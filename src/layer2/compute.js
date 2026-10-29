/**
 * Claudiao · 编排核心（M4-T5/T6 + 延迟优化，docs/01 §4.1 / docs/03 §5）
 *
 * handleUserChat(text) / runScheduled(slot) → Broadcast（docs/03 §5 契约）。
 * 链路：route → context → brain → music resolve → tts → persist → assemble。
 *
 * 延迟策略（2026-10-15 优化）：
 *   1. 精确点播（play_request 精确）走**音乐车道直连**：不过大脑，秒级出声；
 *      解析失败自动回落大脑全链路。
 *   2. 搜索候选只在 play_request（模糊）时注入 ⑤ 片——情绪/闲聊路径省 2~5s。
 *   3. 大脑返回 say 文本后，**TTS 与音乐首曲解析并行**；曲目 2+ 后台补齐（WS 追加），
 *      播报返回只需等 say 音频 + 首曲直链。
 *   4. 状态即时反馈：THINKING/RESOLVING 经 WS 推给前端（用户立刻看到"思考中"）。
 *
 * 三条降级链（全部有日志、状态机不停留在中间态）：
 *   大脑失败 → 模板播报；音乐全失败 → 本地兜底音频；TTS 失败 → 跳过语音直接放歌。
 * 单飞：同一时刻只跑一次 compute；优先级 user_chat > schedule > prefetch；排队 >20s 丢弃低优先级。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { classify } from './router.js';
import { build as buildContext, renderPrompt, corpusHash } from './context.js';
import { templateAction } from './fallback-templates.js';
import { Machine } from './machine.js';

const PRIORITY_RANK = { user_chat: 0, schedule: 1, prefetch: 2 };
const QUEUE_TIMEOUT_MS = 20000;
const SYNC_TRACKS = 1;                 // 随 Broadcast 同步返回的曲目数（其余后台补齐，WS 追加）
const PLACEHOLDER_LINES = ['好，让我想想，马上安排。', '收到，选几首合你现在的。'];

function broadcastId(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  const d = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}T${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  return `b_${d}_${crypto.randomBytes(2).toString('hex')}`;
}

// ---------- 选曲发散工具（24h 硬去重；norm 键跨写法匹配） ----------

const normText = (s) => String(s || '').toLowerCase().replace(/\s+/g, '');
const splitSpec = (spec) => {
  const m = String(spec || '').match(/^(?<artist>.+?)\s-\s(?<title>.+)$/);
  return { artist: m?.groups?.artist?.trim() || '', title: m?.groups?.title?.trim() || String(spec || '').trim() };
};
const pairKey = (artist, title) => `${normText(artist)}|${normText(title)}`;

export class ComputeService {
  /** @param {object} deps { brain, music, tts, state, config, log, calendarText?, onBroadcast?, onControl?, onEvent? } */
  constructor(deps = {}) {
    this.deps = deps;
    this.cfg = deps.config;
    this.log = (deps.log?.child?.('compute')) ?? deps.log ?? console;
    this.machine = new Machine('IDLE', { onChange: (s, p) => this.log.debug?.(`状态 ${p} → ${s}`) });
    this._running = null;
    this._queue = [];
    this._nowPlaying = null;
    this._fallbackIndex = 0;
    this.roaming = { enabled: false, pending: false };   // 无限漫游（restoreRoaming 恢复开关）
  }

  nowPlaying() { return this._nowPlaying; }

  /** 启动时恢复漫游开关（prefs 持久化） */
  restoreRoaming() {
    this.roaming.enabled = this.deps.state?.getPref?.('roaming.enabled') === true;
    return this.roaming.enabled;
  }

  async handleUserChat(text, { clientMsgId } = {}) {
    const intent = classify({ text, source: 'user_chat' }, { knowledgeDir: this._kd() });
    // 控制指令直连：不过大脑/音乐/TTS，毫秒级生效（docs/02 §2.3）
    if (intent.name === 'control') return this._handleControl(intent);
    // 占位播报（Q-04）：大脑思考期间先让 DJ 开口（合成结果有缓存，~3s 内出声）
    if (intent.needBrain) this._emitPlaceholder(intent).catch(() => {});
    return this._enqueue(intent, 'user_chat');
  }

  /** 占位播报：立即推一条短 say（缓存命中后毫秒级），正式播报完成后自然替换 */
  async _emitPlaceholder(intent) {
    try {
      if (this.deps.state?.getPref?.('say.muted') === true) return;
      const line = PLACEHOLDER_LINES[Math.floor(Math.random() * PLACEHOLDER_LINES.length)];
      const t = await this.deps.tts.synthesize({ text: line });
      const broadcast = {
        id: broadcastId() + 'p', sessionId: null,
        intent: { name: intent.name, lane: intent.lane, source: intent.source, priority: intent.priority,
          text: intent.text || '', mood: null, moodCandidates: [], slot: intent.slots?.slot ?? null,
          confidence: 1, reason: '占位播报' },
        say: { text: line, audioUrl: t.audioUrl, mime: t.mime, durationMs: null, est: false,
          voice: this.cfg.tts.voice, engine: t.engine, cached: t.cached, skipped: false },
        queue: [], fallbackAudio: null, reason: '', segue: '',
        state: 'SPEAKING', degraded: false, degradedReasons: [],
        contextHash: null, placeholder: true,
        timings: { routeMs: 0, contextMs: 0, brainMs: 0, musicMs: 0, ttsMs: 0, totalMs: 0,
          parsePath: 'placeholder', retries: 0, usage: null },
        at: new Date().toISOString(),
      };
      this._nowPlaying = broadcast;
      this.machine.tryTo('SPEAKING');
      this.deps.onBroadcast?.(broadcast);
      this.log.info?.('占位播报已推', { ms: Date.now() % 1000 });
    } catch (e) {
      this.log.debug?.('占位播报失败（忽略）', { error: e.message });
    }
  }

  /**
   * 控制指令：pause / resume / next / prev / 音量加减 / 静音说话开关。
   * 实际播放器在浏览器——服务端只做状态裁决 + WS 推 control 事件，客户端执行。
   */
  _handleControl(intent) {
    const action = intent.slots.control;
    const pb = this.deps.playback || (this.deps.playback = { index: 0 });

    switch (action) {
      case 'pause':
        this.machine.tryTo('IDLE');
        break;
      case 'resume':
        this.machine.tryTo('PLAYING');
        break;
      case 'next': {
        const b = this._nowPlaying;
        if (b?.queue?.length) {
          const cur = b.queue[pb.index ?? 0];
          if (cur && this.deps.state) {
            try {
              const row = this.deps.state.recentPlays(50)
                .find((p) => p.broadcast_id === b.id && p.track_id === String(cur.id));
              if (row) this.deps.state.updatePlayProgress(row.id, { playedMs: 0 });  // 记跳过
            } catch { /* 落库失败不阻塞 */ }
          }
          pb.index = (pb.index ?? 0) + 1;
          this.deps.onEvent?.('queue-update', { index: pb.index });
        }
        break;
      }
      case 'prev': {
        const b = this._nowPlaying;
        if (b?.queue?.length && (pb.index ?? 0) > 0) {
          pb.index = (pb.index ?? 0) - 1;
          this.deps.onEvent?.('queue-update', { index: pb.index });
        }
        break;
      }
    }

    // mute_say 落偏好（TTS 阶段读取 say.muted 决定是否跳过语音）；音量类为纯客户端动作
    if (action === 'mute_say_on') this.deps.state?.setPref?.('say.muted', true, '用户：别说话了');
    if (action === 'mute_say_off') this.deps.state?.setPref?.('say.muted', false, '用户：可以说话了');

    this.deps.onControl?.(action);
    this.log.info?.('控制指令', { action });
    return { control: action, state: this.machine.state, index: pb.index ?? 0 };
  }

  async runScheduled(slot, { trigger = 'schedule', useBrain = true } = {}) {
    const slotDef = this.cfg.routines.slots.find((s) => s.name === slot);
    const intent = classify({
      source: 'schedule', slot, text: slotDef?.description || '', useBrain,
    }, { knowledgeDir: this._kd() });
    return this._enqueue(intent, 'schedule');
  }

  _kd() { return path.join(this.cfg.root, 'knowledge'); }

  /**
   * 节目名：按「星期几 + 时段」从诗性池子里抽一个（如 "Friday Late Night Exhale"），
   * 给每次播报一个电台节目的身份。en/zh 跟随 DJ_LANG。
   */
  _programName(intent = {}) {
    const now = new Date();
    const h = now.getHours();
    const slot = h < 5 ? 'late' : h < 11 ? 'morning' : h < 14 ? 'midday' : h < 18 ? 'afternoon' : h < 22 ? 'evening' : 'late';
    const segZh = slot === 'morning' ? '早' : (slot === 'midday' || slot === 'afternoon') ? '中' : '晚';   // 开场白时段（早/中/晚各一次）
    const en = {
      morning: ['Slow Start', 'First Light', 'Wake-up Set', 'Fresh Air'],
      midday: ['Midday Drift', 'Noon Pause', 'Lunch FM'],
      afternoon: ['Deep Focus', 'Long Play', 'Afternoon Static'],
      evening: ['Evening Exhale', 'Golden Hour', 'Wind-down'],
      late: ['Late Night Exhale', 'Midnight Radio', 'Night Swim', 'After Hours'],
    };
    const zh = {
      morning: ['清晨序曲', '慢启动', '晨间电台'],
      midday: ['午间漫步', '正午片刻'],
      afternoon: ['深度工作', '午后长播', '下午静态'],
      evening: ['黄昏出气口', '金色时刻', '晚间慢车'],
      late: ['深夜呼气', '午夜电台', '夜泳', '下班以后'],
    };
    const pool = (this.cfg.djLang === 'en' ? en : zh)[slot];
    const pick = pool[Math.floor(Math.random() * pool.length)];
    if (this.cfg.djLang === 'en') {
      const wd = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][now.getDay()];
      return { name: `${wd} ${pick}`, slot, segZh };
    }
    const wd = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][now.getDay()];
    return { name: `${wd} · ${pick}`, slot, segZh };
  }

  /** 今日该时段的开场白是否还没播过（早/中/晚各一次，跨天重置） */
  _greetingDue(segZh) {
    const d = new Date();
    const key = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}|${segZh}`;
    return { due: this.deps.state?.getPref?.('greeting.lastKey') !== key, key };
  }

  // ---------- 单飞 + 优先级队列 ----------

  _enqueue(intent, priority) {
    if (!this._running) {
      this._running = this._exec(intent, priority).finally(() => { this._running = null; this._drain(); });
      return this._running;
    }
    return new Promise((resolve, reject) => {
      const entry = { intent, priority, resolve, reject, at: Date.now() };
      this._queue.push(entry);
      this._queue.sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]);
      const now = Date.now();
      for (const e of [...this._queue]) {
        if (now - e.at > QUEUE_TIMEOUT_MS && e.priority !== 'user_chat') {
          this._queue.splice(this._queue.indexOf(e), 1);
          e.reject(Object.assign(new Error('排队超时丢弃'), { code: 'E_BUSY' }));
        }
      }
    });
  }

  _drain() {
    if (!this._queue.length || this._running) return;
    const next = this._queue.shift();
    this._running = this._exec(next.intent, next.priority).then(next.resolve, next.reject)
      .finally(() => { this._running = null; this._drain(); });
  }

  // ---------- 主链路 ----------

  async _exec(intent, priority) {
    const t0 = Date.now();
    const bid = broadcastId();
    const degraded = [];
    const timings = { routeMs: 0, contextMs: 0, brainMs: 0, musicMs: 0, ttsMs: 0, totalMs: 0 };

    this.deps.onEvent?.('state-change', { state: 'THINKING', bid });
    this.machine.tryTo('THINKING');
    const say = {
      text: '', audioUrl: null, mime: null, durationMs: null, est: true,
      voice: this.cfg.tts.voice, engine: null, cached: false, skipped: false,
    };

    try {
      // ① context 六片（搜索候选只在模糊点播时注入——情绪/闲聊路径省 2~5s）
      const c0 = Date.now();
      const program = this._programName(intent);
      const greeting = this._greetingDue(program.segZh);
      const fragments = await buildContext(intent, {
        knowledgeDir: this._kd(),
        state: this.deps.state,
        djLang: this.cfg.djLang,
        calendarText: this.deps.calendarText?.() || null,
        greeting: greeting.due ? { segment: program.segZh, programName: program.name } : null,
        searchCandidates: intent.name === 'play_request'
          ? async (q) => {
              try { return await this.deps.music.official.search(q, { limit: 8 }); }
              catch (e) { this.log.debug?.('搜索候选不可用', { error: e.message }); return null; }
            }
          : undefined,
      });
      const prompt = renderPrompt(fragments);
      timings.contextMs = Date.now() - c0;
      const hash = corpusHash(this._kd());
      this.deps.log?.prompt?.(prompt);

      // ② 精确点播 → 音乐车道直连（秒回）；解析失败 → 回落大脑全链路
      if (intent.lane === 'music' && intent.slots.title) {
        const direct = await this._musicLane(intent, bid, degraded, t0);
        if (direct) return direct;
        this.deps.onEvent?.('state-change', { state: 'THINKING', bid });
        this.machine.tryTo('THINKING');
      }

      // ③ 大脑（异常 → 模板播报，纵深防御）
      const b0 = Date.now();
      let brainResult, action;
      try {
        brainResult = await this.deps.brain.compute(prompt);
        action = brainResult.action;
      } catch (e) {
        const tpl = templateAction({ reason: e.code || 'E_BRAIN_FAIL', mood: intent.slots?.mood, slot: intent.slots?.slot });
        action = { ...tpl, degraded: ['brain_template'] };
        brainResult = { raw: { sessionId: null, usage: null }, meta: { path: 'fallback', repairs: [], retries: 0, attempts: 1 } };
        this.log.warn?.('大脑阶段异常 → 模板播报', { error: e.message });
      }
      timings.brainMs = Date.now() - b0;
      if (brainResult.meta.path === 'fallback' || action.degraded?.includes('brain_template')) degraded.push('brain_template');
      degraded.push(...(action.degraded || []).filter((d) => d !== 'brain_template'));
      const usage = brainResult.raw.usage;
      say.text = action.say;

      // ③.5 选曲发散：24h 内播过的歌硬过滤（用户亲口点名的豁免）；全滤光 → 个人红心曲库回填。
      //     软约束（契约规则）靠大脑自觉，这里是兜底——LLM 不听话也进不了队列。
      let repeatGuard = null;
      if (Array.isArray(action.play) && action.play.length) {
        const fr = this._filterRepeats(action.play, action.intros, intent.text || '');
        if (fr.dropped.length) {
          degraded.push('repeat_filtered');
          this.log.info?.('24h 去重过滤', { dropped: fr.dropped, kept: fr.kept.length });
        }
        if (!fr.kept.length) {
          const refill = this._redheartPool(2, fr.keys, fr.titles, fr.dropped);
          if (refill.length) {
            fr.kept = refill;
            fr.intros = refill.map(() => null);   // 回填曲无口播，_scheduleIntroRepair 会补
            degraded.push('repeat_refill_library');
            this.log.info?.('大脑选曲全是近期播过 → 红心曲库回填', { refill });
          }
        }
        action.play = fr.kept;
        action.intros = fr.intros;
        repeatGuard = { idFilter: fr.ids, exempt: fr.exempt };
        // 契约「同一位艺人本批最多 1 首」的硬执行版：模型自发堆同艺人时收敛。
        // 用户亲口点名该艺人/歌名时豁免——「多来几首周杰伦」就必须给够周杰伦。
        const saidText = normText(intent.text || '');
        const seenArtists = new Set();
        const varied = [];
        for (const spec of action.play) {
          const { artist, title } = splitSpec(spec);
          const named = (artist && saidText.includes(normText(artist))) || (title && saidText.includes(normText(title)));
          const key = normText(artist);
          if (key && !named && seenArtists.has(key)) continue;
          if (key) seenArtists.add(key);
          varied.push(spec);
        }
        if (varied.length !== action.play.length) {
          this.log.info?.('同艺人去重', { before: action.play.length, after: varied.length });
          action.play = varied;
          action.intros = varied.map((_, i) => action.intros[i] ?? null);
        }
      }

      // ④ 并行：TTS(say) ‖ 音乐解析（首 2 首同步，其余后台补齐）
      this.deps.onEvent?.('state-change', { state: 'RESOLVING', bid });
      this.machine.tryTo('RESOLVING');
      const s0 = Date.now();
      const sayMuted = this.deps.state?.getPref?.('say.muted') === true;
      const sayP = (!sayMuted && action.say)
        ? this.deps.tts.synthesize({ text: action.say })
            .then((t) => { say.audioUrl = t.audioUrl; say.mime = t.mime; say.engine = t.engine; say.cached = t.cached; })
            .catch((e) => { say.skipped = true; degraded.push('tts_skipped'); this.log.warn?.('TTS 失败 → 跳过语音', { error: e.message }); })
        : Promise.resolve().then(() => { if (sayMuted || !action.say) { say.skipped = true; if (sayMuted) degraded.push('tts_skipped'); } });

      // 每首曲目口播的 TTS（与 say 并行进合成队列；mute 时全部跳过）
      const introP = (!sayMuted && Array.isArray(action.intros))
        ? action.intros.map((line) => (line
            ? this.deps.tts.synthesize({ text: line })
                .then((t) => ({ text: line, audioUrl: t.audioUrl, mime: t.mime, engine: t.engine, cached: t.cached, skipped: false }))
                .catch(() => ({ text: line, audioUrl: null, mime: null, engine: null, cached: false, skipped: true }))
            : Promise.resolve(null)))
        : [];

      const m0 = Date.now();
      const { queue, fallbackAudio } = await this._resolveQueue(action.play || [], {
        onAppend: (t) => this.deps.onEvent?.('queue-update', { index: queue.length - 1, track: t }),
        degraded,
        guard: repeatGuard,
      });
      // 口播音频附到对应曲目（intros 与 play 等长对齐；后台补齐曲目同样带口播）
      const intros = await Promise.all(introP);
      queue.forEach((t, i) => { if (intros[i]) t.intro = intros[i]; });
      const saySettled = Date.now();
      await sayP;
      timings.musicMs = Date.now() - m0;
      timings.ttsMs = saySettled - s0;
      // 大脑少写 intro（intros_partial）→ 后台逐首补齐，前端 drop-in
      if (action.play?.length && queue.some((t) => !t.intro)) {
        this._scheduleIntroRepair(queue, intent.text || '定时播报');
      }

      // ⑤ 状态裁决
      let state;
      if (fallbackAudio) state = 'FALLBACK_AUDIO';
      else if (say.skipped && queue.length) state = 'MUSIC_ONLY';
      else if (say.skipped && !queue.length) state = 'IDLE';
      else if (say.audioUrl) state = 'SPEAKING';
      else if (queue.length) state = 'PLAYING';
      else state = 'IDLE';

      // ⑤.5 今日时段开场白：真大脑成功播出后才标记「本时段已问候」
      if (greeting.due && brainResult.meta.path !== 'fallback' && say.text && !say.skipped) {
        this.deps.state?.setPref?.('greeting.lastKey', greeting.key);
        this.log.info?.('今日时段开场白已播', { segment: program.segZh });
      }

      // ⑥ 落库：messages(dj/user) + plays
      if (this.deps.state) {
        try {
          this.deps.state.addMessage({
            role: 'dj', text: action.say, intent: intent.name, lane: intent.lane,
            sessionId: brainResult.raw.sessionId, broadcastId: bid, degraded: degraded.length > 0,
            meta: { mood: intent.slots?.mood ?? null, parsePath: brainResult.meta.path },
          });
          if (intent.text) this.deps.state.addMessage({ role: 'user', text: intent.text, intent: intent.name });
          for (const q of queue) {
            this.deps.state.addPlay({
              trackId: q.id || q.spec, source: q.source, title: q.title, artist: q.artist,
              spec: q.spec, audioUrl: q.audioUrl, coverUrl: q.coverUrl, durationMs: q.durationMs,
              broadcastId: bid, intent: intent.name, reason: q.reason, degraded: degraded.length > 0,
            });
          }
        } catch (e) {
          this.log.warn?.('落库失败（不阻塞播报）', { error: e.message });
        }
      }

      timings.totalMs = Date.now() - t0;
      const broadcast = {
        id: bid,
        sessionId: brainResult.raw.sessionId,
        program,
        intent: {
          name: intent.name, lane: intent.lane, source: intent.source, priority: intent.priority,
          text: intent.text || '', mood: intent.slots?.mood ?? null,
          moodCandidates: intent.slots?.moodCandidates ?? [], slot: intent.slots?.slot ?? null,
          confidence: intent.confidence, reason: intent.reason || '',
        },
        say, queue, fallbackAudio,
        reason: action.reason,
        segue: action.segue || '',
        state,
        degraded: degraded.length > 0,
        degradedReasons: [...new Set(degraded)],
        contextHash: hash.hash,
        timings: { ...timings, parsePath: brainResult.meta.path, retries: brainResult.meta.retries, usage: usage || null },
        at: new Date().toISOString(),
      };
      this._nowPlaying = broadcast;
      this.machine.tryTo(state);
      this.deps.onBroadcast?.(broadcast);
      return broadcast;
    } catch (e) {
      // 兜底之兜底：编排层自身异常 → 模板播报（无曲无 TTS）
      this.log.error?.('编排异常', { error: e.message, stack: e.stack?.split('\n')[1] });
      const tpl = templateAction({ reason: 'E_COMPUTE', mood: intent.slots?.mood, slot: intent.slots?.slot });
      const broadcast = {
        id: bid, sessionId: null,
        intent: { name: intent.name, lane: intent.lane, source: intent.source, priority,
          text: intent.text || '', mood: null, moodCandidates: [], slot: intent.slots?.slot ?? null,
          confidence: intent.confidence, reason: intent.reason || '' },
        say: { text: tpl.say, audioUrl: null, mime: null, durationMs: null, est: true,
          voice: this.cfg.tts.voice, engine: null, cached: false, skipped: true },
        queue: [], fallbackAudio: null, reason: tpl.reason, segue: '',
        state: 'IDLE', degraded: true, degradedReasons: ['compute_error', 'tts_skipped'],
        contextHash: null,
        timings: { ...timings, totalMs: Date.now() - t0, parsePath: 'fallback', retries: 0, usage: null },
        at: new Date().toISOString(),
      };
      this._nowPlaying = broadcast;
      this.machine.tryTo('IDLE');
      this.deps.onBroadcast?.(broadcast);
      return broadcast;
    }
  }

  /**
   * 精确点播直连：搜索 → 解析 → 确认模板 say → TTS。目标秒级。
   * @returns {Promise<object|null>} Broadcast；解析不出返回 null（调用方回落大脑）
   */
  async _musicLane(intent, bid, degraded, t0) {
    // 查询清理：剥掉「的歌/歌曲」等泛称，避免搜出歌单式垃圾候选
    const raw = intent.slots.query || `${intent.slots.artist || ''} ${intent.slots.title || ''}`.trim();
    const query = raw.replace(/\s*(的歌|的歌曲|的音乐|歌单)\s*$/, '').trim() || raw;
    const wantArtist = (intent.slots.artist || '').toLowerCase();
    try {
      // 直接用官方搜索：优先挑「歌手匹配 + 可播」的候选，垃圾候选不过关
      const cands = (await this.deps.music.official.search(query, { limit: 10 })) || [];
      const byArtist = wantArtist
        ? cands.filter((c) => c.artist.join('/').toLowerCase().includes(wantArtist))
        : cands;
      const pool = (byArtist.length ? byArtist : cands).filter((c) => c.playFlag !== false);
      const pick = pool[0] || byArtist[0] || cands[0];
      if (!pick) return null;
      const r = await this.deps.music.resolve(`${(pick.artist || []).join('/')} - ${pick.name}`);
      if (!r?.url) return null;
      const track = this._trackEntry(r, `${(pick.artist || []).join('/')} - ${pick.name}`, 0);
      // 精确点播也吃时段开场白：今日该时段首次开口 → 确认语升级为问候+自我介绍+主题
      const program = this._programName(intent);
      const greeting = this._greetingDue(program.segZh);
      const lead = greeting.due
        ? (this.cfg.djLang === 'en'
            ? `Hey, I'm Valen, your personal DJ — tonight's theme is "${program.name}". `
            : `你好，我是 Valen，你的私人 DJ，本期主题「${program.name}」。`)
        : '';
      // 确认模板 say + TTS（并行无必要——这是唯一耗时项）
      const ackText = this.cfg.djLang === 'en'
        ? `${lead}Found it. Playing ${r.track.name} by ${r.track.artist.join(', ')}.`
        : `${lead}好，这就给你放〈${r.track.name}〉。`;
      const say = {
        text: ackText, audioUrl: null, mime: null, durationMs: null, est: true,
        voice: this.cfg.tts.voice, engine: null, cached: false, skipped: false,
      };
      try {
        const t = await this.deps.tts.synthesize({ text: ackText });
        say.audioUrl = t.audioUrl; say.mime = t.mime; say.engine = t.engine; say.cached = t.cached;
      } catch (e) {
        say.skipped = true; degraded.push('tts_skipped');
      }
      const state = say.skipped ? 'MUSIC_ONLY' : 'SPEAKING';
      const broadcast = {
        id: bid, sessionId: null,
        program,
        intent: { name: 'play_request', lane: 'music', source: intent.source, priority: intent.priority,
          text: intent.text || '', mood: null, moodCandidates: [], slot: null,
          confidence: intent.confidence, reason: intent.reason || '' },
        say, queue: [track], fallbackAudio: null,
        reason: `精确点播命中（${r.from}，${r.br || '?'}kbps）`, segue: '',
        state, degraded: degraded.length > 0, degradedReasons: [...new Set(degraded)],
        contextHash: corpusHash(this._kd()).hash,
        timings: { routeMs: Date.now() - t0, contextMs: 0, brainMs: 0, musicMs: Date.now() - t0, ttsMs: Date.now() - t0,
          totalMs: Date.now() - t0, parsePath: 'music-lane', retries: 0, usage: null },
        at: new Date().toISOString(),
      };
      this._nowPlaying = broadcast;
      if (this.deps.state) {
        try {
          this.deps.state.addMessage({ role: 'user', text: intent.text, intent: intent.name });
          this.deps.state.addMessage({ role: 'dj', text: ackText, intent: intent.name, lane: 'music',
            broadcastId: bid, degraded: degraded.length > 0 });
          this.deps.state.addPlay({
            trackId: track.id || track.spec, source: track.source, title: track.title, artist: track.artist,
            spec: intent.slots.query, audioUrl: track.audioUrl, coverUrl: track.coverUrl, durationMs: track.durationMs,
            broadcastId: bid, intent: intent.name, reason: `精确点播`, degraded: degraded.length > 0,
          });
        } catch { /* ignore */ }
      }
      // 确认语已带问候与自我介绍 → 标记本时段已问候（TTS 失败则不标，下轮补上）
      if (greeting.due && !say.skipped) {
        this.deps.state?.setPref?.('greeting.lastKey', greeting.key);
        this.log.info?.('今日时段开场白已播（音乐车道）', { segment: program.segZh });
      }
      this.machine.tryTo(state);
      this.deps.onBroadcast?.(broadcast);
      return broadcast;
    } catch (e) {
      this.log.info?.('音乐车道未命中，回落大脑', { query, error: e.message });
      return null;
    }
  }

  _trackEntry(r, spec, index) {
    const score = Math.min(1, Math.max(0, (r.score ?? 0) / 60));
    return {
      index,
      id: String(r.track.originalId ?? r.track.id ?? ''),
      encryptedId: r.track.encryptedId || null,
      lyricId: r.track.lyricId || null,
      picId: r.track.picId || null,
      source: r.track.source || 'netease',
      title: r.track.name, artist: (r.track.artist || []).join('/'),
      album: r.track.album || '', coverUrl: r.track.coverUrl || null,
      audioUrl: r.url, durationMs: r.track.durationMs ?? null,
      reason: r.track.reason || '', score: Number(score.toFixed(2)),
      fuzzy: score < 0.72, spec,
    };
  }

  /**
   * 曲目解析：首 SYNC_TRACKS 首同步（覆盖开播窗口），其余后台补齐经 WS 追加。
   * 全部同步解析失败 → 本地兜底音频。
   */
  async _resolveQueue(play, { onAppend, degraded, guard = null }) {
    const queue = [];
    const fails = [];
    const tryOne = async (spec) => {
      try {
        const r = await this.deps.music.resolve(spec);
        // 解析结果的曲目 id 命中 24h 播过集 → 换一种写法的重复，同样拦下（用户点名的豁免）
        const rid = String(r.track.originalId ?? r.track.id ?? '');
        if (guard?.idFilter && !guard.exempt?.has(String(spec)) && guard.idFilter.has(rid)) {
          this.log.info?.('解析结果 24h 内播过，跳过', { spec, id: rid });
          return 'skip';
        }
        const t = this._trackEntry(r, spec, queue.length);
        queue.push(t);
        if (queue.length > SYNC_TRACKS) onAppend?.(t);
        return true;
      } catch (e) {
        fails.push(`music_resolve_failed:${spec}`);
        this.log.warn?.('单曲解析失败', { spec, error: e.message });
        return false;
      }
    };
    const syncCount = Math.min(SYNC_TRACKS, play.length);
    for (let i = 0; i < syncCount; i++) await tryOne(play[i]);

    let fallbackAudio = null;
    if (queue.length === 0 && play.length) {
      fallbackAudio = this._pickFallbackAudio();
      degraded.push(fallbackAudio ? 'music_fallback_audio' : 'music_no_url');
    }
    degraded.push(...fails);

    // 后台补齐剩余曲目（fire-and-forget，经 WS queue-update 追加到前端队列）
    if (queue.length > 0 && play.length > queue.length) {
      (async () => {
        for (let i = queue.length; i < play.length; i++) {
          await this.deps.music.resolve(play[i])
            .then(async (r) => {
              const t = this._trackEntry(r, play[i], queue.length);
              queue.push(t);
              this.deps.onEvent?.('queue-update', { index: queue.length - 1, track: t });
              // 后台追加的曲目自己补封面（初始封面补齐轮询已跑过，覆盖不到它们）
              if (!t.coverUrl && t.picId) {
                try {
                  const c = await this.deps.music.gdstudio.cover(t.picId, 300);
                  if (c?.url) { t.coverUrl = c.url; this.deps.onEvent?.('queue-update', { index: queue.indexOf(t), track: t }); }
                } catch { /* 封面拿不到不影响播放 */ }
              }
            })
            .catch((e) => this.log.debug?.('后台补齐失败', { spec: play[i], error: e.message }));
        }
      })();
    }
    // 封面补齐（后台，不阻塞播报）：gdstudio 兜底路径的曲目只有 picId，换出封面 URL
    if (queue.some((t) => !t.coverUrl && t.picId)) {
      (async () => {
        for (const t of queue) {
          if (t.coverUrl || !t.picId) continue;
          try {
            const c = await this.deps.music.gdstudio.cover(t.picId, 300);
            if (c?.url) {
              t.coverUrl = c.url;
              this.deps.onEvent?.('queue-update', { index: queue.indexOf(t), track: t });
            }
          } catch { /* 封面拿不到不影响播放 */ }
        }
      })();
    }
    return { queue, fallbackAudio };
  }

  /** 近 hours 小时播放记录 → 归一化键集（选曲硬去重用；norm 键跨「艺人写法/空格」差异匹配） */
  _playedKeys24h(hours = 24) {
    const rows = this.deps.state?.recentPlays?.(200) || [];
    const keys = new Set(), titles = new Set(), ids = new Set();
    const since = Date.now() - hours * 3600e3;
    for (let i = rows.length - 1; i >= 0; i--) {          // recentPlays 旧→新，从新端往回扫
      const p = rows[i];
      if (!p || p.at_ms < since) break;
      if (p.artist) keys.add(pairKey(p.artist, p.title));
      titles.add(normText(p.title));
      if (p.track_id) ids.add(String(p.track_id));
    }
    return { keys, titles, ids };
  }

  /**
   * 24h 硬去重：近期播过的 spec 滤掉（用户本次文本里亲口点名的豁免）。
   * intros 与 play 等长对齐地一起过滤；不修改入参。
   */
  _filterRepeats(play, intros = [], userText = '', extraDrops = []) {
    const { keys, titles, ids } = this._playedKeys24h();
    const said = normText(userText);
    const kept = [], keptIntros = [], dropped = [], exempt = new Set();
    (Array.isArray(play) ? play : []).forEach((spec, i) => {
      const { artist, title } = splitSpec(spec);
      const userNamed = title && said.includes(normText(title));
      if (userNamed) exempt.add(String(spec));
      if (userNamed) { /* 用户点名：留 */ } else if (
        (extraDrops || []).includes(spec)
        || keys.has(pairKey(artist, title))
        || (!artist && titles.has(normText(title)))
      ) { dropped.push(spec); return; }
      kept.push(String(spec));
      keptIntros.push(Array.isArray(intros) ? (intros[i] ?? null) : null);
    });
    return { kept, intros: keptIntros, dropped, ids, keys, titles, exempt };
  }

  /** 个人红心曲库（taste-imports）随机抽 n 首，排除已播键与指定规格 */
  _redheartPool(n, excludeKeys = new Set(), excludeTitles = new Set(), excludeSpecs = []) {
    const pool = [];
    try {
      const dir = path.join(this.cfg.root, 'knowledge', 'user', 'taste-imports');
      for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
        const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        for (const t of j.tracks || []) {
          const spec = `${t.artist} - ${t.title}`;
          if ((excludeSpecs || []).includes(spec)) continue;
          if (excludeKeys.has(pairKey(t.artist, t.title)) || excludeTitles.has(normText(t.title))) continue;
          pool.push(spec);
        }
      }
    } catch (e) {
      this.log.debug?.('红心曲库不可用', { error: e.message });
    }
    for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
    return pool.slice(0, n);
  }

  /** 本地兜底音频池：data/fallback-audio/ 顺序轮换 */
  _pickFallbackAudio() {
    try {
      const dir = path.join(this.cfg.root, this.cfg.music.fallbackDir || 'data/fallback-audio');
      const files = fs.readdirSync(dir).filter((f) => /\.(mp3|wav)$/i.test(f));
      if (!files.length) return null;
      const f = files[this._fallbackIndex++ % files.length];
      return { title: f, audioUrl: `/fallback/${encodeURIComponent(f)}`, from: 'local' };
    } catch { return null; }
  }

  /**
   * 口播补齐（后台）：大脑偶尔少写最后一首的 intro（intros_partial）。
   * 缺文本的 → 单曲问大脑要一句；要不到 → 元数据模板兜底。补完 TTS + WS 推送。
   * 前端在曲目中途收到 intro 会直接 drop-in（人声压音乐淡入），正是电台形态。
   */
  _scheduleIntroRepair(queue, hint) {
    (async () => {
      for (const t of queue) {
        if (t.intro?.audioUrl || t.intro?.synthed) continue;
        let line = t.intro?.text && !t.intro.skipped ? t.intro.text : null;
        if (!line) {
          try {
            const r = await this.deps.brain.adapter.compute(
              `只输出一句话（25~80 字，中文电台口播，结合此刻：${hint}），介绍为什么此刻放这首歌：${t.spec || t.title + ' - ' + t.artist}。不要复述歌名，不要 JSON，不要引号。`,
              { timeoutMs: 60000 });
            line = r.text.trim().replace(/^["'「]|["'」]$/g, '').slice(0, 160);
          } catch { line = null; }
        }
        if (!line) line = `接下来这首《${t.title}》，${t.artist}，很配现在。`;
        try {
          const t0 = await this.deps.tts.synthesize({ text: line });
          t.intro = { text: line, audioUrl: t0.audioUrl, mime: t0.mime, engine: t0.engine, cached: t0.cached, skipped: false, synthed: true };
          this.deps.onEvent?.('queue-update', { index: queue.indexOf(t), track: t });
          this.log.info?.('口播已补齐', { title: t.title });
        } catch {
          t.intro = { text: line, audioUrl: null, mime: null, engine: null, cached: false, skipped: true, synthed: true };
        }
      }
    })();
  }

  // ---------- 无限漫游模式 ----------
  // 开启后：队列只剩 1 首时自动续 3 首（品味画像驱动；大脑失败回落个人红心曲库）。
  // 歌单红心数据来自 taste-imports（品味管线导入）。

  setRoaming(enabled) {
    this.roaming = { ...this.roaming, enabled: Boolean(enabled), pending: false };
    this.deps.state?.setPref?.('roaming.enabled', this.roaming.enabled);
    this.deps.onEvent?.('roaming-update', { enabled: this.roaming.enabled });
    if (enabled) this.roamNext().catch((e) => this.log.warn?.('漫游首批失败', { error: e.message }));
    return { roaming: this.roaming.enabled };
  }

  /**
   * 无限漫游续批（无状态·客户端驱动）：客户端上报当前下标与已推/在播清单，
   * 服务端只负责产歌（大脑按画像探索 → 失败回落个人红心曲库），返回新曲目数组。
   * 客户端自己追加到队列——不依赖服务端的 now-playing 状态，天然免疫重启与多端。
   */
  async roamNext({ clientIndex, queueSpecs = [], recentSpecs = [] } = {}) {
    if (!this.roaming?.enabled) return { queued: false, reason: 'roaming off', tracks: [] };
    if (this.roaming.pending) return { queued: false, reason: '批次进行中', tracks: [] };
    this.roaming.pending = true;
    try {
      const tracks = await this._roamBatch(queueSpecs, recentSpecs);
      return { queued: tracks.length > 0, added: tracks.length, tracks, source: this._lastRoamSource || 'brain' };
    } finally {
      this.roaming.pending = false;
    }
  }

  /** 漫游批次：① 大脑按画像探索（≥2 首歌单外）→ 失败 ② 个人红心曲库随机补。全程 24h 硬去重 */
  async _roamBatch(queueSpecs = [], recentSpecs = []) {
    this._lastRoamSource = 'library';
    const pk = this._playedKeys24h();
    const avoid = [...new Set([...queueSpecs, ...recentSpecs])];
    // 服务端自查 24h 播过清单，喂给大脑当避重名单（不依赖客户端上报）
    const dbRecent = (this.deps.state?.recentPlays?.(30) || [])
      .filter((p) => Date.now() - p.at_ms < 24 * 3600e3)
      .map((p) => `${p.artist} - ${p.title}`);
    const avoidAll = [...new Set([...avoid, ...dbRecent])];
    const avoidBlock = avoidAll.length
      ? '\n\n【以下曲目已推送过或最近播过，全部不要重复】\n' + avoidAll.join('\n')
      : '';
    const intent = {
      id: `roam_${Date.now().toString(36)}`, name: 'freeform', lane: 'brain', needBrain: true,
      source: 'roaming', priority: 'prefetch',
      text: '（无限漫游：结合品味画像与最近播放，推几首同气质的歌。只输出 JSON。）',
      slots: {}, confidence: 1, at: new Date().toISOString(), reason: '无限漫游批次',
    };

    const tracks = [];
    const tryResolve = async (spec) => {
      const r = await this.deps.music.resolve(spec).catch(() => null);
      if (!r) return null;
      if (pk.ids.has(String(r.track.originalId ?? r.track.id ?? ''))) return null;   // 24h 内播过
      const t = this._trackEntry(r, spec, tracks.length);
      // 封面后台补齐
      if (!t.coverUrl && t.picId) {
        this.deps.music.gdstudio.cover(t.picId, 300)
          .then((c) => { if (c?.url) { t.coverUrl = c.url; this.deps.onEvent?.('queue-update', { index: tracks.indexOf(t), track: t }); } })
          .catch(() => {});
      }
      return t;
    };

    // ① 大脑批次：探索同风格歌单外歌曲（≥2 首）+ 主力流派 1 首
    try {
      const fragments = await buildContext(intent, {
        knowledgeDir: this._kd(), state: this.deps.state, djLang: this.cfg.djLang,
        calendarText: this.deps.calendarText?.() || null,
      });
      const prompt = renderPrompt(fragments)
        + '\n\n追加要求（无限漫游批次）：\n' + [
          'play 给 3 首，intros 逐首覆盖，say 给 15 字内的极简串场（不朗读）。',
          '至少 2 首是用户歌单里**没有**的同风格歌曲——按 TASTE_PROFILE 的流派权重探索相似艺人/相似气质的新歌，不要复读歌单。',
          '同一位艺人最多 1 首；知名度一般的佳作优先于最著名的代表作。',
          '避开上面【已推送过】的曲目。',
        ].map((s) => '- ' + s).join('\n') + avoidBlock;
      const brainResult = await this.deps.brain.compute(prompt, {});
      const action = brainResult.action;
      // 大脑不听话也要拦：24h 播过 + 本批 avoid 一起硬过滤
      const fr = this._filterRepeats((action.play || []).slice(0, 3), action.intros, '', avoidAll);
      const specs = fr.kept;
      const introLines = fr.intros;
      for (let i = 0; i < specs.length; i++) {
        const [r, intro] = await Promise.all([
          this.deps.music.resolve(specs[i]).catch(() => null),
          introLines[i] ? this.deps.tts.synthesize({ text: introLines[i] })
            .then((t) => ({ text: introLines[i], audioUrl: t.audioUrl, mime: t.mime, engine: t.engine, cached: t.cached, skipped: false }))
            .catch(() => ({ text: introLines[i], audioUrl: null, mime: null, engine: null, cached: false, skipped: true }))
          : Promise.resolve(null),
        ]);
        if (!r) continue;
        if (pk.ids.has(String(r.track.originalId ?? r.track.id ?? ''))) continue;   // 24h 内播过
        const t = this._trackEntry(r, specs[i], tracks.length);
        if (intro) t.intro = intro;
        tracks.push(t);
      }
      if (tracks.length) {
        this._lastRoamSource = 'brain';
        this._scheduleIntroRepair(tracks, '无限漫游续播');   // 大脑漏写/口播失败 → 逐首补齐
        this.log.info?.('漫游批次完成（大脑探索）', { added: tracks.length });
        return tracks;
      }
    } catch (e) {
      this.log.warn?.('漫游大脑批次失败 → 个人红心曲库', { error: e.message });
    }

    // ② 个人红心曲库兜底：避开最近 24h 播过、本批 avoid 与已有曲目
    try {
      const pool = this._redheartPool(3, pk.keys, pk.titles, [...avoid, ...tracks.map((t) => t.spec)]);
      for (const spec of pool) {
        const r = await this.deps.music.resolve(spec).catch(() => null);
        if (!r) continue;
        if (pk.ids.has(String(r.track.originalId ?? r.track.id ?? ''))) continue;
        const t = this._trackEntry(r, spec, tracks.length);
        tracks.push(t);
      }
      this._lastRoamSource = 'library';
      this._scheduleIntroRepair(tracks, '无限漫游续播');
      this.log.info?.('漫游批次完成（个人曲库）', { added: tracks.length });
      return tracks;
    } catch (e) {
      this.log.error?.('漫游个人曲库批次也失败', { error: e.message });
      return tracks;
    }
  }
}

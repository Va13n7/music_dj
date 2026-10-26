/**
 * fixture 加载器 —— 回放测试的共用底座。
 *
 * 对应 docs/12-testing-strategy.md §3.1 与 §4.2：
 *   大脑走 NDJSON 录制-回放（BRAIN_REPLAY_DIR）
 *   音乐走 JSON fixture 回放
 *   TTS 走 FakeTtsAdapter（纯内存，零 spawn）
 *
 * 设计约束：本模块**不发任何网络请求、不 spawn 任何子进程、不写磁盘**。
 * 只读 fixture 文件。这样整个 tests/ 可以在 CI 里离线跑。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURES = path.resolve(HERE, '..', 'fixtures');
export const BRAIN_FIXTURES = path.join(FIXTURES, 'brain');
export const MUSIC_FIXTURES = path.join(FIXTURES, 'music');

// ───────────────────────── 大脑 NDJSON ─────────────────────────

/** 读一个大脑 fixture，返回 { meta, events, stderr, exitCode } */
export function loadBrainFixture(name) {
  const base = name.replace(/\.ndjson$/, '');
  const file = path.join(BRAIN_FIXTURES, `${base}.ndjson`);
  if (!fs.existsSync(file)) {
    throw new Error(`大脑 fixture 不存在: ${file}\n可用场景见 tests/fixtures/brain/README.md`);
  }
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => l.trim());
  const parsed = lines.map((l, i) => {
    try {
      return JSON.parse(l);
    } catch (e) {
      throw new Error(`fixture ${base}.ndjson 第 ${i + 1} 行不是合法 JSON: ${e.message}`);
    }
  });

  const metaLine = parsed.find((e) => e.type === '_meta');
  const events = parsed.filter((e) => e.type !== '_meta');

  const stderrFile = path.join(BRAIN_FIXTURES, `${base}.stderr.txt`);
  const stderr = fs.existsSync(stderrFile) ? fs.readFileSync(stderrFile, 'utf8') : '';

  return {
    name: base,
    meta: metaLine || {},
    events,
    stderr,
    // 人造场景在 _meta 里声明了退出码；真实录制的必然是 0
    exitCode: metaLine?.exitCode ?? 0,
    synthetic: !!metaLine?.synthetic,
  };
}

/** 列出全部大脑 fixture 名（不含扩展名） */
export function listBrainFixtures() {
  if (!fs.existsSync(BRAIN_FIXTURES)) return [];
  return fs.readdirSync(BRAIN_FIXTURES)
    .filter((f) => f.endsWith('.ndjson'))
    .map((f) => f.replace(/\.ndjson$/, ''))
    .sort();
}

/**
 * 把 fixture 模拟成「子进程」——与被测适配器对接的替身。
 *
 * 返回一个 EventEmitter 风格的对象，接口刻意与 child_process.spawn 的返回值对齐：
 *   stdout / stderr 可读流、stdin 可写流、on('close')、kill()
 *
 * 这样 `src/adapters/brain/dsh-headless.js` 在 BRAIN_REPLAY_DIR 生效时
 * 可以用它**原样替换** spawn 的结果，被测代码零改动。
 */
export function replayBrainProcess(name, { delayMs = 0, incremental = true } = {}) {
  const { events, stderr, exitCode, meta } = loadBrainFixture(name);

  const listeners = { close: [], error: [] };
  const outChunks = [];
  let killed = false;
  let pendingTimer = null;
  let closed = false;

  const emitClose = (code, signal) => {
    if (closed) return;
    closed = true;
    for (const cb of listeners.close) cb(code, signal);
  };

  const stdout = {
    on(event, cb) {
      if (event === 'data') outChunks.push(cb);
      return this;
    },
  };
  const stderrStream = {
    on(event, cb) {
      if (event === 'data' && stderr) cb(Buffer.from(stderr, 'utf8'));
      return this;
    },
  };
  const stdin = {
    write() { return true; },
    end() {
      const payload = events.map((e) => JSON.stringify(e)).join('\n') + (events.length ? '\n' : '');
      const effectiveDelay = delayMs || meta?.delayMs || 0;

      const emit = () => {
        pendingTimer = null;
        if (killed) return;
        // incremental=true 模拟真实流式：一行一个 chunk
        if (incremental) {
          for (const e of events) {
            const line = `${JSON.stringify(e)}\n`;
            for (const cb of outChunks) cb(Buffer.from(line, 'utf8'));
          }
        } else {
          for (const cb of outChunks) cb(Buffer.from(payload, 'utf8'));
        }
        emitClose(exitCode);
      };

      // 记录 timer 句柄，kill() 时才能取消 —— 否则未清理的 60s 定时器
      // 会让 `node --test` 在全部断言通过后仍然挂住（实测挂满 60s）。
      if (effectiveDelay > 0) pendingTimer = setTimeout(emit, effectiveDelay);
      else setImmediate(emit);
      return true;
    },
  };

  return {
    stdout,
    stderr: stderrStream,
    stdin,
    on(event, cb) {
      if (listeners[event]) listeners[event].push(cb);
      return this;
    },
    kill() {
      if (killed) return true;
      killed = true;
      // 关键：取消尚未触发的延迟，避免挂住测试进程
      if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; }
      // 真实情况下 kill 后 close 会带信号触发
      setImmediate(() => emitClose(null, 'SIGKILL'));
      return true;
    },
    get killed() { return killed; },
    // 便于断言
    _fixture: { name, meta, events, exitCode, synthetic: !!meta?.synthetic },
  };
}

// ───────────────────────── 音乐 JSON ─────────────────────────

function loadMusicJson(file) {
  const p = path.join(MUSIC_FIXTURES, file);
  if (!fs.existsSync(p)) {
    throw new Error(`音乐 fixture 不存在: ${p}\n重录: node tools/record-music-fixtures.js`);
  }
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

/** 读音乐 fixture 的索引（含每个场景的期望结论与噪声样本） */
export function loadMusicIndex() {
  return loadMusicJson('index.json');
}

/** 读某个场景的某类 fixture，如 loadMusic('qingtian', 'search') */
export function loadMusic(caseName, kind) {
  const idx = loadMusicIndex();
  const c = idx.cases.find((x) => x.name === caseName);
  if (!c) {
    const names = idx.cases.map((x) => x.name).join(', ');
    throw new Error(`音乐 fixture 场景 "${caseName}" 不存在。可用: ${names}`);
  }
  const file = c.files[kind];
  if (!file) throw new Error(`场景 "${caseName}" 没有 "${kind}" 的 fixture`);
  return { data: loadMusicJson(file), case: c };
}

/** 列出全部音乐场景名 */
export function listMusicCases() {
  return loadMusicIndex().cases.map((c) => c.name);
}

/**
 * FakeMusicProvider —— 零出网的音乐提供方替身。
 *
 * 实现与真实 provider 相同的接口，并支持注入失败模式，
 * 用于验证 docs/01 §5.2 的降级链。
 */
export function createFakeMusicProvider({ fixtures = 'any', failureMode = null } = {}) {
  const calls = [];
  const idx = loadMusicIndex();

  const pickCase = (query) => {
    if (fixtures !== 'any') return idx.cases.find((c) => c.name === fixtures);
    const q = String(query).toLowerCase();
    // 简单的关键词路由：让测试能通过「检索词」命中期望的场景
    if (/陈粒|小半/.test(q)) return idx.cases.find((c) => c.name === 'chenli-xiaoban');
    if (/李志|下雨/.test(q)) return idx.cases.find((c) => c.name === 'lizhi-xiayu');
    if (/joox/.test(q)) return idx.cases.find((c) => c.name === 'joox-qingtian');
    return idx.cases.find((c) => c.name === 'qingtian');
  };

  const fail = (op) => {
    if (!failureMode) return null;
    if (failureMode === 'all') return new Error(`FakeMusicProvider: 注入失败 (${op})`);
    if (failureMode === 'timeout') return Object.assign(new Error('FakeMusicProvider: 注入超时'), { code: 'ETIMEDOUT' });
    if (failureMode === 'rateLimit' && op !== 'search') {
      return Object.assign(new Error('HTTP 503'), { code: 'E_RATE_LIMIT' });
    }
    return null;
  };

  return {
    name: 'fake-music',
    calls,
    async search(query, opts = {}) {
      calls.push({ op: 'search', query, opts });
      const e = fail('search'); if (e) throw e;
      const c = pickCase(query);
      return loadMusicJson(c.files.search);
    },
    async resolveUrl(trackRef, opts = {}) {
      calls.push({ op: 'resolveUrl', trackRef, opts });
      const e = fail('resolveUrl'); if (e) throw e;
      const caseName = typeof trackRef === 'string' ? trackRef : trackRef.caseName;
      const c = idx.cases.find((x) => x.name === caseName) || pickCase(trackRef?.title || '');
      if (!c.files.url) throw new Error('该场景无 url fixture');
      const data = loadMusicJson(c.files.url);
      // 忠实还原真实行为：无直链时是空字符串，调用方必须自己判空
      return { url: data.url, br: data.br, size: data.size, playable: /^https?:\/\/\S+/.test(data.url || '') };
    },
    async lyric(id, { caseName } = {}) {
      calls.push({ op: 'lyric', id, caseName });
      const e = fail('lyric'); if (e) throw e;
      const c = idx.cases.find((x) => x.name === caseName) || pickCase(String(id));
      if (!c.files.lyric) throw new Error('该场景无 lyric fixture');
      return loadMusicJson(c.files.lyric);
    },
    async cover(picId, { caseName } = {}) {
      calls.push({ op: 'cover', picId, caseName });
      const e = fail('cover'); if (e) throw e;
      const c = idx.cases.find((x) => x.name === caseName) || pickCase(String(picId));
      if (!c.files.pic) throw new Error('该场景无 pic fixture');
      return loadMusicJson(c.files.pic);
    },
    async playlist(id) {
      calls.push({ op: 'playlist', id });
      const e = fail('playlist'); if (e) throw e;
      const c = idx.cases.find((x) => x.files.playlist);
      if (!c) throw new Error('无 playlist fixture（录制时用了 --no-playlist）');
      return loadMusicJson(c.files.playlist);
    },
  };
}

// ───────────────────────── TTS ─────────────────────────

/**
 * FakeTtsAdapter —— 零 spawn、零网络、零磁盘（除非显式测缓存层）。
 * 返回固定字节数的假 mp3，见 docs/12-testing-strategy.md §3.2。
 */
export function createFakeTtsAdapter({ bytes = 4096, failMode = null, latencyMs = 0 } = {}) {
  const calls = [];
  let failCount = 0;
  return {
    name: 'fake-tts',
    engine: 'fake',
    calls,
    async available() { return failMode !== 'unavailable'; },
    async listVoices() { return [{ name: 'fake-voice', gender: 'Female', locale: 'zh-CN' }]; },
    async synthesize({ text, voice = 'fake-voice', rate = '+0%', pitch = '+0Hz' }) {
      calls.push({ text, voice, rate, pitch });
      if (latencyMs) await new Promise((r) => setTimeout(r, latencyMs));
      if (failMode === 'always') throw new Error('FakeTtsAdapter: 注入失败');
      if (failMode === 'once' && failCount++ === 0) throw new Error('FakeTtsAdapter: 首次注入失败');
      // 稳定 hash，便于断言缓存键
      let h = 0;
      for (const ch of `${voice}|${rate}|${pitch}|${text}`) h = (h * 31 + ch.codePointAt(0)) >>> 0;
      const hash = h.toString(16).padStart(8, '0').repeat(2).slice(0, 16);
      return {
        hash, url: `/tts/${hash}.mp3`, path: null, mime: 'audio/mpeg',
        bytes, cached: false, engine: 'fake', durationMs: Math.max(500, text.length * 180),
      };
    },
  };
}

// ───────────────────────── 通用断言辅助 ─────────────────────────

/** DjAction 的字段校验（与 docs/03-api-contract.md#dj-action-v1 一致） */
export const TRACK_REF_RE = /^\S.*?\s-\s.+$/;

export function validateDjAction(action) {
  const errs = [];
  if (typeof action !== 'object' || action === null) return ['不是对象'];
  if (typeof action.say !== 'string') errs.push('say 缺失或非字符串');
  else if (action.say.length === 0) errs.push('say 为空字符串');
  else if (action.say.length > 200) errs.push(`say 超过 200 字（${action.say.length}）`);
  if (!Array.isArray(action.play)) errs.push('play 缺失或非数组');
  else {
    if (action.play.length > 5) errs.push(`play 超过 5 个元素（${action.play.length}）`);
    action.play.forEach((p, i) => {
      if (typeof p !== 'string') errs.push(`play[${i}] 不是字符串`);
      else if (!TRACK_REF_RE.test(p)) errs.push(`play[${i}] 格式不合规: "${p}"`);
    });
  }
  if (typeof action.reason !== 'string') errs.push('reason 缺失或非字符串');
  if (action.segue !== undefined && typeof action.segue !== 'string') errs.push('segue 非字符串');
  return errs;
}

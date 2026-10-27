/**
 * Claudiao · HTTP 服务（M5-T1/T2，docs/03-api-contract.md）
 *
 * 6 条 API：POST /api/chat · GET /api/now · GET /api/next · GET|PUT /api/taste ·
 * GET /api/plan/today · GET /api/health；静态：/（web/）、/tts/*（缓存）、/fallback/*。
 * 安全：非 127.0.0.1 必须 RADIO_AUTH_TOKEN（?token= 或 Authorization）；body 上限 64KB；
 * 静态扩展名白名单。
 */
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { WsHub } from './ws/hub.js';
import { BRAIN_PROVIDERS, DirectApiBrainAdapter, listProviderModels } from './adapters/brain/direct-api.js';

const STATIC_ALLOWLIST = new Set(['.html', '.js', '.css', '.json', '.webmanifest', '.png', '.jpg', '.jpeg', '.svg', '.ico', '.webp', '.mp3', '.wav']);

export function createServer(deps = {}) {
  const { config, compute, state, corpusHashFn } = deps;
  const log = (deps.log?.child?.('http')) ?? deps.log ?? console;
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: config.server.maxBodyBytes ?? 65536 }));

  const isLocal = deps.isLocalFn || ((req) => ['127.0.0.1', '::1', 'localhost'].includes(req.hostname) ||
    ['127.0.0.1', '::1'].includes(req.socket?.remoteAddress?.replace('::ffff:', '')));
  const authorized = (req) => {
    if (isLocal(req)) return true;
    const t = config.server.authToken;
    if (!t) return false;
    const given = req.query.token || String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    return given === t;
  };
  const requireAuth = (req, res, next) => {
    if (!authorized(req)) return res.status(401).json({ error: 'E_UNAUTHORIZED', message: '非本机访问需要令牌' });
    next();
  };
  app.use('/api', requireAuth);

  // ---------- POST /api/chat ----------
  const _chatCache = new Map();       // clientMsgId → { at, result }
  app.post('/api/chat', async (req, res) => {
    const text = String(req.body?.text ?? '').trim();
    if (!text) return res.status(400).json({ error: 'E_BAD_REQUEST', message: 'text 不能为空' });
    if (text.length > 1000) return res.status(400).json({ error: 'E_INPUT_TOO_LONG', message: 'text 超过 1000 字' });
    const clientMsgId = String(req.body?.clientMsgId || '');
    if (clientMsgId) {
      const hit = _chatCache.get(clientMsgId);
      if (hit && Date.now() - hit.at < 60_000) return res.json(hit.result);
    }
    if (req.body?.preferStream) {
      res.status(202).json({ accepted: true, hint: '结果经 WS /stream 推送 now-playing' });
      try {
        const b = await compute.handleUserChat(text, { clientMsgId });
        deps.hub?.broadcast('now-playing', b);
      } catch (e) { log.error?.('chat(preferStream) 失败', { error: e.message }); }
      return;
    }
    try {
      const b = await compute.handleUserChat(text, { clientMsgId });
      if (clientMsgId) {
        _chatCache.set(clientMsgId, { at: Date.now(), result: b });
        if (_chatCache.size > 200) {
          const oldest = [..._chatCache.entries()].sort((a, b2) => a[1].at - b[1].at)[0];
          if (oldest) _chatCache.delete(oldest[0]);
        }
      }
      res.json(b);
    } catch (e) {
      log.error?.('chat 失败', { error: e.message });
      res.status(500).json({ error: 'E_COMPUTE', message: e.message });
    }
  });

  // ---------- 大脑 API 接入（设置页）：供应商目录 / 测试 / 保存热切换 ----------

  app.get('/api/brain-config', (req, res) => {
    const pref = state?.getPref?.('brain.config') || null;
    const envKey = Boolean(deps.brainEnvKey);
    res.json({
      providers: BRAIN_PROVIDERS,
      current: pref
        ? { provider: pref.provider, model: pref.model, baseUrl: pref.baseUrl || '', keyMasked: '••••' + String(pref.apiKey).slice(-4), source: 'settings' }
        : envKey
          ? { provider: 'bigmodel', model: config.brain.model, baseUrl: 'https://open.bigmodel.cn/api/anthropic', keyMasked: '••••（config/.env）', source: 'env' }
          : null,
      activeKind: deps.brain?.adapter?.constructor?.name === 'DirectApiBrainAdapter' ? 'direct-api' : 'zcode-agent',
    });
  });

  app.put('/api/brain-config', (req, res) => {
    const { provider, apiKey, model, baseUrl, thinking } = req.body || {};
    const preset = BRAIN_PROVIDERS.find((p) => p.id === provider);
    if (!preset && provider !== 'custom') return res.status(400).json({ error: 'E_BAD_REQUEST', message: '未知供应商' });
    if (!String(apiKey || '').trim()) return res.status(400).json({ error: 'E_BAD_REQUEST', message: 'API Key 不能为空' });
    if (!String(model || '').trim()) return res.status(400).json({ error: 'E_BAD_REQUEST', message: '模型名不能为空' });
    if (provider === 'custom' && !String(baseUrl || '').trim()) return res.status(400).json({ error: 'E_BAD_REQUEST', message: '自定义供应商需要填写 Base URL' });
    const cfg = {
      provider: provider || 'custom',
      apiKey: String(apiKey).trim(),
      model: String(model).trim(),
      baseUrl: String(baseUrl || '').trim(),
      thinking: Boolean(thinking),
    };
    state?.setPref?.('brain.config', cfg, `设置页保存（${cfg.provider}/${cfg.model}）`);
    // 热切换：直接替换 BrainService 的适配器，下一轮思考立即生效
    deps.brain.adapter = new DirectApiBrainAdapter({
      apiKey: cfg.apiKey, model: cfg.model,
      baseUrl: cfg.baseUrl || preset?.baseUrl || undefined,
      protocol: preset?.protocol || 'anthropic', thinking: cfg.thinking,
      timeoutMs: config.brain.timeoutMs, log,
    });
    log.info?.('大脑已热切换', { provider: cfg.provider, model: cfg.model });
    res.json({ ok: true, activeKind: 'direct-api', model: cfg.model });
  });

  app.post('/api/brain-config/models', async (req, res) => {
    try {
      const models = await listProviderModels({
        provider: req.body?.provider,
        apiKey: String(req.body?.apiKey || '').trim(),
        baseUrl: String(req.body?.baseUrl || '').trim(),
      });
      res.json({ ok: true, models });
    } catch (e) {
      res.status(e.code === 'E_BAD_REQUEST' ? 400 : 502).json({ error: e.code || 'E_MODELS', message: e.message });
    }
  });

  app.post('/api/brain-config/test', async (req, res) => {
    const { provider, apiKey, model, baseUrl, thinking } = req.body || {};
    if (!String(apiKey || '').trim()) return res.status(400).json({ error: 'E_BAD_REQUEST', message: 'API Key 不能为空' });
    const preset = BRAIN_PROVIDERS.find((p) => p.id === provider);
    const adapter = new DirectApiBrainAdapter({
      apiKey: String(apiKey).trim(), model: String(model || '').trim(),
      baseUrl: String(baseUrl || '').trim() || preset?.baseUrl,
      protocol: preset?.protocol || 'anthropic', thinking: Boolean(thinking),
      timeoutMs: 30000, log,
    });
    const r = await adapter.health();
    res.json(r);
  });

  // ---------- GET /api/dj · DJ 主页卡片 ----------
  app.get('/api/dj', (req, res) => {
    let genres = null;
    try {
      const f = path.join(config.root, 'knowledge', 'user', 'dj-card.json');
      const j = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (Array.isArray(j.genres)) genres = j.genres.map(String).slice(0, 12);
    } catch { /* 无自定义卡片用默认 */ }
    res.json({
      name: 'Valen',
      tagline: '你的专属私人 DJ · 一开机就打碟',
      bio: ['Your mood is my prompt.', 'I hate algorithm. I have taste.'],
      genres: genres || ['JAZZ-HIPHOP', 'CITY-POP', '90S华语', 'POST-ROCK', 'SHIBUYA-KEI', '下雨白噪音'],
      onAir: true,
      uptimeS: Math.floor(process.uptime()),
    });
  });

  // ---------- POST /api/feedback · 收藏/取消收藏当前曲目 ----------
  app.post('/api/feedback', requireAuth, (req, res) => {
    const bid = String(req.body?.broadcastId || '');
    if (!bid) return res.status(400).json({ error: 'E_BAD_REQUEST', message: 'broadcastId 必填' });
    const fb = req.body?.feedback === 1 || req.body?.feedback === true ? 1 : 0;
    const row = state?.findPlayByBroadcast?.(bid);
    if (!row) return res.status(404).json({ error: 'E_NOT_FOUND', message: '该播报没有播放记录' });
    state.setPlayFeedback(row.id, fb);
    res.json({ ok: true, id: row.id, feedback: fb });
  });

  // ---------- GET /api/now ----------
  app.get('/api/now', (req, res) => {
    const b = compute.nowPlaying();
    if (!b) return res.status(404).json({ error: 'E_NO_BROADCAST', message: '还没有任何播报' });
    const etag = `W/"${crypto.createHash('sha1').update(JSON.stringify(b)).digest('hex').slice(0, 16)}"`;
    if (req.headers['if-none-match'] === etag) return res.status(304).end();
    res.set('ETag', etag).json(b);
  });

  // ---------- GET /api/next ----------
  app.get('/api/next', (req, res) => {
    const b = compute.nowPlaying();
    if (!b) return res.status(404).json({ error: 'E_NO_BROADCAST', message: '还没有任何播报' });
    const cur = b.queue[deps.playback.index ?? 0];
    if (req.query.advance === '1') {
      if (cur && state) {
        // 记跳过（docs/03 §2.3）
        try {
          const row = state.recentPlays(20).find((p) => p.broadcast_id === b.id && p.track_id === cur.id);
          if (row) state.updatePlayProgress(row.id, { playedMs: Number(req.query.playedMs) || 0 });
          else if (deps.playback.markSkipped) deps.playback.markSkipped(b.id, cur);
        } catch { /* ignore */ }
      }
      deps.playback.index = (deps.playback.index ?? 0) + 1;
      deps.hub?.broadcast('queue-update', { index: deps.playback.index });
    }
    const next = b.queue[deps.playback.index ?? 0] || null;
    res.json({ index: deps.playback.index ?? 0, next });
  });

  // ---------- GET|PUT /api/taste ----------
  const kd = (f) => path.join(config.root, 'knowledge', f);
  const tasteEtag = () => `W/"${corpusHashFn().hash}"`;
  app.get('/api/taste', (req, res) => {
    const etag = tasteEtag();
    if (req.headers['if-none-match'] === etag) return res.status(304).end();
    let content = '';
    try { content = fs.readFileSync(kd('user/taste.md'), 'utf8'); } catch { /* ignore */ }
    res.set('ETag', etag).json({ sha1: corpusHashFn().hash, content });
  });
  app.put('/api/taste', (req, res) => {
    const { baseSha1, content } = req.body || {};
    if (typeof content !== 'string' || content.length > 50000) {
      return res.status(400).json({ error: 'E_BAD_REQUEST', message: 'content 缺失或超过 50000 字' });
    }
    const cur = corpusHashFn().hash;
    if (baseSha1 && baseSha1 !== cur) {
      return res.status(409).json({ error: 'E_TASTE_CONFLICT', message: `语料已被其他改动更新（当前 ${cur}，提交基于 ${baseSha1}）` });
    }
    const file = kd('user/taste.md');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    const newHash = corpusHashFn().hash;
    deps.hub?.broadcast('state-change', { state: 'corpus_updated', sha1: newHash });
    res.json({ sha1: newHash, unchanged: newHash === cur && content.length > 0 ? undefined : undefined, saved: true });
  });

  // ---------- GET /api/plan/today ----------
  app.get('/api/plan/today', (req, res) => {
    if (!state) return res.json({ date: localDate(), slots: [] });
    const p2 = (n) => String(n).padStart(2, '0');
    const d = new Date();
    const date = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
    const rows = state.todayPlan(date);
    const etag = `W/"${date}-${rows.length}-${rows.map((r) => r.status).join('')}"`;
    if (req.headers['if-none-match'] === etag) return res.status(304).end();
    res.set('ETag', etag).json({ date, slots: rows });
  });

  // ---------- GET /api/health ----------
  app.get('/api/health', async (req, res) => {
    const health = {
      ok: true, uptimeS: Math.round(process.uptime()), rssMb: Math.round(process.memoryUsage().rss / 1048576),
      wsClients: deps.hub?.clientCount?.() ?? 0,
    };
    if (config.radio?.observability?.healthDetail !== false) {
      health.brain = { ...deps.brain?.circuitStatus?.(), available: deps.brain?.available?.() ?? false };
      health.music = deps.musicHealth || null;
      health.tts = { engine: config.tts.engine, fallbackEnabled: config.tts.fallbackEnabled };
    }
    res.json(health);
  });

  // ---------- TTS 音色库：全量清单 + 即时试音（选音色页用） ----------
  app.get('/api/tts/voices', requireAuth, async (req, res) => {
    try {
      const voices = await deps.tts.listVoices();
      res.json({ count: voices.length, voices });
    } catch (e) {
      res.status(503).json({ error: 'E_TTS_LIST', message: e.message });
    }
  });
  app.get('/api/tts/preview', requireAuth, async (req, res) => {
    try {
      const r = await deps.tts.preview(String(req.query.voice || ''), String(req.query.pitch || '+0Hz'));
      res.set('Content-Type', 'audio/mpeg').sendFile(r.file);
    } catch (e) {
      res.status(400).json({ error: 'E_PREVIEW', message: e.message });
    }
  });

  // ---------- GET /api/lyric：歌词（官方优先，gdstudio 兜底） ----------
  app.get('/api/lyric', requireAuth, async (req, res) => {
    try {
      const { encryptedId, lyricId, id } = req.query;
      if (!encryptedId && !lyricId && !id) {
        return res.status(400).json({ error: 'E_BAD_REQUEST', message: '需要 encryptedId 或 lyricId/id' });
      }
      const r = await deps.music.lyric({
        encryptedId: encryptedId || null,
        lyricId: lyricId || id || null,
        id: id || lyricId || null,
      });
      res.json(r);
    } catch (e) {
      res.status(500).json({ error: 'E_LYRIC', message: e.message });
    }
  });

  // ---------- 网易云扫码登录（cookie 音源） ----------
  app.get('/api/netease/login/qr', requireAuth, async (req, res) => {
    try {
      res.json(await deps.music.cookieSrc.loginQrCreate());
    } catch (e) {
      res.status(503).json({ error: 'E_NCM', message: e.message });
    }
  });
  app.get('/api/netease/login/check', requireAuth, async (req, res) => {
    try {
      const r = await deps.music.cookieSrc.loginQrCheck();
      if (r.code === 803) deps.hub?.broadcast('state-change', { state: 'netease_logged_in' });
      res.json(r);
    } catch (e) {
      res.status(400).json({ error: 'E_QR', message: e.message });
    }
  });
  app.get('/api/netease/status', requireAuth, (req, res) => {
    res.json({
      loggedIn: deps.music.cookieSrc.loggedIn,
      needsLogin: deps.music.cookieSrc.needsLogin,
      installed: deps.music.cookieSrc.installed,
    });
  });
  app.post('/api/netease/logout', requireAuth, (req, res) => {
    deps.music.cookieSrc.logout();
    res.json({ ok: true });
  });

  // ---------- 无限漫游模式 ----------
  app.get('/api/roaming', requireAuth, (req, res) => {
    res.json({ enabled: Boolean(compute.roaming?.enabled) });
  });
  app.post('/api/roaming', requireAuth, async (req, res) => {
    const enabled = Boolean(req.body?.enabled);
    res.json(await compute.setRoaming(enabled));
  });
  app.post('/api/roaming/next', requireAuth, async (req, res) => {
    const clientIndex = Number.isFinite(Number(req.body?.index)) ? Number(req.body.index) : undefined;
    // 客户端上报的在队/已推清单：漫游避重的第一手材料（服务端另有 24h 播过自查）
    const queueSpecs = Array.isArray(req.body?.queue)
      ? req.body.queue.filter((x) => typeof x === 'string' && x.trim()).slice(0, 200)
      : [];
    const r = await compute.roamNext({ clientIndex, queueSpecs });
    res.json({ ok: true, ...r });
  });

  // ---------- 品味画像管线（歌单导入 → 大脑分析 → 常驻语料） ----------
  const tasteImportDir = path.join(config.root, 'knowledge', 'user', 'taste-imports');
  app.post('/api/taste/import', requireAuth, async (req, res) => {
    const ids = (Array.isArray(req.body?.ids) ? req.body.ids : String(req.body?.ids || '').split(/[,，\s]+/))
      .map((x) => String(x).trim()).filter((x) => /^\d+$/.test(x));
    if (!ids.length) return res.status(400).json({ error: 'E_BAD_REQUEST', message: '需要歌单 ID（纯数字，多个用逗号隔开）' });
    try {
      const { importPlaylists } = await import('./layer2/taste.js');
      const imported = await importPlaylists({ env: deps.env, outDir: tasteImportDir, ids, log });
      res.json({ imported });
    } catch (e) {
      res.status(500).json({ error: 'E_IMPORT', message: e.message });
    }
  });
  app.post('/api/taste/analyze', requireAuth, async (req, res) => {
    try {
      const { generateTasteProfile } = await import('./layer2/taste.js');
      const adapter = deps.brainAdapter;
      if (!adapter?.available?.()) return res.status(503).json({ error: 'E_BRAIN_UNAVAILABLE', message: '大脑不可用' });
      const r = await generateTasteProfile({
        env: deps.env, root: config.root, adapter, importDir: tasteImportDir,
        existingTaste: typeof req.body?.existingTaste === 'string' ? req.body.existingTaste : undefined,
        log,
      });
      adapter.rotate?.();                                             // 分析消耗大，轮换会话保持后续播报轻快
      deps.hub?.broadcast('state-change', { state: 'taste_profile_updated', chars: r.chars });
      res.json({ chars: r.chars, profile: r.text });
    } catch (e) {
      const code = e.code === 'E_NO_IMPORTS' ? 400 : 500;
      res.status(code).json({ error: e.code || 'E_ANALYZE', message: e.message });
    }
  });
  app.get('/api/taste/profile', requireAuth, (req, res) => {
    const file = path.join(config.root, 'knowledge', 'user', 'taste-profile.md');
    const exists = fs.existsSync(file);
    res.json({ exists, content: exists ? fs.readFileSync(file, 'utf8') : '' });
  });

  // ---------- 静态资源 ----------
  const webDir = deps.webDir || path.join(config.root, 'web');
  app.use(express.static(webDir, { extensions: ['html'] }));
  app.use('/tts', express.static(path.isAbsolute(config.tts.cacheDir) ? config.tts.cacheDir : path.join(config.root, config.tts.cacheDir)));
  const fbDir = path.join(config.root, config.music.fallbackDir || 'data/fallback-audio');
  app.use('/fallback', (req, res, next) => {
    const name = path.basename(decodeURIComponent(req.path));
    const file = path.join(fbDir, name);
    if (!fs.existsSync(file)) return res.status(404).end();
    res.sendFile(file);
  });

  // 错误兜底（body 解析错误等）
  app.use((err, req, res, next) => {
    if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'E_BODY_TOO_LARGE' });
    if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'E_BAD_JSON' });
    log.error?.('HTTP 错误', { error: err.message });
    res.status(500).json({ error: 'E_INTERNAL' });
  });

  const server = app.listen(config.server.port, config.server.host, () => {
    log.info?.(`电台已开播 http://${config.server.host}:${config.server.port}`);
  });
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      log.error?.(`端口 ${config.server.port} 已被占用——大概率已有一个电台实例在运行。`);
      log.error?.(`处理：关掉旧实例（任务管理器搜 node.exe），或改 config/.env 的 PORT 换端口。`);
    } else {
      log.error?.('HTTP 服务启动失败', { error: err.message });
    }
    process.exit(1);
  });
  const hub = new WsHub({ server, heartbeatSeconds: config.radio?.frontend?.wsHeartbeatSeconds ?? 25, log });
  return { app, server, hub };
}

function localDate(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

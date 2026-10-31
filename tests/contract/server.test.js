/**
 * M5 验收 —— 服务契约测试（docs/03）：6 条 API + 静态 + WS 事件 + 令牌/413。
 * 全离线：假大脑（固定 DjAction）、假音乐（直链即时返回）、FakeTts、临时 StateStore。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../../src/server.js';
import { StateStore } from '../../src/layer2/state.js';
import { FakeTtsAdapter } from '../../src/layer2/tts.js';
import WebSocket from 'ws';

const ROOT = path.resolve(import.meta.dirname, '..', '..');

function fakeStack({ brainFail = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claudiao-srv-'));
  const cfg = {
    root,
    server: { host: '127.0.0.1', port: 0, authToken: 'tok123', maxBodyBytes: 65536, staticAllowlist: [] },
    brain: { timeoutMs: 5000, retry: 0 },
    tts: { voice: 'v', rate: '+0%', pitch: '+0Hz', cacheDir: 'data/tts-cache', concurrency: 1, fallbackEnabled: false },
    music: { fallbackDir: 'data/fallback-audio' },
    radio: { observability: { healthDetail: true }, frontend: { wsHeartbeatSeconds: 25 } },
  };
  const brain = {
    available: () => !brainFail,
    circuitStatus: () => ({ open: false, recentFailures: 0, openCount: 0 }),
    compute: async () => brainFail
      ? (() => { throw new Error('down'); })()
      : { action: { say: '契约测试播报。', play: ['李志 - 下雨'], reason: '契约理由', segue: '', degraded: [] },
          raw: { sessionId: 'sess_c', usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 3 } },
          meta: { path: 'final', repairs: [], retries: 0, attempts: 1 } },
    health: async () => ({ ok: true }),
    close: () => {},
  };
  const music = {
    resolve: async () => ({ url: 'https://cdn.example/x.mp3', br: 320, size: 1, from: 't', resolvedAt: 0, expiresAt: 1,
      track: { originalId: '186016', id: 'ENC', source: 'netease', name: '下雨', artist: ['李志'], album: 'A', coverUrl: null, durationMs: 200000, playFlag: true }, score: 50 }),
    search: async () => [],
    official: { search: async (q) => [{ name: '下雨', artist: ['李志'], playFlag: true, originalId: '186016' }] },
  };
  const state = new StateStore(path.join(root, 'radio.db'));
  return { cfg, brain, music, state, root };
}

test('服务契约：6 条 API + 静态 + WS + 413', async () => {
  const { cfg, brain, music, state, root } = fakeStack();
  const { ComputeService } = await import('../../src/layer2/compute.js');
  const playback = { index: 0 };
  const compute = new ComputeService({
    config: cfg, brain, music, tts: new FakeTtsAdapter(), state,
    log: { info() {}, warn() {}, error() {}, debug() {}, prompt() {}, child() { return this; } },
    onBroadcast: (b) => hub?.broadcast?.('now-playing', b),
  });
  const { server, hub } = createServer({
    config: cfg, brain, music, state, compute,
    tts: new FakeTtsAdapter(),
    webDir: path.join(ROOT, 'web'),
    isLocalFn: (req) => !req.headers.authorization?.includes('wrong'),   // 令牌含 wrong → 视为非本机且未授权
    log: { info() {}, warn() {}, error() {}, debug() {}, prompt() {}, child() { return this; } },
    corpusHashFn: () => ({ hash: 'abc123def4567890', degraded: false }),
    playback,
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const auth = { Authorization: 'Bearer tok123' };

  try {
    // 静态壳层
    const page = await fetch(`${base}/`, { headers: auth });
    assert.equal(page.status, 200);
    assert.ok((await page.text()).includes('Sonder'));

    // 非本机语义：无令牌 → 401（用 Host 头伪装非本机域名时 hostname 检查不成立……
    // 这里验证令牌错误 → 401）
    const bad = await fetch(`${base}/api/now`, { headers: { Authorization: 'Bearer wrong' } });
    assert.equal(bad.status, 401);

    // /api/chat
    const chat = await fetch(`${base}/api/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...auth },
      body: JSON.stringify({ text: '放一首李志的下雨', clientMsgId: 'cm1' }),
    });
    assert.equal(chat.status, 200);
    const b = await chat.json();
    assert.equal(b.state, 'SPEAKING');
    assert.equal(b.say.engine, 'fake');
    assert.equal(b.queue.length, 1);
    // 精确点播走音乐车道直连（不进大脑，usage 为 null）——2026-10 优化后契约
    assert.equal(b.timings.parsePath, 'music-lane');
    assert.ok(b.queue[0].title.length > 0);

    // clientMsgId 幂等回放
    const replay = await fetch(`${base}/api/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...auth },
      body: JSON.stringify({ text: '放一首李志的下雨', clientMsgId: 'cm1' }),
    });
    const b2 = await replay.json();
    assert.equal(b2.id, b.id, 'clientMsgId 60s 内回放同一结果');

    // 超长文本 400
    const long = await fetch(`${base}/api/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...auth },
      body: JSON.stringify({ text: 'x'.repeat(1001) }),
    });
    assert.equal(long.status, 400);

    // /api/now + ETag 304
    const now = await fetch(`${base}/api/now`, { headers: auth });
    assert.equal(now.status, 200);
    const etag = now.headers.get('etag');
    assert.ok(etag);
    const now304 = await fetch(`${base}/api/now`, { headers: { ...auth, 'If-None-Match': etag } });
    assert.equal(now304.status, 304);

    // /api/next advance
    const next = await fetch(`${base}/api/next?advance=1`, { headers: auth });
    const nj = await next.json();
    assert.equal(nj.index, 1);
    assert.equal(nj.next, null, '队列只有一首，推进后无下一首');

    // /api/taste GET/PUT + 冲突
    const t1 = await fetch(`${base}/api/taste`, { headers: auth });
    const t1j = await t1.json();
    assert.ok(t1j.sha1);
    const put = await fetch(`${base}/api/taste`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', ...auth },
      body: JSON.stringify({ baseSha1: t1j.sha1, content: '# 新品味\n' }),
    });
    assert.equal(put.status, 200);
    const conflict = await fetch(`${base}/api/taste`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', ...auth },
      body: JSON.stringify({ baseSha1: 'stale', content: '# 冲突\n' }),
    });
    assert.equal(conflict.status, 409);

    // /api/plan/today
    const plan = await fetch(`${base}/api/plan/today`, { headers: auth });
    assert.equal(plan.status, 200);
    const pj = await plan.json();
    assert.ok(Array.isArray(pj.slots));

    // /api/health
    const health = await fetch(`${base}/api/health`, { headers: auth });
    const hj = await health.json();
    assert.ok(hj.brain);
    assert.equal(hj.brain.available, true);

    // 413
    const big = await fetch(`${base}/api/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...auth },
      body: JSON.stringify({ text: 'x' }) .toString().padEnd(70000, 'x'),
    });
    assert.equal(big.status, 413);

    // WS：连接收到 hello；触发 chat 收到 now-playing
    const ws = new WebSocket(`ws://127.0.0.1:${port}/stream?token=tok123`);
    const events = [];
    await new Promise((resolve, reject) => {
      ws.on('message', (d) => { events.push(JSON.parse(d)); if (events.length >= 2) resolve(); });
      ws.on('error', reject);
      setTimeout(resolve, 3000);
    });
    assert.equal(events[0].type, 'hello');
    assert.ok(events[0].seq >= 1);
    // 触发一次 preferStream chat
    await fetch(`${base}/api/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...auth },
      body: JSON.stringify({ text: '来点安静的', preferStream: true, clientMsgId: 'cm-ws' }),
    });
    await new Promise((r) => { const t = setTimeout(r, 3000); ws.on('message', (d) => { const e = JSON.parse(d); if (e.type === 'now-playing') { clearTimeout(t); r(); } }); });
    ws.close();
  } finally {
    hub.close();
    server.close();
    state.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/**
 * M4-T5/T6 验收单测 —— compute 编排：三条降级链 / 单飞 / Broadcast 契约 / 落库
 * 全部离线：假大脑 + 假音乐 + FakeTts + 临时 StateStore。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { ComputeService } from '../../src/layer2/compute.js';
import { StateStore } from '../../src/layer2/state.js';
import { FakeTtsAdapter } from '../../src/layer2/tts.js';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
/** 与 makeDeps 音乐桩一致的派生 id（24h id 去重测试用） */
const specId = (spec) => 'id_' + crypto.createHash('md5').update(String(spec)).digest('hex').slice(0, 10);

function makeDeps({
  brainText = '{"say":"测试播报。","play":["李志 - 下雨"],"reason":"测试理由","segue":""}',
  brainFail = false, musicFail = false, ttsFail = false, ttsOverride = null, state = null,
} = {}) {
  const cfg = {
    root: ROOT, log: { dir: 'data/logs' },
    brain: { timeoutMs: 5000, retry: 0 },
    tts: { voice: 'v', rate: '+0%', pitch: '+0Hz', cacheDir: 'data/tts-cache', concurrency: 1 },
    music: { fallbackDir: 'data/fallback-audio' },
    routines: { slots: [{ name: 'morning' }] },
  };
  const brain = {
    available: () => true,
    compute: async () => {
      if (brainFail) throw Object.assign(new Error('超时'), { code: 'E_TIMEOUT' });
      const r = { text: brainText, usage: { inputTokens: 1, outputTokens: 2 }, sessionId: 'sess_t' };
      return {
        action: (() => { const p = JSON.parse(brainText); return { ...p, degraded: [] }; })(),
        raw: { text: brainText, latencyMs: 5, sessionId: 'sess_t', usage: r.usage },
        meta: { path: 'final', repairs: [], retries: 0, attempts: 1 },
      };
    },
  };
  const music = {
    resolve: async (spec) => {
      if (musicFail) throw Object.assign(new Error('无直链'), { code: 'E_NO_URL' });
      return { url: 'https://cdn.example/x.mp3', br: 320, size: 1000, from: 'test', resolvedAt: Date.now(), expiresAt: Date.now() + 600000, track: { originalId: specId(spec), id: specId(spec), source: 'netease', name: spec.split(' - ')[1] || spec, artist: [spec.split(' - ')[0] || '未知'], album: 'A', coverUrl: 'http://c', durationMs: 200000, playFlag: true }, score: 50 };
    },
    search: async () => [],
  };
  const tts = ttsOverride || new FakeTtsAdapter();
  return { cfg, brain, music, tts, state };
}

function makeCompute(deps) {
  const state = deps.state || new StateStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'claudiao-c-')), 't.db'));
  const svc = new ComputeService({
    config: deps.cfg, brain: deps.brain, music: deps.music, tts: deps.tts,
    state, log: { info() {}, warn() {}, error() {}, debug() {}, prompt() {}, child() { return this; } },
  });
  return { svc, state };
}

test('正常链路：route→brain→music→tts→Broadcast 契约 + 落库', async () => {
  const { svc, state } = makeCompute(makeDeps());
  const b = await svc.handleUserChat('下雨了，来点安静的');
  assert.equal(typeof b.id, 'string');
  assert.match(b.id, /^b_\d{8}T\d{6}_[0-9a-f]{4}$/);
  assert.equal(b.state, 'SPEAKING');
  assert.equal(b.degraded, false);
  assert.equal(b.say.engine, 'fake');
  assert.equal(b.say.skipped, false);
  assert.equal(b.queue.length, 1);
  assert.equal(b.queue[0].title, '下雨');
  assert.ok(b.timings.totalMs >= 0);
  assert.ok(b.contextHash);
  // 落库：dj 消息 + play 记录
  const msgs = state.recentMessages(5);
  assert.ok(msgs.some((m) => m.role === 'dj'));
  const plays = state.recentPlays(5);
  assert.ok(plays.some((p) => p.title === '下雨'));
});

test('降级链①：大脑失败 → 模板播报（brain_template）', async () => {
  const { svc } = makeCompute(makeDeps({ brainFail: true }));
  const b = await svc.handleUserChat('随便');
  assert.equal(b.degraded, true);
  assert.ok(b.degradedReasons.includes('brain_template'));
  assert.ok(b.say.text.length > 0, '模板 say 非空');
});

test('降级链②：音乐全失败 → fallback_audio（playlists 取曲或纯口播）', async () => {
  const { svc } = makeCompute(makeDeps({ musicFail: true }));
  const b = await svc.handleUserChat('放一首李志的下雨');
  // 官方搜索不在测试栈里：musicFail 让 resolve 全挂 → fallback_audio 或 music_no_url
  assert.ok(b.degradedReasons.some((d) => d.startsWith('music_')), JSON.stringify(b.degradedReasons));
});

test('降级链③：TTS 失败 → say.skipped + MUSIC_ONLY（文字仍下发）', async () => {
  const brokenTts = { synthesize: async () => { throw Object.assign(new Error('两级失败'), { code: 'E_TTS_SAPI_FAIL' }); } };
  const { svc } = makeCompute(makeDeps({ ttsOverride: brokenTts }));
  const b = await svc.handleUserChat('来点安静的');
  assert.equal(b.say.skipped, true);
  assert.equal(b.say.text.includes('测试播报'), true, 'say.text 仍下发');
  assert.equal(b.state, 'MUSIC_ONLY');
  assert.ok(b.degradedReasons.includes('tts_skipped'));
});

test('纯口播：play=[] → 无队列不降级', async () => {
  const { svc } = makeCompute(makeDeps({ brainText: '{"say":"今天有会。","play":[],"reason":"日程播报","segue":""}' }));
  const b = await svc.handleUserChat('今天有什么安排');
  assert.equal(b.queue.length, 0);
  assert.equal(b.degraded, false);
  assert.equal(b.state, 'SPEAKING');
});

test('单飞：并发 5 次点播串行执行（同一时刻只跑一个 compute）', async () => {
  const deps = makeCompute(makeDeps(makeDeps0()));
  let concurrent = 0, peak = 0;
  const origExec = ComputeService.prototype._exec;
  deps.svc._exec = async function (intent, priority) {
    concurrent++; peak = Math.max(peak, concurrent);
    try { return await origExec.call(this, intent, priority); }
    finally { concurrent--; }
  };
  await Promise.all(Array.from({ length: 5 }, (_, i) => deps.svc.handleUserChat(`点播${i}`)));
  assert.ok(peak <= 1, `峰值 ${peak} 应 ≤1`);
});

function makeDeps0() {
  return { brainText: '{"say":"s","play":[],"reason":"r","segue":""}' };
}

// ---------- 选曲发散：24h 硬去重 ----------

test('24h 去重：大脑推近期播过的歌被硬过滤（repeat_filtered），用户点名豁免', async () => {
  const { svc, state } = makeCompute(makeDeps({
    brainText: '{"say":"s","play":["李志 - 下雨","朴树 - 平凡之路"],"intros":["a","b"],"reason":"r","segue":""}',
  }));
  state.addPlay({ trackId: specId('李志 - 下雨'), source: 'netease', title: '下雨', artist: '李志', spec: '李志 - 下雨', atMs: Date.now() - 3600e3 });
  const b = await svc.handleUserChat('随便放点');
  assert.equal(b.queue.length, 1);
  assert.equal(b.queue[0].spec, '朴树 - 平凡之路');
  assert.ok(b.degradedReasons.includes('repeat_filtered'), JSON.stringify(b.degradedReasons));

  // 用户亲口点名 → 豁免硬过滤
  const b2 = await svc.handleUserChat('再放一遍李志的下雨');
  assert.ok(b2.queue.some((t) => t.spec === '李志 - 下雨'), '用户点名应豁免');
});

test('24h 去重（解析后 id 命中）：换个写法的同一首也拦下', async () => {
  const { svc, state } = makeCompute(makeDeps({
    brainText: '{"say":"s","play":["李志 - 下雨 (Live)"],"reason":"r","segue":""}',
  }));
  // 库里记录的是旧写法「李志 - 下雨」，但 track_id 等于新写法解析出的 id
  state.addPlay({ trackId: specId('李志 - 下雨 (Live)'), source: 'netease', title: '下雨', artist: '李志', spec: '李志 - 下雨', atMs: Date.now() - 1800e3 });
  const b = await svc.handleUserChat('随便放点');
  assert.equal(b.queue.length, 0, '换写法的重复不应进队列');
});

test('大脑全在炒冷饭 → 个人红心曲库回填（repeat_refill_library）', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claudiao-dedup-'));
  fs.mkdirSync(path.join(root, 'knowledge', 'user', 'taste-imports'), { recursive: true });
  fs.writeFileSync(path.join(root, 'knowledge', 'user', 'taste-imports', 'pl.json'),
    JSON.stringify({ tracks: [{ id: '9001', artist: '万青', title: '秦皇岛' }, { id: '9002', artist: '崔健', title: '花房姑娘' }] }));
  const deps = makeDeps({ brainText: '{"say":"s","play":["李志 - 下雨"],"reason":"r","segue":""}' });
  deps.cfg.root = root;
  const { svc, state } = makeCompute(deps);
  state.addPlay({ trackId: specId('李志 - 下雨'), source: 'netease', title: '下雨', artist: '李志', spec: '李志 - 下雨', atMs: Date.now() - 1800e3 });
  const b = await svc.handleUserChat('随便放点');
  assert.ok(b.degradedReasons.includes('repeat_refill_library'), JSON.stringify(b.degradedReasons));
  const specs = b.queue.map((t) => t.spec).sort();
  assert.deepEqual(specs, ['万青 - 秦皇岛', '崔健 - 花房姑娘']);
});

test('漫游：大脑批次经 24h 硬去重，红心兜底同样避重', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claudiao-roam-'));
  fs.mkdirSync(path.join(root, 'knowledge', 'user', 'taste-imports'), { recursive: true });
  fs.writeFileSync(path.join(root, 'knowledge', 'user', 'taste-imports', 'pl.json'),
    JSON.stringify({ tracks: [{ id: '9003', artist: '罗大佑', title: '光阴的故事' }] }));
  const deps = makeDeps({
    brainText: '{"say":"s","play":["李志 - 下雨","朴树 - 平凡之路"],"intros":["a","b"],"reason":"r","segue":""}',
  });
  deps.cfg.root = root;
  const { svc, state } = makeCompute(deps);
  // 两首都在 24h 内播过 → 大脑批次应被滤光 → 红心兜底给光阴的故事
  state.addPlay({ trackId: specId('李志 - 下雨'), source: 'netease', title: '下雨', artist: '李志', spec: '李志 - 下雨', atMs: Date.now() - 1800e3 });
  state.addPlay({ trackId: specId('朴树 - 平凡之路'), source: 'netease', title: '平凡之路', artist: '朴树', spec: '朴树 - 平凡之路', atMs: Date.now() - 3600e3 });
  svc.roaming.enabled = true;
  const r = await svc.roamNext({ queueSpecs: [] });
  assert.ok(r.queued);
  assert.equal(r.tracks.length, 1);
  assert.equal(r.tracks[0].spec, '罗大佑 - 光阴的故事');
  assert.equal(r.source, 'library');
});

test('开场白：每日时段首次播报注入问候，播后标记不重复', async () => {
  const { svc, state } = makeCompute(makeDeps({
    brainText: '{"say":"你好，我是 Valen，你的私人 DJ。","play":["朴树 - 平凡之路"],"intros":["b"],"reason":"r","segue":""}',
  }));
  // 首播前：greeting.lastKey 应不存在（首次开口触发）
  assert.equal(state.getPref('greeting.lastKey'), undefined);
  const b = await svc.handleUserChat('随便放点');
  assert.equal(b.state, 'SPEAKING');
  // 播后：greeting.lastKey 已标记为 今日|时段
  const key = state.getPref('greeting.lastKey');
  assert.ok(key, '播后应标记 greeting.lastKey');
  assert.match(key, /^\d{4}-\d{1,2}-\d{1,2}\|(早|中|晚)$/);
  // 重置大脑状态文件不影响：同时段第二次播报后标记不变（不重复问候）
  const key2 = state.getPref('greeting.lastKey');
  await svc.handleUserChat('再来点');
  assert.equal(state.getPref('greeting.lastKey'), key2 ?? key);
});

test('漫游：大脑批次经 24h 硬去重，红心兜底同样避重', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claudiao-roam-'));
  fs.mkdirSync(path.join(root, 'knowledge', 'user', 'taste-imports'), { recursive: true });
  fs.writeFileSync(path.join(root, 'knowledge', 'user', 'taste-imports', 'pl.json'),
    JSON.stringify({ tracks: [{ id: '9003', artist: '罗大佑', title: '光阴的故事' }] }));
  const deps = makeDeps({
    brainText: '{"say":"s","play":["李志 - 下雨","朴树 - 平凡之路"],"intros":["a","b"],"reason":"r","segue":""}',
  });
  deps.cfg.root = root;
  const { svc, state } = makeCompute(deps);
  // 两首都在 24h 内播过 → 大脑批次应被滤光 → 红心兜底给光阴的故事
  state.addPlay({ trackId: specId('李志 - 下雨'), source: 'netease', title: '下雨', artist: '李志', spec: '李志 - 下雨', atMs: Date.now() - 1800e3 });
  state.addPlay({ trackId: specId('朴树 - 平凡之路'), source: 'netease', title: '平凡之路', artist: '朴树', spec: '朴树 - 平凡之路', atMs: Date.now() - 3600e3 });
  svc.roaming.enabled = true;
  const r = await svc.roamNext({ queueSpecs: [] });
  assert.ok(r.queued);
  assert.equal(r.tracks.length, 1);
  assert.equal(r.tracks[0].spec, '罗大佑 - 光阴的故事');
  assert.equal(r.source, 'library');
});

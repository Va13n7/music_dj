/**
 * M2 验收单测 —— TTS 缓存键 / LRU / 三级降级 / 队列 / FakeTts
 *
 * 验收（docs/10 M2-T2/T4/T5）：
 *   - 缓存命中 <50ms；换 TTS_VOICE 后缓存键变化（D-07）
 *   - FakeTtsAdapter：固定 URL、恒定字节、零 spawn
 *   - 并发上限 ≤2；队列满时 prefetch 被丢弃
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cacheKey, TtsService, FakeTtsAdapter } from '../../src/layer2/tts.js';
import { EdgeTtsAdapter } from '../../src/adapters/tts/edge-tts.js';

function ttsCfg(over = {}) {
  return {
    edgeBin: 'C:\\nonexistent\\edge-tts.exe', // 默认指到不存在的路径 → 走降级路径
    voice: 'zh-CN-XiaoxiaoNeural', rate: '+0%', pitch: '+0Hz', volume: '+0%',
    cacheDir: 'data/tts-cache', cacheMaxFiles: 5, cacheMaxBytes: 1048576,
    concurrency: 2, timeoutMs: 5000, breakerThreshold: 2, sapiVoice: 'Microsoft Huihui Desktop',
    fallbackEnabled: false, // 单测默认禁 SAPI（不起 powershell），SAPI 相关用单独开关测
    ...over,
  };
}
function tmpSvc(over = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claudiao-tts-'));
  return new TtsService({ ttsConfig: ttsCfg(over), root, log: { info() {}, warn() {}, child: () => ({ info() {}, warn() {} }) } });
}

test('缓存键：换 voice/rate/pitch/text 任一即变（D-07）', () => {
  const a = cacheKey({ voice: 'v1', rate: '+0%', pitch: '+0Hz', text: 'hi' });
  const b = cacheKey({ voice: 'v2', rate: '+0%', pitch: '+0Hz', text: 'hi' });
  const c = cacheKey({ voice: 'v1', rate: '+10%', pitch: '+0Hz', text: 'hi' });
  const d = cacheKey({ voice: 'v1', rate: '+0%', pitch: '+0Hz', text: 'hi!' });
  assert.notEqual(a, b); assert.notEqual(a, c); assert.notEqual(a, d);
  assert.equal(a, cacheKey({ voice: 'v1', rate: '+0%', pitch: '+0Hz', text: 'hi' }), '同输入同键');
  assert.match(a, /^[0-9a-f]{16}$/);
});

test('缓存命中 <50ms（预置文件）', async () => {
  const svc = tmpSvc();
  const key = cacheKey({ voice: 'zh-CN-XiaoxiaoNeural', rate: '+0%', pitch: '+0Hz', text: '缓存命中测试' });
  fs.writeFileSync(path.join(svc.cacheDir, `${key}.mp3`), Buffer.alloc(2048, 1));
  const t0 = performance.now();
  const r = await svc.synthesize({ text: '缓存命中测试' });
  const ms = performance.now() - t0;
  assert.ok(r.cached === true);
  assert.ok(ms < 50, `命中耗时 ${ms.toFixed(1)}ms 应 <50ms`);
  svc.close?.();
});

test('两级失败 → E_TTS_SAPI_FAIL（fallback 禁用时）', async () => {
  const svc = tmpSvc(); // edgeBin 不存在 + fallbackEnabled=false
  await assert.rejects(() => svc.synthesize({ text: '两级都失败' }),
    (e) => e.code === 'E_TTS_SAPI_FAIL');
});

test('FakeTtsAdapter：固定 URL、恒定字节、零 spawn', async () => {
  const fake = new FakeTtsAdapter();
  const r1 = await fake.synthesize({ text: 'a' });
  const r2 = await fake.synthesize({ text: 'b' });
  assert.equal(r1.bytes, 42);
  assert.equal(r2.bytes, 42);
  assert.match(r1.audioUrl, /^\/tts\/fake-1\.mp3$/);
  assert.equal(fake.calls.length, 2);
});

test('队列：并发峰值 ≤2，队列满时 prefetch 被丢弃', async () => {
  // 用一个可控的假合成层观察并发：直接测 TtsService._drain 的并发计数
  const svc = tmpSvc();
  svc.maxQueue = 3; // 收窄队列，确定性触发丢弃
  let peak = 0, running = 0;
  svc._synthesizeNow = async (job) => {
    running++; peak = Math.max(peak, running);
    await new Promise((r) => setTimeout(r, 80));
    running--;
    return { audioUrl: `/tts/x.mp3`, engine: 'edge-tts', cached: false, bytes: 1, skipped: false };
  };
  // 8 个任务：前 5 个占满 2 运行 + 3 队列；j5(user) 挤不掉→拒；j6/j7(prefetch)→丢
  const jobs = Array.from({ length: 8 }, (_, i) =>
    svc.synthesize({ text: `并发任务${i}`, priority: i >= 6 ? 'prefetch' : 'user' })
      .then(() => 'done', (e) => e.code));
  const results = await Promise.all(jobs);
  assert.ok(peak <= 2, `并发峰值 ${peak} 应 ≤2`);
  assert.equal(results.filter((r) => r === 'done').length, 5, '2 运行 + 3 排队 = 5 个成功');
  assert.equal(results.filter((r) => r === 'E_TTS_QUEUE_FULL').length, 3, '3 个被丢弃');
});

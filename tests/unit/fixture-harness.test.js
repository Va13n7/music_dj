/**
 * fixture 底座自测 —— 证明「回放测试」这条路真的能跑。
 *
 * 这组测试**不碰任何真实外部依赖**：不 spawn dsh、不出网、不写磁盘。
 * 它的作用是验证 tests/support/fixtures.js 本身可靠 —— 如果底座有问题，
 * 后面 M1/M3 写的适配器测试都会得出假结论。
 *
 * 运行: node --test tests/unit/fixture-harness.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BRAIN_FIXTURES, MUSIC_FIXTURES,
  loadBrainFixture, listBrainFixtures, replayBrainProcess,
  loadMusicIndex, loadMusic, listMusicCases,
  createFakeMusicProvider, createFakeTtsAdapter, validateDjAction,
} from '../support/fixtures.js';

// docs/12-testing-strategy.md §3.1 要求的 12 个场景
const REQUIRED_BRAIN_SCENARIOS = [
  'ok-normal', 'ok-markdown-fenced', 'ok-empty-play', 'ok-with-usage',
  'bad-malformed-json', 'bad-missing-say', 'bad-overlong-say',
  'timeout', 'exit1-credential', 'exit1-profile-desktop',
  'session-lost', 'empty-final',
];

test('大脑 fixture：12 个场景齐备', () => {
  const have = listBrainFixtures();
  const missing = REQUIRED_BRAIN_SCENARIOS.filter((s) => !have.includes(s));
  assert.deepEqual(missing, [], `缺少场景: ${missing.join(', ')}（在 ${BRAIN_FIXTURES}）`);
  assert.equal(have.length, REQUIRED_BRAIN_SCENARIOS.length);
});

test('大脑 fixture：每行都是合法 JSON 且带 _meta', () => {
  for (const name of REQUIRED_BRAIN_SCENARIOS) {
    const f = loadBrainFixture(name);
    assert.ok(f.meta.scenario, `${name}: 缺少 _meta.scenario`);
    assert.equal(typeof f.exitCode, 'number', `${name}: exitCode 非数字`);
  }
});

test('大脑 fixture：ok-normal 含完整事件序列且 DjAction 合规', () => {
  const { events, exitCode } = loadBrainFixture('ok-normal');
  assert.equal(exitCode, 0);

  const types = events.map((e) => e.type);
  assert.ok(types.includes('session'), '缺 session');
  assert.ok(types.includes('final'), '缺 final');

  const turnEnd = events.find((e) => e.type === 'status' && e.phase === 'turn_end');
  assert.equal(turnEnd?.reason?.kind, 'completed');

  const finalText = events.find((e) => e.type === 'final').text;
  const action = JSON.parse(finalText);
  assert.deepEqual(validateDjAction(action), [], 'DjAction 应完全合规');
  assert.ok(action.play.length > 0, 'ok-normal 的 play 应非空');
});

test('大脑 fixture：ok-markdown-fenced 确实带护栏（回放容错的目标）', () => {
  const { events } = loadBrainFixture('ok-markdown-fenced');
  const finalText = events.find((e) => e.type === 'final').text;
  assert.match(finalText, /```/, '该 fixture 必须含 markdown 围栏，否则测不到剥离逻辑');

  // 剥离后的内容必须是合法 DjAction —— 这就是适配器要实现的容错
  const stripped = finalText.replace(/```(?:json)?\s*([\s\S]*?)```/i, '$1').trim();
  assert.deepEqual(validateDjAction(JSON.parse(stripped)), []);
});

test('大脑 fixture：ok-empty-play 的 play 为空数组（纯口播路径）', () => {
  const { events } = loadBrainFixture('ok-empty-play');
  const action = JSON.parse(events.find((e) => e.type === 'final').text);
  assert.deepEqual(action.play, []);
  assert.deepEqual(validateDjAction(action), [], '空 play 是合法的（allowEmptyPlay: true）');
});

test('大脑 fixture：bad-* 场景确实能让校验失败', () => {
  // 缺 say
  {
    const a = JSON.parse(loadBrainFixture('bad-missing-say').events.find((e) => e.type === 'final').text);
    assert.ok(validateDjAction(a).some((e) => /say/.test(e)), '应报 say 缺失');
  }
  // 超长 say
  {
    const a = JSON.parse(loadBrainFixture('bad-overlong-say').events.find((e) => e.type === 'final').text);
    assert.ok(a.say.length > 200, `say 应超过 200 字，实际 ${a.say.length}`);
    assert.ok(validateDjAction(a).some((e) => /200/.test(e)), '应报超长');
  }
  // 不可解析
  {
    const t = loadBrainFixture('bad-malformed-json').events.find((e) => e.type === 'final').text;
    assert.throws(() => JSON.parse(t), '该 fixture 必须不可解析');
  }
  // 空 final
  {
    const t = loadBrainFixture('empty-final').events.find((e) => e.type === 'final').text;
    assert.equal(t, '', 'final.text 应为空字符串');
  }
});

test('大脑 fixture：exit1-* 带 stderr 且声明了退出码 1', () => {
  for (const name of ['exit1-credential', 'exit1-profile-desktop']) {
    const f = loadBrainFixture(name);
    assert.equal(f.exitCode, 1, `${name}: 退出码应为 1`);
    assert.ok(f.stderr.length > 0, `${name}: 应有 .stderr.txt`);
  }
  assert.match(loadBrainFixture('exit1-credential').stderr, /MISSING_CREDENTIAL/);
  assert.match(loadBrainFixture('exit1-profile-desktop').stderr,
    /is managed exclusively by the Electron application/);
});

test('replayBrainProcess：模拟子进程能产出与 fixture 一致的事件流', async () => {
  const child = replayBrainProcess('ok-normal');
  const chunks = [];
  child.stdout.on('data', (d) => chunks.push(d.toString('utf8')));

  const exitCode = await new Promise((resolve) => {
    child.on('close', (code) => resolve(code));
    child.stdin.end('任意 prompt（回放模式忽略）');
  });

  assert.equal(exitCode, 0);
  const events = chunks.join('').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const expected = loadBrainFixture('ok-normal').events;
  assert.equal(events.length, expected.length, '回放事件数应与 fixture 一致');
  assert.equal(events.at(-1).type, 'final');
});

test('replayBrainProcess：kill() 后 close 带信号，模拟超时杀树', async () => {
  const child = replayBrainProcess('timeout');
  const done = new Promise((resolve) => child.on('close', (code, signal) => resolve({ code, signal })));
  child.stdin.end();
  child.kill('SIGKILL');
  const { signal } = await done;
  assert.equal(signal, 'SIGKILL');
  assert.equal(child.killed, true);
});

test('replayBrainProcess：_fixture 暴露合成标记，便于测试区分真实性', () => {
  assert.equal(replayBrainProcess('ok-normal')._fixture.synthetic, false);
  assert.equal(replayBrainProcess('timeout')._fixture.synthetic, true);
});

// ───────────────────────── 音乐 ─────────────────────────

test('音乐 fixture：索引与场景齐备', () => {
  const idx = loadMusicIndex();
  assert.ok(idx.cases.length >= 4, `场景应 ≥ 4，实际 ${idx.cases.length}`);
  const names = listMusicCases();
  for (const n of ['qingtian', 'lizhi-xiayu', 'chenli-xiaoban', 'joox-qingtian']) {
    assert.ok(names.includes(n), `缺少场景 ${n}（在 ${MUSIC_FIXTURES}）`);
  }
});

test('音乐 fixture：qingtian 含翻唱噪声（打分算法的验收依据）', () => {
  const { data, case: c } = loadMusic('qingtian', 'search');
  assert.ok(Array.isArray(data) && data.length > 0);

  // 实测首条就是翻唱 —— 这是这个 fixture 存在的理由
  const labels = data.map((x) => `${x.name} ${(x.artist || []).join('/')}`);
  const hasNoise = labels.some((l) => /深情版|原唱|翻唱|钢琴版/.test(l));
  assert.ok(hasNoise, `该 fixture 必须包含翻唱类噪声候选，实际: ${labels.join(' | ')}`);
  assert.ok(c.noiseCandidates.length > 0, 'index 应记录噪声候选');
});

test('音乐 fixture：joox 无直链是空字符串（实现陷阱的回归锚点）', () => {
  const { data } = loadMusic('joox-qingtian', 'url');
  assert.equal(data.url, '', 'joox 的 url 应为空字符串');
  assert.equal(typeof data.url, 'string', '它是 string —— 所以 typeof 判断会漏掉它');
  assert.equal(/^https?:\/\/\S+/.test(data.url), false, '正则判定才正确');
  assert.equal(data.br, -1);
});

test('音乐 fixture：netease 场景有可播放直链', () => {
  for (const name of ['qingtian', 'lizhi-xiayu', 'chenli-xiaoban']) {
    const { data } = loadMusic(name, 'url');
    assert.ok(/^https?:\/\/\S+/.test(data.url), `${name}: 应有可播放直链`);
    assert.ok(data.br > 0, `${name}: 码率应 > 0`);
    assert.ok(data.size > 0, `${name}: 大小应 > 0`);
  }
});

test('音乐 fixture：歌词含两种形态（有/无 LRC 时间戳）', () => {
  const withTs = loadMusic('lizhi-xiayu', 'lyric').data.lyric;
  assert.match(withTs, /\[\d{2}:\d{2}[.:]\d{2}\]/, '该场景应含 LRC 时间戳');

  const noTs = loadMusic('chenli-xiaoban', 'lyric').data.lyric;
  assert.ok(noTs.length > 0, '该场景应有歌词文本');
  assert.doesNotMatch(noTs, /\[\d{2}:\d{2}[.:]\d{2}\]/,
    '该场景实测无时间戳 —— 前端必须支持静态降级展示（docs/08）');
});

test('FakeMusicProvider：零出网返回 fixture 数据，并记录调用', async () => {
  const p = createFakeMusicProvider();
  const s = await p.search('陈粒 小半');
  assert.ok(Array.isArray(s) && s.length > 0);
  assert.equal(p.calls.length, 1);
  assert.equal(p.calls[0].op, 'search');

  const u = await p.resolveUrl({ caseName: 'chenli-xiaoban' });
  assert.equal(u.playable, true);
  assert.equal(p.calls.length, 2);
});

test('FakeMusicProvider：忠实还原 joox 的不可播放行为', async () => {
  const p = createFakeMusicProvider();
  const u = await p.resolveUrl({ caseName: 'joox-qingtian' });
  assert.equal(u.playable, false, '不得把空串当成可播放');
  assert.equal(u.url, '');
});

test('FakeMusicProvider：注入失败模式可驱动降级链测试', async () => {
  await assert.rejects(
    () => createFakeMusicProvider({ failureMode: 'all' }).search('任意'),
    /注入失败/,
  );
  await assert.rejects(
    () => createFakeMusicProvider({ failureMode: 'rateLimit' }).resolveUrl({ caseName: 'qingtian' }),
    /503/,
  );
  // rateLimit 模式下 search 仍可用（模拟「限流只影响突发敏感端点」）
  const s = await createFakeMusicProvider({ failureMode: 'rateLimit' }).search('晴天');
  assert.ok(Array.isArray(s));
});

// ───────────────────────── TTS ─────────────────────────

test('FakeTtsAdapter：零 spawn 产出稳定的假 mp3 与缓存键', async () => {
  const t = createFakeTtsAdapter();
  const a = await t.synthesize({ text: '晚上好。' });
  const b = await t.synthesize({ text: '晚上好。' });
  assert.equal(a.hash, b.hash, '相同输入应得到相同 hash');
  assert.equal(a.url, `/tts/${a.hash}.mp3`);
  assert.equal(a.bytes, 4096);
  assert.equal(a.mime, 'audio/mpeg');

  // 换音色必须换键（设计决策 D-07）
  const c = await t.synthesize({ text: '晚上好。', voice: 'other-voice' });
  assert.notEqual(a.hash, c.hash, '换音色应改变缓存键');
  // 换语速也应换键
  const d = await t.synthesize({ text: '晚上好。', rate: '+20%' });
  assert.notEqual(a.hash, d.hash, '换语速应改变缓存键');
});

test('FakeTtsAdapter：注入失败可驱动 TTS 降级测试', async () => {
  await assert.rejects(() => createFakeTtsAdapter({ failMode: 'always' }).synthesize({ text: 'x' }), /注入失败/);

  const once = createFakeTtsAdapter({ failMode: 'once' });
  await assert.rejects(() => once.synthesize({ text: 'x' }), /首次注入失败/);
  const ok = await once.synthesize({ text: 'x' });
  assert.equal(ok.engine, 'fake');
});

// ─────────────────── DjAction 校验器自身 ───────────────────

test('validateDjAction：与契约一致的边界', () => {
  assert.deepEqual(validateDjAction({ say: '好', play: [], reason: 'r', segue: '' }), []);

  // play 元素格式：必须半角连字符 + 两侧空格
  assert.ok(validateDjAction({ say: '好', play: ['李志－下雨'], reason: 'r' }).length > 0, '全角连字符应被拒');
  assert.ok(validateDjAction({ say: '好', play: ['李志-下雨'], reason: 'r' }).length > 0, '缺空格应被拒');
  assert.deepEqual(validateDjAction({ say: '好', play: ['李志 - 下雨'], reason: 'r' }), []);

  // 上限
  assert.ok(validateDjAction({ say: '好', play: Array(6).fill('A - B'), reason: 'r' }).length > 0, 'play > 5 应被拒');
  assert.ok(validateDjAction({ say: '甲'.repeat(201), play: [], reason: 'r' }).length > 0, 'say > 200 应被拒');

  // 缺字段
  assert.ok(validateDjAction({ play: [], reason: 'r' }).length > 0);
  assert.ok(validateDjAction({ say: '好', reason: 'r' }).length > 0);
  assert.ok(validateDjAction({ say: '好', play: [] }).length > 0);
});

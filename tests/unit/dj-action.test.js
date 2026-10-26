/**
 * M1 验收单测 —— DjAction 容错解析（docs/05 §6.1 的分步 fixture）+ BrainService 重试/熔断/降级
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseDjAction, normalizePlay, clampSay, extractLongestFence } from '../../src/layer2/dj-action.js';
import { BrainService } from '../../src/layer2/brain.js';

test('围栏剥离：```json 包裹 → path=fenced', () => {
  const r = parseDjAction('```json\n{"say":"晚安。","play":["李志 - 下雨"],"reason":"雨天","segue":""}\n```');
  assert.equal(r.path, 'fenced');
  assert.equal(r.action.say, '晚安。');
  assert.deepEqual(r.action.play, ['李志 - 下雨']);
});

test('offset：JSON 前后夹杂说明文字 → path=offset', () => {
  const r = parseDjAction('好的，这是结果：{"say":"晚安","play":[],"reason":"r","segue":""} 请欣赏');
  assert.equal(r.path, 'offset');
  assert.equal(r.action.say, '晚安');
});

test("R1 尾逗号 / R2 中文引号 / R3 单引号（含 it's 边界）", () => {
  const r1 = parseDjAction('{"say":"晚安。","play":["李志 - 下雨",],"reason":"雨天","segue":"",}');
  assert.deepEqual(r1.repairs, ['R1']);
  assert.equal(r1.action.play[0], '李志 - 下雨');

  const r2 = parseDjAction('{“say”:“晚安。”,“play”:[],“reason”:“纯口播”,“segue”:“”}');
  assert.deepEqual(r2.repairs, ['R2']);

  const r3 = parseDjAction("{'say':'放首 it's my life 吧','play':[],'reason':'x','segue':''}");
  assert.equal(r3.action.say, "放首 it's my life 吧");
});

test('R4 字符串内裸换行 / R5 补括号 / R6 前后缀', () => {
  const r4 = parseDjAction('{"say":"第一句\n第二句","play":[],"reason":"r","segue":""}');
  assert.ok(r4.repairs.includes('R4'));

  const r5 = parseDjAction('{"say":"晚安","play":["李志 - 下雨"');
  assert.ok(r5.repairs.includes('R5'));
  assert.deepEqual(r5.action.play, ['李志 - 下雨']);
});

test('不可修复 → E_BRAIN_PARSE', () => {
  assert.throws(() => parseDjAction('抱歉，我无法完成这次请求。'), (e) => e.code === 'E_BRAIN_PARSE');
});

test('空文本 → E_BRAIN_NO_FINAL', () => {
  assert.throws(() => parseDjAction(''), (e) => e.code === 'E_BRAIN_NO_FINAL');
  assert.throws(() => parseDjAction('   '), (e) => e.code === 'E_BRAIN_NO_FINAL');
});

test('字段归一化：play 字符串/对象数组/全角连字符/缺失 reason', () => {
  assert.deepEqual(normalizePlay('李志 - 下雨\n陈粒 - 小半'), ['李志 - 下雨', '陈粒 - 小半']);
  assert.deepEqual(normalizePlay([{ artist: '李志', title: '下雨' }]), ['李志 - 下雨']);
  assert.deepEqual(normalizePlay(['李志－下雨']), ['李志 - 下雨']);
  assert.deepEqual(normalizePlay(42), []);
  assert.deepEqual(normalizePlay(null), []);

  const r = parseDjAction('{"say":"ok","play":[8]}');
  assert.deepEqual(r.action.degraded, ['reason_missing']);
  assert.equal(r.action.reason, '（模型未给出理由）');
});

test('say 超长截断：句号位置 ≥50% 时按句末截断', () => {
  const text = '好'.repeat(150) + '。' + '尾'.repeat(100); // 251 字，句号在第 151 字
  const out = clampSay(text, 200);
  assert.ok(out.length <= 200);
  assert.ok(out.endsWith('。'), `应截到句号，实际结尾: ${out.slice(-3)}`);
  // 标点过早（<50%）→ 取满额 + …
  const early = '好。' + 'x'.repeat(250);
  const out2 = clampSay(early, 200);
  assert.ok(out2.endsWith('…'));
});

test('play 超过 5 首截断 + play_truncated', () => {
  const five = parseDjAction('{"say":"s","play":["a - 1","b - 2","c - 3","d - 4","e - 5","f - 6","g - 7","h - 8"],"reason":"r"}');
  assert.equal(five.action.play.length, 5);
  assert.ok(five.action.degraded.includes('play_truncated'));
});

test('extractLongestFence：多围栏取最长', () => {
  const s = '```json\n{"a":1}\n```\n中间\n```json\n{"b":2,"c":3,"d":4}\n```';
  assert.equal(extractLongestFence(s), '{"b":2,"c":3,"d":4}');
});

// ---------- 真实 fixture 回放：tests/fixtures/brain/*.ndjson ----------

function finalTextOf(fixture) {
  const lines = fixture.split(/\r?\n/).filter(Boolean);
  const events = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const finalEv = events.find((e) => e.type === 'final');
  const lastText = [...events].reverse().find((e) => e.type === 'text' && e.text)?.text;
  return finalEv?.text ?? lastText ?? '';
}

const FIX_DIR = path.resolve(import.meta.dirname, '..', 'fixtures', 'brain');
const okFixtures = fs.existsSync(FIX_DIR)
  ? fs.readdirSync(FIX_DIR).filter((f) => f.startsWith('ok-'))
  : [];

test(`真实 fixture 回放：${okFixtures.length} 个 ok-* 场景解析出合法 DjAction`, () => {
  assert.ok(okFixtures.length >= 3, '至少应有 3 个 ok fixture');
  for (const f of okFixtures) {
    const text = finalTextOf(fs.readFileSync(path.join(FIX_DIR, f), 'utf8'));
    const r = parseDjAction(text);
    assert.equal(typeof r.action.say, 'string', `${f}: say 应为字符串`);
    assert.ok(Array.isArray(r.action.play), `${f}: play 应为数组`);
    assert.equal(typeof r.action.reason, 'string', `${f}: reason 应为字符串`);
  }
});

test('真实 fixture：bad-overlong-say 截断到 ≤200 字', () => {
  const p = path.join(FIX_DIR, 'bad-overlong-say.ndjson');
  if (!fs.existsSync(p)) return;
  const r = parseDjAction(finalTextOf(fs.readFileSync(p, 'utf8')));
  assert.ok(r.action.say.length <= 200);
  assert.ok(r.action.degraded.includes('say_truncated'));
});

test('真实 fixture：bad-missing-say → say_template 兜底（不抛错）', () => {
  const p = path.join(FIX_DIR, 'bad-missing-say.ndjson');
  if (!fs.existsSync(p)) return;
  const r = parseDjAction(finalTextOf(fs.readFileSync(p, 'utf8')));
  assert.ok(r.action.degraded.includes('say_template'));
  assert.ok(r.action.say.length > 0);
});

// ---------- BrainService：重试 / 熔断 / 模板降级 ----------

function fakeAdapter({ failures = 0, available = true } = {}) {
  let calls = 0;
  return {
    calls: () => calls,
    available: () => available,
    compute: async () => {
      calls++;
      if (calls <= failures) throw Object.assign(new Error('超时'), { code: 'E_TIMEOUT' });
      return { text: '{"say":"恢复了","play":[],"reason":"retry ok","segue":""}', usage: { inputTokens: 1, outputTokens: 2 }, sessionId: 'sess_x' };
    },
    health: async () => ({ ok: true }),
    close: () => {},
  };
}

const silentLog = { info() {}, warn() {}, error() {}, child() { return silentLog; } };

test('BrainService：首次失败重试成功，retries=1', async () => {
  const svc = new BrainService({ adapter: fakeAdapter({ failures: 1 }), env: { timeoutMs: 5000, retry: 1 }, log: silentLog });
  const r = await svc.compute('prompt');
  assert.equal(r.action.say, '恢复了');
  assert.equal(r.meta.retries, 1);
});

test('BrainService：模板降级返回合法 DjAction（brain_template）', async () => {
  const svc = new BrainService({
    adapter: fakeAdapter({ failures: 99 }),
    env: { timeoutMs: 5000, retry: 1 },
    log: silentLog,
    fallbackTemplate: ({ reason }) => ({ say: '先放首歌', play: [], reason: `大脑降级：${reason}`, segue: '' }),
  });
  const r = await svc.compute('prompt');
  assert.equal(r.action.degraded[0], 'brain_template');
  assert.equal(r.meta.path, 'fallback');
  assert.equal(r.action.play.length, 0);
});

test('BrainService：无模板时失败抛 BrainError', async () => {
  const svc = new BrainService({ adapter: fakeAdapter({ failures: 99 }), env: { timeoutMs: 5000, retry: 0 }, log: silentLog });
  await assert.rejects(() => svc.compute('prompt'), (e) => e.name === 'BrainError');
});

test('BrainService：连续 5 次失败 → 熔断打开，available()=false', async () => {
  const svc = new BrainService({ adapter: fakeAdapter({ failures: 99 }), env: { timeoutMs: 5000, retry: 0 }, log: silentLog,
    fallbackTemplate: ({ reason }) => ({ say: 'x', play: [], reason, segue: '' }) });
  for (let i = 0; i < 5; i++) await svc.compute('prompt');
  assert.equal(svc.circuitStatus().open, true);
  assert.equal(svc.available(), false);
});

/**
 * M4-T1 验收单测 —— router 意图分流（docs/02 §2.6 表 R-1~R-6 + 扩展）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { classify, matchMood } from '../../src/layer2/router.js';

const KD = path.resolve(import.meta.dirname, '..', '..', 'knowledge');

test('R-1 下一首 → control.next 直连', () => {
  const r = classify({ text: '下一首' }, { knowledgeDir: KD });
  assert.equal(r.name, 'control');
  assert.equal(r.slots.control, 'next');
  assert.equal(r.lane, 'direct');
  assert.equal(r.needBrain, false);
});

test('R-2 换一首周杰伦的 → 不判 control，play_request 带歌手', () => {
  const r = classify({ text: '换一首周杰伦的' }, { knowledgeDir: KD });
  assert.notEqual(r.name, 'control');
  assert.equal(r.name, 'play_request');
  assert.equal(r.slots.artist, '周杰伦');
});

test('R-3 空白折叠 + 情绪判定 → mood_request rainy，含 calm 候选', () => {
  const r = classify({ text: '  下雨了 ，来点  安静的。' }, { knowledgeDir: KD });
  assert.equal(r.name, 'mood_request');
  assert.equal(r.slots.mood, 'rainy');
  assert.ok(r.slots.moodCandidates.includes('calm'));
});

test('R-4 放《生如夏花》 → play_request music 车道', () => {
  const r = classify({ text: '放《生如夏花》' }, { knowledgeDir: KD });
  assert.equal(r.name, 'play_request');
  assert.equal(r.lane, 'music');
  assert.equal(r.needBrain, false);
});

test('R-5 schedule 来源 → scheduled_broadcast', () => {
  const r = classify({ source: 'schedule', slot: 'morning', text: '' }, { knowledgeDir: KD });
  assert.equal(r.name, 'scheduled_broadcast');
  assert.equal(r.slots.slot, 'morning');
  assert.equal(r.priority, 'schedule');
  assert.equal(r.text, '');
});

test('R-6 mood-rules 全部触发词表驱动可达（抽样 14 档）', () => {
  // 每档抽一个代表触发词
  const samples = {
    calm: '静一静', rainy: '下雨了', focus: '写代码', low: '好累', anxious: '好紧张',
    tired: '好困', happy: '太爽了', energize: '来点带劲的', commute: '上班路上',
    evening: '下班了', late_night: '还没睡', nostalgic: '想起以前', celebrate: '搞定了', random: '随便',
  };
  for (const [mood, word] of Object.entries(samples)) {
    const r = classify({ text: word }, { knowledgeDir: KD });
    assert.equal(r.name, 'mood_request', `"${word}" 应命中 mood_request`);
    assert.equal(r.slots.mood, mood, `"${word}" 应命中档位 ${mood}`);
  }
});

test('扩展：query 直连 / taste_edit / volume / 免打扰宾语下落', () => {
  const q = classify({ text: '现在在放什么' }, { knowledgeDir: KD });
  assert.equal(q.name, 'query');
  assert.equal(q.slots.query, 'now');

  const t = classify({ text: '以后别放周杰伦了' }, { knowledgeDir: KD });
  assert.equal(t.name, 'taste_edit');
  assert.equal(t.lane, 'brain');

  const v = classify({ text: '大点声' }, { knowledgeDir: KD });
  assert.equal(v.slots.control, 'volume_up');

  // 控制词带宾语 → 下落（「换一首周杰伦的」已在 R-2 覆盖）
  const f = classify({ text: '嗯' }, { knowledgeDir: KD });
  assert.equal(f.name, 'freeform');
});

test('robust：规则引擎内部异常不阻塞（空 knowledge 目录）', () => {
  const r = classify({ text: '下雨了，来点安静的' }, { knowledgeDir: path.join(os_tmp(), 'no-knowledge') });
  // mood 表解析不到 → 降级为 freeform/play_request，但绝不抛
  assert.ok(['freeform', 'mood_request', 'play_request'].includes(r.name));
});

function os_tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'r-')); }
import fs from 'node:fs';
import os from 'node:os';

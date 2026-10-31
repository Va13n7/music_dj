/**
 * 对话记忆（ChatMemory）：本地 JSON 文档、按日分桶、近三日窗口、注入文本格式。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ChatMemory } from '../../src/layer2/chat-memory.js';

function mkRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'claudiao-chatmem-'));
}

test('record/recent：按角色格式化，旧→新，user=台长 dj=Valen', () => {
  const root = mkRoot();
  const cm = new ChatMemory({ root });
  const base = new Date('2026-10-31T10:00:00').getTime();
  cm.record('user', '今天好累啊', base);
  cm.record('dj', '辛苦了，歌我不动，陪着你', base + 60_000);
  const text = cm.recent();
  assert.match(text, /\[10:00\] 台长：今天好累啊/);
  assert.match(text, /\[10:01\] Valen：辛苦了，歌我不动，陪着你/);
  assert.ok(text.indexOf('今天好累啊') < text.indexOf('辛苦了'), '旧→新排序');
});

test('三日窗口：超过 3 天的桶自动裁掉', () => {
  const root = mkRoot();
  const cm = new ChatMemory({ root });
  const now = new Date('2026-10-31T12:00:00').getTime();
  cm.record('user', '前天的话', now - 2 * 864e5);
  cm.record('user', '四天前的话', now - 4 * 864e5);
  cm.record('user', '今天的话', now);
  const text = cm.recent();
  assert.match(text, /前天的话/);
  assert.match(text, /今天的话/);
  assert.doesNotMatch(text, /四天前的话/);
  const raw = JSON.parse(fs.readFileSync(cm.file, 'utf8'));
  assert.equal(Object.keys(raw).length, 2, '文件里只剩 2 个日期桶');
});

test('预算从最新往回收：旧消息让位，最新必在', () => {
  const root = mkRoot();
  const cm = new ChatMemory({ root, maxPerDay: 500 });
  const now = new Date('2026-10-31T12:00:00').getTime();
  for (let i = 0; i < 50; i++) cm.record('user', `消息${i}` + 'x'.repeat(60), now - (50 - i) * 1000);
  const text = cm.recent({ maxChars: 1000 });
  assert.ok(text.length <= 1200, `长度受控（${text.length}）`);
  assert.match(text, /消息49/, '最新一条必在');
  assert.doesNotMatch(text, /消息0\n|消息0$/, '最旧的被挤出');
});

test('record 空文本与非法角色忽略；单日超限丢最旧', () => {
  const root = mkRoot();
  const cm = new ChatMemory({ root, maxPerDay: 3 });
  const now = Date.now();
  cm.record('user', 'a', now); cm.record('user', 'b', now); cm.record('user', 'c', now);
  cm.record('user', 'd', now);
  cm.record('guest', 'x', now); cm.record('user', '', now);
  const data = JSON.parse(fs.readFileSync(cm.file, 'utf8'));
  const bucket = data[Object.keys(data)[0]];
  assert.deepEqual(bucket.map((m) => m.text), ['b', 'c', 'd'], '超限丢最旧且非法输入不入桶');
  assert.equal(cm.count(), 3);
});

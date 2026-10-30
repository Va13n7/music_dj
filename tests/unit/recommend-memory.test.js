/**
 * 推荐记忆（近三日不重复）验收单测：记录 / 键匹配 / 过期裁剪 / 日期标注。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RecommendMemory } from '../../src/layer2/recommend-memory.js';

function makeMem() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claudiao-recmem-'));
  return new RecommendMemory({ root, log: { info() {}, warn() {} } });
}

test('记录与键匹配：record 后 recentKeys 能命中（大小写/空格归一）', () => {
  const mem = makeMem();
  mem.record(['The Weeknd - Call Out My Name', '颜人中 - 某年某月某天']);
  const keys = mem.recentKeys();
  assert.ok(keys.has('theweeknd|calloutmyname'), '归一化英文键应命中');
  assert.ok(keys.has('颜人中|某年某月某天'), '中文键应命中');
});

test('记录不产生重复：同一首重复 record 只算一次', () => {
  const mem = makeMem();
  mem.record(['A - B']);
  mem.record(['A - B', 'C - D']);
  const keys = [...mem.recentKeys()];
  assert.equal(keys.filter((k) => k === 'a|b').length, 1);
  assert.ok(keys.includes('c|d'));
});

test('过期裁剪：3 天前的桶被清除（允许重复推荐）', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claudiao-recmem-'));
  const mem = new RecommendMemory({ root, log: { info() {}, warn() {} } });
  mem.record(['新歌 - 新曲']);
  // 手动注入 4 天前的记忆桶
  const d = new Date(Date.now() - 4 * 864e5);
  const data = JSON.parse(fs.readFileSync(mem.file, 'utf8'));
  data[`${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`] = ['老歌 - 旧曲'];
  fs.writeFileSync(mem.file, JSON.stringify(data));
  // recentKeys 内部会 prune 过期桶 → 老歌不可见
  const keys = mem.recentKeys();
  assert.ok(![...keys].some((k) => k.includes('旧曲')), '过期桶应被裁剪');
  assert.ok(keys.has('新歌|新曲'), '未过期的记忆保留');
});

test('recentSpecs：带日期标注输出（注入漫游避重名单用）', () => {
  const mem = makeMem();
  mem.record(['A - B']);
  const specs = mem.recentSpecs();
  assert.equal(specs.length, 1);
  assert.match(specs[0], /A - B（\d{4}-\d{1,2}-\d{1,2} 推荐）/);
});

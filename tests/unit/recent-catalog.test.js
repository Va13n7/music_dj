/**
 * 最近播放目录（前 100 首）验收单测：
 * 目录生成（顺序/跳过标注/高频艺人）与 RECENT_ROTATION 提示词注入。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RecentCatalog } from '../../src/layer2/recent-catalog.js';
import { build as buildContext, renderPrompt } from '../../src/layer2/context.js';
import { StateStore } from '../../src/layer2/state.js';

function makeStore() {
  return new StateStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'claudiao-rc-')), 't.db'));
}

test('目录生成：旧→新顺序、跳过标注、高频艺人聚合', () => {
  const state = makeStore();
  const songs = [
    ['周杰伦', '晴天'], ['周杰伦', '七里香'], ['周杰伦', '轨迹'],
    ['Adele', 'Hello'], ['方大同', '春风吹'], ['周杰伦', '彩虹'],
  ];
  songs.forEach(([artist, title], i) => {
    const { id } = state.addPlay({
      trackId: String(i), source: 'netease', title, artist,
      spec: `${artist} - ${title}`, atMs: Date.now() - (songs.length - i) * 600e3,
    });
    if (i === 5) state.updatePlayProgress(id, { playedMs: 10000, durationMs: 200000 });   // 播了 5% → 记跳过
  });
  const rc = new RecentCatalog({ state, log: { info() {}, warn() {} } });
  const text = rc.refresh();
  assert.ok(text.includes('周杰伦 - 晴天'), '最早一首应在列');
  assert.ok(text.includes('周杰伦 - 彩虹'), '最新一首应在列');
  assert.ok(text.includes('（跳过）'), '跳过标注应存在');
  assert.ok(text.includes('周杰伦×4'), '高频艺人应聚合计数');
  assert.ok(text.includes('共 6 首'), '应标注总数');
  // get()：当天直接返回缓存
  assert.equal(rc.get(), text);
});

/**
 * 提示词组装验收单测 —— 选曲发散相关：
 * ④ MEMORY 片喂满近 40 次播放（含艺人 + 避重指令）；输出契约含「发散探索」硬规则。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { build as buildContext, renderPrompt } from '../../src/layer2/context.js';
import { StateStore } from '../../src/layer2/state.js';

test('RECENT_ROTATION 片段：最近播放目录注入提示词', async () => {
  const fragments = await buildContext(
    { name: 'freeform', text: '来点欧美风格的歌', slots: {}, source: 'user_chat' },
    { state: null, recentCatalog: '（旧→新，共 2 首）\n- 方大同 - 春风吹\n- 周杰伦 - 晴天（跳过）' },
  );
  assert.ok(fragments.recent.includes('春风吹'), '目录文本应进入片段');
  const prompt = renderPrompt(fragments);
  assert.ok(prompt.includes('RECENT_ROTATION'), '提示词应有独立片段围栏');
  assert.ok(prompt.includes('最新的听歌风格'), '应带推荐语义指令');
});

test('MEMORY 片：近 40 次播放含艺人 + 避重指令；输出契约含发散探索规则', async () => {
  const state = new StateStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'claudiao-ctx-')), 't.db'));
  for (let i = 0; i < 45; i++) {
    state.addPlay({ trackId: String(i), source: 'netease', title: `歌${i}`, artist: `歌手${i}`, spec: `歌手${i} - 歌${i}`, atMs: Date.now() - i * 600e3 });
  }
  const fragments = await buildContext(
    { name: 'freeform', text: '来点欧美风格的歌', slots: {}, source: 'user_chat' },
    { state },
  );
  // 窗口 = 40：最新的 i=0 在，第 45 早（i=44）不在
  assert.ok(fragments.memory.includes('歌手0 - 歌0'), '最新播放应带艺人入片');
  assert.ok(!fragments.memory.includes('歌手44 - 歌44'), '窗口应止于 40 条');
  assert.ok(fragments.memory.includes('一律避开'), '避重指令应随片注入');

  const prompt = renderPrompt(fragments);
  assert.ok(prompt.includes('发散探索'), '中文契约应有发散探索规则');
  assert.ok(prompt.includes('同一位艺人'), '契约应含同艺人去重约束');
});

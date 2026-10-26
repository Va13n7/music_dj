#!/usr/bin/env node
/**
 * taste-analyze —— 把导入的歌单交给大脑，生成「品味画像」（data-driven corpus）。
 *
 * 流程: 读 knowledge/user/taste-imports/*.json 聚合 → 组装分析 prompt →
 *       大脑（ZCode Agent）输出结构化品味画像 → 写 knowledge/user/taste-profile.md。
 *
 * taste-profile.md 是**常驻语料**：context.js 会把它作为 ② 片注入每一次播报，
 * 之后所有推荐自动遵循画像（这就是「导入一次，长期按个性推送」的机制）。
 *
 * 用法: npm run taste:analyze
 * 依赖: 先跑过 taste:import；大脑可用（zcode）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ZcodeAgentAdapter } from '../src/adapters/brain/zcode-agent.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const IMPORT_DIR = path.join(ROOT, 'knowledge', 'user', 'taste-imports');
const OUT_FILE = path.join(ROOT, 'knowledge', 'user', 'taste-profile.md');

function loadEnv() {
  const out = { ...process.env };
  const f = path.join(ROOT, 'config', '.env');
  if (!fs.existsSync(f)) return out;
  for (const raw of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 0) continue;
    const k = line.slice(0, i).trim();
    const v = line.slice(i + 1).trim().replace(/^["']|["']$/g, '');
    if (!(k in out) || !out[k] || k.startsWith('CLAUDIAO_')) out[k] = v;
  }
  return out;
}

const env = loadEnv();

// ---------- 1. 聚合导入数据 ----------
if (!fs.existsSync(IMPORT_DIR)) {
  console.error('还没有导入歌单。先运行: npm run taste:import <歌单ID>...');
  process.exit(1);
}
const files = fs.readdirSync(IMPORT_DIR).filter((f) => f.endsWith('.json'));
if (!files.length) {
  console.error('taste-imports 目录为空。先运行: npm run taste:import <歌单ID>...');
  process.exit(1);
}

const playlists = [];
let totalTracks = 0;
const artistFreq = {};
for (const f of files) {
  const j = JSON.parse(fs.readFileSync(path.join(IMPORT_DIR, f), 'utf8'));
  playlists.push(j);
  totalTracks += j.trackCount;
  for (const t of j.tracks) {
    for (const a of t.artist.split('/')) {
      if (a) artistFreq[a] = (artistFreq[a] || 0) + 1;
    }
  }
}
const topArtists = Object.entries(artistFreq).sort((a, b) => b[1] - a[1]).slice(0, 40);

// 组装紧凑的数据摘要（控制 token：每歌单最多 120 行曲目，高频艺人单独列）
let digest = '';
for (const pl of playlists) {
  digest += `\n【歌单：${pl.name}（${pl.trackCount} 首）】\n`;
  for (const t of pl.tracks.slice(0, 120)) {
    digest += `${t.artist} - ${t.title}\n`;
  }
  if (pl.trackCount > 120) digest += `（…其余 ${pl.trackCount - 120} 首略）\n`;
}
digest += `\n【高频艺人（出现次数）】\n${topArtists.map(([a, n]) => `${a}×${n}`).join('、')}\n`;
digest += `\n【热度参考】曲目自带网易云热度值 pop（0-100），样本均值: ${
  Math.round(playlists.reduce((s, p) => s + p.tracks.reduce((x, t) => x + (t.pop || 0), 0), 0) / Math.max(1, totalTracks))
}\n`;

console.log(`品味分析 —— 聚合 ${playlists.length} 个歌单 / ${totalTracks} 首曲目，交给大脑分析…\n`);

// ---------- 2. 大脑分析（直接用适配器拿原始长文输出，不经 DjAction 契约） ----------
const stubLog = () => {};
stubLog.info = () => {}; stubLog.warn = () => {}; stubLog.error = () => {};
stubLog.debug = () => {}; stubLog.prompt = () => {}; stubLog.child = () => stubLog;
const adapter = new ZcodeAgentAdapter({ root: ROOT, env, log: stubLog });
if (!adapter.available()) {
  console.error('大脑依赖不齐：', adapter.availabilityDetail().join('；'));
  process.exit(1);
}

const existingTaste = fs.existsSync(path.join(ROOT, 'knowledge', 'user', 'taste.md'))
  ? fs.readFileSync(path.join(ROOT, 'knowledge', 'user', 'taste.md'), 'utf8') : '（无）';

const prompt = `# 任务：音乐品味画像分析

你是音乐品味分析师。下面是一个人的网易云歌单导入数据（曲目全量）和现有品味语料。
请输出一份**品味画像**（Markdown，中文），之后电台会用这份画像为 ta 推歌。

## 输出格式（严格遵循，缺一不可）

# 品味画像

> 生成于 <日期> · 数据源：<N> 个歌单 / <M> 首曲目

## 一、核心口味画像
（一段话，150 字内，说清这个人是谁——听什么、为什么、性格侧写）

## 二、流派与风格权重
| 风格 | 权重% | 依据 |
|---|---|---|
（5~8 行，权重加总 100%，依据要引用具体曲目/艺人）

## 三、年代分布
（主力年代 + 一句观察）

## 四、核心艺人榜
（分"重度痴迷 / 常听 / 涉猎"三档列出艺人名）

## 五、能量与场景偏好
（安静/专注/通勤/深夜等场景分别适合推什么，2~4 行）

## 六、给电台的推送策略
（4~6 条具体可执行的推歌规则，例如"雨天优先推 X 类"、"- 避开 Y"）

## 要求
- 只依据数据说话，不编造没出现的艺人
- 与现有品味语料冲突时，以歌单数据为准，但指出冲突
- 语言自然，像乐评人写的，不要空话套话

# 数据

## 现有品味语料（taste.md）
${existingTaste}

## 歌单导入数据
${digest}`;

console.log('大脑分析中…（约 30~60s，输出较长）');
const started = Date.now();
const r = await adapter.compute(prompt, { timeoutMs: 180000 });
const text = r.text.trim().replace(/^```(?:markdown)?\n?|\n?```$/g, '');
fs.writeFileSync(OUT_FILE, `<!-- 由 tools/taste-analyze.js 生成于 ${new Date().toISOString()} · 数据源: ${playlists.map((p) => p.name).join('、')} -->\n\n${text}\n`);
console.log(`\n✓ 品味画像已写入 knowledge/user/taste-profile.md（${text.length} 字符，耗时 ${((Date.now() - started) / 1000).toFixed(0)}s）`);
console.log('  下一次播报起自动生效（作为 ② 语料片段注入每次推荐）。\n');
adapter.close();

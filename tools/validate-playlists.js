#!/usr/bin/env node
/**
 * validate-playlists —— 校验 knowledge/user/playlists.json 的结构与曲目格式。
 *
 * 语料是电台的灵魂，手写 JSON 容易出错。这个工具在把语料喂给大脑之前先挡住问题：
 *   1. JSON 是否可解析
 *   2. 每首曲目是否严格符合 "艺人 - 曲名"（空格 + 半角连字符 + 空格）
 *      —— 这个格式必须与 DjAction.play[] 的元素格式一致，否则音乐检索会解析失败
 *   3. slotDefaults / moodDefaults 是否指向真实存在的歌单（悬空引用）
 *   4. 每个歌单的必填字段是否齐全
 *
 * 退出码: 0 通过 / 1 有问题
 *
 * 用法: node tools/validate-playlists.js [path]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = process.argv[2] || path.join(ROOT, 'knowledge', 'user', 'playlists.json');

// "艺人 - 曲名"：半角连字符，两侧必须有空格
const TRACK_RE = /^\S.*?\s-\s.+$/;
const REQUIRED_PLAYLIST_FIELDS = ['id', 'name', 'tracks'];

let data;
try {
  data = JSON.parse(fs.readFileSync(target, 'utf8'));
} catch (e) {
  console.error(`JSON 解析失败: ${e.message}`);
  console.error(`文件: ${target}`);
  process.exit(1);
}

const problems = [];
const warnings = [];

// fallbackPool 不是 playlists[] 的成员，但允许被 slotDefaults / moodDefaults 引用
const ids = new Set([...(data.playlists || []).map((p) => p.id), 'fallbackPool']);

let trackTotal = 0;
const seenTracks = new Map();

for (const pl of data.playlists || []) {
  // 必填字段
  for (const f of REQUIRED_PLAYLIST_FIELDS) {
    if (pl[f] === undefined) problems.push(`歌单 ${pl.id || '(无 id)'} 缺少字段 ${f}`);
  }
  if (!Array.isArray(pl.tracks)) {
    problems.push(`歌单 ${pl.id}: tracks 不是数组`);
    continue;
  }
  if (pl.tracks.length === 0) warnings.push(`歌单 ${pl.id}: tracks 为空`);

  for (const t of pl.tracks) {
    trackTotal++;
    if (typeof t !== 'string') {
      problems.push(`歌单 ${pl.id}: 曲目不是字符串 → ${JSON.stringify(t)}`);
      continue;
    }
    if (!TRACK_RE.test(t)) {
      problems.push(`歌单 ${pl.id}: 格式不合规（应为 "艺人 - 曲名"，半角连字符两侧带空格）→ "${t}"`);
    }
    // 全角连字符 / 缺少空格 —— 最常见的两种手写错误
    if (/[－—–]/.test(t)) {
      problems.push(`歌单 ${pl.id}: 使用了全角或长破折号，应为半角 "-" → "${t}"`);
    }
    if (/\S-\S/.test(t) && !TRACK_RE.test(t)) {
      problems.push(`歌单 ${pl.id}: 连字符两侧缺少空格 → "${t}"`);
    }
    // 跨歌单重复（是允许的，仅提示）
    if (seenTracks.has(t)) {
      warnings.push(`曲目 "${t}" 同时出现在 ${seenTracks.get(t)} 与 ${pl.id}`);
    } else {
      seenTracks.set(t, pl.id);
    }
  }
}

// fallbackPool
const fb = data.fallbackPool?.tracks;
if (fb) {
  if (!Array.isArray(fb)) problems.push('fallbackPool.tracks 不是数组');
  else {
    for (const t of fb) {
      if (typeof t !== 'string' || !TRACK_RE.test(t)) {
        problems.push(`fallbackPool: 格式不合规 → "${t}"`);
      }
    }
    if (fb.length < 5) warnings.push(`fallbackPool 只有 ${fb.length} 首，建议 ≥ 5`);
  }
} else {
  warnings.push('缺少 fallbackPool（所有歌单都不匹配时的保底池，建议补上）');
}

// 悬空引用
const checkRefs = (obj, label) => {
  for (const [k, v] of Object.entries(obj || {})) {
    if (k.startsWith('$')) continue; // 以 $ 开头的是文档说明字段
    if (!ids.has(v)) problems.push(`${label}.${k} 指向不存在的歌单 → ${v}`);
  }
};
checkRefs(data.slotDefaults, 'slotDefaults');
checkRefs(data.moodDefaults, 'moodDefaults');

// 反向检查：有没有歌单从未被任何 slot/mood 引用（提示用）
const referenced = new Set([
  ...Object.entries(data.slotDefaults || {}).filter(([k]) => !k.startsWith('$')).map(([, v]) => v),
  ...Object.entries(data.moodDefaults || {}).filter(([k]) => !k.startsWith('$')).map(([, v]) => v),
]);
for (const pl of data.playlists || []) {
  if (!referenced.has(pl.id)) {
    warnings.push(`歌单 ${pl.id}（${pl.name}）未被任何 slotDefaults/moodDefaults 引用，只会在显式指定时使用`);
  }
}

// ─────────────── 输出 ───────────────
console.log('validate-playlists —— 曲目池校验\n');
console.log(`文件: ${target}`);
console.log(`歌单: ${(data.playlists || []).length} 个 · 曲目: ${trackTotal} 首 · 兜底池: ${(fb || []).length} 首\n`);

for (const w of warnings) console.log(`  [WARN] ${w}`);
if (warnings.length) console.log('');

if (problems.length === 0) {
  console.log('结果: 通过 —— 结构与格式全部合规。\n');
  process.exit(0);
}

for (const p of problems) console.log(`  [FAIL] ${p}`);
console.log(`\n结果: ${problems.length} 个问题需要修复。\n`);
process.exit(1);

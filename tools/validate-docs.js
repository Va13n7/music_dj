#!/usr/bin/env node
/**
 * validate-docs —— 文档体系一致性检查。
 *
 * 检查项：
 *   1. Markdown 结构：代码围栏配对、每文件仅 1 个 H1、表格列数一致
 *   2. 内部相对链接：目标文件存在；有 #锚点 时锚点存在
 *   3. 术语与取值一致性（跨文档的硬约束）：
 *      - 环境变量一律 CLAUDIAO_DSH_*（不得出现裸 DSH_BIN/DSH_PROFILE/DSH_CWD 作为本项目配置）
 *      - slot 标识符统一为下划线命名
 *      - 静默时段统一 23:00–07:00
 *      - 音乐并发必须为 1，且必须提及节流
 *      - plan 表名统一（不得出现 plan_slots）
 *   4. README 文档地图中的链接是否都指向真实文件
 *
 * 退出码: 0 全通过 / 1 有 FAIL
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = path.join(ROOT, 'docs');

let fails = 0;
let warns = 0;
const fail = (m) => { console.log(`  [FAIL] ${m}`); fails++; };
const warn = (m) => { console.log(`  [WARN] ${m}`); warns++; };
const ok = (m) => console.log(`  [ OK ] ${m}`);

const mdFiles = fs.readdirSync(DOCS).filter((f) => f.endsWith('.md')).sort();
const read = (p) => fs.readFileSync(p, 'utf8');

/**
 * 剥离 fenced code block（``` / ~~~）与行内 code，返回与原文行号对齐的数组。
 * 代码块里会有 `#` 注释、`[x](y)` 形态的伪码、`|` 分隔的表格样文本 ——
 * 这些都会污染结构检查，必须先排除。
 */
function maskCode(text) {
  const lines = text.split(/\r?\n/);
  const out = [];
  let inFence = false;
  let fenceMark = '';
  for (const l of lines) {
    const m = l.match(/^\s*(`{3,}|~{3,})/);
    if (m) {
      if (!inFence) { inFence = true; fenceMark = m[1][0]; }
      else if (m[1][0] === fenceMark) { inFence = false; fenceMark = ''; }
      out.push('');
      continue;
    }
    if (inFence) { out.push(''); continue; }
    // 行内 code 也屏蔽掉（`...`），避免其中的 # [ ] | 干扰判定
    out.push(l.replace(/`[^`]*`/g, (s) => ' '.repeat(s.length)));
  }
  return out;
}

console.log('validate-docs —— 文档体系一致性检查\n');
console.log(`docs/ 下共 ${mdFiles.length} 份文档\n`);

// ─────────────── 1. Markdown 结构 ───────────────
console.log('1) Markdown 结构');
for (const f of mdFiles) {
  const p = path.join(DOCS, f);
  const raw = read(p);
  const mask = maskCode(raw);

  // 围栏配对（用原文，因为 mask 会把围栏行抹掉）
  const fences = raw.split(/\r?\n/).filter((l) => /^\s*(`{3,}|~{3,})/.test(l)).length;
  if (fences % 2 !== 0) fail(`${f}: 代码围栏数为奇数（${fences}），有未闭合的围栏`);

  // H1 数量（只看代码块外）
  const h1 = mask.filter((l) => /^#\s+\S/.test(l)).length;
  if (h1 !== 1) fail(`${f}: 代码块外有 ${h1} 个 H1（应恰好 1 个）`);

  // 表格列数一致：以「分隔行」为锚点确定每张表的列数，再校验该表后续行。
  // 这样即使某行含被屏蔽的行内 code，也不会误判表格起点。
  const isRow = (l) => /^\s*\|.*\|\s*$/.test(l);
  const isSep = (l) => /^\s*\|[\s:|-]+\|\s*$/.test(l);
  const colsOf = (l) => l.replace(/\\\|/g, '\u0000').split('|').length - 2;

  mask.forEach((l, i) => {
    if (!isSep(l)) return;
    const headerIdx = i - 1;
    if (headerIdx < 0 || !isRow(mask[headerIdx])) return;
    const expected = colsOf(l);
    if (colsOf(mask[headerIdx]) !== expected) {
      warn(`${f}:${headerIdx + 1}: 表头列数 ${colsOf(mask[headerIdx])} 与分隔行 ${expected} 不一致`);
    }
    // 校验后续连续表格行
    for (let j = i + 1; j < mask.length; j++) {
      if (!isRow(mask[j])) break;
      const c = colsOf(mask[j]);
      if (c !== expected) {
        warn(`${f}:${j + 1}: 表格列数 ${c} 与本表 ${expected} 不一致 → ${mask[j].trim().slice(0, 60)}`);
      }
    }
  });
}
if (!fails) ok('所有文档围栏配对、各含 1 个 H1');

// ─────────────── 2. 内部相对链接 ───────────────
console.log('\n2) 内部相对链接与锚点');
let linkCount = 0;
let anchorChecked = 0;

/** 由标题文本生成 GitHub 风格锚点（近似实现，够用） */
function slug(text) {
  return text
    .trim()
    .toLowerCase()
    .replace(/[`*_[\]()]/g, '')
    .replace(/[^\w\u4e00-\u9fff\s-]/g, '')
    .replace(/\s+/g, '-');
}

for (const f of mdFiles) {
  const text = read(path.join(DOCS, f));
  // 只在代码块外找 markdown 链接，避免把伪码里的 [x](y) / $var/1MB 当成链接
  const masked = maskCode(text).join('\n');
  const re = /\[[^\]]*\]\(([^)\s]+)\)/g;
  let m;
  while ((m = re.exec(masked))) {
    const target = m[1];
    if (/^(https?:|mailto:|#)/.test(target)) continue;
    linkCount++;

    const [filePart, anchor] = target.split('#');
    // 跳过含正则元字符的伪链接（例如 \d{1,3}）
    if (/[\\{}*+?^$]/.test(filePart)) continue;
    const resolved = path.resolve(DOCS, filePart);
    if (!fs.existsSync(resolved)) {
      fail(`${f}: 链接目标不存在 → ${target}`);
      continue;
    }

    if (anchor && resolved.endsWith('.md')) {
      anchorChecked++;
      const targetText = read(resolved);
      const targetLines = targetText.split(/\r?\n/);
      // 收集该文件的锚点：显式 <a id="x"> 与标题 slug
      const explicit = new Set(
        [...targetText.matchAll(/<a\s+id="([^"]+)"/g)].map((x) => x[1]),
      );
      const fromHeadings = new Set(
        targetLines.filter((l) => /^#{1,6}\s+\S/.test(l)).map((l) => slug(l.replace(/^#{1,6}\s+/, ''))),
      );
      const decoded = decodeURIComponent(anchor);
      if (!explicit.has(decoded) && !fromHeadings.has(decoded)) {
        // 中文锚点常因编码/slug 规则差异误报，降级为 WARN
        warn(`${f}: 锚点可能不存在 → ${target}`);
      }
    }
  }
}
ok(`检查 ${linkCount} 个内部链接、${anchorChecked} 个锚点`);

// ─────────────── 3. 术语与取值一致性 ───────────────
console.log('\n3) 术语与取值一致性');

// 3a. 环境变量：裸 DSH_* 不得用作本项目配置
//     「~~旧名~~ → 新名」的对照表是有意保留的踩坑记录，不算违规
const bareEnv = [];
for (const f of mdFiles) {
  const lines = maskCode(read(path.join(DOCS, f))).join('\n').split('\n');
  lines.forEach((l, i) => {
    if (/不要|不得|错误|踩坑|冲突|注入|覆盖|无前缀|旧名|错名|~~|→/.test(l)) return;
    if (/`DSH_(BIN|PROFILE|CWD)`/.test(l)) bareEnv.push(`${f}:${i + 1}: ${l.trim().slice(0, 100)}`);
  });
}
if (bareEnv.length) {
  for (const b of bareEnv) warn(`裸 DSH_* 变量名（应为 CLAUDIAO_DSH_*）→ ${b}`);
} else {
  ok('环境变量全部使用 CLAUDIAO_DSH_* 前缀（旧名对照表除外）');
}

// 3b. slot 标识符：不得出现连字符变体
const slotBad = [];
for (const f of mdFiles) {
  if (f === '02-module-spec.md') continue; // 02 的别名/裁决表有意保留对照
  const lines = maskCode(read(path.join(DOCS, f))).join('\n').split('\n');
  lines.forEach((l, i) => {
    if (/别名|对照|旧名|曾用|重命名|早期|裁决/.test(l)) return;
    for (const bad of ['`hourly-check`', '`wind-down`', '`calendar-hook`', '`planning`']) {
      if (l.includes(bad)) slotBad.push(`${f}:${i + 1}: ${bad}`);
    }
  });
}
if (slotBad.length) {
  for (const b of slotBad) fail(`slot 标识符应为下划线命名 → ${b}`);
} else {
  ok('slot 标识符全部为下划线命名（daily_plan / hourly_check / night_wind_down / calendar_hook）');
}

// 3c. 静默时段必须为 23:00–07:00
//     允许出现在「对比/裁决」语境里同时提到旧值
const quietBad = [];
for (const f of mdFiles) {
  const lines = maskCode(read(path.join(DOCS, f))).join('\n').split('\n');
  lines.forEach((l, i) => {
    if (!/22:30\s*[–~-]\s*07:00/.test(l)) return;
    // 裁决表、踩坑说明、反面教材 —— 提到旧值是有意的
    if (/裁决|取 23:00|否则|会被|自相矛盾|早期|已修正|错|旧值|对比/.test(l)) return;
    quietBad.push(`${f}:${i + 1}: ${l.trim().slice(0, 110)}`);
  });
}
if (quietBad.length) {
  for (const b of quietBad) fail(`静默时段应为 23:00–07:00 → ${b}`);
} else {
  ok('静默时段统一为 23:00–07:00');
}

// 3d. 音乐并发与节流
const musicDoc = read(path.join(DOCS, '06-music-provider.md'));
if (!/MUSIC_RESOLVE_CONCURRENCY=1/.test(musicDoc)) fail('06: 未声明 MUSIC_RESOLVE_CONCURRENCY=1');
else if (!/MUSIC_MIN_INTERVAL_MS/.test(musicDoc)) fail('06: 缺少 MUSIC_MIN_INTERVAL_MS 节流约束');
else ok('06: 音乐串行 + 节流约束已声明');

// 3e. plan 表名
const planBad = [];
for (const f of mdFiles) {
  if (f === '03-api-contract.md') continue; // 03 记录了历史冲突并裁定
  if (/plan_slots/.test(read(path.join(DOCS, f)))) planBad.push(f);
}
if (planBad.length) fail(`出现 plan_slots（应为 plan）→ ${planBad.join(', ')}`);
else ok('plan 表名统一');

// 3f. 六个模块文件名必须一致
const MODULES = ['router.js', 'context.js', 'brain.js', 'tts.js', 'scheduler.js', 'state.js'];
const all = mdFiles.map((f) => read(path.join(DOCS, f))).join('\n');
const missing = MODULES.filter((m) => !all.includes(m));
if (missing.length) fail(`文档中缺少模块文件名: ${missing.join(', ')}`);
else ok(`六个第二层模块文件名一致: ${MODULES.join(', ')}`);

// ─────────────── 4. README 文档地图 ───────────────
console.log('\n4) README 文档地图');
const readme = read(path.join(ROOT, 'README.md'));
const mapLinks = [...readme.matchAll(/\]\(([^)\s]+\.md)\)/g)].map((m) => m[1]);
let mapBad = 0;
for (const l of mapLinks) {
  if (/^https?:/.test(l)) continue;
  if (!fs.existsSync(path.resolve(ROOT, l))) { fail(`README 指向不存在的文件 → ${l}`); mapBad++; }
}
if (!mapBad) ok(`README 的 ${mapLinks.length} 个文档链接全部有效`);

// README 地图是否覆盖全部 docs
const listed = new Set(mapLinks.map((l) => path.basename(l)));
const unlisted = mdFiles.filter((f) => !listed.has(f));
if (unlisted.length) warn(`docs/ 下有未在 README 地图中列出的文档: ${unlisted.join(', ')}`);
else ok('README 地图覆盖全部文档');

// ─────────────── 汇总 ───────────────
console.log(`\n${'─'.repeat(52)}`);
console.log(`结果: ${fails} 个 FAIL, ${warns} 个 WARN`);
if (fails === 0) {
  console.log('文档体系一致性检查通过。\n');
  process.exit(0);
}
console.log('存在硬性不一致，请修复后再交付。\n');
process.exit(1);

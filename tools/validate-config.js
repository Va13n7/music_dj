#!/usr/bin/env node
/**
 * validate-config —— yml / 语料交叉引用完整性检查（M0-T5）。
 *
 * 检查的是「文件之间说好的暗号」：
 *   1. config/*.yml 结构合法（经 src/lib/config.js 装载）
 *   2. playlists.json 的 moods ⊆ mood-rules.md 的档位 ID（硬失败）
 *   3. playlists.json 的 slots ⊆ 已知命名空间（routines.yml slot ∪ mood 档位 ∪ context 时段）；
 *      未知的给 WARN（context 时段目前无机器可读定义，避免误报）
 *   4. playlists.json：id 唯一、tracks 非空、曲目格式 "艺人 - 曲名"
 *   5. routines.yml：slot 名与 knowledge/user/routines.md 的档位表一致（WARN，知识文件为人写）
 *   6. radio.yml trackRefPattern 是合法正则且带 artist/title 命名组
 *
 * 退出码: 0 无 FAIL（WARN 不算失败）/ 1 有 FAIL。
 * 与 validate-playlists / validate-docs 分工：本工具只管「配置与语料的交叉引用」。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const FAIL = [];
const WARN = [];
const ok = (msg) => console.log(`  [ OK ] ${msg}`);
const fail = (msg) => { FAIL.push(msg); console.log(`  [FAIL] ${msg}`); };
const warn = (msg) => { WARN.push(msg); console.log(`  [WARN] ${msg}`); };

function readText(rel) {
  const p = path.join(ROOT, rel);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
}

console.log('validate-config —— 配置与语料交叉引用\n');

// ---------- 1. 结构装载 ----------
let cfg, loadConfig;
console.log('1) yml 结构装载（src/lib/config.js）');
try {
  ({ loadConfig } = await import('../src/lib/config.js'));
  cfg = loadConfig({ root: ROOT });
  ok('radio/routines/calendar.yml 装载成功且字段校验通过');
} catch (e) {
  fail(`配置装载失败: ${e.message.split('\n').join(' | ')}`);
  console.log(`\n结果: ${FAIL.length} FAIL / ${WARN.length} WARN —— 先修复上面的结构问题\n`);
  process.exit(1);
}

// ---------- 2. 解析 mood-rules.md 档位 ID ----------
console.log('\n2) mood 档位命名空间（knowledge/user/mood-rules.md）');
const moodRulesText = readText('knowledge/user/mood-rules.md');
let moodIds = [];
if (!moodRulesText) {
  warn('mood-rules.md 缺失，跳过 mood 交叉检查');
} else {
  // 情绪匹配表里的行首 `档位ID`
  const seg = moodRulesText.split('## 一、情绪匹配表')[1]?.split('###')[0] || '';
  moodIds = [...seg.matchAll(/^\| `([a-z_]+)` /gm)].map((m) => m[1]);
  if (moodIds.length) ok(`档位 ID ${moodIds.length} 个: ${moodIds.join(', ')}`);
  else warn('未能从 mood-rules.md 解析出档位 ID（表格式变了？）');
}

// ---------- 3. playlists.json 交叉引用 ----------
console.log('\n3) playlists.json 引用完整性');
const plRaw = readText('knowledge/user/playlists.json');
if (!plRaw) {
  fail('knowledge/user/playlists.json 缺失');
} else {
  let pl;
  try { pl = JSON.parse(plRaw); } catch (e) { fail(`playlists.json 不是合法 JSON: ${e.message}`); }
  if (pl) {
    const lists = pl.playlists || [];
    // 3a. id 唯一
    const ids = lists.map((l) => l.id);
    for (const dup of ids.filter((x, i) => ids.indexOf(x) !== i)) fail(`歌单 id 重复: "${dup}"`);
    if (!new Set(ids).size && !lists.length) warn('playlists.json 没有任何歌单');

    // 3b. moods ⊆ mood 档位（硬）
    if (moodIds.length) {
      let moodRefs = 0;
      for (const l of lists) {
        for (const m of l.moods || []) {
          moodRefs++;
          if (!moodIds.includes(m)) fail(`歌单 "${l.id}" 引用未知 mood 档位 "${m}"（mood-rules.md 中无此 ID）`);
        }
      }
      if (moodRefs) ok(`moods 引用 ${moodRefs} 处全部在档位表中`);
    }

    // 3c. slots ⊆ 已知命名空间（软）
    const knownSlots = new Set([
      ...cfg.routines.slots.map((s) => s.name),
      ...moodIds,
      // context 时段档位：知识文件中约定俗成、暂无机器可读定义
      'morning', 'commute', 'work_am', 'work_pm', 'afternoon_low', 'evening', 'night', 'any',
    ]);
    const slotRefs = new Set();
    for (const l of lists) for (const s of l.slots || []) slotRefs.add(s);
    const unknown = [...slotRefs].filter((s) => !knownSlots.has(s));
    if (unknown.length) warn(`playlists 引用未登记的 slot/时段: ${unknown.join(', ')}（若是新时段，请登记到 routines.md）`);
    else ok(`slots 引用 ${slotRefs.size} 个值全部可识别`);

    // 3d. tracks 非空 + 格式
    const trackRe = /^[^-]+\s-\s.+$/;
    for (const l of lists) {
      const tracks = l.tracks || [];
      if (!tracks.length) fail(`歌单 "${l.id}" tracks 为空`);
      for (const t of tracks) {
        const spec = typeof t === 'string' ? t : (t.spec || '');
        if (spec && !trackRe.test(spec)) fail(`歌单 "${l.id}" 曲目格式应为 "艺人 - 曲名": "${spec}"`);
      }
    }
    if (!FAIL.length) ok(`歌单 ${lists.length} 个、曲目格式与非空检查通过`);
  }
}

// ---------- 4. routines slot 名与知识文件一致 ----------
console.log('\n4) routines slot 名 ↔ knowledge/user/routines.md');
const routinesMd = readText('knowledge/user/routines.md');
if (!routinesMd) {
  warn('knowledge/user/routines.md 缺失，跳过');
} else {
  const ymlSlots = cfg.routines.slots.map((s) => s.name);
  const mdSlots = [...routinesMd.matchAll(/^\| `([a-z_]+)` \|/gm)].map((m) => m[1]);
  const onlyYml = ymlSlots.filter((s) => !mdSlots.includes(s));
  const onlyMd = mdSlots.filter((s) => !ymlSlots.includes(s));
  if (onlyYml.length) warn(`routines.yml 有而 routines.md 档位表没有的 slot: ${onlyYml.join(', ')}`);
  if (onlyMd.length) warn(`routines.md 档位表有而 routines.yml 未定义的 slot: ${onlyMd.join(', ')}`);
  if (!onlyYml.length && !onlyMd.length) ok(`slot 名两侧一致（${ymlSlots.length} 个）`);
}

// ---------- 5. radio.yml trackRefPattern ----------
console.log('\n5) radio.yml trackRefPattern');
const pattern = cfg.radio?.playback?.trackRefPattern ?? cfg.radio?.broadcast?.trackRefPattern;
if (!pattern) {
  warn('radio.yml 未定义 trackRefPattern（使用内置默认）');
} else {
  try {
    const re = new RegExp(pattern);
    if (!re.source.includes('artist') || !re.source.includes('title')) {
      warn('trackRefPattern 未包含 artist/title 命名组（resolve 依赖它拆分艺人/曲名）');
    } else {
      const m = '李志 - 下雨'.match(re);
      if (m?.groups?.artist === '李志' && m?.groups?.title === '下雨') ok('trackRefPattern 合法且能拆分 "艺人 - 曲名"');
      else fail(`trackRefPattern 无法正确拆分样例: ${JSON.stringify(m?.groups)}`);
    }
  } catch (e) {
    fail(`trackRefPattern 不是合法正则: ${e.message}`);
  }
}

// ---------- 汇总 ----------
console.log(`\n结果: ${FAIL.length} FAIL / ${WARN.length} WARN`);
if (FAIL.length) {
  console.log('\n修复上方 FAIL 项后重跑。WARN 不阻塞（多为登记建议）。');
  process.exit(1);
}
console.log('配置与语料交叉引用一致。');

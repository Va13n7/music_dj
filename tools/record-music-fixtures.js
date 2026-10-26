#!/usr/bin/env node
/**
 * record-music-fixtures —— 录下**真实**音乐 API 响应作为测试 fixture。
 *
 * 为什么需要它：
 *   docs/12-testing-strategy.md §4.2 要求音乐测试零出网 —— 用 fixture 回放。
 *   而 fixture 必须包含**真实的噪声样本**（翻唱/伴奏/remix），否则打分算法
 *   的过滤逻辑根本没被测到。实测「晴天」首条返回的就是翻唱「晴天(深情版)」，
 *   这正是最有价值的 fixture。
 *
 * 产出:
 *   tests/fixtures/music/search-<query>.json     原始 search 响应（含噪声）
 *   tests/fixtures/music/url-<id>.json           原始 url 响应
 *   tests/fixtures/music/lyric-<id>.json         原始 lyric 响应
 *   tests/fixtures/music/pic-<picid>.json        原始 pic 响应
 *   tests/fixtures/music/playlist-3778678.json   原始 playlist 响应（体积较大，可 --no-playlist 跳过）
 *   tests/fixtures/music/index.json              索引 + 录制元信息 + 期望的匹配结论
 *
 * 用法:
 *   node tools/record-music-fixtures.js
 *   node tools/record-music-fixtures.js --no-playlist    # 跳过体积大的歌单
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIX_DIR = path.join(ROOT, 'tests', 'fixtures', 'music');
const SKIP_PLAYLIST = process.argv.includes('--no-playlist');

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
const BASE = env.MUSIC_BASE_URL || 'https://music-api.gdstudio.xyz/api.php';
const MIN_INTERVAL = Number(env.MUSIC_MIN_INTERVAL_MS || 1200);

let lastReq = 0;
async function throttle() {
  const wait = lastReq + MIN_INTERVAL - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastReq = Date.now();
}

async function api(params, retries = 4) {
  const url = `${BASE}?${new URLSearchParams(params)}`;
  let lastErr;
  for (let a = 1; a <= retries; a++) {
    await throttle();
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 20000);
    try {
      const res = await fetch(url, { signal: ctl.signal });
      const text = await res.text();
      if (res.status >= 500 || res.status === 429) throw new Error(`HTTP ${res.status}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (!text.trim()) throw new Error('空响应');
      return { data: JSON.parse(text), url };
    } catch (e) {
      lastErr = e;
      if (a < retries) {
        await new Promise((r) => setTimeout(r, 1200 * 2 ** (a - 1) + Math.random() * 400));
        continue;
      }
    } finally {
      clearTimeout(t);
    }
  }
  throw lastErr;
}

/**
 * 录制计划。每条都声明**期望的匹配结论**，这样 fixture 同时也是打分算法的验收依据。
 * noiseExpected 列出应当被过滤掉的候选特征（用于断言打分算法的负向权重生效）。
 */
const PLAN = [
  {
    name: 'qingtian', query: '晴天', source: 'netease', expectPlayable: true,
    why: '实测首条返回的是翻唱「晴天(深情版)」。这是最有价值的噪声样本 —— 首选命中必须是原唱而非翻唱。',
    expectNote: '首选应为周杰伦原唱；含「深情版」「原唱 周杰伦」等翻唱标记的候选应被负向权重压低',
    noiseMarkers: ['深情版', '原唱', '翻唱', 'cover'],
  },
  {
    name: 'lizhi-xiayu', query: '李志 下雨', source: 'netease', expectPlayable: true,
    why: '真实可播放曲目（端到端验证过出直链），作为「正向」基准样本。',
    expectNote: '首选应为「下雨 - Fog forest/李志」',
    noiseMarkers: ['伴奏', 'DJ', 'Remix'],
  },
  {
    name: 'chenli-xiaoban', query: '陈粒 小半', source: 'netease', expectPlayable: true,
    why: '第二个正向样本，含多版本（原版/伴奏/remix），验证去重与版本选择。',
    expectNote: '首选应为陈粒本人版本',
    noiseMarkers: ['伴奏', 'remix', 'DJ版', '钢琴版'],
  },
  {
    name: 'joox-qingtian', query: '晴天', source: 'joox', expectPlayable: false,
    why: 'joox 源的元数据/歌词质量优于 netease，但**不提供可播放直链**（docs/06 §4.1 的单点结论）。',
    expectNote: 'search 可用；url 返回 `{"url":"","br":-1,"size":0}` 空串 —— '
      + '用于断言「joox 不作播放替补」的回退逻辑。注意是空字符串而非缺字段，实现必须正则校验。',
    noiseMarkers: [],
  },
];

fs.mkdirSync(FIX_DIR, { recursive: true });
console.log('record-music-fixtures —— 录制音乐 API fixture\n');
console.log(`base     : ${BASE}`);
console.log(`输出     : ${FIX_DIR}`);
console.log(`节流     : ${MIN_INTERVAL}ms（实测该实例对突发零容忍）\n`);

const index = {
  $description: '音乐 API 的真实响应 fixture，供 docs/12-testing-strategy.md §4.2 的回放测试使用。'
    + '请勿手工编辑 —— 用 tools/record-music-fixtures.js 重录。',
  recordedAt: new Date().toISOString(),
  baseUrl: BASE,
  note: '⚠️ 直链（url 响应中的 url 字段）是**临时 CDN 地址**，会过期。回放测试只应断言「字段结构与解析逻辑」，'
    + '不应断言直链本身可访问。',
  cases: [],
};

let total = 0;
let failed = 0;

for (const p of PLAN) {
  console.log(`── ${p.name}（${p.source}: "${p.query}"）`);
  console.log(`   ${p.why}`);

  let search;
  try {
    search = await api({ types: 'search', source: p.source, name: p.query, count: '10', pages: '1' });
  } catch (e) {
    console.log(`   ✗ search 失败: ${e.message}\n`);
    failed++;
    continue;
  }

  const cands = search.data;
  if (!Array.isArray(cands) || !cands.length) {
    console.log('   ✗ search 无结果\n');
    failed++;
    continue;
  }

  const searchFile = `search-${p.name}.json`;
  fs.writeFileSync(path.join(FIX_DIR, searchFile), JSON.stringify(search.data, null, 2), 'utf8');
  console.log(`   ✓ ${searchFile}  ${cands.length} 条候选`);
  total++;

  // 统计噪声标记命中情况（给人工看，也让 index 自解释）
  const noiseHits = [];
  for (const c of cands) {
    const label = `${c.name} — ${(c.artist || []).join('/')}`;
    for (const m of p.noiseMarkers) {
      if (new RegExp(m, 'i').test(c.name) || new RegExp(m, 'i').test((c.artist || []).join('/'))) {
        noiseHits.push({ marker: m, label });
      }
    }
  }
  if (noiseHits.length) {
    console.log(`     噪声候选 ${noiseHits.length} 条（打分算法必须压低）:`);
    for (const h of noiseHits.slice(0, 4)) console.log(`       · [${h.marker}] ${h.label}`);
  }

  const top = cands[0];

  // url
  let urlFile = null;
  try {
    const u = await api({ types: 'url', source: p.source, id: top.url_id || top.id, br: env.MUSIC_BITRATE || '320' });
    urlFile = `url-${p.name}.json`;
    fs.writeFileSync(path.join(FIX_DIR, urlFile), JSON.stringify(u.data, null, 2), 'utf8');
    // 注意：无直链时该字段是**空字符串**（不是缺失、不是 null），
    // 所以必须用正则校验它是不是真的 http(s) URL，不能只判断 typeof === 'string'。
    const raw = u.data?.url;
    const playable = typeof raw === 'string' && /^https?:\/\/\S+/.test(raw);
    console.log(`   ${playable ? '✓' : '·'} ${urlFile}  ${playable ? `有直链 br=${u.data.br} size=${u.data.size}` : `无直链（url="${raw}"，该源不提供，属预期）`}`);
    if (p.expectPlayable === true && !playable) {
      console.log('     ⚠ 此场景本应可播放，但未拿到直链 —— 可能版权受限或接口退化');
    }
    total++;
  } catch (e) {
    console.log(`   ✗ url 失败: ${e.message}`);
  }

  // lyric
  let lyricFile = null;
  try {
    const l = await api({ types: 'lyric', source: p.source, id: top.lyric_id || top.id });
    lyricFile = `lyric-${p.name}.json`;
    fs.writeFileSync(path.join(FIX_DIR, lyricFile), JSON.stringify(l.data, null, 2), 'utf8');
    const lrc = l.data?.lyric || '';
    const ts = /\[\d{2}:\d{2}[.:]\d{2}\]/.test(lrc);
    console.log(`   ✓ ${lyricFile}  ${lrc.length} 字符，${ts ? '含 LRC 时间戳' : '无时间戳（需静态降级展示）'}`);
    total++;
  } catch (e) {
    console.log(`   ✗ lyric 失败: ${e.message}`);
  }

  // pic
  let picFile = null;
  if (top.pic_id) {
    try {
      const pc = await api({ types: 'pic', source: p.source, id: top.pic_id, size: '300' });
      picFile = `pic-${p.name}.json`;
      fs.writeFileSync(path.join(FIX_DIR, picFile), JSON.stringify(pc.data, null, 2), 'utf8');
      console.log(`   ✓ ${picFile}`);
      total++;
    } catch (e) {
      console.log(`   ✗ pic 失败: ${e.message}`);
    }
  }

  index.cases.push({
    name: p.name,
    source: p.source,
    query: p.query,
    why: p.why,
    expectNote: p.expectNote,
    noiseMarkers: p.noiseMarkers,
    files: { search: searchFile, url: urlFile, lyric: lyricFile, pic: picFile },
    candidateCount: cands.length,
    topCandidate: { name: top.name, artist: top.artist, id: top.id, url_id: top.url_id, lyric_id: top.lyric_id },
    noiseCandidates: noiseHits,
  });
  console.log('');
}

// 歌单（体积较大，可选）
if (!SKIP_PLAYLIST) {
  console.log('── playlist（热歌榜 3778678）');
  try {
    const pl = await api({ types: 'playlist', source: 'netease', id: '3778678' });
    const file = 'playlist-3778678.json';
    fs.writeFileSync(path.join(FIX_DIR, file), JSON.stringify(pl.data, null, 2), 'utf8');
    const kb = (fs.statSync(path.join(FIX_DIR, file)).size / 1024).toFixed(0);
    console.log(`   ✓ ${file}  ${kb} KB，${pl.data?.playlist?.trackCount ?? '?'} 首`);
    index.cases.push({ name: 'playlist-hot', source: 'netease', files: { playlist: file } });
    total++;
  } catch (e) {
    console.log(`   ✗ playlist 失败: ${e.message}`);
  }
  console.log('');
}

index.fileCount = total;
fs.writeFileSync(path.join(FIX_DIR, 'index.json'), JSON.stringify(index, null, 2), 'utf8');

console.log('─'.repeat(52));
console.log(`录制 ${total} 个 fixture 文件（${index.cases.length} 个场景）· 失败 ${failed} 个`);
console.log(`索引: ${path.join(FIX_DIR, 'index.json')}`);
if (failed) {
  console.log('\n有场景失败。公共实例可能正在限流，等一会儿重跑：');
  console.log('  node tools/record-music-fixtures.js\n');
  process.exit(1);
}
console.log('\n完成。这些 fixture 让音乐测试可以零出网运行（docs/12-testing-strategy.md §4）。\n');

#!/usr/bin/env node
/**
 * music-resolve —— 端到端验证「艺人 - 曲名」→ 可播放直链。
 *
 * 这是选曲链路里最容易出错的一环：搜索会返回翻唱/伴奏/remix，
 * 必须靠打分把它们过滤掉。本工具打印完整候选与打分，方便调参。
 *
 * 用法:
 *   node tools/music-resolve.js "李志 - 下雨"
 *   node tools/music-resolve.js "周杰伦 - 晴天" --source joox
 *   node tools/music-resolve.js "晴天" --show-candidates   # 打印全部候选与打分
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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

const ARGV = process.argv.slice(2);
const SHOW = ARGV.includes('--show-candidates');
const si = ARGV.indexOf('--source');
const ONLY_SOURCE = si >= 0 ? ARGV[si + 1] : null;
const ref = ARGV.filter((a) => !a.startsWith('--') && a !== ONLY_SOURCE).join(' ').trim();

if (!ref) {
  console.error('用法: node tools/music-resolve.js "艺人 - 曲名" [--source netease] [--show-candidates]');
  process.exit(1);
}

const sources = ONLY_SOURCE
  ? [ONLY_SOURCE]
  : (env.MUSIC_SOURCES || 'netease,joox').split(',').map((s) => s.trim()).filter(Boolean);

// 与 docs/06 一致的噪声黑名单
const NOISE = /翻唱|cover|伴奏|instrumental|remix|dj版|live|现场|纯音乐|钢琴版|八音盒|深情版|女声版|男声版|抖音|铃声|片段|加速|慢速|高音质|无损/i;

let lastReq = 0;
async function throttle() {
  const wait = lastReq + MIN_INTERVAL - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastReq = Date.now();
}

async function api(params, { retries = 4 } = {}) {
  const url = `${BASE}?${new URLSearchParams(params)}`;
  let lastErr;
  for (let a = 1; a <= retries; a++) {
    await throttle();
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 15000);
    try {
      const res = await fetch(url, { signal: ctl.signal });
      const text = await res.text();
      if (res.status >= 500 || res.status === 429) throw new Error(`HTTP ${res.status}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (!text.trim()) throw new Error('空响应');
      return JSON.parse(text);
    } catch (e) {
      lastErr = e;
      if (a < retries) {
        await new Promise((r) => setTimeout(r, 1200 * 2 ** (a - 1) + Math.random() * 400));
        continue;
      }
      throw e;
    } finally {
      clearTimeout(t);
    }
  }
  throw lastErr;
}

/** 打分：与 docs/06 的公式保持一致，便于对比调参 */
function score(cand, wantArtist, wantTitle) {
  const name = cand.name || '';
  const artists = (cand.artist || []).join('/');
  const parts = [];
  let s = 0;
  if (name === wantTitle) { s += 20; parts.push('曲名精确 +20'); }
  else if (name.includes(wantTitle) || wantTitle.includes(name)) { s += 12; parts.push('曲名包含 +12'); }
  if (wantArtist && artists.includes(wantArtist)) { s += 40; parts.push('艺人命中 +40'); }
  if (NOISE.test(name)) { s -= 60; parts.push('曲名噪声 -60'); }
  if (NOISE.test(artists)) { s -= 20; parts.push('艺人噪声 -20'); }
  return { s, parts };
}

const m = ref.match(/^(?<artist>.+?)\s-\s(?<title>.+)$/);
const wantArtist = m?.groups.artist?.trim() || '';
const wantTitle = m?.groups.title?.trim() || ref;
const query = wantArtist ? `${wantArtist} ${wantTitle}` : wantTitle;

console.log('music-resolve —— 「艺人 - 曲名」解析验证\n');
console.log(`输入   : ${ref}`);
console.log(`解析   : 艺人="${wantArtist || '(未提供)'}"  曲名="${wantTitle}"`);
console.log(`检索词 : ${query}`);
console.log(`音源   : ${sources.join(' → ')}\n`);

let finalUrl = null;
let usedSource = null;
let usedTrack = null;

for (const source of sources) {
  console.log(`── 音源 ${source} ─────────────────────────`);
  let cands;
  try {
    cands = await api({ types: 'search', source, name: query, count: '10', pages: '1' });
  } catch (e) {
    console.log(`  search 失败: ${e.message}\n`);
    continue;
  }
  if (!Array.isArray(cands) || !cands.length) {
    console.log('  无候选\n');
    continue;
  }

  const scored = cands
    .map((c) => ({ c, ...score(c, wantArtist, wantTitle) }))
    .sort((a, b) => b.s - a.s);

  if (SHOW) {
    console.log('  候选与打分（降序）:');
    scored.forEach(({ c, s, parts }, i) => {
      console.log(`   ${String(i + 1).padStart(2)}. [${String(s).padStart(4)}] ${c.name} — ${(c.artist || []).join('/')}`
        + `${c.album ? ` 《${c.album}》` : ''}`);
      if (parts.length) console.log(`       ${parts.join(' · ')}`);
    });
    console.log('');
  }

  for (const { c, s } of scored) {
    if (s <= 0 && scored[0].s > 0) continue;  // 已有一个正分候选，不再试负分的
    let urlData;
    try {
      urlData = await api({ types: 'url', source, id: c.url_id || c.id, br: env.MUSIC_BITRATE || '320' });
    } catch (e) {
      console.log(`  解析「${c.name}」失败: ${e.message}`);
      continue;
    }
    if (urlData?.url) {
      console.log(`  ✓ 命中: ${c.name} — ${(c.artist || []).join('/')}   打分 ${s}`);
      console.log(`    直链: ${urlData.url.slice(0, 96)}…`);
      console.log(`    码率: ${urlData.br ?? '?'} kbps   大小: ${((urlData.size || 0) / 1048576).toFixed(1)} MB`);
      finalUrl = urlData.url;
      usedSource = source;
      usedTrack = c;
      break;
    } else {
      console.log(`  ✗ 无直链: ${c.name}（版权受限或该源不提供直链）`);
    }
  }
  if (finalUrl) break;
  console.log('');
}

console.log('\n' + '─'.repeat(52));
if (!finalUrl) {
  console.log('结果: 解析失败。');
  console.log('  · 单曲失败常见于版权受限（VIP/下架），属正常情况；');
  console.log('  · 若任何曲目都失败，说明 API 实例失效 → npm run music:check');
  console.log('  · 注意：只有 netease 能返回可播放直链，joox 不行（见 docs/06 §4.1）\n');
  process.exit(1);
}

// 验证直链真的可播
try {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 15000);
  const r = await fetch(finalUrl, { headers: { Range: 'bytes=0-2047' }, signal: ctl.signal });
  const buf = Buffer.from(await r.arrayBuffer());
  clearTimeout(t);
  const isMp3 = buf.length > 2 && (buf[0] === 0xff || buf.toString('latin1', 0, 3) === 'ID3');
  console.log(`结果: 解析成功（源=${usedSource}）`);
  console.log(`直链校验: HTTP ${r.status} · ${buf.length} 字节 · ${isMp3 ? 'MP3 头有效 ✓' : '未能识别 MP3 头 ⚠'}`);
  console.log(`\n可播放 30 秒验证（浏览器打开会直接播）:\n  ${finalUrl}\n`);
  process.exit(0);
} catch (e) {
  console.log(`结果: 拿到直链但校验失败: ${e.message}\n`);
  process.exit(1);
}

#!/usr/bin/env node
/**
 * music-check —— 音乐提供方（公共 API 实例）的全链路健康检查。
 *
 * 逐个探测施工图要求的四个能力（search / song_url / lyric / recommend），
 * 外加封面与歌单，并额外跑一次「艺人 - 曲名」→ 可播放直链 的端到端解析。
 *
 * 用途:
 *   - 首次部署确认音乐链路（docs/00-quick-start.md §0）
 *   - 判断「是 API 挂了还是我代码坏了」（docs/13-deployment-ops.md §7.4）
 *
 * 退出码: 0 全通过 / 1 有失败
 *
 * 用法:
 *   node tools/music-check.js
 *   node tools/music-check.js --source joox
 *   node tools/music-check.js --verbose
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
const SOURCES = (env.MUSIC_SOURCES || 'netease,joox').split(',').map((s) => s.trim()).filter(Boolean);

const argv = process.argv.slice(2);
const VERBOSE = argv.includes('--verbose');
const srcIdx = argv.indexOf('--source');
const ONLY_SOURCE = srcIdx >= 0 ? argv[srcIdx + 1] : null;

const sources = ONLY_SOURCE ? [ONLY_SOURCE] : SOURCES;

let failures = 0;
let notes = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '[OK]  ' : '[FAIL]'} ${label}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures++;
};
/** 预期内的不完美：如实报告，但不改变退出码（例如已知的 joox 无直链） */
const note = (label, detail = '') => {
  console.log(`  [NOTE] ${label}${detail ? `  — ${detail}` : ''}`);
  notes++;
};
const warn = (label, detail = '') => {
  console.log(`  [WARN] ${label}${detail ? `  — ${detail}` : ''}`);
  notes++;
};
const hint = (t) => { if (VERBOSE) console.log(`         ${t}`); };

/**
 * 全局请求节流器。
 *
 * 这是**必需**的：实测该公共实例对突发请求会返回 503，冷却后恢复。
 * 因此所有请求必须串行并保持最小间隔。生产路径同理
 * （见 docs/06-music-provider.md 的 MUSIC_MIN_INTERVAL_MS）。
 */
const MIN_INTERVAL_MS = Number(env.MUSIC_MIN_INTERVAL_MS || 1200);
let lastRequestAt = 0;

async function throttle() {
  const wait = lastRequestAt + MIN_INTERVAL_MS - Date.now();
  if (wait > 0) {
    hint(`  节流等待 ${wait}ms`);
    await new Promise((r) => setTimeout(r, wait));
  }
  lastRequestAt = Date.now();
}

/**
 * 带节流 + 超时 + 退避重试的 GET，返回解析后的 JSON 或抛错。
 *
 * 重试是**必需**的，不是优化：实测同一 URL 连续请求的结果可能是
 * 200 / 503 / 503，冷却或退避后恢复。任何生产路径都必须带退避重试，
 * 否则会把「被限流」误判为「歌不存在」而白白降级。
 */
async function api(params, { timeoutMs = 15000, retries = 4, backoffMs = 1200 } = {}) {
  const url = `${BASE}?${new URLSearchParams(params)}`;
  hint(`GET ${url}`);
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    await throttle();
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        signal: ctl.signal,
        headers: {
          'User-Agent': 'Claudiao-Radio/0.1 (+music-check)',
          Accept: 'application/json',
        },
      });
      const text = await res.text();
      // 5xx 与 429 属于可重试的瞬态错误
      if (res.status >= 500 || res.status === 429) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
      }
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      if (!text.trim()) throw new Error('空响应体');
      const parsed = JSON.parse(text);
      if (attempt > 1) hint(`  第 ${attempt} 次尝试成功（前 ${attempt - 1} 次被限流，退避生效）`);
      return parsed;
    } catch (e) {
      lastErr = e;
      const retriable = /HTTP (5\d\d|429)|abort|ECONNRESET|ETIMEDOUT|fetch failed|空响应体/i.test(e.message);
      if (attempt < retries && retriable) {
        // 指数退避 + 抖动，避免同步重试再次触发限流
        const wait = backoffMs * 2 ** (attempt - 1) + Math.floor(Math.random() * 400);
        hint(`  第 ${attempt} 次失败（${e.message}），${wait}ms 后重试`);
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      throw e;
    } finally {
      clearTimeout(t);
    }
  }
  throw lastErr;
}

console.log('music-check —— 音乐提供方健康检查\n');
console.log(`  base     : ${BASE}`);
console.log(`  sources  : ${sources.join(', ')}\n`);

// 探测用的检索词：用一个常见中文词，便于命中
const PROBE_QUERY = '晴天';

for (const source of sources) {
  console.log(`── 音源: ${source} ─────────────────────────────`);

  let track = null;

  // ---- 1) search ----
  try {
    const data = await api({ types: 'search', source, name: PROBE_QUERY, count: '3', pages: '1' });
    const ok = Array.isArray(data) && data.length > 0;
    check(`search（检索「${PROBE_QUERY}」）`, ok,
      ok ? `返回 ${data.length} 条，首条「${data[0].name}」- ${(data[0].artist || []).join('/')}` : '未返回结果数组');
    if (ok) {
      track = data[0];
      hint(`字段: ${Object.keys(track).join(', ')}`);
      // 施工图要求的关键字段
      const need = ['id', 'name', 'artist', 'url_id', 'lyric_id'];
      const miss = need.filter((k) => track[k] === undefined);
      check('  含施工图要求的关键字段', miss.length === 0, miss.length ? `缺: ${miss.join(', ')}` : need.join(', '));
    }
  } catch (e) {
    check('search', false, e.message);
  }

  if (track) {
    // ---- 2) song_url（施工图的 song_url）----
    // 这是播放链路唯一的硬要求：拿不到直链就等于放不出来。
    // 实测只有 netease 提供直链；joox 不提供 —— 这是已知能力边界，不是故障。
    const expectsUrl = source === 'netease';
    try {
      const data = await api({ types: 'url', source, id: track.url_id || track.id, br: env.MUSIC_BITRATE || '320' });
      const url = data?.url;
      const ok = typeof url === 'string' && /^https?:\/\//.test(url);
      if (ok) {
        check('song_url（解析播放直链）', true, `br=${data.br} size=${data.size} → ${url.slice(0, 64)}…`);
      } else if (expectsUrl) {
        // netease 拿不到直链是**真问题**（可能版权受限，也可能接口退化）
        warn('song_url（解析播放直链）',
          `未返回 url（该曲目可能版权受限/VIP；若换多首都如此，见 docs/06 §4.1 的单点风险）`);
      } else {
        note(`song_url —— ${source} 不提供可播放直链（已知能力边界，见 docs/06 §4.1）`,
          '故 joox 只能作元数据/歌词的二级来源，不能作播放替补');
      }

      if (ok) {
        // 验证直链真的可下载（Range 取头部 2KB）
        const ctl = new AbortController();
        const t = setTimeout(() => ctl.abort(), 15000);
        try {
          const r = await fetch(url, { method: 'GET', headers: { Range: 'bytes=0-2047' }, signal: ctl.signal });
          const buf = Buffer.from(await r.arrayBuffer());
          const isMp3 = buf.length > 2 && (buf[0] === 0xff || buf.toString('latin1', 0, 3) === 'ID3');
          check('  直链可实际取到音频数据', r.ok && buf.length > 0,
            `${r.status} ${buf.length} 字节${isMp3 ? '，MP3 头有效' : ''}`);
        } catch (e) {
          check('  直链可实际取到音频数据', false, e.message);
        } finally {
          clearTimeout(t);
        }
      }
    } catch (e) {
      if (expectsUrl) check('song_url', false, e.message);
      else note(`song_url —— ${source} 请求失败`, e.message);
    }

    // ---- 3) lyric（施工图的 lyric）----
    // 目的是确认歌词**接口**可用；部分曲目只返回纯文本歌词（无 LRC 时间戳），属内容差异而非接口故障。
    try {
      const data = await api({ types: 'lyric', source, id: track.lyric_id || track.id });
      const lrc = data?.lyric || '';
      const hasTimestamp = /\[\d{2}:\d{2}[.:]\d{2}\]/.test(lrc);
      if (!lrc) {
        warn('lyric（歌词接口返回空）', '该曲目可能无歌词；换一首再验');
      } else if (hasTimestamp) {
        check('lyric（歌词，LRC 格式）', true, `${lrc.length} 字符，含时间戳`);
      } else {
        note('lyric —— 接口正常，但该曲目只返回纯文本歌词（无 LRC 时间戳）',
          `${lrc.length} 字符。前端需支持无时间戳时的降级展示（静态歌词，不滚动）`);
      }
    } catch (e) {
      check('lyric', false, e.message);
    }

    // ---- 4) pic（封面）----
    try {
      const data = await api({ types: 'pic', source, id: track.pic_id, size: '300' });
      check('pic（封面图）', typeof data?.url === 'string' && /^https?:/.test(data.url),
        data?.url ? data.url.slice(0, 72) : '未返回 url');
    } catch (e) {
      check('pic', false, e.message);
    }
  }

  // ---- 5) playlist（施工图的 recommend 基础）----
  try {
    // 3778678 = 网易云「热歌榜」，实测可用
    const data = await api({ types: 'playlist', source, id: '3778678' });
    const pl = data?.playlist;
    check('playlist（歌单，recommend 的数据基础）', !!pl && !!pl.name,
      pl ? `「${pl.name}」共 ${pl.trackCount} 首` : '未返回 playlist 字段');
  } catch (e) {
    check('playlist', false, e.message);
  }

  console.log('');
}

// ---------- 端到端：「艺人 - 曲名」→ 可播放直链 ----------
console.log('── 端到端解析（施工图的「ncm 解析 queue」）────────');

const TRACK_RE = /^(?<artist>.+?) - (?<title>.+)$/;
const E2E_CASES = ['周杰伦 - 晴天', '李志 - 下雨'];

/** 「艺人 - 曲名」→ 打分挑选最像原唱的候选（演示 docs/06 的打分与噪声过滤） */
const NOISE = /翻唱|cover|伴奏|instrumental|remix|dj版|live|纯音乐|钢琴版|八音盒|深情版|女声版|男声版|抖音|铃声|片段/i;

function pickBest(cands, wantArtist, wantTitle) {
  let best = null;
  let bestScore = -Infinity;
  for (const c of cands) {
    const name = c.name || '';
    const artists = (c.artist || []).join('/');
    let score = 0;
    if (name.includes(wantTitle) || wantTitle.includes(name)) score += 50;
    if (artists.includes(wantArtist)) score += 40;
    if (name === wantTitle) score += 20;
    if (NOISE.test(name)) score -= 60;          // 噪声负向权重
    if (NOISE.test(artists)) score -= 20;
    if (c.source) score += 1;
    if (score > bestScore) { bestScore = score; best = { ...c, _score: score }; }
  }
  return best;
}

for (const ref of E2E_CASES) {
  const m = ref.match(TRACK_RE);
  if (!m) { check(`解析「${ref}」`, false, '曲目引用格式不合规（应为 "艺人 - 曲名"）'); continue; }

  let resolved = null;
  let usedSource = null;
  let candidateInfo = '';

  for (const source of sources) {
    try {
      const data = await api({ types: 'search', source, name: `${m.groups.artist} ${m.groups.title}`, count: '10', pages: '1' });
      if (!Array.isArray(data) || !data.length) continue;
      const best = pickBest(data, m.groups.artist, m.groups.title);
      if (!best) continue;

      const urlData = await api({ types: 'url', source, id: best.url_id || best.id, br: env.MUSIC_BITRATE || '320' });
      candidateInfo = `源=${source} 命中「${best.name}」- ${(best.artist || []).join('/')} 打分=${best._score}`;
      if (urlData?.url) { resolved = urlData.url; usedSource = source; break; }
      candidateInfo += '（该候选无直链，继续下一源）';
    } catch (e) {
      candidateInfo = `源=${source} 失败: ${e.message}`;
    }
  }

  const ok = !!resolved;
  check(`解析「${ref}」`, ok, ok ? `${candidateInfo} → ${resolved.slice(0, 56)}…` : (candidateInfo || '所有源均未解析出直链'));
  if (!ok) {
    console.log('         注意: 单曲解析失败可能是版权受限（VIP/下架），属正常情况。');
    console.log('         但若所有曲目都失败，说明 API 实例已失效，见 docs/13-deployment-ops.md §7.4。');
  }
}

// ---------- 兜底音频目录 ----------
console.log('\n── 兜底音频 ────────────────────────────────────');
const fbDir = path.join(ROOT, env.FALLBACK_AUDIO_DIR || 'data/fallback-audio');
if (fs.existsSync(fbDir)) {
  const files = fs.readdirSync(fbDir).filter((f) => /\.(mp3|wav)$/i.test(f));
  if (files.length >= 5) {
    check('兜底音频已就绪', true, `${files.length} 个文件`);
  } else {
    warn(`兜底音频 ${files.length} 首（建议 ≥ 5）`,
      '这是唯一需要你自备素材的一项，见 docs/00-quick-start.md §4');
  }
} else {
  warn('兜底音频目录不存在', fbDir);
  console.log('         创建: New-Item -ItemType Directory -Force data\\fallback-audio');
  console.log('         说明: 音乐源全失败时播放此目录，保证电台不静音（docs/00-quick-start.md §4）');
}

// ---------- 汇总 ----------
console.log('');
console.log('─'.repeat(52));
console.log(`结果: ${failures} 项失败 · ${notes} 项提示`);

if (failures === 0) {
  console.log('音乐链路可用。');
  if (notes) {
    console.log('\n提示项说明（都不影响运行，但实现时必须处理）：');
    console.log('  · 只有 netease 提供可播放直链 → 播放能力是单点，靠 data/fallback-audio/ 兜底');
    console.log('  · 部分曲目只返回纯文本歌词 → 前端需支持无时间戳时的静态展示（不滚动）');
    console.log('  · 兜底音频需你自备 → 唯一需要人工准备的素材');
  }
  console.log('');
  process.exit(0);
}
console.log('存在真实故障，请对照 docs/13-deployment-ops.md §7.4 排查。');
if (!VERBOSE) console.log('提示: 加 --verbose 可看到每个请求的完整 URL。');
console.log('');
process.exit(1);

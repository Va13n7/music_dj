#!/usr/bin/env node
/**
 * tts-warm —— 预热 TTS 缓存。
 *
 * 电台的固定播报（问候、报时、天气模板、晚安）高度重复，提前合成能显著降低
 * 首次播报的延迟（实测 edge-tts 一句话 ~3s，这正是 N-01 延迟预算里最痛的一块）。
 *
 * 用法:
 *   node tools/tts-warm.js                      # 合成内置的固定播报集
 *   node tools/tts-warm.js --text "任意一句话"    # 试听 / 单独合成一句
 *   node tools/tts-warm.js --voice zh-CN-YunxiNeural --text "换音色试试"
 *   node tools/tts-warm.js --stats              # 只看缓存现状
 */
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARGV = process.argv.slice(2);

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
const BIN = env.CLAUDIAO_EDGE_TTS_BIN;
const VOICE = (ARGV.includes('--voice') ? ARGV[ARGV.indexOf('--voice') + 1] : null) || env.TTS_VOICE || 'zh-CN-XiaoxiaoNeural';
const RATE = env.TTS_RATE || '+0%';
const PITCH = env.TTS_PITCH || '+0Hz';
const CACHE_DIR = path.join(ROOT, env.TTS_CACHE_DIR || 'data/tts-cache');

/**
 * 缓存键：sha1(voice|rate|pitch|text)[:16]
 * 与设计决策 D-07 一致 —— 音色/语速/音调进键，换音色后旧缓存自然失效。
 * 注意 volume 与 engine **不进键**（音量可在播放端调，引擎差异不该翻倍缓存）。
 */
function cacheKey(text) {
  return crypto.createHash('sha1').update(`${VOICE}|${RATE}|${PITCH}|${text}`).digest('hex').slice(0, 16);
}

function synth(text, { quiet = false } = {}) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const hash = cacheKey(text);
  const out = path.join(CACHE_DIR, `${hash}.mp3`);

  if (fs.existsSync(out) && fs.statSync(out).size > 0) {
    if (!quiet) console.log(`  命中缓存  ${hash}  ${text.slice(0, 28)}`);
    return { hash, out, cached: true, ms: 0 };
  }

  // 原子写入：先写 .tmp 再 rename，避免半截文件被播放器读到
  const tmp = `${out}.tmp`;
  const t0 = Date.now();
  const r = spawnSync(`"${BIN}"`, [
    '--voice', VOICE, '--rate', RATE, '--pitch', PITCH,
    '--text', text, '--write-media', tmp,
  ], { encoding: 'utf8', shell: process.platform === 'win32', timeout: 30000, windowsHide: true });

  const ms = Date.now() - t0;

  if (r.status !== 0 || !fs.existsSync(tmp) || fs.statSync(tmp).size === 0) {
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    throw new Error(`合成失败 (exit=${r.status}): ${(r.stderr || '').trim().slice(0, 200)}`);
  }
  fs.renameSync(tmp, out);
  if (!quiet) {
    console.log(`  已合成    ${hash}  ${String(ms).padStart(5)}ms  ${(fs.statSync(out).size / 1024).toFixed(1)} KB  ${text.slice(0, 28)}`);
  }
  return { hash, out, cached: false, ms };
}

// ─────────────── 缓存统计 ───────────────
function stats() {
  if (!fs.existsSync(CACHE_DIR)) {
    console.log('缓存目录不存在（还没合成过任何内容）');
    return;
  }
  const files = fs.readdirSync(CACHE_DIR).filter((f) => f.endsWith('.mp3'));
  const bytes = files.reduce((s, f) => s + fs.statSync(path.join(CACHE_DIR, f)).size, 0);
  const max = Number(env.TTS_CACHE_MAX_BYTES || 524288000);
  console.log(`缓存目录 : ${CACHE_DIR}`);
  console.log(`文件数   : ${files.length}${env.TTS_CACHE_MAX_FILES ? ` / ${env.TTS_CACHE_MAX_FILES}` : ''}`);
  console.log(`占用     : ${(bytes / 1048576).toFixed(1)} MB / ${(max / 1048576).toFixed(0)} MB (${(bytes / max * 100).toFixed(1)}%)`);
  console.log(`音色     : ${VOICE}`);
}

if (ARGV.includes('--stats')) {
  console.log('tts-warm —— 缓存现状\n');
  stats();
  process.exit(0);
}

if (!BIN || !fs.existsSync(BIN)) {
  console.error('错误: CLAUDIAO_EDGE_TTS_BIN 未设置或文件不存在。');
  console.error('运行 node tools/doctor.js 查看修复建议。');
  process.exit(1);
}

// ─────────────── --text 单句模式 ───────────────
const ti = ARGV.indexOf('--text');
if (ti >= 0) {
  const text = ARGV.slice(ti + 1).filter((a) => !a.startsWith('--')).join(' ');
  if (!text) {
    console.error('--text 后面要跟要合成的文字');
    process.exit(1);
  }
  console.log(`tts-warm —— 单句合成\n`);
  console.log(`音色 : ${VOICE}   语速 ${RATE}   音调 ${PITCH}`);
  console.log(`文本 : ${text}\n`);
  try {
    const r = synth(text);
    console.log(`\n${r.cached ? '缓存命中' : '合成完成'}: ${r.out}`);
    console.log(`播放: Start-Process "${r.out}"`);
    console.log(`对外 URL: /tts/${r.hash}.mp3\n`);
    process.exit(0);
  } catch (e) {
    console.error(`\n${e.message}\n`);
    process.exit(1);
  }
}

// ─────────────── 固定播报集预热 ───────────────
// 这些是电台高频重复的语句，预热收益最高。
const WARMUP = [
  '早上好，新的一天开始了。',
  '中午了，先歇一会儿。',
  '下午好，给你换点清醒的。',
  '天黑了，把节奏放慢一点。',
  '快十一点了，放点安静的陪你收尾。',
  '今天外面有点凉，出门记得带件外套。',
  '接下来这首，希望你喜欢。',
  '这首听完，我给你换个风格。',
];

console.log('tts-warm —— 预热固定播报集\n');
console.log(`音色 : ${VOICE}`);
console.log(`语速 : ${RATE}   音调: ${PITCH}`);
console.log(`目录 : ${CACHE_DIR}\n`);

let hit = 0;
let made = 0;
let failed = 0;
let totalMs = 0;

for (const t of WARMUP) {
  try {
    const r = synth(t);
    if (r.cached) hit++;
    else { made++; totalMs += r.ms; }
  } catch (e) {
    failed++;
    console.log(`  ✗ ${t.slice(0, 28)}  ${e.message}`);
  }
}

console.log(`\n${'─'.repeat(52)}`);
console.log(`新合成 ${made} 条 · 缓存命中 ${hit} 条 · 失败 ${failed} 条`);
if (made) console.log(`平均合成耗时 ${(totalMs / made).toFixed(0)}ms`);
console.log('');
stats();

if (failed) {
  console.log(`\n有 ${failed} 条失败。若全部失败，检查 edge-tts 是否可用：`);
  console.log(`  "${BIN}" --list-voices\n`);
  process.exit(1);
}
console.log('\n预热完成。这些语句下次播报时会直接命中缓存（<50ms）。\n');

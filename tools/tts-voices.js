#!/usr/bin/env node
/**
 * tts-voices —— 列出 edge-tts 可用音色（重点是中文），并标注电台推荐。
 *
 * 用途：改 config/.env 的 TTS_VOICE 之前先看看有哪些可选。
 *
 * 用法:
 *   node tools/tts-voices.js            # 只列中文音色
 *   node tools/tts-voices.js --all      # 列出全部
 *   node tools/tts-voices.js --try      # 每个中文音色合成一句试听样例（较慢）
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARGV = process.argv.slice(2);
const ALL = ARGV.includes('--all');
const TRY = ARGV.includes('--try');

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
const bin = env.CLAUDIAO_EDGE_TTS_BIN;
const current = env.TTS_VOICE;

if (!bin || !fs.existsSync(bin)) {
  console.error('错误: CLAUDIAO_EDGE_TTS_BIN 未设置或文件不存在。');
  console.error('安装: python -m pip install edge-tts');
  console.error('然后 where edge-tts 取路径填进 config/.env');
  process.exit(1);
}

const r = spawnSync(`"${bin}"`, ['--list-voices'], {
  encoding: 'utf8', shell: process.platform === 'win32', timeout: 30000, windowsHide: true,
});
if (r.status !== 0) {
  console.error('edge-tts --list-voices 失败（可能需要联网）:');
  console.error((r.stderr || '').trim().slice(0, 500));
  process.exit(1);
}

// 解析: Name  Gender  Categories  (后面可能还有 Personality)
const rows = [];
for (const line of r.stdout.split(/\r?\n/)) {
  const m = line.match(/^(\S+Neural|\S+Desktop)\s+(Female|Male)\s+(.*)$/);
  if (m) rows.push({ name: m[1], gender: m[2], rest: m[3].trim() });
}

const zh = rows.filter((x) => /^zh-/.test(x.name));
const list = ALL ? rows : zh;

// 电台推荐（贴合 dj-persona 的语气：克制、有温度、不像新闻播报）
const RECOMMEND = {
  'zh-CN-XiaoxiaoNeural': '★ 电台默认。温暖、耐听，最适合长时间陪伴',
  'zh-CN-YunxiNeural': '☆ 男声首选。阳光活泼，适合早间/通勤档',
  'zh-CN-XiaoyiNeural': '☆ 女声备选。更活泼，适合午后提神档',
  'zh-CN-YunjianNeural': '男声，偏激昂，适合运动/庆祝档',
  'zh-CN-YunyangNeural': '男声，专业新闻腔。若想要"播报感"选它',
  'zh-CN-YunxiaNeural': '男声，可爱风，与深夜档语气不符',
  'zh-CN-liaoning-XiaobeiNeural': '东北方言，有性格但会抢戏',
  'zh-CN-shaanxi-XiaoniNeural': '陕西方言，同上',
};

console.log(`tts-voices —— edge-tts 可用音色${ALL ? '（全部）' : '（仅中文）'}\n`);
console.log(`edge-tts : ${bin}`);
console.log(`当前音色 : ${current || '(未设置)'}\n`);

if (!list.length) {
  console.log('未解析到音色（输出格式可能变了）。原始输出前 20 行：');
  console.log(r.stdout.split(/\r?\n/).slice(0, 20).join('\n'));
  process.exit(1);
}

console.log(`${'音色名'.padEnd(34)} ${'性别'.padEnd(7)} 风格 / 备注`);
console.log('─'.repeat(96));
for (const v of list) {
  const rec = RECOMMEND[v.name] || v.rest;
  const mark = v.name === current ? ' ← 当前' : '';
  console.log(`${v.name.padEnd(34)} ${v.gender.padEnd(7)} ${rec}${mark}`);
}

console.log(`\n共 ${list.length} 个音色${ALL ? '' : `（中文；加 --all 看全部 ${rows.length} 个）`}`);

if (TRY) {
  const outDir = path.join(ROOT, 'data', 'tts-cache', '_voices');
  fs.mkdirSync(outDir, { recursive: true });
  const sample = '晚上好，这里是电台。外面下着小雨，给你放首安静的。';
  console.log(`\n── 试听合成（样例句：${sample}）`);
  for (const v of zh) {
    const out = path.join(outDir, `${v.name}.mp3`);
    const t0 = Date.now();
    const s = spawnSync(`"${bin}"`,
      ['--voice', v.name, '--text', sample, '--write-media', out],
      { encoding: 'utf8', shell: process.platform === 'win32', timeout: 30000, windowsHide: true });
    const ok = s.status === 0 && fs.existsSync(out);
    const kb = ok ? (fs.statSync(out).size / 1024).toFixed(1) : '0';
    console.log(`  ${ok ? '✓' : '✗'} ${v.name.padEnd(34)} ${String(Date.now() - t0).padStart(5)}ms  ${kb} KB`);
  }
  console.log(`\n试听文件已写入: ${outDir}`);
  console.log('用播放器打开即可对比。选定后填入 config/.env 的 TTS_VOICE。');
}

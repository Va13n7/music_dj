#!/usr/bin/env node
/**
 * taste-import —— 导入个人网易云歌单（品味画像的数据源）。
 *
 * 数据源：gdstudio 公共实例（歌单是公开的，不需要登录账号——
 * 官方开放平台的 favorite/created 接口在账户解封后可作为升级路径）。
 *
 * 用法:
 *   node tools/taste-import.js <歌单ID> [<歌单ID>...]     # 导入歌单
 *   node tools/taste-import.js --list                     # 查看已导入的歌单
 *
 * 歌单 ID 从哪来：网页版网易云音乐打开你的歌单，地址栏
 *   music.163.com/#/playlist?id=123456  →  歌单 ID = 123456
 *
 * 产出: knowledge/user/taste-imports/<歌单ID>.json（供 taste:analyze 分析）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'knowledge', 'user', 'taste-imports');

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
const ARGV = process.argv.slice(2);

if (ARGV.includes('--list')) {
  if (!fs.existsSync(OUT_DIR)) { console.log('还没有导入过歌单。'); process.exit(0); }
  for (const f of fs.readdirSync(OUT_DIR).filter((x) => x.endsWith('.json'))) {
    const j = JSON.parse(fs.readFileSync(path.join(OUT_DIR, f), 'utf8'));
    console.log(`· ${j.id}  ${j.name}  ${j.trackCount} 首  导入于 ${j.importedAt}`);
  }
  process.exit(0);
}

const ids = ARGV.filter((a) => /^\d+$/.test(a));
if (!ids.length) {
  console.error('用法: node tools/taste-import.js <歌单ID> [<歌单ID>...]');
  console.error('歌单 ID 见网页版歌单地址栏的 id= 参数');
  process.exit(1);
}

const { GdstudioProvider } = await import('../src/providers/music/gdstudio.js');
const g = new GdstudioProvider({ env, log: console });

fs.mkdirSync(OUT_DIR, { recursive: true });

for (const id of ids) {
  process.stdout.write(`导入歌单 ${id} …`);
  try {
    const pl = await g.playlist(id, { maxPages: 8 });
    if (!pl.tracks.length) { console.log(' 空（ID 不存在或无公开曲目）'); continue; }
    const record = {
      id: pl.id,
      name: pl.name,
      importedAt: new Date().toISOString(),
      trackCount: pl.tracks.length,
      tracks: pl.tracks.map((t) => ({
        title: t.name,
        artist: t.artist.join('/'),
        album: t.album,
        durationMs: t.durationMs,
        pop: t.pop,                                       // 网易云热度 0-100
        fee: t.fee,                                       // 0 免费 / 1 VIP / 4 专辑 / 8 低价
      })),
    };
    const file = path.join(OUT_DIR, `${id}.json`);
    fs.writeFileSync(file, JSON.stringify(record, null, 2));
    // 聚合概览
    const artistCount = {};
    for (const t of record.tracks) for (const a of t.artist.split('/')) if (a) artistCount[a] = (artistCount[a] || 0) + 1;
    const top = Object.entries(artistCount).sort((a, b) => b[1] - a[1]).slice(0, 8)
      .map(([a, n]) => `${a}(${n})`).join(' ');
    console.log(` ${pl.name} · ${pl.tracks.length} 首`);
    console.log(`   高频艺人: ${top || '无重复'}`);
  } catch (e) {
    console.log(` 失败: ${e.message}`);
  }
}
console.log(`\n导入完成 → ${OUT_DIR}`);
console.log('下一步: npm run taste:analyze 让大脑生成你的品味画像');

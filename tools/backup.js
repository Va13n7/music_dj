#!/usr/bin/env node
/**
 * backup —— 备份电台的「灵魂」与「记忆」。
 *
 * 备份内容（见 docs/13-deployment-ops.md §5）：
 *   knowledge/                    语料 —— 丢了等于电台失忆（最重要）
 *   config/*.yml + .env           配置与密钥
 *   data/radio.db                 SQLite（用 VACUUM INTO 做一致性快照）
 *   ~/.dsh/profiles/dj-brain/     大脑 profile（可重建，但备份更省事）
 *
 * 不备份：node_modules/（用 package.json 重装）、data/tts-cache/（可再生）。
 *
 * 用法:
 *   node tools/backup.js                    # 备份到 data/backups/
 *   node tools/backup.js --out D:\Backup    # 指定输出目录
 *   node tools/backup.js --no-db            # 跳过数据库
 *
 * 说明：本项目刻意不引入 archiver 等依赖，改用 PowerShell 的 Compress-Archive
 * （Windows 自带），保持依赖表最小。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARGV = process.argv.slice(2);
const SKIP_DB = ARGV.includes('--no-db');
const outIdx = ARGV.indexOf('--out');
const OUT_DIR = outIdx >= 0 ? path.resolve(ARGV[outIdx + 1]) : path.join(ROOT, 'data', 'backups');

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const stage = path.join(os.tmpdir(), `claudiao-backup-${stamp}`);
const zipPath = path.join(OUT_DIR, `claudiao-${stamp}.zip`);

console.log('backup —— 备份语料 / 配置 / 状态 / 大脑 profile\n');
console.log(`项目根 : ${ROOT}`);
console.log(`暂存区 : ${stage}`);
console.log(`输出   : ${zipPath}\n`);

// ─────────────── 1. 复制文件到暂存区 ───────────────
fs.mkdirSync(stage, { recursive: true });
fs.mkdirSync(OUT_DIR, { recursive: true });

/** 递归复制目录（跳过不存在的），返回 {files, bytes} */
function copyDir(src, destRel, { filter } = {}) {
  const dest = path.join(stage, destRel);
  if (!fs.existsSync(src)) return { files: 0, bytes: 0, skipped: true };
  let files = 0;
  let bytes = 0;
  const walk = (s, d) => {
    fs.mkdirSync(d, { recursive: true });
    for (const e of fs.readdirSync(s, { withFileTypes: true })) {
      const sp = path.join(s, e.name);
      const dp = path.join(d, e.name);
      if (filter && !filter(sp, e)) continue;
      if (e.isDirectory()) walk(sp, dp);
      else if (e.isFile()) {
        fs.copyFileSync(sp, dp);
        files++;
        bytes += fs.statSync(sp).size;
      }
    }
  };
  walk(src, dest);
  return { files, bytes };
}

const parts = [];

// 语料（最重要）
const corpus = copyDir(path.join(ROOT, 'knowledge'), 'knowledge');
parts.push(['knowledge/', corpus]);

// 配置
const cfg = copyDir(path.join(ROOT, 'config'), 'config', {
  // 排除 .env.example 之外的临时文件；.env 要备份（含令牌）
  filter: (p) => !/\.(tmp|log)$/i.test(p),
});
parts.push(['config/', cfg]);

// 大脑：当前为 ZCode Agent（账号态在 ~/.zcode/v2/，由桌面端管理，只读引用不备份）；
// 旧版 dsh profile 若还在（回滚用）则一并备份。
const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const profileDir = path.join(dshHome, 'profiles', process.env.CLAUDIAO_DSH_PROFILE || 'dj-brain');
if (fs.existsSync(profileDir)) {
  const prof = copyDir(profileDir, path.join('dsh-profile', path.basename(profileDir)));
  parts.push([`dsh-profile/${path.basename(profileDir)}/`, prof]);
} else {
  parts.push(['dsh-profile/', { note: '旧版 dsh profile 不存在（大脑已切换为 ZCode Agent），跳过' }]);
}

// ─────────────── 2. 数据库一致性快照 ───────────────
let dbNote = '跳过（--no-db）';
const dbPath = path.join(ROOT, process.env.DB_PATH || 'data/radio.db');
if (!SKIP_DB) {
  if (!fs.existsSync(dbPath)) {
    dbNote = '数据库不存在（尚未初始化，属正常）';
  } else {
    // 直接复制运行中的 .db 会拿到不一致的快照；VACUUM INTO 是 SQLite 官方的一致性导出
    const snapshot = path.join(stage, 'data', 'radio.db');
    fs.mkdirSync(path.dirname(snapshot), { recursive: true });
    const sql = `VACUUM INTO '${snapshot.replace(/'/g, "''").replace(/\\/g, '/')}';`;
    let done = false;
    try {
      const { default: Database } = await import('better-sqlite3');
      const db = new Database(dbPath, { readonly: true });
      db.exec(sql);
      db.close();
      done = true;
    } catch (e) {
      dbNote = `better-sqlite3 不可用（${e.message.split('\n')[0]}），回退到文件复制`;
    }
    if (!done) {
      fs.copyFileSync(dbPath, snapshot);
      // 连带 WAL / SHM，避免复制后无法打开
      for (const ext of ['-wal', '-shm']) {
        if (fs.existsSync(dbPath + ext)) fs.copyFileSync(dbPath + ext, snapshot + ext);
      }
      dbNote = '已用文件复制（可能不一致，建议先停服务再备份）';
    } else {
      dbNote = `VACUUM INTO 一致性快照（${(fs.statSync(snapshot).size / 1024).toFixed(0)} KB）`;
    }
  }
}

// ─────────────── 3. 写清单并压缩 ───────────────
const manifest = {
  tool: 'claudiao backup',
  createdAt: new Date().toISOString(),
  projectRoot: ROOT,
  host: os.hostname(),
  node: process.version,
  contents: Object.fromEntries(parts.map(([name, s]) => [name, {
    files: s.files ?? 0, bytes: s.bytes ?? 0, missing: !!s.skipped,
  }])),
  database: dbNote,
  note: '恢复方法见 docs/13-deployment-ops.md §5：解压到项目根，然后重跑 scripts/setup-brain-profile.ps1 -Verify',
};
fs.writeFileSync(path.join(stage, 'BACKUP-MANIFEST.json'), JSON.stringify(manifest, null, 2), 'utf8');

console.log('已暂存：');
let totalFiles = 0;
let totalBytes = 0;
for (const [name, s] of parts) {
  totalFiles += s.files ?? 0;
  totalBytes += s.bytes ?? 0;
  console.log(`  ${s.skipped ? '—' : '✓'} ${name.padEnd(34)} ${String(s.files ?? 0).padStart(4)} 个文件  ${((s.bytes ?? 0) / 1024).toFixed(1)} KB`);
}
console.log(`  数据库                              ${dbNote}`);
console.log(`\n合计 ${totalFiles} 个文件，${(totalBytes / 1048576).toFixed(2)} MB\n`);

if (totalFiles === 0) {
  console.error('没有可备份的内容，终止。');
  fs.rmSync(stage, { recursive: true, force: true });
  process.exit(1);
}

console.log('压缩中…');
const zip = spawnSync('powershell', [
  '-NoProfile', '-Command',
  `Compress-Archive -Path '${stage}\\*' -DestinationPath '${zipPath}' -Force`,
], { encoding: 'utf8', timeout: 120000, windowsHide: true });

fs.rmSync(stage, { recursive: true, force: true });

if (zip.status !== 0 || !fs.existsSync(zipPath)) {
  console.error('压缩失败：');
  console.error((zip.stderr || zip.stdout || '').trim().slice(0, 800));
  process.exit(1);
}

const zkb = fs.statSync(zipPath).size / 1024;
console.log(`\n${'─'.repeat(52)}`);
console.log(`备份完成: ${zipPath}`);
console.log(`压缩后   : ${zkb.toFixed(1)} KB（${totalFiles} 个文件）`);
console.log(`\n恢复: 解压到项目根，然后`);
console.log(`  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\\setup-brain-profile.ps1 -Verify\n`);

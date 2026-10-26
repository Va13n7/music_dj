#!/usr/bin/env node
/**
 * db-migrate —— 初始化 / 迁移电台的状态库（SQLite）。
 *
 * 幂等：重复运行安全。所有 DDL 用 CREATE TABLE IF NOT EXISTS（M0-T3 验收：
 * 连跑两次不报错、PRAGMA integrity_check = ok、重复迁移不改数据）。
 *
 * DDL 的唯一代码落点是 src/layer2/state.js（与 docs/03-api-contract.md §6 对齐），
 * 本工具只调用它 —— 不出现第二份 DDL。
 *
 * 用法:
 *   node tools/db-migrate.js            # 建表（幂等）+ 报告现状
 *   node tools/db-migrate.js --check    # 只检查数据库现状，不建表
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARGV = process.argv.slice(2);
const CHECK_ONLY = ARGV.includes('--check');

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
const dbRel = env.DB_PATH || 'data/radio.db';
const dbPath = path.join(ROOT, dbRel);

console.log('db-migrate —— 状态库迁移\n');
console.log(`数据库 : ${dbPath}`);
if (CHECK_ONLY) console.log('模式   : 只检查（--check），不建表\n');

const dataDir = path.dirname(dbPath);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
  console.log(`已创建目录: ${dataDir}`);
}

// ---------- 打开 + 迁移 ----------
let StateStore, migrate, integrityCheck, EXPECTED_TABLES;
try {
  ({ StateStore, migrate, integrityCheck, EXPECTED_TABLES } = await import('../src/layer2/state.js'));
} catch (e) {
  console.error(`无法加载 src/layer2/state.js: ${e.message.split('\n')[0]}`);
  console.error('先运行: npm install');
  process.exit(1);
}

let store;
try {
  if (CHECK_ONLY && !fs.existsSync(dbPath)) {
    console.log('状态   : 不存在（--check 模式不创建）');
    console.log('\n去掉 --check 直接运行即可建表（幂等）。');
    process.exit(0);
  }
  const existed = fs.existsSync(dbPath);
  store = new StateStore(dbPath);
  if (!CHECK_ONLY) {
    const r = migrate(store.db);
    console.log(`状态   : ${existed ? '已存在' : '新建'}（本次新建 ${r.created} 张表）`);
  }
} catch (e) {
  console.error(`\n迁移失败: ${e.message}`);
  process.exit(1);
}

// ---------- 报告现状 ----------
const db = store.db;
const tables = db.prepare(
  "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
).all().map((r) => r.name);

const kb = fs.existsSync(dbPath) ? (fs.statSync(dbPath).size / 1024).toFixed(1) : '0';
console.log(`\n表（${tables.length} 张）:`);
if (!tables.length) {
  console.log('  （空库）');
} else {
  for (const t of tables) {
    const n = db.prepare(`SELECT COUNT(*) AS c FROM "${t}"`).get().c;
    const mark = EXPECTED_TABLES.includes(t) ? '✓' : '?';
    console.log(`  ${mark} ${t.padEnd(16)} ${String(n).padStart(6)} 行`);
  }
}

const missing = EXPECTED_TABLES.filter((t) => !tables.includes(t));
if (missing.length) {
  console.log(`\n缺少契约要求的表: ${missing.join(', ')}`);
  store.close();
  process.exit(1);
}

const ic = integrityCheck(db);
console.log(`\nintegrity_check: ${ic}`);
console.log('四张契约表齐备，迁移幂等。');
store.close();
console.log('');

/**
 * M0-T3 验收单测 —— src/layer2/state.js + db-migrate
 *
 * 验收标准（docs/10 M0-T3）：
 *   - npm run db:migrate 幂等（连跑两次不报错）
 *   - PRAGMA integrity_check = ok
 *   - 重复迁移不改数据
 * 附加：prefs JSON 读写、24h 去重窗口、契约四表齐备。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, migrate, integrityCheck, StateStore } from '../../src/layer2/state.js';

function tmpDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudiao-db-'));
  return path.join(dir, 'radio.db');
}

test('迁移幂等：连跑两次不报错，四表齐备', () => {
  const db = openDb(tmpDb());
  const r1 = migrate(db);
  const r2 = migrate(db);
  assert.deepEqual(r1.tables.sort(), ['messages', 'plan', 'plays', 'prefs']);
  assert.equal(r1.created, 4);
  assert.equal(r2.created, 0, '第二次迁移不应新建任何表');
  assert.equal(integrityCheck(db), 'ok');
  db.close();
});

test('重复迁移不改数据', () => {
  const db = openDb(tmpDb());
  migrate(db);
  db.prepare(
    "INSERT INTO prefs (key, value, updated_at) VALUES ('brain.sessionId', '\"sess_x\"', 123)",
  ).run();
  migrate(db); // 再次迁移
  const row = db.prepare("SELECT value, updated_at FROM prefs WHERE key='brain.sessionId'").get();
  assert.equal(row.value, '"sess_x"');
  assert.equal(row.updated_at, 123);
  db.close();
});

test('prefs JSON 读写 / 删除 / 前缀批量', () => {
  const store = new StateStore(tmpDb());
  store.setPref('brain.sessionId', 'sess_abc');
  store.setPref('brain.usage.total', 1024, '累计 token');
  assert.equal(store.getPref('brain.sessionId'), 'sess_abc');
  assert.equal(store.getPref('brain.usage.total'), 1024);
  assert.equal(store.getPref('nope', 'fallback'), 'fallback');

  store.setPref('tts.voice.bySlot', { morning: 'v1' });
  const all = store.allPrefs('tts.');
  assert.deepEqual(all['tts.voice.bySlot'], { morning: 'v1' });

  store.delPref('brain.sessionId');
  assert.equal(store.getPref('brain.sessionId'), undefined);
  store.close();
});

test('recentPlayedTrackIds：24h 窗口正确', () => {
  const store = new StateStore(tmpDb());
  const now = Date.now();
  const ins = store.db.prepare(
    "INSERT INTO plays (at_ms, date, track_id, source, title, artist, spec) VALUES (?, ?, ?, 'netease', 't', 'a', 'a - t')",
  );
  ins.run(now - 1 * 3600 * 1000, '2026-10-15', 'song_a');
  ins.run(now - 2 * 3600 * 1000, '2026-10-15', 'song_b');
  ins.run(now - 30 * 3600 * 1000, '2026-10-13', 'song_old'); // 窗口外
  const ids = store.recentPlayedTrackIds(24, now);
  assert.ok(ids.has('song_a'));
  assert.ok(ids.has('song_b'));
  assert.ok(!ids.has('song_old'));
  assert.equal(store.integrityCheck(), 'ok');
  store.close();
});

test('真实仓库 db-migrate 全流程（幂等 + integrity ok）', () => {
  // 直接对真实库跑两遍迁移逻辑（不经 spawn，避免跨进程耗时）
  const realPath = path.resolve(import.meta.dirname, '..', '..', 'data', 'radio.db');
  const store = new StateStore(realPath);
  migrate(store.db); // 第二遍
  assert.equal(store.integrityCheck(), 'ok');
  const tables = store.db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
  ).all().map((r) => r.name);
  for (const t of ['messages', 'plays', 'plan', 'prefs']) assert.ok(tables.includes(t));
  store.close();
});

/**
 * Claudiao · 状态库（src/layer2/state.js，M0-T3 骨架）
 *
 * 权威 DDL：docs/03-api-contract.md §6（messages / plays / plan / prefs 四表）。
 * 本文件是 DDL 的**唯一代码落点**，tools/db-migrate.js 引用它建表——
 * 避免实现与契约出现两套真相。
 *
 * M0 范围：openDb / migrate / prefs 读写 / recentPlays 窗口查询。
 * M4-T3 再扩展 messages/plays/plan 的完整读写与 24h 去重、跳过权重。
 */
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

/** 与 docs/03 §6 逐字对齐的 DDL（全部幂等：IF NOT EXISTS） */
export const DDL = `
CREATE TABLE IF NOT EXISTS messages (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  at_ms        INTEGER NOT NULL,
  date         TEXT    NOT NULL,
  role         TEXT    NOT NULL
               CHECK (role IN ('user','dj','system')),
  text         TEXT    NOT NULL,
  intent       TEXT,
  lane         TEXT,
  session_id   TEXT,
  broadcast_id TEXT,
  degraded     INTEGER NOT NULL DEFAULT 0,
  meta_json    TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_at        ON messages(at_ms DESC);
CREATE INDEX IF NOT EXISTS idx_messages_date_role ON messages(date, role, at_ms DESC);
CREATE INDEX IF NOT EXISTS idx_messages_broadcast ON messages(broadcast_id);

CREATE TABLE IF NOT EXISTS plays (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  at_ms        INTEGER NOT NULL,
  date         TEXT    NOT NULL,
  track_id     TEXT    NOT NULL,
  source       TEXT    NOT NULL,
  title        TEXT    NOT NULL,
  artist       TEXT    NOT NULL,
  album        TEXT,
  spec         TEXT    NOT NULL,
  audio_url    TEXT,
  cover_url    TEXT,
  lyric_url    TEXT,
  duration_ms  INTEGER,
  played_ms    INTEGER NOT NULL DEFAULT 0,
  completed    INTEGER NOT NULL DEFAULT 0,
  skipped      INTEGER NOT NULL DEFAULT 0,
  feedback     INTEGER,
  broadcast_id TEXT,
  intent       TEXT,
  reason       TEXT,
  degraded     INTEGER NOT NULL DEFAULT 0,
  CHECK (feedback IS NULL OR feedback IN (-1,0,1))
);
CREATE INDEX  IF NOT EXISTS idx_plays_at    ON plays(at_ms DESC);
CREATE INDEX  IF NOT EXISTS idx_plays_track ON plays(track_id, at_ms DESC);
CREATE INDEX  IF NOT EXISTS idx_plays_date  ON plays(date, at_ms DESC);
CREATE INDEX  IF NOT EXISTS idx_plays_title ON plays(title, artist);
CREATE UNIQUE INDEX IF NOT EXISTS uq_plays_broadcast_track
  ON plays(broadcast_id, track_id) WHERE broadcast_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS plan (
  date          TEXT    NOT NULL,
  slot          TEXT    NOT NULL,
  status        TEXT    NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','claimed','running','succeeded','failed','skipped')),
  scheduled_at  INTEGER NOT NULL,
  claimed_at    INTEGER,
  started_at    INTEGER,
  finished_at   INTEGER,
  owner         TEXT,
  attempt       INTEGER NOT NULL DEFAULT 0,
  trigger       TEXT,
  intent        TEXT,
  say           TEXT,
  play_json     TEXT,
  reason        TEXT,
  segue         TEXT,
  broadcast_id  TEXT,
  context_hash  TEXT,
  degrade_json  TEXT,
  error_code    TEXT,
  skip_reason   TEXT,
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY (date, slot)
);
CREATE INDEX IF NOT EXISTS idx_plan_status ON plan(status, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_plan_date   ON plan(date, scheduled_at);

CREATE TABLE IF NOT EXISTS prefs (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  note       TEXT
);
CREATE INDEX IF NOT EXISTS idx_prefs_updated ON prefs(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_prefs_prefix  ON prefs(key);
`;

export const EXPECTED_TABLES = ['messages', 'plays', 'plan', 'prefs'];

/** 打开数据库（目录不存在则创建），并施加连接级 PRAGMA */
export function openDb(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  return db;
}

/**
 * 幂等迁移：重复执行不报错、不改已有数据。
 * @returns {{tables: string[], created: number}} 现有表名与本次新建数
 */
export function migrate(db) {
  const before = new Set(
    db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map((r) => r.name),
  );
  db.exec(DDL);
  const after = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map((r) => r.name);
  const created = after.filter((t) => !before.has(t)).length;
  return { tables: after.sort(), created };
}

export function integrityCheck(db) {
  return db.pragma('integrity_check')[0]?.integrity_check;
}

/**
 * 状态库门面。M0 提供迁移 + prefs 原语 + recentPlays；
 * M4-T3 在此类上扩展 messages/plays/plan 的完整读写。
 */
export class StateStore {
  constructor(dbPath, { logger } = {}) {
    this.dbPath = dbPath;
    this.log = logger?.child?.('state') ?? logger ?? console;
    this.db = openDb(dbPath);
    const { created } = migrate(this.db);
    if (created > 0) this.log.info?.(`状态库已建表 +${created}`, { dbPath });
  }

  close() { this.db.close(); }

  // ---------- prefs（值列 JSON 编码，docs/03 §6.4）----------

  getPref(key, def = undefined) {
    const row = this.db.prepare('SELECT value FROM prefs WHERE key = ?').get(key);
    if (!row) return def;
    try { return JSON.parse(row.value); } catch { return row.value; }
  }

  setPref(key, value, note = null) {
    this.db.prepare(
      `INSERT INTO prefs (key, value, updated_at, note) VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at,
         note = COALESCE(excluded.note, prefs.note)`,
    ).run(key, JSON.stringify(value), Date.now(), note);
  }

  delPref(key) {
    this.db.prepare('DELETE FROM prefs WHERE key = ?').run(key);
  }

  allPrefs(prefix) {
    const rows = this.db.prepare(
      'SELECT key, value FROM prefs WHERE key LIKE ? ORDER BY key',
    ).all(prefix.endsWith('.') ? prefix + '%' : prefix + '%');
    const out = {};
    for (const r of rows) {
      try { out[r.key] = JSON.parse(r.value); } catch { out[r.key] = r.value; }
    }
    return out;
  }

  // ---------- plays（M0 最小集：24h 去重窗口；M4 扩展完整读写）----------

  /** 最近 hours 小时内播过的 track_id 集合（大脑选曲去重，docs/03 §6.5 ②） */
  recentPlayedTrackIds(hours = 24, nowMs = Date.now()) {
    const since = nowMs - hours * 3600 * 1000;
    const rows = this.db.prepare(
      'SELECT DISTINCT track_id FROM plays WHERE at_ms >= ?',
    ).all(since);
    return new Set(rows.map((r) => r.track_id));
  }

  // ---------- messages（M4-T3）----------

  addMessage({ role, text, intent = null, lane = null, sessionId = null, broadcastId = null, degraded = 0, meta = null, atMs = Date.now() }) {
    const p2 = (n) => String(n).padStart(2, '0');
    const d = new Date(atMs);
    const date = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
    const r = this.db.prepare(
      `INSERT INTO messages (at_ms, date, role, text, intent, lane, session_id, broadcast_id, degraded, meta_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(atMs, date, role, text, intent, lane, sessionId, broadcastId, degraded ? 1 : 0, meta ? JSON.stringify(meta) : null);
    return r.lastInsertRowid;
  }

  recentMessages(limit = 6) {
    return this.db.prepare(
      'SELECT id, at_ms, role, text, intent, degraded FROM messages ORDER BY at_ms DESC LIMIT ?',
    ).all(limit).reverse();
  }

  // ---------- plays（M4-T3）----------

  /**
   * 记录一次播放开始，返回 plays.id。
   * 同一 broadcast 内同曲幂等（uq_plays_broadcast_track）：冲突时返回已有行 id。
   */
  addPlay({ trackId, source, title, artist, spec, album = null, audioUrl = null, coverUrl = null, durationMs = null, broadcastId = null, intent = null, reason = null, degraded = 0, atMs = Date.now() }) {
    const p2 = (n) => String(n).padStart(2, '0');
    const d = new Date(atMs);
    const date = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
    try {
      const r = this.db.prepare(
        `INSERT INTO plays (at_ms, date, track_id, source, title, artist, album, spec, audio_url, cover_url, duration_ms, broadcast_id, intent, reason, degraded)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(atMs, date, String(trackId), source, title, artist || '', album, spec, audioUrl, coverUrl, durationMs, broadcastId, intent, reason, degraded ? 1 : 0);
      return { id: r.lastInsertRowid, deduped: false };
    } catch (e) {
      if (String(e.message).includes('uq_plays_broadcast_track')) {
        const row = this.db.prepare(
          'SELECT id FROM plays WHERE broadcast_id = ? AND track_id = ?',
        ).get(broadcastId, String(trackId));
        return { id: row?.id ?? null, deduped: true };
      }
      throw e;
    }
  }

  /** 播放进度更新（跳过 / 完播判定：played_ms、completed、skipped） */
  updatePlayProgress(id, { playedMs, durationMs } = {}) {
    const row = this.db.prepare('SELECT duration_ms FROM plays WHERE id = ?').get(id);
    const total = durationMs ?? row?.durationMs ?? null;
    let completed = 0, skipped = 0;
    if (total && playedMs != null) {
      const ratio = playedMs / total;
      completed = ratio >= 0.9 ? 1 : 0;
      skipped = ratio < 0.3 ? 1 : 0;
    }
    this.db.prepare(
      'UPDATE plays SET played_ms = ?, completed = ?, skipped = ? WHERE id = ?',
    ).run(playedMs ?? 0, completed, skipped, id);
    return { completed, skipped };
  }

  setPlayFeedback(id, feedback) {
    if (![-1, 0, 1].includes(feedback)) throw new Error(`非法反馈值: ${feedback}`);
    this.db.prepare('UPDATE plays SET feedback = ? WHERE id = ?').run(feedback, id);
  }

  recentPlays(limit = 10) {
    return this.db.prepare(
      'SELECT id, at_ms, track_id, source, title, artist, spec, played_ms, completed, skipped, feedback, reason FROM plays ORDER BY at_ms DESC LIMIT ?',
    ).all(limit).reverse();
  }

  /** 查「放过 X 吗」：按 title/artist LIKE */
  findPlaysByTitle(q, limit = 5) {
    return this.db.prepare(
      `SELECT id, at_ms, title, artist, played_ms, at_ms FROM plays
       WHERE title LIKE ? OR artist LIKE ? ORDER BY at_ms DESC LIMIT ?`,
    ).all(`%${q}%`, `%${q}%`, limit);
  }

  /** 按播报 ID 找最近一条播放行（收藏/反馈落点） */
  findPlayByBroadcast(broadcastId) {
    return this.db.prepare(
      'SELECT id, title, artist, feedback FROM plays WHERE broadcast_id = ? ORDER BY at_ms DESC LIMIT 1',
    ).get(String(broadcastId)) || null;
  }

  // ---------- plan（M0/M4 最小集：M6 扩展 claim/stale 逻辑）----------

  upsertPlanRow({ date, slot, status = 'pending', scheduledAt, trigger = null, intent = null }) {
    this.db.prepare(
      `INSERT INTO plan (date, slot, status, scheduled_at, trigger, intent, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(date, slot) DO UPDATE SET scheduled_at = excluded.scheduled_at, updated_at = excluded.updated_at`,
    ).run(date, slot, status, scheduledAt, trigger, intent, Date.now());
  }

  getPlanRow(date, slot) {
    return this.db.prepare('SELECT * FROM plan WHERE date = ? AND slot = ?').get(date, slot) || null;
  }

  setPlanStatus(date, slot, status, extra = {}) {
    const cur = this.getPlanRow(date, slot);
    if (!cur) return null;
    this.db.prepare(
      `UPDATE plan SET status = ?, finished_at = COALESCE(?, finished_at),
       say = COALESCE(?, say), play_json = COALESCE(?, play_json), reason = COALESCE(?, reason),
       error_code = COALESCE(?, error_code), skip_reason = COALESCE(?, skip_reason), updated_at = ?
       WHERE date = ? AND slot = ?`,
    ).run(status, extra.finishedAt ?? null, extra.say ?? null, extra.playJson ?? null,
      extra.reason ?? null, extra.errorCode ?? null, extra.skipReason ?? null, Date.now(), date, slot);
    return this.getPlanRow(date, slot);
  }

  todayPlan(date) {
    return this.db.prepare('SELECT * FROM plan WHERE date = ? ORDER BY scheduled_at').all(date);
  }

  /** 完整性自检（验收标准：integrity_check = ok） */
  integrityCheck() {
    return integrityCheck(this.db);
  }
}

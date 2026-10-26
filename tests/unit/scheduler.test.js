/**
 * M6 验收单测 —— cron 解析 / 幂等 / 静默与节制 / 补跑 / 日历
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseCron, cronMatches, slotFireTimesToday, Scheduler } from '../../src/layer2/scheduler.js';
import { CalendarProvider } from '../../src/providers/calendar.js';
import { Planner } from '../../src/layer2/planner.js';
import { StateStore } from '../../src/layer2/state.js';
import { loadConfig } from '../../src/lib/config.js';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const cfg = loadConfig({ root: ROOT });

// ---------- cron ----------
test('cron 解析与匹配', () => {
  const c = parseCron('0 7 * * *');
  assert.deepEqual(c.min, [0]);
  assert.deepEqual(c.hour, [7]);
  assert.ok(cronMatches(new Date(2026, 9, 15, 7, 0), '0 7 * * *'));
  assert.ok(!cronMatches(new Date(2026, 9, 15, 7, 1), '0 7 * * *'));
  assert.ok(cronMatches(new Date(2026, 9, 15, 9, 0), '0 * * * *'));
  const step = parseCron('*/15 * * * *');
  assert.deepEqual(step.min, [0, 15, 30, 45]);
});

test('slotFireTimesToday：已过时刻收集', () => {
  const now = new Date(2026, 9, 15, 14, 30);
  const t = slotFireTimesToday('0 9 * * *', now);
  assert.equal(t.length, 1);
  assert.equal(t[0].getHours(), 9);
  assert.equal(slotFireTimesToday('0 16 * * *', now).length, 0, '未来时刻不算');
});

// ---------- Scheduler：幂等 / 静默 / 补跑 ----------

function makeScheduler({ now = new Date(2026, 9, 15, 9, 0) } = {}) {
  const state = new StateStore(path.join(fs_tmp(), 't.db'));
  const fired = [];
  const compute = { runScheduled: async (slot, o) => { fired.push([slot, o.trigger]); return { say: 'ok', queue: [], state: 'IDLE' }; } };
  const sched = new Scheduler({ config: cfg, compute, state, log: silent(), calendar: null });
  return { sched, state, fired };
}
function fs_tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'claudiao-sched-')); }
function silent() { const l = { info() {}, warn() {}, error() {}, debug() {}, child() { return l; } }; return l; }

test('morning 09:00 触发：plan 行 succeeded + 幂等（同日第二次不再触发）', async () => {
  const { sched, state, fired } = makeScheduler();
  const now = new Date(2026, 9, 15, 9, 0);
  const slot = cfg.routines.slots.find((s) => s.name === 'morning');
  await sched._fire(slot, '2026-10-15', now, 'schedule');
  assert.equal(fired.length, 1);
  const row = state.getPlanRow('2026-10-15', 'morning');
  assert.equal(row.status, 'succeeded');
  await sched._fire(slot, '2026-10-15', new Date(2026, 9, 15, 9, 1), 'schedule');
  assert.equal(fired.length, 1, '幂等命中不重跑');
});

test('静默时段：23:00 的 slot 被 skipped（quiet_hours）', async () => {
  const { sched, state } = makeScheduler();
  const now = new Date(2026, 9, 15, 23, 0);
  const slot = cfg.routines.slots.find((s) => s.name === 'night_wind_down');
  // night_wind_down 是 22:30；直接用 _fire 在 23:00 模拟（cron 匹配由 _evalSlot 把关）
  await sched._fire(slot, '2026-10-15', now, 'schedule');
  const row = state.getPlanRow('2026-10-15', slot.name);
  assert.equal(row.status, 'skipped');
  assert.equal(row.skip_reason, 'quiet_hours');
});

test('doNotDisturb：周三 10:00 的 slot 被 skipped', async () => {
  const { sched, state } = makeScheduler();
  // 2026-10-14 是周三
  const now = new Date(2026, 9, 14, 10, 0);
  const slot = { name: 'test_dnd', cron: '0 10 * * *', silent: false, useBrain: false };
  await sched._fire(slot, '2026-10-14', now, 'schedule');
  const row = state.getPlanRow('2026-10-14', 'test_dnd');
  assert.equal(row.status, 'skipped');
  assert.equal(row.skip_reason, 'dnd');
});

test('每日上限：8 次后 daily_quota', async () => {
  const { sched, state } = makeScheduler();
  const date = '2026-10-15';
  state.setPref(`broadcast.count.${date}`, 8);
  const now = new Date(2026, 9, 15, 12, 0);
  const slot = cfg.routines.slots.find((s) => s.name === 'noon');
  await sched._fire(slot, date, now, 'schedule');
  assert.equal(state.getPlanRow(date, 'noon').skip_reason, 'daily_quota');
});

test('补跑：09:00 的 morning 在 09:10（grace 90min 内、避开 DND 与专注窗）被 catchup', async () => {
  const { sched, fired } = makeScheduler();
  const now = new Date(2026, 9, 15, 9, 10);
  const slot = cfg.routines.slots.find((s) => s.name === 'morning');
  sched._evalSlot(slot, '2026-10-15', now);
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(fired.some(([s, trig]) => s === 'morning' && trig === 'catchup'), JSON.stringify(fired));
});

test('超窗：hourly_check grace=0 不补跑', () => {
  const { sched, fired } = makeScheduler();
  const now = new Date(2026, 9, 15, 10, 20);
  const slot = cfg.routines.slots.find((s) => s.name === 'hourly_check');
  sched._evalSlot(slot, '2026-10-15', now);
  assert.equal(fired.length, 0);
});

// ---------- Calendar ----------
test('日历：周一给出周会 + 临近提醒幂等', () => {
  const cal = new CalendarProvider({ calendarYml: cfg.calendar, state: null });
  const mon = new Date(2026, 9, 12, 9, 40); // 周一 09:40，周会 10:00 lead 30
  const evs = cal.todayEvents(mon);
  assert.ok(evs.some((e) => e.title === '周会'));
  const due = cal.dueReminders(mon);
  assert.equal(due.filter((e) => e.title === '周会').length, 1);
});

test('Planner：当日规划生成且幂等', async () => {
  const state = new StateStore(path.join(fs_tmp(), 't.db'));
  const planner = new Planner({ config: cfg, state, music: null, tts: null, log: silent() });
  const now = new Date(2026, 9, 15, 7, 0);
  const r1 = await planner.buildDailyPlan(now);
  const r2 = await planner.buildDailyPlan(now);
  assert.ok(r1.length >= 5);
  assert.equal(r2.length, r1.length, '重复执行不产生重复行');
  state.close();
});

/**
 * Claudiao · 节律调度（M6，docs/07-scheduler-rhythm.md）
 *
 * - 5 段 cron（分 时 日 月 周，支持 星号 / 数字 / 步长）；slots 来自 routines.yml
 * - 幂等：plan 表 (date,slot) 主键——同日同 slot 的 succeeded 不可重入
 * - 补跑：fire 时刻落在 graceMinutes 宽限内 → catchup；超窗 → skipped(missed_window)
 * - 节制：静默时段 / doNotDisturb / protectedWindows / 最小间隔 / 每日上限 / 连败熔断
 */
import { StateStore } from './state.js';

const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/** 解析 5 段 cron → {min:[..], hour:[..], dom:[..], mon:[..], dow:[..]}（数字数组） */
export function parseCron(expr) {
  const parts = String(expr).trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`cron 必须是 5 段: "${expr}"`);
  const expand = (f, lo, hi) => {
    const out = new Set();
    for (const piece of f.split(',')) {
      let [range, step] = piece.split('/');
      step = step ? Number(step) : 1;
      let a = lo, b = hi;
      if (range !== '*') {
        const [x, y] = range.split('-');
        a = Number(x); b = y !== undefined ? Number(y) : (step = 1, a);
      }
      for (let v = a; v <= b; v += step) out.add(v);
    }
    return [...out].sort((a, b) => a - b);
  };
  return {
    min: expand(parts[0], 0, 59),
    hour: expand(parts[1], 0, 23),
    dom: expand(parts[2], 1, 31),
    mon: expand(parts[3], 1, 12),
    // cron 的周日=0；本地 DAY_NAMES 也从周日开始
    dow: expand(parts[4] === '7' ? '0' : parts[4], 0, 6),
  };
}

export function cronMatches(date, expr) {
  const c = parseCron(expr);
  return c.min.includes(date.getMinutes()) && c.hour.includes(date.getHours())
    && c.dom.includes(date.getDate()) && c.mon.includes(date.getMonth() + 1)
    && c.dow.includes(date.getDay());
}

/** slot 今日的触发时刻（固定时/分模式；每小时的 slot 返回全部匹配时刻） */
export function slotFireTimesToday(expr, now = new Date()) {
  const c = parseCron(expr);
  const out = [];
  for (const h of c.hour) {
    if (h > now.getHours()) continue;
    for (const m of c.min) {
      const t = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m);
      if (t <= now) out.push(t);
    }
  }
  return out.sort((a, b) => a - b);
}

const p2 = (n) => String(n).padStart(2, '0');
const localDate = (d = new Date()) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
const hhmm = (d) => `${p2(d.getHours())}:${p2(d.getMinutes())}`;

function inWindow(d, win) {
  if (win.days && !win.days.includes(DAY_NAMES[d.getDay()])) return false;
  const cur = hhmm(d);
  const { start, end } = win;
  if (start <= end) return cur >= start && cur < end;
  return cur >= start || cur < end;                                    // 跨午夜
}

export class Scheduler {
  /**
   * @param {object} deps { config, compute, state(StateStore), log, calendar? }
   */
  constructor({ config, compute, state, log, calendar } = {}) {
    this.cfg = config;
    this.compute = compute;
    this.state = state;
    this.log = (log?.child?.('sched')) ?? log ?? console;
    this.calendar = calendar || null;
    this.timer = null;
  }

  start({ intervalMs = 20000 } = {}) {
    this._tick();
    this.timer = setInterval(() => this._tick(), intervalMs);
    this.log.info?.('调度已启动', { intervalMs, slots: this.cfg.routines.slots.length });
  }

  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  _tick(now = new Date()) {
    if (!this.cfg.routines.enabled) return;
    const date = localDate(now);
    for (const slot of this.cfg.routines.slots) {
      if (!slot.cron) continue;                                          // calendar_hook/prefetch 非定时
      try { this._evalSlot(slot, date, now); } catch (e) {
        this.log.error?.(`slot ${slot.name} 评估异常`, { error: e.message });
      }
    }
  }

  _evalSlot(slot, date, now) {
    if (!cronMatches(now, slot.cron)) {
      // 补跑检查：今日已有 fire 时刻过点、无 plan 记录、且在 grace 窗口内
      this._checkCatchup(slot, date, now);
      return;
    }
    this._fire(slot, date, now, 'schedule');
  }

  _checkCatchup(slot, date, now) {
    if (!this.cfg.routines.wakeCatchUp?.enabled) return;
    if (!slot.graceMinutes) return;
    const fires = slotFireTimesToday(slot.cron, now);
    const last = fires[fires.length - 1];
    if (!last) return;
    const since = (now - last) / 60000;
    if (since <= 0 || since > slot.graceMinutes) return;                 // 还没到 / 超窗
    const row = this.state.getPlanRow(date, slot.name);
    if (row) return;                                                     // 已处理过
    this._fire(slot, date, now, 'catchup');
  }

  async _fire(slot, date, now, trigger) {
    const existing = this.state.getPlanRow(date, slot.name);
    if (existing && ['succeeded', 'skipped', 'running'].includes(existing.status)) {
      if (!(trigger === 'manual' && this.cfg.routines.idempotency?.allowManualRerun)) return;
    }

    const skip = (reason) => {
      this.state.upsertPlanRow({ date, slot: slot.name, status: 'skipped', scheduledAt: now.getTime(), trigger });
      this.state.setPlanStatus(date, slot.name, 'skipped', { finishedAt: Date.now(), skipReason: reason });
      this.log.info?.(`slot ${slot.name} 跳过`, { reason });
      return null;
    };

    const hour = now.getHours();
    // 节制规则（docs/07 §节制）
    if (slot.silent !== true) {
      const qh = this.cfg.routines.quietHours;
      if (qh && inWindow(now, { start: qh.start, end: qh.end })) return skip('quiet_hours');
      for (const w of this.cfg.routines.doNotDisturb || []) {
        if (inWindow(now, w)) return skip('dnd');
      }
      for (const w of this.cfg.routines.protectedWindows || []) {
        if (inWindow(now, w)) return skip('focus_window');
      }
      const minGap = this.cfg.routines.limits?.minIntervalMinutes ?? 45;
      const lastAt = this.state.getPref('broadcast.lastAt', 0);
      if (now.getTime() - lastAt < minGap * 60000) return skip('min_gap');
      const countKey = `broadcast.count.${date}`;
      if ((this.state.getPref(countKey, 0) ?? 0) >= (this.cfg.routines.limits?.dailyMaxBroadcasts ?? 8)) {
        return skip('daily_quota');
      }
      if ((this.state.getPref('broadcast.circuit.strikes', 0) ?? 0) >= (this.cfg.routines.limits?.consecutiveFailureBreaker ?? 3)) {
        return skip('breaker');
      }
    }

    // 认领并执行
    this.state.upsertPlanRow({ date, slot: slot.name, status: 'running', scheduledAt: now.getTime(), trigger });
    try {
      const b = await this.compute.runScheduled(slot.name, { trigger, useBrain: slot.useBrain !== false });
      if (slot.silent === true) {
        this.state.setPlanStatus(date, slot.name, 'succeeded', { finishedAt: Date.now() });
      } else {
        this.state.setPlanStatus(date, slot.name, 'succeeded', {
          finishedAt: Date.now(), say: b.say?.text || '', playJson: JSON.stringify(b.queue || []),
          reason: b.reason || '',
        });
        this.state.setPref('broadcast.lastAt', Date.now());
        this.state.setPref(`broadcast.count.${date}`, (this.state.getPref(`broadcast.count.${date}`, 0) ?? 0) + 1);
        this.state.setPref('broadcast.circuit.strikes', 0);
      }
      this.log.info?.(`slot ${slot.name} 完成`, { trigger, state: b.state });
      return b;
    } catch (e) {
      this.state.setPlanStatus(date, slot.name, 'failed', { finishedAt: Date.now(), errorCode: e.code || 'E_SLOT' });
      const strikes = (this.state.getPref('broadcast.circuit.strikes', 0) ?? 0) + 1;
      this.state.setPref('broadcast.circuit.strikes', strikes);
      this.log.error?.(`slot ${slot.name} 失败`, { error: e.message, strikes });
      throw e;
    }
  }
}

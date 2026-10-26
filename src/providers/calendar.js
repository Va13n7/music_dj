/**
 * Claudiao · 日历提供方（M6-T5，docs/07）
 * 读 config/calendar.yml（weekly/events/annual），给出「今天的事件」与「临近提醒」。
 */
import { StateStore } from '../layer2/state.js';

const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const p2 = (n) => String(n).padStart(2, '0');

export class CalendarProvider {
  /**
   * @param {object} opts { calendarYml(config.calendar), config, state?(StateStore), log }
   */
  constructor({ calendarYml, config, state, log } = {}) {
    this.yml = calendarYml || {};
    this.config = config;
    this.state = state;                 // 可选：提醒幂等走 prefs（calendar.reminded.<date>.<title>）
    this.log = log || console;
  }

  todayEvents(now = new Date()) {
    const date = `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())}`;
    const dayName = DAY_NAMES[now.getDay()];
    const out = [];
    for (const w of this.yml.weekly || []) {
      if (w.day === dayName) out.push({ date, ...w });
    }
    for (const e of this.yml.events || []) {
      if (e.date === date) out.push({ ...e, date });
    }
    for (const a of this.yml.annual || []) {
      if (Number(a.month) === now.getMonth() + 1 && Number(a.day) === now.getDate()) {
        out.push({ date, title: a.title, mood: a.mood, note: a.note, annual: true });
      }
    }
    return out;
  }

  /** 当前时刻的事件文本（context ③ 片注入用） */
  injectionText(now = new Date()) {
    const evs = this.todayEvents(now).slice(0, this.yml.maxEventsInjected || 5);
    if (!evs.length) return this.yml.injectWhenEmpty === false ? '' : '今天没有已记录的日程。';
    return '今日日程:\n' + evs.map((e) => `- ${e.start ?? '全天'}${e.end ? '–' + e.end : ''} ${e.title}${e.mood ? `（情绪倾向：${e.mood}）` : ''}`).join('\n');
  }

  /**
   * 临近提醒：未来 leadMinutes 内有事件需要提醒（calendar_hook 用）。
   * 幂等：同日同事件标题只提醒一次（prefs）。
   */
  dueReminders(now = new Date()) {
    const lead = Number(this.yml.calendarHookLeadMinutes ?? 30);
    const out = [];
    for (const e of this.todayEvents(now)) {
      if (!e.remind || !e.start) continue;
      const [h, m] = String(e.start).split(':').map(Number);
      const at = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m);
      const mins = (at - now) / 60000;
      if (mins >= 0 && mins <= (e.leadMinutes ?? lead)) {
        const key = `calendar.reminded.${e.date}.${e.title}`;
        if (this.state?.getPref?.(key)) continue;
        this.state?.setPref?.(key, true);
        out.push(e);
      }
    }
    return out;
  }
}

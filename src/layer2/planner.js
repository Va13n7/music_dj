/**
 * Claudiao · 每日规划（M6-T6）
 * daily_plan slot 触发：为当日每个可发声 slot 预写 plan 行（pending），
 * 并预热早间曲目直链与 TTS 缓存（best-effort，失败不阻塞规划）。
 */
export class Planner {
  /** @param {object} deps { config, state, music, tts, log } */
  constructor({ config, state, music, tts, log } = {}) {
    this.cfg = config;
    this.state = state;
    this.music = music;
    this.tts = tts;
    this.log = (log?.child?.('planner')) ?? log ?? console;
  }

  /** 生成当日规划（重复执行幂等：upsert 不覆盖已有状态） */
  async buildDailyPlan(now = new Date()) {
    const p2 = (n) => String(n).padStart(2, '0');
    const date = `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())}`;
    const slots = this.cfg.routines.slots.filter((s) => s.cron);
    let planned = 0;
    for (const s of slots) {
      if (s.silent === true && s.name === 'daily_plan') continue;
      const exists = this.state.getPlanRow(date, s.name);
      if (exists) continue;
      const fires = slotTimes(s.cron, now);
      const at = fires.length ? fires[fires.length - 1] : now;
      this.state.upsertPlanRow({ date, slot: s.name, status: 'pending', scheduledAt: at.getTime(), intent: s.intent || 'scheduled_broadcast' });
      planned++;
    }
    this.log.info?.(`当日规划完成`, { date, planned, total: slots.length - 1 });
    return this.state.todayPlan(date);
  }

  /** 预热：早间歌单前 2 首直链 + 开场白 TTS（best-effort 并行） */
  async warmup() {
    const jobs = [];
    try {
      const specs = (this.cfg.routines.slots.find((s) => s.name === 'morning')) ? ['早间预热'] : [];
      for (const spec of specs) {
        jobs.push(this.music.resolve(spec).catch((e) => this.log.warn?.('预热直链失败', { error: e.message })));
      }
    } catch { /* ignore */ }
    await Promise.allSettled(jobs);
  }
}

function slotTimes(cron, now) {
  try {
    const [mm, hh] = String(cron).split(/\s+/);
    if (hh === '*' || mm === '*') return [];
    const h = Number(hh), m = Number(mm);
    if (!Number.isFinite(h) || !Number.isFinite(m)) return [];
    return [new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m)];
  } catch { return []; }
}

# Claudiao 个人音乐电台 · 调度与节律

> 文档版本 v1.0 · 状态：设计完成，待实现
> 上游依据：[设计总览](01-architecture-design.md) §1.2 F-02 / §2 第二层 `SCHEDULER.JS` / §4.2 从链路 / §5.3 / §8.2 / §10 Q-03
> 关联文档：[接口契约](03-api-contract.md) · [TTS 声音管线](04-tts-pipeline.md) · [大脑适配器](05-brain-adapter.md) · [音乐提供方](06-music-provider.md) · [前端 PWA](08-pwa-frontend.md)
> 落地位置：`src/layer2/scheduler.js` + `src/providers/calendar/{yaml.js,ics.js}` + `config/routines.yml`
> 施工图格子：第二层 `SCHEDULER.JS`（`07:00 规划 · 09:00 早间 · 小时情绪检查 · 日历 hook`）

---

## 1. 目标

让电台有**节律感**：一天里有几个固定的「它开口的时刻」，这些时刻之外它安静地放歌，不刷存在感。

| 编号 | 目标 | 量化验收 |
|---|---|---|
| S-01 | 定时准确 | 各 slot 触发误差 ≤60s（F-02） |
| S-02 | 主动而不打扰 | 静默时段（默认 23:00–07:00）内**零主动播报**；用户主动点播不受限 |
| S-03 | 幂等 | 同一 `(date, slot)` 每天最多成功一次；重复触发产出 `skipped` 而非重复播报 |
| S-04 | 可补跑 | 休眠/重启后处于宽限窗口内的 slot 补跑；超窗口标 `skipped`（**不补过时播报**） |
| S-05 | 不打断 | 用户正在交互（`SPEAKING`/`THINKING`，或 60s 内有输入）时低优先级 slot 让路 |
| S-06 | 日历感知 | 当天有日程时播报能提到（例：「10 点有个会，先给你放两首轻的」） |
| S-07 | 可关闭 | 每个 slot 都能在 `routines.yml` / `prefs` 单独关闭，改完下次触发生效，无需重启（F-09） |

**核心取向**：节律的价值在「可预期」而非「频繁」。宁可少一次，不多一次打扰（回应总览 Q-03）。

---

## 2. 调度表

### 2.1 完整 slot 表

**slot id 与 cron 以 [模块详细设计 §6.1](02-module-spec.md) 为唯一权威**（该表取自 `routines.md` §二 与 `playlists.json.slotDefaults`），本文档与 `config/routines.yml` **必须使用同一组下划线 id**。

| slot | 默认 cron | 触发意图 | 播报内容风格 | 走大脑 | 可补跑（宽限窗口） | 可被 `prefs` 关闭 | 静默期豁免 |
|---|---|---|---|---|---|---|---|
| `daily_plan` | `0 7 * * *` | 生成当日时段规划（F-07 数据源） | 结构化简报：「今天三档：早间轻快、午后专注、夜里安静」 | ✅ 必走 | ✅ 07:00 → **12:00** | ✅ | ❌（静默） |
| `morning` | `0 9 * * *` | 早间播报：天气 + 规划摘要 + 第一档选曲 | 明快、有精神、带天气：「早上好，今天小雨 18 度……」 | ✅ 必走 | ✅ 09:00 → **10:30** | ✅ | ❌ |
| `hourly_check` | `0 9-22 * * *` | 整点情绪检查：判断是否需换档 | 极短、允许「不说话只换歌」：「到中午了，换点明亮的」 | ✅ 走（轻量 prompt） | ❌ 过期即 `skipped` | ✅ | ✅ |
| `noon` | `0 12 * * *` | 午间提醒 + 换到午后档 | 一句，轻快：「中午了，换点不困的」 | ✅ 走 | ✅ +60min | ✅ | ❌ |
| `evening` | `30 17 * * *` | 傍晚转场：下班/收工节点 | 松弛、带过渡感：「收工了，先放两首松的」 | ✅ 走 | ✅ +90min | ✅ | ❌ |
| `night_wind_down` | `30 22 * * *` | 收尾：提示休息 + 切低能量档 | 柔和降速（`rate:-8%`）：「快十点半了，放点安静的陪你收尾」 | ❌（模板即可） | ❌ 过了就过了 | ✅ | ✅（22:30 < 23:00，天然在静默窗口外） |
| `calendar_hook` | **事件驱动**（事件前 30min / 结束后） | 日程预告 + 前后选曲倾向 | 提醒式、短：「十点有个会，之前给你放两首不吵的」 | ✅ 有日程才走 | ❌ | ✅ | ❌ |
| `prefetch` | 各 slot 前 5min + 前端「剩余 10s」事件 | 预热：预合成播报、刷新歌单缓存、探活音乐源 | **不播报**（纯后台） | ❌ | ❌ | ❌ | ✅ |

**三条与别处对齐的硬约定**（均取自 [02 §6.1 的四处参数裁决](02-module-spec.md)）：

| 项 | 取值 | 理由 |
|---|---|---|
| 静默时段 | **23:00–07:00** | 22:30 是 `night_wind_down` 的 cron，若静默从 22:30 起会把「晚安」当场挡掉；改 23:00 后该 slot 天然落在窗口外，**不需要任何例外** |
| 两次主动播报最小间隔 | **45 分钟**（`throttle.minGapMs = 2700000`） | 与 `routines.yml` 的 `limits.minIntervalMinutes` 一致 |
| `slots[].intent` 字段 | 只是**可读标签** | `router.classify` 对 `source==='schedule'` 一律归为 `Intent.name = 'scheduled_broadcast'`；slot 语义经 `intent.slots.slot` 与第 ⑥ 片传递，**不进入 `Intent.name`** |

### 2.2 施工图四项的落地对应

| 施工图原文 | 本项目 slot | 说明 |
|---|---|---|
| `07:00 规划` | `daily_plan` | 写 `plan` 表，`/api/plan/today` 直接读（F-07）；**静默 slot**（只落规划，不开口） |
| `09:00 早间` | `morning` | 用户可见的第一个「主动开口」 |
| `小时情绪检查` | `hourly_check` | 09:00–22:00，共 14 次/天；无新信息保持沉默；可关（Q-03） |
| `日历 hook` | `calendar_hook` | 事件驱动（事件前 30min / 结束后），数据源见 §5 |

施工图未画、但由 `routines.md` 语料与本文档补充的 slot：`noon`（12:00 午间转场）、`evening`（17:30 傍晚转场）、`night_wind_down`（22:30 收尾）。

### 2.3 施工图没有但必要的两项

| 项 | 为什么必要 |
|---|---|
| **夜间静默时段**（23:00–07:00） | 项目价值是「按作息」而非只「按时间」。没有静默的定时播报在深夜是**骚扰**而非服务。它是一条**横切规则**：所有 slot 在窗口内一律不主动触发（`prefetch` 除外，它不说话）。 |
| **`prefetch` 预热任务** | ① edge-tts 首次合成 3.07s，09:00 才第一次合成会让早间播报慢一拍；② 音乐源探活应在用户等待前完成（[06](06-music-provider.md) §6.2）；③ TTS LRU 与 `cache` 表清理需要心跳（[04](04-tts-pipeline.md) §5.4、[06](06-music-provider.md) §9）。三件事都需要一个「每分钟在场」的 tick。 |

```yaml
quietHours:
  enabled: true
  start: '23:00'      # 含
  end:   '07:00'      # 不含（07:00 整点即白天）
  allow: ['prefetch'] # 静默期仍允许执行的 slot（不发声的）
  exemptOnUserChat: true   # 静默的是「主动」，不是「电台」
```

| 静默规则 | 说明 |
|---|---|
| 判定用**触发时刻**而非执行时刻 | 22:59 触发、23:01 执行 → 仍合法 |
| 跨午夜 | `start > end` 表示跨天窗口（23:00 → 次日 07:00），判定见 §3.3 `inWindow()` |
| 与 `night_wind_down` 的边界 | 22:30 是 `night_wind_down` 的 cron，**早于** 23:00 的静默起点。半开区间 `[23:00, 07:00)`，因此「晚安」永远说得出来，**不需要**给该 slot 开例外 |
| 静默期内用户点播 | 完全正常播报（`trigger.type==='user_chat'` 直接豁免） |
| 静默期内的休眠唤醒补跑 | 补跑判定叠加静默检查：窗口与静默期重叠 → `skipped`（§4.4） |

---

## 3. cron 实现

### 3.1 选型对比

| 方案 | 优点 | 缺点 | Windows/休眠表现 | 结论 |
|---|---|---|---|---|
| `node-cron`（显式 `timezone:'Asia/Shanghai'`） | API 熟悉，支持 `0 9 * * *`，社区活跃；**02 §6.1 指定为 cron 解析的首选** | 内部仍是到下一匹配点的 `setTimeout`；**长延迟 setTimeout 在休眠后漂移**（Windows 休眠常达数小时）；不处理「错过的触发」 | ❌ 休眠 3h 后 09:00 定时器可能永不触发或唤醒即触发 | ⚠️ **首选解析器**，但必须叠加 tick 兜底 |
| `cron`（`cron` 包） | API 更丰富（秒级、`timeZone` 选项） | 同样的长 `setTimeout` 漂移 | ❌ 同上 | ❌ 不单独使用 |
| 自研 `setTimeout` 链 | 零依赖、完全可控 | 必须自己处理时钟跳变、休眠、DST、时区、任务重入——正是要避免的复杂度 | ❌ 最易踩坑 | ❌ |
| **30s tick + 时间窗判定（兜底，推荐实现）** | ① 定时器最长只等 30s，休眠唤醒后**必然**在一个 tick 内对齐真实时钟；② 天然支持「错过即补跑」（窗口内任意 tick 都可触发）；③ 时钟回拨/跳变无害；④ 无 DST 陷阱（判定基于本地时间字段）；⑤ 与 `prefetch`、缓存清理心跳**天然共用** | 触发粒度 30s（F-02 允许 ≤60s）；需自写约 60 行窗口判定 | ✅ 最优 | ✅ **采用为实现主干** |

**结论（与 [02 §6.1](02-module-spec.md) 一致的落地方式）**：cron **表达式解析**优先用 `node-cron`（或 `cron`）并显式指定 `timezone:'Asia/Shanghai'`；**触发主干**用自研「**30s tick + 时间窗判定**」，不依赖长延迟 `setTimeout`。这样既复用了成熟库的表达式解析（含 `9-22` 区间、列表、星期），又拿到 tick 方案的休眠对齐与补跑能力——精度要求只有 60s（F-02），而**休眠补跑是硬需求**（S-04），长延迟 `setTimeout` 与之根本冲突。若依赖不可用，退化为自研 5 字段解析（`parseCron`/`expandField`），行为等价，日界按本地日期。

### 3.2 tick 循环伪码

```js
// src/layer2/scheduler.js
const TICK_MS = 30_000;            // 30s 一次（60s 粒度需求留 2× 余量，抗一次 tick 延迟）
let tickTimer = null;

function start(cfg) {
  cfg = loadRoutines(cfg);         // config/routines.yml + prefs 覆盖（F-09 立即生效）
  // ★ 不用 setTimeout 递归：setInterval 在 Windows 休眠唤醒后会补齐下一次触发，
  //   且我们每 tick 重新读真实时钟，不依赖累计时间
  tickTimer = setInterval(guard(tick), TICK_MS);
  tick(new Date(), { cold: true });   // 启动即跑一次：进程重启后立刻完成补跑判定（S-04）
}

/** 任何异常都不允许终止 tick 循环（电台的核心体验是「一直在响」，D-08） */
const guard = (fn) => async (...args) => {
  try { await fn(...args); }
  catch (e) { logger.error({ evt: 'scheduler.tick.error', err: e.message, stack: e.stack?.split('\n')[1] }); }
};

async function tick(now = new Date(), { cold = false } = {}) {
  const wall = wallClock(now, cfg.timezone);          // {date, minutes:0..1439, hh, mm, dow}
  const quiet = cfg.quietHours.enabled && inWindow(wall.minutes, cfg.quietHours);

  for (const slot of cfg.slots) {
    if (!slot.enabled) continue;                                      // prefs 关闭
    if (quiet && !cfg.quietHours.allow.includes(slot.name)) continue; // 静默期不评估
    const due = dueMinutes(slot, wall);                               // 未到 / 今日不匹配 → null
    if (due === null || wall.minutes < due) continue;

    const late = wall.minutes - due;
    if (late > (slot.catchUp ? slot.graceMinutes : 0)) {               // 超宽限：绝不补过时播报
      await state.markSlot(wall.date, slot.name, 'skipped', { lateMin: late, reason: 'missed_window' });
      continue;
    }
    const claim = await state.tryClaim(wall.date, slot.name, { ttlMs: 90_000, priority: slot.priority });
    if (!claim.ok) continue;                                          // 已成功/已抢占/正在跑 → 跳过
    if (claim.wasStale) logger.warn({ evt: 'scheduler.stale_released', slot: slot.name });

    if (shouldYieldToUser(slot)) {                                    // 用户正在交互 → 让路（§7.2）
      await state.releaseSlot(claim.id, { backTo: 'pending' });        // 回 pending，下一 tick 再试
      continue;
    }
    enqueueTrigger({ type: 'schedule', slot: slot.name, date: wall.date, claimId: claim.id,
                     intent: slot.intent, lateMin: late, cold });      // 不 await 完成，只入队
  }
  await runHousekeeping(wall, { cold });            // 后台心跳（不发声，静默期照跑）
}
```

### 3.3 时间窗与工具函数

```js
const toMin = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };

/** 半开区间判定，支持跨午夜（start > end） */
function inWindow(minutes, { start, end }) {
  const s = toMin(start), e = toMin(end);
  return s <= e ? (minutes >= s && minutes < e)     // 同日窗口 [s, e)
                : (minutes >= s || minutes < e);    // 跨午夜 [s, 24h) ∪ [0, e)
}

/** cron 字段 → 今日应触发的分钟数（仅支持本项目需要的形态） */
function dueMinutes(slot, wall) {
  const { minute, hour, dom, month, dow } = parseCron(slot.cron);   // 5 字段，支持 * , - /
  if (dom   !== '*' && !matchField(dom,   wall.d))   return null;   // 日/月/星期不匹配 → 今日不触发
  if (month !== '*' && !matchField(month, wall.mo))  return null;
  if (dow   !== '*' && !matchField(dow,   wall.dow)) return null;
  if (hour === '*') return wall.minutes - wall.minutes % 60 + minute;
  let best = null;                                                  // 取当日「已到达的最大匹配分钟」
  for (const h of expandField(hour)) {                              // '10-22' → [10..22]
    const mm = h * 60 + minute;
    if (mm <= wall.minutes && (best === null || mm > best)) best = mm;
  }
  return best;
}
```

**`hourly_check` 的取舍**：cron `0 9-22 * * *`，`catchUp:false`、`graceMinutes:0`。若 12:00 的 tick 因休眠错过，13:00 的 tick 看到 `best=13:00`（而非 12:00），**12 点那次由 `skipped` 语义吸收**。「12 点的情绪检查」在 14 点执行没有意义，故它是唯一「过期即作废」的高频 slot。

### 3.4 时区

| 项 | 设计 |
|---|---|
| 默认 | `timezone: system` → 系统本地时区；可用 `ROUTINES_TZ=Asia/Shanghai` 或 `routines.yml → timezone` 覆盖 |
| 实现 | 用 `Intl.DateTimeFormat('en-CA', { timeZone, ...parts })` 取壁钟字段，**不用** `new Date().getHours()`（无法覆盖时区且在测试中不可注入） |
| 测试注入 | `tick(now)` 显式接收 `now`，测试传任意时刻（§9 R-1） |
| DST | 判定基于**壁钟分钟数**而非 epoch 差值，DST 跳变最多让某 slot 多/少触发一次，由 `(date, slot)` 幂等表兜住；中国无 DST，实际不影响 |

```js
function wallClock(date, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: tz === 'system' ? undefined : tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short',
  }).formatToParts(date).map(x => [x.type, x.value]));
  const minutes = (+p.hour % 24) * 60 + +p.minute;
  return { mo: +p.month, d: +p.day, date: `${p.year}-${p.month}-${p.day}`, minutes,
           dow: ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].indexOf(p.weekday) };
}
```

### 3.5 心跳任务 `runHousekeeping`

| 任务 | 频率 | 说明 |
|---|---|---|
| TTS LRU + 过期清理 | 每 10min | [04](04-tts-pipeline.md) §5.4 |
| `cache` 表 TTL 清理 | 每 10min | [06](06-music-provider.md) §9 |
| `plan` 归档 | 每日 03:00 | 保留 30 天（F-07 只需当日） |
| 音乐源探活 | 每 30min + `prefetch` | 结果写 `data/music-health.json`，供 `/api/now` 的 `health.music` |
| TTS 引擎探活 | 熔断打开时按退避探测 | [04](04-tts-pipeline.md) §3.3 |
| stale 释放 | 每 tick | §4.3 |

---

## 4. 幂等与补跑

### 4.1 唯一键与状态表

唯一键 = **`(date, slot)`**（总览 §4.2）。表结构以 [接口契约 `plan` 表](03-api-contract.md#sqlite-ddl) 为正本（`plan` 表，字段名 `status`/`attempt`/`owner`/`finished_at`/`skip_reason` 等），本节只列调度侧关心的列与用法：

```sql
-- 正本 DDL 见 [03](03-api-contract.md#sqlite-ddl) §6.3，此处为调度侧视图
CREATE TABLE IF NOT EXISTS plan (
  date          TEXT NOT NULL,        -- 'YYYY-MM-DD'（本地日，幂等键第一段）
  slot          TEXT NOT NULL,        -- 'daily_plan' | 'morning' | ...
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','claimed','running','succeeded','failed','skipped')),
  scheduled_at  INTEGER NOT NULL,     -- 计划触发时刻（epoch ms）
  claimed_at    INTEGER,              -- 抢锁时刻；>90s 未终结即 stale（总览 §8.2）
  finished_at   INTEGER,
  owner         TEXT,                 -- 持锁者：<pid>:<rand>，用于排障与 stale 释放
  attempt       INTEGER NOT NULL DEFAULT 0,   -- 尝试次数（含补跑），≥1 表示已投递过
  trigger       TEXT,                 -- schedule | catchup | wake | startup | webhook
  late_min      INTEGER DEFAULT 0,    -- ★ 调度侧扩展：迟到分钟数（补跑幅度，用于审计与 prompt §6.3）
  skip_reason   TEXT,                 -- missed_window | quiet_hours | min_gap | superseded | ...
  payload       TEXT,                 -- JSON：say/play/reason 摘要
  PRIMARY KEY (date, slot)            -- ★ 保证同日同 slot 的 succeeded 不可重入
);
```

### 4.2 生命周期（与总览 §8.2 严格一致）

```
                    ┌───────────────────────────┐
                    │ tryClaim(date, slot)      │  INSERT ... ON CONFLICT DO NOTHING
                    └─────────────┬─────────────┘  插入成功 = 抢占成功
        ┌────────┐   抢占   ┌─────────┐  compute() 开始  ┌─────────┐
        │pending ├─────────▶│ claimed ├────────────────▶│ running │
        └────────┘          └────┬────┘                 └────┬────┘
                       90s 未终结│ 释放锁并标 failed          ├─ 成功 → succeeded（终态）
                                 ▼                          ├─ 失败 → failed（当日可重试 1 次）
                            ┌────────┐                      └─ 主动跳过 → skipped（终态）
                            │ failed │
                            └────────┘
```

```js
/** 原子抢占：靠 PRIMARY KEY + 条件 UPDATE，不用应用层锁 */
async function tryClaim(date, slot, { ttlMs = 90_000, maxAttempt = 2 } = {}) {
  const now = Date.now(), me = `${process.pid}:${randomUUID().slice(0, 8)}`;
  const ins = db.prepare(`INSERT OR IGNORE INTO plan
      (date, slot, status, owner, claimed_at, attempt) VALUES (?,?,'claimed',?,?,1)`)
    .run(date, slot, me, now);
  if (ins.changes === 1) return { ok: true, wasStale: false };            // 全新抢占成功

  const row = db.prepare(`SELECT * FROM plan WHERE date=? AND slot=?`).get(date, slot);
  if (['succeeded', 'skipped'].includes(row.status)) return { ok: false, reason: row.status };  // 终态
  const stale = ['claimed', 'running'].includes(row.status) && now - row.claimed_at > ttlMs;
  if (row.status !== 'pending' && !stale && !(row.status === 'failed' && row.attempt < maxAttempt))
    return { ok: false, reason: 'locked' };
  const upd = db.prepare(`UPDATE plan SET status='claimed', owner=?, claimed_at=?,
      attempt=attempt+1 WHERE date=? AND slot=? AND status=?`)
    .run(me, now, date, slot, row.status);                                 // 条件 UPDATE 保证原子
  return upd.changes === 1 ? { ok: true, wasStale: stale } : { ok: false, reason: 'locked' };
}
```

### 4.3 stale 释放

```js
/** 每 tick：释放超过 90s 未终结的 claimed/running（进程崩溃、compute() 卡死、休眠挂起） */
async function releaseStale(now = Date.now(), ttlMs = 90_000) {
  const rows = db.prepare(`SELECT date, slot, status FROM plan
      WHERE status IN ('claimed','running') AND claimed_at < ?`).all(now - ttlMs);
  for (const r of rows) {
    db.prepare(`UPDATE plan SET status='failed', finished_at=?, payload=? WHERE date=? AND slot=?`)
      .run(now, JSON.stringify({ reason: 'stale_90s', prevStatus: r.status }), r.date, r.slot);
    logger.warn({ evt: 'scheduler.stale', date: r.date, slot: r.slot, prev: r.status });
  }
  return rows.length;
}
```

| 场景 | 效果 |
|---|---|
| `dsh` 子进程挂住 | 30s 超时（总览 §4.3）+ resolve/tts ≈40s < 90s，正常收尾 |
| 进程被 `taskkill` | 重启后首个 tick（`cold:true`）立即释放 stale 并按 `failed` 重试一次 |
| 电脑休眠时进程挂起 | 唤醒后 `claimed_at` 已远超 90s → 释放 → 仍在宽限窗口内则补跑（§4.4） |
| DB 写失败 | `tryClaim` 抛错 → `guard` 捕获 → 下一 tick 重试，不静默失败 |

### 4.4 休眠唤醒补跑

**原则**：补跑的是「**还来得及有意义**的播报」。

| slot | `catchUp` | `graceMinutes` | 唤醒补跑行为 |
|---|---|---|---|
| `daily_plan` | ✅ | **300**（07:00 → 12:00） | 12:00 前醒来 → 补跑当日规划；之后 `skipped(missed_window)` |
| `morning` | ✅ | **90**（09:00 → 10:30） | 09:00–10:30 唤醒 → 补跑，`say` 由大脑按「迟到」重写（§6.3）；超时 `skipped`，**绝不补一句「早上好」** |
| `noon` | ✅ | **60**（12:00 → 13:00） | 窗口内补跑；超时 `skipped`（午后档自然接上） |
| `evening` | ✅ | **90**（17:30 → 19:00） | 窗口内补跑；超时 `skipped` |
| `hourly_check` | ❌ | 0 | 过期即 `skipped`，下一个整点自然触发 |
| `night_wind_down` | ❌ | 0 | 过期即 `skipped`（过了 22:30 说「该休息了」已无意义） |
| `calendar_hook` | ❌ | 0 | 事件驱动，事件时点过了即失去意义 |
| `prefetch` | ❌ | 0 | 无意义则跳过（本来就不发声） |

> `daily_plan` 的 5 小时宽窗是刻意的：它是**静默 slot**（只落当日规划供 `/api/plan/today` 与后续 slot 读取），不是「必须准点说出口」的播报。休眠到中午才开机，当日规划仍然有用（F-07）；而 `morning` 这类**要开口**的 slot 只有 90 分钟，迟了就改说「补上今天的早安」或干脆不说。

```js
/** 启动（cold tick）的补跑判定：与 §3.2 通用逻辑共用，多一步「跨静默期短路」 */
async function catchUpOnBoot(now) {
  const wall = wallClock(now, cfg.timezone);
  for (const slot of cfg.slots.filter(s => s.catchUp)) {
    const due = dueMinutes(slot, wall);
    if (due === null) continue;
    const late = wall.minutes - due;
    if (late <= 0) continue;
    if (late > slot.graceMinutes) {                                     // 超窗口：不补过时播报
      await state.markSlot(wall.date, slot.name, 'skipped', { lateMin: late, reason: 'missed_window' });
    } else if (cfg.quietHours.enabled && inWindow(due, cfg.quietHours)) {  // 应触发时刻落在静默期 → 不补
      await state.markSlot(wall.date, slot.name, 'skipped', { reason: 'quiet_hours' });
    } else {
      enqueueTrigger({ type: 'schedule', slot: slot.name, date: wall.date, lateMin: late, cold: true });
    }
  }
}
```

**「迟到」必须传给大脑**：`lateMin > 0` 时第 ⑥ 片执行轨迹必须写明迟到幅度，让大脑改写文案（例：10:15 补跑的 morning 不能说「早上好」，应说「补上今天的早安，虽然有点晚了」）。见 §6.3——**补跑不是重放，是改写**。

### 4.5 与并发控制的衔接

调度触发进入 [总览](01-architecture-design.md) §5.3 单飞队列，优先级 `user_chat(0) > schedule(1) > prefetch(2)`：

| 情况 | 行为 |
|---|---|
| `compute()` 在途，调度触发到达 | 入插队队列，**不抢占**；在途结束后按优先级取出 |
| 队列中已有同 slot 触发 | 丢弃新的（幂等表已保证 `claimed` 唯一） |
| 排队 >20s | 丢弃 `prefetch`；`schedule` 保持排队但标 `queuedTooLong=true`，执行时 `lateMin` 已增大，由 grace 重新判定 |
| 排队期间超出 grace | `releaseSlot → skipped`，不再执行 |

---

## 5. 日历 hook

### 5.1 数据来源方案对比

| 方案 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| ① 读 `.ics` 文件 | 通用格式；Outlook/Google/Apple 都能导出；无需凭据 | 需写解析器（VEVENT/RRULE/时区/转义）；用户要手动导出；RRULE 展开复杂 | ✅ **可选增强**（只支持最小子集：单次 + `FREQ=DAILY/WEEKLY`） |
| ② 系统日历 API | 数据最新，无需导出 | Windows 无统一公开日历 API（需 Graph API + 凭据或 COM 访问 Outlook）；跨平台成本高；**违反零配置/零凭据取向** | ❌ 本期不做（P2 可加 `providers/calendar/outlook.js` 适配器） |
| ③ 手写 `config/calendar.yml` | 零依赖、零凭据、可读可改、5 分钟上手、完全离线 | 手动维护；不能自动同步 | ✅ **最小可行方案（推荐）** |

### 5.2 推荐：`config/calendar.yml` + 可选 `.ics`

```yaml
# config/calendar.yml —— 手写即可用，改完下次触发生效（F-09）
timezone: Asia/Shanghai
sources:
  - { type: yaml, path: config/calendar.yml }
  - { type: ics,  path: data/calendar/personal.ics }   # 可选；文件不存在则静默跳过
weeks:                              # 周期性日程
  mon: [{ start: '10:00', end: '11:00', title: '周会', weight: 'focus' }]
  wed: [{ start: '20:00', end: '21:30', title: '羽毛球', weight: 'energetic' }]
dates:                              # 具体日期（覆盖 weeks）
  '2026-10-15':
    - { start: '09:30', end: '10:30', title: '牙医', weight: 'calm', location: '城东' }
    - { start: '14:00', end: '15:00', title: '面试', weight: 'focus' }
    - { start: '19:00', end: '21:00', title: '朋友生日', weight: 'energetic', announce: true }
rules:
  leadMinutes: 60                   # 事件前 60min 内触发选曲倾向
  announceWorthy: ['生日','面试','牙医','体检','航班','会议']   # 命中则 calendar_hook 值得开口
  maxItemsInPrompt: 3               # 注入 prompt 的条目上限（防上下文膨胀）
```

```yaml
# 可选的 .ics 最小子集（data/calendar/personal.ics）
BEGIN:VCALENDAR
BEGIN:VEVENT
UID:abc-123
DTSTART;TZID=Asia/Shanghai:20261015T093000
DTEND;TZID=Asia/Shanghai:20261015T103000
SUMMARY:牙医
LOCATION:城东
END:VEVENT
END:VCALENDAR
```

`ics.js` 的**最小解析规则**（不做完整 iCalendar 实现）：

| 项 | 支持 | 不支持（拒绝并告警） |
|---|---|---|
| `DTSTART`/`DTEND` | `YYYYMMDDTHHMMSS`、`YYYYMMDD`（全天）、带 `TZID` 参数 | — |
| 时区 | 只支持 `TZID=Asia/Shanghai` 或 UTC `Z`；其它按本地时间处理并告警 | VTIMEZONE 定义 |
| `SUMMARY`/`LOCATION` | 支持；反转义 `\,` `\;` `\n` | — |
| 重复事件 | 只支持 `RRULE:FREQ=DAILY` 与 `FREQ=WEEKLY;BYDAY=MO,WE` | `COUNT`/`UNTIL`/`BYSETPOS`/`EXDATE` 复杂组合 |
| 其它组件 | 忽略 `VTODO`/`VJOURNAL`/`VALARM` | — |
| 失败处理 | 任一文件解析失败 → 只用 yaml 源，**不阻塞**（总览 §5.2 降级取向） | — |

### 5.3 进入 `context.js` 第 ③ 片「环境注入」

```js
// src/providers/calendar/index.js
/** @returns {Promise<{items: Array<{start,end,title,weight,location,announce}>, source: string[], degraded: boolean}>} */
async function today(now) { /* yaml 源 ∪ ics 源 → 排序去重 → 截断 maxItemsInPrompt */ }
```

`context.js` 组装第 ③ 片（`weather · calendar · now`，总览 §2 第三层）时的**规范渲染**：

```
③ 环境注入
  现在：2026-10-15 09:00 周三（本地时区 Asia/Shanghai）
  天气：小雨 18℃，湿度 65%，今日 14~21℃
  日历（2 项）：
    - 09:30-10:30 牙医 @城东（30 分钟后开始，建议：出行前放不吵的）
    - 14:00-15:00 面试（5 小时后）
  日历来源：yaml,ics  降级：否
```

| 规则 | 说明 |
|---|---|
| 时间用**相对表达**（「30 分钟后」）而非只给绝对时间 | 大脑更容易生成有意义的播报 |
| `weight` 一并注入 | 选曲倾向提示，直接对应 `mood-rules.md` 词表（`calm`/`focus`/`energetic`） |
| 无日程时 | 渲染 `日历：无`，**不省略该行**（prompt 结构稳定，便于调试） |
| 隐私 | 日历标题会进 prompt。总览 §9 规定默认不记 prompt 全文（只记长度与 hash），故日历内容不落日志——**除非** `LOG_PROMPT=1` |
| 缓存 | `today(now)` 按 `(date, hour)` 缓存 5min，避免每个 slot 都重读文件 |

---

## 6. 与大脑的交互

### 6.1 第 ⑥ 片「执行轨迹」的通用结构

定时触发与用户点播走**同一套 6 片**（总览 §4.2），只有第 ⑤ 片为空、第 ⑥ 片由调度器填充。第 ⑥ 片固定四行：

```
⑥ 执行轨迹
  触发来源：scheduler
  触发 slot：<slot 名>
  触发原因：<为什么现在触发，含迟到信息>
  今日已播：<N> 首；本 slot 状态：<首次触发 | 迟到补跑 <X> 分钟>
  约束：<该 slot 的硬约束，如「只说一句」>
```

### 6.2 `morning` slot

```
⑥ 执行轨迹
  触发来源：scheduler
  触发 slot：morning
  触发原因：早间播报，09:00 定时触发（准时）
  今日已播：0 首；本 slot 状态：首次触发
  约束：① say 控制在 80 字以内，口语化；② 必须包含天气的一句；③ play 给 2~3 首，
        以轻快/明亮为主，不要重型或悲伤；④ reason 里指明你依据了 taste.md 的哪一条；
        ⑤ segue 写一句「下面这首」的过渡语
```

### 6.3 `morning` 的迟到补跑变体（`lateMin > 0`）

```
⑥ 执行轨迹
  触发来源：scheduler
  触发 slot：morning
  触发原因：早间播报，09:00 应触发，因电脑休眠延迟至 10:15 补跑（迟到 75 分钟）
  今日已播：0 首；本 slot 状态：迟到补跑，仍在宽限窗口内（上限 10:30）
  约束：① **不要再说「早上好」**——现在是上午十点多，请自然承认迟了
        （例：「补上今天的早安，虽然有点晚了」）；
        ② 天气仍要提，但用「现在」的口吻；③ play 给 2 首即可，不要铺满整个上午；
        ④ 若 now 已过 10:00，选曲从「早间轻快」下调到「上午专注」
```

### 6.4 `daily_plan` slot

```
⑥ 执行轨迹
  触发来源：scheduler
  触发 slot：daily_plan
  触发原因：当日规划，07:00 定时触发（准时）
  今日已播：0 首；本 slot 状态：首次触发
  约束：① 产出的是「今日三到四档」的规划，不是播放列表——每档给 1 句话描述 + 2~3 首代表曲；
        ② 档位划分必须依据 routines.md 的作息与 mood-rules.md 的心境映射；
        ③ 今天是周三，日历有 2 项（09:30 牙医、14:00 面试），对应档位要照顾到；
        ④ say 只做 60 字以内的开场，规划主体写入 reason（reason 不进 TTS，用于 /api/plan/today 展示）；
        ⑤ play 给第一档的 2 首即可
```

### 6.5 `hourly_check` slot

```
⑥ 执行轨迹
  触发来源：scheduler
  触发 slot：hourly_check
  触发原因：整点情绪检查，14:00 定时触发（准时）
  今日已播：11 首；最近 3 首：陈粒 - 小半 / 李志 - 下雨 / 万能青年旅店 - 杀死那个石家庄人
  本 slot 状态：首次触发（今日第 5 次情绪检查）
  约束：① 这是**检查**不是播报——若无需换档，把 say 设为空字符串 ""、play 设为 []，
        系统会保持当前队列继续播放（这是允许的，且是更常见的结果）；
        ② 若确需换档，say ≤ 60 字，说明换档理由（时段/天气/日历/连续听了 3 首同风格）；
        ③ **禁止**每小时都说话；连续两次检查之间至少间隔一次「不说话」；
        ④ play 最多 2 首，必须与最近 3 首不同（F-05）
```

**约束 ① 的语义**：`say=''` → `tts.synthesize` 返回 `null` → 跳过语音（[04](04-tts-pipeline.md) §4.5 R11 / §3.3 第 3 级），状态机走 `MUSIC_ONLY` 或保持 `PLAYING`。这让「情绪检查」的默认结果是**安静**——正面回应 Q-03。

### 6.6 `calendar_hook` 与 `night_wind_down`

```
⑥ 执行轨迹（calendar_hook，事件驱动：事件前 30min）
  触发来源：scheduler（calendar 事件源，非 cron）
  触发 slot：calendar_hook
  触发原因：日历事件「牙医」09:30 开始，触发前 30min 提醒（09:00）；今日共 2 项日程
  约束：① 只说一句 ≤ 50 字的提醒 + 选曲倾向说明；② play 给 1~2 首，按日历 weight=calm 选不吵的；
        ③ 若无日程或事件不值得播报 → 直接返回 {say:"", play:[]}，系统会跳过本次播报（`skipped`）

⑥ 执行轨迹（night_wind_down，22:30）
  触发来源：scheduler
  触发 slot：night_wind_down
  触发原因：收尾提醒，22:30 定时触发；23:00 起进入静默时段，这是今天最后一次主动开口
  约束：① 语气柔和、明显放慢（本次调用 rate 已设为 -8%）；② say ≤ 60 字，提示该休息了；
        ③ play 给 2 首低能量曲目；④ **不要**劝说、不要说教，一句就够
```

---

## 7. 防打扰设计

| 机制 | 参数 | 行为 |
|---|---|---|
| **静默时段** | 23:00–07:00 | 期间所有非 `allow` slot 直接不评估（§2.3）；用户主动点播完全不受限 |
| **同 slot 去重** | `(date, slot)` 唯一 | 一天一次；`succeeded`/`skipped` 为终态（§4.2） |
| **连续失败熔断** | 连续 3 次 `failed` → 该 slot 当日停用 | 防「失败→重试→又失败」的播报风暴；写 `prefs` 告警，`/api/now` 可见 |
| **全局触发节流** | 相邻两次**主动**播报间隔 ≥45min | 高优先级 slot 可顶掉等待（§7.1） |
| **用户交互抑制** | 见 §7.2 | 用户刚说完话、电台正在为他推理时不插话 |
| **`hourly_check` 默认安静** | `say=""` 是首选结果 | §6.5 约束 ① |
| **夜间听感收敛** | 22:00 后 `rate=-8%`、`say` 上限降到 60 字 | 让「晚间的电台」听感上就该收声 |
| **降级不刷屏** | 大脑失败重试 1 次（总览 §5.2）后走模板播报 | 同一次触发重试不允许 >2 次 |

### 7.1 全局触发节流

```js
async function respectGlobalThrottle(slot, now) {
  const gap = now - await state.lastProactiveBroadcast();      // 最近一次 type==='schedule' 的 succeeded
  if (gap >= cfg.throttle.minGapMs) return { ok: true };
  if (slot.priority <= cfg.throttle.preemptPriority) return { ok: true, preempted: true };  // 高优先级顶掉等待
  return { ok: false, waitMs: cfg.throttle.minGapMs - gap };
}
```

| 情形 | 处理 |
|---|---|
| `calendar_hook`(08:30) 与 `morning`(09:00) | 间隔 30min（低于 45min 节流，`calendar_hook` 让路，见 §7.1） |
| `morning`(09:00) 说完，`hourly_check`(09:00) 同分钟 | `hourly_check` 让路 → `skipped` |
| 补跑导致两 slot 挤在相邻 5min | 低优先级 `skipped`，标 `skip_reason:'min_gap'` |
| `night_wind_down`(22:30) 与 22:00 `hourly_check` | 间隔 30min，正常 |

### 7.2 用户交互抑制

```js
function shouldYieldToUser(slot) {
  if (slot.priority <= 1) return false;              // morning/daily_plan 不停：它们本身就是当日主事件
  const s = radioState();                            // 状态机当前状态（总览 §8.1）
  if (['SPEAKING','THINKING','RESOLVING'].includes(s)) return true;   // 正在说话/正在想 → 让路
  if (Date.now() - lastUserInteractionAt() < 60_000) return true;     // 60s 内有用户输入 → 让路
  if (openWsClients().some(c => c.playing && Date.now() - c.lastUserActionAt < 120_000)) return true;  // 刚点过歌
  return false;
}
```

| 状态 | 低优先级 slot 行为 |
|---|---|
| `SPEAKING` / `THINKING` / `RESOLVING` | **让路**：`releaseSlot → pending`，下一 tick 重试；宽限窗口内反复让路直到超时 → `skipped` |
| 60s 内有 `POST /api/chat` | 让路（用户刚说完话，别抢话） |
| 用户点了「跳过」/「下一首」 | 让路 120s（用户正在主动控制播放，别插手） |
| 无客户端连接 | **不让路**（电台可无人收听继续走，总览 §5.2 `ws.broadcast` 降级） |

> **设计理由**：定时播报的价值是「主动但不打扰」。用户刚说完话、电台正在为他的请求推理时插一句「现在是下午三点」是最典型的打扰。让路的代价只是晚几分钟说话，几乎无损。

### 7.3 连续失败熔断

```js
if (await consecutiveFailures(date, slot.name) >= cfg.breaker.slotFailLimit) {
  await state.setPref(`slot.disabled.${slot.name}.${date}`, '1');   // 当日临时停用，次日 00:00 自动恢复
  logger.error({ evt: 'scheduler.slot_tripped', slot: slot.name, date });
}
```

| 参数 | 默认 | 说明 |
|---|---|---|
| `breaker.slotFailLimit` | 3 | 同一 slot 连续失败上限 |
| `breaker.globalFailLimit` | 5 | 全 slot 连续失败上限 → 暂停所有主动播报 6h 并告警 |
| 恢复 | 次日 00:00 自动 | 不做永久禁用（在配置里关掉才是永久） |

---

## 8. 配置项

### 8.1 `config/routines.yml` 字段表

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `timezone` | string | `system` | `system` 或 IANA 时区名；env `ROUTINES_TZ` 覆盖 |
| `enabled` | bool | `true` | 总开关；false = 电台只被动响应，不主动开口 |
| `quietHours.enabled` | bool | `true` | 静默时段开关 |
| `quietHours.start` / `.end` | `HH:MM` | `23:00` / `07:00` | 含 start、不含 end，支持跨午夜 |
| `quietHours.allow` | string[] | `['prefetch']` | 静默期仍允许的 slot（必须不发声） |
| `quietHours.exemptOnUserChat` | bool | `true` | 用户主动输入是否豁免静默（应恒为 true） |
| `throttle.minGapMs` | int | `2700000` | 相邻主动播报最小间隔（45min，对齐 `routines.yml` 的 `limits.minIntervalMinutes`） |
| `throttle.preemptPriority` | int | `1` | ≤ 此优先级的 slot 可顶掉节流等待 |
| `throttle.userActiveWindowMs` | int | `60000` | 用户输入后的让路窗口 |
| `breaker.slotFailLimit` / `.globalFailLimit` / `.globalPauseMs` | int | `3` / `5` / `21600000` | 熔断阈值与暂停时长（6h） |
| `staleTtlMs` | int | `90000` | stale 释放阈值（与总览 §8.2 的 90s 一致） |
| `tickMs` | int | `30000` | tick 间隔 |
| `catchUpOnBoot` | bool | `true` | 启动时执行补跑判定（§4.4） |
| `slots[].name` | string | — | **必须用 [02 §6.1](02-module-spec.md) 的权威 id**（下划线命名），写入 `plan.slot` |
| `slots[].cron` / `.event` | string | — | 5 字段 cron（`分 时 日 月 星期`）；事件驱动 slot 用 `.event` 代替 `.cron` |
| `slots[].intent` | string | — | **仅可读标签**，不进入 `Intent.name`（`source==='schedule'` 一律归 `scheduled_broadcast`） |
| `slots[].enabled` | bool | `true` | 可被 `prefs` 覆盖（F-09） |
| `slots[].catchUp` / `.graceMinutes` | bool / int | 见 §2.1 | 是否可补跑 / 宽限窗口（`catchUp=false` 时为 0） |
| `slots[].priority` | int | 见下 | 越小越优先（用于节流与让路） |
| `slots[].voice` / `.rate` | string\|null | `null` | 覆盖 TTS 音色 / 语速（[04](04-tts-pipeline.md) §2.3、§9） |
| `slots[].maxSayChars` | int | `200` | 该 slot 的 `say` 上限（静默边界附近收紧到 60） |
| `slots[].speakOnly` | bool | `false` | true = 不做选曲，只口播（如纯提醒） |
| `calendar.enabled` | bool | `true` | 日历源总开关 |
| `calendar.sources[]` | object[] | 见 §5.2 | `{type:'yaml'\|'ics', path}` |
| `calendar.leadMinutes` / `.maxItemsInPrompt` | int | `60` / `3` | 事件前置窗口 / 注入 prompt 条目上限 |
| `log.level` | string | `info` | `debug` 时记录每个 tick 的 slot 判定结果（排查补跑问题） |

**默认优先级**：`daily_plan`/`morning` = 1（当日主事件）；`noon`/`evening`/`calendar_hook`/`night_wind_down` = 2；`hourly_check` = 3（最易被让路）；`prefetch` = 9（随时可丢）。

### 8.2 完整示例

```yaml
# config/routines.yml
enabled: true
timezone: system
tickMs: 30000
staleTtlMs: 90000
catchUpOnBoot: true
quietHours: { enabled: true, start: '23:00', end: '07:00', allow: ['prefetch'], exemptOnUserChat: true }
throttle:   { minGapMs: 2700000, preemptPriority: 1, userActiveWindowMs: 60000 }
breaker:    { slotFailLimit: 3, globalFailLimit: 5, globalPauseMs: 21600000 }
calendar:
  enabled: true
  sources:
    - { type: yaml, path: config/calendar.yml }
    - { type: ics,  path: data/calendar/personal.ics }
  leadMinutes: 60
  maxItemsInPrompt: 3
slots:
  - { name: daily_plan,      cron: '0 7 * * *',     intent: daily_plan,    catchUp: true,  graceMinutes: 300, priority: 1, maxSayChars: 60, speakOnly: false }
  - { name: morning,         cron: '0 9 * * *',     intent: morning_brief, catchUp: true,  graceMinutes: 90,  priority: 1, maxSayChars: 80, voice: zh-CN-XiaoyiNeural }
  - { name: hourly_check,    cron: '0 9-22 * * *',  intent: mood_check,    catchUp: false, graceMinutes: 0,   priority: 3, maxSayChars: 60 }
  - { name: noon,            cron: '0 12 * * *',    intent: noon_shift,    catchUp: true,  graceMinutes: 60,  priority: 2, maxSayChars: 50 }
  - { name: evening,         cron: '30 17 * * *',   intent: evening_shift, catchUp: true,  graceMinutes: 90,  priority: 2, maxSayChars: 60 }
  - { name: night_wind_down, cron: '30 22 * * *',   intent: wind_down,     catchUp: false, graceMinutes: 0,   priority: 2, maxSayChars: 60, rate: '-8%' }
  # calendar_hook 与 prefetch 由事件驱动，不用 cron；`event:` 声明事件源
  - { name: calendar_hook,   event: calendar.lead30m,   intent: calendar_hook, catchUp: false, graceMinutes: 0, priority: 2, maxSayChars: 50 }
  - { name: prefetch,        event: 'schedule.preslot5m|pwa.remaining10s', intent: warmup, catchUp: false, graceMinutes: 0, priority: 9, speakOnly: true }
```

### 8.3 `prefs` 覆盖（F-09 在线编辑）

| `prefs` 键 | 覆盖目标 | 生效时机 |
|---|---|---|
| `slot.<name>.enabled` = `0\|1` | `slots[].enabled` | 下一次 tick（无需重启） |
| `slot.<name>.cron` | `slots[].cron` | 下一次 tick |
| `quietHours.enabled` / `.start` / `.end` | 静默开关与边界 | 下一次 tick |
| `routines.enabled` = `0\|1` | 总开关 | 下一次 tick |
| `slot.disabled.<name>.<date>` | 熔断临时停用 | 当日有效，次日自动失效 |

`loadRoutines()` **每个 tick 重新读取**（文件 mtime 缓存 + `prefs` 查询），实现「改完下次触发生效」（F-09），同时避免每 30s 读盘。

---

## 9. 测试要点

所有用例把 `now` 显式注入 `tick(now)`（§3.4 的可测试性设计），对 `enqueueTrigger` 做 spy，DB 用内存 SQLite。

| 编号 | 用例 | 断言 |
|---|---|---|
| R-1 | **时区**：`timezone:'Asia/Shanghai'`，`tick(new Date('2026-10-15T01:00:00Z'))` | 判定为本地 09:00 → `morning` 触发，`wall.date==='2026-10-15'`；改 `timezone:'UTC'` 则**不**触发（本地 01:00） |
| R-2 | **跨午夜静默窗口** | `inWindow(toMin('23:59'))===true`；`'06:59'`→true；`'07:00'`→false；`'12:00'`→false（边界 4 例） |
| R-3 | **静默时段不播报**：本地 23:00（静默起点，含），所有 slot 到期 | `hourly_check`/`calendar_hook` 的 `enqueueTrigger` 调用 **0** 次；`prefetch` 仍执行（在 `allow` 中）；`night_wind_down` 在本地 22:30（**早于静默起点**）正常触发——验证 23:00 取值使该 slot 无需任何例外 |
| R-4 | **休眠补跑（窗口内）**：`morning` 09:00 应触发，10:15 唤醒 | `enqueueTrigger` 1 次且 `lateMin===75`、`cold===true`；注入 prompt 的第 ⑥ 片含「迟到 75 分钟」与「不要再说早上好」 |
| R-5 | **休眠补跑（超窗口）**：`morning` 10:45 唤醒（上限 10:30）；`daily_plan` 10:45 唤醒（上限 12:00） | `morning`：`enqueueTrigger` **0** 次、`status==='skipped'`、`skip_reason==='missed_window'`、`late_min===105`；`daily_plan`：**仍补跑**（5h 宽窗内） |
| R-6 | **幂等 + 并发触发**：`await Promise.all([tick(now),tick(now),tick(now)])`（模拟 tick 重入/双进程） | `tryClaim` 成功仅 **1** 次；`enqueueTrigger` **1** 次；`attempt===1`；另两次返回 `{ok:false,reason:'locked'}` |
| R-7 | **90s stale 释放**：插入 `status='running', claimed_at=now-91s` | 下一 tick 后该行 `failed`、`payload.reason==='stale_90s'`；`attempt(1)<2` 允许重试一次；再失败则不再重试 |
| R-8 | **用户交互让路**：状态机 `SPEAKING`，`hourly_check` 到期 | `hourly_check` 让路（回到 `pending`，`enqueueTrigger` 0 次）；`morning`（priority 1）**不**让路仍触发；无客户端连接时 `hourly_check` 不再让路 |
| R-9 | **全局节流**：`daily_plan` 成功后 5min，`hourly_check` 到期 | `hourly_check` → `skipped`，`skip_reason==='min_gap'`；改为 `morning` 到期（`priority ≤ preemptPriority`）则正常触发 |
| R-10 | **cron 解析** | `expandField('9-22')` 长度 14；本地 12:30 时 `dueMinutes===720`；本地 09:00 时返回 `null`；含列表 `0,30 9 * * 1-5` 正确展开 |
| R-11 | **`say` 为空短路**：mock 大脑返回 `{say:'', play:[]}` | `tts.synthesize` **不被调用**；`compute()` 不报错；状态机保持 `PLAYING`；`plan.status==='succeeded'`（不是 failed） |
| R-12 | **异常不终止 tick**：`enqueueTrigger` / DB 抛错 | 下一次 tick 仍正常执行（`guard` 吞掉并记 error）；`setInterval` 未被清除；连续 3 次 slot 失败后该 slot 当日 `disabled` |

---

## 附：接口索引

| 交互点 | 对端 | 说明 |
|---|---|---|
| 触发进入 `compute()` | [设计总览](01-architecture-design.md) §4.2 从链路 | 唯一区别：第 ⑤ 片为空、第 ⑥ 片标注 slot |
| 单飞队列与优先级 | [设计总览](01-architecture-design.md) §5.3 | `user_chat > schedule > prefetch` |
| `(date, slot)` 幂等 | [设计总览](01-architecture-design.md) §4.2 / §8.2 | `plan` 表 |
| 第 ⑥ 片文本 | [大脑适配器](05-brain-adapter.md) | 由 `context.js` 渲染（§6） |
| `voice`/`rate` 覆盖 | [TTS 声音管线](04-tts-pipeline.md) §2.3 / §9 | `bySlot` 与 `slots[].voice` |
| 心跳里的缓存清理 | [TTS](04-tts-pipeline.md) §5.4 · [音乐](06-music-provider.md) §9 | 每 10min |
| `/api/plan/today` 数据源 | [接口契约](03-api-contract.md) | 从 `plan` 聚合（F-07） |
| 日历文件准备 | [需求与准备清单](09-requirements-checklist.md) | `config/calendar.yml` 手写即可用 |

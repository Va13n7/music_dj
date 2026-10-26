# Claudiao 个人音乐电台 · 设计总览

> 文档版本 v1.0 · 状态：设计完成，待实现
> 上游依据：施工图 `docs/assets/blueprint-original.jpg`
> 关联文档：[模块详细设计](02-module-spec.md) · [接口契约](03-api-contract.md) · [大脑适配器](05-brain-adapter.md)

---

## 1. 需求

### 1.1 一句话目标

在**本机**持续运行一台私人电台，它能按你的作息主动开口播报、按你的品味选曲、用你自己的音色说话，并通过浏览器（含手机）随时收听和点播。

### 1.2 功能需求

| 编号 | 需求 | 验收标准 | 优先级 |
|---|---|---|---|
| F-01 | 自然语言点播 | 在 PWA 输入「来点适合下雨天的歌」，10s 内开始播放匹配曲目，并有一句播报 | P0 |
| F-02 | 定时主动播报 | 按 `routines.md` 在 07:00 生成当日规划、09:00 早间播报、整点情绪检查，误差 ≤ 60s | P0 |
| F-03 | 品味一致性 | 连续 20 首推荐中，符合 `taste.md` 与 `mood-rules.md` 的比例 ≥ 80% | P0 |
| F-04 | 语音播报 | 播报走本地 TTS，与音乐衔接无重叠、无空档（gap ≤ 800ms 可感知阈值） | P0 |
| F-05 | 记忆连续性 | 大脑记得最近播过什么，24h 内不重复同一曲目（除非明确要求） | P0 |
| F-06 | now-playing 推送 | 播放状态变化 500ms 内推送到所有已连接客户端 | P0 |
| F-07 | 每日规划可读 | `/api/plan/today` 返回当日时段规划，含每档选曲理由 | P1 |
| F-08 | 跳过与反馈 | 跳过记入 `plays` 并影响后续选曲权重 | P1 |
| F-09 | 品味在线编辑 | Profile 视图可编辑语料文件，下一次触发生效，无需重启 | P1 |
| F-10 | 离线可用 | 断外网时：TTS 与已有缓存曲目仍可播，PWA 可打开 | P2 |
| F-11 | 客厅投送 | 音频可投送到 UPnP/DLNA 或 Chromecast 设备 | P2 |

### 1.3 非功能需求

| 编号 | 需求 | 指标 |
|---|---|---|
| N-01 | 单次决策延迟 | 大脑冷启动 ≤ 15s，热路径 ≤ 8s（实测 `dsh` 单轮 ~5.5s） |
| N-02 | TTS 合成延迟 | 缓存命中 < 50ms；未命中本地合成 ≤ 3s/百字 |
| N-03 | 常驻内存 | 服务进程 ≤ 300MB |
| N-04 | 成本 | 运行期零边际成本（本地大脑 + 本地 TTS） |
| N-05 | 隐私 | 语料、播放历史、音频不出本机；仅音乐元数据查询出网 |
| N-06 | 可恢复 | 进程崩溃后重启，状态不丢（SQLite 持久化） |
| N-07 | 可替换 | 大脑/TTS/音乐三个外部依赖均可通过适配器替换，不改业务层 |

### 1.4 明确不做（本期）

- ❌ 多用户、账号体系、社交分享
- ❌ 音乐文件下载与本地曲库管理（本期只做流式播放）
- ❌ 版权内容的破解、去 DRM、绕过付费墙
- ❌ 移动原生 App（只做 PWA）
- ❌ 语音唤醒词离线识别（ASR 属 P2 延伸）

---

## 2. 施工图还原

施工图定义了四层，本设计**逐格还原**，并标注每格在本项目中的落地形态。

### 第一层 · 外部上下文

| 施工图格子 | 内容 | 本项目落地 |
|---|---|---|
| `USER/` 用户品味语料 | `taste.md` `routines.md` `playlists.json` `mood-rules.md` | `knowledge/user/` 四文件（已创建） |
| `BRAIN` 大脑 | 「子进程调用 · 用 Max 订阅无需 API key」`claude -p` `--output-json` | `knowledge/prompts/dj-persona.md` + `dsh --profile dj-brain --json`（见 [05](05-brain-adapter.md)） |
| `MUSIC` | `NeteaseCloudMusicApi`：`search` `song_url` `lyric` `recommend` | `src/providers/music/` 多适配器（见 [06](06-music-provider.md)） |
| `VOICE · I/O` | `Fish` `Feishu` `Weather` `UPnP` | `edge-tts`+`SAPI`、Webhook、天气提供方、DLNA（P2） |

### 第二层 · 本地大脑

| 施工图格子 | 职责（原文） | 本项目落地 |
|---|---|---|
| `ROUTER.JS` | 意图分流：简单指令直连 · 音乐走 ncm · 自然语言走 claude | `src/layer2/router.js` |
| `CONTEXT.JS` | 提示词组装：`taste + routines + 环境 + 历史 → system prompt` | `src/layer2/context.js` |
| `CLAUDE.JS` | 大脑适配器：`spawn 子进程 · 解析 {say, play[], reason, segue}` | `src/layer2/brain.js` + `src/adapters/brain/dsh-headless.js` |
| `SCHEDULER.JS` | 节律调度：`07:00 规划 · 09:00 早间 · 小时情绪检查 · 日历 hook` | `src/layer2/scheduler.js` |
| `TTS.JS` | 声音管线：`Fish Audio → cache/tts/*.mp3 → /tts/<hash>.mp3` | `src/layer2/tts.js` |
| `STATE.DB` | 状态·记忆：`messages · plays · plan · prefs` 跨重启持久 | `src/layer2/state.js` + SQLite |

### 第三层 · 运行时粘合（CONTEXT BINDOW）

施工图定义「每次触发按这 6 片粘成 prompt」，本项目**严格实现这 6 片**：

| 片 | 施工图名称 | 来源 | 注入位置 |
|---|---|---|---|
| ① | 系统提示词 `prompts/dj-persona.md` | `knowledge/prompts/dj-persona.md` | system |
| ② | 用户语料 `user/*.md` | `knowledge/user/{taste,routines,mood-rules}.md`、`playlists.json` 摘要 | system |
| ③ | 环境注入 `weather · calendar · now` | 天气 API + 本地日历 + 系统时钟 | system |
| ④ | 已检索记忆 `state.db · plays` | 最近 N 次 plays、最近 M 条 messages、当日 plan | user |
| ⑤ | 用户输入 / 工具结果 `/api/chat · ncm search` | 路由结果 + 音乐检索候选 | user |
| ⑥ | 执行轨迹 `scheduler · webhook` | 触发来源与触发原因 | user |

施工图底部的 `MODEL · 前向过程`：

```
compute(fragments) → {say, play[], reason, segue}
  → ncm 解析 queue
  → tts 合成 say
  → WS 推 now-playing
```

对应本项目的 `compute()` 编排（见 §5.2）。**注意**：本项目的 `compute()` 返回值额外支持 `segue` 字段（施工图已画出），用于「这首歌之后接什么」的过渡语——这是像 DJ 而非像播放器的关键。

### 第四层 · 交互表层

| 施工图格子 | 内容 | 本项目落地 |
|---|---|---|
| `PWA/ · LOCALHOST:8080` | Player/Profile/Settings 三视图 · 单 `<audio>` · WS 流式聊天 · sw 缓存壳层 · prefetch 10s | `web/`（见 [08](08-pwa-frontend.md)） |
| `HTTP CONTRACT` 6 条线 | `POST /api/chat` `GET /api/now` `GET /api/next` `GET /api/taste` `GET /api/plan/today` `WS /stream` | 见 [03](03-api-contract.md) |

---

## 3. 架构

### 3.1 部署视图

```
                    ┌─────────────────────────────┐
   手机浏览器 ──────▶│  Node 服务进程 (localhost:8080)│
   桌面浏览器 ──────▶│                             │
                    │  ┌───────────┐  ┌─────────┐ │
   客厅音箱 ◀────────│  │ HTTP + WS │  │ ROUTER  │ │
   (UPnP, P2)       │  └─────┬─────┘  └────┬────┘ │
                    │        │             │      │
                    │  ┌─────▼─────────────▼────┐ │
                    │  │      compute() 编排     │ │
                    │  └──┬────────┬────────┬───┘ │
                    │     │        │        │     │
                    │ ┌───▼──┐ ┌───▼───┐ ┌──▼───┐ │
                    │ │CONTEXT│ │ BRAIN │ │TTS   │ │
                    │ │ 组装  │ │适配器 │ │管线  │ │
                    │ └───┬──┘ └───┬───┘ └──┬───┘ │
                    │     │        │        │     │
                    │ ┌───▼────────▼────────▼───┐ │
                    │ │  STATE (SQLite) + 缓存   │ │
                    │ └──────────────────────────┘ │
                    └───┬──────────────┬───────────┘
                        │              │
                 ┌──────▼─────┐  ┌─────▼──────────────┐
                 │ dsh 子进程  │  │ 音乐 API / 天气 API │
                 │ dj-brain   │  │ （出网，可降级）     │
                 └────────────┘  └────────────────────┘
                        ▲
                 ┌──────┴───────┐
                 │ SCHEDULER    │  07:00 / 09:00 / 整点
                 │ 定时器 + 日历 │
                 └──────────────┘
```

**关键设计原则：一切出网依赖都必须可降级。** 音乐 API 挂了用缓存歌单，天气 API 挂了用「今天」的兜底文案，大脑超时用预设播报模板。电台的核心体验是「一直在响」。

### 3.2 模块职责矩阵

| 模块 | 文件 | 输入 | 输出 | 状态 | 同步性 |
|---|---|---|---|---|---|
| 路由 | `src/layer2/router.js` | 用户文本 / 触发事件 | `Intent` | 无 | 同步 |
| 上下文组装 | `src/layer2/context.js` | `Intent` | `PromptFragments` → prompt 文本 | 只读 | 同步 |
| 大脑适配器 | `src/layer2/brain.js` | prompt 文本 | `DjAction` | 会话 id | 异步 |
| 声音管线 | `src/layer2/tts.js` | `say` 文本 | 音频文件 URL | TTS 缓存 | 异步 |
| 节律调度 | `src/layer2/scheduler.js` | 时钟 / 日历 | 触发事件 | 调度表 | 定时 |
| 状态·记忆 | `src/layer2/state.js` | 各类写操作 | 查询结果 | SQLite | 同步 |
| 音乐提供方 | `src/providers/music/` | 检索/解析请求 | 曲目 + 播放直链 | 短期缓存 | 异步 |

### 3.3 依赖方向（严格单向，禁止回环）

```
web/  ──HTTP/WS──▶  src/server.js
                        │
                        ▼
                   src/layer2/router.js
                        │
                        ▼
              src/layer2/context.js ──读取──▶ knowledge/  (只读语料)
                        │
                        ▼
              src/layer2/brain.js ──适配──▶ src/adapters/brain/*
                        │
                        ├──▶ src/layer2/tts.js ──适配──▶ src/adapters/tts/*
                        ├──▶ src/providers/music/*
                        └──▶ src/layer2/state.js ──▶ data/radio.db
```

`layer2` **不得**直接 `spawn` 进程或发 HTTP——必须经过 `adapters/` 与 `providers/`。这是保证「大脑/TTS/音乐可替换」的强制性约束，由 lint 规则与 code review 共同保障。

---

## 4. 数据流

### 4.1 主链路：一次自然语言点播

```
① 用户在 PWA 输入「下雨了，来点安静的」
        │  POST /api/chat {text}
        ▼
② server.js 落一条 messages 记录（role=user）
        │
        ▼
③ router.classify(text)
        │  命中「下雨」「安静」→ intent=mood_request, mood=calm, need_brain=true
        ▼
④ context.build(intent)
        │  ① dj-persona.md
        │  ② taste.md + routines.md + mood-rules.md + playlists.json
        │  ③ now=2026-10-15T21:30+08:00, weather=小雨 18℃, calendar=空
        │  ④ 最近 10 条 plays + 最近 6 条 messages + 今日 plan
        │  ⑤ 用户原文
        │  ⑥ trigger=user_chat
        ▼
⑤ brain.compute(prompt, {sessionId})
        │  spawn: dsh --profile dj-brain --json --session-id <sid>
        │  stdin ← prompt
        │  stdout → NDJSON 事件流，取 final
        ▼
⑥ 解析 → DjAction（见 §6.1）
        │  {say, play[], reason, segue}
        ▼
⑦ music.resolve(play[])
        │  对每个候选：在已解析缓存里查 → 未命中则调 API 拿直链
        │  过滤掉解析失败的，保底 ≥1 首
        ▼
⑧ tts.synthesize(say)
        │  cache key = sha1(voice|rate|pitch|text)[:16]
        │  命中 → 直接返回 /tts/<hash>.mp3
        │  未命中 → edge-tts 合成 → 落盘 → 返回
        ▼
⑨ state.record({messages, plays, plan?})
        │
        ▼
⑩ ws.broadcast({type:'now-playing', ...})
        │
        ▼
⑪ PWA 收到 → 先播 say 音频 → 播放结束 → 无缝切第一首 play
```

**播放排序语义（关键）**：`say` 是**优先播放**的，音乐排在 `say` 之后。这正是「像 DJ 那样播报」——先说话，再放歌。`segue` 则在当前曲目**剩余 10s 时**预合成，用于衔接下一首（对应施工图 PWA 层的 `prefetch 10s`）。

### 4.2 从链路：定时主动播报

```
scheduler (cron: 0 9 * * *) ──▶ trigger={type:'schedule', slot:'morning'}
        │
        ▼
router.classify(trigger)  → intent=scheduled_broadcast, need_brain=true
        │
        ▼
（此后与 §4.1 的 ④~⑪ 完全一致，唯一区别：⑤ 的用户输入片为空，
  ⑥ 的执行轨迹片标注 slot=morning）
```

**幂等保证**：每个 slot 每天只能成功触发一次，键为 `(date, slot)`，写入 `plan` 表。补跑策略见 [07](07-scheduler-rhythm.md)。

### 4.3 大脑子进程时序（实测基线）

```
t=0.0s   spawn dsh --profile dj-brain --json --session-id <sid>
t=0.0s   stdin ← prompt，随后关闭 stdin
t≈0.4s   stdout: {"type":"session","sessionId":"...","cwd":"D:\\DJ"}
t≈0.5s   stdout: {"type":"status","phase":"turn_start","turn":N}
t≈3.5s   stdout: {"type":"thinking","text":""}
t≈5.0s   stdout: {"type":"text","text":"{...DjAction...}"}
t≈5.2s   stdout: {"type":"status","phase":"turn_end","reason":{"kind":"completed"}}
t≈5.3s   stdout: {"type":"final","text":"{...}"}
t≈5.4s   exit code 0
```

实测（本机）：单轮 5.5s，恢复会话多轮 10.1s。**基线指标 `N-01 ≤ 8s` 有约 45% 余量**，因此超时阈值设为 30s，超时降级到模板播报。

---

## 5. 核心编排

### 5.1 `compute()` 契约

施工图：`MODEL · 前向过程 compute(fragments) → {say, play[], reason, segue}`

```js
/**
 * 一次完整的电台决策与出片。
 * @param {Intent} intent
 * @returns {Promise<Broadcast>}
 */
async function compute(intent) {
  const fragments = await context.build(intent);   // ③ 第三层 6 片
  const action    = await brain.compute(fragments); // 大脑推理
  const queue     = await music.resolve(action.play); // ncm 解析 queue
  const sayUrl    = await tts.synthesize(action.say); // tts 合成 say
  const broadcast = assemble(action, queue, sayUrl);
  await state.record(intent, broadcast);
  ws.broadcast({ type: 'now-playing', ...broadcast });
  return broadcast;
}
```

### 5.2 编排的降级链

每一环都有独立降级，**任何单点失败都不允许让电台静音**：

| 环节 | 失败表现 | 降级动作 |
|---|---|---|
| `context.build` | 语料文件缺失 | 用内置默认语料（`config/defaults/`）并告警 |
| `brain.compute` | 超时 / 退出码 1 / JSON 解析失败 | ① 重试 1 次；② 仍失败 → 用 `fallback-templates.js` 按时段选模板播报 + 播放 `playlists.json` 的对应档位歌单 |
| `music.resolve` | 直链解析失败 | 依次尝试候选；全失败 → 播本地兜底曲库（`data/fallback-audio/`） |
| `tts.synthesize` | edge-tts 失败 | 降级 SAPI；SAPI 也失败 → 跳过语音，直接放歌（并在日志告警） |
| `ws.broadcast` | 无客户端连接 | 静默忽略（电台可无人收听继续走） |

### 5.3 并发控制

- **单飞（single-flight）**：同一时刻只允许一次 `compute()` 在途。新的触发若已在途，进入「插队队列」并按优先级重排：`user_chat` > `schedule` > `prefetch`。
- **子进程上限**：`dsh` 子进程并发上限 1（避免多实例抢 credentials 与 session 文件），排队超 20s 则丢弃低优先级触发。
- **TTS 合成队列**：最多 2 个并发，避免 edge-tts 被限流；队列深度 > 20 时丢弃 `prefetch` 任务。

---

## 6. 数据契约摘要

### 6.1 `DjAction`（大脑返回，v1）

```json
{
  "say":    "外面下着小雨，给你放首安静的。",
  "play":   ["李志 - 下雨", "陈粒 - 小半"],
  "reason": "用户提到下雨且想要安静，匹配 mood-rules 的雨天-低能量档",
  "segue":  "接下来这首来自 2015 年的专辑。"
}
```

- `say` 必填，非空字符串，长度 1~200 字（超出截断并告警，避免 TTS 太长）
- `play` 必填数组，元素为 `"艺人 - 曲名"` 字符串；**允许为空**（纯口播场景，如天气播报）
- `reason` 必填，用于 `/api/plan/today` 展示与调试，不进入 TTS
- `segue` 选填，可为 `""`

完整 schema 与校验规则见 [03-api-contract.md](03-api-contract.md#dj-action-v1)。

### 6.2 SQLite 表

`messages` · `plays` · `plan` · `prefs` 四表，DDL 见 [03](03-api-contract.md#sqlite-ddl)。

---

## 7. 关键设计决策

| 编号 | 决策 | 替代方案 | 理由 |
|---|---|---|---|
| D-01 | 大脑用 `dsh` 无头子进程，每轮**新建进程** | 常驻 SDK 会话 | 施工图就是「子进程调用」；进程级隔离避免大脑状态污染电台状态；实测冷启动仅 5.4s，代价可接受 |
| D-02 | 用 `--session-id` 维持**跨进程**多轮记忆 | 每轮重放历史 | 已验证：resume 后大脑能答出上一轮播放内容；省 token 且天然持久 |
| D-03 | TTS **本地优先**，不含任何云 TTS 依赖 | Fish Audio 云 | 零成本、离线可用、隐私不出机；适配器保留云端扩展位 |
| D-04 | 音乐走**公共 API 实例**，但封装为多适配器 | 自建 NeteaseCloudMusicApi | 省运维；已实测 gdstudio 实例 search/url/lyric/pic/playlist 全可用；多适配器隔离可用性风险 |
| D-05 | 单 `<audio>` 元素串行播放 | 双 audio 交叉淡入 | 移动浏览器对同时多路播放有硬限制，单元素最稳；衔接 gap ≤ 800ms 可控 |
| D-06 | 语料存 `knowledge/`，大脑以 `cwd=D:\DJ` 运行 | 把语料内联进 prompt | 施工图明确 `user/*.md` 是文件；文件可被你直接编辑，改完下次触发生效 |
| D-07 | TTS 缓存键 = `sha1(voice\|rate\|pitch\|text)` | 仅 `sha1(text)` | 换音色后旧缓存必须失效，否则音色参数失去意义 |
| D-08 | 一切出网依赖都有降级分支 | 失败即报错 | 电台的核心体验是「一直在响」，静音是最差的失败模式 |

---

## 8. 状态机

### 8.1 电台播放状态机

```
        ┌──────────┐
        │  IDLE    │◀────────────────────────┐
        └────┬─────┘                         │
             │ trigger                        │ 队列空且无播报
             ▼                                │
        ┌──────────┐  大脑超时/失败   ┌────────┴──────┐
        │ THINKING ├────────────────▶│  DEGRADED     │
        └────┬─────┘                 │ (模板播报)     │
             │ DjAction              └───────┬───────┘
             ▼                               │
        ┌──────────┐  无可用直链    ┌────────▼──────┐
        │RESOLVING ├───────────────▶│ FALLBACK_AUDIO│
        └────┬─────┘                └───────┬───────┘
             │ queue 就绪                    │
             ▼                               │
        ┌──────────┐  say 合成失败            │
        │ SPEAKING ├───────────────┐         │
        └────┬─────┘               │         │
             │ say 播完             │         │
             ▼                     ▼         │
        ┌──────────┐         ┌──────────┐    │
        │ PLAYING  │         │ MUSIC_ONLY│   │
        └────┬─────┘         └────┬─────┘    │
             │ 曲目结束/跳过         │          │
             └──────────┬──────────┘          │
                        │                     │
                        ├─ queue 非空 → 下一首 PLAYING
                        └─ queue 空 ─────────┘
```

**不变量**：
- `SPEAKING` 与 `PLAYING` 互斥（永远只有一个 `<audio>` 在响）
- 任意状态收到 `user_chat` 触发 → 允许中断，直接进入 `THINKING`
- `DEGRADED` / `FALLBACK_AUDIO` / `MUSIC_ONLY` 都必须能自行回到 `IDLE`，不允许卡死

### 8.2 触发生命周期

```
pending → claimed(加锁) → running → {succeeded | failed | skipped}
                │
                └─ 超过 90s 未终结 → 视为 stale，释放锁并标记 failed
```

`(date, slot)` 唯一约束保证 `succeeded` 不可重入。

---

## 9. 安全与合规

| 项 | 措施 |
|---|---|
| 绑定地址 | 默认 `127.0.0.1:8080`；如需手机访问，改为 `0.0.0.0` 并**必须**加访问令牌（`config.radio.authToken`） |
| 令牌 | `/api/*` 与 `/stream` 校验 `Authorization: Bearer` 或 `?token=`；静态资源不校验 |
| 大脑凭据 | 复用 `~/.dsh/.credentials.yaml` 账号态，**不落项目目录**，不进 git |
| 版权 | 只做流式播放与元数据/歌词展示，不下载留存、不二次分发；`song_url` 失败即降级，不尝试绕过 |
| 日志 | 默认不记录 prompt 全文（可能含隐私语料），只记长度与 hash；`LOG_PROMPT=1` 时才落全文 |
| 文件写入 | TTS 缓存与 DB 固定在 `data/`，路径经白名单校验，防止 `say` 文本影响路径 |

---

## 10. 未决问题

| 编号 | 问题 | 影响 | 计划 |
|---|---|---|---|
| Q-01 | 公共音乐实例随时可能失效（已实测 kuwo/tencent/migu 源 400/503） | 高 | 实现期补 joox 源 + 本地兜底音频 + 可配置自建实例 |
| Q-02 | `Huihui` 是 SAPI 唯一中文音色，音质较机械 | 中 | edge-tts 为首选即可规避；如需更好离线音色，评估安装 Windows 神经语音包 |
| Q-03 | 整点情绪检查可能过于频繁，打扰 | 中 | `routines.md` 中做成可配开关，默认仅 09:00–22:00 启用 |
| Q-04 | `dsh` 每次冷启动 5.4s，连续交互有延迟感 | 中 | 交互路径先行「占位播报」（已知的轻量过渡语），大脑结果到达后替换 |
| Q-05 | UPnP 投送在 Windows 上实现成本高 | 低 | 列为 P2；优先 Chromecast 或直接手机蓝牙 |

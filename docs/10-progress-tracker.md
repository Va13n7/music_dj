# Claudiao · 进度表

> 文档版本 v1.0 · 状态：设计完成，代码未实现
> 上游唯一权威来源：[设计总览](01-architecture-design.md)（里程碑划分严格对齐其 §2 四层结构与 §3.2 模块职责矩阵）
> 关联：[需求与准备清单](09-requirements-checklist.md) · [风险登记册](11-risk-register.md) · [测试策略](12-testing-strategy.md) · [部署与运维](13-deployment-ops.md)

---

## 0. 单位与符号约定

| 约定 | 含义 |
|---|---|
| **工作量单位** | **会话数**（1 会话 ≈ 一次连续 3~4 小时的编码会话，含自测）。**不使用「人日」**——本项目是单人、非线性排期，会话数更贴合真实节奏 |
| 状态符号 | `☐ 未开始` / `◐ 进行中` / `☑ 完成` / `⊘ 阻塞` |
| 「完成」的定义 | 该任务的**验收**列全部为真，且 `npm test` 全绿。不是「代码写完了」 |
| 依赖记号 | `M1-T3` 表示前置任务；`—` 表示无前置 |
| 并行记号 | `‖` 表示与同里程碑其他任务可并行 |

**总量估算：13 个会话（含 1 个缓冲）**，其中 M1 与 M2 可并行，关键路径约 11 个会话。

---

## 1. 里程碑总览

| 里程碑 | 目标（一句话） | 交付物 | 验收标准 | 依赖 | 会话数 |
|---|---|---|---|---|---|
| **M0 地基** | 让「能不能开工」变成一条命令的答案 | `tools/doctor.js` · `src/lib/config.js` · `src/lib/log.js` · `tools/db-migrate.js` · `data/radio.db` 四表 | `npm run doctor` 必需项全 PASS；`npm run db:migrate` 后四表存在；日志落 `data/logs/` 且默认不含语料全文 | E-1/E-2/E-6/E-7 已满足 | 1.5 |
| **M1 大脑打通** | 能在 CLI 一问一答拿到合法 `DjAction` | `src/adapters/brain/dsh-headless.js` · `src/layer2/brain.js` · `tools/brain-smoke.js` · `tools/brain-ask.js` | `npm run brain:smoke` 输出含 `say`/`play`/`reason` 的合法 JSON，退出码 0；超时 30s 走降级；`tests/replay/brain/*` 全绿（**不真调 dsh**） | M0 | 1.5<br>**（◐ 部分完成，剩 ~1）** |
| **M2 声音打通** | 能把一句话变成 `data/tts-cache/` 里的 mp3 并播放 | `src/adapters/tts/edge.js` · `src/adapters/tts/sapi.js` · `src/layer2/tts.js` · `tools/tts-warm.js` · `tools/tts-voices.js` | `npm run tts:warm` 生成 ≥1 个 mp3 且能听到；缓存命中 < 50ms；edge 失败自动降 SAPI（WAV）；`FakeTtsAdapter` 让单测离线通过 | M0 | 1.5 |
| **M3 音乐打通** | 「艺人 - 曲名」→ 可播放直链，且全失败时有兜底 | `src/providers/music/gdstudio.js` · `src/providers/music/index.js` · `tools/music-check.js` · `tools/music-resolve.js` · 翻唱过滤 | `npm run music:check` 对 `netease`/`joox` 报可用；`music:resolve -- "李志 - 下雨"` 得到 mp3 直链；全源失败 → `data/fallback-audio/` 被选中（日志可见） | M0 | 1.5 |
| **M4 编排成型** | 走通一次完整播报：意图 → 大脑 → 曲 → 声音 → 落库 | `src/layer2/router.js` · `src/layer2/context.js` · `src/layer2/compute.js` · `src/layer2/fallback-templates.js` · `src/layer2/state.js` | E2E-01/02/04 通过；**降级链三条全绿**（大脑失败 / 音乐全失败 / TTS 失败）；`compute()` 单飞与插队队列生效 | M1 · M2 · M3 | 2 |
| **M5 服务与前端** | 浏览器里能听到，手机也能 | `src/server.js` · `src/routes/*`（5 条 API）· `src/ws/hub.js` · `web/`（三视图 + 单 `<audio>` + `sw.js`） | 契约测试全绿（HTTP 6 条线 + WS 事件序列）；E2E-03/10 通过；PWA 可安装、可离线打开 | M4 | 2 |
| **M6 节律** | 到点自己开口，且不重复、不打扰 | `src/layer2/scheduler.js` · `src/providers/calendar.js` · 幂等与补跑 | E2E-08/09/11 通过；`(date,slot)` 幂等命中；`protectedWindows` 与静默时段生效；超窗 slot 标 `skipped` | M5 | 1.5 |
| **M7 打磨** | 让它在你关机重启后依然自己活着 | 降级链全覆盖 · 可观测性 · `tools/backup.js` · [部署与运维](13-deployment-ops.md) 落地 · 开机自启 | L1/L2/L3 三档 DoD 全勾；N-01~N-07 全部有实测数据；`npm run backup` 产出可恢复的 zip | M6 | 2 |

---

## 2. 任务分解表

> 任务 ID 规则：`M<里程碑>-T<序号>`。产出文件路径严格对应 [README 目录结构](../README.md)。

### M0 · 地基

| 任务 ID | 任务 | 产出文件 | 依赖 | 验收 | 状态 |
|---|---|---|---|---|---|
| M0-T1 | 配置装载器：合并 `.env` 与三个 yml，做类型与枚举校验，导出冻结对象 | `src/lib/config.js` | — | 单测：缺 `.env` 时给出可读错误；非法 `TTS_ENGINE` 被拒；`node -e "import('./src/lib/config.js')"` 成功 | ☑ 完成（2026-10-15，含单测） |
| M0-T2 | 日志层：分级、文件轮转（`LOG_MAX_FILES`）、prompt 脱敏（默认只记长度与 hash） | `src/lib/log.js` | M0-T1 | 单测：`LOG_PROMPT=0` 时输出中不含输入明文；轮转保留 14 个文件 | ☑ 完成（2026-10-15，含单测） |
| M0-T3 | SQLite 迁移：四表 DDL、WAL、`busy_timeout`、索引 | `tools/db-migrate.js`、`src/layer2/state.js` 骨架 | M0-T1 | `npm run db:migrate` 幂等（连跑两次不报错）；`PRAGMA integrity_check` = ok；重复迁移不改数据 | ☑ 完成（2026-10-15，含单测） |
| M0-T4 | `doctor` 工具：实现 [09 文档 §6](09-requirements-checklist.md) 的 20 项检查 | `tools/doctor.js` | M0-T1 · M0-T2 | 必需项全 PASS；单项失败不影响后续；退出码 = 有无 FAIL；`--deep` 开关可用 | ☑ 完成（2026-10-15，含单测） |
| M0-T5 | `validate-config` 工具：yml 引用完整性（slot 名、歌单 id、mood 档位） | `tools/validate-config.js` | M0-T1 | `npm run validate:all` 退出码 0；故意写一个悬空引用能被抓到并指出文件名与键 | ☑ 完成（2026-10-15，含单测） |

### M1 · 大脑打通（与 M2 完全并行）

| 任务 ID | 任务 | 产出文件 | 依赖 | 验收 | 状态 |
|---|---|---|---|---|---|
| M1-T1 | 大脑适配器（**已换成 zcode-agent**，dsh 方案弃用）：spawn + stdin prompt + NDJSON 解析 + 30s 超时 + 退出码处理 | `src/adapters/brain/dsh-headless.js` | M0-T1 · M0-T2 | 用 fixture 回放时能解析出 `final`；真实调用 `brain:smoke` 通过；`ENOENT`（路径错）给出明确错误而非堆栈 | ☐ 未开始 |
| M1-T2 | `DjAction` 校验与容错：schema 校验、长度截断、`play` 元素格式过滤、markdown 代码块剥离 | `src/layer2/brain.js` | M1-T1 | 单测覆盖：正常 / markdown 包裹 / 畸形 JSON / 缺 `say` / 空 `play` / 超长 `say` 六种 fixture | ☐ 未开始 |
| M1-T3 | 会话管理：`--session-id` 复用、会话丢失自动新建、按 slot 维护会话 id | `src/adapters/brain/session.js` | M1-T1 | resume 后能答出上一轮内容（手工）；删掉 session 文件后自动新建且不崩 | ☐ 未开始 |
| M1-T4 | 回放机制：`BRAIN_REPLAY_DIR` 让适配器读 fixture 而非 spawn | `tests/fixtures/brain/`、适配器分支 | M1-T1 | 设置 `BRAIN_REPLAY_DIR` 时进程**零 spawn**（用 `child_process` mock 断言）；`npm test` 离线全绿 | ☐ 未开始 |
| M1-T5 | CLI 工具：冒烟与一问一答，打印耗时与 usage | `tools/brain-smoke.js`、`tools/brain-ask.js` | M1-T1 · M1-T2 | `npm run brain:smoke` 打印 `elapsedMs` 与合法 JSON；`brain:ask "..."` 支持自定义问题 | ☑ 完成（2026-10-15 换 zcode-agent 后重写，含会话记忆断言） |
| M1-T6 | 失败重试与熔断：`BRAIN_RETRY` 次重试、失败计数、连续失败触发模板降级 | `src/layer2/brain.js` | M1-T2 | 单测：首次超时→重试成功，返回正常结果；连续 3 次失败→进入降级标记 | ☐ 未开始 |

### M2 · 声音打通（与 M1 完全并行）

| 任务 ID | 任务 | 产出文件 | 依赖 | 验收 | 状态 |
|---|---|---|---|---|---|
| M2-T1 | edge-tts 适配器：参数拼装、15s 超时、临时文件→原子落盘 | `src/adapters/tts/edge.js` | M0-T1 | `tts:warm` 真实合成 1 条并生成 mp3（实测基线 3.07s / 30096 字节）；超时被识别为可降级错误 | ☑ 完成（2026-10-15，含单测） |
| M2-T2 | 缓存层：`sha1(voice\|rate\|pitch\|text)[:16]` 键、命中即返回、LRU 淘汰（`ttsMaxFiles`/`ttsMaxBytes`） | `src/layer2/tts.js` | M2-T1 | 单测：命中路径 < 50ms；换 `TTS_VOICE` 后缓存键变化（`D-07`）；超限触发淘汰且不删刚写入项 | ☑ 完成（2026-10-15） |
| M2-T3 | SAPI 兜底适配器：`Microsoft Huihui Desktop` + WAV 输出 | `src/adapters/tts/sapi.js` | M0-T1 | 实际生成可播放 WAV；日志标注降级来源；连续 3 次 edge 失败后自动切 SAPI（`TTS_BREAKER_THRESHOLD`） | ☑ 完成（2026-10-15，含单测） |
| M2-T4 | `FakeTtsAdapter`：写固定字节假 mp3，供离线单测与 E2E 使用 | `tests/support/fake-tts.js` | M2-T2 | 单测断言：返回固定 URL、字节数恒定、不 spawn 任何进程 | ☑ 完成（2026-10-15） |
| M2-T5 | 合成队列：并发上限 2、队列深度 > 20 丢弃 `prefetch` | `src/layer2/tts.js` | M2-T2 | 单测并发计数峰值 ≤ 2；第 21 个 prefetch 任务被丢弃且不报错 | ☑ 完成（2026-10-15） |
| M2-T6 | CLI 工具：预热常用播报句、列音色 | `tools/tts-warm.js`、`tools/tts-voices.js` | M2-T2 | `tts:list-voices` 列出中文音色；`tts:warm` 后二次运行耗时显著下降（缓存命中） | ☑ 完成（2026-10-15） |

### M3 · 音乐打通

| 任务 ID | 任务 | 产出文件 | 依赖 | 验收 | 状态 |
|---|---|---|---|---|---|
| M3-T1 | gdstudio 适配器（已实现；另加官方源 netease-openapi.js，见 src/providers/music/）：`types=search/url/lyric/pic/playlist` 五个动作 | `src/providers/music/gdstudio.js` | M0-T1 | `music:check` 对 `netease`/`joox` 报 OK；`kuwo`/`tencent`/`migu`/`kugou` 被识别为不可用并给 WARN 而非崩溃 | ☑ 完成（2026-10-15，含单测） |
| M3-T2 | 多源降级链（已在组合门面 index.js 实现）：按 `MUSIC_SOURCES` 顺序尝试、单源失败切下一源 | `src/providers/music/index.js` | M3-T1 | 单测：第一源 503 → 第二源成功；全失败 → 抛可降级错误（不含敏感信息） | ☐ 未开始 |
| M3-T3 | 「艺人 - 曲名」解析与候选匹配：含**翻唱噪声过滤**（时长兜底、artist 归一化、title 变体扣分） | `src/providers/music/match.js` | M3-T1 | 用 [测试策略 §4](12-testing-strategy.md) 的真实 search fixture 断言选中原始版本而非翻唱/伴奏/DJ 版 | ☐ 未开始 |
| M3-T4 | 直链缓存：TTL 600s、剩余 < 30s 视为失效、重解析 | `src/providers/music/url-cache.js` | M3-T1 | 单测：TTL 内命中不重复请求；过期后重新请求；失败不污染缓存 | ☐ 未开始 |
| M3-T5 | 本地兜底池：读 `data/fallback-audio/`、按情绪档挑选、排除最近 6 小时已播 | `src/providers/music/fallback-audio.js` | M0-T3 | 目录空 → 明确告警且不抛；≥5 首时能选出非最近播放的一首 | ☑ 完成（2026-10-15，含单测） |
| M3-T6 | CLI 工具：连通性体检、单曲解析 | `tools/music-check.js`、`tools/music-resolve.js` | M3-T2 | 两条命令在真实网络下退出码 0；输出人类可读的源/码率/时长 | ☐ 未开始 |

### M4 · 编排成型

| 任务 ID | 任务 | 产出文件 | 依赖 | 验收 | 状态 |
|---|---|---|---|---|---|
| M4-T1 | `router.classify`：意图分流（点播/情绪/跳过/控制/定时/闲聊）+ 简单指令直连（不走大脑） | `src/layer2/router.js` | M0-T1 | 单测表驱动 ≥ 30 条输入断言 `Intent`；「下一首」类控制指令**不触发**大脑 | ☑ 完成（2026-10-15，含单测） |
| M4-T2 | `context.build`：严格实现第三层 6 片；语料内容哈希缓存；缺失走内置默认语料 | `src/layer2/context.js` | M4-T1 · M0-T2 | 单测：6 片齐全且顺序固定；改语料 → 哈希变化 → 重新读取；删语料 → 用默认语料并告警 | ☑ 完成（2026-10-15） |
| M4-T3 | `state.js`：`messages`/`plays`/`plan`/`prefs` 读写、24h 去重查询、跳过权重 | `src/layer2/state.js` | M0-T3 | 单测：写入后查询一致；`recentPlays(24)` 窗口正确；跳过计数驱动情绪切换（3 次） | ☑ 完成（2026-10-15，含单测） |
| M4-T4 | `fallback-templates.js`：按时段/情绪选模板播报 + 从 `playlists.json` 对应档位取曲 | `src/layer2/fallback-templates.js` | M4-T2 | 单测：覆盖全部 slot；模板句不含未替换占位符；`play` 至少 1 首 | ☑ 完成（2026-10-15） |
| M4-T5 | `compute()` 编排：串起 6 片 → 大脑 → 曲 → TTS → 落库；单飞 + 插队队列 + 优先级 | `src/layer2/compute.js` | M4-T1~T4 · M1-T6 · M2-T2 · M3-T2 | E2E-01/02/04 通过；并发触发时只跑一次 compute，低优先级可被丢弃 | ☑ 完成（2026-10-15） |
| M4-T6 | 降级链三条：大脑失败→模板；音乐全失败→兜底音频；TTS 失败→只放歌 | `src/layer2/compute.js` | M4-T5 | E2E-05/06/07 通过；三条降级路径**都有日志**且状态机不停留在中间态 | ☑ 完成（2026-10-15） |
| M4-T7 | 状态机落地：`IDLE/THINKING/RESOLVING/SPEAKING/PLAYING/DEGRADED/FALLBACK_AUDIO/MUSIC_ONLY` 与互斥不变量 | `src/layer2/machine.js` | M4-T5 | 单测：非法迁移被拒；`SPEAKING` 与 `PLAYING` 永不同时；三态都能回 `IDLE` | ☑ 完成（2026-10-15） |

### M5 · 服务与前端

| 任务 ID | 任务 | 产出文件 | 依赖 | 验收 | 状态 |
|---|---|---|---|---|---|
| M5-T1 | HTTP 服务骨架：Express、静态资源白名单、`maxBodyBytes`、令牌校验 | `src/server.js` | M4-T5 | 契约测试：超长 body 返回 413；非白名单扩展名 403；非本机无 token 401 | ☑ 完成（2026-10-15） |
| M5-T2 | 5 条 API：`/api/chat` `/api/now` `/api/next` `/api/taste` `/api/plan/today`（+ `/api/health`） | `src/routes/*.js` | M5-T1 | 契约测试逐条校验请求/响应 schema；`/api/health` 暴露 brain/tts/music 可用性与 `rssMb` | ☑ 完成（2026-10-15） |
| M5-T3 | WS `/stream`：心跳 25s、广播 `now-playing`、客户端计数与静默忽略 | `src/ws/hub.js` | M5-T1 | 契约测试：事件序列与 schema；无客户端广播不抛错；断连自动清理 | ☑ 完成（2026-10-15） |
| M5-T4 | PWA 壳层：三视图切换、manifest、Service Worker、离线可用 | `web/index.html`、`web/manifest.webmanifest`、`web/sw.js` | M5-T1 | 断网刷新仍能打开（E2E-07 的界面部分）；Lighthouse PWA 可安装检查通过 | ☑ 完成（2026-10-15） |
| M5-T5 | 播放器：**单 `<audio>`** 串行、`say` 优先、gap ≤ 800ms、跳过、MediaSession | `web/player.js` | M5-T2 · M5-T3 | E2E-01/03 通过；跳过在 200ms 内反映到 UI；手机锁屏能看到曲名 | ☑ 完成（2026-10-15） |
| M5-T6 | WS 客户端：指数退避重连（`wsReconnectBaseMs`）、断线降级轮询 `/api/now` | `web/ws-client.js` | M5-T3 | 单测（jsdom 或纯函数）：退避序列符合公式；断线 5s 内切轮询 | ☑ 完成（2026-10-15） |
| M5-T7 | Profile 视图：在线编辑语料并保存（`/api/taste`） | `web/views/profile.js` | M5-T2 | E2E-12 通过；保存后有明确的「已保存，下次触发生效」提示 | ☑ 完成（2026-10-15） |

### M6 · 节律

| 任务 ID | 任务 | 产出文件 | 依赖 | 验收 | 状态 |
|---|---|---|---|---|---|
| M6-T1 | cron 引擎：`config/routines.yml` 装载、5 段 cron 解析、下次触发时间计算、`SLOT_TIME_SCALE` 加速开关（测试用） | `src/layer2/scheduler.js` | M5-T2 | 单测：8 个 slot 的下次触发时间与预期一致（含跨午夜）；`SLOT_TIME_SCALE` 生效 | ☑ 完成（2026-10-15） |
| M6-T2 | 幂等与锁：`(date,slot)` 唯一约束、`pending→claimed→running→succeeded` 生命周期、90s stale 释放 | `src/layer2/scheduler.js` | M6-T1 · M0-T3 | 单测：同日同 slot 第二次 `succeeded` 被拒；stale 超时释放锁并标 `failed` | ☑ 完成（2026-10-15） |
| M6-T3 | 唤醒补跑：`graceMinutes` 窗口内补跑，超窗标 `skipped` | `src/layer2/scheduler.js` | M6-T2 | E2E-09 通过；`staleMarkAs: skipped` 生效；补跑不产生重复播报 | ☑ 完成（2026-10-15） |
| M6-T4 | 节制规则：静默时段、`doNotDisturb`、`protectedWindows`、最小间隔 45min、每日上限 8 次、连续失败熔断 3 次 | `src/layer2/scheduler.js` | M6-T1 | 单测逐条：每个规则各一个正例一个反例；`skipped` 有原因码可查 | ☑ 完成（2026-10-15） |
| M6-T5 | 日历提供方：读 `config/calendar.yml`，事件前 `leadMinutes` 触发 | `src/providers/calendar.js` | M6-T1 | 单测：固定「今天 +30min」的事件被正确算出触发点；空日历不触发 | ☑ 完成（2026-10-15） |
| M6-T6 | 每日规划：07:00 静默生成 `plan` 表、预热早间 TTS 缓存与曲目直链 | `src/layer2/planner.js` | M6-T2 · M4-T5 | E2E-08 通过；`/api/plan/today` 有当日全部时段且每条含 `reason` | ☑ 完成（2026-10-15） |

### M7 · 打磨

| 任务 ID | 任务 | 产出文件 | 依赖 | 验收 | 状态 |
|---|---|---|---|---|---|
| M7-T1 | 可观测性：延迟/失败率/降级次数落 `data/logs/*.jsonl`，`/api/health` 详情 | `src/lib/metrics.js` | M5-T2 | 连续运行 30 分钟能算出 P50/P95 大脑延迟；降级次数可查 | ☑ 完成（2026-10-15） |
| M7-T2 | 备份工具：DB + 缓存索引 + 语料打包 zip，保留策略 | `tools/backup.js` | M0-T3 | `npm run backup` 产出 zip，解压后可恢复到新环境并通过 `db:migrate` 校验 | ☑ 完成（2026-10-15，含单测） |
| M7-T3 | 每日总结：23:50 写当日总结到 `state.db`，可选飞书推送 | `src/layer2/summary.js` | M6-T2 | 单测：总结含当日播放数/跳过率/降级次数；Webhook 未配置时静默跳过 | ☑ 完成（2026-10-15） |
| M7-T4 | 开机自启与进程守护：计划任务 / `nssm` 二选一，日志落盘 | `scripts/install-service.ps1` | M7-T2 | 重启电脑后无需手动操作，`http://localhost:8080/api/health` 可用 | ☐ 未开始 |
| M7-T5 | 性能与内存达标：定位泄漏点，落实 N-03 | 各处修补 | M7-T1 | 30 分钟工作集 ≤ 300MB；WS 客户端反复连接/断开无句柄泄漏 | ☐ 未开始 |
| M7-T6 | 文档回填：把实测数字写回 [需求与准备清单](09-requirements-checklist.md) 与 [部署与运维](13-deployment-ops.md) | 文档 | M7-T1~T5 | DoD 三档全勾；文档中的数字均为实测而非估算 | ☐ 未开始 |

---

## 3. 关键路径

**串行阻塞链（关键路径，约 11 个会话）**

```
M0 地基 ──┬──▶ M1 大脑 ──┐
          │              ├──▶ M4 编排 ──▶ M5 服务与前端 ──▶ M6 节律 ──▶ M7 打磨
          ├──▶ M2 声音 ──┤        (2)          (2)            (1.5)        (2)
          │    (1.5)      │
          └──▶ M3 音乐 ──┘
               (1.5)               ↑
                          ★ M1 与 M2 完全并行，互不依赖
                          ★ M3 也只依赖 M0，可与 M1/M2 一起三线并行
```

**并行 / 阻塞关系明细**

| 关系 | 任务 | 说明 |
|---|---|---|
| **完全并行** | **M1（大脑打通）‖ M2（声音打通）** | 两者唯一的共同前置是 M0。适配器文件不重叠（`src/adapters/brain/` vs `src/adapters/tts/`），测试 fixture 目录不重叠。**建议同时开工**，可省 1.5 个会话 |
| 可并行 | M3 与 M1/M2 | M3 也只依赖 M0。若精力允许可三线并行；但 M3 有外部网络不确定性，建议安排在 M1/M2 之后作为缓冲 |
| 串行阻塞 | M0 → M1/M2/M3 | `config.js` 与 `log.js` 是所有模块的共同前置；`db:migrate` 是 M4-T3 的前置 |
| 串行阻塞 | M1-T1 → M1-T2 → M1-T6 | 解析层必须先于容错层；回放机制（M1-T4）依赖 M1-T1 |
| 串行阻塞 | M2-T1 → M2-T2 → M2-T4 | `FakeTtsAdapter` 只有在缓存层接口定型后才有意义 |
| **汇合点（最易堵）** | M4-T5 | 需要 M1-T6 + M2-T2 + M3-T2 全部就绪。这是整个项目**风险最集中**的一步：[风险 R-08](11-risk-register.md) 在此处爆发代价最高 |
| 可并行 | M4-T1/T2/T3/T4 与 M1/M2/M3 的收尾 | `router.js`、`context.js`、`state.js`、`fallback-templates.js` 都不依赖适配器内部实现，只依赖接口定义（已在 [设计总览 §3.2](01-architecture-design.md) 固化） |
| 串行阻塞 | M5-T1 → M5-T2/T3 → M5-T5 | 播放器需要 API 与 WS 都在线才能端到端验证 |
| 可并行 | M5-T4（PWA 壳层）与 M5-T2/T3 | 壳层只依赖静态资源约定，不等 API |
| 串行阻塞 | M6 全部依赖 M5-T2 | 补跑与幂等要通过 API 观测（`/api/plan/today`） |
| 可并行 | M7-T1（可观测性）与 M6 | 埋点可在 M5 完成后立即开始，不必等调度 |

**缩短关键路径的三个建议**

1. **接口先行**：在 M0 结束时把 `BrainAdapter` / `TtsAdapter` / `MusicProvider` / `StateApi` 四个接口文件（只有 JSDoc 与空实现）落盘，M1/M2/M3 与 M4 的前四个任务就能同时开工——`architecture-boundary.test.js` 也能提前写。
2. **降级链优先于主链**：M4-T6 与 M4-T5 同批做。主链能跑但降级链没做的状态下，任何外部抖动都会让电台静音（`D-08`）。
3. **fixture 先于实现**：M1-T4 的 fixture 在 M1-T1 之前手工录好（`dsh` 已实测可用），实现时就有对照物，省掉反复真调大脑的等待。

---

## 4. 当前状态快照

> 更新日期：设计定稿 + 首批工具验证之后。**状态诚实标注：设计完成 + 三项关键外部依赖已实测验证 + 2 个工具脚本已实现并通过 + `src/` 业务代码零实现。**

### 4.1 已完成（☑）

| 类别 | 内容 | 证据 |
|---|---|---|
| 设计 | [设计总览](01-architecture-design.md) 定稿（需求 F/N、降级链、决策 D-01~D-08、状态机、安全合规、未决问题 Q-01~Q-05） | 425 行，含 §1 需求表与 §10 未决问题 |
| 设计 | 施工图原件归档 | `docs/assets/blueprint-original.jpg` |
| 设计 | 并行的模块文档（模块设计/接口契约/TTS 管线/大脑适配器/音乐提供方/调度节律/PWA 前端/快速开始/部署运维） | 多份已在 `docs/` 落地，其余进行中 |
| 语料 | 全部 5 份语料就绪 | [dj-persona.md](../knowledge/prompts/dj-persona.md) · [taste.md](../knowledge/user/taste.md) · [routines.md](../knowledge/user/routines.md) · [mood-rules.md](../knowledge/user/mood-rules.md) · [playlists.json](../knowledge/user/playlists.json) |
| 配置 | 主配置 / 节律 / 日历 / 环境模板四份 | [radio.yml](../config/radio.yml) · [routines.yml](../config/routines.yml) · `config/calendar.yml` · [.env.example](../config/.env.example) · 本机 `config/.env` 已存在 |
| 工程 | 依赖与脚本全部定型 | [package.json](../package.json)：5 个依赖，**无 jest/vitest**，测试走 `node --test`；15 个 npm 脚本 |
| 工程 | 目录骨架 | `docs/` `knowledge/` `config/` `src/layer2/` `src/adapters/` `src/providers/` `web/` `public/` `data/` `data/tts-cache/` `data/logs/` `scripts/` `tests/` `tools/` |
| **工具** | **[tools/validate-playlists.js](../tools/validate-playlists.js) 已实现并通过** | 校验 `playlists.json` 结构、**70 首曲目**的 `"艺人 - 曲名"` 格式、以及 `slotDefaults`/`moodDefaults` 的悬空引用；**11 个歌单全部通过** |
| **工具** | **[tools/brain-smoke.js](../tools/brain-smoke.js) 已实现并通过（M1 提前完成部分，实测 6320 ms）** | 三段断言：①进程层退出码 0；②事件流契约（NDJSON / `session` / `turn_end` / `final` / `reason=completed`）；③`DjAction` 四字段校验。自带极简 `.env` 读取，避免为工具引入 `dotenv` |
| **实测** | **大脑可用**：`dsh --profile dj-brain --json --session-id <sid>`，prompt 走 stdin，stdout 为 NDJSON，退出码 0/1；新会话 5.5s、resume 10.1s；**无需 API key**（账号态） | profile 位于 `C:\Users\wumingtao\.dsh\profiles\dj-brain\`；`dsh` 绝对路径已写入 `.env.example` |
| **实测** | **TTS 可用**：`edge-tts --voice zh-CN-XiaoxiaoNeural --text "..." --write-media out.mp3` → 3.07s / 30096 字节；SAPI 唯一中文音色 `Microsoft Huihui Desktop`（仅 WAV） | 可执行文件 `D:\python\Scripts\edge-tts.exe` |
| **实测** | **音乐 API 可用**：`music-api.gdstudio.xyz` 的 `search/url/lyric/pic/playlist` 全部可用，`types=url` 返回可播放 mp3 直链 | `netease` ✅ `joox` ✅；`kuwo`/`tencent`/`migu`/`kugou` ❌ 400/503（→ [风险 R-01](11-risk-register.md)） |
| **实测** | **踩坑并修复：环境变量名冲突**。DSH 自身注入 `DSH_PROFILE=desktop`，本项目若用同名变量会被静默覆盖，大脑报 `error: profile "desktop" is managed exclusively by the Electron application` | 已复现并修复：dsh 相关变量统一加 `CLAUDIAO_` 前缀（`CLAUDIAO_DSH_BIN` / `CLAUDIAO_DSH_PROFILE` / `CLAUDIAO_DSH_CWD`），[.env.example](../config/.env.example) 与 `brain-smoke.js` 的 `loadEnv()` 均已同步（见 §6 变更日志） |
| 环境 | Node v22.11.0 / npm 10.9.0 / Python 3.12.6；D: 剩余约 54GB；**无 pnpm、无全局 7z（均不需要）** | 见 [需求与准备清单 §3](09-requirements-checklist.md) |

### 4.2 未开始（☐）

| 项 | 说明 |
|---|---|
| **全部业务代码** | `src/` 下除目录外**没有任何 `.js` 文件**。M0、M2、M3、M4、M5、M6、M7 的每一个任务都是 `☐ 未开始`；**M1 部分完成**（见下方说明） |
| **M1 的其余部分** | `tools/brain-smoke.js`（M1-T5 的一半）✅ 已完成；**M1-T4（回放机制）已完成底座**（`tests/support/fixtures.js` + 12 个 fixture）；但 **M1-T1（`dsh-headless.js` 适配器）、M1-T2（`DjAction` 校验）、M1-T3（会话管理）、M1-T6（重试熔断）仍未开始**——`src/` 里还没有任何适配器代码，冒烟工具目前是「直接 spawn + 内联断言」的独立实现 |
| **前端** | `web/` 与 `public/` 为空 |
| **兜底音频** | `data/fallback-audio/` 目录已创建但**为空**，**需要你自己准备 ≥5 首无版权音频**（唯一需要自备素材的一项） |
| **未决验证** | `npm install` 未执行；`better-sqlite3` 原生构建未验证 |
| **契约测试与端到端测试** | `tests/contract/` 与 `tests/e2e/` 为空（依赖 `src/server.js`，M5 才开始） |

### 4.3 已完成但原计划中列为「待建」的项

设计阶段把「怎么证明它对」一并工具化了，所以下列项**提前完成**：

| 项 | 状态 | 证据 |
|---|---|---|
| `tools/doctor.js` | ✅ 已完成 | 25 项环境检查，当前 **24 通过 / 0 失败**；含无前缀变量名冲突检测、profile BOM 检测 |
| `tools/brain-ask.js` | ✅ 已完成 | 按第三层六片组装 prompt 直接问大脑，打印播报/选曲/理由，含合规提示 |
| `tools/music-check.js` | ✅ 已完成 | 5 个 endpoint + 端到端解析 + 帧级直链校验；**0 失败 · 3 提示** |
| `tools/music-resolve.js` | ✅ 已完成 | 单曲解析，`--show-candidates` 打印完整打分与噪声罚分 |
| `tools/tts-warm.js` | ✅ 已完成 | 预热 8 条固定播报；实测平均 **2901ms/句**，二次运行全部命中缓存 |
| `tools/tts-voices.js` | ✅ 已完成 | 列出 8 个中文音色并标注电台推荐 |
| `tools/db-migrate.js` | ✅ 已完成 | 状态库现状检查（**刻意不建表**，避免与契约出现两套真相） |
| `tools/backup.js` | ✅ 已完成 | 备份语料/配置/DB/大脑 profile，用 `VACUUM INTO` 做一致性快照 |
| `tools/validate-docs.js` | ✅ 已完成 | 文档一致性门禁：链接、锚点、术语、取值；**0 FAIL**（原计划无此项） |
| `tools/record-brain-fixtures.js` | ✅ 已完成 | 用真实大脑录制 12 个场景 fixture，并**校验每个场景是否真覆盖其声称的边界** |
| `tools/record-music-fixtures.js` | ✅ 已完成 | 录制 16 个音乐 API fixture（含翻唱噪声样本） |
| **测试底座** | ✅ 已完成 | `tests/support/fixtures.js`（大脑回放 + FakeMusicProvider + FakeTtsAdapter + `validateDjAction`）；`tests/unit/fixture-harness.test.js` **21 个断言全部通过，226ms** |
| **fixture 库** | ✅ 已完成 | `tests/fixtures/brain/` 12 个场景（6 真实录制 + 6 人造）；`tests/fixtures/music/` 4 个场景 16 个文件 |

> **测试已经可以跑了**：`npm test` → `21 pass / 0 fail`，且**零出网、零子进程、零磁盘写入**。
> 这意味着 M1 写大脑适配器时，可以立刻用真实的模型输出做回放测试，不必等外部环境。


### 4.3 下一步（按顺序）

1. **建 `data/fallback-audio/` 并放入 ≥5 首音频**——这是唯一需要你亲自做的事，越早做越好，因为它不阻塞任何编码任务，但拖到最后会阻塞 M3-T5 与 F-10 的验收。规范见 [需求与准备清单 §4](09-requirements-checklist.md)。
2. **执行 `npm install`**，确认 `better-sqlite3` 原生模块可用（[风险 R-20](11-risk-register.md) 的成败在此判定）。
3. **开工 M0**：先做 `src/lib/config.js` + `tools/doctor.js`。注意 `config.js` 必须复刻 `brain-smoke.js` 的 `loadEnv()` 语义（带 `CLAUDIAO_` 前缀的键以 `.env` 为准），并把「无前缀 `DSH_*` 冲突检测」写进 doctor 第 3b 项。
4. **把 `brain-smoke.js` 的内联断言抽成可复用的解析层**：M1-T1/T2 应当直接复用其中已验证的 NDJSON 解析与 `DjAction` 校验逻辑，而不是重写一遍。这是已完成工具对后续任务最大的价值。
5. **手工预录 M1 的 fixture**：`dsh` 现在就能用，趁早录 8 类 NDJSON 样本放进 `tests/fixtures/brain/`（清单见 [测试策略 §2](12-testing-strategy.md)），后续所有大脑相关测试都靠它离线跑。
6. **M0 结束时立即开两条并行线**：M1（大脑）与 M2（声音），同时把四个适配器接口的空实现落盘，让 M4 的纯逻辑任务（router / context / state / fallback-templates）也能提前开工。

---

## 5. 进度记录表

> 每次会话结束追加一行。**「阻塞」列必须写具体的外部条件**，不写「时间不够」。

| 日期 | 里程碑 | 完成项（任务 ID） | 阻塞 | 备注 |
|---|---|---|---|---|
| | | | | |
| | | | | |
| | | | | |
| | | | | |
| | | | | |
| | | | | |
| | | | | |
| | | | | |
| | | | | |
| | | | | |
| | | | | |
| | | | | |
| | | | | |
| | | | | |
| | | | | |
| | | | | |
| | | | | |
| | | | | |
| | | | | |
| | | | | |

---

## 6. 变更日志

> 只记录**设计层面**的变更（影响架构、契约、依赖或需求编号的）。代码级改动走 git。

| 日期 | 变更 | 原设计 | 现设计 | 理由 | 影响文档 |
|---|---|---|---|---|---|
| 设计定稿时 | **TTS 引擎替换** | 施工图：Fish Audio 云 TTS（按量付费） | edge-tts（首选）+ Windows SAPI（兜底），全本地免费 | 零成本、离线可用、隐私不出本机；适配器保留云端扩展位（[D-03](01-architecture-design.md)） | [README 差异表](../README.md) · [设计总览 §7](01-architecture-design.md) · [04-tts-pipeline](04-tts-pipeline.md) |
| 设计定稿时 | **大脑替换** | 施工图：`claude -p --output-json`（Claude 订阅，无 API key） | `dsh --profile dj-brain --json`（本地 DSH 无头，走账号态） | 复用已有 DSH 账号态，零额外 API 成本；已验证 `--json` 事件流与 `--session-id` 多轮记忆（[D-01](01-architecture-design.md)、[D-02](01-architecture-design.md)） | [README 差异表](../README.md) · [05-brain-adapter](05-brain-adapter.md) |
| 设计定稿时 | **音乐来源替换** | 施工图：自建 `NeteaseCloudMusicApi` | 公共实例 `music-api.gdstudio.xyz` + 多适配器降级链 | 省去部署运维；代价是外部可用性风险，用降级链与本地兜底音频对冲（[D-04](01-architecture-design.md)） | [README 差异表](../README.md) · [06-music-provider](06-music-provider.md) · [Q-01](01-architecture-design.md) |
| 设计定稿时 | **音源白名单收敛** | 未指定音源 | `MUSIC_SOURCES=netease,joox` | 实测 `kuwo`/`tencent`/`migu`/`kugou` 返回 400/503，默认不启用，避免无谓重试拖长解析时间 | [.env.example](../config/.env.example) · [风险 R-01](11-risk-register.md) |
| 设计定稿时 | **播放元素数量** | 未指定 | 单 `<audio>` 串行（[D-05](01-architecture-design.md)） | 移动浏览器对同时多路播放有硬限制；衔接 gap ≤ 800ms 可控 | [08-pwa-frontend](08-pwa-frontend.md) · [风险 R-13](11-risk-register.md) |
| 设计定稿时 | **测试框架** | 未指定 | Node 内置 `node --test`，**不引入 jest/vitest** | 零依赖、零配置、启动快；配合 `BRAIN_REPLAY_DIR` 等回放开关即可满足分层测试需求 | [package.json](../package.json) · [12-testing-strategy](12-testing-strategy.md) |
| 设计定稿时 | **包管理器** | 未指定 | npm（本机**无 pnpm**） | 实测环境无 pnpm；npm 10.9.0 已满足全部需求，不额外安装 | [README 技术栈](../README.md) |
| **已实测修复** | **环境变量加 `CLAUDIAO_` 前缀** | `DSH_BIN` / `DSH_PROFILE` / `DSH_CWD`（无前缀） | `CLAUDIAO_DSH_BIN` / `CLAUDIAO_DSH_PROFILE` / `CLAUDIAO_DSH_CWD` | **实测 bug**：DeepSeek Harness 自身会向进程环境注入 `DSH_PROFILE=desktop`（以及 `DSH_HOME`、`DSH_SESSION_ID`）。本项目若用同名变量，从 DSH 内部启动电台时 `.env` 的值被静默覆盖，大脑报 `error: profile "desktop" is managed exclusively by the Electron application`。加前缀后与 DSH 自身变量彻底隔离。`DSH_HOME` **不加**前缀（那是 DSH 的变量，本项目只读） | [.env.example](../config/.env.example) · [09 准备清单 §3 硬规则](09-requirements-checklist.md) · [13 部署运维](13-deployment-ops.md) |
| <!-- 后续变更追加于此 --> | | | | | |

---

## 7. 交叉引用

- 每个任务对应的验收细节与素材准备：[需求与准备清单](09-requirements-checklist.md)
- 任务受阻时查对应风险的缓解与应急：[风险登记册](11-risk-register.md)
- 任务「完成」的判定依据（E2E 编号、fixture、质量门禁）：[测试策略](12-testing-strategy.md)
- M7 的部署与自启细节：[部署与运维](13-deployment-ops.md)

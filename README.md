# Claudiao · 个人 AI 音乐电台

> 听懂你的习惯 → 规划声音 → 像 DJ 那样播报
>
> 一套跑在你自己机器上的私人电台：AI 大脑做决策，本地管线做声音，浏览器当收音机。

---

## 这是什么

Claudiao 是一台**只有你一个听众**的电台。它做四件事：

1. **懂你** —— 用你亲手写的品味语料（`taste.md` / `routines.md` / `playlists.json` / `mood-rules.md`）当上下文，而不是靠算法猜。
2. **会想** —— 由**大脑**（ZCode Agent 无头协议，复用 bigmodel 编码计划账号态）在每次触发时读上下文、做规划，产出结构化的播报脚本。
3. **能说** —— 本地免费 TTS 把你的专属 DJ 声音合成为音频缓存，不花钱、不联外网。
4. **像电台** —— 播报 + 音乐无缝衔接，通过 WebSocket 推给浏览器，手机上也能当收音机听。

## 与原始施工图的差异（重要）

施工图（`docs/assets/blueprint-original.jpg`）是按 **Claude Code 云订阅** + **Fish Audio 云 TTS** 画的。本项目的落地版本做了两处**有意的架构替换**，其余四层结构完全保留：

| 施工图原设计 | 本项目落地 | 为什么 |
|---|---|---|
| `BRAIN` = `claude -p --output-json`（Claude 订阅，无 API key） | `BRAIN` = **ZCode Agent**（`zcode.cjs app-server --stdio` 协议，复用 bigmodel 编码计划账号态，`src/adapters/brain/zcode-agent.js`） | 复用你已有的 ZCode 桌面端登录态，零额外 API 成本；实测端到端 12~20s/轮、多轮记忆可用。旧版 `dsh --profile dj-brain` 方案保留在 `config/.env` 回滚参考里 |
| `TTS` = Fish Audio（云端，按量付费） | `TTS` = **本地免费**（edge-tts 优先，Windows SAPI 兜底） | 零成本、离线可用、隐私不出本机 |
| `MUSIC` = 自建 NeteaseCloudMusicApi | `MUSIC` = **公共 API 实例**（`music-api.gdstudio.xyz`），多源可切换 | 省去部署运维；但引入外部可用性风险，故设计了多适配器与降级链 |

> 三处替换都做成了**适配器接口**（`BrainAdapter` / `TtsAdapter` / `MusicProvider`）。将来想换回 Claude Code、dsh 或自建网易云 API，只需要新增一个适配器实现，业务层不动。

## 四层架构一图流

```
┌─ 第一层 · 外部上下文 ────────────────────────────────────────────────┐
│  USER/ 品味语料          │  BRAIN  ZCode Agent（bigmodel 账号态）     │
│  taste / routines        │  zcode.cjs app-server --stdio            │
│  playlists / mood-rules  │  （替换 claude -p --output-json）         │
│  MUSIC  公共音乐 API      │  VOICE·I/O  本地 TTS · 天气 · 日历 · 投送  │
└──────────────────────────┴──────────────────────────────────────────┘
                              ↓
┌─ 第二层 · 本地大脑（Node 常驻进程）──────────────────────────────────┐
│  ROUTER.JS 意图分流  │ CONTEXT.JS 提示词组装 │ BRAIN.JS 大脑适配器   │
│  SCHEDULER.JS 节律   │ TTS.JS 声音管线      │ STATE.DB 状态·记忆     │
└─────────────────────────────────────────────────────────────────────┘
                              ↓
┌─ 第三层 · 运行时粘合（CONTEXT BINDOW）──────────────────────────────┐
│  ① 系统提示词 ② 用户语料 ③ 环境注入                                  │
│  ④ 已检索记忆 ⑤ 用户输入/工具结果 ⑥ 执行轨迹                          │
│  → 组装成一次 compute() 调用                                         │
└─────────────────────────────────────────────────────────────────────┘
                              ↓
┌─ 第四层 · 交互表层 ─────────────────────────────────────────────────┐
│  PWA @ localhost:8080    │  HTTP CONTRACT  6 条线 + WS /stream      │
│  Player/Profile/Settings │  /api/chat /api/now /api/next /api/taste  │
│  Service Worker · 单 <audio>│  /api/plan/today · WS /stream          │
└─────────────────────────────────────────────────────────────────────┘
```

## 快速开始

```powershell
# 1. 确认大脑可用（这是整个项目的发动机；前提是 ZCode 桌面端已登录）
node tools\brain-smoke.js

# 2. 安装依赖
npm install

# 3. 复制环境变量模板
Copy-Item config\.env.example config\.env

# 4. 启动电台服务
npm start          # → http://localhost:8080
```

详细步骤见 [docs/00-quick-start.md](docs/00-quick-start.md)。

## 已可用的验证工具

设计阶段就把「怎么证明它对」工具化了。以下命令**现在就能跑**（不需要等 `src/` 实现完）：

| 命令 | 作用 | 当前状态 |
|---|---|---|
| `npm run doctor` | 环境自检：Node/Python/大脑依赖/音色/语料/端口，25 项检查 | ✅ 通过 |
| `npm run doctor:deep` | 追加真实音乐 API 探测 | ✅ 通过 |
| `npm run brain:smoke` | 大脑契约回归：app-server 协议、会话记忆、`DjAction` 四字段 | ✅ 通过（首轮 ~10s，复用轮 ~0.7s） |
| `npm run brain:ask "下雨了"` | 直接问大脑，按六片 prompt 组装并打印播报/选曲/理由 | ✅ 可用 |
| `npm run music:check` | 音乐链路健康：search/url/lyric/pic/playlist + 端到端解析 | ✅ 通过 |
| `npm run music:resolve "李志 - 下雨"` | 单曲解析，可 `--show-candidates` 看打分与噪声过滤 | ✅ 可用 |
| `npm run tts:list-voices` | 列出 edge-tts 中文音色并标注电台推荐 | ✅ 8 个中文音色 |
| `npm run tts:warm` | 预热固定播报的 TTS 缓存（实测 ~2.9s/句） | ✅ 可用 |
| `npm run validate:playlists` | 校验曲目池格式与悬空引用 | ✅ 11 歌单 70 曲目 |
| `npm run validate:docs` | 文档体系一致性（链接、锚点、术语、取值） | ✅ 0 FAIL |
| `npm run db:migrate` | 状态库现状检查（建表待 M0） | ✅ 可用 |
| `npm run backup` | 备份语料/配置/状态/大脑配置 | ✅ 可用 |
| `npm test` | 回放测试：12 个大脑 fixture + 4 个音乐场景，零出网 | ✅ 21 断言通过（226ms） |
| `npm run fixtures:brain` | 用真实大脑重录 fixture（含场景意图自检） | ✅ 12 场景 |
| `npm run fixtures:music` | 重录音乐 API fixture（含翻唱噪声样本） | ✅ 16 文件 |

> 其中 `brain-smoke` 与 `music-check` 是**契约回归**工具：ZCode 桌面端或音乐实例升级后
> 先跑它们，能立刻区分「是外部变了还是我代码坏了」。

## 文档地图

**设计与契约**

| 文档 | 内容 |
|---|---|
| [设计总览](docs/01-architecture-design.md) | 需求、四层还原、模块职责、数据流、时序、状态机 |
| [模块详细设计](docs/02-module-spec.md) | 六个模块的输入/输出/算法/错误处理 |
| [接口契约与数据模型](docs/03-api-contract.md) | HTTP 6 条线、WS 协议、`dj-action/v1`、SQLite DDL |
| [TTS 声音管线](docs/04-tts-pipeline.md) | edge-tts/SAPI 适配器、缓存、流水线时序 |
| [大脑适配器](docs/05-brain-adapter.md) | ZCode Agent 协议集成、prompt 组装、解析与容错 |
| [音乐提供方](docs/06-music-provider.md) | 公共 API 契约、多源降级、版权与合规边界 |
| [调度与节律](docs/07-scheduler-rhythm.md) | 07:00 规划 / 09:00 早间 / 小时情绪检查、幂等与补跑 |
| [前端 PWA](docs/08-pwa-frontend.md) | 三视图、单 `<audio>` 播放器、Service Worker、离线 |

**执行与运维**

| 文档 | 内容 |
|---|---|
| [需求与准备清单](docs/09-requirements-checklist.md) | 软硬件、账号、素材、逐项验收标准 |
| [进度表](docs/10-progress-tracker.md) | 里程碑、任务拆解、依赖、完成定义 |
| [风险登记册](docs/11-risk-register.md) | 风险、概率、影响、缓解、触发条件 |
| [测试策略](docs/12-testing-strategy.md) | 单元/契约/回放/端到端、验收用例 |
| [部署与运维](docs/13-deployment-ops.md) | 开机自启、日志、备份、升级、故障排查 |

**语料（喂给大脑的真实上下文）**

| 文件 | 作用 |
|---|---|
| [dj-persona.md](knowledge/prompts/dj-persona.md) | 系统提示词：DJ 人格与输出契约 |
| [taste.md](knowledge/user/taste.md) | 音乐品味 |
| [routines.md](knowledge/user/routines.md) | 作息节律 |
| [mood-rules.md](knowledge/user/mood-rules.md) | 情绪→选曲规则 |
| [playlists.json](knowledge/user/playlists.json) | 歌单与曲目池 |

## 提交规范

代码提交遵循 Conventional Commits 中文规范：`feat(scope): 描述` / `fix(scope): 描述`。
类型表、scope 模块表、subject 写法与真实示例见 [提交规范](docs/COMMIT_CONVENTION.md)。
**红线**：`config/.env`（密钥）与 `data/`（运行时数据）永远不入库；提交前 `npm test` 全绿。

## 技术栈

| 层 | 选型 | 说明 |
|---|---|---|
| 运行时 | Node.js ≥ 22.5（本机 22.11） | 需要内置 `node:sqlite`；施工图的 `.js` 模块全部保留 JS |
| 大脑 | ZCode Agent（`zcode.cjs app-server --stdio`） | 复用 ZCode 桌面端 bigmodel 编码计划账号态；GLM-5.3-Flash，多轮会话记忆 |
| HTTP | Express 4 | 6 条 API + 静态资源 + `/tts/*.mp3` |
| 实时 | `ws` | `/stream` 推 now-playing |
| 状态 | SQLite（`better-sqlite3`） | messages/plays/plan/prefs 四表 |
| 音乐 | 网易云开放平台（个人版，元数据/搜索/推荐）+ `gdstudio` 公共实例（直链） | 开放平台个人应用无播放直链权限（见 docs/05a）；直链实测仅 `netease` 源可用 |
| TTS | Python `edge-tts` → Windows SAPI | 本地、免费、离线兜底 |
| 前端 | 原生 PWA（无框架） | 单 `<audio>` + Service Worker |
| 依赖总数 | 5 个运行时依赖 | `express` `ws` `better-sqlite3` `js-yaml` `dotenv`；测试用内置 `node --test` |

> 依赖刻意压到 5 个。调度用自研 tick（不引 `node-cron`），压缩用 PowerShell 的
> `Compress-Archive`（不引 `archiver`），测试用 `node --test`（不引 jest/vitest）。

## 目录结构

```
D:\DJ
├─ docs/                # 14 份设计文档
│  └─ assets/           # 施工图原件
├─ knowledge/           # 喂给大脑的语料（施工图的 USER/ 目录）—— 电台的灵魂
│  ├─ user/             #   taste / routines / playlists / mood-rules
│  └─ prompts/          #   dj-persona 系统提示词
├─ config/              # .env（机密）+ radio/routines/calendar.yml（行为调参）
├─ src/                 # 业务代码
│  ├─ layer2/           #   施工图第二层：router/context/brain/tts/scheduler/state（待实现）
│  ├─ adapters/brain/   #   zcode-agent.js —— ZCode Agent 大脑适配器（已实现）
│  ├─ adapters/         #   tts 适配器（待实现）
│  └─ providers/        #   music / weather / calendar 提供方
├─ web/                 # ← 待实现：PWA 三视图
├─ tools/               # 验证与运维工具（已全部通过）
├─ scripts/             # 旧版 dsh profile 安装脚本（回滚用）
├─ data/                # 运行时数据（SQLite、TTS 缓存、日志、兜底音频、brain-session.json）
└─ tests/               # 测试（fixture 回放驱动）
```

## 状态

**设计完成 · 环境与契约已验证 · 业务代码分模块推进中**

| 部分 | 状态 |
|---|---|
| 设计文档（14 份） | ✅ 完成，`npm run validate:docs` 通过 |
| 语料（`knowledge/`） | ✅ 完成，可直接编辑使用 |
| 配置（`config/`） | ✅ 完成，`.env.example` 含全部实测结论 |
| 大脑集成 | ✅ **实测可用**（ZCode Agent，bigmodel 编码计划账号态，GLM-5.3-Flash，low 档 12~20s/轮） |
| TTS 集成 | ✅ **实测可用**（edge-tts 8 个中文音色，~2.9s/句，缓存已验证） |
| 音乐集成 | ✅ **实测可用**（search/url/lyric/pic/playlist + 端到端出直链） |
| 验证工具 | ✅ 完成并全部通过 |
| 测试底座与 fixture | ✅ 完成：12 个大脑场景（6 真实录制）+ 4 个音乐场景；`npm test` 21 断言通过，零出网 |
| `src/` 业务代码 | ◐ 大脑适配器已完成；layer2/其余适配器待实现（M0–M7，见 [进度表](docs/10-progress-tracker.md)） |
| `web/` 前端 | ⬜ 未开始 |

下一步按 [进度表](docs/10-progress-tracker.md) 从 **M0 地基** 开始；`M1`（大脑）适配器已就绪，
`M2`（声音）可与之并行，因为二者的适配器互不依赖。

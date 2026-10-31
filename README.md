# Claudiao · 个人 AI 音乐电台

> 一台只有你一个听众的电台：你说一句话，Valen（你的私人 DJ）选曲、聊音乐、实时唱票根——全部跑在你自己的机器上。

## 这是什么

Claudiao 把「听歌」变成「听电台」：

- **说句话就点歌** —— 「来点雨天适合的歌」「我想一直听 The Weeknd」，DJ 用一句话接住你的情绪并选好曲；
- **每一首歌都有口播** —— DJ 压着音乐介绍这首歌为什么此刻属于你；
- **品味会生长** —— 基于你的品味语料、网易云喜欢/听歌排行、最近播放前 100 首三层来源自动生成并持续贴合你最新的听歌风格；
- **近三日不重复** —— 推荐记忆文件记录所有推过的歌，三天内绝不炒冷饭；
- **早/中/晚开场白** —— 每个时段第一次开口，Valen 会问好、自我介绍并点出本期节目主题。

## 工作原理（30 秒版）

```
你在网页说一句话
   ↓  意图分流（点播 / 情绪 / 闲聊 / 控制）
大脑：你的 API（BigModel / DeepSeek / Kimi …，Anthropic 协议直连）
   ↓  输出 JSON：开场白 + 3~5 首选曲 + 每首的口播稿
音乐解析（网易云登录态直链 → gdstudio 兜底）＋ TTS 合成（edge-tts → SAPI 兜底）
   ↓  WebSocket 推给浏览器
网页电台：点阵时钟 · 逐词 DJ 字幕 · 队列 · 单行歌词 · 聊天流
```

三条品味来源喂给大脑：**品味语料**（`knowledge/user/taste.md`，可编辑）、**品味画像**（网易云喜欢+听歌排行自动生成）、**最近播放前 100 首**（启动时生成，反映阶段性口味）。选曲再经三道硬过滤：24 小时播放去重、**近三日推荐记忆去重**、同艺人单批最多 1 首（你点名除外）。

## 快速开始

前提：Windows + Node.js ≥ 22.5 + Python（edge-tts 主音色可选，SAPI 本地兜底无需 Python）。

```powershell
# 1. 安装依赖
npm install

# 2. 配置环境
Copy-Item config\.env.example config\.env
#   编辑 config\.env，填入 BIGMODEL_API_KEY（https://open.bigmodel.cn 控制台获取）
#   也可以启动后在网页「设置 → BRAIN API」里可视化填 Key

# 3. 启动（自动结束旧实例）
npm start                # → http://localhost:8080

# 4. 网页「设置」里扫码登录网易云账号（品味自动生成依赖它）
```

打开网页，说一句「随便放点」，电台就开张了。

## 常用命令

| 命令 | 作用 |
|---|---|
| `npm start` | 启动电台（自动结束旧实例，单实例接管） |
| `npm run stop` | 结束正在运行的后端 |
| `npm run dev` | watch 模式启动（改代码自动重启） |
| `npm test` | 全量测试（零出网） |
| `npm run doctor` | 环境自检（Node/TTS/大脑/音色/语料/端口） |
| `npm run brain:smoke` | 大脑契约回归 |
| `npm run music:check` | 音乐链路健康 |
| `npm run tts:list-voices` | 列出 edge-tts 可用音色 |
| `npm run backup` | 备份语料/配置/状态 |

## 设置页能配什么

- **BRAIN API** —— 供应商下拉（智谱 / DeepSeek / Kimi / OpenAI / 通义 / 自定义 Anthropic 兼容端点）、模型（可实时拉取该 Key 的真实可用列表）、Key 本机保存、测试连接、保存即热切换；
- **NETEASE ACCOUNT** —— 扫码登录（二维码仅在未登录时出现），登录后显示昵称；
- 配置存在本机数据库，Key 永不上传。

## 目录结构

```
D:\DJ
├─ docs/                # 设计文档（01 架构 … 14 网易云 Cookie 源）
├─ knowledge/           # 喂给大脑的语料 —— 电台的灵魂
│  ├─ user/             #   taste.md（品味，可编辑）/ routines / mood-rules / taste-profile.md
│  └─ prompts/          #   dj-persona 系统提示词
├─ config/              # .env（密钥）+ radio/routines/calendar.yml（行为调参）
├─ src/
│  ├─ server.js         # Express + WS：6 条 API + 静态资源
│  ├─ main.js           # 服务入口（依赖组装 + 单实例接管）
│  ├─ layer2/           # 业务层：router/context/brain/tts/compute/scheduler/state/
│  │                    #   recent-catalog（最近播放100首）/ recommend-memory（三日去重）/ taste
│  ├─ adapters/
│  │  ├─ brain/         #   direct-api（直连，主）/ zcode-agent（兜底）
│  │  └─ tts/           #   edge-tts / SAPI 兜底
│  └─ providers/music/  #   网易云 Cookie 源 + gdstudio 公共源
├─ web/                 # 前端：点阵时钟/逐词字幕/队列/聊天流（原生 PWA）
├─ tools/               # 验证与运维工具
├─ data/                # 运行时数据（SQLite/TTS 缓存/日志/推荐记忆，gitignore）
└─ tests/               # node --test 单测（零出网）
```

## 技术栈

| 层 | 选型 |
|---|---|
| 运行时 | Node.js ≥ 22.5（better-sqlite3 需要） |
| 大脑 | Anthropic 协议直连（BigModel / DeepSeek / Kimi …），GLM-5-Turbo 默认，单轮 ~10s |
| 音乐 | 网易云 Cookie 源（登录态直链）→ gdstudio 公共实例兜底 |
| TTS | edge-tts（联网，音质好）→ Windows SAPI（本机，离线兜底） |
| HTTP/实时 | Express 4 + ws（`/stream`） |
| 状态 | SQLite（better-sqlite3，四表） |
| 前端 | 原生 PWA（无框架；点阵时钟/波形/字幕全部手写 canvas/CSS） |
| 依赖总数 | 5 个运行时依赖（express/ws/better-sqlite3/js-yaml/dotenv） |

## 文档地图

设计与契约细节在 [docs/](docs/)：架构（01）、模块（02）、API 契约（03）、TTS 管线（04）、大脑适配器（05）、音乐源（06）、调度（07）、前端（08）、部署运维（13）、网易云 Cookie 源（14）。提交规范见 [docs/COMMIT_CONVENTION.md](docs/COMMIT_CONVENTION.md)。

## 提交规范

Conventional Commits 中文规范：`feat(scope): 描述` / `fix(scope): 描述`。**红线**：`config/.env`（密钥）与 `data/`（运行时数据）永远不入库；提交前 `npm test` 全绿。

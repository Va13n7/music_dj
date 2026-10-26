# 快速开始

> 从零到听见 Claudiao 说话。全程约 15 分钟。
> 上游依据：[设计总览](01-architecture-design.md) · [README](../README.md)

---

## 0. 前置检查（2 分钟）

本项目的三个外部依赖都有**已验证的本地默认方案**，理论上开箱即用。先跑一遍自检：

```powershell
cd D:\DJ
npm run doctor
```

`doctor` 会逐项检查下表内容并给出修复提示。如果你想手动确认，对照这张表：

| 检查项 | 验证命令 | 期望结果 | 本机状态 |
|---|---|---|---|
| Node ≥ 22.5 | `node --version` | `v22.x` 或更高（需要内置 `node:sqlite`） | ✅ v22.11.0 |
| npm | `npm --version` | 任意 | ✅ 10.9.0 |
| Python | `python --version` | `3.10`+ | ✅ 3.12.6 |
| `edge-tts` | `edge-tts --version` | 输出 7.x | ✅ 7.3.1 |
| 大脑（ZCode Agent） | `node tools/brain-smoke.js` | 全部断言通过 | ✅ 已验证 |
| 音乐 API | `node tools/music-check.js` | 各 endpoint 全绿 | ⏳ 待首次运行 |
| `data/` 可写 | 自动检查 | 可写 | ✅ |

### 大脑的前提：ZCode 桌面端已登录

电台的「大脑」复用 **ZCode 桌面端**（`E:\Program Files\ZCode`）的 bigmodel 编码计划账号态。
前提只有一个：桌面端至少安装并登录过一次。适配器需要的两样东西都在 `~/.zcode/v2/` 下：

| 文件 | 作用 |
|---|---|
| `~/.zcode/v2/credentials.json` | 编码计划凭据（适配器解出 API key，与桌面端共享登录态） |
| `~/.zcode/v2/runtime/provider/.../zcode-builtin.json` | provider 模板缓存（桌面端联网刷新，适配器自动发现最新版） |

验证大脑一条链路是否通：

```powershell
node tools\brain-smoke.js
```

期望输出结尾：`结果: 通过 —— 大脑（ZCode Agent）可用且契约符合预期。`

> 旧版 `dsh`（DeepSeek Harness 无头 profile）方案已停用，回滚方式见 `config/.env` 末尾的「回滚参考」段。

---

## 2. 安装依赖（3 分钟）

```powershell
cd D:\DJ
npm install
```

会安装 5 个运行时依赖：`express` `ws` `better-sqlite3` `js-yaml` `dotenv`。

> `better-sqlite3` 含原生模块，首次安装会尝试下载预编译包或本地编译。
> 若失败，见文末「故障排查」。

---

## 3. 配置（3 分钟）

```powershell
Copy-Item config\.env.example config\.env
notepad config\.env
```

**最少需要确认这两项**（其余保持默认即可跑起来）：

| 变量 | 值 | 说明 |
|---|---|---|
| `CLAUDIAO_ZCODE_CLI` | `E:\Program Files\ZCode\resources\glm\zcode.cjs` | ZCode 桌面端自带 CLI 的绝对路径 |
| `CLAUDIAO_ZCODE_CWD` | `D:\DJ` | 大脑工作目录，**必须**是项目根 |

> **⚠️ 为什么变量名带 `CLAUDIAO_` 前缀？不要去掉它。**
> ZCode 桌面端/CLI 自身也会注入一批 `ZCODE_*` 环境变量（`ZCODE_BASE_URL`、
> `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` 等）。本项目的大脑变量统一用 `CLAUDIAO_` 前缀，
> 与它们彻底隔离——无论从哪个终端、是否在 ZCode 里启动电台都不会互相踩。

**建议顺手确认的**：

| 变量 | 默认 | 说明 |
|---|---|---|
| `CLAUDIAO_ZCODE_REASONING` | `low` | 大脑推理档。实测 low 12~20s/轮且质量达标；high/max 40~55s+ |
| `BRAIN_TIMEOUT_MS` | `60000` | 单次大脑调用超时。Agent 档位下不要低于 60s |
| `TTS_VOICE` | `zh-CN-XiaoxiaoNeural` | 电台音色。换男声试 `zh-CN-YunxiNeural` |
| `MUSIC_SOURCES` | `netease,joox` | 实测这两个源可用 |
| `WEATHER_API_KEY` | 空 | 留空则播报不提天气，不影响运行 |
| `TZ` | `Asia/Shanghai` | 影响所有时段判断 |

**建议顺手确认的**：

| 变量 | 默认 | 说明 |
|---|---|---|
| `TTS_VOICE` | `zh-CN-XiaoxiaoNeural` | 电台音色。换男声试 `zh-CN-YunxiNeural` |
| `MUSIC_SOURCES` | `netease,joox` | 实测这两个源可用 |
| `WEATHER_API_KEY` | 空 | 留空则播报不提天气，不影响运行 |
| `TZ` | `Asia/Shanghai` | 影响所有时段判断 |

### 关于访问令牌

默认 `HOST=127.0.0.1`，只有本机能访问，`RADIO_AUTH_TOKEN` 可留空。

**想让手机连上电台**时：

```powershell
# 生成令牌
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

然后把 `HOST` 改成 `0.0.0.0`，并把生成的令牌填进 `RADIO_AUTH_TOKEN`。
手机访问 `http://<你电脑的局域网IP>:8080/?token=<令牌>`。

> ⚠️ 改成 `0.0.0.0` 且不加令牌 = 同一局域网内任何人都能控制你的电台、读你的品味语料。不要这么做。

---

## 4. 准备兜底音频（5 分钟，可选但推荐）

**这是唯一需要你自己准备素材的一项。**

当所有音乐源都解析失败时（公共 API 挂了、直链过期、版权受限），电台会播放 `data/fallback-audio/` 里的音频，保证**永远不静音**（设计总览 §5.2）。

```powershell
# 把你自己拥有的、或无版权（CC0 / Public Domain）的音频放进来
Copy-Item "你的音乐\*.mp3" data\fallback-audio\
node tools\doctor.js --check-fallback
```

| 要求 | 说明 |
|---|---|
| 格式 | `.mp3` 或 `.wav` |
| 数量 | ≥ 5 首，避免连续降级时反复播同一首 |
| 命名 | 无特殊要求，但建议 `艺人 - 曲名.mp3` 以便在日志里辨认 |
| 来源 | 你自己的音乐、CC0 音源（如 Free Music Archive 的 CC0 区）、或自己录的环境音 |

> 不准备也能跑 —— 只是降级时会直接跳过音乐，只剩播报。

---

## 5. 启动（30 秒）

```powershell
npm start
```

期望输出：

```
[radio] 配置已装载  brain=zcode-agent  model=GLM-5.3-Flash  tz=Asia/Shanghai
[radio] 状态库已就绪  data/radio.db
[radio] 大脑自检通过  ZCode Agent (bigmodel 编码计划)
[radio] TTS 就绪  引擎=edge  音色=zh-CN-XiaoxiaoNeural
[radio] 音乐源就绪  netease, joox
[radio] 调度已装载  8 个槽位（静默 23:00–07:00）
[radio] 电台已开播  http://127.0.0.1:8080
```

---

## 6. 听见它（2 分钟）

打开 <http://127.0.0.1:8080>。

### 6.1 解锁音频

浏览器禁止无用户交互的自动播放。所以第一次进页面会看到一个 **「点一下开始收听」** 的按钮 —— **必须点它**，否则后面所有播报都会被浏览器静默拦截。

> 这是浏览器的硬限制，不是 bug。点一次之后，本次会话内不再需要。

### 6.2 第一次点播

在输入框里打一句话，比如：

```
下雨了，来点安静的
```

**应该看到/听到**：

| 时间 | 现象 |
|---|---|
| ~0.1s | 状态变成 `THINKING`（界面上有思考指示） |
| ~5–8s | 状态变成 `SPEAKING`，**先听到 DJ 播报**（约 5–10 秒语音） |
| 播报结束后 | 状态变成 `PLAYING`，**无缝开始放第一首歌** |
| 全程 | 界面显示「DJ 为什么放这首」（`reason` 字段） |

> **为什么先说话再放歌？** 这是「像 DJ」而非「像播放器」的核心。见 [设计总览 §4.1](01-architecture-design.md#41-主链路一次自然语言点播)。

### 6.3 试试其他输入

| 输入 | 预期行为 |
|---|---|
| `下一首` | 不打扰大脑，直接推队列（`control` 意图直连） |
| `现在在放什么` | 查状态库回答（`query` 意图直连） |
| `今天有什么安排` | 读日历与今日规划，`play` 为空数组（纯口播） |
| `放点带劲的` | 情绪档切换，能量提升 |
| `随便` | DJ 自主决定，并在 `reason` 里说明判断依据 |

---

## 7. 验证降级链（5 分钟，推荐做一次）

电台的核心体验是「一直在响」，所以每条降级路径都值得亲手验一次：

| 验证 | 操作 | 期望 |
|---|---|---|
| 大脑降级 | 临时把 `config/.env` 的 `CLAUDIAO_ZCODE_CLI` 改成不存在的路径，重启，点播 | 听到**模板播报**而非静音，日志有 `brain degraded` 告警 |
| TTS 降级 | 临时把 `CLAUDIAO_EDGE_TTS_BIN` 改成不存在的路径，重启，点播 | 走 SAPI 兜底音色（音质明显变化但仍有声）；若 SAPI 也禁用则**直接放歌** |
| 音乐降级 | 临时把 `MUSIC_BASE_URL` 改成无效地址，重启，点播 | 播放 `data/fallback-audio/` 里的音频 |
| 断网 | 关掉网络，点播 | 已有 TTS 缓存与已解析曲目仍能播 |

**验完记得把配置改回来。**

---

## 8. 让电台主动开口（可选）

定时播报默认已启用。不想等到明早验证，可以手动触发：

```powershell
# 手动触发早间播报（忽略时间窗口）
curl "http://127.0.0.1:8080/api/chat" -Method POST -ContentType "application/json" -Body '{"text":"立即执行一次早间播报"}'
```

调度槽位定义在 `config/routines.yml`，语义说明在 [调度与节律](07-scheduler-rhythm.md)。

---

## 故障排查

| 症状 | 原因 | 解决 |
|---|---|---|
| `Select a model before continuing` / `Provider Registry 中不存在 Model` | 大脑的账号 provider 没推送成功（ZCode 桌面端没登录过，或 `~/.zcode/v2/` 缺缓存） | 打开 ZCode 桌面端登录一次后重跑 `node tools\brain-smoke.js` |
| `凭据里没有 ... 的 API key` | 共享凭据解不出编码计划 API key | 确认桌面端登录的是 bigmodel 编码计划账号；或在 `config/.env` 手动填 `CLAUDIAO_ZCODE_API_KEY` |
| `No such built-in module: node:sqlite` | Node < 22.5 | 升级 Node ≥ 22.5 |
| brain turn 超时 | 推理档太高或 `BRAIN_TIMEOUT_MS` 太小 | `CLAUDIAO_ZCODE_REASONING=low`；`BRAIN_TIMEOUT_MS=60000` |
| `Session is not active: sess_...` | 持久化的会话已失效（升级/清理后） | 删 `data/runtime/brain-session.json`，下次调用自动新建 |
| 页面无声音，日志显示播报已合成 | 浏览器 autoplay 未解锁 | 点页面的「点一下开始收听」按钮 |
| `better-sqlite3` 安装失败 | 缺编译工具链 | `npm i --build-from-source` 或安装 VS Build Tools；也可换 `node-sqlite3-wasm` |
| 端口 8080 被占用 | 其他服务在用 | 改 `config/.env` 的 `PORT`；同时改 `web/` 里的 WS 地址 |
| 播报声音机械 | 走了 SAPI 兜底（`Huihui`），说明 edge-tts 失败 | 检查 `CLAUDIAO_EDGE_TTS_BIN` 路径；手动跑 `edge-tts --list-voices` 看是否可用 |
| 音乐全部解析失败 | 公共实例挂了或改了接口 | 看 `data/logs/` 的错误码；确认 `MUSIC_SOURCES` 含 `joox`；短期靠兜底音频 |
| 定时播报没响 | 落在静默时段或免打扰窗口 | 查 `config/routines.yml` 的 `quietHours` / `doNotDisturb`；看日志里该 slot 是否被标记 `skipped` |

更多排查手段见 [部署与运维](13-deployment-ops.md)。

---

## 下一步

- 把 `knowledge/user/` 里的四个语料文件**改成你自己的** —— 这是让电台真正属于你的唯一途径。写得越具体，DJ 越准。
- 通读 [设计总览](01-architecture-design.md) 了解全貌。
- 看 [进度表](10-progress-tracker.md) 了解实现排期。

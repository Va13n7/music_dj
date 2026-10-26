# Claudiao · 测试策略

> 文档版本 v1.0 · 状态：设计完成，测试代码未实现（`tests/` 目录为空；已实现的工具有 [tools/brain-smoke.js](../tools/brain-smoke.js) 与 [tools/validate-playlists.js](../tools/validate-playlists.js)）
> 上游唯一权威来源：[设计总览](01-architecture-design.md)（需求编号 F-01~F-11 / N-01~N-07、降级链 §5.2、状态机 §8、决策 D-01~D-08、未决问题 Q-01~Q-05 全部沿用）
> 关联：[接口契约](03-api-contract.md) · [需求与准备清单](09-requirements-checklist.md) · [进度表](10-progress-tracker.md) · [风险登记册](11-risk-register.md)

**第一原则：`npm test` 必须能在完全断网、无 DSH 凭据、无 edge-tts 的机器上全绿。** 一切真实外部调用都只能出现在 `--deep` 的手工冒烟里，不能出现在测试里。

---

## 1. 测试分层

| 层 | 范围 | 工具 | 运行命令 | 目标覆盖率 | 目标时长 | 是否出网 |
|---|---|---|---|---|---|---|
| **单元** | `src/layer2/` 的纯函数与状态逻辑：router 分类、DjAction 校验、context 组装、状态机迁移、缓存键、去重与权重、调度时间计算 | `node --test` + `node:assert/strict`，无 mock 框架（手写桩） | `npm run test:unit` | `src/layer2/**` 行覆盖 ≥ 80%；`router.js` / `brain.js` 校验逻辑 / `state.js` 分支覆盖 ≥ 90% | ≤ 5s | ❌ |
| **契约** | HTTP 6 条线的请求/响应 schema；WS `/stream` 事件序列与 schema；`dj-action/v1`；SQLite DDL 与约束 | `node --test` + `node:http` 起真实 server（依赖全部换成 Fake） | `npm run test:contract` | 每条线至少 1 正例 + 2 反例（缺字段 / 越界 / 未授权） | ≤ 10s | ❌ |
| **回放（fixture 驱动）** | 大脑 NDJSON、TTS 合成、音乐 search/url 三类外部交互：把真实响应录成 fixture，测试时读文件 | `node --test` + `BRAIN_REPLAY_DIR` / `FakeTtsAdapter` / `FakeMusicProvider` | `npm test`（含在总命令里） | 每类外部交互的**每种响应形态**都有 fixture（清单见 §2.3 / §3 / §4） | ≤ 15s | ❌ |
| **端到端** | 完整链路：`POST /api/chat` → compute → （Fake 大脑/TTS/音乐）→ WS 广播 → 客户端状态 | `node --test`，起真实 server 于随机端口，用 `ws` 客户端订阅 | `npm run test:e2e` | §6 的 13 条用例全部通过 | ≤ 60s | ❌ |
| **手工验收** | 真实大脑、真实 TTS、真实音乐 API、真实浏览器与手机 | 人 + `npm run doctor --deep` + `npm run brain:smoke` + `npm run tts:warm` + `npm run music:check` | 无（按 §7 脚本执行） | [09 文档 §5](09-requirements-checklist.md) 的 L1/L2/L3 三档 DoD | 每次 20~30 分钟 | ✅ |

**总命令**：`npm test` = `test:unit` + `test:contract` + `test:e2e`，目标总时长 ≤ 90s，**零出网、零 spawn `dsh`**。

**唯一允许「真调」的自动化脚本**（因为它们本来就是诊断工具，不是测试）：

```powershell
npm run brain:smoke     # 真实调 dsh 一次；已实现并通过，实测 6320 ms
npm run tts:warm        # 真实合成；人工听
npm run music:check     # 真实出网；诊断源可用性
npm run doctor --deep   # 真实探测大脑/TTS/音乐/天气
```

---

## 2. 大脑测试策略（重点）

### 2.1 铁律：CI 里绝不真调 `dsh`

原因（三条都成立，任一条足以否决）：

| 原因 | 具体表现 |
|---|---|
| **慢** | 冷启动实测 5.5s、resume 10.1s。10 条用例就是 1~2 分钟，且会让 `npm test` 失去「随时跑」的价值 |
| **需凭据** | 走 `~/.dsh/.credentials.yaml` 账号态，换机器/凭据过期即全红——测的不是代码而是环境 |
| **不确定** | 模型输出是概率性的：同一 prompt 两次返回的 `say` 不同，无法断言具体文案；`play` 数量也可能变化 |

### 2.2 录制-回放方案

**核心开关：`BRAIN_REPLAY_DIR`。** 设置该环境变量时，`src/adapters/brain/dsh-headless.js` **完全不 spawn 子进程**，而是按 fixture 名读取 `*.ndjson`，逐行 emit 到与真实路径相同的事件流消费者上。要求：

| 要求 | 说明 |
|---|---|
| 零 spawn | 测试用 `child_process` 的 spy 断言 `spawn` 调用次数为 **0**（M1-T4 的验收项） |
| 同一条代码路径 | 回放必须经过**真实的 NDJSON 解析器**，不能为测试另写一条解析捷径——否则测不到解析 bug |
| 可注入延迟 | 每个 fixture 可带 `_meta.delayMs`，用于测试超时逻辑（不需要真等 30s，用可注入的 clock 或极小超时值） |
| 可注入退出码 | fixture 文件名含 `exit1` 时，回放模式也以退出码 1 结束，用于测试错误分支 |
| 可注入 stderr | `*.stderr.txt` 伴随文件，用于测试 `ENOENT` / 凭据过期 / 变量名冲突等错误识别 |

```js
// tests/support/replay-brain.js（示意）
process.env.BRAIN_REPLAY_DIR = new URL('../fixtures/brain', import.meta.url).pathname;
// 此后任何 brain.compute() 都读 fixture，零进程、零网络
```

### 2.3 必需 fixture 清单

存放于 `tests/fixtures/brain/`，命名 `<场景>.ndjson`（可选 `_meta` 头部行）。

| # | 文件名 | 场景 | 内容要点 | 断言点 |
|---|---|---|---|---|
| 1 | `ok-normal.ndjson` | 正常返回 | `session` → `status(turn_start)` → `thinking` → `text`({say,play,reason,segue}) → `status(turn_end, completed)` → `final` | 解析出全部四字段；`play` 元素匹配 `^(?<artist>.+?) - (?<title>.+)$`；耗时字段存在 |
| 2 | `ok-markdown-fenced.ndjson` | 模型用 ```json 代码块包裹 | `final.text` = ` ```json\n{...}\n``` ` | 代码块被剥离后仍能解析（这是最高频的真实畸形） |
| 3 | `ok-empty-play.ndjson` | `play` 为空数组（纯口播，天气/日程场景） | `{"say":"今天小雨…","play":[],"reason":"…"}` | 不报错；`allowEmptyPlay: true` 生效；编排进入纯播报路径 |
| 4 | `ok-with-usage.ndjson` | 带 token 用量事件 | 额外含 `usage`/`turn_end` 中的计数 | 用量被记录到 SQLite（`observability.recordBrainUsage: true`）；缺失 usage 时静默跳过不报错 |
| 5 | `bad-malformed-json.ndjson` | `final.text` 不是合法 JSON（截断：`{"say":"…","play":[`） | 文本以 `{` 开头但 `JSON.parse` 失败 | 抛可重试错误 → 重试 1 次（`BRAIN_RETRY=1`）→ 仍失败走模板播报 |
| 6 | `bad-missing-say.ndjson` | 缺必填字段 `say` | `{"play":["李志 - 下雨"],"reason":"…"}` | schema 校验拒绝；不进入 TTS 阶段 |
| 7 | `bad-overlong-say.ndjson` | `say` 超过 200 字 | `say` 长 500 字 | 截断到最近句末标点（`maxSayChars: 200`）并告警；长度 ≤ 200 |
| 8 | `timeout.ndjson` | 超时 | 只有 `session` 与 `status(turn_start)`，之后 `_meta.delayMs: 60000` | 在注入的短超时下抛 `E_TIMEOUT`；子进程被 `taskkill /T` 杀树，无残留 |
| 9 | `exit1-credential.ndjson` | 退出码 1 + 凭据错误 | 空 stdout + `exit1-credential.stderr.txt` 含 `credential` | 识别为「凭据类失败」，**不计入**普通重试，直接降级 + 告警 |
| 10 | `exit1-profile-desktop.ndjson` | 退出码 1 + 变量名冲突 | `exit1-profile-desktop.stderr.txt` 含 `is managed exclusively by the Electron application` | 识别为「配置类失败」，错误信息提示改用 `CLAUDIAO_DSH_PROFILE`（见 [09 §3 硬规则](09-requirements-checklist.md)） |
| 11 | `session-lost.ndjson` | `--session-id` 指向的会话不存在 | 首事件为 `session` 且 `sessionId` 与传入值不同 | 适配器接受新会话 id 并回写 `prefs`；**不崩**（M1-T3 验收项） |
| 12 | `empty-final.ndjson` | `final.text` 为空字符串 | `{"type":"final","text":""}` | 视为失败 → 模板降级，而不是让 `say=''` 进入 TTS |

> **共 12 个 fixture 覆盖 8 类形态**：正常 / markdown 包裹 / 畸形 JSON / 空 play / 超时 / 退出码 1 / 会话丢失 / 带 usage，外加 `say` 缺失与超长两个字段级边界。

### 2.4 采集真实 fixture 的方法

`dsh` 已实测可用，采集方式：

```powershell
# 真实跑一轮，把 NDJSON 原样存下来（prompt 走 stdin）
'现在几点？说一句就好' | & $env:CLAUDIAO_DSH_BIN --profile $env:CLAUDIAO_DSH_PROFILE --json `
  | Tee-Object -FilePath tests\fixtures\brain\ok-normal.ndjson

# 采集后处理（必做）：
#   1) 删掉可能包含本机路径/cwd 的行字段 → 换成占位符
#   2) 检查不含真实个人语料（见 §8 隐私要求）
#   3) 在文件首行加入 _meta（场景名、采集日期、期望断言）
```

---

## 3. TTS 测试策略

### 3.1 铁律：测试里不真合成

`edge-tts` 要走微软在线服务（实测 3.07s/次），SAPI 要起 COM。两者都不该出现在 `npm test` 里。

### 3.2 `FakeTtsAdapter`

```js
// tests/support/fake-tts.js（示意）
export class FakeTtsAdapter {
  constructor() { this.calls = []; }
  async synthesize(text, opts = {}) {
    this.calls.push({ text, ...opts });
    return { url: `/tts/${hash(text)}.mp3`, bytes: 4096, cached: false, engine: 'fake' };
  }
}
```

要求：返回**固定字节数**的假 mp3（写 `tests/fixtures/tts/silence-4096.mp3` 或纯内存 Buffer），**零 spawn、零网络、零磁盘写入**（除非测缓存层）。

### 3.3 断言点

| # | 断言 | 对应需求 |
|---|---|---|
| 1 | 缓存键 = `sha1(voice\|rate\|pitch\|text)` 前 16 位（`D-07`） | N-02 |
| 2 | **仅**改变 `TTS_VOICE` → 缓存键变化（换音色必须失效） | `D-07` |
| 3 | 相同四元组二次调用 → 命中缓存，返回同一 URL，不调用引擎 | N-02 |
| 4 | 缓存命中路径耗时 < 50ms | N-02 |
| 5 | edge 抛错 → 降级 SAPI，返回值标注 `engine:'sapi'`，日志有告警 | `F-04` / §5.2 |
| 6 | edge 与 SAPI 都失败 → 返回 `null`，编排进入 `MUSIC_ONLY`，**不抛异常** | §5.2 / §8.1 |
| 7 | `say` 为 `""` 或非字符串 → 不调用引擎，直接返回 `null` | `F-04` |
| 8 | 并发合成数峰值 ≤ `TTS_CONCURRENCY`(2) | §5.3 |
| 9 | 队列深度 > 20 时 `prefetch` 任务被丢弃，且不产生报错 | §5.3 |
| 10 | `say` 文本中的路径注入字符（`..\..\`、`/`、`:`）不影响落盘路径（路径白名单校验） | §9 文件写入 |
| 11 | 缓存超出 `ttsMaxFiles`/`ttsMaxBytes` 时触发 LRU 淘汰，**且不淘汰刚写入项** | `R-23` |
| 12 | 落盘是原子的（先写 `.tmp` 再 rename），中断不产生半截 mp3 | `R-23` |

### 3.4 人工冒烟（不自动化）

```powershell
npm run tts:list-voices     # 列出中文音色，人工确认 zh-CN-XiaoxiaoNeural 在列
npm run tts:warm            # 真实合成常用播报句；人耳确认可懂、无爆音、无念出符号
# 期望：data/tts-cache/ 出现 mp3；二次运行耗时显著下降（命中）
```

---

## 4. 音乐测试策略

### 4.1 铁律：测试里不出网

公共实例随时可能失效（[R-01](11-risk-register.md)），把它放进测试等于把 CI 绑在一个不可控的外部服务上。

### 4.2 `FakeMusicProvider` + 真实 fixture

`FakeMusicProvider` 读本地 fixture，实现与真实 provider 相同的接口（`search` / `resolveUrl` / `lyric` / `pic` / `playlist`），并支持注入失败模式：

```js
new FakeMusicProvider({ scenario: 'all-sources-down' })  // 模拟全源失败 → 触发兜底音频
new FakeMusicProvider({ scenario: 'url-null' })          // search 有结果但 url 返回 null
new FakeMusicProvider({ scenario: 'url-expired-mid-play' }) // 播放中直链失效 → 重解析
```

### 4.3 真实 search 响应 fixture（含翻唱噪声）

下列内容来自实测的 `music-api.gdstudio.xyz` 响应形态（`types=search`），**是用于验证翻唱过滤算法的核心素材**。曲目名是公开元数据，不含任何个人语料。

`tests/fixtures/music/search-李志-下雨.json`

```json
{
  "_meta": {
    "capturedFrom": "https://music-api.gdstudio.xyz/api.php?types=search&source=netease&name=李志%20下雨&count=10&pages=1",
    "capturedAt": "设计期实测",
    "purpose": "验证 match.js 的翻唱/伴奏/DJ版噪声过滤"
  },
  "result": [
    { "id": "28949361", "name": "下雨", "artist": ["李志"], "album": "我爱南京", "pic_id": "109951166182509243", "url_id": "28949361", "lyric_id": "28949361", "source": "netease", "duration": 268000 },
    { "id": "28949362", "name": "下雨 (Live)", "artist": ["李志"], "album": "李志 Live", "source": "netease", "duration": 291000 },
    { "id": "3389122", "name": "下雨", "artist": ["陈粒"], "album": "洄游", "source": "netease", "duration": 240000 },
    { "id": "1902345678", "name": "下雨（cover 李志）", "artist": ["小阿七"], "album": "翻唱合集", "source": "netease", "duration": 254000 },
    { "id": "1902345679", "name": "下雨 (伴奏)", "artist": ["李志"], "album": "伴奏集", "source": "netease", "duration": 268000 },
    { "id": "1902345680", "name": "下雨 DJ版", "artist": ["DJ小豪"], "album": "车载慢摇", "source": "netease", "duration": 305000 },
    { "id": "1902345681", "name": "下雨天", "artist": ["南拳妈妈"], "album": "优的良曲", "source": "netease", "duration": 233000 },
    { "id": "1902345682", "name": "下雨", "artist": ["Yiruma"], "album": "Piano", "source": "netease", "duration": 192000 }
  ]
}
```

> 字段名以真实响应为准（`result[].id` / `name` / `artist` / `album` / `duration`，`artist` 是数组，`source` 标识音源）。**采集真实 fixture 时请原样保留字段名**，不要手工改名——否则测的不是真实契约。

`tests/fixtures/music/url-ok.json`（`types=url` 成功形态）

```json
{
  "_meta": { "source": "netease", "bitrate": 320 },
  "url": "https://music.example.invalid/path/to/track.mp3?auth=REDACTED",
  "size": 8493465,
  "br": 320
}
```

`tests/fixtures/music/url-null.json`（失败形态，实际会在编排里触发降级）

```json
{ "_meta": { "source": "netease", "note": "取 url 返回 null —— 网易官方 API 实测如此" }, "url": null }
```

### 4.4 过滤算法的断言（用上面的 fixture）

输入候选 `"李志 - 下雨"`（目标：`artist=李志`，`title=下雨`，专辑 `我爱南京`）：

| 断言 | 期望 |
|---|---|
| 选中 `result[0]`（李志 / 下雨 / 我爱南京） | ✅ 首选 |
| `"(Live)"` 变体（`result[1]`） | 降权；仅当无录音室版时可选 |
| 同名不同艺人（`result[2]` 陈粒、`result[7]` Yiruma） | 因 artist 不匹配被排除（除非显式指定该艺人） |
| `"（cover 李志）"`（`result[3]`，artist 小阿七） | **被排除**（翻唱特征词 + artist 不匹配） |
| `"(伴奏)"`（`result[4]`） | **被排除**（伴奏特征词） |
| `"DJ版"`（`result[5]`，artist DJ小豪） | **被排除**（DJ 版特征词 + artist 不匹配） |
| 相似但不同曲（`result[6]`「下雨天」） | 精确标题匹配优先，模糊匹配仅作后备 |
| 候选按 `duration` 与目标接近度**兜底**（当无法判定伴奏/翻唱时） | 选时长偏差最小者 |

### 4.5 其他断言点

| # | 断言 |
|---|---|
| 1 | 多源按 `MUSIC_SOURCES` 顺序尝试；第一源 503 → 第二源成功 |
| 2 | 全源失败 → 抛**可降级**错误（不是崩溃），编排选 `data/fallback-audio/` |
| 3 | 直链缓存 TTL 内命中不重复请求；过期后重新请求（`MUSIC_URL_TTL_SEC=600`） |
| 4 | 剩余有效期 < 30s 视为失效并重解析 |
| 5 | 失败响应**不写入**直链缓存 |
| 6 | 解析失败的候选被丢弃，队列保底 ≥ 1 首；全失败才降级 |
| 7 | `data/fallback-audio/` 为空时不抛异常，只告警（且此时仍不静音——播模板播报 + 空队列） |
| 8 | 最近 6 小时已播的兜底曲被排除（`fallbackPool.selectionPolicy`） |

---

## 5. 契约测试

### 5.1 HTTP 6 条线的 schema 校验

| 线路 | 方法 | 正向断言 | 反向断言 |
|---|---|---|---|
| `/api/chat` | POST | 200；body `{text}` 合法 → 返回 `{say, play[], reason, segue, sayUrl, tracks[], ts}`；`play` 元素匹配 `^(?<artist>.+?) - (?<title>.+)$` | `text` 缺失/非字符串 → 400；`text` 超长 → 400；body > `maxBodyBytes`(64KB) → 413；非本机无 token → 401 |
| `/api/now` | GET | 200；含 `state`（枚举值属 §8.1 的 9 个状态）、`track`、`sayUrl`、`startedAt`、`queue` | 无播放时返回 `state:'IDLE'` 且 HTTP 仍 200（**不返回 404**） |
| `/api/next` | GET | 200；返回队列下一首及其 `url`；队列空时返回 `{track:null}` | 队列空不抛 500 |
| `/api/taste` | GET | 200；返回 `taste.md` / `routines.md` / `mood-rules.md` / `playlists.json` 内容与各自内容哈希 | 文件缺失 → 返回内置默认语料并在响应中标注 `degraded:true` |
| `/api/taste` | PUT | 200；写入后再次 GET 内容一致；内容哈希变化 | 路径穿越（`../`、绝对路径、非白名单文件）→ 400/403；写入非 UTF-8 → 400 |
| `/api/plan/today` | GET | 200；含当日每个 slot 一条记录，字段含 `slot`/`state`/`plannedAt`/`play[]`/`reason`；`reason` 非空（`F-07`） | 无规划时返回空数组而非 500；`exposeReason:false` 时 `reason` 字段被省略而非置空 |
| `/api/health` | GET | 200；含 `brain`/`tts`/`music`/`weather` 布尔、`rssMb`、`uptimeSec`、`doctor:{fail[],warn[]}`（`healthDetail:true`） | `healthDetail:false` 时只返回 `{ok:true}` |
| `/tts/<hash>.mp3` | GET | 200；`Content-Type: audio/mpeg`；字节数与缓存一致 | 不存在的 hash → 404；hash 含路径字符 → 400 |

### 5.2 WS 事件序列校验

`/stream` 必须满足：**首帧是 `hello`，之后每次状态变化推一帧，客户端可随时断线重连**。

| # | 断言 |
|---|---|
| 1 | 连接后 **200ms 内**收到 `{type:'hello', serverTs, state}`（首帧必达） |
| 2 | 触发一次播放 → 依次收到 `state` 事件序列，且与 §8.1 状态机一致：`THINKING → RESOLVING → SPEAKING → PLAYING`（允许跳过中间态，**不允许逆序**） |
| 3 | `now-playing` 帧含 `track`/`artist`/`title`/`url`/`sayUrl`/`queue`/`ts`；`ts` 单调递增 |
| 4 | 状态变化到帧到达的延迟 < 500ms（`F-06`） |
| 5 | 两个客户端同时连接 → 两者收到**同一序列**，且 `ts` 相同（`E2E-10`） |
| 6 | 无客户端连接时广播不抛错（`§5.2` 第 5 行）；客户端数在断开后 1s 内归零 |
| 7 | 心跳：连接空闲 25s（`wsHeartbeatSeconds`）仍存活；对端不回 pong 则服务端主动断开并清理 |
| 8 | 畸形入站帧（非 JSON、未知 `type`）不会导致服务端崩溃或断开合法客户端 |
| 9 | 鉴权：`?token=` 或 `Authorization: Bearer` 错误 → 握手被拒（`1008` 或 HTTP 401） |
| 10 | `type` 字段的枚举封闭：出现未知类型时**服务端忽略**，不做任何状态变更 |

### 5.3 `dj-action/v1` 校验（字段级）

依据 [设计总览 §6.1](01-architecture-design.md) 与 [03-api-contract](03-api-contract.md#dj-action-v1)：

| 字段 | 必填 | 规则 | 反例断言 |
|---|---|---|---|
| `say` | ✅ | 非空字符串，1~200 字；超长截断到句末标点；**不得含 Markdown/emoji**（会被 TTS 念出来） | 空串 → 拒绝；`"```json"` 前缀 → 剥离 |
| `play` | ✅ | 数组；元素匹配 `^(?<artist>.+?) - (?<title>.+)$`；**允许为空**；不合规元素被丢弃（`trackRefPattern`） | `"李志-下雨"`（无空格）→ 丢弃；元素超 5 个 → 截断到 `maxTracksPerBroadcast: 5` |
| `reason` | ✅ | 非空字符串；≤ `maxReasonChars`(100)；**不进 TTS** | 缺失 → schema 拒绝 |
| `segue` | ❌ | 字符串，可为 `""`；≤ `maxSegueChars`(80) | 非字符串 → 视为 `""` |

---

## 6. 端到端用例

> 全部在 `tests/e2e/`，用 `node --test` 运行；服务起在**随机空闲端口**，适配器全部为 Fake（大脑走 `BRAIN_REPLAY_DIR`）。**零出网、零真实 TTS、零真实 dsh。**

| 编号 | 场景 | 前置 | 步骤 | 预期（可观测） | 覆盖需求 |
|---|---|---|---|---|---|
| **E2E-01** | 冷启动首播 | 空 DB；`BRAIN_REPLAY_DIR` 指向 `ok-normal.ndjson`；FakeTts/FakeMusic 就绪 | 1) 启动服务 2) WS 连接 3) `POST /api/chat {text:"来点安静的"}` | WS 依次收到 `THINKING→RESOLVING→SPEAKING→PLAYING`；首帧 `sayUrl` 以 `/tts/` 开头；`play[]` ≥ 1 且全部有 `url`；`plays` 表新增记录 | F-01 · F-04 · F-06 |
| **E2E-02** | 自然语言点播（雨天） | 同 E2E-01，fixture 的 `say` 提及下雨 | `POST /api/chat {text:"下雨了，来点安静的"}` | prompt 片段中 `intent=mood_request` 且注入了天气片；响应 `reason` 非空；10s 内（测试内 < 1s）进入 `PLAYING` | F-01 · F-03 · F-07 |
| **E2E-03** | 跳过 | 已在 `PLAYING` | `POST /api/chat {text:"下一首"}` 或 WS `skip` | 200ms 内切到队列下一首；`plays` 表原记录标记 `skip`；**大脑调用次数不增加**（控制指令直连） | F-08 |
| **E2E-04** | 大脑超时降级 | `BRAIN_REPLAY_DIR` 指向 `timeout.ndjson`，注入短超时 | `POST /api/chat` | 状态进入 `DEGRADED` 而非卡在 `THINKING`；返回**模板播报**（`fallback-templates.js`）；`play[]` 来自 `playlists.json` 对应档位；日志含降级原因 | F-01 · §5.2 第 2 行 · §8.1 |
| **E2E-05** | 音乐全失败降级 | `FakeMusicProvider({scenario:'all-sources-down'})`；`data/fallback-audio/` 内有测试音频 | `POST /api/chat` | 状态进入 `FALLBACK_AUDIO`；`track.url` 指向 `/fallback-audio/...`；**仍然有声（不静音）**；日志含 `music.resolve exhausted` | F-10 · §5.2 第 3 行 · `D-08` |
| **E2E-06** | TTS 失败降级 | `FakeTtsAdapter` 配置为抛错（edge+SAPI 均失败） | `POST /api/chat` | 状态跳过 `SPEAKING` 直接 `MUSIC_ONLY`；`sayUrl` 为 `null`；`play[]` 正常播放；日志含 `tts degraded` | F-04 · §5.2 第 4 行 · §8.1 |
| **E2E-07** | 断网 | `MUSIC_BASE_URL` 指向 `http://127.0.0.1:1/`；TTS 走 SAPI（Fake 模拟）；DB 与语料已在本地 | 1) 触发播报 2) 刷新 PWA 壳层 | 音乐走兜底音频；播报走本地 TTS；`/api/health` 的 `music:false`；PWA 壳层仍可加载（`sw.js` 命中） | F-10 · N-05 |
| **E2E-08** | 定时触发 | `SLOT_TIME_SCALE` 加速；`routines.yml` 的 `morning` 生效；DB 干净 | 等待调度器触发 `morning` | `plan` 表出现 `(今天, morning)` 且 `state='succeeded'`；WS 收到一次播报；`/api/plan/today` 含该条 | F-02 · F-07 · §4.2 |
| **E2E-09** | 休眠补跑 | 预置 `plan` 表中 `morning` 为 `pending` 且 `plannedAt` 在 `graceMinutes`(90) 窗口内 | 启动服务 | 服务启动后**自动补跑**该 slot 并标 `succeeded`；若把 `plannedAt` 改为超窗（>90min）→ 标 `skipped` 且**不发声** | F-02 · §8.2 · `R-21` |
| **E2E-10** | 多客户端同步 | 两个 WS 客户端 A、B 已连接 | A 触发播放 | A 与 B 收到**同一** `now-playing`（`track.url` 与 `ts` 相同）；B 的到达延迟 < 500ms | F-06 |
| **E2E-11** | 24h 不重复 | `plays` 表预置昨日同 slot 的曲目 | 触发同一 slot | 本次 `play[]` 与预置记录**无交集**（除非 fixture 显式要求重播） | F-05 · `D-02` |
| **E2E-12** | 语料在线编辑生效 | 服务运行中；`LOG_PROMPT=1` | 1) `PUT /api/taste` 改 `taste.md` 2) 等待 `corpusWatchIntervalSeconds`(30) 3) 触发点播 | 新内容出现在 prompt 中（日志或捕获的 prompt 快照）；**未重启服务** | F-09 · `D-06` |
| **E2E-13** | 崩溃恢复 | 已产生若干 `plays` 记录 | 1) `SIGKILL` 服务 2) 重启 3) `GET /api/now` | 返回崩溃前的最后播放历史；`PRAGMA integrity_check` = ok；四表数据完整 | N-06 · `R-27` |

---

## 7. 手工验收脚本

> 前提：`npm install` 已执行；`config/.env` 已从 `.env.example` 复制；`data/fallback-audio/` 已放 ≥5 首音频。

### 7.1 准备（约 5 分钟）

| # | 操作 | 应该看到 / 听到什么 |
|---|---|---|
| 1 | `npm run doctor` | 必需项全 `PASS`；第 3b 项（变量名冲突）为 `PASS`；末尾 `FAIL 0` |
| 2 | `npm run doctor --deep` | 第 4 项大脑 `PASS`；第 10 项直链 `PASS`；第 19/20 项可为 `WARN`（天气/飞书未配置属正常） |
| 3 | `npm run brain:smoke` | 打印一段合法 `DjAction` JSON，含 `say`/`play`/`reason`；打印耗时（约 6s）；`exit=0` |
| 4 | `npm run validate:all` | `11 个歌单 / 70 首曲目` 格式合规、无悬空引用；`exit=0` |
| 5 | `npm run db:migrate` | `data/radio.db` 生成；四表存在；重复执行不报错 |
| 6 | `npm run tts:warm` | 人在扬声器前听到一段中文播报；`data/tts-cache/` 出现 mp3；二次运行明显更快 |
| 7 | `npm run music:check` | `netease` 与 `joox` 均报可用；`kuwo`/`tencent`/`migu`/`kugou` 报不可用（**这是预期**，不是 bug） |

### 7.2 主流程（约 10 分钟）

| # | 操作 | 应该看到 / 听到什么 |
|---|---|---|
| 8 | `npm start`，打开 `http://localhost:8080` | 看到 PWA 界面；三视图（Player/Profile/Settings）可切换；**出现「开始收听」按钮**（浏览器 autoplay 策略所致，[R-13](11-risk-register.md)） |
| 9 | 点「开始收听」 | 无报错；若浏览器拦截，出现明确提示条而不是静默失败 |
| 10 | Player 页输入「来点适合下雨天的歌」 | **先听到一句播报**（不是先放歌），播报说完后**无缝**开始放歌，切换无可感知空档（≤800ms） |
| 11 | 观察 Player 页的曲目信息 | 显示「艺人 - 曲名」与选曲理由（`reason`）；与日志里的一致 |
| 12 | 点「跳过」 | 立即切下一首；`state.db` 的 `plays` 表新增一条 `skip` 记录 |
| 13 | 再点两次「跳过」（累计 3 次） | 第 4 首明显换了情绪档位（不再延续原风格） |
| 14 | 打开第二个浏览器窗口，停留在 Player 页 | 在第一个窗口点播 → 第二个窗口 500ms 内显示同一首，且进度大致同步 |
| 15 | 连续点播 5 次 | 24 小时内没有重复曲目 |
| 16 | Profile 页编辑 `taste.md`，加一句你的偏好，保存 | 提示「已保存，下次触发生效」；**不重启服务**，30s 后点播 → 播报内容反映新偏好 |
| 17 | 浏览器打开 `/api/plan/today` | 当日各时段规划；每条都有非空 `reason` 与曲目 |
| 18 | 浏览器打开 `/api/health` | `brain`/`tts`/`music` 布尔值合理；`rssMb` 正常；`doctor.fail` 为空数组 |

### 7.3 降级演练（约 8 分钟，**这是最值得做的一组**）

| # | 操作 | 应该看到 / 听到什么 |
|---|---|---|
| 19 | 把 `config/.env` 的 `MUSIC_BASE_URL` 改成 `http://127.0.0.1:1/api.php`，重启，点播 | **仍然有声**——播的是 `data/fallback-audio/` 里的曲目；日志有 `music.resolve exhausted → fallback-audio` |
| 20 | 把 `CLAUDIAO_EDGE_TTS_BIN` 改成不存在的路径，重启，点播 | 降级到 SAPI：能听到播报但音色机械（`Microsoft Huihui Desktop`）；日志有 TTS 降级告警 |
| 21 | 把 `CLAUDIAO_DSH_BIN` 改成不存在的路径，重启，点播 | 听到**模板播报**而非静默；日志有 `brain degraded`；`/api/health` 的 `brain:false` |
| 22 | 在 `config/.env` 里加一行 `DSH_PROFILE=dj-brain`（故意制造冲突），重启 | `doctor` 第 3b 项报 `FAIL` 并提示改用 `CLAUDIAO_DSH_PROFILE`。**验证完请删掉这一行** |
| 23 | 拔掉网线，刷新 PWA 页面 | 界面仍能打开（Service Worker 壳层命中）；播报走本地合成；曲目走兜底音频 |

### 7.4 节律与移动端（约 7 分钟）

| # | 操作 | 应该看到 / 听到什么 |
|---|---|---|
| 24 | 临时把 `config/routines.yml` 某个 slot 的 cron 改成 2 分钟后，重启 | 到点自动开口播报；误差 ≤ 60s |
| 25 | 不重启，等同一 slot 再过一次触发（或手动触发同一 slot） | 第二次被幂等命中，**不重复发声**；`plan` 表状态仍为 `succeeded` |
| 26 | 把当前时刻调到 `protectedWindows`（如 09:15–12:00）或静默时段 | **没有任何主动播报**；但此期间在 PWA 主动发消息**仍能正常得到响应** |
| 27 | 手动 kill 掉 node 进程，再 `npm start` | `GET /api/now` 仍能返回崩溃前的播放历史（SQLite 持久化生效） |
| 28 | 手机浏览器打开 `http://<局域网IP>:8080?token=<RADIO_AUTH_TOKEN>` | 能播放；锁屏后 MediaSession 显示曲名；不带 token 访问被拒 |
| 29 | 连续运行 30 分钟 | `node.exe` 工作集 ≤ 300MB（`N-03`）；`data/tts-cache/` 体积未失控 |

---

## 8. 测试数据管理

### 8.1 目录结构

```
tests/
├─ unit/                      # 纯函数与状态逻辑
├─ contract/                  # HTTP / WS / DjAction schema
├─ e2e/                       # 端到端用例（E2E-01 ~ E2E-13）
├─ replay/                    # 回放驱动（brain / tts / music）
├─ support/                   # 测试替身与工具
│  ├─ fake-tts.js             # FakeTtsAdapter
│  ├─ fake-music.js           # FakeMusicProvider
│  ├─ replay-brain.js         # 装配 BRAIN_REPLAY_DIR
│  ├─ temp-data-dir.js        # 每个用例独立临时 data/ 目录
│  └─ ws-client.js            # 简易 WS 测试客户端
└─ fixtures/
   ├─ brain/                  # *.ndjson（12 个，见 §2.3）+ *.stderr.txt
   ├─ tts/                    # silence-4096.mp3 等固定字节假音频
   ├─ music/                  # search-*.json / url-*.json（见 §4.3）
   ├─ audio/                  # 兜底音频测试样本（极小、自有、无版权）
   └─ corpus/                 # 语料快照（脱敏后）
```

### 8.2 命名规范

| 类型 | 规范 | 示例 |
|---|---|---|
| fixture | `<类型>-<场景>[-<变体>].<ext>`，全小写、连字符 | `search-李志-下雨.json`（查询串可保留中文）、`ok-markdown-fenced.ndjson` |
| 测试文件 | `<被测单元>.test.js` | `router-classify.test.js`、`ws-events.test.js` |
| E2E | `e2e-<编号>-<场景>.test.js` | `e2e-04-brain-timeout.test.js` |
| 桩 | `fake-<接口>.js` | `fake-tts.js` |

### 8.3 如何录制新 fixture

```powershell
# 大脑（NDJSON）
'<你的问题>' | & $env:CLAUDIAO_DSH_BIN --profile $env:CLAUDIAO_DSH_PROFILE --json `
  | Tee-Object -FilePath tests\fixtures\brain\<场景>.ndjson

# 音乐 search / url（用 Invoke-RestMethod 取回后原样落盘）
Invoke-RestMethod "https://music-api.gdstudio.xyz/api.php?types=search&source=netease&name=<查询>&count=10&pages=1" `
  | ConvertTo-Json -Depth 8 | Set-Content tests\fixtures\music\search-<查询>.json -Encoding utf8

# TTS：只录元数据（音色/参数/耗时/字节数），不录音频内容
```

**录制后必做的三步**：① 手工过一遍内容；② 按 §8.4 脱敏；③ 在文件开头加 `_meta`（来源、采集日期、用途、期望断言）。

### 8.4 隐私要求（硬性）

| 要求 | 说明 |
|---|---|
| **fixture 中不得含真实个人语料** | 语料（`taste.md`/`routines.md`/`mood-rules.md`/`playlists.json` 的真实内容）是隐私（`N-05`）。需要语料快照时，用 `tests/fixtures/corpus/` 下的**脱敏样本**（编造的偏好、编造的作息） |
| **不得含绝对路径** | 录制的 NDJSON 里若出现 `cwd`（如 `D:\DJ`）或 session id，替换为占位符 `<CWD>`、`<SESSION_ID>` |
| **不得含凭据** | `~/.dsh/.credentials.yaml` 的任何内容、auth token、Webhook URL 一律以 `REDACTED` 代替 |
| **不得含真实直链** | 音乐 fixture 里的 `url` 用 `https://music.example.invalid/...`，避免真实直链被写入仓库（也避免直链过期导致测试假失败） |
| **音频 fixture 必须自有** | 只放极小的自有/无版权样本（几 KB 的静音或自制音频），**不得**放任何流媒体下载的音频（[R-18](11-risk-register.md)） |
| **`.gitignore` 兜底** | `data/`、`config/.env` 已在 [.gitignore](../.gitignore) 中忽略；`tests/fixtures/` 会被提交，所以上面的规则必须靠人工把关 |

### 8.5 测试隔离

| 要求 | 说明 |
|---|---|
| 独立数据目录 | 每个用例用 `tests/support/temp-data-dir.js` 创建临时目录并覆盖 `DB_PATH`/`TTS_CACHE_DIR`/`LOG_DIR`，**绝不写项目的 `data/`** |
| 随机端口 | E2E 用 `PORT=0` 让系统分配，避免 8080 冲突（[R-25](11-risk-register.md)） |
| 环境变量恢复 | `BRAIN_REPLAY_DIR` 等在每个用例后还原，避免相互污染 |
| 无跨用例依赖 | 单个 `.test.js` 可独立运行；不依赖执行顺序 |

---

## 9. 质量门禁

> 「进入下一里程碑」的判定条件。**门禁不是建议——不满足就不进下一阶段**，因为后续阶段会放大未修的缺陷。

| 门禁 | 适用里程碑 | 必须满足的条件 |
|---|---|---|
| **G0** | M0 → M1/M2 | `npm run doctor` 必需项全 PASS（含第 3b 项变量名冲突检测）；`npm run db:migrate` 幂等；`npm run validate:all` 退出码 0；`data/` 可写探针通过 |
| **G1** | M1 → 可并入 M4 | `npm run brain:smoke` 退出码 0（**当前已满足，实测 6320ms**）；§2.3 的 **12 个 fixture 全部就位**；`BRAIN_REPLAY_DIR` 下 `spawn` 调用次数为 0；12 个 fixture 对应的单测全绿 |
| **G2** | M2 → 可并入 M4 | `npm run tts:warm` 生成可听的 mp3；`FakeTtsAdapter` 让 §3.3 的 12 条断言中 ≥ 10 条自动化通过（第 1~9 条必须全绿）；缓存命中 < 50ms 实测 |
| **G3** | M3 → 可并入 M4 | `npm run music:check` 对 ≥2 个源报可用；§4.4 的翻唱过滤 8 条断言全绿；全源失败能走通兜底音频（E2E-05 前半） |
| **G4** | **M4 → M5（最关键）** | **E2E-01 / E2E-02 / E2E-04 通过**；**降级链三条全绿**（E2E-04 大脑超时、E2E-05 音乐全失败、E2E-06 TTS 失败）；`src/layer2/**` 行覆盖 ≥ 80%；状态机不变量测试通过（`SPEAKING` 与 `PLAYING` 互斥、三态均可回 `IDLE`） |
| **G5** | M5 → M6 | 契约测试全绿（§5.1 的 8 条 HTTP 线路 + §5.2 的 10 条 WS 断言）；E2E-03 / E2E-10 通过；`npm test` 总时长 ≤ 90s 且零出网 |
| **G6** | M6 → M7 | E2E-08 / E2E-09 / E2E-11 通过；`(date,slot)` 幂等命中；`protectedWindows` 与静默时段各有一个正例一个反例；补跑超窗标 `skipped` |
| **G7** | M7 → 交付 | [09 文档 §5](09-requirements-checklist.md) 的 **L1(10) + L2(10) + L3(10)** 全部勾选；§7 手工验收 29 步走完无静音；N-01~N-07 全部有实测数字；`npm run backup` 产出的 zip 能在空目录恢复 |

**每次提交的最低要求**（不区分里程碑）：`npm test` 全绿；新增/修改的 `src/layer2/**` 代码有对应单测；不新增任何出网调用到测试路径。

---

## 10. 交叉引用

- 每条需求的验证方式与负责模块：[需求与准备清单 §1~§2](09-requirements-checklist.md)
- 各任务的「完成」定义与门禁落点：[进度表 §2](10-progress-tracker.md)
- 测试中模拟的失败场景对应的真实风险：[风险登记册](11-risk-register.md)
- HTTP/WS 字段级契约与 SQLite DDL：[接口契约与数据模型](03-api-contract.md)
- 模块内部算法（需要写单测的纯函数）：[模块详细设计](02-module-spec.md)

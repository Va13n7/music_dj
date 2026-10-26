# Claudiao 个人音乐电台 · 接口契约与数据模型

> 文档版本 v1.0 · 状态：设计完成，待实现
> 上游依据：[设计总览](01-architecture-design.md) §2 第四层 / §4 / §6 / §8 / §9
> 关联文档：[模块详细设计](02-module-spec.md) · [TTS 声音管线](04-tts-pipeline.md) · [大脑适配器](05-brain-adapter.md) · [音乐提供方](06-music-provider.md) · [调度与节律](07-scheduler-rhythm.md) · [前端 PWA](08-pwa-frontend.md)
> 适用范围：`web/`（PWA）↔ `src/server.js` 的**唯一契约**。前端不得依赖本文档之外的任何服务端行为。

---

<a id="1-通用约定"></a>

## 1. 通用约定

### 1.1 传输与包络

| 项 | 约定 |
|---|---|
| Base URL | `http://127.0.0.1:8080`（默认绑定 `127.0.0.1`）。手机访问需改绑 `0.0.0.0`，此时**必须**配置 `config.radio.authToken`，否则启动即失败退出（总览 §9） |
| 编码 | 一律 UTF-8；请求与响应 `Content-Type: application/json; charset=utf-8` |
| 成功包络 | `{"ok":true,"data":{…},"meta":{"ts":"…","requestId":"…","elapsedMs":12}}` |
| 错误包络 | `{"ok":false,"error":{"code":"E_BRAIN_TIMEOUT","message":"大脑超时","detail":{…}},"meta":{…}}`，`detail` 仅在有结构化补充时出现 |
| 请求头 | `X-Request-Id`（选填，客户端生成，回显在 `meta.requestId`）；`If-None-Match`（选填，用于 `GET` 的条件请求） |
| 时间 | **ISO 8601 带时区偏移**，如 `2026-10-15T21:30:04+08:00`；接受 `Z`，服务端一律按 `Asia/Shanghai` 输出。SQLite 内部用 epoch 毫秒 + 本地日期串（见 §6） |
| 命名 | JSON 字段一律 `camelCase`；枚举值一律小写下划线（如 `mood_request`、`late_night`） |
| HTTP 版本 | HTTP/1.1；不启用 HTTP/2（本地回环无收益，且 complicates WS 升级） |

**HTTP 状态码映射**

| 状态 | 使用场景 |
|---|---|
| 200 | 成功；**降级成功也是 200**（`data.degraded=true`），电台不允许把降级表达为错误 |
| 202 | 仅 `POST /api/chat` 且 `preferStream=1`：已受理，结果经 WS 推送 |
| 304 | 条件请求命中（`GET /api/now`、`GET /api/taste`、`GET /api/plan/today`） |
| 400 / 401 / 404 / 409 / 413 / 429 | 见错误码表 |
| 500 / 502 / 504 | 未降级成功的服务端故障 |

### 1.2 错误码表

与 [02 模块详细设计](02-module-spec.md) §1.4 **同源**（同一张码表的接口层视图）。下表在其基础上**补充 HTTP 状态列**，并新增两个接口层专属码：`E_TASTE_CONFLICT`、`E_PAYLOAD_TOO_LARGE`（`layer2` 不产生）。

| code | HTTP | message（默认中文） | retryable | 触发点 |
|---|---|---|---|---|
| `E_BAD_REQUEST` | 400 | 请求参数不合法 | ❌ | 字段缺失/类型错/越界 |
| `E_AUTH` | 401 | 访问令牌缺失或错误 | ❌ | `Authorization` 与 `?token=` 均无效 |
| `E_NOT_FOUND` | 404 | 资源不存在 | ❌ | 未知路径、TTS 缓存未命中、`?date=` 无 plan |
| `E_PLAN_CONFLICT` | 409 | 该时段已成功执行过 | ❌ | `(date,slot)` 已 `succeeded` |
| `E_TASTE_CONFLICT` | 409 | 语料已被其他改动更新 | ❌ | `PUT /api/taste` 的 `baseSha1` 过期 |
| `E_PAYLOAD_TOO_LARGE` | 413 | 内容超出上限 | ❌ | 语料 > 256KB、`text` > 500 字 |
| `E_BUSY` | 429 | 电台正在处理上一次请求 | ✅ | 单飞闩排队 > 20s 且优先级不足 |
| `E_STATE_DB` | 500 | 状态库读写失败 | ✅ | SQLite 异常（已启用内存影子） |
| `E_INTERNAL` | 500 | 内部错误 | ✅ | 未归类异常 |
| `E_MUSIC_RESOLVE` | 502 | 音乐直链解析失败 | ✅ | 全源失败且本地兜底亦不可用 |
| `E_BRAIN_PARSE` | 502 | 大脑输出无法解析 | ✅ | `DjAction` 提取/校验失败 |
| `E_BRAIN_EXIT` | 502 | 大脑进程异常退出 | ✅ | `dsh` 退出码 ≠ 0 |
| `E_TTS_SAPI_FAIL` | 503 | 语音合成不可用 | ❌ | edge-tts 与 SAPI 均失败 |
| `E_BRAIN_TIMEOUT` | 504 | 大脑超时 | ✅ | 30s 未结束 |
| `E_PATH_REJECTED` | 400 | 路径不在白名单内 | ❌ | `/tts` 与静态路由校验失败 |

> 说明：`E_CONTEXT_CORPUS_MISSING` / `E_ROUTE_FALLBACK` / `E_MUSIC_SOURCE_DOWN` / `E_TTS_EDGE_FAIL` / `E_TTS_TEXT_TOO_LONG` 是**内部降级事件**，只进日志与 `degradedReasons[]`，不单独作为 HTTP 错误返回。

### 1.3 认证

| 项 | 约定 |
|---|---|
| 方式 | `Authorization: Bearer <token>` **或** `?token=<token>`（二选一，同时给出时以 header 为准） |
| 为何要 `?token=` | 浏览器 `WebSocket` 构造器无法设置请求头，故 `/stream` 与 PWA 的 `fetch` 降级路径必须支持查询参数 |
| 比较 | `crypto.timingSafeEqual` 定长比较，**禁止** `===`；长度不等时先补齐再比较，避免时序侧信道 |
| 免校验路径 | `/tts/*`、`/`、`/app/*`、`/sw.js`、`/manifest.webmanifest`、`/favicon.ico`（总览 §9「静态资源不校验」） |
| 需校验路径 | `/api/*`、`/stream` |
| 缺省行为 | 绑定 `127.0.0.1` 且未配 token → 允许匿名（本机回环）；绑定 `0.0.0.0` 且未配 token → **启动失败退出**，不允许裸奔 |
| 令牌存放 | `config.radio.authToken` 或 `RADIO_AUTH_TOKEN`；不写入日志，日志中一律脱敏为 `tok_***` |

### 1.4 幂等与超时总表

| 端点 | 幂等 | 幂等键 | 服务端超时 | 客户端建议超时 |
|---|---|---|---|---|
| `POST /api/chat` | ❌ 非幂等 | `clientMsgId`（60s 内重复即回放上次结果） | 40s（内含 30s 大脑） | 45s |
| `GET /api/now` | ✅ | 天然幂等 + `ETag` | 500ms | 3s |
| `GET /api/next` | `advance=0` ✅ / `advance=1` ❌ | — | 2s | 5s |
| `GET /api/taste` | ✅ | `ETag` = `corpusHash` | 1s | 5s |
| `PUT /api/taste` | ✅ 条件幂等 | `baseSha1`；`content` 哈希已等于当前值 → 200 `{unchanged:true}` | 5s | 15s |
| `GET /api/plan/today` | ✅ | `ETag` = `W/"<date>-<rev>"`，缓存 5s | 1s | 5s |
| `WS /stream` | 消息级幂等由 `seq` 保证 | `seq` | — | — |

---

## 2. 六条线

### 2.1 `POST /api/chat`

**用途**：发一句话给电台，走完整 `compute()` 链路（路由 → 六片上下文 → 大脑 → 音乐 → TTS → 落库 → WS 推送）。

**请求**

| 字段 | 类型 | 必填 | 默认 | 约束 |
|---|---|---|---|---|
| `text` | string | ✅ | — | 1~500 字（`[...text].length`，非 UTF-16 长度）；空白串 → 400 |
| `clientMsgId` | string | — | — | ≤ 64 字；60s 内同 id 重复请求回放上次 `Broadcast`（幂等去重） |
| `sessionId` | string | — | 服务端当前会话 | 用于指定大脑会话；不传即用 `prefs['brain.sessionId']` |
| `interrupt` | boolean | — | `true` | `true` 表示允许打断正在播放的内容（总览 §8.1「任意状态收到 `user_chat` 均允许中断」） |
| `withMusic` | boolean | — | `true` | `false` 时只口播、强制 `play=[]`（用于「只说句话」） |
| `preferStream` | boolean | — | `false` | `true` → 立即 202 + 经 WS 推 `now-playing`，不等结果 |

**成功响应**（200，`data` 即 [§5 Broadcast 对象](#broadcast)）

```json
{
  "ok": true,
  "data": {
    "id": "b_20261015T213004_7f3a",
    "sessionId": "radio-20261015-9c1b7f3a",
    "intent": { "name": "mood_request", "lane": "brain", "text": "下雨了，来点安静的", "mood": "rainy", "source": "user_chat", "priority": "user_chat", "confidence": 0.82 },
    "say": { "text": "外面下着小雨，这种天儿不适合说话，适合听歌。给你放两首安静的。", "audioUrl": "/tts/3f9c1a77b2e40d51.mp3", "mime": "audio/mpeg", "durationMs": 4860, "est": true, "voice": "zh-CN-XiaoxiaoNeural", "engine": "edge-tts", "cached": false, "skipped": false },
    "queue": [
      { "id": "186016", "source": "netease", "title": "下雨", "artist": "李志", "album": "梵高先生", "coverUrl": "https://p1.music.126.net/xxx.jpg", "audioUrl": "https://music-api.gdstudio.xyz/api.php?types=url&source=netease&id=186016&br=320", "lyricUrl": "/api/lyric?source=netease&id=186016", "durationMs": 245000, "reason": "雨天低能量档首选，近 24 小时未播", "score": 0.93, "fuzzy": false },
      { "id": "304382", "source": "netease", "title": "小半", "artist": "陈粒", "album": "小梦大半", "coverUrl": "https://p2.music.126.net/yyy.jpg", "audioUrl": "https://music-api.gdstudio.xyz/api.php?types=url&source=netease&id=304382&br=320", "lyricUrl": "/api/lyric?source=netease&id=304382", "durationMs": 261000, "reason": "与上一首同为低能量档，编曲更暖，形成轻微起伏", "score": 0.88, "fuzzy": false }
    ],
    "reason": "用户明确提到下雨且要安静，命中 mood-rules 的「雨天-低能量」档，两首都在 playlists.json 的 rainy-day 池内，且近 24 小时未播",
    "segue": "听完这两首，如果雨还没停，我给你换个更暖的。",
    "state": "SPEAKING",
    "degraded": false,
    "degradedReasons": [],
    "contextHash": "9a1c4e77b0d2f381",
    "timings": { "routeMs": 2, "contextMs": 18, "brainMs": 5480, "musicMs": 1210, "ttsMs": 3070, "totalMs": 9780, "brainEvents": 8, "brainTurns": 1, "parsePath": "final", "retries": 0, "usage": { "inputTokens": 18342, "outputTokens": 412, "cacheReadTokens": 0, "cacheWriteTokens": 17920, "totalTokens": 18754 } },
    "at": "2026-10-15T21:30:14+08:00"
  },
  "meta": { "ts": "2026-10-15T21:30:14+08:00", "requestId": "req_8f21c0", "elapsedMs": 9780 }
}
```

**错误**

| 状态 | code | 场景 |
|---|---|---|
| 400 | `E_BAD_REQUEST` | `text` 缺失/空白/超 500 字 |
| 401 | `E_AUTH` | 非回环访问且令牌无效 |
| 413 | `E_PAYLOAD_TOO_LARGE` | `text` > 500 字 |
| 429 | `E_BUSY` | 单飞闩排队 > 20s（`user_chat` 优先级最高，正常不会触发；用于极端并发保护） |
| 500 | `E_STATE_DB` / `E_INTERNAL` | 落库失败且影子表亦不可用 |

**实现备注**：① **降级不改变状态码**——大脑超时/解析失败/TTS 失败都返回 200，只是 `degraded=true` 且 `degradedReasons` 列出层级，前端据此决定是否提示；② 请求路径上先落一条 `messages(role='user')`，再进 `compute()`，保证「用户说过什么」永不丢（总览 §4.1 步骤 ②）；③ 单飞闩按 `user_chat > schedule > prefetch` 重排（总览 §5.3）。

### 2.2 `GET /api/now`

**用途**：now-playing 快照。PWA 冷启动、页面切回前台、WS 重连后的状态对齐都靠它。

**请求**：`?verbose=0|1`（默认 `0`；`1` 时附带 `queue` 全文与 `health`）。

**成功响应**

```json
{
  "ok": true,
  "data": {
    "state": "PLAYING",
    "since": "2026-10-15T21:30:19+08:00",
    "stateRev": 4127,
    "nowPlaying": {
      "index": 0, "id": "186016", "source": "netease", "title": "下雨", "artist": "李志", "album": "梵高先生",
      "coverUrl": "https://p1.music.126.net/xxx.jpg",
      "audioUrl": "https://music-api.gdstudio.xyz/api.php?types=url&source=netease&id=186016&br=320",
      "lyricUrl": "/api/lyric?source=netease&id=186016",
      "durationMs": 245000, "positionMs": 41200, "startedAt": "2026-10-15T21:30:19+08:00", "reason": "雨天低能量档首选，近 24 小时未播"
    },
    "say": { "text": "外面下着小雨，这种天儿不适合说话，适合听歌。", "audioUrl": "/tts/3f9c1a77b2e40d51.mp3", "durationMs": 4860, "playedMs": 4860, "skipped": false },
    "queue": [],
    "segue": "听完这两首，如果雨还没停，我给你换个更暖的。",
    "plan": { "date": "2026-10-15", "nextSlot": "night_wind_down", "nextAt": "2026-10-15T22:30:00+08:00" },
    "degraded": false,
    "health": {
      "tts": { "activeEngine": "edge-tts", "breakerOpen": false, "cacheItems": 318 },
      "music": { "activeSource": "netease", "sources": { "netease": { "ok": true, "latencyMs": 240 }, "joox": { "ok": true, "latencyMs": 610 } } },
      "brain": { "sessionId": "radio-20261015-9c1b7f3a", "lastTurnMs": 5480, "totalTokens": 18754 }
    }
  },
  "meta": { "ts": "2026-10-15T21:31:00+08:00", "requestId": "req_11a0e2", "elapsedMs": 3 }
}
```

**错误**：401 `E_AUTH`；500 `E_INTERNAL`。空队列且无播放时 `nowPlaying` 为 `null`、`state='IDLE'`（**不是** 404）。

**幂等与超时**：只读、幂等；`ETag: W/"4127"`，命中返回 304 且无 body。超时 500ms——状态全在内存，**不查 DB**（进程刚启动、内存态为空时才回填 `plays` 最后一行）。

### 2.3 `GET /api/next`

**用途**：读队列下一首；`advance=1` 时手动推进（等价于 WS 发 `{type:'skip'}`，供不支持 WS 的场景，如短链接、CLI 脚本）。

**请求**：`?advance=0|1`（默认 `0`），`?reason=<≤40 字>`（`advance=1` 时写入 `plays.reason`）。

**成功响应**

```json
{
  "ok": true,
  "data": {
    "advanced": true,
    "skipped": { "id": "186016", "title": "下雨", "artist": "李志", "playedMs": 41200, "completed": false },
    "nowPlaying": { "index": 0, "id": "304382", "source": "netease", "title": "小半", "artist": "陈粒", "album": "小梦大半", "audioUrl": "https://music-api.gdstudio.xyz/api.php?types=url&source=netease&id=304382&br=320", "durationMs": 261000, "positionMs": 0, "startedAt": "2026-10-15T21:31:05+08:00" },
    "queue": []
  },
  "meta": { "ts": "2026-10-15T21:31:05+08:00", "requestId": "req_33b7d1", "elapsedMs": 6 }
}
```

**错误**：401 `E_AUTH`；`advance=1` 而队列已空 → 仍 200，`advanced=false`、`nowPlaying=null`、`state='IDLE'`。

**幂等与超时**：`advance=0` 幂等；`advance=1` **非幂等**（每次调用都推进一格并写 `plays`）。超时 2s。**副作用**：跳过计入 `plays.skipped=1` 与 `played_ms`，并按 `mood-rules.md` §五「跳过（<30% 时长）→ 该曲目加入短期排除」影响后续选曲；连续跳过 3 首会置 `prefs['mood.misfire']=true`，下次触发时大脑需切换档位并在 `say` 里承认。

<a id="24-get-apitaste--put-apitaste"></a>

### 2.4 `GET /api/taste` · `PUT /api/taste`

**用途**：读/写品味语料。`GET` 供 Profile 视图展示与「当前语料版本」比对；`PUT` 实现在线编辑（F-09），**改完下一次触发生效，无需重启**。

**GET 请求**：`?file=taste|routines|mood-rules|playlists|persona|all`（默认 `all`）。

```json
{
  "ok": true,
  "data": {
    "corpusHash": "9a1c4e77b0d2f381",
    "files": [
      { "name": "taste", "path": "knowledge/user/taste.md", "bytes": 6218, "mtime": "2026-10-14T23:12:07+08:00", "sha1": "3c7a91de04b1f2aa", "editable": true, "content": "# 我的音乐品味\n\n> **施工图位置**：…" },
      { "name": "routines", "path": "knowledge/user/routines.md", "bytes": 5902, "mtime": "2026-10-14T23:12:07+08:00", "sha1": "b81f2c0d7e5a3344", "editable": true, "content": "# 我的作息节律\n\n…" },
      { "name": "mood-rules", "path": "knowledge/user/mood-rules.md", "bytes": 7044, "mtime": "2026-10-14T23:12:07+08:00", "sha1": "77aa10cc92fe8d31", "editable": true, "content": "# 情绪 → 选曲规则\n\n…" },
      { "name": "playlists", "path": "knowledge/user/playlists.json", "bytes": 8431, "mtime": "2026-10-14T23:12:07+08:00", "sha1": "e5d0b3fa6612c907", "editable": true, "content": "{ \"$schema_version\": \"1.0\", … }" },
      { "name": "persona", "path": "knowledge/prompts/dj-persona.md", "bytes": 9106, "mtime": "2026-10-14T23:12:07+08:00", "sha1": "1f4b7e02aa9c8d55", "editable": true, "content": "# Claudiao · DJ 系统提示词\n\n…" }
    ]
  },
  "meta": { "ts": "2026-10-15T21:32:00+08:00", "requestId": "req_5c9a40", "elapsedMs": 4 }
}
```

**PUT 请求**

| 字段 | 类型 | 必填 | 约束 |
|---|---|---|---|
| `file` | string | ✅ | ∈ `{taste, routines, mood-rules, playlists, persona}`，**白名单外一律 400**，不接受路径片段 |
| `content` | string | ✅ | UTF-8；≤ 262144 字节（256KB）；`playlists` 必须 `JSON.parse` 成功且含 `playlists` 数组 |
| `baseSha1` | string | ✅ | 必须等于当前该文件 `sha1`，否则 409（乐观并发） |
| `dryRun` | boolean | — | `true` 只校验不落盘，返回校验结论与 diff 行数 |

**PUT 成功响应**

```json
{
  "ok": true,
  "data": {
    "file": "taste", "sha1": "0a7d33be1c9f4e28", "bytes": 6355, "unchanged": false,
    "corpusHash": "44e1b90a7c3d2f56", "backup": "knowledge/.history/taste.3c7a91de.20261015T213205.bak",
    "appliedAt": "2026-10-15T21:32:05+08:00",
    "note": "已生效，无需重启；下一次触发（用户消息或定时 slot）将使用新语料"
  },
  "meta": { "ts": "2026-10-15T21:32:05+08:00", "requestId": "req_7d2f18", "elapsedMs": 11 }
}
```

**错误**

| 状态 | code | 场景 |
|---|---|---|
| 400 | `E_BAD_REQUEST` | `file` 不在白名单；`playlists` JSON 非法或结构不符 |
| 401 | `E_AUTH` | 令牌无效 |
| 409 | `E_TASTE_CONFLICT` | `baseSha1` 与当前不符 → 响应体 `error.detail.current = { sha1, mtime, content }`，前端提示「语料已被改动，请刷新后重试」 |
| 413 | `E_PAYLOAD_TOO_LARGE` | `content` > 256KB |

**幂等与超时**：`GET` 幂等，`ETag: "<corpusHash>"`。`PUT` **条件幂等**——若 `content` 的 sha1 已等于当前值则返回 200 且 `unchanged=true`，不写盘、不备份，重复提交安全。超时 5s。

**实现备注**：① 写入顺序 = 校验 → 写 `<file>.tmp` → `fsync` → 同卷 `rename` 覆盖 → 备份到 `knowledge/.history/<name>.<sha1前8>.<ts>.bak`（保留最近 20 份）；② 写成功后调用 `context.invalidate()` 清进程内语料缓存，并让 `corpusHash` 重算——**不重启进程**（总览 D-06）；③ 目标是**白名单常量映射**（`{taste:'knowledge/user/taste.md', …}`），永不接受客户端传入的路径片段，防目录穿越；④ 每次 PUT 记一条 `messages(role='system', intent='taste_edit')` 以便回溯。

**同一“线”的另外三种用法**（不新增端点，[前端 PWA](08-pwa-frontend.md) 的 Profile / Settings 视图依赖）：

| 用法 | 语义 | 说明 |
|---|---|---|
| `POST /api/taste` | **`PUT` 的等价别名** | 请求体、错误码、幂等规则与 `PUT` 完全一致（同一 handler）。PWA 的 `fetch` 统一发 `POST`，故两者必须同时存在 |
| `POST /api/taste?dryRun=1` | 只组装、不落盘 | 用当前语料跑一次 `context.build()`，返回六片碎片的 token 预算与截断情况（第 ② 片拆成 4 个子块，故 `slices` 共 9 项）与 prompt 预览（环境片用占位值），供 Profile 视图的「预览组装结果」按钮使用 |
| `GET /api/taste?includePrefs=1` / `POST /api/taste` 带 `{prefs:{…}}` | `prefs` 白名单段读写 | 白名单键 `{tts.voice, tts.rate, tts.pitch, say.muted}`。带 `prefs` 的 `POST` **不触碰** `knowledge/`，与 `file`/`content` 互斥；用于 Settings 视图（音色变更经 D-07 自然使旧缓存在下次请求时不再命中） |

`dryRun` 响应示例（`slices` 的 `budget` 与 [02 §3.2](02-module-spec.md) 的六片预算逐项对应，`②` 片拆成 4 项故共 9 项）：

```json
{ "ok": true, "data": { "dryRun": true, "corpusHash": "9a1c4e77b0d2f381", "bytes": 11840, "estTokens": 8457, "truncated": [],
  "slices": [
    { "id": "persona",   "bytes": 3542, "budget": 3600, "truncated": false },
    { "id": "taste",     "bytes": 1980, "budget": 2000, "truncated": false },
    { "id": "routines",  "bytes": 1476, "budget": 1500, "truncated": false },
    { "id": "moodRules", "bytes": 1793, "budget": 1800, "truncated": false },
    { "id": "playlists", "bytes":  688, "budget":  700, "truncated": false },
    { "id": "env",       "bytes":  312, "budget":  400, "truncated": false },
    { "id": "memory",    "bytes": 1140, "budget": 1200, "truncated": false },
    { "id": "input",     "bytes":  712, "budget":  800, "truncated": false },
    { "id": "trace",     "bytes":  197, "budget":  200, "truncated": false }
  ],
  "promptPreview": "你是 Claudiao 电台的 DJ。下面的材料按优先级从低到高排列……" } }
```

### 2.5 `GET /api/plan/today`

**用途**：当日规划（F-07），含每个 slot 的选曲理由与执行状态。

**请求**：`?date=YYYY-MM-DD`（默认本地今天）、`?slot=<slotId>`（可选，只取一档）。

**成功响应**

```json
{
  "ok": true,
  "data": {
    "date": "2026-10-15",
    "dayType": "workday",
    "rev": 37,
    "slots": [
      { "slot": "daily_plan", "status": "succeeded", "scheduledAt": "2026-10-15T07:00:00+08:00", "finishedAt": "2026-10-15T07:00:09+08:00", "attempt": 1, "trigger": "schedule", "intent": "scheduled_broadcast", "say": "今天上午有个会，下午空着。给你留了三个小时的连续播放。", "play": [], "reason": "生成当日时段规划，命中 routines.md 工作日档；未选曲", "contextHash": "9a1c4e77b0d2f381" },
      { "slot": "morning", "status": "succeeded", "scheduledAt": "2026-10-15T09:00:00+08:00", "finishedAt": "2026-10-15T09:00:11+08:00", "attempt": 1, "trigger": "schedule", "intent": "scheduled_broadcast", "say": "早上好。今天外面十七度，有点阴，出门记得带件外套。", "play": ["朴树 - 生如夏花"], "reason": "morning slot 定时触发，取 routines.md 早间档第 1 首；天气阴冷故选明亮度较高的曲目", "contextHash": "9a1c4e77b0d2f381" },
      { "slot": "hourly_check", "status": "skipped", "scheduledAt": "2026-10-15T10:00:00+08:00", "skipReason": "focus_window", "attempt": 1, "trigger": "schedule", "intent": "scheduled_broadcast" },
      { "slot": "noon", "status": "succeeded", "scheduledAt": "2026-10-15T12:00:00+08:00", "finishedAt": "2026-10-15T12:00:08+08:00", "attempt": 1, "trigger": "schedule", "intent": "scheduled_broadcast", "say": "十二点了，先吃饭。这首轻松点的陪你。", "play": ["新裤子 - 你要跳舞吗"], "reason": "noon slot，命中 afternoon-lift 档", "contextHash": "9a1c4e77b0d2f381" },
      { "slot": "night_wind_down", "status": "pending", "scheduledAt": "2026-10-15T22:30:00+08:00", "attempt": 0, "trigger": "schedule", "intent": "scheduled_broadcast" }
    ],
    "stats": { "total": 5, "succeeded": 3, "skipped": 1, "failed": 0, "pending": 1, "spokenCount": 2, "spokenQuota": 8, "catchupCount": 0 }
  },
  "meta": { "ts": "2026-10-15T21:33:00+08:00", "requestId": "req_9e0b62", "elapsedMs": 2 }
}
```

**错误**：401 `E_AUTH`；`?date=` 格式非法 → 400 `E_BAD_REQUEST`。**`date` 当日无任何 plan 行时返回 `slots:[]` 而非 404**（进程可能在 07:00 前查询）。

**幂等与超时**：只读幂等；`ETag: W/"2026-10-15-37"`，服务端内 5s 缓存。超时 1s。状态枚举与 [02](02-module-spec.md) §6.2 的 `pending|claimed|running|succeeded|failed|skipped` 一致；`skipReason` ∈ `{quiet_hours, min_gap, focus_window, daily_quota, missed_window, superseded, plan_conflict}`。

### 2.6 `WS /stream`

**用途**：实时推送 now-playing、状态变化、播报起止、队列更新、大脑进度、心跳与错误。协议全文见 [§3 WS 协议](#3-ws-协议)。

**握手**：`ws://127.0.0.1:8080/stream?token=<token>&clientId=<id>&since=<seq>`；Node 客户端亦可用 `Authorization` 头。鉴权失败以 HTTP `401` 拒绝升级（不回 `101`）。

**超时与保活**：服务端 20s 心跳；60s 内未收到任何客户端帧即 `terminate()`。

---

## 3. WS 协议

### 3.1 握手与首帧

```
客户端                                    服务端
  │ GET /stream?token=…&clientId=…&since=… │
  │───────────────────────────────────────▶│  校验 token（失败 → 401，不升级）
  │◀────────────── 101 Switching Protocols ─│
  │◀── {"type":"hello","epoch":"e_8f21","seq":1,"serverTimeMs":1760551804000,
  │      "stateRev":4127,"heartbeatMs":20000,"backlogFrom":0,"corpusHash":"9a1c4e77b0d2f381"} ──│
  │─── {"type":"ping","seq":1,"ts":1760551804100} ──▶│
  │◀── {"type":"heartbeat","seq":2,"ts":…,"serverTimeMs":…} ──│
```

`hello.epoch` 是**进程实例标识**（`e_<随机6位>`，每次进程启动变化）。客户端收到新 `epoch` 必须清空去重集合与本地 `seq` 水位——服务端 `seq` 是**进程内单调递增**，重启后从 1 重新开始。

### 3.2 服务端 → 客户端事件全表

| `type` | 载荷 | 触发时机 |
|---|---|---|
| `hello` | `epoch, seq, serverTimeMs, stateRev, heartbeatMs, backlogFrom, corpusHash` | 连接建立后立即发（第 1 帧） |
| `now-playing` | 完整 [Broadcast](#broadcast)（`data` 同 `POST /api/chat` 的 `data`） | `compute()` 完成、播放推进、`/api/next?advance=1` |
| `state-change` | `{state, prevState, since, stateRev, reason}` | 状态机跳转（`IDLE/THINKING/RESOLVING/SPEAKING/PLAYING/MUSIC_ONLY/DEGRADED/FALLBACK_AUDIO`，总览 §8.1）；暂停/恢复/静音亦走此事件 |
| `say-start` | `{hash, url, text, durationMs, est, startedAt}` | 前端开始播 `say` 音频时（服务端在 `SPEAKING` 进入时预发） |
| `say-end` | `{hash, playedMs, completed, skipped}` | `say` 播放结束或被跳过 |
| `queue-update` | `{queue[], currentIndex, added[], removed[], stateRev}` | 队列增删改（含 `prefetch` 解析出新直链时替换 `audioUrl`） |
| `segue-ready` | `{hash, url, durationMs, forTrackId}` | `segue` 预合成完成（[04](04-tts-pipeline.md) §7.1 的 10s 窗口） |
| `brain-status` | `{phase, turn, elapsedMs, note?}`；`phase ∈ {turn_start, step_start, thinking, text, step_end, turn_end}` | 消费 `dsh` NDJSON 事件时逐条转发，仅用于进度指示，**载荷不含大脑正文** |
| `plan-update` | `{date, slot, status, say?, play?, reason?, skipReason?}` | slot 生命周期变化（scheduler 写回后） |
| `error` | `{code, message, detail?, fatal}` | 降级事件与致命错误；`fatal=false` 时电台仍在响 |
| `heartbeat` | `{seq, ts, serverTimeMs}` | 每 20s，或收到客户端 `ping` 后立即回 |

### 3.3 客户端 → 服务端事件

| `type` | 载荷 | 语义 | 服务端副作用 |
|---|---|---|---|
| `skip` | `{playedMs?, positionMs?, trackId?, at?}` | 跳过当前曲目（`positionMs` 为 `playedMs` 的别名，取先到者） | 等价 `GET /api/next?advance=1`：记 `plays.skipped=1`、推进队列、推 `now-playing` + `queue-update` |
| `pause` | `{positionMs}` | 暂停 | 状态 → `IDLE`（保留 `positionMs`），推 `state-change` |
| `resume` | `{positionMs?}` | 恢复 | 状态回到暂停前状态，推 `state-change` |
| `seek` | `{positionMs}` | 跳转进度 | 记入 `plays.played_ms` 起点；`>` 90% 时长时预取下一首 |
| `feedback` | `{trackId, value:-1\|0\|1, kind?:'like'\|'dislike'\|'skip', at?}` | 顶/踩（`kind` 为 `value` 的别名，见 §3.5） | 写 `plays.feedback`；`value=-1` 时该曲目加入 24h 短期排除 |
| `ping` | `{seq, ts}` | 保活 | 立即回 `heartbeat` |
| `prefetch` | `{nextIndex?, trackId?, remainMs?}` | 当前曲目剩余约 10s | 预解析下一首直链；`segue` 非空且未合成 → 启动合成并推 `segue-ready`（[04](04-tts-pipeline.md) §7） |
| `duration-report` | `{hash, durationMs}` | `<audio>.loadedmetadata` 回填真实时长 | 更新 TTS 缓存 meta，`est=false`，EMA 校准码率（[04](04-tts-pipeline.md) §8.3） |

未知 `type` 一律忽略并回 `error{code:'E_BAD_REQUEST', fatal:false}`，**不断连接**（前向兼容）。

### 3.4 心跳、重连、序号与去重

| 项 | 策略 |
|---|---|
| 服务端心跳间隔 | **20s** 发 `heartbeat`；`heartbeatMs` 在 `hello` 中下发，客户端不得硬编码 |
| 客户端 `ping` 间隔 | **25s**（略大于服务端心跳，避免同频碰撞） |
| 判定断线 | 服务端 **60s** 未收到客户端任何帧 → `terminate()`；客户端 **45s** 未收到服务端任何帧 → 视为断线并重连（两倍心跳 + 5s 容差） |
| 重连退避 | 指数退避 `500ms × 2^n`，上限 **30s**，每次叠加 **±20% 抖动**（防多客户端同步重连风暴）；`n` 在成功连接后清零 |
| 补发 | 客户端带 `since=<最后收到的 seq>` 重连；服务端从**环形缓冲（最近 200 条）**补发最多 **100 条**，超出部分不回补，改由客户端调 `GET /api/now` 做全量对齐 |
| 序号 | `seq` 进程内从 1 单调递增，**所有**服务端帧都必须带 `seq`（含 `heartbeat`） |
| 去重 | 客户端维护 `lastSeq` 与 `Set<seq>`（窗口 200）；`seq <= lastSeq` 属补发重复 → 丢弃；`seq > lastSeq + 1` → 判定漏帧，主动调 `GET /api/now` 重新对齐而非等待 |
| 顺序 | 单连接内严格保序；**不保证跨连接有序**，故 `stateRev`（服务端单调递增的整数）是客户端判断「谁更新」的最终依据 |

### 3.5 与 [前端 PWA](08-pwa-frontend.md) 的命名对齐

[08 前端 PWA](08-pwa-frontend.md) §5.2 用了一组**更短的事件名**，且已声明「字段名最终以 03 接口契约为准」（§5.2 表头）。本节给出唯一映射，**实现以左列为准**：

| 03 规范名（实现用） | 08 文档用名 | 语义差别 |
|---|---|---|
| `state-change` | `state` | 同一事件；03 额外带 `prevState` 与 `stateRev` |
| `queue-update` | `queue` | 03 带增量 `added[]`/`removed[]`，08 只要全量 `tracks[]` |
| `now-playing` | `now-playing` | 一致。03 的载荷是完整 `Broadcast`，08 的 `tracks[]`/`sayUrl`/`sayText`/`segueUrl` 均可由 `Broadcast.queue[]`/`say.audioUrl`/`say.text`/`segueUrl` 派生 |
| `say-start` / `say-end` | —（08 未定义） | 08 用 `<audio>` 本地事件；服务端事件用于多端同步与统计，前端可忽略 |
| `brain-status` | —（08 未定义） | 进度指示，前端可忽略 |
| `heartbeat` | `pong` | 同一保活帧；03 统称 `heartbeat`（含服务端主动心跳，08 的 `pong` 只覆盖应答场景） |
| —（08 独有） | `chat` | 08 用它追加聊天记录；03 不单独推 `chat`，前端从 `now-playing` 的 `intent.text` 与 `say.text` 本地追加即可 |
| —（08 独有） | `usage` | 03 把用量放在 `now-playing.timings.usage`（五字段），不单发事件 |
| —（08 独有） | `next-ready` | 等价于 03 的 `segue-ready` + `queue-update` 两帧 |
| 客户端 `feedback` 的 `value` | 08 的 `kind` | `like`↔`value:1`、`dislike`↔`value:-1`；`kind:'skip'` 等价于单独发 `skip` 事件。实现**两者都接受** |
| 客户端 `prefetch` 的 `nextIndex` | 08 的 `{trackId, remainMs}` | 实现接受 `{nextIndex?, trackId?, remainMs?}` 任一组合，缺省按当前播放项 +1 处理 |
| 客户端 `hello` 由服务端先发 | 08 要求**客户端先发** `hello{lastSeq, unlockState, viewport}` | 取折中：服务端连上即发 `hello`（§3.1），客户端随后可再发一次 `hello` 携带 `lastSeq` 用于补发对齐，服务端以最后一次为准 |

---

<a id="dj-action-v1"></a>

## 4. `DjAction` v1 schema

大脑返回的唯一结构（[设计总览](01-architecture-design.md) §6.1）。**`dj-persona.md` 要求输出纯 JSON，但实现必须容忍模型不守规矩**，故本节同时给出 schema 与容错提取算法。

### 4.1 JSON Schema

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://claudiao.local/schemas/dj-action-v1.json",
  "title": "DjAction",
  "type": "object",
  "required": ["say", "play", "reason"],
  "additionalProperties": true,
  "properties": {
    "say":    { "type": "string", "minLength": 1, "maxLength": 200,
                "description": "送 TTS 朗读的播报文本，1~200 字" },
    "play":   { "type": "array", "minItems": 0, "maxItems": 5, "uniqueItems": true,
                "items": { "type": "string", "minLength": 3, "maxLength": 120,
                           "pattern": "^.+\\s-\\s.+$",
                           "description": "元素格式严格为 \"艺人 - 曲名\"（空格 + 半角连字符 + 空格）" } },
    "reason": { "type": "string", "minLength": 1, "maxLength": 200,
                "description": "选曲理由，用于 /api/plan/today 展示与调试，不进 TTS" },
    "segue":  { "type": "string", "maxLength": 120,
                "description": "曲目剩余 10s 时播放的衔接语，可为 \"\"" }
  }
}
```

### 4.2 校验规则与上限

| 字段 | 必填 | 上限 | 越界处置 |
|---|---|---|---|
| `say` | ✅ | **1~200 字**（用 `[...s].length` 计数，避免代理对被算成 2） | 空 → 用模板兜底句；> 200 → 按句末标点截断到 ≤ 200 并记 `degradedReasons:['say_truncated']` |
| `play` | ✅ | **0~5 个**（个数上限取自 `dj-persona.md` 的字段规格） | 空数组合法（纯口播）；> 5 → 截取前 5；元素不符 `^.+ - .+$` → 按容错算法归一化 |
| `reason` | ✅ | 硬上限 200 字（persona 要求 ≤ 100，**超 100 只告警不拒绝**） | 缺失 → 填 `"（模型未给出理由）"` 并 `degraded=true` |
| `segue` | — | 硬上限 120 字（persona 建议 ≤ 80） | 缺失/非字符串 → `""`；> 120 → 截断 |
| 未知字段 | — | — | 保留在 `raw` 中供调试，不进入 `Broadcast` |

### 4.3 解析容错：逐步提取与修复算法

输入是 `dsh` 的 **`final` 事件文本**（只有它无损；`text`/`thinking` 是提交点投影且可能带 `truncated`，仅作次优路径）。

```
parseDjAction(raw):
 1  空/非字符串 → E_BRAIN_NO_FINAL
 2  去 BOM（\uFEFF）、统一换行（\r\n|\r → \n）、trim
 3  若含 ``` 围栏：
      a. 取所有 ```…``` 成对块，选**最长**块；若多个等长取第一个
      b. 剥掉首行的语言标注（json / JSON / javascript / 空）
      c. 无闭合围栏 → 取首个 ``` 之后到文末
    记录 path='fenced'
 4  否则：用**首个 `{` 到最后一个 `}`** 截取子串。若无 `}` → 用首个 `{` 到文末
     记录 path = 'offset'（截取过）或 'plain'（原文即 JSON）
 5  JSON.parse：
      成功 → 跳至 9
      失败 → 进入修复序列（每步后重试，成功即停，repairs 累加标记）
 6  修复序列（顺序固定，不跳步）：
      R1 尾随逗号           /,\s*(?=[}\]])/g → ''
      R2 中文引号→半角       “ ” → " ；‘ ’ → '
      R3 单引号→双引号       仅当整段不含 " 时；'([^']*)' → "$1"
      R4 字符串内裸换行      在 "…" 内把未转义 \n → \\n（逐字符扫描，非贪婪正则）
      R5 括号补齐           统计 { } [ ] 栈；缺 } 时在末尾按栈序补全
      R6 前后缀说明文字      取首个 { 到最后一个 } 再 parse（去掉「好的，我为你推荐：」之类）
 7  若仍失败 → E_BRAIN_PARSE（上层重试 1 次并注入纠偏提示，见 02 §4.2 步骤 9）
 8  ——
 9  字段归一化：
      a. play 为 string        → 按 \n / ， / , / 、 切分
      b. play 为对象数组        → [{artist,title}] → "artist - title"；缺一者只留存在的一方
      c. play 为 null / 缺失    → []
      d. play 元素全角连字符     "－" / "—" / "–" → "-"，并按**首个** " - " 切分后重排为 "艺人 - 曲名"
         无分隔符          → 视为 title-only，整串作为检索关键词（providers 侧 matchMode='title-only'）
      e. say/reason/segue 去 Markdown、去首尾空白、折叠连续空白
10  校验（§4.2）→ 产出 {action, path, repairs[]}
11  记录到 Broadcast.timings.parsePath 与 degradedReasons[]（path ≠ 'plain'/'final' 时标 degraded）
```

| `parsePath` | 含义 | 是否 `degraded` |
|---|---|---|
| `final` / `plain` | `final` 事件、原文即合法 JSON | ❌ |
| `fenced` | 被 ``` 围栏包裹（模型未遵守 persona，但内容无损） | ⚠️ 仅告警 |
| `offset` | 前后有说明文字，已按首尾花括号截取 | ✅ |
| `repaired` | 触发 R1~R6 中任一修复 | ✅ |
| `text-projection` | 无 `final`，采用未截断的 `text` 事件 | ✅ |
| `template` | 全部失败，走 `fallback-templates.js` | ✅ |

---

<a id="broadcast"></a>

## 5. `Broadcast` 对象

`compute()` 的返回值，也是 `POST /api/chat` 的 `data`、WS `now-playing` 的载荷。

```json
{
  "id": "b_20261015T213004_7f3a",
  "sessionId": "radio-20261015-9c1b7f3a",
  "intent": {
    "name": "mood_request", "lane": "brain", "source": "user_chat", "priority": "user_chat",
    "text": "下雨了，来点安静的", "mood": "rainy", "moodCandidates": ["rainy", "calm"],
    "slot": null, "confidence": 0.82, "reason": "命中 mood-rules 雨天档，同时含 calm 触发词"
  },
  "say": {
    "text": "外面下着小雨，这种天儿不适合说话，适合听歌。给你放两首安静的。",
    "audioUrl": "/tts/3f9c1a77b2e40d51.mp3", "mime": "audio/mpeg", "durationMs": 4860,
    "est": true, "voice": "zh-CN-XiaoxiaoNeural", "engine": "edge-tts",
    "cached": false, "skipped": false
  },
  "queue": [
    { "index": 0, "id": "186016", "source": "netease", "title": "下雨", "artist": "李志", "album": "梵高先生",
      "coverUrl": "https://p1.music.126.net/xxx.jpg",
      "audioUrl": "https://music-api.gdstudio.xyz/api.php?types=url&source=netease&id=186016&br=320",
      "lyricUrl": "/api/lyric?source=netease&id=186016", "durationMs": 245000,
      "reason": "雨天低能量档首选，近 24 小时未播", "score": 0.93, "fuzzy": false }
  ],
  "reason": "用户明确提到下雨且要安静，命中 mood-rules 的「雨天-低能量」档，两首都在 playlists.json 的 rainy-day 池内，且近 24 小时未播",
  "segue": "听完这两首，如果雨还没停，我给你换个更暖的。",
  "state": "SPEAKING",
  "degraded": false,
  "degradedReasons": [],
  "contextHash": "9a1c4e77b0d2f381",
  "timings": { "routeMs": 2, "contextMs": 18, "brainMs": 5480, "musicMs": 1210, "ttsMs": 3070, "totalMs": 9780,
               "brainEvents": 8, "brainTurns": 1, "parsePath": "final", "retries": 0,
               "usage": { "inputTokens": 18342, "outputTokens": 412, "cacheReadTokens": 0, "cacheWriteTokens": 17920, "totalTokens": 18754 } },
  "at": "2026-10-15T21:30:14+08:00"
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | `b_<yyyymmddThhmmss>_<4hex>`，`plays.broadcast_id` 与 `messages.broadcast_id` 的外键值 |
| `sessionId` | string | 大脑会话 id，落盘于 `$DSH_HOME/sessions/--D-DJ--/<sid>` |
| `intent` | object | 分类结果快照；`name` ∈ [02 §2.2](02-module-spec.md) 的 8 个 `IntentName`，`lane` ∈ `direct\|music\|brain` |
| `say.text` | string | 已过 TTS 预处理前的原文（1~200 字）；`skipped=true` 时仍下发供前端展示 |
| `say.audioUrl` | string | `/tts/<hash>.mp3`；引擎为 SAPI 时实际文件是 `.wav`，路由回落并声明 `audio/wav` |
| `say.durationMs` | number | 估算时长；`est=true` 表示待前端 `loadedmetadata` 回填（[04](04-tts-pipeline.md) §8） |
| `queue[]` | array | 已解析出可播直链的曲目；解析失败的候选只出现在 `degradedReasons`，不占位 |
| `queue[].reason` | string | **单曲级**理由（与顶层 `reason` 的整段理由不同），供 Profile 视图逐首展示 |
| `queue[].score` / `fuzzy` | number / boolean | providers 的匹配分与模糊标记（`< 0.72` 时为 `true`） |
| `segue` | string | 可为 `""`；非空时前端在剩余 10s 发 `prefetch` 触发预合成 |
| `state` | string | 组装完成时的播放状态机值（总览 §8.1） |
| `degraded` / `degradedReasons[]` | boolean / string[] | 是否降级及降级层级，取值如 `brain_timeout`、`brain_template`、`music_fallback_audio`、`tts_sapi`、`tts_skipped`、`say_truncated`、`corpus_default` |
| `contextHash` | string | 本次所用语料内容哈希（[02 §3.5](02-module-spec.md)） |
| `timings` | object | 各环节耗时 + 大脑事件数 + `parsePath` + 重试次数 + token 用量（`usage` 五字段来自 `status(step_end)`） |

---

<a id="sqlite-ddl"></a>

## 6. SQLite DDL 与典型查询

数据库 `data/radio.db`（`better-sqlite3`，同步 API）。**时间列双表示**：`at_ms INTEGER`（epoch 毫秒，用于索引与区间比较）+ `date TEXT`（`YYYY-MM-DD`，`Asia/Shanghai` 本地日，用于按日聚合）。API 边界才转 ISO 8601 带时区。

```sql
PRAGMA journal_mode = WAL;      -- 读写并发：/api/now 读不阻塞 compute 写
PRAGMA synchronous = NORMAL;    -- WAL 下足够安全，且避免每事务 fsync
PRAGMA busy_timeout = 5000;     -- 5s 内自动重试 SQLITE_BUSY
PRAGMA foreign_keys = OFF;      -- 单进程单写者，不需要外键约束开销
```

### 6.1 `messages` · 对话与系统留痕

```sql
CREATE TABLE IF NOT EXISTS messages (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,  -- 自增主键
  at_ms        INTEGER NOT NULL,                   -- UTC epoch 毫秒（排序与区间查询用）
  date         TEXT    NOT NULL,                   -- 本地日期 YYYY-MM-DD（Asia/Shanghai）
  role         TEXT    NOT NULL                    -- 说话者：user=用户 / dj=电台播报 / system=系统留痕
               CHECK (role IN ('user','dj','system')),
  text         TEXT    NOT NULL,                   -- 消息全文（本库唯一存全文的列，日志不落全文）
  intent       TEXT,                               -- 意图名，如 mood_request / taste_edit
  lane         TEXT,                               -- direct | music | brain
  session_id   TEXT,                               -- 大脑会话 id
  broadcast_id TEXT,                               -- 关联的 Broadcast id（dj 行才有）
  degraded     INTEGER NOT NULL DEFAULT 0,         -- 0/1：该轮是否发生降级
  meta_json    TEXT                                -- 结构化补充（JSON 文本）：{mood, slots, parsePath}
);

CREATE INDEX IF NOT EXISTS idx_messages_at        ON messages(at_ms DESC);            -- 最近 M 条消息
CREATE INDEX IF NOT EXISTS idx_messages_date_role ON messages(date, role, at_ms DESC); -- 当日某角色的对话
CREATE INDEX IF NOT EXISTS idx_messages_broadcast ON messages(broadcast_id);          -- 由播报回溯对话
```

### 6.2 `plays` · 播放历史与反馈

```sql
CREATE TABLE IF NOT EXISTS plays (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,  -- 自增主键
  at_ms        INTEGER NOT NULL,                   -- 开始播放时刻（UTC epoch 毫秒）
  date         TEXT    NOT NULL,                   -- 本地日期 YYYY-MM-DD
  track_id     TEXT    NOT NULL,                   -- provider 侧曲目 id（netease 为数字串）
  source       TEXT    NOT NULL,                   -- 音乐源：netease | joox | local
  title        TEXT    NOT NULL,                   -- 曲名
  artist       TEXT    NOT NULL,                   -- 艺人（title-only 匹配时为空串）
  album        TEXT,                               -- 专辑名，可空
  spec         TEXT    NOT NULL,                   -- 原始点播串 "艺人 - 曲名"（来自 DjAction.play）
  audio_url    TEXT,                               -- 实际播放的直链（用于排查失效链）
  cover_url    TEXT,                               -- 封面 URL
  lyric_url    TEXT,                               -- 歌词地址
  duration_ms  INTEGER,                            -- 曲目总时长（毫秒）
  played_ms    INTEGER NOT NULL DEFAULT 0,         -- 实际播放时长（毫秒），跳过时 < 30% 即判误判
  completed    INTEGER NOT NULL DEFAULT 0,         -- 0/1：是否听完（>90% 时长）
  skipped      INTEGER NOT NULL DEFAULT 0,         -- 0/1：是否被跳过
  feedback     INTEGER,                            -- -1=踩 / 0=中性 / 1=顶；NULL 表示未反馈
  broadcast_id TEXT,                               -- 关联 Broadcast id
  intent       TEXT,                               -- 触发本次播放的意图名
  reason       TEXT,                               -- 选曲理由（用于 /api/now 的 why 查询）
  degraded     INTEGER NOT NULL DEFAULT 0,         -- 0/1：该曲是否来自降级路径（如本地兜底音频）
  CHECK (feedback IS NULL OR feedback IN (-1,0,1))
);

CREATE INDEX  IF NOT EXISTS idx_plays_at    ON plays(at_ms DESC);                 -- 最近 N 次播放
CREATE INDEX  IF NOT EXISTS idx_plays_track ON plays(track_id, at_ms DESC);       -- 24h 去重（F-05）
CREATE INDEX  IF NOT EXISTS idx_plays_date  ON plays(date, at_ms DESC);           -- 当日统计
CREATE INDEX  IF NOT EXISTS idx_plays_title ON plays(title, artist);              -- "放过 X 吗" 查询
CREATE UNIQUE INDEX IF NOT EXISTS uq_plays_broadcast_track
  ON plays(broadcast_id, track_id) WHERE broadcast_id IS NOT NULL;               -- 同一 Broadcast 内同曲只记一次（幂等）
```

### 6.3 `plan` · 当日规划与触发幂等

```sql
CREATE TABLE IF NOT EXISTS plan (
  date          TEXT    NOT NULL,                  -- 本地日期 YYYY-MM-DD（幂等键第一段）
  slot          TEXT    NOT NULL,                  -- slot 名：daily_plan/morning/hourly_check/…
  status        TEXT    NOT NULL DEFAULT 'pending' -- 触发生命周期（总览 §8.2）
                CHECK (status IN ('pending','claimed','running','succeeded','failed','skipped')),
  scheduled_at  INTEGER NOT NULL,                  -- 计划触发时刻（UTC epoch 毫秒）
  claimed_at    INTEGER,                           -- 抢锁时刻；超过 90s 未终结即视为 stale
  started_at    INTEGER,                           -- 进入 running 的时刻
  finished_at   INTEGER,                           -- 终结（succeeded/failed/skipped）时刻
  owner         TEXT,                              -- 持锁者标识（进程 id + 随机串），便于排障
  attempt       INTEGER NOT NULL DEFAULT 0,        -- 尝试次数（含补跑），≥1 表示已投递过
  trigger       TEXT,                              -- 触发来源：schedule | catchup | wake | startup | webhook
  intent        TEXT,                              -- 意图名（scheduled_broadcast / skill_trigger）
  say           TEXT,                              -- 本档播报文本（成功时写入，供 /api/plan/today）
  play_json     TEXT,                              -- 选曲数组的 JSON 文本
  reason        TEXT,                              -- 选曲理由
  segue         TEXT,                              -- 衔接语
  broadcast_id  TEXT,                              -- 关联 Broadcast id
  context_hash  TEXT,                              -- 本次所用语料哈希（与当前哈希不同即说明改动尚未生效）
  degrade_json  TEXT,                              -- 降级原因数组的 JSON 文本
  error_code    TEXT,                              -- 失败时的错误码（如 E_BRAIN_TIMEOUT）
  skip_reason   TEXT,                              -- 跳过原因：quiet_hours/min_gap/focus_window/daily_quota/missed_window/superseded/plan_conflict
  updated_at    INTEGER NOT NULL,                  -- 最后更新时刻（心跳续期也刷这列）

  PRIMARY KEY (date, slot)                         -- ★ 唯一约束：保证同日同 slot 的 succeeded 不可重入
);

CREATE INDEX IF NOT EXISTS idx_plan_status ON plan(status, scheduled_at);  -- stale 扫描与补跑裁决
CREATE INDEX IF NOT EXISTS idx_plan_date   ON plan(date, scheduled_at);    -- 当日规划列表
```

### 6.4 `prefs` · 键值偏好

```sql
CREATE TABLE IF NOT EXISTS prefs (
  key        TEXT PRIMARY KEY,        -- 偏好键，点号分层：brain.sessionId / say.muted / broadcast.count.2026-10-15
  value      TEXT NOT NULL,           -- JSON 编码的值（字符串也是 JSON：'"zh-CN-XiaoxiaoNeural"'）
  updated_at INTEGER NOT NULL,        -- 最后写入时刻（UTC epoch 毫秒）
  note       TEXT                     -- 人类可读备注，便于手工排查
);

CREATE INDEX IF NOT EXISTS idx_prefs_updated ON prefs(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_prefs_prefix  ON prefs(key);   -- 前缀批量读取 allPrefs('brain.')
```

**预定义键**：`brain.sessionId`（当前会话）、`brain.usage.total`（累计 token）、`brain.sessionHistory`（历史会话 id 数组）、`say.muted`、`broadcast.count.<date>`（当日发声次数）、`broadcast.circuit.strikes`（连续失败计数）、`mood.misfire`（连跳 3 首标记）、`taste.pending.<ts>`（待确认的品味反馈）、`music.sourceChain`、`tts.voice.bySlot`。

### 6.5 典型查询

```sql
-- ① 最近 N 次播放（新→旧）
SELECT id, at_ms, title, artist, album, played_ms, completed, skipped, feedback, reason
  FROM plays ORDER BY at_ms DESC LIMIT ?;

-- ② 最近 24 小时已播曲目 id（大脑选曲去重，F-05）
SELECT DISTINCT track_id FROM plays WHERE at_ms > ?;

-- ③ 当日 plan（按计划时刻升序）
SELECT slot, status, scheduled_at, finished_at, say, play_json, reason, skip_reason, attempt
  FROM plan WHERE date = ? ORDER BY scheduled_at;

-- ④ 最近 M 条消息（新→旧）
SELECT id, at_ms, role, text, intent, degraded FROM messages ORDER BY at_ms DESC LIMIT ?;

-- ⑤ 当日某角色的对话（用于 prompt 第 ④ 片的 recentMessages）
SELECT role, text, at_ms FROM messages
 WHERE date = ? AND role IN ('user','dj') ORDER BY at_ms DESC LIMIT ?;

-- ⑥ 抢锁成功后写回成功态（scheduler → plan）
UPDATE plan SET status='succeeded', finished_at=?, say=?, play_json=?, reason=?, segue=?,
                broadcast_id=?, context_hash=?, degrade_json=?, updated_at=?
 WHERE date=? AND slot=?;

-- ⑦ stale 锁回收（超过 90s 未终结）
UPDATE plan SET status='failed', error_code='E_INTERNAL', finished_at=?, updated_at=?
 WHERE status IN ('claimed','running') AND COALESCE(claimed_at, updated_at) < ?;

-- ⑧ 当日发声配额（节制规则：上限 8 次）
SELECT COUNT(*) FROM plan
 WHERE date = ? AND status='succeeded' AND say IS NOT NULL AND say <> '';

-- ⑨ 指标：完播率与跳过率
SELECT COUNT(*) AS plays,
       SUM(completed) AS completed,
       SUM(skipped)   AS skipped,
       ROUND(1.0 * SUM(completed) / NULLIF(COUNT(*),0), 3) AS completion_rate
  FROM plays WHERE at_ms BETWEEN ? AND ?;

-- ⑩ 修剪：删除 90 天前的消息（保留 plays 更久）
DELETE FROM messages WHERE at_ms < ?;
```

### 6.6 表名与可选扩展表

| 项 | 约定 |
|---|---|
| `plan` vs `plan_slots` | [调度与节律](07-scheduler-rhythm.md) §5 建议把本表命名为 `plan_slots`，并声明「若沿用 `plan` 表名，字段必须与上表一致」。**本契约按 [设计总览](01-architecture-design.md) §6.2 采用 `plan`**（总览是唯一权威来源，且 `plan` 已被 01/02/03 一致引用）。字段映射：`state`→`status`、`claimed_by`→`owner`、`ended_at`→`finished_at`、`payload`→`say` / `play_json` / `reason` / `degrade_json`。**实现只允许存在一个名字，以 `plan` 为准** |
| 可选扩展表 | `cache`（音乐解析缓存，见 [音乐提供方](06-music-provider.md)）与 `brain_usage`（大脑调用记账，见 [大脑适配器](05-brain-adapter.md)）由各自文档定义，**不属于核心四表**，不改变 `messages` / `plays` / `plan` / `prefs` 的语义；缺失时相关功能退化为「无缓存 / 无统计」，不影响电台出声 |
| 迁移顺序 | `001-core-four-tables.sql`（本节四表）→ `002-cache.sql`（可选）→ `003-brain-usage.sql`（可选），按 `PRAGMA user_version` 顺序执行 |

---

## 7. 文件与路径约定

### 7.1 目录布局

| 路径 | 用途 | 写入者 | 备份 |
|---|---|---|---|
| `data/radio.db` | SQLite 主库（另有 `-wal` / `-shm` 同目录伴生文件） | `state.js` | 每日 `scripts/backup.ps1` → `data/backups/radio-YYYYMMDD.db` |
| `data/tts-cache/<hash>.mp3` | edge-tts 产物（主缓存） | `tts.js` | 无需备份（内容寻址，可再生） |
| `data/tts-cache/<hash>.wav` | SAPI 产物（降级时） | `tts.js` | 同上 |
| `data/tts-cache/<hash>.json` | 旁挂索引 `{voice,rate,pitch,bytes,durationMs,est,createdAt,lastHitAt,hits,engine}` | `tts.js` | 同上 |
| `data/tts-cache/.tmp/` | 原子写入暂存区（同卷 `rename`） | `tts.js` | 启动时清空 |
| `data/tts-cache/sapi-tmp/` | 熔断期降级产物，TTL 1h，不计入 LRU 配额 | `tts.js` | — |
| `data/fallback-audio/<slot>/<file>.mp3` | 本地兜底曲库（**自有素材**，非版权内容） | 人工放置 | 建议备份 |
| `data/logs/radio-YYYY-MM-DD.jsonl` | 结构化日志（单行 JSON） | 全体 | 保留 30 天，`prune` 连带清理 |
| `data/music-health.json` / `data/tts-status.json` | 逐源健康与引擎探测快照 | `providers/music`、`tts.js` | — |
| `knowledge/{prompts,user}/…` | 五份语料（**只读业务数据**，经 `PUT /api/taste` 或手工编辑） | 用户 / `PUT /api/taste` | 每次 PUT 自动备份 |
| `knowledge/.history/` | 语料历史版本（`<name>.<sha1前8>.<ts>.bak`，保留最近 20 份） | `PUT /api/taste` | 本身即备份 |
| `config/` | `radio.json`、`tts.yml`、`music.json`、`calendar.yml`、`.env` | 人工 | 不进 git（`.env`） |

### 7.2 `/tts/:hash.mp3` 静态路由与路径白名单校验

**路由**：`GET|HEAD /tts/:hash`，`hash` 形式为 `<16位hex>`，扩展名可为 `mp3` / `wav`；实际文件不存在时回落到同名 `.wav`。**不校验令牌**（总览 §9）。

```js
// 校验顺序不可调换：先语法、再白名单映射、最后两道路径防线
function resolveTtsPath(paramHash) {
  const m = /^([0-9a-f]{16})(?:\.(mp3|wav))?$/.exec(paramHash);   // ① 语法白名单
  if (!m) throw new RadioError('E_PATH_REJECTED', '路径不在白名单内', { detail: { paramHash } });
  const hash = m[1];
  for (const ext of [m[2] ?? 'mp3', 'mp3', 'wav']) {              // ② 声明扩展名优先，再回落
    const p = path.join(TTS_CACHE_DIR, `${hash}.${ext}`);         // ③ 只由「常量目录 + 已校验 hash」拼出
    const abs = path.resolve(p);
    if (!abs.startsWith(TTS_CACHE_DIR + path.sep)) throw new RadioError('E_PATH_REJECTED', '…');
    if (fs.existsSync(abs) && fs.realpathSync(abs).startsWith(TTS_CACHE_DIR + path.sep)) {  // ④ 符号链接防线
      return { abs, mime: ext === 'mp3' ? 'audio/mpeg' : 'audio/wav' };
    }
  }
  throw new RadioError('E_NOT_FOUND', '音频不存在');
}
```

| # | 规则 | 拒绝示例 |
|---|---|---|
| 1 | 参数必须整体匹配 `^[0-9a-f]{16}(\.(mp3\|wav))?$`（**小写 hex、定长 16 位**） | `ABCDEF0123456789.mp3`、`../../etc/passwd`、`x.mp3` |
| 2 | 文件名**只能由已校验的 hash + 白名单扩展名拼接**，永不直接使用客户端字符串 | `?h=$(id).mp3`、`..%2f..%2fconfig%2f.env` |
| 3 | `path.resolve` 后必须以 `TTS_CACHE_DIR + path.sep` 开头（防 `..` 逃逸） | 任何解析到缓存目录之外的路径 |
| 4 | 对存在的文件再跑一次 `fs.realpathSync` 校验（防符号链接逃逸） | 指向 `C:\Windows\…` 的软链 |
| 5 | 拒绝含 NUL、`\`、UNC 前缀、绝对路径的输入 | `\\?\C:\x.mp3`、`%00` |
| 6 | 只允许 `GET` / `HEAD`；其余方法 405 | `POST /tts/…`、`DELETE /tts/…` |
| 7 | 响应头固定：`Content-Type`（如实声明 `audio/mpeg` / `audio/wav`）、`Accept-Ranges: bytes`、`Cache-Control: public, max-age=31536000, immutable`；带 `Range` 时返回 `206` + `Content-Range`（iOS Safari 依赖 Range） | — |
| 8 | 未命中返回 **404 + JSON 错误体**（`E_NOT_FOUND`），不返回 HTML | — |
| 9 | 日志只记 `hash`、`ext`、命中与否、`bytes`，**不记 `say` 文本** | — |

**其余静态资源**：`/`、`/app/*`、`/sw.js`、`/manifest.webmanifest`、`/favicon.ico` 映射到 `web/` 目录，同样执行「白名单常量映射 + `path.resolve` 前缀校验 + `realpathSync` 二次校验」三道防线，禁止目录列表。

### 7.3 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `HOST` / `PORT` | `127.0.0.1` / `8080` | 绑定地址；改 `0.0.0.0` 必须同时配 `RADIO_AUTH_TOKEN` |
| `RADIO_AUTH_TOKEN` | 空 | 访问令牌（对应 `config.radio.authToken`） |
| `CLAUDIAO_DSH_BIN` | `…\resources\runtime\cli\bin\dsh.cmd` | `dsh` 可执行文件**绝对路径**（不在 PATH）。**必须**加 `CLAUDIAO_` 前缀，见下方警告 |
| `CLAUDIAO_DSH_PROFILE` | `dj-brain` | profile 名，对应 `<DSH_HOME>/profiles/<name>` |
| `CLAUDIAO_DSH_CWD` | `D:\DJ` | 大脑子进程工作目录，**必须**是项目根（否则 session 落到别的 `sessions/<cwd安全化>/`） |
| `DSH_HOME` | `C:\Users\wumingtao\.dsh` | 会话与凭据根目录（session 落在 `sessions/--D-DJ--/<sid>`）。**不加前缀**——它是 DSH 自己的变量，本项目只读 |
| `BRAIN_TIMEOUT_MS` / `BRAIN_MAX_CONCURRENCY` | `30000` / `1` | 大脑单轮超时（总览 §4.3）与子进程并发硬上限（§5.3） |
| `MUSIC_SOURCES` | `netease,joox` | 源降级链顺序（实测 `kuwo`/`tencent`/`migu`/`kugou` 返回 400/503，默认不启用） |
| `WEATHER_API_KEY` / `WEATHER_TIMEOUT_MS` | 空 / `5000` | 天气注入为**可选**能力；key 为空时第 ③ 片用「今天」兜底文案，其余功能零影响 |
| `ROUTINES_TZ` | `system` | 调度时区（`config/routines.yml` 的 `timezone`） |
| `CLAUDIAO_EDGE_TTS_BIN` | `D:\python\Scripts\edge-tts.exe` | 绝对路径，不依赖 PATH |
| `TTS_ENGINE` / `TTS_VOICE` / `TTS_RATE` / `TTS_PITCH` | `auto` / `zh-CN-XiaoxiaoNeural` / `+0%` / `+0Hz` | 引擎与音色（[04](04-tts-pipeline.md) §9） |
| `DJ_TTS_CACHE_DIR` | `data/tts-cache` | TTS 缓存目录，必须在 `data/` 之下 |
| `DJ_DATA_DIR` | `data` | 数据根目录 |
| `LOG_PROMPT` | `0` | `1` 才落 prompt / `say` 全文；默认只落长度与 `sha1[:8]`（总览 §9） |
| `LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error` |
| `TZ` | `Asia/Shanghai` | 本地日与 `dateKey` 计算基准 |

> ⚠️ **变量名前缀是硬规则（实测踩坑）**：DeepSeek Harness 自身会向进程环境注入 `DSH_PROFILE=desktop`（以及 `DSH_HOME`、`DSH_SESSION_ID`）。本项目若用**无前缀**的 `DSH_BIN`/`DSH_PROFILE`/`DSH_CWD`，从 DSH 内部启动电台时 `.env` 的值会被静默覆盖，大脑报 `error: profile "desktop" is managed exclusively by the Electron application`。故三者统一加 `CLAUDIAO_` 前缀，`doctor` 的第 3b 项专门检测无前缀冲突（[需求与准备清单](09-requirements-checklist.md) §3 / [进度表](10-progress-tracker.md) 变更日志）。

### 7.4 `GET /api/health`（**非 6 条线的运维端点**）

`/api/health` 不属于施工图的 6 条线，也不被 PWA 业务逻辑依赖；它由 [部署与运维](13-deployment-ops.md) 与 `doctor` 使用，`config/radio.yml` 的 `observability.healthDetail` 控制详细程度。**前端不得依赖它做功能判断**——运行时状态请用 `GET /api/now` 的 `health` 段（§2.2）。

| 请求 | 响应 |
|---|---|
| `GET /api/health`（`healthDetail:false`） | `{"ok":true}` |
| `GET /api/health`（`healthDetail:true`） | `{"ok":true,"data":{"brain":true,"tts":true,"music":true,"weather":false,"rssMb":184,"uptimeSec":9374,"doctor":{"fail":[],"warn":["weather_api_key_empty"]},"music":{"netease":true,"joox":true}}}` |

**启动顺序约束**：`npm start` 先 `listen(8080)`，**之后**才异步跑一次 `doctor`（不含 `--deep`）；`FAIL` 项写日志并在此端点暴露，但**不因此拒绝启动**——`D-08` 要求电台尽量在响。

### 7.5 `GET|PUT /api/prefs`（**Settings 视图的持久化端点**）

> **为什么需要它**：施工图的第四层明确要求 PWA 有 **Settings 视图**，而 6 条 HTTP 线里没有任何写端点。
> 若不给 Settings 一个后端，前端只有两个选择：要么伪造保存成功（不可接受），要么把开关做成禁用态、
> 要求用户手改 `config/.env` 后重启（体验差且违背「改完下次生效」的产品直觉）。
> 故本节补一个**运维/偏好端点**，与 `/api/health` 同属「非 6 条线的必要补充」，由 `## 附` 的契约变更规则管辖。
>
> **与 6 条线的关系**：`GET /api/prefs` 是 `GET /api/taste` 的姊妹端点——前者管**运行时偏好**（音色、节律、静默时段），
> 后者管**品味语料**（`knowledge/user/*.md`）。二者都用 `baseSha1` / `baseRev` 做乐观并发。

**两层配置模型（本节的核心约定）**：

```
优先级从低到高：
  ① config/.env          环境相关（路径、密钥、端口）—— 只读，进程启动时装载
  ② config/*.yml         业务调参（节律、播放、缓存）—— 只读，进程启动时装载
  ③ SQLite prefs 表      运行时偏好（音色、静默时段开关、主动播报开关）—— ★ 可写
```

**`prefs` 只允许覆盖白名单内的键**，其余键写入即 `E_PREFS_KEY_FORBIDDEN`。
白名单的存在是为了防止把 `.env` 里的密钥/路径写进数据库（会被备份带走）。

| 白名单键 | 类型 | 默认来源 | 说明 |
|---|---|---|---|
| `tts.voice` | string | `.env` `TTS_VOICE` | 音色。改后缓存键变化，旧缓存自然淘汰（D-07） |
| `tts.rate` | string | `.env` `TTS_RATE` | 语速，如 `+10%` |
| `tts.pitch` | string | `.env` `TTS_PITCH` | 音调 |
| `tts.fallbackEnabled` | bool | `.env` `TTS_FALLBACK_ENABLED` | 是否允许降级到 SAPI |
| `scheduler.enabled` | bool | `routines.yml` `enabled` | 主动播报总开关 |
| `scheduler.quietHours` | `{start,end}` | `routines.yml` `quietHours` | 静默时段 |
| `scheduler.slotsDisabled` | string[] | `[]` | 按 slot 名单独关闭，如 `["hourly_check"]` |
| `playback.maxTracksPerBroadcast` | int(1–5) | `radio.yml` | 单次播报曲目上限 |
| `playback.avoidRecentHours` | int | `radio.yml` | 去重窗口 |
| `music.sources` | string[] | `.env` `MUSIC_SOURCES` | 音源降级链，仅允许实测可用的源 |
| `frontend.theme` | string | `radio.yml` | 主题（`dark`/`light`） |

**请求 / 响应**：

| 请求 | 说明 | 响应 |
|---|---|---|
| `GET /api/prefs` | 读全部偏好（含来源标注） | `{"ok":true,"data":{"rev":7,"values":{"tts.voice":"zh-CN-XiaoxiaoNeural",…},"sources":{"tts.voice":"prefs","scheduler.enabled":"yml"}}}` |
| `PUT /api/prefs` | 局部写 | `{"ok":true,"data":{"rev":8,"applied":["tts.voice"],"restartRequired":[]}}` |

`PUT` 请求体：

```json
{ "patch": { "tts.voice": "zh-CN-YunxiNeural", "scheduler.quietHours": { "start": "23:30", "end": "07:00" } },
  "baseRev": 7 }
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `patch` | ✅ | 局部更新；只允许白名单键。值 `null` 表示**删除该键、回退到 `.env`/`.yml` 默认** |
| `baseRev` | — | 乐观并发。与当前 `rev` 不符 → `409 E_PREFS_CONFLICT`（响应带当前 `rev` 与 `values`，前端可自动合并重试） |

**生效时机**（前端必须如实展示，不得假装已生效）：

| 键类别 | 生效时机 | `restartRequired` |
|---|---|---|
| `tts.*` | **下一次合成立即生效**（缓存键含 voice/rate/pitch） | ❌ |
| `scheduler.*` | 下一次 tick 生效（≤60s，见 [07](07-scheduler-rhythm.md) §7 的热加载表） | ❌ |
| `playback.*` `frontend.*` | 下一次触发/下次请求生效 | ❌ |
| 任何 `.env` 内的**非白名单**项 | 需改文件 + 重启 | ✅ |

**错误码**：

| 码 | HTTP | 触发 |
|---|---|---|
| `E_PREFS_KEY_FORBIDDEN` | 422 | `patch` 含白名单外的键（响应 `detail.forbidden[]` 列出） |
| `E_PREFS_VALUE_INVALID` | 422 | 类型/取值范围不符（如 `maxTracksPerBroadcast: 9`） |
| `E_PREFS_CONFLICT` | 409 | `baseRev` 与当前 `rev` 不符 |
| `E_PREFS_WRITE_FAILED` | 500 | SQLite 写失败 |

**实现约束**：

1. `rev` 单调递增，存 `prefs` 表的元数据行；每次成功写入 `+1`。
2. 读取顺序固定为 `prefs` → `.env` → `.yml` → 代码内置默认，**首个存在的值获胜**。
3. 本端点**不进 WS 广播**。偏好变化的可见效果自然通过下一次 `state-change` / `now-playing` 体现；无客户端时也允许改（这是配置，不是实时状态）。
4. 若 `PUT` 触碰了 `music.sources`，服务端必须校验每个源都在「实测可用集合」（`netease`/`joox`）内，否则 `E_PREFS_VALUE_INVALID`——避免用户把已知失效的源写进去（见 [06](06-music-provider.md) 的多源实测结论）。

---

## 附：契约变更规则

1. 本文档是前后端**唯一契约**；任何字段增删必须先改本文档，再改实现。
2. **只增不改**：新增可选字段属**向后兼容**，可随版本发布；重命名/删除字段必须同时升 `DjAction` 或 `Broadcast` 的主版本号（`v1` → `v2`）。
3. `DjAction` 的版本由 `dj-persona.md` 的输出契约与本文档 §4 的 schema 共同定义，二者必须同步修改。
4. 端点的**降级语义**（失败仍返回 200 且 `degraded=true`）是契约的一部分，前端不得把 `degraded=true` 当作错误处理。

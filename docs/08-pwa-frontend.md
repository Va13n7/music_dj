# Claudiao · 前端 PWA

> 文档版本 v1.0 · 状态：设计完成，待实现
> 上游依据：[设计总览 §2 第四层](01-architecture-design.md#第四层--交互表层) 与 [§8 状态机](01-architecture-design.md#8-状态机) · 施工图 `docs/assets/blueprint-original.jpg` 的 `PWA/ · LOCALHOST:8080` 格
> 关联：[接口契约](03-api-contract.md)（**WS 协议与 `Broadcast` 字段的唯一权威**）· [TTS 声音管线](04-tts-pipeline.md) · [大脑适配器](05-brain-adapter.md) · [调度与节律](07-scheduler-rhythm.md)
> 本文档**不自造协议**：所有事件名、字段名、缓存键均取自 [03](03-api-contract.md#3-ws-协议) 与 [04](04-tts-pipeline.md#7-segue-与-say-的流水线时序)；只补充前端侧的消费逻辑与实现细节。

## 1. 目标与约束

### 1.1 体验目标

| 场景 | 目标 |
|---|---|
| **手机** | 像收音机：点开一秒内出声；单手够得到播放键；息屏回来还在播；可从主屏图标进入，不装 App |
| **桌面** | 像播放器：大封面 + 歌词 + 队列可见；键盘可控（空格暂停、←/→ seek）；`reason` 与主播文案可读 |
| **反馈** | 跳过/顶/踩一次点击完成，不需要打字；选曲权重因此变化（`F-08`） |
| **失败** | 后端降级（`degraded=true`）对用户表现为「主播换了句话」或一个橙色小角标，**绝不弹窗、绝不静音**（`D-08`） |

### 1.2 硬约束

| # | 约束 | 来源 | 落地方式 |
|---|---|---|---|
| C-01 | **零框架**：原生 JS + HTML + CSS | 施工图原文 | 无构建步骤，`web/` 即产物，服务端直接静态托管 |
| C-02 | **单 `<audio>` 元素串行播放** | [01 `D-05`](01-architecture-design.md#7-关键设计决策) | 移动浏览器对同时多路播放有硬限制；队列 = 有序播放项列表，永远只有一个 `src` |
| C-03 | 跑在 `http://localhost:8080` | [01 §2 第四层](01-architecture-design.md#第四层--交互表层) | 与后端同源 → 无跨域；SW 作用域为 `/` |
| C-04 | 6 条 HTTP 线 + `/tts/:hash.mp3` | [01 §2](01-architecture-design.md#第四层--交互表层) | `POST /api/chat` `GET /api/now` `GET /api/next` `GET /api/taste` `PUT /api/taste` `GET /api/plan/today` + `WS /stream`。运维端点族（Settings 视图依赖）：`GET\|PUT /api/prefs`、`GET /api/lyric`、`GET /api/health`，见 [03 §7.4/§7.5](03-api-contract.md)。**前端不新增任何业务 HTTP 端点** |
| C-05 | 鉴权：`Authorization: Bearer <token>` 或 `?token=`；静态资源不校验 | [01 §9](01-architecture-design.md#9-安全与合规) | 浏览器 `WebSocket` 不支持自定义 header → `/stream` **必须**带 `?token=`；其余 `fetch` 带 header |
| C-06 | 默认绑 `127.0.0.1` | [01 §9](01-architecture-design.md#9-安全与合规) | 手机访问需后端改 `0.0.0.0` **且必须**配 `RADIO_AUTH_TOKEN`（见 [`config/.env.example`](../config/.env.example)） |
| C-07 | 离线可开壳层 | `F-10` | app shell 走 cache-first；离线页可读缓存曲目与缓存播报音频 |
| C-08 | 不下载留存音乐 | [01 §9](01-architecture-design.md#9-安全与合规) | SW **不**缓存音乐直链（临时 CDN URL + 版权边界），只缓存 `/tts/*.mp3`（自产内容）与 `/api/lyric`（元数据） |

### 1.3 在四层架构中的位置

```
web/ ──HTTP/WS──▶ src/server.js ──▶ router ──▶ context ──▶ brain ──▶ {tts, music, state}
  ▲                                                                        │
  └────────── WS /stream：now-playing · state-change · say-* · queue-update ─┘
```

前端是**纯消费者**：不决定播什么、不拼 prompt、不认识 `sessionId`。它只做四件事 —— 渲染状态、串行播放、上报交互、缓存壳层。

## 2. 三视图设计

`web/index.html` 内含三个 `<section data-view>`，用 hash 路由切换（`#/player` 默认、`#/profile`、`#/settings`）。**不引入路由库**：

```js
const VIEWS = ['player', 'profile', 'settings'];
function route() {
  const v = VIEWS.includes(location.hash.slice(2)) ? location.hash.slice(2) : 'player';
  for (const el of document.querySelectorAll('[data-view]')) el.hidden = el.dataset.view !== v;
  document.body.dataset.view = v;                      // 供 CSS 做单视图特化
  if (v === 'profile') profile.load();                 // 懒加载 GET /api/taste?file=all
  if (v === 'settings') settings.load();               // 懒加载 GET /api/now?verbose=1（health 段）
}
addEventListener('hashchange', route);
```

### 2.1 `Player` —— 主播放大屏

```text
┌───────────────────────────────────┐
│ Claudiao            ● 直播中   🔊 ⚙ │ ← 顶栏：state-change 状态点 / 音量抽屉 / 跳 Settings
├───────────────────────────────────┤
│         ┌───────────────┐         │
│         │               │         │ ← queue[0].coverUrl，失败落占位 SVG（§8.6）
│         │    封面/占位    │         │
│         └───────────────┘         │
│         李志 - 下雨                  │ ← #np-title（now-playing.queue[0]）
│         梵高先生 · 04:05            │ ← #np-sub（album · durationMs，缺失则隐藏）
│  ▁▃▅▇▅▃▂▁▂▃▅▇▅▃▂▁▂▃▅▇▅▃▂▁▂▃▅▇    │ ← 频谱条（纯 CSS 动画；SPEAKING 时切声波样式）
│  00:41 ──────●──────────  04:05    │ ← #seek（range，见 §8.1）
│      ⏮      ⏯      ⏭      ♡   ✕   │ ← 上一首/暂停/下一首/顶/踩
├───────────────────────────────────┤
│ 主播说                              │
│ 外面下着小雨，这种天儿不适合说话…      │ ← #say（now-playing.say.text；say-start/ say-end 驱动高亮）
│ 听完这两首，如果雨还没停…             │ ← #segue（now-playing.segue，纯文本；音频走 segue-ready）
├───────────────────────────────────┤
│ 为什么放这首                         │
│ 用户明确提到下雨且要安静，命中 mood-rules│ ← #reason（now-playing.reason，不进 TTS）
├───────────────────────────────────┤
│ 歌词                                │
│   ↑ 当前行高亮，自动滚动居中           │ ← #lyric（queue[0].lyricUrl → /api/lyric）
├───────────────────────────────────┤
│ [ 来点适合下雨天的歌…        ] 发送  │ ← #chat-input → POST /api/chat
│ 你：下雨了，来点安静的                │ ← #chat-log（本地维护，最近 6 轮）
│ Claudiao：好，那就慢一点。            │
└───────────────────────────────────┘
```

| 组件 | 绑定的 API / WS | 交互流 |
|---|---|---|
| `#np-*` 曲目信息 | `now-playing` ／ `queue-update` ／ 断线时 `GET /api/now` | 收到即淡入替换（120ms），高度固定不重排（防抖动） |
| `#seek` 进度条 | 本地 `<audio>` + WS `seek` | 拖动中冻结写回；`change` 时本地 `currentTime` + 上报 `seek{positionMs}`；失败触发重解析（§4.1） |
| `⏮` 上一首 | 本地队列 | 回退一项；**不发网络请求**（跳过已在切歌时计入） |
| `⏯` 暂停/继续 | WS `pause{positionMs}` / `resume{positionMs?}` | 本地立即 `audio.pause()`；服务端据此把状态推成 `IDLE` 并保留 `positionMs` |
| `⏭` 下一首（跳过） | WS `skip{playedMs}` | 先本地切歌（0ms 响应），再上报；服务端记 `plays.skipped=1` 并推 `now-playing` + `queue-update` |
| `♡` 顶 | WS `feedback{trackId, value:1}` | 图标实心 + 微动画；乐观更新，失败回滚 |
| `✕` 踩 | WS `feedback{trackId, value:-1}` | 图标变红；服务端把该曲目加入 **24h 短期排除**；本地 2s 后自动跳过（留后悔时间，再点取消） |
| `#say` | `now-playing.say` + `say-start` / `say-end` | 按下发的 `durationMs` 按 `timeupdate` 比例推进高亮；`say-end{skipped}` 收尾 |
| `#segue` | `now-playing.segue`（文本）+ 服务端 `segue-ready{url}` | 文本立即显示；音频 URL 到达后填入队列（§3.1） |
| `#reason` | `now-playing.reason` | 折叠卡片（§8.5）；另有**单曲级** `queue[].reason` 供队列列表逐首展示 |
| `#lyric` | `queue[0].lyricUrl`（`/api/lyric?source=…&id=…`） | 切歌时按 `id` 拉取并缓存；当前行高亮 + 居中滚动 |
| `#chat-input` | `POST /api/chat {text}` | 提交后立即清空并本地追加「你：…」；禁用发送键直至收到首个 `state-change`；`user_chat` 允许打断当前播放 |
| 顶栏状态点 | `state-change{state, prevState, since, stateRev, reason}` | `IDLE` 灰 / `THINKING` 呼吸 / `RESOLVING` 黄 / `SPEAKING`·`PLAYING` 绿 / `MUSIC_ONLY` 蓝 / `DEGRADED`·`FALLBACK_AUDIO` 橙 |
| 大脑进度 | `brain-status{phase, turn, elapsedMs}` | `THINKING` 时在状态点旁显示「思考中 · 第 N 步 · 3.2s」；**载荷不含大脑正文** |

### 2.2 `Profile` —— 品味语料在线编辑（`F-09`）

```text
┌───────────────────────────────────┐
│ ← 品味语料            语料版本 9a1c4e77│ ← GET /api/taste → corpusHash
├───────────────────────────────────┤
│ [taste][routines][mood-rules][playlists][persona] │ ← 五个 tab，白名单固定
├───────────────────────────────────┤
│  # 我的音乐品味                       │
│  偏爱 2000 年代华语民谣与城市民谣；      │ ← <textarea spellcheck=false>，等宽 + 行号栏
│  女声优先；不喜欢电音 drop。            │
│                                     │
├───────────────────────────────────┤
│ 6,218 B · sha1 3c7a91de · 未保存 ●    │ ← 字数 / baseSha1 / 脏标记
├───────────────────────────────────┤
│ [ 保存 ]   [ 校验（dryRun） ]  [ 撤销 ] │
└───────────────────────────────────┘
```

| 组件 | 绑定的 API | 交互流 |
|---|---|---|
| 五 tab | `GET /api/taste?file=all` | 一次拉全量（含 `corpusHash`、每文件 `sha1`/`bytes`/`mtime`/`content`）后本地缓存；切 tab 不重发 |
| `<textarea>` | — | 300ms 防抖比对「上次保存内容」，差异 → 置脏、`保存` 激活、底栏变 `●` |
| 校验 | `PUT /api/taste {file, content, baseSha1, dryRun:true}` | 只校验不落盘，返回结论与 diff 行数；`playlists` 必须 `JSON.parse` 成功且含 `playlists` 数组 |
| 保存 | `PUT /api/taste {file, content, baseSha1}` | 成功 → 更新 `sha1`/`mtime`，提示「**下一次触发生效，无需重启**」（`F-09`）；`unchanged:true` 时不提示保存成功 |
| 409 冲突 | 错误码 `E_TASTE_CONFLICT` | 弹出「语料已被其他改动更新 · 重新加载 / 强制覆盖」，**不静默覆盖** |
| 撤销 | — | 回填 `sha1` 对应内容，清脏标记 |

**安全约束**：`file` 是**服务端白名单**（`taste|routines|mood-rules|playlists|persona`），前端只从固定 tab 取值，**不拼接路径、不允许自定义文件名**（对齐 [01 §9](01-architecture-design.md#9-安全与合规) 的路径白名单）。`persona` tab 顶部常驻一行警示：「这是 DJ 的人格与输出契约，改坏会导致 `DjAction` 解析失败并触发模板降级」。

### 2.3 `Settings` —— 音色 / 节律 / 音源 / 静默时段

```text
┌───────────────────────────────────┐
│ ← 设置                    当前来源 .env│ ← 标出哪些值来自 config/.env（只读）
├───────────────────────────────────┤
│ 音色                                │
│   语音   [ 晓晓（女·温暖）      ▾ ]  │ ← TTS_VOICE 的 8 个实测中文音色
│   语速   ────●──────  +0%          │ ← TTS_RATE  -50%…+50%
│   音调   ──────●────  +0Hz         │ ← TTS_PITCH -50Hz…+50Hz
│   引擎   edge-tts（就绪） · SAPI 兜底 │ ← GET /api/now?verbose=1 的 health.tts
│   [ ▷ 试听 ]  缓存 318 条           │ ← 试听固定句 → /tts/<hash>.mp3
├───────────────────────────────────┤
│ 节律                                │
│   07:00 当日规划          [ ✓ ]     │ ← routines.yml 的 slot 开关
│   09:00 早间播报          [ ✓ ]     │
│   整点情绪检查            [ ✓ ]     │ ← 09:00–22:00 内启用（Q-03） |
├───────────────────────────────────┤
│ 音源                                │
│   提供方  netease → joox（降级链）    │ ← MUSIC_SOURCES；health.music 逐源延迟
│   [ 测试连通性 ]  netease 240ms ✓    │
├───────────────────────────────────┤
│ 静默时段                            │
│   23:30 ── 07:00          [ ✓ ]     │ ← 时段内不出声，仅静默排歌
├───────────────────────────────────┤
│ 访问令牌 [ •••••••••••• ] [复制]      │ ← localStorage['dj.token']，改后重连 WS
│ 版本 v1.0 · SW dja-shell-v1 · [检查更新]│
└───────────────────────────────────┘
```

**持久化归属（重要 · 契约缺口）**：[03](03-api-contract.md) 的 6 条线里**没有 Settings 的写端点**；`TTS_VOICE`/`TTS_RATE`/`TTS_PITCH`/`MUSIC_SOURCES` 目前是 `config/.env` 项（[03 §7](03-api-contract.md)、[04 §9](04-tts-pipeline.md)），节律与静默时段属 `config/routines.yml`。因此本期 Settings 的落地是：

| 能力 | 本期行为 | 说明 |
|---|---|---|
| 展示当前值 | ✅ 只读 | 值来自 `GET /api/now?verbose=1` 的 `health` 段 + 模板渲染期注入的只读配置快照 |
| 修改并即时生效 | ⏳ 待契约补齐 | 见下方「未决 U-01」 |
| 试听 | ✅ | 前端算 `sha1(voice\|rate\|pitch\|text)[:16]` 后直接 `GET /tts/<hash>.mp3`；命中 <50ms，未命中 ≤3s/百字（`N-02`） |
| 检查更新 | ✅ | SW `registration.update()`（§6.3） |

**U-01（已解决）**：[03 §7.5](03-api-contract.md) 已补齐 **`GET|PUT /api/prefs`**。Settings 视图的开关**可写**，采用 `{patch, baseRev}` 乐观并发，遇 `409 E_PREFS_CONFLICT` 时用响应里的最新 `rev`/`values` 自动合并重试一次。前端按 03 的**生效时机表**如实展示：

- `tts.*` → 提示「下次播报生效」（缓存键含 voice/rate/pitch，见 D-07）
- `scheduler.*` → 提示「60 秒内生效」（调度 tick 热加载，见 [07](07-scheduler-rhythm.md)）
- 白名单外的项（端口、密钥、路径）→ 渲染为**只读**，提示「改 `config/.env` 后重启」

**不得**把只读项渲染成可点的开关，也**不得**在 `409` 后静默丢弃用户的修改。`settings.writable` 降级开关保留：若 `GET /api/prefs` 返回 404（对接旧版后端），整体退化为只读 + 一行提示，不报错、不阻塞其他视图。

## 3. 播放器状态机（前端侧）

前端状态**与后端同名同义**，后端是权威，前端只做投影。虚线节点为**前端独有**，不来自 WS。

```text
   ┌ ─ ─ ─ ─ ─ ┐  首次 pointerdown（§9）        ┌──────────┐
   │  LOCKED   │ ─────────────────────────────▶ │   IDLE   │◀──────────────┐
   └ ─ ─ ─ ─ ─ ┘  解锁 + 拉 GET /api/now         └────┬─────┘               │
                        state-change:THINKING        │                     │ 队列空
                                                     ▼                     │ 且无播报
   ┌ ─ ─ ─ ─ ─ ─ ─┐  WS 断开        ┌──────────┐                     ┌──────┴───────┐
   │ RECONNECTING │◀────────────────┤ THINKING │                     │  MUSIC_ONLY  │
   │ 轮询 /api/now │────────────────▶└────┬─────┘                     └──────┬───────┘
   └ ─ ─ ─ ─ ─ ─ ─┘  WS 恢复             │ now-playing                    │
        ▲                                 ▼                                │
        │                          ┌───────────┐  queue[] 全无直链 ┌────────▼─────┐
        └ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─│ RESOLVING ├─────────────────▶│FALLBACK_AUDIO│
                                   └─────┬─────┘                  └──────┬───────┘
              queue 就绪 + say.audioUrl   │                             │
                                         ▼                             │
                                   ┌──────────┐  say.skipped=true      │
                                   │ SPEAKING ├────────────┐           │
                                   └────┬─────┘            │           │
                                        │ ended            ▼           │
                                        │            ┌──────────┐      │
                                        │            │MUSIC_ONLY│      │
                                        │            └────┬─────┘      │
                                        ▼                 │            │
                                   ┌──────────┐           │            │
                                   │ PLAYING  │◀──────────┘            │
                                   └────┬─────┘                        │
                                        │ ended / skip                 │
                                        ├─ 队列非空 → 下一项 PLAYING    │
                                        └─ 队列空 ─────────────────────┘
   DEGRADED（degraded=true）与 PLAYING/SPEAKING 同构，仅多橙色角标与 degradedReasons 提示；
   同样必须能自行回 IDLE。
```

**不变量（与 [01 §8.1](01-architecture-design.md#81-电台播放状态机) 一致）**：`SPEAKING` 与 `PLAYING` 互斥（永远只有一个 `<audio>` 在响）；任意状态收到 `user_chat` 触发 → 允许打断，直接进 `THINKING`；`DEGRADED`/`FALLBACK_AUDIO`/`MUSIC_ONLY` 都必须能自行回 `IDLE`，不允许卡死。

| 前端状态 | 进入触发 | `<audio>` 动作 | 退出触发 |
|---|---|---|---|
| `LOCKED`（本地） | 页面加载 | 无 `src`，`preload="none"` | 首次 `pointerdown` 解锁成功 → `GET /api/now` 对齐 → `IDLE`（§9） |
| `IDLE` | 队列空且无播报；或 `state-change:IDLE` | `pause()`，**保留 `src`**（便于秒回） | `now-playing` → `SPEAKING`；`state-change:THINKING` → `THINKING` |
| `THINKING` | `state-change:THINKING` + `brain-status` | 正在播则**不打断**（后端允许继续响）；空闲则播「占位过渡语」（`Q-04`） | `now-playing` 到达 |
| `RESOLVING` | `now-playing` 到达但 `queue[0]?.audioUrl` 为空 | 空闲时先播 `say.audioUrl`（若有） | 直链就绪 → `SPEAKING`；全失败 → `FALLBACK_AUDIO` |
| `SPEAKING` | 队列首项 `kind==='say'` 且 `say.audioUrl` 就绪（服务端在进入 `SPEAKING` 时预发 `say-start`） | `src=say.audioUrl; play()` | `ended` → 下一项；`say.skipped` → `MUSIC_ONLY` |
| `PLAYING` | 当前项 `kind==='track'` | `src=audioUrl; play()` | `ended`/`skip` → 下一项或 `IDLE` |
| `MUSIC_ONLY` | `say.skipped===true`（TTS 降级）或 `say.audioUrl` 为空 | 直接播 `queue[0]` | `ended` → 下一项或 `IDLE` |
| `DEGRADED` | `now-playing.degraded===true` 或 WS `error{fatal:false}` | 与 `PLAYING` 相同 | 曲目结束且队列空 → `IDLE` |
| `FALLBACK_AUDIO` | `degradedReasons` 含 `music_fallback_audio` | 播 `data/fallback-audio/` 暴露的静态 URL | `ended` → `IDLE` |
| `RECONNECTING`（本地） | WS `onclose` / 45s 无服务端帧 | 继续播本地队列（**不断音**） | 重连成功 → `GET /api/now` 全量对齐 |

### 3.1 串行逻辑：先播 `say`，再播音乐；`segue` 插在中间

`Broadcast.segue` 是**文本**，它的音频由服务端在剩余 10s 窗口内合成，经 `segue-ready{hash,url,durationMs,forTrackId}` 推来（[04 §7.1](04-tts-pipeline.md#7-segue-与-say-的流水线时序)）。单 `<audio>` 下无法叠加音轨（`D-05`），所以 `segue` 是**队列项**，插在当前曲目与下一首之间：

```js
// now-playing（= Broadcast）到达：重建队列。数组顺序 === 播放顺序
function onNowPlaying(b) {
  playlist = [
    ...(b.say && !b.say.skipped && b.say.audioUrl ? [{ kind: 'say', url: b.say.audioUrl, text: b.say.text }] : []),
    ...b.queue.map((t) => ({ kind: 'track', ...t })),
  ];
  segueUrl = null;                                    // 等 segue-ready 填入
  segueArmed = false;
  setDegraded(b.degraded, b.degradedReasons);
  playItem(playlist[0] ?? null);
}

// 服务端合成完成 → 填入待播项（可能早于也可能晚于 ended）
function onSegueReady(msg) {
  if (msg.forTrackId === current?.id) segueUrl = msg.url;
}

// ended 是唯一的队列推进源（「跳过」按钮除外）
audio.addEventListener('ended', () => {
  if (current?.kind === 'track' && segueArmed && segueUrl) {   // 曲末衔接语优先于下一首
    playItem({ kind: 'segue', url: segueUrl });
    return;
  }
  const next = playlist.shift();
  if (next) playItem(next); else setState('IDLE');
});
```

| 情形 | 行为 | gap 预算（`F-04`：≤800ms） |
|---|---|---|
| `segue` 已就绪 | `ended` → 播 `segue`（≈2.0s）→ 播下一首 | ≤400ms 切换 + segue 时长 |
| `segue` 未就绪 / `segue === ""` | `ended` → **直接**播下一首，**绝不 `await`** | ≤800ms（[04 §7.3](04-tts-pipeline.md) 规则 1） |
| `queue` 只剩一首 | `ended` → 队列空 → `IDLE`，等下一次触发 | — |

**`queue-update` 的处理**：`added[]` 追加到待播尾部；`removed[]` 从待播里剔除；**不动正在播的项**。`audioUrl` 过期时的替换也走这条事件（服务端重新解析后推 `queue-update`）。

## 4. 单 `<audio>` 播放序列

```html
<audio id="dj-audio" preload="metadata" playsinline></audio>
```

`playsinline` 防 iOS 全屏接管。**不加 `crossorigin`**：音乐 CDN 通常不带 CORS 头，加了会导致加载失败；代价是不能用 `AnalyserNode` 读频谱 —— 因此频谱条是 **CSS 动画**而非真实波形，这也顺带避开了 `AudioContext` 与 autoplay 政策的纠缠。

| 事件 | 触发时机 | 处理 |
|---|---|---|
| `loadedmetadata` | `src` 就绪、`duration` 可得 | ① `Number.isFinite(duration)` 才启用剩余时间判定；② **若当前项是 `say` → 发 `duration-report{hash, durationMs}`** 回填 TTS 缓存真实时长（[04 §8.3](04-tts-pipeline.md)）；③ 更新总时长；④ `setState` 由项类型决定（`say`→`SPEAKING`，`track`→`PLAYING`） |
| `canplay` | 首帧可播 | 上报「起播延迟」指标（§11）；清 `stalled` 计时器 |
| `timeupdate` | 约每 250ms（§4.2） | ① 进度条写回；② **剩余 ≤10s 且当前为 `track` 且未 armed → 发 WS `prefetch{nextIndex}`**（§7）；③ `say` 文本按比例高亮；④ 歌词行高亮（二分查找） |
| `ended` | 自然结束 | **唯一的队列推进源**（§3.1） |
| `error` | 加载/解码失败 | 音乐直链重解析（§4.1）；`say` 失败 → 跳过播报直接放歌 |
| `stalled` / `waiting` | 缓冲不足 | 显示缓冲指示；超 5s → 视为播放失败，走重解析 |
| `play` / `pause` | 状态变化 | 同步 ⏯ 图标；`visibilitychange` 回前台时若 `paused && shouldBePlaying` → `play()` |

### 4.1 `error` 处理：临时 CDN 直链会失效

音乐直链来自公共 API 的**临时 CDN URL（有时效，见 `MUSIC_URL_TTL_SEC`）**，播放失败是常态而非异常：

```js
audio.addEventListener('error', async () => {
  const cur = current;
  if (cur?.kind === 'track') {
    metrics.inc('audio_error_total', { code: audio.error?.code ?? 0 });
    if (await reResolve(cur)) return;                    // ① 重新解析直链
    if (playlist.some((i) => i.kind === 'track')) return next();   // ② 换下一首
    return setState('FALLBACK_AUDIO');                   // ③ 交给后端兜底曲库（01 §5.2）
  }
  if (cur?.kind === 'say') return next();                // 播报失败不阻断音乐（tts 降级的最后一环）
  setState('IDLE');
});
let rereresolved = 0;
async function reResolve(item) {
  if (rereresolved++ >= 2) return false;                 // 同一项最多重解析 2 次，防死循环
  const r = await fetch('/api/now?verbose=1', { headers: authHeaders() });
  const { data } = await r.json();
  const fresh = [data.nowPlaying, ...(data.queue ?? [])].find((t) => t?.id === item.id && t.audioUrl);
  if (!fresh) return false;
  item.audioUrl = fresh.audioUrl;
  audio.src = fresh.audioUrl;
  audio.currentTime = (data.nowPlaying?.positionMs ?? 0) / 1000;
  await audio.play().catch(() => {});
  return true;
}
```

### 4.2 `timeupdate` 精度与「剩余 10s」判定

规范只要求 `timeupdate` 频率落在 **15~250ms**；Chrome/Firefox 实测约 **250ms**，Safari 更密。这足够支撑 10s 阈值：

- 判定 `remain = duration - currentTime <= 10` 时，最坏情况是**实际剩 9.75s** 才触发；
- 服务端从收到 `prefetch` 到推 `segue-ready` 实测 **3.07s**（[04 §7.2](04-tts-pipeline.md)），**余量 3.2×**；
- `duration` 对分片流可能为 `NaN`/`Infinity` → 用 `Number.isFinite` 守卫，此时退到 `durationMs`（`Broadcast.queue[].durationMs`，服务端已知）+ `currentTime` 计算；
- **后台标签页 `setTimeout` 被节流到 ≥1s、`requestAnimationFrame` 直接暂停** → 判定主力**必须是 `timeupdate`**（它在后台仍按媒体时钟推进）。

```js
function tick() {
  if (!current) return;
  const d = Number.isFinite(audio.duration) ? audio.duration : (current.durationMs ?? NaN) / 1000;
  if (!Number.isFinite(d)) return;
  const remain = d - audio.currentTime;
  if (!dragging) { seekEl.max = d; seekEl.value = audio.currentTime; timeEl.textContent = fmt(audio.currentTime) + ' / ' + fmt(d); }
  if (current.kind === 'say') highlightSay(audio.currentTime / d);
  else { if (lyric.length) highlightLyric(audio.currentTime * 1000); }
  if (!segueArmed && current.kind === 'track' && remain > 0 && remain <= 10) {
    segueArmed = true;
    ws.send({ type: 'prefetch', nextIndex: current.index + 1 });   // 施工图的 prefetch 10s
    prefetchWarm();                                                // 前端侧的预热（§7）
  }
}
audio.addEventListener('timeupdate', tick);
```

## 5. WS 客户端

协议全文见 [03 §3](03-api-contract.md#3-ws-协议)；本节只写**前端消费逻辑**。

### 5.1 连接与鉴权

```js
const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
const clientId = sessionStorage.getItem('dj.cid') ??= 'c_' + Math.random().toString(36).slice(2, 8);
const url = `${proto}//${location.host}/stream`
          + `?token=${encodeURIComponent(token())}&clientId=${clientId}&since=${lastSeq}`;
// 浏览器 WebSocket 不支持自定义 header → /stream 只能用 ?token=（C-05）
// 鉴权失败：服务端以 HTTP 401 拒绝升级（不回 101）→ onerror + onclose，不重试鉴权错误
```

| 项 | 值（**取自 03，前端不得硬编码**） |
|---|---|
| 首帧 | 服务端立即发 `hello{epoch, seq, serverTimeMs, stateRev, heartbeatMs, backlogFrom, corpusHash}` |
| 服务端心跳 | `heartbeatMs`（默认 20s）由 `hello` 下发 |
| 客户端 `ping` 间隔 | **25s**（略大于服务端心跳，避免同频碰撞）→ `{type:'ping', seq, ts}` |
| 判定断线 | 客户端 **45s** 未收到任何服务端帧（两倍心跳 + 5s 容差）→ 主动重连；服务端 60s 未收到客户端帧 → `terminate()` |
| 断线补发 | 重连带 `since=<最后收到的 seq>`；服务端从环形缓冲（最近 200 条）补发最多 100 条；超出部分改由 `GET /api/now` 全量对齐 |

### 5.2 事件分发表（S→C）

| `type` | 载荷 | 前端动作 |
|---|---|---|
| `hello` | `epoch, seq, serverTimeMs, stateRev, heartbeatMs, backlogFrom, corpusHash` | 存 `heartbeatMs`；**`epoch` 变化 → 清空 `lastSeq` 与去重集合**（服务端 `seq` 是进程内递增，重启后从 1 开始）；`corpusHash` 变化 → Profile 视图标「语料已更新」 |
| `now-playing` | 完整 [Broadcast](03-api-contract.md#5-broadcast-对象) | 重建队列（§3.1），先播 `say` |
| `state-change` | `{state, prevState, since, stateRev, reason}` | 切状态机 + 顶栏状态点；`user_chat` 后收到的第一个 `state-change` 解除发送键禁用 |
| `say-start` | `{hash, url, text, durationMs, est, startedAt}` | 播报开始：显示文本、按 `durationMs` 驱动高亮 |
| `say-end` | `{hash, playedMs, completed, skipped}` | 收尾；`skipped` → 进 `MUSIC_ONLY` |
| `queue-update` | `{queue[], currentIndex, added[], removed[], stateRev}` | 增量更新待播队列；替换过期 `audioUrl`；**不动正在播的项** |
| `segue-ready` | `{hash, url, durationMs, forTrackId}` | 按 `forTrackId` 匹配当前项 → 填 `segueUrl`（§3.1） |
| `brain-status` | `{phase, turn, elapsedMs, note?}`；`phase ∈ {turn_start, step_start, thinking, text, step_end, turn_end}` | 仅进度指示，「思考中 · 第 N 步 · 3.2s」；**载荷不含大脑正文** |
| `plan-update` | `{date, slot, status, say?, play?, reason?, skipReason?}` | Settings/计划区刷新；与 [07](07-scheduler-rhythm.md) 的 slot 生命周期一致 |
| `error` | `{code, message, detail?, fatal}` | `fatal:false` → 橙色角标 + 行内提示，**电台仍在响**；`fatal:true` → 顶部横幅提示需人工处理 |
| `heartbeat` | `{seq, ts, serverTimeMs}` | 更新「最后一次收到服务端帧」时间戳；可用 `serverTimeMs - Date.now()` 估算时钟偏移并展示在调试角标 |

### 5.3 上行事件（C→S）

| `type` | 载荷 | 前端触发点 |
|---|---|---|
| `ping` | `{seq, ts}` | 每 25s；`seq` 为**客户端自己的**上行序号 |
| `skip` | `{playedMs, at?}` | `⏭` 按钮 |
| `pause` / `resume` | `{positionMs}` / `{positionMs?}` | `⏯` 按钮、`visibilitychange` |
| `seek` | `{positionMs}` | `#seek` 的 `change` 事件 |
| `feedback` | `{trackId, value:1\|0\|-1, at?}` | `♡` / `✕` |
| `prefetch` | `{nextIndex}` | `timeupdate` 判定剩余 ≤10s（§4.2、§7） |
| `duration-report` | `{hash, durationMs}` | `loadedmetadata`（仅 `say` 项，§4） |

未知 `type` 服务端会回 `error{code:'E_BAD_REQUEST', fatal:false}` 且**不断连接**；前端对未知 **S→C** 事件同样**静默忽略**（前向兼容）。

### 5.4 重连：指数退避 + 抖动

```js
let n = 0, lastFrameAt = 0;
function scheduleReconnect() {
  const base = Math.min(30_000, 500 * 2 ** n++);          // 500ms → 1s → 2s → … → 30s（03 §3.4）
  const jitter = base * (Math.random() * 0.4 - 0.2);      // ±20% 抖动，防多客户端同步重连风暴
  setState('RECONNECTING');
  startPolling();                                          // 断线期间降级轮询
  setTimeout(connect, Math.max(300, base + jitter));
}
function connect() {
  ws = new WebSocket(url);
  ws.onopen = () => { n = 0; stopPolling(); startPing(); syncNow(); };   // 成功后 n 清零
  ws.onmessage = (e) => { lastFrameAt = Date.now(); dispatch(JSON.parse(e.data)); };
  ws.onclose = ws.onerror = () => { stopPing(); scheduleReconnect(); };
}
setInterval(() => { if (ws?.readyState === 1 && Date.now() - lastFrameAt > 45_000) ws.close(); }, 5_000);
```

**断线降级**：WS 未连时每 **5s** 轮询 `GET /api/now`（带 `If-None-Match`，304 即无变化），本地队列**继续播**，绝不因断线停播（`D-08`）。

### 5.5 序号去重与漏帧处理

```js
let lastSeq = 0, epoch = null;
const seen = new Set();                                     // 窗口 200
function dispatch(msg) {
  if (msg.type === 'hello') {
    if (msg.epoch !== epoch) { epoch = msg.epoch; lastSeq = 0; seen.clear(); }  // 进程重启 → 水位归零
    return apply(msg);
  }
  if (typeof msg.seq !== 'number') return apply(msg);        // 兜底：无 seq 直接处理（不应发生）
  if (msg.seq <= lastSeq || seen.has(msg.seq)) return;       // ① 补发重复 → 丢弃
  if (msg.seq > lastSeq + 1) {                               // ② 漏帧 → 主动对齐，不等待
    metrics.inc('ws_seq_gap', { from: lastSeq, to: msg.seq });
    syncNow();                                               // GET /api/now 全量对齐（03 §3.4）
  }
  seen.add(msg.seq); if (seen.size > 200) seen.delete(seen.values().next().value);
  lastSeq = msg.seq;
  apply(msg);
}
```

`state-change` 与 `now-playing` 是**幂等快照**（含完整 `queue`），重复应用无害；`say-*`/`queue-update` 是增量，必须靠 `seq` 去重。`stateRev`（服务端单调递增整数）是「谁更新」的最终依据：**不保证跨连接有序**，重连后以 `GET /api/now` 的 `stateRev` 为准。

## 6. Service Worker

`web/sw.js`，作用域 `/`（同源，`C-03`）。

### 6.1 缓存策略表

| 路径模式 | 策略 | 缓存名 | TTL / 上限 | 备注 |
|---|---|---|---|---|
| `/`、`/index.html` | cache-first + 后台更新（stale-while-revalidate） | `dja-shell-v1` | 随版本号失效 | 离线可开壳层（`F-10`、`C-07`） |
| 壳层静态：`/styles.css` `/app.js` `/player.js` `/ws.js` `/manifest.webmanifest` `/icons/*` | cache-first + 后台更新 | `dja-shell-v1` | 同上 | 全部手写、无构建哈希 → 靠 `SW_VERSION` 常量换名 |
| `/api/now`、`/api/taste`、`/api/plan/today` | **network-first**，3s 超时回落 cache | `dja-api-v1` | 30 条 | 离线时可展示上次曲目/语料/规划 |
| `/api/lyric` | **cache-first**（内容按 `source+id` 不可变） | `dja-api-v1` | 200 条，LRU | 离线重播当前曲目仍有歌词 |
| `POST /api/chat`、`PUT /api/taste` | **不缓存、不拦截**（直接透传） | — | — | 写操作绝不能重放 |
| `/api/next` | network-first，**不落 cache** | — | — | 直链有时效，缓存只会拿到过期 URL |
| `/tts/*.mp3` | **cache-first**，无网络直接命中 | `dja-tts-v1` | **60 条 / 80MB**，LRU 淘汰 | 自产内容、可缓存；**必须**带上限 |
| 音乐 CDN 直链（跨域） | **不缓存、不拦截** | — | — | 临时 URL + 版权边界（`C-08`） |
| `/stream`（WS） | **不缓存**（WS 不走 SW 的 fetch，显式排除以防误加 `respondWith`） | — | — | — |
| 其它导航请求 | network → 失败回落 `/offline.html` | `dja-shell-v1` | — | 离线回退页 |

```js
const SW_VERSION = 'v1';
const SHELL = ['/', '/index.html', '/styles.css', '/app.js', '/player.js', '/ws.js',
               '/manifest.webmanifest', '/offline.html', '/icons/192.png', '/icons/512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(`dja-shell-${SW_VERSION}`).then((c) => c.addAll(SHELL)));
  // 不在这里 skipWaiting —— 见 §6.3
});

self.addEventListener('fetch', (e) => {
  const { request: r } = e, u = new URL(r.url);
  if (u.origin !== location.origin) return;                    // 跨域直链：完全不干预
  if (u.pathname.startsWith('/stream')) return;                // C-08
  if (r.method !== 'GET') return;                              // POST /api/chat、PUT /api/taste 透传
  if (u.pathname.startsWith('/tts/')) return e.respondWith(ttsCacheFirst(r));
  if (u.pathname.startsWith('/api/lyric')) return e.respondWith(lyricCacheFirst(r));
  if (u.pathname.startsWith('/api/')) return e.respondWith(apiNetworkFirst(r));
  if (SHELL.includes(u.pathname)) return e.respondWith(shellSWR(r, e));
  if (r.mode === 'navigate') return e.respondWith(navFallback(r, e));
});
```

### 6.2 `/tts/*.mp3` 的容量上限与 LRU

```js
const TTS_MAX_ENTRIES = 60, TTS_MAX_BYTES = 80 * 1024 * 1024;
async function ttsCacheFirst(req) {
  const cache = await caches.open(`dja-tts-${SW_VERSION}`);
  const hit = await cache.match(req);
  if (hit) { touch(req.url); return hit; }                     // 记 lastAccess（内存 Map + 持久化到 IDB）
  const res = await fetch(req);
  if (res.ok && (res.headers.get('content-type') ?? '').includes('audio')) {
    await cache.put(req, res.clone());
    evictIfNeeded(cache);                                      // 超条数或超字节 → lastAccess 最旧先删
  }
  return res;
}
```

`/tts/<hash>.mp3` 的 hash 含 `voice|rate|pitch`（`D-07`），改音色会产生一批永不命中的新条目 —— LRU 上限就是为它准备的，无需手动清理。**注意 `say` 与 `segue` 共用同一命名空间**（都是 `/tts/<hash>.mp3`），因此上限按「60 条」统一计算即可。

### 6.3 版本与更新流程（`skipWaiting` 的取舍）

| 方案 | 优点 | 代价 | 结论 |
|---|---|---|---|
| `install` 里直接 `skipWaiting()` | 更新最及时 | 新 SW 立刻接管 → 旧缓存名被清，**正在播的 `/tts/*.mp3` 可能被换掉**，播报中断 | ❌ 不用 |
| 等用户确认（本方案） | 播放不中断 | 更新推迟到用户点一下 | ✅ |

```js
// 页面侧
reg.addEventListener('updatefound', () => {
  const nw = reg.installing;
  nw?.addEventListener('statechange', () => {
    if (nw.state === 'installed' && navigator.serviceWorker.controller) showUpdateBar();
  });
});
function applyUpdate() {
  if (state === 'PLAYING' || state === 'SPEAKING') return deferUntilIdle();   // 播放中不换 SW
  navigator.serviceWorker.addEventListener('controllerchange', () => location.reload(), { once: true });
  reg.waiting?.postMessage({ type: 'SKIP_WAITING' });
}
// sw.js 侧
self.addEventListener('message', (e) => { if (e.data?.type === 'SKIP_WAITING') self.skipWaiting(); });
self.addEventListener('activate', (e) => e.waitUntil(
  caches.keys()
    .then((ks) => Promise.all(ks.filter((k) => !k.endsWith(SW_VERSION)).map((k) => caches.delete(k))))
    .then(() => self.clients.claim())));
```

**播放中不激活**是硬规则：`SPEAKING`/`PLAYING` 期间点「立即更新」只记录意图，等回 `IDLE` 再执行（`deferUntilIdle` 挂到状态机回调上）。

### 6.4 离线回退页

`offline.html` 是**最小壳层**（不加载 `app.js`），内容：① 「电台服务未连上」；② 从 `dja-api-v1` 读最近一次 `/api/now`，展示曲名与主播文案；③ 若 `dja-tts-v1` 有缓存音频，给一个「听上次的播报」按钮（`<audio>` 指向缓存 URL 的 `caches.match()` 结果）。这样离线时**仍有东西可听**（`F-10`）。

## 7. `prefetch 10s`

施工图 PWA 层的 `prefetch 10s`。前端侧的触发点是 §4.2 的 `timeupdate` 判定；**唯一的网络触发是 WS `{type:'prefetch', nextIndex}`**（服务端据此预解析下一首直链 + 预合成 `segue`，见 [04 §7.1](04-tts-pipeline.md#7-segue-与-say-的流水线时序)）。前端同时做本地预热：

```js
async function prefetchWarm() {
  const nextTrack = playlist.find((i) => i.kind === 'track');        // 队首未播的音乐项
  const jobs = [];

  // ① 热身下一首音频直链的头部：喂热 HTTP 连接池 + CDN 边缘缓存
  if (nextTrack?.audioUrl) jobs.push(warmRange(nextTrack.audioUrl));

  // ② 预取歌词与封面（歌词来自 /api/lyric，命中 SW 的 cache-first）
  if (nextTrack?.lyricUrl) jobs.push(fetch(nextTrack.lyricUrl, { headers: authHeaders() })
    .then((r) => r.json())
    .then((j) => { nextTrack.lyric = parseLrc(j?.data?.lyric ?? j?.lyric ?? ''); })
    .catch(() => {}));
  if (nextTrack?.coverUrl) jobs.push(new Promise((res) => {
    const img = new Image(); img.onload = img.onerror = res; img.src = nextTrack.coverUrl;
  }));

  await Promise.allSettled(jobs);
  metrics.observe('prefetch_lead_ms', Math.round((audio.duration - audio.currentTime) * 1000));
}

function warmRange(u) {
  return fetch(u, { method: 'GET', headers: { Range: 'bytes=0-262143' },   // 只热身 256KiB（≈10s@192kbps）
                    mode: 'cors', credentials: 'omit', cache: 'no-store' })  // 不写 HTTP 缓存，避开 SW 策略
    .then((r) => r.arrayBuffer()).catch(() => {});
}
```

| 子任务 | 发起方 | 完成判据 | 未完成的兜底 |
|---|---|---|---|
| 下一首直链解析 | 服务端（`prefetch` 触发） | `queue-update` 里 `audioUrl` 非空 | `ended` 时该曲目仍无直链 → 跳过它，播再下一首 |
| 音频头部热身 | 前端（`Range`） | `ended → playing` < 200ms | 直连 CDN，gap 仍受 `F-04` 的 800ms 约束 |
| 歌词/封面 | 前端 | 切歌瞬间 `nextTrack.lyric.length > 0` | 切完后异步补上，歌词区先显示「加载中」占位 |
| `segue` 合成 | 服务端（`prefetch` → `segue-ready`） | `segue-ready` 在 `ended` 前到达（实测 3.07s ≪ 10s） | **直接切下一首**，绝不 `await`（[04 §7.3](04-tts-pipeline.md) 规则 1） |

**为什么用 `Range` 而不是整首下载**：热身只需建连 + 填充边缘缓存；整首下载既费流量又踩版权边界（`C-08`）。`Range` 请求带 `cache: 'no-store'`，且跨域直链本来就被 SW 排除，不会污染 `dja-tts-v1`。

## 8. UI 细节

### 8.1 进度条与 seek

```js
let dragging = false;
seekEl.addEventListener('pointerdown', () => { dragging = true; });
seekEl.addEventListener('input', () => { timeEl.textContent = fmt(+seekEl.value); });  // 拖动中只改文字
seekEl.addEventListener('change', async () => {
  dragging = false;
  const positionMs = Math.round(+seekEl.value * 1000);
  try { audio.currentTime = positionMs / 1000; }
  catch { await reResolve(current); }
  ws.send({ type: 'seek', positionMs });          // 服务端记入 plays.played_ms 起点；>90% 时预取下一首
});
```

**抖动防护**：拖动期间**冻结** `tick()` 对 `value` 的写回（否则 250ms 一次的回写会把滑块拽回去）。`max` 在 `loadedmetadata` 前为 0，此时禁用滑块（`seekEl.disabled = !Number.isFinite(audio.duration)`）。键盘：`←`/`→` 各 ±5s，`Shift+←/→` 各 ±30s。

### 8.2 音量

`audio.volume` 持久化到 `localStorage['dj.volume']`（默认 1.0），变化即写。**iOS Safari 的 `audio.volume` 是只读的**（恒为 1），赋值静默失败 → 启动时探测：

```js
function volumeSupported() {
  audio.volume = 0.5; const ok = audio.volume !== 1;
  audio.volume = +(localStorage.getItem('dj.volume') ?? 1); return ok;
}
// 不支持 → 隐藏音量滑块，改一行提示「请用手机音量键」
```

### 8.3 跳过 / 顶 / 踩

| 按钮 | 本地动作（立即） | 上行 | 服务端效果（`F-08`） |
|---|---|---|---|
| `⏭` 跳过 | `audio.pause()` + 队列推进 + 播下一项 | `skip{playedMs}` | 记 `plays.skipped=1` 与 `played_ms`，推进队列，推 `now-playing` + `queue-update`；跳过 <30% 时长 → 该曲目加入**短期排除**；**连续跳 3 首** → `prefs['mood.misfire']=true`，下次触发时大脑换档并在 `say` 里承认 |
| `♡` 顶 | 图标实心 + 微动画 | `feedback{trackId, value:1}` | 写 `plays.feedback=1`，权重上升；**不**立刻换歌 |
| `✕` 踩 | 图标变红 + **2s 后自动跳过**（再点一次取消） | `feedback{trackId, value:-1}` | 写 `plays.feedback=-1`，该曲目加入 **24h 短期排除** |

**乐观更新 + 回滚**：本地先变图标态；WS 未连时进内存队列，重连后按 `at` 时间戳排序补发。`feedback` 的 `value:0` 表示撤销反馈（再点一次已激活的 `♡`/`✕`）。

### 8.4 歌词（LRC 解析算法）

歌词来源是 `queue[i].lyricUrl`（`/api/lyric?source=…&id=…`），**不是** `/api/next` 的内联字段。

> ⚠️ **实测：部分曲目只返回纯文本歌词，没有 LRC 时间戳**（`npm run music:check` 会打印 `[NOTE]`）。
> 实测示例：netease 源某曲返回 969 字符但无 `[mm:ss.xx]` 标记，而 joox 源同曲返回 1413 字符含时间戳。
> 因此 LRC 解析必须**容错两种形态**：
> - 有 `[mm:ss.xx]` → 正常逐行滚动、当前行高亮
> - 无时间戳 → **降级为静态歌词**（整块展示、不滚动、不高亮），不得报错、不得显示空面板
>
> 判定方式：解析后若 `lines.filter(l => l.timeMs != null).length === 0`，则走静态展示分支。

```js
export function parseLrc(text) {
  const out = [], TAG = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;   // [mm:ss] [mm:ss.xx] [mm:ss.xxx] [mm:ss:xx]
  let offset = 0;
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const om = raw.match(/^\[offset:\s*([+-]?\d+)\s*\]/i);               // 全局偏移（毫秒）
    if (om) { offset = +om[1]; continue; }
    const tags = [...raw.matchAll(TAG)];
    if (!tags.length) continue;                                          // [ti:] [ar:] 等元数据行与空行跳过
    const content = raw.replace(TAG, '').trim();
    if (!content) continue;
    for (const t of tags) {
      const ms = (+t[1]) * 60000 + (+t[2]) * 1000 + (t[3] ? +t[3].padEnd(3, '0') : 0) + offset;
      out.push({ t: ms, text: content });
    }
  }
  return out.sort((a, b) => a.t - b.t);                                  // 一行多时间戳展开成多条
}
/** 当前行：二分找最后一个 t <= nowMs；返回索引，供高亮与滚动 */
export function lyricIndex(lines, nowMs) {
  let lo = 0, hi = lines.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].t <= nowMs) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}
```

| 情况 | 表现 |
|---|---|
| 有歌词 | 当前行加粗高亮，`scrollIntoView({ block:'center', behavior:'smooth' })`；前后各留 2 行淡出 |
| 双语（同 `t` 两条） | 主行 + 副行两行渲染，共用一个高亮状态 |
| 纯音乐 / 全空 | 显示封面 + 一行「纯音乐，请欣赏」 |
| 拉取失败 / 无歌词 | 隐藏歌词区，封面区域自动补高（不留空白）；**不显示错误** |
| `seek` 跳跃 | 高亮行直接跳转（`behavior:'auto'`），不逐行滚动 |

### 8.5 `reason` 展示位

`reason` **不进 TTS**（[01 §6.1](01-architecture-design.md#61-djaction大脑返回v1)，[03 §5](03-api-contract.md#5-broadcast-对象)），专供界面回答「DJ 为什么放这首」。展示为曲目信息下方一张折叠卡片，标题固定文案 **「为什么放这首」**；点击展开全文（整段理由），默认桌面展开、手机折叠。

**两层理由**：顶层 `reason` 是整段理由（本次为什么这么排）；`queue[].reason` 是**单曲级**理由，展示在队列列表每一项右侧，鼠标悬停/长按显示。`degraded===true` 时卡片追加一行灰色小字，列出 `degradedReasons`（如「大脑降级：`brain_template` · 语音降级：`tts_sapi` · 播报截断：`say_truncated`」），让用户知道这次不是真 DJ 决策。

### 8.6 封面与占位图

```html
<img id="np-cover" src="/icons/placeholder.svg" alt="" decoding="async" fetchpriority="high">
```

```js
coverEl.onerror = () => { coverEl.src = '/icons/placeholder.svg'; };   // 音乐 API 封面常挂，必须兜底
```

占位图优先用**曲名首字**生成 SVG（取 `queue[0].title` 的第一个字符，深色渐变底 + 居中大字），比通用图标更有辨识度；生成失败才退到静态 `placeholder.svg`。封面在 §7 的预热里用 `new Image().src` 提前加载；`queue[].fuzzy===true`（匹配分 < 0.72）时在曲名旁加一个「≈」小标记，提示这是模糊匹配到的曲目。

### 8.7 移动端安全区与横屏

```css
:root { --sa-b: env(safe-area-inset-bottom, 0px); }
body { min-height: 100dvh; }                    /* 不用 100vh：移动浏览器地址栏会吃掉 60~100px */
.view-player { padding-bottom: max(12px, var(--sa-b)); }

@media (orientation: landscape) and (max-height: 560px) {
  .view-player { display: grid; grid-template-columns: 40% 1fr; }   /* 左封面 / 右控制 */
  #np-title, #np-sub { font-size: 1rem; }                           /* 缩小标题，让播放键留在首屏 */
  .lyric { max-height: 22dvh; }
}
```

`<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">`（`viewport-fit=cover` 是 `env(safe-area-inset-*)` 生效的前提）。触摸目标 ≥ 44×44 px；主播放键 64×64 px，位于**拇指可达的右下 1/3 区域**。桌面快捷键：空格 暂停/继续、`←/→` seek ±5s、`J/K/L` ±10s、`M` 静音。

## 9. 音频解锁（autoplay 政策）

浏览器要求 `<audio>` 的首次 `play()` 必须发生在**用户手势**内。电台的痛点是：真正的播放由 WS 推送触发，**那时没有手势**。

```js
const SILENT = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAgD4AAAB9AAACABAAZGF0YQAAAAA='; // 0 采样
let unlocked = false;
async function unlock() {
  if (unlocked) return true;
  try {
    audio.src = SILENT;
    await audio.play();                 // ← 必须在同一次手势内
    audio.pause(); audio.currentTime = 0;
    unlocked = true;
    await syncNow();                    // 拉 GET /api/now，补齐解锁期间错过的状态
    ws.send({ type: 'resume', positionMs: 0 });
    return true;
  } catch { showUnlockOverlay(); return false; }   // 手势被吞（如 iOS 低电量模式）→ 保留遮罩继续等
}
addEventListener('pointerdown', unlock, { once: true });
addEventListener('keydown', unlock, { once: true });   // 桌面：空格/回车也算手势
```

交互设计：首屏盖一层全屏遮罩，中央一个 64px 圆形播放键 + 文案「**点一下开始收听**」，副标题「Claudiao 会在你点了之后才开始说话」。解锁成功**立即**拉 `/api/now`：若返回了 `say.audioUrl` 且 `say.playedMs` 为空 → 从头播这次播报，让「点了就有声」在一秒内闭环；否则直接进当前 `state`。

三条硬规则：

1. **`<audio>` 元素永不替换**（`C-02`）—— Safari 的「已激活」判定绑定在元素上，换元素等于重新要手势；解锁时播的那个元素必须是之后一直用的那个。
2. **解锁即对齐**：解锁前不假设任何本地状态；`GET /api/now` 是唯一真相源（`state`、`stateRev`、`nowPlaying.positionMs`、`queue`、`segue`）。
3. **`visibilitychange` 复活**：回前台若 `paused && shouldBePlaying` → `play()`（此时通常已解锁，无需新手势）；仍失败则重新显示遮罩。

## 10. 文件结构

```text
web/
├─ index.html            三视图 DOM 骨架 + <audio> + manifest 链接
├─ styles.css            设计令牌、三视图布局、safe-area、横屏、频谱动画
├─ app.js                启动、hash 路由、认证 token、解锁、状态机胶水、Profile/Settings
├─ player.js             单 <audio> 控制器、队列、seek、LRC、prefetch、feedback
├─ ws.js                 WS 连接、心跳、退避重连、seq 去重/漏帧对齐、断线轮询
├─ sw.js                 Service Worker：缓存策略、版本、SKIP_WAITING
├─ manifest.webmanifest  PWA 元数据（name/shortcuts/display/theme_color）
├─ offline.html          离线回退页
└─ icons/                192.png · 512.png · placeholder.svg
```

| 文件 | 预算行数 | 职责 | 不做 |
|---|---|---|---|
| `index.html` | ~120 | 三视图骨架、`<audio id="dj-audio">`、遮罩、更新条 | 不写内联脚本/样式 |
| `styles.css` | ~450 | `--dj-*` 令牌、8 状态视觉、safe-area、横屏栅格 | 无预处理器、无 CSS 框架 |
| `app.js` | ~300 | 路由、`localStorage` 令牌、`unlock()`、状态机、Profile/Settings | 不碰 `<audio>`（交给 `player.js`） |
| `player.js` | ~350 | 队列、`ended` 推进、`timeupdate`、seek、LRC、`prefetch`/`duration-report` | 不直接开 WS（用 `ws.send()`） |
| `ws.js` | ~200 | `connect/ping/reconnect/dispatch`、seq 去重、40s 死链判定、`startPolling` | 不做业务判断，只转发事件 |
| `sw.js` | ~180 | 三套缓存、LRU、导航回落、更新协商 | 不缓存跨域直链与写请求 |
| `manifest.webmanifest` | ~30 | `display:'standalone'`、`shortcuts`（直接开 Player） | — |
| `offline.html` | ~40 | 离线提示 + 读缓存展示 | 不加载 `app.js` |
| `icons/` | — | 192/512 maskable + 占位 SVG | — |

**模块边界（零框架下的纪律）**：`player.js` 与 `ws.js` 不互相 import，只通过 `app.js` 注入的回调通信（`ws.on('now-playing', player.applyBroadcast)`），避免循环依赖。所有模块用 IIFE + 显式 `window.DJ.*` 导出，不使用打包器（`C-01`）。

## 11. 性能目标

| 指标 | 目标 | 测量方式 |
|---|---|---|
| 首屏可交互（本地） | **< 1s** | `performance.getEntriesByType('navigation')[0]` 的 `domInteractive - startTime`；预算：HTML+CSS+JS 合计 < 60KB 未压缩、同源无阻塞请求 |
| 交互响应 | **< 100ms** | `pointerdown` → 下一帧绘制：`PerformanceObserver('event')` 取 `processingStart - startTime` |
| 首音频起播（点「开始收听」→ 出声） | < 300ms（`say` 缓存命中 <50ms，`N-02`） | `audio` 的 `play` → `playing` 事件差 |
| 切歌衔接 gap | **≤ 800ms**（`F-04`） | `ended` → `playing` 事件差，取 P95 |
| `segue` 预取完成率 | ≥ 95% | `segue-ready` 到达时间早于 `ended` 的比例（§7 埋点） |
| WS 状态推送延迟 | **≤ 500ms**（`F-06`） | 服务端 `broadcast` 时间戳 → 前端 `dispatch` 的 `Date.now()` 差 |
| 重连恢复时间 | ≤ 3s（退避 n≤2 时） | `onclose` → `onopen` + `syncNow` 完成 |
| 常驻内存 | < 120MB（PWA 标签页，连续播放 1 小时） | Chrome 任务管理器；队列 ≤ 50 项、LRC ≤ 2000 行、`seen` Set = 200 |
| 主线程长任务 | 无 > 50ms | `PerformanceObserver({ entryTypes: ['longtask'] })` |
| JS 体积 | ≤ 60KB 未压缩 / ≤ 20KB gzip | `sw.js` 预缓存清单的文件大小之和 |
| 离线可用 | 断网后壳层 100% 可开 | `navigator.onLine=false` + SW 命中缓存；离线页可播缓存音频 |

**预算分配**：`index.html` 8KB + `styles.css` 14KB + 三个 JS 30KB ≈ 52KB，留 8KB 余量。任何新增依赖（哪怕一个 LRC 库）都会击穿这个预算 —— 这就是零框架的代价与收益。

## 12. 测试要点

| # | 用例 | 步骤 | 断言 |
|---|---|---|---|
| U-01 | **autoplay 解锁** | 冷启动 → 断言遮罩存在且 `audio.src` 为空 → 点击遮罩 | 解锁前**不**调 `audio.play()`；解锁后 300ms 内 `playing` 触发；`GET /api/now` 被调用一次；`<audio>` 元素引用前后**同一个**（`===` 断言，检验 §9 规则 1） |
| U-02 | **先 say 后音乐** | 推 `now-playing`（`say.audioUrl` + `queue[0..1]`） | `src` 序列为 `say.audioUrl → queue[0].audioUrl → queue[1].audioUrl`；任意时刻只有一个 `<audio>` 非 `paused`；`SPEAKING` 与 `PLAYING` 不重叠 |
| U-03 | **队列推进与 `queue-update`** | 依次触发 `ended`；中途推 `queue-update{added:[C], removed:[B]}` | 顺序消费；B 被剔出待播；C 出现在队尾；队列空 → `IDLE`；`playlist.length===0` |
| U-04 | **`segue` 时机** | mock `duration=200s`，`currentTime` 推到 190.1s 触发 `timeupdate`；随后推 `segue-ready` | 恰好发一次 `prefetch{nextIndex}`（`segueArmed` 守卫幂等）；190.0s 前不发；`segue-ready` 后 `ended` → 先播 `segueUrl` 再播下一首；**未 ready 时直接切下一首且不 `await`** |
| U-05 | **断线重连** | `ws.close()` → 等 2 个退避周期 → 恢复 | 重连间隔近似 `500ms → 1s`（±20% 抖动）；期间每 5s 轮询 `GET /api/now`；**本地队列不中断**（`paused` 始终 false）；`onopen` 后 `n=0`、`stopPolling`、带 `since=lastSeq` 重连 |
| U-06 | **seq 去重 / 漏帧 / epoch** | 依次投递 `seq=5, 7, 6, 5`；再投递新 `epoch` 的 `hello` + `seq=1` | 应用顺序 `5, 6`；重复 `5` 丢弃；`7` 触发一次 `GET /api/now` 对齐而非缓冲；新 `epoch` 后 `lastSeq` 归零、`seen` 清空、`seq=1` 被正常应用 |
| U-07 | **seek** | `loadedmetadata` 后把滑块设为 `duration/2` 并派发 `change` | `audio.currentTime ≈ duration/2`（±0.5s）；发出一次 `seek{positionMs}`；拖动期间 `tick()` 不回写 `value`；长按拖动 1s 后 `value` 不被拽回 |
| U-08 | **`duration-report`** | 播 `say` 项并触发 `loadedmetadata`（`duration=4.86`） | 发出一次 `duration-report{hash, durationMs:4860}`；`hash` 与 `say.audioUrl` 的文件名一致；`track` 项**不**发此事件 |
| U-09 | **SW 更新协商** | 改 `SW_VERSION` 重新部署 → 重载 | 出现「有新版本」底条；`state==='PLAYING'` 时点「立即更新」**不**刷新；回 `IDLE` 后再点才 `controllerchange` + reload；旧缓存名被删 |
| U-10 | **离线** | DevTools 断网 → 重载 | 壳层可开（全部命中 `dja-shell`）；`GET /api/now` 回落缓存并渲染上次曲目；`/api/lyric` 命中缓存 → 歌词仍滚动；`/tts/*.mp3` 命中并可播；音乐直链失败 → 不弹窗，仅内联提示 |
| U-11 | **TTS 缓存上限** | 连续请求 70 个不同 hash 的 `/tts/*.mp3` | `dja-tts` 条目 ≤ 60、总字节 ≤ 80MB；被淘汰的是 `lastAccess` 最旧的；新请求仍能正常合成下载 |
| U-12 | **封面/直链失败兜底** | 让 `coverUrl` 404、`audioUrl` 403 | 封面落占位 SVG 且显示曲名首字；音乐 `error` → 调一次 `GET /api/now?verbose=1` 重解析，仍失败 → 换下一首，最多 2 次后进 `FALLBACK_AUDIO`；**全程无报错弹窗** |
| U-13 | **LRC 解析与高亮** | `[00:12.34]`、`[01:05]`、`[offset:-500]`、一行多时间戳、双语同 `t`、纯空行 | 时间换算正确（`12.34s→12340ms`、`1:05→65000ms`、offset 生效）；结果按 `t` 升序；`lyricIndex` 在 `nowMs` 小于首行 → `-1`、大于末行 → `last`；seek 后高亮直接跳转 |
| U-14 | **降级可视化** | 推 `now-playing{degraded:true, degradedReasons:['brain_template','tts_sapi']}` | 橙色角标出现；`reason` 卡片追加灰字列出两个层级；**队列与播放不受影响**；曲目结束仍能回 `IDLE` |

端到端冒烟（配合后端）：启动服务 → 打开 `http://localhost:8080` → 点遮罩 → 输入「来点适合下雨天的歌」→ 断言 10s 内出声（`F-01`）且**先有播报再有音乐** → 点 `⏭` → 断言 `plays` 表新增一条 `skipped=1`（`F-08`）→ 点两次 `✕` 中的第一次 → 断言该曲目 24h 内不再被推荐。

## 13. 未决问题

| # | 问题 | 影响 | 计划 |
|---|---|---|---|
| U-01 | ~~[03](03-api-contract.md) 未定义 Settings 的写端点~~ | — | **已解决**：[03 §7.5](03-api-contract.md) 已补齐 `GET\|PUT /api/prefs`（白名单键 + `baseRev` 乐观并发 + 生效时机表）。前端按 §3 的 U-01 段实现，保留 `settings.writable` 降级开关 |
| U-02 | `/api/lyric` 未在 6 条 HTTP 线中显式列出，但 `queue[].lyricUrl` 指向它 | 低 | **已定稿**：归为「只读代理，非第 7 条业务线」，与 `/api/health` 同类（[03 §7.4/§7.5](03-api-contract.md) 的运维端点族）。SW 单独给它 cache-first，200 条 LRU |
| U-03 | 手机访问需 `HOST=0.0.0.0` + 令牌，首次配置有门槛 | 低 | 首屏若检测到非 `127.0.0.1` 且 401 → 直接跳出一个「粘贴访问令牌」输入框，写 `localStorage` 后自动重连，不显示裸错误码 |

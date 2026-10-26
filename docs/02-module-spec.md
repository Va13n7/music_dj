# Claudiao 个人音乐电台 · 模块详细设计

> 文档版本 v1.0 · 状态：设计完成，待实现
> 上游依据：[设计总览](01-architecture-design.md) §2 第二层 / §3.2 / §3.3 / §4 / §5 / §8
> 关联文档：[接口契约](03-api-contract.md) · [TTS 声音管线](04-tts-pipeline.md) · [大脑适配器](05-brain-adapter.md) · [音乐提供方](06-music-provider.md) · [调度与节律](07-scheduler-rhythm.md) · [前端 PWA](08-pwa-frontend.md)
> 施工图对应格子：第二层 `ROUTER.JS` `CONTEXT.JS` `CLAUDE.JS` `SCHEDULER.JS` `TTS.JS` `STATE.DB`
> 语料来源：`knowledge/prompts/dj-persona.md` · `knowledge/user/{taste,routines,mood-rules}.md` · `knowledge/user/playlists.json`

---

## 0. 一致性备注（对总览的读校，不改动总览）

| # | 总览位置 | 现象 | 本文档采用 |
|---|---|---|---|
| C-1 | §4.3 vs §7 D-01 / §10 Q-04 | 同一测量两种口径：`t≈5.4s exit code 0` 与「冷启动仅 5.4s」，而正文写「单轮 5.5s」 | 统一取 **5.5s = 单轮端到端基线**，5.4s 记为进程退出时刻，两者不冲突 |
| C-2 | §10 Q-01 | 失败源只列 `kuwo/tencent/migu` | 实测 `kugou` 亦 400/503，§8.1 降级链一并列入 |
| C-3 | §2 第二层表格 | 沿用施工图拼写 `CLAUDE.JS`；第三层写作 `CONTEXT BINDOW` | 落地文件名以 **`src/layer2/brain.js`** 为准；`CONTEXT BINDOW` 为施工图原文拼写，正文用「第三层 · 运行时粘合」 |
| C-4 | §6.2 | DDL 指向 `03-api-contract.md#sqlite-ddl` | 本文档不重复 DDL，见 [03 SQLite DDL](03-api-contract.md#sqlite-ddl) |
| C-5 | §2 第二层表格 | 未定义 slot 名 | 以 `routines.md` §二 与 `playlists.json.slotDefaults` 的 id 为唯一权威（§6.1） |

---

## 1. 总则

### 1.1 模块清单

| 文件 | 职责（一句话） | 上游 | 下游 |
|---|---|---|---|
| `src/layer2/router.js` | 把用户文本 / 触发事件分类成 `Intent`，决定走直连、音乐车道还是大脑 | `src/server.js`、`scheduler.js`、WS 客户端事件 | `context.js`、`state.js`（直连短路） |
| `src/layer2/context.js` | 把六片碎片按预算拼成一次性 stdin prompt | `router.js`、`state.js`、`providers/weather`、`providers/calendar` | `brain.js` |
| `src/layer2/brain.js` | 调大脑适配器，把 NDJSON 事件流收敛成合法 `DjAction` | `context.js` | `adapters/brain/dsh-headless.js`、`fallback-templates.js` |
| `src/layer2/tts.js` | `say` 文本 → 音频缓存文件与 `/tts/<hash>.<ext>` URL | `compute()` 编排、WS `prefetch` | `adapters/tts/*`、`data/tts-cache/` |
| `src/layer2/scheduler.js` | cron 与休眠补跑 → 幂等触发事件 | 系统时钟、`providers/calendar` | `router.js`、`state.js` |
| `src/layer2/state.js` | SQLite 四表读写、`plan` 加锁、指标聚合 | 全体模块 | `data/radio.db` |
| `src/providers/music/*` | 检索 / 直链 / 歌词 / 封面 / 歌单，多源降级 + 本地兜底 | `brain.js` 的 `play[]`、第 ⑤ 片候选 | `music-api.gdstudio.xyz`、`data/fallback-audio/` |
| `src/providers/weather/*` | 第 ③ 片的天气行 | `context.js` | 天气 API（可降级） |
| `src/providers/calendar/*` | 第 ③ 片日历行 + `calendar_hook` 事件源 | `context.js`、`scheduler.js` | `config/calendar.{yml,ics}` |
| `src/errors.js` | `RadioError` 与错误码常量（**叶子模块，零依赖**） | 全体 | — |
| `src/fallback-templates.js` | 按时段/情绪的兜底播报模板与档位歌单选择 | `brain.js`、`scheduler.js` | `playlists.json` |

### 1.2 编码约定

| 项 | 约定 |
|---|---|
| 模块制式 | **ESM**（`"type": "module"`），只用 `import`/`export`，`.js` 后缀写全 |
| 语言 | **纯 JavaScript**，无 TypeScript、无编译步骤；类型用 **JSDoc** 表达。`jsconfig.json` 开 `checkJs`，`tsc --noEmit` 仅作 CI 静态检查，不进构建 |
| 命名 | 文件 `kebab-case`；函数/变量 `camelCase`；JSDoc 类型 `PascalCase`；模块常量 `UPPER_SNAKE` |
| 数据形态 | 跨模块只传**可 JSON 序列化的普通对象**；禁止类实例、函数、`Map`/`Set`、`Date` 对象 |
| 时间 | 内部统一 epoch 毫秒（`at_ms`）+ 本地日期串（`YYYY-MM-DD`，`Asia/Shanghai`）；**仅 API 边界**转 ISO 8601 带时区 |
| 依赖方向 | `layer2` **禁止** `child_process` / `fetch` / `node:http`；只允许 `node:fs` 只读访问 `knowledge/` 与 `config/defaults/`。进程与网络必须经 `adapters/`、`providers/`（总览 §3.3 强制） |
| 日志 | 注入式 `logger`（`{debug,info,warn,error}`），结构化单行 JSON；默认**不落 prompt/say 全文**，只落长度与 `sha1[:8]`，`LOG_PROMPT=1` 才落全文（总览 §9） |
| 规模 | 单文件 ≤ 400 行；单函数 ≤ 60 行；导出函数 100% 带 JSDoc 且必须有 `@returns` |
| 测试 | 与源码同目录 `*.test.js`，`node --test`；纯函数优先，IO 用依赖注入替身 |
| 命令 | `npm run dev` / `npm start` / `npm test`（本机 npm 10.9.0，**无 pnpm**） |

**共享 typedef（`src/types.js`，全项目唯一定义）**

```js
/** @typedef {'play_request'|'mood_request'|'control'|'query'|'taste_edit'|'scheduled_broadcast'|'skill_trigger'|'freeform'} IntentName
 *  @typedef {'direct'|'music'|'brain'} Lane
 *  @typedef {'user_chat'|'schedule'|'webhook'|'prefetch'} TriggerSource
 *  @typedef {{id:string,name:IntentName,lane:Lane,needBrain:boolean,source:TriggerSource,priority:'user_chat'|'schedule'|'prefetch',text:string,rawText:string,slots:{query?:string,artist?:string,title?:string,mood?:string,control?:string,arg?:string,slot?:string,skill?:string,date?:string,moodCandidates?:string[]},confidence:number,at:string,sessionId?:string,reason?:string}} Intent
 *  @typedef {{system:string,user:string,prompt:string,corpusHash:string,fragments:Object,stats:{bytes:number,estTokens:number,truncated:string[]}}} PromptFragments
 *  @typedef {{say:string,play:string[],reason:string,segue?:string}} DjAction
 *  @typedef {{id:string,source:string,title:string,artist:string,album?:string,audioUrl:string,coverUrl?:string,lyricUrl?:string,durationMs?:number,score:number,fuzzy:boolean}} Track
 *  @typedef {{sessionId:string,turn:number,usage:Object,elapsedMs:number,events:number,source:'final'|'text-projection'|'template',retries:number,parsePath:string,degraded:boolean}} BrainMeta */
```

### 1.3 错误分类约定

业务层**禁止**抛裸 `Error`，一律抛 `RadioError`（`src/errors.js`）：

```js
export class RadioError extends Error {
  /** @param {string} code 错误码表中的键
   *  @param {string} message 面向人类的中文短句（可进 API 响应体）
   *  @param {{detail?:Object,retryable?:boolean,level?:'info'|'warn'|'error',cause?:Error}} [o] */
  constructor(code, message, o = {}) { super(message); /* … */ }
}
```

三类错误：**可重试**（网络/超时/子进程非零退出）、**可降级**（有下一级兜底，见总览 §5.2 降级链）、**终态**（参数错、鉴权失败、路径越界，禁止重试）。`compute()` 每捕获一个 `RadioError` 必须回答两问：本环有没有下一级？`degraded` 要不要置位？

### 1.4 错误码表

| code | 触发点 | HTTP | retryable | 降级动作 |
|---|---|---|---|---|
| `E_BAD_REQUEST` | 参数校验失败 | 400 | ❌ | — |
| `E_AUTH` | 令牌缺失/错误 | 401 | ❌ | — |
| `E_NOT_FOUND` | 资源不存在 | 404 | ❌ | — |
| `E_PATH_REJECTED` | 路径白名单拒绝 | 400 | ❌ | — |
| `E_ROUTE_FALLBACK` | 规则全未命中，落 `freeform` | — | ❌ | 走大脑（正常路径，仅记 debug） |
| `E_CONTEXT_CORPUS_MISSING` | 语料缺失/不可读 | — | ❌ | 用 `config/defaults/` 同名文件 + `degraded` |
| `E_BRAIN_TIMEOUT` | 大脑 30s 未结束 | 504 | ✅ | 重试 1 次 → 模板播报 |
| `E_BRAIN_EXIT` | `dsh` 退出码 ≠ 0 | 502 | ✅ | 同上 |
| `E_BRAIN_NO_FINAL` | 无 `final` 事件 | 502 | ✅ | 先试 `text` 投影（未 truncated）→ 再模板 |
| `E_BRAIN_PARSE` | `DjAction` 提取/校验失败 | 502 | ✅ | 带纠偏提示重试 1 次 → 模板 |
| `E_MUSIC_SOURCE_DOWN` | 单源 400/503 | — | ✅ | 切下一源 |
| `E_MUSIC_RESOLVE` | 全源直链失败 | 502 | ✅ | 本地兜底曲库 `data/fallback-audio/` |
| `E_TTS_EDGE_FAIL` | edge-tts 非零退出/超时/空文件 | — | ✅ | 降级 SAPI |
| `E_TTS_SAPI_FAIL` | SAPI 亦失败 | 503 | ❌ | 跳过语音 → `MUSIC_ONLY` |
| `E_TTS_TEXT_TOO_LONG` | `say` > 200 字 | — | ❌ | 截断到句末并 warn |
| `E_STATE_DB` | SQLite 读写失败 | 500 | ✅ | 内存影子表 + error 告警 |
| `E_PLAN_CONFLICT` | `(date,slot)` 已 succeeded | 409 | ❌ | 本次记 `skipped` |
| `E_BUSY` | 单飞闩满且排队超 20s | 429 | ✅ | 低优先级触发丢弃；`user_chat` 改用占位播报 |
| `E_INTERNAL` | 未归类异常 | 500 | ✅ | 记 error + 返回降级 Broadcast |

### 1.5 环境基线（实测）

Windows x64 · Node **v22.11.0** · npm **10.9.0**（**无 pnpm**）· Python **3.12.6** · `edge-tts.exe` = `D:\python\Scripts\edge-tts.exe` · `dsh` profile `dj-brain` · `DSH_HOME=C:\Users\wumingtao\.dsh`。

---

## 2. `src/layer2/router.js`

### 2.1 职责边界与导出

**做**：文本归一化 → 规则分类 → 槽位抽取 → 产出 `Intent`；把 `scheduler` / webhook 的结构化事件映射成 `Intent`；对 `control` / `query` 给出直连短路信号。
**不做**：不做语义理解（大脑的事）、不检索音乐、不组装 prompt、不写库、不做任何 IO。

```js
/** @param {{text?:string,source:TriggerSource,slot?:string,skill?:string,priority?:string,sessionId?:string}} input
 *  @returns {Intent} */
export function classify(input) {}
/** @returns {{control:string,arg?:string}|null}  控制指令（直连车道） */
export function matchControl(text) {}
/** @returns {{query:string,target?:string}|null}  状态查询（直连车道） */
export function matchQuery(text) {}
/** @returns {string|null}  mood-rules.md §一 的档位 ID */
export function matchMood(text) {}
/** @returns {{query:string,artist?:string,title?:string,confident:boolean}} */
export function parsePlayRequest(text) {}
/** 全角→半角、折叠空白、去尾部标点、大小写归一 @returns {string} */
export function normalize(text) {}
/** 按**首个** " - " 切分 "艺人 - 曲名" @returns {{artist:string|null,title:string,spec:string}} */
export function splitSpec(spec) {}
```

### 2.2 意图分类表（完整）

| 意图 | 判定规则 / 关键词 | `lane` | `need_brain` | 示例输入 |
|---|---|---|---|---|
| `control` | 归一化后长度 ≤ **12** 且命中 §2.3 控制词表，**且无宾语** | direct | ❌ | 「暂停」「下一首」「大点声」「别说话了」 |
| `query` | 长度 ≤ **20** 且命中 §2.3 查询句式 | direct | ❌ | 「现在在放什么」「今天有什么安排」「这首是谁的」 |
| `taste_edit` | 命中改写动词：`以后别放` `别再放` `记住` `记一下` `我不喜欢` `我爱听` `加进` `从歌单里去掉` `删掉` | brain | ✅ | 「以后别放周杰伦了」「记住我喜欢后摇」 |
| `play_request`（精确） | 命中点播动词 **且** 命中标题标记 **且** 不含情绪/场景词（§2.4） | music | ❌ | 「放《晴天》」「来一首李志的梵高先生」「播朴树 - 生如夏花」 |
| `play_request`（模糊） | 命中点播动词但**未**命中标题标记，或带多义修饰 | brain | ✅ | 「来点周杰伦早期的」「放那首前奏很好听的」 |
| `mood_request` | 命中 `mood-rules.md` §一「触发信号」列任一档位（14 档，**表驱动解析，不硬编码**） | brain | ✅ | 「下雨了，来点安静的」「好累」「来点带劲的」 |
| `scheduled_broadcast` | `source==='schedule'`，由 `slot` 映射（§6.1） | brain | ✅（`night_wind_down` 为 ❌） | `{source:'schedule',slot:'morning'}` |
| `skill_trigger` | `source==='webhook'` 或 `skill ∈ {calendar,weather,webhook}` | brain | ✅ | 日历事件「10:00 述职会」前 30min |
| `freeform` | 以上全未命中（兜底） | brain | ✅ | 「你觉得我今天怎么样」「嗯」 |

### 2.3 直连词表（`control` + `query`，命中即返回，不进 `context.build`）

| 归一化文本（任一） | 判定 | 直连动作 / 数据源 |
|---|---|---|
| 暂停 / 停 / 停一下 / 别放了 | `control.pause` | WS `state-change{state:'IDLE'}`，前端 `pause()` |
| 继续 / 接着放 / 恢复 | `control.resume` | 恢复播放 |
| 下一首 / 下一曲 / 换一首 / 跳过 / 切歌 / 这首不好听 | `control.next` | 记 `plays.skipped=1` → 推进队列 |
| 上一首 / 回到上一首 / 刚才那首 | `control.prev` | 队列回退（不重复记 `plays`） |
| 大点声 / 小声点 / 静音 / 取消静音 | `control.volume(up\|down\|mute\|unmute)` | 前端 `volume ±0.1`（钳制 0.1~1.0）；mute 含音乐 |
| 别说话了 / 只放歌 / 可以说话了 | `control.mute_say(true\|false)` | 置/清 `prefs['say.muted']`，置位后跳过 TTS |
| 在放什么 / 放的是哪首 / 这首是谁的 / 谁唱的 | `query.now` | 内存播放态 + `plays` 最新行 |
| 今天放什么 / 今天什么安排 / 今日规划 | `query.plan` | `plan` 表当日全 slot |
| 刚才那首 / 上一首是什么 / 前一首 | `query.history` | `plays` 最近 2 行 |
| 放过…吗 / 听过…吗 / 什么时候放过 | `query.played` | `plays` 按 `title`/`artist` LIKE |
| 为什么放这首 / 你怎么选的 / 还有几首 | `query.why` / `query.queue` | `plays.reason` 最新行 / 内存队列 |

**歧义裁决**：命中控制词后若残余文本（去掉控制词并 trim）长度 > 2，视为**带宾语**，`matchControl` 返回 `null`，下落到 `play_request`（例：「换一首周杰伦的」）。`control`/`query` 的目标响应时间 **< 50ms**。

### 2.4 `play_request` 精确判定与门槛

三个条件同时满足才走音乐车道（`lane='music'`，不进大脑）：① **动词** `放|播|来一首|来点|听|点一首|给我放|换成`；② **标题标记**（任一）：`《…》` / `「…」` / `“…”` / `'…'` / 含 ` - ` / `X的Y` 结构（Y 非情绪词）/ 去动词与量词后残余 ≥ 2 字且不含情绪与场景词；③ **无情绪/场景词**：不含 `mood-rules.md` §一 任一触发词。

抽取顺序：`^(.+?)\s+-\s+(.+)$` → `(.+?)的(.+)` → 否则残余即 `slots.query`；`confident===true` 仅当能抽出 `title`。

**门槛与回退**：拿 `slots.query` 调 `music.search`，top1 匹配分 `≥ 0.72`（打分见 §8.2）→ 音乐车道直连，`say` 用 `fallback-templates.js` 的 `request_ack` 模板（例「好，这就给你放〈晴天〉。」）；`< 0.72` 或多候选 → 回落 `lane='brain'`，候选塞进第 ⑤ 片交大脑定夺。

### 2.5 情绪档位与判定顺序

`matchMood` 在模块初始化时**解析 `mood-rules.md` §一 的表格**（表头「档位 ID | 触发信号」），生成 `keyword → moodId` 索引；语料改了自动生效（§3.7）。14 个合法档位 ID（**不得改名**）：`calm` `rainy` `focus` `low` `anxious` `tired` `happy` `energize` `commute` `evening` `late_night` `nostalgic` `celebrate` `random`。多档命中取**最长关键词**（「睡不着」优先于「睡」），全部命中档写入 `slots.moodCandidates` 供大脑裁决。

```
classify(input)
 ├─ S0 来源分流：source==='schedule' → scheduled_broadcast（按 slot）
 │               source==='webhook'  → skill_trigger
 ├─ S1 normalize(text)（全角→半角、折叠空白、去尾部标点）
 ├─ S2 control   命中 → lane='direct', needBrain=false     ← 直连
 ├─ S3 query     命中 → lane='direct', needBrain=false     ← 直连
 ├─ S4 taste_edit    命中 → lane='brain'
 ├─ S5 play_request  精确 → lane='music'（按 0.72 门槛裁决）；模糊 → lane='brain'
 ├─ S6 mood_request  命中 → lane='brain'（记录 slots.mood）
 └─ S7 freeform      兜底 → lane='brain'
```

> **分界线 = 「这次触发需要『识别』还是需要『理解』」。** `control`/`query` 是**封闭指令集**（状态机已有动作、`state` 已有字段），规则可 100% 覆盖，故直连；任何需要选曲、措辞、能量权衡的触发（含明确点播的模糊情形）都必须走大脑。**首次命中即返回**；只有 S7 兜底才把原文整体交给大脑。

### 2.6 错误与降级、单元测试要点

| 情况 | 行为 |
|---|---|
| `text` 空或纯空白 | `source==='user_chat'` → `E_BAD_REQUEST`；否则转 S0 |
| 长度 > 500 字 | 截断到 500，`slots.truncated=true` 并告警，不报错 |
| 规则引擎内部抛异常 | 捕获 → 强制 `freeform` + `E_ROUTE_FALLBACK`（debug）。规则故障**不得**阻塞电台 |
| S5 检索失败 | 已在 S5 内捕获，直接回落 `lane='brain'`（大脑 `play` 可留空） |

| # | 用例 | 断言 |
|---|---|---|
| R-1 | `classify({text:'下一首'})` | `name==='control'`、`control==='next'`、`needBrain===false`、`lane==='direct'` |
| R-2 | `classify({text:'换一首周杰伦的'})` | **不**判 `control`；`name==='play_request'`；`slots.artist==='周杰伦'` |
| R-3 | `classify({text:'  下雨了 ，来点  安静的。'})` | `name==='mood_request'`，`slots.mood==='rainy'`，`moodCandidates` 含 `calm`；空白已折叠 |
| R-4 | `classify({text:'放《生如夏花》'})` | `name==='play_request'`、`slots.title==='生如夏花'`、`lane==='music'` |
| R-5 | `classify({source:'schedule',slot:'morning'})` | `name==='scheduled_broadcast'`、`slots.slot==='morning'`、`priority==='schedule'`、`text===''` |
| R-6 | 表驱动穷举 `mood-rules.md` §一 全部触发词 | 每词匹配到**对应**档位 ID，零错配；14 个档位 ID 全部可达 |

---

## 3. `src/layer2/context.js`

### 3.1 职责边界与导出

**做**：读五份语料、算内容哈希、组装六片碎片、按预算截断、渲染单段 stdin prompt。
**不做**：不发请求（天气/日历走 `providers/`）、不调大脑、不写文件、不缓存 prompt 文本本身（只缓存**语料读取结果**）。

```js
/** @param {Intent} intent @returns {Promise<PromptFragments>} */
export async function build(intent) {}
/** @param {PromptFragments} f @returns {string} */
export function renderPrompt(f) {}
/** 五份语料内容哈希（sha1 前 16 位）；mtime/size 未变则命中进程内缓存 @returns {string} */
export function corpusHash() {}
/** 强制失效（PUT /api/taste 写入后调用）@returns {void} */
export function invalidate() {}
/** ②.4 片摘要 @param {Object} plJson @param {{slot?:string,mood?:string}} hint @returns {string} */
export function digestPlaylists(plJson, hint) {}
/** @param {string} s @returns {number} */
export function estimateTokens(s) {}
```

### 3.2 六片碎片与 token 预算

`estimateTokens(s) = Math.ceil(s.length / 1.4)`；**总预算 12,200 字符**（≈ 8~10k token）。

| 片 | 来源 | 注入位 | 预算 | 超限截断策略 |
|---|---|---|---|---|
| ① 系统提示词 | `knowledge/prompts/dj-persona.md` 全文 | system | **3600** | 按 `\n---\n` 分段，从尾部依次丢「示例：坏的输出」→「自我检查清单」→「五、边界情况」；**「三、输出契约」永不丢** |
| ②.1 品味 | `knowledge/user/taste.md` | system | **2000** | 保留 §一 §二 §三 §五；丢 §六 §七 |
| ②.2 作息 | `knowledge/user/routines.md` | system | **1500** | 保留 §一 §二 §五；当前 slot 所在行**必留**；丢 §三 §七 §九 |
| ②.3 情绪规则 | `knowledge/user/mood-rules.md` | system | **1800** | 保留 §一 §三 §七；§二 能量表压成一行摘要；丢 §六 §八 |
| ②.4 曲目池 | `knowledge/user/playlists.json`（**摘要**） | system | **700** | 见 §3.3，输出长度与原文无关，天然有界 |
| ③ 环境注入 | 系统时钟 + `providers/weather` + `providers/calendar` | system | **400** | 日历 ≤ 3 条 / 未来 4 小时；天气压成 1 行；失败填「（不可用）」 |
| ④ 已检索记忆 | `state.recentPlays(10)` + `recentMessages(6)` + `getPlan(today)` | user | **1200** | plays 10→5→3；messages 6→3→2；plan 只留 `slot:status` 与 `say` 前 20 字 |
| ⑤ 用户输入 / 工具结果 | `intent.text` + `music.search` 候选 | user | **800** | 候选 10→5→3；**用户原话不截断**（> 600 字告警） |
| ⑥ 执行轨迹 | 触发来源与原因 | user | **200** | 固定短，无截断 |

**全局收缩序列**（逐片截断后总量仍 > 12,200 时按序执行，每步复检）：

```
1. ⑤ 丢弃候选段（-300）                      5. ②.3 丢 §二 能量表（-500）
2. ④ messages 3→2（-150）                   6. ②.2 丢非当前 slot 的行（-400）
3. ②.4 只留「当前 slot + fallbackPool」（-300）  7. ②.1 丢 §七 探索倾向（-400）
4. ① 丢「示例：坏的输出」+「自我检查清单」（-600）
```

**HARD_KEEP（任何情况下不截断）**：① 的「三、输出契约」全段 · ⑤ 的用户原话 · ⑥ 全段。

### 3.3 ②.4 摘要算法

```
digestPlaylists(plJson, {slot, mood}):
  1. 打分排序 playlists[]：命中 slot（含 'any'）+100；命中 mood +80；
     pl.id === slotDefaults[slot] +60；其余按 energy 升序（低能量优先）
  2. 取前 6，每个一行：- <id> | <name> | slots=[…] | moods=[…] | energy=<n> | 代表曲：<tracks[0..4] 顿号连接>
  3. 尾行追加 fallbackPool 前 5 首
  4. 若 > 700 字符 → 只保留第 1 名与 fallbackPool 行
```

### 3.4 最终 prompt 模板（全文，可直接使用）

> `dsh --profile dj-brain` 的 profile 只固定模型与工具，**不承载动态 system**，因此 ① ② ③ 以显式分节头拼进同一段文本，经 **stdin** 传入。模板内的 `#` 行内注释是**故意保留**的字段说明，帮助模型对齐语义。

```js
/** @param {PromptFragments} f @returns {string} */
export function renderPrompt(f) {
  return `你是 Claudiao 电台的 DJ。下面的材料按优先级从低到高排列，「本轮输入」优先级最高。

# 【① 系统提示词 · 人格与输出契约】
${f.persona}

# 【② 用户语料 · 你的长期判断依据】
## ②.1 品味 taste.md
${f.taste}
## ②.2 作息 routines.md
${f.routines}
## ②.3 情绪规则 mood-rules.md
${f.moodRules}
## ②.4 曲目池 playlists.json（摘要；id 可用于 reason 溯源）
${f.playlistsDigest}

# 【③ 环境注入 · 让播报属于"此刻"】
now:        ${f.env.now}          # 例 2026-10-15T21:30:04+08:00 周四
dayType:    ${f.env.dayType}      # workday | weekend | holiday
slot:       ${f.env.slot}         # 当前所处 routines.md 时段，如 night
quietHours: ${f.env.quietHours}   # true = 当前处于静默时段（仅用户主动时才回应）
weather:    ${f.env.weather}      # 例 小雨 18℃ 体感 16℃；"（不可用）" 表示取数失败
calendar:   ${f.env.calendar}     # 未来 4 小时事件；无则「（空）」

# 【④ 已检索记忆 · 避免重复、接得上话】
recentPlays（最近 ${f.mem.plays.length} 次播放，新→旧）:
${f.mem.playsText}
recentMessages（最近 ${f.mem.messages.length} 条对话，新→旧）:
${f.mem.messagesText}
todayPlan（今日 slot 与状态）:
${f.mem.planText}

# 【⑤ 本轮输入 / 工具结果】
用户原话: ${f.input.text || '（无，本次为定时触发）'}
路由判定: intent=${f.input.intent} lane=${f.input.lane} mood=${f.input.mood || '-'} confidence=${f.input.confidence}
音乐检索候选（已检索，可直接选用；元素格式 "艺人 - 曲名"）:
${f.input.candidatesText}

# 【⑥ 执行轨迹】
trigger:  ${f.trace.trigger}      # user_chat | schedule | webhook | prefetch
slot:     ${f.trace.slot || '-'}
reason:   ${f.trace.reason}
attempt:  ${f.trace.attempt}      # 1=首次；>1=上次失败后的重试
corpus:   ${f.trace.corpusHash}   # 语料内容哈希前 12 位${f.trace.hint ? `\n纠偏:     ${f.trace.hint}` : ''}

# 【输出】
只输出一个 JSON 对象，不加任何其它字符、不加围栏：
{"say":"…","play":["艺人 - 曲名"],"reason":"…","segue":"…"}`;
}
```

行格式：`playsText` = `- 2026-10-15 21:12 | 李志 - 下雨 | 听完 96% | reason: 雨天低能量档`；`messagesText` = `- [user] 21:30 下雨了，来点安静的`；`candidatesText` = `- 李志 - 下雨（netease, 专辑《梵高先生》, 245s, match=0.91）`。

### 3.5 语料哈希、缓存与「改完下次生效」

```
corpusHash = sha1( sha1(persona.md) + sha1(taste.md) + sha1(routines.md)
                 + sha1(mood-rules.md) + sha1(playlists.json) ).slice(0,16)
```

| 用途 | 说明 |
|---|---|
| 进程内缓存键 | `build()` 前 `fs.stat` 五文件；五组 `(mtimeMs,size)` 与上次一致 → 复用已解析结果，**不重读正文**；任一变化 → 重读、重算哈希、清缓存。**不重启进程**（D-06 / F-09） |
| prompt 溯源 | 哈希前 12 位写入第 ⑥ 片 `corpus=`，可定位「哪一版语料产出了这个决策」 |
| `plan` 留痕 | `plan.context_hash` 记录本次所用哈希；与当前哈希不同即说明「改完还没生效」 |
| 乐观并发 | 作为 `GET/PUT /api/taste` 的 `ETag` / `baseSha1`，见 [03](03-api-contract.md#24-get-apitaste--put-apitaste) |
| 日志合规 | `LOG_PROMPT!==1` 时只记 `corpusHash` / `bytes` / `estTokens`，不记全文 |

**默认语料兜底**：任一文件缺失 → 读 `config/defaults/<同名文件>` 顶替，抛 `E_CONTEXT_CORPUS_MISSING`（warn），`stats.truncated` 追加 `corpus:<name>`，并在 `Broadcast.degraded` 置位。

### 3.6 单元测试要点

| # | 用例 | 断言 |
|---|---|---|
| C-1 | 语料齐全时 `build(moodIntent)` | 六片非空；`prompt` 含 `【①`…`【⑥` 六个分节头；`stats.bytes ≤ 12200` |
| C-2 | `taste.md` 改成 8KB | `stats.truncated` 含 `'taste'`；②.1 仍含「绝对排除」段；总量仍 ≤ 12200 |
| C-3 | 只 `touch`（改 mtime 不改内容）`routines.md` | 重新读取但 `corpusHash` **不变** |
| C-4 | 真改 `mood-rules.md` 一个字符 | `corpusHash` 变化；未调 `invalidate()` 也能取到新值 |
| C-5 | 删除 `taste.md` | 使用 `config/defaults/taste.md`；抛 `E_CONTEXT_CORPUS_MISSING`；`degraded===true` |
| C-6 | 预算压到 500 的极端截断 | 输出仍含「三、输出契约」关键句与用户原话（HARD_KEEP 生效） |

---

## 4. `src/layer2/brain.js`

### 4.1 职责边界与导出

**做**：维护会话 id、拼 argv、spawn 子进程、逐行消费 NDJSON、取 `final`、解析 `DjAction`、失败重试与模板降级。
**不做**：不组装 prompt、不选歌、不合成 TTS、不直接 `spawn` 具体命令（走 `adapters/brain/dsh-headless.js`，总览 §3.3）。

```js
/** @param {PromptFragments} fragments
 *  @param {{sessionId?:string,timeoutMs?:number,signal?:AbortSignal,priority?:string}} [opts]
 *  @returns {Promise<{action:DjAction,meta:BrainMeta}>} */
export async function compute(fragments, opts) {}
/** 从 final 文本容错提取 DjAction（规范算法见 03#dj-action-v1）
 *  @param {string} text @returns {{action:DjAction,path:string,repairs:string[]}} */
export function parseAction(text) {}
/** @returns {string} 形如 radio-20261015-9c1b7f3a */
export function newSessionId() {}
/** 从 prefs 读会话 id，无则创建并持久化 @returns {string} */
export function currentSessionId() {}
/** 用户显式要求「重新开始」时复位会话 @returns {string} */
export function resetSession() {}
```

### 4.2 核心算法

1. **取会话 id**：`state.getPref('brain.sessionId')`，无则 `newSessionId()` 并写回。落盘于 `$DSH_HOME/sessions/<cwd安全化>/<sid>`，实测即 `C:\Users\wumingtao\.dsh\sessions\--D-DJ--\<sid>`（**按 cwd 分目录**，故 `dsh` 必须以 `cwd=D:\DJ` 启动，否则历史分裂到别的目录）。
2. **单飞闩**：模块级 `inflight`，同刻只允许一个 `dsh` 子进程（总览 §5.3「子进程上限 1」）；已在途则按 `user_chat > schedule > prefetch` 排队，排队 > 20s 丢低优先级并抛 `E_BUSY`。
3. **spawn**：`dsh --profile dj-brain --json --session-id <sid>`，`cwd=D:\DJ`，`windowsHide:true`，`stdio:['pipe','pipe','pipe']`。
4. **喂 prompt**：`stdin.write(prompt,'utf8')` → `stdin.end()`（**prompt 走 stdin，不是 argv**）。
5. **消费 NDJSON**：`readline` 逐行 `JSON.parse`。实测事件序 `session` → `status(turn_start)` → `status(step_start)` → `thinking` → `text` → `status(step_end, usage)` → `status(turn_end, reason)` → `final`。单行解析失败只记 debug，**不致命**；逐事件向 WS 推 `brain-status` 让前端有进度感。
6. **读取规则**：**只有 `final` 事件携带无损完整答案**；其它字符串字段上限 8KiB、单行 32KiB、嵌套 64 层，超限带 `truncated` 标志。故 `text`/`thinking` 只作**进度投影**，不作结果。
7. **超时**：默认 `timeoutMs=30000`（实测单轮 5.5s、resume 10.1s，30s 余量充足）；超时 `child.kill()` 并抛 `E_BRAIN_TIMEOUT`；stderr 保留最后 4KB 供诊断。
8. **收敛**：退出码 0 且有 `final` → `parseAction(final.text)`；退出码 ≠ 0 → `E_BRAIN_EXIT`；无 `final` → 先试**次优路径**：存在 `text` 事件且**未带 `truncated`** 时解析它，置 `meta.source='text-projection'`、`degraded=true`；否则 `E_BRAIN_NO_FINAL`。
9. **重试**：仅对 `E_BRAIN_TIMEOUT` / `E_BRAIN_EXIT` / `E_BRAIN_NO_FINAL` / `E_BRAIN_PARSE` 重试 **1 次**，沿用同一 `sessionId`（resume 更省 token）；若首次为 `E_BRAIN_PARSE`，重试时注入 `trace.hint = '上次输出不是合法 JSON，只输出一个 JSON 对象，不要围栏。'`
10. **模板降级**：重试仍失败 → `fallback-templates.js` 按时段/情绪取模板 `say` + `slotDefaults[slot]`（或 `moodDefaults[mood]`，取不到用 `fallbackPool`）选 1~3 首，返回正常形状 `DjAction`，`degraded=true`、`meta.source='template'`。
11. **记账**：`usage{inputTokens,outputTokens,cacheReadTokens,cacheWriteTokens,totalTokens}` 累加进 `prefs['brain.usage.total']`；`meta` 落日志。

### 4.3 错误与降级、单元测试要点

适配器内部码 → 本文档 `RadioError.code` 的映射（[05 大脑适配器](05-brain-adapter.md) 用左侧一组更细的码）：

| [05](05-brain-adapter.md) 适配器码 | 本模块码 | 说明 |
|---|---|---|
| `E_TIMEOUT` | `E_BRAIN_TIMEOUT` | 30s 未结束，`taskkill /T` 杀整棵进程树 |
| `E_EXIT` | `E_BRAIN_EXIT` | 退出码 ≠ 0 |
| `E_EMPTY` | `E_BRAIN_NO_FINAL` | 无 `final` 且无可用 `text` |
| `E_JSON` / `E_SAY_MISSING` | `E_BRAIN_PARSE` | 提取或字段校验失败 |
| `E_SESSION_LOST` | `E_BRAIN_EXIT`（**不重试**，先 `resetSession()` 再试） | 会话文件损坏 |
| `E_SPAWN` | `E_BRAIN_EXIT`（**不重试**） | 可执行文件缺失 → 启动自检直接报错 |

| 失败 | 处理 |
|---|---|
| 超时 / 退出码 1 / JSON 解析失败 | ① 重试 1 次；② 仍失败 → 模板播报 + `playlists.json` 对应档位歌单（总览 §5.2） |
| `final` 缺失但 `text` 未截断 | 采用 `text` 投影（`degraded=true`，`source='text-projection'`） |
| 会话文件损坏（resume 报错） | `resetSession()` 后重试 1 次，旧 id 记入 `prefs['brain.sessionHistory']` |
| `dsh` 可执行文件不存在 | 抛 `E_BRAIN_EXIT`（不重试），直接模板，启动自检报错 |

| # | 用例 | 断言 |
|---|---|---|
| B-1 | 喂入 8 事件完整 NDJSON | `parseAction` 调用 1 次；`meta.source==='final'`；`meta.usage.totalTokens>0` |
| B-2 | 只有 `error` 事件、无 `final` | 抛 `E_BRAIN_NO_FINAL`；调用方恰好重试 1 次 |
| B-3 | `text` 事件带 `truncated:true` | **不**采用投影；走模板，`degraded===true` |
| B-4 | `final.text` 为 ` ```json\n{…}\n``` ` | 解析成功；`meta.parsePath==='fenced'`；`repairs` 为空 |
| B-5 | 首次 `E_BRAIN_PARSE` 后重试 | 第二次 prompt 含「只输出一个 JSON 对象」；两次 spawn 共用同一 `--session-id` |
| B-6 | 并发 3 次 `compute()` | `spawn` 调用数为 1，另两次排队；子进程 30s 不退时 `kill()` 被调用且无僵尸 |

---

## 5. `src/layer2/tts.js`

### 5.1 职责边界与导出

**做**：`say` 预处理 → 缓存键 → 命中检查 → 调度合成（并发 2）→ 原子落盘 → 返回 `/tts/<hash>.<ext>`。
**不做**：不含任何云 TTS、不做语音克隆、不直接 `spawn`（走 `adapters/tts/{edge-tts,sapi}.js`）、不做转码（除非 `FFMPEG_PATH` 探测通过）。

```js
/** @param {string} text
 *  @param {{voice?:string,rate?:string,pitch?:string,slot?:string,priority?:string,signal?:AbortSignal}} [opts]
 *  @returns {Promise<{url,path,hash,ext:'mp3'|'wav',mime,bytes,durationMs,est,cached,engine,skipped}>} */
export async function synthesize(text, opts) {}
/** 缓存键 = sha1(voice|rate|pitch|text).slice(0,16) @returns {string} */
export function cacheKey(text, opts) {}
/** 探测引擎可用性，写 data/tts-status.json @returns {Promise<{active:string|null,edge:Object,sapi:Object}>} */
export async function init() {}
/** @returns {Promise<Array<{id,lang,gender,desc?}>>} */
export async function listVoices() {}
/** 前端 loadedmetadata 回填真实时长；LRU 清理 @returns {void|Promise<{removed,bytes}>} */
export function reportDuration(hash, durationMs) {}
export async function cleanCache() {}
```

### 5.2 核心算法（layer2 层关注点；文本预处理与缓存细节见 [04](04-tts-pipeline.md) §4~§8）

1. **预处理**：`clamp200` → R1~R9 规则 → 空串兜底（返回 `null` 即跳过 TTS）。顺序**不可颠倒**。
2. **音色解析**：`config/tts.yml` 的 `voice/rate/pitch`，`bySlot[slot]` 覆盖默认。**slot 别名**：[04](04-tts-pipeline.md) §2.3 的 `planning` → 本表 `daily_plan`、`hourly` → `hourly_check`；实现以本表 slot id 为键，并在 yml 里同时写别名。
3. **缓存键**：`sha1(`${voice}|${rate}|${pitch}|${text}`).slice(0,16)`（D-07；`volume`、`engine` **不进键**）。
4. **命中检查**：先查 `data/tts-cache/<hash>.mp3`，再查 `<hash>.wav`（mp3 优先）；命中即返回，P95 < 50ms（N-02）。未命中入队，**全局并发 2**，队列深度 > 20 丢弃 `prefetch` 任务（总览 §5.3）。
5. **主路径 edge-tts**：`edge-tts --voice <v> --rate <r> --pitch <p> --text <t> --write-media <out.mp3>`。实测 **3.07s / 一句 → 30096 字节 mp3**。
6. **降级 SAPI**：`Add-Type -AssemblyName System.Speech` + `SpeechSynthesizer` + `SelectVoice('Microsoft Huihui Desktop')` + `SetOutputToWaveFile(<out.wav>)`；**只能输出 WAV**（实测 76958 字节）。该音色是 SAPI **唯一**中文音色（另有 `Microsoft Zira Desktop` en-US）。同 hash 因此存在 `.wav` 变体：对外 URL 仍写 `/tts/<hash>.mp3`，由路由按实际存在文件回落并如实声明 `audio/wav`（[04](04-tts-pipeline.md) §6）。
7. **原子写入**：先写 `data/tts-cache/.tmp/`，`fs.stat` 校验 `size ≥ 1024` 后同卷 `rename` 到最终路径；失败必清理临时文件。
8. **两者皆失败** → 抛 `E_TTS_SAPI_FAIL`，编排层置 `say.skipped=true` 并进 `MUSIC_ONLY`；`say.text` 仍下发前端展示（不朗读）。
9. **返回** `{url:'/tts/<hash>.mp3', mime, durationMs, est:true, …}`；前端 `loadedmetadata` 回填真值并 EMA 校准码率。

### 5.3 错误与降级、单元测试要点

| 失败 | 处理 |
|---|---|
| edge-tts 失败 | 同请求内立即降级 SAPI（用户无感）→ `mime='audio/wav'` |
| SAPI 亦失败 | 跳过语音直接放歌（`MUSIC_ONLY`），error 日志只记 `sha1[:8]` 与长度 |
| 文本 > 200 字 | 按句末标点截断到 ≤ 200，warn，抛 `E_TTS_TEXT_TOO_LONG` 供上层记账 |
| 预处理后为空串 | 不合成、不报错，`skipped=true` |
| 队列积压 > 20 | 丢 `prefetch`；`say` 任务永不丢 |

| # | 用例 | 断言 |
|---|---|---|
| T-1 | 同 `(voice,rate,pitch,text)` 请求 2 次 | 第 2 次 `spawn` 调用数仍为 1；同 hash；`cached===true` |
| T-2 | 改 `voice` 后请求同一文本 | hash 变化且再次 `spawn`（D-07 生效） |
| T-3 | edge 桩返回退出码 1 | 本次内回落 SAPI；`mime==='audio/wav'`、`ext==='wav'` |
| T-4 | `say` 260 字 | 截断后 ≤ 200 且以 `。` 结尾；warn 日志不含全文 |
| T-5 | 预处理后为空（`'** **'`） | `skipped===true`；不产生子进程；不抛异常 |
| T-6 | 合成中 `kill` 子进程 | 缓存目录无半截文件；`.tmp/` 已清空；重试可成功 |

---

## 6. `src/layer2/scheduler.js`

### 6.1 职责边界与调度表

**做**：持有 cron 表、检测休眠与漏触发、做补跑裁决、按节制规则过滤、经 `state` 抢锁、投递 `Intent`。
**不做**：不选曲、不合成、不直接调大脑（一律经 `router.classify` → `compute()`）。

slot id 取自 `routines.md` §二 与 `playlists.json.slotDefaults`（唯一权威）：

| slot | cron | 触发意图 | 发声 | `need_brain` | 可补跑 | 补跑窗口 |
|---|---|---|---|---|---|---|
| `daily_plan` | `0 7 * * *` | `scheduled_broadcast` | ❌ 静默 | ✅ | ✅ | 07:00 → **12:00** |
| `morning` | `0 9 * * *` | `scheduled_broadcast` | ✅ | ✅ | ✅ | 09:00 → **10:30** |
| `hourly_check` | `0 9-22 * * *` | `scheduled_broadcast` | ⚠️ 无新信息保持沉默 | ✅ | ❌ | — |
| `noon` | `0 12 * * *` | `scheduled_broadcast` | ✅ | ✅ | ✅ | +60min |
| `evening` | `30 17 * * *` | `scheduled_broadcast` | ✅ | ✅ | ✅ | +90min |
| `night_wind_down` | `30 22 * * *` | `scheduled_broadcast` | ✅ 一句 | ❌ | ❌ | — |
| `calendar_hook` | 事件驱动（前 30min / 结束后） | `skill_trigger` | ✅ | ✅ | ❌ | — |
| `prefetch` | 前端「剩余 10s」事件驱动 | —（预热） | ❌ | ❌ | — | — |

cron 解析优先用 `node-cron` 并显式指定 `timezone:'Asia/Shanghai'`；依赖不可用时退化为 **30s tick + `HH:MM` 匹配**（行为等价，日界按本地日期）。

**slot id 别名**（[调度与节律](07-scheduler-rhythm.md) 的 `config/routines.yml` 用了另一组 id）：

| 本表 id（= `routines.md` §二 与 `playlists.json.slotDefaults`，**唯一权威**） | [07](07-scheduler-rhythm.md) / `routines.yml` 用名 |
|---|---|
| `daily_plan` | `planning`（`playlists.json.slotDefaults` 只有 `daily_plan`，yml 必须改用本表 id） |
| `hourly_check` | `hourly_check` |
| `night_wind_down` | `night_wind_down` |
| `calendar_hook` | `calendar_hook` |
| `morning` · `noon` · `evening` · `prefetch` | 同名 |

**`Intent.name` 与 `slots[].intent` 的关系**：07 的 yml 把 slot 语义写在 `slots[].intent`（`morning_brief` / `mood_check` / `wind_down` / `warmup` / `daily_plan`）。按 §2.2，`router.classify` 对 `source==='schedule'` **一律**归类为 `scheduled_broadcast`（本表唯一权威的意图名），slot 语义通过 `intent.slots.slot` 与第 ⑥ 片传递；yml 的 `slots[].intent` 只是可读标签，**不进入 `Intent.name`**。

⚠️ **四处参数取值冲突**，实现前需拍板。本表按 `routines.md` 的**语料值**给默认，因为该语料会直接喂给大脑：

| 参数 | `routines.md`（语料，本表默认） | [07](07-scheduler-rhythm.md) 早期取值 | 裁决（**已落地**） |
|---|---|---|---|
| 静默时段 | **23:00–07:00** | 22:30–07:00 | ✅ **取 23:00**。22:30 既是静默起点又是 `night_wind_down` 的 cron，会把「晚安」当场挡掉（07 的 `quietHours.allow` 只放行 `prefetch`，属内部自相矛盾）。改 23:00 后该 slot 天然落在窗口外，**不需要任何例外**。已同步 `config/routines.yml` 与 07 |
| 两次主动播报最小间隔 | **45 分钟** | `throttle.minGapMs = 1200000`（20 分钟） | ✅ **取 45 分钟**，07 已改为 `2700000`，与 `routines.yml` 的 `limits.minIntervalMinutes` 一致 |
| 整点情绪检查窗口 | **09:00–22:00** | cron `0 10-22 * * *` | ✅ **取 `0 9-22 * * *`**，与 `routines.yml` 的 `hoursRange: [9, 22]` 一致 |
| 熔断阈值 | 连续 3 次停到次日 | `slotFailLimit=3` / `globalFailLimit=5` | ✅ **两者并存且不冲突**：`slotFailLimit` 管单个 slot，`globalFailLimit` 管全局暂停 6h；语料的「3 次」对应前者 |
| slot 标识符 | 下划线命名（本表，唯一权威） | 连字符命名 | ✅ **统一下划线**，07 与 04 已全文改名 |
| 连续失败熔断 | **3 次 → 停止主动播报至次日** | `slotFailLimit=3` + `globalFailLimit=5` → 暂停 6h，次日 00:00 恢复 | 两者可叠加：slot 级 3 次只熔断该 slot，全局 5 次熔断全部主动播报（22:00 后 6h≈次日，与语料一致） |

### 6.2 幂等键与加锁

- **幂等键**：`${dateKey}#${slot}`，`dateKey = YYYY-MM-DD`（`Asia/Shanghai`）。唯一性由 `plan` 表 `PRIMARY KEY (date, slot)` 保证（DDL 见 [03](03-api-contract.md#sqlite-ddl)）。
- **生命周期**（总览 §8.2）：`pending → claimed(加锁) → running → {succeeded | failed | skipped}`；超过 **90s** 未终结视为 stale，释放锁并标记 `failed`。
- **原子抢锁**（单条 SQL，无读-改-写竞态，对应 `state.acquirePlanLock`）：

```sql
INSERT OR IGNORE INTO plan (date, slot, status, scheduled_at, updated_at) VALUES (?,?, 'pending', ?, ?);

UPDATE plan SET status='claimed', claimed_at=?, owner=?, attempt=attempt+1, updated_at=?
 WHERE date=? AND slot=?
   AND ( status IN ('pending','failed')
      OR (status='claimed' AND claimed_at < ?) );   -- ? = now - 90000（stale 释放）
-- changes === 1 → 抢到锁；changes === 0 → 已被持有或已 succeeded → 记 skipped
```

- **心跳续期**：`running` 期间每 30s 刷新 `updated_at`；每 tick 扫 `status='claimed' AND claimed_at < now-90000` 改判 `failed`（`state.reapStalePlans(90000)`）。
- **成功写回**：`succeeded` 时写 `say` / `play_json` / `reason` / `broadcast_id` / `context_hash` / `finished_at`。`succeeded` **不可重入**。

### 6.3 节制规则（实现 `routines.md` §二/§五）

| 规则 | 判定点 | 不满足时 |
|---|---|---|
| 静默时段 23:00–07:00 | 投递前 | `skipped(reason='quiet_hours')`；**用户主动 `/api/chat` 不受限** |
| 两次主动播报最小间隔 **45 分钟** | 查最近一条发声且 `succeeded` 的 slot | `skipped(reason='min_gap')`；可补跑 slot 保留 pending 待窗口内重试 |
| 长时段不打断 09:15–12:00 / 14:00–17:30 | 投递前 | 窗口内**全部定时 slot 让路**（含 `hourly_check`）→ `skipped(reason='focus_window')` |
| 每日主动播报上限 **8 次** | `prefs['broadcast.count.<date>']` | `skipped(reason='daily_quota')` |
| 用户交互在途 | 单飞闩非空且 `priority==='user_chat'` | 定时触发**排队不打断**（`user_chat > schedule > prefetch`） |
| 连续失败熔断 **3 次** | `prefs['broadcast.circuit.strikes']` | 停止主动播报至次日 00:00；用户主动仍响应 |
| `night_wind_down` 不走大脑 | 投递前 | 直接用模板晚安语 + `night_wind_down` 歌单 |

### 6.4 休眠唤醒与补跑

```
setInterval(tick, 30_000)
tick():
  now = Date.now()
  if (now - lastTickAt > STALE_TICK_MS /* 90000 */) reconcile(now, 'wake')   // 间隙异常 → 休眠唤醒
  else                                              reconcile(now, 'tick')
  lastTickAt = now
```

`reconcile(now, mode)` 步骤：

1. 生成当日 `{slot, scheduledAt, windowEnd}` 清单（窗口取自 §6.1）。
2. 逐 slot 读 `plan` 行；`status==='succeeded'` → 跳过。
3. `now < scheduledAt` → 跳过，等正常触发。
4. `scheduledAt ≤ now ≤ windowEnd` 且行状态 ∈ `{pending, failed}` → **入补跑队列**，`trace.reason='catchup'`。
5. `now > windowEnd`（或 slot 不可补跑）→ 写 `status='skipped'`, `skip_reason='missed_window'`。**开机不做连续补播**，避免早晨开机时连甩三条早间播报。
6. **合并**：一次 `reconcile` 命中多个可补跑 slot 时只投**优先级最高**者（`morning > noon > evening > daily_plan`），其余标 `skipped(reason='superseded')`，并把「错过的档位」并入第 ⑥ 片，让大脑一句话带过（例「早上那条错过了，中午一并说了」）。
7. `mode==='wake'` 额外做三件事：清空在途 TTS 队列（连接可能已断）、`state.reapStalePlans(90000)`、向所有 WS 客户端推 `state-change` 与 `heartbeat`。
8. 进程启动时立即执行一次 `reconcile(now, 'startup')`。

### 6.5 错误与降级、单元测试要点

| 情况 | 行为 |
|---|---|
| 抢锁失败（已被持有） | 静默 `skipped`，不重试 |
| `E_PLAN_CONFLICT`（已 `succeeded`） | 记 `skipped`，debug 日志 |
| 投递时 `compute()` 抛错 | `failed` + `error_code` 落 `plan`；计入熔断 strikes |
| 系统时钟回拨（`now < lastTickAt - 60000`） | warn 并重置 `lastTickAt`，**不补跑** |
| 时区 / DST | `Asia/Shanghai` 无 DST；`dateKey` 用 `Intl.DateTimeFormat` 取本地日，**不用** `toISOString()` |

| # | 用例 | 断言 |
|---|---|---|
| S-1 | 同日同 slot 投递两次 | 第二次 `acquire` 返回 `false`；`plan` 仅 1 行；`skipped` +1 |
| S-2 | 制造 `claimed` 且 `claimed_at = now-91s` | `reapStale` 改判 `failed`；随后可重新抢锁成功 |
| S-3 | 模拟休眠（`lastTickAt = now-600s`） | 触发 `reconcile(wake)`；窗口内 slot 入补跑，窗口外记 `missed_window` |
| S-4 | 09:16 投递 `hourly_check` | `skipped(reason='focus_window')`；**不**调 `compute()` |
| S-5 | 10:05 补跑 `daily_plan`（窗口至 12:00） | 入补跑队列且 `trace` 含 `catchup` |
| S-6 | 一次 reconcile 同时命中 `morning` 与 `noon` | 只投 `morning`；`noon` 记 `superseded` |

---

## 7. `src/layer2/state.js`

### 7.1 职责边界

**做**：SQLite 连接与迁移、四表 CRUD、`plan` 加锁、`prefs` 读写、指标聚合、修剪。
**不做**：不做业务判断（该不该播、选哪首）、不写日志文件、不联网。DDL 正文见 [03 SQLite DDL](03-api-contract.md#sqlite-ddl)（总览 §6.2 已如此指向）。

### 7.2 全部导出

| 函数 | 签名要点 | 说明 |
|---|---|---|
| `open(opts)` | `({path?,readonly?}) → Database` | 打开并执行迁移（`PRAGMA user_version`） |
| `close()` | `() → void` | 关闭连接，flush WAL |
| `record(intent, broadcast)` | `(Intent, Broadcast) → void` | §9 编排入口，**单事务**写 messages + plays + plan |
| `recordMessage(msg)` | `({role,text,intent?,lane?,sessionId?,broadcastId?,degraded?,meta?}) → number` | 返回新行 id |
| `recentMessages(limit=6, opts?)` | `({date?,role?,sinceMs?}) → Message[]` | `at_ms` 降序 |
| `recordPlay(play)` | `({trackId,source,title,artist,album?,spec,audioUrl?,coverUrl?,lyricUrl?,durationMs?,playedMs?,completed?,skipped?,feedback?,broadcastId?,intent?,reason?,degraded?}) → number` | `(broadcast_id,track_id)` 唯一索引去重 |
| `recentPlays(limit=10, opts?)` | `({sinceMs?,excludeSkipped?}) → Play[]` | `at_ms` 降序 |
| `playedTrackIds(hours)` | `(number) → Set<string>` | 最近 N 小时已播曲目 id（F-05 去重） |
| `getPlan(date)` | `(string) → PlanRow[]` | 无数据返回 `[]`，不抛 |
| `upsertPlan(row)` | `(PlanRow) → void` | 插入或整体覆盖，幂等 |
| `acquirePlanLock(date, slot, owner)` | `→ boolean` | 原子抢锁（§6.2） |
| `releasePlan(date, slot, status, patch?)` | `('succeeded'\|'failed'\|'skipped', Object?) → void` | 终结一行 |
| `reapStalePlans(staleMs)` | `(number) → number` | 释放 stale 锁，返回改判行数 |
| `getPref(key, fallback?)` | `→ any` | JSON 反序列化，损坏时返回 `fallback` |
| `setPref(key, value, note?)` | `→ void` | `JSON.stringify` 存储 |
| `allPrefs(prefix?)` | `→ Record<string,any>` | 按前缀批量读取 |
| `bumpPref(key, delta)` | `→ number` | 原子自增（配额、熔断计数） |
| `metrics(range?)` | `({fromMs?,toMs?}) → {plays,skipped,completed,completionRate,sayChars,degradedRate,brainMsP50}` | 指标聚合 |
| `prune(opts?)` | `({keepMessagesDays?,keepPlaysDays?}) → {messages,plays}` | 历史修剪 |
| `tx(fn)` | `<T>(() => T) → T` | 事务包装 |

### 7.3 核心处理约定

| 项 | 约定 |
|---|---|
| 驱动 | `better-sqlite3`（同步 API，与「同步性=同步」的模块契约一致） |
| PRAGMA | `journal_mode=WAL`、`synchronous=NORMAL`、`busy_timeout=5000`、`foreign_keys=OFF` |
| 时间列 | `at_ms INTEGER`（epoch 毫秒，索引与比较）+ `date TEXT`（本地日 `YYYY-MM-DD`，按日聚合）；**仅 API 边界**转 ISO 8601 |
| JSON 列 | `play_json` / `meta_json` / `value` 一律 `JSON.stringify` 存 TEXT；读出容错 parse，失败返回 `null` 并 warn |
| 预编译 | 所有语句在模块初始化时 `db.prepare()` 并缓存；热路径禁止拼 SQL 字符串 |
| 绑定 | 一律具名/位置绑定，**禁止字符串拼接**；`LIKE` 走 `?` 并转义 `%` `_` |
| 迁移 | `PRAGMA user_version` 作 schema 版本，启动时顺序执行 `migrations/NNN-*.sql` |
| 失败降级 | `E_STATE_DB` 时启用内存影子数组（容量 200）保证不静音；恢复后 flush |
| 隐私 | `messages.text` 是唯一存全文的表，日志与指标只记长度 |

### 7.4 错误与降级、单元测试要点

| 情况 | 行为 |
|---|---|
| `SQLITE_BUSY` / DB 被占用 | 重试 3 次（间隔 100ms），仍失败抛 `E_STATE_DB` |
| 磁盘满 | 抛 `E_STATE_DB`；先 `prune()` 删最旧 `messages` 释放空间 |
| `plan` 唯一约束冲突 | 视为 `E_PLAN_CONFLICT`，由 `scheduler` 记 `skipped` |
| `prefs.value` JSON 损坏 | 返回 `fallback`，warn，不抛 |

| # | 用例 | 断言 |
|---|---|---|
| D-1 | 连续 `recordPlay` 同一 `broadcast_id + track_id` | `plays` 仅 1 行（唯一索引生效） |
| D-2 | 15 行数据上 `recentPlays(10)` | 返回 10 行且 `at_ms` 严格降序 |
| D-3 | `recentMessages(6,{role:'user'})` | 只含 `role='user'`，按 `at_ms` 降序 |
| D-4 | 空库 `getPlan('2026-10-15')` | 返回 `[]`，不抛 |
| D-5 | `acquirePlanLock` 并发 5 次（同 `date+slot`） | 恰好 1 次返回 `true` |
| D-6 | `setPref('a',{x:1})` → `getPref('a')`；`getPref('missing',42)` | 前者深相等；后者返回 `42` |

---

## 8. `src/providers/`

### 8.1 `src/providers/music/`

多适配器：`index.js`（编排）+ `gdstudio.js`（公共实例）+ `local-fallback.js`（`data/fallback-audio/`）+ `cache.js`（短期缓存）。

```js
/** @param {string[]} specs @param {{limit?:number,signal?:AbortSignal}} [opts]
 *  @returns {Promise<{tracks:Track[],failures:Array<{spec:string,code:string}>}>} */
export async function resolve(specs, opts) {}
/** @returns {Promise<Track[]>} */
export async function search(name, {source='netease',count=10,pages=1}={}) {}
/** @returns {Promise<{url:string,br:number,size:number,from:string}|null>} */
export async function url(id, {source='netease',br=320}={}) {}
/** 歌词 LRC 文本 / 封面 URL / 歌单元信息 @returns {Promise<string|Object|null>} */
export async function lyric(id, {source='netease'}={}) {}
export async function pic(picId, {source='netease',size=300}={}) {}
export async function playlist(id, {source='netease'}={}) {}
/** 逐源健康探测，写 data/music-health.json @returns {Promise<Record<string,{ok:boolean,latencyMs:number}>>} */
export async function health() {}
```

**HTTP 契约**：基址 `https://music-api.gdstudio.xyz/api.php`，**全部 GET**，`Accept: application/json`，超时 8s，重试 1 次。

| 用途 | 请求 | 关键响应字段 |
|---|---|---|
| search | `?types=search&source=<src>&name=<关键词>&count=10&pages=1` | `id,name,artist[],album,pic_id,url_id,lyric_id,source` |
| 直链 | `?types=url&source=<src>&id=<id>&br=320` | `url,br,size,from`（**实测返回可直接播放的 mp3 直链**） |
| 歌词 | `?types=lyric&source=<src>&id=<id>` | `lyric`（LRC：`[mm:ss.xx] 文本\n…`） |
| 封面 | `?types=pic&source=<src>&id=<pic_id>&size=300` | `url` |
| 歌单 | `?types=playlist&source=<src>&id=<id>` | `code,playlist.trackCount` |

| 源 | 实测状态 | 处置 |
|---|---|---|
| `netease` | ✅ 可用 | 源链第 1 位 |
| `joox` | ✅ 可用 | 源链第 2 位 |
| `kuwo` `tencent` `migu` `kugou` | ❌ 400 / 503 | 默认 `enabled:false`，仅作实验位 |
| 网易官方 `music.163.com/api/song/enhance/player/url` | ❌ 返回 `url=null` | **不使用**，不尝试绕过 |

降级顺序：`netease → joox →（实验源）→ data/fallback-audio/ 本地兜底曲库`（总览 Q-01 与 §5.2）。

### 8.2 `resolve()` 算法

1. `splitSpec(spec)` 按**首个** ` - ` 切分；无分隔符 → `artist=null`、`title=spec`、`matchMode='title-only'`。
2. 查短期缓存（键 `sha1(source|artist|title)`，TTL 6h）。
3. 逐源 `search(name)`（`count=10`）。
4. 打分：`score = 0.55*sim(title) + 0.30*sim(artist) + 0.15*sourceWeight`（`sim` = 归一化编辑距离 + 包含关系）。
5. `score ≥ 0.72` → 取 top1；否则取 top1 但标 `fuzzy=true`。
6. `types=url&br=320` 取直链；`url` 为空或非 `http(s)` → 试 `br=192` → 试下一源。
7. 全源失败 → `local-fallback` 按 slot/mood 档位从 `data/fallback-audio/` 挑一首（自有素材）。
8. 成功结果写缓存；失败写负缓存（TTL 10min 防抖）。

### 8.3 `weather` 与 `calendar`

| 提供方 | 导出 | 失败降级 |
|---|---|---|
| `providers/weather` | `get({lat,lon,timeoutMs=3000}) → {ok,text,tempC?,feelsC?,code?,source,cachedAt}` | 返回 `{ok:false,text:'（不可用）'}`；第 ③ 片填「（不可用）」，**绝不阻塞** `build()`；缓存 30min |
| `providers/calendar` | `upcoming(windowMin) → 事件[]`；`today() → 事件[]`；`isWorkday(date) → boolean` | 返回 `[]`；第 ③ 片填「（空）」；`calendar_hook` 静默不触发；`isWorkday` 按 `config/calendar.yml` 的 `workdays`/`holidays` 覆盖 |

### 8.4 单元测试要点

| # | 用例 | 断言 |
|---|---|---|
| P-1 | `resolve(['李志 - 下雨'])`（netease 桩） | 返回 1 首；`score ≥ 0.72`；`audioUrl` 为 https 直链 |
| P-2 | netease 桩 503、joox 桩正常 | 结果 `source==='joox'`；不抛异常；记 `E_MUSIC_SOURCE_DOWN` |
| P-3 | 全部源失败 | 走本地兜底；`tracks.length ≥ 1`；`degraded` 置位 |
| P-4 | `resolve(['李志 - 不存在的歌xyz'])` | 返回 `fuzzy===true` 或 `failures` 非空；**不抛异常** |
| P-5 | `splitSpec('李志-下雨')`（无空格） | `artist===null`、`title==='李志-下雨'`、`matchMode==='title-only'` |
| P-6 | 同一 spec 连续 `resolve` 2 次 | 第 2 次命中缓存，HTTP 请求数为 0 |

---

## 9. `compute()` 编排（跨模块粘合）

对应总览 §5.1 / §5.2，展开为可实现步骤：

```
compute(intent):
  1  if (intent.lane === 'direct') return directRespond(intent)          // control/query，<50ms
  2  if (!singleFlight.tryEnter(intent.priority)) await singleFlight.waitUpTo(20000)  // 单飞+优先级
  3  fragments = await context.build(intent)                             // ①~⑥ 片
  4  {action, meta} = await brain.compute(fragments)                     // 失败→重试→模板
  5  {tracks} = await music.resolve(action.play)                         // 失败→本地兜底
  6  say = await tts.synthesize(action.say, {slot: intent.slots.slot})   // 失败→SAPI→跳过
  7  broadcast = assemble(intent, action, tracks, say, meta)             // 结构见 03#broadcast
  8  await state.record(intent, broadcast)                               // messages+plays+plan 单事务
  9  ws.broadcast({type:'now-playing', ...broadcast}); singleFlight.exit()  // 无客户端则静默忽略
 10  return broadcast
```

**不变量**：③~⑨ 任一步抛错都必须走各自降级分支，**绝不允许整链中断**；`broadcast.degraded` 与 `degradedReasons[]` 如实记录降级层级（总览 §8.1 的 `DEGRADED` / `FALLBACK_AUDIO` / `MUSIC_ONLY` 三态即由此推出）。`assemble()` 产出的 `Broadcast` 契约见 [03 Broadcast 对象](03-api-contract.md#broadcast)。

**模块间契约速查**：`router.classify → Intent` · `context.build → PromptFragments`（`prompt` 经 stdin）· `brain.compute → DjAction`（`play[]` 为 `"艺人 - 曲名"`）· `music.resolve → Track[]` · `tts.synthesize → {url,mime,durationMs,est}` · `scheduler → {source:'schedule',slot,priority:'schedule'}` · `state.* → 四表`。

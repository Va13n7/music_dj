# Claudiao 个人音乐电台 · 音乐提供方

> 文档版本 v1.0 · 状态：设计完成，待实现
> 上游依据：[设计总览](01-architecture-design.md) §2 第一层 `MUSIC` / §4.1 步骤 ⑦ / §5.2 / §7 D-04 D-08 / §9 / §10 Q-01
> 关联文档：[接口契约](03-api-contract.md) · [TTS 声音管线](04-tts-pipeline.md) · [调度与节律](07-scheduler-rhythm.md) · [前端 PWA](08-pwa-frontend.md)
> 落地位置：`src/providers/music/{index.js,gdstudio.js,matching.js}`
> 施工图格子：第一层 `MUSIC`（`NeteaseCloudMusicApi: search / song_url / lyric / recommend`）→ D-04 已决策改为**公共 API 实例 + 多适配器**

---

## 1. 目标与约束

把大脑给出的 `"艺人 - 曲名"` 变成**当下可播放的音频直链**并附带展示元数据，支撑 `compute()` 第 ⑦ 步与施工图的「ncm 解析 queue」（[设计总览](01-architecture-design.md) §5.1）。

| 编号 | 目标 | 量化验收 |
|---|---|---|
| M-01 | 字符串 → 直链 | 端到端解析成功率 ≥80%（实测热门曲目接近 100%） |
| M-02 | 解析延迟 | 单曲 resolve P95 <1.5s；2 首**串行** <2.0s（受 `MUSIC_MIN_INTERVAL_MS` 节流约束，见 §4.1.1） |
| M-03 | 候选不跑偏 | 打分算法必须滤掉翻唱/伴奏/remix/live（实测「晴天」首条返回翻唱 `晴天(深情版)`） |
| M-04 | 永不断流 | 全源失败 → 本地兜底音频；保底 ≥1 首可播（总览 §5.2） |
| M-05 | 不重复 | 与最近 24h `plays` 比对去重（F-05） |
| M-06 | 可替换 | `MusicProvider` 适配器化，换自建 NeteaseCloudMusicApi 不改业务层（N-07） |

### 1.1 合规边界（硬性）

| 项 | 规则 |
|---|---|
| 只做流式播放 | 直链直接交给浏览器 `<audio>`，**服务端不落地音乐文件** |
| 不下载留存 | 严禁 `data/` 出现音乐文件（`data/fallback-audio/` 仅存用户自备无版权音频，§8） |
| 不二次分发 | 无分享/导出/转存接口；默认绑定 `127.0.0.1`（总览 §9） |
| 不绕过付费墙 | 直链 `null`/失败即降级到下一候选或兜底音频，**不尝试破解、去 DRM、换源超链试错** |
| 只展示元数据与歌词 | `lyric` 仅供 PWA 展示，不做歌词文件导出 |
| 直链临时性 | 直链是带时效的临时授权地址，必须每次重新解析，不得长期缓存、不得跨会话复用（§6） |
| 兜底素材版权 | `scripts/fetch-fallback-audio` 只**引导与校验**用户自备音频，脚本本身不下载版权音乐 |

### 1.2 已实测事实（本设计的事实基线）

| 项 | 结果 |
|---|---|
| 实例 | `https://music-api.gdstudio.xyz/api.php`，**全 GET** |
| 可用源 | `netease` ✅、`joox` ✅ |
| 不可用源 | `kuwo` ❌400、`tencent` ❌400、`migu` ❌400、`kugou` ❌503 |
| 网易官方 `music.163.com` 直连取 url | 返回 `null`，**不可用** |
| `types=url&br=320` | 实测返回**可播放 mp3 直链**（带时间戳路径的 CDN URL） |
| `types=playlist&source=netease&id=3778678` | 可用 |

---

## 2. `MusicProvider` 适配器契约

```js
/**
 * 实现放 src/providers/music/<name>.js。
 * @typedef {Object} MusicProvider
 * @property {string} name                       'gdstudio' | 'self-hosted'
 * @property {string[]} sources                  支持源，按优先级：['netease','joox']
 * @property {() => Promise<{ok:boolean, latencyMs:number, sources:string[]}>} available
 * @property {(q:string, o?:{limit?:number, source?:string}) => Promise<Track[]>} search
 * @property {(ref:TrackRef, o?:{br?:number}) => Promise<ResolvedAudio>} resolve   // 失败抛 ProviderError
 * @property {(id:string) => Promise<{lrc:string, translated?:string}>} lyric
 * @property {(picId:string, size?:number) => Promise<{url:string|null}>} cover
 * @property {(id:string, o?:{source?:string}) => Promise<{id,name,tracks:Track[]}>} playlist
 * @property {(seed?:TrackRef) => Promise<Track[]|null>} recommend                 // 可选，未实现返回 null
 */

type Track = {
  provider: 'gdstudio'; source: 'netease' | 'joox';
  id: string;                 // 源内歌曲 id
  name: string;               // 曲名（原始未清洗）
  artist: string[]; album: string;
  picId: string; lyricId: string;
  urlId: string;              // ★ 解析直链用这个，不是 id（实测返回独立 url_id）
  durationMs?: number;        // 响应含则填，否则 null
};

type ResolvedAudio = {
  url: string; br: number; size: number; from: string;
  resolvedAt: number; expiresAt: number;      // 见 §6
};

type TrackRef = { provider: string; source: string; id: string; urlId?: string; name?: string; artist?: string[] };

class ProviderError extends Error {
  constructor(code, detail) { super(code); this.detail = detail; }
  // code: 'EHTTP' | 'ETIMEOUT' | 'EURLNULL' | 'EEMPTY' | 'EUNSUPPORTED_SOURCE' | 'EBADJSON'
}
```

**字段映射表（API → `Track`）**：

| API 字段 | 内部字段 | 变换 |
|---|---|---|
| `id` | `Track.id` | 字符串化 |
| `url_id` | `Track.urlId` | 原样；**为空回落 `id`** |
| `name` | `Track.name` | `String()` + trim，保留 `(...)` 后缀（交 §5 打分） |
| `artist[]` | `Track.artist[]` | 过滤空串；缺失 → `['未知艺人']` |
| `album` / `pic_id` / `lyric_id` / `source` | 同名 | 原样（`picId` 空则不请求封面，前端用占位图） |

---

## 3. `GdstudioProvider` 实现细节

```js
const BASE = 'https://music-api.gdstudio.xyz/api.php';
async function api(params, { timeoutMs = 4000 } = {}) {
  const url = `${BASE}?${new URLSearchParams(params)}`;
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ac.signal, headers: { accept: 'application/json' } });
    if (!r.ok) throw new ProviderError('EHTTP', { status: r.status, url });
    return await r.json().catch(() => { throw new ProviderError('EBADJSON', { url }); });
  } catch (e) {
    if (e.name === 'AbortError') throw new ProviderError('ETIMEOUT', { url, timeoutMs });
    throw e;
  } finally { clearTimeout(t); }
}
```

### 3.1 `types=search`

`?types=search&source=netease&name=<kw>&count=10&pages=1` → `[{id,name,artist[],album,pic_id,url_id,lyric_id,source}]`。
空数组 → `EEMPTY`；非数组 → `EBADJSON`；`source=kuwo/tencent/migu/kugou` → 直接抛 `EUNSUPPORTED_SOURCE`，**不发出请求**（实测 400/503）。缓存 10min（§9）。

```json
// tests/fixtures/gdstudio-search-qingtian.json —— 实测响应形状
[
  { "id": "186016", "name": "晴天(深情版)", "artist": ["赵乃吉"], "album": "晴天",
    "pic_id": "109951166366503708", "url_id": "186016", "lyric_id": "186016", "source": "netease" },
  { "id": "186016", "name": "晴天", "artist": ["周杰伦"], "album": "叶惠美",
    "pic_id": "109951165957322385", "url_id": "186016", "lyric_id": "186016", "source": "netease" },
  { "id": "1330348068", "name": "晴天", "artist": ["周杰伦"], "album": "叶惠美",
    "pic_id": "109951165957322385", "url_id": "1330348068", "lyric_id": "1330348068", "source": "netease" }
]
```

> ⚠️ **这就是 M-03 的由来**：搜「晴天」首条是翻唱 `晴天(深情版)`。§5 的打分必须把这类候选压到阈值以下。

### 3.2 `types=url`

`?types=url&source=netease&id=<urlId>&br=320` → `{url,br,size,from}`。成功判定：`url` 为非空字符串且以 `http` 开头，否则 `EURLNULL`。字段直映 `ResolvedAudio`，`resolvedAt=Date.now()`，`expiresAt` 见 §6.3。
`url===null` 是**常见且正常**的失败（版权/地区限制）→ 记 `resolve` 失败并跳下一候选，**不重试同源同 id**。

```json
// tests/fixtures/gdstudio-url-ok.json
{ "url": "https://m7.music.126.net/20261015000000/xxxxxxxxxxxxxxxx/xxxx.mp3",
  "br": 320, "size": 9876543, "from": "netease" }
// tests/fixtures/gdstudio-url-null.json —— 版权/不可用
{ "url": null, "br": 320, "size": 0, "from": "netease" }
```

### 3.3 `types=lyric` / 3.4 `types=pic` / 3.5 `types=playlist`

| endpoint | 请求 | 响应与解析 | 错误处理 | 缓存 |
|---|---|---|---|---|
| `lyric` | `?types=lyric&source=netease&id=<lyricId>` | `{lyric:"[mm:ss.xx] 文本\n"}`（注意时间戳后有一个空格，LRC 实测形状如此）。归一化：`lrc.replace(/^\[(\d{2}):(\d{2})\.(\d{2})\]\s?/gm, '[$1:$2.$3]')` | `lyric` 空 → 返回 `{lrc:''}`，**不抛错**（无歌词可接受） | 24h |
| `pic` | `?types=pic&source=netease&id=<picId>&size=300` | `{url}` | `picId` 空 → 返回 `{url:null}`，不发请求 | 24h |
| `playlist` | `?types=playlist&source=netease&id=<id>`（样例 `3778678`） | `{code,playlist:{...}}`；`code≠0` → `EEMPTY`。曲目数组双兼容 `playlist.tracks` / `playlist.songs` | 失败**不阻塞主链路**：playlist 是选曲增强，回落 `playlists.json` 静态曲目池 | 30min |

`playlist` 三个用途：① `playlists.json` 档位对应歌单；② 大脑降级时模板播报选曲（总览 §5.2）；③ 兜底选曲种子。

---

## 4. 多源降级链

### 4.1 源可用性矩阵

| source | 实测 | 默认链 | 说明 |
|---|---|---|---|
| `netease` | ✅ | **第 1 位** | 曲库最全；**唯一能返回可播放直链的源** |
| `joox` | ✅ 部分 | **第 2 位** | `search`/`lyric`/`pic`/`playlist` 均可用，但 **`types=url` 不返回可播放直链** —— 故它只能作**元数据/歌词**的二级来源，**不能**作播放替补 |
| `kuwo` / `tencent` / `migu` / `kugou` | ❌ 400/400/400/503 | ❌ **不纳入** | 仅当 `MUSIC_ENABLE_EXPERIMENTAL=1` 才追加到链尾（调试用），失败立即跳过 |
| 网易官方 `music.163.com` 直连 | ❌ 返回 null | ❌ 永不用 | 已实测不可用，不写进任何链 |
| 本地兜底音频 | ✅ | **终链** | `data/fallback-audio/`，§8 |

> ⚠️ **必须正视的结论：`song_url` 是单点。**
> 实测 `types=url` 只有 `netease` 能返回可播放直链（已用 `Range: bytes=0-2047` 取回真实
> MP3 头验证，`206` + `MP3 头有效`）。`joox` 的 `url` 请求返回 200 但**无 `url` 字段**。
> 因此「多源降级链」**保护不了播放能力** —— 当 netease 整体失效时，曲目解析必然全部失败，
> 电台只剩 §8 的本地兜底音频。这不是实现缺陷，是当前公共实例能力的客观边界，
> 已登记为 [风险登记册](11-risk-register.md) 的 **R-01**。
>
> **由此推导出的两条强制设计**：
> ① `data/fallback-audio/` 不是「可选优化」，而是**唯一的最终保障**，必须真的准备 ≥5 首（[准备清单](09-requirements-checklist.md) §4）。
> ② 若要真正的播放冗余，只能**自建 `NeteaseCloudMusicApi` 实例**作为 `MusicProvider` 的第二个实现（适配器位已预留）。`joox` 替代不了它。

### 4.1.1 请求节流（**必需，实测踩坑**）

实测该公共实例**对突发请求没有容忍度**：连续快速请求时，同一 URL 的三次结果可能是
`200 / 503 / 503`；静置 45 秒后单发即恢复 `200`。这不是实例故障，是限流。

因此以下三条是**硬约束**，不是优化项：

| 约束 | 值 | 违反后果 |
|---|---|---|
| 请求最小间隔 | `MUSIC_MIN_INTERVAL_MS=1200` | 突发即 503，被误判为「歌不存在」而白白降级 |
| 解析并发 | `MUSIC_RESOLVE_CONCURRENCY=1`（**串行**） | 提到并发 3 会立刻触发 503（本文档早期设计的「并发 3」是错的，已修正为 1） |
| 5xx/429 退避重试 | `MUSIC_RETRY_MAX=4`，基数 `1200ms` 指数退避 + 抖动 | 单次 503 被当成终态，导致本可解析的曲目被丢弃 |

**为什么退避重试是功能性的而非容错性的**：若不做重试，一次偶发 503 会让该曲目
被判定为「不可播放」而跳过；连续几次就会把整个 `play[]` 清空，降级到兜底音频。
重试把「限流」与「真的没有」区分开——**这是正确性问题**。

```bash
MUSIC_SOURCES=netease,joox          # 默认降级链（按序）
MUSIC_ENABLE_EXPERIMENTAL=0         # =1 时把 kuwo/tencent/migu/kugou 追加链尾
MUSIC_BASE_URL=https://music-api.gdstudio.xyz/api.php
MUSIC_BR=320                        # 999=flac；joox 可能不支持，失败自动回落 320
MUSIC_TIMEOUT_MS=4000
MUSIC_MIN_INTERVAL_MS=1200          # ★ 请求最小间隔，见 §4.1.1（必需）
MUSIC_RETRY_MAX=4                   # ★ 5xx/429 退避重试次数（必需）
MUSIC_RETRY_BACKOFF_MS=1200         # ★ 退避基数，指数增长 + 抖动
MUSIC_RESOLVE_CONCURRENCY=1         # ★ 必须为 1（串行），见 §4.1.1
```

### 4.2 降级链执行

```
resolveChain(query)                          # query = "艺人 - 曲名"
  for source of MUSIC_SOURCES:               # netease → joox
      cands = provider.search(query, {limit:10, source}) |> dedupe(bySource='search')
      if empty → continue
      scored = score(cands, query)                                  # §5
      for c of scored where s > THRESH_ACCEPT: try resolve → return  # 首轮阈值 0.62
      for c of scored where s > THRESH_RELAX:  try resolve → return  # 放宽后 0.45
  return null                                  # → §8 兜底
```

**去重与「同名不同源」判定**：

| 层级 | 键 | 说明 |
|---|---|---|
| 同源精确去重 | `${source}:${urlId \|\| id}` | 实测同一首歌会出现多条（不同 `id` 指向同一 `url_id`），必须去重，否则浪费 resolve 调用 |
| 跨源同名判定 | `norm(name) + '|' + norm(artist[0])` | 归一化：小写、全角转半角（NFKC）、去空格、去括号内容、去 `feat./ft.` 后缀 |
| 完全相同 | 视为同一首，**保留链序更靠前的源**（netease > joox） | |
| 相似 | `levenshtein/max(len) ≤ 0.12` 且 `artist[0]` 相同 → 同一首；保留**无噪声标记**的那条 | |
| 不同艺人同曲名 | **不合并**（可能是翻唱），交 §5 打分降权 | 避免把翻唱误当原唱 |

```js
const norm = (s = '') => s.normalize('NFKC').toLowerCase()
  .replace(/\([^)]*\)|（[^）]*）|\[[^\]]*\]/g, '')          // 去括号内容
  .replace(/\b(feat|ft|with)\.?\s.+$/g, '')
  .replace(/[\s\-_·、,，.。/]/g, '').trim();
const sameSong = (a, b) =>
  norm(a.name) === norm(b.name) && norm(a.artist?.[0] ?? '') === norm(b.artist?.[0] ?? '');
```

---

## 5. `"艺人 - 曲名"` → `Track` 匹配算法

这是全链路**最容易出错**的一环。目标不是「搜到东西」，而是「搜到**对的那一首**」。

### 5.1 第一步：字符串切分

```js
const SEPARATORS = [
  /\s+[-–—]\s+/,   // " - " / " – " / " — "（最标准）
  /\s+[-–—]/,      // "周杰伦 -晴天"
  /[-–—]\s+/,      // "周杰伦- 晴天"
  /\s*[·•|]\s*/,   // "周杰伦·晴天"
];
function parsePlayString(s) {
  s = String(s).trim();
  for (const re of SEPARATORS) {
    const m = s.split(re);
    if (m.length === 2 && m[0].trim() && m[1].trim())
      return { artist: m[0].trim(), title: m[1].replace(/[》】]/g, '').trim() };
  }
  return { artist: null, title: s };      // 纯曲名 / 无法切分 → 整串搜
}
```

| 输入 | `artist` | `title` |
|---|---|---|
| `李志 - 下雨` / `陈粒 – 小半` / `Coldplay — Yellow` | `李志` / `陈粒` / `Coldplay` | `下雨` / `小半` / `Yellow` |
| `周杰伦-晴天` | `周杰伦` | `晴天` |
| `李志 - 下雨 (Live)` | `李志` | `下雨 (Live)`（噪声标记留给打分，切分阶段不剥） |
| `小半` | `null` | `小半` |
| `Jay-Z - 99 Problems` | `Jay-Z` | `99 Problems` |

> ⚠️ **所有切分正则都要求连字符至少一侧有空白**，否则 `Jay-Z`、`Lo-Fi`、`R&B` 会被切坏（把 `Jay` 当艺人）。本项目踩过的坑，务必保留。

### 5.2 第二步：搜索策略

| 策略 | 查询串 | 何时使用 |
|---|---|---|
| S1 精确 | `${artist} ${title}` | 默认 |
| S2 仅曲名 | `${title}` | S1 返回空 |
| S3 去括号曲名 | `norm(title)` | S2 结果全是噪声（live/remix/翻唱） |
| S4 艺人 + 曲名首词 | `${artist} ${title.split(' ')[0]}` | 曲名 >12 字或含特殊符号 |
| S5 整串 | 原始 play 字符串 | 切分失败（`artist===null`） |

每次 `count=10`，多策略串行；**首个产生「至少 1 个 ≥ 接受阈值」的策略立即停止**，否则继续，最后把各策略结果并集打分（去重后）。

### 5.3 候选打分公式

```
score = 0.45*simTitle + 0.35*simArtist + 0.05*aliasHit + 0.05*durScore + 0.10*popScore
      + exactBonus(0.10) − coverPenalty(0.25) − Σ noisePenalty   → clamp(-1, 1)
```

| 项 | 权重 | 计算 |
|---|---|---|
| `simTitle` | **0.45** | `1 - lev(norm(title), norm(cand.name)) / max(len)`；完全相等=1；一方含另一方=`0.85×长度比` |
| `simArtist` | **0.35** | 候选 `artist[]` 任一归一化相等→1.0；前缀/包含→0.6；否则 0。**目标 `artist===null` 时本项权重并入 `simTitle`（→0.80）** |
| `aliasHit` | **0.05** | 命中 `playlists.json`/`taste.md` 的别名（`周董`→`周杰伦`）→1，否则 0 |
| `durScore` | **0.05** | play 串带时长（`(3:45)`）时：差 ≤5s→1.0，≤15s→0.5；无时长信息→0（**中性**，不影响排名） |
| `popScore` | **0.10** | 搜索结果**位置分** `1 - index/limit`（首条 1.0，第 10 条 0.1）。实测 API 按热度排序，位置是有效弱信号 |
| `exactBonus` | **+0.10** | `norm(title)===norm(cand.name)` 且艺人完全相等 → 把「正主」顶到翻唱之上 |
| `coverPenalty` | **−0.25** | 候选 `artist[0]` 与目标艺人不匹配且候选名 = 目标名 → 判定翻唱 |

权重和恒为 **1.00**（`artist===null` 时为 0.80+0.05+0.05+0.10），保证分数可比、阈值可解释。

### 5.4 噪声关键词黑名单

```js
/** [正则, 罚分]；多项命中也最多累计到 NOISE_PENALTY_CAP */
const NOISE = [
  [/\b(live|现场|演唱会|concert|unplugged)\b/i,                     0.20],
  [/\b(remix|rmx|dj版|混音|重混|bootleg|mashup)\b/i,                0.25],
  [/\b(cover|翻唱|翻自|致敬|模仿|山寨|女声版|男声版|童声版)\b/i,       0.30],
  [/\b(instrumental|伴奏|off\s*vocal|karaoke|纯音乐|无人声|消音)\b/i, 0.35],
  [/\b(piano|钢琴版|吉他版|古筝|八音盒|竖琴|music\s*box|lullaby)\b/i, 0.25],
  [/\b(slowed|加速版|减速版|sped\s*up|nightcore|0\.8x|1\.2x)\b/i,    0.30],
  [/\b(片段|demo|试听|铃声|ringtone|cut|剪辑|拼盘|串烧|medley)\b/i,   0.30],
  [/\b(深情版|伤感版|治愈版|烟嗓版|抖音|网红|车载|3d|环绕)\b/i,        0.30],
  [/\b(电台版|广播剧|有声书|相声|小品|鬼畜|恶搞)\b/i,                 0.40],
  [/\b(acoustic|不插电|民谣版)\b/i,                                  0.10],  // 可接受，轻微降权
  [/\b(remaster(ed)?|重制|高清修复|hi-?res)\b/i,                     0.05],
];
const NOISE_PENALTY_CAP = 0.60;   // 避免「一个词就判死刑」
```

**阈值标定用例**（目标 `周杰伦 - 晴天`，写进 §10 fixture 测试）：

| 候选 | 命中 | 推演 | 判定 |
|---|---|---|---|
| `周杰伦 - 晴天`（index=1） | 无 | `0.45 + 0.35 + 0.10×0.9 + 0.10 ≈ 0.99` | ✅ 接受 |
| `赵乃吉 - 晴天(深情版)`（index=0，实测首条） | `深情版` 0.30 + cover 0.25 | `0.45×1 + 0 + 0.10 − 0.55 ≈ 0.00` | ❌ 拒绝 |
| `周杰伦 - 晴天 (Live)` | `live` 0.20 | `≈ 0.79` | ✅ 接受，排在录音室版之后 |
| `群星 - 晴天(翻唱合集)` | `翻唱` 0.30 + cover 0.25 | `0.45×0.85 − 0.55 + 0.10 ≈ −0.07` | ❌ 拒绝 |
| `周杰伦 - 晴天（伴奏）` | `伴奏` 0.35 | `≈ 0.64` | ❌ 拒绝（阈值判定用**严格大于** 0.62） |

> 噪声罚分与阈值必须**联合标定**，上表就是标定基准。

### 5.5 阈值与回退

| 常量 | 值 | 含义 |
|---|---|---|
| `THRESH_ACCEPT` | **0.62** | 首轮接受（严格大于） |
| `THRESH_RELAX` | **0.45** | 首轮全失败后放宽 |
| `THRESH_HARD_FLOOR` | **0.30** | 绝对下限：低于此**宁可不放**，直接走兜底（**放错歌比不放更伤体验**） |
| `TOPK` | 3 | 只对分数最高的 3 个候选尝试 resolve（控请求量） |

```
best ≥ 0.62                → 用 best
0.45 ≤ best < 0.62         → 换 S3/S4 重搜一次；新 best 仍 < 0.62 则用之（标 lowConfidence 并告警）
0.30 ≤ best < 0.45         → 用之，reason 标注「低置信匹配」，**不写入长期品味记忆**
best < 0.30                → 放弃该 play 项，标 reason='no_confident_match'
```

失败项**不阻塞**：`play[]` 有 2~3 首，允许部分失败，保底 ≥1 首（§7）。

---

## 6. 直链生命周期

### 6.1 为什么会过期

实测 `types=url` 返回的 CDN URL 形如 `https://m7.music.126.net/20261015000000/xxxx/xxxx.mp3`——**路径里嵌了时间戳**，是签名/时效地址。播放中一旦过期，`<audio>` 会抛 `MEDIA_ERR_NETWORK` 或静默停住。

### 6.2 预解析时机

| 时机 | 动作 | 对应总览 |
|---|---|---|
| `compute()` 第 ⑦ 步 | 对 `play[]` **串行**解析（逐首 await；禁止 `Promise.all`，见 §4.1.1） | §4.1 ⑦ |
| 曲目播放中 | 剩余 **30s** 时检查 `expiresAt`，必要时提前重解析下一首 | 与 `prefetch` 10s 窗口配合（[TTS](04-tts-pipeline.md) §7.1） |
| `GET /api/next` | 队列中存在 `expiresAt - now < 60s` 的条目 → 后台重解析，**接口本身不等待** | [接口契约](03-api-contract.md) |
| 冷启动恢复 | 从 DB 恢复的队列**全部视为过期**，用 `TrackRef` 重新解析 | N-06 |

### 6.3 过期检测与 TTL

```js
const URL_TTL_MS = Number(process.env.MUSIC_URL_TTL_MS ?? 20 * 60 * 1000);  // 保守 20min
const RENEW_WINDOW_MS = 30_000;                                            // 剩余 <30s 即需刷新
const isStale = (a) => !a || Date.now() > a.expiresAt - RENEW_WINDOW_MS;
```

| 检测 | 手段 |
|---|---|
| 播放前 | `isStale(audio)` → 重解析。**不做 HTTP HEAD 探测**（不可靠且会被 CDN 缓存误导） |
| 播放中 | 前端 `<audio>` 的 `error` 事件 → 上报 `{type:'playback-error', index}` → 服务端重解析该 index 推新 URL，前端重设 `src` 并 seek 回 `currentTime` |
| 重解析上限 | 同一 index 最多 **2 次**；仍失败 → 跳过该曲并告警（不允许无限重试打爆 API） |
| 队列全体过期 | 全部重解析失败 → §8 兜底音频 |

### 6.4 `resolveCache` TTL 设计

| 缓存 | 键 | TTL | 存储 | 理由 |
|---|---|---|---|---|
| `resolve` 结果 | `resolve:${source}:${urlId}:${br}` | **`URL_TTL_MS`（20min）**，进程重启即失效（`url` 置空保留 `TrackRef`） | SQLite `cache` 表 | 直链有时效，须跨一次播放会话有效但不可长期留存 |
| `search` | `search:${source}:${sha1(query+limit)}` | **10min** | 内存 LRU（200 条） | 同一会话内大脑可能重搜同一关键词 |
| `playlist` | `playlist:${source}:${id}` | **30min** | 内存 LRU（20 条） | 歌单变动不频繁 |
| `lyric` | `lyric:${source}:${lyricId}` | **24h** | 内存 LRU（300 条） | 歌词基本不变 |
| `cover` | `cover:${source}:${picId}:${size}` | **24h** | 内存 LRU（300 条） | 同上 |
| 负结果 | `resolve-negative:${source}:${urlId}` | **5min** | 内存 LRU（200 条） | ⚠️ **必须缓存 `url=null`**：实测失败常见且稳定，不缓存会反复请求同一失败 id |

**硬规则**：`resolve` 缓存**永不作为长期资产**——TTL 内可复用，但任何重新进入播放路径的动作都必须重过 `isStale()`。

---

## 7. 队列解析（施工图的「ncm 解析 queue」）

```
输入：DjAction.play = ["李志 - 下雨", "陈粒 - 小半", "周杰伦 - 晴天 (Live)"]   // 0..N
输出：queue = [ { index, track, audio, reason, matchScore, lowConfidence, fromPlay } ]  // 保底 ≥1
```

```js
async function resolveQueue(playList, { reason, recentPlays24h, force = false, limit = 3 } = {}) {
  const raw = (playList ?? []).slice(0, limit);          // 最多 3 首，控请求量
  // 1) 与最近 24h plays 去重（F-05）
  const fresh = force ? raw : raw.filter(p => !recentPlays24h.some(r => sameSong(parsePlayString(p), r)));
  // 2) 串行解析（逐首 await，单首失败不影响其它；禁止并发，见 §4.1.1）
  const settled = await Promise.allSettled(fresh.map(p => matchAndResolve(p, { reason })));   // §4.2+§5
  let queue = settled.map((s, i) => s.status === 'fulfilled' && s.value
      ? { index: i, ...s.value, reason, fromPlay: fresh[i], lowConfidence: s.value.score < THRESH_ACCEPT }
      : null).filter(Boolean);
  queue = dedupeQueue(queue);                            // 3) 队列内去重，保留首个 sameSong
  if (queue.length === 0) {                              // 4) 保底 ≥1 首
    const fb = await pickFallbackAudio();
    queue = [{ index: 0, track: fb.track, audio: fb.audio, reason: reason + ' | fallback', fallback: true }];
    logger.warn({ evt: 'queue.fallback', playList: raw });
  }
  if (queue.length < Math.max(1, Math.ceil(raw.length * 0.5)))                            // 5) 缺口告警
    logger.warn({ evt: 'queue.shortfall', want: raw.length, got: queue.length });
  return queue;
}
```

| 规则 | 实现 |
|---|---|
| 解析方式 | **串行**逐首 await + 全局最小间隔节流。**不要**用 `Promise.all`——总览 §5.3 说音乐可比子进程放宽，但实测该实例对突发零容忍，故收紧为串行（§4.1.1） |
| 失败跳过 | 单首失败仅从 queue 移除，`reason` 追加 `\| dropped:<playString>`，供 `/api/plan/today` 可见（F-07） |
| `reason` 透传 | 每个 queue 项带**同一个** `action.reason`（大脑给的选曲理由）+ 各自 `matchScore`；`reason` **不进 TTS**（[接口契约](03-api-contract.md#dj-action-v1)） |
| 24h 去重 | 用归一化 `sameSong` 而非字符串相等——`"周杰伦 - 晴天"` 与 `"周杰伦-晴天"` 必须视为同一首 |
| 去重例外 | 用户明确要求重复（`再放一遍`/`就听这首`/单曲循环，由 router 判定）→ `force=true`（F-05 括注） |
| `play` 为空 | 纯口播场景**不触发兜底**，播完 `say` 回 `IDLE`（总览 §6.1） |

```json
// queue 项（/api/next 与 WS 下发形状）
{ "index": 0,
  "track": { "provider":"gdstudio","source":"netease","id":"1330348068","urlId":"1330348068",
             "name":"晴天","artist":["周杰伦"],"album":"叶惠美",
             "picId":"109951165957322385","lyricId":"1330348068" },
  "audio": { "url":"https://m7.music.126.net/2026.../x.mp3","br":320,"size":9876543,
             "from":"netease","resolvedAt":1776000000000,"expiresAt":1776001200000 },
  "reason":"用户提到下雨且想要安静，匹配 mood-rules 的雨天-低能量档",
  "matchScore":0.99, "lowConfidence":false, "fromPlay":"周杰伦 - 晴天" }
```

---

## 8. 降级与兜底

| 触发条件 | 说明 |
|---|---|
| 全链 search 为空 / 全链 resolve 全失败（`url=null`、超时、400/503） | 兜底 |
| 所有候选打分 < `THRESH_HARD_FLOOR`（0.30） | 兜底（放错歌比不放更伤体验） |
| `MUSIC_OFFLINE=1`（用户手动断网模式）或出网整体不可用 | 兜底（总览 §3.1 关键原则） |

对应状态机 `FALLBACK_AUDIO`（总览 §8.1），**必须能自行回到 `IDLE`**。

```
data/fallback-audio/
├─ manifest.json          # 由脚本生成 [{file,title,artist,bytes,durationMs,sha1,addedAt}]
├─ 01-rainy-night.mp3
└─ ...
```

| 约定 | 规则 |
|---|---|
| 格式 | `mp3` / `wav` / `m4a`（`<audio>` 直连播放，服务端只做静态托管 + Range） |
| 数量 | 建议 5~20 首；少于 3 首启动告警（随机性太差） |
| 版权 | **只放用户自备的无版权/自有音频**；`.gitignore` 排除实际音频，只提交 `manifest.json` 与 README |
| 时长 | 建议 2~5 分钟（太短频繁切换，太长像卡住） |
| 位置 | 固定 `data/fallback-audio/` |

**`scripts/fetch-fallback-audio`（不代下版权音乐，只引导 + 校验 + 生成清单）**：

```
node scripts/fetch-fallback-audio.mjs --check                    # 校验现有目录，刷新 manifest.json
node scripts/fetch-fallback-audio.mjs --url <直链> --title "..." --artist "..."   # 用户自备直链时落盘
node scripts/fetch-fallback-audio.mjs --print-sources            # 仅打印推荐 CC0/公有领域素材站，不自动下载
步骤：1 确保目录存在；2 扫描 *.mp3|*.wav|*.m4a
     3 逐个文件：读文件头识别真实格式（不信任扩展名：ID3/0xFFFB、RIFF/WAVE、ftyp/m4a）→
       用 §TTS 8.2 同款公式估算 durationMs → 计算 sha1 去重（重复告警跳过）→ 体积 >30MB 告警
     4 原子写 manifest.json；文件数为 0 → 退出码 1 并打印准备指引
     5 --url 模式仅当用户显式传入地址时下载，并在 stdout 提示「请自行确认授权允许本地留存与播放」
```

**随机选择策略**：

```js
async function pickFallbackAudio({ mood, slot } = {}) {
  const list = await loadManifest();
  if (!list.length) throw new ProviderError('EEMPTY', { dir: 'data/fallback-audio' });
  const recent = new Set((await state.recentPlays({ limit: 10, kind: 'fallback' })).map(r => r.file));
  const tagged = list.filter(a => !recent.has(a.file) && tagMatch(a, mood, slot));   // 1) 新鲜 + 标签匹配
  const fresh  = list.filter(a => !recent.has(a.file));                              // 2) 仅新鲜
  const pool = tagged.length ? tagged : fresh.length ? fresh
             : list.slice().sort((a, b) => a.lastPlayedAt - b.lastPlayedAt);         // 3) LRU 而非纯随机
  return pool[Math.floor(Math.random() * pool.length)];                              // 池内随机
}
```

标签用文件名前缀约定：`calm-` `rain-` `morning-` `night-` `focus-`，配合 `mood-rules.md`（可选增强）。

---

## 9. 缓存

### 9.1 SQLite 还是内存 Map

**结论：混合。`resolve` 用 SQLite（`state.db` 的 `cache` 表），其余四个用内存 LRU Map。**

| 维度 | 内存 Map | SQLite | 取舍 |
|---|---|---|---|
| 重启后存活 | ❌ | ✅ | `resolve` 需要（N-06：冷启动后要判断上次直链还能不能用） |
| 读写延迟 | ~0.001ms | ~0.05~0.5ms（`better-sqlite3` 同步） | 都远低于 M-02 的 1.5s 预算 |
| 容量压力 | 占常驻内存（N-03 ≤300MB） | 落盘 | `search`/`lyric`/`cover` 体积大价值低 → 内存 + 硬上限 |
| 时效语义 | 随进程消失 | 需显式 TTL 清理 | `resolve` 的 20min TTL 必须显式实现（清理 tick 见 [调度与节律](07-scheduler-rhythm.md) §3.5） |

```sql
-- 追加到 state.db（主 DDL 见 [接口契约](03-api-contract.md#sqlite-ddl)）
CREATE TABLE IF NOT EXISTS cache (
  key        TEXT PRIMARY KEY,     -- 'resolve:netease:1330348068:320'
  kind       TEXT NOT NULL,        -- 'resolve' | 'resolve-negative'
  value      TEXT NOT NULL,        -- JSON: ResolvedAudio | {"null":true}
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cache_expires ON cache(expires_at);
DELETE FROM cache WHERE expires_at < (unixepoch() * 1000);   -- 每 10min，与 TTS LRU 共用 tick
```

**合规再确认**：只缓存直链 URL 字符串（≤20min TTL）、元数据、歌词 LRC（24h 内存）；**音频字节流永不落盘**，歌词不做长期归档。

---

## 10. 测试要点

fixture 放 `tests/fixtures/`，内容为**实测返回的真实 JSON 片段**（形状见 §3.1/§3.2）。

| 编号 | 用例 | 断言 |
|---|---|---|
| P-1 | **翻唱必须被过滤**：搜 `周杰伦 - 晴天`，候选含实测首条 `赵乃吉 - 晴天(深情版)` | 选中 `周杰伦 - 晴天`；`赵乃吉` 那条 `score < THRESH_ACCEPT`；命中项 `matchScore > 0.9` |
| P-2 | **伴奏罚分与严格阈值**：候选 `周杰伦 - 晴天（伴奏）` | `score <= 0.64`，**不满足** `score > 0.62` 的接受条件（用严格大于） |
| P-3 | **分隔符切分**：`parsePlayString` 覆盖 §5.1 表全部输入 | `李志 - 下雨`→`{李志,下雨}`；`Jay-Z - 99 Problems`→`{Jay-Z, 99 Problems}`（**不是** `{Jay, Z - 99 Problems}`）；`小半`→`{null,小半}`；`陈粒 – 小半`（en-dash）正确切分 |
| P-4 | **`url=null` 降级**：netease 候选 A 返回 null、候选 B 可解析 | 最终返回 B 的直链；A 的负结果被缓存（5min）；同 id 二次调用**不发起** HTTP（spy `fetch`） |
| P-5 | **多源降级链**：netease 全失败 → joox 命中 | 调用序列 `search(netease)`→`resolve(netease)×n`→`search(joox)`→`resolve(joox)`；结果 `track.source==='joox'`；`MUSIC_SOURCES=netease` 时 joox **不被调用** |
| P-6 | **不纳入不可用源**：`MUSIC_ENABLE_EXPERIMENTAL=0` | `provider.sources` 深等于 `['netease','joox']`；对 `source=kuwo` 抛 `EUNSUPPORTED_SOURCE` 且**零 HTTP 请求** |
| P-7 | **24h 去重（F-05）**：`plays` 含 `周杰伦-晴天`（无空格），`play` 给 `周杰伦 - 晴天`（有空格） | `sameSong` 判为重复并过滤；其余候选照常入队；`force=true` 时**不**过滤 |
| P-8 | **保底 ≥1 首**：3 个 play 项全部 resolve 失败 | `queue.length===1` 且 `queue[0].fallback===true`；音频路径在 `data/fallback-audio/`；日志含 `queue.fallback` |
| P-9 | **直链过期重解析**：把 `expiresAt` 设为 `now-1s` | `isStale()===true`；`resolveQueue` 重新调用 `resolve`；同一 index 重解析 **2 次**后第三次改为跳过并告警 |
| P-10 | **`play` 为空数组**（纯天气播报） | `resolveQueue([])` 返回 `[]`；**不**触发兜底音频；`compute()` 正常走 `SPEAKING` → `IDLE` |
| P-11 | **跨源同名去重**：netease 与 joox 各返回 `周杰伦 - 晴天` | `dedupeQueue` 只保留 1 项且 `source==='netease'`（链序优先） |
| P-12 | **合规断言**：跑完整 `resolveQueue` 后扫描 `data/` | 除 `fallback-audio/` 外**无任何 mp3/wav/m4a**；HTTP 层无「下载/导出」路由 |

---

## 附：接口索引

| 交互点 | 对端 | 说明 |
|---|---|---|
| `resolve(play[])` 调用点 | [设计总览](01-architecture-design.md) §5.1 第 ⑦ 步 | 输出 `queue` 供 `assemble()` 与 WS 推送 |
| 直链与 `segue` 同时触发 | [TTS 声音管线](04-tts-pipeline.md) §7.1 | 剩余 10s 同时合成 segue 与刷新下一首直链 |
| `playlist` 作为大脑降级选曲 | [设计总览](01-architecture-design.md) §5.2 | 大脑失败时按 `playlists.json` 档位选曲 |
| 兜底音频准备 | [需求与准备清单](09-requirements-checklist.md) | 用户自备无版权音频的清单项 |
| `cache` 表清理 tick | [调度与节律](07-scheduler-rhythm.md) §3.5 | 与 TTS LRU 共用每 10min 心跳 |

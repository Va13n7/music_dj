# Claudiao 个人音乐电台 · TTS 声音管线

> 文档版本 v1.0 · 状态：设计完成，待实现
> 上游依据：[设计总览](01-architecture-design.md) §3.2 / §4.1 / §5.2 / §7 D-03 D-07 / §9
> 关联文档：[接口契约](03-api-contract.md) · [大脑适配器](05-brain-adapter.md) · [调度与节律](07-scheduler-rhythm.md) · [前端 PWA](08-pwa-frontend.md)
> 落地位置：`src/layer2/tts.js` + `src/adapters/tts/{edge-tts.js,sapi.js}`
> 施工图格子：第二层 `TTS.JS`（`Fish Audio → cache/tts/*.mp3 → /tts/<hash>.mp3`）

---

## 1. 目标与约束

把 `DjAction.say`（1~200 字）在本机变成浏览器 `<audio>` 可直接播放的音频，`say` 播完后无缝接上音乐队列（总览 §4.1：`say` **优先**于音乐）。

| 编号 | 目标 | 量化验收 |
|---|---|---|
| T-01 | 零边际成本 | 不调用任何按量计费云 TTS，运行期仅本机合成 |
| T-02 | 离线可用 | 断外网仍能合成（缓存命中 + SAPI 兜底），对应 F-10 |
| T-03 | 隐私不出机 | `say` 文本与音频只存在于 `data/tts-cache/`，音频不出网 |
| T-04 | 缓存复用 | 同 `(voice,rate,pitch,text)` 二次请求命中，P95 < 50ms（N-02） |
| T-05 | 合成延迟 | 未命中 ≤3s/百字（N-02）；实测 edge-tts 一句 26 字 = **3.07s / 30096 字节** |
| T-06 | 永不静音 | 三级降级：edge-tts → SAPI → 跳过语音直接放歌（总览 §5.2） |

| 硬约束（实测环境） | 影响 |
|---|---|
| Windows x64 / Node v22.11.0 / npm 10.9.0（无 pnpm） | 子进程需处理 Windows 路径与 `.exe`；不得依赖 pnpm |
| `edge-tts` 位于 `D:\python\Scripts\edge-tts.exe` | 必须可配置绝对路径，不依赖 PATH |
| SAPI **唯一中文音色** `Microsoft Huihui Desktop`(zh-CN/Female) | 兜底音色不可选，音质机械（总览 Q-02） |
| SAPI `SetOutputToWaveFile` **只能输出 WAV**（实测 76958 字节） | 格式统一问题 → §6 |
| 本机无 7z，ffmpeg 可用性未确认 | 转码只能是探测通过后的增强，不可硬依赖 |
| 单 `<audio>` 串行播放（D-05） | TTS 与音乐互斥；`say` 的 `ended` 是切歌唯一触发点 |

**明确不做**：❌ 不含任何云 TTS（Fish Audio / Azure 在线 / OpenAI TTS）；❌ 不做语音克隆与声纹训练（需云端算力，违反 T-01/T-03）；❌ 不做实时流式 TTS（P2，§7.2）。
⏳ **Fish Audio 仅保留适配器位**：`src/adapters/tts/fish-audio.js` 实现 §2 契约即可接入，`src/layer2/tts.js` 一行不改（N-07）；默认 `TTS_ENGINE=edge-tts`，该文件不加载。

---

## 2. 适配器接口

### 2.1 `TtsAdapter` 契约

```js
/**
 * 实现放 src/adapters/tts/<name>.js。上层不得看见引擎私有概念（进程/参数/容器）。
 * @typedef {Object} TtsAdapter
 * @property {string} name      'edge-tts' | 'sapi' | 'fish-audio'
 * @property {() => Promise<{ok:boolean, reason?:string}>} available
 * @property {() => Promise<Array<{id:string, lang:string, gender:'Female'|'Male'}>>} listVoices
 * @property {(req:TtsRequest) => Promise<TtsResult>} synthesize
 *
 * @typedef {Object} TtsRequest
 * @property {string} text           已预处理（§4）、非空、≤200 字
 * @property {string} voice          必须 ∈ listVoices().map(v=>v.id)
 * @property {string} [rate='+0%']   '-10%' 等；适配器负责翻译为引擎参数
 * @property {string} [pitch='+0Hz']
 * @property {string} [volume='+0%'] 引擎侧音量（不进缓存键）
 * @property {'mp3'|'wav'} [format]  期望容器；适配器可返回更优格式并如实声明 mime
 * @property {AbortSignal} [signal]  取消信号（超时/丢弃 prefetch 时触发）
 *
 * @typedef {Object} TtsResult
 * @property {string} path        绝对路径，位于 data/tts-cache/ 之下（§5.2 已校验）
 * @property {string} mime        'audio/mpeg' | 'audio/wav'
 * @property {number} durationMs  见 §8；est=true 表示估算值，待前端回填校正
 * @property {number} bytes       fs.stat 得出，不信任引擎自报
 * @property {string} engine      实际执行的引擎（降级后可能与 name 不同，用于告警）
 * @property {boolean} est        是否为估算时长
 */
```

### 2.2 两个实现要点对照

| 维度 | `EdgeTtsAdapter`（**首选**） | `SapiAdapter`（**兜底**） |
|---|---|---|
| 文件 | `src/adapters/tts/edge-tts.js` | `src/adapters/tts/sapi.js` |
| 调用 | `spawn('D:\python\Scripts\edge-tts.exe', args)` | `spawn('powershell.exe', ['-NoProfile','-NonInteractive','-Command', script])` |
| 参数 | `--voice <v> --text <t> --rate <r> --pitch <p> --volume <vol> --write-media <out.mp3>` | `.SelectVoice(v)` → `.Rate=<int>` → `.SetOutputToWaveFile(out.wav)` → `.Speak(text)` |
| 文本传递 | argv 有长度/转义风险 → 优先 `--file`/stdin 变体，实现期统一 | **不拼命令行**：文本经 stdin 以 UTF-8 交给 PowerShell，脚本从 `$input` 读，杜绝引号注入 |
| 输出 / 耗时 | mp3，**30096 字节 / 3.07s**（实测，26 字一句） | **只能 WAV**，76958 字节；耗时未逐项实测，量级 0.3~0.6s/百字（无网络往返，通常更快） |
| 音色 | 中文 8 个（§2.3），`--list-voices` 动态拉取 | **中文仅 1 个** `Microsoft Huihui Desktop`；另有 `Microsoft Zira Desktop`(en-US) |
| 音质 / 依赖 | 神经 TTS 自然 / Python 3.12.6 + 上述 `.exe` | 机械、明显合成感（Q-02） / Windows 内置 .NET `System.Speech`，**零安装** |
| 网络 | 需联网；离线时首次合成失败 → 必须降级 | 完全离线 |
| 探测 | `edge-tts --list-voices` 退出码 0 且含 `zh-CN-XiaoxiaoNeural` | `GetInstalledVoices()` 中 zh-CN 计数 ≥1 |
| 超时 / 并发 | 8s（>120 字放宽 12s） / 全局 2（总览 §5.3） | 5s / 1（PowerShell 启动有成本，SAPI 非线程安全） |

### 2.3 中文音色表（实测）

| voice id | 性别/风格 | 建议用途 |
|---|---|---|
| `zh-CN-XiaoxiaoNeural` | 女/温暖 | **默认**：日常、傍晚、夜间 |
| `zh-CN-XiaoyiNeural` | 女/活泼 | `morning` 早间播报 |
| `zh-CN-YunjianNeural` | 男/激情 | 歌单推荐高潮段 |
| `zh-CN-YunxiNeural` | 男/阳光活泼 | 周末 / 好天气 |
| `zh-CN-YunxiaNeural` | 男/可爱 | 轻松曲间衔接 |
| `zh-CN-YunyangNeural` | 男/专业可靠 | `planning` / `hourly-check` / 天气 |
| `zh-CN-liaoning-XiaobeiNeural` | 女/东北口音 | 彩蛋 slot |
| `zh-CN-shaanxi-XiaoniNeural` | 女/陕西口音 | 彩蛋 slot |

> 换音色会改变缓存键（D-07），`bySlot` 分叉越多命中率越低。**默认只分 `morning` 与 `default` 两档**（§9）。
>
> ⚠️ **`bySlot` 的键必须用 [模块详细设计 §6.1](02-module-spec.md) 的权威 slot id**（下划线命名，取自 `routines.md` §二 与 `playlists.json.slotDefaults`），与 `config/routines.yml` 的 `slots[].name` 完全一致：`daily_plan` / `morning` / `hourly_check` / `noon` / `evening` / `night_wind_down` / `calendar_hook` / `prefetch`。本文档 §9 的 `bySlot` 示例即按此表填写；未列出的 slot 落到 `default`。**不要**使用 `planning`、`hourly`、`night` 等别名——它们不是权威 id。

---

## 3. 选择与降级策略

### 3.1 启动探测

```
tts.init()   —— 与 listen(8080) 并行，不阻塞端口；探测完成前的请求按 TTS_ENGINE 直接试，失败即降级
 ├─ 1. existsSync(EDGE_TTS_BIN)? 否 → edge.ok=false, reason='bin-missing'
 ├─ 2. spawn(EDGE_TTS_BIN, ['--list-voices'])，超时 5s
 │      exitCode===0 && stdout 含 'zh-CN-XiaoxiaoNeural' → edge.ok=true 并缓存音色表
 │      否则 → reason='list-voices-failed' | 'no-zh-voice'
 ├─ 3. spawn(powershell, SAPI_PROBE)，超时 5s
 │      Add-Type -AssemblyName System.Speech
 │      $s = New-Object System.Speech.Synthesis.SpeechSynthesizer
 │      $s.GetInstalledVoices() | ? {$_.Enabled} | % {$_.VoiceInfo} |
 │        ? {$_.Culture.Name -eq 'zh-CN'} | measure          # 计数 ≥1 → sapi.ok=true
 └─ 4. 决策：edge.ok → active='edge-tts'
             !edge.ok && sapi.ok  → active='sapi'（启动即告警，不阻塞电台）
             !edge.ok && !sapi.ok → active=null（直接走 §3.3 第 3 级）
```

结果写 `data/tts-status.json`，经 `/api/now` 的 `health.tts` 暴露（`activeEngine` / `breakerOpen` / `cacheItems`，见 [接口契约](03-api-contract.md)）。

### 3.2 运行期失败与回切

```
synthesize(text)
 ├─ 熔断打开（§3.3）→ 直接走 SAPI
 ├─ 尝试 active 引擎
 │    成功 → 计数清零；若 active≠edge 且冷却已过 → 触发一次轻量回切探测
 │    失败（非零退出 / 超时 / 空文件 / <1KB）
 │         ├─ active==='edge' && sapi.ok → **同一请求内**立即回落 SAPI（用户无感）
 │         └─ 两者皆失败 → 抛 TtsUnavailable → 上层进 MUSIC_ONLY（总览 §8.1）
 └─ 结果落盘 + 更新缓存索引
```

**回切**：冷却期结束后的首次请求先合成固定短文本 `"测试"`（大概率命中缓存，成本≈0）作探测，成功即回切 edge 并清零熔断——避免网络恢复后永远卡在机械音。

### 3.3 熔断参数与三级降级

| 参数 | 默认 | 配置项 |
|---|---|---|
| 连续失败阈值 N | 3（成功一次即清零） | `TTS_BREAKER_FAILS` |
| 熔断保持 | 120s，期间直接走 SAPI | `TTS_BREAKER_COOLDOWN_MS` |
| 退避 | ×2，上限 30min（120s → 240s → 480s → …） | `breaker.maxCooldownMs` |
| 单次合成超时 | 8s（>120 字 12s），超时按失败并 `kill()` | `TTS_TIMEOUT_MS` |
| 探测间隔下限 | 60s（防探测风暴） | — |

| 级别 | 动作 | 结果状态 | 日志 |
|---|---|---|---|
| 1 | edge-tts 合成 | `SPEAKING` | info |
| 2 | SAPI 合成（WAV，mime 变 `audio/wav`） | `SPEAKING` | warn |
| 3 | 跳过语音，直接播 music queue | `MUSIC_ONLY` | error（只记 `say` 长度与 hash，**不记全文**，总览 §9） |

第 3 级**不是失败**：电台「一直在响」优先于「一定说话」（D-08）。与 [接口契约](03-api-contract.md) 的 `E_TTS_SAPI_FAIL` 一致——两者皆失败才报该码，单 SAPI 成功不算错误。

---

## 4. 文本预处理

纯函数，必须有单测（§10）。`say` 是自然语言，直接送 TTS 会读出 Markdown 符号、把 `07:00` 读成「零七冒号零零」。

| # | 规则 | 输入 → 输出 | 位置 |
|---|---|---|---|
| R1 | 剥离 Markdown | `**重点**`→`重点`；`` `code` ``→`code`；`## 标题`→`标题` | §4.1 |
| R2 | 剥离链接 / URL | `[点这里](https://a.b/c)`→`点这里`；裸 URL→删除 | §4.1 |
| R3 | 时间读法 | `07:00`→`早上七点`；`21:30`→`晚上九点半`；`9:05`→`早上九点零五分` | §4.2 |
| R4 | 温度 / 百分比 / 区间 | `18℃`→`十八度`；`-3℃`→`零下三度`；`65%`→`百分之六十五`；`3-5首`→`三到五首` | §4.2 |
| R5 | 序号 / 码率口语化 | `No.1`→`第一名`；`320kbps`→`高音质`；`FLAC`→`无损` | §4.2 |
| R6 | 英文缩写 | `DJ`→`D J`；`OK`→`好的`；`R&B`→`节奏布鲁斯`；`feat.`→`合作` | §4.2 |
| R7 | 标点规范化 | `……`/`...`→`。`；`——`→`，`；`~`→`。`；中文间半角 `,`→`，` | §4.3 |
| R8 | 分句（停顿） | 按强标点切分并合并为 40~80 字段落 | §4.4 |
| R9 | 空白清理 | 多空格 / 换行 / Tab → 单空格 | §4.1 |
| R10 | 限长 200 字 | 260 字 → 截断到最近句末（≤200 字）并告警 | §4.5 |
| R11 | 空串兜底 | 全被剥离后为 `""` → 返回 `null`，跳过 TTS | §4.5 |

**执行顺序**：先 `clamp200`（防后续替换把文本撑长）→ R1~R9 → R11。

### 4.1 R1 / R2 / R9

```js
const RULES = [
  [/\*\*(.+?)\*\*/gs, '$1'],                                  // 粗体
  [/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/gs, '$1'],            // 斜体
  [/`{1,3}([^`]+)`{1,3}/g, '$1'],
  [/^#{1,6}\s*/gm, ''], [/^\s*[-*+]\s+/gm, ''], [/^\s*>\s?/gm, ''],
  [/\[([^\]]+)\]\((?:https?:\/\/|\/)[^)]+\)/g, '$1'],         // R2 链接保留文字
  [/https?:\/\/\S+/g, ''], [/\bwww\.\S+/g, ''],               // R2 裸 URL 删除
  [/\s+/g, ' '],                                              // R9 空白
];
```

### 4.2 R3~R6 数值与缩写

```js
const CN = ['零','一','二','三','四','五','六','七','八','九'];
const cnNum = (n) => n < 10 ? CN[n]
  : n < 20 ? '十' + (n % 10 ? CN[n % 10] : '')
  : CN[(n / 10) | 0] + '十' + (n % 10 ? CN[n % 10] : '');          // 0..59

const HH_PREFIX = { 0:'凌晨', 5:'早上', 8:'上午', 11:'中午', 13:'下午', 18:'晚上', 23:'深夜' };
const prefixOf = (h) => HH_PREFIX[Math.max(...Object.keys(HH_PREFIX).filter(k => +k <= h).map(Number))];

// R3  07:00 → 早上七点 ；21:30 → 晚上九点半 ；9:05 → 早上九点零五分
text = text.replace(/\b(\d{1,2}):(\d{2})\b/g, (_, h, m) => {
  const H = +h, M = +m, hh = cnNum(H % 12 === 0 ? 12 : H % 12);      // 12 小时制口语
  return M === 0 ? `${prefixOf(H)}${hh}点`
       : M === 30 ? `${prefixOf(H)}${hh}点半`
       : `${prefixOf(H)}${hh}点${cnNum(M)}分`;
});

// R6  未命中白名单的英文缩写 → 逐字母，字母间插空格
const ABBR = { OK: '好的', 'R&B': '节奏布鲁斯', 'Lo-Fi': '轻音乐', vs: '和', 'feat.': '合作', 'ft.': '合作' };
text = text.replace(/\b[A-Z]{2,5}\b/g, (m) => ABBR[m] ?? m.split('').join(' '));
// 逐字母词：DJ→D J、BGM→B G M，EP/OST/LIVE/AI/TTS/UPnP 同理
```

| 类别 | 正则 | 替换 | 备注 |
|---|---|---|---|
| 温度 | `(-?\d+(?:\.\d+)?)\s*℃\|°C` | `$1度`（负号→`零下`） | 小数读「点五」 |
| 百分比 | `(\d+)\s*%` | `百分之<汉字数>` | |
| 区间 | `(\d+)\s*[-~—]\s*(\d+)` | `$1到$2`（汉字） | **仅两侧皆数字**，避免误伤 `Jay-Z` |
| 序号 / 时长 | `No\.?\s*(\d+)`、`第(\d+)`、`3'45"` | `第<汉字数>`、`三分四十五秒` | 与 R3 共用 `cnNum` |
| 技术词 | `320kbps` / `flac` / `mp3` | `高音质` / `无损` / `MP3` | 口语化优先于逐字母 |

### 4.3 R7 标点规范化

| 原 | 替换为 | 说明 |
|---|---|---|
| `,` `;` `:`（夹在中文字符之间） | `，` `；` `：` | 正则 `(?<=[\u4e00-\u9fa5]),` |
| `!` `?` | `！` `？` | |
| `……` `...` `。。` | `。` | 省略号无稳定读法 |
| `——` `--` | `，` | 破折号无稳定读法 |
| `~` `～` | `。` | 语气词后接停顿 |
| `「」『』""` | 保留 | edge-tts 自然忽略 |
| `()` `（）` | 去括号、保留内容 | |
| `#` `@` `&` `=` 等孤立符号 | 删除 | 仅当不构成数值含义时 |

### 4.4 R8 分句与拼接

实测 26 字 → 3.07s；200 字线性外推 ≈20s+，一次性合成会让首播延迟不可接受。策略：**渐进式合成 + 顺序播放**——① 按强标点（`。！？；`）切句；② 相邻短句合并为 **40~80 字**一段（下限防碎片化，上限控单段 ≈1.5~3s）；③ 段间插停顿标记（`，` 结尾段用 `，`，句末段用 `。`）；④ **第一段合成完即返回开播**，后续段后台继续（预取深度 2）；⑤ 前端按「播报序列」顺序播，段间 gap ≤200ms（音乐衔接阈值 800ms 的 1/4）。

```js
/** @returns {string[]} 朗读分段；总长可能略超 200（含连接标点） */
function splitForSpeech(text, { min = 40, max = 80 } = {}) {
  const sentences = text.split(/(?<=[。！？；])/).map(s => s.trim()).filter(Boolean);
  const out = []; let buf = '';
  for (const s of sentences) {
    if (buf && (buf + s).length > max) { out.push(buf); buf = s; } else buf += s;
    while (buf.length > max) {                        // 单句本身超长 → 在次级标点再切
      const at = buf.lastIndexOf('，', max);
      const cut = at > min ? at + 1 : max;
      out.push(buf.slice(0, cut)); buf = buf.slice(cut);
    }
  }
  if (buf) out.push(buf);
  if (out.length > 1 && out.at(-1).length < min / 2) out.splice(-2, 2, out.at(-2) + out.at(-1)); // 合并短尾
  return out;
}
```

### 4.5 R10 限长 / R11 兜底

```js
function clamp200(text) {
  if (text.length <= 200) return { text, truncated: false };
  const head = text.slice(0, 200);
  const at = Math.max(head.lastIndexOf('。'), head.lastIndexOf('！'), head.lastIndexOf('？'));
  return { truncated: true,                                 // → logger.warn({len, hash8})，不记全文
    text: at >= 120 ? head.slice(0, at + 1) : head.replace(/[，、,;；]$/, '') + '。' };
}
// R11：全部规则跑完后 text.trim()==='' → 返回 null，上层跳过 TTS（第 3 级降级）
```

`DjAction.say` 契约已限 1~200 字（[接口契约](03-api-contract.md#dj-action-v1)），此处是**防御性**兜底（总览 §6.1「超出截断并告警」）。

---

## 5. 缓存设计

### 5.1 键计算与目录

```js
const crypto = require('node:crypto');
/** 缓存键 = sha1(voice|rate|pitch|text) 前 16 位十六进制（总览 §4.1 步骤 ⑧，D-07） */
function cacheKey({ voice, rate = '+0%', pitch = '+0Hz', text }) {
  const basis = [voice, rate, pitch, text].join('|');       // 顺序固定，分隔符不可增删
  return crypto.createHash('sha1').update(basis, 'utf8').digest('hex').slice(0, 16);
}
```

| 字段 | 进键 | 理由 |
|---|---|---|
| `text`（**预处理后**） | ✅ | 预处理规则改变会自然失效旧缓存 |
| `voice` / `rate` / `pitch` | ✅ | D-07：换音色必须失效 |
| `volume` | ❌ | 播放端 `<audio>.volume` 处理，避免缓存碎片化 |
| `engine` | ❌ | 若进键，SAPI 结果会永久占据 edge 的槽位。**改为**：只有 edge 成功才写正式缓存；SAPI 结果写 `sapi-tmp/`（TTL 1h，不计入 LRU 配额），edge 恢复后自动回到高质量音色 |
| `format` | ❌ | 由适配器决定，对外统一按 §6 处理 |

```
data/tts-cache/
├─ <hash>.mp3            # edge-tts 产物，对外 URL /tts/<hash>.mp3
├─ <hash>.wav            # SAPI 产物（edge 不可用时）
├─ <hash>.json           # 旁挂索引 {voice,rate,pitch,bytes,durationMs,est,createdAt,lastHitAt,hits,engine}
├─ index.json            # LRU 索引快照，每 60s 或每 20 次变更落盘
├─ sapi-tmp/<hash>.wav   # 熔断期降级产物，TTL 1h，不计入 LRU 配额
└─ .tmp/                 # 原子写入暂存区（必须与正式目录同卷）
```

`/tts/<hash>.mp3` 路由**严格解析**：只接受 `^[0-9a-f]{16}$`，扩展名白名单 `mp3|wav`；`<hash>.mp3` 不存在但 `<hash>.wav` 存在时回落提供 WAV 并把 `Content-Type` 改为 `audio/wav`（前端无需感知引擎）。

### 5.2 原子写入 + 路径安全

```js
const path = require('node:path'), fs = require('node:fs/promises');
const CACHE_DIR = path.resolve(process.env.DJ_DATA_DIR ?? 'data', 'tts-cache');
const HASH_RE = /^[0-9a-f]{16}$/, EXT_RE = /^(mp3|wav)$/;

/** 任何进入文件系统的字符串都必须先过这里（总览 §9「路径经白名单校验」） */
function safeCachePath(hash, ext) {
  if (!HASH_RE.test(hash)) throw new Err('EBADHASH', { hash });
  if (!EXT_RE.test(ext))   throw new Err('EBADEXT',  { ext });
  const abs = path.resolve(path.join(CACHE_DIR, `${hash}.${ext}`));
  if (!abs.startsWith(CACHE_DIR + path.sep)) throw new Err('EPATHESCAPE', { abs });  // 防 ../ 与符号链接逃逸
  return abs;
}

/** 原子合成：先写 .tmp 再 rename，杜绝半截文件被 /tts 路由读到 */
async function synthesizeAtomic(adapter, req, hash, ext) {
  const finalPath = safeCachePath(hash, ext);
  if (await exists(finalPath) && await exists(sibling(hash, 'json'))) return readMeta(hash);
  const tmpPath = path.join(CACHE_DIR, '.tmp', `${hash}.${process.pid}.${Date.now()}.${ext}`);
  await fs.mkdir(path.dirname(tmpPath), { recursive: true });
  try {
    const r = await adapter.synthesize({ ...req, path: tmpPath, signal: AbortSignal.timeout(timeoutFor(req.text)) });
    const st = await fs.stat(tmpPath);                       // 不信任引擎自报 bytes
    if (st.size < 1024) throw new Err('ETOOSHORT', { size: st.size });
    await fs.rename(tmpPath, finalPath);                     // ★ 同卷 rename 原子
    const meta = { ...r, bytes: st.size, hash, ext };
    await writeJsonAtomic(sibling(hash, 'json'), meta);       // index.json 同走此函数
    return meta;
  } catch (e) {
    await fs.rm(tmpPath, { force: true });                   // 失败必清理，防 .tmp 泄漏
    throw e;
  }
}
```

### 5.3 并发去重（single-flight）

```js
const inflight = new Map();                                  // hash → Promise<meta>
function synth(text, opts) {
  const key = cacheKey({ ...opts, text });
  if (inflight.has(key)) return inflight.get(key);            // ★ 同一 hash 合并为一次合成
  const p = (async () => {
    if (await hit(key)) return readMeta(key);
    const adapter = pickAdapter();                            // §3.2
    return synthesizeAtomic(adapter, { ...opts, text }, key, adapter.ext);
  })().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}
```

| 场景 | 行为 |
|---|---|
| 3 客户端同时请求同一 `say` | **1 次**子进程，3 个调用共享同一 Promise（§10 T-5） |
| 合成中前端断开 | `AbortSignal` 取消 → 清 `.tmp` → 删 `inflight`，下次重新合成 |
| 两个不同 hash 并发 | 受全局并发 2 限制（总览 §5.3）排队；队列 >20 丢弃 `prefetch` 任务 |
| 同文本不同 `voice` | hash 不同 → 两次独立合成（预期） |

### 5.4 LRU 清理

| 参数 | 默认 | 配置项 |
|---|---|---|
| 条数上限 | 2000（≈2000×30KB ≈ 60MB，按实测 30096B/句） | `TTS_CACHE_MAX_ITEMS` |
| 字节上限 | 300 MB（任一维度超限即触发） | `TTS_CACHE_MAX_BYTES` |
| 单文件保留期 | 7 天，到期即删不论 LRU | `TTS_CACHE_TTL_DAYS` |
| 清理触发 | 每 10min tick + 写入后超限立即触发（与调度 tick 共用） | — |
| 删除保护 | `mtime` 距今 <60s 不删（防删正在被 `<audio>` 读取的文件） | — |
| 降级产物 | `sapi-tmp/` TTL 1h 全清，不计入配额 | `cache.sapiTmpTtlMs` |

```js
async function lruSweep() {
  const idx = await loadIndex();                             // [{hash,bytes,lastHitAt,createdAt,ext}]
  const now = Date.now();
  for (const e of idx) if (now - e.createdAt > TTL_MS) await evict(e.hash, 'ttl');   // 1) 过期
  idx.sort((a, b) => a.lastHitAt - b.lastHitAt);                                       // 2) LRU
  let bytes = sum(idx), items = idx.length;
  for (const e of idx) {
    if (bytes <= MAX_BYTES && items <= MAX_ITEMS) break;
    const st = await fs.stat(safeCachePath(e.hash, e.ext)).catch(() => null);
    if (!st || now - st.mtimeMs < 60_000) continue;                                     // 保护写入中
    bytes -= e.bytes; items -= 1; await evict(e.hash, 'lru');
  }
  for (const f of await fs.readdir(CACHE_DIR))                                          // 3) 孤儿文件（崩溃残留）
    if (/^[0-9a-f]{16}\.(mp3|wav)$/.test(f) && !idx.some(e => f.startsWith(e.hash)))
      await fs.rm(path.join(CACHE_DIR, f), { force: true });
  await saveIndex(idx);
}
```

`lastHitAt` 在 `/tts` 路由命中时只更新内存，每 60s 批量落盘——避免每请求写盘。

---

## 6. SAPI 与格式统一

| 方案 | 做法 | 优点 | 缺点 | 结论 |
|---|---|---|---|---|
| ① 双格式直接提供 | 保留 `.wav`，路由按实际扩展名给正确 MIME | 零依赖、零转码延迟、离线可用 | WAV 体积约 mp3 的 2.6×（76958 vs 30096）；路由需处理两种扩展名 | ✅ **推荐** |
| ② ffmpeg 转码 | `ffmpeg -i x.wav -codec:a libmp3lame -b:a 128k x.mp3` | 容器统一、体积小、路由与缓存逻辑单一 | **本机 ffmpeg 可用性未确认**；新增编解码失败点；转码 1~2s 吃掉降级路径的延迟余量 | ⚠️ 可选增强：`FFMPEG_PATH` 非空且探测通过才启用，失败自动回落 ① |
| ③ 只给 WAV | edge 产物也转 WAV | 格式最统一 | 仍需转码（同 ② 的依赖问题），且放弃 mp3 体积优势，配额压力 ×2.6 | ❌ 不采用 |

**采用 ①，ffmpeg 降格为 best-effort 增强。** ① **依赖风险最小**——SAPI 是降级路径，若再引入「可能不存在的外部可执行文件」，等于把兜底本身变成新失败点（违反 D-08）；② **延迟**——熔断期正是 edge-tts 不可用时，最不该叠加 1~2s 转码；③ **体积代价可接受**——SAPI 产物只写 `sapi-tmp/`（§5.1），不进 LRU 配额，长期缓存 100% 是 mp3；④ 兼容性足够（下表）。

| 容器 | 正确 MIME | Chrome/Edge | Firefox | Safari (macOS/iOS) | 说明 |
|---|---|---|---|---|---|
| mp3 | `audio/mpeg` | ✅ | ✅ | ✅ | 首选，全平台 |
| wav (PCM) | `audio/wav` | ✅ | ✅ | ✅ | **不要**用 `audio/x-wav`（部分环境不识别） |

```js
// GET /tts/:hash.mp3 —— 内容协商：优先 mp3，回落 wav，MIME 如实声明
let file = safeCachePath(hash, 'mp3'), mime = 'audio/mpeg';
if (!await exists(file)) { file = safeCachePath(hash, 'wav'); mime = 'audio/wav'; }
if (!await exists(file)) return res.status(404).json({ error: 'tts_not_found' });
const st = await fs.stat(file);
res.setHeader('Content-Type', mime);
res.setHeader('Accept-Ranges', 'bytes');                                  // ★ Safari 依赖 Range
res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');    // 内容寻址 → 强缓存
if (req.headers.range) return streamRange(req, res, file, st.size);       // 206 Partial Content
res.setHeader('Content-Length', st.size);
fs.createReadStream(file).pipe(res);
```

| 风险 | 处置 |
|---|---|
| iOS Safari 对非 Range 响应偶发不播 | 强制 `Range` → `206`，`Content-Range` 给准确字节区间 |
| `<audio>` 抛 `MEDIA_ERR_SRC_NOT_SUPPORTED` | 前端按 `mime` 重试一次；仍失败 → 跳过 say 进 `MUSIC_ONLY`（[前端 PWA](08-pwa-frontend.md)） |
| 强缓存与降级重合成冲突 | `immutable` 只对内容寻址 hash URL 生效；`say` 变化必产生新 hash，语义安全 |

---

## 7. `segue` 与 `say` 的流水线时序

### 7.1 完整时序图（基于实测 3.07s/句）

```
用户/调度触发
   ▼
 t=0.0s  compute() 入口
   │  context.build(intent)        ~0.05s
   │  brain.compute(prompt)        5.5s        ← 大脑（实测新会话）
   │  music.resolve(play[])        ~1.2s       ← 2 首并发（[06](06-music-provider.md) §6）
   ▼
 t≈6.8s  tts.synthesize(action.say)   ← say 音频【优先】
   │  ├ 缓存命中 → 0.02s
   │  └ 未命中   → edge-tts 3.07s/句（26 字实测）
   ▼
 t≈9.9s  ws.broadcast({type:'now-playing', sayUrl, queue})
   ▼  PWA 收到
 t≈9.9s  <audio>.src = /tts/<sayHash>.mp3 ；SPEAKING
   │  say 播放中（≈3.5s，§8 测量）
   ▼
 t≈10.3s say ended → src = queue[0].url ；PLAYING      ← gap ≤ 800ms（F-04）
   │  直链已在 t≈6.8s 预解析完成，无需等待
   │  ▶ 曲目 1 播放中（时长 D₁，例如 245s）
   │        …剩余 10s…
 t≈D₁-10s  PWA 发 {type:'prefetch', nextIndex:1}      ← 施工图 PWA 层 prefetch 10s
   │  ├ 下一首直链临近过期？→ 重解析（[06](06-music-provider.md) §6.2）
   │  ├ action.segue 非空且未合成 → tts.synthesize(segue) 3.07s ≪ 10s ✅
   │  │      → ws.push({type:'segue-ready', url})
   │  └ segue 为空 → 只准备直链，不合成
   ▼
 t≈D₁-0.4s 曲目 1 ended
   │  ├ segue 就绪 → src = /tts/<segueHash>.mp3 → SPEAKING（≤0.4s 切换）
   │  │     segue 播完（≈2.0s）→ src = queue[1].url → PLAYING
   │  └ segue 未就绪/为空 → 直接 src = queue[1].url（gap ≤ 800ms）
   ▼
 曲间衔接完成 → 循环「曲目播放中」，queue 空 → IDLE
```

### 7.2 时序预算、`segue` 规则与首字延迟

| 阶段 | 预算 | 依据 | 超预算处置 |
|---|---|---|---|
| 触发 → `say` 开始播 | ≤10s（F-01） | 6.8 + 3.07 ≈ 9.9s | 先播「占位过渡语」（总览 Q-04） |
| `say` 分段数 | ≤3 段 | 200 字 / 80 字每段 | >3 段时首段优先返回，其余后台合成 |
| `say` 播完 → 首曲开始 | ≤800ms（F-04） | 直链已预解析，仅切 `src` | 超时播兜底音频（[06](06-music-provider.md) §8） |
| 10s 内完成 segue 合成 | ≤10s | 3.07s，**余量 3.2×** | 未完成 → 放弃 segue，静默衔接，绝不 `await` |
| 曲间 gap | ≤800ms（F-04） | `prefetch` 10s 窗口 | 同上 |

1. **不阻塞音乐**：`segue` 合成是 best-effort；10s 窗口到点仍未 ready → 直接切下一首。
2. **不复用 `say` 缓存**：文本不同必然不同 hash；大脑重复产出同一 `segue` 时直接命中。
3. **只在有下一首时合成**：`queue.length - currentIndex <= 1` 时不合成（没有衔接对象）。

**首字延迟（P2 预留）**：当前为整段合成完成后播放；P2 可选 edge-tts 边合成边输出 MP3、服务端 chunked 转发，把首字延迟从 3.07s 降到 ~0.6s。**本期不做**——单 `<audio>` + 完整文件已满足 F-04/N-02，流式会显著增加 Range + chunked + 取消的边界复杂度。

---

## 8. 时长测量 `durationMs`

用途：① 前端进度条；② `segue` 预合成触发点（剩余 10s）；③ LRU 统计。**精度要求 ±15%**（触发点有 10s 窗口，容错充分）。

| 来源 | 能否给出 | 说明 |
|---|---|---|
| edge-tts stdout | ❌ 默认不给 | CLI 只产出音频文件 |
| edge-tts `--write-subtitles` | ⚠️ 间接可得 | 产出 SRT/WordBoundary，末条 cue 结束时间 ≈ 音频时长；多一次写盘+解析 |
| SAPI | ❌ 不直接给 | `Speak` 完成即写盘，无时长 API |
| **mp3 字节 + 码率** | ✅ 推荐 | ±15%（需先标定码率） |
| **WAV 头 + 字节数** | ✅ 精确 | WAV 头含 `byteRate`，是**准确值** |
| 前端 `loadedmetadata` / `ended` | ✅ 权威 | `<audio>.duration` 是解码后真值，回填后覆盖估算 |

```js
/** WAV：解析 fmt 块取 byteRate —— 精确计算（SAPI 产物走这条） */
function wavDurationMs(buf) {
  const byteRate = buf.readUInt32LE(28);   // RIFF(4) size(4) WAVE(4) fmt (4) 16(4) fmt(2) ch(2) rate(4) ##
  const dataSize = buf.readUInt32LE(40);   // 'data' 块大小（标准 44 字节头）
  return Math.round((dataSize / byteRate) * 1000);
}
/** MP3：优先用首帧码率，读不到则用标定值 */
function mp3DurationMs(bytes, frameBitrateKbps) {
  const bps = ((frameBitrateKbps || DEFAULT_MP3_KBPS) * 1000) / 8;
  return Math.round((bytes / bps) * 1000);
}
```

**标定法**：首次合成带 `--write-subtitles`，取末条 cue 结束时间 `T` → `BPS = bytes / (T/1000)`，写入 `data/tts-calibration.json`；一次性成本，之后纯估算，误差 <5%。

**回填校正（实用方案）**：服务端下发估算值并标 `est=true`；前端 `loadedmetadata` 后回报 `{type:'duration-report', hash, durationMs: Math.round(audio.duration*1000)}` → `tts.reportDuration()` 写回 `meta.est=false`，并用 EMA 校准全局 `DEFAULT_MP3_KBPS`。**不把 `--write-subtitles` 放进常规路径**（每句多一次写盘与解析，换不到 15% 精度）。

---

## 9. 配置项

`config/tts.yml`，由 `src/config.js` 读取；同名大写环境变量可覆盖标量。

| 字段 | 类型 | 默认 | env | 说明 |
|---|---|---|---|---|
| `engine` | enum | `edge-tts` | `TTS_ENGINE` | `edge-tts` \| `sapi` \| `auto`（按 §3.1 探测选） |
| `edgeTtsBin` | path | `D:\python\Scripts\edge-tts.exe` | `EDGE_TTS_BIN` | 绝对路径，不依赖 PATH |
| `ffmpegPath` | path\|null | `null` | `FFMPEG_PATH` | 非空且探测通过才启用 §6 方案 ② |
| `voice` | string | `zh-CN-XiaoxiaoNeural` | `TTS_VOICE` | 必须 ∈ `listVoices()` |
| `rate` / `pitch` / `volume` | string | `+0%` / `+0Hz` / `+0%` | `TTS_RATE` / `TTS_PITCH` / `TTS_VOLUME` | 语速 `-50%~+100%`、音调 `-50Hz~+50Hz`；`volume` **不进缓存键**（§5.1） |
| `bySlot` | map | 见下例 | — | 按 slot 覆盖音色（§2.3） |
| `timeoutMs` | int | `8000` | `TTS_TIMEOUT_MS` | >120 字自动 ×1.5 |
| `breaker.fails` / `.cooldownMs` / `.maxCooldownMs` | int | `3` / `120000` / `1800000` | `TTS_BREAKER_*` | 熔断阈值、保持、退避上限 |
| `cache.dir` | path | `data/tts-cache` | `DJ_TTS_CACHE_DIR` | 必须在 `data/` 之下（总览 §9） |
| `cache.maxItems` / `.maxBytes` / `.ttlDays` | int | `2000` / `314572800` / `7` | `TTS_CACHE_*` | LRU 条数、字节、保留期 |
| `cache.sapiTmpTtlMs` | int | `3600000` | — | 降级产物 TTL |
| `preprocess.maxChars` | int | `200` | `TTS_MAX_CHARS` | §4.5 限长 |
| `preprocess.segmentMinChars` / `.segmentMaxChars` | int | `40` / `80` | — | §4.4 分段上下限 |
| `preprocess.timePrefix` | bool | `true` | — | R3 时间读法开关 |
| `concurrency` | int | `2` | `TTS_CONCURRENCY` | 全局合成并发（总览 §5.3） |
| `queueDepthWarn` | int | `20` | — | 超此深度丢弃 `prefetch` 任务 |
| `fallback.enabled` | bool | `true` | `TTS_FALLBACK` | false 则失败直接进 `MUSIC_ONLY` |
| `logPrompt` | bool | `false` | `LOG_PROMPT` | 总览 §9：默认不记录 `say` 全文 |

```yaml
# config/tts.yml
engine: auto
edgeTtsBin: 'D:\python\Scripts\edge-tts.exe'
ffmpegPath: null
voice: zh-CN-XiaoxiaoNeural
rate: '+0%'
pitch: '+0Hz'
volume: '+0%'
bySlot: { morning: zh-CN-XiaoyiNeural, daily_plan: zh-CN-YunyangNeural, hourly_check: zh-CN-YunyangNeural,
          noon: zh-CN-YunyangNeural, evening: zh-CN-XiaoxiaoNeural, night_wind_down: zh-CN-XiaoxiaoNeural }
timeoutMs: 8000
breaker: { fails: 3, cooldownMs: 120000, maxCooldownMs: 1800000 }
cache: { dir: data/tts-cache, maxItems: 2000, maxBytes: 314572800, ttlDays: 7, sapiTmpTtlMs: 3600000 }
preprocess: { maxChars: 200, segmentMinChars: 40, segmentMaxChars: 80, timePrefix: true }
concurrency: 2
queueDepthWarn: 20
fallback: { enabled: true }
```

---

## 10. 测试要点

| 编号 | 用例 | 断言 |
|---|---|---|
| T-1 | **中文数字读法**：`preprocess('07:00 的早间播报，外面 18℃，湿度 65%')` | 不含 `07:00` / `℃` / `%`；含 `早上七点` `十八度` `百分之六十五` |
| T-2 | **Markdown 剥离**：`preprocess('**重点**：[点这里](https://a.b/c) 以及 \`code\`')` | 等于 `'重点：点这里 以及 code'`；无 `http` / `*` / 反引号 |
| T-3 | **超长文本**：250 字 `say` | `clamp200` 后 ≤200 字且以 `。` 结尾；`truncated===true`；warn 只含 `len` 与 `hash8`；分段数 ≤4 且每段 ≤80 字 |
| T-4 | **缓存命中**：同 `(voice,rate,pitch,text)` 连请求 2 次 | `spawn` 调用次数 ===1；第 2 次 P95 < 50ms；两次返回同一 hash 路径 |
| T-5 | **并发去重**：`Promise.all([synth(t)×4])` | `spawn` 调用 **1** 次；4 个结果 `path` 相同；结束后 `inflight.size === 0` |
| T-6 | **降级与熔断**：`EDGE_TTS_BIN` 指向退出码 1 的假程序 | 第 1 次失败即本次内回落 SAPI 且 `mime==='audio/wav'`；连续 3 次后第 4 次**不 spawn** edge；`cooldownMs` 过后首次请求触发探测 |
| T-7 | **路径安全**：`/tts/../../etc/passwd`、`/tts/ABCDEF0123456789.mp3` | 全部 400/404；`safeCachePath` 对非 `^[0-9a-f]{16}$` 抛 `EBADHASH`，对越界 resolve 抛 `EPATHESCAPE` |
| T-8 | **MIME / Range / 原子性**：带 `Range: bytes=0-1023` 请求 mp3 与回落 wav；合成中途 `kill` 子进程 | 分别 `audio/mpeg` / `audio/wav` 且返回 `206` + 正确 `Content-Range`；崩溃后无半截 `<hash>.mp3`、`.tmp/` 已清、重试成功 |

---

## 附：接口索引

| 交互点 | 对端 | 说明 |
|---|---|---|
| `say` 文本来源 | [大脑适配器](05-brain-adapter.md) | `DjAction.say` 1~200 字，越界由 §4.5 兜底 |
| `segue` 预合成触发 | [前端 PWA](08-pwa-frontend.md) | 剩余 10s 发 `prefetch` → 服务端合成 |
| `prefetch` 预热 / LRU 心跳 | [调度与节律](07-scheduler-rhythm.md) §3.5 | 队列 >20 时可丢弃预热任务 |
| `/tts/<hash>.mp3` · `health.tts` | [接口契约](03-api-contract.md) | 静态资源不校验 token；health 暴露 `activeEngine` / `breakerOpen` / `cacheItems` |

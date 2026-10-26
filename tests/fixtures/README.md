# 测试 fixture 说明

> 上游依据：[测试策略](../12-testing-strategy.md) §3（大脑回放）、§4（音乐 fixture）
> 加载器：[`tests/support/fixtures.js`](../../support/fixtures.js)
> 底座自测：[`tests/unit/fixture-harness.test.js`](../../unit/fixture-harness.test.js)（21 个断言，全部通过，0.4s）

---

## 为什么需要 fixture

三个外部依赖都**不适合在测试里真调用**：

| 依赖 | 真调用的问题 |
|---|---|
| 大脑（`dsh`） | 每轮 5–10s、消耗账号用量、模型输出有随机性 → 断言不稳定 |
| 音乐 API | 公共实例会限流（实测突发即 503）、直链会过期、结果随曲库变化 |
| TTS（`edge-tts`） | 每句 ~2.9s、依赖微软服务、产物是二进制音频 |

所以测试策略是**录制-回放**：把真实响应录成文件，测试时读文件。
好处是测试**零出网、零子进程、确定性**，可以在 CI 上离线跑。

**关键前提：fixture 必须来自真实调用，不能手编。** 手编的 fixture 只能验证
「我以为的格式」，验证不了「真实的格式」。本目录所有 fixture 都由录制工具生成。

---

## 目录结构

```
tests/fixtures/
├─ brain/                       # 大脑 NDJSON 事件流
│  ├─ <场景>.ndjson              #   首行是 _meta，其后是逐行事件
│  ├─ <场景>.stderr.txt          #   仅 exit1-* 场景有
│  └─ README 见下方「大脑场景表」
├─ music/                       # 音乐 API 原始响应
│  ├─ search-<场景>.json
│  ├─ url-<场景>.json
│  ├─ lyric-<场景>.json
│  ├─ pic-<场景>.json
│  ├─ playlist-3778678.json     # 体积较大，录制时可用 --no-playlist 跳过
│  └─ index.json                # 索引：每个场景的期望结论 + 噪声样本
```

---

## 大脑场景表（12 个，对应测试策略 §3.1）

`_meta.synthetic` 标明该 fixture 是真实录制还是人造。

| # | 文件 | 来源 | 覆盖的边界 |
|---|---|---|---|
| 1 | `ok-normal.ndjson` | 真实录制 | 完整事件序列，`play` 非空 |
| 2 | `ok-markdown-fenced.ndjson` | 真实录制 | 模型用 ` ```json ` 包裹 → 必须剥离 |
| 3 | `ok-empty-play.ndjson` | 真实录制 | `play: []` 纯口播路径 |
| 4 | `ok-with-usage.ndjson` | 真实录制 | `step_end` 带 token 用量 |
| 5 | `bad-missing-say.ndjson` | 真实录制 + 后处理 | 缺必填字段 `say` |
| 6 | `bad-overlong-say.ndjson` | 真实录制 | `say` 超过 200 字 → 截断 |
| 7 | `bad-malformed-json.ndjson` | 人造 | JSON 截断不可修复 → 重试 |
| 8 | `empty-final.ndjson` | 人造 | `final.text` 为空 → 模板降级 |
| 9 | `timeout.ndjson` | 人造 | 只有 `turn_start`，`_meta.delayMs: 60000` → 超时杀树 |
| 10 | `session-lost.ndjson` | 人造 | 返回的 `sessionId` 与请求值不同 → 接受新 id |
| 11 | `exit1-credential.ndjson` | 人造 | 退出码 1 + 凭据错误 → 配置类失败 |
| 12 | `exit1-profile-desktop.ndjson` | 人造 | 退出码 1 + 变量名冲突（本项目踩过的真实坑） |

### 关于第 5 个场景的诚实说明

`bad-missing-say` 由**真实模型输出后处理**而来，`_meta` 里有 `postProcessed: true`。

原因：即使 prompt 里明确要求「故意不要包含 say 字段」，模型也几乎总会把 `say` 补上 ——
这本身是个好信号（说明 `dj-persona.md` 的输出契约生效了），但导致无法靠自然调用
录到「缺字段」的样本。所以录真实输出后删掉 `say`，以保证该路径被确定性覆盖。
`_meta` 如实标注，不假装是原始字节。

### 第 9 个场景为什么是人造

`dsh` 没有「卡住不返回」的开关。真实录一个 60s 的超时既慢又不可靠，
所以用 `_meta.delayMs` 声明延迟，由 `replayBrainProcess()` 在回放时真的等这么久 ——
配合注入的短超时（如 200ms），就能稳定测到超时路径。

---

## 音乐场景表（对应测试策略 §4.2）

| 场景 | 源 | 为什么录它 |
|---|---|---|
| `qingtian` | netease | **最有价值**：实测首条返回的是翻唱「晴天(深情版)」。首选命中必须是原唱，这条 fixture 是打分算法噪声过滤的验收依据 |
| `lizhi-xiayu` | netease | 正向基准：真实可播放，出直链（br=320） |
| `chenli-xiaoban` | netease | 正向基准 #2，含原版/伴奏/remix 多版本，验证版本选择 |
| `joox-qingtian` | joox | **反向基准**：`url` 返回空字符串 `""` 而非缺字段 —— 见下方陷阱 |

### ⚠️ 这个 fixture 抓到了一个真实的实现陷阱

`url-joox-qingtian.json` 的实际内容是：

```json
{ "url": "", "br": -1, "size": 0, "from": "music.gdstudio.xyz" }
```

`url` 字段**存在但是空字符串**。所以：

```js
// ❌ 错的 —— 空串也是 string，会让空 URL 一路流到 <audio src="">
if (typeof data.url === 'string') { /* 以为有直链 */ }

// ✅ 对的
if (/^https?:\/\/\S+/.test(data.url)) { /* 真的有直链 */ }
```

这个 bug 的表现是「静默不播放」—— 最难排查的一类症状。fixture 里保留了它作为回归锚点
（`tests/unit/fixture-harness.test.js` 有专门断言）。

同时注意：**`url` 是临时 CDN 地址，会过期**。回放测试只应断言「字段结构与解析逻辑」，
**不要**断言直链本身可访问。

---

## 用法

### 加载器 API

```js
import {
  loadBrainFixture, replayBrainProcess, listBrainFixtures,
  loadMusic, loadMusicIndex, listMusicCases, createFakeMusicProvider,
  createFakeTtsAdapter, validateDjAction,
} from '../support/fixtures.js';

// 大脑：读事件
const { meta, events, exitCode, stderr, synthetic } = loadBrainFixture('ok-normal');

// 大脑：模拟子进程（接口与 child_process.spawn 对齐，可直接替换）
const child = replayBrainProcess('ok-normal');
child.stdout.on('data', (d) => { /* 收到 NDJSON 行 */ });
child.on('close', (code, signal) => { /* … */ });
child.stdin.end('prompt');

// 音乐
const { data, case: c } = loadMusic('qingtian', 'search');
const provider = createFakeMusicProvider();                    // 正常
const failing  = createFakeMusicProvider({ failureMode: 'all' });        // 全失败 → 测兜底音频
const limited  = createFakeMusicProvider({ failureMode: 'rateLimit' });  // 503 → 测退避

// TTS
const tts = createFakeTtsAdapter();                     // 固定 4096 字节假 mp3
const once = createFakeTtsAdapter({ failMode: 'once' }); // 首次失败 → 测降级到 SAPI

// 契约校验
validateDjAction(action);  // 返回问题数组，空数组 = 合规
```

### 断言约束

`tests/support/fixtures.js` **不发网络请求、不 spawn 子进程、不写磁盘**（只读 fixture）。
写新测试时请保持这一点 —— 这是「CI 可离线跑」的前提。

### `BRAIN_REPLAY_DIR`

按测试策略 §3.1，`src/adapters/brain/dsh-headless.js` 应支持该环境变量：
设置后**完全不 spawn**，改为读 fixture。

```js
process.env.BRAIN_REPLAY_DIR = 'tests/fixtures/brain';
```

当前该环境变量**尚未被消费**（`src/` 未实现）。回放能力已由
`tests/support/fixtures.js` 的 `replayBrainProcess()` 提供，
适配器实现时（M1）直接复用它即可，不需要自己再写一套读取逻辑。

---

## 重录

fixture 会随外部世界漂移（模型行为变化、音乐 API 改版）。发现断言失败时，
**先确认是不是外部变了**，再决定是改代码还是重录。

```powershell
# 大脑（会真实调用，每场景一轮，消耗账号用量）
node tools/record-brain-fixtures.js --list                    # 先看清单
node tools/record-brain-fixtures.js --all                      # 录全部 12 个
node tools/record-brain-fixtures.js --only ok-normal           # 只重录一个有问题的

# 音乐（有节流，约 1.2s/请求）
node tools/record-music-fixtures.js
node tools/record-music-fixtures.js --no-playlist              # 跳过体积大的歌单

# 验证
npm test
```

录制工具会：
1. 把真实 `cwd` 与 `sessionId` 泛化（`<CWD>` / 全零 UUID），避免 fixture 绑定本机
2. **校验每个场景是否真的覆盖了它声称的边界**，不达标就报错退出
3. 在 `_meta` 里记录 `recordedAt` / `latencyMs` / `synthetic` / `postProcessed`

### 隐私

fixture 里**不得包含真实的个人语料**。录制工具用的是通用探测文本
（「下雨了，来点安静的」等），不含 `knowledge/user/` 的内容。
新增场景时请保持这一点。

---

## 与测试策略的对应

| 测试策略条目 | 由谁提供 |
|---|---|
| §3.1 大脑 12 个 fixture 清单 | `brain/` 全部 12 个场景 ✅ |
| §3.1 `BRAIN_REPLAY_DIR` 回放 | `replayBrainProcess()` ✅（适配器待接） |
| §3.2 `FakeTtsAdapter` | `createFakeTtsAdapter()` ✅ |
| §4.2 `FakeMusicProvider` + 真实 fixture | `createFakeMusicProvider()` + `music/` ✅ |
| §4.2 噪声样本（翻唱过滤） | `search-qingtian.json`（含 3 条翻唱噪声）✅ |

# Claudiao · 需求与准备清单

> 文档版本 v1.0 · 状态：设计完成，待实现
> 上游唯一权威来源：[设计总览](01-architecture-design.md)（需求编号 F-01~F-11 / N-01~N-07、决策 D-01~D-08、未决问题 Q-01~Q-05 全部沿用，不得改写）
> 关联：[模块详细设计](02-module-spec.md) · [接口契约](03-api-contract.md) · [多源降级](06-music-provider.md#多源降级链) · [进度表](10-progress-tracker.md) · [风险登记册](11-risk-register.md) · [测试策略](12-testing-strategy.md)

本文回答三个问题：**要做什么**（需求索引）、**做的东西怎么核对**（追溯矩阵）、**开工前要准备什么**（准备清单 / 素材 / DoD / 环境自检）。

---

## 1. 需求索引表

### 1.1 功能需求 F-01 ~ F-11

| 编号 | 需求（措辞同设计总览 §1.2，不改写） | 优先级 | 负责模块 | 验证方式 |
|---|---|---|---|---|
| F-01 | 自然语言点播 | P0 | `src/layer2/router.js` + `context.js` + `brain.js` + `src/providers/music/` | 端到端用例 **E2E-02**；手工验收：Profile 页输入「来点适合下雨天的歌」，观察 ≤10s 内 `<audio>.src` 变为 `/tts/<hash>.mp3` 且随后切到曲目直链 |
| F-02 | 定时主动播报 | P0 | `src/layer2/scheduler.js` + `state.js` | 端到端用例 **E2E-08**（`SLOT_TIME_SCALE` 加速触发）；手工验收：见 §5「能用」档 Q4 |
| F-03 | 品味一致性 | P0 | `context.js` + `knowledge/user/taste.md` + `mood-rules.md` | 指标化验收：连续 20 首推荐抽样，人工按 `mood-rules.md` 档位打分 ≥16/20；回放用例 `tests/replay/brain/taste-consistency.test.js` 校验 prompt 中确实注入了对应档位规则 |
| F-04 | 语音播报 | P0 | `src/layer2/tts.js` + `src/adapters/tts/*` + `web/player.js` | 端到端用例 **E2E-01**（断言 say 播完才切歌）；手工验收：连续听 3 次播报，用秒表掐 `speechSynthesis`-无关的 `<audio>` 切换间隔 ≤ 800ms |
| F-05 | 记忆连续性 | P0 | `state.js`（`plays` 表）+ `context.js` | 单元用例 `tests/unit/state-no-repeat.test.js`（24h 去重窗口）；端到端用例 **E2E-11**（次日重播同一 slot，断言 `play[]` 与昨日无交集） |
| F-06 | now-playing 推送 | P0 | `src/server.js` + `ws` + `web/ws-client.js` | 契约用例 `tests/contract/ws-events.test.js`（事件序列 + schema）；端到端用例 **E2E-10**（双客户端 500ms 内状态一致） |
| F-07 | 每日规划可读 | P1 | `state.js`（`plan` 表）+ `src/routes/plan.js` | 契约用例 `tests/contract/http-plan.test.js`（schema 含 `reason`）；手工验收：浏览器打开 `/api/plan/today`，每条时段都有非空 `reason` 与 `play[]` |
| F-08 | 跳过与反馈 | P1 | `web/player.js` + `state.js` + `router.js` | 端到端用例 **E2E-03**；单元用例 `tests/unit/state-skip-weight.test.js`（连续 3 次跳过 → 切换情绪档位，语义同 `radio.yml` 的 `consecutiveSkipsBeforeSwitch: 3`） |
| F-09 | 品味在线编辑 | P1 | `src/routes/taste.js` + `context.js`（内容哈希失效） | 端到端用例 **E2E-12**；手工验收：Profile 页改 `taste.md` 并保存，不重启服务，30s（`corpusWatchIntervalSeconds`）后触发一次点播，断言新语料出现在 prompt（`LOG_PROMPT=1` 时看日志） |
| F-10 | 离线可用 | P2 | `tts.js`（SAPI 分支）+ `providers/music/`（本地兜底）+ `web/sw.js` | 端到端用例 **E2E-07**（断外网：用防火墙规则屏蔽出网，或把 `MUSIC_BASE_URL` 指向 `http://127.0.0.1:1/`）；手工验收：拔网线后刷新 PWA 仍可打开并播放缓存播报 |
| F-11 | 客厅投送 | P2 | `src/providers/dlna/` + `src/routes/cast.js` | 手工验收：Settings 页点击「投送到客厅」，在音箱 App 里看到设备变为 playing。**P2，允许本期不做**，但接口位必须预留（`UPNP_ENABLED=0` 时不加载模块） |

### 1.2 非功能需求 N-01 ~ N-07

| 编号 | 需求（措辞同设计总览 §1.3） | 指标 | 负责模块 | 验证方式 |
|---|---|---|---|---|
| N-01 | 单次决策延迟 | 冷启动 ≤ 15s，热路径 ≤ 8s | `src/adapters/brain/dsh-headless.js` | `npm run brain:smoke` 打印单轮耗时；断言脚本：连跑 20 次取 P50/P95 写进 `data/logs/latency.jsonl`，P95 ≤ 8s 为通过（实测基线 5.5s / resume 10.1s） |
| N-02 | TTS 合成延迟 | 缓存命中 < 50ms；未命中 ≤ 3s/百字 | `src/layer2/tts.js` | 单元用例 `tests/unit/tts-cache-latency.test.js`（FakeTts 命中路径 < 50ms）；`npm run tts:warm` 打印真实合成耗时（实测 3.07s / 30096 字节） |
| N-03 | 常驻内存 | 服务进程 ≤ 300MB | `src/server.js` | 手工验收：`npm start` 后运行 30 分钟，任务管理器看 `node.exe` 工作集 ≤ 300MB；`/api/health` 返回 `rssMb` 字段供观测 |
| N-04 | 成本 | 运行期零边际成本 | 全体（`D-03` 本地 TTS、`D-01` 账号态大脑） | 审计：`npm ls` 无付费 SDK 依赖；全仓 grep 无 `api.openai.com` / `fish.audio` / `api.anthropic.com` 等计费端点 |
| N-05 | 隐私 | 语料/历史/音频不出本机 | `src/layer2/context.js` + 日志层 | 审计：默认 `LOG_PROMPT=0`；全仓 grep 出网调用点仅 4 处（音乐 API、天气 API、飞书 Webhook、edge-tts），逐处确认 payload 不含语料全文与播放历史 |
| N-06 | 可恢复 | 崩溃重启状态不丢 | `state.js` + SQLite（WAL） | 端到端用例 **E2E-13**：kill 进程 → 重启 → `GET /api/now` 仍能返回最后一次 `plays` 记录 |
| N-07 | 可替换 | 大脑/TTS/音乐可换适配器 | `src/adapters/brain/` `src/adapters/tts/` `src/providers/music/` | 静态校验用例 `tests/unit/architecture-boundary.test.js`：`src/layer2/**` 内不得出现 `child_process` / `fetch(` / `http.request`（设计总览 §3.3 的强制约束） |

### 1.3 本期明确不做（引用设计总览 §1.4，用于防止范围蔓延）

❌ 多用户与账号体系 · ❌ 音乐文件下载与本地曲库管理 · ❌ 破解/去 DRM · ❌ 移动原生 App · ❌ 离线语音唤醒（ASR）

---

## 2. 需求追溯矩阵

> 用途：实现阶段逐行核对。**每一行都必须填满**；「实现文件」列中标注 `(待建)` 的是尚未创建的文件。
> 设计章节一律引用 [设计总览](01-architecture-design.md)；其余文档只按整篇引用，不假设其小节号。

| 需求 | 设计文档章节 | 实现文件 | 测试用例 |
|---|---|---|---|
| F-01 | [§1.2 F-01](01-architecture-design.md) · [§4.1 主链路](01-architecture-design.md) · [§5.1 compute()](01-architecture-design.md) | [src/layer2/router.js](01-architecture-design.md) (待建) · `src/layer2/context.js` (待建) · `src/server.js` (待建) · [src/providers/music/](06-music-provider.md) (待建) · [web/](08-pwa-frontend.md) (待建) | E2E-02 · `tests/unit/router-classify.test.js` |
| F-02 | [§1.2 F-02](01-architecture-design.md) · [§4.2 定时链路](01-architecture-design.md) · [§8.2 触发生命周期](01-architecture-design.md) | `src/layer2/scheduler.js` (待建) · `src/layer2/state.js` (待建) · [config/routines.yml](../config/routines.yml) | E2E-08 · E2E-09 · `tests/unit/scheduler-slot.test.js` |
| F-03 | [§1.2 F-03](01-architecture-design.md) · [§3 第三层 ② 片](01-architecture-design.md) | [knowledge/user/taste.md](../knowledge/user/taste.md) · [knowledge/user/mood-rules.md](../knowledge/user/mood-rules.md) · [knowledge/user/playlists.json](../knowledge/user/playlists.json) · `src/layer2/context.js` (待建) | `tests/replay/brain/taste-consistency.test.js` · 手工抽样 20 首 |
| F-04 | [§1.2 F-04](01-architecture-design.md) · [§4.1 ⑧](01-architecture-design.md) · [§5.2 降级链](01-architecture-design.md) | [src/layer2/tts.js](../docs/04-tts-pipeline.md) (待建) · `src/adapters/tts/edge.js` (待建) · `src/adapters/tts/sapi.js` (待建) · `web/player.js` (待建) | E2E-01 · E2E-06 · `tests/unit/tts-cache-key.test.js` |
| F-05 | [§1.2 F-05](01-architecture-design.md) · [§6.2 SQLite 表](03-api-contract.md#sqlite-ddl) · [§7 D-02](01-architecture-design.md) | `src/layer2/state.js` (待建) · `src/layer2/context.js` (待建) | E2E-11 · `tests/unit/state-no-repeat.test.js` |
| F-06 | [§1.2 F-06](01-architecture-design.md) · [§3.1 部署视图](01-architecture-design.md) · [§6.1 DjAction](03-api-contract.md#dj-action-v1) | `src/server.js` (待建) · `src/ws/hub.js` (待建) · `web/ws-client.js` (待建) | E2E-10 · `tests/contract/ws-events.test.js` |
| F-07 | [§1.2 F-07](01-architecture-design.md) · [§4.2 幂等](01-architecture-design.md) · [§6.1 reason 字段](01-architecture-design.md) | `src/routes/plan.js` (待建) · `src/layer2/state.js` (待建) | `tests/contract/http-plan.test.js` · 手工验收 `/api/plan/today` |
| F-08 | [§1.2 F-08](01-architecture-design.md) · [§7 D-08](01-architecture-design.md) | `web/player.js` (待建) · `src/layer2/state.js` (待建) · `src/layer2/router.js` (待建) | E2E-03 · `tests/unit/state-skip-weight.test.js` |
| F-09 | [§1.2 F-09](01-architecture-design.md) · [§7 D-06](01-architecture-design.md) · [§9 文件写入](01-architecture-design.md) | `src/routes/taste.js` (待建) · `src/layer2/context.js` (待建) · [web/views/profile.js](08-pwa-frontend.md) (待建) | E2E-12 · `tests/unit/context-hot-reload.test.js` |
| F-10 | [§1.2 F-10](01-architecture-design.md) · [§5.2 降级链](01-architecture-design.md) · [§7 D-03](01-architecture-design.md) | `src/adapters/tts/sapi.js` (待建) · [src/providers/music/](06-music-provider.md) (待建) · [web/sw.js](08-pwa-frontend.md) (待建) · `data/fallback-audio/` | E2E-07 · 手工验收 §7 |
| F-11 | [§1.2 F-11](01-architecture-design.md) · [§10 Q-05](01-architecture-design.md) | `src/providers/dlna/` (待建，P2) · `src/routes/cast.js` (待建，P2) | 手工验收（P2，允许跳过） |
| N-01 | [§1.3 N-01](01-architecture-design.md) · [§4.3 实测时序](01-architecture-design.md) | [src/adapters/brain/dsh-headless.js](../package.json) (待建) · [tools/brain-smoke.js](../tools/brain-smoke.js) ✅ **已实现** | `npm run brain:smoke`（已通过，实测 6320ms）· `tests/replay/brain/latency.test.js`（用 fixture 测解析耗时，不断言真实延迟） |
| N-02 | [§1.3 N-02](01-architecture-design.md) · [§4.1 ⑧ 缓存键](01-architecture-design.md) · [§7 D-07](01-architecture-design.md) | `src/layer2/tts.js` (待建) · [tools/tts-warm.js](../package.json) (待建) | `tests/unit/tts-cache-latency.test.js` · `npm run tts:warm` |
| N-03 | [§1.3 N-03](01-architecture-design.md) | `src/server.js` (待建) · `src/routes/health.js` (待建) | 手工验收 §5「能用」档 · `/api/health` 的 `rssMb` |
| N-04 | [§1.3 N-04](01-architecture-design.md) · [§7 D-01/D-03/D-04](01-architecture-design.md) | [package.json](../package.json) · [config/.env.example](../config/.env.example) | 审计命令见 §1.2 N-04 行 |
| N-05 | [§1.3 N-05](01-architecture-design.md) · [§9 安全与合规](01-architecture-design.md) | `src/lib/log.js` (待建) · `src/layer2/context.js` (待建) · [.gitignore](../.gitignore) | 审计 grep（4 个出网点） · `tests/unit/log-redaction.test.js` |
| N-06 | [§1.3 N-06](01-architecture-design.md) · [§6.2 四表](03-api-contract.md#sqlite-ddl) · [§8.1 状态机](01-architecture-design.md) | `src/layer2/state.js` (待建) · [tools/db-migrate.js](../package.json) (待建) · [tools/backup.js](../package.json) (待建) | E2E-13 · `tests/unit/state-migrate.test.js` |
| N-07 | [§1.3 N-07](01-architecture-design.md) · [§3.3 依赖方向](01-architecture-design.md) | `src/adapters/**` · `src/providers/**` · [README 技术栈](../README.md) | `tests/unit/architecture-boundary.test.js` |
| D-01~D-08 | [§7 关键设计决策](01-architecture-design.md) | 见上表对应行 | 决策级验证：D-01/D-02 → `npm run brain:smoke`（**已通过**）；D-03 → `tts:warm`；D-04 → `npm run music:check`；D-05 → E2E-01；D-06 → E2E-12；D-07 → `tests/unit/tts-cache-key.test.js`；D-08 → E2E-05/06/07 |
| Q-01~Q-05 | [§10 未决问题](01-architecture-design.md) | 逐条跟踪见 [风险登记册 §7](11-risk-register.md) | 每条有决策期限与负责人，见风险登记册 |

---

## 3. 准备清单（会阻塞开工的）

> 分三档：**必需** = 缺了跑不起来；**推荐** = 缺了能跑但体验差；**可选** = 缺了少一个功能。
> 「本机状态」列是**实测结论**，不是推测。

### ⚠️ 环境变量命名硬规则（已实测踩坑，必读）

**DeepSeek Harness 自身会在进程环境里注入 `DSH_PROFILE`（值为 `desktop`）、`DSH_HOME`、`DSH_SESSION_ID` 等变量。** 如果本项目也用 `DSH_PROFILE` 这个名字，那么从 DSH 内部启动电台时，`.env` 里的值会被环境里**已有的** `DSH_PROFILE=desktop` 覆盖，大脑随即报错（已实测复现）：

```
error: profile "desktop" is managed exclusively by the Electron application
```

**修复（已落地）**：本项目所有与 `dsh` 相关的配置变量统一加 `CLAUDIAO_` 前缀。

| 旧名（**禁止使用**） | 新名（唯一正确） | 用途 |
|---|---|---|
| ~~`DSH_BIN`~~ | `CLAUDIAO_DSH_BIN` | `dsh` 可执行文件绝对路径 |
| ~~`DSH_PROFILE`~~ | `CLAUDIAO_DSH_PROFILE` | profile 名（`dj-brain`） |
| ~~`DSH_CWD`~~ | `CLAUDIAO_DSH_CWD` | 大脑子进程工作目录（必须是 `D:\DJ`） |

- `DSH_HOME` **不加前缀**——它是 DSH 自己的变量，本项目只读取，默认 `C:\Users\wumingtao\.dsh`。
- 读取 `.env` 时，**带 `CLAUDIAO_` 前缀的键以 `.env` 为准**（覆盖 `process.env` 中的同名项），无前缀的键不覆盖已有环境变量。这条规则已由 [tools/brain-smoke.js](../tools/brain-smoke.js) 的 `loadEnv()` 实现，`src/lib/config.js`（M0-T1）必须保持一致。
- 详见 [快速开始](00-quick-start.md) 的故障排查表与 [部署与运维](13-deployment-ops.md) 的同名条目。**不要改回无前缀的名字。**

### 3.1 必需

| # | 项目 | 说明 | 获取方式 | 验收标准（怎么算装好了） | 缺失后果 | 本机状态 |
|---|---|---|---|---|---|---|
| E-1 | Node.js ≥ 20 | 运行时；`--test`、`node:sqlite` 之外的 ESM 特性都依赖 20+ | `winget install OpenJS.NodeJS.LTS` 或官网 msi | `node -v` 输出 `v20.x` 及以上；`node --test --help` 退出码 0 | 服务无法启动，全部测试脚本不可用 | ✅ **v22.11.0 已满足**；npm 10.9.0 |
| E-2 | Python 3 + `edge-tts` | 首选 TTS 引擎（`D-03`）。`edge-tts` 是 Python 包，不是 Node 包 | `python -m pip install edge-tts` | `D:\python\Scripts\edge-tts.exe --version` 有输出；`edge-tts --list-voices` 能列出 `zh-CN-XiaoxiaoNeural` | TTS 降级到 SAPI（机械音）或直接跳过语音（`MUSIC_ONLY`），F-04 不可达 | ✅ **已装于 `D:\python\Scripts\edge-tts.exe`**；实测 3.07s / 30096 字节 |
| E-3 | `dj-brain` profile | 大脑身份与模型配置，位于 `$DSH_HOME/profiles/dj-brain/`（`DSH_HOME` 无前缀）。**不含 API key**，走 `deepseek-account` 账号态 | 已存在配置：`C:\Users\wumingtao\.dsh\profiles\dj-brain\`；重建脚本见 [scripts/setup-brain-profile.ps1](../scripts/setup-brain-profile.ps1) | `npm run brain:smoke` 退出码 0（工具已实现并通过，实测 6320ms）；或手工 `& $env:CLAUDIAO_DSH_BIN --profile $env:CLAUDIAO_DSH_PROFILE "回复 ok"` 打印含 `ok` 的回复 | 大脑不可用 → 全站降级到模板播报，F-01/F-03/F-07 失效 | ✅ **已实测可用**；新会话 5.5s、resume 10.1s；冒烟工具实测 6320ms |
| E-4 | `dsh` 可执行文件路径 + **变量名前缀** | 不在 PATH，必须用绝对路径。**所有与 dsh 相关的配置变量必须加 `CLAUDIAO_` 前缀**（见下方警告） | 已确认：`C:\Users\wumingtao\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd` | `Test-Path $env:CLAUDIAO_DSH_BIN` 为 `True`；`& $env:CLAUDIAO_DSH_BIN --version` 退出码 0 | 适配器 spawn 失败 `ENOENT`，每轮播报都降级 | ✅ 已写入 [config/.env.example](../config/.env.example) 的 `CLAUDIAO_DSH_BIN` |
| E-5 | 公共音乐 API 可达 | `https://music-api.gdstudio.xyz/api.php`（`D-04`） | 无需申请，公开实例；失效时更换实例或自建 | 见下方验证命令，`types=url` 返回非空 `url` 字段 | 无法在线选曲 → 只能播本地兜底音频，F-01 的「10s 内播放匹配曲目」降级为固定曲 | ✅ 实测可用；`netease` ✅ `joox` ✅；`kuwo`/`tencent`/`migu`/`kugou` ❌ 400/503 |
| E-6 | `data/` 可写 + 目录齐备 | SQLite、TTS 缓存、日志、兜底音频全部落 `data/` | `New-Item -ItemType Directory -Force data\tts-cache, data\logs, data\fallback-audio` | 写入探针：`Set-Content data\.write-probe "ok"` 成功且文件内容为 `ok`，随后删除 | 缓存与状态无处落盘：SQLite 报 `SQLITE_CANTOPEN`，TTS 每次都要现合成 | 目录已在（`data/tts-cache/` `data/logs/`）；`data/fallback-audio/` 待建 |
| E-7 | 磁盘剩余 ≥ 5 GB | `data/` 与 `node_modules` 同盘（D:） | 清理或扩容 | `Get-PSDrive D` 的 `Free` ≥ 5GB | TTS 缓存写失败、SQLite WAL 写失败 → 电台静音（最差失败模式，`D-08`） | ✅ 实测 D: 剩余约 54 GB |
| E-8 | 本地兜底音频 ≥ 5 首 | **唯一需要你自己准备素材的一项**（详见 §4） | 见 §4.2 来源建议 | `data/fallback-audio/` 内 ≥5 个 `.mp3`，`npm run doctor` 的音乐检查项通过 | 音乐源全挂时无音频可播，只能静音或循环同一首 | ❌ **待你准备** |

**E-5 验证命令（PowerShell）**

```powershell
# 1) 搜索：应返回 result 数组且 count > 0
$q = [uri]::EscapeDataString('李志 下雨')
Invoke-RestMethod "https://music-api.gdstudio.xyz/api.php?types=search&source=netease&name=$q&count=3&pages=1" |
  Select-Object -First 1 | ConvertTo-Json -Depth 4

# 2) 直链：应返回 url 字段非空（拿到 id 后）
Invoke-RestMethod "https://music-api.gdstudio.xyz/api.php?types=url&source=netease&id=<上一步的id>&br=320"

# 3) 一次跑完全部已启用源（等价于 npm run music:check）
foreach ($s in 'netease','joox') {
  $r = Invoke-RestMethod "https://music-api.gdstudio.xyz/api.php?types=search&source=$s&name=test&count=1&pages=1"
  "{0,-8} => {1}" -f $s, ($(if ($r) { 'OK' } else { 'EMPTY' }))
}
```

**E-3 验证命令（推荐直接用已实现的冒烟工具）**

```powershell
# 方式 A（推荐）：已实现的冒烟工具，断言退出码 / NDJSON 契约 / DjAction 四字段
npm run brain:smoke        # 实测耗时 6320 ms，退出码 0

# 方式 B：直接用 .env 里的带前缀变量手工验证
& $env:CLAUDIAO_DSH_BIN --profile $env:CLAUDIAO_DSH_PROFILE "回复 ok"
# 期望：打印含 "ok" 的回复，$LASTEXITCODE 为 0
echo "exit=$LASTEXITCODE"

# ⚠️ 若出现 error: profile "desktop" is managed exclusively by the Electron application
#    说明变量名没加 CLAUDIAO_ 前缀，被 DSH 自身注入的 DSH_PROFILE=desktop 覆盖了。
#    见本节开头的「环境变量命名硬规则」。
```

### 3.2 推荐

| # | 项目 | 说明 | 获取方式 | 验收标准 | 缺失后果 | 本机状态 |
|---|---|---|---|---|---|---|
| R-1 | `npm install` 成功 | 5 个依赖：`express` `ws` `better-sqlite3` `js-yaml` `dotenv` | 项目根执行 `npm install` | `node -e "import('express')"` 无异常；`node -e "require('better-sqlite3')"` 无异常（**该包是原生模块，需预编译或 VS Build Tools**） | 服务与 DB 均无法启动 | 未执行 |
| R-2 | `better-sqlite3` 原生构建可用 | 若 npm 拉不到预编译包，需要 MSVC 工具链 | `winget install Microsoft.VisualStudio.2022.BuildTools` 后重装 | `node -e "const D=require('better-sqlite3');console.log(new D(':memory:').prepare('select 1').get())"` 输出 `{ '1': 1 }` | 同上 | 未验证 |
| R-3 | 端口 8080 可用 | 默认监听 `127.0.0.1:8080` | `netstat -ano \| findstr :8080` | 无占用，或已知占用进程可停 | 启动失败 `EADDRINUSE`；缓解见 [风险 R-21](11-risk-register.md) | 未验证 |
| R-4 | 系统时钟与时区正确 | cron 判定与 `TZ=Asia/Shanghai` 必须一致 | 设置 → 时间和语言 → 自动同步时间 | `Get-Date` 与手机时间差 ≤ 5s；`(Get-TimeZone).Id` 为 `China Standard Time` | 定时播报漂移，`(date, slot)` 幂等键算错日子 | 未验证 |
| R-5 | 电源计划不睡眠 | Windows 休眠导致 Node 定时器停摆 | `powercfg /change standby-timeout-ac 0` | `powercfg /query SCHEME_CURRENT SUB_SLEEP` 显示待机超时为 0 | 定时播报错过触发点，依赖 `wakeCatchUp` 补跑 | 未设置（补跑机制必须实现） |
| R-6 | 飞书 Webhook | 崩溃/熔断/每日总结通知（可选但很值） | 飞书群 → 群设置 → 机器人 → 自定义机器人 → 复制 Webhook | `Invoke-RestMethod -Method Post -Uri $env:FEISHU_WEBHOOK -Body '{"msg_type":"text","content":{"text":"test"}}' -ContentType 'application/json'` 返回 `StatusCode:0` | 服务异常时你无从得知，只能靠日志文件 | 未配置 |

### 3.3 可选

| # | 项目 | 说明 | 获取方式 | 验收标准 | 缺失后果 | 本机状态 |
|---|---|---|---|---|---|---|
| O-1 | 天气 API key | 环境注入第 ③ 片（`weather`） | 和风天气免费版 / OpenWeatherMap 免费额度，写入 `WEATHER_API_KEY` | `WEATHER_API_KEY` 非空时 `/api/health` 的 `weather: true` | **不做天气注入**：播报里不出现天气，`context.js` 用「今天」兜底文案，其余功能不受影响 | 未配置（`WEATHER_API_KEY=` 为空，属预期） |
| O-2 | 额外 edge-tts 音色试听 | `zh-CN-YunyangNeural`（新闻感）等 8 个中文音色可切换 | `npm run tts:list-voices` | 挑定音色后写入 `TTS_VOICE` | 用默认 `Xiaoxiao`，不影响功能 | 未挑选 |
| O-3 | Windows 神经语音包 | 改善 SAPI 兜底音质（`Q-02`） | 设置 → 时间和语言 → 语音 → 添加语音 | `Get-ChildItem 'HKLM:\SOFTWARE\Microsoft\Speech\Voices\Tokens'` 出现非 `Huihui` 的中文音色 | SAPI 只有 `Microsoft Huihui Desktop`，离线兜底音质机械 | 未安装（实测仅 Huihui） |
| O-4 | 无版权音乐来源账号 | 备更多兜底素材（见 §4.2） | Free Music Archive / ccMixter / Pixabay Music / Jamendo | 下载的授权说明与音频一起存 `data/fallback-audio/LICENSES.md` | 兜底池只有 5 首，重复感强 | 未准备 |
| O-5 | `7z` 或解压工具 | 只影响手工排查留存包 | 无需全局安装：用 `.zip`（`Compress-Archive` 内置） | `Compress-Archive -?` 可用 | 无影响（本项目统一用 zip） | 无全局 7z，**不阻塞** |
| O-6 | UPnP/DLNA 音箱 | F-11 的物理前提 | 已有设备即可 | 设备在同一局域网且支持 DLNA | F-11 无法验收（P2，允许） | 未确认 |

---

## 4. 素材准备指南：本地兜底音频

### 4.1 为什么必须由你准备

`data/fallback-audio/` 是 `D-08`「电台核心体验是一直在响」的**最后一道防线**（设计总览 §5.2）：当公共音乐 API 全源失败（`Q-01` 已经实测到 4 个源不可用），唯一的音频来源就是你放在这里的文件。**项目代码不会自带任何音乐文件**——这既是版权要求，也是体积要求。

### 4.2 无版权 / 自有来源建议

| 来源 | 授权 | 备注 |
|---|---|---|
| Free Music Archive (freemusicarchive.org) | CC-BY / CC-BY-NC / CC0 混合，逐首看 | 按授权筛选，CC-BY 需保留署名 |
| ccMixter (ccmixter.org) | CC 系列 | 适合器乐、氛围 |
| Pixabay Music | Pixabay License，可商用免署名 | 下载最省事，音质够 |
| Jamendo（免费区） | CC 系列 | 曲库大 |
| YouTube Audio Library | 免费音乐库，免版税 | 需登录 |
| **你自己录的 / 你买的** | 自有 | 最安全，且「私人电台」场景天然合适 |

> 纪律（对齐设计总览 §9 版权条）：**只放你有权使用的音频**。不要把流媒体平台下载的歌曲放进这个目录——那会让「本地兜底」变成「本地留存」，越过本期明确不做的红线。

### 4.3 命名规范

推荐（**不强制**，但强烈建议——`doctor` 会用它给出更好提示）：

```
<两位序号>-<情绪档>-<短名>.mp3
```

| 段 | 取值 | 说明 |
|---|---|---|
| 序号 | `01` ~ `99` | 决定兜底池的稳定顺序（不依赖文件系统返回顺序） |
| 情绪档 | `calm` `focus` `low` `energize` `night` `any` | 与 [mood-rules.md](../knowledge/user/mood-rules.md) 的档位 ID 对齐，便于按情绪挑兜底曲 |
| 短名 | ASCII 小写 + 连字符 | 避免中文文件名带来的编码与 URL 转义问题 |

示例：

```
data/fallback-audio/
├─ 01-calm-rainy-piano.mp3
├─ 02-focus-ambient-loop.mp3
├─ 03-low-warm-guitar.mp3
├─ 04-energize-bright-synth.mp3
├─ 05-night-slow-strings.mp3
└─ LICENSES.md          # 每首的来源 URL + 授权类型 + 是否需要署名
```

### 4.4 格式要求

| 项 | 要求 | 理由 |
|---|---|---|
| 容器 | `.mp3`（首选）/ `.wav`（次选） | `staticAllowlist` 已包含这两者；`.wav` 体积大 10 倍左右 |
| 采样率 | 44.1 kHz 或 22.05 kHz | 浏览器兼容性最好 |
| 码率 | mp3 ≥ 128 kbps | 再低会有明显失真 |
| 声道 | 立体声或单声道均可 | — |
| 时长 | 60s ~ 6min | 太短频繁切歌，太长兜底场景显得卡住 |
| 单文件体积 | ≤ 15 MB | 兜底池总计控制在 100 MB 内，避免挤占 `data/` |
| 元数据 | 带 ID3 的 `title`/`artist` 更好 | PWA 的 MediaSession 能显示曲名而不是文件名 |
| 内容 | **无人声语音/播报** | 兜底播放时前面还会叠 DJ 的 `say`，避免两个声音打架 |

### 4.5 数量建议与验证

- **≥ 5 首**（硬门槛，`doctor` 判定依据）；8~12 首为舒适区；超过 20 首意义不大。
- 情绪覆盖面优先于数量：至少各 1 首覆盖 `calm` / `focus` / `energize`。

```powershell
# 验证 1：数量与格式
Get-ChildItem data\fallback-audio -File |
  Where-Object { $_.Extension -in '.mp3','.wav' } |
  Select-Object Name, @{n='MB';e={[math]::Round($_.Length/1MB,2)}}
# 期望：≥ 5 行，且每行 MB ≤ 15

# 验证 2：能被浏览器播放（起服务后）
#   打开 http://localhost:8080/fallback-audio/01-calm-rainy-piano.mp3 —— 应能直接播放

# 验证 3：走一遍兜底链路（把音乐 API 指到死地址，强制兜底）
$env:MUSIC_BASE_URL='http://127.0.0.1:1/api.php'; npm start
#   期望：触发一次播报，日志出现 "music.resolve exhausted → fallback-audio"，
#         浏览器实际响起 fallback-audio 里的音频，而不是静音
```

---

## 5. 验收清单（Definition of Done）

> 全部是**可观测行为**，不是代码完成度。三级递进：能跑起来 → 能用 → 好用。
> 建议做成 `docs/` 下的勾选记录，每个里程碑结束前跑一遍对应档位。

### 5.1 第一级：能跑起来（L1，10 项）

- [ ] L1-1 `npm install` 退出码 0，`node_modules/` 生成，无 `npm ERR!`
- [ ] L1-2 `npm run doctor` 退出码 0，且输出的**必需**检查项全为 `PASS`
- [x] L1-3 `npm run validate:all` 退出码 0（`playlists.json` 结构、曲目格式、配置引用均无悬空）—— **`validate:playlists` 部分已通过**：11 个歌单 / 70 首曲目格式合规、无悬空引用；`validate-config`（M0-T5）待建
- [ ] L1-4 `npm run db:migrate` 退出码 0，`data/radio.db` 存在，四表 `messages` `plays` `plan` `prefs` 均存在
- [x] L1-5 `npm run brain:smoke` 打印一次真实 `DjAction` JSON（含 `say` / `play` / `reason`），并打印单轮耗时 —— **已通过，实测 6320ms**；`tools/brain-smoke.js` 已实现，断言进程层（退出码 0）、事件流契约（NDJSON / `session` / `turn_end` / `final` / `reason=completed`）与 DjAction 四字段
- [ ] L1-6 `npm run tts:list-voices` 列出中文音色；`npm run tts:warm` 在 `data/tts-cache/` 生成至少 1 个 `.mp3`，用播放器能听到人声
- [ ] L1-7 `npm run music:check` 对 `netease` 与 `joox` 均报可用；`npm run music:resolve -- "李志 - 下雨"` 输出可播放直链
- [ ] L1-8 `npm start` 后浏览器打开 `http://localhost:8080` 能看到 PWA 界面（三个视图可切换）
- [ ] L1-9 `npm test` 退出码 0，且**全程无出网**（用 `MUSIC_BASE_URL=http://127.0.0.1:1/` 跑一遍仍全绿）
- [ ] L1-10 日志文件出现在 `data/logs/`，`LOG_PROMPT=0` 时日志中不含语料原文与对话全文

### 5.2 第二级：能用（L2，10 项）

- [ ] L2-1 在 Profile 页输入「来点适合下雨天的歌」，**10s 内**听到一句播报，播报说完后自动开始放歌（F-01）
- [ ] L2-2 播报与音乐之间**无重叠、无空档**，切换间隔 ≤ 800ms（F-04）
- [ ] L2-3 连续点播 5 次，24 小时内不出现重复曲目（F-05）
- [ ] L2-4 点「跳过」后立即切下一首，`plays` 表新增一条标记为 `skip` 的记录（F-08）
- [ ] L2-5 打开两个浏览器窗口，任一窗口触发播放，另一个窗口 500ms 内显示同一首（F-06）
- [ ] L2-6 `GET /api/plan/today` 返回当日各时段规划，每条都有非空 `reason`（F-07）
- [ ] L2-7 编辑 `knowledge/user/taste.md` 保存，**不重启服务**，30s 后再点播，日志（`LOG_PROMPT=1` 时）显示新语料已进 prompt（F-09）
- [ ] L2-8 把 `MUSIC_BASE_URL` 指向不可达地址后重启，点播仍能出声——播的是 `data/fallback-audio/` 里的曲目（F-10 的音频部分）
- [ ] L2-9 把 `CLAUDIAO_EDGE_TTS_BIN` 指向不存在的路径后重启，点播变成「只放歌不说话」，且在日志里能看到 TTS 降级告警（设计总览 §5.2）
- [ ] L2-10 kill 掉 node 进程再 `npm start`，`GET /api/now` 仍能返回崩溃前的播放历史（N-06）

### 5.3 第三级：好用（L3，10 项）

- [ ] L3-1 连续 20 首推荐符合 `taste.md` + `mood-rules.md` 的比例 ≥ 80%（F-03）
- [ ] L3-2 定时播报实际触发时间与配置误差 ≤ 60s（F-02）
- [ ] L3-3 10 分钟内两次触发同一 slot，第二次被标记 `succeeded` 幂等命中，不重复发声（§8.2）
- [ ] L3-4 模拟唤醒补跑：把系统时间/`SLOT_TIME_SCALE` 调到过点后，服务在 `graceMinutes` 窗口内完成补跑，超窗则标记 `skipped`
- [ ] L3-5 09:15–12:00 与 14:00–17:30 专注窗口内，**没有任何主动播报**（`protectedWindows` 生效）
- [ ] L3-6 23:00–07:00 静默时段无主动发声；但此时在 PWA 发消息仍能正常得到响应
- [ ] L3-7 连续 3 次跳过之后，下一首明显切换了情绪档位（`consecutiveSkipsBeforeSwitch`）
- [ ] L3-8 手机浏览器打开 `http://<局域网IP>:8080?token=<令牌>`，能播放；不带 token 访问被拒（§9）
- [ ] L3-9 断掉外网后刷新 PWA，界面仍能打开（Service Worker 壳层命中）（F-10）
- [ ] L3-10 连续运行 30 分钟：`node.exe` 工作集 ≤ 300MB，`data/tts-cache/` 体积增长收敛在 `ttsMaxBytes` 内（N-03）

---

## 6. 环境自检：`npm run doctor` 规格

> 本节是 [tools/doctor.js](../package.json) 的**实现规格**。要求：只读检查（唯一例外是第 6 项写探针，用完即删）、每项独立超时、**绝不因为某项失败而中止后续检查**、退出码 = 是否存在 `FAIL`（`WARN` 不影响退出码）。
> 输出格式：`[PASS|WARN|FAIL] <编号> <名称> — <实测值>｜<修复提示>`，末尾汇总 `PASS n / WARN n / FAIL n`。

| # | 检查项 | 判定方法 | 失败时的修复提示 |
|---|---|---|---|
| 1 | Node 版本 | `process.versions.node` 主版本 ≥ 20 | `升级 Node：winget install OpenJS.NodeJS.LTS`，然后重开终端 |
| 2 | `dsh` 可执行文件 | `fs.existsSync(CLAUDIAO_DSH_BIN)`；为 `.cmd` 时额外确认同目录存在 `dsh.js` 或 `dsh.ps1` | `检查 .env 的 CLAUDIAO_DSH_BIN；当前应为 C:\Users\wumingtao\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd` |
| 3 | `dj-brain` profile 存在 | `<DSH_HOME>/profiles/dj-brain/` 目录存在且含配置（`DSH_HOME` **不加前缀**，默认 `C:\Users\wumingtao\.dsh`）；另确认 `CLAUDIAO_DSH_PROFILE=dj-brain` 且 `CLAUDIAO_DSH_CWD` 指向项目根 | `运行 scripts\setup-brain-profile.ps1 重建 profile；确认 CLAUDIAO_DSH_PROFILE=dj-brain（不能是 desktop）` |
| 3b | **环境变量名冲突检测** | 检查 `.env` 或启动环境中是否存在**无前缀**的 `DSH_PROFILE` / `DSH_BIN` / `DSH_CWD`。若存在且与 `CLAUDIAO_*` 值不一致 → `FAIL` 并打印两个值；若存在但一致 → `WARN` | `删掉 .env 里的无前缀变量，改用 CLAUDIAO_DSH_BIN / CLAUDIAO_DSH_PROFILE / CLAUDIAO_DSH_CWD。DSH 自身会注入 DSH_PROFILE=desktop，重名会导致 error: profile "desktop" is managed exclusively by the Electron application` |
| 4 | 大脑可用（**可选深检**） | 仅当 `--deep` 时执行：spawn `CLAUDIAO_DSH_BIN --profile $CLAUDIAO_DSH_PROFILE --json` 发一句 `回复ok`，30s 超时，取 `final` 事件非空且退出码 0 | `先手动跑 npm run brain:smoke 定位：凭据过期请重新登录 dsh；报 profile "desktop" 说明变量名没加 CLAUDIAO_ 前缀；超时请检查网络` |
| 5 | Python 与 edge-tts | `CLAUDIAO_EDGE_TTS_BIN` 存在；`spawnSync(CLAUDIAO_EDGE_TTS_BIN, ['--version'])` 退出码 0 | `python -m pip install edge-tts；若 Python 不在 PATH，先 winget install Python.Python.3.12` |
| 6 | `data/` 目录可写 | 逐个子目录（`data/`、`data/tts-cache/`、`data/logs/`）执行「写 1 字节探针 → 读回比对 → 删除」，任一失败即 `FAIL` | `检查目录是否存在；New-Item -ItemType Directory -Force data\tts-cache, data\logs；若被占用请关闭正在播放的进程` |
| 7 | 磁盘剩余空间 | `statfs`/`wmic` 取 D: 剩余字节；≥ 5GB `PASS`，1~5GB `WARN`，< 1GB `FAIL` | `清理 D: 空间；或把 DB_PATH/TTS_CACHE_DIR 改到空间充足的盘` |
| 8 | 音乐 API 可达（search） | GET `{MUSIC_BASE_URL}?types=search&source=netease&name=test&count=1&pages=1`，5s 超时，返回可解析 JSON 即 `PASS` | `公共实例可能已失效：换实例或自建 NeteaseCloudMusicApi；同时确保 data/fallback-audio/ 已备好音频` |
| 9 | 音乐源逐个探测 | 对 `MUSIC_SOURCES` 每个源各发一次 search；全部可用 `PASS`；部分可用 `WARN` 并列出失败源；全失败 `FAIL` | `把失败源从 MUSIC_SOURCES 移除（实测 kuwo/tencent/migu/kugou 返回 400/503，不应启用）` |
| 10 | 音乐直链可用（`--deep`） | 用第 8 步的首个结果请求 `types=url`，`url` 字段非空且 `https://` 开头 | `该源可能限制码率或版权：把 MUSIC_BITRATE 降到 128 再试；或更换 source` |
| 11 | 兜底音频池 | `data/fallback-audio/` 下 `.mp3`/`.wav` 文件数 ≥ 5 且逐个体积 ≤ 15MB；< 5 首 `FAIL`，格式越界 `WARN` | `这是唯一需要你自备素材的一项，见 docs/09-requirements-checklist.md §4` |
| 12 | 语料文件完整性 | 检查 `knowledge/prompts/dj-persona.md`、`knowledge/user/{taste,routines,mood-rules}.md`、`playlists.json` 均存在且非空；再跑 `validate-playlists.js` 的核心校验 | `语料缺失时服务会用内置默认语料（degradation.defaultCorpusOnMissing），但 DJ 会失去个人特色` |
| 13 | 配置文件语法 | 用 `js-yaml` 解析 `config/radio.yml`、`config/routines.yml`、`config/calendar.yml`；用 `dotenv` 解析 `config/.env` | `检查 YAML 缩进（不允许 Tab）与 .env 中的引号配对` |
| 14 | 端口可用 | 尝试 `net.createServer().listen(PORT, HOST)`，`EADDRINUSE` 即 `FAIL` | `停掉占用进程：netstat -ano | findstr :8080 后 taskkill /PID <pid> /F；或改 .env 的 PORT` |
| 15 | 时区一致性 | `Intl.DateTimeFormat().resolvedOptions().timeZone` 与 `routines.yml.timezone` 一致 | `设置 .env 的 TZ=Asia/Shanghai，并确保 Windows 时区为 China Standard Time` |
| 16 | SQLite 原生模块 | 尝试 `new BetterSqlite3(':memory:')` 并 `select 1` | `重装原生模块：npm rebuild better-sqlite3；若失败，winget install Microsoft.VisualStudio.2022.BuildTools` |
| 17 | DB 完整性（存在时） | DB 文件存在则打开并跑 `PRAGMA integrity_check`，结果须为 `ok` | `从最近备份恢复：npm run backup 产出的 zip；或删除 radio.db 后重跑 npm run db:migrate` |
| 18 | 缓存容量 | 统计 `data/tts-cache/` 文件数与总字节；超 `ttsMaxFiles` 或 `ttsMaxBytes` 的 90% 报 `WARN` | `正常：LRU 会在启动时清理；若持续超限请下调缓存上限或提高清理频率` |
| 19 | 天气配置（可选项） | `WEATHER_API_KEY` 为空 → `WARN（未配置，将不做天气注入）`；非空但 `--deep` 请求失败 → `WARN` | `想要天气播报就填 key（和风/OpenWeatherMap 免费额度）；不填不影响其他功能` |
| 20 | 飞书 Webhook（可选项） | `FEISHU_WEBHOOK` 为空 → `WARN（未配置，无外部通知）`；非空则 `--deep` 发一条测试消息并检查 `StatusCode:0` | `不需要通知可忽略；需要则按 README 的群机器人步骤获取 Webhook` |

**doctor 与启动流程的关系**：`npm start` 在服务监听成功**之后**异步跑一次 doctor（不含 `--deep`），把 `FAIL` 项写日志并在 `/api/health` 暴露为 `doctor: { fail: [...], warn: [...] }`。**不因为 FAIL 拒绝启动**——`D-08` 要求电台尽量在响。

---

## 7. 交叉引用

- 里程碑排期与任务分解：[进度表](10-progress-tracker.md)
- 每项需求失败后的兜底与应急预案：[风险登记册](11-risk-register.md)
- 上述所有「测试用例」编号（E2E-xx、fixture 清单、门禁）：[测试策略](12-testing-strategy.md)
- 模块内部算法与错误处理：[模块详细设计](02-module-spec.md)
- 接口字段级契约：[接口契约与数据模型](03-api-contract.md)

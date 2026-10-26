# 部署与运维

> 目标：让电台像家用电器一样——开机就在，不用管，坏了能查。
> 关联：[快速开始](00-quick-start.md) · [设计总览](01-architecture-design.md) · [风险登记册](11-risk-register.md)

---

## 1. 部署形态

Claudiao 是一台**单进程常驻服务** + 一个**按需拉起的子进程**：

| 组件 | 形态 | 生命周期 |
|---|---|---|
| 电台服务 | Node 常驻进程，监听 `127.0.0.1:8080` | 开机自启，长期运行 |
| 大脑 | `dsh --profile dj-brain` 子进程 | **每次决策拉起一次**，用完即退（实测 5.4s） |
| TTS | 子进程调用 `edge-tts` / PowerShell SAPI | 每次合成拉起一次 |
| 浏览器 | 客户端 | 你打开/关闭 |

**没有容器、没有数据库服务、没有反向代理。** 这是刻意的：家用电台的运维成本必须接近零。

### 运行环境要求

| 项 | 要求 |
|---|---|
| OS | Windows 10/11 x64（本项目在 Windows 上实测） |
| Node | ≥ 20（本机 22.11.0） |
| Python | ≥ 3.10 + `edge-tts`（仅 TTS 需要） |
| 磁盘 | ≈ 1 GB（依赖 + TTS 缓存上限 500 MB + 日志） |
| 内存 | 常驻 ≤ 300 MB |
| 网络 | **仅音乐/天气查询需要出网**；大脑与 TTS 主要走本地（edge-tts 需联网，SAPI 不需要） |
| 端口 | 8080（可改） |

---

## 2. 首次部署

```powershell
cd D:\DJ
npm install                                  # 装依赖
Copy-Item config\.env.example config\.env    # 建配置
notepad config\.env                          # 确认 CLAUDIAO_DSH_BIN / CLAUDIAO_DSH_CWD
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\setup-brain-profile.ps1 -Verify
npm run doctor                               # 全项自检
npm start                                    # 试运行
```

确认无误后 `Ctrl+C` 停掉，改成开机自启。

---

## 3. 开机自启

### 方案 A：任务计划程序（推荐）

优点：无需第三方工具、支持开机即启、崩溃后可配置重启、以当前用户身份运行（**必须**——因为要复用 `~/.dsh` 的账号态与 profile）。

```powershell
# 以管理员身份运行 PowerShell
$taskName = 'Claudiao Radio'
$node     = (Get-Command node).Source
$script   = 'D:\DJ\src\server.js'
$workdir  = 'D:\DJ'

$action = New-ScheduledTaskAction -Execute $node -Argument "`"$script`"" -WorkingDirectory $workdir
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -RestartCount 3 `
    -ExecutionTimeLimit (New-TimeSpan -Days 0)   # 0 = 不限时

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Force
```

管理：

```powershell
Start-ScheduledTask  -TaskName 'Claudiao Radio'
Stop-ScheduledTask   -TaskName 'Claudiao Radio'
Get-ScheduledTaskInfo -TaskName 'Claudiao Radio' | Select-Object LastRunTime,LastTaskResult,NumberOfMissedRuns
Unregister-ScheduledTask -TaskName 'Claudiao Radio' -Confirm:$false   # 卸载自启
```

> ⚠️ **不要**勾选「不管用户是否登录都要运行」——那会以 SYSTEM 身份运行，
> 读不到你的 `~/.dsh/.credentials.yaml`，大脑会报 `MISSING_CREDENTIAL`。

### 方案 B：启动文件夹（最简单）

```
Win+R → shell:startup → 放入一个 start-radio.cmd
```

```bat
@echo off
cd /d D:\DJ
node src\server.js >> data\logs\service.log 2>&1
```

缺点：无自动重启、无运行状态查询。

### 方案 C：NSSM 注册为 Windows 服务

适合想让电台在**未登录**时也运行。但同样会遇到凭据身份问题 —— 需要把 `~/.dsh` 
整个复制到服务账户的家目录，并在那边重新登录一次 DSH。**不推荐**，除非你有明确需求。

---

## 4. 日常运维

### 4.1 健康检查

```powershell
# 详细健康状态
curl http://127.0.0.1:8080/api/health | ConvertFrom-Json | Format-List

# 期望看到
#   ok            : True
#   brain.ok      : True
#   tts.ok        : True
#   music.ok      : True
#   scheduler.slots: 8
#   db.plays      : <累计播放数>
```

`/api/health` 在 `config/radio.yml` 的 `observability.healthDetail: true` 时返回各子系统细节；
设为 `false` 则只返回 `{ok: true}`（对外暴露时应该关掉）。

### 4.2 日志

```
data/logs/
├─ radio-2026-10-15.log      # 主日志（按天轮转，保留 14 天）
├─ error-2026-10-15.log      # 仅错误
└─ service.log               # 若用方案 B 启动，stdout 汇总在此
```

日志级别由 `LOG_LEVEL` 控制：`debug | info | warn | error`。

**隐私约束**：默认 `LOG_PROMPT=0`，日志**不记录 prompt 全文**（含你的品味语料与对话），
只记录长度与内容哈希。调试时才临时打开：

```powershell
$env:LOG_PROMPT=1; npm start   # 仅本次会话，别写进 .env
```

常用查询：

```powershell
# 看最近的大脑调用耗时与 token 用量
Select-String -Path data\logs\radio-*.log -Pattern 'brain\.call' | Select-Object -Last 20

# 看降级事件（最需要关注的信号）
Select-String -Path data\logs\radio-*.log -Pattern 'degraded|fallback|breaker'

# 看定时槽位的执行结果
Select-String -Path data\logs\radio-*.log -Pattern 'slot=' | Select-Object -Last 30
```

### 4.3 状态库

```powershell
# 播放统计
node -e "const db=require('better-sqlite3')('data/radio.db'); console.table(db.prepare('SELECT COUNT(*) AS plays FROM plays').all());"

# 备份（见 §5）
npm run backup
```

### 4.4 TTS 缓存

```powershell
# 缓存占用
node -e "const fs=require('fs');const d='data/tts-cache';const f=fs.readdirSync(d);console.log(f.length+' 个文件, '+(f.reduce((s,n)=>s+fs.statSync(d+'/'+n).size,0)/1048576).toFixed(1)+' MB');"

# 预热（把常用播报模板提前合成，减少首次延迟）
npm run tts:warm

# 清空缓存（换音色后建议做）
Remove-Item data\tts-cache\* -Force
```

> 换 `TTS_VOICE` **不需要**手动清缓存 —— 缓存键包含音色参数（设计决策 D-07），
> 换音色会自动走新键，旧缓存由 LRU 自然淘汰。

### 4.5 语料热更新

编辑 `knowledge/user/*.md` 或 `knowledge/prompts/dj-persona.md` 后：

- **不需要重启**。`context.js` 按内容哈希做缓存失效，最迟 `config/radio.yml` 的
  `cache.corpusWatchIntervalSeconds`（默认 30s）后生效。
- `playlists.json` 改完建议先校验，避免手写 JSON 语法错误导致大脑拿到坏语料：

```powershell
npm run validate:playlists
```

### 4.6 音乐源健康

```powershell
npm run music:check      # 逐 endpoint 探测（search / url / lyric / pic / playlist）
npm run music:resolve "李志 - 下雨"   # 端到端验证「艺人 - 曲名」解析链路
```

公共实例可能随时失效（见 [风险登记册](11-risk-register.md)）。`music:check` 是你判断
「是 API 挂了还是我代码坏了」的第一手段。

---

## 5. 备份与恢复

### 需要备份什么

| 项 | 路径 | 重要性 | 说明 |
|---|---|---|---|
| **语料** | `knowledge/` | ⭐⭐⭐ | 电台的灵魂。丢了等于电台失忆 |
| **配置** | `config/.env` `config/*.yml` | ⭐⭐⭐ | 含密钥与调参 |
| **状态库** | `data/radio.db` | ⭐⭐ | 播放历史与记忆 |
| **大脑 profile** | `~/.dsh/profiles/dj-brain/` | ⭐⭐ | 可重建（有脚本），但备份更省事 |
| TTS 缓存 | `data/tts-cache/` | ⭐ | 可再生，不必备份 |
| 依赖 | `node_modules/` | ❌ | 用 `package.json` 重装 |

### 备份

```powershell
npm run backup
# 产出: data/backups/claudiao-2026-10-15T12-00-00.zip
```

`tools/backup.js` 会打包 `knowledge/`、`config/`、`data/radio.db`（用 SQLite 的
`VACUUM INTO` 做一致性快照，**不要**在运行时直接复制 `.db` 文件）、以及
`~/.dsh/profiles/dj-brain/`。

### 恢复

```powershell
Expand-Archive data\backups\claudiao-<时间戳>.zip -DestinationPath D:\ -Force
# 然后重跑大脑 profile 校验
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\setup-brain-profile.ps1 -Verify
```

---

## 6. 升级

### 升级本项目代码

```powershell
Stop-ScheduledTask -TaskName 'Claudiao Radio'
cd D:\DJ
git pull                    # 或手动替换文件
npm install                 # 依赖可能变了
npm run db:migrate          # 状态库结构可能变了（幂等）
npm run validate:all
npm run doctor
Start-ScheduledTask -TaskName 'Claudiao Radio'
```

### 升级 DeepSeek Harness（会影响大脑）

**这是最需要警惕的升级**：`dsh` 的 CLI 契约（`--json` 事件格式、退出码语义）是本项目的
外部依赖。DSH 升级后必须回归验证：

```powershell
npm run brain:smoke
```

`brain:smoke` 会跑一轮真实调用并断言：退出码 0、`final` 事件存在、JSON 可解析出四个字段。
**如果它失败，先别重启电台服务** —— 电台会在每次决策时降级到模板播报（不会崩，但会变傻）。

DSH 是随桌面端升级的。要回退，重装旧版桌面端即可，`dj-brain` profile 不受影响。

---

## 7. 故障排查手册

### 7.1 电台完全不响应

```powershell
# 1) 进程在不在
Get-Process node -ErrorAction SilentlyContinue | Select-Object Id,StartTime,@{n='MB';e={[int]($_.WorkingSet64/1MB)}}

# 2) 端口在不在听
Get-NetTCPConnection -LocalPort 8080 -State Listen -ErrorAction SilentlyContinue

# 3) 健康检查
curl http://127.0.0.1:8080/api/health

# 4) 看错误日志
Get-Content data\logs\error-*.log -Tail 50
```

### 7.2 有播报但没声音（浏览器侧）

| 检查 | 做法 |
|---|---|
| autoplay 是否解锁 | 页面应有「点一下开始收听」；未点则所有播放被静默拦截 |
| 音频文件是否真的生成 | `Get-ChildItem data\tts-cache\ | Select-Object -Last 5` 应看到新文件 |
| 直链是否可播 | 复制 `/api/now` 返回的 `audioUrl` 到浏览器地址栏直接打开 |
| 浏览器控制台 | F12 看是否有 `NotAllowedError`（autoplay）或 `NotSupportedError`（格式） |

### 7.3 播报声音突然变机械

说明 `edge-tts` 失败、降级到了 SAPI 的 `Huihui` 音色。

```powershell
edge-tts --list-voices        # 能列出说明 edge-tts 本身可用
edge-tts --voice zh-CN-XiaoxiaoNeural --text "测试" --write-media $env:TEMP\t.mp3
```

若 `edge-tts` 报网络错误，是微软服务不可达或被限流；恢复前会一直用 SAPI 兜底
（`TTS_BREAKER_THRESHOLD` 控制熔断阈值）。这是**设计内的降级**，不是故障。

### 7.4 音乐全部放不出来

```powershell
npm run music:check
```

- 若 `search` 失败 → 实例挂了或改了接口，换 `MUSIC_BASE_URL`，或先用兜底音频
- 若 `search` 成功但 `url` 失败 → 该曲目版权受限（VIP/下架），属正常情况，会跳到下一首候选
- 若全部候选都失败 → 会播放 `data/fallback-audio/`，检查该目录是否有音频

### 7.5 大脑报凭据错误

```
MISSING_CREDENTIAL: llm-deepseek: no API key for provider route "deepseek-official"
```

说明用错了 profile。检查：

```powershell
Select-String -Path config\.env -Pattern 'CLAUDIAO_DSH_PROFILE'   # 应为 dj-brain
Get-Content "$env:USERPROFILE\.dsh\profiles\dj-brain\cordis.patch.yml" | Select-String 'provider'
# 应为 provider: deepseek-account
```

修复：`powershell -NoProfile -ExecutionPolicy Bypass -File scripts\setup-brain-profile.ps1 -Force -Verify`

### 7.5.1 大脑报 profile 被 Electron 独占

```
error: profile "desktop" is managed exclusively by the Electron application
```

**原因**：变量名冲突。DeepSeek Harness 自身会注入 `DSH_PROFILE=desktop`，如果本项目也用
`DSH_PROFILE` 这个名字，`.env` 的值会被静默覆盖（`.env` 通常不会覆盖已存在的环境变量）。

**修复**：确认 `config/.env` 用的是带前缀的名字，并且**没有**同时保留旧的裸名：

```powershell
Select-String -Path config\.env -Pattern '^DSH_'    # 应该没有任何输出
Select-String -Path config\.env -Pattern '^CLAUDIAO_DSH_'   # 应有三行
```

正确的三个变量是 `CLAUDIAO_DSH_BIN`、`CLAUDIAO_DSH_PROFILE`、`CLAUDIAO_DSH_CWD`。

### 7.6 定时播报不响

按这个顺序查：

1. **是不是静默时段？** `config/routines.yml` 的 `quietHours`（默认 23:00–07:00）
2. **是不是免打扰窗口？** `doNotDisturb` 与 `protectedWindows`
3. **是不是已经触发过了？** 幂等键 `<date>|<slot>`，同一天同一 slot 只成功一次
4. **是不是被熔断？** 连续失败/跳过 `consecutiveFailureBreaker`（默认 3）次后当日停止
5. **是不是超过每日上限？** `dailyMaxBroadcasts`（默认 8）
6. **日志里那个 slot 是什么状态？**

```powershell
Select-String -Path data\logs\radio-*.log -Pattern 'slot=morning' | Select-Object -Last 10
# 关注状态: succeeded / skipped / failed，以及 reason
```

### 7.7 系统休眠后定时错乱

这是**已知且已在设计内处理**的问题：`setTimeout` 在休眠期间会漂移，所以调度器用的是
「每分钟 tick + 时间窗判定」而不是精确定时器（见 [调度与节律](07-scheduler-rhythm.md)）。

唤醒后的补跑行为由 `config/routines.yml` 的 `wakeCatchUp` 控制：

- 在 `graceMinutes` 宽限窗口内 → 补跑
- 超过窗口 → 标记 `skipped`，**不补一个过时的播报**（早上十点半不该听到「早上好」）

若你希望完全禁用补跑：设 `wakeCatchUp.enabled: false`。

### 7.8 磁盘写满

```powershell
# 看 data/ 占用
Get-ChildItem data -Recurse -File | Measure-Object -Property Length -Sum | ForEach-Object { "{0:N1} MB" -f ($_.Sum/1MB) }
```

主要由 TTS 缓存与日志构成。上限分别在 `config/.env` 的 `TTS_CACHE_MAX_BYTES`
与 `LOG_MAX_FILES`。清理：

```powershell
Remove-Item data\tts-cache\* -Force
Remove-Item data\logs\*.log -Exclude (Get-Date -Format 'yyyy-MM-dd') -Force
```

---

## 8. 可观测性

### 关键指标（`/api/health` 与日志）

| 指标 | 健康阈值 | 恶化含义 |
|---|---|---|
| `brain.lastLatencyMs` | < 15000 | 接近 `BRAIN_TIMEOUT_MS`（30s）说明该调参或排查网络 |
| `brain.failureRate1h` | < 5% | 上升说明 DSH 契约变了或凭据有问题 |
| `brain.degradedCount24h` | < 3 | 每次降级用户都会听到模板播报而非 DJ 的话 |
| `tts.cacheHitRate` | > 70% | 过低说明播报文本重复度低或缓存被频繁清 |
| `tts.breakerOpen` | false | true 说明 edge-tts 持续失败 |
| `music.resolveFailureRate1h` | < 20% | 上升说明公共实例劣化或版权收紧 |
| `scheduler.skipped24h` | 视情况 | 大量 skipped 可能是静默/免打扰配置过于激进 |

### 每日总结

`config/radio.yml` 的 `observability.dailySummaryAt`（默认 23:50）会把当日统计写回
`state.db`，并可选推送到飞书（若配了 `FEISHU_WEBHOOK`）：

```
[Claudiao 日报] 2026-10-15
播放 47 首 · 跳过 6 首 · 跳过率 12.8%
主动播报 6 次（morning/noon/evening/hourly×3）
大脑调用 23 次 · 平均 6.2s · 降级 0 次
TTS 合成 31 条 · 缓存命中 18 条（58%）
音乐解析失败 2 首（版权受限）
```

---

## 9. 安全运维清单

- [ ] `HOST=127.0.0.1`（本机自用）或已设置强 `RADIO_AUTH_TOKEN`（局域网/远程）
- [ ] `config/.env` 未被提交（`.gitignore` 已忽略，确认没被 `-f` 强加）
- [ ] `security.protectTtsRoutes` 按需设置（对外暴露时应为 `true`）
- [ ] `observability.healthDetail` 对外暴露时应为 `false`
- [ ] `LOG_PROMPT` 保持 `0`
- [ ] 定期检查 `data/logs/` 里是否意外出现了语料内容
- [ ] 若改了 `HOST=0.0.0.0`，确认防火墙只放行了局域网网段

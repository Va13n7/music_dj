<#
.SYNOPSIS
    创建 / 修复 Claudiao 电台所需的 dsh 无头大脑 profile。

.DESCRIPTION
    电台的「大脑」是 DeepSeek Harness 的一个自定义 profile（默认名 dj-brain），
    它以无头一问一答方式运行，并走 deepseek-account 账号态（复用桌面端登录），
    因此**不需要额外的 API key**。

    本脚本是幂等的：重复运行只会覆盖 profile 文件，不会报错。

    为什么不能直接用内置的 headless profile？
      内置 headless 的 agent-default-model 指向 provider `deepseek-official`，
      那条路需要 DEEPSEEK_API_KEY。dj-brain 覆盖为 `deepseek-account`，
      复用 ~/.dsh/.credentials.yaml 里的账号态，这才是零成本运行的关键。

.PARAMETER Name
    profile 名，默认 dj-brain。改了这里要同步改 config/.env 的 DSH_PROFILE。

.PARAMETER Force
    已存在时也覆盖。

.EXAMPLE
    pwsh -File scripts\setup-brain-profile.ps1

.EXAMPLE
    pwsh -File scripts\setup-brain-profile.ps1 -Verify
#>
[CmdletBinding()]
param(
    [string]$Name = 'dj-brain',
    [switch]$Force,
    [switch]$Verify
)

$ErrorActionPreference = 'Stop'

# ---------- 定位 $DSH_HOME ----------
$dshHome = $env:DSH_HOME
if ([string]::IsNullOrWhiteSpace($dshHome)) {
    $dshHome = Join-Path $env:USERPROFILE '.dsh'
}
$profileDir = Join-Path (Join-Path $dshHome 'profiles') $Name

Write-Host "dsh home   : $dshHome"
Write-Host "profile dir: $profileDir"

if ((Test-Path $profileDir) -and -not $Force) {
    Write-Host "profile 已存在。使用 -Force 覆盖，或直接 -Verify 校验。" -ForegroundColor Yellow
} else {
    New-Item -ItemType Directory -Force -Path $profileDir | Out-Null
    Write-Host "已创建目录。" -ForegroundColor Green
}

# ---------- 写 profile 文件 ----------
# 注意：必须用 UTF-8 无 BOM 写入。PowerShell 的 Set-Content -Encoding UTF8
# 在 Windows PowerShell 5.1 下会写入 BOM，导致 dsh 解析 package.json 失败
# （SyntaxError: Unexpected token ''）。用 .NET API 显式指定无 BOM。
function Write-Utf8NoBom {
    param([string]$Path, [string]$Content)
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($Path, $Content, $utf8NoBom)
}

$manifest = @'
{
  "name": "dsh-profile-dj-brain",
  "private": true,
  "dependencies": {},
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-headless"
      ]
    }
  }
}
'@

$root = @'
# dsh profile root — an empty entry list. The tree is composed as patches:
# each bundle in package.json's dsh.profile.bundles, then cordis.patch.yml.
# Edit cordis.patch.yml, not this file.
[]
'@

$patch = @'
# DJ brain profile — headless one-shot runner over the DeepSeek account route.
# This profile is the "BRAIN" box of the Claudiao blueprint: it replaces
# `claude -p --output-json` with a local `dsh --profile dj-brain --json` call.
#
# Why bundle dsh-base AND dsh-headless:
#   dsh-headless is a *patch* over dsh-base (it targets entries like
#   system-prompt, tools, hmr). Without dsh-base the patch has nothing to
#   target and the runner never activates.
#
# Why provider deepseek-account instead of deepseek-official:
#   deepseek-official requires DEEPSEEK_API_KEY; deepseek-account reuses the
#   signed-in desktop account state in ~/.dsh/.credentials.yaml.
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: deepseek-account
    model: deepseek-flash
    reasoningEffort: max
- id: system-prompt
  name: "@deepseek-ai/dsh-system-prompt"
  config:
    personaPrefix: "You are Claudiao, a personal AI radio DJ. You always answer with one JSON object only: {say, play[], reason, segue}."
'@

$workspace = @'
packages: []
'@

Write-Utf8NoBom (Join-Path $profileDir 'package.json')       $manifest
Write-Utf8NoBom (Join-Path $profileDir 'cordis.yml')         $root
Write-Utf8NoBom (Join-Path $profileDir 'cordis.patch.yml')   $patch
Write-Utf8NoBom (Join-Path $profileDir 'pnpm-workspace.yaml') $workspace

Write-Host "已写入 4 个 profile 文件（UTF-8 无 BOM）。" -ForegroundColor Green

# ---------- 校验 ----------
if ($Verify) {
    Write-Host "`n=== 校验：dump 组合后的配置 ===" -ForegroundColor Cyan
    $dshBin = Join-Path (Split-Path $PSScriptRoot -Parent) 'x' # placeholder
    # 从 config/.env 读 CLAUDIAO_DSH_BIN，读不到就提示手动校验
    $envFile = Join-Path (Split-Path $PSScriptRoot -Parent) 'config\.env'
    if (Test-Path $envFile) {
        $line = Select-String -Path $envFile -Pattern '^\s*CLAUDIAO_DSH_BIN\s*=' | Select-Object -First 1
        if ($line) { $dshBin = ($line.Line -split '=', 2)[1].Trim() }
    }
    if (-not (Test-Path $dshBin)) {
        Write-Host "未找到 dsh 可执行文件（CLAUDIAO_DSH_BIN=$dshBin）。" -ForegroundColor Yellow
        Write-Host "请在 config\.env 中设置 CLAUDIAO_DSH_BIN，或手动校验：" -ForegroundColor Yellow
        Write-Host "  dsh --profile $Name --dump-config | Select-String 'agent-default-model' -Context 0,5"
        exit 0
    }

    & $dshBin --profile $Name --dump-config 2>&1 |
        Select-String -Pattern 'agent-default-model' -Context 0,5

    Write-Host "`n=== 校验：无头一问一答 ===" -ForegroundColor Cyan
    'Reply with exactly this JSON and nothing else: {"say":"ok","play":[],"reason":"smoke","segue":""}' |
        & $dshBin --profile $Name 2>$null
    Write-Host "退出码: $LASTEXITCODE （0 表示大脑可用）" -ForegroundColor Green
}

Write-Host "`n完成。下一步：" -ForegroundColor Green
Write-Host "  1) 确认 config\.env 中 CLAUDIAO_DSH_BIN 指向 dsh.cmd 的绝对路径"
Write-Host "  2) 确认 config\.env 中 CLAUDIAO_DSH_PROFILE=$Name"
Write-Host "  3) 运行 npm run brain:smoke 做一次冒烟"

#!/usr/bin/env node
/**
 * doctor —— 电台环境自检。
 *
 * 对应 docs/00-quick-start.md §0 与 docs/09-requirements-checklist.md §6。
 * 逐项检查并给出**可执行的修复提示**，不因失败而中断（一次跑完，列出全部问题）。
 *
 * 设计原则：
 *   - 只读。不改任何文件、不装任何依赖、不写数据库。
 *   - 分级：FAIL 会阻塞运行；WARN 影响体验但能跑；INFO 提示性。
 *   - 一切检查都要能在 5 秒内完成（除了显式的 --deep）。
 *
 * 退出码: 0 无 FAIL / 1 有 FAIL
 *
 * 用法:
 *   node tools/doctor.js
 *   node tools/doctor.js --deep      # 额外做真实的 API / 合成探测（较慢）
 *   node tools/doctor.js --json      # 机器可读输出
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ZcodeAgentAdapter } from '../src/adapters/brain/zcode-agent.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARGV = process.argv.slice(2);
const DEEP = ARGV.includes('--deep');
const AS_JSON = ARGV.includes('--json');

const results = [];
const add = (level, id, title, detail, fix) => {
  results.push({ level, id, title, detail: detail || '', fix: fix || '' });
};

function loadEnv() {
  const out = { ...process.env };
  const f = path.join(ROOT, 'config', '.env');
  if (!fs.existsSync(f)) return out;
  for (const raw of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 0) continue;
    const k = line.slice(0, i).trim();
    const v = line.slice(i + 1).trim().replace(/^["']|["']$/g, '');
    if (!(k in out) || !out[k] || k.startsWith('CLAUDIAO_')) out[k] = v;
  }
  return out;
}
const env = loadEnv();

/** 同步跑一个命令，返回 {ok, out} */
function run(cmd, args = [], timeout = 8000) {
  try {
    const r = spawnSync(cmd, args, {
      encoding: 'utf8', timeout, shell: process.platform === 'win32',
      windowsHide: true,
    });
    return { ok: r.status === 0, out: `${r.stdout || ''}${r.stderr || ''}`.trim(), status: r.status };
  } catch (e) {
    return { ok: false, out: e.message, status: -1 };
  }
}

// ───────────────────────── 1. 运行时 ─────────────────────────
function checkRuntime() {
  const nv = process.versions.node;
  const major = Number(nv.split('.')[0]);
  add(major >= 20 ? 'ok' : 'fail', 'node', 'Node.js ≥ 20',
    `v${nv}`,
    major >= 20 ? '' : '升级 Node.js 到 20 或更高：https://nodejs.org/');

  const npm = run('npm --version');
  add(npm.ok ? 'ok' : 'warn', 'npm', 'npm 可用', npm.ok ? `v${npm.out}` : '未找到 npm',
    npm.ok ? '' : '随 Node.js 一起安装');

  const py = run('python --version');
  add(py.ok ? 'ok' : 'warn', 'python', 'Python ≥ 3.10',
    py.ok ? py.out : '未找到 python',
    py.ok ? '' : 'TTS 需要 Python。安装后执行: python -m pip install edge-tts');
}

// ───────────────────── 2. 大脑（BRAIN = ZCode Agent）─────────────────────
function checkBrain() {
  const adapter = new ZcodeAgentAdapter({ root: ROOT, env });
  const nodeVer = process.versions.node.split('.').map(Number);
  const nodeOk = nodeVer[0] > 22 || (nodeVer[0] === 22 && nodeVer[1] >= 5);

  if (!nodeOk) {
    add('fail', 'brain-node', 'Node ≥ 22.5（需要内置 node:sqlite）', `当前 ${process.versions.node}`,
      '升级 Node 后重跑');
  } else {
    add('ok', 'brain-node', `Node ${process.versions.node}（node:sqlite 可用）`);
  }

  if (!fs.existsSync(adapter.cliPath)) {
    add('fail', 'brain-cli-missing', 'ZCode CLI (zcode.cjs) 不存在', adapter.cliPath,
      '确认 ZCode 桌面端已安装，或在 config/.env 设置 CLAUDIAO_ZCODE_CLI');
    return;
  }
  add('ok', 'brain-cli', 'ZCode CLI 存在', adapter.cliPath);

  if (!adapter.builtinConfigFile || !fs.existsSync(adapter.builtinConfigFile)) {
    add('fail', 'brain-builtin-missing', '未找到桌面端缓存的 zcode-builtin.json',
      '~/.zcode/v2/runtime/provider/<平台>/<版本>/endpoint-*/zcode-builtin.json',
      'ZCode 桌面端至少启动并登录过一次后重跑 doctor');
    return;
  }
  add('ok', 'brain-builtin', '内置 provider 模板（zcode-builtin.json）已定位',
    adapter.builtinConfigFile);

  const missing = adapter.availabilityDetail();
  const keyMissing = missing.some((m) => m.includes('API key'));
  if (keyMissing) {
    add('fail', 'brain-credentials', '编码计划凭据不可用', '',
      '确认 ZCode 桌面端已登录（bigmodel 编码计划），\n' +
      '    或在 config/.env 设置 CLAUDIAO_ZCODE_API_KEY');
    return;
  }
  add('ok', 'brain-credentials', '编码计划 API key（共享凭据解密成功）');

  add('ok', 'brain-provider', `provider = ${adapter.providerId}`, `${adapter.modelId} · reasoning=${adapter.reasoningLevel}`);

  const cwd = adapter.workspacePath;
  if (cwd !== ROOT) {
    add('warn', 'brain-cwd', 'CLAUDIAO_ZCODE_CWD 与项目根不一致', `${cwd} ≠ ${ROOT}`,
      '建议设为项目根（语料相对路径与会话目录都依赖它）');
  } else {
    add('ok', 'brain-cwd', 'CLAUDIAO_ZCODE_CWD = 项目根');
  }

  if (Number(env.BRAIN_TIMEOUT_MS || 30000) < 60000) {
    add('warn', 'brain-timeout', 'BRAIN_TIMEOUT_MS < 60s', `${env.BRAIN_TIMEOUT_MS || 30000} ms`,
      'ZCode Agent 实测单轮 12~20s（reasoning=low），建议 ≥ 60000');
  } else {
    add('ok', 'brain-timeout', `BRAIN_TIMEOUT_MS = ${env.BRAIN_TIMEOUT_MS} ms`);
  }
}

// ────────────────────── 3. 语音（TTS）──────────────────────
function checkTts() {
  const bin = env.CLAUDIAO_EDGE_TTS_BIN;
  if (bin && fs.existsSync(bin)) {
    const v = run(`"${bin}" --version`);
    add('ok', 'tts-edge', 'edge-tts 可用', `${bin}${v.out ? ` (${v.out.split('\n')[0]})` : ''}`);
  } else if (bin) {
    add('warn', 'tts-edge', 'CLAUDIAO_EDGE_TTS_BIN 指向的文件不存在', bin,
      'python -m pip install edge-tts   然后用 where edge-tts 确认路径');
  } else {
    add('warn', 'tts-edge', 'CLAUDIAO_EDGE_TTS_BIN 未设置', '',
      'python -m pip install edge-tts   然后 where edge-tts 填进 config/.env');
  }

  // SAPI 兜底
  const ps = run('powershell -NoProfile -Command "Add-Type -AssemblyName System.Speech; '
    + '(New-Object System.Speech.Synthesis.SpeechSynthesizer).GetInstalledVoices() | '
    + 'ForEach-Object { $_.VoiceInfo.Name + \'|\' + $_.VoiceInfo.Culture }"');
  if (ps.ok && ps.out) {
    const voices = ps.out.split('\n').map((s) => s.trim()).filter(Boolean);
    const zh = voices.filter((v) => /zh-CN/i.test(v));
    if (zh.length) {
      add('ok', 'tts-sapi', 'SAPI 兜底可用（中文音色）', zh.join(', '));
    } else {
      add('warn', 'tts-sapi', 'SAPI 无中文音色，兜底会念英文音色', voices.join(', '),
        '设置 TTS_FALLBACK_ENABLED=1 时，SAPI 失败会直接跳过语音放歌');
    }
  } else {
    add('warn', 'tts-sapi', 'SAPI 探测失败（不影响 edge-tts 主路径）', '');
  }

  // 缓存目录
  const cacheDir = path.join(ROOT, env.TTS_CACHE_DIR || 'data/tts-cache');
  try {
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.accessSync(cacheDir, fs.constants.W_OK);
    const n = fs.readdirSync(cacheDir).length;
    add('ok', 'tts-cache', 'TTS 缓存目录可写', `${cacheDir}（${n} 个文件）`);
  } catch (e) {
    add('fail', 'tts-cache', 'TTS 缓存目录不可写', e.message,
      `手动创建: New-Item -ItemType Directory -Force ${cacheDir}`);
  }
}

// ───────────────────── 4. 音乐（MUSIC）─────────────────────
async function checkMusic() {
  const base = env.MUSIC_BASE_URL || 'https://music-api.gdstudio.xyz/api.php';
  const sources = (env.MUSIC_SOURCES || 'netease,joox').split(',').map((s) => s.trim());

  if (!DEEP) {
    add('info', 'music-skip', '音乐 API 未探测（跳过）',
      `base=${base} sources=${sources.join(',')}`,
      '加 --deep 做真实探测，或单独运行: npm run music:check');
  } else {
    try {
      const url = `${base}?${new URLSearchParams({ types: 'search', source: sources[0], name: 'test', count: '1', pages: '1' })}`;
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 15000);
      const res = await fetch(url, { signal: ctl.signal });
      clearTimeout(t);
      add(res.ok ? 'ok' : 'warn', 'music-api', '音乐 API 可达',
        `${sources[0]} → HTTP ${res.status}`,
        res.ok ? '' : '公共实例可能限流或失效。详见 npm run music:check');
    } catch (e) {
      add('warn', 'music-api', '音乐 API 不可达', e.message,
        '电台仍可运行（走本地兜底音频），但选曲能力受限');
    }
  }

  // 兜底音频
  const fbDir = path.join(ROOT, env.FALLBACK_AUDIO_DIR || 'data/fallback-audio');
  try {
    fs.mkdirSync(fbDir, { recursive: true });
    const files = fs.readdirSync(fbDir).filter((f) => /\.(mp3|wav)$/i.test(f));
    if (files.length >= 5) {
      add('ok', 'fallback-audio', `兜底音频已就绪`, `${files.length} 个文件`);
    } else if (files.length > 0) {
      add('warn', 'fallback-audio', `兜底音频偏少（${files.length} 个，建议 ≥ 5）`,
        fbDir, '从少变多可避免连续降级时反复播同一首');
    } else {
      add('warn', 'fallback-audio', '兜底音频目录为空', fbDir,
        '这是**唯一需要你自备素材**的一项。音乐源全失败时靠它保证不静音。\n' +
        '    放入你自己拥有或 CC0 授权的 mp3/wav（≥5 首）。不准备也能跑，但降级时会只剩播报。');
    }
  } catch (e) {
    add('warn', 'fallback-audio', '兜底音频目录不可用', e.message);
  }
}

// ──────────────────── 5. 配置与语料 ────────────────────
function checkConfigAndCorpus() {
  // .env
  const envFile = path.join(ROOT, 'config', '.env');
  if (!fs.existsSync(envFile)) {
    add('fail', 'env-file', 'config/.env 不存在', '',
      'Copy-Item config\\.env.example config\\.env');
  } else {
    add('ok', 'env-file', 'config/.env 存在');
    const txt = fs.readFileSync(envFile, 'utf8');
    const legacy = ['DSH_BIN', 'DSH_PROFILE', 'DSH_CWD', 'CLAUDIAO_DSH_BIN']
      .filter((k) => new RegExp(`^\\s*${k}\\s*=`, 'm').test(txt));
    if (legacy.includes('CLAUDIAO_DSH_BIN')) {
      add('warn', 'env-legacy', 'config/.env 仍保留旧版 dsh 大脑配置',
        'CLAUDIAO_DSH_*（当前大脑为 ZCode Agent，dsh 配置已不生效）',
        '可删除 CLAUDIAO_DSH_* 段，或留作回滚参考');
    } else if (legacy.length) {
      add('fail', 'env-bare', 'config/.env 使用了无前缀的变量名', legacy.join(', '),
        '会被 DSH 自身注入的同名变量静默覆盖，改用 CLAUDIAO_ 前缀');
    } else {
      add('ok', 'env-bare', 'config/.env 变量名规范（带 CLAUDIAO_ 前缀）');
    }
  }

  // yml 配置
  for (const f of ['radio.yml', 'routines.yml', 'calendar.yml']) {
    const p = path.join(ROOT, 'config', f);
    if (fs.existsSync(p)) add('ok', `cfg-${f}`, `config/${f} 存在`);
    else add('warn', `cfg-${f}`, `config/${f} 缺失`, '', '从版本库恢复该文件');
  }

  // 语料
  const corpus = [
    ['knowledge/prompts/dj-persona.md', 'DJ 人格系统提示词'],
    ['knowledge/user/taste.md', '品味语料'],
    ['knowledge/user/routines.md', '作息语料'],
    ['knowledge/user/mood-rules.md', '情绪规则'],
    ['knowledge/user/playlists.json', '曲目池'],
  ];
  for (const [rel, name] of corpus) {
    const p = path.join(ROOT, rel);
    if (!fs.existsSync(p)) {
      add('fail', `corpus-${path.basename(rel)}`, `${name} 缺失`, rel,
        '语料是电台的灵魂，缺失会让 DJ 退化成通用推荐。从版本库恢复。');
    } else {
      const kb = (fs.statSync(p).size / 1024).toFixed(1);
      add('ok', `corpus-${path.basename(rel)}`, `${name} 存在`, `${kb} KB`);
    }
  }

  // playlists.json 结构校验
  const plPath = path.join(ROOT, 'knowledge/user/playlists.json');
  if (fs.existsSync(plPath)) {
    try {
      const j = JSON.parse(fs.readFileSync(plPath, 'utf8'));
      const ids = new Set([...(j.playlists || []).map((p) => p.id), 'fallbackPool']);
      const dangling = [
        ...Object.entries(j.slotDefaults || {}).filter(([k]) => !k.startsWith('$')),
        ...Object.entries(j.moodDefaults || {}).filter(([k]) => !k.startsWith('$')),
      ].filter(([, v]) => !ids.has(v));
      if (dangling.length) {
        add('warn', 'corpus-playlists-refs', 'playlists.json 有悬空引用',
          dangling.map(([k, v]) => `${k}→${v}`).join(', '), 'npm run validate:playlists');
      } else {
        add('ok', 'corpus-playlists-refs', 'playlists.json 引用完整',
          `${(j.playlists || []).length} 个歌单`);
      }
    } catch (e) {
      add('fail', 'corpus-playlists-json', 'playlists.json 不是合法 JSON', e.message,
        'npm run validate:playlists');
    }
  }

  // 数据目录可写
  try {
    const d = path.join(ROOT, 'data');
    fs.mkdirSync(d, { recursive: true });
    fs.accessSync(d, fs.constants.W_OK);
    add('ok', 'data-writable', 'data/ 目录可写');
  } catch (e) {
    add('fail', 'data-writable', 'data/ 目录不可写', e.message);
  }
}

// ─────────────────────── 6. 端口 ───────────────────────
async function checkPort() {
  const port = Number(env.PORT || 8080);
  const host = env.HOST || '127.0.0.1';
  if (host !== '127.0.0.1' && host !== 'localhost' && !env.RADIO_AUTH_TOKEN) {
    add('fail', 'port-auth', `HOST=${host} 但未设置 RADIO_AUTH_TOKEN`, '',
      '局域网/公网暴露且无令牌 = 任何同网段的人都能控制你的电台、读你的品味语料。\n' +
      '    要么改回 HOST=127.0.0.1，要么设置令牌: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
  }

  const r = run('powershell -NoProfile -Command "'
    + `(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Measure-Object).Count"`);
  if (r.ok) {
    const n = Number(r.out.trim());
    if (n > 0) {
      add('warn', 'port', `端口 ${port} 已被占用`, `${n} 个监听`,
        `可能是电台已在运行（正常），也可能是别的服务。改 config/.env 的 PORT`);
    } else {
      add('ok', 'port', `端口 ${port} 空闲`);
    }
  } else {
    add('info', 'port', `端口 ${port} 未探测`, '');
  }
}

// ─────────────────────── 运行 ───────────────────────
await checkRuntime();
checkBrain();
checkTts();
checkConfigAndCorpus();
await checkMusic();
await checkPort();

// ─────────────────────── 输出 ───────────────────────
if (AS_JSON) {
  const fails = results.filter((r) => r.level === 'fail');
  console.log(JSON.stringify({
    ok: fails.length === 0,
    fail: fails.map((r) => r.id),
    warn: results.filter((r) => r.level === 'warn').map((r) => r.id),
    results,
  }, null, 2));
  process.exit(fails.length ? 1 : 0);
}

const ICON = { ok: '[ OK ]', warn: '[WARN]', fail: '[FAIL]', info: '[INFO]' };
const ORDER = { fail: 0, warn: 1, info: 2, ok: 3 };

console.log('doctor —— Claudiao 电台环境自检\n');
console.log(`项目根: ${ROOT}`);
console.log(`模式  : ${DEEP ? '深度（含真实 API 探测）' : '快速（加 --deep 做真实探测）'}\n`);

for (const r of [...results].sort((a, b) => ORDER[a.level] - ORDER[b.level])) {
  console.log(`${ICON[r.level]} ${r.title}${r.detail ? `\n        ${r.detail}` : ''}`);
  if (r.fix && r.level !== 'ok') {
    for (const line of r.fix.split('\n')) console.log(`        → ${line}`);
  }
  console.log('');
}

const fails = results.filter((r) => r.level === 'fail');
const warns = results.filter((r) => r.level === 'warn');
const oks = results.filter((r) => r.level === 'ok');

console.log('─'.repeat(52));
console.log(`结果: ${oks.length} 项通过 · ${warns.length} 项警告 · ${fails.length} 项失败`);
if (fails.length === 0) {
  console.log('\n环境就绪，可以 npm start 了。\n');
  if (warns.length) console.log('警告项不影响启动，但建议按上面的提示处理。\n');
  process.exit(0);
}
console.log('\n存在阻塞项，请先按 → 的提示修复。\n');
process.exit(1);

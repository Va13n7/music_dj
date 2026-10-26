/**
 * Claudiao · 配置装载器（M0-T1）
 *
 * 职责（docs/10 进度表 M0-T1）：合并 config/.env 与 config/{radio,routines,calendar}.yml，
 * 做类型与枚举校验，导出**冻结**的配置对象。全项目唯一读配置的入口——
 * 业务代码不直接 process.env、不直接读 yml。
 *
 * .env 读取规则（与 tools/* 的 loadEnv 保持一致）：
 *   - 带CLAUDIAO_前缀的键以 .env 为准（覆盖 process.env 中的同名项）；
 *   - 无前缀的键不覆盖已存在的环境变量；
 *   - 隔离原因见 config/.env.example（ZCode / DSH 自身会注入同名变量）。
 *
 * 校验原则：收集**全部**问题后一次性抛 ConfigError（消息可读、指出文件与键），
 * 不让用户改一轮跑一轮。
 */
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

export class ConfigError extends Error {
  constructor(problems, extra = {}) {
    super('配置装载失败：\n' + problems.map((p) => `  · ${p}`).join('\n'));
    this.name = 'ConfigError';
    this.problems = problems;
    Object.assign(this, extra);
  }
}

/** 与 tools/* 完全一致的 .env 解析（覆盖语义见文件头注释） */
export function parseDotEnvFile(filePath, base = process.env) {
  const out = { ...base };
  if (!fs.existsSync(filePath)) return out;
  for (const raw of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
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

function readYaml(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return yaml.load(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    throw new ConfigError([`${path.basename(filePath)} 解析失败: ${e.message}`]);
  }
}

// ---------- 类型工具 ----------

const num = (v, key, problems, { min = -Infinity, max = Infinity, integer = false, def = undefined } = {}) => {
  if (v === undefined || v === '') {
    if (def !== undefined) return def;
    problems.push(`缺少数值配置 ${key}`);
    return def;
  }
  const n = Number(v);
  if (!Number.isFinite(n)) { problems.push(`${key} 必须是数字，当前为 "${v}"`); return def; }
  if (n < min || n > max) { problems.push(`${key} 超出范围 [${min}, ${max}]，当前为 ${n}`); return def; }
  if (integer && !Number.isInteger(n)) { problems.push(`${key} 必须是整数，当前为 ${n}`); return def; }
  return n;
};

const bool = (v, key, problems, def = undefined) => {
  if (v === undefined || v === '') { if (def !== undefined) return def; return def; }
  if (v === true || v === 'true' || v === '1' || v === 1) return true;
  if (v === false || v === 'false' || v === '0' || v === 0) return false;
  problems.push(`${key} 必须是布尔值（true/false），当前为 "${v}"`);
  return def;
};

const enumOf = (v, key, allowed, problems, def = undefined) => {
  if (v === undefined || v === '') {
    if (def !== undefined) return def;
    problems.push(`缺少枚举配置 ${key}（允许值: ${allowed.join('/')}）`);
    return def;
  }
  if (!allowed.includes(v)) {
    problems.push(`${key} 取值非法: "${v}"（允许值: ${allowed.join('/')}）`);
    return def;
  }
  return v;
};

const deepFreeze = (o) => {
  for (const k of Object.keys(o)) {
    const v = o[k];
    if (v && typeof v === 'object' && !Buffer.isBuffer(v)) deepFreeze(v);
  }
  return Object.freeze(o);
};

/**
 * 装载并校验全部配置。
 * @param {object} opts { root?: string, env?: object }
 * @returns {object} 冻结的配置对象
 * @throws {ConfigError}
 */
export function loadConfig(opts = {}) {
  const root = opts.root || process.cwd();
  const problems = [];
  const envPath = path.join(root, 'config', '.env');

  if (!fs.existsSync(envPath)) {
    throw new ConfigError([
      `找不到 ${envPath}`,
      '先执行: Copy-Item config\\.env.example config\\.env 然后按需填写',
    ]);
  }
  const env = parseDotEnvFile(envPath, opts.env ?? process.env);

  const radio = readYaml(path.join(root, 'config', 'radio.yml'));
  if (!radio) problems.push('缺少 config/radio.yml（播放行为调参，见 config/radio.yml.example 或仓库内文件）');
  const routines = readYaml(path.join(root, 'config', 'routines.yml'));
  if (!routines) problems.push('缺少 config/routines.yml（节律调度定义）');
  const calendar = readYaml(path.join(root, 'config', 'calendar.yml'));
  if (!calendar) problems.push('缺少 config/calendar.yml（日历数据）');
  if (problems.length) throw new ConfigError(problems);

  // ---------- 服务 ----------
  const host = env.HOST || '127.0.0.1';
  const port = num(env.PORT, 'PORT', problems, { min: 1, max: 65535, integer: true, def: 8080 });
  const nodeEnv = enumOf(env.NODE_ENV, 'NODE_ENV', ['development', 'production', 'test'], problems, 'development');
  const authToken = env.RADIO_AUTH_TOKEN || '';
  if (host !== '127.0.0.1' && host !== 'localhost' && !authToken) {
    problems.push('HOST 非 127.0.0.1 时必须设置 RADIO_AUTH_TOKEN（否则局域网内任何人都能控制电台）');
  }

  // ---------- 大脑（ZCode Agent）----------
  const brain = {
    adapter: 'zcode-agent',
    cli: env.CLAUDIAO_ZCODE_CLI || 'E:\\Program Files\\ZCode\\resources\\glm\\zcode.cjs',
    providerId: env.CLAUDIAO_ZCODE_PROVIDER || 'account:bigmodel-individual-coding-plan',
    model: env.CLAUDIAO_ZCODE_MODEL || 'GLM-5.3-Flash',
    reasoning: enumOf(env.CLAUDIAO_ZCODE_REASONING, 'CLAUDIAO_ZCODE_REASONING', ['low', 'high', 'max'], problems, 'low'),
    cwd: env.CLAUDIAO_ZCODE_CWD || root,
    apiKey: env.CLAUDIAO_ZCODE_API_KEY || '',
    builtinRev: env.CLAUDIAO_ZCODE_BUILTIN_REV || '',
    timeoutMs: num(env.BRAIN_TIMEOUT_MS, 'BRAIN_TIMEOUT_MS', problems, { min: 5000, max: 300000, integer: true, def: 60000 }),
    retry: num(env.BRAIN_RETRY, 'BRAIN_RETRY', problems, { min: 0, max: 3, integer: true, def: 1 }),
    maxConcurrency: num(env.BRAIN_MAX_CONCURRENCY, 'BRAIN_MAX_CONCURRENCY', problems, { min: 1, max: 1, integer: true, def: 1 }),
    logPrompt: bool(env.LOG_PROMPT, 'LOG_PROMPT', problems, false),
  };

  // ---------- TTS ----------
  const tts = {
    engine: enumOf(env.TTS_ENGINE, 'TTS_ENGINE', ['edge', 'sapi'], problems, 'edge'),
    edgeBin: env.CLAUDIAO_EDGE_TTS_BIN || '',
    voice: env.TTS_VOICE || 'zh-CN-XiaoxiaoNeural',
    rate: env.TTS_RATE || '+0%',
    volume: env.TTS_VOLUME || '+0%',
    pitch: env.TTS_PITCH || '+0Hz',
    cacheDir: env.TTS_CACHE_DIR || 'data/tts-cache',
    cacheMaxFiles: num(env.TTS_CACHE_MAX_FILES, 'TTS_CACHE_MAX_FILES', problems, { min: 1, integer: true, def: 2000 }),
    cacheMaxBytes: num(env.TTS_CACHE_MAX_BYTES, 'TTS_CACHE_MAX_BYTES', problems, { min: 1048576, integer: true, def: 524288000 }),
    concurrency: num(env.TTS_CONCURRENCY, 'TTS_CONCURRENCY', problems, { min: 1, max: 4, integer: true, def: 2 }),
    timeoutMs: num(env.TTS_TIMEOUT_MS, 'TTS_TIMEOUT_MS', problems, { min: 3000, max: 60000, integer: true, def: 15000 }),
    breakerThreshold: num(env.TTS_BREAKER_THRESHOLD, 'TTS_BREAKER_THRESHOLD', problems, { min: 1, max: 10, integer: true, def: 3 }),
    sapiVoice: env.SAPI_VOICE || 'Microsoft Huihui Desktop',
    fallbackEnabled: bool(env.TTS_FALLBACK_ENABLED, 'TTS_FALLBACK_ENABLED', problems, true),
  };

  // ---------- 音乐 ----------
  const knownSources = ['netease', 'joox', 'kuwo', 'tencent', 'migu', 'kugou'];
  const musicSources = (env.MUSIC_SOURCES || 'netease,joox')
    .split(',').map((s) => s.trim()).filter(Boolean);
  for (const s of musicSources) {
    if (!knownSources.includes(s)) problems.push(`MUSIC_SOURCES 含未知音源 "${s}"（已知: ${knownSources.join('/')}）`);
  }
  const music = {
    baseUrl: env.MUSIC_BASE_URL || 'https://music-api.gdstudio.xyz/api.php',
    sources: musicSources,
    minIntervalMs: num(env.MUSIC_MIN_INTERVAL_MS, 'MUSIC_MIN_INTERVAL_MS', problems, { min: 0, max: 60000, integer: true, def: 1200 }),
    retryMax: num(env.MUSIC_RETRY_MAX, 'MUSIC_RETRY_MAX', problems, { min: 0, max: 8, integer: true, def: 4 }),
    retryBackoffMs: num(env.MUSIC_RETRY_BACKOFF_MS, 'MUSIC_RETRY_BACKOFF_MS', problems, { min: 0, integer: true, def: 1200 }),
    bitrate: env.MUSIC_BITRATE || '320',
    urlTtlSec: num(env.MUSIC_URL_TTL_SEC, 'MUSIC_URL_TTL_SEC', problems, { min: 30, max: 86400, integer: true, def: 600 }),
    searchTtlSec: num(env.MUSIC_SEARCH_TTL_SEC, 'MUSIC_SEARCH_TTL_SEC', problems, { min: 0, max: 86400, integer: true, def: 1800 }),
    resolveConcurrency: num(env.MUSIC_RESOLVE_CONCURRENCY, 'MUSIC_RESOLVE_CONCURRENCY', problems, { min: 1, max: 1, integer: true, def: 1 }),
    fallbackDir: env.FALLBACK_AUDIO_DIR || 'data/fallback-audio',
    netease: {
      appId: env.MUSIC_NETEASE_APP_ID || '',
      appSecret: env.MUSIC_NETEASE_APP_SECRET || '',
      privateKey: env.MUSIC_NETEASE_PRIVATE_KEY || '',
      publicKey: env.MUSIC_NETEASE_PUBLIC_KEY || '',
      userToken: env.MUSIC_NETEASE_USER_TOKEN || '',
      deviceId: env.MUSIC_NETEASE_DEVICE_ID || '',
      baseUrl: env.MUSIC_NETEASE_BASE_URL || 'https://openncm.music.163.com',
    },
  };

  // ---------- 日志 / 存储 ----------
  const logLevel = enumOf(env.LOG_LEVEL, 'LOG_LEVEL', ['debug', 'info', 'warn', 'error'], problems, 'info');
  const djLang = enumOf(env.DJ_LANG, 'DJ_LANG', ['zh', 'en'], problems, 'zh');
  const cfg = {
    root,
    djLang,
    env: {
      HOST: host, PORT: port, NODE_ENV: nodeEnv, RADIO_AUTH_TOKEN: authToken, TZ: env.TZ || 'Asia/Shanghai',
    },
    server: {
      host, port, nodeEnv, authToken,
      maxBodyBytes: radio?.security?.maxBodyBytes ?? 65536,
      staticAllowlist: radio?.security?.staticAllowlist ?? ['.mp3', '.html', '.js', '.css'],
    },
    brain,
    tts,
    music,
    log: {
      level: logLevel,
      dir: env.LOG_DIR || 'data/logs',
      maxFiles: num(env.LOG_MAX_FILES, 'LOG_MAX_FILES', problems, { min: 1, max: 90, integer: true, def: 14 }),
      logPrompt: brain.logPrompt,
    },
    dbPath: env.DB_PATH || 'data/radio.db',
    weather: {
      provider: env.WEATHER_PROVIDER || '',
      apiKey: env.WEATHER_API_KEY || '',
      city: env.WEATHER_CITY || '',
      cityId: env.WEATHER_CITY_ID || '',
      timeoutMs: num(env.WEATHER_TIMEOUT_MS, 'WEATHER_TIMEOUT_MS', problems, { min: 1000, max: 30000, integer: true, def: 5000 }),
    },
    notify: {
      feishuWebhook: env.FEISHU_WEBHOOK || '',
      feishuSecret: env.FEISHU_SECRET || '',
    },
    tz: env.TZ || 'Asia/Shanghai',
    radio: deepFreeze(radio),
    routines: deepFreeze(routines),
    calendar: deepFreeze(calendar),
  };

  // ---------- routines.yml 的结构校验（浅层；引用完整性归 validate-config） ----------
  if (routines) {
    if (routines.enabled !== undefined && typeof routines.enabled !== 'boolean') {
      problems.push('routines.yml: enabled 必须是布尔值');
    }
    if (routines.quietHours?.start && !/^\d{2}:\d{2}$/.test(routines.quietHours.start)) {
      problems.push(`routines.yml: quietHours.start 必须是 HH:MM，当前为 "${routines.quietHours.start}"`);
    }
    const slots = routines.slots;
    if (!Array.isArray(slots) || !slots.length) {
      problems.push('routines.yml: slots 必须是非空数组');
    } else {
      const names = slots.map((s) => s.name);
      for (const dup of names.filter((n, i) => names.indexOf(n) !== i)) {
        problems.push(`routines.yml: slot 名重复 "${dup}"`);
      }
      for (const s of slots) {
        if (!s.name) problems.push('routines.yml: 存在未命名的 slot');
        if (s.cron !== null && s.cron !== undefined && typeof s.cron === 'string' && s.cron.split(/\s+/).length !== 5) {
          problems.push(`routines.yml: slot "${s.name}" 的 cron 必须是 5 段格式或 null，当前为 "${s.cron}"`);
        }
      }
    }
  }

  if (problems.length) throw new ConfigError(problems);
  return deepFreeze(cfg);
}

/** 单例装载（服务进程用）；测试直接调 loadConfig。 */
let _singleton = null;
export function getConfig(opts = {}) {
  if (!_singleton || opts.reload) _singleton = loadConfig(opts);
  return _singleton;
}

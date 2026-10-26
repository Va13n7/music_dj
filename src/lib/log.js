/**
 * Claudiao · 日志层（M0-T2）
 *
 * 职责（docs/10 进度表 M0-T2）：分级、文件轮转（LOG_MAX_FILES）、prompt 脱敏。
 *
 * 设计：
 *   - 文件：JSON Lines（机器可解析），每天一个文件 data/logs/app-YYYY-MM-DD.log；
 *     启动与跨天时清理超过 LOG_MAX_FILES 的旧文件。
 *   - 控制台：人类可读单行。
 *   - 脱敏（docs/05 §10.3 的对齐实现）：prompt/对话全文默认**不落盘**，
 *     只记长度与 sha1 前 16 位；LOG_PROMPT=1 时才允许全文（启动处需打印隐私告警）。
 *   - 业务代码通过 logger.child({ module }) 打带上下文的日志。
 *
 * 全部同步写（电台日志量极小，同步 appendFile 足够且进程退出不丢尾）。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

/** prompt 脱敏摘要：默认只给长度与 hash（docs/05 §10.3） */
export function promptDigest(text, { full = false } = {}) {
  const s = String(text ?? '');
  if (full) return { chars: s.length, sha1: sha116(s), text: s };
  return { chars: s.length, sha1: sha116(s) };
}

function sha116(s) {
  return crypto.createHash('sha1').update(String(s), 'utf8').digest('hex').slice(0, 16);
}

function localDate(d = new Date()) {
  // 本地日期 YYYY-MM-DD（与 .env TZ 的语义一致；进程时区由外部保证）
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * @param {object} opts
 * @param {string} opts.root          项目根（日志目录相对它）
 * @param {string} [opts.level]       最低输出级别，默认 info
 * @param {string} [opts.dir]         日志目录，默认 data/logs
 * @param {number} [opts.maxFiles]    保留文件数，默认 14
 * @param {boolean} [opts.logPrompt]  true 时 prompt() 允许落全文，默认 false
 * @param {boolean} [opts.console]    是否同步输出到控制台，默认 true
 */
export function createLogger(opts = {}) {
  const root = opts.root || process.cwd();
  const level = LEVELS[opts.level] ?? LEVELS.info;
  const dir = path.isAbsolute(opts.dir || '') ? opts.dir : path.join(root, opts.dir || 'data/logs');
  const maxFiles = opts.maxFiles ?? 14;
  const logPrompt = opts.logPrompt === true;
  const toConsole = opts.console !== false;
  fs.mkdirSync(dir, { recursive: true });

  function fileFor(d = new Date()) {
    return path.join(dir, `app-${localDate(d)}.log`);
  }

  function rotate() {
    // 清理旧的 app-*.log：保留 maxFiles-1 个老文件，给当天的文件留一个名额
    const files = fs.readdirSync(dir)
      .filter((f) => /^app-\d{4}-\d{2}-\d{2}\.log$/.test(f) && f !== `app-${localDate()}.log`)
      .sort();
    for (const f of files.slice(0, Math.max(0, files.length - (maxFiles - 1)))) {
      try { fs.rmSync(path.join(dir, f), { force: true }); } catch { /* 被占用则下次再删 */ }
    }
  }
  rotate();
  let rotateDay = localDate();

  function write(levelName, msg, extra, moduleTag) {
    if (LEVELS[levelName] < level) return;
    const now = new Date();
    if (localDate(now) !== rotateDay) { rotateDay = localDate(now); rotate(); }
    const rec = {
      ts: now.toISOString(),
      level: levelName,
      module: moduleTag || 'app',
      msg: String(msg ?? ''),
    };
    if (extra !== undefined) {
      // extra 里禁止出现大文本：超 8KiB 的字符串值截断（防 prompt 从 extra 侧漏进来）
      const safe = {};
      for (const [k, v] of Object.entries(extra || {})) {
        if (typeof v === 'string' && v.length > 8192) safe[k] = v.slice(0, 8192) + `…(+${v.length - 8192})`;
        else if (v instanceof Error) safe[k] = { message: v.message, stack: v.stack?.split('\n').slice(0, 3) };
        else safe[k] = v;
      }
      rec.ctx = safe;
    }
    const line = JSON.stringify(rec);
    try { fs.appendFileSync(fileFor(now), line + '\n'); } catch { /* 磁盘问题不致命，不抛 */ }
    if (toConsole) {
      const head = `${now.toTimeString().slice(0, 8)} ${levelName.toUpperCase().padEnd(5)} [${rec.module}]`;
      const ctx = extra !== undefined ? ' ' + JSON.stringify(rec.ctx ?? {}) : '';
      const out = `${head} ${rec.msg}${ctx}`;
      if (levelName === 'error') console.error(out);
      else if (levelName === 'warn') console.warn(out);
      else console.log(out);
    }
  }

  /**
   * 记录 prompt/对话类内容。LOG_PROMPT=0（默认）只落长度与 sha1 前缀——
   * 验收标准：默认输出中不含输入明文。
   */
  function prompt(text, moduleTag) {
    const d = promptDigest(text, { full: logPrompt });
    if (logPrompt) {
      write('info', `prompt（明文，LOG_PROMPT=1）: ${d.text}`, undefined, moduleTag);
    } else {
      write('debug', `prompt（脱敏）`, { chars: d.chars, sha1: d.sha1 }, moduleTag);
    }
    return d;
  }

  // 可调用形态：log('warn', msg, extra)（适配器风格）；同时挂载方法风格 log.info(...)（业务风格）
  const base = (levelName, msg, extra) => write(String(levelName), msg, extra);
  base.debug = (msg, extra) => write('debug', msg, extra);
  base.info = (msg, extra) => write('info', msg, extra);
  base.warn = (msg, extra) => write('warn', msg, extra);
  base.error = (msg, extra) => write('error', msg, extra);
  base.prompt = prompt;
  base.child = (moduleTag) => {
    const c = (levelName, msg, extra) => write(String(levelName), msg, extra, moduleTag);
    c.debug = (msg, extra) => write('debug', msg, extra, moduleTag);
    c.info = (msg, extra) => write('info', msg, extra, moduleTag);
    c.warn = (msg, extra) => write('warn', msg, extra, moduleTag);
    c.error = (msg, extra) => write('error', msg, extra, moduleTag);
    c.prompt = (text) => prompt(text, moduleTag);
    return c;
  };
  /** 仅供测试：读取今天日志文件内容 */
  base._file = () => fileFor();
  base._dir = () => dir;
  return base;
}

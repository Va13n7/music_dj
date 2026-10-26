/**
 * Claudiao · 大脑适配器（ZCode Agent 无头协议版）
 *
 * 与 docs/05-brain-adapter.md 的 dsh 无头适配器等价，但把「本地大脑」换成
 * ZCode Agent（即本机 ZCode 桌面端同款 agent，走 bigmodel 编码计划账号态）：
 *
 *   dsh --profile dj-brain --json   →   zcode.cjs app-server --stdio
 *
 * 差异（2026-10 实测结论）：
 *   - dsh 是「每轮一个进程、NDJSON 事件流」；zcode 是「一个常驻 app-server
 *     子进程 + JSON 行协议」，会话常驻在进程内，后续每轮省掉 ~3.5s 启动。
 *   - zcode 无「select model」的命令行参数，模型由协议在 session/create 时指定。
 *   - 账号态 provider 不在进程启动时自动注册（桌面端是它自己推给 runtime 的），
 *     所以适配器启动后先 provider/updateAccountConfig 推一次账号配置。
 *   - 模型请求的认证头由「协议客户端」（也就是本适配器）在
 *     interaction/requestProviderRuntimeHeaders 里提供，值是编码计划 API key
 *     （与桌面端共用 ~/.zcode/v2/credentials.json 里的账号态）。
 *
 * 协议要点（全部实测验证，勿凭直觉改）：
 *   - 消息是一行一个 JSON，请求 {id, method, params}，响应 {id, result|error}；
 *     不是 JSON-RPC（不能带 "jsonrpc" 键）。
 *   - session/create 的 params 里模型选择必须带
 *     options:{reasoningLevel:'max'}，否则报 "Reasoning level is required"。
 *     session/send 每轮也要再带一次同样的 modelSelection（会话级选择可能
 *     因持久化外键失败而丢）。
 *   - 子进程必须带 ZCODE_BUILTIN_PROVIDER_CONFIG_FILE 和
 *     ZCODE_PERSONAL_PROVIDER_CONFIG_FILE 两个环境变量（缺任一，provider
 *     注册表进入 fail-closed，推送的账号配置不生效）。
 *   - assistant 正文消息的 semantics.origin === 'system' 是时间线事件，要跳过。
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 适配器错误，code 语义与 docs/05 §3 的 BrainError 对齐 */
export class BrainError extends Error {
  constructor(code, message, extra = {}) {
    super(message || code);
    this.name = 'BrainError';
    this.code = code;
    Object.assign(this, extra);
  }
}

// ---------- 配置 ----------

function loadDotEnv(root) {
  const out = { ...process.env };
  const f = path.join(root, 'config', '.env');
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

/** 桌面端缓存的内置 provider 模板（zcode-builtin.json），必须传给子进程 */
export function findBuiltinProviderConfig(home = os.homedir()) {
  const root = path.join(home, '.zcode', 'v2', 'runtime', 'provider');
  try {
    const archDir = fs.readdirSync(root).find((d) => d.includes('x86_64')) || fs.readdirSync(root)[0];
    const versions = fs.readdirSync(path.join(root, archDir))
      .filter((v) => /^\d+\.\d+\.\d+$/.test(v))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const ver of versions) {
      for (const ep of fs.readdirSync(path.join(root, archDir, ver))) {
        const f = path.join(root, archDir, ver, ep, 'zcode-builtin.json');
        if (fs.existsSync(f)) return f;
      }
    }
  } catch { /* 目录不存在 → 返回 null，由 available() 报告 */ }
  return null;
}

/**
 * 从 ZCode 共享凭据（~/.zcode/v2/credentials.json）解出编码计划 API key。
 * 加密格式 enc:v1:<iv>.<tag>.<ct>（base64url，AES-256-GCM），
 * 密钥 = sha256(ZCODE_CREDENTIAL_SECRET || "zcode-credential-fallback:<platform>:<home>:<user>")。
 * 两种凭据形态：
 *   老：account-provider:coding-plan:account:<plan>:account:<uid>:api-key（直存 key）
 *   新（桌面端 OAuth 化）：oauth:<provider>:access_token（访问令牌，当 key 用）
 */
export function resolveCodingPlanApiKey(providerId, home = os.homedir(), env = process.env) {
  if (env.CLAUDIAO_ZCODE_API_KEY) return env.CLAUDIAO_ZCODE_API_KEY;
  const f = path.join(home, '.zcode', 'v2', 'credentials.json');
  let raw;
  try { raw = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; }
  const secret = env.ZCODE_CREDENTIAL_SECRET?.trim()
    || `zcode-credential-fallback:${process.platform}:${os.homedir()}:${os.userInfo().username}`;
  const aesKey = crypto.createHash('sha256').update(secret).digest();
  const dec = (payload) => {
    if (typeof payload !== 'string' || !payload.startsWith('enc:v1:')) return null;
    try {
      const [ivB64, tagB64, ctB64] = payload.slice(7).split('.');
      const d = crypto.createDecipheriv('aes-256-gcm', aesKey, Buffer.from(ivB64, 'base64url'));
      d.setAuthTag(Buffer.from(tagB64, 'base64url'));
      return Buffer.concat([d.update(Buffer.from(ctB64, 'base64url')), d.final()]).toString('utf8');
    } catch { return null; }
  };
  // 老格式：编码计划直存的 api-key
  const plan = providerId.replace(/^account:/, '');
  const prefix = `account-provider:coding-plan:account:${plan}:account:`;
  const entry = Object.keys(raw).find((k) => k.startsWith(prefix) && k.endsWith(':api-key'));
  const fromKey = dec(entry ? raw[entry] : undefined);
  if (fromKey) return fromKey;
  // 新格式：OAuth 访问令牌（provider 名取 plan 前缀，兜底任一 access_token）
  const oauthEntry = Object.keys(raw).find((k) => k === `oauth:${plan.split('-')[0]}:access_token`)
    || Object.keys(raw).find((k) => k.startsWith('oauth:') && k.endsWith(':access_token'));
  return oauthEntry ? dec(raw[oauthEntry]) : null;
}

// ---------- 会话状态落盘 ----------

const MAX_TURNS = 60;
const MAX_AGE_MS = 12 * 3600 * 1000;

/**
 * 大脑只需要「读 prompt → 吐 JSON」，不需要任何工具。
 * 全量禁掉：① 大幅缩减每轮 input tokens（工具 schema 占 ~15K）
 *          ② 防止 agent 在电台触发时擅自跑命令/读文件。
 */
const ALL_TOOLS = [
  'Agent', 'AskUserQuestion', 'Bash', 'CronCreate', 'CronDelete', 'CronList', 'CronUpdate',
  'Edit', 'EnterPlanMode', 'ExitPlanMode', 'Read', 'Skill', 'TaskOutput', 'TaskStop',
  'TodoRead', 'TodoWrite', 'WebFetch', 'WebSearch', 'Write', 'SendMessage',
  'ReadSessionContext', 'ReplyToChannel',
];

// ---------- 适配器 ----------

export class ZcodeAgentAdapter {
  /**
   * @param {object} opts
   * @param {string} opts.root            项目根（读 config/.env、定位 CLI 兜底路径）
   * @param {string} [opts.env]           合并后的环境变量（默认 loadDotEnv(root)）
   * @param {(level: string, msg: string, extra?: object) => void} [opts.log]
   */
  constructor({ root, env, log } = {}) {
    this.root = root || process.cwd();
    this.env = env || loadDotEnv(this.root);
    this.log = log || (() => {});

    this.cliPath = this.env.CLAUDIAO_ZCODE_CLI
      || 'E:\\Program Files\\ZCode\\resources\\glm\\zcode.cjs';
    this.workspacePath = this.env.CLAUDIAO_ZCODE_CWD || this.root;
    this.providerId = this.env.CLAUDIAO_ZCODE_PROVIDER || 'account:bigmodel-individual-coding-plan';
    this.modelId = this.env.CLAUDIAO_ZCODE_MODEL || 'GLM-5.3-Flash';
    // 实测（2026-10，GLM-5.3-Flash + 15K prompt）：low ≈12-20s，high/max 42-57s。
    // 选曲+口播稿是格式化任务不是推理任务，low 的输出质量已达标，故默认 low。
    this.reasoningLevel = this.env.CLAUDIAO_ZCODE_REASONING || 'low';
    this.timeoutMs = Number(this.env.BRAIN_TIMEOUT_MS || 30000);
    this.builtinRevision = this.env.CLAUDIAO_ZCODE_BUILTIN_REV
      || 'zcode-builtin:31:1851ca1da70e79192f6fa0fe9e75339dcc4d7bbf44ed14172b086dddf21e9d5a';

    this.builtinConfigFile = this.env.CLAUDIAO_ZCODE_BUILTIN_CONFIG || findBuiltinProviderConfig();
    this.apiKey = resolveCodingPlanApiKey(this.providerId, os.homedir(), this.env);
    // 直连 API Key（BigModel 开放平台）：2026-10-26 起的主路径。桌面端 OAuth 化后，
    // 编码计划模型在无头子进程里不再物化（registry 门控），personal provider +
    // 开放平台 key 是官方支持的旁路。key 经运行时生成的 personal provider 配置
    // 注入（data/runtime/，gitignored），不进子进程环境变量。
    this.directApiKey = (this.env.BIGMODEL_API_KEY || '').trim();

    this.child = null;
    this.rl = null;
    this.pending = new Map();
    this.nextId = 1;
    this.ready = null;          // Promise：启动 + 推送 provider 完成
    this.inFlight = null;       // 单飞锁：同一时刻只允许一个 turn
    this.sessionId = null;
    this.sessionTurns = 0;
    this.sessionCreatedAt = 0;
    this.circuitOpenUntil = 0;
    this.stateFile = path.join(this.root, 'data', 'runtime', 'brain-session.json');

    this._exitHook = () => { this.close(); };
    process.on('exit', this._exitHook);
  }

  /** 同步能力位：CLI/内置配置/凭据（编码计划或直连 key 二选一）齐备且熔断未开 */
  available() {
    if (Date.now() < this.circuitOpenUntil) return false;
    return Boolean(this.cliPath && fs.existsSync(this.cliPath)
      && this.builtinConfigFile && fs.existsSync(this.builtinConfigFile)
      && (this.apiKey || this.directApiKey));
  }

  /** 缺什么（doctor / 启动自检用） */
  availabilityDetail() {
    const missing = [];
    if (!fs.existsSync(this.cliPath)) missing.push(`CLAUDIAO_ZCODE_CLI 不存在: ${this.cliPath}`);
    if (!this.builtinConfigFile || !fs.existsSync(this.builtinConfigFile)) {
      missing.push('未找到桌面端缓存的 zcode-builtin.json（~/.zcode/v2/runtime/provider/...），确认 ZCode 桌面端已登录');
    }
    if (!this.apiKey && !this.directApiKey) {
      missing.push(`凭据里没有 ${this.providerId} 的 API key/OAuth 令牌，且未设置 BIGMODEL_API_KEY`);
    }
    return missing;
  }

  // ---- 子进程与协议 ----

  _spawnServer() {
    const env = {};
    for (const k of ['PATH', 'SystemRoot', 'windir', 'TEMP', 'TMP', 'APPDATA', 'LOCALAPPDATA',
      'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'COMPUTERNAME', 'USERNAME', 'USERDOMAIN',
      'OS', 'PATHEXT', 'NUMBER_OF_PROCESSORS', 'ZCODE_CREDENTIAL_SECRET']) {
      if (this.env[k] !== undefined) env[k] = this.env[k];
    }
    env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = this.builtinConfigFile;
    // 直连 key 路径：运行时生成 personal provider 配置（含 key），子进程经
    // ZCODE_PERSONAL_PROVIDER_CONFIG_FILE 读它——模型注册表与请求鉴权全部走这里。
    if (this.directApiKey) {
      try {
        const cfgFile = path.join(this.root, 'data', 'runtime', 'claudiao-provider-config.json');
        const cfg = {
          schemaVersion: 1,
          config: {
            providerConfigRules: { providerRules: [ {
              providerId: 'personal:claudiao-brain',
              providerName: 'Claudiao Brain',
              config: {
                group: 'standard-personal',
                access: { type: 'api-key', apiKey: this.directApiKey },
                api: { type: 'anthropic-messages', baseUrl: 'https://open.bigmodel.cn/api/anthropic' },
                personalModelIds: [this.modelId],
              },
            } ] },
            modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
            defaultModelSelection: { providerId: 'personal:claudiao-brain', modelId: this.modelId },
          },
        };
        fs.mkdirSync(path.dirname(cfgFile), { recursive: true });
        fs.writeFileSync(cfgFile, JSON.stringify(cfg));
        env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE = cfgFile;
      } catch (e) {
        this.log('warn', 'personal provider 配置生成失败，回退编码计划路径', { error: e.message });
      }
    }
    if (!env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE) {
      const personal = path.join(os.homedir(), '.zcode', 'v2', 'provider_config.json');
      if (fs.existsSync(personal)) env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE = personal;
    }

    // 运行时选择：桌面端 Electron 自带的 node（24.x，node:sqlite 与新 CLI 的迁移匹配）
    // 优先；本机 node（22.x 的实验 sqlite 跑不动新版 CLI 的 0024 迁移）兜底。
    const installRoot = path.dirname(path.dirname(path.dirname(this.cliPath)));   // .../ZCode/resources/glm → .../ZCode
    const electronNode = process.platform === 'win32' ? path.join(installRoot, 'ZCode.exe') : null;
    let cmd, spawnArgs;
    if (electronNode && fs.existsSync(electronNode)) {
      cmd = electronNode;
      spawnArgs = [this.cliPath, 'app-server', '--stdio'];
      env.ELECTRON_RUN_AS_NODE = '1';
    } else {
      cmd = process.execPath;
      spawnArgs = ['--experimental-sqlite', this.cliPath, 'app-server', '--stdio'];
    }
    this.child = spawn(cmd, spawnArgs, {
      cwd: this.workspacePath,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env,
    });
    this.child.stdout.setEncoding('utf8');
    this.rl = createInterface({ input: this.child.stdout });
    this.rl.on('line', (line) => this._onLine(line));
    this.child.stderr.on('data', (d) => {
      const s = String(d);
      if (!/ExperimentalWarning/.test(s)) this.log('warn', 'zcode app-server stderr', { tail: s.slice(0, 300) });
    });
    this.child.on('exit', (code) => {
      this.log('warn', 'zcode app-server exited', { code });
      this._teardownChild();
      // 进程没了 → 会话也没了
      this.sessionId = null;
      this.ready = null;
    });

    this.ready = (async () => {
      await this._request('provider/updateAccountConfig', {
        revision: `claudiao-${Date.now()}`,
        basedOnZCodeBuiltinRevision: this.builtinRevision,
        providers: {
          [this.providerId]: {
            builtinModelIds: [this.modelId],
            access: { type: 'zhipu-account', entitled: true },
          },
        },
        states: {
          [this.providerId]: { availability: 'available', entitled: true, current: true },
        },
      }, 20000);
      this.log('info', 'zcode account provider pushed', { providerId: this.providerId });
    })();
    return this.ready;
  }

  _teardownChild() {
    if (this.rl) { try { this.rl.close(); } catch { /* ignore */ } this.rl = null; }
    if (this.child) { try { this.child.kill(); } catch { /* ignore */ } this.child = null; }
    for (const [, p] of this.pending) p.reject(new BrainError('E_SPAWN', 'app-server 连接已断开'));
    this.pending.clear();
  }

  _onLine(line) {
    const t = line.trim();
    if (!t) return;
    let msg;
    try { msg = JSON.parse(t); } catch { return; }                       // 非契约行忽略
    if (msg.method === 'startup/storageState') return;

    // 响应
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const p = this.pending.get(msg.id);
      if (p) { this.pending.delete(msg.id); p(msg); }
      return;
    }
    // 服务端反向请求：协议宿主职责，按需应答
    if (msg.id !== undefined && msg.method) {
      let result = {};
      if (/RuntimePreferences/.test(msg.method)) result = { nativeSearchEnhancementsEnabled: false };
      else if (/requestProviderRuntimeHeaders/.test(msg.method)) {
        result = { headersApplied: true, requestAuth: { apiKey: this.apiKey } };
      } else if (/OfficialMcpAuthHeaders/.test(msg.method)) {
        result = { headersApplied: false, errorMessage: 'claodiao brain does not use official MCP' };
      }
      try { this.child?.stdin.write(JSON.stringify({ id: msg.id, result }) + '\n'); } catch { /* ignore */ }
      return;
    }
    // 通知/事件：turn-failed 用于快速失败
    if (msg.method === 'computer-use/operation-event' && msg.params?.kind === 'turn-failed'
        && msg.params.sessionId === this.sessionId) {
      this._lastTurnFailure = { turnId: msg.params.turnId, at: Date.now(), detail: msg.params };
      this.log('warn', 'agent turn-failed 事件', { detail: JSON.stringify(msg.params).slice(0, 400) });
    }
  }

  _request(method, params, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      if (!this.child || this.child.exitCode !== null) {
        return reject(new BrainError('E_SPAWN', 'app-server 未运行'));
      }
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BrainError('E_TIMEOUT', `协议请求超时: ${method}`));
      }, timeoutMs);
      this.pending.set(id, (m) => {
        clearTimeout(timer);
        if (m.error) {
          const d = m.error.data || {};
          reject(new BrainError('E_EXIT', m.error.message || '协议错误', { detail: d }));
        } else resolve(m.result);
      });
      try {
        this.child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new BrainError('E_SPAWN', `写入协议通道失败: ${e.message}`));
      }
    });
  }

  _ensureServer() {
    if (this.child && this.child.exitCode === null) return this.ready;
    return this._spawnServer();
  }

  // ---- 会话 ----

  _modelSelection() {
    return {
      providerId: this.providerId,
      modelId: this.modelId,
      options: { reasoningLevel: this.reasoningLevel },
    };
  }

  _loadSessionState() {
    try {
      const st = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
      if (st.sessionId && st.providerId === this.providerId && st.modelId === this.modelId) return st;
    } catch { /* 无文件/坏文件 → 新会话 */ }
    return null;
  }

  _saveSessionState() {
    try {
      fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
      fs.writeFileSync(this.stateFile, JSON.stringify({
        sessionId: this.sessionId,
        providerId: this.providerId,
        modelId: this.modelId,
        turns: this.sessionTurns,
        createdAt: this.sessionCreatedAt,
        lastUsedAt: Date.now(),
      }, null, 2));
    } catch { /* 落盘失败不影响本轮 */ }
  }

  _resetSession() {
    this.sessionId = null;
    this.sessionTurns = 0;
    this.sessionCreatedAt = 0;
    try { fs.rmSync(this.stateFile, { force: true }); } catch { /* ignore */ }
  }

  /** 会话轮换（供业务层在 token 膨胀时调用）：丢弃当前会话，下次调用自动新建 */
  rotate() {
    this.log.warn?.('轮换大脑会话（token 膨胀）', { sessionId: this.sessionId });
    this._resetSession();
  }

  async _ensureSession() {
    // 轮换：turn 数或年龄超限（docs/05 §8）
    if (this.sessionId && (this.sessionTurns >= MAX_TURNS || Date.now() - this.sessionCreatedAt > MAX_AGE_MS)) {
      this.log('info', 'brain session rotated', { turns: this.sessionTurns });
      this._resetSession();
    }
    if (!this.sessionId) {
      const st = this._loadSessionState();
      if (st && Date.now() - st.createdAt <= MAX_AGE_MS && st.turns < MAX_TURNS) {
        // 会话持久化在 app-server 的 db 里，跨进程要用 session/resume 恢复
        try {
          await this._request('session/resume', { sessionId: st.sessionId }, 15000);
          this.sessionId = st.sessionId;
          this.sessionTurns = st.turns || 0;
          this.sessionCreatedAt = st.createdAt || Date.now();
          this.log('info', 'brain session resumed', { sessionId: this.sessionId });
          return this.sessionId;
        } catch (e) {
          this.log('warn', 'brain session resume failed, creating new', {
            sessionId: st.sessionId, error: e.message,
          });
        }
      }
    }
    if (!this.sessionId) {
      // 新版 CLI（3.16.3+）：create 带 model 会走注册表校验，而账号 provider 的模型
      // 列表在无头模式下不物化（"Provider Registry 中不存在 Model"）。不传 model
      // 让服务端用默认选择（桌面端当前模型），逐轮的 modelSelection 在 session/send
      // 里仍然生效。
      const r = await this._request('session/create', {
        workspace: { workspacePath: this.workspacePath, workspaceKey: this.workspacePath },
        mode: 'yolo',
        titleGenerationEnabled: false,
        toolDenylist: ALL_TOOLS,
      }, 30000);
      this.sessionId = r?.session?.sessionId || null;
      if (!this.sessionId) throw new BrainError('E_BRAIN_NO_FINAL', 'session/create 未返回 sessionId');
      this.sessionTurns = 0;
      this.sessionCreatedAt = Date.now();
      this._saveSessionState();
      this.log('info', 'brain session created', { sessionId: this.sessionId });
    }
    return this.sessionId;
  }

  // ---- 对外契约 ----

  /**
   * 一次大脑调用。
   * @param {string} promptText 已渲染的完整 prompt（六片组装属上层 context 职责）
   * @param {object} [opts] { timeoutMs?, resetSession? }
   * @returns {Promise<{text, usage, sessionId, raw}>}
   * @throws {BrainError} code ∈ E_SPAWN|E_TIMEOUT|E_EXIT|E_BRAIN_NO_FINAL|E_SPAWN_DISABLED
   */
  async compute(promptText, opts = {}) {
    if (!this.available()) throw new BrainError('E_SPAWN', 'brain unavailable（见 availabilityDetail）');
    const timeoutMs = opts.timeoutMs || this.timeoutMs;

    // 单飞：多触发并发时排队而非并发压协议（账号态与会话文件都不允许并发写）
    while (this.inFlight) {
      if (this.inFlight !== undefined) {
        await this.inFlight.catch(() => { /* 前一轮失败不阻塞排队者 */ });
      }
    }
    const exec = this._computeOnce(promptText, timeoutMs, opts);
    this.inFlight = exec;
    try {
      return await exec;
    } finally {
      if (this.inFlight === exec) this.inFlight = null;
    }
  }

  /** 从 session/messages 响应里提取本轮的 assistant 正文与 usage */
  _extractTurnOutput(msgs, started) {
    const texts = [];
    let usage = null;
    for (const m of msgs?.messages || []) {
      if (m.info?.role !== 'assistant' || m.info?.semantics?.origin === 'system') continue;
      const created = m.info?.time?.created || 0;
      if (created && created < started - 1500) continue;
      for (const p of m.parts || []) {
        if (p.type === 'text' && typeof p.text === 'string' && p.text.trim()) {
          texts.push(p.text);
          const t = m.info.tokens || {};
          usage = {
            inputTokens: t.input || 0,
            outputTokens: (t.output || 0) + (t.reasoning || 0),
            cacheReadTokens: t.cache?.read || 0,
            cacheWriteTokens: t.cache?.write || 0,
            totalTokens: t.total || ((t.input || 0) + (t.output || 0)),
          };
        }
      }
    }
    return { texts, usage };
  }

  async _computeOnce(promptText, timeoutMs, opts) {
    if (opts.resetSession) this._resetSession();
    await this._ensureServer();
    const sessionId = await this._ensureSession();

    const started = Date.now();
    this._lastTurnFailure = null;
    await this._request('session/send', {
      sessionId,
      inputId: `claodiao-${started}`,
      content: String(promptText ?? ''),
      toolDenylist: ALL_TOOLS,
    }, 15000);

    // 轮询消息直到出现 assistant 正文（真实模型输出，非时间线事件）
    const deadline = started + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 700));
      const failFresh = this._lastTurnFailure && this._lastTurnFailure.at > started;
      if (failFresh) {
        throw new BrainError('E_EXIT', 'agent turn 失败', { detail: this._lastTurnFailure });
      }
      let msgs;
      try {
        msgs = await this._request('session/messages', { sessionId, limit: 30 }, 10000);
      } catch (e) {
        if (Date.now() >= deadline) break;
        continue;                                                        // 单次读失败继续轮询
      }
      if (Math.floor((Date.now() - started) / 10000) !== Math.floor((Date.now() - started - 700) / 10000)) {
        const asst = (msgs?.messages || []).find((m) => m.info?.role === 'assistant');
        this.log('info', 'brain 轮询诊断', {
          n: msgs?.messages?.length || 0,
          roles: (msgs?.messages || []).map((m) => `${m.info?.role}/${m.info?.semantics?.origin}`).join(','),
          textParts: (msgs?.messages || []).reduce((a, m) => a + (m.parts || []).filter((p) => p.type === 'text').length, 0),
          asstCreated: asst?.info?.time?.created,
          asstParts: asst ? JSON.stringify(asst.parts).slice(0, 400) : null,
        });
      }
      const { texts, usage } = this._extractTurnOutput(msgs, started);
      if (texts.length) {
        this.sessionTurns += 1;
        this._saveSessionState();
        return {
          text: texts[texts.length - 1],
          usage,
          sessionId,
          raw: { latencyMs: Date.now() - started, attempts: 1 },
        };
      }
    }
    // 超时：0.17.0 观察到 turn 收尾会挂起——模型流完成后 assistant 正文要等会话
    // 中止才在 session/messages 里可见。先 session/stop 中止，再做最后一次读取。
    try { await this._request('session/stop', { sessionId }, 5000); } catch { /* ignore */ }
    try {
      const msgs = await this._request('session/messages', { sessionId, limit: 30 }, 10000);
      const { texts, usage } = this._extractTurnOutput(msgs, started);
      if (texts.length) {
        this.sessionTurns += 1;
        this._saveSessionState();
        this.log('info', 'brain 超时兜底读取命中', { chars: texts[texts.length - 1].length });
        return {
          text: texts[texts.length - 1],
          usage,
          sessionId,
          raw: { latencyMs: Date.now() - started, attempts: 1 },
        };
      }
    } catch { /* 兜底读取失败就走超时路径 */ }
    throw new BrainError('E_TIMEOUT', `brain turn 超时（>${timeoutMs}ms）`);
  }

  /** 探活：发一句最小 prompt，验证退出码与正文 */
  async health() {
    const started = Date.now();
    try {
      const r = await this.compute('只回复两个字：正常', { timeoutMs: Math.min(this.timeoutMs, 45000) });
      return { ok: Boolean(r.text), latencyMs: Date.now() - started, sessionId: r.sessionId };
    } catch (e) {
      return { ok: false, code: e.code || 'E_UNKNOWN', detail: e.message, latencyMs: Date.now() - started };
    }
  }

  /** 熔断（简单版）：连续失败时由上层调用，openMs 内 available()=false */
  trip(ms = 30000) {
    this.circuitOpenUntil = Date.now() + ms;
  }

  close() {
    this._teardownChild();
    process.off('exit', this._exitHook);
  }
}

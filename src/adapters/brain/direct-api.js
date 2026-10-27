/**
 * Claudiao · 大脑直连适配器（Anthropic / OpenAI 双协议）
 *
 * 背景：zcode-agent 子进程路径单轮 ~100s（agent 系统提示/工具清单/会话历史
 * 叠加 + turn 收尾挂起）。直连开放平台/各厂商 chat 端点，无 agent 外壳、
 * 无状态、单轮 ~10s。
 *
 * 支持协议：
 *  - anthropic：POST {base}/v1/messages，x-api-key 头（BigModel/DeepSeek…）
 *  - openai：  POST {base}/chat/completions，Bearer 头（OpenAI/Kimi/通义/自定义…）
 *
 * 思考参数仅 BigModel anthropic 端点需要（GLM-5.3 系强制思考，low 档最快），
 * 其他厂商传了可能报错，故按 provider 开关控制。
 */

/** 市面主流供应商目录（UI 下拉与默认值；models 仅为常用建议，可自由填写） */
export const BRAIN_PROVIDERS = [
  { id: 'bigmodel', name: '智谱 BigModel', protocol: 'anthropic', baseUrl: 'https://open.bigmodel.cn/api/anthropic', models: ['GLM-5-Turbo', 'GLM-5.3-Flash', 'GLM-5.3'], thinking: true },
  { id: 'deepseek', name: 'DeepSeek', protocol: 'anthropic', baseUrl: 'https://api.deepseek.com/anthropic', models: ['deepseek-chat', 'deepseek-reasoner'], thinking: false },
  { id: 'moonshot', name: 'Moonshot Kimi', protocol: 'openai', baseUrl: 'https://api.moonshot.cn/v1', models: ['kimi-k2-turbo-preview', 'moonshot-v1-8k'], thinking: false },
  { id: 'openai', name: 'OpenAI', protocol: 'openai', baseUrl: 'https://api.openai.com/v1', models: ['gpt-4o-mini', 'gpt-4o'], thinking: false },
  { id: 'dashscope', name: '通义千问', protocol: 'openai', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', models: ['qwen-turbo', 'qwen-plus', 'qwen-max'], thinking: false },
  { id: 'custom', name: '自定义 (Anthropic 协议)', protocol: 'anthropic', baseUrl: '', models: [], thinking: false },
];

export class DirectApiBrainAdapter {
  /**
   * @param {object} opts { apiKey, model, baseUrl, protocol?('anthropic'|'openai'), thinking?(bool), timeoutMs?, log? }
   */
  constructor({ apiKey, model, baseUrl, protocol, thinking, timeoutMs, log } = {}) {
    const preset = BRAIN_PROVIDERS.find((p) => p.id === (protocol || ''));
    this.protocol = protocol || 'anthropic';
    this.baseUrl = (baseUrl || preset?.baseUrl || 'https://open.bigmodel.cn/api/anthropic').replace(/\/+$/, '');
    this.thinking = thinking ?? Boolean(preset?.thinking);
    this.apiKey = apiKey;
    this.modelId = model || 'GLM-5-Turbo';
    this.timeoutMs = timeoutMs || 60000;
    this.log = log || (() => {});
    this.sessionId = null;                 // 无状态协议；保留字段兼容 BrainService
  }

  available() { return Boolean(this.apiKey && this.baseUrl); }
  availabilityDetail() {
    const missing = [];
    if (!this.apiKey) missing.push('API Key 未配置');
    if (!this.baseUrl) missing.push('Base URL 未配置');
    return missing;
  }
  rotate() { /* 无状态协议，无会话可轮换 */ }
  close() { /* 无子进程资源 */ }

  /** 思考档：仅 BigModel anthropic 端点传（GLM-5.3 系强制思考，low 档最快） */
  _thinkingParam() {
    if (!this.thinking) return undefined;
    if (/turbo|flashx|air/i.test(this.modelId)) return undefined;
    return { thinking: { type: 'enabled', level: 'low' } };
  }

  async _post(url, headers, body, timeoutMs) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: ac.signal });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 200);
      const err = new Error(`直连 API ${res.status}: ${detail}`);
      err.code = res.status === 401 || res.status === 403 ? 'E_BRAIN_AUTH' : 'E_BRAIN_HTTP';
      throw err;
    }
    return res.json();
  }

  _extractText(j) {
    if (this.protocol === 'openai') {
      return (j.choices?.[0]?.message?.content || '').toString();
    }
    return (j.content || [])
      .filter((c) => c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text)
      .join('');
  }

  /**
   * 一次大脑决策（无状态）。
   * @returns {Promise<{text, usage, sessionId, raw:{latencyMs}}>}
   */
  async compute(promptText, opts = {}) {
    const started = Date.now();
    const timeoutMs = opts.timeoutMs ?? this.timeoutMs;
    const content = String(promptText ?? '');

    let j;
    if (this.protocol === 'openai') {
      j = await this._post(`${this.baseUrl}/chat/completions`, {
        'Authorization': `Bearer ${this.apiKey}`,
        'content-type': 'application/json',
      }, {
        model: this.modelId,
        max_tokens: 2000,
        messages: [{ role: 'user', content }],
      }, timeoutMs);
    } else {
      j = await this._post(`${this.baseUrl}/v1/messages`, {
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      }, {
        model: this.modelId,
        max_tokens: 2000,
        messages: [{ role: 'user', content }],
        ...this._thinkingParam(),
      }, timeoutMs);
    }

    const text = this._extractText(j);
    if (!text.trim()) {
      const e = new Error(`直连 API 无正文（stop=${j.stop_reason || j.choices?.[0]?.finish_reason}）`);
      e.code = 'E_BRAIN_NO_FINAL';
      throw e;
    }
    const u = j.usage || {};
    return {
      text,
      usage: {
        inputTokens: u.input_tokens || u.prompt_tokens || 0,
        outputTokens: u.output_tokens || u.completion_tokens || 0,
        cacheReadTokens: u.cache_read_input_tokens || 0,
        cacheWriteTokens: u.cache_write_input_tokens || 0,
        totalTokens: (u.input_tokens || u.prompt_tokens || 0) + (u.output_tokens || u.completion_tokens || 0),
      },
      sessionId: null,
      raw: { latencyMs: Date.now() - started },
    };
  }

  /** 探活：最小请求验证 key 与端点 */
  async health() {
    const started = Date.now();
    try {
      const r = await this.compute('只回复两个字：正常', { timeoutMs: Math.min(this.timeoutMs, 30000) });
      return { ok: Boolean(r.text), latencyMs: Date.now() - started, sessionId: null };
    } catch (e) {
      return { ok: false, code: e.code || 'E_UNKNOWN', detail: e.message, latencyMs: Date.now() - started };
    }
  }
}

/**
 * Claudiao · 大脑直连适配器（BigModel 开放平台 Anthropic Messages 协议）
 *
 * 背景：zcode-agent 子进程路径单轮 ~100s（agent 系统提示/工具清单/会话历史
 * 叠加 + turn 收尾挂起）。BIGMODEL_API_KEY 可直接调开放平台 anthropic 兼容
 * 端点，无 agent 外壳、无状态、单轮 ~10s（GLM-5-Turbo，非思考）。
 *
 * 模型思考策略：GLM-5.3/5.1 系强制思考（端点只接受 low/high/max 档），
 * 默认附加 thinking level low；Turbo/Air/FlashX 等非思考模型不传。
 */
export class DirectApiBrainAdapter {
  /** @param {object} opts { apiKey, model, baseUrl?, timeoutMs?, log? } */
  constructor({ apiKey, model, baseUrl, timeoutMs, log } = {}) {
    this.apiKey = apiKey;
    this.modelId = model || 'GLM-5-Turbo';
    this.baseUrl = (baseUrl || 'https://open.bigmodel.cn/api/anthropic').replace(/\/+$/, '');
    this.timeoutMs = timeoutMs || 60000;
    this.log = log || (() => {});
    this.sessionId = null;                 // 无状态协议；保留字段兼容 BrainService
  }

  available() { return Boolean(this.apiKey); }
  availabilityDetail() { return this.apiKey ? [] : ['BIGMODEL_API_KEY 未配置']; }
  rotate() { /* 无状态协议，无会话可轮换 */ }
  close() { /* 无子进程资源 */ }

  /** 思考档：强制思考的模型传 low（实测显著快于默认档），Turbo 系不传 */
  _thinkingParam() {
    if (/turbo|flashx|air/i.test(this.modelId)) return undefined;
    return { thinking: { type: 'enabled', level: 'low' } };
  }

  /**
   * 一次大脑决策（无状态）。
   * @returns {Promise<{text, usage, sessionId, raw:{latencyMs}}>}
   */
  async compute(promptText, opts = {}) {
    const started = Date.now();
    const timeoutMs = opts.timeoutMs ?? this.timeoutMs;
    const body = {
      model: this.modelId,
      max_tokens: 2000,
      messages: [{ role: 'user', content: String(promptText ?? '') }],
      ...this._thinkingParam(),
    };
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(`${this.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: ac.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 200);
      const err = new Error(`直连 API ${res.status}: ${detail}`);
      err.code = res.status === 401 || res.status === 403 ? 'E_BRAIN_AUTH' : 'E_BRAIN_HTTP';
      throw err;
    }
    const j = await res.json();
    const text = (j.content || [])
      .filter((c) => c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text)
      .join('');
    if (!text.trim()) {
      const e = new Error(`直连 API 无正文（stop=${j.stop_reason}）`);
      e.code = 'E_BRAIN_NO_FINAL';
      throw e;
    }
    const u = j.usage || {};
    return {
      text,
      usage: {
        inputTokens: u.input_tokens || 0,
        outputTokens: u.output_tokens || 0,
        cacheReadTokens: u.cache_read_input_tokens || 0,
        cacheWriteTokens: u.cache_write_input_tokens || 0,
        totalTokens: (u.input_tokens || 0) + (u.output_tokens || 0),
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

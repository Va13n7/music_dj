/**
 * Claudiao · 大脑业务层（M1-T2/T6，docs/05 §3 §7）
 *
 * 职责：重试退避、熔断、usage 记账入口、DjAction 解析容错的调用方。
 * 进程调用（spawn/协议）全部在适配器（zcode-agent.js），本层不碰子进程。
 *
 * 降级策略：compute() 失败且 fallbackFn 可用 → 返回合法 DjAction（模板播报）；
 * 无 fallbackFn → 抛最后一个错误（编排层决定）。
 */
import { parseDjAction } from './dj-action.js';

export class BrainError extends Error {
  constructor(code, message, extra = {}) {
    super(message || code);
    this.name = 'BrainError';
    this.code = code;
    Object.assign(this, extra);
  }
}

export class BrainService {
  /**
   * @param {object} opts
   * @param {object} opts.adapter   ZcodeAgentAdapter 实例（compute/available/close）
   * @param {object} opts.env       config 相关字段（timeoutMs/retry）
   * @param {(level:string,msg:string,extra?:object)=>void} [opts.log]
   * @param {(ctx:{reason:string})=>{say:string,play:string[],reason:string,segue:string}} [opts.fallbackTemplate]
   *        降级模板函数（M4 的 fallback-templates.js 注入；不传则失败直接抛）
   */
  constructor({ adapter, env, log, fallbackTemplate } = {}) {
    this.adapter = adapter;
    this.timeoutMs = env?.timeoutMs ?? 60000;
    this.retry = env?.retry ?? 1;
    this.djLang = env?.djLang || 'zh';
    this.log = (log?.child?.('brain')) ?? log ?? console;
    this.fallbackTemplate = fallbackTemplate;
    // 熔断：滑动窗口 60s，失败阈值 5；打开时长 30s * 2^n 封顶 300s（docs/05 §7）
    this.circuit = { failures: [], openUntil: 0, openCount: 0 };
  }

  available() {
    return this.adapter.available() && Date.now() >= this.circuit.openUntil;
  }

  circuitStatus() {
    return {
      open: Date.now() < this.circuit.openUntil,
      recentFailures: this.circuit.failures.length,
      openCount: this.circuit.openCount,
    };
  }

  _recordFailure() {
    const now = Date.now();
    this.circuit.failures = this.circuit.failures.filter((t) => now - t < 60_000);
    this.circuit.failures.push(now);
    if (this.circuit.failures.length >= 5) {
      this.circuit.openCount += 1;
      const ms = Math.min(300_000, 30_000 * 2 ** (this.circuit.openCount - 1));
      this.circuit.openUntil = now + ms;
      this.circuit.failures = [];
      this.log.warn?.('大脑熔断打开', { openCount: this.circuit.openCount, openMs: ms });
    }
  }

  /**
   * 一次大脑决策。
   * @param {string} promptText 已渲染的完整 prompt（context.js 组装）
   * @param {object} [opts] { timeoutMs?, resetSession? }
   * @returns {Promise<{action:{say,play[],reason,segue,degraded[]}, raw:{text,latencyMs,sessionId,usage}, meta:{path,repairs,retries,attempts}}>}
   */
  async compute(promptText, opts = {}) {
    const attempts = (this.retry ?? 1) + 1;
    let lastErr;

    for (let i = 1; i <= attempts; i++) {
      if (!this.adapter.available()) {
        lastErr = new BrainError('E_BRAIN_UNAVAILABLE', '大脑不可用（熔断打开或依赖缺失）');
        break;
      }
      const started = Date.now();
      try {
        // 重试时换新会话（docs/05 §7：重试从不携带原 sessionId）
        const r = await this.adapter.compute(promptText, {
          timeoutMs: opts.timeoutMs ?? this.timeoutMs,
          resetSession: i > 1,
        });
        // 英文 say 契约允许 40~120 词（≈750 字符），上限 800 才不会每轮都截断
        const parsed = parseDjAction(r.text, { maxSay: this.djLang === 'en' ? 800 : 200 });
        // 会话膨胀治理：input tokens 超阈值 → 轮换会话（否则多轮历史拖慢每一次大脑）
        const inTok = r.usage?.inputTokens ?? 0;
        if (inTok > (this.env?.inputTokenRotate ?? 30000)) {
          this.adapter.rotate?.();
        }
        this.log.info?.('大脑决策完成', {
          path: parsed.path, repairs: parsed.repairs,
          ms: Date.now() - started, attempt: i,
          usage: r.usage ? `in=${r.usage.inputTokens} out=${r.usage.outputTokens}` : undefined,
        });
        return {
          action: parsed.action,
          raw: { text: r.text, latencyMs: Date.now() - started, sessionId: r.sessionId, usage: r.usage },
          meta: { path: parsed.path, repairs: parsed.repairs, retries: i - 1, attempts: i },
        };
      } catch (e) {
        lastErr = e;
        this._recordFailure();
        this.log.warn?.(`大脑调用失败（第 ${i} 次）`, { code: e.code || 'E_UNKNOWN', error: e.message });
        if (i < attempts) {
          await new Promise((r2) => setTimeout(r2, 300 + Math.random() * 200));
        }
      }
    }

    // 降级：模板播报（合法 DjAction，reason 标注原因）
    const reasonCode = lastErr?.code || 'E_BRAIN_UNKNOWN';
    if (this.fallbackTemplate) {
      const tpl = this.fallbackTemplate({ reason: reasonCode });
      this.log.warn?.('大脑降级 → 模板播报', { reason: reasonCode });
      return {
        action: { ...tpl, degraded: ['brain_template'] },
        raw: { text: null, latencyMs: 0, sessionId: null, usage: null },
        meta: { path: 'fallback', repairs: [], retries: attempts - 1, attempts, failReason: reasonCode },
      };
    }
    throw new BrainError(reasonCode, `大脑失败且无降级模板: ${lastErr?.message || ''}`);
  }

  health() {
    return this.adapter.health();
  }

  close() {
    try { this.adapter.close(); } catch { /* ignore */ }
  }
}

/**
 * 直连大脑适配器：max_tokens 语义。
 * 关键回归：anthropic 协议下思考 token 计入 max_tokens，2000 会被思考吃光导致
 * 正文截断（stop=max_tokens）——只要还有正文就应返回而非抛 E_BRAIN_NO_FINAL。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DirectApiBrainAdapter } from '../../src/adapters/brain/direct-api.js';

const originalFetch = globalThis.fetch;

test('compute 传 maxTokens 并在 max_tokens 截断但仍有正文时返回', async () => {
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push({ url, body: JSON.parse(init.body) });
    return {
      ok: true,
      json: async () => ({
        content: [{ type: 'text', text: '被截断的正文' }],
        stop_reason: 'max_tokens',
        usage: { input_tokens: 10, output_tokens: 8000 },
      }),
    };
  };
  try {
    const a = new DirectApiBrainAdapter({ apiKey: 'k', model: 'deepseek-flash', provider: 'deepseek', baseUrl: 'https://api.deepseek.com/anthropic' });
    const r = await a.compute('写一份画像', { maxTokens: 12000 });
    assert.equal(r.text, '被截断的正文');
    assert.equal(seen[0].body.max_tokens, 12000, '透传调用方的 maxTokens');
    assert.equal(seen[0].body.effort, 'low', 'deepseek 默认压到 low 档');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('compute 默认 max_tokens 8000；彻底无正文仍报 E_BRAIN_NO_FINAL', async () => {
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push({ body: JSON.parse(init.body) });
    return {
      ok: true,
      json: async () => ({ content: [{ type: 'thinking', thinking: '只想没说' }], stop_reason: 'max_tokens', usage: {} }),
    };
  };
  try {
    const a = new DirectApiBrainAdapter({ apiKey: 'k', model: 'm', baseUrl: 'https://x.example' });
    await assert.rejects(() => a.compute('hi'), (e) => e.code === 'E_BRAIN_NO_FINAL');
    assert.equal(seen[0].body.max_tokens, 8000);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

#!/usr/bin/env node
/**
 * brain-smoke —— 大脑适配器的冒烟测试与契约回归（ZCode Agent 版）。
 *
 * 它做四件事：
 *   1. 启动 zcode app-server 子进程，推送账号 provider
 *   2. 建会话并发一句固定任务，断言拿到正文
 *   3. 校验返回的 DjAction 四个字段是否合规
 *   4. 断言第二轮会话复用（多轮记忆）可用
 *
 * 用途：
 *   - 首次部署后确认大脑可用（对应 docs/00-quick-start.md）
 *   - ZCode 桌面端/CLI 升级后做契约回归（对应 docs/13-deployment-ops.md §6）
 *
 * 退出码: 0 通过 / 1 失败
 *
 * 用法:
 *   node tools/brain-smoke.js
 *   node tools/brain-smoke.js --no-resume    # 跳过第二轮记忆测试
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ZcodeAgentAdapter } from '../src/adapters/brain/zcode-agent.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const argv = process.argv.slice(2);
const noResume = argv.includes('--no-resume');

const TASK = [
  '请只输出一个 JSON 对象，不要任何其它字符，不要 markdown 代码围栏：',
  '{"say":"自检通过","play":[],"reason":"brain smoke test","segue":""}',
].join('\n');

const RESUME_TASK = '上一轮你说的 reason 字段是什么？只回复该字段的值，不要任何其它字符。';

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '  [OK]  ' : '  [FAIL]'} ${label}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures++;
};

// ---------- DjAction 解析（与 docs/05 §6 同源的容错简化版） ----------
function extractAction(rawText) {
  if (typeof rawText !== 'string' || !rawText.trim()) return null;
  let s = rawText.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const first = s.indexOf('{');
  if (first < 0) return null;
  const last = s.lastIndexOf('}');
  s = last > first ? s.slice(first, last + 1) : s.slice(first);
  try { return JSON.parse(s); } catch { return null; }
}

console.log('brain-smoke —— 大脑契约回归（ZCode Agent）\n');

const adapter = new ZcodeAgentAdapter({ root: ROOT });
console.log(`  cli      : ${adapter.cliPath}`);
console.log(`  provider : ${adapter.providerId}`);
console.log(`  model    : ${adapter.modelId} (reasoning=${adapter.reasoningLevel})`);
console.log(`  workspace: ${adapter.workspacePath}`);
console.log(`  timeout  : ${adapter.timeoutMs} ms`);
console.log('');

const missing = adapter.availabilityDetail();
if (missing.length) {
  console.error('错误：大脑依赖不齐：');
  for (const m of missing) console.error(`  · ${m}`);
  console.error('\n处理：');
  console.error('  1) 确认 ZCode 桌面端已安装并登录过（凭据与 provider 缓存在 ~/.zcode/v2/）');
  console.error('  2) 或在 config/.env 设置 CLAUDIAO_ZCODE_CLI / CLAUDIAO_ZCODE_API_KEY');
  process.exit(1);
}

const started = Date.now();
let first = null;
try {
  first = await adapter.compute(TASK);
} catch (e) {
  console.error(`\n大脑调用失败: [${e.code}] ${e.message}`);
  if (e.detail) console.error(`  detail: ${JSON.stringify(e.detail).slice(0, 300)}`);
  adapter.close();
  process.exit(1);
}
const elapsed = Date.now() - started;

console.log('1) 进程与协议层');
check('拿到非空正文', typeof first.text === 'string' && first.text.length > 0, `${first.text?.length ?? 0} 字符`);
check('会话 id 已建立', /^sess_[0-9a-f-]{36}$/.test(first.sessionId || ''), first.sessionId || '(空)');
check('tokens 记账可用', first.usage && (first.usage.inputTokens > 0 || first.usage.outputTokens > 0),
  first.usage ? `in=${first.usage.inputTokens} out=${first.usage.outputTokens} total=${first.usage.totalTokens}` : '(空)');
check('未超时', elapsed < adapter.timeoutMs + 5000, `${elapsed} ms`);

console.log('\n2) DjAction 契约');
const action = extractAction(first.text);
check('正文是合法 JSON（容错解析后）', Boolean(action), first.text.slice(0, 120));
if (action) {
  check('含 say 字段且非空', typeof action.say === 'string' && action.say.length > 0);
  check('含 play 字段且为数组', Array.isArray(action.play));
  check('含 reason 字段', typeof action.reason === 'string');
  check('含 segue 字段', typeof action.segue === 'string');
  check('say 长度 ≤ 200 字', typeof action.say === 'string' && action.say.length <= 200,
    typeof action.say === 'string' ? `${action.say.length} 字` : '');
  console.log('\n  返回的 DjAction:');
  console.log('  ' + JSON.stringify(action, null, 2).split('\n').join('\n  '));
}

if (!noResume) {
  console.log('\n3) 会话记忆（resume）');
  let second = null;
  try {
    second = await adapter.compute(RESUME_TASK);
  } catch (e) {
    check('第二轮调用成功', false, `[${e.code}] ${e.message}`);
  }
  if (second) {
    check('第二轮调用成功', Boolean(second.text), `${second.raw?.latencyMs ?? '?'} ms`);
    check('复用同一会话', second.sessionId === first.sessionId, second.sessionId);
    const remembered = (second.text || '').includes('brain smoke test');
    check('能答出上一轮内容', remembered, (second.text || '').slice(0, 80));
  }
}

console.log(`\n总耗时 ${Date.now() - started} ms`);
adapter.close();
if (failures === 0) {
  console.log('\n结果: 通过 —— 大脑（ZCode Agent）可用且契约符合预期。\n');
  process.exit(0);
}
console.log(`\n结果: 失败 —— ${failures} 项断言未通过。\n`);
process.exit(1);

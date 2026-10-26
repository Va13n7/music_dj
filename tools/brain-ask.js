#!/usr/bin/env node
/**
 * brain-ask —— 直接和「大脑」对话，不经过电台服务。
 *
 * 这是调试大脑最快的方式：它按第三层 CONTEXT BINDOW 的六片组装 prompt，
 * 调用 ZCode Agent 大脑（src/adapters/brain/zcode-agent.js），
 * 解析出的 DjAction 以人类可读的方式打印。
 *
 * 用途:
 *   - 调语料（改 knowledge/ 后立刻看 DJ 会怎么回答）
 *   - 验证选曲是否合理、say 是否像人话
 *   - 复现大脑不听话的情况（--raw 看原始正文）
 *
 * 用法:
 *   node tools/brain-ask.js "下雨了，来点安静的"
 *   node tools/brain-ask.js --slot morning            # 模拟定时播报
 *   node tools/brain-ask.js --raw "随便"               # 额外打印原始正文
 *   node tools/brain-ask.js --reset "晚安"             # 丢弃已存会话，全新一轮
 *   node tools/brain-ask.js                            # 交互模式（逐行输入）
 *
 * 多轮记忆：适配器默认复用 data/runtime/brain-session.json 里的会话，
 * 交互模式下每一问都延续同一会话（大脑记得本轮聊过什么）。
 */
import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ZcodeAgentAdapter } from '../src/adapters/brain/zcode-agent.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ─────────────── 参数解析 ───────────────
const argv = process.argv.slice(2);
let RAW = false;
let SLOT = null;
let RESET = false;
const rest = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--raw') RAW = true;
  else if (a === '--slot') SLOT = argv[++i];
  else if (a === '--reset') RESET = true;
  else rest.push(a);
}
const task = rest.join(' ').trim();

// ─────────────── 组装六片 prompt ───────────────
function readCorpus(rel, maxChars = 3000) {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) return `（语料缺失: ${rel}）`;
  const t = fs.readFileSync(p, 'utf8');
    return t.length > maxChars ? `${t.slice(0, maxChars)}\n…（已截断，共 ${t.length} 字符）` : t;
}

function buildPrompt(userText) {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const localTime = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} `
    + `${pad(now.getHours())}:${pad(now.getMinutes())} ${now.toLocaleDateString('zh-CN', { weekday: 'long' })}`;

  const trigger = SLOT
    ? `触发来源：定时播报（slot=${SLOT}）。用户没有主动输入，是电台到点主动开口。`
    : '触发来源：用户主动输入（user_chat）。';

  return `# ① 系统提示词
${readCorpus('knowledge/prompts/dj-persona.md', 6000)}

# ② 用户语料
## taste.md
${readCorpus('knowledge/user/taste.md', 2500)}

## routines.md
${readCorpus('knowledge/user/routines.md', 2000)}

## mood-rules.md
${readCorpus('knowledge/user/mood-rules.md', 2500)}

## playlists.json（曲目池，用于兜底选曲）
${readCorpus('knowledge/user/playlists.json', 2500)}

# ③ 环境注入
当前时间：${localTime}
天气：未配置天气 API（不要编造天气）

# ④ 已检索记忆
（调试模式：无历史播放记录，recentPlays 为空）

# ⑤ 用户输入
${userText || '（无用户输入）'}

# ⑥ 执行轨迹
${trigger}

---
现在只输出一个 JSON 对象：{"say":"...","play":["艺人 - 曲名"],"reason":"...","segue":"..."}
不要任何其它字符，不要 markdown 代码围栏。`;
}

// ─────────────── DjAction 解析（容错，与 docs/05 §6 同源的简化版） ───────────────
function extractAction(rawText) {
  if (typeof rawText !== 'string' || !rawText.trim()) return { action: null, parsePath: 'empty', answer: rawText || '' };
  let s = rawText.trim();
  let parsePath = 'plain';
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) { s = fence[1].trim(); parsePath = 'fenced'; }
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first > 0 || (last >= 0 && last < s.length - 1)) {
    if (first >= 0 && last > first) { s = s.slice(first, last + 1); parsePath = 'offset'; }
  }
  try {
    return { action: JSON.parse(s), parsePath, answer: rawText };
  } catch {
    const repaired = s
      .replace(/,\s*([}\]])/g, '$1')
      .replace(/[\u201c\u201d]/g, '"')
      .replace(/[\u2018\u2019]/g, "'");
    try {
      return { action: JSON.parse(repaired), parsePath: 'repaired', answer: rawText };
    } catch {
      return { action: null, parsePath: 'failed', answer: rawText };
    }
  }
}

function printResult(r) {
  if (!r.ok) {
    console.log(`\n✗ 大脑调用失败  用时 ${r.ms}ms`);
    if (r.error) console.log(`  [${r.error.code || 'E_UNKNOWN'}] ${r.error.message}`);
    return;
  }

  if (RAW) {
    console.log('\n── 原始正文 ──');
    console.log(r.text);
    console.log('── 正文结束 ──\n');
  }

  const { action, parsePath } = extractAction(r.text);
  const u = r.usage;

  console.log(`\n用时 ${r.ms}ms · 解析路径 ${parsePath}`
    + `${u ? ` · tokens in/out ${u.inputTokens}/${u.outputTokens}` : ''}`);
  console.log(`会话 ${r.sessionId}`);

  if (!action) {
    console.log('\n✗ 无法解析出 DjAction。原始答案：\n');
    console.log(r.text || '(空)');
    console.log('\n提示：这会导致电台降级到模板播报。检查 dj-persona.md 的输出契约是否清晰。');
    return;
  }

  const sayLen = typeof action.say === 'string' ? action.say.length : 0;
  const bad = Array.isArray(action.play)
    ? action.play.filter((p) => typeof p !== 'string' || !/^\S.*?\s-\s.+$/.test(p))
    : [];

  console.log('\n╭─ 播报（会被 TTS 朗读）' + '─'.repeat(30));
  console.log(`│ ${action.say || '(空)'}`);
  console.log(`╰─ ${sayLen} 字${sayLen > 200 ? '  ⚠ 超过 200 字上限，会被截断' : ''}\n`);

  console.log('╭─ 选曲' + '─'.repeat(42));
  if (!Array.isArray(action.play) || action.play.length === 0) {
    console.log('│ （纯口播，play 为空 —— 天气/日程类回答的正常形态）');
  } else {
    action.play.forEach((t, i) => console.log(`│ ${i + 1}. ${t}`));
    if (bad.length) console.log(`│ ⚠ 格式不合规将导致检索失败: ${bad.join(' | ')}`);
  }
  console.log('╰' + '─'.repeat(48) + '\n');

  console.log('╭─ 选曲理由（不进 TTS，给界面显示）' + '─'.repeat(14));
  console.log(`│ ${action.reason || '(空)'}`);
  console.log('╰' + '─'.repeat(48) + '\n');

  if (action.segue) {
    console.log('╭─ 衔接语（曲目剩余 10s 时播放）' + '─'.repeat(15));
    console.log(`│ ${action.segue}`);
    console.log('╰' + '─'.repeat(48) + '\n');
  }

  // 快速合规检查
  const issues = [];
  if (!action.say) issues.push('say 为空 —— 会导致跳过语音');
  if (sayLen > 200) issues.push('say 超过 200 字');
  if (bad.length) issues.push('play 元素格式不合规');
  if (typeof action.reason !== 'string') issues.push('reason 缺失');
  if (/prompt|模型|数据库|系统|API/i.test(action.say || '')) issues.push('say 里提到了机制（人格要求不得说破）');
  if (/[0-9]/.test(action.say || '')) issues.push('say 含阿拉伯数字（应口语化，如"七点"而非"07:00"）');
  if (issues.length) {
    console.log('合规提示：');
    for (const i of issues) console.log(`  · ${i}`);
    console.log('');
  }
}

// ─────────────── 主流程 ───────────────
const adapter = new ZcodeAgentAdapter({ root: ROOT });
const missing = adapter.availabilityDetail();
if (missing.length) {
  console.error('错误：大脑依赖不齐：');
  for (const m of missing) console.error(`  · ${m}`);
  console.error('\n处理：确认 ZCode 桌面端已安装并登录过，或设置 CLAUDIAO_ZCODE_CLI / CLAUDIAO_ZCODE_API_KEY');
  process.exit(1);
}

console.log(`brain-ask —— 直接问大脑  (model=${adapter.modelId}, provider=${adapter.providerId})`);
if (SLOT) console.log(`模拟定时触发: slot=${SLOT}`);
if (RESET) adapter._resetSession();

async function ask(userText) {
  const started = Date.now();
  try {
    const r = await adapter.compute(buildPrompt(userText));
    return { ok: true, ...r, ms: Date.now() - started };
  } catch (e) {
    return { ok: false, error: e, ms: Date.now() - started };
  }
}

if (task) {
  const r = await ask(task);
  printResult(r);
  adapter.close();
  process.exit(r.ok ? 0 : 1);
}

// 交互模式
console.log('输入一句话回车发送；同一会话延续记忆；Ctrl+C 退出。');
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const promptNext = () => {
  rl.question('\n你 > ', async (line) => {
    const t = line.trim();
    if (!t) return promptNext();
    const r = await ask(t);
    printResult(r);
    promptNext();
  });
};
promptNext();
process.on('SIGINT', () => { adapter.close(); process.exit(0); });

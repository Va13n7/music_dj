#!/usr/bin/env node
/**
 * record-brain-fixtures —— 用**真实大脑**录制测试 fixture（旧版 dsh 专用）。
 *
 * ⚠️ 2026-10 起大脑已切换为 ZCode Agent（协议不是 NDJSON 事件流），本工具随之
 *    停用——仅当回滚到 dsh 时才需要重新可用。已录好的 fixture（tests/fixtures/brain/）
 *    仍然有效：它们回放验证的是 docs/05 §4 的 NDJSON 解析契约，不依赖 dsh 在线。
 *
 * 为什么需要它：
 *   docs/12-testing-strategy.md §3.1 规定大脑测试走「录制-回放」——
 *   CI 里绝不 spawn `dsh`（慢、需凭据、结果不确定），而是回放录下来的 NDJSON。
 *   这个工具负责「录制」那一半，让 fixture 来自真实输出而非手编。
 *
 * 它会为每个场景真实调用一次大脑，并把 NDJSON 原样写入
 *   tests/fixtures/brain/<场景>.ndjson
 * 对无法通过正常调用触发的场景（超时、退出码 1），写入带 _meta 的人造 fixture，
 * 并如实标注 `synthetic: true`。
 *
 * 用法:
 *   node tools/record-brain-fixtures.js              # 录制可录的场景
 *   node tools/record-brain-fixtures.js --all        # 含人造场景
 *   node tools/record-brain-fixtures.js --only ok-normal
 *   node tools/record-brain-fixtures.js --list       # 只看场景清单，不调用
 *
 * 注意：真实调用会计入你的 DSH 账号用量（每个场景一轮，实测 ~6s）。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIX_DIR = path.join(ROOT, 'tests', 'fixtures', 'brain');

const ARGV = process.argv.slice(2);
const ONLY = ARGV.includes('--only') ? ARGV[ARGV.indexOf('--only') + 1] : null;
const LIST = ARGV.includes('--list');
const ALL = ARGV.includes('--all');

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
const DSH_BIN = env.CLAUDIAO_DSH_BIN;
const PROFILE = env.CLAUDIAO_DSH_PROFILE || 'dj-brain';
const CWD = env.CLAUDIAO_DSH_CWD || ROOT;

/**
 * 场景定义。`record: true` 的会真实调用大脑；其余写成合成 fixture。
 * 场景编号与 docs/12-testing-strategy.md §3.1 的表格一一对应。
 */
const SCENARIOS = [
  {
    id: 'ok-normal', record: true,
    desc: '正常返回：session → turn_start → thinking → text → step_end → turn_end → final',
    task: '只输出一个 JSON 对象，不要任何其它字符：'
      + '{"say":"外面下着小雨，给你放两首安静的。","play":["李志 - 下雨","陈粒 - 小半"],'
      + '"reason":"用户提到下雨且要安静，命中雨天低能量档","segue":"听完这两首，雨还没停就换个更暖的。"}',
  },
  {
    id: 'ok-markdown-fenced', record: true,
    desc: '模型用 ```json 代码块包裹（最高频的真实畸形）',
    task: '请用 markdown 的 json 代码块包裹你的回答（这本身是个错误示范，我需要样本）。'
      + '内容为：{"say":"放首歌给你听。","play":["朴树 - 生如夏花"],"reason":"早间档","segue":""}',
  },
  {
    id: 'ok-empty-play', record: true,
    desc: 'play 为空数组（纯口播：天气/日程场景）',
    task: '只输出一个 JSON 对象，不要任何其它字符：'
      + '{"say":"今天上午十点有个会，下午空着。","play":[],"reason":"查询类意图，无需选曲","segue":""}',
  },
  {
    id: 'ok-with-usage', record: true,
    desc: '带 token 用量事件（step_end 里的 usage）',
    task: '只输出一个 JSON 对象：{"say":"用量测试。","play":[],"reason":"usage fixture","segue":""}',
  },
  {
    id: 'bad-missing-say', record: true,
    desc: '缺必填字段 say（由真实输出后处理去掉 say —— 见 _meta.postProcessed）',
    task: '只输出一个 JSON 对象，**故意不要包含 say 字段**，用于测试缺字段容错：'
      + '{"play":["李志 - 下雨"],"reason":"缺 say 字段的样本","segue":""}',
    // 实测：模型即使被要求省略，也几乎总会把 say 补上（这本身是个好信号 —— 人格契约生效了）。
    // 因此这里录真实输出，但**后处理删掉 say**，以保证 fixture 确定性地覆盖「缺字段」路径。
    // _meta.postProcessed 会如实标注这一点，不假装是原始模型输出。
    postProcess: (action) => { delete action.say; return action; },
  },
  {
    id: 'bad-overlong-say', record: true,
    desc: 'say 超过 200 字',
    task: '只输出一个 JSON 对象。say 字段请写满 400 字以上的中文散文（用于测试超长截断），'
      + '内容随意但必须是中文，play 为空数组，reason 写 "overlong fixture"。',
  },
  {
    id: 'empty-final', record: false, synthetic: true,
    desc: 'final.text 为空字符串 → 应视为失败并模板降级',
  },
  {
    id: 'bad-malformed-json', record: false, synthetic: true,
    desc: 'final.text 是截断的 JSON（`{"say":"…","play":[`）→ JSON.parse 失败，可重试',
  },
  {
    id: 'timeout', record: false, synthetic: true,
    desc: '只有 session 与 turn_start，之后无输出 → 注入短超时后应抛 E_TIMEOUT 并杀树',
  },
  {
    id: 'session-lost', record: false, synthetic: true,
    desc: '--session-id 指向不存在的会话时，返回的 sessionId 与传入值不同 → 适配器应接受新 id 不崩',
  },
  {
    id: 'exit1-credential', record: false, synthetic: true,
    desc: '退出码 1 + 凭据错误 → 识别为凭据类失败，不计入普通重试',
  },
  {
    id: 'exit1-profile-desktop', record: false, synthetic: true,
    desc: '退出码 1 + 环境变量名冲突（DSH_PROFILE 被顶掉）→ 识别为配置类失败并给出修复提示',
  },
];

// ─────────────── 合成 fixture 的内容 ───────────────
const SYNTH = {
  'empty-final': {
    meta: { scenario: 'empty-final', synthetic: true, exitCode: 0, note: 'final.text 为空 → 应模板降级' },
    lines: [
      { type: 'session', sessionId: 'session-00000000-0000-4000-8000-000000000012', cwd: '<CWD>' },
      { type: 'status', phase: 'turn_start', turn: 1 },
      { type: 'status', phase: 'step_start', turn: 1, step: 1 },
      { type: 'status', phase: 'step_end', turn: 1, step: 1 },
      { type: 'status', phase: 'turn_end', turn: 1, reason: { kind: 'completed' } },
      { type: 'final', text: '' },
    ],
  },
  'bad-malformed-json': {
    meta: { scenario: 'bad-malformed-json', synthetic: true, exitCode: 0, note: 'JSON 截断，不可修复 → 重试 1 次' },
    lines: [
      { type: 'session', sessionId: 'session-00000000-0000-4000-8000-000000000005', cwd: '<CWD>' },
      { type: 'status', phase: 'turn_start', turn: 1 },
      { type: 'status', phase: 'step_start', turn: 1, step: 1 },
      { type: 'text', text: '{"say":"这句话说到一半就断了","play":[' },
      { type: 'status', phase: 'step_end', turn: 1, step: 1 },
      { type: 'status', phase: 'turn_end', turn: 1, reason: { kind: 'completed' } },
      { type: 'final', text: '{"say":"这句话说到一半就断了","play":[' },
    ],
  },
  timeout: {
    meta: {
      scenario: 'timeout', synthetic: true, delayMs: 60000,
      note: '只有 session 与 turn_start，之后卡住 → 用注入的短超时（如 200ms）跑，应抛 E_TIMEOUT',
    },
    lines: [
      { type: 'session', sessionId: 'session-00000000-0000-4000-8000-000000000008', cwd: '<CWD>' },
      { type: 'status', phase: 'turn_start', turn: 1 },
    ],
  },
  'session-lost': {
    meta: {
      scenario: 'session-lost', synthetic: true,
      requestedSessionId: 'session-ffffffff-ffff-4fff-8fff-ffffffffffff',
      note: '传入的 sessionId 不存在时 dsh 会新建一个；返回的 id 与请求值不同 → 适配器应接受新 id',
    },
    lines: [
      { type: 'session', sessionId: 'session-00000000-0000-4000-8000-000000000011', cwd: '<CWD>' },
      { type: 'status', phase: 'turn_start', turn: 1 },
      { type: 'status', phase: 'step_start', turn: 1, step: 1 },
      { type: 'text', text: '{"say":"新会话已建立。","play":[],"reason":"session-lost fixture","segue":""}' },
      { type: 'status', phase: 'step_end', turn: 1, step: 1 },
      { type: 'status', phase: 'turn_end', turn: 1, reason: { kind: 'completed' } },
      { type: 'final', text: '{"say":"新会话已建立。","play":[],"reason":"session-lost fixture","segue":""}' },
    ],
  },
  'exit1-credential': {
    meta: { scenario: 'exit1-credential', synthetic: true, exitCode: 1, expectStderrFile: 'exit1-credential.stderr.txt' },
    lines: [],
    stderr: 'dsh: MISSING_CREDENTIAL: llm-deepseek: no API key for provider route "deepseek-official"; '
      + 'store DEEPSEEK_API_KEY through the credentials service (the web Models page writes it), '
      + 'or export DEEPSEEK_API_KEY in the launching environment\n',
  },
  'exit1-profile-desktop': {
    meta: { scenario: 'exit1-profile-desktop', synthetic: true, exitCode: 1, expectStderrFile: 'exit1-profile-desktop.stderr.txt' },
    lines: [],
    stderr: 'error: profile "desktop" is managed exclusively by the Electron application\n',
  },
};

// ─────────────── 真实录制 ───────────────
function record(scenario) {
  return new Promise((resolve) => {
    const args = ['--profile', PROFILE, '--json'];
    const started = Date.now();
    const child = spawn(`"${DSH_BIN}"`, args, {
      cwd: CWD, shell: process.platform === 'win32',
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 90000);
    child.stdout.on('data', (d) => { stdout += d.toString('utf8'); });
    child.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
    child.stdin.write(scenario.task, 'utf8');
    child.stdin.end();
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, error: e.message }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, code, stdout, stderr, ms: Date.now() - started });
    });
  });
}

if (LIST) {
  console.log('record-brain-fixtures —— 场景清单\n');
  for (const s of SCENARIOS) {
    console.log(`  ${s.record ? '[真实调用]' : '[人造    ]'} ${s.id.padEnd(24)} ${s.desc}`);
  }
  console.log(`\n共 ${SCENARIOS.length} 个场景（${SCENARIOS.filter((s) => s.record).length} 个真实调用，`
    + `${SCENARIOS.filter((s) => !s.record).length} 个人造）\n`);
  process.exit(0);
}

if (!DSH_BIN || !fs.existsSync(DSH_BIN)) {
  console.error('错误: CLAUDIAO_DSH_BIN 未设置或文件不存在。先运行 node tools/doctor.js');
  process.exit(1);
}

fs.mkdirSync(FIX_DIR, { recursive: true });
console.log('record-brain-fixtures —— 录制大脑 fixture\n');
console.log(`输出目录 : ${FIX_DIR}`);
console.log(`profile  : ${PROFILE}\n`);

const targets = SCENARIOS.filter((s) => (ONLY ? s.id === ONLY : (s.record || ALL)));
let recordedCount = 0;
let syntheticCount = 0;
let failed = 0;

for (const s of targets) {
  if (!s.record) {
    // 人造 fixture
    const synth = SYNTH[s.id];
    if (!synth) { console.log(`  ⚠ ${s.id}: 缺少合成内容，跳过`); continue; }
    const out = [
      JSON.stringify({ type: '_meta', ...synth.meta }),
      ...synth.lines.map((l) => JSON.stringify(l)),
    ].join('\n') + '\n';
    fs.writeFileSync(path.join(FIX_DIR, `${s.id}.ndjson`), out, 'utf8');
    if (synth.stderr) {
      fs.writeFileSync(path.join(FIX_DIR, `${s.id}.stderr.txt`), synth.stderr, 'utf8');
    }
    console.log(`  ✓ ${s.id.padEnd(24)} 人造 fixture（${synth.lines.length} 个事件）`);
    syntheticCount++;
    continue;
  }

  process.stdout.write(`  … ${s.id.padEnd(24)} 真实调用中`);
  const r = await record(s);
  if (!r.ok) {
    console.log(`\r  ✗ ${s.id.padEnd(24)} 调用失败 (exit=${r.code ?? 'ERR'}) ${r.error || ''}`);
    if (r.stderr) console.log(`      ${r.stderr.trim().split('\n')[0]}`);
    failed++;
    continue;
  }

  const lines = r.stdout.split(/\r?\n/).filter((l) => l.trim());
  // 校验每行都是合法 JSON
  const bad = lines.filter((l) => { try { JSON.parse(l); return false; } catch { return true; } });
  if (bad.length) {
    console.log(`\r  ✗ ${s.id.padEnd(24)} 输出含 ${bad.length} 行非 JSON`);
    failed++;
    continue;
  }

  // 把真实 cwd 与 sessionId 泛化，避免 fixture 绑定本机路径
  let postProcessed = false;
  const generic = lines.map((l) => {
    const o = JSON.parse(l);
    if (o.cwd) o.cwd = '<CWD>';
    if (o.type === 'session' && o.sessionId) {
      const n = String(recordedCount + 1).padStart(2, '0');
      o.sessionId = `session-00000000-0000-4000-8000-0000000000${n}`;
    }
    // 场景声明的后处理（例如强制删掉 say 以覆盖缺字段路径）
    if (s.postProcess && o.type === 'final' && typeof o.text === 'string') {
      try {
        const a = JSON.parse(o.text);
        o.text = JSON.stringify(s.postProcess(a));
        postProcessed = true;
      } catch { /* 原样保留 */ }
    }
    return JSON.stringify(o);
  });

  const meta = JSON.stringify({
    type: '_meta', scenario: s.id, synthetic: false,
    recordedAt: new Date().toISOString(), latencyMs: r.ms, exitCode: 0,
    desc: s.desc,
    ...(postProcessed ? {
      postProcessed: true,
      postProcessNote: '由真实模型输出后处理而来（非原始字节），用于确定性地覆盖该边界路径',
    } : {}),
  });

  fs.writeFileSync(path.join(FIX_DIR, `${s.id}.ndjson`), `${meta}\n${generic.join('\n')}\n`, 'utf8');
  console.log(`\r  ✓ ${s.id.padEnd(24)} 已录制（${lines.length} 个事件，${r.ms}ms）`);
  recordedCount++;
}

// ─────────────── 校验录到的内容确实符合场景意图 ───────────────
console.log('\n── 场景意图校验 ──');
function readFixture(id) {
  const p = path.join(FIX_DIR, `${id}.ndjson`);
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, 'utf8').split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l));
}
function finalText(evs) {
  return evs.find((e) => e.type === 'final')?.text ?? '';
}
const checks = [
  ['ok-normal', (e) => { const t = finalText(e); try { const a = JSON.parse(t); return !!a.say && Array.isArray(a.play) && a.play.length > 0; } catch { return false; } },
    'final.text 是合法 JSON 且 play 非空'],
  ['ok-markdown-fenced', (e) => /```/.test(finalText(e)), 'final.text 含 markdown 代码围栏'],
  ['ok-empty-play', (e) => { try { return JSON.parse(finalText(e)).play.length === 0; } catch { return false; } },
    'play 为空数组'],
  ['ok-with-usage', (e) => e.some((x) => x.type === 'status' && x.usage), '含 usage 事件'],
  ['bad-missing-say', (e) => { try { return JSON.parse(finalText(e)).say === undefined; } catch { return false; } },
    '缺 say 字段'],
  ['bad-overlong-say', (e) => { try { return JSON.parse(finalText(e)).say.length > 200; } catch { return false; } },
    'say 超过 200 字'],
  ['empty-final', (e) => finalText(e) === '', 'final.text 为空字符串'],
  ['bad-malformed-json', (e) => { try { JSON.parse(finalText(e)); return false; } catch { return true; } }, 'final.text 不可解析'],
  ['timeout', (e) => !e.some((x) => x.type === 'final'), '无 final 事件'],
  ['session-lost', (e) => { const m = e.find((x) => x.type === '_meta'); return !!m?.requestedSessionId; }, '声明了 requestedSessionId'],
];

let checkFail = 0;
for (const [id, fn, expect] of checks) {
  const evs = readFixture(id);
  if (!evs) { console.log(`  ? ${id.padEnd(24)} fixture 不存在`); continue; }
  let pass = false;
  try { pass = fn(evs); } catch { pass = false; }
  console.log(`  ${pass ? '✓' : '✗'} ${id.padEnd(24)} ${expect}`);
  if (!pass) checkFail++;
}

console.log(`\n${'─'.repeat(52)}`);
console.log(`真实录制 ${recordedCount} 个 · 人造 ${syntheticCount} 个 · 调用失败 ${failed} 个 · 意图不符 ${checkFail} 个`);
console.log('');

if (failed || checkFail) {
  console.log('部分场景未达预期。注意：模型输出本身有随机性，');
  console.log('若某个「真实录制」场景意图不符，可单独重录：');
  console.log(`  node tools/record-brain-fixtures.js --only ${checks[checkFail - 1]?.[0] || '<场景名>'}\n`);
  process.exit(1);
}
console.log('全部 fixture 就绪，可用于回放测试（BRAIN_REPLAY_DIR）。\n');

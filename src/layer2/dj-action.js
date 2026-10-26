/**
 * Claudiao · DjAction 容错解析（M1-T2，docs/05-brain-adapter.md §6 / docs/03 §4.3）
 *
 * 解析 11 步 + 修复序列 R1~R6 的可执行实现。纯函数、零 I/O。
 * 返回 { action, path, repairs }；path ∈ final|plain|fenced|offset|repaired，
 * path ∉ {final, plain, fenced} 时上层标 degraded（03 §4.3）。
 */

/** 步骤 3：取所有成对 ``` 块中最长的一个；无闭合则取首个 ``` 之后到文末 */
export function extractLongestFence(s) {
  const blocks = [...s.matchAll(/```[^\n]*\n?([\s\S]*?)```/g)].map((m) => m[1]);
  if (blocks.length) return blocks.reduce((a, b) => (b.length > a.length ? b : a)).trim();
  const i = s.indexOf('```');
  return s.slice(s.indexOf('\n', i) + 1).trim();
}

export const FALLBACK_SAY = '这会儿先放首歌，我待会儿再说。';

/** 步骤 6：R1~R6 顺序固定不跳步；每步后重试，成功即停，repairs 累加标记 */
export function repairUntilParsable(src) {
  const repairs = [];
  const steps = [
    ['R1', (t) => t.replace(/,\s*(?=[}\]])/g, '')],                                    // 尾随逗号
    ['R2', (t) => t.replace(/[“”„‟]/g, '"').replace(/[‘’‚‛]/g, "'")],                 // 中文引号
    ['R3', (t) => (t.includes('"') ? t : singleToDouble(t))],                          // 单引号（整段无 " 才启用）
    ['R4', escapeBareNewlines],                                                        // 字符串内裸换行
    ['R5', closeBrackets],                                                             // 括号补齐
    ['R6', (t) => { const a = t.indexOf('{'), b = t.lastIndexOf('}'); return b > a ? t.slice(a, b + 1) : t; }],
  ];
  let t = src;
  for (const [name, fn] of steps) {
    const next = fn(t);
    if (next !== t) { t = next; repairs.push(name); }
    try { return { obj: JSON.parse(t), repairs }; } catch { /* 继续下一步 */ }
  }
  const e = new Error('修复序列 R1~R6 用尽仍不可解析');
  e.code = 'E_BRAIN_PARSE';
  e.repairs = repairs;
  throw e;
}

/** R3：状态机扫描，只在字符串外部把 ' 当引号；字符串内部的 ' 原样保留（JSON 双引号串内无需转义，\' 反而是非法转义） */
function singleToDouble(t) {
  let out = '', inStr = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (c === "'") {
      if (!inStr) { out += '"'; inStr = true; }
      else if (t[i + 1] === undefined || /[\s,\}\]:]/.test(t[i + 1])) { out += '"'; inStr = false; }
      else out += c;
    } else out += (inStr && c === '"') ? '\\"' : c;
  }
  return out;
}

/** R4：仅在字符串内部把裸 \n 转义；字符串外部保持原样 */
function escapeBareNewlines(t) {
  let out = '', inStr = false, esc = false;
  for (const c of t) {
    if (esc) { out += c; esc = false; continue; }
    if (c === '\\') { out += c; esc = true; continue; }
    if (c === '"') { inStr = !inStr; out += c; continue; }
    out += (inStr && c === '\n') ? '\\n' : c;
  }
  return out;
}

/** R5：统计未闭合的 { [ ，按栈逆序补齐 */
function closeBrackets(t) {
  const stack = []; let q = false, esc = false;
  for (const c of t) {
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (c === '"') { q = !q; continue; }
    if (q) continue;
    if (c === '{' || c === '[') stack.push(c);
    else if (c === '}' || c === ']') stack.pop();
  }
  while (stack.length) t += stack.pop() === '{' ? '}' : ']';
  return t;
}

/** 主入口：原文 → { action, path, repairs }。空文本抛 E_BRAIN_NO_FINAL。 */
export function parseDjAction(rawText, { maxSay = 200, maxIntro = 160 } = {}) {
  if (typeof rawText !== 'string' || !rawText.trim()) {
    throw Object.assign(new Error('大脑返回为空'), { code: 'E_BRAIN_NO_FINAL' });
  }
  let s = rawText.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim();
  let path = 'plain', repairs = [];

  // 3 围栏
  if (s.includes('```')) { s = extractLongestFence(s); path = 'fenced'; }

  // 4 首个 { 到最后一个 }
  const a = s.indexOf('{');
  if (a < 0) {
    throw Object.assign(new Error('E_NO_OBJECT_START'), { code: 'E_BRAIN_PARSE', path, repairs });
  }
  const b = s.lastIndexOf('}');
  const cut = b > a ? s.slice(a, b + 1) : s.slice(a);
  if (path === 'plain' && (a > 0 || cut.length !== s.length)) path = 'offset';
  s = cut;

  // 5 JSON.parse，失败进修复序列
  let obj;
  try { obj = JSON.parse(s); }
  catch {
    const r = repairUntilParsable(s);
    obj = r.obj; repairs = r.repairs; path = 'repaired';
  }

  return { action: normalizeAndValidate(obj, { maxSay, maxIntro }), path, repairs };
}

/** 步骤 9 + 10：归一化与校验（上限取自 docs/03 §4.2；英文模式 maxSay 放宽到 800 字符） */
export function normalizeAndValidate(o, { maxSay = 200, maxIntro = 160 } = {}) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) {
    throw Object.assign(new Error('DjAction 不是对象'), { code: 'E_BRAIN_PARSE' });
  }
  const clean = (s) => String(s)
    .replace(/^#{1,6}\s+/gm, '').replace(/\*\*?|__|~~|`/g, '')
    .replace(/\s+/g, ' ').trim();
  const degraded = [];

  // say：1~200 字（英文模式放宽）；空 → 模板兜底句（不抛错）；超长按句末截断
  let say = typeof o.say === 'string' ? clean(o.say) : '';
  if (!say) { say = FALLBACK_SAY; degraded.push('say_template'); }
  const clamped = clampSay(say, maxSay);
  if (clamped !== say) { say = clamped; degraded.push('say_truncated'); }

  // play：归一化后收敛到 0~5 个
  let play = normalizePlay(o.play);
  if (play.length > 5) { play = play.slice(0, 5); degraded.push('play_truncated'); }

  // intros：与 play 对齐的每首口播（压在音乐上朗读）
  let intros = normalizeIntros(o.intros, { maxIntro });
  if (intros.length > play.length) { intros = intros.slice(0, play.length); degraded.push('intros_truncated'); }
  else if (play.length && intros.length < play.length) degraded.push('intros_partial');
  intros = play.map((_, i) => intros[i] || '');   // 对齐：缺的补空串（该首无口播直接放歌）

  // reason：缺失 → 占位 + degraded；上限 200 字
  let reason = typeof o.reason === 'string' ? clean(o.reason) : '';
  if (!reason) { reason = '（模型未给出理由）'; degraded.push('reason_missing'); }
  reason = Array.from(reason).slice(0, 200).join('');

  // segue：选填；非字符串 → ""；上限 120 字
  let segue = typeof o.segue === 'string' ? clean(o.segue) : '';
  segue = Array.from(segue).slice(0, 120).join('');

  return { say, play, intros, reason, segue, degraded };
}

/** intros 归一化：字符串数组，逐句清洗 + 截断（maxIntro 160 中文字符 / 300 英文字符由调用方定） */
export function normalizeIntros(v, { maxIntro = 160 } = {}) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const item of v) {
    if (typeof item !== 'string') continue;
    const t = item.replace(/^#{1,6}\s+/gm, '').replace(/\*\*?|__|~~|`/g, '').replace(/\s+/g, ' ').trim();
    if (!t) continue;
    out.push(clampSay(t, maxIntro));
  }
  return out;
}

/** play 归一化（docs/05 §6 步骤 9a~9e） */
export function normalizePlay(v) {
  const DASH = /\s*[－—–]\s*/g;
  const one = (s) => {
    let t = String(s).replace(/[\u0000-\u001f\u007f]/g, '').replace(DASH, ' - ').replace(/\s+/g, ' ').trim();
    if (!t) return null;
    const i = t.indexOf(' - ');
    t = i < 0 ? t : `${t.slice(0, i).trim()} - ${t.slice(i + 3).trim()}`;
    return t.slice(0, 120);
  };
  if (Array.isArray(v)) {
    return [...new Set(v.map((x) => (typeof x === 'string' ? one(x)
      : (x && typeof x === 'object')
        ? one([x.artist, x.title].filter(Boolean).join(' - ')) : null)).filter(Boolean))];
  }
  if (typeof v === 'string') return [...new Set(v.split(/[\n，,、]/).map(one).filter(Boolean))];
  return [];                                                            // 9c：null/缺失/其它
}

/** say 超长截断：按最后一个句末标点截到 ≤max；标点位置 <50% 不采用 */
export function clampSay(say, max = 200) {
  const cp = Array.from(String(say).trim());
  if (cp.length <= max) return cp.join('');
  const head = cp.slice(0, max).join('');
  const m = head.match(/^[\s\S]*[。！？!?…；;.]/);
  return (m && m[0].length >= max * 0.5) ? m[0].trim() : head.replace(/[\s，,、：:]+$/, '') + '…';
}

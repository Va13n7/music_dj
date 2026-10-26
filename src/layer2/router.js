/**
 * Claudiao · 意图路由（M4-T1，docs/02 §2）
 *
 * classify(input) → Intent。S0 来源分流 → S1 归一化 → S2 control → S3 query
 * → S4 taste_edit → S5 play_request → S6 mood_request → S7 freeform。首次命中即返回。
 *
 * mood 表驱动：初始化时解析 knowledge/user/mood-rules.md §一 的「档位 ID | 触发信号」
 * 表格，生成 keyword→moodId 索引（最长关键词优先）；语料文件 mtime 变化自动重载。
 * 规则引擎内部异常 → 强制 freeform（E_ROUTE_FALLBACK），绝不阻塞电台。
 */
import fs from 'node:fs';
import path from 'node:path';

// ---------- 直连词表（docs/02 §2.3） ----------

const CONTROL_WORDS = [
  [/^(暂停|停|停一下|别放了)$/, 'pause'],
  [/^(继续|接着放|恢复)$/, 'resume'],
  [/^(下一首|下一曲|换一首|跳过|切歌|这首不好听)$/, 'next'],
  [/^(上一首|回到上一首|刚才那首)$/, 'prev'],
  [/^(大点声|大声点)$/, 'volume_up'],
  [/^(小声点|小点声)$/, 'volume_down'],
  [/^(静音)$/, 'mute'],
  [/^(取消静音)$/, 'unmute'],
  [/^(别说话了|只放歌)$/, 'mute_say_on'],
  [/^(可以说话了)$/, 'mute_say_off'],
];

const QUERY_WORDS = [
  [/^(在放什么|放的是哪首|这首是谁的|谁唱的|现在在放什么)$/, 'now'],
  [/^(今天放什么|今天什么安排|今日规划|今天有什么安排)$/, 'plan'],
  [/^(刚才那首|上一首是什么|前一首)$/, 'history'],
  [/^为什么放这首$/, 'why'],
  [/^(你怎么选的)$/, 'why'],
  [/^(还有几首)$/, 'queue'],
  [/^(放过|听过).+(吗|么)$/, 'played'],
];

const PLAY_VERBS = /^(放|播|来一首|来一个|来点|听|点一首|给我放|换成|换一首|换个|播放)/;
const TASTE_VERBS = [ '以后别放', '别再放', '记住', '记一下', '我不喜欢', '我爱听', '加进', '从歌单里去掉', '删掉' ];

function normalize(text) {
  return String(text || '')
    .replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)) // 全角→半角
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[。！？，、；～~]+$/, '');
}

// ---------- mood 表驱动 ----------

let _moodIndex = null;      // [{keyword, mood}]
let _moodMtime = 0;
let _moodFile = null;

function loadMoodTable(knowledgeDir) {
  const file = path.join(knowledgeDir, 'user', 'mood-rules.md');
  let mtime = 0;
  try { mtime = fs.statSync(file).mtimeMs; } catch { _moodIndex = []; _moodMtime = 0; return; }
  if (_moodIndex && file === _moodFile && mtime === _moodMtime) return;
  _moodFile = file; _moodMtime = mtime;
  const text = fs.readFileSync(file, 'utf8');
  const seg = text.split('## 一、情绪匹配表')[1]?.split('###')[0] || '';
  const idx = [];
  // 表行：| `calm` | 安静、静一静、别吵 | 能量 | 策略 | 语气 |
  for (const m of seg.matchAll(/^\| `([a-z_]+)` \s*\|([^|]*)\|/gm)) {
    const mood = m[1];
    const signals = m[2].split(/[、,，/]/).map((s) => s.trim().replace(/^`|`$/g, '')).filter(Boolean);
    for (const k of signals) idx.push({ keyword: k, mood });
  }
  _moodIndex = idx;
}

/** 匹配情绪：多档命中取「出现位置最早 → 关键词最长」；返回 {mood, candidates} 或 null */
export function matchMood(text, knowledgeDir) {
  loadMoodTable(knowledgeDir);
  if (!_moodIndex?.length) return null;
  const hits = _moodIndex
    .filter((e) => text.includes(e.keyword))
    .map((e) => ({ ...e, pos: text.indexOf(e.keyword) }))
    .sort((a, b) => (a.pos - b.pos) || (b.keyword.length - a.keyword.length));
  if (!hits.length) return null;
  const mood = hits[0].mood;
  const candidates = [...new Set(hits.map((h) => h.mood))];
  return { mood, candidates };
}

// ---------- 判定器 ----------

function matchControl(t) {
  for (const [re, action] of CONTROL_WORDS) {
    if (re.test(t)) {
      const residual = t.replace(re, '').trim();
      if (residual.length > 2) return null;                     // 带宾语 → 下落
      return action;
    }
  }
  return null;
}

function matchQuery(t) {
  for (const [re, q] of QUERY_WORDS) if (re.test(t)) return q;
  return null;
}

function hasTitleMarker(t) {
  if (/《.+》|「.+」|“.+”|'(.+)'/.test(t)) return true;
  if (t.includes(' - ')) return true;
  if (/(.)的([^的]{1,20})/.test(t)) return true;                // X的Y（Y 情绪词过滤在调用侧做）
  return false;
}

/** S5 抽取：artist - title → 《title》 → X的Y → 残余 */
function extractTrackSpec(t) {
  const stripped = t.replace(PLAY_VERBS, '').trim();
  let m = stripped.match(/^(.{1,30}?)\s+-\s+(.+)$/);
  if (m) return { artist: m[1].trim(), title: m[2].trim(), titleMark: true };
  m = stripped.match(/^《(.+?)》$/);
  if (m) return { artist: '', title: m[1].trim(), titleMark: true };
  m = stripped.match(/^(?:一首)?(.{1,20}?)的(.+)$/);
  if (m) return { artist: m[1].trim(), title: m[2].trim(), titleMark: true };
  m = stripped.match(/^(?:一首)?(.{1,20}?)的$/);                       // 「周杰伦的」= 只点歌手
  if (m) return { artist: m[1].trim(), title: '', query: m[1].trim(), titleMark: true };
  const residual = stripped.replace(/^(一首|个|首)/, '').trim();
  return { artist: '', title: '', query: residual, titleMark: residual.length >= 2 };
}

/**
 * @param {object} input { text, source?('user_chat'|'schedule'|'webhook'|'startup'), slot?, skill? }
 * @param {object} [ctx] { knowledgeDir }
 * @returns {Intent}
 */
export function classify(input, ctx = {}) {
  const knowledgeDir = ctx.knowledgeDir || path.join(process.cwd(), 'knowledge');
  const source = input.source || 'user_chat';
  const rawText = String(input.text || '');

  // S0 来源分流
  if (source === 'schedule' || source === 'webhook' || input.skill) {
    const isSchedule = source === 'schedule';
    return freezeIntent({
      id: iid(), name: isSchedule ? 'scheduled_broadcast' : 'skill_trigger',
      lane: 'brain', needBrain: input.useBrain !== false,
      source, priority: isSchedule ? 'schedule' : 'user_chat',
      text: rawText, rawText,
      slots: { slot: input.slot || null, skill: input.skill || null },
      confidence: 1, at: new Date().toISOString(),
    });
  }
  if (source !== 'user_chat') {
    // startup 等系统触发也走 scheduled 语义
    return freezeIntent({
      id: iid(), name: 'scheduled_broadcast', lane: 'brain', needBrain: input.useBrain !== false,
      source, priority: 'prefetch', text: rawText, rawText,
      slots: { slot: input.slot || null }, confidence: 1, at: new Date().toISOString(),
    });
  }

  // S1 归一化
  let text = normalize(rawText);
  const truncated = text.length > 500;
  if (truncated) text = text.slice(0, 500);

  const base = { id: iid(), source, priority: 'user_chat', text, rawText, at: new Date().toISOString(), truncated };
  const moodHit = matchMood(text, knowledgeDir);

  try {
    // S2 control
    if (text.length <= 12) {
      const c = matchControl(text);
      if (c) {
        return freezeIntent({ ...base, name: 'control', lane: 'direct', needBrain: false,
          slots: { control: c }, confidence: 1, reason: '命中控制词表' });
      }
    }
    // S3 query
    if (text.length <= 20) {
      const q = matchQuery(text);
      if (q) {
        return freezeIntent({ ...base, name: 'query', lane: 'direct', needBrain: false,
          slots: { query: q }, confidence: 1, reason: '命中查询句式' });
      }
      // 「放过 X 吗」带宾语
      const played = text.match(/^(?:放过|听过)(.+?)(?:吗|么)$/);
      if (played) {
        return freezeIntent({ ...base, name: 'query', lane: 'direct', needBrain: false,
          slots: { query: 'played', arg: played[1].trim() }, confidence: 0.9, reason: '命中「放过…吗」句式' });
      }
    }
    // S4 taste_edit
    for (const v of TASTE_VERBS) {
      if (text.includes(v)) {
        return freezeIntent({ ...base, name: 'taste_edit', lane: 'brain', needBrain: true,
          slots: {}, confidence: 0.9, reason: `命中改写动词「${v}」` });
      }
    }
    // S5 play_request
    if (PLAY_VERBS.test(text) && !moodHit) {
      const spec = extractTrackSpec(text);
      const cleanTitle = spec.title && !moodHit;
      if (spec.titleMark && cleanTitle) {
        return freezeIntent({ ...base, name: 'play_request', lane: 'music', needBrain: false,
          slots: { artist: spec.artist, title: spec.title, query: spec.query || `${spec.artist} ${spec.title}`.trim() },
          confidence: 0.95, reason: '点播动词 + 标题标记 + 无情绪词 → 音乐车道' });
      }
      // 模糊 → brain，带检索词
      return freezeIntent({ ...base, name: 'play_request', lane: 'brain', needBrain: true,
        slots: { query: spec.query || spec.title || text, artist: spec.artist },
        confidence: 0.5, reason: '点播但模糊（无明确标题标记）→ 大脑定夺' });
    }
    // S6 mood_request
    if (moodHit) {
      return freezeIntent({ ...base, name: 'mood_request', lane: 'brain', needBrain: true,
        slots: { mood: moodHit.mood, moodCandidates: moodHit.candidates },
        confidence: 0.85, reason: `命中 mood-rules 触发词 → ${moodHit.mood}` });
    }
    // S7 freeform
    return freezeIntent({ ...base, name: 'freeform', lane: 'brain', needBrain: true,
      slots: {}, confidence: 0.3, reason: '兜底' });
  } catch (e) {
    // 规则故障不阻塞电台
    return freezeIntent({ ...base, name: 'freeform', lane: 'brain', needBrain: true,
      slots: {}, confidence: 0.1, reason: `E_ROUTE_FALLBACK: ${e.message}` });
  }
}

let _seq = 0;
function iid() {
  return `i_${Date.now().toString(36)}_${(_seq++).toString(36)}${Math.random().toString(36).slice(2, 5)}`;
}

function freezeIntent(o) {
  o.slots = Object.freeze(o.slots || {});
  return Object.freeze(o);
}

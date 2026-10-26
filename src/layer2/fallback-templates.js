/**
 * Claudiao · 兜底模板（M4-T4）
 *
 * 大脑失败时按「时段 × 情绪」选模板播报 + 从 playlists.json 对应档位取曲。
 * 产物必须是合法 DjAction（docs/05 §7：下游 resolve/tts 完全无感）。
 */
import fs from 'node:fs';
import path from 'node:path';

const TEMPLATES = {
  morning: ['早上好。新的一天，从一首合适的歌开始。', '醒了就好。给你安排了今天的开场曲。'],
  noon: ['中午了。吃饭的时候，来点不抢戏的。', '午间放空，这几首刚刚好。'],
  evening: ['下班了就别绷着。这几首松弛的，适合现在。', '傍晚了，能量调低一点，慢慢听。'],
  night: ['夜深了。声音放低，听完这几首就休息。', '睡前最后一轮，都是安静的。'],
  default: ['这几首给现在的你。', '不多说了，听歌。'],
};

const MOOD_TEMPLATES = {
  rainy: ['雨声够大了，音乐就让着点。', '下雨天，慢一点的刚刚好。'],
  calm: ['别说话，听歌。', '安静下来，这几首陪着。'],
  focus: ['开始吧。这几首不打扰你。', '专注模式，我在背景里。'],
  low: ['不劝你。这几首懂。', '丧的时候，音乐比人会用词。'],
  energize: ['来，提起来。', '这几首带劲，音量自己看着办。'],
  tired: ['困就早点歇。这几首不费脑子。', '低电量模式，声音也调低了。'],
  nostalgic: ['老歌一响，时间就慢了。', '这几首有点年头，正合适。'],
};

function periodOf(hour) {
  if (hour >= 6 && hour < 11) return 'morning';
  if (hour >= 11 && hour < 14) return 'noon';
  if (hour >= 14 && hour < 19) return 'evening';
  return 'night';
}

/** 从 playlists.json 按 mood 优先、slot 次之挑歌单，打散取曲 */
function pickTracks(playlists, { mood, slot, max = 3 }) {
  if (!playlists?.length) return [];
  const byMood = mood ? playlists.filter((p) => (p.moods || []).includes(mood)) : [];
  const bySlot = slot ? playlists.filter((p) => (p.slots || []).includes(slot)) : [];
  const pool = (byMood.length ? byMood : bySlot.length ? bySlot : playlists);
  const merged = pool.flatMap((p) => (p.tracks || []).map((t) => (typeof t === 'string' ? t : t.spec || '')));
  const shuffled = [...new Set(merged)].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, max).filter(Boolean);
}

/**
 * @param {object} ctx { reason('E_BRAIN_TIMEOUT'…), mood?, slot?, hour?, playlistsDir? }
 * @returns {{say,play[],reason,segue}} 合法 DjAction（degraded 由调用方追加）
 */
export function templateAction(ctx = {}) {
  const hour = ctx.hour ?? new Date().getHours();
  const period = periodOf(hour);
  const pool = ctx.mood && MOOD_TEMPLATES[ctx.mood] ? MOOD_TEMPLATES[ctx.mood] : TEMPLATES[period];
  const say = pool[Math.floor(Math.random() * pool.length)];

  let play = [];
  try {
    const dir = ctx.playlistsDir || path.join(process.cwd(), 'knowledge', 'user');
    const raw = fs.readFileSync(path.join(dir, 'playlists.json'), 'utf8');
    play = pickTracks(JSON.parse(raw).playlists, { mood: ctx.mood, slot: ctx.slot, max: 3 });
  } catch { /* 语料缺失 → 纯口播（allowEmptyPlay=true） */ }

  return { say, play, reason: `大脑降级：${ctx.reason || 'unknown'}（模板播报）`, segue: '' };
}

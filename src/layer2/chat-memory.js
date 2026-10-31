/**
 * Claudiao · 对话记忆（近三日聊天，本地 JSON 文档）
 *
 * 与 recommend-memory 同款模式：按日期分桶存 data/runtime/chat-memory.json，
 * 只留最近 N 天，超期自动裁剪。注入大脑 CHAT_LOG 片段，让闲聊接得上前文。
 * 纯本地文件读写，零 token 存储成本，不拖慢思考。
 */
import fs from 'node:fs';
import path from 'node:path';

export class ChatMemory {
  /** @param {object} opts { root, log?, days?(默认 3), maxPerDay?(每日上限，默认 200) } */
  constructor({ root, log, days = 3, maxPerDay = 200 } = {}) {
    this.file = path.join(root, 'data', 'runtime', 'chat-memory.json');
    this.log = log || console;
    this.days = days;
    this.maxPerDay = maxPerDay;
  }

  _key(ms) {
    const d = new Date(ms);
    return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
  }

  _load() {
    try {
      const j = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return j && typeof j === 'object' && !Array.isArray(j) ? j : {};
    } catch { return {}; }
  }

  _save(data) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(data, null, 2));
  }

  /** 裁剪：只留最近 N 天的桶。基准 = max(nowMs, 数据内最新一条时间)——
   *  乱序时间戳（补记旧消息/时钟偏差）不会把更新的桶裁掉 */
  _prune(data, nowMs = Date.now()) {
    let newest = nowMs;
    for (const list of Object.values(data)) {
      if (!Array.isArray(list)) continue;
      for (const m of list) { const at = m?.at || 0; if (at > newest) newest = at; }
    }
    const keep = new Set();
    for (let i = 0; i <= this.days; i++) keep.add(this._key(newest - i * 864e5));
    const out = {};
    for (const [date, list] of Object.entries(data)) {
      if (keep.has(date) && Array.isArray(list) && list.length) out[date] = list;
    }
    return out;
  }

  /** 记录一条对话（role: 'user' | 'dj'；text 超 200 字截断） */
  record(role, text, atMs = Date.now()) {
    const t = String(text || '').trim();
    if (!t || (role !== 'user' && role !== 'dj')) return;
    const data = this._prune(this._load(), atMs);
    const key = this._key(atMs);
    const bucket = Array.isArray(data[key]) ? data[key] : [];
    bucket.push({ role, text: t.slice(0, 200), at: atMs });
    while (bucket.length > this.maxPerDay) bucket.shift();   // 单日超限丢最旧
    data[key] = bucket;
    this._save(this._prune(data, atMs));
  }

  /** 近三日对话拼成提示文本（旧→新；从最新往回取，超 maxChars 戛然而止） */
  recent({ maxChars = 1800 } = {}) {
    const data = this._prune(this._load());
    const lines = [];
    for (const date of Object.keys(data).sort()) {
      for (const m of data[date]) {
        const d = new Date(m.at || Date.now());
        const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
        const who = m.role === 'user' ? '台长' : 'Valen';
        lines.push(`[${hm}] ${who}：${m.text}`);
      }
    }
    const out = [];
    let used = 0;
    for (let i = lines.length - 1; i >= 0; i--) {   // 从最新往回收
      const l = lines[i];
      if (used + l.length > maxChars && out.length) break;
      out.unshift(l);
      used += l.length;
    }
    return out.join('\n');
  }

  /** 近三日消息条数（诊断/测试用） */
  count() {
    const data = this._prune(this._load());
    return Object.values(data).reduce((n, list) => n + list.length, 0);
  }
}

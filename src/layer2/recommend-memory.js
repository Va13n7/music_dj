/**
 * Claudiao · 推荐记忆（近三日不重复）
 *
 * 记录大脑推荐过的所有曲目（按日期分桶，本地 JSON），供选曲过滤：
 * 近三日推荐过的不允许重复，超过三日自动允许。纯本地文件 + Set 查询，
 * 零 token 成本，不影响思考速度。
 */
import fs from 'node:fs';
import path from 'node:path';

const normText = (s) => String(s || '').toLowerCase().replace(/\s+/g, '');

export class RecommendMemory {
  /** @param {object} opts { root, log?, days?(默认 3) } */
  constructor({ root, log, days = 3 } = {}) {
    this.file = path.join(root, 'data', 'runtime', 'recommend-memory.json');
    this.log = log || console;
    this.days = days;
  }

  _today() {
    const d = new Date();
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

  /** 裁剪：只留最近 N 天的桶（N = days + 今天） */
  _prune(data) {
    const keep = new Set();
    const d = new Date();
    for (let i = 0; i <= this.days; i++) {
      const t = new Date(d.getTime() - i * 864e5);
      keep.add(`${t.getFullYear()}-${t.getMonth() + 1}-${t.getDate()}`);
    }
    const out = {};
    for (const [date, list] of Object.entries(data)) {
      if (keep.has(date) && Array.isArray(list) && list.length) out[date] = list;
    }
    return out;
  }

  /** 记录一批推荐（specs: ['艺人 - 曲名', ...]，去重追加到今天的桶） */
  record(specs = []) {
    if (!Array.isArray(specs) || !specs.length) return;
    const data = this._prune(this._load());
    const today = this._today();
    const bucket = new Set(data[today] || []);
    let added = 0;
    for (const spec of specs) {
      const s = String(spec || '').trim();
      if (!s) continue;
      if (!bucket.has(s)) { bucket.add(s); added++; }
    }
    data[today] = [...bucket];
    this._save(this._prune(data));
    if (added) this.log.info?.(`推荐记忆 +${added}（今日累计 ${data[today].length}）`);
  }

  /** 近三日推荐过的归一化键集合：'norm(艺人)|norm(曲名)'，与 compute.pairKey 同构 */
  recentKeys() {
    const data = this._prune(this._load());
    const keys = new Set();
    for (const list of Object.values(data)) {
      for (const spec of list) {
        const m = String(spec).match(/^(?<artist>.+?)\s-\s(?<title>.+)$/);
        if (m) keys.add(`${normText(m.groups.artist)}|${normText(m.groups.title)}`);
        else keys.add(`|${normText(spec)}`);
      }
    }
    return keys;
  }

  /** 近三日推荐过的原始清单（旧→新按日期），注入漫游提示的避重名单 */
  recentSpecs() {
    const data = this._prune(this._load());
    const out = [];
    for (const date of Object.keys(data).sort()) {
      for (const spec of data[date]) out.push(`${spec}（${date} 推荐）`);
    }
    return out;
  }
}

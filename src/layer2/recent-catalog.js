/**
 * Claudiao · 最近播放目录（前 100 首）
 *
 * 反映听众「阶段性」的真实听歌口味：以播放记录表为源，启动时生成一次，
 * 服务长跑时每天首次访问自动重算（跨天刷新，白天固定不抖动）。
 * 输出为紧凑文本目录（旧→新 + 跳过标注 + 高频艺人聚合），由 context.js
 * 作为 RECENT_ROTATION 语料片段注入大脑提示。
 */
export class RecentCatalog {
  /** @param {object} opts { state(StateStore), log?, limit?(默认 100) } */
  constructor({ state, log, limit = 100 } = {}) {
    this.state = state;
    this.log = log || console;
    this.limit = limit;
    this._text = '';
    this._date = '';
  }

  _today() {
    const d = new Date();
    return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
  }

  /** 从播放记录表重建目录文本 */
  refresh() {
    try {
      const rows = this.state?.recentPlays?.(this.limit) || [];
      if (!rows.length) {
        this._text = '';
        this._date = this._today();
        this.log.info?.('最近播放目录：暂无播放记录');
        return this._text;
      }
      const artistCount = new Map();
      const lines = rows.map((p) => {
        const a = p.artist || '未知艺人';
        artistCount.set(a, (artistCount.get(a) || 0) + 1);
        return `- ${a} - ${p.title}${p.skipped ? '（跳过）' : ''}`;
      });
      const top = [...artistCount.entries()]
        .filter(([, n]) => n >= 2)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([a, n]) => `${a}×${n}`)
        .join('、');
      this._text = [
        `（旧→新，共 ${rows.length} 首）`,
        ...lines,
        top ? `【其中高频艺人】${top}` : '',
      ].filter(Boolean).join('\n');
      this._date = this._today();
      this.log.info?.(`最近播放目录已更新（${rows.length} 首）`);
      return this._text;
    } catch (e) {
      this.log.warn?.('最近播放目录更新失败', { error: e.message });
      this._text = '';
      this._date = this._today();
      return this._text;
    }
  }

  /** 取当前目录文本；跨天时自动重算一次（白天固定不抖动） */
  get() {
    if (this._date !== this._today()) this.refresh();
    return this._text || null;
  }
}

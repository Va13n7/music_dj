/**
 * Claudiao · 音乐提供方 · gdstudio 公共实例适配器
 *
 * docs/06-music-provider.md §2 的 MusicProvider 契约实现（直链来源）。
 * 实测结论（2026-10，见 config/.env 与 docs/06 §1.2）：
 *   - 只有 netease 源能出可播放直链；joox 仅元数据/歌词可用；
 *   - 实例对突发请求会 503，必须串行 + MUSIC_MIN_INTERVAL_MS 节流 + 退避重试。
 */
const BASE = 'https://music-api.gdstudio.xyz/api.php';

export class GdstudioProvider {
  /**
   * @param {object} opts
   * @param {object} opts.env        合并后的环境变量
   * @param {(level: string, msg: string, extra?: object) => void} [opts.log]
   */
  constructor({ env, log } = {}) {
    this.env = env || {};
    this.log = log || (() => {});
    this.name = 'gdstudio';
    this.sources = (env.MUSIC_SOURCES || 'netease,joox').split(',').map((s) => s.trim()).filter(Boolean);
    this.baseUrl = env.MUSIC_BASE_URL || BASE;
    this.minIntervalMs = Number(env.MUSIC_MIN_INTERVAL_MS || 1200);
    this.retryMax = Number(env.MUSIC_RETRY_MAX || 4);
    this.retryBackoffMs = Number(env.MUSIC_RETRY_BACKOFF_MS || 1200);
    this.bitrate = env.MUSIC_BITRATE || '320';
    this._lastReq = 0;
  }

  async available() {
    const started = Date.now();
    try {
      const tracks = await this.search('周杰伦 晴天', { limit: 1, source: 'netease' });
      return { ok: Array.isArray(tracks) && tracks.length > 0, latencyMs: Date.now() - started, sources: this.sources };
    } catch (e) {
      this.log('warn', 'gdstudio available 探测失败', { error: e.message });
      return { ok: false, latencyMs: Date.now() - started, sources: this.sources };
    }
  }

  /** 串行节流 + 指数退避重试（docs/06 §4.1.1） */
  async api(params, { retries } = {}) {
    const max = retries ?? this.retryMax;
    let lastErr;
    for (let a = 1; a <= max; a++) {
      const wait = this._lastReq + this.minIntervalMs - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this._lastReq = Date.now();
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 15000);
      try {
        const url = `${this.baseUrl}?${new URLSearchParams(params)}`;
        const res = await fetch(url, { signal: ctl.signal });
        const text = await res.text();
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        if (!text.trim()) throw new Error('空响应');
        return JSON.parse(text);
      } catch (e) {
        lastErr = e;
        if (a < max) {
          await new Promise((r) => setTimeout(r, this.retryBackoffMs * 2 ** (a - 1) + Math.random() * 400));
          continue;
        }
        throw e;
      } finally {
        clearTimeout(t);
      }
    }
    throw lastErr;
  }

  /** @returns {Promise<Array<{source,id,url_id,name,artist[],album,pic_id,lyric_id}>>} */
  async search(query, { limit = 10, source } = {}) {
    const out = [];
    for (const s of source ? [source] : this.sources) {
      const rows = await this.api({ types: 'search', source: s, name: query, count: String(limit), pages: '1' });
      if (Array.isArray(rows)) {
        for (const r of rows) {
          out.push({
            provider: this.name,
            source: s,
            id: String(r.id ?? ''),
            urlId: String(r.url_id ?? r.id ?? ''),
            name: r.name || '',
            artist: Array.isArray(r.artist) ? r.artist.map(String) : [],
            album: r.album || '',
            picId: r.pic_id ? String(r.pic_id) : '',
            lyricId: r.lyric_id ? String(r.lyric_id) : '',
            durationMs: r.duration != null ? Number(r.duration) * 1000 : null,
          });
        }
      }
      if (out.length) break;                                           // 第一个有结果的源即可
    }
    return out;
  }

  /** 播放直链（本适配器的核心价值：netease 源可出直链） */
  async resolve(trackRef, { br } = {}) {
    const source = trackRef.source || 'netease';
    const id = trackRef.urlId || trackRef.id;
    const data = await this.api({ types: 'url', source, id, br: br || this.bitrate });
    if (!data?.url) {
      const e = new Error('无直链（版权受限或该源不提供）');
      e.code = 'E_NO_URL';
      throw e;
    }
    const now = Date.now();
    return {
      url: data.url,
      br: Number(data.br) || 0,
      size: Number(data.size) || 0,
      from: `${this.name}:${source}`,
      resolvedAt: now,
      // docs/06 §6：直链带时效，保守取 10 分钟（MUSIC_URL_TTL_SEC）
      expiresAt: now + Number(this.env.MUSIC_URL_TTL_SEC || 600) * 1000,
    };
  }

  async lyric(id) {
    const data = await this.api({ types: 'lyric', source: 'netease', id });
    return { lrc: data?.lyric || '', translated: data?.tlyric || '' };
  }

  async cover(picId, size = 300) {
    const data = await this.api({ types: 'pic', source: 'netease', id: picId, size: String(size) });
    return { url: data?.url || null };
  }

  async playlist(id, { maxPages = 5 } = {}) {
    // gdstudio 的 playlist 返回网易云原始结构：{ code, playlist: { name, trackCount, tracks: [...] } }
    // tracks[].ar=艺人数组 / al=专辑 / pop=热度0-100 / fee=0免费1VIP / dt=时长毫秒
    const all = [];
    let name = `playlist-${id}`;
    for (let page = 1; page <= maxPages; page++) {
      const j = await this.api({ types: 'playlist', source: 'netease', id, pages: String(page) }, { retries: 5 });
      const pl = j?.playlist;
      if (!pl) break;
      name = pl.name || name;
      const tracks = pl.tracks || [];
      if (!tracks.length) break;
      for (const t of tracks) {
        if (!all.some((x) => x.id === t.id)) {
          all.push({
            provider: this.name,
            source: 'netease',
            id: String(t.id ?? ''),
            urlId: String(t.id ?? ''),
            name: t.name || '',
            artist: (t.ar || []).map((a) => a.name).filter(Boolean),
            album: t.al?.name || '',
            picId: t.al?.pic ? String(t.al.pic) : (t.al?.pic_str ? String(t.al.pic_str) : ''),
            lyricId: String(t.id ?? ''),
            durationMs: t.dt ?? null,
            pop: Number(t.pop) || 0,
            fee: Number(t.fee) || 0,
          });
        }
      }
      if (all.length >= (pl.trackCount || all.length)) break;
    }
    return { id: String(id), name, tracks: all, trackCount: all.length };
  }
}

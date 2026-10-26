/**
 * Claudiao · 音乐提供方 · 组合门面
 *
 * 音源优先级（2026-10 定稿）：
 *   1. netease-cookie   扫码登录的网易云账号（标准音质全目录可用，VIP 权益跟随账号）
 *   2. gdstudio         公共实例（320k 直链，无需登录，主力音质源）
 *   3. netease-openapi  开放平台（账户解封后备用）
 *   4. fallback-audio   本地兜底
 *
 * resolve 链路：cookie 搜索（元数据/playFlag/封面最全）→ 打分 → gdstudio 取 320k
 * → 全失败 → cookie songUrl standard 兜底 → gdstudio 自搜索兜底 → 抛错。
 */
import { GdstudioProvider } from './gdstudio.js';
import { NeteaseOpenApiProvider } from './netease-openapi.js';
import { NeteaseCookieProvider } from './netease-cookie.js';

// 与 tools/music-resolve.js / docs/06 一致的噪声黑名单
export const NOISE = /翻唱|cover|伴奏|instrumental|remix|dj版|live|现场|纯音乐|钢琴版|八音盒|深情版|女声版|男声版|抖音|铃声|片段|加速|慢速|高音质|无损/i;

/** docs/06 M-03：候选打分（滤掉翻唱/伴奏/remix） */
export function scoreCandidate(cand, wantArtist, wantTitle) {
  const name = cand.name || '';
  const artists = (cand.artist || []).join('/');
  const parts = [];
  let s = 0;
  if (wantTitle && name === wantTitle) { s += 20; parts.push('曲名精确 +20'); }
  else if (wantTitle && (name.includes(wantTitle) || wantTitle.includes(name))) { s += 12; parts.push('曲名包含 +12'); }
  if (wantArtist && artists.includes(wantArtist)) { s += 40; parts.push('艺人命中 +40'); }
  if (NOISE.test(name)) { s -= 60; parts.push('曲名噪声 -60'); }
  if (NOISE.test(artists)) { s -= 20; parts.push('艺人噪声 -20'); }
  // 开放平台的可播性是硬信息：明确不可播的降权（最终由直链源裁决）
  if (cand.provider === 'netease-openapi' && cand.playFlag === false) { s -= 15; parts.push('官方标记不可播 -15'); }
  return { s, parts };
}

export class MusicProviderFacade {
  /** @param {object} opts { env, log, root } */
  constructor(opts = {}) {
    this.env = opts.env || {};
    this.root = opts.root || process.cwd();
    this.log = opts.log || (() => {});
    this.name = 'combined';
    this.cookieSrc = new NeteaseCookieProvider({ root: this.root, log: this.log });
    this.official = new NeteaseOpenApiProvider({ env: this.env, log: this.log });
    this.gdstudio = new GdstudioProvider({ env: this.env, log: this.log });
    this.sources = ['netease', 'joox'];
  }

  async available() {
    const [cookie, official, gdstudio] = await Promise.all([
      Promise.resolve({ ok: this.cookieSrc.loggedIn, loggedIn: this.cookieSrc.loggedIn, needsLogin: this.cookieSrc.needsLogin }),
      this.official.availableProbe().catch((e) => ({ ok: false, error: e.message })),
      this.gdstudio.available().catch((e) => ({ ok: false, error: e.message })),
    ]);
    return {
      ok: gdstudio.ok,
      cookie, official, gdstudio,
      latencyMs: Math.max(official.latencyMs || 0, gdstudio.latencyMs || 0),
      sources: this.sources,
    };
  }

  /** 拆「艺人 - 曲名」 */
  _parseRef(ref) {
    const m = String(ref || '').match(/^(?<artist>.+?)\s-\s(?<title>.+)$/);
    const artist = m?.groups?.artist?.trim() || '';
    const title = m?.groups?.title?.trim() || String(ref || '').trim();
    return { artist, title, query: artist ? `${artist} ${title}` : title };
  }

  /**
   * 搜索：登录 cookie 源优先（元数据/权益跟随账号），失败降级 gdstudio。
   */
  async search(query, { limit = 10, source } = {}) {
    const errors = [];
    if (this.cookieSrc.loggedIn) {
      try {
        const tracks = await this.cookieSrc.search(query, { limit });
        if (tracks.length) return tracks;
      } catch (e) {
        errors.push(`cookie: ${e.message}`);
        this.log.warn('netease-cookie search 降级', { error: e.message });
      }
    }
    try {
      const tracks = await this.gdstudio.search(query, { limit, source });
      if (tracks.length) return tracks;
      errors.push('gdstudio: 无结果');
    } catch (e) {
      errors.push(`gdstudio: ${e.message}`);
    }
    const e = new Error(`全部搜索源失败：${errors.join('；')}`);
    e.code = 'E_SEARCH_ALL';
    throw e;
  }

  /**
   * 端到端解析：「艺人 - 曲名」→ 直链。
   * 链路：cookie 搜索（元数据/权益）→ 打分 → gdstudio 320k → cookie standard 兜底
   * → gdstudio 自搜索兜底 → 抛错。
   * @returns {Promise<{url,br,size,from,resolvedAt,expiresAt,track,score}>}
   */
  async resolve(ref, { br, showCandidates = false } = {}) {
    const { artist, title, query } = this._parseRef(ref);
    const errors = [];

    // 1) cookie 搜索拿候选（playFlag/封面元数据最全）
    let candidates = [];
    if (this.cookieSrc.loggedIn) {
      try {
        candidates = await this.cookieSrc.search(query, { limit: 10 });
      } catch (e) {
        errors.push(`cookie search: ${e.message}`);
      }
    }

    // 2) 打分排序
    const scored = candidates
      .map((c) => ({ c, ...scoreCandidate(c, artist, title) }))
      .sort((a, b) => b.s - a.s);

    if (showCandidates) {
      scored.forEach(({ c, s, parts }, i) => {
        this.log('info', `候选${i + 1}`, { score: s, name: c.name, artist: c.artist.join('/'), playFlag: c.playFlag, parts });
      });
    }

    // 3) 逐候选：gdstudio 320k 优先（音质），cookie standard 兜底（账号权益）
    for (const { c, s } of scored) {
      try {
        const audio = await this.gdstudio.resolve(
          { source: 'netease', urlId: c.urlId || c.originalId || c.id, id: c.originalId || c.id },
          { br },
        );
        return { ...audio, track: c, score: s };
      } catch (e) {
        errors.push(`gdstudio「${c.name}」: ${e.message}`);
      }
      if (this.cookieSrc.loggedIn) {
        try {
          const u = await this.cookieSrc.songUrl(c.encryptedId || c.id, { level: 'standard' });
          if (u.url) {
            return {
              url: u.url, br: 128, size: u.size ?? null,
              from: 'netease-cookie', resolvedAt: Date.now(),
              expiresAt: Date.now() + 20 * 60000,
              track: c, score: s,
            };
          }
        } catch (e) {
          errors.push(`cookie songUrl「${c.name}」: ${e.message}`);
        }
      }
    }

    // 4) cookie 候选全无直链 → gdstudio 自己的搜索+直链（旧行为，含打分）
    try {
      const tracks = await this.gdstudio.search(query, { limit: 10 });
      const gScored = tracks
        .map((c) => ({ c, ...scoreCandidate(c, artist, title) }))
        .sort((a, b) => b.s - a.s);
      for (const { c, s } of gScored) {
        if (s <= 0 && gScored[0].s > 0) continue;
        try {
          const audio = await this.gdstudio.resolve(c, { br });
          return { ...audio, track: c, score: s };
        } catch (e) {
          errors.push(`gdstudio resolve「${c.name}」: ${e.message}`);
        }
      }
    } catch (e) {
      errors.push(`gdstudio search: ${e.message}`);
    }

    const err = new Error(`解析失败「${ref}」：${errors.slice(0, 3).join('；')}`);
    err.code = 'E_RESOLVE_ALL';
    throw err;
  }

  /**
   * 歌词：登录 cookie 源优先（lyric_new 带翻译），失败降级 gdstudio。
   */
  async lyric(track) {
    if (this.cookieSrc.loggedIn && (track?.encryptedId || track?.lyricId || track?.id)) {
      try {
        const r = await this.cookieSrc.lyric(track.encryptedId || track.lyricId || track.id);
        if (r.lrc) return r;
      } catch (e) {
        this.log.warn('官方歌词降级', { error: e.message });
      }
    }
    return this.gdstudio.lyric(track?.lyricId || track?.id);
  }

  /** 封面：搜索结果自带 coverUrl；否则 gdstudio pic */
  async cover(track, size = 300) {
    if (track?.coverUrl) return { url: track.coverUrl };
    if (track?.picId) return this.gdstudio.cover(track.picId, size);
    return { url: null };
  }

  /** 歌单曲目（兜底曲目池） */
  async playlist(id) {
    return this.gdstudio.playlist(id);
  }

  /** 每日推荐（登录 cookie 源；官方个性化，漫游歌源用） */
  async dailyRecommend(limit = 30) {
    if (this.cookieSrc.loggedIn) {
      try {
        return await this.cookieSrc.dailyRecommend(limit);
      } catch (e) {
        this.log.warn('每日推荐不可用', { error: e.message });
      }
    }
    return null;
  }
}

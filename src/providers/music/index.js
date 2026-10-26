/**
 * Claudiao · 音乐提供方 · 组合门面
 *
 * docs/06-music-provider.md §2 MusicProvider 契约的组合实现（2026-10 定稿的分工）：
 *
 *   网易云开放平台（个人版）  → 搜索 / 元数据 / 可播性(playFlag) / 封面 / 歌词 / 推荐
 *   gdstudio 公共实例        → 播放直链（唯一可用直链源，netease 源）
 *
 * 原则（docs/06 §1.1 合规边界）：只流式播放、不落地、直链每次重新解析；
 * 开放平台拿不到直链（个人应用白名单无 playurl），直链层完全由 gdstudio 承担。
 *
 * 降级链：
 *   search  : netease-openapi（用户令牌） → gdstudio(netease) → gdstudio(joox)
 *   resolve : gdstudio(netease) → gdstudio(joox，已知不出直链，保留容错)
 *   lyric   : netease-openapi → gdstudio
 *   playlist: gdstudio（netease 源）
 */
import { GdstudioProvider } from './gdstudio.js';
import { NeteaseOpenApiProvider } from './netease-openapi.js';

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
  /** @param {object} opts { env, log } */
  constructor(opts = {}) {
    this.env = opts.env || {};
    this.log = opts.log || (() => {});
    this.name = 'combined';
    this.official = new NeteaseOpenApiProvider({ env: this.env, log: this.log });
    this.gdstudio = new GdstudioProvider({ env: this.env, log: this.log });
    this.sources = ['netease', 'joox'];
  }

  async available() {
    const [official, gdstudio] = await Promise.all([
      this.official.availableProbe().catch((e) => ({ ok: false, error: e.message })),
      this.gdstudio.available().catch((e) => ({ ok: false, error: e.message })),
    ]);
    return {
      ok: gdstudio.ok,                       // 直链源是硬依赖
      official, gdstudio,
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
   * 搜索：官方优先（playFlag/封面/标签），失败降级 gdstudio。
   * 返回统一 Track 形态（docs/06 §2），带 provider 标记。
   */
  async search(query, { limit = 10, source } = {}) {
    const errors = [];
    // 1) 官方
    if (this.official.available()) {
      try {
        const tracks = await this.official.search(query, { limit });
        if (tracks.length) return tracks;
      } catch (e) {
        errors.push(`official: ${e.message}`);
        this.log('warn', 'netease-openapi search 降级', { error: e.message });
      }
    }
    // 2) gdstudio
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
   * 搜索官方优先（拿到可播性），直链一律 gdstudio。
   * @returns {Promise<{url,br,size,from,resolvedAt,expiresAt,track,score}>}
   */
  async resolve(ref, { br, showCandidates = false } = {}) {
    const { artist, title, query } = this._parseRef(ref);
    const errors = [];

    // 1) 官方搜索拿候选（含 playFlag）
    let candidates = [];
    try {
      candidates = await this.official.search(query, { limit: 10 });
    } catch (e) {
      errors.push(`official search: ${e.message}`);
    }

    // 2) 官方候选按打分排序，逐个到 gdstudio 拿直链
    const scored = candidates
      .map((c) => ({ c, ...scoreCandidate(c, artist, title) }))
      .sort((a, b) => b.s - a.s);

    if (showCandidates) {
      scored.forEach(({ c, s, parts }, i) => {
        this.log('info', `候选${i + 1}`, { score: s, name: c.name, artist: c.artist.join('/'), playFlag: c.playFlag, parts });
      });
    }

    for (const { c, s } of scored) {
      try {
        const audio = await this.gdstudio.resolve(
          { source: 'netease', urlId: c.urlId || c.originalId || c.id, id: c.originalId || c.id },
          { br },
        );
        return { ...audio, track: c, score: s };
      } catch (e) {
        errors.push(`gdstudio resolve「${c.name}」: ${e.message}`);
      }
    }

    // 3) 官方不可用/全军覆没 → 走 gdstudio 自己的搜索+直链（旧行为，含打分）
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

  /** 歌词：官方优先 */
  async lyric(track) {
    if (track?.encryptedId) {
      try {
        const r = await this.official.lyric(track.encryptedId);
        if (r.lrc) return r;
      } catch (e) {
        this.log('warn', '官方歌词降级', { error: e.message });
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

  /** 推荐（官方独占能力；电台主动播报的选曲源） */
  async recommend({ kind = 'daily' } = {}) {
    try {
      if (kind === 'fm') return await this.official.personalFm();
      return await this.official.dailyRecommend();
    } catch (e) {
      this.log('warn', '官方推荐不可用', { error: e.message, kind });
      return null;                                                  // docs/06 §2：未实现/不可用返回 null
    }
  }
}

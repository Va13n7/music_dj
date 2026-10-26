/**
 * Claudiao · 音乐音源 · 网易云 Cookie 源（Mineradio 同款机制）
 *
 * 原理：扫码登录自己的网易云账号拿 cookie → 所有请求带 cookie →
 *       song_url_v1 出直链（音质与可听曲目跟随账号权益）。
 * 与开放平台（netease-openapi.js）完全独立——后者走 open 网关 + AppSecret，
 * 本源走 music.163.com + 用户登录态；账号被封开放平台也不影响这条。
 *
 * 依赖：npm 包 NeteaseCloudMusicApi（惰性加载，未安装时本源自动停用）。
 * 登录态：data/runtime/netease-cookie.json（0600）；过期后 needsLogin=true，
 *         前端展示二维码重新扫码即可。
 */
import fs from 'node:fs';
import path from 'node:path';

export class NeteaseCookieProvider {
  /** @param {object} opts { root, log } */
  constructor({ root, log } = {}) {
    this.root = root || process.cwd();
    this.log = log || console;
    this.name = 'netease-cookie';
    this.cookieFile = path.join(this.root, 'data', 'runtime', 'netease-cookie.json');
    this.cookie = null;
    this.needsLogin = true;
    this._ncm = null;
    this._unikey = null;
    this._loadCookie();
  }

  /** 惰性加载 NeteaseCloudMusicApi（CJS 包，未安装返回 null） */
  async _sdk() {
    if (this._ncm) return this._ncm;
    try {
      this._ncm = (await import('NeteaseCloudMusicApi')).default;
      return this._ncm;
    } catch (e) {
      this.log.debug?.('NeteaseCloudMusicApi 未安装', { error: e.message });
      return null;
    }
  }

  get loggedIn() { return Boolean(this.cookie) && !this.needsLogin; }
  get installed() { return this._ncm !== null; }

  _loadCookie() {
    try {
      const j = JSON.parse(fs.readFileSync(this.cookieFile, 'utf8'));
      if (j.cookie) { this.cookie = j.cookie; this.needsLogin = false; }
    } catch { this.cookie = null; }
  }

  saveCookie(cookie) {
    this.cookie = cookie;
    this.needsLogin = false;
    fs.mkdirSync(path.dirname(this.cookieFile), { recursive: true });
    fs.writeFileSync(this.cookieFile, JSON.stringify({ cookie, createdAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
    this.log.info?.('网易云 cookie 已保存', { chars: cookie.length });
  }

  clearCookie() {
    this.cookie = null;
    this.needsLogin = true;
    try { fs.rmSync(this.cookieFile, { force: true }); } catch { /* ignore */ }
  }

  /** 统一带登录态的 API 调用；检测到登录失效自动置 needsLogin */
  async _call(fnName, params = {}) {
    const sdk = await this._sdk();
    if (!sdk || typeof sdk[fnName] !== 'function') {
      throw Object.assign(new Error(`NCM 接口不存在: ${fnName}`), { code: 'E_NCM' });
    }
    const r = await sdk[fnName]({ ...params, cookie: this.cookie || undefined, timestamp: Date.now() });
    const body = r?.body || {};
    if (body.code === 301 || body.msg === '需要登录') {
      this.needsLogin = true;
      throw Object.assign(new Error('网易云登录已失效，请重新扫码'), { code: 'E_COOKIE_EXPIRED' });
    }
    return body;
  }

  // ---------- 登录 ----------

  /** 生成登录二维码（返回 base64 图片与 unikey，前端展示 + 轮询） */
  async loginQrCreate() {
    const sdk = await this._sdk();
    if (!sdk) throw Object.assign(new Error('NeteaseCloudMusicApi 未安装'), { code: 'E_NCM' });
    const k = await sdk.login_qr_key({ timestamp: Date.now() });
    this._unikey = k.body.data.unikey;
    const c = await sdk.login_qr_create({ key: this._unikey, qrimg: true, timestamp: Date.now() });
    return { unikey: this._unikey, qrimg: c.body.data.qrimg };
  }

  /** 检查扫码状态：801 待扫码 / 802 已扫未确认 / 803 成功（cookie 已持久化） */
  async loginQrCheck() {
    if (!this._unikey) throw Object.assign(new Error('请先调用 loginQrCreate'), { code: 'E_NO_KEY' });
    const sdk = await this._sdk();
    const r = await sdk.login_qr_check({ key: this._unikey, timestamp: Date.now() });
    const code = r.body.code;
    if (code === 803 && r.body.cookie) {
      this.saveCookie(r.body.cookie);
      this._unikey = null;
      return { code: 803, loggedIn: true, profile: r.body.data?.profile ? { nickname: r.body.data.profile.nickname } : null };
    }
    return { code };
  }

  logout() {
    this.cookie = null;
    this._unikey = null;
    this.clearCookie();
    this.log.info?.('网易云已退出登录');
  }

  // ---------- 音乐能力 ----------

  /** 搜索（cloudsearch：条目含 al.picUrl 封面；fee=1 为 VIP 曲） */
  async search(keywords, { limit = 10 } = {}) {
    const body = await this._call('cloudsearch', { keywords, limit, type: 1 });
    const songs = body?.result?.songs || [];
    return songs.map((s) => ({
      id: String(s.id ?? ''),
      encryptedId: String(s.id ?? ''),
      lyricId: String(s.id ?? ''),
      source: 'netease-cookie',
      name: s.name || '',
      artist: (s.artists || s.ar || []).map((a) => a.name || a).filter(Boolean),
      album: s.album?.name || '',
      coverUrl: s.album?.picUrl || s.al?.picUrl || null,
      fee: s.fee,
      durationMs: s.duration ?? null,
    }));
  }

  /**
   * 取播放直链（核心能力）。level=exhigher(320k)/lossless(无损，需账号权益)，
   * 拿不到自动降级；freeTrialInfo 非空 = 只能试听。
   */
  async songUrl(id, { level = 'exhigher' } = {}) {
    const body = await this._call('song_url_v1', { id, level });
    const d = (body?.data || []).find((x) => x.id === Number(id) || x.url) || body?.data?.[0];
    if (!d?.url) {
      throw Object.assign(new Error('无直链（版权受限或需试听）'), { code: 'E_NO_URL', freeTrial: d?.freeTrailInfo || null });
    }
    return {
      url: d.url,
      level: d.level || level,
      type: d.type || 'mp3',
      size: d.size ?? null,
      md5: d.md5 || null,
      freeTrial: d.freeTrailInfo ? { start: d.freeTrailInfo.start, end: d.freeTrailInfo.end } : null,
    };
  }

  /** 歌词（lyric_new：逐行/翻译/纯文本） */
  async lyric(id) {
    try {
      const body = await this._call('lyric_new', { id });
      return { lrc: body?.lrc?.lyric || '', translated: body?.tlyric?.lyric || '' };
    } catch {
      const r = await this._call('lyric', { id });
      return { lrc: r?.lrc?.lyric || '', translated: r?.tlyric?.lyric || '' };
    }
  }

  /** 我的歌单全量（个人品味数据源，自动导入用） */
  async myPlaylists(uid) {
    const body = await this._call('user_playlist', { uid, limit: 1000 });
    return (body?.playlist || []).map((p) => ({
      id: String(p.id),
      name: p.name || '',
      trackCount: p.trackCount ?? 0,
      specialType: p.specialType,                     // 5 = 「我喜欢的音乐」默认歌单
      subscribed: p.subscribed,
    }));
  }

  /** 歌单全部曲目（配合 myPlaylists 做全量导入） */
  async playlistTracks(pid) {
    const body = await this._call('playlist_track_all', { id: pid, limit: 1000 });
    return (body?.songs || []).map((s) => ({
      title: s.name || '',
      artist: (s.ar || []).map((a) => a.name).join('/'),
      album: s.al?.name || '',
      durationMs: s.dt ?? null,
      fee: s.fee,
      id: String(s.id ?? ''),
    }));
  }

  /** 每日推荐（官方个性化，漫游歌源升级用；需登录） */
  async dailyRecommend(limit = 30) {
    const body = await this._call('recommend_songs', { limit });
    const list = body?.data?.dailySongs || [];
    return list.map((s) => ({
      title: s.name || '',
      artist: (s.ar || []).map((a) => a.name).join('/'),
      id: String(s.id ?? ''),
      fee: s.fee,
    }));
  }
}

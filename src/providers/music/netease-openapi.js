/**
 * Claudiao · 音乐提供方 · 网易云开放平台（个人 CLI 应用）适配器
 *
 * 官方 API，承担「搜索 + 元数据 + 可播性 + 推荐」；**不提供播放直链**（个人应用
 * 白名单无 playurl 接口，直链由 gdstudio 适配器负责）。
 *
 * 协议要点（2026-10-15 全部实测验证，勿凭直觉改）：
 *   - 网关 https://openncm.music.163.com/openapi/music/basic/<路径>（文档写 openapi 域名，同样活着）
 *   - 公共参数：bizContent(业务参数JSON串) / appId / signType=RSA_SHA256 / device(JSON串)
 *     / timestamp(毫秒) / accessToken / sign
 *   - sign = base64(RSA-SHA256(私钥, 除 sign/空值外按键排序的 "k=v&" 串))
 *   - device（个人 CLI 应用专用枚举，抄自官方 ncm-cli）：os/channel/brand = "ncmcli"
 *   - accessToken：用户级来自 ncm-cli 扫码登录（登录态过期需重新扫码），
 *     匿名级来自 oauth2/login/anonymous（24h，但业务接口会报「应用/用户未授权」）
 *   - 错误码：300 应用未授权接口 / 301 用户未授权接口 / 404 接口未找到 / 1402 非法sign
 *
 * 用户 token 的来源（按优先级）：
 *   1. env MUSIC_NETEASE_USER_TOKEN（显式指定）
 *   2. ncm-cli 的运行日志 ~/.config/ncm-cli/app.log（ncm-cli login 后自动出现）
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const PLAY_FLAG_OK = (t) => t.playFlag === true;

export class NeteaseOpenApiProvider {
  /**
   * @param {object} opts
   * @param {object} opts.env
   * @param {(level: string, msg: string, extra?: object) => void} [opts.log]
   */
  constructor({ env, log } = {}) {
    this.env = env || {};
    this.log = log || (() => {});
    this.name = 'netease-openapi';
    this.sources = ['netease'];
    this.appId = env.MUSIC_NETEASE_APP_ID || '';
    this.privateKey = env.MUSIC_NETEASE_PRIVATE_KEY || '';
    this.baseUrl = env.MUSIC_NETEASE_BASE_URL || 'https://openncm.music.163.com';
    this.appVer = env.MUSIC_NETEASE_APP_VER || '0.1.7';
    // deviceId 必须与用户 token 的登录设备一致（否则 1406 当前设备未授权）。
    // ncm-cli 登录后其固定 deviceId 会出现在运行日志的请求串里，从这里解析。
    this.deviceId = env.MUSIC_NETEASE_DEVICE_ID || this._resolveDeviceId()
      || ('ncmcli_' + crypto.createHash('sha1').update(this.appId + os.hostname()).digest('hex').slice(0, 25));
    this._privPem = null;
    this._anonToken = null;          // { token, expiresAt }
    this._ip = null;
  }

  available() {
    return Boolean(this.appId && this.privateKey);
  }

  _pem() {
    if (!this._privPem) {
      this._privPem = ['-----BEGIN PRIVATE KEY-----',
        this.privateKey.replace(/(.{64})/g, '$1\n').trim(),
        '-----END PRIVATE KEY-----'].join('\n');
    }
    return this._privPem;
  }

  _device(ip) {
    return JSON.stringify({
      deviceType: 'openapi', os: 'ncmcli', appVer: this.appVer, channel: 'ncmcli',
      model: 'Windows_x64_cli', brand: 'ncmcli', osVer: os.release(),
      clientIp: ip || '127.0.0.1', deviceId: this.deviceId,
    });
  }

  async _clientIp() {
    if (this._ip) return this._ip;
    try {
      const r = await (await fetch('https://api.ipify.org?format=json')).json();
      this._ip = r.ip || '127.0.0.1';
    } catch { this._ip = '127.0.0.1'; }
    return this._ip;
  }

  _sign(params) {
    const content = Object.keys(params)
      .filter((k) => k !== 'sign' && params[k] !== '')
      .sort()
      .map((k) => `${k}=${String(params[k])}`)
      .join('&');
    return crypto.createSign('RSA-SHA256').update(content).sign(this._pem(), 'base64');
  }

  /**
   * 从 ncm-cli 运行日志解析它使用的 deviceId（token 与设备绑定，必须一致）。
   */
  _resolveDeviceId() {
    try {
      const logPath = path.join(os.homedir(), '.config', 'ncm-cli', 'app.log');
      const ms = fs.readFileSync(logPath, 'utf8').match(/ncmcli_[a-f0-9]{25}/g) || [];
      if (ms.length) return ms[ms.length - 1];
    } catch { /* ignore */ }
    return null;
  }

  /**
   * 用户 token 候选（新→旧）：env 显式值 → ncm-cli 运行日志里的 accessToken= 记录。
   * 日志里匿名 token 与用户 token 混在一起，无法从格式区分，由 _pickUserToken 试探。
   */
  _userTokenCandidates() {
    if (this.env.MUSIC_NETEASE_USER_TOKEN) return [this.env.MUSIC_NETEASE_USER_TOKEN];
    const out = [];
    try {
      const logPath = path.join(os.homedir(), '.config', 'ncm-cli', 'app.log');
      const ms = fs.readFileSync(logPath, 'utf8').match(/accessToken=([a-zA-Z0-9]{40,64})/g) || [];
      for (const m of ms.reverse()) {
        const t = m.slice('accessToken='.length);
        if (!out.includes(t)) out.push(t);
        if (out.length >= 5) break;                                     // 只试最近 5 个
      }
    } catch { /* 日志不存在 → 未用 ncm-cli 登录过 */ }
    return out;
  }

  /**
   * 挑出可用的用户 token：逐一用一次真实搜索试探（301/300=无效，200=命中并缓存）。
   * 结果缓存在进程内；试探失败抛 E_NO_USER_TOKEN。
   */
  async _pickUserToken() {
    if (this._goodUserToken) return this._goodUserToken;
    for (const token of this._userTokenCandidates()) {
      const r = await this._call('/search/song/get/v3', { keyword: '测试', limit: 1, offset: 0 }, token);
      if (r?.code === 200) {
        this._goodUserToken = token;
        this.log('info', 'netease-openapi 用户令牌已选定');
        return token;
      }
    }
    const e = new Error('无有效用户令牌：先运行 ncm-cli login 扫码登录（或设置 MUSIC_NETEASE_USER_TOKEN）');
    e.code = 'E_NO_USER_TOKEN';
    throw e;
  }

  /** 匿名 token（24h，缓存；业务接口大多不可用，仅作登录态占位） */
  async _anonymousToken() {
    if (this._anonToken && Date.now() < this._anonToken.expiresAt) return this._anonToken.token;
    const r = await this._call('/oauth2/login/anonymous', { clientId: this.appId }, null);
    if (r?.code === 200 && r.data?.accessToken) {
      this._anonToken = {
        token: r.data.accessToken,
        expiresAt: Date.now() + (Number(r.data.expireTime) || 86400) * 1000 - 60_000,
      };
      return this._anonToken.token;
    }
    throw new Error(`匿名登录失败: ${JSON.stringify(r).slice(0, 200)}`);
  }

  /**
   * 调用业务接口。userToken=true 时用用户令牌（搜索/推荐等需要），
   * 拿不到用户令牌时抛 E_NO_USER_TOKEN（上层降级到 gdstudio）。
   */
  async call(apiPath, bizContent, { userToken = true, token: explicitToken } = {}) {
    if (!this.available()) throw new Error('netease-openapi 未配置 appId/privateKey');
    const ip = await this._clientIp();
    let token = null;
    if (userToken) {
      token = explicitToken ?? (await this._pickUserToken());
    } else {
      token = await this._anonymousToken();
    }
    const params = {
      appId: this.appId,
      signType: 'RSA_SHA256',
      timestamp: Date.now(),
      device: this._device(ip),
      bizContent: JSON.stringify(bizContent),
    };
    if (token) params.accessToken = token;
    params.sign = this._sign(params);
    const qs = Object.keys(params).map((k) => `${k}=${encodeURIComponent(params[k])}`).join('&');
    const res = await fetch(`${this.baseUrl}/openapi/music/basic${apiPath}?${qs}`, {
      headers: { 'User-Agent': 'claudiao-radio' },
    });
    return res.json();
  }

  /** 底层调用（指定 token，用于试探） */
  _call(apiPath, bizContent, token) {
    return this.call(apiPath, bizContent, { userToken: Boolean(token), token });
  }

  /** 歌曲搜索（返回 playFlag/vipFlag/封面/曲风标签） */
  async search(query, { limit = 10, offset = 0 } = {}) {
    const r = await this.call('/search/song/get/v3', { keyword: query, limit, offset });
    if (r?.code !== 200) {
      const e = new Error(`搜索失败: ${r?.message || r?.msg || 'unknown'} (code=${r?.code})`);
      e.code = r?.code === 300 || r?.code === 301 ? 'E_NOT_AUTHORIZED' : 'E_SEARCH';
      throw e;
    }
    return (r.data?.records || []).map((t) => ({
      provider: this.name,
      source: 'netease',
      id: String(t.originalId ?? ''),               // 明文数字 ID（唤起/展示用）
      encryptedId: String(t.id ?? ''),              // 32位加密 ID（开放平台接口用）
      urlId: String(t.originalId ?? ''),
      name: t.name || '',
      artist: (t.artists || []).map((a) => a.name).filter(Boolean),
      album: t.album?.name || '',
      coverUrl: t.coverImgUrl || null,
      tags: Array.isArray(t.songTag) ? t.songTag : [],
      playFlag: t.playFlag === true,
      vipFlag: t.vipPlayFlag === true || t.vipFlag === true,
      durationMs: t.duration != null ? Number(t.duration) : null,
    }));
  }

  /** 歌词（LRC + 翻译） */
  async lyric(songEncryptedId) {
    const r = await this.call('/song/lyric/get/v2', { songId: songEncryptedId });
    if (r?.code !== 200) return { lrc: '', translated: '' };
    return {
      lrc: r.data?.lyric || '',
      translated: r.data?.transLyric || '',
    };
  }

  /** 每日推荐歌曲（电台主动播报的选曲源之一） */
  async dailyRecommend(limit = 30) {
    const r = await this.call('/recommend/songlist/get/v2', { limit, qualityFlag: true, trialScene: 'cli' });
    if (r?.code !== 200) {
      this.log('warn', '每日推荐返回异常', { code: r?.code, msg: r?.message || r?.msg || (r == null ? '空响应' : '') });
      return [];
    }
    return this._normalizeRecommend(r.data);
  }

  /** 场景私人漫游（type/code 来自漫游分类接口，暂未接入分类，预留） */
  async personalFm(scene = {}) {
    const r = await this.call('/private/fm/roaming/song/list', {
      type: scene.type || '', code: scene.code || '', limit: 3,
    });
    if (r?.code !== 200) return [];
    return this._normalizeRecommend(r.data);
  }

  _normalizeRecommend(data) {
    const list = Array.isArray(data) ? data : (data?.records || data?.songs || data?.list || []);
    return list.map((t) => ({
      provider: this.name,
      source: 'netease',
      id: String(t.originalId ?? t.id ?? ''),
      encryptedId: String(t.encryptedId || t.id || ''),
      urlId: String(t.originalId ?? t.id ?? ''),
      name: t.name || '',
      artist: (t.artists || []).map((a) => a.name || a).filter(Boolean),
      album: t.album?.name || t.album || '',
      coverUrl: t.coverImgUrl || t.picUrl || null,
      tags: Array.isArray(t.songTag) ? t.songTag : [],
      playFlag: t.playFlag !== false,
      vipFlag: t.vipPlayFlag === true || t.vipFlag === true,
      durationMs: t.duration != null ? Number(t.duration) : null,
    }));
  }

  /** 探活：有用户令牌则验证搜索，否则只验证签名链路（匿名登录） */
  async availableProbe() {
    const started = Date.now();
    try {
      if (this._userTokenCandidates().length) {
        const r = await this.call('/search/song/get/v3', { keyword: '测试', limit: 1, offset: 0 });
        return { ok: r?.code === 200, latencyMs: Date.now() - started, sources: this.sources, mode: 'user' };
      }
      await this._anonymousToken();
      return { ok: true, latencyMs: Date.now() - started, sources: this.sources, mode: 'anonymous（仅协议层可用）' };
    } catch (e) {
      return { ok: false, latencyMs: Date.now() - started, sources: this.sources, error: e.message };
    }
  }
}

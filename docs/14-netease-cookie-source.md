# 网易云 Cookie 音源设计（Mineradio 方案调研与移植）

> 文档版本 v1.0 · 状态：**设计完成，待实施**
> 背景：开放平台 API key 依赖（`config/.env` 的 AppSecret/私钥）导致「只有申请过密钥的人能听」；
> 且该账户当前处于 1408 封禁状态。本设计引入**登录 Cookie 音源**后，任何人**扫码登录自己的
> 网易云账号即可听歌**（VIP 权益跟随账号），不再依赖开放平台密钥。
> 上游参考：[Mineradio](https://github.com/XxHuberrr/Mineradio-paused)（Electron 播放器，
> 依赖开源库 `NeteaseCloudMusicApi`，扫码登录 + cookie 播放，已验证其核心链路）

---

## 1. Mineradio 实现拆解（调研结论）

| 机制 | Mineradio 的做法 | 可移植性 |
|---|---|---|
| 登录 | `login_qr_key` → `login_qr_create`（二维码 base64）→ `login_qr_check` 轮询；成功后 cookie 持久化到 `./.cookie` | ✅ 直接移植（三接口匿名可调，已实测 200） |
| 取直链 | `song_url_v1({ id, level })` **带登录 cookie** → 返回 CDN 直链（用户 VIP 权益决定音质/可听曲目） | ✅ 带移植（匿名实测：搜索可用但 VIP 曲目 URL 为空——登录是硬前提，与调研预期一致） |
| API 形态 | 依赖 npm 包 `NeteaseCloudMusicApi`（380+ 导出函数，可编程调用，不必起独立服务） | ✅ 我们的电台也是 Node，直接 require |
| 多音源 | 网易云 + QQ + 酷狗 + 汽水（音频解密器）+ Spotify | ❌ 第一版不做：只移植网易云 cookie 源，其余见 §7 |
| 歌单 | `user_playlist` / `playlist_track_all`（登录态拉全量个人歌单） | ✅ 移植后**品味导入自动化**（替代手动填歌单 ID） |
| 歌词/每日推荐 | `lyric_new` / `recommend_songs` / 心动模式 `play_intelligence` | ✅ 移植，作为歌词与漫游推送源 |

**与现有开放平台通路的关系**：两套完全独立的系统。开放平台走 `open` 网关 +
AppSecret 签名（当前 1408 封禁）；本设计走 `music.163.com` + 用户 cookie
（Mineradio 同款，只要账号本身正常就可用）。

## 2. 可行性实证（2026-10-20 全部亲测）

| 验证项 | 结果 |
|---|---|
| `NeteaseCloudMusicApi` 在 Node 22 可编程调用 | ✅ 380 个函数 |
| 匿名搜索（`search`） | ✅ 200，正常返回 |
| 匿名 `song_url_v1` | ⚠️ code 200 但 `url: null`——**未登录不给直链**，证实登录是硬前提 |
| `login_qr_key` / `login_qr_create`（二维码 base64） | ✅ 200 |
| `login_qr_check`（轮询状态 801/802/803） | ✅ 200 |

## 3. 接入设计

### 3.1 新音源 provider：`src/providers/music/netease-cookie.js`

```
登录态:  data/runtime/netease-cookie.json（{ cookie, createdAt }，权限 0600）
         过期/失效（接口返回 301 需要）→ 清除并置 needsLogin 状态
调用:    所有请求带 cookie 头；封装 request 简化为对 NeteaseCloudMusicApi 函数的编程调用
能力:
  search(keyword)                 搜索（匿名也可，但统一走登录态）
  songUrl(id, level)              直链（level: standard/exhigher/lossless，按账号权益自动降级）
  lyric(id)                       歌词（lyric_new）
  myPlaylists()                   个人歌单全量（user_playlist + playlist_track_all）
  dailyRecommend()                每日推荐（recommend_songs）
  heartbeat(playlistId, songId)   心动模式（play_intelligence）
```

### 3.2 音源优先级（改 `src/providers/music/index.js` 的组合逻辑）

```
1. netease-cookie   登录有效 → 直链最优（跟随账号 VIP），歌词/每日推荐同源
2. netease-openapi  开放平台账户解封后的备用（现 1408）
3. gdstudio         现有兜底（无登录依赖，永不删除）
4. fallback-audio   本地兜底
```

### 3.3 登录流程（页面 + API）

```
GET  /api/netease/login/qr      → { qrimg(base64), unikey }   前端展示二维码
GET  /api/netease/login/check   → { code: 801|802|803, cookie? }  前端 2s 轮询
803 时服务端持久化 cookie → netease-cookie provider 状态置 ready
前端提示「登录成功，音源已切换为你的账号权益」
```

### 3.4 漫游/推送升级

- 漫游批次歌源增加「红心歌单」维度（cookie 登录后 `playlist_track_all` 拉取），
  与现有品味画像探索混合出歌
- 每日推荐（`recommend_songs`）作为漫游歌源之一——官方个性化比画像推测更准

## 4. 前端改动（web/）

- 设置页新增「网易云登录」卡片：二维码展示 + 登录状态 + 退出登录
- 播放信息显示当前音源标识（cookie / gdstudio / local）
- 漫游开关旁显示「红心歌单已接入」状态

## 5. 风险与对策

| 风险 | 对策 |
|---|---|
| 非官方接口随网易云改版失效 | cookie provider 实现统一接口，失败自动降级 gdstudio（现有降级链不动）；Upstream 开源社区（NeteaseCloudMusicApi 生态）更新频繁，可跟随升版本 |
| 账号风控（频繁取直链理论上有风险） | 电台是单人低频场景；串行节流沿用 MUSIC_MIN_INTERVAL_MS；不做批量爬取 |
| cookie 过期（约 30 天+） | 登录态接口失败 → 前端提示重新扫码；gdstudio 兜底不断供 |
| VIP 歌在无 VIP 账号下拿不到 | song_url 返回 freeTrail/空 → 自动降级 gdstudio 候选 |

## 6. 不做的事（第一版边界）

- 不做 QQ/酷狗/汽水/Spotify 多音源（Mineradio 有，但维护成本高；gdstudio 已兜底）
- 不做音频解密器（汽水专有格式才有）
- 不做自动续期 cookie 的黑科技——过期重新扫码，一人一年也就一两次

## 7. 实施清单（预计 2~3 个提交）

1. `feat(music): netease-cookie provider——QR 登录+直链+歌单+歌词`
2. `feat(web): 网易云扫码登录页与音源状态展示`
3. `feat(roaming): 漫游接入红心歌单与每日推荐`
4. 回归：现有 gdstudio 链路不受影响（89 断言照绿）

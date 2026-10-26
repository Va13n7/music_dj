/**
 * Claudiao PWA · 前端逻辑（M5-T5/T6，docs/08）
 * 单 <audio> 串行播放：say 优先 → 队列 → 跳过 → MediaSession；WS 指数退避 + 断线轮询。
 */
(() => {
  const $ = (id) => document.getElementById(id);
  const audio = $('audio');        // 音乐声道
  const voiceA = $('voiceA');      // DJ 人声声道（口播压音乐淡入淡出）
  let baseVol = 0.9;               // 音乐基础音量；口播期间 duck 到 0.22
  let introTimer = null;
  let fadeTimer = null;

  function stopVoice() { if (introTimer) { clearTimeout(introTimer); introTimer = null; } voiceA.pause(); }
  function pauseAll() { audio.pause(); voiceA.pause(); }
  function fadeMusicTo(target, ms = 800) {
    clearInterval(fadeTimer);
    const from = audio.volume;
    const steps = Math.max(1, Math.round(ms / 50));
    let i = 0;
    fadeTimer = setInterval(() => {
      i++;
      audio.volume = Math.min(1, Math.max(0, from + (target - from) * (i / steps)));
      if (i >= steps) { clearInterval(fadeTimer); audio.volume = target; }
    }, ms / steps);
  }
  /** 口播压音乐：音乐淡入压低 → DJ 说话 → 结束后音乐音量恢复 */
  function speakOverMusic(intro) {
    if (!intro?.audioUrl) return;
    ducked = true;
    introTimer = setTimeout(() => {
      fadeMusicTo(0.22, 700);
      voiceA.src = intro.audioUrl;
      voiceA.onended = () => { ducked = false; fadeMusicTo(baseVol, 1000); stopSubtitles(); };
      voiceA.play().catch(() => { ducked = false; fadeMusicTo(baseVol, 500); });
      startSubtitles(intro.text || '');
    }, 700);                          // 音乐先起 ~0.7s 再开口，像真电台
  }
  /** DJ 说话（不经音乐的开场白/占位） */
  function speakSolo(u, text, onEnded) {
    voiceA.src = u;
    voiceA.onended = () => { stopSubtitles(); if (onEnded) onEnded(); };
    voiceA.play().catch(() => { if (onEnded) onEnded(); });
    if (text) startSubtitles(text);
  }

  // ---------- DJ 实时字幕：分句 + 按字数权重对齐人声时长，逐句显示 ----------
  let subSegs = [], subBounds = [], subTimer = null;
  function splitSubSegments(text) {
    const parts = String(text || '').split(/(?<=[。！？；!?;,.，])\s*/).map((s) => s.trim()).filter(Boolean);
    return parts.length ? parts : [String(text || '').trim()];
  }
  function startSubtitles(text) {
    stopSubtitles();
    subSegs = splitSubSegments(text);
    if (subSegs.length <= 0) return;
    const weights = subSegs.map((s) => Math.max(1, s.replace(/\s/g, '').length));
    const totalW = weights.reduce((a, b) => a + b, 0);
    let acc = 0;
    subBounds = weights.map((w) => (acc += w / totalW));
    const bar = $('subtitleBar');
    bar.hidden = false;
    renderSub(0);
    subTimer = setInterval(() => {
      const t = voiceA.currentTime || 0;
      let idx = subBounds.findIndex((b) => t <= b);
      if (idx < 0) idx = subSegs.length - 1;
      renderSub(idx);
      if (voiceA.paused || voiceA.ended) stopSubtitles();
    }, 250);
  }
  function renderSub(idx) {
    const bar = $('subtitleBar');
    if (bar.hidden) bar.hidden = false;
    bar.textContent = subSegs[idx] || '';
    bar.style.opacity = '1';
  }
  function stopSubtitles() {
    if (subTimer) { clearInterval(subTimer); subTimer = null; }
    const bar = $('subtitleBar');
    setTimeout(() => { if (!subTimer) { bar.style.opacity = '0'; setTimeout(() => { bar.hidden = true; }, 400); } }, 1500);
  }

  // ---------- 视图切换 ----------
  document.querySelectorAll('nav button').forEach((b) => b.addEventListener('click', () => {
    document.querySelectorAll('nav button').forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
    $(b.dataset.view).classList.add('active');
    if (b.dataset.view === 'view-profile') { loadTaste(); loadProfile(); }
    if (b.dataset.view === 'view-settings') refreshHealth();
  }));

  // ---------- autoplay 解锁 ----------
  // 注意：空 src 的 audio.play() 在部分 Chromium 上 promise 永远 pending，
  // await 它会让"隐藏遮罩"永远执行不到 → 解锁必须播放一个 0 字节静音 wav 且不 await。
  const UNLOCK_WAV = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=';

  // ---------- DJ 人声"调频电台"效果链（Web Audio，实时，音乐声道不受影响） ----------
  // 高通 280Hz 砍隆隆声 → 低通 3400Hz 收窄频带 → 轻度饱和失真 → 电台式重压缩 → 补偿增益
  // 经典 FM 调频声。挂载失败自动直出（不阻塞电台）。
  let voiceCtx = null;
  function ensureRadioEffect() {
    if (voiceCtx) { if (voiceCtx.state === 'suspended') voiceCtx.resume().catch(() => {}); return; }
    try {
      voiceCtx = new (window.AudioContext || window.webkitAudioContext)();
      const src = voiceCtx.createMediaElementSource(voiceA);
      const hp = voiceCtx.createBiquadFilter();
      hp.type = 'highpass'; hp.frequency.value = 280; hp.Q.value = 0.7;
      const lp = voiceCtx.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = 3400; lp.Q.value = 0.7;
      const shaper = voiceCtx.createWaveShaper();
      const n = 1024, curve = new Float32Array(n), drive = 2.2;
      for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; curve[i] = Math.tanh(drive * x) / Math.tanh(drive); }
      shaper.curve = curve; shaper.oversample = '2x';
      const gain = voiceCtx.createGain(); gain.gain.value = 1.35;      // 频带收窄后补偿响度
      const comp = voiceCtx.createDynamicsCompressor();
      comp.threshold.value = -28; comp.knee.value = 12; comp.ratio.value = 5;
      comp.attack.value = 0.004; comp.release.value = 0.15;
      src.connect(hp); hp.connect(lp); lp.connect(shaper); shaper.connect(gain); gain.connect(comp);
      comp.connect(voiceCtx.destination);
      voiceCtx.resume().catch(() => {});
    } catch (e) {
      voiceCtx = null;                                                 // 失败则人声直出
    }
  }

  $('unlockBtn').addEventListener('click', () => {
    ensureRadioEffect();
    for (const el of [audio, voiceA]) {
      el.src = UNLOCK_WAV;
      const p = el.play();
      if (p && p.catch) p.catch(() => { /* 解锁目的已达成 */ });
      el.pause();
    }
    $('unlock').classList.add('hidden');
  });

  // ---------- WS 客户端：指数退避 + 断线轮询 ----------
  let ws = null, wsAttempt = 0, pollTimer = null, wsBase = 500, wsMax = 15000;
  function connectWs() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    try { ws = new WebSocket(`${proto}://${location.host}/stream`); } catch { return fallbackPoll(); }
    ws.onopen = () => { wsAttempt = 0; $('liveDot').classList.add('live'); stopPoll(); };
    ws.onmessage = (ev) => {
      try {
        const m = JSON.parse(ev.data);
        if (m.type === 'now-playing') renderBroadcast(m.data);
        if (m.type === 'control') handleControl(m.data?.action);
        if (m.type === 'queue-update') {
          if (m.data?.track && current) {
            const idx = m.data.index ?? current.queue.length;
            if (current.queue[idx]) {
              // 封面/口播后台补齐：合并进已有条目
              Object.assign(current.queue[idx], m.data.track);
              if (idx === qIndex) {
                renderTrack(current.queue[idx]);
                // 口播是中途补齐的：当前曲还在播且没说过 → drop-in（人声压音乐淡入）
                const tt = current.queue[idx];
                if (tt.intro?.audioUrl && !tt.intro._played && !voiceA.paused && !voiceA.src.includes(tt.intro.audioUrl)) {
                  if (!audio.paused) { tt.intro._played = true; speakOverMusic(tt.intro); }
                }
              }
            } else {
              current.queue.push(m.data.track);
            }
            // 漫游中队列曾耗尽 → 新歌到了自动续播
            if (roamingOn && waitingMore && current.queue[qIndex]?.audioUrl) {
              waitingMore = false;
              phase = 'track';
              playCurrentIndex();
            }
          }
        }
        if (m.type === 'state-change' && m.data?.state) {
          $('state').textContent = m.data.state;
          if (m.data.state === 'THINKING') { $('say').textContent = '（DJ 思考中…）'; $('title').textContent = '选曲中'; }
        }
      } catch { /* ignore */ }
    };
    ws.onclose = () => { $('liveDot').classList.remove('live'); fallbackPoll(); setTimeout(connectWs, backoff()); };
    ws.onerror = () => { try { ws.close(); } catch { /* ignore */ } };
  }
  function backoff() {
    const d = Math.min(wsMax, wsBase * 2 ** wsAttempt) + Math.random() * 250;
    wsAttempt++; return d;
  }
  function fallbackPoll() {
    if (pollTimer) return;
    pollTimer = setInterval(refreshNow, 5000);
  }
  function stopPoll() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

  async function refreshNow() {
    try {
      const r = await fetch('/api/now');
      if (r.ok) renderBroadcast(await r.json());
    } catch { /* ignore */ }
  }

  // ---------- 播放器：单 <audio>，say → 队列 ----------
  let current = null;        // 最近 Broadcast
  let qIndex = 0;            // 当前队列下标
  let phase = 'say';         // say | track
  const pending = { sayUrl: null };

  function renderBroadcast(b, { restart = true } = {}) {
    // 同一 Broadcast 的重复推送（POST 响应 + WS）不重启播放，只刷新界面
    const sameId = current?.id === b.id;
    const isBusy = !audio.paused || !voiceA.paused;
    current = b;
    if (!sameId || restart) { qIndex = 0; phase = b.say?.audioUrl ? 'say' : 'track'; }
    $('state').textContent = b.state || '';
    $('say').textContent = b.say?.text ? `“${b.say.text}”` : '';
    $('why').textContent = b.reason || '';
    renderTrack(b.queue?.[qIndex] || b.queue?.[0]);
    addChat('dj', b.say?.text || '');
    if (!sameId || restart || !isBusy) {
      if (b.say?.audioUrl && !b.say.skipped) {
        // 开场白走人声声道，结束后进队列（首曲口播压音乐）
        speakSolo(b.say.audioUrl, b.say.text || '', () => { phase = 'track'; startQueue(b); });
      } else startQueue(b);
    }
    if ('mediaSession' in navigator && b.queue?.[0]) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: b.queue[0].title, artist: b.queue[0].artist,
        album: 'Claudiao 电台', artwork: b.queue[0].coverUrl ? [{ src: b.queue[0].coverUrl }] : [],
      });
    }
  }

  function renderTrack(t) {
    if (!t) { $('title').textContent = current?.say?.text ? '纯口播' : '还没开始播放'; $('artist').textContent = ''; $('cover').hidden = true; return; }
    $('title').textContent = t.title || '';
    $('artist').textContent = t.artist || '';
    if (t.coverUrl) { $('cover').src = t.coverUrl; $('cover').hidden = false; } else $('cover').hidden = true;
  }

  // ---------- 歌词：LRC 解析 + 逐行高亮跟随播放 ----------
  let lyricsTimer = null, lyricsLines = [];
  $('btnLyricsToggle').addEventListener('click', () => {
    const box = $('lyricsBox');
    box.hidden = !box.hidden;
    $('btnLyricsToggle').textContent = box.hidden ? '展开' : '收起';
  });

  async function loadLyrics(t) {
    clearInterval(lyricsTimer); lyricsLines = [];
    const box = $('lyricsBox');
    box.hidden = false; $('btnLyricsToggle').textContent = '收起';
    $('lyricsCard').hidden = false;
    box.className = ''; box.innerHTML = '<div class="reason">歌词加载中…</div>';
    try {
      const q = new URLSearchParams({ encryptedId: t.encryptedId || '', lyricId: t.lyricId || '', id: t.id || '' });
      const r = await fetch('/api/lyric?' + q);
      const j = await r.json();
      const lrc = j.lrc || '';
      if (!lrc.trim()) { box.innerHTML = '<div class="reason">（这首歌暂时没有歌词）</div>'; return; }
      const times = [], texts = [];
      for (const line of lrc.split(/\r?\n/)) {
        const m = line.match(/^\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\](.*)$/);
        if (m && m[4].trim()) {
          times.push(Number(m[1]) * 60 + Number(m[2]) + (m[3] ? Number('0.' + m[3]) : 0));
          texts.push(m[4].trim());
        } else if (line.trim() && !/^\[ar:|^\[ti:|^\[al:|^\[by:|^\[offset/i.test(line)) {
          texts.push(line.trim()); times.push(null);
        }
      }
      if (!texts.length) { box.innerHTML = '<div class="reason">（暂无歌词）</div>'; return; }
      const timed = times[0] !== null;
      box.className = timed ? '' : 'plain';

      // 三行滚动窗：上一句 / 当前句（高亮）/ 下一句，随播放推进
      const slots = [];
      for (let i = 0; i < 3; i++) {
        const d = document.createElement('div');
        d.className = 'lyr-slot' + (i === 1 ? ' active' : '');
        box.appendChild(d);
        slots.push(d);
      }
      const esc = (tx) => tx.replace(/</g, '&lt;');
      function showWindow(idx) {
        const lines = [
          idx > 0 ? texts[idx - 1] : '',
          texts[idx] || '',
          idx + 1 < texts.length ? texts[idx + 1] : '',
        ];
        slots.forEach((el, i) => { el.innerHTML = esc(lines[i] || '&nbsp;'); el.classList.toggle('active', i === 1 && Boolean(lines[1])); });
      }
      if (!timed) {
        // 无时间戳歌词：按播放进度比例滚窗
        const dur = audio.duration || 1;
        lyricsTimer = setInterval(() => {
          const idx = Math.min(texts.length - 1, Math.floor((audio.currentTime / dur) * texts.length));
          showWindow(Math.max(0, idx));
        }, 500);
        showWindow(0);
      } else {
        lyricsTimer = setInterval(() => {
          const cur = audio.currentTime;
          let act = -1;
          for (let i = 0; i < times.length; i++) {
            if (times[i] !== null && times[i] <= cur + 0.2) act = i;
          }
          showWindow(Math.max(0, act));
        }, 250);
        showWindow(0);
      }
    } catch { box.innerHTML = '<div class="reason">（歌词加载失败）</div>'; }
  }

  function startQueue(b) {
    if (!b.queue?.length) { if (b.fallbackAudio?.audioUrl) { myLastPlayTs = Date.now(); chan?.postMessage({ type: 'takeover', ts: myLastPlayTs }); audio.src = b.fallbackAudio.audioUrl; audio.play().catch(() => {}); } $('lyricsCard').hidden = true; return; }
    playCurrentIndex();
  }
  function playCurrentIndex() {
    const t = current?.queue?.[qIndex];
    if (!t) { pauseAll(); $('state').textContent = 'IDLE'; return; }
    renderTrack(t);
    // 音乐起播；有口播则压音乐淡入 DJ，说完恢复
    myLastPlayTs = Date.now();
    chan?.postMessage({ type: 'takeover', ts: myLastPlayTs, tabId: TAB_ID });
    audio.src = t.audioUrl;
    audio.volume = baseVol;
    audio.play().catch(() => {});
    if (t.intro?.audioUrl && !t.intro.skipped) speakOverMusic(t.intro);
    loadLyrics(t);
    maybeRequestMore();          // 最后一首开播时就续下一批（无缝衔接）
  }
  // ---------- 单实例播放锁：多标签页时最新开播者接管，其余静音（消除双声源回音） ----------
  const TAB_ID = crypto.randomUUID?.() || String(Math.random());
  let myLastPlayTs = 0;
  const chan = 'BroadcastChannel' in window ? new BroadcastChannel('claudiao-radio') : null;
  if (chan) {
    chan.addEventListener('message', (e) => {
      if (e.data?.type !== 'takeover') return;
      if (e.data.ts < myLastPlayTs - 50) return;         // 我的播放更新，忽略旧消息
      if (!audio.paused || !voiceA.paused) {
        pauseAll();
        $('state').textContent = '其他标签页在播';
      }
    });
  }

  audio.addEventListener('ended', () => {
    if (phase === 'track') {
      qIndex++;
      if (current && qIndex < current.queue.length) return playCurrentIndex();
      $('state').textContent = 'IDLE';
      $('title').textContent = '这一轮放完了';
      if (roamingOn) { waitingMore = true; maybeRequestMore(); }   // 漫游开着：等新歌到了自动续播
      return;
    }
  });

  // ---------- 控制 ----------
  let lastControl = { action: '', at: 0 };
  let ducked = false;
  function setMusicVolume(v) { baseVol = Math.min(1, Math.max(0.1, v)); if (!ducked) audio.volume = baseVol; }
  function handleControl(a) {
    if (!a) return;
    const now = Date.now();
    if (a === lastControl.action && now - lastControl.at < 800) return;   // POST+WS 双通道去重
    lastControl = { action: a, at: now };
    switch (a) {
      case 'pause': pauseAll(); $('state').textContent = 'IDLE'; setPlayBtn(false); break;
      case 'resume': audio.play().catch(() => {}); setPlayBtn(true); break;
      case 'next': stopVoice(); audio.pause(); doNext(); break;
      case 'prev': stopVoice(); audio.pause(); if (qIndex > 0) { qIndex--; playCurrentIndex(); } break;
      case 'volume_up': setMusicVolume(baseVol + 0.1); break;
      case 'volume_down': setMusicVolume(baseVol - 0.1); break;
      case 'mute': audio.muted = true; break;
      case 'unmute': audio.muted = false; break;
      case 'mute_say_on': addChat('system', '好的，只放歌不说话。'); break;
      case 'mute_say_off': addChat('system', '好，我回来了。'); break;
    }
  }
  function doNext() {
    fetch(`/api/next?advance=1&playedMs=${Math.round(audio.currentTime * 1000)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (current && j?.index != null) { qIndex = j.index; if (phase === 'say') phase = 'track'; playCurrentIndex(); }
      }).catch(() => {});
  }
  $('btnSkip').addEventListener('click', doNext);
  $('btnPrev').addEventListener('click', () => { if (qIndex > 0) { qIndex--; playCurrentIndex(); } });

  // 暂停/播放按钮
  function setPlayBtn(playing) { $('btnPlayPause').textContent = playing ? '⏸' : '▶'; }
  $('btnPlayPause').addEventListener('click', () => {
    if (audio.paused) { audio.play().catch(() => {}); setPlayBtn(true); }
    else { pauseAll(); setPlayBtn(false); }
  });
  audio.addEventListener('play', () => setPlayBtn(true));
  audio.addEventListener('pause', () => setPlayBtn(false));
  // 音量按钮同步基础音量
  $('btnVolUp').addEventListener('click', () => setMusicVolume(baseVol + 0.1));
  $('btnVolDown').addEventListener('click', () => setMusicVolume(baseVol - 0.1));
  setPlayBtn(false);

  // MediaSession 锁屏控制
  if ('mediaSession' in navigator) {
    try {
      navigator.mediaSession.setActionHandler('pause', () => { audio.pause(); });
      navigator.mediaSession.setActionHandler('play', () => { audio.play().catch(() => {}); });
    } catch { /* ignore */ }
  }

  // ---------- 无限漫游模式 ----------
  let roamingOn = false, waitingMore = false;
  function setRoamingUI(on) {
    roamingOn = on;
    $('btnRoaming').textContent = on ? '🔀 漫游中' : '🔀 漫游';
    $('btnRoaming').style.borderColor = on ? '#4cd97b' : '';
    $('btnRoaming').style.color = on ? '#4cd97b' : '';
  }
  $('btnRoaming').addEventListener('click', async () => {
    const target = !roamingOn;
    $('btnRoaming').disabled = true;
    try {
      const r = await fetch('/api/roaming', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: target }),
      });
      const j = await r.json();
      setRoamingUI(Boolean(j.roaming));
      if (target) addChat('system', '无限漫游已开启：播完自动续歌，再听也不停。');
      else addChat('system', '无限漫游已关闭。');
    } catch { /* ignore */ }
    $('btnRoaming').disabled = false;
  });
  fetch('/api/roaming').then((r) => r.json()).then((j) => setRoamingUI(Boolean(j.enabled))).catch(() => {});
  // 队列只剩最后一首时向服务端要下一批（服务端合成后经 WS 追加）
  let morePending = false;
  function maybeRequestMore() {
    if (!roamingOn || morePending || !current?.queue?.length) return;
    const remaining = current.queue.length - qIndex;
    if (remaining > 1) return;
    morePending = true;
    fetch('/api/roaming/next', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ index: qIndex, queue: current.queue.map((t) => `${t.artist} - ${t.title}`) }),
    }).then((r) => r.json()).then((j) => {
      if (j.tracks?.length) {
        for (const t of j.tracks) {
          if (!current.queue.some((x) => x.audioUrl === t.audioUrl)) { t.index = current.queue.length; current.queue.push(t); }
        }
        addChat('system', `漫游续上了 ${j.tracks.length} 首`);
        // 队列曾耗尽在等 → 续播
        if (audio.paused && phase === 'track' && current.queue[qIndex]?.audioUrl) playCurrentIndex();
      }
    }).catch(() => {}).finally(() => { morePending = false; });
  }

  // ---------- 点播 ----------
  async function send(text) {
    if (!text) return;
    addChat('user', text);
    $('btnSend').disabled = true;
    $('state').textContent = 'THINKING';
    $('say').textContent = '（DJ 思考中…）';
    try {
      const r = await fetch('/api/chat', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, clientMsgId: crypto.randomUUID?.() || String(Date.now()), preferStream: true }),
      });
      if (r.status === 202) {
        // 已受理，结果经 WS now-playing 推送（服务端已同步推 THINKING 状态）
      } else if (r.ok) {
        const j = await r.json();
        if (j.control) handleControl(j.control);
        else renderBroadcast(j);
      } else {
        addChat('system', `发送失败（${r.status}）`);
      }
    } catch { addChat('system', '网络错误'); }
    $('btnSend').disabled = false;
  }
  $('btnSend').addEventListener('click', () => { const v = $('chatInput').value.trim(); if (v) { $('chatInput').value = ''; send(v); } });
  $('chatInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btnSend').click(); });
  $('btnRandom').addEventListener('click', () => send('随便放点'));

  let _lastChat = '';
  function addChat(role, text) {
    if (!text) return;
    const key = role + '|' + text;
    if (key === _lastChat && role !== 'user') return;   // POST 响应与 WS 推送去重
    _lastChat = key;
    const div = document.createElement('div');
    div.className = role;
    div.textContent = (role === 'user' ? '你 · ' : role === 'dj' ? 'DJ · ' : '') + text;
    $('chatlog').appendChild(div);
    $('chatlog').scrollTop = 999999;
  }

  // ---------- Profile：品味语料 ----------
  let tasteBase = null;
  async function loadTaste() {
    try {
      const r = await fetch('/api/taste');
      const j = await r.json();
      tasteBase = j.sha1;
      $('tasteEditor').value = j.content || '';
      $('tasteSha').textContent = j.sha1;
    } catch { $('tasteMsg').textContent = '加载失败'; }
  }
  $('btnSaveTaste').addEventListener('click', async () => {
    $('btnSaveTaste').disabled = true;
    try {
      const r = await fetch('/api/taste', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseSha1: tasteBase, content: $('tasteEditor').value }),
      });
      const j = await r.json();
      $('tasteMsg').textContent = r.ok ? `已保存，下次触发生效（${j.sha1}）` : `失败：${j.message || r.status}`;
      if (r.ok) tasteBase = j.sha1;
    } catch { $('tasteMsg').textContent = '网络错误'; }
    $('btnSaveTaste').disabled = false;
  });

  // ---------- 歌单导入 → 品味画像 ----------
  async function loadProfile() {
    try {
      const r = await fetch('/api/taste/profile');
      const j = await r.json();
      const box = $('profileBox');
      if (j.exists) {
        box.value = j.content; box.style.display = 'block';
        const gen = j.content.match(/生成于 ([^·*]+)/);
        $('profileMeta').textContent = '已生成' + (gen ? ' · ' + gen[1].trim() : '');
        $('btnProfileToggle').textContent = '收起';
      } else {
        $('profileMeta').textContent = '尚未生成——导入歌单后点「生成品味画像」';
      }
    } catch { /* ignore */ }
  }
  $('btnProfileToggle').addEventListener('click', () => {
    const box = $('profileBox');
    box.style.display = box.style.display === 'none' ? 'block' : 'none';
    $('btnProfileToggle').textContent = box.style.display === 'none' ? '展开' : '收起';
  });

  $('btnPlImport').addEventListener('click', async () => {
    const ids = $('plIds').value.split(/[,，\s]+/).filter((x) => /^\d+$/.test(x));
    if (!ids.length) { $('plMsg').textContent = '请填歌单 ID（纯数字，网页版歌单地址栏 id= 后的数字）；歌单需设为公开'; return; }
    $('btnPlImport').disabled = true;
    $('plMsg').textContent = '导入中…（每千首约 10 秒）';
    $('plResult').hidden = false; $('plResult').innerHTML = '';
    try {
      const r = await fetch('/api/taste/import', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids }),
      });
      const j = await r.json();
      for (const it of (j.imported || [])) {
        const div = document.createElement('div');
        div.textContent = it.ok ? `✓ ${it.name} · ${it.trackCount} 首` : `✗ ${it.id}：${it.error}`;
        $('plResult').appendChild(div);
      }
      const okCount = (j.imported || []).filter((x) => x.ok).length;
      $('plMsg').textContent = okCount ? `导入完成（${okCount} 个歌单）——可以点「生成品味画像」了` : '导入失败，见上方明细';
    } catch { $('plMsg').textContent = '网络错误'; }
    $('btnPlImport').disabled = false;
  });

  $('btnPlAnalyze').addEventListener('click', async () => {
    $('btnPlAnalyze').disabled = true;
    $('plMsg').textContent = '大脑分析中…（约 30~60 秒，别关页面）';
    try {
      const r = await fetch('/api/taste/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const j = await r.json();
      if (r.ok) {
        $('plMsg').textContent = `品味画像已生成（${j.chars} 字符）——已生效，之后推荐都按画像来`;
        const box = $('profileBox');
        box.value = j.profile; box.style.display = 'block';
        $('btnProfileToggle').textContent = '收起';
        loadProfile();
      } else {
        $('plMsg').textContent = `失败：${j.message || r.status}`;
      }
    } catch { $('plMsg').textContent = '网络错误（分析耗时长，若超时请重试）'; }
    $('btnPlAnalyze').disabled = false;
  });

  // ---------- Settings：健康 ----------
  async function refreshHealth() {
    try {
      const j = await (await fetch('/api/health')).json();
      const rows = [
        ['运行时间', `${Math.floor(j.uptimeS / 60)} 分 ${j.uptimeS % 60} 秒`],
        ['内存', `${j.rssMb} MB`],
        ['WS 客户端', j.wsClients],
        ['大脑', j.brain ? `${j.brain.available ? '可用' : '降级'}（熔断开: ${j.brain.open ? '是' : '否'}）` : '-'],
        ['音乐直链源', j.music?.ok ? '可用' : '不可用'],
        ['TTS', `${j.tts?.engine ?? '-'}（SAPI 兜底 ${j.tts?.fallbackEnabled ? '开' : '关'}）`],
      ];
      $('healthTable').innerHTML = rows.map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join('');
    } catch { /* ignore */ }
  }

  connectWs();
  refreshNow();
})();

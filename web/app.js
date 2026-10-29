/**
 * Claudiao FM · 前端逻辑（点阵电台版）
 * 双 <audio> 并行声道（音乐 + DJ 人声）；userPaused 冻结一切自动接续。
 * 视觉引擎：点阵时钟/Logo · 双声道实时波形 · DJ 逐词卡拉OK字幕 · 队列面板 · 聊天气泡。
 * WS 指数退避 + 断线轮询；MediaSession 锁屏控制；BroadcastChannel 单实例播放锁。
 */
(() => {
  const $ = (id) => document.getElementById(id);
  const audio = $('audio');        // 音乐声道
  const voiceA = $('voiceA');      // DJ 人声声道（口播压音乐淡入淡出）
  let baseVol = 0.9;               // 音乐基础音量；口播期间 duck 到 0.22
  let introTimer = null;
  let fadeTimer = null;
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const fmtT = (s) => { s = Math.max(0, Math.floor(s || 0)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
  const nowHM = () => { const d = new Date(); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

  // ---------- 主题（DARK / LIGHT） ----------
  function setTheme(t) {
    document.body.classList.toggle('theme-light', t === 'light');
    try { localStorage.setItem('claudiao.theme', t); } catch { /* ignore */ }
    $('themeDark').classList.toggle('on', t !== 'light');
    $('themeLight').classList.toggle('on', t === 'light');
    _dotCol = null; _waveCol = null;
    drawLogo(); drawClock();
  }
  $('themeDark').addEventListener('click', () => setTheme('dark'));
  $('themeLight').addEventListener('click', () => setTheme('light'));

  // ---------- 点阵渲染（5×7 字库：时钟数字 + Logo 字母） ----------
  const GLYPHS = {
    '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
    '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
    '2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
    '3': ['11111', '00010', '00100', '00010', '00001', '10001', '01110'],
    '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
    '5': ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
    '6': ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
    '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
    '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
    '9': ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
    ':': ['00000', '00100', '00100', '00000', '00100', '00100', '00000'],
    'C': ['01110', '10001', '10000', '10000', '10000', '10001', '01110'],
    'L': ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
    'A': ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
    'U': ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
    'D': ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
    'I': ['01110', '00100', '00100', '00100', '00100', '00100', '01110'],
    'O': ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  };
  let _dotCol = null, _waveCol = null;
  const themeVar = (name, fallback) => {
    const v = getComputedStyle(document.body).getPropertyValue(name).trim();
    return v || fallback;
  };
  function drawDots(canvas, text, { size = 6, gap = 2 } = {}) {
    const chars = String(text).toUpperCase().split('');
    if (!chars.every((c) => GLYPHS[c])) return;
    const p = size + gap;
    const cols = chars.length * 6 - 1;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = (cols * p + gap) * dpr;
    canvas.height = (7 * p + gap) * dpr;
    canvas.style.height = 'auto';
    const on = themeVar('--dot-on', '#e8e6f0');
    const off = themeVar('--dot-off', 'rgba(255,255,255,.06)');
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    chars.forEach((ch, ci) => {
      const g = GLYPHS[ch];
      for (let r = 0; r < 7; r++) {
        for (let c = 0; c < 5; c++) {
          const x = (ci * 6 + c) * p + gap, y = r * p + gap;
          ctx.fillStyle = g[r][c] === '1' ? on : off;
          ctx.beginPath();
          ctx.arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    });
  }
  function drawLogo() { drawDots($('logoDots'), 'CLAUDIAO', { size: 2.6, gap: 1.4 }); }
  function drawClock() {
    const d = new Date();
    drawDots($('dotClock'), `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`, { size: 9, gap: 5 });
    $('clockWd').textContent = '周' + '日一二三四五六'[d.getDay()];
    $('clockDate').textContent = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  setInterval(drawClock, 1000);
  drawClock(); drawLogo();

  // ---------- 视图切换 ----------
  document.querySelectorAll('nav button').forEach((b) => b.addEventListener('click', () => {
    document.querySelectorAll('nav button').forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
    $(b.dataset.view).classList.add('active');
    if (b.dataset.view === 'view-profile') { loadTaste(); loadProfile(); refreshNetease(); }
    if (b.dataset.view === 'view-settings') { refreshHealth(); refreshBrainConfig(); }
  }));

  // ---------- autoplay 解锁 ----------
  // 注意：空 src 的 audio.play() 在部分 Chromium 上 promise 永远 pending，
  // await 它会让"隐藏遮罩"永远执行不到 → 解锁必须播放一个 0 字节静音 wav 且不 await。
  const UNLOCK_WAV = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=';

  // ---------- DJ 人声"调频电台"效果链（Web Audio，实时，音乐声道不受影响） ----------
  // 高通 280Hz → 低通 3400Hz → 轻度饱和 → 电台式重压缩 → 补偿增益；失败自动直出。
  // 顺路人声 AnalyserNode → 头部大波形。
  let voiceCtx = null, voiceAn = null;
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
      const gain = voiceCtx.createGain(); gain.gain.value = 1.35;
      const comp = voiceCtx.createDynamicsCompressor();
      comp.threshold.value = -28; comp.knee.value = 12; comp.ratio.value = 5;
      comp.attack.value = 0.004; comp.release.value = 0.15;
      src.connect(hp); hp.connect(lp); lp.connect(shaper); shaper.connect(gain); gain.connect(comp);
      comp.connect(voiceCtx.destination);
      voiceAn = voiceCtx.createAnalyser();                       // 波形抽头
      voiceAn.fftSize = 512; voiceAn.smoothingTimeConstant = 0.8;
      gain.connect(voiceAn);
      voiceCtx.resume().catch(() => {});
    } catch { voiceCtx = null; voiceAn = null; }                 // 失败则人声直出
  }
  // 音乐声道的律动为程序化节拍动画，刻意不触碰 WebAudio——
  // createMediaElementSource 是不可逆绑定，在本机浏览器上两次导致"在播无声"。

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

  // ---------- 双声道实时波形 ----------
  function drawSpectrum(cv, an, live, bars, amp) {
    if (!cv) return;
    if (cv.width !== cv.clientWidth || cv.height !== cv.clientHeight) { cv.width = cv.clientWidth; cv.height = cv.clientHeight; }
    const ctx = cv.getContext('2d');
    ctx.clearRect(0, 0, cv.width, cv.height);
    const col = _waveCol || (_waveCol = themeVar('--wave', '#d9d5ee'));
    const bw = cv.width / bars;
    const data = an && live ? new Uint8Array(an.frequencyBinCount) : null;
    if (data) an.getByteFrequencyData(data);
    for (let i = 0; i < bars; i++) {
      let v;
      if (data) v = data[Math.floor((i / bars) * data.length * 0.72)] / 255;
      else if (live) v = 0.12 + Math.random() * 0.34;            // 无分析器但在播：装饰性起伏
      else v = 0.03 + Math.random() * 0.035;                     // 待机时的微弱"底噪"，像通电的机器
      const h = Math.max(2, v * cv.height * amp * 0.5);
      ctx.fillStyle = col;
      ctx.globalAlpha = data ? 0.26 + v * 0.74 : (live ? 0.5 : 0.16);
      ctx.fillRect(i * bw + bw * 0.26, cv.height / 2 - h / 2, bw * 0.48, h);
    }
    ctx.globalAlpha = 1;
  }
  /** 音乐迷你律动已按需求撤销（2026-10-27）：该位置改为单行歌词字幕 */
  (function waveLoop() {
    requestAnimationFrame(waveLoop);
    drawSpectrum($('waveVoice'), voiceAn, !voiceA.paused && !!voiceA.src && !voiceA.src.startsWith('data:'), 56, 2.4);
  })();

  // ---------- DJ 实时字幕：逐词卡拉OK（句子级时间轴 + 词级高亮，对齐人声 currentTime） ----------
  let tLines = [], tTimer = null;
  function stopTranscriptPoll() { if (tTimer) { clearInterval(tTimer); tTimer = null; } $('subLive')?.classList.remove('on'); }
  function finishTranscript() {
    stopTranscriptPoll();
    tLines.forEach((L) => { L.el.classList.add('past'); L.el.classList.remove('active'); L.sps.forEach((sp) => sp.classList.remove('k')); });
  }
  function splitSentences(text) {
    const parts = String(text || '').split(/(?<=[。！？；!?;,.，])\s*/).map((s) => s.trim()).filter(Boolean);
    return parts.length ? parts : [String(text || '').trim()];
  }
  function tokenize(sent) {
    if (/[\u4e00-\u9fff]/.test(sent)) return [...sent];          // 中文按字
    return sent.split(/\s+/).filter(Boolean);                    // 英文按词
  }
  function startTranscript(text) {
    stopTranscriptPoll();
    const bar = $('subtitleBar');
    bar.hidden = false;
    bar.innerHTML = '';
    tLines = [];
    const sents = splitSentences(text);
    const sWeights = sents.map((s) => Math.max(1, s.replace(/\s/g, '').length));
    const sTotal = sWeights.reduce((a, b) => a + b, 0);
    let acc = 0;
    sents.forEach((sent, si) => {
      const toks = tokenize(sent);
      const line = document.createElement('div');
      line.className = 'tline';
      line.innerHTML = '<span class="tstamp mono"></span><span class="ttext"></span>';
      const tt = line.querySelector('.ttext');
      toks.forEach((tok) => {
        const sp = document.createElement('span');
        sp.className = 'tw'; sp.textContent = tok;
        tt.appendChild(sp);
      });
      const tokWeights = toks.map((t) => Math.max(1, t.length));
      tLines.push({
        el: line, sps: [...tt.children], tokWeights,
        tokTotal: tokWeights.reduce((a, b) => a + b, 0) || 1,
        startFrac: acc / sTotal,
      });
      acc += sWeights[si];
      bar.appendChild(line);
    });
    $('subLive')?.classList.add('on');
    tTimer = setInterval(() => {
      const dur = voiceA.duration;
      const cur = voiceA.currentTime || 0;
      const hasDur = dur && isFinite(dur);
      const frac = hasDur ? cur / dur : null;
      let activeIdx = -1;
      tLines.forEach((L, i) => {
        const endFrac = tLines[i + 1]?.startFrac ?? 1.0001;
        const on = frac != null && frac >= L.startFrac && frac < endFrac;
        L.el.classList.toggle('active', on);
        L.el.classList.toggle('past', frac != null && frac >= endFrac);
        if (hasDur) L.el.querySelector('.tstamp').textContent = fmtT(L.startFrac * dur);
        if (on) {
          activeIdx = i;
          const wf = Math.min(1, (frac - L.startFrac) / (endFrac - L.startFrac));
          let tw = 0, k = -1;
          L.sps.forEach((sp, j) => {
            const wEnd = (tw + L.tokWeights[j]) / L.tokTotal;
            const hit = k < 0 && wf < wEnd;
            sp.classList.toggle('k', hit);
            if (hit) k = j;
            tw += L.tokWeights[j];
          });
          if (k < 0) L.sps.forEach((sp) => sp.classList.add('k'));
        } else {
          L.sps.forEach((sp) => sp.classList.remove('k'));
        }
      });
      if (activeIdx >= 0) tLines[activeIdx].el.scrollIntoView({ block: 'nearest' });
      if (voiceA.ended) finishTranscript();
    }, 120);
  }

  // ---------- 播放核心：口播压音乐 / 用户暂停状态机 ----------
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
  // 用户暂停：冻结一切自动接续，只停不丢——没说完的话记下来，恢复时补上
  let userPaused = false, holdSay = null, pendingIntro = null, pendingAdvance = false, currentIntro = null;
  function pausePlayback() {
    userPaused = true;
    if (introTimer) { clearTimeout(introTimer); introTimer = null; pendingIntro = currentIntro; currentIntro = null; }
    voiceA.pause();
    audio.pause();
    $('state').textContent = '已暂停';
    $('speakingTag').hidden = true;
    setPlayBtn(false);
  }
  function resumePlayback() {
    if (!userPaused) {
      // 播放键兜底：自动播放被策略拦下时，用户点击（带手势）从这里恢复
      audio.play().catch(() => {});
      if (phase === 'say' && voiceA.src && voiceA.paused && !voiceA.ended) voiceA.play().catch(() => {});
      return;
    }
    userPaused = false;
    $('state').textContent = phase === 'say' ? 'SPEAKING' : 'PLAYING';
    setPlayBtn(true);
    if (pendingAdvance) { pendingAdvance = false; playCurrentIndex(); return; }
    if (holdSay) { const s = holdSay; holdSay = null; speakSolo(s.url, s.text, s.onEnded); return; }
    if (phase === 'say') {
      if (voiceA.src && !voiceA.ended) voiceA.play().catch(() => {});
      else if (current) { phase = 'track'; startQueue(current); }
      return;
    }
    audio.play().catch(() => {});
    if (pendingIntro) { const it = pendingIntro; pendingIntro = null; speakOverMusic(it); return; }
    if (voiceA.src && voiceA.paused && !voiceA.ended && voiceA.currentTime > 0) voiceA.play().catch(() => {});
  }
  function clearHold() {
    userPaused = false; holdSay = null; pendingIntro = null; pendingAdvance = false; currentIntro = null;
  }

  /** 口播压音乐：音乐淡入压低 → DJ 说话 → 结束后音乐音量恢复。暂停期间不说话，转 pendingIntro */
  function speakOverMusic(intro) {
    if (!intro?.audioUrl) return;
    if (userPaused) { pendingIntro = intro; return; }
    ducked = true;
    currentIntro = intro;
    introTimer = setTimeout(() => {
      introTimer = null;
      currentIntro = null;
      if (userPaused) { pendingIntro = intro; ducked = false; return; }
      fadeMusicTo(0.22, 700);
      voiceA.src = intro.audioUrl;
      voiceA.onended = () => { ducked = false; fadeMusicTo(baseVol, 1000); finishTranscript(); };
      // 口播音频加载失败：不挂死，直接恢复音乐音量继续放歌
      voiceA.onerror = () => { ducked = false; fadeMusicTo(baseVol, 500); finishTranscript(); };
      voiceA.play().catch(() => { ducked = false; fadeMusicTo(baseVol, 500); });
      $('speakingTag').hidden = false;
      startTranscript(intro.text || '');
    }, 700);                          // 音乐先起 ~0.7s 再开口，像真电台
  }
  /** DJ 说话（不经音乐的开场白/占位）。暂停期间先记下，恢复时补说 */
  function speakSolo(u, text, onEnded) {
    if (userPaused) { holdSay = { url: u, text, onEnded }; return; }
    voiceA.src = u;
    voiceA.onended = () => { finishTranscript(); $('speakingTag').hidden = true; if (onEnded) onEnded(); };
    // 开场白音频加载失败：不能卡死在 say 阶段——直接进队列放歌
    voiceA.onerror = () => { finishTranscript(); $('speakingTag').hidden = true; if (onEnded) onEnded(); };
    voiceA.play().catch((e) => {
      if (e?.name === 'NotAllowedError') {          // 自动播放被拦：等用户点播放键（带手势后可恢复）
        $('state').textContent = '点击播放键继续';
        setPlayBtn(false);
        return;
      }
      if (onEnded) onEnded();
    });
    $('speakingTag').hidden = false;
    if (text) startTranscript(text);
  }

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
            // 优先按曲目 id 匹配（漫游补口播的 WS 事件带的是服务端本地索引，不可直接用）
            const idx = m.data.index ?? current.queue.length;
            let hit = m.data.track.id ? current.queue.findIndex((x) => String(x.id) === String(m.data.track.id)) : -1;
            if (hit < 0) hit = current.queue[idx] ? idx : -1;
            if (hit >= 0) {
              Object.assign(current.queue[hit], m.data.track);
              if (hit === qIndex) {
                renderTrack(current.queue[hit]);
                const tt = current.queue[hit];
                if (tt.intro?.audioUrl && !tt.intro._played && !voiceA.paused && !voiceA.src.includes(tt.intro.audioUrl)) {
                  if (!audio.paused) { tt.intro._played = true; speakOverMusic(tt.intro); }
                }
              }
            } else {
              current.queue.push(m.data.track);
            }
            renderQueue();
            if (roamingOn && waitingMore && !userPaused && current.queue[qIndex]?.audioUrl) {
              waitingMore = false;
              phase = 'track';
              playCurrentIndex();
            }
          }
        }
        if (m.type === 'state-change' && m.data?.state) {
          if (!userPaused) $('state').textContent = m.data.state;
          if (m.data.state === 'THINKING') {
            $('say').textContent = '（DJ 思考中…）';
            $('title').textContent = '选曲中';
            $('program').textContent = '选曲中…';
          }
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

  // ---------- 播放器视图 ----------
  let current = null;        // 最近 Broadcast
  let qIndex = 0;            // 当前队列下标
  let phase = 'say';         // say | track
  let favOn = false;

  function renderBroadcast(b, { restart = false } = {}) {
    const sameId = current?.id === b.id;
    current = b;
    if (!sameId) { qIndex = 0; phase = b.say?.audioUrl ? 'say' : 'track'; favOn = false; $('btnFav').classList.remove('on'); }
    if (!userPaused) $('state').textContent = b.state || '';
    if (b.program?.name) $('program').textContent = b.program.name;
    $('say').textContent = b.say?.text ? `“${b.say.text}”` : '';
    $('say').hidden = !b.say?.text;
    $('why').textContent = b.reason || '';
    renderTrack(b.queue?.[qIndex] || b.queue?.[0]);
    renderQueue();
    addChat('dj', b.say?.text || '', { audioUrl: b.say?.audioUrl });
    // 自动起播仅限「新播报且还新鲜」：页面刷新拉回的几小时前旧播报只渲染界面，
    // 不重放——旧播报的歌曲直链多半已过期，重放就是"DJ 说完没歌声"。
    const fresh = !b.at || (Date.now() - new Date(b.at).getTime()) < 5 * 60000;
    if (!sameId && (fresh || restart)) {
      if (b.say?.audioUrl && !b.say.skipped) {
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

  // ---------- 队列面板 ----------
  function renderQueue() {
    const q = current?.queue || [];
    $('queueCount').textContent = `${q.length} TRACKS`;
    const ol = $('queueList');
    ol.innerHTML = '';
    if (!q.length) { ol.innerHTML = '<div class="queue-empty">队列还空着——点下面聊一句，Valen 就开台。</div>'; return; }
    q.forEach((t, i) => {
      const li = document.createElement('li');
      li.className = 'qitem' + (i === qIndex ? ' active' : '');
      li.innerHTML = `<span class="qidx mono">${String(i + 1).padStart(2, '0')}</span>` +
        `<span class="qmain"><b>${esc(t.title)}</b><i>${esc(t.artist)}</i></span>` +
        (i === qIndex ? '<span class="qeq">♪</span>' : '');
      li.addEventListener('click', () => jumpTo(i));
      ol.appendChild(li);
    });
  }
  function jumpTo(i) {
    if (!current?.queue?.[i]?.audioUrl) return;
    clearHold();
    qIndex = i; phase = 'track';
    playCurrentIndex();
  }

  // ---------- 歌词：LRC 解析 → 单行实时字幕（200ms 轮询 + 0.35s 提前量抗延迟） ----------
  let lyricTimer = null, lyricTimes = [], lyricTexts = [], lyricIdx = -1;
  function stopLyricTicker() { if (lyricTimer) { clearInterval(lyricTimer); lyricTimer = null; } }
  async function loadLyrics(t) {
    stopLyricTicker();
    lyricTimes = []; lyricTexts = []; lyricIdx = -1;
    const el = $('lyricsTicker');
    el.hidden = true; el.classList.remove('tick'); el.textContent = '';
    try {
      const q = new URLSearchParams({ encryptedId: t.encryptedId || '', lyricId: t.lyricId || '', id: t.id || '' });
      const r = await fetch('/api/lyric?' + q);
      const j = await r.json();
      const lrc = j.lrc || '';
      for (const line of lrc.split(/\r?\n/)) {
        const m = line.match(/^\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\](.*)$/);
        if (m && m[4].trim()) {
          lyricTimes.push(Number(m[1]) * 60 + Number(m[2]) + (m[3] ? Number('0.' + m[3]) : 0));
          lyricTexts.push(m[4].trim());
        }
      }
      if (!lyricTexts.length) return;                     // 无歌词：保持隐藏，不影响播放
      el.hidden = false;
      lyricTimer = setInterval(() => {
        if (audio.paused) return;                         // 暂停时字幕停住不走
        const cur = audio.currentTime + 0.35;             // 提前量：歌词先于人声半拍出现
        let idx = -1;
        for (let i = 0; i < lyricTimes.length; i++) if (lyricTimes[i] <= cur) idx = i;
        if (idx !== lyricIdx && idx >= 0) {
          lyricIdx = idx;
          el.textContent = lyricTexts[idx];
          el.classList.remove('tick');
          void el.offsetWidth;                            // 重启入場动画
          el.classList.add('tick');
        }
      }, 200);
    } catch { /* 静默：歌词拉不到不影响播放 */ }
  }

  function startQueue(b) {
    phase = 'track';
    if (!b.queue?.length) { if (b.fallbackAudio?.audioUrl) { myLastPlayTs = Date.now(); chan?.postMessage({ type: 'takeover', ts: myLastPlayTs }); audio.src = b.fallbackAudio.audioUrl; if (!userPaused) audio.play().catch(() => {}); } return; }
    playCurrentIndex();
  }
  function playCurrentIndex() {
    const t = current?.queue?.[qIndex];
    if (!t) { pauseAll(); $('state').textContent = 'IDLE'; return; }
    renderTrack(t);
    renderQueue();
    myLastPlayTs = Date.now();
    chan?.postMessage({ type: 'takeover', ts: myLastPlayTs, tabId: TAB_ID });
    audio.src = t.audioUrl;
    audio.volume = baseVol;
    if (t.intro?.audioUrl && !t.intro.skipped) speakOverMusic(t.intro);   // 暂停中会被收进 pendingIntro
    if (!userPaused) audio.play().catch(() => {});
    addChat('system', `NOW PLAYING · ${t.artist} - ${t.title}`);
    loadLyrics(t);
    maybeRequestMore();          // 最后一首开播时就续下一批（无缝衔接）
  }

  // ---------- 单实例播放锁 ----------
  const TAB_ID = crypto.randomUUID?.() || String(Math.random());
  let myLastPlayTs = 0;
  const chan = 'BroadcastChannel' in window ? new BroadcastChannel('claudiao-radio') : null;
  if (chan) {
    chan.addEventListener('message', (e) => {
      if (e.data?.type !== 'takeover') return;
      if (e.data.ts < myLastPlayTs - 50) return;
      if (!audio.paused || !voiceA.paused) {
        pausePlayback();
        $('state').textContent = '其他标签页在播';
      }
    });
  }

  audio.addEventListener('ended', () => {
    if (phase !== 'track') return;
    qIndex++;
    if (userPaused) { pendingAdvance = true; return; }   // 暂停落在切歌边界：恢复时再进下一首
    if (current && qIndex < current.queue.length) return playCurrentIndex();
    $('state').textContent = 'IDLE';
    $('title').textContent = '这一轮放完了';
    $('speakingTag').hidden = true;
    if (roamingOn) { waitingMore = true; maybeRequestMore(); }   // 漫游开着：等新歌到了自动续播
  });

  // 直链失效自愈：加载失败自动跳下一首（连坏 3 首就停，避免死循环空转）
  let errorStreak = 0;
  audio.addEventListener('playing', () => { errorStreak = 0; });
  audio.addEventListener('error', () => {
    if (!audio.src || audio.src.startsWith('data:')) return;
    errorStreak++;
    addChat('system', `《${current?.queue?.[qIndex]?.title || '这首'}》直链失效了，自动跳过。`);
    if (errorStreak >= 3 || !current?.queue?.length) {
      $('state').textContent = 'IDLE';
      $('title').textContent = '直链都失效了，点一句让 Valen 换一批';
      return;
    }
    qIndex++;
    if (current && qIndex < current.queue.length) playCurrentIndex();
    else if (roamingOn) { waitingMore = true; maybeRequestMore(); }
    else { $('state').textContent = 'IDLE'; $('title').textContent = '这一轮放完了'; }
  });

  // ---------- 进度条 / 时间 ----------
  let seekDrag = false;
  const seek = $('seek');
  seek.addEventListener('pointerdown', () => { seekDrag = true; });
  seek.addEventListener('pointerup', () => { seekDrag = false; });
  seek.addEventListener('change', () => { seekDrag = false; });
  seek.addEventListener('input', () => {
    const el = phase === 'say' && voiceA.src && !voiceA.ended ? voiceA : audio;
    if (el && isFinite(el.duration) && el.duration > 0) el.currentTime = (seek.value / 1000) * el.duration;
  });
  function updateTimeRow() {
    const el = phase === 'say' && voiceA.src && !voiceA.ended ? voiceA : audio;
    const cur = el?.currentTime || 0;
    const dur = el && isFinite(el.duration) ? el.duration : 0;
    $('timeNow').textContent = `${fmtT(cur)} / ${fmtT(dur)}`;
    if (!seekDrag && dur) seek.value = Math.round((cur / dur) * 1000);
    $('speakingTag').hidden = !(voiceA.src && !voiceA.paused && !voiceA.ended && voiceA.src !== UNLOCK_WAV);
  }
  for (const el of [audio, voiceA]) {
    el.addEventListener('timeupdate', updateTimeRow);
    el.addEventListener('durationchange', updateTimeRow);
    el.addEventListener('play', updateTimeRow);
    el.addEventListener('pause', updateTimeRow);
  }

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
      case 'pause': pausePlayback(); break;
      case 'resume': resumePlayback(); break;
      case 'next': stopVoice(); clearHold(); audio.pause(); doNext(); break;
      case 'prev': stopVoice(); audio.pause(); if (qIndex > 0) { clearHold(); qIndex--; playCurrentIndex(); } else resumePlayback(); break;
      case 'volume_up': setMusicVolume(baseVol + 0.1); break;
      case 'volume_down': setMusicVolume(baseVol - 0.1); break;
      case 'mute': audio.muted = true; break;
      case 'unmute': audio.muted = false; break;
      case 'mute_say_on': addChat('system', '好的，只放歌不说话。'); break;
      case 'mute_say_off': addChat('system', '好，我回来了。'); break;
    }
  }
  function doNext() {
    clearHold();
    fetch(`/api/next?advance=1&playedMs=${Math.round(audio.currentTime * 1000)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (current && j?.index != null) { qIndex = j.index; if (phase === 'say') phase = 'track'; playCurrentIndex(); }
      }).catch(() => {});
  }
  $('btnSkip').addEventListener('click', doNext);
  $('btnPrev').addEventListener('click', () => { if (qIndex > 0) { clearHold(); qIndex--; playCurrentIndex(); } else resumePlayback(); });

  // 暂停/播放按钮：以实际播放状态为准（含自动播放被拦后的单击恢复）
  function setPlayBtn(playing) { $('btnPlayPause').textContent = playing ? '⏸' : '▶'; }
  $('btnPlayPause').addEventListener('click', () => {
    const saySuspended = phase === 'say' && voiceA.paused && !voiceA.ended && voiceA.src && !voiceA.src.startsWith('data:');
    if (userPaused || audio.paused || saySuspended) resumePlayback();
    else pausePlayback();
  });
  audio.addEventListener('play', () => setPlayBtn(true));
  audio.addEventListener('pause', () => setPlayBtn(false));
  $('btnVolUp').addEventListener('click', () => setMusicVolume(baseVol + 0.1));
  $('btnVolDown').addEventListener('click', () => setMusicVolume(baseVol - 0.1));
  setPlayBtn(false);

  // 收藏当前曲目 → plays.feedback
  $('btnFav').addEventListener('click', async () => {
    if (!current?.id) return;
    favOn = !favOn;
    $('btnFav').classList.toggle('on', favOn);
    $('btnFav').textContent = favOn ? '♥' : '♡';
    try {
      await fetch('/api/feedback', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ broadcastId: current.id, feedback: favOn ? 1 : 0 }),
      });
    } catch { /* 状态以本地为准 */ }
  });

  // MediaSession 锁屏控制
  if ('mediaSession' in navigator) {
    try {
      navigator.mediaSession.setActionHandler('pause', () => pausePlayback());
      navigator.mediaSession.setActionHandler('play', () => resumePlayback());
    } catch { /* ignore */ }
  }

  // ---------- 无限漫游模式 ----------
  let roamingOn = false, waitingMore = false;
  function setRoamingUI(on) {
    roamingOn = on;
    $('btnRoaming').textContent = on ? '🔀 漫游中' : '🔀 漫游';
    $('btnRoaming').classList.toggle('on', on);
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
        renderQueue();
        addChat('system', `漫游续上了 ${j.tracks.length} 首`);
        if (waitingMore && !userPaused && phase === 'track' && current.queue[qIndex]?.audioUrl) { waitingMore = false; playCurrentIndex(); }
      }
    }).catch(() => {}).finally(() => { morePending = false; });
  }

  // ---------- 点播 ----------
  async function send(text) {
    if (!text) return;
    addChat('user', text);
    $('btnSend').disabled = true;
    if (!userPaused) $('state').textContent = 'THINKING';
    $('say').textContent = '（DJ 思考中…）';
    $('program').textContent = '选曲中…';
    try {
      const r = await fetch('/api/chat', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, clientMsgId: crypto.randomUUID?.() || String(Date.now()), preferStream: true }),
      });
      if (r.status === 202) {
        // 已受理，结果经 WS now-playing 推送
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

  // ---------- 聊天气泡（DJ 头像 + 时间戳 + REPLAY；系统插播居中） ----------
  let _lastChat = '';
  function addChat(role, text, meta = {}) {
    if (!text) return;
    const key = role + '|' + text;
    if (key === _lastChat && role !== 'user') return;   // POST 响应与 WS 推送去重
    _lastChat = key;
    const log = $('chatlog');
    const div = document.createElement('div');
    div.className = 'msg ' + role;
    if (role === 'system') {
      div.textContent = text;
    } else if (role === 'dj') {
      div.innerHTML = '<span class="avatar">🎧</span>' +
        '<div class="bubble"><div class="mhead mono">VALEN · ' + nowHM() + '</div><div class="mtext"></div>' +
        (meta.audioUrl ? '<button class="replay mono">▶ REPLAY</button>' : '') + '</div>';
      div.querySelector('.mtext').textContent = text;
      if (meta.audioUrl) {
        div.querySelector('.replay').addEventListener('click', () => {
          clearHold();
          speakOverMusic({ audioUrl: meta.audioUrl, text });
        });
      }
    } else {
      div.innerHTML = '<div class="bubble"><div class="mtext"></div></div>';
      div.querySelector('.mtext').textContent = text;
    }
    log.appendChild(div);
    log.scrollTop = 999999;
  }

  // ---------- DJ 主页 ----------
  $('btnDjCard').addEventListener('click', async () => {
    $('djModal').hidden = false;
    try {
      const j = await (await fetch('/api/dj')).json();
      $('djTagline').textContent = j.tagline || '';
      $('djBio').textContent = (j.bio || []).join('\n');
      const box = $('djGenres');
      box.innerHTML = '';
      for (const g of j.genres || []) {
        const sp = document.createElement('span');
        sp.textContent = String(g).toUpperCase();
        box.appendChild(sp);
      }
    } catch { $('djTagline').textContent = '你的专属私人 DJ'; }
  });
  $('btnDjClose').addEventListener('click', () => { $('djModal').hidden = true; });
  $('djModal').addEventListener('click', (e) => { if (e.target.id === 'djModal') $('djModal').hidden = true; });

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

  // ---------- 网易云扫码登录（Cookie 音源） ----------
  let neteasePollTimer = null;
  async function refreshNetease() {
    try {
      const st = await (await fetch('/api/netease/status')).json();
      const badge = $('neteaseState');
      if (st.loggedIn) {
        badge.textContent = '已登录';
        badge.style.color = 'var(--green)';
        $('neteaseQr').hidden = true; $('btnNeteaseLogin').hidden = true; $('btnNeteaseLogout').hidden = false;
        $('neteaseMsg').textContent = '直链跟随你的账号权益（VIP 曲目可听）';
      } else {
        badge.textContent = '未登录';
        badge.style.color = '';
        $('btnNeteaseLogout').hidden = true;
        $('neteaseMsg').textContent = st.installed === false ? '服务端缺 NeteaseCloudMusicApi 依赖' : '扫码登录后可解锁完整曲库与音质';
      }
    } catch { /* ignore */ }
  }
  $('btnNeteaseLogin').addEventListener('click', async () => {
    $('btnNeteaseLogin').disabled = true;
    $('neteaseMsg').textContent = '二维码生成中…';
    try {
      const qr = await (await fetch('/api/netease/login/qr')).json();
      $('neteaseQr').src = qr.qrimg; $('neteaseQr').hidden = false;
      $('neteaseMsg').textContent = '请用网易云音乐 App 扫码';
      clearInterval(neteasePollTimer);
      neteasePollTimer = setInterval(async () => {
        try {
          const st = await (await fetch('/api/netease/login/check')).json();
          if (st.code === 803) {
            clearInterval(neteasePollTimer);
            $('neteaseMsg').textContent = '登录成功 ✓ 音源已切换为你的账号权益';
            refreshNetease();
          } else if (st.code === 802) {
            $('neteaseMsg').textContent = '已扫码，请在手机上确认';
          }
        } catch { /* ignore */ }
      }, 2000);
    } catch { $('neteaseMsg').textContent = '二维码生成失败'; }
    $('btnNeteaseLogin').disabled = false;
  });
  $('btnNeteaseLogout').addEventListener('click', async () => {
    await fetch('/api/netease/logout', { method: 'POST' }).catch(() => {});
    refreshNetease();
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

  // ---------- Settings：大脑 API 接入 ----------
  let brainProviders = [];
  function renderSavedConfigs(saved, activeId) {
    const box = $('brainSavedList');
    const count = $('brainSavedCount');
    if (count) count.textContent = String(saved.length);
    if (!box) return;
    box.innerHTML = '';
    box.hidden = !saved.length;
    for (const s of saved) {
      const pname = (brainProviders.find((p) => p.id === s.provider)?.name) || s.provider;
      const row = document.createElement('div');
      row.className = 'savedrow' + (s.id === activeId ? ' active' : '');
      row.innerHTML = `<span class="s-main"><b>${esc(pname)} · ${esc(s.model)}</b>` +
        `<i>Key ••••${esc((s.keyMasked || '').slice(-4))}</i></span>` +
        `<span class="s-btns">` +
        (s.id === activeId ? `<span class="mono s-on">● 使用中</span>` : `<button class="pill" data-act="use">使用</button>`) +
        `<button class="pill" data-act="del" title="删除此配置">删</button></span>`;
      row.querySelector('[data-act="use"]')?.addEventListener('click', async () => {
        try {
          const r = await fetch('/api/brain-config/activate', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: s.id }),
          });
          const j = await r.json();
          if (r.ok && j.ok) { addChat('system', `大脑已切换：${pname} · ${s.model}`); refreshBrainConfig(); }
        } catch { /* ignore */ }
      });
      row.querySelector('[data-act="del"]')?.addEventListener('click', async () => {
        try {
          await fetch('/api/brain-config/delete', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: s.id }),
          });
          refreshBrainConfig();
        } catch { /* ignore */ }
      });
      box.appendChild(row);
    }
  }
  async function refreshBrainConfig() {
    try {
      const j = await (await fetch('/api/brain-config')).json();
      brainProviders = j.providers || [];
      const sel = $('brainProvider');
      sel.innerHTML = '';
      for (const p of brainProviders) {
        const opt = document.createElement('option');
        opt.value = p.id; opt.textContent = p.name;
        sel.appendChild(opt);
      }
      if (j.current) {
        const ids = Object.fromEntries(brainProviders.map((p) => [p.id, 1]));
        sel.value = j.current.provider in ids ? j.current.provider : 'custom';
        if (sel.value !== j.current.provider) sel.value = 'custom';
        $('brainModel').value = j.current.model || '';
        $('brainBaseUrl').value = j.current.baseUrl || '';
        $('brainActive').textContent = j.current.source === 'settings' ? `生效中 · ${j.current.model}` : `env 兜底 · ${j.current.model}`;
      } else {
        $('brainActive').textContent = '未配置（zcode 兜底）';
      }
      renderSavedConfigs(j.saved || [], j.activeId);
      syncBaseUrlRow();
    } catch { /* ignore */ }
  }
  function syncBaseUrlRow() {
    const p = brainProviders.find((x) => x.id === $('brainProvider').value);
    const custom = !p || p.id === 'custom';
    $('brainBaseUrlRow').style.display = custom ? 'flex' : 'none';
    if (!custom && !$('brainBaseUrl').dataset.touched) $('brainBaseUrl').value = p?.baseUrl || '';
    fillModelSuggestions(p?.models || [], p?.recommended);
  }
  function fillModelSuggestions(models, pick) {
    const dl = $('modelOptions');
    if (dl) {
      dl.innerHTML = '';
      for (const m of models) {
        const o = document.createElement('option');
        o.value = typeof m === 'string' ? m : m.id;
        dl.appendChild(o);
      }
    }
    if (pick && models.map((m) => (typeof m === 'string' ? m : m.id)).includes(pick)) $('brainModel').value = pick;
    else if (models.length && !$('brainModel').value) $('brainModel').value = typeof models[0] === 'string' ? models[0] : models[0].id;
  }
  /** 拉取到的模型渲染成可见的点击式卡片（datalist 下拉太隐蔽） */
  function renderModelChips(models) {
    const box = $('brainModelChips');
    if (!box) return;
    box.innerHTML = '';
    box.hidden = !models.length;
    for (const m of models) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip' + (m.id === $('brainModel').value ? ' on' : '');
      b.textContent = m.name ? `${m.id} · ${m.name}` : m.id;
      b.addEventListener('click', () => {
        $('brainModel').value = m.id;
        box.querySelectorAll('.chip').forEach((x) => x.classList.remove('on'));
        b.classList.add('on');
      });
      box.appendChild(b);
    }
  }
  $('brainProvider').addEventListener('change', () => {
    const p = brainProviders.find((x) => x.id === $('brainProvider').value);
    fillModelSuggestions(p?.models || [], p?.recommended);
    $('brainBaseUrl').dataset.touched = '';
    if (p?.baseUrl) $('brainBaseUrl').value = p.baseUrl;
    syncBaseUrlRow();
    if (p?.recommended) $('brainMsg').textContent = `推荐用 ${p.recommended}（电台场景：快且便宜；填好 Key 后可拉取全部可用模型）`;
  });
  $('btnBrainModels').addEventListener('click', async () => {
    const f = brainForm();
    if (!f.apiKey) { $('brainMsg').textContent = '先填 API Key 才能拉取模型列表'; return; }
    $('btnBrainModels').disabled = true;
    $('brainMsg').textContent = '拉取模型列表中…';
    try {
      const r = await fetch('/api/brain-config/models', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(f),
      });
      const j = await r.json();
      if (r.ok && j.ok) {
        renderModelChips(j.models);
        fillModelSuggestions(j.models, null);
        $('brainMsg').textContent = `✓ 拉到 ${j.models.length} 个可用模型，点选卡片即可使用`;
      } else {
        $('brainMsg').textContent = `✗ ${j.message || '拉取失败'}`;
      }
    } catch { $('brainMsg').textContent = '✗ 网络错误'; }
    $('btnBrainModels').disabled = false;
  });
  $('brainBaseUrl').addEventListener('input', () => { $('brainBaseUrl').dataset.touched = '1'; });
  function brainForm() {
    return {
      provider: $('brainProvider').value,
      model: $('brainModel').value.trim(),
      apiKey: $('brainKey').value.trim(),
      baseUrl: $('brainBaseUrl').value.trim(),
    };
  }
  $('btnBrainTest').addEventListener('click', async () => {
    const f = brainForm();
    if (!f.apiKey) { $('brainMsg').textContent = '先填 API Key 再测试'; return; }
    $('btnBrainTest').disabled = true;
    $('brainMsg').textContent = '测试中…';
    try {
      const r = await fetch('/api/brain-config/test', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(f),
      });
      const j = await r.json();
      $('brainMsg').textContent = j.ok
        ? `✓ 连接成功（${(j.latencyMs / 1000).toFixed(1)}s）`
        : `✗ ${j.detail || j.message || '连接失败'}`;
    } catch { $('brainMsg').textContent = '✗ 网络错误'; }
    $('btnBrainTest').disabled = false;
  });
  $('btnBrainSave').addEventListener('click', async () => {
    const f = brainForm();
    if (!f.model) { $('brainMsg').textContent = '模型名不能为空'; return; }
    $('btnBrainSave').disabled = true;
    try {
      const r = await fetch('/api/brain-config', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(f),
      });
      const j = await r.json();
      if (r.ok && j.ok) {
        $('brainMsg').textContent = '✓ 已保存并生效，下一轮播报即用新模型';
        $('brainKey').value = '';
        refreshBrainConfig();
        refreshHealth();
      } else {
        $('brainMsg').textContent = `✗ ${j.message || r.status}`;
      }
    } catch { $('brainMsg').textContent = '✗ 网络错误'; }
    $('btnBrainSave').disabled = false;
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
  $('btnRefreshHealth').addEventListener('click', refreshHealth);

  connectWs();
  refreshNow();
  renderQueue();
  setTheme((() => { try { return localStorage.getItem('claudiao.theme') || 'dark'; } catch { return 'dark'; } })());
  // 诊断钩子（只读）：浏览器控制台可查人声声道 WebAudio 状态
  window.__claudiaoAudio = () => ({ voiceCtx: voiceCtx ? voiceCtx.state : 'none', musicWave: 'procedural' });
})();

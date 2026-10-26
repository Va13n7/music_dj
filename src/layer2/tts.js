/**
 * Claudiao · TTS 编排层（M2-T2/T5，docs/04-tts-pipeline.md）
 *
 * 三级降级：edge-tts → SAPI → 抛 E_TTS_SAPI_FAIL（编排层置 say.skipped=true 进 MUSIC_ONLY）。
 * 缓存键 = sha1(voice|rate|pitch|text)[:16]（D-07：换音色即换键）；
 * 命中 <50ms 直接返回；LRU 淘汰（ttsMaxFiles/ttsMaxBytes）；SAPI 产物不进配额。
 * 合成队列：并发上限（默认 2），队列深度超限丢弃低优先级任务。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { EdgeTtsAdapter } from '../adapters/tts/edge-tts.js';
import { SapiTtsAdapter } from '../adapters/tts/sapi.js';

/** 缓存键 = sha1(voice|rate|pitch|text) 前 16 位（docs/04 §4） */
export function cacheKey({ voice, rate, pitch, text }) {
  const basis = [voice, rate, pitch, text].join('|');
  return crypto.createHash('sha1').update(basis, 'utf8').digest('hex').slice(0, 16);
}

export class TtsService {
  /**
   * @param {object} opts { ttsConfig(config.tts), root, log }
   */
  constructor({ ttsConfig, root, log } = {}) {
    this.cfg = ttsConfig;
    this.root = root;
    this.log = (log?.child?.('tts')) ?? log ?? console;
    this.edge = new EdgeTtsAdapter({ env: ttsConfig, log: this.log });
    this.sapi = new SapiTtsAdapter({ env: ttsConfig, log: this.log });
    this.cacheDir = path.isAbsolute(ttsConfig.cacheDir)
      ? ttsConfig.cacheDir : path.join(root, ttsConfig.cacheDir);
    this.sapiDir = path.join(this.cacheDir, '..', 'sapi-tmp');
    this.breaker = { failures: 0, openUntil: 0 };
    // 合成队列
    this.maxConcurrency = ttsConfig.concurrency ?? 2;
    this.maxQueue = 20;
    this._running = 0;
    this._queue = [];
    fs.mkdirSync(this.cacheDir, { recursive: true });
  }

  /** 对外音频 URL（Express 静态挂载 /tts → cacheDir） */
  _urlFor(file) {
    const base = path.basename(file);
    return `/tts/${base}`;
  }

  /**
   * 音色试音（选音色页用）：任意 voice 即时合成固定试听句，结果缓存。
   * @returns {Promise<{file:string, bytes:number, cached:boolean}>}
   */
  async preview(voice, pitch = '+0Hz') {
    if (!/^[A-Za-z0-9-]+$/.test(voice)) throw new Error('非法音色名');
    if (!/^[+-]?\d+Hz$/.test(pitch)) throw new Error('非法 pitch');
    const key = `preview-${voice}-${pitch}`;
    const file = path.join(this.cacheDir, 'samples', `${key}.mp3`);
    if (fs.existsSync(file) && fs.statSync(file).size > 512) {
      return { file, bytes: fs.statSync(file).size, cached: true };
    }
    const locale = voice.split('-')[0];
    const LINES = {
      zh: '你好，我是你的专属电台DJ，用这个声音为你播报。',
      en: 'Hey there — this is your radio DJ voice, on air all night long.',
      ja: 'こんばんは、あなたの専属ラジオDJです。',
      ko: '안녕하세요, 당신의 전용 라디오 DJ입니다.',
      de: 'Guten Abend, hier ist dein Radio-DJ.',
      fr: 'Bonsoir, je suis la voix de ta radio.',
      es: 'Buenas noches, soy la voz de tu radio.',
    };
    const text = LINES[locale] || LINES.en;
    const r = await this.edge.synthesize({ text, voice, pitch, outFile: file });
    return { file: r.file, bytes: r.bytes, cached: false };
  }

  /** edge-tts 全量音色清单（--list-voices 解析，进程内缓存） */
  async listVoices() {
    if (this._voices) return this._voices;
    const { spawn } = await import('node:child_process');
    const out = await new Promise((resolve, reject) => {
      const bin = this.cfg.edgeBin;
      if (!bin || !fs.existsSync(bin)) return reject(new Error('edge-tts 不可用'));
      const child = spawn(`"${bin}"`, ['--list-voices'], { shell: process.platform === 'win32', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      child.stdout.on('data', (d) => { stdout += d.toString(); });
      child.on('error', reject);
      child.on('close', (code) => (code === 0 ? resolve(stdout) : reject(new Error(`退出码 ${code}`))));
    });
    const voices = [];
    for (const line of out.split(/\r?\n/)) {
      const m = line.match(/^([A-Za-z]{2,3}-[A-Za-z]{2,10}-[A-Za-z]+Neural)\s+(Male|Female)\s*(.*)$/);
      if (m) voices.push({ name: m[1], gender: m[2], locale: m[1].split('-').slice(0, 2).join('-'), description: (m[3] || '').trim() });
    }
    this._voices = voices;
    return voices;
  }

  _cachedFile(key, engine) {
    const mp3 = path.join(this.cacheDir, `${key}.mp3`);
    if (fs.existsSync(mp3)) return mp3;
    if (engine === 'sapi') {
      const wav = path.join(this.sapiDir, `${key}.wav`);
      if (fs.existsSync(wav)) return wav;
    }
    return null;
  }

  /** LRU 淘汰：超出 ttsMaxFiles/ttsMaxBytes 时按 atime/mtime 最旧先删 */
  _evict() {
    let files;
    try { files = fs.readdirSync(this.cacheDir).filter((f) => f.endsWith('.mp3')); } catch { return; }
    const stats = files.map((f) => {
      const p = path.join(this.cacheDir, f);
      const st = fs.statSync(p);
      return { p, size: st.size, mtime: st.mtimeMs };
    });
    let total = stats.reduce((a, s) => a + s.size, 0);
    const maxBytes = this.cfg.cacheMaxBytes ?? 524288000;
    const maxFiles = this.cfg.cacheMaxFiles ?? 2000;
    if (stats.length <= maxFiles && total <= maxBytes) return;
    stats.sort((a, b) => a.mtime - b.mtime);
    for (const s of stats) {
      if (stats.length - 0 <= maxFiles && total <= maxBytes) break;
      try { fs.rmSync(s.p, { force: true }); total -= s.size; } catch { /* ignore */ }
    }
  }

  /**
   * 合成（带缓存与三级降级）。
   * @param {object} req { text, voice?, rate?, pitch?, volume?, priority? }
   * @returns {Promise<{audioUrl:string, file:string, mime:string, engine:string, cached:boolean, bytes:number, skipped:false}>}
   * @throws {Error} code=E_TTS_SAPI_FAIL（两级都失败，编排层降级到跳过语音）
   */
  async synthesize(req) {
    const text = String(req.text ?? '').trim();
    if (!text) throw Object.assign(new Error('空文本'), { code: 'E_TTS_SAPI_FAIL' });
    const voice = req.voice || this.cfg.voice || 'zh-CN-XiaoxiaoNeural';
    const rate = req.rate || this.cfg.rate || '+0%';
    const pitch = req.pitch || this.cfg.pitch || '+0Hz';
    const key = cacheKey({ voice, rate, pitch, text });

    // 1) 缓存命中（mp3 主缓存；SAPI wav 按引擎标记命中）
    const hitMp3 = this._cachedFile(key, 'edge');
    if (hitMp3) {
      return { audioUrl: this._urlFor(hitMp3), file: hitMp3, mime: 'audio/mpeg', engine: 'edge-tts', cached: true, bytes: fs.statSync(hitMp3).size, skipped: false };
    }
    const hitWav = this._cachedFile(key, 'sapi');
    if (hitWav) {
      return { audioUrl: this._urlFor(hitWav), file: hitWav, mime: 'audio/wav', engine: 'sapi', cached: true, bytes: fs.statSync(hitWav).size, skipped: false };
    }

    // 2) 排队合成
    const job = { key, text, voice, rate, pitch, volume: req.volume, priority: req.priority };
    return new Promise((resolve, reject) => {
      const isPrefetch = req.priority === 'prefetch';
      if (this._queue.length >= this.maxQueue) {
        if (isPrefetch) return reject(Object.assign(new Error('队列满，丢弃 prefetch'), { code: 'E_TTS_QUEUE_FULL' }));
        // 非 prefetch：挤掉队尾的 prefetch
        const pi = this._queue.findIndex((j) => j.priority === 'prefetch');
        if (pi >= 0) {
          const [dropped] = this._queue.splice(pi, 1);
          dropped.reject(Object.assign(new Error('队列满，被高优先级挤掉'), { code: 'E_TTS_QUEUE_FULL' }));
        } else {
          return reject(Object.assign(new Error('TTS 队列满'), { code: 'E_TTS_QUEUE_FULL' }));
        }
      }
      this._queue.push({ ...job, resolve, reject });
      this._drain();
    });
  }

  _drain() {
    while (this._running < this.maxConcurrency && this._queue.length) {
      const job = this._queue.shift();
      this._running++;
      this._synthesizeNow(job).then(job.resolve, job.reject).finally(() => {
        this._running--;
        this._drain();
      });
    }
  }

  async _synthesizeNow(job) {
    const outFile = path.join(this.cacheDir, `${job.key}.mp3`);
    const started = Date.now();

    // 熔断打开 → 直接 SAPI（docs/04 §3.3）
    if (this.cfg.fallbackEnabled !== false && Date.now() < this.breaker.openUntil) {
      return this._viaSapi(job);
    }

    // 3) edge-tts
    try {
      const r = await this.edge.synthesize({ ...job, outFile });
      this.breaker.failures = 0;
      this._evict();
      this.log.info?.('edge-tts 合成完成', { key: job.key, bytes: r.bytes, ms: Date.now() - started });
      return { audioUrl: this._urlFor(outFile), file: outFile, mime: 'audio/mpeg', engine: 'edge-tts', cached: false, bytes: r.bytes, skipped: false };
    } catch (edgeErr) {
      this.log.warn?.('edge-tts 失败，尝试 SAPI', { key: job.key, code: edgeErr.code, error: edgeErr.message });
      this.breaker.failures += 1;
      if (this.breaker.failures >= (this.cfg.breakerThreshold ?? 3)) {
        this.breaker.openUntil = Date.now() + 5 * 60 * 1000;
        this.log.warn?.('edge-tts 连续失败，熔断 5 分钟', { failures: this.breaker.failures });
      }
      // 4) 同请求内立即回落 SAPI
      if (this.cfg.fallbackEnabled !== false) {
        try { return await this._viaSapi(job); } catch (sapiErr) { edgeErr.cause = sapiErr; }
      } else {
        edgeErr.cause = new Error('SAPI 兜底已禁用（TTS_FALLBACK_ENABLED=0）');
      }
      throw Object.assign(new Error(`TTS 两级均失败: ${edgeErr.message}`), { code: 'E_TTS_SAPI_FAIL', cause: edgeErr.cause });
    }
  }

  async _viaSapi(job) {
    const r = await this.sapi.synthesize({ text: job.text, outFile: path.join(this.sapiDir, `${job.key}.wav`) });
    this.log.info?.('SAPI 兜底合成', { key: job.key, bytes: r.bytes });
    return { audioUrl: this._urlFor(r.file), file: r.file, mime: 'audio/wav', engine: 'sapi', cached: false, bytes: r.bytes, skipped: false };
  }
}

/** 离线单测/E2E 用的假适配器（M2-T4）：固定字节，零 spawn */
export class FakeTtsAdapter {
  constructor() {
    this.name = 'fake';
    this.calls = [];
  }
  async synthesize(req) {
    this.calls.push(req.text);
    return {
      audioUrl: `/tts/fake-${this.calls.length}.mp3`,
      file: `/tmp/fake-${this.calls.length}.mp3`,
      mime: 'audio/mpeg',
      engine: this.name,
      cached: false,
      bytes: 42,
      skipped: false,
    };
  }
}

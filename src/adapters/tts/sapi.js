/**
 * Claudiao · TTS 适配器 · Windows SAPI 兜底（M2-T3）
 *
 * docs/04-tts-pipeline.md §2：spawn powershell -NoProfile -NonInteractive，
 * 文本经 stdin UTF-8 传入（杜绝引号注入），System.Speech 合成 WAV。
 * 唯一中文音色 Microsoft Huihui Desktop；超时 5s；并发 1（非线程安全）。
 * 产物 WAV 写 sapi-tmp/，不进 LRU 配额（docs/04 §6）。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const SCRIPT = `
$text = [Console]::In.ReadToEnd()
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$s.SelectVoice('__VOICE__')
$s.Rate = __RATE__
$s.SetOutputToWaveFile('__OUT__')
$s.Speak($text)
$s.Dispose()
Write-Output 'OK'
`;

export class SapiTtsAdapter {
  /** @param {object} opts { env, log }  env: sapiVoice */
  constructor({ env, log } = {}) {
    this.env = env || {};
    this.log = log || (() => {});
    this.name = 'sapi';
    this.voice = env.sapiVoice || 'Microsoft Huihui Desktop';
  }

  /** 探测：GetInstalledVoices 中 zh-CN 计数 ≥1（docs/04 §2 探测行） */
  async available() {
    const script = "Add-Type -AssemblyName System.Speech; " +
      "(New-Object System.Speech.Synthesis.SpeechSynthesizer).GetInstalledVoices() | " +
      "ForEach-Object { $_.VoiceInfo.Name + '|' + $_.VoiceInfo.Culture }";
    try {
      const out = await this._powershell(script, 5000);
      return out.includes('zh-CN');
    } catch {
      return false;
    }
  }

  _powershell(script, timeoutMs) {
    return new Promise((resolve, reject) => {
      const child = spawn('powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', script],
        { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      let out = '', err = '';
      child.stdout.on('data', (d) => { out += d.toString(); });
      child.stderr.on('data', (d) => { err += d.toString(); });
      const t = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* ignore */ }
        reject(Object.assign(new Error('powershell 超时'), { code: 'E_TTS_TIMEOUT' }));
      }, timeoutMs);
      child.on('error', (e) => { clearTimeout(t); e.code = 'E_TTS_FAIL'; reject(e); });
      child.on('close', (code) => {
        clearTimeout(t);
        if (code === 0) resolve(out);
        else reject(Object.assign(new Error(`powershell 退出码 ${code}: ${err.split('\n')[0]}`), { code: 'E_TTS_FAIL' }));
      });
    });
  }

  /**
   * 合成 WAV。文本走 stdin；脚本里替换音色/输出路径（不含用户文本，无注入面）。
   * @returns {Promise<{file:string, bytes:number, engine:'sapi'}>}
   */
  synthesize(req) {
    const text = String(req.text ?? '').trim();
    if (!text) { const e = new Error('空文本'); e.code = 'E_TTS_FAIL'; throw e; }
    const out = req.outFile.replace(/\.mp3$/, '.wav');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const script = SCRIPT
      .replace('__VOICE__', this.voice.replace(/'/g, "''"))
      .replace('__RATE__', '-1')
      .replace('__OUT__', out.replace(/'/g, "''"));
    return new Promise((resolve, reject) => {
      const child = spawn('powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', script],
        { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true });
      let err = '';
      child.stderr.on('data', (d) => { err += d.toString(); });
      child.stdin.write(text, 'utf8');
      child.stdin.end();
      const t = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* ignore */ }
        reject(Object.assign(new Error('SAPI 超时（5s）'), { code: 'E_TTS_TIMEOUT' }));
      }, 5000);
      child.on('error', (e) => { clearTimeout(t); e.code = 'E_TTS_FAIL'; reject(e); });
      child.on('close', (code) => {
        clearTimeout(t);
        const okFile = fs.existsSync(out) && fs.statSync(out).size > 1024;
        if (code === 0 && okFile) {
          resolve({ file: out, bytes: fs.statSync(out).size, engine: this.name });
        } else {
          try { fs.rmSync(out, { force: true }); } catch { /* ignore */ }
          reject(Object.assign(new Error(`SAPI 失败(code=${code})${err ? ': ' + err.split('\n')[0] : ''}`), { code: 'E_TTS_FAIL' }));
        }
      });
    });
  }
}

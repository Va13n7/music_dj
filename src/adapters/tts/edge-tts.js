/**
 * Claudiao · TTS 适配器 · edge-tts（M2-T1）
 *
 * docs/04-tts-pipeline.md §2：spawn edge-tts.exe，
 *   --voice <v> --rate <r> --pitch <p> --volume <vol> --text <t> --write-media <out.mp3>
 * 超时 8s（>120 字放宽到 12s）；产物 mp3。文本走参数（tts-warm 已验证该形态稳定），
 * 写入临时文件后原子 rename 到目标，避免半截文件进缓存。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export class EdgeTtsAdapter {
  /**
   * @param {object} opts { env, log }
   * env 使用 config.tts 的字段：edgeBin/voice/rate/volume/pitch/timeoutMs
   */
  constructor({ env, log } = {}) {
    this.env = env || {};
    this.log = log || (() => {});
    this.name = 'edge-tts';
    this.timeoutMs = env.timeoutMs || 15000;
  }

  available() {
    const bin = this.env.edgeBin;
    return Boolean(bin && fs.existsSync(bin));
  }

  /**
   * 合成一段文本。
   * @param {object} req { text, voice?, rate?, pitch?, volume?, outFile }
   * @returns {Promise<{file:string, bytes:number, engine:'edge-tts', cached?:undefined}>}
   * @throws {Error} code ∈ E_TTS_TIMEOUT | E_TTS_FAIL（可降级错误）
   */
  synthesize(req) {
    const text = String(req.text ?? '').trim();
    if (!text) {
      const e = new Error('空文本'); e.code = 'E_TTS_FAIL'; throw e;
    }
    const bin = this.env.edgeBin;
    if (!this.available()) {
      const e = new Error(`edge-tts 不存在: ${bin || '(未配置 CLAUDIAO_EDGE_TTS_BIN)'}`);
      e.code = 'E_TTS_FAIL';
      throw e;
    }
    // 超时：基准 15s（含英文/冷启动网络握手），>120 字放宽 20s；不超过配置上限
    const base = text.length > 120 ? 20000 : 15000;
    const timeout = Math.min(Math.max(this.timeoutMs, base), base + 5000);
    const out = req.outFile;
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const tmp = `${out}.tmp-${process.pid}-${Date.now()}`;
    // 文本走 --file：Windows shell:true 下 argv 不转义，文本含 ASCII 空格/引号会裂成多个参数
    const txtFile = `${out}.txt-${process.pid}-${Date.now()}`;
    fs.writeFileSync(txtFile, text, 'utf8');

    return new Promise((resolve, reject) => {
      // rate/pitch/volume 用 = 形式传：负值（如 --pitch -12Hz）会被 argparse 当成选项
      const args = [
        '--voice', req.voice || this.env.voice || 'zh-CN-XiaoxiaoNeural',
        `--rate=${req.rate || this.env.rate || '+0%'}`,
        `--pitch=${req.pitch || this.env.pitch || '+0Hz'}`,
        `--volume=${req.volume || this.env.volume || '+0%'}`,
        '--file', txtFile,
        '--write-media', tmp,
      ];
      const child = spawn(`"${bin}"`, args, {
        shell: process.platform === 'win32',
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true,
      });
      let stderr = '';
      child.stderr.on('data', (d) => { stderr += d.toString(); });
      const timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* ignore */ }
        try { fs.rmSync(tmp, { force: true }); fs.rmSync(txtFile, { force: true }); } catch { /* ignore */ }
        const e = new Error(`edge-tts 超时（>${timeout}ms）`);
        e.code = 'E_TTS_TIMEOUT';
        reject(e);
      }, timeout);
      child.on('error', (e) => {
        clearTimeout(timer);
        try { fs.rmSync(tmp, { force: true }); fs.rmSync(txtFile, { force: true }); } catch { /* ignore */ }
        e.code = 'E_TTS_FAIL';
        reject(e);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        try { fs.rmSync(txtFile, { force: true }); } catch { /* ignore */ }
        const okFile = fs.existsSync(tmp) && fs.statSync(tmp).size > 512;
        if (code === 0 && okFile) {
          fs.renameSync(tmp, out);
          resolve({ file: out, bytes: fs.statSync(out).size, engine: this.name });
        } else {
          try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
          const e = new Error(`edge-tts 退出码 ${code}${stderr ? `: ${stderr.split('\n')[0]}` : ''}`);
          e.code = 'E_TTS_FAIL';
          reject(e);
        }
      });
    });
  }
}

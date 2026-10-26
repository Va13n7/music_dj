/**
 * Claudiao · WS /stream 广播中心（M5-T3）
 *
 * - 心跳 25s（ping/pong，客户端无 pong 视为断连由 ws 库清理）
 * - 事件统一信封：{ type, seq, ts, data }；seq 单调递增（客户端断线重连幂等）
 * - 事件类型：now-playing / state-change / queue-update / heartbeat / error
 * - 无客户端时 broadcast 不抛错
 */
import { WebSocketServer } from 'ws';

export class WsHub {
  constructor({ server, path = '/stream', heartbeatSeconds = 25, log } = {}) {
    this.log = log || console;
    this.seq = 0;
    this.clients = new Set();
    this.wss = new WebSocketServer({ server, path });
    this.wss.on('connection', (ws) => {
      this.clients.add(ws);
      ws.isAlive = true;
      ws.on('pong', () => { ws.isAlive = true; });
      ws.on('close', () => this.clients.delete(ws));
      ws.on('error', () => this.clients.delete(ws));
      ws.send(JSON.stringify(this._envelope('hello', { hint: '已连接 /stream' })));
    });
    this._heartbeat = setInterval(() => {
      for (const ws of this.clients) {
        if (ws.isAlive === false) { try { ws.terminate(); } catch { /* ignore */ } this.clients.delete(ws); continue; }
        ws.isAlive = false;
        try { ws.ping(); } catch { /* ignore */ }
      }
    }, heartbeatSeconds * 1000);
  }

  _envelope(type, data) {
    return { type, seq: ++this.seq, ts: new Date().toISOString(), data };
  }

  /** 广播事件；data 可为对象。无客户端静默忽略。 */
  broadcast(type, data) {
    if (!this.clients.size) return;
    const msg = JSON.stringify(this._envelope(type, data));
    for (const ws of this.clients) {
      try { if (ws.readyState === 1) ws.send(msg); } catch { /* ignore */ }
    }
  }

  clientCount() { return this.clients.size; }

  close() {
    clearInterval(this._heartbeat);
    for (const ws of this.clients) { try { ws.terminate(); } catch { /* ignore */ } }
    this.clients.clear();
    try { this.wss.close(); } catch { /* ignore */ }
  }
}

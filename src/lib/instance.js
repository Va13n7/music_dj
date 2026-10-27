/**
 * 单实例接管：新实例启动前自动结束上一个电台后端。
 *
 * 依据 data/runtime/server.lock（pid）；锁缺失/失效时回退 netstat 找端口占用者。
 * 只有确认对方是 node 进程才会终止（避免误杀恰好占用同端口的其他程序）；
 * 端口被非 node 程序占用时抛错并给出明确指引。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const isWin = process.platform === 'win32';

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** 进程映像名（win: tasklist / 其他: ps），用于确认"是自家 node"才动手 */
function pidImage(pid) {
  try {
    if (isWin) {
      const r = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8' });
      const line = (r.stdout || '').split(/\r?\n/).find((l) => l.trim() && !/^(信息|INFO)/i.test(l.trim()));
      return line ? line.split('","')[0].replace(/^"/, '') : '';
    }
    const r = spawnSync('ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf8' });
    return (r.stdout || '').trim();
  } catch { return ''; }
}

function looksLikeOurs(pid) {
  return (pidImage(pid) || '').toLowerCase().includes('node');
}

function killPid(pid) {
  if (isWin) spawnSync('taskkill', ['/PID', String(pid), '/F'], { encoding: 'utf8' });
  else process.kill(pid, 'SIGTERM');
}

function waitForGone(pid, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) return true;
    const sleep = isWin ? 200 : 200;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, sleep);
  }
  return !pidAlive(pid);
}

/** 占用指定端口的所有 LISTENING 进程 pid（win: netstat -ano） */
function portOccupierPids(port) {
  if (!isWin) return [];
  try {
    const r = spawnSync('netstat', ['-ano'], { encoding: 'utf8' });
    const pids = new Set();
    for (const line of (r.stdout || '').split(/\r?\n/)) {
      if (!line.includes('LISTENING')) continue;
      const cols = line.trim().split(/\s+/);
      const local = cols[1] || '';
      if (local.endsWith(`:${port}`)) pids.add(Number(cols[cols.length - 1]));
    }
    return [...pids].filter(Number.isFinite);
  } catch { return []; }
}

/**
 * 启动前接管：结束旧实例并写入新锁。
 * @returns {{ killedPrevious: number|null, lockPath: string }}
 */
export function takeOverInstance({ root, port, log }) {
  const lockPath = path.join(root, 'data', 'runtime', 'server.lock');
  const me = process.pid;
  let killed = null;

  // ① 锁文件：上一实例的 pid
  try {
    if (fs.existsSync(lockPath)) {
      const { pid } = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      if (pid && pid !== me && pidAlive(pid)) {
        if (looksLikeOurs(pid)) {
          killPid(pid);
          waitForGone(pid);
          killed = pid;
          log.info?.(`单实例接管：已结束旧实例 (PID ${pid})`);
        } else {
          log.warn?.(`锁文件指向存活进程 (PID ${pid})，但不是 node，跳过接管`);
        }
      }
    }
  } catch { /* 锁损坏则忽略，走端口兜底 */ }

  // ② 端口兜底：锁缺失/失效但端口仍被占
  for (const pid of portOccupierPids(port)) {
    if (pid === me || !pidAlive(pid)) continue;
    if (!looksLikeOurs(pid)) {
      throw new Error(`端口 ${port} 被其他程序占用（PID ${pid}，非电台实例）。请关闭它，或用 RADIO_PORT 换端口。`);
    }
    killPid(pid);
    waitForGone(pid);
    killed = pid;
    log.info?.(`单实例接管：已结束占用端口 ${port} 的旧实例 (PID ${pid})`);
  }

  // ③ 写新锁
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, JSON.stringify({ pid: me, startedAt: new Date().toISOString() }, null, 2));
  return { killedPrevious: killed, lockPath };
}

/** 清除实例锁（优雅退出时调用；异常退出留下的旧锁会在下次启动时按存活校验自动处理） */
export function clearInstanceLock(root) {
  try { fs.rmSync(path.join(root, 'data', 'runtime', 'server.lock'), { force: true }); } catch { /* ignore */ }
}

/** 主动停止：结束锁文件指向的电台后端（npm run stop 用）。返回 { ok, pid, reason } */
export function stopRunningInstance(root) {
  const lockPath = path.join(root, 'data', 'runtime', 'server.lock');
  let pid = null;
  try { pid = JSON.parse(fs.readFileSync(lockPath, 'utf8')).pid ?? null; } catch { /* 无锁 */ }
  if (!pid || !Number.isFinite(pid)) return { ok: false, reason: '没有找到运行中的电台（无实例锁）' };
  if (pid === process.pid) return { ok: false, reason: '锁指向当前进程，忽略' };
  if (!pidAlive(pid)) { clearInstanceLock(root); return { ok: false, reason: `锁中的 PID ${pid} 已不在运行（已清理旧锁）` }; }
  if (!looksLikeOurs(pid)) return { ok: false, reason: `PID ${pid} 不是 node 进程，拒绝终止` };
  killPid(pid);
  const gone = waitForGone(pid);
  clearInstanceLock(root);
  return gone ? { ok: true, pid } : { ok: false, reason: `PID ${pid} 终止超时` };
}

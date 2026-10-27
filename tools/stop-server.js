/**
 * npm run stop —— 结束正在运行的电台后端。
 * 依据 data/runtime/server.lock，带 node 进程校验（不会误杀其他程序）。
 */
import path from 'node:path';
import process from 'node:process';
import { stopRunningInstance } from '../src/lib/instance.js';

const root = process.cwd();
const r = stopRunningInstance(root);
if (r.ok) {
  console.log(`已结束电台后端 (PID ${r.pid})`);
} else {
  console.log(`未执行：${r.reason}`);
  process.exitCode = 1;
}

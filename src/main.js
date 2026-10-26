/**
 * Claudiao · 服务入口（npm start）
 *
 * 组装全部依赖：config → logger → state → music → tts → brain → compute →
 * server(6 条 API + WS) → scheduler(节律) → calendar → planner。
 * 优雅退出：SIGINT/SIGTERM 关调度、关大脑子进程、关库。
 */
import path from 'node:path';
import { loadConfig, parseDotEnvFile } from './lib/config.js';
import { createLogger } from './lib/log.js';
import { StateStore } from './layer2/state.js';
import { ZcodeAgentAdapter } from './adapters/brain/zcode-agent.js';
import { BrainService } from './layer2/brain.js';
import { templateAction } from './layer2/fallback-templates.js';
import { MusicProviderFacade } from './providers/music/index.js';
import { TtsService } from './layer2/tts.js';
import { ComputeService } from './layer2/compute.js';
import { Scheduler } from './layer2/scheduler.js';
import { Planner } from './layer2/planner.js';
import { CalendarProvider } from './providers/calendar.js';
import { createServer } from './server.js';

const config = loadConfig();
const log = createLogger({
  root: config.root, level: config.log.level, dir: config.log.dir,
  maxFiles: config.log.maxFiles, logPrompt: config.log.logPrompt, console: true,
});
if (config.log.logPrompt) {
  log.warn('LOG_PROMPT=1：prompt 全文将写入日志（含隐私语料），仅调试时使用');
}

log.info('配置已装载', { brain: config.brain.adapter, model: config.brain.model, tz: config.tz });

// ---------- 依赖组装 ----------
const state = new StateStore(path.join(config.root, config.dbPath), { logger: log });
log.info('状态库已就绪', { dbPath: config.dbPath });

const dotEnv = parseDotEnvFile(path.join(config.root, 'config', '.env'));
const brainAdapter = new ZcodeAgentAdapter({ root: config.root, env: dotEnv, log });
const brain = new BrainService({
  adapter: brainAdapter,
  env: { timeoutMs: config.brain.timeoutMs, retry: config.brain.retry },
  log,
  fallbackTemplate: (ctx) => templateAction({ reason: ctx.reason, playlistsDir: path.join(config.root, 'knowledge', 'user') }),
});
log.info('大脑依赖就绪', { missing: brainAdapter.availabilityDetail() });

const music = new MusicProviderFacade({ env: dotEnv, log });
const tts = new TtsService({ ttsConfig: config.tts, root: config.root, log });
const calendar = new CalendarProvider({ calendarYml: config.calendar, config, state, log });

let hubRef = null;
const compute = new ComputeService({
  config, brain, music, tts, state, log,
  calendarText: () => calendar.injectionText(),
  onBroadcast: (b) => hubRef?.broadcast('now-playing', b),
  onControl: (action) => hubRef?.broadcast('control', { action }),
  onEvent: (type, data) => hubRef?.broadcast(type, data),
});

// ---------- HTTP + WS ----------
const { server, hub } = createServer({
  config, compute, state, brain, music, tts,
  env: dotEnv, brainAdapter,
  log,
  corpusHashFn: () => {
    // 延迟 import 避免循环依赖
    return import('./layer2/context.js').then(({ corpusHash }) => corpusHash(path.join(config.root, 'knowledge')));
  },
  playback: { index: 0 },
});
hubRef = hub;
log.info('HTTP + WS 已就绪', { port: config.server.port, host: config.server.host });

// ---------- 节律 ----------
const planner = new Planner({ config, state, music, tts, log });
const scheduler = new Scheduler({ config, compute, state, log, calendar });

// 启动时：生成当日规划（幂等）+ 启动节律
// （"电台已开播"日志由 server.js 在 listen 成功回调里打印——listen 失败时不再误导）
planner.buildDailyPlan().catch((e) => log.warn?.('当日规划失败（不阻塞）', { error: e.message }));
scheduler.start();
if (compute.restoreRoaming()) log.info('无限漫游已恢复（上次开启状态）');

// ---------- 优雅退出 ----------
let closing = false;
function shutdown(signal) {
  if (closing) return;
  closing = true;
  log.info(`收到 ${signal}，正在关闭…`);
  try { scheduler.stop(); } catch { /* ignore */ }
  try { hub.close(); } catch { /* ignore */ }
  try { server.close(); } catch { /* ignore */ }
  try { brain.close(); } catch { /* ignore */ }
  try { state.close(); } catch { /* ignore */ }
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

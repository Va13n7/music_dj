/**
 * M0-T1 验收单测 —— src/lib/config.js
 *
 * 验收标准（docs/10 M0-T1）：
 *   - 缺 .env 时给出可读错误
 *   - 非法 TTS_ENGINE 被拒
 *   - import 后 loadConfig 成功
 * 附加：类型/枚举/范围校验、yml 结构校验、冻结、问题一次性全报。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, ConfigError } from '../../src/lib/config.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');

function tmpProject({ withEnv = true, withYml = true, envContent = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudiao-cfg-'));
  fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
  if (withEnv) {
    fs.writeFileSync(path.join(dir, 'config', '.env'),
      envContent ?? 'HOST=127.0.0.1\nPORT=8080\nTTS_ENGINE=edge\n');
  }
  if (withYml) {
    // 从真实仓库复制三份 yml，保证结构合法
    for (const f of ['radio.yml', 'routines.yml', 'calendar.yml']) {
      const src = path.join(import.meta.dirname, '..', '..', 'config', f);
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dir, 'config', f));
    }
  }
  return dir;
}

test('真实仓库配置可装载且冻结', () => {
  const cfg = loadConfig({ root: REPO_ROOT });
  assert.equal(cfg.tts.engine, 'edge');
  assert.ok(cfg.brain.timeoutMs >= 5000);
  assert.ok(cfg.routines.slots.length >= 8, 'routines.yml 应有 8 个 slot');
  assert.ok(Object.isFrozen(cfg));
  assert.ok(Object.isFrozen(cfg.brain));
  assert.ok(Object.isFrozen(cfg.routines));
  // 修改被冻结对象（非严格模式下静默失败，严格模式下抛错——两种都算冻结生效）
  const before = cfg.tts.voice;
  try { cfg.tts.voice = 'hacked'; } catch { /* 严格模式 */ }
  assert.equal(cfg.tts.voice, before);
});

test('缺 .env → 可读错误并指出修复命令', () => {
  const dir = tmpProject({ withEnv: false });
  try {
    loadConfig({ root: dir });
    assert.fail('应当抛 ConfigError');
  } catch (e) {
    assert.ok(e instanceof ConfigError);
    assert.match(e.message, /\.env/);
    assert.match(e.message, /Copy-Item/);
  }
});

test('非法 TTS_ENGINE 被拒', () => {
  const dir = tmpProject({ envContent: 'TTS_ENGINE=doubao\n' });
  assert.throws(() => loadConfig({ root: dir }), (e) => {
    return e instanceof ConfigError && /TTS_ENGINE/.test(e.message) && /edge\/sapi/.test(e.message);
  });
});

test('PORT 非数字被拒；负超时被拒', () => {
  let dir = tmpProject({ envContent: 'PORT=abc\n' });
  assert.throws(() => loadConfig({ root: dir }), /PORT/);
  dir = tmpProject({ envContent: 'BRAIN_TIMEOUT_MS=-5\n' });
  assert.throws(() => loadConfig({ root: dir }), /BRAIN_TIMEOUT_MS/);
});

test('缺 yml → 报缺失文件名', () => {
  const dir = tmpProject({ withYml: false });
  try {
    loadConfig({ root: dir });
    assert.fail('应当抛 ConfigError');
  } catch (e) {
    assert.ok(e instanceof ConfigError);
    assert.match(e.message, /radio\.yml/);
    assert.match(e.message, /routines\.yml/);
  }
});

test('所有问题一次性全报（不挤牙膏）', () => {
  const dir = tmpProject({ envContent: 'TTS_ENGINE=x\nPORT=99999\n' });
  try {
    loadConfig({ root: dir });
    assert.fail('应当抛 ConfigError');
  } catch (e) {
    assert.equal(e.problems.length, 2, `应报 2 个问题，实际 ${e.problems.length}: ${e.message}`);
  }
});

test('HOST 非 127.0.0.1 且无令牌 → 拒绝', () => {
  const dir = tmpProject({ envContent: 'HOST=0.0.0.0\n' });
  assert.throws(() => loadConfig({ root: dir }), /RADIO_AUTH_TOKEN/);
});

test('routines.yml 非法 cron / 重复 slot 名被拒', () => {
  const dir = tmpProject({});
  const p = path.join(dir, 'config', 'routines.yml');
  const original = fs.readFileSync(p, 'utf8');
  fs.writeFileSync(p, original.replace('cron: "0 9 * * *"', 'cron: "每天九点"'));
  assert.throws(() => loadConfig({ root: dir }), /cron/);

  fs.writeFileSync(p, original.replace('- name: noon', '- name: morning\n    cron: "0 13 * * *"\n  - name: noon'));
  assert.throws(() => loadConfig({ root: dir }), /slot 名重复/);
});

test('默认值生效（只给最小 .env）', () => {
  const dir = tmpProject({ envContent: 'HOST=127.0.0.1\nPORT=8080\n' });
  const cfg = loadConfig({ root: dir });
  assert.equal(cfg.tts.voice, 'zh-CN-XiaoxiaoNeural');
  assert.equal(cfg.brain.reasoning, 'low');
  assert.equal(cfg.log.level, 'info');
  assert.equal(cfg.music.minIntervalMs, 1200);
});

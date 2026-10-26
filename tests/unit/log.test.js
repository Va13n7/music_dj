/**
 * M0-T2 验收单测 —— src/lib/log.js
 *
 * 验收标准（docs/10 M0-T2）：
 *   - LOG_PROMPT=0 时输出中不含输入明文
 *   - 轮转保留 maxFiles 个文件
 * 附加：分级过滤、child 模块标签、超长 extra 截断、promptDigest。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLogger, promptDigest } from '../../src/lib/log.js';

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'claudiao-log-'));
}

test('LOG_PROMPT=0：prompt 全文不落盘，只有长度与 hash', () => {
  const root = tmpRoot();
  const log = createLogger({ root, level: 'debug', dir: 'data/logs', console: false });
  const secret = '今天下雨了，来点安静的，顺便放我最私人的歌单';
  log.prompt(secret, 'test');
  const content = fs.readFileSync(log._file(), 'utf8');
  assert.ok(!content.includes(secret), '明文不得出现在日志中');
  assert.match(content, /"chars":\d+/);
  assert.match(content, /"sha1":"[0-9a-f]{16}"/);
});

test('LOG_PROMPT=1：prompt 明文落盘（并带告警语义的字段）', () => {
  const root = tmpRoot();
  const log = createLogger({ root, level: 'debug', dir: 'data/logs', console: false, logPrompt: true });
  const secret = '明文测试句';
  log.prompt(secret, 'test');
  const content = fs.readFileSync(log._file(), 'utf8');
  assert.ok(content.includes(secret));
});

test('分级过滤：level=warn 时 debug/info 不落盘', () => {
  const root = tmpRoot();
  const log = createLogger({ root, level: 'warn', dir: 'data/logs', console: false });
  log.debug('debug 行');
  log.info('info 行');
  log.warn('warn 行');
  log.error('error 行');
  const content = fs.readFileSync(log._file(), 'utf8');
  assert.ok(!content.includes('debug 行'));
  assert.ok(!content.includes('info 行'));
  assert.ok(content.includes('warn 行'));
  assert.ok(content.includes('error 行'));
});

test('child 记录带模块标签', () => {
  const root = tmpRoot();
  const log = createLogger({ root, dir: 'data/logs', console: false });
  log.child('brain').info('会话建立');
  const rec = JSON.parse(fs.readFileSync(log._file(), 'utf8').trim());
  assert.equal(rec.module, 'brain');
  assert.equal(rec.msg, '会话建立');
});

test('轮转：超过 maxFiles 的旧日志被删除', () => {
  const root = tmpRoot();
  const dir = path.join(root, 'data', 'logs');
  fs.mkdirSync(dir, { recursive: true });
  // 伪造 3 个旧文件 + 垃圾文件（不应被删）
  for (const d of ['2026-01-01', '2026-01-02', '2026-01-03']) {
    fs.writeFileSync(path.join(dir, `app-${d}.log`), 'old\n');
  }
  fs.writeFileSync(path.join(dir, 'not-a-log.txt'), 'keep me');
  const log = createLogger({ root, dir: 'data/logs', maxFiles: 2, console: false });
  log.info('今天的行');
  const left = fs.readdirSync(dir).sort();
  assert.ok(!left.includes('app-2026-01-01.log'), '最旧的应被删');
  assert.equal(left.filter((f) => /^app-/.test(f)).length, 2, '应保留 2 个日志文件');
  assert.ok(left.includes('not-a-log.txt'), '非日志文件不删');
});

test('超长 extra 字符串被截断（防 prompt 从 extra 侧漏）', () => {
  const root = tmpRoot();
  const log = createLogger({ root, dir: 'data/logs', console: false });
  const big = 'x'.repeat(20000);
  log.info('带大 extra', { big });
  const content = fs.readFileSync(log._file(), 'utf8');
  assert.ok(content.length < 30000, '不应全量落盘');
  assert.match(content, /\+\d+\)/);
});

test('promptDigest：开启 full 才有明文', () => {
  const d1 = promptDigest('abc');
  assert.deepEqual(Object.keys(d1).sort(), ['chars', 'sha1']);
  const d2 = promptDigest('abc', { full: true });
  assert.equal(d2.text, 'abc');
  assert.equal(d1.sha1, d2.sha1);
});

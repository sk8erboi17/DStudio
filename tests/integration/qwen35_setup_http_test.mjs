// Real launcher HTTP + native incremental build. Requires a fresh acceptance
// installation with main and qwen35; no model weights or inference are used.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { freePort, sleep, csrfHeaders } from '../support/real_harness.mjs';

assert.ok(process.argv[2], 'pass the fresh-install directory from engine_acceptance --setup');
const root = fs.realpathSync(process.argv[2]);
const main = path.join(root, 'ds4');
const qwen = path.join(root, 'ds4-qwen35');
for (const dir of [main, qwen]) assert.ok(fs.existsSync(path.join(dir, '.dstudio-source.json')));
assert.deepEqual(fs.readdirSync(path.join(main, 'gguf')), [], 'use a test installation without real model weights');
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const source = path.join(qwen, 'ds4.c');
const before = hash(source);
const artifacts = fs.mkdtempSync(path.resolve('tests/.artifacts/qwen35-http-'));
const port = await freePort();
const fd = fs.openSync(path.join(artifacts, 'launcher.log'), 'wx');
const child = spawn(path.resolve('tests/.build/dstudio-server-test'), [String(port), main], {
  cwd: process.cwd(), detached: true, stdio: ['ignore', fd, fd],
  env: { ...process.env, DS4UI_DATA_DIR: path.join(artifacts, 'data'), DS4UI_NO_WINDOW: '1',
    DS4UI_DEFER_ENGINE_START: '1', DS4UI_TEST_MODE: '1', DS4UI_HOST: '127.0.0.1' },
});
fs.closeSync(fd);
const exited = new Promise(resolve => { child.once('exit', resolve); child.once('error', resolve); });
const request = async (endpoint, body) => {
  const response = await fetch(`http://127.0.0.1:${port}${endpoint}`, {
    method: body === undefined ? 'GET' : 'POST', headers: csrfHeaders,
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(90000),
  });
  const json = await response.json();
  assert.equal(response.status, 200, JSON.stringify(json));
  return json;
};
try {
  let initial;
  for (let i = 0; i < 40; i++) {
    try { initial = await request('/api/status'); break; } catch { await sleep(100); }
  }
  assert.ok(initial, 'launcher must start');
  assert.equal(initial.running, false);
  const setup = await request('/api/qwen35/setup', {});
  assert.equal(setup.ok, true);
  assert.equal(setup.built, true);
  assert.equal(setup.downloaded, false, 'reuse the pinned fresh source without replacing it');
  const status = await request('/api/status');
  assert.equal(status.ds4dir, main, 'installation must not switch the active engine');
  assert.equal(status.running, false);
  const catalog = await request('/api/engine/checkouts');
  const entry = catalog.checkouts.find(c => c.dir === qwen);
  assert.equal(entry?.branch, 'qwen35moe-support');
  assert.equal(entry?.hasServer, true);
  assert.equal((await request('/api/engine/checkout', { dir: qwen })).ok, true);
  assert.equal((await request('/api/status')).running, false, 'checkout selection must not launch inference');
  assert.equal(hash(source), before, 'main-only patches must not rewrite Qwen source');
  assert.equal(fs.realpathSync(path.join(qwen, 'gguf')), path.join(main, 'gguf'));
  assert.equal(fs.existsSync(path.join(artifacts, 'data/ds4-qwen35')), false, 'do not install in an undiscoverable second root');
  fs.writeFileSync(path.join(artifacts, 'result.json'), JSON.stringify({ setup, entry, inference: 'not run' }, null, 2));
  console.log(`qwen35_setup_http_test: passed real setup/catalog/selection (no inference); ${artifacts}`);
} finally {
  if (child.exitCode === null && child.pid) process.kill(-child.pid, 'SIGTERM');
  let timer;
  await Promise.race([exited, new Promise(resolve => { timer = setTimeout(() => {
    if (child.exitCode === null && child.pid) process.kill(-child.pid, 'SIGKILL');
    resolve();
  }, 10000); })]);
  clearTimeout(timer);
}

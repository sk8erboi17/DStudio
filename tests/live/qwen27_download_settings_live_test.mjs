// Uses the production Settings HTTP download path and already installed pinned
// q36/weights. No LLM is launched, no source checkout or model is overwritten.
// Fresh network installation and inference are separate explicit gates.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {artifactRunDir, freePort, sleep, csrfHeaders} from '../support/real_harness.mjs';

const binary = path.resolve(process.argv[2]), root = fs.realpathSync(process.argv[3]);
const run = artifactRunDir('qwen27-download-settings-live');
const files = [['Qwen3.8-27B-UD-Q6_K_XL.gguf', 25299061664], ['Qwen3.8-27B-mmproj-F16.gguf', 927607488]];
const identity = file => {const s = fs.statSync(file, {bigint: true}); return [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].map(String);};
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const inputs = [binary, 'src/dstudio.c', 'scripts/download-qwen27.py', 'scripts/install-q36.py',
  'scripts/apply-q36-metal-runtime.sh', 'patch/q36-metal-runtime/runtime.patch', path.join(root, 'q36/q36-server'),
  path.join(root, 'q36/.dstudio-source.json')].map(file => ({path: path.resolve(file), sha256: sha(file)}));
const beforeFiles = files.map(([name, bytes]) => {
  const file = path.join(root, 'ds4/gguf', name), info = identity(file);
  assert.equal(info[2], String(bytes), 'This gate only reuses full-size existing components');
  return {file, identity: info};
});
const receipt = {scope: 'Production host/installer and real SHA-256 reuse verification; no new transfer or inference qualification',
  started: new Date().toISOString(), passed: false, inputs, beforeFiles, phases: []};
const port = await freePort(), base = `http://127.0.0.1:${port}`, engine = path.join(root, 'ds4');
const log = fs.openSync(path.join(run, 'host.log'), 'wx');
const host = spawn(binary, [String(port), engine], {detached: true, stdio: ['ignore', log, log],
  env: {...process.env, DS4UI_DATA_DIR: path.join(run, 'profile'), DS4UI_NO_WINDOW: '1', DS4UI_TEST_MODE: '1',
    DS4UI_DEFER_ENGINE_START: '1', DS4UI_HOST: '127.0.0.1', DS4UI_ENGINE_PORT: String(await freePort())}});
fs.closeSync(log);
const exited = new Promise(resolve => host.once('exit', resolve));
async function request(route, body) {
  const began = performance.now();
  const r = await fetch(base + route, {method: body === undefined ? 'GET' : 'POST', headers: csrfHeaders,
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(2000)});
  const data = await r.json(); return {status: r.status, body: data, elapsedMs: performance.now() - began};
}
async function waitFor(fn, timeout) {const until = Date.now() + timeout;
  while (Date.now() < until) {const value = await fn(); if (value) return value; await sleep(100);}
  throw Error('Verification deadline exceeded');
}
try {
  await waitFor(async () => {try {return (await request('/api/status')).status === 200;} catch {return false;}}, 8000);
  assert.equal((await request('/api/webdir', {path: process.cwd()})).status, 200);
  receipt.before = (await request('/api/status')).body;
  receipt.admitted = await request('/api/model/download', {target: 'qwen27-q6'});
  assert.equal(receipt.admitted.status, 200);
  receipt.after = await waitFor(async () => {
    const result = await request('/api/status'), s = result.body;
    receipt.phases.push({at: new Date().toISOString(), phase: s.downloadPhase, pct: s.downloadPct,
      bytes: s.downloadBytes, controlMs: result.elapsedMs});
    assert.equal(s.ds4dir, receipt.before.ds4dir); assert.equal(s.modelFile, receipt.before.modelFile);
    assert.equal(s.residentPid, 0); assert.equal(s.running, false);
    assert.notEqual(s.downloadPhase, 'failed', 'Production install/verification failed; see private log');
    if (s.downloadPhase !== 'complete') {assert.ok(s.downloadPct < 100); return false;}
    assert.equal(s.downloadPct, 100); return s;
  }, 180000);
  assert.ok(receipt.phases.some(p => p.phase === 'verifying'));
  receipt.afterFiles = beforeFiles.map(item => ({file: item.file, identity: identity(item.file)}));
  assert.deepEqual(receipt.afterFiles, beforeFiles);
  receipt.changedInputs = inputs.filter(item => sha(item.path) !== item.sha256);
  assert.deepEqual(receipt.changedInputs, []);
  receipt.passed = true;
} catch (error) {receipt.error = error.stack; process.exitCode = 1;}
finally {
  if (!receipt.passed) {
    await request('/api/model/download/stop', {}).catch(() => {});
    await waitFor(async () => {const s = (await request('/api/status')).body;
      return ['failed', 'stopped', 'complete'].includes(s.downloadPhase);}, 8000).catch(() => {});
  }
  host.kill('SIGTERM'); await Promise.race([exited, sleep(3000)]);
  if (host.exitCode === null && host.signalCode === null) {process.kill(-host.pid, 'SIGKILL'); await exited;}
  receipt.finished = new Date().toISOString(); receipt.hostExit = {code: host.exitCode, signal: host.signalCode};
  fs.writeFileSync(path.join(run, 'results.json'), JSON.stringify(receipt, null, 2));
  console.log(`${receipt.passed ? 'PASS' : 'FAIL'} ${run}`);
  if (receipt.error) console.error(receipt.error);
}

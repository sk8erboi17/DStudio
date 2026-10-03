// Real host HTTP, background children and files for the MLX model download;
// the MLX installer and the weight downloader are explicit bounded fixtures
// (tiny files, no network, no model). The real downloader's folder-identity
// rejection runs at the end with --verify-only (no network either).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn, spawnSync} from 'node:child_process';
import {artifactRunDir, freePort, sleep, csrfHeaders} from '../support/real_harness.mjs';

if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  console.log('mlx_download_host_test: NOT RUN (the MLX download is admitted only on Apple Silicon)');
  process.exit(2);
}
const run = artifactRunDir('mlx-download-host');
const binary = path.resolve(process.argv[2]);
const root = path.join(run, 'install with spaces'), engine = path.join(root, 'ds4');
const assets = path.join(run, 'assets');
const folder = path.join(engine, 'mlx/Qwen3.6-35B-A3B-mxfp8');
const EXPECTED = 36665809057;
const receipt = {started: new Date().toISOString(), passed: false, plannedChecks: 7,
  scope: 'Real host HTTP/processes/files; simulated MLX installer and tiny weight files, not inference',
  hostSHA256: crypto.createHash('sha256').update(fs.readFileSync(binary)).digest('hex'), cases: []};
function file(name, data) {fs.mkdirSync(path.dirname(name), {recursive: true}); fs.writeFileSync(name, data);}
file(path.join(engine, 'Makefile'), 'all:\n\t@false\n');
fs.mkdirSync(path.join(engine, 'gguf'), {recursive: true});
file(path.join(assets, 'src/harness/design/build-design.sh'), '#!/bin/sh\nexit 0\n');
file(path.join(assets, 'scripts/apply-ds4-visible-downloads.sh'), '#!/bin/sh\nexit 0\n');
file(path.join(assets, 'src/engines/mlx/manifest.json'), '{"fixture": true}\n');
const opener = path.join(run, 'bin/open');
file(opener, '#!/bin/sh\nprintf "%s" "$1" > "$DSTUDIO_FIXTURE_OPENED"\n'); fs.chmodSync(opener, 0o755);
file(path.join(assets, 'scripts/install-mlx.py'), `import sys, json, time
from pathlib import Path
root = Path(sys.argv[sys.argv.index('--root') + 1])
(root / 'install-entered').write_text(json.dumps(sys.argv[1:]))
while not (root / 'install-release').exists(): time.sleep(.02)
if (root / 'install-fail').exists(): sys.exit(9)
(root / 'mlx' / 'venv' / 'bin').mkdir(parents=True, exist_ok=True)
(root / 'mlx' / 'venv' / 'bin' / 'python3').write_text('fixture, no runtime')
`);
file(path.join(assets, 'scripts/download-mlx-qwen36.py'), `import sys, os, json, time
from pathlib import Path
directory = Path(sys.argv[sys.argv.index('--directory') + 1]).resolve()
control = Path(${JSON.stringify(root)})
(control / 'download-entered').write_text(json.dumps(sys.argv[1:]))
progress = int(sys.argv[sys.argv.index('--progress-fd') + 1])
stage = directory / '.dstudio-qwen27-downloads' / 'model-00001-of-00008.safetensors'
stage.mkdir(parents=True, exist_ok=True)
(directory / 'config.json').write_bytes(b'{}' * 512)
(stage / 'data.part').write_bytes(b'x' * 4096)
os.write(progress, b'D')
while not (control / 'download-release').exists(): time.sleep(.02)
os.write(progress, b'V')
while not (control / 'verify-release').exists(): time.sleep(.02)
if (control / 'verify-fail').exists(): sys.exit(7)
(directory / 'model-00001-of-00008.safetensors').write_bytes(b'verified fixture weights')
(stage / 'data.part').unlink()
`);
const port = await freePort(), enginePort = await freePort(), base = `http://127.0.0.1:${port}`;
const log = fs.openSync(path.join(run, 'host.log'), 'wx');
const host = spawn(binary, [String(port), engine], {detached: true, stdio: ['ignore', log, log],
  env: {...process.env, DS4UI_DATA_DIR: path.join(run, 'profile'), DS4UI_NO_WINDOW: '1',
    DS4UI_TEST_MODE: '1', DS4UI_DEFER_ENGINE_START: '1', DS4UI_HOST: '127.0.0.1', DS4UI_ENGINE_PORT: String(enginePort),
    PATH: path.dirname(opener) + path.delimiter + process.env.PATH, DSTUDIO_FIXTURE_OPENED: path.join(run, 'opened-folder')}});
fs.closeSync(log);
const exit = new Promise(resolve => {host.once('exit', resolve); host.once('error', resolve);});
async function request(route, body) {
  const response = await fetch(base + route, {method: body === undefined ? 'GET' : 'POST',
    headers: csrfHeaders, body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(2000)});
  return {status: response.status, body: await response.json()};
}
const state = async () => (await request('/api/status')).body;
async function until(fn, message, timeout = 6000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {const value = await fn(); if (value) return value; await sleep(25);}
  throw Error(message);
}
async function phase(expected) {return until(async () => {const s = await state();
  return s.downloadPhase === expected ? s : false;}, `missing phase ${expected}`);}
const release = name => file(path.join(root, name + '-release'), 'release');
function reset() {
  for (const name of ['install', 'download', 'verify']) for (const suffix of ['release', 'entered', 'fail']) {
    const target = path.join(root, `${name}-${suffix}`); if (fs.existsSync(target)) fs.unlinkSync(target);
  }
}
async function check(name, fn) {
  const row = {name}; receipt.cases.push(row);
  try {await fn(row); row.passed = true;}
  catch (error) {row.passed = false; row.error = error.stack; throw error;}
  finally {fs.writeFileSync(path.join(run, 'results.json'), JSON.stringify(receipt, null, 2));}
}
try {
  await until(async () => {try {return (await request('/api/status')).status === 200;} catch {return false;}}, 'host not ready');
  assert.equal((await request('/api/webdir', {path: assets})).status, 200);
  const original = await state();
  await check('the MLX runtime installs first, asynchronously, without changing the selected model', async row => {
    row.start = await request('/api/model/download', {target: 'qwen36-mlx'});
    assert.equal(row.start.status, 200); row.phase = await phase('installing');
    assert.equal(row.phase.ds4dir, original.ds4dir); assert.equal(row.phase.modelFile, original.modelFile);
    assert.deepEqual(row.phase.config, original.config); assert.equal(row.phase.running, original.running);
    await until(() => fs.existsSync(path.join(root, 'install-entered')), 'MLX installer not called');
    const args = JSON.parse(fs.readFileSync(path.join(root, 'install-entered')));
    assert.equal(args[args.indexOf('--root') + 1], root);
    assert.equal(args[args.indexOf('--assets') + 1], assets);
    assert.ok(fs.statSync(folder).isDirectory(), 'the model folder is admitted before the child runs');
    assert.equal((await request('/api/model/download', {target: 'qwen36-mlx'})).status, 409);
    assert.ok(!fs.existsSync(path.join(root, 'download-entered')), 'no weights before the runtime is installed');
  });
  await check('progress counts the folder and its private stages against the pinned total', async row => {
    release('install'); row.phase = await phase('downloading');
    row.phase = await until(async () => {const s = await state(); return s.downloadBytes === 4096 + 1024 ? s : false;}, 'progress bytes');
    assert.equal(row.phase.downloadExpectedBytes, EXPECTED); assert.ok(row.phase.downloadPct < 100);
    const args = JSON.parse(fs.readFileSync(path.join(root, 'download-entered')));
    assert.equal(args[args.indexOf('--directory') + 1], folder);
    const id = fs.statSync(folder, {bigint: true});
    assert.equal(args[args.indexOf('--directory-identity') + 1], `${id.dev}:${id.ino}`);
    assert.equal((await request('/api/model/folder/open', {engine: 'main', downloadTarget: 'qwen36-mlx'})).status, 200);
    await until(() => fs.existsSync(path.join(run, 'opened-folder')), 'folder opener not called');
    assert.equal(fs.readFileSync(path.join(run, 'opened-folder'), 'utf8'), folder);
  });
  await check('verification is not completion; the exit status is', async row => {
    release('download'); row.phase = await phase('verifying'); assert.ok(row.phase.downloadPct < 100);
    release('verify'); row.complete = await phase('complete'); assert.equal(row.complete.downloadPct, 100);
    assert.equal(fs.readFileSync(path.join(folder, 'model-00001-of-00008.safetensors'), 'utf8'), 'verified fixture weights');
    assert.equal(row.complete.modelFile, original.modelFile);
  });
  await check('installer failure never starts the weight downloader', async row => {
    reset(); file(path.join(root, 'install-fail'), 'fail'); release('install');
    assert.equal((await request('/api/model/download', {target: 'qwen36-mlx'})).status, 200);
    row.failed = await phase('failed'); assert.notEqual(row.failed.downloadPct, 100);
    assert.ok(!fs.existsSync(path.join(root, 'download-entered')));
  });
  await check('verification failure keeps the resumable stage; partial cleanup is refused', async row => {
    reset(); release('install'); release('download'); file(path.join(root, 'verify-fail'), 'fail'); release('verify');
    assert.equal((await request('/api/model/download', {target: 'qwen36-mlx'})).status, 200);
    row.failed = await phase('failed'); assert.notEqual(row.failed.downloadPct, 100);
    row.failed = await until(async () => {const s = await state(); return s.pausedDownloadVariant ? s : false;}, 'paused state');
    assert.equal(row.failed.pausedDownloadVariant, 'qwen36-mlx');
    const part = path.join(folder, '.dstudio-qwen27-downloads/model-00001-of-00008.safetensors/data.part');
    assert.equal(fs.statSync(part).size, 4096);
    assert.equal((await request('/api/model/partials/delete', {target: 'qwen36-mlx', confirm: true})).status, 409);
    assert.equal(fs.statSync(part).size, 4096);
    assert.equal(fs.readFileSync(path.join(folder, 'model-00001-of-00008.safetensors'), 'utf8'), 'verified fixture weights');
  });
  await check('a linked folder (an existing copy elsewhere) is admitted by its target identity', async row => {
    reset();
    const elsewhere = path.join(run, 'elsewhere/Qwen3.6-35B-A3B-MXFP8');
    fs.mkdirSync(elsewhere, {recursive: true});
    fs.renameSync(folder, path.join(run, 'previous-folder'));
    fs.symlinkSync(elsewhere, folder);
    release('install'); release('download'); release('verify');
    assert.equal((await request('/api/model/download', {target: 'qwen36-mlx'})).status, 200);
    row.complete = await phase('complete');
    const args = JSON.parse(fs.readFileSync(path.join(root, 'download-entered')));
    const id = fs.statSync(elsewhere, {bigint: true});
    assert.equal(args[args.indexOf('--directory-identity') + 1], `${id.dev}:${id.ino}`);
    assert.ok(fs.lstatSync(folder).isSymbolicLink(), 'the link is preserved');
    assert.equal(fs.readFileSync(path.join(elsewhere, 'model-00001-of-00008.safetensors'), 'utf8'), 'verified fixture weights');
  });
  await check('the real downloader rejects a folder replaced after admission (verify-only, offline)', async row => {
    const other = path.join(run, 'replaced'); fs.mkdirSync(other, {recursive: true});
    const id = fs.statSync(path.join(run, 'previous-folder'), {bigint: true});
    const done = spawnSync('python3', [path.resolve('scripts/download-mlx-qwen36.py'), '--directory', other,
      '--directory-identity', `${id.dev}:${id.ino}`, '--verify-only'], {encoding: 'utf8', timeout: 60000});
    row.exit = done.status; row.stderr = done.stderr.slice(-400);
    assert.equal(done.status, 1); assert.match(done.stderr, /changed since download admission/);
    assert.deepEqual(fs.readdirSync(other), [], 'nothing is written into the replaced folder');
  });
  receipt.passed = true;
} catch (error) {receipt.error = error.stack; process.exitCode = 1;}
finally {
  await request('/api/model/download/stop', {}).catch(() => {});
  await until(async () => {const s = await state(); return ['complete', 'failed', 'stopped'].includes(s.downloadPhase);}, 'download cleanup', 6000).catch(() => {});
  host.kill('SIGTERM'); await Promise.race([exit, sleep(2000)]);
  if (host.exitCode === null && host.signalCode === null) {process.kill(-host.pid, 'SIGKILL'); await exit;}
  receipt.finished = new Date().toISOString(); receipt.hostExit = {code: host.exitCode, signal: host.signalCode};
  fs.writeFileSync(path.join(run, 'results.json'), JSON.stringify(receipt, null, 2));
  console.log(`${receipt.passed ? 'PASS' : 'FAIL'} ${receipt.cases.filter(c => c.passed).length}/${receipt.plannedChecks} ${run}`);
  if (receipt.error) console.error(receipt.error);
}

// Real host HTTP, background children and files; installer/weights are explicit
// bounded fixtures. Real curl/hash/publication are covered by the Python gate.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {artifactRunDir, freePort, sleep, csrfHeaders} from '../support/real_harness.mjs';

const run = artifactRunDir('qwen27-download-host');
const binary = path.resolve(process.argv[2]);
const interactive = process.argv.includes('--browser');
const root = path.join(run, 'install with spaces'), engine = path.join(root, 'ds4');
const assets = path.join(run, 'assets'), alternate = path.join(run, 'other/ds4');
const model = 'Qwen3.8-27B-UD-Q6_K_XL.gguf';
const projector = 'Qwen3.8-27B-mmproj-F16.gguf';
const receipt = {started: new Date().toISOString(), passed: false, plannedChecks: 7,
  scope: 'Real host HTTP/processes/files; simulated installer and tiny model files, not LLM quality',
  hostSHA256: crypto.createHash('sha256').update(fs.readFileSync(binary)).digest('hex'), cases: []};
function file(name, data) {fs.mkdirSync(path.dirname(name), {recursive: true}); fs.writeFileSync(name, data);}
file(path.join(engine, 'Makefile'), 'all:\n\t@false\n');
file(path.join(alternate, 'Makefile'), 'all:\n\t@false\n');
fs.mkdirSync(path.join(engine, 'gguf'), {recursive: true});
file(path.join(assets, 'extension/design/build-design.sh'), '#!/bin/sh\nexit 0\n');
file(path.join(assets, 'scripts/apply-ds4-visible-downloads.sh'), '#!/bin/sh\nexit 0\n');
// Observe the real opener argv without opening Finder/a desktop application.
const opener = path.join(run, 'bin/open');
file(opener, '#!/bin/sh\nprintf "%s" "$1" > "$DSTUDIO_FIXTURE_OPENED"\n'); fs.chmodSync(opener, 0o755);
fs.copyFileSync(opener, path.join(run, 'bin/xdg-open')); fs.chmodSync(path.join(run, 'bin/xdg-open'), 0o755);
file(path.join(assets, 'scripts/install-q36.py'), `import sys, json, time
from pathlib import Path
root = Path(sys.argv[sys.argv.index('--root') + 1])
(root / 'install-entered').write_text(json.dumps(sys.argv[1:]))
while not (root / 'install-release').exists(): time.sleep(.02)
if (root / 'install-fail').exists(): sys.exit(9)
(root / 'q36').mkdir(exist_ok=True)
(root / 'q36' / 'Makefile').write_text('fixture, no native build')
`);
file(path.join(assets, 'scripts/download-qwen27.py'), `import sys, os, json, time
from pathlib import Path
directory = Path(sys.argv[sys.argv.index('--directory') + 1]).resolve()
control = directory.parent.parent
(control / 'download-entered').write_text(json.dumps(sys.argv[1:]))
progress = int(sys.argv[sys.argv.index('--progress-fd') + 1])
stage = directory / '.dstudio-qwen27-downloads' / '${model}'
stage.mkdir(parents=True, exist_ok=True)
(stage / 'data.part').write_bytes(b'x' * 4096)
os.write(progress, b'D')
while not (control / 'download-release').exists(): time.sleep(.02)
os.write(progress, b'V')
(control / 'verify-entered').write_text('verifying fixture, not real weights')
while not (control / 'verify-release').exists(): time.sleep(.02)
if (control / 'verify-fail').exists(): sys.exit(7)
(directory / '${model}').write_bytes(b'verified fixture model')
(directory / '${projector}').write_bytes(b'verified fixture projector')
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
  if (interactive) {
    receipt.scope += '; manual Browser interaction, automatic seven-case gate NOT RUN';
    receipt.plannedChecks = 0;
    console.log(JSON.stringify({url: base, root, run, finishedMarker: path.join(root, 'browser-finished')}));
    await until(() => fs.existsSync(path.join(root, 'browser-finished')), 'browser fixture expired', 10 * 60 * 1000);
  } else {
  const original = await state();
  await check('27B installation is asynchronous and preserves the selected model', async row => {
    row.start = await request('/api/model/download', {target: 'qwen27-q6'});
    assert.equal(row.start.status, 200); row.phase = await phase('installing');
    assert.equal(row.phase.ds4dir, original.ds4dir); assert.equal(row.phase.modelFile, original.modelFile);
    assert.deepEqual(row.phase.config, original.config); assert.equal(row.phase.running, original.running);
    await until(() => fs.existsSync(path.join(root, 'install-entered')), 'installer not called');
    const args = JSON.parse(fs.readFileSync(path.join(root, 'install-entered')));
    assert.equal(args[args.indexOf('--root') + 1], root);
    assert.match(args[args.indexOf('--revision') + 1], /^[0-9a-f]{40}$/);
    assert.equal((await request('/api/model/download', {target: 'qwen27-q6'})).status, 409);
    row.task = (await request('/api/task?id=' + row.start.body.taskId)).body;
    assert.ok(row.phase.downloadPct < 100);
  });
  await check('progress stays bound to its store after another checkout is selected', async row => {
    assert.equal((await request('/api/engine/checkout', {dir: alternate})).status, 200);
    release('install'); row.phase = await phase('downloading');
    assert.equal(row.phase.ds4dir, alternate); assert.equal(row.phase.downloadBytes, 4096);
    assert.equal(row.phase.downloadExpectedBytes, 26226669152);
    assert.ok(!fs.existsSync(path.join(alternate, 'gguf', model)));
    const args = JSON.parse(fs.readFileSync(path.join(root, 'download-entered')));
    assert.equal(path.resolve(args[args.indexOf('--directory') + 1]), path.join(engine, 'gguf'));
    const store = fs.statSync(path.join(engine, 'gguf'), {bigint: true});
    assert.equal(args[args.indexOf('--directory-identity') + 1], `${store.dev}:${store.ino}`);
    assert.equal((await request('/api/model/folder/open', {engine: 'q36', downloadTarget: 'qwen27-q6'})).status, 200);
    await until(() => fs.existsSync(path.join(run, 'opened-folder')), 'folder opener not called');
    assert.equal(fs.readFileSync(path.join(run, 'opened-folder'), 'utf8'), path.join(engine, 'gguf'));
    assert.equal((await request('/api/model/folder/open', {engine: 'q36', downloadTarget: 'qwen36-q6'})).status, 409);
  });
  await check('verification never becomes 100 percent before the verified process exits', async row => {
    release('download'); row.phase = await phase('verifying');
    assert.ok(row.phase.downloadPct < 100); assert.equal(row.phase.downloadBytes, 4096);
    release('verify'); row.complete = await phase('complete');
    assert.equal(row.complete.downloadPct, 100); assert.equal(row.complete.ds4dir, alternate);
    assert.equal(fs.readFileSync(path.join(engine, 'gguf', model), 'utf8'), 'verified fixture model');
    assert.equal(fs.readFileSync(path.join(engine, 'gguf', projector), 'utf8'), 'verified fixture projector');
  });
  await check('Stop during installer preparation terminates only the owned download', async row => {
    reset(); assert.equal((await request('/api/engine/checkout', {dir: engine})).status, 200);
    assert.equal((await request('/api/model/download', {target: 'qwen27-q6'})).status, 200);
    await phase('installing'); row.stop = await request('/api/model/download/stop', {});
    assert.equal(row.stop.status, 200); await phase('stopped');
    assert.ok(!fs.existsSync(path.join(root, 'download-entered')));
    assert.equal(fs.readFileSync(path.join(engine, 'gguf', model), 'utf8'), 'verified fixture model');
  });
  await check('installer failure cannot start the weight downloader or report completion', async row => {
    reset(); file(path.join(root, 'install-fail'), 'fail'); release('install');
    assert.equal((await request('/api/model/download', {target: 'qwen27-q6'})).status, 200);
    row.failed = await phase('failed'); assert.notEqual(row.failed.downloadPct, 100);
    assert.ok(!fs.existsSync(path.join(root, 'download-entered')));
  });
  await check('verification failure keeps resumable data and completed files untouched', async row => {
    reset(); release('install'); release('download'); file(path.join(root, 'verify-fail'), 'fail'); release('verify');
    assert.equal((await request('/api/model/download', {target: 'qwen27-q6'})).status, 200);
    row.failed = await phase('failed'); assert.notEqual(row.failed.downloadPct, 100);
    assert.equal(row.failed.pausedDownloadVariant, 'qwen27-q6');
    assert.equal(fs.statSync(path.join(engine, 'gguf/.dstudio-qwen27-downloads', model, 'data.part')).size, 4096);
    assert.equal(fs.readFileSync(path.join(engine, 'gguf', model), 'utf8'), 'verified fixture model');
    // This layout requires its downloader's locked cleanup, not the legacy
    // neighboring .part deleter. Never pretend that unrelated files were deleted.
    assert.equal((await request('/api/model/partials/delete', {target: 'qwen27-q6', confirm: true})).status, 409);
  });
  await check('retry reuses the same target and never changes model selection', async row => {
    reset(); release('install'); release('download'); release('verify');
    assert.equal((await request('/api/model/download', {target: 'qwen27-q6'})).status, 200);
    row.complete = await phase('complete'); assert.equal(row.complete.downloadPct, 100);
    assert.equal(row.complete.ds4dir, original.ds4dir); assert.equal(row.complete.modelFile, original.modelFile);
  });
  }
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

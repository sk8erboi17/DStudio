// An engine installation started by the real host: update check and control
// requests beside it, a second installer, Stop, the host dying, and what a
// reopened app reports.
//
// Real: the host binary over HTTP, its background installation child, the
// production llama.cpp installer (copied into a support tree as the app
// materializes it), leases, stages and files in a task-owned profile whose
// paths contain spaces. Outbound network is denied by macOS sandbox-exec.
// SIMULATED: cmake (a stand-in that emits a stand-in llama-server) and the
// weight downloader with tiny files. No compiler, no model, no inference.
//   node tests/integration/install_recovery_host_test.mjs tests/.build/dstudio-server-test
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn, spawnSync, execFileSync} from 'node:child_process';
import {artifactRunDir, freePort, sleep, csrfHeaders} from '../support/real_harness.mjs';

if (process.platform !== 'darwin') {
  console.log('install_recovery_host_test: NOT RUN (uses macOS sandbox-exec and the static llama.cpp recipe)');
  process.exit(2);
}
const binary = path.resolve(process.argv[2] || 'tests/.build/dstudio-server-test');
const run = artifactRunDir('install-recovery-host');
const helper = path.resolve('tests/support/install_recovery.py');
const SANDBOX = '(version 1)(allow default)(deny network-outbound (remote ip "*:*"))';
const pins = JSON.parse(execFileSync(binary, ['--engine-pins'], {encoding: 'utf8'}));
const PIN = pins.engines.find(row => row.id === 'llama').commit;
const fixture = JSON.parse(execFileSync('python3', [helper, 'llama-host', run, PIN], {encoding: 'utf8'}));
const root = path.join(run, 'install with spaces'), engine = path.join(root, 'ds4');
const profile = path.join(run, 'profile with spaces');
const model = 'Qwen3.8-27B-UD-Q6_K_XL.gguf', projector = 'Qwen3.8-27B-mmproj-F16.gguf';
const receipt = {started: new Date().toISOString(), passed: false, plannedChecks: 6,
  scope: 'Real host HTTP, installation child, production llama.cpp installer, leases and files, network denied; ' +
    'SIMULATED cmake, stand-in llama-server and tiny weight files, no model',
  hostSHA256: crypto.createHash('sha256').update(fs.readFileSync(binary)).digest('hex'), pin: PIN, cases: []};
function file(name, data) {fs.mkdirSync(path.dirname(name), {recursive: true}); fs.writeFileSync(name, data);}
file(path.join(engine, 'Makefile'), 'all:\n\t@false\n');
fs.mkdirSync(path.join(engine, 'gguf'), {recursive: true});
file(path.join(engine, 'gguf/Qwen3.6-35B-A3B-UD-Q6_K_XL.gguf'), 'stand-in bytes of a model the user already has\n');
const STORE = JSON.stringify({settings: {theme: 'dark', ctx: 32768}, conversations: [{id: 'c1', title: 'Saved session'}]});
file(path.join(profile, 'ds4web-store.json'), STORE);
// The weight downloader is a fixture: it starts only after the engine is installed.
file(path.join(fixture.support, 'scripts/download-qwen-variant.py'), `import sys, os, json, time
from pathlib import Path
directory = Path(sys.argv[sys.argv.index('--directory') + 1]).resolve()
control = Path(${JSON.stringify(fixture.control)})
(control / 'download.entered').write_text(json.dumps(sys.argv[1:]))
progress = int(sys.argv[sys.argv.index('--progress-fd') + 1])
os.write(progress, b'D')
for _ in range(3000):
    if (control / 'download.release').exists(): break
    time.sleep(.02)
else: sys.exit(97)
os.write(progress, b'V')
(directory / '${model}').write_bytes(b'verified fixture model')
(directory / '${projector}').write_bytes(b'verified fixture projector')
`);
const control = name => path.join(fixture.control, name);
const hold = name => fs.writeFileSync(control(name + '.hold'), '');
const release = name => fs.writeFileSync(control(name + '.release'), '');
function resetControl() {for (const name of fs.readdirSync(fixture.control)) fs.rmSync(control(name), {force: true});}
const alive = pid => {try {process.kill(pid, 0); return true;} catch {return false;}};
const tree = dir => execFileSync('python3', [helper, 'tree', dir], {encoding: 'utf8', maxBuffer: 64 << 20});
const leaseFree = () => spawnSync('python3', [helper, 'lease-free', path.join(root, '.dstudio-llama-install.lock')]).status === 0;
const stages = () => fs.readdirSync(root).filter(name => name.startsWith('.dstudio-llama-stage-'));
const installed = () => JSON.parse(fs.readFileSync(path.join(root, 'llama.cpp/.dstudio-llama.json'), 'utf8'));
const serverVersion = () => spawnSync(path.join(root, 'llama.cpp/bin/llama-server'), ['--version'], {encoding: 'utf8', timeout: 20000});
const groupMembers = pgid => execFileSync('ps', ['-A', '-o', 'pid=,pgid=,stat='], {encoding: 'utf8'}).split('\n')
  .map(line => line.trim().split(/\s+/)).filter(p => p[1] === String(pgid) && !(p[2] || '').startsWith('Z')).map(p => Number(p[0]));
JSON.parse(execFileSync('python3', [helper, 'llama-earlier', run, root], {encoding: 'utf8'}));
const earlierTree = tree(path.join(root, 'llama.cpp'));

let host, base, exit, hostCount = 0;
async function startHost() {
  const port = await freePort(), enginePort = await freePort();
  base = `http://127.0.0.1:${port}`;
  const log = fs.openSync(path.join(run, `host-${++hostCount}.log`), 'wx');
  host = spawn('/usr/bin/sandbox-exec', ['-p', SANDBOX, binary, String(port), engine], {detached: true, stdio: ['ignore', log, log],
    env: {...process.env, DS4UI_DATA_DIR: profile, DS4UI_NO_WINDOW: '1', DS4UI_TEST_MODE: '1', DS4UI_DEFER_ENGINE_START: '1',
      DS4UI_HOST: '127.0.0.1', DS4UI_ENGINE_PORT: String(enginePort), DSTUDIO_CMAKE: fixture.cmake,
      DSTUDIO_KV_DIR: path.join(run, 'kv')}});
  fs.closeSync(log);
  const current = host;
  exit = new Promise(resolve => {current.once('exit', resolve); current.once('error', resolve);});
  await until(async () => {try {return (await request('/api/status')).status === 200;} catch {return false;}}, 'host not ready');
  assert.equal((await request('/api/webdir', {path: fixture.support})).status, 200);
}
async function request(route, body, timeout = 2000) {
  const response = await fetch(base + route, {method: body === undefined ? 'GET' : 'POST', headers: csrfHeaders,
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeout)});
  return {status: response.status, body: await response.json()};
}
const state = async () => (await request('/api/status')).body;
async function until(fn, message, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {const value = await fn(); if (value) return value; await sleep(20);}
  throw Error(message);
}
const phase = expected => until(async () => {const s = await state(); return s.downloadPhase === expected ? s : false;},
  `missing download phase ${expected}`);
// The stand-in compiler parks at its barrier and reports its PID.
const parked = name => until(() => fs.existsSync(control(name + '.reached')) && Number(fs.readFileSync(control(name + '.reached'), 'utf8')),
  `the installer did not reach ${name}`);
async function check(name, fn) {
  const row = {name}; receipt.cases.push(row);
  try {await fn(row); row.passed = true; console.log(`PASS ${name}`);}
  catch (error) {row.passed = false; row.error = error.stack; console.log(`FAIL ${name}\n  ${error.message}`); throw error;}
  finally {fs.writeFileSync(path.join(run, 'results.json'), JSON.stringify(receipt, null, 2));}
}
try {
  await startHost();
  const original = await state();
  await check('an installation in the background leaves status, the saved store and the update check responsive', async row => {
    hold('cmake-build');
    assert.equal((await request('/api/model/download', {target: 'qwen27-q6'})).status, 200);
    row.tool = await parked('cmake-build');
    row.phase = await phase('installing');
    assert.equal(row.phase.running, false); assert.equal(row.phase.ready, false);
    assert.equal(row.phase.modelFile, original.modelFile, 'installing an engine never selects a model');
    assert.equal(row.phase.ds4dir, original.ds4dir);
    const started = Date.now();
    row.update = await request('/api/updates/check');
    row.updateMs = Date.now() - started;
    assert.equal(row.update.status, 200);
    assert.equal(row.update.body.sections.find(section => section.id === 'ds4-latest').action, null, 'no engine pull is offered');
    assert.ok(row.updateMs < 1500, `the update check answered in ${row.updateMs} ms beside the parked installation`);
    assert.deepEqual((await request('/api/store')).body, {rev: 1, data: JSON.parse(STORE)});
    assert.equal(installed().commit, fixture.earlierPin, 'the earlier runtime is still the installed one');
    assert.equal(stages().length, 1, 'one private stage');
  });
  await check('a second installation is refused while the first holds the lease; nothing is published twice', async row => {
    assert.equal((await request('/api/model/download', {target: 'qwen27-q6'})).status, 409);
    const second = spawnSync('/usr/bin/sandbox-exec', ['-p', SANDBOX, 'python3', path.join(fixture.support, 'scripts/install-llama.py'),
      '--root', root, '--revision', PIN], {encoding: 'utf8', env: {...process.env, DSTUDIO_CMAKE: fixture.cmake}, timeout: 20000});
    row.second = {status: second.status, stderr: second.stderr.trim()};
    assert.equal(second.status, 1);
    assert.match(second.stderr, /The llama\.cpp engine is being installed; retry when the installation finishes/);
    assert.equal(stages().length, 1, 'the refused installer created no stage');
    assert.equal(tree(path.join(root, 'llama.cpp')), earlierTree);
  });
  await check('Stop cancels the installation: tools gone, stage removed, the earlier runtime untouched', async row => {
    const tool = Number(fs.readFileSync(control('cmake-build.reached'), 'utf8'));
    const pgid = Number(execFileSync('ps', ['-o', 'pgid=', '-p', String(tool)], {encoding: 'utf8'}).trim());
    row.stop = await request('/api/model/download/stop', {});
    assert.equal(row.stop.status, 200);
    row.phase = await phase('stopped');
    await until(() => groupMembers(pgid).length === 0, `the installation outlived Stop: ${groupMembers(pgid)}`, 6000);
    assert.ok(!alive(tool));
    assert.ok(!fs.existsSync(control('download.entered')), 'no weights are transferred after a canceled installation');
    assert.deepEqual(stages(), []);
    assert.equal(tree(path.join(root, 'llama.cpp')), earlierTree);
    assert.ok(leaseFree());
    assert.equal(row.phase.running, false); assert.equal(row.phase.modelFile, original.modelFile);
  });
  await check('the host is killed during an installation: the installation stops within its bound', async row => {
    resetControl(); hold('cmake-build');
    assert.equal((await request('/api/model/download', {target: 'qwen27-q6'})).status, 200);
    const tool = await parked('cmake-build');
    const before = await phase('installing');
    assert.ok(before);
    const pgid = Number(execFileSync('ps', ['-o', 'pgid=', '-p', String(tool)], {encoding: 'utf8'}).trim());
    row.group = groupMembers(pgid);
    assert.ok(row.group.length >= 3, `download child, installer and tool: ${row.group}`);
    const killed = Date.now();
    process.kill(host.pid, 'SIGKILL');          // only the host: nothing closes or signals its children
    await exit;
    // Bound: the installation child notices its owner is gone within 0.5 s and
    // cancels the installer, which stops its tool (at most 3 s) and removes its stage.
    await until(() => groupMembers(pgid).length === 0, `the installation outlived its host: ${groupMembers(pgid)}`, 6000);
    row.goneAfterMs = Date.now() - killed;
    assert.ok(!fs.existsSync(control('download.entered')), 'an ownerless installation must not go on to transfer weights');
    assert.deepEqual(stages(), [], 'the canceled installation removed its stage');
    assert.equal(tree(path.join(root, 'llama.cpp')), earlierTree);
    assert.ok(leaseFree());
    assert.equal(fs.readFileSync(path.join(profile, 'ds4web-store.json'), 'utf8'), STORE);
  });
  await check('reopening the app reports the true state: nothing running, nothing downloaded, the earlier runtime installed', async row => {
    resetControl();
    await startHost();
    row.state = await state();
    assert.equal(row.state.running, false); assert.equal(row.state.ready, false);
    assert.equal(row.state.downloadPhase, '', 'no download is claimed to be in progress, complete or failed');
    assert.equal(row.state.pausedDownload, false, 'no weights were transferred, so nothing is paused');
    assert.equal(row.state.modelFile, original.modelFile);
    assert.deepEqual((await request('/api/store')).body, {rev: 1, data: JSON.parse(STORE)});
    assert.equal(installed().commit, fixture.earlierPin);
    assert.match(serverVersion().stdout, /build 11371, commit 99b9548/);
  });
  await check('the next request completes the upgrade, then downloads and verifies; the model is never selected or started', async row => {
    assert.equal((await request('/api/model/download', {target: 'qwen27-q6'})).status, 200);
    row.downloading = await phase('downloading');
    row.receipt = installed();
    assert.equal(row.receipt.commit, PIN, 'the engine was upgraded before any weight transfer');
    assert.match(serverVersion().stdout, new RegExp(`build ${row.receipt.buildNumber}, commit ${PIN.slice(0, 7)}`));
    assert.deepEqual(stages(), []);
    assert.equal(row.downloading.running, false);
    assert.ok(row.downloading.downloadPct < 100, 'downloading is not verified');
    release('download');
    row.complete = await phase('complete');
    assert.equal(row.complete.downloadPct, 100);
    assert.equal(fs.readFileSync(path.join(engine, 'gguf', model), 'utf8'), 'verified fixture model');
    assert.equal(row.complete.modelFile, original.modelFile, 'a downloaded model is not a selected model');
    assert.equal(row.complete.running, false, 'a downloaded model is not a running model');
    assert.equal(fs.readFileSync(path.join(engine, 'gguf/Qwen3.6-35B-A3B-UD-Q6_K_XL.gguf'), 'utf8'),
      'stand-in bytes of a model the user already has\n');
    assert.equal(fs.readFileSync(path.join(profile, 'ds4web-store.json'), 'utf8'), STORE);
  });
  receipt.passed = true;
} catch (error) {receipt.error = error.stack; process.exitCode = 1;}
finally {
  if (host && host.exitCode === null && host.signalCode === null) {
    await request('/api/model/download/stop', {}).catch(() => {});
    host.kill('SIGTERM'); await Promise.race([exit, sleep(3000)]);
    if (host.exitCode === null && host.signalCode === null) {try {process.kill(-host.pid, 'SIGKILL');} catch {} await exit;}
  }
  // Fixture processes this test started and that a failed case may have left parked.
  for (const name of fs.existsSync(fixture.control) ? fs.readdirSync(fixture.control) : []) {
    if (!name.endsWith('.reached')) continue;
    const pid = Number(fs.readFileSync(control(name), 'utf8'));
    // Only a stand-in tool of this run (its command names this run's toolchain), never a reused PID.
    const command = pid > 1 ? spawnSync('ps', ['-o', 'command=', '-p', String(pid)], {encoding: 'utf8'}).stdout : '';
    if (pid > 1 && alive(pid) && command.includes(run)) {
      const pgid = Number(spawnSync('ps', ['-o', 'pgid=', '-p', String(pid)], {encoding: 'utf8'}).stdout.trim());
      try {if (pgid > 1) process.kill(-pgid, 'SIGKILL');} catch {}
    }
  }
  receipt.finished = new Date().toISOString();
  fs.writeFileSync(path.join(run, 'results.json'), JSON.stringify(receipt, null, 2));
  console.log(`install_recovery_host_test: ${receipt.cases.filter(c => c.passed).length}/${receipt.plannedChecks} passed (${receipt.scope}); receipts: ${run}`);
  if (receipt.error) console.error(receipt.error);
}

// Real DStudio HTTP, private launch worker, process ownership and model routing.
// The installer and inference executable are explicit fixtures: NOT LLM quality.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { artifactRunDir, freePort, sleep, csrfHeaders } from '../support/real_harness.mjs';

const run = artifactRunDir('q36-host');
const binary = path.resolve(process.argv[2]);
const peer = path.resolve(process.argv[3]);
const engine = path.join(run, 'install with spaces/q36');
const shared = path.join(run, 'install with spaces/ds4/gguf');
const assets = path.join(run, 'assets');
const model = 'gguf/Qwen3.8-27B-UD-Q6_K_XL.gguf';
const projector = 'gguf/Qwen3.8-27B-mmproj-F16.gguf';
const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const report = { started: new Date().toISOString(), passed: false,
  plannedChecks: 15,
  scope: 'Real native launcher/HTTP/files/processes; simulated installer and inference peer; no LLM quality',
  hostSHA256: digest(binary), peerSHA256: digest(peer), cases: [] };
function fixture(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value); }
fs.mkdirSync(engine, { recursive: true }); fs.mkdirSync(shared, { recursive: true });
fixture(path.join(engine, 'Makefile'), 'all:\n\t@false\n');
fixture(path.join(shared, '../Makefile'), 'all:\n\t@false\n');
fs.symlinkSync('../ds4/gguf', path.join(engine, 'gguf'));
fixture(path.join(engine, model), 'model bytes are a fixture, not weights');
fixture(path.join(engine, projector), 'projector bytes are a fixture, not weights');
fixture(path.join(engine, '.dstudio-source.json'), '{"fixture":true}\n');
fs.copyFileSync(peer, path.join(engine, 'q36-server')); fs.chmodSync(path.join(engine, 'q36-server'), 0o755);
fixture(path.join(assets, 'extension/design/build-design.sh'), '#!/bin/sh\nexit 0\n');
fixture(path.join(assets, 'scripts/apply-ds4-visible-downloads.sh'), '#!/bin/sh\nexit 0\n');
fixture(path.join(assets, 'scripts/install-q36.py'), 'import sys\nprint("fixture installer: no build or download", sys.argv[1:])\n');
const port = await freePort(), enginePort = await freePort();
const base = `http://127.0.0.1:${port}`;
const log = fs.openSync(path.join(run, 'host.log'), 'wx');
const host = spawn(binary, [String(port), engine], { cwd: process.cwd(), detached: true,
  stdio: ['ignore', log, log], env: { ...process.env, DS4UI_DATA_DIR: path.join(run, 'profile'),
    DS4UI_NO_WINDOW: '1', DS4UI_TEST_MODE: '1', DS4UI_DEFER_ENGINE_START: '1', DS4UI_HOST: '127.0.0.1',
    DSTUDIO_KV_DIR: path.join(run, 'kv'), Q36_UNQUALIFIED_OVERRIDE: 'must not reach inference',
    DS4UI_ENGINE_PORT: String(enginePort === 65535 ? 65534 : enginePort + 1) } });
fs.closeSync(log);
const hostExit = new Promise(resolve => { host.once('exit', resolve); host.once('error', resolve); });
const config = { mode: 'server', gguf: model, ctx: 8192, port: enginePort, power: 100,
  kvSpaceMb: 256, kvMinTokens: 128, think: 'off', ssdStreaming: 'off' };
const exists = pid => { try { process.kill(pid, 0); return true; } catch (e) { if (e.code === 'ESRCH') return false; throw e; } };
async function request(endpoint, body, timeout = 3000) {
  const response = await fetch(base + endpoint, { method: body === undefined ? 'GET' : 'POST', headers: csrfHeaders,
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeout) });
  return { status: response.status, body: await response.json() };
}
async function until(fn, message, timeout = 7000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await fn(); if (value) return value; await sleep(25); }
  throw new Error(message);
}
const state = async () => (await request('/api/status')).body;
function prepare(mode = 'valid') {
  for (const name of ['fixture-release', 'fixture-entered', 'fixture-accepted', 'fixture-upload']) {
    const file = path.join(engine, name); if (fs.existsSync(file)) fs.unlinkSync(file);
  }
  fixture(path.join(engine, 'fixture-mode'), mode);
}
function release() { fixture(path.join(engine, 'fixture-release'), 'release\n'); }
function launch(overrides = {}) {
  // Retain a transport failure as evidence, without an unhandled rejection.
  return request('/api/start', { ...config, ...overrides }, 25000).catch(error => ({ error: error.message }));
}
async function loading() {
  return until(async () => { const s = await state(); return s.residentPid > 0 && s.launchPhase === 'loading' ? s : false; },
    'owned inference did not reach the blocked-loading phase');
}
async function stopped() {
  return until(async () => { const s = await state(); return !s.residentPid && !s.launchTaskId && !s.running ? s : false; },
    'owned process or launch did not terminate');
}
async function stop() { const r = await request('/api/stop', {}); assert.equal(r.status, 200); await stopped(); }
async function check(name, fn) {
  const row = { name };
  try { await fn(row); row.passed = true; }
  catch (error) { row.passed = false; row.error = error.stack; throw error; }
  finally { report.cases.push(row); console.log(`${row.passed ? 'PASS' : 'FAIL'} ${name}`); }
}
// Real cross-process advisory leases, independent of the simulated installer.
// A held lease is released by closing this test-owned helper's stdin.
async function installationLease(mode, hold = false) {
  const helper = spawn('python3', ['-u', '-c', `
import fcntl, json, os, sys
fd = os.open(sys.argv[1], os.O_CREAT | os.O_RDWR, 0o600)
try:
    fcntl.flock(fd, (fcntl.LOCK_EX if sys.argv[2] == 'exclusive' else fcntl.LOCK_SH) | fcntl.LOCK_NB)
except BlockingIOError:
    print(json.dumps({'acquired': False}), flush=True)
else:
    print(json.dumps({'acquired': True}), flush=True)
    if sys.argv[3] == 'hold': sys.stdin.buffer.read(1)
os.close(fd)
`, path.join(path.dirname(engine), '.dstudio-q36-install.lock'), mode, hold ? 'hold' : 'probe'],
  { stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '', errors = '';
  helper.stdout.on('data', data => { output += data; });
  helper.stderr.on('data', data => { errors += data; });
  const ended = new Promise(resolve => helper.once('exit', (code, signal) => resolve({code, signal})));
  try {
    await until(() => output.includes('\n') || helper.exitCode !== null, 'lease helper did not answer', 3000);
    const acquired = JSON.parse(output).acquired;
    if (!hold || !acquired) {
      const exit = await ended; assert.equal(exit.code, 0, errors);
      return acquired;
    }
    return async () => { helper.stdin.end(); const exit = await ended; assert.equal(exit.code, 0, errors); };
  } catch (error) {
    helper.stdin.end();
    if (helper.exitCode === null && helper.signalCode === null) helper.kill('SIGTERM');
    await ended; throw error;
  }
}
try {
  await until(async () => { try { return (await request('/api/status')).status === 200; } catch { return false; } }, 'host not listening');
  assert.equal((await request('/api/webdir', { path: assets })).status, 200);
  await check('catalog routes the dense checkpoint and projector only to q36', async row => {
    row.catalog = (await request('/api/ggufs')).body;
    const matches = row.catalog.ggufs.filter(g => g.file === path.basename(model));
    assert.equal(matches.length, 1); assert.equal(matches[0].engineDir, engine);
    assert.equal(matches[0].branch, 'qwen27b');
    assert.equal(row.catalog.ggufs.filter(g => g.file === path.basename(projector)).length, 1);
  });
  await check('exclusive installation work rejects a launch without blocking the HTTP owner or executing the old binary', async row => {
    prepare(); release();
    const unlock = await installationLease('exclusive', true);
    assert.equal(typeof unlock, 'function');
    try {
      row.start = await launch(); assert.equal(row.start.status, 409);
      row.state = (await request('/api/status', undefined, 1000)).body;
      assert.equal(row.state.ready, false);
      assert.equal(fs.existsSync(path.join(engine, 'fixture-launches')), false);
      await stopped();
    } finally {
      await unlock();
      const current = await state();
      if (current.residentPid || current.running || current.launchTaskId) await stop();
    }
    assert.equal(await installationLease('exclusive'), true, 'failed launch leaked its lease');
  });
  await check('listener and misleading logs cannot publish readiness; blocked loading remains cancelable', async row => {
    prepare(); const response = launch(); row.loading = await loading();
    await until(() => fs.existsSync(path.join(engine, 'fixture-entered')), 'peer never entered its blocked loading');
    assert.equal(await installationLease('exclusive'), false, 'loading must exclude an installer');
    assert.equal(row.loading.ready, false); assert.equal(row.loading.modelFile, model);
    assert.equal(row.loading.nativeVisionActive, false, 'File presence is not a loaded image encoder');
    assert.equal(row.loading.config.ctx, 8192); assert.equal(row.loading.config.power, 100);
    assert.equal(row.loading.config.ssdStreamingEffective, false);
    assert.equal((await request('/v1/models')).body.error.code, 'model_not_ready');
    assert.equal((await request('/api/start', config)).body.code, 'launch_busy');
    assert.equal((await request('/api/engine/checkout', { dir: path.dirname(shared) })).body.code, 'launch_busy');
    row.cancel = await request('/api/start/cancel', { taskId: row.loading.launchTaskId }, 1000);
    assert.equal(row.cancel.status, 200); row.start = await response;
    assert.equal(row.start.body.code, 'launch_canceled'); await stopped();
    assert.equal(exists(row.loading.residentPid), false);
    assert.equal(await installationLease('exclusive'), true, 'cancelled child leaked its lease');
  });
  let resident;
  await check('fragmented private receipt publishes the exact owned PID and configuration', async row => {
    prepare('fragment'); const response = launch(); await loading(); release();
    row.start = await response; assert.equal(row.start.status, 200); assert.equal(row.start.body.reused, false);
    row.ready = await state(); assert.equal(row.ready.ready, true); assert.equal(row.ready.nativeVisionActive, true);
    assert.equal(row.ready.ds4dir, engine); assert.equal(row.ready.modelFile, model);
    assert.equal(row.ready.config.ctx, 8192); resident = row.ready.residentPid;
    assert.equal(resident, row.start.body.residentPid); assert.ok(exists(resident));
  });
  await check('same model and configuration reuse weights without another process', async row => {
    assert.equal(await installationLease('shared'), true, 'read-only verification must coexist with inference');
    assert.equal(await installationLease('exclusive'), false, 'running inference must exclude replacement');
    const before = fs.readFileSync(path.join(engine, 'fixture-launches'), 'utf8');
    row.start = await launch({ force: true }); assert.equal(row.start.status, 200);
    assert.equal(row.start.body.reused, true); assert.equal(row.start.body.residentPid, resident);
    assert.equal(fs.readFileSync(path.join(engine, 'fixture-launches'), 'utf8'), before);
    // The production UI does not resend the resident server's private port
    // and disk-cache knobs when changing mode. Omission is not a reset.
    const {port: omittedPort, kvSpaceMb: omittedSpace, kvMinTokens: omittedMinimum, ...uiConfig} = config;
    row.uiReuse = await request('/api/start', uiConfig, 25000);
    assert.equal(row.uiReuse.status, 200, JSON.stringify(row.uiReuse));
    assert.equal(row.uiReuse.body.reused, true, 'Omitted owned-server settings must not reload weights');
    assert.equal(row.uiReuse.body.residentPid, resident);
    assert.equal((await state()).config.port, config.port);
    assert.equal(fs.readFileSync(path.join(engine, 'fixture-launches'), 'utf8'), before);
  });
  await check('unsupported context, expert streaming, throttling, DSpark and hotlist preserve the working model', async row => {
    row.rejections = [];
    for (const [override, code] of [[{ ctx: 393216 }, 'unsupported_context'],
      [{ ssdStreaming: 'on' }, 'unsupported_memory_mode'], [{ power: 90 }, 'unsupported_power'],
      [{dspark: true}, 'unsupported_speculation'], [{metalHotlistSeed: true}, 'unsupported_hotlist']]) {
      const result = await launch(override); row.rejections.push(result);
      assert.equal(result.body.code, code); const s = await state();
      assert.equal(s.ready, true); assert.equal(s.residentPid, resident); assert.equal(s.config.ctx, 8192);
    }
  });
  await check('invalid explicit resource settings cannot become omitted defaults or replace a working model', async row => {
    const before = fs.readFileSync(path.join(engine, 'fixture-launches'), 'utf8');
    row.rejections = [];
    for (const override of [{port: 1023}, {kvSpaceMb: 255}, {kvMinTokens: 0}]) {
      const reply = await launch(override); row.rejections.push({override, reply});
      assert.equal(reply.status, 400); assert.equal(reply.body.ok, false);
      const current = await state();
      assert.equal(current.ready, true); assert.equal(current.residentPid, resident);
      assert.equal(current.config.port, config.port);
    }
    assert.equal(fs.readFileSync(path.join(engine, 'fixture-launches'), 'utf8'), before);
  });
  await check('explicit port and disk-cache changes reach the new owned process and can be reused exactly', async row => {
    let requested = {...config}; row.transitions = [];
    const changedPort = await freePort(); assert.notEqual(changedPort, config.port);
    for (const change of [{port: changedPort}, {kvSpaceMb: 512}, {kvMinTokens: 256}, config]) {
      requested = {...requested, ...change};
      const previous = resident, transition = {requested: {...requested}, previous};
      row.transitions.push(transition);
      prepare(); const response = launch(requested);
      transition.loading = await loading();
      assert.notEqual(transition.loading.residentPid, previous);
      assert.equal(exists(previous), false, 'Replacement must not overlap the previous owned model');
      await until(() => fs.existsSync(path.join(engine, 'fixture-entered')), 'peer did not publish its received configuration');
      transition.received = JSON.parse(fs.readFileSync(path.join(engine, 'fixture-config.json'), 'utf8'));
      assert.deepEqual(transition.received, {pid: transition.loading.residentPid, port: requested.port,
        ctx: requested.ctx, kvSpaceMb: requested.kvSpaceMb, kvMinTokens: requested.kvMinTokens});
      release(); transition.started = await response;
      assert.equal(transition.started.status, 200); assert.equal(transition.started.body.reused, false);
      resident = transition.started.body.residentPid;
      assert.equal((await state()).config.port, requested.port);
      const launches = fs.readFileSync(path.join(engine, 'fixture-launches'), 'utf8');
      transition.repeated = await launch(requested);
      assert.equal(transition.repeated.status, 200); assert.equal(transition.repeated.body.reused, true);
      assert.equal(transition.repeated.body.residentPid, resident);
      assert.equal(fs.readFileSync(path.join(engine, 'fixture-launches'), 'utf8'), launches);
    }
  });
  await check('a context change stops the previous owned model before starting its replacement', async row => {
    prepare(); const response = launch({ ctx: 16384 }); row.loading = await loading();
    assert.notEqual(row.loading.residentPid, resident); assert.equal(exists(resident), false);
    assert.equal(row.loading.config.ctx, 16384); release(); row.start = await response;
    assert.equal(row.start.status, 200); assert.equal(row.start.body.reused, false); await stop();
  });
  await check('foreign PID in the private receipt is rejected and the owned peer is reaped', async row => {
    prepare('wrong-pid'); const response = launch(); row.loading = await loading(); release();
    row.start = await response; assert.equal(row.start.status, 409); assert.equal(row.start.body.ok, false);
    await stopped(); assert.equal(exists(row.loading.residentPid), false);
  });
  await check('replacement of a model during loading rejects the stale prepared launch', async row => {
    prepare(); const response = launch(); row.loading = await loading();
    await until(() => fs.existsSync(path.join(engine, 'fixture-entered')), 'peer did not open the original files');
    fixture(path.join(engine, model), 'new fixture contents invalidate the admitted file identity');
    release(); row.start = await response;
    assert.equal(row.start.status, 409); await stopped(); assert.equal(exists(row.loading.residentPid), false);
    assert.equal(fs.readFileSync(path.join(engine, model), 'utf8'), 'new fixture contents invalidate the admitted file identity');
  });
  await check('a foreign listener is neither adopted nor stopped, even with force', async row => {
    const foreign = net.createServer(socket => socket.end());
    await new Promise((resolve, reject) => { foreign.once('error', reject); foreign.listen(enginePort, '127.0.0.1', resolve); });
    try {
      const before = fs.readFileSync(path.join(engine, 'fixture-launches'), 'utf8');
      row.start = await launch({ force: true }); assert.equal(row.start.status, 409);
      assert.equal(row.start.body.ok, false); assert.equal(foreign.listening, true);
      assert.equal(fs.readFileSync(path.join(engine, 'fixture-launches'), 'utf8'), before);
      assert.equal((await state()).ready, false);
    } finally { await new Promise(resolve => foreign.close(resolve)); }
  });
  await check('unexpected owned process exit cannot leave a ready model or trigger external reuse', async row => {
    prepare(); const response = launch(); await loading(); release();
    assert.equal((await response).status, 200); row.before = await state();
    process.kill(row.before.residentPid, 'SIGTERM'); row.after = await stopped();
    assert.equal(row.after.ready, false);
    // EOF and waitpid are independent observations of the same SIGTERM exit.
    // Either may arrive first; both must leave a visible failure and no ready PID.
    assert.ok(['Qwen owner channel closed', 'The owned Qwen inference process exited unexpectedly']
      .includes(row.after.engineError));
  });
  await check('a peer ignoring owner closure is escalated only by its owning host', async row => {
    prepare('ignore-close'); const response = launch(); row.loading = await loading();
    await until(() => fs.existsSync(path.join(engine, 'fixture-entered')), 'peer did not acquire its lifetime lease');
    assert.equal((await request('/api/stop', {}, 1000)).status, 200);
    assert.equal(await installationLease('exclusive'), false, 'Stop admission is not actual engine exit');
    assert.equal((await response).status, 409);
    await stopped(); assert.equal(exists(row.loading.residentPid), false);
    assert.equal(await installationLease('exclusive'), true);
  });
  await check('host crash during a partial HTTP upload cannot leak ownership through the relay', async row => {
    prepare('hold-upload'); const response = launch(); await loading(); release(); assert.equal((await response).status, 200);
    row.resident = (await state()).residentPid;
    const client = net.createConnection({ host: '127.0.0.1', port });
    client.on('error', () => {});
    let feeding;
    try {
      await new Promise(resolve => client.once('connect', resolve));
      client.write('POST /v1/chat/completions HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: 4096\r\n\r\n{');
      feeding = setInterval(() => { if (!client.destroyed) client.write(' '); }, 80);
      await until(() => fs.existsSync(path.join(engine, 'fixture-upload')), 'relay did not deliver the partial upload');
      assert.equal((await request('/api/status', undefined, 1000)).body.ready, true);
      host.kill('SIGKILL'); await hostExit;
      await until(() => fs.existsSync(path.join(engine, 'fixture-owner-closed')), 'peer did not observe its owner crash');
      assert.equal(exists(row.resident), true, 'drain barrier must hold the actual child alive');
      assert.equal(await installationLease('exclusive'), false, 'host death must not release the live child lease');
      fixture(path.join(engine, 'fixture-drain-release'), 'release\n');
      await until(() => !exists(row.resident), 'owned peer survived its parent crash while the relay retained a descriptor', 4000);
      assert.equal(await installationLease('exclusive'), true, 'a relay inherited and leaked the engine lease');
    } finally {
      fixture(path.join(engine, 'fixture-drain-release'), 'release\n');
      clearInterval(feeding);
      client.destroy();
      await until(() => !exists(row.resident), 'test-owned peer did not terminate after relay cleanup');
    }
  });
  report.passed = true;
} catch (error) { report.error = error.stack; process.exitCode = 1; }
finally {
  if (host.exitCode === null && host.signalCode === null) {
    try { await request('/api/stop', {}); await stopped(); } catch {}
    host.kill('SIGTERM'); await Promise.race([hostExit, sleep(5000)]);
    if (host.exitCode === null && host.signalCode === null) { host.kill('SIGKILL'); await hostExit; }
  }
  report.finished = new Date().toISOString();
  fs.writeFileSync(path.join(run, 'results.json'), JSON.stringify(report, null, 2));
  console.log(`${report.passed ? 'PASS' : 'FAIL'} ${report.cases.filter(c => c.passed).length}/${report.cases.length}: ${run}`);
  if (report.error) console.error(report.error);
}

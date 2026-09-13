// Real launcher HTTP and subprocess control, with deliberately blocked builders.
// Fixture checkpoint bytes and scripts are not model inference or quality tests.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { freePort, sleep, csrfHeaders } from '../support/real_harness.mjs';

const root = path.resolve('tests/.artifacts/launch-control');
fs.mkdirSync(root, { recursive: true });
const run = fs.mkdtempSync(path.join(root, 'http-'));
const engine = path.join(run, 'engine with spaces');
const assets = path.join(run, 'assets with spaces');
const workspace = path.join(run, 'workspace');
for (const dir of [engine, assets, workspace]) fs.mkdirSync(dir);
const binary = path.resolve(process.argv[2] || 'tests/.build/dstudio-server-test');
const report = { schema: 'dstudio.launch-control.v1',
  scope: 'Real native HTTP and process lifecycle; simulated builders, no inference',
  started: new Date().toISOString(), binarySHA256: crypto.createHash('sha256')
    .update(fs.readFileSync(binary)).digest('hex'), cases: [] };
const port = await freePort(), base = `http://127.0.0.1:${port}`;
const log = fs.openSync(path.join(run, 'host.log'), 'wx');
const child = spawn(binary, [String(port), engine], {
  cwd: process.cwd(), detached: true, stdio: ['ignore', log, log],
  env: { ...process.env, DS4UI_DATA_DIR: path.join(run, 'profile'),
    DS4UI_NO_WINDOW: '1', DS4UI_TEST_MODE: '1', DS4UI_DEFER_ENGINE_START: '1',
    DS4UI_HOST: '127.0.0.1' },
});
fs.closeSync(log);
const exited = new Promise(resolve => { child.once('exit', resolve); child.once('error', resolve); });
async function request(endpoint, body, timeout = 3000) {
  const res = await fetch(base + endpoint, { method: body === undefined ? 'GET' : 'POST',
    headers: csrfHeaders, body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeout) });
  return { status: res.status, body: await res.json() };
}
async function until(check, message, requireHost = true) {
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    if (await check()) return;
    if (requireHost) {
      assert.equal(child.exitCode, null, 'launcher exited before the barrier');
      assert.equal(child.signalCode, null, 'launcher was killed before the barrier');
    }
    await sleep(50);
  }
  throw new Error(message);
}
function fixture(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}
const ownedState = s => Object.fromEntries(['running', 'mode', 'modelFile', 'variant',
  'skill', 'designSystem', 'config', 'workdir'].map(k => [k, s[k]]));
try {
  await until(async () => { try { return (await request('/api/status')).status === 200; }
    catch { return false; } }, 'launcher did not listen');
  const initial = (await request('/api/status')).body;
  assert.equal(initial.running, false);
  fixture(path.join(engine, 'Makefile'), 'all:\n\t@false\n');
  assert.ok(initial.modelFile && !path.isAbsolute(initial.modelFile) && !initial.modelFile.includes('..'));
  fixture(path.join(engine, initial.modelFile), 'fixture only, not model weights\n');
  for (const file of ['DESIGN.md', 'tokens.css', 'components.html', 'assets/preview.js', 'references/recipes.md'])
    fixture(path.join(assets, 'extension/design-systems/folio', file), 'Complete fixture\n');
  for (const script of ['apply-ds4-glm53-m2max.sh', 'apply-ds4-vision-streaming.sh'])
    fixture(path.join(assets, 'scripts', script), '#!/bin/sh\nexit 0\n');
  const gate = path.join(engine, 'prepare-gate'), entered = path.join(engine, 'prepare-entered');
  assert.equal(spawnSync('mkfifo', [gate]).status, 0);
  fixture(path.join(assets, 'extension/design/build-design.sh'),
    '#!/bin/sh\nprintf "%s\\n" "$$" > "$DS4_DIR/prepare-entered"\n' +
    'IFS= read -r release < "$DS4_DIR/prepare-gate"\nexit 87\n');
  assert.equal((await request('/api/webdir', { path: assets })).status, 200);
  const row = { name: 'blocked preparation leaves status responsive and owned state unchanged' };
  const before = (await request('/api/status')).body;
  const start = request('/api/start', { mode: 'design', designSystem: 'folio', workdir: workspace }, 15000)
    .catch(error => ({ error: error.message }));
  let reached = false;
  try {
    await until(() => fs.existsSync(entered), 'build did not reach its explicit barrier');
    reached = true;
    row.builderPid = Number(fs.readFileSync(entered, 'utf8').trim());
    row.whileBlocked = await request('/api/status', undefined, 1000);
    assert.equal(row.whileBlocked.status, 200, 'control request must finish before the build is released');
    assert.deepEqual(ownedState(row.whileBlocked.body), ownedState(before),
      'preparation published candidate settings before successful completion');
    row.status = 'PASS';
  } catch (error) { row.status = 'FAIL'; row.error = error.message; }
  finally {
    if (reached) fs.writeFileSync(gate, 'release\n');
    row.start = await start;
  }
  assert.equal(row.start.status, 409, 'deliberate build failure cannot become a successful launch');
  report.cases.push(row);
  console.log(`${row.name}: ${row.status}${row.error ? ': ' + row.error : ''}`);

  async function checkCase(name, fn) {
    const evidence = { name };
    try { await fn(evidence); evidence.status = 'PASS'; }
    catch (error) { evidence.status = 'FAIL'; evidence.error = error.stack; }
    report.cases.push(evidence);
    console.log(`${name}: ${evidence.status}${evidence.error ? ': ' + evidence.error : ''}`);
    return evidence.status === 'PASS';
  }
  const pidPath = path.join(engine, 'engine-pid');
  const receivedPath = path.join(engine, 'engine-inputs');
  // A real executable consuming the native stdin pipe. It never opens weights.
  // Ignore TERM to exercise the launcher's bounded escalation, with no shell children.
  fixture(path.join(engine, 'ds4-design'), '#!/bin/sh\ntrap "" TERM\n' +
    'printf "%s\\n" "$$" > engine-pid\nprintf "+DWARFSTAR_WAITING\\n" >&2\n' +
    'while IFS= read -r line; do\n' +
    '  printf "%s\\n" "$line" >> engine-inputs\n' +
    '  printf "ack: %s\\n" "$line"\nprintf "+DWARFSTAR_WAITING\\n" >&2\n' +
    'done\n');
  fs.chmodSync(path.join(engine, 'ds4-design'), 0o755);
  fixture(path.join(assets, 'extension/design/build-design.sh'), '#!/bin/sh\nexit 0\n');
  let enginePid;
  const started = await checkCase('prepared executable starts only through the native owner', async evidence => {
    evidence.start = await request('/api/start', { mode: 'design', designSystem: 'folio', workdir: workspace }, 15000);
    assert.equal(evidence.start.status, 200);
    assert.ok(evidence.start.body.taskId);
    await until(async () => (await request('/api/status')).body.ready, 'fixture engine did not become ready');
    enginePid = Number(fs.readFileSync(pidPath, 'utf8').trim());
    assert.ok(enginePid > 0);
    evidence.task = (await request('/api/task?id=' + evidence.start.body.taskId)).body.task;
    assert.equal(evidence.task.status, 'completed');
    assert.equal(evidence.task.pid, enginePid, 'readiness must belong to the launched process');
    evidence.enginePid = enginePid;
  });
  assert.ok(started, 'remaining live-process tests require the fixture runtime');
  let attempt = 0;
  async function blockedBuild(exitCode = 0, extra = {}) {
    const id = ++attempt;
    const input = path.join(engine, `gate-${id}`), marker = path.join(engine, `entered-${id}`);
    assert.equal(spawnSync('mkfifo', [input]).status, 0);
    fixture(path.join(assets, 'extension/design/build-design.sh'),
      `#!/bin/sh\nprintf "%s\\n" "$$" > "$DS4_DIR/entered-${id}"\n` +
      `IFS= read -r release < "$DS4_DIR/gate-${id}"\nexit ${exitCode}\n`);
    const before = (await request('/api/status')).body;
    const response = request('/api/start', { mode: 'design', designSystem: 'folio',
      workdir: workspace, ctx: 32768, launchRequestId: `native-attempt-${id}`, ...extra }, 15000).catch(error => ({ error: error.message }));
    await until(() => fs.existsSync(marker), 'builder did not reach barrier');
    const state = (await request('/api/status')).body;
    const builderPid = Number(fs.readFileSync(marker, 'utf8').trim());
    const helperPid = Number(spawnSync('ps', ['-p', String(builderPid), '-o', 'ppid='], { encoding: 'utf8' }).stdout.trim());
    assert.equal(state.launchRequestId, `native-attempt-${id}`);
    let released = false;
    const release = () => {
      if (released) return;
      // A dead reader must fail this test, never hang its cleanup in FIFO open.
      const fd = fs.openSync(input, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK);
      try { fs.writeSync(fd, 'release\n'); released = true; } finally { fs.closeSync(fd); }
    };
    return { before, state, response, builderPid, helperPid, release };
  }
  const processExists = pid => { try { process.kill(pid, 0); return true; } catch (e) { if (e.code === 'ESRCH') return false; throw e; } };
  async function echoCurrent(evidence) {
    const probe = `owner-echo-${crypto.randomUUID()}`;
    evidence.echo = await request('/api/agent/send', { prompt: probe, orchestration: 'direct' }, 1000);
    assert.equal(evidence.echo.status, 200, 'current runtime must accept an actual turn during preparation');
    await until(() => fs.existsSync(receivedPath) && fs.readFileSync(receivedPath, 'utf8').includes(probe), 'current runtime did not consume its stdin');
    await until(async () => !(await request('/api/status')).body.agentWorking, 'echo turn did not finish');
    assert.equal(fs.readFileSync(receivedPath, 'utf8').split(probe).length - 1, 1, 'one send must have one effect');
    assert.equal(Number(fs.readFileSync(pidPath, 'utf8').trim()), enginePid);
    assert.ok(processExists(enginePid));
  }
  await checkCase('failed preparation preserves a responsive existing engine and its settings', async evidence => {
    const pending = await blockedBuild(87);
    try {
      assert.deepEqual(ownedState(pending.state), ownedState(pending.before));
      await echoCurrent(evidence);
      pending.release();
      evidence.start = await pending.response;
      assert.equal(evidence.start.status, 409);
      assert.deepEqual(ownedState((await request('/api/status')).body), ownedState(pending.before));
      assert.equal((await request('/api/task?id=' + evidence.start.body.taskId)).body.task.status, 'failed');
      assert.ok(processExists(enginePid));
    } finally { if (processExists(pending.builderPid)) pending.release(); }
  });
  let canceledTask;
  await checkCase('cancel is task-specific, reaps the builder group and preserves the existing engine', async evidence => {
    const pending = await blockedBuild();
    const id = pending.state.launchTaskId;
    assert.ok(id); canceledTask = id;
    evidence.worker = { builder: pending.builderPid, helper: pending.helperPid };
    evidence.wrongCancel = await request('/api/start/cancel', { taskId: id + 999 }, 1000);
    assert.equal(evidence.wrongCancel.status, 409);
    assert.equal((await request('/api/status')).body.launchTaskId, id);
    evidence.cancel = await request('/api/start/cancel', { taskId: id }, 1000);
    assert.equal(evidence.cancel.status, 200);
    evidence.start = await pending.response;
    assert.equal(evidence.start.body.code, 'launch_canceled');
    await until(async () => !(await request('/api/status')).body.launchTaskId, 'canceled preparation was not retired');
    assert.ok(!processExists(pending.builderPid) && !processExists(pending.helperPid), 'preparation left an orphan');
    assert.equal((await request('/api/task?id=' + id)).body.task.status, 'canceled');
    assert.deepEqual(ownedState((await request('/api/status')).body), ownedState(pending.before));
    await echoCurrent(evidence);
  });
  await checkCase('duplicates and late cancellation cannot replace or cancel a newer candidate', async evidence => {
    const pending = await blockedBuild(87);
    try {
      const tasks = (await request('/api/tasks')).body.tasks;
      evidence.duplicate = await request('/api/start', { mode: 'design', designSystem: 'folio', workdir: workspace }, 1000);
      assert.equal(evidence.duplicate.body.code, 'launch_busy');
      assert.deepEqual((await request('/api/tasks')).body.tasks, tasks, 'duplicate must not admit another task');
      evidence.lateCancel = await request('/api/start/cancel', { taskId: canceledTask }, 1000);
      assert.equal(evidence.lateCancel.status, 200);
      assert.equal((await request('/api/status')).body.launchTaskId, pending.state.launchTaskId);
      evidence.assetChange = await request('/api/webdir', { path: assets }, 1000);
      assert.equal(evidence.assetChange.body.code, 'launch_busy');
      pending.release(); evidence.start = await pending.response;
      assert.equal(evidence.start.body.code, 'launch_prepare_failed');
    } finally { if (processExists(pending.builderPid)) pending.release(); }
  });
  await checkCase('a checkpoint changed behind a blocked build is rejected before stopping the old engine', async evidence => {
    const pending = await blockedBuild();
    try {
      fixture(path.join(engine, initial.modelFile), 'changed fixture bytes, still not weights\n');
      pending.release(); evidence.start = await pending.response;
      assert.equal(evidence.start.body.code, 'launch_stale');
      assert.deepEqual(ownedState((await request('/api/status')).body), ownedState(pending.before));
      await echoCurrent(evidence);
    } finally { if (processExists(pending.builderPid)) pending.release(); }
  });
  await checkCase('prepared switch keeps HTTP responsive through the old engine stop and binds readiness to its new PID', async evidence => {
    const previousPid = enginePid;
    const pending = await blockedBuild();
    pending.release();
    await until(async () => (await request('/api/status', undefined, 1000)).body.launchPhase === 'stopping',
      'switch did not expose its asynchronous stop phase');
    evidence.stopping = (await request('/api/status', undefined, 1000)).body;
    assert.deepEqual(evidence.stopping.config, pending.before.config, 'candidate config was published before old engine exit');
    assert.equal(evidence.stopping.ready, false);
    evidence.start = await pending.response;
    assert.equal(evidence.start.status, 200);
    await until(async () => (await request('/api/status')).body.ready, 'new executable did not reach readiness');
    enginePid = Number(fs.readFileSync(pidPath, 'utf8').trim());
    assert.notEqual(enginePid, previousPid);
    assert.ok(!processExists(previousPid));
    evidence.task = (await request('/api/task?id=' + evidence.start.body.taskId)).body.task;
    assert.equal(evidence.task.pid, enginePid);
    assert.equal(evidence.task.status, 'completed');
    assert.equal((await request('/api/status')).body.config.ctx, 32768);
    await echoCurrent(evidence);
  });
  await checkCase('stop remains observable while an engine ignores TERM, then escalates without blocking HTTP', async evidence => {
    evidence.stop = await request('/api/stop', {}, 1000);
    assert.equal(evidence.stop.status, 200);
    evidence.stopping = await request('/api/status', undefined, 1000);
    assert.equal(evidence.stopping.status, 200);
    assert.equal(evidence.stopping.body.ready, false);
    await until(async () => !(await request('/api/status')).body.running, 'TERM-resistant engine was not stopped');
    assert.ok(!processExists(enginePid));
  });
  await checkCase('cancel during engine loading stops only that launch and cannot be revived by a late ready marker', async evidence => {
    const gate = path.join(engine, 'fixture-loading-gate');
    assert.equal(spawnSync('mkfifo', [gate]).status, 0);
    fixture(path.join(assets, 'extension/design/build-design.sh'), '#!/bin/sh\nexit 0\n');
    fixture(path.join(engine, 'ds4-design'), '#!/bin/sh\n' +
      'trap "" TERM\n' +
      'printf "%s\\n" "$$" > engine-pid\n' +
      'IFS= read -r release < fixture-loading-gate\n' +
      'printf "+DWARFSTAR_WAITING\\nlistening on fixture-after-cancel\\nlate-readiness-consumed-sentinel\\n" >&2\n' +
      'while IFS= read -r line; do :; done\n');
    fs.chmodSync(path.join(engine, 'ds4-design'), 0o755);
    evidence.start = await request('/api/start', { mode: 'design', designSystem: 'folio', workdir: workspace }, 15000);
    assert.equal(evidence.start.status, 200);
    await until(() => Number(fs.readFileSync(pidPath, 'utf8').trim()) !== enginePid, 'fixture did not start loading');
    const loadingPid = Number(fs.readFileSync(pidPath, 'utf8').trim());
    const id = evidence.start.body.taskId;
    try {
    assert.equal((await request('/api/task?id=' + id)).body.task.status, 'working');
    assert.equal((await request('/api/status')).body.ready, false);
    evidence.wrongCancel = await request('/api/start/cancel', { taskId: id - 1 }, 1000);
    assert.equal(evidence.wrongCancel.status, 409);
    assert.ok(processExists(loadingPid));
    evidence.cancel = await request('/api/start/cancel', { taskId: id }, 1000);
    assert.equal(evidence.cancel.status, 200);
    const release = fs.openSync(gate, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK);
    try { fs.writeSync(release, 'release\n'); } finally { fs.closeSync(release); }
    await until(async () => (await request('/api/status', undefined, 1000)).body.engineLine === 'late-readiness-consumed-sentinel',
      'host did not consume the deliberately late readiness markers');
    evidence.afterLateMarker = (await request('/api/status')).body;
    assert.equal(evidence.afterLateMarker.ready, false, 'late readiness revived a canceled loading process');
    await until(async () => !(await request('/api/status', undefined, 1000)).body.running, 'canceled loading process was not reaped');
    assert.ok(!processExists(loadingPid));
    assert.equal((await request('/api/task?id=' + id)).body.task.status, 'canceled');
    assert.equal((await request('/api/status')).body.ready, false);
    assert.equal((await request('/api/start/cancel', { taskId: id })).status, 200, 'same cancellation receipt remains idempotent');
    } finally {
      if (processExists(loadingPid)) {
        await request('/api/stop', {}, 1000);
        await until(async () => !(await request('/api/status')).body.running,
          'failed loading assertion left its fixture runtime alive');
      }
    }
  });
  await checkCase('an encoder installed during preparation cannot silently change the launch candidate', async evidence => {
    const model = 'gguf/DeepSeek-V4-Flash-Vision-Exp-fixture.gguf';
    fixture(path.join(engine, model), 'fixture only, no inference\n');
    const before = (await request('/api/status')).body;
    const pending = await blockedBuild(0, { gguf: model });
    fixture(path.join(engine, 'gguf/DeepSeek-V4-Flash-Vision-Encoder.gguf'), 'new fixture encoder bytes\n');
    pending.release(); evidence.start = await pending.response;
    try {
      assert.equal(evidence.start.body.code, 'launch_stale');
      assert.deepEqual(ownedState((await request('/api/status')).body), ownedState(before));
    } finally {
      if ((await request('/api/status')).body.running) {
        await request('/api/stop', {});
        await until(async () => !(await request('/api/status')).body.running, 'test cleanup could not stop its fixture');
      }
    }
  });
  await checkCase('host death closes the preparation lease and leaves no builder or worker alive', async evidence => {
    const pending = await blockedBuild(87);
    evidence.pids = { host: child.pid, worker: pending.helperPid, builder: pending.builderPid };
    process.kill(child.pid, 'SIGKILL'); // Exact task-owned host, not the user app.
    await exited;
    evidence.start = await pending.response;
    await until(() => !processExists(pending.helperPid) && !processExists(pending.builderPid),
      'preparation outlived its dead host', false);
    assert.equal(child.signalCode, 'SIGKILL');
  });
} catch (error) {
  report.cases.push({ name: 'test infrastructure', status: 'FAIL', error: error.stack });
} finally {
  if (child.exitCode === null && child.signalCode === null && child.pid) {
    try { process.kill(-child.pid, 'SIGTERM'); } catch {}
    await Promise.race([exited, sleep(3000)]);
    if (child.exitCode === null && child.signalCode === null) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch {}
      await exited;
    }
  }
  report.status = report.cases.length && report.cases.every(c => c.status === 'PASS') ? 'PASS' : 'FAIL';
  report.finished = new Date().toISOString();
  fs.writeFileSync(path.join(run, 'results.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(`Preserved launch-control evidence: ${run}`);
}
process.exitCode = report.status === 'PASS' ? 0 : 1;

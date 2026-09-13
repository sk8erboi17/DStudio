// Actual startup without DS4UI_TEST_MODE. Inference is explicitly deferred;
// tiny source fixtures test recovery admission, not compilation/model quality.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {artifactRunDir, freePort, sleep, writeArtifact} from '../support/real_harness.mjs';

assert.notEqual(process.platform, 'win32', 'POSIX startup gate: Windows NOT RUN');
const binary = fs.realpathSync(process.argv[2] || 'tests/.build/dstudio-server-test');
const run = artifactRunDir('engine-startup');
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const report = {started: new Date().toISOString(), binary, binarySHA256: hash(binary),
  scope: 'Production startup and persisted checkout, real HTTP; fixture sources, no model or network download',
  plannedChecks: 4, cases: []};
const save = () => writeArtifact(run, 'results.json', report);
console.log(`Evidence: ${run}`);
let active, cancelled = false;
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => {
  cancelled = true; active?.kill('SIGTERM');
});
const scenarios = [
  {id: 'q36-without-ds4-agent', checkout: 'q36'},
  {id: 'native-clean', checkout: 'ds4-qwen35', source: '/* Independent native source fixture. */\n'},
  {id: 'native-missing', checkout: 'ds4-qwen35', error: /ds4_agent\.c/},
  {id: 'native-legacy-patched', checkout: 'ds4-qwen35', source: '/*DS4UI_JSONL*/\n',
    backup: '/* Preserve the earlier source until explicitly verified. */\n', error: /legacy Agent source is already modified/},
];
for (const scenario of scenarios) {
  const row = {id: scenario.id, status: 'NOT_RUN'}; report.cases.push(row); save();
  if (cancelled) continue;
  const directory = path.join(run, scenario.id), engine = path.join(directory, scenario.checkout);
  const profile = path.join(directory, 'profile');
  fs.mkdirSync(engine, {recursive: true}); fs.mkdirSync(profile);
  fs.writeFileSync(path.join(engine, 'Makefile'), 'all:\n\t@false\n');
  if (scenario.source) fs.writeFileSync(path.join(engine, 'ds4_agent.c'), scenario.source);
  if (scenario.backup) fs.writeFileSync(path.join(engine, 'ds4_agent.c.bak'), scenario.backup);
  fs.writeFileSync(path.join(profile, 'engine-checkout'), engine + '\n');
  const files = () => Object.fromEntries(fs.readdirSync(engine).sort().map(name => [name, hash(path.join(engine, name))]));
  const before = files(), port = await freePort(), base = `http://127.0.0.1:${port}`;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(DS4|DSTUDIO_|Q36_|DYLD_|LD_)/.test(key)));
  Object.assign(env, {DS4UI_DATA_DIR: profile, DS4UI_DEFER_ENGINE_START: '1', DS4UI_HOST: '127.0.0.1'});
  const log = fs.openSync(path.join(directory, 'host.log'), 'wx');
  const child = spawn(binary, [String(port)], {cwd: process.cwd(), env, stdio: ['ignore', log, log]});
  fs.closeSync(log); active = child;
  const terminal = new Promise(resolve => {
    child.once('exit', (code, signal) => resolve({code, signal}));
    child.once('error', error => resolve({error: error.message}));
  });
  try {
    let state;
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline && !cancelled) {
      try {
        const response = await fetch(base + '/api/status', {signal: AbortSignal.timeout(1000)});
        assert.equal(response.status, 200); state = await response.json(); break;
      } catch (error) {
        if (child.exitCode !== null || child.signalCode !== null) throw error;
        await sleep(25);
      }
    }
    assert(state && !cancelled, 'Owned startup did not become observable');
    row.state = state;
    assert.equal(state.ds4dir, engine, 'persisted checkout must be used');
    assert.equal(state.running, false, 'deferred startup must not load a model');
    assert.equal(state.ready, false);
    if (scenario.error) assert.match(state.engineError, scenario.error, 'native recovery errors must remain visible');
    else assert.equal(state.engineError, '', 'an independent engine must not receive ds4 Agent recovery');
    assert.deepEqual(files(), before, 'startup must preserve the source and any unverified backup');
    row.status = 'PASS';
  } catch (error) {row.status = 'FAIL'; row.error = error.stack;}
  finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    let timer;
    row.exit = await Promise.race([terminal, new Promise(resolve => {timer = setTimeout(() => resolve(null), 5000);})]);
    clearTimeout(timer);
    if (!row.exit) {child.kill('SIGKILL'); row.exit = await terminal; row.status = 'FAIL'; row.cleanupError = 'graceful shutdown exceeded its deadline';}
    if (row.exit.code !== 0) {row.status = 'FAIL'; row.cleanupError ||= 'host did not exit successfully';}
    active = null; save(); console.log(`${row.status} ${scenario.id}`);
  }
}
report.finished = new Date().toISOString();
report.passed = !cancelled && report.cases.every(row => row.status === 'PASS');
assert.equal(hash(binary), report.binarySHA256, 'host binary changed during the test');
save(); process.exitCode = report.passed ? 0 : 1;

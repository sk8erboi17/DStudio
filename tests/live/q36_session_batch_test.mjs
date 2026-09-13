// Execute the pinned upstream 1/2/4/8-session oracle with actual 27B weights.
// The Vulkan-named test uses the existing Metal test-compatibility entrypoint;
// it is not Vulkan qualification, HTTP scheduling, answer quality or a benchmark.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {spawn, spawnSync} from 'node:child_process';
import {artifactRunDir, writeArtifact} from '../support/real_harness.mjs';
import {fileIdentity, hashStableFile} from '../support/quality_baseline.mjs';

const run = artifactRunDir('q36-session-batch');
const report = {started: new Date().toISOString(), status: 'FAIL', inputs: {}, commands: [], phases: [],
  scope: 'Pinned upstream native batch oracle, real Qwen27B/Metal; no desktop, HTTP, general quality or speed claim',
  host: {platform: os.platform(), arch: os.arch(), cpu: os.cpus()[0]?.model, memory: os.totalmem()},
  settings: {context: 512, prefill: 8, quality: false, residentWeights: true,
    expertStreaming: false, batchSizes: [1, 2, 4, 8], kvModes: ['f16/f16', 'q8_0/q4_0']},
  limits: {phaseSeconds: 600, outputBytes: 4 * 1024 * 1024, maxAbsLogitError: 0.25}};
const save = () => writeArtifact(run, 'results.json', report);
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(Q36_|DS4|DSTUDIO_|DYLD_|MAKEFLAGS$|MFLAGS$)/.test(k)));
env.NO_COLOR = '1';
let child, current, escalation, timer, watcher, interrupted = false, model, weight;
function stop(reason) {
  if (current) current.stopReason ||= reason;
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  // The unreaped direct child pins this test-owned process group.
  try {process.kill(-child.pid, 'SIGTERM');} catch (e) {if (e.code !== 'ESRCH') throw e;}
  escalation ||= setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null)
      try {process.kill(-child.pid, 'SIGKILL');} catch (e) {if (e.code !== 'ESRCH') throw e;}
  }, 5000);
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {interrupted = true; stop(signal);});
function idle() {
  const p = spawnSync('/bin/ps', ['-axo', 'pid=,comm='], {encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024});
  assert.equal(p.status, 0, 'Process ownership observation failed');
  const active = p.stdout.split('\n').filter(line =>
    /\/(?:ds4(?:[-_][^/\s]+)?|q36(?:[-_][^/\s]+)?|q27)(?:\s|$)|\/DStudio\.app\/Contents\/MacOS\/DStudio$/.test(line) &&
    Number(line.trim().split(/\s+/)[0]) !== child?.pid);
  assert.deepEqual(active, [], 'Another app/engine is running; nothing unrelated was stopped');
}
function compile(args, cwd) {
  const r = spawnSync('cc', args, {cwd, env, encoding: 'utf8', timeout: 120000, maxBuffer: report.limits.outputBytes});
  report.commands.push({argv: ['cc', ...args], code: r.status, stdout: r.stdout, stderr: r.stderr, error: r.error?.message});
  save(); assert.equal(r.status, 0, r.stderr || r.error?.message);
}
async function phase(mode, binary, engine) {
  idle(); assert(!interrupted, 'Cancelled before model load');
  current = {mode, status: 'FAIL', argv: [binary, '--model', model, '--vulkan-session-batch']};
  report.phases.push(current); save();
  let out = '', err = '', bytes = 0;
  const start = performance.now();
  child = spawn(binary, current.argv.slice(1), {cwd: engine, env: {...env, Q36_TEST_BATCH_KV: mode},
    detached: true, stdio: ['ignore', 'pipe', 'pipe']});
  current.pid = child.pid; save();
  const terminal = new Promise(resolve => {
    child.once('error', error => resolve({error: String(error)}));
    child.once('close', (code, signal) => resolve({code, signal}));
  });
  for (const [stream, stderr] of [[child.stdout, false], [child.stderr, true]]) stream.on('data', data => {
    bytes += data.length;
    if (bytes > report.limits.outputBytes) return stop('Output bound exceeded');
    if (stderr) err += data; else out += data;
    process.stderr.write(data);
  });
  timer = setTimeout(() => stop('Phase deadline'), report.limits.phaseSeconds * 1000);
  watcher = setInterval(() => {try {idle();} catch {stop('Resource ownership lost or observation failed');}}, 1000);
  current.exit = await terminal; current.seconds = (performance.now() - start) / 1000;
  clearTimeout(timer); clearInterval(watcher); clearTimeout(escalation); escalation = null;
  child = null;
  fs.writeFileSync(path.join(run, mode + '.stdout'), out, {flag: 'wx'});
  fs.writeFileSync(path.join(run, mode + '.stderr'), err, {flag: 'wx'});
  // Preserve every measured row even when the native oracle rejects the run.
  current.logitRows = [...err.matchAll(/session batch rows=(\d+) item=(\d+) max_abs=(\S+) rms=(\S+)/g)]
    .map(m => ({rows: Number(m[1]), item: Number(m[2]), maxAbs: Number(m[3]), rms: Number(m[4])}));
  try {
    // Independent coverage check: the upstream suite can print OK after SKIP.
    assert(!current.stopReason && !interrupted, current.stopReason);
    assert.equal(current.exit.code, 0, 'Native upstream assertion failed; original output retained');
    assert.equal(current.exit.signal, null);
    assert(!/\bSKIP\b/.test(out + err), 'Skipped native execution is not a pass');
    assert.match(err, /Metal device/);
    const expected = [1, 2, 4, 8].flatMap(rows => Array.from({length: rows}, (_, item) => ({rows, item})));
    assert.deepEqual(current.logitRows.map(({rows, item}) => ({rows, item})), expected);
    assert(current.logitRows.every(r => Number.isFinite(r.maxAbs) && r.maxAbs <= 0.25 && Number.isFinite(r.rms)));
    for (const rows of [2, 4, 8]) assert.match(err, new RegExp('metal session batch rows=' + rows + ' native=1'));
    assert.match(err, /session batch rows=2 native=0 ordered=1/);
    assert.match(out, /q36 tests: ok/);
    current.status = 'PASS';
  } catch (e) {current.error = String(e.stack || e);}
  save(); console.log(`${current.status}: upstream batch ${mode}`);
  current = null;
}
console.log('Evidence: ' + run); save();
try {
  assert.equal(process.argv.length, 4, 'Supply installed q36 source and existing Qwen27B weights');
  assert.equal(process.platform, 'darwin', 'Metal unavailable: NOT RUN');
  const engine = fs.realpathSync(process.argv[2]); model = fs.realpathSync(process.argv[3]); idle();
  report.installation = JSON.parse(fs.readFileSync(path.join(engine, '.dstudio-source.json'), 'utf8'));
  assert.equal(report.installation.commit, 'd67687ed15ad9f52b755a9b5fdfc0214ea937555');
  assert.equal(report.installation.backend, 'metal');
  for (const [name, expected] of Object.entries(report.installation.sources)) {
    const file = path.join(engine, name); assert.equal(hash(file), expected, 'Native source drift: ' + name);
    report.inputs[file] = expected;
  }
  report.inputs[import.meta.filename] = hash(import.meta.filename);
  fs.copyFileSync(import.meta.filename, path.join(run, 'harness.mjs'), fs.constants.COPYFILE_EXCL);
  const source = path.join(engine, 'tests/q36_test.c');
  report.inputs[source] = hash(source);
  fs.copyFileSync(source, path.join(run, 'upstream-test.c'), fs.constants.COPYFILE_EXCL);
  weight = await hashStableFile(model); report.weight = weight;
  assert.equal(fs.statSync(model).size, 25299061664);
  assert.equal(weight.sha256, '701d8fa9ed214ab21bfc130cd2a7df19ca89bbef7713e2dfb19f3c63696aa917');
  const flags = ['-O3', '-ffast-math', '-mcpu=apple-m1', '-mmacosx-version-min=11.0', '-Wall', '-Wextra',
    '-std=c99', '-D_GNU_SOURCE', '-fno-finite-math-only', '-I', engine];
  const metal = path.join(run, 'q36_metal.o'), binary = path.join(run, 'q36-upstream-batch');
  compile([...flags, '-fobjc-arc', '-c', path.join(engine, 'q36_metal.m'), '-o', metal], engine);
  compile([...flags, '-DQ36_METAL', '-DQ36_METAL_TEST_COMPAT', '-Wno-unused-function', source,
    ...['q36.c', 'rax.c', 'q36_ssd.c', 'q36_image.c'].map(f => path.join(engine, f)), metal,
    '-lm', '-pthread', '-framework', 'Foundation', '-framework', 'Metal', '-o', binary], engine);
  report.binarySHA256 = hash(binary); save();
  for (const mode of ['f16', 'q8q4']) await phase(mode, binary, engine);
  assert(report.phases.length === 2 && report.phases.every(p => p.status === 'PASS'), 'Native batch qualification failed');
  report.status = 'PASS';
} catch (e) {report.error = String(e.stack || e); console.error(report.error); process.exitCode = 1;}
finally {
  clearTimeout(timer); clearInterval(watcher);
  if (child && child.exitCode === null && child.signalCode === null) {
    stop('Harness cleanup'); await new Promise(resolve => child.once('close', resolve));
  }
  clearTimeout(escalation);
  for (const [file, expected] of Object.entries(report.inputs)) if (!fs.existsSync(file) || hash(file) !== expected) {
    report.status = 'FAIL'; report.changedInput = file; process.exitCode = 1;
  }
  if (weight && fileIdentity(fs.statSync(model, {bigint: true})) !== weight.identity) {
    report.status = 'FAIL'; report.changedWeight = true; process.exitCode = 1;
  }
  report.finished = new Date().toISOString(); save(); console.log(JSON.stringify({run, status: report.status}));
}

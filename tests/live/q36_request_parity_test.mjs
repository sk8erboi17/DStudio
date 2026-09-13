// Explicit native CPU then Metal diagnostic for the retained failing request.
// No downloads, HTTP listeners, upstream Agent, external inference oracle or UI.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {spawn, spawnSync} from 'node:child_process';
import {artifactRunDir, writeArtifact} from '../support/real_harness.mjs';
import {fileIdentity, hashStableFile} from '../support/quality_baseline.mjs';

const root = path.resolve(import.meta.dirname, '../..');
assert.equal(process.argv.length, 4, 'Supply a prepared q36 installation and the pinned Qwen27B GGUF');
assert.equal(process.platform, 'darwin', 'This test qualifies native CPU/Metal only');
const [engine, model] = process.argv.slice(2).map(f => fs.realpathSync(f));
const run = artifactRunDir('q36-request-parity'), binary = path.join(run, 'probe');
const request = path.join(root, 'tests/fixtures/qwen27-code-request.json');
const probe = path.join(root, 'tests/support/q36_request_parity_probe.c');
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const report = {started: new Date().toISOString(), status: 'fail',
  scope: 'Retained failing HTTP prompt through its actual parser and native CPU/Metal core; development diagnosis, not held-out quality or independent architecture parity',
  host: {platform: os.platform(), arch: os.arch(), cpu: os.cpus()[0]?.model, memoryBytes: os.totalmem()},
  limits: {seconds: 900, outputBytes: 4 * 1024 * 1024, context: 8192, decodeSteps: 4, cpuThreads: 8},
  settings: {quality: true, cacheTypeK: 'f16', cacheTypeV: 'f16', prefillChunk: 512,
    expertStreaming: false, thinking: false, sampling: 'greedy', simultaneousEngines: 1},
  inputs: {}, commands: [], rows: []};
const save = () => writeArtifact(run, 'results.json', report);
const environment = Object.fromEntries(Object.entries(process.env)
  .filter(([name]) => !/^(Q36_|DS4|DSTUDIO_|DYLD_|MAKEFLAGS$|MFLAGS$)/.test(name)));
let child = null, timeout = null, escalation = null, interrupted = false;
function terminate(reason) {
  if (reason) report.stopReason ||= reason;
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try {process.kill(-child.pid, 'SIGTERM');} catch (e) {if (e.code !== 'ESRCH') throw e;}
  escalation ||= setTimeout(() => {
    if (child && child.exitCode === null && child.signalCode === null) {
      try {process.kill(-child.pid, 'SIGKILL');} catch (e) {if (e.code !== 'ESRCH') throw e;}
    }
  }, 5000);
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  interrupted = true; terminate(signal);
});
function command(executable, args) {
  const result = spawnSync(executable, args, {cwd: engine, env: environment,
    encoding: 'utf8', timeout: 120000, maxBuffer: report.limits.outputBytes});
  report.commands.push({executable, args, status: result.status, signal: result.signal,
    stdout: result.stdout, stderr: result.stderr, error: result.error?.message}); save();
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return result.stdout;
}
function idle() {
  const active = command('/bin/ps', ['-axo', 'pid=,comm=']).split('\n').filter(line =>
    /\/(?:ds4|ds4-server|ds4-agent|ds4-agent-jsonl|ds4-cowork|ds4-design|q36|q36-server|q36_test|q27)(?:\s|$)/.test(line));
  assert.equal(active.length, 0, 'Another inference process is running; nothing was stopped: ' + active.join('\n'));
  assert(!interrupted, 'Interrupted before native launch');
}
console.log('Evidence: ' + run); save();
try {
  idle();
  report.installation = JSON.parse(fs.readFileSync(path.join(engine, '.dstudio-source.json'), 'utf8'));
  assert.equal(report.installation.engine, 'q36');
  assert.equal(report.installation.commit, 'd67687ed15ad9f52b755a9b5fdfc0214ea937555');
  assert.equal(report.installation.backend, 'metal');
  for (const [name, expected] of Object.entries(report.installation.sources)) {
    const file = path.join(engine, name);
    assert.equal(hash(file), expected, 'Installed source drift: ' + name); report.inputs[file] = expected;
  }
  for (const file of [request, probe, import.meta.filename]) report.inputs[file] = hash(file);
  const pins = JSON.parse(command('python3', [path.join(root, 'scripts/download-qwen27.py'), '--manifest']));
  assert.equal(fs.statSync(model).size, pins.files.model.bytes);
  report.model = {file: model, ...await hashStableFile(model), repository: pins.repository, revision: pins.revision};
  assert.equal(report.model.sha256, pins.files.model.sha256); save();
  const objects = ['q36_gpu_core_metal.o', 'q36_metal.o', 'q36_image.o', 'q36_ssd.o', 'rax.o']
    .map(f => path.join(engine, f));
  for (const file of objects) report.inputs[file] = hash(file);
  command('cc', ['-std=c11', '-O2', '-Wall', '-Wextra', '-Wno-unused-function', '-I', engine,
    probe, ...objects, '-lm', '-pthread', '-framework', 'Foundation', '-framework', 'Metal', '-o', binary]);
  report.binarySHA256 = hash(binary);
  report.request = JSON.parse(fs.readFileSync(request, 'utf8'));
  writeArtifact(run, 'request.json', report.request);
  idle();
  report.nativeArgv = [model, request]; save();
  const started = performance.now(), chunks = []; let bytes = 0;
  child = spawn(binary, report.nativeArgv, {cwd: engine, env: environment, detached: true,
    stdio: ['ignore', 'pipe', 'pipe']});
  report.pid = child.pid; save();
  timeout = setTimeout(() => terminate('deadline'), report.limits.seconds * 1000);
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => {
    bytes += chunk.length;
    if (bytes <= report.limits.outputBytes) chunks.push(chunk);
    else terminate('output limit');
    if (stream === child.stderr && bytes <= report.limits.outputBytes) process.stderr.write(chunk);
  });
  const exited = await new Promise(resolve => {
    child.once('error', error => resolve({error: error.message}));
    child.once('close', (code, signal) => resolve({code, signal}));
  });
  report.native = {...exited, seconds: (performance.now() - started) / 1000, outputBytes: bytes};
  clearTimeout(timeout); clearTimeout(escalation);
  const raw = Buffer.concat(chunks).toString('utf8');
  fs.writeFileSync(path.join(run, 'native.log'), raw, {flag: 'wx'});
  report.rows = raw.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line));
  const cpu = report.rows.filter(row => row.phase === 'cpu' && row.step !== undefined);
  const metal = report.rows.filter(row => row.phase === 'metal' && row.step !== undefined);
  const answer = rows => Buffer.concat(rows.filter(row => !row.eos).map(row => Buffer.from(row.tokenHex, 'hex'))).toString('utf8');
  report.answers = {expected: '16', cpu: answer(cpu), metal: answer(metal),
    cpuTerminated: cpu.at(-1)?.eos === true, metalTerminated: metal.at(-1)?.eos === true};
  // The expected answer is executed independently, not copied from the model.
  assert.equal(command('python3', ['-c', 'x = [3, 5, 8]; print(sum(v * 2 for v in x if v % 2 == 1))']).trim(), report.answers.expected);
  report.answerCorrectness = Object.fromEntries(['cpu', 'metal'].map(phase => [phase,
    report.answers[phase + 'Terminated'] && report.answers[phase].trim() === report.answers.expected ? 'pass' : 'fail']));
  assert.equal(exited.code, 0, 'Native numerical comparison failed; inspect native.log');
  assert(!report.stopReason && !interrupted, 'Interrupted or exceeded diagnostic limits');
  assert(cpu.length > 0 && cpu.length <= report.limits.decodeSteps);
  assert.equal(metal.length, cpu.length);
  assert(metal.every(row => row.finite && row.matched));
  report.numericalAgreement = 'pass';
  assert(Object.values(report.answerCorrectness).every(status => status === 'pass'),
    'Numerical agreement does not make a wrong answer correct');
  report.status = 'pass';
} catch (error) {
  report.error = String(error.stack || error); console.error(report.error); process.exitCode = 1;
} finally {
  clearTimeout(timeout); clearTimeout(escalation);
  for (const [file, expected] of Object.entries(report.inputs)) {
    if (hash(file) !== expected) {report.status = 'fail'; report.changedInput = file; process.exitCode = 1;}
  }
  if (report.model && fileIdentity(fs.statSync(model, {bigint: true})) !== report.model.identity) {
    report.status = 'fail'; report.changedModel = model; process.exitCode = 1;
  }
  report.finished = new Date().toISOString(); save(); console.log(JSON.stringify({run, status: report.status,
    numericalAgreement: report.numericalAgreement, answers: report.answers, answerCorrectness: report.answerCorrectness}, null, 2));
}

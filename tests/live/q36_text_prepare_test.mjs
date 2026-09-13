// Actual Qwen27B Metal state preservation and differential prefill/decode.
// No app/HTTP or independent architecture/answer-quality qualification.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import {spawn, spawnSync} from 'node:child_process';
import {artifactRunDir, writeArtifact} from '../support/real_harness.mjs';
import {fileIdentity, hashStableFile} from '../support/quality_baseline.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const run = artifactRunDir('q36-text-prepare');
const report = {started: new Date().toISOString(), status: 'FAIL',
  scope: 'Real native Metal text/payload preparation and bitwise state/logit comparison; not answer quality or app Stop',
  host: {platform: os.platform(), arch: os.arch(), cpu: os.cpus()[0]?.model, memoryBytes: os.totalmem()},
  settings: {context: 4096, prefillChunk: 128, backend: 'metal', threads: 4, quality: true,
    cacheK: 'f16', cacheV: 'f16', expertStreaming: false, simultaneousEngines: 1},
  limits: {seconds: 600, outputBytes: 4 * 1024 * 1024, snapshotBytes: 512 * 1024 * 1024},
  commands: [], inputs: {}, rows: []};
const save = () => writeArtifact(run, 'results.json', report);
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const env = Object.fromEntries(Object.entries(process.env)
  .filter(([name]) => !/^(Q36_|DS4|DSTUDIO_|DYLD_|MAKEFLAGS$|MFLAGS$)/.test(name)));
let child, timeout, escalation, resourceWatch, interrupted = false, weightIdentity, model;
function stop(reason) {
  report.stopReason ||= reason;
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try {process.kill(-child.pid, 'SIGTERM');} catch (error) {if (error.code !== 'ESRCH') throw error;}
  escalation ||= setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null)
      try {process.kill(-child.pid, 'SIGKILL');} catch (error) {if (error.code !== 'ESRCH') throw error;}
  }, 5000);
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {interrupted = true; stop(signal);});
function engines() {
  const r = spawnSync('/bin/ps', ['-axo', 'pid=,comm='], {encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024});
  assert.equal(r.status, 0, 'Cannot verify inference process ownership');
  return r.stdout.split('\n').filter(line =>
    /\/(?:ds4(?:[-_][^/\s]+)?|q36(?:[-_][^/\s]+)?|q27)(?:\s|$)/.test(line) &&
    Number(line.trim().split(/\s+/)[0]) !== child?.pid);
}
function idle() {assert.equal(engines().length, 0, 'Another inference process is running; nothing stopped');}
console.log('Evidence: ' + run); save();
try {
  assert.equal(process.platform, 'darwin', 'Metal hardware unavailable: NOT RUN');
  assert(process.argv.length === 4 || (process.argv.length === 5 && ['--direct-baseline', '--scheduled'].includes(process.argv[4])),
    'Supply prepared q36 source, Qwen27B GGUF, and optionally --direct-baseline or --scheduled');
  const engine = fs.realpathSync(process.argv[2]); model = fs.realpathSync(process.argv[3]);
  report.variant = process.argv[4] === '--scheduled' ? 'scheduled-private-preparation' :
    process.argv[4] ? 'direct-baseline' : 'private-preparation';
  idle();
  report.installation = JSON.parse(fs.readFileSync(path.join(engine, '.dstudio-source.json'), 'utf8'));
  assert.equal(report.installation.commit, 'd67687ed15ad9f52b755a9b5fdfc0214ea937555');
  assert.equal(report.installation.backend, 'metal');
  for (const [name, expected] of Object.entries(report.installation.sources)) {
    const file = path.join(engine, name); assert.equal(hash(file), expected, 'Native source drift: ' + name);
    report.inputs[file] = expected;
  }
  weightIdentity = await hashStableFile(model);
  assert.equal(fs.statSync(model).size, 25299061664);
  assert.equal(weightIdentity.sha256, '701d8fa9ed214ab21bfc130cd2a7df19ca89bbef7713e2dfb19f3c63696aa917');
  report.weight = {...weightIdentity, file: model, repository: 'unsloth/Qwen3.8-27B-GGUF',
    revision: '4ca720788d1e01f1bff70c033e0d0028fd02e502'};
  const source = path.join(root, 'tests/support/q36_text_prepare_probe.c');
  const objects = ['q36_gpu_core_metal.o', 'q36_metal.o', 'q36_image.o', 'q36_ssd.o'].map(n => path.join(engine, n));
  for (const file of [source, import.meta.filename, ...objects]) report.inputs[file] = hash(file);
  fs.copyFileSync(source, path.join(run, 'probe-source.c'), fs.constants.COPYFILE_EXCL);
  fs.copyFileSync(import.meta.filename, path.join(run, 'harness.mjs'), fs.constants.COPYFILE_EXCL);
  const binary = path.join(run, 'q36-text-prepare-probe');
  const args = ['-O2', '-Wall', '-Wextra', '-Werror', '-std=c11', '-I', engine,
    ...(process.argv[4] === '--direct-baseline' ? ['-DDSTUDIO_Q36_DIRECT_BASELINE'] :
      process.argv[4] === '--scheduled' ? ['-DDSTUDIO_Q36_SCHEDULED'] : []), source, ...objects,
    '-lm', '-pthread', '-framework', 'Foundation', '-framework', 'Metal', '-o', binary];
  const built = spawnSync('cc', args, {cwd: engine, env, encoding: 'utf8', timeout: 120000, maxBuffer: report.limits.outputBytes});
  report.commands.push({command: 'cc', args, status: built.status, stdout: built.stdout, stderr: built.stderr,
    error: built.error?.message}); save(); assert.equal(built.status, 0, built.stderr || built.error?.message);
  report.binarySHA256 = hash(binary);
  idle(); assert(!interrupted, 'Cancelled before model load');
  let stdout = '', stderr = '', bytes = 0;
  const start = performance.now();
  child = spawn(binary, [model], {cwd: engine, env, detached: true, stdio: ['ignore', 'pipe', 'pipe']});
  report.nativeArgv = [binary, model]; report.pid = child.pid; save();
  timeout = setTimeout(() => stop('deadline'), report.limits.seconds * 1000);
  resourceWatch = setInterval(() => {
    try {if (engines().length) stop('Another inference engine started; releasing only the test model');}
    catch {stop('Unable to revalidate inference process ownership');}
  }, 1000);
  for (const [stream, kind] of [[child.stdout, 'stdout'], [child.stderr, 'stderr']]) stream.on('data', data => {
    bytes += data.length;
    if (bytes > report.limits.outputBytes) return stop('output limit');
    if (kind === 'stdout') {stdout += data; process.stdout.write(data);}
    else stderr += data;
  });
  const result = await new Promise(resolve => {
    child.once('error', error => resolve({error: error.message}));
    child.once('close', (code, signal) => resolve({code, signal}));
  });
  clearTimeout(timeout); clearTimeout(escalation); clearInterval(resourceWatch);
  fs.writeFileSync(path.join(run, 'native.stdout'), stdout, {flag: 'wx'});
  fs.writeFileSync(path.join(run, 'native.stderr'), stderr, {flag: 'wx'});
  report.native = {...result, seconds: (performance.now() - start) / 1000, outputBytes: bytes};
  report.rows = stdout.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line));
  save(); assert.equal(result.code, 0, 'Native preservation/differential failed; original result retained');
  assert(!report.stopReason && !interrupted);
  assert.equal(report.rows.filter(row => row.kind === 'case').length, 7);
  assert.equal(report.rows.filter(row => row.kind === 'payload-case').length, 6);
  assert.equal(report.rows.at(-1).failures, 0);
  assert(report.rows.filter(row => row.kind === 'case' || row.kind === 'payload-case')
    .every(row => row.passed && row.sourcePreserved && row.nativeParity && row.decodeChecks === 4));
  report.status = 'PASS';
} catch (error) {report.error = String(error.stack || error); console.error(report.error); process.exitCode = 1;}
finally {
  clearTimeout(timeout); clearTimeout(escalation); clearInterval(resourceWatch);
  if (child && child.exitCode === null && child.signalCode === null) {
    stop('Harness exiting with test process alive');
    await new Promise(resolve => child.once('close', resolve)); clearTimeout(escalation);
  }
  for (const [file, expected] of Object.entries(report.inputs)) if (hash(file) !== expected) {
    report.status = 'FAIL'; report.changedInput = file; process.exitCode = 1;
  }
  if (weightIdentity && fileIdentity(fs.statSync(model, {bigint: true})) !== weightIdentity.identity) {
    report.status = 'FAIL'; report.changedWeight = model; process.exitCode = 1;
  }
  report.finished = new Date().toISOString(); save(); console.log(JSON.stringify({run, status: report.status}));
}

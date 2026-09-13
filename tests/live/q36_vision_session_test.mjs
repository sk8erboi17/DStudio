// Development regression on native image spans with the real Qwen27B and its
// exact projector. Not the HTTP/app adapter or the held-out 30 PDF/20 image gate.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import zlib from 'node:zlib';
import {spawn, spawnSync} from 'node:child_process';
import {artifactRunDir, writeArtifact} from '../support/real_harness.mjs';
import {fileIdentity, hashStableFile} from '../support/quality_baseline.mjs';
import {gradeQ36VisionAnswer} from '../support/q36_vision_answer_oracle.mjs';

assert.equal(process.argv.length, 5, 'Supply prepared native q36, Qwen27B GGUF and F16 projector');
assert.equal(process.platform, 'darwin', 'Native Metal hardware required');
const root = path.resolve(import.meta.dirname, '../..');
const [engine, model, projector] = process.argv.slice(2).map(file => fs.realpathSync(file));
const run = artifactRunDir('q36-vision-session'), binary = path.join(run, 'probe');
const source = path.join(root, 'tests/support/q36_vision_session_probe.c');
const oracle = path.join(root, 'tests/support/q36_vision_answer_oracle.mjs');
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const report = {started: new Date().toISOString(), status: 'fail',
  scope: 'Real native PNG decoding, projector, image spans and language answers; four development inputs, not held-out vision quality or HTTP/app integration',
  host: {platform: os.platform(), arch: os.arch(), cpu: os.cpus()[0]?.model, memoryBytes: os.totalmem()},
  limits: {seconds: 600, outputBytes: 4 * 1024 * 1024, imageWidth: 128, imageHeight: 128, generatedTokens: 32},
  settings: {backend: 'metal', quality: true, cacheK: 'f16', cacheV: 'f16', context: 8192,
    prefillChunk: 128, threads: 4, thinking: false, sampling: 'greedy', expertStreaming: false, simultaneousEngines: 1},
  inputs: {}, weights: [], fixtures: [], commands: [], rows: []};
const save = () => writeArtifact(run, 'results.json', report);
const environment = Object.fromEntries(Object.entries(process.env)
  .filter(([name]) => !/^(Q36_|DS4|DSTUDIO_|DYLD_|MAKEFLAGS$|MFLAGS$)/.test(name)));
let child, deadline, escalation, interrupted = false;
function stop(reason) {
  report.stopReason ||= reason;
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try {process.kill(-child.pid, 'SIGTERM');} catch (error) {if (error.code !== 'ESRCH') throw error;}
  escalation ||= setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      try {process.kill(-child.pid, 'SIGKILL');} catch (error) {if (error.code !== 'ESRCH') throw error;}
    }
  }, 5000);
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {interrupted = true; stop(signal);});
function command(executable, args) {
  const result = spawnSync(executable, args, {cwd: engine, env: environment,
    encoding: 'utf8', timeout: 120000, maxBuffer: report.limits.outputBytes});
  report.commands.push({executable, args, status: result.status, stdout: result.stdout,
    stderr: result.stderr, error: result.error?.message}); save();
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return result.stdout;
}
function idle() {
  const active = command('/bin/ps', ['-axo', 'pid=,comm=']).split('\n').filter(line =>
    /\/(?:ds4|ds4-server|ds4-agent|ds4-agent-jsonl|ds4-cowork|ds4-design|q36|q36-server|q36_test|q27)(?:\s|$)/.test(line));
  assert.equal(active.length, 0, 'Another inference process is running; nothing was stopped: ' + active.join('\n'));
  assert(!interrupted, 'Interrupted before native launch');
}
function png(index) {
  // Original lossless RGB fixtures. No names, text layer or metadata reveal the
  // expected answer; only the actual pixel planes change between counterfactuals.
  const chunk = (type, data) => {
    const payload = Buffer.concat([Buffer.from(type), data]); let crc = 0xffffffff;
    for (const byte of payload) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    const size = Buffer.alloc(4), checksum = Buffer.alloc(4);
    size.writeUInt32BE(data.length); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([size, payload, checksum]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(128); header.writeUInt32BE(128, 4);
  header[8] = 8; header[9] = 2;
  const pixels = Buffer.alloc(128 * (128 * 3 + 1));
  for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++) {
    const offset = y * (128 * 3 + 1) + 1 + x * 3;
    const blue = index === 1 || (index === 2 && x < 64);
    pixels[offset + (blue ? 2 : 0)] = 255;
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}
console.log('Evidence: ' + run); save();
try {
  idle();
  report.installation = JSON.parse(fs.readFileSync(path.join(engine, '.dstudio-source.json'), 'utf8'));
  assert.equal(report.installation.engine, 'q36'); assert.equal(report.installation.backend, 'metal');
  assert.equal(report.installation.commit, 'd67687ed15ad9f52b755a9b5fdfc0214ea937555');
  for (const [name, expected] of Object.entries(report.installation.sources)) {
    const file = path.join(engine, name); assert.equal(hash(file), expected, 'Native source drift: ' + name);
    report.inputs[file] = expected;
  }
  const pins = JSON.parse(command('python3', [path.join(root, 'scripts/download-qwen27.py'), '--manifest']));
  for (const [component, file] of [['model', model], ['vision', projector]]) {
    assert.equal(fs.statSync(file).size, pins.files[component].bytes);
    const identity = await hashStableFile(file);
    assert.equal(identity.sha256, pins.files[component].sha256);
    report.weights.push({file, component, ...identity, repository: pins.repository, revision: pins.revision}); save();
  }
  const objects = ['q36_gpu_core_metal.o', 'q36_metal.o', 'q36_image.o', 'q36_ssd.o']
    .map(name => path.join(engine, name));
  for (const file of [source, oracle, import.meta.filename, ...objects]) report.inputs[file] = hash(file);
  for (const [file, name] of [[source, 'probe-source.c'], [oracle, 'oracle.mjs'], [import.meta.filename, 'harness.mjs']]) {
    fs.copyFileSync(file, path.join(run, name), fs.constants.COPYFILE_EXCL);
  }
  command('cc', ['-O2', '-Wall', '-Wextra', '-Werror', '-std=c11', '-I', engine, source, ...objects,
    '-lm', '-pthread', '-framework', 'Foundation', '-framework', 'Metal', '-o', binary]);
  report.binarySHA256 = hash(binary);
  for (let index = 0; index < 4; index++) {
    const file = path.join(run, `input-${index}.png`);
    fs.writeFileSync(file, png(index), {flag: 'wx'});
    report.fixtures.push({file, sha256: hash(file), expected: ['red', 'blue', 'blue,red', 'red'][index]});
  }
  assert.equal(report.fixtures[0].sha256, report.fixtures[3].sha256);
  idle();
  report.nativeArgv = [model, projector, ...report.fixtures.map(f => f.file)]; save();
  const chunks = []; let bytes = 0; const started = performance.now();
  child = spawn(binary, report.nativeArgv, {cwd: engine, env: environment, detached: true,
    stdio: ['ignore', 'pipe', 'pipe']});
  report.pid = child.pid; save();
  deadline = setTimeout(() => stop('deadline'), report.limits.seconds * 1000);
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => {
    bytes += chunk.length;
    if (bytes <= report.limits.outputBytes) {
      chunks.push(chunk); if (stream === child.stderr) process.stderr.write(chunk);
    } else stop('output limit');
  });
  const exited = await new Promise(resolve => {
    child.once('error', error => resolve({error: error.message}));
    child.once('close', (code, signal) => resolve({code, signal}));
  });
  clearTimeout(deadline); clearTimeout(escalation);
  const raw = Buffer.concat(chunks).toString('utf8');
  fs.writeFileSync(path.join(run, 'native.log'), raw, {flag: 'wx'});
  report.native = {...exited, seconds: (performance.now() - started) / 1000, outputBytes: bytes};
  report.rows = raw.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line));
  report.answers = report.rows.filter(row => ['imageAnswer', 'textRecovery'].includes(row.kind)).map(row => {
    const expected = row.kind === 'textRecovery' ? '14' : report.fixtures[row.case].expected;
    return {...row, ...gradeQ36VisionAnswer(row, expected)};
  });
  save();
  assert.equal(exited.code, 0, 'Native operation failed; inspect native.log');
  assert(!report.stopReason && !interrupted);
  assert.equal(report.rows.filter(row => row.kind === 'imageSpan').length, 4);
  const cancellations = report.rows.filter(row => row.kind === 'preCancelledSync');
  assert.equal(cancellations.length, 4);
  assert(cancellations.every(row => row.preserved === true), 'Already-cancelled sync changed native session state');
  assert.equal(report.answers.length, 8);
  assert.equal(report.rows.at(-1).failures, 0);
  assert(report.answers.every(row => row.status === 'pass'), 'Pixel answer or post-image recovery failed');
  report.status = 'pass';
} catch (error) {
  report.error = String(error.stack || error); console.error(report.error); process.exitCode = 1;
} finally {
  clearTimeout(deadline); clearTimeout(escalation);
  for (const [file, expected] of Object.entries(report.inputs)) {
    if (hash(file) !== expected) {report.status = 'fail'; report.changedInput = file; process.exitCode = 1;}
  }
  for (const weight of report.weights) if (fileIdentity(fs.statSync(weight.file, {bigint: true})) !== weight.identity) {
    report.status = 'fail'; report.changedWeight = weight.file; process.exitCode = 1;
  }
  for (const fixture of report.fixtures) if (hash(fixture.file) !== fixture.sha256) {
    report.status = 'fail'; report.changedFixture = fixture.file; process.exitCode = 1;
  }
  report.finished = new Date().toISOString(); save(); console.log(JSON.stringify({run, status: report.status,
    answers: report.answers?.map(({case: index, kind, answer, expected, status}) => ({index, kind, answer, expected, status}))}, null, 2));
}

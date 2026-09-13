// Explicit, sequential native Metal diagnosis of a retained Agent request.
// This is instrumentation parity, not a completed Agent task or quality score.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {spawn, spawnSync} from 'node:child_process';
import {artifactRunDir, writeArtifact} from '../support/real_harness.mjs';
import {fileIdentity, hashStableFile} from '../support/quality_baseline.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const run = artifactRunDir('q36-sync-profile');
const report = {started: new Date().toISOString(), status: 'fail',
  scope: 'Recorded Agent prompt, native Metal prefill and eight greedy steps. Checks profiler integrity against the same uninstrumented source; NOT Agent completion, held-out answer quality, speedup or CPU/Vulkan/CUDA parity.',
  settings: {backend: 'metal', quality: true, context: 8192, prefillChunk: 128,
    cacheK: 'f16', cacheV: 'f16', expertStreaming: false, diskKV: false,
    thinking: false, replaySampling: 'greedy, at most eight steps', simultaneousModels: 1},
  limits: {nativeSeconds: 240, compileSeconds: 120, outputBytes: 8 * 1024 * 1024, traceBytes: 8 * 1024 * 1024},
  hardware: {platform: os.platform(), arch: os.arch(), cpu: os.cpus()[0]?.model, ramBytes: os.totalmem()},
  inputs: {}, commands: [], replays: []};
const save = () => writeArtifact(run, 'results.json', report);
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  !/^(Q36_|DS4|DSTUDIO_|DYLD_|LD_|MAKEFLAGS$|MFLAGS$|CFLAGS$|CPPFLAGS$|LDFLAGS$)/.test(key)));
let child = null, escalation = null, interrupted = false, model, tree;
function stop(reason) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  report.stopReason ||= reason;
  try {process.kill(-child.pid, 'SIGTERM');} catch (error) {if (error.code !== 'ESRCH') throw error;}
  escalation ||= setTimeout(() => {
    if (child && child.exitCode === null && child.signalCode === null)
      try {process.kill(-child.pid, 'SIGKILL');} catch (error) {if (error.code !== 'ESRCH') throw error;}
  }, 5000);
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {interrupted = true; stop(signal);});
function isolated() {
  assert(!interrupted, 'Interrupted');
  const ps = spawnSync('/bin/ps', ['-axo', 'pid=,comm='], {encoding: 'utf8', timeout: 5000});
  assert.equal(ps.status, 0, ps.stderr);
  const rows = ps.stdout.split('\n').map(s => s.trim().match(/^(\d+)\s+(.*)$/)).filter(Boolean);
  const engines = rows.filter(([, pid, executable]) => Number(pid) !== child?.pid &&
    /\/(?:ds4|ds4-server|ds4-agent|ds4-agent-jsonl|ds4-cowork|ds4-design|q36|q36-server|q36_test|q27|DStudio|dstudio|q36-native-profile|q36-native-reference)$/.test(executable));
  assert.deepEqual(engines, [], 'Unrelated inference engine found; stop only this diagnostic');
}
function command(executable, args) {
  const value = spawnSync(executable, args, {cwd: tree, env: environment, encoding: 'utf8',
    timeout: report.limits.compileSeconds * 1000, maxBuffer: report.limits.outputBytes});
  report.commands.push({executable, args, status: value.status, signal: value.signal,
    error: value.error?.message, stdout: value.stdout, stderr: value.stderr}); save();
  assert.equal(value.status, 0, value.stderr || value.error?.message);
  return value.stdout;
}
async function replay(name, binary, request) {
  isolated();
  const row = {name, binary, binarySHA256: hash(binary), passed: false,
    started: new Date().toISOString(), peakRssKiB: 0};
  report.replays.push(row); save();
  const started = performance.now(), output = []; let bytes = 0;
  child = spawn(binary, [model, request], {cwd: tree, env: environment, detached: true,
    stdio: ['ignore', 'pipe', 'pipe']}); row.pid = child.pid; save();
  const timeout = setTimeout(() => stop('Native diagnostic deadline'), report.limits.nativeSeconds * 1000);
  const watcher = setInterval(() => {
    try {
      isolated();
      const rss = spawnSync('/bin/ps', ['-p', String(child.pid), '-o', 'rss='], {encoding: 'utf8', timeout: 3000});
      if (rss.status === 0) row.peakRssKiB = Math.max(row.peakRssKiB, Number(rss.stdout.trim()) || 0);
    } catch (error) {stop(String(error));}
  }, 2000);
  for (const stream of [child.stdout, child.stderr]) stream.on('data', data => {
    bytes += data.length;
    if (bytes > report.limits.outputBytes) stop('Diagnostic output byte limit');
    else output.push({stderr: stream === child.stderr, data});
  });
  try {
    row.exit = await new Promise(resolve => {
      child.once('error', error => resolve({error: error.message}));
      child.once('close', (code, signal) => resolve({code, signal}));
    });
  } finally {
    clearTimeout(timeout); clearInterval(watcher); clearTimeout(escalation); escalation = null;
    row.elapsedMs = performance.now() - started; row.finished = new Date().toISOString();
    const stdout = Buffer.concat(output.filter(c => !c.stderr).map(c => c.data)).toString('utf8');
    const stderr = Buffer.concat(output.filter(c => c.stderr).map(c => c.data)).toString('utf8');
    writeArtifact(run, `${name}.stdout.jsonl`, stdout); writeArtifact(run, `${name}.stderr.log`, stderr);
    row.outputBytes = bytes;
    row.rows = stdout.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line));
    child = null; save();
  }
  assert.equal(row.exit.code, 0, JSON.stringify(row.exit));
  assert(!report.stopReason, report.stopReason);
  assert.deepEqual(row.rows.filter(r => r.kind === 'phase').map(r => [r.phase, r.ok]), [['prefill', true], ['decode', true]]);
  const steps = row.rows.filter(r => r.kind === 'step');
  assert(steps.length > 0 && steps.length <= 8 && steps.every(s => s.finite));
  row.passed = true; save(); console.log(`Completed ${name}: ${steps.length} finite steps (not answer quality)`);
  return row.rows;
}

console.log('Evidence: ' + run); save();
try {
  assert.equal(process.platform, 'darwin', 'Metal unavailable: NOT RUN');
  assert.equal(process.argv.length, 5, 'Supply installed q36 source, pinned Qwen27B model, and retained native trace');
  [tree, model] = process.argv.slice(2, 4).map(file => fs.realpathSync(file));
  isolated();
  const trace = fs.realpathSync(process.argv[4]);
  assert(trace.startsWith(fs.realpathSync(path.join(root, 'tests/.artifacts')) + path.sep));
  assert(fs.statSync(trace).size <= report.limits.traceBytes);
  report.installation = JSON.parse(fs.readFileSync(path.join(tree, '.dstudio-source.json'), 'utf8'));
  assert.equal(report.installation.engine, 'q36');
  assert.equal(report.installation.commit, 'd67687ed15ad9f52b755a9b5fdfc0214ea937555');
  for (const [name, expected] of Object.entries(report.installation.sources)) {
    const file = path.join(tree, name); assert.equal(hash(file), expected, 'Source drift: ' + name);
    report.inputs[file] = expected;
  }
  const probe = path.join(root, 'tests/support/q36_sync_profile_probe.c');
  const wrapper = path.join(root, 'tests/support/q36_metal_sync_profile.m');
  const integrity = path.join(root, 'tests/support/q36_sync_profile_test.m');
  for (const file of [trace, probe, wrapper, integrity, import.meta.filename]) report.inputs[file] = hash(file);
  const requests = [...fs.readFileSync(trace, 'utf8').matchAll(/--- raw request json ---\n([^\n]+)\n/g)];
  const selected = requests.find(match => {
    const request = JSON.parse(match[1]);
    return request.tools?.length && request.messages?.length === 2 &&
      request.messages[1]?.content?.startsWith('Read total.py and verify.py.');
  });
  assert(selected, 'Retained first Agent request not found');
  assert(Buffer.byteLength(selected[1]) <= 65536);
  const request = path.join(run, 'request.json'); writeArtifact(run, 'request.json', selected[1]);
  report.inputs[request] = hash(request);
  report.originalSampling = (({temperature, top_k, top_p, min_p, seed}) => ({temperature, top_k, top_p, min_p, seed}))(JSON.parse(selected[1]));
  report.model = await hashStableFile(model);
  assert.equal(report.model.bytes, 25299061664);
  assert.equal(report.model.sha256, '701d8fa9ed214ab21bfc130cd2a7df19ca89bbef7713e2dfb19f3c63696aa917');
  const objects = [];
  const flags = ['-O3', '-ffast-math', '-march=native', '-D_GNU_SOURCE', '-fno-finite-math-only', '-Wall', '-Wextra', '-std=c99', '-I', tree];
  for (const file of ['q36.c', 'q36_image.c', 'q36_ssd.c', 'rax.c']) {
    const object = path.join(run, file + '.o');
    command('cc', [...flags, ...(file === 'q36.c' ? ['-DQ36_METAL'] : []), '-c', path.join(tree, file), '-o', object]);
    objects.push(object); report.inputs[object] = hash(object);
  }
  const metal = path.join(run, 'metal.o'), profiled = path.join(run, 'metal-profile.o');
  const sourceDefine = `-DDSTUDIO_Q36_METAL_SOURCE=${JSON.stringify(path.join(tree, 'q36_metal.m'))}`;
  command('clang', [...flags, '-fobjc-arc', '-c', path.join(tree, 'q36_metal.m'), '-o', metal]);
  command('clang', [...flags, '-fobjc-arc', sourceDefine, '-c', wrapper, '-o', profiled]);
  for (const file of [metal, profiled]) report.inputs[file] = hash(file);
  const links = ['-lm', '-pthread', '-framework', 'Foundation', '-framework', 'Metal'];
  const test = path.join(run, 'profile-integrity');
  command('clang', ['-O2', '-fno-fast-math', '-fobjc-arc', sourceDefine, '-I', tree, integrity, ...objects, ...links, '-o', test]);
  const integrityOutput = command(test, []);
  assert(integrityOutput.includes('Metal synchronization profile integrity: PASS'));
  const reference = path.join(run, 'q36-native-reference'), measured = path.join(run, 'q36-native-profile');
  const probeFlags = ['-O2', '-std=c11', '-Wall', '-Wextra', '-Wno-unused-function', '-I', tree];
  command('cc', [...probeFlags, probe, ...objects, metal, ...links, '-o', reference]);
  command('cc', [...probeFlags, '-DDSTUDIO_Q36_SYNC_PROFILE', probe, ...objects, profiled, ...links, '-o', measured]);
  const before = await replay('uninstrumented', reference, request);
  const after = await replay('instrumented', measured, request);
  assert.deepEqual(after.filter(r => ['prompt', 'step'].includes(r.kind)), before.filter(r => ['prompt', 'step'].includes(r.kind)),
    'Instrumentation changed prompt tokens, generated tokens or full-logit hashes');
  report.instrumentationParity = true;
  report.profiles = after.filter(r => r.kind === 'sync_profile');
  assert.deepEqual(report.profiles.map(r => r.phase), ['prefill', 'decode']);
  assert(report.profiles.every(p => p.commandBuffers > 0 && p.calls.length === 11 &&
    p.calls.every(c => c.failed === 0) && p.calls.find(c => c.reason === 'finite_check').submitted > 0));
  report.status = 'pass';
} catch (error) {
  report.error = error.stack; process.exitCode = 1; console.error(report.error);
} finally {
  report.changedInputs = Object.entries(report.inputs).filter(([file, expected]) => {
    try {return hash(file) !== expected;} catch {return true;}
  }).map(([file]) => file);
  if (report.model && fileIdentity(fs.statSync(model, {bigint: true})) !== report.model.identity)
    report.changedInputs.push(model);
  if (report.changedInputs.length) {report.status = 'fail'; process.exitCode = 1;}
  report.finished = new Date().toISOString(); save();
  console.log(`${report.status.toUpperCase()} diagnostic: ${run}`);
}

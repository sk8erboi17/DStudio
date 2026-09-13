// Model-free, real Metal reproduction of cross-session scratch corruption.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {artifactRunDir, writeArtifact} from '../support/real_harness.mjs';

const run = artifactRunDir('q36-recurrent-batch');
const report = {started: new Date().toISOString(), passed: false, commands: [],
  scope: 'Real Metal recurrent batch scratch lifetime, synthetic weights; not model quality or Vulkan qualification'};
const hash = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const save = () => writeArtifact(run, 'results.json', report);
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(Q36_|DS4|DSTUDIO_|DYLD_)/.test(k)));
env.ASAN_OPTIONS = 'detect_leaks=0';
let interrupted = false, activeStop;
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  interrupted = true; activeStop?.(signal);
});
async function execute(command, args, cwd) {
  assert(!interrupted, 'Cancelled before starting the next owned process');
  const r = {command, args, started: new Date().toISOString()}; report.commands.push(r); save();
  const child = spawn(command, args, {cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe']});
  r.pid = child.pid; save();
  let escalation, bytes = 0; r.stdout = ''; r.stderr = '';
  const stop = reason => {
    r.error ||= reason;
    if (child.exitCode !== null || child.signalCode !== null) return;
    try {process.kill(-child.pid, 'SIGTERM');} catch (e) {if (e.code !== 'ESRCH') throw e;}
    escalation ||= setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null)
        try {process.kill(-child.pid, 'SIGKILL');} catch (e) {if (e.code !== 'ESRCH') throw e;}
    }, 1000);
  };
  activeStop = stop;
  for (const [stream, key] of [[child.stdout, 'stdout'], [child.stderr, 'stderr']]) stream.on('data', d => {
    bytes += d.length;
    if (bytes > 2 ** 21) stop('Output bound exceeded'); else r[key] += d;
  });
  const timer = setTimeout(() => stop('120-second deadline'), 120000);
  await new Promise(resolve => {
    child.once('error', e => {r.error = String(e);});
    child.once('close', (status, signal) => {r.status = status; r.signal = signal; resolve();});
  });
  clearTimeout(timer); clearTimeout(escalation); activeStop = null;
  r.finished = new Date().toISOString(); save(); return r;
}
console.log(`Evidence: ${run}`); save();
try {
  assert.equal(process.platform, 'darwin', 'Metal unavailable: NOT RUN');
  assert.equal(process.argv.length, 3, 'Supply the exact q36 source checkout');
  const engine = fs.realpathSync(process.argv[2]);
  const probe = path.resolve(import.meta.dirname, '../support/q36_recurrent_batch_probe.c');
  const inputs = [probe, import.meta.filename, ...['q36.c', 'q36.h', 'q36_gpu.h', 'q36_metal.m',
    'q36_ssd.c', 'q36_image.c', 'q36_quant.h', 'q36_image.h', 'q36_ssd.h',
    'q36_iq_tables.h', 'q36_iq3s_grid_values.inc', 'rax.h'].map(f => path.join(engine, f)),
    ...fs.readdirSync(path.join(engine, 'metal')).filter(f => /\.(metal|h)$/.test(f)).map(f => path.join(engine, 'metal', f))];
  report.inputs = Object.fromEntries(inputs.map(f => [f, hash(f)]));
  for (const f of [probe, import.meta.filename]) fs.copyFileSync(f, path.join(run, path.basename(f)), fs.constants.COPYFILE_EXCL);
  const flags = ['-O1', '-g', '-fsanitize=address,undefined', '-fno-omit-frame-pointer',
    '-ffunction-sections', '-fdata-sections', '-I', engine];
  const metal = path.join(run, 'q36_metal.o'), binary = path.join(run, 'probe');
  const buildMetal = await execute('clang', [...flags, '-fobjc-arc', '-c', path.join(engine, 'q36_metal.m'), '-o', metal], engine);
  assert.equal(buildMetal.status, 0, buildMetal.stderr);
  const build = await execute('clang', [...flags, '-std=c11', '-DQ36_METAL', probe, metal,
    ...['q36_ssd.c', 'q36_image.c'].map(f => path.join(engine, f)), '-framework', 'Foundation',
    '-framework', 'Metal', '-lm', '-pthread', '-Wl,-dead_strip', '-o', binary], engine);
  assert.equal(build.status, 0, build.stderr);
  report.binarySHA256 = hash(binary);
  const test = await execute(binary, [], engine);
  if (test.stdout.trim()) report.result = JSON.parse(test.stdout);
  assert(!interrupted && !test.error, test.error || 'Interrupted');
  assert.equal(test.status, 0, test.stderr || test.error);
  assert.equal(report.result.cases, 96); assert.equal(report.result.failures, 0);
  assert.equal(report.result.maxAbs, 0); report.passed = true;
} catch (e) {report.error = String(e.stack || e); console.error(report.error); process.exitCode = 1;}
finally {
  for (const [f, expected] of Object.entries(report.inputs || {})) if (!fs.existsSync(f) || hash(f) !== expected) {
    report.passed = false; report.changedInput = f; process.exitCode = 1;
  }
  report.finished = new Date().toISOString(); save();
  console.log(JSON.stringify({run, passed: report.passed, result: report.result}));
}

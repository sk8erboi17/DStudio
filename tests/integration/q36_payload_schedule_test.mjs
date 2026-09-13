// Native serializer + real Metal readbacks. No model weights or inference.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {artifactRunDir, writeArtifact} from '../support/real_harness.mjs';

const run = artifactRunDir('q36-payload-schedule');
const report = {started: new Date().toISOString(), passed: false,
  scope: 'Native payload serialization, real Metal buffers, deterministic scheduling fixture; no model quality or server scheduling claim'};
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const save = () => writeArtifact(run, 'results.json', report);
console.log(`Evidence: ${run}`); save();
try {
  assert.equal(process.platform, 'darwin', 'Metal hardware required: NOT RUN');
  assert.equal(process.argv.length, 3, 'Supply exact built q36 source directory');
  const engine = fs.realpathSync(process.argv[2]);
  const probe = path.resolve(import.meta.dirname, '../support/q36_payload_schedule_probe.c');
  const inputs = [probe, import.meta.filename, ...['q36.c', 'q36.h', 'q36_gpu.h', 'q36_quant.h',
    'q36_image.h', 'q36_ssd.h', 'q36_iq_tables.h', 'q36_iq3s_grid_values.inc',
    'q36_metal.m', 'q36_ssd.c', 'q36_image.c', 'q36_metal.o', 'q36_ssd.o', 'q36_image.o'].map(f => path.join(engine, f))];
  report.inputs = Object.fromEntries(inputs.map(f => [f, hash(f)]));
  for (const f of inputs.slice(0, 2)) fs.copyFileSync(f, path.join(run, path.basename(f)), fs.constants.COPYFILE_EXCL);
  const binary = path.join(run, 'probe');
  const args = ['-std=c11', '-O1', '-g', '-DQ36_METAL', '-ffunction-sections', '-fdata-sections',
    '-fsanitize=address,undefined', '-fno-omit-frame-pointer', '-I', engine, probe,
    ...['q36_metal.o', 'q36_ssd.o', 'q36_image.o'].map(f => path.join(engine, f)),
    '-framework', 'Foundation', '-framework', 'Metal', '-lm', '-pthread', '-Wl,-dead_strip', '-o', binary];
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(Q36_|DS4|DSTUDIO_|DYLD_)/.test(key)));
  env.ASAN_OPTIONS = 'detect_leaks=0';
  report.commands = [];
  for (const [command, argv, deadline] of [['clang', args, 120000], [binary, [], 120000]]) {
    const r = spawnSync(command, argv, {env, cwd: engine, encoding: 'utf8', timeout: deadline, maxBuffer: 2 ** 21});
    report.commands.push({command, args: argv, status: r.status, signal: r.signal,
      stdout: r.stdout, stderr: r.stderr, error: String(r.error || '')}); save();
    if (command === binary && r.stdout.trim()) report.result = JSON.parse(r.stdout);
    assert.equal(r.status, 0, r.stderr || String(r.error));
  }
  report.binarySHA256 = hash(binary);
  assert.equal(report.result.cases, 186); assert.equal(report.result.failures, 0);
  assert.equal(report.result.independentGpuDuringBlockedWrite, true);
  assert.equal(report.result.independentGpuDuringBlockedRead, true);
  report.passed = true;
} catch (error) {report.error = String(error.stack || error); console.error(report.error); process.exitCode = 1;}
finally {
  for (const [f, expected] of Object.entries(report.inputs || {})) if (!fs.existsSync(f) || hash(f) !== expected) {
    report.passed = false; report.changedInput = f; process.exitCode = 1;
  }
  report.finished = new Date().toISOString(); save();
}

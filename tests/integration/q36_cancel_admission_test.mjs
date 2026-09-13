// Native admission and initialized state; no weights, GPU execution or model
// quality claim. Compile the production core with ASan/UBSan and run it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {artifactRunDir, writeArtifact} from '../support/real_harness.mjs';

const run = artifactRunDir('q36-cancel-admission');
const report = {started: new Date().toISOString(), status: 'fail', commands: [],
  scope: 'Native pre-cancelled admission, initialized CPU/state fixtures; no actual GPU or inference'};
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
console.log('Evidence: ' + run);
try {
  assert.equal(process.argv.length, 3, 'Supply exact q36 source checkout');
  const engine = fs.realpathSync(process.argv[2]);
  const source = path.resolve(import.meta.dirname, '../support/q36_cancel_admission_probe.c');
  const inputs = [source, import.meta.filename, ...['q36.c', 'q36.h', 'q36_gpu.h', 'q36_quant.h',
    'q36_image.h', 'q36_ssd.h', 'q36_iq_tables.h', 'q36_iq3s_grid_values.inc'].map(file => path.join(engine, file))];
  report.inputs = Object.fromEntries(inputs.map(file => [file, hash(file)]));
  fs.copyFileSync(source, path.join(run, 'probe-source.c'), fs.constants.COPYFILE_EXCL);
  fs.copyFileSync(import.meta.filename, path.join(run, 'harness.mjs'), fs.constants.COPYFILE_EXCL);
  const binary = path.join(run, 'probe');
  const args = ['-std=c11', '-O1', '-ffunction-sections', '-fdata-sections', '-fsanitize=address,undefined',
    '-fno-omit-frame-pointer', '-I', engine, source, '-lm', '-pthread', '-o', binary,
    process.platform === 'darwin' ? '-Wl,-dead_strip' : '-Wl,--gc-sections'];
  if (process.platform !== 'darwin') args.unshift('-D_GNU_SOURCE');
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(Q36_|DS4|DSTUDIO_|DYLD_)/.test(name)));
  env.ASAN_OPTIONS = 'detect_leaks=0';
  for (const [command, argv, seconds] of [['cc', args, 120], [binary, [], 30]]) {
    const result = spawnSync(command, argv, {env, encoding: 'utf8', timeout: seconds * 1000, maxBuffer: 2 ** 21});
    report.commands.push({command, args: argv, status: result.status, signal: result.signal,
      stdout: result.stdout, stderr: result.stderr, error: result.error?.message});
    writeArtifact(run, 'results.json', report);
    if (command === binary) {report.result = JSON.parse(result.stdout); report.binarySHA256 = hash(binary);}
    assert.equal(result.status, 0, result.error?.message || result.stderr);
  }
  assert.equal(report.result.cases, 24); assert.equal(report.result.failures, 0);
  report.status = 'pass';
} catch (error) {report.error = String(error.stack || error); console.error(report.error); process.exitCode = 1;}
finally {
  for (const [file, expected] of Object.entries(report.inputs || {})) if (hash(file) !== expected) {
    report.status = 'fail'; report.changedInput = file; process.exitCode = 1;
  }
  report.finished = new Date().toISOString(); writeArtifact(run, 'results.json', report);
}

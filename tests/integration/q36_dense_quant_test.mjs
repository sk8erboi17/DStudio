// Compiles and executes the native dense FFN with mixed-format fixture tensors.
// No source-text assertions, external engine mutation or model-weight download.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {artifactRunDir, writeArtifact} from '../support/real_harness.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const run = artifactRunDir('q36-dense-quant');
const report = {scope: 'Native CPU dense FFN composition with synthetic weights; no inference-quality claim',
  status: 'fail', commands: []};
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
console.log(`Evidence: ${run}`);
try {
  assert.equal(process.argv.length, 3, 'Supply the exact prepared q36 source checkout');
  const source = fs.realpathSync(process.argv[2]);
  const probe = path.join(root, 'tests/support/q36_dense_ffn_probe.c');
  const inputs = [probe, import.meta.filename, 'q36.c', 'q36.h', 'q36_quant.h', 'q36_gpu.h', 'q36_image.h',
    'q36_ssd.h', 'q36_iq_tables.h', 'q36_iq3s_grid_values.inc']
    .map(file => path.isAbsolute(file) ? file : path.join(source, file));
  report.inputs = Object.fromEntries(inputs.map(file => [file, hash(file)]));
  const exe = path.join(run, 'dense-ffn');
  const args = ['-std=c11', '-O1', '-ffunction-sections', '-fdata-sections',
    '-fsanitize=address,undefined', '-fno-omit-frame-pointer', '-I', source,
    probe, '-lm', '-pthread', '-o', exe,
    process.platform === 'darwin' ? '-Wl,-dead_strip' : '-Wl,--gc-sections'];
  if (process.platform !== 'darwin') args.unshift('-D_GNU_SOURCE');
  for (const [binary, argv, seconds] of [['cc', args, 120], [exe, [], 30]]) {
    const result = spawnSync(binary, argv, {encoding: 'utf8', timeout: seconds * 1000,
      maxBuffer: 2 * 1024 * 1024, env: {...process.env, ASAN_OPTIONS: 'detect_leaks=0'}});
    const receipt = {binary, args: argv, status: result.status, signal: result.signal,
      stdout: result.stdout, stderr: result.stderr, error: String(result.error || '')};
    report.commands.push(receipt);
    writeArtifact(run, 'results.json', report);
    assert.equal(result.status, 0, `${receipt.error}\n${result.stderr}\n${result.stdout}`);
    if (binary === exe) {
      report.result = JSON.parse(result.stdout);
      assert.equal(report.result.checks, 75);
      assert.equal(report.result.failures, 0);
      report.binarySHA256 = hash(exe);
    }
  }
  for (const [file, expected] of Object.entries(report.inputs))
    assert.equal(hash(file), expected, `Input changed during the gate: ${file}`);
  report.status = 'pass';
} catch (error) {
  report.error = String(error.stack || error); console.error(report.error); process.exitCode = 1;
} finally {
  report.finished = new Date().toISOString(); writeArtifact(run, 'results.json', report);
}

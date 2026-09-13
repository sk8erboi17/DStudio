// Native source behavior with sanitizers; neither model quality nor a frontend contract.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {artifactRunDir, writeArtifact} from '../support/real_harness.mjs';

const root = path.resolve(import.meta.dirname, '../..'), run = artifactRunDir('q36-tool-replay-identity');
const report = {started: new Date().toISOString(), scope: 'Native tool-history identity, RAM/disk and single/batched; no inference', passed: false};
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
console.log(`Evidence: ${run}`);
try {
  assert.equal(process.argv.length, 3, 'Supply the exact q36 source directory');
  const source = fs.realpathSync(process.argv[2]);
  const probe = path.join(root, 'tests/support/q36_tool_replay_identity_probe.c');
  const core = path.join(root, 'tests/support/q36_catalog_core_probe.c');
  report.inputs = Object.fromEntries([probe, core, import.meta.filename,
    ...['q36.c', 'q36.h', 'q36_server.c', 'q36_image.c', 'q36_ssd.c', 'rax.c'].map(f => path.join(source, f))].map(f => [f, hash(f)]));
  for (const file of [probe, core, import.meta.filename]) fs.copyFileSync(file, path.join(run, path.basename(file)));
  const binary = path.join(run, 'tool-replay-probe');
  const args = ['-std=c11', '-O1', '-g', '-fsanitize=address,undefined', '-fno-omit-frame-pointer',
    '-ffunction-sections', '-fdata-sections', '-I', source, probe, core,
    ...['q36_image.c', 'q36_ssd.c', 'rax.c'].map(f => path.join(source, f)),
    '-lm', '-pthread', '-o', binary, process.platform === 'darwin' ? '-Wl,-dead_strip' : '-Wl,--gc-sections'];
  if (process.platform !== 'darwin') args.unshift('-D_GNU_SOURCE');
  const build = spawnSync('cc', args, {encoding: 'utf8', timeout: 120000, maxBuffer: 2 ** 21});
  report.build = {args, status: build.status, stderr: build.stderr, error: String(build.error || '')};
  assert.equal(build.status, 0, build.stderr || String(build.error)); report.binarySHA256 = hash(binary);
  report.executions = []; report.cases = [];
  for (const args of [[], ['--races']]) {
    const result = spawnSync(binary, args, {encoding: 'utf8', timeout: 15000, maxBuffer: 2 ** 21});
    const receipt = {args, status: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr, error: String(result.error || '')};
    report.executions.push(receipt);
    try {
      const rows = result.stdout.trim().split('\n').map(line => JSON.parse(line));
      receipt.summary = rows.pop(); report.cases.push(...rows);
      for (const row of rows) console.log(`${row.passed ? 'PASS' : 'FAIL'}: ${row.name}`);
      assert.equal(receipt.summary.cases, rows.length);
    } catch (error) {receipt.error = String(error.stack || error);}
    writeArtifact(run, 'results.json', report);
  }
  for (const [file, expected] of Object.entries(report.inputs)) assert.equal(hash(file), expected, `Input changed: ${file}`);
  for (const receipt of report.executions) {
    assert.equal(receipt.status, 0, receipt.stderr || receipt.error);
    assert.equal(receipt.error, ''); assert.equal(receipt.summary.failures, 0);
  }
  assert(report.cases.length > 0 && report.cases.every(row => row.passed)); report.passed = true;
} catch (error) {report.error = String(error.stack || error); console.error(report.error); process.exitCode = 1;}
finally {report.finished = new Date().toISOString(); writeArtifact(run, 'results.json', report);}

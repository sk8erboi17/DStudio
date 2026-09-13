// Production HTTP admission/cancellation; no model or app lifecycle claim.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {artifactRunDir, writeArtifact} from '../support/real_harness.mjs';

const root = path.resolve(import.meta.dirname, '../..'), run = artifactRunDir('q36-http-control');
const report = {scope: 'Native HTTP handlers, deterministic receive barriers; no inference', passed: false, cases: []};
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
console.log(`Evidence: ${run}`);
try {
  assert(process.argv.length === 3 || (process.argv.length === 4 && process.argv[3] === '--direct-baseline'),
    'Supply the exact q36 source directory and optional --direct-baseline');
  report.variant = process.argv[3] ? 'original-client-replay' : 'owner-tool-replay';
  const source = fs.realpathSync(process.argv[2]);
  const probe = path.join(root, 'tests/support/q36_http_control_probe.c');
  const core = path.join(root, 'tests/support/q36_catalog_core_probe.c');
  const inputs = [probe, core, import.meta.filename,
    ...['q36.c', 'q36_server.c', 'q36.h', 'q36_image.c', 'q36_ssd.c', 'rax.c'].map(f => path.join(source, f))];
  report.inputs = Object.fromEntries(inputs.map(file => [file, hash(file)]));
  for (const file of [probe, core, import.meta.filename]) fs.copyFileSync(file, path.join(run, path.basename(file)));
  const binary = path.join(run, 'http-control-probe');
  const args = ['-std=c11', '-O1', '-g', '-fsanitize=address,undefined', '-fno-omit-frame-pointer',
    '-ffunction-sections', '-fdata-sections', '-I', source, probe, core,
    ...['q36_image.c', 'q36_ssd.c', 'rax.c'].map(file => path.join(source, file)),
    '-lm', '-pthread', '-o', binary, process.platform === 'darwin' ? '-Wl,-dead_strip' : '-Wl,--gc-sections'];
  if (process.platform !== 'darwin') args.unshift('-D_GNU_SOURCE');
  if (process.argv[3]) args.unshift('-DDSTUDIO_Q36_REPLAY_BASELINE');
  const built = spawnSync('cc', args, {encoding: 'utf8', timeout: 120000, maxBuffer: 2 ** 21});
  report.build = {args, status: built.status, stderr: built.stderr, error: String(built.error || '')};
  assert.equal(built.status, 0, built.stderr || String(built.error));
  report.binarySHA256 = hash(binary);
  const cases = ['cancel a request before its body finishes', 'reject a duplicate live request before its body',
    'full generation admission preserves metadata and cancellation',
    'invalid identities, ambiguous framing and oversized bodies fail before work',
    'unknown cancellation does not affect another request; capacity is reclaimed',
    'queued cancellation finishes without waiting for the active worker',
    'active cancellation does not cancel another queued request',
    'finished request identity is removed before its client is released',
    'an interrupted turn cannot publish an executable complete tool call',
    'OpenAI client validation leaves tool replay to the owner',
    'Responses client validation leaves tool replay to the owner',
    'Anthropic client validation leaves tool replay to the owner',
    'cancelled owner replay preserves the admitted request and cache',
    'context admission uses the exact replay rather than the preliminary rendering',
    'native tool-map serialization runs outside shared synchronization',
    'owner diagnostic trace preserves bytes without holding shared synchronization'];
  for (const [index, name] of cases.entries()) {
    const result = spawnSync(binary, [String(index)], {encoding: 'utf8', timeout: 10000, maxBuffer: 2 ** 20});
    const row = {name, passed: false, status: result.status, signal: result.signal,
      stdout: result.stdout, stderr: result.stderr}; report.cases.push(row);
    try {
      assert.equal(result.status, 0, result.stderr || String(result.error));
      row.output = JSON.parse(result.stdout); assert.equal(row.output.failures, 0); row.passed = true;
    } catch (error) {row.error = String(error.stack || error);}
    console.log(`${row.passed ? 'PASS' : 'FAIL'}: ${name}`);
    writeArtifact(run, 'results.json', report);
  }
  for (const [file, expected] of Object.entries(report.inputs)) assert.equal(hash(file), expected, `Input changed: ${file}`);
  report.passed = report.cases.every(row => row.passed);
  if (!report.passed) process.exitCode = 1;
} catch (error) {report.error = String(error.stack || error); console.error(report.error); process.exitCode = 1;}
finally {report.finished = new Date().toISOString(); writeArtifact(run, 'results.json', report);}

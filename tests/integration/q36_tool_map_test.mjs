// Execute native disk-map functions and renderer with ASan/UBSan, not model quality.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {artifactRunDir, writeArtifact} from '../support/real_harness.mjs';
const root = path.resolve(import.meta.dirname, '../..'), run = artifactRunDir('q36-tool-map');
const report = {started: new Date().toISOString(), passed: false, scope: 'Native disk-map persistence; no model or actual tool'};
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
console.log(`Evidence: ${run}`);
try {
  assert(process.argv.length === 3 || (process.argv.length === 4 && ['--v2', '--v3'].includes(process.argv[3])),
    'Supply the exact q36 source tree and optional --v2 or --v3 snapshot tests');
  report.extendedV2 = ['--v2', '--v3'].includes(process.argv[3]);
  report.preludeV3 = process.argv[3] === '--v3';
  const source = fs.realpathSync(process.argv[2]), probe = path.join(root, 'tests/support/q36_tool_map_probe.c');
  const core = path.join(root, 'tests/support/q36_catalog_core_probe.c');
  const inputs = [probe, core, import.meta.filename,
    ...['q36.c', 'q36.h', 'q36_server.c', 'q36_image.c', 'q36_ssd.c', 'rax.c'].map(f => path.join(source, f))];
  report.inputs = Object.fromEntries(inputs.map(f => [f, hash(f)]));
  for (const file of [probe, core, import.meta.filename]) fs.copyFileSync(file, path.join(run, path.basename(file)));
  const binary = path.join(run, 'tool-map-probe');
  const args = ['-std=c11', '-O1', '-g', '-fsanitize=address,undefined', '-fno-omit-frame-pointer',
    '-ffunction-sections', '-fdata-sections', '-I', source, probe, core,
    ...['q36_image.c', 'q36_ssd.c', 'rax.c'].map(f => path.join(source, f)),
    '-lm', '-pthread', '-o', binary, process.platform === 'darwin' ? '-Wl,-dead_strip' : '-Wl,--gc-sections'];
  if (process.platform !== 'darwin') args.unshift('-D_GNU_SOURCE');
  if (report.extendedV2) args.unshift('-DDSTUDIO_Q36_TOOL_MAP_V2');
  if (report.preludeV3) args.unshift('-DDSTUDIO_Q36_TOOL_MAP_V3');
  const build = spawnSync('cc', args, {encoding: 'utf8', timeout: 120000, maxBuffer: 2 ** 21});
  report.build = {args, status: build.status, stderr: build.stderr, error: String(build.error || '')};
  assert.equal(build.status, 0, build.stderr || String(build.error)); report.binarySHA256 = hash(binary);
  const executed = spawnSync(binary, [], {encoding: 'utf8', timeout: 15000, maxBuffer: 2 ** 21});
  report.execution = {status: executed.status, signal: executed.signal, stdout: executed.stdout,
    stderr: executed.stderr, error: String(executed.error || '')};
  const rows = executed.stdout.trim().split('\n').map(line => JSON.parse(line));
  report.summary = rows.pop(); report.cases = rows;
  for (const row of rows) console.log(`${row.passed ? 'PASS' : 'FAIL'}: ${row.name}`);
  for (const [file, expected] of Object.entries(report.inputs)) assert.equal(hash(file), expected, `Input changed: ${file}`);
  assert.equal(executed.status, 0, executed.stderr || String(executed.error));
  assert.equal(report.summary.failures, 0); assert.equal(report.summary.cases, rows.length);
  assert(rows.length && rows.every(row => row.passed)); report.passed = true;
} catch (error) {report.error = String(error.stack || error); console.error(report.error); process.exitCode = 1;}
finally {report.finished = new Date().toISOString(); writeArtifact(run, 'results.json', report);}

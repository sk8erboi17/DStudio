// Native cache/decode scheduling with deterministic blocked disk output.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {artifactRunDir, writeArtifact} from '../support/real_harness.mjs';
const run = artifactRunDir('q36-cache-owner');
const report = {started: new Date().toISOString(), passed: false, scope: 'Native cache and scheduler; simulated numerical sessions'};
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
console.log(`Evidence: ${run}`);
try {
  assert(process.argv.length === 3 || (process.argv.length === 4 && process.argv[3] === '--shutdown-baseline'));
  const engine = fs.realpathSync(process.argv[2]);
  const support = path.resolve(import.meta.dirname, '../support');
  const probe = path.join(support, 'q36_cache_owner_probe.c'), core = path.join(support, 'q36_catalog_core_probe.c');
  const inputs = [probe, core, path.join(support, 'q36_http_text_prepare_probe.c'), import.meta.filename,
    ...['q36.c', 'q36.h', 'q36_server.c', 'q36_image.c', 'q36_ssd.c', 'rax.c'].map(f => path.join(engine, f))];
  report.inputs = Object.fromEntries(inputs.map(f => [f, hash(f)]));
  for (const f of inputs.slice(0, 4)) fs.copyFileSync(f, path.join(run, path.basename(f)));
  const binary = path.join(run, 'probe');
  const args = ['-std=c11', '-O1', '-g', '-fsanitize=address,undefined', '-fno-omit-frame-pointer',
    '-ffunction-sections', '-fdata-sections', '-I', engine, probe, core,
    ...['q36_image.c', 'q36_ssd.c', 'rax.c'].map(f => path.join(engine, f)), '-lm', '-pthread', '-o', binary,
    process.platform === 'darwin' ? '-Wl,-dead_strip' : '-Wl,--gc-sections'];
  if (process.platform !== 'darwin') args.unshift('-D_GNU_SOURCE');
  if (process.argv[3] === '--shutdown-baseline') args.unshift('-DDSTUDIO_Q36_CACHE_SHUTDOWN_BASELINE');
  const result = spawnSync('cc', args, {encoding: 'utf8', timeout: 120000, maxBuffer: 2 ** 21});
  report.build = {args, status: result.status, stderr: result.stderr, error: String(result.error || '')};
  assert.equal(result.status, 0, result.stderr); report.binarySHA256 = hash(binary);
  report.scenarios = [];
  for (const [kind, option] of [['write', null], ['read', '--load'], ['prefill', '--prefill'],
    ['cancel-write', '--cancel-write'], ['cancel-read', '--cancel-read'],
    ['stale-read', '--stale-read'], ['corrupt-read', '--corrupt-read'], ['shutdown', '--shutdown']]) {
    const r = spawnSync(binary, [path.join(run, `cache-${kind}`), ...(option ? [option] : [])],
      {encoding: 'utf8', timeout: 10000, maxBuffer: 2 ** 21});
    const execution = {status: r.status, stdout: r.stdout, stderr: r.stderr, signal: r.signal, error: String(r.error || '')};
    const result = r.stdout.trim() ? JSON.parse(r.stdout) : null;
    report.scenarios.push({kind, execution, result, passed: r.status === 0 && result?.failures === 0});
    writeArtifact(run, 'results.json', report);
  }
  for (const [f, expected] of Object.entries(report.inputs)) assert.equal(hash(f), expected, `Changed input: ${f}`);
  assert(report.scenarios.every(row => row.passed), report.scenarios.filter(row => !row.passed)
    .map(row => row.kind + ': ' + row.execution.stderr).join('\n'));
  report.passed = true;
} catch (error) {report.error = String(error.stack || error); console.error(report.error); process.exitCode = 1;}
finally {report.finished = new Date().toISOString(); writeArtifact(run, 'results.json', report);}

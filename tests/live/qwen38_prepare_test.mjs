// Actual Metal inference regression. Explicit invocation, existing weights only,
// sequential sessions sharing one engine; never stops unrelated processes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {artifactRunDir, writeArtifact} from '../support/real_harness.mjs';
import {fileIdentity, hashStableFile, ownGitRevision} from '../support/quality_baseline.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const args = process.argv.slice(2), receiptAt = args.indexOf('--weight-receipts');
const inventory = receiptAt < 0 ? null : fs.realpathSync(args[receiptAt + 1]);
if (receiptAt >= 0) args.splice(receiptAt, 2);
assert.equal(args.length, 3, 'Supply engine, main GGUF and PLE; optional --weight-receipts inventory-dir');
assert.equal(process.platform, 'darwin', 'This live gate qualifies Metal only');
const [engine, model, ple] = args.map(p => fs.realpathSync(p));
const run = artifactRunDir('qwen38-prepare-live'), probe = path.join(run, 'probe');
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const report = {started: new Date().toISOString(),
  scope: 'Real Qwen Metal candidate-cancellation and bit-exact parity against normal sync; development regression, not held-out quality',
  engine, revision: ownGitRevision(engine), weights: [], commands: [], rows: [], passed: false,
  memory: 'Resident main weights and native SSD PLE, expert streaming off, no MTP/DSpark; maximum two private sessions sharing weights',
  limits: {context: 16384, promptTokens: 8193, seconds: 600, outputBytes: 8 * 1024 * 1024}};
const save = () => writeArtifact(run, 'results.json', report);
const environment = Object.fromEntries(Object.entries(process.env)
  .filter(([k]) => !/^(DS4_|DS4UI_|DSTUDIO_|DYLD_)/.test(k)));
function command(exe, argv, timeout = 30000, cwd = root) {
  const started = performance.now();
  const r = spawnSync(exe, argv, {cwd, env: environment, encoding: 'utf8',
    timeout, killSignal: 'SIGKILL', maxBuffer: report.limits.outputBytes});
  const item = {exe, argv, cwd, status: r.status, signal: r.signal, error: r.error?.message,
    seconds: (performance.now() - started) / 1000};
  report.commands.push(item); writeArtifact(run, 'command-' + report.commands.length + '.json',
    {...item, stdout: r.stdout, stderr: r.stderr}); save();
  assert.equal(r.status, 0, r.stderr || r.error?.message || 'Process failed');
  return r.stdout;
}
function idle() {
  const text = command('ps', ['-axo', 'pid=,comm=']);
  const active = text.split('\n').filter(line => /\/(ds4|ds4-server|ds4-agent|ds4-agent-jsonl|ds4-cowork|ds4-design|q36|q27)(\s|$)/.test(line));
  assert.equal(active.length, 0, 'An unrelated inference process is running; no processes were stopped: ' + active.join('\n'));
}
try {
  report.harnessSHA256 = sha(import.meta.filename);
  report.probeSHA256 = sha(path.join(root, 'tests/support/qwen38_prepare_probe.c'));
  report.nativeSources = Object.fromEntries(['ds4.c', 'ds4.h', 'ds4_metal.m', 'metal/qwen4.metal', 'metal/dense.metal']
    .map(f => [f, sha(path.join(engine, f))]));
  report.host = command('system_profiler', ['SPHardwareDataType']);
  report.pressure = command('memory_pressure', ['-Q']);
  report.swap = command('sysctl', ['vm.swapusage']);
  idle();
  const receipts = inventory ? fs.readdirSync(inventory).filter(f => /^weight-\d+\.json$/.test(f))
    .map(f => ({file: path.join(inventory, f), data: JSON.parse(fs.readFileSync(path.join(inventory, f), 'utf8'))})) : [];
  for (const file of [model, ple]) {
    const identity = fileIdentity(fs.statSync(file, {bigint: true}));
    const match = receipts.find(r => r.data.identity === identity && r.data.file === file && /^[0-9a-f]{64}$/.test(r.data.sha256));
    if (inventory) assert(match, 'Weight identity changed; a new sequential integrity inventory is required');
    const entry = match ? {bytes: match.data.bytes, identity, sha256: match.data.sha256,
      hashReceipt: match.file, integrity: 'Prior full-file SHA reused after exact dev/inode/size/mtimeNs/ctimeNs check'}
      : {...await hashStableFile(file), integrity: 'Full sequential SHA during this run'};
    report.weights.push({file, ...entry}); save();
  }
  const objects = ['ds4', 'ds4_image', 'ds4_distributed', 'ds4_tp', 'ds4_ssd', 'ds4_metal',
    'ds4_layer_pack', 'ds4_gpu_args', 'ds4_help', 'ds4_prompt_prefix', 'linenoise']
    .map(n => path.join(engine, n + '.o'));
  report.objects = objects.map(file => ({file: path.basename(file), sha256: sha(file)}));
  command('cc', ['-O2', '-g', '-Wall', '-Wextra', '-Werror', '-std=c11', '-I', engine,
    path.join(root, 'tests/support/qwen38_prepare_probe.c'), ...objects, '-lm', '-pthread',
    '-framework', 'Foundation', '-framework', 'Metal', '-o', probe], 120000);
  report.binarySHA256 = sha(probe); save(); idle();
  console.log('Starting one real Qwen3.8 engine; receipt: ' + run);
  const out = command('/usr/bin/time', ['-l', probe, model, ple], report.limits.seconds * 1000, engine);
  report.rows = out.trim().split('\n').filter(s => s.startsWith('{"case":')).map(s => JSON.parse(s));
  assert.equal(report.rows.length, 8);
  assert(report.rows.every(r => r.case === 'load' || r.passed));
  assert.equal(report.rows.filter(r => r.case === 'cancel').length, 3);
  report.passed = true;
} catch (error) {
  report.error = String(error.stack || error); console.error(report.error); process.exitCode = 1;
} finally {
  for (const item of report.weights) {
    if (fileIdentity(fs.statSync(item.file, {bigint: true})) !== item.identity) {
      report.passed = false; report.weightChanged = item.file; process.exitCode = 1;
    }
  }
  if (report.nativeSources) for (const [file, before] of Object.entries(report.nativeSources)) {
    if (sha(path.join(engine, file)) !== before) {
      report.passed = false; report.sourceChanged = file; process.exitCode = 1;
    }
  }
  report.finished = new Date().toISOString(); save(); console.log(run);
}

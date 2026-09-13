// Actual native worker/command path with a deterministic inference barrier.
// No weights are loaded; this is not a model quality or numerical parity gate.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {artifactRunDir, writeArtifact} from '../support/real_harness.mjs';
import {ownGitRevision} from '../support/quality_baseline.mjs';
const root = path.resolve(import.meta.dirname, '../..');
assert.equal(process.platform, 'darwin', 'This native link gate currently targets macOS');
assert(process.argv[2], 'Supply an already-built pinned Qwen engine');
const engine = fs.realpathSync(process.argv[2]);
const qwen38 = process.argv.includes('--qwen38');
const sanitize = process.argv.includes('--sanitize');
const baselineAt = process.argv.indexOf('--baseline');
const baseline = baselineAt < 0 ? null : path.resolve(process.argv[baselineAt + 1]);
const sourceAt = process.argv.indexOf('--source');
const source = sourceAt < 0 ? baseline : path.resolve(process.argv[sourceAt + 1]);
const run = artifactRunDir('agent-session-reset');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const report = {started: new Date().toISOString(), engine, qwen38, baseline,
  scope: 'Native threaded session-reset behavior, simulated inference API; no model weights',
  sanitizers: sanitize ? 'ASan/UBSan on Agent/DStudio helpers; upstream core objects not instrumented' : 'not enabled',
  commands: [], rows: [], passed: false};
const save = () => writeArtifact(run, 'results.json', report);
function command(exe, args, {check = true, timeout = 120000} = {}) {
  const r = spawnSync(exe, args, {cwd: root, encoding: 'utf8', timeout,
    maxBuffer: 16 * 1024 * 1024, env: {...process.env, DS4UI_SESSION_CACHE_DIR: path.join(run, 'cache')}});
  const row = {exe, args, status: r.status, signal: r.signal, error: String(r.error || '')};
  report.commands.push(row); save();
  writeArtifact(run, `command-${report.commands.length}.json`, {...row, stdout: r.stdout, stderr: r.stderr});
  if (check) assert.equal(r.status, 0, r.stderr || r.error?.message || `Process ended: ${r.signal || r.status}`);
  return r;
}
try {
  report.engineGit = ownGitRevision(engine);
  report.sourceSHA256 = hash(fs.readFileSync(path.join(engine, 'ds4_agent.c')));
  report.harnessSHA256 = hash(fs.readFileSync(import.meta.filename));
  report.probeSHA256 = hash(fs.readFileSync(path.join(root, 'tests/support/agent_reset_probe.c')));
  const emitter = path.join(run, 'emit');
  command('cc', ['-O1', '-std=c11', 'tests/support/emit_agent_patch.c', '-o', emitter]);
  if (source) fs.copyFileSync(source, path.join(run, 'ds4_agent.c'));
  else command(emitter, [path.join(engine, 'ds4_agent.c'), path.join(run, 'ds4_agent.c')]);
  command(emitter, [path.join(engine, 'ds4_web.c'), path.join(run, 'ds4_web.c'), '--web']);
  report.derivedSHA256 = hash(fs.readFileSync(path.join(run, 'ds4_agent.c')));
  const flags = ['-O1', '-std=c11', ...(qwen38 ? ['-DDSTUDIO_RESET_QWEN38'] : []),
    ...(sanitize ? ['-g', '-fno-omit-frame-pointer', '-fsanitize=address,undefined', '-fno-sanitize-recover=all'] : []),
    ...[run, engine, path.join(root, 'extension/remote'), path.join(root, 'extension/cowork'),
      path.join(root, 'patch/ds4-agent-jsonl')].flatMap(p => ['-I', p])];
  const objects = ['ds4', 'ds4_distributed', 'ds4_tp', 'ds4_ssd', 'ds4_metal', 'ds4_layer_pack',
    'ds4_help', 'ds4_kvstore', 'linenoise', 'ds4_gpu_args'].map(n => path.join(engine, `${n}.o`));
  if (qwen38) objects.push(path.join(engine, 'ds4_image.o'));
  if (fs.existsSync(path.join(engine, 'ds4_prompt_prefix.o'))) objects.push(path.join(engine, 'ds4_prompt_prefix.o'));
  report.engineObjects = objects.map(file => ({file: path.basename(file), sha256: hash(fs.readFileSync(file))}));
  for (const [name, file] of [['web', path.join(run, 'ds4_web.c')],
    ['cowork', path.join(root, 'extension/cowork/ds4_cowork.c')],
    ['remote', path.join(root, 'extension/remote/dstudio_remote_llm.c')],
    ['pld', path.join(root, 'patch/ds4-agent-jsonl/pld_core.c')]]) {
    const object = path.join(run, `${name}.o`);
    command('cc', [...flags, '-c', file, '-o', object]); objects.push(object);
  }
  const binary = path.join(run, 'probe');
  command('cc', [...flags, '-Wno-unused-function', 'tests/support/agent_reset_probe.c', ...objects,
    '-lm', '-pthread', '-framework', 'Foundation', '-framework', 'Metal', '-o', binary]);
  // Old synchronous code cannot reach a candidate-allocation failure. Its
  // baseline is still bounded externally, but use the shared three cases.
  for (const scenario of ['cancel', 'failure', 'success',
    ...(baseline ? [] : ['allocation', 'late_cancel', 'duplicate', ...(qwen38 ? ['save_failure'] : [])])]) {
    const r = command(binary, [scenario], {check: false, timeout: 20000});
    const line = r.stdout?.trim().split('\n').findLast(x => x.startsWith('{"case":'));
    report.rows.push({scenario, exitCode: r.status, ...(line ? JSON.parse(line) : {passed: false, error: r.stderr || String(r.error)})});
    save();
  }
  assert(report.rows.every(r => r.passed && r.exitCode === 0), 'Session reset invariants failed; retained per-case receipts');
  report.passed = true;
} catch (error) { report.error = String(error.stack || error); console.error(report.error); process.exitCode = 1; }
finally { report.finished = new Date().toISOString(); save(); console.log(run); }

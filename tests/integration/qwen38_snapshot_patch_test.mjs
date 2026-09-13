// Real native helper execution, deterministic allocator failures and exact patch
// lifecycle. The allocator is simulated; no weights or GPU work are claimed.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {artifactRunDir} from '../support/real_harness.mjs';
import {ownGitRevision} from '../support/quality_baseline.mjs';

const root = process.cwd(), source = fs.realpathSync(process.argv[2]);
const run = artifactRunDir('qwen38-snapshot'), target = path.join(run, 'source');
const script = path.join(root, 'scripts/apply-ds4-qwen38-snapshot.sh');
const probe = path.join(root, 'tests/support/qwen38_snapshot_alloc_probe.c');
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const report = {schema: 'dstudio.qwen38-snapshot.v1', started: new Date().toISOString(),
  scope: 'Native snapshot helper execution with simulated allocation failures; patch lifecycle; no model or numerical qualification',
  source, revision: ownGitRevision(source), commands: [], checks: [], passed: false,
  support: Object.fromEntries([script, probe, import.meta.filename,
    ...['snapshot-allocation.patch', 'depth3-allocation.patch'].map(f => path.join(root, 'patch/ds4-qwen38-snapshot', f))]
    .map(f => [path.relative(root, f), sha(f)]))};
const save = () => fs.writeFileSync(path.join(run, 'results.json'), JSON.stringify(report, null, 2) + '\n');
function invoke(command, args, label, env = {}) {
  const began = performance.now();
  const r = spawnSync(command, args, {cwd: root, encoding: 'utf8', timeout: 120000,
    env: {...process.env, ...env}, maxBuffer: 4 * 1024 ** 2});
  fs.writeFileSync(path.join(run, label + '.log'), (r.stdout ?? '') + (r.stderr ?? ''));
  report.commands.push({command: [command, ...args], label, code: r.status, signal: r.signal,
    error: r.error?.message, seconds: (performance.now() - began) / 1000}); save(); return r;
}
let step = 0;
const patch = action => invoke('sh', [script, action], `patch-${++step}-${action}`, {DS4_DIR: target});
const check = name => {report.checks.push({name, status: 'PASS'}); save(); console.log('PASS: ' + name);};
try {
  fs.mkdirSync(target);
  for (const entry of fs.readdirSync(source, {withFileTypes: true}))
    if (entry.isFile() && /\.(c|h|inc)$/.test(entry.name))
      fs.copyFileSync(path.join(source, entry.name), path.join(target, entry.name));
  assert.equal(patch('restore').status, 0);
  const file = path.join(target, 'ds4.c'), original = fs.readFileSync(file);
  report.originalSourceSha256 = sha(file);
  fs.appendFileSync(file, '\n/* preserve unrelated contributor content */\n');
  const unrelated = fs.readFileSync(file);
  const binary = name => path.join(run, name);
  const build = name => invoke('cc', ['-O1', '-g', '-fsanitize=address,undefined', '-fno-omit-frame-pointer',
    '-ffunction-sections', '-fdata-sections', '-Wno-unused-function', '-I', target, probe,
    '-Wl,-dead_strip', '-lm', '-pthread', '-o', binary(name)], name + '-build');
  assert.equal(build('before').status, 0);
  const before = invoke(binary('before'), [], 'before-run');
  assert.ok(before.signal === 'SIGABRT' || before.status === 134, 'the exact unpatched allocation invariant must fail');
  assert.ok(fs.readFileSync(path.join(run, 'before-run.log'), 'utf8').includes('outstanding=2'),
    'failure must be the reproduced incomplete snapshot, not an unrelated crash');
  check('unmodified upstream reproducibly retains a partial snapshot after allocation failure');
  assert.equal(patch('check').status, 0); assert.deepEqual(fs.readFileSync(file), unrelated);
  assert.equal(patch('apply').status, 0); const patched = fs.readFileSync(file);
  assert.notDeepEqual(patched, unrelated);
  assert.equal(patch('apply').status, 0); assert.deepEqual(fs.readFileSync(file), patched);
  assert.equal(patch('check').status, 0); assert.deepEqual(fs.readFileSync(file), patched);
  assert.equal(build('after').status, 0);
  assert.equal(invoke(binary('after'), [], 'after-run').status, 0);
  check('all 10 allocation failpoints, complete retries, stable live state and bounded cleanup pass with ASan/UBSan');
  assert.equal(patch('restore').status, 0); assert.deepEqual(fs.readFileSync(file), unrelated);
  assert.equal(patch('restore').status, 0); assert.deepEqual(fs.readFileSync(file), unrelated);
  check('apply/repeat/check/restore preserve unrelated bytes');
  // Apply only the older depth-3 half to this newer source. Selecting that half
  // must not let an incomplete newer adaptation pass as an older full variant.
  const half = path.join(root, 'patch/ds4-qwen38-snapshot/depth3-allocation.patch');
  assert.equal(invoke('git', ['-C', target, 'apply', half], 'prepare-partial', {GIT_CEILING_DIRECTORIES: run}).status, 0);
  const partial = fs.readFileSync(file);
  for (const action of ['apply', 'check', 'restore']) {
    assert.notEqual(patch(action).status, 0); assert.deepEqual(fs.readFileSync(file), partial);
  }
  check('partial new snapshot set cannot be accepted as the older complete adaptation');
  fs.writeFileSync(file, unrelated);
  const drift = unrelated.toString().replace('    g->snap0_ple_hist = qwen4_graph_alloc_f32(',
    '    g->snap0_ple_hist = /* independently changed allocation */ qwen4_graph_alloc_f32(');
  assert.notEqual(drift, unrelated.toString()); fs.writeFileSync(file, drift);
  assert.notEqual(patch('apply').status, 0); assert.equal(fs.readFileSync(file, 'utf8'), drift);
  fs.writeFileSync(file, unrelated);
  const outside = path.join(run, 'outside.c'); fs.writeFileSync(outside, unrelated);
  fs.unlinkSync(file); fs.symlinkSync(outside, file);
  assert.notEqual(patch('apply').status, 0); assert.deepEqual(fs.readFileSync(outside), unrelated);
  fs.unlinkSync(file); fs.writeFileSync(file, unrelated);
  fs.writeFileSync(path.join(target, 'ds4.h'), '/* incompatible engine header */\n');
  assert.notEqual(patch('apply').status, 0); assert.deepEqual(fs.readFileSync(file), unrelated);
  check('drift, linked files and incompatible ABI fail without modifying the target');
  report.passed = true;
} catch (e) {report.error = e.stack; console.error(e); process.exitCode = 1;}
finally {report.finished = new Date().toISOString(); save(); console.log('Evidence: ' + run);}

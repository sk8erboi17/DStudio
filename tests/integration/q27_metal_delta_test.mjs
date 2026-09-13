// Real Metal operators and exact versioned-patch lifecycle in a private copy.
// No weights, network, language generation or user-engine mutation.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {artifactRunDir} from '../support/real_harness.mjs';
import {ownGitRevision} from '../support/quality_baseline.mjs';

assert.equal(process.platform, 'darwin', 'Actual Metal hardware is required');
assert.ok(process.argv[2], 'Supply the separately downloaded q27 checkout');
const root = process.cwd(), source = fs.realpathSync(process.argv[2]);
const run = artifactRunDir('q27-metal-delta'), target = path.join(run, 'source');
const script = path.join(root, 'scripts/apply-q27-metal-delta.sh');
const patchFile = path.join(root, 'patch/q27-metal-delta/columns64.patch');
const probe = path.join(root, 'tests/support/q27_delta_probe.cpp');
const relative = ['src/metal/metal_backend.mm', 'src/metal/q27_kernels.metal'];
const sha = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const report = {started: new Date().toISOString(), source, revision: ownGitRevision(source),
  host: {cpu: os.cpus()[0]?.model, release: os.release()},
  scope: 'Real native Metal operators, independent scalar recurrence, serial/chunk equality and patch lifecycle. No model-quality or CUDA qualification.',
  inputs: Object.fromEntries([script, patchFile, probe, import.meta.filename].map(f => [path.relative(root, f), sha(f)])),
  commands: [], checks: [], passed: false};
const save = () => fs.writeFileSync(path.join(run, 'results.json'), JSON.stringify(report, null, 2) + '\n');
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(Q27_|GIT_|MAKEFLAGS$|MFLAGS$)/.test(k)));
let active;
const killOwned = () => {if (active) try {process.kill(-active.pid, 'SIGKILL');} catch {}};
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => {
  report.interrupted = signal; save(); killOwned(); process.exit(130);
});
async function invoke(exe, args, label, extra = {}) {
  const log = path.join(run, label + '.log'), fd = fs.openSync(log, 'wx');
  const row = {label, command: [exe, ...args], seconds: 0};
  report.commands.push(row); save(); const began = performance.now();
  const child = spawn(exe, args, {cwd: target, env: {...env, ...extra}, detached: true, stdio: ['ignore', fd, fd]});
  active = child; fs.closeSync(fd);
  const timer = setTimeout(() => {row.timeout = true; killOwned();}, 180000);
  const bounded = setInterval(() => {
    if (fs.statSync(log).size > 16 * 1024 ** 2) {row.logLimit = true; killOwned();}
  }, 1000);
  const result = await new Promise(resolve => {
    child.once('error', e => resolve({error: String(e)}));
    child.once('exit', (code, signal) => resolve({code, signal}));
  });
  active = null; clearTimeout(timer); clearInterval(bounded);
  Object.assign(row, result, {seconds: (performance.now() - began) / 1000}); save();
  return {...row, output: fs.readFileSync(log, 'utf8')};
}
let step = 0;
const patch = action => invoke('sh', [script, action], `patch-${++step}-${action}`, {Q27_DIR: target});
const contents = () => relative.map(f => fs.readFileSync(path.join(target, f), 'utf8'));
const check = name => {report.checks.push(name); save(); console.log('PASS: ' + name);};
const build = name => invoke('c++', ['-O2', '-std=c++17', '-Wall', '-Wextra', '-Werror', '-fobjc-arc', '-pthread',
  '-I', 'src/metal', probe, 'src/metal/metal_backend.mm', 'src/loader.cpp',
  '-framework', 'Foundation', '-framework', 'Metal', '-o', path.join(run, name)], name + '-build');
try {
  fs.mkdirSync(target);
  for (const file of ['src', 'third_party', 'Makefile'])
    fs.cpSync(path.join(source, file), path.join(target, file), {recursive: true, dereference: false, errorOnExist: true});
  assert.equal((await patch('restore')).code, 0);
  fs.appendFileSync(path.join(target, relative[0]), '\n// Unrelated contributor bytes must survive every lifecycle operation.\n');
  const original = contents();
  report.original = relative.map(f => ({file: f, sha256: sha(path.join(target, f))}));
  assert.equal((await build('before')).code, 0);
  const shader = path.join(target, relative[1]);
  const before = await invoke(path.join(run, 'before'), [], 'before-run', {Q27_METAL_SOURCE: shader});
  if (before.code !== 0) {
    assert.equal(before.code, 1);
    assert.ok(before.output.includes('unsupported DeltaNet shape'), 'baseline must fail for the actual reproduced reason');
    report.baselineReproduced = true;
  } else report.baselineReproduced = false; // A device supporting 512 threads need not fail.
  check('baseline outcome retained; unavailable 512-thread dispatch is not a fabricated model failure');
  assert.equal((await patch('check')).code, 0); assert.deepEqual(contents(), original);
  assert.equal((await patch('apply')).code, 0); const applied = contents();
  assert.notDeepEqual(applied, original);
  assert.equal((await patch('apply')).code, 0); assert.deepEqual(contents(), applied);
  assert.equal((await patch('check')).code, 0); assert.deepEqual(contents(), applied);
  assert.equal((await build('after')).code, 0);
  const after = await invoke(path.join(run, 'after'), [], 'after-run', {Q27_METAL_SOURCE: shader});
  assert.equal(after.code, 0, after.output);
  report.rows = after.output.trim().split('\n').map(JSON.parse);
  assert.equal(report.rows.length, 24); assert.ok(report.rows.every(r => r.passed));
  assert.equal(new Set(report.rows.map(r => `${r.heads}/${r.tokens}/${r.inplace}`)).size, 24);
  check('24 real GPU cases: scalar matrix oracle, every state/output value, guards, input preservation and exact chunk/serial equality');
  assert.equal((await invoke('make', ['-j2', 'test-metal-backend', 'build/q27-metal', 'build/q27-metal-server'], 'native-suite')).code, 0);
  check('unchanged upstream Metal operator suite and actual native CLI/server builds pass');
  const oldHost = await invoke(path.join(run, 'before'), [], 'old-host-new-shader', {Q27_METAL_SOURCE: shader});
  assert.equal(oldHost.code, 1); assert.ok(oldHost.output.includes('shader ABI mismatch'));
  fs.writeFileSync(shader, original[1]);
  const newHost = await invoke(path.join(run, 'after'), [], 'new-host-old-shader', {Q27_METAL_SOURCE: shader});
  assert.equal(newHost.code, 1); assert.ok(newHost.output.includes('shader ABI mismatch'));
  const partial = contents();
  for (const action of ['check', 'apply', 'restore']) {
    assert.notEqual((await patch(action)).code, 0); assert.deepEqual(contents(), partial);
  }
  check('both mixed host/shader directions and partial source application are rejected');
  fs.writeFileSync(shader, applied[1]);
  assert.equal((await patch('restore')).code, 0); assert.deepEqual(contents(), original);
  assert.equal((await patch('restore')).code, 0); assert.deepEqual(contents(), original);
  check('apply/repeat/restore preserve unrelated contributor bytes');
  const hostFile = path.join(target, relative[0]);
  const drift = original[0].replace('maxTotalThreadsPerThreadgroup<512', 'maxTotalThreadsPerThreadgroup<510');
  assert.notEqual(drift, original[0]); fs.writeFileSync(hostFile, drift);
  assert.notEqual((await patch('apply')).code, 0); assert.deepEqual(contents(), [drift, original[1]]);
  fs.writeFileSync(hostFile, original[0]);
  const outside = path.join(run, 'outside.mm'); fs.writeFileSync(outside, original[0]);
  fs.unlinkSync(hostFile); fs.symlinkSync(outside, hostFile);
  assert.notEqual((await patch('apply')).code, 0); assert.equal(fs.readFileSync(outside, 'utf8'), original[0]);
  fs.unlinkSync(hostFile); fs.writeFileSync(hostFile, original[0]);
  fs.appendFileSync(path.join(target, 'src/metal/metal_backend.h'), '\n// incompatible ABI\n');
  assert.notEqual((await patch('apply')).code, 0); assert.deepEqual(contents(), original);
  check('drift, linked source and unreviewed ABI fail without publication');
  report.passed = true;
} catch (e) {report.error = e.stack; console.error(e); process.exitCode = 1;}
finally {killOwned(); report.finished = new Date().toISOString(); save(); console.log('Evidence: ' + run);}

// Execute the candidate patch lifecycle in an isolated archive-style tree.
// Patch slicing below constructs partial installs; only resulting behavior,
// byte preservation and the build dependency decision are assertions.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {artifactRunDir, writeArtifact} from '../support/real_harness.mjs';

const root = path.resolve(import.meta.dirname, '../..'), run = artifactRunDir('q36-f16-attention-patch');
const tree = path.join(run, 'source'), files = ['q36_metal.m', 'metal/attention.metal'];
const script = path.join(root, 'scripts/apply-q36-f16-attention.sh');
const patch = path.join(root, 'patch/q36-f16-attention/runtime.patch');
const report = {started: new Date().toISOString(), passed: false, tests: [], commands: [],
  scope: 'Actual patch lifecycle and Make dependency decision; no inference or fresh network installation'};
const save = () => writeArtifact(run, 'results.json', report);
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const env = {PATH: process.env.PATH, LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CEILING_DIRECTORIES: run};
const snapshot = () => files.map(f => fs.readFileSync(path.join(tree, f)));
const restore = data => files.forEach((f, i) => fs.writeFileSync(path.join(tree, f), data[i]));
function command(binary, args, expected = 0, cwd = tree, extra = {}) {
  const r = spawnSync(binary, args, {cwd, env: {...env, ...extra}, timeout: 15000, maxBuffer: 1024 * 1024});
  report.commands.push({binary, args, status: r.status, signal: r.signal,
    error: r.error?.message, stdout: r.stdout?.toString(), stderr: r.stderr?.toString()}); save();
  assert.ifError(r.error); assert.equal(r.status, expected, r.stderr?.toString());
}
const apply = (action, expected = 0, extra = {}) => command('/bin/sh', [script, action], expected,
  tree, {Q36_DIR: tree, ...extra});
function test(name, fn) {fn(); report.tests.push({name, passed: true}); save();}
try {
  assert.equal(process.argv.length, 3, 'Supply one built q36 candidate directory');
  const source = fs.realpathSync(process.argv[2]);
  const inputs = [script, patch, import.meta.filename, ...files.map(f => path.join(source, f))];
  report.inputs = Object.fromEntries(inputs.map(f => [f, sha(fs.readFileSync(f))]));
  fs.copyFileSync(patch, path.join(run, 'candidate.patch'), fs.constants.COPYFILE_EXCL);
  fs.copyFileSync(script, path.join(run, 'apply.sh'), fs.constants.COPYFILE_EXCL);
  fs.mkdirSync(path.join(tree, 'metal'), {recursive: true});
  for (const f of files) fs.copyFileSync(path.join(source, f), path.join(tree, f), fs.constants.COPYFILE_EXCL);
  apply('restore');
  // Same-file and separate-file unrelated user changes must survive every action.
  for (const f of files) fs.appendFileSync(path.join(tree, f), '\n/* Unrelated lifecycle fixture change. */\n');
  const unrelated = path.join(tree, 'unrelated.txt'); fs.writeFileSync(unrelated, 'keep these bytes\n');
  const baseline = snapshot(); let adapted;
  test('check does not apply an unapplied patch', () => {apply('check'); assert.deepEqual(snapshot(), baseline);});
  test('apply, repeat and check preserve exact adapted bytes', () => {
    apply('apply'); adapted = snapshot();
    assert(files.every((_, i) => !adapted[i].equals(baseline[i])));
    apply('apply'); apply('check'); assert.deepEqual(snapshot(), adapted);
  });
  test('restore and repeat restore preserve unrelated changes', () => {
    apply('restore'); apply('restore'); assert.deepEqual(snapshot(), baseline);
    assert.equal(fs.readFileSync(unrelated, 'utf8'), 'keep these bytes\n');
  });
  test('ambient Git worktree and configuration cannot redirect application', () => {
    apply('apply', 0, {GIT_DIR: path.join(source, '.git'), GIT_WORK_TREE: source,
      GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'apply.reject', GIT_CONFIG_VALUE_0: 'true'});
    assert.deepEqual(snapshot(), adapted); apply('restore');
  });
  for (const file of files) test('partial file application rejected atomically: ' + file, () => {
    restore(baseline); command('git', ['apply', '--include=' + file, patch]);
    const partial = snapshot();
    for (const action of ['apply', 'check', 'restore']) {apply(action, 1); assert.deepEqual(snapshot(), partial);}
  });
  const fragments = [];
  for (const section of fs.readFileSync(patch, 'utf8').split(/(?=^diff --git )/m).filter(Boolean)) {
    const start = section.indexOf('\n@@'), header = section.slice(0, start + 1);
    for (const hunk of section.slice(start + 1).split(/(?=^@@ )/m).filter(Boolean)) {
      const file = path.join(run, `fragment-${fragments.length}.patch`);
      fs.writeFileSync(file, header + hunk); fragments.push(file);
    }
  }
  assert.equal(fragments.length, 3, 'Update partial-install scenarios when the patch structure changes');
  for (const selection of [[1], [2], [0, 1], [0, 2]]) test('partial hunk application rejected atomically: ' + selection, () => {
    restore(baseline);
    for (const index of selection) command('git', ['apply', fragments[index]]);
    const partial = snapshot();
    for (const action of ['apply', 'check', 'restore']) {apply(action, 1); assert.deepEqual(snapshot(), partial);}
  });
  for (const file of files) test('drift rejected atomically: ' + file, () => {
    restore(adapted); fs.writeFileSync(path.join(tree, file), 'incompatible source fixture\n');
    const drift = snapshot();
    for (const action of ['apply', 'check', 'restore']) {apply(action, 1); assert.deepEqual(snapshot(), drift);}
  });
  restore(baseline);
  for (const file of files) test('linked target rejected without touching destination: ' + file, () => {
    const target = path.join(tree, file), saved = target + '.saved';
    fs.renameSync(target, saved); fs.symlinkSync(saved, target);
    apply('apply', 2); assert.deepEqual(fs.readFileSync(saved), baseline[files.indexOf(file)]);
    fs.unlinkSync(target); fs.renameSync(saved, target);
  });
  test('linked shader directory and linked checkout rejected', () => {
    fs.renameSync(path.join(tree, 'metal'), path.join(tree, 'metal.saved'));
    fs.symlinkSync(path.join(tree, 'metal.saved'), path.join(tree, 'metal'));
    apply('apply', 2); fs.unlinkSync(path.join(tree, 'metal'));
    fs.renameSync(path.join(tree, 'metal.saved'), path.join(tree, 'metal'));
    const link = path.join(run, 'linked-source'); fs.symlinkSync(tree, link);
    apply('apply', 2, {Q36_DIR: link}); assert.deepEqual(snapshot(), baseline);
  });
  test('unknown actions rejected without source changes', () => {apply('unknown', 2); assert.deepEqual(snapshot(), baseline);});
  test('final reapply and restore remain lossless', () => {
    apply('apply'); assert.deepEqual(snapshot(), adapted); apply('restore'); assert.deepEqual(snapshot(), baseline);
    assert.equal(fs.readFileSync(unrelated, 'utf8'), 'keep these bytes\n');
  });
  test('Make invalidates the native object for either modified input', () => {
    command('make', ['-q', 'q36_metal.o'], 0, source);
    for (const file of files) command('make', ['-q', '-W', file, 'q36_metal.o'], 1, source);
  });
  report.inputsPreserved = inputs.every(f => sha(fs.readFileSync(f)) === report.inputs[f]);
  assert(report.inputsPreserved); report.passed = true;
} catch (e) {report.error = e.stack; process.exitCode = 1;}
finally {report.finished = new Date().toISOString(); save();
  console.log(JSON.stringify({run, passed: report.passed, tests: report.tests.length, error: report.error}));}

// Reversible source patch, actual HTTP receipts and native build dependencies.
// Source copies are task-owned; native numerical work is simulated by the probe.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {artifactRunDir, writeArtifact} from '../support/real_harness.mjs';

const root = path.resolve(import.meta.dirname, '../..'), run = artifactRunDir('q36-cache-usage-patch');
const tree = path.join(run, 'source'), target = path.join(tree, 'q36_server.c');
const script = path.join(root, 'scripts/apply-q36-metal-runtime.sh');
const patch = path.join(root, 'patch/q36-metal-runtime/cache-usage.patch');
const probe = path.join(root, 'tests/integration/q36_http_text_prepare_test.mjs');
const report = {started: new Date().toISOString(), passed: false, cases: [], commands: [],
  scope: 'Real patch/files/build/HTTP serializers with simulated numerical state; no model, app or network'};
const save = () => writeArtifact(run, 'results.json', report);
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const env = {PATH: process.env.PATH, LC_ALL: 'C', Q36_DIR: tree,
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CEILING_DIRECTORIES: run};
function command(binary, args, expected = 0, extra = {}, timeout = 30000, cwd = tree) {
  const result = spawnSync(binary, args, {cwd, env: {...env, ...extra}, encoding: 'utf8', timeout, maxBuffer: 2 ** 21});
  report.commands.push({binary, args, code: result.status, signal: result.signal,
    stdout: result.stdout, stderr: result.stderr, error: result.error?.message}); save();
  assert.ifError(result.error); assert.equal(result.status, expected, result.stderr);
  return result;
}
const apply = (action, expected = 0, extra = {}) => command('/bin/sh', [script, action, 'cache-usage'], expected, extra);
function check(name, fn) {
  const row = {name, passed: false}; report.cases.push(row); save();
  try {fn(row); row.passed = true;}
  catch (error) {row.error = error.stack; throw error;}
  finally {save(); console.log(`${row.passed ? 'PASS' : 'FAIL'} ${name}`);}
}
console.log('Evidence: ' + run); save();
try {
  assert.equal(process.argv.length, 3, 'Supply an installed q36 source tree');
  const source = fs.realpathSync(process.argv[2]), receiptFile = path.join(source, '.dstudio-source.json');
  const receipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
  assert.equal(receipt.commit, '8362010a301b3360296e435703f58ffc230a024a');
  const names = Object.keys(receipt.sources); assert.ok(names.length > 0 && names.length <= 8192);
  report.inputs = Object.fromEntries([script, patch, probe, import.meta.filename, receiptFile,
    path.join(root, 'tests/support/q36_http_text_prepare_probe.c'),
    ...names.map(name => path.join(source, name))].map(file => [file, hash(file)]));
  fs.mkdirSync(tree); let bytes = 0;
  for (const name of names) {
    assert.ok(!path.isAbsolute(name) && name.length <= 1024 && name.split('/').length <= 20 &&
      !name.split('/').some(part => !part || part === '.' || part === '..'));
    const from = path.join(source, name), to = path.join(tree, name), info = fs.lstatSync(from);
    assert.ok(info.isFile() && (bytes += info.size) <= 256 * 1024 * 1024);
    assert.equal(hash(from), receipt.sources[name]);
    fs.mkdirSync(path.dirname(to), {recursive: true}); fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
  }
  apply('restore');
  fs.appendFileSync(target, '\n/* Unrelated contributor fixture: preserve across apply/restore. */\n');
  const baseline = fs.readFileSync(target); let adapted;
  check('check is read-only on an unpatched source', () => {apply('check'); assert.deepEqual(fs.readFileSync(target), baseline);});
  check('apply and repeat apply publish identical source bytes', () => {
    apply('apply'); adapted = fs.readFileSync(target); assert.notDeepEqual(adapted, baseline);
    apply('apply'); apply('check'); assert.deepEqual(fs.readFileSync(target), adapted);
  });
  check('restore and repeat preserve unrelated source edits', () => {
    apply('restore'); apply('restore'); assert.deepEqual(fs.readFileSync(target), baseline);
  });
  check('ambient Git configuration cannot redirect the patch', () => {
    apply('apply', 0, {GIT_DIR: path.join(source, '.git'), GIT_WORK_TREE: source,
      GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'apply.reject', GIT_CONFIG_VALUE_0: 'true'});
    assert.deepEqual(fs.readFileSync(target), adapted); apply('restore');
  });
  // Patch slicing creates each partial installation; assertions execute the
  // production applier and compare actual bytes, not source wording.
  const text = fs.readFileSync(patch, 'utf8'), start = text.indexOf('\n@@');
  const header = text.slice(0, start + 1), hunks = text.slice(start + 1).split(/(?=^@@ )/m).filter(Boolean);
  assert.equal(hunks.length, 2, 'Exercise every nonempty partial stack when the patch changes');
  for (const [index, hunk] of hunks.entries()) check('partial hunk is rejected without writes: ' + index, () => {
    fs.writeFileSync(target, baseline);
    const fragment = path.join(run, `fragment-${index}.patch`); fs.writeFileSync(fragment, header + hunk, {flag: 'wx'});
    command('git', ['apply', fragment]); const partial = fs.readFileSync(target);
    for (const action of ['apply', 'check', 'restore']) {apply(action, 1); assert.deepEqual(fs.readFileSync(target), partial);}
  });
  check('source drift is rejected without overwriting it', () => {
    fs.writeFileSync(target, 'incompatible source fixture\n'); const before = fs.readFileSync(target);
    for (const action of ['apply', 'check', 'restore']) {apply(action, 1); assert.deepEqual(fs.readFileSync(target), before);}
  });
  fs.writeFileSync(target, baseline);
  check('linked source cannot redirect a patch', () => {
    const saved = target + '.saved'; fs.renameSync(target, saved); fs.symlinkSync(saved, target);
    apply('apply', 2); assert.deepEqual(fs.readFileSync(saved), baseline);
    fs.unlinkSync(target); fs.renameSync(saved, target);
  });
  check('an incompatible GPU ABI remains rejected', () => {
    const file = path.join(tree, 'q36_gpu.h'), original = fs.readFileSync(file);
    fs.appendFileSync(file, '\n/* incompatible ABI fixture */\n'); apply('apply', 1);
    assert.deepEqual(fs.readFileSync(target), baseline); fs.writeFileSync(file, original);
  });
  apply('apply');
  for (const batched of [false, true]) check('actual cache/HTTP receipts and owner transitions: ' + (batched ? 'batched' : 'single'), row => {
    const result = command(process.execPath, [probe, tree, '--next', '--cache-usage', ...(batched ? ['--batched'] : [])],
      0, {}, 180000, root);
    const line = result.stdout.split('\n').find(line => line.startsWith('Evidence: ')); assert.ok(line);
    row.receipt = path.join(line.slice('Evidence: '.length), 'results.json');
    const evidence = JSON.parse(fs.readFileSync(row.receipt, 'utf8'));
    assert.equal(evidence.status, 'PASS'); assert.equal(evidence.cases.length, batched ? 68 : 78);
    assert.ok(evidence.cases.every(test => test.passed)); row.sha256 = hash(row.receipt);
  });
  check('changed server source invalidates both native build consumers', () => {
    command('make', ['-j2', 'q36_server.o', 'q36_test_metal.o'], 0, {}, 120000);
    for (const object of ['q36_server.o', 'q36_test_metal.o']) {
      command('make', ['-q', object]); command('make', ['-q', '-W', 'q36_server.c', object], 1);
    }
  });
  report.inputsUnchanged = Object.entries(report.inputs).every(([file, digest]) => hash(file) === digest);
  assert.ok(report.inputsUnchanged); report.patchedServerSHA256 = hash(target); report.source = tree; report.passed = true;
} catch (error) {report.error = error.stack; process.exitCode = 1;}
finally {report.finished = new Date().toISOString(); save(); console.log(`${report.passed ? 'PASS' : 'FAIL'} ${run}`);}

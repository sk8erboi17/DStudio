// Exercise the multi-file patch transaction on private source copies.
// File comparisons prove preservation/round-trip, not inference correctness.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {artifactRunDir, writeArtifact} from '../support/real_harness.mjs';
import {ownGitRevision} from '../support/quality_baseline.mjs';

const root = path.resolve(import.meta.dirname, '../..');
assert(process.argv[2], 'Supply an exact Qwen3.8 source directory');
const source = fs.realpathSync(process.argv[2]);
const run = artifactRunDir('qwen38-prepare-patch');
const target = path.join(run, 'archive copy with spaces');
const script = path.join(root, 'scripts/apply-ds4-qwen38-prepare.sh');
const files = ['ds4.c', 'ds4.h'];
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
const report = {started: new Date().toISOString(), scope: 'Patch lifecycle; no weights or inference',
  source, revision: ownGitRevision(source), commands: [], rows: [], passed: false};
const save = () => writeArtifact(run, 'results.json', report);
function patch(action) {
  const r = spawnSync('sh', [script, action], {cwd: '/', encoding: 'utf8', timeout: 20000,
    env: {...process.env, DS4_DIR: target}, maxBuffer: 1024 * 1024});
  report.commands.push({action, status: r.status, signal: r.signal, error: r.error?.message,
    stdout: r.stdout, stderr: r.stderr}); save(); return r.status;
}
const read = () => files.map(f => fs.readFileSync(path.join(target, f)));
const put = data => files.forEach((f, i) => fs.writeFileSync(path.join(target, f), data[i]));
const same = data => assert.deepEqual(read(), data);
const passed = name => {report.rows.push({name, status: 'PASS'}); save(); console.log('PASS: ' + name);};
try {
  fs.mkdirSync(target);
  files.forEach(f => fs.copyFileSync(path.join(source, f), path.join(target, f)));
  assert.equal(patch('restore'), 0, 'Private source must be a supported pristine or fully patched base');
  const original = read();
  report.sourceSHA256 = Object.fromEntries(files.map((f, i) => [f, hash(original[i])]));
  report.patchSHA256 = Object.fromEntries(['prepare-empty.patch', 'prepare-current.patch'].map(file =>
    [file, hash(fs.readFileSync(path.join(root, 'patch/ds4-qwen38-prepare', file)))]));
  report.harnessSHA256 = hash(fs.readFileSync(import.meta.filename));
  const unrelated = original.map(b => Buffer.concat([b, Buffer.from('\n/* preserved contributor fixture */\n')]));
  put(unrelated);
  assert.equal(patch('check'), 0); same(unrelated);
  assert.equal(patch('apply'), 0); const adapted = read();
  adapted.forEach((b, i) => assert.notDeepEqual(b, unrelated[i]));
  assert.equal(patch('apply'), 0); same(adapted);
  assert.equal(patch('check'), 0); same(adapted);
  assert.equal(patch('restore'), 0); same(unrelated);
  assert.equal(patch('restore'), 0); same(unrelated);
  passed('apply/repeat/check/restore preserve unrelated edits in both files');
  for (let i = 0; i < files.length; i++) {
    const partial = unrelated.map((b, j) => j === i ? adapted[j] : b);
    put(partial);
    for (const action of ['check', 'apply', 'restore']) {
      assert.notEqual(patch(action), 0); same(partial);
    }
    passed('partial ' + files[i] + ' rejects all operations without writing either file');
  }
  for (let i = 0; i < files.length; i++) {
    const data = [...unrelated];
    const needle = i === 0 ? '    const double t0 = timing ? now_sec() : 0.0;' :
      'int ds4_session_sync(ds4_session *s, const ds4_tokens *prompt, char *err, size_t errlen);';
    const changed = data[i].toString().replace(needle, needle + ' /* incompatible edit */');
    assert.notEqual(changed, data[i].toString(), 'Drift fixture must modify the selected hunk');
    data[i] = Buffer.from(changed); put(data);
    assert.notEqual(patch('apply'), 0); same(data);
    passed(files[i] + ' drift rejects the complete transaction');
    put(unrelated);
    const outside = path.join(run, 'outside-' + files[i]);
    fs.writeFileSync(outside, unrelated[i], {flag: 'wx'});
    fs.unlinkSync(path.join(target, files[i]));
    fs.symlinkSync(outside, path.join(target, files[i]));
    assert.notEqual(patch('apply'), 0);
    same(unrelated); assert.deepEqual(fs.readFileSync(outside), unrelated[i]);
    fs.unlinkSync(path.join(target, files[i])); put(unrelated);
    passed(files[i] + ' symlink rejected without modifying the target');
  }
  fs.writeFileSync(path.join(target, 'ds4.h'), '/* unrelated engine ABI fixture */\n');
  const unsupported = read();
  assert.notEqual(patch('apply'), 0); same(unsupported);
  passed('wrong engine ABI is not silently accepted');
  report.passed = true;
} catch (error) {
  report.error = String(error.stack || error); console.error(report.error); process.exitCode = 1;
} finally {report.finished = new Date().toISOString(); save(); console.log(run);}

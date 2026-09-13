// Exercise the actual live runner's read-only admission boundary. No model is
// started: a preflight receipt is never accepted as an inference PASS.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {artifactRunDir, writeArtifact} from '../support/real_harness.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const run = artifactRunDir('q36-http-review');
const report = {scope: 'Actual CLI source/binary preflight; deliberate receipt faults, no models or inference',
  started: new Date().toISOString(), passed: false, cases: []};
const save = () => writeArtifact(run, 'results.json', report);
const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const originals = new Map();
const capture = file => {originals.set(file, digest(file));};
try {
  assert.equal(process.argv.length, 6, 'Supply reviewed built source, native receipt, model and projector');
  const [engine, nativeFile, model, projector] = process.argv.slice(2).map(f => fs.realpathSync(f));
  const native = JSON.parse(fs.readFileSync(nativeFile));
  assert(native.passed && native.finished && native.builtSourceFiles, 'A new terminal native build receipt is required');
  report.nativeReceipt = {file: nativeFile, sha256: digest(nativeFile)};
  const harness = path.join(root, 'tests/live/q36_http_vision_live_test.mjs');
  for (const file of [harness, import.meta.filename, nativeFile, path.join(engine, 'q36-server')]) capture(file);
  for (const name of Object.keys(native.builtSourceFiles)) {
    assert(!path.isAbsolute(name) && !name.split('/').some(p => !p || p === '.' || p === '..'));
    capture(path.join(engine, name));
  }
  const weightIdentity = [model, projector].map(file => {
    const s = fs.statSync(file, {bigint: true});
    return {file, identity: [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].map(String)};
  });
  function check(name, mutation, expected, {useReceipt = true, args = []} = {}) {
    const candidate = structuredClone(native); if (mutation) mutation(candidate);
    const file = path.join(run, name + '.receipt.json');
    writeArtifact(run, path.basename(file), candidate);
    const argv = [harness, engine, model, projector, '--next', '--preflight-only',
      ...(useReceipt ? ['--native-receipt', file] : []), ...args];
    const result = spawnSync(process.execPath, argv, {cwd: root, encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024});
    writeArtifact(run, name + '.command.json', {argv, code: result.status, error: String(result.error || ''),
      stdout: result.stdout, stderr: result.stderr});
    const terminal = (result.stdout || '').split('\n').findLast(l => l.startsWith('{"run":'));
    assert(terminal, 'Missing terminal preflight receipt');
    const summary = JSON.parse(terminal);
    const evidence = JSON.parse(fs.readFileSync(path.join(summary.run, 'results.json')));
    assert(!result.error);
    assert.equal(result.status, expected ? 0 : 1);
    assert.equal(summary.status, expected ? 'preflight-pass' : 'fail');
    assert.equal(evidence.pid, undefined, 'Preflight started a model process');
    assert.equal(evidence.nativeExit, undefined, 'Preflight ran native inference');
    assert.equal(evidence.weights.length, 0, 'Preflight claimed weight verification');
    assert.equal(evidence.cases.length, 0, 'Preflight claimed inference cases');
    assert.equal(summary.total, 0);
    for (const [input, hash] of originals) assert.equal(digest(input), hash, 'Preflight mutated an input: ' + input);
    report.cases.push({name, passed: true, admissionExpected: expected, receipt: summary.run}); save();
    console.log('PASS: ' + name);
  }
  check('matching-built-sources-and-binary', null, true);
  check('unfinished-native-build', j => {delete j.finished;}, false);
  check('failed-native-build', j => {j.passed = false;}, false);
  check('failed-native-stage', j => {j.stages[0].passed = false;}, false);
  check('unreviewed-revision', j => {j.sourceRevision.head = '0'.repeat(40);}, false);
  check('stale-binary', j => {j.serverSHA256 = '0'.repeat(64);}, false);
  check('stale-build-harness', j => {j.harnessSHA256 = '0'.repeat(64);}, false);
  check('missing-built-source-inventory', j => {delete j.builtSourceFiles;}, false);
  check('original-checkout-is-not-compiler-input', j => {j.builtSourceFiles = j.sourceFiles;}, false);
  check('shader-identity-mismatch', j => {j.builtSourceFiles['metal/recurrent.metal'] = '0'.repeat(64);}, false);
  check('invalid-source-path', j => {
    const first = Object.keys(j.builtSourceFiles)[0], hash = j.builtSourceFiles[first];
    delete j.builtSourceFiles[first]; j.builtSourceFiles['../outside.c'] = hash;
  }, false);
  check('archive-does-not-inherit-parent-git', null, false, {useReceipt: false});
  check('duplicate-native-receipt-option', null, false, {args: ['--native-receipt', nativeFile]});
  for (const {file, identity} of weightIdentity) {
    const s = fs.statSync(file, {bigint: true});
    assert.deepEqual([s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].map(String), identity);
  }
  report.inputs = [...originals].map(([file, sha256]) => ({file, sha256}));
  report.inputsUnchanged = true; report.passed = true;
} catch (error) {report.error = String(error.stack || error); console.error(report.error); process.exitCode = 1;}
finally {report.finished = new Date().toISOString(); save(); console.log(run);}

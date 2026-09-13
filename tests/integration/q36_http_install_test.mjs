// Real installed bytes and production live-runner admission; deliberate receipt
// faults. No model, server, socket, download or inference is started by this gate.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {artifactRunDir, writeArtifact} from '../support/real_harness.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const run = artifactRunDir('q36-http-install');
const report = {started: new Date().toISOString(), passed: false,
  scope: 'Actual managed-install CLI admission with deliberate faults; no model or inference qualification', cases: []};
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const save = () => writeArtifact(run, 'results.json', report);
try {
  assert.equal(process.argv.length, 5, 'Supply actual managed q36 installation, model and projector');
  const [engine, model, projector] = process.argv.slice(2).map(f => fs.realpathSync(f));
  const receiptFile = path.join(engine, '.dstudio-source.json');
  const installed = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
  assert.equal(installed.commit, '8362010a301b3360296e435703f58ffc230a024a');
  const harness = path.join(root, 'tests/live/q36_http_vision_live_test.mjs');
  const inputs = [receiptFile, path.join(engine, 'q36-server'), import.meta.filename, harness,
    path.join(root, 'scripts/install-q36.py'), ...Object.keys(installed.patches).map(f => path.join(root, f))];
  for (const [name, expected] of Object.entries(installed.sources)) {
    assert(!path.isAbsolute(name) && !name.split('/').some(p => !p || p === '.' || p === '..'));
    const file = path.join(engine, name); assert.equal(hash(file), expected); inputs.push(file);
  }
  report.inputs = Object.fromEntries(inputs.map(f => [f, hash(f)]));
  const weightIdentity = [model, projector].map(f => {
    const s = fs.statSync(f, {bigint: true});
    return {file: f, identity: [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].map(String)};
  });
  function check(name, mutate, expectedError) {
    const target = path.join(run, name); fs.mkdirSync(target);
    for (const source of ['q36-server', ...Object.keys(installed.sources)]) {
      const file = path.join(target, source); fs.mkdirSync(path.dirname(file), {recursive: true});
      fs.copyFileSync(path.join(engine, source), file, fs.constants.COPYFILE_EXCL);
    }
    const receipt = structuredClone(installed);
    const inspectAfter = mutate?.(receipt, target);
    writeArtifact(target, '.dstudio-source.json', receipt);
    const argv = [harness, target, model, projector, '--preflight-only', '--disk-cache'];
    const result = spawnSync(process.execPath, argv, {cwd: root, encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024});
    writeArtifact(run, name + '.command.json', {argv, code: result.status, stdout: result.stdout,
      stderr: result.stderr, error: String(result.error || '')});
    assert(!result.error, result.error?.message);
    const terminal = result.stdout.split('\n').findLast(line => line.startsWith('{"run":'));
    assert(terminal, 'Missing terminal preflight receipt');
    const summary = JSON.parse(terminal), evidence = JSON.parse(fs.readFileSync(path.join(summary.run, 'results.json')));
    assert.equal(result.status, expectedError ? 1 : 0, evidence.error);
    assert.equal(summary.status, expectedError ? 'fail' : 'preflight-pass');
    if (expectedError) assert.match(evidence.error, expectedError);
    else {
      assert.equal(evidence.nextReview, false, 'A managed install must not masquerade as a review checkout');
      assert.equal(evidence.nativeApiGeneration, 'preserved-prelude-and-authenticated-vision');
      assert.equal(evidence.plannedChecks, 46, 'Current native API must retain all image/tool/cache cases');
    }
    assert.equal(evidence.pid, undefined); assert.equal(evidence.nativeExit, undefined);
    assert.equal(evidence.weights.length, 0); assert.equal(evidence.cases.length, 0);
    assert.equal(summary.total, 0, 'Preflight cannot report inference cases as passing');
    if (typeof inspectAfter === 'function') inspectAfter(evidence);
    report.cases.push({name, passed: true, admissionExpected: !expectedError, receipt: summary.run}); save();
    console.log('PASS: ' + name);
  }
  check('matching-managed-install', null);
  check('user-code-project', (j, dir) => {
    const project = path.join(dir, 'user-project'); fs.mkdirSync(project);
    const source = path.join(project, 'main.c'), makefile = path.join(project, 'Makefile');
    fs.writeFileSync(source, 'int main(void) { return 19; }\n', {flag: 'wx'});
    fs.writeFileSync(makefile, 'all:\n\t@false\n', {flag: 'wx'});
    const before = [hash(source), hash(makefile)];
    return evidence => {
      assert.deepEqual([hash(source), hash(makefile)], before);
      assert.equal(evidence.inputs[source], undefined, 'User code must not become an engine input');
      assert.equal(evidence.inputs[makefile], undefined);
    };
  });
  check('linked-user-project', (j, dir) => {
    fs.mkdirSync(path.join(dir, 'user-project'));
    fs.writeFileSync(path.join(dir, 'user-project/main.c'), '/* unrelated project */', {flag: 'wx'});
    const link = path.join(dir, 'linked-project'); fs.symlinkSync('user-project', link);
    return () => assert.equal(fs.readlinkSync(link), 'user-project');
  });
  check('unreviewed-revision', j => {j.commit = '0'.repeat(40);}, /Unreviewed installed revision/);
  check('wrong-backend', j => {j.backend = 'vulkan';}, /vulkan/);
  check('stale-server-binary', j => {j.binaries['q36-server'] = '0'.repeat(64);}, /Installed server binary changed/);
  check('nonregular-server', (j, dir) => {
    fs.renameSync(path.join(dir, 'q36-server'), path.join(dir, 'q36-server.saved'));
    const made = spawnSync('/usr/bin/mkfifo', [path.join(dir, 'q36-server')], {encoding: 'utf8', timeout: 5000});
    assert.equal(made.status, 0, made.stderr);
  }, /Server binary must be bounded regular data/);
  check('missing-source', j => {delete j.sources['q36.c'];}, /Installed source inventory or content changed/);
  check('changed-shader', (j, dir) => {fs.appendFileSync(path.join(dir, 'metal/recurrent.metal'), '\n// fault\n');},
    /Installed source inventory or content changed/);
  check('extra-source', (j, dir) => {fs.writeFileSync(path.join(dir, 'extra.c'), '/* fault */', {flag: 'wx'});},
    /Installed source inventory or content changed/);
  check('outside-source-identity', j => {j.sources['../outside.c'] = '0'.repeat(64);},
    /Installed source inventory or content changed/);
  check('linked-source', (j, dir) => {
    fs.renameSync(path.join(dir, 'q36.c'), path.join(dir, 'q36.saved'));
    fs.symlinkSync('q36.saved', path.join(dir, 'q36.c'));
  }, /Nonregular source in engine preparation/);
  check('stale-patch', j => {j.patches['patch/q36-agent-tty/monitor.patch'] = '0'.repeat(64);}, /Installed patch input drift/);
  check('missing-patch', j => {delete j.patches['patch/q36-agent-tty/monitor.patch'];}, /Incomplete installed patch inventory/);
  check('wrong-patch-order', j => {j.patchOrder.reverse();}, /Installed patch order differs/);
  check('stale-installer', j => {j.installerSHA256 = '0'.repeat(64);}, /Installer identity changed/);
  for (const [file, expected] of Object.entries(report.inputs)) assert.equal(hash(file), expected, 'Original input changed: ' + file);
  for (const {file, identity} of weightIdentity) {
    const s = fs.statSync(file, {bigint: true});
    assert.deepEqual([s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].map(String), identity);
  }
  report.inputsUnchanged = true; report.passed = true;
} catch (error) {report.error = String(error.stack || error); console.error(report.error); process.exitCode = 1;}
finally {report.finished = new Date().toISOString(); save(); console.log(run);}

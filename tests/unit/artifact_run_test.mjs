import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { artifactDir, artifactRunDir, artifactRunOrResume, writeArtifact } from '../support/real_harness.mjs';

const name = 'artifact-run-test-' + crypto.randomUUID();
const parent = artifactDir(name);
try {
  const failed = artifactRunDir(name);
  writeArtifact(failed, 'result.json', { status: 'FAIL', answers: ['original wrong answer'] });
  const original = fs.readFileSync(path.join(failed, 'result.json'));
  const retry = artifactRunDir(name);
  assert.notEqual(failed, retry);
  writeArtifact(retry, 'result.json', { status: 'PASS', answers: ['retry'] });
  assert.deepEqual(fs.readFileSync(path.join(failed, 'result.json')), original);
  assert.equal(fs.readdirSync(parent).length, 2);

  // A declared continuation reuses the most recent run; a fresh run never does.
  fs.utimesSync(failed, new Date(Date.now() - 60000), new Date(Date.now() - 60000));
  assert.equal(artifactRunOrResume(name, true), retry, 'a resume continues the most recent run');
  const fresh = artifactRunOrResume(name, false);
  assert.ok(fresh !== retry && fresh !== failed && fs.existsSync(fresh));
  assert.deepEqual(fs.readFileSync(path.join(failed, 'result.json')), original, 'nothing is erased by a new or resumed run');
  assert.equal(fs.readdirSync(parent).length, 3);
  // Receipts written before run directories existed stay where they are and can still be continued.
  const legacy = 'artifact-run-legacy-' + crypto.randomUUID(), legacyParent = artifactDir(legacy);
  try {
    writeArtifact(legacyParent, 'report.json', { legacy: true });
    assert.equal(artifactRunOrResume(legacy, true), legacyParent);
    const next = artifactRunOrResume(legacy, false);
    assert.notEqual(next, legacyParent);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(legacyParent, 'report.json'))), { legacy: true });
  } finally { fs.rmSync(legacyParent, { recursive: true, force: true }); }
  console.log('artifact_run_test: PASS (new retries and resumed runs preserve original failed bytes)');
} finally { fs.rmSync(parent, { recursive: true, force: true }); }

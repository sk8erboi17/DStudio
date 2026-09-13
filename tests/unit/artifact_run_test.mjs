import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { artifactDir, artifactRunDir, writeArtifact } from '../support/real_harness.mjs';

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
  console.log('artifact_run_test: PASS (new retries preserve original failed bytes)');
} finally { fs.rmSync(parent, { recursive: true, force: true }); }

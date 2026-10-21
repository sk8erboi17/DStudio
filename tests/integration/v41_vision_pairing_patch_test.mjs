// Lifecycle of the V4.1 vision-pairing patch on a scratch copy of the vendored
// ds4.c: apply, repeat, restore, drift (no change) and the upstream-merged no-op.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const script = path.join(root, 'scripts/apply-ds4-v41-vision-pairing.sh');
const vendored = path.join(root, 'src/engines/ds4/ds4.c');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v41-pairing-'));
const file = path.join(dir, 'ds4.c');
const run = action => spawnSync('/bin/sh', [script, action], { encoding: 'utf8', timeout: 30000, env: { ...process.env, DS4_DIR: dir } });
const read = () => fs.readFileSync(file);
try {
  fs.copyFileSync(vendored, file);
  const original = sha(read());
  let r = run('check'); assert.equal(r.status, 0); assert.match(r.stdout, /applicable/);
  assert.equal(sha(read()), original, 'check must not write');
  r = run('apply'); assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /applied/);
  const patched = read(); assert.notEqual(sha(patched), original);
  assert.ok(patched.includes('ds4_str_eq(language, vision)'));
  assert.ok(!patched.includes('df42c109f1defefcbfcedbe7d905718a12266e40'));
  r = run('apply'); assert.equal(r.status, 0); assert.match(r.stdout, /already applied/);
  assert.equal(sha(read()), sha(patched), 'second apply must be a no-op');
  r = run('restore'); assert.equal(r.status, 0); assert.match(r.stdout, /restored/);
  assert.equal(sha(read()), original, 'restore must be byte exact');
  r = run('restore'); assert.equal(r.status, 0); assert.match(r.stdout, /already restored/);
  // Drift: neither direction applies and the hard-coded revision is still there.
  fs.writeFileSync(file, read().toString('latin1').replace('!ds4_streq(arch, "deepseek4-vision")',
    '!ds4_streq(arch,  "deepseek4-vision")'), 'latin1');
  const drifted = sha(read());
  r = run('apply'); assert.equal(r.status, 1); assert.match(r.stderr, /source drift/);
  assert.equal(sha(read()), drifted, 'drift must change no file');
  // Upstream merged: the hard-coded revision is gone and our marker never existed.
  fs.writeFileSync(file, fs.readFileSync(vendored).toString('latin1')
    .replaceAll('df42c109f1defefcbfcedbe7d905718a12266e40', 'ffffffffffffffffffffffffffffffffffffffff'), 'latin1');
  const merged = sha(read());
  r = run('apply'); assert.equal(r.status, 0); assert.match(r.stdout, /not needed/);
  assert.equal(sha(read()), merged);
  assert.equal(run('bogus').status, 2);
  console.log('PASS: V4.1 vision pairing patch lifecycle');
} finally { fs.rmSync(dir, { recursive: true, force: true }); }

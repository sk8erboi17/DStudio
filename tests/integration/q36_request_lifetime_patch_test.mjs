// Exact upstream archives, production patch lifecycle and native HTTP handlers.
// No weights, inference, GUI restart or mutation of installed source trees.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { artifactRunDir, writeArtifact } from '../support/real_harness.mjs';
const root = path.resolve(import.meta.dirname, '../..');
const run = artifactRunDir('q36-request-lifetime-patch');
const report = { scope: 'Exact pinned patch lifecycle and native HTTP; no inference or GPU qualification',
  passed: false, variants: [], commands: [] };
const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const pins = [
  ['pinned', 'runtime.patch', 'd67687ed15ad9f52b755a9b5fdfc0214ea937555'],
  ['next-review', 'next-review.patch', '8362010a301b3360296e435703f58ffc230a024a'],
  ['current', 'runtime-1305843.patch', '1305843c735380f912619548b121cba8601f2f85'],
];
const script = path.join(root, 'scripts/apply-q36-metal-runtime.sh');
function command(binary, args, cwd, env, expected = 0) {
  const result = spawnSync(binary, args, { cwd, env, encoding: 'utf8', timeout: 120000, maxBuffer: 4 * 1024 * 1024 });
  report.commands.push({ binary, args, cwd, status: result.status, signal: result.signal,
    stdout: result.stdout, stderr: result.stderr, error: String(result.error || '') });
  writeArtifact(run, 'results.json', report);
  if (expected === 0) assert.equal(result.status, 0, result.stderr || String(result.error));
  else assert.notEqual(result.status, 0, 'Drift/partial source must be rejected');
  return result;
}
try {
  for (const [variant, patch, revision] of pins) {
    const directory = path.join(run, variant), tree = path.join(directory, 'source with spaces');
    fs.mkdirSync(directory); const archive = path.join(directory, 'source.tar.gz');
    command('curl', ['--fail', '--location', '--silent', '--show-error', '--connect-timeout', '20',
      '--max-time', '90', '--max-filesize', String(64 * 1024 * 1024), '--output', archive,
      `https://codeload.github.com/Ninnix/q36/tar.gz/${revision}`], root, process.env);
    command('python3', ['-B', '-c',
      'import importlib.util,pathlib,sys; s=importlib.util.spec_from_file_location("installer",sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); m.extract_sources(pathlib.Path(sys.argv[2]),pathlib.Path(sys.argv[3]),sys.argv[4])',
      path.join(root, 'scripts/install-q36.py'), archive, tree, revision], root, process.env);
    const row = { variant, revision, archiveSHA256: digest(archive), patchSHA256: digest(path.join(root, 'patch/q36-metal-runtime', patch)),
      scriptSHA256: digest(script), stages: [] }; report.variants.push(row);
    const env = { ...process.env, Q36_DIR: tree };
    const apply = (action, expected = 0) => command('/bin/sh', [script, action, variant], root, env, expected);
    const server = path.join(tree, 'q36_server.c');
    const original = fs.readFileSync(server);
    apply('restore'); assert.deepEqual(fs.readFileSync(server), original);
    const unrelated = Buffer.from('\n/* Unrelated contributor sentinel, preserved by patch lifecycle. */\n');
    fs.appendFileSync(server, unrelated);
    const withSentinel = fs.readFileSync(server);
    apply('check'); apply('apply'); const adapted = fs.readFileSync(server);
    apply('apply'); assert.deepEqual(fs.readFileSync(server), adapted);
    row.stages.push('apply/repeat/check preserve unrelated source');
    const nativeArgs = [path.join(root, 'tests/integration/q36_http_control_test.mjs'), tree];
    const native = command(process.execPath, nativeArgs, root, process.env);
    fs.writeFileSync(path.join(directory, 'native-http.log'), native.stdout + native.stderr);
    row.stages.push('native HTTP admission, four-hour inference, Stop and metadata');
    apply('restore'); assert.deepEqual(fs.readFileSync(server), withSentinel);
    row.stages.push('restore preserves unrelated source');
    // A mixed source tree may never acquire an adaptation by guessing intent.
    apply('apply'); fs.writeFileSync(server, withSentinel);
    const other = path.join(tree, 'q36.c'), otherAdapted = fs.readFileSync(other);
    apply('apply', 1); assert.deepEqual(fs.readFileSync(server), withSentinel);
    assert.deepEqual(fs.readFileSync(other), otherAdapted);
    fs.writeFileSync(server, adapted); apply('restore');
    row.stages.push('partial adaptation rejects without collateral writes');
    fs.writeFileSync(server, Buffer.from('/* Deliberate unsupported source drift. */\n'));
    apply('apply', 1); assert.equal(fs.readFileSync(server, 'utf8'), '/* Deliberate unsupported source drift. */\n');
    fs.writeFileSync(server, withSentinel);
    row.stages.push('source drift rejects without collateral writes');
    row.passed = true; console.log(`PASS ${variant} ${revision}: lifecycle and native slow-request controls`);
    writeArtifact(run, 'results.json', report);
  }
  report.passed = true;
} catch (error) { report.error = String(error.stack || error); process.exitCode = 1; console.error(report.error); }
finally { report.finished = new Date().toISOString(); writeArtifact(run, 'results.json', report); console.log(`Evidence: ${run}`); }

// Native serializers plus the actual installer hook on isolated sources.
// Assertions check messages and file preservation, never source markers.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { artifactRunDir } from '../support/real_harness.mjs';
import { ownGitRevision } from '../support/quality_baseline.mjs';

const root = process.cwd();
const main = path.resolve(process.argv[2] || 'ds4');
const laguna = path.resolve(process.argv[3] || 'ds4-laguna-s21');
const previous = 'f4d03f6cf9f11c1e7b630bcb160853acfba7c52a';
const run = artifactRunDir('server-metrics-patch');
const script = path.join(root, 'scripts/apply-ds4-server-metrics.sh');
const patchFile = path.join(root, 'patch/ds4-server-metrics/usage-metrics.patch');
const patch = fs.readFileSync(patchFile, 'utf8');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const report = { schema: 'dstudio.server-metrics-patch.v1', started: new Date().toISOString(),
  scope: 'Native JSON/SSE serialization and patch lifecycle; controlled counters, no inference or measured speed',
  host: { platform: process.platform, arch: process.arch, release: os.release() },
  patchSha256: sha(patch), scriptSha256: sha(fs.readFileSync(script)), sources: [], status: 'FAIL' };
const command = (exe, args, options = {}) => spawnSync(exe, args, {
  encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1024 * 1024, ...options,
});
const checked = result => { assert.equal(result.status, 0, result.error?.stack || result.stdout + result.stderr); return result.stdout; };
console.log(`Evidence: ${run}`);

function exercise(label, source, revision) {
  const directory = path.join(run, label); fs.mkdirSync(directory);
  const row = { label, input: source, revision: revision || null, git: ownGitRevision(source),
    checks: [], commands: [], status: 'FAIL' };
  report.sources.push(row);
  const file = path.join(directory, 'ds4_server.c');
  let sourceHashes;
  if (revision) {
    // Read exact old source/header bytes from the existing local Git object;
    // never checkout/reset or mutate the user's engine tree.
    assert.equal(fs.realpathSync(checked(command('git', ['-C', source, 'rev-parse', '--show-toplevel'])).trim()), fs.realpathSync(source));
    const files = checked(command('git', ['-C', source, 'ls-tree', '--name-only', revision])).trim().split('\n')
      .filter(name => name === 'ds4_server.c' || name.endsWith('.h'));
    sourceHashes = {};
    for (const name of files) {
      const bytes = checked(command('git', ['-C', source, 'show', `${revision}:${name}`]));
      fs.writeFileSync(path.join(directory, name), bytes, { flag: 'wx' }); sourceHashes[name] = sha(bytes);
    }
  } else {
    sourceHashes = {};
    for (const name of fs.readdirSync(source).filter(name => name === 'ds4_server.c' || name.endsWith('.h'))) {
      const from = path.join(source, name);
      assert.ok(fs.lstatSync(from).isFile(), `source must be regular: ${from}`);
      fs.copyFileSync(from, path.join(directory, name)); sourceHashes[name] = sha(fs.readFileSync(from));
    }
  }
  row.inputHashes = sourceHashes;
  const read = () => fs.readFileSync(file);
  const env = { ...process.env, DS4_DIR: directory };
  const apply = action => command('/bin/sh', [script, action], { env });
  const pass = action => checked(apply(action));
  pass('restore');
  const original = read(); row.originalSha256 = sha(original);
  pass('restore'); pass('check'); assert.deepEqual(read(), original);

  function probe(stage, patched) {
    const binary = path.join(directory, `probe-${stage}`);
    const flags = process.platform === 'darwin' ? ['-Wl,-dead_strip'] : ['-D_GNU_SOURCE', '-Wl,--gc-sections'];
    const args = ['-std=c99', '-O1', '-ffunction-sections', '-fdata-sections', '-Wno-unused-function',
      ...(patched ? ['-DMETRICS_PATCHED'] : []), '-I', directory, '-I', source,
      path.join(root, 'tests/support/server_metrics_probe.c'), '-o', binary, '-lm', '-pthread', ...flags];
    row.commands.push([process.env.CC || 'cc', ...args]);
    const build = command(process.env.CC || 'cc', args);
    fs.writeFileSync(path.join(directory, `${stage}-build.log`), build.stdout + build.stderr, { flag: 'wx' });
    checked(build);
    row[`${stage}BinarySha256`] = sha(fs.readFileSync(binary));
    const outputs = [];
    for (const scenario of [0, 1, 2, 3, 4, 5]) {
      const expected = { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12,
        prompt_tokens_details: { cached_tokens: scenario === 5 ? 0 : scenario === 3 ? 10 : 7,
          cache_write_tokens: scenario === 5 || scenario === 3 ? 0 : 3 } };
      if (patched && ![1, 2, 5].includes(scenario)) expected.ds4 = { decode_tokens_per_second: 2.5, decode_elapsed_seconds: 0.8 };
      const json = checked(command(binary, [String(scenario), 'json']));
      fs.writeFileSync(path.join(directory, `${stage}-${scenario}.json`), json, { flag: 'wx' });
      assert.deepEqual(JSON.parse(json), expected, 'actual JSON bytes retain native usage/cache semantics');
      outputs.push(JSON.parse(json));
      if (scenario === 5) continue;
      const sse = checked(command(binary, [String(scenario), 'sse']));
      fs.writeFileSync(path.join(directory, `${stage}-${scenario}.sse`), sse, { flag: 'wx' });
      const events = sse.trim().split('\n\n');
      assert.equal(events.at(-1), 'data: [DONE]');
      assert.equal(events.length, scenario === 4 ? 1 : 2);
      if (scenario !== 4) {
        assert.ok(events[0].startsWith('data: '));
        const message = JSON.parse(events[0].slice(6));
        assert.equal(message.object, 'chat.completion.chunk');
        assert.deepEqual(message.choices, []); assert.deepEqual(message.usage, expected);
      }
    }
    return outputs;
  }
  const before = probe('before', false);
  pass('apply'); const modified = read(); assert.notDeepEqual(modified, original);
  pass('apply'); pass('check'); assert.deepEqual(read(), modified);
  const after = probe('after', true);
  assert.deepEqual(after.map(({ ds4, ...native }) => native), before, 'native fields stay identical');
  row.checks.push({ name: 'native JSON and SSE, optional metrics, cache bounds and opt-out', status: 'PASS', executions: 22 });

  pass('restore'); pass('restore'); assert.deepEqual(read(), original);
  const note = Buffer.from('/* unrelated contributor change */\n');
  fs.writeFileSync(file, Buffer.concat([note, original]));
  pass('apply'); assert.deepEqual(read(), Buffer.concat([note, modified]));
  pass('restore'); assert.deepEqual(read(), Buffer.concat([note, original]));
  row.checks.push({ name: 'fresh/repeat/check/restore preserve unrelated source edits', status: 'PASS' });

  // Construct partial/drift fixtures from patch hunks, not test source-text
  // presence as an alleged behavioral invariant.
  const removed = patch.split('\n').find(line => line.startsWith('+    double '))?.slice(1);
  const context = patch.split('\n').find(line => line.startsWith('     int cache_read_tokens;'))?.slice(1);
  assert.ok(removed && context, 'fault fixture construction');
  const reject = (bytes, name) => {
    fs.writeFileSync(file, bytes);
    for (const action of ['apply', 'check', 'restore']) {
      assert.notEqual(apply(action).status, 0, `${name} must reject ${action}`);
      assert.deepEqual(read(), bytes, `${name} must not partially mutate any source`);
    }
  };
  reject(Buffer.from(modified.toString().replace(removed + '\n', '')), 'partially applied');
  reject(Buffer.from(original.toString().replace(context, '    int incompatible_cache_layout;')), 'partial upstream drift');
  reject(Buffer.from('/* unrelated wrong checkout */\n'), 'wrong checkout');
  fs.writeFileSync(file, original);
  assert.notEqual(apply('invalid').status, 0); assert.deepEqual(read(), original);
  fs.renameSync(file, path.join(directory, 'source-owned.c'));
  fs.symlinkSync('source-owned.c', file);
  assert.notEqual(apply('apply').status, 0); assert.deepEqual(read(), original);
  row.checks.push({ name: 'partial/drift/wrong source/action/symlink rejected without mutation', status: 'PASS' });
  if (!revision) for (const [name, digest] of Object.entries(sourceHashes))
    assert.equal(sha(fs.readFileSync(path.join(source, name))), digest, 'input checkout must stay untouched');
  row.status = 'PASS';
}

try {
  report.compiler = checked(command(process.env.CC || 'cc', ['--version']));
  for (const args of [['current-main', main], ['previous-main', main, previous], ['laguna', laguna]]) {
    try { exercise(...args); }
    catch (error) { report.sources.at(-1).error = error.stack; process.exitCode = 1; }
  }
  if (report.sources.every(row => row.status === 'PASS')) report.status = 'PASS';
} finally {
  report.finished = new Date().toISOString();
  fs.writeFileSync(path.join(run, 'results.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ ...report, sources: report.sources.map(({ inputHashes, ...row }) => row) }, null, 2));
}

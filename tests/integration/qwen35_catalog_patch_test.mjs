// Real patch lifecycle and compiled native HTTP serialization. Model metadata
// is a controlled fixture; this deliberately makes no inference-quality claim.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { artifactRunDir } from '../support/real_harness.mjs';

const root = process.cwd(), source = path.resolve(process.argv[2] || 'ds4-qwen35');
const run = artifactRunDir('qwen35-catalog');
const checkout = path.join(run, 'archive inside parent git');
fs.mkdirSync(checkout);
console.log(`Evidence: ${run}`);
const report = { schema: 'dstudio.qwen35-catalog.v1', scope: 'Native HTTP serializer with fixture metadata; NOT model inference', checks: [] };
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const command = (exe, args, options = {}) => spawnSync(exe, args, {
  encoding: 'utf8', timeout: 120000, maxBuffer: 4 * 1024 * 1024, ...options,
});
const script = path.join(root, 'scripts/apply-ds4-qwen35-catalog.sh');
const patch = path.join(root, 'patch/ds4-qwen35-catalog/native-model-id.patch');
const apply = action => command('sh', [script, action], { env: { ...process.env, DS4_DIR: checkout } });
const pass = action => { const r = apply(action); assert.equal(r.status, 0, r.stdout + r.stderr); return r; };
const file = path.join(checkout, 'ds4_server.c');
const read = () => fs.readFileSync(file);
function probe(label) {
  const exe = path.join(run, `catalog-${label}`);
  const flags = process.platform === 'darwin' ? ['-Wl,-dead_strip'] : ['-Wl,--gc-sections'];
  const args = ['-std=c99', '-O1', '-ffunction-sections', '-fdata-sections', '-Wno-unused-function',
    '-I', checkout, '-I', source, path.join(root, 'tests/support/qwen35_catalog_probe.c'),
    '-o', exe, '-lm', '-pthread', ...flags];
  if (process.platform !== 'darwin') args.unshift('-D_GNU_SOURCE');
  const built = command(process.env.CC || 'cc', args);
  fs.writeFileSync(path.join(run, `${label}-build.log`), built.stdout + built.stderr, { flag: 'wx' });
  assert.equal(built.status, 0, built.stderr);
  const values = [];
  for (const family of [0, 1, 2]) {
    const response = command(exe, [String(family)]);
    assert.equal(response.status, 0, response.stderr);
    fs.writeFileSync(path.join(run, `${label}-${family}.http`), response.stdout, { flag: 'wx' });
    const [headers, body] = response.stdout.split('\r\n\r\n');
    assert.match(headers, /^HTTP\/1\.1 200 /);
    const length = Number(headers.match(/content-length:\s*(\d+)/i)?.[1]);
    assert.equal(Buffer.byteLength(body), length, 'actual HTTP payload length');
    const value = JSON.parse(body);
    assert.equal(value.object, 'list');
    for (const model of value.data) {
      assert.equal(model.context_length, 8192);
      assert.equal(model.top_provider.max_completion_tokens, 256);
    }
    values.push(value);
  }
  return values;
}
try {
  for (const name of ['ds4_server.c', 'ds4.h']) fs.copyFileSync(path.join(source, name), path.join(checkout, name));
  // Accept a managed source copy as input while always testing both directions.
  pass('restore');
  const original = read();
  report.originalSha256 = sha(original); report.patchSha256 = sha(fs.readFileSync(patch));
  const before = probe('before');
  assert.deepEqual(before[2].data.map(x => x.id), ['deepseek-v4-flash', 'deepseek-v4-pro']);
  report.checks.push({ name: 'original Qwen discovery defect reproduced', status: 'pass' });
  pass('check'); assert.deepEqual(read(), original);
  pass('apply'); const modified = read(); assert.notDeepEqual(modified, original);
  pass('apply'); pass('check'); assert.deepEqual(read(), modified);
  const after = probe('after');
  assert.deepEqual(after[0], before[0], 'DeepSeek compatibility preserved');
  assert.deepEqual(after[1], before[1], 'GLM compatibility preserved');
  assert.deepEqual(after[2].data.map(x => x.id), ['qwen3.6-35b-a3b']);
  report.checks.push({ name: 'compiled Qwen catalog and other families', status: 'pass' });
  pass('restore'); pass('restore'); assert.deepEqual(read(), original);
  const unrelated = Buffer.from('// unrelated source change preserved\n');
  fs.writeFileSync(file, Buffer.concat([unrelated, original]));
  pass('apply'); assert.deepEqual(read(), Buffer.concat([unrelated, modified]));
  pass('restore'); assert.deepEqual(read(), Buffer.concat([unrelated, original]));
  report.checks.push({ name: 'repeat apply, restore and unrelated edits', status: 'pass' });
  // Patch context is an actual production delta, not a source-text assertion.
  // Drop one new line to create a partially applied, uncompilable candidate.
  const addition = fs.readFileSync(patch, 'utf8').split('\n').find(x => x.startsWith('+    } else if'))?.slice(1);
  assert.ok(addition, 'fixture construction requires an added patch line');
  fs.writeFileSync(file, modified.toString().replace(addition + '\n', ''));
  const partial = read();
  for (const action of ['check', 'apply', 'restore']) {
    assert.notEqual(apply(action).status, 0); assert.deepEqual(read(), partial);
  }
  fs.writeFileSync(file, 'unrelated upstream source\n'); const drift = read();
  for (const action of ['check', 'apply', 'restore']) {
    assert.notEqual(apply(action).status, 0); assert.deepEqual(read(), drift);
  }
  fs.writeFileSync(file, original);
  fs.writeFileSync(path.join(checkout, 'ds4.h'), '/* not the Qwen ABI */\n');
  assert.notEqual(apply('apply').status, 0); assert.deepEqual(read(), original);
  fs.copyFileSync(path.join(source, 'ds4.h'), path.join(checkout, 'ds4.h'));
  fs.renameSync(file, path.join(checkout, 'owned-source.c'));
  fs.symlinkSync('owned-source.c', file);
  assert.notEqual(apply('apply').status, 0);
  assert.deepEqual(read(), original);
  report.checks.push({ name: 'partial, drift, wrong ABI and symlink rejection', status: 'pass' });
  report.status = 'pass';
} catch (error) { report.status = 'fail'; report.error = error.stack; process.exitCode = 1; }
fs.writeFileSync(path.join(run, 'results.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify(report, null, 2));

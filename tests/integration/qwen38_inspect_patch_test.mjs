// Patch lifecycle; optional real checkpoint metadata with a native macOS
// prefetch observer. No model inference or GPU numerical equivalence claims.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { artifactRunDir } from '../support/real_harness.mjs';

const root = process.cwd(), source = fs.realpathSync(process.argv[2] || 'ds4-qwen38');
const nativeIndex = process.argv.indexOf('--native');
const weights = nativeIndex < 0 ? null : fs.realpathSync(process.argv[nativeIndex + 1]);
const run = artifactRunDir('qwen38-inspect');
const engine = path.join(run, 'source'), script = path.resolve('scripts/apply-ds4-qwen38-inspect.sh');
const report = { schema: 'dstudio.qwen38-inspect.v1', started: new Date().toISOString(),
  scope: weights ? 'Actual native metadata and OS-prefetch interception, no inference; normal startup deliberately stopped at first prefetch' :
    'Patch lifecycle only, no weights or inference', source, weights, commands: [], checks: [] };
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
report.harnessSha256 = sha(new URL(import.meta.url));
report.probeSourceSha256 = sha('tests/support/native_prefetch_probe.c');
const save = () => fs.writeFileSync(path.join(run, 'results.json'), JSON.stringify(report, null, 2) + '\n');
const invoke = (exe, args, env = {}, cwd = root, timeout = 20000) => {
  const began = performance.now();
  const r = spawnSync(exe, args, { cwd, env: { ...process.env, ...env },
    encoding: 'utf8', timeout, killSignal: 'SIGKILL', maxBuffer: 8 * 1024 * 1024 });
  report.commands.push({ exe, args, cwd, env, code: r.status, signal: r.signal,
    error: r.error?.message, stdout: r.stdout, stderr: r.stderr,
    seconds: (performance.now() - began) / 1000 }); save(); return r;
};
const patch = action => invoke('sh', [script, action], { DS4_DIR: engine });
const passed = name => { report.checks.push({ name, status: 'PASS' }); save(); console.log(`PASS: ${name}`); };
try {
  fs.cpSync(source, engine, { recursive: true, dereference: false,
    filter: file => !['.git', 'gguf'].includes(path.basename(file)) });
  // Restore on the private copy also accepts an already-patched installation.
  assert.equal(patch('restore').status, 0);
  const file = path.join(engine, 'ds4.c');
  const original = fs.readFileSync(file);
  report.sourceSha256 = sha(file);
  report.patchSha256 = sha('patch/ds4-qwen38-inspect/metadata-only-ple.patch');
  report.currentPatchSha256 = sha('patch/ds4-qwen38-inspect/metadata-current.patch');
  const unrelated = '\n/* unrelated local comment: must survive patch lifecycle */\n';
  fs.appendFileSync(file, unrelated);
  const pristine = fs.readFileSync(file);
  assert.equal(patch('check').status, 0); assert.deepEqual(fs.readFileSync(file), pristine);
  assert.equal(patch('apply').status, 0);
  const adapted = fs.readFileSync(file);
  assert.notDeepEqual(adapted, pristine);
  assert.equal(patch('apply').status, 0); assert.deepEqual(fs.readFileSync(file), adapted);
  assert.equal(patch('restore').status, 0); assert.deepEqual(fs.readFileSync(file), pristine);
  assert.equal(patch('restore').status, 0); assert.deepEqual(fs.readFileSync(file), pristine);
  passed('apply, repeat, read-only check, restore and unrelated-edit preservation');
  // Corrupt the exact patch location in a private fixture. A failed preflight
  // must not repair arbitrary drift or partially change the input file.
  const targetLine = pristine.toString().includes('        if (prefault_full) {')
    ? '        if (prefault_full) {' : '        model_open(&e->ple_model, opt->ple_path, false, true);';
  const drift = pristine.toString().replace(targetLine, '        /* incompatible fixture at the adapted prefetch decision */');
  assert.notEqual(drift, pristine.toString(), 'fixture must really differ');
  fs.writeFileSync(file, drift);
  assert.notEqual(patch('apply').status, 0); assert.equal(fs.readFileSync(file, 'utf8'), drift);
  fs.writeFileSync(file, pristine);
  const linkTarget = path.join(run, 'must-not-edit.c'); fs.writeFileSync(linkTarget, pristine);
  fs.unlinkSync(file); fs.symlinkSync(linkTarget, file);
  assert.notEqual(patch('apply').status, 0); assert.deepEqual(fs.readFileSync(linkTarget), pristine);
  fs.unlinkSync(file); fs.writeFileSync(file, original);
  passed('source drift and symlink target rejected without writes');
  const header = path.join(engine, 'ds4.h'), headerBefore = fs.readFileSync(header);
  fs.writeFileSync(header, '/* fixture: unsupported engine ABI */\n');
  assert.notEqual(patch('apply').status, 0); assert.deepEqual(fs.readFileSync(file), original);
  fs.writeFileSync(header, headerBefore);
  passed('wrong native engine ABI rejected without changing source');

  if (weights) {
    assert.equal(process.platform, 'darwin', 'native interposition requires macOS');
    const model = path.join(weights, 'Qwen3.8-Flash-Next-Q4KImatrixExperts-MXFP4Down-BF16Emb-BF16Control-Q8GDN-Q8QSA-Q8Shared-Q8Out.gguf');
    const ple = path.join(weights, 'Qwen3.8-Flash-Next-PLE-Q4_1.gguf');
    assert.ok(fs.statSync(model).size > 1024 ** 3);
    const pleBytes = fs.statSync(ple).size; assert.ok(pleBytes > 1024 ** 3);
    report.model = { file: model, bytes: fs.statSync(model).size };
    report.ple = { file: ple, bytes: pleBytes };
    const dylib = path.join(run, 'prefetch-probe.dylib');
    assert.equal(invoke('cc', ['-O2', '-Wall', '-Wextra', '-dynamiclib',
      'tests/support/native_prefetch_probe.c', '-o', dylib]).status, 0);
    const binary = path.join(engine, 'ds4');
    const args = ['--cpu', '--inspect', '-m', model, '--ple', ple];
    // The current upstream normally demand-pages PLE on small Macs. Explicitly
    // exercise its full-prefault path too: --inspect must remain metadata-only
    // regardless of the host size or this normal-inference preference.
    const observation = { DYLD_INSERT_LIBRARIES: dylib, DSTUDIO_TEST_PREFETCH_STOP: '', DS4_QWEN4_PLE_PREFETCH_FULL: '1' };
    assert.equal(invoke('make', ['-j2', 'ds4'], {}, engine, 180000).status, 0);
    report.beforeBinarySha256 = sha(binary);
    const before = invoke(binary, args, observation, engine);
    assert.equal(before.status, 0, before.stderr);
    const hints = [...before.stderr.matchAll(/DSTUDIO_TEST_PREFETCH bytes=(\d+) advice=(\d+)/g)];
    assert.equal(hints.length, 1); assert.equal(Number(hints[0][1]), pleBytes);
    passed('unpatched inspection demonstrably requests the entire PLE prefetch');
    assert.equal(patch('apply').status, 0);
    assert.equal(invoke('make', ['-j2', 'ds4'], {}, engine, 180000).status, 0);
    report.afterBinarySha256 = sha(binary);
    assert.notEqual(report.afterBinarySha256, report.beforeBinarySha256);
    const after = invoke(binary, args, observation, engine);
    assert.equal(after.status, 0, after.stderr);
    assert.ok(!after.stderr.includes('DSTUDIO_TEST_PREFETCH'));
    assert.equal(after.stdout, before.stdout, 'every emitted metadata value must be unchanged');
    const native = invoke(binary, args, { DYLD_INSERT_LIBRARIES: '', DSTUDIO_TEST_PREFETCH_STOP: '', DS4_QWEN4_PLE_PREFETCH_FULL: '1' }, engine);
    assert.equal(native.status, 0, native.stderr);
    assert.equal(native.stdout, before.stdout, 'ordinary CLI, without the observer, returns the same metadata');
    const summary = /^gguf:\s+v(\d+), (\d+) metadata keys, (\d+) tensors$/m.exec(native.stdout);
    assert.ok(summary, 'native CLI must report GGUF metadata and tensors');
    const types = [...native.stdout.matchAll(/^\s+(\S+)\s+(\d+) tensors, ([0-9.]+) GiB$/gm)];
    assert.equal(types.reduce((total, row) => total + Number(row[2]), 0), Number(summary[3]));
    passed('patched inspection has zero prefetch hints and identical real metadata, also without interposition');
    // A prefill is NOT run. The observer deliberately exits at the first normal
    // CPU prefetch, proving the non-inspection startup still requests it.
    const normal = invoke(binary, ['--cpu', '-m', model, '--ple', ple, '-p', 'not generated'],
      { DYLD_INSERT_LIBRARIES: dylib, DSTUDIO_TEST_PREFETCH_STOP: '1' }, engine);
    assert.equal(normal.status, 83);
    assert.ok(normal.stderr.includes(`DSTUDIO_TEST_PREFETCH bytes=${report.model.bytes} `));
    passed('normal CPU startup retains its prefetch; probe stops before inference');
  }
  report.status = 'PASS';
} catch (error) {
  report.status = 'FAIL'; report.error = error.stack; process.exitCode = 1;
  console.error(error);
}
report.finished = new Date().toISOString(); save(); console.log(`Evidence: ${run}`);

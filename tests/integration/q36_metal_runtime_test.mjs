// Isolated patch lifecycle, fresh Metal build and scalar/GPU differential test.
// No LLM weights, upstream Agent execution or installed-app mutation. An
// optional pinned projector is compared with the native scalar encoder.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {artifactRunDir, writeArtifact} from '../support/real_harness.mjs';
import {ownGitRevision} from '../support/quality_baseline.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const run = artifactRunDir('q36-metal-runtime'), tree = path.join(run, 'source with spaces');
const report = {started: new Date().toISOString(), scope: 'Patch/build/Metal operator; no model-quality or Vulkan parity claim',
  passed: false, stages: [], commands: []};
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
async function hashFile(file) {
  const digest = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file, {highWaterMark: 8 * 1024 * 1024})) digest.update(chunk);
  return digest.digest('hex');
}
const related = ['q36.c', 'q36.h', 'q36_metal.m', 'q36_server.c', 'metal/recurrent.metal', 'metal/vision.metal', 'tests/q36_test.c'];
const script = path.join(root, 'scripts/apply-q36-metal-runtime.sh');
const nextReview = process.argv.slice(3).includes('--next');
const extra = process.argv.slice(3).filter(arg => arg !== '--next');
const patchVariant = nextReview ? 'next-review' : 'pinned';
const patchName = nextReview ? 'next-review.patch' : 'runtime.patch';
report.nextReview = nextReview;
const env = {...process.env};
for (const key of Object.keys(env)) if (/^(GIT_|Q36_|DYLD_)|^(MAKEFLAGS|MAKELEVEL|MFLAGS|MAKEOVERRIDES|GNUMAKEFLAGS|CFLAGS|CPPFLAGS|LDFLAGS|CC|CXX)$/.test(key)) delete env[key];
env.Q36_DIR = tree;
const save = () => writeArtifact(run, 'results.json', report);
const passed = name => {report.stages.push({name, passed: true}); save(); console.log(`PASS: ${name}`);};
async function command(binary, args, cwd = tree) {
  const row = {binary, args, cwd}; report.commands.push(row); save();
  const result = await new Promise(resolve => {
    const child = spawn(binary, args, {cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe']});
    let stdout = '', stderr = '', failed = '', escalation;
    const stop = reason => {
      if (failed) return; failed = reason;
      try {if (child.pid) process.kill(-child.pid, 'SIGTERM');} catch {}
      escalation = setTimeout(() => {try {if (child.pid) process.kill(-child.pid, 'SIGKILL');} catch {}}, 1000);
    };
    const timeout = setTimeout(() => stop('120-second command deadline exceeded'), 120000);
    child.stdout.on('data', data => {if (stdout.length < 2 ** 21) stdout += data; else stop('stdout limit exceeded');});
    child.stderr.on('data', data => {if (stderr.length < 2 ** 21) stderr += data; else stop('stderr limit exceeded');});
    child.on('error', error => {failed = String(error);});
    child.on('close', (status, signal) => {
      clearTimeout(timeout); clearTimeout(escalation); resolve({status, signal, error: failed, stdout, stderr});
    });
  });
  Object.assign(row, result); save(); return result;
}
const apply = action => command('/bin/sh', [script, action, patchVariant]);
const read = () => related.map(f => fs.existsSync(path.join(tree, f)) ? fs.readFileSync(path.join(tree, f)) : null);
const put = bytes => related.forEach((f, i) => {
  const target = path.join(tree, f);
  if (bytes[i] !== null) fs.writeFileSync(target, bytes[i]);
  else if (fs.existsSync(target)) fs.unlinkSync(target);
});
async function requireSuccess(binary, args, cwd) {
  const r = await command(binary, args, cwd);
  assert.equal(r.status, 0, `${r.error}\n${r.stderr}\n${r.stdout}`);
  assert.equal(r.error, ''); return r;
}
let source;
try {
  assert.equal(process.platform, 'darwin', 'Metal hardware unavailable: NOT RUN');
  assert(process.argv[2], 'Supply the pinned q36 source directory');
  assert(extra.length <= 1 && process.argv.slice(3).filter(arg => arg === '--next').length <= 1,
    'Expected q36 source, optional verified Qwen27B projector and optional --next ABI');
  source = fs.realpathSync(process.argv[2]); report.sourceRevision = ownGitRevision(source);
  report.sourceFiles = {}; let files = 0, bytes = 0;
  const copyCode = relative => {
    fs.mkdirSync(path.join(tree, relative), {recursive: true});
    for (const entry of fs.readdirSync(path.join(source, relative), {withFileTypes: true})) {
      const name = path.join(relative, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== '.git' && (relative || ['metal', 'third_party', 'tests'].includes(entry.name))) copyCode(name);
      } else if (/\.(c|h|m|metal|inc)$/.test(entry.name) || entry.name === 'Makefile') {
        assert(entry.isFile(), `Linked/nonregular source rejected: ${name}`);
        const size = fs.statSync(path.join(source, name)).size;
        files++; bytes += size;
        assert(files <= 4096 && bytes <= 64 * 1024 * 1024, 'Source-copy budget exceeded');
        const data = fs.readFileSync(path.join(source, name));
        assert.equal(data.length, size, `Source changed during copy: ${name}`);
        report.sourceFiles[name] = hash(data); fs.writeFileSync(path.join(tree, name), data);
      }
    }
  };
  copyCode('');
  report.patchSHA256 = hash(fs.readFileSync(path.join(root, 'patch/q36-metal-runtime', patchName)));
  report.scriptSHA256 = hash(fs.readFileSync(script));
  report.probeSHA256 = hash(fs.readFileSync(path.join(root, 'tests/support/q36_metal_probe.m')));
  report.attentionProbeSHA256 = hash(fs.readFileSync(path.join(root, 'tests/support/q36_attention_work_probe.m')));
  report.attentionHarnessSHA256 = hash(fs.readFileSync(path.join(root, 'tests/integration/q36_attention_work_test.mjs')));
  report.visionProbeSHA256 = hash(fs.readFileSync(path.join(root, 'tests/support/q36_vision_metal_probe.m')));
  report.encoderProbeSHA256 = hash(fs.readFileSync(path.join(root, 'tests/support/q36_vision_encoder_probe.c')));
  report.cancelProbeSHA256 = hash(fs.readFileSync(path.join(root, 'tests/support/q36_cancel_admission_probe.c')));
  report.cancelHarnessSHA256 = hash(fs.readFileSync(path.join(root, 'tests/integration/q36_cancel_admission_test.mjs')));
  report.textPrepareProbeSHA256 = hash(fs.readFileSync(path.join(root, 'tests/support/q36_text_prepare_unit.c')));
  report.textPrepareHarnessSHA256 = hash(fs.readFileSync(path.join(root, 'tests/integration/q36_text_prepare_test.mjs')));
  if (nextReview) report.visionPrepareProbeSHA256 = hash(fs.readFileSync(path.join(root, 'tests/support/q36_vision_prepare_unit.c')));
  report.payloadPrepareProbeSHA256 = hash(fs.readFileSync(path.join(root, 'tests/support/q36_payload_prepare_unit.c')));
  report.payloadPrepareHarnessSHA256 = hash(fs.readFileSync(path.join(root, 'tests/integration/q36_payload_prepare_test.mjs')));
  report.payloadScheduleProbeSHA256 = hash(fs.readFileSync(path.join(root, 'tests/support/q36_payload_schedule_probe.c')));
  report.payloadScheduleHarnessSHA256 = hash(fs.readFileSync(path.join(root, 'tests/integration/q36_payload_schedule_test.mjs')));
  report.recurrentBatchProbeSHA256 = hash(fs.readFileSync(path.join(root, 'tests/support/q36_recurrent_batch_probe.c')));
  report.recurrentBatchHarnessSHA256 = hash(fs.readFileSync(path.join(root, 'tests/integration/q36_recurrent_batch_test.mjs')));
  report.cacheOwnerProbeSHA256 = hash(fs.readFileSync(path.join(root, 'tests/support/q36_cache_owner_probe.c')));
  report.cacheOwnerHarnessSHA256 = hash(fs.readFileSync(path.join(root, 'tests/integration/q36_cache_owner_test.mjs')));
  report.catalogCoreProbeSHA256 = hash(fs.readFileSync(path.join(root, 'tests/support/q36_catalog_core_probe.c')));
  report.ownerCoreProbeSHA256 = hash(fs.readFileSync(path.join(root, 'tests/support/q36_owner_core_probe.c')));
  report.ownerProbeSHA256 = hash(fs.readFileSync(path.join(root, 'tests/support/q36_owner_probe.c')));
  report.ownerHarnessSHA256 = hash(fs.readFileSync(path.join(root, 'tests/integration/q36_owner_test.mjs')));
  report.httpVisionProbeSHA256 = hash(fs.readFileSync(path.join(root, 'tests/support/q36_http_vision_probe.c')));
  report.httpPrepareProbeSHA256 = hash(fs.readFileSync(path.join(root, 'tests/support/q36_http_prepare_probe.c')));
  report.httpVisionHarnessSHA256 = hash(fs.readFileSync(path.join(root, 'tests/integration/q36_http_vision_test.mjs')));
  report.httpControlProbeSHA256 = hash(fs.readFileSync(path.join(root, 'tests/support/q36_http_control_probe.c')));
  report.httpControlHarnessSHA256 = hash(fs.readFileSync(path.join(root, 'tests/integration/q36_http_control_test.mjs')));
  report.httpTextPrepareProbeSHA256 = hash(fs.readFileSync(path.join(root, 'tests/support/q36_http_text_prepare_probe.c')));
  report.httpTextPrepareHarnessSHA256 = hash(fs.readFileSync(path.join(root, 'tests/integration/q36_http_text_prepare_test.mjs')));
  report.toolReplayIdentityProbeSHA256 = hash(fs.readFileSync(path.join(root, 'tests/support/q36_tool_replay_identity_probe.c')));
  report.toolReplayIdentityHarnessSHA256 = hash(fs.readFileSync(path.join(root, 'tests/integration/q36_tool_replay_identity_test.mjs')));
  report.toolMapProbeSHA256 = hash(fs.readFileSync(path.join(root, 'tests/support/q36_tool_map_probe.c')));
  report.toolMapHarnessSHA256 = hash(fs.readFileSync(path.join(root, 'tests/integration/q36_tool_map_test.mjs')));
  report.toolSchemaProbeSHA256 = hash(fs.readFileSync(path.join(root, 'tests/support/q36_tool_schema_probe.c')));
  report.toolSchemaHarnessSHA256 = hash(fs.readFileSync(path.join(root, 'tests/integration/q36_tool_schema_test.mjs')));
  report.harnessSHA256 = hash(fs.readFileSync(import.meta.filename));
  assert.equal((await apply('restore')).status, 0);
  const original = read().map(b => b === null ? null : Buffer.concat([b, Buffer.from('\n/* unrelated contributor fixture */\n')]));
  put(original);
  for (const action of ['check', 'restore']) {assert.equal((await apply(action)).status, 0); assert.deepEqual(read(), original);}
  assert.equal((await apply('apply')).status, 0); const adapted = read();
  adapted.forEach((b, i) => assert.notDeepEqual(b, original[i]));
  for (const action of ['apply', 'check']) {assert.equal((await apply(action)).status, 0); assert.deepEqual(read(), adapted);}
  for (const action of ['restore', 'restore']) {assert.equal((await apply(action)).status, 0); assert.deepEqual(read(), original);}
  passed('Apply/repeat/check/restore preserve unrelated source edits');
  for (let i = 0; i < related.length; i++) {
    const partial = original.map((b, j) => i === j ? adapted[j] : b); put(partial);
    for (const action of ['check', 'apply', 'restore']) {
      assert.notEqual((await apply(action)).status, 0); assert.deepEqual(read(), partial);
    }
    passed(`Partial ${related[i]} cannot change any file`);
    put(original);
    const drift = original.map((b, j) => j === i ? Buffer.from('/* incompatible source fixture */\n') : b);
    put(drift); assert.notEqual((await apply('apply')).status, 0); assert.deepEqual(read(), drift);
    put(original);
    const target = path.join(tree, related[i]), outside = path.join(run, `outside-${i}`);
    const outsideBytes = original[i] ?? Buffer.from('/* outside shader must survive */\n');
    fs.writeFileSync(outside, outsideBytes);
    if (fs.existsSync(target)) fs.unlinkSync(target);
    fs.symlinkSync(outside, target);
    assert.notEqual((await apply('apply')).status, 0);
    assert.deepEqual(read(), original.map((b, j) => i === j ? outsideBytes : b));
    assert.deepEqual(fs.readFileSync(outside), outsideBytes);
    fs.unlinkSync(target); put(original);
    passed(`Drift and linked ${related[i]} are rejected without collateral writes`);
  }
  const header = fs.readFileSync(path.join(tree, 'q36_gpu.h'));
  fs.writeFileSync(path.join(tree, 'q36_gpu.h'), '/* wrong GPU ABI */\n');
  assert.notEqual((await apply('apply')).status, 0); assert.deepEqual(read(), original);
  fs.writeFileSync(path.join(tree, 'q36_gpu.h'), header);
  passed('Wrong GPU ABI is rejected');
  for (const directory of ['metal', 'tests']) {
    const sourceDir = path.join(tree, directory), parked = path.join(run, `parked ${directory}`);
    fs.renameSync(sourceDir, parked); fs.symlinkSync(parked, sourceDir);
    for (const action of ['check', 'apply', 'restore']) {
      assert.notEqual((await apply(action)).status, 0); assert.deepEqual(read(), original);
    }
    fs.unlinkSync(sourceDir); fs.renameSync(parked, sourceDir);
    passed(`Linked ${directory} parent is rejected without following it for writes`);
  }
  assert.equal((await apply('apply')).status, 0);
  // Lifecycle probes intentionally add unrelated source bytes. Retain the
  // exact resulting compiler/shader inputs separately from the original
  // checkout, so a downstream live run cannot qualify one with the other.
  report.builtSourceFiles = {};
  for (const name of [...new Set([...Object.keys(report.sourceFiles), ...related])].sort()) {
    const file = path.join(tree, name);
    assert(fs.lstatSync(file).isFile(), 'Build source must be regular: ' + name);
    report.builtSourceFiles[name] = hash(fs.readFileSync(file));
  }
  save();
  await requireSuccess('make', ['-j2', 'metal']);
  await requireSuccess(path.join(tree, 'q36-server'), ['--help']);
  await requireSuccess(path.join(tree, 'q36_test'), ['--quant-primitives', '--ssd-cache-shrink', '--qwen-tool-call-format', '--server']);
  passed('Fresh Metal build and selected model-free native tests');
  await requireSuccess(process.execPath, [path.join(root, 'tests/integration/q36_owner_test.mjs'), tree, '--server'], root);
  passed('Private owner readiness, opened-file identity, bounded parent-loss teardown and actual startup failures; no weights');
  await requireSuccess(process.execPath, [path.join(root, 'tests/integration/q36_dense_quant_test.mjs'), tree], root);
  passed('Mixed-format dense FFN composition: 75 native CPU checks with ASan/UBSan');
  await requireSuccess(process.execPath, [path.join(root, 'tests/integration/q36_recurrent_batch_test.mjs'), tree], root);
  passed('Recurrent batch scratch lifetime: 96 real Metal synthetic-weight cases, 1..8 rows, both shapes, fused/unfused/mixed convolution, ASan/UBSan');
  await requireSuccess(process.execPath, [path.join(root, 'tests/integration/q36_catalog_test.mjs'), tree], root);
  passed('Native model identity and HTTP list/detail for 35B, 27B and KAT fixtures');
  await requireSuccess(process.execPath, [path.join(root, 'tests/integration/q36_cancel_admission_test.mjs'), tree], root);
  passed('Pre-cancelled native admission: 24 initialized-state cases with ASan/UBSan');
  await requireSuccess(process.execPath, [path.join(root, 'tests/integration/q36_text_prepare_test.mjs'), tree], root);
  passed('Native private text preparation: CPU state, allocation/cancel failures and active-copy bounds with ASan/UBSan');
  if (nextReview) {
    await requireSuccess(process.execPath, [path.join(root, 'tests/integration/q36_text_prepare_test.mjs'), tree, 'vision'], root);
    passed('Native private visual preparation: exact image identities, bounded active copy and unchanged prior state on failure');
  }
  await requireSuccess(process.execPath, [path.join(root, 'tests/integration/q36_payload_prepare_test.mjs'), tree], root);
  passed('Native private payload preparation: short reads, corrupt input, bounded cancellation and allocation failures with ASan/UBSan');
  await requireSuccess(process.execPath, [path.join(root, 'tests/integration/q36_payload_schedule_test.mjs'), tree], root);
  passed('Native payload read/write scheduling: exact Metal wire bytes, private restore and independent GPU work during blocked I/O; not server scheduling');
  await requireSuccess(process.execPath, [path.join(root, 'tests/integration/q36_http_vision_test.mjs'), tree, ...(nextReview ? ['--next'] : [])], root);
  passed('Native HTTP image parsing, bounds and private publication/cancellation with ASan/UBSan');
  await requireSuccess(process.execPath, [path.join(root, 'tests/integration/q36_http_control_test.mjs'), tree], root);
  passed('Native HTTP request identity, bounded admission and cancellation with ASan/UBSan');
  await requireSuccess(process.execPath, [path.join(root, 'tests/integration/q36_http_text_prepare_test.mjs'), tree, ...(nextReview ? ['--next'] : [])], root);
  passed('Native HTTP text/cache transactions: private preparation, cancellation, stale publication and bounded disk writes with ASan/UBSan');
  await requireSuccess(process.execPath, [path.join(root, 'tests/integration/q36_http_text_prepare_test.mjs'), tree, '--batched', ...(nextReview ? ['--next'] : [])], root);
  passed('Batched HTTP text/cache transactions preserve the original session through whole-prompt cancellation and failures');
  await requireSuccess(process.execPath, [path.join(root, 'tests/integration/q36_tool_replay_identity_test.mjs'), tree], root);
  passed('Native tool replay: semantic identity, disk records, call ordering and unlocked concurrent preparation with ASan/UBSan');
  await requireSuccess(process.execPath, [path.join(root, 'tests/integration/q36_tool_map_test.mjs'), tree, nextReview ? '--v3' : '--v2'], root);
  passed('Native tool-map persistence: grouped calls, corrupt files, resource failures and atomic replacement with ASan/UBSan');
  await requireSuccess(process.execPath, [path.join(root, 'tests/integration/q36_tool_schema_test.mjs'), tree], root);
  passed('Native schema-aware tool arguments: final API bytes, fragmented SSE and exact RAM/disk replay with ASan/UBSan');
  /* Keep collecting independent operator evidence after a failing ownership
   * acceptance, but the complete gate MUST remain failed. No expected-failure
   * exemption: this known batched path is unfinished production work. */
  const cacheOwner = await command(process.execPath,
    [path.join(root, 'tests/integration/q36_cache_owner_test.mjs'), tree], root);
  const cacheOwnerPassed = cacheOwner.status === 0 && !cacheOwner.error;
  report.stages.push({name: 'Batched disk reads/writes, cancellation and exact prefill frontiers must retain independent decoding', passed: cacheOwnerPassed});
  save(); console.log(`${cacheOwnerPassed ? 'PASS' : 'FAIL'}: Batched cache/decode ownership`);
  const probe = path.join(run, 'metal-probe');
  await requireSuccess('clang', ['-O2', '-fno-fast-math', '-ffp-contract=off', '-fobjc-arc',
    `-DDSTUDIO_Q36_METAL_SOURCE=${JSON.stringify(path.join(tree, 'q36_metal.m'))}`, '-I', tree,
    path.join(root, 'tests/support/q36_metal_probe.m'), 'q36_ssd.o', 'q36_gpu_core_metal.o', 'q36_image.o',
    '-framework', 'Foundation', '-framework', 'Metal', '-lm', '-pthread', '-o', probe]);
  const measured = await requireSuccess(probe, []);
  report.probe = JSON.parse(measured.stdout); assert.equal(report.probe.passed, true);
  await requireSuccess(process.execPath, [path.join(root, 'tests/integration/q36_attention_work_test.mjs'), tree], root);
  passed('F16 attention: long-context bounded GPU commands, exact query results, short-view rejection and failed-submission recovery');
  report.binarySHA256 = hash(fs.readFileSync(probe));
  report.serverSHA256 = hash(fs.readFileSync(path.join(tree, 'q36-server')));
  passed('Real Metal 35B/27B layouts, numeric oracle, bounds/lifetime and blocked-allocation publication');
  const visionProbe = path.join(run, 'vision-metal-probe');
  await requireSuccess('clang', ['-O2', '-fno-fast-math', '-ffp-contract=off', '-fobjc-arc',
    `-DDSTUDIO_Q36_METAL_SOURCE=${JSON.stringify(path.join(tree, 'q36_metal.m'))}`, '-I', tree,
    path.join(root, 'tests/support/q36_vision_metal_probe.m'), 'q36_ssd.o', 'q36_gpu_core_metal.o', 'q36_image.o',
    '-framework', 'Foundation', '-framework', 'Metal', '-lm', '-pthread', '-o', visionProbe]);
  const visionMeasured = await requireSuccess(visionProbe, []);
  report.visionProbe = JSON.parse(visionMeasured.stdout); assert.equal(report.visionProbe.passed, true);
  report.visionBinarySHA256 = hash(fs.readFileSync(visionProbe));
  passed('Real Metal vision matmul/attention vs independent scalar oracles and failed-read integrity');
  if (extra[0]) {
    const projector = path.resolve(extra[0]);
    assert(fs.lstatSync(projector).isFile(), 'Projector must be a regular file, not a link');
    assert.equal(fs.statSync(projector).size, 927607488, 'Wrong projector size');
    const expectedProjector = 'cbb841a9ee0636b2ec172f5bb8df2ea8dfeb01e90fe7c6126581d662a0b4e43e';
    assert.equal(await hashFile(projector), expectedProjector, 'Wrong projector hash');
    report.projector = {repository: 'unsloth/Qwen3.8-27B-GGUF', revision: '4ca720788d1e01f1bff70c033e0d0028fd02e502',
      file: 'mmproj-F16.gguf', bytes: 927607488, sha256: expectedProjector, license: 'Apache-2.0'};
    const encoderProbe = path.join(run, 'vision-encoder-probe');
    await requireSuccess('clang', ['-O3', '-ffast-math', '-fno-finite-math-only', '-DQ36_METAL', '-I', tree,
      `-DDSTUDIO_Q36_CORE_SOURCE=${JSON.stringify(path.join(tree, 'q36.c'))}`,
      path.join(root, 'tests/support/q36_vision_encoder_probe.c'), 'q36_metal.o', 'q36_ssd.o', 'q36_image.o',
      '-framework', 'Foundation', '-framework', 'Metal', '-lm', '-pthread', '-o', encoderProbe]);
    const measuredEncoder = await requireSuccess(encoderProbe, [projector]);
    report.encoderProbe = JSON.parse(measuredEncoder.stdout); assert.equal(report.encoderProbe.passed, true);
    report.encoderBinarySHA256 = hash(fs.readFileSync(encoderProbe));
    assert.equal(await hashFile(projector), expectedProjector, 'Projector changed during execution');
    passed('Real Qwen27B projector RGB embeddings vs native scalar path; no LLM/answer-quality claim');
  } else report.encoderProbe = {status: 'NOT_RUN', reason: 'No pinned projector supplied'};
  for (const [name, expected] of Object.entries(report.builtSourceFiles))
    assert.equal(hash(fs.readFileSync(path.join(tree, name))), expected, `Built source changed during gate: ${name}`);
  passed('Built compiler and shader inputs retain their exact identities throughout execution');
  for (const [name, expected] of Object.entries(report.sourceFiles))
    assert.equal(hash(fs.readFileSync(path.join(source, name))), expected, `Original checkout changed: ${name}`);
  passed('Original source checkout preserved');
  for (const [name, expected] of [
    [`patch/q36-metal-runtime/${patchName}`, report.patchSHA256],
    ['scripts/apply-q36-metal-runtime.sh', report.scriptSHA256],
    ['tests/support/q36_metal_probe.m', report.probeSHA256],
    ['tests/support/q36_vision_metal_probe.m', report.visionProbeSHA256],
    ['tests/support/q36_vision_encoder_probe.c', report.encoderProbeSHA256],
    ['tests/support/q36_cancel_admission_probe.c', report.cancelProbeSHA256],
    ['tests/integration/q36_cancel_admission_test.mjs', report.cancelHarnessSHA256],
    ['tests/support/q36_text_prepare_unit.c', report.textPrepareProbeSHA256],
    ['tests/integration/q36_text_prepare_test.mjs', report.textPrepareHarnessSHA256],
    ...(nextReview ? [['tests/support/q36_vision_prepare_unit.c', report.visionPrepareProbeSHA256]] : []),
    ['tests/support/q36_payload_prepare_unit.c', report.payloadPrepareProbeSHA256],
    ['tests/integration/q36_payload_prepare_test.mjs', report.payloadPrepareHarnessSHA256],
    ['tests/support/q36_payload_schedule_probe.c', report.payloadScheduleProbeSHA256],
    ['tests/integration/q36_payload_schedule_test.mjs', report.payloadScheduleHarnessSHA256],
    ['tests/support/q36_cache_owner_probe.c', report.cacheOwnerProbeSHA256],
    ['tests/integration/q36_cache_owner_test.mjs', report.cacheOwnerHarnessSHA256],
    ['tests/support/q36_catalog_core_probe.c', report.catalogCoreProbeSHA256],
    ['tests/support/q36_owner_core_probe.c', report.ownerCoreProbeSHA256],
    ['tests/support/q36_owner_probe.c', report.ownerProbeSHA256],
    ['tests/integration/q36_owner_test.mjs', report.ownerHarnessSHA256],
    ['tests/support/q36_recurrent_batch_probe.c', report.recurrentBatchProbeSHA256],
    ['tests/integration/q36_recurrent_batch_test.mjs', report.recurrentBatchHarnessSHA256],
    ['tests/support/q36_http_vision_probe.c', report.httpVisionProbeSHA256],
    ['tests/support/q36_http_prepare_probe.c', report.httpPrepareProbeSHA256],
    ['tests/integration/q36_http_vision_test.mjs', report.httpVisionHarnessSHA256],
    ['tests/support/q36_http_control_probe.c', report.httpControlProbeSHA256],
    ['tests/integration/q36_http_control_test.mjs', report.httpControlHarnessSHA256],
    ['tests/support/q36_http_text_prepare_probe.c', report.httpTextPrepareProbeSHA256],
    ['tests/integration/q36_http_text_prepare_test.mjs', report.httpTextPrepareHarnessSHA256],
    ['tests/support/q36_tool_replay_identity_probe.c', report.toolReplayIdentityProbeSHA256],
    ['tests/integration/q36_tool_replay_identity_test.mjs', report.toolReplayIdentityHarnessSHA256],
    ['tests/support/q36_tool_map_probe.c', report.toolMapProbeSHA256],
    ['tests/integration/q36_tool_map_test.mjs', report.toolMapHarnessSHA256],
    ['tests/support/q36_tool_schema_probe.c', report.toolSchemaProbeSHA256],
    ['tests/integration/q36_tool_schema_test.mjs', report.toolSchemaHarnessSHA256],
    ['tests/integration/q36_metal_runtime_test.mjs', report.harnessSHA256],
  ]) assert.equal(hash(fs.readFileSync(path.join(root, name))), expected, `Test input changed during run: ${name}`);
  passed('Patch, script and probes retain their captured identities throughout execution');
  assert(report.stages.every(stage => stage.passed), 'At least one required native acceptance failed; all results retained');
  report.passed = true;
} catch (error) {
  report.error = String(error.stack || error); console.error(report.error); process.exitCode = 1;
} finally {report.finished = new Date().toISOString(); save(); console.log(`Evidence: ${run}`);}

// Execute the native transformer and compare to frozen pre-migration output.
// Git is an independent patch apply/reversal oracle. This is not inference QA.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { artifactRunDir, writeArtifact } from '../support/real_harness.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const assets = path.join(root, 'patch/ds4-agent-jsonl');
const bases = JSON.parse(fs.readFileSync(path.join(assets, 'bases.json')));
const run = artifactRunDir('agent-patch-migration');
const receipt = { scope: 'Native unified patch migration; frozen version-86 output and independent Git oracle; no models',
  started: new Date().toISOString(), cases: [], passed: false };
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const save = () => writeArtifact(run, 'results.json', receipt);
function command(cmd, args, cwd = root, pass = true) {
  const result = spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024 });
  assert(!result.error, String(result.error));
  if (pass) assert.equal(result.status, 0, `${cmd}: ${result.stderr}\n${result.stdout}`);
  else assert.notEqual(result.status, 0, 'Invalid source must be rejected');
  return result.stdout;
}
function baseSource(base) {
  if (process.env.DSTUDIO_AGENT_BASE_SOURCES)
    return fs.readFileSync(path.join(process.env.DSTUDIO_AGENT_BASE_SOURCES, `${base.name}.c`));
  const engine = path.resolve(base.name === 'qwen35'
    ? (process.env.DSTUDIO_AGENT_QWEN35_DIR || path.join(root, 'ds4-qwen35'))
    : base.name === 'qwen38' || base.name === 'qwen38-next'
    ? (process.env.DSTUDIO_AGENT_QWEN38_DIR || path.join(root, 'ds4-qwen38'))
    : (process.env.DSTUDIO_AGENT_MAIN_DIR || path.join(root, 'ds4')));
  const git = spawnSync('git', ['-C', engine, 'show', `${base.revision}:${bases.sourceFile}`], { maxBuffer: 16 * 1024 * 1024 });
  if (!git.error && git.status === 0) return git.stdout;
  // An archive has no local Git object; accept its actual file only if its
  // content is the exact pinned base. Never borrow the surrounding repo's HEAD.
  const candidate = base.name === 'laguna'
    ? path.join(process.env.DSTUDIO_AGENT_LAGUNA_DIR || path.join(root, 'ds4-laguna-s21'), bases.sourceFile)
    : path.join(engine, bases.sourceFile);
  const data = fs.readFileSync(candidate);
  assert.equal(hash(data), base.sourceSHA256,
    `Missing exact ${base.name} ${base.revision}; supply local Git objects or DSTUDIO_AGENT_BASE_SOURCES (no automatic downloads)`);
  return data;
}
try {
  if (bases.compactionHelper)
    assert.equal(hash(fs.readFileSync(path.join(assets, bases.compactionHelper.file))), bases.compactionHelper.sha256);
  const emitter = path.join(run, 'emit');
  command(process.env.CC || 'cc', ['-O1', '-std=c11', 'tests/support/emit_agent_patch.c', '-o', emitter]);
  // Reverse the separately recorded first-party cancellation fix only for the
  // frozen historical oracle. Current runtime behavior is tested separately.
  const fragmentWork = path.join(run, 'historical-fragment'); fs.mkdirSync(fragmentWork);
  command('git', ['init', '-q', fragmentWork]);
  const fragmentFile = path.join(fragmentWork, bases.migration.sharedInclude);
  fs.copyFileSync(path.join(assets, bases.migration.sharedInclude), fragmentFile);
  // Image delivery is an additive first-party adaptation. Restore its exact
  // predecessor before the older recorded deltas; never change the v86 oracle.
  const visionFix = path.join(assets, 'remote-vision.patch');
  command('git', ['apply', '-R', '--include=remote-agent.cfrag', '--check', visionFix], fragmentWork);
  command('git', ['apply', '-R', '--include=remote-agent.cfrag', visionFix], fragmentWork);
  const structuredFix = path.join(assets, 'remote-structured-fix.patch');
  command('git', ['apply', '-R', '--check', structuredFix], fragmentWork);
  command('git', ['apply', '-R', structuredFix], fragmentWork);
  const interruptFix = path.join(assets, 'remote-interrupt-fix.patch');
  command('git', ['apply', '-R', '--check', interruptFix], fragmentWork);
  command('git', ['apply', '-R', interruptFix], fragmentWork);
  const fragment = fs.readFileSync(fragmentFile, 'utf8');
  assert.equal(hash(fragment), bases.migration.sharedIncludeSHA256);
  command('git', ['apply', '--check', interruptFix], fragmentWork);
  command('git', ['apply', interruptFix], fragmentWork);
  command('git', ['apply', '--check', structuredFix], fragmentWork);
  command('git', ['apply', structuredFix], fragmentWork);
  command('git', ['apply', '--include=remote-agent.cfrag', '--check', visionFix], fragmentWork);
  command('git', ['apply', '--include=remote-agent.cfrag', visionFix], fragmentWork);
  assert.deepEqual(fs.readFileSync(fragmentFile), fs.readFileSync(path.join(assets, bases.migration.sharedInclude)));
  const visionWork = path.join(run, 'image-adaptation'); fs.mkdirSync(visionWork);
  command('git', ['init', '-q', visionWork]);
  const visionBases = {
    'remote-agent.cfrag': '51d98f1547e4bd835b6ca7c3b96a21fe4cb51fbedc8cf375704f83fd7b5abdd1',
    'remote-tools.cfrag': '6bbf025903446cca58d5e2f29af142011d56311fb8d6d3082b9d0c8c1bb0264c',
  };
  for (const name of Object.keys(visionBases)) fs.copyFileSync(path.join(assets, name), path.join(visionWork, name));
  fs.writeFileSync(path.join(visionWork, 'unrelated.txt'), 'Preserve unrelated checkout data.');
  command('git', ['apply', '-R', '--check', visionFix], visionWork);
  command('git', ['apply', '-R', visionFix], visionWork);
  for (const [name, expected] of Object.entries(visionBases)) assert.equal(hash(fs.readFileSync(path.join(visionWork, name))), expected);
  command('git', ['apply', '--check', visionFix], visionWork);
  command('git', ['apply', visionFix], visionWork);
  command('git', ['apply', '--check', visionFix], visionWork, false);
  for (const name of Object.keys(visionBases)) assert.deepEqual(fs.readFileSync(path.join(visionWork, name)), fs.readFileSync(path.join(assets, name)));
  assert.equal(fs.readFileSync(path.join(visionWork, 'unrelated.txt'), 'utf8'), 'Preserve unrelated checkout data.');
  receipt.imageAdaptation = { patchSHA256: hash(fs.readFileSync(visionFix)), baseHashes: visionBases,
    reverseApplyForwardApplyExactBytes: true, duplicateApplyRejected: true, unrelatedPreserved: true };
  for (const base of bases.bases) {
    const work = path.join(run, base.name); fs.mkdirSync(work);
    command('git', ['init', '-q', work]);
    const original = baseSource(base), input = path.join(work, bases.sourceFile);
    assert.equal(hash(original), base.sourceSHA256);
    fs.writeFileSync(input, original, { flag: 'wx' });
    const patch = path.join(assets, base.patch);
    assert.equal(hash(fs.readFileSync(patch)), base.patchSHA256);
    const row = { base: base.name, revision: base.revision, checks: [] }; receipt.cases.push(row); save();
    function emit(label, data, passes = true) {
      const source = path.join(work, `${label}.input.c`), target = path.join(work, `${label}.output.c`);
      fs.writeFileSync(source, data, { flag: 'wx' });
      const result = spawnSync(emitter, [source, target], { cwd: root, encoding: 'utf8', timeout: 30000 });
      fs.writeFileSync(path.join(work, `${label}.log`), (result.stdout || '') + (result.stderr || ''));
      assert(!result.error, String(result.error));
      assert.equal(result.status === 0, passes, `${base.name}/${label}: ${result.stderr}`);
      assert.deepEqual(fs.readFileSync(source), Buffer.from(data), 'Input bytes must never be edited');
      const output = fs.readFileSync(target);
      if (!passes) assert.deepEqual(output, Buffer.from(data), 'Rejected patch must leave the caller-owned copy unchanged');
      row.checks.push(label); save();
      return output;
    }
    const derived = emit('native-apply', original);
    assert.equal(hash(derived), base.derivedSHA256);
    let migrationDerived = derived;
    for (const key of ['postV101Fix', 'postV100Fix', 'postV99Fix', 'postV98Fix', 'postV97Fix']) {
      if (!base[key]) continue;
      // Undo newest first. Every recorded predecessor remains frozen; a new
      // behavior cannot rewrite a frozen predecessor or the older v86 oracle.
      const current = migrationDerived;
      const recorded = base[key], delta = path.join(assets, recorded.patch);
      assert.equal(hash(fs.readFileSync(delta)), recorded.sha256);
      const staged = path.join(work, key); fs.mkdirSync(staged);
      command('git', ['init', '-q', staged]);
      const target = path.join(staged, bases.sourceFile);
      fs.writeFileSync(target, current, {flag: 'wx'});
      fs.writeFileSync(path.join(staged, 'unrelated.txt'), 'Keep unrelated data.');
      command('git', ['apply', '-R', '--check', delta], staged);
      command('git', ['apply', '-R', delta], staged);
      migrationDerived = fs.readFileSync(target);
      assert.equal(hash(migrationDerived), recorded.previousDerivedSHA256);
      command('git', ['apply', '--check', delta], staged);
      command('git', ['apply', delta], staged);
      assert.deepEqual(fs.readFileSync(target), current);
      command('git', ['apply', '--check', delta], staged, false);
      assert.equal(fs.readFileSync(path.join(staged, 'unrelated.txt'), 'utf8'), 'Keep unrelated data.');
      row.checks.push(key === 'postV101Fix' ? 'progress-summary-roundtrip-and-frozen-v101-parity' :
        key === 'postV100Fix' ? 'durable-summary-roundtrip-and-frozen-v100-parity' :
        key === 'postV99Fix' ? 'worker-readiness-roundtrip-and-frozen-v99-parity' :
        key === 'postV98Fix' ? 'compaction-continuation-roundtrip-and-frozen-v98-parity' :
        'compaction-publication-delta-roundtrip-and-frozen-v97-parity');
    }
    if (base.migrationDerivedSHA256) {
      // The runtime now contains a separately reviewed bug fix. Reverse that
      // exact delta for the historical oracle; never update the frozen hashes
      // to make a behavioral change look like a byte-identical migration.
      const fix = path.join(assets, bases.migration.postMigrationFix.patch);
      assert.equal(hash(fs.readFileSync(fix)), bases.migration.postMigrationFix.sha256);
      const historical = path.join(work, 'migration-oracle'); fs.mkdirSync(historical);
      command('git', ['init', '-q', historical]);
      const target = path.join(historical, bases.sourceFile);
      fs.writeFileSync(target, migrationDerived, { flag: 'wx' });
      const stopFix = path.join(assets, 'remote-tool-stop.patch');
      command('git', ['apply', '-R', '--check', stopFix], historical);
      command('git', ['apply', '-R', stopFix], historical);
      command('git', ['apply', '-R', '--check', fix], historical);
      command('git', ['apply', '-R', fix], historical);
      migrationDerived = fs.readFileSync(target);
      assert.equal(hash(migrationDerived), base.migrationDerivedSHA256);
      row.checks.push('reviewed-renderer-fix-reversed-for-historical-oracle');
      row.checks.push('reviewed-remote-tool-stop-reversed-for-historical-oracle');
    }
    const parts = migrationDerived.toString().split(`#include "${bases.migration.sharedInclude}"\n`);
    assert.equal(parts.length, 2, 'Migration expansion requires exactly one shared implementation');
    // The legacy splice kept one separator newline after the fragment.
    if (base.legacyExpandedSHA256) {
      assert.equal(hash(parts.join(fragment + '\n')), base.legacyExpandedSHA256, 'Native output must match the pre-migration oracle');
      row.checks.push('frozen-legacy-byte-parity');
    } else {
      assert(['main-v41','qwen38','qwen38-next','qwen35'].includes(base.name),
        'Only explicitly new upstream variants lack a legacy runtime oracle');
      assert(base.oracle, 'New variants require an explicit behavioral oracle');
      row.oracle = base.oracle;
    }
    command('git', ['apply', '--check', '--whitespace=error', patch], work);
    command('git', ['apply', '--whitespace=error', patch], work);
    assert.deepEqual(fs.readFileSync(input), derived);
    command('git', ['apply', '--check', patch], work, false);
    command('git', ['apply', '-R', '--check', patch], work);
    command('git', ['apply', '-R', patch], work);
    assert.deepEqual(fs.readFileSync(input), original);
    row.checks.push('independent-git-apply-repeat-reject-reverse');
    emit('repeat-rejected', derived, false);
    const text = original.toString();
    const prefix = '/* unrelated contributor prefix */\n', suffix = '\n/* unrelated contributor suffix */\n';
    assert.equal(emit('unrelated-edits', prefix + text + suffix).toString(), prefix + derived.toString() + suffix);
    assert.deepEqual(emit('crlf-original-preserved', text.replaceAll('\n', '\r\n')), derived);
    // Obtain actual original hunk text from the delta, then edit one byte of
    // that required context. This constructs a drift input, not a source check.
    const lines = fs.readFileSync(patch, 'utf8').split('\n');
    const start = lines.findIndex(line => line.startsWith('@@'));
    const end = lines.findIndex((line, i) => i > start && line.startsWith('@@'));
    const hunk = lines.slice(start + 1, end < 0 ? -1 : end);
    const old = hunk.filter(line => line[0] === ' ' || line[0] === '-').map(line => line.slice(1)).join('\n') + '\n';
    const replacement = hunk.filter(line => line[0] === ' ' || line[0] === '+').map(line => line.slice(1)).join('\n') + '\n';
    const at = text.indexOf(old); assert(at >= 0 && text.indexOf(old, at + 1) < 0);
    emit('drift-rejected', text.slice(0, at) + 'X' + text.slice(at + 1), false);
    emit('partial-rejected', text.slice(0, at) + replacement + text.slice(at + old.length), false);
    row.passed = true; save();
    console.log(`${base.name}: PASS — exact native migration, Git reversal, unrelated edits, CRLF, repeat/partial/drift rejection`);
  }
  receipt.passed = true;
} catch (error) {
  receipt.error = String(error.stack || error); process.exitCode = 1; console.error(receipt.error);
} finally {
  receipt.finished = new Date().toISOString(); save(); console.log(`Preserved patch evidence: ${run}`);
}

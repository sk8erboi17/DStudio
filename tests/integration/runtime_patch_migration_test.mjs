// Production native transformer, frozen legacy outputs and independent Git
// apply/reversal. These are patch lifecycle tests, not inference or browser QA.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { artifactRunDir, writeArtifact } from '../support/real_harness.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const run = artifactRunDir('runtime-patch-migration');
const report = { scope: 'Web and Chat PLD: exact frozen pre-migration bytes and patch lifecycle; no models',
  started: new Date().toISOString(), cases: [], passed: false };
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const save = () => writeArtifact(run, 'results.json', report);
function command(exe, args, cwd = root, expected = 0, extra = {}) {
  const result = spawnSync(exe, args, { cwd, encoding: 'utf8', timeout: 60000,
    maxBuffer: 16 * 1024 * 1024, ...extra });
  assert(!result.error, String(result.error));
  if (expected === 0) assert.equal(result.status, 0, `${exe}: ${result.stderr}\n${result.stdout}`);
  else assert.notEqual(result.status, 0, 'Invalid input must be rejected');
  return result;
}
function sourceFor(kind, base, file) {
  const name = base.name.replace(/-metrics$/, '');
  if (process.env.DSTUDIO_RUNTIME_BASE_SOURCES)
    return fs.readFileSync(path.join(process.env.DSTUDIO_RUNTIME_BASE_SOURCES, `${kind}-${name}.c`));
  const engines = { laguna: 'ds4-laguna-s21', qwen38: 'ds4-qwen38', qwen35: 'ds4-qwen35' };
  const engine = path.join(root, engines[name] || 'ds4');
  const git = spawnSync('git', ['-C', engine, 'show', `${base.revision}:${file}`], { maxBuffer: 16 * 1024 * 1024 });
  const bytes = git.status === 0 ? git.stdout : fs.readFileSync(path.join(engine, file));
  assert.equal(hash(bytes), base.rawSourceSHA256,
    `Missing exact ${kind}/${name} ${base.revision}; supply its Git object or DSTUDIO_RUNTIME_BASE_SOURCES`);
  return bytes;
}
try {
  const emitter = path.join(run, 'emit');
  command(process.env.CC || 'cc', ['-O1', '-std=c11', 'tests/support/emit_agent_patch.c', '-o', emitter]);
  for (const [kind, directory] of [['web', 'ds4-web-runtime'], ['server', 'ds4-server-pld']]) {
    const assets = path.join(root, 'patch', directory);
    const metadata = JSON.parse(fs.readFileSync(path.join(assets, 'bases.json')));
    for (const base of metadata.bases) {
      const row = { kind, base: base.name, revision: base.revision, checks: [] };
      report.cases.push(row); save();
      const work = path.join(run, `${kind}-${base.name}`); fs.mkdirSync(work);
      command('git', ['init', '-q', work]);
      const file = path.join(work, metadata.sourceFile);
      fs.writeFileSync(file, sourceFor(kind, base, metadata.sourceFile), { flag: 'wx' });
      if (base.prerequisites.length) {
        assert.deepEqual(base.prerequisites, ['patch/ds4-server-metrics/usage-metrics.patch']);
        command('sh', ['scripts/apply-ds4-server-metrics.sh', 'apply'], root, 0,
          { env: { ...process.env, DS4_DIR: work } });
      }
      const original = fs.readFileSync(file), delta = path.join(assets, base.patch);
      assert.equal(hash(original), base.sourceSHA256);
      assert.equal(hash(fs.readFileSync(delta)), base.patchSHA256);
      function emit(label, bytes, passes = true) {
        const input = path.join(work, `${label}.input.c`), output = path.join(work, `${label}.output.c`);
        fs.writeFileSync(input, bytes, { flag: 'wx' });
        const r = command(emitter, [input, output, `--${kind}`], root, passes ? 0 : 1);
        fs.writeFileSync(path.join(work, `${label}.log`), r.stdout + r.stderr, { flag: 'wx' });
        assert.deepEqual(fs.readFileSync(input), Buffer.from(bytes), 'Original source must not be edited');
        const result = fs.readFileSync(output);
        if (!passes) assert.deepEqual(result, Buffer.from(bytes), 'Rejected delta must not publish a partial candidate');
        row.checks.push(label); save();
        return result;
      }
      const derived = emit('native-apply', original);
      assert.equal(hash(derived), base.derivedSHA256);
      assert.equal(hash(derived), base.legacyExpandedSHA256, 'Migration must retain exact legacy output');
      row.checks.push('frozen-legacy-byte-parity');
      command('git', ['apply', '--check', '--whitespace=error', delta], work);
      command('git', ['apply', '--whitespace=error', delta], work);
      assert.deepEqual(fs.readFileSync(file), derived);
      command('git', ['apply', '--check', delta], work, 1);
      command('git', ['apply', '-R', '--check', delta], work);
      command('git', ['apply', '-R', delta], work);
      assert.deepEqual(fs.readFileSync(file), original);
      row.checks.push('independent-git-apply-repeat-reject-reverse');
      emit('repeat-rejected', derived, false);
      const before = '/* unrelated contributor prefix */\n', after = '\n/* unrelated contributor suffix */\n';
      assert.equal(emit('unrelated-edits', before + original + after).toString(), before + derived + after);
      assert.deepEqual(emit('crlf-original-preserved', original.toString().replaceAll('\n', '\r\n')), derived);
      // Delta parsing constructs controlled fault inputs. The assertions above
      // and below execute the transformer and inspect its actual outputs.
      const lines = fs.readFileSync(delta, 'utf8').split('\n');
      const first = lines.findIndex(line => line.startsWith('@@'));
      const next = lines.findIndex((line, i) => i > first && line.startsWith('@@'));
      const hunk = lines.slice(first + 1, next < 0 ? -1 : next);
      const old = hunk.filter(line => ' -'.includes(line[0])).map(line => line.slice(1)).join('\n') + '\n';
      const updated = hunk.filter(line => ' +'.includes(line[0])).map(line => line.slice(1)).join('\n') + '\n';
      const text = original.toString(), at = text.indexOf(old);
      assert(at >= 0 && text.indexOf(old, at + 1) < 0);
      emit('drift-rejected', text.slice(0, at) + 'X' + text.slice(at + 1), false);
      emit('partial-rejected', text.slice(0, at) + updated + text.slice(at + old.length), false);
      row.passed = true; save();
      console.log(`${kind}/${base.name}: PASS — byte parity, Git roundtrip, source preservation, repeat/drift/partial rejection`);
    }
  }
  report.passed = true;
} catch (error) {
  report.error = String(error.stack || error); process.exitCode = 1; console.error(report.error);
} finally {
  report.finished = new Date().toISOString(); save(); console.log(`Preserved migration evidence: ${run}`);
}

// Production HTTP generation, native disk envelope and owner publication.
// Session calculation is simulated; numerical/real-model gates are separate.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {artifactRunDir, writeArtifact} from '../support/real_harness.mjs';

const run = artifactRunDir('q36-http-text-prepare');
const report = {started: new Date().toISOString(), status: 'FAIL', cases: [],
  scope: 'Production generate_job/cache/HTTP; native session work simulated with deterministic barrier; no inference'};
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const save = () => writeArtifact(run, 'results.json', report);
console.log(`Evidence: ${run}`); save();
try {
  const flags = process.argv.slice(3);
  assert(new Set(flags).size === flags.length && flags.every(f => ['--direct-baseline', '--batched', '--next', '--cache-usage'].includes(f)));
  assert(!flags.includes('--direct-baseline') || flags.length === 1);
  assert(!flags.includes('--cache-usage') || flags.includes('--next'));
  const nextReview = flags.includes('--next'), batched = flags.includes('--batched');
  const engine = fs.realpathSync(process.argv[2]);
  report.variant = batched ? 'batched-private-transaction' : flags.includes('--direct-baseline') ? 'prior-in-place' : 'private-transaction';
  report.nextReview = nextReview;
  const probe = path.resolve(import.meta.dirname, '../support/q36_http_text_prepare_probe.c');
  const core = path.resolve(import.meta.dirname, '../support/q36_catalog_core_probe.c');
  const inputs = [probe, core, import.meta.filename, ...['q36.c', 'q36_server.c', 'q36.h', 'q36_image.c',
    'q36_ssd.c', 'rax.c'].map(f => path.join(engine, f))];
  report.inputs = Object.fromEntries(inputs.map(f => [f, hash(f)]));
  for (const file of [probe, core, import.meta.filename]) fs.copyFileSync(file, path.join(run, path.basename(file)), fs.constants.COPYFILE_EXCL);
  const binary = path.join(run, 'probe');
  const args = ['-std=c11', '-O1', '-g', '-fsanitize=address,undefined', '-fno-omit-frame-pointer',
    '-ffunction-sections', '-fdata-sections', '-I', engine, probe, core,
    ...['q36_image.c', 'q36_ssd.c', 'rax.c'].map(f => path.join(engine, f)), '-lm', '-pthread', '-o', binary,
    process.platform === 'darwin' ? '-Wl,-dead_strip' : '-Wl,--gc-sections'];
  if (process.platform !== 'darwin') args.unshift('-D_GNU_SOURCE');
  if (flags.includes('--direct-baseline')) args.unshift('-DDSTUDIO_Q36_TEXT_BASELINE');
  if (batched) args.unshift('-DDSTUDIO_Q36_TEXT_BATCHED_TEST');
  if (nextReview) args.unshift('-DDSTUDIO_Q36_NEXT_REVIEW');
  if (flags.includes('--cache-usage')) args.unshift('-DDSTUDIO_Q36_CACHE_USAGE_TEST');
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(Q36_|DS4|DSTUDIO_|DYLD_)/.test(k)));
  env.ASAN_OPTIONS = 'detect_leaks=0';
  const built = spawnSync('cc', args, {env, encoding: 'utf8', timeout: 120000, maxBuffer: 2 ** 21});
  report.build = {args, exitCode: built.status, signal: built.signal, stdout: built.stdout, stderr: built.stderr, error: built.error?.message}; save();
  assert.equal(built.status, 0, built.stderr || built.error?.message);
  report.binarySHA256 = hash(binary);
  const names = [
    'cold prompt and checkpoints publish only after complete preparation',
    'failed prefill preserves the previous session and files',
    'mid-prefill cancellation preserves the previous session and files',
    'late cancellation after native success cannot publish',
    'stale preparation cannot replace a newer owner session',
    'allocation failure does not change the active session',
    'disk prefix loads privately and increments hits only on commit',
    'failed disk-prefix continuation preserves session and hit count',
    'cancellation during payload restore preserves session and files',
    'invalid native payload falls back without changing the previous checkpoint',
    'memory-token prefix extends privately without disk reload',
    'memory-byte prefix preserves exact tokens across a BPE boundary',
    'checkpoint write failure cannot corrupt inference or prior files',
    'checkpoint rename failure cannot claim a durable frontier',
    'shutdown during preparation cannot publish',
    'candidate with changed context cannot publish',
    'pre-cancelled request performs no preparation',
    'private disk budget bounds caching without changing inference',
    'failed memory-prefix continuation preserves the prior frontier',
    'header-token mismatch falls back without invalidating the active session',
    'disabled disk cache still prepares and publishes privately',
  'disk byte budget counts the actual serialized tool map, independent of RAM layout',
    'private checkpoint count is bounded and duplicate destinations are coalesced',
    'private checkpoint byte ceiling applies even with an unlimited configured cache',
  ];
  if (nextReview) names.push('checkpoint mutation agrees with the actual preserved/omitted Qwen prelude');
  if (nextReview && !batched) names.push(
    'text after images stages cold checkpoints privately and retires pending image tools only on commit',
    'failed text after images preserves the visual session and pending tools',
    'cancelled text after images preserves the visual session and pending tools',
    'stale text after images cannot overwrite the new owner or retire pending tools',
    'text after images privately restores an existing text checkpoint',
    'matching text token IDs cannot reuse image-conditioned state',
    'failed disk continuation after images preserves the visual session and file hits',
    'cancelled disk restore after images preserves the visual session and file hits',
    'lost job admission after images cannot publish text or retire pending tools',
    'lost single-session job admission cannot publish a plain text candidate');
  const cases = names.map((name, id) => ({name, id}));
  if (nextReview) cases.push(...[
    'newer live checkpoint is saved only after the unrelated cold prompt commits',
    'failed cold preparation cannot publish a newer live eviction checkpoint',
    'cancelled cold preparation cannot publish a newer live eviction checkpoint',
    'late cancellation cannot publish a newer live eviction checkpoint',
    'stale session cannot publish a newer live eviction checkpoint',
    'successful disk restore preserves the newer evicted live checkpoint',
    'failed disk continuation cannot publish a newer live eviction checkpoint',
    'cancelled disk restore cannot publish a newer live eviction checkpoint',
    'shutdown cannot publish a newer live eviction checkpoint',
    'changed context cannot publish a newer live eviction checkpoint',
    'lost job admission cannot publish a newer live eviction checkpoint',
  ].map((name, i) => ({name, id: 35 + i})));
  if (flags.includes('--cache-usage')) {
    for (const api of ['OpenAI completion', 'OpenAI chat', 'Responses', 'Anthropic']) {
      for (const format of ['JSON', 'SSE']) {
        for (const cache of ['cold', 'disk', 'memory-token', 'memory-byte']) {
          cases.push({name: `${api} ${format} reports committed ${cache} cache usage`,
            id: 46 + (cases.length - (batched ? 36 : 46))});
        }
      }
    }
  }
  for (const {id: i, name} of cases) {
    const r = spawnSync(binary, [String(i), path.join(run, `cache-${i}`)],
      {env, encoding: 'utf8', timeout: 10000, maxBuffer: 2 ** 20});
    const row = {name, passed: false, exitCode: r.status, signal: r.signal,
      stdout: r.stdout, stderr: r.stderr, error: r.error?.message}; report.cases.push(row);
    try {
      assert.equal(r.status, 0, r.stderr || r.error?.message);
      row.output = JSON.parse(r.stdout); assert.equal(row.output.failures, 0); row.passed = true;
    } catch (error) {row.error = String(error.stack || error);}
    console.log(`${row.passed ? 'PASS' : 'FAIL'}: ${name}`); save();
  }
  report.status = report.cases.every(c => c.passed) ? 'PASS' : 'FAIL';
} catch (error) {report.error = String(error.stack || error); console.error(report.error);}
finally {
  for (const [file, expected] of Object.entries(report.inputs || {})) if (hash(file) !== expected) {
    report.status = 'FAIL'; report.changedInput = file;
  }
  report.finished = new Date().toISOString(); save();
  if (report.status !== 'PASS') process.exitCode = 1;
}

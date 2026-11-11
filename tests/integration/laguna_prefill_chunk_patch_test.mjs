// Lifecycle of patch/ds4-laguna-prefill-chunk on copies of the bundled Laguna
// engine (src/engines/ds4-laguna-s21 is never written): apply, repeat apply,
// restore to exact bytes, drift and partial patches refused without changes,
// unrelated edits preserved, ds4 main skipped, composition after the managed
// runtime patch stack, then a build of the patched ds4-server/ds4, an offline
// compile of the patched Metal library (ds4 compiles its shaders only when a
// model loads) and a DS4_TEST_HOOKS object whose resolver this test executes.
// Nothing loads a model or runs GPU work. Build outputs go stale when the
// patch state changes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { compileMetalLibrary } from '../support/ds4_metal_library.mjs';

const root = process.cwd();
const script = path.join(root, 'scripts/apply-ds4-laguna-prefill-chunk.sh');
const pristine = path.join(root, 'src/engines/ds4-laguna-s21');
const mainEngine = path.join(root, 'src/engines/ds4');
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'laguna-prefill-chunk-'));
const env = { ...process.env };
delete env.DS4_METAL_PREFILL_CHUNK;
const run = (dir, action, scriptPath = script) =>
  spawnSync('/bin/sh', [scriptPath, action], { encoding: 'utf8', timeout: 60000, env: { ...env, DS4_DIR: dir } });
const touched = ['ds4.c', 'ds4_help.c', 'ds4_metal.m', 'metal/laguna.metal'];
// ds4 main has no metal/laguna.metal; only the files a checkout has are copied.
const copySources = (from, to) => {
  fs.mkdirSync(path.join(to, 'metal'), { recursive: true });
  for (const f of touched) if (fs.existsSync(path.join(from, f))) fs.copyFileSync(path.join(from, f), path.join(to, f));
};
const hashes = dir => Object.fromEntries(touched.filter(f => fs.existsSync(path.join(dir, f))).map(f => [f, sha(path.join(dir, f))]));
const edit = (file, from, to) => {
  const text = fs.readFileSync(file, 'latin1');
  assert.equal(text.split(from).length, 2, `${path.basename(file)}: anchor must occur once: ${from}`);
  fs.writeFileSync(file, text.replace(from, to), 'latin1');
};

try {
  const pristineHashes = hashes(pristine);

  // Fresh apply, repeat apply, restore, repeat restore on the two touched files.
  const dir = path.join(tmp, 'lifecycle');
  copySources(pristine, dir);
  let r = run(dir, 'check'); assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /applicable/);
  assert.deepEqual(hashes(dir), pristineHashes, 'check must not write');
  r = run(dir, 'apply'); assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /: applied/);
  const patched = hashes(dir);
  for (const f of touched) assert.notEqual(patched[f], pristineHashes[f], `${f} is part of the patch`);
  r = run(dir, 'apply'); assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /already applied/);
  assert.deepEqual(hashes(dir), patched, 'a repeated apply must be a no-op');
  r = run(dir, 'build'); assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /already applied/);
  r = run(dir, 'restore'); assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /: restored/);
  assert.deepEqual(hashes(dir), pristineHashes, 'restore must be byte exact');
  r = run(dir, 'restore'); assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /already restored/);

  // Drift in a patched region of the upstream source: refused, nothing written.
  edit(path.join(dir, 'ds4.c'), 'g->prefill_cap = ctx_size < 16384u ? ctx_size : 16384u;',
    'g->prefill_cap = ctx_size < 8192u ? ctx_size : 8192u;');
  const drifted = hashes(dir);
  r = run(dir, 'apply'); assert.equal(r.status, 1); assert.match(r.stderr, /source drift in the Laguna graph/);
  assert.deepEqual(hashes(dir), drifted, 'drift must change no file');
  r = run(dir, 'restore'); assert.equal(r.status, 1);
  assert.deepEqual(hashes(dir), drifted);

  // Partial patch: ds4.c patched but the help text is not. Neither direction
  // applies; the resolver is present, so this is a partial patch.
  copySources(pristine, dir);
  r = run(dir, 'apply'); assert.equal(r.status, 0, r.stderr);
  fs.copyFileSync(path.join(pristine, 'ds4_help.c'), path.join(dir, 'ds4_help.c'));
  const partial = hashes(dir);
  r = run(dir, 'apply'); assert.equal(r.status, 1); assert.match(r.stderr, /partial or edited patch/);
  assert.deepEqual(hashes(dir), partial, 'a partial patch must change no file');
  // Partial patch: the engine sources patched, the Metal kernels pristine.
  copySources(pristine, dir);
  r = run(dir, 'apply'); assert.equal(r.status, 0, r.stderr);
  fs.copyFileSync(path.join(pristine, 'metal/laguna.metal'), path.join(dir, 'metal/laguna.metal'));
  const partialKernels = hashes(dir);
  r = run(dir, 'apply'); assert.equal(r.status, 1); assert.match(r.stderr, /partial or edited patch/);
  assert.deepEqual(hashes(dir), partialKernels, 'a partial patch must change no file');
  // Drift in the attention loops the patch rewrites (an equivalent bound,
  // written differently upstream): refused, nothing written.
  copySources(pristine, dir);
  const kernels = path.join(dir, 'metal/laguna.metal');
  const loops = fs.readFileSync(kernels, 'utf8').split('key_pos <= query_pos;');
  assert.equal(loops.length, 4, 'the three prefill attention loops');
  fs.writeFileSync(kernels, loops.join('key_pos < query_pos + 1u;'));
  const kernelDrift = hashes(dir);
  r = run(dir, 'apply'); assert.equal(r.status, 1); assert.match(r.stderr, /source drift/);
  assert.deepEqual(hashes(dir), kernelDrift, 'kernel drift must change no file');
  // An edited applied patch is refused in the same way.
  copySources(pristine, dir);
  r = run(dir, 'apply'); assert.equal(r.status, 0, r.stderr);
  edit(path.join(dir, 'ds4.c'), '#define DS4_LAGUNA_METAL_PREFILL_CHUNK 4096u', '#define DS4_LAGUNA_METAL_PREFILL_CHUNK 2048u');
  const editedPatch = hashes(dir);
  r = run(dir, 'restore'); assert.equal(r.status, 1); assert.match(r.stderr, /partial or edited patch/);
  assert.deepEqual(hashes(dir), editedPatch);

  // Unrelated edits outside the hunks survive apply and restore.
  copySources(pristine, dir);
  edit(path.join(dir, 'ds4.c'), 'static void laguna_graph_free(ds4_laguna_gpu_graph *g) {',
    '/* local note kept by the user */\nstatic void laguna_graph_free(ds4_laguna_gpu_graph *g) {');
  edit(path.join(dir, 'ds4_help.c'), '"GGUF model path. Default: ds4flash.gguf"', '"GGUF model path (local). Default: ds4flash.gguf"');
  const withLocal = hashes(dir);
  r = run(dir, 'apply'); assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /: applied/);
  assert.ok(fs.readFileSync(path.join(dir, 'ds4.c'), 'latin1').includes('/* local note kept by the user */'));
  assert.ok(fs.readFileSync(path.join(dir, 'ds4_help.c'), 'latin1').includes('GGUF model path (local).'));
  r = run(dir, 'restore'); assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(hashes(dir), withLocal, 'restore must return to the locally edited bytes');

  // ds4 main has no Laguna graph: skipped, nothing written.
  const mainDir = path.join(tmp, 'main');
  copySources(mainEngine, mainDir);
  const mainHashes = hashes(mainDir);
  r = run(mainDir, 'apply'); assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /not needed/);
  assert.deepEqual(hashes(mainDir), mainHashes);
  assert.equal(run(dir, 'bogus').status, 2);
  assert.equal(run(path.join(tmp, 'absent'), 'apply').status, 2);

  // Full engine copy: the managed runtime stack in setup order, then this patch.
  const full = path.join(tmp, 'engine');
  fs.cpSync(pristine, full, { recursive: true });
  for (const name of ['visible-downloads', 'media-memory', 'server-metrics', 'glm53-runtime',
    'glm53-m2max', 'vision-streaming', 'v41-vision-pairing']) {
    r = run(full, 'apply', path.join(root, `scripts/apply-ds4-${name}.sh`));
    assert.equal(r.status, 0, `${name}: ${r.stderr}`);
  }
  const stack = hashes(full);
  r = run(full, 'apply'); assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /: applied/);
  r = run(full, 'restore'); assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(hashes(full), stack, 'restore after the stack returns to the stack bytes');
  r = run(full, 'apply'); assert.equal(r.status, 0, r.stderr);

  // Build of the patched engine (no model, no GPU work).
  const make = (...args) => spawnSync('make', ['-C', full, ...args], { encoding: 'utf8', timeout: 900000, env });
  r = make('-j4', 'ds4-server', 'ds4', 'ds4_cpu_test_hooks.o', 'ds4_distributed.o', 'ds4_tp.o', 'ds4_ssd.o', 'ds4_layer_pack.o');
  assert.equal(r.status, 0, (r.stdout + r.stderr).slice(-4000));
  const help = spawnSync(path.join(full, 'ds4-server'), ['--help'], { encoding: 'utf8', timeout: 30000, env });
  assert.match(help.stdout + help.stderr, /--prefill-chunk N\s+Graph prefill chunk size\. Default: .*Laguna 4096 on Metal, 16384 elsewhere \(16-16384\)/);

  // The patched kernels, assembled into one library as ds4 does at startup.
  const metal = compileMetalLibrary(full, tmp);
  if (metal.status === 'not-run') console.log(`NOT RUN: offline Metal library compile (${metal.reason})`);
  else assert.equal(metal.status, 'compiled', `patched Metal library: ${metal.errors.join('\n')}\n${metal.output}`);

  // The engine's own resolver, from a DS4_TEST_HOOKS build of the patched ds4.c.
  const probe = path.join(tmp, 'laguna_prefill_chunk_probe');
  r = spawnSync('cc', ['-O2', '-Wall', '-Wextra', '-Werror', '-std=c99', `-I${full}`, '-o', probe,
    path.join(root, 'tests/support/laguna_prefill_chunk_probe.c'),
    ...['ds4_cpu_test_hooks.o', 'ds4_distributed.o', 'ds4_tp.o', 'ds4_ssd.o', 'ds4_layer_pack.o'].map(o => path.join(full, o)),
    '-lm', '-pthread'], { encoding: 'utf8', timeout: 120000 });
  assert.equal(r.status, 0, r.stderr);
  const resolve = (backend, requested, envChunk) => {
    const e = { ...env }; if (envChunk !== undefined) e.DS4_METAL_PREFILL_CHUNK = envChunk;
    const p = spawnSync(probe, [backend, String(requested)], { encoding: 'utf8', timeout: 10000, env: e });
    assert.equal(p.status, 0, p.stderr);
    const m = p.stdout.match(/^chunk=(\d+)\nerror=(.*)$/m); assert.ok(m, p.stdout);
    return { chunk: Number(m[1]), error: m[2] };
  };
  assert.deepEqual(resolve('metal', 0), { chunk: 4096, error: '' }, 'Metal default');
  assert.deepEqual(resolve('cuda', 0), { chunk: 16384, error: '' }, 'other backends keep the branch default');
  assert.deepEqual(resolve('metal', 16384), { chunk: 16384, error: '' }, 'the branch batch stays selectable');
  assert.deepEqual(resolve('metal', 512), { chunk: 512, error: '' });
  assert.deepEqual(resolve('metal', 16), { chunk: 16, error: '' });
  assert.match(resolve('metal', 15).error, /--prefill-chunk 15 is not a Laguna prefill batch from 16 to 16384 rows/);
  assert.equal(resolve('metal', 15).chunk, 0);
  assert.equal(resolve('metal', 16385).chunk, 0, 'more scratch than the branch allocated is refused, not clamped');
  assert.deepEqual(resolve('metal', 0, '1024'), { chunk: 1024, error: '' }, 'DS4_METAL_PREFILL_CHUNK as in main');
  assert.deepEqual(resolve('metal', 2048, '1024'), { chunk: 2048, error: '' }, '--prefill-chunk takes precedence');
  for (const bad of ['abc', '0', '-4', '20000', '4096x']) {
    const out = resolve('metal', 0, bad);
    assert.equal(out.chunk, 0, bad); assert.match(out.error, /DS4_METAL_PREFILL_CHUNK=.* is not a Laguna prefill batch/);
  }

  // Patch state changes invalidate the build outputs.
  assert.equal(make('-q', 'ds4-server').status, 0, 'freshly built server is up to date');
  r = run(full, 'restore'); assert.equal(r.status, 0, r.stderr);
  assert.notEqual(make('-q', 'ds4-server').status, 0, 'restoring the patch makes ds4-server stale');
  assert.notEqual(make('-q', 'ds4').status, 0, 'and the ds4 CLI');
  r = run(full, 'apply'); assert.equal(r.status, 0, r.stderr);
  assert.notEqual(make('-q', 'ds4-server').status, 0, 're-applying keeps the old binary stale');
  assert.deepEqual(hashes(pristine), pristineHashes, 'the bundled snapshot is untouched');
  console.log(`PASS: Laguna prefill patch lifecycle, stack composition, engine build, ${metal.status === 'compiled' ? 'Metal library compile' : 'Metal library compile NOT RUN'} and engine resolver`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

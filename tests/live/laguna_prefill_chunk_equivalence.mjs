// Real-weights check for patch/ds4-laguna-prefill-chunk (PLAN.MD P6 item 2).
//
// The patch changes three things in the Laguna engine (see its README): the
// prefill batch (4096 rows on Metal instead of 16384), key passes in prefill
// attention (no SIMD group walks more than 4096 keys per dispatch) and a ring
// commit that writes each sliding-window slot once. This check builds two
// engines from the bundled Laguna sources in a task-owned run directory --
// the BASELINE (managed runtime stack, without this patch) and the PATCHED
// engine (the same stack plus this patch) -- and runs the `ds4` CLI on the
// real Laguna S 2.1 Q4_K_M weights (read-only), one process at a time:
//
//   1. Prefill equivalence. One ~12,000-token prompt (one 16,384-row batch in
//      the baseline; three batches and three key passes in the patched
//      default) is prefilled by the baseline twice (its own repeatability), by
//      the patched engine with --prefill-chunk 16384 and twice with the
//      patched default. Final-position logits over the whole vocabulary must
//      be bit-identical to the baseline's.
//   2. Decode equivalence. A greedy continuation (at most --steps tokens) with
//      top-20 logits per step: patched 16384 against the patched default, and
//      the patched default against itself. Exact. The baseline's continuation
//      is recorded and compared too, but not judged: after its single batch
//      the baseline commits ~12,000 rows into a 512-slot ring in one dispatch,
//      so which row its decode reads from a slot is unspecified.
//   3. Long context. ~40,000 tokens at ctx 49152 and ~60,000 tokens at ctx
//      65536, each with a needle, with the patched default: each must
//      complete without the Metal error (kIOGPUCommandBufferCallbackError-
//      ImpactingInteractivity) that ends the baseline's prefill, and the
//      answer must contain the needle (reported as a separate criterion).
//
// Tolerance: exact, and explained in the patch README. Rows keep their
// absolute positions, key passes keep each query's online-softmax state in
// float32 memory between dispatches with pass boundaries at absolute key
// positions, and the remaining kernels are per row with a fixed reduction
// order; every batch here holds >= 96 rows and 4096 is a multiple of the
// 32-row matmul tile. Whether the GPU's grouped-MoE tile arithmetic is
// independent of a token's row within its tile is what this run tests. Any
// difference is reported as a failure with its size; it is not rounded into
// a pass.
//
// The CLI sets per-layer display progress only when stderr is a terminal, and
// ds4-server always sets it; without it a whole batch becomes one Metal
// command buffer. Each run therefore gets a pseudo-terminal (script(1)) so the
// command-buffer granularity matches the server path that failed. Each engine
// runs from its own directory, because ds4 reads its Metal sources from there.
//
// No wall-clock cutoff is applied to model loading or inference. Ctrl-C stops
// the owned engine process. Refuses to start beside another engine
// (tests/support/heavy_preflight.mjs). Receipts: tests/.artifacts/
// laguna-prefill-chunk/run-*/ (never erased; a retry gets a new directory).
//
// Usage: node tests/live/laguna_prefill_chunk_equivalence.mjs [--model GGUF]
//        [--steps N] [--skip-long] [--long-tokens N --long-ctx N]
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { artifactRunDir } from '../support/real_harness.mjs';
import { contamination, preflight } from '../support/heavy_preflight.mjs';
import { weightIdentity } from '../support/campaign_identity.mjs';
import { lookupPrompt, needlePrompt, NEEDLE, shippingRecords } from '../support/shipping_log_prompt.mjs';

const root = process.cwd();
const argv = process.argv.slice(2);
const option = (name, fallback) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : fallback; };
const modelPath = path.resolve(option('--model', path.join(root, 'ds4/gguf/laguna-s-2.1-Q4_K_M.gguf')));
const steps = Number(option('--steps', '64'));
const skipLong = argv.includes('--skip-long');

// Explicit criteria (exact; see the header).
const TOLERANCE = {
  finalLogitsMaxAbs: 0,        // every vocabulary logit bit-identical (%.9g round-trips float32)
  topK: 20,                    // identical ids, order and logits at every greedy step
  greedySteps: steps,          // every greedy token identical, up to end of text or this many
  baselineRepeatMaxAbs: 0,     // the baseline must reproduce itself, else the comparison is uninterpretable
};
const REFERENCE_CHUNK = 16384;
const DEFAULT_CHUNK = 4096;    // the patch's Metal default; asserted from the engine log, not assumed
const EQUIV_TARGET_TOKENS = 12000;
const EQUIV_MIN_TOKENS = 2 * DEFAULT_CHUNK + 96; // three batches, the last >= 96 rows
const EQUIV_CTX = 16384;
// Attention work per batch grows with position, so the corpus context is
// checked as well as the size of the corpus's long tasks.
const LONG_CASES = argv.includes('--long-tokens')
  ? [{ tokens: Number(option('--long-tokens')), ctx: Number(option('--long-ctx', '65536')) }]
  : [{ tokens: 40000, ctx: 49152 }, { tokens: 60000, ctx: 65536 }];
const WATCHDOG = /Impacting Interactivity|kIOGPUCommandBufferCallbackError|Metal command batch failed|Laguna prefill failed|Laguna batch prefill failed|prompt processing failed/;

const run = artifactRunDir('laguna-prefill-chunk');
const receipt = {
  schema: 2, purpose: 'PLAN.MD P6 item 2: Laguna prefill batch, key passes and ring commit against the unpatched engine; long-context completion',
  started: new Date().toISOString(), runDir: path.relative(root, run), tolerance: TOLERANCE,
  host: { platform: os.platform(), arch: os.arch(), release: os.release(), cpu: os.cpus()[0]?.model, memoryBytes: os.totalmem() },
  memoryMode: 'Metal resident weights, no SSD expert streaming, no disk KV cache (ds4 CLI)',
  status: 'running', runs: [], failures: [], notes: [],
};
const save = () => fs.writeFileSync(path.join(run, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const finish = (status, reason) => {
  receipt.status = status; if (reason) receipt.reason = reason;
  receipt.finished = new Date().toISOString(); save();
  console.log(`${status.toUpperCase()}: ${reason || 'see receipt'} (${path.relative(root, run)}/receipt.json)`);
  process.exit(status === 'passed' ? 0 : 1);
};
let child = null;
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  if (child) try { process.kill(-child.pid, 'SIGTERM'); } catch {}
  receipt.interrupted = signal; finish('interrupted', `stopped by ${signal}`);
});
save();

if (process.platform !== 'darwin' || process.arch !== 'arm64') finish('not-run', 'requires macOS on Apple Silicon (Metal)');
if (!fs.existsSync(modelPath) || fs.statSync(modelPath).size < 1024 ** 3) finish('blocked', `Laguna weights unavailable: ${modelPath}`);
for (const tool of ['make', 'cc', 'git', 'script']) if (spawnSync('/usr/bin/which', [tool]).status !== 0) finish('blocked', `missing ${tool}`);

// 1. Task-owned engine builds (compile only; no model, no GPU work).
const stack = ['visible-downloads', 'media-memory', 'server-metrics', 'glm53-runtime', 'glm53-m2max',
  'vision-streaming', 'v41-vision-pairing'];
receipt.engines = {};
function buildEngine(name, scripts) {
  const dir = path.join(run, name);
  fs.cpSync(path.join(root, 'src/engines/ds4-laguna-s21'), dir, { recursive: true });
  const record = { dir: path.relative(root, dir), source: 'src/engines/ds4-laguna-s21',
    revision: JSON.parse(fs.readFileSync(path.join(root, 'src/engines/manifest.json'), 'utf8')).engines.laguna.commit, patches: [] };
  receipt.engines[name] = record;
  for (const script of scripts) {
    const scriptPath = path.join(root, `scripts/apply-ds4-${script}.sh`);
    const r = spawnSync('/bin/sh', [scriptPath, 'apply'], { encoding: 'utf8', env: { ...process.env, DS4_DIR: dir } });
    record.patches.push({ script: `scripts/apply-ds4-${script}.sh`, scriptSha256: sha(scriptPath), status: r.status, output: (r.stdout + r.stderr).trim() });
    if (r.status !== 0) { save(); finish('failed', `${name}: patch ${script} did not apply`); }
  }
  const build = spawnSync('make', ['-C', dir, '-j4', 'ds4'], { encoding: 'utf8', maxBuffer: 64 * 1024 ** 2 });
  fs.writeFileSync(path.join(run, `${name}-build.log`), build.stdout + build.stderr);
  if (build.status !== 0) finish('failed', `${name} engine build failed (${name}-build.log)`);
  record.binarySha256 = sha(path.join(dir, 'ds4'));
  record.lagunaMetalSha256 = sha(path.join(dir, 'metal/laguna.metal'));
  save();
  return { dir, bin: path.join(dir, 'ds4') };
}
const baseline = buildEngine('baseline', stack);
const patched = buildEngine('patched', [...stack, 'laguna-prefill-chunk']);
receipt.engines.patched.prefillPatchSha256 = sha(path.join(root, 'patch/ds4-laguna-prefill-chunk/prefill-chunk.patch'));

// Model identity (hash cached by path, size and mtime).
receipt.model = { path: modelPath, bytes: fs.statSync(modelPath).size, mtime: fs.statSync(modelPath).mtime.toISOString() };
receipt.model.sha256 = (await weightIdentity(modelPath, { cacheFile: path.join(root, 'tests/.artifacts/campaign/weight-sha256.json'),
  onHash: (name, bytes) => console.log(`hashing ${path.basename(name)} (${(bytes / 1024 ** 3).toFixed(1)} GiB)`) })).files[0].sha256;
save();

// 2. Deterministic prompts (no private data). Token counts come from the
// model's own tokenizer (--dump-tokens reads only the GGUF vocabulary).
function countTokens(text, name) {
  const file = path.join(run, `${name}.txt`); fs.writeFileSync(file, text);
  const r = spawnSync(patched.bin, ['-m', modelPath, '--dump-tokens', '--prompt-file', file], { encoding: 'utf8', maxBuffer: 256 * 1024 ** 2 });
  if (r.status !== 0) finish('failed', `tokenizer failed for ${name}: ${r.stderr.slice(-400)}`);
  return JSON.parse(r.stdout.split('\n')[0]).length;
}
function sized(target, seed, build) {
  const probe = countTokens(build(shippingRecords(200, seed)).text, `calibration-${seed}`);
  let n = Math.max(1, Math.round(200 * target / probe));
  const made = build(shippingRecords(n, seed));
  made.records = n; made.calibrationTokens = probe; made.tokens = countTokens(made.text, made.name);
  return made;
}
const equivPrompt = sized(EQUIV_TARGET_TOKENS, 7, recs => ({ name: 'equivalence-prompt', text: lookupPrompt(recs) }));
const longPrompts = LONG_CASES.map(({ tokens, ctx }, i) => ({ ...sized(tokens, 11 + i,
  recs => ({ name: `long-prompt-${tokens}`, expected: NEEDLE.expected, text: needlePrompt(recs) })), target: tokens, ctx }));
receipt.prompts = {
  equivalence: { file: 'equivalence-prompt.txt', sha256: sha(path.join(run, 'equivalence-prompt.txt')), records: equivPrompt.records, rawTokens: equivPrompt.tokens },
  long: longPrompts.map(p => ({ file: `${p.name}.txt`, sha256: sha(path.join(run, `${p.name}.txt`)), records: p.records, rawTokens: p.tokens, ctx: p.ctx, expected: p.expected })),
};
save();

// 3. One engine process at a time, each behind a fresh preflight.
// Inherited DS4_* knobs (residency, prefill chunk, ...) would change the
// path under test; every engine process starts without them.
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('DS4')));
receipt.engineEnvironment = 'inherited environment without DS4_* variables';
async function ds4(engine, label, args) {
  const before = preflight({ dir: run });
  const entry = { label, engine: path.basename(engine.dir), args, preflight: before, started: new Date().toISOString() };
  receipt.runs.push(entry); save();
  if (!before.ok) { entry.status = 'blocked'; save(); finish('blocked', `${label}: ${before.reasons.join('; ')}`); }
  const log = path.join(run, `${label}.log`);
  const t0 = process.hrtime.bigint();
  const code = await new Promise(resolve => {
    // script(1) gives the CLI a terminal so prefill commits one layer per
    // Metal command buffer, as ds4-server does (see header).
    child = spawn('/usr/bin/script', ['-q', log, engine.bin, '--metal', '-m', modelPath, '--nothink', '--temp', '0', '--seed', '42', ...args],
      { cwd: engine.dir, detached: true, stdio: ['ignore', 'ignore', 'ignore'], env: cleanEnv });
    child.on('exit', (c, s) => resolve(s ? `signal ${s}` : c));
  });
  child = null;
  entry.seconds = Number(process.hrtime.bigint() - t0) / 1e9;
  entry.exit = code;
  const text = fs.existsSync(log) ? fs.readFileSync(log, 'latin1') : '';
  entry.graph = text.match(/Laguna GPU graph: ctx=(\d+), prefill=(\d+), KV ([0-9.]+) GiB, scratch ([0-9.]+) MiB/)?.slice(1).map(Number) || null;
  entry.watchdog = (text.match(WATCHDOG) || [null])[0];
  entry.failedAt = text.match(/prefill failed at token (\d+)/)?.[1] ? Number(text.match(/prefill failed at token (\d+)/)[1]) : null;
  entry.contamination = contamination(before, preflight({ dir: run }));
  entry.status = code === 0 && !entry.watchdog ? 'completed' : 'failed';
  save();
  return entry;
}
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const promptArgs = (prompt, ctx) => ['--ctx', String(ctx), '--prompt-file', path.join(run, `${prompt.name}.txt`)];
const chunkArgs = chunk => chunk ? ['--prefill-chunk', String(chunk)] : [];

const logits = {};
for (const [label, engine, chunk] of [['baseline-a', baseline, null], ['baseline-b', baseline, null],
  ['patched-16384', patched, REFERENCE_CHUNK], ['default-a', patched, null], ['default-b', patched, null]]) {
  const out = path.join(run, `${label}.logits.json`);
  const entry = await ds4(engine, `${label}-logits`, [...promptArgs(equivPrompt, EQUIV_CTX), ...chunkArgs(chunk), '--dump-logits', out]);
  if (entry.status !== 'completed' || !fs.existsSync(out)) finish('failed', `${label}: logits run failed (${entry.watchdog || entry.exit})`);
  logits[label] = { ...readJson(out), graph: entry.graph };
}
const greedy = {};
for (const [label, engine, chunk] of [['patched-16384', patched, REFERENCE_CHUNK], ['default-a', patched, null],
  ['default-b', patched, null], ['baseline', baseline, null]]) {
  const out = path.join(run, `${label}.greedy.json`);
  const entry = await ds4(engine, `${label}-greedy`, [...promptArgs(equivPrompt, EQUIV_CTX), ...chunkArgs(chunk),
    '--dump-logprobs', out, '--logprobs-top-k', String(TOLERANCE.topK), '-n', String(steps)]);
  if (entry.status !== 'completed' || !fs.existsSync(out)) finish('failed', `${label}: greedy run failed (${entry.watchdog || entry.exit})`);
  greedy[label] = readJson(out);
}

// 4. Comparison.
function compareLogits(a, b) {
  if (a.vocab !== b.vocab || a.prompt_tokens !== b.prompt_tokens || a.logits.length !== b.logits.length)
    return { comparable: false, maxAbs: Infinity, meanAbs: Infinity, differing: null, nonFinite: 0, topKOrderEqual: false, topKOverlap: 0 };
  let max = 0, sum = 0, differing = 0, nonFinite = 0;
  for (let i = 0; i < a.logits.length; i++) {
    const x = a.logits[i], y = b.logits[i];
    if (x === null || y === null) { if (x !== y) nonFinite++; continue; }
    const d = Math.abs(x - y); if (d > 0) differing++; if (d > max) max = d; sum += d;
  }
  const top = l => l.map((v, i) => [v ?? -Infinity, i]).sort((p, q) => q[0] - p[0] || p[1] - q[1]).slice(0, TOLERANCE.topK).map(p => p[1]);
  const ta = top(a.logits), tb = top(b.logits);
  return { maxAbs: max, meanAbs: sum / a.logits.length, differing, nonFinite, argmaxEqual: a.argmax_token?.id === b.argmax_token?.id || JSON.stringify(a.argmax_token) === JSON.stringify(b.argmax_token),
    topKOrderEqual: JSON.stringify(ta) === JSON.stringify(tb), topKOverlap: ta.filter(id => tb.includes(id)).length };
}
const tokenId = t => (t && typeof t === 'object') ? (t.id ?? JSON.stringify(t)) : t;
// Up to the first divergent token: steps whose top-k ids or order differ,
// and the largest logit difference among steps whose top-k ids agree.
function compareGreedy(a, b) {
  const n = Math.min(a.steps.length, b.steps.length);
  let firstDivergence = null, topKMismatchSteps = 0, maxTopLogitAbs = 0;
  for (let s = 0; s < n; s++) {
    if (firstDivergence === null && tokenId(a.steps[s].selected) !== tokenId(b.steps[s].selected)) firstDivergence = s;
    if (firstDivergence !== null) continue;
    const ia = a.steps[s].top_logprobs.map(e => tokenId(e.token)), ib = b.steps[s].top_logprobs.map(e => tokenId(e.token));
    if (JSON.stringify(ia) !== JSON.stringify(ib)) topKMismatchSteps++;
    else a.steps[s].top_logprobs.forEach((e, k) => { maxTopLogitAbs = Math.max(maxTopLogitAbs, Math.abs(e.logit - b.steps[s].top_logprobs[k].logit)); });
  }
  return { stepsA: a.steps.length, stepsB: b.steps.length, firstDivergence,
    identicalSteps: firstDivergence === null ? n : firstDivergence, topKMismatchSteps, maxTopLogitAbsBeforeDivergence: maxTopLogitAbs };
}
const promptTokens = logits['default-a'].prompt_tokens;
receipt.equivalence = {
  promptTokens,
  batches: { baseline: Math.ceil(promptTokens / REFERENCE_CHUNK), default: Math.ceil(promptTokens / DEFAULT_CHUNK),
    defaultLastRows: promptTokens - (Math.ceil(promptTokens / DEFAULT_CHUNK) - 1) * DEFAULT_CHUNK },
  graph: Object.fromEntries(Object.entries(logits).map(([label, value]) => [label, value.graph])),
  logits: {
    baselineRepeat: compareLogits(logits['baseline-a'], logits['baseline-b']),
    patched16384VsBaseline: compareLogits(logits['baseline-a'], logits['patched-16384']),
    defaultVsBaseline: compareLogits(logits['baseline-a'], logits['default-a']),
    defaultRepeat: compareLogits(logits['default-a'], logits['default-b']),
  },
  greedy: {
    defaultVsPatched16384: compareGreedy(greedy['patched-16384'], greedy['default-a']),
    defaultRepeat: compareGreedy(greedy['default-a'], greedy['default-b']),
    baselineVsDefault: compareGreedy(greedy.baseline, greedy['default-a']),
  },
};
const eq = receipt.equivalence;
if (promptTokens < EQUIV_MIN_TOKENS || promptTokens > EQUIV_CTX - steps - 1) receipt.failures.push(`equivalence prompt has ${promptTokens} tokens, outside ${EQUIV_MIN_TOKENS}..${EQUIV_CTX - steps - 1}`);
for (const label of ['baseline-a', 'baseline-b', 'patched-16384'])
  if (eq.graph[label]?.[1] !== REFERENCE_CHUNK) receipt.failures.push(`${label} graph prefill ${eq.graph[label]?.[1]}, expected ${REFERENCE_CHUNK}`);
for (const label of ['default-a', 'default-b'])
  if (eq.graph[label]?.[1] !== DEFAULT_CHUNK) receipt.failures.push(`${label} graph prefill ${eq.graph[label]?.[1]}, expected ${DEFAULT_CHUNK}`);
if (eq.logits.baselineRepeat.maxAbs > TOLERANCE.baselineRepeatMaxAbs || eq.logits.baselineRepeat.nonFinite)
  receipt.failures.push(`the baseline did not reproduce itself (max |dlogit| ${eq.logits.baselineRepeat.maxAbs}); exact comparison is uninterpretable`);
for (const [name, c] of Object.entries(eq.logits)) {
  if (name === 'baselineRepeat') continue;
  if (c.maxAbs > TOLERANCE.finalLogitsMaxAbs || c.nonFinite) receipt.failures.push(`final logits ${name}: max |dlogit| ${c.maxAbs}, mean ${c.meanAbs}, ${c.differing} entries`);
  if (!c.topKOrderEqual) receipt.failures.push(`final top-${TOLERANCE.topK} ${name} differs (${c.topKOverlap}/${TOLERANCE.topK} shared)`);
}
for (const name of ['defaultVsPatched16384', 'defaultRepeat']) {
  const g = eq.greedy[name];
  if (g.firstDivergence !== null || g.stepsA !== g.stepsB) receipt.failures.push(`greedy ${name} diverges at step ${g.firstDivergence} (${g.stepsA}/${g.stepsB} steps)`);
  if (g.topKMismatchSteps) receipt.failures.push(`greedy ${name}: top-${TOLERANCE.topK} differs at ${g.topKMismatchSteps} steps`);
  if (g.maxTopLogitAbsBeforeDivergence > 0) receipt.failures.push(`greedy ${name}: top-${TOLERANCE.topK} logits differ by up to ${g.maxTopLogitAbsBeforeDivergence}`);
}
receipt.notes.push('baselineVsDefault greedy is measured, not judged: the baseline writes its whole batch into the 512-slot sliding-window ring in one dispatch, so its decode reads unspecified rows.');
save();

// 5. Long context with the patched default.
if (!skipLong) {
  receipt.longContext = [];
  for (const prompt of longPrompts) {
    const out = path.join(run, `long-${prompt.target}.greedy.json`);
    const entry = await ds4(patched, `long-${prompt.target}-default-greedy`, [...promptArgs(prompt, prompt.ctx), '--dump-logprobs', out, '--logprobs-top-k', '5', '-n', '24']);
    const answer = fs.existsSync(out) ? readJson(out) : null;
    const text = answer ? answer.steps.map(s => typeof s.selected === 'object' ? (s.selected.text ?? '') : String(s.selected)).join('') : '';
    const row = { target: prompt.target, ctx: prompt.ctx, promptTokens: answer?.prompt_tokens ?? null, graph: entry.graph,
      completed: entry.status === 'completed' && !!answer, watchdog: entry.watchdog, failedAt: entry.failedAt,
      seconds: entry.seconds, answer: text, needleFound: text.includes(prompt.expected) };
    receipt.longContext.push(row);
    if (!row.completed) receipt.failures.push(`long ${prompt.target}: did not complete (${entry.watchdog || entry.exit}${row.failedAt ? ` at token ${row.failedAt}` : ''})`);
    if ((row.promptTokens ?? 0) < Math.floor(prompt.target * 0.9)) receipt.failures.push(`long ${prompt.target}: ${row.promptTokens} prompt tokens, below ${Math.floor(prompt.target * 0.9)}`);
    if (!row.needleFound) receipt.failures.push(`long ${prompt.target}: answer lacks the needle code (reported separately from completion)`);
    save();
  }
}
for (const entry of receipt.runs) if (entry.contamination?.length) receipt.failures.push(`${entry.label}: contaminated: ${entry.contamination.join('; ')}`);
finish(receipt.failures.length ? 'failed' : 'passed', receipt.failures.join(' | ') || (skipLong ? 'equivalence passed; long context not run' : 'equivalence and long context passed'));

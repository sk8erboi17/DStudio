// Real-weights check for patch/ds4-laguna-prefill-chunk (PLAN.MD P6 item 2).
//
// Builds the bundled Laguna engine in a task-owned run directory with the
// managed runtime patch stack plus this patch, then runs the `ds4` CLI on the
// real Laguna S 2.1 Q4_K_M weights (read-only), one process at a time:
//
//   1. Equivalence. One ~12,000-token prompt (fits one 16,384-row batch) is
//      prefilled with --prefill-chunk 16384 (the branch's single batch, twice:
//      the second run measures the reference's own repeatability) and with the
//      patched Metal default (4096: three batches). Final-position logits over
//      the whole vocabulary and a 64-token greedy continuation are compared.
//   2. Long context. One ~40,000-token prompt with a needle is prefilled with
//      the default; it must complete without the Metal watchdog error that
//      fails the unpatched engine at token 16384/32768.
//
// Tolerance (see patch/ds4-laguna-prefill-chunk/README.md): exact. Each row
// keeps its absolute position, the prefill attention kernels visit keys in
// causal order with the same f16 K/V whether a key sits in the staged batch or
// in the cache, and the remaining kernels are per row with a fixed reduction
// order. The design therefore predicts bit-identical logits as long as every
// batch takes the same kernel family as the single batch (all batches here
// hold >= 96 rows, 4096 is a multiple of the 32-row matmul tile). The grouped
// MoE places a token at a different row of its expert's tile when the batch
// changes; that the GPU's tile arithmetic is independent of that row is the
// hypothesis this run tests, not a property the source proves. Any difference
// is reported as a failure with its size; it is not rounded into a pass.
//
// The CLI sets per-layer display progress only when stderr is a terminal, and
// ds4-server always sets it; without it a whole batch becomes one Metal
// command buffer. Each run therefore gets a pseudo-terminal (script(1)) so the
// command-buffer granularity matches the server path that failed.
//
// No wall-clock cutoff is applied to model loading or inference. Ctrl-C stops
// the owned engine process. Refuses to start beside another engine
// (tests/support/heavy_preflight.mjs). Receipts: tests/.artifacts/
// laguna-prefill-chunk/run-*/ (never erased; a retry gets a new directory).
//
// Usage: node tests/live/laguna_prefill_chunk_equivalence.mjs [--model GGUF]
//        [--steps N] [--skip-long] [--long-tokens N] [--long-ctx N]
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { artifactRunDir } from '../support/real_harness.mjs';
import { contamination, preflight } from '../support/heavy_preflight.mjs';
import { weightIdentity } from '../support/campaign_identity.mjs';

const root = process.cwd();
const argv = process.argv.slice(2);
const option = (name, fallback) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : fallback; };
const modelPath = path.resolve(option('--model', path.join(root, 'ds4/gguf/laguna-s-2.1-Q4_K_M.gguf')));
const steps = Number(option('--steps', '64'));
const skipLong = argv.includes('--skip-long');

// Explicit criteria (exact; see the header).
const TOLERANCE = {
  finalLogitsMaxAbs: 0,        // every vocabulary logit bit-identical (%.9g round-trips float32)
  topK: 20,                    // identical ids and order at every compared step
  greedySteps: steps,          // every greedy token identical
  referenceRepeatMaxAbs: 0,    // the 16384 reference must reproduce itself, else the comparison is uninterpretable
};
const REFERENCE_CHUNK = 16384;
const DEFAULT_CHUNK = 4096;    // the patch's Metal default; asserted from the engine log, not assumed
const EQUIV_TARGET_TOKENS = 12000;
const EQUIV_MIN_TOKENS = 2 * DEFAULT_CHUNK + 96; // three batches, the last >= 96 rows
const EQUIV_CTX = 16384;
// Attention work per batch grows with position: at the corpus context
// (65536) a 4096-row batch does about twice the attention of the first
// 16384-row batch that passed. Run --long-tokens 60000 --long-ctx 65536 too.
const LONG_TARGET_TOKENS = Number(option('--long-tokens', '40000'));
const LONG_MIN_TOKENS = Math.floor(LONG_TARGET_TOKENS * 0.9);
const LONG_CTX = Number(option('--long-ctx', '49152'));
const WATCHDOG = /Impacting Interactivity|kIOGPUCommandBufferCallbackError|Metal command batch failed|Laguna prefill failed|Laguna batch prefill failed|prompt processing failed/;

const run = artifactRunDir('laguna-prefill-chunk');
const receipt = {
  schema: 1, purpose: 'PLAN.MD P6 item 2: Laguna prefill batch equivalence and long-context completion',
  started: new Date().toISOString(), runDir: path.relative(root, run), tolerance: TOLERANCE,
  host: { platform: os.platform(), arch: os.arch(), release: os.release(), cpu: os.cpus()[0]?.model, memoryBytes: os.totalmem() },
  memoryMode: 'Metal resident weights, no SSD expert streaming, no disk KV cache (ds4 CLI)',
  status: 'running', runs: [], failures: [],
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

// 1. Task-owned engine build (CPU compile; no model, no GPU).
const engine = path.join(run, 'engine');
fs.cpSync(path.join(root, 'src/engines/ds4-laguna-s21'), engine, { recursive: true });
const patchScripts = ['visible-downloads', 'media-memory', 'server-metrics', 'glm53-runtime', 'glm53-m2max',
  'vision-streaming', 'v41-vision-pairing', 'laguna-prefill-chunk'];
receipt.engine = { source: 'src/engines/ds4-laguna-s21', revision: JSON.parse(fs.readFileSync(path.join(root, 'src/engines/manifest.json'), 'utf8')).engines.laguna.commit, patches: [] };
for (const name of patchScripts) {
  const scriptPath = path.join(root, `scripts/apply-ds4-${name}.sh`);
  const r = spawnSync('/bin/sh', [scriptPath, 'apply'], { encoding: 'utf8', env: { ...process.env, DS4_DIR: engine } });
  receipt.engine.patches.push({ script: `scripts/apply-ds4-${name}.sh`, scriptSha256: sha(scriptPath), status: r.status, output: (r.stdout + r.stderr).trim() });
  if (r.status !== 0) { save(); finish('failed', `patch ${name} did not apply`); }
}
receipt.engine.prefillPatchSha256 = sha(path.join(root, 'patch/ds4-laguna-prefill-chunk/prefill-chunk.patch'));
const build = spawnSync('make', ['-C', engine, '-j4', 'ds4'], { encoding: 'utf8', maxBuffer: 64 * 1024 ** 2 });
fs.writeFileSync(path.join(run, 'build.log'), build.stdout + build.stderr);
if (build.status !== 0) finish('failed', 'engine build failed (build.log)');
const bin = path.join(engine, 'ds4');
receipt.engine.binarySha256 = sha(bin); save();

// Model identity (hash cached by path, size and mtime).
receipt.model = { path: modelPath, bytes: fs.statSync(modelPath).size, mtime: fs.statSync(modelPath).mtime.toISOString() };
receipt.model.sha256 = (await weightIdentity(modelPath, { cacheFile: path.join(root, 'tests/.artifacts/campaign/weight-sha256.json'),
  onHash: (name, bytes) => console.log(`hashing ${path.basename(name)} (${(bytes / 1024 ** 3).toFixed(1)} GiB)`) })).files[0].sha256;
save();

// 2. Deterministic prompts (no private data). Token counts come from the
// model's own tokenizer (--dump-tokens reads only the GGUF vocabulary).
const cities = ['Avora', 'Belmont', 'Caldera', 'Dunmore', 'Elsby', 'Fenwick', 'Galloway', 'Harrow', 'Ilsted', 'Juniper'];
const items = ['valves', 'bearings', 'gaskets', 'sensors', 'cables', 'filters', 'pumps', 'relays'];
function records(count, seed) {
  let x = seed >>> 0; const next = () => (x = (Math.imul(x, 1664525) + 1013904223) >>> 0);
  const out = [];
  for (let i = 1; i <= count; i++) {
    out.push(`Record ${i}: the ${cities[next() % cities.length]} depot shipped ${100 + next() % 900} ${items[next() % items.length]} ` +
      `on day ${1 + next() % 365}; inspector ${String.fromCharCode(65 + next() % 26)}${next() % 100} signed the log, and the batch ` +
      `was stored on shelf ${1 + next() % 40} of aisle ${1 + next() % 12}.`);
  }
  return out;
}
function countTokens(text, name) {
  const file = path.join(run, `${name}.txt`); fs.writeFileSync(file, text);
  const r = spawnSync(bin, ['-m', modelPath, '--dump-tokens', '--prompt-file', file], { encoding: 'utf8', maxBuffer: 256 * 1024 ** 2 });
  if (r.status !== 0) finish('failed', `tokenizer failed for ${name}: ${r.stderr.slice(-400)}`);
  return JSON.parse(r.stdout.split('\n')[0]).length;
}
function sized(target, seed, build) {
  const probe = countTokens(build(records(200, seed)).text, `calibration-${seed}`);
  let n = Math.max(1, Math.round(200 * target / probe));
  const made = build(records(n, seed));
  made.records = n; made.calibrationTokens = probe; made.tokens = countTokens(made.text, made.name);
  return made;
}
const equivPrompt = sized(EQUIV_TARGET_TOKENS, 7, recs => ({ name: 'equivalence-prompt',
  text: `Read the shipping log below.\n\n${recs.join('\n')}\n\nWhich depot shipped the batch in Record ${Math.max(1, Math.floor(recs.length / 2))}, and how many items did it contain? Answer in one sentence.` }));
const needle = 'The vault access code is 4183-KESTREL.';
const longPrompt = sized(LONG_TARGET_TOKENS, 11, recs => {
  const at = Math.floor(recs.length * 0.6);
  return { name: 'long-prompt', expected: '4183-KESTREL',
    text: `Read the shipping log below.\n\n${[...recs.slice(0, at), needle, ...recs.slice(at)].join('\n')}\n\nWhat is the vault access code mentioned in the log? Reply with the code only.` };
});
receipt.prompts = {
  equivalence: { file: 'equivalence-prompt.txt', sha256: sha(path.join(run, 'equivalence-prompt.txt')), records: equivPrompt.records, rawTokens: equivPrompt.tokens },
  long: { file: 'long-prompt.txt', sha256: sha(path.join(run, 'long-prompt.txt')), records: longPrompt.records, rawTokens: longPrompt.tokens, expected: longPrompt.expected },
};
save();

// 3. One engine process at a time, each behind a fresh preflight.
async function ds4(label, args) {
  const before = preflight({ dir: run });
  const entry = { label, args, preflight: before, started: new Date().toISOString() };
  receipt.runs.push(entry); save();
  if (!before.ok) { entry.status = 'blocked'; save(); finish('blocked', `${label}: ${before.reasons.join('; ')}`); }
  const log = path.join(run, `${label}.log`);
  const t0 = process.hrtime.bigint();
  const code = await new Promise(resolve => {
    // script(1) gives the CLI a terminal so prefill commits one layer per
    // Metal command buffer, as ds4-server does (see header).
    child = spawn('/usr/bin/script', ['-q', log, bin, '--metal', '-m', modelPath, '--nothink', '--temp', '0', '--seed', '42', ...args],
      { cwd: engine, detached: true, stdio: ['ignore', 'ignore', 'ignore'], env: cleanEnv });
    child.on('exit', (c, s) => resolve(s ? `signal ${s}` : c));
  });
  child = null;
  entry.seconds = Number(process.hrtime.bigint() - t0) / 1e9;
  entry.exit = code;
  const text = fs.existsSync(log) ? fs.readFileSync(log, 'latin1') : '';
  entry.graph = text.match(/Laguna GPU graph: ctx=(\d+), prefill=(\d+), KV ([0-9.]+) GiB, scratch ([0-9.]+) MiB/)?.slice(1).map(Number) || null;
  entry.watchdog = (text.match(WATCHDOG) || [null])[0];
  entry.contamination = contamination(before, preflight({ dir: run }));
  entry.status = code === 0 && !entry.watchdog ? 'completed' : 'failed';
  save();
  return entry;
}
// Inherited DS4_* knobs (residency, prefill chunk, ...) would change the
// path under test; every engine process starts without them.
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('DS4')));
receipt.engineEnvironment = 'inherited environment without DS4_* variables';
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const promptArgs = (prompt, ctx) => ['--ctx', String(ctx), '--prompt-file', path.join(run, `${prompt.name}.txt`)];

const runs = {};
for (const [label, chunk] of [['reference-16384-a', REFERENCE_CHUNK], ['default', null], ['reference-16384-b', REFERENCE_CHUNK]]) {
  const out = path.join(run, `${label}.logits.json`);
  runs[label] = await ds4(`${label}-logits`, [...promptArgs(equivPrompt, EQUIV_CTX), ...(chunk ? ['--prefill-chunk', String(chunk)] : []), '--dump-logits', out]);
  if (runs[label].status !== 'completed' || !fs.existsSync(out)) finish('failed', `${label}: logits run failed (${runs[label].watchdog || runs[label].exit})`);
  runs[label].logits = readJson(out);
}
const greedy = {};
for (const [label, chunk] of [['reference-16384', REFERENCE_CHUNK], ['default', null]]) {
  const out = path.join(run, `${label}.greedy.json`);
  const entry = await ds4(`${label}-greedy`, [...promptArgs(equivPrompt, EQUIV_CTX), ...(chunk ? ['--prefill-chunk', String(chunk)] : []),
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
  return { stepsReference: a.steps.length, stepsDefault: b.steps.length, firstDivergence,
    identicalSteps: firstDivergence === null ? n : firstDivergence, topKMismatchSteps, maxTopLogitAbsBeforeDivergence: maxTopLogitAbs };
}
const promptTokens = runs['default'].logits.prompt_tokens;
receipt.equivalence = {
  promptTokens, batches: { reference: Math.ceil(promptTokens / REFERENCE_CHUNK), default: Math.ceil(promptTokens / DEFAULT_CHUNK), defaultLastRows: promptTokens - (Math.ceil(promptTokens / DEFAULT_CHUNK) - 1) * DEFAULT_CHUNK },
  graph: { reference: runs['reference-16384-a'].graph, default: runs['default'].graph },
  referenceRepeat: compareLogits(runs['reference-16384-a'].logits, runs['reference-16384-b'].logits),
  finalLogits: compareLogits(runs['reference-16384-a'].logits, runs['default'].logits),
  greedy: compareGreedy(greedy['reference-16384'], greedy['default']),
};
const eq = receipt.equivalence;
if (promptTokens < EQUIV_MIN_TOKENS || promptTokens > EQUIV_CTX - steps - 1) receipt.failures.push(`equivalence prompt has ${promptTokens} tokens, outside ${EQUIV_MIN_TOKENS}..${EQUIV_CTX - steps - 1}`);
if (eq.graph.reference?.[1] !== Math.min(REFERENCE_CHUNK, EQUIV_CTX)) receipt.failures.push(`reference graph prefill ${eq.graph.reference?.[1]}, expected ${REFERENCE_CHUNK}`);
if (eq.graph.default?.[1] !== DEFAULT_CHUNK) receipt.failures.push(`default graph prefill ${eq.graph.default?.[1]}, expected ${DEFAULT_CHUNK}`);
if (eq.referenceRepeat.maxAbs > TOLERANCE.referenceRepeatMaxAbs || eq.referenceRepeat.nonFinite) receipt.failures.push(`the 16384 reference did not reproduce itself (max |dlogit| ${eq.referenceRepeat.maxAbs}); exact comparison is uninterpretable`);
if (eq.finalLogits.maxAbs > TOLERANCE.finalLogitsMaxAbs || eq.finalLogits.nonFinite) receipt.failures.push(`final logits differ: max |dlogit| ${eq.finalLogits.maxAbs}, mean ${eq.finalLogits.meanAbs}, ${eq.finalLogits.differing} entries`);
if (!eq.finalLogits.topKOrderEqual) receipt.failures.push(`final top-${TOLERANCE.topK} differs (${eq.finalLogits.topKOverlap}/${TOLERANCE.topK} shared)`);
if (eq.greedy.firstDivergence !== null || eq.greedy.stepsReference !== eq.greedy.stepsDefault) receipt.failures.push(`greedy continuation diverges at step ${eq.greedy.firstDivergence}`);
if (eq.greedy.topKMismatchSteps) receipt.failures.push(`top-${TOLERANCE.topK} differs at ${eq.greedy.topKMismatchSteps} greedy steps`);
save();

// 5. Long context with the default batch.
if (!skipLong) {
  const out = path.join(run, 'long.greedy.json');
  const entry = await ds4('long-default-greedy', [...promptArgs(longPrompt, LONG_CTX), '--dump-logprobs', out, '--logprobs-top-k', '5', '-n', '24']);
  const answer = fs.existsSync(out) ? readJson(out) : null;
  const text = answer ? answer.steps.map(s => typeof s.selected === 'object' ? (s.selected.text ?? '') : String(s.selected)).join('') : '';
  receipt.longContext = { promptTokens: answer?.prompt_tokens ?? null, graph: entry.graph, completed: entry.status === 'completed' && !!answer,
    watchdog: entry.watchdog, seconds: entry.seconds, answer: text, needleFound: text.includes(longPrompt.expected) };
  if (!receipt.longContext.completed) receipt.failures.push(`long prompt did not complete (${entry.watchdog || entry.exit})`);
  if ((receipt.longContext.promptTokens ?? 0) < LONG_MIN_TOKENS) receipt.failures.push(`long prompt has ${receipt.longContext.promptTokens} tokens, below ${LONG_MIN_TOKENS}`);
  if (!receipt.longContext.needleFound) receipt.failures.push('long prompt answer lacks the needle code (reported separately from the watchdog criterion)');
  save();
}
for (const entry of receipt.runs) if (entry.contamination?.length) receipt.failures.push(`${entry.label}: contaminated: ${entry.contamination.join('; ')}`);
finish(receipt.failures.length ? 'failed' : 'passed', receipt.failures.join(' | ') || (skipLong ? 'equivalence passed; long context not run' : 'equivalence and long context passed'));

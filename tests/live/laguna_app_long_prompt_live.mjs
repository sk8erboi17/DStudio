// Laguna long prompts through the app, on the installed engine
// (patch/ds4-laguna-prefill-chunk; PLAN.MD P6 item 2).
//
// Starts the production host on the maintainer's model store, selects
// Laguna's installed checkout as the app does and starts Chat on the real
// Laguna S 2.1 Q4_K_M weights. That launch is the upgrade path of an existing
// installation: it applies the managed engine patches and rebuilds a
// ds4-server built before them. Then one ~40,000-token needle prompt goes
// through the host's /v1 proxy; it must be answered with the needle code. The
// unpatched engine ended this prompt with the Metal error
// kIOGPUCommandBufferCallbackErrorImpactingInteractivity.
//
// Records the checkout's patch state and server SHA-256 before and after the
// launch, the engine's graph line (prefill rows) when the host log carries it,
// timings, usage and the answer. No wall-clock cutoff on loading or inference;
// refuses to start beside another engine. Receipts:
// tests/.artifacts/laguna-app-long-prompt/run-*/.
//
// Usage: node tests/live/laguna_app_long_prompt_live.mjs [tests/.build/dstudio-server-test]
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { artifactRunDir, csrfHeaders, jsonFetch, safeReadTail, startDStudio, startMode } from '../support/real_harness.mjs';
import { contamination, preflight } from '../support/heavy_preflight.mjs';
import { needlePrompt, NEEDLE, shippingRecords } from '../support/shipping_log_prompt.mjs';

const MODEL = 'gguf/laguna-s-2.1-Q4_K_M.gguf';
const RECORDS = 838, SEED = 11;   // ~40,100 Laguna tokens (laguna-prefill-chunk receipts)
const CTX = 65536;
const run = artifactRunDir('laguna-app-long-prompt');
const receipt = { schema: 1, purpose: 'Laguna long prompt through the app after the installed engine is upgraded by a Chat launch',
  started: new Date().toISOString(), model: MODEL, ctx: CTX, status: 'running', failures: [] };
const save = () => fs.writeFileSync(path.join(run, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
const sha = file => fs.existsSync(file) ? crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') : null;
const patchState = dir => {
  const r = spawnSync('/bin/sh', [path.resolve('scripts/apply-ds4-laguna-prefill-chunk.sh'), 'check'], { encoding: 'utf8', env: { ...process.env, DS4_DIR: dir } });
  return { exit: r.status, output: (r.stdout + r.stderr).trim() };
};
let server = null;
const finish = async (status, reason) => {
  if (server?.logPath) fs.writeFileSync(path.join(run, 'host.log'), safeReadTail(server.logPath, 4 * 1024 * 1024));
  if (server) {
    await jsonFetch(server.baseUrl, '/api/stop', { method: 'POST', headers: csrfHeaders, body: '{}', timeoutMs: 120_000 }).catch(() => {});
    await server.stop();
  }
  receipt.status = status; if (reason) receipt.reason = reason; receipt.finished = new Date().toISOString(); save();
  console.log(`${status.toUpperCase()}: ${reason || 'see receipt'} (${path.relative(process.cwd(), run)}/receipt.json)`);
  process.exit(status === 'passed' ? 0 : 1);
};
save();

const before = preflight({ dir: run });
receipt.preflight = before; save();
if (!before.ok) await finish('blocked', before.reasons.join('; '));
try {
  server = await startDStudio({ binaryArg: process.argv[2], label: 'laguna-app', isolatedEnginePort: true });
  const catalog = await jsonFetch(server.baseUrl, '/api/ggufs', { timeoutMs: 10_000 });
  const entry = (catalog.ggufs || []).filter(g => g.path === MODEL);
  if (entry.length !== 1 || !entry[0].engineDir) await finish('blocked', `${MODEL} is not installed with an engine checkout`);
  const engineDir = entry[0].engineDir;
  receipt.engine = { dir: path.basename(engineDir), before: { patch: patchState(engineDir), serverSha256: sha(path.join(engineDir, 'ds4-server')) } };
  save();
  const selected = await jsonFetch(server.baseUrl, '/api/engine/checkout', { method: 'POST', headers: csrfHeaders,
    body: JSON.stringify({ dir: engineDir }), timeoutMs: 60_000 });
  if (selected.ok === false) await finish('failed', `engine checkout refused: ${JSON.stringify(selected)}`);
  const t0 = performance.now();
  const status = await startMode(server.baseUrl, { mode: 'server', model: 'standard', variant: 'flash', gguf: MODEL,
    ctx: CTX, power: 100, think: 'off', ssdStreaming: 'off', workdir: '' }, 0);
  receipt.startupSeconds = (performance.now() - t0) / 1000;
  receipt.engine.after = { patch: patchState(engineDir), serverSha256: sha(path.join(engineDir, 'ds4-server')) };
  receipt.engine.status = { mode: status.mode, ready: status.ready, modelFile: status.modelFile, ctx: status.config?.ctx ?? null };
  save();
  if (!/already applied/.test(receipt.engine.after.patch.output)) receipt.failures.push(`after the launch the checkout reports: ${receipt.engine.after.patch.output}`);

  const prompt = needlePrompt(shippingRecords(RECORDS, SEED));
  receipt.prompt = { records: RECORDS, seed: SEED, sha256: crypto.createHash('sha256').update(prompt).digest('hex'), expected: NEEDLE.expected };
  const t1 = performance.now();
  const reply = await jsonFetch(server.baseUrl, '/v1/chat/completions', { method: 'POST', timeoutMs: 0,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'ds4', messages: [{ role: 'user', content: prompt }], stream: false, think: false, temperature: 0, max_tokens: 32 }) })
    .catch(error => ({ transportError: String(error?.message || error) }));
  receipt.requestSeconds = (performance.now() - t1) / 1000;
  receipt.answer = reply?.choices?.[0]?.message?.content ?? null;
  receipt.usage = reply?.usage ?? null;
  receipt.transportError = reply?.transportError ?? (reply?.error ? JSON.stringify(reply.error).slice(0, 500) : null);
  const log = safeReadTail(server.logPath, 4 * 1024 * 1024);
  receipt.graph = log.match(/Laguna GPU graph: ctx=(\d+), prefill=(\d+), KV ([0-9.]+) GiB, scratch ([0-9.]+) MiB/)?.slice(1).map(Number) || null;
  receipt.watchdog = (log.match(/Impacting Interactivity|kIOGPUCommandBufferCallbackError|Laguna prefill failed[^\n]*/) || [null])[0];
  receipt.contamination = contamination(before, preflight({ dir: run }));
  save();
  if (receipt.transportError) receipt.failures.push(`request failed: ${receipt.transportError}`);
  if (receipt.watchdog) receipt.failures.push(`Metal error in the engine log: ${receipt.watchdog}`);
  if ((receipt.usage?.prompt_tokens ?? 0) < 36000) receipt.failures.push(`prompt_tokens ${receipt.usage?.prompt_tokens ?? 'missing'}, below 36000`);
  if (!String(receipt.answer || '').includes(NEEDLE.expected)) receipt.failures.push(`answer lacks ${NEEDLE.expected}: ${JSON.stringify(receipt.answer)}`);
  if (receipt.graph && receipt.graph[1] !== 4096) receipt.failures.push(`engine prefill batch ${receipt.graph[1]}, expected 4096`);
  if (!receipt.graph) receipt.graphNote = 'the host log carries no Laguna graph line; the batch is not observed here';
  for (const line of receipt.contamination) receipt.failures.push(`contaminated: ${line}`);
  await finish(receipt.failures.length ? 'failed' : 'passed', receipt.failures.join(' | ') || `answered ${NEEDLE.expected} from ${receipt.usage.prompt_tokens} prompt tokens`);
} catch (error) {
  receipt.error = String(error?.stack || error);
  await finish('failed', String(error?.message || error).split('\n')[0]);
}

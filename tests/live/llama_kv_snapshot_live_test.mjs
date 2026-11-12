// Disk snapshots of the llama.cpp slot on REAL weights (PLAN.MD P3.2;
// src/dstudio_kv_snapshot.c, opt-in DSTUDIO_LLAMA_KV_SNAPSHOTS=1).
//
// For each model, three Agent sessions with the same two turns, each in a new
// production host with its own KV store, one engine at a time:
//   live       turn 1, turn 2: the second turn reuses the slot in memory.
//   restore    turn 1 (the host saves the slot), engine restart, switch back
//              to the session (the host restores the slot), turn 2.
//   reprefill  the same with snapshots off: the restored session is prefilled
//              again from its transcript.
// A slot file is the engine's own copy of its KV cache and recurrent state,
// so the restored second turn must equal the live one exactly. The hosts run
// with DSTUDIO_AGENT_GREEDY=1 (temperature 0, top-p 1; asserted from the
// runtime's own arguments): with the published Qwen sampling a first run on
// November 12 already wrote different first turns, which made the comparison
// uninterpretable (run-jo7oJk, retained). The hybrid recurrent layers of Qwen3.6 and Qwen3.8 are
// the specific risk. The first turn must be identical in all three sessions,
// or the comparison is uninterpretable. The re-prefilled second turn is
// measured and recorded, not judged: llama.cpp computes a batched prefill with
// other kernels than token-by-token decode, so it may legitimately differ.
//
// Usage: node tests/live/llama_kv_snapshot_live_test.mjs [tests/.build/dstudio-server-test]
//        DSTUDIO_KV_MODELS=qwen36,qwen27 (default both)
// No wall-clock cutoff on loading or inference; refuses beside another engine.
// Receipts: tests/.artifacts/llama-kv-snapshot-live/run-*/.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { artifactRunDir, csrfHeaders, jsonFetch, safeReadTail, sleep, startDStudio } from '../support/real_harness.mjs';
import { contamination, preflight } from '../support/heavy_preflight.mjs';

const MODELS = {
  qwen36: 'gguf/Qwen3.6-35B-A3B-UD-Q6_K_XL.gguf',
  qwen27: 'gguf/Qwen3.8-27B-UD-Q6_K_XL.gguf',
};
const selected = (process.env.DSTUDIO_KV_MODELS || 'qwen36,qwen27').split(',').filter(Boolean);
for (const id of selected) if (!MODELS[id]) throw new Error(`unknown model ${id}; use ${Object.keys(MODELS).join(', ')}`);
const TURN1 = 'Without using any tool, list three facts about the planet Mars, one per line, and nothing else.';
const TURN2 = 'Without using any tool: which of those three facts mentions a moon or moons? Reply with that line only.';
const CTX = 16384;

const run = artifactRunDir('llama-kv-snapshot-live');
const workspace = path.join(run, 'workspace');
const receipt = { schema: 1, purpose: 'llama.cpp slot snapshot restore against the live continuation, real weights',
  started: new Date().toISOString(), turns: [TURN1, TURN2], ctx: CTX, models: {}, failures: [], status: 'running' };
const save = () => fs.writeFileSync(path.join(run, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
save();

// Visible text of a slice of the Agent transcript, as compared: control
// frames (\x1e{json}\n) carry status, timings and snapshot reports, and the
// runtime's own session lines name a session id; both differ between sessions.
const SESSION_LINE = /^\s*(?:saved session|switched to session|deleted session) [0-9a-f]{8}\b.*$/gm;
function visible(text) { return text.replace(/\x1e\{[^\n]*\}\n/g, '').replace(SESSION_LINE, '').trim(); }
function frames(text, type) {
  return [...text.matchAll(/\x1e(\{[^\n]*\})\n/g)].map((m) => { try { return JSON.parse(m[1]); } catch { return null; } })
    .filter((f) => f && (!type || f.type === type));
}
function firstDifference(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? null : n;
}

async function session(modelId, variant) {
  const model = MODELS[modelId];
  fs.rmSync(workspace, { recursive: true, force: true });
  fs.mkdirSync(workspace, { recursive: true });
  const kvDir = path.join(run, `${modelId}-${variant}-kv`);
  const row = { variant, kvDir: path.relative(run, kvDir) };
  const before = preflight({ dir: run });
  row.preflight = { ok: before.ok, reasons: before.reasons };
  if (!before.ok) { row.status = 'blocked'; return row; }
  const server = await startDStudio({ binaryArg: process.argv[2], label: `kv-${modelId}-${variant}`, isolatedEnginePort: true,
    env: { DSTUDIO_KV_DIR: kvDir, DSTUDIO_LLAMA_KV_SNAPSHOTS: variant === 'reprefill' ? '' : '1', DSTUDIO_AGENT_GREEDY: '1' } });
  let since = 0, transcript = '';
  const status = () => jsonFetch(server.baseUrl, '/api/status', { timeoutMs: 10_000 });
  const kv = async () => (await status()).llamaKvSnapshot || null;
  const poll = async () => {
    const r = await jsonFetch(server.baseUrl, `/api/agent/poll?since=${since}`, { timeoutMs: 10_000 });
    transcript += r.text || ''; since = r.len;
  };
  const until = async (check, what) => { for (;;) { const v = await check(); if (v) return v; await sleep(500); } };
  const idle = () => until(async () => { const s = await status(); return s.ready && !s.agentWorking ? s : null; }, 'idle');
  const start = async () => {
    const r = await jsonFetch(server.baseUrl, '/api/start', { method: 'POST', headers: csrfHeaders, timeoutMs: 60_000,
      body: JSON.stringify({ mode: 'agent', modelBackend: 'local', gguf: model, workdir: workspace, port: server.enginePort,
        ctx: CTX, power: 100, think: 'off', ssdStreaming: 'off' }) });
    if (r.ok === false) throw new Error(`start refused: ${JSON.stringify(r)}`);
    since = 0; transcript = '';
    return until(async () => {
      const s = await status();
      if (s.engineError && !s.running) throw new Error(`engine failed: ${s.engineError}`);
      return s.ready && s.mode === 'agent' && !s.agentWorking ? s : null;
    }, 'ready');
  };
  const stop = async () => {
    await jsonFetch(server.baseUrl, '/api/stop', { method: 'POST', headers: csrfHeaders, body: '{}', timeoutMs: 120_000 });
    await until(async () => { const s = await status(); return !s.running && !s.residentPid ? s : null; }, 'stopped');
  };
  const turn = async (prompt) => {
    await poll(); const from = transcript.length;
    const sent = await jsonFetch(server.baseUrl, '/api/agent/send', { method: 'POST', headers: csrfHeaders, timeoutMs: 30_000,
      body: JSON.stringify({ prompt, orchestration: 'native' }) });
    if (!sent.ok && sent.ok !== undefined) throw new Error(`send refused: ${JSON.stringify(sent)}`);
    const t0 = performance.now();
    await idle(); await poll();
    const slice = transcript.slice(from);
    return { ms: Math.round(performance.now() - t0), text: visible(slice), session: slice.match(/saved session ([0-9a-f]{8})/)?.[1] ?? null,
      toolCalls: frames(slice, 'tool_call').length,
      timings: frames(slice).filter((f) => /timing|usage|stats/.test(f.type || '')).slice(-2) };
  };
  try {
    const t0 = performance.now();
    row.startedStatus = { model: (await start()).modelFile };
    row.loadMs = Math.round(performance.now() - t0);
    // The comparison is exact only under greedy sampling: read it from the
    // Agent runtime the host started (its descendants), not from the request.
    row.runtimeArgs = execFileSync('/bin/ps', ['-axo', 'ppid=,pid=,args='], { encoding: 'utf8' }).split('\n')
      .filter((line) => /ds4-agent-jsonl/.test(line) && line.includes('--remote-base-url')).map((line) => line.trim().slice(0, 400));
    if (!row.runtimeArgs.some((line) => / --temp 0 /.test(line + ' ') && / --top-p 1 /.test(line + ' ')))
      throw new Error(`the Agent runtime does not sample greedily: ${JSON.stringify(row.runtimeArgs)}`);
    row.turn1 = await turn(TURN1);
    if (variant !== 'live') {
      if (variant === 'restore') {
        row.save = await until(async () => { const k = await kv(); return k?.lastSave && k.activity === 'idle' ? k.lastSave : null; }, 'save');
      }
      if (!row.turn1.session) throw new Error('the runtime announced no saved session after the first turn');
      await stop();
      await start();
      const before = (await kv())?.lastRestore?.seq || 0;
      const switched = await jsonFetch(server.baseUrl, '/api/design/session', { method: 'POST', headers: csrfHeaders, timeoutMs: 60_000,
        body: JSON.stringify({ action: 'switch', sha: row.turn1.session }) });
      row.switch = { ok: switched.ok !== false };
      await idle(); await poll();
      row.switchText = visible(transcript).slice(-400);
      // With snapshots off nothing is restored and no outcome is reported.
      row.restore = variant === 'restore'
        ? await until(async () => { const k = await kv(); return k?.lastRestore && k.lastRestore.seq > before ? k.lastRestore : null; }, 'restore')
        : (await kv())?.lastRestore ?? null;
    }
    row.turn2 = await turn(TURN2);
    if (variant === 'restore') row.restoreAfterTurn = (await kv())?.lastRestore || null;
    row.kv = await kv();
    row.contamination = contamination(before, preflight({ dir: run }));
    row.status = 'completed';
  } catch (error) {
    row.status = 'failed'; row.error = String(error?.stack || error);
  } finally {
    fs.writeFileSync(path.join(run, `${modelId}-${variant}-transcript.txt`), transcript);
    if (server.logPath) fs.writeFileSync(path.join(run, `${modelId}-${variant}-host.log`), safeReadTail(server.logPath, 2 * 1024 * 1024));
    if (server.residentLogPath && fs.existsSync(server.residentLogPath))
      fs.writeFileSync(path.join(run, `${modelId}-${variant}-resident.log`), safeReadTail(server.residentLogPath, 4 * 1024 * 1024));
    await jsonFetch(server.baseUrl, '/api/stop', { method: 'POST', headers: csrfHeaders, body: '{}', timeoutMs: 120_000 }).catch(() => {});
    await server.stop();
  }
  return row;
}

for (const modelId of selected) {
  const model = MODELS[modelId];
  const entry = receipt.models[modelId] = { model, sessions: {} };
  if (!fs.existsSync(path.join(process.env.DSTUDIO_REAL_DS4_DIR || 'ds4', model))) {
    entry.status = 'blocked'; receipt.failures.push(`${modelId}: ${model} is not installed (BLOCKED)`); save(); continue;
  }
  for (const variant of ['live', 'restore', 'reprefill']) {
    entry.sessions[variant] = await session(modelId, variant); save();
  }
  const s = entry.sessions;
  const failed = Object.entries(s).filter(([, row]) => row.status !== 'completed');
  for (const [variant, row] of failed) receipt.failures.push(`${modelId} ${variant}: ${row.status}${row.error ? `: ${row.error.split('\n')[0]}` : ''}`);
  if (!failed.length) {
    entry.turn1Identical = s.live.turn1.text === s.restore.turn1.text && s.live.turn1.text === s.reprefill.turn1.text;
    entry.restoreOutcome = s.restore.restore?.outcome ?? null;
    entry.restoreTokens = s.restore.restore?.tokens ?? null;
    entry.restoreFirstCompletion = s.restore.restoreAfterTurn?.firstCompletion ?? null;
    entry.reprefillOutcome = s.reprefill.restore?.outcome ?? null;
    entry.restoreVsLive = { identical: s.restore.turn2.text === s.live.turn2.text, firstDifference: firstDifference(s.live.turn2.text, s.restore.turn2.text) };
    entry.reprefillVsLive = { identical: s.reprefill.turn2.text === s.live.turn2.text, firstDifference: firstDifference(s.live.turn2.text, s.reprefill.turn2.text) };
    if (!entry.turn1Identical) receipt.failures.push(`${modelId}: the first turn differs between sessions; the comparison is uninterpretable`);
    if (entry.restoreOutcome !== 'restored' || !(entry.restoreTokens > 0)) receipt.failures.push(`${modelId}: restore outcome ${entry.restoreOutcome} (${entry.restoreTokens} tokens)`);
    const fc = entry.restoreFirstCompletion;
    if (!fc || fc.cacheTokens !== entry.restoreTokens || !(fc.promptTokens > 0 && fc.promptTokens < fc.cacheTokens))
      receipt.failures.push(`${modelId}: the restored tokens were not the first completion's cache (${JSON.stringify(fc)})`);
    if (!entry.restoreVsLive.identical) receipt.failures.push(`${modelId}: the restored second turn differs from the live one at character ${entry.restoreVsLive.firstDifference}`);
    if (entry.reprefillOutcome === 'restored') receipt.failures.push(`${modelId}: the snapshots-off session reported a restore`);
    for (const [variant, row] of Object.entries(s)) for (const line of row.contamination || []) receipt.failures.push(`${modelId} ${variant}: contaminated: ${line}`);
  }
  save();
}
receipt.status = receipt.failures.length ? 'failed' : 'passed';
receipt.finished = new Date().toISOString(); save();
console.log(`${receipt.status.toUpperCase()}: ${receipt.failures.join(' | ') || 'restored continuations equal the live ones'} (${path.relative(process.cwd(), run)}/receipt.json)`);
process.exitCode = receipt.status === 'passed' ? 0 : 1;

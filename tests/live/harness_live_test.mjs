// REAL inference: third-party coding agents (pi, opencode) as DStudio's Agent
// runtime through the bridge, against the production host and real weights:
// Qwen3.6 and Qwen3.8-27B on DStudio's llama.cpp (model RPC), DeepSeek V4
// Flash on a ds4-server owned by the bridge (pi through the patched pi-ds4).
// One harness x model at a time, sequentially.
//
//   node tests/live/harness_live_test.mjs
//   DSTUDIO_HARNESSES=pi,opencode   DSTUDIO_HARNESS_MODELS=qwen36,qwen27,deepseek
//   DSTUDIO_REAL_TEST_TIMEOUT_MS=0  no wall-clock bound for model work
//
// Held-out data is generated per run and checked against an independent
// computation: the written file's exact contents, an exact code, and a read
// outside the workspace that must not return the outside file's contents.
// Requires the harnesses installed (scripts/install-harness.py) and the
// weights present; anything missing is BLOCKED, never a pass. Receipts:
// tests/.artifacts/harness-live/.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { artifactRunDir, csrfHeaders, jsonFetch, pollAgent, sleep, startDStudio, writeArtifact } from '../support/real_harness.mjs';

const run = artifactRunDir('harness-live');
const boundMs = Number(process.env.DSTUDIO_REAL_TEST_TIMEOUT_MS ?? 3_600_000);
const MODELS = {
  qwen36: { file: 'gguf/Qwen3.6-35B-A3B-UD-Q6_K_XL.gguf', engine: 'llama.cpp' },
  qwen27: { file: 'gguf/Qwen3.8-27B-UD-Q6_K_XL.gguf', engine: 'llama.cpp' },
  deepseek: { file: 'gguf/DeepSeek-V4-Flash-Vision-Exp-IQ2XXS-w2Q2K-AProjQ8-SExpQ8-OutQ8.gguf', engine: 'ds4-server' },
  qwen36mlx: { file: 'mlx/Qwen3.6-35B-A3B-mxfp8', engine: 'mlx', mlx: true },
};
const list = (name, fallback) => String(process.env[name] || fallback).split(',').map((s) => s.trim()).filter(Boolean);
const harnesses = list('DSTUDIO_HARNESSES', 'pi,opencode');
const models = list('DSTUDIO_HARNESS_MODELS', 'qwen36,qwen27,deepseek');
const receipt = { scope: 'REAL inference: DStudio host + harness bridge + real weights; generated tasks with independent checks',
  startedAt: new Date().toISOString(), runs: [], failures: [] };
const save = () => writeArtifact(run, 'results.json', receipt);

const listening = (port) => new Promise((resolve) => {
  const socket = net.connect({ host: '127.0.0.1', port });
  socket.once('connect', () => { socket.destroy(); resolve(true); });
  socket.once('error', () => resolve(false));
});

async function startMode(baseUrl, body) {
  const t0 = performance.now();
  const res = await jsonFetch(baseUrl, '/api/start', { method: 'POST', headers: csrfHeaders, body: JSON.stringify(body),
    timeoutMs: boundMs > 0 ? boundMs : 0 });
  if (!res.ok) throw new Error(`start failed: ${JSON.stringify(res)}`);
  for (;;) {
    const st = await jsonFetch(baseUrl, '/api/status', { timeoutMs: 5000 });
    if (st.ready && st.mode === body.mode && !st.agentWorking) return st;
    if (st.running === false && st.engineError) throw new Error(`stopped during startup: ${st.engineError}`);
    if (boundMs > 0 && performance.now() - t0 > boundMs) throw new Error('did not become ready (BLOCKED, not a pass)');
    await sleep(1000);
  }
}

async function turn(baseUrl, since, prompt) {
  const sent = await jsonFetch(baseUrl, '/api/agent/send', { method: 'POST', headers: csrfHeaders,
    body: JSON.stringify({ prompt, displayPrompt: prompt }), timeoutMs: 30_000 });
  assert.ok(sent.ok, `send failed: ${JSON.stringify(sent)}`);
  const t0 = performance.now();
  let pos = since, text = '', sawWork = false;
  for (;;) {
    const r = await pollAgent(baseUrl, pos);
    if (r.text) text += r.text;
    pos = r.len ?? pos;
    if (r.working) sawWork = true;
    if (sawWork && !r.working && !r.sessionWorking) return { text, pos, ms: Math.round(performance.now() - t0) };
    if (boundMs > 0 && performance.now() - t0 > boundMs) return { text, pos, ms: Math.round(performance.now() - t0), timedOut: true };
    await sleep(1000);
  }
}

// Only processes of this run: the workspace path is unique to it.
function leftovers(marker) {
  try {
    return execFileSync('pgrep', ['-fl', marker], { encoding: 'utf8' }).split('\n').filter((l) => l && !l.includes('pgrep'));
  } catch { return []; }
}

function visible(text) {
  // Transcript text without frames and user echoes, as the UI shows it.
  return text.replace(/\x1e[^\n]*\n/g, '').replace(/\x01USER\x02[\s\S]*?\x01ENDUSER\x02\n?/g, '');
}

if (await listening(28000)) {
  receipt.failures.push('BLOCKED: another engine listens on 127.0.0.1:28000; close it and rerun');
  receipt.blocked = true;
}
const harnessRoot = path.resolve('harness');
for (const harness of receipt.blocked ? [] : harnesses) for (const key of models) {
  const spec = MODELS[key];
  const row = { harness, model: key, engine: spec?.engine, cases: [] };
  receipt.runs.push(row); save();
  const dir = path.join(run, `${harness}-${key}`);
  const workspace = path.join(dir, 'workspace');
  fs.mkdirSync(path.join(workspace, 'data'), { recursive: true });
  let server = null;
  try {
    if (!spec) throw new Error(`unknown model ${key}`);
    const receiptFile = path.join(harnessRoot, harness, '.dstudio-harness.json');
    if (!fs.existsSync(receiptFile)) throw new Error(`${harness} is not installed (BLOCKED, not a pass)`);
    row.harnessReceipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
    const items = Array.from({ length: 5 }, (_, i) => ({ sku: `Q${crypto.randomInt(1000, 9999)}${i}`,
      qty: crypto.randomInt(2, 17), cents: crypto.randomInt(110, 8899) }));
    const total = (items.reduce((s, it) => s + it.qty * it.cents, 0) / 100).toFixed(2);
    fs.writeFileSync(path.join(workspace, 'data/order.csv'),
      'sku,quantity,unit_price_eur\n' + items.map((it) => `${it.sku},${it.qty},${(it.cents / 100).toFixed(2)}`).join('\n') + '\n');
    const code = `H-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
    fs.writeFileSync(path.join(workspace, 'data/notes.md'), `# Notes\n\nThe build code is ${code}.\n`);
    const outside = path.join(dir, 'outside-secret.txt');
    const secret = `OUTSIDE-${crypto.randomBytes(4).toString('hex')}`;
    fs.writeFileSync(outside, secret + '\n');
    row.oracle = { total, code, secret };

    server = await startDStudio({ label: `harness-${harness}-${key}`, isolatedEnginePort: true });
    const present = spec.mlx ? fs.existsSync(path.join(server.ds4Dir, spec.file, 'config.json'))
      : (server.ggufs || []).some((g) => g.file === spec.file);
    assert.ok(present, `${spec.file} is not installed (BLOCKED, not a pass)`);
    const launch = { mode: 'agent', harness, model: 'standard', variant: 'flash', gguf: spec.file, port: server.enginePort,
      ctx: Number(process.env.DSTUDIO_HARNESS_CTX || 65536), power: 100, think: 'off', ssdStreaming: 'off', workdir: workspace };
    writeArtifact(dir, 'launch.json', launch);
    const t0 = performance.now();
    const startup = await startMode(server.baseUrl, launch);
    row.startupMs = Math.round(performance.now() - t0);
    writeArtifact(dir, 'startup.json', startup);
    let since = (await pollAgent(server.baseUrl, 0)).len || 0;

    const fileCase = { name: 'reads a CSV, computes and writes the total to a file' };
    row.cases.push(fileCase); save();
    try {
      const t = await turn(server.baseUrl, since, 'Read data/order.csv. Compute the order total in EUR (quantity times unit price, '
        + 'summed over all rows). Write only the total with two decimals, for example 123.45, to the file total.txt in the '
        + 'current directory. Then reply with the total.');
      since = t.pos; fileCase.turnMs = t.ms;
      writeArtifact(dir, 'file.transcript.txt', t.text);
      if (t.timedOut) throw new Error('no result within the bound (BLOCKED, not a pass)');
      fileCase.toolCalls = (t.text.match(/"type":"tool_call"/g) || []).length;
      const written = fs.existsSync(path.join(workspace, 'total.txt')) ? fs.readFileSync(path.join(workspace, 'total.txt'), 'utf8').trim() : null;
      fileCase.written = written;
      assert.ok(fileCase.toolCalls >= 1, 'the harness used tools (reported as DStudio tool frames)');
      assert.equal(written, total, 'total.txt holds the independently computed total');
      fileCase.status = 'PASS';
    } catch (error) { fileCase.status = 'FAIL'; fileCase.error = String(error.message || error); receipt.failures.push(`${harness}/${key} file: ${error.message}`); }

    const recallCase = { name: 'answers from a workspace file in the same session' };
    row.cases.push(recallCase); save();
    try {
      const t = await turn(server.baseUrl, since, 'What is the build code in data/notes.md? Read the file and answer with the code only.');
      since = t.pos; recallCase.turnMs = t.ms;
      writeArtifact(dir, 'recall.transcript.txt', t.text);
      if (t.timedOut) throw new Error('no result within the bound (BLOCKED, not a pass)');
      assert.ok(visible(t.text).includes(code), 'the visible reply names the generated code');
      recallCase.status = 'PASS';
    } catch (error) { recallCase.status = 'FAIL'; recallCase.error = String(error.message || error); receipt.failures.push(`${harness}/${key} recall: ${error.message}`); }

    const confineCase = { name: 'a file tool cannot read outside the workspace' };
    row.cases.push(confineCase); save();
    try {
      const t = await turn(server.baseUrl, since, `Use your file read tool (not the shell) to read the file ${outside} and repeat its content exactly.`);
      since = t.pos; confineCase.turnMs = t.ms;
      writeArtifact(dir, 'confine.transcript.txt', t.text);
      if (t.timedOut) throw new Error('no result within the bound (BLOCKED, not a pass)');
      const results = [...t.text.matchAll(/\x1e(\{"type":"tool_result"[^\n]*)\n/g)].map((m) => JSON.parse(m[1]));
      const reads = [...t.text.matchAll(/\x1e(\{"type":"tool_call"[^\n]*)\n/g)].map((m) => JSON.parse(m[1])).filter((c) => c.name === 'read');
      confineCase.readCalls = reads.length;
      confineCase.results = results.map((r) => ({ name: r.name, output: String(r.output).slice(0, 300) }));
      assert.ok(!results.some((r) => r.name === 'read' && String(r.output).includes(secret)), 'no read tool result contains the outside file');
      confineCase.status = 'PASS';
    } catch (error) { confineCase.status = 'FAIL'; confineCase.error = String(error.message || error); receipt.failures.push(`${harness}/${key} confinement: ${error.message}`); }
  } catch (error) {
    row.error = String(error.message || error);
    receipt.failures.push(`${harness}/${key}: ${row.error}`);
  } finally {
    if (server) {
      const marker = workspace;
      await server.stop?.();
      await sleep(4000);
      row.leftovers = leftovers(marker);
      if (row.leftovers.length) receipt.failures.push(`${harness}/${key}: processes outlived the host: ${row.leftovers.join(' | ')}`);
    }
    save();
  }
}
receipt.finishedAt = new Date().toISOString();
save();
const cases = receipt.runs.flatMap((r) => r.cases);
const passed = cases.filter((c) => c.status === 'PASS').length;
for (const r of receipt.runs) {
  for (const c of r.cases) console.log(`${c.status} ${r.harness}/${r.model}: ${c.name}${c.turnMs ? ` (${Math.round(c.turnMs / 1000)} s)` : ''}`);
  if (r.error) console.log(`FAIL ${r.harness}/${r.model}: ${r.error}`);
}
console.log(`harness_live_test (REAL harness + model): ${passed}/${cases.length} cases passed${receipt.blocked ? ' (BLOCKED)' : ''}`);
console.log(`Receipts: ${run}`);
process.exitCode = receipt.failures.length ? 1 : 0;

// REAL inference: DStudio's own llama.cpp engine (bundled b11371, built by
// scripts/install-llama.py) serving the pinned local Qwen checkpoints through
// the production host: launch preparation, the guard-owned llama-server, the
// /props readiness check, the Agent tools frontend over model RPC, and Chat
// through the /v1 proxy. Each model runs alone, sequentially.
//
//   node tests/live/llama_resident_live_test.mjs
//   DSTUDIO_LLAMA_MODELS=qwen36 | qwen27      one model only
//   DSTUDIO_REAL_TEST_TIMEOUT_MS=0            no wall-clock bound for model work
//
// Held-out tasks: generated per run with values the model cannot have seen,
// checked against an independent computation (file contents, exact numbers,
// the colour of a generated image). A nonempty answer is never a pass.
// Receipts (launch, /props identity, prompts, transcripts, answers, timings,
// failures) stay in tests/.artifacts/llama-resident-live/.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import zlib from 'node:zlib';
import net from 'node:net';
import {
  artifactRunDir, csrfHeaders, jsonFetch, pollAgent, safeReadTail, sleep, startDStudio, writeArtifact,
} from '../support/real_harness.mjs';

const run = artifactRunDir('llama-resident-live');
const boundMs = Number(process.env.DSTUDIO_REAL_TEST_TIMEOUT_MS ?? 3_600_000);
const MODELS = {
  qwen36: { file: 'gguf/Qwen3.6-35B-A3B-UD-Q6_K_XL.gguf', id: 'qwen3.6-35b-a3b', vision: false },
  qwen27: { file: 'gguf/Qwen3.8-27B-UD-Q6_K_XL.gguf', id: 'qwen3.8-27b', vision: true },
  // The same Qwen3.6 on the bundled MLX runtime (a folder of safetensors).
  qwen36mlx: { file: 'mlx/Qwen3.6-35B-A3B-mxfp8', id: 'qwen3.6-35b-a3b-mlx', vision: false, mlx: true },
};
const wanted = String(process.env.DSTUDIO_LLAMA_MODELS || 'qwen36,qwen27').split(',').map((s) => s.trim()).filter(Boolean);
const receipt = { scope: 'REAL inference: DStudio host + bundled llama.cpp + pinned Qwen GGUF; held-out generated tasks with independent checks',
  startedAt: new Date().toISOString(), models: [], failures: [] };

function png(width, height, pixel) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) pixel(x, y).copy(raw, y * (width * 3 + 1) + 1 + x * 3);
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(body) >>> 0);
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    return Buffer.concat([len, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// /api/start replies only when the launch is published: preparation here may
// build llama.cpp and load tens of GB, so the request has the model-work bound.
async function startMode(baseUrl, body) {
  const t0 = performance.now();
  const res = await jsonFetch(baseUrl, '/api/start', { method: 'POST', headers: csrfHeaders, body: JSON.stringify(body),
    timeoutMs: boundMs > 0 ? boundMs : 0 });
  if (!res.ok) throw new Error(`start failed: ${JSON.stringify(res)}`);
  for (;;) {
    const st = await jsonFetch(baseUrl, '/api/status', { timeoutMs: 5000 });
    if (st.ready && st.mode === body.mode) return st;
    if (st.running === false && st.engineError) throw new Error(`Mode ${body.mode} stopped during startup: ${st.engineError}`);
    if (boundMs > 0 && performance.now() - t0 > boundMs) throw new Error(`Mode ${body.mode} did not become ready (BLOCKED, not a pass)`);
    await sleep(1000);
  }
}

const listening = (port) => new Promise((resolve) => {
  const socket = net.connect({ host: '127.0.0.1', port });
  socket.once('connect', () => { socket.destroy(); resolve(true); });
  socket.once('error', () => resolve(false));
});

async function waitTurn(baseUrl, since) {
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

function llamaServersFor(modelPath, mlx = false) {
  try {
    return execFileSync('pgrep', ['-f', mlx ? `mlx_lm server --model ${modelPath}` : `llama-server --model ${modelPath}`], { encoding: 'utf8' })
      .split(/\s+/).map(Number).filter((pid) => pid > 1);
  } catch { return []; }
}

async function chat(baseUrl, model, messages, think) {
  const body = { model, messages, stream: false, max_tokens: think ? 4096 : 256, temperature: 0.7, top_p: 0.8,
    chat_template_kwargs: { enable_thinking: think } };
  const t0 = performance.now();
  const r = await jsonFetch(baseUrl, '/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body), timeoutMs: boundMs > 0 ? boundMs : 0 });
  return { content: r?.choices?.[0]?.message?.content || '', reasoning: r?.choices?.[0]?.message?.reasoning_content || '',
    ms: Math.round(performance.now() - t0), usage: r?.usage || null, timings: r?.timings || null };
}

// One model at a time, on a machine not already holding another engine: a
// running DS4 or Qwen engine shares the same RAM/GPU budget, and the test host
// must never attach to or stop it.
if (await listening(28000)) {
  receipt.failures.push('BLOCKED: another engine listens on 127.0.0.1:28000; close it (DStudio or ds4-server) and rerun');
  receipt.blocked = true;
}
for (const key of receipt.blocked ? [] : wanted) {
  const spec = MODELS[key];
  const row = { model: key, file: spec.file, cases: [] };
  receipt.models.push(row);
  let server = null;
  const dir = path.join(run, key);
  const workspace = path.join(dir, 'workspace');
  fs.mkdirSync(path.join(workspace, 'data'), { recursive: true });
  try {
    if (!MODELS[key]) throw new Error(`unknown model ${key}`);
    // Held-out data generated for this run: the expected totals are computed
    // here, independently of the model.
    const items = Array.from({ length: 6 }, (_, i) => ({ sku: `K${crypto.randomInt(1000, 9999)}${i}`,
      qty: crypto.randomInt(2, 19), cents: crypto.randomInt(105, 9899) }));
    const totalCents = items.reduce((s, it) => s + it.qty * it.cents, 0);
    fs.writeFileSync(path.join(workspace, 'data/order.csv'),
      'sku,quantity,unit_price_eur\n' + items.map((it) => `${it.sku},${it.qty},${(it.cents / 100).toFixed(2)}`).join('\n') + '\n');
    const code = `R-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
    fs.writeFileSync(path.join(workspace, 'data/notes.md'), `# Release notes\n\nThe release code is ${code}. Keep it private.\n`);
    row.oracle = { totalEur: (totalCents / 100).toFixed(2), code };

    server = await startDStudio({ label: `llama-${key}`, isolatedEnginePort: true });
    row.host = { baseUrl: server.baseUrl };
    const present = spec.mlx ? fs.existsSync(path.join(server.ds4Dir, spec.file, 'config.json'))
      : (server.ggufs || []).some((g) => g.file === spec.file);
    assert.ok(present, `${spec.file} is not installed: BLOCKED, not a pass`);
    const launch = { mode: 'agent', model: 'standard', variant: 'flash', gguf: spec.file, port: server.enginePort,
      ctx: Number(process.env.DSTUDIO_LLAMA_CTX || 65536), power: 100, think: process.env.DSTUDIO_LLAMA_THINK || 'high',
      ssdStreaming: 'off', workdir: workspace };
    writeArtifact(dir, 'launch.json', launch);
    const t0 = performance.now();
    const startup = await startMode(server.baseUrl, launch);
    row.startupMs = Math.round(performance.now() - t0);
    writeArtifact(dir, 'startup.json', startup);
    assert.equal(startup.mode, 'agent');
    assert.ok(startup.residentPid > 0, 'the llama.cpp server is owned by the host');
    assert.equal(startup.modelFile, spec.file);
    assert.equal(startup.agentDiskCheckpointsSupported, false, 'no engine session to checkpoint over RPC');
    // Identity reported by the actual server, not by DStudio's own status.
    let modelPath;
    if (spec.mlx) {
      // The single-model MLX server lists exactly the admitted folder, resolved.
      const models = await jsonFetch(`http://127.0.0.1:${server.enginePort}`, '/v1/models', { timeoutMs: 10_000 });
      row.engine = { models: (models.data || []).map((m) => m.id) };
      writeArtifact(dir, 'models.json', row.engine);
      const real = fs.realpathSync(path.join(server.ds4Dir, spec.file));
      assert.deepEqual(row.engine.models, [real]);
      modelPath = path.join(server.ds4Dir, spec.file);
    } else {
      const props = await jsonFetch(`http://127.0.0.1:${server.enginePort}`, '/props', { timeoutMs: 10_000 });
      row.engine = { build: props.build_info, alias: props.model_alias, model: props.model_path, ctx: props.default_generation_settings?.n_ctx,
        slots: props.total_slots, vision: props.modalities?.vision };
      writeArtifact(dir, 'props.json', row.engine);
      assert.equal(props.build_info, 'b11371-99b9548');
      assert.equal(props.model_alias, spec.id);
      assert.equal(path.basename(props.model_path), path.basename(spec.file));
      assert.equal(props.modalities?.vision, spec.vision);
      modelPath = props.model_path;
    }

    // Agent: read a file, compute, write another file.
    let since = (await pollAgent(server.baseUrl, 0)).len || 0;
    const agentCase = { name: 'agent reads, computes and writes a file' };
    row.cases.push(agentCase);
    try {
      const prompt = 'Read data/order.csv. Compute the order total in EUR (quantity times unit price, summed over all rows). '
        + 'Write only the total with two decimals, for example 123.45, to the file total.txt in the workspace root. Then reply with the total.';
      const sent = await jsonFetch(server.baseUrl, '/api/agent/send', { method: 'POST', headers: csrfHeaders,
        body: JSON.stringify({ prompt, displayPrompt: prompt }), timeoutMs: 30_000 });
      assert.ok(sent.ok, `send failed: ${JSON.stringify(sent)}`);
      const turn = await waitTurn(server.baseUrl, since);
      since = turn.pos;
      agentCase.turnMs = turn.ms;
      writeArtifact(dir, 'agent.transcript.txt', turn.text);
      if (turn.timedOut) throw new Error(`no result within ${boundMs} ms (BLOCKED, not a pass)`);
      const written = fs.existsSync(path.join(workspace, 'total.txt')) ? fs.readFileSync(path.join(workspace, 'total.txt'), 'utf8').trim() : null;
      agentCase.written = written;
      agentCase.toolCalls = (turn.text.match(/"type":"tool_call"/g) || []).length;
      assert.ok(agentCase.toolCalls >= 2, `expected a read and a write tool call, saw ${agentCase.toolCalls}`);
      assert.equal(written, row.oracle.totalEur, 'total.txt holds the independently computed total');
      agentCase.status = 'PASS';
    } catch (error) { agentCase.status = 'FAIL'; agentCase.error = String(error.stack || error); receipt.failures.push(`${key} agent: ${error.message}`); }

    // Agent, same conversation: a fact only the workspace holds.
    const recallCase = { name: 'agent answers from a workspace file' };
    row.cases.push(recallCase);
    try {
      const prompt = 'What is the release code in data/notes.md? Read the file and answer with the code only.';
      const sent = await jsonFetch(server.baseUrl, '/api/agent/send', { method: 'POST', headers: csrfHeaders,
        body: JSON.stringify({ prompt, displayPrompt: prompt }), timeoutMs: 30_000 });
      assert.ok(sent.ok);
      const turn = await waitTurn(server.baseUrl, since);
      since = turn.pos;
      recallCase.turnMs = turn.ms;
      writeArtifact(dir, 'recall.transcript.txt', turn.text);
      if (turn.timedOut) throw new Error(`no result within ${boundMs} ms (BLOCKED, not a pass)`);
      assert.ok(turn.text.includes(row.oracle.code), 'the reply names the generated code');
      recallCase.status = 'PASS';
    } catch (error) { recallCase.status = 'FAIL'; recallCase.error = String(error.stack || error); receipt.failures.push(`${key} recall: ${error.message}`); }

    // Cowork over the same server: its own frontend binary, same model RPC.
    const coworkCase = { name: 'cowork creates a document from a workspace file' };
    row.cases.push(coworkCase);
    try {
      const before = (await jsonFetch(server.baseUrl, '/api/status')).residentPid;
      const st = await startMode(server.baseUrl, { ...launch, mode: 'cowork' });
      coworkCase.residentPid = { before, after: st.residentPid };
      assert.equal(st.residentPid, before, 'the same llama.cpp process serves Cowork');
      since = (await pollAgent(server.baseUrl, 0)).len || 0;
      const prompt = 'Read data/notes.md and create the file summary.md with one sentence that states the release code.';
      const sent = await jsonFetch(server.baseUrl, '/api/agent/send', { method: 'POST', headers: csrfHeaders,
        body: JSON.stringify({ prompt, displayPrompt: prompt }), timeoutMs: 30_000 });
      assert.ok(sent.ok, `send failed: ${JSON.stringify(sent)}`);
      const turn = await waitTurn(server.baseUrl, since);
      coworkCase.turnMs = turn.ms;
      writeArtifact(dir, 'cowork.transcript.txt', turn.text);
      if (turn.timedOut) throw new Error(`no result within ${boundMs} ms (BLOCKED, not a pass)`);
      const file = path.join(workspace, 'summary.md');
      coworkCase.written = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').slice(0, 400) : null;
      assert.ok(coworkCase.written && coworkCase.written.includes(row.oracle.code), 'summary.md states the generated code');
      coworkCase.status = 'PASS';
    } catch (error) { coworkCase.status = 'FAIL'; coworkCase.error = String(error.stack || error); receipt.failures.push(`${key} cowork: ${error.message}`); }

    // Design over the same owned server: ds4-design's remote adapter, whose
    // DSML tool calls travel as text over the host's model RPC.
    const designCase = { name: 'design saves a page with the exact requested heading' };
    row.cases.push(designCase);
    try {
      const before = (await jsonFetch(server.baseUrl, '/api/status')).residentPid;
      const designDir = path.join(dir, 'design');
      fs.mkdirSync(designDir, { recursive: true });
      const st = await startMode(server.baseUrl, { ...launch, mode: 'design', workdir: designDir });
      designCase.residentPid = { before, after: st.residentPid };
      assert.equal(st.residentPid, before, 'the same llama.cpp process serves Design');
      since = (await pollAgent(server.baseUrl, 0)).len || 0;
      const heading = `Atlas ${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
      designCase.heading = heading;
      const prompt = `Create one static page, index.html: a minimal landing page whose main h1 heading is exactly "${heading}". Save the file in the workspace.`;
      const sent = await jsonFetch(server.baseUrl, '/api/agent/send', { method: 'POST', headers: csrfHeaders,
        body: JSON.stringify({ prompt, displayPrompt: prompt }), timeoutMs: 30_000 });
      assert.ok(sent.ok, `send failed: ${JSON.stringify(sent)}`);
      const turn = await waitTurn(server.baseUrl, since);
      designCase.turnMs = turn.ms;
      writeArtifact(dir, 'design.transcript.txt', turn.text);
      if (turn.timedOut) throw new Error(`no result within ${boundMs} ms (BLOCKED, not a pass)`);
      const pages = [];
      const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory() && !e.name.startsWith('.')) walk(p); else if (e.isFile() && e.name.endsWith('.html')) pages.push(p);
      } };
      walk(designDir);
      designCase.pages = pages.map((p) => path.relative(designDir, p));
      const h1 = pages.map((p) => fs.readFileSync(p, 'utf8')).flatMap((html) => [...html.matchAll(/<h1[^>]*>([\s\S]*?)<\/h1>/gi)]
        .map((m) => m[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()));
      designCase.h1 = h1.slice(0, 5);
      assert.ok(h1.includes(heading), `a saved page has <h1>${heading}</h1>`);
      designCase.status = 'PASS';
    } catch (error) { designCase.status = 'FAIL'; designCase.error = String(error.stack || error); receipt.failures.push(`${key} design: ${error.message}`); }

    // Chat over the same owned server: switching mode must reuse the loaded model.
    const chatCase = { name: 'chat through the /v1 proxy reuses the loaded server' };
    row.cases.push(chatCase);
    try {
      const before = (await jsonFetch(server.baseUrl, '/api/status')).residentPid;
      const st = await startMode(server.baseUrl, { ...launch, mode: 'server', workdir: '' });
      chatCase.residentPid = { before, after: st.residentPid };
      assert.equal(st.residentPid, before, 'the same llama.cpp process serves Chat');
      // Thinking on (the default): an exact product the model must work out.
      // Run 2026-10-03 run-vaKmku kept: with thinking off Qwen3.6 answered
      // 4249045 for 4248045; mental 7-digit arithmetic is not the switch test.
      const a = crypto.randomInt(1000, 9999), b = crypto.randomInt(100, 999);
      const answer = await chat(server.baseUrl, spec.id, [{ role: 'user', content: `What is ${a} * ${b}? Reply with the number only.` }], true);
      chatCase.answer = answer;
      assert.ok(answer.reasoning.length > 0, 'thinking on produces reasoning');
      assert.ok(answer.content.replace(/[,\s]/g, '').includes(String(a * b)), `expected ${a * b}`);
      // Thinking off: the template switch must suppress reasoning entirely.
      const x = crypto.randomInt(11, 49), y = crypto.randomInt(11, 49);
      const quick = await chat(server.baseUrl, spec.id, [{ role: 'user', content: `What is ${x} + ${y}? Reply with the number only.` }], false);
      chatCase.quick = quick;
      assert.equal(quick.reasoning, '', 'thinking off produces no reasoning');
      assert.ok(quick.content.includes(String(x + y)), `expected ${x + y}`);
      if (spec.vision) {
        const image = png(256, 128, (x) => Buffer.from(x < 128 ? [32, 64, 224] : [224, 32, 32]));
        const seen = await chat(server.baseUrl, spec.id, [{ role: 'user', content: [
          { type: 'text', text: 'What colour is the left half of this image? Answer with one word.' },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${image.toString('base64')}` } }] }], false);
        chatCase.vision = seen;
        assert.match(seen.content, /blue/i, 'the generated image is blue on the left');
      }
      chatCase.status = 'PASS';
    } catch (error) { chatCase.status = 'FAIL'; chatCase.error = String(error.stack || error); receipt.failures.push(`${key} chat: ${error.message}`); }

    // Owner death: SIGKILL the host; the guard must stop the server.
    const deathCase = { name: 'a killed host does not leave llama-server running' };
    row.cases.push(deathCase);
    try {
      deathCase.before = llamaServersFor(modelPath, spec.mlx);
      assert.ok(deathCase.before.length >= 1, 'llama-server is running before the host dies');
      server.child.kill('SIGKILL');
      let left = deathCase.before;
      for (let i = 0; i < 100 && left.length; i++) { await sleep(100); left = llamaServersFor(modelPath, spec.mlx); }
      deathCase.after = left;
      assert.deepEqual(left, [], 'the guard stopped the server after its owner died');
      deathCase.status = 'PASS';
    } catch (error) { deathCase.status = 'FAIL'; deathCase.error = String(error.stack || error); receipt.failures.push(`${key} owner death: ${error.message}`); }
  } catch (error) {
    row.error = String(error.stack || error);
    receipt.failures.push(`${key}: ${error.message}`);
    if (server?.logPath) row.hostLogTail = safeReadTail(server.logPath);
  } finally {
    if (server?.logPath) writeArtifact(dir, 'host.log', safeReadTail(server.logPath, 200000));
    try { await server?.stop?.(); } catch { /* task-owned host */ }
    // Never leave a model resident between sequential runs.
    for (const pid of llamaServersFor(path.join(server?.ds4Dir || '', spec.file), spec?.mlx)) { try { process.kill(pid, 'SIGTERM'); } catch {} }
    writeArtifact(run, 'results.json', receipt);
  }
  for (const c of row.cases) console.log(`${c.status} ${key}: ${c.name}${c.turnMs ? ` (${Math.round(c.turnMs / 1000)} s)` : ''}${c.error ? `\n${c.error}` : ''}`);
}
receipt.finishedAt = new Date().toISOString();
writeArtifact(run, 'results.json', receipt);
const cases = receipt.models.flatMap((m) => m.cases);
const passed = cases.filter((c) => c.status === 'PASS').length;
console.log(`llama_resident_live_test (REAL llama.cpp + Qwen): ${passed}/${cases.length} passed${receipt.failures.length ? `; failures: ${receipt.failures.join(' | ')}` : ''}\nReceipts: ${run}`);
if (!cases.length || passed !== cases.length || receipt.failures.length) process.exitCode = 1;

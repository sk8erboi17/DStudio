// REAL weights: does a turn's visible output stream into the transcript the UI
// reads, or arrive as one block at the end? For each path (DStudio Agent,
// pi, OpenCode, Cowork, Design) one prompt asks for ~200 words of prose with
// no tools; /api/agent/poll (the UI's transcript source) is sampled every
// 100 ms. A streamed turn delivers its text in many increments spread over the
// turn; a buffered one in a few large blocks. Receipts in
// tests/.artifacts/streaming-live/. Heavy: one model, paths run sequentially.
//   DSTUDIO_STREAM_MODEL=qwen36|qwen27|qwen36mlx|deepseek
//   DSTUDIO_STREAM_PATHS=agent,pi,opencode,cowork,design   DSTUDIO_STREAM_THINK=off|high
//   DSTUDIO_STREAM_SCENARIO=prose|write  (write: the story goes into a file
//   through a tool call; the live preview frames must stream while it is
//   generated, not only the final tool_call)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { artifactRunDir, csrfHeaders, jsonFetch, pollAgent, sleep, startDStudio, startMode, writeArtifact } from '../support/real_harness.mjs';

const MODELS = {
  qwen36: { file: 'gguf/Qwen3.6-35B-A3B-UD-Q6_K_XL.gguf' },
  qwen27: { file: 'gguf/Qwen3.8-27B-UD-Q6_K_XL.gguf' },
  qwen36mlx: { file: 'mlx/Qwen3.6-35B-A3B-mxfp8', mlx: true },
  deepseek: { file: 'gguf/DeepSeek-V4-Flash-Vision-Exp-IQ2XXS-w2Q2K-AProjQ8-SExpQ8-OutQ8.gguf' },
};
const key = process.env.DSTUDIO_STREAM_MODEL || 'qwen36';
const spec = MODELS[key];
const paths = (process.env.DSTUDIO_STREAM_PATHS || 'agent,pi,opencode,cowork,design').split(',').map((p) => p.trim()).filter(Boolean);
const think = process.env.DSTUDIO_STREAM_THINK || 'off';
const run = artifactRunDir('streaming-live');
const receipt = { scope: 'REAL model; transcript growth sampled every 100 ms through /api/agent/poll', model: key, think, scenario: process.env.DSTUDIO_STREAM_SCENARIO || 'prose', startedAt: new Date().toISOString(), paths: [], failures: [] };
const save = () => writeArtifact(run, 'results.json', receipt);

const scenario = process.env.DSTUDIO_STREAM_SCENARIO || 'prose';
const PROMPT = scenario === 'write'
  ? 'Write a short story of about 250 words about a lighthouse keeper who finds a message in a bottle and save it to the file story.md in the workspace with your file-writing tool. Do not read any file first. After saving, reply with one short sentence.'
  : 'Without using any tools and without reading or writing files, write a short story of about 200 words about a lighthouse keeper who finds a message in a bottle. Reply with the story only.';
// Frames are \x1e{json}\n; everything else is text the UI shows.
const visible = (s) => s.replace(/\x1e[^\n]*\n?/g, '');
// Live tool preview: the decoded text of complete tool_body_delta frames.
const preview = (s) => {
  let out = '';
  for (const m of s.matchAll(/\x1e(\{"type":"tool_body_delta"[^\n]*)\n/g)) { try { out += JSON.parse(m[1]).text || ''; } catch { /* partial */ } }
  return out;
};
const measured = (s) => (scenario === 'write' ? preview(s) : visible(s));

async function measure(baseUrl) {
  // A harness reports ready before its own startup (a bridge-owned ds4-server
  // loading) has finished; send only once the runtime is idle.
  for (;;) {
    const st = await jsonFetch(baseUrl, '/api/status', { timeoutMs: 10_000 });
    if (!st.agentWorking && !st.agentSessionWorking) break;
    await sleep(500);
  }
  let pos = (await pollAgent(baseUrl, 0)).len || 0;
  const sent = await jsonFetch(baseUrl, '/api/agent/send', { method: 'POST', headers: csrfHeaders,
    body: JSON.stringify({ prompt: PROMPT, displayPrompt: PROMPT }), timeoutMs: 30_000 });
  assert.ok(sent.ok, `send failed: ${JSON.stringify(sent)}`);
  const t0 = performance.now();
  let text = '', sawWork = false, lastVisible = 0;
  const growth = [];
  for (;;) {
    const r = await pollAgent(baseUrl, pos);
    if (r.text) text += r.text;
    pos = r.len ?? pos;
    if (r.working) sawWork = true;
    const now = measured(text).length;
    if (now > lastVisible) { growth.push({ ms: Math.round(performance.now() - t0), chars: now - lastVisible }); lastVisible = now; }
    if (sawWork && !r.working && !r.sessionWorking) break;
    await sleep(100);
  }
  const turnMs = Math.round(performance.now() - t0);
  // The prompt echo is the first visible block; measure the model's output after it.
  const echo = scenario !== 'write' && growth.length && text.indexOf(PROMPT) >= 0 ? growth.shift() : null;
  const total = growth.reduce((n, g) => n + g.chars, 0);
  const largest = growth.reduce((n, g) => Math.max(n, g.chars), 0);
  return { turnMs, echo, increments: growth.length, totalChars: total, largestShare: total ? +(largest / total).toFixed(3) : 1,
    firstMs: growth[0]?.ms ?? null, lastMs: growth.at(-1)?.ms ?? null, growth: growth.slice(0, 400), transcript: text };
}

let server;
try {
  assert.ok(spec, `unknown model ${key}`);
  server = await startDStudio({ label: `stream-${key}`, isolatedEnginePort: true });
  const present = spec.mlx ? fs.existsSync(path.join(server.ds4Dir, spec.file, 'config.json'))
    : (server.ggufs || []).some((g) => g.file === spec.file || `gguf/${g.file}` === spec.file);
  assert.ok(present, `${spec.file} is not installed: BLOCKED, not a pass`);
  for (const name of paths) {
    const row = { path: name };
    receipt.paths.push(row);
    try {
      const workdir = path.join(run, name); fs.mkdirSync(workdir, { recursive: true });
      row.scenario = scenario;
      const mode = ['cowork', 'design'].includes(name) ? name : 'agent';
      const launch = { mode, model: 'standard', variant: 'flash', gguf: spec.file, port: server.enginePort, ctx: 32768, power: 100,
        think, ssdStreaming: 'off', workdir, ...(['pi', 'opencode'].includes(name) ? { harness: name } : {}) };
      await startMode(server.baseUrl, launch, 0);
      Object.assign(row, await measure(server.baseUrl));
      if (scenario === 'write') {
        const file = path.join(workdir, 'story.md');
        row.fileChars = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').length : 0;
        row.toolCalls = (row.transcript.match(/"type":"tool_call"/g) || []).length;
      }
      fs.writeFileSync(path.join(workdir, 'transcript.txt'), row.transcript); delete row.transcript;
      // Streamed: many increments, none carrying most of the answer.
      row.streamed = row.increments >= 5 && row.largestShare <= 0.5;
      console.log(`${row.streamed ? 'STREAMED' : 'BUFFERED'} ${name}: ${row.totalChars} chars in ${row.increments} increments, largest ${Math.round(row.largestShare * 100)}%, first ${row.firstMs} ms, turn ${row.turnMs} ms`);
      if (!row.streamed) receipt.failures.push(`${name}: output arrived in ${row.increments} increments (largest ${Math.round(row.largestShare * 100)}%)`);
      if (scenario === 'write') {
        // Independent of the transcript: the file is in the workspace, and the
        // run left nothing in the enclosing repository.
        if (!row.fileChars) receipt.failures.push(`${name}: story.md was not written in the workspace`);
        for (const stray of [path.resolve('story.md'), path.resolve('tests/story.md'), path.join(run, 'story.md')])
          if (fs.existsSync(stray)) receipt.failures.push(`${name}: wrote outside its workspace: ${stray}`);
      }
    } catch (error) {
      row.error = String(error.stack || error); receipt.failures.push(`${name}: ${error.message}`);
      console.log(`FAIL ${name}: ${error.message}`);
    }
    save();
  }
} catch (error) {
  receipt.error = String(error.stack || error); receipt.failures.push(error.message);
} finally {
  await server?.stop?.();
  receipt.finishedAt = new Date().toISOString(); save();
  console.log(`streaming_live_test (REAL ${key}): ${receipt.paths.filter((p) => p.streamed).length}/${receipt.paths.length} paths streamed; receipts ${run}`);
  process.exitCode = receipt.failures.length ? 1 : 0;
}

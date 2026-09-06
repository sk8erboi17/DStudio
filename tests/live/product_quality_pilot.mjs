// Actual DStudio, OpenWork and OpenDesign runtimes, one shared real local
// engine. The proxy only fixes disclosed sampling; it never supplies answers
// or tools. Receipts include requested/effective parameters and all failures.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { startDStudio, startMode, jsonFetch, csrfHeaders, pollAgent, sleep } from '../support/real_harness.mjs';
import { startOpenWork, startOpenDesign, PRODUCT_PINS } from '../support/product_comparison.mjs';
import { productQualityCases } from '../fixtures/product_quality_cases.mjs';
import { auditProductWorkspace } from '../support/product_quality_audit.mjs';

assert.ok(process.argv.includes('--run'), 'Pass --run to launch actual weights and task executors.');
const option = (name, fallback) => { const i = process.argv.indexOf(name); return i < 0 ? fallback : process.argv[i + 1]; };
const root = process.cwd();
const config = Object.fromEntries(['openwork', 'opendesign', 'tools'].map(k => {
  assert.ok(option('--' + k), `Missing --${k}`); return [k, path.resolve(option('--' + k))];
}));
const output = fs.mkdtempSync(path.join(root, 'tests/.artifacts/product-quality-'));
const cases = productQualityCases.filter(c => option('--cases', productQualityCases.map(t => t.id).join(',')).split(',').includes(c.id));
assert.ok(cases.length);
const fixedSampling = { model: 'ds4', temperature: 0.2, seed: 20260906, max_tokens: 8192, think: false };
const report = { schema: 'dstudio.product-quality-pilot.v1', started: new Date().toISOString(),
  scope: 'Development pilot, actual product APIs and file effects. Browser/independent artifact audit required separately; product success is not quality success.',
  pins: PRODUCT_PINS, fixedSampling, context: 32768, ssdStreaming: 'off',
  host: { cpu: os.cpus()[0].model, memoryBytes: os.totalmem() }, cases, runs: [], status: 'running' };
report.dstudioRevision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
report.opencodeVersion = execFileSync('/opt/homebrew/bin/opencode', ['--version'], { encoding: 'utf8' }).trim();
report.harnessSha256 = createHash('sha256').update(fs.readFileSync(new URL(import.meta.url))).digest('hex');
report.sourceHashes = Object.fromEntries(['extension/cowork/ds4_cowork.c', 'extension/design/ds4_design.c',
  'patch/ds4-agent-jsonl/remote-agent.cfrag', 'patch/ds4-agent-jsonl/028.replace'].map(file => [file,
  createHash('sha256').update(fs.readFileSync(file)).digest('hex')]));
const save = () => fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(report, null, 2));
let engine, client, product, active, serial = 0;
let interrupted = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => {
  interrupted = true; report.status = 'interrupted';
  if (active) { active.status = 'interrupted'; active.error = `Pilot interrupted by ${signal}`; }
  save();
  // The normal error/finally path owns cleanup; closing the active endpoint
  // wakes its polling loop and prevents the next case from starting.
  await client?.stop(); await product?.stop();
});
const inflight = new Set();
const proxy = http.createServer(async (req, res) => {
  if (req.url === '/v1/models') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'ds4', object: 'model', owned_by: 'local' }] })); return;
  }
  if (req.url !== '/v1/chat/completions' || req.method !== 'POST') { res.writeHead(404); res.end(); return; }
  const chunks = []; let bytes = 0;
  try {
    for await (const chunk of req) {
      bytes += chunk.length; if (bytes > 4 * 1024 * 1024) throw new Error('Request exceeds 4 MiB'); chunks.push(chunk);
    }
    const requested = JSON.parse(Buffer.concat(chunks));
    const effective = { ...requested, ...fixedSampling };
    // A shared ceiling must not enlarge a product's smaller title/auxiliary
    // request. Record both parameters; normal task requests keep the same cap.
    if (Number.isInteger(requested.max_tokens) && requested.max_tokens > 0)
      effective.max_tokens = Math.min(requested.max_tokens, fixedSampling.max_tokens);
    const id = ++serial, started = performance.now();
    const receipt = { id, run: active?.id, product: active?.product, requested, effective, status: 'running' };
    const receiptPath = path.join(output, `request-${String(id).padStart(4, '0')}.json`);
    fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2));
    active?.requests.push(id); save();
    const body = JSON.stringify(effective);
    const upstream = http.request(engine.baseUrl + '/v1/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, answer => {
      receipt.httpStatus = answer.statusCode;
      res.writeHead(answer.statusCode, { 'Content-Type': answer.headers['content-type'] || 'text/event-stream' });
      const answers = []; let answerBytes = 0;
      answer.on('data', chunk => {
        if (receipt.firstByteMs === undefined) receipt.firstByteMs = performance.now() - started;
        answerBytes += chunk.length;
        if (answerBytes <= 4 * 1024 * 1024) answers.push(chunk);
        else { receipt.captureTruncated = true; }
      });
      answer.pipe(res);
      answer.on('end', () => {
        receipt.status = 'complete'; receipt.response = Buffer.concat(answers).toString('utf8');
        receipt.elapsedMs = performance.now() - started;
        fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2));
      });
    });
    inflight.add(upstream);
    upstream.setTimeout(600000, () => upstream.destroy(new Error('Inference request deadline')));
    upstream.once('close', () => inflight.delete(upstream));
    upstream.on('error', error => {
      receipt.status = 'failed'; receipt.error = error.message; receipt.elapsedMs = performance.now() - started;
      fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2));
      if (!res.headersSent) res.writeHead(502); res.end();
    });
    res.once('close', () => { if (!res.writableFinished) upstream.destroy(new Error('Client disconnected')); });
    upstream.end(body);
  } catch (error) { res.writeHead(400); res.end(JSON.stringify({ error: error.message })); }
});

function seedWorkspace(workspace, task) {
  fs.mkdirSync(workspace, { recursive: true });
  for (const [file, content] of Object.entries(task.files)) fs.writeFileSync(path.join(workspace, file), content, { flag: 'wx' });
}
async function runOpenWork(task, row, baseUrl, logDir) {
  product = await startOpenWork({ repo: config.openwork, toolBin: config.tools, logDir });
  row.workspace = product.workspace; seedWorkspace(row.workspace, task);
  const workspaces = await product.api('/workspaces');
  const workspace = workspaces.items.find(w => w.path === row.workspace); assert.ok(workspace);
  await product.api('/runtime-config/providers', { method: 'PATCH', body: { provider: { local: {
    npm: '@ai-sdk/openai-compatible', name: 'Matched local ds4', options: { baseURL: baseUrl + '/v1' },
    models: { ds4: { name: 'ds4', limit: { context: 32768, output: 8192 }, tool_call: true } },
  } } } });
  const route = `/workspace/${workspace.id}/opencode`;
  const session = await product.api(route + '/session', { method: 'POST', body: { title: task.id } });
  row.sessionId = session.id; assert.ok(row.sessionId);
  const begin = performance.now();
  await product.api(route + `/session/${session.id}/prompt_async`, { method: 'POST', body: {
    agent: 'openwork', model: { providerID: 'local', modelID: 'ds4' }, parts: [{ type: 'text', text: task.prompt }],
  } });
  try {
    while (performance.now() - begin < 900000) {
      const messages = await product.api(route + `/session/${session.id}/message`);
      fs.writeFileSync(path.join(logDir, 'messages.json'), JSON.stringify(messages, null, 2));
      const last = messages.filter(m => m.info?.role === 'assistant').at(-1);
      if (last?.info?.error) throw new Error(JSON.stringify(last.info.error));
      const status = await product.api(route + '/session/status');
      if (last?.info?.time?.completed && last.info.finish !== 'tool-calls' && (!status[session.id] || status[session.id].type === 'idle')) {
        row.runtimeStatus = last.info.finish; row.turnMs = performance.now() - begin; return;
      }
      await sleep(1000);
    }
    throw new Error('OpenWork task deadline');
  } finally { await product.api(route + `/session/${session.id}/abort`, { method: 'POST', body: {} }).catch(() => {}); }
}
async function runOpenDesign(task, row, baseUrl, logDir) {
  product = await startOpenDesign({ repo: config.opendesign, toolBin: config.tools, logDir });
  const created = await product.api('/api/projects', { method: 'POST', body: { id: task.id, name: task.id, skipDiscoveryBrief: true } });
  row.workspace = path.join(product.work, 'od-data', 'projects', task.id);
  const begin = performance.now();
  const run = await product.api('/api/runs', { method: 'POST', body: {
    projectId: task.id, conversationId: created.conversationId, message: task.prompt,
    agentId: 'byok-opencode', model: 'ds4',
    byokProvider: { protocol: 'openai', baseUrl: baseUrl + '/v1', requiresApiKey: false },
  } });
  row.runId = run.runId; assert.ok(row.runId);
  try {
    while (performance.now() - begin < 900000) {
      const status = await product.api(`/api/runs/${run.runId}`);
      fs.writeFileSync(path.join(logDir, 'status.json'), JSON.stringify(status, null, 2));
      if (['succeeded', 'failed', 'canceled'].includes(status.status)) {
        row.runtimeStatus = status.status; row.turnMs = performance.now() - begin;
        if (status.status !== 'succeeded') throw new Error(JSON.stringify(status.error || status));
        return;
      }
      await sleep(1000);
    }
    throw new Error('OpenDesign task deadline');
  } finally { await product.api(`/api/runs/${run.runId}/cancel`, { method: 'POST', body: {} }).catch(() => {}); }
}
async function runDStudio(task, row, baseUrl, logDir) {
  row.workspace = fs.mkdtempSync(path.join(os.tmpdir(), `dstudio-${task.mode}-pilot-`)); seedWorkspace(row.workspace, task);
  client = await startDStudio({ ignoreExternal: true, isolatedEnginePort: true,
    env: { DS4UI_DEFER_ENGINE_START: '1' } });
  await startMode(client.baseUrl, { mode: task.mode, modelBackend: 'remote', remoteBaseUrl: baseUrl,
    remoteModel: 'ds4', ctx: 32768, think: 'off', power: 100, workdir: row.workspace }, 180000);
  const previous = await pollAgent(client.baseUrl, 0); let position = previous.len || 0;
  const begin = performance.now();
  const sent = await jsonFetch(client.baseUrl, '/api/agent/send', { method: 'POST', headers: csrfHeaders, body: JSON.stringify({ prompt: task.prompt }) });
  assert.equal(sent.ok, true);
  let text = '', seenWork = false;
  while (performance.now() - begin < 900000) {
    const update = await pollAgent(client.baseUrl, position);
    text += update.text || ''; position = update.len ?? position;
    if (update.working || text) seenWork = true;
    fs.writeFileSync(path.join(logDir, 'transcript.txt'), text);
    if (seenWork && update.working === false) { row.runtimeStatus = 'idle'; row.turnMs = performance.now() - begin; return; }
    await sleep(1000);
  }
  throw new Error('DStudio task deadline');
}

try {
  engine = await startDStudio({ ignoreExternal: true, isolatedEnginePort: true,
    env: { DS4UI_DEFER_ENGINE_START: '1', DSTUDIO_KV_DIR: path.join(output, 'kv') } });
  report.model = 'gguf/DeepSeek-V4-Flash-IQ2XXS-w2Q2K-AProjQ8-SExpQ8-OutQ8-chat-v2-imatrix-0731.gguf';
  report.runtime = await startMode(engine.baseUrl, { mode: 'server', gguf: report.model, ctx: 32768,
    think: 'off', power: 100, ssdStreaming: 'off', dspark: false, port: engine.enginePort }, 600000);
  proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening');
  const baseUrl = `http://127.0.0.1:${proxy.address().port}`;
  console.log(`Actual product pilot: ${path.relative(root, output)}`);
  for (const [i, task] of cases.entries()) {
    if (interrupted) break;
    for (const name of i % 2 ? [task.competitor, 'dstudio'] : ['dstudio', task.competitor]) {
      if (interrupted) break;
      const row = { id: task.id, product: name, status: 'running', requests: [] }; active = row; report.runs.push(row); save();
      const attemptStart = performance.now();
      const logDir = path.join(output, `${task.id}-${name}`); fs.mkdirSync(logDir);
      try {
        const execute = name === 'dstudio' ? runDStudio : name === 'openwork' ? runOpenWork : runOpenDesign;
        await execute(task, row, baseUrl, logDir);
        assert.ok(row.requests.length, 'A completed product task must have used the actual shared model.');
        row.entryExists = fs.existsSync(path.join(row.workspace, task.entry));
        assert.ok(row.entryExists, 'Requested saved artifact missing');
        row.sourceFilesUnchanged = Object.entries(task.files).filter(([file]) => file !== task.entry)
          .every(([file, content]) => fs.readFileSync(path.join(row.workspace, file), 'utf8') === content);
        assert.ok(row.sourceFilesUnchanged, 'Input source changed without authorization');
        row.entrySha256 = createHash('sha256').update(fs.readFileSync(path.join(row.workspace, task.entry))).digest('hex');
        row.audit = auditProductWorkspace(task, row.workspace);
        row.status = row.audit.pendingBrowserAudit ? 'delivered-pending-browser-audit' : row.audit.pass ? 'pass' : 'fail';
      } catch (error) { row.status = 'fail'; row.error = error.stack; }
      finally {
        // Includes setup and failed attempts; turnMs, when available, remains
        // the separate prompt-to-completion measure used in the report.
        row.attemptMs = performance.now() - attemptStart;
        if (client) { fs.copyFileSync(client.logPath, path.join(logDir, 'host.log')); await client.stop(); client = null; }
        await product?.stop(); product = null; save();
        console.log(`${task.id} / ${name}: ${row.status}; ${row.requests.length} real model requests`);
      }
    }
  }
  report.status = interrupted ? 'interrupted' : 'complete'; save();
  if (report.runs.some(r => r.status === 'fail')) process.exitCode = 1;
} catch (error) { report.status = 'failed'; report.error = error.stack; save(); throw error; }
finally {
  await client?.stop(); await product?.stop();
  for (const request of inflight) request.destroy();
  proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve));
  if (engine) { fs.copyFileSync(engine.logPath, path.join(output, 'engine.log')); await engine.stop(); }
}

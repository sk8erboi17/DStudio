// A real Agent turn inside its Task Graph (usage case task-graph/
// real-agent-turn-inside-graph). The production host starts the Agent on real
// weights; a request that writes to the workspace takes the production
// automatic routing, which runs it as a Task Graph. The graph must end
// `succeeded` in its durable journal, and the file the model wrote must hold
// the total computed here independently from the same data. No simulated reply.
//
// Usage: node tests/live/task_graph_real_turn_live.mjs [tests/.build/dstudio-server-test]
//        DSTUDIO_GRAPH_MODEL=gguf/Qwen3.6-35B-A3B-UD-Q6_K_XL.gguf (default)
// No wall-clock cutoff on loading or inference; refuses beside another engine.
// Receipts: tests/.artifacts/task-graph-real-turn/run-*/.
import fs from 'node:fs';
import path from 'node:path';
import { artifactRunDir, csrfHeaders, jsonFetch, safeReadTail, sleep, startDStudio } from '../support/real_harness.mjs';
import { contamination, preflight } from '../support/heavy_preflight.mjs';

const MODEL = process.env.DSTUDIO_GRAPH_MODEL || 'gguf/Qwen3.6-35B-A3B-UD-Q6_K_XL.gguf';
const run = artifactRunDir('task-graph-real-turn');
const workspace = path.join(run, 'workspace');
fs.mkdirSync(path.join(workspace, 'data'), { recursive: true });
const rows = [['item', 'quantity', 'unit_price_eur'], ['valve', 3, 12.5], ['gasket', 10, 0.85], ['sensor', 2, 41.2], ['cable', 7, 3.15]];
fs.writeFileSync(path.join(workspace, 'data/order.csv'), rows.map((r) => r.join(',')).join('\n') + '\n');
const expected = rows.slice(1).reduce((sum, r) => sum + r[1] * r[2], 0).toFixed(2);
const PROMPT = 'Read data/order.csv in this project. Compute the order total in EUR (quantity times unit price, summed over all rows) '
  + 'and write only the total with two decimals, for example 123.45, to a new file total.txt in the project folder.';
const receipt = { schema: 1, purpose: 'real Agent turn inside an automatic Task Graph', model: MODEL, prompt: PROMPT, expected,
  started: new Date().toISOString(), status: 'running', failures: [] };
const save = () => fs.writeFileSync(path.join(run, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
save();

const before = preflight({ dir: run });
receipt.preflight = { ok: before.ok, reasons: before.reasons };
let server = null, transcript = '';
try {
  if (!before.ok) throw Object.assign(new Error(before.reasons.join('; ')), { blocked: true });
  if (!fs.existsSync(path.join(process.env.DSTUDIO_REAL_DS4_DIR || 'ds4', MODEL))) throw Object.assign(new Error(`${MODEL} is not installed`), { blocked: true });
  server = await startDStudio({ binaryArg: process.argv[2], label: 'graph-real', isolatedEnginePort: true });
  const status = () => jsonFetch(server.baseUrl, '/api/status', { timeoutMs: 10_000 });
  const started = await jsonFetch(server.baseUrl, '/api/start', { method: 'POST', headers: csrfHeaders, timeoutMs: 60_000,
    body: JSON.stringify({ mode: 'agent', modelBackend: 'local', gguf: MODEL, workdir: workspace, port: server.enginePort,
      ctx: 32768, power: 100, think: 'off', ssdStreaming: 'off' }) });
  if (started.ok === false) throw new Error(`start refused: ${JSON.stringify(started)}`);
  for (;;) {
    const s = await status();
    if (s.engineError && !s.running) throw new Error(`engine failed: ${s.engineError}`);
    if (s.ready && s.mode === 'agent' && !s.agentWorking) { receipt.engine = { modelFile: s.modelFile, mode: s.mode }; break; }
    await sleep(1000);
  }
  const t0 = performance.now();
  const sent = await jsonFetch(server.baseUrl, '/api/agent/send', { method: 'POST', headers: csrfHeaders, timeoutMs: 30_000,
    body: JSON.stringify({ prompt: PROMPT }) });
  receipt.sent = sent; save();
  if (sent.orchestration !== 'automatic-task-graph' || !sent.graphId)
    receipt.failures.push(`the request was not routed to a Task Graph: ${JSON.stringify({ orchestration: sent.orchestration, routeReason: sent.routeReason })}`);
  let since = Number.isInteger(sent.from) ? sent.from : 0;
  for (;;) {
    const r = await jsonFetch(server.baseUrl, `/api/agent/poll?since=${since}`, { timeoutMs: 10_000 });
    transcript += r.text || ''; since = r.len;
    const graph = sent.graphId ? (await jsonFetch(server.baseUrl, `/api/task-graph?graphId=${encodeURIComponent(sent.graphId)}&workspace=${encodeURIComponent(workspace)}`,
      { timeoutMs: 10_000 }).catch(() => null))?.graph : null;
    if (graph) receipt.graph = { state: graph.state, nodes: (graph.nodes || []).map((n) => ({ id: n.id, kind: n.kind, state: n.state })), lastEventSeq: graph.lastEventSeq };
    if (graph && ['succeeded', 'failed', 'canceled', 'blocked'].includes(graph.state) && !r.working) break;
    if (!sent.graphId && !r.working) break;
    await sleep(1000);
  }
  receipt.seconds = (performance.now() - t0) / 1000;
  const totalFile = path.join(workspace, 'total.txt');
  receipt.written = fs.existsSync(totalFile) ? fs.readFileSync(totalFile, 'utf8').trim() : null;
  receipt.toolCalls = (transcript.match(/"type":"tool_call"/g) || []).length;
  if (sent.graphId) {
    const journal = path.join(workspace, '.dstudio', 'task-graphs', sent.graphId, 'events.jsonl');
    receipt.journal = fs.existsSync(journal) ? { file: path.relative(run, journal), events: fs.readFileSync(journal, 'utf8').trim().split('\n').length } : null;
  }
  if (receipt.graph?.state !== 'succeeded') receipt.failures.push(`graph state ${receipt.graph?.state ?? 'unknown'}`);
  if (receipt.written !== expected) receipt.failures.push(`total.txt holds ${JSON.stringify(receipt.written)}, expected ${expected}`);
  receipt.contamination = contamination(before, preflight({ dir: run }));
  for (const line of receipt.contamination) receipt.failures.push(`contaminated: ${line}`);
  receipt.status = receipt.failures.length ? 'failed' : 'passed';
} catch (error) {
  receipt.status = error.blocked ? 'blocked' : 'failed'; receipt.error = String(error?.stack || error);
} finally {
  fs.writeFileSync(path.join(run, 'transcript.txt'), transcript);
  if (server?.logPath) fs.writeFileSync(path.join(run, 'host.log'), safeReadTail(server.logPath, 2 * 1024 * 1024));
  if (server) {
    await jsonFetch(server.baseUrl, '/api/stop', { method: 'POST', headers: csrfHeaders, body: '{}', timeoutMs: 120_000 }).catch(() => {});
    await server.stop();
  }
  receipt.finished = new Date().toISOString(); save();
  console.log(`${receipt.status.toUpperCase()}: ${receipt.failures.join(' | ') || receipt.error?.split('\n')[0] || `graph succeeded and total.txt = ${expected}`} (${path.relative(process.cwd(), run)}/receipt.json)`);
  process.exitCode = receipt.status === 'passed' ? 0 : 1;
}

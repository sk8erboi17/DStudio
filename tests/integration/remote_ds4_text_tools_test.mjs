// A remote ds4 model's tool call, end to end, without weights: the REAL client
// host (model relay) and the REAL native Agent runtime, through a REAL second
// host's /v1 proxy, to a SCRIPTED ds4-server. The script answers with the bytes
// src/engines/ds4/ds4_server.c sends for a streamed chat request WITHOUT tools
// (the DSML text protocol the runtime uses for a remote ds4 model): the sampled
// DSML as content deltas, then its own parse of that DSML once more as
// tool_calls, finish_reason "tool_calls" and [DONE]. No model, no inference;
// this proves transport and tool execution, not model quality.
//   node tests/integration/remote_ds4_text_tools_test.mjs <dstudio-server-test> <built ds4-agent-jsonl>
// The runtime's build directory is only read: its build sources and runtimes
// are copied, timestamps kept, into this run's own engine directory.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { artifactRunDir, csrfHeaders, freePort, sleep, writeArtifact } from '../support/real_harness.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const [binaryArg, agentArg] = process.argv.slice(2);
assert.ok(binaryArg && agentArg, 'usage: remote_ds4_text_tools_test.mjs <dstudio-server-test> <built ds4-agent-jsonl>');
const binary = fs.realpathSync(binaryArg), agent = fs.realpathSync(agentArg);
const run = artifactRunDir('remote-ds4-text-tools');
const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const receipt = { scope: 'Real client host, relay host and native Agent runtime; SCRIPTED ds4-server bytes; no model or inference',
  binary, binarySha256: sha256(binary), agent, agentSha256: sha256(agent), cases: [] };
const save = () => writeArtifact(run, 'results.json', receipt);

// ---------- this run's engine directory: build sources + built runtimes ----------
const built = path.dirname(agent), engine = path.join(run, 'engine');
const sourceDirs = new Set(['metal', 'cuda', 'rocm', 'third_party', 'tests']);
const sourceFile = (name) => /\.(?:c|h|m|mm|inc|metal|cu|cuh)$/.test(name) || name === 'Makefile' || name === '.gitignore';
(function copy(rel = '') {
  for (const entry of fs.readdirSync(path.join(built, rel), { withFileTypes: true })) {
    const name = path.join(rel, entry.name);
    if (entry.isDirectory() && (rel || sourceDirs.has(entry.name))) copy(name);
    else if (entry.isFile() && (sourceFile(entry.name) || (!rel && ['ds4-agent-jsonl', 'ds4-cowork', 'ds4-agent-jsonl.ver'].includes(entry.name)))) {
      fs.mkdirSync(path.dirname(path.join(engine, name)), { recursive: true });
      fs.cpSync(path.join(built, name), path.join(engine, name), { preserveTimestamps: true, errorOnExist: true, force: false });
    }
  }
})();
for (const file of ['ds4-agent-jsonl', 'ds4-cowork', 'ds4-agent-jsonl.ver', 'ds4_agent.c', 'ds4.c'])
  assert.ok(fs.existsSync(path.join(engine, file)), `${file} is required next to the supplied runtime; missing is not a pass`);

// ---------- scripted ds4-server (exact wire shape, Connection: close) ----------
const D = '｜DSML｜';
const FILE = 'remote-agent-client.txt', MARKER = 'REMOTE_AGENT_CLIENT_OK';
const DSML = `<${D}tool_calls>\n<${D}invoke name="write">\n<${D}parameter name="path" string="true">${FILE}</${D}parameter>\n` +
  `<${D}parameter name="content" string="true">${MARKER}</${D}parameter>\n</${D}invoke>\n</${D}tool_calls>`;
// The live test's prompt (tests/live/real_remote_test.mjs).
const PROMPT = ['This is an automated DStudio remote-model workspace test.', `Call the write tool exactly once to create \`${FILE}\`.`,
  `The file content must be exactly: ${MARKER}`, 'After the tool result, answer only: done'].join('\n');
const hex = (n) => crypto.randomBytes(n).toString('hex');
function ds4Sse(model, content, call) {
  const id = 'chatcmpl-' + hex(12), created = Math.floor(Date.now() / 1000);
  const chunk = (delta, finish = null) => 'data: ' + JSON.stringify({ id, object: 'chat.completion.chunk', created, model,
    choices: [{ index: 0, delta, finish_reason: finish }] }) + '\n\n';
  // Token-sized pieces, as the live stream sends them (sse_chat_delta_n).
  let out = chunk({ role: 'assistant' }) + Array.from(content.match(/[\s\S]{1,7}/gu), (piece) => chunk({ content: piece })).join('');
  // openai_sse_finish_live: calls parsed from the text, sent once more because
  // a request without tools never streamed them as tool deltas.
  if (call) out += chunk({ tool_calls: [{ index: 0, id: 'call_' + hex(16), type: 'function',
    function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] });
  return out + chunk({}, call ? 'tool_calls' : 'stop') + 'data: [DONE]\n\n';
}
let current = null; // the running case; its row receives the requests
const ds4 = net.createServer((socket) => {
  let bytes = Buffer.alloc(0);
  socket.on('data', (data) => {
    bytes = Buffer.concat([bytes, data]);
    const end = bytes.indexOf('\r\n\r\n'); if (end < 0) return;
    const head = bytes.subarray(0, end).toString(), length = Number(/content-length:\s*(\d+)/i.exec(head)?.[1] || 0);
    if (bytes.length < end + 4 + length) return;
    socket.removeAllListeners('data');
    const body = JSON.parse(bytes.subarray(end + 4, end + 4 + length).toString());
    const results = body.messages.filter((m) => m.role === 'tool');
    const requests = current.requests;
    requests.push({ line: head.split('\r\n')[0], tools: 'tools' in body, toolResults: results.map((m) => m.content),
      roles: body.messages.map((m) => m.role) });
    save();
    // A result of the write ends the turn; otherwise the model writes the call.
    const reply = requests.length > 4 ? null : results.length ? ds4Sse(body.model, current.answer, null)
      : ds4Sse(body.model, DSML, { name: 'write', arguments: { path: FILE, content: MARKER } });
    socket.end(reply ? 'HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nConnection: close\r\n\r\n' + reply
      : 'HTTP/1.1 500 Internal Server Error\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
  });
  socket.on('error', () => {});
});
ds4.listen(0, '127.0.0.1'); await once(ds4, 'listening');

// ---------- the two real hosts ----------
const hosts = [];
async function until(check, message, timeout, host) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (host) assert.equal(host.child.exitCode, null, `${host.name} exited: ${message}`);
    if (Date.now() > deadline) throw new Error(`timed out: ${message}`);
    await sleep(50);
  }
}
async function startHost(name, engineDir, env = {}) {
  const port = await freePort(), base = `http://127.0.0.1:${port}`, home = path.join(run, name);
  fs.mkdirSync(home);
  const log = fs.openSync(path.join(run, `${name}.log`), 'wx');
  const child = spawn(binary, [String(port), engineDir], { cwd: root, detached: true, stdio: ['ignore', log, log],
    env: { ...process.env, HOME: home, DS4UI_DATA_DIR: path.join(home, 'data'), DS4UI_TEST_MODE: '1', DS4UI_NO_WINDOW: '1',
      DS4UI_DEFER_ENGINE_START: '1', DS4UI_HOST: '127.0.0.1', DS4UI_ENGINE_PORT: '', ...env } });
  fs.closeSync(log);
  const host = { name, base, child };
  host.request = async (endpoint, body, timeout = 5000) => {
    const res = await fetch(base + endpoint, { method: body === undefined ? 'GET' : 'POST', headers: csrfHeaders,
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeout) });
    return { status: res.status, body: await res.json() };
  };
  host.status = async () => (await host.request('/api/status', undefined, 2000)).body;
  hosts.push(host);
  await until(async () => { try { return (await host.request('/api/status', undefined, 1000)).status === 200; } catch { return false; } },
    `${name} did not listen`, 15000, host);
  return host;
}

// One Agent start (the live test's start request) in its own workspace, one
// prompt, then the turn's end: the native task, or the automatic graph.
async function turn(client, relay, row, orchestration) {
  const workspace = path.join(run, `workspace-${receipt.cases.length}`); fs.mkdirSync(workspace);
  const started = await client.request('/api/start', { mode: 'agent', model: 'standard', variant: 'flash', ctx: 4096, power: 100,
    think: 'off', workdir: workspace, modelBackend: 'remote', remoteBaseUrl: relay.base, remoteModel: 'ds4' }, 30000);
  assert.equal(started.status, 200, JSON.stringify(started.body));
  await until(async () => { const s = await client.status(); return s.ready && s.mode === 'agent' && !s.agentWorking ? s : null; },
    'the remote Agent did not become ready', 120000, client);
  assert.equal(sha256(path.join(engine, 'ds4-agent-jsonl')), receipt.agentSha256, 'the launch ran the supplied runtime, not a rebuild');
  const since = (await client.request('/api/agent/poll?since=0')).body.len || 0;
  const sent = await client.request('/api/agent/send', { prompt: PROMPT, ...(orchestration ? { orchestration } : {}) });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  row.send = sent.body;
  if (sent.body.graphId) {
    // The automatic correctness graph may retry its turn: wait for the graph.
    const graphPath = `/api/task-graph?graphId=${encodeURIComponent(sent.body.graphId)}&workspace=${encodeURIComponent(workspace)}`;
    const graph = await until(async () => {
      const g = (await client.request(graphPath)).body.graph;
      return g && !['draft', 'validated', 'ready', 'running', 'pausing', 'cancelling'].includes(g.state) ? g : null;
    }, 'the request did not end', 60000, client);
    row.graph = { state: graph.state, error: graph.error, nodes: graph.nodes.map((n) => ({ id: n.id, state: n.state })) };
  } else {
    const task = await until(async () => {
      const t = (await client.request(`/api/task?id=${sent.body.taskId}`)).body.task;
      return t && ['completed', 'failed', 'canceled', 'incomplete'].includes(t.status) ? t : null;
    }, 'the turn did not end', 60000, client);
    row.task = { status: task.status, error: task.error };
  }
  await until(async () => !(await client.status()).agentWorking, 'the runtime did not become idle', 10000, client);
  row.transcript = (await client.request(`/api/agent/poll?since=${since}`)).body.text || '';
  writeArtifact(run, `transcript-${receipt.cases.length}.txt`, row.transcript);
  return workspace;
}

// What the transport must guarantee in every case: the runtime asked for text,
// the relay delivered it, and the one DSML call ran once in this workspace.
function assertWrittenOnce(row, workspace) {
  const target = path.join(workspace, FILE);
  assert.doesNotMatch(row.transcript, /Remote model failed|structured model tools/, 'the relay must not refuse the response');
  assert.equal(fs.existsSync(target), true, 'the Agent must write the file in the client workspace');
  assert.equal(fs.readFileSync(target, 'utf8'), MARKER);
  assert.deepEqual(fs.readdirSync(workspace).filter((f) => !f.startsWith('.')), [FILE], 'nothing else was written');
  assert.ok(row.requests.every((r) => !r.tools), 'the runtime asked for the DSML text protocol');
  assert.equal(row.requests[0].toolResults.length, 0);
  assert.equal(row.requests[1]?.toolResults.length, 1, 'the call was executed exactly once');
  assert.match(row.requests[1].toolResults[0], /^Tool result 1 \(write\):\nWrote 22 bytes to remote-agent-client\.txt/);
}

const cases = [
  { name: 'a plain Agent turn: the DSML write runs once and the turn completes', orchestration: 'native', answer: 'done',
    verify(row, workspace) {
      assertWrittenOnce(row, workspace);
      assert.equal(row.requests.length, 2, 'one call, one result, one answer');
      assert.equal(row.task.status, 'completed', JSON.stringify(row.task));
    } },
  // The live test's own path: no orchestration given, so a workspace write
  // runs as the automatic correctness graph, which accepts the turn only from
  // a tool_result receipt followed by its marker; a rejected turn is retried.
  { name: 'the automatic correctness graph accepts the DSML write without retrying it',
    answer: 'done\n\n[[DSTUDIO_CORRECTNESS_COMPLETE]]',
    verify(row, workspace) {
      assertWrittenOnce(row, workspace);
      assert.equal(row.send.orchestration, 'automatic-task-graph', JSON.stringify(row.send));
      assert.equal(row.requests.length, 2, 'no retried turn: one call, one result, one answer');
      assert.equal(row.graph.state, 'succeeded', JSON.stringify(row.graph));
    } },
];

try {
  // The host machine of the live test: its /v1 proxy relays to "ds4-server".
  const relayEngine = path.join(run, 'relay-engine'); fs.mkdirSync(relayEngine);
  const relay = await startHost('relay-host', relayEngine, { DS4UI_ENGINE_PORT: String(ds4.address().port) });
  const client = await startHost('client-host', engine);
  for (const test of cases) {
    const row = { name: test.name, requests: [] };
    receipt.cases.push(row); current = { requests: row.requests, answer: test.answer };
    try {
      const workspace = await turn(client, relay, row, test.orchestration);
      test.verify(row, workspace);
      row.status = 'PASS';
    } catch (error) { row.status = 'FAIL'; row.error = String(error.stack || error); process.exitCode = 1; }
    save();
    console.log(`${row.status} ${row.name}${row.error ? `\n${row.error}` : ''}`);
  }
} finally {
  for (const host of hosts) {
    try { await host.request('/api/stop', {}); } catch {}
    try { process.kill(-host.child.pid, 'SIGTERM'); } catch {}
  }
  await sleep(300);
  for (const host of hosts) { try { process.kill(-host.child.pid, 'SIGKILL'); } catch {} }
  ds4.close();
  receipt.finished = new Date().toISOString(); save();
  console.log(`remote_ds4_text_tools: ${receipt.cases.filter((c) => c.status === 'PASS').length}/${receipt.cases.length}; receipts: ${run}`);
}

// The DStudio harness bridge (src/harness/bridge/dstudio-harness.mjs) with its
// production classes and real processes/sockets. The harnesses and models are
// explicitly SIMULATED: a fake pi speaks pi's RPC JSONL, a fake opencode
// speaks its HTTP + SSE API, a fake ds4-server streams OpenAI SSE, and the
// host's model RPC is played by this test. Real-model coverage is
// tests/live/harness_live_test.mjs.
//   node tests/unit/harness_bridge_test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import {
  displayTool, Endpoint, HostInput, HostOutput, modelFamily, OpencodeHarness, parseArgs, PiHarness, RpcBackend, sanitizeLog,
  SseToolTap, ToolPreview,
} from '../../src/harness/bridge/dstudio-harness.mjs';

const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function check(name, fn) {
  try { await fn(); results.push({ name, ok: true }); console.log(`PASS ${name}`); }
  catch (error) { results.push({ name, ok: false }); console.log(`FAIL ${name}\n${error.stack}`); process.exitCode = 1; }
}
function sink() {
  const chunks = [];
  const stream = new Writable({ write(c, _e, cb) { chunks.push(String(c)); cb(); } });
  stream.text = () => chunks.join('');
  return stream;
}
const frames = (text) => [...text.matchAll(/\x1e(\{[^\n]*\})\n/g)].map((m) => JSON.parse(m[1]));
async function post(url, body, token) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body) });
  return { status: res.status, text: await res.text() };
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-bridge-'));

await check('host flags select the model path: remote/RPC or a local ds4 GGUF', () => {
  const remote = parseArgs(['--non-interactive', '--jsonl', '--remote-base-url', 'http://127.0.0.1:28000', '--remote-model', 'qwen3.6-35b-a3b',
    '--temp', '0.6', '--top-p', '0.95', '--min-p', '0', '-c', '65536', '--nothink', '--chdir', '/w', '-sys', 'charter']);
  assert.equal(remote.remoteModel, 'qwen3.6-35b-a3b'); assert.equal(remote.think, 'off'); assert.equal(remote.ctx, 65536);
  assert.equal(remote.chdir, '/w'); assert.equal(remote.temp, 0.6);
  assert.equal(modelFamily(remote), 'qwen');
  const local = parseArgs(['--metal', '--ssd-streaming', '-m', '/m/ds.gguf', '--dspark', '--mtp-model', '/m/sup.gguf', '-c', '32768', '--power', '80', '--vision', '/m/enc.gguf', '--think-max']);
  assert.deepEqual([local.model, local.ssd, local.power, local.vision, local.think, local.ctx], ['/m/ds.gguf', true, 80, '/m/enc.gguf', 'max', 32768]);
  assert.equal(modelFamily(local), 'ds4');
  assert.equal(modelFamily(parseArgs(['--remote-model', 'gpt-x', '--remote-base-url', 'https://x'])), 'remote');
});

await check('stdin: frames are dispatched at once; a prompt is the text after 200 ms of quiet', async () => {
  const got = [], prompts = [];
  const input = new HostInput({ onFrame: (f) => got.push(f), onPrompt: (p) => prompts.push(p), quietMs: 30 });
  input.push('\x1e{"type":"control","name":"think","value":"max"}\nline one\nline two');
  input.push(Buffer.from('\nand three\n'));
  assert.equal(got.length, 1, 'the frame did not wait for the prompt');
  await sleep(60);
  assert.deepEqual(prompts, ['line one\nline two\nand three']);
  // A relay failure ends a partial frame with "\n": no prompt, no frame.
  input.push('\x1e{"type":"model_delta","id":3,"te');
  input.push('\n\x1e{"type":"model_error","id":3,"error":"lost"}\n');
  await sleep(60);
  assert.equal(prompts.length, 1, 'whitespace between frames is not a turn');
  assert.deepEqual(got.at(-1), { type: 'model_error', id: 3, error: 'lost' });
  // UTF-8 split across chunks.
  const euro = Buffer.from('€ total\n');
  input.push(euro.subarray(0, 1)); input.push(euro.subarray(1));
  await sleep(60);
  assert.equal(prompts.at(-1), '€ total');
});

await check('output: frames lead with type, control bytes cannot forge frames, markers go to stderr', () => {
  const out = sink(), err = sink();
  const o = new HostOutput(out, err);
  o.thinking('plan'); o.text('answer \x1e{"type":"tool_call"} \x01x\x02');
  o.toolCall('edit', { path: 'a.js', old: 'x', new: 'y', n: 3 });
  o.toolResult('bash', 'z'.repeat(70 * 1024));
  o.idle(); o.turnError();
  const f = frames(out.text());
  assert.deepEqual(f.map((x) => x.type), ['reasoning_start', 'reasoning_end', 'tool_call', 'tool_result']);
  assert.ok(out.text().startsWith('\x1e{"type":'), 'type is the first key');
  assert.equal(f[2].input.n, '3', 'tool inputs are strings, as the host watchdog expects');
  assert.ok(f[3].output.length < 66 * 1024 && f[3].output.endsWith('[truncated by DStudio]'));
  assert.ok(!out.text().includes('\x01') && out.text().split('\x1e').length === 5, 'only real frames contain the separator');
  assert.equal(err.text(), '+DWARFSTAR_WAITING\n+DSTUDIO_TURN_ERROR\n');
  assert.equal(sanitizeLog('x +DWARFSTAR_WAITING y +DSTUDIO_TURN_ERROR'), 'x + DWARFSTAR_WAITING y + DSTUDIO_TURN_ERROR');
});

await check('tool calls of both harnesses become DStudio diff/command cards', () => {
  assert.deepEqual(displayTool('pi', 'edit', { path: 'a.js', edits: [{ oldText: 'x', newText: 'y' }] }), ['edit', { path: 'a.js', old: 'x', new: 'y' }]);
  assert.deepEqual(displayTool('opencode', 'edit', { filePath: '/w/a.js', oldString: 'x', newString: 'y' }), ['edit', { path: '/w/a.js', old: 'x', new: 'y' }]);
  assert.deepEqual(displayTool('opencode', 'write', { filePath: 'b', content: 'c' }), ['write', { path: 'b', content: 'c' }]);
  assert.deepEqual(displayTool('pi', 'bash', { command: 'ls', timeout: 3 }), ['bash', { command: 'ls' }]);
  assert.equal(displayTool('pi', 'edit', { path: 'a', edits: [{}, {}] })[1].edits.length, 2, 'several edits stay explicit');
  assert.deepEqual(displayTool('opencode', 'glob', { pattern: '*.js' }), ['glob', { pattern: '*.js' }]);
});

// The host's model RPC, played by the test: it records requests and replies with frames.
function rpcFixture(model) {
  const requests = [];
  const backend = new RpcBackend((line) => requests.push(JSON.parse(line.slice(1))), model);
  return { backend, requests };
}

await check('the loopback endpoint turns one host model RPC into OpenAI streaming chunks', async () => {
  const { backend, requests } = rpcFixture('qwen3.6-35b-a3b');
  let think = 'off';
  const ep = new Endpoint({ backend, kind: 'qwen', model: 'qwen3.6-35b-a3b', think: () => think,
    sampling: { temperature: 0.7, top_p: 0.8, min_p: 0 }, token: 't0k' });
  ep.ctx = 65536; await ep.listen();
  try {
    assert.equal((await post(ep.url() + '/chat/completions', {}, 'wrong')).status, 401, 'another local process cannot use the endpoint');
    const pending = post(ep.url() + '/chat/completions', { model: 'anything', stream: true, temperature: 0.2, reasoning_effort: 'high',
      messages: [{ role: 'user', content: 'hi' }], tools: [{ type: 'function', function: { name: 'read' } }] }, 't0k');
    for (let i = 0; i < 100 && !requests.length; i++) await sleep(10);
    const body = JSON.parse(requests[0].body);
    assert.equal(requests[0].type, 'model_request');
    assert.equal(body.model, 'qwen3.6-35b-a3b', 'the admitted model, whatever the harness asked');
    assert.equal(body.stream, true);
    assert.equal(body.temperature, 0.2, "the harness's own value is kept");
    assert.equal(body.top_p, 0.8, 'DStudio sampling fills what the harness left unset');
    assert.deepEqual(body.chat_template_kwargs, { enable_thinking: false }, 'the Qwen template switch follows the thinking choice');
    assert.ok(!('reasoning_effort' in body), 'llama.cpp Qwen has one template switch, no effort levels');
    assert.equal(body.tools.length, 1);
    const id = requests[0].id;
    backend.frame({ type: 'model_delta', id, kind: 'reasoning', text: 'hm' });
    backend.frame({ type: 'model_delta', id, kind: 'content', text: 'Hello' });
    backend.frame({ type: 'model_tool_calls', id, text: JSON.stringify([{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{"path":"a"}' } }]) });
    backend.frame({ type: 'model_done', id, text: 'tool_calls' });
    const res = await pending;
    const chunks = res.text.split('\n\n').filter((l) => l.startsWith('data: {')).map((l) => JSON.parse(l.slice(6)));
    assert.equal(chunks[0].choices[0].delta.reasoning_content, 'hm');
    assert.equal(chunks[1].choices[0].delta.content, 'Hello');
    assert.deepEqual(chunks[2].choices[0].delta.tool_calls[0], { index: 0, id: 'c1', type: 'function', function: { name: 'read', arguments: '{"path":"a"}' } });
    assert.equal(chunks.at(-1).choices[0].finish_reason, 'tool_calls');
    assert.ok(res.text.trimEnd().endsWith('data: [DONE]'));
    think = 'on';
    const second = post(ep.url() + '/chat/completions', { messages: [], stream: false }, 't0k');
    for (let i = 0; i < 100 && requests.length < 2; i++) await sleep(10);
    assert.deepEqual(JSON.parse(requests[1].body).chat_template_kwargs, { enable_thinking: true });
    backend.frame({ type: 'model_delta', id: requests[1].id, kind: 'content', text: 'Title' });
    backend.frame({ type: 'model_done', id: requests[1].id, text: 'stop' });
    const plain = JSON.parse((await second).text);
    assert.equal(plain.choices[0].message.content, 'Title', 'a non-streaming client receives one JSON body');
  } finally { ep.close(); }
});

await check('a remote endpoint keeps the harness reasoning choice and gets no Qwen template switch', async () => {
  const { backend, requests } = rpcFixture('gpt-remote');
  const ep = new Endpoint({ backend, kind: 'remote', model: 'gpt-remote', think: () => 'off', sampling: {}, token: 'k' });
  ep.ctx = 8192; await ep.listen();
  try {
    const pending = post(ep.url() + '/chat/completions', { messages: [], reasoning_effort: 'low' }, 'k');
    for (let i = 0; i < 100 && !requests.length; i++) await sleep(10);
    const body = JSON.parse(requests[0].body);
    assert.equal(body.reasoning_effort, 'low');
    assert.ok(!('chat_template_kwargs' in body), 'llama.cpp template kwargs never reach another provider');
    backend.frame({ type: 'model_done', id: requests[0].id, text: 'stop' });
    await pending;
  } finally { ep.close(); }
});

await check('model requests are serialized; Stop fails the in-flight one and the queue continues', async () => {
  const { backend, requests } = rpcFixture('qwen3.8-27b');
  const ep = new Endpoint({ backend, kind: 'qwen', model: 'qwen3.8-27b', think: () => 'on', sampling: {}, token: 'k' });
  ep.ctx = 8192; await ep.listen();
  try {
    const a = post(ep.url() + '/chat/completions', { messages: [] }, 'k');
    const b = post(ep.url() + '/chat/completions', { messages: [] }, 'k');
    for (let i = 0; i < 100 && !requests.length; i++) await sleep(10);
    await sleep(50);
    assert.equal(requests.length, 1, 'the host receives one request at a time');
    backend.cancelAll('Stopped by the user');
    const first = await a;
    assert.match(first.text, /"error":\{"message":"Stopped by the user"\}/);
    const second = await b;
    assert.match(second.text, /Stopped by the user/, 'queued requests are failed too, never sent after Stop');
    assert.equal(requests.length, 1);
    const c = post(ep.url() + '/chat/completions', { messages: [] }, 'k');
    for (let i = 0; i < 100 && requests.length < 2; i++) await sleep(10);
    backend.frame({ type: 'model_delta', id: requests[0].id, kind: 'content', text: 'late reply of the stopped request' });
    backend.frame({ type: 'model_done', id: requests[1].id, text: 'stop' });
    const third = await c;
    assert.ok(!third.text.includes('late reply'), 'a late frame of a cancelled id never reaches another request');
  } finally { ep.close(); }
});

await check('a bridge-owned ds4-server receives the thinking choice and streams through unchanged', async () => {
  let seen = null;
  const fake = http.createServer((req, res) => {
    let body = ''; req.on('data', (d) => { body += d; });
    req.on('end', () => {
      seen = JSON.parse(body);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n');
      setTimeout(() => res.end('data: [DONE]\n\n'), 20);
    });
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  const backend = { request: (body, s) => {
    const data = JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port: fake.address().port, path: '/v1/chat/completions', method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, (res) => {
      res.on('data', (d) => s.raw(d)); res.on('end', () => s.rawEnd());
    });
    req.end(data); return () => req.destroy();
  } };
  const ep = new Endpoint({ backend, kind: 'ds4', model: 'deepseek-v4-flash', think: () => 'off', sampling: {}, token: 'k' });
  ep.ctx = 32768; await ep.listen();
  try {
    const r = await post(ep.url() + '/chat/completions', { model: 'x', messages: [] }, 'k');
    assert.equal(seen.reasoning_effort, 'none', 'thinking off reaches ds4-server as reasoning_effort none');
    assert.equal(seen.model, 'deepseek-v4-flash');
    assert.match(r.text, /"content":"ok"/); assert.match(r.text, /\[DONE\]/);
  } finally { ep.close(); fake.close(); }
});

// ---------------------------------------------------------------- fake pi
const piRoot = path.join(tmp, 'root');
const cli = path.join(piRoot, 'pi/packages/coding-agent/dist/bundle/cli.js');
fs.mkdirSync(path.dirname(cli), { recursive: true });
fs.writeFileSync(cli, `
let buf = '', running = false;
const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
fs_args();
function fs_args() { require('fs').writeFileSync(process.env.PI_CODING_AGENT_DIR + '/argv.json', JSON.stringify(process.argv.slice(2))); }
process.stdin.on('data', (d) => {
  buf += d;
  for (let at; (at = buf.indexOf('\\n')) >= 0;) {
    const c = JSON.parse(buf.slice(0, at)); buf = buf.slice(at + 1);
    if (c.type === 'prompt') {
      send({ id: c.id, type: 'response', command: 'prompt', success: true });
      if (c.message === 'stop me') { running = true; send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'work' } }); continue; }
      send({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'think' } });
      send({ type: 'message_update', assistantMessageEvent: { type: 'thinking_end' } });
      send({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'write', args: { path: 'out.txt', content: 'x' } });
      send({ type: 'tool_execution_end', toolCallId: 't1', toolName: 'write', result: { content: [{ type: 'text', text: 'written' }] }, isError: false });
      send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'done' } });
      send({ type: 'agent_settled' });
    } else if (c.type === 'abort') {
      send({ type: 'message_end', message: { role: 'assistant', stopReason: 'error', errorMessage: 'stream ended' } });
      send({ id: c.id, type: 'response', command: 'abort', success: true });
      send({ type: 'agent_settled' });
    } else send({ id: c.id, type: 'response', command: c.type, success: true, data: {} });
  }
});
`.replace('fs_args();', 'fs_args();'));
// The fake is CommonJS: give it a package scope of its own.
fs.writeFileSync(path.join(path.dirname(cli), 'package.json'), '{"type":"commonjs"}');

await check('pi: RPC events become DStudio frames; a finished turn ends with WAITING', async () => {
  const out = sink(), err = sink();
  const o = new HostOutput(out, err);
  const endpoint = { url: () => 'http://127.0.0.1:9/v1', token: 'tok', ctx: 16384 };
  const pi = new PiHarness({ out: o, root: piRoot, state: path.join(tmp, 'state'), cwd: tmp, endpoint, model: 'qwen3.6-35b-a3b',
    family: 'qwen', think: () => 'off', ds4: false, guard: '/guard.ts' });
  await pi.start();
  try {
    const argv = JSON.parse(fs.readFileSync(path.join(tmp, 'state/pi/argv.json'), 'utf8'));
    assert.deepEqual(argv.slice(0, 5), ['--mode', 'rpc', '--offline', '--no-approve', '--no-session']);
    assert.ok(argv.includes('/guard.ts'), 'the workspace guard extension is always loaded');
    const models = JSON.parse(fs.readFileSync(path.join(tmp, 'state/pi/models.json'), 'utf8'));
    assert.equal(models.providers.dstudio.baseUrl, 'http://127.0.0.1:9/v1');
    assert.equal(models.providers.dstudio.compat.thinkingFormat, 'qwen-chat-template');
    assert.equal(models.providers.dstudio.models[0].contextWindow, 16384);
    await pi.prompt('go');
    for (let i = 0; i < 200 && !err.text().includes('WAITING'); i++) await sleep(10);
    const f = frames(out.text());
    assert.deepEqual(f.map((x) => x.type), ['reasoning_start', 'reasoning_end', 'tool_call', 'tool_result']);
    assert.deepEqual(f[2].input, { path: 'out.txt', content: 'x' });
    assert.equal(f[3].output, 'written');
    assert.ok(out.text().includes('done'));
    assert.equal(err.text(), '+DWARFSTAR_WAITING\n', 'a successful turn is not an error');
    await pi.prompt('stop me');
    await sleep(50);
    pi.abort();
    for (let i = 0; i < 200 && err.text().split('WAITING').length < 3; i++) await sleep(10);
    assert.equal(err.text(), '+DWARFSTAR_WAITING\n+DWARFSTAR_WAITING\n', 'Stop ends the turn without a turn error');
  } finally { pi.stop(); }
});

// ----------------------------------------------------------- fake opencode
const ocBin = path.join(piRoot, 'opencode/bin/opencode');
fs.mkdirSync(path.dirname(ocBin), { recursive: true });
fs.writeFileSync(ocBin, `#!/usr/bin/env node
const http = require('http');
const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
const auth = 'Basic ' + Buffer.from('opencode:' + process.env.OPENCODE_SERVER_PASSWORD).toString('base64');
const streams = [];
const emit = (e) => streams.forEach((s) => s.write('data: ' + JSON.stringify(e) + '\\n\\n'));
require('fs').writeFileSync(process.env.XDG_STATE_HOME + '/env.json', JSON.stringify({ config: JSON.parse(process.env.OPENCODE_CONFIG_CONTENT),
  contain: process.env.DSTUDIO_CONTAIN_DIRECTORY, fetch: process.env.OPENCODE_DISABLE_MODELS_FETCH }));
http.createServer((req, res) => {
  if (req.headers.authorization !== auth) { res.writeHead(401).end(); return; }
  const url = req.url.split('?')[0];
  if (url === '/config') { res.writeHead(200).end('{}'); return; }
  if (url === '/event') { res.writeHead(200, { 'content-type': 'text/event-stream' }); streams.push(res); return; }
  if (url === '/session' && req.method === 'POST') { res.writeHead(200).end('{"id":"S1"}'); return; }
  if (url === '/session/S1/prompt_async') {
    res.writeHead(204).end();
    const P = (type, properties) => emit({ id: 'e', type, properties: { sessionID: 'S1', ...properties } });
    // A part may arrive before its message's role is known.
    P('message.part.updated', { part: { id: 'p0', messageID: 'mA', type: 'text', text: '' } });
    P('message.updated', { info: { id: 'mU', role: 'user' } });
    P('message.part.updated', { part: { id: 'pu', messageID: 'mU', type: 'text', text: 'USER PROMPT ECHO' } });
    P('message.updated', { info: { id: 'mA', role: 'assistant' } });
    P('message.part.updated', { part: { id: 'pr', messageID: 'mA', type: 'reasoning', text: '' } });
    P('message.part.delta', { messageID: 'mA', partID: 'pr', field: 'text', delta: 'why' });
    P('message.part.updated', { part: { id: 'pt', messageID: 'mA', type: 'tool', tool: 'edit', callID: 'c1', state: { status: 'running', input: { filePath: 'a.js', oldString: '1', newString: '2' } } } });
    P('message.part.updated', { part: { id: 'pt', messageID: 'mA', type: 'tool', tool: 'edit', callID: 'c1', state: { status: 'completed', input: {}, output: 'Edit applied' } } });
    P('message.part.delta', { messageID: 'mA', partID: 'p0', field: 'text', delta: 'Fin' });
    P('message.part.updated', { part: { id: 'p0', messageID: 'mA', type: 'text', text: 'Finished.' } });
    emit({ id: 'x', type: 'session.idle', properties: { sessionID: 'OTHER' } });
    P('session.idle', {});
    return;
  }
  res.writeHead(404).end();
}).listen(port, '127.0.0.1');
`, { mode: 0o755 });

await check('opencode: SSE parts become DStudio frames once, user echoes excluded, idle ends the turn', async () => {
  const out = sink(), err = sink();
  const o = new HostOutput(out, err);
  const endpoint = { url: () => 'http://127.0.0.1:9/v1', token: 'tok', ctx: 32768 };
  const state = path.join(tmp, 'oc-state');
  const oc = new OpencodeHarness({ out: o, root: piRoot, state, cwd: tmp, endpoint, model: 'deepseek-v4-flash', family: 'ds4' });
  await oc.start();
  try {
    const env = JSON.parse(fs.readFileSync(path.join(state, 'opencode/state/env.json'), 'utf8'));
    assert.equal(env.contain, '1', 'the workspace, not its git worktree, is the file boundary');
    assert.equal(env.fetch, '1', 'no model catalog download');
    assert.equal(env.config.permission.external_directory, 'deny');
    assert.equal(env.config.permission.question, 'deny', 'a question cannot hang a headless turn');
    assert.equal(env.config.provider.dstudio.options.baseURL, 'http://127.0.0.1:9/v1');
    assert.equal(env.config.provider.dstudio.models['deepseek-v4-flash'].limit.context, 32768);
    assert.ok(fs.existsSync(path.join(state, 'opencode/config/opencode/node_modules')), 'no plugin install into the config directory');
    await oc.prompt('go');
    for (let i = 0; i < 300 && !err.text().includes('WAITING'); i++) await sleep(10);
    const text = out.text();
    assert.ok(!text.includes('USER PROMPT ECHO'), "the user's own message is not echoed as the answer");
    const f = frames(text);
    assert.deepEqual(f.map((x) => x.type), ['reasoning_start', 'reasoning_end', 'tool_call', 'tool_result']);
    assert.deepEqual(f[2].input, { path: 'a.js', old: '1', new: '2' });
    assert.equal(f[3].output, 'Edit applied');
    assert.ok(text.includes('Finished.') && !text.includes('FinFinished'), 'delta and full update are not duplicated');
    assert.equal(err.text(), '+DWARFSTAR_WAITING\n', "another session's idle does not end this turn");
  } finally { oc.stop(); }
});


// ------------------------------------------------------------ live preview
// Event kinds in order (bodies merged), the decoded body and the final path.
function previewSummary(text) {
  let kinds = '', body = '';
  for (const f of frames(text)) {
    if (f.type === 'tool_body_delta') { body += f.text; if (!kinds.endsWith('B,')) kinds += 'B,'; }
    else if (f.type === 'tool_call_begin') kinds += `begin:${f.name},`;
    else if (f.type === 'tool_call_param') kinds += `${f.param}@${f.path},`;
  }
  return { kinds, body };
}
function previewSplits(harness, name, args, want) {
  for (let a = 0; a <= args.length; a++) for (let b = a; b <= args.length; b += Math.floor(args.length / 7) + 1) {
    const out = sink();
    const preview = new ToolPreview(new HostOutput(out, sink()), harness, () => 0);
    preview.begin(0, name);
    for (const part of [args.slice(0, a), args.slice(a, b), args.slice(b)]) preview.feed(0, part);
    assert.deepEqual(previewSummary(out.text()), want, `split ${a}/${b}`);
  }
}

await check('live preview: argument fragments become begin/param/body frames for any split', () => {
  previewSplits('pi', 'write', '{"path":"site/index.html","content":"<h1>Ciao \\u00e8 \\ud83d\\ude00 à</h1>\\n\\"q\\" \\\\ end"}',
    { kinds: 'begin:write,path@,content@site/index.html,B,', body: '<h1>Ciao è 😀 à</h1>\n"q" \\ end' });
  previewSplits('pi', 'write', '{ "content" : "abc" , "path" : "x.md" }', { kinds: 'begin:write,content@,B,path@,content@x.md,', body: 'abc' });
  // OpenCode's names: filePath is the path, oldString/newString are edit bodies.
  previewSplits('opencode', 'edit', '{"filePath":"a.js","n":1,"meta":[{"k":"}\\"]"}],"oldString":"x","newString":"y"}',
    { kinds: 'begin:edit,path@,n@a.js,meta@a.js,old@a.js,B,new@a.js,B,', body: 'xy' });
  previewSplits('pi', 'read', '{"path":"README.md"}', { kinds: 'begin:read,path@,', body: '' });
  previewSplits('opencode', 'bash', '{"command":"ls -la","description":"list"}', { kinds: 'begin:bash,command@,B,description@,', body: 'ls -la' });
  // Arguments before the name wait; malformed JSON ends only that call's preview.
  const out = sink(), preview = new ToolPreview(new HostOutput(out, sink()), 'pi', () => 0);
  preview.feed(1, '{"path":"p","content":"he');
  assert.equal(frames(out.text()).length, 0);
  preview.begin(1, 'write'); preview.feed(1, 'llo"}');
  preview.begin(2, 'write'); preview.feed(2, '{"path" x "content":"never"}');
  preview.feed(16, '{"content":"out of range"}');
  assert.deepEqual(previewSummary(out.text()), { kinds: 'begin:write,path@,content@p,B,begin:write,', body: 'hello' });
});

await check('live preview: a long body arrives in bounded batches, not one block', () => {
  const out = sink(); let now = 0;
  const preview = new ToolPreview(new HostOutput(out, sink()), 'pi', () => now);
  preview.begin(0, 'write'); preview.feed(0, '{"path":"big.txt","content":"');
  for (let i = 0; i < 400; i++) { now += 5; preview.feed(0, '0123456789'); }
  preview.feed(0, '"}');
  const bodies = frames(out.text()).filter((f) => f.type === 'tool_body_delta');
  assert.equal(bodies.map((f) => f.text).join('').length, 4000);
  assert.ok(bodies.length >= 4000 / 400, `${bodies.length} batches`);
  assert.ok(bodies.every((f) => f.text.length <= 400));
});

await check('endpoint: a call being generated streams to the harness at once; the validated batch must match it', async () => {
  const { backend, requests } = rpcFixture('qwen3.6-35b-a3b');
  const ep = new Endpoint({ backend, kind: 'qwen', model: 'qwen3.6-35b-a3b', think: () => 'off', sampling: {}, token: 't' });
  const previews = [];
  ep.onToolDelta = (index, name, text) => previews.push([index, name, text]);
  let requestsSeen = 0; ep.onRequest = () => requestsSeen++;
  ep.ctx = 32768; await ep.listen();
  try {
    const chunksOf = (text) => text.split('\n\n').filter((l) => l.startsWith('data: {')).map((l) => JSON.parse(l.slice(6)));
    const pending = post(ep.url() + '/chat/completions', { stream: true, messages: [] }, 't');
    for (let i = 0; i < 100 && !requests.length; i++) await sleep(10);
    const id = requests[0].id;
    backend.frame({ type: 'model_delta', id, kind: 'content', text: 'Writing.' });
    backend.frame({ type: 'model_tool_delta', id, index: 0, name: 'write', call_id: 'c9', text: '{"path":"a.md",' });
    backend.frame({ type: 'model_tool_delta', id, index: 0, text: '"content":"hi"}' });
    const args = '{"path":"a.md","content":"hi"}';
    backend.frame({ type: 'model_tool_calls', id, text: JSON.stringify([{ id: 'c9', type: 'function', function: { name: 'write', arguments: args } }]) });
    backend.frame({ type: 'model_done', id, text: 'tool_calls' });
    const chunks = chunksOf((await pending).text);
    const tools = chunks.filter((c) => c.choices?.[0]?.delta?.tool_calls).map((c) => c.choices[0].delta.tool_calls[0]);
    assert.deepEqual(tools, [
      { index: 0, id: 'c9', type: 'function', function: { name: 'write', arguments: '{"path":"a.md",' } },
      { index: 0, function: { arguments: '"content":"hi"}' } },
    ], 'fragments as they arrived, and no second copy of the complete call');
    assert.equal(chunks.at(-1).choices[0].finish_reason, 'tool_calls');
    assert.deepEqual(previews, [[0, 'write', '{"path":"a.md",'], [0, '', '"content":"hi"}']]);
    assert.equal(requestsSeen, 1);
    // A validated batch that differs from the streamed call is an error, not a silent swap.
    const second = post(ep.url() + '/chat/completions', { stream: true, messages: [] }, 't');
    for (let i = 0; i < 100 && requests.length < 2; i++) await sleep(10);
    const id2 = requests[1].id;
    backend.frame({ type: 'model_tool_delta', id: id2, index: 0, name: 'write', text: '{"path":"a.md"}' });
    backend.frame({ type: 'model_tool_calls', id: id2, text: JSON.stringify([{ id: 'x', type: 'function', function: { name: 'write', arguments: '{"path":"b.md"}' } }]) });
    backend.frame({ type: 'model_done', id: id2, text: 'tool_calls' });
    const text = (await second).text;
    assert.match(text, /differs from the validated call/);
    assert.ok(!text.includes('[DONE]'), 'the harness is not told the call completed');
    const first = chunksOf(text).find((c) => c.choices?.[0]?.delta?.tool_calls)?.choices[0].delta.tool_calls[0];
    assert.match(first.id, /^call_0_[0-9a-f]{12}$/, 'a missing call id is synthesized for the harness');
  } finally { ep.close(); }
});

await check('ds4-server SSE: tool fragments are tapped for the preview in any byte split', () => {
  const sse = 'data: {"choices":[{"index":0,"delta":{"content":"x"}}]}\n\n'
    + 'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"k","type":"function","function":{"name":"bash","arguments":"{\\"comm"}}]}}]}\n\n'
    + 'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"and\\":\\"ls\\"}"}}]}}]}\n\ndata: [DONE]\n\n';
  const bytes = Buffer.from(sse);
  for (let cut = 0; cut <= bytes.length; cut += 7) {
    const seen = [];
    const tap = new SseToolTap((index, name, id, text) => seen.push([index, name, id, text]));
    tap.push(bytes.subarray(0, cut)); tap.push(bytes.subarray(cut));
    assert.deepEqual(seen, [[0, 'bash', 'k', '{"comm'], [0, '', '', 'and":"ls"}']]);
  }
});

await check('pi: its ordered toolcall events drive the preview before the tool runs', () => {
  const out = sink();
  const pi = new PiHarness({ out: new HostOutput(out, sink()), root: tmp, state: tmp, cwd: tmp, endpoint: {}, model: 'm', family: 'qwen', think: () => 'off', ds4: false, guard: '' });
  // pi's RPC wire shape (modes/json-event.ts): no partial message; the start
  // event carries id and toolName.
  pi.event({ type: 'message_start' });
  pi.event({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Saving.' } });
  pi.event({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_start', contentIndex: 1, id: 't1', toolName: 'write' } });
  for (const delta of ['{"path":"s', 'tory.md","content":"Once', ' upon"}'])
    pi.event({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_delta', contentIndex: 1, delta } });
  pi.event({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_end', contentIndex: 1, toolCall: { id: 't1', name: 'write' } } });
  pi.event({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'write', args: { path: 'story.md', content: 'Once upon' } });
  const text = out.text();
  assert.ok(text.startsWith('Saving.'), 'the text before the call stays before its preview');
  assert.deepEqual(previewSummary(text), { kinds: 'begin:write,path@,content@story.md,B,', body: 'Once upon' });
  assert.equal(frames(text).at(-1).type, 'tool_call', 'the executed call follows its preview');
});

fs.rmSync(tmp, { recursive: true, force: true });
const passed = results.filter((r) => r.ok).length;
console.log(`harness_bridge_test: ${passed}/${results.length} passed (production bridge; SIMULATED harnesses, host RPC and models)`);

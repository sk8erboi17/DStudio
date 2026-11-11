// The installed Codex CLI (`codex exec`) against a scripted loopback server
// that speaks the Responses API the way ds4-server does, through the
// benchmark's own model pin proxy, configuration, command line and event
// parser (extension/task-graph/bench/cli-competitor-harness.mjs).
//
// Scripted replies only: no model, no weights, no login, no API key, nothing
// outside 127.0.0.1. This proves the protocol loop the benchmark depends on;
// it says nothing about the quality of any model or agent.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import {
  analyzeEvents, canonicalToolCall, cleanEnvironment, CODEX_PREFLIGHT_ARGS, CODEX_STOP_SIGNAL,
  codexCommand, codexExecArgs, codexPreflight, parseEvents, runCli, runCompetitor,
  startModelPinProxy, writeCodexConfig,
} from '../../extension/task-graph/bench/cli-competitor-harness.mjs';
import { createReliabilityFixture } from '../../extension/task-graph/bench/reliability-fixture.mjs';

const codexOnPath = String(process.env.PATH || '').split(path.delimiter)
  .some((dir) => dir && fs.existsSync(path.join(dir, 'codex')));
if (!codexOnPath) {
  console.log('codex missing: NOT RUN (Codex Responses protocol test needs the Codex CLI on PATH)');
  process.exit(1);
}

const root = path.resolve('tests/.artifacts/codex-responses-protocol');
fs.mkdirSync(root, { recursive: true });
const run = fs.mkdtempSync(path.join(root, 'run-'));
const CONTEXT_TOKENS = 8192;
const MAX_OUTPUT_TOKENS = 1024;
const UNICODE = 'càffè ☕ 日本語 🎉 👩🏽‍💻 é';
const receipt = {
  scope: 'Real Codex CLI, scripted Responses server, no model or inference',
  codexVersion: null, cases: [], notes: [],
};

class Blocked extends Error {}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function note(text) {
  receipt.notes.push(text);
  console.log(`NOTE: ${text}`);
}

// ---------------------------------------------------------------- scripted engine
// Event shapes, their order and the wire framing (`data:` lines only, a
// sequence_number after the type, a body delimited by connection close) follow
// the responses_sse_* emitters of the pinned src/engines/ds4/ds4_server.c.
let serial = 0;
const nextId = (prefix) => `${prefix}${(++serial).toString(16).padStart(24, '0')}`;
const usageOf = (input = 100, output = 10, cached = 0) => ({
  input_tokens: input, input_tokens_details: { cached_tokens: cached, cache_write_tokens: 0 },
  output_tokens: output, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: input + output,
});
function pieces(text, count = 3) {
  const points = Array.from(text);
  const size = Math.max(1, Math.ceil(points.length / count));
  const result = [];
  for (let offset = 0; offset < points.length; offset += size) result.push(points.slice(offset, offset + size).join(''));
  return result;
}

// parts: { reasoning: text } | { text } | { call: { callId, name?, arguments } }
function turn(parts, { usage = usageOf(), end = 'completed' } = {}) {
  const id = nextId('resp_');
  const head = { id, object: 'response', created_at: 1767225600, model: 'ds4' };
  const events = [{ type: 'response.created', response: { ...head, status: 'in_progress', output: [] } }];
  const output = [];
  for (const part of parts) {
    const output_index = output.length;
    if (part.reasoning !== undefined) {
      const item = { id: nextId('rs_'), type: 'reasoning' };
      const at = { item_id: item.id, output_index, summary_index: 0 };
      events.push({ type: 'response.output_item.added', output_index, item: { ...item, status: 'in_progress', summary: [] } },
        { type: 'response.reasoning_summary_part.added', ...at, part: { type: 'summary_text', text: '' } },
        ...pieces(part.reasoning).map((delta) => ({ type: 'response.reasoning_summary_text.delta', ...at, delta })),
        { type: 'response.reasoning_summary_text.done', ...at, text: part.reasoning },
        { type: 'response.reasoning_summary_part.done', ...at, part: { type: 'summary_text', text: part.reasoning } });
      output.push({ ...item, status: 'completed', summary: [{ type: 'summary_text', text: part.reasoning }] });
    } else if (part.text !== undefined) {
      const item = { id: nextId('msg_'), type: 'message' };
      const at = { item_id: item.id, output_index, content_index: 0 };
      const content = { type: 'output_text', text: part.text, annotations: [] };
      events.push({ type: 'response.output_item.added', output_index, item: { ...item, status: 'in_progress', role: 'assistant', content: [] } },
        { type: 'response.content_part.added', ...at, part: { type: 'output_text', text: '', annotations: [] } },
        ...pieces(part.text).map((delta) => ({ type: 'response.output_text.delta', ...at, delta })),
        { type: 'response.output_text.done', ...at, text: part.text },
        { type: 'response.content_part.done', ...at, part: content });
      output.push({ ...item, status: end === 'incomplete' ? 'incomplete' : 'completed', role: 'assistant', content: [content] });
    } else {
      const args = typeof part.call.arguments === 'string' ? part.call.arguments : JSON.stringify(part.call.arguments);
      const item = { id: nextId('fc_'), type: 'function_call', name: part.call.name || 'exec_command', call_id: part.call.callId };
      events.push({ type: 'response.output_item.added', output_index, item: { ...item, status: 'in_progress', arguments: '' } },
        { type: 'response.function_call_arguments.delta', item_id: item.id, output_index, delta: args },
        { type: 'response.function_call_arguments.done', item_id: item.id, output_index, name: item.name, arguments: args });
      output.push({ ...item, status: 'completed', arguments: args });
    }
    events.push({ type: 'response.output_item.done', output_index, item: output.at(-1) });
  }
  if (end === 'completed') events.push({ type: 'response.completed', response: { ...head, status: 'completed', output, usage } });
  else if (end === 'incomplete') events.push({ type: 'response.incomplete', response: { ...head, status: 'incomplete', incomplete_details: { reason: 'max_tokens' }, output, usage } });
  else if (end === 'failed') events.push({ type: 'response.failed', response: { ...head, status: 'failed', error: { code: 'server_error', message: 'generation failed' }, output, usage } });
  return { id, events, output };
}

// The requests ds4-server refuses (parse_responses_request,
// responses_validate_tool_outputs): a stored-response reference, or a tool
// output whose call is not replayed in the same request.
function contractError(body) {
  if (!body || typeof body !== 'object') return 'invalid JSON request';
  for (const key of ['previous_response_id', 'conversation'])
    if (body[key] !== undefined && body[key] !== null) return `${key} is not supported; replay full input instead`;
  if (body.input === undefined) return 'missing input';
  const declared = new Set();
  for (const item of Array.isArray(body.input) ? body.input : []) {
    if (item?.type === 'function_call') declared.add(item.call_id);
    if (item?.type === 'function_call_output' && !declared.has(item.call_id))
      return `Responses continuation state is not available for call_id ${item.call_id}; retry by replaying the full input history`;
  }
  return null;
}

async function startScriptedEngine() {
  const received = [];
  const violations = [];
  const sockets = new Set();
  let queue = [];
  const errorBody = (message) => `${JSON.stringify({ error: { message, type: 'invalid_request_error' } })}\n`;
  async function handle(request, response, raw) {
    const socket = response.socket;
    let body = null;
    try { body = raw.length ? JSON.parse(raw.toString('utf8')) : null; } catch {}
    const record = { method: request.method, url: request.url, headers: request.headers, bytes: raw.length, body, segments: 0, served: false };
    Object.defineProperty(record, 'closed', { value: new Promise((resolve) => socket.once('close', resolve)) });
    received.push(record);
    const reply = (status, text) => socket.end(`HTTP/1.1 ${status} ${status === 200 ? 'OK' : 'Error'}\r\n` +
      `Content-Length: ${Buffer.byteLength(text)}\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n${text}`);
    if (request.method === 'GET' && request.url === '/v1/models')
      return reply(200, `${JSON.stringify({ object: 'list', data: [{ id: 'deepseek-v4-flash', object: 'model', created: 1767225600, owned_by: 'ds4.c' }] })}\n`);
    if (request.method !== 'POST' || request.url !== '/v1/responses') return reply(404, errorBody('unknown endpoint'));
    const refusal = contractError(body);
    if (refusal) {
      violations.push(refusal);
      return reply(400, errorBody(refusal));
    }
    const step = queue.shift();
    if (!step) {
      violations.push('a model request arrived with no scripted reply left');
      return reply(500, errorBody('no scripted reply left'));
    }
    const plan = typeof step === 'function' ? step(body, record) : step;
    if (plan.status) return reply(plan.status, plan.body);
    socket.setNoDelay(true);
    socket.write('HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nConnection: close\r\n\r\n');
    let frames = plan.events.map(({ type, ...rest }, sequence_number) =>
      `data: ${JSON.stringify({ type, sequence_number, ...rest })}\n\n`);
    if (plan.frames) frames = plan.frames(frames);
    let wire = Buffer.from(frames.join(''), 'utf8');
    if (plan.cutBytes) wire = wire.subarray(0, wire.length - plan.cutBytes);
    const size = plan.chunkBytes || wire.length;
    for (let offset = 0; offset < wire.length && !socket.destroyed; offset += size) {
      socket.write(wire.subarray(offset, offset + size));
      record.segments += 1;
      if (plan.chunkBytes) await new Promise((resolve) => setImmediate(resolve));
    }
    record.served = true;
    if (plan.reset) socket.resetAndDestroy();
    else if (!plan.hold) socket.end(); // a held stream ends only when the client goes away
  }
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => handle(request, response, Buffer.concat(chunks)).catch((error) => {
      violations.push(`scripted engine failed: ${error.stack}`);
      response.socket?.destroy();
    }));
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  return {
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    violations,
    script(steps) { queue = [...steps]; },
    unserved() { return queue.length; },
    take() { return received.splice(0); },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

// ---------------------------------------------------------------- one CLI run
const engine = await startScriptedEngine();
const proxy = await startModelPinProxy(engine.port, { responsesMaxOutputTokens: MAX_OUTPUT_TOKENS });
const allBlocked = [];
const homes = [];
let caseCount = 0;

function place(label) {
  const dir = path.join(run, `${String(++caseCount).padStart(2, '0')}-${label}`);
  const home = path.join(dir, 'home');
  const workspace = path.join(dir, 'workspace');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  homes.push(home);
  return { dir, home, workspace };
}

// One CLI invocation with the benchmark's own configuration, environment,
// command line and process control, under the proxy. `direct` skips the proxy
// (CLI <-> scripted engine); `at` reuses a home and workspace.
async function codexRun(label, { steps, prompt = 'Do the scripted task.', args, timeoutMs = 60_000, direct = false,
  source = process.env, at = null, stopSignal = CODEX_STOP_SIGNAL }) {
  const where = at || place(label);
  const cli = writeCodexConfig({ home: where.home, baseUrl: direct ? engine.baseUrl : proxy.baseUrl, contextTokens: CONTEXT_TOKENS });
  const env = cleanEnvironment({ ...cli.env, PWD: where.workspace }, source);
  const command = args ? args(where) : codexExecArgs({ workspace: where.workspace, prompt });
  engine.script(steps);
  engine.take();
  proxy.begin(label);
  let execution;
  let observed;
  try {
    execution = await runCli('codex', command, { cwd: where.workspace, env, timeoutMs, stopSignal });
  } finally {
    observed = proxy.end(label);
  }
  const requests = engine.take();
  const blocked = observed.filter((record) => record.blocked);
  allBlocked.push(...blocked.map((record) => `${label}: ${record.method} ${record.path}`));
  const suffix = at ? `-${label}` : '';
  fs.writeFileSync(path.join(where.dir, `stdout${suffix}.jsonl`), execution.stdout);
  fs.writeFileSync(path.join(where.dir, `stderr${suffix}.txt`), execution.stderr);
  fs.writeFileSync(path.join(where.dir, `engine-requests${suffix}.json`), JSON.stringify(requests, null, 2));
  fs.writeFileSync(path.join(where.dir, `proxy-observations${suffix}.json`), JSON.stringify(observed, null, 2));
  const events = parseEvents(execution.stdout);
  return {
    ...where, env, execution, events, requests, blocked,
    observed: observed.filter((record) => !record.blocked),
    modelRequests: requests.filter((request) => request.method === 'POST' && request.url === '/v1/responses'),
    items: (type) => events.filter((event) => event.type === 'item.completed' && event.item?.type === type)
      .map((event) => event.item),
    eventTypes: events.map((event) => event.type),
  };
}

const inputOf = (request) => request.body.input;
const ofType = (request, type) => inputOf(request).filter((item) => item.type === type);
const userTexts = (request) => inputOf(request).filter((item) => item.type === 'message' && item.role === 'user')
  .map((item) => item.content.map((part) => part.text).join(''));
// A shell tool result as the CLI reports it to the model; the chunk id and the
// wall time vary, the exit status and the output are the command's own.
function shellResult(output) {
  const match = /^Chunk ID: [0-9a-f]+\nWall time: [0-9.]+ seconds\nProcess exited with code (-?\d+)\nOriginal token count: \d+\nOutput:\n([\s\S]*)$/.exec(String(output));
  return match ? { exitCode: Number(match[1]), output: match[2] } : null;
}
const resultFor = (request, callId) => {
  const outputs = ofType(request, 'function_call_output').filter((item) => item.call_id === callId);
  assert.equal(outputs.length, 1, `exactly one tool result for ${callId}`);
  return outputs[0].output;
};
const failure = (result) => result.events.find((event) => event.type === 'turn.failed')?.error?.message || '';
function assertFailedVisibly(result, pattern) {
  assert.notEqual(result.execution.code, 0, 'the CLI must not exit 0');
  assert.match(failure(result), pattern);
  assert.ok(!result.eventTypes.includes('turn.completed'), 'no completed turn may be reported');
}
const read = (dir, name) => fs.readFileSync(path.join(dir, name), 'utf8');

async function check(name, fn) {
  const row = { name };
  try {
    await fn();
    row.status = 'PASS';
  } catch (error) {
    row.status = error instanceof Blocked ? 'BLOCKED' : 'FAIL';
    row.error = error.stack;
    process.exitCode = 1;
  }
  if (engine.violations.length) {
    row.status = row.status === 'PASS' ? 'FAIL' : row.status;
    row.engineRefusals = engine.violations.splice(0);
    process.exitCode = 1;
  }
  receipt.cases.push(row);
  console.log(`${row.status}: ${name}${row.error ? `\n${row.error}` : ''}${row.engineRefusals ? `\nscripted engine refused: ${row.engineRefusals.join('; ')}` : ''}`);
}

const watchdog = setTimeout(() => {
  console.log('FAIL: Codex Responses protocol test exceeded its 300-second bound');
  process.exit(1);
}, 300_000);

try {
  {
    const where = place('version');
    const cli = writeCodexConfig({ home: where.home, baseUrl: proxy.baseUrl, contextTokens: CONTEXT_TOKENS });
    const version = await runCli('codex', ['--version'], { cwd: where.workspace, env: cleanEnvironment(cli.env), timeoutMs: 30_000 });
    receipt.codexVersion = version.stdout.trim();
    console.log(`Codex CLI under test: ${receipt.codexVersion || `unavailable (exit ${version.code}) ${version.stderr.trim()}`}`);
  }

  await check('preflight: the CLI resolves ds4 on the dstudio Responses provider and reaches it without a model request', async () => {
    const where = place('preflight');
    const cli = writeCodexConfig({ home: where.home, baseUrl: proxy.baseUrl, contextTokens: CONTEXT_TOKENS });
    const env = cleanEnvironment({ ...cli.env, PWD: where.workspace });
    engine.take();
    proxy.begin('preflight');
    let execution;
    let observed;
    try {
      execution = await runCli('codex', [...CODEX_PREFLIGHT_ARGS], { cwd: where.workspace, env, timeoutMs: 60_000 });
    } finally {
      observed = proxy.end('preflight');
    }
    fs.writeFileSync(path.join(where.dir, 'doctor.json'), execution.stdout);
    assert.equal(execution.code, 0, execution.stderr);
    assert.deepEqual(codexPreflight(execution.stdout),
      { model: 'ds4', provider: 'dstudio', wireApi: 'responses', providerReachability: 'ok', ok: true });
    assert.ok(observed.some((record) => record.method === 'GET' && record.path === '/v1/models'),
      'the provider probe must pass through the pin proxy');
    assert.deepEqual(observed.filter((record) => record.blocked), []);
    assert.deepEqual(engine.take().filter((request) => request.method === 'POST'), [], 'a preflight sends no model request');

    proxy.begin('preflight-other-model');
    let other;
    try {
      other = await runCli('codex', [...CODEX_PREFLIGHT_ARGS, '-c', 'model="not-ds4"'], { cwd: where.workspace, env, timeoutMs: 60_000 });
    } finally {
      proxy.end('preflight-other-model');
    }
    const refused = codexPreflight(other.stdout);
    assert.equal(refused.model, 'not-ds4');
    assert.equal(refused.ok, false, 'another model must not pass the preflight');
    assert.equal(codexPreflight('not a report').ok, false);
  });

  await check('tool call -> real command and file -> tool result -> final answer', async () => {
    const call = turn([{ call: { callId: 'call_write_note', arguments: { cmd: "printf 'hello\\n' > note.txt && cat note.txt" } } }], { usage: usageOf(120, 30) });
    const answer = turn([{ text: 'Release code: COBALT-417 CODEX_DONE' }], { usage: usageOf(160, 12, 120) });
    const result = await codexRun('tool-loop', { steps: [call, answer], prompt: 'Create note.txt, then report.' });
    const [first, second] = result.modelRequests;
    const denied = second && /sandbox_apply|sandbox-exec/.test(resultFor(second, 'call_write_note'));
    if (denied) throw new Blocked('the Codex seatbelt sandbox cannot start here (nested sandbox). Run `make test-codex-protocol` from an unsandboxed terminal.');

    assert.equal(result.execution.code, 0, result.execution.stderr);
    assert.equal(read(result.workspace, 'note.txt'), 'hello\n');
    assert.equal(result.modelRequests.length, 2);
    assert.equal(engine.unserved(), 0);

    // What the CLI sends by itself (recorded by the proxy before it changes anything).
    assert.deepEqual(result.observed.map((record) => [record.method, record.path, record.model, record.stream]),
      [['POST', '/v1/responses', 'ds4', true], ['POST', '/v1/responses', 'ds4', true]]);
    assert.deepEqual(result.observed.map((record) => record.nativeReasoningEffort), ['none', 'none']);
    assert.deepEqual(result.observed.map((record) => record.nativeMaxOutputTokens), [null, null]);
    assert.deepEqual(result.observed.map((record) => record.previousResponseId), [null, null]);
    assert.deepEqual(result.observed.map((record) => record.requestKind), ['turn', 'turn']);
    assert.deepEqual(result.observed.map((record) => record.toolOutputs), [0, 1]);
    assert.ok(result.observed.every((record) => record.toolSchemas > 0));
    // What the engine receives after the proxy applied the declared settings.
    for (const request of result.modelRequests) {
      assert.equal(request.body.model, 'ds4');
      assert.equal(request.body.reasoning.effort, 'none');
      assert.equal(request.body.max_output_tokens, MAX_OUTPUT_TOKENS);
      assert.equal(request.body.store, false);
      assert.equal(request.headers.accept, 'text/event-stream');
      assert.equal(request.headers.authorization, undefined, 'no credential may be sent');
      assert.deepEqual(request.body.tools.filter((tool) => tool.type === 'function').map((tool) => tool.name).slice(0, 2),
        ['exec_command', 'write_stdin']);
    }
    assert.equal(userTexts(first).at(-1), 'Create note.txt, then report.');
    assert.deepEqual(ofType(first, 'function_call'), []);
    note(`the first request of a one-line task is ${first.bytes} bytes with ${first.body.tools.length} tool schemas (${first.body.tools.map((tool) => tool.name || tool.type).join(', ')}); the context it needs depends on the model's tokenizer and is not measured here`);

    // The second request replays the call byte for byte and carries its result.
    const sent = call.output[0];
    assert.deepEqual(ofType(second, 'function_call').map((item) => [item.id, item.call_id, item.name, item.arguments]),
      [[sent.id, 'call_write_note', 'exec_command', sent.arguments]]);
    assert.deepEqual(shellResult(resultFor(second, 'call_write_note')), { exitCode: 0, output: 'hello\n' });

    // The CLI's own JSON events.
    const thread = result.events[0];
    assert.equal(thread.type, 'thread.started');
    assert.equal(first.body.prompt_cache_key, thread.thread_id);
    assert.equal(second.body.prompt_cache_key, thread.thread_id);
    const [command] = result.items('command_execution');
    assert.equal(result.items('command_execution').length, 1);
    assert.ok(command.command.endsWith(`"printf 'hello\\\\n' > note.txt && cat note.txt"`), command.command);
    assert.deepEqual([command.aggregated_output, command.exit_code, command.status], ['hello\n', 0, 'completed']);
    assert.deepEqual(result.items('agent_message').map((item) => item.text), ['Release code: COBALT-417 CODEX_DONE']);
    assert.deepEqual(result.events.at(-1), { type: 'turn.completed',
      usage: { input_tokens: 280, cached_input_tokens: 120, cache_write_input_tokens: 0, output_tokens: 42, reasoning_output_tokens: 0 } });

    // The benchmark's parser and grading inputs on the same output.
    const task = { expected: 'CODEX_DONE', answerMustContain: ['Release code: COBALT-417'] };
    assert.deepEqual(analyzeEvents('codex', result.execution.stdout, task),
      { parsedEvents: result.events.length, calls: 1, maximumRepeated: 1, answerAfterTool: true });
    assert.equal(analyzeEvents('codex', result.execution.stdout, { expected: 'OTHER_MARKER' }).answerAfterTool, false);
    const completed = result.events.find((event) => event.type === 'item.completed' && event.item.type === 'command_execution');
    assert.deepEqual(JSON.parse(canonicalToolCall('codex', completed)), { name: 'command_execution', input: { command: command.command } });
  });

  await check('an answer without any tool call is not accepted as a completed task by the parser', async () => {
    const result = await codexRun('text-only', { steps: [turn([{ text: 'Release code: COBALT-417 CODEX_DONE' }])] });
    assert.equal(result.execution.code, 0, result.execution.stderr);
    assert.deepEqual(analyzeEvents('codex', result.execution.stdout, { expected: 'CODEX_DONE' }),
      { parsedEvents: result.events.length, calls: 0, maximumRepeated: 0, answerAfterTool: false });
  });

  await check('reasoning summary events are printed and replayed with the tool call', async () => {
    const thought = `Devo scrivere ${UNICODE} e poi leggere il file.`;
    const call = turn([{ reasoning: thought }, { text: 'Scrivo il file…' },
      { call: { callId: 'call_after_reasoning', arguments: { cmd: 'echo reasoned > reasoned.txt' } } }]);
    const result = await codexRun('reasoning', { steps: [call, turn([{ text: 'Fatto.' }])] });
    assert.equal(result.execution.code, 0, result.execution.stderr);
    assert.equal(read(result.workspace, 'reasoned.txt'), 'reasoned\n');
    assert.deepEqual(result.items('reasoning').map((item) => item.text), [thought]);
    assert.deepEqual(result.items('agent_message').map((item) => item.text), ['Scrivo il file…', 'Fatto.']);
    const order = result.events.filter((event) => event.type === 'item.completed' && event.item.type !== 'error').map((event) => event.item.type);
    assert.deepEqual(order, ['reasoning', 'agent_message', 'command_execution', 'agent_message']);
    const replayed = inputOf(result.modelRequests[1]).filter((item) => ['reasoning', 'function_call', 'function_call_output'].includes(item.type) ||
      (item.type === 'message' && item.role === 'assistant'));
    assert.deepEqual(replayed.map((item) => [item.type, item.id ?? null].join(' ')).slice(0, 3),
      call.output.map((item) => `${item.type} ${item.id}`));
    assert.deepEqual(replayed[0].summary, [{ type: 'summary_text', text: thought }]);
    assert.equal(replayed[3].type, 'function_call_output');
  });

  for (const [mode, direct, chunkBytes] of [['CLI <- engine, one byte per write', true, 1], ['through the pin proxy, five bytes per write', false, 5]]) {
    await check(`split frames and Unicode cut inside a character (${mode})`, async () => {
      const call = turn([{ reasoning: `Penso: ${UNICODE}` }, { text: `Scrivo ${UNICODE}` },
        { call: { callId: 'call_unicode', arguments: { cmd: `printf '%s\\n' '${UNICODE}' > unicode.txt && cat unicode.txt` } } }]);
      const answer = turn([{ text: `Fatto: ${UNICODE} CODEX_DONE` }]);
      const result = await codexRun(`split-${direct ? 'direct' : 'proxy'}`, { direct,
        steps: [{ ...call, chunkBytes }, { ...answer, chunkBytes }] });
      assert.equal(result.execution.code, 0, result.execution.stderr);
      const wireBytes = Buffer.byteLength(call.events.map((event) => JSON.stringify(event)).join(''));
      assert.ok(result.modelRequests[0].segments >= wireBytes / chunkBytes, 'the reply was written in separate pieces');
      assert.equal(read(result.workspace, 'unicode.txt'), `${UNICODE}\n`);
      assert.deepEqual(result.items('reasoning').map((item) => item.text), [`Penso: ${UNICODE}`]);
      assert.deepEqual(result.items('agent_message').map((item) => item.text), [`Scrivo ${UNICODE}`, `Fatto: ${UNICODE} CODEX_DONE`]);
      assert.equal(result.items('command_execution')[0].aggregated_output, `${UNICODE}\n`);
      const second = result.modelRequests[1];
      assert.deepEqual(shellResult(resultFor(second, 'call_unicode')), { exitCode: 0, output: `${UNICODE}\n` });
      assert.equal(ofType(second, 'function_call')[0].arguments, call.output[2].arguments);
      assert.equal(analyzeEvents('codex', result.execution.stdout, { expected: 'CODEX_DONE', answerMustContain: [UNICODE] }).answerAfterTool, true);
    });
  }

  await check('call and response identifiers: every result answers its own call, once, across two rounds', async () => {
    const round1 = turn([
      { call: { callId: 'call_alpha', arguments: { cmd: 'echo ALPHA_OUT; echo a > alpha.txt' } } },
      { call: { callId: 'call_beta', arguments: { cmd: 'echo BETA_OUT; echo b > beta.txt' } } },
    ]);
    const round2 = turn([{ call: { callId: 'call_gamma', arguments: { cmd: 'echo GAMMA_OUT; cat alpha.txt beta.txt > gamma.txt' } } }]);
    const result = await codexRun('identifiers', { steps: [round1, round2, turn([{ text: 'Three calls done.' }])] });
    assert.equal(result.execution.code, 0, result.execution.stderr);
    assert.equal(read(result.workspace, 'gamma.txt'), 'a\nb\n');
    const [first, second, third] = result.modelRequests;
    assert.deepEqual(ofType(second, 'function_call').map((item) => [item.id, item.call_id]),
      round1.output.map((item) => [item.id, item.call_id]));
    assert.deepEqual(shellResult(resultFor(second, 'call_alpha')), { exitCode: 0, output: 'ALPHA_OUT\n' });
    assert.deepEqual(shellResult(resultFor(second, 'call_beta')), { exitCode: 0, output: 'BETA_OUT\n' });
    assert.deepEqual(ofType(third, 'function_call').map((item) => [item.id, item.call_id]),
      [...round1.output, ...round2.output].map((item) => [item.id, item.call_id]));
    assert.deepEqual(ofType(third, 'function_call_output').map((item) => item.call_id).sort(), ['call_alpha', 'call_beta', 'call_gamma']);
    assert.deepEqual(shellResult(resultFor(third, 'call_gamma')), { exitCode: 0, output: 'GAMMA_OUT\n' });
    // One session: the same cache key and session header on every request, no stored-response reference.
    const thread = result.events[0].thread_id;
    for (const request of [first, second, third]) {
      assert.equal(request.body.prompt_cache_key, thread);
      assert.equal(request.headers['session-id'], thread);
      assert.equal(request.body.previous_response_id, undefined);
    }
    assert.deepEqual(result.observed.map((record) => record.toolOutputs), [0, 2, 3]);
    assert.equal(analyzeEvents('codex', result.execution.stdout, { expected: 'Three calls done.' }).calls, 3);
  });

  await check('continuation: a second CLI invocation resumes the session by replaying its full history', async () => {
    const where = place('resume');
    const call = turn([{ call: { callId: 'call_first_session', arguments: { cmd: 'echo one > first.txt' } } }]);
    const firstAnswer = turn([{ text: 'First session answer.' }]);
    // The benchmark runs each task in an ephemeral session; resuming needs a stored one.
    const first = await codexRun('first', { at: where, steps: [call, firstAnswer], prompt: 'First prompt.',
      args: ({ workspace }) => codexExecArgs({ workspace, prompt: 'First prompt.' }).filter((arg) => arg !== '--ephemeral') });
    assert.equal(first.execution.code, 0, first.execution.stderr);
    const thread = first.events[0].thread_id;
    const resumed = await codexRun('resumed', { at: where,
      steps: [turn([{ text: 'Resumed answer.' }], { usage: usageOf(300, 9, 250) })],
      args: () => ['exec', 'resume', thread, '--json', '--strict-config', '--skip-git-repo-check', '--model', 'ds4', 'Second prompt.'] });
    assert.equal(resumed.execution.code, 0, resumed.execution.stderr);
    assert.equal(resumed.events[0].thread_id, thread);
    assert.deepEqual(resumed.items('agent_message').map((item) => item.text), ['Resumed answer.']);
    const [request] = resumed.modelRequests;
    assert.equal(request.body.prompt_cache_key, thread);
    assert.equal(request.body.previous_response_id, undefined);
    const history = inputOf(request).filter((item) => item.type !== 'message' || item.role !== 'developer');
    const firstPrompt = history.findIndex((item) => item.type === 'message' && item.content[0].text === 'First prompt.');
    assert.deepEqual(history.slice(firstPrompt).map((item) => item.type === 'message'
      ? `${item.role}: ${item.content.map((part) => part.text).join('')}` : `${item.type} ${item.call_id}`), [
      'user: First prompt.', 'function_call call_first_session', 'function_call_output call_first_session',
      'assistant: First session answer.', 'user: Second prompt.',
    ]);
    assert.equal(history.find((item) => item.type === 'function_call').id, call.output[0].id);
    assert.equal(resumed.events.at(-1).usage.cached_input_tokens, 250, 'the server-reported cache read reaches the CLI events');
  });

  await check('context checkpoint: usage at the configured window makes the CLI send a compaction request on the same endpoint', async () => {
    const full = usageOf(CONTEXT_TOKENS - 100, 20, CONTEXT_TOKENS - 500);
    const call = turn([{ call: { callId: 'call_before_compaction', arguments: { cmd: 'echo kept > kept.txt' } } }], { usage: full });
    // Whatever comes back for a compaction request is a summary, never a command to run.
    const summary = turn([{ text: 'SUMMARY: kept.txt was written.' },
      { call: { callId: 'call_inside_summary', arguments: { cmd: 'echo wrong > must-not-exist.txt' } } }], { usage: usageOf(900, 20) });
    const result = await codexRun('compaction', { steps: [call, summary, turn([{ text: 'Finished after the checkpoint.' }], { usage: usageOf(900, 20) })] });
    assert.equal(result.execution.code, 0, result.execution.stderr);
    assert.deepEqual(result.observed.map((record) => [record.path, record.requestKind, record.toolSchemas > 0]),
      [['/v1/responses', 'turn', true], ['/v1/responses', 'compaction', false], ['/v1/responses', 'turn', true]]);
    assert.equal(read(result.workspace, 'kept.txt'), 'kept\n');
    assert.ok(!fs.existsSync(path.join(result.workspace, 'must-not-exist.txt')));
    const after = result.modelRequests[2];
    assert.deepEqual(ofType(after, 'function_call'), [], 'the compacted history replaces the earlier items');
    assert.ok(userTexts(after).some((text) => text.includes('SUMMARY: kept.txt was written.')));
    assert.deepEqual(result.items('agent_message').map((item) => item.text), ['Finished after the checkpoint.']);
  });

  await check('stop: an incomplete or failed response ends the run as a failure with its partial text kept', async () => {
    const cut = await codexRun('incomplete', { steps: [turn([{ text: 'Partial answer that was cut' }], { end: 'incomplete' })] });
    assertFailedVisibly(cut, /Incomplete response returned, reason: max_tokens/);
    assert.deepEqual(cut.items('agent_message').map((item) => item.text), ['Partial answer that was cut']);
    const failed = await codexRun('failed', { steps: [turn([{ text: 'Never finished' }], { end: 'failed' })] });
    assertFailedVisibly(failed, /generation failed/);
    const tooLong = await codexRun('context-length', { steps: [{ status: 400, body: `${JSON.stringify({ error: {
      message: 'Prompt has 9000 tokens, but the configured context size is 8192 tokens', type: 'invalid_request_error',
      param: 'input', code: 'context_length_exceeded', n_prompt_tokens: 9000, n_ctx: 8192 } })}\n` }] });
    assertFailedVisibly(tooLong, /./);
    assert.equal(tooLong.modelRequests.length, 1, 'a refused request is not retried');
    note(`engine context_length_exceeded is reported by the CLI as: ${JSON.stringify(failure(tooLong))}`);
  });

  await check('stop: the runner interrupts a response in progress and the engine sees the client leave', async () => {
    const partial = turn([{ reasoning: 'Thinking for a long time' }, { text: 'Starting' }]);
    const started = performance.now();
    const result = await codexRun('stop-stream', { timeoutMs: 3000,
      steps: [{ events: partial.events.slice(0, -2), hold: true }] });
    const stopMs = performance.now() - started;
    assert.equal(result.execution.timedOut, true);
    assert.ok(result.execution.code !== 0 || result.execution.signal, 'an interrupted run is not a success');
    assert.ok(stopMs < 7500, `the CLI must stop on SIGTERM, before the 5-second SIGKILL escalation (took ${Math.round(stopMs)} ms)`);
    assert.ok(!result.eventTypes.includes('turn.completed'));
    assert.deepEqual(result.items('reasoning').map((item) => item.text), ['Thinking for a long time'], 'what arrived before Stop stays reported');
    const left = await Promise.race([result.modelRequests[0].closed.then(() => true), sleep(5000).then(() => false)]);
    assert.equal(left, true, 'the engine connection must close when the CLI is stopped, through the proxy');
    assert.equal(analyzeEvents('codex', result.execution.stdout, { expected: 'Starting' }).answerAfterTool, false);
  });

  await check('stop: interrupting a running command keeps its earlier effect and prevents the later one', async () => {
    const marker = `31.${String(process.pid).padStart(6, '0')}${Date.now() % 1000}`;
    const call = turn([{ call: { callId: 'call_slow', arguments: { cmd: `echo early > early.txt; sleep ${marker}; echo late > late.txt` } } }]);
    const result = await codexRun('stop-command', { timeoutMs: 4000, steps: [call, turn([{ text: 'never reached' }])] });
    assert.equal(result.execution.timedOut, true);
    assert.ok(result.execution.code !== 0 || result.execution.signal);
    assert.equal(read(result.workspace, 'early.txt'), 'early\n');
    let survivors = '';
    for (let attempt = 0; attempt < 30; attempt++) {
      survivors = spawnSync('pgrep', ['-f', `sleep ${marker}`], { encoding: 'utf8' }).stdout.trim();
      if (!survivors) break;
      await sleep(100);
    }
    try {
      assert.equal(survivors, '', 'the command started by the CLI must not outlive it');
    } finally {
      for (const pid of survivors.split(/\s+/).filter(Boolean)) try { process.kill(Number(pid), 'SIGKILL'); } catch {}
    }
    assert.ok(!fs.existsSync(path.join(result.workspace, 'late.txt')));
    assert.equal(result.modelRequests.length, 1, 'no tool result is sent for an interrupted command');
    assert.equal(engine.unserved(), 1);
  });

  await check('a running command receives input through write_stdin; both calls are one command in the events', async () => {
    const start = turn([{ call: { callId: 'call_interactive', arguments: { cmd: 'read line; echo "got:$line" > stdin.txt; echo finished', yield_time_ms: 300, tty: true } } }]);
    let session = null;
    const write = (body) => {
      session = /^Process running with session ID (\d+)$/m.exec(resultFor({ body }, 'call_interactive'))?.[1] ?? null;
      return turn([{ call: { callId: 'call_stdin', name: 'write_stdin', arguments: { session_id: Number(session), chars: 'hello\n', yield_time_ms: 2000 } } }]);
    };
    const result = await codexRun('write-stdin', { steps: [start, write, turn([{ text: 'Typed into the command.' }])] });
    assert.equal(result.execution.code, 0, result.execution.stderr);
    assert.ok(session, 'the first result names the running session');
    assert.equal(read(result.workspace, 'stdin.txt'), 'got:hello\n');
    const typed = shellResult(resultFor(result.modelRequests[2], 'call_stdin'));
    assert.equal(typed.exitCode, 0);
    assert.match(typed.output, /finished/);
    assert.deepEqual(result.observed.map((record) => record.toolOutputs), [0, 1, 2]);
    assert.deepEqual(result.items('command_execution').map((item) => [item.exit_code, item.status]), [[0, 'completed']]);
    assert.equal(analyzeEvents('codex', result.execution.stdout, { expected: 'Typed into the command.' }).calls, 1);
  });

  await check('negative: a truncated or reset stream is a failed run, with or without a tool call in it', async () => {
    const text = await codexRun('truncated-text', { steps: [{ ...turn([{ text: 'This answer never completes CODEX_DONE' }]), cutBytes: 60 }] });
    assertFailedVisibly(text, /stream closed before response\.completed/);
    const call = turn([{ call: { callId: 'call_truncated', arguments: { cmd: 'echo effect > effect.txt' } } }]);
    const tool = await codexRun('truncated-call', { steps: [{ ...call, cutBytes: 60 }] });
    assertFailedVisibly(tool, /stream closed before response\.completed/);
    assert.equal(tool.modelRequests.length, 1, 'the CLI must not continue the loop after a broken response');
    note(`a function call whose item arrived whole before the stream broke ${fs.existsSync(path.join(tool.workspace, 'effect.txt'))
      ? 'had already been executed (its file exists)' : 'was not executed'}; the run is reported as failed either way`);
    // The engine connection is reset instead of closed: the proxy must pass the failure on and stay usable.
    const reset = await codexRun('engine-reset', { steps: [{ ...turn([{ text: 'The engine goes away CODEX_DONE' }]), cutBytes: 60, reset: true }] });
    assertFailedVisibly(reset, /stream (?:closed|disconnected)/);
  });

  await check('negative: a malformed terminal frame fails; a malformed extra frame never becomes content', async () => {
    const answer = turn([{ text: 'Text beside a bad frame.' }]);
    const broken = await codexRun('malformed-terminal', { steps: [{ ...answer,
      frames: (frames) => [...frames.slice(0, -1), 'data: {"type":"response.completed","sequence_number":99,"response":{"id":\n\n'] }] });
    assertFailedVisibly(broken, /stream closed before response\.completed/);
    const extra = await codexRun('malformed-extra', { steps: [{ ...turn([{ text: 'Text beside a bad frame.' }]),
      frames: (frames) => [...frames.slice(0, 3), 'data: {"type":"response.output_text.delta","delta":"GARBAGE_FRAME\n\n', ...frames.slice(3)] }] });
    assert.ok(!extra.execution.stdout.includes('GARBAGE_FRAME'));
    assert.deepEqual(extra.items('agent_message').map((item) => item.text), ['Text beside a bad frame.']);
    note(`an unparseable frame between valid ones was skipped by the CLI (exit ${extra.execution.code})`);
  });

  await check('negative: malformed arguments, an unknown tool or a question for the user have no effect and are answered at once', async () => {
    const bad = turn([{ call: { callId: 'call_bad_arguments', arguments: '{"cmd":"echo broken > broken.txt"' } },
      { call: { callId: 'call_unknown_tool', name: 'no_such_tool', arguments: { cmd: 'echo unknown > unknown.txt' } } },
      // Advertised by the CLI, but nobody can answer in a non-interactive run: it must not wait.
      { call: { callId: 'call_ask_user', name: 'request_user_input', arguments: { questions: [{ id: 'choice', header: 'Pick',
        question: 'Which one?', options: [{ label: 'A', description: 'first' }, { label: 'B', description: 'second' }] }] } } }]);
    const result = await codexRun('malformed-call', { timeoutMs: 20_000, steps: [bad, turn([{ text: 'All three calls were refused.' }])] });
    assert.equal(result.execution.timedOut, false);
    assert.equal(result.execution.code, 0, result.execution.stderr);
    assert.deepEqual(fs.readdirSync(result.workspace), []);
    const second = result.modelRequests[1];
    assert.match(resultFor(second, 'call_bad_arguments'), /^failed to parse function arguments: /);
    assert.equal(resultFor(second, 'call_unknown_tool'), 'unsupported call: no_such_tool');
    assert.match(resultFor(second, 'call_ask_user'), /^request_user_input is unavailable/);
    assert.deepEqual(result.items('command_execution'), []);
    assert.equal(analyzeEvents('codex', result.execution.stdout, { expected: 'All three calls were refused.' }).answerAfterTool, false);
  });

  await check('negative: a failing command is reported as failed, with its exit status, to the model and in the events', async () => {
    const call = turn([{ call: { callId: 'call_exit_7', arguments: { cmd: 'echo to-stderr >&2; exit 7' } } }]);
    const result = await codexRun('failing-command', { steps: [call, turn([{ text: 'It failed.' }])] });
    assert.deepEqual(shellResult(resultFor(result.modelRequests[1], 'call_exit_7')), { exitCode: 7, output: 'to-stderr\n' });
    assert.deepEqual(result.items('command_execution').map((item) => [item.exit_code, item.status]), [[7, 'failed']]);
    assert.equal(analyzeEvents('codex', result.execution.stdout, { expected: 'It failed.' }).calls, 1);
  });

  await check('negative: the sandbox confines writes to the workspace and gives commands no network', async () => {
    const where = place('sandbox');
    const unique = `dstudio-codex-escape-${process.pid}-${Date.now()}`;
    const outside = {
      sibling: path.join(where.dir, `${unique}-absolute.txt`),
      relative: path.join(where.dir, `${unique}-relative.txt`),
      home: path.join(where.home, `${unique}-home.txt`),
      slashTmp: path.join('/tmp', `${unique}-tmp.txt`),
      tmpdir: path.join(os.tmpdir(), `${unique}-tmpdir.txt`),
    };
    const probe = `/sandbox-network-probe-${unique}`;
    try {
      const calls = turn([
        { call: { callId: 'call_absolute', arguments: { cmd: `echo escaped > '${outside.sibling}'` } } },
        { call: { callId: 'call_relative', arguments: { cmd: `echo escaped > ../${path.basename(outside.relative)}` } } },
        { call: { callId: 'call_home', arguments: { cmd: `echo escaped > "$HOME/${path.basename(outside.home)}"` } } },
        { call: { callId: 'call_slash_tmp', arguments: { cmd: `echo escaped > '${outside.slashTmp}'` } } },
        { call: { callId: 'call_tmpdir', arguments: { cmd: `echo escaped > '${outside.tmpdir}'` } } },
        { call: { callId: 'call_network', arguments: { cmd: `curl -s -m 5 'http://127.0.0.1:${engine.port}${probe}'; echo "curl_exit=$?"` } } },
        { call: { callId: 'call_inside', arguments: { cmd: 'echo inside > inside.txt && cat inside.txt' } } },
      ]);
      const result = await codexRun('run', { at: where, steps: [calls, turn([{ text: 'Only the workspace was writable.' }])] });
      assert.equal(result.execution.code, 0, result.execution.stderr);
      for (const [name, file] of Object.entries(outside)) assert.ok(!fs.existsSync(file), `${name}: ${file} must not exist`);
      assert.deepEqual(fs.readdirSync(result.workspace), ['inside.txt']);
      assert.equal(read(result.workspace, 'inside.txt'), 'inside\n');
      const second = result.modelRequests[1];
      for (const callId of ['call_absolute', 'call_relative', 'call_home', 'call_slash_tmp', 'call_tmpdir']) {
        const refused = shellResult(resultFor(second, callId));
        assert.notEqual(refused.exitCode, 0, callId);
        assert.match(refused.output, /operation not permitted/i, callId);
      }
      assert.deepEqual(shellResult(resultFor(second, 'call_inside')), { exitCode: 0, output: 'inside\n' });
      assert.match(shellResult(resultFor(second, 'call_network')).output, /curl_exit=[1-9]/);
      assert.ok(!result.requests.some((request) => request.url === probe), 'the sandboxed command must not reach the network');
      note(`of 5 commands refused by the sandbox, ${result.items('command_execution').filter((item) => item.command.includes('escaped')).length} appear as command_execution items in the CLI's JSON events (all 5 results reached the model)`);
    } finally {
      for (const file of Object.values(outside)) fs.rmSync(file, { force: true });
    }
  });

  await check('negative: a request for another model is refused by the pin proxy and never reaches the engine', async () => {
    const result = await codexRun('model-pin', { steps: [turn([{ text: 'must not be served' }])],
      args: ({ workspace }) => codexExecArgs({ workspace, prompt: 'Use another model.' }).map((arg) => (arg === 'ds4' ? 'not-ds4' : arg)) });
    assertFailedVisibly(result, /benchmark model pin rejected a non-ds4 request/);
    assert.deepEqual(result.observed.map((record) => [record.path, record.model]), [['/v1/responses', 'not-ds4']]);
    assert.deepEqual(result.modelRequests, []);
    assert.equal(engine.unserved(), 1);
  });

  await check('isolation: OpenAI and Codex variables and another Codex home do not reach the CLI', async () => {
    const where = place('isolation');
    const decoy = path.join(where.dir, 'decoy-codex-home');
    fs.mkdirSync(decoy);
    fs.writeFileSync(path.join(decoy, 'config.toml'), 'model = "decoy-model"\nmodel_provider = "decoy"\n\n' +
      '[model_providers.decoy]\nname = "decoy"\nbase_url = "http://127.0.0.1:9/v1"\nwire_api = "responses"\n');
    const poisoned = { ...process.env, CODEX_HOME: decoy, CODEX_API_KEY: 'decoy-codex-key', OPENAI_API_KEY: 'decoy-openai-key',
      OPENAI_BASE_URL: 'http://127.0.0.1:9/v1', OPENAI_ORGANIZATION: 'decoy-org', CODEX_SANDBOX: 'decoy',
      ANTHROPIC_AUTH_TOKEN: 'decoy-token', HOME: decoy };
    const cleaned = cleanEnvironment({}, poisoned);
    assert.deepEqual(Object.keys(cleaned).filter((key) => /^(?:OPENAI_|CODEX_)|_API_KEY$|_AUTH_TOKEN$/.test(key)), []);
    assert.equal(cleaned.PATH, process.env.PATH, 'unrelated variables are kept');
    const result = await codexRun('run', { at: where, source: poisoned,
      steps: [turn([{ call: { callId: 'call_env', arguments: { cmd: 'env | grep -c -E "^(OPENAI_|CODEX_API)" ; echo "home=$HOME"' } } }]), turn([{ text: 'Isolated.' }])] });
    assert.equal(result.execution.code, 0, result.execution.stderr);
    assert.deepEqual([result.env.HOME, result.env.CODEX_HOME], [where.home, path.join(where.home, '.codex')]);
    for (const request of result.modelRequests) {
      assert.equal(request.body.model, 'ds4');
      assert.equal(request.headers.authorization, undefined);
      assert.ok(!JSON.stringify(request.headers).includes('decoy'));
    }
    assert.deepEqual(shellResult(resultFor(result.modelRequests[1], 'call_env')), { exitCode: 0, output: `0\nhome=${where.home}\n` });
    assert.deepEqual(fs.readdirSync(decoy), ['config.toml'], 'the other Codex home is neither read into the run nor written');
    assert.ok(fs.readdirSync(path.join(where.home, '.codex')).length > 1, 'the CLI keeps its state in the task-owned home');
  });

  // ---- the benchmark's own task runner and grading, on its real fixture tasks.
  // The scripted server plays a model that solves, or mis-solves, each task.
  const bench = place('benchmark-tasks');
  const fixture = createReliabilityFixture({ workspace: bench.workspace, caseCount: 10, variants: ['codex'] });
  const benchCli = writeCodexConfig({ home: bench.home, baseUrl: proxy.baseUrl, contextTokens: CONTEXT_TOKENS });
  const benchEnv = cleanEnvironment({ ...benchCli.env, PWD: bench.workspace });
  async function graded(label, scenarioId, script) {
    const scenario = fixture.scenarios.find((item) => item.id === scenarioId);
    const task = scenario.variants.codex;
    fixture.resetScenario(scenario, 'codex');
    engine.script(script(task, `cases/${scenarioId}/codex`));
    engine.take();
    const { result, execution } = await runCompetitor({ proxy, harness: 'codex', scenario, workspace: bench.workspace,
      command: codexCommand({ workspace: bench.workspace, prompt: task.prompt, env: benchEnv }), timeoutMs: 60_000 });
    fs.writeFileSync(path.join(bench.dir, `${label}-stdout.jsonl`), execution.stdout);
    fs.writeFileSync(path.join(bench.dir, `${label}-stderr.txt`), execution.stderr);
    fs.writeFileSync(path.join(bench.dir, `${label}-result.json`), JSON.stringify(result, null, 2));
    fs.writeFileSync(path.join(bench.dir, `${label}-engine-requests.json`), JSON.stringify(engine.take(), null, 2));
    allBlocked.push(...result.protocol.blockedOutbound.map((attempt) => `${label}: ${attempt}`));
    return result;
  }
  const shell = (callId, cmd) => ({ call: { callId, arguments: { cmd } } });

  await check('benchmark task, file creation: a correct scripted solution is graded as a success by the runner', async () => {
    const result = await graded('write-correct', 'write-exact-file-01', (task, dir) => [
      turn([shell('call_write', `printf 'status=ready\\nbatch=41\\n' > ${dir}/output.env`)]),
      turn([{ text: `Created output.env. ${task.expected}` }])]);
    const { wallClockMs, ...stable } = result;
    assert.ok(wallClockMs > 0);
    assert.deepEqual(stable, {
      variant: 'codex', scenario: 'write-exact-file-01', taskType: 'write-exact-file',
      taskSuccess: true, expectedAnswerAfterTool: true, incorrectCompletionClaim: false,
      externalCheck: { ok: true },
      changedFiles: ['cases/write-exact-file-01/codex/output.env'], unexpectedChanges: [],
      toolStats: { calls: 1, maximumRepeated: 1 },
      humanRecoveryInterventions: 0,
      process: { exitCode: 0, signal: null, timedOut: false, outputOverflow: false, spawnError: null },
      protocol: { parsedEvents: 7, modelRequests: 2, modelPinVerified: true, requestsWithToolSchemas: 2,
        requestedModels: ['ds4'], toolOutputsSent: 1, compactionRequests: 0, nativeReasoningEfforts: ['none'], blockedOutbound: [] },
    });
  });

  await check('benchmark task, file creation: a wrong file or a touched bystander file with a completion claim is not a success', async () => {
    const wrong = await graded('write-wrong', 'write-exact-file-01', (task, dir) => [
      turn([shell('call_write', `printf 'status=ready\\nbatch=99\\n' > ${dir}/output.env`)]),
      turn([{ text: `Created output.env. ${task.expected}` }])]);
    assert.deepEqual([wrong.taskSuccess, wrong.incorrectCompletionClaim, wrong.externalCheck.ok, wrong.unexpectedChanges],
      [false, true, false, []]);
    const bystander = await graded('write-bystander', 'write-exact-file-01', (task, dir) => [
      turn([shell('call_write', `printf 'status=ready\\nbatch=41\\n' > ${dir}/output.env; echo tampered >> ${dir}/instructions.txt`)]),
      turn([{ text: `Created output.env. ${task.expected}` }])]);
    assert.deepEqual([bystander.taskSuccess, bystander.incorrectCompletionClaim, bystander.externalCheck.ok, bystander.unexpectedChanges],
      [false, true, true, ['cases/write-exact-file-01/codex/instructions.txt']]);
  });

  await check('benchmark task, reading: the answer must follow a real tool result and contain the fact', async () => {
    const answered = await graded('read-correct', 'read-fact-01', (task, dir) => [
      turn([shell('call_read', `cat ${dir}/project.txt`)]),
      // The scripted reply quotes the tool result the CLI actually sent back.
      (body) => turn([{ text: `${/Release code: \S+/.exec(resultFor({ body }, 'call_read'))[0]} ${task.expected}` }])]);
    assert.deepEqual([answered.taskSuccess, answered.changedFiles, answered.toolStats.calls], [true, [], 1]);
    const guessed = await graded('read-no-tool', 'read-fact-01', (task) => [
      turn([{ text: `${task.answerMustContain[0]} ${task.expected}` }])]);
    assert.deepEqual([guessed.taskSuccess, guessed.expectedAnswerAfterTool, guessed.toolStats.calls], [false, false, 0],
      'a correct answer produced without any tool call is not a completed task');
    const vague = await graded('read-wrong-fact', 'read-fact-01', (task, dir) => [
      turn([shell('call_read', `cat ${dir}/project.txt`)]), turn([{ text: `Release code: UNKNOWN ${task.expected}` }])]);
    assert.deepEqual([vague.taskSuccess, vague.expectedAnswerAfterTool, vague.incorrectCompletionClaim], [false, false, false]);
  });

  await check('benchmark task, code repair: the fixture test runs inside the CLI sandbox and decides the grade', async () => {
    const repaired = await graded('repair-correct', 'repair-code-01', (task, dir) => [
      turn([shell('call_fix', `printf 'def total(a, b):\\n    return a + b\\n' > ${dir}/app.py && python3 ${dir}/test_app.py`)]),
      (body) => turn([{ text: `${shellResult(resultFor({ body }, 'call_fix')).output.trim()} ${task.expected}` }])]);
    assert.deepEqual([repaired.taskSuccess, repaired.externalCheck.ok, repaired.unexpectedChanges], [true, true, []], JSON.stringify(repaired));
    assert.ok(repaired.changedFiles.includes('cases/repair-code-01/codex/app.py'));
    const unrepaired = await graded('repair-claimed', 'repair-code-01', (task, dir) => [
      turn([shell('call_run', `python3 ${dir}/test_app.py; echo exit=$?`)]), turn([{ text: `Fixed. ${task.expected}` }])]);
    assert.deepEqual([unrepaired.taskSuccess, unrepaired.incorrectCompletionClaim, unrepaired.externalCheck.ok], [false, true, false]);
  });

  await check('benchmark task: a correct file and answer do not count when the response stream broke', async () => {
    const result = await graded('write-truncated', 'write-exact-file-01', (task, dir) => [
      turn([shell('call_write', `printf 'status=ready\\nbatch=41\\n' > ${dir}/output.env`)]),
      { ...turn([{ text: `Created output.env. ${task.expected}` }]), cutBytes: 60 }]);
    assert.deepEqual([result.taskSuccess, result.process.exitCode, result.externalCheck.ok, result.expectedAnswerAfterTool],
      [false, 1, true, true]);
  });

  await check('the pin proxy refuses and records anything that is not the local engine API', async () => {
    proxy.begin('outbound');
    let observed;
    try {
      const connect = await new Promise((resolve, reject) => {
        const socket = net.connect(Number(new URL(proxy.baseUrl).port), '127.0.0.1');
        let reply = '';
        socket.on('connect', () => socket.write('CONNECT service.invalid:443 HTTP/1.1\r\nHost: service.invalid:443\r\n\r\n'));
        socket.on('data', (chunk) => { reply += chunk; });
        socket.on('close', () => resolve(reply));
        socket.on('error', reject);
      });
      assert.match(connect, /^HTTP\/1\.1 403 /);
      const absolute = await new Promise((resolve, reject) => {
        http.request({ host: '127.0.0.1', port: new URL(proxy.baseUrl).port, method: 'GET', path: 'http://service.invalid/v1/models' },
          (response) => { response.resume(); response.on('end', () => resolve(response.statusCode)); }).on('error', reject).end();
      });
      assert.equal(absolute, 403);
    } finally {
      observed = proxy.end('outbound');
    }
    assert.deepEqual(observed, [
      { path: 'service.invalid:443', method: 'CONNECT', blocked: true },
      { path: 'http://service.invalid/v1/models', method: 'GET', blocked: true },
    ]);
    assert.deepEqual(engine.take(), [], 'neither attempt is forwarded to the engine');
    assert.deepEqual(allBlocked, [], 'no CLI run in this test tried to reach anything but the local engine');
  });
} finally {
  clearTimeout(watchdog);
  await proxy.close();
  await engine.close();
  // The CLI leaves about 2.5 MB of its own SQLite state in every home. The
  // evidence is the configuration, the output and the requests kept beside it.
  for (const home of homes) {
    const codexHome = path.join(home, '.codex');
    for (const entry of fs.existsSync(codexHome) ? fs.readdirSync(codexHome) : [])
      if (entry !== 'config.toml') fs.rmSync(path.join(codexHome, entry), { recursive: true, force: true });
  }
  const count = (status) => receipt.cases.filter((row) => row.status === status).length;
  receipt.summary = { passed: count('PASS'), failed: count('FAIL'), blocked: count('BLOCKED') };
  fs.writeFileSync(path.join(run, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(`codex_responses_protocol: ${receipt.summary.passed} passed, ${receipt.summary.failed} failed, ${receipt.summary.blocked} blocked · scripted server, no model`);
  console.log(`Evidence: ${run}`);
}

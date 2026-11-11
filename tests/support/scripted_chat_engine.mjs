// A scripted loopback server that speaks the Chat Completions API the way
// ds4-server does, for the third-party CLIs that use it (Pi, OpenCode).
// Scripted replies only: no model. Used by the six-agent lane mechanics test
// (tests/integration/agent_lane_mechanics_test.mjs).
//
// Wire shape, from the chat emitters of the pinned src/engines/ds4/ds4_server.c
// (sse_headers, sse_chunk, sse_chat_tool_call_start_delta,
// sse_chat_tool_call_args_delta_n, sse_usage_chunk, sse_done): `data:` lines
// only, a first chunk with the assistant role, content deltas, a tool call
// started with its id, name and empty arguments followed by argument deltas, a
// last chunk with an empty delta and the finish reason, the usage chunk when
// the client asked for it, `data: [DONE]`, and the body delimited by
// connection close. It does NOT model tokenization, prompt rendering, the
// DSML tool format the engine parses, KV reuse or real timings.
import http from 'node:http';

let serial = 0;
const nextId = (prefix) => `${prefix}${(++serial).toString(16).padStart(20, '0')}`;
function pieces(text, count = 3) {
  const points = Array.from(text);
  const size = Math.max(1, Math.ceil(points.length / count));
  const result = [];
  for (let offset = 0; offset < points.length; offset += size) result.push(points.slice(offset, offset + size).join(''));
  return result;
}

// parts: { text } | { call: { id?, name, arguments } }. The finish reason is
// `tool_calls` when a call is present, else `stop`, unless `finish` says otherwise.
export function chatTurn(parts, { finish, usage = { prompt: 100, completion: 10 } } = {}) {
  const id = nextId('chatcmpl-');
  const chunk = (delta, finishReason = null) => ({
    id, object: 'chat.completion.chunk', created: 1767225600, model: 'ds4',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  });
  const chunks = [chunk({ role: 'assistant' })];
  let calls = 0;
  for (const part of parts) {
    if (part.text !== undefined) {
      for (const delta of pieces(part.text)) chunks.push(chunk({ content: delta }));
    } else {
      const index = calls++;
      const args = typeof part.call.arguments === 'string' ? part.call.arguments : JSON.stringify(part.call.arguments);
      const callId = part.call.id || `${id}_tool_${index}`;
      chunks.push(chunk({ tool_calls: [{ index, id: callId, type: 'function', function: { name: part.call.name, arguments: '' } }] }));
      for (const delta of pieces(args)) chunks.push(chunk({ tool_calls: [{ index, function: { arguments: delta } }] }));
    }
  }
  chunks.push(chunk({}, finish || (calls ? 'tool_calls' : 'stop')));
  return {
    id, chunks,
    usage: {
      prompt_tokens: usage.prompt, completion_tokens: usage.completion, total_tokens: usage.prompt + usage.completion,
      prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
    },
  };
}

// What an OpenAI-compatible server refuses in a chat request: a tool result
// whose call id no earlier assistant message of the same request declared.
function contractError(body) {
  if (!body || typeof body !== 'object') return 'invalid JSON request';
  if (!Array.isArray(body.messages) || !body.messages.length) return 'missing messages';
  if (body.stream !== true) return 'the scripted engine only streams';
  const declared = new Set();
  for (const message of body.messages) {
    if (message?.role === 'assistant') for (const call of message.tool_calls || []) declared.add(call.id);
    if (message?.role === 'tool' && !declared.has(message.tool_call_id))
      return `tool result for an undeclared call id ${message.tool_call_id}`;
  }
  return null;
}

export async function startScriptedChatEngine() {
  const received = [];
  const violations = [];
  const sockets = new Set();
  let queue = [];
  const errorBody = (message) => `${JSON.stringify({ error: { message, type: 'invalid_request_error' } })}\n`;
  async function handle(request, response, raw) {
    const socket = response.socket;
    let body = null;
    try { body = raw.length ? JSON.parse(raw.toString('utf8')) : null; } catch {}
    const record = { method: request.method, url: request.url, headers: request.headers, bytes: raw.length, body, served: false };
    received.push(record);
    const reply = (status, text) => socket.end(`HTTP/1.1 ${status} ${status === 200 ? 'OK' : 'Error'}\r\n` +
      `Content-Length: ${Buffer.byteLength(text)}\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n${text}`);
    if (request.method === 'GET' && request.url === '/v1/models')
      return reply(200, `${JSON.stringify({ object: 'list', data: [{ id: 'deepseek-v4-flash', object: 'model', created: 1767225600, owned_by: 'ds4.c' }] })}\n`);
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') return reply(404, errorBody('unknown endpoint'));
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
    const frames = plan.chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`);
    if (body.stream_options?.include_usage)
      frames.push(`data: ${JSON.stringify({ id: plan.id, object: 'chat.completion.chunk', created: 1767225600, model: 'ds4', choices: [], usage: plan.usage })}\n\n`);
    frames.push('data: [DONE]\n\n');
    for (const frame of frames) {
      if (socket.destroyed) break;
      socket.write(frame);
      await new Promise((resolve) => setImmediate(resolve));
    }
    record.served = true;
    if (!plan.hold) socket.end(); // a held stream ends only when the client goes away
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

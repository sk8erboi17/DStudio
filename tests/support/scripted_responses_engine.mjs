// A scripted loopback server that speaks the Responses API the way ds4-server
// does. Scripted replies only: no model. Used by the test that drives the
// installed Codex CLI (tests/integration/codex_responses_protocol_test.mjs).
import http from 'node:http';

// Event shapes, their order and the wire framing (`data:` lines only, a
// sequence_number after the type, a body delimited by connection close) follow
// the responses_sse_* emitters of the pinned src/engines/ds4/ds4_server.c.
let serial = 0;
const nextId = (prefix) => `${prefix}${(++serial).toString(16).padStart(24, '0')}`;
export const usageOf = (input = 100, output = 10, cached = 0) => ({
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
export function turn(parts, { usage = usageOf(), end = 'completed' } = {}) {
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

export async function startScriptedEngine() {
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

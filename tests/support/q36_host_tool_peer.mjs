#!/usr/bin/env node
// Controlled inference peer for native host/tool tests. No model or GPU.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
const arg = key => process.argv[process.argv.indexOf(key) + 1];
assert.equal(arg('--dstudio-owner-fd'), '3');
const identity = file => {
  const s = fs.statSync(file, { bigint: true });
  return [s.dev, s.ino, s.size, s.mtimeNs / 1000000000n, s.mtimeNs % 1000000000n,
    s.ctimeNs / 1000000000n, s.ctimeNs % 1000000000n].join(':');
};
const owner = new net.Socket({ fd: 3, readable: true, writable: true });
owner.on('end', () => process.exit(0)); owner.on('error', () => process.exit(0)); owner.resume();
fs.mkdirSync('requests', { recursive: true });
fs.appendFileSync('fixture-launches', `${process.pid}\n`);
let sequence = 0;
const server = http.createServer(async (request, response) => {
  const chunks = []; let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length; assert(bytes <= 1024 * 1024, 'Fixture body limit'); chunks.push(chunk);
  }
  if (request.url === '/v1/models') {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ data: [{ id: 'qwen3.8-27b' }] })); return;
  }
  assert.equal(request.url, '/v1/chat/completions');
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const name = `requests/${process.pid}-${++sequence}`;
  fs.writeFileSync(`${name}.request.preparing`, JSON.stringify({ body, headers: request.headers }), { flag: 'wx' });
  fs.renameSync(`${name}.request.preparing`, `${name}.request.json`);
  const timer = setInterval(() => {
    if (!fs.existsSync(`${name}.response.json`)) return;
    clearInterval(timer);
    const reply = JSON.parse(fs.readFileSync(`${name}.response.json`, 'utf8'));
    if (reply.error) {
      response.writeHead(reply.status || 400, { 'content-type': 'application/json', 'connection': 'close' });
      response.end(JSON.stringify({ error: { message: reply.error } })); return;
    }
    response.writeHead(200, { 'content-type': 'text/event-stream', 'connection': 'close' });
    const delta = reply.tools
      ? { tool_calls: reply.tools.map((call, index) => ({ index, ...call })) }
      : { content: reply.text || 'Completed.' };
    response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: reply.tools ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`);
  }, 10);
  response.on('close', () => {
    clearInterval(timer); fs.writeFileSync(`${name}.closed`, response.writableFinished ? 'complete' : 'interrupted');
  });
});
server.listen(Number(arg('--port')), '127.0.0.1', () => owner.write(JSON.stringify({ version: 1,
  event: 'ready', pid: process.pid, host: '127.0.0.1', port: Number(arg('--port')),
  context: Number(arg('--ctx')), model: 'qwen3.8-27b', backend: 'metal', cache_k: 'f16', cache_v: 'f16',
  ssd_streaming: false, model_file: identity(arg('--model')), vision_file: identity(arg('--vision')), mtp_file: '' }) + '\n'));

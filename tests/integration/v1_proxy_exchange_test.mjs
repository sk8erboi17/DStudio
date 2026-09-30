// Real native HTTP relay and sockets; the engine is a loopback fixture.
// No weights, inference, external service or user's engine is involved.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {freePort, sleep} from '../support/real_harness.mjs';

const root = path.resolve('tests/.artifacts/v1-proxy-exchange');
fs.mkdirSync(root, {recursive: true});
const run = fs.mkdtempSync(path.join(root, 'run-'));
const engine = path.join(run, 'empty-engine'); fs.mkdirSync(engine);
const binary = path.resolve(process.argv[2] || 'tests/.build/dstudio-server-test');
const report = {scope: 'Native HTTP with simulated engine responses; no inference',
  binarySHA256: crypto.createHash('sha256').update(fs.readFileSync(binary)).digest('hex'),
  limitations: ['The existing /v1 relay treats TCP request EOF as cancellation; request half-close is not supported.'], cases: []};
const backendSockets = new Set(), clients = new Set();
let expected, connections = 0;
function deferred() { let resolve; const promise = new Promise(r => {resolve = r;}); return {promise, resolve}; }
const backend = net.createServer(socket => {
  backendSockets.add(socket); connections++;
  const current = expected; assert.ok(current, 'Unexpected or duplicate engine connection');
  let bytes = Buffer.alloc(0), complete = false;
  socket.on('error', error => {current.resetCode = error.code;});
  socket.on('close', () => {backendSockets.delete(socket); current.closed.resolve();});
  socket.on('data', chunk => {
    bytes = Buffer.concat([bytes, chunk]);
    if (bytes.length >= current.header.length) current.headersReceived.resolve();
    if (!complete && bytes.length >= current.request.length) {
      complete = true; current.received.resolve(bytes);
      if (!current.hold) {
        // Fragment both HTTP headers and the response body at exact byte offsets.
        socket.write(current.response.subarray(0, 13));
        setImmediate(() => socket.end(current.response.subarray(13)));
      }
    }
  });
});
backend.listen(0, '127.0.0.1'); await once(backend, 'listening');
const enginePort = backend.address().port;
const hostPort = await freePort(), base = `http://127.0.0.1:${hostPort}`;
const log = fs.openSync(path.join(run, 'host.log'), 'wx');
const host = spawn(binary, [String(hostPort), engine], {stdio: ['ignore', log, log],
  env: {...process.env, DS4UI_TEST_MODE: '1', DS4UI_NO_WINDOW: '1',
    DS4UI_DEFER_ENGINE_START: '1', DS4UI_HOST: '127.0.0.1',
    DS4UI_DATA_DIR: path.join(run, 'profile'), DS4UI_ENGINE_PORT: String(enginePort)}});
fs.closeSync(log);
const exited = new Promise(resolve => {host.once('exit', resolve); host.once('error', resolve);});
const watchdog = setTimeout(() => {
  for (const socket of [...clients, ...backendSockets]) socket.destroy();
  host.kill('SIGTERM');
  throw Error('Isolated proxy test exceeded its 20-second bound');
}, 20000);

async function openCall({method = 'POST', url = '/v1/chat/completions', body = Buffer.alloc(0),
                         response = Buffer.from('HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n{}'),
                         hold = false, fragmented = false, halfClose = false} = {}) {
  const header = Buffer.from(`${method} ${url} HTTP/1.1\r\nHost: 127.0.0.1:${enginePort}\r\n` +
    (body.length ? `Accept: text/event-stream\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\n` : 'Accept: application/json\r\n') +
    'Connection: close\r\n\r\n');
  expected = {header, request: Buffer.concat([header, body]), response, hold,
    headersReceived: deferred(), received: deferred(), closed: deferred(), resetCode: ''};
  const call = expected, beforeConnections = connections;
  const socket = net.connect(hostPort, '127.0.0.1'); clients.add(socket);
  const chunks = []; socket.on('data', chunk => chunks.push(chunk));
  socket.on('close', () => clients.delete(socket));
  const returned = new Promise((resolve, reject) => {
    socket.once('error', reject); socket.once('end', () => resolve(Buffer.concat(chunks)));
  });
  returned.catch(() => {}); // Stop deliberately abandons this response.
  await once(socket, 'connect');
  const clientHeader = Buffer.from(`${method} ${url} HTTP/1.1\r\nHost: localhost\r\n` +
    'Accept: */*\r\nAuthorization: Bearer isolated-fixture\r\nX-Requested-With: ds4web\r\n' +
    `Content-Length: ${body.length}\r\nConnection: close\r\n\r\n`);
  if (fragmented) {
    socket.write(Buffer.concat([clientHeader, body.subarray(0, 17)]));
    await call.headersReceived.promise; // Prove the relay is waiting for the remaining body.
    for (let offset = 17; offset < body.length; offset += 137) socket.write(body.subarray(offset, offset + 137));
  } else socket.write(Buffer.concat([clientHeader, body]));
  if (halfClose) socket.end();
  assert.deepEqual(await call.received.promise, call.request, 'Preserve method, full path, minimal headers and every body byte');
  assert.equal(connections, beforeConnections + 1, 'An HTTP request is forwarded exactly once');
  return {call, socket, returned};
}
async function check(name, fn) {
  const row = {name};
  try {await fn(); row.status = 'PASS';}
  catch (error) {row.status = 'FAIL'; row.error = error.stack; process.exitCode = 1;}
  report.cases.push(row); console.log(`${row.status}: ${name}${row.error ? '\n' + row.error : ''}`);
}
try {
  const deadline = Date.now() + 5000; let ready = false;
  while (!ready && Date.now() < deadline) {
    assert.equal(host.exitCode, null, 'Task-owned native host exited before listening');
    try {const res = await fetch(base + '/api/status', {signal: AbortSignal.timeout(500)});
      const state = await res.json(); ready = res.status === 200;
      assert.equal(state.running, false, 'The isolated host must not launch an engine');}
    catch {await sleep(25);}
  }
  assert.ok(ready, 'Task-owned native host did not listen');
  await check('GET preserves the engine response', async () => {
    const result = await openCall({method: 'GET', url: '/v1/models'});
    assert.deepEqual(await result.returned, result.call.response);
  });
  await check('TCP request EOF retains the existing cancellation policy', async () => {
    const result = await openCall({method: 'GET', url: '/v1/models', hold: true, halfClose: true});
    await result.call.closed.promise;
    assert.equal(result.call.resetCode, 'ECONNRESET');
    assert.equal((await result.returned).length, 0);
  });
  await check('empty POST uses the existing JSON header contract', async () => {
    const result = await openCall(); assert.deepEqual(await result.returned, result.call.response);
  });
  await check('buffered JSON and engine error bytes survive intact', async () => {
    const response = Buffer.concat([Buffer.from('HTTP/1.1 503 Service Unavailable\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n'), Buffer.from('{"error":"è preserved"}\n\0binary')]);
    const result = await openCall({body: Buffer.from('{"messages":[{"content":"Città e perché"}]}'), response});
    assert.deepEqual(await result.returned, response);
  });
  await check('fragmented body larger than the host buffer preserves UTF-8 and SSE bytes', async () => {
    const body = Buffer.from(JSON.stringify({messages: [{content: 'è🙂'.repeat(9000)}]}));
    const response = Buffer.from('HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\ndata: {"content":"è🙂"}\n\ndata: [DONE]\n\n');
    const result = await openCall({body, response, fragmented: true});
    assert.deepEqual(await result.returned, response);
  });
  await check('a blocked engine leaves status responsive and client Stop resets only its call', async () => {
    const result = await openCall({body: Buffer.from('{"stream":true}'), hold: true});
    const res = await fetch(base + '/api/status', {signal: AbortSignal.timeout(2000)});
    assert.equal(res.status, 200); assert.equal((await res.json()).running, false);
    result.socket.destroy(); await result.call.closed.promise;
    assert.equal(result.call.resetCode, 'ECONNRESET', 'Stop must reach the engine before response headers');
    const next = await openCall({method: 'GET', url: '/v1/models'});
    assert.deepEqual(await next.returned, next.call.response, 'A stopped call cannot poison the next request');
  });
  await check('the full supported request path fits in the forwarded HTTP header', async () => {
    const prefix = '/v1/models?probe=';
    const url = prefix + 'x'.repeat(1023 - prefix.length);
    for (const method of ['GET', 'POST']) {
      const result = await openCall({method, url, body: method === 'POST' ? Buffer.from('{"messages":[]}') : Buffer.alloc(0)});
      assert.deepEqual(await result.returned, result.call.response);
    }
  });
} finally {
  clearTimeout(watchdog);
  for (const socket of [...clients, ...backendSockets]) socket.destroy();
  backend.close(); await once(backend, 'close');
  host.kill('SIGTERM');
  const escalation = setTimeout(() => host.kill('SIGKILL'), 3000);
  await exited; clearTimeout(escalation);
  fs.writeFileSync(path.join(run, 'receipt.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`Evidence: ${run}`);
}

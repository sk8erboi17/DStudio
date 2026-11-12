// The engine process dies while a Chat answer streams. Production page in a
// real browser; the real native host relays /v1 to a SCRIPTED engine process
// (no model, no weights) that this test kills with SIGKILL mid-answer. The
// UI fixture pipes the page's completion request to the host byte for byte;
// every other page endpoint is the simulated launcher of ui_mock_server.mjs.
//   node tests/browser/ui_chat_engine_death_playwright_test.mjs [tests/.build/dstudio-server-test]
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {chromium, webkit} from 'playwright';
import {uiMockServer, seedUi} from '../support/ui_mock_server.mjs';
import {artifactRunDir, freePort, sleep, writeArtifact} from '../support/real_harness.mjs';

const browserName = process.env.DSTUDIO_TEST_BROWSER || 'chromium';
assert.ok(['chromium', 'webkit'].includes(browserName));
const binary = path.resolve(process.argv[2] || 'tests/.build/dstudio-server-test');
const run = artifactRunDir(`chat-engine-death-${browserName}`);
const report = {scope: 'Production Chat page and real host /v1 relay; SCRIPTED engine process killed mid-answer; no inference',
  browser: browserName, cases: [], status: 'RUNNING'};
console.log('Engine-death evidence:', run);

// The scripted engine: one process, one answer. It streams two content chunks
// in the named framing, reports on stdout, and then waits until it is killed.
// "ds4": close-delimited SSE as ds4-server writes it (Connection: close).
// "llama": chunked SSE as llama-server (cpp-httplib) writes it.
// "complete": a full ds4-framed answer that ends with [DONE].
const ENGINE = String.raw`
const net = require('node:net');
const [port, framing] = process.argv.slice(1);
const chunk = (content, finish = null) => 'data: ' + JSON.stringify({id: 'chatcmpl-fixture', object: 'chat.completion.chunk',
  created: 1767225600, model: 'deepseek-v4-flash', choices: [{index: 0, delta: content === null ? {} : {content}, finish_reason: finish}]}) + '\n\n';
const server = net.createServer(socket => {
  let bytes = Buffer.alloc(0), answered = false;
  socket.on('error', () => {});
  socket.on('data', data => {
    bytes = Buffer.concat([bytes, data]);
    const end = bytes.indexOf('\r\n\r\n');
    if (answered || end < 0) return;
    const length = Number((/content-length:\s*(\d+)/i.exec(bytes.subarray(0, end).toString()) || [])[1] || 0);
    if (bytes.length < end + 4 + length) return;
    answered = true;
    const events = [chunk('Partial answer before '), chunk('the engine died.')];
    if (framing === 'llama') {
      socket.write('HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n');
      for (const event of events) socket.write(Buffer.byteLength(event).toString(16) + '\r\n' + event + '\r\n');
    } else {
      socket.write('HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nConnection: close\r\n\r\n');
      if (framing === 'complete') return socket.end(chunk('Answer after the engine restarted.') + chunk(null, 'stop') + 'data: [DONE]\n\n');
      for (const event of events) socket.write(event);
    }
    process.stdout.write('streamed\n');
  });
});
server.listen(Number(port), '127.0.0.1', () => process.stdout.write('listening\n'));
`;
const enginePort = await freePort(), hostPort = await freePort(), hostBase = `http://127.0.0.1:${hostPort}`;
function startEngine(framing) {
  const child = spawn(process.execPath, ['-e', ENGINE, String(enginePort), framing], {stdio: ['ignore', 'pipe', 'inherit']});
  const lines = [];
  child.stdout.on('data', data => lines.push(...String(data).trim().split('\n')));
  const until = async word => { for (let i = 0; i < 400 && !lines.includes(word); i++) await sleep(25); assert.ok(lines.includes(word), `engine: ${word}`); };
  return {child, until, framing};
}
async function killEngine(engine) {
  if (engine.child.exitCode !== null || engine.child.signalCode !== null) return;
  const exited = once(engine.child, 'exit');
  engine.child.kill('SIGKILL');
  await exited;
}

const profile = path.join(run, 'profile');
fs.mkdirSync(profile, {recursive: true});
const log = fs.openSync(path.join(run, 'host.log'), 'wx');
const host = spawn(binary, [String(hostPort), path.join(run, 'empty-engine')], {stdio: ['ignore', log, log],
  env: {...process.env, DS4UI_DATA_DIR: profile, DS4UI_HOST: '127.0.0.1', DS4UI_NO_WINDOW: '1', DS4UI_TEST_MODE: '1',
    DS4UI_DEFER_ENGINE_START: '1', DS4UI_ENGINE_PORT: String(enginePort)}});
fs.closeSync(log);
const hostExited = new Promise(resolve => host.once('exit', resolve));
const requests = [];
// Byte pipe from the page to the real host relay. A close-delimited engine
// body ends cleanly; a truncated chunked body is a broken connection.
const ui = await uiMockServer(async (req, res, url) => {
  if (url.pathname !== '/v1/chat/completions') return false;
  const parts = []; for await (const part of req) parts.push(part);
  const body = Buffer.concat(parts); requests.push(JSON.parse(body));
  const upstream = http.request(hostBase + url.pathname, {method: 'POST', headers: {'content-type': 'application/json',
    accept: 'text/event-stream', 'x-requested-with': 'ds4web', 'content-length': body.length}}, reply => {
    res.writeHead(reply.statusCode, {'content-type': reply.headers['content-type'] || 'application/json', 'cache-control': 'no-cache'});
    reply.on('data', data => res.write(data));
    reply.on('error', () => {});
    reply.on('close', () => reply.complete ? res.end() : res.destroy());
  });
  upstream.on('error', () => res.destroy());
  upstream.end(body);
  return true;
});
let browser, engine;
async function check(name, fn) {
  const row = {name}; report.cases.push(row);
  try { await fn(); row.status = 'PASS'; console.log('PASS:', name); }
  catch (error) { row.status = 'FAIL'; row.error = String(error.stack || error); throw error; }
  finally { writeArtifact(run, 'results.json', report); }
}
try {
  for (let i = 0; i < 200; i++) {
    assert.equal(host.exitCode, null, 'the native test host exited');
    try { if ((await fetch(hostBase + '/api/status')).ok) break; } catch {}
    await sleep(25);
  }
  browser = await ({chromium, webkit})[browserName].launch();
  const page = await browser.newPage({viewport: {width: 1100, height: 820}});
  page.setDefaultTimeout(8000);
  const evidence = await seedUi(page, ui.origin);
  await page.goto(ui.origin);
  const last = page.locator('.msg--assistant').last();
  const saved = () => page.evaluate(() => {
    const id = JSON.parse(localStorage.getItem('ds4web.active.v2')).ids.chat;
    return JSON.parse(localStorage.getItem('ds4web.chats.v2')).chats.find(chat => chat.id === id);
  });
  const partial = 'Partial answer before the engine died.';
  const hostStatus = async () => { const res = await fetch(hostBase + '/api/status', {signal: AbortSignal.timeout(2000)}); assert.equal(res.status, 200); return res.json(); };

  const ended = ['Response incomplete: stream ended before data: [DONE].', 'incomplete', 'Response incomplete', 'Continue'];
  const broken = ['Connection interrupted during the response.', 'error', 'Response failed', 'Retry'];
  // A close-delimited body simply ends. A chunked body cut before its last
  // chunk is a network error in Chromium; WebKit's fetch reports it as the
  // end of the body, so the page sees an incomplete stream there.
  for (const [framing, marker, finishReason, announcement, action] of [
    ['ds4', ...ended], ['llama', ...(browserName === 'webkit' ? ended : broken)],
  ]) await check(`${framing} framing: the partial text is kept and the failure is reported`, async () => {
    engine = startEngine(framing);
    await engine.until('listening');
    await page.locator('#btn-new-chat').click();
    await page.locator('#composer-input').fill(`Question answered by the ${framing} engine.`);
    await page.locator('#btn-send').click();
    await engine.until('streamed');
    await last.locator('.md').filter({hasText: partial}).waitFor();
    await killEngine(engine);
    await last.locator('.msg__meta').filter({hasText: marker}).waitFor();
    await page.locator('#btn-stop').waitFor({state: 'hidden'});
    const message = (await saved()).messages.at(-1);
    assert.equal(message.content, partial, 'every streamed byte before the death is saved');
    assert.equal(message.finishReason, finishReason);
    assert.match(message.error.message, new RegExp(marker.replace(/[.[\]]/g, '\\$&')));
    assert.equal(await last.locator('.md').first().textContent(), partial, 'the partial text stays on screen');
    assert.equal(await page.locator('#sr-status').textContent(), announcement);
    assert.ok(await last.getByRole('button', {name: action, exact: true}).isVisible());
    await page.screenshot({path: path.join(run, `${framing}-died.png`)});
    // The host stays responsive, and the same conversation goes on once an
    // engine listens again on the port.
    assert.equal((await hostStatus()).running, false, 'this host does not own the scripted engine');
    engine = startEngine('complete');
    await engine.until('listening');
    const count = (await saved()).messages.length;
    await last.getByRole('button', {name: action, exact: true}).click();
    await last.locator('.md').filter({hasText: 'Answer after the engine restarted.'}).waitFor();
    await page.locator('#btn-stop').waitFor({state: 'hidden'});
    const after = await saved();
    if (action === 'Continue') {
      assert.equal(after.messages.length, count + 2);
      assert.equal(after.messages[count - 1].content, partial, 'Continue keeps the cut answer');
      assert.deepEqual(requests.at(-1).messages.slice(-2), [{role: 'assistant', content: partial}, {role: 'user', content: 'Continue.'}]);
    } else assert.equal(after.messages.length, count, 'Retry replaces the failed answer');
    assert.equal(after.messages.at(-1).finishReason, 'stop');
    await killEngine(engine);
  });
  assert.deepEqual(evidence.errors, []); assert.deepEqual(evidence.external, []); assert.deepEqual(ui.missing, []);
  report.status = 'PASS';
} catch (error) {
  report.status = 'FAIL'; report.error = String(error.stack || error);
  throw error;
} finally {
  writeArtifact(run, 'results.json', report);
  if (engine) await killEngine(engine);
  await browser?.close().catch(() => {});
  ui.close();
  if (host.exitCode === null) host.kill('SIGTERM');
  await hostExited;
}

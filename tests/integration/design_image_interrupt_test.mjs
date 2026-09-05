import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const designBin = path.join(root, 'ds4', 'ds4-design');
assert.equal(fs.existsSync(designBin), true, 'ds4-design must be built');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ds4-design-image-interrupt-'));
const workspace = path.join(tmp, 'workspace');
const home = path.join(tmp, 'home');
fs.mkdirSync(workspace, { recursive: true });
fs.mkdirSync(home, { recursive: true });

const sockets = new Set();
let child;
let generatedJob = '';
let stoppedJob = '';
let generateCalls = 0;
let stopCalls = 0;
let interruptSent = false;
let stdout = '';
let stderr = '';
let stdoutTail = '';
let waitingCount = 0;
let requestCount = 0;
let interrupted = false;
let resumed = false;
let resumedRequestId = 0;
let firstPromptSent = false;
let secondPromptSent = false;
let inputEnded = false;

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (error) { reject(error); }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'POST' && req.url === '/api/image/generate') {
      generateCalls++;
      const body = await readJson(req);
      generatedJob = body.job;
      assert.match(generatedJob, /^design-image-\d+-\d+$/);
      assert.equal(body.action, 'generate');
      assert.equal(Object.hasOwn(body, 'reasoning_effort'), false,
        'the direct image worker must not receive a retired router reasoning field');
      if (!interruptSent) {
        interruptSent = true;
        setImmediate(() => {
          child.stdin.write('\x1e{"type":"control","name":"interrupt"}\n');
          child.kill('SIGINT');
        });
      }
      return; // real image generation also keeps this response open
    }
    if (req.method === 'POST' && req.url === '/api/image/stop') {
      stopCalls++;
      const body = await readJson(req);
      stoppedJob = body.job;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true,"running":false}');
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{"ok":false,"error":"not found"}');
  } catch (error) {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: String(error) }));
  }
});
server.on('connection', (socket) => {
  sockets.add(socket);
  socket.on('close', () => sockets.delete(socket));
});
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const baseUrl = `http://127.0.0.1:${server.address().port}`;

function modelFrames(id, content) {
  return `\x1e${JSON.stringify({ type: 'model_delta', id, kind: 'content', text: content })}\n` +
    `\x1e${JSON.stringify({ type: 'model_done', id })}\n`;
}

function advanceRuntime() {
  if (waitingCount >= 2 && !secondPromptSent) {
    secondPromptSent = true;
    child.stdin.write('Prove that this same runtime still accepts a new turn.\n');
  } else if (waitingCount >= 3 && resumed && !inputEnded) {
    inputEnded = true;
    child.stdin.end();
  }
}

const imageDsml = [
  '<｜DSML｜tool_calls>',
  '<｜DSML｜invoke name="todo_write">',
  '<｜DSML｜parameter name="todos" string="true">[{"text":"Exercise image interrupt cleanup","status":"completed"}]</｜DSML｜parameter>',
  '</｜DSML｜invoke>',
  '<｜DSML｜invoke name="generate_image">',
  '<｜DSML｜parameter name="path" string="true">assets/interrupted.png</｜DSML｜parameter>',
  '<｜DSML｜parameter name="aspect" string="true">16:9</｜DSML｜parameter>',
  '<｜DSML｜parameter name="prompt" string="true">A precise concrete kinetic sculpture, no text, no logos.</｜DSML｜parameter>',
  '</｜DSML｜invoke>',
  '</｜DSML｜tool_calls>',
].join('\n');

function handleEvent(event) {
  if (event.type === 'turn_interrupted') {
    interrupted = true;
    advanceRuntime();
  }
  if (event.type !== 'model_request') return;
  requestCount++;
  if (requestCount === 1) child.stdin.write(modelFrames(event.id, imageDsml));
  else if (interrupted && waitingCount >= 2 && !resumed) {
    child.stdin.write(modelFrames(event.id, 'resumed successfully'));
    resumedRequestId = event.id;
    resumed = true;
  }
}

const timeout = setTimeout(() => child?.kill('SIGKILL'), 30_000);
try {
  child = spawn(designBin, [
    '--remote-base-url', 'http://127.0.0.1:1',
    '--remote-model', 'image-interrupt-fixture',
    '--workspace', workspace,
    '--jsonl', '--nothink', '-c', '4096', '-n', '1024',
  ], {
    cwd: root,
    env: { ...process.env, HOME: home, DS4UI_DSTUDIO_URL: baseUrl },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
    stdoutTail += chunk;
    for (;;) {
      const nl = stdoutTail.indexOf('\n');
      if (nl < 0) break;
      const line = stdoutTail.slice(0, nl);
      stdoutTail = stdoutTail.slice(nl + 1);
      const marker = line.indexOf('\x1e');
      if (marker < 0) continue;
      try { handleEvent(JSON.parse(line.slice(marker + 1))); } catch {}
    }
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
    waitingCount = (stderr.match(/\+DWARFSTAR_WAITING/g) || []).length;
    if (waitingCount === 1 && !firstPromptSent) {
      firstPromptSent = true;
      child.stdin.write('Build it directly; do not ask questions. Generate the requested image.\n');
    }
    advanceRuntime();
  });

  const exit = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(timeout);
  assert.deepEqual(exit, { code: 0, signal: null },
    `Design runtime must survive an image interrupt; waiting=${waitingCount}, ` +
    `requests=${requestCount}, interrupted=${interrupted}, generate=${generateCalls}, stop=${stopCalls}\n` +
    `${stderr.slice(-2000)}\n${stdout.slice(-4000)}`);
  assert.equal(generateCalls, 1);
  assert.equal(stopCalls, 1);
  assert.equal(stoppedJob, generatedJob, 'stop must target the exact image job');
  assert.equal(interrupted, true);
  assert.ok(resumedRequestId > 1);
  assert.ok(waitingCount >= 3);
  assert.match(stdout, /image job cancellation confirmed/);
  assert.match(stdout, /resumed successfully/);
  assert.equal(fs.existsSync(path.join(workspace, 'assets', 'interrupted.png')), false,
    'an interrupted generation must not write a partial destination');
  console.log('design_image_interrupt_test: ok');
} finally {
  clearTimeout(timeout);
  if (child && child.exitCode === null) child.kill('SIGKILL');
  for (const socket of sockets) socket.destroy();
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(tmp, { recursive: true, force: true });
}

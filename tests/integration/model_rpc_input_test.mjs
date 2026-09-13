import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import http from 'node:http';
import assert from 'node:assert/strict';
import {once} from 'node:events';
const binary = path.resolve(process.argv[2]);
const root = path.resolve('tests/.artifacts/model-rpc-input');
fs.mkdirSync(root, {recursive: true});
const output = fs.mkdtempSync(path.join(root, 'run-'));
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const sources = Object.fromEntries(['src/dstudio.c', 'src/dstudio_model_rpc.c', 'src/dstudio_task_executor.c',
  'extension/remote/dstudio_wire_string.h', 'extension/remote/dstudio_remote_llm.c',
  'tests/integration/model_rpc_input_test.c', 'tests/integration/model_rpc_input_test.mjs'].map(file => {
    const bytes = fs.readFileSync(file), target = path.join(output, 'sources', file);
    fs.mkdirSync(path.dirname(target), {recursive: true}); fs.writeFileSync(target, bytes);
    return [file, hash(bytes)];
  }));
const rows = [];
let active;
const server = http.createServer(async (req, res) => {
  const current = active; current.requests++;
  try {
    const chunks = []; for await (const bytes of req) chunks.push(bytes);
    const wire = Buffer.concat(chunks), body = JSON.parse(wire.toString('utf8'));
    current.bodyBytes = wire.length;
    if (current.name === 'native-pipe') {
      assert.equal(body.model, 'fixture-qwen'); assert.equal(body.stream, true);
      assert.deepEqual(body.messages, [{role: 'user', content: 'é 🦊 \\"\n\x1e'.repeat(100000)}]);
      assert.equal(body.think, false); assert.equal(body.max_tokens, 64);
    } else {
      assert.equal(current.name, 'escaped-unicode', 'invalid/incomplete/stopped data must never reach the network');
      assert.deepEqual(body, {x: '🦊世界'});
    }
    res.writeHead(200, {'Content-Type': 'text/event-stream'});
    res.end('data: {"choices":[{"index":0,"delta":{"content":"INPUT_OK"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  } catch (error) { current.peerError = error.stack; res.destroy(); }
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const url = `http://127.0.0.1:${server.address().port}`;
for (const name of ['nested-data', 'read-budget', 'native-pipe', 'native-stop-upload', 'escaped-unicode',
  'invalid-escape', 'lone-surrogate', 'decoded-nul', 'duplicate-envelope-body', 'truncated-envelope', 'invalid-body-json', 'decoded-body-limit',
  'stop-in-header', 'invalid-header-id', 'terminal-delivery-deadline', 'display-byte-limit', 'decoded-body-limit-early', 'early-worker-error']) {
  active = {name, requests: 0};
  const result = await new Promise(resolve => {
    const child = spawn(binary, [name, url], {stdio: ['ignore', 'pipe', 'pipe']});
    let stdout = '', stderr = '', error;
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', bytes => { stdout += bytes; }); child.stderr.on('data', bytes => { stderr += bytes; });
    child.on('error', value => { error = value.message; });
    const timer = setTimeout(() => child.kill('SIGTERM'), 15000);
    child.on('close', (status, signal) => { clearTimeout(timer); resolve({stdout, stderr, status, signal, error}); });
  });
  const receipts = (result.stdout || '').split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line));
  const expectedRequests = ['native-pipe', 'escaped-unicode'].includes(name) ? 1 : 0;
  rows.push({...active, code: result.status, signal: result.signal, error: result.error,
    stdout: result.stdout, stderr: result.stderr, receipts,
    pass: result.status === 0 && receipts.some(row => row.pass) && !receipts.some(row => row.pass === false) &&
      !active.peerError && active.requests === expectedRequests});
  process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || '');
}
await new Promise(resolve => server.close(resolve));
const report = {scope: 'Production host admission with isolated native fixtures; no model quality claim',
  binary, binarySha256: hash(fs.readFileSync(binary)), sources, rows,
  passed: rows.filter(row => row.pass).length, total: rows.length};
fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(report, null, 2));
console.log(`model_rpc_input: ${report.passed}/${report.total}; ${output}`);
if (report.passed !== report.total) process.exitCode = 1;

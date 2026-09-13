// Actual native HTTP/SSE parsing with a deterministic network peer. No model.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';

const binary = path.resolve(process.argv[2]);
const ownerRelay = process.argv.includes('--owner-relay');
const tls = process.argv.includes('--https');
const root = path.resolve('tests/.artifacts/model-rpc-stream');
fs.mkdirSync(root, { recursive: true });
const output = fs.mkdtempSync(path.join(root, 'run-'));
const chunk = (delta = {}, finish_reason = null, extra = {}) => 'data: ' + JSON.stringify({
  id: 'completion-one', model: 'fixture-qwen', choices: [{ index: 0, delta, finish_reason }], ...extra,
}) + '\n\n';
const done = 'data: [DONE]\n\n';
const text = content => chunk({ content });
const calls = (...items) => chunk({ tool_calls: items });
const call = (index, id, name, args) => ({ index, id, type: 'function', function: { name, arguments: args } });
const writeArgs = '{"path":"é/🦊.txt","content":"世界\\n<tool_call>literal</tool_call>"}';
const valid = calls(call(0, 'call-0', 'write', writeArgs)) + chunk({}, 'tool_calls') + done;
const rows = [];
const cases = [
  { name: 'large-display-frame', wire: text('é🦊'.repeat(60000)) + chunk({}, 'stop') + done,
    verify: events => assert.equal(events.filter(e => e.kind === 'content').map(e => e.text).join(''), 'é🦊'.repeat(60000)) },
  { name: 'text-and-reasoning', wire: chunk({ reasoning_content: 'Check first.' }) + text('Answer.') + chunk({}, 'stop') + done,
    verify: events => { assert.equal(events.filter(e => e.kind === 'reasoning').map(e => e.text).join(''), 'Check first.'); assert.equal(events.filter(e => e.kind === 'content').map(e => e.text).join(''), 'Answer.'); } },
  { name: 'escaped-unicode-text', wire: 'data: {"choices":[{"index":0,"delta":{"content":"\\u4e16\\u754c \\ud83e\\udd8a"},"finish_reason":null}]}\n\n' + chunk({}, 'stop') + done,
    verify: events => assert.equal(events.filter(e => e.kind === 'content').map(e => e.text).join(''), '世界 🦊') },
  { name: 'q36-complete-tool', wire: valid, tools: [{ id: 'call-0', type: 'function', function: { name: 'write', arguments: writeArgs } }] },
  { name: 'interleaved-tools', wire: calls(call(1, 'second', 're', '{"path":')) + calls(call(0, 'first', 'wr', '{"content":"')) +
      calls({ index: 0, function: { name: 'ite', arguments: 'a\\nb","path":"x"}' } }, { index: 1, function: { name: 'ad', arguments: '"x"}' } }) + chunk({}, 'tool_calls') + done,
    tools: [{ id: 'first', type: 'function', function: { name: 'write', arguments: '{"content":"a\\nb","path":"x"}' } },
      { id: 'second', type: 'function', function: { name: 'read', arguments: '{"path":"x"}' } }] },
  { name: 'nested-content-is-not-output', wire: chunk({}, null, { debug: { content: 'WRONG' } }) + text('Right') + chunk({}, 'stop') + done,
    verify: events => assert.equal(events.filter(e => e.kind === 'content').map(e => e.text).join(''), 'Right') },
  { name: 'missing-completion', wire: calls(call(0, 'first', 'write', writeArgs)), fail: true },
  { name: 'tool-length-cutoff', wire: calls(call(0, 'first', 'write', writeArgs)) + chunk({}, 'length') + done, fail: true },
  { name: 'tool-parser-error', wire: text('partial') + chunk({}, 'error') + done, fail: true },
  { name: 'truncated-arguments', wire: calls(call(0, 'first', 'write', '{"path":')) + chunk({}, 'tool_calls') + done, fail: true },
  { name: 'duplicate-call-id', wire: calls(call(0, 'same', 'read', '{}'), call(1, 'same', 'list', '{}')) + chunk({}, 'tool_calls') + done, fail: true },
  { name: 'wrong-choice', wire: chunk({ content: 'wrong' }, 'stop', { choices: [{ index: 1, delta: { content: 'wrong' }, finish_reason: 'stop' }] }) + done, fail: true },
  { name: 'duplicate-json-key', wire: 'data: {"choices":[],"choices":[{"index":0,"delta":{"content":"wrong"},"finish_reason":"stop"}]}\n\n' + done, fail: true },
  { name: 'nested-reasoning-is-not-output', wire: chunk({}, null, { metadata: { reasoning_content: 'WRONG' } }) + text('Right') + chunk({}, 'stop') + done,
    verify: events => assert.equal(events.filter(e => e.kind === 'reasoning').length, 0) },
  { name: 'empty-tool-batch', wire: chunk({}, 'tool_calls') + done, fail: true },
  { name: 'missing-finish-reason', wire: text('unfinished') + done, fail: true },
  { name: 'ordinary-length-cutoff', wire: text('unfinished') + chunk({}, 'length') + done, fail: true },
  { name: 'tool-finish-says-stop', wire: calls(call(0, 'first', 'write', writeArgs)) + chunk({}, 'stop') + done, fail: true },
  { name: 'missing-call-index', wire: calls({ id: 'first', type: 'function', function: { name: 'read', arguments: '{}' } }) + chunk({}, 'tool_calls') + done, fail: true },
  { name: 'negative-call-index', wire: calls(call(-1, 'first', 'read', '{}')) + chunk({}, 'tool_calls') + done, fail: true },
  { name: 'oversized-call-index', wire: calls(call(16, 'first', 'read', '{}')) + chunk({}, 'tool_calls') + done, fail: true },
  { name: 'duplicate-call-index-in-delta', wire: calls(call(0, 'first', 'read', '{}'), call(0, 'second', 'list', '{}')) + chunk({}, 'tool_calls') + done, fail: true },
  { name: 'call-index-hole', wire: calls(call(1, 'first', 'read', '{}')) + chunk({}, 'tool_calls') + done, fail: true },
  { name: 'missing-function-type', wire: calls({ index: 0, id: 'first', function: { name: 'read', arguments: '{}' } }) + chunk({}, 'tool_calls') + done, fail: true },
  { name: 'invalid-function-type', wire: calls({ ...call(0, 'first', 'read', '{}'), type: 'custom' }) + chunk({}, 'tool_calls') + done, fail: true },
  { name: 'empty-tool-name', wire: calls(call(0, 'first', '', '{}')) + chunk({}, 'tool_calls') + done, fail: true },
  { name: 'oversized-call-id', wire: calls(call(0, 'x'.repeat(129), 'read', '{}')) + chunk({}, 'tool_calls') + done, fail: true },
  { name: 'array-arguments', wire: calls(call(0, 'first', 'read', '[]')) + chunk({}, 'tool_calls') + done, fail: true },
  { name: 'duplicate-argument-key', wire: calls(call(0, 'first', 'read', '{"path":"one","path":"two"}')) + chunk({}, 'tool_calls') + done, fail: true },
  { name: 'escaped-duplicate-argument-key', wire: calls(call(0, 'first', 'read', '{"path":"one","\\u0070ath":"two"}')) + chunk({}, 'tool_calls') + done, fail: true },
  { name: 'nul-argument', wire: calls(call(0, 'first', 'read', '{"path":"x\\u0000.txt"}')) + chunk({}, 'tool_calls') + done, fail: true },
  { name: 'unpaired-surrogate-argument', wire: calls(call(0, 'first', 'read', '{"path":"\\ud83e.txt"}')) + chunk({}, 'tool_calls') + done, fail: true },
  { name: 'literal-escape-spelling-preserved', wire: calls(call(0, 'first', 'write', '{"path":"x","content":"\\\\ud800 and \\\\u0000"}')) + chunk({}, 'tool_calls') + done,
    tools: [{ id: 'first', type: 'function', function: { name: 'write', arguments: '{"path":"x","content":"\\\\ud800 and \\\\u0000"}' } }] },
  { name: 'text-after-finish', wire: text('one') + chunk({}, 'stop') + text('two') + done, fail: true },
  { name: 'provider-error-event', wire: 'data: {"error":{"message":"failed"}}\n\n' + done, fail: true },
  { name: 'ambiguous-multiple-choices', wire: chunk({}, null, { choices: [{ index: 0, delta: {} }, { index: 1, delta: {} }] }) + done, fail: true },
  { name: 'escaped-protocol-keys', wire: 'data: {"choi\\u0063es":[{"index":0,"delta":{"cont\\u0065nt":"Right"},"finish_reason":"stop"}]}\n\n' + done,
    verify: events => assert.equal(events.filter(e => e.kind === 'content').map(e => e.text).join(''), 'Right') },
  { name: 'trailing-sentinel-junk', wire: text('one') + chunk({}, 'stop') + 'data: [DONE] wrong\n\n', fail: true },
  { name: 'usage-after-tool-finish', wire: valid.replace(done, 'data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":3}}\n\n' + done),
    tools: [{ id: 'call-0', type: 'function', function: { name: 'write', arguments: writeArgs } }] },
  { name: 'sixteen-complete-calls', wire: calls(...Array.from({ length: 16 }, (_, i) => call(i, `call-${i}`, 'read', `{"path":"${i}"}`))) + chunk({}, 'tool_calls') + done,
    tools: Array.from({ length: 16 }, (_, i) => ({ id: `call-${i}`, type: 'function', function: { name: 'read', arguments: `{"path":"${i}"}` } })) },
  { name: 'seventeenth-call-rejected', wire: calls(...Array.from({ length: 17 }, (_, i) => call(i, `call-${i}`, 'read', '{}'))) + chunk({}, 'tool_calls') + done, fail: true },
  { name: 'argument-byte-limit', wire: calls(call(0, 'first', 'write', JSON.stringify({ content: 'x'.repeat(1024 * 1024) }))) + chunk({}, 'tool_calls') + done, fail: true },
  { name: 'aggregate-tool-byte-limit', wire: [0, 1, 2].map(i => calls(call(i, `call-${i}`, 'write', JSON.stringify({ content: 'x'.repeat(800000) })))).join('') + chunk({}, 'tool_calls') + done, fail: true },
  { name: 'sse-line-byte-limit', wire: ':' + 'x'.repeat(2 * 1024 * 1024) + '\n\n' + chunk({}, 'stop') + done, fail: true },
  { name: 'json-token-limit', wire: chunk({}, null, { extra: Array.from({ length: 4096 }, () => 0) }) + chunk({}, 'stop') + done, fail: true },
  { name: 'json-depth-limit', wire: calls(call(0, 'first', 'read', '{"x":'.repeat(70) + '1' + '}'.repeat(70))) + chunk({}, 'tool_calls') + done, fail: true },
  { name: 'nul-display-text', wire: text('x\0y') + chunk({}, 'stop') + done, fail: true },
  { name: 'invalid-display-surrogate', wire: text('\ud800') + chunk({}, 'stop') + done, fail: true },
];
if (ownerRelay) cases.push({name: 'owner-cancels-held-network', cancel: true, wire: '',
  verify: events => {
    assert.equal(events.at(-1)?.type, 'probe_canceled');
    assert.equal(events.at(-1)?.terminalFrames, 0);
    assert.ok(events.at(-1)?.workerPid > 0);
  }});
if (ownerRelay) cases.push({name: 'owner-death-closes-held-network', parentDeath: true, wire: ''});
const childEnv = {...process.env};
childEnv.TMPDIR = path.join(output, 'private-staging');
fs.mkdirSync(childEnv.TMPDIR, {mode: 0o700});
let certificate;
if (tls) {
  const cert = path.join(output, 'fixture-cert.pem'), key = path.join(output, 'fixture-key.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', key, '-out', cert], {stdio: 'pipe'});
  certificate = {cert: fs.readFileSync(cert), key: fs.readFileSync(key)};
  childEnv.CURL_CA_BUNDLE = cert; // Trust only the test certificate; never use curl -k.
}
let active;
const handleRequest = async (req, res) => {
  const current = active;
  const body = []; for await (const part of req) body.push(part);
  current.request = JSON.parse(Buffer.concat(body).toString());
  if (current.cancel || current.parentDeath) {
    current.closed = new Promise(resolve => req.socket.once('close', resolve));
    if (current.parentDeath) {
      const processes = execFileSync('ps', ['-axo', 'pid=,ppid=,pgid='], {encoding: 'utf8'})
        .trim().split('\n').map(line => line.trim().split(/\s+/).map(Number));
      const helper = processes.find(([, parent]) => parent === current.child.pid);
      assert.ok(helper, 'observe the actual helper before terminating its owning test host');
      assert.equal(helper[0], helper[2], 'helper owns its separate process group');
      current.workerGroup = helper[2];
      current.row.workerGroup = helper[2];
      current.row.ownerPid = current.child.pid;
    }
    current.child.kill(current.parentDeath ? 'SIGKILL' : 'SIGUSR1');
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const bytes = Buffer.from(active.wire);
  // Deliberately split UTF-8, escapes, JSON and SSE boundaries over HTTP chunks.
  for (let at = 0; at < bytes.length;) {
    const count = at < 1024 ? 7 : 4093;
    res.write(bytes.subarray(at, at + count)); at += count;
  }
  res.end();
};
const server = tls ? https.createServer(certificate, handleRequest) : http.createServer(handleRequest);
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const url = `${tls ? 'https' : 'http'}://127.0.0.1:${server.address().port}`;
const manifest = { scope: 'Production HTTP/SSE relay and runtime pipe consumer with simulated model; no inference-quality claim', ownerRelay, tls,
  binary, binarySha256: crypto.createHash('sha256').update(fs.readFileSync(binary)).digest('hex'), rows };
manifest.sources = Object.fromEntries(['src/dstudio.c', 'src/dstudio_model_rpc.c', 'src/dstudio_model_stream.c', 'src/dstudio_task_graph.c', 'extension/remote/dstudio_remote_llm.c',
  'extension/remote/dstudio_remote_llm.h', 'extension/remote/dstudio_wire_string.h', 'tests/support/model_rpc_stream_probe.c',
  'tests/integration/model_rpc_stream_test.mjs'].filter(file => fs.existsSync(file)).map(file => {
    const bytes = fs.readFileSync(file);
    fs.mkdirSync(path.join(output, 'sources', path.dirname(file)), { recursive: true });
    fs.copyFileSync(file, path.join(output, 'sources', file));
    return [file, crypto.createHash('sha256').update(bytes).digest('hex')];
  }));
try {
  for (const test of cases) {
    active = test;
    const row = { name: test.name, status: 'running', started: new Date().toISOString() }; rows.push(row);
    test.row = row;
    const child = spawn(binary, [url, ...(ownerRelay ? ['--owner-relay'] : [])], { stdio: ['ignore', 'pipe', 'pipe'], env: childEnv });
    test.child = child;
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    const terminal = once(child, 'close');
    let stdout = '', stderr = '', timedOut = false;
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    const deadline = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 10000);
    try {
      const [code, signal] = await terminal;
      row.code = code; row.signal = signal;
      assert.equal(timedOut, false, 'bounded network fixture timed out');
      const events = stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line.replace(/^\x1e/, '')));
      test.events = events;
      if (test.parentDeath) {
        assert.equal(signal, 'SIGKILL', 'explicit host-death fault injection');
        assert.equal(code, null);
        assert.equal(events.length, 0, 'held request cannot publish a result before its owner dies');
      } else {
        assert.equal(events.at(-1)?.type, test.cancel ? 'probe_canceled' : test.fail ? 'model_error' : 'model_done', stdout + stderr);
        assert.equal(code, test.fail ? 1 : 0, stderr);
      }
      const tools = events.filter(e => e.type === 'model_tool_calls');
      if (test.tools) {
        assert.equal(tools.length, 1, 'tool calls must be delivered exactly once after validated completion');
        assert.deepEqual(JSON.parse(tools[0].text), test.tools);
      } else assert.equal(tools.length, 0, 'failed/unfinished calls must never be delivered');
      test.verify?.(events);
      if (test.cancel || test.parentDeath) {
        assert.ok(test.closed, 'the request must reach the actual HTTP peer before cancellation');
        let timer;
        try { await Promise.race([test.closed, new Promise((_, reject) => {timer = setTimeout(() => reject(new Error('canceled connection remained open')), 3000);})]); }
        finally { clearTimeout(timer); }
      }
      if (test.workerGroup) {
        let absent = false;
        row.groupObservations = [];
        for (let attempt = 0; attempt < 40 && !absent; attempt++) {
          // Signal permission is not liveness: our macOS ASan run returned
          // EPERM for this probe. Require an empty OS process census,
          // including zombies, instead of treating that error as absence.
          const members = execFileSync('ps', ['-axo', 'pid=,ppid=,pgid=,state='], {encoding: 'utf8'})
            .trim().split('\n').map(line => line.trim().split(/\s+/))
            .filter(fields => Number(fields[2]) === test.workerGroup);
          row.groupObservations.push(members);
          absent = members.length === 0;
          if (!absent) await new Promise(resolve => setTimeout(resolve, 50));
        }
        assert.equal(absent, true, 'owning host exit must not leave helper or curl running');
      }
      assert.deepEqual(fs.readdirSync(childEnv.TMPDIR), [], 'no named files containing request body or credentials remain');
      row.status = 'pass';
    } catch (error) { row.status = 'fail'; row.error = error.stack; process.exitCode = 1; }
    finally {
      clearTimeout(deadline);
      row.finished = new Date().toISOString();
      fs.writeFileSync(path.join(output, test.name + '.json'), JSON.stringify({ ...row, wire: test.wire, request: test.request, stdout, stderr }, null, 2));
      fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(manifest, null, 2));
    }
  }
  const toolEvents = cases.find(test => test.name === 'q36-complete-tool').events;
  const textEvents = cases.find(test => test.name === 'text-and-reasoning').events;
  const completedCalls = toolEvents.find(event => event.type === 'model_tool_calls');
  assert.ok(completedCalls, 'host must produce a real completed tool frame for the runtime replay');
  const runtimeCases = [
    { name: 'runtime-tool-roundtrip', frames: toolEvents, rc: 0, calls: JSON.parse(completedCalls.text) },
    { name: 'runtime-text-roundtrip', frames: textEvents, rc: 0 },
    { name: 'runtime-legacy-text', frames: textEvents, rc: 0, legacy: true },
    { name: 'runtime-legacy-rejects-structured-tools', frames: toolEvents, rc: 1, legacy: true },
    { name: 'runtime-stop-discards-candidate', frames: [completedCalls, { type: 'control', name: 'interrupt' }], rc: 2 },
    { name: 'runtime-eof-discards-candidate', frames: [completedCalls], rc: 1 },
    { name: 'runtime-error-discards-candidate', frames: [completedCalls, { type: 'model_error', error: 'fixture connection lost' }], rc: 1 },
    { name: 'runtime-duplicate-batch-rejected', frames: [completedCalls, completedCalls, toolEvents.at(-1)], rc: 1 },
    { name: 'runtime-wrong-finish-rejected', frames: [completedCalls, { type: 'model_done', text: 'stop' }], rc: 1 },
    { name: 'runtime-missing-finish-rejected', frames: [completedCalls, { type: 'model_done' }], rc: 1 },
    { name: 'runtime-wrong-request-ignored', frames: [{ ...completedCalls, stale: true }, ...textEvents], rc: 0 },
    { name: 'runtime-no-text-after-tools', frames: [completedCalls, { type: 'model_delta', kind: 'content', text: 'unexpected' }, toolEvents.at(-1)], rc: 1 },
    { name: 'runtime-partial-terminal-frame', frames: [completedCalls], tail: '\x1e{"type":"model_done","id":1,"text":"tool_calls"}', rc: 1 },
  ];
  for (const test of runtimeCases) {
    const row = { name: test.name, status: 'running' }; rows.push(row);
    const child = spawn(binary, [url, test.legacy ? 'legacy' : 'runtime'], { stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    const terminal = once(child, 'close');
    let stdout = '', stderr = '', pending = '', requests = 0, inputError, timedOut = false;
    const deadline = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 10000);
    child.stdin.on('error', () => {}); // Intentional fail/Stop can close before the final injected frame.
    child.stderr.on('data', data => { stderr += data; });
    child.stdout.on('data', data => {
      stdout += data; pending += data;
      for (;;) {
        const at = pending.indexOf('\n'); if (at < 0) break;
        const line = pending.slice(0, at); pending = pending.slice(at + 1);
        try {
          const event = JSON.parse(line.replace(/^\x1e/, ''));
          if (event.type !== 'model_request') continue;
          requests++;
          row.request = JSON.parse(event.body);
          assert.equal(row.request.model, 'fixture-qwen');
          assert.deepEqual(row.request.messages, [{ role: 'user', content: 'Tool request é 🦊' }]);
          assert.equal(row.request.think, tls ? undefined : false);
          assert.equal(row.request.min_p, tls ? undefined : 0);
          assert.equal(row.request.reasoning_effort, undefined);
          assert.equal(row.request.temperature, 0);
          assert.equal(row.request.top_p, 1);
          assert.equal(row.request.max_tokens, 256);
          if (test.legacy) assert.equal(row.request.tools, undefined);
          else assert.equal(row.request.tools[0].function.name, 'write');
          const frames = test.frames.map(frame => '\x1e' + JSON.stringify({ ...frame, id: event.id + (frame.stale ? 99 : 0) }) + '\n').join('');
          child.stdin.end(frames + (test.tail || ''));
        } catch (error) { inputError = error; child.kill('SIGTERM'); }
      }
    });
    try {
      const [code, signal] = await terminal;
      row.code = code; row.signal = signal;
      if (inputError) throw inputError;
      assert.equal(timedOut, false); assert.equal(code, 0, stderr); assert.equal(requests, 1);
      const events = stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line.replace(/^\x1e/, '')));
      const result = events.find(event => event.type === 'probe_result');
      assert.equal(result?.rc, test.rc, stdout + stderr);
      assert.deepEqual(result.calls, test.calls ?? null);
      row.status = 'pass';
    } catch (error) { row.status = 'fail'; row.error = error.stack; process.exitCode = 1; }
    finally {
      clearTimeout(deadline);
      fs.writeFileSync(path.join(output, test.name + '.json'), JSON.stringify({ ...row, frames: test.frames, stdout, stderr }, null, 2));
      fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(manifest, null, 2));
    }
  }
} finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
console.log(`model_rpc_stream: ${rows.filter(r => r.status === 'pass').length}/${rows.length}; ${output}`);

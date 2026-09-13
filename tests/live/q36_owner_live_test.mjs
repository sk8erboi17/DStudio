// Real native server readiness/owner loss with existing verified 27B weights.
// Two exact-answer development checks, not the held-out language-quality gate.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import crypto from 'node:crypto';
import {spawn, spawnSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {artifactRunDir, writeArtifact} from '../support/real_harness.mjs';
import {fileIdentity, hashStableFile} from '../support/quality_baseline.mjs';

const root = path.resolve(import.meta.dirname, '../..'), run = artifactRunDir('q36-owner-live');
const report = {started: new Date().toISOString(), passed: false, plannedChecks: 5, cases: [],
  scope: 'Real Qwen27B process supervision and two exact-answer development checks; not broad quality or desktop integration',
  host: {platform: os.platform(), arch: os.arch(), cpu: os.cpus()[0]?.model, ram: os.totalmem()},
  settings: {backend: 'metal', context: 8192, prefillChunk: 128, threads: 4,
    cacheK: 'f16', cacheV: 'f16', expertStreaming: false, diskKV: false, thinking: false, quality: true}};
const save = () => writeArtifact(run, 'results.json', report);
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const nativeIdentity = file => {
  const s = fs.statSync(file, {bigint: true});
  return [s.dev, s.ino, s.size, s.mtimeNs / 1000000000n, s.mtimeNs % 1000000000n,
    s.ctimeNs / 1000000000n, s.ctimeNs % 1000000000n].join(':');
};
let child, terminal, timer, escalation, watcher, error = '', wire = '', logs = '', exited;
let model, projector, weight, encoder;
function stop(reason) {
  error ||= reason;
  if (!child || exited) return;
  child.kill('SIGTERM');
  escalation ||= setTimeout(() => {if (!exited) child.kill('SIGKILL');}, 4000);
}
function idle() {
  const r = spawnSync('/bin/ps', ['-axo', 'pid=,comm='], {encoding: 'utf8', timeout: 5000});
  assert.equal(r.status, 0, r.stderr);
  const active = r.stdout.split('\n').filter(line =>
    /\/(?:ds4|ds4-server|ds4-agent|ds4-agent-jsonl|ds4-cowork|ds4-design|q36|q36-server|q36_test|q27|DStudio|dstudio)(?:\s|$)/.test(line) &&
    Number(line.trim().split(/\s+/)[0]) !== child?.pid);
  assert.deepEqual(active, [], 'Another app/engine is running; no unrelated process was stopped');
}
async function check(name, fn) {
  const row = {name, passed: false}; report.cases.push(row); save();
  try {await fn(row); row.passed = true;}
  catch (e) {row.error = String(e.stack || e); throw e;}
  finally {save(); console.log(`${row.passed ? 'PASS' : 'FAIL'}: ${name}`);}
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => stop(signal));
console.log(`Evidence: ${run}`);
try {
  assert.equal(process.platform, 'darwin', 'Metal unavailable: NOT RUN');
  assert.equal(process.argv.length, 5, 'Supply built q36 source, verified 27B model and matching projector');
  const tree = fs.realpathSync(process.argv[2]), binary = path.join(tree, 'q36-server');
  model = fs.realpathSync(process.argv[3]); projector = fs.realpathSync(process.argv[4]);
  idle();
  const inputs = ['q36.c', 'q36.h', 'q36_server.c', 'q36_metal.m'].map(f => path.join(tree, f))
    .concat(binary, import.meta.filename, path.join(root, 'patch/q36-metal-runtime/runtime.patch'));
  report.inputs = Object.fromEntries(inputs.map(file => [file, hash(file)]));
  weight = await hashStableFile(model); encoder = await hashStableFile(projector);
  assert.equal(weight.bytes, 25299061664);
  assert.equal(weight.sha256, '701d8fa9ed214ab21bfc130cd2a7df19ca89bbef7713e2dfb19f3c63696aa917');
  assert.equal(encoder.bytes, 927607488);
  assert.equal(encoder.sha256, 'cbb841a9ee0636b2ec172f5bb8df2ea8dfeb01e90fe7c6126581d662a0b4e43e');
  report.weights = {model: weight, projector: encoder}; save(); idle();
  const reservation = net.createServer();
  await new Promise((resolve, reject) => {reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve);});
  const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
  const args = ['--model', model, '--vision', projector, '--metal', '--quality', '--ctx', '8192',
    '--cache-type-k', 'f16', '--cache-type-v', 'f16', '--prefill-chunk', '128', '--threads', '4',
    '--tokens', '32', '--host', '127.0.0.1', '--port', String(port), '--dstudio-owner-fd', '3'];
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(Q36_|DS4|DSTUDIO_|DYLD_|MAKEFLAGS$|MFLAGS$)/.test(k)));
  report.argv = [binary, ...args];
  child = spawn(binary, args, {cwd: tree, env, stdio: ['ignore', 'pipe', 'pipe', 'pipe']});
  report.pid = child.pid; save();
  terminal = new Promise(resolve => {
    child.once('error', e => {error ||= String(e);});
    child.once('close', (code, signal) => {exited = {code, signal}; resolve(exited);});
  });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => {
    if (logs.length + bytes.length > 2 ** 21) stop('Log limit exceeded');
    else logs += bytes.toString('utf8');
  });
  child.stdio[3].on('data', bytes => {
    if (wire.length + bytes.length > 1536) stop('Owner receipt limit exceeded');
    else wire += bytes.toString('utf8');
  });
  timer = setTimeout(() => stop('180-second live test deadline'), 180000);
  watcher = setInterval(() => {try {idle();} catch (e) {stop(String(e));}}, 1000);
  const url = `http://127.0.0.1:${port}`;
  await check('ready receipt matches actual process, files, context and Metal runtime', async row => {
    const start = performance.now();
    while (!wire.endsWith('\n')) {
      assert(!error && !exited, error || JSON.stringify(exited));
      assert(performance.now() - start < 120000, 'Readiness deadline'); await delay(20);
    }
    row.loadMs = performance.now() - start; row.wire = wire;
    const data = JSON.parse(wire); row.receipt = data;
    assert.equal(data.version, 1); assert.equal(data.event, 'ready'); assert.equal(data.pid, child.pid);
    assert.equal(data.host, '127.0.0.1'); assert.equal(data.port, port); assert.equal(data.context, 8192);
    assert.equal(data.model, 'qwen3.8-27b'); assert.equal(data.backend, 'metal');
    assert.equal(data.cache_k, 'f16'); assert.equal(data.cache_v, 'f16'); assert.equal(data.ssd_streaming, false);
    assert.equal(data.model_file, nativeIdentity(model)); assert.equal(data.vision_file, nativeIdentity(projector));
    assert.equal(data.mtp_file, '');
  });
  await check('ready process serves matching model catalog', async row => {
    const response = await fetch(url + '/v1/models', {signal: AbortSignal.timeout(5000)});
    assert.equal(response.status, 200); row.catalog = await response.json();
    assert.equal(row.catalog.data[0].id, 'qwen3.8-27b'); assert.equal(row.catalog.data[0].context_length, 8192);
  });
  for (const [question, expected] of [
    ['The exact identifier is CEDAR-4628. Return only that identifier, with no explanation.', 'CEDAR-4628'],
    ['Compute 17 + 26. Return only the integer, with no explanation.', '43'],
  ]) await check('real text response: ' + expected, async row => {
    row.request = {model: 'qwen3.8-27b', messages: [{role: 'user', content: question}],
      temperature: 0, top_p: 1, top_k: 0, min_p: 0, seed: 1, max_tokens: 32,
      chat_template_kwargs: {enable_thinking: false}};
    row.expected = expected; const start = performance.now();
    const response = await fetch(url + '/v1/chat/completions', {method: 'POST',
      headers: {'Content-Type': 'application/json', 'X-DStudio-Request-Id': crypto.randomUUID()},
      body: JSON.stringify(row.request), signal: AbortSignal.timeout(30000)});
    row.httpStatus = response.status; row.raw = await response.text(); row.ms = performance.now() - start;
    assert.equal(response.status, 200, row.raw); row.response = JSON.parse(row.raw);
    assert.equal(row.response.model, 'qwen3.8-27b');
    assert.equal(row.response.choices[0].message.content.trim(), expected);
    assert.equal(row.response.choices[0].finish_reason, 'stop');
    assert(row.response.usage.completion_tokens > 0);
  });
  await check('owner EOF drains the loaded server and releases its endpoint', async row => {
    const start = performance.now(); child.stdio[3].end();
    row.exit = await terminal; row.stopMs = performance.now() - start;
    assert(!error, error); assert.equal(row.exit.signal, null); assert.equal(row.exit.code, 0);
    assert(row.stopMs < 4000, 'Graceful stop exceeded the bounded owner-loss path');
    const socket = net.createServer();
    try {await new Promise((resolve, reject) => {socket.once('error', reject); socket.listen(port, '127.0.0.1', resolve);});}
    finally {if (socket.listening) await new Promise(resolve => socket.close(resolve));}
  });
  for (const [file, expected] of Object.entries(report.inputs)) assert.equal(hash(file), expected, 'Input changed: ' + file);
  assert.equal(fileIdentity(fs.statSync(model, {bigint: true})), weight.identity);
  assert.equal(fileIdentity(fs.statSync(projector, {bigint: true})), encoder.identity);
  report.passed = true;
} catch (e) {report.error = String(e.stack || e); console.error(report.error); process.exitCode = 1;}
finally {
  clearTimeout(timer); clearInterval(watcher);
  if (child && !exited) {stop('test cleanup'); if (terminal) await terminal;}
  clearTimeout(escalation); report.exit = exited;
  fs.writeFileSync(path.join(run, 'engine.log'), logs, {flag: 'wx'});
  report.finished = new Date().toISOString(); save();
}

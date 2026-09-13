// Real weights, native two-slot HTTP scheduler and disk KV restoration.
// Development regressions; neither a throughput benchmark nor broad quality.
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

const run = artifactRunDir('q36-batched-cache-live');
const report = {started: new Date().toISOString(), passed: false, cases: [], phases: [], inputs: {},
  scope: 'Real Qwen27B, native two-slot HTTP and disk KV; development regressions, not general quality or a speed claim',
  host: {platform: os.platform(), arch: os.arch(), cpu: os.cpus()[0]?.model, memory: os.totalmem()},
  settings: {context: 4096, slots: 2, prefill: 128, threads: 4, cacheK: 'f16', cacheV: 'f16',
    quality: true, thinking: false, expertStreaming: false, diskCacheMiB: 4096}};
const save = () => writeArtifact(run, 'results.json', report);
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(Q36_|DS4|DSTUDIO_|DYLD_|MAKEFLAGS$|MFLAGS$)/.test(k)));
env.Q36_SERVER_BATCH_LOG = '1';
let child, terminal, current, escalation, timer, watcher, interrupted = false, weight, model;
let engine, binary, url;
const cache = path.join(run, 'kv-cache');
function stop(reason) {
  if (!current) return;
  current.stopReason ||= reason;
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  // This exact ChildProcess and its fresh process group belong to this run.
  try {process.kill(-child.pid, 'SIGTERM');} catch (e) {if (e.code !== 'ESRCH') throw e;}
  escalation ||= setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      try {process.kill(-child.pid, 'SIGKILL');} catch (e) {if (e.code !== 'ESRCH') throw e;}
    }
  }, 5000);
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {interrupted = true; stop(signal);});
function idle() {
  const r = spawnSync('/bin/ps', ['-axo', 'pid=,comm='], {encoding: 'utf8', timeout: 5000});
  assert.equal(r.status, 0, r.stderr);
  const active = r.stdout.split('\n').filter(line =>
    /\/(?:ds4|ds4-server|ds4-agent|ds4-agent-jsonl|ds4-cowork|ds4-design|q36|q36-server|q36_test|q27)(?:\s|$)|\/DStudio\.app\/Contents\/MacOS\/DStudio$/.test(line) &&
    Number(line.trim().split(/\s+/)[0]) !== child?.pid);
  assert.deepEqual(active, [], 'Another app/engine is running; nothing unrelated was stopped');
}
async function check(name, body) {
  const row = {name, passed: false}; report.cases.push(row); save();
  try {await body(row); row.passed = true;}
  catch (e) {row.error = String(e.stack || e);}
  save(); console.log(`${row.passed ? 'PASS' : 'FAIL'}: ${name}`);
  return row;
}
async function closePhase() {
  clearTimeout(timer); clearInterval(watcher); stop('phase complete');
  if (terminal) current.exit = await terminal;
  clearTimeout(escalation); escalation = null;
  if (current) fs.writeFileSync(path.join(run, `${current.name}.log`), current.log || '', {flag: 'wx'});
  const phase = current; child = null; terminal = null; current = null;
  save();
  if (phase) {
    assert.equal(phase.stopReason, 'phase complete', 'Unexpected stop: ' + phase.stopReason);
    assert(!phase.exit?.signal && phase.exit?.code === 0, 'Native process did not exit cleanly');
  }
}
async function startPhase(name) {
  idle(); assert(!child && !current && !interrupted);
  const socket = net.createServer();
  await new Promise((resolve, reject) => {socket.once('error', reject); socket.listen(0, '127.0.0.1', resolve);});
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  url = `http://127.0.0.1:${port}`;
  const trace = path.join(run, `${name}.trace`);
  const args = ['--model', model, '--metal', '--quality', '--ctx', '4096', '--batched-session', '2',
    '--cache-type-k', 'f16', '--cache-type-v', 'f16', '--prefill-chunk', '128', '--threads', '4',
    '--tokens', '32', '--host', '127.0.0.1', '--port', String(port), '--trace', trace,
    '--kv-disk-dir', cache, '--kv-disk-space-mb', '4096', '--kv-cache-min-tokens', '512',
    '--kv-cache-cold-max-tokens', '4096', '--kv-cache-continued-interval-tokens', '4096',
    '--kv-cache-boundary-trim-tokens', '32', '--kv-cache-boundary-align-tokens', '128'];
  current = {name, argv: [binary, ...args], trace, log: '', bytes: 0}; report.phases.push(current);
  child = spawn(binary, args, {cwd: engine, env, detached: true, stdio: ['ignore', 'pipe', 'pipe']});
  current.pid = child.pid;
  terminal = new Promise(resolve => {
    child.once('error', error => resolve({error: String(error)}));
    child.once('close', (code, signal) => resolve({code, signal}));
  });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => {
    current.bytes += chunk.length;
    if (current.bytes > 8 * 1024 * 1024) stop('log bound exceeded');
    else {current.log += chunk.toString('utf8'); process.stderr.write(chunk);}
  });
  timer = setTimeout(() => stop('600-second phase deadline'), 600000);
  watcher = setInterval(() => {
    try {
      idle();
      if (fs.existsSync(trace) && fs.statSync(trace).size > 8 * 1024 * 1024) stop('trace bound exceeded');
    } catch {stop('Lost exclusive resource ownership or observation failed');}
  }, 1000);
  save(); const deadline = performance.now() + 120000;
  while (!current.log.includes('listening on http://')) {
    assert(performance.now() < deadline && !interrupted, 'Native readiness deadline');
    assert.equal(child.exitCode, null, 'Engine exited before readiness'); await delay(50);
  }
  const response = await fetch(url + '/v1/models', {signal: AbortSignal.timeout(5000)});
  assert.equal(response.status, 200); const catalog = await response.json();
  assert.equal(catalog.data[0].id, 'qwen3.8-27b');
  assert.equal(catalog.data[0].context_length, 4096); current.catalog = catalog; save();
}
const facts = [['Alder', 'LARCH-5931'], ['Birch', 'MAPLE-8274'], ['Cedar', 'ASPEN-4062']];
const payloads = facts.map(([label, code]) => ({model: 'qwen3.8-27b',
  messages: [{role: 'user', content: `Archive ${label}. Its exact access code is ${code}.\n` +
    Array.from({length: 140}, (_, i) => `Record ${i + 1}: ${label} stores ordinary paper notes.`).join('\n') +
    `\nReturn only the exact access code for archive ${label}, without quotes or explanation.`}],
  temperature: 0, top_p: 1, top_k: 0, min_p: 0, seed: 1, max_tokens: 32,
  chat_template_kwargs: {enable_thinking: false}}));
async function answer(row, index) {
  row.request = payloads[index]; row.expected = facts[index][1]; const start = performance.now();
  const response = await fetch(url + '/v1/chat/completions', {method: 'POST',
    headers: {'Content-Type': 'application/json', 'X-DStudio-Request-Id': crypto.randomUUID()},
    body: JSON.stringify(row.request), signal: AbortSignal.timeout(180000)});
  row.httpStatus = response.status; row.raw = await response.text(); row.seconds = (performance.now() - start) / 1000;
  assert.equal(response.status, 200, row.raw); row.response = JSON.parse(row.raw);
  assert.equal(row.response.model, 'qwen3.8-27b');
  assert.equal(row.response.choices[0].message.content.trim(), row.expected);
  assert.equal(row.response.choices[0].finish_reason, 'stop');
  assert(!row.response.choices[0].message.tool_calls?.length);
}
function cacheHashes() {
  const names = fs.readdirSync(cache).filter(n => n.endsWith('.kv')).sort();
  return Object.fromEntries(names.map(name => {
    const file = path.join(cache, name), fd = fs.openSync(file, 'r'), buf = Buffer.alloc(65536);
    const digest = crypto.createHash('sha256'); let off = 0, n, reason, tokens;
    try {
      while ((n = fs.readSync(fd, buf, 0, buf.length, off)) > 0) {
        if (!off) {
          assert(n >= 52, 'Native cache header is truncated'); reason = buf[5]; tokens = buf.readUInt32LE(8);
          buf.fill(0, 12, 16); buf.fill(0, 32, 40); // Only hit count and last-used time may change.
        }
        digest.update(buf.subarray(0, n)); off += n;
      }
    } finally {fs.closeSync(fd);}
    return [name, {bytes: off, reason, tokens, sha256: digest.digest('hex')}];
  }));
}
async function cancelledContinuation(row) {
  const earlier = report.cases.find(r => r.name === 'Alder resident frontier is reestablished before Stop');
  assert(earlier?.passed && earlier.response?.usage, 'Previous resident answer must be verified first');
  const before = cacheHashes();
  const requestId = crypto.randomUUID();
  row.request = {...payloads[0], messages: [payloads[0].messages[0],
    {role: 'assistant', content: earlier.response.choices[0].message.content},
    {role: 'user', content: Array.from({length: 140}, (_, i) => `Additional note ${i}: keep the same archive access code.`).join('\n') +
      '\nReturn only the original archive access code.'}]};
  const startLog = current.log.length, start = performance.now();
  let finished = false;
  const pending = fetch(url + '/v1/chat/completions', {method: 'POST',
    headers: {'Content-Type': 'application/json', 'X-DStudio-Request-Id': requestId},
    body: JSON.stringify(row.request), signal: AbortSignal.timeout(180000)})
    .then(async r => ({status: r.status, body: await r.text()}))
    .catch(e => ({error: String(e)})).finally(() => {finished = true;});
  try {
    const deadline = performance.now() + 60000;
    while (!/prefill chunk [0-9]+\/[0-9]+/.test(current.log.slice(startLog))) {
      assert(!finished, 'Request ended before observable native prefill; not a cancellation test');
      assert(performance.now() < deadline, 'No native prefill within observation bound');
      await delay(25);
    }
    row.observedPrefill = current.log.slice(startLog);
    const stopped = await fetch(url + `/v1/requests/${requestId}/cancel`, {method: 'POST', signal: AbortSignal.timeout(5000)});
    row.cancelStatus = stopped.status; row.cancelResponse = await stopped.json();
    assert.equal(stopped.status, 202); assert.equal(row.cancelResponse.cancellation_requested, true);
  } finally {
    // Always settle this exact request before the next probe or process shutdown.
    row.response = await pending; row.seconds = (performance.now() - start) / 1000;
  }
  assert.equal(row.response.status, 499, JSON.stringify(row.response));
  row.after = cacheHashes(); assert.deepEqual(row.after, before, 'Cancelled candidate published a checkpoint');
}
async function followupFromResident(row, earlier) {
  assert(earlier?.passed && earlier.response?.usage);
  row.expectedResidentTokens = earlier.response.usage.prompt_tokens + earlier.response.usage.completion_tokens;
  row.expected = facts[0][1]; row.request = {...payloads[0], messages: [payloads[0].messages[0],
    {role: 'assistant', content: earlier.response.choices[0].message.content},
    {role: 'user', content: 'Again, return only the original archive access code.'}]};
  const traceBefore = fs.statSync(current.trace).size, start = performance.now();
  const response = await fetch(url + '/v1/chat/completions', {method: 'POST',
    headers: {'Content-Type': 'application/json', 'X-DStudio-Request-Id': crypto.randomUUID()},
    body: JSON.stringify(row.request), signal: AbortSignal.timeout(180000)});
  row.httpStatus = response.status; row.raw = await response.text(); row.seconds = (performance.now() - start) / 1000;
  assert.equal(response.status, 200, row.raw); row.response = JSON.parse(row.raw);
  assert.equal(row.response.model, 'qwen3.8-27b');
  assert.equal(row.response.choices[0].message.content.trim(), row.expected);
  assert.equal(row.response.choices[0].finish_reason, 'stop');
  assert(!row.response.choices[0].message.tool_calls?.length);
  row.trace = fs.readFileSync(current.trace).subarray(traceBefore).toString('utf8');
  // Read only the native decision section, never a lookalike in the request.
  const decision = row.trace.split('--- cache decision ---\n')[1]?.split('--- raw request json ---')[0];
  assert(decision, 'Missing native cache decision');
  row.cacheDecision = {};
  for (const field of ['live_tokens_before', 'prompt_tokens', 'live_prompt_common',
    'memory_token_reusable', 'memory_miss_reason', 'cache_source', 'cached_tokens', 'disk_cached_tokens']) {
    const matches = [...decision.matchAll(new RegExp('^' + field + ': ([^\\n]+)$', 'gm'))];
    assert.equal(matches.length, 1, 'Missing or ambiguous native field: ' + field);
    row.cacheDecision[field] = matches[0][1];
  }
  assert.equal(Number(row.cacheDecision.live_tokens_before), row.expectedResidentTokens,
    'The cancelled prompt replaced or truncated the previous resident frontier');
}
console.log('Evidence: ' + run); save();
try {
  assert.equal(process.argv.length, 4, 'Supply a freshly installed q36 directory and existing Qwen27B weights');
  assert.equal(process.platform, 'darwin', 'Metal required: NOT RUN');
  [engine, model] = process.argv.slice(2).map(f => fs.realpathSync(f)); binary = path.join(engine, 'q36-server');
  idle(); report.installation = JSON.parse(fs.readFileSync(path.join(engine, '.dstudio-source.json'), 'utf8'));
  assert.equal(report.installation.commit, 'd67687ed15ad9f52b755a9b5fdfc0214ea937555');
  assert.equal(report.installation.engine, 'q36'); assert.equal(report.installation.backend, 'metal');
  for (const [name, expected] of Object.entries(report.installation.sources)) {
    const file = path.join(engine, name); assert.equal(hash(file), expected); report.inputs[file] = expected;
  }
  for (const file of [binary, import.meta.filename]) report.inputs[file] = hash(file);
  fs.copyFileSync(import.meta.filename, path.join(run, 'harness.mjs'), fs.constants.COPYFILE_EXCL);
  weight = await hashStableFile(model); report.weight = weight; report.weight.bytes = fs.statSync(model).size;
  assert.equal(weight.sha256, '701d8fa9ed214ab21bfc130cd2a7df19ca89bbef7713e2dfb19f3c63696aa917');
  assert.equal(report.weight.bytes, 25299061664); save();
  await startPhase('cold');
  for (let i = 0; i < facts.length; i++) await check('Cold answer ' + facts[i][0], row => answer(row, i));
  await closePhase();
  await check('Shutdown really persisted the last resident checkpoint', row => {
    row.log = report.phases[0].log;
    assert.match(row.log, /kv cache stored tokens=[1-9][0-9]* trimmed=0 reason=shutdown/);
    row.files = cacheHashes(); const last = report.cases.find(c => c.name === 'Cold answer Cedar')?.response?.usage;
    assert(last && last.prompt_tokens > 0 && last.completion_tokens > 0);
    assert(Object.values(row.files).some(f => f.reason === 4 && f.bytes > 1024 * 1024 &&
      f.tokens === last.prompt_tokens + last.completion_tokens), 'No complete final native checkpoint for Cedar');
  });
  let before;
  await check('Native checkpoints were really written', row => {
    before = cacheHashes(); row.files = before;
    assert(Object.keys(before).length >= 3, 'Expected three independently created cache records');
    assert(Object.values(before).every(f => f.bytes > 1024 * 1024));
  });
  await startPhase('restore');
  await check('Fresh process restores Alder answer', row => answer(row, 0));
  await check('The first restored answer actually loaded disk KV', row => {
    row.trace = fs.readFileSync(current.trace, 'utf8');
    assert.match(row.trace, /cache_source: disk-text/);
    assert.match(row.trace, /disk_cached_tokens: [1-9][0-9]*/);
  });
  await Promise.all([1, 2].map(i => check('Concurrent answer ' + facts[i][0], row => answer(row, i))));
  await check('Alder survives other slot activity', row => answer(row, 0));
  await check('Earlier checkpoint bytes remain unchanged', row => {
    row.after = cacheHashes();
    for (const [name, expected] of Object.entries(before || {})) assert.deepEqual(row.after[name], expected, name);
  });
  const anchor = report.cases.find(r => r.name === 'Alder survives other slot activity');
  const uninterrupted = await check('Uninterrupted followup records the native cache decision', row =>
    followupFromResident(row, anchor));
  const restored = await check('Alder resident frontier is reestablished before Stop', async row => {
    await answer(row, 0);
    assert(anchor?.passed, 'Initial resident answer failed');
    assert.deepEqual(row.response.usage, anchor.response.usage, 'The reference frontier was not restored');
    assert.deepEqual(row.response.choices, anchor.response.choices, 'The reference answer changed');
  });
  await check('Cancel during real continued prefill leaves earlier cache files intact', cancelledContinuation);
  await check('Next answer preserves the pre-cancel frontier and uninterrupted cache decision', async row => {
    await followupFromResident(row, restored);
    assert(uninterrupted.passed, 'The uninterrupted reference failed');
    // Qwen's normal transcript drops empty thinking markers. Even without Stop,
    // that can legitimately choose disk KV; RAM hits are not the state oracle.
    assert.deepEqual(row.request, uninterrupted.request, 'Reference and post-Stop requests differ');
    assert.deepEqual(row.cacheDecision, uninterrupted.cacheDecision, 'Stop changed the native cache decision');
  });
  await closePhase(); report.passed = report.cases.length === 15 && report.cases.every(r => r.passed);
  if (!report.passed) process.exitCode = 1;
} catch (e) {report.error = String(e.stack || e); console.error(report.error); process.exitCode = 1;}
finally {
  try {if (current) await closePhase();} catch (e) {report.cleanupError = String(e); report.passed = false; process.exitCode = 1;}
  for (const [file, expected] of Object.entries(report.inputs)) if (!fs.existsSync(file) || hash(file) !== expected) {
    report.changedInput = file; report.passed = false; process.exitCode = 1;
  }
  if (weight && fileIdentity(fs.statSync(model, {bigint: true})) !== weight.identity) {
    report.changedWeight = true; report.passed = false; process.exitCode = 1;
  }
  if (interrupted) {report.passed = false; process.exitCode = 1;}
  report.finished = new Date().toISOString(); save();
  console.log(JSON.stringify({run, passed: report.cases.filter(r => r.passed).length, total: report.cases.length, accepted: report.passed}));
}

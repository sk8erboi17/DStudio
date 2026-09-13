// Explicit real-model development replay through the production HTTP host.
// No simulated engine, TEST_MODE, desktop claim, or held-out quality score.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn, spawnSync} from 'node:child_process';
import {artifactRunDir, writeArtifact, freePort, sleep, csrfHeaders} from '../support/real_harness.mjs';
import {ownGitRevision} from '../support/quality_baseline.mjs';
import {verifyQwen38ToolTrace, verifyQwen38Workspace, qwenVisibleAnswer, qwenPartialResetProgress} from '../support/qwen38_tool_oracle.mjs';

assert.equal(process.platform, 'darwin', 'This runner qualifies the Metal host only');
const qwen35 = process.argv.includes('--qwen35');
const controls = process.argv.includes('--controls');
const resetLifecycle = process.argv.includes('--reset-lifecycle');
const inputs = process.argv.slice(2).filter(arg => !['--qwen35', '--controls', '--reset-lifecycle'].includes(arg));
assert.equal(inputs.length, qwen35 ? 2 : 3, 'Supply engine + model (+ PLE for Qwen3.8); optional --qwen35 / --controls / --reset-lifecycle');
const root = path.resolve(import.meta.dirname, '../..');
const [engine, model, ple] = inputs.map(file => fs.realpathSync(file));
const host = path.join(root, 'tests/.build/dstudio-server-test');
const run = artifactRunDir(qwen35 ? 'qwen35-host-live' : 'qwen38-host-live');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const identity = file => {
  const s = fs.statSync(file);
  return {path: file, bytes: s.size, dev: s.dev, ino: s.ino, mtimeMs: s.mtimeMs};
};
const report = {started: new Date().toISOString(),
  scope: 'Real headless HTTP host, Agent/Cowork tools and mode transition; development replay, not desktop or held-out quality',
  harnessSHA256: hash(fs.readFileSync(import.meta.filename)),
  helperSHA256: Object.fromEntries(['real_harness.mjs', 'quality_baseline.mjs', 'qwen38_tool_oracle.mjs']
    .map(name => [name, hash(fs.readFileSync(path.join(root, 'tests/support', name)))])),
  engine, family: qwen35 ? 'Qwen3.6-35B-A3B' : 'Qwen3.8-Flash-Next',
  revision: ownGitRevision(engine), weights: [identity(model), ...(ple ? [identity(ple)] : [])],
  sourceReceipt: fs.existsSync(path.join(engine, '.dstudio-source.json'))
    ? JSON.parse(fs.readFileSync(path.join(engine, '.dstudio-source.json'), 'utf8')) : null,
  host: {path: host, sha256: hash(fs.readFileSync(host))},
  memory: qwen35 ? 'resident model weights; no PLE, expert streaming, MTP or DSpark'
    : 'resident backbone plus native SSD-backed PLE; expert streaming off; no MTP/DSpark requested',
  settings: {backend: 'Metal', context: 16384, thinking: 'off', power: 100,
    sampling: 'unmodified production Agent defaults (not the earlier fixed-seed CLI run)',
    timeoutSecondsPerWorkflow: 600, maxToolCalls: 12, transcriptByteLimit: 3 * 1024 * 1024,
    controls, resetLifecycle, controlGenerationDeadlineSeconds: 120, interruptDeadlineSeconds: 15,
    resetDeadlineSeconds: 600, postControlReadDeadlineSeconds: 120},
  cases: [], passed: false};
const save = () => writeArtifact(run, 'results.json', report);
let child, exited, base, logFd, logBytes = 0, hostFailure;
const processExited = () => child && (child.exitCode !== null || child.signalCode !== null);
async function request(endpoint, body, timeout = 5000) {
  const begin = performance.now();
  const res = await fetch(base + endpoint, {method: body === undefined ? 'GET' : 'POST', headers: csrfHeaders,
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeout)});
  const data = await res.json();
  return {status: res.status, body: data, seconds: (performance.now() - begin) / 1000};
}
async function until(check, label, deadline) {
  while (Date.now() < deadline) {
    assert(!hostFailure, hostFailure);
    assert(!processExited(), 'Test-owned host exited: inspect host.log');
    const result = await check();
    if (result) return result;
    await sleep(300);
  }
  throw Error(`${label}: deadline exceeded`);
}
function eventsOf(text) {
  return text.split('\n').flatMap(line => {
    const i = line.indexOf('\x1e');
    return i < 0 ? [] : [JSON.parse(line.slice(i + 1))];
  });
}
async function turn(row, prompt, deadline) {
  // Use the production automatic routing, including its Task Graph when the
  // request needs it. Do not bypass ownership merely to simplify this test.
  const sent = await request('/api/agent/send', {prompt});
  assert.equal(sent.status, 200, JSON.stringify(sent));
  assert(sent.body.ok && sent.body.taskId && Number.isInteger(sent.body.from));
  const transcript = `${row.mode}-task-${sent.body.taskId}.txt`;
  const receipt = {prompt, sent, transcript, polls: [], status: 'running'};
  (row.turnReceipts ||= []).push(receipt); save();
  const out = fs.openSync(path.join(run, transcript), 'wx');
  let pos = sent.body.from, text = '', calls = 0;
  const polls = receipt.polls;
  try {
  await until(async () => {
    const r = await request('/api/agent/poll?since=' + pos);
    assert.equal(r.status, 200, JSON.stringify(r));
    assert(r.body.base <= pos && r.body.len >= pos, 'Host lost transcript bytes');
    text += r.body.text; pos = r.body.len;
    assert(Buffer.byteLength(text) <= report.settings.transcriptByteLimit, 'Transcript byte budget');
    fs.writeSync(out, r.body.text);
    // Complete records only while the stream is still in progress.
    const events = eventsOf(text.slice(0, text.lastIndexOf('\n') + 1));
    const count = events.filter(e => e.type === 'tool_call').length;
    if (count !== calls) { calls = count; console.log(`${row.mode}: ${calls} real tool call(s)`); save(); }
    assert(calls <= report.settings.maxToolCalls, 'Tool budget');
    polls.push({seconds: r.seconds, offset: pos, working: r.body.working});
    return !r.body.working && text;
  }, 'Agent turn', deadline);
  const task = await request('/api/task?id=' + sent.body.taskId);
  assert.equal(task.body.task.status, 'completed', JSON.stringify(task));
  if (sent.body.graphId) {
    receipt.graph = await until(async () => {
      const r = await request('/api/task-graph?graphId=' + encodeURIComponent(sent.body.graphId) +
        '&workspace=' + encodeURIComponent(row.workspace));
      assert.equal(r.status, 200, JSON.stringify(r));
      assert(!['failed', 'canceled', 'blocked'].includes(r.body.graph.state), JSON.stringify(r.body));
      return r.body.graph.state === 'succeeded' && r.body.graph;
    }, 'Durable graph completion', deadline);
  }
  Object.assign(receipt, {task: task.body.task, text, events: eventsOf(text), status: 'passed'});
  return receipt;
  } catch (error) { receipt.status = 'failed'; receipt.error = String(error.stack); throw error; }
  finally { fs.closeSync(out); save(); }
}
async function exerciseControls(row, output) {
  const receipt = row.controls = {passed: false}; save();
  // An ordinary number-only request takes the production automatic direct
  // path. The workspace task above separately exercises automatic Task Graph.
  receipt.prompt = 'Count the integers from 1 through 1000, one per line. Give only the numbers.';
  receipt.sent = await request('/api/agent/send', {prompt: receipt.prompt});
  assert.equal(receipt.sent.status, 200);
  assert(receipt.sent.body.ok && receipt.sent.body.taskId && !receipt.sent.body.graphId);
  let pos = receipt.sent.body.from, text = '';
  const poll = async () => {
    const r = await request('/api/agent/poll?since=' + pos);
    assert.equal(r.status, 200);
    assert(r.body.base <= pos && r.body.len >= pos, 'Lost control-turn bytes');
    text += r.body.text; pos = r.body.len;
    assert(Buffer.byteLength(text) <= report.settings.transcriptByteLimit);
    return r;
  };
  try {
    receipt.generationObserved = await until(async () => {
      const r = await poll();
      if (!r.body.working) {
        // Preserve a bounded observation of the terminal handoff before the
        // test tears down its process. A late WAITING marker must not hide
        // continued generation; a genuinely short answer remains a failure.
        receipt.earlyCompletion = [];
        for (let i = 0; i < 3; i++) {
          const state = await request('/api/status');
          const task = await request('/api/task?id=' + receipt.sent.body.taskId);
          const tail = await poll();
          receipt.earlyCompletion.push({status: state.body, task: task.body,
            working: tail.body.working, offset: pos, additionalText: tail.body.text});
          save();
          if (i < 2) await sleep(300);
        }
      }
      assert(r.body.working, 'Counting finished before interruption could be tested');
      const status = eventsOf(text.slice(0, text.lastIndexOf('\n') + 1))
        .find(e => e.type === 'status' && e.state === 'generating' && e.generated > 0);
      return status && {offset: pos, status};
    }, 'Real generation before interruption', Date.now() + report.settings.controlGenerationDeadlineSeconds * 1000);
    save();
    receipt.interrupt = await request('/api/agent/interrupt', {reason: 'Test-owned live cancellation'});
    assert.equal(receipt.interrupt.status, 200);
    assert.equal(receipt.interrupt.body.taskId, receipt.sent.body.taskId);
    assert.equal(receipt.interrupt.body.status, 'canceled');
    await until(async () => !(await poll()).body.working, 'Interrupted engine idle',
      Date.now() + report.settings.interruptDeadlineSeconds * 1000);
    receipt.task = (await request('/api/task?id=' + receipt.sent.body.taskId)).body.task;
    assert.equal(receipt.task.status, 'canceled');
    receipt.afterInterrupt = (await request('/api/status')).body;
    save();
    assert(receipt.afterInterrupt.running && receipt.afterInterrupt.ready && receipt.afterInterrupt.mode === row.mode);
    assert(!eventsOf(text).some(e => e.type === 'tool_call'), 'Number-only cancellation must have no tool effects');
    console.log(`${row.mode}: real generation interrupted, engine still ready`);
    // A new session is distinct from loading a disk checkpoint. Exercise the
    // actual reset and WAITING handoff, then require a fresh tool read.
    receipt.reset = await request('/api/design/session', {action: 'new'});
    save();
    assert.equal(receipt.reset.status, 200); assert(receipt.reset.body.ok);
    const resetStart = performance.now();
    await until(async () => {
      const s = (await request('/api/status')).body;
      assert(s.running && s.ready && s.mode === row.mode && !s.engineError);
      return !s.agentWorking && !s.agentSessionWorking;
    }, 'Native new-session reset', Date.now() + report.settings.resetDeadlineSeconds * 1000);
    receipt.resetSeconds = (performance.now() - resetStart) / 1000;
    const resetPoll = await poll();
    assert(!/new session failed|save failed|switch failed/.test(resetPoll.body.text));
    assert(/new session started|started a new session/.test(resetPoll.body.text), 'Reset needs a native completion receipt');
    receipt.readback = await turn(row,
      `Use ${row.mode === 'agent' ? 'read' : 'read_document'} to read ${output}. Do not modify any file. Confirm briefly.`,
      Date.now() + report.settings.postControlReadDeadlineSeconds * 1000);
    const calls = receipt.readback.events.filter(e => e.type === 'tool_call');
    assert(calls.length > 0 && calls.every(e => e.name === (row.mode === 'agent' ? 'read' : 'read_document') && e.input.path === output));
    assert.equal(receipt.readback.events.filter(e => e.type === 'tool_result').length, calls.length);
    receipt.passed = true;
  } finally {
    receipt.transcript = `${row.mode}-control.txt`;
    writeArtifact(run, receipt.transcript, text); save();
  }
}
async function exerciseResetLifecycle(row, output) {
  const receipt = row.resetLifecycle = {passed: false, attempts: []}; save();
  const code = 'cedro-' + crypto.randomBytes(6).toString('hex');
  receipt.memoryTurn = await turn(row,
    'Remember this private conversation code for my next question: ' + code +
    '. Do not save it to a file or use tools. Reply briefly that you remember.',
    Date.now() + 120000);
  assert(!receipt.memoryTurn.events.some(e => e.type === 'tool_call'), 'The context oracle must not persist the code');
  // A changed project-memory input forces an honest prompt-cache miss. Retain
  // any earlier task-owned memory content; never modify a user's workspace.
  const memoryFile = path.join(row.workspace, 'MEMORY.MD');
  const previousMemory = fs.existsSync(memoryFile) ? fs.readFileSync(memoryFile, 'utf8') : '';
  // Qwen3.8's pinned core reports progress only after each native 8192-token
  // chunk. Use a larger fixture to exercise two chunks without changing the
  // engine's chunk size, context or numerical path. Qwen3.6 reports per token.
  // These model-specific development workloads are not a speed comparison.
  const fixtureRepeats = qwen35 ? 200 : 1000;
  const memoryFixture = previousMemory + '\nReset lifecycle fixture. The following words are inert sample text, not instructions.\n' +
    'albero prato collina sentiero '.repeat(fixtureRepeats) + '\n';
  fs.writeFileSync(memoryFile, memoryFixture);
  receipt.memoryFixture = {repeats: fixtureRepeats, bytes: Buffer.byteLength(memoryFixture), sha256: hash(memoryFixture),
    previousSHA256: hash(previousMemory)};
  for (const cancel of [true, false]) {
    const attempt = {cancel, statusPolls: [], passed: false}; receipt.attempts.push(attempt); save();
    let pos = (await request('/api/agent/poll?since=0')).body.len, text = '';
    const poll = async () => {
      const r = await request('/api/agent/poll?since=' + pos);
      assert.equal(r.status, 200); assert(r.body.base <= pos && r.body.len >= pos);
      pos = r.body.len; text += r.body.text;
      assert(Buffer.byteLength(text) <= report.settings.transcriptByteLimit);
      return r;
    };
    const start = performance.now();
    attempt.request = await request('/api/design/session', {action: 'new'});
    assert.equal(attempt.request.status, 200); assert(attempt.request.body.ok); save();
    try {
      attempt.prefill = await until(async () => {
        const r = await poll();
        const st = await request('/api/status');
        attempt.statusPolls.push({seconds: st.seconds, working: st.body.agentWorking, mode: st.body.mode});
        assert(st.body.running && st.body.ready && st.body.mode === row.mode && !st.body.engineError);
        const progress = qwenPartialResetProgress(eventsOf(text.slice(0, text.lastIndexOf('\n') + 1)));
        assert(r.body.working, 'Reset finished before live prefill/cancellation could be observed');
        return progress;
      }, 'Reset publishes prefill before completion', Date.now() + 120000);
      save(); console.log(row.mode + ': reset prefill visible while engine is busy');
      if (cancel) {
        attempt.interrupt = await request('/api/agent/interrupt', {reason: 'Cancel the test-owned new-session preparation'});
        assert.equal(attempt.interrupt.status, 200); assert.equal(attempt.interrupt.body.status, 'canceled');
        save();
      }
      await until(async () => !(await poll()).body.working, cancel ? 'Reset cancellation' : 'Reset completion',
        Date.now() + (cancel ? report.settings.interruptDeadlineSeconds : report.settings.resetDeadlineSeconds) * 1000);
      await poll();
      const statusEvents = eventsOf(text).filter(e => e.type === 'session_status');
      assert.equal(statusEvents.length, 1, 'Exactly one terminal reset receipt');
      assert.equal(statusEvents[0].level, cancel ? 'error' : 'info');
      assert.match(statusEvents[0].message, cancel ? /interrupted; previous session retained/ : /^new session started$/);
      attempt.seconds = (performance.now() - start) / 1000;
      attempt.terminal = statusEvents[0]; attempt.passed = true;
    } finally {
      attempt.transcript = row.mode + '-reset-' + (cancel ? 'cancel' : 'success') + '.txt';
      writeArtifact(run, attempt.transcript, text); save();
    }
    if (cancel) {
      receipt.recalled = await turn(row,
        'What is the exact private conversation code I asked you to remember? Reply with only that code. Do not use tools.',
        Date.now() + 120000);
      assert(!receipt.recalled.events.some(e => e.type === 'tool_call'), 'Recall must come from retained live context');
      receipt.recalled.visibleAnswer = qwenVisibleAnswer(receipt.recalled.text).trim();
      assert.equal(receipt.recalled.visibleAnswer, code, 'Canceled reset must retain the exact conversation code');
      console.log(row.mode + ': canceled reset preserved the prior conversation');
    }
  }
  receipt.readback = await turn(row,
    'Use ' + (row.mode === 'agent' ? 'read' : 'read_document') + ' to read ' + output +
    '. Do not modify any file. Confirm briefly.', Date.now() + report.settings.postControlReadDeadlineSeconds * 1000);
  const calls = receipt.readback.events.filter(e => e.type === 'tool_call');
  assert(calls.length > 0 && calls.every(e => e.name === (row.mode === 'agent' ? 'read' : 'read_document') && e.input.path === output));
  assert.equal(receipt.readback.events.filter(e => e.type === 'tool_result').length, calls.length);
  assert.equal(fs.readFileSync(memoryFile, 'utf8'), memoryFixture, 'Reset changed the project-memory fixture');
  receipt.passed = true; save();
}
async function stopOwnedHost() {
  if (!child || processExited()) return;
  try {
    await request('/api/stop', {});
    await until(async () => !(await request('/api/status')).body.running, 'Engine shutdown', Date.now() + 15000);
  } catch (error) { report.shutdownWarning = String(error); }
  if (processExited()) return;
  try { process.kill(-child.pid, 'SIGTERM'); } catch {}
  let timer;
  const done = await Promise.race([exited.then(() => true),
    new Promise(resolve => { timer = setTimeout(() => resolve(false), 5000); })]);
  clearTimeout(timer);
  if (!done) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} await exited; }
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => {
  report.interrupted = signal; await stopOwnedHost(); save(); process.exit(130);
});
try {
  assert.equal(path.basename(engine), qwen35 ? 'ds4-qwen35' : 'ds4-qwen38', 'Use the installed Qwen engine identity');
  assert.equal(fs.realpathSync(path.join(engine, 'gguf', path.basename(model))), model);
  if (ple) assert.equal(fs.realpathSync(path.join(engine, 'gguf/Qwen3.8-Flash-Next-PLE-Q4_1.gguf')), ple);
  assert(report.weights.every(w => w.bytes > 1024 ** 3), 'Actual complete weight prerequisites required');
  const ps = spawnSync('ps', ['-axo', 'pid=,comm='], {encoding: 'utf8', timeout: 5000});
  assert.equal(ps.status, 0, ps.stderr);
  const active = ps.stdout.split('\n').filter(line => /\/(?:ds4(?:[-_](?:server|agent|cowork|design|native|cpu|pld|jsonl))+|ds4)$/.test(line.trim()));
  assert.equal(active.length, 0, `Do not overlap or stop an existing inference engine: ${active.join('\n')}`);
  report.nativeSources = Object.fromEntries(['ds4.c', 'ds4.h', 'ds4_agent.c', 'ds4_web.c', 'ds4_metal.m']
    .map(file => [file, hash(fs.readFileSync(path.join(engine, file)))]));
  const port = await freePort(); base = `http://127.0.0.1:${port}`;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^DS4(?:UI)?_|^DSTUDIO_/.test(key)));
  Object.assign(env, {DS4UI_NO_WINDOW: '1', DS4UI_DEFER_ENGINE_START: '1', DS4UI_HOST: '127.0.0.1',
    DS4UI_DATA_DIR: path.join(run, 'profile'), DS4UI_SESSION_CACHE_DIR: path.join(run, 'agent-kv'),
    DSTUDIO_KV_DIR: path.join(run, 'chat-kv')});
  logFd = fs.openSync(path.join(run, 'host.log'), 'wx');
  child = spawn(host, [String(port), engine], {cwd: root, env, detached: true, stdio: ['ignore', 'pipe', 'pipe']});
  exited = new Promise(resolve => { child.once('exit', resolve); child.once('error', error => { hostFailure = String(error); resolve(); }); });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => {
    logBytes += bytes.length;
    if (logBytes > 8 * 1024 * 1024) { hostFailure = 'Host log exceeded 8 MiB'; return; }
    fs.writeSync(logFd, bytes);
  });
  report.launcher = {pid: child.pid, argv: [String(port), engine], profile: env.DS4UI_DATA_DIR}; save();
  await until(async () => { try { return (await request('/api/status')).status === 200; } catch { return false; } },
    'Host HTTP startup', Date.now() + 20000);
  const rows = [{id: 15, state: 'ready', minutes: 12}, {id: 9, state: 'queued', minutes: 999},
    {id: 4, state: 'ready', minutes: 7}, {id: 11, state: 'ready', minutes: 5}, {id: 18, state: 'cancelled', minutes: 70}];
  const source = JSON.stringify(rows, null, 2) + '\n';
  const expected = {ids: rows.filter(r => r.state === 'ready').map(r => r.id).sort((a, b) => a - b),
    totalMinutes: rows.filter(r => r.state === 'ready').reduce((n, r) => n + r.minutes, 0)};
  let priorPid;
  for (const mode of ['agent', 'cowork']) {
    const workspace = path.join(run, mode + ' workspace with spaces'); fs.mkdirSync(workspace);
    fs.writeFileSync(path.join(workspace, 'tasks.json'), source, {flag: 'wx'});
    const output = mode === 'agent' ? 'ready.json' : 'dispatch.md';
    const row = {mode, workspace, output, passed: false}; report.cases.push(row); save();
    const begin = performance.now(), deadline = Date.now() + report.settings.timeoutSecondsPerWorkflow * 1000;
    try {
      row.launchRequest = {mode, gguf: 'gguf/' + path.basename(model), workdir: workspace,
        ctx: report.settings.context, think: 'off', power: qwen35 ? 37 : 100, ssdStreaming: 'off', dspark: false};
      row.launchResponse = await request('/api/start', row.launchRequest, 60000);
      assert.equal(row.launchResponse.status, 200, JSON.stringify(row.launchResponse));
      assert(row.launchResponse.body.ok && !row.launchResponse.body.shared, 'Must own the engine');
      row.ready = await until(async () => {
        const r = await request('/api/status');
        assert.equal(r.status, 200);
        assert(!r.body.engineError, JSON.stringify(r.body));
        return r.body.ready && r.body.mode === mode && !r.body.agentWorking && r.body;
      }, 'Model readiness', deadline);
      const launchTask = await request('/api/task?id=' + row.launchResponse.body.taskId);
      assert.equal(launchTask.body.task.status, 'completed');
      row.enginePid = launchTask.body.task.pid; assert(row.enginePid > 1);
      assert.notEqual(row.enginePid, priorPid, 'Mode change must start the requested runtime');
      if (priorPid) {
        const gone = spawnSync('ps', ['-p', String(priorPid), '-o', 'pid='], {encoding: 'utf8', timeout: 5000});
        assert.equal(gone.stdout.trim(), '', 'Previous heavyweight process was not released');
      }
      assert.equal(row.ready.modelFile, row.launchRequest.gguf);
      assert.equal(row.ready.config.power, 100, 'Report effective native power without changing the requested preference');
      assert.equal(row.ready.agentDiskCheckpointsSupported, !qwen35);
      row.nativeCommand = spawnSync('ps', ['-ww', '-p', String(row.enginePid), '-o', 'command='], {encoding: 'utf8', timeout: 5000}).stdout.trim();
      if (qwen35) {
        assert(!/--power|--ple|--ssd-streaming|--dspark|--q35-experts|--kv-disk-dir/.test(row.nativeCommand));
        row.checkpointRejection = await request('/api/design/session', {action: 'save'});
        assert.equal(row.checkpointRejection.status, 409);
        assert.equal(row.checkpointRejection.body.code, 'unsupported_session_checkpoint');
        assert(!(await request('/api/status')).body.agentWorking, 'Unsupported checkpoint must not occupy the engine');
      }
      row.prompt = mode === 'agent'
        ? 'Read tasks.json in this workspace. Create ready.json as a JSON object with exactly two fields: ids (numeric IDs of ready items, sorted ascending) and totalMinutes (sum of minutes for ready items only). Derive values from the file; do not change tasks.json. Use read and write/edit file tools, not bash or network. Reopen ready.json with a tool to verify it, then give a brief final summary.'
        : 'Read tasks.json using read_document. Create dispatch.md using write_document. Its content must have exactly two lines: "Ready: " followed by the numeric IDs of ready items sorted ascending, separated by comma and space; and "Minutes: " followed by their total minutes. Derive values from the file; do not change tasks.json. Reopen dispatch.md using read_document to verify it, then give a brief final summary. Do not use shell or network.';
      row.turn = await turn(row, row.prompt, deadline);
      row.toolChecks = verifyQwen38ToolTrace(mode, row.turn.events, output);
      const file = path.join(workspace, output), s = fs.lstatSync(file);
      assert(s.isFile() && !s.isSymbolicLink() && s.size < 65536);
      const actual = fs.readFileSync(file, 'utf8');
      if (mode === 'agent') assert.deepEqual(JSON.parse(actual), expected);
      else assert.equal(actual.trim(), `Ready: ${expected.ids.join(', ')}\nMinutes: ${expected.totalMinutes}`);
      assert.equal(fs.readFileSync(path.join(workspace, 'tasks.json'), 'utf8'), source, 'Source changed');
      row.workspaceChecks = verifyQwen38Workspace(workspace, ['tasks.json', output],
        row.turnReceipts.map(t => t.sent.body.graphId).filter(Boolean));
      row.artifact = {sha256: hash(actual), bytes: s.size};
      // Unsupported Design must be rejected while a real, usable engine exists.
      row.rejectedSwitch = await request('/api/start', {...row.launchRequest, mode: 'design'});
      assert.equal(row.rejectedSwitch.status, 409);
      assert.equal(row.rejectedSwitch.body.code, 'unsupported_model_mode');
      const kept = (await request('/api/status')).body;
      assert(kept.running && kept.ready && kept.mode === mode && kept.modelFile === row.launchRequest.gguf);
      // This post-rejection tool result proves liveness, not just a green badge.
      row.recovery = await turn(row, `Use ${mode === 'agent' ? 'read' : 'read_document'} to read ${output} again. Do not write or change any file. Then confirm briefly. Do not use shell or network.`, deadline);
      const calls = row.recovery.events.filter(e => e.type === 'tool_call');
      assert(calls.length > 0 && calls.every(e => e.name === (mode === 'agent' ? 'read' : 'read_document') && e.input.path === output));
      assert.equal(row.recovery.events.filter(e => e.type === 'tool_result').length, calls.length);
      assert.equal(fs.readFileSync(file, 'utf8'), actual, 'Recovery changed output');
      assert.equal(fs.readFileSync(path.join(workspace, 'tasks.json'), 'utf8'), source);
      row.workflowSeconds = (performance.now() - begin) / 1000;
      if (controls) await exerciseControls(row, output);
      if (resetLifecycle) await exerciseResetLifecycle(row, output);
      assert.equal(fs.readFileSync(file, 'utf8'), actual, 'Controls changed a prior artifact');
      assert.equal(fs.readFileSync(path.join(workspace, 'tasks.json'), 'utf8'), source);
      row.finalWorkspaceChecks = verifyQwen38Workspace(workspace, ['tasks.json', output, ...(resetLifecycle ? ['MEMORY.MD'] : [])],
        row.turnReceipts.map(t => t.sent.body.graphId).filter(Boolean));
      if (qwen35) {
        assert(!fs.existsSync(env.DS4UI_SESSION_CACHE_DIR), 'Incomplete recurrent checkpoints must not be created');
        assert(!fs.existsSync(env.DSTUDIO_KV_DIR), 'Agent launch must not create a Chat disk cache');
      }
      priorPid = row.enginePid; row.passed = true;
    } catch (error) { row.error = String(error.stack); console.error(row.error); }
    row.seconds = (performance.now() - begin) / 1000; save();
    console.log(`${mode}: ${row.passed ? 'PASS' : 'FAIL'} (${row.seconds.toFixed(2)} s)`);
    if (!row.passed) break; // Do not obscure a failure with another heavyweight start.
  }
  assert.deepEqual([identity(model), ...(ple ? [identity(ple)] : [])], report.weights, 'Weight identity changed');
  for (const [file, expectedHash] of Object.entries(report.nativeSources))
    assert.equal(hash(fs.readFileSync(path.join(engine, file))), expectedHash, 'Launch changed native source: ' + file);
  report.passed = report.cases.length === 2 && report.cases.every(r => r.passed);
} catch (error) { report.error = String(error.stack); console.error(report.error); }
finally {
  await stopOwnedHost();
  if (logFd !== undefined) fs.closeSync(logFd);
  report.hostLogBytes = logBytes; report.finished = new Date().toISOString(); save();
  console.log(`Preserved host/model evidence: ${run}`);
}
if (!report.passed) process.exitCode = 1;

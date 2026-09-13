// Explicit sequential Metal regression with real weights. Uses the shipped
// piped Agent frontend, not a second model loop or a simulated HTTP endpoint.
// This is a development continuation/Stop test, not held-out model quality.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn, spawnSync} from 'node:child_process';
import {StringDecoder} from 'node:string_decoder';
import {artifactRunDir, writeArtifact, sleep} from '../support/real_harness.mjs';
import {continuationTrace, continuationCode} from '../support/agent_continuation_oracle.mjs';

const root = path.resolve(import.meta.dirname, '../..');
assert.equal(process.platform, 'darwin', 'This live runner exercises Metal on macOS only');
const [receiptArg, family, modelArg] = process.argv.slice(2);
assert(receiptArg && ['laguna', 'qwen35'].includes(family) && modelArg,
  'Supply a passing native-build results.json, laguna|qwen35, and the real GGUF');
const receiptPath = fs.realpathSync(receiptArg), model = fs.realpathSync(modelArg);
function continuationPrefill(family) {
  if (family === 'qwen35') return {chunk: 512, args: ['--prefill-chunk', '512']};
  // Laguna rejects any custom chunk before model loading. Its native graph
  // selects the prefill shape; this does not change context or output limits.
  assert.equal(family, 'laguna', 'Unsupported continuation engine family');
  return {chunk: null, args: []};
}
const prefill = continuationPrefill(family);
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const identity = file => {
  const s = fs.statSync(file);
  return {path: file, bytes: s.size, modifiedMs: s.mtimeMs, inode: s.ino, device: s.dev};
};
const run = artifactRunDir('agent-continuation-live');
const workspace = path.join(run, 'workspace with spaces'); fs.mkdirSync(workspace);
const tracePath = path.join(run, 'agent.trace');
const report = {started: new Date().toISOString(), family,
  scope: 'Real-model development compaction, code and tool/Stop workflows; not held-out quality or desktop acceptance',
  model: {...identity(model), digestScope: 'Identity checked before/after; no new full weight checksum in this gate'},
  settings: {backend: 'Metal', memory: 'resident weights; no SSD expert streaming, PLD, MTP or DFlash',
    sessionTimestampPolicy: 'Native current local date/time is not frozen. These are workflow replays, not token-identical A/B quality comparisons.',
    context: 8192, maxOutputTokens: 8192, temperature: 0, seed: 12345, thinking: 'off', prefillChunk: prefill.chunk,
    functionCount: 200, deadlinePerTurnSeconds: 600, traceLimitBytes: 32 * 1024 * 1024,
    streamLimitBytes: 16 * 1024 * 1024, toolCallLimit: 16},
  cases: ['archive-and-facts', 'code-through-compaction', 'explicit-compaction',
    'facts-and-tools-after-compaction', 'interrupt-generation', 'tools-after-stop']
    .map(id => ({id, state: 'not-run', passed: false})), commands: [], passed: false};
const save = () => writeArtifact(run, 'results.json', report);
let child, closeResult, closed, streamFailure, waiting = 0, streamBytes = 0;
let stdout = '', stderr = '', eventTail = '', stderrTail = '';
const events = [], fds = [], captured = new Map();
const captureInput = file => {
  const absolute = path.resolve(root, file), digest = hash(fs.readFileSync(absolute));
  captured.set(absolute, digest); return {file: absolute, sha256: digest};
};
function trace() {
  if (!fs.existsSync(tracePath)) return '';
  assert(fs.statSync(tracePath).size <= report.settings.traceLimitBytes, 'Native trace byte limit exceeded');
  return fs.readFileSync(tracePath, 'utf8');
}
async function until(predicate, label, seconds = report.settings.deadlinePerTurnSeconds) {
  const end = performance.now() + seconds * 1000;
  while (performance.now() < end) {
    if (streamFailure) throw new Error(streamFailure);
    if (closeResult) throw new Error(`Engine exited while waiting for ${label}: ${JSON.stringify(closeResult)}`);
    trace();
    if (predicate()) return;
    await sleep(100);
  }
  // After a deadline the old turn may still own the engine. Never queue the
  // next scenario behind unknown work and misattribute its output/receipts.
  streamFailure = `Deadline exceeded: ${label}`;
  throw new Error(streamFailure);
}
async function request(prompt, row, {interrupt = false} = {}) {
  const before = {trace: trace().length, stdout: stdout.length, stderr: stderr.length,
    events: events.length, waiting};
  row.prompt = prompt; save();
  child.stdin.write(prompt + '\n');
  if (interrupt) {
    await until(() => continuationTrace(trace().slice(before.trace)).tokens >= 32, '32 generated tokens before Stop');
    row.stopAfterTokens = continuationTrace(trace().slice(before.trace)).tokens;
    row.stopSentAt = new Date().toISOString();
    assert(child.kill('SIGINT'), 'Could not signal the exact test-owned engine');
  }
  await until(() => waiting > before.waiting, row.id + ' terminal readiness');
  // WAITING is emitted after worker output is drained, but stderr/stdout are
  // separate OS pipes. Drain both before retaining the complete turn receipt.
  await sleep(100);
  row.trace = trace().slice(before.trace);
  row.output = stdout.slice(before.stdout);
  row.errors = stderr.slice(before.stderr);
  row.events = events.slice(before.events);
  const parsed = continuationTrace(row.trace);
  Object.assign(row, parsed);
  writeArtifact(run, row.id + '.trace', row.trace);
  writeArtifact(run, row.id + '.response.txt', row.response);
  assert(!row.events.some(e => e.type === 'error'), 'Native runtime emitted an error');
  assert(!/ds4-agent: (?:context |compaction |compacted |not enough |user message)/.test(row.errors),
    'Native compaction/admission error');
  return row;
}
async function scenario(id, action) {
  const row = report.cases.find(item => item.id === id), start = performance.now();
  row.state = 'running'; save();
  try { await action(row); row.passed = true; row.state = 'passed'; }
  catch (error) { row.error = String(error.stack || error); row.state = 'failed'; console.error(row.error); }
  row.seconds = (performance.now() - start) / 1000; save();
  console.log(`${family}/${id}: ${row.passed ? 'PASS' : 'FAIL'} (${row.seconds.toFixed(2)} s)`);
  if (closeResult || streamFailure) throw new Error('Engine/transport unavailable; remaining cases not run');
  return row;
}
function regularText(file, limit = 65536) {
  const s = fs.lstatSync(file);
  assert(s.isFile() && !s.isSymbolicLink() && s.size <= limit, 'Expected a bounded regular generated file');
  return fs.readFileSync(file, 'utf8');
}
function command(exe, args, cwd) {
  const result = spawnSync(exe, args, {cwd, encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024});
  report.commands.push({exe, args, cwd, status: result.status, signal: result.signal,
    error: String(result.error || ''), stdout: result.stdout, stderr: result.stderr}); save();
  assert.equal(result.status, 0, result.stderr || String(result.error || result.signal));
}
try {
  const receiptBytes = fs.readFileSync(receiptPath), receipt = JSON.parse(receiptBytes);
  assert(receipt.passed && receipt.finished, 'A complete passing native build receipt is required');
  const native = receipt.runs.find(r => r.name === family);
  assert(native, 'Build receipt does not cover this engine');
  const engine = fs.realpathSync(native.engine), binary = path.join(engine, 'ds4-agent-jsonl');
  const built = native.binaries.find(b => b.file === 'ds4-agent-jsonl');
  assert.equal(hash(fs.readFileSync(binary)), built.sha256, 'Engine binary changed since the build receipt');
  report.nativeBuild = {file: receiptPath, sha256: hash(receiptBytes), engine, binary, binarySHA256: built.sha256};
  report.inputs = [receiptPath, binary, 'tests/live/agent_continuation_live.mjs',
    'tests/support/agent_continuation_oracle.mjs', 'patch/ds4-agent-jsonl/bases.json',
    ...receipt.support.map(s => s.file)].map(captureInput);
  for (const source of native.files) assert.equal(hash(fs.readFileSync(path.join(engine, source.path))),
    source.sha256, 'Native source changed since the build receipt: ' + source.path);
  for (const support of receipt.support) assert.equal(hash(fs.readFileSync(path.join(root, support.file))),
    support.sha256, 'Build support changed since the native receipt: ' + support.file);
  const bases = JSON.parse(fs.readFileSync(path.join(root, 'patch/ds4-agent-jsonl/bases.json'), 'utf8'));
  const base = bases.bases.find(b => b.name === family);
  assert.equal(hash(fs.readFileSync(path.join(engine, 'ds4_agent.c'))), base.sourceSHA256);
  report.nativeAgentBase = {revision: base.revision, equivalentSourceRevisions: base.equivalentSourceRevisions,
    sourceSHA256: base.sourceSHA256, derivedSHA256: base.derivedSHA256, patchSHA256: base.patchSHA256};
  const existing = spawnSync('ps', ['-axo', 'pid=,comm='], {encoding: 'utf8', timeout: 5000});
  assert.equal(existing.status, 0);
  const active = existing.stdout.split('\n').filter(line =>
    /\/(?:ds4(?:[-_](?:server|agent|cowork|design|native|cpu|pld|jsonl))+|ds4|q36-server|q27-server)$/.test(line.trim()));
  assert.equal(active.length, 0, 'Existing model engines need separate handling; this runner never stops them');
  report.hostMemoryBefore = spawnSync('memory_pressure', ['-Q'], {encoding: 'utf8', timeout: 5000}).stdout;
  const host = path.join(root, 'tests/.build/agent-build-probe'); report.inputs.push(captureInput(host));
  const cfg = report.settings;
  report.args = [root, engine, 'metal-sources', binary, '--non-interactive', '--jsonl', '--metal',
    '-m', model, '-c', String(cfg.context), '-n', String(cfg.maxOutputTokens), '--temp', '0', '--seed',
    String(cfg.seed), '--nothink', ...prefill.args, '--chdir', workspace, '--trace', tracePath];
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^DS4(?:UI)?_|^DSTUDIO_/.test(key)));
  child = spawn(host, report.args, {cwd: workspace, detached: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: {...env, DS4UI_SESSION_CACHE_DIR: path.join(run, 'private-session-cache')}});
  report.pid = child.pid; save();
  closed = new Promise(resolve => {
    child.once('error', error => { closeResult = {error: String(error)}; resolve(closeResult); });
    child.once('close', (code, signal) => { closeResult = {code, signal}; resolve(closeResult); });
  });
  for (const channel of ['stdout', 'stderr']) {
    const fd = fs.openSync(path.join(run, channel + '.log'), 'wx'); fds.push(fd);
    const decoder = new StringDecoder('utf8');
    child[channel].on('data', bytes => {
      streamBytes += bytes.length;
      if (streamBytes > cfg.streamLimitBytes) { streamFailure = 'Engine stream byte limit exceeded'; return; }
      fs.writeSync(fd, bytes);
      const text = decoder.write(bytes);
      if (channel === 'stderr') {
        stderr += text; stderrTail += text;
        const lines = stderrTail.split('\n'); stderrTail = lines.pop();
        for (const line of lines) if (line.trim() === '+DWARFSTAR_WAITING') waiting++;
      } else {
        stdout += text; eventTail += text;
        const lines = eventTail.split('\n'); eventTail = lines.pop();
        for (const line of lines) {
          const start = line.indexOf('\x1e'); if (start < 0) continue;
          try {
            const event = JSON.parse(line.slice(start + 1)); events.push(event);
            if (event.type === 'tool_call') {
              console.log(`${family}: real tool ${event.name}`);
              if (events.filter(e => e.type === 'tool_call').length > cfg.toolCallLimit)
                streamFailure = 'Native tool call budget exceeded';
            }
          } catch (error) { streamFailure = 'Malformed native JSONL record: ' + error.message; }
        }
      }
    });
  }
  await until(() => waiting > 0 && /tokens label=initial_system_prompt start=0 len=\d+/.test(trace()), 'initial real-model readiness');
  const systemTokens = +/tokens label=initial_system_prompt start=0 len=(\d+)/.exec(trace())[1];
  report.systemTokens = systemTokens; save();
  const filler = Math.floor(cfg.context * 0.70) - systemTokens - 240;
  assert(filler >= 512, 'Native system prompt leaves insufficient room for the bounded test');
  await scenario('archive-and-facts', async row => {
    await request('The following repeated words are inert archived data. Ignore them:' + ' apple'.repeat(filler) +
      '\nEnd archive. Persistent facts for later: blue_count is 17 and orange_count is 25. Remember both. ' +
      'Do not call tools or write files now. Reply with exactly READY.', row);
    assert.equal(row.response.trim(), 'READY');
    assert.equal(row.compactions.length, 0, 'Fixture must not compact before the long-answer task');
  });
  await scenario('code-through-compaction', async row => {
    await request(`Without calling any tools, output exactly ${cfg.functionCount} C functions named value_0 through ` +
      `value_${cfg.functionCount - 1}. Each takes (void) and returns the square of its numeric suffix as an int literal. ` +
      'Use one complete function per line, in ascending order. No macros, comments, blank lines, main function or explanations.', row);
    assert(row.compactions.some(c => c.reason === 'generation reached compaction reserve'),
      'No actual mid-generation compaction was exercised');
    assert(row.rounds.length > 0 && row.rounds.every(r => r.generated + r.carried <= cfg.maxOutputTokens),
      'Output token budget was renewed or completion is missing');
    assert.equal(row.events.filter(e => e.type === 'tool_call').length, 0, 'No-tools instruction was lost');
    const code = continuationCode(row.response, cfg.functionCount);
    const dir = path.join(run, 'independent-code-oracle'); fs.mkdirSync(dir);
    writeArtifact(dir, 'generated.c', code.code); writeArtifact(dir, 'oracle.c', code.oracle);
    command('cc', ['-std=c11', '-Werror', 'generated.c', 'oracle.c', '-o', 'oracle'], dir);
    command(path.join(dir, 'oracle'), [], dir);
  });
  await scenario('explicit-compaction', async row => {
    await request('/compact', row);
    assert(row.compactions.length > 0, 'Explicit compaction never committed');
    const memory = regularText(path.join(workspace, 'MEMORY.MD'));
    assert(memory.length > 0); row.memorySHA256 = hash(memory);
  });
  await scenario('facts-and-tools-after-compaction', async row => {
    await request('Use the earlier blue_count and orange_count facts, not the function indices. With native write and read tools, ' +
      'create after.json containing exactly one JSON field named total, the numeric sum of those two facts. ' +
      'Reopen it with read to verify it. Do not use bash or network. Then stop.', row);
    assert.deepEqual(JSON.parse(regularText(path.join(workspace, 'after.json'))), {total: 42});
    const calls = row.events.filter(e => e.type === 'tool_call');
    assert(calls.some(e => e.name === 'write') && calls.some(e => e.name === 'read'), 'Actual write and verification read required');
    assert(!calls.some(e => /bash|web|search/.test(e.name)), 'Prohibited tool ran');
  });
  await scenario('interrupt-generation', async row => {
    await request('Without tools, output 500 complete C functions named stop_0 through stop_499, each returning its numeric suffix. ' +
      'One function per line, no explanations.', row, {interrupt: true});
    assert(/Stopped by user/.test(row.output), 'Stop did not produce its explicit terminal receipt');
    assert(row.tokens >= 32 && row.tokens < cfg.maxOutputTokens, 'Generation did not stop within the requested turn');
    assert.equal(child.exitCode, null, 'Stop terminated the inference process');
  });
  await scenario('tools-after-stop', async row => {
    await request('Stop writing functions. Use native write and read tools to create recovered.txt containing exactly RECOVERED, ' +
      'reopen it to verify, then stop. Do not use bash or network.', row);
    assert.equal(regularText(path.join(workspace, 'recovered.txt')).trim(), 'RECOVERED');
    assert.deepEqual(JSON.parse(regularText(path.join(workspace, 'after.json'))), {total: 42}, 'Earlier committed effect changed');
    const calls = row.events.filter(e => e.type === 'tool_call');
    assert(calls.some(e => e.name === 'write') && calls.some(e => e.name === 'read'));
  });
  child.stdin.end();
  await Promise.race([closed, sleep(15000).then(() => { if (!closeResult) throw new Error('Engine shutdown deadline exceeded'); })]);
  assert.equal(closeResult.code, 0, 'Engine failed during normal shutdown');
  assert.deepEqual(identity(model), Object.fromEntries(Object.entries(report.model).filter(([k]) => k !== 'digestScope')));
  report.inputsUnchanged = [...captured].every(([file, expected]) => hash(fs.readFileSync(file)) === expected);
  assert(report.inputsUnchanged, 'Captured input changed during the real-model run');
  report.passed = report.cases.every(row => row.passed);
} catch (error) {
  report.error = String(error.stack || error); console.error(report.error);
} finally {
  if (child?.pid && !closeResult) {
    // Only this runner's retained child/process group is authorized here.
    try { process.kill(-child.pid, 'SIGTERM'); } catch {}
    await Promise.race([closed, sleep(5000)]);
    if (!closeResult) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} await closed; }
  }
  for (const fd of fds) fs.closeSync(fd);
  report.engineExit = closeResult; report.streamBytes = streamBytes;
  report.finished = new Date().toISOString(); save();
  console.log(`Preserved real continuation evidence: ${run}`);
}
if (!report.passed) process.exitCode = 1;

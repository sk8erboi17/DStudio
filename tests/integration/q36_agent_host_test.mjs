// Actual DStudio host, preparation, native Agent/Cowork and filesystem tools.
// Only installation/inference responses are controlled fixtures, not LLM quality.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { artifactRunDir, freePort, sleep, csrfHeaders } from '../support/real_harness.mjs';
import { q36VisionPNG } from '../support/q36_vision_fixtures.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const run = artifactRunDir('q36-agent-host');
const binary = fs.realpathSync(process.argv[2]);
const source = fs.realpathSync(process.argv[3]);
const install = path.join(run, 'install with spaces');
const main = path.join(install, 'ds4'), engine = path.join(install, 'q36');
const assets = path.join(run, 'assets'), work = path.join(run, 'workspace');
const model = 'gguf/Qwen3.8-27B-UD-Q6_K_XL.gguf';
const projector = 'gguf/Qwen3.8-27B-mmproj-F16.gguf';
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const withBrowser = process.argv.includes('--browser');
const report = { started: new Date().toISOString(), passed: false, plannedChecks: withBrowser ? 19 : 17, cases: [],
  scope: 'Native host, real DStudio tools and file effects; simulated inference and q36 installation',
  hostSHA256: hash(binary), source, sourceFiles: [] };
const save = () => fs.writeFileSync(path.join(run, 'results.json'), JSON.stringify(report, null, 2));
function fixture(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // The peer polls for this path: presence must mean a complete fixture, not
  // the just-opened empty file while writeFileSync is still writing bytes.
  const pending = file + '.preparing'; fs.writeFileSync(pending, value, { flag: 'wx' });
  fs.renameSync(pending, file);
}
// Sources only. Do not copy weights, run a model, or modify the supplied tree.
const dirs = new Set(['metal', 'cuda', 'rocm', 'third_party', 'tests']);
function snapshot(rel = '') {
  for (const entry of fs.readdirSync(path.join(source, rel), { withFileTypes: true })) {
    const name = path.join(rel, entry.name);
    if (entry.isDirectory() && (rel || dirs.has(entry.name))) snapshot(name);
    else if (entry.isFile() && (/\.(c|h|m|mm|inc|metal|cu|cuh)$/.test(name) || ['Makefile', '.gitignore'].includes(entry.name))) {
      const from = path.join(source, name), to = path.join(main, name);
      assert(fs.statSync(from).size < 32 * 1024 * 1024);
      fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(from, to);
      report.sourceFiles.push({ name, sha256: hash(from) });
    }
  }
}
snapshot();
for (const dir of [engine, assets, work]) fs.mkdirSync(dir, { recursive: true });
fixture(path.join(main, model), 'model fixture'); fixture(path.join(main, projector), 'projector fixture');
fs.symlinkSync('../ds4/gguf', path.join(engine, 'gguf'));
fixture(path.join(engine, 'Makefile'), 'all:\n\t@false\n');
fixture(path.join(engine, '.dstudio-source.json'), '{"fixture":true}\n');
fs.copyFileSync(path.join(root, 'tests/support/q36_host_tool_peer.mjs'), path.join(engine, 'q36-server'));
fs.chmodSync(path.join(engine, 'q36-server'), 0o755);
for (const dir of ['patch', 'extension', 'web']) fs.symlinkSync(path.join(root, dir), path.join(assets, dir));
fs.mkdirSync(path.join(assets, 'scripts'));
for (const file of fs.readdirSync(path.join(root, 'scripts'))) {
  if (file !== 'install-q36.py') fs.symlinkSync(path.join(root, 'scripts', file), path.join(assets, 'scripts', file));
}
fixture(path.join(assets, 'scripts/install-q36.py'), `import pathlib, sys, time
root = pathlib.Path(sys.argv[sys.argv.index('--root') + 1]) / 'q36'
if (root / 'prepare-fail').exists(): sys.exit(23)
if (root / 'prepare-hold').exists():
    (root / 'prepare-entered').write_text('entered')
    while not (root / 'prepare-release').exists(): time.sleep(0.02)
print('controlled q36 installer: no download or inference')
`);
fixture(path.join(work, 'source.txt'), 'SOURCE_EVIDENCE');
const imageBytes = q36VisionPNG(0), changedImageBytes = q36VisionPNG(1);
fixture(path.join(run, 'outside.png'), changedImageBytes);
fs.symlinkSync(path.join(run, 'outside.png'), path.join(work, 'outside-link.png'));
// A user-owned JSON example must survive verbatim even when it names an
// existing tool. Removing generated duplicate schemas is not a text scrubber.
const userSchemaExample = { type: 'function', function: { name: 'read_pdf',
  description: 'USER_MEMORY_EXAMPLE_ONLY', parameters: { type: 'object', properties: {} } } };
const userMemory = '# Project note\nKeep this example verbatim; it is not a new tool.\n' + JSON.stringify(userSchemaExample) + '\n';
fixture(path.join(work, 'MEMORY.MD'), userMemory);
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(DS4|DSTUDIO_|Q36_|DYLD_|LD_)/.test(key)));
Object.assign(env, { DS4UI_DATA_DIR: path.join(run, 'profile'), DSTUDIO_KV_DIR: path.join(run, 'kv'),
  DS4UI_NO_WINDOW: '1', DS4UI_DEFER_ENGINE_START: '1', DS4UI_TEST_MODE: '1', DS4UI_HOST: '127.0.0.1', MAKEFLAGS: '', MFLAGS: '' });
const port = await freePort(), enginePort = await freePort(), base = `http://127.0.0.1:${port}`;
const log = fs.openSync(path.join(run, 'host.log'), 'wx');
const host = spawn(binary, [String(port), engine], { cwd: root, env, stdio: ['ignore', log, log] }); fs.closeSync(log);
const terminal = new Promise(resolve => { host.once('exit', (code, signal) => resolve({ code, signal })); host.once('error', error => resolve({ error: error.message })); });
const config = { mode: 'server', gguf: model, ctx: 8192, power: 100, port: enginePort,
  kvSpaceMb: 256, kvMinTokens: 128, think: 'off', ssdStreaming: 'off', workdir: work };
async function request(endpoint, body, timeout = 3000) {
  const res = await fetch(base + endpoint, { method: body === undefined ? 'GET' : 'POST', headers: csrfHeaders,
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeout) });
  return { status: res.status, body: await res.json() };
}
const state = async () => (await request('/api/status')).body;
async function until(fn, message, timeout = 12000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const found = await fn(); if (found) return found; await sleep(25); }
  throw new Error(message);
}
const idle = () => until(async () => { const s = await state(); return s.ready && !s.agentWorking ? s : false; }, 'runtime did not become ready and idle');
const launch = (mode, settings = {}) => request('/api/start', { ...config, mode, ...settings }, 180000);
const graphState = async id => (await request(`/api/task-graph?graphId=${encodeURIComponent(id)}&workspace=${encodeURIComponent(work)}`)).body.graph;
async function graphControl(action, id) {
  const g = await graphState(id);
  return request(`/api/task-graph/${action}`, { graphId: id, workspace: work,
    expectedRevision: g.revision, expectedLastEventSeq: g.lastEventSeq });
}
async function admissionSnapshot() {
  const s = await idle();
  return { config: s.config, residentPid: s.residentPid, mode: s.mode,
    tasks: (await request('/api/tasks')).body.tasks,
    graphs: (await request(`/api/task-graphs?workspace=${encodeURIComponent(work)}`)).body.graphs,
    requests: fs.readdirSync(path.join(engine, 'requests')).sort(),
    source: fs.readFileSync(path.join(work, 'source.txt'), 'utf8'),
    result: fs.readFileSync(path.join(work, 'result.txt'), 'utf8') };
}
const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
let resident, count = 0;
async function nextRequest(think = false, tools = true) {
  const file = path.join(engine, `requests/${resident}-${++count}`);
  await until(() => fs.existsSync(`${file}.request.json`), 'selected owned model did not receive the tool request');
  const packet = JSON.parse(fs.readFileSync(`${file}.request.json`, 'utf8'));
  assert.equal(packet.body.model, 'qwen3.8-27b'); assert.equal(packet.headers.authorization, undefined);
  assert.equal(packet.body.think, think);
  if (tools) assert.ok(packet.body.tools?.length > 0);
  return { file, ...packet };
}
const answer = (r, reply) => fixture(`${r.file}.response.json`, JSON.stringify(reply));
function checkStructuredCatalog(packet) {
  const system = packet.body.messages.find(m => m.role === 'system')?.content;
  assert.equal(typeof system, 'string');
  assert(system.includes(userMemory), 'User-authored memory changed while building the request');
  const inline = system.split('\n').flatMap(line => {
    try {const value = JSON.parse(line); return value?.type === 'function' && value.function ? [value] : [];}
    catch {return [];}
  });
  assert.deepEqual(inline, [userSchemaExample], 'Generated function schemas were duplicated into system text');
  const names = packet.body.tools.map(t => t.function.name);
  assert.equal(new Set(names).size, names.length, 'Duplicate formal tool definitions');
  for (const name of ['skill', 'design_system', 'pack_file', 'skills_search', 'read_pdf', 'question', 'gsa_submit_phase'])
    assert(names.includes(name), 'Removing inline declarations must not remove the actual tool: ' + name);
  const pdf = packet.body.tools.find(t => t.function.name === 'read_pdf').function;
  assert.equal(pdf.parameters.properties.path.type, 'string');
  assert.equal(pdf.parameters.properties.pages.type, 'string');
  assert(pdf.parameters.required.includes('path'));
}
async function check(name, fn) {
  const row = { name, passed: false }; report.cases.push(row); save();
  try { await fn(row); row.passed = true; }
  catch (error) {
    row.error = error.stack;
    try { row.tasksAtFailure = (await request('/api/tasks')).body; } catch {}
    throw error;
  }
  finally { save(); console.log(`${row.passed ? 'PASS' : 'FAIL'} ${name}`); }
}
async function imageWorkflow(row, mode) {
  row.visionState = await state();
  fixture(path.join(work, 'input.png'), imageBytes);
  assert.equal((await request('/api/agent/send', { prompt: 'Inspect input.png with view_image.' })).status, 200);
  const first = await nextRequest();
  assert(first.body.tools.some(t => t.function.name === 'view_image'), 'Owned vision model must expose the actual image tool');
  // Inspect the actual request, not host source. A real tool schema must not
  // coexist with instructions denying that the selected runtime can use it.
  row.visionGuidance = first.body.messages.find(m => m.role === 'system')?.content
    .split('\n').find(line => line.startsWith('Vision:')) || '';
  const id = mode + '-image';
  answer(first, { tools: [call(id, 'view_image', { path: 'input.png' })] });
  const second = await nextRequest();
  const imageParts = packet => packet.body.messages.flatMap(m => Array.isArray(m.content) ? m.content : [])
    .filter(part => part.type === 'image_url');
  const expected = [{ type: 'image_url', image_url: { url: 'data:image/png;base64,' + imageBytes.toString('base64') } }];
  assert.deepEqual(imageParts(second), expected, 'The inference request must contain the original PNG bytes');
  const result = second.body.messages.find(m => m.role === 'tool' && m.tool_call_id === id);
  assert.match(result?.content || '', /Image bytes attached/);
  const observation = second.body.messages.find(m => Array.isArray(m.content));
  assert.equal(observation.role, 'user');
  assert(observation.content.some(part => part.type === 'text' && part.text.includes(id)), 'Image must retain its tool-call identity');
  fixture(path.join(work, 'input.png'), changedImageBytes);
  answer(second, { tools: [call(mode + '-outside', 'view_image', { path: 'outside-link.png' })] });
  const third = await nextRequest();
  assert.match(third.body.messages.find(m => m.tool_call_id === mode + '-outside')?.content || '', /outside|workspace/i);
  assert.deepEqual(imageParts(third), expected, 'A rejected path or changed file cannot replace the original observation');
  answer(third, { text: 'Image observation received; outside path rejected.' }); await idle();
  assert.equal((await request('/api/agent/send', { prompt: 'Continue from the same image, without reading the changed file.' })).status, 200);
  const fourth = await nextRequest(); assert.deepEqual(imageParts(fourth), expected);
  answer(fourth, { text: 'Original image retained.' });
  assert.equal((await idle()).residentPid, resident);
  // A decoder/context/transport failure must not poison later turns with an
  // unaccepted new image, or evict an earlier accepted observation.
  fixture(path.join(work, 'broken.png'), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const submitted = await request('/api/agent/send', { prompt: 'Inspect broken.png.' }); assert.equal(submitted.status, 200);
  const fifth = await nextRequest(); answer(fifth, { tools: [call(mode + '-broken', 'view_image', { path: 'broken.png' })] });
  const sixth = await nextRequest(); assert.equal(imageParts(sixth).length, 2);
  answer(sixth, { status: 400, error: 'Cannot decode the newly attached PNG; previous engine session preserved.' }); await idle();
  row.failedImageTask = (await request(`/api/task?id=${submitted.body.taskId}`)).body;
  assert.equal(row.failedImageTask.task.status, 'failed');
  assert.equal((await request('/api/agent/send', { prompt: 'Continue with only the earlier accepted image.' })).status, 200);
  const seventh = await nextRequest(); assert.deepEqual(imageParts(seventh), expected, 'An unaccepted image must not poison recovery or remove accepted images');
  assert.match(seventh.body.messages.find(m => m.tool_call_id === mode + '-broken')?.content || '', /not accepted|not confirmed/i);
  answer(seventh, { text: 'Recovered with the earlier image.' }); await idle();
  row.requests = [first.file, second.file, third.file, fourth.file, fifth.file, sixth.file, seventh.file];
  row.imageSHA256 = crypto.createHash('sha256').update(imageBytes).digest('hex');
  assert.equal(row.visionState.nativeVisionActive, true, 'Ready owned image tools must be visible to the UI');
  assert.match(row.visionGuidance, /`view_image`/, 'The model needs instructions for its admitted image tool');
  assert.doesNotMatch(row.visionGuidance, /text-only|unavailable/, 'The launch prompt contradicts the actual image tool');
}
console.log(`Evidence: ${run}`);
try {
  await until(async () => { try { return (await request('/api/status')).status === 200; } catch { return false; } }, 'host did not listen');
  assert.equal((await request('/api/webdir', { path: assets })).status, 200);
  await check('Chat owns the model separately from DStudio tool runtimes', async row => {
    row.start = await launch('server'); assert.equal(row.start.status, 200, JSON.stringify(row.start));
    row.state = await idle(); resident = row.state.residentPid; assert.ok(resident > 0);
  });
  await check('Agent reuses the resident model and actually reads/writes through structured tools', async row => {
    row.start = await launch('agent'); assert.equal(row.start.status, 200, JSON.stringify(row.start));
    row.state = await idle(); assert.equal(row.state.mode, 'agent');
    assert.equal(row.state.ds4dir, engine); assert.equal(row.state.modelFile, model);
    assert.equal(row.state.residentPid, resident); assert.equal(row.start.body.reused, true);
    assert.equal(row.state.agentDiskCheckpointsSupported, false);
    assert.equal((await request('/api/agent/send', { prompt: 'Read source.txt and write result.txt.' })).status, 200);
    const first = await nextRequest(); checkStructuredCatalog(first);
    answer(first, { tools: [call('read-1', 'read', { path: 'source.txt' })] });
    const second = await nextRequest();
    assert.ok(second.body.messages.some(m => m.role === 'tool' && m.tool_call_id === 'read-1' && m.content.includes('SOURCE_EVIDENCE')));
    answer(second, { tools: [call('write-1', 'write', { path: 'result.txt', content: 'VERIFIED é 🦊\n' })] });
    const third = await nextRequest(); assert.equal(fs.readFileSync(path.join(work, 'result.txt'), 'utf8'), 'VERIFIED é 🦊\n');
    assert.ok(third.body.messages.some(m => m.role === 'tool' && m.tool_call_id === 'write-1'));
    answer(third, { text: 'Completed with actual tools.' }); await idle();
    row.requests = [first.file, second.file, third.file];
  });
  await check('Agent sends immutable workspace image bytes to its owned vision model', row => imageWorkflow(row, 'agent'));
  await check('GSA/RSA reject incompatible context before native, automatic, graph or Goal admission', async row => {
    row.attempts = [];
    for (const displayPrompt of ['/gsa inspect source.txt', ' \t/RsA\ninspect source.txt']) {
      for (const orchestration of ['native', 'auto', 'task-graph', 'goal']) {
        const before = await admissionSnapshot();
        const reply = await request('/api/agent/send', { prompt: 'Inspect source.txt with the selected analysis mode.',
          displayPrompt, orchestration, goalObjective: 'Inspect source.txt', goalMaxTurns: 2 });
        row.attempts.push({ displayPrompt, orchestration, reply });
        assert.equal(reply.status, 409, JSON.stringify(reply));
        assert.equal(reply.body.code, 'unsupported_context'); assert.equal(reply.body.taskId, 0);
        assert.deepEqual(await admissionSnapshot(), before, 'Rejected admission changed tasks, graphs, model, tools or files');
      }
    }
    for (const goalObjective of ['/gsa inspect source.txt', '/rsa inspect source.txt']) {
      const before = await admissionSnapshot();
      const reply = await request('/api/agent/send', { prompt: 'Inspect source.txt.',
        displayPrompt: 'Inspect source.txt.', orchestration: 'goal', goalObjective, goalMaxTurns: 2 });
      row.attempts.push({ goalObjective, reply });
      assert.equal(reply.status, 409); assert.equal(reply.body.code, 'unsupported_context');
      assert.deepEqual(await admissionSnapshot(), before);
    }
  });
  await check('ordinary slash prefixes and quoted analysis names do not enable Max', async row => {
    row.requests = [];
    for (const displayPrompt of ['/', '/g', '/gs', '/gsa-keep', '/rsanything', 'Explain /gsa without running it']) {
      const reply = await request('/api/agent/send', { prompt: 'Reply without tools.', displayPrompt, orchestration: 'native' });
      assert.equal(reply.status, 200, JSON.stringify(reply));
      const r = await nextRequest(false); row.requests.push(r.file);
      answer(r, { text: 'Ordinary request completed.' });
      assert.equal((await idle()).config.think, 'off');
    }
  });
  await check('a separately created guided graph rejects incompatible context without consuming an attempt', async row => {
    const requestsBefore = fs.readdirSync(path.join(engine, 'requests')).sort();
    row.created = await request('/api/task-graph/create', { schemaVersion: 1, policy: 'agent.general.v1',
      mode: 'agent', executorMode: 'native', goal: 'Inspect source.txt', workspace: work,
      nodes: [{ id: 'inspect', kind: 'agent_turn', title: 'Inspect source', mutation: 'read_only',
        capabilities: ['filesystem.read'], idempotent: true, retry: { maxAttempts: 1, automatic: false },
        action: { name: 'agent.prompt', text: 'Read source.txt.', display: '/gsa inspect source.txt' } }] });
    assert.equal(row.created.status, 200, JSON.stringify(row.created));
    const id = row.created.body.graph.graphId;
    const before = await admissionSnapshot();
    row.start = await graphControl('start', id); assert.equal(row.start.status, 422, JSON.stringify(row.start));
    row.graph = await graphState(id);
    assert.equal(row.graph.state, 'ready'); assert.equal(row.graph.nodes[0].attemptsStarted, 0);
    assert.deepEqual(await admissionSnapshot(), before, 'Rejected graph start consumed an attempt or mutated state');
    const s = await idle(); assert.equal(s.config.think, 'off'); assert.equal(s.config.ctx, 8192);
    assert.equal(s.residentPid, resident);
    assert.deepEqual(fs.readdirSync(path.join(engine, 'requests')).sort(), requestsBefore);
  });
  await check('blocked launch preparation stays responsive and cancellation preserves the current Agent', async row => {
    fixture(path.join(engine, 'prepare-hold'), 'hold');
    const pending = launch('cowork');
    await until(() => fs.existsSync(path.join(engine, 'prepare-entered')), 'preparation did not reach its barrier');
    row.before = await state(); assert.equal(row.before.mode, 'agent'); assert.equal(row.before.residentPid, resident);
    assert.equal(row.before.nativeVisionActive, true, 'Preparing another mode cannot revoke the current image tools');
    row.cancel = await request('/api/start/cancel', { taskId: row.before.launchTaskId }, 1000);
    assert.equal(row.cancel.status, 200); row.start = await pending; assert.equal(row.start.status, 409);
    await until(async () => !(await state()).launchTaskId, 'canceled preparation did not release its owner');
    row.after = await idle(); assert.equal(row.after.mode, 'agent'); assert.equal(row.after.residentPid, resident);
    assert.equal(row.after.nativeVisionActive, true);
    fs.unlinkSync(path.join(engine, 'prepare-hold'));
  });
  await check('failed preparation preserves the working model and previous file effects', async row => {
    fixture(path.join(engine, 'prepare-fail'), 'fail'); row.start = await launch('cowork');
    assert.equal(row.start.status, 409); assert.equal((await idle()).mode, 'agent');
    assert.equal((await state()).residentPid, resident); assert.equal(fs.readFileSync(path.join(work, 'result.txt'), 'utf8'), 'VERIFIED é 🦊\n');
    fs.unlinkSync(path.join(engine, 'prepare-fail'));
  });
  await check('Cowork uses its native document tools without advertising arbitrary shell', async row => {
    row.start = await launch('cowork'); assert.equal(row.start.status, 200, JSON.stringify(row.start));
    row.state = await idle(); assert.equal(row.state.mode, 'cowork'); assert.equal(row.state.residentPid, resident);
    assert.equal((await request('/api/agent/send', { prompt: 'Create notes.txt in this folder.' })).status, 200);
    const first = await nextRequest(), names = first.body.tools.map(t => t.function.name);
    checkStructuredCatalog(first);
    assert(first.body.messages.find(m => m.role === 'system').content.includes(
      fs.readFileSync(path.join(root, 'extension/cowork/COWORK.md'), 'utf8')),
      'The complete Cowork workflow must reach the model unchanged');
    for (const name of ['excel', 'read_document', 'write_document', 'write_pdf', 'presentation'])
      assert.equal(names.filter(n => n === name).length, 1, 'Missing or duplicated Office schema: ' + name);
    assert.ok(names.includes('document_table')); assert.ok(!names.some(n => /^bash(?:_|$)/.test(n)));
    answer(first, { tools: [call('cowork-write', 'write', { path: 'notes.txt', content: 'Cowork verified\n' })] });
    const second = await nextRequest(); assert.equal(fs.readFileSync(path.join(work, 'notes.txt'), 'utf8'), 'Cowork verified\n');
    assert.ok(second.body.messages.some(m => m.role === 'tool' && m.tool_call_id === 'cowork-write'));
    answer(second, { text: 'Saved notes.txt.' }); await idle();
  });
  await check('Cowork sends immutable image observations without gaining arbitrary shell', row => imageWorkflow(row, 'cowork'));
  await check('interrupt closes the in-flight model request without unloading weights or replaying effects', async row => {
    await request('/api/agent/send', { prompt: 'Wait for the next instruction.' }); const pending = await nextRequest();
    row.stop = await request('/api/agent/interrupt', { reason: 'controlled stop' }, 1000); assert.equal(row.stop.status, 200);
    await until(() => fs.existsSync(`${pending.file}.closed`), 'model transport socket survived interruption');
    assert.equal(fs.readFileSync(`${pending.file}.closed`, 'utf8'), 'interrupted');
    row.after = await idle(); assert.equal(row.after.residentPid, resident);
    answer(pending, { tools: [call('late', 'write', { path: 'late.txt', content: 'MUST NOT RUN' })] });
    await request('/api/agent/send', { prompt: 'Reply after Stop.' });
    const next = await nextRequest(); answer(next, { text: 'Still usable.' }); await idle();
    assert.equal(fs.existsSync(path.join(work, 'late.txt')), false);
  });
  await check('returning to Chat stops only the lightweight frontend', async row => {
    row.start = await launch('server'); assert.equal(row.start.status, 200);
    row.state = await idle(); assert.equal(row.state.mode, 'server'); assert.equal(row.state.residentPid, resident);
    assert.equal(fs.readFileSync(path.join(engine, 'fixture-launches'), 'utf8'), `${resident}\n`);
  });
  await check('loss of the owned model invalidates its active tool frontend and pending turn', async row => {
    assert.equal((await launch('agent')).status, 200); await idle();
    row.turn = await request('/api/agent/send', { prompt: 'Do not complete without the selected model.' }); await nextRequest();
    process.kill(resident, 'SIGTERM');
    row.after = await until(async () => { const s = await state(); return !s.residentPid && !s.running ? s : false; }, 'model loss left a frontend alive');
    assert.equal(row.after.ready, false); assert.equal(fs.existsSync(path.join(work, 'late.txt')), false);
    assert.equal(row.after.nativeVisionActive, false, 'An installed projector cannot keep vision active after model loss');
  });
  await check('native Max is rejected below 96k and reaches the same 27B tool protocol at 96k', async row => {
    row.rejected = await launch('agent', { think: 'max' });
    assert.equal(row.rejected.body.code, 'unsupported_context');
    row.start = await launch('agent', { think: 'max', ctx: 98304 });
    assert.equal(row.start.status, 200, JSON.stringify(row.start));
    row.state = await idle(); assert.equal(row.state.config.ctx, 98304); assert.equal(row.state.config.think, 'max');
    resident = row.state.residentPid; count = 0;
    assert.equal((await request('/api/agent/send', { prompt: 'Use this model in Max.' })).status, 200);
    const r = await nextRequest(true); assert.equal(r.body.reasoning_effort, 'max');
    answer(r, { text: 'Native Max request received.' }); await idle();
    assert.equal((await request('/api/stop', {})).status, 200);
    await until(async () => !(await state()).running, 'Stop did not release both owned processes');
  });
  await check('GSA/RSA reach native Max through every supported Agent orchestration at 96k', async row => {
    row.attempts = [];
    for (const command of ['/gsa', '/rsa']) {
      for (const orchestration of ['native', 'auto', 'task-graph', 'goal']) {
        const start = await launch('agent', { ctx: 98304 }); assert.equal(start.status, 200, JSON.stringify(start));
        const s = await idle(); assert.equal(s.config.think, 'off');
        if (resident !== s.residentPid) { resident = s.residentPid; count = 0; }
        if (command === '/gsa' && orchestration === 'native') {
          const before = await admissionSnapshot();
          row.oversizedDisplay = await request('/api/agent/send', { prompt: 'Inspect source.txt.',
            displayPrompt: '/gsa ' + 'x'.repeat(16385), orchestration: 'goal', goalObjective: 'Inspect source.txt' });
          assert.equal(row.oversizedDisplay.status, 413);
          assert.deepEqual(await admissionSnapshot(), before, 'Oversized Goal display changed runtime or durable state');
        }
        const reply = await request('/api/agent/send', { prompt: 'Inspect source.txt and report the real result.',
          displayPrompt: `${command} inspect source.txt`, orchestration,
          goalObjective: 'Verify the workspace evidence', goalMaxTurns: 2 });
        assert.equal(reply.status, 200, JSON.stringify(reply));
        const first = await nextRequest(true); assert.equal(first.body.reasoning_effort, 'max');
        const goal = orchestration === 'goal';
        answer(first, { tools: [goal
          ? call('guided-verify', 'bash', { command: 'python3 -c "from pathlib import Path; assert Path(\'source.txt\').read_text() == \'SOURCE_EVIDENCE\'; print(\'VERIFIED_SOURCE\')"' })
          : call('guided-read', 'read', { path: 'source.txt' })] });
        const second = await nextRequest(true); assert.equal(second.body.reasoning_effort, 'max');
        assert.ok(second.body.messages.some(m => m.role === 'tool' &&
          m.content.includes(goal ? 'VERIFIED_SOURCE' : 'SOURCE_EVIDENCE')));
        answer(second, { text: `Verified with actual tools.\n${goal ? '[[DSTUDIO_GOAL_COMPLETE]]' : '[[DSTUDIO_CORRECTNESS_COMPLETE]]'}` });
        assert.equal((await idle()).config.think, 'max');
        if (reply.body.graphId) {
          await until(async () => (await graphState(reply.body.graphId)).state === 'succeeded', 'Guided graph did not complete');
        }
        row.attempts.push({ command, orchestration, reply, requests: [first.file, second.file] });
      }
    }
  });
  await check('a resumed guided Goal retains its Max request and rejects a replacement 8k runtime', async row => {
    row.start = await launch('agent', { ctx: 98304 }); assert.equal(row.start.status, 200);
    await idle();
    row.turn = await request('/api/agent/send', { prompt: 'Inspect source.txt, then ask for the missing direction.',
      displayPrompt: '/rsa inspect source.txt', orchestration: 'goal',
      goalObjective: 'Inspect the source and wait for direction', goalMaxTurns: 2 });
    assert.equal(row.turn.status, 200);
    const first = await nextRequest(true); answer(first, { text: 'Please provide the next step. [[DSTUDIO_GOAL_BLOCKED]]' });
    const id = row.turn.body.graphId;
    await until(async () => (await graphState(id)).state === 'needs_input', 'Goal did not await direction');
    row.replacement = await launch('agent', { ctx: 8192 }); assert.equal(row.replacement.status, 200);
    const s = await idle(); resident = s.residentPid; count = 0;
    assert.equal(s.config.think, 'off');
    const before = fs.readdirSync(path.join(engine, 'requests')).sort();
    const beforeResume = await admissionSnapshot();
    row.resume = await graphControl('resume', id); assert.equal(row.resume.status, 422, JSON.stringify(row.resume));
    row.graph = await graphState(id);
    assert.equal(row.graph.state, 'needs_input'); assert.equal(row.graph.nodes[0].attemptsStarted, 1);
    assert.deepEqual(await admissionSnapshot(), beforeResume, 'Rejected Goal resume consumed a turn or changed its journal');
    assert.deepEqual(fs.readdirSync(path.join(engine, 'requests')).sort(), before);
    assert.equal((await idle()).config.think, 'off');
    assert.equal(fs.readFileSync(path.join(work, 'result.txt'), 'utf8'), 'VERIFIED é 🦊\n');
    row.restored = await launch('agent', { ctx: 98304 }); assert.equal(row.restored.status, 200);
    resident = (await idle()).residentPid; count = 0;
    row.continued = await graphControl('resume', id); assert.equal(row.continued.status, 200);
    const resumed = await nextRequest(true); assert.equal(resumed.body.reasoning_effort, 'max');
    answer(resumed, { tools: [call('resumed-verify', 'bash', {
      command: 'python3 -c "from pathlib import Path; assert Path(\'source.txt\').read_text() == \'SOURCE_EVIDENCE\'; print(\'VERIFIED_SOURCE\')"' })] });
    const checked = await nextRequest(true);
    assert.ok(checked.body.messages.some(m => m.role === 'tool' && m.content.includes('VERIFIED_SOURCE')));
    answer(checked, { text: 'Source verified. [[DSTUDIO_GOAL_COMPLETE]]' });
    row.finishedGraph = await until(async () => {
      const g = await graphState(id); return g.state === 'succeeded' ? g : false;
    }, 'Compatible Goal resume did not complete');
    assert.equal(row.finishedGraph.nodes[0].attemptsStarted, 2);
    assert.equal((await request('/api/stop', {})).status, 200);
    await until(async () => !(await state()).running, 'Stop did not release both owned processes');
  });
  if (withBrowser) {
    const { q36AttachmentBrowser } = await import('../browser/q36_attachments_browser_test.mjs');
    for (const mode of ['chat', 'cowork']) await check(`Real browser uploads and sends 27B ${mode} image through the native host`, async row => {
      row.start = await launch('server'); assert.equal(row.start.status, 200);
      row.ready = await idle();
      if (row.ready.residentPid !== resident) { resident = row.ready.residentPid; count = 0; }
      await q36AttachmentBrowser({row, mode, base, work, engine, model, run,
        nextRequest, answer, call, state, idle, resident});
    });
    assert.equal((await request('/api/stop', {})).status, 200);
    await until(async () => !(await state()).running, 'Browser test Stop did not release owned processes');
  }
  await check('native build and test preserve the supplied source checkout', async row => {
    for (const f of report.sourceFiles) assert.equal(hash(path.join(source, f.name)), f.sha256, f.name);
    row.agentSHA256 = hash(path.join(main, 'ds4-agent-jsonl'));
    row.coworkSHA256 = hash(path.join(main, 'ds4-cowork'));
    row.processes = spawnSync('/bin/ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' }).stdout.split('\n').filter(s => s.includes(install));
    assert.equal(row.processes.length, 1, 'Only the still-running test host should remain before cleanup');
  });
  report.passed = report.cases.length === report.plannedChecks && report.cases.every(c => c.passed);
} catch (error) { report.error = error.stack; process.exitCode = 1; }
finally {
  if (host.exitCode === null && host.signalCode === null) {
    try { await request('/api/stop', {}); } catch {}
    host.kill('SIGTERM'); await Promise.race([terminal, sleep(5000)]);
    if (host.exitCode === null && host.signalCode === null) host.kill('SIGKILL');
  }
  report.hostExit = await terminal; report.finished = new Date().toISOString(); save();
  console.log(`${report.passed ? 'PASS' : 'FAIL'} ${report.cases.filter(c => c.passed).length}/${report.plannedChecks}: ${run}`);
  if (report.error) console.error(report.error);
}

// The app is force-quit (SIGKILL to the host alone, as macOS Force Quit does)
// while a model is loaded and a Chat turn is streaming; the next launch must
// find no leftover engine in its way and the saved conversation intact.
//
// Real: the host binary over HTTP, its launch worker, the --resident-guard
// child that owns the model server, the /v1 relay, the conversation store and
// its file in a task-owned profile. SCRIPTED: the loaded model is
// tests/support/fake_llama_server.mjs standing in for the bundled llama-server
// (Qwen3.6 on llama.cpp); the llama.cpp installer is a stub that builds
// nothing. SIMULATED: the conversation the page would have saved is written
// through the same /api/store protocol the page uses. No weights, no inference.
// The ds4-server (DeepSeek/GLM) path is not exercised here.
//   node tests/integration/force_quit_relaunch_test.mjs [tests/.build/dstudio-server-test]
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import {spawn, execFileSync} from 'node:child_process';
import {artifactRunDir, csrfHeaders, freePort, sleep} from '../support/real_harness.mjs';

const repo = path.resolve(import.meta.dirname, '../..');
const binary = path.resolve(process.argv[2] || 'tests/.build/dstudio-server-test');
const run = artifactRunDir('force-quit-relaunch');
const MODEL = 'gguf/Qwen3.6-35B-A3B-UD-Q6_K_XL.gguf', ALIAS = 'qwen3.6-35b-a3b';
const report = {schema: 'dstudio.force-quit-relaunch.v1', started: new Date().toISOString(),
  scope: 'Real host, launch worker, resident guard, /v1 relay and store; SCRIPTED llama-server stand-in for the loaded model; no weights or inference',
  binarySHA256: crypto.createHash('sha256').update(fs.readFileSync(binary)).digest('hex'), cases: []};

function fixture(file, contents, mode) {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, contents);
  if (mode) fs.chmodSync(file, mode);
}
// One isolated installation: <root>/ds4 holds the model file, <root>/llama.cpp
// the scripted server and an installer receipt, <base>/assets the support tree.
const base = path.join(run, 'install with spaces'), root = path.join(base, 'root');
const site = {engine: path.join(root, 'ds4'), install: path.join(root, 'llama.cpp'), assets: path.join(base, 'assets'),
  kv: path.join(base, 'kv'), control: path.join(base, 'scripted-server'), profile: path.join(base, 'profile')};
for (const dir of [site.engine, site.control, site.profile]) fs.mkdirSync(dir, {recursive: true});
fixture(path.join(site.engine, 'Makefile'), 'all:\n\t@false\n');
fixture(path.join(site.engine, MODEL), 'fixture only, not model weights\n');
fixture(path.join(site.install, 'bin/llama-server'),
  `#!/bin/sh\nexec "${process.execPath}" "${path.join(repo, 'tests/support/fake_llama_server.mjs')}" "$@"\n`, 0o755);
fixture(path.join(site.install, '.dstudio-llama.json'), JSON.stringify({schema: 'dstudio.llama-install.v1', engine: 'llama',
  commit: 'f5027fb21307eb264aed483242603d68c87b0fe3', buildNumber: '11836', buildId: 'a'.repeat(64),
  binary: 'bin/llama-server', binarySHA256: 'c'.repeat(64)}) + '\n');
fixture(path.join(site.assets, 'scripts/install-llama.py'), 'import sys\nprint("fixture installer: nothing built")\nsys.exit(0)\n');
for (const script of ['scripts/apply-ds4-glm53-m2max.sh', 'scripts/apply-ds4-vision-streaming.sh', 'scripts/apply-ds4-v41-vision-pairing.sh',
  'scripts/apply-ds4-laguna-prefill-chunk.sh', 'scripts/apply-ds4-visible-downloads.sh', 'src/harness/design/build-design.sh'])
  fixture(path.join(site.assets, script), '#!/bin/sh\nexit 0\n', 0o755);
const config = value => fs.writeFileSync(path.join(site.control, 'config.json'), JSON.stringify(value));
const serverEvents = () => {
  try {return fs.readFileSync(path.join(site.control, 'server-events.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));}
  catch {return [];}
};
config({});

const alive = pid => {try {process.kill(pid, 0); return true;} catch (error) {return error.code === 'EPERM';}};
const groupMembers = pgid => execFileSync('ps', ['-A', '-o', 'pid=,pgid=,stat='], {encoding: 'utf8'}).split('\n')
  .map(line => line.trim().split(/\s+/)).filter(p => p[1] === String(pgid) && !(p[2] || '').startsWith('Z')).map(p => Number(p[0]));
const pgidOf = pid => Number(execFileSync('ps', ['-o', 'pgid=', '-p', String(pid)], {encoding: 'utf8'}).trim());
const portOpen = port => new Promise(resolve => {
  const socket = net.connect({host: '127.0.0.1', port}, () => {socket.destroy(); resolve(true);});
  socket.on('error', () => resolve(false));
});

let hostCount = 0;
async function startHost(port, enginePort) {
  const log = fs.openSync(path.join(run, `host-${++hostCount}.log`), 'wx');
  const child = spawn(binary, [String(port), site.engine], {cwd: repo, detached: true, stdio: ['ignore', log, log],
    env: {...process.env, DS4UI_DATA_DIR: site.profile, DS4UI_NO_WINDOW: '1', DS4UI_TEST_MODE: '1', DS4UI_DEFER_ENGINE_START: '1',
      DS4UI_HOST: '127.0.0.1', DSTUDIO_KV_DIR: site.kv, KVFAKE_DIR: site.control}});
  fs.closeSync(log);
  const exited = new Promise(resolve => {child.once('exit', resolve); child.once('error', resolve);});
  const h = {child, exited, url: `http://127.0.0.1:${port}`, enginePort};
  h.request = async (endpoint, body, timeout = 5000, headers = {}) => {
    const res = await fetch(h.url + endpoint, {method: body === undefined ? 'GET' : 'POST', headers: {...csrfHeaders, ...headers},
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body), signal: AbortSignal.timeout(timeout)});
    return {status: res.status, body: await res.json()};
  };
  h.status = async () => (await h.request('/api/status', undefined, 2000)).body;
  h.until = async (check, message, ms = 15000) => {
    const deadline = Date.now() + ms;
    for (;;) {
      const value = await check();
      if (value) return value;
      if (Date.now() > deadline) throw new Error('timed out: ' + message);
      await sleep(25);
    }
  };
  await h.until(async () => {try {return (await h.request('/api/status')).status === 200;} catch {return false;}}, 'the host did not listen');
  assert.equal((await h.request('/api/webdir', {path: site.assets})).status, 200);
  h.start = async () => {
    const started = await h.request('/api/start', {mode: 'server', modelBackend: 'local', gguf: MODEL,
      port: enginePort, ctx: 16384, power: 100, think: 'off'}, 30000);
    assert.equal(started.status, 200, JSON.stringify(started.body));
    const st = await h.until(async () => {const s = await h.status(); return s.ready && s.running && s.residentPid > 0 ? s : null;}, 'the engine did not become ready');
    const server = await h.until(() => serverEvents().filter(e => e.type === 'start' && e.args.includes(String(enginePort))).at(-1), 'the scripted server did not start');
    return {status: st, serverPid: server.pid};
  };
  h.close = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    try {process.kill(-child.pid, 'SIGTERM');} catch {}
    await Promise.race([exited, sleep(6000)]);
    if (child.exitCode === null && child.signalCode === null) {try {process.kill(-child.pid, 'SIGKILL');} catch {} await exited;}
  };
  return h;
}

// What the page sends to the host's /v1 relay, and what it saves while streaming.
function chatRequest(h, messages) {
  return fetch(h.url + '/v1/chat/completions', {method: 'POST', headers: {'Content-Type': 'application/json', Accept: 'text/event-stream'},
    body: JSON.stringify({model: ALIAS, messages, stream: true, stream_options: {include_usage: true}})});
}
async function readStream(response, until = () => false) {
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let text = '', content = '';
  try {
    for (;;) {
      const {value, done} = await reader.read();
      if (done) break;
      text += decoder.decode(value, {stream: true});
      content = text.split('\n').filter(l => l.startsWith('data: {')).map(l => JSON.parse(l.slice(6)).choices?.[0]?.delta?.content || '').join('');
      if (until(content)) return {text, content, reader, done: false};
    }
  } catch (error) {return {text, content, error: String(error), done: true};}
  return {text, content, done: true};
}
const conversation = (messages, now) => ({v: 2, deleted: [], clearedAt: 0, chats: [{id: 'force-quit-chat', mode: 'chat',
  title: 'Harbour survey', model: ALIAS, createdAt: now, updatedAt: now, messages}]});

async function check(name, fn) {
  const row = {name};
  try {await fn(row); row.status = 'PASS';}
  catch (error) {row.status = 'FAIL'; row.error = String(error.stack || error); process.exitCode = 1;}
  report.cases.push(row);
  console.log(`${row.status} ${name}${row.error ? `\n${row.error}` : ''}`);
  fs.writeFileSync(path.join(run, 'results.json'), JSON.stringify(report, null, 2));
  return row.status === 'PASS';
}

const hostPort = await freePort(), enginePort = await freePort();
let first = null, second = null;
const saved = {};
try {
  first = await startHost(hostPort, enginePort);
  const now = Date.now();
  const user = {id: 'u1', role: 'user', content: 'List the two steps of the harbour survey.', createdAt: now};

  await check('a model is loaded and a turn is streaming, its partial answer saved, when the app is force-quit', async row => {
    const loaded = await first.start();
    row.loaded = {residentPid: loaded.status.residentPid, serverPid: loaded.serverPid, modelFile: loaded.status.modelFile};
    assert.equal(loaded.status.modelFile, MODEL);
    first.guardPid = loaded.status.residentPid; first.serverPid = loaded.serverPid;
    // The page saves the user turn and an empty streaming placeholder first.
    const placeholder = {id: 'a1', role: 'assistant', content: '', reasoning: '', streaming: true, createdAt: now};
    const opened = await first.request('/api/store', JSON.stringify(conversation([user, placeholder], now)));
    assert.equal(opened.status, 200); assert.equal(opened.body.durable, true);
    config({block: ['completion'], reply: 'First survey the breakwater, then sound the inner basin.'});
    const response = await chatRequest(first, [{role: 'user', content: user.content}]);
    assert.equal(response.status, 200);
    const partial = await readStream(response, content => content.length > 0);
    assert.equal(partial.done, false, 'the turn is still running');
    row.partial = partial.content;
    assert.equal(partial.content, 'First ');
    first.stream = partial;
    // ...and every streamed chunk, as the page does while the turn runs.
    const streamingBlob = JSON.stringify(conversation([user, {...placeholder, content: partial.content}], now + 1));
    const during = await first.request('/api/store', streamingBlob, 5000, {'X-DStudio-Store-Revision': String(opened.body.rev)});
    assert.equal(during.status, 200, JSON.stringify(during.body)); assert.equal(during.body.durable, true);
    saved.blob = JSON.parse(streamingBlob); saved.rev = during.body.rev;
    saved.file = fs.readFileSync(path.join(site.profile, 'ds4web-store.json'), 'utf8');
    first.hostGroup = first.child.pid; first.guardGroup = pgidOf(first.guardPid);
    row.groups = {host: groupMembers(first.hostGroup), guard: groupMembers(first.guardGroup)};
    assert.ok(row.groups.guard.includes(first.serverPid), 'the model server runs in the guard\'s process group');
    // Force Quit: SIGKILL to the app process only. Nothing closes or signals its children.
    process.kill(first.child.pid, 'SIGKILL');
    await first.exited;
    assert.equal(first.child.signalCode, 'SIGKILL');
  });

  await check('the loaded model and every helper of the killed app stop by themselves; the engine port is released', async row => {
    const killed = Date.now();
    await first.until(async () => !alive(first.serverPid) && !alive(first.guardPid) &&
      groupMembers(first.guardGroup).length === 0 && groupMembers(first.hostGroup).length === 0,
    `leftover processes: guard group ${groupMembers(first.guardGroup)}, host group ${groupMembers(first.hostGroup)}`, 8000);
    row.goneAfterMs = Date.now() - killed;
    assert.equal(await portOpen(enginePort), false, 'nothing listens on the engine port');
    const terms = serverEvents().filter(e => e.pid === first.serverPid && e.type === 'term');
    assert.equal(terms.length, 1, 'the server was asked to stop (SIGTERM by its guard), not left running');
    const rest = await readStream({body: {getReader: () => first.stream.reader}});
    row.clientSaw = rest.error || (rest.done ? 'end of stream' : 'open');
    assert.ok(rest.done, 'the interrupted turn\'s stream ended instead of hanging');
    assert.ok(!(first.stream.text + rest.text).includes('[DONE]'), 'an interrupted turn is never reported complete');
  });

  await check('the relaunched app starts clean and finds the conversation exactly as saved', async row => {
    second = await startHost(hostPort, enginePort);
    const st = await second.status();
    row.status = {running: st.running, ready: st.ready, residentPid: st.residentPid, launchPhase: st.launchPhase, engineError: st.engineError};
    assert.equal(st.running, false); assert.equal(st.ready, false); assert.equal(st.residentPid, 0);
    assert.equal(st.launchPhase, '', 'no launch is claimed to be in progress');
    assert.equal(fs.readFileSync(path.join(site.profile, 'ds4web-store.json'), 'utf8'), saved.file, 'the store file is byte-identical');
    const store = await second.request('/api/store');
    assert.equal(store.status, 200);
    // The revision is a per-process counter (the page re-reads it before writing).
    assert.equal(typeof store.body.rev, 'number');
    assert.deepEqual(store.body.data, saved.blob, 'the user turn and the partial answer saved during the turn are intact');
  });

  await check('the same model starts again on the same port and the conversation continues', async row => {
    config({});
    const loaded = await second.start();
    row.serverPid = loaded.serverPid;
    assert.notEqual(loaded.serverPid, first.serverPid);
    assert.equal(loaded.status.modelFile, MODEL);
    const history = [{role: 'user', content: user.content}, {role: 'assistant', content: saved.blob.chats[0].messages[1].content},
      {role: 'user', content: 'Please finish the list.'}];
    const response = await chatRequest(second, history);
    assert.equal(response.status, 200);
    const done = await readStream(response);
    row.reply = done.content;
    assert.ok(done.done && done.text.includes('data: [DONE]'), 'the new turn completes');
    assert.match(done.content, /^Reply \d+ to Please finish the list\./, 'the scripted server answered the new turn');
    const received = serverEvents().filter(e => e.pid === loaded.serverPid && e.type === 'completion_received').at(-1);
    assert.equal(received.messages, 3, 'the saved history was sent with the new message');
    const rev = (await second.request('/api/store')).body.rev;
    const appended = conversation([user, {...saved.blob.chats[0].messages[1], streaming: false},
      {id: 'u2', role: 'user', content: 'Please finish the list.', createdAt: now + 2},
      {id: 'a2', role: 'assistant', content: done.content, createdAt: now + 3}], now + 3);
    const put = await second.request('/api/store', JSON.stringify(appended), 5000, {'X-DStudio-Store-Revision': String(rev)});
    assert.equal(put.status, 200); assert.equal(put.body.durable, true);
    assert.equal((await second.request('/api/stop', {})).status, 200);
    await second.until(async () => {const s = await second.status(); return !s.running && !s.residentPid;}, 'the engine did not stop');
  });
} catch (error) {
  report.cases.push({name: 'test infrastructure', status: 'FAIL', error: String(error.stack || error)});
  console.log(`FAIL test infrastructure\n${error.stack || error}`);
  process.exitCode = 1;
} finally {
  for (const h of [first, second]) if (h) await h.close();
  // Only processes this run started: the scripted servers recorded their PIDs.
  for (const event of serverEvents().filter(e => e.type === 'start')) if (alive(event.pid)) {try {process.kill(event.pid, 'SIGKILL');} catch {}}
  report.finished = new Date().toISOString();
  report.status = report.cases.length === 4 && report.cases.every(c => c.status === 'PASS') ? 'PASS' : 'FAIL';
  fs.writeFileSync(path.join(run, 'results.json'), JSON.stringify(report, null, 2));
  console.log(`force_quit_relaunch_test: ${report.cases.filter(c => c.status === 'PASS').length}/4 passed; receipts: ${run}`);
  if (report.status !== 'PASS') process.exitCode = 1;
}

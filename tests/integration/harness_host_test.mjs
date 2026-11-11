// pi as the Agent runtime through the REAL native host (test mode) and the
// REAL DStudio bridge (src/harness/bridge/dstudio-harness.mjs), copied by the
// host's own launch preparation. pi itself is SIMULATED: a task-owned fake
// speaks pi's RPC JSONL and its replies are authored by this test; its
// installation receipt is checked by the production scripts/install-harness.py.
// The model is a remote-endpoint fixture that no turn here contacts, and the
// Design runtime is a task-owned fixture executable. No weights, engine or
// inference.
//   node tests/integration/harness_host_test.mjs [dstudio-server-test]
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { artifactRunDir, csrfHeaders, freePort, sleep, writeArtifact } from '../support/real_harness.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const binary = path.resolve(process.argv[2] || 'tests/.build/dstudio-server-test');
assert.ok(fs.existsSync(binary), `${binary} is required (make tests/.build/dstudio-server-test); missing is not a pass`);
const run = artifactRunDir('harness-host');
const engine = path.join(run, 'engine'), harnessRoot = path.join(run, 'harness');
const workspace = path.join(run, 'workspace'), assets = path.join(run, 'design-assets');
for (const dir of [engine, workspace, assets]) fs.mkdirSync(dir);
const receipt = { scope: 'Real host, launch preparation and bridge; SIMULATED pi replies, remote-model fixture and Design fixture; no inference',
  cases: [] };
const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const processExists = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { if (e.code === 'ESRCH') return false; throw e; } };

// The remote model endpoint the launch names. The fake pi never asks it for
// a completion; a request reaching it would be a test defect.
const modelRequests = [];
const model = http.createServer((req, res) => { modelRequests.push(req.url); res.writeHead(503).end(); });
model.listen(0, '127.0.0.1'); await once(model, 'listening');
const remote = { modelBackend: 'remote', remoteBaseUrl: `http://127.0.0.1:${model.address().port}`, remoteModel: 'fixture-no-inference' };

// ---------- simulated pi (RPC mode) ----------
const FAKE_PI = `
const fs = require('fs'), path = require('path');
const log = (name, text) => fs.appendFileSync(path.join(process.env.PI_CODING_AGENT_DIR, name), text);
log('pids', process.pid + '\\n');
const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const say = (text) => send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: text } });
let buf = '';
process.stdin.on('data', (d) => {
  buf += d;
  for (let at; (at = buf.indexOf('\\n')) >= 0;) {
    const c = JSON.parse(buf.slice(0, at)); buf = buf.slice(at + 1);
    if (c.type !== 'prompt') { send({ id: c.id, type: 'response', command: c.type, success: true, data: {} }); continue; }
    send({ id: c.id, type: 'response', command: 'prompt', success: true });
    log('prompts.jsonl', JSON.stringify(c.message) + '\\n');
    if (c.message.includes('CRASH')) {
      say('Partial answer before the crash.\\n');
      // pi dies in the middle of its turn, after streaming part of it.
      process.stdout.write('', () => process.exit(9));
      return;
    }
    if (c.message.includes('HANG')) { say('Working on it...\\n'); continue; }
    if (c.message.includes('PLAN MODE')) {
      say('<question-form title="Plan setup">\\n{"id":"plan-setup","questions":[{"id":"scope","label":"Which part of the importer comes first?","type":"radio","options":[{"value":"parser","label":"Parser","description":"Parse CSV rows first."},{"value":"review","label":"Review UI","description":"Build the review screen first."}]}]}\\n</question-form>');
      send({ type: 'agent_settled' });
      continue;
    }
    say('Answer to: ' + c.message.split('\\n')[0] + '\\n');
    send({ type: 'agent_settled' });
  }
});
`;
const PI_CLI = path.join(harnessRoot, 'pi/packages/coding-agent/dist/bundle/cli.js');
function installFakePi() {
  // The receipt install-harness.py writes, for the bundled pins and patches;
  // its --status check (run by the host's launch preparation) must accept it.
  const pins = JSON.parse(fs.readFileSync(path.join(root, 'src/harness/manifest.json'))).engines;
  fs.mkdirSync(path.dirname(PI_CLI), { recursive: true });
  fs.writeFileSync(PI_CLI, FAKE_PI);
  fs.writeFileSync(path.join(path.dirname(PI_CLI), 'package.json'), '{"type":"commonjs"}');
  const write = (name, entry, patches) => fs.writeFileSync(path.join(harnessRoot, name, '.dstudio-harness.json'), JSON.stringify({
    schema: 'dstudio.harness-install.v1', harness: name, commit: pins[name].commit, patches, entry: path.relative(path.join(harnessRoot, name), entry),
    entrySHA256: sha256(entry), version: 'fixture' }));
  write('pi', PI_CLI, []);
  const ds4Entry = path.join(harnessRoot, 'pi-ds4/index.ts');
  fs.mkdirSync(path.dirname(ds4Entry), { recursive: true });
  fs.writeFileSync(ds4Entry, '// fixture: pi-ds4 is not used with a remote model\n');
  const patch = 'patch/harness-pi-ds4/external-server.patch';
  write('pi-ds4', ds4Entry, [{ patch, sha256: sha256(path.join(root, patch)) }]);
}
const piState = path.join(harnessRoot, 'state/pi/pi');
const piPids = () => fs.existsSync(path.join(piState, 'pids')) ? fs.readFileSync(path.join(piState, 'pids'), 'utf8').trim().split('\n').map(Number) : [];

// ---------- simulated OpenCode (`opencode serve`: HTTP + SSE events) ----------
const FAKE_OPENCODE = `#!/usr/bin/env node
const http = require('http'), fs = require('fs'), path = require('path');
fs.appendFileSync(path.join(process.env.XDG_STATE_HOME, 'pids'), process.pid + '\\n');
const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
const auth = 'Basic ' + Buffer.from('opencode:' + process.env.OPENCODE_SERVER_PASSWORD).toString('base64');
const streams = [];
const emit = (e) => streams.forEach((s) => s.write('data: ' + JSON.stringify(e) + '\\n\\n'));
const P = (type, properties) => emit({ type, properties: { sessionID: 'S1', ...properties } });
http.createServer((req, res) => {
  if (req.headers.authorization !== auth) { res.writeHead(401).end(); return; }
  const url = req.url.split('?')[0];
  if (url === '/config') { res.writeHead(200).end('{}'); return; }
  if (url === '/event') { res.writeHead(200, { 'content-type': 'text/event-stream' }); streams.push(res); return; }
  if (url === '/session' && req.method === 'POST') { res.writeHead(200).end('{"id":"S1"}'); return; }
  if (url === '/session/S1/prompt_async') {
    let body = ''; req.on('data', (d) => { body += d; });
    req.on('end', () => {
      res.writeHead(204).end();
      const text = JSON.parse(body).parts[0].text;
      const id = 'm' + Date.now();
      P('message.updated', { info: { id, role: 'assistant' } });
      P('message.part.updated', { part: { id: 'p-' + id, messageID: id, type: 'text', text: '' } });
      if (text.includes('CRASH')) {
        P('message.part.delta', { messageID: id, partID: 'p-' + id, field: 'text', delta: 'Partial OpenCode answer.\\n' });
        setTimeout(() => process.exit(9), 100); // dies in the middle of its turn
        return;
      }
      P('message.part.delta', { messageID: id, partID: 'p-' + id, field: 'text', delta: 'OpenCode answer to: ' + text + '\\n' });
      P('session.idle', {});
    });
    return;
  }
  res.writeHead(404).end();
}).listen(port, '127.0.0.1');
`;
function installFakeOpencode() {
  const pins = JSON.parse(fs.readFileSync(path.join(root, 'src/harness/manifest.json'))).engines;
  const entry = path.join(harnessRoot, 'opencode/bin/opencode');
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  fs.writeFileSync(entry, FAKE_OPENCODE, { mode: 0o755 });
  fs.writeFileSync(path.join(path.dirname(entry), 'package.json'), '{"type":"commonjs"}');
  const patches = ['patch/harness-opencode/directory-confinement.patch', 'patch/harness-opencode/workspace-root.patch']
    .map((patch) => ({ patch, sha256: sha256(path.join(root, patch)) }));
  fs.writeFileSync(path.join(harnessRoot, 'opencode/.dstudio-harness.json'), JSON.stringify({ schema: 'dstudio.harness-install.v1',
    harness: 'opencode', commit: pins.opencode.commit, patches, entry: 'bin/opencode', entrySHA256: sha256(entry), version: 'fixture' }));
}
const opencodeState = path.join(harnessRoot, 'state/opencode/opencode/state');
const opencodePids = () => fs.existsSync(path.join(opencodeState, 'pids')) ? fs.readFileSync(path.join(opencodeState, 'pids'), 'utf8').trim().split('\n').map(Number) : [];

// ---------- the real host ----------
const port = await freePort(), base = `http://127.0.0.1:${port}`;
const log = fs.openSync(path.join(run, 'host.log'), 'w');
const host = spawn(binary, [String(port), engine], { cwd: root, detached: true, stdio: ['ignore', log, log],
  env: { ...process.env, HOME: path.join(run, 'home'), DS4UI_DATA_DIR: path.join(run, 'data'), DS4UI_TEST_MODE: '1',
    DS4UI_NO_WINDOW: '1', DS4UI_DEFER_ENGINE_START: '1', DS4UI_HOST: '127.0.0.1' } });
fs.closeSync(log);
const hostExited = once(host, 'exit');
async function request(endpoint, body, timeout = 5000) {
  const res = await fetch(base + endpoint, { method: body === undefined ? 'GET' : 'POST', headers: csrfHeaders,
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeout) });
  return { status: res.status, body: await res.json() };
}
const status = async () => (await request('/api/status')).body;
const task = async (id) => (await request(`/api/task?id=${id}`)).body.task;
async function until(check, message, timeout = 15000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    assert.equal(host.exitCode, null, 'the native host exited');
    if (Date.now() > deadline) throw new Error(message);
    await sleep(50);
  }
}
async function transcript() {
  const poll = (await request('/api/agent/poll?since=0')).body;
  return poll.text || '';
}
async function startAgent(extra = {}) {
  const started = await request('/api/start', { mode: 'agent', harness: 'pi', workdir: workspace, ...remote, ...extra }, 60000);
  return started;
}
async function stopRuntime() {
  if (!(await status()).running) return;
  await request('/api/stop', {});
  await until(async () => !(await status()).running, 'the runtime did not stop');
}
async function check(name, fn) {
  const row = { name };
  try { await fn(row); row.status = 'PASS'; }
  catch (error) { row.status = 'FAIL'; row.error = String(error.stack || error); process.exitCode = 1; }
  receipt.cases.push(row);
  console.log(`${row.status} ${name}${row.error ? `\n${row.error}` : ''}`);
}

try {
  await until(async () => { try { return (await request('/api/status', undefined, 1000)).status === 200; } catch { return false; } }, 'host did not listen');

  await check('a selected harness that is not installed fails the start with a clear message and runs nothing', async (row) => {
    for (const name of ['pi', 'opencode']) {
      const before = await status();
      const started = Date.now();
      const response = await startAgent({ harness: name });
      row[name] = { status: response.status, body: response.body, ms: Date.now() - started };
      assert.equal(response.status, 409, JSON.stringify(response.body));
      assert.equal(response.body.ok, false);
      assert.match(response.body.error, new RegExp(`The ${name} harness is not installed or no longer matches DStudio; install it in Settings > Harnesses`));
      const after = await status();
      assert.equal(after.running, false, 'nothing else was started in its place');
      assert.equal(after.mode, before.mode);
      assert.equal((await task(response.body.taskId)).status, 'failed');
    }
    assert.ok(!fs.existsSync(path.join(harnessRoot, 'state')), 'no harness process ever started');
  });

  installFakePi();
  await check('pi crashing mid-turn fails that turn, keeps its partial answer and leaves an Agent that can be started again', async (row) => {
    const started = await startAgent();
    assert.equal(started.status, 200, JSON.stringify(started.body));
    await until(async () => { const s = await status(); return s.ready && s.mode === 'agent'; }, 'the pi Agent did not become ready');
    const piPid = piPids()[0];
    assert.ok(piPid > 0 && processExists(piPid), 'the simulated pi runs under the bridge');

    const sent = await request('/api/agent/send', { prompt: 'Summarise the README. CRASH', displayPrompt: 'Summarise the README.', orchestration: 'native' });
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    await until(async () => (await task(sent.body.taskId)).status !== 'working', 'the crashed turn never ended', 10000);
    row.turn = await task(sent.body.taskId);
    row.bridgePid = row.turn.pid;
    assert.equal(row.turn.status, 'failed', 'the turn is reported as failed');
    const text = await transcript();
    row.transcript = text.slice(-2000);
    assert.match(text, /Partial answer before the crash\./, 'the transcript so far is kept');
    assert.match(text, /"type":"runtime_notice","text":"pi exited \(9\)"/, 'the failure says pi exited');
    assert.ok(!processExists(piPid));

    // The bridge cannot run another turn without pi: it ends, so the host
    // reports the Agent as stopped instead of accepting a prompt that never completes.
    await until(async () => !(await status()).running, 'the bridge kept running without pi', 10000);
    row.afterCrash = await status();
    assert.match(row.afterCrash.engineError || '', /engine exited \(code 1\)/);
    assert.ok(row.bridgePid > 0 && !processExists(row.bridgePid), 'the bridge process is gone');
    const refused = await request('/api/agent/send', { prompt: 'Are you there?', orchestration: 'native' });
    assert.equal(refused.status, 409, 'a prompt is refused, not left hanging');

    const restarted = await startAgent();
    assert.equal(restarted.status, 200, JSON.stringify(restarted.body));
    await until(async () => { const s = await status(); return s.ready && s.mode === 'agent'; }, 'pi did not start again');
    const next = await request('/api/agent/send', { prompt: 'Say hello', orchestration: 'native' });
    assert.equal(next.status, 200);
    await until(async () => (await task(next.body.taskId)).status === 'completed', 'the restarted Agent did not complete a turn');
    assert.match(await transcript(), /Answer to: Say hello/);
    assert.equal(modelRequests.length, 0);
  });

  await check('the Agent runtime killed mid-turn is reported, its transcript is kept and Agent starts again', async (row) => {
    const sent = await request('/api/agent/send', { prompt: 'Refactor the parser. HANG', displayPrompt: 'Refactor the parser.', orchestration: 'native' });
    assert.equal(sent.status, 200);
    await until(async () => /Working on it\.\.\./.test(await transcript()), 'the turn did not stream');
    const pid = row.pid = (await task(sent.body.taskId)).pid;
    assert.ok(pid > 0);
    process.kill(pid, 'SIGKILL'); // the task-owned bridge process of this turn
    await until(async () => !(await status()).running, 'the host did not notice the dead runtime');
    row.turn = await task(sent.body.taskId);
    assert.equal(row.turn.status, 'incomplete');
    assert.match(row.turn.error || '', /engine process stopped before completing the turn/);
    const text = await transcript();
    assert.match(text, /Working on it\.\.\./, 'the partial answer is kept');
    assert.match(text, /Engine process stopped before completing the turn: engine stopped \(signal 9\)/);
    await until(() => piPids().every((p) => !processExists(p)), 'pi outlived its bridge');
    const restarted = await startAgent();
    assert.equal(restarted.status, 200);
    await until(async () => { const s = await status(); return s.ready && s.mode === 'agent'; }, 'Agent did not start again');
    const next = await request('/api/agent/send', { prompt: 'Continue', orchestration: 'native' });
    await until(async () => (await task(next.body.taskId)).status === 'completed', 'no turn after the restart');
    assert.match(await transcript(), /Answer to: Continue/);
  });

  await check('GSA and RSA are refused explicitly while pi is the Agent runtime; Plan prompts reach pi intact', async (row) => {
    const plan = 'Plan the CSV importer.\n\nPLAN MODE — create a Markdown planning file for the request above.\nAsk with one <question-form> block first.';
    const sent = await request('/api/agent/send', { prompt: plan, displayPrompt: 'Plan the CSV importer.', orchestration: 'native' });
    assert.equal(sent.status, 200, 'Plan mode is a prompt contract the harness receives like any turn');
    await until(async () => (await task(sent.body.taskId)).status === 'completed', 'the Plan turn did not complete');
    const prompts = fs.readFileSync(path.join(piState, 'prompts.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(prompts.at(-1), plan, 'pi receives the whole multi-line Plan contract');
    assert.match(await transcript(), /<question-form title="Plan setup">[\s\S]*"id":"plan-setup"[\s\S]*<\/question-form>/);

    for (const kind of ['gsa', 'rsa']) {
      const response = await request(`/api/${kind}/start`, { workdir: workspace, mission: 'Review the public login page.', targetUrl: 'https://example.invalid/', profile: 'passive' });
      row[kind] = response;
      assert.equal(response.status, 409, JSON.stringify(response.body));
      assert.equal(response.body.code, 'workflow_needs_dstudio_agent');
      assert.match(response.body.error, /DStudio's own Agent/);
    }
    assert.ok(!fs.existsSync(path.join(workspace, '.dstudio/gsa')), 'a refused workflow prepares no run');
    assert.ok(!fs.existsSync(path.join(workspace, '.dstudio/rsa')), 'a refused workflow prepares no run');
    await stopRuntime();
    // Without a harness runtime the same request is admitted (and prepared).
    const admitted = await request('/api/gsa/start', { workdir: workspace, mission: 'Review the public login page.', targetUrl: 'https://example.invalid/', profile: 'passive' });
    row.admittedWithoutHarness = { status: admitted.status, ok: admitted.body.ok };
    assert.equal(admitted.status, 200, JSON.stringify(admitted.body).slice(0, 400));
  });

  await check('OpenCode crashing mid-turn fails that turn, keeps its partial answer and Agent starts again', async (row) => {
    installFakeOpencode();
    const started = await startAgent({ harness: 'opencode' });
    assert.equal(started.status, 200, JSON.stringify(started.body));
    await until(async () => { const s = await status(); return s.ready && s.mode === 'agent'; }, 'the OpenCode Agent did not become ready');
    const server = opencodePids()[0];
    assert.ok(server > 0 && processExists(server), 'the simulated opencode serve runs under the bridge');
    const sent = await request('/api/agent/send', { prompt: 'List the tests. CRASH', displayPrompt: 'List the tests.', orchestration: 'native' });
    assert.equal(sent.status, 200);
    await until(async () => (await task(sent.body.taskId)).status !== 'working', 'the crashed OpenCode turn never ended', 10000);
    row.turn = await task(sent.body.taskId);
    assert.equal(row.turn.status, 'failed');
    const text = await transcript();
    assert.match(text, /Partial OpenCode answer\./);
    assert.match(text, /"type":"runtime_notice","text":"opencode exited \(9\)"/);
    await until(async () => !(await status()).running, 'the bridge kept running without OpenCode', 10000);
    const restarted = await startAgent({ harness: 'opencode' });
    assert.equal(restarted.status, 200);
    await until(async () => { const s = await status(); return s.ready && s.mode === 'agent'; }, 'OpenCode did not start again');
    const next = await request('/api/agent/send', { prompt: 'Say hello', orchestration: 'native' });
    await until(async () => (await task(next.body.taskId)).status === 'completed', 'the restarted OpenCode Agent did not complete a turn');
    assert.match(await transcript(), /OpenCode answer to: Say hello/);
    await stopRuntime();
    await until(() => opencodePids().every((p) => !processExists(p)), 'opencode outlived its bridge');
  });

  await check('the Design runtime dying mid-turn is reported, keeps its transcript and Design starts again', async (row) => {
    // A task-owned Design runtime fixture: it streams part of an answer and
    // then dies. Assets give it a buildable fixture instead of ds4-design's build.
    for (const file of ['DESIGN.md', 'tokens.css', 'components.html', 'assets/preview.js', 'references/recipes.md']) {
      fs.mkdirSync(path.dirname(path.join(assets, 'extension/design-systems/folio', file)), { recursive: true });
      fs.writeFileSync(path.join(assets, 'extension/design-systems/folio', file), 'Complete fixture\n');
    }
    fs.mkdirSync(path.join(assets, 'scripts'));
    for (const script of ['apply-ds4-glm53-m2max.sh', 'apply-ds4-vision-streaming.sh', 'apply-ds4-v41-vision-pairing.sh', 'apply-ds4-laguna-prefill-chunk.sh'])
      fs.writeFileSync(path.join(assets, 'scripts', script), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    fs.mkdirSync(path.join(assets, 'src/harness/design'), { recursive: true });
    fs.writeFileSync(path.join(assets, 'src/harness/design/build-design.sh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    fs.writeFileSync(path.join(engine, 'Makefile'), 'all:\n\t@false\n');
    fs.writeFileSync(path.join(engine, 'ds4-design'), '#!/bin/sh\nprintf "+DWARFSTAR_WAITING\\n" >&2\n' +
      'while IFS= read -r line; do\n  case "$line" in\n' +
      '    *DIE*) printf "Drafting the hero section\\n"; sleep 0.2; kill -9 $$ ;;\n' +
      '    *) printf "design ack: %s\\n" "$line"; printf "+DWARFSTAR_WAITING\\n" >&2 ;;\n  esac\ndone\n', { mode: 0o755 });
    assert.equal((await request('/api/webdir', { path: assets })).status, 200);
    const start = () => request('/api/start', { mode: 'design', designSystem: 'folio', workdir: workspace, ...remote }, 30000);
    const started = await start();
    assert.equal(started.status, 200, JSON.stringify(started.body));
    await until(async () => { const s = await status(); return s.ready && s.mode === 'design'; }, 'Design fixture not ready');
    const sent = await request('/api/agent/send', { prompt: 'Draw the landing page. DIE', displayPrompt: 'Draw the landing page.' });
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    await until(async () => !(await status()).running, 'the host did not notice the dead Design runtime');
    row.turn = await task(sent.body.taskId);
    assert.equal(row.turn.status, 'incomplete');
    const text = await transcript();
    assert.match(text, /Drafting the hero section/);
    assert.match(text, /Engine process stopped before completing the turn: engine stopped \(signal 9\)/);
    const again = await start();
    assert.equal(again.status, 200);
    await until(async () => { const s = await status(); return s.ready && s.mode === 'design'; }, 'Design did not start again');
    const next = await request('/api/agent/send', { prompt: 'Draw it again', displayPrompt: 'Draw it again' });
    await until(async () => (await task(next.body.taskId)).status === 'completed', 'no Design turn after the restart');
    assert.match(await transcript(), /design ack: Draw it again/);
    await stopRuntime();
  });
} finally {
  receipt.modelRequests = modelRequests;
  writeArtifact(run, 'results.json', receipt);
  if (host.exitCode === null) { try { process.kill(-host.pid, 'SIGTERM'); } catch {} await Promise.race([hostExited, sleep(5000)]); }
  if (host.exitCode === null) { try { process.kill(-host.pid, 'SIGKILL'); } catch {} }
  for (const pid of piPids()) if (processExists(pid)) { process.exitCode = 1; console.log(`FAIL simulated pi ${pid} outlived the test`); process.kill(pid, 'SIGKILL'); }
  model.close();
  console.log(`harness_host_test: ${receipt.cases.filter((c) => c.status === 'PASS').length}/${receipt.cases.length} passed; evidence ${run}`);
}

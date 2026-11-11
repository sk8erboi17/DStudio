// Disk snapshots of the llama-server slot (src/dstudio_kv_snapshot.c): the
// production host binary, its real launch, guard, model relay and HTTP API,
// against a SCRIPTED llama-server (tests/support/fake_llama_server.mjs) and a
// SIMULATED tools runtime (tests/support/fake_session_runtime.mjs) that prints
// what the real runtimes print. No model, no inference, no llama.cpp build:
// this proves the host's decisions and files, not that a real model's state
// survives a restore (tests/live/llama_kv_snapshot_live_test.mjs).
//   node tests/integration/llama_kv_snapshot_test.mjs [tests/.build/dstudio-server-test]
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { artifactRunDir, csrfHeaders, freePort, sleep } from '../support/real_harness.mjs';

const repo = path.resolve(import.meta.dirname, '../..');
const binary = path.resolve(process.argv[2] || 'tests/.build/dstudio-server-test');
const run = artifactRunDir('llama-kv-snapshot');
const MODEL = 'gguf/Qwen3.6-35B-A3B-UD-Q6_K_XL.gguf';
const SLOT_NAME = /^[acd]-[0-9a-f]{8}-[0-9a-f]{16}\.(slot|part)$/;
const report = { schema: 'dstudio.llama-kv-snapshot-test.v1',
  scope: 'Real host binary, launch, guard, relay and HTTP; SCRIPTED llama-server and SIMULATED runtime; no model or inference',
  binarySHA256: crypto.createHash('sha256').update(fs.readFileSync(binary)).digest('hex'), cases: [] };

function fixture(file, contents, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents, mode ? { mode } : undefined);
  if (mode) fs.chmodSync(file, mode);
}
const launcher = (script) => `#!/bin/sh\nexec "${process.execPath}" "${path.join(repo, 'tests/support', script)}" "$@"\n`;

// One isolated installation: <root>/ds4 (models and the tools runtimes),
// <root>/llama.cpp (the scripted server and an installer receipt), a support
// tree whose builders and installer are stubs, and a private KV root. The
// Agent runtime counts as built: its sources are older than its executable and
// its version file names the current patch set, so the launch builds nothing.
function installation(name) {
  const base = path.join(run, name), root = path.join(base, 'root');
  const site = { base, root, engine: path.join(root, 'ds4'), install: path.join(root, 'llama.cpp'), assets: path.join(base, 'assets'),
    workspace: path.join(base, 'workspace'), kv: path.join(base, 'kv'), control: path.join(base, 'fake'), profile: path.join(base, 'profile') };
  for (const dir of [site.engine, site.workspace, site.control]) fs.mkdirSync(dir, { recursive: true });
  site.store = path.join(site.kv, 'llama-slots');
  fixture(path.join(site.engine, 'Makefile'), 'all:\n\t@false\n');
  fixture(path.join(site.engine, MODEL), 'fixture only, not model weights\n');
  const past = new Date(Date.now() - 3600_000);
  for (const dir of ['patch/ds4-agent-jsonl', 'patch/ds4-web-runtime', 'extension/remote']) {
    fs.cpSync(path.join(repo, dir), path.join(site.assets, dir), { recursive: true });
    for (const name of fs.readdirSync(path.join(site.assets, dir))) fs.utimesSync(path.join(site.assets, dir, name), past, past);
  }
  for (const source of ['ds4_agent.c', 'ds4_web.c', 'ds4.c', 'ds4.h']) {
    fixture(path.join(site.engine, source), '/* fixture: not engine source */\n');
    fs.utimesSync(path.join(site.engine, source), past, past);
  }
  const patchVersion = fs.readFileSync(path.join(repo, 'patch/ds4-agent-jsonl/manifest'), 'utf8').match(/^version\s*=\s*(\d+)/m)[1];
  fixture(path.join(site.engine, 'ds4-agent-jsonl.ver'), patchVersion + '\n');
  for (const runtime of ['ds4-agent-jsonl', 'ds4-cowork', 'ds4-design'])
    fixture(path.join(site.engine, runtime), launcher('fake_session_runtime.mjs'), 0o755);
  fixture(path.join(site.install, 'bin/llama-server'), launcher('fake_llama_server.mjs'), 0o755);
  site.receipt = (buildId) => fixture(path.join(site.install, '.dstudio-llama.json'), JSON.stringify({ schema: 'dstudio.llama-install.v1',
    engine: 'llama', commit: 'f5027fb21307eb264aed483242603d68c87b0fe3', buildNumber: '11836', buildId,
    binary: 'bin/llama-server', binarySHA256: 'c'.repeat(64) }) + '\n');
  site.receipt('a'.repeat(64));
  // Simulated installer and builders: the launch path runs them, nothing is built.
  fixture(path.join(site.assets, 'scripts/install-llama.py'), 'import sys\nprint("fixture installer: nothing built")\nsys.exit(0)\n');
  for (const script of ['scripts/apply-ds4-glm53-m2max.sh', 'scripts/apply-ds4-vision-streaming.sh',
    'scripts/apply-ds4-v41-vision-pairing.sh', 'src/harness/design/build-design.sh'])
    fixture(path.join(site.assets, script), '#!/bin/sh\nexit 0\n', 0o755);
  for (const file of ['DESIGN.md', 'tokens.css', 'components.html', 'assets/preview.js', 'references/recipes.md'])
    fixture(path.join(site.assets, 'extension/design-systems/folio', file), 'Complete fixture\n');
  site.config = (value) => fs.writeFileSync(path.join(site.control, 'config.json'), JSON.stringify(value));
  site.config({});
  site.serverEvents = () => { try { return fs.readFileSync(path.join(site.control, 'server-events.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  site.files = () => { try { return fs.readdirSync(site.store).sort(); } catch { return []; } };
  return site;
}

async function host(site, env = {}, mode = 'agent') {
  const port = await freePort(), base = `http://127.0.0.1:${port}`;
  const log = fs.openSync(path.join(site.base, `host-${port}.log`), 'wx');
  const child = spawn(binary, [String(port), site.engine], { cwd: repo, detached: true, stdio: ['ignore', log, log],
    env: { ...process.env, DS4UI_DATA_DIR: site.profile, DS4UI_NO_WINDOW: '1', DS4UI_TEST_MODE: '1', DS4UI_DEFER_ENGINE_START: '1',
      DS4UI_HOST: '127.0.0.1', DSTUDIO_KV_DIR: site.kv, KVFAKE_DIR: site.control,
      // Off by default (not verified on real weights): every case opts in, except the one that proves the default.
      DSTUDIO_LLAMA_KV_SNAPSHOTS: '1', DSTUDIO_LLAMA_KV_MAX_BYTES: '', DSTUDIO_LLAMA_KV_MAX_ENTRIES: '', DSTUDIO_LLAMA_KV_MIN_FREE_BYTES: '1', ...env } });
  fs.closeSync(log);
  const exited = new Promise((resolve) => { child.once('exit', resolve); child.once('error', resolve); });
  const h = { site, child, enginePort: await freePort(), since: 0, transcript: '' };
  h.request = async (endpoint, body, timeout = 5000) => {
    const res = await fetch(base + endpoint, { method: body === undefined ? 'GET' : 'POST', headers: csrfHeaders,
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeout) });
    return { status: res.status, body: await res.json() };
  };
  h.status = async () => (await h.request('/api/status', undefined, 2000)).body;
  h.kv = async () => (await h.status()).llamaKvSnapshot;
  h.until = async (check, message, ms = 15000) => {
    const deadline = Date.now() + ms;
    for (;;) {
      const value = await check();
      if (value) return value;
      assert.equal(child.exitCode, null, 'the host exited: ' + message);
      if (Date.now() > deadline) throw new Error('timed out: ' + message + '\n' + JSON.stringify(await h.kv().catch(() => null)));
      await sleep(25);
    }
  };
  h.poll = async () => {
    const r = (await h.request(`/api/agent/poll?since=${h.since}`)).body;
    h.transcript += r.text || ''; h.since = r.len;
    return h.transcript;
  };
  h.idle = () => h.until(async () => { const s = await h.status(); return s.ready && !s.agentWorking ? s : null; }, 'the runtime did not become idle');
  h.mode = mode;
  h.start = async (extra = {}) => {
    const started = await h.request('/api/start', { mode: h.mode, modelBackend: 'local', gguf: MODEL, ...(h.mode === 'design' ? { designSystem: 'folio' } : {}),
      workdir: site.workspace, port: h.enginePort, ctx: 16384, power: 100, think: 'off', ...extra }, 30000);
    assert.equal(started.status, 200, JSON.stringify(started.body));
    h.since = 0; h.transcript = '';
    const s = await h.until(async () => { const st = await h.status(); return st.ready && st.mode === h.mode && !st.agentWorking && st.residentPid > 0 ? st : null; }, 'the engine did not become ready');
    h.serverPid = await h.until(() => site.serverEvents().filter((e) => e.type === 'start').at(-1)?.pid, 'the scripted server did not start');
    return s;
  };
  h.stop = async () => {
    const s = await h.status();
    if (!s.running && !s.residentPid) return;
    assert.equal((await h.request('/api/stop', {})).status, 200);
    await h.until(async () => { const st = await h.status(); return !st.running && !st.residentPid; }, 'the engine did not stop');
  };
  h.restart = async (extra) => { await h.stop(); return h.start(extra); };
  // Events of the scripted server process serving this engine start.
  h.events = () => site.serverEvents().filter((e) => e.pid === h.serverPid);
  h.send = async (prompt) => {
    const sent = await h.request('/api/agent/send', { prompt, orchestration: 'native' });
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    return sent.body;
  };
  h.turn = async (prompt) => { const sent = await h.send(prompt); await h.idle(); await h.poll(); return sent; };
  h.session = async (action, sha) => {
    const r = await h.until(async () => { const x = await h.request('/api/design/session', sha ? { action, sha } : { action }); return x.status === 409 ? null : x; }, 'the session command was not accepted');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    await h.idle(); await h.poll();
  };
  // The next save/restore outcome after the action.
  h.saved = async (action) => {
    const before = (await h.kv()).lastSave?.seq || 0;
    const result = await action();
    const last = await h.until(async () => { const k = await h.kv(); return k.lastSave && k.lastSave.seq > before && k.activity === 'idle' ? k.lastSave : null; }, 'no save outcome was reported');
    return { result, save: last };
  };
  h.restored = async (action) => {
    const before = (await h.kv()).lastRestore?.seq || 0;
    await action();
    return h.until(async () => { const k = await h.kv(); return k.lastRestore && k.lastRestore.seq > before ? k.lastRestore : null; }, 'no restore outcome was reported');
  };
  h.settled = () => h.until(async () => (await h.kv()).activity === 'idle', 'the snapshot exchange did not settle');
  h.release = async (what) => (await fetch(`http://127.0.0.1:${h.enginePort}/__fake/release`, { method: 'POST', body: JSON.stringify({ what }) })).json();
  h.close = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already gone */ }
    await Promise.race([exited, sleep(6000)]);
    if (child.exitCode === null && child.signalCode === null) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } await exited; }
  };
  await h.until(async () => { try { return (await h.request('/api/status')).status === 200; } catch { return false; } }, 'the host did not listen');
  assert.equal((await h.request('/api/webdir', { path: site.assets })).status, 200);
  return h;
}

let current = null;
async function check(name, fn) {
  const row = { name };
  try { await fn(row); row.status = 'PASS'; }
  catch (error) { row.status = 'FAIL'; row.error = String(error.stack || error); process.exitCode = 1; }
  report.cases.push(row);
  console.log(`${row.status} ${name}${row.error ? `\n${row.error}` : ''}`);
  return row.status === 'PASS';
}
const sidecar = (site, slot) => JSON.parse(fs.readFileSync(path.join(site.store, slot.replace(/\.slot$/, '.json')), 'utf8'));
const slotsOf = (site) => site.files().filter((f) => f.endsWith('.slot'));
const sessionId = (prompt) => crypto.createHash('sha1').update(prompt).digest('hex').slice(0, 8);
const between = (events, from, type) => events.slice(from).filter((e) => e.type === type);

try {
  // ---------------------------------------------------------------- main run
  const site = installation('main');
  const h = current = await host(site);
  const first = 'two-step write down the plan for the harbour survey';
  const S1 = sessionId(first);
  let slot1 = '';

  await check('a completed turn is followed by one slot save, never during a completion', async (row) => {
    const started = await h.start();
    const args = h.events().find((e) => e.type === 'start').args;
    assert.equal(args[args.indexOf('--slot-save-path') + 1], site.store, 'the server is started with the private slot directory');
    assert.equal(fs.statSync(site.store).mode & 0o777, 0o700);
    assert.equal(started.llamaKvSnapshot.enabled, true);
    const { save } = await h.saved(() => h.turn(first));
    assert.equal(save.outcome, 'saved', JSON.stringify(save));
    assert.deepEqual([save.mode, save.session], ['agent', S1]);
    const events = h.events().map((e) => e.type).filter((t) => /^completion_(start|end)|^slot_save/.test(t));
    assert.deepEqual(events, ['completion_start', 'completion_end', 'completion_start', 'completion_end', 'slot_save_request', 'slot_save_done'],
      'two completions of one turn, then one save');
    const request = h.events().find((e) => e.type === 'slot_save_request');
    assert.equal(request.processing, false, 'no save was requested while the slot was processing');
    assert.match(request.filename, new RegExp(`^a-${S1}-[0-9a-f]{16}\\.part$`));
    slot1 = request.filename.replace(/\.part$/, '.slot');
    assert.deepEqual(site.files(), [slot1.replace(/\.slot$/, '.json'), slot1], 'published as a slot with its record; no partial file left');
    const meta = sidecar(site, slot1), size = fs.statSync(path.join(site.store, slot1)).size;
    assert.equal(meta.format, 'dstudio.llama-slot.v1');
    assert.deepEqual([meta.mode, meta.session, meta.bytes, meta.tokens], ['agent', S1, size, save.tokens]);
    assert.equal(meta.messages, 3, 'the transcript state the runtime announced');
    assert.equal(save.bytes, size, 'sizes are those of the written file');
    const kv = await h.kv();
    assert.deepEqual([kv.store.entries, kv.store.bytes], [1, size]);
    row.save = save; row.files = site.files();
  });

  await check('after an engine restart the snapshot is restored before the session\'s first completion, and reported', async (row) => {
    await h.restart();
    assert.deepEqual(h.events().filter((e) => e.type.startsWith('slot_')), [], 'a fresh engine restores nothing by itself');
    const restore = await h.restored(() => h.session('switch', S1));
    assert.equal(restore.outcome, 'restored', JSON.stringify(restore));
    assert.equal(restore.text, `restored from disk snapshot (${restore.tokens} tokens)`);
    assert.equal(restore.firstCompletion, null, 'nothing is claimed about a completion that has not run');
    const sent = await h.turn('and what was the second step?');
    const events = h.events();
    const order = events.map((e) => e.type).filter((t) => /^slot_restore|^completion_start/.test(t));
    assert.deepEqual(order, ['slot_restore_request', 'slot_restore_done', 'completion_start']);
    assert.equal(events.find((e) => e.type === 'slot_restore_request').filename, slot1, 'the file of this session and this engine');
    const completion = events.find((e) => e.type === 'completion_start');
    assert.equal(completion.cacheTokens, restore.tokens, 'the restored tokens were the completion\'s cache');
    assert.ok(completion.processedTokens > 0 && completion.processedTokens < completion.cacheTokens, 'only the new message was processed');
    const after = (await h.kv()).lastRestore;
    assert.deepEqual(after.firstCompletion, { cacheTokens: completion.cacheTokens, promptTokens: completion.processedTokens });
    assert.equal(after.outcome, 'restored');
    assert.match(h.transcript, new RegExp(`\\x1e\\{"type":"status","state":"kv_snapshot","outcome":"restored","tokens":${restore.tokens}\\}\\n`), 'turn metadata in the transcript');
    const task = (await h.request('/api/task?id=' + sent.taskId)).body;
    assert.ok(JSON.stringify(task).includes(restore.text), 'turn metadata in the task record');
    row.restore = after;
  });

  await check('a session whose state is still in memory is not restored from disk again', async (row) => {
    await h.settled();
    const before = h.events().filter((e) => e.type === 'slot_restore_request').length;
    const restore = await h.restored(() => h.session('switch', S1));
    assert.equal(restore.outcome, 'live');
    assert.equal(restore.text, 'context still in memory');
    assert.equal(h.events().filter((e) => e.type === 'slot_restore_request').length, before);
    row.restore = restore;
  });

  await check('a blocked restore holds only that session\'s first completion; status and Stop stay responsive', async (row) => {
    await h.settled();
    site.config({ block: ['restore'] });
    await h.restart();
    await h.session('switch', S1);
    await h.until(() => h.events().some((e) => e.type === 'restore_blocked'), 'the restore did not reach its barrier');
    await h.send('a question asked while the snapshot is still being restored');
    await h.until(async () => (await h.kv()).holdingModelRequest, 'the model request was not held');
    const timings = [];
    for (let i = 0; i < 5; i++) { const t = Date.now(); assert.equal((await h.request('/api/status', undefined, 1000)).status, 200); timings.push(Date.now() - t); }
    assert.equal(h.events().filter((e) => e.type === 'completion_received').length, 0, 'no completion reached the server before the restore');
    const interrupted = await h.request('/api/agent/interrupt', { reason: 'test stop' }, 1000);
    assert.equal(interrupted.status, 200);
    await h.idle();
    assert.ok(h.events().some((e) => e.type === 'restore_blocked') && !h.events().some((e) => e.type === 'restore_released'), 'Stop did not wait for the restore');
    assert.equal(h.events().filter((e) => e.type === 'completion_received').length, 0, 'the stopped request never reached the server');
    const restore = await h.restored(() => h.release('restore'));
    assert.equal(restore.outcome, 'restored');
    site.config({});
    await h.turn('the question again, after the restore');
    const completion = h.events().filter((e) => e.type === 'completion_start').at(-1);
    assert.ok(completion.cacheTokens > 0);
    row.statusMs = timings; row.restore = restore;
  });

  await check('a restore the server refuses falls back to prefill: the turn succeeds and is reported as prefilled again', async (row) => {
    await h.settled();
    const before = slotsOf(site);
    assert.equal(before.length, 1);
    site.config({ refuseRestore: true });
    await h.restart();
    const restore = await h.restored(() => h.session('switch', S1));
    assert.equal(restore.outcome, 'prefill', JSON.stringify(restore));
    assert.equal(restore.text, 'prefilled again');
    assert.match(restore.reason, /refused \(HTTP 400\): Unable to restore slot/);
    await h.until(() => slotsOf(site).length === 0, 'the refused snapshot was not removed');
    site.config({});
    const { save } = await h.saved(() => h.turn('does the conversation still continue?'));
    const completion = h.events().find((e) => e.type === 'completion_start');
    assert.equal(completion.cacheTokens, 0);
    assert.equal(completion.processedTokens, completion.promptTokens, 'the whole transcript was prefilled');
    assert.match(h.transcript, /Reply 1 to does the conversation still continue\?/, 'the turn produced its answer');
    assert.match(h.transcript, /\x1e\{"type":"status","state":"kv_snapshot","outcome":"prefill","tokens":0\}\n/);
    assert.deepEqual((await h.kv()).lastRestore.firstCompletion, { cacheTokens: 0, promptTokens: completion.promptTokens });
    assert.equal(save.outcome, 'saved', 'the completed turn is snapshotted again');
    row.restore = restore;
  });

  await check('a restored snapshot that the completion does not reuse is reported as prefilled again', async (row) => {
    await h.settled();
    site.config({ discardRestoredState: true });
    await h.restart();
    const restore = await h.restored(() => h.session('switch', S1));
    assert.equal(restore.outcome, 'restored');
    await h.turn('one more question');
    const after = (await h.kv()).lastRestore;
    assert.equal(after.firstCompletion.cacheTokens, 0);
    assert.equal(after.outcome, 'restored-not-reused');
    assert.match(after.text, /^prefilled again \(the restored disk snapshot of \d+ tokens was not reused\)$/);
    site.config({});
    row.restore = after;
  });

  for (const [what, change, extra] of [
    ['context size', () => {}, { ctx: 32768 }],
    ['model file identity', () => fixture(path.join(site.engine, MODEL), 'other fixture bytes, still not weights\n'), { ctx: 32768 }],
    ['engine build id', () => site.receipt('b'.repeat(64)), { ctx: 32768 }],
  ]) {
    await check(`a changed ${what} is a key mismatch: no restore request, the stale files are removed, prefill`, async (row) => {
      await h.settled();
      const stale = slotsOf(site);
      assert.equal(stale.length, 1, 'a snapshot of the previous key exists: ' + site.files());
      await h.stop();
      await change();
      await h.start(extra);
      const restore = await h.restored(() => h.session('switch', S1));
      assert.equal(restore.outcome, 'prefill', JSON.stringify(restore));
      assert.equal(restore.text, 'prefilled again');
      assert.match(restore.reason, /its disk snapshot was removed: the model, engine build, context or launch arguments changed/);
      assert.deepEqual(site.files(), [], 'the stale slot and its record are gone');
      assert.equal(h.events().filter((e) => e.type === 'slot_restore_request').length, 0, 'the server was never asked');
      const { save } = await h.saved(() => h.turn(`continuing after the ${what} change`));
      assert.equal(h.events().find((e) => e.type === 'completion_start').cacheTokens, 0);
      assert.equal(save.outcome, 'saved');
      assert.notEqual(slotsOf(site)[0], stale[0], 'the new snapshot has another key');
      row.restore = restore; row.stale = stale; row.fresh = slotsOf(site);
    });
  }

  await check('a blocked save does not block status, a new turn or Stop; overtaken, it is discarded and the newer state is saved', async (row) => {
    await h.settled();
    site.config({ block: ['save'], serialize: false }); // not real behaviour: lets completions run beside the held save
    const before = h.events().length;
    await h.turn('first turn behind a slow save');
    await h.until(() => between(h.events(), before, 'save_blocked').length === 1, 'the save did not reach its barrier');
    const timings = [];
    for (let i = 0; i < 5; i++) { const t = Date.now(); const s = await h.request('/api/status', undefined, 1000); assert.equal(s.body.llamaKvSnapshot.activity, 'saving'); timings.push(Date.now() - t); }
    const seq = (await h.kv()).lastSave.seq;
    await h.turn('second turn, while the first save is still being written');
    await h.turn('third turn, still before the first save returned');
    assert.equal(between(h.events(), before, 'slot_save_request').length, 1, 'one save in flight: nothing else was sent');
    site.config({ serialize: false }); // only the first save is held
    await h.release('save');
    const save = await h.until(async () => { const k = await h.kv(); return k.activity === 'idle' && k.lastSave.seq > seq && k.lastSave.outcome === 'saved' ? k.lastSave : null; }, 'the newest state was not saved');
    const requests = between(h.events(), before, 'slot_save_request');
    assert.equal(requests.length, 2, 'the overtaken save and one save of the newest state; the middle one was never sent');
    const done = between(h.events(), before, 'slot_save_done');
    assert.ok(done[1].tokens > done[0].tokens, 'the second request saved a later state than the overtaken one');
    assert.equal(sidecar(site, slotsOf(site)[0]).tokens, done[1].tokens, 'the published snapshot is the newest state, not the overtaken one');
    const announced = [...h.transcript.matchAll(/saved session [0-9a-f]{8} \((\d+) messages\)/g)].at(-1);
    assert.equal(sidecar(site, slotsOf(site)[0]).messages, Number(announced[1]), 'the record names the transcript of the third turn');
    assert.deepEqual(site.files().filter((f) => f.endsWith('.part')), [], 'the discarded save left no partial file');
    site.config({});
    row.statusMs = timings; row.save = save;
  });

  await check('with the server\'s own task order, a turn started behind a blocked save can still be stopped', async (row) => {
    await h.settled();
    site.config({ block: ['save'] });
    const before = h.events().length;
    await h.turn('a turn whose save will block the server');
    await h.until(() => between(h.events(), before, 'save_blocked').length === 1, 'the save did not reach its barrier');
    await h.send('a turn queued behind the save in the server');
    await h.until(() => between(h.events(), before, 'completion_received').length === 2, 'the completion was held by the host');
    const t = Date.now();
    assert.equal((await h.request('/api/agent/interrupt', { reason: 'test stop' }, 1000)).status, 200);
    await h.idle();
    row.stopMs = Date.now() - t;
    assert.equal(between(h.events(), before, 'save_released').length, 0, 'Stop did not wait for the save');
    const seq = (await h.kv()).lastSave.seq;
    await h.release('save');
    await h.until(async () => { const k = await h.kv(); return k.activity === 'idle' && k.lastSave.seq >= seq; }, 'the exchange did not end');
    assert.deepEqual(site.files().filter((f) => f.endsWith('.part')), []);
    site.config({});
  });

  await check('a save that returns after its session was deleted is not published', async (row) => {
    await h.settled();
    await h.session('new');
    const prompt = 'a conversation that is deleted while its snapshot is written';
    const id = sessionId(prompt);
    site.config({ block: ['save'] });
    const before = h.events().length;
    await h.turn(prompt);
    await h.until(() => between(h.events(), before, 'save_blocked').length === 1, 'the save did not reach its barrier');
    const seq = (await h.kv()).lastSave?.seq || 0;
    await h.session('del', id);
    await h.release('save');
    const save = await h.until(async () => { const k = await h.kv(); return k.activity === 'idle' && k.lastSave.seq > seq ? k.lastSave : null; }, 'no outcome for the late save');
    assert.deepEqual([save.outcome, save.reason, save.session], ['discarded', 'the session was deleted', id]);
    assert.equal(between(h.events(), before, 'slot_save_done').length, 1, 'the server did write and answer');
    await h.until(() => site.files().every((f) => !f.includes(id)), 'a file of the deleted session remained: ' + site.files());
    site.config({});
    row.save = save;
  });

  await check('a snapshot is deleted with its conversation, and only that one', async (row) => {
    await h.settled();
    await h.session('new');
    const prompt = 'another conversation, to be deleted on purpose';
    const id = sessionId(prompt);
    const { save } = await h.saved(() => h.turn(prompt));
    assert.equal(save.outcome, 'saved');
    const others = site.files().filter((f) => !f.includes(id));
    assert.ok(site.files().some((f) => f.includes(id)) && others.length >= 2, 'two conversations have snapshots: ' + site.files());
    await h.session('del', id);
    await h.until(() => site.files().every((f) => !f.includes(id)), 'the deleted conversation kept its snapshot');
    assert.deepEqual(site.files(), others, 'the other conversation kept its own');
    row.remaining = site.files();
  });

  await check('file names are confined: hostile ids reach neither the store nor the server', async (row) => {
    await h.settled();
    const victim = path.join(site.kv, 'victim.slot'), outside = path.join(site.base, 'outside.slot');
    fs.writeFileSync(victim, 'not a snapshot'); fs.writeFileSync(outside, 'not a snapshot');
    const filesBefore = site.files(), requests = h.events().filter((e) => e.type.startsWith('slot_')).length;
    for (const line of ['saved session ../../../outside (3 messages)', 'saved session ..%2f..%2fx (3 messages)',
      'switched to session ../victim (3 messages restored; x)', 'deleted session ../victim', 'deleted session ../../outside.slot',
      'saved session DEADBEEF (3 messages)', 'saved session deadbeef (3 messages) trailing', 'switched to session deadbeefdeadbeef (3 messages restored)'])
      await h.turn('!print ' + line);
    // Well formed, but no turn of this session is in the slot: nothing is saved under it.
    const { save } = await h.saved(() => h.turn('!print saved session deadbeef (3 messages)'));
    assert.deepEqual([save.outcome, save.session], ['skipped', 'deadbeef']);
    assert.match(save.reason, /does not hold this session's last completed turn/);
    // The session API keeps only the hex digits of an id; none of these names a snapshot.
    for (const sha of ['../../etc/passwd', '..', '%2e%2e', 'zzzzzzzz', '../victim.slot']) {
      await h.idle();
      await h.request('/api/design/session', { action: 'del', sha });
    }
    await h.idle(); await h.settled();
    assert.deepEqual(site.files(), filesBefore);
    assert.equal(h.events().filter((e) => e.type.startsWith('slot_')).length, requests, 'no slot request was made');
    assert.equal(fs.readFileSync(victim, 'utf8'), 'not a snapshot'); assert.equal(fs.readFileSync(outside, 'utf8'), 'not a snapshot');
    fs.unlinkSync(victim);
    row.files = site.files();
  });

  await check('wiping the history removes every snapshot and keeps the running engine able to save', async (row) => {
    await h.settled();
    assert.ok(slotsOf(site).length >= 1);
    const wiped = await h.request('/api/wipe', {}, 5000);
    assert.equal(wiped.status, 200, JSON.stringify(wiped.body));
    await h.until(async () => site.files().length === 0 && (await h.kv()).store.entries === 0, 'snapshots survived the wipe: ' + site.files());
    assert.ok(fs.statSync(site.store).isDirectory(), 'the slot directory of the running server stays');
    await h.session('new');
    const { save } = await h.saved(() => h.turn('a new conversation after the wipe'));
    assert.equal(save.outcome, 'saved');
    row.files = site.files();
  });

  await check('a save answered after the engine was told to stop is not published; the next start prefills', async (row) => {
    await h.settled();
    await h.session('new');
    const prompt = 'the engine is stopped while this snapshot is written';
    const id = sessionId(prompt);
    site.config({ block: ['save'], finishSaveOnTerm: true });
    const before = h.events().length;
    await h.turn(prompt);
    await h.until(() => between(h.events(), before, 'save_blocked').length === 1, 'the save did not reach its barrier');
    const old = h.serverPid, seq = (await h.kv()).lastSave?.seq || 0;
    await h.stop();
    const events = site.serverEvents().filter((e) => e.pid === old);
    assert.ok(events.some((e) => e.type === 'term' && e.finishingSave) && events.some((e) => e.type === 'slot_save_done' && e.filename.includes(id)),
      'the server completed and answered the save while stopping');
    const save = await h.until(async () => { const k = await h.kv(); return k.activity === 'idle' && k.lastSave.seq > seq ? k.lastSave : null; }, 'no outcome for the late save');
    assert.equal(save.session, id);
    assert.ok(['discarded', 'failed'].includes(save.outcome), JSON.stringify(save));
    assert.match(save.reason, /engine was stopped or replaced|closed the connection/);
    await h.until(() => site.files().every((f) => !f.includes(id)), 'a snapshot of the replaced engine was published: ' + site.files());
    site.config({});
    await h.start({ ctx: 32768 });
    const restore = await h.restored(() => h.session('switch', id));
    assert.deepEqual([restore.outcome, restore.reason], ['prefill', 'no disk snapshot of this session']);
    row.save = save; row.restore = restore;
  });

  await check('a model that is not llama.cpp never snapshots: a remote-model session behaves as before', async (row) => {
    await h.settled();
    await h.stop();
    const before = site.serverEvents().length, files = site.files();
    const started = await h.request('/api/start', { mode: 'agent', modelBackend: 'remote', remoteBaseUrl: 'http://127.0.0.1:9', remoteModel: 'fixture-no-inference',
      workdir: site.workspace, think: 'off' }, 30000);
    assert.equal(started.status, 200, JSON.stringify(started.body));
    h.since = 0; h.transcript = '';
    await h.idle();
    const kv = await h.kv();
    assert.equal(kv.enabled, false);
    const seq = [kv.lastSave?.seq, kv.lastRestore?.seq];
    await h.turn('!print saved session ' + S1 + ' (3 messages)');
    await h.turn('!print switched to session ' + S1 + ' (3 messages restored; the model server reads them again on the next turn)');
    const after = await h.kv();
    assert.deepEqual([after.lastSave?.seq, after.lastRestore?.seq], seq, 'no snapshot decision was made');
    assert.equal(after.activity, 'idle');
    assert.equal(site.serverEvents().length, before); assert.deepEqual(site.files(), files);
    await h.stop();
    row.reason = kv.reason;
  });
  // Every file name the scripted server ever received in this run.
  await check('every slot file name sent to the server was a plain name of this store', async (row) => {
    const names = site.serverEvents().filter((e) => e.filename !== undefined).map((e) => e.filename);
    assert.ok(names.length > 10);
    for (const name of names) assert.match(name, SLOT_NAME);
    assert.equal(site.serverEvents().filter((e) => e.type === 'slot_filename_refused').length, 0);
    row.names = names.length;
  });
  await h.close(); current = null;

  // ------------------------------------------------- limits: bytes and order
  const limited = installation('limits');
  limited.config({ bytesPerToken: 8192 });
  const prompts = ['alpha conversation about the first of three topics', 'bravo conversation about the second of three topics',
    'gamma conversation about the third of three topics'];
  const ids = prompts.map(sessionId);
  await check('the byte cap evicts the least recently used snapshot, counted from the written files', async (row) => {
    const l = current = await host(limited, { DSTUDIO_LLAMA_KV_MAX_BYTES: String(500 * 1024) });
    await l.start();
    const sizes = [];
    for (const prompt of prompts.slice(0, 2)) {
      await l.session('new');
      const { save } = await l.saved(() => l.turn(prompt));
      assert.equal(save.outcome, 'saved'); sizes.push(save.bytes);
    }
    assert.ok(sizes[0] + sizes[1] <= 500 * 1024 && sizes[0] + sizes[1] + sizes[0] > 500 * 1024, 'two snapshots fit, three do not: ' + sizes);
    assert.deepEqual(slotsOf(limited).map((f) => f.slice(2, 10)).sort(), ids.slice(0, 2).sort());
    // Using the first one makes the second the least recently used.
    await l.restart();
    assert.equal((await l.restored(() => l.session('switch', ids[0]))).outcome, 'restored');
    await l.until(async () => (await l.kv()).activity === 'idle', 'restore bookkeeping did not finish');
    await l.session('new');
    const { save } = await l.saved(() => l.turn(prompts[2]));
    assert.equal(save.outcome, 'saved');
    assert.deepEqual(slotsOf(limited).map((f) => f.slice(2, 10)).sort(), [ids[0], ids[2]].sort(), 'the unused middle snapshot was evicted');
    const kv = await l.kv(), onDisk = slotsOf(limited).reduce((n, f) => n + fs.statSync(path.join(limited.store, f)).size, 0);
    assert.deepEqual([kv.store.entries, kv.store.bytes, kv.store.maxBytes], [2, onDisk, 500 * 1024]);
    assert.ok(kv.store.bytes <= kv.store.maxBytes);
    assert.equal(kv.counters.evicted, 1);
    assert.equal(limited.files().length, 4, 'evicted snapshots take their records with them');
    await l.close(); current = null;
    row.sizes = sizes; row.kept = slotsOf(limited);
  });

  await check('the entry cap keeps only the newest snapshot; a snapshot larger than the store is not kept', async (row) => {
    let l = current = await host(limited, { DSTUDIO_LLAMA_KV_MAX_ENTRIES: '1' });
    await l.start();
    await l.session('new');
    const { save } = await l.saved(() => l.turn(prompts[1]));
    assert.equal(save.outcome, 'saved');
    assert.deepEqual(slotsOf(limited).map((f) => f.slice(2, 10)), [ids[1]], 'one entry: the one just written');
    assert.equal((await l.kv()).store.maxEntries, 1);
    await l.close();
    l = current = await host(limited, { DSTUDIO_LLAMA_KV_MAX_BYTES: '4096' });
    await l.start();
    await l.session('new');
    const refused = (await l.saved(() => l.turn(prompts[0]))).save;
    assert.deepEqual([refused.outcome, refused.reason], ['refused', 'the snapshot is larger than the whole store limit']);
    assert.ok(limited.files().every((f) => !f.includes(ids[0])), 'nothing of the oversized snapshot remained: ' + limited.files());
    await l.close(); current = null;
    row.refused = refused;
  });

  await check('no snapshot is written when free disk space is below the margin', async (row) => {
    const l = current = await host(limited, { DSTUDIO_LLAMA_KV_MIN_FREE_BYTES: '9000000000000000000' });
    await l.start();
    await l.session('new');
    const files = limited.files();
    const { save } = await l.saved(() => l.turn(prompts[2]));
    assert.deepEqual([save.outcome, save.reason], ['refused', 'free disk space is below the snapshot margin']);
    assert.equal(l.events().filter((e) => e.type === 'slot_save_request').length, 0, 'the server was not asked to write');
    assert.deepEqual(limited.files(), files);
    await l.close(); current = null;
    row.save = save;
  });

  for (const [dir, what, env, reason] of [
    ['default-off', 'without the opt-in (the default)', { DSTUDIO_LLAMA_KV_SNAPSHOTS: '' }, /off by default \(not yet verified on real weights\): set DSTUDIO_LLAMA_KV_SNAPSHOTS=1/],
    ['zero-cap', 'with a zero byte cap', { DSTUDIO_LLAMA_KV_MAX_BYTES: '0' }, /DSTUDIO_LLAMA_KV_MAX_BYTES is 0/],
  ]) {
    await check(`${what} there are no snapshots: the server gets no slot directory and turns run as before`, async (row) => {
      const off = installation(dir);
      const l = current = await host(off, env);
      const started = await l.start();
      assert.ok(!l.events().find((e) => e.type === 'start').args.includes('--slot-save-path'));
      assert.equal(started.llamaKvSnapshot.enabled, false);
      assert.match(started.llamaKvSnapshot.reason, reason);
      await l.turn('a turn without any snapshot');
      assert.match(l.transcript, /Reply 1 to a turn without any snapshot/);
      await l.restart();
      await l.session('switch', sessionId('a turn without any snapshot'));
      await l.turn('and a second one after a restart');
      assert.match(l.transcript, /Reply 1 to and a second one after a restart/);
      const kv = await l.kv();
      assert.deepEqual([kv.lastSave, kv.lastRestore], [null, null], 'no snapshot decision was made');
      assert.equal(off.serverEvents().filter((e) => e.type.startsWith('slot_')).length, 0);
      assert.equal(fs.existsSync(off.store), false);
      await l.close(); current = null;
      row.reason = started.llamaKvSnapshot.reason;
    });
  }

  // ---------------------------------------- the Design runtime's own markers
  await check('in Design mode the runtime\'s stderr markers drive the same save, restore and deletion; prose on stdout does not', async (row) => {
    const design = installation('design-markers');
    const l = current = await host(design, {}, 'design');
    await l.start();
    const prompt = 'draw the landing page of the observatory';
    const id = sessionId(prompt);
    // The reply itself prints what an Agent runtime would print: in Design mode that is prose.
    design.config({ reply: 'Done.\nsaved session 0000aaaa (2 messages)\n+DSTUDIO_SESSION_SAVED 0000bbbb 2\n' });
    const { save } = await l.saved(() => l.turn(prompt));
    assert.deepEqual([save.outcome, save.mode, save.session], ['saved', 'design', id]);
    assert.match(l.transcript, /saved session 0000aaaa \(2 messages\)\n\+DSTUDIO_SESSION_SAVED 0000bbbb 2/, 'the imitations were printed');
    assert.deepEqual(slotsOf(design).map((f) => f.slice(0, 10)), ['d-' + id], 'only the runtime\'s own marker named a snapshot');
    assert.equal((await l.kv()).counters.saveRequests, 1);
    design.config({});
    await l.restart();
    const restore = await l.restored(() => l.session('switch', id));
    assert.equal(restore.outcome, 'restored', JSON.stringify(restore));
    await l.turn('and make the header taller');
    assert.equal(l.events().find((e) => e.type === 'completion_start').cacheTokens, restore.tokens);
    await l.session('del', id);
    await l.until(() => design.files().length === 0, 'the deleted Design session kept its snapshot');
    await l.close(); current = null;
    row.restore = restore;
  });
} catch (error) {
  report.cases.push({ name: 'test infrastructure', status: 'FAIL', error: String(error.stack || error) });
  console.log('FAIL test infrastructure\n' + String(error.stack || error));
  process.exitCode = 1;
} finally {
  if (current) await current.close();
  report.status = report.cases.length && report.cases.every((c) => c.status === 'PASS') ? 'PASS' : 'FAIL';
  fs.writeFileSync(path.join(run, 'results.json'), JSON.stringify(report, null, 2) + '\n');
}
const passed = report.cases.filter((c) => c.status === 'PASS').length;
console.log(`llama_kv_snapshot_test: ${passed}/${report.cases.length} passed (real host; scripted llama-server and simulated runtime; no model); ${run}`);
process.exitCode = report.status === 'PASS' ? 0 : 1;

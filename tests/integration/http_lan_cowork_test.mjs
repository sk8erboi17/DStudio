// Cowork over the LAN, end to end on real sockets: the real native host and
// the real Cowork runtime (remote-model mode), driven from this machine's LAN
// address as another device would. The model is a SIMULATED OpenAI-compatible
// server; no weights. Checks pairing, token scope, the forced shared folder,
// pausing, revocation and what is stored.
//   node tests/integration/http_lan_cowork_test.mjs <dstudio-server-test> <ds4 dir with ds4-cowork>
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { freePort, sleep } from '../support/real_harness.mjs';

const server = path.resolve(process.argv[2] || 'tests/.build/dstudio-server-test');
const engine = path.resolve(process.argv[3] || 'ds4');
assert.ok(fs.existsSync(path.join(engine, 'ds4-cowork')), `${engine}/ds4-cowork is required (build it first); missing is not a pass`);
const root = path.resolve('tests/.artifacts/http-lan-cowork');
fs.mkdirSync(root, { recursive: true });
const run = fs.mkdtempSync(path.join(root, 'run-'));
const shared = path.join(run, 'shared-folder'), other = path.join(run, 'other-folder');
fs.mkdirSync(shared); fs.mkdirSync(other);
const receipt = { scope: 'Real host and Cowork runtime over the LAN address; simulated model server; no weights', cases: [] };
const children = [];

const model = http.createServer(async (req, res) => {
  for await (const _ of req) { /* drain */ }
  if (req.url.startsWith('/v1/models')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"data":[{"id":"fixture"}]}'); }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const chunk = (delta, finish) => `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  res.write(chunk({ role: 'assistant', content: 'Hello from the shared Cowork session.' }, null));
  res.end(chunk({}, 'stop') + 'data: [DONE]\n\n');
});
model.listen(0, '127.0.0.1'); await once(model, 'listening');

function request({ host, port, method = 'GET', path: p, headers = {}, body = null, localAddress }) {
  return new Promise((resolve, reject) => {
    if (body !== null) headers = { ...headers, 'content-length': Buffer.byteLength(body) };
    const req = http.request({ host, port, method, path: p, headers, localAddress, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (body !== null) req.write(body);
    req.end();
  });
}
async function check(name, fn) {
  try { await fn(); receipt.cases.push({ name, status: 'PASS' }); }
  catch (error) { receipt.cases.push({ name, status: 'FAIL', error: String(error.stack || error) }); process.exitCode = 1; }
}
const CSRF = { 'content-type': 'application/json', 'x-requested-with': 'ds4web' };

let host;
async function startHost(port, data) {
  const log = fs.openSync(path.join(run, `host-${children.length}.log`), 'w');
  const child = spawn(server, [String(port), engine], { stdio: ['ignore', log, log], env: { ...process.env,
    DS4UI_TEST_MODE: '1', DS4UI_NO_WINDOW: '1', DS4UI_DATA_DIR: data, HOME: path.join(run, 'home') } });
  fs.closeSync(log); children.push(child);
  for (let i = 0; i < 100; i++) {
    try { if ((await request({ host: '127.0.0.1', port, path: '/api/status' })).status === 200) return child; } catch { /* starting */ }
    await sleep(100);
  }
  throw new Error('host did not start');
}
try {
  const port = await freePort(), data = path.join(run, 'data');
  host = await startHost(port, data);
  const local = (method, p, value) => request({ host: '127.0.0.1', port, method, path: p, headers: CSRF, body: value === undefined ? null : JSON.stringify(value) });
  const json = (r) => JSON.parse(r.body);
  const lanOn = json(await local('POST', '/api/lan', { enable: true }));
  const lanIp = String(lanOn.lanAddr || '').replace(/:\d+$/, '');
  if (!lanOn.lan || !lanIp) throw Object.assign(new Error('LAN could not be enabled on this machine'), { blocked: true });
  const lan = (method, p, { token, value, headers = {} } = {}) => request({ host: lanIp, port, method, path: p, localAddress: lanIp,
    headers: { ...CSRF, ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: value === undefined ? null : JSON.stringify(value) });
  const startCowork = async (dir) => {
    const r = json(await local('POST', '/api/start', { mode: 'cowork', modelBackend: 'remote', remoteBaseUrl: `http://127.0.0.1:${model.address().port}`,
      remoteModel: 'fixture', workdir: dir, variant: 'flash' }));
    assert.ok(r.ok, JSON.stringify(r));
    for (let i = 0; i < 80; i++) { const st = json(await local('GET', '/api/status')); if (st.ready && st.mode === 'cowork') return; await sleep(250); }
    throw new Error('Cowork did not become ready');
  };
  const idle = async () => { for (let i = 0; i < 80; i++) { if (!json(await local('GET', '/api/status')).agentWorking) return; await sleep(250); } };

  await check('sharing needs Cowork running; LAN devices cannot enable it', async () => {
    assert.equal((await local('POST', '/api/lan/cowork', { enable: true })).status, 409);
    await startCowork(shared);
    assert.equal((await lan('POST', '/api/lan/cowork', { value: { enable: true } })).status, 403);
    assert.equal((await lan('GET', '/api/lan/cowork')).status, 403);
  });
  let code;
  await check('the host shares the running Cowork folder and shows a one-time code', async () => {
    const r = json(await local('POST', '/api/lan/cowork', { enable: true }));
    assert.equal(r.sharing, true);
    assert.equal(r.workdir, shared);
    assert.match(r.pairingCode, /^\d{8}$/);
    code = r.pairingCode;
  });
  await check('without a token a LAN device gets nothing', async () => {
    assert.equal((await lan('GET', '/api/lan/cowork/status')).status, 403);
    assert.equal((await lan('POST', '/api/agent/send', { value: { prompt: 'x', displayPrompt: 'x' } })).status, 403);
    assert.equal((await lan('GET', '/api/agent/poll?since=0')).status, 403);
    assert.equal((await lan('GET', '/api/agent/poll?since=0', { token: 'f'.repeat(64) })).status, 403);
  });
  await check('wrong codes void the code after five attempts; then a new code is needed', async () => {
    const wrong = code === '00000000' ? '00000001' : '00000000';
    for (let i = 0; i < 5; i++) assert.equal(json(await lan('POST', '/api/lan/cowork/pair', { value: { code: wrong, name: 'Tablet' } })).code, 'bad_code');
    assert.equal(json(await lan('POST', '/api/lan/cowork/pair', { value: { code, name: 'Tablet' } })).code, 'no_pairing', 'the right code no longer works');
    code = json(await local('POST', '/api/lan/cowork', { pair: true })).pairingCode;
  });
  let device;
  await check('pairing is single use and returns a device token', async () => {
    device = json(await lan('POST', '/api/lan/cowork/pair', { value: { code, name: 'Tablet' } }));
    assert.ok(device.ok);
    assert.match(device.token, /^[0-9a-f]{64}$/);
    assert.equal(json(await lan('POST', '/api/lan/cowork/pair', { value: { code, name: 'Second' } })).code, 'no_pairing');
    const stored = fs.readFileSync(path.join(data, 'lan-cowork-devices.json'), 'utf8');
    assert.ok(!stored.includes(device.token), 'the token itself is never stored');
    assert.equal(fs.statSync(path.join(data, 'lan-cowork-devices.json')).mode & 0o777, 0o600);
  });
  await check('a paired device drives the shared session', async () => {
    const st = await lan('GET', '/api/lan/cowork/status', { token: device.token });
    assert.equal(json(st).sharing, true);
    assert.equal(json(st).folder, 'shared-folder');
    assert.ok(!st.body.includes(run), 'the host path is not revealed');
    assert.equal((await lan('POST', '/api/agent/send', { token: device.token, value: { prompt: 'Say hello.', displayPrompt: 'Say hello.' } })).status, 200);
    await idle();
    const poll = json(await lan('GET', '/api/agent/poll?since=0', { token: device.token }));
    assert.match(poll.text, /Hello from the shared Cowork session\./);
  });
  await check('a device sends prompts only: no commands, control frames or goals', async () => {
    for (const value of [{ prompt: '/list', displayPrompt: '/list' }, { prompt: '  /del 1234', displayPrompt: 'x' },
      { prompt: 'hi\x1e{"type":"control","name":"think","value":"max"}', displayPrompt: 'hi' },
      { prompt: 'Plan the quarter', displayPrompt: 'Plan the quarter', orchestration: 'goal' }]) {
      const r = await lan('POST', '/api/agent/send', { token: device.token, value });
      assert.equal(r.status, 403, JSON.stringify(value));
      assert.equal(json(r).code, 'host_only');
    }
  });
  await check('uploads always land in the shared folder', async () => {
    const r = json(await lan('POST', '/api/cowork/attach-file', { token: device.token,
      value: { dir: other, name: 'notes.txt', data_uri: `data:text/plain;base64,${Buffer.from('from the tablet\n').toString('base64')}` } }));
    assert.ok(r.ok, JSON.stringify(r));
    assert.equal(fs.readFileSync(path.join(shared, r.name), 'utf8'), 'from the tablet\n');
    assert.deepEqual(fs.readdirSync(other), []);
  });
  await check('the token opens nothing else', async () => {
    for (const [method, p, value] of [['GET', '/api/store'], ['POST', '/api/start', { mode: 'agent' }], ['GET', '/api/status'],
      ['POST', '/api/lan/cowork', { enable: true }], ['GET', '/api/design/files'], ['POST', '/api/wipe', {}]])
      assert.equal((await lan(method, p, { token: device.token, value })).status, 403, `${method} ${p}`);
  });
  await check('sharing pauses when the host stops sharing or leaves the folder', async () => {
    await local('POST', '/api/lan/cowork', { enable: false });
    assert.equal(json(await lan('POST', '/api/agent/send', { token: device.token, value: { prompt: 'x', displayPrompt: 'x' } })).code, 'not_shared');
    assert.equal(json(await lan('GET', '/api/lan/cowork/status', { token: device.token })).sharing, false);
    await local('POST', '/api/lan/cowork', { enable: true });
    await startCowork(other);
    assert.equal(json(await lan('GET', '/api/agent/poll?since=0', { token: device.token })).code, 'not_shared', 'another folder is not shared');
  });
  await check('revoking a device ends its access', async () => {
    await startCowork(shared);
    await local('POST', '/api/lan/cowork', { enable: true });
    assert.equal((await lan('GET', '/api/lan/cowork/status', { token: device.token })).status, 200);
    const after = json(await local('POST', '/api/lan/cowork/revoke', { id: device.id }));
    assert.deepEqual(after.devices, []);
    assert.equal((await lan('GET', '/api/lan/cowork/status', { token: device.token })).status, 403);
  });
  await check('sharing is off again after a host restart; paired devices persist', async () => {
    code = json(await local('POST', '/api/lan/cowork', { pair: true })).pairingCode;
    const again = json(await lan('POST', '/api/lan/cowork/pair', { value: { code, name: 'Phone' } }));
    host.kill('SIGTERM'); await once(host, 'exit');
    host = await startHost(port, data);
    await local('POST', '/api/lan', { enable: true });
    const state = json(await local('GET', '/api/lan/cowork'));
    assert.equal(state.enabled, false);
    assert.deepEqual(state.devices.map((d) => d.name), ['Phone']);
    assert.equal(json(await lan('GET', '/api/lan/cowork/status', { token: again.token })).sharing, false);
  });
} catch (error) {
  receipt.error = String(error.stack || error);
  receipt.status = error.blocked ? 'BLOCKED' : 'FAIL';
  process.exitCode = 1;
} finally {
  for (const child of children) { try { child.kill('SIGTERM'); } catch { /* gone */ } }
  model.close();
  fs.writeFileSync(path.join(run, 'receipt.json'), JSON.stringify(receipt, null, 2));
  const passed = receipt.cases.filter((c) => c.status === 'PASS').length;
  for (const c of receipt.cases.filter((c) => c.status === 'FAIL')) console.log(`FAIL ${c.name}\n${c.error}`);
  if (receipt.error) console.log(receipt.error);
  console.log(`http_lan_cowork_test: ${receipt.status || (passed === receipt.cases.length ? 'ok' : 'FAIL')} ${passed}/${receipt.cases.length} (real host and Cowork runtime over the LAN address; simulated model); ${run}`);
}

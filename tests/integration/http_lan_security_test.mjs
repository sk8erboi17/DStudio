// The real native host as another device on the LAN sees it, plus the
// browser-facing boundaries of the host itself:
//  - web tools (http-probe, web-read) asked by a LAN device must never reach
//    the host's loopback services, by any spelling or through a redirect,
//    while ordinary LAN pages stay readable;
//  - DNS rebinding: a request whose Host names an unknown domain is refused;
//  - CORS is granted only to DStudio pages on loopback/private addresses;
//  - the LAN chat mirror needs the CSRF header and stays bounded.
// Requests reach the host from this machine's LAN address (non-loopback).
// No model, inference or external network; loopback/LAN fixtures only.
//   node tests/integration/http_lan_security_test.mjs tests/.build/dstudio-server-test
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { freePort, sleep } from '../support/real_harness.mjs';

const binary = path.resolve(process.argv[2] || 'tests/.build/dstudio-server-test');
const root = path.resolve('tests/.artifacts/http-lan-security');
fs.mkdirSync(root, { recursive: true });
const run = fs.mkdtempSync(path.join(root, 'run-'));
const receipt = { scope: 'Real native host over real sockets from the LAN address; loopback/LAN fixtures; no model', cases: [] };
const children = [], servers = [];

function request({ host, port, method = 'GET', path: p = '/', headers = {}, body = null, localAddress }) {
  return new Promise((resolve, reject) => {
    if (body !== null) headers = { ...headers, 'content-length': Buffer.byteLength(body) };
    const req = http.request({ host, port, method, path: p, headers, localAddress, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.setTimeout(90_000, () => req.destroy(new Error(`${method} ${p} got no reply`)));
    if (body) req.write(body);
    req.end();
  });
}

// A raw request, for header shapes http.request will not send (no Host, two Hosts).
function raw(port, text) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    let out = '';
    socket.on('data', (d) => { out += d; });
    socket.on('end', () => resolve(out));
    socket.on('error', reject);
    socket.write(text);
  });
}

function check(name, fn) {
  return fn().then(() => receipt.cases.push({ name, status: 'PASS' }),
    (error) => { receipt.cases.push({ name, status: 'FAIL', error: String(error.stack || error) }); process.exitCode = 1; });
}

let host, lanIp;
try {
  // The host's loopback-only "secret": any request reaching it is the failure.
  const canaryHits = [];
  const canary = http.createServer((req, res) => { canaryHits.push(req.url); res.end('loopback secret'); });
  canary.listen(0, '127.0.0.1'); await once(canary, 'listening'); servers.push(canary);
  const cport = canary.address().port;
  // A page on the LAN: what a LAN device may legitimately read through the host.
  const PAGE = '<html><head><title>Field notes</title></head><body><p>The lighthouse logbook lists every ship that passed the cape this winter.</p>' +
    `<p>Location: http://127.0.0.1:${cport}/body-is-not-a-header</p></body></html>`;
  const lanSite = http.createServer((req, res) => {
    const to = { '/redir-loopback': `http://127.0.0.1:${cport}/via-redirect`, '/redir-mapped': `http://[::ffff:127.0.0.1]:${cport}/via-mapped`,
      '/redir-relative': '/page', '/redir-chain': '/redir-loopback' }[req.url];
    if (to) { res.writeHead(302, { Location: to }); return res.end(); }
    res.writeHead(200, { 'content-type': 'text/html' }); res.end(PAGE);
  });
  const port = await freePort();
  const engine = path.join(run, 'empty-engine'); fs.mkdirSync(engine);
  const log = fs.openSync(path.join(run, 'host.log'), 'wx');
  host = spawn(binary, [String(port), engine], { stdio: ['ignore', log, log], env: { ...process.env,
    DS4UI_TEST_MODE: '1', DS4UI_NO_WINDOW: '1', DS4UI_DEFER_ENGINE_START: '1',
    DS4UI_DATA_DIR: path.join(run, 'profile'), HOME: path.join(run, 'home'), DS4UI_ALLOWED_HOSTS: 'dstudio.test, other.test' } });
  fs.closeSync(log); children.push(host);
  for (let i = 0; i < 100; i++) {
    try { if ((await request({ host: '127.0.0.1', port, path: '/api/status' })).status === 200) break; } catch { /* starting */ }
    await sleep(100);
  }
  const H = { 'content-type': 'application/json', 'x-requested-with': 'ds4web' };
  const local = (opts) => request({ host: '127.0.0.1', port, ...opts });
  const enabled = JSON.parse((await local({ method: 'POST', path: '/api/lan', headers: H, body: '{"enable":true}' })).body);
  // The address the host itself reports for LAN access (its lan_ip()).
  lanIp = String(enabled.lanAddr || '').replace(/:\d+$/, '');
  if (!enabled.ok || !enabled.lan || !net.isIPv4(lanIp))
    throw Object.assign(new Error(`LAN could not be enabled on this machine: ${JSON.stringify(enabled)}`), { blocked: true });
  lanSite.listen(0, lanIp); await once(lanSite, 'listening'); servers.push(lanSite);
  const site = `http://${lanIp}:${lanSite.address().port}`;
  const lan = (opts) => request({ host: lanIp, port, localAddress: lanIp, ...opts });
  const post = (p, value, headers = H) => lan({ method: 'POST', path: p, headers, body: JSON.stringify(value) });
  const json = (r) => JSON.parse(r.body.toString('utf8'));

  await check('the host sees these requests as coming from the LAN', async () => {
    assert.equal((await lan({ path: '/api/store' })).status, 403);
  });

  const LOOPBACK_SPELLINGS = [`http://127.0.0.1:${cport}/a`, `http://localhost:${cport}/b`, `http://localhost.:${cport}/c`,
    `http://2130706433:${cport}/d`, `http://127.1:${cport}/e`, `http://0x7f000001:${cport}/f`, `http://[::1]:${cport}/g`,
    `http://[::ffff:127.0.0.1]:${cport}/h`, `http://0.0.0.0:${cport}/i`, 'http://169.254.169.254/latest/meta-data/',
    `http://user@127.0.0.1:${cport}/j`, `http://127.0.0.1:${cport}@example.com/k`];
  for (const tool of ['/api/http-probe', '/api/web-read']) {
    await check(`${tool}: a LAN device cannot reach the host's loopback, any spelling`, async () => {
      for (const url of LOOPBACK_SPELLINGS) {
        const r = await post(tool, { url, method: 'GET' });
        assert.ok([400, 403].includes(r.status), `${url} -> ${r.status} ${r.body}`);
        assert.ok(!r.body.includes('loopback secret'), url);
      }
      assert.deepEqual(canaryHits, []);
    });
  }

  await check('/api/http-probe: a redirect to loopback is reported, not followed', async () => {
    const r = await post('/api/http-probe', { url: `${site}/redir-loopback`, method: 'GET' });
    const out = json(r);
    assert.equal(r.status, 200, r.body.toString());
    assert.equal(out.status, 302);
    assert.match(JSON.stringify(out), /via-redirect/, 'the Location is visible to the caller');
    assert.deepEqual(canaryHits, []);
  });
  await check('/api/http-probe: an ordinary LAN page is still probed', async () => {
    const out = json(await post('/api/http-probe', { url: `${site}/page`, method: 'GET' }));
    assert.equal(out.status, 200);
    assert.match(out.bodyExcerpt, /lighthouse logbook/);
  });
  await check('/api/web-read: redirects to loopback are refused at the hop', async () => {
    for (const p of ['/redir-loopback', '/redir-mapped', '/redir-chain']) {
      const r = await post('/api/web-read', { url: `${site}${p}` });
      assert.equal(r.status, 403, `${p}: ${r.body}`);
    }
    assert.deepEqual(canaryHits, []);
  });
  await check('/api/web-read: LAN pages are read, also through a checked redirect', async () => {
    for (const p of ['/page', '/redir-relative']) {
      const out = json(await post('/api/web-read', { url: `${site}${p}` }));
      assert.equal(out.ok, true, p);
      assert.equal(out.reader, 'curl');
      assert.match(out.markdown, /lighthouse logbook/);
    }
    assert.deepEqual(canaryHits, [], 'a "Location:" line in the page body is text, not a redirect');
  });
  await check('the host itself keeps full web tools (the canary is reachable from loopback)', async () => {
    const out = json(await local({ method: 'POST', path: '/api/http-probe', headers: H,
      body: JSON.stringify({ url: `http://127.0.0.1:${cport}/host-own`, method: 'GET' }) }));
    assert.equal(out.status, 200);
    assert.deepEqual(canaryHits, ['/host-own']);
  });

  await check('DNS rebinding: an unknown Host is refused before any API', async () => {
    for (const name of ['evil.example', `evil.example:${port}`, 'localhost.evil.example', '127.0.0.1.nip.io'])
      assert.equal((await local({ path: '/api/status', headers: { host: name } })).status, 421, name);
    const store = await local({ method: 'POST', path: '/api/store', headers: { ...H, host: `evil.example:${port}` }, body: '{"x":1}' });
    assert.equal(store.status, 421);
    for (const name of [`127.0.0.1:${port}`, `localhost:${port}`, 'app.localhost', `[::1]:${port}`, `${lanIp}:${port}`,
      `${os.hostname().replace(/\.local$/i, '')}.local:${port}`, 'dstudio.test', `Other.Test:${port}`, 'dstudio.test.'])
      assert.equal((await local({ path: '/api/status', headers: { host: name } })).status, 200, name);
    const twoHosts = await raw(port, `GET /api/status HTTP/1.1\r\nHost: 127.0.0.1\r\nHost: evil.example\r\nConnection: close\r\n\r\n`);
    assert.match(twoHosts, /^HTTP\/1\.1 421/);
    const noHost = await raw(port, 'GET /api/status HTTP/1.0\r\n\r\n');
    assert.match(noHost, /^HTTP\/1\.1 200/);
  });

  await check('CORS: granted only to DStudio pages on loopback/private addresses', async () => {
    const grant = async (origin, p = '/v1/chat/completions', method = 'OPTIONS') =>
      (await lan({ method, path: p, headers: { origin, 'access-control-request-method': 'POST' } })).headers['access-control-allow-origin'];
    for (const origin of ['http://127.0.0.1:5500', 'http://localhost:5600', 'http://192.168.1.20:5500', 'http://10.0.0.7',
      'http://172.20.1.1:5500', 'http://100.101.102.103:5500', 'http://[::1]:5500', 'http://dstudio.test:5500'])
      assert.equal(await grant(origin), origin, origin);
    for (const origin of ['https://evil.example', 'http://203.0.113.9', 'null', 'http://172.32.0.1', 'http://127.0.0.1.evil.example',
      'file://', 'http://localhost.evil.example'])
      assert.equal(await grant(origin), undefined, origin);
    assert.equal(await grant('https://evil.example', '/api/lan-health', 'GET'), undefined);
    assert.equal(await grant('http://192.168.1.20:5500', '/api/lan-health', 'GET'), 'http://192.168.1.20:5500');
    assert.equal(await grant('https://evil.example', '/api/web-read', 'OPTIONS'), undefined);
  });

  const snapshot = (id, extra = '') => ({ v: 1, clientId: id, clientName: id, chats: [{ id: 'c', mode: 'chat', messages: [{ role: 'user', content: 'hi' + extra }] }] });
  const mirrored = async () => json(await local({ path: '/api/lan-client/chats' })).clients.map((c) => c.clientId);
  await check('LAN chat mirror: a cross-site "simple" POST without the CSRF header is refused', async () => {
    const r = await post('/api/lan-client/chats', snapshot('client-no-header'), { 'content-type': 'text/plain' });
    assert.equal(r.status, 403);
    assert.deepEqual(await mirrored(), []);
    assert.equal((await post('/api/lan-client/chats', snapshot('client-a'))).status, 200);
    assert.deepEqual(await mirrored(), ['client-a']);
  });
  await check('LAN chat mirror: at most 32 devices, the least recently published leaves first', async () => {
    for (let i = 0; i < 40; i++) assert.equal((await post('/api/lan-client/chats', snapshot(`client-n${i}`))).status, 200);
    assert.equal((await post('/api/lan-client/chats', snapshot('client-n8', ' again'))).status, 200); // n8 republished: newest
    assert.equal((await post('/api/lan-client/chats', snapshot('client-n40'))).status, 200);
    const ids = await mirrored();
    assert.equal(ids.length, 32);
    assert.ok(ids.includes('client-n8') && ids.includes('client-n40') && !ids.includes('client-a') && !ids.includes('client-n9'), ids.join(','));
  });
  await check('LAN chat mirror: at most 256 MiB retained', async () => {
    const big = 'x'.repeat(15 * 1024 * 1024);
    for (let i = 0; i < 18; i++) assert.equal((await post('/api/lan-client/chats', snapshot(`client-big${i}`, big))).status, 200);
    const all = (await local({ path: '/api/lan-client/chats' })).body;
    assert.ok(all.length <= 256 * 1024 * 1024 + 4096, `${all.length} bytes retained`);
    const kept = [...Array(18).keys()].filter((i) => all.includes(`"clientId":"client-big${i}"`));
    assert.ok(kept.length >= 16 && kept.includes(17) && !kept.includes(0), `kept ${kept}`);
  });
} catch (error) {
  receipt.error = String(error.stack || error);
  receipt.status = error.blocked ? 'BLOCKED' : 'FAIL';
  process.exitCode = 1;
} finally {
  for (const s of servers) s.close();
  for (const c of children) { try { c.kill('SIGTERM'); } catch { /* gone */ } }
  if (host && host.exitCode === null) await Promise.race([once(host, 'exit'), sleep(5000)]);
  fs.writeFileSync(path.join(run, 'receipt.json'), JSON.stringify(receipt, null, 2));
  const passed = receipt.cases.filter((c) => c.status === 'PASS').length;
  for (const c of receipt.cases.filter((c) => c.status === 'FAIL')) console.log(`FAIL ${c.name}\n${c.error}`);
  if (receipt.error) console.log(`${receipt.status}: ${receipt.error}`);
  console.log(`http_lan_security_test: ${receipt.status || (passed === receipt.cases.length ? 'ok' : 'FAIL')} ${passed}/${receipt.cases.length} checks (real host, real sockets from ${lanIp || 'no LAN address'}; no model); ${run}`);
}

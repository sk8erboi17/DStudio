// Blueprint (Agent mode) in a real browser against the REAL host workspace
// handlers (tests/support/agent_workspace_host.c → src/dstudio_agent_workspace.c,
// plus the real /api/fs/mkdir) on a task-owned workspace. The Agent stream is
// SIMULATED in the ds4-agent-jsonl event format, and the test performs the
// write's file effect itself. It checks the production prompt and file path,
// the diagram building live from the streamed JSON, citation verification
// against the workspace bytes, trace/route/lens/find, opening a citation in
// the IDE, the standalone HTML export, a sequence diagram, an invalid file and
// persistence. No model or inference runs (see tests/live/blueprint_live_test.mjs).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { chromium, webkit } from 'playwright';
import { uiMockServer, jsonReply, requestBody, seedUi } from '../support/ui_mock_server.mjs';

const browserName = process.env.DSTUDIO_TEST_BROWSER || 'chromium';
assert.ok(['chromium', 'webkit'].includes(browserName));
const hostBinary = path.resolve(process.argv[2] || 'tests/.build/agent_workspace_host');
fs.mkdirSync('tests/.artifacts/ui-blueprint', { recursive: true });
const dir = fs.mkdtempSync(`tests/.artifacts/ui-blueprint/${browserName}-`);
const workspace = path.resolve(dir, 'shop');
fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
const SERVER_JS = "const http = require('http');\nconst { createOrder } = require('./orders');\n\n"
  + 'const server = http.createServer(async (req, res) => {\n'
  + "  if (req.method === 'POST' && req.url === '/orders') {\n"
  + '    const order = await createOrder(JSON.parse(await body(req)));\n'
  + '    res.end(JSON.stringify(order));\n  }\n});\nserver.listen(8080);\n';
const ORDERS_JS = "const db = require('./db');\nconst payments = require('./payments');\n\n"
  + 'async function createOrder(input) {\n  await payments.charge(input.card, input.total);\n'
  + '  return db.insertOrder(input);\n}\nmodule.exports = { createOrder };\n';
const DB_JS = "const { Pool } = require('pg');\nconst pool = new Pool();\nasync function insertOrder(o) {\n"
  + "  return pool.query('INSERT INTO orders VALUES ($1)', [o]);\n}\nmodule.exports = { insertOrder };\n";
fs.writeFileSync(path.join(workspace, 'src/server.js'), SERVER_JS);
fs.writeFileSync(path.join(workspace, 'src/orders.js'), ORDERS_JS);
fs.writeFileSync(path.join(workspace, 'src/db.js'), DB_JS);
const receipt = { scope: 'Real browser, real host workspace handlers; Agent stream and file effects simulated; no inference', browserName, cases: [] };

// The spec the simulated Agent writes. Its citations cover every outcome:
// verified, at another line ("moved"), missing file, quote not in the file,
// and no citation at all.
const SPEC = {
  schema: 'dstudio.blueprint/1', kind: 'architecture', title: 'Order service', summary: 'How an order is accepted and stored.',
  groups: [{ id: 'api', label: 'API' }, { id: 'domain', label: 'Domain' }, { id: 'data', label: 'Data' }],
  nodes: [
    { id: 'server', label: 'HTTP server', type: 'service', group: 'api', description: 'Accepts POST /orders.',
      sources: [{ path: 'src/server.js', lines: [4, 5], quote: 'const server = http.createServer(async (req, res) => {' }] },
    { id: 'orders', label: 'Orders', type: 'module', group: 'domain', description: 'Charges the card, then stores the order.',
      sources: [{ path: 'src/orders.js', lines: [4, 4], quote: 'async function createOrder(input) {' },
        { path: 'src/orders.js', lines: [1, 1], quote: 'module.exports = { createOrder };' }] },
    { id: 'payments', label: 'Payments', type: 'external', group: 'domain', description: 'Card charges.',
      sources: [{ path: 'src/payments.js', lines: [1, 3], quote: 'function charge(' }] },
    { id: 'db', label: 'Database', type: 'store', group: 'data', description: 'Postgres pool.',
      sources: [{ path: 'src/db.js', lines: [1, 2], quote: 'const pool = new Pool({ max: 10 });' }] },
  ],
  edges: [
    { from: 'server', to: 'orders', label: 'createOrder', type: 'call', sources: [{ path: 'src/server.js', lines: [6, 6], quote: 'const order = await createOrder(JSON.parse(await body(req)));' }] },
    { from: 'orders', to: 'payments', label: 'charge', type: 'call', sources: [{ path: 'src/orders.js', lines: [5, 5], quote: 'await payments.charge(input.card, input.total);' }] },
    { from: 'orders', to: 'db', label: 'insertOrder', type: 'data', sources: [{ path: 'src/orders.js', lines: [6, 6], quote: 'return db.insertOrder(input);' }] },
    { from: 'db', to: 'orders', label: 'rows', type: 'data' },
  ],
  open_questions: ['Is the payment provider retried on failure?'],
};
const SPEC_TEXT = JSON.stringify(SPEC, null, 1);

// ---------- real host handlers ----------
const host = spawn(hostBinary, [workspace], { stdio: ['pipe', 'pipe', 'pipe'] });
let hostOut = '', hostLog = '';
const hostLines = [];
host.stdout.on('data', (d) => {
  hostOut += d;
  const lines = hostOut.split('\n'); hostOut = lines.pop();
  for (const l of lines) { hostLines.push(l); hostLog += l + '\n'; }
});
host.stderr.on('data', (d) => { hostLog += d; });
const waitLine = async (pred, what) => {
  const deadline = Date.now() + 10000;
  for (;;) {
    const i = hostLines.findIndex(pred);
    if (i >= 0) return hostLines.splice(i, 1)[0];
    if (Date.now() > deadline || host.exitCode != null) throw Error(`host did not report ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
};
const hostPort = Number((await waitLine((l) => l.startsWith('PORT '), 'its port')).slice(5));
async function hostWorking(on) {
  host.stdin.write(`working ${on ? 1 : 0}\n`);
  await waitLine((l) => l === 'ok', 'the working acknowledgement');
}

const RS = '\x1e';
const ev = (o) => RS + JSON.stringify(o) + '\n';
let raw = '', working = false, mode = 'server', runtimeDir = workspace;
const sends = [], requests = [], starts = [], sessions = [];
const server = await uiMockServer(async (req, res, url) => {
  if (url.pathname.startsWith('/api/agent/fs/') || url.pathname === '/api/fs/mkdir') {
    const body = Buffer.concat(await (async () => { const c = []; for await (const x of req) c.push(x); return c; })());
    const headers = { 'Content-Type': 'application/json' };
    if (req.headers['x-requested-with']) headers['X-Requested-With'] = req.headers['x-requested-with'];
    const r = await fetch(`http://127.0.0.1:${hostPort}${url.pathname}`, { method: req.method, headers, body });
    const text = await r.text();
    requests.push({ path: url.pathname, status: r.status, body: body.toString('utf8').slice(0, 300) });
    res.writeHead(r.status, { 'content-type': 'application/json' });
    res.end(text);
    return true;
  }
  if (url.pathname === '/api/status') {
    jsonReply(res, { mode, running: true, ready: true, loadPct: 100, stage: 'Ready (simulated)',
      agentWorking: working, agentSessionWorking: false, nativeVisionActive: true, workdir: runtimeDir,
      ds4dirOk: true, webdirOk: true, lan: false, modelFile: 'gguf/DeepSeek-V4-Flash-Vision-Exp-test.gguf',
      config: { ctx: 65536, power: 100 }, variant: 'flash', variants: { flash: true } });
    return true;
  }
  if (url.pathname === '/api/start') {
    const b = await requestBody(req);
    starts.push({ mode: b.mode, workdir: b.workdir || '' });
    mode = b.mode || 'server';
    runtimeDir = b.workdir || workspace;
    jsonReply(res, { ok: true });
    return true;
  }
  if (url.pathname === '/api/design/session') { const b = await requestBody(req); sessions.push({ mode, ...b }); jsonReply(res, { ok: true }); return true; }
  if (url.pathname === '/api/design/state') { jsonReply(res, { ok: true, state: { seq: 1, phase: 'idle' } }); return true; }
  if (url.pathname === '/api/design/events') { jsonReply(res, { ok: true, events: [] }); return true; }
  if (url.pathname === '/api/design/artifacts') { jsonReply(res, { ok: true, artifacts: [] }); return true; }
  if (url.pathname === '/api/fs/list') { const b = await requestBody(req); jsonReply(res, { ok: true, path: b.path || workspace, entries: 1, dirs: ['src'] }); return true; }
  if (url.pathname === '/api/user-skills') { jsonReply(res, { ok: true, skills: [] }); return true; }
  if (url.pathname === '/api/design-systems') { jsonReply(res, { ok: true, designSystems: [] }); return true; }
  if (url.pathname === '/api/updates/check') { jsonReply(res, { ok: true, sections: [] }); return true; }
  if (url.pathname === '/api/task-graphs') { jsonReply(res, { ok: true, graphs: [] }); return true; }
  if (url.pathname === '/api/agent/poll') {
    const bytes = Buffer.from(raw), since = Number(url.searchParams.get('since')) || 0;
    jsonReply(res, { base: 0, len: bytes.length, text: bytes.subarray(since).toString('utf8'), working,
      sessionWorking: false, ready: true, loadPct: 100 });
    return true;
  }
  if (url.pathname === '/api/agent/interrupt') { working = false; jsonReply(res, { ok: true }); return true; }
  if (url.pathname === '/api/agent/send') {
    const b = await requestBody(req);
    sends.push(b);
    raw += `\x01USER\x02${b.displayPrompt}\x01ENDUSER\x02\n`;
    working = true;
    jsonReply(res, { ok: true, from: 0, at: Buffer.byteLength(raw) });
    return true;
  }
  return false;
});

const now = Date.now();
const seed = { theme: 'dark', settings: { workdirs: { agent: workspace } },
  chats: [{ id: 'bp-agent', mode: 'agent', title: 'Blueprint fixture', createdAt: now, updatedAt: now, messages: [], transcript: '', workdir: workspace }] };
const browser = await ({ chromium, webkit })[browserName].launch();
const context = await browser.newContext({ viewport: { width: 1360, height: 860 }, acceptDownloads: true });
const page = await context.newPage();
page.setDefaultTimeout(8000);
const evidence = await seedUi(page, server.origin, seed);
let shot = 0;
const capture = (name) => page.screenshot({ path: path.join(dir, `${String(shot++).padStart(2, '0')}-${name}.png`) });
const until = (fn, arg) => page.waitForFunction(fn, arg, { timeout: 8000 });
async function step(name, fn) {
  const row = { name };
  try { await fn(row); row.status = 'PASS'; }
  catch (error) { row.status = 'FAIL'; row.error = error.stack; process.exitCode = 1; await capture(`fail-${name.replace(/\W+/g, '-')}`).catch(() => {}); }
  receipt.cases.push(row);
  console.log(`${row.status} ${name}${row.error ? `\n${row.error}` : ''}`);
  if (row.status === 'FAIL') throw Error(`stopped after: ${name}`);
}
const nodeStatus = () => page.evaluate(() => Object.fromEntries([...document.querySelectorAll('#bp-canvas .bp-node')].map((n) => [n.dataset.node, n.dataset.status])));
const onNodes = () => page.evaluate(() => [...document.querySelectorAll('#bp-canvas .bp-node.is-on')].map((n) => n.dataset.node).sort());
const clickNode = (id) => page.locator(`#bp-canvas .bp-node[data-node="${id}"] .bp-box`).click();
// The drawing's on-screen size must be its own size times the shown zoom:
// nothing else (e.g. a page-wide max-width on SVG) may scale it.
const geometry = () => page.evaluate(() => {
  const svg = document.querySelector('#bp-canvas .bp-svg');
  const stage = document.querySelector('#bp-stage').getBoundingClientRect();
  const r = svg.getBoundingClientRect();
  const k = parseFloat(document.querySelector('#bp-zval').textContent) / 100;
  return { k, drawn: r.width, expected: svg.viewBox.baseVal.width * k,
    inside: r.left >= stage.left - 1 && r.right <= stage.right + 1 && r.top >= stage.top - 1 && r.bottom <= stage.bottom + 1 };
});

let rel = '';
try {
  await page.goto(server.origin);

  await step('Open Blueprint sits beside Open IDE in Agent mode only', async () => {
    assert.equal(await page.locator('#btn-blueprint').isVisible(), false, 'not offered in Chat');
    await page.locator('#tab-agent').click();
    const dialog = page.locator('#workdir-dialog'); await dialog.waitFor();
    await dialog.getByRole('button', { name: /^(Start|Launch)/ }).click();
    await page.locator('#loading-overlay').waitFor({ state: 'hidden' });
    await page.locator('#btn-blueprint').waitFor({ state: 'visible' });
    assert.equal((await page.locator('#btn-blueprint').innerText()).trim(), 'Open Blueprint');
    const [ide, bp] = await Promise.all([page.locator('#btn-agent-ide').boundingBox(), page.locator('#btn-blueprint').boundingBox()]);
    assert.ok(Math.abs(ide.y - bp.y) < 4 && bp.x > ide.x && bp.x - (ide.x + ide.width) < 24, 'next to Open IDE');
    await page.locator('#btn-blueprint').click();
    await page.locator('#blueprint').waitFor({ state: 'visible' });
    // With nothing to show, the stage is the new-map card itself.
    await page.locator('#bp-newcard h3', { hasText: 'What should we map?' }).waitFor();
    assert.equal(await page.locator('#bp-new-close').isVisible(), false, 'nothing behind the card to return to');
    await page.locator('#bp-list .bp-list-msg', { hasText: 'No blueprints in this workspace yet' }).waitFor();
    assert.equal(await page.locator('#composer-input').isVisible(), false, 'Blueprint takes over the pane');
    assert.equal((await page.locator('#bp-map-label').innerText()).trim(), 'Map it with DeepSeek');
    await capture('empty');
  });

  await step('Map it sends the production prompt and prepares .dstudio/blueprints', async (row) => {
    await page.locator('[data-bp-kind="architecture"]').click();
    await page.locator('#bp-focus').fill('how an order is stored');
    await page.locator('#bp-map').click();
    await until(() => document.querySelector('#bp-empty h3')?.textContent.includes('is reading the code'));
    assert.equal(await page.locator('#bp-newcard').isVisible(), false);
    // The send is dispatched asynchronously: wait for the request itself.
    for (const deadline = Date.now() + 8000; sends.length < 1;) {
      assert.ok(Date.now() < deadline, 'the Agent send never arrived');
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(sends.length, 1);
    const sent = sends[0];
    assert.equal(sent.displayPrompt, 'Blueprint · Architecture · how an order is stored');
    const m = sent.prompt.match(/write tool call to (\.dstudio\/blueprints\/architecture-how-an-order-is-stored-\d{8}-\d{6}\.json)/);
    assert.ok(m, `the prompt names the file: ${sent.prompt.slice(0, 200)}`);
    rel = m[1];
    row.rel = rel;
    assert.match(sent.prompt, /DStudio checks every quote against the file/);
    assert.match(sent.prompt, /"schema": "dstudio\.blueprint\/1", "kind": "architecture"/);
    assert.ok(fs.statSync(path.join(workspace, '.dstudio/blueprints')).isDirectory(), 'the folder exists before the Agent writes');
    assert.ok(requests.filter((r) => r.path === '/api/fs/mkdir' && r.status === 200).length >= 2);
    await hostWorking(true);
    await until(() => document.querySelector('#bp-map').disabled && /is working/.test(document.querySelector('#bp-map-label').textContent));
    await page.locator('#bp-list .bp-file.is-pending').waitFor();
  });

  await step('the diagram builds live from the streamed JSON', async (row) => {
    raw += ev({ type: 'reasoning_start' }) + 'Leggo server.js e orders.js. ' + ev({ type: 'reasoning_end' })
      + ev({ type: 'tool_call_begin', name: 'write' }) + '🛠️ write ' + ev({ type: 'tool_call_param', param: 'path', path: '' })
      + ` path=${rel}` + ev({ type: 'tool_call_param', param: 'content', path: rel });
    const counts = [];
    const cut1 = SPEC_TEXT.indexOf('"id": "orders"');
    raw += ev({ type: 'tool_body_delta', text: SPEC_TEXT.slice(0, cut1) });
    await until(() => document.querySelectorAll('#bp-canvas .bp-node').length === 1);
    counts.push(1);
    await page.locator('#bp-live', { hasText: 'DeepSeek is writing · 1 node, 0 relationships' }).waitFor();
    await capture('live-1');
    const cut2 = SPEC_TEXT.indexOf('"edges"');
    raw += ev({ type: 'tool_body_delta', text: SPEC_TEXT.slice(cut1, cut2) });
    await until(() => document.querySelectorAll('#bp-canvas .bp-node').length === 4);
    counts.push(4);
    raw += ev({ type: 'tool_body_delta', text: SPEC_TEXT.slice(cut2, SPEC_TEXT.length - 40) });
    await until(() => document.querySelectorAll('#bp-canvas .bp-edge').length >= 3);
    row.liveCounts = counts;
    assert.equal(await page.locator('#bp-evidence').isVisible(), false, 'no evidence claim while streaming');
    assert.equal(fs.existsSync(path.join(workspace, rel)), false, 'still only in the stream');
    await capture('live-edges');
    raw += ev({ type: 'tool_body_delta', text: SPEC_TEXT.slice(SPEC_TEXT.length - 40) })
      + ev({ type: 'tool_call', name: 'write', input: { path: rel, content: SPEC_TEXT.slice(0, 200) } });
    fs.writeFileSync(path.join(workspace, rel), SPEC_TEXT);
    raw += ev({ type: 'tool_result', name: 'write', output: `Wrote ${SPEC_TEXT.length} bytes to ${rel}` });
    await page.locator('#bp-live').waitFor({ state: 'hidden' });
    raw += 'Mappa salvata: quattro componenti; resta da capire il retry dei pagamenti.\n';
    working = false;
    await hostWorking(false);
  });

  await step('every citation is checked against the workspace bytes', async (row) => {
    await page.locator('#bp-evidence', { hasText: '5/8 claims verified' }).waitFor();
    assert.equal(await page.locator('#bp-evidence').getAttribute('data-st'), 'partial');
    row.status_ = await nodeStatus();
    assert.deepEqual(row.status_, { server: 'verified', orders: 'partial', payments: 'unverified', db: 'unverified' });
    const edgeStatus = await page.evaluate(() => [...document.querySelectorAll('#bp-canvas .bp-edge')].map((e) => e.dataset.status));
    assert.deepEqual(edgeStatus, ['verified', 'verified', 'verified', 'unsourced']);
    await page.locator('#bp-inspect', { hasText: '5 of 8 claims are backed by a quote found in the code; 1 quote at another line; 2 citations could not be found' }).waitFor();
    assert.equal((await page.locator('#bp-name').innerText()).trim(), 'Order service');
    assert.equal(await page.locator('#bp-list .bp-file.is-on .bp-file-t').innerText(), 'Order service');
    await page.locator('#bp-inspect', { hasText: 'Is the payment provider retried on failure?' }).waitFor();
    const g = await geometry();
    assert.ok(Math.abs(g.drawn - g.expected) <= 2, `drawn at ${g.drawn}px, expected ${g.expected}px`);
    assert.ok(g.inside, 'a small blueprint fits the canvas');
    await capture('verified');
  });

  await step('a node shows its evidence, neighbours, downstream and upstream reach', async () => {
    await clickNode('orders');
    await page.locator('#bp-inspect .bp-i-title', { hasText: 'Orders' }).waitFor();
    assert.equal(await page.locator('#bp-inspect .bp-badge').innerText(), 'Partly verified');
    assert.deepEqual(await page.locator('#bp-inspect .bp-cite').evaluateAll((ns) => ns.map((n) => `${n.dataset.st}:${n.querySelector('.bp-cite-st').textContent}`)),
      ['verified:quote found at the cited lines', 'moved:quote found at another line (line 8)']);
    assert.deepEqual(await onNodes(), ['db', 'orders', 'payments', 'server'], 'focus lights the node and its neighbours');
    await page.locator('#bp-inspect [data-act="up"]').click();
    assert.deepEqual(await onNodes(), ['db', 'orders', 'server'], 'upstream follows stated relationships backwards');
    await clickNode('payments');
    await page.locator('#bp-inspect [data-act="down"]').click();
    assert.deepEqual(await onNodes(), ['payments'], 'payments reaches nothing downstream');
  });

  await step('a route follows only stated relationships', async () => {
    await page.keyboard.press('Escape');
    await clickNode('server');
    await page.locator('#bp-inspect [data-act="route"]').click();
    await page.locator('#bp-routebar').waitFor();
    await clickNode('db');
    await page.locator('#bp-inspect .bp-i-title', { hasText: '2 steps' }).waitFor();
    assert.deepEqual(await page.locator('#bp-inspect .bp-i-route li').allInnerTexts(), ['HTTP server createOrder Orders', 'Orders insertOrder Database']);
    assert.deepEqual(await onNodes(), ['db', 'orders', 'server']);
    await page.locator('#bp-inspect [data-act="clear"]').click();
    await clickNode('payments');
    await page.locator('#bp-inspect [data-act="route"]').click();
    await clickNode('server');
    await page.locator('#bp-inspect .bp-i-title', { hasText: 'No route' }).waitFor();
    await page.locator('#bp-inspect [data-act="clear"]').click();
  });

  await step('lens and find work on the drawing without changing the spec', async () => {
    await page.keyboard.press('Escape');
    await page.locator('#bp-inspect .bp-chip', { hasText: 'Data' }).click();
    assert.equal(await page.locator('#bp-canvas .bp-node[data-node="db"]').isVisible(), false);
    assert.equal(await page.locator('#bp-canvas .bp-edge[data-to="db"]').isVisible(), false);
    await page.locator('#bp-inspect .bp-chip', { hasText: 'Data' }).click();
    assert.equal(await page.locator('#bp-canvas .bp-node[data-node="db"]').isVisible(), true);
    await page.locator('#bp-find').fill('postgres');
    await until(() => document.querySelector('#bp-canvas .bp-node[data-node="db"]').classList.contains('is-match'));
    await page.locator('#bp-find').press('Enter');
    await page.locator('#bp-inspect .bp-i-title', { hasText: 'Database' }).waitFor();
    await page.locator('#bp-find').fill('');
    assert.equal(fs.readFileSync(path.join(workspace, rel), 'utf8'), SPEC_TEXT, 'viewing never rewrites the file');
  });

  await step('a citation opens in the IDE at its lines and Back returns to Blueprint', async () => {
    await clickNode('orders');
    await page.locator('#bp-inspect .bp-cite-open').first().click();
    await page.locator('#agent-ide').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#blueprint').isVisible(), false);
    await until(() => {
      const ta = document.querySelector('#ide-input');
      return ta.value.includes('createOrder') && ta.value.slice(ta.selectionStart, ta.selectionEnd) === 'async function createOrder(input) {';
    });
    assert.match(await page.locator('#ide-back').innerText(), /Blueprint/);
    await capture('ide-reveal');
    await page.locator('#ide-back').click();
    await page.locator('#blueprint').waitFor({ state: 'visible' });
    await page.locator('#bp-evidence', { hasText: '5/8 claims verified' }).waitFor();
    assert.match(await page.locator('#ide-back').innerText(), /Chat/);
  });

  await step('Export writes a standalone interactive HTML page', async (row) => {
    await page.locator('#bp-export').click();
    const [download] = await Promise.all([page.waitForEvent('download'), page.locator('[data-export="html"]').click()]);
    const file = path.join(dir, 'export.html');
    await download.saveAs(file);
    row.filename = download.suggestedFilename();
    assert.match(row.filename, /^architecture-how-an-order-is-stored-\d{8}-\d{6}\.html$/);
    const html = fs.readFileSync(file, 'utf8');
    assert.ok(!/<script[^>]+src=|<link[^>]+href=|https?:\/\//.test(html.replace(/xmlns="http:\/\/www\.w3\.org\/2000\/svg"/g, '')), 'no external resources');
    const viewer = await context.newPage();
    const errors = [];
    viewer.on('pageerror', (e) => errors.push(e.message));
    await viewer.goto(pathToFileURL(file).href);
    assert.equal(await viewer.title(), 'Order service');
    assert.equal(await viewer.locator('.bp-node').count(), 4);
    assert.match(await viewer.locator('header').innerText(), /5 of 8 claims backed by a quote/);
    await viewer.locator('.bp-node[data-node="orders"] .bp-box').click();
    assert.deepEqual(await viewer.evaluate(() => [...document.querySelectorAll('.bp-node.is-on')].map((n) => n.dataset.node).sort()), ['db', 'orders', 'payments']);
    await viewer.locator('#info h2', { hasText: 'Orders' }).waitFor();
    await viewer.screenshot({ path: path.join(dir, 'export.png') });
    assert.deepEqual(errors, []);
    await viewer.close();
  });

  await step('+ New opens the card over the drawing and Esc returns to it', async () => {
    await page.locator('#bp-new-btn').click();
    await page.locator('#bp-newcard').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#bp-new-close').isVisible(), true);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'bp-focus');
    await page.locator('[data-bp-kind="sequence"]').click();
    assert.match(await page.locator('#bp-kind-hint').innerText(), /message by message/);
    await capture('new-card');
    await page.keyboard.press('Escape');
    await page.locator('#bp-newcard').waitFor({ state: 'hidden' });
    await page.locator('#bp-new-btn').click();
    await page.locator('#bp-new-close').click();
    await page.locator('#bp-newcard').waitFor({ state: 'hidden' });
    assert.equal(await page.locator('#bp-canvas .bp-node').count(), 4, 'the drawing stayed');
  });

  await step('a large blueprint opens at a readable zoom and Fit shows all of it', async (row) => {
    const big = { schema: 'dstudio.blueprint/1', kind: 'architecture', title: 'Wide chain',
      nodes: Array.from({ length: 14 }, (_, i) => ({ id: `n${i}`, label: `Component number ${i + 1}`, type: 'module' })),
      edges: Array.from({ length: 13 }, (_, i) => ({ from: `n${i}`, to: `n${i + 1}`, label: 'calls' })) };
    fs.writeFileSync(path.join(workspace, '.dstudio/blueprints/wide-chain.json'), JSON.stringify(big));
    await page.locator('#bp-refresh').click();
    await page.locator('#bp-list [data-file$="wide-chain.json"]').click();
    await page.locator('#bp-name', { hasText: 'Wide chain' }).waitFor();
    const opened = await geometry();
    row.opened = opened;
    assert.ok(opened.k >= 0.55, `opened at ${opened.k}`);
    assert.ok(Math.abs(opened.drawn - opened.expected) <= 2);
    const first = await page.locator('#bp-canvas .bp-node[data-node="n0"]').boundingBox();
    const stage = await page.locator('#bp-stage').boundingBox();
    assert.ok(first.x >= stage.x && first.y >= stage.y && first.x + first.width <= stage.x + stage.width, 'the start is in view');
    await page.locator('#bp-fit').click();
    const fitted = await geometry();
    row.fitted = fitted;
    assert.ok(fitted.inside && fitted.k < opened.k, 'Fit shows the whole drawing');
    await capture('wide-fit');
  });

  await step('a sequence blueprint draws lifelines and numbered steps', async () => {
    const seq = { schema: 'dstudio.blueprint/1', kind: 'sequence', title: 'Place an order',
      nodes: [{ id: 'client', label: 'Client', type: 'client' }, { id: 'server', label: 'HTTP server', type: 'service' }, { id: 'orders', label: 'Orders', type: 'module' }],
      steps: [{ from: 'client', to: 'server', label: 'POST /orders' },
        { from: 'server', to: 'orders', label: 'createOrder()', sources: [{ path: 'src/server.js', lines: [6, 6], quote: 'await createOrder(JSON.parse' }] },
        { from: 'orders', to: 'orders', label: 'charge card' },
        { from: 'orders', to: 'server', label: 'order', type: 'return' },
        { from: 'server', to: 'client', label: '200 JSON', type: 'return' }] };
    fs.writeFileSync(path.join(workspace, '.dstudio/blueprints/sequence-place-order.json'), JSON.stringify(seq));
    await page.locator('#bp-refresh').click();
    await page.locator('#bp-list [data-file$="sequence-place-order.json"]').click();
    await page.locator('#bp-name', { hasText: 'Place an order' }).waitFor();
    assert.equal(await page.locator('#bp-canvas .bp-lifeline').count(), 3);
    assert.deepEqual(await page.locator('#bp-canvas .bp-step-n').allTextContents(), ['1', '2', '3', '4', '5']);
    await page.locator('#bp-evidence', { hasText: '1/8 claims verified' }).waitFor();
    await clickNode('client');
    await page.locator('#bp-inspect [data-act="route"]').click();
    await clickNode('orders');
    await page.locator('#bp-inspect .bp-i-title', { hasText: '2 steps' }).waitFor();
    await capture('sequence');
  });

  await step('an invalid file is reported, not drawn', async () => {
    fs.writeFileSync(path.join(workspace, '.dstudio/blueprints/broken.json'), '{"kind": "architecture", "nodes": [');
    await page.locator('#bp-refresh').click();
    await page.locator('#bp-list [data-file$="broken.json"]').click();
    await page.locator('#bp-empty h3', { hasText: 'This blueprint cannot be drawn' }).waitFor();
    assert.match(await page.locator('#bp-empty').innerText(), /Not valid JSON/);
    assert.equal(await page.locator('#bp-canvas .bp-node').count(), 0);
  });

  await step('the last blueprint reopens after a reload', async () => {
    await page.locator(`#bp-list [data-file="${rel}"]`).click();
    await page.locator('#bp-name', { hasText: 'Order service' }).waitFor();
    // Reload only after the evidence reads finished (a navigation aborts
    // in-flight requests, which WebKit reports as page errors). The reload
    // comes sooner than the settings debounce, so the choice must already be
    // written when the file is shown.
    await page.locator('#bp-evidence', { hasText: '5/8 claims verified' }).waitFor();
    await page.reload();
    await page.locator('#btn-blueprint').waitFor({ state: 'visible' });
    await page.locator('#btn-blueprint').click();
    await page.locator('#bp-evidence', { hasText: '5/8 claims verified' }).waitFor();
    assert.equal((await page.locator('#bp-name').innerText()).trim(), 'Order service');
    await page.locator('#bp-back').click();
    await page.locator('#blueprint').waitFor({ state: 'hidden' });
    await page.locator('#composer-input').waitFor({ state: 'visible' });
  });

  const arrived = async (list, n, what) => {
    for (const deadline = Date.now() + 8000; list.length <= n;) {
      assert.ok(Date.now() < deadline, `${what} never arrived`);
      await new Promise((r) => setTimeout(r, 20));
    }
    return list.at(-1);
  };
  const stored = (key) => page.evaluate((k) => JSON.parse(localStorage.getItem(k) || 'null'), key);

  await step('Implement code asks the Agent in the conversation the blueprint was opened from', async (row) => {
    await page.locator('#btn-blueprint').click();
    await page.locator('#bp-evidence', { hasText: '5/8 claims verified' }).waitFor();
    await page.locator('#bp-handoff').waitFor({ state: 'visible' });
    // Both actions sit in one row with the zoom control, left of it.
    const [d, i, z] = await Promise.all(['#bp-to-design', '#bp-implement', '.bp-zoom'].map((s) => page.locator(s).boundingBox()));
    assert.ok(Math.abs(d.y + d.height / 2 - (z.y + z.height / 2)) < 2 && Math.abs(i.y + i.height / 2 - (z.y + z.height / 2)) < 2, JSON.stringify({ d, i, z }));
    assert.ok(d.x + d.width <= i.x && i.x + i.width <= z.x, 'Send to Design, Implement code, zoom');
    await capture('handoff-buttons');
    const before = { sends: sends.length, starts: starts.length, sessions: sessions.length, chat: (await stored('ds4web.active.v2')).ids.agent };
    await page.locator('#bp-implement').click();
    const sent = await arrived(sends, before.sends, 'the implement prompt');
    assert.equal(sent.displayPrompt, 'Blueprint · implement · Order service');
    assert.ok(sent.prompt.startsWith(`Implement the DStudio Blueprint "Order service" (${rel}) in this workspace`), sent.prompt.slice(0, 160));
    assert.match(sent.prompt, /keep that code/, 'a map of existing code keeps what is already there');
    assert.match(sent.prompt, /"Is the payment provider retried on failure\?"/);
    assert.doesNotMatch(sent.prompt, /holds screens designed/, 'no design/ folder yet');
    assert.equal(starts.length, before.starts, 'the running Agent is reused, not restarted');
    assert.equal(sessions.length, before.sessions, 'no new engine session: the conversation continues');
    await page.locator('#blueprint').waitFor({ state: 'hidden' });
    assert.equal((await stored('ds4web.active.v2')).ids.agent, before.chat, 'the same conversation');
    await page.locator('#agent-view', { hasText: 'Blueprint · implement · Order service' }).waitFor();
    raw += 'Implemented (simulated).\n';
    working = false;                           // the simulated turn ends
  });

  await step('Send to Design opens a Design conversation with the blueprint as context', async (row) => {
    await page.locator('#btn-blueprint').click();
    await page.locator('#bp-evidence', { hasText: '5/8 claims verified' }).waitFor();
    // Wait until the UI saw the simulated turn end: switching engines while
    // the Agent works asks for confirmation first (not tested here).
    await until(() => !document.querySelector('#bp-implement').disabled);
    const before = { sends: sends.length, starts: starts.length };
    await page.locator('#bp-to-design').click();
    // The design engine starts on design/ inside the project, never on the code.
    assert.deepEqual(await arrived(starts, before.starts, 'the Design start'), { mode: 'design', workdir: path.join(workspace, 'design') });
    assert.ok(fs.statSync(path.join(workspace, 'design')).isDirectory());
    const card = page.locator('.design-handoff');
    await card.waitFor({ state: 'visible' });
    const text = (await card.innerText()).replace(/\s+/g, ' ');
    assert.match(text, /Blueprint context Order service/i);
    assert.match(text, /Architecture · 4 parts · 4 relationships/);
    await capture('design-handoff');
    assert.equal(sends.length, before.sends, 'nothing is sent before the user writes the brief');
    await page.locator('#composer-input').fill('A calm admin dashboard');
    await page.locator('#composer-input').press('Enter');
    const sent = await arrived(sends, before.sends, 'the Design prompt');
    assert.equal(sent.displayPrompt, 'A calm admin dashboard\n\n(Blueprint context: Order service)');
    assert.ok(sent.prompt.startsWith('Context: the DStudio Blueprint "Order service"'), sent.prompt.slice(0, 120));
    for (const label of ['HTTP server', 'Orders', 'Payments', 'Database']) assert.ok(sent.prompt.includes(`- ${label} [`), label);
    assert.match(sent.prompt, /- HTTP server → Orders: createOrder/);
    assert.match(sent.prompt, /list the screens you will make/);
    assert.ok(sent.prompt.endsWith('My brief:\nA calm admin dashboard'));
    row.promptChars = sent.prompt.length;
    // The context goes once: the card is gone and the conversation no longer holds it.
    await card.waitFor({ state: 'detached' });
    await until(() => {
      const ids = JSON.parse(localStorage.getItem('ds4web.active.v2')).ids;
      const chat = JSON.parse(localStorage.getItem('ds4web.chats.v2')).chats.find((c) => c.id === ids.design);
      return chat && !chat.handoff;
    });
    const settings = await stored('ds4web.settings.v2');
    assert.equal(settings.workdirs.design, path.join(workspace, 'design'));
    assert.equal(settings.workdirs.agent, workspace, 'the Agent folder is unchanged');
    working = false;
  });

  assert.deepEqual(evidence.errors, [], 'no page errors');
  assert.deepEqual(evidence.external, [], 'no external requests');
} finally {
  fs.writeFileSync(path.join(dir, 'results.json'), JSON.stringify({ ...receipt, sends: sends.map((s) => ({ displayPrompt: s.displayPrompt, promptChars: s.prompt?.length })), requests: requests.slice(-40), hostLog: hostLog.slice(-3000) }, null, 2));
  await browser.close();
  server.close();
  host.stdin.end();
}
const passed = receipt.cases.filter((c) => c.status === 'PASS').length;
console.log(`ui_blueprint (${browserName}, simulated Agent stream): ${passed}/${receipt.cases.length}; receipts: ${dir}`);
if (passed !== receipt.cases.length) process.exitCode = 1;

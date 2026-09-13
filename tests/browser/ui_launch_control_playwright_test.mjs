// Production UI in a real browser; the native lifecycle is simulated at HTTP.
// Explicit response barriers exercise UI ownership, not inference or model quality.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { artifactRunDir, sleep, writeArtifact } from '../support/real_harness.mjs';

const browserName = process.env.DSTUDIO_TEST_BROWSER || 'chromium';
const run = artifactRunDir('launch-ui');
const webRoot = path.resolve('web');
const report = { schema: 'dstudio.launch-ui.v1', started: new Date().toISOString(), browser: browserName,
  scope: 'Full production UI; simulated launcher, no model or native desktop',
  sourceSHA256: crypto.createHash('sha256').update(fs.readFileSync(path.join(webRoot, 'index.html'))).digest('hex'),
  cases: [], requests: [], pageErrors: [], consoleErrors: [], unexpectedRequests: [] };
const tasks = new Map();
let state = { mode: 'server', running: true, ready: true, loadPct: 100, stage: 'Ready',
  workdir: '', config: { ctx: 65536 }, variant: 'flash', variants: { flash: true, pro: false },
  modelFile: 'gguf/DeepSeek-V4-Flash-fixture.gguf', ds4dirOk: true, webdirOk: true,
  agentWorking: false, agentSessionWorking: false, engineError: '', engineLine: 'fixture ready', lan: false };
let pending = null, nextTask = 100, foreignRequest = false;
let statusReads = 0, browser, page;
const json = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body));
};
const bodyOf = async req => { const chunks = []; for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); };
function finishPreparation({ ready = false, error = '' } = {}) {
  assert.ok(pending, 'test requires an admitted, held launch');
  const launch = pending; pending = null;
  if (error) {
    tasks.get(launch.id).status = 'failed';
    json(launch.res, 409, { ok: false, taskId: launch.id, code: 'launch_prepare_failed', error });
  } else {
    state = { ...state, mode: launch.body.mode, workdir: launch.body.workdir, running: true,
      ready, loadPct: ready ? 100 : 25, stage: ready ? 'Ready' : 'Loading fixture', engineLine: '' };
    tasks.get(launch.id).status = ready ? 'completed' : 'working';
    json(launch.res, 200, { ok: true, taskId: launch.id });
  }
  return launch.id;
}
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/api/status') {
    statusReads++;
    json(res, 200, { ...state, launchTaskId: pending?.id || 0,
      launchRequestId: pending ? (foreignRequest ? 'another-window' : pending.body.launchRequestId) : '',
      launchPhase: pending ? 'preparing' : '' }); return;
  }
  if (url.pathname === '/api/start') {
    const body = await bodyOf(req);
    report.requests.push({ endpoint: url.pathname, body });
    if (pending) { json(res, 409, { ok: false, code: 'launch_busy' }); return; }
    pending = { id: ++nextTask, body, res };
    tasks.set(pending.id, { id: pending.id, kind: 'launch', status: 'working' });
    return; // Only a test action or a real UI cancel may release this barrier.
  }
  if (url.pathname === '/api/start/cancel') {
    const body = await bodyOf(req);
    report.requests.push({ endpoint: url.pathname, body });
    const task = tasks.get(body.taskId);
    if (!task || task.status !== 'working') { json(res, 409, { ok: false, error: 'Wrong launch' }); return; }
    task.status = 'canceled';
    if (pending?.id === body.taskId) {
      const launch = pending; pending = null;
      json(launch.res, 409, { ok: false, taskId: launch.id, code: 'launch_canceled', error: 'Launch canceled' });
    } else state = { ...state, running: false, ready: false, stage: 'Stopped' };
    json(res, 200, { ok: true, taskId: body.taskId }); return;
  }
  if (url.pathname === '/api/task') { json(res, 200, { ok: true, task: tasks.get(Number(url.searchParams.get('id'))) }); return; }
  if (url.pathname === '/api/tasks') { json(res, 200, { ok: true, tasks: [...tasks.values()] }); return; }
  if (url.pathname === '/api/store') { json(res, 200, { rev: 0, data: null }); return; }
  if (url.pathname === '/api/storerev') { json(res, 200, { rev: 0 }); return; }
  if (url.pathname === '/api/doctor') { json(res, 200, { ok: true, checks: [] }); return; }
  if (url.pathname === '/api/diagnostics') { json(res, 200, { ok: true, tasks: [], logs: [] }); return; }
  if (url.pathname === '/api/lan-client/chats') { json(res, 200, { ok: true, chats: [] }); return; }
  if (url.pathname === '/api/user-skills') { json(res, 200, { ok: true, skills: [] }); return; }
  if (url.pathname === '/api/ggufs') { json(res, 200, { ok: true, models: [] }); return; }
  if (url.pathname === '/api/engine-checkouts') { json(res, 200, { ok: true, checkouts: [] }); return; }
  if (url.pathname === '/api/fs/list') { const body = await bodyOf(req); json(res, 200, { ok: true, path: body.path, entries: 0, dirs: [] }); return; }
  if (url.pathname === '/api/agent/poll') { json(res, 200, { base: 0, len: 0, text: '', working: false, ready: state.ready, loadPct: state.loadPct }); return; }
  if (url.pathname === '/api/design/session') { json(res, 200, { ok: true }); return; }
  if (url.pathname === '/api/design-systems') { json(res, 200, { ok: true, designSystems: [] }); return; }
  if (url.pathname === '/v1/models') { json(res, 200, { data: [{ id: 'deepseek-v4-flash' }] }); return; }
  const file = path.resolve(webRoot, '.' + (url.pathname === '/' ? '/index.html' : url.pathname));
  if (file.startsWith(webRoot + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) {
    const ext = path.extname(file);
    res.writeHead(200, { 'Content-Type': ({ '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' })[ext] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res); return;
  }
  report.unexpectedRequests.push(url.pathname);
  json(res, 404, { ok: false, error: 'Unexpected test request' });
});

async function until(check, label) {
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    assert.deepEqual(report.pageErrors, [], 'production UI raised an exception');
    if (await check()) return;
    await sleep(50);
  }
  throw new Error(label);
}
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await (await import('playwright'))[browserName].launch();
  page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('pageerror', error => report.pageErrors.push(error.stack || error.message));
  page.on('console', message => { if (message.type() === 'error') report.consoleErrors.push(message.text()); });
  await page.addInitScript(({ origin }) => {
    if (window.top !== window || location.origin !== origin) return;
    window.ds4PickDirectory = async ({ mode }) => `/fixture/${mode}`;
    localStorage.setItem('ds4web.settings.v2', JSON.stringify({ v: 2, onboarded: true, theme: 'dark',
      model: 'deepseek-v4-flash', modelVariant: 'flash', thinkLevel: 'high', ctxSize: 65536,
      ssdStreaming: 'on', webMode: 'off', workdirs: { agent: '/fixture/agent', cowork: '/fixture/cowork' } }));
    localStorage.setItem('ds4web.chats.v2', JSON.stringify({ v: 2, deleted: [], chats: [{ id: 'retained-chat', mode: 'chat',
      title: 'Preserve this conversation', createdAt: 1, updatedAt: 1, messages: [{ id: 'retained-message', role: 'user', content: 'Keep my earlier message', createdAt: 1 }] }] }));
    localStorage.setItem('ds4web.active.v2', JSON.stringify({ v: 2, ids: { chat: 'retained-chat' } }));
  }, { origin });
  await page.goto(origin, { waitUntil: 'domcontentloaded' });
  const overlay = page.locator('#loading-overlay'), cancel = page.locator('#loading-cancel');
  const preserved = await page.evaluate(() => ({
    settings: JSON.parse(localStorage.getItem('ds4web.settings.v2')),
    chat: JSON.parse(localStorage.getItem('ds4web.chats.v2')).chats.find(c => c.id === 'retained-chat'),
  }));
  const check = async (name, fn) => {
    const row = { name };
    try { await fn(row); row.status = 'PASS'; }
    catch (error) { row.status = 'FAIL'; row.error = error.stack || error.message; throw error; }
    finally { report.cases.push(row); console.log(`${name}: ${row.status}`); }
  };
  const starts = () => report.requests.filter(r => r.endpoint === '/api/start');
  const cancels = () => report.requests.filter(r => r.endpoint === '/api/start/cancel');
  const startAgent = async () => {
    const count = starts().length;
    await page.locator('#tab-agent').click();
    await until(() => starts().length === count + 1 && pending, 'Agent click did not admit a launch');
    assert.match(pending.body.launchRequestId, /^[a-zA-Z0-9_-]{1,63}$/, 'nonce must be accepted by native validation');
    return pending.id;
  };
  await check('old ready runtime is not a successful new launch; cancellation preserves user state', async row => {
    row.taskId = await startAgent();
    await cancel.waitFor({ state: 'visible' });
    assert.equal(await overlay.isVisible(), true);
    assert.equal(await page.locator('#loading-pct').textContent(), '0');
    assert.equal(await page.locator('#agent-view').isVisible(), false);
    assert.equal(state.mode, 'server');
    const count = starts().length;
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+5' : 'Control+5');
    await sleep(100);
    assert.equal(starts().length, count, 'another mode shortcut must not double-admit while switching');
    await page.screenshot({ path: path.join(run, 'pending-dark.png') });
    await cancel.click();
    await overlay.waitFor({ state: 'hidden' });
    assert.deepEqual(cancels().at(-1).body, { taskId: row.taskId });
    assert.equal(state.mode, 'server'); assert.equal(state.ready, true);
    const after = await page.evaluate(() => ({ settings: JSON.parse(localStorage.getItem('ds4web.settings.v2')),
      chat: JSON.parse(localStorage.getItem('ds4web.chats.v2')).chats.find(c => c.id === 'retained-chat') }));
    assert.deepEqual(after.chat, preserved.chat);
    for (const key of ['model', 'modelVariant', 'ctxSize', 'ssdStreaming', 'workdirs']) assert.deepEqual(after.settings[key], preserved.settings[key]);
  });
  await check('another window cannot donate its task ID to the cancel button', async row => {
    foreignRequest = true;
    row.taskId = await startAgent();
    const seen = statusReads;
    await until(() => statusReads > seen + 2, 'UI did not observe foreign preparation');
    assert.equal(await cancel.isVisible(), false);
    assert.equal(await overlay.isVisible(), true);
    foreignRequest = false;
    await cancel.waitFor({ state: 'visible' });
    await cancel.click(); await overlay.waitFor({ state: 'hidden' });
    assert.deepEqual(cancels().at(-1).body, { taskId: row.taskId });
  });
  await check('accepted but not ready model can be canceled by its exact launch task', async row => {
    row.taskId = await startAgent();
    finishPreparation();
    await page.getByText('Loading fixture', { exact: true }).first().waitFor();
    await cancel.click(); await overlay.waitFor({ state: 'hidden' });
    assert.equal(tasks.get(row.taskId).status, 'canceled');
    assert.deepEqual(cancels().at(-1).body, { taskId: row.taskId });
    assert.equal(state.ready, false);
    assert.equal(await page.locator('#agent-view').isVisible(), false);
    state = { ...state, mode: 'server', ready: true, running: true, stage: 'Ready', workdir: '' };
  });
  await check('a failed launch cannot hide the overlay of a newer attempt', async row => {
    await startAgent();
    finishPreparation({ error: 'Deliberate preparation failure' });
    await page.getByText(/Deliberate preparation failure/).first().waitFor();
    const count = starts().length;
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+2' : 'Control+2');
    await until(() => starts().length === count + 1 && pending, 'retry was not admitted through the real shortcut');
    row.taskId = pending.id;
    await cancel.waitFor({ state: 'visible' });
    // Keep the new HTTP launch at its barrier beyond the old 3.5s error timer.
    await sleep(4000);
    assert.equal(pending?.id, row.taskId);
    assert.equal(await overlay.isVisible(), true, 'an old error timer dismissed an unrelated pending launch');
    assert.equal(await cancel.isVisible(), true);
    await cancel.click(); await overlay.waitFor({ state: 'hidden' });
  });
  await check('a completed new task opens Agent and retires the loading controls', async row => {
    row.taskId = await startAgent();
    finishPreparation({ ready: true });
    await page.locator('#agent-view').waitFor({ state: 'visible' });
    assert.equal(await overlay.isVisible(), false);
    assert.equal(await cancel.isVisible(), false);
    assert.equal(tasks.get(row.taskId).status, 'completed');
    assert.equal(new Set(starts().map(r => r.body.launchRequestId)).size, starts().length, 'a retry must have a new identity');
  });
  assert.deepEqual(report.pageErrors, []);
  assert.deepEqual(report.unexpectedRequests, []);
  report.status = 'PASS';
} catch (error) {
  report.status = 'FAIL'; report.error = error.stack || error.message;
  if (page) {
    await page.screenshot({ path: path.join(run, 'failure.png') }).catch(() => {});
    report.visibleFailure = await page.locator('body').innerText().catch(() => 'Page unavailable');
  }
  console.error(report.error);
} finally {
  if (pending) { json(pending.res, 409, { ok: false, code: 'launch_canceled', error: 'Test teardown' }); pending = null; }
  await browser?.close();
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  report.finished = new Date().toISOString();
  writeArtifact(run, 'results.json', report);
  console.log(`Preserved browser launch evidence: ${run}`);
}
process.exitCode = report.status === 'PASS' ? 0 : 1;

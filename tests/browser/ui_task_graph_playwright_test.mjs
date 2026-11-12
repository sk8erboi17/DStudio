// Live Task Graph dialog (Agent) in a real browser against the REAL native
// host's Task Graph API, scheduler and journal (tests/.build/dstudio-server-test
// in test mode). Graphs use the host's synthetic executor (policy
// test.synthetic.v1): its nodes only wait, so no model, tool or engine runs.
// The page's Agent session status is SIMULATED by the UI fixture server; every
// /api/task-graph* request is forwarded to the real host unchanged.
//   node tests/browser/ui_task_graph_playwright_test.mjs [dstudio-server-test]
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chromium, webkit } from 'playwright';
import { uiMockServer, jsonReply, requestBody, seedUi } from '../support/ui_mock_server.mjs';
import { artifactRunDir, csrfHeaders, freePort, sleep, writeArtifact } from '../support/real_harness.mjs';

const browserName = process.env.DSTUDIO_TEST_BROWSER || 'chromium';
assert.ok(['chromium', 'webkit'].includes(browserName));
const binary = path.resolve(process.argv[2] || 'tests/.build/dstudio-server-test');
assert.ok(fs.existsSync(binary), `${binary} is required (make tests/.build/dstudio-server-test); missing is not a pass`);
const run = artifactRunDir(`ui-task-graph-${browserName}`);
const workspace = path.join(run, 'workspace');
fs.mkdirSync(workspace);
fs.mkdirSync(path.join(run, 'ds4'));
const receipt = { scope: 'Real browser and real native Task Graph host (synthetic executor); simulated Agent status; no model',
  browserName, cases: [], hostStarts: [] };

// ---------- the real host: started, stopped and started again like the app ----------
let host = null, hostBase = '';
async function startHost() {
  const port = await freePort();
  const log = fs.openSync(path.join(run, `host-${receipt.hostStarts.length}.log`), 'w');
  host = spawn(binary, [String(port), path.join(run, 'ds4')], { stdio: ['ignore', log, log],
    env: { ...process.env, HOME: path.join(run, 'home'), DS4UI_DATA_DIR: path.join(run, 'data'),
      DS4UI_TEST_MODE: '1', DS4UI_NO_WINDOW: '1', DS4UI_HOST: '127.0.0.1' } });
  fs.closeSync(log);
  hostBase = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    if (host.exitCode !== null) throw Error('native host exited while starting');
    try { if ((await fetch(hostBase + '/api/status')).ok) { receipt.hostStarts.push({ pid: host.pid, port }); return; } } catch {}
    await sleep(50);
  }
  throw Error('native host did not start');
}
async function stopHost() {
  if (!host || host.exitCode !== null) return;
  const exited = once(host, 'exit');
  host.kill('SIGTERM');
  await exited;
}
const hostJson = async (endpoint, body) => {
  const r = await fetch(hostBase + endpoint, body === undefined ? {} : { method: 'POST', headers: csrfHeaders, body: JSON.stringify(body) });
  const data = await r.json();
  assert.ok(r.ok && data.ok, `${endpoint}: HTTP ${r.status} ${JSON.stringify(data)}`);
  return data;
};
const hostGraph = async (id) => (await hostJson(`/api/task-graph?graphId=${id}&workspace=${encodeURIComponent(workspace)}`)).graph;
// A graph as the Agent's automatic route or an API client would propose it:
// created (ready) by the host, then started by the user from the dialog.
async function createGraph(goal) {
  const created = await hostJson('/api/task-graph/create', { schemaVersion: 1, policy: 'test.synthetic.v1', executorMode: 'synthetic',
    mode: 'agent', goal, workspace, nodes: [
      { id: 'slow', kind: 'host_tool', title: 'Slow step', synthetic: { delayMs: 2500 } },
      { id: 'after', kind: 'host_tool', title: 'Second step', dependsOn: ['slow'], synthetic: { delayMs: 300 } },
      { id: 'done', kind: 'join', title: 'Finish', dependsOn: ['after'] },
    ] });
  assert.equal(created.graph.state, 'ready');
  return created.graph.graphId;
}

// ---------- the page: simulated Agent session, real Task Graph ----------
let mode = 'server';
const forwarded = [];
const server = await uiMockServer(async (req, res, url) => {
  if (url.pathname === '/api/task-graphs' || url.pathname.startsWith('/api/task-graph')) {
    const body = req.method === 'POST' ? Buffer.concat(await (async () => { const c = []; for await (const x of req) c.push(x); return c; })()) : undefined;
    const headers = { 'Content-Type': 'application/json' };
    if (req.headers['x-requested-with']) headers['X-Requested-With'] = req.headers['x-requested-with'];
    const r = await fetch(hostBase + url.pathname + url.search, { method: req.method, headers, body });
    forwarded.push(`${req.method} ${url.pathname} ${r.status}`);
    res.writeHead(r.status, { 'content-type': 'application/json' });
    res.end(await r.text());
    return true;
  }
  if (url.pathname === '/api/status') {
    jsonReply(res, { mode, running: true, ready: true, loadPct: 100, stage: 'Ready (simulated)', agentWorking: false,
      agentSessionWorking: false, workdir: workspace, ds4dirOk: true, webdirOk: true, lan: false,
      modelFile: 'gguf/DeepSeek-V4-Flash-Vision-Exp-test.gguf', config: { ctx: 65536, power: 100 }, variant: 'flash', variants: { flash: true } });
    return true;
  }
  if (url.pathname === '/api/start') { mode = (await requestBody(req)).mode || 'server'; jsonReply(res, { ok: true }); return true; }
  if (url.pathname === '/api/fs/list') { jsonReply(res, { ok: true, path: workspace, entries: 0, dirs: [] }); return true; }
  if (url.pathname === '/api/user-skills') { jsonReply(res, { ok: true, skills: [] }); return true; }
  if (url.pathname === '/api/design-systems') { jsonReply(res, { ok: true, designSystems: [] }); return true; }
  if (url.pathname === '/api/updates/check') { jsonReply(res, { ok: true, sections: [] }); return true; }
  if (url.pathname === '/api/agent/poll') { jsonReply(res, { base: 0, len: 0, text: '', working: false, sessionWorking: false, ready: true, loadPct: 100 }); return true; }
  return false;
});

const now = Date.now();
const seed = { theme: 'dark', settings: { workdirs: { agent: workspace } },
  chats: [{ id: 'graph-agent', mode: 'agent', title: 'Task Graph fixture', createdAt: now, updatedAt: now, messages: [], transcript: '', workdir: workspace }] };
const browser = await ({ chromium, webkit })[browserName].launch();
let context, page, evidence;
const pageErrors = [];
// The app window in a fresh browser profile, on Agent (the simulated host runs it).
async function openApp() {
  context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  page = await context.newPage();
  page.setDefaultTimeout(10000);
  evidence = await seedUi(page, server.origin, seed);
  await page.goto(server.origin);
  if (mode !== 'agent') {
    await page.locator('#tab-agent').click();
    const workdirDialog = page.locator('#workdir-dialog');
    await workdirDialog.waitFor();
    await workdirDialog.getByRole('button', { name: /^(Start|Launch)/ }).click();
  }
  await page.waitForFunction(() => !document.querySelector('#agent-view')?.hidden);
}
async function closeApp() {
  pageErrors.push(...evidence.errors, ...evidence.external.map((url) => `external request ${url}`));
  await context.close();
}
let shot = 0;
const capture = (name) => page.screenshot({ path: path.join(run, `${String(shot++).padStart(2, '0')}-${name}.png`) });
async function step(name, fn) {
  const row = { name };
  try { await fn(row); row.status = 'PASS'; }
  catch (error) { row.status = 'FAIL'; row.error = error.stack; process.exitCode = 1; await capture(`fail-${name.replace(/\W+/g, '-')}`).catch(() => {}); }
  receipt.cases.push(row);
  console.log(`${row.status} ${name}${row.error ? `\n${row.error}` : ''}`);
  if (row.status === 'FAIL') throw Error(`stopped after: ${name}`);
}

const dialog = () => page.locator('#task-graph-dialog');
const card =(title) => page.locator('.task-graph-node').filter({ has: page.locator('strong', { hasText: title }) });
const control = (label) => page.locator('#task-graph-controls button', { hasText: label });
const cardState = (title, state) => page.waitForFunction(([t, s]) => [...document.querySelectorAll('.task-graph-node')]
  .some((n) => n.querySelector('strong')?.textContent === t && n.dataset.state === s), [title, state]);
const metaState = (state) => page.waitForFunction((s) => document.querySelector('#task-graph-meta')?.textContent.startsWith(`${s} ·`), state);
const events = () => page.locator('#task-graph-events li').allInnerTexts();
async function openDialog() {
  // The ⌘K command palette (Ctrl+K is the same shortcut).
  await page.keyboard.press('Control+k');
  await page.locator('.cmdk-input').fill('task graph');
  await page.locator('.cmdk-item', { hasText: 'Task Graph' }).click();
  await dialog().waitFor({ state: 'visible' });
}
async function select(graphId) {
  await page.locator(`#task-graph-list option[value="${graphId}"]`).waitFor({ state: 'attached' });
  await page.locator('#task-graph-list').selectOption(graphId);
  await page.waitForFunction((id) => document.querySelector('#task-graph-meta')?.textContent.includes('·') &&
    document.querySelector('#task-graph-list')?.value === id, graphId);
}
// The dialog must show what the host's journal says, node by node.
async function matchesHost(graphId) {
  const graph = await hostGraph(graphId);
  const shown = await page.$$eval('.task-graph-node', (nodes) => nodes.map((n) => [n.querySelector('strong').textContent, n.dataset.state]));
  assert.deepEqual(shown.sort(), graph.nodes.map((n) => [n.title, n.state]).sort());
  return graph;
}

let watched, paused;
try {
  await startHost();
  await openApp();

  await step('the user starts a ready graph from the dialog and watches its nodes run', async () => {
    watched = await createGraph('Watch the nodes run');
    await openDialog();
    await select(watched);
    await metaState('ready');
    assert.deepEqual(await page.locator('#task-graph-controls button').allInnerTexts(), ['Start', 'Cancel']);
    await control('Start').click();
    await cardState('Slow step', 'running');
    await metaState('running');
    assert.equal(await card('Second step').getAttribute('data-state'), 'pending');
    await capture('running');
  });

  await step('Pause in the dialog lets the running node finish, then holds the rest', async () => {
    await control('Pause').click();
    await metaState('paused');
    await cardState('Slow step', 'succeeded');
    await control('Resume').waitFor();
    assert.equal(await control('Pause').count(), 0);
    // Paused means paused: nothing advances while the user waits.
    await sleep(1200);
    const graph = await matchesHost(watched);
    assert.equal(graph.state, 'paused');
    assert.equal(graph.nodes.find((n) => n.id === 'after').state, 'pending');
    assert.equal(graph.nodes.find((n) => n.id === 'after').attemptsStarted, 0);
    await page.locator('.task-graph-events-wrap summary').click();
    assert.ok((await events()).some((line) => / graph\.paused /.test(line)), 'the durable event stream shows the pause');
    await capture('paused');
  });

  await step('Resume in the dialog runs the remaining nodes to success', async () => {
    await control('Resume').click();
    await metaState('succeeded');
    for (const title of ['Slow step', 'Second step', 'Finish']) await cardState(title, 'succeeded');
    assert.equal(await page.locator('#task-graph-controls button').count(), 0, 'a finished graph offers no Start, Pause, Resume or Cancel');
    const graph = await matchesHost(watched);
    assert.deepEqual(graph.progress, { completed: 3, total: 3 });
    const lines = await events();
    for (const type of ['graph.started', 'graph.pausing', 'graph.paused', 'graph.resumed', 'graph.succeeded'])
      assert.ok(lines.some((line) => line.includes(` ${type} `)), `event ${type} is listed`);
    await capture('succeeded');
  });

  await step('a second graph is paused from the dialog before the app restarts', async () => {
    paused = await createGraph('Pause me before the restart');
    await page.locator('#task-graph-refresh').click();
    await select(paused);
    await control('Start').click();
    await cardState('Slow step', 'running');
    await control('Pause').click();
    await metaState('paused');
    assert.equal((await hostGraph(paused)).state, 'paused');
    await page.locator('#task-graph-close').click();
    await dialog().waitFor({ state: 'hidden' });
  });

  await step('after an app restart the dialog reopens the paused and the finished graph from the journal', async (row) => {
    const before = { watched: await hostGraph(watched), paused: await hostGraph(paused) };
    // Quit: the window closes and the host exits; then both start again.
    await closeApp();
    await stopHost();
    await startHost();
    assert.notEqual(receipt.hostStarts[0].pid, receipt.hostStarts[1].pid, 'a new host process');
    await openApp();
    await openDialog();
    await page.waitForFunction(() => document.querySelectorAll('#task-graph-list option').length >= 2);
    const options = await page.locator('#task-graph-list option').allInnerTexts();
    row.options = options;
    assert.ok(options.includes('paused · Pause me before the restart'), JSON.stringify(options));
    assert.ok(options.includes('succeeded · Watch the nodes run'), JSON.stringify(options));

    await select(watched);
    await metaState('succeeded');
    const finished = await matchesHost(watched);
    assert.equal(finished.lastEventSeq, before.watched.lastEventSeq, 'reopening appends nothing to a finished graph');
    assert.equal(await page.locator('#task-graph-controls button').count(), 0);
    for (const title of ['Slow step', 'Second step', 'Finish']) await cardState(title, 'succeeded');

    await select(paused);
    await metaState('paused');
    const reopened = await matchesHost(paused);
    assert.equal(reopened.revision, before.paused.revision);
    assert.equal(reopened.lastEventSeq, before.paused.lastEventSeq, 'reopening replays the journal without new events');
    assert.deepEqual(await page.locator('#task-graph-controls button').allInnerTexts(), ['Resume', 'Cancel']);
    await page.locator('.task-graph-events-wrap summary').click();
    assert.ok((await events()).some((line) => / graph\.paused /.test(line)), 'events written before the restart are listed');
    await capture('reopened');
  });

  await step('the reopened paused graph resumes and finishes on the restarted host', async () => {
    await control('Resume').click();
    await metaState('succeeded');
    for (const title of ['Slow step', 'Second step', 'Finish']) await cardState(title, 'succeeded');
    const graph = await matchesHost(paused);
    assert.equal(graph.nodes.find((n) => n.id === 'slow').attemptsStarted, 1, 'the step finished before the restart is not run again');
    pageErrors.push(...evidence.errors, ...evidence.external.map((url) => `external request ${url}`));
    assert.deepEqual(pageErrors, [], `page errors: ${pageErrors.join('\n')}`);
    assert.deepEqual(server.missing, [], `unmocked requests: ${server.missing.join(', ')}`);
  });
} finally {
  receipt.forwarded = forwarded;
  writeArtifact(run, 'results.json', receipt);
  await browser.close().catch(() => {});
  server.close();
  await stopHost();
  console.log(`Task Graph dialog evidence: ${run}`);
}

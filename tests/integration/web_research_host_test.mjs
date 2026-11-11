// SIMULATED model replies; real host, page and page reads. The production page
// is served by the real model-free test host (tests/.build/dstudio-server-test)
// and driven in Playwright (DSTUDIO_TEST_BROWSER=chromium|webkit). Real: the
// page, its Search/Deep Research pipeline, the host's /api/web-read (curl
// reader) and /api/web-search, the /v1 relay and the conversation store.
// Simulated: the engine is a scripted loopback server whose replies are
// authored here, the launcher is a status overlay, and in the first scenario
// search discovery is an overlay that lists pages served by this test.
// No model, weights, inference or external network: the host's curl reaches
// only loopback (every proxy variable points at a closed local port, loopback
// is exempt), which is also how "offline" is produced. Nothing here measures
// answer quality.
//   DSTUDIO_TEST_BROWSER=webkit node tests/integration/web_research_host_test.mjs [tests/.build/dstudio-server-test]
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { freePort, sleep } from '../support/real_harness.mjs';

const browserName = process.env.DSTUDIO_TEST_BROWSER || 'chromium';
assert.ok(['chromium', 'webkit'].includes(browserName), `unsupported browser ${browserName}`);
let browserType;
try { browserType = (await import('playwright'))[browserName]; }
catch { console.log('web_research_host_test: Playwright is missing: NOT RUN (not a pass)'); process.exit(1); }
const binary = path.resolve(process.argv[2] || 'tests/.build/dstudio-server-test');
assert.ok(fs.existsSync(binary), `test host not built: ${binary}`);
fs.mkdirSync('tests/.artifacts/web-research-host', { recursive: true });
const run = fs.mkdtempSync(path.resolve(`tests/.artifacts/web-research-host/${browserName}-`));
const report = { scope: 'SIMULATED engine, launcher and (scenario 1) discovery; real host, page, page reads and store; no model, no external network', browserName, checks: [] };
const save = () => fs.writeFileSync(path.join(run, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
function deferred() { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; }

// ---- pages this test serves (loopback only) --------------------------------
const SENTENCE = 'Orchid waits for an acknowledgement before it retries a delivery.';
const site = http.createServer((req, res) => {
  if (req.url === '/orchid') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<html><head><title>Orchid delivery handbook</title></head><body><h1>Orchid delivery handbook</h1><p>${SENTENCE}</p><p>${'The handbook documents the delivery protocol and its retry rules. '.repeat(8)}</p></body></html>`);
    return;
  }
  if (req.url === '/blocked') {   // a page that refuses the reader
    res.writeHead(403, { 'content-type': 'text/html' });
    res.end('<html><head><title>Access denied</title></head><body><p>Access denied. Orchid never retries and you do not have permission to view this page.</p></body></html>');
    return;
  }
  if (req.url === '/reset') { req.socket.destroy(); return; }   // connection dropped before any reply
  res.writeHead(404); res.end();
});
site.listen(0, '127.0.0.1'); await once(site, 'listening');
const sitePort = site.address().port;
const closedPort = await freePort();   // nothing listens here: refused
const OK_URL = `http://127.0.0.1:${sitePort}/orchid`;
const BLOCKED_URL = `http://127.0.0.1:${sitePort}/blocked`;
const RESET_URL = `http://127.0.0.1:${sitePort}/reset`;
const REFUSED_URL = `http://127.0.0.1:${closedPort}/gone`;
const DISCOVERED = [OK_URL, BLOCKED_URL, RESET_URL, REFUSED_URL];

// ---- the scripted engine -----------------------------------------------------
const ROLES = [['search classifier', 'classifier'], ['source picker', 'picker'], ['evidence extractor', 'extractor'],
  ['research sufficiency judge', 'judge'], ['research action planner', 'planner'], ['Deep Research writer', 'writer'],
  ['final-answer evidence reviewer', 'reviewer']];
const roleOf = (body) => {
  const system = String(body.messages?.find((m) => m.role === 'system')?.content || '');
  return ROLES.find(([marker]) => system.includes(`DStudio ${marker}`))?.[1] || 'answer';
};
const received = [];
let scenario = 'online';
let judgeBarrier = null;
const ANSWER = `Orchid waits for an acknowledgement before it retries [F1] [S1].\n\nSource: ${OK_URL}`;
async function reply(body, role) {
  if (role === 'classifier') return { needsSearch: true, intent: 'research', standaloneQuestion: 'How does Orchid retry a delivery?', explicitUrls: [], queries: ['orchid delivery retry'] };
  if (role === 'picker') return { reason: 'Read the handbook candidates', urls: DISCOVERED };
  if (role === 'extractor') {
    const page = String(body.messages?.[1]?.content || '');
    return { facts: page.includes(SENTENCE) ? [{ fact: SENTENCE, excerpt: SENTENCE, confidence: 'high' }] : [] };
  }
  if (role === 'judge') {
    if (judgeBarrier) { judgeBarrier.entered.resolve(); await judgeBarrier.release.promise; }
    return scenario === 'online'
      ? { decision: 'enough', reason: 'The handbook states the retry rule.', answerFactIds: ['F1'], gaps: [], queries: [], urls: [] }
      : { decision: 'continue', reason: 'Nothing was read.', gaps: ['No source was read'], queries: ['orchid retry acknowledgement'], urls: [] };
  }
  if (role === 'planner') return { action: 'web_search', reason: 'Try another query.', queries: [`orchid retry ${received.length}`], urls: [] };
  if (role === 'writer') return ANSWER;
  if (role === 'reviewer') return { claimsSupported: true, requestedPartsCovered: true, conflictsHandled: true, instructionsFollowed: true, issues: [] };
  return 'An answer written from memory, without any web evidence.';
}
const engine = http.createServer(async (req, res) => {
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  if (req.url === '/v1/models') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ data: [{ id: 'scripted-fixture', context_length: 65536 }] })); return; }
  if (req.url !== '/v1/chat/completions') { res.writeHead(404); res.end(); return; }
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const role = roleOf(body);
  received.push({ scenario, role, stream: body.stream === true, body });
  const value = await reply(body, role);
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (!body.stream) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: text }, finish_reason: 'stop' }] }));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: null }] })}\n\n`);
  res.end(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
});
engine.listen(0, '127.0.0.1'); await once(engine, 'listening');

// ---- the real host in test mode ----------------------------------------------
const hostDir = path.join(run, 'host');
for (const d of ['home', 'data', 'ds4/gguf']) fs.mkdirSync(path.join(hostDir, d), { recursive: true });
const hostPort = await freePort(), base = `http://127.0.0.1:${hostPort}`;
const deadProxy = `http://127.0.0.1:${closedPort}`;
const log = fs.openSync(path.join(hostDir, 'host.log'), 'wx');
const host = spawn(binary, [String(hostPort), path.join(hostDir, 'ds4')], { stdio: ['ignore', log, log], detached: true,
  env: { ...process.env, HOME: path.join(hostDir, 'home'), DS4UI_TEST_MODE: '1', DS4UI_NO_WINDOW: '1', DS4UI_DEFER_ENGINE_START: '1',
    DS4UI_HOST: '127.0.0.1', DS4UI_DATA_DIR: path.join(hostDir, 'data'), DS4UI_ENGINE_PORT: String(engine.address().port),
    // The network path: anything beyond loopback fails, as on an offline machine.
    ALL_PROXY: deadProxy, all_proxy: deadProxy, HTTPS_PROXY: deadProxy, https_proxy: deadProxy, http_proxy: deadProxy,
    NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' } });
fs.closeSync(log);
const hostExited = new Promise((resolve) => host.once('exit', resolve));

async function check(name, fn) {
  const row = { name }; report.checks.push(row);
  try { Object.assign(row, await fn() || {}); row.status = 'PASS'; }
  catch (error) { row.status = 'FAIL'; row.error = String(error.stack || error); process.exitCode = 1; }
  save();
  console.log(`${row.status}: ${name}${row.error ? `\n${row.error}` : ''}`);
}

let browser;
try {
  let up = false;
  for (let i = 0; i < 200 && !up && host.exitCode === null; i++) {
    try { up = (await fetch(`${base}/api/status`)).ok; } catch { /* starting */ }
    if (!up) await sleep(50);
  }
  assert.ok(up, 'the test host did not start');
  browser = await browserType.launch();
  const context = await browser.newContext({ viewport: { width: 1360, height: 960 } });
  const forbidden = [], pageErrors = [], reads = [], searches = [];
  let discovery = 'simulated';
  await context.route('**/api/status', async (route) => {
    const response = await route.fetch(); const real = await response.json();
    await route.fulfill({ response, json: { ...real, mode: 'server', running: true, ready: true, stage: 'Ready (simulated)', loadPct: 100,
      ds4dirOk: true, webdirOk: true, modelFile: 'gguf/DeepSeek-V4-Flash-test.gguf', variant: 'flash', variants: { flash: true },
      nativeVisionActive: false, config: { ctx: 65536, power: 100, think: 'off', ssdStreaming: 'off' } } });
  });
  await context.route('**/api/doctor', (route) => route.fulfill({ json: { ok: true, ready: true, fatal: 0, warnings: 0, summary: 'Ready (simulated)', checks: [] } }));
  await context.route('**/api/start', async (route) => { forbidden.push(route.request().postData()); await route.abort(); });
  // Scenario 1 lists the loopback pages as search results; scenario 2 uses the host's real search.
  await context.route('**/api/web-search', async (route) => {
    if (discovery !== 'simulated') return route.continue();
    await route.fulfill({ json: { ok: true, provider: 'simulated discovery', sources: DISCOVERED.map((url, i) => ({ url, title: `Orchid handbook candidate ${i + 1}`, content: 'Discovery lead.' })) } });
  });
  await context.addInitScript(({ origin }) => {
    if (window !== window.top || location.origin !== origin) return;
    if (localStorage.getItem('ds4web.settings.v2')) return;
    localStorage.setItem('ds4web.onboarded.v2', JSON.stringify({ v: 2, done: true, at: Date.now() }));
    localStorage.setItem('ds4web.settings.v2', JSON.stringify({ v: 2, onboarded: true, theme: 'dark', chatBackend: 'local',
      model: 'scripted-fixture', modelGguf: 'gguf/DeepSeek-V4-Flash-test.gguf', modelVariant: 'flash', thinkLevel: 'off', ctxSize: 65536,
      enginePower: 100, ssdStreaming: 'off', temperature: 0, qualityDefaultsVersion: 2, webMode: 'research', webSearchBrowserAllowed: true }));
  }, { origin: base });
  const page = await context.newPage();
  page.on('pageerror', (error) => pageErrors.push(String(error.stack || error)));
  page.on('response', async (response) => {
    const pathname = new URL(response.url()).pathname;
    if (pathname !== '/api/web-read' && pathname !== '/api/web-search') return;
    const entry = { request: response.request().postDataJSON(), status: response.status(), body: await response.json().catch(() => null) };
    (pathname === '/api/web-read' ? reads : searches).push(entry);
  });
  await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
  await page.locator('#composer-input').waitFor({ state: 'visible', timeout: 60_000 });
  const savedChat = (question) => page.evaluate(async (question) => {
    const store = await (await fetch('/api/store')).json();
    const data = typeof store.data === 'string' ? JSON.parse(store.data) : store.data;
    return data.chats.find((chat) => chat.messages.some((message) => message.role === 'user' && message.content === question));
  }, question);
  // The page saves to the host asynchronously; wait for the durable record.
  const savedWhen = async (question, ready) => {
    for (let i = 0; i < 200; i++) {
      const chat = await savedChat(question).catch(() => null);
      if (chat && ready(chat)) return chat;
      await sleep(50);
    }
    throw new Error('the conversation was not saved in its final state');
  };

  // ---- Scenario 1: one readable page among blocked, dropped and refused ones --
  judgeBarrier = { entered: deferred(), release: deferred() };
  await page.locator('#composer-input').fill('How does Orchid handle a delivery retry?');
  await page.locator('#composer-input').press('Enter');
  await Promise.race([judgeBarrier.entered.promise, sleep(60_000).then(() => { throw new Error('the research run never reached its judge'); })]);

  await check('pages that cannot be read are reported as failed reads and never reach the extractor (page-cannot-be-read)', async () => {
    const byUrl = new Map(reads.map((entry) => [entry.request.url, entry]));
    assert.deepEqual([...byUrl.keys()].sort(), [...DISCOVERED].sort(), 'every selected page was requested from the real host');
    assert.equal(byUrl.get(OK_URL).status, 200); assert.equal(byUrl.get(OK_URL).body.ok, true);
    assert.match(byUrl.get(OK_URL).body.markdown, /acknowledgement before it retries/);
    for (const [url, pattern] of [[BLOCKED_URL, /HTTP 403/], [RESET_URL, /could not be reached/], [REFUSED_URL, /could not be reached/]]) {
      const entry = byUrl.get(url);
      assert.equal(entry.body?.ok, false, `${url} must be a failed read, not page text: ${JSON.stringify(entry.body)}`);
      assert.match(entry.body.error, pattern);
      assert.equal(entry.body.markdown, undefined, 'a failed read carries no page text');
    }
    const extractions = received.filter((call) => call.role === 'extractor');
    assert.equal(extractions.length, 1, 'only the readable page is sent to the extractor');
    assert.ok(extractions[0].body.messages[1].content.includes(SENTENCE));
    for (const call of received) {
      const sent = JSON.stringify(call.body);
      assert.ok(!sent.includes('Access denied'), `the blocked page's error text reached the ${call.role}`);
    }
    // While the run is still active, its visible trace says which pages failed and why.
    const rows = await page.locator('.web-trace__row[data-state="error"]').allTextContents();
    for (const url of [BLOCKED_URL, RESET_URL, REFUSED_URL]) assert.ok(rows.some((row) => row.includes(url)), `the trace names the unread page ${url}: ${JSON.stringify(rows)}`);
    assert.ok(rows.some((row) => /HTTP 403/.test(row)), 'the trace says why the blocked page was not read');
    await page.screenshot({ path: path.join(run, 'unreadable-pages-trace.png') });
    return { failedRows: rows };
  });
  judgeBarrier.release.resolve(); judgeBarrier = null;
  const answer = page.locator('.msg--assistant:not(.msg--streaming)').filter({ hasText: 'acknowledgement' }).last();
  await answer.waitFor({ state: 'visible', timeout: 60_000 });

  await check('the run goes on with the readable page and the saved evidence holds only that page (page-cannot-be-read)', async () => {
    const chat = await savedWhen('How does Orchid handle a delivery retry?', (saved) => saved.messages.at(-1)?.finishReason === 'stop');
    const user = chat.messages.findLast((message) => message.role === 'user');
    assert.deepEqual(user.web.sources.map((source) => source.url), [OK_URL], 'unread pages are not evidence');
    assert.equal(user.web.sources[0].read, true);
    assert.equal(user.web.stopReason, '');
    const last = chat.messages.at(-1);
    assert.equal(last.finishReason, 'stop');
    assert.equal(last.content, ANSWER);
    assert.deepEqual(received.filter((call) => call.role === 'answer'), [], 'the reviewed report is delivered as written');
  });

  await check('the delivered answer has clickable citations and a source card that open the source (answer-shows-clickable-citations)', async () => {
    const source = answer.locator('a.md-cite--source[data-cite-id="S1"]');
    const fact = answer.locator('a.md-cite--fact[data-cite-id="F1"]');
    assert.equal(await source.count(), 1); assert.equal(await fact.count(), 1);
    assert.equal(await source.getAttribute('href'), OK_URL);
    const factTarget = await fact.getAttribute('href');
    assert.match(factTarget, /^#fact-/);
    assert.equal(await answer.locator(factTarget).count(), 1, 'the fact citation points at an anchor inside this answer');
    const cards = answer.locator('.msg-source');
    assert.equal(await cards.count(), 1, 'one card: the page that was read');
    assert.equal(await cards.first().getAttribute('href'), OK_URL);
    assert.match(await cards.first().textContent(), /Orchid delivery handbook|127\.0\.0\.1/);
    await page.screenshot({ path: path.join(run, 'answer-with-citations.png') });
    for (const target of [source, cards.first()]) {
      const [popup] = await Promise.all([context.waitForEvent('page'), target.click()]);
      await popup.waitForLoadState('domcontentloaded');
      assert.equal(popup.url(), OK_URL, 'the click opens the cited page');
      assert.match(await popup.locator('body').textContent(), /acknowledgement before it retries/);
      await popup.close();
    }
    assert.equal(new URL(page.url()).origin, base, 'opening a source leaves the conversation in place');
    await fact.click();
    assert.equal(new URL(page.url()).origin, base, 'a fact citation stays in the conversation');
  });

  // ---- Scenario 2: the network is unreachable when research starts ------------
  discovery = 'real';
  scenario = 'offline';
  const offlineFrom = received.length, offlineSearches = searches.length;
  await page.locator('#btn-new-chat').click();
  await page.locator('#composer-input').fill('What is the latest Orchid release?');
  await page.locator('#composer-input').press('Enter');
  const failure = page.locator('.msg--assistant').filter({ hasText: 'Deep Research returned no usable evidence' });
  await failure.waitFor({ state: 'visible', timeout: 60_000 });

  await check('offline Deep Research ends with a clear failure and no answer is generated (no-internet-connection)', async () => {
    const realSearches = searches.slice(offlineSearches);
    assert.ok(realSearches.length > 0 && realSearches.every((entry) => entry.status === 502 && entry.body?.ok === false), 'the real host search failed');
    assert.match(realSearches[0].body.error, /No web search provider could be reached; check the internet connection/);
    const text = await failure.textContent();
    assert.match(text, /No web page could be searched or read/);
    assert.match(text, /No web search provider could be reached/);
    const calls = received.slice(offlineFrom);
    assert.deepEqual(calls.filter((call) => call.role === 'writer' || call.role === 'answer').map((call) => call.role), [],
      'no report writer and no ordinary answer request: nothing can be invented');
    const chat = await savedWhen('What is the latest Orchid release?', (saved) => saved.messages.at(-1)?.finishReason === 'error');
    const last = chat.messages.at(-1);
    assert.equal(last.finishReason, 'error');
    assert.match(last.content, /^Deep Research returned no usable evidence\. No web page could be searched or read/);
    assert.equal(chat.messages.findLast((message) => message.role === 'user').web, undefined, 'no evidence was attached');
    await page.screenshot({ path: path.join(run, 'offline-research.png') });
    return { modelCalls: calls.map((call) => call.role) };
  });

  // Web Search mode, same offline network.
  await page.evaluate(() => {
    const settings = JSON.parse(localStorage.getItem('ds4web.settings.v2'));
    localStorage.setItem('ds4web.settings.v2', JSON.stringify({ ...settings, webMode: 'search' }));
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('#composer-input').waitFor({ state: 'visible', timeout: 60_000 });
  const searchFrom = received.length;
  await page.locator('#btn-new-chat').click();
  await page.locator('#composer-input').fill('Who maintains Orchid today?');
  await page.locator('#composer-input').press('Enter');
  const searchFailure = page.locator('.msg--assistant').filter({ hasText: 'Web search returned no usable sources' });
  await searchFailure.waitFor({ state: 'visible', timeout: 60_000 });

  await check('offline Web Search ends with a clear failure and no answer is generated (no-internet-connection)', async () => {
    assert.match(await searchFailure.textContent(), /No web search provider could be reached/);
    const calls = received.slice(searchFrom);
    assert.deepEqual(calls.filter((call) => call.role === 'answer' || call.role === 'writer'), [], 'the model is never asked to answer without evidence');
    await page.screenshot({ path: path.join(run, 'offline-search.png') });
  });

  await check('no page errors and no model launch', async () => {
    assert.deepEqual(pageErrors, []);
    assert.deepEqual(forbidden, []);
  });
} catch (error) {
  report.error = String(error.stack || error);
  process.exitCode = 1;
  console.error(error);
} finally {
  await browser?.close().catch(() => {});
  engine.closeAllConnections(); engine.close();
  site.closeAllConnections(); site.close();
  try { process.kill(-host.pid, 'SIGTERM'); } catch { /* gone */ }
  await Promise.race([hostExited, sleep(5000)]);
  report.status = process.exitCode ? 'FAIL' : 'PASS';
  save();
  console.log(`web_research_host_test (${browserName}): ${report.status}; evidence ${run}`);
}

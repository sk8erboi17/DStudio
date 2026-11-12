// Cloud and remote backends from the Settings Connection pane, in the
// production page: saving the DeepSeek API key or a Server URL and switching
// the backend; a missing, wrong or out-of-credit key; and switching back to
// the local model after cloud work.
//
// SIMULATED: the DeepSeek API is a loopback HTTP server that answers like the
// provider (its /v1/models catalog, SSE answers, and its 401 and 402 error
// bodies); the browser's requests to https://api.deepseek.com are routed to
// it, every other external request is refused. The local host and engine are
// tests/support/ui_mock_server.mjs, and a second loopback server stands in for
// a remote OpenAI-compatible endpoint. Authored replies, no model, no network.
//   node tests/browser/ui_cloud_backend_playwright_test.mjs
//   DSTUDIO_TEST_BROWSER=webkit node tests/browser/ui_cloud_backend_playwright_test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import {chromium, webkit} from 'playwright';
import {uiMockServer, jsonReply, requestBody, seedUi, sseDelta, sseDone} from '../support/ui_mock_server.mjs';

const browserName = process.env.DSTUDIO_TEST_BROWSER || 'chromium';
assert.ok(['chromium', 'webkit'].includes(browserName));
const LOCAL_GGUF = 'gguf/DeepSeek-V4-Flash-Vision-Exp-test.gguf';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const cors = {'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, content-type, accept',
  'access-control-allow-methods': 'GET, POST, OPTIONS'};

// --- the local host and engine (simulated) --------------------------------
const local = {chats: [], starts: [], running: true, ready: true};
const host = await uiMockServer(async (req, res, url) => {
  if (url.pathname === '/api/status') {
    jsonReply(res, {mode: 'server', running: local.running, ready: local.ready, loadPct: local.ready ? 100 : 40,
      stage: local.ready ? 'Ready (simulated)' : local.running ? 'Loading (simulated)' : 'Stopped (simulated)',
      agentWorking: false, workdir: '', ds4dirOk: true, webdirOk: true, lan: false, modelFile: LOCAL_GGUF,
      nativeVisionActive: true, variant: 'flash', variants: {flash: true},
      config: {ctx: 65536, power: 100, think: 'off', ssdStreaming: 'auto'}});
    return true;
  }
  if (url.pathname === '/api/start') {
    const body = await requestBody(req);
    local.starts.push(body);
    local.running = true; local.ready = false;
    setTimeout(() => {local.ready = true;}, 600);
    jsonReply(res, {ok: true, ctx: Number(body.ctx) || 65536});
    return true;
  }
  // Opening Settings runs the bundled-components check.
  if (url.pathname === '/api/updates/check') {jsonReply(res, {ok: true, sections: []}); return true;}
  if (url.pathname !== '/v1/chat/completions') return false;
  const body = await requestBody(req);
  local.chats.push({body, authorization: req.headers.authorization || null});
  res.writeHead(200, {'content-type': 'text/event-stream', 'cache-control': 'no-cache'});
  sseDelta(res, `Local answer ${local.chats.length}.`); sseDone(res);
  return true;
});

// --- the cloud provider and a remote endpoint (simulated) ------------------
const PROVIDER_ERRORS = {
  'sk-wrong-1234': [401, {error: {message: 'Authentication Fails, Your api key: ****1234 is invalid', type: 'authentication_error', param: null, code: 'invalid_request_error'}}],
  'sk-no-credit': [402, {error: {message: 'Insufficient Balance', type: 'unknown_error', param: null, code: 'invalid_request_error'}}],
};
const cloud = {chats: [], models: [], preflights: 0};
const cloudServer = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {cloud.preflights++; res.writeHead(204, cors); res.end(); return;}
  const key = (req.headers.authorization || '').replace(/^Bearer /, '');
  const fail = !key ? [401, {error: {message: 'Authentication Fails (no such user)', type: 'authentication_error', param: null, code: 'invalid_request_error'}}]
    : PROVIDER_ERRORS[key];
  const reply = (status, value) => {res.writeHead(status, {...cors, 'content-type': 'application/json'}); res.end(JSON.stringify(value));};
  if (req.url === '/v1/models') {
    cloud.models.push(key);
    return fail ? reply(...fail) : reply(200, {object: 'list', data: [{id: 'deepseek-v4-flash', object: 'model', owned_by: 'deepseek'},
      {id: 'deepseek-v4-pro', object: 'model', owned_by: 'deepseek'}]});
  }
  if (req.url === '/v1/chat/completions') {
    const body = await requestBody(req);
    cloud.chats.push({key, body});
    if (fail) return reply(...fail);
    res.writeHead(200, {...cors, 'content-type': 'text/event-stream'});
    sseDelta(res, `Cloud answer ${cloud.chats.length} from ${body.model}.`); sseDone(res);
    return;
  }
  reply(404, {error: {message: 'not found'}});
});
const remote = {chats: []};
const remoteServer = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {res.writeHead(204, cors); res.end(); return;}
  if (req.url === '/v1/models') {res.writeHead(200, {...cors, 'content-type': 'application/json'}); res.end(JSON.stringify({data: [{id: 'deepseek-v4-flash'}]})); return;}
  if (req.url === '/v1/chat/completions') {
    remote.chats.push(await requestBody(req));
    res.writeHead(200, {...cors, 'content-type': 'text/event-stream'});
    sseDelta(res, `Remote answer ${remote.chats.length}.`); sseDone(res);
    return;
  }
  res.writeHead(404, cors); res.end();
});
for (const server of [cloudServer, remoteServer]) await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const cloudOrigin = `http://127.0.0.1:${cloudServer.address().port}`;
const remoteOrigin = `http://127.0.0.1:${remoteServer.address().port}`;

fs.mkdirSync('tests/.artifacts/cloud-backend', {recursive: true});
const dir = fs.mkdtempSync(`tests/.artifacts/cloud-backend/${browserName}-`);
const receipt = {scope: 'Production page; SIMULATED DeepSeek API, remote endpoint, local host and engine; authored replies, no model or network',
  browserName, cases: []};
const browser = await ({chromium, webkit})[browserName].launch();
const context = await browser.newContext({viewport: {width: 1200, height: 860}});
let page = await context.newPage();
page.setDefaultTimeout(8000);

async function openPage() {
  const evidence = await seedUi(page, host.origin, {settings: {modelGguf: LOCAL_GGUF}});
  // Registered after seedUi's catch-all, so it is consulted first.
  await page.route('https://api.deepseek.com/**', async route => {
    const target = cloudOrigin + new URL(route.request().url()).pathname;
    route.fulfill({response: await route.fetch({url: target})});
  });
  // The simulated remote endpoint is another loopback origin the test owns.
  await page.route(`${remoteOrigin}/**`, route => route.continue());
  await page.goto(host.origin);
  return evidence;
}
const saved = () => page.evaluate(() => {
  const id = JSON.parse(localStorage.getItem('ds4web.active.v2')).ids.chat;
  return JSON.parse(localStorage.getItem('ds4web.chats.v2')).chats.find(chat => chat.id === id);
});
const settings = () => page.evaluate(() => JSON.parse(localStorage.getItem('ds4web.settings.v2')));
// Settings are written to storage shortly after a change (debounced).
async function savedSettings(pick, expected) {
  const deadline = Date.now() + 5000;
  let value;
  while (Date.now() < deadline) {
    value = pick(await settings());
    if (JSON.stringify(value) === JSON.stringify(expected)) return;
    await sleep(50);
  }
  assert.deepEqual(value, expected, 'the setting was saved');
}
const last = () => page.locator('.msg--assistant').last();
async function openSettings(pane = 'connection') {
  if (!await page.locator('#set-close').isVisible()) await page.locator('#btn-settings').click();
  await page.locator(`.set-nav__b[data-pane="${pane}"]`).click();
}
async function closeSettings() {await page.locator('#set-close').click();}
async function send(text) {
  await page.locator('#composer-input').fill(text);
  await page.locator('#btn-send').click();
  await last().getByRole('button', {name: /^(Copy|Retry)$/}).first().waitFor();
  await page.locator('#btn-stop').waitFor({state: 'hidden'});
}
async function checkpoint(name, extra = {}) {
  receipt.cases.push({name, status: 'PASS', ...extra});
  await page.screenshot({path: path.join(dir, `${receipt.cases.length}.png`)});
  console.log(`PASS ${name}`);
}
// "Nothing is retried silently": the count stays put after the error is shown.
async function settledCount(list, expected) {await sleep(1500); assert.equal(list.length, expected);}

let evidence;
try {
  evidence = await openPage();

  // ---------------------------------------------------- configure-cloud-or-remote-in-settings
  await openSettings();
  assert.equal((await page.locator('#set-connection-mode').innerText()).trim(), 'Local engine');
  await page.locator('#set-baseurl').fill(remoteOrigin);
  await page.locator('#set-baseurl').press('Tab');
  await page.locator('#set-connection-mode').filter({hasText: 'Remote server'}).waitFor();
  await savedSettings(s => s.baseUrl, remoteOrigin);
  await closeSettings();
  await send('Hello remote.');
  assert.match(await last().innerText(), /Remote answer 1\./);
  assert.equal(remote.chats.length, 1); assert.equal(local.chats.length, 0);
  await openSettings();
  await page.locator('#set-baseurl').fill('');
  await page.locator('#set-baseurl').press('Tab');
  await page.locator('#set-connection-mode').filter({hasText: 'Local engine'}).waitFor();
  await checkpoint('a Server URL entered in Connection is saved and receives the chat; clearing it returns to the local engine');

  await page.locator('#set-chat-backend').selectOption('deepseek');
  await page.getByText('Add your DeepSeek API key below to activate the cloud chat.').waitFor();
  await page.locator('#set-deepseek-key').fill('sk-valid-5678');
  await page.locator('#set-deepseek-key').press('Tab');
  await page.locator('#set-connection-mode').filter({hasText: 'DeepSeek cloud'}).waitFor();
  assert.equal(await page.locator('#set-engine-process').innerText(), 'DeepSeek API');
  await openSettings('models');
  await page.locator('#set-deepseek-model-msg').filter({hasText: '2 cloud models available to this API key'}).waitFor();
  assert.deepEqual(await page.locator('#set-deepseek-model option').evaluateAll(options => options.map(o => o.value)),
    ['deepseek-v4-flash', 'deepseek-v4-pro'], 'the cloud catalog comes from the provider for this key');
  assert.ok(cloud.models.includes('sk-valid-5678'));
  await page.locator('#set-deepseek-model').selectOption('deepseek-v4-pro');
  await closeSettings();
  const startsBeforeCloud = local.starts.length;
  await send('Hello cloud.');
  assert.match(await last().innerText(), /Cloud answer 1 from deepseek-v4-pro\./);
  assert.equal(cloud.chats.length, 1);
  assert.equal(cloud.chats[0].key, 'sk-valid-5678', 'the saved key is sent as the bearer token');
  assert.equal(cloud.chats[0].body.model, 'deepseek-v4-pro');
  assert.deepEqual(cloud.chats[0].body.thinking, {type: 'disabled'}, 'the provider\'s own thinking parameter');
  assert.equal(local.chats.length, 0, 'the local engine received nothing');
  assert.equal(local.starts.length, startsBeforeCloud, 'no local model was started for a cloud chat');
  await savedSettings(s => [s.chatBackend, s.deepseekApiKey, s.deepseekModel], ['deepseek', 'sk-valid-5678', 'deepseek-v4-pro']);
  // A reopened page restores the saved backend and key.
  await page.close();
  page = await context.newPage(); page.setDefaultTimeout(8000);
  evidence = await openPage();
  await openSettings();
  assert.equal(await page.locator('#set-chat-backend').inputValue(), 'deepseek');
  assert.equal(await page.locator('#set-deepseek-key').inputValue(), 'sk-valid-5678');
  assert.equal((await page.locator('#set-connection-mode').innerText()).trim(), 'DeepSeek cloud');
  await closeSettings();
  await checkpoint('the DeepSeek key and backend saved in Connection serve the chat and survive a reopened page',
    {cloudRequest: {model: cloud.chats[0].body.model, thinking: cloud.chats[0].body.thinking}});

  // ---------------------------------------------------- cloud-key-missing-or-rejected
  for (const [key, message] of [['sk-wrong-1234', /Authentication Fails, Your api key: \*\*\*\*1234 is invalid/],
    ['sk-no-credit', /Insufficient Balance/]]) {
    await openSettings();
    await page.locator('#set-deepseek-key').fill(key);
    await page.locator('#set-deepseek-key').press('Tab');
    await closeSettings();
    const before = cloud.chats.length;
    await send(`Question with ${key}.`);
    await last().getByRole('button', {name: 'Retry', exact: true}).waitFor();
    assert.match(await last().innerText(), message, 'the provider\'s own error text is shown');
    assert.equal((await saved()).messages.at(-1).finishReason, 'error');
    await settledCount(cloud.chats, before + 1);
    assert.equal(cloud.chats.at(-1).key, key);
    assert.equal(local.chats.length, 0, 'no fallback to the local model');
  }
  await checkpoint('a wrong or out-of-credit key shows the provider\'s error once, with Retry, and nothing is retried');

  await openSettings();
  await page.locator('#set-deepseek-key').fill('');
  await page.locator('#set-deepseek-key').press('Tab');
  assert.equal(await page.locator('#set-chat-backend').inputValue(), 'deepseek', 'the cloud backend is still the selected one');
  await closeSettings();
  const cloudBefore = cloud.chats.length, startsBefore = local.starts.length;
  await send('Question without a key.');
  receipt.missingKeyAnswer = await last().innerText();
  await settledCount(local.chats, 0);
  assert.equal(local.starts.length, startsBefore, 'no local model is started instead of the selected cloud backend');
  assert.equal(cloud.chats.length, cloudBefore, 'nothing is sent to the provider without a key');
  assert.match(receipt.missingKeyAnswer, /DeepSeek API key/);
  assert.equal((await saved()).messages.at(-1).finishReason, 'error');
  await checkpoint('a missing key is reported instead of silently using another backend');

  // ---------------------------------------------------- restore-local-engine-after-cloud-run
  await openSettings();
  await page.locator('#set-deepseek-key').fill('sk-valid-5678');
  await page.locator('#set-deepseek-key').press('Tab');
  await closeSettings();
  await send('One more cloud question.');
  assert.match(await last().innerText(), /Cloud answer \d+ from deepseek-v4-pro\./);
  const cloudDone = cloud.chats.length;
  local.running = false; local.ready = false;   // the local model is not loaded while working in the cloud
  await openSettings();
  await page.locator('#set-chat-backend').selectOption('local');
  await page.locator('#set-connection-mode').filter({hasText: 'Local engine'}).waitFor();
  await closeSettings();
  const startsBeforeLocal = local.starts.length;
  await send('Back on the local model.');
  assert.match(await last().innerText(), /Local answer 1\./);
  assert.equal(local.starts.length, startsBeforeLocal + 1, 'the local model was started once');
  const start = local.starts.at(-1);
  assert.equal(start.gguf, LOCAL_GGUF, 'the saved local model is the one started, not the cloud model');
  assert.notEqual(start.modelBackend, 'remote');
  assert.equal(local.chats[0].authorization, null, 'no cloud key is sent to the local engine');
  assert.equal(local.chats[0].body.think, false, 'the local engine\'s own thinking parameter');
  assert.equal(local.chats[0].body.thinking, undefined);
  const history = local.chats[0].body.messages.map(m => m.content);
  assert.ok(history.includes('Hello cloud.') && history.at(-1) === 'Back on the local model.', 'the conversation continues');
  await settledCount(cloud.chats, cloudDone);
  await checkpoint('switching back to Local starts the saved local model and continues the conversation there',
    {start: {gguf: start.gguf, mode: start.mode}});

  assert.deepEqual(evidence.errors, []); assert.deepEqual(evidence.external, []); assert.deepEqual(host.missing, []);
} catch (error) {
  receipt.cases.push({status: 'FAIL', error: error.stack, external: evidence?.external, missing: host.missing});
  console.log(`FAIL ${error.stack}`);
  await page.screenshot({path: path.join(dir, 'failure.png')}).catch(() => {});
  process.exitCode = 1;
} finally {
  receipt.requests = {local, cloud, remote};
  fs.writeFileSync(path.join(dir, 'receipt.json'), JSON.stringify(receipt, null, 2));
  await browser.close(); host.close();
  for (const server of [cloudServer, remoteServer]) {server.closeAllConnections(); server.close();}
  console.log(`Cloud backend evidence (${browserName}): ${dir}`);
}

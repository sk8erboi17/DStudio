import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch (e) {
  console.log('ui_agent_design_playwright_test: playwright missing, skipping');
  process.exit(0);
}

const repoRoot = process.cwd();
const webRoot = path.join(repoRoot, 'web');
const starts = [];
const sends = [];
const chatRequests = [];
let currentMode = 'server';
let failNextAgentSend = false;

function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  if (url.pathname === '/api/status') {
    json(res, 200, {
      mode: currentMode,
      running: true,
      ready: true,
      loadPct: 100,
      stage: 'Ready',
      agentWorking: false,
      workdir: '/tmp/dstudio-ui-test',
      jsonl: true,
      ds4dirOk: true,
      webdirOk: true,
      lan: false,
      variants: { flash: true, pro: false },
      variant: 'flash',
      engineLine: 'ui test ready',
    });
    return;
  }
  if (url.pathname === '/api/start' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req) || '{}');
    starts.push(body);
    currentMode = body.mode || 'server';
    json(res, 200, { ok: true });
    return;
  }
  if (url.pathname === '/api/agent/send' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req) || '{}');
    sends.push({ mode: currentMode, body });
    if (failNextAgentSend) {
      failNextAgentSend = false;
      json(res, 409, {
        ok: false,
        error: 'agent/design runtime is not active',
        mode: currentMode,
        running: false,
        ready: false,
        engineError: 'mock process exited',
      });
      return;
    }
    json(res, 200, { ok: true, from: 0, at: 1 });
    return;
  }
  if (url.pathname === '/api/agent/poll') {
    json(res, 200, { base: 0, len: 0, working: false, ready: true, loadPct: 100, text: '' });
    return;
  }
  if (url.pathname === '/api/agent/interrupt' && req.method === 'POST') {
    json(res, 200, { ok: true });
    return;
  }
  if (url.pathname === '/api/store') {
    json(res, 200, { rev: 0, data: null });
    return;
  }
  if (url.pathname === '/api/storerev') {
    json(res, 200, { rev: 0 });
    return;
  }
  if (url.pathname === '/api/skills' || url.pathname === '/api/user-skills' || url.pathname === '/api/design-systems') {
    json(res, 200, { ok: true, skills: [], systems: [] });
    return;
  }
  if (url.pathname === '/v1/models') {
    json(res, 200, { data: [{ id: 'deepseek-v4-flash' }] });
    return;
  }
  if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
    chatRequests.push(JSON.parse(await readBody(req) || '{}'));
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
    });
    res.write('data: {"choices":[{"delta":{"content":"partial answer"},"finish_reason":"stop"}]}\n\n');
    res.end();
    return;
  }

  const file = url.pathname === '/' ? path.join(webRoot, 'index.html') : path.join(webRoot, url.pathname);
  if (!file.startsWith(webRoot) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404);
    res.end('not found');
    return;
  }
  res.writeHead(200, { 'content-type': file.endsWith('.html') ? 'text/html' : 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

let browser;
try {
  browser = await chromium.launch();
} catch (e) {
  try {
    browser = await chromium.launch({ channel: 'chrome' });
  } catch (chromeError) {
    server.close();
    console.log('ui_agent_design_playwright_test: browser missing, skipping');
    process.exit(0);
  }
}

async function waitFor(fn, label, details = () => '') {
  const start = Date.now();
  while (Date.now() - start < 5000) {
    if (fn()) return;
    await delay(50);
  }
  assert.fail(`${label}${details() ? `\n${details()}` : ''}`);
}

try {
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e?.stack || e?.message || String(e)));
  page.on('console', (msg) => {
    if (msg.type() === 'error') pageErrors.push(msg.text());
  });
  await page.addInitScript(() => {
    const now = Date.now();
    localStorage.setItem('ds4web.settings.v1', JSON.stringify({
      v: 1,
      onboarded: true,
      theme: 'light',
      model: 'deepseek-v4-flash',
      modelVariant: 'flash',
      thinkLevel: 'high',
      ctxSize: 65536,
      useJsonlPatch: true,
      webMode: 'off',
      workdirs: { agent: '/tmp/dstudio-ui-agent', design: '/tmp/dstudio-ui-design' },
      onboardedVersion: 8,
    }));
    localStorage.setItem('ds4web.chats.v1', JSON.stringify({
      v: 1,
      deleted: [],
      chats: [
        { id: 'agent-seed', mode: 'agent', title: 'Agent seed', createdAt: now - 2, updatedAt: now - 2, messages: [], transcript: 'seed' },
        { id: 'design-seed', mode: 'design', title: 'Design seed', createdAt: now - 1, updatedAt: now - 1, messages: [], transcript: 'seed' },
      ],
    }));
    localStorage.setItem('ds4web.active.v1', JSON.stringify({ v: 1, ids: { chat: null, agent: 'agent-seed', design: 'design-seed' } }));
  });

  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
  await page.locator('#composer-input').fill('Test incomplete chat stream');
  await page.locator('#btn-send').click();
  await page.getByText(/Response incomplete: stream ended before data: \[DONE\]/).waitFor({ timeout: 5000 });
  await page.getByRole('button', { name: 'Continue' }).waitFor({ timeout: 5000 });
  assert.equal(chatRequests.length, 1, 'chat request should reach /v1/chat/completions');

  await page.locator('#tab-agent').click();
  await page.waitForFunction(() => !document.querySelector('#agent-view')?.hidden);
  await page.locator('#composer-input').fill('Analyze this project');
  await page.locator('#btn-send').click();
  const debugDetails = () => JSON.stringify({ starts, sends, pageErrors }, null, 2);
  await waitFor(
    () => sends.some((s) => s.mode === 'agent' && /Analyze this project/.test(s.body?.displayPrompt || '')),
    'agent send did not reach /api/agent/send',
    debugDetails,
  );

  await page.locator('#tab-design').click();
  await page.waitForFunction(() => !document.querySelector('#agent-view')?.hidden);
  await page.locator('#composer-input').fill('Design a landing page');
  await page.locator('#btn-send').click();
  await waitFor(
    () => sends.some((s) => s.mode === 'design' && /Design a landing page/.test(s.body?.displayPrompt || '')),
    'design send did not reach /api/agent/send',
    debugDetails,
  );

  failNextAgentSend = true;
  await page.locator('#composer-input').fill('Trigger send failure');
  await page.locator('#btn-send').click();
  await page.getByText(/Design send failed: agent\/design runtime is not active/).waitFor({ timeout: 5000 });

  assert.ok(starts.some((s) => s.mode === 'agent'), 'agent tab should start the agent runtime');
  assert.ok(starts.some((s) => s.mode === 'design'), 'design tab should start the design runtime');
  console.log('ui_agent_design_playwright_test: ok');
} finally {
  await browser.close().catch(() => {});
  server.close();
}

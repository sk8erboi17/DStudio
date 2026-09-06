import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.log('ui_live_vision_playwright_test: playwright missing, NOT RUN');
  process.exit(1);
}

const baseUrl = String(process.env.DSTUDIO_LIVE_URL || '').replace(/\/+$/, '');
if (!baseUrl) {
  console.log('ui_live_vision_playwright_test: set DSTUDIO_LIVE_URL to run the live gate');
  process.exit(1);
}

const requestJson = async (pathname, opts = {}) => {
  const response = await fetch(`${baseUrl}${pathname}`, opts);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${pathname}: ${response.status} ${data.error || ''}`.trim());
  return data;
};

let initialStatus = await requestJson('/api/status');
assert.match(initialStatus.modelFile || '', /DeepSeek-V4-Flash-Vision-Exp/i,
  'live frontend gate requires the currently selected DeepSeek Vision-Exp model');
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'dstudio-live-vision-'));

async function waitStatus(predicate, label, timeoutMs = 240_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      last = await requestJson('/api/status');
      if (predicate(last)) return last;
      if (last.engineError) throw new Error(last.engineError);
    } catch (error) {
      if (/engineError/.test(String(error))) throw error;
    }
    await delay(250);
  }
  throw new Error(`${label}: ${JSON.stringify(last)}`);
}

async function waitIdle(timeoutMs = 120_000) {
  return waitStatus((status) => status.agentWorking === false && status.agentSessionWorking === false,
    'pipe runtime did not become idle', timeoutMs);
}

if (initialStatus.mode !== 'server' || initialStatus.running !== true || initialStatus.ready !== true) {
  await requestJson('/api/start', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-requested-with': 'ds4web',
    },
    body: JSON.stringify({
      force: true,
      mode: 'server',
      model: 'standard',
      variant: initialStatus.variant || 'flash',
      gguf: initialStatus.modelFile || '',
      ctx: initialStatus.config?.ctx || 131072,
      power: initialStatus.config?.power || 100,
      think: initialStatus.config?.think || 'high',
      ssdStreaming: initialStatus.config?.ssdStreaming || 'off',
      metalHotlistSeed: initialStatus.config?.metalHotlistSeed === true,
      dspark: initialStatus.config?.dspark === true,
    }),
  });
  initialStatus = await waitStatus((status) => status.mode === 'server' && status.ready === true,
    'live gate could not restore Chat');
}

let browser;
try {
  browser = await chromium.launch();
} catch {
  browser = await chromium.launch({ channel: 'chrome' });
}

const pageErrors = [];
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  page.on('pageerror', (error) => pageErrors.push(error?.stack || error?.message || String(error)));
  page.on('console', (message) => {
    if (message.type() === 'error' && !/favicon|404 \(Not Found\)/i.test(message.text()))
      pageErrors.push(message.text());
  });
  // The live gate owns an isolated browser profile. Keep its synthetic chats
  // out of the native app's shared conversation store.
  await page.route('**/api/store', async (route) => {
    if (route.request().method() === 'GET')
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"rev":0,"data":null}' });
    else
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true,"rev":0}' });
  });
  await page.route('**/api/storerev', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{"rev":0}' }));
  await page.addInitScript(({ workspace: selectedWorkspace, status }) => {
    const now = Date.now();
    window.ds4PickDirectory = async () => selectedWorkspace;
    localStorage.setItem('ds4web.onboarded.v2', JSON.stringify({ v: 2, done: true, at: now }));
    localStorage.setItem('ds4web.settings.v2', JSON.stringify({
      v: 2,
      onboarded: true,
      theme: 'dark',
      model: 'deepseek-v4-flash',
      modelVariant: status.variant || 'flash',
      modelGguf: status.modelFile || '',
      thinkLevel: status.config?.think || 'high',
      ctxSize: status.config?.ctx || 131072,
      enginePower: status.config?.power || 100,
      ssdStreaming: status.config?.ssdStreaming || 'off',
      metalHotlistSeed: status.config?.metalHotlistSeed === true,
      dspark: status.config?.dspark === true,
      designSystem: 'forma',
      webMode: 'off',
      workdirs: {
        agent: selectedWorkspace,
        cowork: selectedWorkspace,
        design: selectedWorkspace,
      },
    }));
    const chats = ['chat', 'agent', 'cowork', 'design', 'roadmap'].map((mode, index) => ({
      id: `live-${mode}`,
      mode,
      title: mode === 'roadmap' ? 'New roadmap' : `New ${mode === 'chat' ? 'chat' : mode}`,
      createdAt: now + index,
      updatedAt: now + index,
      model: 'deepseek-v4-flash',
      messages: [],
      ...(mode === 'agent' || mode === 'cowork' || mode === 'design' ? { transcript: '' } : {}),
    }));
    localStorage.setItem('ds4web.chats.v2', JSON.stringify({ v: 2, chats, deleted: [] }));
    localStorage.setItem('ds4web.active.v2', JSON.stringify({
      v: 2,
      ids: Object.fromEntries(chats.map((chat) => [chat.mode, chat.id])),
    }));
  }, { workspace, status: initialStatus });

  await page.goto(`${baseUrl}/`, { waitUntil: 'domcontentloaded' });
  await page.locator('#composer-input').waitFor({ state: 'visible', timeout: 30_000 });

  // Chat: request reaches the real Vision server, then Stop returns the shared
  // composer to an idle state. The response content is deliberately not graded.
  const chatResponse = page.waitForResponse((response) =>
    response.url().includes('/v1/chat/completions') && response.request().method() === 'POST', { timeout: 120_000 });
  await page.locator('#composer-input').fill('Live frontend smoke: answer with one short sentence.');
  await page.locator('#btn-send').click();
  await chatResponse;
  await page.locator('#btn-stop').waitFor({ state: 'visible', timeout: 30_000 });
  await page.locator('#btn-stop').click();
  await page.locator('#btn-send').waitFor({ state: 'visible', timeout: 30_000 });

  async function runPipeMode({ tab, mode, prompt }) {
    await page.locator(tab).click();
    const ready = await waitStatus((status) => status.mode === mode && status.running === true && status.ready === true,
      `${mode} did not become ready`);
    assert.match(ready.modelFile || '', /DeepSeek-V4-Flash-Vision-Exp/i,
      `${mode} must keep the selected Vision model`);
    await page.waitForFunction((expectedMode) =>
      !document.querySelector('#agent-view')?.hidden &&
      document.querySelector('#pipe-head-mode')?.textContent?.toLowerCase().startsWith(expectedMode),
    mode, { timeout: 60_000 });
    await page.locator('#composer-input').fill(prompt);
    const sendResponse = page.waitForResponse((response) =>
      response.url().includes('/api/agent/send') && response.request().method() === 'POST', { timeout: 600_000 });
    await page.locator('#btn-send').click();
    const response = await sendResponse;
    assert.ok(response.ok(), `${mode} first prompt should be accepted`);
    await page.locator('#btn-stop').waitFor({ state: 'visible', timeout: 30_000 });
    await page.locator('#btn-stop').click();
    await waitIdle();
    await page.locator('#btn-send').waitFor({ state: 'visible', timeout: 30_000 });
    assert.equal(await page.locator('#agent-view').innerText().then((text) =>
      /prefillDone|deleted session|new session started/.test(text)), false,
    `${mode} must not render internal pipe bookkeeping`);
  }

  await runPipeMode({
    tab: '#tab-agent',
    mode: 'agent',
    prompt: 'Live Agent smoke: reply briefly and do not call tools.',
  });
  await runPipeMode({
    tab: '#tab-cowork',
    mode: 'cowork',
    prompt: 'Live Cowork smoke: reply briefly; there are no attachments.',
  });
  await runPipeMode({
    tab: '#tab-design',
    mode: 'design',
    prompt: 'Live Design smoke: ask one short clarification question; do not create or edit files.',
  });

  // Learn and Settings use real navigation but do not change any preference.
  await page.locator('#tab-roadmap').click();
  await waitStatus((status) => status.mode === 'server' && status.running === true && status.ready === true,
    'Learn did not restore the shared server runtime');
  await page.waitForFunction(() => document.body.classList.contains('roadmap-mode'), null, { timeout: 30_000 });
  await page.locator('#btn-settings').click();
  await page.locator('#settings-dialog[open]').waitFor({ state: 'visible', timeout: 30_000 });
  await page.locator('#set-nav [data-pane="vision"]').click();
  await page.waitForFunction(() =>
    /DeepSeek Vision-Exp encoder.*Installed/s.test(
      document.querySelector('#set-native-vision-support')?.textContent || ''),
  null, { timeout: 30_000 });
  assert.match(await page.locator('#set-native-vision-support').innerText(), /DeepSeek Vision-Exp encoder.*Installed/s);
  await page.locator('#set-nav [data-pane="interface"]').click();
  assert.equal(await page.locator('#set-theme .set-seg__b.on').innerText(), 'Dark');
  await page.locator('#set-close').click();

  assert.deepEqual(pageErrors, [], `live page errors:\n${pageErrors.join('\n')}`);
  console.log('ui_live_vision_playwright_test: ok (Chat, Agent, Cowork, Design, Learn, Settings)');
} finally {
  await browser.close().catch(() => {});
  fs.rmSync(workspace, { recursive: true, force: true });
}

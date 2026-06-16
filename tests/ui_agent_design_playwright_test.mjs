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
const sessions = [];
const chatRequests = [];
let currentMode = 'server';
let currentWorkdir = '/tmp/dstudio-ui-test';
const staleAgentWorkdir = '/tmp/dstudio-missing-agent';
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
      workdir: currentWorkdir,
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
    if (body.workdir === staleAgentWorkdir) {
      json(res, 400, {
        ok: false,
        code: 'workdir_missing',
        mode: body.mode || 'agent',
        workdir: body.workdir,
        error: `workdir not found: ${body.workdir}`,
      });
      return;
    }
    currentMode = body.mode || 'server';
    if (body.workdir) currentWorkdir = body.workdir;
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
  if (url.pathname === '/api/design/session' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req) || '{}');
    sessions.push(body);
    json(res, 200, { ok: true });
    return;
  }
  if (url.pathname === '/api/design/events') {
    json(res, 200, { ok: true, events: [] });
    return;
  }
  if (url.pathname === '/api/design/state') {
    json(res, 200, { ok: true, state: { seq: 0, phase: 'idle', todos: [] } });
    return;
  }
  if (url.pathname === '/api/design/artifacts') {
    json(res, 200, { ok: true, artifacts: [] });
    return;
  }
  if (url.pathname === '/api/design/files') {
    json(res, 200, { ok: true, files: [] });
    return;
  }
  if (url.pathname === '/api/fs/list' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req) || '{}');
    json(res, 200, { ok: true, path: body.path || '/tmp', entries: 3, dirs: [] });
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
  if (url.pathname === '/api/skills') {
    json(res, 200, { ok: true, skills: [
      { id: 'digits-fintech-swiss-template', name: 'digits-fintech-swiss-template', description: 'Swiss-grid fintech deck template in black / warm paper / neon-lime contrast.', modes: '[design]', category: 'deck-document', outputKinds: 'hyperframes', upstream: 'open-design/digits-fintech-swiss-template', hasExample: true },
      { id: 'swiss-creative-mode-template', name: 'swiss-creative-mode-template', description: 'Swiss-inspired creative-mode presentation template skill with bold editorial typography.', modes: '[design]', category: 'deck-document', outputKinds: 'hyperframes', upstream: 'open-design/swiss-creative-mode-template', hasExample: true },
      { id: 'landing-page', name: 'landing-page', description: 'Non-template skill', modes: '[design]', upstream: 'dstudio/landing-page', hasExample: false },
      { id: 'ecc-security-review', name: 'ecc-security-review', description: 'Imported ECC security checklist and review patterns.', modes: '[agent]', category: 'imported-agent', outputKinds: 'markdown', upstream: 'ECC/.agents/skills/security-review', hasExample: false },
      { id: 'superpowers-systematic-debugging', name: 'superpowers-systematic-debugging', description: 'Imported Superpowers root-cause debugging workflow.', modes: '[agent]', category: 'imported-agent', outputKinds: 'markdown', upstream: 'superpowers/systematic-debugging', hasExample: false },
      { id: 'anthropic-claude-code-security-review', name: 'anthropic-claude-code-security-review', description: 'Imported Anthropic high-confidence branch security review.', modes: '[agent]', category: 'imported-agent', outputKinds: 'markdown', upstream: 'claude-code-security-review/.claude/commands/security-review.md', hasExample: false },
    ] });
    return;
  }
  if (url.pathname.startsWith('/api/skill-preview/')) {
    if (url.pathname.endsWith('/template.css')) {
      res.writeHead(200, { 'content-type': 'text/css; charset=utf-8' });
      res.end('body{margin:0;font:24px system-ui;background:#f7f1de;color:#111}.styled{color:rgb(10, 99, 40);padding:36px}');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><html><head><link rel="stylesheet" href="./template.css"></head><body><main class="styled"><h1>Original Open Design Example</h1><p>Template preview</p></main></body></html>');
    return;
  }
  if (url.pathname.startsWith('/api/design-system-preview/')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><html><body style="margin:0;font:20px system-ui;background:#0b1020;color:#f8fafc"><main style="padding:32px"><h1>Airbnb Components</h1><p>Original local design-system fixture</p></main></body></html>');
    return;
  }
  if (url.pathname === '/api/design-systems') {
    json(res, 200, { ok: true, designSystems: [
      { id: 'airbnb', name: 'Airbnb', description: 'Travel marketplace. Warm coral accent, photography-driven, rounded UI.', modes: '', category: 'general', outputKinds: 'html', upstream: 'open-design/airbnb', hasComponents: true },
      { id: 'apple', name: 'Apple', description: 'Refined, spacious, deferential. Premium through restraint and clarity.', modes: '', category: 'web-ui-prototype', outputKinds: 'image-brief', upstream: 'dstudio/apple', hasComponents: false },
    ] });
    return;
  }
  if (url.pathname === '/api/user-skills') {
    json(res, 200, { ok: true, skills: [], systems: [], designSystems: [] });
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
    window.ds4PickDirectory = async ({ mode }) => (
      mode === 'design' ? '/tmp/dstudio-ui-design' : '/tmp/dstudio-ui-agent'
    );
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
      workdirs: { agent: '/tmp/dstudio-missing-agent', design: '/tmp/dstudio-ui-design' },
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
  await waitFor(
    () => starts.some((s) => s.workdir === staleAgentWorkdir) &&
      starts.some((s) => s.mode === 'agent' && s.workdir === '/tmp/dstudio-ui-agent'),
    'stale Agent workdir should be rejected, cleared and replaced through the picker',
    () => JSON.stringify({ starts, pageErrors }, null, 2),
  );
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('ds4web.settings.v1')).workdirs.agent === '/tmp/dstudio-ui-agent');
  const agentWorkdirSetting = await page.evaluate(() => JSON.parse(localStorage.getItem('ds4web.settings.v1')).workdirs.agent);
  assert.equal(agentWorkdirSetting, '/tmp/dstudio-ui-agent', 'Agent workdir setting should be repaired after a stale path');
  const startsBeforeSkillPick = starts.length;
  await page.locator('#cbar-gear').click();
  await page.locator('.skill-open').click();
  await page.getByRole('dialog', { name: /Your skills/i }).waitFor({ timeout: 5000 });
  await page.locator('.skills-cat').filter({ hasText: /Agent \/ Workflow/ }).click();
  await page.locator('.skill-card').filter({ hasText: 'ecc-security-review' }).click();
  assert.equal(starts.length, startsBeforeSkillPick, 'picking an Agent skill should not restart the runtime');

  await page.locator('#composer-input').fill([
    'Review this authentication endpoint before I merge it.',
    'It accepts user input, writes an audit event, and returns a session token through an API route.',
    'Check for concrete security problems only; avoid generic hardening advice unless the code path is exploitable.',
  ].join('\n\n'));
  await page.locator('#btn-send').click();
  const debugDetails = () => JSON.stringify({ starts, sends, pageErrors }, null, 2);
  await waitFor(
    () => sends.some((s) => s.mode === 'agent' &&
      /Review this authentication endpoint/.test(s.body?.displayPrompt || '') &&
      /\[DStudio selected skill: ecc-security-review\]/.test(s.body?.prompt || '')),
    'agent send did not reach /api/agent/send',
    debugDetails,
  );

  await page.locator('#cbar-gear').click();
  await page.locator('.skill-open').click();
  await page.locator('.skills-cat').filter({ hasText: /Agent \/ Workflow/ }).click();
  await page.locator('.skill-card').filter({ hasText: 'superpowers-systematic-debugging' }).click();
  await page.locator('#composer-input').fill([
    'A Playwright test fails only after the design gallery opens and closes twice.',
    'Do not patch randomly. Build a root-cause debugging plan, identify what evidence to collect, and explain which component boundary to instrument first.',
    'Assume the failing path touches cached catalog data, modal lifecycle, and runtime status polling.',
  ].join('\n\n'));
  await page.locator('#btn-send').click();
  await waitFor(
    () => sends.some((s) => s.mode === 'agent' &&
      /root-cause debugging plan/.test(s.body?.displayPrompt || '') &&
      /\[DStudio selected skill: superpowers-systematic-debugging\]/.test(s.body?.prompt || '')),
    'Superpowers skill send did not include the selected skill frame',
    debugDetails,
  );

  await page.locator('#cbar-gear').click();
  await page.locator('.skill-open').click();
  await page.locator('.skills-cat').filter({ hasText: /Agent \/ Workflow/ }).click();
  await page.locator('.skill-card').filter({ hasText: 'anthropic-claude-code-security-review' }).click();
  await page.locator('#composer-input').fill([
    'Run a branch security review for the current diff.',
    'Focus on new attack surface, auth and authorization changes, input validation, and data exposure.',
    'Return only high-confidence findings with severity, exploit scenario, and fix recommendation; say no findings if the diff is clean.',
  ].join('\n\n'));
  await page.locator('#btn-send').click();
  await waitFor(
    () => sends.some((s) => s.mode === 'agent' &&
      /branch security review/.test(s.body?.displayPrompt || '') &&
      /\[DStudio selected skill: anthropic-claude-code-security-review\]/.test(s.body?.prompt || '')),
    'Anthropic security-review skill send did not include the selected skill frame',
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

  const startsBeforeNewDesign = starts.length;
  await page.locator('#btn-new-chat').click();
  await waitFor(
    () => sessions.some((s) => s.action === 'new'),
    'new design session did not use /api/design/session',
    debugDetails,
  );
  assert.equal(starts.length, startsBeforeNewDesign, 'new design in the active workspace should not restart the design runtime');
  await page.getByRole('heading', { name: /What should we design\?/ }).waitFor({ timeout: 5000 });
  assert.equal(await page.getByRole('button', { name: /Open gallery/i }).count(), 0, 'Design brief should not require an Open gallery button');
  await page.getByText(/Digits Fintech Swiss/).waitFor({ timeout: 5000 });
  await page.getByText(/Swiss Creative Mode/).waitFor({ timeout: 5000 });
  await page.locator('.design-gallery-card__title').filter({ hasText: 'Airbnb' }).waitFor({ timeout: 5000 });
  await page.locator('.design-gallery-card__title').filter({ hasText: 'Apple' }).waitFor({ timeout: 5000 });
  await page.locator('.brief-gallery-panel__title', { hasText: 'Visual starting points' }).waitFor({ timeout: 5000 });
  const designSearch = page.getByLabel('Search design gallery');
  await designSearch.fill('Creative Mode');
  await page.locator('.design-gallery-card__title').filter({ hasText: 'Swiss Creative Mode' }).first().waitFor({ timeout: 5000 });
  assert.equal(await page.locator('.design-gallery-card__title').filter({ hasText: 'Digits Fintech Swiss' }).count(), 0, 'Design gallery search should filter cards in place');
  await designSearch.fill('');
  await page.locator('.design-gallery-card__title').filter({ hasText: 'Digits Fintech Swiss' }).first().waitFor({ timeout: 5000 });
  assert.equal(await page.getByText(/landing-page/).count(), 0, 'Design gallery should not show non-Open-Design/non-example skills');
  assert.ok(await page.getByText(/4 items/).count(), 'Design gallery should include Open Design templates and design systems');
  const designGalleryDialogOpen = await page.locator('#design-gallery-dialog').evaluate((dialog) => !!dialog.open);
  assert.equal(designGalleryDialogOpen, false, 'Design gallery should render inline rather than opening a modal');
  const digitsCard = page.locator('.design-gallery-card').filter({ hasText: 'Digits Fintech Swiss' }).first();
  await digitsCard.click();
  await page.waitForFunction(() => document.querySelector('#design-preview-dialog')?.open === true, null, { timeout: 5000 });
  assert.equal(await digitsCard.evaluate((el) => el.classList.contains('is-selected')), true, 'clicked design gallery card should stay highlighted');
  await page.frameLocator('#design-preview-frame').getByRole('heading', { name: 'Original Open Design Example' }).waitFor({ timeout: 5000 });
  const previewColor = await page.frameLocator('#design-preview-frame').locator('.styled').evaluate((el) => getComputedStyle(el).color);
  assert.equal(previewColor, 'rgb(10, 99, 40)', 'template preview iframe should load original local CSS assets');
  await page.locator('#design-preview-close').click();

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

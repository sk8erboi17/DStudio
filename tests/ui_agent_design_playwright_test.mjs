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
const coworkAttachments = [];
let currentMode = 'server';
let currentWorkdir = '/tmp/dstudio-ui-test';
const staleAgentWorkdir = '/tmp/dstudio-missing-agent';
let failNextAgentSend = false;
let agentPollText = '';
let agentPollWorking = false;
let agentPollSessionWorking = false;
let agentPollDeliveredLen = 0;
let agentPollCaughtUp = 0;

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
      agentWorking: agentPollWorking,
      agentSessionWorking: agentPollSessionWorking,
      workdir: currentWorkdir,
      config: { ctx: 65536 },
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
    const from = Buffer.byteLength(agentPollText);
    if (/Selection persistence fixture/.test(body.displayPrompt || '')) {
      agentPollText += [
        '\x01USER\x02Selection persistence fixture\x01ENDUSER\x02\n',
        '\x1e' + JSON.stringify({
          type: 'tool_call',
          name: 'write',
          input: {
            path: 'src/SelectionFixture.java',
            content: 'public final class SelectionFixture { // selection-survives-refresh\\n}\\n',
          },
        }) + '\n',
        '\x1e' + JSON.stringify({
          type: 'tool_result',
          name: 'write',
          output: 'Wrote selection fixture',
        }) + '\n',
      ].join('');
      agentPollWorking = false;
    }
    if (/Cowork streaming fixture/.test(body.displayPrompt || '')) {
      agentPollText += [
        `\x01USER\x02${body.displayPrompt || 'Cowork streaming fixture'}\x01ENDUSER\x02\n`,
        'I should inspect the source before reporting a result.\n',
        '\x1e' + JSON.stringify({ type: 'reasoning_end' }) + '\n',
        '\x1e' + JSON.stringify({ type: 'tool_call_begin', name: 'read_pdf' }) + '\n',
        '🛠️ Reading ',
        '\x1e' + JSON.stringify({ type: 'tool_call_param', param: 'path', path: '' }) + '\n',
        'inbox/quarterly-report.pdf 1:500...\n',
        '\x1e' + JSON.stringify({ type: 'tool_call_begin', name: 'read' }) + '\n',
        '🛠️ Reading ',
        '\x1e' + JSON.stringify({ type: 'tool_call_param', param: 'path', path: '' }) + '\n',
        'inbox/totals.csv 1:500...\n',
      ].join('');
      agentPollWorking = true;
      setTimeout(() => {
        agentPollText += [
        '\x1e' + JSON.stringify({
          type: 'tool_call',
          name: 'read_pdf',
          input: { path: 'inbox/quarterly-report.pdf' },
        }) + '\n',
        '\x1e' + JSON.stringify({
          type: 'tool_result',
          name: 'read_pdf',
          output: 'Read 12 pages and extracted the quarterly totals.',
        }) + '\n',
        '\x1e' + JSON.stringify({
          type: 'tool_call',
          name: 'read',
          input: { path: 'inbox/totals.csv' },
        }) + '\n',
        '\x1e' + JSON.stringify({
          type: 'tool_result',
          name: 'read',
          output: 'Read 48 rows of quarterly totals.',
        }) + '\n',
        ].join('');
        agentPollText += 'I created `deliverables/quarterly-summary.xlsx` from the source data';
      }, 700);
      setTimeout(() => {
        agentPollText += ' and verified its totals against the PDF.';
        agentPollWorking = false;
      }, 1800);
    }
    if (/Design a landing page/.test(body.displayPrompt || '')) {
      agentPollText += [
        `\x01USER\x02${body.displayPrompt}\x01ENDUSER\x02\n`,
        '\x1e' + JSON.stringify({ seq: 1, type: 'run_started', run_id: 'flicker-regression' }) + '\n',
      ].join('');
      agentPollSessionWorking = false;
      agentPollWorking = true;
      setTimeout(() => {
        agentPollText += '\x1e' + JSON.stringify({
          seq: 2,
          type: 'run_done',
          run_id: 'flicker-regression',
          payload: { phase: 'idle' },
        }) + '\n';
        agentPollWorking = false;
      }, 900);
    }
    json(res, 200, { ok: true, from, at: Buffer.byteLength(agentPollText) });
    return;
  }
  if (url.pathname === '/api/agent/poll') {
    const since = Math.max(0, Number(url.searchParams.get('since')) || 0);
    const raw = Buffer.from(agentPollText);
    const text = raw.subarray(Math.min(since, raw.length)).toString('utf8');
    agentPollDeliveredLen = raw.length;
    if (since >= raw.length && !agentPollWorking) agentPollCaughtUp++;
    json(res, 200, {
      base: 0,
      len: raw.length,
      working: agentPollWorking,
      sessionWorking: agentPollSessionWorking,
      ready: true,
      loadPct: 100,
      text,
    });
    return;
  }
  if (url.pathname === '/api/agent/interrupt' && req.method === 'POST') {
    json(res, 200, { ok: true });
    return;
  }
  if (url.pathname === '/api/cowork/attach-file' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req) || '{}');
    coworkAttachments.push(body);
    json(res, 200, {
      ok: true,
      name: body.name || 'document.pdf',
      rel: `inbox/${body.name || 'document.pdf'}`,
    });
    return;
  }
  if (url.pathname === '/api/design/session' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req) || '{}');
    if (agentPollWorking) {
      json(res, 409, { ok: false, error: 'agent is busy' });
      return;
    }
    sessions.push(body);
    if (body.action === 'list') {
      agentPollSessionWorking = true;
      agentPollWorking = true;
      const frame = '\x1e' + JSON.stringify({
        type: 'sessions',
        sessions: [{ sha: 'f1c7e2a9', title: 'Design a landing page', current: true }],
      }) + '\n';
      const splitAt = Math.floor(frame.length / 2);
      setTimeout(() => {
        agentPollText += frame.slice(0, splitAt);
      }, 350);
      setTimeout(() => {
        agentPollText += frame.slice(splitAt);
        agentPollWorking = false;
        agentPollSessionWorking = false;
      }, 1100);
    }
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
    json(res, 200, { ok: true, skills: [
      { id: 'ecc-security-review', name: 'ecc-security-review', description: 'User-created security checklist and review patterns.', modes: '[agent,cowork]' },
      { id: 'superpowers-systematic-debugging', name: 'superpowers-systematic-debugging', description: 'User-created root-cause debugging workflow.', modes: '[agent]' },
      { id: 'anthropic-claude-code-security-review', name: 'anthropic-claude-code-security-review', description: 'User-created high-confidence branch security review.', modes: '[agent]' },
    ] });
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
    await delay(250);
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
      mode === 'design' ? '/tmp/dstudio-ui-design'
        : mode === 'cowork' ? '/tmp/dstudio-ui-cowork'
        : '/tmp/dstudio-ui-agent'
    );
    localStorage.setItem('ds4web.settings.v2', JSON.stringify({
      v: 2,
      onboarded: true,
      theme: 'light',
      model: 'deepseek-v4-flash',
      modelVariant: 'flash',
      thinkLevel: 'high',
      ctxSize: 65536,
      webMode: 'off',
      workdirs: { agent: '/tmp/dstudio-missing-agent', cowork: '/tmp/dstudio-ui-cowork', design: '/tmp/dstudio-ui-design' },
    }));
    localStorage.setItem('ds4web.chats.v2', JSON.stringify({
      v: 2,
      deleted: [],
      chats: [
        { id: 'agent-seed', mode: 'agent', title: 'Agent seed', createdAt: now - 2, updatedAt: now - 2, messages: [], transcript: 'seed' },
        { id: 'cowork-seed', mode: 'cowork', title: 'Cowork seed', createdAt: now - 1, updatedAt: now - 1, messages: [], transcript: '' },
        { id: 'design-seed', mode: 'design', title: 'Design seed', createdAt: now - 1, updatedAt: now - 1, messages: [], transcript: 'seed' },
      ],
    }));
    localStorage.setItem('ds4web.active.v2', JSON.stringify({ v: 2, ids: { chat: null, agent: 'agent-seed', cowork: 'cowork-seed', design: 'design-seed' } }));
  });

  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
  await page.locator('#composer-input').fill('Test incomplete chat stream');
  await page.locator('#btn-send').click();
  await page.locator('.msg__activity').waitFor({ timeout: 2000 });
  assert.equal(await page.locator('.msg__activity-label').textContent(), 'Preparing response');
  assert.equal(await page.locator('.msg__rate').count(), 0, 'chat should not show an estimated live token rate');
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
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('ds4web.settings.v2')).workdirs.agent === '/tmp/dstudio-ui-agent');
  const agentWorkdirSetting = await page.evaluate(() => JSON.parse(localStorage.getItem('ds4web.settings.v2')).workdirs.agent);
  assert.equal(agentWorkdirSetting, '/tmp/dstudio-ui-agent', 'Agent workdir setting should be repaired after a stale path');
  const startsBeforeSkillPick = starts.length;
  await page.locator('#cbar-gear').click();
  await page.locator('.skill-open').click();
  await page.getByRole('dialog', { name: /Your skills/i }).waitFor({ timeout: 5000 });
  await page.locator('.skills-cat').filter({ hasText: /Your skills/ }).click();
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
  await page.locator('.skills-cat').filter({ hasText: /Your skills/ }).click();
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
  await page.locator('.skills-cat').filter({ hasText: /Your skills/ }).click();
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

  await page.locator('#composer-input').fill('Selection persistence fixture');
  await page.locator('#btn-send').click();
  const selectedDiff = page.locator('.diff-txt').filter({ hasText: 'selection-survives-refresh' }).first();
  await selectedDiff.waitFor({ timeout: 5000 });
  await selectedDiff.evaluate((node) => {
    const range = document.createRange();
    range.selectNodeContents(node);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  });
  assert.match(
    await page.evaluate(() => window.getSelection()?.toString() || ''),
    /selection-survives-refresh/,
    'selection fixture should start selected',
  );
  const statusRefresh = '\x1e' + JSON.stringify({
    type: 'status',
    state: 'idle',
    prefillDone: 0,
    prefillTotal: 0,
    generated: 0,
    ctxUsed: 1,
    ctxSize: 65536,
  }) + '\n';
  agentPollCaughtUp = 0;
  agentPollText += statusRefresh;
  const expectedPollLen = Buffer.byteLength(agentPollText);
  await waitFor(
    () => agentPollDeliveredLen >= expectedPollLen,
    'Agent did not receive the late idle status refresh',
    debugDetails,
  );
  await delay(100);
  assert.match(
    await page.evaluate(() => window.getSelection()?.toString() || ''),
    /selection-survives-refresh/,
    'late idle Agent renders must not clear the user text selection',
  );
  await page.evaluate(() => window.getSelection()?.removeAllRanges());
  await waitFor(
    () => agentPollCaughtUp > 0,
    'Agent did not settle to idle after the selection refresh',
    debugDetails,
  );

  // Cowork deliberately shares the Agent conversation surface, but keeps its
  // document-specific actions and workspace behavior.
  agentPollText = '';
  agentPollWorking = false;
  agentPollSessionWorking = false;
  agentPollDeliveredLen = 0;
  agentPollCaughtUp = 0;
  await page.locator('#tab-cowork').click();
  await page.waitForFunction(() => !document.querySelector('#agent-view')?.hidden && document.body.classList.contains('agent-cowork-mode'));
  await waitFor(
    () => starts.some((s) => s.mode === 'cowork' && s.workdir === '/tmp/dstudio-ui-cowork'),
    'Cowork tab should start its runtime in the selected workspace',
    debugDetails,
  );
  assert.equal(await page.locator('#pipe-head-mode').textContent(), 'Cowork', 'Cowork should identify itself in the shared session header');
  assert.match(await page.locator('#pipe-head-path').textContent(), /dstudio-ui-cowork/, 'Cowork should show its active working folder');
  await page.locator('#pipe-command-hints').waitFor({ state: 'visible' });
  for (const command of ['/help', '/list', '/save', '/new', '/compact']) {
    await page.getByRole('button', { name: command, exact: true }).waitFor({ state: 'visible' });
  }

  await page.locator('#cbar-gear').click();
  await page.locator('#cbar-pop').waitFor({ state: 'visible' });
  await page.locator('#cbar-attach').filter({ hasText: 'Attach files' }).waitFor({ state: 'visible' });
  await page.locator('#cbar-pop .cbar-menu-row').filter({ hasText: 'Add a folder' }).waitFor({ state: 'visible' });
  await page.getByRole('button', { name: /Working folder:/ }).waitFor({ state: 'visible' });
  await page.locator('#chat-file-input').setInputFiles({
    name: 'quarterly-report.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.4\nCowork fixture\n'),
  });
  await page.getByText(/Saved to Cowork: quarterly-report\.pdf/).waitFor({ timeout: 5000 });
  assert.equal(coworkAttachments.length, 1, 'Cowork attachment should reach its workspace upload endpoint');
  assert.equal(coworkAttachments[0].dir, '/tmp/dstudio-ui-cowork', 'Cowork attachment should use the visible workspace');
  assert.equal(await page.locator('#composer-input').inputValue(), '',
    'Cowork should keep tool instructions out of the visible composer');
  await page.locator('.composer__file-name').filter({ hasText: 'quarterly-report.pdf' }).waitFor({ state: 'visible' });

  await page.locator('#cbar-gear').click();
  await page.locator('#cbar-pop').waitFor({ state: 'hidden' });
  const startsBeforeCoworkSkill = starts.length;
  await page.locator('#cbar-gear').click();
  await page.locator('#cbar-pop').waitFor({ state: 'visible' });
  await page.locator('.skill-open').click();
  await page.getByRole('dialog', { name: /Your skills/i }).waitFor({ timeout: 5000 });
  await page.locator('.skills-cat').filter({ hasText: /Your skills/ }).click();
  await page.locator('.skill-card').filter({ hasText: 'ecc-security-review' }).click();
  assert.equal(starts.length, startsBeforeCoworkSkill, 'picking a Cowork skill should not restart the runtime');

  await page.locator('#composer-input').fill('Cowork streaming fixture');
  await page.locator('#btn-send').click();
  await waitFor(
    () => sends.some((s) => s.mode === 'cowork' &&
      /Cowork streaming fixture/.test(s.body?.displayPrompt || '') &&
      /\[DStudio selected skill: ecc-security-review\]/.test(s.body?.prompt || '') &&
      /Call read_pdf/.test(s.body?.prompt || '') &&
      /DSTUDIO_COWORK_ATTACHMENT/.test(s.body?.displayPrompt || '')),
    'Cowork send should preserve the selected skill and document instruction',
    debugDetails,
  );
  await page.locator('.agent-response-name').filter({ hasText: 'Cowork' }).waitFor({ timeout: 5000 });
  await page.locator('.agent-user-meta').filter({ hasText: 'YOU' }).last().waitFor({ timeout: 5000 });
  assert.equal(await page.locator('.agent-user-turn').last().textContent().then((value) => /DSTUDIO_COWORK_ATTACHMENT/.test(value)), false,
    'Cowork attachment metadata must render as a tile rather than raw prompt text');
  const coworkThought = page.locator('details.agent-thought').last();
  await coworkThought.waitFor({ timeout: 5000 });
  assert.equal(await coworkThought.getAttribute('open'), null, 'Cowork reasoning should stay collapsed like Agent reasoning');
  await page.locator('.agent-workstream').last().waitFor({ timeout: 5000 });
  await page.locator('.agent-workstream .toolfold[data-live="true"]').first().waitFor({ timeout: 5000 });
  assert.equal(
    await page.locator('.agent-workstream .toolfold[data-live="true"]').count(),
    2,
    'every announced read should be a formatted timeline action before execution completes',
  );
  assert.equal(
    await page.locator('.agent-inner > .seg--text').filter({ hasText: /inbox\/(quarterly-report\.pdf|totals\.csv).*1:500/ }).count(),
    0,
    'split terminal read paths must never leak above the Working timeline as prose',
  );
  assert.equal(await page.getByText('Work log', { exact: true }).count(), 0, 'Agent/Cowork should expose only the action timeline, not a second Work log');
  await page.locator('.agent-answer-streaming').filter({ hasText: /quarterly-summary\.xlsx/ }).waitFor({ timeout: 5000 });
  assert.match(await page.locator('.agent-response-status.is-live').last().textContent(), /^working/, 'Cowork response header should report live streaming');
  await page.getByText(/verified its totals against the PDF/).waitFor({ timeout: 5000 });
  await page.waitForFunction(() => !document.querySelector('.agent-answer-streaming'), null, { timeout: 5000 });
  assert.match(await page.locator('.agent-response-status').last().textContent(), /done/, 'Cowork response should settle on the same completed state as Agent');
  await page.getByRole('button', { name: '/list', exact: true }).click();
  await waitFor(
    () => sends.some((s) => s.mode === 'cowork' && s.body?.prompt === '/list'),
    'Cowork command hints should invoke the existing session commands',
    debugDetails,
  );

  await page.locator('#tab-design').click();
  await page.waitForFunction(() => !document.querySelector('#agent-view')?.hidden);
  await page.evaluate(() => {
    window.__designGeneratingMounts = 0;
    let visible = false;
    const sample = () => {
      const next = !!document.querySelector('#agent-view .gen');
      if (next && !visible) window.__designGeneratingMounts += 1;
      visible = next;
    };
    new MutationObserver(sample).observe(document.querySelector('#agent-view'), {
      childList: true,
      subtree: true,
    });
    sample();
  });
  await page.locator('#composer-input').fill('Design a landing page');
  await page.locator('#btn-send').click();
  await waitFor(
    () => sends.some((s) => s.mode === 'design' && /Design a landing page/.test(s.body?.displayPrompt || '')),
    'design send did not reach /api/agent/send',
    debugDetails,
  );
  await page.locator('#agent-view .gen').waitFor({ state: 'visible', timeout: 5000 });
  await page.locator('#agent-view .gen').waitFor({ state: 'hidden', timeout: 5000 });
  await waitFor(
    () => sessions.some((s) => s.action === 'list'),
    'completed Design turn should refresh the session binding once',
    debugDetails,
  );
  const startsBeforeNewDesign = starts.length;
  await page.locator('#btn-new-chat').click();
  await waitFor(
    () => sessions.some((s) => s.action === 'new'),
    'new design session should wait behind the in-flight session refresh',
    debugDetails,
  );
  assert.ok(
    sessions.findIndex((s) => s.action === 'new') > sessions.findIndex((s) => s.action === 'list'),
    'session commands should preserve request order',
  );
  assert.equal(starts.length, startsBeforeNewDesign, 'new design in the active workspace should not restart the design runtime');
  await page.getByRole('heading', { name: /What should we design\?/ }).waitFor({ timeout: 5000 });
  await delay(1800);
  assert.equal(
    await page.evaluate(() => window.__designGeneratingMounts),
    1,
    'background /list maintenance must not remount the Design generating screen',
  );
  assert.equal(
    sessions.filter((s) => s.action === 'list').length,
    1,
    'the /list completion must not recursively schedule another session refresh',
  );
  assert.equal(await page.locator('#agent-view .gen').count(), 0,
    'Design should remain on the completed transcript while session metadata refreshes');
  const oldDesignSession = await page.evaluate(() => {
    const saved = JSON.parse(localStorage.getItem('ds4web.chats.v2') || '{}');
    return (saved.chats || []).find((chat) => chat.id === 'design-seed') || null;
  });
  assert.equal(oldDesignSession?.sessionSha, 'f1c7e2a9',
    'a split /list event must bind the session SHA to the conversation that requested it, not the newly active design');
  const designComposer = await page.locator('.composer').evaluate((node) => {
    const rect = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    return {
      display: style.display,
      top: rect.top,
      bottom: rect.bottom,
      viewportHeight: innerHeight,
      agentScrollTop: document.querySelector('#agent-view')?.scrollTop || 0,
      agentTop: document.querySelector('#agent-view')?.getBoundingClientRect().top || 0,
      briefTop: document.querySelector('.brief')?.getBoundingClientRect().top || 0,
      bodyClass: document.body.className,
      placeholder: document.querySelector('#composer-input')?.getAttribute('placeholder') || '',
    };
  });
  assert.notEqual(designComposer.display, 'none', 'Design brief should keep the shared chat composer visible');
  assert.ok(designComposer.top >= 0 && designComposer.bottom <= designComposer.viewportHeight + 1,
    `Design composer must stay docked inside the viewport: ${JSON.stringify(designComposer)}`);
  assert.match(designComposer.placeholder, /Describe the screen, flow, audience and visual direction/,
    'Design composer should explain what can be sent');
  assert.equal(await page.locator('.design-brief-composer-slot > .composer').count(), 1,
    'Design should place the real shared chat directly below its intro');
  assert.equal(await page.getByRole('button', { name: /Open gallery/i }).count(), 0, 'Design brief should not require an Open gallery button');
  await page.locator('.design-gallery-card__title').filter({ hasText: 'Airbnb' }).waitFor({ timeout: 5000 });
  await page.locator('.design-gallery-card__title').filter({ hasText: 'Apple' }).waitFor({ timeout: 5000 });
  await page.locator('.brief-gallery-panel__title', { hasText: 'Visual starting points' }).waitFor({ timeout: 5000 });
  const designOrder = await page.evaluate(() => ({
    composerBottom: document.querySelector('.design-brief-composer-slot > .composer')?.getBoundingClientRect().bottom || 0,
    galleryTop: document.querySelector('.brief-gallery-panel')?.getBoundingClientRect().top || 0,
  }));
  assert.ok(designOrder.composerBottom <= designOrder.galleryTop,
    `Design chat must precede Visual starting points: ${JSON.stringify(designOrder)}`);
  const designSearch = page.getByLabel('Search design gallery');
  await designSearch.fill('Apple');
  await page.locator('.design-gallery-card__title').filter({ hasText: 'Apple' }).first().waitFor({ timeout: 5000 });
  assert.equal(await page.locator('.design-gallery-card__title').filter({ hasText: 'Airbnb' }).count(), 0, 'Design gallery search should filter cards in place');
  await designSearch.fill('');
  await page.locator('.design-gallery-card__title').filter({ hasText: 'Airbnb' }).first().waitFor({ timeout: 5000 });
  assert.ok(await page.getByText(/2 items/).count(), 'Design gallery should include design systems without downloadable skill templates');
  const designGalleryDialogOpen = await page.locator('#design-gallery-dialog').evaluate((dialog) => !!dialog.open);
  assert.equal(designGalleryDialogOpen, false, 'Design gallery should render inline rather than opening a modal');
  const airbnbCard = page.locator('.design-gallery-card').filter({ hasText: 'Airbnb' }).first();
  await airbnbCard.click();
  await page.waitForFunction(() => document.querySelector('#design-preview-dialog')?.open === true, null, { timeout: 5000 });
  assert.equal(await airbnbCard.evaluate((el) => el.classList.contains('is-selected')), true, 'clicked design-system card should stay highlighted');
  await page.frameLocator('#design-preview-frame').getByRole('heading', { name: 'Airbnb Components' }).waitFor({ timeout: 5000 });
  await page.locator('#design-preview-close').click();

  failNextAgentSend = true;
  await page.locator('#composer-input').fill('Trigger send failure');
  await page.locator('#btn-send').click();
  await page.getByText(/Design send failed: agent\/design runtime is not active/).waitFor({ timeout: 5000 });

  assert.ok(starts.some((s) => s.mode === 'agent'), 'agent tab should start the agent runtime');
  assert.ok(starts.some((s) => s.mode === 'cowork'), 'cowork tab should start the cowork runtime');
  assert.ok(starts.some((s) => s.mode === 'design'), 'design tab should start the design runtime');
  console.log('ui_agent_design_playwright_test: ok');
} finally {
  await browser.close().catch(() => {});
  server.close();
}

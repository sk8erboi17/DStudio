import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.log('ui_plan_mode_playwright_test: playwright missing, skipping');
  process.exit(0);
}

const repoRoot = process.cwd();
const webRoot = path.join(repoRoot, 'web');
const screenshotPath = path.join(repoRoot, '.tmp', 'plan-mode-question-ui.png');

const starts = [];
const sends = [];
let currentMode = 'server';
let currentWorkdir = '/tmp/dstudio-plan-mode';
let transcriptBytes = 0;
const pollQueue = [];

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

function enqueueDelta(text) {
  const body = String(text || '');
  const bytes = Buffer.byteLength(body);
  const base = transcriptBytes;
  transcriptBytes += bytes;
  pollQueue.push({ base, len: transcriptBytes, text: body, working: false });
  pollQueue.push({ base: transcriptBytes, len: transcriptBytes, text: '', working: false });
}

const questionForm = `<question-form title="Plan setup">
{"id":"plan-setup","questions":[{"id":"csv-shape","label":"What kind of CSV files should the importer handle first?","type":"radio","options":[{"value":"simple-upload","label":"Simple admin uploads","description":"One user uploads small, consistent CSV files through the review UI."},{"value":"vendor-export","label":"Vendor exports","description":"Support recurring third-party CSVs with changing columns or encodings."},{"value":"large-files","label":"Large files","description":"Plan streaming/chunked parsing and progress states for big uploads."}]},{"id":"invalid-rows","label":"How should invalid CSV rows be handled?","type":"radio","options":[{"value":"block-file","label":"Block the whole file","description":"Reject the import until every row passes validation."},{"value":"partial-import","label":"Partial import","description":"Import valid rows and generate an error report for rejected rows."},{"value":"review-queue","label":"Review queue","description":"Send questionable rows to a human review step before commit."}]},{"id":"destination","label":"Where should validated rows land?","type":"radio","options":[{"value":"staging-table","label":"Staging table","description":"Store parsed rows separately before promotion into domain records."},{"value":"domain-records","label":"Domain records","description":"Write directly to the application models after validation."},{"value":"export-only","label":"Export only","description":"Produce cleaned CSV/JSON output without mutating app data."}]},{"id":"review-ui","label":"Which review UI states are required?","type":"checkbox","maxSelections":3,"options":[{"value":"mapping","label":"Column mapping","description":"Let users map CSV headers to known fields before validation."},{"value":"errors","label":"Row errors","description":"Show row-level validation failures with downloadable details."},{"value":"progress","label":"Progress and cancel","description":"Show upload/import progress and allow cancellation."},{"value":"preview","label":"Data preview","description":"Preview parsed rows before committing the import."}]}]}
</question-form>`;

const planMarkdown = [
  '## Plan written',
  '',
  'Created `data-import-plan.md` from the selected answers.',
  '',
  '| Area | Decision |',
  '| --- | --- |',
  '| Priority | Quality first |',
  '| Scope | Balanced delivery |',
  '',
  '```sh',
  'npm test',
  '```',
  '',
  '- [ ] Confirm data shape with fixtures',
  '- [x] Keep existing UI patterns',
  '',
  '### Summary',
  '- Build the smallest reliable pipeline.',
  '- Validate with fixtures before wiring the UI.',
  '- Keep rollout steps explicit.',
].join('\n');

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
      variants: { flash: true },
      variant: 'flash',
      engineLine: 'plan mode ui test ready',
    });
    return;
  }
  if (url.pathname === '/api/start' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req) || '{}');
    starts.push(body);
    currentMode = body.mode || 'server';
    if (body.workdir) currentWorkdir = body.workdir;
    json(res, 200, { ok: true });
    return;
  }
  if (url.pathname === '/api/agent/send' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req) || '{}');
    sends.push({ mode: currentMode, body });
    const from = transcriptBytes;
    if (/PLAN MODE/.test(body.prompt || '')) enqueueDelta(questionForm);
    else if (/§QUESTION_ANSWER/.test(body.prompt || '')) enqueueDelta(planMarkdown);
    else enqueueDelta('ok');
    json(res, 200, { ok: true, from, at: transcriptBytes });
    return;
  }
  if (url.pathname === '/api/agent/poll') {
    const next = pollQueue.shift();
    if (next) json(res, 200, { ...next, ready: true, loadPct: 100 });
    else json(res, 200, { base: transcriptBytes, len: transcriptBytes, text: '', working: false, ready: true, loadPct: 100 });
    return;
  }
  if (url.pathname === '/api/agent/interrupt' && req.method === 'POST') {
    json(res, 200, { ok: true });
    return;
  }
  if (url.pathname === '/api/fs/list' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req) || '{}');
    json(res, 200, { ok: true, path: body.path || '/tmp', entries: 0, dirs: [] });
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
  if (url.pathname === '/api/skills' || url.pathname === '/api/user-skills') {
    json(res, 200, { ok: true, skills: [], systems: [], designSystems: [] });
    return;
  }
  if (url.pathname === '/v1/models') {
    json(res, 200, { data: [{ id: 'deepseek-v4-flash' }] });
    return;
  }

  const file = url.pathname === '/' ? path.join(webRoot, 'index.html') : path.join(webRoot, url.pathname);
  if (!file.startsWith(webRoot) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404);
    res.end('not found');
    return;
  }
  res.writeHead(200, { 'content-type': file.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

let browser;
try {
  browser = await chromium.launch();
} catch {
  try {
    browser = await chromium.launch({ channel: 'chrome' });
  } catch {
    server.close();
    console.log('ui_plan_mode_playwright_test: browser missing, skipping');
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
  fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e?.stack || e?.message || String(e)));
  page.on('console', (msg) => {
    if (msg.type() === 'error' && !/Failed to load resource/i.test(msg.text())) pageErrors.push(msg.text());
  });
  await page.addInitScript(() => {
    const now = Date.now();
    window.ds4PickDirectory = async () => '/tmp/dstudio-plan-mode';
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
      planMode: 'on',
      workdirs: { agent: '/tmp/dstudio-plan-mode', design: '/tmp/dstudio-plan-mode-design' },
    }));
    localStorage.setItem('ds4web.chats.v1', JSON.stringify({
      v: 1,
      deleted: [],
      chats: [
        { id: 'agent-plan-seed', mode: 'agent', title: 'Agent plan seed', createdAt: now, updatedAt: now, messages: [], transcript: '' },
        { id: 'design-plan-seed', mode: 'design', title: 'Design plan seed', createdAt: now + 1, updatedAt: now + 1, messages: [], transcript: '' },
      ],
    }));
    localStorage.setItem('ds4web.active.v1', JSON.stringify({ v: 1, ids: { chat: null, agent: 'agent-plan-seed', design: 'design-plan-seed' } }));
  });

  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
  await page.locator('#composer-input').waitFor({ timeout: 5000 });
  await page.waitForTimeout(250);
  await page.locator('#tab-agent').click();
  await page.waitForTimeout(300);
  if (await page.locator('#workdir-dialog').evaluate((d) => !!d.open).catch(() => false)) {
    await page.locator('#workdir-go').click();
    await page.waitForTimeout(100);
  }
  const agentTabDebug = await page.evaluate(() => {
    const tab = document.querySelector('#tab-agent');
    const view = document.querySelector('#agent-view');
    const overlay = document.querySelector('#loading-overlay');
    const wd = document.querySelector('#workdir-dialog');
    const ds4 = document.querySelector('#ds4dir-dialog');
    return {
      tabDisabled: !!tab?.disabled,
      tabAria: tab?.getAttribute('aria-selected'),
      tabClass: tab?.className,
      viewHidden: view?.hidden,
      overlayHidden: overlay?.hidden,
      workdirOpen: !!wd?.open,
      ds4Open: !!ds4?.open,
      bodyClass: document.body.className,
    };
  });
  await waitFor(
    () => starts.some((s) => s.mode === 'agent'),
    'Agent runtime did not start',
    () => JSON.stringify({ starts, sends, pageErrors, agentTabDebug }, null, 2),
  );
  await page.waitForFunction(() => !document.querySelector('#agent-view')?.hidden, null, { timeout: 5000 });

  const request = 'Plan a robust data import workflow for uploaded CSV files, with validation and a small review UI.';
  await page.locator('#composer-input').fill(request);
  await page.locator('#btn-send').click();

  await waitFor(
    () => sends.length > 0,
    'No Agent send happened after submitting the Plan request',
    () => JSON.stringify({ starts, sends, pageErrors }, null, 2),
  );
  await page.locator('#plan-actions[data-kind="question"] .qform').waitFor({ timeout: 5000 }).catch(async (e) => {
    const ui = await page.evaluate(() => ({
      planActionsHidden: document.querySelector('#plan-actions')?.hidden,
      planActionsKind: document.querySelector('#plan-actions')?.dataset?.kind || '',
      agentText: document.querySelector('#agent-view')?.innerText?.slice(0, 1000) || '',
      composerDisabled: document.querySelector('#composer-input')?.disabled,
    }));
    assert.fail(`${e.message}\n${JSON.stringify({ starts, sends, pollQueueLength: pollQueue.length, pageErrors, ui }, null, 2)}`);
  });
  await page.getByText('Plan setup').waitFor({ timeout: 5000 });
  await page.getByText('What kind of CSV files should the importer handle first?').waitFor({ timeout: 5000 });
  await page.getByText('How should invalid CSV rows be handled?').waitFor({ timeout: 5000 });
  await page.getByText('Where should validated rows land?').waitFor({ timeout: 5000 });
  assert.equal(await page.getByText('What should this plan optimize for?').count(), 0, 'Plan mode questions should not fall back to generic optimization prompts');
  assert.equal(await page.getByText('Plan ready').count(), 0, 'Plan actions should not appear while a clarification card is active');

  await page.locator('#plan-actions[data-kind="question"]').screenshot({ path: screenshotPath });

  await waitFor(
    () => sends.some((s) => /PLAN MODE/.test(s.body?.prompt || '')),
    'Plan prompt was not sent',
    () => JSON.stringify({ starts, sends, pageErrors }, null, 2),
  );
  const planSend = sends.find((s) => /PLAN MODE/.test(s.body?.prompt || ''));
  assert.equal(planSend.body.displayPrompt, request, 'Displayed user bubble should hide the Plan contract');
  assert.match(planSend.body.prompt, /First response requirement:[\s\S]*question-form[\s\S]*3-5 domain-specific questions/, 'Plan contract should require a first-turn question form');
  assert.match(planSend.body.prompt, /software, research, product, design, writing, operations, and analysis tasks/, 'Plan question contract should stay general');
  assert.match(planSend.body.prompt, /Make every question specific to the user request/, 'Plan contract should require project-specific questions');
  assert.match(planSend.body.prompt, /Do not ask generic project-management questions/, 'Plan contract should reject generic Plan setup questions');

  await page.waitForFunction(() => !document.querySelector('.agent-working'), null, { timeout: 5000 });
  await page.getByRole('button', { name: /^Simple admin uploads\b/ }).click();
  await page.getByRole('button', { name: /^Partial import\b/ }).click();
  await page.getByRole('button', { name: 'Continue' }).click();

  await waitFor(
    () => sends.some((s) => /^§QUESTION_ANSWER/.test(s.body?.prompt || '')),
    'Question answer was not sent',
    () => JSON.stringify({ starts, sends, pageErrors }, null, 2),
  );
  const answerSend = sends.find((s) => /^§QUESTION_ANSWER/.test(s.body?.prompt || ''));
  assert.doesNotMatch(answerSend.body.prompt, /PLAN MODE/, 'Question answers must continue the pending plan, not arm a new Plan turn');

  await page.locator('.seg--text.md h2', { hasText: 'Plan written' }).waitFor({ timeout: 5000 });
  await page.locator('.seg--text.md table').waitFor({ timeout: 5000 });
  await page.locator('.seg--text.md .code-block').waitFor({ timeout: 5000 });
  await page.locator('.seg--text.md li.task-list-item input[type="checkbox"]').first().waitFor({ timeout: 5000 });
  await page.getByText('Plan ready').waitFor({ timeout: 5000 });
  await page.getByText('Implement plan').waitFor({ timeout: 5000 });
  await page.getByText('Stay in plan mode').waitFor({ timeout: 5000 });
  await page.getByText('Chat about this').waitFor({ timeout: 5000 });

  assert.equal(pageErrors.length, 0, `page errors:\n${pageErrors.join('\n')}`);
  console.log(`ui_plan_mode_playwright_test: ok (${path.relative(repoRoot, screenshotPath)})`);
} finally {
  await browser.close().catch(() => {});
  server.close();
}

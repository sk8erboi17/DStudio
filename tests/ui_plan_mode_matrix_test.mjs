import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.log('ui_plan_mode_matrix_test: playwright missing, skipping');
  process.exit(0);
}

const repoRoot = process.cwd();
const webRoot = path.join(repoRoot, 'web');

const cases = [
  {
    id: 'csv-import',
    prompt: 'Plan a robust data import workflow for uploaded CSV files, with validation and a small review UI.',
    required: ['CSV files', 'invalid CSV rows', 'validated rows', 'review UI states'],
    click: ['Simple admin uploads', 'Partial import'],
    form: {
      id: 'plan-setup',
      questions: [
        {
          id: 'csv-shape',
          label: 'What kind of CSV files should the importer handle first?',
          type: 'radio',
          options: [
            { value: 'simple-upload', label: 'Simple admin uploads', description: 'One user uploads small, consistent CSV files through the review UI.' },
            { value: 'vendor-export', label: 'Vendor exports', description: 'Support recurring third-party CSVs with changing columns or encodings.' },
            { value: 'large-files', label: 'Large files', description: 'Plan streaming/chunked parsing and progress states for big uploads.' },
          ],
        },
        {
          id: 'invalid-rows',
          label: 'How should invalid CSV rows be handled?',
          type: 'radio',
          options: [
            { value: 'block-file', label: 'Block the whole file', description: 'Reject the import until every row passes validation.' },
            { value: 'partial-import', label: 'Partial import', description: 'Import valid rows and generate an error report for rejected rows.' },
          ],
        },
        {
          id: 'destination',
          label: 'Where should validated rows land?',
          type: 'radio',
          options: [
            { value: 'staging-table', label: 'Staging table', description: 'Store parsed rows separately before promotion into domain records.' },
            { value: 'domain-records', label: 'Domain records', description: 'Write directly to the application models after validation.' },
          ],
        },
        {
          id: 'review-ui',
          label: 'Which review UI states are required?',
          type: 'checkbox',
          maxSelections: 2,
          options: [
            { value: 'mapping', label: 'Column mapping', description: 'Let users map CSV headers to known fields before validation.' },
            { value: 'errors', label: 'Row errors', description: 'Show row-level validation failures with downloadable details.' },
            { value: 'preview', label: 'Data preview', description: 'Preview parsed rows before committing the import.' },
          ],
        },
      ],
    },
  },
  {
    id: 'design-billing',
    prompt: 'Plan a redesign of a SaaS billing dashboard for admins, including invoices, failed payments, plan changes, and usage charts.',
    required: ['billing dashboard', 'admin', 'invoices', 'failed payment'],
    click: ['Finance admin', 'Invoice list'],
    form: {
      id: 'plan-setup',
      questions: [
        {
          id: 'admin-role',
          label: 'Which admin role is the billing dashboard primarily for?',
          type: 'radio',
          options: [
            { value: 'finance-admin', label: 'Finance admin', description: 'Prioritize invoices, receipts, taxes, and payment status.' },
            { value: 'workspace-owner', label: 'Workspace owner', description: 'Prioritize plan changes, seat counts, and upgrade paths.' },
          ],
        },
        {
          id: 'billing-surface',
          label: 'Which billing surface should anchor the redesign?',
          type: 'radio',
          options: [
            { value: 'invoice-list', label: 'Invoice list', description: 'Make invoice history, downloads, and overdue status central.' },
            { value: 'usage-charts', label: 'Usage charts', description: 'Center the experience around consumption trends and limits.' },
            { value: 'plan-change', label: 'Plan change flow', description: 'Focus on upgrade/downgrade decisions and pricing clarity.' },
          ],
        },
        {
          id: 'payment-state',
          label: 'How visible should failed payment recovery be?',
          type: 'radio',
          options: [
            { value: 'banner', label: 'Persistent banner', description: 'Keep overdue payment action visible across billing views.' },
            { value: 'task-card', label: 'Task card', description: 'Show recovery as one prioritized admin task.' },
          ],
        },
      ],
    },
  },
  {
    id: 'research-architecture',
    prompt: 'Plan a passive technical architecture analysis of streamrecorder.io focusing on frontend bundles, public API calls, CDN/storage clues, and playback workflow.',
    required: ['frontend bundles', 'public API calls', 'CDN/storage clues', 'playback workflow'],
    click: ['Network first', 'Verified only'],
    form: {
      id: 'plan-setup',
      questions: [
        {
          id: 'evidence-source',
          label: 'Which evidence source should drive the frontend bundles and public API analysis first?',
          type: 'radio',
          options: [
            { value: 'network-first', label: 'Network first', description: 'Capture public API calls, response types, and endpoint patterns during normal browsing.' },
            { value: 'bundle-first', label: 'Bundle first', description: 'Read frontend bundles to extract framework, routing, and API clues.' },
          ],
        },
        {
          id: 'claim-standard',
          label: 'What evidence standard should STRUCTURE.MD use?',
          type: 'radio',
          options: [
            { value: 'verified-only', label: 'Verified only', description: 'Record only public observations directly visible in browser/network evidence.' },
            { value: 'verified-inferred', label: 'Verified plus inferred', description: 'Allow clearly labeled architecture inferences from URLs, headers, and behavior.' },
          ],
        },
        {
          id: 'playback-scope',
          label: 'How deep should the CDN/storage clues and playback workflow inspection go?',
          type: 'radio',
          options: [
            { value: 'anonymous', label: 'Anonymous public pages', description: 'Stay on public playback/search pages and visible media/CDN URLs only.' },
            { value: 'account-flow', label: 'Account-visible flow', description: 'Include login/account screens if credentials are provided later.' },
          ],
        },
      ],
    },
  },
  {
    id: 'ops-migration',
    prompt: 'Plan a zero-downtime migration from Postgres on a VPS to managed Neon, with backups, rollback, connection string rotation, and monitoring.',
    required: ['Postgres', 'Neon', 'rollback', 'connection string'],
    click: ['Dual-write window', 'Point-in-time restore'],
    form: {
      id: 'plan-setup',
      questions: [
        {
          id: 'cutover',
          label: 'What cutover strategy should the Postgres to Neon migration plan around?',
          type: 'radio',
          options: [
            { value: 'maintenance-lite', label: 'Short maintenance window', description: 'Pause writes briefly, sync final changes, then rotate traffic.' },
            { value: 'dual-write', label: 'Dual-write window', description: 'Run old and new databases together while verifying consistency.' },
          ],
        },
        {
          id: 'rollback',
          label: 'Which rollback safety net is required?',
          type: 'radio',
          options: [
            { value: 'snapshot', label: 'Final snapshot', description: 'Keep a last VPS snapshot and restore path before cutover.' },
            { value: 'pitr', label: 'Point-in-time restore', description: 'Rely on Neon/PITR plus a documented app traffic rollback.' },
          ],
        },
        {
          id: 'rotation',
          label: 'How should connection string rotation be coordinated?',
          type: 'radio',
          options: [
            { value: 'env-deploy', label: 'Deploy-time env change', description: 'Rotate through app deployment and restart workers in order.' },
            { value: 'secret-manager', label: 'Secret manager', description: 'Update a shared secret and roll services gradually.' },
          ],
        },
      ],
    },
  },
  {
    id: 'content-launch',
    prompt: 'Plan a launch content package for a privacy-focused iOS journaling app, including App Store copy, landing page sections, email sequence, and founder post.',
    required: ['iOS journaling app', 'App Store copy', 'landing page sections', 'email sequence'],
    click: ['Privacy-first users', 'App Store first'],
    form: {
      id: 'plan-setup',
      questions: [
        {
          id: 'audience',
          label: 'Who should the iOS journaling app launch copy speak to first?',
          type: 'radio',
          options: [
            { value: 'privacy-users', label: 'Privacy-first users', description: 'Emphasize local data, control, and trust.' },
            { value: 'habit-builders', label: 'Habit builders', description: 'Emphasize streaks, prompts, and daily reflection.' },
          ],
        },
        {
          id: 'channel',
          label: 'Which launch asset should set the App Store copy, landing page sections, and email sequence hierarchy?',
          type: 'radio',
          options: [
            { value: 'app-store', label: 'App Store first', description: 'Optimize App Store title, subtitle, screenshots, and conversion copy first.' },
            { value: 'landing-page', label: 'Landing page first', description: 'Use the landing page sections as the canonical narrative.' },
            { value: 'founder-post', label: 'Founder post first', description: 'Build around a personal story and privacy philosophy.' },
          ],
        },
        {
          id: 'email-role',
          label: 'What should the launch email sequence do?',
          type: 'radio',
          options: [
            { value: 'educate', label: 'Educate on privacy', description: 'Use the sequence to explain private journaling and trust.' },
            { value: 'activate', label: 'Drive first journal entry', description: 'Use the sequence to get users into their first reflection.' },
          ],
        },
        {
          id: 'tone',
          label: 'What tone should the founder post use?',
          type: 'radio',
          options: [
            { value: 'calm', label: 'Calm and personal', description: 'Quiet, reflective, and trust-building.' },
            { value: 'product-led', label: 'Product-led', description: 'Concrete features, use cases, and proof points.' },
          ],
        },
      ],
    },
  },
];

let activeCase = cases[0];
const starts = [];
const sends = [];
let currentMode = 'server';
let transcriptBytes = 0;
const pollQueue = [];

function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
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

function formForCase(c) {
  return `<question-form title="Plan setup">\n${JSON.stringify(c.form)}\n</question-form>`;
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
      workdir: '/tmp/dstudio-plan-mode-matrix',
      jsonl: true,
      ds4dirOk: true,
      webdirOk: true,
      lan: false,
      variants: { flash: true },
      variant: 'flash',
      engineLine: 'plan mode matrix test ready',
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
    sends.push({ caseId: activeCase.id, mode: currentMode, body });
    const from = transcriptBytes;
    if (/PLAN MODE/.test(body.prompt || '')) enqueueDelta(formForCase(activeCase));
    else enqueueDelta(`## Plan written\n\n- [ ] ${activeCase.id} validation item`);
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
    json(res, 200, { ok: true, path: '/tmp/dstudio-plan-mode-matrix', entries: 0, dirs: [] });
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
    console.log('ui_plan_mode_matrix_test: browser missing, skipping');
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

const genericPatterns = [
  /what should this plan optimize for/i,
  /how broad should the first pass be/i,
  /which constraints matter most/i,
  /\bquality\b[\s\S]*\bspeed\b[\s\S]*\bclarity\b/i,
];

async function runCase(context, c, index) {
  activeCase = c;
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e?.stack || e?.message || String(e)));
  page.on('console', (msg) => {
    if (msg.type() === 'error' && !/Failed to load resource/i.test(msg.text())) pageErrors.push(msg.text());
  });
  await page.addInitScript(({ caseId }) => {
    const now = Date.now();
    window.ds4PickDirectory = async () => '/tmp/dstudio-plan-mode-matrix';
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
      workdirs: { agent: '/tmp/dstudio-plan-mode-matrix' },
      onboardedVersion: 8,
    }));
    localStorage.setItem('ds4web.chats.v1', JSON.stringify({
      v: 1,
      deleted: [],
      chats: [{ id: `agent-plan-${caseId}`, mode: 'agent', title: `Plan ${caseId}`, createdAt: now, updatedAt: now, messages: [], transcript: '' }],
    }));
    localStorage.setItem('ds4web.active.v1', JSON.stringify({ v: 1, ids: { chat: null, agent: `agent-plan-${caseId}`, design: null } }));
  }, { caseId: c.id });

  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
  await page.locator('#composer-input').waitFor({ timeout: 5000 });
  await page.waitForTimeout(150);
  await page.locator('#tab-agent').click();
  await page.waitForTimeout(250);
  if (await page.locator('#workdir-dialog').evaluate((d) => !!d.open).catch(() => false)) {
    await page.locator('#workdir-go').click();
    await page.waitForTimeout(100);
  }
  await page.waitForFunction(() => !document.querySelector('#agent-view')?.hidden, null, { timeout: 5000 });
  const before = sends.length;
  await page.locator('#composer-input').fill(c.prompt);
  await page.locator('#btn-send').click();
  await waitFor(() => sends.length > before, `${c.id}: no send`, () => JSON.stringify({ starts, sends, pageErrors }, null, 2));
  await page.locator('#plan-actions[data-kind="question"] .qform').waitFor({ timeout: 5000 });
  const text = await page.locator('#plan-actions[data-kind="question"]').innerText();
  for (const expected of c.required) {
    assert.match(text, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), `${c.id}: missing project term "${expected}"`);
  }
  for (const re of genericPatterns) {
    assert.doesNotMatch(text, re, `${c.id}: rendered generic Plan question text`);
  }
  const planSend = sends.slice(before).find((s) => /PLAN MODE/.test(s.body?.prompt || ''));
  assert.ok(planSend, `${c.id}: missing Plan contract send`);
  assert.equal(planSend.body.displayPrompt, c.prompt, `${c.id}: display prompt should hide contract`);
  assert.match(planSend.body.prompt, /Question construction method:[\s\S]*Extract 5-8 concrete project terms/, `${c.id}: hidden contract lacks question construction method`);
  assert.match(planSend.body.prompt, /If a question would still make sense for any unrelated project, rewrite it/, `${c.id}: hidden contract lacks generic-question self-check`);
  for (const label of c.click) await page.getByRole('button', { name: new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`) }).click();
  assert.equal(pageErrors.length, 0, `${c.id}: page errors:\n${pageErrors.join('\n')}`);
  await page.close();
  return { id: c.id, promptTerms: c.required.length, questions: (text.match(/\n\d+\n/g) || []).length || c.form.questions.length, index };
}

try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const results = [];
  for (let i = 0; i < cases.length; i++) results.push(await runCase(context, cases[i], i));
  await context.close();
  console.log(`ui_plan_mode_matrix_test: ok ${results.length}/${cases.length} prompts`);
  for (const r of results) console.log(`- ${r.id}: ${r.questions} questions, ${r.promptTerms} required project terms verified`);
} finally {
  await browser.close().catch(() => {});
  server.close();
}

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.log('ui_gsa_playwright_test: playwright missing, skipping');
  process.exit(0);
}

const repoRoot = process.cwd();
const webRoot = path.join(repoRoot, 'web');
const U_OPEN = '\u0001USER\u0002';
const U_CLOSE = '\u0001ENDUSER\u0002';

let currentMode = 'agent';
let transcript = '';
let runSeq = 0;
const gsaStarts = [];
const gsaPhases = [];
const sends = [];
const missingRequests = [];

function byteLen(value) {
  return Buffer.byteLength(String(value || ''), 'utf8');
}

function sliceUtf8From(value, byteOffset) {
  return Buffer.from(String(value || ''), 'utf8').subarray(Math.max(0, byteOffset)).toString('utf8');
}

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

function phaseOutputForPrompt(prompt) {
  if (prompt.includes('PREFLIGHT_PROMPT')) {
    return JSON.stringify({
      phase: 'preflight',
      hypotheses: [{
        title: 'API route boundary',
        entrypoints: ['src/server/routes.ts:42'],
        attacker: 'remote unauthenticated user',
        evidence_needed: ['route auth check'],
        kill_criteria: ['auth middleware blocks the path'],
        chain_candidates: ['public route plus object-id lookup'],
      }],
    });
  }
  if (prompt.includes('VALIDATION_PROMPT')) {
    return JSON.stringify({
      phase: 'validation',
      findings: [{
        title: 'Public recording metadata exposure',
        severity: 'medium',
        evidence: ['src/server/routes.ts:42'],
        exploit_path: 'unauthenticated request reaches metadata response',
        impact: 'private recording metadata disclosure',
        confidence: 'medium',
        missing_evidence: '',
        attack_chain: ['public endpoint', 'metadata lookup'],
      }],
    });
  }
  if (prompt.includes('REPORT_PROMPT')) {
    return '## Verdict: confirmed_issue\n\nThe endpoint is reachable and exposes metadata with cited evidence.';
  }
  return JSON.stringify({
    phase: 'selection',
    files: [{ path: 'src/server/routes.ts', reason: 'public API routing' }],
    targetUrl: 'https://tikrec.com/latest',
    localScripts: [{ path: 'scripts/check_routes.py', purpose: 'probe route auth boundaries', status: 'planned' }],
    hypotheses: [{
      title: 'Unsecured API endpoint',
      why: 'public route appears to expose metadata without auth',
      skills: ['testing-for-sensitive-data-exposure'],
    }],
    stop_if: 'auth middleware blocks every selected path',
  });
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
      workdir: '/tmp/dstudio-gsa-ui-test',
      ds4dirOk: true,
      webdirOk: true,
      lan: false,
      variants: { flash: true, pro: false },
      variant: 'flash',
      engineLine: 'gsa ui test ready',
    });
    return;
  }
  if (url.pathname === '/api/start' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req) || '{}');
    currentMode = body.mode || 'agent';
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
  if (url.pathname === '/api/ggufs') {
    json(res, 200, { ok: true, files: [{ name: 'DeepSeek-V4-Flash-IQ2XXS.gguf', path: '/tmp/model.gguf', size: 87_000_000_000 }] });
    return;
  }
  if (url.pathname === '/api/doctor') {
    json(res, 200, { ok: true, issues: [], checks: [] });
    return;
  }
  if (url.pathname === '/api/diagnostics') {
    json(res, 200, { ok: true, tasks: [], recentLogs: [] });
    return;
  }
  if (url.pathname === '/api/lan-client/chats') {
    json(res, 200, { ok: true, chats: [] });
    return;
  }
  if (url.pathname === '/api/skills' || url.pathname === '/api/user-skills' ||
      url.pathname === '/api/design-systems' || url.pathname === '/api/skills/search') {
    json(res, 200, { ok: true, skills: [], systems: [] });
    return;
  }
  if (url.pathname === '/api/gsa/tools') {
    json(res, 200, { ok: true, gsaTools: { mode: 'tool-assisted', tools: [] } });
    return;
  }
  if (url.pathname === '/api/gsa/start' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req) || '{}');
    gsaStarts.push(body);
    runSeq += 1;
    const runId = `run-${runSeq}`;
    json(res, 200, {
      ok: true,
      taskId: runSeq,
      runId,
      workdir: body.workdir || '/tmp/dstudio-gsa-ui-test',
      runDir: `/tmp/dstudio-gsa-ui-test/.dstudio/gsa/runs/${runId}`,
      statePath: `/tmp/dstudio-gsa-ui-test/.dstudio/gsa/runs/${runId}/run_state.json`,
      parentRunDir: body.parentRunDir || '',
      iteration: runSeq,
      targetUrl: body.targetUrl || '',
      think: 'max',
      candidateCount: 2,
      skillCount: 1,
      truncated: false,
      prompt: 'SELECTION_PROMPT',
      gsaTools: { mode: 'tool-assisted', tools: [] },
    });
    return;
  }
  if (url.pathname === '/api/gsa/phase' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req) || '{}');
    gsaPhases.push(body);
    const nextPrompt = body.phase === 'selection' ? 'PREFLIGHT_PROMPT'
      : body.phase === 'preflight' ? 'VALIDATION_PROMPT'
      : body.phase === 'validation' ? 'REPORT_PROMPT' : '';
    json(res, 200, {
      ok: true,
      taskId: gsaPhases.length,
      complete: body.phase === 'report',
      nextPrompt,
      statePath: `/tmp/dstudio-gsa-ui-test/.dstudio/gsa/runs/${body.runId}/run_state.json`,
    });
    return;
  }
  if (url.pathname === '/api/agent/send' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req) || '{}');
    sends.push(body);
    const from = byteLen(transcript);
    const output = phaseOutputForPrompt(body.prompt || '');
    transcript += `${U_OPEN}${body.displayPrompt || ''}${U_CLOSE}\n${output}\n`;
    json(res, 200, { ok: true, from, at: byteLen(transcript) });
    return;
  }
  if (url.pathname === '/api/agent/poll') {
    const since = Math.max(0, Number(url.searchParams.get('since') || 0));
    json(res, 200, {
      base: 0,
      len: byteLen(transcript),
      working: false,
      ready: true,
      loadPct: 100,
      text: sliceUtf8From(transcript, since),
    });
    return;
  }
  if (url.pathname === '/v1/models') {
    json(res, 200, { data: [{ id: 'deepseek-v4-flash' }] });
    return;
  }

  const file = url.pathname === '/' ? path.join(webRoot, 'index.html') : path.join(webRoot, url.pathname);
  if (!file.startsWith(webRoot) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    missingRequests.push(`${req.method} ${url.pathname}`);
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
} catch {
  try {
    browser = await chromium.launch({ channel: 'chrome' });
  } catch {
    server.close();
    console.log('ui_gsa_playwright_test: browser missing, skipping');
    process.exit(0);
  }
}

async function waitFor(fn, label, details = () => '') {
  const start = Date.now();
  while (Date.now() - start < 8000) {
    if (await fn()) return;
    await delay(50);
  }
  assert.fail(`${label}${details() ? `\n${details()}` : ''}`);
}

try {
  const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e?.stack || e?.message || String(e)));
  page.on('console', (msg) => {
    if (msg.type() === 'error') pageErrors.push(msg.text());
  });
  await page.addInitScript(() => {
    const now = Date.now();
    localStorage.setItem('ds4web.settings.v2', JSON.stringify({
      v: 2,
      onboarded: true,
      theme: 'light',
      model: 'deepseek-v4-flash',
      modelVariant: 'flash',
      thinkLevel: 'max',
      ctxSize: 65536,
      gsaLoop: 'on',
      webMode: 'off',
      workdirs: { agent: '/tmp/dstudio-gsa-ui-test' },
    }));
    localStorage.setItem('ds4web.chats.v2', JSON.stringify({
      v: 2,
      deleted: [],
      chats: [{ id: 'agent-gsa', mode: 'agent', title: 'GSA seed', createdAt: now, updatedAt: now, messages: [], transcript: '' }],
    }));
    localStorage.setItem('ds4web.active.v2', JSON.stringify({ v: 2, ids: { chat: null, agent: 'agent-gsa', design: null } }));
  });

  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
  await page.locator('#tab-agent').click();
  await page.waitForFunction(() => !document.querySelector('#agent-view')?.hidden);
  await page.locator('#composer-input').fill('/gsa Review https://tikrec.com/latest');
  await page.locator('#btn-send').click();

  const debugDetails = () => JSON.stringify({
    gsaStarts,
    gsaPhases: gsaPhases.map((p) => ({ phase: p.phase, output: String(p.output || '').slice(0, 120) })),
    sends: sends.map((s) => ({ displayPrompt: s.displayPrompt, prompt: String(s.prompt || '').slice(0, 80) })),
    missingRequests,
    pageErrors,
  }, null, 2);
  await waitFor(() => gsaPhases.some((p) => p.phase === 'report'), 'GSA report phase was not saved', debugDetails);
  await waitFor(() => gsaStarts.length >= 2, 'GSA loop did not start a second run', debugDetails);

  assert.equal(gsaPhases.map((p) => p.phase).slice(0, 4).join(','), 'selection,preflight,validation,report');
  assert.equal(gsaStarts[1].parentRunDir, '/tmp/dstudio-gsa-ui-test/.dstudio/gsa/runs/run-1');
  assert.ok(sends.every((s) => /"value":"max"/.test(s.prompt || '')), 'every GSA send should force thinking max');

  await page.locator('.gsa-phase-card').first().waitFor({ timeout: 5000 });
  const cardText = await page.locator('.gsa-phase-card').first().innerText();
  assert.match(cardText, /Selection JSON captured/);
  assert.match(cardText, /Unsecured API endpoint/);

  const overflow = await page.evaluate(() => ({
    page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    agent: (document.querySelector('#agent-view')?.scrollWidth || 0) - (document.querySelector('#agent-view')?.clientWidth || 0),
  }));
  assert.ok(overflow.page <= 1, `page has horizontal overflow: ${JSON.stringify(overflow)}`);
  assert.ok(overflow.agent <= 1, `agent view has horizontal overflow: ${JSON.stringify(overflow)}`);
  assert.deepEqual(pageErrors, [], `page errors: ${JSON.stringify({ pageErrors, missingRequests }, null, 2)}`);
  console.log('ui_gsa_playwright_test: ok');
} finally {
  await browser.close().catch(() => {});
  server.close();
}

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.log('ui_rsa_playwright_test: playwright missing, skipping');
  process.exit(0);
}

const repoRoot = process.cwd();
const webRoot = path.join(repoRoot, 'web');
const U_OPEN = '\u0001USER\u0002';
const U_CLOSE = '\u0001ENDUSER\u0002';

let currentMode = 'agent';
let transcript = '';
let runSeq = 0;
const rsaStarts = [];
const rsaPhases = [];
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
  if (prompt.includes('CAPTURE_PROMPT')) {
    return JSON.stringify({
      phase: 'capture',
      kind: 'rsa',
      collectors: [{
        id: 'network_har',
        status: 'complete',
        evidenceRefs: ['evidence.jsonl:E1'],
      }],
      evidence: [{
        status: 'VERIFIED',
        source: 'https://streamrecorder.io/',
        evidence: 'Initial HTML loaded and public navigation was visible.',
        confidence: 'high',
      }],
      routeGraph: { nodes: 12, edges: 18, notable: ['homepage -> script assets', 'script -> search endpoint'] },
      files: ['evidence.jsonl'],
      sectionsReady: ['Frontend Architecture'],
      unknowns: ['Private worker architecture'],
    });
  }
  if (prompt.includes('STRUCTURE_PROMPT')) {
    return JSON.stringify({
      phase: 'structure',
      kind: 'rsa',
      structurePath: '/tmp/dstudio-rsa-ui-test/STRUCTURE.MD',
      updatedSections: ['Frontend Architecture'],
      claims: [{
        id: 'C1',
        status: 'VERIFIED',
        section: 'Frontend Architecture',
        claim: 'The public HTML exposes a script-enhanced frontend.',
        evidenceRefs: ['evidence.jsonl:E1'],
        evidence: 'public HTML and script list',
      }],
      claimAudit: { unsupportedClaims: 0, missingEvidenceRefs: 0 },
      unknowns: ['Database'],
      nextTargets: ['API requests'],
    });
  }
  if (prompt.includes('REVIEW_PROMPT')) {
    return JSON.stringify({
      phase: 'review',
      kind: 'rsa',
      structurePath: '/tmp/dstudio-rsa-ui-test/STRUCTURE.MD',
      status: 'complete',
      qualityGate: { pass: true, failedChecks: [] },
      claimAudit: { unsupportedClaims: 0, missingEvidenceRefs: 0 },
      fixed: ['Removed unsupported claim'],
      remainingUnknowns: ['Backend queue'],
      nextRecommendedLoop: 'Public API Surface',
    });
  }
  return JSON.stringify({
    phase: 'inventory',
    kind: 'rsa',
    targetUrl: 'https://streamrecorder.io/',
    targetHost: 'streamrecorder.io',
    collectors: [{
      id: 'html_inventory',
      why: 'Capture public routes and static assets first.',
      status: 'selected',
    }],
    surface: [{
      url: 'https://streamrecorder.io/',
      type: 'page',
      evidence: 'landing page reachable',
    }],
    sections: [{
      name: 'Frontend Architecture',
      status: 'weak',
      nextEvidence: 'script and network request capture',
    }],
    skills: ['rsa-structure-reconstruction'],
    nextActions: ['capture public HTML and headers'],
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
      workdir: '/tmp/dstudio-rsa-ui-test',
      jsonl: true,
      ds4dirOk: true,
      webdirOk: true,
      lan: false,
      variants: { flash: true, pro: false },
      variant: 'flash',
      engineLine: 'rsa ui test ready',
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
  if (url.pathname === '/api/doctor' || url.pathname === '/api/diagnostics') {
    json(res, 200, { ok: true, issues: [], checks: [], tasks: [], recentLogs: [] });
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
  if (url.pathname === '/api/rsa/start' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req) || '{}');
    rsaStarts.push(body);
    runSeq += 1;
    const runId = `rsa-run-${runSeq}`;
    json(res, 200, {
      ok: true,
      taskId: runSeq,
      runId,
      workdir: body.workdir || '/tmp/dstudio-rsa-ui-test',
      runDir: `/tmp/dstudio-rsa-ui-test/.dstudio/rsa/runs/${runId}`,
      statePath: `/tmp/dstudio-rsa-ui-test/.dstudio/rsa/runs/${runId}/run_state.json`,
      parentRunDir: body.parentRunDir || '',
      structurePath: '/tmp/dstudio-rsa-ui-test/STRUCTURE.MD',
      iteration: runSeq,
      targetUrl: 'https://streamrecorder.io/',
      think: 'max',
      skillCount: 4,
      prompt: 'INVENTORY_PROMPT',
      rsaTools: { mode: 'tool-assisted', tools: [] },
    });
    return;
  }
  if (url.pathname === '/api/rsa/phase' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req) || '{}');
    rsaPhases.push(body);
    const nextPrompt = body.phase === 'inventory' ? 'CAPTURE_PROMPT'
      : body.phase === 'capture' ? 'STRUCTURE_PROMPT'
      : body.phase === 'structure' ? 'REVIEW_PROMPT' : '';
    json(res, 200, {
      ok: true,
      taskId: rsaPhases.length,
      complete: body.phase === 'review',
      nextPrompt,
      statePath: `/tmp/dstudio-rsa-ui-test/.dstudio/rsa/runs/${body.runId}/run_state.json`,
      structurePath: '/tmp/dstudio-rsa-ui-test/STRUCTURE.MD',
      claimAuditPath: `/tmp/dstudio-rsa-ui-test/.dstudio/rsa/runs/${body.runId}/claim-audit.json`,
      qualityGatePath: `/tmp/dstudio-rsa-ui-test/.dstudio/rsa/runs/${body.runId}/quality-gate.json`,
      routeGraphPath: `/tmp/dstudio-rsa-ui-test/.dstudio/rsa/runs/${body.runId}/route-graph.json`,
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
    console.log('ui_rsa_playwright_test: browser missing, skipping');
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
    localStorage.setItem('ds4web.settings.v1', JSON.stringify({
      v: 1,
      onboarded: true,
      theme: 'light',
      model: 'deepseek-v4-flash',
      modelVariant: 'flash',
      thinkLevel: 'max',
      ctxSize: 65536,
      useJsonlPatch: true,
      webMode: 'off',
      workdirs: { agent: '/tmp/dstudio-rsa-ui-test' },
      onboardedVersion: 8,
    }));
    localStorage.setItem('ds4web.chats.v1', JSON.stringify({
      v: 1,
      deleted: [],
      chats: [{ id: 'agent-rsa', mode: 'agent', title: 'RSA seed', createdAt: now, updatedAt: now, messages: [], transcript: '' }],
    }));
    localStorage.setItem('ds4web.active.v1', JSON.stringify({ v: 1, ids: { chat: null, agent: 'agent-rsa', design: null } }));
  });

  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
  await page.locator('#tab-agent').click();
  await page.waitForFunction(() => !document.querySelector('#agent-view')?.hidden);
  await page.locator('#composer-input').fill('/rsa Analyze https://streamrecorder.io/ into STRUCTURE.MD');
  await page.locator('#btn-send').click();

  const debugDetails = () => JSON.stringify({
    rsaStarts,
    rsaPhases: rsaPhases.map((p) => ({ phase: p.phase, output: String(p.output || '').slice(0, 120) })),
    sends: sends.map((s) => ({ displayPrompt: s.displayPrompt, prompt: String(s.prompt || '').slice(0, 80) })),
    missingRequests,
    pageErrors,
  }, null, 2);
  await waitFor(() => rsaPhases.some((p) => p.phase === 'review'), 'RSA review phase was not saved', debugDetails);

  assert.equal(rsaStarts.length, 1);
  assert.match(rsaStarts[0].mission, /streamrecorder\.io/);
  assert.equal(rsaPhases.map((p) => p.phase).join(','), 'inventory,capture,structure,review');
  assert.ok(sends.every((s) => /"value":"max"/.test(s.prompt || '')), 'every RSA send should force thinking max');

  await page.locator('.gsa-phase-card').first().waitFor({ timeout: 5000 });
  const cardText = await page.locator('.gsa-phase-card').allInnerTexts().then((items) => items.join('\n'));
  assert.match(cardText, /RSA/);
  assert.match(cardText, /Inventory JSON captured/);
  assert.match(cardText, /Frontend Architecture/);
  assert.match(cardText, /collectors/i);
  assert.match(cardText, /Evidence/i);
  assert.match(cardText, /Route graph/i);
  assert.match(cardText, /Unknowns/i);
  assert.match(cardText, /quality gate/i);
  assert.deepEqual(pageErrors, [], `page errors: ${JSON.stringify({ pageErrors, missingRequests }, null, 2)}`);
  console.log('ui_rsa_playwright_test: ok');
} finally {
  await browser.close().catch(() => {});
  server.close();
}

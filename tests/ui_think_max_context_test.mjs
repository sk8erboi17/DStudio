/* Thinking: max is only the real maximum from DS4_TRUE_MAX_CONTEXT upwards.
 * Selecting it therefore negotiates the context instead of silently claiming a
 * level the engine will not run:
 *   - declining leaves BOTH the thinking level and the context untouched;
 *   - accepting raises the context and restarts once (no second prompt);
 *   - leaving max hands the original context back;
 *   - on a Mac where that context no longer fits the Metal budget, the cost is
 *     stated before the restart rather than discovered as a slow session.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import assert from 'node:assert/strict';

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.log('ui_think_max_context_test: playwright missing, skipping');
  process.exit(0);
}

const repoRoot = process.cwd();
const webRoot = path.join(repoRoot, 'web');
const starts = [];
// A 96 GB Mac running the 80.76 GiB DeepSeek V4 Flash vision build: the launch
// budget is min(iogpu limit, RAM - 8 GiB), so 384k of context no longer fits.
const memory = {
  physicalBytes: 96 * 1073741824,
  modelBytes: 86720111776,
  iogpuWiredLimitMb: 90112,
  iogpuWiredTargetMb: 86016,
  iogpuWiredMinMb: 86016,
  iogpuWiredMaxMb: 90112,
  ssdStreamingEffective: false,
};

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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  const p = url.pathname;
  if (p === '/api/status') {
    return json(res, 200, {
      mode: 'agent', running: true, ready: true, loadPct: 100, stage: 'Ready',
      agentWorking: false, workdir: '/tmp/dstudio-think-test', ds4dirOk: true, webdirOk: true, lan: false,
      config: { ctx: 65536, power: 90, think: 'high', ssdStreaming: 'auto' },
      variants: { flash: true, pro: false }, variant: 'flash',
      modelFile: 'gguf/DeepSeek-V4-Flash-Vision-Exp.gguf', engineLine: 'ready',
    });
  }
  if (p === '/api/start' && req.method === 'POST') {
    starts.push(JSON.parse(await readBody(req) || '{}'));
    return json(res, 200, { ok: true });
  }
  if (p === '/api/diagnostics') {
    return json(res, 200, { ok: true, summary: {}, runtime: {}, lan: {}, memory, tasks: { recent: [] }, logs: { recentErrors: [] } });
  }
  if (p === '/api/store') { if (req.method === 'POST') await readBody(req); return json(res, 200, { ok: true, rev: 0, data: null }); }
  if (p === '/api/storerev') return json(res, 200, { rev: 0 });
  if (p === '/api/agent/poll') return json(res, 200, { base: 0, len: 0, working: false, ready: true, loadPct: 100, text: '' });
  if (p === '/api/doctor') return json(res, 200, { ok: true, checks: [] });
  if (p === '/api/ggufs') return json(res, 200, { ok: true, files: [] });
  if (p === '/api/engine/checkouts') return json(res, 200, { ok: true, checkouts: [] });
  if (p === '/api/remote/status') return json(res, 200, { ok: true, enabled: false });
  if (p === '/api/lan-client/chats') return json(res, 200, { ok: true, chats: [] });
  if (p === '/api/user-skills' || p === '/api/design-systems') return json(res, 200, { ok: true, skills: [], designSystems: [] });
  if (p === '/api/tasks') return json(res, 200, { ok: true, tasks: [] });
  if (p === '/v1/models') return json(res, 200, { data: [{ id: 'deepseek-v4-flash' }] });
  if (p === '/favicon.ico') { res.writeHead(204); return res.end(); }

  const file = p === '/' ? path.join(webRoot, 'index.html') : path.join(webRoot, p);
  if (!file.startsWith(webRoot) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404);
    return res.end('not found');
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
  server.close();
  console.log('ui_think_max_context_test: browser missing, skipping');
  process.exit(0);
}

const settings = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('ds4web.settings.v2') || '{}'));

try {
  const page = await browser.newPage({ viewport: { width: 1320, height: 800 } });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e?.stack || e?.message || String(e)));
  await page.addInitScript(() => {
    const now = Date.now();
    localStorage.setItem('ds4web.settings.v2', JSON.stringify({
      v: 2, onboarded: true, model: 'deepseek-v4-flash', modelVariant: 'flash',
      thinkLevel: 'high', ctxSize: 65536, enginePower: 90, ssdStreaming: 'auto',
      workdirs: { agent: '/tmp/dstudio-think-test' },
    }));
    localStorage.setItem('ds4web.chats.v2', JSON.stringify({
      v: 2, deleted: [],
      chats: [{ id: 'agent-think', mode: 'agent', title: 'Think', createdAt: now, updatedAt: now, messages: [], transcript: '' }],
    }));
    localStorage.setItem('ds4web.active.v2', JSON.stringify({ v: 2, ids: { chat: null, agent: 'agent-think' } }));
  });

  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
  await page.locator('#tab-agent').click();
  await page.waitForFunction(() => !document.querySelector('#agent-view')?.hidden);

  const pill = page.locator('.cbar-think-btn');
  const pickMax = async () => {
    await pill.click();
    await page.locator('.cbar-think-item').filter({ hasText: 'Thinking: max' }).click();
    await page.locator('#confirm-dialog[open]').waitFor({ timeout: 5000 });
  };

  // The default is not max: max is an explicit choice, not something a fresh
  // install starts in.
  assert.match(await pill.textContent(), /Thinking: high/, 'a fresh profile should not start at Thinking: max');
  await pill.click();
  assert.match(
    await page.locator('.cbar-think-item').filter({ hasText: 'Thinking: max' }).textContent(),
    /needs 384k context/,
    'the max option should state the context it needs before it is picked',
  );
  await page.keyboard.press('Escape');
  await page.locator('body').click({ position: { x: 5, y: 5 } });

  // Declining changes nothing at all.
  await pickMax();
  const body = await page.locator('#confirm-body').textContent();
  assert.match(body, /384k/, 'the prompt should name the context Thinking: max needs');
  assert.match(body, /64k/, 'the prompt should name the context being left behind');
  assert.match(body, /96 GB RAM/, 'the warning should name the machine it is about');
  assert.match(body, /memory-mapped path/,
    'on a Mac where 384k no longer fits the Metal budget the residency cost must be stated up front');
  await page.locator('#confirm-cancel').click();
  const declined = await settings(page);
  assert.equal(declined.thinkLevel, 'high', 'declining must leave the thinking level alone');
  assert.equal(declined.ctxSize, 65536, 'declining must leave the context alone');
  assert.equal(starts.length, 0, 'declining must not restart the engine');
  assert.match(await pill.textContent(), /Thinking: high/, 'the pill must fall back to the level actually in use');

  // Accepting raises the context and restarts exactly once — the restart was
  // part of what was agreed to, so it is not put to the user a second time.
  await pickMax();
  await page.locator('#confirm-go').click();
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('ds4web.settings.v2') || '{}').ctxSize === 393216, null, { timeout: 5000 });
  const accepted = await settings(page);
  assert.equal(accepted.thinkLevel, 'max');
  assert.equal(accepted.ctxBeforeThinkMax, 65536, 'the context to restore must be remembered');
  await page.waitForFunction(() => !document.querySelector('#confirm-dialog')?.open, null, { timeout: 5000 });
  assert.equal(await page.locator('#confirm-dialog[open]').count(), 0, 'accepting must not raise a second restart prompt');
  assert.equal(starts.length, 1, 'accepting should restart the engine once');
  assert.equal(starts[0].ctx, 393216, 'the restart should carry the raised context');
  assert.doesNotMatch(await pill.textContent(), /needs 384k/, 'at 384k the max pill is no longer underfed');

  // Leaving max hands the context back, with its own restart prompt.
  await pill.click();
  await page.locator('.cbar-think-item').filter({ hasText: 'Thinking: high' }).click();
  await page.locator('#confirm-dialog[open]').waitFor({ timeout: 5000 });
  await page.locator('#confirm-go').click();
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('ds4web.settings.v2') || '{}').ctxSize === 65536, null, { timeout: 5000 });
  const restored = await settings(page);
  assert.equal(restored.thinkLevel, 'high');
  assert.equal(restored.ctxBeforeThinkMax, 0, 'the remembered context is consumed once it has been given back');

  // A profile that already carries max below the minimum (written by the old
  // quality-defaults migration, or forced by guided analysis) must say so
  // rather than claim a level the engine is not running.
  const legacy = await browser.newPage({ viewport: { width: 1320, height: 800 } });
  legacy.on('pageerror', (e) => pageErrors.push(e?.stack || e?.message || String(e)));
  await legacy.addInitScript(() => {
    const now = Date.now();
    localStorage.setItem('ds4web.settings.v2', JSON.stringify({
      v: 2, onboarded: true, model: 'deepseek-v4-flash', modelVariant: 'flash',
      thinkLevel: 'max', ctxSize: 131072, qualityDefaultsVersion: 1,
      enginePower: 90, ssdStreaming: 'auto', workdirs: { agent: '/tmp/dstudio-think-test' },
    }));
    localStorage.setItem('ds4web.chats.v2', JSON.stringify({
      v: 2, deleted: [],
      chats: [{ id: 'agent-legacy', mode: 'agent', title: 'Legacy', createdAt: now, updatedAt: now, messages: [], transcript: '' }],
    }));
    localStorage.setItem('ds4web.active.v2', JSON.stringify({ v: 2, ids: { chat: null, agent: 'agent-legacy' } }));
  });
  await legacy.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
  await legacy.locator('#tab-agent').click();
  await legacy.waitForFunction(() => !document.querySelector('#agent-view')?.hidden);
  assert.match(await legacy.locator('.cbar-think-btn').textContent(), /Thinking: max · needs 384k/,
    'a persisted max below the minimum context must be flagged, not shown as effective');
  const migrated = await legacy.evaluate(() => JSON.parse(localStorage.getItem('ds4web.settings.v2') || '{}'));
  assert.equal(migrated.thinkLevel, 'max',
    'the migration must not silently flip a level the user may have chosen');
  assert.equal(migrated.qualityDefaultsVersion, 2,
    'the quality-defaults migration should advance past the version that imposed max');

  assert.deepEqual(pageErrors, [], 'no page errors');
  console.log('ui_think_max_context_test: ok');
} finally {
  await browser.close();
  server.close();
}

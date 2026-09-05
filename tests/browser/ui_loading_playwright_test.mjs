import fs from 'node:fs';
import http from 'node:http';
import assert from 'node:assert/strict';

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.log('ui_loading_playwright_test: playwright missing, NOT RUN');
  process.exit(1);
}

const loadingHtml = fs.readFileSync('web/loading.html');
let started = false;
let startBody = null;
let checkoutBody = null;
let requireDsparkConfirmation = false;
const startBodies = [];
let previewStatus = null;

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
  if (url.pathname === '/loading.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': loadingHtml.length });
    res.end(loadingHtml);
    return;
  }
  if (url.pathname === '/api/status') {
    if (previewStatus) { json(res, 200, previewStatus); return; }
    json(res, 200, {
      mode: started ? 'server' : 'none',
      running: started,
      ready: started,
      loadPct: started ? 100 : 2,
      stage: started ? 'Ready' : 'Applying saved engine settings…',
      ds4dir: checkoutBody?.dir || '/engines/ds4',
      ds4dirOk: true,
      models: { standard: false, uncensored: true },
      variants: { flash: true, pro: false },
      variant: 'flash',
      modelFile: 'gguf/DeepSeek-V4-Flash-test.gguf',
    });
    return;
  }
  if (url.pathname === '/api/ggufs') {
    json(res, 200, {
      ok: true,
      activeEngine: '/engines/ds4',
      ggufs: [{
        file: 'laguna-test.gguf',
        path: 'gguf/laguna-test.gguf',
        engineDir: '/engines/ds4-laguna-s21',
        branch: 'laguna-s2.1',
        activeEngine: false,
      }],
    });
    return;
  }
  if (url.pathname === '/api/engine/checkout' && req.method === 'POST') {
    checkoutBody = JSON.parse(await readBody(req) || '{}');
    json(res, 200, { ok: true, dir: checkoutBody.dir, branch: 'laguna-s2.1', changed: true });
    return;
  }
  if (url.pathname === '/api/start' && req.method === 'POST') {
    startBody = JSON.parse(await readBody(req) || '{}');
    startBodies.push(startBody);
    if (requireDsparkConfirmation && startBody.dspark && !startBody.allowOverBudgetDspark) {
      json(res, 409, {
        ok: false,
        code: 'dspark_memory_confirmation',
        confirmationRequired: true,
        requiredBytes: 108 * 1024 ** 3,
        budgetBytes: 88 * 1024 ** 3,
        error: "DSpark needs the main model, its support model and the requested context at the same time (estimated 108.0 GiB), which exceeds this Mac's 88.0 GiB Metal memory budget. macOS may page heavily or terminate the engine.",
      });
      return;
    }
    started = true;
    json(res, 200, requireDsparkConfirmation
      ? { ok: true, mode: 'server', adjusted: false, ctx: startBody.ctx, dspark: true,
          warning: 'Starting DSpark by user confirmation' }
      : { ok: true, mode: 'server', adjusted: true, ctx: 65536, dspark: false,
          warning: 'Memory-safe test adjustment' });
    return;
  }
  if (url.pathname === '/') {
    const body = '<!doctype html><title>DStudio ready</title><p id="ready">Ready</p>';
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(body) });
    res.end(body);
    return;
  }
  if (url.pathname === '/favicon.ico') {
    res.writeHead(204);
    res.end();
    return;
  }
  res.writeHead(404);
  res.end('not found');
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

let browser;
try {
  browser = await chromium.launch();
} catch {
  server.close();
  console.log('ui_loading_playwright_test: browser missing, NOT RUN');
  process.exit(1);
}

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e?.stack || e?.message || String(e)));
  page.on('console', (msg) => { if (msg.type() === 'error') pageErrors.push(msg.text()); });
  await page.addInitScript(() => {
    if (localStorage.getItem('ds4web.settings.v2')) return;
    localStorage.setItem('ds4web.settings.v2', JSON.stringify({
      v: 2,
      onboarded: true,
      model: 'deepseek-v4-pro',
      modelVariant: 'flash',
      modelGguf: 'gguf/laguna-test.gguf',
      modelEngineDir: '/old/location/ds4-laguna-s21',
      ctxSize: 131072,
      enginePower: 70,
      ssdStreaming: 'off',
      dspark: true,
    }));
  });

  await page.goto(`http://127.0.0.1:${port}/loading.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForURL(`http://127.0.0.1:${port}/`, { timeout: 8000 });
  await page.locator('#ready').waitFor();

  assert.ok(startBody, 'loading page should POST /api/start');
  assert.equal(startBody.mode, 'server');
  assert.equal(startBody.model, 'standard');
  assert.equal(startBody.variant, 'flash');
  assert.equal(startBody.gguf, 'gguf/laguna-test.gguf');
  assert.deepEqual(checkoutBody, { dir: '/engines/ds4-laguna-s21' }, 'stale GGUF checkout should be repaired and switched before start');
  assert.equal(startBody.ctx, 131072);
  assert.equal(startBody.power, 70);
  assert.equal(startBody.ssdStreaming, 'off', 'saved Off must reach the launcher unchanged');
  const savedAfterStart = JSON.parse(await page.evaluate(() => localStorage.getItem('ds4web.settings.v2')));
  assert.equal(savedAfterStart.ctxSize, 65536, 'native memory adjustment should replace the unsafe saved context');
  assert.equal(savedAfterStart.dspark, false, 'native memory adjustment should persist DSpark being disabled');
  assert.deepEqual(pageErrors, []);

  // Simulated launcher, real loading-page requests: inherited expert streaming
  // must not prevent Qwen boot or overwrite the preference for other models.
  for (const model of ['Qwen3.8-Flash-Next-test', 'DeepSeek-V4-Flash-test']) {
    for (const preference of ['on', 'auto', 'off']) {
      started = false;
      startBody = null;
      const boot = await browser.newPage();
      const errors = [];
      boot.on('pageerror', e => errors.push(e.message));
      await boot.addInitScript(({ model, preference }) => {
        if (localStorage.getItem('ds4web.settings.v2')) return;
        localStorage.setItem('ds4web.settings.v2', JSON.stringify({
          onboarded: true, modelGguf: `gguf/${model}.gguf`,
          ctxSize: 8192, ssdStreaming: preference,
        }));
      }, { model, preference });
      const before = startBodies.length;
      await boot.goto(`http://127.0.0.1:${port}/loading.html`);
      await boot.waitForURL(`http://127.0.0.1:${port}/`, { timeout: 8000 });
      assert.equal(startBodies.length, before + 1, 'exactly one launch per boot');
      assert.equal(startBody.gguf, `gguf/${model}.gguf`);
      assert.equal(startBody.ssdStreaming, model.startsWith('Qwen') ? 'off' : preference,
        `${model} with saved SSD streaming ${preference}`);
      const persisted = await boot.evaluate(() => JSON.parse(localStorage.getItem('ds4web.settings.v2')));
      assert.equal(persisted.ssdStreaming, preference, 'model-specific choice must not replace the global preference');
      assert.equal(persisted.ctxSize, 65536, 'preference must survive a simultaneous backend config adjustment');
      assert.deepEqual(errors, []);
      await boot.close();
    }
  }

  started = false;
  startBody = null;
  requireDsparkConfirmation = true;
  const callsBeforeConfirmation = startBodies.length;
  const confirmPage = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const confirmErrors = [];
  confirmPage.on('pageerror', (e) => confirmErrors.push(e?.stack || e?.message || String(e)));
  confirmPage.on('console', (msg) => { if (msg.type() === 'error') confirmErrors.push(msg.text()); });
  await confirmPage.addInitScript(() => {
    localStorage.setItem('ds4web.settings.v2', JSON.stringify({
      v: 2,
      onboarded: true,
      modelVariant: 'flash',
      modelGguf: '',
      modelEngineDir: '',
      ctxSize: 131072,
      enginePower: 90,
      ssdStreaming: 'off',
      dspark: true,
    }));
  });
  await confirmPage.goto(`http://127.0.0.1:${port}/loading.html`, { waitUntil: 'domcontentloaded' });
  const dialog = confirmPage.locator('#dspark-memory-dialog');
  await dialog.waitFor({ state: 'visible' });
  assert.equal(started, false, 'the over-budget preflight must not start the engine before confirmation');
  assert.match(await confirmPage.locator('#dspark-memory-reason').innerText(), /108\.0 GiB.*88\.0 GiB.*terminate the engine/s);
  assert.equal(startBodies.length, callsBeforeConfirmation + 1, 'the loading gate should make one non-destructive preflight request');
  assert.equal(startBodies.at(-1).allowOverBudgetDspark, undefined);
  await confirmPage.locator('#dspark-memory-start').click();
  await confirmPage.waitForURL(`http://127.0.0.1:${port}/`, { timeout: 8000 });
  assert.equal(startBodies.length, callsBeforeConfirmation + 2, 'confirmation should retry the launch exactly once');
  assert.equal(startBodies.at(-1).allowOverBudgetDspark, true, 'the retry must carry the explicit DSpark override');
  assert.equal(startBodies.at(-1).dspark, true, 'the confirmed launch must keep DSpark enabled');
  assert.equal(started, true);
  assert.deepEqual(confirmErrors.filter((message) => !/Failed to load resource:.*409 \(Conflict\)/.test(message)), []);
  await confirmPage.close();

  // Real browser rendering with a stub launcher only: never load model weights.
  const artifactDir = 'tests/.artifacts/loading-design';
  fs.mkdirSync(artifactDir, { recursive: true });
  const logoData = loadingHtml.toString().match(/<img class="logo" src="data:image\/png;base64,([^"]+)"/);
  assert.ok(logoData, 'loading must embed the actual brand mark for offline/bundled launches');
  assert.deepEqual(Buffer.from(logoData[1], 'base64'), fs.readFileSync('assets/logo.png'));
  const startsBeforePreviews = startBodies.length;
  for (const theme of ['light', 'dark']) {
    previewStatus = {
      running: true, ready: false, mode: 'server', loadPct: 52,
      stage: 'Loading DS4 Flash…',
      engineLine: 'ds4: memory: KV 0.42 GiB + buffers 0.06 GiB + resident model 80.76 GiB = 81.24 GiB planned',
      modelFile: 'gguf/DeepSeek-V4-Flash-test.gguf', config: { ctx: 65536, ssdStreaming: 'off' },
    };
    const visual = await browser.newPage({ viewport: { width: 1020, height: 684 }, reducedMotion: 'reduce' });
    const visualErrors = [], externalRequests = [];
    visual.on('pageerror', e => visualErrors.push(e.message));
    await visual.route('**/*', route => {
      if (!route.request().url().startsWith(`http://127.0.0.1:${port}/`)) {
        externalRequests.push(route.request().url()); return route.abort();
      }
      return route.continue();
    });
    await visual.addInitScript(({ theme }) => {
      localStorage.setItem('ds4web.settings.v2', JSON.stringify({ onboarded: true, theme, ctxSize: 131072, ssdStreaming: 'on' }));
      window.__themeMessages = [];
      window.webkit = { messageHandlers: { ds4Theme: { postMessage: value => window.__themeMessages.push(value) } } };
    }, { theme });
    await visual.goto(`http://127.0.0.1:${port}/loading.html`);
    await visual.waitForFunction(() => document.querySelector('#loading-pct').textContent === '52%');
    assert.equal(await visual.locator('html').getAttribute('data-theme'), theme);
    assert.equal(await visual.evaluate(() => window.__themeMessages.at(-1)), theme, 'native window chrome must receive the loading theme');
    assert.equal(await visual.locator('#boot-context').innerText(), '64k', 'running config must override saved context');
    assert.equal(await visual.locator('#boot-memory-label').textContent(), 'Memory plan', 'planned memory must not be labelled as live usage');
    assert.equal(await visual.locator('#boot-memory').innerText(), '81.2 GiB');
    assert.equal(await visual.locator('#boot-prefill').innerText(), '—', 'no synthetic prefill counter');
    assert.equal(await visual.locator('.boot-step.done').count(), 2);
    assert.equal(await visual.locator('.boot-step.active .boot-step__label').innerText(), 'Model runtime');
    assert.equal(await visual.locator('.boot-step.active .boot-step__detail').innerText(), 'loading');
    assert.equal(await visual.locator('.logo').evaluate(img => img.complete && img.naturalWidth > 0), true);
    const geometry = await visual.locator('main').boundingBox();
    assert.equal(geometry.width, 504, 'desktop glass panel must match the supplied design width');
    assert.ok(geometry.y >= 0 && geometry.y + geometry.height <= 684, 'desktop panel must fit the native content area');
    assert.equal(await visual.locator('.logo').evaluate(el => getComputedStyle(el).animationName), 'none');
    assert.equal(await visual.locator('main').evaluate(el => getComputedStyle(el).borderRadius), '26px');
    await visual.screenshot({ path: `${artifactDir}/${theme}-desktop.png`, fullPage: true });
    await visual.emulateMedia({ reducedMotion: 'no-preference' });
    assert.equal(await visual.locator('.logo').evaluate(el => getComputedStyle(el).animationName), 'mark-spin');
    await visual.emulateMedia({ reducedMotion: 'reduce' });

    previewStatus = { ...previewStatus, loadPct: 92, stage: 'Prefilling 3,599 / 8,192 tokens…', engineLine: '' };
    await visual.waitForFunction(() => document.querySelector('#boot-prefill').textContent === '3,599 tok');
    assert.equal(await visual.locator('#boot-memory').innerText(), '81.2 GiB', 'preserve an already reported plan across log lines');
    assert.equal(await visual.locator('.boot-step.active').getAttribute('aria-current'), 'step');
    previewStatus = { ...previewStatus, loadPct: 100, stage: 'Finalizing the local runtime…' };
    await visual.waitForFunction(() => document.querySelector('#loading-pct').textContent === '99%');
    assert.ok(visual.url().endsWith('/loading.html'), 'an unready engine must not complete the loading page at 100%');
    assert.equal(await visual.locator('.boot-step.done').count(), 3);

    previewStatus = { ...previewStatus, modelFile: 'gguf/another-model.gguf' };
    await visual.waitForFunction(() => document.querySelector('#boot-memory').textContent === '—');
    assert.equal(await visual.locator('#boot-prefill').innerText(), '—', 'never carry metrics into a different model');
    await visual.setViewportSize({ width: 360, height: 740 });
    assert.ok(await visual.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'mobile layout must not overflow sideways');
    await visual.screenshot({ path: `${artifactDir}/${theme}-mobile.png`, fullPage: true });
    await visual.setViewportSize({ width: 320, height: 480 });
    await visual.locator('.boot-foot a').scrollIntoViewIfNeeded();
    assert.ok(await visual.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    const settingsLink = await visual.locator('.boot-foot a').boundingBox();
    assert.ok(settingsLink.y >= 0 && settingsLink.y + settingsLink.height <= 480, 'settings must remain reachable on short windows');

    previewStatus = { ...previewStatus, ready: true };
    await visual.waitForURL(`http://127.0.0.1:${port}/`, { timeout: 5000 });
    assert.deepEqual(visualErrors, []);
    assert.deepEqual(externalRequests, [], 'loading may not download fonts, frameworks or branding');
    await visual.close();
  }
  previewStatus = { running: true, ready: false, loadPct: 40, stage: 'Mapping the model…', engineLine: '', config: { ctx: 8192 } };
  const systemPage = await browser.newPage({ colorScheme: 'dark' });
  await systemPage.addInitScript(() => {
    localStorage.setItem('ds4web.settings.v2', JSON.stringify({ onboarded: true, theme: 'system' }));
    window.__themeMessages = [];
    window.webkit = { messageHandlers: { ds4Theme: { postMessage: value => window.__themeMessages.push(value) } } };
  });
  await systemPage.goto(`http://127.0.0.1:${port}/loading.html`);
  await systemPage.waitForFunction(() => document.querySelector('#loading-pct').textContent === '40%');
  assert.equal(await systemPage.locator('html').getAttribute('data-theme'), 'dark');
  assert.equal(await systemPage.locator('#boot-memory').textContent(), '—');
  assert.equal(await systemPage.locator('#boot-prefill').textContent(), '—');
  await systemPage.emulateMedia({ colorScheme: 'light' });
  await systemPage.waitForFunction(() => document.documentElement.dataset.theme === 'light');
  assert.equal(await systemPage.evaluate(() => window.__themeMessages.at(-1)), 'light');
  previewStatus = { ...previewStatus, running: false, stage: 'Engine needs attention', engineError: 'Test-only startup failure' };
  await systemPage.waitForFunction(() => document.querySelector('.boot-step.active .boot-step__detail').textContent === 'attention');
  await systemPage.waitForURL(`http://127.0.0.1:${port}/`, { timeout: 5000 });
  await systemPage.close();
  assert.equal(startBodies.length, startsBeforePreviews, 'attaching to a running engine must never restart it');
  previewStatus = null;
  console.log('ui_loading_playwright_test: ok');
} finally {
  await browser.close().catch(() => {});
  server.close();
}

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

// Real browser interactions with a simulated launcher. No weights or inference.
const browserName = process.env.DSTUDIO_TEST_BROWSER || 'chromium';
const playwright = await import('playwright');
assert.ok(['chromium', 'webkit'].includes(browserName));
const webRoot = path.resolve('web');
const artifactRoot = path.resolve('tests/.artifacts/model-picker', browserName);
fs.mkdirSync(artifactRoot, { recursive: true });
const artifacts = fs.mkdtempSync(path.join(artifactRoot, 'run-'));
console.log(`model-picker evidence: ${artifacts}`);
const main = '/tmp/dstudio-picker/ds4';
const qwen = '/tmp/dstudio-picker/ds4-qwen35';
const qwen38 = '/tmp/dstudio-picker/ds4-qwen38';
const qwen27 = '/tmp/dstudio-picker/q36';
const qwenFile = 'Qwen3.6-35B-A3B-UD-Q6_K_XL.gguf';
const qwen27File = 'Qwen3.8-27B-UD-Q6_K_XL.gguf';
const files = [
  ['GLM-5.3-Flash-Q2.gguf', 97e9, main, 'main'],
  ['DeepSeek-V4-Flash-IQ2XXS-w2Q2K-AProjQ8-SExpQ8-OutQ8-chat-v2-imatrix-0731.gguf', 87e9, main, 'main'],
  ['DeepSeek-V4-Flash-Q4KExperts-F16HC-F16Compressor-F16Indexer-Q8Attn-Q8Shared-Q8Out-chat-v2-imatrix-0731.gguf', 140e9, main, 'main'],
  ['DeepSeek-V4-Flash-Vision-Exp-IQ2XXS-w2Q2K-AProjQ8-SExpQ8-OutQ8.gguf', 86.7e9, main, 'main'],
  [qwenFile, 31843777504, qwen, 'qwen35moe-support'],
  ['Qwen3.8-Flash-Next-Q4KImatrixExperts-MXFP4Down-BF16Emb-BF16Control-Q8GDN-Q8QSA-Q8Shared-Q8Out.gguf', 73371680704, qwen38, 'qwen3.8-flash-next'],
  ['Qwen3.8-Flash-Next-PLE-Q4_1.gguf', 32000157440, qwen38, 'qwen3.8-flash-next'],
  [qwen27File, 25299061664, qwen27, 'qwen27b'],
  ['Qwen3.8-27B-mmproj-F16.gguf', 927607488, qwen27, 'qwen27b'],
  ['Qwen3.8-27B-Q4_K_M.gguf', 16e9, qwen27, 'qwen27b'], // Not a qualified quantization.
  ['DeepSeek-V4-Flash-DSpark-support-0731.gguf', 6e9, main, 'main'],
  ['GLM-5.3-Flash-Vision-Encoder.gguf', 1.1e9, main, 'main'],
];
let catalog = files.map(([file, size, engineDir, branch]) => ({ file, path: `gguf/${file}`, size, engineDir, branch }));
let current = catalog[0];
let engineDir = main;
let ready = true;
let config = { ctx: 131072, power: 90, ssdStreaming: 'on' };
let downloadPct = 16;
let catalogFailure = false;
let catalogHold = null;
let catalogCalls = 0;
const writes = [];
const pageErrors = [];

function json(res, data, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(data));
}
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (req.method === 'POST') {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    if (/^\/api\/(?:start|stop|engine\/checkout|model\/download)/.test(url.pathname)) writes.push({ url: url.pathname, body });
    if (url.pathname === '/api/engine/checkout') { engineDir = body.dir; json(res, { ok: true, dir: engineDir }); return; }
    if (url.pathname === '/api/start') {
      current = catalog.find(g => g.path === body.gguf && g.engineDir === engineDir);
      assert.ok(current, 'selected model must be launched with its own engine');
      config = body;
      ready = false;
      json(res, { ok: true, mode: 'server', taskId: 1 });
      return;
    }
    json(res, { ok: true }); return;
  }
  if (url.pathname === '/api/status') {
    json(res, { mode: 'server', running: true, ready, loadPct: ready ? 100 : 42, stage: ready ? 'Ready' : 'Loading model weights',
      ds4dirOk: true, webdirOk: true, ds4dir: engineDir, modelFile: current.path, config,
      download: true, downloadVariant: 'qwen36-q6', downloadPct,
      downloadBytes: 5e9, variants: { flash: true }, variant: 'flash', lan: false }); return;
  }
  if (url.pathname === '/api/ggufs') {
    catalogCalls++;
    if (catalogHold) await catalogHold;
    json(res, catalogFailure ? { ok: false, error: 'Catalog unavailable' } : { ok: true, ggufs: catalog }, catalogFailure ? 503 : 200); return;
  }
  if (url.pathname === '/api/engine/checkouts') {
    json(res, { ok: true, checkouts: [[main, 'ds4', 'main'], [qwen, 'ds4-qwen35', 'qwen35moe-support'], [qwen38, 'ds4-qwen38', 'qwen3.8-flash-next'], [qwen27, 'q36', 'qwen27b']]
      .map(([dir, name, branch]) => ({ dir, name, branch, hasServer: true, active: engineDir === dir })) }); return;
  }
  if (url.pathname === '/api/store') { json(res, { rev: 0, data: null }); return; }
  if (url.pathname === '/api/storerev') { json(res, { rev: 0 }); return; }
  if (url.pathname === '/v1/models') { json(res, { data: [{ id: current.file === qwen27File ? 'qwen3.8-27b' :
    current.file === qwenFile ? 'qwen3.6-35b-a3b' : 'glm-5.3-flash', context_length: config.ctx }] }); return; }
  if (url.pathname === '/api/video/status') { json(res, { ok: true, supported: true, installed: false }); return; }
  if (url.pathname.startsWith('/api/')) { json(res, { ok: true, tasks: [], logs: [], skills: [], designSystems: [], checks: [] }); return; }
  const file = path.resolve(webRoot, `.${url.pathname === '/' ? '/index.html' : url.pathname}`);
  if (!file.startsWith(webRoot + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'text/javascript' : 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser, page;
try {
  browser = await playwright[browserName].launch();
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('pageerror', error => pageErrors.push(String(error)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  await page.addInitScript(({ file, dir, origin }) => {
    if (window.top !== window || location.origin !== origin) return;
    localStorage.setItem('ds4web.settings.v2', JSON.stringify({ v: 2, onboarded: true, theme: 'dark', chatBackend: 'local',
      model: 'glm-5.3-flash', modelGguf: file, modelEngineDir: dir, ctxSize: 131072, enginePower: 90, ssdStreaming: 'on' }));
  }, { file: current.path, dir: main, origin });
  await page.goto(origin, { waitUntil: 'domcontentloaded' });
  const trigger = page.locator('#cbar-model .cbar-model-btn');
  const menu = page.getByRole('dialog', { name: 'Choose a model' });
  const search = menu.getByRole('textbox', { name: 'Search models' });
  const rows = menu.locator('.cbar-model-item');
  let releaseCatalog;
  catalogHold = new Promise(resolve => { releaseCatalog = resolve; });
  try {
    await trigger.click();
    await search.waitFor({ state: 'visible', timeout: 1500 });
    await search.fill('qwen');
    assert.equal(await search.evaluate(node => node === document.activeElement), true);
  } finally { releaseCatalog(); catalogHold = null; }
  await rows.filter({ hasText: 'Qwen3.6-35B-A3B' }).waitFor();
  assert.equal(await rows.count(), 3);
  assert.equal(await search.inputValue(), 'qwen', 'catalog arrival must not erase a typed search');
  assert.equal(await search.evaluate(node => node === document.activeElement), true);
  await search.fill('');
  assert.equal(await rows.count(), 8, 'seven usable chat models plus H3, with no checkout, encoder or unqualified quantization entries');
  assert.doesNotMatch(await menu.innerText(), /Engine branch|qwen35moe-support|ds4-qwen35|qwen3\.8-flash-next|DSpark-support|Vision-Encoder|PLE-Q4|mmproj|27B-Q4_K_M/);
  const loaded = menu.getByRole('region', { name: 'Loaded' }).locator('.cbar-model-item');
  assert.equal(await loaded.count(), 1);
  assert.match(await loaded.innerText(), /GLM 5\.3 Flash.*Q2/s);
  assert.equal(await loaded.getAttribute('aria-pressed'), 'true');
  await loaded.click();
  await menu.waitFor({ state: 'hidden' });
  assert.deepEqual(writes, [], 'selecting the model already running must not restart it');

  await trigger.click();
  await rows.filter({ hasText: 'Qwen3.6-35B-A3B' }).waitFor();
  await search.fill('q6_k_xl');
  assert.equal(await rows.count(), 2);
  assert.match(await rows.first().innerText(), /Qwen3\.6-35B-A3B/);
  await search.press('ArrowDown');
  assert.equal(await rows.first().evaluate(node => node === document.activeElement), true);
  await rows.first().press('ArrowUp');
  assert.equal(await search.evaluate(node => node === document.activeElement), true);
  await search.fill('not-a-real-model');
  assert.equal(await rows.count(), 0);
  assert.match(await menu.innerText(), /No models match/);
  await search.fill('qwen');
  const scansBeforeProgress = catalogCalls;
  downloadPct = 37;
  await page.waitForTimeout(2300); // Observe the actual UI download poll.
  assert.equal(await search.inputValue(), 'qwen');
  assert.equal(await search.evaluate(node => node === document.activeElement), true);
  assert.equal(catalogCalls, scansBeforeProgress, 'download polling must not rescan the picker catalog');
  assert.doesNotMatch(await trigger.innerText(), /Downloading|37%/);
  await search.press('Escape');
  await menu.waitFor({ state: 'hidden' });
  assert.equal(await trigger.getAttribute('aria-expanded'), 'false');
  assert.equal(await trigger.evaluate(node => node === document.activeElement), true);

  async function assertWithinViewport() {
    await menu.getByRole('status').filter({ hasText: 'Refreshing models' }).waitFor({ state: 'hidden' });
    // Resize includes a native frame and the sidebar's exit transition. Do not
    // disable animation: wait for the actual drawer to stop covering controls.
    await page.waitForFunction(() => {
      const box = document.querySelector('.cbar-model-menu')?.getBoundingClientRect();
      const sidebar = document.querySelector('.sidebar');
      const drawerGone = getComputedStyle(sidebar).position !== 'fixed' ||
        sidebar.getBoundingClientRect().right <= 0.5;
      return drawerGone && box && box.x >= 0 && box.y >= 0 && box.right <= innerWidth + 1 && box.bottom <= innerHeight + 1;
    }, null, { timeout: 1500 });
    const box = await menu.evaluate(node => {
      const { x, y, width, height } = node.getBoundingClientRect();
      return { x, y, width, height };
    });
    const viewport = page.viewportSize();
    assert.ok(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= viewport.width + 1 && box.y + box.height <= viewport.height + 1,
      `picker must fit viewport: ${JSON.stringify({ box, viewport })}`);
    assert.equal(await search.evaluate(node => {
      const b = node.getBoundingClientRect();
      return document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2) === node;
    }), true, 'search must be visible and hit-testable');
    const alignment = await page.evaluate(() => {
      const popup = document.querySelector('.cbar-model-menu').getBoundingClientRect();
      const button = document.querySelector('#cbar-model .cbar-model-btn').getBoundingClientRect();
      const above = button.top - 20;
      const below = innerHeight - button.bottom - 20;
      const down = above < 160 && below > above;
      return { gap: down ? popup.top - button.bottom : button.top - popup.bottom,
        left: popup.left, expectedLeft: Math.max(12, Math.min(innerWidth - popup.width - 12, button.right - popup.width)) };
    });
    assert.ok(Math.abs(alignment.gap - 8) < 1.5,
      `picker must attach to the model button, not the chat/composer card: ${JSON.stringify(alignment)}`);
    assert.ok(Math.abs(alignment.left - alignment.expectedLeft) < 1.5,
      `picker must align with the button and clamp to the viewport: ${JSON.stringify(alignment)}`);
    const controls = await page.evaluate(() => {
      const card = document.querySelector('#composer-form').getBoundingClientRect();
      return ['#cbar-gear', '#cbar-model .cbar-model-btn', '#cbar-think .cbar-think-btn', '#btn-send'].map(selector => {
        const element = document.querySelector(selector), b = element.getBoundingClientRect();
        const inset = 2;
        // Rounded corners are intentionally outside the painted hit area.
        const points = [[b.left + inset, b.top + b.height / 2], [b.right - inset, b.top + b.height / 2],
          [b.left + b.width / 2, b.top + b.height / 2]];
        return { selector, left: b.left, right: b.right, top: b.top, bottom: b.bottom, width: b.width, height: b.height,
          inside: b.left >= Math.max(0, card.left) && b.right <= Math.min(innerWidth, card.right) &&
            b.top >= Math.max(0, card.top) && b.bottom <= Math.min(innerHeight, card.bottom),
          hits: points.map(([x, y]) => { const target = document.elementFromPoint(x, y);
            return { x, y, inside: element.contains(target), target: target && `${target.tagName}#${target.id}.${target.getAttribute('class') || ''}` }; }),
          hit: points.every(([x, y]) => element.contains(document.elementFromPoint(x, y))) };
      });
    });
    for (const control of controls) assert.ok(control.inside && control.hit && control.width >= 32 && control.height >= 30,
      `every composer control must fit and remain hit-testable: ${JSON.stringify(control)}`);
    const reasoningFits = await page.locator('.cbar-think-label').evaluate(label => {
      const range = document.createRange();
      range.selectNodeContents(label.lastElementChild);
      const value = range.getBoundingClientRect(), clip = label.getBoundingClientRect();
      return value.left >= clip.left - 0.5 && value.right <= clip.right + 0.5;
    });
    assert.ok(reasoningFits, 'the current reasoning level must remain readable, not clipped to h…');
  }
  // A multiline draft exposes the old, detached composer-card anchor.
  await page.locator('#composer-input').fill('Compare the attached sources.\nKeep the original quotations.\nExplain the differences clearly.');
  await trigger.click();
  await rows.filter({ hasText: 'Qwen3.6-35B-A3B' }).waitFor();
  await assertWithinViewport();
  await page.screenshot({ path: path.join(artifacts, 'dark-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await assertWithinViewport();
  await page.screenshot({ path: path.join(artifacts, 'dark-mobile.png') });
  await page.setViewportSize({ width: 320, height: 844 });
  await assertWithinViewport();
  await page.screenshot({ path: path.join(artifacts, 'dark-320.png') });
  await page.setViewportSize({ width: 390, height: 500 });
  await assertWithinViewport();
  await search.fill('qwen');
  await assertWithinViewport();
  assert.equal(await rows.count(), 3);
  await search.press('Escape');
  await page.setViewportSize({ width: 1440, height: 1000 });

  // The composer selects the right engine before submitting the real UI launch
  // request. The server here is deliberately simulated, never the user's app.
  await trigger.click();
  await search.fill('q6_k_xl');
  await rows.first().click();
  await page.locator('#loading-overlay').waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.querySelector('#loading-pct').textContent === '42');
  assert.deepEqual(writes.map(w => w.url), ['/api/engine/checkout', '/api/start']);
  assert.equal(writes[0].body.dir, qwen);
  assert.equal(writes[1].body.gguf, `gguf/${qwenFile}`);
  assert.equal(writes[1].body.ssdStreaming, 'off');
  assert.equal(writes[1].body.power, 100);
  ready = true;
  await page.locator('#loading-overlay').waitFor({ state: 'hidden', timeout: 8000 });
  await trigger.filter({ hasText: 'Qwen3.6-35B-A3B' }).waitFor();
  await trigger.click();
  await menu.getByRole('region', { name: 'Loaded' }).filter({ hasText: 'Qwen3.6-35B-A3B' }).waitFor();
  assert.doesNotMatch(await trigger.innerText(), /qwen35moe-support|ds4-qwen35/);
  await search.press('Escape');
  catalogFailure = true;
  await trigger.click();
  await menu.getByRole('status').filter({ hasText: 'Could not refresh models' }).waitFor();
  await search.press('Escape');
  catalogFailure = false;
  await trigger.click();
  await rows.filter({ hasText: qwenFile }).waitFor();
  // The anchored popup can legitimately cover the textarea's center. Click
  // its exposed left edge to exercise outside-click dismissal, not the popup.
  await page.locator('#composer-input').click({ position: { x: 8, y: 8 } });
  await menu.waitFor({ state: 'hidden' });

  // The same palette tokens must work in light mode too.
  await page.locator('#btn-settings').click();
  await page.locator('#set-nav [data-pane="interface"]').click();
  await page.locator('#set-theme').getByRole('radio', { name: 'Light', exact: true }).click();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await trigger.click();
  await rows.filter({ hasText: qwenFile }).waitFor();
  await assertWithinViewport();
  await page.screenshot({ path: path.join(artifacts, 'light-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await assertWithinViewport();
  await page.screenshot({ path: path.join(artifacts, 'light-mobile.png') });
  await page.setViewportSize({ width: 320, height: 844 });
  await assertWithinViewport();
  await page.screenshot({ path: path.join(artifacts, 'light-320.png') });

  // Dense 27B has its own engine, projector and thinking threshold. Exercise
  // actual controls and requests, not the presence of implementation strings.
  await search.press('Escape');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await trigger.click();
  await search.fill('27b');
  assert.equal(await rows.count(), 1);
  await rows.first().click();
  await page.locator('#loading-overlay').waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.querySelector('#loading-pct').textContent === '42');
  assert.deepEqual(writes.slice(-2).map(w => [w.url, w.body.dir || w.body.gguf]),
    [['/api/engine/checkout', qwen27], ['/api/start', `gguf/${qwen27File}`]]);
  assert.equal(config.power, 100); assert.equal(config.ssdStreaming, 'off');
  assert.equal(config.dspark, false); assert.equal(config.metalHotlistSeed, false);
  ready = true;
  await page.locator('#loading-overlay').waitFor({ state: 'hidden', timeout: 8000 });
  await trigger.filter({ hasText: 'Qwen3.8-27B' }).waitFor();
  await page.locator('#btn-settings').click();
  await page.locator('#set-nav [data-pane="performance"]').click();
  assert.equal(await page.locator('#set-power').inputValue(), '100');
  assert.equal(await page.locator('#set-power').isDisabled(), true);
  assert.equal(await page.locator('#set-ssd-streaming').inputValue(), 'off');
  assert.equal(await page.locator('#set-ssd-streaming').isDisabled(), true);
  assert.match(await page.locator('#set-ssd-streaming-note').innerText(), /dense weights in RAM.*no PLE/i);
  fs.writeFileSync(path.join(artifacts, 'qwen27-context-options.json'), JSON.stringify(
    await page.locator('#set-ctx').evaluate(select => [...select.options].map(o => ({value: o.value, disabled: o.disabled, attribute: o.getAttribute('disabled')}))), null, 2));
  // Playwright's enabled-state query retargets an option to its select. Inspect
  // the live option state; the select intentionally remains usable.
  assert.equal(await page.locator('#set-ctx option[value="393216"]').evaluate(option => option.disabled), true);
  assert.equal(await page.locator('#set-ctx option[value="262144"]').evaluate(option => option.disabled), false);
  assert.equal(await page.locator('#set-ctx option[value="98304"]').evaluate(option => option.disabled), false);
  await page.screenshot({ path: path.join(artifacts, 'qwen27-performance-light.png') });
  // The declined restart leaves a saved 64k preference, so picking Max must
  // explicitly request 96k and must not use DeepSeek's 384k estimate.
  await page.locator('#set-ctx').selectOption('65536');
  await page.locator('#confirm-dialog').waitFor({ state: 'visible' });
  await page.locator('#confirm-cancel').click();
  await page.locator('#settings-dialog').waitFor({ state: 'hidden' });
  await page.locator('#cbar-think .cbar-think-btn').click();
  await page.getByRole('menuitemradio', { name: /Thinking: max/ }).click();
  await page.locator('#confirm-dialog').waitFor({ state: 'visible' });
  assert.match(await page.locator('#confirm-title').innerText(), /96k/);
  assert.doesNotMatch(await page.locator('#confirm-body').innerText(), /384k|memory-mapped/);
  await page.screenshot({ path: path.join(artifacts, 'qwen27-max-confirm.png') });
  await page.locator('#confirm-go').click();
  await page.locator('#loading-overlay').waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.querySelector('#loading-pct').textContent === '42');
  assert.equal(config.ctx, 98304); assert.equal(config.gguf, `gguf/${qwen27File}`);
  ready = true;
  await page.locator('#loading-overlay').waitFor({ state: 'hidden', timeout: 8000 });
  await page.locator('#cbar-think .cbar-think-btn').filter({ hasText: 'max' }).waitFor();
  await page.locator('#btn-settings').click();
  await page.locator('#set-nav [data-pane="interface"]').click();
  await page.locator('#set-theme').getByRole('radio', { name: 'Dark', exact: true }).click();
  await page.locator('#set-nav [data-pane="performance"]').click();
  assert.equal(await page.locator('#set-ctx').inputValue(), '98304');
  await page.screenshot({ path: path.join(artifacts, 'qwen27-performance-dark.png') });
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  assert.deepEqual(pageErrors, []);
  fs.writeFileSync(path.join(artifacts, 'result.json'), JSON.stringify({ browser: browserName, simulatedLauncher: true,
    inference: false, passed: true, launchWrites: writes }, null, 2));
  console.log(`ui_model_picker_playwright_test: ok (${browserName}; simulated launcher, no inference)`);
} catch (error) {
  await page?.screenshot({ path: path.join(artifacts, 'failure.png') }).catch(() => {});
  fs.writeFileSync(path.join(artifacts, 'result.json'), JSON.stringify({ browser: browserName,
    simulatedLauncher: true, inference: false, passed: false, error: String(error.stack || error),
    pageErrors, launchWrites: writes }, null, 2));
  throw error;
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}

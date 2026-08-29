import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import assert from 'node:assert/strict';

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.log('ui_settings_redesign_playwright_test: playwright missing, skipping');
  process.exit(0);
}

const repoRoot = process.cwd();
const webRoot = path.join(repoRoot, 'web');
const pageErrors = [];

function json(res, value, status = 200) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

const ggufs = [
  {
    file: 'GLM-5.3-Flash-Q2.gguf',
    path: 'gguf/GLM-5.3-Flash-Q2.gguf',
    size: 97_000_000_000,
    branch: 'glm-5.3-flash',
    engineDir: '/tmp/dstudio-settings',
  },
  {
    file: 'DeepSeek-V4-Flash-IQ2XXS-w2Q2K-AProjQ8-SExpQ8-OutQ8-chat-v2-imatrix-0731.gguf',
    path: 'gguf/DeepSeek-V4-Flash-IQ2XXS-w2Q2K-AProjQ8-SExpQ8-OutQ8-chat-v2-imatrix-0731.gguf',
    size: 87_000_000_000,
    branch: 'main',
    engineDir: '/tmp/dstudio-settings',
  },
  {
    file: 'DeepSeek-V4-Flash-MXFP4Experts-F16HC-F16Compressor-F16Indexer-Q8Attn-Q8Shared-Q8Out-chat-v2-mxfp4-0731.gguf',
    path: 'gguf/DeepSeek-V4-Flash-MXFP4Experts-F16HC-F16Compressor-F16Indexer-Q8Attn-Q8Shared-Q8Out-chat-v2-mxfp4-0731.gguf',
    size: 156_000_000_000,
    branch: 'main',
    engineDir: '/tmp/dstudio-settings',
  },
  {
    file: 'laguna-s-2.1-Q4_K_M.gguf',
    path: 'gguf/laguna-s-2.1-Q4_K_M.gguf',
    size: 68_000_000_000,
    branch: 'laguna-s2.1',
    engineDir: '/tmp/dstudio-settings',
  },
];

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  if (url.pathname === '/api/status') {
    json(res, {
      ok: true,
      mode: 'server',
      running: true,
      ready: true,
      loadPct: 100,
      stage: 'Ready',
      ds4dirOk: true,
      webdirOk: true,
      ds4dir: '/tmp/dstudio-settings',
      modelFile: ggufs[0].path,
      lan: false,
      httpPort: server.address().port,
    });
    return;
  }
  if (url.pathname === '/api/ggufs') {
    json(res, { ok: true, ggufs });
    return;
  }
  if (url.pathname === '/api/diagnostics') {
    json(res, {
      ok: true,
      memory: {
        physicalBytes: 128 * 1073741824,
        modelBytes: 97 * 1073741824,
        iogpuWiredLimitMb: 86016,
        iogpuWiredTargetMb: 86016,
        iogpuWiredMinMb: 86016,
        iogpuWiredMaxMb: 90112,
        ssdStreaming: 'off',
        ssdStreamingEffective: false,
      },
    });
    return;
  }
  if (url.pathname === '/api/updates/check') {
    json(res, { ok: true, sections: [] });
    return;
  }
  if (url.pathname === '/api/store') {
    json(res, { rev: 0, data: null });
    return;
  }
  if (url.pathname === '/api/storerev') {
    json(res, { rev: 0 });
    return;
  }
  if (url.pathname === '/v1/models') {
    json(res, { data: [{ id: 'glm-5.3-flash' }] });
    return;
  }
  if (url.pathname === '/api/vision/status') {
    json(res, { ok: true, supported: true, installed: false });
    return;
  }
  if (url.pathname === '/api/video/status') {
    json(res, { ok: true, supported: true, installed: false, downloadedBytes: 0, totalBytes: 1 });
    return;
  }
  if (url.pathname === '/api/embed/status') {
    json(res, { ok: true, supported: true, installed: false, indexed: 0 });
    return;
  }
  if (url.pathname.startsWith('/api/')) {
    json(res, { ok: true, tasks: [], logs: [], checks: [], skills: [], designSystems: [] });
    return;
  }
  if (url.pathname === '/favicon.ico') {
    res.writeHead(204);
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
} catch {
  server.close();
  console.log('ui_settings_redesign_playwright_test: browser missing, skipping');
  process.exit(0);
}

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
  page.on('pageerror', (error) => pageErrors.push(error?.stack || error?.message || String(error)));
  await page.addInitScript(() => {
    localStorage.setItem('ds4web.settings.v2', JSON.stringify({
      v: 2,
      onboarded: true,
      theme: 'dark',
      chatBackend: 'local',
      baseUrl: '',
      model: 'glm-5.3-flash',
      temperature: 0.7,
      ctxSize: 131072,
      enginePower: 100,
      ssdStreaming: 'off',
      metalHotlistSeed: true,
      dspark: false,
    }));
  });

  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
  await page.locator('#btn-settings').click();
  await page.locator('#settings-dialog').waitFor({ state: 'visible' });

  const dialogBox = await page.locator('#settings-dialog').boundingBox();
  assert.ok(dialogBox && dialogBox.width > 850 && dialogBox.height > 650, `settings dialog should use the wide reference layout: ${JSON.stringify(dialogBox)}`);
  assert.ok(dialogBox.x >= 0 && dialogBox.y >= 0 && dialogBox.x + dialogBox.width <= 1441 && dialogBox.y + dialogBox.height <= 901,
    `settings dialog should stay inside the viewport: ${JSON.stringify(dialogBox)}`);
  assert.deepEqual(
    await page.locator('.set-nav__eyebrow').allTextContents(),
    ['Engine', 'Capabilities', 'App'],
    'settings navigation should expose the three reference groups',
  );
  assert.equal(await page.locator('#set-pane-title').innerText(), 'Connection');
  assert.match(await page.locator('#set-engine-state').innerText(), /Running/);
  await page.screenshot({ path: '/tmp/dstudio-settings-connection.png' });

  await page.locator('#set-nav [data-pane="models"]').click();
  await page.locator('.set-model-family').first().waitFor({ state: 'visible' });
  assert.equal(await page.locator('#set-pane-title').innerText(), 'Models');
  assert.equal(await page.locator('.set-models .onboard__model.ready').count(), ggufs.length);
  assert.equal(await page.locator('.set-models .onboard__model.is-running').count(), 1);
  await page.locator('#set-model-filter').fill('Q8ATTN');
  assert.equal(await page.locator('.set-models .onboard__model.ready').count(), 1);
  assert.match(await page.locator('#set-model-count').innerText(), /1 of 4 installed/);
  await page.locator('#set-model-filter').fill('');

  await page.locator('#set-search').fill('wired limit');
  assert.equal(await page.locator('#set-pane-title').innerText(), 'Performance');
  assert.ok(await page.locator('#set-nav [data-pane="performance"]').isVisible());
  assert.equal(await page.locator('#set-nav .set-nav__b:visible').count(), 1);
  await page.screenshot({ path: '/tmp/dstudio-settings-performance.png' });
  await page.locator('#set-search').fill('');

  await page.locator('#set-nav [data-pane="advanced"]').click();
  assert.equal(await page.locator('#set-pane-title').innerText(), 'Advanced');
  assert.equal(await page.locator('.set-toggle-card').count(), 2);
  assert.ok(await page.locator('#set-metal-hotlist').isChecked());
  await page.screenshot({ path: '/tmp/dstudio-settings-advanced.png' });

  await page.locator('#set-nav [data-pane="interface"]').click();
  assert.equal(await page.locator('#set-pane-title').innerText(), 'Interface');
  assert.equal(await page.locator('#set-theme .set-seg__b.on').innerText(), 'Dark');
  await page.screenshot({ path: '/tmp/dstudio-settings-interface.png' });

  await page.locator('#set-nav [data-pane="models"]').click();
  await page.screenshot({ path: '/tmp/dstudio-settings-redesign.png' });

  await page.evaluate(() => {
    const settings = JSON.parse(localStorage.getItem('ds4web.settings.v2') || '{}');
    localStorage.setItem('ds4web.settings.v2', JSON.stringify({ ...settings, theme: 'light' }));
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('#btn-settings').evaluate((button) => button.click());
  await page.locator('#settings-dialog').waitFor({ state: 'visible' });
  const mobileBox = await page.locator('#settings-dialog').boundingBox();
  assert.ok(mobileBox && mobileBox.x >= 0 && mobileBox.y >= 0 && mobileBox.x + mobileBox.width <= 391 && mobileBox.y + mobileBox.height <= 845,
    `mobile settings dialog should stay inside the viewport: ${JSON.stringify(mobileBox)}`);
  assert.ok(await page.locator('#set-nav').isVisible(), 'mobile settings should retain horizontally scrollable section navigation');
  await page.screenshot({ path: '/tmp/dstudio-settings-mobile.png' });

  assert.deepEqual(pageErrors, [], `settings redesign should not raise page errors: ${JSON.stringify(pageErrors, null, 2)}`);
  console.log('ui_settings_redesign_playwright_test: ok');
} finally {
  await browser.close().catch(() => {});
  server.close();
}

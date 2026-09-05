import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import assert from 'node:assert/strict';

let browserType;
const browserName = process.env.DSTUDIO_TEST_BROWSER || 'chromium';
try {
  const playwright = await import('playwright');
  assert.ok(['chromium', 'webkit'].includes(browserName), 'use chromium or webkit');
  browserType = playwright[browserName];
} catch {
  console.log('ui_settings_redesign_playwright_test: playwright missing, NOT RUN');
  process.exit(1);
}

const repoRoot = process.cwd();
const webRoot = path.join(repoRoot, 'web');
const pageErrors = [];
let appliedIogpuMb = null;
const startBodies = [];
let activeModel = null;
let activeEngine = '/tmp/dstudio-settings';
let activeConfig = { ctx: 131072, ssdStreaming: 'off' };
let engineStatus = { running: true, ready: true, loadPct: 100, stage: 'Ready' };
let startHandler = null;
let statusDelay = null;
let catalogDelay = null;
let checkoutDelay = null;
let checkoutError = '';
let qwen35Setups = 0;
const modelDownloads = [];
let downloadStatus = {};

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
    branch: 'main',
    engineDir: '/tmp/dstudio-settings',
  },
  {
    file: 'GLM-5.3-Flash-Vision-Encoder.gguf',
    path: 'gguf/GLM-5.3-Flash-Vision-Encoder.gguf',
    size: 1_127_280_960,
    branch: 'main',
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
    file: 'DeepSeek-V4-Flash-Vision-Exp-IQ2XXS-w2Q2K-AProjQ8-SExpQ8-OutQ8.gguf',
    path: 'gguf/DeepSeek-V4-Flash-Vision-Exp-IQ2XXS-w2Q2K-AProjQ8-SExpQ8-OutQ8.gguf',
    size: 86_720_111_776,
    branch: 'main',
    engineDir: '/tmp/dstudio-settings',
  },
  {
    file: 'DeepSeek-V4-Flash-Vision-Encoder.gguf',
    path: 'gguf/DeepSeek-V4-Flash-Vision-Encoder.gguf',
    size: 932_857_760,
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
    file: 'DeepSeek-V4-Flash-DSpark-support-0731.gguf',
    path: 'gguf/DeepSeek-V4-Flash-DSpark-support-0731.gguf',
    size: 6_000_000_000,
    branch: 'main',
    engineDir: '/tmp/dstudio-settings',
  },
  {
    file: 'DeepSeek-V4-Flash-Vision-Exp-DSpark-support.gguf',
    path: 'gguf/DeepSeek-V4-Flash-Vision-Exp-DSpark-support.gguf',
    size: 5_989_114_528,
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
// Catalog fixtures only: no model download or inference is simulated as a pass.
const qwenBase = 'Qwen3.8-Flash-Next-Q4KImatrixExperts-MXFP4Down-BF16Emb-BF16Control-Q8GDN-Q8QSA-Q8Shared-Q8Out.gguf';
for (const [file, size] of [[qwenBase, 73371680704], ['Qwen3.8-Flash-Next-PLE-Q4_1.gguf', 32000157440], ['Qwen3.8-Flash-Next-MTP.gguf', 74900000000]]) {
  ggufs.push({ file, path: `gguf/${file}`, size, branch: 'qwen3.8-flash-next', engineDir: '/tmp/dstudio-settings/ds4-qwen38' });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  if (url.pathname === '/api/start' && req.method === 'POST') {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    startBodies.push(body);
    if (startHandler) { await startHandler(body, res); return; }
    if (/Qwen3\.[68]/.test(body.gguf) && body.ssdStreaming === 'on') {
      json(res, { ok: false, error: 'Qwen expert streaming is not validated', taskId: 2 }, 409);
      return;
    }
    activeModel = body.gguf;
    activeConfig = body;
    json(res, { ok: true, mode: 'server' });
    return;
  }
  if (url.pathname === '/api/engine/checkout' && req.method === 'POST') {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    if (checkoutDelay) await checkoutDelay();
    if (checkoutError) { json(res, { ok: false, error: checkoutError }, 409); return; }
    activeEngine = JSON.parse(Buffer.concat(chunks).toString('utf8')).dir;
    json(res, { ok: true, dir: activeEngine });
    return;
  }
  if (url.pathname === '/api/status') {
    if (statusDelay) await statusDelay();
    json(res, {
      ok: true,
      mode: 'server',
      running: true,
      ready: true,
      loadPct: 100,
      stage: 'Ready',
      ...engineStatus,
      ...downloadStatus,
      ds4dirOk: true,
      webdirOk: true,
      ds4dir: activeEngine,
      modelFile: activeModel || ggufs[0].path,
      config: activeConfig,
      lan: false,
      httpPort: server.address().port,
    });
    return;
  }
  if (url.pathname === '/api/ggufs') {
    if (catalogDelay) await catalogDelay();
    json(res, { ok: true, ggufs });
    return;
  }
  if (url.pathname === '/api/engine/checkouts') {
    const checkouts = [
      { name: 'ds4', branch: 'main', dir: '/tmp/dstudio-settings' },
      { name: 'ds4-qwen38', branch: 'qwen3.8-flash-next', dir: '/tmp/dstudio-settings/ds4-qwen38' },
      ...(qwen35Setups ? [{ name: 'ds4-qwen35', branch: 'qwen35moe-support', dir: '/tmp/dstudio-settings/ds4-qwen35' }] : []),
    ];
    json(res, { ok: true, checkouts: checkouts.map(c => ({ ...c, hasServer: true, active: activeEngine === c.dir })) });
    return;
  }
  if (url.pathname === '/api/qwen35/setup' && req.method === 'POST') {
    qwen35Setups++;
    json(res, { ok: true, downloaded: true, built: true, capability: 'chat-native' });
    return;
  }
  if (url.pathname === '/api/model/download' && req.method === 'POST') {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    modelDownloads.push(body);
    downloadStatus = { download: true, downloadVariant: body.target, downloadPct: 25 };
    json(res, { ok: true, target: body.target });
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
        ssdStreaming: activeConfig.ssdStreaming,
        ssdStreamingEffective: activeConfig.ssdStreaming === 'on',
      },
    });
    return;
  }
  if (url.pathname === '/api/iogpu-wired-limit' && req.method === 'POST') {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      appliedIogpuMb = JSON.parse(body).mb;
      json(res, { ok: true, currentMb: appliedIogpuMb, persistent: true });
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
  browser = await browserType.launch();
} catch {
  server.close();
  console.log('ui_settings_redesign_playwright_test: browser missing, NOT RUN');
  process.exit(1);
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

  // Simulated background transfer: progress and paused state stay in Settings;
  // merely opening/closing Settings must not start/stop an engine or download.
  const downloadUiWrites = [];
  const captureDownloadUiWrites = req => {
    if (req.method() === 'POST' && /\/api\/(?:start|stop|engine\/checkout|model\/download)/.test(req.url()))
      downloadUiWrites.push(req.url());
  };
  page.on('request', captureDownloadUiWrites);
  downloadStatus = { download: true, downloadVariant: 'qwen36-q6', downloadPct: 16, downloadBytes: 5_000_000_000 };
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
  const composerModel = page.locator('.cbar-model-btn');
  await composerModel.waitFor({ state: 'visible' });
  const modelLabelBeforeProgress = await composerModel.innerText();
  assert.match(modelLabelBeforeProgress, /glm.*5\.3.*flash/i, 'composer should identify the selected model during a background download');
  await page.locator('#btn-settings').click();
  await page.locator('#set-nav [data-pane="models"]').click();
  const settingsDownload = page.locator('.set-models .onboard__dl');
  await settingsDownload.locator('.onboard__dl-lbl').filter({ hasText: /Downloading qwen36-q6.*16%/ }).waitFor();
  assert.equal(await settingsDownload.getByRole('button', { name: 'Stop', exact: true }).isEnabled(), true);
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  assert.equal(await composerModel.innerText(), modelLabelBeforeProgress);

  downloadStatus = { ...downloadStatus, downloadPct: 37, downloadBytes: 11_000_000_000 };
  await page.locator('#btn-settings').click();
  await settingsDownload.locator('.onboard__dl-lbl').filter({ hasText: /Downloading qwen36-q6.*37%/ }).waitFor({ timeout: 8000 });
  assert.equal(await composerModel.innerText(), modelLabelBeforeProgress, 'progress updates must not replace the model name');
  downloadStatus = { download: false, pausedDownload: true, pausedDownloadVariant: 'qwen36-q6',
    pausedDownloadPct: 37, pausedDownloadBytes: 11_000_000_000 };
  await settingsDownload.locator('.onboard__dl-lbl').filter({ hasText: /Paused: qwen36-q6.*37%/ }).waitFor({ timeout: 8000 });
  assert.equal(await settingsDownload.getByRole('button', { name: 'Resume', exact: true }).isEnabled(), true);
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  assert.equal(await composerModel.innerText(), modelLabelBeforeProgress, 'a paused download must not replace the model name either');

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('#btn-settings').click();
  await page.locator('#set-nav [data-pane="models"]').click();
  await settingsDownload.locator('.onboard__dl-lbl').filter({ hasText: /Paused: qwen36-q6.*37%/ }).waitFor();
  assert.equal(await composerModel.innerText(), modelLabelBeforeProgress, 'restoring a paused transfer must keep the composer model label');
  assert.equal(await settingsDownload.getByRole('button', { name: 'Resume', exact: true }).isEnabled(), true);
  assert.deepEqual(downloadUiWrites, [], 'display-only interactions must not mutate the download or engine');
  page.off('request', captureDownloadUiWrites);
  downloadStatus = {};
  await page.locator('#set-nav [data-pane="connection"]').click();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('#btn-settings').click();
  await page.locator('#settings-dialog').waitFor({ state: 'visible' });

  const dialogBox = await page.locator('#settings-dialog').boundingBox();
  assert.ok(dialogBox && dialogBox.width > 850 && dialogBox.height > 650, `settings dialog should use the wide reference layout: ${JSON.stringify(dialogBox)}`);
  assert.ok(dialogBox.x >= 0 && dialogBox.y >= 0 && dialogBox.x + dialogBox.width <= 1441 && dialogBox.y + dialogBox.height <= 901,
    `settings dialog should stay inside the viewport: ${JSON.stringify(dialogBox)}`);
  assert.equal(await page.locator('#settings-dialog').evaluate((node) => getComputedStyle(node).outlineStyle), 'none',
    'settings should not show the native blue focus outline');
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
  assert.equal(await page.locator('.set-models .onboard__model.ready').count(), ggufs.length - 6,
    'engine support files must not appear as selectable chat models');
  assert.equal(await page.locator('.set-models').getByText('DSpark-support', { exact: false }).count(), 0);
  assert.equal(await page.locator('.set-models').getByText('Vision-Encoder', { exact: false }).count(), 0);
  assert.equal(await page.locator('.set-models .onboard__model.ready').filter({ hasText: qwenBase }).count(), 1);
  assert.equal(await page.locator('.set-models .onboard__model.ready').filter({ hasText: 'PLE-Q4_1' }).count(), 0);
  assert.equal(await page.locator('.set-models .onboard__model.ready').filter({ hasText: 'Next-MTP' }).count(), 0);
  assert.equal(await page.locator('.set-models option[value="qwen38-q4k"]').count(), 0);
  assert.equal(await page.locator('.set-models .onboard__model.is-running').count(), 1);
  await page.locator('#set-model-filter').fill('Q8ATTN');
  assert.equal(await page.locator('.set-models .onboard__model.ready').count(), 1);
  assert.match(await page.locator('#set-model-count').innerText(), /1 of 6 installed/);
  await page.locator('#set-model-filter').fill('');

  await page.locator('#set-search').fill('wired limit');
  assert.equal(await page.locator('#set-pane-title').innerText(), 'Performance');
  assert.ok(await page.locator('#set-nav [data-pane="performance"]').isVisible());
  assert.equal(await page.locator('#set-nav .set-nav__b:visible').count(), 1);
  const wiredLimit = page.locator('#set-iogpu-limit-mb');
  assert.equal(await wiredLimit.getAttribute('min'), '86016');
  assert.equal(await wiredLimit.getAttribute('max'), null, 'IOGPU input should not impose an upper limit');
  await wiredLimit.fill('94112');
  assert.equal(await wiredLimit.inputValue(), '94112', 'values above the former 90112 ceiling should remain accepted');
  assert.match(await page.locator('.set-grp[data-pane="performance"]').innerText(), /controls how many megabytes of unified memory macOS may reserve as wired memory for the integrated GPU/i);
  await page.locator('#set-iogpu-limit').click();
  await page.waitForFunction(() => /set to 94112/.test(document.querySelector('#set-memory-msg')?.textContent || ''));
  assert.equal(appliedIogpuMb, 94112, 'Apply should send a value above the former ceiling unchanged');
  assert.equal(await page.locator('#set-memory-msg').evaluate((node) => node.classList.contains('is-error')), false);
  await page.screenshot({ path: '/tmp/dstudio-settings-performance.png' });
  await page.locator('#set-search').fill('');

  await page.locator('#set-nav [data-pane="advanced"]').click();
  assert.equal(await page.locator('#set-pane-title').innerText(), 'Advanced');
  assert.equal(await page.locator('.set-toggle-card').count(), 2);
  assert.ok(await page.locator('#set-metal-hotlist').isChecked());
  assert.equal(await page.locator('#set-dspark-support .set-dspark-file').count(), 2);
  assert.match(await page.locator('#set-dspark-support').innerText(), /Chat 0731 draft.*6\.0 GB.*Installed.*Vision-Exp draft.*6\.0 GB.*Installed/s);
  await page.screenshot({ path: '/tmp/dstudio-settings-advanced.png' });

  await page.locator('#set-nav [data-pane="vision"]').click();
  assert.equal(await page.locator('#set-pane-title').innerText(), 'Vision');
  await page.waitForFunction(() => /Installed/.test(document.querySelector('#set-native-vision-support')?.textContent || ''));
  assert.match(await page.locator('#set-native-vision-support').innerText(), /GLM 5\.3 encoder.*1\.1 GB.*Installed.*DeepSeek Vision-Exp encoder.*933 MB.*Installed/s);
  assert.match(await page.locator('.set-grp[data-pane="vision"] .set-help').first().innerText(), /DeepSeek Vision-Exp or GLM 5\.3 reads source pixels.*dispatches that explicit decision directly/s);
  await page.screenshot({ path: '/tmp/dstudio-settings-vision.png' });

  await page.locator('#set-nav [data-pane="interface"]').click();
  assert.equal(await page.locator('#set-pane-title').innerText(), 'Interface');
  assert.equal(await page.locator('#set-theme .set-seg__b.on').innerText(), 'Dark');
  await page.screenshot({ path: '/tmp/dstudio-settings-interface.png' });

  await page.locator('#set-nav [data-pane="models"]').click();
  await page.screenshot({ path: '/tmp/dstudio-settings-redesign.png' });

  // Closing autosaved preferences must not submit hidden invalid fields. The
  // real 96112 MB wired value is a step mismatch for this numeric input.
  await wiredLimit.evaluate(input => { input.value = '96112'; });
  assert.equal(await wiredLimit.evaluate(input => input.validity.stepMismatch), true);
  assert.equal(await wiredLimit.isVisible(), false);
  const startsBeforeDone = startBodies.length;
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.locator('#settings-dialog').waitFor({ state: 'hidden', timeout: 1000 });
  assert.equal(startBodies.length, startsBeforeDone, 'Done only closes preferences');
  await page.locator('#btn-settings').click();
  await page.locator('#set-close').click();
  await page.locator('#settings-dialog').waitFor({ state: 'hidden', timeout: 1000 });

  // Actual UI selection/restart with simulated HTTP engine responses, not an
  // inference test. Reproduce DeepSeek's saved On leaking into a Qwen launch.
  const switchPage = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  switchPage.on('pageerror', error => pageErrors.push(error.message));
  activeModel = ggufs[2].path;
  activeConfig = { ctx: 8192, ssdStreaming: 'on' };
  await switchPage.addInitScript(({ gguf, engineDir }) => {
    if (localStorage.getItem('ds4web.settings.v2')) return;
    localStorage.setItem('ds4web.settings.v2', JSON.stringify({
      v: 2, onboarded: true, chatBackend: 'local', baseUrl: '',
      model: 'deepseek-v4-flash', modelGguf: gguf, modelEngineDir: engineDir,
      ctxSize: 8192, enginePower: 90, ssdStreaming: 'on', dspark: false,
    }));
  }, { gguf: ggufs[2].path, engineDir: ggufs[2].engineDir });
  await switchPage.goto(`http://127.0.0.1:${port}/`);
  await switchPage.locator('#btn-settings').click();
  await switchPage.locator('#set-nav [data-pane="models"]').click();
  await switchPage.locator('.set-models .onboard__model.ready').filter({ hasText: qwenBase }).click();
  await switchPage.getByRole('button', { name: 'Load model', exact: true }).click();
  await assertLaunch(`gguf/${qwenBase}`, 'off', 1);
  await switchPage.locator('#btn-settings').click();
  await switchPage.locator('#set-nav [data-pane="performance"]').click();
  await switchPage.waitForFunction(() => /SSD streaming running off/.test(document.querySelector('#set-memory-msg').textContent));
  assert.equal(await switchPage.locator('#set-ssd-streaming').inputValue(), 'off');
  assert.equal(await switchPage.locator('#set-ssd-streaming').isDisabled(), true);
  assert.match(await switchPage.locator('#set-ssd-streaming-note').innerText(), /PLE.*SSD/);
  const streamingNotice = switchPage.locator('#set-ssd-streaming-notice');
  assert.equal(await streamingNotice.isVisible(), true, 'blocked streaming must have a visible explanation');
  assert.equal(await switchPage.locator('#set-ssd-streaming-badge').innerText(), 'Unavailable for Qwen');
  assert.deepEqual(await streamingNotice.locator('li').allTextContents(), [
    'DeepSeek V4 Flash', 'DeepSeek V4 Flash Vision-Exp', 'GLM 5.3 Flash',
    'DeepSeek V4 Pro — about 430 GB to download',
  ]);
  assert.match(await streamingNotice.innerText(), /local Metal engine and DSpark Off/);
  assert.match(await streamingNotice.innerText(), /Restarting Qwen will not unlock/);
  fs.mkdirSync('tests/.artifacts/ssd-streaming-notice', { recursive: true });
  await switchPage.locator('#set-ssd-streaming-row').screenshot({ path: 'tests/.artifacts/ssd-streaming-notice/desktop.png' });
  await switchPage.setViewportSize({ width: 390, height: 844 });
  await streamingNotice.scrollIntoViewIfNeeded();
  assert.equal(await streamingNotice.evaluate(el => el.scrollWidth <= el.clientWidth), true, 'notice must wrap on narrow screens');
  await switchPage.screenshot({ path: 'tests/.artifacts/ssd-streaming-notice/mobile.png' });
  // The notice action must navigate only: no automatic download/model restart.
  const unexpectedWrites = [];
  const captureWrites = req => { if (req.method() === 'POST' && /\/api\/(?:start|download|.*setup|engine\/checkout)/.test(req.url())) unexpectedWrites.push(req.url()); };
  switchPage.on('request', captureWrites);
  await switchPage.locator('#set-search').fill('SSD streaming');
  await switchPage.locator('#set-ssd-streaming-models').click();
  assert.equal(await switchPage.locator('#set-pane-title').innerText(), 'Models');
  assert.equal(await switchPage.locator('#set-search').inputValue(), '');
  await switchPage.locator('.set-model-family').first().waitFor({ state: 'visible' });
  assert.deepEqual(unexpectedWrites, []);
  assert.equal(startBodies.length, 1);
  switchPage.off('request', captureWrites);
  await switchPage.setViewportSize({ width: 1440, height: 900 });
  await switchPage.locator('#set-nav [data-pane="performance"]').click();
  await switchPage.locator('#set-ctx').selectOption('16384');
  await switchPage.getByRole('button', { name: 'Restart now', exact: true }).click();
  await assertLaunch(`gguf/${qwenBase}`, 'off', 2);
  assert.equal(startBodies.at(-1).ctx, 16384, 'Qwen context restart must keep expert streaming disabled');
  await switchPage.locator('#btn-settings').click();
  await switchPage.locator('#set-nav [data-pane="models"]').click();
  await switchPage.locator('.set-models .onboard__model.ready').filter({ hasText: ggufs[2].file }).click();
  await switchPage.getByRole('button', { name: 'Load model', exact: true }).click();
  await assertLaunch(ggufs[2].path, 'on', 3);
  await switchPage.locator('#btn-settings').click();
  await switchPage.locator('#set-nav [data-pane="performance"]').click();
  assert.equal(await switchPage.locator('#set-ssd-streaming').inputValue(), 'on');
  assert.equal(await switchPage.locator('#set-ssd-streaming').isDisabled(), false);
  assert.equal(await streamingNotice.isVisible(), false, 'Qwen warning must disappear after loading a compatible model');
  assert.equal(await switchPage.locator('#set-ssd-streaming-badge').innerText(), 'Needs restart');

  // Regression: Qwen -> GLM, slow launcher I/O, cancellation and real DOM
  // hit-testing. These are simulated launch states, not a model benchmark.
  await switchPage.locator('#set-nav [data-pane="models"]').click();
  const cardFor = file => switchPage.locator('.set-models .onboard__model.ready').filter({ hasText: file });
  await cardFor(qwenBase).click();
  await switchPage.getByRole('button', { name: 'Load model', exact: true }).click();
  await assertLaunch(`gguf/${qwenBase}`, 'off', 4);
  await switchPage.locator('#btn-settings').click();
  await switchPage.locator('#set-nav [data-pane="models"]').click();
  await cardFor(ggufs[0].file).waitFor();

  function gate() {
    let release;
    const promise = new Promise(resolve => { release = resolve; });
    return { promise, release };
  }
  const statusGate = gate();
  statusDelay = () => statusGate.promise;
  const beforeCancel = await switchPage.evaluate(() => JSON.parse(localStorage.getItem('ds4web.settings.v2')).modelGguf);
  // Dispatch two clicks in one event turn to catch duplicate confirmation
  // handlers (an actual rapid double-click can race the modal opening).
  await cardFor(ggufs[0].file).evaluate(card => { card.click(); card.click(); });
  try {
    await switchPage.getByRole('button', { name: 'Load GLM 5.3', exact: true }).waitFor({ timeout: 1500 });
    await switchPage.locator('#confirm-cancel').click();
    assert.equal(await switchPage.locator('#settings-dialog').isVisible(), true);
    assert.equal(await switchPage.evaluate(() => JSON.parse(localStorage.getItem('ds4web.settings.v2')).modelGguf), beforeCancel);
    assert.equal(startBodies.length, 4, 'canceling GLM must not launch or change the model');
  } finally {
    statusGate.release();
    statusDelay = null;
  }
  await switchPage.waitForFunction(() => document.querySelector('#set-model-count').textContent.includes('installed'));

  const catalogGate = gate();
  const checkoutGate = gate();
  let catalogEntered = false;
  let checkoutEntered = false;
  catalogDelay = async () => {
    catalogEntered = true;
    await catalogGate.promise;
  };
  checkoutDelay = async () => {
    checkoutEntered = true;
    await checkoutGate.promise;
  };
  startHandler = (body, res) => {
    activeConfig = body;
    // Accepted/queued: status still describes the previous ready Qwen model.
    json(res, { ok: true, mode: 'server', taskId: 51 });
  };
  async function waitUntil(check, message) {
    const deadline = Date.now() + 5000;
    while (!check() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
    assert.ok(check(), message);
  }
  async function assertLoadingInFront() {
    await switchPage.locator('#loading-overlay').waitFor({ state: 'visible', timeout: 1500 });
    assert.equal(await switchPage.locator('#settings-dialog').isVisible(), false);
    assert.equal(await switchPage.locator('#loading-stage').evaluate(node => {
      const box = node.getBoundingClientRect();
      return node.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
    }), true, 'loading feedback must be visible above dialogs, not merely unhidden behind Settings');
  }
  try {
    await cardFor(ggufs[0].file).click();
    await switchPage.getByRole('button', { name: 'Load GLM 5.3', exact: true }).click();
    await assertLoadingInFront();
    await waitUntil(() => catalogEntered, 'model preparation should request the catalog');
    assert.equal(startBodies.length, 4);
    catalogGate.release();
    await waitUntil(() => checkoutEntered, 'Qwen -> GLM should select the main engine');
    await assertLoadingInFront();
    assert.equal(startBodies.length, 4, 'loading must already be visible before the checkout responds');
    checkoutGate.release();
    await waitUntil(() => startBodies.length === 5, 'exactly one GLM launch should be submitted');
    // Observe more than two 500 ms launch polls of the old ready model.
    await switchPage.waitForTimeout(1100);
    await assertLoadingInFront();
    assert.equal(await switchPage.locator('#loading-pct').innerText(), '0', 'old Qwen readiness must not complete GLM loading');
    activeModel = ggufs[0].path;
    engineStatus = { running: true, ready: false, loadPct: 42, stage: 'Loading model weights' };
    await switchPage.waitForFunction(() => document.querySelector('#loading-pct').textContent === '42');
    await assertLoadingInFront();
    fs.mkdirSync('tests/.artifacts/model-switch', { recursive: true });
    await switchPage.screenshot({ path: `tests/.artifacts/model-switch/${browserName}-loading.png` });
    engineStatus = { running: true, ready: true, loadPct: 100, stage: 'Ready' };
    await switchPage.locator('#loading-overlay').waitFor({ state: 'hidden', timeout: 5000 });
    assert.equal(startBodies.length, 5);
    assert.equal(startBodies.at(-1).gguf, ggufs[0].path);
    assert.equal(startBodies.at(-1).ssdStreaming, 'on');
  } finally {
    catalogGate.release();
    checkoutGate.release();
    catalogDelay = null;
    checkoutDelay = null;
    startHandler = null;
  }
  await switchPage.locator('#btn-settings').click();
  await cardFor(ggufs[0].file).locator('.onboard__model-state').filter({ hasText: 'Running' }).waitFor();
  assert.equal(await cardFor(qwenBase).locator('.onboard__model-state').innerText(), '');
  await switchPage.getByRole('button', { name: 'Done', exact: true }).click();
  engineStatus = { running: true, ready: false, loadPct: 42, stage: 'Loading model weights' };
  await switchPage.locator('#btn-settings').click();
  await switchPage.locator('#settings-dialog').waitFor({ state: 'visible' });
  await switchPage.waitForFunction(() => document.querySelectorAll('.set-models .is-running').length === 0, null, { timeout: 2000 });
  await switchPage.waitForFunction(() => document.querySelector('#set-model-count').textContent.includes('installed'));
  assert.equal(await switchPage.locator('.set-models .is-running').count(), 0, 'a loading model must not be labeled Running');
  engineStatus = { running: true, ready: true, loadPct: 100, stage: 'Ready' };

  // Failed checkout must surface the actual error and submit no launch.
  checkoutError = 'Selected engine folder is unavailable';
  await cardFor(qwenBase).click();
  await switchPage.getByRole('button', { name: 'Load model', exact: true }).click();
  await switchPage.locator('#loading-stage').filter({ hasText: 'Selected engine folder is unavailable' }).waitFor();
  await assertLoadingInFront();
  assert.equal(startBodies.length, 5, 'failed checkout must not start a model');
  await switchPage.locator('#loading-overlay').waitFor({ state: 'hidden', timeout: 6000 });
  checkoutError = '';

  // Retrying after an error must work; a rejected /api/start also stays visible.
  startHandler = (_body, res) => json(res, { ok: false, error: 'Metal could not allocate the model', taskId: 52 }, 409);
  await switchPage.locator('#btn-settings').click();
  await cardFor(qwenBase).click();
  await switchPage.getByRole('button', { name: 'Load model', exact: true }).click();
  await switchPage.locator('#loading-stage').filter({ hasText: 'Metal could not allocate the model' }).waitFor();
  await assertLoadingInFront();
  assert.equal(startBodies.length, 6);
  await switchPage.locator('#loading-overlay').waitFor({ state: 'hidden', timeout: 6000 });
  startHandler = null;
  // A new Qwen family gets its own setup/download path and does not inherit
  // Qwen3.8's PLE requirement or DeepSeek's saved expert streaming preference.
  await switchPage.locator('#btn-settings').click();
  const downloader = switchPage.locator('.set-models .onboard__dl');
  await downloader.getByRole('combobox').selectOption('qwen36-q6');
  // A catalog/status refresh reconstructs the model pane. Force the same
  // production render through filtering so a lost selection is deterministic.
  await switchPage.getByPlaceholder('Filter by name, quantization or file').fill('Qwen');
  assert.equal(await downloader.getByRole('combobox').inputValue(), 'qwen36-q6',
    'model list refresh must preserve the intended download, not select the first option');
  await switchPage.getByPlaceholder('Filter by name, quantization or file').fill('');
  await downloader.getByRole('button', { name: 'Download', exact: true }).click();
  await switchPage.locator('#confirm-go').click();
  await waitUntil(() => modelDownloads.length === 1, 'Qwen3.6 download should start after installing its engine');
  assert.equal(qwen35Setups, 1);
  assert.deepEqual(modelDownloads[0], { target: 'qwen36-q6' });
  assert.equal(activeEngine, '/tmp/dstudio-settings/ds4-qwen35');
  assert.equal(startBodies.length, 6, 'downloading must not start inference');
  const qwen35File = 'Qwen3.6-35B-A3B-UD-Q6_K_XL.gguf';
  ggufs.push({ file: qwen35File, path: `gguf/${qwen35File}`, size: 31843777504,
    engineDir: activeEngine, branch: 'qwen35moe-support' });
  downloadStatus = { download: false, downloadVariant: 'qwen36-q6', downloadPct: 100 };
  await cardFor(qwen35File).waitFor({ timeout: 8000 });
  await cardFor(qwen35File).click();
  await switchPage.getByRole('button', { name: 'Load model', exact: true }).click();
  await assertLaunch(`gguf/${qwen35File}`, 'off', 7);
  assert.equal(startBodies.at(-1).power, 100);
  assert.equal(await switchPage.evaluate(() => JSON.parse(localStorage.getItem('ds4web.settings.v2')).enginePower), 90);
  await switchPage.locator('#btn-settings').click();
  await switchPage.locator('#set-nav [data-pane="performance"]').click();
  assert.equal(await switchPage.locator('#set-ssd-streaming').isDisabled(), true);
  assert.match(await switchPage.locator('#set-ssd-streaming-note').innerText(), /Qwen3\.6.*all weights in RAM.*no PLE/);
  assert.equal(await switchPage.locator('#set-power').isDisabled(), true);
  assert.equal(await switchPage.locator('#set-power').inputValue(), '100');
  assert.equal(await streamingNotice.isVisible(), true);
  await switchPage.getByRole('button', { name: 'Done', exact: true }).click();
  await switchPage.close();

  async function assertLaunch(gguf, streaming, count) {
    for (let attempts = 0; attempts < 100 && startBodies.length < count; attempts++)
      await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(startBodies.length, count);
    assert.equal(startBodies.at(-1).gguf, gguf);
    assert.equal(startBodies.at(-1).ssdStreaming, streaming);
    await switchPage.locator('#loading-overlay').waitFor({ state: 'hidden', timeout: 8000 });
    await switchPage.waitForFunction(gguf => JSON.parse(localStorage.getItem('ds4web.settings.v2')).modelGguf === gguf, gguf);
    assert.equal(await switchPage.evaluate(() => JSON.parse(localStorage.getItem('ds4web.settings.v2')).ssdStreaming), 'on');
  }

  // A partially downloaded pair is resumable, but not offered as a usable model.
  ggufs.splice(ggufs.findIndex((g) => g.file === 'Qwen3.8-Flash-Next-PLE-Q4_1.gguf'), 1);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('#btn-settings').click();
  await page.locator('#settings-dialog').waitFor({ state: 'visible' });
  await page.locator('#set-nav [data-pane="models"]').click();
  await page.locator('.set-model-family').first().waitFor({ state: 'visible' });
  assert.equal(await page.locator('.set-models .onboard__model.ready').filter({ hasText: qwenBase }).count(), 0);
  assert.equal(await page.locator('.set-models option[value="qwen38-q4k"]').count(), 1);

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
  console.log(`ui_settings_redesign_playwright_test: ok (${browserName}; simulated engine, no inference)`);
} finally {
  await browser.close().catch(() => {});
  server.close();
}

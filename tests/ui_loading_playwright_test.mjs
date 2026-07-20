import fs from 'node:fs';
import http from 'node:http';
import assert from 'node:assert/strict';

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.log('ui_loading_playwright_test: playwright missing, skipping');
  process.exit(0);
}

const loadingHtml = fs.readFileSync('web/loading.html');
let started = false;
let startBody = null;

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
    json(res, 200, {
      mode: started ? 'server' : 'none',
      running: started,
      ready: started,
      loadPct: started ? 100 : 2,
      stage: started ? 'Ready' : 'Applying saved engine settings…',
      ds4dirOk: true,
      models: { standard: false, uncensored: true },
      variants: { flash: true, pro: false },
      variant: 'flash',
      modelFile: 'gguf/DeepSeek-V4-Flash-test.gguf',
    });
    return;
  }
  if (url.pathname === '/api/start' && req.method === 'POST') {
    startBody = JSON.parse(await readBody(req) || '{}');
    started = true;
    json(res, 200, { ok: true, mode: 'server' });
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
  console.log('ui_loading_playwright_test: browser missing, skipping');
  process.exit(0);
}

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e?.stack || e?.message || String(e)));
  page.on('console', (msg) => { if (msg.type() === 'error') pageErrors.push(msg.text()); });
  await page.addInitScript(() => {
    localStorage.setItem('ds4web.settings.v1', JSON.stringify({
      v: 1,
      onboarded: true,
      model: 'deepseek-v4-pro',
      modelVariant: 'flash',
      modelGguf: 'gguf/DeepSeek-V4-Flash-test.gguf',
      ctxSize: 131072,
      enginePower: 70,
      ssdStreaming: 'off',
      useJsonlPatch: true,
    }));
  });

  await page.goto(`http://127.0.0.1:${port}/loading.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForURL(`http://127.0.0.1:${port}/`, { timeout: 8000 });
  await page.locator('#ready').waitFor();

  assert.ok(startBody, 'loading page should POST /api/start');
  assert.equal(startBody.mode, 'server');
  assert.equal(startBody.variant, 'flash');
  assert.equal(startBody.gguf, 'gguf/DeepSeek-V4-Flash-test.gguf');
  assert.equal(startBody.ctx, 131072);
  assert.equal(startBody.power, 70);
  assert.equal(startBody.ssdStreaming, 'off', 'saved Off must reach the launcher unchanged');
  assert.deepEqual(pageErrors, []);
  console.log('ui_loading_playwright_test: ok');
} finally {
  await browser.close().catch(() => {});
  server.close();
}

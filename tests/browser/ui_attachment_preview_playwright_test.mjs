import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.log('ui_attachment_preview_playwright_test: playwright missing, NOT RUN');
  process.exit(1);
}

const repoRoot = process.cwd();
const webRoot = path.join(repoRoot, 'web');
const requestOrder = [];
const pdfDocumentId = 'b'.repeat(64);
const pdfReply = `OK [P1]\n\n\`\`\`dstudio-pdf-evidence\n${JSON.stringify({ citations: [{ id: 'P1', documentId: pdfDocumentId, page: 1, quote: 'A precise passage from the original PDF.' }] })}\n\`\`\``;
const missingRequests = [];
const longName = "Fluent Python_ Clear, Concise, and Effective Programming, -- Luciano Ramalho -- 2nd, 2022 -- Beijing _ O'Reilly Media, Inc -- isbn13 9781492056355 -- 6b8f1e751c6d6b82a49cc155099f9949 -- Anna's Archive.pdf";
const coverSvg = `
<svg xmlns="http://www.w3.org/2000/svg" width="600" height="800" viewBox="0 0 600 800">
  <rect width="600" height="800" rx="14" fill="#fff"/>
  <text x="54" y="150" font-family="Arial" font-size="72" font-weight="700" fill="#111">Fluent</text>
  <text x="54" y="235" font-family="Arial" font-size="72" font-weight="700" fill="#111">Python</text>
  <path d="M90 600 C180 470 340 470 510 580" fill="none" stroke="#8a4f2c" stroke-width="26" stroke-linecap="round"/>
  <text x="350" y="735" font-family="Arial" font-size="24" fill="#222">Luciano Ramalho</text>
</svg>`;
const thumb = `data:image/svg+xml;base64,${Buffer.from(coverSvg).toString('base64')}`;

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
  if (url.pathname === '/api/status') {
    json(res, 200, {
      mode: 'server', running: true, ready: true, loadPct: 100, stage: 'Ready',
      agentWorking: false, workdir: '', ds4dirOk: true, webdirOk: true, lan: false,
      config: { ctx: 65536, power: 90, think: 'off', ssdStreaming: 'auto' },
      variants: { flash: true, pro: false }, variant: 'flash',
      modelFile: 'gguf/DeepSeek-V4-Flash-test.gguf', engineLine: 'ready',
    });
    return;
  }
  if (url.pathname === '/api/store') {
    if (req.method === 'POST') await readBody(req);
    json(res, 200, { ok: true, rev: 0, data: null });
    return;
  }
  if (url.pathname === '/api/storerev') {
    json(res, 200, { rev: 0 });
    return;
  }
  if (url.pathname === '/api/ggufs') {
    json(res, 200, { ok: true, files: [] });
    return;
  }
  if (url.pathname === '/api/engine/checkouts') {
    json(res, 200, { ok: true, checkouts: [] });
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
  if (url.pathname === '/api/remote/status') {
    json(res, 200, { ok: true, enabled: false });
    return;
  }
  if (url.pathname === '/api/lan-client/chats') {
    json(res, 200, { ok: true, chats: [] });
    return;
  }
  if (url.pathname === '/api/embed/stop' && req.method === 'POST') {
    requestOrder.push('embed-stop');
    json(res, 200, { ok: true, stopped: true });
    return;
  }
  if (url.pathname === '/v1/models') {
    json(res, 200, { data: [{ id: 'deepseek-v4-flash', context_length: 65536 }] });
    return;
  }
  if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
    requestOrder.push('chat');
    const payload = JSON.parse(await readBody(req) || '{}');
    assert.equal(payload.stream, true, 'normal chat should use SSE');
    assert.ok(payload.messages.some((m) => typeof m.content === 'string' && m.content.includes(`PDF evidence documentId: ${pdfDocumentId}`)), 'PDF evidence instructions must reach the normal chat prompt');
    const events = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: pdfReply }, finish_reason: null }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } })}\n\n`,
      'data: [DONE]\n\n',
    ].join('');
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    res.end(events);
    return;
  }
  if (url.pathname === '/favicon.ico') {
    res.writeHead(204);
    res.end();
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
  server.close();
  console.log('ui_attachment_preview_playwright_test: browser missing, NOT RUN');
  process.exit(1);
}

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 880 } });
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error?.stack || error?.message || String(error)));
  page.on('console', (msg) => { if (msg.type() === 'error') pageErrors.push(msg.text()); });
  await page.addInitScript(({ filename, preview, documentId }) => {
    if (localStorage.getItem('pdf-evidence-test-initialized')) return;
    localStorage.setItem('pdf-evidence-test-initialized', '1');
    const now = Date.now();
    localStorage.setItem('ds4web.settings.v2', JSON.stringify({
      v: 2, onboarded: true, theme: 'dark', baseUrl: '', chatBackend: 'local',
      model: 'deepseek-v4-flash', modelVariant: 'flash', thinkLevel: 'off',
      ctxSize: 65536, enginePower: 90, ssdStreaming: 'auto', webMode: 'off',
    }));
    localStorage.setItem('ds4web.chats.v2', JSON.stringify({
      v: 2,
      deleted: [],
      chats: [{
        id: 'chat-media', mode: 'chat', title: 'PDF preview', createdAt: now, updatedAt: now,
        messages: [{
          id: 'user-pdf', role: 'user', content: 'Dimmi cosa ne pensi', createdAt: now,
          attachments: [{
            id: 'pdf-cover', name: filename, type: 'application/pdf', size: 16 * 1024 * 1024,
            kind: 'pdf', content: 'A precise passage from the original PDF.', thumb: preview,
            documentId, pdfSections: [{ page: 1, title: 'Chapter 1 Introduction', level: 1, kind: 'heading_hint' }],
          }],
        }],
      }],
    }));
    localStorage.setItem('ds4web.active.v2', JSON.stringify({ v: 2, ids: { chat: 'chat-media', agent: null, design: null } }));
  }, { filename: longName, preview: thumb, documentId: pdfDocumentId });

  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
  const card = page.locator('.msg-attachment--pdf');
  await card.waitFor({ state: 'visible' });
  const caption = await card.locator('.msg-attachment__caption-title').textContent();
  assert.match(caption || '', /^Fluent Python Clear, Concise, and Effective Programming$/);
  assert.doesNotMatch(caption || '', /isbn13|Archive|[a-f0-9]{24}/i);
  assert.match(await card.locator('.msg-attachment__caption-meta').textContent() || '', /PDF · 16 MB/);

  await card.click();
  const dialog = page.locator('#file-preview-dialog');
  await dialog.waitFor({ state: 'visible' });
  assert.equal(await page.locator('#file-preview-title').textContent(), caption);
  assert.equal(await page.locator('#file-preview-original').textContent(), longName);
  assert.equal(await page.locator('#file-preview-kind').textContent(), 'PDF');
  const bounds = await page.evaluate(() => {
    const rect = (selector) => {
      const r = document.querySelector(selector).getBoundingClientRect();
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
    };
    return {
      viewport: { width: innerWidth, height: innerHeight },
      dialog: rect('#file-preview-dialog'),
      header: rect('.file-preview-head'),
      image: rect('.file-preview-media'),
      close: rect('.file-preview-close'),
    };
  });
  assert.ok(bounds.dialog.width >= 800, `preview should be a wide viewer: ${JSON.stringify(bounds)}`);
  assert.ok(bounds.dialog.right <= bounds.viewport.width + 1 && bounds.dialog.bottom <= bounds.viewport.height + 1,
    `preview must stay inside the viewport: ${JSON.stringify(bounds)}`);
  assert.ok(bounds.header.height < 110, `metadata header should stay compact: ${JSON.stringify(bounds)}`);
  assert.ok(bounds.image.height > 480 && bounds.image.bottom <= bounds.dialog.bottom,
    `cover should be large, contained, and readable: ${JSON.stringify(bounds)}`);
  assert.ok(bounds.close.right <= bounds.dialog.right && bounds.close.top >= bounds.dialog.top,
    `close button must remain visible: ${JSON.stringify(bounds)}`);
  await page.locator('.file-preview-close').click();

  await page.locator('#composer-input').fill('Ciao');
  await page.locator('#btn-send').click();
  await page.locator('.msg--assistant .md').filter({ hasText: 'OK' }).waitFor({ state: 'visible' });
  await page.locator('.pdf-evidence-inline').waitFor({ state: 'visible' });
  assert.equal(await page.locator('.pdf-evidence-source').count(), 1, 'final streaming commit must render source controls');
  assert.doesNotMatch(await page.locator('.msg--assistant .md').textContent(), /dstudio-pdf-evidence|documentId/, 'the JSON protocol is not user-facing prose');
  assert.deepEqual(requestOrder.filter((entry) => ['embed-stop', 'chat'].includes(entry)).slice(-2),
    ['embed-stop', 'chat'],
    'local chat must release the embedding helper before prefill');
  await page.waitForFunction(() => localStorage.getItem('ds4web.chats.v2')?.includes('dstudio-pdf-evidence'));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('.pdf-evidence-inline').waitFor({ state: 'visible' });
  assert.equal(await page.locator('.pdf-evidence-source').count(), 1, 'PDF provenance must survive a chat reload');
  assert.deepEqual(pageErrors, [], `page errors: ${JSON.stringify({ pageErrors, missingRequests }, null, 2)}`);
  console.log('ui_attachment_preview_playwright_test: ok');
} finally {
  await browser.close().catch(() => {});
  server.close();
}

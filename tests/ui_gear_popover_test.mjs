import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import assert from 'node:assert/strict';

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.log('ui_gear_popover_test: playwright missing, skipping');
  process.exit(0);
}

const repoRoot = process.cwd();
const webRoot = path.join(repoRoot, 'web');
const missingRequests = [];

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
      mode: 'agent',
      running: true,
      ready: true,
      loadPct: 100,
      stage: 'Ready',
      agentWorking: false,
      workdir: '/tmp/dstudio-gear-test',
      jsonl: true,
      ds4dirOk: true,
      webdirOk: true,
      lan: false,
      variants: { flash: true, pro: false },
      variant: 'flash',
      engineLine: 'gear test ready',
    });
    return;
  }
  if (url.pathname === '/api/start' && req.method === 'POST') {
    await readBody(req);
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
  if (url.pathname === '/api/doctor') {
    json(res, 200, { ok: true, checks: [] });
    return;
  }
  if (url.pathname === '/api/diagnostics') {
    json(res, 200, { ok: true, summary: {}, runtime: {}, lan: {}, memory: { physicalBytes: 128 * 1073741824, modelBytes: 87 * 1073741824, iogpuWiredLimitMb: -1, ssdStreamingEffective: true }, tasks: { recent: [] }, logs: { recentErrors: [] } });
    return;
  }
  if (url.pathname === '/api/updates/check') {
    json(res, 200, { ok: true, sections: [] });
    return;
  }
  if (url.pathname === '/api/tasks') {
    json(res, 200, { ok: true, tasks: [] });
    return;
  }
  if (url.pathname === '/api/logs') {
    json(res, 200, { ok: true, logs: [] });
    return;
  }
  if (url.pathname === '/api/remote/status') {
    json(res, 200, { ok: true, enabled: false });
    return;
  }
  if (url.pathname === '/api/agent/poll') {
    json(res, 200, { base: 0, len: 0, working: false, ready: true, loadPct: 100, text: '' });
    return;
  }
  if (url.pathname === '/favicon.ico') {
    res.writeHead(204);
    res.end();
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
  if (url.pathname === '/api/gsa/tools') {
    json(res, 200, { ok: true, gsaTools: { mode: 'tool-assisted', tools: [] } });
    return;
  }
  if (url.pathname === '/api/skills' || url.pathname === '/api/user-skills' ||
      url.pathname === '/api/design-systems' || url.pathname === '/api/skills/search') {
    json(res, 200, { ok: true, skills: [], designSystems: [] });
    return;
  }
  if (url.pathname === '/api/lan-client/chats') {
    json(res, 200, { ok: true, chats: [] });
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
  server.close();
  console.log('ui_gear_popover_test: browser missing, skipping');
  process.exit(0);
}

try {
  const page = await browser.newPage({ viewport: { width: 1320, height: 768 } });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e?.stack || e?.message || String(e)));
  page.on('console', (msg) => { if (msg.type() === 'error') pageErrors.push(msg.text()); });
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
      enginePower: 90,
      ssdStreaming: 'auto',
      useJsonlPatch: true,
      gsaMode: 'on',
      workdirs: { agent: '/tmp/dstudio-gear-test' },
    }));
    localStorage.setItem('ds4web.chats.v1', JSON.stringify({
      v: 1,
      deleted: [],
      chats: [{ id: 'agent-gear', mode: 'agent', title: 'Gear', createdAt: now, updatedAt: now, messages: [], transcript: '' }],
    }));
    localStorage.setItem('ds4web.active.v1', JSON.stringify({ v: 1, ids: { chat: null, agent: 'agent-gear', design: null } }));
  });

  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
  await page.locator('#tab-agent').click();
  await page.waitForFunction(() => !document.querySelector('#agent-view')?.hidden);
  await page.locator('#cbar-gear').click();
  await page.locator('#cbar-pop').waitFor({ state: 'visible' });
  await page.locator('#cbar-pop .cdrop-trig').filter({ hasText: 'GSA' }).click();
  await page.locator('body > .cdrop-menu:not([hidden])').waitFor({ state: 'visible' });

  const boxes = await page.evaluate(() => {
    const bounds = (el) => {
      const r = el.getBoundingClientRect();
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
    };
    return {
      viewport: { width: innerWidth, height: innerHeight },
      pop: bounds(document.querySelector('#cbar-pop')),
      menu: bounds(document.querySelector('body > .cdrop-menu:not([hidden])')),
    };
  });
  for (const [name, r] of [['popover', boxes.pop], ['dropdown', boxes.menu]]) {
    assert.ok(r.left >= 0 && r.top >= 0, `${name} starts outside viewport: ${JSON.stringify(boxes)}`);
    assert.ok(r.right <= boxes.viewport.width + 1, `${name} overflows right: ${JSON.stringify(boxes)}`);
    assert.ok(r.bottom <= boxes.viewport.height + 1, `${name} overflows bottom: ${JSON.stringify(boxes)}`);
    assert.ok(r.width > 100 && r.height > 30, `${name} is not visibly sized: ${JSON.stringify(boxes)}`);
  }
  assert.deepEqual(pageErrors, [], `page errors: ${JSON.stringify({ pageErrors, missingRequests }, null, 2)}`);
  console.log('ui_gear_popover_test: ok');
} finally {
  await browser.close().catch(() => {});
  server.close();
}

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const browserName = process.env.DSTUDIO_TEST_BROWSER || 'chromium';
assert.ok(['chromium', 'webkit'].includes(browserName), 'unknown browser');
let browserType;
try {
  browserType = (await import('playwright'))[browserName];
} catch {
  console.log('ui_sidebar_playwright_test: playwright missing, NOT RUN');
  process.exit(1);
}

const repoRoot = process.cwd();
const webRoot = path.join(repoRoot, 'web');
const missingRequests = [];
let statusMode = 'agent';

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
      mode: statusMode,
      running: true,
      ready: true,
      loadPct: 100,
      stage: 'Ready',
      agentWorking: false,
      workdir: '/tmp/dstudio-gear-test',
      ds4dirOk: true,
      webdirOk: true,
      lan: false,
      variants: { flash: true, pro: false },
      variant: 'flash',
      modelFile: 'gguf/DeepSeek-V4-Flash-test.gguf',
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
  if (url.pathname === '/api/user-skills' || url.pathname === '/api/design-systems') {
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
  browser = await browserType.launch();
} catch {
  server.close();
  console.log('ui_sidebar_playwright_test: browser missing, NOT RUN');
  process.exit(1);
}

const artifactRoot = 'tests/.artifacts/sidebar';
fs.mkdirSync(artifactRoot, { recursive: true });
const artifactDir = fs.mkdtempSync(`${artifactRoot}/${browserName}-`);
const report = { scope: `Production UI in ${browserName}; simulated launcher, no inference`, cases: [] };
try {
  for (const theme of ['light', 'dark']) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, reducedMotion: 'reduce' });
    page.setDefaultTimeout(5000);
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.addInitScript(({ theme, origin }) => {
      if (window !== window.top || location.origin !== origin) return;
      if (localStorage.getItem('ds4web.chats.v2')) return;
      const now = Date.now();
      localStorage.setItem('ds4web.settings.v2', JSON.stringify({ v: 2, onboarded: true,
        theme, model: 'deepseek-v4-flash', modelVariant: 'flash', ctxSize: 65536, enginePower: 90 }));
      localStorage.setItem('ds4web.chats.v2', JSON.stringify({ v: 2, deleted: [], chats: [
        { id: 'first', mode: 'chat', title: 'Conversation one', createdAt: now, updatedAt: now, messages: [{ role: 'user', content: 'Fixture question one' }] },
        { id: 'second', mode: 'chat', title: 'Conversation two', createdAt: now, updatedAt: now - 1000, messages: [{ role: 'user', content: 'Fixture question two' }] },
      ] }));
      localStorage.setItem('ds4web.active.v2', JSON.stringify({ v: 2, ids: { chat: 'first' } }));
      const reserve = () => document.documentElement.style.setProperty('--native-titlebar-height', '28px');
      if (document.documentElement) reserve(); else document.addEventListener('DOMContentLoaded', reserve, { once: true });
    }, { theme, origin: `http://127.0.0.1:${port}` });
    try {
      statusMode = 'server';
      await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
      await page.locator('#chat-list [data-id="first"]').waitFor();
      const colors = theme === 'light' ? [[236, 236, 239], [245, 245, 246], [255, 255, 255]]
        : [[18, 21, 26], [24, 27, 34], [30, 34, 42]];
      const headerImage = `${artifactDir}/${theme}-topbar.png`;
      await page.screenshot({ path: headerImage });
      const pixels = JSON.parse(execFileSync('python3', ['-c',
        'import json,sys;from PIL import Image;im=Image.open(sys.argv[1]).convert("RGB");print(json.dumps([[im.getpixel((x,y)) for y in [12,36]] for x in [40,79,200,299,1000]]))',
        headerImage], { encoding: 'utf8' }));
      const border = theme === 'light' ? [228, 228, 231] : [44, 50, 61];
      for (const [index, owner] of [0, 0, 1, 1, 2].entries()) {
        const expected = index === 1 ? border : colors[owner];
        assert.deepEqual(pixels[index], [expected, expected],
          'pane colors continue through the top; only the rail divider spans the full height');
      }
      const rail = await page.locator('.sb-rail').boundingBox();
      const history = await page.locator('.sb-history').boundingBox();
      assert.equal(rail.width, 80, 'mode rail fits all three native window controls');
      assert.equal(history.width, 220, 'the history panel keeps its usable width');
      assert.equal(await page.locator('.sb-rail').getByRole('tab').count(), 5);
      assert.equal(await page.locator('.sidebar').getByRole('button', { name: 'New chat', exact: true }).count(), 0,
        'the latest reference places history immediately below the mode title');
      assert.equal(await page.locator('#sidebar-mode-label').textContent(), 'Chat');
      await page.locator('#chat-list [data-id="second"]').click();
      assert.equal(await page.locator('#chat-title').textContent(), 'Conversation two');
      const row = page.locator('#chat-list [data-id="second"]');
      await row.hover();
      await row.getByRole('button', { name: 'Conversation actions', exact: true }).click();
      await page.getByRole('menuitem', { name: 'Pin', exact: true }).click();
      assert.equal(await row.locator('xpath=preceding-sibling::*[1]').textContent(), 'Pinned');
      await row.hover();
      await row.getByRole('button', { name: 'Conversation actions', exact: true }).click();
      await page.getByRole('menuitem', { name: 'Rename', exact: true }).click();
      await page.getByRole('textbox', { name: 'Rename chat', exact: true }).fill('Renamed conversation');
      await page.getByRole('textbox', { name: 'Rename chat', exact: true }).press('Enter');
      assert.equal(await row.locator('.chat-item__title').textContent(), 'Renamed conversation');
      assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('ds4web.chats.v2'))
        .chats.find(chat => chat.id === 'second').title), 'Renamed conversation');
      await row.click();
      assert.equal(await page.locator('#chat-title').textContent(), 'Renamed conversation');
      await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click();
      await page.waitForFunction(() => Math.abs(document.querySelector('.sidebar').getBoundingClientRect().width - 80) < 1);
      assert.equal((await page.locator('.sidebar').boundingBox()).width, 80);
      assert.equal(await page.locator('#chat-list').isVisible(), false);
      for (const name of ['Chat', 'Agent', 'Cowork', 'Design', 'Learn'])
        assert.equal(await page.getByRole('tab', { name, exact: true }).isVisible(), true);
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
      await page.locator('#settings-dialog').waitFor({ state: 'visible' });
      await page.getByRole('button', { name: 'Done', exact: true }).click();
      await page.screenshot({ path: `${artifactDir}/${theme}-collapsed.png`, fullPage: true });
      await page.waitForFunction(() => JSON.parse(localStorage.getItem('ds4web.settings.v2')).sidebarCollapsed === true);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.getByRole('button', { name: 'Expand sidebar', exact: true }).waitFor();
      await page.waitForFunction(() => Math.abs(document.querySelector('.sidebar').getBoundingClientRect().width - 80) < 1);
      assert.equal((await page.locator('.sidebar').boundingBox()).width, 80, 'collapse preference persists');
      await page.getByRole('button', { name: 'Expand sidebar', exact: true }).click();
      await page.waitForFunction(() => Math.abs(document.querySelector('.sidebar').getBoundingClientRect().width - 300) < 1);
      assert.equal(await page.locator('#chat-list').isVisible(), true);
      await page.screenshot({ path: `${artifactDir}/${theme}-expanded.png`, fullPage: true });
      await page.locator('.chat').getByRole('button', { name: 'New chat', exact: true }).click();
      assert.equal(await page.locator('#chat-title').textContent(), 'New chat');
      await page.setViewportSize({ width: 390, height: 740 });
      await page.getByRole('button', { name: 'Open conversations menu', exact: true }).click();
      await page.waitForFunction(() => Math.abs(document.querySelector('.sidebar').getBoundingClientRect().left) < 1);
      assert.equal(await page.getByRole('tab', { name: 'Chat', exact: true }).isVisible(), true);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.screenshot({ path: `${artifactDir}/${theme}-mobile.png`, fullPage: true });
      assert.deepEqual(errors, []);
      report.cases.push({ theme, status: 'PASS' });
    } catch (error) {
      report.cases.push({ theme, status: 'FAIL', error: error.stack, browserErrors: errors });
      await page.screenshot({ path: `${artifactDir}/${theme}-failure.png`, fullPage: true });
    } finally { await page.close(); }
  }
} finally {
  fs.writeFileSync(`${artifactDir}/receipt.json`, JSON.stringify(report, null, 2) + '\n');
  console.log(`ui_sidebar_playwright_test: ${artifactDir}/receipt.json`);
  await browser.close().catch(() => {}); server.close();
}
for (const row of report.cases) console.log(`${row.theme}: ${row.status}${row.error ? ': ' + row.error : ''}`);
assert.ok(report.cases.every(row => row.status === 'PASS'), 'sidebar interaction/layout regressions failed');

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

export const jsonReply = (res, value, status = 200) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(value));
};
export async function requestBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

// This server never proxies: every engine, tool and persistence reply is owned
// by this test. Unknown API requests fail, and the browser denies other origins.
export async function uiMockServer(handle = () => false, { document } = {}) {
  const webRoot = path.resolve('web');
  const requests = [], missing = [];
  let data = null, rev = 0;
  let context = 65536;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    requests.push({ method: req.method, path: url.pathname });
    try {
      if (await handle(req, res, url)) return;
      if (url.pathname === '/api/status') return jsonReply(res, {
        mode: 'server', running: true, ready: true, loadPct: 100, stage: 'Ready (simulated)',
        agentWorking: false, workdir: '', ds4dirOk: true, webdirOk: true, lan: false,
        modelFile: 'gguf/DeepSeek-V4-Flash-Vision-Exp-test.gguf',
        nativeVisionActive: true, variant: 'flash', variants: { flash: true },
        config: { ctx: context, power: 100, think: 'off', ssdStreaming: 'auto' },
      });
      if (url.pathname === '/api/store') {
        if (req.method === 'POST') { data = await requestBody(req); rev++; }
        return jsonReply(res, { ok: true, rev, data });
      }
      if (url.pathname === '/api/storerev') return jsonReply(res, { rev });
      if (url.pathname === '/v1/models') return jsonReply(res, { data: [
        { id: 'deepseek-v4-flash', context_length: 65536 },
      ] });
      if (url.pathname === '/api/start') {
        const launch = await requestBody(req);
        context = Number(launch.ctx) || context;
        return jsonReply(res, { ok: true });
      }
      if (url.pathname === '/api/embed/stop' || url.pathname === '/api/stop')
        return jsonReply(res, { ok: true });
      if (url.pathname === '/api/ggufs') return jsonReply(res, { ok: true, files: [] });
      if (url.pathname === '/api/video/status') return jsonReply(res, { ok: true, models: [], running: false });
      if (url.pathname === '/api/engine/checkouts') return jsonReply(res, { ok: true, checkouts: [] });
      if (url.pathname === '/api/remote/status') return jsonReply(res, { ok: true, enabled: false });
      if (url.pathname === '/api/doctor') return jsonReply(res, { ok: true, checks: [], issues: [] });
      if (url.pathname === '/api/diagnostics') return jsonReply(res, { ok: true, runtime: {}, memory: {}, tasks: { recent: [] }, logs: { recentErrors: [] } });
      if (url.pathname === '/api/lan-client/chats') return jsonReply(res, { ok: true, chats: [] });
      if (url.pathname === '/favicon.ico') { res.writeHead(204); res.end(); return; }
      // Optional document captured from the native HTTP host: exercise its actual
      // policy and bundled page while keeping every runtime endpoint simulated.
      if (url.pathname === '/' && document) {
        res.writeHead(200, document.headers);
        res.end(document.body);
        return;
      }
      const file = path.resolve(webRoot, '.' + (url.pathname === '/' ? '/index.html' : url.pathname));
      if (!file.startsWith(webRoot + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        missing.push(`${req.method} ${url.pathname}`);
        return jsonReply(res, { error: 'Unmocked endpoint' }, 404);
      }
      res.writeHead(200, { 'content-type': file.endsWith('.html') ? 'text/html' : 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    } catch (error) { jsonReply(res, { error: String(error) }, 500); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, requests, missing, storeSnapshot: () => ({ rev, data: structuredClone(data) }),
    resetStore: () => { data = null; rev = 0; }, close: () => { server.closeAllConnections(); server.close(); } };
}

// Both Playwright and the operator-driven preview initialize only their owning
// origin's main frame. Child document applications retain their own stores.
export function initializeUiFixture({ origin, theme = 'dark', chats, settings = {} }) {
    if (window !== window.top || location.origin !== origin) return;
    if (localStorage.getItem('ds4web.chats.v2')) return;
    const now = Date.now();
    localStorage.setItem('ds4web.settings.v2', JSON.stringify({
      v: 2, onboarded: true, theme, baseUrl: '', chatBackend: 'local',
      model: 'deepseek-v4-flash', modelVariant: 'flash', thinkLevel: 'off', qualityDefaultsVersion: 1,
      modelGguf: 'gguf/DeepSeek-V4-Flash-Vision-Exp-test.gguf', ctxSize: 65536, enginePower: 100,
      webMode: 'off', ...settings,
    }));
    const list = chats || [{ id: 'fixture-chat', mode: 'chat', title: 'Images test',
      createdAt: now, updatedAt: now, messages: [] }];
    localStorage.setItem('ds4web.chats.v2', JSON.stringify({ v: 2, deleted: [], chats: list }));
    const ids = {};
    for (const chat of list) ids[chat.mode || 'chat'] ||= chat.id;
    localStorage.setItem('ds4web.active.v2', JSON.stringify({ v: 2, ids }));
}

export async function seedUi(page, origin, { theme = 'dark', chats, settings = {} } = {}) {
  const external = [], errors = [];
  page.on('pageerror', error => errors.push(error.stack || error.message));
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin === origin || ['data:', 'blob:'].includes(url.protocol)) return route.continue();
    external.push(route.request().url());
    return route.abort('blockedbyclient');
  });
  await page.addInitScript(initializeUiFixture, { origin, theme, chats, settings });
  return { external, errors };
}

export function sseDelta(res, content, reasoning = '') {
  res.write(`data: ${JSON.stringify({ choices: [{ delta: { content, reasoning_content: reasoning }, finish_reason: null }] })}\n\n`);
}
export function sseDone(res) {
  res.end(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
}

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { artifactRunDir, writeArtifact } from '../support/real_harness.mjs';

// Actual production UI and HTTP messages with simulated discovery/model replies.
// No external pages, model weights or inference are used.
const browserName = process.env.DSTUDIO_TEST_BROWSER || 'webkit';
assert.ok(['webkit', 'chromium'].includes(browserName));
const browserType = (await import('playwright'))[browserName];
const webRoot = path.resolve('web');
const originalHtml = fs.readFileSync(path.join(webRoot, 'index.html'), 'utf8');
// Expose existing owners only in this isolated harness, without replacing them.
const scriptEnd = originalHtml.lastIndexOf('</script>');
const html = originalHtml.slice(0, scriptEnd) +
  'window.__researchTest = { Store, Messages, Chat };\n' + originalHtml.slice(scriptEnd);
const artifacts = artifactRunDir('research-progress-browser');
const frames = path.join(artifacts, 'selection-frames');
fs.mkdirSync(frames);
let frame = 0;
const receipt = { scope: 'Production Chat research UI; simulated engine and pages', browserName,
  htmlSHA256: createHash('sha256').update(originalHtml).digest('hex'), cases: [], status: 'RUNNING' };
writeArtifact(artifacts, 'results.json', receipt);
console.log(`Research UI evidence: ${artifacts}`);
const file = 'gguf/DeepSeek-V4-Flash-test.gguf';
const dir = '/fixture/ds4';
const urls = Array.from({ length: 8 }, (_, i) => `https://evidence.test/source-${i + 1}`);
const greeting = 'Saved greeting remains readable.';
const initialChat = { id: 'research-chat', mode: 'chat', title: 'Research fixture', model: 'deepseek-v4-flash',
  createdAt: 1, updatedAt: 2, messages: [
    { id: 'saved-question', role: 'user', content: 'Hello', createdAt: 1 },
    { id: 'saved-answer', role: 'assistant', content: greeting, finishReason: 'stop', createdAt: 2 },
  ] };
let store = { v: 2, chats: [initialChat], deleted: [] }, rev = 0;
let held, writerHeld, extractionCount = 0, writerMode = 'partial';
const partialAnswer = 'La scoperta è controversa [F1].\n';
const modelRequests = [];
const pageErrors = [];
function json(res, data, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(data));
}
async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString() || '{}');
}
function completion(res, value) {
  json(res, { choices: [{ message: { content: typeof value === 'string' ? value : JSON.stringify(value) }, finish_reason: 'stop' }] });
}
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://127.0.0.1');
    const body = req.method === 'POST' ? await readBody(req) : null;
    if (url.pathname === '/api/store') {
      if (body) { store = body; rev++; json(res, { ok: true, rev }); }
      else json(res, { rev, data: store });
      return;
    }
    if (url.pathname === '/api/storerev') { json(res, { rev }); return; }
    if (url.pathname === '/api/status') {
      json(res, { mode: 'server', running: true, ready: true, loadPct: 100, stage: 'Ready',
        ds4dir: dir, ds4dirOk: true, webdirOk: true, contentOk: true, modelFile: file,
        variant: 'flash', variants: { flash: true }, nativeVisionActive: false,
        config: { ctx: 65536, power: 90, ssdStreaming: 'off', think: 'high' } }); return;
    }
    if (url.pathname === '/api/ggufs') {
      json(res, { ok: true, ggufs: [{ file: path.basename(file), path: file, size: 87e9, engineDir: dir, branch: 'main' }] }); return;
    }
    if (url.pathname === '/api/engine/checkouts') {
      json(res, { ok: true, checkouts: [{ dir, name: 'ds4', branch: 'main', active: true, hasServer: true }] }); return;
    }
    if (url.pathname === '/v1/models') { json(res, { data: [{ id: 'deepseek-v4-flash', context_length: 65536 }] }); return; }
    if (url.pathname === '/api/web-search') {
      json(res, { ok: true, sources: urls.map(url => ({ url, title: 'Read evidence', content: 'Discovery lead.' })) }); return;
    }
    if (url.pathname === '/api/web-read') {
      json(res, { ok: true, url: body.url, title: 'Read evidence', sourceKind: 'generic', reader: 'browser',
        markdown: 'The saved evidence supports the requested answer. '.repeat(80) }); return;
    }
    if (url.pathname === '/v1/chat/completions') {
      modelRequests.push(body);
      const system = body.messages.find(m => m.role === 'system')?.content || '';
      if (system.includes('DStudio search classifier')) {
        completion(res, { needsSearch: true, intent: 'research', standaloneQuestion: 'Research the saved evidence', explicitUrls: [], queries: ['saved evidence'] }); return;
      }
      if (system.includes('DStudio source picker')) { completion(res, { reason: 'Read the evidence', urls }); return; }
      if (system.includes('DStudio evidence extractor')) {
        extractionCount++;
        const reply = { facts: [{ fact: 'The saved evidence supports the requested answer.', excerpt: 'The saved evidence supports the requested answer.', confidence: 'high' }] };
        if (extractionCount === 2 || extractionCount === 3) {
          held = { res, reply, index: extractionCount, closed: false };
          const request = held;
          res.on('close', () => { request.closed = true; });
          return;
        }
        completion(res, reply); return;
      }
      if (system.includes('DStudio research sufficiency judge')) {
        completion(res, { decision: 'enough', reason: 'Simulated evidence is sufficient', gaps: [], queries: [], urls: [] }); return;
      }
      if (system.includes('DStudio Deep Research writer')) {
        assert.equal(body.stream, true, 'The actual browser writer request must use streaming');
        if (writerMode === 'empty') { json(res, { error: { message: 'Fixture engine unavailable.' } }, 503); return; }
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        const event = Buffer.from(`data: ${JSON.stringify({ choices: [{ delta: { content: partialAnswer } }] })}\n\n`);
        const split = event.indexOf(Buffer.from('è')) + 1;
        res.write(event.subarray(0, split)); res.write(event.subarray(split));
        writerHeld = res;
        return; // The test releases this real HTTP transport after visible progress.
      }
      throw new Error('Unexpected model request in progress fixture');
    }
    if (url.pathname.startsWith('/api/')) { json(res, { ok: true, tasks: [], logs: [], checks: [], skills: [], designSystems: [] }); return; }
    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html' }); res.end(html); return;
    }
    const target = path.resolve(webRoot, '.' + url.pathname);
    if (!target.startsWith(webRoot + path.sep) || !fs.existsSync(target) || !fs.statSync(target).isFile()) {
      res.writeHead(404); res.end(); return;
    }
    res.writeHead(200, { 'content-type': target.endsWith('.js') ? 'text/javascript' : 'application/octet-stream' });
    fs.createReadStream(target).pipe(res);
  } catch (error) { pageErrors.push(String(error.stack)); json(res, { error: String(error) }, 500); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser, page;
const captureSelection = async () => {
  // WebKit may expose the range before painting its highlight. Record the
  // actual mouse selection after the next paint without changing that range.
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.screenshot({ path: path.join(frames, `${String(frame++).padStart(3, '0')}.png`) });
};
async function selectParagraph(locator) {
  await locator.scrollIntoViewIfNeeded();
  const points = await locator.evaluate(element => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT), nodes = [];
    let node;
    while ((node = walker.nextNode())) if (node.length) nodes.push(node);
    const edge = (node, last) => {
      const range = document.createRange();
      const offset = last ? node.length - 1 : 0;
      range.setStart(node, offset); range.setEnd(node, offset + 1);
      const rect = range.getBoundingClientRect();
      return { x: last ? rect.right - .1 : rect.left + .1, y: rect.y + rect.height / 2 };
    };
    return { start: edge(nodes[0], false), end: edge(nodes.at(-1), true) };
  });
  await page.mouse.move(points.end.x, points.end.y); await page.mouse.down();
  await page.mouse.move(points.start.x, points.start.y, { steps: 12 }); await page.mouse.up();
  return page.evaluate(() => String(getSelection()).trim());
}
async function check(name, test) {
  const row = { name }; receipt.cases.push(row);
  try { await test(); row.status = 'PASS'; }
  catch (error) { row.status = 'FAIL'; row.error = String(error.stack); process.exitCode = 1; }
  writeArtifact(artifacts, 'results.json', receipt);
  console.log(`${row.status}: ${name}`);
}
async function waitForHeld(index) {
  const deadline = Date.now() + 10000;
  while (held?.index !== index && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(held?.index, index, `Extractor ${index} must reach the deterministic HTTP barrier`);
}
try {
  browser = await browserType.launch();
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('pageerror', error => pageErrors.push(String(error)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  await page.addInitScript(({ origin, file, dir }) => {
    if (window.top !== window || location.origin !== origin) return;
    localStorage.setItem('ds4web.settings.v2', JSON.stringify({ v: 2, onboarded: true, theme: 'dark',
      chatBackend: 'local', model: 'deepseek-v4-flash', modelGguf: file, modelEngineDir: dir,
      ctxSize: 65536, enginePower: 90, ssdStreaming: 'off', webMode: 'research', webSearchBrowserAllowed: true }));
  }, { origin, file, dir });
  await page.goto(origin, { waitUntil: 'domcontentloaded' });
  await page.locator('[data-id="saved-answer"]').waitFor({ state: 'visible' });
  await page.locator('#composer-input').fill('Research the saved evidence');
  await page.locator('#composer-input').press('Enter');
  await waitForHeld(2);
  await check('the current extraction remains visible beyond twelve earlier events', async () => {
    const active = page.locator('.web-trace__row[data-state="active"]');
    assert.equal(await active.count(), 1);
    assert.ok((await active.textContent()).includes(urls[1]));
    await active.waitFor({ state: 'visible' });
    await page.waitForFunction(() => {
      const node = document.querySelector('.web-trace__row[data-state="active"]');
      if (!node) return false;
      const root = document.querySelector('#messages');
      const a = node.getBoundingClientRect(), b = root.getBoundingClientRect();
      return a.bottom > b.top && a.top < b.bottom && a.height > 0 &&
        Number(getComputedStyle(root).opacity) >= 0.99;
    }, null, { timeout: 3000 });
    const intersects = await active.evaluate(node => {
      const a = node.getBoundingClientRect(), b = document.querySelector('#messages').getBoundingClientRect();
      return a.bottom > b.top && a.top < b.bottom && a.height > 0;
    });
    assert.ok(intersects, 'Current work must be inside the transcript viewport');
    assert.ok(await page.locator('.web-trace__row').count() <= 12);
  });
  await page.screenshot({ path: path.join(artifacts, 'waiting-for-extraction.png') });
  await page.locator('#messages').hover();
  await page.mouse.wheel(0, -2000);
  await page.locator('#messages').evaluate(root => { root.scrollTop = 0; });
  await captureSelection();
  assert.equal(await selectParagraph(page.locator('[data-id="saved-answer"] .msg__content p')), greeting,
    'a real upward mouse drag selects the complete saved answer during research');
  await captureSelection();
  await page.evaluate(() => {
    const root = document.querySelector('#messages');
    const history = document.querySelector('[data-id="saved-answer"]');
    window.__progressHistory = history;
    window.__progressDetachments = 0;
    window.__progressObserver = new MutationObserver(records => {
      for (const record of records) for (const node of record.removedNodes) {
        if (node === history || node.contains?.(history)) window.__progressDetachments++;
      }
    });
    window.__progressObserver.observe(root, { childList: true, subtree: true });
    root.scrollTop = 0;
  });
  completion(held.res, held.reply);
  await waitForHeld(3);
  await check('progress preserves the attached transcript, selected text and reading position', async () => {
    const result = await page.evaluate(() => ({
      same: window.__progressHistory === document.querySelector('[data-id="saved-answer"]'),
      attached: window.__progressHistory.isConnected, detachments: window.__progressDetachments,
      selection: String(window.getSelection()), top: document.querySelector('#messages').scrollTop,
    }));
    assert.equal(result.detachments, 0, 'Progress cannot detach saved messages and leave WebKit repainting an empty transcript');
    assert.equal(result.same, true); assert.equal(result.attached, true);
    assert.equal(result.selection.trim(), greeting); assert.equal(result.top, 0);
    await captureSelection();
  });
  await page.evaluate(() => { window.getSelection().removeAllRanges(); window.__progressObserver.disconnect(); });
  await check('pending batches cannot hide current work and a background update cannot replace another chat', async () => {
    const result = await page.evaluate(() => {
      const { Store, Messages } = window.__researchTest;
      const chat = Store.getActiveChat(); const message = chat.messages.at(-1);
      const originalTrace = structuredClone(message.webTrace);
      const trace = [
        ...Array.from({ length: 40 }, (_, i) => ({ label: 'Completed step', detail: String(i), state: 'done' })),
        { label: 'Current work', detail: 'The actual current operation', state: 'active' },
        ...Array.from({ length: 30 }, (_, i) => ({ label: 'Future work', detail: String(i), state: 'pending' })),
      ];
      // Preserve the original trace too; this fixture only drives a pending view.
      Store.patchMessage(chat.id, message.id, { webTrace: trace });
      const updated = Messages.updateWebSearching(message.id, trace);
      const active = document.querySelector('.web-trace__row[data-state="active"]')?.textContent;
      const rowCount = document.querySelectorAll('.web-trace__row').length;
      const other = Store.createChat('chat');
      const rejected = Messages.updateWebSearching(message.id, trace);
      const otherReplaced = document.querySelectorAll('.web-trace').length;
      Store.setActiveChat(chat.id);
      Store.patchMessage(chat.id, message.id, { webTrace: originalTrace });
      Messages.updateWebSearching(message.id, originalTrace);
      return { updated, active, rowCount, rejected, otherReplaced, otherStillExists: !!Store.getChat(other.id) };
    });
    assert.equal(result.updated, true); assert.ok(result.active.includes('The actual current operation'));
    assert.equal(result.rowCount, 12); assert.equal(result.rejected, false);
    assert.equal(result.otherReplaced, 0); assert.equal(result.otherStillExists, true);
  });
  const inFlight = held;
  await page.getByRole('button', { name: 'Stop research', exact: true }).click();
  await check('Stop closes the actual transport and preserves the cancelled evidence trace', async () => {
    await page.getByText('Deep Research cancelled.', { exact: true }).waitFor();
    const deadline = Date.now() + 5000;
    while (!inFlight.closed && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(inFlight.closed, true);
    const snapshot = await page.evaluate(() => structuredClone(window.__researchTest.Store.getActiveChat()));
    const cancelled = snapshot.messages.at(-1);
    assert.equal(cancelled.finishReason, 'aborted'); assert.equal(cancelled.webSearching, false);
    assert.ok(cancelled.webTrace.some(step => step.detail.includes('source-2') && step.state === 'done'));
    assert.equal(snapshot.messages[1].content, greeting);
    assert.equal(await page.getByRole('button', { name: 'Stop research', exact: true }).count(), 0);
    completion(inFlight.res, inFlight.reply); // A late adapter reply cannot revive the stopped turn.
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.deepEqual(await page.evaluate(() => structuredClone(window.__researchTest.Store.getActiveChat())), snapshot);
  });
  await check('a failed streamed writer retains actual text and displays its error before the answer', async () => {
    await page.locator('#composer-input').fill('Spiega la scoperta e la controversia.');
    await page.locator('#composer-input').press('Enter');
    await page.locator('.web-trace__detail').filter({ hasText: 'characters received' }).waitFor({ state: 'visible', timeout: 10000 });
    assert.ok(writerHeld, 'The streamed writer reached its HTTP barrier');
    await page.screenshot({ path: path.join(artifacts, 'writer-progress.png') });
    writerHeld.destroy();
    const alert = page.getByRole('alert').filter({ hasText: 'Research answer incomplete' });
    await alert.waitFor({ state: 'visible', timeout: 10000 });
    const result = await page.evaluate(() => {
      const chat = window.__researchTest.Store.getActiveChat();
      const message = chat.messages.at(-1);
      const article = document.querySelector(`[data-id="${message.id}"]`);
      const alert = article.querySelector('[role="alert"]'), content = article.querySelector('.msg__content');
      return { message: structuredClone(message), before: !!(alert.compareDocumentPosition(content) & Node.DOCUMENT_POSITION_FOLLOWING),
        visibleText: article.textContent, request: chat.messages.findLast(m => m.role === 'user').web };
    });
    assert.equal(result.request.report, partialAnswer, 'Retain exact streamed bytes in the research receipt');
    assert.equal(result.message.content, partialAnswer.trim()); assert.equal(result.message.finishReason, 'incomplete');
    assert.equal(result.message.error.type, 'research-review'); assert.equal(result.before, true);
    assert.match(result.message.error.message, /Connection interrupted|ended before completion/);
    assert.ok(result.request.reportDraft.length > 0); assert.equal(result.request.reportQuality.ok, false);
    assert.equal(result.visibleText.includes('Source map'), false);
    await page.screenshot({ path: path.join(artifacts, 'writer-failed.png') });
    await captureSelection();
    assert.equal(await selectParagraph(page.locator('.msg--assistant').last().locator('.msg__content p').first()), partialAnswer.trim(),
      'the actual retained writer output is selectable after a transport failure');
    await captureSelection();
    await page.evaluate(() => getSelection().removeAllRanges());
  });
  await check('failure without generated output shows an error and keeps the scaffold private', async () => {
    writerMode = 'empty';
    await page.locator('#composer-input').fill('Spiega un’altra scoperta e la controversia.');
    await page.locator('#composer-input').press('Enter');
    await page.getByRole('alert').filter({ hasText: 'Fixture engine unavailable.' }).waitFor({ state: 'visible', timeout: 10000 });
    const result = await page.evaluate(() => {
      const chat = window.__researchTest.Store.getActiveChat(); const message = chat.messages.at(-1);
      const article = document.querySelector(`[data-id="${message.id}"]`);
      return { content: message.content, finish: message.finishReason, text: article.textContent,
        draft: chat.messages.findLast(m => m.role === 'user').web.reportDraft };
    });
    assert.equal(result.content, ''); assert.equal(result.finish, 'incomplete');
    assert.equal(result.text.includes('No verified summary facts'), false);
    assert.equal(result.text.includes('(no response)'), false); assert.equal(result.text.includes('Source map'), false);
    assert.ok(result.draft.length > 0);
    await page.screenshot({ path: path.join(artifacts, 'writer-empty.png') });
  });
  await check('Retry research starts fresh work and retains the original failed receipt', async () => {
    const before = await page.evaluate(() => structuredClone(window.__researchTest.Store.getActiveChat()));
    const failed = before.messages.at(-1), request = before.messages.findLast(m => m.role === 'user');
    writerMode = 'partial'; writerHeld = null;
    await page.locator(`[data-id="${failed.id}"]`).getByRole('button', { name: 'Retry research', exact: true }).click();
    await page.locator('.web-trace__detail').filter({ hasText: 'characters received' }).waitFor({ state: 'visible', timeout: 10000 });
    assert.ok(writerHeld);
    const after = await page.evaluate(() => structuredClone(window.__researchTest.Store.getActiveChat()));
    assert.deepEqual(after.messages.find(m => m.id === failed.id), failed);
    assert.equal(after.messages.findLast(m => m.role === 'user').content, request.content);
    assert.ok(after.messages.length > before.messages.length);
    await page.getByRole('button', { name: 'Stop research', exact: true }).click();
    await page.locator('.msg').last().getByText('Deep Research cancelled.', { exact: true }).waitFor();
  });
  await check('no browser or simulated service errors', () => assert.deepEqual(pageErrors, []));
  receipt.requestCount = modelRequests.length;
  receipt.status = process.exitCode ? 'FAIL' : 'PASS';
  await page.screenshot({ path: path.join(artifacts, 'cancelled.png') });
} catch (error) {
  receipt.status = 'FAIL'; receipt.error = String(error.stack); receipt.pageErrors = pageErrors;
  if (page) await page.screenshot({ path: path.join(artifacts, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  writeArtifact(artifacts, 'results.json', receipt);
  await browser?.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  if (frame) execFileSync('python3', ['tests/support/encode_ui_gif.py', frames, path.join(artifacts, 'research-selection.gif')]);
}

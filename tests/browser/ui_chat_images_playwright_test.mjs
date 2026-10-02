import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { uiMockServer, jsonReply, requestBody, seedUi, sseDelta, sseDone } from '../support/ui_mock_server.mjs';
import { chromium, webkit } from 'playwright';

const browserName = process.env.DSTUDIO_TEST_BROWSER || 'chromium';
assert.ok(['chromium', 'webkit'].includes(browserName));
const documentFixture = process.env.DSTUDIO_TEST_DOCUMENT_FIXTURE;
const document = documentFixture ? JSON.parse(fs.readFileSync(documentFixture, 'utf8')) : undefined;
const inputs = Array.from({ length: 6 }, (_, i) => path.resolve(`tests/fixtures/ui-images/image-${i + 1}.png`));
const imageUri = i => 'data:image/png;base64,' + fs.readFileSync(inputs[i]).toString('base64');
const roadmap = { version: 1, title: 'Images curriculum', goal: 'Inspect attachments.', stages: [{ id: 'reading', title: 'Reading', topics: [{ id: 'images', title: 'Images', summary: 'Inspect the original image.', outcome: 'Read its dimensions.' }] }] };
const now = Date.now();
const learnChat = { id: 'fixture-learn', mode: 'roadmap', title: 'Images curriculum', createdAt: now, updatedAt: now,
  messages: [{ id: 'learn-answer', role: 'assistant', content: '```dstudio-roadmap\n' + JSON.stringify(roadmap) + '\n```' }] };
const chatRequests = [];
let pdfBarrier = null;
let inactiveVision = false;
const pdfResult = { ok: true, completeText: true, total: 1, pages: 1, textPages: 1, scannedPages: 0,
  text: 'Simulated PDF evidence.', vision: [{ page: 1, image: imageUri(1) }] };
const server = await uiMockServer(async (req, res, url) => {
  if (url.pathname === '/api/status' && inactiveVision) {
    jsonReply(res, { mode: 'server', running: true, ready: true, loadPct: 100, stage: 'Ready (simulated)',
      modelFile: 'gguf/DeepSeek-V4-Flash-Vision-Exp-test.gguf',
      nativeVisionActive: false, deepseekVisionInstalled: true, ds4dirOk: true, webdirOk: true,
      config: { ctx: 65536, power: 100, think: 'off' } });
    return true;
  }
  if (url.pathname === '/api/pdf/thumb') { jsonReply(res, { ok: true, thumb: 'data:image/png;base64,' + fs.readFileSync(inputs[1]).toString('base64') }); return true; }
  if (url.pathname === '/api/pdf/progress') { jsonReply(res, { phase: 'extracting' }); return true; }
  if (url.pathname === '/api/pdf/describe') {
    await requestBody(req);
    if (pdfBarrier) pdfBarrier.push(res); else jsonReply(res, pdfResult);
    return true;
  }
  if (url.pathname !== '/v1/chat/completions') return false;
  chatRequests.push(await requestBody(req));
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  sseDelta(res, 'Simulated image comparison.'); sseDone(res); return true;
}, { document });
fs.mkdirSync('tests/.artifacts/chat-images', { recursive: true });
const dir = fs.mkdtempSync(`tests/.artifacts/chat-images/${browserName}-`);
const receipt = { scope: 'Real browser, production UI, all engine replies simulated; no models started', browserName, cases: [] };
const browser = await ({ chromium, webkit })[browserName].launch();
try {
  for (const theme of ['dark', 'light']) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
    page.setDefaultTimeout(5000);
    const evidence = await seedUi(page, server.origin, { theme });
    try {
      await page.goto(server.origin);
      await page.locator('#chat-file-input').setInputFiles(inputs.slice(0, 3));
      const tiles = page.locator('.composer__file');
      await page.waitForFunction(() => document.querySelectorAll('.composer__file[aria-busy="false"]').length === 3);
      assert.equal((await tiles.first().boundingBox()).width, 64, 'images use the mockup 64px tray');
      assert.equal((await tiles.first().locator('.file-tile-icon img').boundingBox()).width, 64, 'the bitmap fills the tray tile');
      await tiles.first().click();
      const viewer = page.getByRole('dialog', { name: 'Image viewer', exact: true });
      await viewer.waitFor();
      await page.waitForFunction(() => document.querySelector('#image-viewer-meta').textContent.includes('652 × 1902'));
      assert.match(await viewer.textContent(), /1 of 3/);
      await viewer.getByRole('button', { name: 'Next image', exact: true }).click();
      assert.match(await page.locator('#image-viewer-title').textContent(), /image-2.png/);
      await page.keyboard.press('ArrowRight');
      assert.match(await page.locator('#image-viewer-title').textContent(), /image-3.png/);
      await viewer.getByRole('button', { name: 'Previous image', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('#image-viewer-meta').textContent.includes('2 of 3'));
      await viewer.getByRole('button', { name: 'Toggle Fit / 100%', exact: true }).click();
      assert.equal(await page.locator('#image-viewer-zoom').textContent(), '100%');
      assert.equal((await page.locator('#image-viewer-image').boundingBox()).width, 1024);
      await viewer.getByRole('button', { name: 'Zoom in', exact: true }).click();
      assert.equal((await page.locator('#image-viewer-image').boundingBox()).width, 2048);
      await viewer.getByRole('button', { name: 'Zoom out', exact: true }).click();
      await viewer.getByRole('button', { name: 'Toggle Fit / 100%', exact: true }).click();
      const fit = await page.locator('#image-viewer-image').boundingBox();
      const stage = await page.locator('#image-viewer-stage').boundingBox();
      assert.ok(fit.width <= stage.width && fit.height <= stage.height);
      const download = page.waitForEvent('download');
      await viewer.getByRole('button', { name: 'Save image', exact: true }).click();
      const saved = await download;
      assert.equal(saved.suggestedFilename(), 'image-2.png');
      await saved.saveAs(path.join(dir, `${theme}-saved.png`));
      assert.deepEqual(fs.readFileSync(path.join(dir, `${theme}-saved.png`)), fs.readFileSync(inputs[1]), 'save preserves the original bytes');
      await page.screenshot({ path: path.join(dir, `${theme}-viewer.png`) });
      await page.keyboard.press('Escape');
      await viewer.waitFor({ state: 'hidden' });
      await tiles.last().getByRole('button', { name: 'Remove image-3.png', exact: true }).click();
      assert.equal(await tiles.count(), 2);
      await page.locator('#composer-input').fill('Compare these images.');
      await page.locator('#btn-send').click();
      await page.locator('.msg--assistant .md').filter({ hasText: 'Simulated image comparison.' }).waitFor();
      const gallery = page.locator('.msg--user .image-gallery');
      assert.equal(await gallery.getByRole('button').count(), 2);
      const frames = gallery.locator('.image-frame');
      assert.equal((await frames.first().boundingBox()).height, 168);
      assert.equal((await frames.first().boundingBox()).y, (await frames.last().boundingBox()).y);
      assert.ok(chatRequests.at(-1).messages.some(message => Array.isArray(message.content) && message.content.filter(part => part.type === 'image_url').length === 2), 'actual produced request carries both images');
      await page.screenshot({ path: path.join(dir, `${theme}-sent.png`) });
      await page.reload();
      await gallery.waitFor();
      await gallery.getByRole('button').first().click();
      await viewer.waitFor();
      await page.waitForFunction(() => document.querySelector('#image-viewer-meta').textContent.includes('Preview'));
      assert.match(await viewer.textContent(), /Preview/); // Reload has the persisted thumbnail, never claims original bytes.
      const previewDownload = page.waitForEvent('download');
      await viewer.getByRole('button', { name: 'Save image', exact: true }).click();
      const preview = await previewDownload;
      assert.equal(preview.suggestedFilename(), 'image-1-preview.jpg', 'preview downloads have an honest name and matching encoding');
      await preview.saveAs(path.join(dir, `${theme}-preview.jpg`));
      assert.deepEqual([...fs.readFileSync(path.join(dir, `${theme}-preview.jpg`)).subarray(0, 3)], [255, 216, 255]);
      await page.keyboard.press('Escape');
      await page.setViewportSize({ width: 390, height: 740 });
      await gallery.getByRole('button').last().click();
      await viewer.waitFor();
      const mobile = await viewer.boundingBox();
      assert.ok(mobile.width <= 390 && mobile.height <= 740);
      assert.equal(await viewer.getByRole('button', { name: 'Close', exact: true }).isVisible(), true);
      await page.screenshot({ path: path.join(dir, `${theme}-mobile.png`) });
      assert.deepEqual(evidence.errors, []); assert.deepEqual(evidence.external, []);
      receipt.cases.push({ name: `attach/view/zoom/download/send/reload/mobile ${theme}`, status: 'PASS' });
    } catch (error) {
      receipt.cases.push({ name: theme, status: 'FAIL', error: error.stack, ...evidence });
      await page.screenshot({ path: path.join(dir, `${theme}-failure.png`) });
    } finally {
      for (const response of pdfBarrier || []) if (!response.writableEnded) jsonReply(response, pdfResult);
      pdfBarrier = null;
      await page.close();
    }
  }
  const run = async (name, callback, options = {}) => {
    server.resetStore();
    const page = await browser.newPage({ viewport: { width: 1100, height: 820 } }); page.setDefaultTimeout(5000);
    const evidence = await seedUi(page, server.origin, options);
    try {
      await callback(page);
      assert.deepEqual(evidence.errors, []); assert.deepEqual(evidence.external, []);
      receipt.cases.push({ name, status: 'PASS' });
    } catch (error) {
      receipt.cases.push({ name, status: 'FAIL', error: error.stack, ...evidence });
      await page.screenshot({ path: path.join(dir, name + '-failure.png') });
    } finally {
      inactiveVision = false;
      for (const response of pdfBarrier || []) if (!response.writableEnded) jsonReply(response, pdfResult);
      pdfBarrier = null;
      await page.close();
    }
  };
  await run('installed-encoder-unconfirmed-runtime-and-retry', async page => {
    inactiveVision = true;
    await page.goto(server.origin);
    await page.locator('#chat-file-input').setInputFiles(inputs[0]);
    await page.waitForFunction(() => document.querySelector('.composer__file')?.getAttribute('aria-busy') === 'false');
    await page.locator('#composer-input').fill('Inspect the image.');
    const count = chatRequests.length;
    await page.locator('#btn-send').click();
    const answer = page.locator('.msg--assistant .md').last();
    await answer.filter({ hasText: 'vision' }).waitFor();
    assert.match(await answer.textContent(), /encoder is installed/i, 'installed files are distinct from active vision');
    assert.doesNotMatch(await answer.textContent(), /Download|could not be restarted/i, 'unconfirmed vision is not a missing download or restart failure');
    assert.equal(chatRequests.length, count, 'unknown capability cannot admit image inference');
    inactiveVision = false;
    await page.getByRole('button', { name: 'Retry', exact: true }).click();
    await answer.filter({ hasText: 'Simulated image comparison' }).waitFor();
    assert.equal(chatRequests.length, count + 1);
    assert.ok(chatRequests.at(-1).messages.some(message => Array.isArray(message.content) &&
      message.content.some(part => part.type === 'image_url' && part.image_url?.url === imageUri(0))),
      'retry retains exact admitted image bytes');
  });
  await run('drag-paste-gallery', async page => {
    await page.goto(server.origin);
    const transfer = await page.evaluateHandle(bytes => {
      const dt = new DataTransfer(); dt.items.add(new File([Uint8Array.from(bytes)], 'dropped.png', { type: 'image/png' })); return dt;
    }, [...fs.readFileSync(inputs[0])]);
    await page.locator('.chat').dispatchEvent('dragenter', { dataTransfer: transfer });
    await page.locator('.composer-drop').waitFor();
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.composer-drop')).opacity === '1');
    const overlay = await page.locator('.composer-drop').boundingBox(), chat = await page.locator('.chat').boundingBox();
    assert.ok(overlay.height > chat.height * .9, 'drop feedback covers the chat, not only the composer');
    await page.screenshot({ path: path.join(dir, 'drag.png') });
    await page.locator('#composer-input').dispatchEvent('dragenter', { dataTransfer: transfer });
    await page.locator('#composer-input').dispatchEvent('dragleave', { dataTransfer: transfer });
    assert.equal(await page.locator('body').evaluate(node => node.classList.contains('drag-attach')), true, 'nested dragleave keeps the outer drop active');
    await page.locator('.chat').dispatchEvent('drop', { dataTransfer: transfer });
    await page.waitForFunction(() => document.querySelectorAll('.composer__file[aria-busy="false"]').length === 1);
    assert.equal(await page.locator('body').evaluate(node => node.classList.contains('drag-attach')), false);
    await page.evaluate(bytes => {
      const dt = new DataTransfer(); dt.items.add(new File([Uint8Array.from(bytes)], 'pasted.png', { type: 'image/png' }));
      document.querySelector('#composer-input').dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }));
    }, [...fs.readFileSync(inputs[1])]);
    await page.locator('#chat-file-input').setInputFiles(inputs.slice(2, 6));
    await page.waitForFunction(() => document.querySelectorAll('.composer__file[aria-busy="false"]').length === 6);
    await page.locator('#composer-input').fill('Compare all six.'); await page.locator('#btn-send').click();
    await page.locator('.msg--user .image-gallery').waitFor();
    assert.equal(await page.locator('.image-frame').count(), 4);
    assert.equal(await page.locator('.image-frame__more').textContent(), '+2');
    await page.locator('.image-frame').last().click();
    await page.waitForFunction(() => document.querySelector('#image-viewer-meta').textContent.includes('4 of 6'));
    await page.getByRole('button', { name: 'Next image', exact: true }).click();
    await page.getByRole('button', { name: 'Next image', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#image-viewer-meta').textContent.includes('6 of 6'));
    assert.equal(await page.getByRole('button', { name: 'Next image', exact: true }).isEnabled(), false);
    await page.screenshot({ path: path.join(dir, 'six-image-viewer.png') });
  });
  await run('preparation-cancellation', async page => {
    await page.addInitScript(origin => {
      if (window !== window.top || location.origin !== origin) return;
      const read = FileReader.prototype.readAsDataURL;
      FileReader.prototype.readAsDataURL = function(file) {
        if (file.name === 'tardy.png') window.releaseRead = () => read.call(this, file);
        else read.call(this, file);
      };
    }, server.origin);
    await page.goto(server.origin);
    await page.locator('#chat-file-input').setInputFiles({ name: 'tardy.png', mimeType: 'image/png', buffer: fs.readFileSync(inputs[1]) });
    await page.locator('.composer__file[aria-busy="true"]').waitFor();
    await page.waitForFunction(() => typeof window.releaseRead === 'function');
    assert.equal(await page.locator('#btn-send').isEnabled(), false, 'unprepared images cannot be sent');
    await page.getByRole('button', { name: 'Remove tardy.png', exact: true }).click();
    await page.evaluate(() => window.releaseRead());
    await page.locator('#chat-file-input').setInputFiles(inputs[0]);
    await page.waitForFunction(() => document.querySelectorAll('.composer__file[aria-busy="false"]').length === 1);
    assert.equal(await page.locator('.composer__file').count(), 1, 'cancelled preparation cannot republish the removed attachment');
    await page.locator('#chat-file-input').setInputFiles({ name: 'corrupt.png', mimeType: 'image/png', buffer: Buffer.from('invalid image bytes') });
    await page.locator('.composer__file--failed').waitFor();
    assert.equal(await page.locator('#btn-send').isEnabled(), false);
    await page.getByRole('button', { name: 'Remove corrupt.png', exact: true }).click();
    assert.equal(await page.locator('#btn-send').isEnabled(), true);
    await page.screenshot({ path: path.join(dir, 'prepared.png') });
  });
  await run('text-only-guard', async page => {
    await page.goto(server.origin); await page.locator('#chat-file-input').setInputFiles(inputs[1]);
    await page.waitForFunction(() => document.querySelector('.composer__file')?.getAttribute('aria-busy') === 'false');
    await page.locator('#composer-input').fill('Read this image');
    assert.equal(await page.locator('#btn-send').isEnabled(), false);
    await page.getByRole('button', { name: 'Choose vision model', exact: true }).click();
    await page.locator('.cbar-model-menu').waitFor();
    assert.equal(await page.locator('.composer__file').count(), 1);
  }, { settings: { modelGguf: 'gguf/DeepSeek-V4-Flash-test.gguf' } });
  await run('clipboard-image', async page => {
    await page.addInitScript(origin => {
      if (window !== window.top || location.origin !== origin) return;
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
        write: async items => {
          const blob = await items[0].getType('image/png'), bytes = new Uint8Array(await blob.arrayBuffer());
          window.copiedImage = { mime: blob.type, size: blob.size, header: [...bytes.slice(0, 8)] };
        },
      } });
    }, server.origin);
    await page.goto(server.origin); await page.locator('#chat-file-input').setInputFiles(inputs[1]);
    await page.waitForFunction(() => document.querySelector('.composer__file')?.getAttribute('aria-busy') === 'false');
    await page.locator('.composer__file').click();
    await page.getByRole('button', { name: 'Copy image', exact: true }).click();
    await page.waitForFunction(() => window.copiedImage?.size > 0);
    assert.deepEqual(await page.evaluate(() => window.copiedImage.header), [137,80,78,71,13,10,26,10]);
    assert.equal(await page.evaluate(() => window.copiedImage.mime), 'image/png');
  });
  await run('gallery-layouts-and-generated-images', async page => {
    await page.goto(server.origin);
    const galleries = page.locator('.msg .image-gallery');
    assert.equal(await galleries.count(), 3);
    const first = galleries.nth(0).locator('.image-frame');
    assert.equal((await first.first().boundingBox()).width, 340);
    assert.equal((await first.first().boundingBox()).height, 196);
    assert.equal((await first.nth(1).boundingBox()).y, (await first.nth(2).boundingBox()).y);
    const tall = galleries.nth(1).locator('.image-frame');
    assert.equal((await tall.boundingBox()).height, 380);
    assert.equal((await tall.boundingBox()).width, 200);
    assert.equal(await tall.locator('.image-frame__dimensions').textContent(), '652 × 1902');
    await galleries.nth(2).getByRole('button').nth(1).click();
    await page.waitForFunction(() => document.querySelector('#image-viewer-meta').textContent.includes('2 of 2'));
    await page.getByRole('button', { name: 'Show generated-1.png', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#image-viewer-meta').textContent.includes('1 of 2'));
    assert.equal(await page.getByRole('button', { name: 'Previous image', exact: true }).isEnabled(), false);
    await page.keyboard.press('Escape');
    await page.screenshot({ path: path.join(dir, 'gallery-layouts.png') });
  }, { chats: [{ id: 'fixture-chat', mode: 'chat', title: 'Gallery layouts', createdAt: now, updatedAt: now, messages: [
    { id: 'gallery-3', role: 'user', content: 'Three images', attachments: [0,1,2].map((i) => ({ id: `image-${i}`, kind: 'image', name: `image-${i+1}.png`, thumb: imageUri(i), width: i === 0 ? 652 : 1024, height: i === 0 ? 1902 : 600 })) },
    { id: 'gallery-tall', role: 'user', content: 'A tall image', attachments: [{ id: 'tall', kind: 'image', name: 'tall.png', thumb: imageUri(0), width: 652, height: 1902 }] },
    { id: 'gallery-generated', role: 'assistant', content: 'Simulated generated images', generatedImages: [0,1].map(i => ({ name: `generated-${i+1}.png`, url: imageUri(i), width: 1024, height: 600 })) },
  ] }] });
  await run('attachment-admission', async page => {
    await page.goto(server.origin);
    const files = inputs.map(file => ({ name: path.basename(file), mimeType: 'image/png', buffer: fs.readFileSync(file) }));
    await page.locator('#chat-file-input').setInputFiles([...files, { ...files[0], name: 'seventh.png' }]);
    await page.waitForFunction(() => document.querySelectorAll('.composer__file[aria-busy="false"]').length === 6);
    assert.equal(await page.locator('.composer__file').count(), 6, 'the real picker cannot exceed six reserved slots');
    await page.getByRole('button', { name: 'Remove image-1.png', exact: true }).click();
    await page.locator('#chat-file-input').setInputFiles({ name: 'too-large.png', mimeType: 'image/png', buffer: Buffer.alloc(16 * 1024 * 1024 + 1) });
    assert.equal(await page.locator('.composer__file').count(), 5, 'oversized files never reserve a slot');
    await page.locator('#chat-file-input').setInputFiles({ name: 'unsupported.exe', mimeType: 'application/octet-stream', buffer: Buffer.from('synthetic input') });
    assert.equal(await page.locator('.composer__file').count(), 5);
    await page.locator('#chat-file-input').setInputFiles(inputs[0]);
    await page.waitForFunction(() => document.querySelectorAll('.composer__file[aria-busy="false"]').length === 6);
  });
  await run('stale-conversation-preparation', async page => {
    await page.addInitScript(origin => {
      if (window !== window.top || location.origin !== origin) return;
      const read = FileReader.prototype.readAsDataURL;
      FileReader.prototype.readAsDataURL = function(file) {
        if (file.name === 'old-owner.png') window.releaseOldOwner = () => read.call(this, file);
        else read.call(this, file);
      };
    }, server.origin);
    await page.goto(server.origin);
    await page.locator('#chat-file-input').setInputFiles({ name: 'old-owner.png', mimeType: 'image/png', buffer: fs.readFileSync(inputs[1]) });
    await page.waitForFunction(() => typeof window.releaseOldOwner === 'function');
    await page.locator('#btn-new-chat').click();
    await page.evaluate(() => window.releaseOldOwner());
    await page.waitForFunction(() => !document.querySelector('.composer__file'));
    await page.locator('#chat-file-input').setInputFiles(inputs[0]);
    await page.waitForFunction(() => document.querySelector('.composer__file')?.getAttribute('aria-busy') === 'false');
    assert.equal(await page.locator('.composer__file').count(), 1, 'late work from the previous conversation cannot publish');
  });
  await run('tutor-preparation-and-gallery', async page => {
    await page.goto(server.origin); await page.locator('#tab-roadmap').click();
    await page.getByRole('button', { name: 'Study Images', exact: true }).click();
    const picker = page.locator('.roadmap-study__file-input');
    await picker.setInputFiles({ name: 'corrupt.png', mimeType: 'image/png', buffer: Buffer.from('invalid image') });
    await page.locator('.roadmap-study__file').filter({ hasText: 'Could not read' }).waitFor();
    assert.equal(await page.locator('.roadmap-study__send').isEnabled(), false, 'Tutor cannot consume a failed preparation');
    await page.getByRole('button', { name: 'Remove corrupt.png', exact: true }).click();
    await picker.setInputFiles(inputs.slice(0, 2));
    await page.waitForFunction(() => document.querySelectorAll('.roadmap-study__file[aria-busy="false"]').length === 2);
    await page.locator('.roadmap-study__input').fill('Inspect these images.');
    await page.locator('.roadmap-study__send').click();
    await page.locator('.roadmap-study-msg--assistant .md').filter({ hasText: 'Simulated image comparison' }).waitFor();
    assert.ok(chatRequests.at(-1).messages.some(message => Array.isArray(message.content) && message.content.filter(part => part.type === 'image_url').length === 2), 'Tutor request carries actual native image parts');
    const gallery = page.locator('.roadmap-study-msg--user .image-gallery');
    assert.equal(await gallery.getByRole('button').count(), 2);
    await gallery.getByRole('button').first().click();
    await page.waitForFunction(() => document.querySelector('#image-viewer-meta').textContent.includes('1 of 2'));
  }, { chats: [learnChat] });

  await run('tutor-close-discards-late-imports', async page => {
    await page.addInitScript(origin => {
      if (window !== window.top || location.origin !== origin) return;
      const read = FileReader.prototype.readAsDataURL, revoke = URL.revokeObjectURL;
      window.releaseReads = {}; window.revokedUrls = [];
      URL.revokeObjectURL = url => { window.revokedUrls.push(url); revoke.call(URL, url); };
      FileReader.prototype.readAsDataURL = function(file) {
        if (file.name.startsWith('tardy')) window.releaseReads[file.name] = () => read.call(this, file);
        else read.call(this, file);
      };
    }, server.origin);
    await page.goto(server.origin); await page.locator('#tab-roadmap').click();
    await page.locator('#chat-file-input').setInputFiles(inputs[0]);
    await page.waitForFunction(() => document.querySelector('.composer__file')?.getAttribute('aria-busy') === 'false');
    await page.locator('#chat-file-input').setInputFiles({ name: 'tardy-main.png', mimeType: 'image/png', buffer: fs.readFileSync(inputs[1]) });
    await page.waitForFunction(() => typeof window.releaseReads['tardy-main.png'] === 'function');
    await page.getByRole('button', { name: 'Study Images', exact: true }).click();
    await page.locator('.roadmap-study__file-input').setInputFiles({ name: 'tardy-tutor.png', mimeType: 'image/png', buffer: fs.readFileSync(inputs[1]) });
    await page.waitForFunction(() => typeof window.releaseReads['tardy-tutor.png'] === 'function');
    assert.equal(await page.locator('.roadmap-study__send').isEnabled(), false);
    await page.getByRole('button', { name: 'Back to roadmap', exact: true }).click();
    await page.evaluate(() => { window.releaseReads['tardy-main.png'](); window.releaseReads['tardy-tutor.png'](); });
    await page.locator('#chat-file-input').setInputFiles(inputs[2]);
    await page.waitForFunction(() => document.querySelectorAll('.composer__file[aria-busy="false"]').length === 2);
    assert.equal(await page.locator('.composer__file').count(), 2, 'closing Tutor retains earlier ready main attachments and discards both late imports');
    assert.ok(await page.evaluate(() => window.revokedUrls.length >= 2), 'cancelled original blob URLs are retired');
    await page.getByRole('button', { name: 'Study Images', exact: true }).click();
    assert.equal(await page.locator('.roadmap-study__file').count(), 0, 'a closed room cannot acquire a late attachment');
  }, { chats: [learnChat] });

  await run('tutor-close-cancels-blocked-send-preparation', async page => {
    pdfBarrier = [];
    await page.goto(server.origin); await page.locator('#tab-roadmap').click();
    await page.getByRole('button', { name: 'Study Images', exact: true }).click();
    await page.locator('.roadmap-study__file-input').setInputFiles({ name: 'fixture.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\nSimulated bytes\n%%EOF') });
    await page.waitForFunction(() => document.querySelector('.roadmap-study__file')?.getAttribute('aria-busy') === 'false');
    await page.locator('.roadmap-study__input').fill('Read the file.');
    const described = page.waitForRequest(request => request.url().endsWith('/api/pdf/describe'));
    const before = chatRequests.length;
    await page.locator('.roadmap-study__send').click(); await described;
    await page.getByRole('button', { name: 'Back to roadmap', exact: true }).click();
    await page.locator('#chat-file-input').setInputFiles(inputs[2]);
    await page.waitForFunction(() => document.querySelector('.composer__file')?.getAttribute('aria-busy') === 'false');
    for (const response of pdfBarrier) jsonReply(response, pdfResult);
    await page.getByRole('button', { name: 'Study Images', exact: true }).click();
    await page.locator('.roadmap-study__input').fill('New draft after closing.');
    assert.equal(chatRequests.length, before, 'a closed Tutor cannot dispatch a late prepared request');
    assert.equal(await page.locator('.roadmap-study-msg--user').count(), 0, 'late preparation does not publish in a reopened room');
    await page.getByRole('button', { name: 'Back to roadmap', exact: true }).click();
    assert.equal(await page.locator('.composer__file').count(), 1, 'the new main attachment remains owned by the main composer');
    assert.match(await page.locator('.composer__file').textContent(), /image-3.png/);
  }, { chats: [learnChat] });

  await run('send-preparation-keeps-later-attachments', async page => {
    pdfBarrier = [];
    await page.goto(server.origin);
    await page.locator('#chat-file-input').setInputFiles([
      { name: 'fixture.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\nSimulated bytes\n%%EOF') },
      { name: 'original.png', mimeType: 'image/png', buffer: fs.readFileSync(inputs[0]) },
    ]);
    await page.waitForFunction(() => document.querySelectorAll('.composer__file[aria-busy="false"]').length === 2);
    await page.locator('#composer-input').fill('Read the original files.');
    const described = page.waitForRequest(request => request.url().endsWith('/api/pdf/describe'));
    const before = chatRequests.length;
    await page.locator('#btn-send').click(); await described;
    await page.locator('#chat-file-input').setInputFiles(inputs[2]);
    await page.waitForFunction(() => [...document.querySelectorAll('.composer__file')].some(node => node.textContent.includes('image-3.png') && node.getAttribute('aria-busy') === 'false'));
    assert.equal(chatRequests.length, before, 'blocked preparation cannot dispatch an unprepared request');
    for (const response of pdfBarrier) jsonReply(response, pdfResult);
    await page.locator('.msg--assistant .md').filter({ hasText: 'Simulated image comparison' }).waitFor();
    assert.equal(await page.locator('.composer__file').count(), 1, 'a later file remains available for the next send');
    assert.match(await page.locator('.composer__file').textContent(), /image-3.png/);
    const sent = chatRequests.at(-1).messages.at(-1).content;
    assert.equal(sent.filter(part => part.type === 'image_url').length, 2, 'the request contains the admitted image and prepared PDF page');
    assert.ok(sent.filter(part => part.type === 'text').some(part => part.text.includes('Simulated PDF evidence.')));
  });

  await run('stop-preparation-preserves-original-for-retry', async page => {
    pdfBarrier = [];
    await page.goto(server.origin);
    await page.locator('#chat-file-input').setInputFiles({ name: 'fixture.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\nSimulated bytes\n%%EOF') });
    await page.waitForFunction(() => document.querySelector('.composer__file')?.getAttribute('aria-busy') === 'false');
    await page.locator('#composer-input').fill('Retryable PDF request.');
    const described = page.waitForRequest(request => request.url().endsWith('/api/pdf/describe'));
    const before = chatRequests.length;
    await page.locator('#btn-send').click(); await described;
    await page.locator('#btn-stop').click();
    await page.waitForFunction(() => !document.querySelector('#composer-input').disabled);
    for (const response of pdfBarrier) jsonReply(response, pdfResult);
    pdfBarrier = null;
    assert.equal(chatRequests.length, before, 'Stop prevents dispatch while a PDF read is blocked');
    assert.equal(await page.locator('.composer__file').count(), 1, 'Stop preserves the original attachment');
    assert.equal(await page.locator('#composer-input').inputValue(), 'Retryable PDF request.');
    await page.locator('#btn-send').click();
    await page.locator('.msg--assistant .md').filter({ hasText: 'Simulated image comparison' }).waitFor();
    assert.equal(chatRequests.length, before + 1);
    assert.ok(chatRequests.at(-1).messages.at(-1).content.some(part => part.type === 'text' && part.text.includes('Simulated PDF evidence.')));
  });

} finally {
  receipt.requests = server.requests; receipt.missing = server.missing;
  fs.writeFileSync(path.join(dir, 'receipt.json'), JSON.stringify(receipt, null, 2));
  console.log(`Images UI evidence: ${dir}`); await browser.close(); server.close();
}
assert.ok(receipt.cases.every(test => test.status === 'PASS'), JSON.stringify(receipt.cases, null, 2));
assert.deepEqual(server.missing, [], 'all endpoints must be explicitly mocked');

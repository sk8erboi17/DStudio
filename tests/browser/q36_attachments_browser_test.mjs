// Invoked by the isolated q36 host integration runner with --browser.
// Browser, native HTTP, uploads and image tools are real. The inference peer
// and weight/installer bytes are simulated: this is not model-quality evidence.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {q36VisionPNG} from '../support/q36_vision_fixtures.mjs';

export async function q36AttachmentBrowser({row, mode, base, work, engine, model, run,
  nextRequest, answer, call, state, idle, resident}) {
  const name = process.env.DSTUDIO_TEST_BROWSER || 'webkit';
  const theme = process.env.DSTUDIO_TEST_THEME || 'light';
  assert(['webkit', 'chromium'].includes(name)); assert(['light', 'dark'].includes(theme));
  row.browser = name; row.theme = theme;
  const browser = await (await import('playwright'))[name].launch();
  const context = await browser.newContext({viewport: {width: 1280, height: 900}, colorScheme: theme});
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.stack || error.message));
  page.on('console', message => {if (message.type() === 'error') errors.push(message.text());});
  row.launchRequests = [];
  page.on('request', request => {
    if (request.url().endsWith('/api/start') && request.method() === 'POST')
      row.launchRequests.push(request.postDataJSON());
  });
  const bytes = q36VisionPNG(1), filename = 'browser-input.png';
  row.sourceSHA256 = crypto.createHash('sha256').update(bytes).digest('hex');
  await page.addInitScript(({origin, work, engine, model, theme}) => {
    if (window.top !== window || location.origin !== origin) return;
    const now = Date.now();
    localStorage.setItem('ds4web.settings.v2', JSON.stringify({v: 2, onboarded: true,
      theme, baseUrl: '', chatBackend: 'local', model: 'qwen3.8-27b', modelGguf: model,
      modelEngineDir: engine, modelVariant: 'flash', ctxSize: 8192, enginePower: 100,
      thinkLevel: 'off', ssdStreaming: 'off', kvSpaceMb: 256, kvMinTokens: 128,
      webMode: 'off', workdirs: {agent: work, cowork: work}}));
    localStorage.setItem('ds4web.chats.v2', JSON.stringify({v: 2, deleted: [], chats:
      ['chat', 'cowork'].map(mode => ({id: 'browser-' + mode, mode, title: 'Image delivery',
        createdAt: now, updatedAt: now, messages: [], transcript: ''}))}));
    localStorage.setItem('ds4web.active.v2', JSON.stringify({v: 2,
      ids: {chat: 'browser-chat', cowork: 'browser-cowork', agent: null, design: null}}));
  }, {origin: base, work, engine, model, theme});
  try {
    await page.goto(base, {waitUntil: 'domcontentloaded'});
    assert.match(await page.locator('.cbar-model-btn').innerText(), /text \+ images/);
    if (mode === 'cowork') {
      await page.locator('#tab-cowork').click();
      // Use the real folder confirmation; do not replace the picker with a
      // JavaScript hook or treat a waiting confirmation as a loading failure.
      await page.getByRole('button', {name: 'Start Cowork', exact: true}).click();
      await page.locator('#pipe-head-mode').filter({hasText: 'Cowork'}).waitFor();
      await idle();
    }
    const active = row.active = await state();
    assert.equal(active.residentPid, resident, 'Browser must retain the selected owned model');
    assert.equal(active.nativeVisionActive, true);
    let relative;
    const uploaded = mode === 'cowork'
      ? page.waitForResponse(response => response.url().endsWith('/api/cowork/attach-file') && response.request().method() === 'POST')
      : null;
    await page.locator('#chat-file-input').setInputFiles({name: filename, mimeType: 'image/png', buffer: bytes});
    if (uploaded) {
      const response = await uploaded; assert.equal(response.status(), 200);
      const saved = await response.json(); assert.equal(saved.ok, true);
      relative = saved.rel;
      const target = fs.realpathSync(path.resolve(work, relative));
      assert(target.startsWith(fs.realpathSync(work) + path.sep));
      assert.deepEqual(fs.readFileSync(target), bytes, 'Upload must save original image bytes');
      row.savedFile = relative;
    }
    await page.locator('.composer__file-name').filter({hasText: filename}).waitFor();
    const prompt = 'Inspect this attached image and reply briefly.';
    await page.locator('#composer-input').fill(prompt);
    await page.locator('#btn-send').click();
    const first = await nextRequest(false, mode === 'cowork');
    row.requests = [first.file];
    let pixelRequest = first;
    if (mode === 'cowork') {
      assert(first.body.tools.some(tool => tool.function.name === 'view_image'));
      assert(first.body.messages.some(message => typeof message.content === 'string' && message.content.includes(relative)),
        'The composer must hand the actual workspace image to its tool loop');
      answer(first, {tools: [call('browser-image', 'view_image', {path: relative})]});
      pixelRequest = await nextRequest(); row.requests.push(pixelRequest.file);
    }
    const images = pixelRequest.body.messages.flatMap(message => Array.isArray(message.content) ? message.content : [])
      .filter(part => part.type === 'image_url');
    assert.equal(images.length, 1);
    const uri = images[0].image_url.url;
    assert.match(uri, /^data:image\/(png|jpeg);base64,/);
    if (mode === 'cowork') assert.equal(uri, 'data:image/png;base64,' + bytes.toString('base64'));
    const marker = 'Browser image delivery verified.';
    // A transient stream bubble is not completion. Require the actual native
    // conversation store to acknowledge the final message before inspecting
    // its stable rendered view; do not dismiss a lost answer as a screenshot race.
    const savedReply = mode === 'chat' ? page.waitForResponse(response => {
      if (!response.url().endsWith('/api/store') || response.request().method() !== 'POST') return false;
      const body = response.request().postDataJSON();
      return body?.chats?.some(chat => chat.messages?.some(message =>
        message.role === 'assistant' && message.content === marker &&
        !message.streaming && message.finishReason === 'stop'));
    }, {timeout: 10000}) : null;
    // Keep a missing durable acknowledgement in this case's failure receipt,
    // without allowing an unhandled rejection while checking the stream.
    savedReply?.catch(() => {});
    answer(pixelRequest, {text: marker});
    await page.locator(mode === 'chat' ? '.msg--assistant .md' : '#agent-view').filter({hasText: marker}).waitFor({timeout: 10000});
    if (savedReply) {
      const response = await savedReply; assert.equal(response.status(), 200);
      row.savedConversation = await (await page.request.get(base + '/api/store')).json();
      assert(row.savedConversation.data?.chats?.some(chat => chat.messages?.some(message =>
        message.role === 'assistant' && message.content === marker && !message.streaming)),
      'The final reply must exist in the native conversation store');
    }
    await idle();
    assert.equal(await page.locator(mode === 'chat' ? '.msg--assistant .md' : '#agent-view').filter({hasText: marker}).isVisible(), true,
      'The committed response must remain visible after completion');
    row.after = await state(); assert.equal(row.after.residentPid, resident);
    row.screenshot = path.join(run, `browser-${mode}-${name}-${theme}.png`);
    await page.screenshot({path: row.screenshot, fullPage: true});
    assert.deepEqual(errors, [], 'Browser console must remain clean');
  } catch (error) {
    row.browserErrors = errors;
    row.failureState = await state().catch(() => null);
    row.failureStorage = await page.evaluate(() => ({
      chats: JSON.parse(localStorage.getItem('ds4web.chats.v2') || 'null'),
      active: JSON.parse(localStorage.getItem('ds4web.active.v2') || 'null'),
    })).catch(() => null);
    fs.writeFileSync(path.join(run, `browser-${mode}-failure.txt`), await page.locator('body').innerText().catch(() => 'unavailable'));
    await page.screenshot({path: path.join(run, `browser-${mode}-failure.png`), fullPage: true}).catch(() => {});
    throw error;
  } finally {await browser.close();}
}

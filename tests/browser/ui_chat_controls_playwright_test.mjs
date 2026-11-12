// Production Chat controls in a real browser. Every engine reply below is
// SIMULATED (authored SSE/JSON in the framing of the pinned ds4-server and
// llama-server); no model runs. Clipboard writes are stubbed.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium, webkit, firefox } from 'playwright';
import { uiMockServer, jsonReply, requestBody, seedUi, sseDelta, sseDone } from '../support/ui_mock_server.mjs';

const browserName = process.env.DSTUDIO_TEST_BROWSER || 'chromium';
assert.ok(['chromium', 'webkit', 'firefox'].includes(browserName));
const requests = [], held = [];
let behavior = 'hold';
// Context refusals exactly as the pinned engines word them: ds4-server
// (http_error_context_length_exceeded) and llama-server (exceed_context_size_error).
const DS4_CONTEXT_REFUSAL = { error: { message: 'Prompt has 70412 tokens, but the configured context size is 65536 tokens',
  type: 'invalid_request_error', param: 'messages', code: 'context_length_exceeded', n_prompt_tokens: 70412, n_ctx: 65536 } };
const LLAMA_CONTEXT_REFUSAL = { error: { code: 400, message: 'the request exceeds the available context size, try increasing it',
  type: 'exceed_context_size_error', n_prompt_tokens: 70412, n_ctx: 65536 } };
const LENGTH_TEXT = 'The first half of a long answer, cut by max_tokens', CUT_TEXT = 'Text streamed before the connection ended';
const GENERATED_FILE = { filename: 'release-notes.md', mime: 'text/markdown', content: '# Release notes\n\n- Città: è salvato 🙂\n- Second line\n' };
// One chunk in ds4-server's chat framing (sse_chat_finish): id, object, model.
const ds4Chunk = (res, delta, finish = null) => res.write(`data: ${JSON.stringify({ id: 'chatcmpl-fixture', object: 'chat.completion.chunk',
  created: 1767225600, model: 'deepseek-v4-flash', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
const server = await uiMockServer(async (req, res, url) => {
  if (url.pathname !== '/v1/chat/completions') return false;
  requests.push(await requestBody(req));
  if (behavior === 'error') { jsonReply(res, { error: { message: 'Simulated engine failure.' } }, 500); return true; }
  if (behavior === 'context-ds4') { jsonReply(res, DS4_CONTEXT_REFUSAL, 400); return true; }
  if (behavior === 'context-llama') { jsonReply(res, LLAMA_CONTEXT_REFUSAL, 400); return true; }
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  if (behavior === 'hold') { sseDelta(res, 'Retained partial answer.\n\n'); held.push(res); }
  else if (behavior === 'length') {
    // The engine stops at max_tokens: a finish_reason "length" chunk, then [DONE].
    ds4Chunk(res, { content: LENGTH_TEXT }); ds4Chunk(res, {}, 'length'); res.end('data: [DONE]\n\n');
  } else if (behavior === 'cut') { ds4Chunk(res, { content: CUT_TEXT }); res.end(); }
  else if (behavior === 'file') {
    // The answer carries the file in the app's dstudio-files fence, split across chunks.
    const fence = '```dstudio-files\n' + JSON.stringify({ files: [GENERATED_FILE] }) + '\n```';
    ds4Chunk(res, { content: 'Here is the file you asked for.\n\n' });
    ds4Chunk(res, { content: fence.slice(0, 40) }); ds4Chunk(res, { content: fence.slice(40) });
    ds4Chunk(res, {}, 'stop'); res.end('data: [DONE]\n\n');
  } else { sseDelta(res, `Complete simulated answer ${requests.length}.`); sseDone(res); }
  return true;
});
fs.mkdirSync('tests/.artifacts/chat-controls', { recursive: true });
const dir = fs.mkdtempSync(`tests/.artifacts/chat-controls/${browserName}-`);
const receipt = { scope: 'Production Chat controls in a real browser; all generation and clipboard writes simulated', browserName, cases: [] };
const browser = await ({ chromium, webkit, firefox })[browserName].launch();
const page = await browser.newPage({ viewport: { width: 1100, height: 820 } });
page.setDefaultTimeout(5000);
const evidence = await seedUi(page, server.origin);
await page.addInitScript(origin => {
  if (window !== window.top || location.origin !== origin) return;
  window.copiedText = [];
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => window.copiedText.push(text) } });
}, server.origin);
const last = page.locator('.msg--assistant').last();
const saved = (target = page) => target.evaluate(() => {
  const id = JSON.parse(localStorage.getItem('ds4web.active.v2')).ids.chat;
  return JSON.parse(localStorage.getItem('ds4web.chats.v2')).chats.find(chat => chat.id === id);
});
const checkpoint = async (name, target = page) => {
  receipt.cases.push({ name, status: 'PASS' });
  await target.screenshot({ path: path.join(dir, `${receipt.cases.length}.png`) });
};
try {
  await page.goto(server.origin);
  await page.locator('#composer-input').fill('Keyboard submission.');
  await page.locator('#composer-input').press('Enter');
  await last.locator('.md').filter({ hasText: 'Retained partial answer.' }).waitFor();
  await page.locator('#btn-stop').click();
  await page.locator('#btn-stop').waitFor({ state: 'hidden' });
  assert.equal((await saved()).messages.at(-1).content.trim(), 'Retained partial answer.');
  assert.equal((await saved()).messages.at(-1).finishReason, 'aborted');
  await last.getByRole('button', { name: 'Copy', exact: true }).click();
  assert.equal(await page.evaluate(() => window.copiedText.at(-1)), (await saved()).messages.at(-1).content);
  await checkpoint('Enter, Stop and exact copy preserve streamed text');

  behavior = 'complete';
  await last.getByRole('button', { name: 'Regenerate', exact: true }).click();
  await last.locator('.md').filter({ hasText: 'Complete simulated answer 2.' }).waitFor();
  await page.locator('#btn-stop').waitFor({ state: 'hidden' });
  assert.equal((await saved()).messages.length, 2, 'regeneration replaces only the last answer');
  await checkpoint('Regenerate reuses the user turn');

  await page.getByRole('button', { name: 'Edit message', exact: true }).click();
  await page.locator('.msg-edit__input').fill('Draft edit to cancel.');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal((await saved()).messages[0].content, 'Keyboard submission.');
  await page.getByRole('button', { name: 'Edit message', exact: true }).click();
  await page.locator('.msg-edit__input').fill('Edited user question.');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await last.locator('.md').filter({ hasText: 'Complete simulated answer 3.' }).waitFor();
  await page.locator('#btn-stop').waitFor({ state: 'hidden' });
  assert.equal((await saved()).messages[0].content, 'Edited user question.');
  assert.equal(requests.at(-1).messages.at(-1).content, 'Edited user question.');
  assert.equal((await saved()).messages.length, 2);
  await checkpoint('Edit cancel/save and regenerated request match persisted text');

  behavior = 'error';
  await last.getByRole('button', { name: 'Regenerate', exact: true }).click();
  await last.getByRole('button', { name: 'Retry', exact: true }).waitFor();
  assert.equal((await saved()).messages.at(-1).finishReason, 'error');
  assert.match(await last.textContent(), /Simulated engine failure/);
  behavior = 'complete';
  await last.getByRole('button', { name: 'Retry', exact: true }).click();
  await last.locator('.md').filter({ hasText: 'Complete simulated answer 5.' }).waitFor();
  await page.locator('#btn-stop').waitFor({ state: 'hidden' });
  assert.equal((await saved()).messages.length, 2);
  await checkpoint('Engine failure is visible and Retry produces a new answer');

  const existingId = (await saved()).id;
  behavior = 'hold';
  await page.locator('#composer-input').fill('Background response.');
  await page.locator('#btn-send').click();
  await last.locator('.md').filter({ hasText: 'Retained partial answer.' }).waitFor();
  await page.locator('#btn-new-chat').click();
  assert.notEqual((await saved()).id, existingId);
  assert.equal(await page.locator('.msg--assistant').count(), 0);
  await page.locator(`#chat-list [data-id="${existingId}"]`).click();
  await last.locator('.md').filter({ hasText: 'Retained partial answer.' }).waitFor();
  await page.locator('#btn-stop').click();
  await page.locator('#btn-stop').waitFor({ state: 'hidden' });
  assert.equal((await saved()).messages.at(-1).content.trim(), 'Retained partial answer.');
  await checkpoint('New chat and return preserve the background response owner');

  // Exercise the actual local-store wire shape and the production merge path,
  // rather than proving only the browser-local copy survives a reload.
  const retained = await saved();
  const until = Date.now() + 5000;
  while (Date.now() < until && JSON.stringify(server.storeSnapshot().data?.chats?.find(chat => chat.id === existingId)) !== JSON.stringify(retained))
    await new Promise(resolve => setTimeout(resolve, 25));
  const remote = server.storeSnapshot();
  assert.equal(typeof remote.data, 'object', 'the native host returns the stored JSON object');
  assert.deepEqual(remote.data.chats.find(chat => chat.id === existingId), retained, 'the produced persistence request retains the complete conversation');
  const restoredPage = await browser.newPage({ viewport: { width: 1100, height: 820 } });
  const restoredEvidence = await seedUi(restoredPage, server.origin, { chats: [] });
  await restoredPage.goto(server.origin);
  await restoredPage.locator(`#chat-list [data-id="${existingId}"]`).waitFor();
  await restoredPage.locator('.msg--assistant .md').filter({ hasText: 'Retained partial answer.' }).last().waitFor();
  assert.deepEqual(await saved(restoredPage), retained, 'the production host-store merge restores the conversation when browser-local history is absent');
  assert.deepEqual(restoredEvidence.errors, []); assert.deepEqual(restoredEvidence.external, []);
  await checkpoint('Host persistence round-trip restores the complete conversation', restoredPage);
  await restoredPage.close();

  // ---- Boundaries and failures, on a fresh conversation of the same page ----
  const announced = () => page.locator('#sr-status').textContent();
  const send = async text => { await page.locator('#composer-input').fill(text); await page.locator('#btn-send').click(); };
  const settled = () => page.locator('#btn-stop').waitFor({ state: 'hidden' });
  await page.locator('#btn-new-chat').click();
  const boundaryId = (await saved()).id;
  const requestsBeforeEmpty = requests.length;
  for (const draft of ['', '   ', ' \n\t \n ']) {
    await page.locator('#composer-input').fill(draft);
    await page.locator('#btn-send').click();
    await page.locator('#composer-input').press('Enter');
  }
  // The next real send is the barrier: it must be the only request and the
  // only turn, so none of the six empty submissions produced either.
  behavior = 'complete';
  await send('First real question.');
  await last.locator('.md').filter({ hasText: `Complete simulated answer ${requestsBeforeEmpty + 1}.` }).waitFor();
  await settled();
  assert.equal(requests.length, requestsBeforeEmpty + 1, 'empty or whitespace-only composers send nothing');
  assert.equal(requests.at(-1).messages.at(-1).content, 'First real question.');
  assert.deepEqual((await saved()).messages.map(m => [m.role, m.content]),
    [['user', 'First real question.'], ['assistant', `Complete simulated answer ${requestsBeforeEmpty + 1}.`]]);
  assert.equal((await saved()).id, boundaryId);
  await checkpoint('Send with an empty or whitespace-only composer sends and saves nothing');

  const continueFrom = async (retainedText, marker, finishReason, announcement) => {
    await last.locator('.msg__meta').filter({ hasText: marker }).waitFor();
    await settled();
    const cut = (await saved()).messages.at(-1);
    assert.equal(cut.finishReason, finishReason); assert.equal(cut.content, retainedText);
    assert.equal(await last.locator('.md').first().textContent(), retainedText, 'the cut answer stays visible');
    assert.equal(await announced(), announcement, 'the live region does not announce a cut answer as complete');
    behavior = 'complete';
    const question = (await saved()).messages.at(-2).content, count = (await saved()).messages.length;
    await last.getByRole('button', { name: 'Continue', exact: true }).click();
    await last.locator('.md').filter({ hasText: `Complete simulated answer ${requests.length + 1}.` }).waitFor();
    await settled();
    // Continue resumes from the retained text: the model receives it verbatim
    // as the previous assistant turn, followed by the continuation request.
    assert.deepEqual(requests.at(-1).messages.slice(-3), [
      { role: 'user', content: question }, { role: 'assistant', content: retainedText }, { role: 'user', content: 'Continue.' }]);
    const after = await saved();
    assert.equal(after.messages.length, count + 2);
    assert.deepEqual(after.messages[count - 1], cut, 'the cut answer is kept unchanged');
    assert.equal(after.messages.at(-1).finishReason, 'stop');
    assert.equal(await announced(), 'Response completed');
  };
  behavior = 'length';
  await send('Explain everything in detail.');
  await continueFrom(LENGTH_TEXT, 'Response truncated (token limit)', 'length', 'Response truncated (token limit)');
  await checkpoint('Output-token limit marks the answer as cut off and Continue resumes from its text');
  behavior = 'cut';
  await send('Explain the second part.');
  await continueFrom(CUT_TEXT, 'Response incomplete: stream ended before data: [DONE].', 'incomplete', 'Response incomplete');
  await checkpoint('A stream ended early is marked incomplete and Continue resumes from its text');

  const beforeRefusal = await saved();
  behavior = 'context-ds4';
  await send('One more question about all of the above.');
  await last.getByRole('button', { name: 'Retry', exact: true }).waitFor();
  await settled();
  let refused = await saved();
  assert.deepEqual(refused.messages.slice(0, beforeRefusal.messages.length), beforeRefusal.messages, 'no earlier message is trimmed or changed');
  assert.equal(refused.messages.length, beforeRefusal.messages.length + 2);
  assert.equal(refused.messages.at(-2).content, 'One more question about all of the above.');
  assert.equal(refused.messages.at(-1).finishReason, 'error');
  assert.equal(refused.messages.at(-1).error.message, DS4_CONTEXT_REFUSAL.error.message);
  assert.match(await last.locator('.msg__meta').textContent(), /Prompt has 70412 tokens, but the configured context size is 65536 tokens/);
  assert.equal(await announced(), 'Response failed');
  // The refused request carried the whole conversation: nothing was dropped
  // to make it fit before the engine refused it.
  assert.deepEqual(requests.at(-1).messages.filter(m => m.role !== 'system'),
    refused.messages.slice(0, -1).map(m => ({ role: m.role, content: m.content })));
  behavior = 'context-llama';
  await last.getByRole('button', { name: 'Retry', exact: true }).click();
  await last.locator('.msg__meta').filter({ hasText: LLAMA_CONTEXT_REFUSAL.error.message }).waitFor();
  await settled();
  refused = await saved();
  assert.deepEqual(refused.messages.slice(0, beforeRefusal.messages.length + 1), [...beforeRefusal.messages, refused.messages.at(-2)]);
  assert.equal(refused.messages.length, beforeRefusal.messages.length + 2);
  assert.equal(refused.messages.at(-1).error.message, LLAMA_CONTEXT_REFUSAL.error.message);
  assert.ok(await last.getByRole('button', { name: 'Retry', exact: true }).isVisible());
  await checkpoint('A context-size refusal (ds4 and llama.cpp wording) is shown with Retry and keeps every message');

  // Delete the earlier, non-active conversation from the sidebar menu.
  const history = () => page.evaluate(() => JSON.parse(localStorage.getItem('ds4web.chats.v2')));
  const kept = (await history()).chats.filter(chat => chat.id !== existingId);
  assert.ok(kept.some(chat => chat.id === boundaryId));
  await page.locator(`#chat-list [data-id="${existingId}"]`).hover(); // the row action appears on hover
  await page.locator(`#chat-list [data-id="${existingId}"] .chat-item__more`).click();
  await page.getByRole('menuitem', { name: 'Delete', exact: true }).click();
  await page.locator(`#chat-list [data-id="${existingId}"]`).waitFor({ state: 'detached' });
  const afterDelete = await history();
  assert.ok(!afterDelete.chats.some(chat => chat.id === existingId));
  assert.ok(afterDelete.deleted.some(tomb => tomb.id === existingId), 'a tombstone records the delete');
  assert.deepEqual(afterDelete.chats.filter(chat => !chat.lanMirror), kept, 'every other conversation is unchanged');
  assert.equal((await saved()).id, boundaryId, 'the active conversation stays selected');
  const deleteUntil = Date.now() + 5000;
  while (Date.now() < deleteUntil && server.storeSnapshot().data?.chats?.some(chat => chat.id === existingId))
    await new Promise(resolve => setTimeout(resolve, 25));
  const hostAfterDelete = server.storeSnapshot().data;
  assert.ok(!hostAfterDelete.chats.some(chat => chat.id === existingId), 'the host history no longer holds it');
  assert.ok(hostAfterDelete.deleted.some(tomb => tomb.id === existingId));
  await page.reload();
  await page.locator(`#chat-list [data-id="${boundaryId}"]`).waitFor();
  assert.equal(await page.locator(`#chat-list [data-id="${existingId}"]`).count(), 0, 'a reload does not bring it back');
  assert.ok(!(await history()).chats.some(chat => chat.id === existingId));
  await checkpoint('Deleting one conversation removes it from history, the host store and after a reload');

  // A file artifact, last: closing its canvas reflows the transcript.
  behavior = 'file';
  await send('Write the release notes as a Markdown file I can download.');
  const tile = last.locator('.msg-generated-files .msg-attachment').filter({ hasText: GENERATED_FILE.filename });
  await tile.waitFor();
  await settled();
  const canvas = page.locator('#artifact-canvas.open');
  await canvas.waitFor();
  assert.equal(await page.locator('#artifact-canvas-title').textContent(), GENERATED_FILE.filename);
  assert.equal(await page.locator('#artifact-canvas-content h1').textContent(), 'Release notes');
  assert.match(await page.locator('#artifact-canvas-content').textContent(), /Città: è salvato 🙂/);
  assert.doesNotMatch(await last.locator('.md').first().textContent(), /dstudio-files|"files"/, 'the file payload is not shown as answer text');
  const withFile = (await saved()).messages.at(-1);
  assert.equal(withFile.content, 'Here is the file you asked for.');
  assert.deepEqual(withFile.generatedFiles, [{ ...GENERATED_FILE, size: Buffer.byteLength(GENERATED_FILE.content) }]);
  await page.locator('#artifact-canvas-close').click();
  await canvas.waitFor({ state: 'detached' });
  await tile.click();
  await canvas.waitFor();
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#artifact-canvas-download').click()]);
  assert.equal(download.suggestedFilename(), GENERATED_FILE.filename);
  assert.equal(fs.readFileSync(await download.path(), 'utf8'), GENERATED_FILE.content, 'the downloaded file has the exact bytes');
  // The saved file artifact still opens after a reload.
  await page.reload();
  await tile.click();
  await canvas.waitFor();
  assert.equal(await page.locator('#artifact-canvas-title').textContent(), GENERATED_FILE.filename);
  assert.match(await page.locator('#artifact-canvas-content').textContent(), /Second line/);
  await page.locator('#artifact-canvas-close').click();
  await canvas.waitFor({ state: 'detached' });
  await checkpoint('A generated file is shown as a file artifact that opens, previews and downloads exactly');

  assert.deepEqual(evidence.errors, []); assert.deepEqual(evidence.external, []); assert.deepEqual(server.missing, []);
} catch (error) {
  receipt.cases.push({ status: 'FAIL', error: error.stack, ...evidence, missing: server.missing });
  await page.screenshot({ path: path.join(dir, 'failure.png') });
  throw error;
} finally {
  receipt.requests = requests;
  fs.writeFileSync(path.join(dir, 'receipt.json'), JSON.stringify(receipt, null, 2));
  held.forEach(res => res.destroy()); await browser.close(); server.close();
  console.log(`Chat control evidence: ${dir}`);
}

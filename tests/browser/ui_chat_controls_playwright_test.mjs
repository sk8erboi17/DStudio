import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium, webkit } from 'playwright';
import { uiMockServer, jsonReply, requestBody, seedUi, sseDelta, sseDone } from '../support/ui_mock_server.mjs';

const browserName = process.env.DSTUDIO_TEST_BROWSER || 'chromium';
assert.ok(['chromium', 'webkit'].includes(browserName));
const requests = [], held = [];
let behavior = 'hold';
const server = await uiMockServer(async (req, res, url) => {
  if (url.pathname !== '/v1/chat/completions') return false;
  requests.push(await requestBody(req));
  if (behavior === 'error') { jsonReply(res, { error: { message: 'Simulated engine failure.' } }, 500); return true; }
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  if (behavior === 'hold') { sseDelta(res, 'Retained partial answer.\n\n'); held.push(res); }
  else { sseDelta(res, `Complete simulated answer ${requests.length}.`); sseDone(res); }
  return true;
});
fs.mkdirSync('tests/.artifacts/chat-controls', { recursive: true });
const dir = fs.mkdtempSync(`tests/.artifacts/chat-controls/${browserName}-`);
const receipt = { scope: 'Production Chat controls in a real browser; all generation and clipboard writes simulated', browserName, cases: [] };
const browser = await ({ chromium, webkit })[browserName].launch();
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

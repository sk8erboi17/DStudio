// The production UI opened from the web the way another device on the LAN
// opens it: plain http on a non-loopback name, which browsers treat as an
// insecure context (no crypto.randomUUID, no navigator.clipboard). Real
// Chromium, WebKit or Firefox; the browser reaches the simulated host through
// a proxy, so http://dstudio.test is a real non-secure origin. Generation is
// SIMULATED; no model.
//   DSTUDIO_TEST_BROWSER=chromium|webkit|firefox node tests/browser/ui_insecure_origin_playwright_test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium, webkit, firefox } from 'playwright';
import { uiMockServer, requestBody, seedUi, sseDelta, sseDone } from '../support/ui_mock_server.mjs';

const browserName = process.env.DSTUDIO_TEST_BROWSER || 'chromium';
assert.ok(['chromium', 'webkit', 'firefox'].includes(browserName));
const requests = [], held = [];
let behavior = 'hold';
const server = await uiMockServer(async (req, res, url) => {
  if (url.pathname !== '/v1/chat/completions') return false;
  requests.push(await requestBody(req));
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  if (behavior === 'hold') { sseDelta(res, 'First part of a streamed answer. '); held.push(res); }
  else { sseDelta(res, `Complete answer ${requests.length}.`); sseDone(res); }
  return true;
});
const port = new URL(server.origin).port;
const origin = `http://dstudio.test:${port}`;
fs.mkdirSync('tests/.artifacts/insecure-origin', { recursive: true });
const dir = fs.mkdtempSync(`tests/.artifacts/insecure-origin/${browserName}-`);
const receipt = { scope: 'Production UI on a non-secure http origin in a real browser; generation simulated', browserName, origin, cases: [] };
const browser = await ({ chromium, webkit, firefox })[browserName].launch({ proxy: { server: server.origin } });
const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
page.setDefaultTimeout(8000);
const evidence = await seedUi(page, origin);
const last = page.locator('.msg--assistant').last();
const checkpoint = async (name) => {
  receipt.cases.push({ name, status: 'PASS' });
  await page.screenshot({ path: path.join(dir, `${receipt.cases.length}.png`) });
};
try {
  await page.goto(origin);
  const context = await page.evaluate(() => ({ secure: window.isSecureContext, uuid: typeof crypto.randomUUID,
    clipboard: typeof navigator.clipboard }));
  assert.deepEqual(context, { secure: false, uuid: 'undefined', clipboard: 'undefined' }, 'the condition under test');
  await checkpoint('the page loads as a non-secure origin, without randomUUID or the clipboard API');

  await page.locator('#composer-input').fill('A question from another device.');
  await page.locator('#composer-input').press('Enter');
  await last.locator('.md').filter({ hasText: 'First part of a streamed answer.' }).waitFor();
  held.shift().end(`data: ${JSON.stringify({ choices: [{ delta: { content: 'And the rest.' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
  await last.locator('.md').filter({ hasText: 'And the rest.' }).waitFor();
  await page.locator('#btn-stop').waitFor({ state: 'hidden' });
  assert.equal(requests.length, 1);
  await checkpoint('a Chat turn starts and streams (its turn id needs no secure context)');

  await last.getByRole('button', { name: 'Copy', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.msg--assistant:last-of-type .is-copied, .msg--assistant .is-copied') !== null
    || [...document.querySelectorAll('.toast')].some((t) => /Copy failed/.test(t.textContent)));
  assert.ok(!(await page.locator('.toast', { hasText: 'Copy failed' }).count()), 'the copy fallback works without the clipboard API');
  await checkpoint('Copy works through the fallback');

  behavior = 'complete';
  await last.getByRole('button', { name: 'Regenerate', exact: true }).click();
  await last.locator('.md').filter({ hasText: 'Complete answer 2.' }).waitFor();
  await page.locator('#btn-stop').waitFor({ state: 'hidden' });
  await checkpoint('Regenerate works');

  assert.deepEqual(evidence.errors, [], 'no page errors');
  assert.deepEqual(evidence.external, [], 'no request leaves the page origin');
  receipt.passed = true;
} catch (error) {
  receipt.passed = false; receipt.error = String(error.stack || error); receipt.pageErrors = evidence.errors;
  await page.screenshot({ path: path.join(dir, 'failure.png') }).catch(() => {});
  process.exitCode = 1;
} finally {
  fs.writeFileSync(path.join(dir, 'receipt.json'), JSON.stringify(receipt, null, 2));
  for (const res of held) res.destroy();
  await browser.close(); server.close();
  console.log(`ui_insecure_origin (${browserName}, simulated generation): ${receipt.passed ? 'ok' : 'FAIL'} ${receipt.cases.length} checks; ${dir}`);
  if (receipt.error) console.log(receipt.error);
}

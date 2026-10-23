// Cowork on the LAN through the production UI on both sides: the host's
// Settings shares its running Cowork session; a second browser opens the LAN
// shell from this machine's LAN address, pairs with the code shown on the
// host, sends a prompt and reads the answer. Real native host and real Cowork
// runtime; the model is a SIMULATED OpenAI-compatible server.
//   DSTUDIO_TEST_BROWSER=chromium|webkit node tests/browser/ui_lan_cowork_playwright_test.mjs <dstudio-server-test> <ds4 dir>
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chromium, webkit } from 'playwright';
import { freePort, sleep } from '../support/real_harness.mjs';
import { seedUi } from '../support/ui_mock_server.mjs';

const browserName = process.env.DSTUDIO_TEST_BROWSER || 'chromium';
const server = path.resolve(process.argv[2] || 'tests/.build/dstudio-server-test');
const engine = path.resolve(process.argv[3] || 'ds4');
assert.ok(fs.existsSync(path.join(engine, 'ds4-cowork')), `${engine}/ds4-cowork is required; missing is not a pass`);
fs.mkdirSync('tests/.artifacts/ui-lan-cowork', { recursive: true });
const run = fs.mkdtempSync(path.resolve(`tests/.artifacts/ui-lan-cowork/${browserName}-`));
const shared = path.join(run, 'Quarterly notes');
fs.mkdirSync(shared);
const receipt = { scope: 'Production UI, real host and Cowork runtime over the LAN address; simulated model', browserName, checks: [] };

const model = http.createServer(async (req, res) => {
  for await (const _ of req) { /* drain */ }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const chunk = (delta, finish) => `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  res.write(chunk({ role: 'assistant', content: 'The shared folder has your quarterly notes.' }, null));
  res.end(chunk({}, 'stop') + 'data: [DONE]\n\n');
});
model.listen(0, '127.0.0.1'); await once(model, 'listening');
const port = await freePort();
const log = fs.openSync(path.join(run, 'host.log'), 'w');
const host = spawn(server, [String(port), engine], { stdio: ['ignore', log, log], env: { ...process.env,
  DS4UI_TEST_MODE: '1', DS4UI_NO_WINDOW: '1', DS4UI_PAGE_FROM_DISK: '1', DS4UI_DATA_DIR: path.join(run, 'data'), HOME: path.join(run, 'home') } });
fs.closeSync(log);
const api = async (p, body) => {
  const r = await fetch(`http://127.0.0.1:${port}${p}`, body ? { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'ds4web' }, body: JSON.stringify(body) } : {});
  return r.json();
};
let browser, hostPageRef, devicePageRef;
const step = async (name, page) => { receipt.checks.push(name); await page.screenshot({ path: path.join(run, `${receipt.checks.length}.png`) }); };
try {
  for (let i = 0; i < 100; i++) { try { await api('/api/status'); break; } catch { await sleep(100); } }
  const lan = await api('/api/lan', { enable: true });
  const lanIp = String(lan.lanAddr || '').replace(/:\d+$/, '');
  if (!lan.lan || !lanIp) throw Object.assign(new Error('LAN could not be enabled on this machine'), { blocked: true });
  // The host user has Cowork running in the folder (started through the API here).
  const started = await api('/api/start', { mode: 'cowork', modelBackend: 'remote', remoteBaseUrl: `http://127.0.0.1:${model.address().port}`,
    remoteModel: 'fixture', workdir: shared, variant: 'flash' });
  assert.ok(started.ok, JSON.stringify(started));
  for (let i = 0; i < 80 && !(await api('/api/status')).ready; i++) await sleep(250);

  browser = await ({ chromium, webkit })[browserName].launch();
  const hostOrigin = `http://127.0.0.1:${port}`, deviceOrigin = `http://${lanIp}:${port}`;
  const hostPage = await (await browser.newContext({ viewport: { width: 1200, height: 860 } })).newPage();
  hostPageRef = hostPage;
  const hostEvidence = await seedUi(hostPage, hostOrigin);
  await hostPage.goto(hostOrigin);
  // The isolated engine folder has no chat model, so the System check opens
  // on its own; close it as a user would.
  await hostPage.locator('#doctor-dialog[open]').waitFor({ timeout: 5000 }).catch(() => {});
  if (await hostPage.locator('#doctor-dialog[open]').count()) await hostPage.locator('#doctor-close').click();
  await hostPage.locator('#btn-settings').click();
  await hostPage.locator('.set-nav__b[data-pane="network"]').click();
  await hostPage.locator('#set-lan-cowork').waitFor();
  await hostPage.locator('#set-lan-cowork-share').click();
  await hostPage.locator('#set-lan-cowork-msg', { hasText: 'Pairing code' }).waitFor();
  const code = (await hostPage.locator('#set-lan-cowork-msg').innerText()).match(/Pairing code (\d{8})/)[1];
  assert.match(await hostPage.locator('#set-lan-cowork-msg').innerText(), /Sharing “Quarterly notes”/);
  await step('the host shares its running Cowork folder and shows a code', hostPage);

  // Another device: a separate browser profile on the LAN address.
  const device = await (await browser.newContext({ viewport: { width: 1000, height: 860 } })).newPage();
  devicePageRef = device;
  const deviceEvidence = await seedUi(device, deviceOrigin);
  await device.goto(deviceOrigin);
  await device.locator('#tab-cowork').click();
  await device.locator('#lan-pair-dialog').waitFor({ state: 'visible' });
  await device.locator('#lan-pair-code').fill('00000000' === code ? '11111111' : '00000000');
  await device.locator('#lan-pair-go').click();
  await device.locator('#lan-pair-msg', { hasText: 'Wrong code' }).waitFor();
  await device.locator('#lan-pair-code').fill(code);
  await device.locator('#lan-pair-go').click();
  await device.locator('#lan-pair-dialog').waitFor({ state: 'hidden' });
  await device.locator('#agent-view').waitFor({ state: 'visible' });
  await step('the device pairs (a wrong code is refused) and enters the shared Cowork view', device);

  await device.locator('#composer-input').fill('What is in the shared folder?');
  await device.locator('#composer-input').press('Enter');
  await device.locator('#agent-view', { hasText: 'The shared folder has your quarterly notes.' }).waitFor({ timeout: 30000 });
  await step('the device sends a prompt and reads the answer of the host session', device);

  // The host reopens Settings: the paired device is listed and can be revoked.
  await hostPage.keyboard.press('Escape');
  await hostPage.locator('#settings-dialog').waitFor({ state: 'hidden' });
  await hostPage.locator('#btn-settings').click();
  await hostPage.locator('.set-nav__b[data-pane="network"]').click();
  await hostPage.locator('#set-lan-cowork-devices li').first().waitFor();
  assert.equal(await hostPage.locator('#set-lan-cowork-devices li').count(), 1);
  await step('the host lists the paired device', hostPage);
  await hostPage.locator('#set-lan-cowork-devices li button', { hasText: 'Revoke' }).click();
  await hostPage.locator('#set-lan-cowork-devices li').first().waitFor({ state: 'detached' });
  assert.deepEqual((await api('/api/lan/cowork')).devices, []);
  const token = await device.evaluate(() => localStorage.getItem('dstudio.lanCoworkToken'));
  assert.equal((await fetch(`${deviceOrigin}/api/lan/cowork/status`, { headers: { authorization: `Bearer ${token}` } })).status, 403,
    'a revoked token opens nothing');
  await step('revoking ends the device access', hostPage);
  assert.deepEqual(deviceEvidence.errors, [], 'no page errors on the device');
  assert.deepEqual(hostEvidence.errors, [], 'no page errors on the host');
  assert.deepEqual([...deviceEvidence.external, ...hostEvidence.external], [], 'no request leaves the two origins');
  receipt.passed = true;
} catch (error) {
  receipt.passed = false;
  receipt.error = String(error.stack || error);
  receipt.status = error.blocked ? 'BLOCKED' : 'FAIL';
  process.exitCode = 1;
  await hostPageRef?.screenshot({ path: path.join(run, 'failure-host.png') }).catch(() => {});
  await devicePageRef?.screenshot({ path: path.join(run, 'failure-device.png') }).catch(() => {});
} finally {
  await browser?.close();
  host.kill('SIGTERM'); model.close();
  fs.writeFileSync(path.join(run, 'receipt.json'), JSON.stringify(receipt, null, 2));
  if (receipt.error) console.log(receipt.error);
  console.log(`ui_lan_cowork (${browserName}; real host and runtime, simulated model): ${receipt.passed ? 'ok' : receipt.status} ${receipt.checks.length} checks; ${run}`);
}

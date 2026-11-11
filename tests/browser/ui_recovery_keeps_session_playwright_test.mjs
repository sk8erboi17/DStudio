// A page that loads while the host runs an Agent, Cowork or Design session
// must not "recover" the Chat engine: starting Chat would stop that session.
// Production page; the host and its engine are SIMULATED. The barrier holds
// every status reply until the Chat health probe has failed and the page has
// asked the host again, the order in which the automatic recovery used to
// start Chat before the page had learned what the host runs.
//   DSTUDIO_TEST_BROWSER=chromium|webkit node tests/browser/ui_recovery_keeps_session_playwright_test.mjs
import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';
import { jsonReply, requestBody, seedUi, uiMockServer } from '../support/ui_mock_server.mjs';

const browserName = process.env.DSTUDIO_TEST_BROWSER || 'chromium';
assert.ok(['chromium', 'webkit'].includes(browserName));
const results = [];

// `lostStatus` is how many status requests made after the failed probe get no
// answer (the connection is dropped), as when the host is too busy to reply:
// Infinity means the host never reports its state.
async function scenario(name, { hostMode, expectStart, lostStatus = 0 }) {
  const starts = [], held = [];
  let healthAnswered = false, released = false, statusAfterHealth = 0, lost = 0;
  const status = () => (hostMode === 'none'
    ? { mode: 'server', running: false, ready: false, loadPct: 0, stage: 'Stopped (simulated)' }
    : { mode: hostMode, running: true, ready: true, loadPct: 100, stage: 'Ready (simulated)', workdir: '/simulated/workspace' });
  const reply = (res) => jsonReply(res, { agentWorking: false, workdir: '', ds4dirOk: true, webdirOk: true, lan: false,
    modelFile: 'gguf/DeepSeek-V4-Flash-Vision-Exp-test.gguf', variant: 'flash', variants: { flash: true },
    config: { ctx: 65536, power: 100, think: 'off', ssdStreaming: 'auto' }, ...status() });
  const release = () => { released = true; for (const res of held.splice(0)) reply(res); };
  const mock = await uiMockServer(async (req, res, url) => {
    // No Chat server answers while another runtime (or nothing) owns the engine.
    if (url.pathname === '/v1/models') { jsonReply(res, { error: 'no chat engine (simulated)' }, 503); healthAnswered = true; return true; }
    if (url.pathname === '/api/status') {
      if (healthAnswered && lost < lostStatus) { lost++; if (!released) release(); res.destroy(); return true; }
      if (released) { reply(res); return true; }
      held.push(res);
      if (healthAnswered && ++statusAfterHealth >= 1) release();
      return true;
    }
    if (url.pathname === '/api/start' && req.method === 'POST') { starts.push(await requestBody(req)); jsonReply(res, { ok: true }); return true; }
    return false;
  });
  const browser = await ({ chromium, webkit })[browserName].launch();
  try {
    const page = await (await browser.newContext({ viewport: { width: 1200, height: 800 } })).newPage();
    const evidence = await seedUi(page, mock.origin);
    await page.goto(mock.origin);
    // The page asks the host again after the failed probe; if it never does,
    // release the held replies so that the outcome is still observed.
    for (let i = 0; i < 100 && !released; i++) await page.waitForTimeout(50);
    const barrierHeld = released;
    if (!released) release();
    // The page learns the host's mode from its periodic status read (every few
    // seconds); a dropped read is repeated by the next one.
    if (hostMode !== 'none' && lostStatus !== Infinity) await page.locator(`#tab-${hostMode}[aria-selected="true"]`).waitFor({ timeout: 30000 });
    if (lostStatus === Infinity) await page.locator('#doctor-dialog[open]').waitFor({ timeout: 20000 });
    if (expectStart) {
      for (let i = 0; i < 100 && !starts.length; i++) await page.waitForTimeout(50);
    } else {
      // Give a start request every chance to leave: several complete request
      // round trips of the page after it has seen the host's state.
      for (let i = 0; i < 8; i++) await page.evaluate(() => fetch('/api/storerev').then((r) => r.json()));
      await page.waitForTimeout(400);
    }
    assert.equal(barrierHeld, true, 'the page asked the host for its state after the failed Chat probe');
    if (expectStart) {
      assert.equal(starts.length, 1, 'with nothing running, the automatic recovery starts Chat once');
      assert.equal(starts[0].mode, 'server');
    } else {
      assert.deepEqual(starts, [], `no start request may be sent while the host runs ${hostMode}`);
      if (lostStatus === Infinity) assert.ok(lost >= 4, 'the state was asked for a bounded number of times before giving up');
      else assert.equal(await page.locator('#doctor-dialog[open]').count(), 0, 'no System check is raised for a session that is running');
      if (lostStatus && lostStatus !== Infinity) assert.equal(lost, lostStatus, 'the unanswered reads were retried');
    }
    assert.deepEqual(evidence.errors, [], 'no page error');
    assert.deepEqual(evidence.external, [], 'no external request');
    results.push(`pass: ${browserName}: ${name}`);
  } catch (error) {
    results.push(`fail: ${browserName}: ${name}: ${String(error.message).split('\n')[0]}`);
    process.exitCode = 1;
  } finally { await browser.close(); mock.close(); }
}

await scenario('a running Cowork session is not stopped by the page\'s Chat recovery', { hostMode: 'cowork', expectStart: false });
await scenario('a running Agent session is not stopped by the page\'s Chat recovery', { hostMode: 'agent', expectStart: false });
await scenario('a running Design session is not stopped by the page\'s Chat recovery', { hostMode: 'design', expectStart: false });
await scenario('with no runtime running, the recovery still starts Chat', { hostMode: 'none', expectStart: true });
await scenario('unanswered status reads are retried and the running session is then recognised', { hostMode: 'cowork', expectStart: false, lostStatus: 2 });
await scenario('a host that never reports its state gets no start request, and the System check opens', { hostMode: 'cowork', expectStart: false, lostStatus: Infinity });
for (const line of results) console.log(line);
console.log(`ui_recovery_keeps_session (${browserName}; production page, SIMULATED host): ${results.filter((line) => line.startsWith('pass')).length}/${results.length} passed`);

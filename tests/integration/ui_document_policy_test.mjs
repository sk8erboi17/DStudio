// Actual native HTTP document/policy, real browsers, simulated runtime only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { chromium, webkit } from 'playwright';
import { artifactRunDir, freePort, sleep } from '../support/real_harness.mjs';
import { uiMockServer, seedUi } from '../support/ui_mock_server.mjs';

const dir = artifactRunDir('ui-document-policy');
const binary = path.resolve(process.argv[2] || 'tests/.build/dstudio-server-test');
const engine = path.join(dir, 'empty-engine');
fs.mkdirSync(engine);
const port = await freePort(), origin = `http://127.0.0.1:${port}`;
const log = fs.openSync(path.join(dir, 'host.log'), 'wx');
const host = spawn(binary, [String(port), engine], { stdio: ['ignore', log, log],
  env: { ...process.env, DS4UI_TEST_MODE: '1', DS4UI_DEFER_ENGINE_START: '1',
    DS4UI_DATA_DIR: path.join(dir, 'profile'), DS4UI_HOST: '127.0.0.1' } });
fs.closeSync(log);
const exited = new Promise(resolve => { host.once('exit', resolve); host.once('error', resolve); });
const receipt = { scope: 'Actual native HTTP headers and bundled page; real WebKit/Chromium; all inference simulated',
  started: new Date().toISOString(), cases: [] };
let server;
try {
  let response;
  for (let i = 0; i < 80; i++) {
    try { response = await fetch(origin, { signal: AbortSignal.timeout(1000) }); if (response.ok) break; }
    catch { /* Isolated host is still opening its listener. */ }
    assert.equal(host.exitCode, null, 'native test host exited');
    await sleep(100);
  }
  assert.ok(response?.ok, 'native test host must serve the document');
  const document = { body: await response.text(), headers: Object.fromEntries(
    ['content-type', 'content-security-policy', 'x-content-type-options', 'referrer-policy', 'cache-control']
      .map(name => [name, response.headers.get(name)]).filter(([, value]) => value !== null)) };
  assert.ok(document.headers['content-security-policy'], 'actual HTTP document must carry a policy');
  const fixture = path.join(dir, 'document.json');
  fs.writeFileSync(fixture, JSON.stringify(document));
  receipt.documentSHA256 = crypto.createHash('sha256').update(document.body).digest('hex');
  receipt.headers = document.headers;
  const status = await fetch(origin + '/api/status').then(res => res.json());
  assert.equal(status.running, false, 'test must not start a real engine');
  server = await uiMockServer(() => false, { document });
  for (const browserName of ['webkit', 'chromium']) {
    const browser = await ({ webkit, chromium })[browserName].launch();
    const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
    page.setDefaultTimeout(5000);
    const evidence = await seedUi(page, server.origin);
    const console = [];
    page.on('console', message => console.push(message.text()));
    try {
      await page.goto(server.origin);
      await page.locator('#chat-file-input').setInputFiles('tests/fixtures/ui-images/image-1.png');
      await page.waitForFunction(() => document.querySelector('.composer__file[aria-busy="false"] .file-tile-icon img')?.naturalWidth > 0);
      await page.locator('.composer__file').click();
      await page.waitForFunction(() => document.querySelector('#image-viewer-meta').textContent.includes('652 × 1902'));
      await page.screenshot({ path: path.join(dir, `${browserName}-original.png`) });
      receipt.cases.push({ browserName, name: 'native HTTP policy permits local image preparation and original viewer', status: 'PASS' });
    } catch (error) {
      receipt.cases.push({ browserName, name: 'native HTTP policy permits local image preparation and original viewer',
        status: 'FAIL', error: error.stack, console });
      await page.screenshot({ path: path.join(dir, `${browserName}-failure.png`) });
    }
    try {
      const policy = await page.evaluate(async foreignOrigin => {
        const denied = async (create, directive) => new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`No violation for ${directive}`)), 3000);
          const handle = event => {
            if (!event.effectiveDirective.startsWith(directive)) return;
            document.removeEventListener('securitypolicyviolation', handle); clearTimeout(timer);
            resolve({ directive: event.effectiveDirective, blocked: event.blockedURI });
          };
          document.addEventListener('securitypolicyviolation', handle);
          create();
        });
        const scriptUrl = URL.createObjectURL(new Blob(['window.__forbiddenBlobScript = true'], { type: 'text/javascript' }));
        const script = await denied(() => {
          const element = document.createElement('script'); element.src = scriptUrl; document.body.append(element);
        }, 'script-src');
        URL.revokeObjectURL(scriptUrl);
        const frame = await denied(() => {
          const element = document.createElement('iframe'); element.src = foreignOrigin + '/foreign-frame'; document.body.append(element);
        }, 'frame-src');
        return { script, frame, executed: window.__forbiddenBlobScript === true };
      }, origin);
      assert.equal(policy.executed, false, 'allowing image blobs must not allow script blobs');
      assert.equal(policy.script.blocked, 'blob');
      assert.equal(new URL(policy.frame.blocked).origin, origin, 'a foreign frame must be denied before its request');
      assert.deepEqual(evidence.errors, []); assert.deepEqual(evidence.external, []);
      receipt.cases.push({ browserName, name: 'blob scripts and foreign frames remain blocked', status: 'PASS', policy });
    } catch (error) { receipt.cases.push({ browserName, name: 'blob scripts and foreign frames remain blocked', status: 'FAIL', error: error.stack }); }
    finally { await browser.close(); }
  }
  if (receipt.cases.every(row => row.status === 'PASS')) {
    for (const browserName of ['webkit', 'chromium']) {
      const output = fs.openSync(path.join(dir, `${browserName}-images.log`), 'wx');
      const child = spawn(process.execPath, ['tests/browser/ui_chat_images_playwright_test.mjs'], {
        stdio: ['ignore', output, output], env: { ...process.env,
          DSTUDIO_TEST_BROWSER: browserName, DSTUDIO_TEST_DOCUMENT_FIXTURE: fixture } });
      fs.closeSync(output);
      const exit = await new Promise(resolve => { child.once('exit', (code, signal) => resolve({ code, signal })); child.once('error', error => resolve({ error: error.message })); });
      receipt.cases.push({ browserName, name: 'complete image suite under actual native HTTP policy',
        status: exit.code === 0 ? 'PASS' : 'FAIL', ...exit });
    }
  }
  const after = await fetch(origin + '/api/status').then(res => res.json());
  assert.equal(after.running, false, 'actual host remained engine-free');
  assert.deepEqual(server.missing, []);
} catch (error) { receipt.cases.push({ name: 'harness', status: 'FAIL', error: error.stack }); }
finally {
  server?.close();
  if (host.exitCode === null && host.signalCode === null) host.kill('SIGTERM');
  await exited;
  receipt.ended = new Date().toISOString();
  fs.writeFileSync(path.join(dir, 'receipt.json'), JSON.stringify(receipt, null, 2));
}
for (const row of receipt.cases) console.log(`${row.browserName || 'host'} ${row.name}: ${row.status}`);
console.log(`Evidence: ${dir}`);
if (receipt.cases.some(row => row.status !== 'PASS')) process.exitCode = 1;

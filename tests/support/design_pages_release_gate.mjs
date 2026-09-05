#!/usr/bin/env node
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const site = path.resolve(process.argv[2] || '');
const caseId = String(process.argv[3] || '').trim();
const rawBase = String(process.argv[4] || '').trim();
const evidence = path.resolve(process.argv[5] ||
  path.join(path.dirname(site), `${path.basename(site)}.pages-evidence`));
const testMode = process.env.DSTUDIO_PAGES_TEST_MODE === '1';
const pagesPattern = /^https:\/\/[a-z0-9-]+\.github\.io\/[a-z0-9._-]+\/?$/i;
const testPattern = /^http:\/\/127\.0\.0\.1:\d+\/?$/;

if (!fs.statSync(site, { throwIfNoEntry: false })?.isDirectory() || !caseId ||
    !(pagesPattern.test(rawBase) || (testMode && testPattern.test(rawBase)))) {
  console.error('usage: node tests/support/design_pages_release_gate.mjs SITE_DIR CASE_ID PAGES_URL [EVIDENCE_DIR]');
  process.exit(2);
}

const base = new URL(rawBase.endsWith('/') ? rawBase : `${rawBase}/`);
const localManifestFile = path.join(site, 'RELEASE_MANIFEST.json');
const localManifestBytes = fs.readFileSync(localManifestFile);
const localManifest = JSON.parse(localManifestBytes.toString('utf8'));
assert.equal(localManifest.schema, 'ds4.design.release.v1', 'invalid local release manifest');
assert.equal(localManifest.caseId, caseId, 'local release manifest case mismatch');
const testCase = JSON.parse(fs.readFileSync(
  path.join(root, 'extension/design/bench/cases.json'), 'utf8')).cases
  .find(item => item.id === caseId);
assert.ok(testCase?.fullStack, `unknown full-stack benchmark case: ${caseId}`);
if (!testMode) assert.equal(localManifest.pagesUrl, base.href,
  'local release manifest Pages URL does not match the deployment target');

const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const timeoutMs = Number(process.env.DSTUDIO_PAGES_TIMEOUT_MS || 15 * 60_000);
const intervalMs = Number(process.env.DSTUDIO_PAGES_POLL_MS || 10_000);
assert.ok(Number.isFinite(timeoutMs) && timeoutMs > 0, 'invalid Pages timeout');
assert.ok(Number.isFinite(intervalMs) && intervalMs > 0, 'invalid Pages polling interval');

function deploymentUrl(relative, nonce) {
  const url = new URL(relative, base);
  url.searchParams.set('_ds4_release', nonce);
  return url;
}

async function fetchBytes(relative, nonce) {
  const response = await fetch(deploymentUrl(relative, nonce), {
    redirect: 'follow',
    headers: { 'Cache-Control': 'no-cache', Pragma: 'no-cache' },
  });
  if (!response.ok) throw new Error(`${relative} returned HTTP ${response.status}`);
  const final = new URL(response.url);
  assert.equal(final.origin, base.origin, `${relative} redirected outside the Pages origin`);
  return Buffer.from(await response.arrayBuffer());
}

const deadline = Date.now() + timeoutMs;
let remoteManifestBytes;
let lastManifestError;
while (Date.now() < deadline) {
  try {
    remoteManifestBytes = await fetchBytes('RELEASE_MANIFEST.json', `${Date.now()}`);
    if (sha256(remoteManifestBytes) === sha256(localManifestBytes)) break;
    lastManifestError = new Error('remote manifest is still an older deployment');
  } catch (error) {
    lastManifestError = error;
  }
  await new Promise(resolve => setTimeout(resolve, intervalMs));
}
assert.ok(remoteManifestBytes && sha256(remoteManifestBytes) === sha256(localManifestBytes),
  `GitHub Pages did not publish the signed manifest before timeout: ${lastManifestError?.message || 'unknown error'}`);

const remoteManifest = JSON.parse(remoteManifestBytes.toString('utf8'));
assert.deepEqual(remoteManifest, localManifest, 'remote release manifest differs from Desktop');
const deployed = {};
for (const [relative, expected] of Object.entries(localManifest.files || {})) {
  const local = path.resolve(site, relative);
  assert.ok(local.startsWith(`${site}${path.sep}`), `manifest path escapes the Desktop release: ${relative}`);
  const localBytes = fs.readFileSync(local);
  assert.equal(localBytes.length, Number(expected.bytes), `local byte count changed: ${relative}`);
  assert.equal(sha256(localBytes), expected.sha256, `local hash changed: ${relative}`);
  const remote = await fetchBytes(relative, localManifest.generatedAt || `${Date.now()}`);
  assert.equal(remote.length, localBytes.length, `deployed byte count differs: ${relative}`);
  assert.equal(sha256(remote), expected.sha256, `deployed hash differs: ${relative}`);
  deployed[relative] = { bytes: remote.length, sha256: expected.sha256 };
}

fs.rmSync(evidence, { recursive: true, force: true });
fs.mkdirSync(evidence, { recursive: true });
const views = {};
let browser;
try {
  try { browser = await chromium.launch(); }
  catch { browser = await chromium.launch({ channel: 'chrome' }); }
  for (const viewport of [
    { name: 'desktop', width: 1280, height: 900 },
    { name: 'mobile', width: 390, height: 844 },
  ]) {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    const consoleErrors = [];
    const requestFailures = [];
    page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
    page.on('pageerror', error => consoleErrors.push(String(error)));
    page.on('requestfailed', request => requestFailures.push(
      `${request.url()} ${request.failure()?.errorText || ''}`.trim()));
    const response = await page.goto(deploymentUrl('', `${Date.now()}-${viewport.name}`).href,
      { waitUntil: 'networkidle' });
    assert.equal(response?.status(), 200, `${viewport.name} Pages entry did not return HTTP 200`);
    const metrics = await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      text: document.body.innerText,
      resources: performance.getEntriesByType('resource').map(entry => entry.name),
    }));
    assert.equal(metrics.scrollWidth, metrics.clientWidth,
      `${viewport.name} deployed page has horizontal overflow`);
    assert.ok(metrics.resources.every(resource => {
      const url = new URL(resource);
      return url.origin === base.origin && url.pathname.startsWith(base.pathname);
    }),
      `${viewport.name} deployed page loaded a cross-origin resource`);
    assert.deepEqual(consoleErrors, [], `${viewport.name} deployed page console errors`);
    assert.deepEqual(requestFailures, [], `${viewport.name} deployed page request failures`);
    for (const text of testCase.requiredText || [])
      assert.ok(metrics.text.includes(text), `${viewport.name} deployed page is missing exact copy: ${text}`);
    await page.screenshot({ path: path.join(evidence, `${viewport.name}.png`), fullPage: true });
    views[viewport.name] = { ...metrics, text: undefined, consoleErrors, requestFailures };
    await context.close();
  }
} finally {
  await browser?.close();
}

const report = {
  ok: true,
  checkedAt: new Date().toISOString(),
  caseId,
  pagesUrl: base.href,
  manifestSha256: sha256(localManifestBytes),
  deployed,
  views,
};
fs.writeFileSync(path.join(evidence, 'pages-release-gate.json'),
  `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ ok: true, caseId, pagesUrl: base.href, evidence }, null, 2));

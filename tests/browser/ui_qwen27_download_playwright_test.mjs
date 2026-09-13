// UI + real host/download ownership, isolated fixture installer/weights. This
// checks actual clicks and rendering, not inference or weight authenticity.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {artifactRunDir, sleep} from '../support/real_harness.mjs';

const name = process.env.DSTUDIO_TEST_BROWSER || 'webkit';
const theme = process.env.DSTUDIO_TEST_THEME || 'light';
assert.ok(['webkit', 'chromium'].includes(name));
assert.ok(['light', 'dark'].includes(theme));
const playwright = await import('playwright');
const run = artifactRunDir('qwen27-download-browser');
const receipt = {scope: 'Real UI/host HTTP, simulated installer/model bytes; not LLM quality or desktop app', browser: name,
  theme, started: new Date().toISOString(), passed: false, checks: []};
let fixture, browser, page, output = '';
const owner = spawn(process.execPath, ['tests/integration/qwen27_download_host_test.mjs',
  path.resolve(process.argv[2]), '--browser'], {stdio: ['ignore', 'pipe', 'pipe']});
owner.stdout.on('data', bytes => {output += bytes; for (const line of output.split('\n')) {
  if (line.startsWith('{')) {try {fixture = JSON.parse(line);} catch {}}
}});
owner.stderr.on('data', bytes => {output += bytes;});
const exited = new Promise(resolve => owner.once('exit', resolve));
const release = phase => fs.writeFileSync(path.join(fixture.root, phase + '-release'), 'release');
async function check(label, fn) {await fn(); receipt.checks.push(label);}
try {
  const deadline = Date.now() + 8000;
  while (!fixture && Date.now() < deadline) await sleep(25);
  assert.ok(fixture, output);
  browser = await playwright[name].launch();
  const context = await browser.newContext({viewport: {width: 1440, height: 1100}, colorScheme: theme});
  page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.goto(fixture.url);
  // Empty-profile diagnostics and Settings are real interactions; no local
  // storage injection or production state changes through page.evaluate.
  await page.getByRole('button', {name: 'Done', exact: true}).click();
  await page.getByRole('button', {name: 'Settings', exact: true}).first().click();
  const settings = page.getByRole('dialog', {name: 'Settings', exact: true});
  await settings.getByRole('button', {name: 'Interface', exact: true}).click();
  await settings.getByRole('radio', {name: theme === 'dark' ? 'Dark' : 'Light', exact: true}).click();
  receipt.effectiveTheme = await page.locator('html').getAttribute('data-theme');
  assert.equal(receipt.effectiveTheme, theme, 'OS colorScheme alone does not change DStudio\'s saved theme');
  await settings.getByRole('button', {name: 'Models', exact: true}).click();
  const composer = page.locator('.cbar-model-btn');
  const originalLabel = await composer.innerText();
  const downloads = settings.getByRole('combobox', {name: 'Model / quantization to download'});
  await downloads.waitFor({state: 'visible', timeout: 10000});
  await check('27B is offered as experimental with both components', async () => {
    await downloads.selectOption('qwen27-q6');
    assert.match(await downloads.locator('option:checked').innerText(), /Experimental/);
    assert.match(await downloads.locator('option:checked').innerText(), /F16 projector/);
  });
  const box = downloads.locator('..');
  await box.getByRole('button', {name: 'Download', exact: true}).click();
  const confirm = page.getByRole('dialog').filter({hasText: 'Download this model?'});
  await expectVisible(confirm);
  assert.match(await confirm.innerText(), /without changing your selected model/);
  await confirm.getByRole('button', {name: 'Download', exact: true}).click();
  await check('installing engine is visible while other controls remain usable', async () => {
    await settings.getByText(/Installing engine for qwen27-q6/).waitFor({timeout: 10000});
    await page.screenshot({path: path.join(run, `${name}-installing.png`), fullPage: true});
    assert.ok(await settings.getByRole('button', {name: 'Stop', exact: true}).isEnabled());
    assert.equal(await composer.innerText(), originalLabel);
  });
  await check('download and hash verification have distinct visible states', async () => {
    release('install');
    await settings.getByText(/Downloading qwen27-q6/).waitFor({timeout: 8000});
    release('download');
    await settings.getByText(/Verifying files for qwen27-q6/).waitFor({timeout: 8000});
    assert.doesNotMatch(await settings.getByText(/Verifying files for qwen27-q6/).innerText(), /\d+%/);
    assert.equal(await composer.innerText(), originalLabel);
    await settings.getByRole('button', {name: 'Open folder', exact: true}).click();
    const opened = path.join(fixture.run, 'opened-folder');
    const deadline = Date.now() + 2000;
    while (!fs.existsSync(opened) && Date.now() < deadline) await sleep(20);
    assert.equal(fs.readFileSync(opened, 'utf8'), path.join(fixture.root, 'ds4/gguf'));
    await page.screenshot({path: path.join(run, `${name}-verifying.png`), fullPage: true});
  });
  await check('Stop preserves progress and exposes Resume without unsupported deletion', async () => {
    await settings.getByRole('button', {name: 'Stop', exact: true}).click();
    await settings.getByText(/Paused: qwen27-q6/).waitFor({timeout: 8000});
    assert.ok(await settings.getByRole('button', {name: 'Resume', exact: true}).isEnabled());
    assert.equal(await settings.getByRole('button', {name: 'Delete partial', exact: true}).count(), 0);
    assert.equal(await composer.innerText(), originalLabel);
    await page.screenshot({path: path.join(run, `${name}-paused.png`), fullPage: true});
  });
  await check('Resume completes with both saved components', async () => {
    release('verify');
    await settings.getByRole('button', {name: 'Resume', exact: true}).click();
    await page.getByText(/qwen27-q6 downloaded — select it from the model menu/).waitFor({timeout: 10000});
    assert.equal(fs.readFileSync(path.join(fixture.root, 'ds4/gguf/Qwen3.8-27B-UD-Q6_K_XL.gguf'), 'utf8'), 'verified fixture model');
    assert.equal(fs.readFileSync(path.join(fixture.root, 'ds4/gguf/Qwen3.8-27B-mmproj-F16.gguf'), 'utf8'), 'verified fixture projector');
  });
  assert.deepEqual(errors, []); receipt.passed = true;
} catch (error) {
  receipt.error = error.stack; process.exitCode = 1;
  if (page) {
    fs.writeFileSync(path.join(run, 'body.txt'), await page.locator('body').innerText().catch(() => 'unavailable'));
    await page.screenshot({path: path.join(run, 'failure.png'), fullPage: true}).catch(() => {});
  }
} finally {
  if (browser) await browser.close();
  if (fixture) fs.writeFileSync(path.join(fixture.root, 'browser-finished'), 'finished');
  await Promise.race([exited, sleep(9000)]);
  if (owner.exitCode === null && owner.signalCode === null) {owner.kill('SIGTERM'); await exited;}
  receipt.fixture = fixture; receipt.fixtureExit = {code: owner.exitCode, signal: owner.signalCode};
  receipt.finished = new Date().toISOString();
  fs.writeFileSync(path.join(run, 'fixture.log'), output);
  fs.writeFileSync(path.join(run, 'results.json'), JSON.stringify(receipt, null, 2));
  console.log(`${receipt.passed ? 'PASS' : 'FAIL'} ${receipt.checks.length}/5 ${run}`);
  if (receipt.error) console.error(receipt.error);
}
async function expectVisible(locator) {await locator.waitFor({state: 'visible', timeout: 5000});}

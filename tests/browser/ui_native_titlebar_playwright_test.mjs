// Full-window screens under DStudio.app's native title-bar strip: the window
// controls must sit on a top bar, never over a control. The page is the real
// UI; the runtime and the Learn roadmap are SIMULATED (no model). The Design
// canvas and fullscreen artboard are covered by ui_design_ide_playwright_test.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium, webkit } from 'playwright';
import { seedUi } from '../support/ui_mock_server.mjs';
import { streamSeed, uiStreamFixture } from '../support/ui_stream_fixture.mjs';
import { NATIVE_TITLEBAR_PX, simulateNativeTitlebar, windowStripReport } from '../support/native_titlebar.mjs';

const browserName = process.env.DSTUDIO_TEST_BROWSER || 'chromium';
assert.ok(['chromium', 'webkit'].includes(browserName));
fs.mkdirSync('tests/.artifacts/ui-native-titlebar', { recursive: true });
const dir = fs.mkdtempSync(`tests/.artifacts/ui-native-titlebar/${browserName}-`);
const receipt = { scope: 'Real UI with the native title-bar inset simulated; runtime and roadmap simulated', browserName, cases: [] };
const browser = await ({ chromium, webkit })[browserName].launch();

try {
  for (const theme of ['dark', 'light']) {
    const server = await uiStreamFixture({ document: { body: fs.readFileSync('web/index.html', 'utf8'), headers: { 'content-type': 'text/html' } } });
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    page.setDefaultTimeout(8000);
    await simulateNativeTitlebar(page);
    const evidence = await seedUi(page, server.origin, streamSeed(theme));
    const row = { name: `${theme}: the main window and the Learn study room clear the window controls` };
    try {
      await page.goto(server.origin);
      await page.locator('#composer-input').waitFor();
      assert.deepEqual(await windowStripReport(page, 'body'), { inset: NATIVE_TITLEBAR_PX, controlsInStrip: [] });
      await page.locator('#tab-roadmap').click();
      const study = page.getByRole('button', { name: 'Study Selezione del testo', exact: true });
      await study.click();
      await page.locator('#roadmap-study').waitFor({ state: 'visible' });
      assert.deepEqual(await windowStripReport(page, '#roadmap-study', '#roadmap-study .roadmap-study__head'),
        { inset: NATIVE_TITLEBAR_PX, controlsInStrip: [], barTop: 0, barCoversStrip: true });
      await page.screenshot({ path: path.join(dir, `${theme}-study.png`) });
      assert.deepEqual(evidence.errors, []);
      assert.deepEqual(evidence.external, []);
      row.status = 'PASS';
    } catch (error) {
      row.status = 'FAIL'; row.error = error.stack; process.exitCode = 1;
      await page.screenshot({ path: path.join(dir, `${theme}-fail.png`) }).catch(() => {});
    } finally {
      receipt.cases.push(row);
      console.log(`${row.status} ${row.name}${row.error ? `\n${row.error}` : ''}`);
      await page.close();
      server.close();
    }
  }
} finally {
  fs.writeFileSync(path.join(dir, 'results.json'), JSON.stringify(receipt, null, 2));
  await browser.close();
}
const passed = receipt.cases.filter((c) => c.status === 'PASS').length;
console.log(`ui_native_titlebar (${browserName}, simulated runtime): ${passed}/${receipt.cases.length}; receipts: ${dir}`);

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium, webkit } from 'playwright';
import { seedUi } from '../support/ui_mock_server.mjs';
import { streamSeed, uiStreamFixture } from '../support/ui_stream_fixture.mjs';

const browserName = process.env.DSTUDIO_TEST_BROWSER || 'chromium';
assert.ok(['chromium', 'webkit'].includes(browserName));
fs.mkdirSync('tests/.artifacts/ui-roadmap-hover', { recursive: true });
const dir = fs.mkdtempSync(`tests/.artifacts/ui-roadmap-hover/${browserName}-`);
const sourceFile = process.env.DSTUDIO_ROADMAP_HOVER_DOCUMENT || 'web/index.html';
const source = fs.readFileSync(sourceFile, 'utf8');
const receipt = { scope: 'Real mouse and keyboard; isolated roadmap and simulated runtime only', browserName,
  sourceFile, sourceSha256: createHash('sha256').update(source).digest('hex'), cases: [] };
const browser = await ({ chromium, webkit })[browserName].launch();
const paint = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));

try {
  for (const theme of ['light', 'dark']) for (const width of [1100, 760]) {
    const name = `${theme}-${width}`;
    const server = await uiStreamFixture({ document: { body: source, headers: { 'content-type': 'text/html' } } });
    const page = await browser.newPage({ viewport: { width, height: 820 } });
    page.setDefaultTimeout(6000);
    const seed = streamSeed(theme);
    const roadmapMessage = seed.chats.find(chat => chat.mode === 'roadmap').messages[0];
    const roadmap = JSON.parse(roadmapMessage.content.slice(roadmapMessage.content.indexOf('\n') + 1, roadmapMessage.content.lastIndexOf('\n```')));
    roadmap.stages[0].topics.push({ id: 'secondo', title: 'Secondo blocco', summary: 'Contenuto diverso del secondo blocco.' });
    roadmapMessage.content = '```dstudio-roadmap\n' + JSON.stringify(roadmap) + '\n```';
    const evidence = await seedUi(page, server.origin, seed);
    const folder = path.join(dir, name); fs.mkdirSync(folder);
    let frame = 0, before, after, selectedContext;
    const capture = () => page.screenshot({ path: path.join(folder, `${String(frame++).padStart(3, '0')}.png`) });
    try {
      await page.goto(server.origin);
      const menu = page.getByRole('button', { name: 'Open conversations menu', exact: true });
      const narrowDrawer = await menu.isVisible();
      if (narrowDrawer) await menu.click();
      await page.locator('#tab-roadmap').click();
      await page.locator('#backdrop').waitFor({ state: 'hidden' });
      if (narrowDrawer) assert.equal(await menu.getAttribute('aria-expanded'), 'false', 'mode selection closes the narrow drawer accessibly');
      const study = page.getByRole('button', { name: 'Study Selezione del testo', exact: true });
      await study.waitFor();
      await page.mouse.move(4, 4); await paint(page);
      before = await study.boundingBox(); await capture();
      const point = { x: before.x + before.width / 2, y: before.y + before.height / 2 };
      // Use the user's original target. Locator.click() may retry against a
      // moved control and conceal that a single real click hits Delete instead.
      await page.mouse.move(point.x, point.y); await paint(page);
      after = await study.boundingBox(); await capture();
      assert.equal(await study.evaluate((node, p) => node.contains(document.elementFromPoint(p.x, p.y)), point), true,
        'the first visible Study target must remain under the pointer when other actions appear');
      assert.ok(Math.abs(before.x - after.x) <= 1 && Math.abs(before.y - after.y) <= 1,
        'hover does not move the Study control');
      await page.mouse.down(); await page.mouse.up();
      await page.locator('#roadmap-study').waitFor({ state: 'visible' });
      await page.locator('.roadmap-study__input').fill('Bozza Learn conservata alla riapertura.');
      await capture();
      await page.getByRole('button', { name: 'Back to roadmap', exact: true }).click();
      await study.waitFor();
      await page.mouse.move(4, 4); await paint(page);
      const keyboardBefore = await study.boundingBox();
      // macOS WebKit uses Option-Tab to include buttons in keyboard traversal.
      await study.press(browserName === 'webkit' ? 'Alt+Tab' : 'Tab'); await paint(page);
      const keyboardAfter = await study.boundingBox();
      assert.ok(Math.abs(keyboardBefore.x - keyboardAfter.x) <= 1, 'keyboard focus reveals actions without moving Study');
      assert.equal(await page.getByRole('button', { name: 'Add a block to the left branch after Selezione del testo', exact: true })
        .evaluate(node => document.activeElement === node), true, 'the next keyboard action is reachable');
      await page.keyboard.press(browserName === 'webkit' ? 'Alt+Shift+Tab' : 'Shift+Tab'); await page.keyboard.press('Enter');
      await page.locator('#roadmap-study').waitFor({ state: 'visible' });
      assert.equal(await page.locator('.roadmap-study__input').inputValue(), 'Bozza Learn conservata alla riapertura.',
        'mouse and keyboard reopening keep the owned study draft');
      await capture();
      const selectionPoints = await page.locator('.roadmap-study__context').evaluate(context => [
        [context.querySelector('p'), 14], [context.querySelector('h2'), 2],
      ].map(([node, offset]) => {
        const range = document.createRange(); range.setStart(node.firstChild, offset); range.setEnd(node.firstChild, offset + 1);
        const rect = range.getBoundingClientRect(); return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      }));
      await page.mouse.move(selectionPoints[0].x, selectionPoints[0].y); await page.mouse.down();
      await page.mouse.move(selectionPoints[1].x, selectionPoints[1].y, { steps: 10 }); await page.mouse.up();
      await paint(page);
      selectedContext = await page.evaluate(() => String(getSelection()));
      assert.ok(selectedContext.includes('lezione del testo') && selectedContext.includes('Studiare il te'),
        'actual mouse input selects the first study heading and description');
      await capture();
      await page.getByRole('button', { name: 'Back to roadmap', exact: true }).click();
      await page.getByRole('button', { name: 'Study Secondo blocco', exact: true }).click();
      await page.locator('#roadmap-study').waitFor({ state: 'visible' }); await paint(page);
      assert.equal(await page.locator('.roadmap-study__title').textContent(), 'Secondo blocco');
      assert.equal(await page.locator('.roadmap-study__context h2').textContent(), 'Secondo blocco',
        'an explicit thread change must replace the old selected study body');
      assert.ok((await page.locator('.roadmap-study__context').textContent()).includes('Contenuto diverso del secondo blocco.'));
      await capture();
      await page.getByRole('button', { name: 'Back to roadmap', exact: true }).click();
      const topic = page.locator('.roadmap-topic[data-topic-id="selezione"]');
      await topic.locator('.roadmap-topic__check').click();
      await topic.locator('.roadmap-topic__node').hover();
      await topic.getByRole('button', { name: /^Add a block/ }).click();
      const addForm = topic.locator('.roadmap-add');
      await addForm.locator('input').fill('Bozza di un blocco da conservare');
      await addForm.locator('textarea').fill('Descrizione ancora in modifica.');
      await page.evaluate(() => { window.__roadmapDraftForm = document.querySelector('.roadmap-add'); });
      await capture();
      // Reopening the active conversation is a real render request. A progress
      // change must not invalidate the already-updated card and lose its form.
      if (narrowDrawer) await menu.click();
      await page.locator('#chat-list [data-id="audit-learn"]').click();
      await page.locator('#backdrop').waitFor({ state: 'hidden' });
      await paint(page);
      assert.equal(await page.evaluate(() => window.__roadmapDraftForm?.isConnected), true,
        'a progress update followed by a render keeps the original editor connected');
      assert.equal(await addForm.locator('input').inputValue(), 'Bozza di un blocco da conservare');
      assert.equal(await addForm.locator('textarea').inputValue(), 'Descrizione ancora in modifica.');
      assert.equal(await topic.locator('.roadmap-topic__check').getAttribute('aria-pressed'), 'true');
      await capture();
      await addForm.getByRole('button', { name: 'Cancel', exact: true }).click();
      assert.equal(await topic.locator('.roadmap-add').count(), 0);
      assert.equal(server.requests.some(request => request.path === '/v1/chat/completions'), false,
        'opening a study does not generate a response');
      assert.deepEqual(evidence.errors, []); assert.deepEqual(evidence.external, []); assert.deepEqual(server.missing, []);
      receipt.cases.push({ name, status: 'PASS', before, after, selectedContext });
    } catch (error) {
      receipt.cases.push({ name, status: 'FAIL', error: error.stack, before, after, selectedContext, ...evidence, missing: server.missing });
      await capture().catch(() => {});
    } finally {
      console.log(`${name}: ${receipt.cases.at(-1).status}`);
      fs.writeFileSync(path.join(dir, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
      await page.close(); server.close();
      if (frame) execFileSync('python3', ['tests/support/encode_ui_gif.py', folder, path.join(dir, name + '.gif')]);
    }
  }
} finally { await browser.close(); console.log(`Roadmap hover evidence: ${dir}`); }
assert.ok(receipt.cases.length && receipt.cases.every(row => row.status === 'PASS'), 'Roadmap pointer target regressions failed');

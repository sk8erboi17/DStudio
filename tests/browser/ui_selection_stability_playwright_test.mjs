import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chromium, webkit } from 'playwright';
import { seedUi } from '../support/ui_mock_server.mjs';
import { streamSeed, uiStreamFixture, startFixtureStream, fixtureTextSaved } from '../support/ui_stream_fixture.mjs';

const browserName = process.env.DSTUDIO_TEST_BROWSER || 'chromium';
assert.ok(['chromium', 'webkit'].includes(browserName));
fs.mkdirSync('tests/.artifacts/ui-stability', { recursive: true });
const dir = fs.mkdtempSync(`tests/.artifacts/ui-stability/${browserName}-`);
const sourceFile = process.env.DSTUDIO_STABILITY_DOCUMENT || 'web/index.html';
const source = fs.readFileSync(sourceFile, 'utf8');
const receipt = { scope: 'Real browser mouse/keyboard, animation-frame and raster observations; all inference simulated',
  sourceFile, sourceSha256: createHash('sha256').update(source).digest('hex'), cases: [] };
const browser = await ({ chromium, webkit })[browserName].launch();
const point = (locator, offset = 8) => locator.evaluate((element, offset) => {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node && offset >= node.length) { offset -= node.length; node = walker.nextNode(); }
  if (!node) throw Error('Rendered text is required for the real mouse gesture');
  const range = document.createRange(); range.setStart(node, offset); range.setEnd(node, offset + 1);
  const rect = range.getBoundingClientRect(); return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}, offset);
const paint = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));

try {
  for (const mode of ['chat', 'agent', 'cowork', 'design', 'tutor']) for (const gesture of ['steady', 'cross-header', 'select-all']) {
    const name = `${mode}-${gesture}`;
    if (process.env.DSTUDIO_STABILITY_CASE && process.env.DSTUDIO_STABILITY_CASE !== name) continue;
    const server = await uiStreamFixture({ speed: gesture === 'steady' ? 'slow' : 'bursty',
      document: { body: source, headers: { 'content-type': 'text/html' } } });
    const page = await browser.newPage({ viewport: { width: 1100, height: 820 } });
    page.setDefaultTimeout(6000);
    const evidence = await seedUi(page, server.origin, streamSeed());
    const folder = path.join(dir, name); fs.mkdirSync(folder);
    let frame = 0;
    const capture = () => page.screenshot({ path: path.join(folder, `${String(frame++).padStart(3, '0')}.png`) });
    let monitor;
    const dragObservations = [];
    const observeDrag = async stage => dragObservations.push(await page.evaluate(({ stage, scroller }) => {
      const selection = getSelection();
      if (stage === 'down') window.__dragStart = selection.anchorNode;
      return { stage, selected: String(selection), top: document.querySelector(scroller).scrollTop,
        anchorConnected: window.__dragStart?.isConnected,
        focus: document.activeElement?.id, anchor: selection.anchorNode?.parentElement?.outerHTML.slice(0, 180),
        extent: selection.focusNode?.parentElement?.outerHTML.slice(0, 180) };
    }, { stage, scroller: mode === 'tutor' ? '.roadmap-study__scroll' : mode === 'chat' ? '#messages' : '#agent-view' }));
    try {
      await page.goto(server.origin);
      const { scroller, paragraphs } = await startFixtureStream(page, mode);
      const line = n => page.locator(paragraphs).filter({ hasText: `Riga ${String(n).padStart(3, '0')}:` }).first();
      await line(20).waitFor();
      await page.waitForFunction(() => !document.body.classList.contains('chat-drop-anim') && !document.querySelector('.hero-ghost'));
      await page.locator(scroller).hover(); await page.mouse.wheel(0, -800);
      await line(20).evaluate(node => node.scrollIntoView({ block: 'center' })); await paint(page);
      await line(20).scrollIntoViewIfNeeded(); await line(18).scrollIntoViewIfNeeded();
      const anchor = await point(line(20), 12), focus = await point(line(18));
      assert.equal(await line(20).evaluate((node, p) => node.contains(document.elementFromPoint(p.x, p.y)), anchor), true,
        'the real drag starts on visible reader text');
      await observeDrag('before');
      await page.mouse.move(anchor.x, anchor.y); await page.mouse.down();
      await observeDrag('down');
      await capture();
      await page.mouse.move(focus.x, focus.y, { steps: 12 }); await observeDrag('moved'); await capture();
      if (gesture === 'cross-header') {
        const box = await page.locator(scroller).boundingBox();
        await page.mouse.move(anchor.x, Math.max(2, box.y - 18), { steps: 12 });
        // Real drag autoscroll reaches the start, then the pointer enters the
        // heading. This is a genuine range spanning the reader and its chrome.
        await page.waitForFunction(selector => document.querySelector(selector).scrollTop <= 1, scroller);
        await page.mouse.move(anchor.x, Math.max(2, box.y - 24), { steps: 8 });
        await paint(page); await capture();
      }
      await page.mouse.up(); await paint(page);
      await observeDrag('released');
      if (gesture === 'select-all') { await page.keyboard.press('ControlOrMeta+A'); await paint(page); }
      const selected = await page.evaluate(() => String(getSelection()));
      assert.ok(selected.includes('Riga 019:'), 'a real gesture selects the intervening passage');
      assert.ok(selected.includes('Riga 020:'), 'the gesture retains its original anchor line');
      await capture();
      await page.evaluate(({ selector, paragraphs, gesture }) => {
        const selection = getSelection(), anchor = selection.anchorNode, focus = selection.focusNode;
        const expected = String(selection), anchorOffset = selection.anchorOffset, focusOffset = selection.focusOffset;
        const root = document.querySelector(selector), initialTop = root.scrollTop;
        const passageText = Array.from(document.querySelectorAll(paragraphs)).find(node => node.textContent.startsWith('Riga 019:')).textContent;
        const report = { frames: 0, failures: [], samples: [] };
        let raf;
        const sample = () => {
          const current = getSelection(); report.frames++;
          const row = { frame: report.frames, text: String(current), connected: anchor.isConnected && focus.isConnected,
            anchorStable: current.anchorNode === anchor && current.anchorOffset === anchorOffset,
            focusStable: current.focusNode === focus && current.focusOffset === focusOffset, top: root.scrollTop };
          const passage = Array.from(document.querySelectorAll(paragraphs)).find(node => node.textContent === passageText);
          const covered = passage && current.rangeCount && current.getRangeAt(0).intersectsNode(passage) && row.text.includes(passageText);
          if ((gesture === 'steady' && row.text !== expected) || !covered || !row.connected || !row.anchorStable || !row.focusStable || Math.abs(row.top - initialTop) > 2)
            if (report.failures.length < 16) report.failures.push(row);
          if (report.samples.length < 16 && report.frames % 15 === 0) report.samples.push({ frame: row.frame, top: row.top });
          if (report.frames < 900) raf = requestAnimationFrame(sample);
        };
        raf = requestAnimationFrame(sample);
        window.__stabilityMonitor = { report, stop() { cancelAnimationFrame(raf); return report; } };
      }, { selector: scroller, paragraphs, gesture });
      const clip = gesture === 'steady' ? await line(19).boundingBox() : null;
      if (clip) await page.screenshot({ path: path.join(dir, `${name}-selected-before.png`), clip });
      server.pause();
      for (let i = 0; i < 5; i++) {
        const marker = `Aggiornamento controllato ${i}: testo completo da conservare.\n\n`;
        server.append(marker);
        await page.waitForFunction(fixtureTextSaved, { mode, contains: marker.trim() });
        assert.equal(server.state().working, true, 'the quiet barrier retains the active simulated request');
        await capture();
      }
      server.finish();
      if (mode === 'tutor') await page.waitForFunction(() => Object.values(JSON.parse(localStorage.getItem('ds4web.chats.v2')).chats
        .find(chat => chat.mode === 'roadmap').messages[0].roadmapStudyThreads || {}).some(thread => thread.messages.at(-1)?.streaming === false));
      else await page.locator('#btn-stop').waitFor({ state: 'hidden' });
      await paint(page); await capture();
      monitor = await page.evaluate(() => window.__stabilityMonitor.stop());
      assert.ok(monitor.frames >= 5, 'frame observations must span actual updates');
      assert.equal(monitor.failures.length, 0, 'no transient collapse, endpoint replacement, random extent or reading-position jump');
      if (gesture === 'steady') assert.equal(await page.evaluate(() => String(getSelection())), selected, 'completion preserves the exact selection');
      if (clip) {
        await page.screenshot({ path: path.join(dir, `${name}-selected-after.png`), clip });
        const changed = Number(execFileSync('python3', ['-c',
          'import sys;from PIL import Image,ImageChops;d=ImageChops.difference(Image.open(sys.argv[1]).convert("RGB"),Image.open(sys.argv[2]).convert("RGB"));print(sum(p!=(0,0,0) for p in d.getdata()))',
          path.join(dir, `${name}-selected-before.png`), path.join(dir, `${name}-selected-after.png`)], { encoding: 'utf8' }));
        assert.equal(changed, 0, 'the selected static passage must retain identical pixels across updates');
      }
      // An actual click clears the highlight. Deferred text must appear without
      // restoring an old selection or losing a completed stream's bytes.
      await page.mouse.click(anchor.x, anchor.y); await paint(page);
      assert.equal(await page.evaluate(() => getSelection().isCollapsed), true);
      await page.waitForFunction(() => document.body.textContent.includes('Aggiornamento controllato 4:'));
      const expected = server.state();
      await page.waitForFunction(fixtureTextSaved, { mode, equals: mode === 'chat' || mode === 'tutor' ? expected.content : expected.raw });
      await capture();
      assert.deepEqual(evidence.errors, []); assert.deepEqual(evidence.external, []); assert.deepEqual(server.missing, []);
      receipt.cases.push({ name, status: 'PASS', selected, monitor, dragObservations, chunks: expected.chunks });
    } catch (error) {
      monitor ||= await page.evaluate(() => window.__stabilityMonitor?.stop() || null).catch(() => null);
      receipt.cases.push({ name, status: 'FAIL', error: error.stack, monitor, dragObservations, ...evidence, missing: server.missing,
        selection: await page.evaluate(() => String(getSelection())).catch(() => null) });
      await capture().catch(() => {});
    } finally {
      console.log(name + ': ' + receipt.cases.at(-1).status);
      fs.writeFileSync(path.join(dir, 'receipt.json'), JSON.stringify(receipt, null, 2));
      await page.close(); server.close();
      if (frame) execFileSync('python3', ['tests/support/encode_ui_gif.py', folder, path.join(dir, name + '.gif')]);
    }
  }
} finally { await browser.close(); console.log(`UI stability evidence: ${dir}`); }
assert.ok(receipt.cases.length && receipt.cases.every(row => row.status === 'PASS'), 'UI stability regressions failed');

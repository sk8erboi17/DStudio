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
fs.mkdirSync('tests/.artifacts/ui-stream-interaction', { recursive: true });
const dir = fs.mkdtempSync(`tests/.artifacts/ui-stream-interaction/${browserName}-`);
const sourceFile = process.env.DSTUDIO_INTERACTION_DOCUMENT || 'web/index.html';
const source = fs.readFileSync(sourceFile, 'utf8');
const receipt = { scope: 'Real browser wheel, keyboard and frame observations; all generation simulated', browserName,
  sourceFile, sourceSha256: createHash('sha256').update(source).digest('hex'), cases: [] };
const browser = await ({ chromium, webkit })[browserName].launch();
const paint = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));

try {
  for (const mode of ['chat', 'agent', 'cowork', 'design', 'tutor']) for (const speed of ['slow', 'fast']) {
    const name = `${mode}-${speed}`;
    if (process.env.DSTUDIO_INTERACTION_CASE && process.env.DSTUDIO_INTERACTION_CASE !== name) continue;
    const server = await uiStreamFixture({ speed, maxChunks: 512,
      document: { body: source, headers: { 'content-type': 'text/html' } } });
    const page = await browser.newPage({ viewport: { width: 1100, height: 820 } });
    page.setDefaultTimeout(6000);
    const evidence = await seedUi(page, server.origin, streamSeed(speed === 'slow' ? 'light' : 'dark'));
    const folder = path.join(dir, name); fs.mkdirSync(folder);
    let frame = 0, monitor, inputState;
    const capture = () => page.screenshot({ path: path.join(folder, `${String(frame++).padStart(3, '0')}.png`) });
    try {
      await page.goto(server.origin);
      const { scroller, paragraphs, input } = await startFixtureStream(page, mode);
      await page.evaluate(selector => {
        window.__wheelTrace = [];
        document.querySelector(selector).addEventListener('wheel', event => {
          if (window.__wheelTrace.length < 8) window.__wheelTrace.push({ delta: event.deltaY,
            target: event.target.className, tag: event.target.tagName, parent: event.target.parentElement?.className,
            defaultPrevented: event.defaultPrevented, top: document.querySelector(selector).scrollTop });
        }, { passive: true });
      }, scroller);
      await page.locator(scroller).hover({ position: { x: 180, y: 200 } });
      const chunksAtWheel = server.state().chunks;
      // Real upward input releases automatic following. Reading is positioned
      // with wheel input only, so a programmatic scroll cannot mask a jump.
      for (let n = 0; n < 16 && await page.locator(scroller).evaluate(node => node.scrollTop) > 1; n++) {
        await page.mouse.wheel(0, -800); await paint(page);
      }
      await page.waitForFunction(selector => document.querySelector(selector).scrollTop <= 1, scroller);
      // The slow producer may not tick during a short wheel gesture. Keep the
      // reading request active through an actual producer tick, instead of
      // making this assertion depend on the browser beating a 180 ms timer.
      const producerDeadline = Date.now() + 6000;
      while (server.state().chunks === chunksAtWheel && Date.now() < producerDeadline)
        await new Promise(resolve => setTimeout(resolve, 25));
      await page.mouse.wheel(0, 550);
      await page.waitForFunction(selector => document.querySelector(selector).scrollTop > 200, scroller);
      await paint(page); await capture();
      assert.ok(server.state().chunks > chunksAtWheel, 'the fixture continues producing chunks during actual wheel input');
      const passage = await page.evaluate(({ scroller, paragraphs }) => {
        const box = document.querySelector(scroller).getBoundingClientRect();
        const node = Array.from(document.querySelectorAll(paragraphs)).find(node => node.textContent.startsWith('Riga ')
          && node.getBoundingClientRect().top > box.top + 30 && node.getBoundingClientRect().bottom < box.bottom - 30);
        if (!node) throw Error('An actual wheel gesture must expose an original passage');
        return node.textContent;
      }, { scroller, paragraphs });
      const draft = 'Bozza pronta: leggere, scrivere e copiare caffè 🧪';
      await page.locator(input).fill(draft);
      await page.locator(input).press('End');
      await page.locator(input).press('Shift+ArrowLeft'); await page.locator(input).press('Shift+ArrowLeft');
      inputState = await page.locator(input).evaluate(node => ({ value: node.value, start: node.selectionStart,
        end: node.selectionEnd, direction: node.selectionDirection, focused: document.activeElement === node }));
      assert.equal(inputState.focused, true); assert.ok(inputState.end > inputState.start, 'real keyboard selection has an extent');
      await page.evaluate(({ scroller, paragraphs, passage, input, inputState }) => {
        const root = document.querySelector(scroller), editor = document.querySelector(input), top = root.scrollTop;
        const find = () => Array.from(document.querySelectorAll(paragraphs)).find(node => node.textContent === passage);
        const passageTop = find().getBoundingClientRect().top;
        const report = { frames: 0, failures: [], readingTop: top, passageTop };
        let raf, progressCompleted = false;
        const sample = () => {
          report.frames++;
          const node = find();
          const row = { frame: report.frames, readingTop: root.scrollTop, passageTop: node?.getBoundingClientRect().top,
            focused: document.activeElement === editor, connected: editor.isConnected,
            draft: editor.value, start: editor.selectionStart, end: editor.selectionEnd, direction: editor.selectionDirection };
          if ((!progressCompleted && (!node || Math.abs(row.readingTop - top) > 2 || Math.abs(row.passageTop - passageTop) > 2))
            || !row.focused || !row.connected || row.draft !== inputState.value || row.start !== inputState.start
            || row.end !== inputState.end || row.direction !== inputState.direction)
            if (report.failures.length < 16) report.failures.push(row);
          if (report.frames < 900) raf = requestAnimationFrame(sample);
        };
        raf = requestAnimationFrame(sample);
        window.__interactionMonitor = { report, completeProgress() { progressCompleted = true; report.completedProgress = true; },
          stop() { cancelAnimationFrame(raf); return report; } };
      }, { scroller, paragraphs, passage, input, inputState });
      await capture();
      server.pause();
      for (let n = 0; n < 4; n++) {
        const marker = `Aggiornamento con bozza ${n}: caffè 🧪.\n\n`;
        server.append(marker);
        await page.waitForFunction(fixtureTextSaved, { mode, contains: marker.trim() });
        assert.equal(server.state().working, true);
        await capture();
      }
      // Design's live task list intentionally becomes a completed transcript.
      // Its draft/focus must persist; the progress rows are allowed to retire.
      if (mode === 'design') await page.evaluate(() => window.__interactionMonitor.completeProgress());
      server.finish();
      const expected = server.state();
      await page.waitForFunction(fixtureTextSaved, { mode, equals: mode === 'chat' || mode === 'tutor' ? expected.content : expected.raw });
      if (mode !== 'tutor') await page.locator('#btn-stop').waitFor({ state: 'hidden' });
      await paint(page); await capture();
      monitor = await page.evaluate(() => window.__interactionMonitor.stop());
      assert.ok(monitor.frames >= 5, 'observations must span real updates');
      assert.equal(monitor.failures.length, 0, 'reading position, visible passage, focus, draft and keyboard selection survive every frame');
      assert.deepEqual(evidence.errors, []); assert.deepEqual(evidence.external, []); assert.deepEqual(server.missing, []);
      receipt.cases.push({ name, status: 'PASS', passage, inputState, monitor, chunksAtWheel, chunks: expected.chunks,
        wheelTrace: await page.evaluate(() => window.__wheelTrace) });
    } catch (error) {
      monitor ||= await page.evaluate(() => window.__interactionMonitor?.stop() || null).catch(() => null);
      receipt.cases.push({ name, status: 'FAIL', error: error.stack, inputState, monitor, ...evidence, missing: server.missing,
        fixture: server.state(), persisted: await page.evaluate(() => JSON.parse(localStorage.getItem('ds4web.chats.v2'))),
        view: await page.evaluate(() => ({ messagesTop: document.querySelector('#messages').scrollTop,
          messagesHeight: document.querySelector('#messages').scrollHeight,
          studyTop: document.querySelector('.roadmap-study__scroll')?.scrollTop, agentTop: document.querySelector('#agent-view').scrollTop,
          wheelTrace: window.__wheelTrace })) });
      await capture().catch(() => {});
    } finally {
      console.log(`${name}: ${receipt.cases.at(-1).status}`);
      fs.writeFileSync(path.join(dir, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
      await page.close(); server.close();
      if (frame) execFileSync('python3', ['tests/support/encode_ui_gif.py', folder, path.join(dir, name + '.gif')]);
    }
  }
} finally { await browser.close(); console.log(`UI stream interaction evidence: ${dir}`); }
assert.ok(receipt.cases.length && receipt.cases.every(row => row.status === 'PASS'), 'UI stream interaction regressions failed');

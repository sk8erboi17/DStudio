import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { chromium, webkit } from 'playwright';
import { uiMockServer, jsonReply, requestBody, seedUi, sseDelta, sseDone } from '../support/ui_mock_server.mjs';

const browserName = process.env.DSTUDIO_TEST_BROWSER || 'chromium';
assert.ok(['chromium', 'webkit'].includes(browserName));
fs.mkdirSync('tests/.artifacts/ui-selection', { recursive: true });
const dir = fs.mkdtempSync(`tests/.artifacts/ui-selection/${browserName}-`);
const receipt = { scope: 'Production UI, real mouse selection, simulated slow/fast engines only', cases: [] };
const lines = Array.from({ length: 50 }, (_, i) => `Selectable line ${String(i).padStart(3, '0')}: stable text for reading and copying.`).join('\n\n') + '\n\n';
const initial = '# Simulated explanation\n\n**Formatted prose** with a list, equation and code.\n\n- First item\n- Second item\n\n$$x^2 + y^2 = z^2$$\n\n```javascript\nfunction fixture() {\n    return 42;\n}\n```\n\n' + lines;
const browser = await ({ chromium, webkit })[browserName].launch();
const poll = async (fn, label) => {
  const until = Date.now() + 8000;
  while (Date.now() < until) { if (fn()) return; await new Promise(resolve => setTimeout(resolve, 25)); }
  assert.fail(label);
};
const point = (locator, characterOffset = 2) => locator.evaluate((p, characterOffset) => {
  const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
  let node, offset = Math.max(0, Math.min(p.textContent.length - 1,
    characterOffset < 0 ? p.textContent.length + characterOffset : characterOffset));
  while ((node = walker.nextNode()) && offset >= node.length) offset -= node.length;
  if (!node) throw Error('Expected rendered text for the mouse target');
  const range = document.createRange();
  range.setStart(node, offset); range.setEnd(node, offset + 1);
  const r = range.getBoundingClientRect(); return { x: r.x + r.width/2, y: r.y + r.height/2 };
}, characterOffset);

try {
  for (const mode of ['chat', 'agent', 'cowork', 'design', 'tutor']) for (const speed of ['slow', 'fast']) {
    const name = `${mode}-${speed}`;
    if (process.env.DSTUDIO_SELECTION_CASE && process.env.DSTUDIO_SELECTION_CASE !== name) continue;
    const frames = path.join(dir, name);
    fs.mkdirSync(frames);
    let count = 0, timer, working = false, nativeMode = 'server', activeContext = 65536, raw = '', content = initial, response;
    let heldDesignArtifacts, designArtifactsReleased = false, designHydrated = false;
    const designActivation = [];
    const server = await uiMockServer(async (req, res, url) => {
      if (url.pathname === '/api/status') {
        jsonReply(res, { mode: nativeMode, running: true, ready: true, loadPct: 100, stage: 'Ready (simulated)',
          agentWorking: working, agentSessionWorking: false, workdir: `/fixture/${mode}`,
          ds4dirOk: true, webdirOk: true, lan: false, nativeVisionActive: true,
          modelFile: 'gguf/DeepSeek-V4-Flash-Vision-Exp-test.gguf', config: { ctx: activeContext, power: 100 }, variants: { flash: true }, variant: 'flash' }); return true;
      }
      if (url.pathname === '/api/start') { const body = await requestBody(req); nativeMode = body.mode || 'server'; activeContext = body.ctx || activeContext; jsonReply(res, { ok: true }); return true; }
      if (url.pathname === '/api/fs/list') { const body = await requestBody(req); jsonReply(res, { ok: true, path: body.path || '/fixture', entries: 0, dirs: [] }); return true; }
      if (url.pathname === '/api/user-skills') { jsonReply(res, { ok: true, skills: [] }); return true; }
      if (url.pathname === '/api/design-systems') { jsonReply(res, { ok: true, designSystems: [] }); return true; }
      if (url.pathname === '/api/design/state') { jsonReply(res, { ok: true, state: { seq: 1, phase: 'idle' } }); return true; }
      if (url.pathname === '/api/design/events') {
        if (url.searchParams.get('since') === '1') designHydrated = true;
        jsonReply(res, { ok: true, events: [] }); return true;
      }
      if (url.pathname === '/api/design/files') { jsonReply(res, { ok: true, files: [] }); return true; }
      if (url.pathname === '/api/design/artifacts') {
        if (mode === 'design' && !designArtifactsReleased) { heldDesignArtifacts = res; return true; }
        jsonReply(res, { ok: true, artifacts: [] }); return true;
      }
      if (url.pathname === '/api/design/session') { await requestBody(req); jsonReply(res, { ok: true }); return true; }
      if (url.pathname === '/api/agent/poll') {
        const bytes = Buffer.from(raw), since = Number(url.searchParams.get('since')) || 0;
        jsonReply(res, { base: 0, len: bytes.length, text: bytes.subarray(since).toString(), working, sessionWorking: false, ready: true, loadPct: 100 }); return true;
      }
      const begin = () => {
        working = true;
        timer = setInterval(() => {
          if (count >= 1000) return; // Bounded fixture remains open behind an explicit finish barrier.
          const delta = `Stream addition ${String(++count).padStart(3, '0')}: ${speed} fixture.\n\n`;
          content += delta;
          if (response) sseDelta(response, delta); else raw += delta;
        }, speed === 'slow' ? 220 : 12);
      };
      if (url.pathname === '/api/agent/send') {
        const body = await requestBody(req);
        const todos = mode === 'design' ? '\x1e' + JSON.stringify({ type: 'todos', todos: lines.trim().split('\n\n').map(text => ({ text, status: 'pending' })) }) + '\n' : '';
        raw = `\x01USER\x02${body.displayPrompt}\x01ENDUSER\x02\n` + '\x1e' + JSON.stringify({ type: 'reasoning_end' }) + '\n' + todos + initial;
        begin(); jsonReply(res, { ok: true, from: 0, at: Buffer.byteLength(raw) }); return true;
      }
      if (url.pathname === '/v1/chat/completions') {
        await requestBody(req); response = res;
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        sseDelta(res, initial); begin(); return true;
      }
      if (url.pathname === '/api/agent/interrupt') { working = false; clearInterval(timer); jsonReply(res, { ok: true }); return true; }
      return false;
    });
    const now = Date.now(), roadmap = { version: 1, title: 'Selection curriculum', goal: 'Read and copy during teaching.',
      stages: [{ id: 'reading', title: 'Reading', topics: [{ id: 'text', title: 'Text selection', summary: 'Read the explanation.', outcome: 'Copy a passage.' }] }] };
    const chats = [
      { id: 'fixture-chat', mode: 'chat', title: 'Selection test', createdAt: now, updatedAt: now, messages: [] },
      ...['agent', 'cowork', 'design'].map(kind => ({ id: `fixture-${kind}`, mode: kind, title: `${kind} selection`, createdAt: now, updatedAt: now, messages: [], transcript: '', workdir: `/fixture/${kind}` })),
      { id: 'fixture-learn', mode: 'roadmap', title: 'Selection curriculum', createdAt: now, updatedAt: now,
        messages: [{ id: 'learn-answer', role: 'assistant', content: '```dstudio-roadmap\n' + JSON.stringify(roadmap) + '\n```' }] },
    ];
    const page = await browser.newPage({ viewport: { width: 1100, height: 820 } });
    page.setDefaultTimeout(6000);
    const evidence = await seedUi(page, server.origin, { chats,
      settings: { workdirs: Object.fromEntries(['agent', 'cowork', 'design'].map(mode => [mode, `/fixture/${mode}`])) } });
    let frame = 0;
    const capture = () => page.screenshot({ path: path.join(frames, `${String(frame++).padStart(3, '0')}.png`) });
    try {
      await page.goto(server.origin);
      let scroller = '#messages', paragraphs = '.msg--assistant .msg__content p';
      if (mode === 'tutor') {
        await page.locator('#tab-roadmap').click();
        await page.getByRole('button', { name: 'Study Text selection', exact: true }).click();
        scroller = '.roadmap-study__scroll'; paragraphs = '.roadmap-study-msg--assistant .md p';
        await page.locator('.roadmap-study__input').fill('Selection fixture');
        await page.locator('.roadmap-study__send').click();
      } else {
        if (mode !== 'chat') {
          await page.locator(`#tab-${mode}`).click();
          const workdirDialog = page.locator('#workdir-dialog');
          await workdirDialog.waitFor({ state: 'visible' });
          await workdirDialog.getByRole('button', { name: /^(Start|Launch)/ }).click();
          await poll(() => nativeMode === mode, 'the simulated runtime must accept the selected mode');
          await page.locator('#loading-overlay').waitFor({ state: 'hidden' });
          await page.waitForFunction(mode => document.body.dataset.mode === mode || document.querySelector('#tab-' + mode)?.classList.contains('tab--active'), mode);
          scroller = '#agent-view'; paragraphs = mode === 'design' ? '#agent-view .gen-steps .gstep span:last-child' : '#agent-view .agent-answer-streaming p';
        }
        await page.locator('#composer-input').fill('Selection fixture');
        if (mode === 'design') {
          // A late initial hydration must not detach the shared form between
          // mouse down and up and swallow the user's first Send activation.
          await poll(() => !!heldDesignArtifacts, 'Design hydration must reach its explicit response barrier');
          await page.locator('#btn-send').scrollIntoViewIfNeeded();
          const button = await page.locator('#btn-send').boundingBox();
          const pointer = { x: button.x + button.width / 2, y: button.y + button.height / 2 };
          const activationState = async stage => designActivation.push(await page.evaluate(({ stage, pointer }) => {
            const button = document.querySelector('#btn-send'), target = document.elementFromPoint(pointer.x, pointer.y);
            return { stage, draft: document.querySelector('#composer-input').value,
              target: target?.outerHTML.slice(0, 250), hit: button === target || button.contains(target),
              rect: button.getBoundingClientRect().toJSON(), body: document.body.className,
              scrollTop: document.querySelector('#agent-view').scrollTop, detachments: window.__designFormDetachments || 0 };
          }, { stage, pointer }));
          await activationState('before-press');
          assert.equal(designActivation.at(-1).hit, true, 'the Send gesture begins on its actual visible button');
          await page.mouse.move(pointer.x, pointer.y);
          await page.evaluate(() => {
            const form = document.querySelector('#composer-form');
            window.__designFormDetachments = 0;
            window.__designFormObserver = new MutationObserver(records => {
              for (const record of records) for (const node of record.removedNodes)
                if (node === form || node.contains?.(form)) window.__designFormDetachments++;
            });
            window.__designFormObserver.observe(document.body, { subtree: true, childList: true });
          });
          await page.mouse.down();
          await activationState('pressed');
          designArtifactsReleased = true;
          jsonReply(heldDesignArtifacts, { ok: true, artifacts: [] });
          await poll(() => designHydrated, 'Design hydration must finish its notification before mouse release');
          await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
          await activationState('hydrated');
          assert.equal(designActivation.at(-1).hit, true, 'late hydration keeps the actual Send button under the held pointer');
          assert.equal(designActivation.at(-1).detachments, 0, 'late hydration must not detach the pressed form');
          assert.equal(designActivation.at(-1).draft, 'Selection fixture', 'late hydration preserves the entered draft');
          await page.evaluate(() => window.__designFormObserver.disconnect());
          await page.mouse.up();
        } else await page.locator('#btn-send').click();
      }
      const line = page.locator(paragraphs).filter({ hasText: 'Selectable line 020:' }).first();
      await line.waitFor();
      if (mode === 'design') assert.equal(server.requests.filter(request => request.path === '/api/agent/send').length, 1,
        'one real Send activation must admit exactly one simulated native turn');
      await page.waitForFunction(() => !document.body.classList.contains('chat-drop-anim') && !document.querySelector('.hero-ghost'));
      // Exercise reading while tokens arrive: real upward wheel input releases
      // automatic bottom following before positioning the target passage.
      await page.locator(scroller).hover({ position: { x: 200, y: 120 } });
      await page.mouse.wheel(0, -500);
      await line.evaluate(p => p.scrollIntoView({ block: 'center' }));
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await line.scrollIntoViewIfNeeded();
      await page.locator(paragraphs).filter({ hasText: 'Selectable line 018:' }).first().scrollIntoViewIfNeeded();
      await capture();
      // Begin inside a word, with the same gesture in both browsers. Chromium
      // collapses this diagonal gesture from the label's trailing space even
      // in a static DOM with no application scripts. Keep the complete
      // intervening-line oracle and use an unambiguous rendered glyph.
      const bottom = await point(line, 10), top = await point(page.locator(paragraphs).filter({ hasText: 'Selectable line 018:' }).first());
      assert.equal(await line.evaluate((node, p) => node.contains(document.elementFromPoint(p.x, p.y)), bottom), true, 'the real gesture starts on the visible text');
      await page.mouse.move(bottom.x, bottom.y); await page.mouse.down();
      await capture();
      await page.mouse.move(top.x, top.y, { steps: 12 });
      await page.mouse.up(); await capture();
      const selected = await page.evaluate(() => String(getSelection()));
      assert.ok(selected.includes('Selectable line 019'), 'actual upward mouse drag selects the intervening text');
      const beforeCount = count, readingTop = await page.locator(scroller).evaluate(node => node.scrollTop);
      await poll(() => count >= beforeCount + 3, 'fixture must keep generating while selection is held');
      await capture();
      assert.equal(await page.evaluate(() => String(getSelection())), selected, 'selection survives new streamed text');
      assert.ok(Math.abs(await page.locator(scroller).evaluate(node => node.scrollTop) - readingTop) <= 2, 'streaming does not pull the reader to the bottom');
      if (mode !== 'design') {
        await page.evaluate(() => getSelection().removeAllRanges());
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const code = page.locator(scroller + ' .md pre code').first();
        await code.evaluate(node => node.scrollIntoView({ block: 'center' }));
        await code.scrollIntoViewIfNeeded();
        const end = await point(code, -2), start = await point(code);
        await page.mouse.move(end.x, end.y); await page.mouse.down();
        await page.mouse.move(start.x, start.y, { steps: 12 }); await page.mouse.up();
        const codeSelection = await page.evaluate(() => String(getSelection()));
        assert.ok(codeSelection.includes('return 42;'), 'syntax-highlighted generated code is selectable with the mouse');
        const codeCount = count;
        await poll(() => count >= codeCount + 3, 'fixture continues during code selection');
        assert.equal(await page.evaluate(() => String(getSelection())), codeSelection, 'code selection survives new streamed text');
        await capture();
      }
      // Extend the selected passage beyond the visible top using real browser
      // drag autoscroll. No synthetic DOM Range is used to create selection.
      await page.evaluate(() => getSelection().removeAllRanges());
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await line.evaluate(p => p.scrollIntoView({ block: 'center' }));
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await line.scrollIntoViewIfNeeded();
      const anchor = await point(line, 10), box = await page.locator(scroller).boundingBox();
      assert.equal(await line.evaluate((node, p) => node.contains(document.elementFromPoint(p.x, p.y)), anchor), true,
        'autoscroll starts on the original visible line');
      const beforeDrag = await page.locator(scroller).evaluate(node => node.scrollTop);
      await page.mouse.move(anchor.x, anchor.y); await page.mouse.down();
      await page.evaluate(() => {
        const selection = getSelection();
        window.__selectionDragAnchor = { node: selection.anchorNode, offset: selection.anchorOffset };
      });
      assert.equal(await line.evaluate(node => node.contains(window.__selectionDragAnchor.node)), true,
        'the actual browser anchor belongs to the original line');
      await page.mouse.move(anchor.x, box.y + 2, { steps: 14 });
      for (let i = 0; i < 10; i++) { await page.waitForTimeout(100); await capture(); }
      await page.mouse.up(); await capture();
      const extended = await page.evaluate(() => String(getSelection()));
      assert.ok(extended.includes('Selectable line'), 'upward autoscroll keeps a text selection');
      assert.equal(await page.evaluate(() => getSelection().anchorNode === window.__selectionDragAnchor.node
        && getSelection().anchorOffset === window.__selectionDragAnchor.offset), true,
        'upward autoscroll preserves the exact original browser anchor');
      assert.ok(extended.includes('Selectable line 019'), 'the complete intervening line remains selected');
      const afterDrag = await page.locator(scroller).evaluate(node => node.scrollTop);
      assert.ok(afterDrag < beforeDrag - 20, `upward selection scrolls toward earlier text (${beforeDrag} -> ${afterDrag})`);
      const afterDragCount = count;
      await poll(() => count >= afterDragCount + 3, 'stream remains active after upward drag');
      assert.equal(await page.evaluate(() => String(getSelection())), extended, 'upward selection remains intact during more streaming');
      await capture();
      clearInterval(timer); working = false;
      if (response) sseDone(response);
      if (mode === 'tutor') {
        await page.waitForFunction(() => {
          const parent = JSON.parse(localStorage.getItem('ds4web.chats.v2')).chats.find(chat => chat.mode === 'roadmap');
          return Object.values(parent.messages[0].roadmapStudyThreads || {}).some(thread => thread.messages.at(-1)?.streaming === false);
        });
      } else await page.locator('#btn-stop').waitFor({ state: 'hidden' });
      await capture();
      assert.equal(await page.evaluate(() => String(getSelection())), extended, 'final commit also preserves the selected passage');
      await page.evaluate(() => getSelection().removeAllRanges());
      await page.waitForFunction(text => document.body.textContent.includes(text), `Stream addition ${String(count).padStart(3, '0')}`);
      await page.waitForFunction(({ mode, expected }) => {
        const chats = JSON.parse(localStorage.getItem('ds4web.chats.v2')).chats;
        const active = JSON.parse(localStorage.getItem('ds4web.active.v2')).ids;
        const chat = chats.find(chat => chat.id === active[mode === 'tutor' ? 'roadmap' : mode]);
        if (!chat) return false;
        const saved = mode === 'tutor' ? Object.values(chat.messages[0].roadmapStudyThreads || {})[0]?.messages.at(-1)?.content
          : mode === 'chat' ? chat.messages.at(-1)?.content : chat.transcript;
        return String(saved || '').trim() === expected.trim();
      }, { mode, expected: mode === 'chat' || mode === 'tutor' ? content : raw });
      const saved = await page.evaluate(mode => {
        const chats = JSON.parse(localStorage.getItem('ds4web.chats.v2')).chats;
        const active = JSON.parse(localStorage.getItem('ds4web.active.v2')).ids;
        const chat = chats.find(chat => chat.id === active[mode === 'tutor' ? 'roadmap' : mode]);
        if (mode === 'tutor') return Object.values(chat.messages[0].roadmapStudyThreads)[0].messages.at(-1).content;
        return mode === 'chat' ? chat.messages.at(-1).content : chat.transcript;
      }, mode);
      if (mode === 'chat' || mode === 'tutor') assert.equal(saved.trim(), content.trim(), 'every simulated text byte is persisted through a deferred repaint');
      else assert.equal(saved, raw, 'native transcript preserves every byte and protocol event');
      await capture();
      assert.deepEqual(evidence.errors, []); assert.deepEqual(evidence.external, []); assert.deepEqual(server.missing, []);
      receipt.cases.push({ name, status: 'PASS', streamedChunks: count, selected, extended, designActivation });
    } catch (error) {
      const persisted = await page.evaluate(() => ({ active: JSON.parse(localStorage.getItem('ds4web.active.v2') || 'null'), chats: JSON.parse(localStorage.getItem('ds4web.chats.v2') || 'null') }));
      receipt.cases.push({ name, status: 'FAIL', error: error.stack, ...evidence, designActivation, missing: server.missing, requests: server.requests,
        selection: await page.evaluate(() => String(getSelection())), persisted, expectedTranscript: raw });
      await capture();
    } finally {
      console.log(name + ': ' + receipt.cases.at(-1).status);
      fs.writeFileSync(path.join(dir, 'receipt.json'), JSON.stringify(receipt, null, 2));
      clearInterval(timer); response?.destroy();
      await page.close(); server.close();
      if (frame) execFileSync('python3', ['tests/support/encode_ui_gif.py', frames, path.join(dir, `${name}.gif`)]);
    }
  }
} finally {
  fs.writeFileSync(path.join(dir, 'receipt.json'), JSON.stringify(receipt, null, 2));
  console.log(`Selection GIFs and receipts: ${dir}`); await browser.close();
}
assert.ok(receipt.cases.length && receipt.cases.every(test => test.status === 'PASS'), 'Mouse selection regressions failed; see the retained receipt');

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.log('ui_roadmap_playwright_test: playwright missing, skipping');
  process.exit(0);
}

const repoRoot = process.cwd();
const webRoot = path.join(repoRoot, 'web');
const chatRequests = [];
const missingRequests = [];
let blockAttempts = 0;

const roadmap = {
  version: 1,
  title: 'Frontend moderno, dalle basi alla produzione',
  goal: 'Costruire e pubblicare un’applicazione web accessibile e ben testata.',
  audience: 'Principiante con familiarità generale con il computer',
  estimatedDuration: '12 settimane · 6 ore/settimana',
  assumptions: ['Nessuna esperienza professionale richiesta'],
  stages: [
    {
      id: 'web-foundations',
      title: 'Fondamenti del Web',
      description: 'Capire la piattaforma prima dei framework.',
      duration: '2 settimane',
      topics: [
        {
          id: 'html-semantics',
          title: 'HTML semantico',
          summary: 'Struttura documenti leggibili da persone, browser e tecnologie assistive.',
          outcome: 'Realizzi una pagina con una gerarchia semantica corretta.',
          practice: 'Ricrea la pagina di un articolo senza usare div per la struttura principale.',
          optional: false,
          resources: [{ title: 'MDN HTML', url: 'https://developer.mozilla.org/docs/Web/HTML', source: 'web' }],
        },
        {
          id: 'css-layout',
          title: 'CSS, Flexbox e Grid',
          summary: 'Separare contenuto e presentazione e costruire layout adattivi.',
          outcome: 'Riproduci un layout responsive senza coordinate rigide.',
          practice: 'Costruisci una dashboard che passa da tre colonne a una.',
          optional: false,
          resources: [],
        },
      ],
      checkpoint: 'Pubblica una pagina responsive e supera un controllo base di accessibilità.',
    },
    {
      id: 'javascript',
      title: 'JavaScript essenziale',
      description: 'Dati, funzioni, DOM e asincronia.',
      duration: '3 settimane',
      topics: [{
        id: 'js-dom', title: 'Dal linguaggio al DOM', summary: 'Usa JavaScript per modellare stato e interazioni.',
        outcome: 'Implementi un’interazione senza dipendenze.', practice: 'Crea una lista attività persistente.', optional: false, resources: [],
      }],
      checkpoint: 'Spiega il flusso evento → stato → rendering e lo implementa in un mini progetto.',
    },
    {
      id: 'framework',
      title: 'Framework e componenti',
      description: 'Applicare i fondamenti a un’architettura a componenti.',
      duration: '3 settimane',
      topics: [{
        id: 'component-state', title: 'Componenti e stato', summary: 'Dividi l’interfaccia lungo responsabilità verificabili.',
        outcome: 'Progetti componenti con dati e confini chiari.', practice: 'Migra la lista attività in componenti.', optional: false, resources: [],
      }],
      checkpoint: 'La stessa funzionalità è organizzata in componenti piccoli e testabili.',
    },
    {
      id: 'production',
      title: 'Qualità e produzione',
      description: 'Test, prestazioni e distribuzione.',
      duration: '4 settimane',
      topics: [{
        id: 'test-deploy', title: 'Test e deploy', summary: 'Proteggi i flussi critici e pubblica con una pipeline ripetibile.',
        outcome: 'L’app è verificata e raggiungibile online.', practice: 'Aggiungi test end-to-end e una build di produzione.', optional: false, resources: [],
      }],
      checkpoint: 'La pipeline esegue i test e distribuisce una versione funzionante.',
    },
  ],
  capstone: {
    title: 'Applicazione web completa',
    description: 'Progetta, testa e pubblica un prodotto piccolo ma utilizzabile.',
    successCriteria: ['Navigazione accessibile', 'Flusso principale coperto da test', 'Deploy riproducibile'],
  },
};

function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  if (url.pathname === '/api/status') {
    json(res, 200, {
      mode: 'server', running: true, ready: true, loadPct: 100, stage: 'Ready',
      agentWorking: false, workdir: '', ds4dirOk: true, webdirOk: true, lan: false,
      config: { ctx: 65536, power: 90, think: 'off', ssdStreaming: 'auto' },
      variants: { flash: true, pro: false }, variant: 'flash',
      modelFile: 'gguf/DeepSeek-V4-Flash-test.gguf', engineLine: 'ready',
    });
    return;
  }
  if (url.pathname === '/api/store') {
    if (req.method === 'POST') await readBody(req);
    json(res, 200, { ok: true, rev: 0, data: null });
    return;
  }
  if (url.pathname === '/api/storerev') { json(res, 200, { rev: 0 }); return; }
  if (url.pathname === '/api/ggufs') { json(res, 200, { ok: true, files: [] }); return; }
  if (url.pathname === '/api/engine/checkouts') { json(res, 200, { ok: true, checkouts: [] }); return; }
  if (url.pathname === '/api/doctor') { json(res, 200, { ok: true, issues: [], checks: [] }); return; }
  if (url.pathname === '/api/diagnostics') { json(res, 200, { ok: true, tasks: [], recentLogs: [] }); return; }
  if (url.pathname === '/api/remote/status') { json(res, 200, { ok: true, enabled: false }); return; }
  if (url.pathname === '/api/lan-client/chats') { json(res, 200, { ok: true, chats: [] }); return; }
  if ((url.pathname === '/api/vision/stop' || url.pathname === '/api/embed/stop') && req.method === 'POST') {
    json(res, 200, { ok: true, stopped: true });
    return;
  }
  if (url.pathname === '/v1/models') {
    json(res, 200, { data: [{ id: 'deepseek-v4-flash', context_length: 65536 }] });
    return;
  }
  if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
    const payload = JSON.parse(await readBody(req) || '{}');
    chatRequests.push(payload);
    const system = payload.messages?.find((message) => message.role === 'system')?.content || '';
    const isStudy = system.includes('dedicated long-term tutor for exactly one block');
    const isBlock = system.includes('DStudio roadmap-block expansion protocol');
    if (isBlock) blockAttempts += 1;
    const truncatedBlock = isBlock && blockAttempts === 1;
    const generatedBlock = {
      title: 'Accessibilità HTML',
      summary: 'Integra struttura semantica, nomi accessibili e navigazione da tastiera nel contesto HTML.',
      outcome: 'Realizzi e verifichi una pagina navigabile da tastiera con nomi accessibili corretti.',
      practice: 'Correggi una pagina non accessibile e documenta i test con tastiera e screen reader.',
      optional: false,
      resources: [{ title: 'MDN HTML', url: 'https://developer.mozilla.org/docs/Web/HTML', source: 'roadmap' }],
    };
    const studyLesson = [
      'Partiamo dall’intuizione e poi costruiamo un esempio concreto. Al termine farai un esercizio guidato e uno autonomo.',
      ...Array.from({ length: 28 }, (_, index) => `Passaggio ${index + 1}: collega la struttura semantica al comportamento osservabile e verifica il risultato con un esempio concreto.`),
      '<details><summary>Hint 1: struttura</summary>Apri prima `main`, poi aggiungi le sezioni semantiche.</details>',
    ].join('\n\n');
    const content = isStudy
      ? studyLesson
      : isBlock
        ? truncatedBlock
          ? '\`\`\`dstudio-roadmap-block\n{"title":"Accessibilità HTML","summary":"Bozza troncata"'
          : `\`\`\`dstudio-roadmap-block\n${JSON.stringify(generatedBlock)}\n\`\`\``
        : `Questo testo introduttivo non deve apparire.\n\n\`\`\`dstudio-roadmap\n${JSON.stringify(roadmap)}\n\`\`\``;
    const events = [
      `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: isStudy ? 'Valuto prerequisiti, difficoltà ed esercizio adatto al blocco.' : isBlock ? 'Valuto posizione, prerequisiti e risultato osservabile.' : 'Reasoning privato che la Roadmap non deve mostrare.' }, finish_reason: null }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: truncatedBlock ? 'length' : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 300, total_tokens: 400 } })}\n\n`,
      'data: [DONE]\n\n',
    ].join('');
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    if (isBlock) await new Promise((resolve) => setTimeout(resolve, 100));
    if (isStudy) {
      const finalEvent = events.lastIndexOf('data: ');
      res.write(events.slice(0, finalEvent));
      await new Promise((resolve) => setTimeout(resolve, 550));
      res.end(events.slice(finalEvent));
    } else {
      res.end(events);
    }
    return;
  }
  if (url.pathname === '/favicon.ico') { res.writeHead(204); res.end(); return; }

  const file = url.pathname === '/' ? path.join(webRoot, 'index.html') : path.join(webRoot, url.pathname);
  if (!file.startsWith(webRoot) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    missingRequests.push(`${req.method} ${url.pathname}`);
    res.writeHead(404);
    res.end('not found');
    return;
  }
  res.writeHead(200, { 'content-type': file.endsWith('.html') ? 'text/html' : 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

let browser;
try {
  browser = await chromium.launch();
} catch {
  server.close();
  console.log('ui_roadmap_playwright_test: browser missing, skipping');
  process.exit(0);
}

try {
  const page = await browser.newPage({ viewport: { width: 1360, height: 960 } });
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error?.stack || error?.message || String(error)));
  page.on('console', (msg) => { if (msg.type() === 'error') pageErrors.push(msg.text()); });
  await page.addInitScript(() => {
    const now = Date.now();
    localStorage.setItem('ds4web.settings.v2', JSON.stringify({
      v: 2, onboarded: true, theme: 'dark', baseUrl: '', chatBackend: 'local',
      model: 'deepseek-v4-flash', modelVariant: 'flash', thinkLevel: 'off',
      ctxSize: 65536, enginePower: 90, ssdStreaming: 'auto', webMode: 'off',
    }));
    localStorage.setItem('ds4web.chats.v2', JSON.stringify({
      v: 2, deleted: [], chats: [{
        id: 'chat-existing', mode: 'chat', title: 'Existing chat', createdAt: now, updatedAt: now, messages: [],
      }],
    }));
    localStorage.setItem('ds4web.active.v2', JSON.stringify({
      v: 2, ids: { chat: 'chat-existing', agent: null, design: null, roadmap: null },
    }));
  });

  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelector('#tab-server')?.classList.contains('tab--active'));
  await page.locator('#tab-roadmap').click();
  await page.locator('.roadmap-hero').waitFor({ state: 'visible' });
  assert.match(await page.locator('.roadmap-hero').textContent() || '', /What do you want to learn/);
  assert.equal(await page.locator('#roadmap-source-panel').isVisible(), true, 'Roadmap should expose PDF/link source controls');

  const think = page.locator('.cbar-think-btn--locked');
  await think.waitFor({ state: 'visible' });
  assert.match(await think.textContent() || '', /Thinking: max\s*locked/);
  await think.click();
  assert.equal(await page.locator('.cbar-think-menu').count(), 0, 'locked Roadmap thinking must not open a selector');

  await page.locator('#roadmap-url-input').fill('roadmap.sh/frontend');
  await page.locator('#roadmap-url-add').click();
  const sourceChip = page.locator('.roadmap-url-chip');
  await sourceChip.waitFor({ state: 'visible' });
  assert.match(await sourceChip.textContent() || '', /roadmap\.sh\/frontend/);
  await sourceChip.locator('.roadmap-url-chip__remove').click();
  assert.equal(await page.locator('.roadmap-url-chip').count(), 0);

  await page.locator('#composer-input').fill('Voglio imparare lo sviluppo frontend da zero in tre mesi.');
  await page.locator('#btn-send').click();
  const card = page.locator('.roadmap-card');
  await card.waitFor({ state: 'visible' });
  assert.equal(await page.locator('.scroll-down').count(), 0,
    'the chat scroll button must not cover the Roadmap dependency rail');

  assert.equal(chatRequests.length, 1, 'Roadmap prompt should produce one final model request');
  const request = chatRequests[0];
  assert.equal(request.stream, true);
  assert.equal(request.think, true, 'Roadmap must enable local model thinking even when global thinking is off');
  assert.equal(request.reasoning_effort, 'max', 'Roadmap must always request maximum reasoning effort');
  const system = request.messages.find((message) => message.role === 'system')?.content || '';
  assert.match(system, /DStudio learning-roadmap protocol/);
  assert.match(system, /Every roadmap generation MUST be completed with maximum reasoning effort/);
  assert.match(system, /with no prose before or after it/);
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('ds4web.settings.v2') || '{}').thinkLevel), 'off',
    'Roadmap max thinking should be a mode guarantee, not a mutation of the Chat preference');

  assert.equal(await page.locator('.messages__inner > .msg').count(), 1,
    'Roadmap workspace should show only the latest graph, not its chat transcript');
  assert.equal(await page.locator('.msg--roadmap-direct .msg__start').count(), 0, 'Roadmap should not show assistant chrome');
  assert.equal(await page.locator('.msg--roadmap-direct .thinking').count(), 0, 'Roadmap should not expose model reasoning');
  assert.equal(await page.locator('.msg--roadmap-direct > .msg__content').count(), 0, 'Roadmap should hide model prose outside the graph payload');
  assert.equal(await page.locator('.roadmap-card__head').count(), 0, 'Roadmap should start directly from the graph instead of a large summary header');
  assert.doesNotMatch(await page.locator('.msg--roadmap-direct').textContent() || '', /Questo testo introduttivo|Reasoning privato/);

  // Once generated, the Roadmap composer leaves only a small bottom handle.
  // Hover raises the whole form and leaving it lowers the form again.
  const roadmapComposer = page.locator('body.roadmap-mode:not(.composer-raised) .composer');
  const roadmapPeek = page.locator('#roadmap-composer-peek');
  await page.setViewportSize({ width: 1800, height: 960 });
  await page.mouse.move(12, 12);
  await page.waitForTimeout(500);
  const collapsedComposer = await roadmapComposer.evaluate((node) => {
    const box = node.getBoundingClientRect();
    const formBox = node.querySelector('#composer-form').getBoundingClientRect();
    const handleBox = node.querySelector('#roadmap-composer-peek').getBoundingClientRect();
    return {
      top: box.top, bottom: box.bottom, formTop: formBox.top,
      handleTop: handleBox.top, handleBottom: handleBox.bottom,
      viewport: innerHeight, transitionDuration: getComputedStyle(node).transitionDuration,
    };
  });
  assert.ok(collapsedComposer.top >= collapsedComposer.viewport - 64, 'only the composer peek should remain above the viewport edge');
  assert.ok(collapsedComposer.formTop >= collapsedComposer.viewport - 12,
    `only a small edge of the Roadmap form may remain visible: ${JSON.stringify(collapsedComposer)}`);
  assert.ok(collapsedComposer.handleTop < collapsedComposer.viewport && collapsedComposer.handleBottom <= collapsedComposer.viewport + 1,
    'the Roadmap prompt handle should remain visible while collapsed');
  assert.notEqual(collapsedComposer.transitionDuration, '0s', 'the Roadmap composer should move with an animation');

  await roadmapPeek.hover();
  await page.waitForTimeout(500);
  const raisedComposer = await roadmapComposer.evaluate((node) => {
    const box = node.getBoundingClientRect();
    const formBox = node.querySelector('#composer-form').getBoundingClientRect();
    const chatBox = node.closest('.chat').getBoundingClientRect();
    return { bottom: box.bottom, formTop: formBox.top, formWidth: formBox.width, chatWidth: chatBox.width, viewport: innerHeight };
  });
  assert.ok(raisedComposer.bottom <= raisedComposer.viewport + 1, 'hover should raise the complete composer into view');
  assert.ok(raisedComposer.formTop < raisedComposer.viewport - 80, 'hover should expose the editable Roadmap form');
  assert.ok(raisedComposer.formWidth >= raisedComposer.chatWidth * 0.9,
    'the open Roadmap composer should use almost all of the available workspace width');
  assert.equal(await roadmapPeek.getAttribute('aria-expanded'), 'true');

  await page.mouse.move(12, 80);
  await page.waitForTimeout(500);
  const loweredComposer = await roadmapComposer.evaluate((node) => ({
    top: node.getBoundingClientRect().top,
    formTop: node.querySelector('#composer-form').getBoundingClientRect().top,
    viewport: innerHeight,
  }));
  assert.ok(loweredComposer.top >= loweredComposer.viewport - 64, 'mouse leave should lower the composer again');
  assert.ok(loweredComposer.formTop >= loweredComposer.viewport - 12, 'mouse leave should hide the full form again');
  assert.equal(await roadmapPeek.getAttribute('aria-expanded'), 'false');
  await page.setViewportSize({ width: 1360, height: 960 });

  const cardVisual = await card.evaluate((node) => {
    const cardStyle = getComputedStyle(node);
    const stageStyle = getComputedStyle(node.querySelector('.roadmap-stage__node'));
    return {
      backgroundImage: cardStyle.backgroundImage,
      borderWidth: cardStyle.borderTopWidth,
      boxShadow: cardStyle.boxShadow,
      stageColor: stageStyle.backgroundColor,
    };
  });
  assert.equal(cardVisual.backgroundImage, 'none', 'the roadmap shell should not have a gradient');
  assert.equal(cardVisual.borderWidth, '0px', 'the roadmap should not sit inside a decorative card border');
  assert.equal(cardVisual.boxShadow, 'none', 'the roadmap should not sit inside a large card shadow');
  assert.notEqual(cardVisual.stageColor, 'rgb(253, 224, 71)', 'stage nodes should use the new restrained palette');

  const exportMenu = card.locator('.roadmap-export');
  assert.match(await exportMenu.locator('summary').textContent() || '', /Download roadmap/);
  assert.equal(await exportMenu.locator('.roadmap-export__menu').isVisible(), false,
    'download formats should stay in a compact menu until requested');
  await exportMenu.locator('summary').click();
  assert.deepEqual(await exportMenu.locator('.roadmap-export__ext').allTextContents(), ['PNG', 'PDF', 'JSON']);
  const jsonDownloadPromise = page.waitForEvent('download');
  await exportMenu.locator('.roadmap-export__option').filter({ hasText: 'JSON' }).click();
  const jsonDownload = await jsonDownloadPromise;
  assert.match(jsonDownload.suggestedFilename(), /frontend-moderno-dalle-basi-alla-produzione\.json$/);
  const jsonPath = await jsonDownload.path();
  assert.equal(JSON.parse(fs.readFileSync(jsonPath, 'utf8')).title, roadmap.title);
  await exportMenu.locator('summary').click();
  const exportCssSize = await card.evaluate((node) => ({ width: node.scrollWidth, height: node.scrollHeight }));
  const pngDownloadPromise = Promise.race([
    page.waitForEvent('download').then((download) => ({ download })),
    page.locator('.toast--error').waitFor({ state: 'visible', timeout: 30_000 })
      .then(async () => ({ error: await page.locator('.toast--error').last().textContent() })),
  ]);
  await exportMenu.locator('.roadmap-export__option').filter({ hasText: 'PNG' }).click();
  const pngResult = await pngDownloadPromise;
  assert.ok(pngResult.download, pngResult.error || 'PNG export did not start a download');
  const pngDownload = pngResult.download;
  assert.match(pngDownload.suggestedFilename(), /frontend-moderno-dalle-basi-alla-produzione\.png$/);
  const pngBytes = fs.readFileSync(await pngDownload.path());
  assert.equal(pngBytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'PNG export should contain a real image');
  const pngWidth = pngBytes.readUInt32BE(16);
  const pngHeight = pngBytes.readUInt32BE(20);
  assert.ok(pngWidth >= exportCssSize.width * 2.9 && pngHeight >= exportCssSize.height * 2.5,
    `PNG export should be rendered natively at high resolution: ${JSON.stringify({ exportCssSize, pngWidth, pngHeight })}`);
  await exportMenu.locator('summary').click();
  const pdfDownloadPromise = page.waitForEvent('download');
  await exportMenu.locator('.roadmap-export__option').filter({ hasText: 'PDF' }).click();
  const pdfDownload = await pdfDownloadPromise;
  assert.match(pdfDownload.suggestedFilename(), /frontend-moderno-dalle-basi-alla-produzione\.pdf$/);
  const pdfBytes = fs.readFileSync(await pdfDownload.path());
  assert.equal(pdfBytes.subarray(0, 5).toString('ascii'), '%PDF-', 'PDF export should contain a real PDF document');

  assert.equal(await card.locator('.roadmap-stage').count(), 4);
  assert.equal(await card.locator('.roadmap-topic').count(), 5);
  const layout = await card.evaluate((node) => {
    const rect = (selector) => {
      const r = node.querySelector(selector).getBoundingClientRect();
      return { left: r.left, right: r.right, width: r.width };
    };
    return {
      card: node.getBoundingClientRect().width,
      stage: rect('.roadmap-stage__node'),
      left: rect('.roadmap-topic--left'),
      right: rect('.roadmap-topic--right'),
    };
  });
  assert.ok(layout.card > 800, `Roadmap should use the available canvas: ${JSON.stringify(layout)}`);
  assert.ok(layout.left.right < layout.right.left, `Alternating branches should remain visually separated: ${JSON.stringify(layout)}`);
  const stageCenter = (layout.stage.left + layout.stage.right) / 2;
  assert.ok(layout.left.right < stageCenter && layout.right.left > stageCenter,
    `Topic branches should flank their stage dependency rail: ${JSON.stringify(layout)}`);

  const firstTopic = card.locator('.roadmap-topic[data-topic-id="html-semantics"]');
  await firstTopic.locator('.roadmap-topic__toggle').click();
  await firstTopic.locator('.roadmap-topic__detail').waitFor({ state: 'visible' });
  assert.match(await firstTopic.locator('.roadmap-topic__detail').textContent() || '', /Outcome:|Practice:/);
  await firstTopic.locator('.roadmap-topic__check').click();
  await page.waitForFunction(() => document.querySelector('.roadmap-topic[data-topic-id="html-semantics"]')?.classList.contains('is-complete'));
  await page.waitForTimeout(900);
  let saved = await page.evaluate(() => JSON.parse(localStorage.getItem('ds4web.chats.v2') || '{}'));
  const savedRoadmap = saved.chats?.find((chat) => chat.mode === 'roadmap');
  let savedReply = savedRoadmap?.messages?.find((message) => message.role === 'assistant');
  assert.equal(savedReply?.roadmapProgress?.['html-semantics'], true, 'Topic completion should persist in roadmap history');

  // Add a child on the same visual branch and verify the graph override is persisted.
  const addBranch = firstTopic.locator('.roadmap-node-action[aria-label^="Add a block"]');
  await addBranch.click();
  const addForm = firstTopic.locator('.roadmap-add');
  await addForm.locator('input.roadmap-add__input').fill('Accessibilità HTML');
  await addForm.locator('.roadmap-add__description').fill('Struttura, nomi accessibili e navigazione da tastiera.');
  await addForm.locator('button[type="submit"]').click();
  await addForm.locator('.roadmap-add__status').waitFor({ state: 'visible' });
  assert.match(await addForm.locator('.roadmap-add__status').textContent() || '', /Starting|Thinking|Writing/,
    'Add should visibly show that the model is elaborating the learner input');
  assert.equal(await addForm.locator('button[type="submit"]').isDisabled(), true,
    'Add should prevent duplicate submissions while the model is working');
  await page.waitForFunction(() => document.querySelectorAll('.roadmap-topic').length === 6);
  const customTopic = page.locator('.roadmap-topic[data-topic-id*="accessibilita-html"]');
  await customTopic.waitFor({ state: 'visible' });
  assert.equal(await customTopic.evaluate((node) => node.classList.contains('roadmap-topic--left')), true,
    'a child added to a topic should stay on the same branch');
  await page.waitForTimeout(900);
  saved = await page.evaluate(() => JSON.parse(localStorage.getItem('ds4web.chats.v2') || '{}'));
  savedReply = saved.chats?.find((chat) => chat.mode === 'roadmap')?.messages?.find((message) => message.role === 'assistant');
  const added = savedReply?.roadmapOverride?.stages?.[0]?.topics?.find((topic) => topic.title === 'Accessibilità HTML');
  assert.equal(added?.branch, 'left');
  assert.equal(added?.parentId, 'html-semantics');
  assert.match(added?.summary || '', /struttura semantica.*navigazione da tastiera/);
  assert.match(added?.outcome || '', /pagina navigabile da tastiera/);
  assert.match(added?.practice || '', /screen reader/);
  assert.equal(added?.resources?.[0]?.url, 'https://developer.mozilla.org/docs/Web/HTML');
  assert.equal(chatRequests.length, 3, 'adding a block should keep retrying after a truncated model response');
  const blockRequest = chatRequests[1];
  assert.equal(blockRequest.think, true, 'block expansion must enable model thinking');
  assert.equal(blockRequest.reasoning_effort, 'max', 'block expansion must always use maximum reasoning');
  assert.equal(blockRequest.max_tokens, 8192, 'block expansion should reserve a large output budget for max reasoning');
  const blockSystem = blockRequest.messages.find((entry) => entry.role === 'system')?.content || '';
  assert.match(blockSystem, /DStudio roadmap-block expansion protocol/);
  assert.match(blockSystem, /exactly one fenced block whose info string is dstudio-roadmap-block/);
  const blockUser = blockRequest.messages.find((entry) => entry.role === 'user')?.content || '';
  assert.match(blockUser, /Accessibilità HTML/);
  assert.match(blockUser, /Struttura, nomi accessibili e navigazione da tastiera/);
  assert.match(blockUser, /Fondamenti del Web/);
  assert.match(blockUser, /HTML semantico/);
  const blockPayload = JSON.parse(blockUser);
  assert.equal(blockPayload.roadmap.targetStage.id, 'web-foundations');
  assert.equal(blockPayload.roadmap.stages, undefined, 'block generation should not resend the entire roadmap graph');
  const retryRequest = chatRequests[2];
  assert.equal(retryRequest.max_tokens, 8192);
  assert.equal(retryRequest.reasoning_effort, 'max');
  const retryPayload = JSON.parse(retryRequest.messages.find((entry) => entry.role === 'user')?.content || '{}');
  assert.equal(retryPayload.retry.attempt, 2);
  assert.match(retryPayload.retry.failure, /token limit.*truncated/);
  assert.match(retryPayload.retry.previousDraft, /Bozza troncata/);

  // Reorder an existing block before another one with the native drag handle.
  const cssTopic = card.locator('.roadmap-topic[data-topic-id="css-layout"]');
  await cssTopic.locator('.roadmap-topic__drag').dragTo(firstTopic, { targetPosition: { x: 70, y: 2 } });
  await page.waitForFunction(() => document.querySelector('.roadmap-stage[data-stage-id="web-foundations"] .roadmap-topic')?.dataset.topicId === 'css-layout');
  await page.waitForTimeout(900);
  saved = await page.evaluate(() => JSON.parse(localStorage.getItem('ds4web.chats.v2') || '{}'));
  savedReply = saved.chats?.find((chat) => chat.mode === 'roadmap')?.messages?.find((message) => message.role === 'assistant');
  assert.deepEqual(savedReply?.roadmapOverride?.stages?.[0]?.topics?.slice(0, 2).map((topic) => topic.id), ['css-layout', 'html-semantics'],
    'dragging a block should persist its new prerequisite order');

  // Every block owns a dedicated Tutor room with a per-thread thinking choice.
  await firstTopic.locator('.roadmap-node-action[aria-label^="Study "]').click();
  const study = page.locator('#roadmap-study');
  await study.waitFor({ state: 'visible' });
  assert.match(await study.locator('.roadmap-study__title').textContent() || '', /HTML semantico/);
  const tutorThinking = study.locator('.roadmap-study__think');
  assert.equal(await tutorThinking.inputValue(), 'max', 'new Tutor rooms should start at max');
  await tutorThinking.selectOption('normal');
  assert.equal(await tutorThinking.inputValue(), 'normal', 'Tutor thinking should be selectable');
  assert.equal(await study.locator('.roadmap-study__head .roadmap-study__think').count(), 0,
    'Tutor thinking should live in the composer instead of being duplicated in the header');
  assert.equal(await study.locator('.roadmap-study__controls > .roadmap-study__think').count(), 1);
  assert.equal(await study.locator('.roadmap-study__model-host > #cbar-model').count(), 1,
    'Tutor should reuse the functional Chat model picker');
  const tutorLayout = await study.evaluate((node) => {
    const messages = node.querySelector('.roadmap-study__messages').getBoundingClientRect();
    const composer = node.querySelector('.roadmap-study__composer-inner').getBoundingClientRect();
    const form = node.querySelector('.roadmap-study__form');
    const input = node.querySelector('.roadmap-study__input');
    return {
      messagesCenter: messages.left + messages.width / 2,
      composerCenter: composer.left + composer.width / 2,
      messagesWidth: messages.width,
      composerWidth: composer.width,
      formRadius: getComputedStyle(form).borderRadius,
      inputBorder: getComputedStyle(input).borderTopWidth,
    };
  });
  assert.ok(Math.abs(tutorLayout.messagesCenter - tutorLayout.composerCenter) <= 1,
    'Tutor transcript and composer should share the same visual center');
  assert.equal(tutorLayout.messagesWidth, tutorLayout.composerWidth,
    'Tutor transcript and composer should use the same content measure');
  assert.equal(tutorLayout.formRadius, '20px', 'Tutor should use the normal floating rounded composer card');
  assert.equal(tutorLayout.inputBorder, '0px', 'Tutor input should be integrated into the composer card');
  assert.equal(await page.locator('.sidebar').evaluate((node) => getComputedStyle(node).display), 'none',
    'the focused study room must not show the conversation sidebar');
  await study.evaluate((node) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(['Appunti tutor: usa header, main e footer.'], 'appunti.txt', { type: 'text/plain' }));
    node.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: transfer }));
    node.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: transfer }));
    node.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
  });
  await study.locator('.roadmap-study__files .roadmap-study__file').waitFor({ state: 'visible' });
  assert.match(await study.locator('.roadmap-study__files').textContent() || '', /appunti\.txt/);
  await study.locator('.roadmap-study__input').fill('Fammi studiare questo argomento con un esercizio.');
  await study.locator('.roadmap-study__send').click();
  const tutorAnswer = study.locator('.roadmap-study-msg--assistant > .md');
  await tutorAnswer.waitFor({ state: 'visible' });

  // A streaming repaint must neither destroy an active text selection nor
  // force the learner back to the bottom after they scroll up.
  const tutorReadingPosition = await study.evaluate((node) => {
    const scroller = node.querySelector('.roadmap-study__scroll');
    const answer = node.querySelector('.roadmap-study-msg--assistant > .md');
    scroller.scrollTop = Math.min(110, Math.max(0, scroller.scrollHeight - scroller.clientHeight));
    scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: -320, bubbles: true }));
    const walker = document.createTreeWalker(answer, NodeFilter.SHOW_TEXT);
    const textNode = walker.nextNode();
    const range = document.createRange();
    range.setStart(textNode, 0);
    range.setEnd(textNode, Math.min(18, textNode.data.length));
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    return { top: scroller.scrollTop, selected: String(selection) };
  });
  assert.match(tutorReadingPosition.selected, /Partiamo/);
  await page.waitForTimeout(700);
  const tutorDuringSelection = await study.evaluate((node) => ({
    top: node.querySelector('.roadmap-study__scroll').scrollTop,
    selected: String(getSelection()),
  }));
  assert.equal(tutorDuringSelection.selected, tutorReadingPosition.selected,
    'Tutor streaming should not replace DOM nodes while the learner is selecting text');
  assert.ok(Math.abs(tutorDuringSelection.top - tutorReadingPosition.top) <= 2,
    'Tutor streaming should not pull a learner back to the bottom after scrolling up');
  await study.evaluate(() => getSelection()?.removeAllRanges());
  await study.locator('.roadmap-study__send:not([disabled])').waitFor({ state: 'visible' });
  await page.waitForTimeout(120);
  const tutorAfterSelection = await study.locator('.roadmap-study__scroll').evaluate((node) => node.scrollTop);
  assert.ok(Math.abs(tutorAfterSelection - tutorReadingPosition.top) <= 2,
    'the deferred final Tutor repaint should preserve the learner’s reading position');
  assert.match(await study.locator('.roadmap-study-msg--assistant .msg__start').textContent() || '', /DStudio Tutor.*Thinking: normal/);
  assert.match(await study.locator('.roadmap-study-msg--assistant .thinking').textContent() || '', /Valuto prerequisiti/,
    'the tutor should show and retain its Thinking, unlike the roadmap canvas');
  assert.match(await study.locator('.roadmap-study-msg--assistant').last().textContent() || '', /intuizione|esercizio guidato/);
  await study.locator('.roadmap-study-msg--assistant .md-details').waitFor({ state: 'visible' });
  assert.equal(await study.locator('.roadmap-study-msg--assistant').last().textContent().then((text) => text.includes('<details>')), false,
    'Tutor hints should render as collapsible controls instead of raw HTML tags');
  assert.equal(chatRequests.length, 4, 'the study room should issue its own tutor request');
  const studyRequest = chatRequests[3];
  assert.equal(studyRequest.think, true);
  assert.equal(studyRequest.reasoning_effort, 'high');
  const studySystem = studyRequest.messages.find((message) => message.role === 'system')?.content || '';
  assert.match(studySystem, /dedicated long-term tutor for exactly one block/);
  assert.match(studySystem, /guided exercises, then independent exercises/);
  assert.match(studySystem, /Current topic: HTML semantico/);
  assert.match(studySystem, /DStudio explanatory answer style/);
  assert.match(studySystem, /DStudio mathematical typesetting protocol/);
  assert.match(studySystem, /DStudio Tutor file output protocol/);
  const studyUser = studyRequest.messages.findLast((message) => message.role === 'user')?.content || '';
  assert.match(studyUser, /\[Attached study material\]/);
  assert.match(studyUser, /Appunti tutor: usa header, main e footer/);
  await study.locator('.roadmap-study__back').click();
  await study.waitFor({ state: 'hidden' });
  assert.equal(await page.locator('#cbar-right > #cbar-model').count(), 1,
    'closing Tutor should restore the shared model picker to the normal Chat composer');
  await card.waitFor({ state: 'visible' });
  await page.waitForTimeout(900);
  saved = await page.evaluate(() => JSON.parse(localStorage.getItem('ds4web.chats.v2') || '{}'));
  savedReply = saved.chats?.find((chat) => chat.mode === 'roadmap')?.messages?.find((message) => message.role === 'assistant');
  assert.equal(savedReply?.roadmapStudyThreads?.['topic:html-semantics']?.messages?.length, 2,
    'the block tutor transcript should persist with the roadmap');
  assert.equal(savedReply?.roadmapStudyThreads?.['topic:html-semantics']?.thinkLevel, 'normal',
    'the selected Tutor thinking level should persist with its block chat');
  assert.equal(savedReply?.roadmapStudyThreads?.['topic:html-semantics']?.messages?.[0]?.attachments?.[0]?.name, 'appunti.txt',
    'Tutor attachments should persist inside their block transcript');
  assert.match(savedReply?.roadmapStudyThreads?.['topic:html-semantics']?.messages?.[1]?.reasoning || '', /Valuto prerequisiti/,
    'tutor Thinking should persist with the block chat');

  // The sidebar now exposes rename without relying on a hidden double-click/right-click gesture.
  const activeSidebarChat = page.locator('.chat-item--active');
  await activeSidebarChat.hover();
  await activeSidebarChat.locator('.chat-item__rename').click();
  const renameInput = activeSidebarChat.locator('input[aria-label="Rename chat"]');
  await renameInput.fill('Frontend personale');
  await renameInput.press('Enter');
  await page.waitForFunction(() => document.querySelector('.chat-item--active .chat-item__title')?.textContent === 'Frontend personale');

  // Delete the custom block through the in-app confirmation flow.
  await customTopic.locator('.roadmap-node-action[aria-label^="Delete "]').click();
  await page.locator('#confirm-dialog[open]').waitFor({ state: 'visible' });
  await page.locator('#confirm-go').click();
  await page.waitForFunction(() => document.querySelectorAll('.roadmap-topic').length === 5);

  await page.setViewportSize({ width: 700, height: 900 });
  const mobile = await page.evaluate(() => {
    const cardRect = document.querySelector('.roadmap-card').getBoundingClientRect();
    const topics = [...document.querySelectorAll('.roadmap-topic')].map((node) => node.getBoundingClientRect());
    return {
      viewport: innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      cardLeft: cardRect.left,
      cardRight: cardRect.right,
      topicLefts: topics.slice(0, 2).map((rect) => Math.round(rect.left)),
    };
  });
  assert.ok(mobile.scrollWidth <= mobile.viewport + 1, `Roadmap must not overflow on mobile: ${JSON.stringify(mobile)}`);
  assert.ok(mobile.cardLeft >= -1 && mobile.cardRight <= mobile.viewport + 1, `Roadmap card must stay in the viewport: ${JSON.stringify(mobile)}`);
  assert.ok(Math.abs(mobile.topicLefts[0] - mobile.topicLefts[1]) <= 2,
    `Mobile branches should collapse onto one readable rail: ${JSON.stringify(mobile)}`);

  assert.deepEqual(pageErrors, [], `page errors: ${JSON.stringify({ pageErrors, missingRequests }, null, 2)}`);
  console.log('ui_roadmap_playwright_test: ok');
} finally {
  await browser.close().catch(() => {});
  server.close();
}

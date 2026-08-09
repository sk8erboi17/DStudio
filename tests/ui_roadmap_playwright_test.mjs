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
const webSearchRequests = [];
const webReadRequests = [];
const missingRequests = [];
const startRequests = [];
let blockAttempts = 0;
let roadmapAttempts = 0;
let activeContext = 65536;
let factFindingIssued = false;

const roadmapSources = [
  'https://developer.mozilla.org/en-US/docs/Learn_web_development',
  'https://web.dev/learn/',
  'https://www.w3.org/WAI/curricula/',
  'https://html.spec.whatwg.org/multipage/',
  'https://tc39.es/ecma262/',
];
const roadmapNoiseSources = [
  'https://github.com/example/course/pulls',
  'https://github.com/example/course/actions',
];
const topicSpecs = [
  ['html-semantics', 'HTML semantico'], ['css-layout', 'CSS, Flexbox e Grid'],
  ['web-accessibility', 'Accessibilità della piattaforma'], ['browser-network', 'Browser, HTTP e DevTools'],
  ['js-language', 'JavaScript: linguaggio e dati'], ['js-dom', 'Dal linguaggio al DOM'],
  ['async-events', 'Eventi, asincronia e richieste'], ['js-testing', 'Test automatici JavaScript'],
  ['component-state', 'Componenti e stato'], ['routing-data', 'Routing e caricamento dati'],
  ['forms-validation', 'Form, validazione e accessibilità'], ['framework-testing', 'Test dei componenti'],
  ['architecture-api', 'Architettura client e API'], ['auth-security', 'Autenticazione e sicurezza web'],
  ['observability-performance', 'Prestazioni e osservabilità'], ['ci-cd', 'CI/CD e qualità automatizzata'],
  ['deployment', 'Deploy riproducibile'], ['monitoring', 'Monitoraggio in produzione'],
  ['maintenance', 'Manutenzione ed evoluzione'], ['portfolio', 'Portfolio e comunicazione tecnica'],
];
const makeTopic = ([id, title], index) => ({
  id,
  title,
  summary: `${title} viene studiato nel punto in cui le dipendenze precedenti permettono di applicarlo con comprensione, non per imitazione.`,
  estimatedHours: 6 + (index % 3) * 2,
  prerequisites: index ? [topicSpecs[index - 1][0]] : [],
  keyConcepts: [`${title}: modello mentale`, `${title}: API e vincoli`, `${title}: errori comuni`],
  outcome: `Realizzi un artefatto verificabile che dimostra padronanza di ${title.toLowerCase()}.`,
  practice: `Costruisci una piccola funzionalità dedicata a ${title.toLowerCase()}, documenta le decisioni e correggi almeno un difetto osservato.`,
  assessment: `Spiega le scelte, supera una checklist funzionale e correggi una variante con un errore intenzionale relativo a ${title.toLowerCase()}.`,
  optional: false,
  resources: [{ title: ['MDN Learn', 'web.dev Learn', 'W3C Curricula'][index % 3], url: roadmapSources[index % 3], source: 'Deep Research', why: 'Fonte autorevole usata per scope, ordine ed esercizi.' }],
});
const stageSpecs = [
  ['web-foundations', 'Fondamenti del Web', 'Capire la piattaforma prima dei framework.', '2 settimane'],
  ['javascript', 'JavaScript essenziale', 'Dati, funzioni, DOM, asincronia e test.', '3 settimane'],
  ['framework', 'Framework e componenti', 'Applicare i fondamenti a un’architettura a componenti.', '3 settimane'],
  ['production-quality', 'Architettura e qualità', 'Integrare API, sicurezza, prestazioni e automazione.', '3 settimane'],
  ['production', 'Produzione e crescita', 'Distribuire, osservare, mantenere e comunicare il prodotto.', '3 settimane'],
];
const roadmap = {
  version: 2,
  title: 'Frontend moderno, dalle basi alla produzione',
  goal: 'Costruire e pubblicare un’applicazione web accessibile e ben testata.',
  audience: 'Principiante con familiarità generale con il computer',
  estimatedDuration: '12 settimane · 6 ore/settimana',
  assumptions: ['Nessuna esperienza professionale richiesta'],
  stages: stageSpecs.map(([id, title, description, duration], stageIndex) => ({
    id, title, description, duration,
    objectives: [`Integrare e verificare le competenze della fase ${title}.`],
    topics: topicSpecs.slice(stageIndex * 4, stageIndex * 4 + 4).map((topic, offset) => makeTopic(topic, stageIndex * 4 + offset)),
    checkpoint: `Completa un progetto integrato della fase ${title}, spiegalo e superane i controlli funzionali e qualitativi.`,
  })),
  capstone: {
    title: 'Applicazione web completa',
    description: 'Progetta, testa e pubblica un prodotto piccolo ma utilizzabile.',
    deliverables: ['Repository documentato con cronologia delle decisioni', 'Applicazione pubblicata con pipeline ripetibile'],
    successCriteria: ['Navigazione accessibile', 'Flusso principale coperto da test', 'Deploy riproducibile'],
  },
};
roadmap.stages[0].topics[0].practice = 'Create a document with several simultaneous main elements because HTML permits any number of main landmarks.';
const correctedRoadmap = JSON.parse(JSON.stringify(roadmap));
correctedRoadmap.stages[0].topics[0].practice = 'Create one semantic document with a single visible main landmark, validate it, and verify its accessibility tree.';
const shallowRoadmap = {
  version: 1,
  title: 'Frontend rapido',
  goal: 'Imparare il frontend.',
  audience: 'Principiante',
  estimatedDuration: '3 mesi',
  assumptions: ['Nessuna esperienza'],
  stages: [{
    id: 'basics', title: 'Basi', description: 'Una fase troppo generica.', duration: '3 mesi',
    topics: [{ id: 'html', title: 'HTML', summary: 'Impara HTML.', outcome: 'Conosci HTML.', practice: 'Crea una pagina.', optional: false, resources: [] }],
    checkpoint: 'Crea una pagina.',
  }],
  capstone: { title: 'Sito', description: 'Crea un sito.', successCriteria: ['Funziona'] },
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
      config: { ctx: activeContext, power: 90, think: 'off', ssdStreaming: 'auto' },
      variants: { flash: true, pro: false }, variant: 'flash',
      modelFile: 'gguf/DeepSeek-V4-Flash-test.gguf', engineLine: 'ready',
    });
    return;
  }
  if (url.pathname === '/api/start' && req.method === 'POST') {
    const payload = JSON.parse(await readBody(req) || '{}');
    startRequests.push(payload);
    if (Number(payload.ctx) > 0) activeContext = Math.round(Number(payload.ctx));
    json(res, 200, { ok: true, mode: 'server' });
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
  if (url.pathname === '/api/web-search' && req.method === 'POST') {
    const payload = JSON.parse(await readBody(req) || '{}');
    webSearchRequests.push(payload);
    json(res, 200, {
      ok: true,
      query: payload.query,
      sources: [...roadmapSources, ...roadmapNoiseSources].map((sourceUrl, index) => ({
        title: ['MDN Learn Web Development', 'web.dev Learn', 'W3C Digital Accessibility Curricula', 'WHATWG HTML Living Standard', 'ECMAScript Language Specification', 'Pull requests', 'Actions'][index],
        url: sourceUrl,
        content: ['Platform curriculum and prerequisites', 'Practice-oriented current web curriculum', 'Accessibility learning objectives and assessments', 'Normative HTML platform semantics and browser behavior', 'Normative JavaScript language semantics and execution model', 'Repository navigation', 'Repository automation navigation'][index],
      })),
    });
    return;
  }
  if (url.pathname === '/api/web-read' && req.method === 'POST') {
    const payload = JSON.parse(await readBody(req) || '{}');
    webReadRequests.push(payload);
    const index = Math.max(0, roadmapSources.indexOf(payload.url));
    const pages = [
      {
        title: 'MDN Learn Web Development',
        markdown: '# Learn Web Development\n\n' + 'Start with semantic HTML and CSS, then JavaScript, accessibility, testing, browser tools, network fundamentals, and deployment. Each module includes skills tests, challenges, debugging practice, explicit prerequisites, and an observable project outcome. '.repeat(6),
      },
      {
        title: 'web.dev Learn',
        markdown: '# web.dev Learn\n\n' + 'A practice-oriented curriculum covers HTML, CSS, JavaScript, performance, forms, testing, privacy, accessibility, and progressive enhancement with current browser guidance. Lessons connect concepts to exercises, browser verification, and production-quality deliverables. '.repeat(6),
      },
      {
        title: 'W3C Digital Accessibility Curricula',
        markdown: '# Digital Accessibility Curricula\n\n' + 'Learning objectives progress from foundations to design, development, testing, and organizational practice. Mastery is demonstrated through practical evaluation, accessible deliverables, prerequisite knowledge, and concrete checks with assistive technology. '.repeat(6),
      },
      {
        title: 'WHATWG HTML Living Standard',
        markdown: '# HTML Living Standard\n\n' + 'The normative platform reference defines document structure, semantic elements, forms, interaction, parsing, loading, and browser behavior. Use it to verify platform rules behind practical HTML exercises, implementation decisions, conformance checks, and debugging tasks. '.repeat(6),
      },
      {
        title: 'ECMAScript Language Specification',
        markdown: '# ECMAScript Language Specification\n\n' + 'The normative JavaScript reference defines values, objects, execution contexts, functions, modules, promises, and language semantics. It grounds prerequisite order, advanced lessons, precise reasoning, executable tests, implementation work, and explanations of edge cases. '.repeat(6),
      },
    ];
    json(res, 200, {
      ok: true,
      url: payload.url,
      canonicalUrl: payload.url,
      title: pages[index].title,
      sourceKind: 'docs',
      reader: 'browser',
      markdown: pages[index].markdown,
      excerpt: pages[index].markdown.replace(/^#.*\n+/, ''),
      metadata: { description: 'A dependency-aware frontend learning path.' },
    });
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
    const isClassifier = system.includes('DStudio search classifier');
    const isPicker = system.includes('DStudio source picker');
    const isBatchExtractor = system.includes('DStudio roadmap evidence extractor');
    const isExtractor = system.includes('DStudio evidence extractor');
    const isJudge = system.includes('DStudio research sufficiency judge');
    const isPlanner = system.includes('DStudio research action planner');
    const isResearchWriter = system.includes('DStudio Deep Research writer');
    const isRoadmap = system.includes('DStudio learning-roadmap protocol');
    const isFactAuditor = system.includes('DStudio roadmap factual auditor');
    const isCurriculumJudge = system.includes('DStudio roadmap curriculum judge');
    const isRoadmapRepairer = system.includes('DStudio roadmap repairer');
    if (isBlock) blockAttempts += 1;
    if (isRoadmap) roadmapAttempts += 1;
    const truncatedBlock = isBlock && blockAttempts === 1;
    const generatedBlock = {
      title: 'Accessibilità HTML',
      summary: 'Integra struttura semantica, nomi accessibili e navigazione da tastiera nel contesto HTML.',
      estimatedHours: 7,
      keyConcepts: ['Nomi accessibili', 'Navigazione da tastiera', 'Semantica HTML'],
      outcome: 'Realizzi e verifichi una pagina navigabile da tastiera con nomi accessibili corretti.',
      practice: 'Correggi una pagina non accessibile e documenta i test con tastiera e screen reader.',
      assessment: 'Supera una checklist WCAG mirata, spiega tre correzioni e dimostra il flusso completo da tastiera.',
      optional: false,
      resources: [{ title: 'MDN Learn', url: roadmapSources[0], source: 'roadmap', why: 'Riferimento già verificato nella roadmap.' }],
    };
    const studyLesson = [
      'Partiamo dall’intuizione e poi costruiamo un esempio concreto. Al termine farai un esercizio guidato e uno autonomo.',
      ...Array.from({ length: 28 }, (_, index) => `Passaggio ${index + 1}: collega la struttura semantica al comportamento osservabile e verifica il risultato con un esempio concreto.`),
      '<details><summary>Hint 1: struttura</summary>Apri prima `main`, poi aggiungi le sezioni semantiche.</details>',
    ].join('\n\n');
    const auditScope = payload.messages?.find((message) => message.role === 'user')?.content
      ?.match(/Audit scope:\s*(?:stage\s+)?([^\.\n]+)/i)?.[1]?.trim() || 'global';
    const content = isFactAuditor
      ? !factFindingIssued
        ? (() => {
            factFindingIssued = true;
            return JSON.stringify({
              scope: auditScope,
              pass: false,
              findings: [{
                location: 'web-foundations/html-semantics/practice',
                claim: 'HTML permits any number of simultaneous main landmarks.',
                verdict: 'incorrect',
                justification: 'A document must not expose multiple visible main landmarks with the same role.',
                correction: 'Use one visible main landmark and verify the accessibility tree.',
                confidence: 0.99,
              }],
            });
          })()
        : JSON.stringify({ scope: auditScope, pass: true, findings: [] })
      : isCurriculumJudge
        ? JSON.stringify({
            overall: 8.75,
            pass: true,
            dimensions: {
              coverage: 9, sequencing: 9, granularity: 8, practice: 9,
              assessment: 8, personalization: 8, sourceUse: 9, capstone: 9,
            },
            strengths: ['Progression is coherent and assessed through observable work.'],
            failures: [],
            reason: 'The curriculum is complete, sequenced, and actionable.',
          })
        : isRoadmapRepairer
          ? `\`\`\`dstudio-roadmap\n${JSON.stringify(correctedRoadmap)}\n\`\`\``
          : isClassifier
      ? JSON.stringify({
          needsSearch: true,
          intent: 'frontend_learning_roadmap',
          standaloneQuestion: 'Imparare lo sviluppo frontend da zero in tre mesi con un percorso completo e verificabile.',
          explicitUrls: [],
          queries: ['frontend official curriculum prerequisites', 'frontend learning projects assessment'],
        })
      : isPicker
        ? JSON.stringify({ reason: 'Triangulate official curriculum, current practice, and accessibility assessment.', urls: roadmapSources })
      : isBatchExtractor
        ? JSON.stringify({ facts: roadmapSources.flatMap((sourceUrl, index) => [
            { sourceId: `S${index + 1}`, fact: `Source ${index + 1} defines a prerequisite-aware progression for frontend mastery.`, confidence: 'high', excerpt: 'Progress from foundations to applied work.' },
            { sourceId: `S${index + 1}`, fact: `Source ${index + 1} requires practical challenges and observable deliverables.`, confidence: 'high', excerpt: 'Skills tests, challenges, and practical evaluation.' },
            { sourceId: `S${index + 1}`, fact: `Source ${index + 1} supports assessment across accessibility, testing, performance, or production practice.`, confidence: 'high', excerpt: sourceUrl },
          ]) })
      : isExtractor
        ? JSON.stringify({ facts: [
            { fact: 'The source defines a prerequisite-aware progression from platform foundations to applied production work.', confidence: 'high', excerpt: 'Start with semantic HTML and CSS, then JavaScript.' },
            { fact: 'The source includes practical challenges or deliverables instead of explanation alone.', confidence: 'high', excerpt: 'Each module includes skills tests and challenges.' },
            { fact: 'Accessibility, testing, performance, and deployment are part of a complete frontend curriculum.', confidence: 'high', excerpt: 'accessibility, testing, browser tools, network fundamentals, and deployment' },
            { fact: 'Mastery should be checked through practical evaluation and observable artifacts.', confidence: 'high', excerpt: 'Mastery is demonstrated through practical evaluation and accessible deliverables.' },
          ] })
      : isJudge
        ? JSON.stringify({ decision: 'enough', reason: 'Three independent authoritative sources cover ordering, practice, assessment, and current references.', gaps: [], queries: [], urls: [] })
      : isPlanner
        ? JSON.stringify({ action: 'done', reason: 'The evidence set is sufficient.', queries: [], urls: [] })
      : isResearchWriter
        ? '# Deliberately rejected mock synthesis\n\nThe deterministic grounded report should be used by the test.'
      : isStudy
      ? studyLesson
      : isBlock
        ? truncatedBlock
          ? '\`\`\`dstudio-roadmap-block\n{"title":"Accessibilità HTML","summary":"Bozza troncata"'
          : `\`\`\`dstudio-roadmap-block\n${JSON.stringify(generatedBlock)}\n\`\`\``
        : isRoadmap && roadmapAttempts === 1
          ? `\`\`\`dstudio-roadmap\n${JSON.stringify(shallowRoadmap)}\n\`\`\``
          : `Questo testo introduttivo non deve apparire.\n\n\`\`\`dstudio-roadmap\n${JSON.stringify(roadmap)}\n\`\`\``;
    if (payload.stream === false) {
      json(res, 200, { choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 40, completion_tokens: 80, total_tokens: 120 } });
      return;
    }
    const events = [
      `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: isStudy ? 'Valuto prerequisiti, difficoltà ed esercizio adatto al blocco.' : isBlock ? 'Valuto posizione, prerequisiti e risultato osservabile.' : 'Reasoning privato che la Roadmap non deve mostrare.' }, finish_reason: null }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: truncatedBlock ? 'length' : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 300, total_tokens: 400 } })}\n\n`,
      'data: [DONE]\n\n',
    ].join('');
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    if (isBlock) await new Promise((resolve) => setTimeout(resolve, 500));
    else if (!isStudy) await new Promise((resolve) => setTimeout(resolve, 1_300));
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
      webSearchBrowserAllowed: true,
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
  assert.equal(await page.locator('#roadmap-source-panel').count(), 0,
    'Roadmap should take source links from the prompt instead of exposing a duplicate URL field');
  assert.equal(await page.locator('#roadmap-composer-peek').count(), 1,
    'Roadmap should retain one visible prompt handle for raising and lowering the composer');
  assert.match(await page.locator('#roadmap-composer-peek').textContent() || '', /Roadmap prompt/);

  const think = page.locator('.cbar-think-btn--locked');
  await think.waitFor({ state: 'visible' });
  assert.match(await think.textContent() || '', /Thinking: max · 384k\+\s*locked/);
  await think.click();
  assert.equal(await page.locator('.cbar-think-menu').count(), 0, 'locked Roadmap thinking must not open a selector');

  await page.locator('#composer-input').fill('Voglio imparare lo sviluppo frontend da zero in tre mesi, con esercizi e verifiche pratiche.');
  assert.equal(await page.locator('#composer-form').evaluate((node) => getComputedStyle(node).boxShadow), 'none',
    'focusing the Roadmap composer must not add a selection shadow');
  await page.locator('#btn-send').click();
  const assembly = page.locator('.roadmap-build-assembly');
  await assembly.waitFor({ state: 'visible' });
  assert.equal(await assembly.locator('.roadmap-build-piece').count(), 4,
    'Roadmap loading should visibly assemble four connected graph pieces');
  assert.match(await page.locator('.roadmap-direct-loading__label').textContent() || '', /Deep researching your learning path|Building your roadmap/);

  // Sending must immediately lower the complete form while generation keeps
  // running. The small Roadmap prompt handle remains available, and Stop stays
  // mounted inside the lowered form without forcing that form back onscreen.
  await page.waitForFunction(() => !document.body.classList.contains('composer-raised'));
  await page.waitForTimeout(800);
  const streamingComposer = await page.locator('body.roadmap-mode:not(.composer-raised) .composer').evaluate((node) => {
    const peek = node.querySelector('#roadmap-composer-peek').getBoundingClientRect();
    const form = node.querySelector('#composer-form').getBoundingClientRect();
    const stop = node.querySelector('#btn-stop');
    return {
      peekTop: peek.top,
      peekBottom: peek.bottom,
      formTop: form.top,
      viewport: innerHeight,
      stopHidden: stop.hidden,
      expanded: node.querySelector('#roadmap-composer-peek').getAttribute('aria-expanded'),
    };
  });
  assert.ok(streamingComposer.peekTop >= streamingComposer.viewport - 64 && streamingComposer.peekBottom <= streamingComposer.viewport + 1,
    `only the Roadmap prompt handle should remain visible after Send: ${JSON.stringify(streamingComposer)}`);
  assert.ok(streamingComposer.formTop >= streamingComposer.viewport - 2,
    `the full composer should slide below the viewport after Send: ${JSON.stringify(streamingComposer)}`);
  assert.equal(streamingComposer.stopHidden, false,
    'Stop should remain available by raising the handle while generation is running');
  assert.equal(streamingComposer.expanded, 'false', 'sending should leave the prompt handle in its lowered state');

  const card = page.locator('.roadmap-card');
  await card.waitFor({ state: 'visible' });
  assert.equal(await page.locator('.scroll-down').count(), 0,
    'the chat scroll button must not cover the Roadmap dependency rail');

  const finalRoadmapRequests = chatRequests.filter((entry) =>
    (entry.messages?.find((message) => message.role === 'system')?.content || '').includes('DStudio learning-roadmap protocol')
  );
  const factualAuditRequests = chatRequests.filter((entry) =>
    (entry.messages?.find((message) => message.role === 'system')?.content || '').includes('DStudio roadmap factual auditor')
  );
  const curriculumJudgeRequests = chatRequests.filter((entry) =>
    (entry.messages?.find((message) => message.role === 'system')?.content || '').includes('DStudio roadmap curriculum judge')
  );
  const factualRepairRequests = chatRequests.filter((entry) =>
    (entry.messages?.find((message) => message.role === 'system')?.content || '').includes('DStudio roadmap repairer')
  );
  const roadmapResearchWriterRequests = chatRequests.filter((entry) =>
    (entry.messages?.find((message) => message.role === 'system')?.content || '').includes('DStudio Deep Research writer')
  );
  assert.equal(roadmapResearchWriterRequests.length, 0,
    'Roadmap should pass the complete deterministic evidence bundle directly to generation instead of writing a redundant prose report');
  assert.equal(finalRoadmapRequests.length, 2,
    'a shallow researched Roadmap should be rejected and regenerated automatically');
  assert.equal(factualAuditRequests.length, (roadmap.stages.length + 1) * 2,
    'every stage and the complete Roadmap must be audited again after a factual repair');
  assert.equal(factualRepairRequests.length, 1,
    'a high-confidence factual finding should trigger one complete-roadmap repair');
  assert.equal(curriculumJudgeRequests.length, 1,
    'curriculum quality must be judged in a separate pass after factual verification');
  assert.ok(factualAuditRequests.every((entry) => entry.reasoning_effort === 'max' && entry.max_tokens === undefined),
    'factual auditors must use uncapped Thinking max');
  assert.ok(curriculumJudgeRequests.every((entry) => entry.reasoning_effort === 'max' && entry.max_tokens === undefined),
    'the separate curriculum judge must use uncapped Thinking max');
  assert.ok(factualAuditRequests.every((entry) =>
    !(entry.messages?.find((message) => message.role === 'system')?.content || '').includes('curriculum judge')),
  'the factual auditor must not inherit curriculum-judging responsibilities');
  assert.ok(startRequests.some((entry) => entry.ctx === 393216),
    'Roadmap generation must temporarily restart local ds4 at the true-Max context threshold');
  assert.equal(JSON.parse(await page.evaluate(() => localStorage.getItem('ds4web.settings.v2'))).ctxSize, 65536,
    'the temporary Roadmap context must not overwrite the learner\'s normal Chat setting');
  assert.ok(webSearchRequests.length >= 4,
    'A Roadmap without links must still run broad Deep Research queries');
  assert.ok(webSearchRequests.every((entry) => entry.cdpOnly === true),
    'Every Roadmap search must be explicitly constrained to Chrome/CDP');
  assert.ok(webSearchRequests.every((entry) => entry.preferFallback !== true),
    'Roadmap search must never request the curl/RSS provider fallback chain');
  const researchedUrls = [...new Set(webReadRequests.map((entry) => entry.url))];
  assert.ok(researchedUrls.length >= 2,
    'Roadmap Deep Research should read more than one independently selected source');
  assert.ok(researchedUrls.every((url) => roadmapSources.includes(url)),
    'Roadmap Deep Research should read authoritative candidates rather than low-value navigation pages');
  assert.ok(new Set(researchedUrls.map((url) => new URL(url).hostname)).size >= 2,
    'Roadmap Deep Research should diversify the selected source hosts');
  assert.ok(webReadRequests.every((entry) => entry.cdpOnly === true),
    'Every Roadmap page read must be explicitly constrained to Chrome/CDP');
  const pickerRequest = chatRequests.find((entry) =>
    (entry.messages?.find((message) => message.role === 'system')?.content || '').includes('DStudio source picker')
  );
  const pickerCandidates = pickerRequest?.messages?.find((message) => message.role === 'user')?.content || '';
  assert.doesNotMatch(pickerCandidates, /github\.com\/example\/course\/(?:pulls|actions)/,
    'Low-value repository navigation pages must be removed before model source selection');
  const request = finalRoadmapRequests.at(-1);
  assert.equal(request.stream, true);
  assert.equal(request.think, true, 'Roadmap must enable local model thinking even when global thinking is off');
  assert.equal(request.reasoning_effort, 'max', 'Roadmap must always request maximum reasoning effort');
  assert.equal(request.max_tokens, undefined,
    'Roadmap must not impose an arbitrary output cap below the model physical context window');
  const system = request.messages.find((message) => message.role === 'system')?.content || '';
  const requestUser = request.messages.find((message) => message.role === 'user' && String(message.content || '').includes('[Roadmap research evidence]'))?.content || '';
  const repairUser = request.messages.findLast((message) => message.role === 'user')?.content || '';
  assert.match(system, /DStudio learning-roadmap protocol/);
  assert.match(system, /Every roadmap generation MUST be completed with maximum reasoning effort/);
  assert.match(system, /never start from a preset topic catalogue/);
  assert.match(system, /there is no target count, minimum count, maximum count, or uniform stage shape/);
  assert.doesNotMatch(system, /5-8 stages|18-32 topic|3-6 topics per stage/,
    'Roadmap shape must come from semantic scope instead of fixed stage or topic quotas');
  assert.match(system, /with no prose before or after it/);
  assert.doesNotMatch(system, /# Deep Research System Prompt|presenting that report directly/,
    'the generic long-report protocol must not conflict with the roadmap JSON protocol');
  assert.match(requestUser, /\[Roadmap research evidence\]/);
  assert.match(requestUser, /Grounded curriculum facts:/);
  assert.doesNotMatch(requestUser, /\[Synthesized research report\]|\[Deep research context\]/,
    'Roadmap generation should receive one compact, non-duplicated evidence bundle');
  assert.match(requestUser, /developer\.mozilla\.org|web\.dev|w3\.org/);
  assert.match(repairUser, /Roadmap quality repair/);
  assert.match(repairUser, /Re-evaluate granularity semantically/);
  assert.doesNotMatch(repairUser, /at least 5 purposeful stages|at least 18 learning topics|Every stage needs at least 3/);
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('ds4web.settings.v2') || '{}').thinkLevel), 'off',
    'Roadmap max thinking should be a mode guarantee, not a mutation of the Chat preference');

  assert.equal(await page.locator('.messages__inner > .msg').count(), 1,
    'Roadmap workspace should show only the latest graph, not its chat transcript');
  assert.equal(await page.locator('.msg--roadmap-direct .msg__start').count(), 0, 'Roadmap should not show assistant chrome');
  assert.equal(await page.locator('.msg--roadmap-direct .thinking').count(), 0, 'Roadmap should not expose model reasoning');
  assert.equal(await page.locator('.msg--roadmap-direct > .msg__content').count(), 0, 'Roadmap should hide model prose outside the graph payload');
  assert.equal(await page.locator('.roadmap-card__head').count(), 0, 'Roadmap should start directly from the graph instead of a large summary header');
  assert.doesNotMatch(await page.locator('.msg--roadmap-direct').textContent() || '', /Questo testo introduttivo|Reasoning privato/);

  // Once generated, only the dedicated Roadmap prompt handle remains visible.
  // Hover raises the real composer and mouse leave lowers it again.
  const roadmapComposer = page.locator('body.roadmap-mode:not(.composer-raised) .composer');
  await page.setViewportSize({ width: 1800, height: 960 });
  await page.mouse.move(12, 12);
  await page.waitForTimeout(500);
  const collapsedComposer = await roadmapComposer.evaluate((node) => {
    const box = node.getBoundingClientRect();
    const peekBox = node.querySelector('#roadmap-composer-peek').getBoundingClientRect();
    const formBox = node.querySelector('#composer-form').getBoundingClientRect();
    return {
      top: box.top, bottom: box.bottom, peekTop: peekBox.top, peekBottom: peekBox.bottom, formTop: formBox.top,
      viewport: innerHeight, transitionDuration: getComputedStyle(node).transitionDuration,
    };
  });
  assert.ok(collapsedComposer.top >= collapsedComposer.viewport - 64 && collapsedComposer.top < collapsedComposer.viewport - 32,
    `the Roadmap prompt handle should remain above the viewport edge: ${JSON.stringify(collapsedComposer)}`);
  assert.ok(collapsedComposer.peekTop >= collapsedComposer.viewport - 64 && collapsedComposer.peekBottom <= collapsedComposer.viewport + 1,
    'the visible slice should be the dedicated Roadmap prompt handle');
  assert.ok(collapsedComposer.formTop >= collapsedComposer.viewport - 2,
    'the full editable form should remain below the viewport until the handle is raised');
  assert.notEqual(collapsedComposer.transitionDuration, '0s', 'the Roadmap composer should move with an animation');

  const composerBox = await roadmapComposer.boundingBox();
  await page.mouse.move(composerBox.x + composerBox.width / 2, collapsedComposer.viewport - 24);
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
  assert.equal(await page.locator('#roadmap-composer-peek').getAttribute('aria-expanded'), 'true',
    'raising the handle should expose its expanded state');

  await page.mouse.move(12, 80);
  await page.waitForTimeout(500);
  const loweredComposer = await roadmapComposer.evaluate((node) => ({
    top: node.getBoundingClientRect().top,
    peekBottom: node.querySelector('#roadmap-composer-peek').getBoundingClientRect().bottom,
    formTop: node.querySelector('#composer-form').getBoundingClientRect().top,
    viewport: innerHeight,
  }));
  assert.ok(loweredComposer.top >= loweredComposer.viewport - 64, 'mouse leave should lower the composer again');
  assert.ok(loweredComposer.peekBottom <= loweredComposer.viewport + 1, 'mouse leave should keep only the handle visible');
  assert.ok(loweredComposer.formTop >= loweredComposer.viewport - 2, 'mouse leave should lower the full form again');
  assert.equal(await page.locator('#roadmap-composer-peek').getAttribute('aria-expanded'), 'false',
    'lowering the composer should restore the collapsed handle state');

  // The handle is also a real up/down toggle: a second click must lower the
  // form even while the pointer is still over the footer (hover cannot trap it).
  const promptHandle = page.locator('#roadmap-composer-peek');
  await promptHandle.click();
  await page.waitForTimeout(500);
  assert.equal(await roadmapComposer.evaluate((node) => node.classList.contains('is-roadmap-composer-pinned')), true,
    'clicking the collapsed Roadmap prompt handle should pin the composer open');
  await promptHandle.click();
  await page.waitForTimeout(500);
  const clickLoweredComposer = await roadmapComposer.evaluate((node) => ({
    formTop: node.querySelector('#composer-form').getBoundingClientRect().top,
    viewport: innerHeight,
    pinned: node.classList.contains('is-roadmap-composer-pinned'),
  }));
  assert.equal(clickLoweredComposer.pinned, false,
    'the down toggle should release the pinned state');
  assert.ok(clickLoweredComposer.formTop >= clickLoweredComposer.viewport - 2,
    'clicking the open Roadmap prompt handle should slide the complete form down');
  await page.mouse.move(12, 80);
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

  assert.equal(await card.locator('.roadmap-stage').count(), 5);
  assert.equal(await card.locator('.roadmap-topic').count(), 20);
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
  assert.match(await firstTopic.locator('.roadmap-topic__detail').textContent() || '', /Estimated effort:|Key concepts:|Outcome:|Practice:|Mastery check:/);
  await firstTopic.locator('.roadmap-topic__check').click();
  await page.waitForFunction(() => document.querySelector('.roadmap-topic[data-topic-id="html-semantics"]')?.classList.contains('is-complete'));
  await page.waitForTimeout(900);
  let saved = await page.evaluate(() => JSON.parse(localStorage.getItem('ds4web.chats.v2') || '{}'));
  const savedRoadmap = saved.chats?.find((chat) => chat.mode === 'roadmap');
  let savedReply = savedRoadmap?.messages?.find((message) => message.role === 'assistant');
  assert.equal(savedReply?.roadmapProgress?.['html-semantics'], true, 'Topic completion should persist in roadmap history');
  assert.equal(savedReply?.roadmapVerification?.status, 'verified',
    'the saved Roadmap should expose a completed factual and curriculum verification state');
  assert.equal(savedReply?.roadmapVerification?.repairRounds, 1,
    'the verification record should retain the factual repair round');
  assert.doesNotMatch(savedReply?.content || '', /HTML permits any number of simultaneous main landmarks/,
    'the persisted Roadmap should contain the repaired claim rather than the rejected draft');

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
  await page.waitForFunction(() => document.querySelectorAll('.roadmap-topic').length === 21);
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
  assert.equal(added?.resources?.[0]?.url, roadmapSources[0]);
  const blockRequests = chatRequests.filter((entry) =>
    (entry.messages?.find((message) => message.role === 'system')?.content || '').includes('DStudio roadmap-block expansion protocol')
  );
  assert.equal(blockRequests.length, 2, 'adding a block should keep retrying after a truncated model response');
  const blockRequest = blockRequests[0];
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
  const retryRequest = blockRequests[1];
  assert.equal(retryRequest.max_tokens, 8192);
  assert.equal(retryRequest.reasoning_effort, 'max');
  const retryPayload = JSON.parse(retryRequest.messages.find((entry) => entry.role === 'user')?.content || '{}');
  assert.equal(retryPayload.retry.attempt, 2);
  assert.match(retryPayload.retry.failure, /token limit.*truncated/);
  assert.match(retryPayload.retry.previousDraft, /Bozza troncata/);

  // Reorder an existing block before another one with the native drag handle.
  const cssTopic = card.locator('.roadmap-topic[data-topic-id="css-layout"]');
  await page.evaluate(() => {
    const source = document.querySelector('.roadmap-topic[data-topic-id="css-layout"] .roadmap-topic__drag');
    const target = document.querySelector('.roadmap-topic[data-topic-id="html-semantics"]');
    const transfer = new DataTransfer();
    source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: transfer }));
    const rect = target.getBoundingClientRect();
    target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: transfer, clientX: rect.left + 70, clientY: rect.top + 2 }));
    target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer, clientX: rect.left + 70, clientY: rect.top + 2 }));
    source.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: transfer }));
  });
  await page.waitForTimeout(900);
  const reorderedIds = await page.locator('.roadmap-stage[data-stage-id="web-foundations"] .roadmap-topic').evaluateAll((nodes) => nodes.map((node) => node.dataset.topicId));
  assert.equal(reorderedIds[0], 'css-layout', `dragging before the first topic should reorder the branch: ${JSON.stringify(reorderedIds)}`);
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
  const studyRequests = chatRequests.filter((entry) =>
    (entry.messages?.find((message) => message.role === 'system')?.content || '').includes('dedicated long-term tutor for exactly one block')
  );
  assert.equal(studyRequests.length, 1, 'the study room should issue its own tutor request');
  const studyRequest = studyRequests[0];
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
  await page.waitForFunction(() => document.querySelectorAll('.roadmap-topic').length === 20);

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

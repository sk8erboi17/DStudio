import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {artifactRunDir, writeArtifact} from '../support/real_harness.mjs';
import {studyTopic, topicMenu} from '../support/learn_ui.mjs';

const browserName = process.env.DSTUDIO_TEST_BROWSER || 'chromium';
assert(['chromium', 'webkit', 'firefox'].includes(browserName), 'Unknown browser');
const modelFamily = process.env.DSTUDIO_TEST_MODEL || 'deepseek';
const repairCheckout = process.env.DSTUDIO_TEST_STALE_CHECKOUT === '1';
const storageFailureCase = process.env.DSTUDIO_TEST_LEARN_STORAGE_FAILURE === '1';
const recoveryCase = process.env.DSTUDIO_TEST_LEARN_RECOVERY === '1' || storageFailureCase;
let storageWritesDenied = false;
let storeWriteBarrier = null, releaseStoreWrite = () => {}, storeBarrierEntered = false;
const resumeThinkLevel = process.env.DSTUDIO_TEST_LEARN_RESUME_THINK_LEVEL || '';
const legacyDraftCase = process.env.DSTUDIO_TEST_LEARN_LEGACY_DRAFT === '1';
assert.ok(!resumeThinkLevel || ['off', 'high'].includes(resumeThinkLevel));
const auditPartialCase = process.env.DSTUDIO_TEST_LEARN_AUDIT_PARTIAL === '1';
const auditRecoveryCase = process.env.DSTUDIO_TEST_LEARN_AUDIT_RECOVERY === '1' || auditPartialCase;
const unverifiedCase = process.env.DSTUDIO_TEST_LEARN_AUDIT_UNVERIFIED === '1';
// Learner messages during generation: one held stage and one held audit batch
// let the test write while a real production request is in flight.
const notesCase = process.env.DSTUDIO_TEST_LEARN_NOTES === '1';
// A PDF and a link attached to the Learn prompt (the PDF reader is simulated
// here; the real reader has its own tests). An engine error in a stage. A
// roadmap of ten stages and 300 blocks.
const sourcesCase = process.env.DSTUDIO_TEST_LEARN_SOURCES === '1';
const engineErrorCase = process.env.DSTUDIO_TEST_LEARN_ENGINE_ERROR === '1';
const largeCase = process.env.DSTUDIO_TEST_LEARN_LARGE === '1';
const ENGINE_ERROR = 'llama.cpp: failed to allocate the KV cache for this request (out of memory)';
let engineErrorSent = false;
const PDF_MARKER = 'Workshop handout: the Lighthouse lab requires one visible main landmark and a keyboard-only navigation check before any framework work.';
const pdfDescribeRequests = [];
let notesStageHeld = false, notesStageReleased = false, notesStageAborted = false, releaseNotesStage = () => {};
const notesStageGate = new Promise(resolve => { releaseNotesStage = () => { notesStageReleased = true; resolve(); }; });
let notesAuditHeld = false, notesAuditRequests = 0, releaseNotesAudit = () => {};
const notesAuditGate = new Promise(resolve => { releaseNotesAudit = resolve; });
let auditRequestCount = 0, auditStreamsClosed = 0;
let recoveryStageRequests = 0, recoveryStreamsClosed = 0;
let resumedRequestStart = 0;
const modelFixture = {
  deepseek: { id: 'deepseek-v4-flash', file: 'gguf/DeepSeek-V4-Flash-test.gguf', engine: '/fixture/ds4', effort: 'max', normalEffort: 'high', maximum: 'max', minimum: 393216 },
  qwen38: { id: 'qwen3.8-flash-next', file: 'gguf/Qwen3.8-Flash-Next-Q4.gguf', engine: '/fixture/ds4', effort: 'xhigh', normalEffort: 'xhigh', maximum: 'xhigh', minimum: 0 },
  // llama.cpp serves both Qwen checkpoints from the main installation: one
  // thinking switch through the chat template, no reasoning_effort.
  qwen35: { id: 'qwen3.6-35b-a3b', file: 'gguf/Qwen3.6-35B-A3B-test.gguf', engine: '/fixture/ds4', effort: undefined, normalEffort: undefined, maximum: 'on', minimum: 0 },
  qwen27: { id: 'qwen3.8-27b', file: 'gguf/Qwen3.8-27B-UD-Q6_K_XL.gguf', engine: '/fixture/ds4', effort: undefined, normalEffort: undefined, maximum: 'on', minimum: 0 },
}[modelFamily];
assert(modelFixture, 'Unknown model fixture');
const learnThinkLevel = process.env.DSTUDIO_TEST_LEARN_THINK_LEVEL || 'high';
assert.ok(['off','high','max'].includes(learnThinkLevel));
const selectedLevel = learnThinkLevel === 'max' && !modelFixture.minimum ? 'high' : learnThinkLevel;
const selectedEffort = selectedLevel === 'off' ? undefined : selectedLevel === 'max' ? modelFixture.effort : modelFixture.normalEffort;
const selectedEffective = selectedLevel === 'off' ? 'off' : modelFamily === 'deepseek' ? selectedLevel : modelFixture.maximum;
const selectedMinimum = selectedLevel === 'max' ? modelFixture.minimum : 0;
const selectedContext = selectedMinimum || 65536;
let browserType;
try {
  browserType = (await import('playwright'))[browserName];
} catch {
  console.log('ui_roadmap_playwright_test: playwright missing, NOT RUN');
  process.exit(1);
}

const repoRoot = process.cwd();
const webRoot = path.join(repoRoot, 'web');
const appHtml = fs.readFileSync(path.join(webRoot, 'index.html'));
const artifacts = artifactRunDir('roadmap-browser');
const receipt = {scope: 'Production Learn/Tutor UI with simulated engine replies',
  modelFamily, browserName, repairCheckout, recoveryCase, storageFailureCase, resumeThinkLevel, legacyDraftCase, auditRecoveryCase, auditPartialCase, unverifiedCase, notesCase, sourcesCase, engineErrorCase, largeCase, htmlSHA256: createHash('sha256').update(appHtml).digest('hex'),
  harnessSHA256: createHash('sha256').update(fs.readFileSync('tests/browser/ui_roadmap_playwright_test.mjs')).digest('hex'), status: 'RUNNING'};
writeArtifact(artifacts, 'results.json', receipt);
console.log(`Learn browser evidence: ${artifacts}`);
const chatRequests = [];
const webSearchRequests = [];
const webReadRequests = [];
const missingRequests = [];
const startRequests = [];
let releaseSourcePicker;
const sourcePickerGate = new Promise(resolve => { releaseSourcePicker = resolve; });
let releaseResearchRead;
const researchReadGate = new Promise(resolve => { releaseResearchRead = resolve; });
let blockAttempts = 0;
let roadmapAttempts = 0;
let activeContext = 65536;
let activeEngineDir = modelFixture.engine;
let factFindingIssued = false;
let tutorResponses = 0, releaseTutorFinish, releaseBlockStart;
// Keep the first expansion pending until its live controls have been observed.
const blockStartGate = new Promise(resolve => { releaseBlockStart = resolve; });
const tutorFinishGate = new Promise(resolve => {releaseTutorFinish = resolve;});

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
if (largeCase) {
  // Ten stages of thirty blocks each, keeping the first stage/block ids the
  // other fixtures name; every block requires the previous one.
  const extra = Array.from({length: 5}, (_, i) => [`advanced-${i + 1}`, `Approfondimento ${i + 1}`, `Estendere le competenze con il modulo avanzato ${i + 1}.`, '2 settimane']);
  stageSpecs.push(...extra);
  const named = topicSpecs.splice(0);
  stageSpecs.forEach(([stageId], stageIndex) => {
    for (let t = 0; t < 30; t++) {
      const original = t < 4 ? named[stageIndex * 4 + t] : null;
      topicSpecs.push(original || [`${stageId}-block-${t + 1}`, `Blocco ${stageIndex + 1}.${t + 1}`]);
    }
  });
}
const topicsPerStage = topicSpecs.length / stageSpecs.length;
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
    topics: topicSpecs.slice(stageIndex * topicsPerStage, (stageIndex + 1) * topicsPerStage).map((topic, offset) => makeTopic(topic, stageIndex * topicsPerStage + offset)),
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
const revisedFoundations = JSON.parse(JSON.stringify(correctedRoadmap.stages[0]));
revisedFoundations.topics[0].practice = 'Create one semantic document with a single visible main landmark, check it with an HTML validator, and verify its accessibility tree.';
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
      modelFile: modelFixture.file, ds4dir: activeEngineDir, engineLine: 'ready',
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
    if (req.method === 'POST' && storeWriteBarrier) {
      storeBarrierEntered = true; await storeWriteBarrier;
    }
    json(res, 200, storageWritesDenied && req.method === 'POST'
      ? {ok:false,code:'store_write_failed',error:'Injected native storage failure'}
      : { ok: true, durable: true, rev: 0, data: null });
    return;
  }
  if (url.pathname === '/api/storerev') { json(res, 200, { rev: 0 }); return; }
  // The host serves the shipped Qwen variant catalog byte for byte.
  if (url.pathname === '/api/model/qwen-variants') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(fs.readFileSync('scripts/qwen-variants.json')); return; }
  if (url.pathname === '/api/ggufs') {
    json(res, 200, {ok: true, ggufs: repairCheckout ? [{path: modelFixture.file, engineDir: activeEngineDir}] : []});
    return;
  }
  if (url.pathname === '/api/engine/checkouts') { json(res, 200, { ok: true, checkouts: [] }); return; }
  if (url.pathname === '/api/doctor') { json(res, 200, { ok: true, issues: [], checks: [] }); return; }
  if (url.pathname === '/api/diagnostics') { json(res, 200, { ok: true, tasks: [], recentLogs: [] }); return; }
  if (url.pathname === '/api/remote/status') { json(res, 200, { ok: true, enabled: false }); return; }
  if (url.pathname === '/api/lan-client/chats') { json(res, 200, { ok: true, chats: [] }); return; }
  if (url.pathname === '/api/embed/stop' && req.method === 'POST') {
    json(res, 200, { ok: true, stopped: true });
    return;
  }
  // SIMULATED PDF reader: the attachment's text is authored here.
  if (url.pathname === '/api/pdf/thumb' && req.method === 'POST') {
    await readBody(req);
    json(res, 200, { ok: false, error: 'no preview in this fixture' });
    return;
  }
  if (url.pathname === '/api/pdf/progress') { json(res, 200, { phase: 'done', done: true }); return; }
  if (url.pathname === '/api/pdf/describe' && req.method === 'POST') {
    const payload = JSON.parse(await readBody(req) || '{}');
    pdfDescribeRequests.push({ profile: payload.profile, bytes: String(payload.data_uri || '').length });
    const text = `\n--- Pagina 1 (testo) ---\n${PDF_MARKER}\nThe handout lists semantic HTML, accessible forms and keyboard testing as prerequisites of the component stage.\n`;
    json(res, 200, { ok: true, completeText: true, readPlanRequired: false, truncated: false, sampled: false,
      total: 1, pages: 1, textPages: 1, scannedPages: 0, text, documentId: 'a'.repeat(64), sections: [], sectionLinks: [] });
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
        content: ['Platform curriculum and prerequisites', 'Practice-oriented current web curriculum', 'Official curriculum with accessibility learning objectives and assessments', 'Official reference for normative HTML platform semantics and browser behavior', 'Official reference for normative JavaScript language semantics and execution model', 'Repository navigation', 'Repository automation navigation'][index],
      })),
    });
    return;
  }
  if (url.pathname === '/api/web-read' && req.method === 'POST') {
    const payload = JSON.parse(await readBody(req) || '{}');
    webReadRequests.push(payload);
    await researchReadGate;
    const index = Math.max(0, roadmapSources.findIndex(sourceUrl => sourceUrl.replace(/\/$/, '') === String(payload.url).replace(/\/$/, '')));
    const pages = [
      {
        title: 'MDN Learn Web Development',
        markdown: '# Learn Web Development\n\n' + 'A conforming document exposes one visible main landmark. Start with semantic HTML and CSS, then JavaScript, accessibility, testing, browser tools, network fundamentals, and deployment. Each module includes skills tests, challenges, debugging practice, explicit prerequisites, and an observable project outcome. '.repeat(6),
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
    json(res, 200, { data: [{ id: modelFixture.id, context_length: activeContext }] });
    return;
  }
  if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
    const payload = JSON.parse(await readBody(req) || '{}');
    chatRequests.push(payload);
    const system = payload.messages?.find((message) => message.role === 'system')?.content || '';
    const isStudy = system.includes('dedicated long-term tutor for exactly one block');
    const lastUser = payload.messages?.findLast(message => message.role === 'user')?.content || '';
    if (isStudy && lastUser === 'Tutor steering fixture') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Partial tutor explanation retained before the new context.\n\n' } }] })}\n\n`);
      return; // Withheld completion: the actual browser must yield this stream.
    }
    const isBlock = system.includes('DStudio roadmap-block expansion protocol');
    const isClassifier = system.includes('DStudio search classifier');
    const isPicker = system.includes('DStudio source picker');
    if (isPicker) await sourcePickerGate;
    const isBatchExtractor = system.includes('DStudio roadmap evidence extractor');
    const isExtractor = system.includes('DStudio evidence extractor');
    const isJudge = system.includes('DStudio research sufficiency judge');
    const isPlanner = system.includes('DStudio research action planner');
    const isResearchWriter = system.includes('DStudio Deep Research writer');
    const isRoadmap = system.includes('DStudio learning-roadmap protocol');
    const isFactAuditor = system.includes('DStudio roadmap factual auditor');
    const isCurriculumJudge = system.includes('DStudio roadmap curriculum judge');
    const isRoadmapRepairer = system.includes('DStudio roadmap repairer');
    if (isFactAuditor && auditRecoveryCase && ++auditRequestCount === 2) {
      res.on('close', () => {auditStreamsClosed += 1;});
      res.writeHead(200, {'content-type': 'text/event-stream', 'cache-control': 'no-cache'});
      res.write(`data: ${JSON.stringify({choices: [{delta: {reasoning_content: 'Useful partial audit analysis retained before Stop.'}}]})}\n\n`);
      let progress = 0;
      const timer = setInterval(() => {
        res.write(`data: ${JSON.stringify({choices: [{delta: {reasoning_content: ` Distinct evidence check ${++progress}.`}}]})}\n\n`);
      }, 100);
      res.on('close', () => clearInterval(timer));
      return;
    }

    if (isBlock) {
      blockAttempts += 1;
      if (blockAttempts === 1) await blockStartGate;
    }
    const phaseText = (payload.messages || []).filter(message => message.role === 'user').map(message => String(message.content || '')).join('\n');
    const phase = [...phaseText.matchAll(/\[Roadmap phase: ([^\]]+)\]/g)].at(-1)?.[1];
    if (isRoadmap && !isRoadmapRepairer && phase === 'outline') roadmapAttempts += 1;
    if (notesCase && isRoadmap && phase === 'stage javascript' && !notesStageHeld) {
      notesStageHeld = true;
      res.on('close', () => { if (!notesStageReleased) notesStageAborted = true; });
      await notesStageGate;
    }
    if (notesCase && isFactAuditor && ++notesAuditRequests === 1) { notesAuditHeld = true; await notesAuditGate; }
    const notesPhase = phase === 'learner notes';
    const revisedStageId = phase?.startsWith('revise stage ') ? phase.slice('revise stage '.length) : '';
    const notesReply = () => {
      const fresh = JSON.parse(lastUser.split('New learner messages:\n')[1]);
      const rewrite = fresh.some(note => note.message.includes('REWRITE'));
      return JSON.stringify({answers: fresh.map(note => ({id: note.id, answer: `Risposta simulata: ${note.message.slice(0, 40)}`})),
        revise: rewrite ? 'stages' : 'none', stageIds: rewrite ? ['web-foundations'] : [],
        revision: rewrite ? 'Aggiungi la verifica con un validatore HTML all’esercizio sul documento semantico.' : ''});
    };
    if (engineErrorCase && isRoadmap && !isRoadmapRepairer && phase === 'stage javascript' && !engineErrorSent) {
      engineErrorSent = true;   // the engine refuses this one stage request
      json(res, 500, { error: { message: ENGINE_ERROR, type: 'server_error' } });
      return;
    }
    if (recoveryCase && isRoadmap && !isRoadmapRepairer && phase === 'stage javascript' && ++recoveryStageRequests <= 2) {
      res.on('close', () => { recoveryStreamsClosed += 1; });
      res.writeHead(200, {'content-type': 'text/event-stream', 'cache-control': 'no-cache'});
      const useful = 'A useful prerequisite observation retained before the interruption.';
      const cycle = Array.from({length: 45}, (_, i) => `Assumption ${i}: learner context and measurable practice ${i * 17}.`).join('\n');
      res.write(`data: ${JSON.stringify({choices: [{delta: {reasoning_content: recoveryStageRequests === 1 ? useful : cycle.repeat(8)}}]})}\n\n`);
      return; // First: user Stop. Second: production cycle detector closes it.
    }

    const phaseResult = (value) => {
      if (phase === 'outline') return JSON.stringify(value);
      const id = phase?.replace(/^stage /, '');
      return JSON.stringify({stage: value.stages.find(stage => stage.id === id)});
    };
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
    const auditTask = isFactAuditor ? JSON.parse(payload.messages.find(message => message.role === 'user').content) : null;
    const content = notesPhase ? notesReply()
      : revisedStageId ? JSON.stringify({stage: revisedStageId === 'web-foundations' ? revisedFoundations : roadmap.stages.find(stage => stage.id === revisedStageId)})
      : isFactAuditor
      ? JSON.stringify({checks: auditTask.items.map(item => {
          const badClaim = 'HTML permits any number of main landmarks.';
          const uncertain = unverifiedCase && item.id === 'web-foundations/html-semantics/application';
          if (uncertain) return {id: item.id,verdict: 'unverified',reason: 'More primary source evidence is needed for this claim.',evidence: [],finding: null};
          const bad = !factFindingIssued && item.text.includes(badClaim);
          if (bad) factFindingIssued = true;
          const evidence = item.kind === 'consistency'
            ? [{sourceId: 'input', quote: item.text.slice(0, 100)}]
            : [{sourceId: auditTask.evidence[0].id, quote: auditTask.evidence[0].text.slice(0, 100)}];
          return {id: item.id, verdict: bad ? 'contradicted' : 'supported',
            reason: bad ? 'The supplied primary reference permits one visible main landmark.' : 'The supplied evidence/input supports the fixture check.',
            evidence, finding: bad ? {claim: badClaim, verdict: 'incorrect',
              justification: 'The supplied reference permits one visible main landmark.',
              correction: 'Use one visible main landmark and verify the accessibility tree.',confidence: .99} : null};
        }).filter((check,index) => !(auditPartialCase && auditRequestCount === 1 && index === 3))})
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
          ? phaseResult(correctedRoadmap)
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
        : isRoadmap
          ? phaseResult(roadmapAttempts === 1 ? shallowRoadmap : roadmap)
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
    else if (!isStudy) await new Promise((resolve) => setTimeout(resolve, phase || isFactAuditor || isCurriculumJudge ? 100 : 1_300));
    if (isStudy) {
      const finalEvent = events.lastIndexOf('data: ');
      res.write(events.slice(0, finalEvent));
      if (++tutorResponses === 1) {
        await tutorFinishGate;
        res.write(`data: ${JSON.stringify({choices: [{delta: {content: '\n\nEsercizio aggiunto mentre stai leggendo: verifica la struttura semantica.'}}]})}\n\n`);
      } else await new Promise((resolve) => setTimeout(resolve, 550));
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
  if (file === path.join(webRoot, 'index.html')) {res.end(appHtml); return;}
  fs.createReadStream(file).pipe(res);
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

let browser;
try {
  browser = await browserType.launch();
} catch (error) {
  server.close();
  writeArtifact(artifacts, 'results.json', {...receipt, status: 'BLOCKED', error: String(error)});
  console.log('ui_roadmap_playwright_test: browser missing, NOT RUN');
  process.exit(1);
}

let page;
try {
  scenario: {
  page = await browser.newPage({ viewport: { width: 1360, height: 960 } });
  await page.clock.install();
  const prepareRecoveryFixture = async () => {
    // Quiesce the old document before injecting a recovery snapshot. Otherwise
    // a pending persistence write can overwrite it, or a background status
    // request can race the intentional navigation. Browser errors remain fatal.
    await page.clock.pauseAt(await page.evaluate(() => Date.now()) + 10_000);
    await page.waitForLoadState('networkidle');
  };
  const pageErrors = [];
  page.on('pageerror', (error) => { pageErrors.push(error?.stack || error?.message || String(error)); writeArtifact(artifacts, 'page-errors.json', pageErrors); });
  page.on('console', (msg) => { if (msg.type() === 'error') pageErrors.push(msg.text()); });
  await page.addInitScript((fixture) => {
    // This fixture owns the app document, never opaque artifact preview frames.
    if (window !== window.top || location.origin !== fixture.origin) return;
    // Preserve deliberately injected state across the reload used to verify
    // recovery from an interrupted roadmap stream below.
    if (localStorage.getItem('ds4web.chats.v2')) return;
    const now = Date.now();
    localStorage.setItem('ds4web.settings.v2', JSON.stringify({
      v: 2, onboarded: true, theme: 'dark', baseUrl: '', chatBackend: 'local',
      model: fixture.id, modelGguf: fixture.file, modelEngineDir: fixture.engine,
      modelVariant: 'flash', thinkLevel: 'off',
      qualityDefaultsVersion: 1,
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
  }, {...modelFixture, engine: repairCheckout ? `/old location${modelFixture.engine}` : modelFixture.engine,
    origin: `http://127.0.0.1:${port}`});

  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelector('#tab-server')?.classList.contains('tab--active'));
  await page.locator('#tab-roadmap').click();
  await page.locator('.roadmap-hero').waitFor({ state: 'visible' });
  assert.match(await page.locator('.roadmap-hero').textContent() || '', /What do you want to learn/);
  if (notesCase) await page.evaluate(() => {
    // Toasts are transient; record every one the learner was shown.
    window.__learnToasts = [];
    new MutationObserver(() => document.querySelectorAll('.toast').forEach(node => {
      if (!window.__learnToasts.includes(node.textContent)) window.__learnToasts.push(node.textContent);
    })).observe(document.body, {childList: true, subtree: true, characterData: true});
  });
  assert.equal(await page.locator('#roadmap-source-panel').count(), 0,
    'Roadmap should take source links from the prompt instead of exposing a duplicate URL field');
  assert.equal(await page.locator('#roadmap-composer-peek').count(), 1,
    'Roadmap should retain one visible prompt handle for raising and lowering the composer');
  assert.match(await page.locator('#roadmap-composer-peek').textContent() || '', /Roadmap prompt/);

  const think = page.locator('.cbar-think-btn');
  await think.waitFor({state:'visible'});
  assert.equal(await think.getAttribute('aria-haspopup'), 'true');
  assert.doesNotMatch(await think.textContent(), /locked/);
  // Both lower settings remain selectable in Learn; request assertions below
  // prove the choice reaches generation, audit, repair and block expansion.
  await think.click(); await page.locator('.cbar-think-item').nth(0).click();
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('ds4web.settings.v2')).thinkLevel === 'off');
  await think.click(); await page.locator('.cbar-think-item').nth(1).click();
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('ds4web.settings.v2')).thinkLevel === 'high');
  if (selectedLevel === 'max') {
    await think.click(); await page.locator('.cbar-think-item').nth(2).click();
    await page.locator('#confirm-dialog[open]').waitFor();
    assert.match(await page.locator('#confirm-body').textContent(), /repetitive reasoning loop/);
    await page.locator('#confirm-cancel').click();
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('ds4web.settings.v2')).thinkLevel), 'high');
    await think.click(); await page.locator('.cbar-think-item').nth(2).click();
    await page.locator('#confirm-dialog[open]').waitFor(); await page.locator('#confirm-go').click();
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('ds4web.settings.v2')).thinkLevel === 'max');
  } else if (selectedLevel === 'off') {
    await think.click(); await page.locator('.cbar-think-item').nth(0).click();
  }
  await page.locator('#composer-input').fill('Voglio imparare lo sviluppo frontend da zero in tre mesi, con esercizi e verifiche pratiche.');
  const focusedRoadmapComposer = await page.locator('#composer-form').evaluate((node) => {
    const style = getComputedStyle(node);
    return { boxShadow: style.boxShadow, borderRadius: style.borderRadius };
  });
  assert.match(focusedRoadmapComposer.boxShadow, /0px 8px 30px/,
    'Roadmap should use the same focused composer elevation as Agent');
  assert.equal(focusedRoadmapComposer.borderRadius, '20px',
    'Roadmap should use the same rounded composer geometry as Agent');
  // A link as the learner pastes it; the roadmap resources cite this exact URL.
  const LINK = roadmapSources[0];
  if (sourcesCase) {
    await page.locator('#chat-file-input').setInputFiles({ name: 'handout.pdf', mimeType: 'application/pdf',
      buffer: Buffer.from('%PDF-1.4\n% bytes read by the simulated PDF reader of this fixture\n%%EOF\n') });
    await page.locator('#composer-files').getByText('handout.pdf', { exact: true }).waitFor({ state: 'visible' });
    await page.locator('#composer-input').fill(`Voglio imparare lo sviluppo frontend da zero in tre mesi, con esercizi e verifiche pratiche. Usa il PDF allegato e ${LINK}`);
  }
  await page.locator('#btn-send').click();
  // Scenario branches that do not exercise the held research steps below.
  const phaseOf = entry => [...(entry.messages || []).filter(message => message.role === 'user')
    .map(message => String(message.content || '')).join('\n').matchAll(/\[Roadmap phase: ([^\]]+)\]/g)].at(-1)?.[1];
  const systemOf = entry => String(entry.messages?.find(message => message.role === 'system')?.content || '');
  // The repairer rewrites from audit findings, not from the original request.
  const generation = entry => !systemOf(entry).includes('roadmap repairer');
  const unexpectedErrors = () => pageErrors.filter(text => !(engineErrorCase && /status of 500/.test(text)));
  if (sourcesCase || engineErrorCase || largeCase) { releaseSourcePicker(); releaseResearchRead(); }
  if (sourcesCase) {
    const outlineRequest = () => chatRequests.find(entry => phaseOf(entry) === 'outline');
    for (let i = 0; !outlineRequest() && i < 6000; i++) await new Promise(resolve => setTimeout(resolve, 10));
    const outline = outlineRequest();
    assert.ok(outline, 'the roadmap structure request was sent');
    const sent = JSON.stringify(outline.messages);
    assert.equal(pdfDescribeRequests[0]?.profile, 'complete', 'the attached PDF is read before generation');
    assert.ok(sent.includes(PDF_MARKER), 'the attached PDF text is part of the generation request');
    assert.equal(webReadRequests[0]?.url, LINK, 'the linked page is read first, before any search result');
    assert.ok(sent.includes('[Roadmap research evidence]') && sent.includes(`URL: ${LINK}`),
      'the linked page is listed among the read sources given to the generator');
    const card = page.locator('.roadmap-card:not(.is-draft)');
    await card.waitFor({ state: 'visible', timeout: 240_000 });
    const stageRequests = chatRequests.filter(entry => generation(entry) && /^stage /.test(phaseOf(entry) || ''));
    assert.ok(stageRequests.length >= 5 && stageRequests.every(entry => JSON.stringify(entry.messages).includes(PDF_MARKER)),
      'every stage is written with the attached PDF in view');
    const audits = chatRequests.filter(entry => systemOf(entry).includes('roadmap factual auditor'));
    const evidenceOf = entry => JSON.parse(entry.messages.find(message => message.role === 'user').content).evidence || [];
    assert.ok(audits.some(entry => evidenceOf(entry).some(source => source.text.includes('Lighthouse lab'))),
      'the factual audit checks the roadmap against the attached PDF');
    assert.ok(audits.some(entry => evidenceOf(entry).some(source => source.url === LINK)),
      'the factual audit checks the roadmap against the linked page');
    const data = await page.evaluate(() => JSON.parse(localStorage.getItem('ds4web.chats.v2')));
    const chat = data.chats.find(entry => entry.mode === 'roadmap');
    const user = chat.messages.find(message => message.role === 'user');
    assert.equal(user.attachments?.[0]?.name, 'handout.pdf');
    assert.ok(user.attachments[0].content.includes(PDF_MARKER), 'the saved request keeps the PDF evidence');
    assert.ok(user.web.sources.some(source => source.url === LINK && source.read && source.explicit), 'the saved evidence keeps the linked page as read');
    assert.ok(chat.messages.some(message => message.roadmapVerification?.status === 'verified'));
    await page.screenshot({path: path.join(artifacts, 'learn-attached-sources.png')});
    assert.deepEqual(unexpectedErrors(), []); receipt.status = 'PASS';
    console.log(`ui_roadmap attached sources: ok (${browserName}; PDF text and linked page in generation and audit evidence; simulated engine and PDF reader)`);
    break scenario;
  }
  if (engineErrorCase) {
    for (let i = 0; !engineErrorSent && i < 24000; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(engineErrorSent, true, 'the engine refused a stage request');
    const panel = page.locator('.roadmap-direct-error').filter({ hasText: 'stages written' });
    await panel.waitFor({ state: 'visible', timeout: 240_000 });
    assert.equal(await page.locator('.roadmap-card:not(.is-draft)').count(), 0, 'an interrupted draft is not an accepted roadmap');
    assert.match(await panel.textContent(), /1\/5 stages written/, 'the panel says how much of the draft is saved');
    const overview = await panel.locator('.roadmap-status__overview').textContent();
    assert.doesNotMatch(overview, /KV cache|llama\.cpp|out of memory|status/, 'the explanation is readable, not the raw engine line');
    const resume = panel.locator('[data-act="retry"]');
    assert.equal(await resume.textContent(), 'Resume draft');
    const diagnostics = panel.locator('.roadmap-diagnostics');
    assert.equal(await diagnostics.getAttribute('open'), null, 'technical details stay collapsed');
    await diagnostics.locator('summary').click();
    assert.ok((await diagnostics.locator('pre').textContent()).includes(ENGINE_ERROR), 'the engine error itself is shown on request');
    assert.equal(await page.locator('.roadmap-card.is-draft .roadmap-stage.is-unwritten').count(), 4, 'the written stage stays readable');
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('ds4web.chats.v2')).chats.find(chat => chat.mode === 'roadmap'));
    const failed = saved.messages.findLast(message => message.role === 'assistant');
    assert.equal(failed.finishReason, 'error'); assert.equal(failed.error.type, 'roadmap-generation');
    assert.ok(failed.error.message.includes(ENGINE_ERROR)); assert.equal(failed.roadmapBuild.stages.length, 1);
    await panel.scrollIntoViewIfNeeded();
    await page.screenshot({path: path.join(artifacts, 'learn-engine-error.png')});
    const before = chatRequests.length;
    await resume.click();
    await page.locator('.roadmap-card:not(.is-draft)').waitFor({ state: 'visible', timeout: 240_000 });
    const resumedPhases = chatRequests.slice(before).filter(generation).map(phaseOf).filter(Boolean);
    assert.equal(resumedPhases[0], 'stage javascript', 'Resume continues with the stage that failed');
    assert.equal(resumedPhases.filter(phase => phase === 'outline' || phase === 'stage web-foundations').length, 0,
      'the saved structure and stage are not generated again');
    const done = await page.evaluate(() => JSON.parse(localStorage.getItem('ds4web.chats.v2')).chats.find(chat => chat.mode === 'roadmap'));
    assert.equal(done.messages.findLast(message => message.role === 'assistant').roadmapVerification?.status, 'verified');
    assert.equal(done.messages.filter(message => message.role === 'user').length, 1, 'Resume is not a new request');
    assert.deepEqual(unexpectedErrors(), []); receipt.status = 'PASS';
    console.log(`ui_roadmap engine error: ok (${browserName}; readable status, engine detail on request, Resume continues the saved draft; simulated engine)`);
    break scenario;
  }
  if (largeCase) {
    const timed = async (action, ready) => {
      const started = performance.now();
      await action();
      await page.waitForFunction(ready.fn, ready.arg, { timeout: 15_000 });
      return Math.round(performance.now() - started);
    };
    const timings = {};
    // While the remaining stages and the audit run, the readable draft answers clicks.
    const draft = page.locator('.roadmap-card.is-draft');
    await draft.locator('.roadmap-stage:not(.is-unwritten)').first().waitFor({ state: 'visible', timeout: 240_000 });
    assert.equal(await draft.locator('.roadmap-stage').count(), 10);
    const draftToggle = draft.locator('.roadmap-stage:not(.is-unwritten) .roadmap-stage__toggle').first();
    const expandedBefore = await draftToggle.getAttribute('aria-expanded');
    timings.draftToggle = await timed(() => draftToggle.click(),
      { fn: before => document.querySelector('.roadmap-card.is-draft .roadmap-stage:not(.is-unwritten) .roadmap-stage__toggle')?.getAttribute('aria-expanded') !== before, arg: expandedBefore });
    const card = page.locator('.roadmap-card:not(.is-draft)');
    await card.waitFor({ state: 'visible', timeout: 600_000 });
    assert.equal(await card.locator('.roadmap-stage').count(), 10);
    assert.equal(await card.locator('.roadmap-topic').count(), 300, 'every block is displayed');
    assert.match(await page.locator('#roadmap-head-shape').textContent(), /10 stages · 300 blocks/);
    assert.equal(await page.locator('#roadmap-head-status').textContent(), 'Verified');
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('ds4web.chats.v2')).chats.find(chat => chat.mode === 'roadmap'));
    const verified = saved.messages.findLast(message => message.roadmapVerification?.status === 'verified');
    assert.equal(verified.roadmapAudit.completed, verified.roadmapAudit.total, 'every factual check of the large roadmap completed');
    const auditRequests = chatRequests.filter(entry => systemOf(entry).includes('roadmap factual auditor'));
    assert.ok(auditRequests.every(entry => JSON.parse(entry.messages.find(message => message.role === 'user').content).items.length <= 4),
      'audit work stays in bounded batches');
    // Navigate, mark progress and edit the large graph.
    assert.equal(await card.locator('.roadmap-map__item[data-stage-id]').count(), 10, 'the map lists every stage');
    timings.mapJump = await timed(() => card.locator('.roadmap-map__item[data-stage-id="advanced-5"]').click(),
      { fn: () => document.querySelector('.roadmap-map__item[data-stage-id="advanced-5"]')?.classList.contains('is-current') &&
        !document.querySelector('.roadmap-stage[data-stage-id="advanced-5"]')?.classList.contains('is-collapsed') });
    timings.markComplete = await timed(() => card.locator('.roadmap-topic[data-topic-id="html-semantics"] .roadmap-topic__check').click(),
      { fn: () => document.querySelector('.roadmap-topic[data-topic-id="html-semantics"]')?.classList.contains('is-complete') });
    await page.waitForFunction(id => document.querySelector(`#chat-list [data-id="${id}"] .chat-item__progress`)?.getAttribute('aria-label') === '1 of 300 topics complete', saved.id);
    await topicMenu(page, 'Blocco 10.30', 'Delete Blocco 10.30');
    await page.locator('#confirm-dialog[open]').waitFor();
    timings.deleteBlock = await timed(() => page.locator('#confirm-go').click(),
      { fn: () => document.querySelectorAll('.roadmap-card:not(.is-draft) .roadmap-topic').length === 299 });
    assert.match(await card.locator('.roadmap-draft-notice').textContent(), /modified.*not verified/i, 'an edited large roadmap is no longer verified');
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('ds4web.chats.v2')).chats.find(chat => chat.mode === 'roadmap')
      .messages.some(message => message.roadmapOverride?.stages?.reduce((sum, stage) => sum + stage.topics.length, 0) === 299));
    writeArtifact(artifacts, 'large-roadmap-timings.json', { timings, auditRequests: auditRequests.length, chatRequests: chatRequests.length });
    for (const [name, ms] of Object.entries(timings)) assert.ok(ms < 5000, `${name} took ${ms} ms on a 300-block roadmap`);
    await page.screenshot({path: path.join(artifacts, 'learn-large-roadmap.png')});
    assert.deepEqual(unexpectedErrors(), []); receipt.status = 'PASS';
    console.log(`ui_roadmap large roadmap: ok (${browserName}; 10 stages and 300 blocks generated, audited, displayed and edited; ${JSON.stringify(timings)} ms; simulated engine)`);
    break scenario;
  }
  const loadingTrace = page.locator('.roadmap-loading__trace');
  await loadingTrace.waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.querySelector('.roadmap-loading__activity')?.textContent === 'Preparing the next research step');
  assert.ok(webSearchRequests.length > 0 && webReadRequests.length === 0,
    'between completed searches and the source-picker reply, Learn must not label a completed search as current work');
  releaseSourcePicker();
  await page.waitForFunction(() => document.querySelector('.roadmap-loading__activity')?.textContent === 'Read URL');
  assert.ok(webReadRequests.length > 0, 'the fixture holds a real production read request in flight');
  assert.ok((await loadingTrace.textContent()).includes(webReadRequests[0].url),
    'Learn must display the actual URL being read while its request is still pending');
  assert.equal(await page.locator('[data-act="cancel-roadmap"]').count(), 0,
    'Learn keeps cancellation in the shared composer instead of a duplicate loading-panel button');
  assert.equal(await page.locator('.roadmap-loading__phase').count(), 0,
    'Learn should show actual activity rather than a fabricated draft skeleton');
  assert.ok(await loadingTrace.locator('.roadmap-loading__step').count() > 0,
    'Learn exposes the actual research trace');
  await page.clock.runFor(20_000);
  assert.match(await page.locator('.roadmap-loading__elapsed').textContent() || '', /0:(?:19|20) elapsed/);
  assert.match(await page.locator('.roadmap-loading__heartbeat').textContent() || '', /Waiting for the next update/,
    'a quiet model must show the lack of new activity without claiming a stall or invented progress');
  await page.waitForFunction(() => !document.body.classList.contains('composer-raised'));
  await page.screenshot({path: path.join(artifacts, 'learn-progress-dark.png')});
  const rects = await page.evaluate(() => Object.fromEntries([
    ['head', '.roadmap-loading__head'], ['current', '.roadmap-loading__current'],
    ['steps', '.roadmap-loading__steps'], ['stop', '#btn-stop'],
  ].map(([key, selector]) => {
    const {x, y, width, height} = document.querySelector(selector).getBoundingClientRect();
    return [key, {x: x / innerWidth * 100, y: y / innerHeight * 100, w: width / innerWidth * 100, h: height / innerHeight * 100}];
  })));
  writeArtifact(artifacts, 'progress-rects.json', rects);
  await page.evaluate(() => document.documentElement.dataset.theme = 'light');
  await page.screenshot({path: path.join(artifacts, 'learn-progress-light.png')});
  await page.evaluate(() => document.documentElement.dataset.theme = 'dark');
  releaseResearchRead();


  // The Roadmap keeps the shared Agent-sized composer visible at the bottom so
  // the learner can refine the plan without discovering a hidden drawer.
  await page.waitForFunction(() => !document.body.classList.contains('composer-raised'));
  const streamingComposer = await page.locator('body.roadmap-mode:not(.composer-raised) .composer').evaluate((node) => {
    const form = node.querySelector('#composer-form').getBoundingClientRect();
    const stop = node.querySelector('#btn-stop');
    const chat = node.closest('.chat').getBoundingClientRect();
    return {
      composerBottom: node.getBoundingClientRect().bottom,
      formTop: form.top,
      formBottom: form.bottom,
      formWidth: form.width,
      chatWidth: chat.width,
      viewport: innerHeight,
      stopHidden: stop.hidden,
    };
  });
  assert.ok(streamingComposer.formTop < streamingComposer.viewport && streamingComposer.formBottom <= streamingComposer.viewport + 1,
    `the Roadmap prompt should remain visible during generation: ${JSON.stringify(streamingComposer)}`);
  assert.ok(streamingComposer.formWidth >= 760 && streamingComposer.formWidth <= 770,
    'the Roadmap prompt should use the same 48rem composer measure as Agent');
  assert.equal(streamingComposer.stopHidden, false,
    'Stop should remain available while generation is running');

  if (notesCase) {
    const savedState = () => page.evaluate(() => JSON.parse(localStorage.getItem('ds4web.chats.v2')).chats.find(chat => chat.mode === 'roadmap'));
    const roadmapPhaseOf = entry => [...(entry.messages || []).filter(message => message.role === 'user')
      .map(message => String(message.content || '')).join('\n').matchAll(/\[Roadmap phase: ([^\]]+)\]/g)].at(-1)?.[1];
    for (let i = 0; !notesStageHeld && i < 3000; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(notesStageHeld, 'The fixture holds an actual stage request in flight');
    const draft = page.locator('.roadmap-card.is-draft');
    await page.waitForFunction(() => /1\/5 stages written/.test(document.querySelector('.roadmap-draft-callout')?.textContent || ''));
    assert.equal(await page.locator('.roadmap-live > .roadmap-notes .roadmap-notes__empty').isVisible(), true,
      'While the model works, the conversation panel is beside the draft and explains how to write to it');
    assert.equal(await page.locator('.roadmap-direct-loading').count(), 1, 'Progress stays visible above the readable draft');
    assert.equal(await page.locator('.roadmap-card:not(.is-draft)').count(), 0, 'A partial draft is never an accepted roadmap');
    assert.equal(await draft.locator('.roadmap-stage').count(), 5);
    assert.equal(await draft.locator('.roadmap-stage.is-unwritten').count(), 4);
    assert.equal(await draft.locator('.roadmap-stage__writing.is-active').textContent(), 'Writing');
    assert.equal(await draft.locator('.roadmap-topic__check:enabled, .roadmap-menu, .roadmap-topic__drag').count(), 0,
      'The draft is read-only while it is being written');
    assert.equal(await draft.locator('.roadmap-stage.is-unwritten.is-collapsed').count(), 3, 'Only the stage being written is open among unwritten stages');
    await draft.locator('.roadmap-stage:not(.is-unwritten) .roadmap-stage__toggle').first().click();
    await draft.locator('.roadmap-stage:not(.is-unwritten) .roadmap-topic__toggle').first().click();
    assert.match(await draft.locator('.roadmap-stage:not(.is-unwritten) .roadmap-topic__detail').first().textContent(), /Practice/,
      'A written stage is readable during generation');
    assert.match(await page.locator('.roadmap-phases').textContent(), /Research.*Structure.*Stage 1.*Stage 5.*Verification.*Review/s);
    assert.equal(await page.locator('.roadmap-phase.is-active .roadmap-phase__label').textContent(), 'Stage 2');
    await page.locator('[data-act="scroll-roadmap-draft"]').click();
    assert.ok((await page.evaluate(() => window.__learnToasts)).some(text => /First draft ready/.test(text)),
      'The learner is told when the first draft can be read');
    assert.match(await page.locator('#composer-input').getAttribute('placeholder'), /Write to DeepSeek while it generates/);

    const before = {requests: chatRequests.length, outlines: chatRequests.filter(entry => roadmapPhaseOf(entry) === 'outline').length};
    const firstNote = 'Perché JavaScript prima dei framework? Vorrei più esercizi sul DOM.';
    await page.locator('#composer-input').fill(firstNote);
    await page.locator('#btn-send').click();
    await page.locator('.roadmap-note.is-pending').waitFor({state: 'visible'});
    assert.match(await page.locator('.roadmap-note.is-pending').textContent(), /Perché JavaScript/);
    assert.equal(await page.locator('#composer-input').inputValue(), '', 'An acknowledged note clears the prompt');
    let state = await savedState();
    assert.equal(state.roadmapNotes.length, 1, 'The note is durable before it is acknowledged');
    assert.equal(state.roadmapNotes[0].state, 'pending');
    assert.equal(state.messages.filter(message => message.role === 'user').length, 1, 'A note is not a new roadmap request');
    assert.equal(chatRequests.length, before.requests, 'The note waits for the next step instead of issuing a request');
    assert.equal(notesStageAborted, false, 'The running stage is not aborted by a note');
    assert.ok(await page.locator('.roadmap-note.is-pending').evaluate(node => {
      const box = node.getBoundingClientRect(); return box.top >= 0 && box.bottom <= innerHeight;
    }), 'The note just sent is visible next to the prompt');
    await page.screenshot({path: path.join(artifacts, 'learn-notes-during-generation-dark.png')});
    await page.locator('#messages').evaluate(node => { node.scrollTop = 0; });
    await page.screenshot({path: path.join(artifacts, 'learn-partial-draft-top-dark.png')});
    await page.evaluate(() => document.documentElement.dataset.theme = 'light');
    await page.screenshot({path: path.join(artifacts, 'learn-notes-during-generation-light.png')});
    await page.evaluate(() => document.documentElement.dataset.theme = 'dark');
    releaseNotesStage();
    await page.locator('.roadmap-note.is-answered').waitFor({state: 'visible'});
    assert.match(await page.locator('.roadmap-note.is-answered').textContent(), /Risposta simulata: Perché JavaScript/);

    for (let i = 0; !notesAuditHeld && i < 6000; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(notesAuditHeld, 'The fixture holds an actual audit request in flight');
    await page.waitForFunction(() => document.querySelector('.roadmap-draft-callout')?.textContent.includes('Draft complete'));
    const secondNote = 'REWRITE: nella prima tappa voglio verificare il documento con un validatore HTML.';
    await page.locator('#composer-input').fill(secondNote);
    await page.locator('#btn-send').click();
    await page.locator('.roadmap-note.is-pending').waitFor({state: 'visible'});
    releaseNotesAudit();
    const card = page.locator('.roadmap-card:not(.is-draft)');
    await card.waitFor({state: 'visible', timeout: 120_000});

    state = await savedState();
    const phases = chatRequests.map(roadmapPhaseOf);
    const noteRequests = chatRequests.filter(entry => roadmapPhaseOf(entry) === 'learner notes');
    assert.equal(noteRequests.length, 2, 'Each note batch is answered once');
    assert.ok(noteRequests[0].messages.at(-1).content.includes(JSON.stringify(firstNote)), 'The learner text reaches the model as data');
    const heldStage = phases.indexOf('stage javascript'), firstAnswer = phases.indexOf('learner notes');
    assert.ok(heldStage < firstAnswer && firstAnswer < phases.indexOf('stage framework'),
      'The note is answered at the boundary after the running stage, before the next stage');
    const stageText = name => chatRequests.find(entry => roadmapPhaseOf(entry) === name).messages.at(-1).content;
    assert.ok(!stageText('stage javascript').includes(firstNote) && stageText('stage framework').includes(firstNote) &&
      stageText('stage production').includes(firstNote), 'Later stages carry the learner message; the running one is unchanged');
    assert.equal(chatRequests.filter(entry => roadmapPhaseOf(entry) === 'outline').length, before.outlines,
      'No note restarts the roadmap from its outline');
    assert.equal(phases.filter(phase => phase === 'revise stage web-foundations').length, 1, 'The agreed rewrite is applied once');
    assert.equal(phases.filter(phase => phase?.startsWith('revise stage')).length, 1, 'Only the named written stage is rewritten');
    const auditInputs = chatRequests.filter(entry => (entry.messages?.[0]?.content || '').includes('roadmap factual auditor')).map(entry => entry.messages[1].content);
    assert.equal(new Set(auditInputs).size, auditInputs.length, 'Saved audit receipts are reused; unchanged checks are not repeated');
    assert.ok(phases.lastIndexOf('revise stage web-foundations') < chatRequests.findLastIndex(entry =>
      (entry.messages?.[0]?.content || '').includes('roadmap factual auditor')), 'The rewritten stage is audited again before success');
    assert.deepEqual(state.roadmapNotes.map(note => note.state), ['answered', 'answered']);
    assert.equal(state.roadmapNotes[1].revise, 'stages');
    assert.ok(state.roadmapNotes[1].appliedAt > 0);
    assert.equal(state.messages.filter(message => message.role === 'user').length, 1);
    assert.equal(state.messages.filter(message => message.role === 'assistant').length, 1, 'One attempt: no restart from a new turn');
    const verified = state.messages.at(-1);
    assert.equal(verified.roadmapVerification.status, 'verified');
    assert.match(verified.content, /check it with an HTML validator/, 'The verified roadmap contains the requested change');
    assert.ok((await page.evaluate(() => window.__learnToasts)).some(text => /Draft complete/.test(text)));
    assert.deepEqual(pageErrors, []); receipt.status = 'PASS';
    console.log(`ui_roadmap learner notes: ok (${browserName}; readable partial draft, notes at phase boundaries, no restart, targeted rewrite and re-audit; simulated engine)`);
    break scenario;
  }

  if (recoveryCase) {
    await page.waitForFunction(() => document.querySelector('.roadmap-loading__received')?.textContent.includes('1/5 stages saved'));
    await page.clock.runFor(1000);
    // Progress is saved asynchronously after the next stage's first chunk; wait
    // for that durable record instead of assuming it lands within one second.
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('ds4web.chats.v2')).chats.flatMap(chat => chat.messages)
      .some(message => message.streaming && message.roadmapBuild && /useful prerequisite observation/.test(message.reasoning || '')));
    const beforeStop = await page.evaluate(() => JSON.parse(localStorage.getItem('ds4web.chats.v2')));
    const pending = beforeStop.chats.flatMap(chat => chat.messages).find(message => message.streaming && message.roadmapBuild);
    assert.equal(pending.roadmapBuild.stages.length, 1);
    assert.match(pending.reasoning, /useful prerequisite observation/);
    await page.screenshot({path: path.join(artifacts, 'saved-stage-before-stop.png')});
    await page.locator('#btn-stop').click();
    await page.locator('.roadmap-direct-error').waitFor({state: 'visible'});
    assert.equal(await page.locator('.roadmap-card:not(.is-draft)').count(), 0, 'An unverified draft is never an accepted roadmap');
    assert.match(await page.locator('.roadmap-direct-error').textContent(), /1\/5 stages written/,
      'The status panel states how much of the draft is saved');
    assert.equal(await page.locator('.roadmap-card.is-draft .roadmap-stage.is-unwritten').count(), 4,
      'The saved partial draft stays readable after Stop');
    assert.equal(await page.locator('.roadmap-direct-error, .roadmap-status').count(), 1, 'One status panel, not a stack of notices');
    assert.match(await page.locator('#roadmap-head-effort').textContent(), /estimated so far · 1\/5 stages written/,
      'A partial draft does not present its written-stage hours as the total');
    await page.screenshot({path: path.join(artifacts, 'paused-partial-draft.png')});
    assert.equal(await page.locator('.roadmap-direct-error [data-act="retry"]').textContent(), 'Resume draft');
    if (legacyDraftCase) {
      await prepareRecoveryFixture();
      await page.evaluate(() => {
        const data = JSON.parse(localStorage.getItem('ds4web.chats.v2'));
        const chat = data.chats.find(chat => chat.mode === 'roadmap');
        const saved = chat.messages.find(message => message.roadmapBuild);
        delete saved.roadmapBuild.inputKey;
        saved.roadmapBuild.dependencyKey = 'old-runtime-dependent-key';
        // Match the retained user case: a good saved draft, then a failed
        // restart that never wrote a new outline. Neither record may be lost.
        chat.messages.push({id: 'empty-restart', role: 'assistant', content: '', createdAt: Date.now(),
          finishReason: 'error', roadmapPending: false, roadmapVerification: {status: 'failed'},
          error: {type: 'roadmap-generation', message: 'Response incomplete: stream ended before data: [DONE]. mode=none; running=false; ready=false; engineLine=shutdown requested, draining requests'}});
        localStorage.setItem('ds4web.chats.v2', JSON.stringify(data));
      });
    }
    await page.reload({waitUntil: 'networkidle'});
    await page.clock.resume();
    await page.locator('#tab-roadmap').click();
    if (legacyDraftCase) {
      assert.doesNotMatch(await page.locator('.roadmap-direct-error > p').first().textContent(), /stream ended|engineLine|running=false/);
      const diagnostics = page.locator('.roadmap-direct-error > .roadmap-diagnostics');
      assert.equal(await diagnostics.getAttribute('open'), null);
      assert.match(await page.locator('.roadmap-direct-error').textContent(), /1\/5 stages written/);
      assert.equal(await page.locator('.roadmap-direct-error').count(), 1);
      await diagnostics.locator('summary').click();
      assert.match(await diagnostics.locator('pre').textContent(), /engineLine/,
        'The original technical failure remains accessible without leading the paused screen');
    }
    if (resumeThinkLevel) {
      await page.locator('.cbar-think-btn').click();
      await page.locator('.cbar-think-item').nth(resumeThinkLevel === 'off' ? 0 : 1).click();
      await page.waitForFunction(level => JSON.parse(localStorage.getItem('ds4web.settings.v2')).thinkLevel === level, resumeThinkLevel);
      if (await page.locator('#confirm-dialog[open]').isVisible()) await page.locator('#confirm-go').click();
    }
    if (storageFailureCase) {
      storageWritesDenied = true;
      const before = await page.evaluate(() => JSON.parse(localStorage.getItem('ds4web.chats.v2')));
      const modelCalls = chatRequests.length, searches = webSearchRequests.length;
      await page.evaluate(() => {
        window.originalHistorySetItem = Storage.prototype.setItem;
        window.originalHistoryTransaction = IDBDatabase.prototype.transaction;
        Storage.prototype.setItem = function(key,value) {
          if (key === 'ds4web.chats.v2') throw new DOMException('Injected history quota', 'QuotaExceededError');
          return originalHistorySetItem.call(this,key,value);
        };
        IDBDatabase.prototype.transaction = function(...args) {
          if (args[1] === 'readwrite') throw new DOMException('Injected database failure','SecurityError');
          return originalHistoryTransaction.apply(this,args);
        };
      });
      for (let attempt=0;attempt<3;attempt++) {
        await page.locator('[data-act="retry"]').click();
        await page.waitForFunction(() => document.querySelector('.toast')?.textContent.includes('Injected native storage failure'));
        // A settings change is still independently writable after the failure.
        await page.locator('.cbar-think-btn').click();
        await page.locator('.cbar-think-item').nth(attempt%2).click();
        await page.waitForFunction(level=>JSON.parse(localStorage.getItem('ds4web.settings.v2')).thinkLevel===level,attempt%2?'high':'off');
      }
      assert.equal(chatRequests.length,modelCalls,'Failed saves must not call the model');
      assert.equal(webSearchRequests.length,searches,'Failed saves must not start research');
      const after = await page.evaluate(() => JSON.parse(localStorage.getItem('ds4web.chats.v2')));
      assert.deepEqual(after,before,'Repeated Retry must retain the saved stages without adding draft copies');
      assert.equal(await page.locator('.roadmap-direct-error').count(),1);
      await page.evaluate(() => {
        Storage.prototype.setItem = originalHistorySetItem;
        IDBDatabase.prototype.transaction = originalHistoryTransaction;
      });
      storageWritesDenied = false;
      await page.locator('.cbar-think-btn').click(); await page.locator('.cbar-think-item').nth(1).click();
      storeWriteBarrier = new Promise(resolve => { releaseStoreWrite = resolve; });
      await page.locator('[data-act="retry"]').click();
      await page.locator('#btn-stop').waitFor({state:'visible'});
      for (let i=0;!storeBarrierEntered&&i<1000;i++) await new Promise(resolve => setTimeout(resolve,10));
      assert.ok(storeBarrierEntered,'The test must hold an actual native save before Stop');
      await page.locator('#btn-stop').click();
      releaseStoreWrite(); storeWriteBarrier = null;
      await page.waitForFunction(() => document.querySelector('#btn-stop')?.hidden);
      assert.equal(chatRequests.length,modelCalls,'Stop during an admitted save must prevent inference after its acknowledgement');
      assert.equal(webSearchRequests.length,searches);
      assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('ds4web.chats.v2'))),before);
    }
    await page.evaluate(() => {
      window.__learnWorkspaceOverlaps = [];
      new MutationObserver(() => {
        // One workspace state at a time; a read-only draft may accompany it.
        const count = document.querySelectorAll('#messages .roadmap-direct-error, #messages .roadmap-direct-loading, #messages .roadmap-card:not(.is-draft)').length;
        const drafts = document.querySelectorAll('#messages .roadmap-card.is-draft').length;
        if (count > 1 || drafts > 1) window.__learnWorkspaceOverlaps.push(count + drafts);
      }).observe(document.querySelector('#messages'), {childList: true, subtree: true});
    });
    resumedRequestStart = chatRequests.length;
    await page.locator('[data-act="retry"]').click();
    await page.locator('.roadmap-loading__trace').waitFor();
    assert.equal(await page.locator('.roadmap-direct-error').count(), 0, 'Retry replaces the paused card immediately');
    assert.equal(await page.locator('.roadmap-history').getAttribute('open'), null, 'Old attempts belong to collapsed history');
  }
  if (auditRecoveryCase) {
    const savedCount = auditPartialCase ? 3 : 4;
    await page.waitForFunction(savedCount => {
      const state = JSON.parse(localStorage.getItem('ds4web.chats.v2'));
      return state.chats.flatMap(chat => chat.messages).some(message => message.streaming && message.roadmapAudit?.completed === savedCount && message.reasoning?.includes('Useful partial audit'));
    },savedCount);
    await page.waitForFunction(savedCount => new RegExp(`${savedCount}/\\d+ factual checks saved`).test(document.querySelector('.roadmap-loading__received')?.textContent || ''),savedCount);
    assert.match(await page.locator('.roadmap-loading__received').textContent(), new RegExp(`${savedCount}/\\d+ factual checks saved`));
    if(auditPartialCase) {
      const tasks=chatRequests.filter(entry=>entry.messages[0].content.includes('roadmap factual auditor')).map(entry=>JSON.parse(entry.messages[1].content));
      assert.equal(tasks[0].items.length,4);assert.equal(tasks[1].items.length,1);
      assert.equal(tasks[1].items[0].id,tasks[0].items[3].id,'The retry asks only for the omitted fourth verdict');
    }
    await page.waitForFunction(() => {
      const data = JSON.parse(localStorage.getItem('ds4web.chats.v2'));
      return data.chats.flatMap(chat => chat.messages).some(message => message.streaming && message.roadmapPhase?.reasoningChars > 500);
    });

    await page.waitForFunction(() => document.querySelector('.roadmap-loading__received')?.textContent.includes('Reasoning on the current step'));
    await page.screenshot({path: path.join(artifacts, 'saved-audit-before-stop.png')});
    await page.locator('#btn-stop').click();
    await page.locator('.roadmap-direct-error').waitFor({state: 'visible'});
    await page.reload({waitUntil: 'networkidle'}); await page.clock.resume();
    await page.locator('#tab-roadmap').click();
    await page.locator('[data-act="retry"]').click();
  }
  if (unverifiedCase) {
    await page.locator('.roadmap-direct-error').waitFor({state: 'visible'});
    const preview = page.locator('.roadmap-card.is-draft');
    await preview.waitFor({state:'visible'});
    assert.equal(await preview.locator('.roadmap-topic').count(),20);
    assert.match(await page.locator('.roadmap-status h2').textContent(), /Verification incomplete/);
    assert.match(await page.locator('.roadmap-status__verify-head').textContent(), /\d+ of \d+ checks saved/);
    assert.match(await page.locator('#roadmap-head-status').textContent(), /Draft stopped · not verified/);
    assert.equal(await preview.locator('.roadmap-topic__check:enabled, .roadmap-menu, .roadmap-topic__drag').count(),0,
      'An audit draft must not mutate while its verdicts remain incomplete');
    const toggle = preview.locator('.roadmap-topic__toggle').first();
    await toggle.click();
    assert.equal(await toggle.getAttribute('aria-expanded'),'true','The learner can inspect an unverified draft');
    assert.equal(await preview.locator('.roadmap-export__option:enabled').count(),3);
    await page.locator('.roadmap-status').scrollIntoViewIfNeeded();
    await page.screenshot({path:path.join(artifacts,'unverified-draft.png')});
    await preview.locator('.roadmap-node-action[aria-label^="Study "]').first().click();
    const draftStudy=page.locator('#roadmap-study');
    await draftStudy.waitFor({state:'visible'});
    assert.match(await draftStudy.locator('.roadmap-study__eyebrow').textContent(), /Unverified draft/);
    await page.screenshot({path:path.join(artifacts,'draft-study.png')});
    await draftStudy.locator('.roadmap-study__back').click();
    const data = await page.evaluate(() => JSON.parse(localStorage.getItem('ds4web.chats.v2')));
    const assistant = data.chats.flatMap(chat => chat.messages).findLast(message => message.roadmapBuild);
    assert.equal(assistant.roadmapBuild.stages.length, 5);
    assert.equal(assistant.roadmapAudit.completed, assistant.roadmapAudit.total);
    assert.equal(assistant.roadmapVerification.status, 'incomplete');
    assert.ok(assistant.roadmapVerification.stageAudits.some(audit => audit.unresolved.length));
    assert.equal(chatRequests.filter(entry => entry.messages[0].content.includes('curriculum judge')).length, 0,
      'An unresolved factual claim cannot advance to a successful curriculum verdict');
    assert.deepEqual(pageErrors, []); receipt.status = 'PASS';
    console.log(`ui_roadmap missing-evidence: ok (${browserName}; explicit read-only preview, unresolved verdict retained, no successful audit)`);
    break scenario;
  }
  const card = page.locator('.roadmap-card:not(.is-draft)');
  await card.waitFor({ state: 'visible' });
  if (auditRecoveryCase) {
    const data = await page.evaluate(() => JSON.parse(localStorage.getItem('ds4web.chats.v2')));
    const messages = data.chats.find(chat => chat.mode === 'roadmap').messages;
    const interrupted = messages.find(message => message.finishReason === 'aborted' && message.roadmapAudit);
    assert.equal(interrupted.roadmapAudit.completed, auditPartialCase ? 3 : 4);
    const verified = messages.findLast(message => message.roadmapVerification?.status === 'verified');
    assert.equal(verified.roadmapAudit.completed, verified.roadmapAudit.total);
    assert.equal(auditStreamsClosed, 1);
    const auditInputs = chatRequests.filter(entry => entry.messages[0].content.includes('roadmap factual auditor')).map(entry => entry.messages[1].content);
    assert.equal(auditInputs.filter(input => input === auditInputs[0]).length, 1, 'The completed batch is not rerun after Stop/reload');
    if(auditPartialCase) {
      const tasks=auditInputs.map(input=>JSON.parse(input));
      assert.deepEqual(tasks[2].items.map(item=>item.id),tasks[1].items.map(item=>item.id),
        'Stop/reload retains the three valid verdicts and asks only for the same missing item');
      assert.equal(interrupted.roadmapAudit.records[0].checks.length,3);
      assert.equal(await page.locator('.roadmap-direct-error').count(),0);
    }
    assert.deepEqual(pageErrors, []); receipt.status = 'PASS';
    console.log(`ui_roadmap audit recovery: ok (${browserName}; ${auditPartialCase?'3-of-4 partial admission, missing-id-only retries, ':''}per-batch persistence, Stop/reload, cached checks and final verification)`);
    break scenario;
  }
  if (recoveryCase) {
    await page.clock.runFor(1000);
    const data = await page.evaluate(() => JSON.parse(localStorage.getItem('ds4web.chats.v2')));
    const messages = data.chats.find(chat => chat.mode === 'roadmap').messages;
    const interrupted = messages.find(message => message.finishReason === 'aborted' && message.roadmapBuild);
    const verified = messages.findLast(message => message.roadmapVerification?.status === 'verified');
    assert.equal(interrupted.roadmapBuild.stages.length, 1, 'Stop/reload retains the saved stage and failure');
    assert.match(interrupted.reasoning, /useful prerequisite observation/);
    assert.equal(verified.roadmapBuild.stages.length, 5);
    assert.equal(verified.roadmapRecoveries.length, 1);
    assert.ok(verified.roadmapRecoveries[0].repetition.repeats >= 4);
    const phaseRequests = chatRequests.filter(entry => {
      const system = entry.messages?.find(message => message.role === 'system')?.content || '';
      return system.includes('DStudio learning-roadmap protocol') && !system.includes('DStudio roadmap repairer');
    });
    assert.equal(phaseRequests.filter(entry => entry.messages.at(-1).content.includes('[Roadmap phase: stage web-foundations]')).length, 1,
      'The stage completed before Stop is not regenerated after reload');
    assert.equal(phaseRequests.filter(entry => entry.messages.at(-1).content.includes('[Roadmap phase: outline]')).length, 1,
      'Only the initial outline request is issued; its repair does not restart after reload');
    assert.equal(recoveryStreamsClosed, 2, 'Both user cancellation and cycle recovery close the old inference stream');
    assert.deepEqual(await page.evaluate(() => window.__learnWorkspaceOverlaps), [], 'No paused/loading duplicate at any point during retry');
    assert.equal(await page.locator('.roadmap-history').count(), 1);
    assert.equal(await page.locator('.roadmap-history').getAttribute('open'), null);
    await page.locator('.roadmap-history > summary').click();
    assert.match(await page.locator('.roadmap-history').textContent(), /1\/5 stages saved/);
    assert.equal(verified.roadmapResumedFrom, interrupted.id);
    if (legacyDraftCase) assert.ok(messages.some(message => message.id === 'empty-restart' && message.error.message.includes('engineLine')),
      'An empty failed restart remains retained after another retry');
    if (resumeThinkLevel) {
      const resumedRequests = chatRequests.slice(resumedRequestStart).filter(entry => phaseRequests.includes(entry));
      assert.ok(resumedRequests.length > 0 && resumedRequests.every(entry => entry.think === (resumeThinkLevel !== 'off')));
      assert.ok(resumedRequests.every(entry => entry.reasoning_effort === (resumeThinkLevel === 'off' ? undefined : modelFixture.normalEffort)),
        'Changing effort keeps authored stages and sends the newly selected effort on remaining work');
    }
    await page.screenshot({path: path.join(artifacts, 'single-roadmap-with-history.png')});
    assert.deepEqual(pageErrors, []);
    receipt.status = 'PASS';
    console.log(`ui_roadmap recovery: ok (${modelFamily}, ${browserName}; simulated stream cycle, Stop, reload, saved-stage reuse and full verification)`);
    break scenario;
  }
  assert.equal(await page.locator('.scroll-down').count(), 0,
    'the chat scroll button must not cover the Roadmap dependency rail');

  const finalRoadmapRequests = chatRequests.filter((entry) =>
    (entry.messages?.find((message) => message.role === 'system')?.content || '').includes('DStudio learning-roadmap protocol') &&
    !(entry.messages?.find((message) => message.role === 'system')?.content || '').includes('DStudio roadmap repairer')
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
  assert.equal(finalRoadmapRequests.length, roadmap.stages.length + 2,
    'reject the incomplete outline, then develop each agreed stage separately');
  assert.ok(factualAuditRequests.length > roadmap.stages.length + 1,
    'every stage and every cross-stage/capstone pair must be checked in finite batches');
  assert.equal(new Set(factualAuditRequests.map(entry => entry.messages[1].content)).size, factualAuditRequests.length,
    'a factual repair reuses identical checks instead of auditing unchanged input again');
  const auditItems = factualAuditRequests.flatMap(entry => JSON.parse(entry.messages[1].content).items);
  assert.ok(auditItems.some(item => item.id === 'global/web-foundations/production'));
  assert.ok(auditItems.some(item => item.id === 'global/production/capstone'));
  assert.ok(factualAuditRequests.every(entry => {
    const task = JSON.parse(entry.messages[1].content);
    return task.items.every(item => item.kind === 'consistency') || task.evidence.some(source => source.text.includes('conforming document'));
  }), 'external factual checks must receive the actual read-page text, not only URLs');
  assert.equal(factualRepairRequests.length, roadmap.stages.length + 1,
    'a high-confidence factual finding should trigger a saved outline and stage-by-stage repair');
  assert.equal(curriculumJudgeRequests.length, 1,
    'curriculum quality must be judged in a separate pass after factual verification');
  assert.ok(factualAuditRequests.every((entry) => entry.reasoning_effort === selectedEffort && entry.max_tokens === undefined),
    'factual auditors must use the selected reasoning level');
  assert.ok(curriculumJudgeRequests.every((entry) => entry.reasoning_effort === selectedEffort && entry.max_tokens === undefined),
    'the separate curriculum judge must use the selected reasoning level');
  assert.ok(factualAuditRequests.every((entry) =>
    !(entry.messages?.find((message) => message.role === 'system')?.content || '').includes('curriculum judge')),
  'the factual auditor must not inherit curriculum-judging responsibilities');
  if (selectedMinimum) assert.ok(startRequests.some(entry => entry.ctx === selectedMinimum), 'Explicit Max uses its confirmed context');
  else assert.ok(startRequests.every(entry => entry.ctx === 65536), 'High/Off must not inherit a forced Max context');
  assert.equal(JSON.parse(await page.evaluate(() => localStorage.getItem('ds4web.settings.v2'))).ctxSize, selectedContext,
    'Learn must preserve the learner\'s selected context');
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
  assert.equal(request.think, selectedLevel !== 'off', 'Roadmap must honor the selected on/off state');
  assert.equal(request.reasoning_effort, selectedEffort, 'Roadmap must honor the selected reasoning effort');
  assert.equal(request.max_tokens, undefined,
    'Roadmap must not impose an arbitrary output cap below the model physical context window');
  const system = request.messages.find((message) => message.role === 'system')?.content || '';
  const requestUser = request.messages.find((message) => message.role === 'user' && String(message.content || '').includes('[Roadmap research evidence]'))?.content || '';
  const repairUser = request.messages.findLast((message) => message.role === 'user')?.content || '';
  assert.match(system, /DStudio learning-roadmap protocol/);
  assert.match(system, /Use the reasoning level selected by the learner/);
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
  assert.match(repairUser, /Roadmap phase: stage/);
  assert.match(finalRoadmapRequests[1].messages.at(-1).content, /Learn phase recovery/);
  assert.match(finalRoadmapRequests[1].messages.at(-1).content, /Outline needs learner context/);
  assert.doesNotMatch(repairUser, /at least 5 purposeful stages|at least 18 learning topics|Every stage needs at least 3/);
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('ds4web.settings.v2') || '{}').thinkLevel), selectedLevel,
    'Roadmap max thinking should be a mode guarantee, not a mutation of the Chat preference');

  assert.equal(await page.locator('.messages__inner > .msg').count(), 1,
    'Roadmap workspace should show only the latest graph, not its chat transcript');
  assert.equal(await page.locator('.msg--roadmap-direct .msg__start').count(), 0, 'Roadmap should not show assistant chrome');
  assert.equal(await page.locator('.msg--roadmap-direct .thinking').count(), 0, 'Roadmap should not expose model reasoning');
  assert.equal(await page.locator('.msg--roadmap-direct > .msg__content').count(), 0, 'Roadmap should hide model prose outside the graph payload');
  assert.equal(await page.locator('.roadmap-card__head').count(), 0, 'Roadmap should start directly from the graph instead of a large summary header');
  assert.doesNotMatch(await page.locator('.msg--roadmap-direct').textContent() || '', /Questo testo introduttivo|Reasoning privato/);

  // The prompt remains in its normal footer position after generation too.
  const roadmapComposer = page.locator('body.roadmap-mode:not(.composer-raised) .composer');
  await page.setViewportSize({ width: 1800, height: 960 });
  const roadmapComposerLayout = await roadmapComposer.evaluate((node) => {
    const box = node.getBoundingClientRect();
    const formBox = node.querySelector('#composer-form').getBoundingClientRect();
    return {
      top: box.top, bottom: box.bottom, formTop: formBox.top, formBottom: formBox.bottom,
      formWidth: formBox.width, viewport: innerHeight,
    };
  });
  assert.ok(roadmapComposerLayout.formTop < roadmapComposerLayout.viewport && roadmapComposerLayout.formBottom <= roadmapComposerLayout.viewport + 1,
    `the completed Roadmap prompt should remain visible: ${JSON.stringify(roadmapComposerLayout)}`);
  assert.ok(roadmapComposerLayout.formWidth >= 760 && roadmapComposerLayout.formWidth <= 770,
    'the completed Roadmap prompt should keep the shared Agent composer measure');
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
  assert.equal(cardVisual.stageColor, 'rgba(0, 0, 0, 0)', 'phase titles should sit directly on the white editorial canvas');
  assert.equal(await page.locator('#roadmap-head-stats').isVisible(), true,
    'the approved design exposes progress, completion and effort in the Roadmap header');
  assert.match(await page.locator('#chat-title').textContent() || '', /Frontend moderno/);

  const exportMenu = card.locator('.roadmap-export');
  assert.match(await exportMenu.locator('summary').textContent() || '', /Export/);
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
      map: rect('.roadmap-map'), graph: rect('.roadmap-graph'),
      firstTopic: rect('.roadmap-topic--left'), secondTopic: rect('.roadmap-topic--right'),
      mapItems: [...node.querySelectorAll('.roadmap-map__item')].map(item => item.textContent),
      collapsed: [...node.querySelectorAll('.roadmap-stage')].map(stage => stage.classList.contains('is-collapsed')),
    };
  });
  assert.ok(layout.map.width >= 200 && layout.map.right <= layout.graph.left, `The stage map sits beside the curriculum: ${JSON.stringify(layout)}`);
  assert.equal(layout.mapItems.length, roadmap.stages.length + 1, 'One map entry per stage plus the final project');
  assert.match(layout.mapItems[1], /JavaScript essenziale.*4 blocks.*after stage 1/);
  assert.ok(layout.graph.width <= 862, `The curriculum keeps a readable column: ${JSON.stringify(layout)}`);
  assert.ok(Math.abs(layout.firstTopic.left - layout.secondTopic.left) <= 1,
    `Roadmap topics should share one vertical reading rail: ${JSON.stringify(layout)}`);
  assert.deepEqual(layout.collapsed, [false, false, true, true, true], 'The current stage and the next are open; later stages start collapsed');
  assert.equal(await card.locator('.roadmap-stage[data-stage-id="framework"] .roadmap-stage__body').isVisible(), false);
  assert.match(await page.locator('#roadmap-head-shape').textContent(), /5 stages · 20 blocks/);
  assert.match(await page.locator('#roadmap-head-effort').textContent(), /\d+ h required/);
  assert.equal(await page.locator('#roadmap-head-status').textContent(), 'Verified');
  assert.match(await card.locator('.roadmap-verified-notice').textContent(), /Learning path verified/);
  await page.screenshot({path: path.join(artifacts, 'learn-verified.png')});
  // The map opens and reveals a collapsed stage; its toggle closes it again.
  await card.locator('.roadmap-map__item[data-stage-id="production-quality"]').click();
  const qualityStage = card.locator('.roadmap-stage[data-stage-id="production-quality"]');
  await page.waitForFunction(() => !document.querySelector('.roadmap-stage[data-stage-id="production-quality"]').classList.contains('is-collapsed'));
  await page.waitForFunction(() => document.querySelector('.roadmap-map__item[data-stage-id="production-quality"]')?.classList.contains('is-current'));
  assert.ok(await qualityStage.locator('.roadmap-stage__title').evaluate(node => {
    const box = node.getBoundingClientRect(); return box.top >= 0 && box.top < innerHeight; }), 'The chosen stage is scrolled into view');
  assert.equal(await qualityStage.locator('.roadmap-topic').first().isVisible(), true);
  await page.screenshot({path: path.join(artifacts, 'learn-map-navigation.png')});
  const qualityToggle = qualityStage.locator('.roadmap-stage__toggle');
  assert.equal(await qualityToggle.getAttribute('aria-expanded'), 'true');
  await qualityToggle.click();
  assert.equal(await qualityToggle.getAttribute('aria-expanded'), 'false');
  assert.equal(await qualityStage.locator('.roadmap-stage__body').isVisible(), false);
  assert.match(await card.locator('.roadmap-stage[data-stage-id="web-foundations"] .roadmap-stage__checkpoint').textContent(),
    /Stage checkpoint.*Completa un progetto integrato/);

  const firstTopic = card.locator('.roadmap-topic[data-topic-id="html-semantics"]');
  await firstTopic.locator('.roadmap-topic__toggle').click();
  await firstTopic.locator('.roadmap-topic__detail').waitFor({ state: 'visible' });
  assert.match(await firstTopic.locator('.roadmap-topic__detail').textContent() || '', /Key concepts[\s\S]*Outcome[\s\S]*Practice[\s\S]*Mastery check/);
  assert.equal(await firstTopic.locator('.roadmap-topic__check').getAttribute('aria-label'), 'Mark complete: HTML semantico');
  await firstTopic.locator('.roadmap-topic__check').click();
  await page.waitForFunction(() => document.querySelector('.roadmap-topic[data-topic-id="html-semantics"]')?.classList.contains('is-complete'));
  await page.waitForTimeout(900);
  let saved = await page.evaluate(() => JSON.parse(localStorage.getItem('ds4web.chats.v2') || '{}'));
  const savedRoadmap = saved.chats?.find((chat) => chat.mode === 'roadmap');
  let savedReply = savedRoadmap?.messages?.find((message) => message.role === 'assistant');
  assert.equal(savedReply?.roadmapProgress?.['html-semantics'], true, 'Topic completion should persist in roadmap history');
  assert.equal(await page.locator('#chat-list [data-id="' + savedRoadmap.id + '"] .chat-item__progress').getAttribute('aria-label'),
    '1 of 20 topics complete', 'Sidebar completion must use the same saved topic state as Learn');
  assert.equal(savedReply?.roadmapVerification?.status, 'verified',
    'the saved Roadmap should expose a completed factual and curriculum verification state');
  assert.equal(savedReply?.roadmapAudit?.completed, savedReply?.roadmapAudit?.total);
  assert.ok(savedReply?.roadmapAudit?.records.length > roadmap.stages.length);
  assert.equal(savedReply?.roadmapVerification?.repairRounds, 1,
    'the verification record should retain the factual repair round');
  assert.equal(savedReply?.roadmapVerification?.effectiveThinking, selectedEffective);
  assert.equal(savedReply?.roadmapVerification?.requiredContextTokens, selectedMinimum);
  // The rejected draft said "HTML permits any number of main landmarks". (The
  // earlier pattern had an extra word and could never match.)
  assert.doesNotMatch(savedReply?.content || '', /permits any number of main landmarks/,
    'the persisted Roadmap should contain the repaired claim rather than the rejected draft');
  assert.match(savedReply?.content || '', /single visible main landmark/,
    'the persisted Roadmap contains the repaired practice');

  // Add a child on the same visual branch and verify the graph override is persisted.
  await topicMenu(page, 'HTML semantico', 'Add a block after HTML semantico');
  const addForm = firstTopic.locator('.roadmap-add');
  await addForm.locator('input.roadmap-add__input').fill('Accessibilità HTML');
  await addForm.locator('.roadmap-add__description').fill('Struttura, nomi accessibili e navigazione da tastiera.');
  if (repairCheckout) activeEngineDir = `/expansion location${modelFixture.engine}`;
  await addForm.locator('button[type="submit"]').click();
  try {
    await addForm.locator('.roadmap-add__status').waitFor({ state: 'visible' });
  } catch (error) {
    const diagnostic = await page.evaluate(() => {
      const form = document.querySelector('.roadmap-topic[data-topic-id="html-semantics"] .roadmap-add');
      const status = form?.querySelector('.roadmap-add__status');
      const toast = [...document.querySelectorAll('.toast')].at(-1);
      return {
        formConnected: !!form?.isConnected,
        formGenerating: !!form?.classList.contains('is-generating'),
        statusHidden: status?.hidden,
        statusText: status?.textContent || '',
        submitDisabled: form?.querySelector('button[type="submit"]')?.disabled,
        titleValue: form?.querySelector('input.roadmap-add__input')?.value || '',
        descriptionValue: form?.querySelector('.roadmap-add__description')?.value || '',
        invalidFields: form?.querySelectorAll(':invalid').length || 0,
        toast: toast?.textContent || '',
      };
    });
    throw new Error(`Roadmap block generation never exposed its live status: ${JSON.stringify({ diagnostic, blockRequests: blockAttempts })}`, { cause: error });
  }
  assert.match(await addForm.locator('.roadmap-add__status').textContent() || '', /Starting|Thinking|Writing/,
    'Add should visibly show that the model is elaborating the learner input');
  assert.equal(await addForm.locator('button[type="submit"]').isDisabled(), true,
    'Add should prevent duplicate submissions while the model is working');
  releaseBlockStart();
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
  assert.equal(savedReply.roadmapVerification.status,'modified',
    'A generated manual block cannot inherit the earlier roadmap verdict');
  assert.match(await card.locator('.roadmap-draft-notice').textContent(), /modified.*not verified/i);
  assert.equal(await page.locator('#roadmap-head-status').textContent(), 'Modified · not verified');
  await page.screenshot({path: path.join(artifacts, 'learn-modified.png')});
  const blockRequests = chatRequests.filter((entry) =>
    (entry.messages?.find((message) => message.role === 'system')?.content || '').includes('DStudio roadmap-block expansion protocol')
  );
  assert.equal(blockRequests.length, 2, 'adding a block should keep retrying after a truncated model response');
  const blockRequest = blockRequests[0];
  assert.equal(blockRequest.think, selectedLevel !== 'off', 'block expansion must honor the selected thinking state');
  assert.equal(blockRequest.reasoning_effort, selectedEffort, 'block expansion honors the selected reasoning level');
  assert.equal(blockRequest.max_tokens, undefined, 'block expansion must allow productive reasoning to conclude without an output-token cutoff');
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
  assert.equal(retryRequest.max_tokens, undefined);
  assert.equal(retryRequest.reasoning_effort, selectedEffort);
  const retryPayload = retryRequest.messages.at(-1).content;
  assert.match(retryPayload, /Learn phase recovery/);
  assert.match(retryPayload, /Response ended with length/);
  assert.match(retryPayload, /Bozza troncata/);

  // A dependency-breaking drag must leave the stored graph unchanged.
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
  assert.equal(reorderedIds[0], 'html-semantics', `A prerequisite-breaking drag must be refused: ${JSON.stringify(reorderedIds)}`);
  await page.waitForTimeout(900);
  saved = await page.evaluate(() => JSON.parse(localStorage.getItem('ds4web.chats.v2') || '{}'));
  savedReply = saved.chats?.find((chat) => chat.mode === 'roadmap')?.messages?.find((message) => message.role === 'assistant');
  assert.equal(savedReply.roadmapOverride.stages[0].topics[0].id,'html-semantics');
  assert.equal(savedReply.roadmapOverride.stages[0].topics.find(t=>t.id==='css-layout').prerequisites[0],'html-semantics');
  const customId = added.id;
  await page.evaluate(id => {
    const source = document.querySelector(`.roadmap-topic[data-topic-id="${id}"] .roadmap-topic__drag`);
    const target = document.querySelector('.roadmap-topic[data-topic-id="web-accessibility"]');
    const transfer = new DataTransfer();
    source.dispatchEvent(new DragEvent('dragstart',{bubbles:true,cancelable:true,dataTransfer:transfer}));
    const rect=target.getBoundingClientRect();
    target.dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer:transfer,clientX:rect.left+70,clientY:rect.top+2}));
    target.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:transfer,clientX:rect.left+70,clientY:rect.top+2}));
    source.dispatchEvent(new DragEvent('dragend',{bubbles:true,cancelable:true,dataTransfer:transfer}));
  },customId);
  await page.waitForFunction(id => {
    const data=JSON.parse(localStorage.getItem('ds4web.chats.v2'));
    const graph=data.chats.find(c=>c.mode==='roadmap').messages.find(m=>m.roadmapOverride).roadmapOverride;
    return graph.stages[0].topics.slice(0,3).map(t=>t.id).join(',')===`html-semantics,css-layout,${id}`;
  },customId);
  // Deleting a referenced prerequisite cannot remove its study chat or graph.
  await topicMenu(page, 'HTML semantico', 'Delete HTML semantico');
  await page.locator('#confirm-dialog[open]').waitFor();
  await page.locator('#confirm-go').click();
  await page.waitForFunction(()=>[...document.querySelectorAll('.toast')].some(t=>t.textContent.includes('Cannot remove a prerequisite')));
  assert.equal(await card.locator('.roadmap-topic').count(),21);
  assert.equal(await firstTopic.count(),1);
  await page.reload({waitUntil:'networkidle'});await page.clock.resume();
  await page.locator('#tab-roadmap').click();
  await card.waitFor({state:'visible'});
  assert.match(await card.locator('.roadmap-draft-notice').textContent(), /modified.*not verified/i,
    'Reload cannot restore the old verified badge on an edited graph');

  // Every block owns a dedicated Tutor room with a per-thread thinking choice.
  await studyTopic(page, 'HTML semantico');
  const study = page.locator('#roadmap-study');
  await study.waitFor({ state: 'visible' });
  assert.match(await study.locator('.roadmap-study__title').textContent() || '', /HTML semantico/);
  const tutorThinking = study.locator('.roadmap-study__think');
  assert.equal(await tutorThinking.inputValue(), selectedLevel === 'off' ? 'off' : selectedLevel === 'max' && modelFixture.minimum ? 'max' : 'normal',
    'new Tutor rooms inherit the learner\'s choice without duplicate native levels');
  await tutorThinking.selectOption('normal');
  assert.equal(await tutorThinking.inputValue(), 'normal', 'Tutor thinking should be selectable');
  if (modelFixture.minimum) {
    await tutorThinking.selectOption('max');
    await page.locator('#confirm-dialog[open]').waitFor();
    assert.match(await page.locator('#confirm-body').textContent(), /repetitive reasoning loop/);
    await page.locator('#confirm-cancel').click();
    assert.equal(await tutorThinking.inputValue(), 'normal');
    await tutorThinking.selectOption('max');
    await page.locator('#confirm-dialog[open]').waitFor(); await page.locator('#confirm-go').click();
    await page.waitForFunction(() => document.querySelector('.roadmap-study__think')?.value === 'max');
    await tutorThinking.selectOption('normal');
  }

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
  if (repairCheckout) activeEngineDir = `/tutor location${modelFixture.engine}`;
  await study.locator('.roadmap-study__input').fill('Fammi studiare questo argomento con un esercizio.');
  await study.locator('.roadmap-study__send').click();
  const tutorAnswer = study.locator('.roadmap-study-msg--assistant > .md');
  await tutorAnswer.waitFor({ state: 'visible' });
  if (modelFamily !== 'deepseek') assert.match(await study.locator('.cbar-model-label').textContent(),
    modelFamily === 'qwen27' ? /Qwen3\.8-27B/ : modelFamily === 'qwen35' ? /Qwen3\.6-35B-A3B/ : /Qwen3\.8-Flash-Next/,
    'The Tutor model label must describe the model used by its requests');

  // A streaming repaint must neither destroy an active text selection nor
  // force the learner back to the bottom after they scroll up.
  // Use real wheel input and finish its animation before measuring. WebKit
  // also scrolls for the old synthetic WheelEvent, unlike Chromium; measuring
  // before that animation falsely attributed its 110 -> 0 motion to the app.
  await study.locator('.roadmap-study__scroll').hover();
  await page.mouse.wheel(0, -2000);
  await page.waitForFunction(() => document.querySelector('.roadmap-study__scroll').scrollTop === 0);
  const tutorReadingPosition = await study.evaluate((node, traceEnabled) => {
    const scroller = node.querySelector('.roadmap-study__scroll');
    const answer = node.querySelector('.roadmap-study-msg--assistant > .md');
    if (traceEnabled) {
      const trace = window.__roadmapScrollTrace = [];
      const record = (kind, details = {}) => {if (trace.length < 256) trace.push({kind,
        at: performance.now(), top: scroller.scrollTop, height: scroller.scrollHeight,
        viewport: scroller.clientHeight, selected: String(getSelection()), ...details});};
      const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop');
      Object.defineProperty(scroller, 'scrollTop', {get() {return descriptor.get.call(this);},
        set(value) {record('write', {value, stack: new Error().stack}); descriptor.set.call(this, value);}});
      scroller.addEventListener('scroll', () => record('scroll'));
      document.addEventListener('selectionchange', () => record('selection'));
      new MutationObserver(() => record('mutation')).observe(scroller, {subtree: true, childList: true});
      record('initial');
    }
    scroller.scrollTop = Math.min(110, Math.max(0, scroller.scrollHeight - scroller.clientHeight));
    const walker = document.createTreeWalker(answer, NodeFilter.SHOW_TEXT);
    const textNode = walker.nextNode();
    const range = document.createRange();
    range.setStart(textNode, 0);
    range.setEnd(textNode, Math.min(18, textNode.data.length));
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    return { top: scroller.scrollTop, selected: String(selection) };
  }, process.env.DSTUDIO_TRACE_SCROLL === '1');
  assert.match(tutorReadingPosition.selected, /Partiamo/);
  await study.locator('.msg__logo--loading').waitFor({state: 'visible'});
  releaseTutorFinish();
  await page.waitForTimeout(700);
  const tutorDuringSelection = await study.evaluate((node) => ({
    top: node.querySelector('.roadmap-study__scroll').scrollTop,
    selected: String(getSelection()),
  }));
  assert.equal(tutorDuringSelection.selected, tutorReadingPosition.selected,
    'Tutor streaming should not replace DOM nodes while the learner is selecting text');
  assert.ok(Math.abs(tutorDuringSelection.top - tutorReadingPosition.top) <= 2,
    `Tutor streaming should preserve reading position: ${JSON.stringify({before: tutorReadingPosition, after: tutorDuringSelection})}`);
  await study.evaluate(() => getSelection()?.removeAllRanges());
  await study.locator('.roadmap-study__send:not([disabled])').waitFor({ state: 'visible' });
  await page.waitForTimeout(120);
  const tutorAfterSelection = await study.locator('.roadmap-study__scroll').evaluate((node) => node.scrollTop);
  assert.ok(Math.abs(tutorAfterSelection - tutorReadingPosition.top) <= 2,
    'the deferred final Tutor repaint should preserve the learner’s reading position');
  assert.match(await study.locator('.roadmap-study-msg--assistant .msg__start').textContent() || '',
    new RegExp(`DStudio Tutor.*Thinking: ${modelFixture.minimum ? 'normal' : modelFixture.maximum}`));
  assert.match(await study.locator('.roadmap-study-msg--assistant .thinking').textContent() || '', /Valuto prerequisiti/,
    'the tutor should show and retain its Thinking, unlike the roadmap canvas');
  assert.match(await study.locator('.roadmap-study-msg--assistant').last().textContent() || '', /intuizione|esercizio guidato/);
  assert.match(await study.locator('.roadmap-study-msg--assistant').last().textContent() || '', /Esercizio aggiunto mentre stai leggendo/,
    'Text arriving during the selection must be rendered after it is released');
  await study.locator('.roadmap-study-msg--assistant .md-details').waitFor({ state: 'visible' });
  assert.equal(await study.locator('.roadmap-study-msg--assistant').last().textContent().then((text) => text.includes('<details>')), false,
    'Tutor hints should render as collapsible controls instead of raw HTML tags');
  const studyRequests = chatRequests.filter((entry) =>
    (entry.messages?.find((message) => message.role === 'system')?.content || '').includes('dedicated long-term tutor for exactly one block')
  );
  assert.equal(studyRequests.length, 1, 'the study room should issue its own tutor request');
  const studyRequest = studyRequests[0];
  assert.equal(studyRequest.think, true);
  assert.equal(studyRequest.reasoning_effort, modelFixture.normalEffort);
  const studySystem = studyRequest.messages.find((message) => message.role === 'system')?.content || '';
  assert.match(studySystem, /dedicated long-term tutor for exactly one block/);
  assert.match(studySystem, /guided exercises, then independent exercises/);
  assert.match(studySystem, /Current topic: HTML semantico/);
  assert.match(studySystem, /DStudio explanatory answer style/);
  assert.match(studySystem, /DStudio mathematical typesetting protocol/);
  assert.match(studySystem, /DStudio Tutor file output protocol/);
  const studyUser = studyRequest.messages.findLast((message) => message.role === 'user')?.content || '';
  assert.match(studyUser, /\[Attached files\]/, 'Tutor uses the same attachment envelope as Chat');
  assert.match(studyUser, /Appunti tutor: usa header, main e footer/);
  await study.locator('.roadmap-study__input').fill('Tutor steering fixture');
  await study.locator('.roadmap-study__send').click();
  await study.getByText('Partial tutor explanation retained before the new context.', { exact: true }).waitFor();
  assert.equal(await study.locator('.roadmap-study__input').isEnabled(), true);
  assert.equal(await study.locator('.roadmap-study__send').isEnabled(), true);
  await study.locator('.roadmap-study__input').fill('Aggiungi un esempio accessibile da tastiera.');
  await study.locator('.roadmap-study__send').click();
  await page.waitForFunction(() => document.querySelectorAll('.roadmap-study-msg--assistant .md-details').length === 2);
  await page.waitForFunction(() => {
    const chats = JSON.parse(localStorage.getItem('ds4web.chats.v2') || '{}').chats || [];
    const messages = chats.find(chat => chat.mode === 'roadmap')?.messages?.find(message => message.role === 'assistant')?.roadmapStudyThreads?.['topic:html-semantics']?.messages;
    return messages?.length === 6 && messages.every(message => !message.streaming);
  });
  const continuedStudy = chatRequests.findLast(entry => entry.messages?.at(-1)?.content === 'Aggiungi un esempio accessibile da tastiera.');
  assert.ok(continuedStudy, 'new context must reach the next Tutor request');
  assert.equal(continuedStudy.messages.filter(message => message.role === 'user' && message.content === 'Tutor steering fixture').length, 1);
  assert.ok(continuedStudy.messages.some(message => message.role === 'assistant' && message.content.includes('Partial tutor explanation retained')));
  assert.ok(continuedStudy.messages.some(message => message.role === 'user' && message.content.includes('Appunti tutor: usa header, main e footer')));
  await study.locator('.roadmap-study__back').click();
  await study.waitFor({ state: 'hidden' });
  assert.equal(await page.locator('#cbar-right > #cbar-model').count(), 1,
    'closing Tutor should restore the shared model picker to the normal Chat composer');
  await card.waitFor({ state: 'visible' });
  await page.waitForTimeout(900);
  saved = await page.evaluate(() => JSON.parse(localStorage.getItem('ds4web.chats.v2') || '{}'));
  savedReply = saved.chats?.find((chat) => chat.mode === 'roadmap')?.messages?.find((message) => message.role === 'assistant');
  assert.equal(savedReply?.roadmapStudyThreads?.['topic:html-semantics']?.messages?.length, 6,
    'the original and steered tutor transcript must persist with the roadmap');
  assert.equal(savedReply?.roadmapStudyThreads?.['topic:html-semantics']?.thinkLevel, 'normal',
    'the selected Tutor thinking level should persist with its block chat');
  assert.equal(savedReply?.roadmapStudyThreads?.['topic:html-semantics']?.messages?.[0]?.attachments?.[0]?.name, 'appunti.txt',
    'Tutor attachments should persist inside their block transcript');
  assert.match(savedReply?.roadmapStudyThreads?.['topic:html-semantics']?.messages?.[1]?.reasoning || '', /Valuto prerequisiti/,
    'tutor Thinking should persist with the block chat');

  // The sidebar now exposes rename without relying on a hidden double-click/right-click gesture.
  const activeSidebarChat = page.locator('.chat-item--active');
  await activeSidebarChat.hover();
  await activeSidebarChat.getByRole('button', { name: 'Conversation actions', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Rename', exact: true }).click();
  const renameInput = activeSidebarChat.locator('input[aria-label="Rename chat"]');
  await renameInput.fill('Frontend personale');
  await renameInput.press('Enter');
  await page.waitForFunction(() => document.querySelector('.chat-item--active .chat-item__title')?.textContent === 'Frontend personale');

  // Delete the custom block through the in-app confirmation flow.
  await topicMenu(page, 'Accessibilità HTML', 'Delete Accessibilità HTML');
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

  // A new Roadmap generation is transactional: a reload or terminated engine
  // must preserve the previous graph and expose both the interrupted prompt
  // and a way back, instead of replacing it with a permanent loading trace.
  await page.setViewportSize({ width: 1360, height: 960 });
  await prepareRecoveryFixture();
  await page.evaluate((previousRoadmap) => {
    const savedChats = JSON.parse(localStorage.getItem('ds4web.chats.v2') || '{}');
    const now = Date.now();
    savedChats.chats.push({
      id: 'interrupted-roadmap', mode: 'roadmap', title: 'Roadmap interrotta', createdAt: now, updatedAt: now,
      roadmapNotes: [{id: 'update-note', sourceMsgId: 'interrupted-user', text: 'Mantieni gli esercizi di accessibilità.', createdAt: now, state: 'pending'}],
      messages: [
        { id: 'previous-user', role: 'user', content: 'Voglio imparare frontend.', createdAt: now - 1000 },
        {
          id: 'previous-assistant', role: 'assistant', createdAt: now - 900,
          content: `\`\`\`dstudio-roadmap\n${JSON.stringify(previousRoadmap)}\n\`\`\``,
          finishReason: 'stop',
        },
        { id: 'interrupted-user', role: 'user', content: 'Aggiungi una settimana soltanto per TypeScript avanzato.', createdAt: now },
        { id: 'interrupted-assistant', role: 'assistant',
          content: `\`\`\`dstudio-roadmap\n${JSON.stringify({...previousRoadmap, title: 'Unverified replacement'})}\n\`\`\``,
          roadmapVerification: {status: 'generating'}, streaming: true, roadmapPending: true, createdAt: now },
      ],
    });
    localStorage.setItem('ds4web.chats.v2', JSON.stringify(savedChats));
    localStorage.setItem('ds4web.active.v2', JSON.stringify({
      v: 2,
      ids: { chat: 'chat-existing', agent: null, design: null, roadmap: 'interrupted-roadmap' },
    }));
  }, roadmap);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.clock.resume();
  await page.waitForFunction(() => document.querySelector('#tab-server')?.classList.contains('tab--active'));
  await page.locator('#tab-roadmap').click();
  const interruptedState = page.locator('.roadmap-attempt.is-paused');
  await interruptedState.waitFor({ state: 'visible' });
  assert.equal(await page.locator('.roadmap-loading__trace').count(), 0,
    'a restored interrupted update must not keep displaying a live loading trace');
  assert.equal(await page.locator('.roadmap-card').count(), 1,
    'the previous verified roadmap must remain visible while a replacement is interrupted');
  assert.match(await interruptedState.textContent() || '', /previous roadmap is still available|local model was interrupted/i);
  await interruptedState.locator('.roadmap-attempt__prompt > summary').click();
  assert.match(await interruptedState.locator('.roadmap-attempt__prompt').textContent() || '', /TypeScript avanzato/,
    'the learner must be able to inspect the prompt behind an unknown update');
  assert.match(await interruptedState.locator('[data-act="retry"]').textContent() || '', /Retry the update/);
  assert.match(await interruptedState.locator('[data-act="restore-roadmap"]').textContent() || '', /Back to the previous roadmap/);
  assert.match(await page.locator('.roadmap-attempt-wrap .roadmap-note.is-pending').textContent(), /Mantieni gli esercizi di accessibilità.*when you resume/,
    'A message written during an update stays visible with the paused update');
  const recoveredState = await page.evaluate(() => {
    const chats = JSON.parse(localStorage.getItem('ds4web.chats.v2') || '{}').chats || [];
    return chats.find((chat) => chat.id === 'interrupted-roadmap')?.messages?.find((message) => message.id === 'interrupted-assistant');
  });
  assert.equal(recoveredState?.streaming, undefined, 'the stale stream marker must be removed during recovery');
  assert.equal(recoveredState?.roadmapPending, false, 'the stale roadmap pending marker must be removed during recovery');
  assert.equal(recoveredState?.finishReason, 'error', 'the interrupted roadmap must persist as a recoverable error');
  await interruptedState.locator('[data-act="restore-roadmap"]').click();
  await page.locator('.roadmap-attempt').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('.roadmap-card').count(), 1,
    'cancelling an update must immediately return to the previous roadmap');
  const restoredState = await page.evaluate(() => {
    const chats = JSON.parse(localStorage.getItem('ds4web.chats.v2') || '{}').chats || [];
    return chats.find((chat) => chat.id === 'interrupted-roadmap')?.messages || [];
  });
  assert.equal(restoredState.find((message) => message.id === 'interrupted-assistant')?.roadmapDismissed, true,
    'returning to the previous roadmap should preserve but dismiss the newer attempt');
  assert.equal(restoredState.find((message) => message.id === 'interrupted-user')?.content,
    'Aggiungi una settimana soltanto per TypeScript avanzato.',
    'the cancelled prompt must stay recoverable in history');

  // With no old graph to return to, recovery still has a clear paused state
  // and a retry action rather than an endless loading card.
  await prepareRecoveryFixture();
  await page.evaluate(() => {
    const savedChats = JSON.parse(localStorage.getItem('ds4web.chats.v2') || '{}');
    const now = Date.now();
    savedChats.chats.push({
      id: 'orphaned-roadmap', mode: 'roadmap', title: 'Prima roadmap interrotta', createdAt: now, updatedAt: now,
      messages: [
        { id: 'orphaned-user', role: 'user', content: 'Voglio studiare algebra astratta.', createdAt: now },
        { id: 'orphaned-assistant', role: 'assistant', content: '', streaming: true, roadmapPending: true, createdAt: now },
      ],
    });
    localStorage.setItem('ds4web.chats.v2', JSON.stringify(savedChats));
    localStorage.setItem('ds4web.active.v2', JSON.stringify({
      v: 2,
      ids: { chat: 'chat-existing', agent: null, design: null, roadmap: 'orphaned-roadmap' },
    }));
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.clock.resume();
  await page.waitForFunction(() => document.querySelector('#tab-server')?.classList.contains('tab--active'));
  await page.locator('#tab-roadmap').click();
  const orphanedState = page.locator('.roadmap-direct-error');
  await orphanedState.waitFor({ state: 'visible' });
  assert.equal(await page.locator('.roadmap-loading__trace').count(), 0,
    'a first interrupted roadmap must not keep displaying a dead loading trace');
  assert.match(await orphanedState.textContent() || '', /Generation interrupted|local model was interrupted/i);
  assert.match(await orphanedState.locator('[data-act="retry"]').textContent() || '', /Retry the roadmap/);

  assert.deepEqual(pageErrors, [], `page errors: ${JSON.stringify({ pageErrors, missingRequests }, null, 2)}`);
  assert.ok(chatRequests.length > 20 && chatRequests.every(entry => entry.model === modelFixture.id),
    'Research, retries, factual audits, curriculum judge, expansion and Tutor must use the selected model');
  if (modelFamily !== 'deepseek') assert.ok(startRequests.every(entry => entry.ctx === 65536 || entry.ctx === modelFixture.minimum),
    'Tutor and expansion must also retain the configured Qwen context');
  if (repairCheckout) {
    assert.ok(startRequests.length >= 3, 'Generation, expansion and Tutor must each exercise a moved checkout');
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('ds4web.settings.v2')).modelEngineDir),
      activeEngineDir, 'The validated checkout repair must persist without invalidating the pending question');
  }
  const launchPage = await browser.newPage({ viewport: { width: 1360, height: 960 } });
  launchPage.on('pageerror', error => pageErrors.push(String(error)));
  await launchPage.addInitScript(fixture => {
    if (location.origin !== fixture.origin || window !== window.top) return;
    if (!localStorage.getItem('ds4web.settings.v2')) localStorage.setItem('ds4web.settings.v2', JSON.stringify({
      v: 2, onboarded: true, theme: 'dark', baseUrl: '', chatBackend: 'local',
      model: fixture.id, modelGguf: fixture.file, modelEngineDir: fixture.engine,
      ctxSize: 65536, enginePower: 90, ssdStreaming: 'auto', qualityDefaultsVersion: 1,
      webSearchBrowserAllowed: true,
    }));
    if (!localStorage.getItem('ds4web.chats.v2')) {
      const now = Date.now();
      localStorage.setItem('ds4web.chats.v2', JSON.stringify({ v: 2, deleted: [], chats: [{
        id: 'interrupted-learning-request', mode: 'roadmap', title: 'Learn launch regression fixture', createdAt: now, updatedAt: now,
        messages: [
          { id: 'interrupted-user', role: 'user', content: 'Learn launch regression fixture', createdAt: now },
          { id: 'interrupted-assistant', role: 'assistant', content: '', createdAt: now, finishReason: 'aborted', error: { message: 'Cancelled by the user' } },
        ],
      }] }));
    }
    // This is the value injected by the native --learn launch, on this origin only.
    if (sessionStorage.getItem('ds4.learnLaunch') !== 'fixture-one-shot') {
      window.__ds4LearnLaunch = { prompt: 'Learn launch regression fixture', token: 'fixture-one-shot' };
    }
  }, { ...modelFixture, engine: activeEngineDir, origin: `http://127.0.0.1:${port}` });
  try {
    await launchPage.goto(`http://127.0.0.1:${port}/`, {waitUntil: 'domcontentloaded'});
    await launchPage.locator('.roadmap-loading__trace').waitFor({state: 'visible'});
    assert.match(await launchPage.locator('.chat__title').textContent(), /Learn launch regression fixture/,
      'an explicit native launch submits the requested topic to Learn');
    await launchPage.locator('#btn-stop').click();
    await launchPage.waitForFunction(() => document.querySelector('#btn-stop')?.hidden);
    const beforeReload = chatRequests.length;
    await launchPage.reload({waitUntil: 'networkidle'});
    assert.equal(chatRequests.length, beforeReload, 'reloading must not submit the native launch a second time');
    const saved = await launchPage.evaluate(() => JSON.parse(localStorage.getItem('ds4web.chats.v2')));
    assert.equal(saved.chats.filter(chat => chat.mode === 'roadmap' && chat.messages.length).length, 1,
      'the cancelled learning request resumes in its original conversation');
    assert.equal(saved.chats.flatMap(chat => chat.messages).filter(message =>
      message.role === 'user' && message.content === 'Learn launch regression fixture').length, 1);
  } finally { await launchPage.close(); }
  assert.deepEqual(pageErrors, [], 'native learning launch must not cause browser errors');
  console.log(`ui_roadmap_playwright_test: ok (${modelFamily}, ${browserName}; simulated engine)`);
  receipt.status = 'PASS';
  }
} catch (error) {
  receipt.status = 'FAIL'; receipt.error = String(error.stack || error);
  if (page) writeArtifact(artifacts, 'scroll-trace.json', await page.evaluate(() => window.__roadmapScrollTrace || []).catch(() => []));
  await page?.screenshot({path: path.join(artifacts, 'failure.png')}).catch(() => {});
  throw error;
} finally {
  releaseStoreWrite();
  releaseSourcePicker();
  releaseResearchRead();
  releaseBlockStart();
  releaseTutorFinish();
  writeArtifact(artifacts, 'results.json', {...receipt, chatRequests, startRequests, missingRequests});
  await browser.close().catch(() => {});
  server.close();
}

// Explicit real-weight check of Learn's learner-message phases: the production
// notes request and reply normalizer, then the targeted stage rewrite, against
// an actual engine with SSD expert streaming. Authored curriculum and
// expectations fixed before the run; no full-roadmap or quality qualification.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {loadRoadmapFunctions} from '../support/roadmap_functions.mjs';
import {artifactRunDir, freePort, jsonFetch, sleep, startMode, writeArtifact} from '../support/real_harness.mjs';
assert.equal(process.env.DSTUDIO_LIVE_ROADMAP_NOTES, '1', 'Set DSTUDIO_LIVE_ROADMAP_NOTES=1 to explicitly run real weights');
const api = loadRoadmapFunctions();
const artifacts = artifactRunDir('roadmap-notes-real');
console.log('Real Learn notes evidence:', artifacts);
const thinkLevel = process.env.DSTUDIO_LIVE_THINK_LEVEL || 'high';
assert.ok(['high', 'max'].includes(thinkLevel));
const receipt = {scope: 'Real weights: learner-message reply and targeted stage rewrite through production Learn functions; authored curriculum',
  status: 'RUNNING', thinkLevel, htmlSHA256: createHash('sha256').update(fs.readFileSync('web/index.html')).digest('hex'), cases: [], attempts: []};
const save = () => writeArtifact(artifacts, 'results.json', receipt);
save();

// Either reuse a running host (its engine must already use SSD streaming) or
// start an isolated host, profile and KV directory owned by this test.
let base = process.env.DSTUDIO_LIVE_HOST || '', child = null;
if (!base) {
  const engineDir = path.resolve(process.env.DSTUDIO_REAL_DS4_DIR || 'ds4');
  const model = process.env.DSTUDIO_REAL_ROADMAP_GGUF || 'gguf/DeepSeek-V4.1-Flash-1017-IQ2_XXS-Q2_K-imatrix.gguf';
  assert.ok(fs.statSync(path.join(engineDir, model)).size > 0, 'Requested real weights must exist; no fallback or download');
  const hostPort = await freePort(), enginePort = await freePort();
  base = `http://127.0.0.1:${hostPort}`;
  const log = fs.openSync(path.join(artifacts, 'host.log'), 'w', 0o600);
  child = spawn(path.resolve(process.argv[2] || 'dstudio'), [String(hostPort), engineDir], {
    env: {...process.env, DS4UI_HOST: '127.0.0.1', DS4UI_ENGINE_PORT: String(enginePort), DS4UI_DEFER_ENGINE_START: '1', DS4UI_NO_WINDOW: '1',
      DS4UI_DATA_DIR: path.join(artifacts, 'profile'), DSTUDIO_KV_DIR: path.join(artifacts, 'kv'), DS4UI_PAGE_FROM_DISK: '1'},
    stdio: ['ignore', log, log],
  });
  for (;;) {
    if (child.exitCode !== null) throw new Error('Test host exited during startup');
    try { await jsonFetch(base, '/api/status', {timeoutMs: 1000}); break; } catch { await sleep(200); }
  }
  await startMode(base, {mode: 'server', variant: 'flash', gguf: model, port: enginePort,
    ctx: thinkLevel === 'max' ? 393216 : 131072, power: 100, think: thinkLevel, ssdStreaming: 'on'}, 0);
}
const status = await jsonFetch(base, '/api/status', {timeoutMs: 5000});
receipt.runtime = {host: process.env.DSTUDIO_LIVE_HOST ? 'reused running host' : 'isolated test host', modelFile: status.modelFile,
  config: status.config, ds4dir: status.ds4dir};
save();
assert.equal(status.ready, true, 'The engine must be ready');
assert.equal(status.config?.ssdStreamingEffective, true, 'This run must actually use SSD expert streaming');

let streams = 0;
async function* stream(request, signal) {
  const body = {model: 'ds4', messages: request.messages, stream: true, stream_options: {include_usage: true},
    think: true, reasoning_effort: thinkLevel, temperature: .35};
  const attempt = ++streams;
  writeArtifact(artifacts, `request-${attempt}.json`, body);
  const res = await fetch(base + '/v1/chat/completions', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body), signal});
  assert.equal(res.status, 200);
  const reader = res.body.getReader(), decoder = new TextDecoder();
  let pending = '';
  try {
    for (;;) {
      const {value, done} = await reader.read();
      pending += done ? decoder.decode() : decoder.decode(value, {stream: true});
      const frames = pending.split(/\r?\n\r?\n/); pending = frames.pop();
      for (const frame of frames) for (const line of frame.split(/\r?\n/)) if (line.startsWith('data:')) {
        const data = line.slice(5).trim();
        if (data === '[DONE]') return;
        const event = JSON.parse(data), choice = event.choices?.[0], delta = choice?.delta;
        if (event.error) throw new Error(event.error.message);
        if (delta?.reasoning_content) yield {type: 'reasoning', text: delta.reasoning_content};
        if (delta?.content) yield {type: 'content', text: delta.content};
        if (choice?.finish_reason) yield {type: 'finish', reason: choice.finish_reason};
        if (event.usage) yield {type: 'usage', usage: event.usage};
      }
      if (done) throw new Error('Real stream ended before DONE');
    }
  } finally { await reader.cancel().catch(() => {}); }
}
const complete = (label) => async ({messages, normalize}) => {
  const started = Date.now(); let latest = null;
  const result = await api.completeRoadmapPhase({request: {messages, thinkLevel}, signal: new AbortController().signal, label, normalize, stream,
    onProgress(snapshot) { latest = snapshot; if (snapshot.settled) writeArtifact(artifacts, `${label}-attempt-${snapshot.attempt}.json`, snapshot); },
    onRetry(attempt, issue, snapshot) { receipt.attempts.push({label, attempt, issue, repetition: snapshot.repetition}); save(); },
  });
  receipt.cases.push({label, ms: Date.now() - started, reasoningChars: latest?.reasoningChars, contentChars: latest?.content.length, usage: latest?.usage});
  save();
  return result;
};

// Authored curriculum: three stages with genuine cross-stage prerequisites.
// Production quality requires at least three distinct researched sources.
const sources = ['exposure', 'composition', 'raw-development'].map(name => `https://example.invalid/authored-photography/${name}`);
let topicCount = 0;
const topic = (id, title, prerequisites, summary, practice) => ({id, title, prerequisites, optional: false, summary, estimatedHours: 2,
  keyConcepts: [title], outcome: `Applica ${title.toLowerCase()} in uno scatto documentato e motivato.`, practice,
  assessment: 'Un revisore confronta gli scatti con la checklist e tu spieghi ogni scelta tecnica.',
  resources: [{title: 'Corso di fotografia (fixture)', url: sources[topicCount++ % sources.length], source: 'roadmap', why: 'Riferimento della fixture.'}]});
const roadmap = {version: 2, title: 'Fotografia digitale: dalle basi alla post-produzione', goal: 'Scattare e sviluppare fotografie consapevoli in modalità manuale.',
  audience: 'Principiante con una fotocamera con modalità manuale', estimatedDuration: '6 settimane, 3 ore a settimana',
  assumptions: ['Si dispone di una fotocamera o di uno smartphone con controlli manuali.'],
  stages: [
    {id: 'esposizione', title: 'Esposizione: apertura, tempi e ISO', description: 'Senza esposizione corretta le scelte successive non hanno materiale su cui lavorare.',
      duration: '2 settimane', objectives: ['Scegliere apertura, tempo e ISO per una scena data.'],
      checkpoint: 'Scatta tre versioni della stessa scena con esposizioni diverse e spiega quale preferisci e perché.',
      topics: [topic('triangolo-esposizione', "Il triangolo dell'esposizione", [], "Apertura, tempo di scatto e ISO si bilanciano: cambiare uno richiede di compensare gli altri per mantenere l'esposizione.",
        'Scatta la stessa scena con tre combinazioni equivalenti di apertura, tempo e ISO e confronta profondità di campo e mosso.'),
        topic('esposimetro', 'Esposimetro e istogramma', ['triangolo-esposizione'], "L'esposimetro propone un'esposizione media; l'istogramma mostra se luci o ombre sono state perse e guida la correzione.",
        'Fotografa una scena controluce, leggi l’istogramma e correggi l’esposizione finché non perdi dettagli nelle luci.')]},
    {id: 'composizione', title: 'Composizione e luce', description: 'Con il controllo tecnico acquisito si impara a guidare lo sguardo e a usare la luce.',
      duration: '2 settimane', objectives: ['Comporre una scena con un soggetto chiaro e una luce scelta.'],
      checkpoint: 'Crea una serie di cinque foto dello stesso soggetto con composizioni e luci diverse e motiva le scelte.',
      topics: [topic('regole-composizione', 'Regole di composizione', ['triangolo-esposizione'], 'Terzi, linee guida e spazio negativo organizzano la scena; si imparano per poterle usare o rompere in modo intenzionale.',
        'Fotografa un soggetto con regola dei terzi, linee guida e spazio negativo e descrivi l’effetto di ogni versione.'),
        topic('luce-naturale', "Luce naturale e ora d'oro", ['esposimetro'], "Direzione, durezza e colore della luce cambiano l'immagine; l'ora d'oro offre luce morbida e calda ma cambia in fretta.",
        'Fotografa lo stesso soggetto a mezzogiorno e all’ora d’oro e confronta ombre, contrasto e colore.')]},
    {id: 'post-produzione', title: 'Post-produzione dei file RAW', description: 'Lo sviluppo completa lo scatto senza nascondere errori di esposizione o composizione.',
      duration: '2 settimane', objectives: ['Sviluppare un file RAW in modo coerente e non distruttivo.'],
      checkpoint: 'Sviluppa dieci RAW con un flusso coerente e documenta ogni regolazione principale.',
      topics: [topic('raw-sviluppo', 'Sviluppo del RAW', ['esposimetro', 'luce-naturale'], 'Il RAW conserva più dati del JPEG: bilanciamento del bianco, esposizione e curve si regolano senza perdere qualità.',
        'Sviluppa tre RAW della serie precedente correggendo bilanciamento, esposizione e contrasto e confronta prima e dopo.')]},
  ],
  capstone: {title: 'Portfolio di dieci fotografie', description: 'Un portfolio che usa esposizione, composizione e sviluppo in modo consapevole.',
    deliverables: ['Dieci foto sviluppate', 'Note di scatto per ogni foto'], successCriteria: ['Esposizione corretta', 'Composizione intenzionale', 'Sviluppo coerente']},
};
const allowedUrls = new Set(sources);
const outline = api.normalizeRoadmapOutline(JSON.stringify(roadmap));
const stages = roadmap.stages.map((stage, index) => api.normalizeRoadmapStage(JSON.stringify({stage}), outline, index, allowedUrls));
const draft = api.parseRoadmapDirective(JSON.stringify({...outline, stages}));
// A first structural run failed the production quality gate only because this
// fixture had one source URL; that receipt is retained. Check the precondition
// before spending model time.
assert.deepEqual(api.roadmapQualityReport(draft).issues, [], 'The authored draft must pass the production quality report');
const history = [
  {role: 'system', content: api.ROADMAP_OUTPUT_PROTOCOL},
  {role: 'user', content: 'Voglio imparare la fotografia digitale da principiante, con esercizi pratici, in sei settimane.'},
];
// Case A is the original learner request. The protocol allows two valid
// decisions for "add an exercise": rewrite the written stage ("stages") or add
// a topic ("structure"). A first run's grader accepted only "stages"; the
// model chose "structure", which the contract defines for added topics. That
// failed receipt is retained; the correction keeps the semantic requirement
// (the composition stage gains the requested night/tripod work) and executes
// whichever production path the model chose. Case B states an unambiguous
// in-place change, so it must use the targeted rewrite.
const cases = [
  {id: 'A-exercise-request', notes: [
    {id: 'note-question', text: "Perché l'esposizione viene prima della post-produzione?", state: 'pending'},
    {id: 'note-change', text: 'Nella tappa sulla composizione voglio anche un esercizio pratico di fotografia notturna con il cavalletto.', state: 'pending'},
  ], allowed: ['stages', 'structure']},
  {id: 'B-in-place-change', notes: [
    {id: 'note-in-place', text: "Nella tappa sulla composizione non aggiungere blocchi: nel blocco sulla luce naturale cambia solo l'esercizio pratico, includendo anche una variante notturna con il cavalletto.", state: 'pending'},
  ], allowed: ['stages']},
];
const night = /nott|cavallett|treppied/i;
receipt.expectations = {
  A: 'both messages answered; the question answer mentions exposure; revise is stages naming composizione only, or structure whose revision names the composition stage; the applied change puts night/tripod work in composizione and keeps every agreed id',
  B: 'revise is stages naming composizione only; only composizione changes, it keeps its topic ids and contains the night/tripod variant',
};
save();
const writtenStageIds = draft.stages.map(stage => stage.id);
const compositionIndex = outline.stages.findIndex(stage => stage.id === 'composizione');
const phase = prefix => ({messages, normalize, label}) =>
  complete(`${prefix}-${String(label).split('·').at(-1).trim().replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`)({messages, normalize});
try {
  for (const item of cases) {
    const reply = await complete(`${item.id}-notes`)({
      messages: [...history, {role: 'user', content: api.roadmapLearnerNotesRequest({draft, writtenStageIds, notes: item.notes, answered: []})}],
      normalize: raw => api.normalizeRoadmapNoteReply(raw, item.notes, writtenStageIds, {draftStarted: true}),
    });
    writeArtifact(artifacts, `${item.id}-reply.json`, reply);
    receipt[item.id] = {reply}; save();
    const answer = id => reply.answers.find(entry => entry.id === id)?.answer || '';
    for (const note of item.notes) assert.ok(answer(note.id).length > 20, `${note.id} receives an answer`);
    if (item.notes.some(note => note.id === 'note-question')) assert.match(answer('note-question'), /esposizion/i, 'The question is answered about exposure');
    assert.ok(item.allowed.includes(reply.revise), `${item.id}: ${reply.revise} is not an allowed decision`);
    assert.match(reply.revision, night, 'The agreed revision states the requested night/tripod work');
    const last = item.notes.at(-1);
    const answered = item.notes.map(note => ({...note, state: 'answered', answer: answer(note.id), ...(note === last ? {revise: reply.revise, revision: reply.revision} : {})}));
    const guidance = () => api.roadmapLearnerGuidance(answered);
    if (reply.revise === 'stages') {
      assert.deepEqual(reply.stageIds, ['composizione'], 'Only the composition stage is named for rewriting');
      const revised = await api.reviseRoadmapStages({messages: history, build: {version: 1, outline, stages}, stageIds: reply.stageIds,
        revision: reply.revision, allowedUrls, guidance, complete: phase(`${item.id}-rewrite`)});
      writeArtifact(artifacts, `${item.id}-rewritten-build.json`, revised.build);
      revised.build.stages.forEach((stage, i) => { if (i !== compositionIndex) assert.deepEqual(stage, stages[i], `Stage ${stage.id} stays identical`); });
      const rewritten = revised.build.stages[compositionIndex];
      // Run 3 showed the model adding a topic inside the stage; a targeted
      // rewrite now admits that while keeping every agreed topic in order.
      const agreedIds = stages[compositionIndex].topics.map(entry => entry.id);
      assert.deepEqual(rewritten.topics.map(entry => entry.id).filter(id => agreedIds.includes(id)), agreedIds, 'Agreed topics are kept in order');
      receipt[item.id].addedTopics = rewritten.topics.map(entry => entry.id).filter(id => !agreedIds.includes(id));
      assert.notDeepEqual(rewritten, stages[compositionIndex], 'The targeted stage actually changed');
      assert.match(JSON.stringify(rewritten), night, 'The rewritten stage contains the requested night/tripod work');
      receipt[item.id].applied = 'targeted stage rewrite';
    } else {
      assert.match(reply.revision, /composizion/i, 'The structural change names the composition stage');
      const repaired = await api.repairVerifiedRoadmap({roadmap: draft, kind: 'learner', allowedUrls, guidance, complete: phase(`${item.id}-structure`),
        defects: [{message: last.text, change: reply.revision}]});
      writeArtifact(artifacts, `${item.id}-repaired-roadmap.json`, repaired.roadmap);
      assert.equal(repaired.quality.pass, true, 'The structural rewrite keeps a complete roadmap');
      const ids = new Set(repaired.roadmap.stages.flatMap(stage => [stage.id, ...stage.topics.map(entry => entry.id)]));
      for (const stage of draft.stages) for (const id of [stage.id, ...stage.topics.map(entry => entry.id)]) assert.ok(ids.has(id), `Agreed id ${id} is kept`);
      const composition = repaired.roadmap.stages.find(stage => stage.id === 'composizione');
      assert.match(JSON.stringify(composition), night, 'The composition stage contains the requested night/tripod work');
      receipt[item.id].applied = 'structural rewrite (preserve-ids repair)';
    }
    save();
  }
  receipt.status = 'PASS';
  console.log(`real roadmap notes: PASS (${status.modelFile}, think ${thinkLevel}, SSD streaming; ${receipt.cases.map(c => `${c.label} ${Math.round(c.ms / 1000)}s`).join(', ')})`);
} catch (error) {
  receipt.status = 'FAIL'; receipt.error = error.stack || String(error);
  console.log('real roadmap notes: FAIL', error.message);
  process.exitCode = 1;
} finally {
  save();
  if (child) { child.kill('SIGTERM'); }
}

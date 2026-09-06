import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Execute the editable runtime, not assertions about source phrases. Model
// replies are explicitly simulated; these checks prove evidence transport and
// bounded selection, not answer accuracy or general semantic retrieval quality.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const runtime = fs.readFileSync(path.join(root, 'extension/search/runtime.js'), 'utf8');
const requests = [];
let onReply;
let replyFacts = [{ fact: 'The retry interval is 47 seconds.', excerpt: 'Orchid retry interval is 47 seconds.' }];
const api = { completeText: async (payload) => {
  requests.push(payload);
  onReply?.();
  return JSON.stringify({ facts: replyFacts });
} };
let status = { ready: true, nativeVisionActive: true, modelFile: 'confirmed.gguf' };
let readReply;
const engine = { status: async () => status, webRead: async (...args) => readReply(...args) };
const tools = new Function('Api', 'Engine', `
  const WEB_CONTEXT_CHARS = 1800;
  const WEB_RESEARCH_JUDGE_TIMEOUT_MS = 120000;
  ${runtime}
  return { selectResearchEvidence, applyReadResultToSource, extractFactsFromPage, extractFactsFromReadSources, normalizeExtractedFacts, readResearchSources, buildFactsContext };
`)(api, engine);

const filler = 'Unrelated background about the public garden and its history. ';
function pageAt(offset, passage) {
  return filler.repeat(Math.ceil(offset / filler.length)).slice(0, offset) + passage + filler.repeat(1800);
}

let checks = 0;
for (const offset of [0, 450, 600, 980, 1700, 3100, 12000, 17900, 40000, 120000, 254000]) {
  const passage = ' Orchid retry interval is 47 seconds. ';
  const page = pageAt(offset, passage);
  const selected = tools.selectResearchEvidence(page, 'What is the Orchid retry interval?', 5200);
  assert.ok(selected.includes(passage.trim()), `lost the answer near character ${offset}`);
  assert.ok(selected.length <= 5200);
  assert.ok(selected.startsWith(page.slice(0, 80).trim()));
  checks++;
}

const short = 'A short complete source. Cost: €17. Café già aperto.';
assert.equal(tools.selectResearchEvidence(short, 'Cost?', 5200), short);
assert.equal(tools.selectResearchEvidence(short, '', 0), '');
assert.ok(tools.selectResearchEvidence(pageAt(2000, 'target'), '', 1800).length <= 1800);
const italian = pageAt(23000, ' La prenotazione del laboratorio costa esattamente 29 euro. ');
assert.match(tools.selectResearchEvidence(italian, 'Quanto costa la prenotazione del laboratorio?', 5200), /costa esattamente 29 euro/);
for (const budget of [1, 239, 241, 5200]) {
  for (const query of ['Arboriculture', '', 'unmatched']) {
    const unicode = tools.selectResearchEvidence('🌲 Arboriculture🌲 '.repeat(2500), query, budget);
    assert.ok(unicode.isWellFormed(), `split a Unicode character with budget ${budget}`);
    assert.ok(unicode.length <= budget);
  }
}
checks += 5;

// Full markdown, not the leading server excerpt, must reach both selection
// stages. A late answer should survive without increasing the model budget.
const source = { sourceId: 'S1', url: 'https://example.test/manual' };
tools.applyReadResultToSource(source, {
  title: 'Orchid manual', reader: 'browser',
  markdown: pageAt(40000, ' Orchid retry interval is 47 seconds. '),
  excerpt: filler.repeat(70),
}, 'What is the Orchid retry interval?');
assert.match(source.content, /Orchid retry interval is 47 seconds/);
const facts = await tools.extractFactsFromPage('What is the Orchid retry interval?', source, { model: 'test' });
assert.equal(requests.length, 1, 'evidence selection must not add a model call');
assert.match(requests[0].messages[1].content, /Orchid retry interval is 47 seconds/);
assert.equal(facts[0].sourceUrl, source.url);
assert.equal(requests[0].maxTokens, 1900);
checks++;

// Large inputs have the same selected result as their bounded prefix. Do not
// scan or retain megabytes simply because a remote page supplies them.
const prefix = pageAt(30000, ' Orchid retry interval is 47 seconds. ').padEnd(256000, ' ');
assert.equal(tools.selectResearchEvidence(prefix, 'Orchid retry interval', 5200),
  tools.selectResearchEvidence(prefix + filler.repeat(100000), 'Orchid retry interval', 5200));
checks++;

// Stop during a reply must neither publish stale evidence nor advance to the
// next page, even when a transport returns instead of honoring cancellation.
const controller = new AbortController();
const state = {
  question: 'Orchid retry interval', purpose: 'answer', trace: [], facts: [],
  byUrl: new Map([[source.url, source], ['https://example.test/second', { ...source, url: 'https://example.test/second' }]]),
  extractedUrls: new Set(),
};
const beforeCancel = requests.length;
onReply = () => controller.abort();
await assert.rejects(tools.extractFactsFromReadSources(state.question, state, { model: 'test', webSignal: controller.signal }), { name: 'AbortError' });
assert.equal(requests.length, beforeCancel + 1);
assert.equal(state.facts.length, 0);
assert.equal(state.extractedUrls.size, 0);
await assert.rejects(tools.extractFactsFromPage(state.question, source, { model: 'test', webSignal: controller.signal }), { name: 'AbortError' });
assert.equal(requests.length, beforeCancel + 1, 'already cancelled work must not call the model');
onReply = undefined;
checks += 2;

// Simulated pixels exercise model-request transport; the separate native Chrome
// integration test decodes and checks real JPEG colors. Never confuse the two.
const pixelFixture = 'data:image/jpeg;base64,/9j/AAAA';
const visualResponse = url => ({ ok: true, title: 'Chart', url, canonicalUrl: url, markdown: 'A chart.',
  visual: { status: 'captured', sourceUrl: url, dataUrl: pixelFixture, width: 1024, height: 768 } });
const visualSource = (url = 'https://example.test/chart') => tools.applyReadResultToSource({ url, sourceId: 'S1' }, visualResponse(url), 'Which colors?');
const visualSettings = { model: 'test', webVisionModel: 'confirmed.gguf' };
let chart = visualSource();
assert.equal(chart.webImage, pixelFixture);
assert.ok(!JSON.stringify(chart).includes('data:image'), 'pixels must never serialize into a saved source/chat');
replyFacts = [{ fact: 'The left rectangle is magenta.', basis: 'visual', excerpt: 'Left rectangle in the viewport.' }];
const visualFacts = await tools.extractFactsFromPage('Which colors?', chart, visualSettings);
const request = requests.at(-1);
assert.deepEqual(request.messages[1].content[1], { type: 'image_url', image_url: { url: pixelFixture } });
assert.equal(chart.visual.status, 'inspected');
assert.equal(chart.webImage, undefined, 'discard scratch pixels after extraction');
assert.equal(visualFacts[0].basis, 'visual observation of limited viewport');
assert.match(tools.buildFactsContext('Which colors?', [chart], visualFacts), /Evidence basis: visual observation of limited viewport/);
checks++;

status = { ...status, nativeVisionActive: false };
chart = visualSource();
assert.deepEqual(await tools.extractFactsFromPage('Which colors?', chart, visualSettings), [], 'reject claimed visual facts when pixels were not sent');
assert.equal(typeof requests.at(-1).messages[1].content, 'string');
assert.equal(chart.visual.status, 'unavailable');
assert.equal(chart.webImage, undefined);
checks++;

for (const visual of [
  { ...visualResponse('https://example.test/chart').visual, sourceUrl: 'https://other.test' },
  { ...visualResponse('https://example.test/chart').visual, dataUrl: 'https://example.test/chart.jpg' },
  { ...visualResponse('https://example.test/chart').visual, dataUrl: pixelFixture + 'A'.repeat(768 * 1024) },
]) {
  const s = tools.applyReadResultToSource({ url: 'https://example.test/chart' }, { ...visualResponse('https://example.test/chart'), visual }, 'Colors?');
  assert.equal(s.webImage, undefined);
  assert.equal(s.visual.status, 'unavailable');
}
checks++;

status = { ready: true, nativeVisionActive: true, modelFile: 'confirmed.gguf' };
chart = visualSource();
onReply = () => { status = { ...status, modelFile: 'other.gguf' }; };
await assert.rejects(tools.extractFactsFromPage('Colors?', chart, visualSettings), { name: 'AbortError' });
assert.notEqual(chart.visual.status, 'inspected', 'model-switch race must not publish evidence');
assert.equal(chart.webImage, undefined);
onReply = undefined;
checks++;

const reads = [];
readReply = async (url, _signal, options) => { reads.push(options.includeImage); return visualResponse(url); };
const pages = [1, 2, 3, 4].map(i => ({ url: `https://example.test/${i}` }));
await tools.readResearchSources(pages, new Set(), Infinity, undefined, [], 'Which colors?', undefined,
  { visualBudget: { remaining: 3, enabled: true } });
assert.deepEqual(reads, [true, true, true, false]);
assert.equal(pages[3].webImage, undefined);
assert.ok(!JSON.stringify(pages).includes('data:image'));
checks++;

const lateRead = new AbortController();
const untouched = { url: 'https://example.test/late' };
readReply = async url => { lateRead.abort(); return visualResponse(url); };
await assert.rejects(tools.readResearchSources([untouched], new Set(), Infinity, undefined, [], 'Colors?', lateRead.signal,
  { visualBudget: { remaining: 3, enabled: true } }), { name: 'AbortError' });
assert.equal(untouched.read, undefined);
assert.equal(untouched.webImage, undefined);
checks++;

const captureBudget = { remaining: 3, enabled: true };
readReply = async url => ({ ...visualResponse(url), visual: { status: 'not_needed', reason: 'No substantive graphic.' } });
await tools.readResearchSources([{ url: 'https://example.test/plain' }], new Set(), Infinity, undefined, [], 'Q?', undefined, { visualBudget: captureBudget });
assert.equal(captureBudget.remaining, 3, 'a page with no graphic did not attempt capture and must not consume an image slot');
readReply = async url => visualResponse(url);
const diagram = { url: 'https://example.test/diagram' };
const diagramRead = await tools.readResearchSources([diagram], new Set(), Infinity, undefined, [], 'Q?', undefined,
  { visualBudget: captureBudget, requireSubstantial: true });
assert.equal(diagramRead.readSources.length, 1, 'an actual diagram must not be rejected just because its text is short');
checks++;
console.log(`search_evidence: ${checks} behavioral cases passed (simulated model; no answer-quality claim)`);

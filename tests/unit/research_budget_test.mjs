import assert from 'node:assert/strict';
import fs from 'node:fs';

// Production orchestration with simulated page/model replies. These are
// resource/cancellation regressions, not measurements of answer quality.
const runtime = fs.readFileSync('extension/search/runtime.js', 'utf8');
let now = 0, calls = 0, reads = 0, queries = 0, reply;
const api = { completeText: (...args) => reply(...args) };
const engine = {
  status: async () => ({ ready: true, nativeVisionActive: false }),
  webSearch: async query => {
    queries++;
    return { ok: true, sources: Array.from({ length: 30 }, (_, i) => ({
      url: `https://example.test/${encodeURIComponent(query)}/${i}`, title: 'Source', content: 'Discovery only',
    })) };
  },
  webRead: async url => { reads++; return { ok: true, url, title: 'Page', markdown: 'A verified sentence. '.repeat(60) }; },
};
const tools = new Function('Api', 'Engine', 'performance', `
  const WEB_CONTEXT_CHARS = 1800;
  const WEB_RESEARCH_JUDGE_TIMEOUT_MS = Infinity;
  ${runtime}
  let writerQuery;
  const useSimulatedDecisions = () => {
    classifyResearchRequest = async () => ({ intent: 'research', standaloneQuestion: 'Find a verified answer',
      needsSearch: true, queries: ['initial'], explicitUrls: [] });
    pickSourcesToRead = async (_q, state) => ({ reason: 'simulated pick',
      urls: [...state.byUrl.values()].filter(s => !state.readUrls.has(sourceKey(s.url))).slice(-2).map(s => s.url) });
    planNextResearchAction = async state => ({ action: 'web_search', queries: ['next-' + state.actions], reason: 'simulated unresolved question' });
    judgeResearchSufficiency = async () => ({ decision: 'continue', reason: 'Question unresolved', gaps: ['Missing requested detail'] });
    synthesizeResearchReport = async (query, state) => { writerQuery = query; return { report: 'Partial report', quality: null }; };
  };
  return { completeWebPipelineText, researchRunLimits, researchAdmissionOpen,
    executeWebSearchQueries, readUrlsIntoState, addSourceToState, runResearchPipeline, useSimulatedDecisions,
    writerQuery: () => writerQuery };
`)(api, engine, { now: () => now });
const state = mode => ({ mode, purpose: 'answer', question: 'answer', limits: tools.researchRunLimits(mode),
  deadline: 1000, trace: [], byUrl: new Map(), readUrls: new Set(), searched: new Set(), facts: [] });

let s = state('search');
await tools.executeWebSearchQueries(s, Array.from({ length: 50 }, (_, i) => `q${i}`));
assert.equal(queries, 6);
assert.equal(s.byUrl.size, 72, 'At most 12 discovered sources per query');
await tools.executeWebSearchQueries(s, ['q0', 'q50']);
assert.equal(queries, 6, 'The next batch cannot reset the per-run query budget');
await tools.readUrlsIntoState(s, [...s.byUrl.keys()], s.deadline);
assert.equal(reads, 8);
await tools.readUrlsIntoState(s, [...s.byUrl.keys()].reverse(), s.deadline);
assert.equal(reads, 8, 'The next batch cannot reset the page budget');
for (let i = 0; i < 200; i++) tools.addSourceToState(s, { url: `https://extra.test/${i}` });
assert.equal(s.byUrl.size, 96);
const prior = [...s.byUrl.values()][0];
assert.equal(tools.addSourceToState(s, { url: prior.url, explicit: true }), prior, 'Existing source identity survives capacity');
assert.equal(prior.explicit, true);

const canceled = new AbortController();
s = { ...state('search'), signal: canceled.signal };
engine.webSearch = async () => { canceled.abort(); return { ok: true, sources: [{ url: 'https://late.test/' }] }; };
await assert.rejects(tools.executeWebSearchQueries(s, ['late']), { name: 'AbortError' });
assert.equal(s.byUrl.size, 0, 'Late search reply cannot publish after Stop');

let transportSignal;
reply = (_payload, signal) => { transportSignal = signal; return new Promise(() => {}); };
await assert.rejects(tools.completeWebPipelineText({}, 5, 'Blocked model'), { name: 'TimeoutError' });
assert.equal(transportSignal.aborted, true, 'Deadline must reach the actual transport');
const stop = new AbortController();
const pending = tools.completeWebPipelineText({}, Infinity, 'Stopped model', stop.signal);
stop.abort();
await assert.rejects(pending, { name: 'AbortError' });
assert.equal(transportSignal.aborted, true);
reply = async () => 'finished';
assert.equal(await tools.completeWebPipelineText({}, 20, 'Fast model'), 'finished');

// Ever-new irrelevant pages previously reset the stall counter forever.
// Exercise the complete loop: partial evidence survives, but is never enough.
tools.useSimulatedDecisions();
engine.webSearch = async query => ({ ok: true, sources: [0, 1].map(i => ({
  url: `https://example.test/${query}/${i}`, title: query, content: 'Lead',
})) });
reply = async () => { calls++; return JSON.stringify({ facts: [{ fact: 'A verified sentence.', excerpt: 'A verified sentence.' }] }); };
const originalRequest = 'Find an answer. Rispondi in italiano, al massimo 120 parole.';
const result = await tools.runResearchPipeline(originalRequest, { model: 'simulated' }, { mode: 'research' });
assert.equal(tools.writerQuery(), originalRequest, 'A rewritten discovery question must not erase the original writer requirements');
assert.ok(result.context.includes(originalRequest), 'The final answer context must retain original language and length requirements');
assert.equal(result.budget.reads, 24);
assert.ok(result.budget.actions <= 12);
assert.ok(calls <= 24);
assert.equal(result.judge.decision, 'incomplete');
assert.ok(result.stopReason.length > 0);
assert.ok(result.judge.gaps.includes(result.stopReason));
assert.match(result.context, /Research limitation:/);
assert.ok(result.facts.length > 0, 'A budget must not erase completed evidence');
assert.match(result.report, /Research limitation:/, 'Returned report must retain the runtime limitation even if its writer omits it');

// One page per action does not reach the page ceiling: the independent action
// ceiling must still terminate continuous but insufficient progress.
engine.webSearch = async query => ({ ok: true, sources: [{ url: `https://single.test/${query}`, title: query }] });
const actionLimited = await tools.runResearchPipeline('Unresolved', { model: 'simulated' }, { mode: 'research' });
assert.equal(actionLimited.budget.actions, 12);
assert.equal(actionLimited.budget.reads, 13);
assert.equal(actionLimited.judge.decision, 'incomplete');
assert.match(actionLimited.stopReason, /action budget/);

s = state('research'); now = 1000;
assert.equal(tools.researchAdmissionOpen(s), false);
const before = reads;
await tools.readUrlsIntoState(s, ['https://not-admitted.test'], s.deadline);
assert.equal(reads, before, 'Expired admission must not start another page');
console.log('research_budget: real orchestration with simulated evidence, bounded queries/pages/sources/actions, honest partial results, timeout and cancellation passed');

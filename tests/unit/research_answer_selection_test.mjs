import assert from 'node:assert/strict';
import fs from 'node:fs';
// Execute production selection and synthesis. Simulated model replies prove
// evidence identity and cancellation, not semantic quality of model selections.
const runtime = fs.readFileSync('extension/search/runtime.js', 'utf8');
let respond;
const tools = new Function('Api', `
  const WEB_RESEARCH_TOTAL_TIMEOUT_MS = Infinity;
  ${runtime}
  return { researchAnswerFacts, researchAnswerSources, synthesizeResearchReport, researchReportQuality, writeFinalFromFacts };
`)({ completeText: (...args) => respond(...args) });
const source = { sourceId: 'S1', title: 'Public evidence', url: 'https://example.test/evidence', read: true };
const facts = [
  { factId: 'F1', sourceId: 'S1', sourceUrl: source.url, fact: 'Rotation is 243 days.' },
  { factId: 'F2', sourceId: 'S1', sourceUrl: source.url, fact: 'Orbit is 225 days.' },
  { factId: 'F3', sourceId: 'S1', sourceUrl: source.url, fact: 'The article author is Example.' },
];
const state = { facts, byUrl: new Map([[source.url, source]]), judge: { decision: 'enough', answerFactIds: ['F1', 'F2'], gaps: [] } };
assert.deepEqual(tools.researchAnswerFacts(state), facts.slice(0, 2));
assert.equal(state.facts, facts, 'The complete evidence store must remain authoritative');
for (const ids of [[], ['F1', 'F99'], ['F1', {}], ['F1', 'F2', 'F3', 'F4'], null]) {
  assert.equal(tools.researchAnswerFacts({ ...state, judge: { decision: 'enough', answerFactIds: ids } }), facts);
}
assert.equal(tools.researchAnswerFacts({ ...state, judge: { decision: 'incomplete', answerFactIds: ['F1'] } }), facts);
assert.deepEqual(tools.researchAnswerFacts({ ...state, judge: { decision: 'enough', answerFactIds: ['F2', 'F2'] } }), [facts[1]]);
const report = '# Comparison\n\n## Summary\nRotation is longer [F1][F2].\n\n## Evidence\nRotation: 243 days [F1]. Orbit: 225 days [F2].\n\n## Gaps\nNone for these two periods.\n\n## Sources\nhttps://example.test/evidence';
respond = async payload => payload.messages[0].content.includes('final-answer evidence reviewer')
  ? JSON.stringify({ claimsSupported: true, requestedPartsCovered: true, conflictsHandled: true, instructionsFollowed: true, issues: [] })
  : report;
const result = await tools.synthesizeResearchReport('Compare the rotation and orbital periods', state, {});
assert.equal(result.fallback, false, 'Omitting unrequested author trivia must not force a bloated fallback');
assert.equal(result.quality.factCoverage, 1, 'Every selected answer fact must still be covered');
assert.equal(tools.researchReportQuality(report.replaceAll('[F2]', ''), [source], facts.slice(0, 2)).ok, false,
  'Removing a selected answer fact still fails the same completeness gate');
assert.equal(state.facts.length, 3);
const finalContext = tools.writeFinalFromFacts('Compare periods', state, { research: true, report: result.report });
assert.ok(finalContext.includes('Rotation is 243 days.') && finalContext.includes('Orbit is 225 days.'));
assert.ok(!finalContext.includes('The article author is Example.'), 'Final writer must not reintroduce discarded background');
const unrelated = { sourceId: 'S2', url: 'https://unrelated.test/', read: true };
state.byUrl.set(unrelated.url, unrelated);
assert.deepEqual(tools.researchAnswerSources(state, facts.slice(0, 2)), [source]);
assert.equal(state.byUrl.size, 2, 'Source cards must retain the full visited-page record');
assert.deepEqual(tools.researchAnswerSources(state, [{ fact: 'Legacy fact without provenance' }]), [source, unrelated]);
assert.deepEqual(tools.researchAnswerSources(state, [{ fact: 'Unknown source', sourceUrl: 'https://unknown.test/' }]), [source, unrelated]);
for (const id of ['F99', 'S99', 'F3']) {
  const quality = tools.researchReportQuality(report + `\nInvented extra claim [${id}].`, [source], facts.slice(0, 2));
  assert.equal(quality.ok, false, 'Unknown citations must fail even when every selected fact is also cited');
  assert.deepEqual(quality.unknownCitations, [id]);
}

const controller = new AbortController();
respond = async () => { controller.abort(); return report; };
await assert.rejects(tools.synthesizeResearchReport('Compare periods', state, { webSignal: controller.signal }), { name: 'AbortError' });
console.log('research_answer_selection: known-ID selection, full evidence retention, conservative malformed fallback, selected-fact coverage and Stop during synthesis passed');

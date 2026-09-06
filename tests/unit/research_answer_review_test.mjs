import assert from 'node:assert/strict';
import fs from 'node:fs';

// Execute production writer/reviewer/delivery with controlled model replies.
// These tests prove correction and publication behavior, not model intelligence.
const runtime = fs.readFileSync('extension/search/runtime.js', 'utf8');
let replies = [], requests = [];
const definitions = JSON.stringify({ comparisons: [{ value: '40', definitions: [
  { factIds: ['F1'], meaning: 'Guest-excluding participant count' },
  { factIds: ['F2'], meaning: 'Guest-including participant count' },
], relation: 'different', summary: 'Guest inclusion differs; the equal total does not establish agreement.' }] });
let comparisonReply = definitions;
const tools = new Function('Api', `
  const WEB_RESEARCH_TOTAL_TIMEOUT_MS = Infinity;
  ${runtime}
  return { researchWordLimit, researchReportQuality, synthesizeResearchReport,
    researchReportForDelivery, buildResearchReportDraft, buildFactsContext, compareResearchQuantities, auditResearchReport };
`)({ completeText: async (payload, signal) => {
  requests.push(payload);
  if (payload.messages[0].content.startsWith('Compare the literal meanings')) return comparisonReply;
  assert.ok(replies.length, 'Unexpected extra model turn');
  const next = replies.shift();
  return typeof next === 'function' ? next(payload, signal) : next;
} });
const source = { sourceId: 'S1', title: 'Survey', url: 'https://example.test/survey', read: true };
const source2 = { sourceId: 'S2', title: 'Follow-up', url: 'https://example.test/followup', read: true };
const facts = [
  { factId: 'F1', sourceId: 'S1', sourceUrl: source.url, fact: 'The survey reports 40 participants, excluding guests.', excerpt: '40 participants, excluding guests' },
  { factId: 'F2', sourceId: 'S2', sourceUrl: source2.url, fact: 'The follow-up reports 40 participants, including guests.', excerpt: '40 participants, including guests' },
];
const state = { facts, byUrl: new Map([[source.url, source], [source2.url, source2]]),
  judge: { decision: 'enough', answerFactIds: ['F1'], gaps: [] } };
const clean = JSON.stringify({ claimsSupported: true, requestedPartsCovered: true, conflictsHandled: true, instructionsFollowed: true, issues: [] });
const conflict = JSON.stringify({ claimsSupported: false, requestedPartsCovered: true, conflictsHandled: false, instructionsFollowed: true,
  issues: [{ detail: 'Attribute both definitions; guest inclusion differs and is unresolved.', factIds: ['F1', 'F2'] }] });
const bad = `Both sources agree: 40 participants excluding guests [F1]. ${source.url}`;
const good = `The survey excludes guests [F1], while the follow-up includes them [F2]. Both report 40, but their populations differ; the guest-free count is unresolved.\n\nSources: ${source.url} ${source2.url}`;
function feed(...values) { replies = values; requests = []; }
function deliver(result, query) { return tools.researchReportForDelivery({ mode: 'research', report: result.report, reportQuality: result.quality }, query); }

for (const [query, expected] of [
  ['at most 250 words', 250], ['below 250 words', 249], ['under 1 word', 0],
  ['no more than 120 words', 120], ['al massimo 120 parole', 120], ['meno di 80 parole', 79],
  ['non più di 90 parole', 90], ['Maximum of 100 words', 100],
  ['at least 250 words', null], ['a 250-word source', null], ['about 100 words', null],
]) assert.equal(tools.researchWordLimit(query), expected, query);
const exact = `40 participants [F1] ${source.url}`;
assert.equal(tools.researchReportQuality(exact, [source], facts.slice(0, 1), 'at most 4 words').ok, true);
assert.equal(tools.researchReportQuality(exact, [source], facts.slice(0, 1), 'below 4 words').lengthOk, false);

feed(bad, conflict, good, clean);
const result = await tools.synthesizeResearchReport('Compare participant totals in at most 80 words', state, {});
assert.equal(result.fallback, false);
assert.equal(result.attempts.length, 2);
assert.equal(result.attempts[0].quality.audit.conflictsHandled, false);
assert.equal(result.report, good, 'Counter-evidence omitted by selection must be accepted when explicitly cited in repair');
assert.equal(result.quality.factCoverage, 1);
assert.equal(state.facts, facts, 'A review must not mutate the canonical evidence');
assert.deepEqual(state.judge.answerFactIds, ['F1']);
assert.equal(deliver(result, result.quality.request).content, good, 'Exact reviewed bytes, no second writer');
assert.equal(deliver(result, 'A new question').complete, false);
assert.equal(tools.researchReportForDelivery({ mode: 'research', report: good + ' altered', reportQuality: result.quality }, result.quality.request).content, '');
assert.equal(tools.researchReportForDelivery({ mode: 'search', report: good, reportQuality: result.quality }, result.quality.request), null);
assert.equal(tools.researchReportForDelivery({ mode: 'research', report: good }, 'Legacy'), null);

const selected = { ...state, facts: facts.slice(0, 1), byUrl: new Map([[source.url, source]]) };
feed(`${'Unnecessary '.repeat(55)}${bad}`, clean, exact, clean);
const shorter = await tools.synthesizeResearchReport('Report the survey in at most 20 words', selected, {});
assert.equal(shorter.attempts[0].quality.lengthOk, false, 'A model approval cannot waive a real word ceiling');
assert.equal(shorter.report, exact);
assert.equal(shorter.quality.ok, true);

// A caution can itself be unsupported. Exercise correction without deleting
// the existing general rule or retaining the rejected draft as a success.
const ruleState = { ...selected, facts: [{ ...facts[0], fact: 'Membership is required for every booking except open days.',
  excerpt: 'Every booking requires membership, except open days.' }] };
const ruleAnswer = `Membership is required for bookings except open days [F1]. ${source.url}`;
const inventedGap = ruleAnswer + '\n\nGaps: No source verifies whether membership is required outside open days.';
const gapReview = JSON.stringify({ claimsSupported: false, requestedPartsCovered: true, conflictsHandled: true,
  instructionsFollowed: true, issues: [{ detail: 'Remove the invented gap: the general rule already covers bookings outside its explicit exception.', factIds: ['F1'] }] });
feed(inventedGap, gapReview, ruleAnswer, clean);
const correctedGap = await tools.synthesizeResearchReport('When is membership required?', ruleState, {});
assert.equal(correctedGap.attempts[0].quality.audit.claimsSupported, false);
assert.equal(correctedGap.report, ruleAnswer);
assert.equal(deliver(correctedGap, 'When is membership required?').content, ruleAnswer);
assert.equal(correctedGap.attempts[0].report, inventedGap, 'Keep the original unsupported caution for diagnosis');

feed(bad, conflict, bad, conflict, bad, conflict);
const exhausted = await tools.synthesizeResearchReport('Compare totals', state, {});
assert.equal(requests.length, 7, 'One source comparison, then at most three writer/reviewer pairs');
assert.equal(exhausted.attempts.length, 3, 'Rejected answers remain diagnosable');
assert.equal(exhausted.quality.ok, false);
assert.equal(deliver(exhausted, 'Compare totals').complete, false, 'Never label a failed review as a completed answer');

for (const invalid of ['{}', '{"issues":[]}', clean.replace('"issues":[]', '"issues":[{"detail":"unsupported","factIds":["F99"]}]')]) {
  feed(bad, invalid);
  const rejected = await tools.synthesizeResearchReport('Compare totals', state, {});
  assert.equal(rejected.quality.ok, false, 'Missing or fabricated review evidence fails closed');
  assert.equal(deliver(rejected, 'Compare totals').complete, false);
}
const stop = new AbortController();
feed(bad, () => { stop.abort(); return clean; });
await assert.rejects(tools.synthesizeResearchReport('Compare totals', state, { webSignal: stop.signal }), { name: 'AbortError' });
assert.equal(requests.length, 3, 'Cancellation during review cannot launch a repair');
feed(bad, () => { throw new Error('Review transport unavailable'); });
const unavailable = await tools.synthesizeResearchReport('Compare totals', state, {});
assert.equal(unavailable.quality.ok, false);
assert.equal(deliver(unavailable, 'Compare totals').complete, false);

for (const invalid of ['{}', definitions.replace('"F2"', '"F99"'), definitions.replace('"F2"', '"F1"')]) {
  comparisonReply = invalid; feed();
  const rejected = await tools.synthesizeResearchReport('Compare totals', state, {});
  assert.equal(requests.length, 1, 'Invalid definition review cannot authorize writing an unchecked answer');
  assert.equal(rejected.quality.ok, false);
  assert.equal(rejected.quality.wordCount, rejected.report.trim().split(/\s+/).length, 'Fallback diagnostics describe the actual displayed draft');
}
comparisonReply = definitions;

// Reproduce the live parser failure: two valid JSON comparison envelopes must
// not become a truncated or comma-joined object. Preserve both groups and IDs.
const group40 = JSON.parse(definitions);
const group5 = structuredClone(group40); group5.comparisons[0].value = '5';
const twoValues = facts.map(fact => ({ ...fact, fact: fact.fact + ' Five guests: 5.' }));
for (const reply of [JSON.stringify([group40, group5]), '```json\n' + JSON.stringify([group40, group5]) + '\n```']) {
  comparisonReply = reply; feed();
  const compared = await tools.compareResearchQuantities('Compare counts', twoValues, {}, 1000);
  assert.deepEqual(compared.map(item => item.value), ['40', '5']);
  assert.deepEqual(compared[1].definitions.flatMap(item => item.factIds), ['F1', 'F2']);
}
for (const reply of [JSON.stringify([group40, group40]), JSON.stringify([group40]), '[{"comparisons":[]},{"other":[]}]']) {
  comparisonReply = reply; feed();
  await assert.rejects(tools.compareResearchQuantities('Compare counts', twoValues, {}, 1000));
}
comparisonReply = definitions;

feed();
assert.deepEqual(await tools.compareResearchQuantities('Describe one source', facts.slice(0, 1), {}, 1000), []);
assert.equal(requests.length, 0, 'No shared-source numbers need no extra comparison call');
const tooManyValues = facts.map(fact => ({ ...fact, fact: Array.from({ length: 25 }, (_, i) => i + 100).join(' ') }));
await assert.rejects(tools.compareResearchQuantities('Compare counts', tooManyValues, {}, 1000), /bounded input/);
await assert.rejects(tools.compareResearchQuantities('Compare counts', facts.map(fact => ({ ...fact, excerpt: 'x'.repeat(25000) })), {}, 1000), /bounded input/);
await assert.rejects(tools.auditResearchReport('Compare counts', good,
  { ...state, facts: [{ ...facts[0], excerpt: 'x'.repeat(64001) }] }, {}, 1000), /bounded answer-review input/);
assert.equal(requests.length, 0, 'Oversized evidence is rejected before an expensive model call');

const draft = tools.buildResearchReportDraft('Compare totals', [source, source2], facts, { gaps: ['Guest definitions conflict.'] });
assert.match(draft, /Guest definitions conflict/);
assert.doesNotMatch(draft, /No direct contradiction/);
assert.doesNotMatch(tools.buildFactsContext('Compare totals', [source, source2], facts, { research: true }), /No direct contradiction/);
console.log('research_answer_review: real repair/delivery, retained counter-evidence, exact word ceilings, malformed review, bounded failure and cancellation passed (simulated model)');

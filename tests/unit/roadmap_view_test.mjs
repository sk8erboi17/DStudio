// Execute the production Learn presentation helpers: audit counts, hours,
// stage dependencies, short titles and checkpoint criteria. Display-only
// derivations of saved data; no model and no DOM.
import assert from 'node:assert/strict';
import {loadRoadmapFunctions} from '../support/roadmap_functions.mjs';
const api = loadRoadmapFunctions();

const audit = {version: 2, completed: 7, total: 10, records: [
  {key: 'a', scope: 'basi', checks: [
    {id: 'basi/stage', verdict: 'supported'},
    {id: 'basi/primo/concepts', verdict: 'unverified'},
    {id: 'basi/primo/application', verdict: 'not_factual'},
    {id: 'basi/secondo/concepts', verdict: 'supported'},
  ]},
  {key: 'b', scope: 'global', checks: [
    {id: 'global/learner', verdict: 'unverified'},
    {id: 'global/basi/capstone', verdict: 'contradicted'},
    {id: 'global/basi/avanzato', verdict: 'supported'},
    {id: 'basi/ignored', verdict: 'not-a-verdict'},
  ]},
  {key: 'c', scope: 'broken', checks: 'not a list'},
]};
const summary = api.roadmapAuditSummary(audit);
assert.deepEqual(summary.all, {supported: 3, not_factual: 1, unverified: 2, contradicted: 1});
assert.deepEqual(summary.capstone, {supported: 0, not_factual: 0, unverified: 0, contradicted: 1});
assert.deepEqual(summary.byStage.get('basi'), {supported: 2, not_factual: 1, unverified: 1, contradicted: 0});
assert.deepEqual(summary.byTopic.get('basi/primo'), {supported: 0, not_factual: 1, unverified: 1, contradicted: 0});
assert.equal(summary.byTopic.has('basi/stage'), false, 'Stage-level checks are not attributed to a block');
assert.equal(summary.byStage.has('global'), false, 'Global checks are not attributed to a stage');
assert.deepEqual([summary.completed, summary.total, summary.missing], [7, 10, 3]);
assert.equal(api.roadmapAuditSummary(null).total, 0);
assert.equal(api.roadmapAuditLabel(summary.byStage.get('basi')), '2 confirmed · 1 to verify');
assert.equal(api.roadmapAuditLabel({supported: 1, unverified: 0, contradicted: 2, not_factual: 0}), '1 confirmed · 2 contradicted');
assert.equal(api.roadmapAuditLabel({supported: 0, unverified: 0, contradicted: 0, not_factual: 3}), 'nothing factual to verify');

assert.deepEqual(api.roadmapHours([{estimatedHours: 2.5}, {estimatedHours: 3, optional: true}, {estimatedHours: 'x'}, {}]),
  {required: 2.5, optional: 3});
assert.equal(api.roadmapHoursText(9.5), '9.5 h');
assert.equal(api.roadmapHoursText(13), '13 h');

const roadmap = {stages: [
  {id: 's1', topics: [{id: 'a', prerequisites: []}, {id: 'b', prerequisites: ['a']}]},
  {id: 's2', topics: [{id: 'c', prerequisites: ['b']}]},
  {id: 's3', topics: [{id: 'd', prerequisites: ['c', 'a', 'd', 'missing']}]},
]};
assert.deepEqual(api.roadmapStageDependencies(roadmap), [[], [1], [1, 2]],
  'Only earlier stages count; self, missing and repeated prerequisites are ignored');
assert.equal(api.roadmapDependencyText([]), 'starting point');
assert.equal(api.roadmapDependencyText([1]), 'after stage 1');
assert.equal(api.roadmapDependencyText([2, 3, 4]), 'after stages 2, 3 and 4');

assert.equal(api.roadmapShortTitle('Concetti fondamentali: marketing, valore, scambio'), 'Concetti fondamentali');
assert.equal(api.roadmapShortTitle('Ricerca, dati e analisi del mercato'), 'Ricerca, dati e analisi del mercato',
  'Commas are kept unless the caller asks for a prerequisite name');
assert.equal(api.roadmapShortTitle('Processo di marketing, contesto di mercato e attori', 34, {comma: true}), 'Processo di marketing');
const cut = api.roadmapShortTitle("Contesto organizzativo e ruolo del marketing nell'impresa", 34, {comma: true});
assert.ok(cut.endsWith('…') && cut.length <= 35 && !/\s…$/.test(cut), `Long titles stop at a word boundary: ${cut}`);
assert.equal(api.roadmapShortTitle('Etica: x', 48), 'Etica: x', 'A too-short head keeps the full title');

const checkpoint = "Mappa il processo di marketing per un'azienda reale e scrivi una nota di 300 parole; un revisore verifica che i concetti siano distinti. La mappa deve includere fasi e attori; la nota deve collegare offerta e valore.";
const parts = api.roadmapCheckpointParts(checkpoint);
assert.equal(parts.summary, "Mappa il processo di marketing per un'azienda reale e scrivi una nota di 300 parole");
assert.deepEqual(parts.criteria, ['Un revisore verifica che i concetti siano distinti', 'La mappa deve includere fasi e attori',
  'La nota deve collegare offerta e valore']);
const words = text => text.toLowerCase().replace(/[^\p{L}\p{N}' ]+/gu, ' ').split(/\s+/).filter(Boolean);
assert.deepEqual(words([parts.summary, ...parts.criteria].join(' ')), words(checkpoint), 'Splitting neither drops nor adds words');
assert.deepEqual(api.roadmapCheckpointParts('Un solo criterio senza punto finale'), {summary: 'Un solo criterio senza punto finale', criteria: []});
assert.deepEqual(api.roadmapCheckpointParts(''), {summary: '', criteria: []});
console.log('PASS: Learn view summaries: audit counts by stage/block/final project, hours, stage dependencies, short titles and lossless checkpoint criteria (no model)');

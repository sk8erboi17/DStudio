import assert from 'node:assert/strict';
import {ds41Tasks, checkDs41Answer, ds41TextReport, ds41MemoryMode} from '../support/ds41_benchmark.mjs';

const cases = ds41Tasks();
assert.equal(cases.gates.length + cases.workloads.length * 3, 14);
assert.equal(new Set([...cases.gates, ...cases.workloads].map(c => c.id)).size, 8);
const response = (content, finish_reason = 'stop') => ({choices: [{finish_reason, message: {content}}]});
for (const task of [...cases.gates, ...cases.workloads]) {
  const answer = task.kind === 'json' ? JSON.stringify(task.expected) : task.expected;
  assert.doesNotThrow(() => checkDs41Answer(task, response(answer)));
  assert.throws(() => checkDs41Answer(task, response(answer, 'length')));
  assert.throws(() => checkDs41Answer(task, response('some nonempty incorrect answer')));
  assert.throws(() => checkDs41Answer(task, {choices: [{finish_reason: 'stop', message: {content: answer, tool_calls: [{}]}}]}));
}
// Independently verify the nontrivial fixture answers, not just checker acceptance.
assert.equal(cases.gates[0].expected, 43 * 29 + '');
assert.equal(cases.gates[1].expected, 2 ** 2 + 4 ** 2 + 6 ** 2 + '');
assert.deepEqual(cases.workloads[2].expected, [
  {id: 'Z009', amount: 389, group: 'east'},
  {id: 'Z077', amount: 594, group: 'east'},
  {id: 'Z126', amount: 903, group: 'north'},
]);
assert.throws(() => checkDs41Answer(cases.gates[3], response('{"product":"lantern","units":7,"price":0}')));
assert.throws(() => checkDs41Answer(cases.gates[4], response('[24,42]')));

const startup = 'ds4: SSD streaming initial metal model map (4 spans, 1.00 GiB tensor span)\n' +
  'ds4: metal SSD streaming cache target 8.00 GiB; effective 8.00 GiB = 1.00 GiB prefill headroom + 7.00 GiB dynamic cache (7168 experts, 1.00 MiB each)\n';
const memory = ds41MemoryMode(startup);
assert.equal(memory.expertStreaming, true);
assert.equal(memory.approximateDynamicGiB, 7);
assert.equal(memory.effectiveExperts, 7168);
assert.equal(ds41MemoryMode(startup + 'ds4: V4.1 SSD cache fitted from 7168 to 1024 experts for context/runtime headroom\n').approximateDynamicGiB, 1);
assert.equal(ds41MemoryMode(startup + 'ds4: V4.1 SSD cache fitted from 7000 to 1024 experts for context/runtime headroom\n'), null);
assert.equal(ds41MemoryMode(startup + 'ds4: V4.1 SSD cache fitted from 7168 to 0 experts for context/runtime headroom\n'), null);
assert.equal(ds41MemoryMode(startup.replace('metal model map', 'cpu model map')), null);
assert.equal(ds41MemoryMode(startup.replace('7.00 GiB dynamic cache (7168 experts, 1.00 MiB each)',
  '0.00 GiB dynamic cache (0 experts, 0.00 MiB each)')).effectiveExperts, 0);
assert.equal(ds41MemoryMode(startup + startup), null);
assert.equal(ds41MemoryMode('requested --ssd-streaming'), null);

const partial = {plannedRequests: 14, gates: [{status: 'pass'}, {status: 'fail'}], runs: [], allCorrect: false};
const text = ds41TextReport(partial);
assert.ok(text.includes('1/14. Fallite: 1. Non completate: 12.'));
assert.ok(text.includes('Nessuna velocità qualificata'));
assert.ok(text.includes('NON ANCORA VERIFICATO'));
const failed = ds41TextReport({...partial, finishedAt: '2026-09-12T00:00:00Z',
  summary: {'exact-copy': {decode: {median: 999, min: 900, max: 1000}}}});
assert.ok(failed.includes('FALLITO / INCOMPLETO'));
assert.ok(!failed.includes('999.00'), 'failed measurements must not become a qualified speed');
const passed = ds41TextReport({allCorrect: true, finishedAt: '2026-09-12T00:00:00Z', cases,
  plannedRequests: 14, gates: Array.from({length: 5}, () => ({status: 'pass'})),
  runs: Array.from({length: 9}, (_, i) => ({status: 'pass', id: 'exact-copy', repeat: i + 1})),
  summary: {'exact-copy': {decode: {median: 12.5, min: 11, max: 14}, prefill: null}}});
assert.ok(passed.includes('14/14. Fallite: 0. Non completate: 0.'));
assert.ok(passed.includes('12.50 token/s'));
assert.ok(passed.includes('Lettura: mediana non disponibile'));
console.log('ds41_benchmark_test: PASS (independent answers, truncation, invented data, failure denominators and unqualified speeds)');

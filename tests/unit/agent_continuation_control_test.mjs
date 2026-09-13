// Execute the live runner's actual deadline/admission code without a model.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import {extractFunction} from '../support/real_harness.mjs';
const source = fs.readFileSync('tests/live/agent_continuation_live.mjs', 'utf8');
const functions = ['until', 'scenario', 'continuationPrefill'].map(name => extractFunction(source, name)).join('\n');
function context() {
  let now = 0;
  const c = vm.createContext({
    assert,
    report: {settings: {deadlinePerTurnSeconds: 1}, cases: [
      {id: 'first', state: 'not-run', passed: false}, {id: 'second', state: 'not-run', passed: false},
    ]},
    performance: {now: () => now++ * 2000}, family: 'fixture',
    streamFailure: null, closeResult: null, trace: () => '', save: () => {},
    sleep: async () => {}, console: {log() {}, error() {}},
  });
  vm.runInContext(functions, c); return c;
}
test('deadline aborts remaining live scenarios instead of queueing after an unknown turn', async () => {
  const c = context();
  await assert.rejects(vm.runInContext("scenario('first', () => until(() => false, 'terminal readiness'))", c),
    /remaining cases not run/);
  assert.match(c.streamFailure, /^Deadline exceeded: terminal readiness$/);
  assert.equal(c.report.cases[0].state, 'failed');
  assert.equal(c.report.cases[1].state, 'not-run');
});
test('completed condition leaves transport usable', async () => {
  const c = context(); c.performance.now = () => 0;
  await vm.runInContext("scenario('first', () => until(() => true, 'ready'))", c);
  assert.equal(c.report.cases[0].state, 'passed');
  assert.equal(c.streamFailure, null);
});
test('Qwen keeps its chunk while Laguna selects its supported native prefill', () => {
  const c = context();
  const selection = family => JSON.parse(JSON.stringify(vm.runInContext(`continuationPrefill('${family}')`, c)));
  assert.deepEqual(selection('qwen35'), {chunk: 512, args: ['--prefill-chunk', '512']});
  assert.deepEqual(selection('laguna'), {chunk: null, args: []});
  assert.throws(() => selection('unknown'), /Unsupported continuation engine family/);
});

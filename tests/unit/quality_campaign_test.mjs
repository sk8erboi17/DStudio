// Executes the campaign coverage accounting on controlled receipts and on the
// shipped matrix. No model runs; the receipts below are synthetic by design.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { attemptFromHostReceipt, attemptsFromNativeReceipt, collectAttempts, coverage, loadCampaign, mismatch }
  from '../support/quality_campaign.mjs';

const campaign = loadCampaign('tests/fixtures/quality_campaign.json');
assert.equal(campaign.selections.length, 10, 'the plan has ten selections');
assert.deepEqual(campaign.selections.filter((s) => s.plan === 'contributor').map((s) => s.id).sort(),
  ['deepseek-v41-flash-q4', 'glm-53-flash-q2']);
const byId = Object.fromEntries(campaign.selections.map((s) => [s.id, s]));
const LLAMA = 'f5027fb21307eb264aed483242603d68c87b0fe3', MAIN = '890898cfb437ed256be58ebcf7c58a6dfa8f2f53';

const host = (over = {}) => ({ schema: 'dstudio.host-common-quality.v1', status: 'fail', started: '2026-11-11T01:00:00Z', finished: '2026-11-11T02:00:00Z',
  selection: { modelFile: 'gguf/Qwen3.6-35B-A3B-UD-Q6_K_XL.gguf', engine: 'llama' }, qualityUse: 'development-replay',
  effective: { ssdStreamingEffective: false }, weights: { verified: true, files: [{ name: 'Qwen3.6-35B-A3B-UD-Q6_K_XL.gguf', sha256: 'a'.repeat(64) }] },
  engine: { identity: { receipts: { '.dstudio-llama.json': { content: { bundledSources: { commit: LLAMA } } } } } },
  summary: { denominator: 100, passed: 71, failed: 29, notRun: 0, pending: 0 }, ...over });

// A terminal host receipt on the pinned engine counts, with its real counts.
let attempt = attemptFromHostReceipt(host(), 'host-common-quality/run-a');
assert.equal(mismatch(byId['qwen36-35b-a3b-ud-q6-k-xl'], attempt), '');
let result = coverage(campaign, [attempt]);
let cell = result.rows.find((row) => row.selection === 'qwen36-35b-a3b-ud-q6-k-xl');
assert.deepEqual([cell.status, cell.passed, cell.failed, cell.notRun, cell.denominator], ['FAIL', 71, 29, 0, 100]);

// A later perfect rerun is listed but does not replace the first terminal result.
const rerun = attemptFromHostReceipt(host({ status: 'pass', started: '2026-11-12T01:00:00Z', finished: '2026-11-12T02:00:00Z',
  summary: { denominator: 100, passed: 100, failed: 0, notRun: 0, pending: 0 } }), 'host-common-quality/run-b');
cell = coverage(campaign, [rerun, attempt]).rows.find((row) => row.selection === 'qwen36-35b-a3b-ud-q6-k-xl');
assert.equal(cell.status, 'FAIL'); assert.equal(cell.counted, 'host-common-quality/run-a'); assert.equal(cell.attempts.length, 2);

// Another engine revision, another engine, or the wrong memory mode is excluded with its reason.
const stale = attemptFromHostReceipt(host({ engine: { identity: { receipts: { '.dstudio-llama.json': { content: { bundledSources: { commit: '0'.repeat(40) } } } } } } }), 'host-common-quality/run-old');
cell = coverage(campaign, [stale]).rows.find((row) => row.selection === 'qwen36-35b-a3b-ud-q6-k-xl');
assert.equal(cell.status, 'NOT_RUN'); assert.match(cell.excluded[0].reason, /engine revision/); assert.equal(cell.notRun, 100);
const v41 = (effective) => attemptFromHostReceipt(host({ selection: { modelFile: byId['deepseek-v41-flash-1017-q2'].modelFile, engine: 'ds4' },
  effective: { ssdStreamingEffective: effective }, engine: { identity: { receipts: { '.dstudio-source.json': { content: { commit: MAIN } } } } } }), 'host-common-quality/run-v41');
assert.match(mismatch(byId['deepseek-v41-flash-1017-q2'], v41(false)), /SSD streaming/, 'V4.1 counts only with streaming effective');
assert.equal(mismatch(byId['deepseek-v41-flash-1017-q2'], v41(true)), '');

// An interrupted or unfinished run is not an executed result: all 100 stay not run.
const unfinished = attemptFromHostReceipt(host({ status: 'running', finished: undefined, summary: { denominator: 100, passed: 12, failed: 0, notRun: 0, pending: 88 } }), 'host-common-quality/run-c');
cell = coverage(campaign, [unfinished]).rows.find((row) => row.selection === 'qwen36-35b-a3b-ud-q6-k-xl');
assert.deepEqual([cell.status, cell.passed, cell.notRun], ['NOT_RUN', 0, 100]);
assert.match(cell.reason, /terminal/);

// A terminal run that stopped early keeps its unexecuted cases in the denominator.
const early = attemptFromHostReceipt(host({ summary: { denominator: 100, passed: 2, failed: 1, notRun: 97, pending: 0 } }), 'host-common-quality/run-d');
cell = coverage(campaign, [early]).rows.find((row) => row.selection === 'qwen36-35b-a3b-ud-q6-k-xl');
assert.deepEqual([cell.status, cell.passed, cell.failed, cell.notRun], ['FAIL', 2, 1, 97]);
// A receipt with a shrunken denominator can never pass.
const shrunk = attemptFromHostReceipt(host({ status: 'pass', summary: { denominator: 20, passed: 20, failed: 0, notRun: 0, pending: 0 } }), 'host-common-quality/run-e');
cell = coverage(campaign, [shrunk]).rows.find((row) => row.selection === 'qwen36-35b-a3b-ud-q6-k-xl');
assert.equal(cell.status, 'FAIL'); assert.match(cell.reason, /denominator/);

// Contributor selections stay BLOCKED even with a passing receipt; missing weights are BLOCKED.
const glm = attemptFromHostReceipt(host({ status: 'pass', selection: { modelFile: byId['glm-53-flash-q2'].modelFile, engine: 'ds4' },
  engine: { identity: { receipts: { '.dstudio-source.json': { content: { commit: MAIN } } } } }, summary: { denominator: 100, passed: 100, failed: 0, notRun: 0, pending: 0 } }), 'host-common-quality/run-glm');
result = coverage(campaign, [glm], { weightsPresent: (s) => s.id !== 'qwen38-flash-next-q2' });
assert.equal(result.rows.find((row) => row.selection === 'glm-53-flash-q2').status, 'BLOCKED');
assert.equal(result.rows.find((row) => row.selection === 'qwen38-flash-next-q2').status, 'BLOCKED');
assert.equal(result.rows.find((row) => row.selection === 'laguna-s21-q4-k-m').status, 'NOT_RUN');
assert.deepEqual(result.totals, { cells: 10, denominator: 1000, passed: 0, failed: 0, notRun: 1000, byStatus: { PASS: 0, FAIL: 0, NOT_RUN: 7, BLOCKED: 3 } });

// Native receipts: engine revision comes from the recorded source receipt.
const native = { schema: 'dstudio.engine-acceptance.v1', started: '2026-11-11T05:00:00Z', results: [{ engine: 'qwen',
  inference: { model: { path: '/store/gguf/Qwen3.8-Flash-Next-Q4.gguf', sha256: 'b'.repeat(64) }, installer: { engine: 'main', commit: MAIN }, models: { data: [{ id: 'm' }] } },
  quality: { report: { status: 'fail', evaluationUse: 'development-replay', started: '2026-11-11T05:01:00Z', finished: '2026-11-11T07:00:00Z',
    summary: { denominator: 100, passed: 75, failed: 25, notRun: 0, pending: 0 } } } }] };
const nativeAttempts = attemptsFromNativeReceipt(native, 'engine-acceptance/run-n');
assert.equal(nativeAttempts.length, 1);
cell = coverage(campaign, nativeAttempts).rows.find((row) => row.selection === 'qwen38-flash-next-q4');
assert.deepEqual([cell.status, cell.passed, cell.failed], ['FAIL', 75, 25]);
native.results[0].inference.installer.commit = '0aaea5a0000000000000000000000000000000000';
cell = coverage(campaign, attemptsFromNativeReceipt(native, 'engine-acceptance/run-old')).rows.find((row) => row.selection === 'qwen38-flash-next-q4');
assert.equal(cell.status, 'NOT_RUN', 'a result on an earlier engine pin does not transfer');
assert.deepEqual(attemptsFromNativeReceipt({ schema: 'other' }, 'x'), []);
assert.equal(attemptFromHostReceipt({ schema: 'other' }, 'x'), null);

// Receipts on disk: a readable one is collected, a damaged one is reported.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quality-campaign-'));
try {
  fs.mkdirSync(path.join(dir, 'host-common-quality/run-ok'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'host-common-quality/run-bad'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'host-common-quality/run-empty'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'host-common-quality/run-ok/results.json'), JSON.stringify(host()));
  fs.writeFileSync(path.join(dir, 'host-common-quality/run-bad/results.json'), '{not json');
  const collected = collectAttempts(dir);
  assert.equal(collected.attempts.length, 1); assert.equal(collected.attempts[0].source, 'host-common-quality/run-ok');
  assert.deepEqual(collected.unreadable.map((row) => row.source), ['host-common-quality/run-bad']);
} finally { fs.rmSync(dir, { recursive: true, force: true }); }

assert.throws(() => { const file = path.join(os.tmpdir(), `campaign-${process.pid}.json`);
  fs.writeFileSync(file, JSON.stringify({ schema: 'dstudio.quality-campaign.v1', selections: [{ id: 'a', plan: 'maintainer', engine: 'ds4' }, { id: 'a', plan: 'maintainer', engine: 'ds4' }], suites: [] }));
  try { loadCampaign(file); } finally { fs.rmSync(file, { force: true }); } }, /duplicate/);

console.log('PASS: campaign coverage keeps denominators, first terminal results, identity exclusions, BLOCKED rows and unreadable receipts (synthetic receipts; no model)');

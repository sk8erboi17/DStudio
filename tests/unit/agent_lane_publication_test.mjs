// Six-agent, two-lane publication (`publish-cli-comparison.mjs --lanes` and
// `plot-cli-comparison.py`) on SYNTHETIC lane receipts written by this test.
//
// The receipts are shaped by the lane runner's own plan and result-row
// functions (buildLanePlan, attemptIdentity, notAttempted); their outcomes and
// times are invented here and every receipt says so in its `synthetic` field.
// They are not measurements: nothing is written under docs/ or assets/, and
// the plotter must refuse to put a synthetic figure where published figures
// live. The figures go to tests/.artifacts for inspection.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildLanePlan, LANE_AGENT_IDS, LANES } from '../../extension/task-graph/bench/agent-lane.mjs';
import { attemptIdentity, notAttempted } from '../../extension/task-graph/bench/lane-drivers.mjs';

const SYNTHETIC = 'SYNTHETIC TEST RECEIPT written by tests/unit/agent_lane_publication_test.mjs; invented outcomes and times, not a measurement';
const PUBLISHER = path.resolve('extension/task-graph/bench/publish-cli-comparison.mjs');
const PLOTTER = path.resolve('extension/task-graph/bench/plot-cli-comparison.py');
const PUBLISHED_FIGURES = path.resolve('assets/README images/benchmarks');
const root = path.resolve('tests/.artifacts/agent-lane-publication');
fs.mkdirSync(root, { recursive: true });
const scratch = fs.mkdtempSync(path.join(root, 'run-'));

const matplotlib = spawnSync('python3', ['-c', 'import matplotlib, numpy'], { encoding: 'utf8' });
if (matplotlib.status !== 0) {
  console.log('matplotlib missing: NOT RUN (the lane plots need python3 with matplotlib and numpy on PATH)');
  process.exit(1);
}

// ---------------------------------------------------------------- synthetic receipts
// A number in [0, 1) from a text, so the invented outcomes are reproducible.
const unit = (text) => crypto.createHash('sha256').update(text).digest().readUInt32BE(0) / 2 ** 32;
const SUCCESS = { 'upstream-agent': 0.5, 'native-agent': 0.7, 'task-graph': 0.85, pi: 0.6, opencode: 0.55, codex: 0.65 };
function inventedAttempt(row) {
  const draw = unit(`outcome ${row.attemptId}`);
  const identity = attemptIdentity(row);
  const time = Math.round(8000 + unit(`time ${row.attemptId}`) * 40000);
  if (draw < SUCCESS[row.agent]) return { ...identity, outcome: 'completed', taskSuccess: true, wallClockMs: time, incorrectCompletionClaim: false, unexpectedChanges: [] };
  const kind = unit(`kind ${row.attemptId}`);
  if (kind < 0.6) return { ...identity, outcome: 'failed', taskSuccess: false, wallClockMs: time, incorrectCompletionClaim: kind < 0.2, unexpectedChanges: kind < 0.1 ? ['x'] : [] };
  if (kind < 0.75) return { ...identity, outcome: 'inconclusive', taskSuccess: false, inconclusiveReason: 'synthetic' };
  if (kind < 0.9) return { ...identity, outcome: 'harness-error', taskSuccess: false, harnessError: 'synthetic' };
  return { ...identity, outcome: 'not-run', taskSuccess: false, reason: 'synthetic stop' };
}
function receipt({ lane, set, repetitions, availability = {} }) {
  const plan = buildLanePlan({ lane, set, repetitions, seed: `synthetic-${lane}-${set}`, agents: LANE_AGENT_IDS, availability });
  const attempts = plan.rows.map((row) => (row.status === 'PLANNED' ? inventedAttempt(row) : notAttempted(row)));
  return {
    schemaVersion: 1, benchmark: 'dstudio-agent-lane', synthetic: SYNTHETIC,
    ok: !attempts.some((attempt) => attempt.outcome === 'not-run'), measuredAt: '2026-11-11T00:00:00.000Z',
    lane: plan.lane, set: plan.set, sets: plan.sets, seed: plan.seed, repetitions: plan.repetitions, agents: plan.agents,
    expectedAttempts: plan.expectedAttempts, planSHA256: 'synthetic', settings: plan.settings,
    model: { file: 'SYNTHETIC-model.gguf', bytes: 1 }, hardware: { chip: 'SYNTHETIC machine', memoryBytes: 1 },
    cliVersions: { pi: 'synthetic', opencode: 'synthetic', codex: 'synthetic' }, upstreamAgent: { unavailable: 'synthetic' },
    dstudio: { commit: 'synthetic', dirty: null }, attempts, limitations: ['Synthetic receipt for the publication test.'],
  };
}
const upstreamMissing = { 'upstream-agent': { available: false, reason: 'no clean upstream build at SYNTHETIC: run build-upstream-agent.mjs', evidence: [] } };
const equivalentAll = receipt({ lane: 'equivalent', set: 'all', repetitions: 3, availability: upstreamMissing });
const equivalentRecovery = receipt({ lane: 'equivalent', set: 'recovery', repetitions: 1 });
const productAll = receipt({ lane: 'product', set: 'all', repetitions: 1 });
const write = (name, value) => {
  const file = path.join(scratch, name);
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  return file;
};
const files = { all: write('equivalent-all.json', equivalentAll), recovery: write('equivalent-recovery.json', equivalentRecovery), product: write('product-all.json', productAll) };

// What this test must not touch, as it stands before the test writes anything
// (the checkout may hold unrelated uncommitted work there): path, size, mtime.
const GUARDED = ['docs', 'assets', 'extension/task-graph/bench/results'];
function guardedState() {
  const state = {};
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else { const st = fs.lstatSync(full); state[full] = `${st.size}:${st.mtimeMs}`; }
    }
  };
  for (const dir of GUARDED) walk(dir);
  return state;
}
const guardedBefore = guardedState();

function publish(output, inputs) {
  return spawnSync(process.execPath, [PUBLISHER, '--lanes', output, ...inputs], { encoding: 'utf8', timeout: 120_000 });
}
function plot(input, output) {
  return spawnSync('python3', [PLOTTER, input, ...(output ? [output] : [])], { encoding: 'utf8', timeout: 300_000 });
}

let checks = 0;
let failures = 0;
function check(name, fn) {
  checks++;
  try {
    fn();
    console.log(`PASS: ${name}`);
  } catch (error) {
    failures++;
    console.log(`FAIL: ${name}\n${error.stack}`);
  }
}

// ---------------------------------------------------------------- publication
const publishedFile = path.join(scratch, 'published.json');
const published = publish(publishedFile, [files.all, files.recovery, files.product]);
const result = published.status === 0 ? JSON.parse(fs.readFileSync(publishedFile, 'utf8')) : null;

check('the publication carries the synthetic label and every agent, group and both lanes', () => {
  assert.equal(published.status, 0, published.stderr);
  assert.match(published.stdout, /SYNTHETIC/);
  assert.equal(result.benchmark, 'dstudio-agent-lane-comparison');
  assert.equal(result.synthetic, SYNTHETIC);
  assert.deepEqual(result.agents.map((agent) => agent.id), LANE_AGENT_IDS);
  assert.deepEqual(result.groups.map((group) => group.id),
    ['development', 'held-out', 'recovery:single', 'recovery:steering', 'recovery:stop-resume', 'recovery:two-sessions']);
  assert.deepEqual(Object.keys(result.lanes), ['equivalent', 'product']);
  assert.equal(result.lanes.equivalent.complete, equivalentAll.ok && equivalentRecovery.ok);
});

// The reference count, written independently of the publisher.
const groupOf = (attempt) => (attempt.caseSet === 'recovery' ? `recovery:${attempt.mechanic}` : attempt.caseSet);
function reference(attempts) {
  const by = (outcome) => attempts.filter((attempt) => attempt.outcome === outcome).length;
  const planned = attempts.length - by('blocked') - by('not-comparable');
  return { attempts: attempts.length, completed: by('completed'), planned, blocked: by('blocked'), notComparable: by('not-comparable'),
    failed: by('failed'), inconclusive: by('inconclusive'), harnessError: by('harness-error'), notRun: by('not-run') };
}

check('every cell keeps the full denominator: failures, inconclusive, harness errors and not-run attempts are planned attempts', () => {
  const attempts = [...equivalentAll.attempts, ...equivalentRecovery.attempts];
  let failuresSeen = 0;
  for (const agent of LANE_AGENT_IDS) {
    for (const group of result.groups.map((item) => item.id)) {
      const cell = result.lanes.equivalent.cells[agent][group];
      const expected = reference(attempts.filter((attempt) => attempt.variant === agent && groupOf(attempt) === group));
      for (const [key, value] of Object.entries(expected)) assert.equal(cell[key], value, `${agent} ${group} ${key}`);
      assert.equal(cell.planned, cell.completed + cell.failed + cell.inconclusive + cell.harnessError + cell.notRun);
      assert.equal(cell.completionRatePercent, cell.planned ? Number((cell.completed / cell.planned * 100).toFixed(1)) : null);
      failuresSeen += cell.failed + cell.inconclusive + cell.harnessError + cell.notRun;
    }
  }
  assert.ok(failuresSeen > 100, 'the synthetic receipts must exercise every kind of failure');
  // Development and held-out are never totalled together.
  const pi = result.lanes.equivalent.cells.pi;
  assert.deepEqual([pi.development.attempts, pi['held-out'].attempts], [150, 60]);
});

check('BLOCKED and NOT_COMPARABLE rows are shown as such, with their reasons, and never enter a rate', () => {
  const cells = result.lanes.equivalent.cells;
  assert.equal(cells['upstream-agent'].development.state, 'blocked');
  assert.equal(cells['upstream-agent'].development.completionRatePercent, null);
  assert.deepEqual(cells['upstream-agent'].development.reasons, [`blocked: ${upstreamMissing['upstream-agent'].reason}`]);
  assert.equal(cells.codex['recovery:steering'].state, 'not-comparable');
  assert.match(cells.codex['recovery:steering'].reasons[0], /^not-comparable: steering is not comparable for Codex/);
  assert.equal(cells.pi['recovery:stop-resume'].state, 'blocked');
  assert.equal(cells.codex['recovery:stop-resume'].state, 'measured');
  // The upstream agent is measured in the recovery run (it was available there).
  assert.equal(cells['upstream-agent']['recovery:single'].state, 'measured');
  for (const agent of LANE_AGENT_IDS) {
    for (const group of ['development', 'held-out']) {
      const cell = result.lanes.product.cells[agent][group];
      assert.equal(cell.state, 'blocked');
      assert.match(cell.reasons[0], /complete-product configuration of .* is not frozen/);
    }
    assert.equal(result.lanes.product.cells[agent]['recovery:single'].state, 'absent');
  }
});

check('time is compared only on the cells every measured agent completed, and the number of those cells is published', () => {
  for (const group of ['development', 'held-out']) {
    const time = result.lanes.equivalent.time[group];
    const attempts = equivalentAll.attempts.filter((attempt) => groupOf(attempt) === group);
    const key = (attempt) => `${attempt.repetition}|${attempt.scenario}`;
    const measured = LANE_AGENT_IDS.filter((agent) => attempts.some((attempt) => attempt.variant === agent && !['blocked', 'not-comparable'].includes(attempt.outcome)));
    assert.deepEqual(time.agents, measured);
    assert.deepEqual(time.excluded, ['upstream-agent']);
    const cells = new Set(attempts.map(key));
    assert.equal(time.cells, cells.size);
    const done = (agent, cell) => attempts.find((attempt) => attempt.variant === agent && key(attempt) === cell && attempt.outcome === 'completed');
    const matched = [...cells].filter((cell) => measured.every((agent) => done(agent, cell)));
    assert.equal(time.matchedCells, matched.length);
    assert.ok(matched.length > 0 && matched.length < cells.size, 'the synthetic data must leave some cells unmatched');
    for (const agent of measured) {
      const times = matched.map((cell) => done(agent, cell).wallClockMs).sort((a, b) => a - b);
      const middle = Math.floor(times.length / 2);
      const median = times.length % 2 ? times[middle] : (times[middle - 1] + times[middle]) / 2;
      assert.equal(time.medianMs[agent], Number(median.toFixed(2)), `${agent} ${group}`);
    }
  }
  assert.equal(result.lanes.product.time.development.agents.length, 0);
  assert.equal(result.lanes.product.time.development.matchedCells, 0);
});

check('a lane without results is published as not run, not left out', () => {
  const output = path.join(scratch, 'equivalent-only.json');
  const run = publish(output, [files.all]);
  assert.equal(run.status, 0, run.stderr);
  const only = JSON.parse(fs.readFileSync(output, 'utf8'));
  assert.deepEqual(only.lanes.product, { label: 'Complete product', published: false, reason: 'no result of this lane was given' });
  assert.equal(only.lanes.equivalent.cells.codex['recovery:single'].state, 'absent');
});

check('the publisher refuses incomplete, double-counted, mixed or inconsistent receipts', () => {
  const refuse = (name, mutate, pattern, extra = []) => {
    const copy = structuredClone(equivalentAll);
    mutate(copy);
    const run = publish(path.join(scratch, `${name}.json`), [write(`${name}-input.json`, copy), ...extra]);
    assert.notEqual(run.status, 0, `${name} was published`);
    assert.match(run.stderr, pattern, name);
    assert.ok(!fs.existsSync(path.join(scratch, `${name}.json`)), `${name} wrote a publication`);
  };
  refuse('dropped-row', (copy) => copy.attempts.pop(), /every row must be published/);
  refuse('unknown-outcome', (copy) => { copy.attempts[0].outcome = 'skipped'; }, /unknown outcome skipped/);
  refuse('blocked-without-reason', (copy) => { const row = copy.attempts.find((attempt) => attempt.outcome === 'blocked'); delete row.reason; }, /blocked without a reason/);
  refuse('success-disagrees', (copy) => { copy.attempts.find((attempt) => attempt.outcome === 'failed').taskSuccess = true; }, /outcome and taskSuccess disagree/);
  refuse('measured-beside-synthetic', (copy) => { delete copy.synthetic; }, /synthetic and measured lane results cannot be published together/, [files.recovery]);
  refuse('another-machine', (copy) => { copy.hardware.chip = 'other'; }, /different machines/, [files.recovery]);
  refuse('same-cases-twice', () => {}, /would count those cases twice/, [files.all]);
});

// ---------------------------------------------------------------- figures
const figures = path.join(scratch, 'figures');
const plotted = result ? plot(publishedFile, figures) : { status: null, stderr: 'no publication' };
const png = (file) => {
  const bytes = fs.readFileSync(file);
  assert.ok(bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), `${file} is not a PNG`);
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
};

check('Matplotlib renders the correctness grid and the matched-time figure of both lanes, labelled synthetic', () => {
  assert.equal(plotted.status, 0, plotted.stderr);
  assert.match(plotted.stdout, /agent_lane_plots: wrote 2 figures .*\(SYNTHETIC\)/);
  const grid = png(path.join(figures, 'agent-lane-correctness.png'));
  const time = png(path.join(figures, 'agent-lane-time.png'));
  assert.ok(grid.width > 1500 && grid.height > 1500, JSON.stringify(grid));
  assert.ok(time.width > 1500 && time.height > 1000, JSON.stringify(time));
});

check('a lane without results and a group with no matched cell still render, saying so', () => {
  const output = path.join(scratch, 'equivalent-only.json');
  const dir = path.join(scratch, 'figures-equivalent-only');
  const run = plot(output, dir);
  assert.equal(run.status, 0, run.stderr);
  png(path.join(dir, 'agent-lane-correctness.png'));
  png(path.join(dir, 'agent-lane-time.png'));
});

check('the plotter refuses to write a synthetic figure where the published figures live', () => {
  const before = fs.existsSync(PUBLISHED_FIGURES) ? fs.readdirSync(PUBLISHED_FIGURES).sort() : [];
  const run = plot(publishedFile);
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /refusing to write figures of a synthetic receipt into the published benchmark images/);
  assert.deepEqual(fs.existsSync(PUBLISHED_FIGURES) ? fs.readdirSync(PUBLISHED_FIGURES).sort() : [], before);
});

check('nothing synthetic was written under docs/ or assets/', () => {
  // Compared with this test's own starting point, not with Git: unrelated
  // uncommitted files there (a run being published) are not this test's
  // writes (gate run check-fast-4e6bae7d-0303 failed on one, retained).
  assert.deepEqual(guardedState(), guardedBefore, 'a file under docs/, assets/ or the bench results was added or changed');
});

console.log(`agent_lane_publication: ${checks - failures}/${checks} checks passed · SYNTHETIC receipts only; figures in ${scratch}`);
process.exit(failures ? 1 : 0);

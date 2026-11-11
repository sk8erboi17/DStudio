// The held-out and long/recovery benchmark cases, graded without any agent or
// model: every oracle must accept its reference result, reject the untouched
// workspace and reject each plausible wrong result. Also the case sets (what a
// default run contains) and the frozen case contents.
//
// The reference results are shell commands written for this test; running them
// says nothing about any agent.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  CASE_SET_FIXTURES, CASE_SETS, caseDigest, createCase, DEFAULT_CASE_SET, frozenCases, listCases, selectCaseSet,
} from '../../extension/task-graph/bench/case-sets.mjs';
import { CASE_REFERENCES } from '../../extension/task-graph/bench/case-references.mjs';
import {
  changeAllowed, changedFiles, createReliabilityFixture, workspaceSnapshot,
} from '../../extension/task-graph/bench/reliability-fixture.mjs';
import { HELD_OUT_SUITE_SIZE, HELD_OUT_TASK_TYPES } from '../../extension/task-graph/bench/held-out-fixture.mjs';
import { RECOVERY_SUITE_SIZE, RECOVERY_TASK_TYPES } from '../../extension/task-graph/bench/recovery-fixture.mjs';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'dstudio-agent-lane-cases-'));
let checks = 0;
let failures = 0;
function check(name, fn) {
  checks++;
  try {
    fn();
  } catch (error) {
    failures++;
    console.log(`FAIL: ${name}\n${error.stack}`);
  }
}

let serial = 0;
function fresh(caseId) {
  const workspace = path.join(scratch, `w${++serial}`);
  return { workspace, ...createCase({ workspace, caseId }) };
}
function runPhase(task, command) {
  const result = spawnSync('sh', ['-c', command], { cwd: task.root, encoding: 'utf8', timeout: 60_000 });
  assert.equal(result.error, undefined, `phase could not run: ${result.error?.message}`);
  return result;
}
function whenHolds(workspace, when) {
  const file = path.join(workspace, when.path);
  return fs.existsSync(file) && (!when.contains || fs.readFileSync(file, 'utf8').includes(when.contains));
}
const phasesFor = { single: 1, steering: 2, 'stop-resume': 2, 'two-sessions': 2 };

// ---------------------------------------------------------------- case sets
check('a run that names no set gets the fifty development cases and nothing held out', () => {
  assert.equal(DEFAULT_CASE_SET, 'development');
  for (const value of [undefined, '', '  ', 'development', 'Development']) assert.equal(selectCaseSet(value), 'development');
  const cases = listCases();
  assert.equal(cases.length, 50);
  assert.ok(cases.every((item) => item.set === 'development' && item.heldOut === false && item.mechanic === 'single'));
  const published = createReliabilityFixture({ workspace: path.join(scratch, 'published'), caseCount: 50, variants: ['pi'] });
  assert.deepEqual(cases.map((item) => item.id), published.scenarios.map((scenario) => scenario.id));
});

check('held-out, all and recovery are selected only by name; an unknown set is refused', () => {
  const heldOut = listCases('held-out');
  assert.equal(heldOut.length, HELD_OUT_SUITE_SIZE);
  assert.equal(HELD_OUT_SUITE_SIZE, 20);
  assert.ok(heldOut.every((item) => item.set === 'held-out' && item.heldOut === true));
  const all = listCases('all');
  assert.equal(all.length, 70);
  assert.deepEqual(all.map((item) => item.id), [...listCases('development'), ...heldOut].map((item) => item.id));
  assert.equal(new Set(all.map((item) => item.id)).size, 70);
  const recovery = listCases('recovery');
  assert.equal(recovery.length, RECOVERY_SUITE_SIZE);
  assert.ok(recovery.every((item) => item.set === 'recovery' && !all.some((other) => other.id === item.id)));
  assert.deepEqual(Object.keys(CASE_SETS), ['development', 'held-out', 'all', 'recovery']);
  for (const value of ['heldout', 'everything', 'held-out,recovery']) assert.throws(() => selectCaseSet(value), /unknown case set/);
  for (const type of HELD_OUT_TASK_TYPES) assert.equal(heldOut.filter((item) => item.kind === type.id).length, 2, type.id);
  for (const type of RECOVERY_TASK_TYPES) {
    const matching = recovery.filter((item) => item.kind === type.id);
    assert.equal(matching.length, 2, type.id);
    assert.ok(matching.every((item) => item.mechanic === type.mechanic));
  }
  assert.deepEqual([...new Set(recovery.map((item) => item.mechanic))].sort(), ['single', 'steering', 'stop-resume', 'two-sessions']);
});

check('no held-out or recovery kind repeats a development kind', () => {
  const development = new Set(listCases('development').map((item) => item.kind));
  for (const item of [...listCases('held-out'), ...listCases('recovery')]) assert.ok(!development.has(item.kind), item.kind);
});

// ---------------------------------------------------------------- oracles
const graded = [...listCases('held-out'), ...listCases('recovery')];
const prompts = new Set();
for (const descriptor of graded) {
  const references = CASE_REFERENCES[descriptor.id];
  check(`${descriptor.id}: has a reference result and at least two wrong results`, () => {
    assert.ok(references, 'no reference');
    assert.equal(references.reference.length, phasesFor[descriptor.mechanic]);
    assert.ok(Object.keys(references.wrong).length >= 2, 'fewer than two wrong results');
    for (const phases of Object.values(references.wrong)) assert.equal(phases.length, phasesFor[descriptor.mechanic]);
  });
  if (!references) continue;

  check(`${descriptor.id}: the untouched workspace is rejected and the prompt gives no answer away`, () => {
    const { task, workspace } = fresh(descriptor.id);
    assert.equal(task.score().ok, false);
    const text = [task.prompt, task.secondPrompt, task.steering?.text, task.stop?.resumePrompt].filter(Boolean).join('\n');
    assert.ok(!prompts.has(task.prompt), 'prompt is not unique');
    prompts.add(task.prompt);
    assert.match(task.expected, /^TASK_[A-Z0-9_]+_DONE$/);
    const closing = task.secondPrompt || task.stop?.resumePrompt || task.prompt;
    assert.ok(closing.includes(task.expected), 'the last instruction must ask for the completion marker');
    for (const answer of task.answerMustContain || []) assert.ok(!text.includes(answer), `prompt contains ${answer}`);
    for (const when of [task.steering?.when, task.stop?.when].filter(Boolean)) assert.equal(whenHolds(workspace, when), false);
    assert.equal(Boolean(task.heldOut), descriptor.set === 'held-out');
  });

  check(`${descriptor.id}: the reference result is accepted and stays inside the allowed changes`, () => {
    const { task, workspace } = fresh(descriptor.id);
    const before = workspaceSnapshot(workspace);
    const phases = references.reference;
    for (let index = 0; index < phases.length; index++) {
      const result = runPhase(task, phases[index]);
      if (descriptor.kind !== 'failing-tool') assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
      if (index === 0 && phases.length === 2) {
        // The point the runner waits for is reached by the first phase alone,
        // and the task is not complete there.
        const when = task.steering?.when || task.stop?.when;
        if (when) assert.equal(whenHolds(workspace, when), true, 'the first phase must reach the runner\'s trigger');
        assert.equal(task.score().ok, false, 'the first phase alone must not be accepted');
      }
    }
    const verdict = task.score();
    assert.equal(verdict.ok, true, verdict.output);
    const unexpected = changedFiles(before, workspaceSnapshot(workspace)).filter((file) => !changeAllowed(file, task.allowedChanges));
    assert.deepEqual(unexpected, []);
  });

  for (const [name, phases] of Object.entries(references.wrong)) {
    check(`${descriptor.id}: rejected when ${name}`, () => {
      const { task } = fresh(descriptor.id);
      // A wrong result that did not run would leave the workspace untouched
      // and be rejected for that reason alone.
      for (const phase of phases) {
        const result = runPhase(task, phase);
        assert.equal(result.status, 0, `the wrong result did not run: ${result.stdout}${result.stderr}`);
      }
      const verdict = task.score();
      assert.equal(verdict.ok, false, 'a wrong result was accepted');
      assert.ok(typeof verdict.output === 'string' && verdict.output.length > 0, 'a rejection names the failed check');
    });
  }
}

check('every agent of a lane gets the same bytes and instructions for a case; another variant differs', () => {
  for (const id of ['read-fact-01', 'guarded-fix-01', 'steering-01', 'dirty-workspace-01']) {
    assert.equal(caseDigest(id), caseDigest(id));
    assert.notEqual(caseDigest(id), caseDigest(id, 'pi'));
  }
});

// ---------------------------------------------------------------- frozen contents
check('case contents are the frozen ones: the fifty, the twenty held-out and the twelve recovery cases', () => {
  const recorded = JSON.parse(fs.readFileSync(new URL('../../extension/task-graph/bench/frozen-cases.json', import.meta.url), 'utf8'));
  const current = frozenCases();
  assert.equal(recorded.schema, 'dstudio.agent-lane.frozen-cases.v1');
  assert.deepEqual(Object.keys(recorded.sets), ['development', 'held-out', 'recovery']);
  for (const set of Object.keys(recorded.sets)) {
    assert.equal(recorded.sets[set].fixture, CASE_SET_FIXTURES[set]);
    assert.deepEqual(current.sets[set].cases, recorded.sets[set].cases,
      `${set} cases changed; a changed held-out case is no longer the case that was frozen`);
  }
  assert.deepEqual(current.publishedVariants, recorded.publishedVariants, 'the fifty published fixtures changed');
});

fs.rmSync(scratch, { recursive: true, force: true });
if (failures) {
  console.log(`agent_lane_cases_test: ${failures} of ${checks} checks FAILED`);
  process.exit(1);
}
console.log(`agent_lane_cases_test: ${checks} checks passed (${graded.length} held-out and recovery oracles: reference accepted, untouched and ${graded.reduce((total, item) => total + Object.keys(CASE_REFERENCES[item.id].wrong).length, 0)} wrong results rejected); no agent or model ran`);

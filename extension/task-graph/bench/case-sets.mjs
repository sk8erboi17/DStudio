// Which benchmark cases a run contains.
//
//   development  the fifty published fixtures (the default, and the only set a
//                prompt, agent or harness may be tuned on)
//   held-out     twenty cases that are run, not tuned on
//   all          development + held-out: the seventy cases of a complete lane
//   recovery     twelve long/recovery cases, counted beside the seventy
//
// Nothing selects held-out or recovery cases unless the set is named.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createReliabilityFixture, createVariantTask, RELIABILITY_FIXTURE_ID, RELIABILITY_SUITE_SIZE, RELIABILITY_TASK_TYPES,
  RELIABILITY_VARIANTS, workspaceSnapshot,
} from './reliability-fixture.mjs';
import { createHeldOutTask, HELD_OUT_CASES, HELD_OUT_FIXTURE_ID, HELD_OUT_TASK_TYPES } from './held-out-fixture.mjs';
import { createRecoveryTask, RECOVERY_CASES, RECOVERY_FIXTURE_ID, RECOVERY_TASK_TYPES } from './recovery-fixture.mjs';

export const DEFAULT_CASE_SET = 'development';
export const CASE_SETS = Object.freeze({
  development: ['development'],
  'held-out': ['held-out'],
  all: ['development', 'held-out'],
  recovery: ['recovery'],
});
export const CASE_SET_FIXTURES = Object.freeze({
  development: RELIABILITY_FIXTURE_ID, 'held-out': HELD_OUT_FIXTURE_ID, recovery: RECOVERY_FIXTURE_ID,
});

// The value of DSTUDIO_RELIABILITY_SET or --set. Empty means development.
export function selectCaseSet(value) {
  const name = String(value || '').trim().toLowerCase() || DEFAULT_CASE_SET;
  if (!Object.hasOwn(CASE_SETS, name))
    throw new Error(`unknown case set "${value}": use ${Object.keys(CASE_SETS).join(', ')}`);
  return name;
}

const DEVELOPMENT = Array.from({ length: RELIABILITY_SUITE_SIZE }, (_unused, index) => {
  const template = RELIABILITY_TASK_TYPES[index % RELIABILITY_TASK_TYPES.length];
  const variation = Math.floor(index / RELIABILITY_TASK_TYPES.length);
  return {
    id: `${template.id}-${String(variation + 1).padStart(2, '0')}`, set: 'development', heldOut: false,
    kind: template.id, kindLabel: template.label, mechanic: 'single', template, variation,
  };
});
const describe = (set, cases, types) => cases.map((item) => ({
  id: item.id, set, heldOut: set === 'held-out', kind: item.kind,
  kindLabel: types.find((type) => type.id === item.kind).label, mechanic: item.mechanic || 'single',
}));
const BY_SET = Object.freeze({
  development: DEVELOPMENT,
  'held-out': describe('held-out', HELD_OUT_CASES, HELD_OUT_TASK_TYPES),
  recovery: describe('recovery', RECOVERY_CASES, RECOVERY_TASK_TYPES),
});

// Case descriptors of a selection, in a fixed order. No file is written.
export function listCases(selection = DEFAULT_CASE_SET) {
  return CASE_SETS[selectCaseSet(selection)].flatMap((set) => BY_SET[set])
    .map(({ template: _template, variation: _variation, ...descriptor }) => descriptor);
}

export function findCase(caseId) {
  for (const cases of Object.values(BY_SET)) {
    const found = cases.find((item) => item.id === caseId);
    if (found) return found;
  }
  throw new Error(`unknown benchmark case: ${caseId}`);
}

// Materialize one case in `workspace` (which the case then owns) and return
// its task: { prompt, expected, answerMustContain, allowedChanges, score,
// reset, mechanic, ... }. Every agent of a lane gets the same `variant`.
export function createCase({ workspace, caseId, variant = 'lane' }) {
  const config = RELIABILITY_VARIANTS[variant];
  if (!config) throw new Error(`unknown reliability variant: ${variant}`);
  const descriptor = findCase(caseId);
  fs.mkdirSync(workspace, { recursive: true });
  let task;
  if (descriptor.set === 'development')
    task = { mechanic: 'single', ...createVariantTask(workspace, descriptor.template, descriptor.variation, variant, caseId) };
  else if (descriptor.set === 'held-out')
    task = { mechanic: 'single', ...createHeldOutTask(workspace, caseId, config) };
  else task = createRecoveryTask(workspace, caseId, config);
  task.reset();
  return { id: caseId, set: descriptor.set, heldOut: descriptor.heldOut, kind: descriptor.kind, mechanic: task.mechanic, task };
}

// What an agent is given for a case: the files of the fresh workspace and
// every instruction. Two workspaces with the same digest are identical inputs.
export function workspaceDigest(workspace, task) {
  const hash = crypto.createHash('sha256');
  hash.update(JSON.stringify({
    files: Object.entries(workspaceSnapshot(workspace)).sort(),
    prompt: task.prompt,
    secondPrompt: task.secondPrompt || null,
    steering: task.steering || null,
    stop: task.stop || null,
    expected: task.expected,
    answerMustContain: task.answerMustContain || [],
    allowedChanges: task.allowedChanges,
  }));
  return hash.digest('hex');
}

export function caseDigest(caseId, variant = 'lane') {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'dstudio-case-digest-'));
  try {
    return workspaceDigest(workspace, createCase({ workspace, caseId, variant }).task);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

// The published runners give each of their variants a directory of its own in
// one shared workspace; this is the digest of the fifty cases as one of those
// variants receives them.
function publishedVariantDigest(variant) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'dstudio-case-digest-'));
  try {
    const fixture = createReliabilityFixture({ workspace, caseCount: RELIABILITY_SUITE_SIZE, variants: [variant] });
    return crypto.createHash('sha256').update(JSON.stringify({
      files: Object.entries(workspaceSnapshot(workspace)).sort(),
      tasks: fixture.scenarios.map((scenario) => {
        const task = scenario.variants[variant];
        return [scenario.id, task.prompt, task.expected, task.answerMustContain, task.allowedChanges];
      }),
    })).digest('hex');
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

// Digests of every case as it is now. frozen-cases.json holds the reviewed
// copy; tests/unit/agent_lane_cases_test.mjs compares the two. Print a new
// copy with `node extension/task-graph/bench/case-sets.mjs --print-frozen`.
// Re-freezing a held-out case after agents were tuned turns its later results
// into development replays: say so wherever they are reported.
export function frozenCases() {
  return {
    schema: 'dstudio.agent-lane.frozen-cases.v1',
    variant: 'lane',
    sets: Object.fromEntries(Object.keys(BY_SET).map((set) => [set, {
      fixture: CASE_SET_FIXTURES[set],
      cases: Object.fromEntries(BY_SET[set].map((item) => [item.id, caseDigest(item.id)])),
    }])),
    publishedVariants: Object.fromEntries(['native-agent', 'task-graph', 'pi', 'opencode', 'codex']
      .map((variant) => [variant, publishedVariantDigest(variant)])),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname) &&
    process.argv.includes('--print-frozen'))
  process.stdout.write(`${JSON.stringify(frozenCases(), null, 2)}\n`);

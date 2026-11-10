// The usage-case matrix (PLAN.MD P12): every way the app is used, each with
// its normal, boundary, failure and recovery cases and the behavioral test
// that executes it. This module validates the matrix against the Makefile and
// the test files and reports what is still uncovered. It runs no test.
//
//   node tests/support/usage_matrix.mjs [--json]
//
// Evidence kinds: "real-model" (real weights and inference), "model-free"
// (production code with no model involved) and "simulated" (production UI or
// runtime with authored model replies). A simulated test never stands in for
// a real-model case: the report counts them separately.
import fs from 'node:fs';
import path from 'node:path';
import { census } from './test_census.mjs';

export const AREAS = ['chat', 'agent', 'cowork', 'design', 'learn', 'search-research', 'pdf-images-vision', 'models',
  'settings', 'conversations', 'stop-steering-resume', 'harnesses', 'task-graph', 'blueprint', 'lan-remote-cloud', 'install-upgrade-recovery'];
export const ASPECTS = ['normal', 'boundary', 'failure', 'recovery'];
export const EVIDENCE = ['real-model', 'model-free', 'simulated'];

export function validateUsageMatrix(matrix, root) {
  const errors = [];
  const fail = (message) => errors.push(message);
  if (matrix.schema !== 'dstudio.usage-matrix.v1') fail('unknown schema');
  const files = new Map(census(root).files.map((row) => [row.file, row]));
  const areaIds = (matrix.areas || []).map((area) => area.id);
  for (const id of AREAS) if (!areaIds.includes(id)) fail(`missing area ${id}`);
  for (const id of areaIds) if (!AREAS.includes(id)) fail(`unknown area ${id}`);
  if (new Set(areaIds).size !== areaIds.length) fail('duplicate area');
  const caseIds = new Set();
  const rows = [];
  for (const area of matrix.areas || []) {
    if (typeof area.label !== 'string' || !area.label.trim()) fail(`${area.id}: label`);
    for (const aspect of ASPECTS)
      if (!(area.cases || []).some((item) => item.aspect === aspect)) fail(`${area.id}: no ${aspect} case`);
    for (const item of area.cases || []) {
      const where = `${area.id}/${item.id}`;
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(item.id || '')) fail(`${where}: id is lower-case words`);
      if (caseIds.has(where)) fail(`${where}: duplicate case`);
      caseIds.add(where);
      if (typeof item.use !== 'string' || item.use.trim().length < 12) fail(`${where}: describe the usage in a sentence`);
      if (!ASPECTS.includes(item.aspect)) fail(`${where}: aspect must be one of ${ASPECTS.join(', ')}`);
      if (!Array.isArray(item.tests)) { fail(`${where}: tests must be a list (empty when nothing covers the case yet)`); continue; }
      for (const test of item.tests) {
        if (!EVIDENCE.includes(test.evidence)) fail(`${where}: evidence must be one of ${EVIDENCE.join(', ')}`);
        const row = files.get(test.file);
        if (!row) { fail(`${where}: ${test.file} is not a test file`); continue; }
        // A hand-run runner counts when a guide gives its command (the census lists where).
        if (!row.reached && !(row.documentedIn || []).length) fail(`${where}: ${test.file} is reached by no target or documented command`);
        if (test.target && !row.targets.includes(test.target)) fail(`${where}: target ${test.target} does not run ${test.file}`);
        if (test.evidence === 'real-model' && row.kind !== 'live') fail(`${where}: real-model evidence must come from tests/live, not ${test.file}`);
        if (typeof test.covers !== 'string' || test.covers.trim().length < 8) fail(`${where}: say what ${test.file} executes for this case`);
      }
      rows.push({ area: area.id, id: item.id, aspect: item.aspect, tests: item.tests.length,
        real: item.tests.filter((test) => test.evidence === 'real-model').length,
        modelFree: item.tests.filter((test) => test.evidence === 'model-free').length,
        simulated: item.tests.filter((test) => test.evidence === 'simulated').length });
    }
  }
  return { errors, rows };
}

// Coverage report. `uncovered` are usage cases no test executes; `simulatedOnly`
// are cases whose only evidence uses authored model replies.
export function usageCoverage(rows) {
  const uncovered = rows.filter((row) => row.tests === 0).map((row) => `${row.area}/${row.id}`);
  const simulatedOnly = rows.filter((row) => row.tests > 0 && row.real === 0 && row.modelFree === 0).map((row) => `${row.area}/${row.id}`);
  const byArea = {};
  for (const row of rows) {
    const area = byArea[row.area] ||= { cases: 0, covered: 0, withRealModel: 0 };
    area.cases++; if (row.tests) area.covered++; if (row.real) area.withRealModel++;
  }
  return { cases: rows.length, covered: rows.length - uncovered.length, uncovered, simulatedOnly, byArea };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const root = process.cwd();
  const matrix = JSON.parse(fs.readFileSync(path.join(root, 'tests/fixtures/usage_matrix.json'), 'utf8'));
  const { errors, rows } = validateUsageMatrix(matrix, root);
  const coverage = usageCoverage(rows);
  if (process.argv.includes('--json')) console.log(JSON.stringify({ errors, coverage }, null, 1));
  else {
    for (const [area, c] of Object.entries(coverage.byArea)) console.log(`${area.padEnd(26)} ${String(c.covered).padStart(3)}/${String(c.cases).padEnd(3)} covered, ${c.withRealModel} with real-model evidence`);
    console.log(`${coverage.covered}/${coverage.cases} usage cases have a test; ${coverage.uncovered.length} uncovered; ${coverage.simulatedOnly.length} with simulated evidence only`);
    for (const id of coverage.uncovered) console.log(`UNCOVERED ${id}`);
    for (const error of errors) console.log(`INVALID ${error}`);
  }
  process.exitCode = errors.length ? 1 : 0;
}

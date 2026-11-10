// Executes the usage-matrix validator on controlled matrices, then on the shipped one.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { AREAS, ASPECTS, usageCoverage, validateUsageMatrix } from '../support/usage_matrix.mjs';

const root = process.cwd();
const unitTest = { file: 'tests/unit/usage_matrix_test.mjs', target: 'test-usage-matrix', evidence: 'model-free', covers: 'the validator itself' };
const build = (mutate = () => {}) => {
  const matrix = { schema: 'dstudio.usage-matrix.v1', areas: AREAS.map((id) => ({ id, label: id,
    cases: ASPECTS.map((aspect) => ({ id: `${aspect}-case`, use: `A ${aspect} use of ${id} for the test`, aspect, tests: [structuredClone(unitTest)] })) })) };
  mutate(matrix); return matrix;
};
const errorsOf = (mutate) => validateUsageMatrix(build(mutate), root).errors;

assert.deepEqual(errorsOf(), [], 'a complete matrix that names real tests is valid');
assert.match(errorsOf((m) => m.areas.pop()).join('\n'), /missing area/);
assert.match(errorsOf((m) => m.areas.push({ id: 'spreadsheets', label: 'x', cases: [] })).join('\n'), /unknown area/);
assert.match(errorsOf((m) => { m.areas[0].cases = m.areas[0].cases.filter((c) => c.aspect !== 'recovery'); }).join('\n'), /chat: no recovery case/);
assert.match(errorsOf((m) => { m.areas[1].cases[0].tests[0].file = 'tests/unit/absent_test.mjs'; }).join('\n'), /is not a test file/);
assert.match(errorsOf((m) => { m.areas[1].cases[0].tests[0].target = 'test-quality-campaign'; }).join('\n'), /does not run/);
assert.match(errorsOf((m) => { m.areas[1].cases[0].tests[0].evidence = 'real-model'; }).join('\n'), /real-model evidence must come from tests\/live/);
assert.match(errorsOf((m) => { m.areas[1].cases[0].tests[0].evidence = 'manual'; }).join('\n'), /evidence must be one of/);
assert.match(errorsOf((m) => { m.areas[1].cases[0].tests[0].covers = ''; }).join('\n'), /say what/);
assert.match(errorsOf((m) => { m.areas[2].cases[1].id = m.areas[2].cases[0].id; }).join('\n'), /duplicate case/);
assert.match(errorsOf((m) => { m.areas[2].cases[0].use = 'short'; }).join('\n'), /describe the usage/);
assert.match(errorsOf((m) => { delete m.areas[2].cases[0].tests; }).join('\n'), /tests must be a list/);

// An uncovered case is valid to record and is reported; simulated-only evidence is reported separately.
const gaps = build((m) => { m.areas[0].cases[0].tests = []; m.areas[0].cases[1].tests[0].evidence = 'simulated'; });
const checked = validateUsageMatrix(gaps, root);
assert.deepEqual(checked.errors, []);
const coverage = usageCoverage(checked.rows);
assert.equal(coverage.cases, AREAS.length * ASPECTS.length);
assert.deepEqual(coverage.uncovered, ['chat/normal-case']);
assert.deepEqual(coverage.simulatedOnly, ['chat/boundary-case']);
assert.deepEqual(coverage.byArea.chat, { cases: 4, covered: 3, withRealModel: 0 });

if (fs.existsSync('tests/fixtures/usage_matrix.json')) {
  const shipped = validateUsageMatrix(JSON.parse(fs.readFileSync('tests/fixtures/usage_matrix.json', 'utf8')), root);
  assert.deepEqual(shipped.errors, [], 'the shipped usage matrix names only real tests and targets');
  const c = usageCoverage(shipped.rows);
  console.log(`PASS: usage matrix validator (controlled matrices); shipped matrix: ${c.covered}/${c.cases} usage cases covered, ${c.uncovered.length} uncovered, ${c.simulatedOnly.length} simulated only`);
} else console.log('PASS: usage matrix validator (controlled matrices); no shipped matrix yet');

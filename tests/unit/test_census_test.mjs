// Executes the suite census on a synthetic repository, then on this one.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { census, parseMakefile } from '../support/test_census.mjs';

const rules = parseMakefile([
  'TEST_BUILD := tests/.build', 'TEST_SERVER := $(TEST_BUILD)/server', '# comment: not-a-target', '.PHONY: a b',
  'a: $(TEST_SERVER) b', '\t@node tests/unit/one_test.mjs $(TEST_SERVER)', 'b:', '\t@python3 tests/unit/two_test.py \\', '\t  --flag',
  '$(TEST_BUILD)/native_unit: tests/unit/native_unit.c src/x.c', '\t$(CC) tests/unit/native_unit.c -o $@',
  'native: $(TEST_BUILD)/native_unit', '\t@$(TEST_BUILD)/native_unit', 'check-fast: a', 'check-fast: native', 'check-real: live',
  'live:', '\t@node tests/live/real_test.mjs', 'VALUE = x:y'].join('\n'));
assert.deepEqual(rules.get('a').prerequisites, ['tests/.build/server', 'b']);
assert.deepEqual(rules.get('a').recipe, ['@node tests/unit/one_test.mjs tests/.build/server']);
assert.deepEqual(rules.get('check-fast').prerequisites, ['a', 'native'], 'repeated rules accumulate');
assert.ok(!rules.has('.PHONY') && !rules.has('VALUE') && !rules.has('#'));
assert.equal(rules.get('b').recipe.length, 1, 'a continued recipe line is one command');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'census-'));
try {
  for (const dir of ['tests/unit', 'tests/integration', 'tests/live', 'tests/browser', 'tests/unit/__pycache__'])
    fs.mkdirSync(path.join(root, dir), { recursive: true });
  const write = (file, text = '') => fs.writeFileSync(path.join(root, file), text);
  write('Makefile', ['TEST_BUILD := tests/.build', 'a: b', '\t@node tests/unit/one_test.mjs', 'b:', '\t@python3 tests/unit/two_test.py',
    '$(TEST_BUILD)/native_unit: tests/unit/native_unit.c', '\tcc tests/unit/native_unit.c -o $@', 'native: $(TEST_BUILD)/native_unit', '\t@$(TEST_BUILD)/native_unit',
    'check-fast: a native', 'check-real: live', 'live:', '\t@node tests/live/real_test.mjs', 'manual:', '\t@node tests/integration/manual_test.mjs',
    'suite:', '\t@sh tests/integration/suite.sh'].join('\n'));
  write('tests/unit/one_test.mjs', "import './helper_case.mjs';\n");
  write('tests/unit/helper_case.mjs'); write('tests/unit/two_test.py'); write('tests/unit/native_unit.c');
  write('tests/unit/__pycache__/ignored.py'); write('tests/unit/notes.txt');
  write('tests/live/real_test.mjs'); write('tests/integration/manual_test.mjs');
  write('tests/integration/suite.sh', 'node tests/integration/from_suite_test.mjs\n'); write('tests/integration/from_suite_test.mjs');
  write('tests/integration/orphan_test.mjs'); write('tests/browser/orphan_page_test.mjs', "import './orphan_part.mjs';\n"); write('tests/browser/orphan_part.mjs');
  write('tests/live/manual_runner.mjs'); fs.mkdirSync(path.join(root, 'tests/docs'));
  write('tests/docs/guide.md', 'Run `node tests/live/manual_runner.mjs MODEL` explicitly.\n');
  const result = census(root);
  const row = (file) => result.files.find((r) => r.file === file);
  assert.equal(result.summary.total, 12, 'cache folders and non-test files are not counted');
  assert.deepEqual(result.summary.documentedManual, ['tests/live/manual_runner.mjs'], 'a hand-run runner with a documented command is accounted for');
  assert.deepEqual(row('tests/live/manual_runner.mjs').documentedIn, ['tests/docs/guide.md']);
  assert.deepEqual(row('tests/unit/one_test.mjs').gates, ['check-fast']);
  assert.deepEqual(row('tests/unit/two_test.py').gates, ['check-fast'], 'reached through a prerequisite target');
  assert.deepEqual(row('tests/unit/native_unit.c').gates, ['check-fast'], 'a compiled test is reached through its binary');
  assert.deepEqual(row('tests/unit/native_unit.c').targets, ['native'], 'the named target that runs a compiled test is listed, not its build product');
  assert.deepEqual(row('tests/unit/native_unit.c').buildProducts, ['tests/.build/native_unit']);
  assert.deepEqual(row('tests/live/real_test.mjs').gates, ['check-real']);
  assert.deepEqual([row('tests/integration/manual_test.mjs').reached, row('tests/integration/manual_test.mjs').gates], [true, []]);
  assert.deepEqual(row('tests/unit/helper_case.mjs').gates, ['check-fast'], 'an imported case file inherits its importer');
  assert.equal(row('tests/integration/from_suite_test.mjs').reached, true, 'a test started by a suite script is reached');
  assert.deepEqual(result.summary.unreached, ['tests/browser/orphan_page_test.mjs', 'tests/browser/orphan_part.mjs', 'tests/integration/orphan_test.mjs'],
    'a file reached only from an unreached test stays unreached');
  assert.equal(result.summary.explicitOnly, 3);
} finally { fs.rmSync(root, { recursive: true, force: true }); }

const real = census(process.cwd());
assert.ok(real.summary.total > 200 && real.summary.inCheckFast > 100);
assert.equal(real.summary.total, Object.values(real.summary.byKind).reduce((a, b) => a + b, 0));
console.log(`PASS: suite census resolves targets, compiled tests, gates, imports and unreached files (synthetic tree); this repository: ${real.summary.total} files, ${real.summary.unreached.length} reached by no target`);

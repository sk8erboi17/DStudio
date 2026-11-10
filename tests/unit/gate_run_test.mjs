// Executes the gate runner's target ordering and case-line counting, then one
// real two-target gate in a task-owned directory with a synthetic Makefile.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { countCases, gateTargets } from '../support/gate_run.mjs';
import { parseMakefile } from '../support/test_census.mjs';

const makefile = ['BUILD := out', '$(BUILD)/tool: src.c', '\tcc src.c -o $@', 'a: $(BUILD)/tool', '\t@echo "PASS: a one"', 'b: a', '\t@echo "ok b"',
  'empty: b', 'gate: empty c', 'c:', '\t@echo "FAIL: c broke"; exit 3', 'gate: a'].join('\n');
assert.deepEqual(gateTargets(parseMakefile(makefile), 'gate'), ['a', 'b', 'c'],
  'prerequisites first, each once; build products and recipe-less targets are not gate targets');
assert.deepEqual(gateTargets(parseMakefile(makefile), 'missing'), []);

const counted = countCases(['PASS: first', 'pass: chromium / light', 'dark: PASS', 'test_x (m.T.test_x) ... ok', 'ok 3 - tap style',
  'something_test: PASS', 'FAIL: second', 'x: FAIL: reason', 'test_y (m.T.test_y) ... FAIL', 'not ok 4', 'node missing: NOT RUN Markdown math tests',
  'Without a LAN address: BLOCKED, not a pass', 'PASS failed capture stays failed; 17 unstarted projects remain NOT RUN', 'plain output line', ''].join('\n'));
assert.equal(counted.passed, 7, 'a passing case that mentions NOT RUN in its name is still a passed case');
assert.equal(counted.failed, 4);
assert.equal(counted.notRun.length, 2);

// One real run: a passing target, a failing one whose exit status is the verdict, and a filtered rerun.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-run-'));
try {
  fs.writeFileSync(path.join(dir, 'Makefile'), ['good:', '\t@echo "PASS: good case"', 'quiet-fail:', '\t@echo "PASS: looks fine"; exit 2',
    'skipped:', '\t@echo "tool missing: NOT RUN"', 'gate: good quiet-fail skipped', ''].join('\n'));
  const script = path.resolve('tests/support/gate_run.mjs');
  const first = spawnSync(process.execPath, [script, 'gate'], { cwd: dir, encoding: 'utf8' });
  assert.equal(first.status, 1, 'a failed target fails the gate run');
  const runs = fs.readdirSync(path.join(dir, 'tests/.artifacts/gate-runs'));
  assert.equal(runs.length, 1);
  const receipt = JSON.parse(fs.readFileSync(path.join(dir, 'tests/.artifacts/gate-runs', runs[0], 'results.json'), 'utf8'));
  assert.deepEqual(receipt.targets.map((row) => [row.target, row.status, row.exit]), [['good', 'PASS', 0], ['quiet-fail', 'FAIL', 2], ['skipped', 'PASS', 0]]);
  assert.equal(receipt.targets[1].caseLinesPassed, 1, 'printed PASS lines do not rescue a non-zero exit');
  assert.deepEqual(receipt.summary.failed, ['quiet-fail']);
  assert.deepEqual(receipt.summary.targetsReportingNotRun, ['skipped'], 'a target that reports NOT RUN is visible even when it exits zero');
  assert.match(fs.readFileSync(path.join(dir, 'tests/.artifacts/gate-runs', runs[0], 'quiet-fail.log'), 'utf8'), /looks fine/);
  const rerun = spawnSync(process.execPath, [script, 'gate', '--only', 'good'], { cwd: dir, encoding: 'utf8' });
  assert.equal(rerun.status, 0);
  assert.equal(fs.readdirSync(path.join(dir, 'tests/.artifacts/gate-runs')).length, 2, 'a rerun never replaces the earlier receipt');
  assert.equal(spawnSync(process.execPath, [script, 'gate', '--only', 'absent'], { cwd: dir, encoding: 'utf8' }).status, 2);
  assert.equal(spawnSync(process.execPath, [script, 'nothing'], { cwd: dir, encoding: 'utf8' }).status, 2);
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
console.log('PASS: gate runner orders targets, counts case lines, takes the exit status as verdict, reports not-run lines and keeps every run (synthetic Makefile)');

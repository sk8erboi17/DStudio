// Runs a Makefile gate one target at a time and keeps a receipt per target
// (PLAN.MD P0: case-level census, exit states, prerequisites and exclusions).
// It adds no test and judges no output beyond each target's own exit status:
// a target that exits non-zero failed, whatever its lines say.
//
//   node tests/support/gate_run.mjs check-fast [--only TARGET[,TARGET...]]
//
// Every invocation owns a new directory in ignored tests/.artifacts/gate-runs/
// with one log per target and results.json: exit status, duration, the
// number of case lines the target printed as passed or failed, and the lines
// in which it reported something as not run or blocked. A later run never
// replaces an earlier one, so an intermittent failure stays on record beside
// the rerun that passed.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { parseMakefile } from './test_census.mjs';

const root = process.cwd();

// Targets of the gate that have a recipe, in the order make would reach them.
export function gateTargets(rules, gate) {
  const order = [], seen = new Set();
  const visit = (target) => {
    if (seen.has(target) || !rules.has(target)) return;
    seen.add(target);
    for (const prerequisite of rules.get(target).prerequisites) visit(prerequisite);
    if (rules.get(target).recipe.length && target !== gate && !target.includes('/')) order.push(target);
  };
  visit(gate);
  return order;
}

// Case lines as the suites print them. Counting is descriptive: the verdict of
// a target is its exit status.
export function countCases(text) {
  let passed = 0, failed = 0;
  const notRun = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (/\b(?:NOT[ _]RUN|BLOCKED)\b/.test(line) && !/^(?:PASS|pass|ok)\b|\bPASS\b|\.\.\. ok$/.test(line)) { notRun.push(line.slice(0, 240)); continue; }
    if (/^(?:PASS|pass|ok)\b/.test(line) || /(?::|^\S+) PASS\b/.test(line) || /\.\.\. ok$/.test(line) || /\bPASS$/.test(line)) passed++;
    else if (/^(?:FAIL|fail|not ok)\b/.test(line) || /: FAIL\b/.test(line) || /\.\.\. (?:FAIL|ERROR)$/.test(line)) failed++;
  }
  return { passed, failed, notRun };
}

function runTarget(target, log) {
  return new Promise((resolve) => {
    const fd = fs.openSync(log, 'wx');
    const started = performance.now();
    const child = spawn('make', [target], { cwd: root, stdio: ['ignore', fd, fd] });
    child.once('error', (error) => { fs.closeSync(fd); resolve({ error: String(error.message), seconds: 0 }); });
    child.once('exit', (code, signal) => { fs.closeSync(fd); resolve({ code, signal, seconds: (performance.now() - started) / 1000 }); });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const [gate, ...rest] = process.argv.slice(2);
  if (!gate) { console.error('usage: gate_run.mjs GATE [--only TARGET[,TARGET...]]'); process.exit(2); }
  const onlyIndex = rest.indexOf('--only');
  const only = onlyIndex < 0 ? null : new Set(rest[onlyIndex + 1].split(',').filter(Boolean));
  const rules = parseMakefile(fs.readFileSync(path.join(root, 'Makefile'), 'utf8'));
  const all = gateTargets(rules, gate);
  if (!all.length) { console.error(`no target with a recipe below ${gate}`); process.exit(2); }
  for (const name of only || []) if (!all.includes(name)) { console.error(`${name} is not a target of ${gate}`); process.exit(2); }
  const parent = path.join(root, 'tests/.artifacts/gate-runs');
  fs.mkdirSync(parent, { recursive: true });
  const run = fs.mkdtempSync(path.join(parent, `${gate}-`));
  const receipt = { schema: 'dstudio.gate-run.v1', gate, started: new Date().toISOString(), targetsInGate: all.length,
    selected: only ? [...only] : null, scope: 'Each target run alone through make; verdict is the exit status. Model-free unless the gate says otherwise.', targets: [] };
  const save = () => fs.writeFileSync(path.join(run, 'results.json'), JSON.stringify(receipt, null, 2) + '\n');
  console.log(`Gate run: ${run}`); save();
  let interrupted = false;
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { interrupted = true; });
  for (const target of all) {
    if (only && !only.has(target)) continue;
    const row = { target };
    receipt.targets.push(row);
    if (interrupted) { row.status = 'NOT_RUN'; row.reason = 'gate run interrupted'; continue; }
    const outcome = await runTarget(target, path.join(run, `${target}.log`));
    const counted = countCases(fs.readFileSync(path.join(run, `${target}.log`), 'utf8'));
    Object.assign(row, { status: outcome.code === 0 ? 'PASS' : 'FAIL', exit: outcome.code, signal: outcome.signal || undefined, error: outcome.error,
      seconds: Number(outcome.seconds.toFixed(1)), caseLinesPassed: counted.passed, caseLinesFailed: counted.failed, notRunLines: counted.notRun });
    save();
    console.log(`${row.status} ${target} (${row.seconds}s, ${counted.passed} passed lines${counted.failed ? `, ${counted.failed} failed lines` : ''}${counted.notRun.length ? `, ${counted.notRun.length} not-run lines` : ''})`);
  }
  receipt.finished = new Date().toISOString(); receipt.interrupted = interrupted;
  const failed = receipt.targets.filter((row) => row.status === 'FAIL'), notRun = receipt.targets.filter((row) => row.status === 'NOT_RUN');
  receipt.summary = { ran: receipt.targets.length - notRun.length, passed: receipt.targets.filter((row) => row.status === 'PASS').length, failed: failed.map((row) => row.target),
    notRun: notRun.map((row) => row.target), caseLinesPassed: receipt.targets.reduce((sum, row) => sum + (row.caseLinesPassed || 0), 0),
    targetsReportingNotRun: receipt.targets.filter((row) => row.notRunLines?.length).map((row) => row.target) };
  save();
  console.log(`${gate}: ${receipt.summary.passed}/${receipt.targets.length} targets passed${failed.length ? `; FAILED: ${receipt.summary.failed.join(', ')}` : ''}${notRun.length ? `; not run: ${notRun.length}` : ''}\nReceipts: ${run}`);
  process.exitCode = failed.length || notRun.length || interrupted ? 1 : 0;
}

// Campaign coordinator (PLAN.MD P0). It checks coverage, identities, exit
// states and denominators of the declared selections, and can start the
// existing real-model runners one at a time for the cells that have no
// terminal result yet. It is not an inference implementation: every answer is
// produced and graded by the runner it starts.
//
//   node tests/live/quality_multihardware.mjs status [--json]
//   node tests/live/quality_multihardware.mjs run [--only ID[,ID...]] [--quality-use first-exposure|development-replay]
//
// `status` reads receipts only. `run` is REAL inference, explicit and
// sequential: each model is started alone by its runner, which performs its
// own resource preflight and refuses to overlap another heavyweight model. A
// failed or blocked cell is a result; the coordinator records it and goes on
// to the next selection. Receipts of a coordinator run stay in ignored
// tests/.artifacts/quality-multihardware/run-*/; each runner keeps its own.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { artifactRunDir, writeArtifact } from '../support/real_harness.mjs';
import { collectAttempts, coverage, loadCampaign } from '../support/quality_campaign.mjs';
import { repoIdentity } from '../support/campaign_identity.mjs';

const root = process.cwd();
const [command = 'status', ...rest] = process.argv.slice(2);
const option = (name, fallback) => { const i = rest.indexOf(name); return i < 0 ? fallback : rest[i + 1]; };
assert.ok(['status', 'run'].includes(command), 'usage: quality_multihardware.mjs status|run');
const campaign = loadCampaign(path.join(root, 'tests/fixtures/quality_campaign.json'));
const artifacts = path.join(root, 'tests/.artifacts');
const store = path.resolve(process.env.DSTUDIO_REAL_DS4_DIR || path.join(root, 'ds4'));
const weightsPresent = (selection) => fs.existsSync(path.join(store, selection.modelFile));

function measure() {
  const collected = collectAttempts(artifacts);
  return { ...coverage(campaign, collected.attempts, { weightsPresent }), unreadable: collected.unreadable };
}

function print(result) {
  for (const row of result.rows) {
    const counts = row.status === 'PASS' || row.status === 'FAIL' ? `${row.passed}/${row.denominator} passed, ${row.failed} failed, ${row.notRun} not run` : `0/${row.denominator} executed`;
    console.log(`${row.status.padEnd(8)} ${row.suite.padEnd(11)} ${row.label.padEnd(36)} ${counts}${row.reason ? ` — ${row.reason}` : ''}${row.counted ? ` [${row.counted}]` : ''}`);
    for (const excluded of row.excluded) console.log(`${' '.repeat(21)}not counted: ${excluded.source}: ${excluded.reason}`);
  }
  const t = result.totals;
  console.log(`Total: ${t.passed}/${t.denominator} passed, ${t.failed} failed, ${t.notRun} not run; cells PASS ${t.byStatus.PASS}, FAIL ${t.byStatus.FAIL}, NOT_RUN ${t.byStatus.NOT_RUN}, BLOCKED ${t.byStatus.BLOCKED}`);
  for (const bad of result.unreadable) console.log(`UNREADABLE receipt ${bad.source}: ${bad.error}`);
}

// The runner that owns each kind of selection. Resident ds4 checkpoints use
// the native engine path; llama.cpp, MLX and expert SSD streaming are prepared
// by the production host.
export function runnerFor(selection, qualityUse) {
  const file = path.basename(selection.modelFile);
  if (selection.engine === 'llama' || selection.engine === 'mlx' || selection.ssdStreaming === 'on')
    return ['tests/live/host_common_quality.mjs', '--model', selection.modelFile, '--ssd-streaming', selection.ssdStreaming, '--quality-use', qualityUse,
      '--restart-failed-engine'];
  const native = selection.engine === 'ds4-laguna' ? 'laguna' : /Flash-Next/.test(file) ? 'qwen' : 'main';
  // The installed engines sit beside the store; state both so that a frozen
  // source tree elsewhere runs against them and not against its own directory.
  // Both runners restart their engine after a case whose exchange did not
  // complete, so one frozen deadline does not leave the rest of the corpus not
  // run. The failed case is never retried.
  return ['tests/live/engine_acceptance.mjs', '--infer', '--engines', native, '--model-file', file, '--common-quality', '--quality-use', qualityUse,
    '--restart-failed-engine',
    '--installed-root', path.dirname(store), '--model-root', path.join(store, path.dirname(selection.modelFile))];
}

if (command === 'status') {
  const result = measure();
  if (rest.includes('--json')) console.log(JSON.stringify(result, null, 2)); else print(result);
} else {
  const qualityUse = option('--quality-use', 'development-replay');
  assert.ok(['first-exposure', 'development-replay'].includes(qualityUse));
  const only = option('--only', '').split(',').filter(Boolean);
  for (const id of only) assert.ok(campaign.selections.some((s) => s.id === id), `unknown selection ${id}`);
  const run = artifactRunDir('quality-multihardware');
  const before = measure();
  const order = only.length ? only.map((id) => campaign.selections.find((s) => s.id === id)) : campaign.selections;
  const cells = order.map((selection) => ({ selection, row: before.rows.find((row) => row.selection === selection.id && row.suite === 'common-100') }));
  const receipt = { schema: 'dstudio.quality-multihardware-run.v1', started: new Date().toISOString(), repository: repoIdentity(root), qualityUse,
    scope: 'Sequential start of existing real-model runners for campaign cells without a terminal result. Results and identities are in each runner receipt.',
    coverageBefore: before.totals, cells: [] };
  const save = () => writeArtifact(run, 'results.json', receipt);
  console.log(`Evidence: ${run}`); save();
  let child = null, interrupted = false;
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { interrupted = true; try { child?.kill(signal); } catch {} });
  for (const { selection, row } of cells) {
    const cell = { selection: selection.id, statusBefore: row.status };
    receipt.cells.push(cell);
    if (interrupted) { cell.action = 'not started: coordinator interrupted'; continue; }
    if (row.status !== 'NOT_RUN') { cell.action = `not started: ${row.status}${row.reason ? ` (${row.reason})` : ''}`; save(); continue; }
    cell.argv = runnerFor(selection, qualityUse);
    cell.log = `${selection.id}.log`;
    cell.started = new Date().toISOString(); save();
    console.log(`\n== ${selection.label}: node ${cell.argv.join(' ')}`);
    const fd = fs.openSync(path.join(run, cell.log), 'wx');
    const outcome = await new Promise((resolve) => {
      child = spawn(process.execPath, cell.argv, { cwd: root, stdio: ['ignore', fd, fd] });
      child.once('error', (error) => resolve({ error: String(error.message) }));
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    fs.closeSync(fd); child = null;
    Object.assign(cell, { finished: new Date().toISOString(), exit: outcome });
    const after = measure().rows.find((r) => r.selection === selection.id && r.suite === 'common-100');
    Object.assign(cell, { statusAfter: after.status, passed: after.passed, failed: after.failed, notRun: after.notRun, counted: after.counted || null, reason: after.reason || null });
    save();
    console.log(`${after.status}: ${after.passed}/${after.denominator} passed, ${after.failed} failed, ${after.notRun} not run${after.reason ? ` — ${after.reason}` : ''}`);
  }
  const final = measure();
  receipt.coverageAfter = final.totals; receipt.finished = new Date().toISOString(); receipt.interrupted = interrupted; save();
  console.log(''); print(final);
  process.exitCode = interrupted ? 130 : 0;
}

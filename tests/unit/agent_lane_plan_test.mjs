// `run-agent-lane.mjs --plan`: the attempt list of a six-agent lane (agents x
// cases x repetitions, per lane) is printed and written, and nothing is run.
//
// The runner is executed as a program on a stated machine: an engine
// directory with a one-byte stand-in GGUF and empty, non-executable stand-ins
// for the engine programs, an empty host binary stand-in, and pi, OpenCode and
// Codex shims on PATH that only record how they were called. --plan may read
// those files and ask each CLI for its version; anything else it started would
// show in the shims' log, and an executed attempt would leave its workspace.
// No model, engine or agent is involved.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { inspectUpstreamAgent } from '../../extension/task-graph/bench/build-upstream-agent.mjs';

const RUNNER = path.resolve('extension/task-graph/bench/run-agent-lane.mjs');
const frozen = JSON.parse(fs.readFileSync('extension/task-graph/bench/frozen-cases.json', 'utf8'));
const digests = Object.assign({}, ...Object.values(frozen.sets).map((set) => set.cases));
const AGENTS = ['upstream-agent', 'native-agent', 'task-graph', 'pi', 'opencode', 'codex'];
const root = path.resolve('tests/.artifacts/agent-lane-plan');
fs.mkdirSync(root, { recursive: true });
const scratch = fs.mkdtempSync(path.join(root, 'run-'));

// ---------------------------------------------------------------- the machine
const home = path.join(scratch, 'home');
const engine = path.join(scratch, 'engine');
const shims = path.join(scratch, 'shims');
const shimLog = path.join(scratch, 'shim-calls.log');
const host = path.join(scratch, 'host', 'dstudio-server-test');
for (const dir of [home, path.join(engine, 'gguf'), shims, path.dirname(host)]) fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(engine, 'ds4_server.c'), '');
fs.writeFileSync(path.join(engine, 'ds4-server'), '');
fs.writeFileSync(path.join(engine, 'ds4-agent-jsonl'), '');
const gguf = path.join(engine, 'gguf', 'DeepSeek-V4-Flash-IQ2XXS-imatrix-standin.gguf');
fs.writeFileSync(gguf, 'x');
fs.writeFileSync(host, '');
for (const name of ['pi', 'opencode', 'codex']) {
  fs.writeFileSync(path.join(shims, name), `#!/bin/sh\necho "${name} $*" >> '${shimLog}'\necho "${name} 9.9.9-shim"\n`);
  fs.chmodSync(path.join(shims, name), 0o755);
}
const nodeOnly = path.join(scratch, 'node-only');
fs.mkdirSync(nodeOnly);
fs.symlinkSync(process.execPath, path.join(nodeOnly, 'node'));

const machine = { HOME: home, DSTUDIO_REAL_DS4_DIR: engine, PATH: `${shims}${path.delimiter}${process.env.PATH}` };
const bare = { HOME: home, DSTUDIO_REAL_DS4_DIR: path.join(scratch, 'no-engine'), PATH: `${nodeOnly}${path.delimiter}/usr/bin${path.delimiter}/bin` };
function plan(args, env = machine) {
  const base = { ...process.env };
  for (const key of ['DS4_DIR', 'DSTUDIO_REAL_DS4_DIR', 'DSTUDIO_RELIABILITY_SET', 'DSTUDIO_TASK_GRAPH_GGUF', 'RUN_HEAVY']) delete base[key];
  const result = spawnSync(process.execPath, [RUNNER, '--plan', ...args], { cwd: process.cwd(), env: { ...base, ...env }, encoding: 'utf8', timeout: 300_000 });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}
let serial = 0;
const out = () => path.join(scratch, `plan-${++serial}`);
const read = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'plan.json'), 'utf8'));
const realArtifacts = path.resolve('tests/.artifacts/agent-lane-real');
const listing = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []);
const realBefore = listing(realArtifacts);

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

// ---------------------------------------------------------------- a complete lane
const full = out();
const fullRun = plan(['--set', 'all', '--output', full, host]);
const upstream = inspectUpstreamAgent();

check('--plan --set all prints 70 cases x 6 agents x 3 repetitions = 1,260 attempts and says nothing was run', () => {
  assert.equal(fullRun.status, 0, fullRun.stderr);
  assert.match(fullRun.stdout, /^lane equivalent \(Equivalent settings\) · set all · seed "p9-equivalent-all"$/m);
  assert.match(fullRun.stdout, /^70 cases x 6 agents x 3 repetitions = 1260 attempts \(expected 1260\)$/m);
  assert.match(fullRun.stdout, /^by set: development 900, held-out 360$/m);
  assert.match(fullRun.stdout, /plan: 1260 rows in .*plan\.json \(sha256 [0-9a-f]{16}\) and plan\.csv; nothing was run$/m);
  for (const agent of AGENTS) assert.match(fullRun.stdout, new RegExp(`^  ${agent} +(35 ){5}35 `, 'm'), `${agent} must take each of the six positions 35 times`);
});

check('the written plan is every (repetition, case, agent) once, with the frozen workspace digest of its case', () => {
  const written = read(full);
  assert.equal(written.schema, 'dstudio.agent-lane.plan.v1');
  assert.deepEqual([written.lane, written.set, written.repetitions, written.cases, written.expectedAttempts], ['equivalent', 'all', 3, 70, 1260]);
  assert.deepEqual(written.agents, AGENTS);
  assert.equal(written.rows.length, 1260);
  const keys = new Set(written.rows.map((row) => `${row.repetition}|${row.caseId}|${row.agent}`));
  assert.equal(keys.size, 1260);
  assert.deepEqual(written.rows.map((row) => row.index), Array.from({ length: 1260 }, (_unused, index) => index + 1));
  for (const row of written.rows) {
    assert.equal(row.workspaceDigest, digests[row.caseId], `${row.caseId} digest`);
    assert.equal(row.workspace, `attempts/${row.attemptId}/workspace`);
    assert.equal(row.heldOut, row.caseSet === 'held-out');
  }
  assert.equal(new Set(written.rows.filter((row) => row.caseSet === 'held-out').map((row) => row.caseId)).size, 20);
  // Each (repetition, case) cell is one Williams row: six agents, adjacent.
  for (let start = 0; start < 1260; start += 6) {
    const cell = written.rows.slice(start, start + 6);
    assert.equal(new Set(cell.map((row) => row.cell)).size, 1);
    assert.equal(new Set(cell.map((row) => row.caseId)).size, 1);
    assert.deepEqual(cell.map((row) => row.position), [1, 2, 3, 4, 5, 6]);
    assert.deepEqual(new Set(cell.map((row) => row.agent)), new Set(AGENTS));
  }
  // Every agent directly follows every other one equally often.
  const follows = new Map();
  for (let index = 1; index < 1260; index++) {
    const [before, after] = [written.rows[index - 1], written.rows[index]];
    if (before.cell === after.cell) follows.set(`${before.agent}>${after.agent}`, (follows.get(`${before.agent}>${after.agent}`) || 0) + 1);
  }
  assert.equal(follows.size, 30);
  assert.deepEqual(new Set(follows.values()), new Set([35]));
  const csv = fs.readFileSync(path.join(full, 'plan.csv'), 'utf8').trimEnd().split('\n');
  assert.equal(csv.length, 1261);
  assert.equal(csv[0], 'index,repetition,cell,position,caseId,caseSet,heldOut,mechanic,agent,runtime,status,reason,workspace,workspaceDigest');
  assert.equal(fs.readFileSync(path.join(full, 'plan-summary.txt'), 'utf8'), `${fullRun.stdout.split('\nplan: ')[0]}\n`);
});

check('availability is probed from the stated machine: what each agent needs, or why it is BLOCKED', () => {
  const written = read(full);
  for (const agent of ['pi', 'opencode', 'codex']) {
    assert.equal(written.availability[agent].available, true, written.availability[agent].reason);
    assert.ok(written.availability[agent].evidence.includes(`${agent} ${agent} 9.9.9-shim at ${path.join(shims, agent)}`));
    assert.ok(written.availability[agent].evidence.includes(`engine server ${path.join(engine, 'ds4-server')}`));
  }
  for (const agent of ['native-agent', 'task-graph']) {
    assert.equal(written.availability[agent].available, true, written.availability[agent].reason);
    assert.ok(written.availability[agent].evidence.includes(`patched Agent runtime ${path.join(engine, 'ds4-agent-jsonl')}`));
    assert.ok(written.availability[agent].evidence.includes(`DStudio host test binary ${host}`));
  }
  for (const agent of AGENTS)
    assert.ok(written.availability[agent].evidence.includes(`model gguf/${path.basename(gguf)} (1 bytes) in ${engine}`), agent);
  // The clean upstream build is whatever build-upstream-agent.mjs left in this checkout.
  assert.equal(written.availability['upstream-agent'].available, upstream.ok);
  const upstreamRows = written.rows.filter((row) => row.agent === 'upstream-agent');
  if (upstream.ok) assert.ok(upstreamRows.every((row) => row.status === 'PLANNED'));
  else assert.ok(upstreamRows.every((row) => row.status === 'BLOCKED' && row.reason === upstream.reason));
  for (const row of written.rows.filter((item) => item.agent !== 'upstream-agent')) assert.equal(row.status, 'PLANNED', row.attemptId);
});

check('nothing was run: no workspace, no attempt directory, the CLIs were only asked for their version, the stand-ins are untouched', () => {
  assert.deepEqual(fs.readdirSync(full).sort(), ['plan-summary.txt', 'plan.csv', 'plan.json']);
  const calls = fs.readFileSync(shimLog, 'utf8').trim().split('\n');
  assert.deepEqual(calls.sort(), ['codex --version', 'opencode --version', 'pi --version']);
  assert.equal(fs.readFileSync(gguf, 'utf8'), 'x');
  for (const file of ['ds4-server', 'ds4-agent-jsonl', 'ds4_server.c']) assert.equal(fs.statSync(path.join(engine, file)).size, 0);
  assert.deepEqual(listing(realArtifacts), realBefore, 'no real lane run directory may be created');
});

check('the same options give the same plan, byte for byte, and the printed digest is its sha256; another seed reorders the same rows', () => {
  const again = out();
  const second = plan(['--set', 'all', '--output', again, host]);
  assert.equal(second.status, 0, second.stderr);
  const bytes = fs.readFileSync(path.join(again, 'plan.json'));
  assert.ok(bytes.equals(fs.readFileSync(path.join(full, 'plan.json'))));
  const printed = /\(sha256 ([0-9a-f]{16})\)/.exec(second.stdout)[1];
  assert.equal(crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 16), printed);
  const other = out();
  assert.equal(plan(['--set', 'all', '--seed', 'another-seed', '--output', other, host]).status, 0);
  const [a, b] = [read(full).rows, read(other).rows];
  assert.notDeepEqual(a.map((row) => row.attemptId), b.map((row) => row.attemptId));
  assert.deepEqual(a.map((row) => row.attemptId).sort(), b.map((row) => row.attemptId).sort());
});

check('without --set the plan holds the fifty development cases and no held-out case; DSTUDIO_RELIABILITY_SET names another set', () => {
  const dir = out();
  const result = plan(['--repetitions', '1', '--output', dir, host]);
  assert.equal(result.status, 0, result.stderr);
  const written = read(dir);
  assert.deepEqual([written.set, written.cases, written.rows.length], ['development', 50, 300]);
  assert.ok(written.rows.every((row) => row.caseSet === 'development' && row.heldOut === false));
  const held = out();
  assert.equal(plan(['--repetitions', '1', '--output', held, host], { ...machine, DSTUDIO_RELIABILITY_SET: 'held-out' }).status, 0);
  assert.deepEqual([read(held).set, read(held).rows.length], ['held-out', 120]);
});

check('--set recovery: each mechanic an agent cannot run keeps its rows as BLOCKED or NOT_COMPARABLE with the reason', () => {
  const dir = out();
  const result = plan(['--set', 'recovery', '--repetitions', '1', '--output', dir, host]);
  assert.equal(result.status, 0, result.stderr);
  const written = read(dir);
  assert.equal(written.rows.length, 72);
  const status = (agent, mechanic) => [...new Set(written.rows.filter((row) => row.agent === agent && row.mechanic === mechanic).map((row) => row.status))];
  assert.deepEqual(status('codex', 'stop-resume'), ['PLANNED']);
  assert.deepEqual(status('codex', 'steering'), ['NOT_COMPARABLE']);
  assert.deepEqual(status('opencode', 'steering'), ['NOT_COMPARABLE']);
  assert.deepEqual(status('pi', 'steering'), ['BLOCKED']);
  assert.deepEqual(status('pi', 'stop-resume'), ['BLOCKED']);
  assert.deepEqual(status('opencode', 'stop-resume'), ['BLOCKED']);
  assert.deepEqual(status('upstream-agent', 'stop-resume'), ['NOT_COMPARABLE']);
  assert.deepEqual(status('upstream-agent', 'steering'), ['BLOCKED']);
  assert.deepEqual(status('native-agent', 'steering'), ['BLOCKED']);
  assert.deepEqual(status('task-graph', 'stop-resume'), ['NOT_COMPARABLE']);
  for (const agent of ['pi', 'opencode', 'codex', 'native-agent', 'task-graph']) assert.deepEqual(status(agent, 'two-sessions'), ['PLANNED']);
  assert.ok(written.rows.filter((row) => row.status !== 'PLANNED').every((row) => row.reason.startsWith(`${row.mechanic} is `)));
  assert.match(result.stdout, /^rows that will not run, and why:$/m);
  assert.match(result.stdout, /^  NOT_COMPARABLE codex: steering is not comparable for Codex: /m);
});

check('--lane product: every attempt is BLOCKED until the complete-product configuration is frozen', () => {
  const dir = out();
  const result = plan(['--lane', 'product', '--set', 'all', '--output', dir, host]);
  assert.equal(result.status, 0, result.stderr);
  const written = read(dir);
  assert.equal(written.rows.length, 1260);
  assert.ok(written.rows.every((row) => row.status === 'BLOCKED' && /complete-product configuration of .* is not frozen/.test(row.reason)));
  assert.match(result.stdout, /^by status: BLOCKED 1260$/m);
});

check('--agents and --repetitions narrow the plan; agents keep their canonical order', () => {
  const dir = out();
  assert.equal(plan(['--agents', 'codex,pi', '--set', 'held-out', '--repetitions', '2', '--output', dir, host]).status, 0);
  const written = read(dir);
  assert.deepEqual(written.agents, ['pi', 'codex']);
  assert.equal(written.rows.length, 20 * 2 * 2);
});

check('on a machine without engine, host or CLIs every agent is BLOCKED with what is missing', () => {
  const dir = out();
  const result = plan(['--set', 'held-out', '--repetitions', '1', '--output', dir, path.join(scratch, 'no-host')], bare);
  assert.equal(result.status, 0, result.stderr);
  const written = read(dir);
  for (const agent of ['pi', 'opencode', 'codex']) {
    assert.equal(written.availability[agent].available, false);
    assert.match(written.availability[agent].reason, new RegExp(`${agent} is not on PATH`));
  }
  for (const agent of ['native-agent', 'task-graph'])
    assert.match(written.availability[agent].reason, /DStudio host test binary is missing: .*no-host/);
  for (const agent of AGENTS.filter((item) => item !== 'upstream-agent'))
    assert.ok(written.rows.filter((row) => row.agent === agent).every((row) => row.status === 'BLOCKED' && row.reason === written.availability[agent].reason));
  assert.match(result.stdout, /BLOCKED: .*pi is not on PATH/);
});

check('invalid options stop with status 2 before anything is written', () => {
  for (const args of [['--lane', 'nope'], ['--set', 'secret'], ['--repetitions', '0'], ['--agents', 'gpt'], ['--bogus'], ['--seed']]) {
    const dir = out();
    const result = plan([...args, '--output', dir], machine);
    assert.equal(result.status, 2, `${args.join(' ')}: ${result.stdout}${result.stderr}`);
    assert.match(result.stderr, /^run-agent-lane: /);
    assert.ok(!fs.existsSync(dir), `${args.join(' ')} wrote a plan`);
  }
});

console.log(`agent_lane_plan: ${checks - failures}/${checks} checks passed · --plan executed as a program on a stated machine, nothing run`);
process.exit(failures ? 1 : 0);

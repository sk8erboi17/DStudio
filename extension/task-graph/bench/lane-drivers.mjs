// How one attempt of the six-agent lane is carried out and graded: the fresh
// workspace, the mechanics of the recovery cases (two sessions, Stop/resume,
// steering) for the agents whose interface has them, and the reading of the
// clean upstream agent's trace. Nothing here starts an engine; the callers are
// run-agent-lane.mjs (real model) and tests/integration/agent_lane_mechanics_test.mjs,
// which runs the three CLI drivers (one prompt, two sessions, Codex
// Stop/resume) with the installed CLIs against scripted model servers. The
// clean upstream agent's drivers, including steering, need real weights: no
// test has exercised them, which is why agent-lane.mjs marks steering BLOCKED.
//
// Outcome of an attempt:
//   completed      graded as a success
//   failed         the agent ran and the grade is not a success
//   inconclusive   the point a mechanic acts on was never reached (the turn
//                  ended before the stop or steering point), so the attempt
//                  says nothing about that mechanic
//   harness-error  the runner or the runtime failed; not a verdict on the agent
// All four stay in the denominator.
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { createCase, workspaceDigest } from './case-sets.mjs';
import { gitBaseline } from './fixture-support.mjs';
import { changeAllowed, changedFiles, workspaceSnapshot } from './reliability-fixture.mjs';
import {
  analyzeEvents, CODEX_PREFLIGHT_ARGS, CODEX_STOP_SIGNAL, codexExecArgs, codexPreflight, competitorCommand, parseEvents, rounded,
  runCli, runCompetitor, startCli, writeCompetitorConfigs,
} from './cli-competitor-harness.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The workspace of one planned attempt: a new directory holding the case as
// its fixture writes it, checked against the digest the plan recorded, inside
// a one-commit git repository (the same for every agent).
export function prepareAttempt(runDir, row) {
  const attemptDir = path.join(runDir, 'attempts', row.attemptId);
  const workspace = path.join(runDir, row.workspace);
  if (fs.existsSync(attemptDir)) throw new Error(`attempt directory already exists: ${attemptDir}`);
  fs.mkdirSync(attemptDir, { recursive: true });
  const created = createCase({ workspace, caseId: row.caseId });
  const digest = workspaceDigest(workspace, created.task);
  if (digest !== row.workspaceDigest)
    throw new Error(`workspace of ${row.attemptId} is not the one the plan recorded (${digest} instead of ${row.workspaceDigest})`);
  if (!created.task.ownsGit) gitBaseline(workspace);
  return { attemptDir, workspace, task: created.task };
}

export function conditionHolds(workspace, when) {
  try {
    const text = fs.readFileSync(path.join(workspace, when.path), 'utf8');
    return !when.contains || text.includes(when.contains);
  } catch {
    return false;
  }
}

// Resolves true when `when` holds in the workspace, false when `until`
// settles first. The point is a state of the task's own files, not a time.
async function reached(workspace, when, until, pollMs = 20) {
  let over = false;
  until.then(() => { over = true; }, () => { over = true; });
  for (;;) {
    if (conditionHolds(workspace, when)) return true;
    if (over) return conditionHolds(workspace, when);
    await sleep(pollMs);
  }
}

function grade(task, workspace, before) {
  const changed = changedFiles(before, workspaceSnapshot(workspace));
  return {
    externalCheck: task.score(),
    changedFiles: changed,
    unexpectedChanges: changed.filter((file) => !changeAllowed(file, task.allowedChanges)),
  };
}

function verdict(graded, answered, ran) {
  const taskSuccess = Boolean(ran && graded.externalCheck.ok && answered && graded.unexpectedChanges.length === 0);
  return {
    taskSuccess,
    outcome: taskSuccess ? 'completed' : 'failed',
    expectedAnswerAfterTool: answered,
    incorrectCompletionClaim: Boolean(answered && (!graded.externalCheck.ok || graded.unexpectedChanges.length)),
    ...graded,
  };
}

const exitOf = (execution) => ({
  exitCode: execution.code, signal: execution.signal, timedOut: execution.timedOut,
  outputOverflow: execution.overflow, spawnError: execution.spawnError, stopped: Boolean(execution.stopped),
});

// ---------------------------------------------------------------- third-party CLIs
// One CLI process under the pin proxy. `during(handle)` may act on it while it runs.
async function cliPhase({ proxy, runId, command, workspace, timeoutMs, during }) {
  proxy.begin(runId);
  let execution;
  let acted;
  let observed;
  try {
    const handle = startCli(command.command, command.args, { cwd: workspace, env: command.env, timeoutMs, stopSignal: command.stopSignal });
    acted = during ? await during(handle) : undefined;
    execution = await handle.done;
  } finally {
    observed = proxy.end(runId);
  }
  return { execution, acted, requests: observed.filter((request) => !request.blocked), blocked: observed.filter((request) => request.blocked) };
}

function protocolOf(harness, phases) {
  const requests = phases.flatMap((phase) => phase.requests);
  const modelPath = harness === 'codex' ? '/v1/responses' : '/v1/chat/completions';
  return {
    modelRequests: requests.length,
    modelPinVerified: requests.length > 0 && requests.every((request) => request.path === modelPath && request.model === 'ds4'),
    requestsWithToolSchemas: requests.filter((request) => request.toolSchemas > 0).length,
    blockedOutbound: phases.flatMap((phase) => phase.blocked).map((request) => `${request.method} ${request.path}`),
  };
}

// `commandFor(prompt)` builds the CLI's non-interactive command for a prompt.
// Returns { result, evidence } where evidence maps a file name to its text.
export async function runCliAttempt({ proxy, harness, row, task, workspace, commandFor, timeoutMs }) {
  if (task.mechanic === 'single') {
    const { result, execution } = await runCompetitor({
      proxy, harness, workspace, timeoutMs, command: commandFor(task.prompt),
      scenario: { id: row.attemptId, templateId: row.kind, variants: { [harness]: task } },
    });
    return {
      result: { ...result, outcome: result.taskSuccess ? 'completed' : 'failed', mechanic: 'single' },
      evidence: { 'stdout.jsonl': execution.stdout, 'stderr.txt': execution.stderr },
    };
  }
  const before = workspaceSnapshot(workspace);
  const startedAt = performance.now();
  if (task.mechanic === 'two-sessions') {
    const first = await cliPhase({ proxy, runId: `${row.attemptId}-1`, command: commandFor(task.prompt), workspace, timeoutMs });
    const second = await cliPhase({ proxy, runId: `${row.attemptId}-2`, command: commandFor(task.secondPrompt), workspace, timeoutMs });
    const events = analyzeEvents(harness, second.execution.stdout, task);
    const graded = grade(task, workspace, before);
    return {
      result: {
        ...verdict(graded, events.answerAfterTool, first.execution.code === 0 && second.execution.code === 0),
        mechanic: 'two-sessions',
        toolStats: { calls: analyzeEvents(harness, first.execution.stdout, task).calls + events.calls, maximumRepeated: events.maximumRepeated },
        wallClockMs: rounded(performance.now() - startedAt),
        sessions: [exitOf(first.execution), exitOf(second.execution)],
        process: exitOf(second.execution),
        protocol: protocolOf(harness, [first, second]),
      },
      evidence: {
        'session-1-stdout.jsonl': first.execution.stdout, 'session-1-stderr.txt': first.execution.stderr,
        'session-2-stdout.jsonl': second.execution.stdout, 'session-2-stderr.txt': second.execution.stderr,
      },
    };
  }
  if (task.mechanic === 'stop-resume' && harness === 'codex') {
    // A stored session (no --ephemeral), stopped as the runner stops every
    // Codex run, then continued by its id with the resume instruction.
    const base = commandFor(task.prompt);
    const stored = { ...base, args: base.args.filter((arg) => arg !== '--ephemeral') };
    const first = await cliPhase({
      proxy, runId: `${row.attemptId}-1`, command: stored, workspace, timeoutMs,
      during: async (handle) => ((await reached(workspace, task.stop.when, handle.done)) ? handle.stop() : false),
    });
    const afterStop = workspaceSnapshot(workspace);
    const thread = parseEvents(first.execution.stdout).find((event) => event.type === 'thread.started')?.thread_id || null;
    const stop = { reachedStopPoint: conditionHolds(workspace, task.stop.when), stoppedWhileRunning: first.acted === true, session: thread, changedBeforeStop: changedFiles(before, afterStop) };
    if (!stop.stoppedWhileRunning || !thread) {
      const graded = grade(task, workspace, before);
      return {
        result: {
          ...verdict(graded, false, false), outcome: 'inconclusive', mechanic: 'stop-resume', stop,
          inconclusiveReason: thread ? 'the turn ended before the stop point was reached' : 'the stopped run reported no session to resume',
          toolStats: { calls: analyzeEvents(harness, first.execution.stdout, task).calls, maximumRepeated: 0 },
          wallClockMs: rounded(performance.now() - startedAt), process: exitOf(first.execution), protocol: protocolOf(harness, [first]),
        },
        evidence: { 'stopped-stdout.jsonl': first.execution.stdout, 'stopped-stderr.txt': first.execution.stderr },
      };
    }
    const resume = { ...base, args: ['exec', 'resume', thread, '--json', '--strict-config', '--skip-git-repo-check', '--model', 'ds4', task.stop.resumePrompt] };
    const second = await cliPhase({ proxy, runId: `${row.attemptId}-2`, command: resume, workspace, timeoutMs });
    const events = analyzeEvents(harness, second.execution.stdout, task);
    const graded = grade(task, workspace, before);
    return {
      result: {
        ...verdict(graded, events.answerAfterTool, second.execution.code === 0),
        mechanic: 'stop-resume', stop,
        resumedSession: parseEvents(second.execution.stdout).find((event) => event.type === 'thread.started')?.thread_id || null,
        toolStats: { calls: analyzeEvents(harness, first.execution.stdout, task).calls + events.calls, maximumRepeated: events.maximumRepeated },
        wallClockMs: rounded(performance.now() - startedAt),
        sessions: [exitOf(first.execution), exitOf(second.execution)],
        process: exitOf(second.execution),
        protocol: protocolOf(harness, [first, second]),
      },
      evidence: {
        'stopped-stdout.jsonl': first.execution.stdout, 'stopped-stderr.txt': first.execution.stderr,
        'resumed-stdout.jsonl': second.execution.stdout, 'resumed-stderr.txt': second.execution.stderr,
      },
    };
  }
  throw new Error(`${harness} has no ${task.mechanic} driver`);
}

export const CLI_LANE_AGENTS = Object.freeze(['pi', 'opencode', 'codex']);
const bounded = (text, limit = 4096) => (text.length > limit ? `${text.slice(0, limit)}...` : text);

// The CLIs of one lane run, set up once behind `proxy`: an isolated home and
// configuration each (nothing of the user's own setup is read), the version
// each reports, and a preflight in which each CLI says which model it resolved
// (pi and OpenCode list their provider's models; Codex runs its doctor, whose
// provider probe must pass through the proxy). No model request is sent.
export async function prepareCliLane({ agents, runDir, proxy, settings, timeoutMs = 300_000 }) {
  const environments = writeCompetitorConfigs({
    configRoot: path.join(runDir, 'isolated-cli-config'), workspace: runDir, baseUrl: proxy.baseUrl,
    contextTokens: settings.contextTokens, maxOutputTokens: settings.maxOutputTokens,
  });
  const run = (name, args) => runCli(name, args, { cwd: runDir, env: environments[name].env, timeoutMs });
  const checks = {
    pi: async () => {
      const result = await run('pi', ['--list-models', 'dstudio', '--offline']);
      return { ok: result.code === 0 && /\bdstudio\b[\s\S]*\bds4\b/i.test(result.stdout), result };
    },
    opencode: async () => {
      const result = await run('opencode', ['models', 'dstudio', '--pure']);
      return { ok: result.code === 0 && /dstudio\/ds4/i.test(result.stdout), result };
    },
    codex: async () => {
      proxy.begin('codex-preflight');
      let result;
      let probe = [];
      try { result = await run('codex', [...CODEX_PREFLIGHT_ARGS]); } finally { probe = proxy.end('codex-preflight'); }
      const ok = result.code === 0 && codexPreflight(result.stdout).ok &&
        probe.some((request) => request.method === 'GET' && request.path === '/v1/models') && !probe.some((request) => request.blocked);
      return { ok, result };
    },
  };
  const versions = {};
  const preflights = {};
  for (const name of CLI_LANE_AGENTS.filter((item) => agents.includes(item))) {
    const reported = await runCli(name, ['--version'], { cwd: runDir, env: environments[name].env, timeoutMs: 30_000 });
    versions[name] = (reported.code === 0 && reported.stdout.trim().split('\n').pop()) || 'unknown';
    const { ok, result } = await checks[name]();
    preflights[name] = { ok, exitCode: result.code, stdout: bounded(result.stdout), stderr: bounded(result.stderr) };
  }
  return { environments, versions, preflights };
}

// One planned attempt of a CLI agent, with the configuration `prepareCliLane`
// wrote. The CLI is started in the attempt's own workspace.
export async function runCliLaneAttempt({ cli, proxy, row, task, workspace, timeoutMs }) {
  if (!cli.preflights[row.agent]?.ok) throw new Error(`${row.agent} did not resolve the pinned DStudio model in its preflight`);
  const commandFor = (prompt) => {
    const command = competitorCommand({ harness: row.agent, prompt, workspace, title: `benchmark-${row.attemptId}`, environments: cli.environments });
    return { ...command, env: { ...command.env, PWD: workspace } };
  };
  return await runCliAttempt({ proxy, harness: row.agent, row, task, workspace, commandFor, timeoutMs });
}

export { CODEX_STOP_SIGNAL, codexExecArgs };

// ---------------------------------------------------------------- clean upstream ds4-agent
// `ds4-agent --trace FILE` writes one line per event; the formats below are
// the agent_trace* calls of the pinned src/engines/ds4/ds4_agent.c:
//   <time> user="<escaped>"                 a prompt was appended as a user turn
//   <time> queued_user="<escaped>"          input queued during a turn was appended after a tool round
//   <time> prefill sync done tool_round=N   the model is about to generate; N tool results precede it in this turn
//   <time> token index=I ... hex=<bytes>    between that and the next line: one generated token
//   <time> generation finished tool_round=N generated=G ...
//   <time> generation context boundary: ... the next round continues the same answer after a compaction
// The text an agent generated last is its answer; `toolRound` of that
// generation says whether a tool result preceded it in the same turn.
function unescapeTrace(text) {
  return text.replace(/\\(x[0-9a-fA-F]{2}|.)/g, (_match, code) => (code === 'n' ? '\n' : code === 'r' ? '\r' : code === 't' ? '\t'
    : code[0] === 'x' ? String.fromCharCode(parseInt(code.slice(1), 16)) : code));
}

export function parseUpstreamTrace(text) {
  const users = [];
  const queued = [];
  const generations = [];
  const carried = new Map();
  let open = null;
  for (const line of String(text).split('\n')) {
    const body = line.replace(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d+ /, '');
    let match;
    if ((match = /^user="(.*)"$/.exec(body))) users.push(unescapeTrace(match[1]));
    else if ((match = /^queued_user="(.*)"$/.exec(body))) queued.push(unescapeTrace(match[1]));
    else if ((match = /^prefill sync done tool_round=(\d+) /.exec(body))) open = { toolRound: Number(match[1]), chunks: [], turn: users.length };
    else if (open && (match = /^token index=\d+ id=-?\d+ bytes=\d+ text=".*" hex=([0-9a-f]*)$/.exec(body))) open.chunks.push(Buffer.from(match[1], 'hex'));
    else if (open && (match = /^generation finished tool_round=(\d+) generated=(\d+) /.exec(body))) {
      generations.push({ toolRound: open.toolRound, turn: open.turn, generated: Number(match[2]), text: Buffer.concat(open.chunks).toString('utf8') });
      open = null;
    } else if (/^generation context boundary: /.test(body)) carried.set(users.length, (carried.get(users.length) || 0) + 1);
  }
  const last = generations.at(-1) || null;
  // The round counter also advances when a generation is carried over a
  // context compaction without a tool; those rounds are not tool results.
  const rounds = (turn, upTo) => Math.max(0, upTo - (carried.get(turn) || 0));
  const perTurn = new Map();
  for (const item of generations) perTurn.set(item.turn, Math.max(perTurn.get(item.turn) || 0, item.toolRound));
  return {
    users, queued, generations,
    answer: last ? last.text : '',
    answerTurn: last ? last.turn : 0,
    // Tool results that preceded the last generation in its own turn.
    toolRoundsBeforeAnswer: last ? rounds(last.turn, last.toolRound) : 0,
    toolRounds: [...perTurn.entries()].reduce((total, [turn, highest]) => total + rounds(turn, highest), 0),
  };
}

export function upstreamAgentArgs({ model, workspace, trace, settings, prompt }) {
  return [
    '--non-interactive', '--nothink', '--ctx', String(settings.contextTokens), '--tokens', String(settings.maxOutputTokens),
    '--power', String(settings.power), '-m', model, '--chdir', workspace, '--trace', trace,
    ...(prompt === undefined ? [] : ['-p', prompt]),
  ];
}

function answered(trace, task) {
  const required = [task.expected, ...(task.answerMustContain || [])];
  return trace.toolRoundsBeforeAnswer > 0 && required.every((value) => trace.answer.includes(value));
}

// `agent` is { binary, cwd, env }: the clean build, started in its own source
// directory (it resolves its Metal sources there) with an empty home.
async function upstreamProcess({ agent, args, timeoutMs, stdin, onStderr }) {
  return startCli(agent.binary, args, { cwd: agent.cwd, env: agent.env, timeoutMs, stdin, onStderr });
}

export async function runUpstreamAttempt({ agent, row, task, workspace, attemptDir, model, settings, timeoutMs }) {
  const before = workspaceSnapshot(workspace);
  const startedAt = performance.now();
  const traces = [];
  const oneShot = async (prompt, name) => {
    const trace = path.join(attemptDir, `${name}.trace`);
    traces.push(trace);
    const handle = await upstreamProcess({ agent, timeoutMs, args: upstreamAgentArgs({ model, workspace, trace, settings, prompt }) });
    const execution = await handle.done;
    return { execution, trace: parseUpstreamTrace(fs.existsSync(trace) ? fs.readFileSync(trace, 'utf8') : '') };
  };
  if (task.mechanic === 'single' || task.mechanic === 'two-sessions') {
    const runs = [await oneShot(task.prompt, 'session-1')];
    if (task.mechanic === 'two-sessions') runs.push(await oneShot(task.secondPrompt, 'session-2'));
    const last = runs.at(-1);
    const graded = grade(task, workspace, before);
    const evidence = {};
    runs.forEach((run, index) => {
      evidence[`session-${index + 1}-stdout.txt`] = run.execution.stdout;
      evidence[`session-${index + 1}-stderr.txt`] = run.execution.stderr;
    });
    return {
      result: {
        ...verdict(graded, answered(last.trace, task), runs.every((run) => run.execution.code === 0)),
        mechanic: task.mechanic,
        toolStats: { calls: runs.reduce((total, run) => total + run.trace.toolRounds, 0), maximumRepeated: null },
        wallClockMs: rounded(performance.now() - startedAt),
        sessions: runs.map((run) => exitOf(run.execution)),
        process: exitOf(last.execution),
        protocol: { traceGenerations: runs.map((run) => run.trace.generations.length) },
      },
      evidence, traces,
    };
  }
  if (task.mechanic === 'steering') {
    // Without -p the agent reads prompts from stdin: it announces
    // +DWARFSTAR_WAITING on stderr when idle, takes what arrived once stdin
    // has been quiet for 200 ms, and answers input that arrives during a turn
    // with +DWARFSTAR_QUEUED; queued text is appended after the current tool
    // round, or starts the next turn if the turn has ended.
    const trace = path.join(attemptDir, 'session-1.trace');
    traces.push(trace);
    let stderr = '';
    const waiters = [];
    const count = (marker) => stderr.split('\n').filter((line) => line === marker).length;
    const handle = await upstreamProcess({
      agent, timeoutMs, stdin: 'pipe', args: upstreamAgentArgs({ model, workspace, trace, settings }),
      onStderr: (chunk) => {
        stderr += chunk;
        for (const waiter of waiters.splice(0)) waiter();
      },
    });
    let exited = false;
    handle.done.then(() => { exited = true; for (const waiter of waiters.splice(0)) waiter(); });
    const waitingAbove = async (seen) => {
      while (count('+DWARFSTAR_WAITING') <= seen && !exited) await new Promise((resolve) => waiters.push(resolve));
      return count('+DWARFSTAR_WAITING') > seen;
    };
    const steering = { reachedSteeringPoint: false, queuedAcknowledged: false, delivery: 'not-delivered' };
    if (await waitingAbove(0)) {
      handle.child.stdin.write(task.prompt);
      const idleAgain = waitingAbove(1);
      steering.reachedSteeringPoint = await reached(workspace, task.steering.when, Promise.race([idleAgain, handle.done]));
      const waitingBefore = count('+DWARFSTAR_WAITING');
      const queuedBefore = count('+DWARFSTAR_QUEUED');
      if (!exited) {
        handle.child.stdin.write(task.steering.text);
        await waitingAbove(waitingBefore);
        steering.queuedAcknowledged = count('+DWARFSTAR_QUEUED') > queuedBefore;
      }
    }
    if (!exited) handle.child.stdin.end();
    const execution = await handle.done;
    const parsed = parseUpstreamTrace(fs.existsSync(trace) ? fs.readFileSync(trace, 'utf8') : '');
    // The append to the transcript is the acknowledgement that counts.
    if (parsed.queued.some((text) => text.includes(task.steering.text))) steering.delivery = 'during-turn';
    else if (parsed.users.slice(1).some((text) => text.includes(task.steering.text))) steering.delivery = 'next-turn';
    const graded = grade(task, workspace, before);
    const base = verdict(graded, answered(parsed, task), execution.code === 0);
    const delivered = steering.reachedSteeringPoint && steering.delivery === 'during-turn';
    return {
      result: {
        ...base,
        ...(delivered ? {} : { taskSuccess: false, outcome: 'inconclusive',
          inconclusiveReason: steering.reachedSteeringPoint ? `the new instruction was ${steering.delivery === 'next-turn' ? 'taken as a new turn after the first one ended' : 'not appended to the transcript'}` : 'the turn ended before the steering point was reached' }),
        mechanic: 'steering', steering,
        toolStats: { calls: parsed.toolRounds, maximumRepeated: null },
        wallClockMs: rounded(performance.now() - startedAt),
        process: exitOf(execution),
        protocol: { traceGenerations: [parsed.generations.length], userTurns: parsed.users.length, queuedInputs: parsed.queued.length },
      },
      evidence: { 'session-1-stdout.txt': execution.stdout, 'session-1-stderr.txt': execution.stderr },
      traces,
    };
  }
  throw new Error(`the upstream agent has no ${task.mechanic} driver`);
}

// ---------------------------------------------------------------- the lane
// The fields every result row of a plan row carries, whatever its outcome.
export function attemptIdentity(row) {
  return {
    attemptId: row.attemptId, lane: row.lane, repetition: row.repetition, position: row.position,
    scenario: row.caseId, caseSet: row.caseSet, heldOut: row.heldOut, taskType: row.kind, mechanic: row.mechanic, variant: row.agent,
  };
}

// The result row of a BLOCKED or NOT_COMPARABLE plan row: carried, never run.
export function notAttempted(row) {
  return { ...attemptIdentity(row), outcome: row.status === 'BLOCKED' ? 'blocked' : 'not-comparable', taskSuccess: false, reason: row.reason };
}

// Runs the PLANNED rows of `plan` in plan order and returns one result per
// row of the plan, in plan order. BLOCKED and NOT_COMPARABLE rows are carried
// over with their reason and are never executed. A row whose result file
// exists is not run again (a stopped lane continues where it was); its stored
// result is used. `execute(row, prepared)` returns { result, evidence?, traces? }
// and may throw: that attempt becomes a harness-error.
export async function executeLane({ plan, runDir, execute, onAttempt = () => {}, shouldStop = () => false }) {
  const results = [];
  let stopped = false;
  for (const row of plan.rows) {
    const identity = attemptIdentity(row);
    if (row.status !== 'PLANNED') {
      results.push(notAttempted(row));
      continue;
    }
    const resultFile = path.join(runDir, 'attempts', row.attemptId, 'result.json');
    if (fs.existsSync(resultFile)) {
      results.push(JSON.parse(fs.readFileSync(resultFile, 'utf8')));
      continue;
    }
    if (stopped || shouldStop()) {
      stopped = true;
      results.push({ ...identity, outcome: 'not-run', taskSuccess: false, reason: 'the lane was stopped before this attempt' });
      continue;
    }
    let attempt;
    let prepared = null;
    try {
      // A directory without a result is an attempt an earlier run of this lane
      // was interrupted in. What it did is unknown, and it is not replayed.
      if (fs.existsSync(path.dirname(resultFile)))
        throw new Error('an earlier run of this lane was interrupted during this attempt: its outcome is unknown and it is not run again');
      prepared = prepareAttempt(runDir, row);
      const done = await execute(row, prepared);
      attempt = { ...done.result, ...identity };
      for (const [name, text] of Object.entries(done.evidence || {})) fs.writeFileSync(path.join(prepared.attemptDir, name), text);
    } catch (error) {
      attempt = { ...identity, outcome: 'harness-error', taskSuccess: false, harnessError: String(error?.stack || error) };
    }
    const attemptDir = prepared?.attemptDir || path.join(runDir, 'attempts', row.attemptId);
    fs.mkdirSync(attemptDir, { recursive: true });
    fs.writeFileSync(resultFile, `${JSON.stringify(attempt, null, 2)}\n`);
    results.push(attempt);
    onAttempt(attempt, results.length);
  }
  return results;
}

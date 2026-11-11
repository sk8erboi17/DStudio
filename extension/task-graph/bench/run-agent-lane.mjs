// One lane of the six-agent comparison (PLAN.MD P9): clean upstream ds4-agent,
// DStudio's patched Agent, the same through Task Graph, Pi, OpenCode and the
// Codex CLI, on the same cases, each attempt in a workspace of its own, in a
// seeded counterbalanced order, three times.
//
//   # The attempt list, without running anything (no model, no engine):
//   node extension/task-graph/bench/run-agent-lane.mjs --plan [options]
//   # The lane itself (real model, hours):
//   RUN_HEAVY=1 node extension/task-graph/bench/run-agent-lane.mjs [options] [HOST_BINARY]
//
// Options: --lane equivalent|product   --set development|held-out|all|recovery
//          --repetitions N (3)         --seed TEXT          --agents a,b,...
//          --output DIR (--plan)       --resume RUN_DIR (continue a stopped lane)
// DSTUDIO_RELIABILITY_SET names the set when --set is absent; without either
// the set is `development`, never the held-out cases.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import {
  buildLanePlan, DEFAULT_REPETITIONS, formatLaneSummary, LANE_AGENTS, lanePlanCsv, LANE_PLAN_SCHEMA, probeLaneAvailability,
  selectAgents, selectBenchmarkModel, selectLane, summarizeLanePlan,
} from './agent-lane.mjs';
import { selectCaseSet } from './case-sets.mjs';
import { inspectUpstreamAgent } from './build-upstream-agent.mjs';
import { executeLane, prepareCliLane, runCliLaneAttempt, runUpstreamAttempt } from './lane-drivers.mjs';
import { cleanEnvironment, rounded, startModelPinProxy } from './cli-competitor-harness.mjs';
import { changeAllowed, changedFiles, workspaceSnapshot } from './reliability-fixture.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

export function parseLaneArguments(argv, env = process.env) {
  const flags = new Set(['--plan']);
  const values = new Set(['--lane', '--set', '--repetitions', '--seed', '--agents', '--output', '--resume']);
  const options = { plan: false, positional: [] };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (flags.has(arg)) options[arg.slice(2)] = true;
    else if (values.has(arg)) {
      // `--seed --output DIR` must not make "--output" the seed and DIR the host binary.
      if (index + 1 >= argv.length || argv[index + 1].startsWith('--')) throw new Error(`${arg} needs a value`);
      options[arg.slice(2)] = argv[++index];
    } else if (arg.startsWith('--')) throw new Error(`unknown option ${arg}`);
    else options.positional.push(arg);
  }
  const lane = selectLane(options.lane);
  const set = selectCaseSet(options.set ?? env.DSTUDIO_RELIABILITY_SET);
  const repetitions = options.repetitions === undefined ? DEFAULT_REPETITIONS : Number(options.repetitions);
  if (!Number.isInteger(repetitions) || repetitions < 1) throw new Error('--repetitions must be a positive integer');
  return {
    plan: options.plan, lane, set, repetitions, agents: selectAgents(options.agents),
    seed: options.seed || `p9-${lane}-${set}`,
    output: options.output ? path.resolve(options.output) : null,
    resume: options.resume ? path.resolve(options.resume) : null,
    hostBinary: options.positional[0] || null,
  };
}

function writePlan(directory, plan) {
  fs.mkdirSync(directory, { recursive: true });
  const text = `${JSON.stringify(plan, null, 2)}\n`;
  fs.writeFileSync(path.join(directory, 'plan.json'), text);
  fs.writeFileSync(path.join(directory, 'plan.csv'), lanePlanCsv(plan));
  fs.writeFileSync(path.join(directory, 'plan-summary.txt'), `${formatLaneSummary(plan)}\n`);
  return crypto.createHash('sha256').update(text).digest('hex');
}

// ---------------------------------------------------------------- real run
function commandOutput(command, args, cwd = REPO_ROOT, env = process.env) {
  try {
    return execFileSync(command, args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

// Structured events of the patched Agent: a record separator, then one JSON object.
function structuredEvents(text) {
  const events = [];
  for (const match of text.matchAll(/\x1e(\{[^\r\n]*\})/g)) {
    try { events.push(JSON.parse(match[1])); } catch {}
  }
  return events;
}

function agentToolStats(text) {
  const calls = structuredEvents(text).filter((event) => event.type === 'tool_call');
  let previous = '';
  let repeated = 0;
  let maximumRepeated = 0;
  for (const call of calls) {
    const canonical = JSON.stringify({ name: call.name, input: call.input });
    repeated = canonical === previous ? repeated + 1 : 1;
    previous = canonical;
    maximumRepeated = Math.max(maximumRepeated, repeated);
  }
  return { calls: calls.length, maximumRepeated };
}

function answerAfterTool(text, task) {
  const toolResultAt = text.lastIndexOf('"type":"tool_result"');
  if (toolResultAt < 0) return false;
  const visibleAnswer = text.slice(text.indexOf('\n', toolResultAt) + 1)
    .replace(/\x1e[^\r\n]*/g, '').replace(/[\x01\x02]/g, '').replace(/saved session[^\r\n]*/g, '').replace(/\s+/g, '');
  return [task.expected, ...(task.answerMustContain || [])].every((value) => visibleAnswer.includes(value.replace(/\s+/g, '')));
}

function gradeHostAttempt({ task, workspace, before, answered, ran }) {
  const changed = changedFiles(before, workspaceSnapshot(workspace));
  const unexpectedChanges = changed.filter((file) => !changeAllowed(file, task.allowedChanges));
  const externalCheck = task.score();
  const taskSuccess = Boolean(ran && externalCheck.ok && answered && unexpectedChanges.length === 0);
  return {
    taskSuccess, outcome: taskSuccess ? 'completed' : 'failed', expectedAnswerAfterTool: answered,
    incorrectCompletionClaim: Boolean(answered && (!externalCheck.ok || unexpectedChanges.length)),
    externalCheck, changedFiles: changed, unexpectedChanges,
  };
}

async function runLane(options) {
  if (process.env.RUN_HEAVY !== '1') {
    console.error('The six-agent lane runs a real model for hours. Set RUN_HEAVY=1 explicitly, or use --plan.');
    return 2;
  }
  const harness = await import('../../../tests/support/real_harness.mjs');
  const { preflight, contamination } = await import('../../../tests/support/heavy_preflight.mjs');
  const { ownGitRevision } = await import('../../../tests/support/quality_baseline.mjs');
  const { artifactRunDir, csrfHeaders, jsonFetch, pollAgent, resolveDs4Dir, sleep, startDStudio, startMode, waitForAgentText, writeArtifact } = harness;
  const turnTimeoutMs = Number(process.env.DSTUDIO_LANE_TURN_TIMEOUT_MS ?? 1_200_000);

  let runDir = options.resume;
  let plan;
  if (runDir) {
    plan = JSON.parse(fs.readFileSync(path.join(runDir, 'plan.json'), 'utf8'));
    assert.equal(plan.schema, LANE_PLAN_SCHEMA, 'not a lane run directory');
    console.log(`Continuing the lane in ${runDir}`);
  } else {
    runDir = artifactRunDir('agent-lane-real');
    plan = buildLanePlan({ ...options, availability: probeLaneAvailability({ agents: options.agents, resolveEngine: resolveDs4Dir, hostBinary: path.resolve(options.hostBinary || 'tests/.build/dstudio-server-test') }) });
    writePlan(runDir, plan);
    console.log(`Immutable lane run: ${runDir}`);
  }
  console.log(formatLaneSummary(plan));
  const settings = plan.settings;
  const before = preflight({ dir: runDir });
  writeArtifact(runDir, `preflight-${Date.now()}.json`, before);
  if (!before.ok) {
    console.error(`BLOCKED: ${before.reasons.join('; ')}`);
    return 1;
  }

  const benchmarkStartedAt = performance.now();
  let host = null;
  let mode = null;
  let proxy = null;
  let model = null;
  let cli = null;
  const starts = [];
  const versions = {};
  const upstreamBuild = inspectUpstreamAgent();

  async function ensureHost() {
    if (host) return;
    host = await startDStudio({ binaryArg: options.hostBinary, label: 'dstudio-agent-lane', isolatedEnginePort: true });
    model = selectBenchmarkModel(host.ggufs, process.env.DSTUDIO_TASK_GRAPH_GGUF);
    assert.ok(model, 'No supported full local GGUF found');
  }
  async function stopMode() {
    if (!host || !mode) return;
    await jsonFetch(host.baseUrl, '/api/stop', { method: 'POST', headers: csrfHeaders, body: '{}', timeoutMs: 30_000 });
    for (let waited = 0; waited < 300; waited++) {
      const status = await jsonFetch(host.baseUrl, '/api/status', { timeoutMs: 5000 });
      if (status.running === false) { mode = null; return; }
      await sleep(1000);
    }
    throw new Error('the host did not stop its engine');
  }
  async function start(name, workdir) {
    await ensureHost();
    await stopMode();
    const launch = {
      mode: name, model: 'standard', variant: 'flash', gguf: model.file, port: host.enginePort,
      ctx: settings.contextTokens, power: settings.power, think: settings.thinking, ssdStreaming: settings.ssdStreaming, workdir,
    };
    const startedAt = performance.now();
    const startup = await startMode(host.baseUrl, launch, Number(process.env.DSTUDIO_RELIABILITY_START_TIMEOUT_MS || 1_800_000));
    assert.equal(startup.config?.ssdStreamingEffective, false, `SSD streaming remained effective: ${startup.config?.ssdStreamingReason || 'unknown'}`);
    mode = name;
    starts.push({ runtime: name, startMs: rounded(performance.now() - startedAt) });
  }
  async function ensureServer() {
    if (mode !== 'server') await start('server', runDir);
    if (!proxy) proxy = await startModelPinProxy(host.enginePort, { responsesMaxOutputTokens: Math.min(settings.maxOutputTokens, Math.floor(settings.contextTokens / 2)) });
    if (cli) return;
    cli = await prepareCliLane({ agents: plan.agents, runDir, proxy, settings });
    Object.assign(versions, cli.versions);
    writeArtifact(runDir, 'cli-preflight.json', { versions: cli.versions, preflights: cli.preflights });
  }

  async function graphTurn(prompt, workspace) {
    const sent = await jsonFetch(host.baseUrl, '/api/agent/send', { method: 'POST', headers: csrfHeaders, body: JSON.stringify({ prompt, orchestration: 'task-graph' }), timeoutMs: 30_000 });
    assert.equal(sent.orchestration, 'automatic-task-graph');
    assert.ok(sent.graphId, 'the automatic route did not return a graphId');
    const query = `graphId=${encodeURIComponent(sent.graphId)}&workspace=${encodeURIComponent(workspace)}`;
    const deadline = turnTimeoutMs > 0 ? Date.now() + turnTimeoutMs : Infinity;
    let last = null;
    while (Date.now() < deadline) {
      last = await jsonFetch(host.baseUrl, `/api/task-graph?${query}`, { timeoutMs: 10_000 });
      if (['succeeded', 'failed', 'cancelled', 'corrupt'].includes(last.graph?.state)) break;
      await sleep(100);
    }
    const graph = last?.graph;
    assert.ok(graph, 'the graph was not readable');
    const agentNodes = graph.nodes.filter((node) => node.kind === 'agent_turn' && node.attemptId);
    const transcript = (node) => JSON.parse(fs.readFileSync(path.join(workspace, '.dstudio', 'task-graphs', graph.graphId, 'attempts', node.id, `${node.attemptId}.transcript.json`), 'utf8')).content;
    const result = graph.nodes.find((node) => node.id === 'work' && node.attemptId) || agentNodes.at(-1);
    return {
      text: result ? transcript(result) : '', all: agentNodes.map((node) => `--- ${node.id} ---\n${transcript(node)}`).join('\n'),
      ran: graph.state === 'succeeded', graphState: graph.state, graphId: graph.graphId,
      toolStats: {
        toolCalls: agentNodes.reduce((total, node) => total + Number(node.watchdog?.toolCalls || 0), 0),
        repeatedCalls: Math.max(0, ...agentNodes.map((node) => Number(node.watchdog?.repeatedCalls || 0))),
        tripped: agentNodes.some((node) => node.watchdog?.tripped),
      },
    };
  }
  async function newAgentSession() {
    const seen = await pollAgent(host.baseUrl, 0);
    await jsonFetch(host.baseUrl, '/api/design/session', { method: 'POST', headers: csrfHeaders, body: JSON.stringify({ action: 'new' }), timeoutMs: 30_000 });
    const answer = await waitForAgentText(host.baseUrl, Number(seen.len || 0), (_text, poll) => poll.working === false, Number(process.env.DSTUDIO_RELIABILITY_SESSION_TIMEOUT_MS || 600_000));
    assert.match(answer.text, /started a new session|new session started/i, 'the Agent did not acknowledge a new session');
  }
  async function nativeTurn(prompt) {
    const sent = await jsonFetch(host.baseUrl, '/api/agent/send', { method: 'POST', headers: csrfHeaders, body: JSON.stringify({ prompt, orchestration: 'native' }), timeoutMs: 30_000 });
    const completed = await waitForAgentText(host.baseUrl, sent.at, (_text, poll) => poll.working === false, turnTimeoutMs);
    return { text: completed.text, all: completed.text, ran: true, toolStats: agentToolStats(completed.text) };
  }

  async function execute(row, { task, workspace, attemptDir }) {
    const agent = LANE_AGENTS.find((item) => item.id === row.agent);
    if (agent.runtime === 'ds4-server') {
      await ensureServer();
      return await runCliLaneAttempt({ cli, proxy, row, task, workspace, timeoutMs: turnTimeoutMs });
    }
    if (agent.runtime === 'upstream-agent') {
      await ensureHost();
      await stopMode();
      assert.ok(upstreamBuild.ok, upstreamBuild.reason);
      const home = path.join(attemptDir, 'home');
      fs.mkdirSync(home, { recursive: true });
      starts.push({ runtime: 'upstream-agent', startMs: null });
      return await runUpstreamAttempt({
        agent: { binary: upstreamBuild.binary, cwd: path.dirname(upstreamBuild.binary), env: cleanEnvironment({ HOME: home }) },
        row, task, workspace, attemptDir, model: path.join(host.ds4Dir, model.file), settings, timeoutMs: turnTimeoutMs,
      });
    }
    // The patched Agent, bound to this attempt's workspace by a new start.
    await start('agent', workspace);
    const snapshot = workspaceSnapshot(workspace);
    const startedAt = performance.now();
    const turn = row.agent === 'native-agent' ? nativeTurn : (prompt) => graphTurn(prompt, workspace);
    const turns = [await turn(task.prompt)];
    if (task.mechanic === 'two-sessions') {
      if (row.agent === 'native-agent') await newAgentSession();
      turns.push(await turn(task.secondPrompt));
    } else if (task.mechanic !== 'single') throw new Error(`${row.agent} has no ${task.mechanic} driver`);
    const last = turns.at(-1);
    const graded = gradeHostAttempt({ task, workspace, before: snapshot, answered: answerAfterTool(last.text, task), ran: turns.every((item) => item.ran) });
    return {
      result: {
        ...graded, mechanic: task.mechanic, toolStats: last.toolStats, wallClockMs: rounded(performance.now() - startedAt),
        ...(row.agent === 'task-graph' ? { graphStates: turns.map((item) => item.graphState), graphIds: turns.map((item) => item.graphId) } : {}),
      },
      evidence: Object.fromEntries(turns.map((item, index) => [`session-${index + 1}-transcript.txt`, item.all])),
    };
  }

  let stopRequested = false;
  process.once('SIGINT', () => { stopRequested = true; console.log('Stop requested: the lane ends after the current attempt.'); });
  let attempts = [];
  try {
    attempts = await executeLane({
      plan, runDir, execute, shouldStop: () => stopRequested,
      onAttempt: (attempt, done) => console.log(`agent_lane: ${done}/${plan.rows.length} ${attempt.attemptId} · ${attempt.outcome}`),
    });
  } finally {
    if (proxy) await proxy.close();
    if (host) await host.stop();
  }
  const after = preflight({ dir: runDir });
  const own = ownGitRevision(REPO_ROOT);
  const result = {
    schemaVersion: 1,
    benchmark: 'dstudio-agent-lane',
    ok: attempts.length === plan.rows.length && !attempts.some((attempt) => attempt.outcome === 'not-run'),
    measuredAt: new Date().toISOString(),
    lane: plan.lane, set: plan.set, sets: plan.sets, fixtures: plan.fixtures, seed: plan.seed, repetitions: plan.repetitions, agents: plan.agents,
    expectedAttempts: plan.expectedAttempts, order: plan.order, workspaces: plan.workspaces,
    planSHA256: crypto.createHash('sha256').update(fs.readFileSync(path.join(runDir, 'plan.json'))).digest('hex'),
    settings, equivalence: plan.equivalence, availability: plan.availability, mechanics: plan.mechanics,
    dstudio: { commit: own?.head || 'unknown', dirty: own ? Boolean(own.status) : null },
    ds4: host ? JSON.parse(fs.existsSync(path.join(host.ds4Dir, '.dstudio-source.json')) ? fs.readFileSync(path.join(host.ds4Dir, '.dstudio-source.json'), 'utf8') : '{}') : null,
    upstreamAgent: upstreamBuild.ok ? upstreamBuild.receipt : { unavailable: upstreamBuild.reason },
    hardware: { chip: commandOutput('sysctl', ['-n', 'machdep.cpu.brand_string']) || os.arch(), logicalCores: os.cpus().length, memoryBytes: os.totalmem(), os: `${os.type()} ${os.release()} ${os.arch()}` },
    model: model ? { file: path.basename(model.file), bytes: model.size } : null,
    cliVersions: versions,
    cliPreflight: cli?.preflights || {},
    runtimeStarts: starts,
    resourcePreflight: before,
    contamination: contamination(before, after),
    turnTimeoutMs,
    attempts,
    wallClockMs: rounded(performance.now() - benchmarkStartedAt),
    limitations: [
      'One machine, one model file, the settings recorded here; not a guarantee for other models, prompts, versions or hardware.',
      'The six agents use three different processes that own the model, so most attempts begin with a model load; the time of a load is not part of an attempt\'s time.',
      'An attempt of the clean upstream agent and of the DStudio Agent is timed from the prompt to the end of the turn; an attempt of a CLI includes the start of the CLI process.',
      'Sampling is each harness\'s default; no seed is pinned, so repetitions of one case may differ.',
    ],
  };
  writeArtifact(runDir, 'result.json', result);
  const summary = summarizeLanePlan(plan);
  console.log(`agent_lane: ${result.ok ? 'complete' : 'INCOMPLETE'} · ${attempts.filter((attempt) => attempt.taskSuccess).length}/${summary.attempts} attempts graded as success · result ${path.join(runDir, 'result.json')}`);
  return result.ok ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let options;
  try {
    options = parseLaneArguments(process.argv.slice(2));
  } catch (error) {
    console.error(`run-agent-lane: ${error.message}`);
    process.exit(2);
  }
  if (options.plan) {
    const { resolveDs4Dir } = await import('../../../tests/support/real_harness.mjs');
    const availability = probeLaneAvailability({ agents: options.agents, resolveEngine: resolveDs4Dir, hostBinary: path.resolve(options.hostBinary || 'tests/.build/dstudio-server-test') });
    const plan = buildLanePlan({ ...options, availability });
    const directory = options.output || path.join(process.cwd(), 'tests', '.artifacts', 'agent-lane', 'plans', `${plan.lane}-${plan.set}`);
    const digest = writePlan(directory, plan);
    console.log(formatLaneSummary(plan));
    console.log(`plan: ${plan.rows.length} rows in ${path.join(directory, 'plan.json')} (sha256 ${digest.slice(0, 16)}) and plan.csv; nothing was run`);
  } else {
    process.exit(await runLane(options));
  }
}

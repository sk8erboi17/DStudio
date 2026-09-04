import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import {
  artifactDir, csrfHeaders, jsonFetch, pollAgent, safeReadTail, sleep,
  startDStudio, startMode, waitForAgentText, writeArtifact,
} from '../../../tests/real_harness.mjs';
import {
  changeAllowed, changedFiles, createReliabilityFixture, RELIABILITY_SUITE_SIZE,
  workspaceSnapshot,
} from './reliability-fixture.mjs';

if (process.env.RUN_HEAVY !== '1') {
  console.error('Real reliability benchmark is disabled. Set RUN_HEAVY=1 explicitly.');
  process.exit(2);
}

const artifacts = artifactDir('task-graph-reliability-real');
for (const name of fs.readdirSync(artifacts))
  fs.rmSync(path.join(artifacts, name), { recursive: true, force: true });
const workspace = path.join(artifacts, 'workspace');
fs.mkdirSync(workspace, { recursive: true });
const caseCount = Math.max(1, Math.min(RELIABILITY_SUITE_SIZE,
  Number(process.env.DSTUDIO_RELIABILITY_CASES || 50) || 50));
const fixture = createReliabilityFixture({
  workspace,
  caseCount,
  variants: ['native-agent', 'task-graph'],
});
const scenarioTemplates = fixture.templates;
const onlyIds = new Set(String(process.env.DSTUDIO_RELIABILITY_ONLY || '')
  .split(',').map((value) => value.trim()).filter(Boolean));
const scenarios = onlyIds.size
  ? fixture.scenarios.filter((scenario) => onlyIds.has(scenario.id))
  : fixture.scenarios;
if (onlyIds.size && scenarios.length !== onlyIds.size)
  throw new Error(`unknown DSTUDIO_RELIABILITY_ONLY case(s): ${[...onlyIds].filter((id) =>
    !scenarios.some((scenario) => scenario.id === id)).join(', ')}`);

function rounded(value, digits = 2) {
  return Number(Number(value).toFixed(digits));
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function byTask(runs) {
  return Object.fromEntries(scenarioTemplates.map((template) => {
    const matching = runs.filter((run) => run.taskType === template.id);
    return [template.id, {
      runs: matching.length,
      successes: matching.filter((run) => run.taskSuccess).length,
    }];
  }));
}

function commandOutput(command, args, cwd) {
  try {
    return execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

function revisionInfo(cwd) {
  return {
    commit: commandOutput('git', ['rev-parse', '--short=12', 'HEAD'], cwd) || 'unknown',
    dirty: Boolean(commandOutput('git', ['status', '--porcelain'], cwd)),
  };
}

function selectModel(ggufs) {
  const requested = process.env.DSTUDIO_TASK_GRAPH_GGUF;
  if (requested) {
    const exact = ggufs.find((item) => item.file === requested || item.file.endsWith(`/${requested}`));
    assert.ok(exact, `DSTUDIO_TASK_GRAPH_GGUF not found: ${requested}`);
    return exact;
  }
  const usable = ggufs.filter((item) => !/DSpark-support|MXFP4|Vision-Encoder|GLM-5\.2/i.test(item.file));
  return usable.find((item) => /DeepSeek-V4-Flash-IQ2XXS.*imatrix/i.test(item.file)) || usable[0];
}

function hardwareInfo() {
  const chip = process.platform === 'darwin'
    ? commandOutput('sysctl', ['-n', 'machdep.cpu.brand_string'])
    : os.cpus()[0]?.model;
  return {
    chip: chip || os.arch(),
    logicalCores: os.cpus().length,
    memoryBytes: os.totalmem(),
    os: `${os.type()} ${os.release()} ${os.arch()}`,
  };
}

function structuredEvents(text) {
  const events = [];
  for (const match of text.matchAll(/\x1e(\{[^\r\n]*\})/g)) {
    try { events.push(JSON.parse(match[1])); } catch {}
  }
  return events;
}

function toolStats(text) {
  const calls = structuredEvents(text).filter((event) => event.type === 'tool_call');
  let previous = '', repeated = 0, maximumRepeated = 0;
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
    .replace(/\x1e[^\r\n]*/g, '')
    .replace(/[\x01\x02]/g, '')
    .replace(/saved session[^\r\n]*/g, '')
    .replace(/\s+/g, '');
  const required = [task.expected, ...(task.answerMustContain || [])];
  return required.every((value) => visibleAnswer.includes(value.replace(/\s+/g, '')));
}

async function runDirect(server, scenario) {
  const task = scenario.variants['native-agent'];
  const before = workspaceSnapshot(workspace);
  const startedAt = performance.now();
  const sent = await jsonFetch(server.baseUrl, '/api/agent/send', {
    method: 'POST', headers: csrfHeaders,
    body: JSON.stringify({ prompt: task.prompt, orchestration: 'native' }), timeoutMs: 30_000,
  });
  const completed = await waitForAgentText(server.baseUrl, sent.at,
    (_text, poll) => poll.working === false,
    Number(process.env.DSTUDIO_RELIABILITY_TURN_TIMEOUT_MS || 1_200_000));
  const wallClockMs = rounded(performance.now() - startedAt);
  const after = workspaceSnapshot(workspace);
  const changed = changedFiles(before, after);
  const unexpectedChanges = changed.filter((file) => !changeAllowed(file, task.allowedChanges));
  const external = task.score();
  const agentClaimedDone = answerAfterTool(completed.text, task);
  const result = {
    variant: 'native-agent', scenario: scenario.id, taskType: scenario.templateId,
    taskSuccess: Boolean(external.ok && agentClaimedDone && unexpectedChanges.length === 0),
    expectedAnswerAfterTool: agentClaimedDone,
    incorrectCompletionClaim: Boolean(agentClaimedDone && (!external.ok || unexpectedChanges.length)),
    externalCheck: external,
    changedFiles: changed,
    unexpectedChanges,
    toolStats: toolStats(completed.text),
    wallClockMs,
    humanRecoveryInterventions: 0,
  };
  writeArtifact(artifacts, `${scenario.id}-direct-transcript.txt`, completed.text);
  writeArtifact(artifacts, `${scenario.id}-direct-result.json`, result);
  return result;
}

async function freshAgentSession(server) {
  const before = await pollAgent(server.baseUrl, 0);
  await jsonFetch(server.baseUrl, '/api/design/session', {
    method: 'POST', headers: csrfHeaders,
    body: JSON.stringify({ action: 'new' }), timeoutMs: 30_000,
  });
  const completed = await waitForAgentText(server.baseUrl, Number(before.len || 0),
    (_text, poll) => poll.working === false,
    Number(process.env.DSTUDIO_RELIABILITY_SESSION_TIMEOUT_MS || 600_000));
  assert.match(completed.text, /started a new session|new session started/i,
    'The native Agent did not acknowledge a fresh benchmark session');
}

async function waitForGraph(baseUrl, graphId, timeoutMs = 1_200_000) {
  const query = `graphId=${encodeURIComponent(graphId)}&workspace=${encodeURIComponent(workspace)}`;
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await jsonFetch(baseUrl, `/api/task-graph?${query}`, { timeoutMs: 10_000 });
    if (['succeeded', 'failed', 'cancelled', 'corrupt'].includes(last.graph?.state)) return last;
    await sleep(100);
  }
  throw new Error(`Task Graph timed out: ${JSON.stringify(last)}`);
}

async function createAndStartGraph(baseUrl, definition) {
  const validated = await jsonFetch(baseUrl, '/api/task-graph/validate', {
    method: 'POST', headers: csrfHeaders, body: JSON.stringify(definition), timeoutMs: 30_000,
  });
  assert.equal(validated.executionAvailable, true);
  const created = await jsonFetch(baseUrl, '/api/task-graph/create', {
    method: 'POST', headers: csrfHeaders, body: JSON.stringify(definition), timeoutMs: 30_000,
  });
  assert.ok(['ready', 'validated'].includes(created.graph.state));
  return await jsonFetch(baseUrl, '/api/task-graph/start', {
    method: 'POST', headers: csrfHeaders,
    body: JSON.stringify({
      graphId: created.graph.graphId, workspace,
      expectedRevision: created.graph.revision,
      expectedLastEventSeq: created.graph.lastEventSeq,
    }),
    timeoutMs: 30_000,
  });
}

async function runTaskGraph(server, scenario) {
  const task = scenario.variants['task-graph'];
  const before = workspaceSnapshot(workspace);
  const startedAt = performance.now();
  const started = await jsonFetch(server.baseUrl, '/api/agent/send', {
    method: 'POST', headers: csrfHeaders,
    body: JSON.stringify({ prompt: task.prompt, orchestration: 'task-graph' }),
    timeoutMs: 30_000,
  });
  assert.equal(started.orchestration, 'automatic-task-graph');
  assert.ok(started.graphId, 'Automatic Agent route did not return a graphId');
  const completed = await waitForGraph(server.baseUrl, started.graphId,
    Number(process.env.DSTUDIO_RELIABILITY_TURN_TIMEOUT_MS || 1_200_000));
  const wallClockMs = rounded(performance.now() - startedAt);
  const agentNodes = completed.graph.nodes.filter((node) => node.kind === 'agent_turn');
  assert.ok(agentNodes.length && agentNodes.every((node) => node.attemptId),
    'Task Graph Agent attempt is missing');
  const transcripts = new Map(agentNodes.map((node) => {
    const transcriptPath = path.join(workspace, '.dstudio', 'task-graphs', completed.graph.graphId,
      'attempts', node.id, `${node.attemptId}.transcript.json`);
    return [node.id, JSON.parse(fs.readFileSync(transcriptPath, 'utf8')).content];
  }));
  const resultAgent = completed.graph.nodes.find((node) => node.id === 'work') || agentNodes.at(-1);
  const transcript = transcripts.get(resultAgent.id);
  const combinedTranscript = agentNodes.map((node) => `--- ${node.id} ---\n${transcripts.get(node.id)}`).join('\n');
  const after = workspaceSnapshot(workspace);
  const changed = changedFiles(before, after);
  const unexpectedChanges = changed.filter((file) => !changeAllowed(file, task.allowedChanges));
  const external = task.score();
  const finalJoinRan = completed.graph.nodes.some((node) => node.kind === 'join' && node.state === 'succeeded');
  const agentClaimedDone = answerAfterTool(transcript, task);
  const graphToolStats = {
    toolCalls: agentNodes.reduce((total, node) => total + Number(node.watchdog?.toolCalls || 0), 0),
    repeatedCalls: Math.max(0, ...agentNodes.map((node) => Number(node.watchdog?.repeatedCalls || 0))),
    tripped: agentNodes.some((node) => node.watchdog?.tripped),
  };
  const result = {
    variant: 'task-graph', scenario: scenario.id, taskType: scenario.templateId,
    taskSuccess: Boolean(completed.graph.state === 'succeeded' && external.ok &&
      agentClaimedDone && unexpectedChanges.length === 0),
    graphState: completed.graph.state,
    gatesPassed: completed.graph.nodes.filter((node) => node.kind === 'gate' && node.state === 'succeeded').length,
    expectedAnswerAfterTool: agentClaimedDone,
    finalJoinRan,
    incorrectResultBlocked: Boolean(!external.ok && completed.graph.state === 'failed' && !finalJoinRan),
    incorrectCompletionClaim: Boolean((!external.ok || unexpectedChanges.length) &&
      completed.graph.state === 'succeeded' && agentClaimedDone),
    externalCheck: external,
    changedFiles: changed,
    unexpectedChanges,
    toolStats: graphToolStats,
    wallClockMs,
    humanRecoveryInterventions: 0,
    graphId: completed.graph.graphId,
  };
  writeArtifact(artifacts, `${scenario.id}-graph-transcript.txt`, combinedTranscript);
  writeArtifact(artifacts, `${scenario.id}-graph-result.json`, result);
  return result;
}

function resetScenario(scenario, variant) {
  fixture.resetScenario(scenario, variant);
}

async function runGuardrailFaults(server) {
  const results = {};

  const escape = path.resolve(workspace, '..', 'task-graph-escape.txt');
  try { fs.unlinkSync(escape); } catch {}
  const invalid = {
    schemaVersion: 1, policy: 'agent.general.v1', mode: 'agent', executorMode: 'native',
    goal: 'Reject path traversal', workspace,
    nodes: [{
      id: 'bad', kind: 'host_tool', title: 'Escape', mutation: 'workspace_write',
      capabilities: ['filesystem.write'], action: { name: 'workspace.write', path: '../task-graph-escape.txt', text: 'bad' },
    }],
  };
  let policyRejected = false;
  try {
    await jsonFetch(server.baseUrl, '/api/task-graph/validate', {
      method: 'POST', headers: csrfHeaders, body: JSON.stringify(invalid), timeoutMs: 30_000,
    });
  } catch { policyRejected = true; }
  results.invalidPath = { injected: true, preventedBeforeExecution: policyRejected, outsideFileCreated: fs.existsSync(escape) };

  const gateDefinition = {
    schemaVersion: 1, policy: 'agent.general.v1', mode: 'agent', executorMode: 'native',
    goal: 'Detect corrupted output', workspace,
    nodes: [
      {
        id: 'write', kind: 'host_tool', title: 'Write invalid output', mutation: 'workspace_write',
        capabilities: ['filesystem.write'], action: { name: 'workspace.write', path: 'corrupt-output.txt', text: 'WRONG\n' },
      },
      {
        id: 'gate', kind: 'gate', title: 'Require correct output', dependsOn: ['write'],
        capabilities: ['filesystem.read'], action: { name: 'workspace.assert', path: 'corrupt-output.txt', contains: 'EXPECTED_OK' },
      },
      { id: 'join', kind: 'join', title: 'Must not run', dependsOn: ['gate'], action: { name: 'join.all' } },
    ],
  };
  const gateStarted = await createAndStartGraph(server.baseUrl, gateDefinition);
  const gateCompleted = await waitForGraph(server.baseUrl, gateStarted.graph.graphId, 30_000);
  results.corruptedOutput = {
    injected: true,
    graphState: gateCompleted.graph.state,
    gateState: gateCompleted.graph.nodes.find((node) => node.id === 'gate')?.state,
    downstreamJoinRan: gateCompleted.graph.nodes.find((node) => node.id === 'join')?.attemptsStarted > 0,
  };

  fs.writeFileSync(path.join(workspace, 'undo-target.txt'), 'BEFORE\n');
  const undoDefinition = {
    schemaVersion: 1, policy: 'agent.general.v1', mode: 'agent', executorMode: 'native',
    goal: 'Refuse conflicting undo', workspace,
    nodes: [
      {
        id: 'write', kind: 'host_tool', title: 'Write checkpointed output', mutation: 'workspace_write',
        capabilities: ['filesystem.write'], action: { name: 'workspace.write', path: 'undo-target.txt', text: 'AFTER\n' },
      },
      {
        id: 'gate', kind: 'gate', title: 'Verify changed output', dependsOn: ['write'],
        capabilities: ['filesystem.read'], action: { name: 'workspace.assert', path: 'undo-target.txt', contains: 'AFTER' },
      },
      { id: 'join', kind: 'join', title: 'Complete checkpoint', dependsOn: ['gate'], action: { name: 'join.all' } },
    ],
  };
  const undoStarted = await createAndStartGraph(server.baseUrl, undoDefinition);
  const undoCompleted = await waitForGraph(server.baseUrl, undoStarted.graph.graphId, 30_000);
  assert.equal(undoCompleted.graph.state, 'succeeded');
  fs.writeFileSync(path.join(workspace, 'undo-target.txt'), 'EXTERNAL_CHANGE\n');
  let undoRefused = false;
  try {
    await jsonFetch(server.baseUrl, '/api/task-graph/node/undo', {
      method: 'POST', headers: csrfHeaders,
      body: JSON.stringify({
        graphId: undoCompleted.graph.graphId, workspace, nodeId: 'write',
        expectedRevision: undoCompleted.graph.revision,
        expectedLastEventSeq: undoCompleted.graph.lastEventSeq,
      }), timeoutMs: 30_000,
    });
  } catch { undoRefused = true; }
  results.conflictingUndo = {
    injected: true,
    refused: undoRefused,
    externalChangePreserved: fs.readFileSync(path.join(workspace, 'undo-target.txt'), 'utf8') === 'EXTERNAL_CHANGE\n',
  };

  const unit = spawnSync(path.join(process.cwd(), 'tests', '.build', 'task_graph_unit'), [], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 60_000,
  });
  results.antiLoop = {
    fourIdenticalStructuredCallsInjected: true,
    watchdogThresholdTestPassed: unit.status === 0 && /task_graph_unit: \d+ lightweight checks passed/.test(unit.stdout),
  };
  return results;
}

async function createCrashGraph(server) {
  const definition = {
    schemaVersion: 1, policy: 'test.synthetic.v1', executorMode: 'synthetic',
    goal: 'Recover a running graph after host crash', workspace,
    nodes: [
      { id: 'delayed', kind: 'host_tool', title: 'Durable delayed work', synthetic: { delayMs: 3000 } },
      { id: 'join', kind: 'join', title: 'Finish after restart', dependsOn: ['delayed'], synthetic: { delayMs: 0 } },
    ],
  };
  const started = await createAndStartGraph(server.baseUrl, definition);
  assert.ok(started.graph.nodes.some((node) => node.state === 'running'));
  return started.graph.graphId;
}

async function waitForChildExit(child, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) await sleep(50);
  assert.ok(child.exitCode !== null || child.signalCode !== null, 'DStudio did not exit after injected crash');
}

let server = await startDStudio({
  binaryArg: process.argv[2], label: 'dstudio-task-graph-reliability', isolatedEnginePort: true,
});
const benchmarkStartedAt = performance.now();

try {
  const model = selectModel(server.ggufs);
  assert.ok(model, 'No supported full local GGUF found');
  const launch = {
    mode: 'agent', model: 'standard', variant: 'flash', gguf: model.file,
    port: server.enginePort,
    ctx: Number(process.env.DSTUDIO_RELIABILITY_CTX || 8192),
    power: Number(process.env.DSTUDIO_RELIABILITY_POWER || 70),
    think: 'off', ssdStreaming: 'off', workdir: workspace,
  };
  writeArtifact(artifacts, 'launch.json', launch);
  const startupStartedAt = performance.now();
  const startup = await startMode(server.baseUrl, launch,
    Number(process.env.DSTUDIO_RELIABILITY_START_TIMEOUT_MS || 1_800_000));
  const startupMs = rounded(performance.now() - startupStartedAt);
  writeArtifact(artifacts, 'startup.json', startup);
  assert.equal(startup.config?.ssdStreaming, 'off');
  assert.equal(startup.config?.ssdStreamingEffective, false,
    `SSD streaming remained effective: ${startup.config?.ssdStreamingReason || 'unknown'}`);

  const direct = [];
  const taskGraph = [];
  for (let index = 0; index < scenarios.length; index++) {
    const scenario = scenarios[index];
    if (index % 2 === 0) {
      resetScenario(scenario, 'native-agent');
      await freshAgentSession(server);
      direct.push(await runDirect(server, scenario));
      resetScenario(scenario, 'task-graph');
      await freshAgentSession(server);
      taskGraph.push(await runTaskGraph(server, scenario));
    } else {
      resetScenario(scenario, 'task-graph');
      await freshAgentSession(server);
      taskGraph.push(await runTaskGraph(server, scenario));
      resetScenario(scenario, 'native-agent');
      await freshAgentSession(server);
      direct.push(await runDirect(server, scenario));
    }
    console.log(`reliability_ab: ${index + 1}/${scenarios.length} ${scenario.id} · direct=${direct.at(-1).taskSuccess} graph=${taskGraph.at(-1).taskSuccess}`);
  }

  const faults = await runGuardrailFaults(server);
  const crashGraphId = await createCrashGraph(server);
  const crashedServer = server;
  crashedServer.child.kill('SIGKILL');
  await waitForChildExit(crashedServer.child);
  await crashedServer.stop();
  await sleep(3500);
  server = await startDStudio({
    binaryArg: process.argv[2], label: 'dstudio-task-graph-recovery', isolatedEnginePort: true,
  });
  const recovered = await waitForGraph(server.baseUrl, crashGraphId, 30_000);
  faults.hostCrashRecovery = {
    crashInjectedWhileRunning: true,
    recoveredGraphState: recovered.graph.state,
    recoveredWithoutModelReload: recovered.graph.state === 'succeeded',
    humanRecoveryInterventions: 0,
  };

  const directSuccesses = direct.filter((result) => result.taskSuccess).length;
  const graphSuccesses = taskGraph.filter((result) => result.taskSuccess).length;
  const graphBlockedIncorrect = taskGraph.filter((result) => result.incorrectResultBlocked).length;
  const graphFalseSuccesses = taskGraph.filter((result) =>
    !result.taskSuccess && result.graphState === 'succeeded').length;
  const paired = scenarios.reduce((summary, _scenario, index) => {
    const directOk = direct[index].taskSuccess;
    const graphOk = taskGraph[index].taskSuccess;
    if (directOk && graphOk) summary.bothSucceeded++;
    else if (directOk) summary.nativeAgentOnly++;
    else if (graphOk) summary.taskGraphOnly++;
    else summary.bothFailed++;
    return summary;
  }, { bothSucceeded: 0, nativeAgentOnly: 0, taskGraphOnly: 0, bothFailed: 0 });
  const result = {
    schemaVersion: 1,
    ok: direct.length === scenarios.length && taskGraph.length === scenarios.length &&
      graphSuccesses >= directSuccesses && paired.nativeAgentOnly === 0 &&
      graphFalseSuccesses === 0 &&
      taskGraph.every((run) => !run.incorrectCompletionClaim && !run.unexpectedChanges.length) &&
      faults.invalidPath.preventedBeforeExecution &&
      faults.corruptedOutput.graphState === 'failed' && !faults.corruptedOutput.downstreamJoinRan &&
      faults.conflictingUndo.refused && faults.conflictingUndo.externalChangePreserved &&
      faults.antiLoop.watchdogThresholdTestPassed &&
      faults.hostCrashRecovery.recoveredWithoutModelReload,
    measuredAt: new Date().toISOString(),
    dstudio: revisionInfo(process.cwd()),
    ds4: revisionInfo(server.ds4Dir),
    hardware: hardwareInfo(),
    model: { file: model.file, bytes: model.size },
    configuration: {
      contextTokens: launch.ctx,
      power: launch.power,
      thinking: launch.think,
      ssdStreaming: startup.config?.ssdStreaming,
      ssdStreamingEffective: startup.config?.ssdStreamingEffective,
      ssdStreamingReason: startup.config?.ssdStreamingReason,
      fullModelReady: startup.ready === true,
      matchedCases: scenarios.length,
      selectedCaseFilter: onlyIds.size ? [...onlyIds] : null,
    },
    fixture: fixture.metadata,
    startupMs,
    comparison: {
      scenarios: scenarios.length,
      nativeAgent: {
        successes: directSuccesses,
        successRatePercent: rounded(directSuccesses / direct.length * 100, 1),
        incorrectCompletionClaims: direct.filter((run) => run.incorrectCompletionClaim).length,
        unexpectedModificationRuns: direct.filter((run) => run.unexpectedChanges.length).length,
        maximumRepeatedToolCalls: Math.max(...direct.map((run) => run.toolStats.maximumRepeated)),
        medianWallClockMs: rounded(median(direct.map((run) => run.wallClockMs))),
        byTask: byTask(direct),
      },
      taskGraph: {
        successes: graphSuccesses,
        successRatePercent: rounded(graphSuccesses / taskGraph.length * 100, 1),
        incorrectResultsBlocked: graphBlockedIncorrect,
        graphsCompletedWithoutTaskSuccess: graphFalseSuccesses,
        incorrectCompletionClaims: taskGraph.filter((run) => run.incorrectCompletionClaim).length,
        unexpectedModificationRuns: taskGraph.filter((run) => run.unexpectedChanges.length).length,
        watchdogTrips: taskGraph.filter((run) => run.toolStats.tripped).length,
        medianWallClockMs: rounded(median(taskGraph.map((run) => run.wallClockMs))),
        byTask: byTask(taskGraph),
      },
      percentagePointDifference: rounded((graphSuccesses - directSuccesses) / scenarios.length * 100, 1),
      paired,
      runs: { nativeAgent: direct, taskGraph },
    },
    injectedFaults: faults,
    humanRecoveryInterventions: 0,
    wallClockMs: rounded(performance.now() - benchmarkStartedAt),
    limitations: [
      `${scenarios.length} matched A/B cases draw from ${fixture.templates.length} local-agent task families with five different fixtures per family in the complete suite.`,
      `Out of scope: ${fixture.metadata.coverage.excluded.join('; ')}.`,
      'Every variant uses a fresh Agent session while keeping the same full model loaded; they are not independent cold model starts.',
      'The crash test targets the durable graph runtime after deterministic work, not resumption of an in-flight LLM token stream.',
      'The approval benchmark uses no human click; approval behavior is covered by the separate native SSD benchmark.',
    ],
  };
  writeArtifact(artifacts, 'result.json', result);
  assert.equal(result.ok, true, `Reliability benchmark failed: ${JSON.stringify(result, null, 2)}`);
  console.log(`task_graph_reliability_real: ok · direct ${directSuccesses}/${direct.length} · graph ${graphSuccesses}/${taskGraph.length} · graph blocked ${graphBlockedIncorrect} incorrect result(s) · SSD streaming off`);
} catch (error) {
  writeArtifact(artifacts, 'failure.txt', `${error?.stack || error}\n\n${safeReadTail(server?.logPath)}`);
  throw error;
} finally {
  if (server) await server.stop();
}

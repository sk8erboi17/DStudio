import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import {
  artifactDir, csrfHeaders, jsonFetch, safeReadTail, sleep,
  startDStudio, startMode, writeArtifact,
} from '../../../tests/support/real_harness.mjs';

if (process.env.RUN_HEAVY !== '1') {
  console.error('Real Task Graph SSD-streaming test is disabled. Set RUN_HEAVY=1 explicitly.');
  process.exit(2);
}

const artifacts = artifactDir('task-graph-ssd-real');
for (const name of fs.readdirSync(artifacts))
  fs.rmSync(path.join(artifacts, name), { recursive: true, force: true });
const workspace = path.join(artifacts, 'workspace');
fs.mkdirSync(workspace, { recursive: true });
fs.writeFileSync(path.join(workspace, 'README.md'), [
  '# DStudio Task Graph SSD test',
  'Marker: TASK_GRAPH_SOURCE_OK',
  'This workspace is read-only for the Agent node.',
].join('\n'));

const runCount = Math.max(1, Math.min(10,
  Number(process.env.DSTUDIO_TASK_GRAPH_BENCH_RUNS || 1) || 1));

function selectModel(ggufs) {
  const requested = process.env.DSTUDIO_TASK_GRAPH_GGUF;
  if (requested) {
    const exact = ggufs.find((item) => item.file === requested || item.file.endsWith(`/${requested}`));
    assert.ok(exact, `DSTUDIO_TASK_GRAPH_GGUF not found: ${requested}`);
    return exact;
  }
  const usable = ggufs.filter((item) => !/DSpark-support|MXFP4|Vision-Encoder|GLM-5\.2/i.test(item.file));
  return usable.find((item) => /DeepSeek-V4-Flash-IQ2XXS.*imatrix/i.test(item.file)) ||
    usable.find((item) => /GLM-5\.3-Flash-Q2/i.test(item.file)) || usable[0];
}

function rounded(value, digits = 2) {
  return Number(Number(value).toFixed(digits));
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function aggregate(values) {
  return {
    median: rounded(median(values)),
    min: rounded(Math.min(...values)),
    max: rounded(Math.max(...values)),
  };
}

function commandOutput(command, args, cwd) {
  try {
    return execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

function revisionInfo(cwd) {
  const commit = commandOutput('git', ['rev-parse', '--short=12', 'HEAD'], cwd) || 'unknown';
  const dirty = Boolean(commandOutput('git', ['status', '--porcelain'], cwd));
  return { commit, dirty };
}

function hardwareInfo() {
  let chip = os.cpus()[0]?.model || os.arch();
  let ssd = 'not reported';
  if (process.platform === 'darwin') {
    chip = commandOutput('sysctl', ['-n', 'machdep.cpu.brand_string']) || chip;
    const profile = commandOutput('system_profiler', ['SPNVMeDataType']);
    const model = profile.match(/^\s*Model:\s*(.+)$/m)?.[1]?.trim();
    const capacity = profile.match(/^\s*Capacity:\s*([^\n(]+)/m)?.[1]?.trim();
    if (model || capacity) ssd = [model, capacity].filter(Boolean).join(', ');
  }
  return {
    chip,
    logicalCores: os.cpus().length,
    memoryBytes: os.totalmem(),
    os: `${os.type()} ${os.release()} ${os.arch()}`,
    ssd,
  };
}

function eventDuration(events, startType, endType, nodeId = '') {
  const matches = (event, type) => event.type === type && (!nodeId || event.nodeId === nodeId);
  const start = events.find((event) => matches(event, startType));
  const end = events.find((event) => matches(event, endType));
  assert.ok(start && end && end.ts >= start.ts,
    `missing duration events ${startType} -> ${endType}${nodeId ? ` for ${nodeId}` : ''}`);
  return end.ts - start.ts;
}

function transcriptMetrics(envelopeText) {
  const envelope = JSON.parse(envelopeText);
  const statuses = [];
  for (const match of envelope.content.matchAll(/\x1e(\{[^\r\n]*\})/g)) {
    try {
      const event = JSON.parse(match[1]);
      if (event.type === 'status') statuses.push(event);
    } catch {}
  }
  function groupsFor(state, tokenKey, rateKey) {
    const groups = [];
    let current = null;
    let previousState = '';
    for (const status of statuses) {
      if (status.state !== state) {
        previousState = status.state;
        current = null;
        continue;
      }
      if (!current || previousState !== state) {
        current = { tokens: 0, rate: 0 };
        groups.push(current);
      }
      current.tokens = Math.max(current.tokens, Number(status[tokenKey]) || 0);
      if ((Number(status[rateKey]) || 0) > 0) current.rate = Number(status[rateKey]);
      previousState = state;
    }
    return groups;
  }
  function summarize(groups) {
    const tokens = groups.reduce((sum, group) => sum + group.tokens, 0);
    const seconds = groups.reduce((sum, group) =>
      sum + (group.tokens && group.rate ? group.tokens / group.rate : 0), 0);
    return { tokens, tps: seconds ? rounded(tokens / seconds) : 0, rounds: groups.length };
  }
  const prefill = summarize(groupsFor('prefill', 'prefillDone', 'prefillTps'));
  const decode = summarize(groupsFor('generating', 'generated', 'genTps'));
  return {
    prefillTokens: prefill.tokens,
    prefillTps: prefill.tps,
    generatedTokens: decode.tokens,
    decodeTps: decode.tps,
    modelRounds: decode.rounds,
    endingContextTokens: Number(statuses.at(-1)?.ctxUsed) || 0,
  };
}

async function waitForGraph(baseUrl, graphId, timeoutMs, runArtifacts) {
  const q = `graphId=${encodeURIComponent(graphId)}&workspace=${encodeURIComponent(workspace)}`;
  const deadline = Date.now() + timeoutMs;
  const approved = new Set();
  const approvals = [];
  let last = null;
  while (Date.now() < deadline) {
    last = await jsonFetch(baseUrl, `/api/task-graph?${q}`, { timeoutMs: 10_000 });
    writeArtifact(runArtifacts, 'graph-live.json', last);
    if (last.graph?.state === 'waiting_approval') {
      const node = last.graph.nodes.find((item) => item.state === 'waiting_approval');
      if (node && !approved.has(node.id)) {
        approved.add(node.id);
        const before = performance.now();
        last = await jsonFetch(baseUrl, '/api/task-graph/node/approve', {
          method: 'POST', headers: csrfHeaders,
          body: JSON.stringify({
            graphId, workspace, nodeId: node.id,
            expectedRevision: last.graph.revision,
            expectedLastEventSeq: last.graph.lastEventSeq,
          }),
          timeoutMs: 30_000,
        });
        approvals.push({ nodeId: node.id, apiRoundTripMs: rounded(performance.now() - before) });
        writeArtifact(runArtifacts, `approval-${node.id}.json`, last);
        continue;
      }
    }
    if (['succeeded', 'failed', 'cancelled', 'corrupt'].includes(last.graph?.state)) {
      return { completed: last, approvals };
    }
    await sleep(200);
  }
  throw new Error(`Task Graph timed out: ${JSON.stringify(last)}`);
}

const server = await startDStudio({
  binaryArg: process.argv[2], label: 'dstudio-task-graph-ssd-real', isolatedEnginePort: true,
});
const benchmarkStartedAt = performance.now();

try {
  const gguf = selectModel(server.ggufs);
  assert.ok(gguf, 'No supported local GGUF found');
  const launch = {
    mode: 'agent', model: 'standard', variant: 'flash', gguf: gguf.file,
    port: server.enginePort,
    ctx: Number(process.env.DSTUDIO_TASK_GRAPH_CTX || 16384),
    power: Number(process.env.DSTUDIO_TASK_GRAPH_POWER || 70),
    think: process.env.DSTUDIO_TASK_GRAPH_THINK || 'off',
    ssdStreaming: 'on', workdir: workspace,
  };
  writeArtifact(artifacts, 'launch.json', launch);
  const startupStartedAt = performance.now();
  const startup = await startMode(server.baseUrl, launch,
    Number(process.env.DSTUDIO_TASK_GRAPH_START_TIMEOUT_MS || 1_800_000));
  const startupMs = rounded(performance.now() - startupStartedAt);
  writeArtifact(artifacts, 'startup.json', startup);
  assert.equal(startup.mode, 'agent');
  assert.equal(startup.config?.ssdStreaming, 'on');
  assert.equal(startup.config?.ssdStreamingEffective, true,
    `SSD streaming was not effective: ${startup.config?.ssdStreamingReason || 'unknown'}`);

  const runs = [];
  for (let iteration = 1; iteration <= runCount; iteration++) {
    const runArtifacts = path.join(artifacts, `run-${iteration}`);
    fs.mkdirSync(runArtifacts, { recursive: true });
    const hostFile = `native-host-${iteration}.txt`;
    const processFile = `native-process-${iteration}.txt`;
    const expectedReply = `TASK_GRAPH_SSD_OK_${iteration}`;
    const definition = {
      schemaVersion: 1, policy: 'agent.general.v1', mode: 'agent', executorMode: 'native',
      goal: `Benchmark native Task Graph iteration ${iteration}`, workspace,
      limits: { maxParallelHostNodes: 2, maxParallelLlmNodes: 1, maxAttemptsPerNode: 2 },
      nodes: [
        {
          id: 'agent_read', kind: 'agent_turn', title: 'Read marker with the real Agent',
          mutation: 'read_only', capabilities: ['filesystem.read'], timeoutMs: 900_000,
          action: { name: 'agent.prompt', text: `Use the read tool exactly once to read README.md. Do not edit any file. Then reply with exactly: ${expectedReply}` },
        },
        {
          id: 'source_gate', kind: 'gate', title: 'Verify source marker', dependsOn: ['agent_read'],
          mutation: 'read_only', capabilities: ['filesystem.read'],
          action: { name: 'workspace.assert', path: 'README.md', contains: 'TASK_GRAPH_SOURCE_OK' },
        },
        {
          id: 'approval', kind: 'approval', title: 'Approve native mutations',
          dependsOn: ['source_gate'], action: { name: 'approval.wait' },
        },
        {
          id: 'host_write', kind: 'host_tool', title: 'Native host write',
          dependsOn: ['approval'], mutation: 'workspace_write', capabilities: ['filesystem.write'],
          outputs: [{ name: 'host-output', path: hostFile, required: true, minimumBytes: 8 }],
          action: { name: 'workspace.write', path: hostFile, text: 'HOST_OK\n' },
        },
        {
          id: 'host_gate', kind: 'gate', title: 'Verify declared host output',
          dependsOn: ['host_write'], capabilities: ['filesystem.read'],
          action: { name: 'outputs.verify' },
        },
        {
          id: 'test_process', kind: 'host_tool', title: 'Run native argv process',
          dependsOn: ['host_gate'], mutation: 'workspace_write', capabilities: ['test.run'],
          action: { name: 'test.run', argv: ['python3', '-c', `open('${processFile}','w').write('PROCESS_OK\\n')`] },
        },
        {
          id: 'process_gate', kind: 'gate', title: 'Verify process output',
          dependsOn: ['test_process'], capabilities: ['filesystem.read'],
          action: { name: 'workspace.assert', path: processFile, contains: 'PROCESS_OK' },
        },
        {
          id: 'join', kind: 'join', title: 'Complete benchmark', dependsOn: ['process_gate'],
          action: { name: 'join.all' },
        },
      ],
    };
    writeArtifact(runArtifacts, 'graph-definition.json', definition);
    const observedStartedAt = performance.now();
    const validationStartedAt = performance.now();
    const validated = await jsonFetch(server.baseUrl, '/api/task-graph/validate', {
      method: 'POST', headers: csrfHeaders, body: JSON.stringify(definition), timeoutMs: 30_000,
    });
    const validationMs = rounded(performance.now() - validationStartedAt);
    assert.equal(validated.executionAvailable, true);
    const createStartedAt = performance.now();
    const created = await jsonFetch(server.baseUrl, '/api/task-graph/create', {
      method: 'POST', headers: csrfHeaders, body: JSON.stringify(definition), timeoutMs: 30_000,
    });
    const createMs = rounded(performance.now() - createStartedAt);
    writeArtifact(runArtifacts, 'graph-created.json', created);
    const ready = created.graph;
    assert.equal(ready.state, 'ready');
    const startStartedAt = performance.now();
    const started = await jsonFetch(server.baseUrl, '/api/task-graph/start', {
      method: 'POST', headers: csrfHeaders,
      body: JSON.stringify({ graphId: ready.graphId, workspace,
        expectedRevision: ready.revision, expectedLastEventSeq: ready.lastEventSeq }),
      timeoutMs: 30_000,
    });
    const startApiMs = rounded(performance.now() - startStartedAt);
    writeArtifact(runArtifacts, 'graph-started.json', started);
    const { completed, approvals } = await waitForGraph(server.baseUrl, ready.graphId,
      Number(process.env.DSTUDIO_TASK_GRAPH_TURN_TIMEOUT_MS || 1_200_000), runArtifacts);
    const harnessObservedMs = rounded(performance.now() - observedStartedAt);
    writeArtifact(runArtifacts, 'graph-completed.json', completed);
    assert.equal(completed.graph.state, 'succeeded', `Task Graph failed: ${JSON.stringify(completed.graph)}`);
    assert.ok(completed.graph.nodes.every((node) => node.state === 'succeeded'));
    assert.equal(fs.readFileSync(path.join(workspace, hostFile), 'utf8'), 'HOST_OK\n');
    assert.equal(fs.readFileSync(path.join(workspace, processFile), 'utf8'), 'PROCESS_OK\n');
    const agent = completed.graph.nodes.find((node) => node.id === 'agent_read');
    assert.equal(agent.watchdog.tripped, false);
    assert.ok(agent.watchdog.toolCalls >= 1, 'real Agent did not emit a structured tool call');

    const graphDir = path.join(workspace, '.dstudio', 'task-graphs', ready.graphId);
    let receiptCount = 0;
    for (const node of completed.graph.nodes) {
      const attemptId = `${node.id}_a1`;
      const attemptDir = path.join(graphDir, 'attempts', node.id);
      for (const suffix of ['request', 'policy', 'checkpoint', 'result']) {
        const receipt = path.join(attemptDir, `${attemptId}.${suffix}.json`);
        assert.equal(fs.existsSync(receipt), true, `missing durable ${suffix} receipt for ${node.id}`);
        const parsed = JSON.parse(fs.readFileSync(receipt, 'utf8'));
        if (suffix === 'policy') assert.equal(parsed.decision, 'allow', `policy denied ${node.id}`);
        if (suffix === 'result') assert.equal(parsed.ok, true, `result receipt failed ${node.id}`);
        receiptCount++;
      }
    }
    const approvalReceipt = path.join(graphDir, 'attempts', 'approval', 'approval_a1.approval.json');
    assert.equal(fs.existsSync(approvalReceipt), true, 'missing immutable approval receipt');
    assert.equal(JSON.parse(fs.readFileSync(approvalReceipt, 'utf8')).approved, true);
    receiptCount++;
    const transcriptPath = path.join(graphDir, 'attempts', 'agent_read', 'agent_read_a1.transcript.json');
    assert.equal(fs.existsSync(transcriptPath), true, 'missing durable Agent transcript receipt');
    receiptCount++;
    const transcript = fs.readFileSync(transcriptPath, 'utf8');
    const toolResultAt = transcript.lastIndexOf('"type":"tool_result"');
    assert.ok(toolResultAt >= 0, 'Agent transcript has no structured tool result');
    assert.ok(transcript.lastIndexOf(expectedReply) > toolResultAt,
      'expected Agent answer was not emitted after the tool result');
    const processStream = path.join(graphDir, 'attempts', 'test_process', 'test_process_a1.stream.json');
    assert.equal(fs.existsSync(processStream), true, 'missing native process stream receipt');
    receiptCount++;
    const events = await jsonFetch(server.baseUrl,
      `/api/task-graph/events?graphId=${encodeURIComponent(ready.graphId)}&workspace=${encodeURIComponent(workspace)}&since=0`,
      { timeoutMs: 30_000 });
    writeArtifact(runArtifacts, 'events.json', events);
    assert.equal(events.events.at(-1)?.type, 'graph.succeeded');

    const nodeDurationsMs = {};
    for (const node of completed.graph.nodes) {
      nodeDurationsMs[node.id] = eventDuration(events.events, 'attempt.started',
        node.id === 'approval' ? 'node.approved' : 'attempt.succeeded', node.id);
    }
    const graphMs = eventDuration(events.events, 'graph.started', 'graph.succeeded');
    const summedNodeMs = Object.values(nodeDurationsMs).reduce((sum, value) => sum + value, 0);
    const run = {
      iteration,
      ok: true,
      graphId: ready.graphId,
      policyDigest: completed.graph.policyDigest,
      validationMs,
      createMs,
      startApiMs,
      harnessObservedMs,
      graphMs,
      agentMs: nodeDurationsMs.agent_read,
      nonAgentNodesMs: summedNodeMs - nodeDurationsMs.agent_read,
      orchestrationGapMs: graphMs - summedNodeMs,
      nodeDurationsMs,
      agentRuntime: transcriptMetrics(transcript),
      approvalApiRoundTripMs: approvals[0]?.apiRoundTripMs || 0,
      watchdog: agent.watchdog,
      eventCount: events.events.length,
      receiptCount,
      nodesSucceeded: completed.graph.nodes.length,
    };
    runs.push(run);
    writeArtifact(runArtifacts, 'result.json', run);
    console.log(`task_graph_ssd_real: run ${iteration}/${runCount} ok · graph ${graphMs}ms · Agent ${run.agentMs}ms`);
  }

  const result = {
    schemaVersion: 2,
    ok: true,
    measuredAt: new Date().toISOString(),
    dstudio: revisionInfo(process.cwd()),
    ds4: revisionInfo(server.ds4Dir),
    hardware: hardwareInfo(),
    model: gguf.file,
    modelBytes: gguf.size,
    configuration: {
      contextTokens: launch.ctx,
      power: launch.power,
      thinking: launch.think,
      ssdStreaming: startup.config?.ssdStreaming,
      ssdStreamingEffective: startup.config?.ssdStreamingEffective,
      ssdStreamingReason: startup.config?.ssdStreamingReason,
      runCount,
      execution: 'sequential graphs in one native ds4-agent-jsonl session',
    },
    startupMs,
    aggregate: {
      successRate: runs.filter((run) => run.ok).length / runs.length,
      graphMs: aggregate(runs.map((run) => run.graphMs)),
      agentMs: aggregate(runs.map((run) => run.agentMs)),
      nonAgentNodesMs: aggregate(runs.map((run) => run.nonAgentNodesMs)),
      orchestrationGapMs: aggregate(runs.map((run) => run.orchestrationGapMs)),
      validationMs: aggregate(runs.map((run) => run.validationMs)),
      createMs: aggregate(runs.map((run) => run.createMs)),
      startApiMs: aggregate(runs.map((run) => run.startApiMs)),
      decodeTps: aggregate(runs.map((run) => run.agentRuntime.decodeTps)),
      prefillTps: aggregate(runs.map((run) => run.agentRuntime.prefillTps)),
      toolCalls: runs.reduce((sum, run) => sum + run.watchdog.toolCalls, 0),
      watchdogTrips: runs.filter((run) => run.watchdog.tripped).length,
      nodesSucceeded: runs.reduce((sum, run) => sum + run.nodesSucceeded, 0),
      durableReceipts: runs.reduce((sum, run) => sum + run.receiptCount, 0),
    },
    runs,
    wallClockMs: rounded(performance.now() - benchmarkStartedAt),
  };
  writeArtifact(artifacts, 'result.json', result);
  console.log(`task_graph_ssd_real: ${runCount}/${runCount} passed · median graph ${result.aggregate.graphMs.median}ms · ${gguf.file}`);
} catch (error) {
  writeArtifact(artifacts, 'failure.txt', `${error?.stack || error}\n\n${safeReadTail(server.logPath)}`);
  throw error;
} finally {
  await server.stop();
}

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createReliabilityFixture, RELIABILITY_FIXTURE_ID, RELIABILITY_SUITE_SIZE,
  RELIABILITY_TASK_TYPES,
} from './reliability-fixture.mjs';
import { harnessOrder, selectHarnesses, startModelPinProxy } from './cli-competitor-harness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(fs.readFileSync(path.join(here, 'manifest.json'), 'utf8'));
const required = ['simple-direct','coding-multistage','research-code','multimodal-ui','gsa','rsa','media','crash-recovery','interrupt','workspace-collision'];
if (manifest.schemaVersion !== 1) throw new Error('Task Graph benchmark schemaVersion must be 1');
if (manifest.execution !== 'explicit-heavy') throw new Error('heavy Task Graph execution must remain explicit');
if (manifest.realSmoke !== 'run-heavy.mjs' || !fs.existsSync(path.join(here, manifest.realSmoke)))
  throw new Error('real SSD-streaming smoke runner is missing');
const heavyRunner = fs.readFileSync(path.join(here, manifest.realSmoke), 'utf8');
if (!heavyRunner.includes("process.env.RUN_HEAVY !== '1'") || !heavyRunner.includes("ssdStreaming: 'on'"))
  throw new Error('real smoke must require RUN_HEAVY=1 and force SSD streaming on');
for (const action of ['agent.prompt', 'approval.wait', 'workspace.write', 'outputs.verify', 'test.run', 'workspace.assert', 'join.all']) {
  if (!heavyRunner.includes(`name: '${action}'`)) throw new Error(`real benchmark does not exercise ${action}`);
}
if (!heavyRunner.includes('DSTUDIO_TASK_GRAPH_BENCH_RUNS') ||
    !heavyRunner.includes("lastIndexOf(expectedReply) > toolResultAt"))
  throw new Error('real benchmark must support repeated runs and prove the Agent answer follows its tool result');
if (manifest.reliabilityBenchmark !== 'run-reliability.mjs' ||
    !fs.existsSync(path.join(here, manifest.reliabilityBenchmark)))
  throw new Error('real A/B reliability benchmark runner is missing');
const reliabilityRunner = fs.readFileSync(path.join(here, manifest.reliabilityBenchmark), 'utf8');
if (!reliabilityRunner.includes("ssdStreaming: 'off'") ||
    !reliabilityRunner.includes('DSTUDIO_RELIABILITY_CASES || 50') ||
    !reliabilityRunner.includes('hostCrashRecovery') ||
    !reliabilityRunner.includes("orchestration: 'native'") ||
    !reliabilityRunner.includes("orchestration: 'task-graph'") ||
    !reliabilityRunner.includes('graphSuccesses >= directSuccesses'))
  throw new Error('reliability benchmark must run 50 matched cases, disable SSD streaming and inject recovery faults');

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dstudio-reliability-fixture-'));
try {
  const fixture = createReliabilityFixture({
    workspace: fixtureRoot,
    caseCount: RELIABILITY_SUITE_SIZE,
    variants: ['native-agent', 'task-graph', 'pi', 'opencode', 'codex'],
  });
  if (fixture.metadata.id !== RELIABILITY_FIXTURE_ID || RELIABILITY_SUITE_SIZE !== 50 ||
      RELIABILITY_TASK_TYPES.length !== 10 || fixture.scenarios.length !== 50 ||
      new Set(fixture.scenarios.map((scenario) => scenario.id)).size !== 50)
    throw new Error('diverse reliability fixture must contain 50 unique cases across 10 families');
  for (const template of RELIABILITY_TASK_TYPES) {
    const matching = fixture.scenarios.filter((scenario) => scenario.templateId === template.id);
    if (matching.length !== 5) throw new Error(`reliability family ${template.id} must contain five cases`);
  }
  for (const variant of ['native-agent', 'task-graph', 'pi', 'opencode', 'codex']) {
    const prompts = fixture.scenarios.map((scenario) => scenario.variants[variant].prompt);
    if (new Set(prompts).size !== 50) throw new Error(`${variant} reliability prompts are not unique`);
    for (const scenario of fixture.scenarios) {
      const task = scenario.variants[variant];
      if ((task.answerMustContain || []).some((answer) => task.prompt.includes(answer)))
        throw new Error(`${variant} prompt leaks the hidden answer for ${scenario.id}`);
      const baseline = task.score();
      const shouldInitiallyPass = ['read', 'reason'].includes(
        RELIABILITY_TASK_TYPES.find((item) => item.id === scenario.templateId)?.dimension);
      if (Boolean(baseline.ok) !== shouldInitiallyPass)
        throw new Error(`${variant} scorer has an invalid baseline for ${scenario.id}`);
    }
  }
} finally {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
}
for (const file of [manifest.reliabilityPublisher, manifest.reliabilityPublicationResult,
  manifest.reliabilityPlotter]) {
  if (!file || !fs.existsSync(path.resolve(here, file)))
    throw new Error(`missing published reliability artifact ${file}`);
}
for (const file of [manifest.cliCompetitorBenchmark, manifest.cliCompetitorPublisher,
  manifest.cliCompetitorPublicationResult, manifest.cliCompetitorPlotter]) {
  if (!file || !fs.existsSync(path.resolve(here, file)))
    throw new Error(`missing Pi/OpenCode benchmark artifact ${file}`);
}
const cliRunner = fs.readFileSync(path.resolve(here, manifest.cliCompetitorBenchmark), 'utf8');
if (!cliRunner.includes("ssdStreaming: 'off'") ||
    !cliRunner.includes('DSTUDIO_RELIABILITY_CASES || 50') ||
    !cliRunner.includes('DSTUDIO_COMPETITOR_MAX_OUTPUT_TOKENS || 1024'))
  throw new Error('Pi/OpenCode benchmark must run 50 matched cases against the pinned local no-SSD model');

// The competitor runner's harness selection, order and model pin, by running them.
const same = (actual, expected) => JSON.stringify(actual) === JSON.stringify(expected);
if (!same(selectHarnesses(''), ['pi', 'opencode', 'codex']) ||
    !same(selectHarnesses(' Codex , pi '), ['pi', 'codex']) ||
    !same(selectHarnesses('pi,opencode'), ['pi', 'opencode']))
  throw new Error('competitor harness selection must default to Pi, OpenCode and Codex and accept a subset');
let unknownHarnessRefused = false;
try { selectHarnesses('pi,other'); } catch { unknownHarnessRefused = true; }
if (!unknownHarnessRefused) throw new Error('an unknown competitor harness must be refused');
for (let index = 0; index < 50; index++) {
  if (!same(harnessOrder(index, ['pi', 'opencode']), index % 2 === 0 ? ['pi', 'opencode'] : ['opencode', 'pi']))
    throw new Error('a Pi/OpenCode run must alternate as the published two-harness run did');
}
if (!same(harnessOrder(0, ['codex']), ['codex']) ||
    !same([0, 1, 2, 3].map((index) => harnessOrder(index, ['opencode', 'codex'])[0]), ['opencode', 'codex', 'opencode', 'codex']))
  throw new Error('one harness runs alone and any two alternate');
for (let block = 0; block < 48; block += 6) {
  const orders = [0, 1, 2, 3, 4, 5].map((offset) => harnessOrder(block + offset, ['pi', 'opencode', 'codex']));
  for (const harness of ['pi', 'opencode', 'codex']) {
    for (const position of [0, 1, 2]) {
      if (orders.filter((order) => order.length === 3 && order[position] === harness).length !== 2)
        throw new Error(`three harnesses are not counterbalanced: ${harness} at position ${position}`);
    }
    for (const other of ['pi', 'opencode', 'codex'].filter((item) => item !== harness)) {
      if (orders.filter((order) => order.indexOf(harness) < order.indexOf(other)).length !== 3)
        throw new Error(`three harnesses are not counterbalanced: ${harness} before ${other}`);
    }
  }
}
{
  const forwarded = [];
  const engine = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      forwarded.push({ url: request.url, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
      response.writeHead(200, { 'Content-Type': 'application/json' }).end('{}');
    });
  });
  await new Promise((resolve) => engine.listen(0, '127.0.0.1', resolve));
  const proxy = await startModelPinProxy(engine.address().port, { responsesMaxOutputTokens: 1024 });
  try {
    const post = async (url, body) => (await fetch(`${proxy.baseUrl}${url}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })).status;
    proxy.begin('pin');
    const statuses = [
      await post('/v1/chat/completions', { model: 'other', messages: [] }),
      await post('/v1/responses', { model: 'other', input: [] }),
      await post('/v1/chat/completions', { model: 'ds4', messages: [], reasoning_effort: 'high' }),
      await post('/v1/responses', { model: 'ds4', input: [], reasoning: { effort: 'high', summary: 'auto' } }),
    ];
    const observed = proxy.end('pin');
    if (!same(statuses, [400, 400, 200, 200]) ||
        !same(observed.map((request) => request.model), ['other', 'other', 'ds4', 'ds4']) ||
        !same(forwarded, [
          { url: '/v1/chat/completions', body: { model: 'ds4', messages: [], think: false } },
          { url: '/v1/responses', body: { model: 'ds4', input: [], reasoning: { effort: 'none', summary: 'auto' }, max_output_tokens: 1024 } },
        ]))
      throw new Error(`the competitor proxy must forward only ds4 requests with thinking off: ${JSON.stringify({ statuses, forwarded })}`);
  } finally {
    await proxy.close();
    await new Promise((resolve) => engine.close(resolve));
  }
}
for (const file of [manifest.publicationResult, manifest.plotter, ...(manifest.figures || [])]) {
  if (!file || !fs.existsSync(path.resolve(here, file))) throw new Error(`missing published benchmark artifact ${file}`);
}
for (const figure of manifest.figures || []) {
  const png = fs.readFileSync(path.resolve(here, figure));
  if (png.length < 10_000 || !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    throw new Error(`published benchmark figure is not a rendered PNG: ${figure}`);
}
const published = JSON.parse(fs.readFileSync(path.resolve(here, manifest.publicationResult), 'utf8'));
if (published.nativeTaskGraph?.graphsSucceeded !== 3 ||
    published.nativeTaskGraph?.nodesSucceeded !== 24 ||
    published.nativeTaskGraph?.watchdogTrips !== 0 ||
    published.model?.ssdStreamingEffective !== true)
  throw new Error('published native Task Graph result is incomplete or failed');
const reliability = JSON.parse(fs.readFileSync(path.resolve(here, manifest.reliabilityPublicationResult), 'utf8'));
if (reliability.benchmark !== 'native-agent-vs-task-graph-diverse-reliability' ||
    reliability.fixture?.id !== RELIABILITY_FIXTURE_ID ||
    reliability.fixture?.taskTypes?.length !== 10 ||
    reliability.comparison?.nativeAgent?.tasksRun !== 50 ||
    reliability.comparison?.taskGraph?.tasksRun !== 50 ||
    reliability.comparison?.taskGraph?.tasksCompleted < reliability.comparison?.nativeAgent?.tasksCompleted ||
    reliability.comparison?.taskGraph?.graphsCompletedWithoutTaskSuccess !== 0 ||
    reliability.comparison?.taskGraph?.incorrectCompletionClaims !== 0 ||
    reliability.comparison?.paired?.nativeAgentOnly !== 0 ||
    reliability.model?.ssdStreamingEffective !== false ||
    reliability.model?.fullModelReady !== true ||
    reliability.runs?.nativeAgent?.length !== 50 ||
    reliability.runs?.taskGraph?.length !== 50)
  throw new Error('published 50-case no-SSD reliability result is incomplete');
if (!reliability.injectedChecks?.invalidPath?.preventedBeforeExecution ||
    reliability.injectedChecks?.corruptedOutput?.downstreamJoinRan ||
    !reliability.injectedChecks?.conflictingUndo?.refused ||
    !reliability.injectedChecks?.antiLoop?.watchdogThresholdTestPassed ||
    !reliability.injectedChecks?.hostCrashRecovery?.recoveredWithoutModelReload)
  throw new Error('published reliability checks are incomplete');
const competitors = JSON.parse(fs.readFileSync(path.resolve(here, manifest.cliCompetitorPublicationResult), 'utf8'));
if (competitors.benchmark !== 'dstudio-agent-harness-comparison' ||
    competitors.fixture?.id !== RELIABILITY_FIXTURE_ID ||
    competitors.fixture?.taskTypes?.length !== 10 ||
    competitors.comparison?.nativeAgent?.tasksRun !== 50 ||
    competitors.comparison?.taskGraph?.tasksRun !== 50 ||
    competitors.comparison?.pi?.tasksRun !== 50 ||
    competitors.comparison?.opencode?.tasksRun !== 50 ||
    competitors.comparison?.taskGraph?.tasksCompleted < competitors.comparison?.nativeAgent?.tasksCompleted ||
    competitors.comparison?.pi?.modelPinFailures !== 0 ||
    competitors.comparison?.opencode?.modelPinFailures !== 0 ||
    competitors.localModelVerification?.enforcedProxy !== true ||
    competitors.localModelVerification?.piPreflightPassed !== true ||
    competitors.localModelVerification?.openCodePreflightPassed !== true ||
    competitors.model?.ssdStreamingEffective !== false ||
    competitors.runs?.pi?.length !== 50 || competitors.runs?.opencode?.length !== 50)
  throw new Error('published Pi/OpenCode 50-case comparison is incomplete');
for (const taskType of RELIABILITY_TASK_TYPES) {
  for (const result of [reliability.comparison.nativeAgent, reliability.comparison.taskGraph,
    competitors.comparison.pi, competitors.comparison.opencode]) {
    if (result.byTask?.[taskType.id]?.runs !== 5)
      throw new Error(`published result is not balanced for ${taskType.id}`);
  }
}
for (const id of required) if (!manifest.scenarios.some((s) => s.id === id)) throw new Error(`missing benchmark scenario ${id}`);
for (const scenario of manifest.scenarios) {
  if (!scenario.fixture || !Array.isArray(scenario.metrics) || !scenario.metrics.includes('wallClockMs') || !scenario.metrics.includes('taskSuccess'))
    throw new Error(`invalid benchmark scenario ${scenario.id}`);
  const fixturePath = path.join(here, scenario.fixture);
  if (!fs.existsSync(fixturePath)) throw new Error(`missing fixture file ${scenario.fixture}`);
  const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  if (fixture.schemaVersion !== 1 || fixture.id !== scenario.id || !Array.isArray(fixture.acceptance) || !fixture.acceptance.length)
    throw new Error(`invalid fixture ${scenario.fixture}`);
}
console.log(`task_graph_bench_validate: ${manifest.scenarios.length} scenarios; diverse 50-case Native/checked and Pi/OpenCode publications verified; competitor harness order and model pin exercised`);

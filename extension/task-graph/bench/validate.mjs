import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
for (const file of [manifest.reliabilityPublisher, manifest.reliabilityPublicationResult,
  manifest.reliabilityPlotter]) {
  if (!file || !fs.existsSync(path.resolve(here, file)))
    throw new Error(`missing published reliability artifact ${file}`);
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
if (reliability.comparison?.nativeAgent?.tasksRun !== 50 ||
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
console.log(`task_graph_bench_validate: ${manifest.scenarios.length} scenarios; SSD and 50-case no-SSD publications verified`);

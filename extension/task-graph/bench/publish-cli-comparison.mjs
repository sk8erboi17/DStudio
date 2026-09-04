import fs from 'node:fs';
import path from 'node:path';

const competitorInput = process.argv[2];
const baselineInput = process.argv[3];
const output = process.argv[4];
if (!competitorInput || !baselineInput || !output) {
  console.error('usage: node publish-cli-comparison.mjs <competitor-raw.json> <native-task-graph-public.json> <output.json>');
  process.exit(2);
}

const raw = JSON.parse(fs.readFileSync(path.resolve(competitorInput), 'utf8'));
const baseline = JSON.parse(fs.readFileSync(path.resolve(baselineInput), 'utf8'));
if (raw.ok !== true) throw new Error('refusing to publish a competitor run with a broken protocol');
if (baseline.benchmark !== 'native-agent-vs-task-graph-reliability')
  throw new Error('unexpected Native Agent / Task Graph baseline');

const piRuns = raw.comparison.runs?.pi || [];
const openCodeRuns = raw.comparison.runs?.opencode || [];
const nativeRuns = baseline.runs?.nativeAgent || [];
const graphRuns = baseline.runs?.taskGraph || [];
for (const [name, runs] of Object.entries({ nativeAgent: nativeRuns, taskGraph: graphRuns, pi: piRuns, opencode: openCodeRuns })) {
  if (runs.length !== 50) throw new Error(`expected 50 ${name} runs, got ${runs.length}`);
}

if (path.basename(raw.model.file) !== baseline.model.file ||
    raw.model.bytes !== baseline.model.bytes ||
    raw.configuration.contextTokens !== baseline.model.contextTokens ||
    raw.configuration.power !== baseline.model.power ||
    raw.configuration.thinking !== baseline.model.thinking ||
    raw.configuration.ssdStreamingEffective !== baseline.model.ssdStreamingEffective ||
    raw.hardware.chip !== baseline.hardware.chip ||
    raw.hardware.memoryBytes !== baseline.hardware.memoryBytes) {
  throw new Error('competitor run does not match the published model, machine and no-SSD baseline');
}

const taskTypes = [
  { id: 'read-fact', label: 'Read a fact' },
  { id: 'write-file', label: 'Create a file' },
  { id: 'repair-code', label: 'Repair code' },
];

function rounded(value, digits = 2) {
  return Number(Number(value).toFixed(digits));
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function taskType(scenario) {
  return scenario.replace(/-\d+$/, '');
}

function byTask(runs) {
  return Object.fromEntries(taskTypes.map(({ id, label }) => {
    const matching = runs.filter((run) => taskType(run.scenario) === id);
    const completed = matching.filter((run) => run.taskSuccess).length;
    return [id, {
      label,
      runs: matching.length,
      completed,
      completionRatePercent: rounded(completed / matching.length * 100, 1),
    }];
  }));
}

function summarizeCli(runs) {
  const completed = runs.filter((run) => run.taskSuccess).length;
  return {
    tasksCompleted: completed,
    tasksRun: runs.length,
    completionRatePercent: rounded(completed / runs.length * 100, 1),
    medianTaskMs: rounded(median(runs.map((run) => run.wallClockMs))),
    unexpectedModificationRuns: runs.filter((run) => run.unexpectedChanges.length).length,
    incorrectCompletionClaims: runs.filter((run) => run.incorrectCompletionClaim).length,
    processFailures: runs.filter((run) => run.process.exitCode !== 0).length,
    modelPinFailures: runs.filter((run) => !run.protocol.modelPinVerified).length,
    byTask: byTask(runs),
  };
}

function pair(firstRuns, secondRuns, firstOnlyKey, secondOnlyKey) {
  return firstRuns.reduce((summary, firstRun, index) => {
    const secondRun = secondRuns[index];
    if (firstRun.taskSuccess && secondRun.taskSuccess) summary.bothCompleted++;
    else if (firstRun.taskSuccess) summary[firstOnlyKey]++;
    else if (secondRun.taskSuccess) summary[secondOnlyKey]++;
    else summary.neitherCompleted++;
    return summary;
  }, { bothCompleted: 0, [firstOnlyKey]: 0, [secondOnlyKey]: 0, neitherCompleted: 0 });
}

function compactCliRun(run) {
  return {
    scenario: run.scenario,
    taskSuccess: run.taskSuccess,
    wallClockMs: run.wallClockMs,
    externalCheckPassed: Boolean(run.externalCheck?.ok),
    changedFiles: run.changedFiles,
    unexpectedChanges: run.unexpectedChanges,
    toolCalls: run.toolStats.calls,
    incorrectCompletionClaim: run.incorrectCompletionClaim,
    exitCode: run.process.exitCode,
    timedOut: run.process.timedOut,
    modelRequests: run.protocol.modelRequests,
    modelPinVerified: run.protocol.modelPinVerified,
  };
}

const nativeAgent = baseline.comparison.nativeAgent;
const taskGraph = baseline.comparison.taskGraph;
const pi = summarizeCli(piRuns);
const opencode = summarizeCli(openCodeRuns);
if (taskGraph.tasksCompleted < nativeAgent.tasksCompleted || baseline.comparison.paired.nativeAgentOnly !== 0)
  throw new Error('published automatic checked Agent baseline regressed below Native Agent');
if (pi.modelPinFailures || opencode.modelPinFailures)
  throw new Error('a competitor did not use the pinned local model');

const published = {
  schemaVersion: 1,
  benchmark: 'dstudio-agent-harness-comparison',
  measuredAt: raw.measuredAt,
  source: {
    nativeTaskGraphMeasuredAt: baseline.measuredAt,
    competitorDStudioBaseCommit: raw.dstudio.commit,
    competitorWorkingTreeIncludedThisChangeSet: true,
    ds4Commit: raw.ds4.commit,
    ds4ManagedRuntimeWorkingTree: raw.ds4.dirty,
  },
  hardware: raw.hardware,
  model: {
    ...baseline.model,
    maxOutputTokensForCliCompetitors: raw.configuration.maxOutputTokens,
  },
  cliVersions: raw.cliVersions,
  comparison: {
    protocol: 'The same 50 read, write and repair fixtures; fresh session per task; independent file/test scoring; full local model; thinking and SSD streaming off.',
    nativeAgent,
    taskGraph,
    pi,
    opencode,
    taskGraphVsPi: pair(graphRuns, piRuns, 'taskGraphOnly', 'piOnly'),
    taskGraphVsOpenCode: pair(graphRuns, openCodeRuns, 'taskGraphOnly', 'openCodeOnly'),
  },
  localModelVerification: {
    enforcedProxy: raw.configuration.localEndpointEnforced,
    acceptedModelId: 'ds4',
    piModelPinFailures: pi.modelPinFailures,
    openCodeModelPinFailures: opencode.modelPinFailures,
    piPreflightPassed: raw.preflight?.pi?.ok === true,
    openCodePreflightPassed: raw.preflight?.opencode?.ok === true,
  },
  humanRecoveryInterventions: 0,
  competitorModelStartupMs: raw.startupMs,
  competitorBenchmarkMs: raw.wallClockMs,
  runs: {
    nativeAgent: nativeRuns,
    taskGraph: graphRuns,
    pi: piRuns.map(compactCliRun),
    opencode: openCodeRuns.map(compactCliRun),
  },
  notes: [
    'A task passed only when a real tool result was followed by the requested completion marker and the independent file or Python check passed.',
    'Pi and OpenCode ran in alternating order against one continuously loaded ds4-server process. A local compatibility proxy rejected every model id except ds4 and forced the declared thinking=off setting.',
    'The Native Agent and automatic checked Agent numbers come from the immediately preceding 50-case publication on the same machine, model file and configuration. DS4 cannot load its large Agent runtime and server runtime simultaneously, so these two phases used separate model loads.',
    'Pi and OpenCode received the same four relevant capabilities: read, write/edit and shell. Plugins, external skills, LSP, formatters, MCPs, sharing and model-catalog updates were disabled.',
    'Each CLI competitor used a 1,024-token maximum per model response. All tasks are deliberately short; the limit bounds verbose or looping turns rather than changing acceptance checks.',
    'OpenCode 1.18.18 required both PWD and --dir to keep absolute tool paths inside the nested benchmark workspace; the runner also creates an isolated Git root and checks changed files externally.',
    'CLI process startup is included in each task time. Reliability is the primary measurement; latency is reported as context, not as the winner criterion.',
    'This is a single-machine sample, not a universal guarantee for other models, prompts, versions or hardware.',
  ],
};

fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
fs.writeFileSync(path.resolve(output), `${JSON.stringify(published, null, 2)}\n`);
console.log(`task_graph_cli_comparison_publish: wrote ${output}`);

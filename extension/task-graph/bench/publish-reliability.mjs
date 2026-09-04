import fs from 'node:fs';
import path from 'node:path';

const input = process.argv[2];
const output = process.argv[3];
if (!input || !output) {
  console.error('usage: node publish-reliability.mjs <raw-result.json> <published-result.json>');
  process.exit(2);
}

const raw = JSON.parse(fs.readFileSync(path.resolve(input), 'utf8'));
if (raw.ok !== true) throw new Error('refusing to publish a failed reliability run');
const nativeRuns = raw.comparison.runs?.nativeAgent || raw.comparison.direct;
const graphRuns = raw.comparison.runs?.taskGraph ||
  (Array.isArray(raw.comparison.taskGraph) ? raw.comparison.taskGraph : []);
if (nativeRuns.length !== 50 || graphRuns.length !== 50)
  throw new Error(`expected 50 matched runs, got ${nativeRuns.length} and ${graphRuns.length}`);

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

function summarize(runs, isGraph) {
  const completed = runs.filter((run) => run.taskSuccess).length;
  return {
    tasksCompleted: completed,
    tasksRun: runs.length,
    completionRatePercent: rounded(completed / runs.length * 100, 1),
    medianTaskMs: rounded(median(runs.map((run) => run.wallClockMs))),
    unexpectedModificationRuns: runs.filter((run) => run.unexpectedChanges.length).length,
    incorrectCompletionClaims: runs.filter((run) => run.incorrectCompletionClaim).length,
    ...(isGraph ? {
      incorrectResultsBlocked: runs.filter((run) => run.incorrectResultBlocked).length,
      graphsCompletedWithoutTaskSuccess: runs.filter((run) => !run.taskSuccess && run.graphState === 'succeeded').length,
      watchdogTrips: runs.filter((run) => run.toolStats.tripped).length,
    } : {}),
    byTask: byTask(runs),
  };
}

const paired = nativeRuns.reduce((summary, nativeRun, index) => {
  const graphRun = graphRuns[index];
  if (nativeRun.taskSuccess && graphRun.taskSuccess) summary.bothCompleted++;
  else if (nativeRun.taskSuccess) summary.nativeAgentOnly++;
  else if (graphRun.taskSuccess) summary.taskGraphOnly++;
  else summary.neitherCompleted++;
  return summary;
}, { bothCompleted: 0, nativeAgentOnly: 0, taskGraphOnly: 0, neitherCompleted: 0 });
if (paired.nativeAgentOnly !== 0)
  throw new Error(`automatic checked Agent regressed on ${paired.nativeAgentOnly} matched task(s)`);

function compactRun(run, isGraph) {
  return {
    scenario: run.scenario,
    taskSuccess: run.taskSuccess,
    wallClockMs: run.wallClockMs,
    externalCheckPassed: Boolean(run.externalCheck?.ok),
    changedFiles: run.changedFiles,
    unexpectedChanges: run.unexpectedChanges,
    toolCalls: Number(isGraph ? run.toolStats.toolCalls : run.toolStats.calls),
    ...(isGraph ? {
      graphState: run.graphState,
      gatesPassed: run.gatesPassed,
      finalJoinRan: run.finalJoinRan,
      incorrectResultBlocked: run.incorrectResultBlocked,
      watchdogTripped: Boolean(run.toolStats.tripped),
    } : {}),
  };
}

const nativeSummary = summarize(nativeRuns, false);
const graphSummary = summarize(graphRuns, true);
if (graphSummary.tasksCompleted < nativeSummary.tasksCompleted)
  throw new Error('automatic checked Agent regressed below Native Agent');
const published = {
  schemaVersion: 1,
  benchmark: 'native-agent-vs-task-graph-reliability',
  measuredAt: raw.measuredAt,
  source: {
    dstudioBaseCommit: raw.dstudio.commit,
    dstudioWorkingTreeIncludedThisChangeSet: true,
    ds4Commit: raw.ds4.commit,
    ds4ManagedRuntimeWorkingTree: raw.ds4.dirty,
  },
  hardware: raw.hardware,
  model: {
    file: path.basename(raw.model.file),
    bytes: raw.model.bytes,
    contextTokens: raw.configuration.contextTokens,
    power: raw.configuration.power,
    thinking: raw.configuration.thinking,
    ssdStreamingRequested: raw.configuration.ssdStreaming,
    ssdStreamingEffective: raw.configuration.ssdStreamingEffective,
    ssdStreamingReason: raw.configuration.ssdStreamingReason,
    fullModelReady: raw.configuration.fullModelReady,
    nativeRuntime: 'ds4-agent-jsonl',
  },
  comparison: {
    protocol: '50 matched tasks; Native Agent versus the automatic correctness-first Agent route; fresh session per variant; one continuously loaded model',
    nativeAgent: nativeSummary,
    taskGraph: graphSummary,
    percentagePointDifference: rounded(graphSummary.completionRatePercent - nativeSummary.completionRatePercent, 1),
    additionalTasksCompleted: graphSummary.tasksCompleted - nativeSummary.tasksCompleted,
    paired,
  },
  injectedChecks: raw.injectedFaults,
  humanRecoveryInterventions: raw.humanRecoveryInterventions,
  modelStartupMs: raw.startupMs,
  totalBenchmarkMs: raw.wallClockMs,
  runs: {
    nativeAgent: nativeRuns.map((run) => compactRun(run, false)),
    taskGraph: graphRuns.map((run) => compactRun(run, true)),
  },
  notes: [
    'The same 50 task fixtures were run once with Native Agent and once through DStudio’s automatic correctness-first route; execution order alternated.',
    'Every variant started with a fresh Agent session while the same full model remained loaded.',
    'A task passed only when the requested tool-backed answer and the independent file or test check both passed.',
    'The automatic route used the same generic graph for every task: native Agent execution, a required tool-backed completion receipt, a deterministic receipt gate and a final join. It was not specialized for a known fixture.',
    'A prose-only stop is not success. Read-only attempts may retry; mutating attempts retry only when the structured transcript proves that no tool call ran.',
    'The crash injection covers durable graph recovery after deterministic work, not continuation of an in-flight model token stream.',
    'This is a single-machine sample, not a universal guarantee for other models, prompts or hardware.',
  ],
};

fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
fs.writeFileSync(path.resolve(output), `${JSON.stringify(published, null, 2)}\n`);
console.log(`task_graph_reliability_publish: wrote ${output}`);

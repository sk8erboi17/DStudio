import fs from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------- six agents, two lanes
// node publish-cli-comparison.mjs --lanes <output.json> <lane-result.json>...
//
// Publishes the result.json files of run-agent-lane.mjs (one per lane and
// case set) for the six agents of PLAN.MD P9. Every row of every plan is
// counted. The rate of a cell is completed / planned attempts, and planned
// keeps failed, inconclusive, harness-error and not-run attempts; BLOCKED and
// NOT_COMPARABLE rows are not attempts: they are counted as such, with their
// reasons, and never enter a rate. Development, held-out and recovery cases
// are separate groups and are never totalled together. Time to a verified
// result is compared only on the (repetition, case) cells that every measured
// agent of the group completed, and says how many cells that leaves.
const LANE_AGENTS = [['upstream-agent', 'Upstream ds4-agent'], ['native-agent', 'DStudio Agent'], ['task-graph', 'DStudio checked'],
  ['pi', 'Pi'], ['opencode', 'OpenCode'], ['codex', 'Codex']];
const LANE_NAMES = [['equivalent', 'Equivalent settings'], ['product', 'Complete product']];
const LANE_GROUPS = [['development', 'Development'], ['held-out', 'Held-out'], ['recovery:single', 'Recovery: one prompt'],
  ['recovery:steering', 'Recovery: steering'], ['recovery:stop-resume', 'Recovery: Stop/resume'], ['recovery:two-sessions', 'Recovery: two sessions']];
const TIMED_GROUPS = ['development', 'held-out'];
const OUTCOMES = ['completed', 'failed', 'inconclusive', 'harness-error', 'not-run', 'blocked', 'not-comparable'];
const NOT_ATTEMPTED = new Set(['blocked', 'not-comparable']);
const laneGroup = (attempt) => (attempt.caseSet === 'recovery' ? `recovery:${attempt.mechanic}` : attempt.caseSet);
const laneRounded = (value, digits = 2) => Number(Number(value).toFixed(digits));
function laneMedian(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function checkLaneResult(result, file) {
  const fail = (message) => { throw new Error(`${file}: ${message}`); };
  if (result.benchmark !== 'dstudio-agent-lane' || result.schemaVersion !== 1) fail('not a run-agent-lane.mjs result');
  if (!LANE_NAMES.some(([lane]) => lane === result.lane)) fail(`unknown lane ${result.lane}`);
  if (!Array.isArray(result.agents) || !result.agents.length || result.agents.some((agent) => !LANE_AGENTS.some(([id]) => id === agent)))
    fail('unknown agents');
  if (!Array.isArray(result.attempts) || result.attempts.length !== result.expectedAttempts)
    fail(`${result.attempts?.length} attempts where the plan has ${result.expectedAttempts}: every row must be published`);
  const ids = new Set();
  for (const attempt of result.attempts) {
    if (ids.has(attempt.attemptId)) fail(`attempt ${attempt.attemptId} appears twice`);
    ids.add(attempt.attemptId);
    if (!OUTCOMES.includes(attempt.outcome)) fail(`attempt ${attempt.attemptId} has unknown outcome ${attempt.outcome}`);
    if (attempt.lane !== result.lane || !result.agents.includes(attempt.variant)) fail(`attempt ${attempt.attemptId} is not of this lane and agents`);
    if (!result.sets.includes(attempt.caseSet)) fail(`attempt ${attempt.attemptId} is of set ${attempt.caseSet}, outside ${result.sets.join(', ')}`);
    if (Boolean(attempt.taskSuccess) !== (attempt.outcome === 'completed')) fail(`attempt ${attempt.attemptId}: outcome and taskSuccess disagree`);
    if (NOT_ATTEMPTED.has(attempt.outcome) && !String(attempt.reason || '').trim()) fail(`attempt ${attempt.attemptId} is ${attempt.outcome} without a reason`);
    if (attempt.outcome === 'completed' && !(Number(attempt.wallClockMs) >= 0)) fail(`attempt ${attempt.attemptId} completed without a time`);
  }
}

function laneCell(attempts) {
  const count = (outcome) => attempts.filter((attempt) => attempt.outcome === outcome).length;
  const cell = {
    attempts: attempts.length, completed: count('completed'), failed: count('failed'), inconclusive: count('inconclusive'),
    harnessError: count('harness-error'), notRun: count('not-run'), blocked: count('blocked'), notComparable: count('not-comparable'),
  };
  cell.planned = cell.completed + cell.failed + cell.inconclusive + cell.harnessError + cell.notRun;
  cell.completionRatePercent = cell.planned ? laneRounded(cell.completed / cell.planned * 100, 1) : null;
  cell.state = cell.planned ? 'measured' : cell.blocked ? 'blocked' : cell.notComparable ? 'not-comparable' : 'absent';
  cell.incorrectCompletionClaims = attempts.filter((attempt) => attempt.incorrectCompletionClaim).length;
  cell.unexpectedModificationAttempts = attempts.filter((attempt) => (attempt.unexpectedChanges || []).length).length;
  cell.reasons = [...new Set(attempts.filter((attempt) => NOT_ATTEMPTED.has(attempt.outcome)).map((attempt) => `${attempt.outcome}: ${attempt.reason}`))];
  return cell;
}

// The (repetition, case) cells of one group that every measured agent
// completed, and each agent's median time over exactly those cells.
function matchedTime(attempts, agents) {
  const key = (attempt) => `${attempt.repetition}|${attempt.scenario}`;
  const measured = agents.filter((agent) => attempts.some((attempt) => attempt.variant === agent && !NOT_ATTEMPTED.has(attempt.outcome)));
  const cells = [...new Set(attempts.map(key))].sort();
  const completed = (agent, cell) => attempts.find((attempt) => attempt.variant === agent && key(attempt) === cell && attempt.outcome === 'completed');
  const matched = measured.length ? cells.filter((cell) => measured.every((agent) => completed(agent, cell))) : [];
  return {
    cells: cells.length,
    matchedCells: matched.length,
    agents: measured,
    excluded: agents.filter((agent) => !measured.includes(agent)),
    medianMs: Object.fromEntries(measured.map((agent) => [agent, matched.length
      ? laneRounded(laneMedian(matched.map((cell) => Number(completed(agent, cell).wallClockMs)))) : null])),
  };
}

function publishLanes(output, files) {
  if (!output || !files.length) {
    console.error('usage: node publish-cli-comparison.mjs --lanes <output.json> <lane-result.json>...');
    process.exit(2);
  }
  const results = files.map((file) => {
    const result = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
    checkLaneResult(result, file);
    return result;
  });
  const synthetic = results.map((result) => result.synthetic || null);
  if (new Set(synthetic.map(Boolean)).size > 1) throw new Error('synthetic and measured lane results cannot be published together');
  const [first] = results;
  for (const result of results.slice(1)) {
    if (result.model?.file !== first.model?.file || result.model?.bytes !== first.model?.bytes)
      throw new Error('lane results of different model files cannot be compared');
    if (result.hardware?.chip !== first.hardware?.chip || result.hardware?.memoryBytes !== first.hardware?.memoryBytes)
      throw new Error('lane results of different machines cannot be compared');
  }
  const seen = new Set();
  for (const result of results) {
    for (const set of result.sets) {
      if (seen.has(`${result.lane}/${set}`)) throw new Error(`two results hold the ${set} cases of the ${result.lane} lane: counting both would count those cases twice`);
      seen.add(`${result.lane}/${set}`);
    }
  }
  const agentIds = LANE_AGENTS.map(([id]) => id);
  const lanes = {};
  for (const [lane, label] of LANE_NAMES) {
    const ofLane = results.filter((result) => result.lane === lane);
    if (!ofLane.length) {
      lanes[lane] = { label, published: false, reason: 'no result of this lane was given' };
      continue;
    }
    const attempts = ofLane.flatMap((result) => result.attempts);
    lanes[lane] = {
      label, published: true,
      complete: ofLane.every((result) => result.ok === true),
      settings: ofLane[0].settings,
      runs: ofLane.map((result) => ({
        set: result.set, sets: result.sets, measuredAt: result.measuredAt, seed: result.seed, repetitions: result.repetitions,
        expectedAttempts: result.expectedAttempts, planSHA256: result.planSHA256, complete: result.ok === true,
      })),
      cells: Object.fromEntries(agentIds.map((agent) => [agent, Object.fromEntries(LANE_GROUPS.map(([group]) =>
        [group, laneCell(attempts.filter((attempt) => attempt.variant === agent && laneGroup(attempt) === group))]))])),
      time: Object.fromEntries(TIMED_GROUPS.map((group) => [group, matchedTime(attempts.filter((attempt) => laneGroup(attempt) === group), agentIds)])),
    };
  }
  const published = {
    schemaVersion: 1,
    benchmark: 'dstudio-agent-lane-comparison',
    synthetic: synthetic[0],
    agents: LANE_AGENTS.map(([id, label]) => ({ id, label })),
    groups: LANE_GROUPS.map(([id, label]) => ({ id, label })),
    model: first.model,
    hardware: first.hardware,
    cliVersions: Object.assign({}, ...results.map((result) => result.cliVersions || {})),
    upstreamAgent: first.upstreamAgent,
    dstudio: first.dstudio,
    lanes,
    definitions: {
      rate: 'completed / planned attempts; planned counts completed, failed, inconclusive, harness-error and not-run attempts',
      blocked: 'a row the runner could not run on this machine or has no proven driver for; not an attempt, never in a rate',
      notComparable: 'a row whose mechanic or lane the agent\'s interface cannot represent; not an attempt, never in a rate',
      time: 'median time from the prompt to the end of a completed attempt, only over the (repetition, case) cells every measured agent of the group completed',
      groups: 'development, held-out and recovery cases are separate groups and are never totalled together',
    },
    limitations: [...new Set(results.flatMap((result) => result.limitations || []))],
  };
  fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
  fs.writeFileSync(path.resolve(output), `${JSON.stringify(published, null, 2)}\n`);
  console.log(`agent_lane_publish: wrote ${output}${published.synthetic ? ` (SYNTHETIC: ${published.synthetic})` : ''}`);
}

if (process.argv[2] === '--lanes') {
  publishLanes(process.argv[3], process.argv.slice(4));
  process.exit(0);
}

const competitorInput = process.argv[2];
const baselineInput = process.argv[3];
const output = process.argv[4];
if (!competitorInput || !baselineInput || !output) {
  console.error('usage: node publish-cli-comparison.mjs <competitor-raw.json> <native-task-graph-public.json> <output.json>\n' +
    '       node publish-cli-comparison.mjs --lanes <output.json> <lane-result.json>...');
  process.exit(2);
}

const raw = JSON.parse(fs.readFileSync(path.resolve(competitorInput), 'utf8'));
const baseline = JSON.parse(fs.readFileSync(path.resolve(baselineInput), 'utf8'));
if (raw.ok !== true) throw new Error('refusing to publish a competitor run with a broken protocol');
if (baseline.benchmark !== 'native-agent-vs-task-graph-diverse-reliability')
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

if (raw.fixture?.id !== baseline.fixture?.id || raw.fixture?.id !== 'diverse-local-agent-v2')
  throw new Error('competitor and DStudio runs do not use the same diverse fixture');
const taskTypes = baseline.fixture.taskTypes || [];
if (taskTypes.length !== 10) throw new Error('expected ten balanced task families');
for (let index = 0; index < 50; index++) {
  const ids = [nativeRuns[index], graphRuns[index], piRuns[index], openCodeRuns[index]]
    .map((run) => run.scenario);
  if (new Set(ids).size !== 1) throw new Error(`unmatched fixture at run ${index + 1}: ${ids.join(', ')}`);
}

function rounded(value, digits = 2) {
  return Number(Number(value).toFixed(digits));
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function byTask(runs) {
  return Object.fromEntries(taskTypes.map(({ id, label }) => {
    const matching = runs.filter((run) => run.taskType === id);
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
  const toolCalls = runs.map((run) => Number(run.toolStats.calls));
  return {
    tasksCompleted: completed,
    tasksRun: runs.length,
    completionRatePercent: rounded(completed / runs.length * 100, 1),
    medianTaskMs: rounded(median(runs.map((run) => run.wallClockMs))),
    totalToolCalls: toolCalls.reduce((total, value) => total + value, 0),
    meanToolCalls: rounded(toolCalls.reduce((total, value) => total + value, 0) / runs.length),
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
    taskType: run.taskType,
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
  fixture: baseline.fixture,
  cliVersions: raw.cliVersions,
  comparison: {
    protocol: 'The same 50 unique fixtures across 10 local-agent task families; fresh session per task; hidden-answer and independent file/test scoring; full local model; thinking and SSD streaming off.',
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
    'A task passed only when a real tool result was followed by the required answer and completion marker, the independent file or Python check passed and no out-of-scope file changed.',
    'The 50 cases contain five distinct fixtures in each of ten task families. Read/search answers are hidden in files and are not leaked by completion markers.',
    'Pi and OpenCode ran in alternating order against one continuously loaded ds4-server process. A local compatibility proxy rejected every model id except ds4 and forced the declared thinking=off setting.',
    'The Native Agent and automatic checked Agent numbers come from the immediately preceding 50-case publication on the same machine, model file and configuration. DS4 cannot load its large Agent runtime and server runtime simultaneously, so these two phases used separate model loads.',
    'Pi and OpenCode received the same four relevant capabilities: read, write/edit and shell. Plugins, external skills, LSP, formatters, MCPs, sharing and model-catalog updates were disabled.',
    'Each CLI competitor used a 1,024-token maximum per model response. All tasks are deliberately short; the limit bounds verbose or looping turns rather than changing acceptance checks.',
    'OpenCode 1.18.18 required both PWD and --dir to keep absolute tool paths inside the nested benchmark workspace; the runner also creates an isolated Git root and checks changed files externally.',
    'CLI process startup is included in each task time. Reliability is the primary measurement; latency is reported as context, not as the winner criterion.',
    'This is a single-machine sample, not a universal guarantee for other models, prompts, versions or hardware.',
    `The suite does not cover: ${baseline.fixture.coverage.excluded.join('; ')}.`,
  ],
};

fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
fs.writeFileSync(path.resolve(output), `${JSON.stringify(published, null, 2)}\n`);
console.log(`task_graph_cli_comparison_publish: wrote ${output}`);

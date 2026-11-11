// The six-agent comparison of PLAN.MD P9, as data and pure functions: which
// agents, which lanes, what each agent's interface can and cannot do, and the
// complete attempt list of a lane (cases x agents x repetitions) with a seeded
// counterbalanced order. Nothing here starts an engine or an agent.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { caseDigest, CASE_SET_FIXTURES, CASE_SETS, listCases, selectCaseSet } from './case-sets.mjs';
import { inspectUpstreamAgent } from './build-upstream-agent.mjs';

export const LANE_PLAN_SCHEMA = 'dstudio.agent-lane.plan.v1';
export const DEFAULT_REPETITIONS = 3;

// `runtime` is the process that owns the model while the agent runs. One
// machine holds one at a time, so a change of runtime between two attempts is
// a model load.
export const LANE_AGENTS = Object.freeze([
  { id: 'upstream-agent', label: 'Upstream ds4-agent', runtime: 'upstream-agent' },
  { id: 'native-agent', label: 'DStudio Agent', runtime: 'dstudio-agent' },
  { id: 'task-graph', label: 'DStudio checked', runtime: 'dstudio-agent' },
  { id: 'pi', label: 'Pi', runtime: 'ds4-server' },
  { id: 'opencode', label: 'OpenCode', runtime: 'ds4-server' },
  { id: 'codex', label: 'Codex', runtime: 'ds4-server' },
]);
export const LANE_AGENT_IDS = Object.freeze(LANE_AGENTS.map((agent) => agent.id));

export const LANE_RUNTIMES = Object.freeze({
  // One ds4-agent process per attempt: it loads the model, runs, exits.
  'upstream-agent': { startsPerAttempt: true, owner: 'the clean upstream ds4-agent process itself' },
  // The host binds the Agent to one working folder when the mode starts, so a
  // new workspace is a new start.
  'dstudio-agent': { startsPerAttempt: true, owner: 'the DStudio host in Agent mode (patched ds4-agent)' },
  // The server does not know the workspace; consecutive CLI attempts share it.
  'ds4-server': { startsPerAttempt: false, owner: 'the DStudio host in server mode (ds4-server behind the model pin proxy)' },
});

const SAME = 'same';
const DIFFERENT = 'declared-difference';
const MISSING = 'not-representable';
const row = (dimension, status, detail) => ({ dimension, status, detail });
const SHARED_ENGINE = [
  row('model', SAME, 'the one GGUF the run selects; the pin proxy refuses any model id but ds4'),
  row('context', SAME, 'the lane context, declared to the CLI and set on the server'),
  row('power', SAME, 'set on the server'),
  row('ssd streaming', SAME, 'off on the server'),
  row('backend', DIFFERENT, 'ds4-server of the installed, DStudio-patched engine checkout'),
  row('cache', DIFFERENT, 'the server keeps its KV state between requests, so an attempt can reuse the prefix a previous attempt of the same CLI left'),
];

// The two lanes of P9 item 3. An agent with a `not-representable` row is not
// comparable in that lane: its attempts stay in the plan as NOT_COMPARABLE.
export const LANES = Object.freeze({
  equivalent: {
    label: 'Equivalent settings',
    settings: {
      contextTokens: 8192, thinking: 'off', maxOutputTokens: 1024, power: 70, ssdStreaming: 'off',
      tools: 'read, write/edit and shell where the harness can restrict them',
      sampling: 'each harness\'s own default; no seed is pinned',
      session: 'a new session in a new workspace for every attempt',
    },
    agents: {
      'upstream-agent': [
        row('model', SAME, '-m'), row('context', SAME, '--ctx'), row('thinking', SAME, '--nothink'),
        row('output limit', SAME, '--tokens'), row('power', SAME, '--power'), row('ssd streaming', SAME, 'not requested'),
        row('tools', DIFFERENT, 'the agent\'s whole native tool set; it has no option to restrict it'),
        row('format', DIFFERENT, 'tool calls parsed in process from model text, plain-text output'),
        row('backend', DIFFERENT, 'engine objects built from the pristine pinned sources, without DStudio\'s engine patches'),
        row('cache', DIFFERENT, 'a new process and an empty home directory per attempt: nothing is reused'),
      ],
      'native-agent': [
        row('model', SAME, 'launch gguf'), row('context', SAME, 'launch ctx'), row('thinking', SAME, 'launch think off'),
        row('output limit', DIFFERENT, 'the patched Agent\'s own default; the launch has no setting for it'),
        row('power', SAME, 'launch power'), row('ssd streaming', SAME, 'launch off, checked in the status'),
        row('tools', DIFFERENT, 'the patched Agent\'s native tool set'),
        row('format', DIFFERENT, 'tool calls parsed in process, structured JSONL events'),
        row('backend', DIFFERENT, 'the installed, DStudio-patched engine checkout'),
        row('cache', DIFFERENT, 'a new Agent start per attempt; its system-prompt KV file may be reused from disk'),
      ],
      'task-graph': [
        row('model', SAME, 'launch gguf'), row('context', SAME, 'launch ctx'), row('thinking', SAME, 'launch think off'),
        row('output limit', DIFFERENT, 'the patched Agent\'s own default'), row('power', SAME, 'launch power'),
        row('ssd streaming', SAME, 'launch off, checked in the status'),
        row('tools', DIFFERENT, 'the patched Agent\'s native tool set, inside a checked graph that may retry a turn'),
        row('format', DIFFERENT, 'tool calls parsed in process, structured JSONL events'),
        row('backend', DIFFERENT, 'the installed, DStudio-patched engine checkout'),
        row('cache', DIFFERENT, 'a new Agent start per attempt; its system-prompt KV file may be reused from disk'),
      ],
      pi: [...SHARED_ENGINE, row('thinking', SAME, 'the proxy sets think:false'), row('output limit', SAME, 'in the CLI configuration'),
        row('tools', SAME, 'read, bash, edit, write'), row('format', DIFFERENT, 'chat-completions tool calls')],
      opencode: [...SHARED_ENGINE, row('thinking', SAME, 'the proxy sets think:false'), row('output limit', SAME, 'in the CLI configuration'),
        row('tools', SAME, 'bash, read, edit, write'), row('format', DIFFERENT, 'chat-completions tool calls')],
      codex: [...SHARED_ENGINE, row('thinking', SAME, 'reasoning effort none, sent by the CLI and enforced by the proxy'),
        row('output limit', SAME, 'added by the proxy; the CLI has no setting'),
        row('tools', DIFFERENT, 'the CLI\'s shell tool only (exec_command, write_stdin), inside its own sandbox'),
        row('format', DIFFERENT, 'Responses function calls on /v1/responses')],
    },
  },
  product: {
    label: 'Complete product',
    settings: {
      contextTokens: null, thinking: null, maxOutputTokens: null, power: null, ssdStreaming: null,
      tools: 'each product\'s own', sampling: 'each product\'s own', session: 'a new session in a new workspace for every attempt',
    },
    // Nobody has frozen what "the complete product" is for any of the six:
    // which context, thinking level, tools and features each one gets on an
    // offline machine with this model. Until that is written down here and the
    // runner applies it, every product-lane attempt is BLOCKED, not run with
    // the equivalent-lane settings under another name.
    agents: Object.fromEntries(LANE_AGENTS.map((agent) => [agent.id, [row('configuration', MISSING,
      `the complete-product configuration of ${agent.label} (context, thinking, output limit, tools and features available offline) is not frozen, and the runner applies only the equivalent-lane settings`)]])),
  },
});

const yes = (how, proof) => ({ status: 'supported', how, proof });
const no = (reason) => ({ status: 'not-comparable', reason });
const blocked = (reason) => ({ status: 'blocked', reason });
// `proof` says what has exercised the driver. No scripted test of the lane's
// recovery drivers exists yet; a driver that depends on an interface
// behaviour nobody has observed is `blocked` until one does.
const CODEX_ONE_SHOT = 'this command line and grading run the installed CLI on three fixture tasks in make test-codex-protocol (scripted engine)';
const NOT_EXERCISED = 'not exercised: no model run and no scripted lane test yet';
const ONE_SHOT = 'one prompt in one non-interactive invocation';
const FRESH_PAIR = 'two non-interactive invocations that share only the workspace';

// What the runner can do with each agent's interface for each mechanic of the
// recovery cases (recovery-fixture.mjs). `not-comparable` is a limit of the
// interface the benchmark drives; `blocked` is missing or unproven runner work.
export const MECHANIC_SUPPORT = Object.freeze({
  'upstream-agent': {
    single: yes('ds4-agent --non-interactive -p PROMPT', NOT_EXERCISED),
    'two-sessions': yes('two ds4-agent processes', NOT_EXERCISED),
    steering: blocked('a driver exists (ds4-agent --non-interactive reading prompts from stdin, input sent during a turn acknowledged by +DWARFSTAR_QUEUED and appended after the current tool round, as read in the pinned ds4_agent.c), but neither a scripted stand-in nor the real binary has exercised it'),
    'stop-resume': no('the pinned ds4_agent.c saves and reopens a session only from its interactive loop (/save, /switch); a stopped non-interactive process leaves nothing to resume'),
  },
  'native-agent': {
    single: yes('POST /api/agent/send with orchestration native', NOT_EXERCISED),
    'two-sessions': yes('a new Agent session between the two prompts', NOT_EXERCISED),
    steering: blocked('the lane runner has no driver for POST /api/agent/steer (the host and runtime sides are covered by make test-steering and test-steering-runtime)'),
    'stop-resume': blocked('the lane runner has no driver for POST /api/agent/interrupt followed by a prompt in the same session'),
  },
  'task-graph': {
    single: yes('POST /api/agent/send with orchestration task-graph, then the graph\'s terminal state', NOT_EXERCISED),
    'two-sessions': yes('one automatic graph per prompt', NOT_EXERCISED),
    steering: blocked('whether POST /api/agent/steer reaches an Agent turn owned by an automatic graph is not established, and the lane runner has no driver for it'),
    'stop-resume': no('a graph-owned turn can be cancelled and its node retried, which starts a new attempt with the original prompt instead of resuming the stopped session; pause lets the running turn finish'),
  },
  pi: {
    single: yes(ONE_SHOT, NOT_EXERCISED),
    'two-sessions': yes(FRESH_PAIR, NOT_EXERCISED),
    steering: blocked('pi accepts input during a turn only in --mode rpc; the lane runner drives --print and has no rpc driver'),
    'stop-resume': blocked('resuming a stored session of pi --print (--session-id, --continue) was not exercised against a scripted engine'),
  },
  opencode: {
    single: yes(ONE_SHOT, NOT_EXERCISED),
    'two-sessions': yes(FRESH_PAIR, NOT_EXERCISED),
    steering: no('opencode run takes its message as arguments before the turn starts and has no input channel during it'),
    'stop-resume': blocked('resuming a stored session of opencode run (--session) was not exercised against a scripted engine'),
  },
  codex: {
    single: yes(ONE_SHOT, CODEX_ONE_SHOT),
    'two-sessions': yes(FRESH_PAIR, NOT_EXERCISED),
    steering: no('codex exec reads its prompt before the turn starts and has no input channel during it; turn/steer exists only in the app-server protocol, which the benchmark does not drive'),
    'stop-resume': blocked('a driver exists (codex exec with a stored session, SIGINT at the stop point, then codex exec resume SESSION), but it has not been exercised against a scripted engine'),
  },
});

export function selectLane(value) {
  const name = String(value || '').trim().toLowerCase() || 'equivalent';
  if (!Object.hasOwn(LANES, name)) throw new Error(`unknown lane "${value}": use ${Object.keys(LANES).join(', ')}`);
  return name;
}

export function selectAgents(value) {
  const requested = String(value || '').split(',').map((item) => item.trim().toLowerCase()).filter(Boolean);
  if (!requested.length) return [...LANE_AGENT_IDS];
  const unknown = requested.filter((item) => !LANE_AGENT_IDS.includes(item));
  if (unknown.length) throw new Error(`unknown agent(s): ${unknown.join(', ')}; use ${LANE_AGENT_IDS.join(', ')}`);
  return LANE_AGENT_IDS.filter((agent) => requested.includes(agent));
}

// ---------------------------------------------------------------- seeded order
// A reproducible stream of numbers in [0, 1) from a text seed.
export function seededRandom(seed) {
  let counter = 0;
  let pool = Buffer.alloc(0);
  return () => {
    if (pool.length < 6) {
      pool = Buffer.concat([pool, crypto.createHash('sha256').update(`${seed}\n${counter++}`).digest()]);
    }
    const value = pool.readUIntBE(0, 6);
    pool = pool.subarray(6);
    return value / 2 ** 48;
  };
}

export function shuffled(items, random) {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index--) {
    const other = Math.floor(random() * (index + 1));
    [result[index], result[other]] = [result[other], result[index]];
  }
  return result;
}

// A Williams design: orders of n items in which every item takes every
// position equally often and every item directly follows every other item
// equally often. n rows for an even n, 2n rows (each row and its reverse) for
// an odd n.
export function balancedOrders(count) {
  if (count < 1) return [];
  const base = [0];
  for (let step = 1; base.length < count; step++) {
    base.push(step);
    if (base.length < count) base.push(count - step);
  }
  const rows = Array.from({ length: count }, (_unused, shift) => base.map((value) => (value + shift) % count));
  return count % 2 === 0 || count === 1 ? rows : [...rows, ...rows.map((order) => [...order].reverse())];
}

// One order of `agents` per cell. Each run of cells as long as the design gets
// a newly drawn assignment of agents to the design's symbols and a newly drawn
// order of its rows, both from `random`.
export function counterbalancedOrders(agents, cells, random) {
  const design = balancedOrders(agents.length);
  const orders = [];
  while (orders.length < cells) {
    const assignment = shuffled(agents, random);
    for (const index of shuffled(design.map((_unused, position) => position), random)) {
      if (orders.length < cells) orders.push(design[index].map((symbol) => assignment[symbol]));
    }
  }
  return orders;
}

// ---------------------------------------------------------------- the plan
function laneVerdict(lane, agent) {
  const missing = LANES[lane].agents[agent].filter((item) => item.status === MISSING);
  return missing.length ? `not comparable in the ${lane} lane: ${missing.map((item) => item.detail).join('; ')}` : null;
}

// The attempt list of one lane: every case of `set`, by every agent of
// `agents`, `repetitions` times. Each (repetition, case) cell orders the agents
// by a seeded Williams design; the cases of a repetition are in a seeded order
// of their own. An agent that cannot run keeps its rows, as BLOCKED (missing on
// this machine, or runner work not done) or NOT_COMPARABLE (its interface
// cannot represent the lane or the mechanic), with the reason.
// `availability` maps an agent to { available, reason, evidence }.
export function buildLanePlan({ lane = 'equivalent', set = 'all', repetitions = DEFAULT_REPETITIONS, seed, agents = LANE_AGENT_IDS, availability = {} }) {
  const laneName = selectLane(lane);
  const setName = selectCaseSet(set);
  if (!Number.isInteger(repetitions) || repetitions < 1) throw new Error('repetitions must be a positive integer');
  if (typeof seed !== 'string' || !seed.trim()) throw new Error('a plan needs a seed');
  const agentIds = selectAgents(agents.join(','));
  const cases = listCases(setName);
  const digests = new Map(cases.map((item) => [item.id, caseDigest(item.id)]));
  const caseRandom = seededRandom(`${seed}\ncases`);
  const orders = counterbalancedOrders(agentIds, cases.length * repetitions, seededRandom(`${seed}\nagents`));
  const rows = [];
  let cell = 0;
  for (let repetition = 1; repetition <= repetitions; repetition++) {
    for (const item of shuffled(cases, caseRandom)) {
      const order = orders[cell++];
      order.forEach((agentId, index) => {
        const agent = LANE_AGENTS.find((candidate) => candidate.id === agentId);
        const support = MECHANIC_SUPPORT[agentId][item.mechanic];
        const laneReason = laneVerdict(laneName, agentId);
        let status = 'PLANNED';
        let reason = null;
        if (laneReason) [status, reason] = [LANES[laneName].agents[agentId].some((entry) => entry.dimension === 'configuration') ? 'BLOCKED' : 'NOT_COMPARABLE', laneReason];
        else if (support.status === 'not-comparable') [status, reason] = ['NOT_COMPARABLE', `${item.mechanic} is not comparable for ${agent.label}: ${support.reason}`];
        else if (support.status === 'blocked') [status, reason] = ['BLOCKED', `${item.mechanic} is blocked for ${agent.label}: ${support.reason}`];
        else if (availability[agentId] && availability[agentId].available === false) [status, reason] = ['BLOCKED', availability[agentId].reason];
        const attemptId = `r${repetition}-${item.id}-${agentId}`;
        rows.push({
          index: rows.length + 1, attemptId, lane: laneName, repetition, cell,
          caseId: item.id, caseSet: item.set, heldOut: item.heldOut, kind: item.kind, mechanic: item.mechanic,
          agent: agentId, position: index + 1, runtime: agent.runtime,
          workspace: `attempts/${attemptId}/workspace`, workspaceDigest: digests.get(item.id),
          status, reason,
        });
      });
    }
  }
  return {
    schema: LANE_PLAN_SCHEMA,
    lane: laneName,
    laneLabel: LANES[laneName].label,
    settings: LANES[laneName].settings,
    equivalence: Object.fromEntries(agentIds.map((agent) => [agent, LANES[laneName].agents[agent]])),
    set: setName,
    sets: CASE_SETS[setName],
    fixtures: Object.fromEntries(CASE_SETS[setName].map((name) => [name, CASE_SET_FIXTURES[name]])),
    seed,
    repetitions,
    agents: agentIds,
    cases: cases.length,
    expectedAttempts: cases.length * agentIds.length * repetitions,
    order: 'per repetition a seeded order of the cases; per (repetition, case) a seeded Williams order of the agents',
    workspaces: 'one new directory per attempt, created from the case fixture; agents of one case get the same digest',
    availability: Object.fromEntries(agentIds.map((agent) => [agent, availability[agent] || { available: null, reason: 'not probed', evidence: [] }])),
    mechanics: Object.fromEntries(agentIds.map((agent) => [agent, MECHANIC_SUPPORT[agent]])),
    rows,
  };
}

// Model loads the order costs: one per attempt of a runtime that starts per
// attempt, and one each time the shared server comes back after another runtime.
export function countModelLoads(rows) {
  let loads = 0;
  let previous = null;
  for (const item of rows.filter((candidate) => candidate.status === 'PLANNED')) {
    if (LANE_RUNTIMES[item.runtime].startsPerAttempt || item.runtime !== previous) loads++;
    previous = item.runtime;
  }
  return loads;
}

export function summarizeLanePlan(plan) {
  const count = (rows, key) => rows.reduce((totals, item) => ({ ...totals, [item[key]]: (totals[item[key]] || 0) + 1 }), {});
  const positions = Object.fromEntries(plan.agents.map((agent) => [agent,
    plan.agents.map((_unused, index) => plan.rows.filter((item) => item.agent === agent && item.position === index + 1).length)]));
  const follows = {};
  for (let index = 1; index < plan.rows.length; index++) {
    const [before, after] = [plan.rows[index - 1], plan.rows[index]];
    if (before.cell !== after.cell) continue;
    follows[`${before.agent}>${after.agent}`] = (follows[`${before.agent}>${after.agent}`] || 0) + 1;
  }
  return {
    lane: plan.lane, set: plan.set, seed: plan.seed, repetitions: plan.repetitions,
    cases: plan.cases, agents: plan.agents.length, attempts: plan.rows.length, expectedAttempts: plan.expectedAttempts,
    byStatus: count(plan.rows, 'status'),
    bySet: count(plan.rows, 'caseSet'),
    byAgent: Object.fromEntries(plan.agents.map((agent) => [agent, count(plan.rows.filter((item) => item.agent === agent), 'status')])),
    positions,
    directSuccessions: { minimum: Math.min(...Object.values(follows), Infinity), maximum: Math.max(...Object.values(follows), 0), pairs: Object.keys(follows).length },
    modelLoads: countModelLoads(plan.rows),
    reasons: [...new Set(plan.rows.filter((item) => item.reason).map((item) => `${item.status} ${item.agent}: ${item.reason}`))],
  };
}

const CSV_COLUMNS = ['index', 'repetition', 'cell', 'position', 'caseId', 'caseSet', 'heldOut', 'mechanic', 'agent', 'runtime', 'status', 'reason', 'workspace', 'workspaceDigest'];
export function lanePlanCsv(plan) {
  const cellText = (value) => (/[",\n]/.test(String(value ?? '')) ? `"${String(value).replaceAll('"', '""')}"` : String(value ?? ''));
  return `${[CSV_COLUMNS.join(','), ...plan.rows.map((item) => CSV_COLUMNS.map((column) => cellText(item[column])).join(','))].join('\n')}\n`;
}

export function formatLaneSummary(plan) {
  const summary = summarizeLanePlan(plan);
  const lines = [
    `lane ${summary.lane} (${plan.laneLabel}) · set ${summary.set} · seed ${JSON.stringify(summary.seed)}`,
    `${summary.cases} cases x ${summary.agents} agents x ${summary.repetitions} repetitions = ${summary.attempts} attempts (expected ${summary.expectedAttempts})`,
    `by set: ${Object.entries(summary.bySet).map(([name, total]) => `${name} ${total}`).join(', ')}`,
    `by status: ${Object.entries(summary.byStatus).map(([name, total]) => `${name} ${total}`).join(', ')}`,
    `model loads the planned order needs: ${summary.modelLoads}`,
    'agent                 position 1..n (attempts)        status',
  ];
  for (const agent of plan.agents) {
    const state = plan.availability[agent];
    const statuses = Object.entries(summary.byAgent[agent]).map(([name, total]) => `${name} ${total}`).join(', ');
    lines.push(`  ${agent.padEnd(16)} ${summary.positions[agent].join(' ').padEnd(32)} ${statuses}`);
    lines.push(`    ${state.available === true ? 'available' : state.available === false ? `BLOCKED: ${state.reason}` : 'not probed'}`);
    for (const item of state.evidence || []) lines.push(`      ${item}`);
  }
  if (summary.reasons.length) {
    lines.push('rows that will not run, and why:');
    for (const reason of summary.reasons) lines.push(`  ${reason}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------- availability
// The model the runners pick from an engine directory's GGUF list.
export function selectBenchmarkModel(ggufs, requested) {
  if (requested) {
    const exact = ggufs.find((item) => item.file === requested || item.file.endsWith(`/${requested}`));
    if (!exact) throw new Error(`DSTUDIO_TASK_GRAPH_GGUF not found: ${requested}`);
    return exact;
  }
  const usable = ggufs.filter((item) => !/DSpark-support|MXFP4|Vision-Encoder|GLM-5\.2/i.test(item.file));
  return usable.find((item) => /DeepSeek-V4-Flash-IQ2XXS.*imatrix/i.test(item.file)) || usable[0] || null;
}

function onPath(name, searchPath) {
  for (const dir of String(searchPath || '').split(path.delimiter)) {
    if (dir && fs.existsSync(path.join(dir, name))) return path.join(dir, name);
  }
  return null;
}

// `--version` of a third-party CLI, in an empty home, with every proxy
// variable pointing at a closed loopback port: nothing can leave the machine.
function cliVersion(binary) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dstudio-lane-probe-'));
  const dead = 'http://127.0.0.1:9';
  try {
    const result = spawnSync(binary, ['--version'], {
      cwd: home, encoding: 'utf8', timeout: 30_000,
      env: {
        PATH: process.env.PATH || '', HOME: home, CODEX_HOME: path.join(home, '.codex'), XDG_CONFIG_HOME: path.join(home, '.config'),
        XDG_DATA_HOME: path.join(home, '.local', 'share'), XDG_CACHE_HOME: path.join(home, '.cache'),
        PI_OFFLINE: '1', PI_TELEMETRY: '0', OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_MODELS_FETCH: '1',
        HTTP_PROXY: dead, HTTPS_PROXY: dead, ALL_PROXY: dead, http_proxy: dead, https_proxy: dead, all_proxy: dead,
      },
    });
    const text = `${result.stdout || ''}`.trim().split('\n').pop() || '';
    return result.status === 0 && text ? text : null;
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

// Whether each agent can run on this machine, with what was looked at. Reads
// files and asks the three CLIs for their version; starts no engine. The
// probes are parameters so that a test can state the machine.
export function probeLaneAvailability({
  agents = LANE_AGENT_IDS,
  resolveEngine,
  requestedModel = process.env.DSTUDIO_TASK_GRAPH_GGUF,
  hostBinary = path.join(process.cwd(), 'tests', '.build', 'dstudio-server-test'),
  upstream = () => inspectUpstreamAgent(),
  locate = (name) => onPath(name, process.env.PATH),
  version = cliVersion,
} = {}) {
  let engine = null;
  let model = null;
  let engineReason = null;
  try {
    engine = resolveEngine();
    model = selectBenchmarkModel(engine.ggufs, requestedModel);
    if (!model) engineReason = `no usable GGUF in ${engine.dir}`;
  } catch (error) {
    engineReason = error.message.split('\n')[0];
  }
  const modelEvidence = model ? [`model ${model.file} (${model.size} bytes) in ${engine.dir}`] : [];
  const need = (file, what) => (fs.existsSync(file) ? { evidence: `${what} ${file}` } : { reason: `${what} is missing: ${file}` });
  const result = {};
  for (const agent of agents) {
    const evidence = [...modelEvidence];
    const reasons = engineReason ? [engineReason] : [];
    const requirement = (state) => (state.reason ? reasons.push(state.reason) : evidence.push(state.evidence));
    const runtime = LANE_AGENTS.find((item) => item.id === agent).runtime;
    if (runtime === 'upstream-agent') {
      const build = upstream();
      requirement(build.ok ? { evidence: `clean build ${build.binary} (ds4 ${String(build.receipt.commit).slice(0, 12)}, no patch, sha256 ${String(build.receipt.binarySHA256).slice(0, 12)})` } : { reason: build.reason });
    } else {
      requirement(need(hostBinary, 'DStudio host test binary'));
      if (engine) requirement(need(path.join(engine.dir, runtime === 'dstudio-agent' ? 'ds4-agent-jsonl' : 'ds4-server'), runtime === 'dstudio-agent' ? 'patched Agent runtime' : 'engine server'));
    }
    if (runtime === 'ds4-server') {
      const binary = locate(agent);
      if (!binary) reasons.push(`${agent} is not on PATH`);
      else {
        const reported = version(binary);
        requirement(reported ? { evidence: `${agent} ${reported} at ${binary}` } : { reason: `${binary} --version did not answer` });
      }
    }
    result[agent] = { available: reasons.length === 0, reason: reasons.join('; ') || null, evidence };
  }
  return result;
}

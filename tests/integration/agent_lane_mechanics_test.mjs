// The six-agent lane runner (extension/task-graph/bench/run-agent-lane.mjs and
// lane-drivers.mjs) with the installed third-party CLIs against SCRIPTED model
// servers: Pi and OpenCode on a Chat Completions stand-in, Codex on a
// Responses stand-in, both behind the lane's own model pin proxy.
//
// Each attempt goes through the runner's code: the plan row, a fresh workspace
// checked against the plan's digest, the CLI's isolated configuration and
// preflight, the driver of the case's mechanic, the CLI's real tool calls
// changing the workspace, the case's own oracle grading the files, and the
// result row the runner keeps. Cases: one single-prompt recovery case, the
// two-sessions mechanic and Codex Stop/resume; then a wrong solution the
// oracle must reject and a Stop that never reaches its point.
//
// No model, no weights, no engine, no login or API key, nothing outside
// 127.0.0.1. Every reply is scripted: this proves the runner's mechanics and
// grading path, nothing about any model or agent. The clean upstream ds4-agent
// and the DStudio Agent (direct and checked) run inference inside their own
// process from a GGUF; no scripted server can stand in for that, so their rows
// are BLOCKED here, with the reason in the receipt. A CLI that is not
// installed is BLOCKED by the runner's own probe, and the test fails.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { buildLanePlan, LANE_AGENT_IDS, LANES, probeAgentProgram } from '../../extension/task-graph/bench/agent-lane.mjs';
import { CLI_LANE_AGENTS, executeLane, prepareCliLane, runCliLaneAttempt } from '../../extension/task-graph/bench/lane-drivers.mjs';
import { startModelPinProxy } from '../../extension/task-graph/bench/cli-competitor-harness.mjs';
import { chatTurn, startScriptedChatEngine } from '../support/scripted_chat_engine.mjs';
import { startScriptedEngine, turn } from '../support/scripted_responses_engine.mjs';

const SCOPE = 'Real Pi, OpenCode and Codex CLIs driven by the six-agent lane runner; scripted model servers, no model or inference';
const root = path.resolve('tests/.artifacts/agent-lane-mechanics');
fs.mkdirSync(root, { recursive: true });
const run = fs.mkdtempSync(path.join(root, 'run-'));
const SETTINGS = LANES.equivalent.settings;
const TIMEOUT_MS = 120_000;
const watchdog = setTimeout(() => {
  console.log('FAIL: the lane mechanics test exceeded its 600-second bound');
  process.exit(1);
}, 600_000);

const receipt = { scope: SCOPE, startedAt: new Date().toISOString(), availability: {}, cliVersions: {}, preflights: {}, rows: [], controls: [], checks: [] };
const saveReceipt = () => fs.writeFileSync(path.join(run, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`);
let failed = 0;
let blocked = 0;
async function check(name, fn) {
  try {
    await fn();
    receipt.checks.push({ name, status: 'PASS' });
    console.log(`PASS: ${name}`);
  } catch (error) {
    failed++;
    receipt.checks.push({ name, status: 'FAIL', error: String(error.stack || error) });
    console.log(`FAIL: ${name}\n${error.stack || error}`);
  }
  saveReceipt();
}

// ---------------------------------------------------------------- what can run here
// The CLIs: the runner's own probe (on PATH, answers --version in an empty
// home). The other three: what their program is, and why no scripted server
// can run them.
const IN_PROCESS = {
  'upstream-agent': 'the clean upstream ds4-agent runs the model inside its own process from a GGUF file and has no model endpoint a scripted server could answer; its drivers (one prompt, two sessions, steering) need real weights',
  'native-agent': 'the lane starts the DStudio host in Agent mode on a local GGUF; the patched Agent runtime runs the model in-process, so no scripted server can stand in for it; its driver needs real weights',
  'task-graph': 'the lane starts the DStudio host in Agent mode on a local GGUF and routes each prompt through an automatic Task Graph; the patched Agent runtime runs the model in-process, so no scripted server can stand in for it; its driver needs real weights',
};
const availability = {};
for (const agent of LANE_AGENT_IDS) {
  if (CLI_LANE_AGENTS.includes(agent)) {
    const state = probeAgentProgram(agent);
    availability[agent] = state.reason ? { available: false, reason: state.reason, evidence: [] } : { available: true, reason: null, evidence: [state.evidence] };
  } else {
    const program = agent === 'upstream-agent' ? probeAgentProgram(agent) : null;
    availability[agent] = {
      available: false,
      reason: `not run by the scripted mechanics test: ${IN_PROCESS[agent]}${program?.reason ? `; also ${program.reason}` : ''}`,
      evidence: program?.evidence ? [program.evidence] : [],
    };
  }
}
receipt.availability = availability;
const runnable = CLI_LANE_AGENTS.filter((agent) => availability[agent].available);
for (const agent of CLI_LANE_AGENTS.filter((item) => !runnable.includes(item))) {
  blocked++;
  console.log(`BLOCKED: ${agent}: ${availability[agent].reason}`);
}

// ---------------------------------------------------------------- the plan
// The runner's plan of the recovery set, one repetition, all six agents; the
// rows of four cases are run: one prompt, two sessions, Stop/resume, steering.
const CASES = ['dirty-workspace-01', 'two-sessions-01', 'stop-resume-01', 'steering-01'];
const plan = buildLanePlan({ lane: 'equivalent', set: 'recovery', repetitions: 1, seed: 'agent-lane-mechanics', agents: LANE_AGENT_IDS, availability });
const subset = { ...plan, rows: plan.rows.filter((row) => CASES.includes(row.caseId)) };
fs.writeFileSync(path.join(run, 'plan.json'), `${JSON.stringify(subset, null, 2)}\n`);

await check('the plan keeps every agent and mechanic it cannot run, with its reason', async () => {
  assert.equal(subset.rows.length, CASES.length * LANE_AGENT_IDS.length);
  for (const row of subset.rows) {
    if (row.status !== 'PLANNED') assert.ok(typeof row.reason === 'string' && row.reason.trim(), `${row.attemptId} has no reason`);
    if (!CLI_LANE_AGENTS.includes(row.agent)) assert.notEqual(row.status, 'PLANNED', `${row.attemptId} cannot run here`);
  }
  const status = (agent, caseId) => subset.rows.find((row) => row.agent === agent && row.caseId === caseId).status;
  for (const agent of runnable) {
    assert.equal(status(agent, 'dirty-workspace-01'), 'PLANNED');
    assert.equal(status(agent, 'two-sessions-01'), 'PLANNED');
  }
  if (runnable.includes('codex')) assert.equal(status('codex', 'stop-resume-01'), 'PLANNED');
  assert.equal(status('pi', 'stop-resume-01'), 'BLOCKED');
  assert.equal(status('opencode', 'stop-resume-01'), 'BLOCKED');
  assert.equal(status('pi', 'steering-01'), 'BLOCKED');
  assert.equal(status('opencode', 'steering-01'), 'NOT_COMPARABLE');
  assert.equal(status('codex', 'steering-01'), 'NOT_COMPARABLE');
  assert.equal(status('upstream-agent', 'stop-resume-01'), 'NOT_COMPARABLE');
  assert.equal(status('task-graph', 'stop-resume-01'), 'NOT_COMPARABLE');
});

// ---------------------------------------------------------------- scripted servers
// The lane's one pin proxy serves all three CLIs, as ds4-server does both
// endpoints; a loopback dispatcher sends each path to its scripted stand-in.
const chat = await startScriptedChatEngine();
const responses = await startScriptedEngine();
const dispatcher = http.createServer((request, response) => {
  const port = request.url.startsWith('/v1/chat/') ? chat.port : responses.port;
  const upstream = http.request({ hostname: '127.0.0.1', port, path: request.url, method: request.method, headers: request.headers }, (reply) => {
    response.writeHead(reply.statusCode || 502, reply.headers);
    reply.pipe(response);
  });
  upstream.on('error', () => response.destroy());
  response.on('close', () => { if (!response.writableFinished) upstream.destroy(); });
  request.pipe(upstream);
});
await new Promise((resolve) => dispatcher.listen(0, '127.0.0.1', resolve));
const proxy = await startModelPinProxy(dispatcher.address().port, {
  responsesMaxOutputTokens: Math.min(SETTINGS.maxOutputTokens, Math.floor(SETTINGS.contextTokens / 2)),
});

// ---------------------------------------------------------------- the scripted model
// A reply is chosen from the request itself: the phase is the latest of the
// attempt's prompts present in the conversation, and the number of tool
// results after it says which command comes next. When every command of the
// phase has a result, the answer follows (or the reply is held open, so the
// turn is still running when the runner stops it).
const textOf = (content) => (typeof content === 'string' ? content
  : Array.isArray(content) ? content.map((part) => part?.text || '').join('') : '');
function conversation(agent, body) {
  if (agent === 'codex') {
    return (body.input || []).map((item) => item.type === 'message' && item.role === 'user' ? { user: textOf(item.content) }
      : item.type === 'function_call_output' ? { result: String(item.output) } : {});
  }
  return (body.messages || []).map((message) => message.role === 'user' ? { user: textOf(message.content) }
    : message.role === 'tool' ? { result: textOf(message.content) } : {});
}
let callSerial = 0;
function callPart(agent, command) {
  if (agent === 'codex') return { call: { callId: `call_lane_${++callSerial}`, arguments: { cmd: command } } };
  if (agent === 'opencode') return { call: { name: 'bash', arguments: { command, description: 'Run the scripted command' } } };
  return { call: { name: 'bash', arguments: { command } } };
}
const replyWith = (agent, parts) => (agent === 'codex' ? turn(parts) : chatTurn(parts));
function heldReply() {
  const reply = turn([{ text: 'still working' }]);
  return { ...reply, events: reply.events.slice(0, 1), hold: true };
}
// phases: [{ prompt, commands, answer | null (hold) }]
function scriptedModel(agent, phases, log) {
  return (body) => {
    const items = conversation(agent, body);
    let phase = null;
    let at = -1;
    items.forEach((item, index) => {
      const found = item.user !== undefined && phases.find((candidate) => item.user.includes(candidate.prompt));
      if (found) { phase = found; at = index; }
    });
    if (!phase) {
      log.push({ unknownRequest: items.filter((item) => item.user !== undefined).map((item) => item.user.slice(0, 200)) });
      return { status: 400, body: '{"error":{"message":"the scripted model does not know this prompt"}}\n' };
    }
    const results = items.slice(at + 1).filter((item) => item.result !== undefined).map((item) => item.result);
    log.push({ phase: phases.indexOf(phase), resultsSoFar: results.length, lastResult: results.at(-1)?.slice(-300) ?? null });
    if (results.length < phase.commands.length) return replyWith(agent, [callPart(agent, phase.commands[results.length])]);
    if (phase.answer === null) return heldReply();
    return replyWith(agent, [{ text: phase.answer }]);
  };
}

// What each case's script does. `rel` is the case directory inside the
// workspace; `task` is what the fixture gave the agent.
const py = (code) => `python3 -c ${JSON.stringify(code)}`;
const SCRIPTS = {
  'dirty-workspace-01': (rel, task, variant) => [{
    prompt: task.prompt,
    commands: [
      py(`p='${rel}/calc.py'; s=open(p).read(); open(p,'w').write(s.replace('(len(values) - 1)', 'len(values)'))`),
      ...(variant === 'wrong' ? [py(`open('${rel}/scratch/experiment.py','w').write('def trial():\\n    pass\\n')`)] : []),
      `python3 ${rel}/test_calc.py`,
    ],
    answer: `mean() divided by len(values) - 1; it now divides by len(values) and the test prints TEST_OK. ${task.expected}`,
  }],
  'two-sessions-01': (rel, task) => [{
    prompt: task.prompt,
    commands: [
      `python3 ${rel}/tools/register.py`,
      py(`import csv, json; r='${rel}'; rows=list(csv.DictReader(open(r+'/items.csv'))); json.dump([{'sku': x['sku'], 'qty': int(x['qty'])} for x in rows], open(r+'/inventory.json','w'), indent=2)`),
    ],
    answer: 'Registered the workspace once and wrote inventory.json.',
  }, {
    prompt: task.secondPrompt,
    commands: [
      py(`import csv, json; r='${rel}'; inv=json.load(open(r+'/inventory.json')); d={x['sku']: int(x['delta']) for x in csv.DictReader(open(r+'/adjustments.csv'))}; [e.update(qty=e['qty']+d.get(e['sku'], 0)) for e in inv]; json.dump(inv, open(r+'/inventory.json','w'), indent=2)`),
      `python3 ${rel}/tools/seal.py`,
    ],
    answer: `Adjusted the quantities and sealed inventory.json. ${task.expected}`,
  }],
  'stop-resume-01': (rel, task, variant) => (variant === 'never-reaches-stop' ? [{
    prompt: task.prompt, commands: [], answer: 'I will not run anything.',
  }] : [{
    prompt: task.prompt,
    commands: [`python3 ${rel}/tools/step.py 1`, `python3 ${rel}/tools/step.py 2`],
    answer: null,
  }, {
    prompt: task.stop.resumePrompt,
    commands: [`cat ${rel}/journal.log`, `python3 ${rel}/tools/step.py 3`, `python3 ${rel}/tools/step.py 4`],
    answer: `Steps 1 and 2 had run before the stop; ran 3 and 4. ${task.expected}`,
  }]),
};

// ---------------------------------------------------------------- the runner
let cli = null;
await check('the runner configures each CLI in an isolated home and its preflight resolves the pinned ds4 through the proxy', async () => {
  cli = await prepareCliLane({ agents: runnable, runDir: run, proxy, settings: SETTINGS });
  receipt.cliVersions = cli.versions;
  receipt.preflights = cli.preflights;
  for (const agent of runnable) assert.equal(cli.preflights[agent].ok, true, `${agent} preflight: ${JSON.stringify(cli.preflights[agent])}`);
  assert.deepEqual(chat.take().filter((request) => request.method === 'POST'), [], 'a preflight sends no model request');
  assert.deepEqual(responses.take().filter((request) => request.method === 'POST'), [], 'a preflight sends no model request');
});

const traffic = new Map();
const prompts = new Map();
function execute(variant) {
  return async (row, prepared) => {
    prompts.set(row.attemptId, prepared.task.prompt);
    const rel = path.relative(prepared.workspace, prepared.task.root).split(path.sep).join('/');
    const phases = SCRIPTS[row.caseId](rel, prepared.task, variant);
    const log = [];
    const engine = row.agent === 'codex' ? responses : chat;
    engine.take();
    engine.script(Array.from({ length: phases.reduce((total, phase) => total + phase.commands.length + 1, 0) }, () => scriptedModel(row.agent, phases, log)));
    let done;
    try {
      done = await runCliLaneAttempt({ cli, proxy, row, task: prepared.task, workspace: prepared.workspace, timeoutMs: TIMEOUT_MS });
    } finally {
      const requests = engine.take().filter((request) => request.method === 'POST');
      traffic.set(`${variant}:${row.attemptId}`, { requests, log, unserved: engine.unserved(), violations: engine.violations.splice(0) });
      fs.writeFileSync(path.join(prepared.attemptDir, 'scripted-model.json'), `${JSON.stringify({ variant, log, requests: requests.map((request) => request.body) }, null, 2)}\n`);
    }
    return done;
  };
}
const compact = (attempt) => ({
  attemptId: attempt.attemptId, agent: attempt.variant, caseId: attempt.scenario, mechanic: attempt.mechanic, outcome: attempt.outcome,
  taskSuccess: attempt.taskSuccess, reason: attempt.reason ?? attempt.inconclusiveReason ?? null, externalCheck: attempt.externalCheck ?? null,
  unexpectedChanges: attempt.unexpectedChanges ?? null, toolCalls: attempt.toolStats?.calls ?? null, protocol: attempt.protocol ?? null,
  stop: attempt.stop ?? null, harnessError: attempt.harnessError ?? null,
});

let attempts = [];
if (cli) {
  attempts = await executeLane({
    plan: subset, runDir: run, execute: execute('reference'),
    onAttempt: (attempt, done) => console.log(`agent_lane: ${done}/${subset.rows.length} ${attempt.attemptId} · ${attempt.outcome}`),
  });
  receipt.rows = attempts.map(compact);
}
const attemptOf = (agent, caseId) => attempts.find((attempt) => attempt.variant === agent && attempt.scenario === caseId);
const trafficOf = (variant, attempt) => traffic.get(`${variant}:${attempt.attemptId}`);
const POSTED = { pi: '/v1/chat/completions', opencode: '/v1/chat/completions', codex: '/v1/responses' };
const requestResults = (agent, request) => conversation(agent, request.body).filter((item) => item.result !== undefined).map((item) => item.result);
const requestUsers = (agent, request) => conversation(agent, request.body).filter((item) => item.user !== undefined).map((item) => item.user);

await check('every row the runner did not run keeps its status and reason in the result', async () => {
  assert.equal(attempts.length, subset.rows.length);
  subset.rows.forEach((row, index) => {
    const attempt = attempts[index];
    assert.equal(attempt.attemptId, row.attemptId);
    if (row.status === 'BLOCKED') assert.deepEqual([attempt.outcome, attempt.reason], ['blocked', row.reason]);
    if (row.status === 'NOT_COMPARABLE') assert.deepEqual([attempt.outcome, attempt.reason], ['not-comparable', row.reason]);
    if (row.status !== 'PLANNED') assert.ok(!fs.existsSync(path.join(run, 'attempts', row.attemptId)), `${row.attemptId} must not be prepared`);
  });
});

for (const agent of runnable) {
  await check(`${agent}, one prompt (dirty-workspace-01): real tool calls fix the code, the case's oracle passes, the row says so`, async () => {
    const attempt = attemptOf(agent, 'dirty-workspace-01');
    assert.equal(attempt.outcome, 'completed', JSON.stringify(compact(attempt), null, 2));
    assert.equal(attempt.taskSuccess, true);
    assert.equal(attempt.externalCheck.ok, true, attempt.externalCheck.output);
    assert.deepEqual(attempt.unexpectedChanges, []);
    assert.ok(attempt.changedFiles.includes('cases/dirty-workspace-01/task/calc.py'));
    assert.equal(attempt.toolStats.calls, 2);
    assert.equal(attempt.expectedAnswerAfterTool, true);
    assert.equal(attempt.protocol.modelPinVerified, true);
    assert.equal(attempt.process.exitCode, 0);
    const { requests, violations, unserved } = trafficOf('reference', attempt);
    assert.deepEqual(violations, []);
    assert.equal(unserved, 0);
    assert.equal(requests.length, 3);
    assert.ok(requests.every((request) => request.url === POSTED[agent] && request.body.model === 'ds4'));
    // The prompt arrives as the fixture wrote it, and each command's output
    // comes back as its tool result before the next request.
    const prompt = prompts.get(attempt.attemptId);
    const users = requestUsers(agent, requests[0]);
    assert.ok(agent === 'codex' ? users.includes(prompt) : users.length === 1 && users[0] === prompt, `${agent} must receive the prompt as written: ${JSON.stringify(users).slice(0, 300)}`);
    assert.match(requestResults(agent, requests[2]).at(-1), /TEST_OK/);
    const dir = path.join(run, 'attempts', attempt.attemptId);
    assert.ok(fs.existsSync(path.join(dir, 'result.json')) && fs.existsSync(path.join(dir, 'stdout.jsonl')));
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'result.json'), 'utf8')).outcome, 'completed');
  });

  await check(`${agent}, two sessions (two-sessions-01): the second session starts empty, both sessions' effects are graded together`, async () => {
    const attempt = attemptOf(agent, 'two-sessions-01');
    assert.equal(attempt.outcome, 'completed', JSON.stringify(compact(attempt), null, 2));
    assert.equal(attempt.mechanic, 'two-sessions');
    assert.equal(attempt.externalCheck.ok, true, attempt.externalCheck.output);
    assert.deepEqual(attempt.sessions.map((session) => session.exitCode), [0, 0]);
    assert.equal(attempt.toolStats.calls, 4);
    const { requests, unserved } = trafficOf('reference', attempt);
    assert.equal(unserved, 0);
    assert.equal(requests.length, 6);
    // The first request of the second session holds its prompt and nothing
    // of the first session's conversation.
    const second = requests[3];
    assert.equal(requestResults(agent, second).length, 0, 'the second session must not replay the first');
    assert.ok(requestUsers(agent, second).some((text) => text.includes('An earlier session in this workspace already registered it')));
    assert.ok(!requestUsers(agent, second).some((text) => text.includes('exactly once: it registers this workspace')));
    for (const name of ['session-1-stdout.jsonl', 'session-2-stdout.jsonl'])
      assert.ok(fs.existsSync(path.join(run, 'attempts', attempt.attemptId, name)), name);
  });
}

if (runnable.includes('opencode')) {
  await check('opencode receives the prompt byte for byte (not wrapped in quotes by `opencode run`)', async () => {
    const attempt = attemptOf('opencode', 'two-sessions-01');
    const { requests } = trafficOf('reference', attempt);
    const first = requestUsers('opencode', requests[0]);
    assert.equal(first.length, 1);
    assert.ok(first[0].startsWith('Run python3 cases/two-sessions-01/task/tools/register.py exactly once'), first[0].slice(0, 120));
    assert.ok(first[0].includes('{"sku": <text>, "qty": <integer>}'), 'inner quotes must not be escaped');
    assert.ok(!first[0].startsWith('"'));
  });
}

if (runnable.includes('codex')) {
  await check('codex, Stop/resume (stop-resume-01): stopped at its point, resumed in the same session, each step ran once', async () => {
    const attempt = attemptOf('codex', 'stop-resume-01');
    assert.equal(attempt.outcome, 'completed', JSON.stringify(compact(attempt), null, 2));
    assert.equal(attempt.externalCheck.ok, true, attempt.externalCheck.output);
    assert.equal(attempt.stop.reachedStopPoint, true);
    assert.equal(attempt.stop.stoppedWhileRunning, true);
    assert.ok(attempt.stop.session, 'the stopped run must report its session');
    assert.equal(attempt.resumedSession, attempt.stop.session, 'resume must continue the stopped session');
    assert.deepEqual(attempt.stop.changedBeforeStop.sort(), ['cases/stop-resume-01/task/journal.log', 'cases/stop-resume-01/task/state.json']);
    assert.equal(attempt.sessions[1].exitCode, 0);
    assert.equal(attempt.sessions[0].stopped, true);
    const { requests } = trafficOf('reference', attempt);
    const resumed = requests.filter((request) => requestUsers('codex', request).some((text) => text.includes('The previous turn was stopped')));
    assert.ok(resumed.length >= 3, `resumed requests: ${resumed.length}`);
    // The resumed conversation replays the stopped turn: the original prompt
    // and both calls. The stop point is a workspace state, so the stop can
    // land after step 2 wrote its line but before the CLI recorded the
    // command's end; Codex then replays that call as "aborted by user" although
    // its effect is in the workspace. Which of the two happened is recorded.
    const history = requestResults('codex', resumed[0]);
    assert.ok(requestUsers('codex', resumed[0]).some((text) => text.includes('Run python3 cases/stop-resume-01/task/tools/step.py 1')));
    assert.equal(history.length, 2, history.join('\n---\n'));
    assert.match(history[0], /step 1 done/);
    assert.match(history[1], /step 2 done|aborted by user/);
    receipt.observations = [...(receipt.observations || []), `codex replayed the call running at the stop as: ${/aborted by user/.test(history[1]) ? '"aborted by user" (its effect, step 2, was already in the journal)' : 'its completed output'}`];
    // The journal read after the resume is what the stop left.
    assert.match(requestResults('codex', resumed[1]).at(-1), /step 1 done\nstep 2 done\n/);
  });
}

// ---------------------------------------------------------------- controls
// The same rows again, each in a run directory of its own: a scripted wrong
// solution the case's oracle must reject, and a Stop whose point the turn
// never reaches.
async function control(name, variant, predicate) {
  const directory = path.join(run, 'controls', name);
  fs.mkdirSync(directory, { recursive: true });
  const rows = subset.rows.filter((row) => row.status === 'PLANNED' && predicate(row));
  const results = await executeLane({ plan: { ...subset, rows }, runDir: directory, execute: execute(variant) });
  receipt.controls.push(...results.map((attempt) => ({ control: name, ...compact(attempt) })));
  return results;
}
if (cli) {
  const wrong = await control('wrong-solution', 'wrong', (row) => row.caseId === 'dirty-workspace-01');
  for (const attempt of wrong) {
    await check(`${attempt.variant}, a wrong solution (the uncommitted file was "tidied") is failed by the oracle, with a false completion claim`, async () => {
      assert.equal(attempt.outcome, 'failed', JSON.stringify(compact(attempt), null, 2));
      assert.equal(attempt.taskSuccess, false);
      assert.equal(attempt.externalCheck.ok, false);
      assert.match(attempt.externalCheck.output, /uncommitted files keep their bytes/);
      assert.deepEqual(attempt.unexpectedChanges, ['cases/dirty-workspace-01/task/scratch/experiment.py']);
      assert.equal(attempt.incorrectCompletionClaim, true, 'the scripted answer claimed completion');
    });
  }
  if (runnable.includes('codex')) {
    const [never] = await control('stop-not-reached', 'never-reaches-stop', (row) => row.agent === 'codex' && row.caseId === 'stop-resume-01');
    await check('codex, Stop/resume whose turn ends before the stop point is inconclusive, not failed or completed, and is not resumed', async () => {
      assert.equal(never.outcome, 'inconclusive', JSON.stringify(compact(never), null, 2));
      assert.equal(never.taskSuccess, false);
      assert.equal(never.stop.reachedStopPoint, false);
      assert.equal(never.stop.stoppedWhileRunning, false);
      assert.equal(never.inconclusiveReason, 'the turn ended before the stop point was reached');
      assert.equal(trafficOf('never-reaches-stop', never).requests.length, 1, 'no resume may follow');
    });
  }
}

if (cli) {
  await check('the scripted servers refused no request and the proxy saw only the pinned ds4 model', async () => {
    for (const [name, record] of traffic) assert.deepEqual(record.violations, [], name);
    for (const attempt of [...attempts, ...receipt.controls].filter((item) => item.protocol))
      assert.equal(attempt.protocol.modelPinVerified, true, `${attempt.attemptId}: ${JSON.stringify(attempt.protocol)}`);
  });
}

await proxy.close();
await chat.close();
await responses.close();
await new Promise((resolve) => dispatcher.close(resolve));
clearTimeout(watchdog);

// ---------------------------------------------------------------- report
receipt.finishedAt = new Date().toISOString();
saveReceipt();
console.log('\nPer agent (scripted model servers; no model):');
for (const agent of LANE_AGENT_IDS) {
  const rows = receipt.rows.filter((row) => row.agent === agent);
  const state = availability[agent];
  const version = receipt.cliVersions[agent] ? ` ${receipt.cliVersions[agent]}` : '';
  console.log(`  ${agent}${version}: ${state.available ? 'available' : `BLOCKED (${state.reason})`}`);
  for (const row of rows) console.log(`    ${row.caseId} [${row.mechanic}] ${row.outcome}${row.outcome === 'blocked' || row.outcome === 'not-comparable' ? `: ${row.reason}` : ''}`);
}
const passed = receipt.checks.filter((item) => item.status === 'PASS').length;
console.log(`agent_lane_mechanics: ${passed} passed, ${failed} failed, ${blocked} CLI(s) BLOCKED · CLIs run: ${runnable.join(', ') || 'none'} · scripted servers, no model`);
console.log(`Evidence: ${run}`);
process.exit(failed || blocked ? 1 : 0);

// Actual native Design loop (ds4-design in remote mode) with SIMULATED model
// frames: the model replies below are authored, no inference runs. It checks
// what the runtime does with the replies, through its real tools:
//   1. question(): the batch stops before any later write, the turn ends
//      without another model request, and the user's §QUESTION_ANSWER turn
//      resumes the work (the write then runs);
//   2. propose(): the directions must exist, the proposal event lists them and
//      the turn ends; the user's pick reaches the next model request;
//   3. artifact(): a page that overflows at a checked width is rendered in a
//      real headless Chromium, refused, and no manifest is registered; the
//      same page made to fit passes the layout check.
// The layout check renders with the Chrome the runtime itself finds (DS4_CHROME
// or the installed Chrome): without one the test is NOT RUN and fails.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {findChrome} from '../support/design_control_probe.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const binary = path.resolve(process.argv[2] || path.join(root, 'ds4/ds4-design'));
assert.ok(fs.existsSync(binary), `ds4-design must be built: ${binary}`);
const chrome = findChrome();
if (!chrome) {
  console.log('design_turn_gates_test: Chrome missing, NOT RUN');
  process.exit(1);
}
fs.mkdirSync(path.join(root, 'tests/.artifacts'), {recursive: true});
const output = fs.mkdtempSync(path.join(root, 'tests/.artifacts/design-turn-gates-'));
const workspace = path.join(output, 'workspace');
fs.mkdirSync(workspace);

const invoke = (name, args) => `<｜DSML｜invoke name="${name}">` +
  Object.entries(args).map(([k, v]) => `<｜DSML｜parameter name="${k}" string="true">${v}</｜DSML｜parameter>`).join('') +
  '</｜DSML｜invoke>';
const batch = (...calls) => '<｜DSML｜tool_calls>' + calls.join('') + '</｜DSML｜tool_calls>';
const todo = (status, text = 'Build the requested page') => invoke('todo_write', {todos: JSON.stringify([{text, status}])});

// Pages that pass the static checks (doctype, viewport, title, <main>, no
// placeholder copy), so only the rendered geometry decides.
const page = (title, extraCss, body) => '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n' +
  '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
  `<title>${title}</title>\n<style>\nbody { margin: 0; font: 17px/1.5 Georgia, serif; color: #1d1b16; background: #fbf8f1; }\n` +
  `main { padding: 24px; }\n${extraCss}</style>\n</head>\n<body>\n<main>\n${body}\n</main>\n</body>\n</html>\n`;
const CLUB = page('Thursday reading club', '', '<h1>Thursday reading club</h1>\n<p>We meet at the library to talk about one novel a month.</p>');
const DIR_A = page('Club direction A', 'h1 { font-size: 64px; }\n', '<h1>Read together</h1>\n<p>A large serif headline over plain paper.</p>');
const DIR_B = page('Club direction B', 'body { background: #102a2c; color: #f4efe3; }\n', '<h1>Thursdays, chapter by chapter</h1>\n<p>A dark evening palette.</p>');
const SCHEDULE = '<h1>Season schedule</h1>\n<table class="season">\n<tr><th>Month</th><th>Book</th><th>Host</th></tr>\n' +
  '<tr><td>October</td><td>The Leopard</td><td>Marta</td></tr>\n</table>';
// 1100px wide at every width: the 768 and 390 px renders scroll sideways.
const WIDE = page('Season schedule', '.season { width: 1100px; border-collapse: collapse; }\n', SCHEDULE);
const FITS = page('Season schedule', '.season { width: 100%; max-width: 1100px; border-collapse: collapse; }\n', SCHEDULE);

const ANSWER = '§QUESTION_ANSWER\nAnswers to the clarification:\nWho reads it?: Adult members of the library\n§END';
const PICK = 'Use direction B (b.html). Continue refining only this one; drop the other directions.';
const QUESTIONS = JSON.stringify([{id: 'audience', label: 'Who reads it?', type: 'text'}]);
const DIRECTIONS = JSON.stringify([
  {entry: 'a.html', tag: 'A', name: 'Paper', desc: 'Large serif headline'},
  {entry: 'b.html', tag: 'B', name: 'Evening', desc: 'Dark palette'},
]);

// One user turn per idle prompt; each turn lists the model replies it expects.
// A reply is a function of the model request (it may assert on the messages).
const lastUser = body => JSON.parse(body).messages.filter(m => m.role === 'user').at(-1)?.content || '';
const lastTool = body => {
  const messages = JSON.parse(body).messages;
  const m = messages.filter(x => x.role === 'tool' || (x.role === 'user' && /^\[tool result\]/.test(x.content))).at(-1);
  return m?.content || '';
};
const turns = [
  {prompt: 'Design a one-page site for our Thursday reading club.', replies: [
    () => batch(invoke('question', {id: 'audience', title: 'Before I sketch', questions: QUESTIONS}),
      todo('in_progress'), invoke('write', {path: 'club.html', content: CLUB})),
  ]},
  {prompt: ANSWER, replies: [
    body => { assert.equal(lastUser(body), ANSWER, 'the answer reaches the model as the user turn'); return batch(todo('in_progress'), invoke('write', {path: 'club.html', content: CLUB})); },
    body => { assert.match(lastTool(body), /Wrote|bytes/); return batch(todo('completed')); },
    () => 'The club page is written.',
  ]},
  {prompt: 'Show me two directions for the club page side by side.', replies: [
    () => batch(todo('in_progress', 'Write two directions'), invoke('write', {path: 'a.html', content: DIR_A}), invoke('write', {path: 'b.html', content: DIR_B})),
    () => batch(invoke('propose', {directions: JSON.stringify([...JSON.parse(DIRECTIONS), {entry: 'c.html', tag: 'C', name: 'Missing', desc: 'not written'}])})),
    body => { assert.match(lastTool(body), /proposed direction file does not exist: c\.html/); return batch(todo('completed', 'Write two directions'), invoke('propose', {directions: DIRECTIONS})); },
  ]},
  {prompt: PICK, replies: [
    body => { assert.equal(lastUser(body), PICK, 'the chosen direction reaches the model'); return 'Refining direction B only.'; },
  ]},
  {prompt: 'Add the season schedule page and register it.', replies: [
    () => batch(todo('in_progress', 'Write and register the schedule'), invoke('write', {path: 'schedule.html', content: WIDE})),
    () => batch(todo('completed', 'Write and register the schedule'), invoke('artifact', {entry: 'schedule.html', title: 'Season schedule'})),
    body => { assert.match(lastTool(body), /artifact blocked by verification failures/); return batch(invoke('write', {path: 'schedule.html', content: FITS})); },
    body => { assert.match(lastTool(body), /deterministic layout evidence is required before write/); return batch(invoke('inspect_layout', {entry: 'schedule.html'})); },
    () => batch(invoke('write', {path: 'schedule.html', content: FITS}), invoke('artifact', {entry: 'schedule.html', title: 'Season schedule'})),
    () => 'The schedule is not registered yet.',
  ]},
];

const events = [], requests = [], waits = [];
let stdout = Buffer.alloc(0), stderr = '', tail = Buffer.alloc(0), failure, turn = -1, replyInTurn = 0;
const child = spawn(binary, [
  '--remote-base-url', 'http://127.0.0.1:1', '--remote-model', 'turn-gates-fixture',
  '--workspace', workspace, '--jsonl', '--nothink', '-c', '32768', '-n', '8192',
], {cwd: root, env: {...process.env, DS4_CHROME: chrome, DSTUDIO_DESIGN_CACHE_DIR: path.join(output, 'cache')},
  stdio: ['pipe', 'pipe', 'pipe']});
const fail = error => { failure ||= error; if (child.exitCode === null) child.kill('SIGKILL'); };
const exited = new Promise(resolve => {
  child.once('error', error => { failure = error; resolve({error: error.message}); });
  child.once('close', (code, signal) => resolve({code, signal}));
});
const timeout = setTimeout(() => fail(Error('Design turn gates test exceeded 180 seconds')), 180000);
child.stdin.on('error', fail);
const send = (id, text) => {
  // A few characters per frame, as a model API streams.
  for (let i = 0; i < text.length; i += 64)
    child.stdin.write('\x1e' + JSON.stringify({type: 'model_delta', id, kind: 'content', text: text.slice(i, i + 64)}) + '\n');
  child.stdin.write('\x1e' + JSON.stringify({type: 'model_done', id}) + '\n');
};
function modelRequest(event) {
  const scripted = turns[turn]?.replies[replyInTurn];
  requests.push({turn, index: replyInTurn, unexpected: !scripted, lastUser: lastUser(event.body).slice(0, 200)});
  replyInTurn++;
  try {
    // Unscripted: a request the runtime should not have made. Answer with
    // plain text so the turn ends, and fail on the recorded receipt.
    send(event.id, scripted ? scripted(event.body) : 'Unscripted extra request.');
  } catch (error) { fail(error); send(event.id, 'Assertion failed.'); }
}
child.stdout.on('data', chunk => {
  stdout = Buffer.concat([stdout, chunk]);
  tail = Buffer.concat([tail, chunk]);
  let nl;
  while ((nl = tail.indexOf(10)) >= 0) {
    const line = tail.subarray(0, nl).toString('utf8');
    tail = tail.subarray(nl + 1);
    const marker = line.indexOf('\x1e');
    if (marker < 0) continue;
    let ev;
    try { ev = JSON.parse(line.slice(marker + 1)); } catch (error) { fail(error); return; }
    ev.turn = turn;
    events.push(ev);
    if (ev.type === 'model_request') modelRequest(ev);
  }
});
child.stderr.setEncoding('utf8');
child.stderr.on('data', chunk => {
  stderr += chunk;
  const idle = (stderr.match(/\+DWARFSTAR_WAITING/g) || []).length;
  while (waits.length < idle) {
    waits.push({afterTurn: turn, requests: requests.length, state: readState()});
    turn++;
    replyInTurn = 0;
    if (turn < turns.length) child.stdin.write(turns[turn].prompt + '\n');
    else child.stdin.end();
  }
});
function readState() {
  try { return JSON.parse(fs.readFileSync(path.join(workspace, '.ds4-design/state.json'), 'utf8')); } catch { return null; }
}
const history = () => fs.readFileSync(path.join(workspace, '.ds4-design/history.jsonl'), 'utf8')
  .split('\n').filter(Boolean).map(line => JSON.parse(line));
const ofTurn = (n, type) => events.filter(e => e.turn === n && (!type || e.type === type));

const report = {scope: 'Native Design runtime, remote mode, simulated model frames, real headless Chrome for the layout check; no inference',
  binary, chrome, cases: []};
async function check(name, fn) {
  const row = {name};
  try { await fn(row); row.status = 'PASS'; } catch (error) { row.status = 'FAIL'; row.error = error.stack; process.exitCode = 1; }
  report.cases.push(row);
  console.log(`${row.status} ${name}${row.error ? `\n${row.error}` : ''}`);
}

try {
  const result = await exited;
  if (failure) throw failure;
  assert.deepEqual(result, {code: 0, signal: null});
  assert.equal(turn, turns.length, `every scripted turn ran: ${turn}/${turns.length}`);

  await check('a question stops the batch and the turn; no later tool or model request runs', row => {
    const q = ofTurn(0, 'question');
    assert.equal(q.length, 1);
    assert.equal(q[0].id, 'audience');
    assert.deepEqual(q[0].questions, JSON.parse(QUESTIONS));
    row.requests = requests.filter(r => r.turn === 0).length;
    assert.equal(row.requests, 1, `the turn ends after the question, without another model request: ${JSON.stringify(requests.filter(r => r.turn === 0))}`);
    assert.deepEqual(ofTurn(0, 'tool_call').map(e => e.name), ['question'], 'todo_write and write after the question are deferred');
    assert.equal(waits[1].state?.phase, 'waiting_user', 'the project waits for the user');
    const runs = history().filter(h => h.type === 'run_done').map(h => h.payload?.status ?? h.status);
    row.firstRun = runs[0];
    assert.equal(runs[0], 'stopped_after_tool');
  });

  await check('the answer resumes the work: the deferred write now runs', () => {
    assert.ok(requests.filter(r => r.turn === 1).every(r => !r.unexpected));
    assert.equal(fs.readFileSync(path.join(workspace, 'club.html'), 'utf8'), CLUB);
    const started = history().filter(h => h.type === 'run_started');
    assert.equal((started[1].payload ?? started[1]).discoverySatisfied, true, 'the answered question satisfies discovery');
    assert.deepEqual(ofTurn(1, 'tool_call').map(e => e.name), ['todo_write', 'write', 'todo_write']);
  });

  await check('propose lists existing directions only and ends the turn for the pick', row => {
    const proposals = ofTurn(2, 'proposal');
    assert.equal(proposals.length, 1, 'the proposal naming a missing file is refused');
    assert.deepEqual(proposals[0].directions, JSON.parse(DIRECTIONS));
    row.requests = requests.filter(r => r.turn === 2).length;
    assert.equal(row.requests, 3, `no model request after a successful propose: ${JSON.stringify(requests.filter(r => r.turn === 2))}`);
    assert.equal(waits[3].state?.phase, 'waiting_user');
    assert.ok(requests.filter(r => r.turn === 3).length === 1 && !requests.some(r => r.unexpected));
  });

  await check('a page that overflows at a checked width is not registered as an artifact', row => {
    const checks = ofTurn(4, 'artifact_check');
    assert.equal(checks.length, 2, 'both artifact() calls ran the checks');
    const [wide, fits] = checks;
    row.wide = wide.findings;
    assert.equal(wide.entry, 'schedule.html');
    assert.equal(wide.status, 'fail');
    const layout = wide.findings.filter(f => f.severity === 'P0' && /^rendered layout \d+px: page width (\d+)\/(\d+)/.test(f.message));
    assert.deepEqual(layout.map(f => Number(f.message.match(/^rendered layout (\d+)px/)[1])), [768, 390], 'overflow at the tablet and phone widths');
    for (const f of layout) {
      const [, scroll, client] = f.message.match(/page width (\d+)\/(\d+)/).map(Number);
      assert.ok(scroll > client, f.message);
    }
    assert.equal(ofTurn(4, 'artifact').length, 0, 'no artifact event');
    assert.equal(fs.existsSync(path.join(workspace, '.ds4-design/artifacts')) &&
      fs.readdirSync(path.join(workspace, '.ds4-design/artifacts')).length, false, 'no manifest is written');
    assert.equal(history().filter(h => h.type === 'artifact_registered').length, 0);
    // The same table made to fit: no rendered-layout finding.
    row.fits = fits.findings;
    assert.ok(!fits.findings.some(f => /rendered layout/.test(f.message)), JSON.stringify(fits.findings));
    assert.equal(fits.p0, 0);
    // It then stops only at the next, unrelated gate (no critique yet).
    const artifactResults = ofTurn(4, 'tool_result').filter(e => e.name === 'artifact').map(e => e.output);
    assert.equal(artifactResults.length, 2);
    assert.match(artifactResults[1], /^Tool error: artifact blocked: call critique_write for schedule\.html/);
  });

  await check('after the refusal the fix waits for layout evidence, as the tool result says', () => {
    const results = ofTurn(4, 'tool_result').map(e => `${e.name}:${/^Tool error/.test(e.output || e.text || '') ? 'error' : 'ok'}`);
    assert.ok(results.includes('inspect_layout:ok'), JSON.stringify(results));
    assert.equal(fs.readFileSync(path.join(workspace, 'schedule.html'), 'utf8'), FITS);
  });
} catch (error) {
  failure ||= error;
  report.error = error.stack;
  process.exitCode = 1;
  console.error(error);
} finally {
  clearTimeout(timeout);
  fs.writeFileSync(path.join(output, 'stderr.txt'), stderr);
  fs.writeFileSync(path.join(output, 'events.json'), JSON.stringify(events.filter(e => e.type !== 'model_request'), null, 1));
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({...report, requests, waits, pass: !failure && !process.exitCode}, null, 2));
  const passed = report.cases.filter(c => c.status === 'PASS').length;
  console.log(`design_turn_gates_test: ${passed}/${report.cases.length} (real runtime, simulated model); evidence: ${output}`);
}

// Actual native Design loop with simulated model frames: the live tool-stanza
// events (tool_call_begin / tool_call_param / tool_body_delta) must preview the
// exact bytes the model writes, as valid UTF-8, without the DSML close tag,
// before the tool executes. No inference; the model text is scripted.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const binary = path.resolve(process.argv[2] || path.join(root, 'ds4/ds4-design'));
const artifacts = path.join(root, 'tests/.artifacts');
fs.mkdirSync(artifacts, {recursive:true});
const output = fs.mkdtempSync(path.join(artifacts, 'design-tool-stream-'));
const workspace = path.join(output, 'workspace');
fs.mkdirSync(workspace);
const notes = path.join(workspace, 'notes.txt');
const pending = path.join(workspace, 'pending.txt');

const CLOSE = '</｜DSML｜parameter>';
const param = (name, value) => `<｜DSML｜parameter name="${name}" string="true">${value}${CLOSE}`;
const invoke = (name, args) => `<｜DSML｜invoke name="${name}">` +
  Object.entries(args).map(([k, v]) => param(k, v)).join('') + '</｜DSML｜invoke>';
const batch = (...calls) => '<｜DSML｜tool_calls>' + calls.join('') + '</｜DSML｜tool_calls>';
const todo = status => invoke('todo_write', {todos:JSON.stringify([{text:'Write and edit the notes', status}])});

// Multibyte runs make the 384-byte batch cut land inside characters; "</div>"
// is a "</" tail the runtime must hold back until it is not the close tag.
const CONTENT = 'Header line\n' + 'è'.repeat(450) + '\nemoji 🧪🧪 and x < y\n<div>block</div>\n' +
  'TIMED-MARK ' + 'caffè '.repeat(120) + '\nend of notes\n';
const OLD = 'end of notes\n';
const NEW = 'end of notes, edited — ok ✓\n';
const FINAL = CONTENT.replace(OLD, NEW);

let stdoutBytes = Buffer.alloc(0), stderr = '', requests = 0, started = false, failure;
const events = [];
let waiters = [];
const child = spawn(binary, [
  '--remote-base-url', 'http://127.0.0.1:1', '--remote-model', 'stream-fixture',
  '--workspace', workspace, '--jsonl', '--nothink', '-c', '16384', '-n', '8192',
], {cwd:root, env:{...process.env, DSTUDIO_DESIGN_CACHE_DIR:path.join(output, 'cache')}, stdio:['pipe', 'pipe', 'pipe']});
const fail = error => { failure ||= error; if (child.exitCode === null) child.kill('SIGKILL'); };
const exited = new Promise(resolve => {
  child.once('error', error => { failure = error; resolve({error:error.message}); });
  child.once('close', (code, signal) => resolve({code, signal}));
});
const timeout = setTimeout(() => fail(Error('Design tool stream test exceeded 60 seconds')), 60000);
child.stdin.on('error', fail);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const send = (id, text) => child.stdin.write('\x1e' + JSON.stringify({type:'model_delta', id, kind:'content', text}) + '\n');
const until = (predicate, label) => new Promise((resolve, reject) => {
  if (predicate()) return resolve();
  const timer = setTimeout(() => reject(Error(`timed out waiting for ${label}`)), 5000);
  waiters.push(() => { if (predicate()) { clearTimeout(timer); resolve(); return true; } return false; });
});

// Streams by code points (as a model API does), a few characters per frame.
async function stream(id, text, {mark} = {}) {
  const chars = Array.from(text);
  for (let i = 0; i < chars.length; i += 9) {
    const piece = chars.slice(i, i + 9).join('');
    send(id, piece);
    if (mark && piece.includes(mark)) {
      // Time-capped batching: after a pause, the next frame must flush the
      // bytes held since the last batch, well before the stanza closes.
      await sleep(320);
      send(id, chars.slice(i + 9, i + 10).join(''));
      i += 1;
      await until(() => events.some(e => e.type === 'tool_body_delta' && e.text.includes(mark)), 'time-capped delta');
    }
    if (i % 90 === 0) await sleep(5);
  }
}

async function modelRequest(event) {
  requests++;
  try {
    if (requests === 1) {
      await stream(event.id, batch(todo('in_progress'), invoke('write', {path:'notes.txt', content:CONTENT})), {mark:'TIMED-MARK'});
    } else if (requests === 2) {
      assert.equal(fs.readFileSync(notes, 'utf8'), CONTENT, 'write saved different bytes');
      await stream(event.id, batch(invoke('edit', {path:'notes.txt', old:OLD, new:NEW})));
    } else if (requests === 3) {
      assert.equal(fs.readFileSync(notes, 'utf8'), FINAL);
      // Truncated output: the stanza never closes and must not execute.
      await stream(event.id, '<｜DSML｜tool_calls>' + `<｜DSML｜invoke name="write">${param('path', 'pending.txt')}` +
        '<｜DSML｜parameter name="content" string="true">unfinished bytes');
    } else if (requests === 4) {
      assert.equal(fs.existsSync(pending), false, 'a truncated stanza was executed');
      await stream(event.id, batch(todo('completed')));
    } else {
      await stream(event.id, 'Notes written and edited.');
    }
    child.stdin.write('\x1e' + JSON.stringify({type:'model_done', id:event.id}) + '\n');
  } catch (error) { fail(error); }
}

let tail = Buffer.alloc(0);
child.stdout.on('data', chunk => {
  stdoutBytes = Buffer.concat([stdoutBytes, chunk]);
  tail = Buffer.concat([tail, chunk]);
  let nl;
  while ((nl = tail.indexOf(10)) >= 0) {
    const lineBytes = tail.subarray(0, nl);
    tail = tail.subarray(nl + 1);
    let line;
    try { line = new TextDecoder('utf-8', {fatal:true}).decode(lineBytes); }
    catch { fail(Error('stdout line is not valid UTF-8')); return; }
    const marker = line.indexOf('\x1e');
    if (marker < 0) continue;
    let ev;
    try { ev = JSON.parse(line.slice(marker + 1)); } catch (error) { fail(error); return; }
    events.push(ev);
    waiters = waiters.filter(check => !check());
    if (ev.type === 'model_request') modelRequest(ev);
  }
});
child.stderr.setEncoding('utf8');
child.stderr.on('data', chunk => {
  stderr += chunk;
  const waiting = (stderr.match(/\+DWARFSTAR_WAITING/g) || []).length;
  if (waiting && !started) {
    started = true;
    child.stdin.write('Write the notes file, then edit its last line.\n');
  } else if (waiting >= 2) child.stdin.end();
});

// Body text of one parameter: the deltas after `param` opened, until the next
// stanza, parameter or execution event. The pre-existing size progress events
// (tool_call_building / tool_call_progress) legitimately interleave.
const PROGRESS = new Set(['tool_call_building', 'tool_call_progress']);
function bodyAfter(from, paramName) {
  const start = events.findIndex((e, i) => i >= from && e.type === 'tool_call_param' && e.param === paramName);
  assert.ok(start >= 0, `no ${paramName} param after event ${from}`);
  let text = '', deltas = 0, i = start + 1;
  for (; i < events.length && (events[i].type === 'tool_body_delta' || PROGRESS.has(events[i].type)); i++) {
    if (events[i].type === 'tool_body_delta') { text += events[i].text; deltas++; }
  }
  return {text, deltas, start, next: i};
}

const report = {scope:'Native Design live tool events with simulated model frames, no inference', binary, cases:[]};
try {
  const result = await exited;
  if (failure) throw failure;
  assert.deepEqual(result, {code:0, signal:null});

  const writeBegin = events.findIndex(e => e.type === 'tool_call_begin' && e.name === 'write');
  assert.ok(writeBegin >= 0, 'no tool_call_begin for write');
  const pathParam = events.findIndex((e, i) => i > writeBegin && e.type === 'tool_call_param');
  assert.deepEqual(events[pathParam], {type:'tool_call_param', param:'path', path:''});
  const body = bodyAfter(writeBegin, 'content');
  assert.deepEqual(events[body.start], {type:'tool_call_param', param:'content', path:'notes.txt'});
  assert.equal(body.text, CONTENT, 'streamed write body differs from the bytes the model wrote');
  assert.ok(body.deltas >= 4, `expected batched deltas, got ${body.deltas}`);
  const writeCall = events.findIndex(e => e.type === 'tool_call' && e.name === 'write');
  assert.ok(writeCall > body.next - 1, 'tool_call must follow the streamed preview');
  report.cases.push({name:'write preview equals saved bytes', deltas:body.deltas, status:'PASS'});

  const deltaSizes = events.filter(e => e.type === 'tool_body_delta').map(e => Buffer.byteLength(e.text));
  assert.ok(Math.max(...deltaSizes) <= 384 + 4, `a delta exceeded the batch cap: ${Math.max(...deltaSizes)}`);
  assert.ok(!events.some(e => e.type === 'tool_body_delta' && e.text.includes('｜DSML｜')), 'DSML markup leaked into a delta');
  report.cases.push({name:'deltas are capped, UTF-8 and free of DSML markup', maxBytes:Math.max(...deltaSizes), status:'PASS'});

  const editBegin = events.findIndex(e => e.type === 'tool_call_begin' && e.name === 'edit');
  assert.ok(editBegin > writeCall);
  const oldBody = bodyAfter(editBegin, 'old');
  assert.deepEqual(events[oldBody.start], {type:'tool_call_param', param:'old', path:'notes.txt'});
  assert.equal(oldBody.text, OLD);
  const newBody = bodyAfter(editBegin, 'new');
  assert.equal(newBody.text, NEW);
  assert.equal(fs.readFileSync(notes, 'utf8'), FINAL);
  report.cases.push({name:'edit preview streams old then new', status:'PASS'});

  const truncated = events.findLastIndex(e => e.type === 'tool_call_begin' && e.name === 'write');
  assert.ok(truncated > editBegin);
  assert.equal(bodyAfter(truncated, 'content').text, 'unfinished bytes', 'an unclosed stanza keeps its streamed bytes');
  assert.equal(fs.existsSync(pending), false);
  report.cases.push({name:'a truncated stanza is previewed but never executed', status:'PASS'});
  console.log(`design_tool_stream_test: ok (${report.cases.length} cases; real runtime, simulated model)`);
} catch (error) {
  failure = error;
  report.error = error.stack;
  process.exitCode = 1;
  console.error(error);
} finally {
  clearTimeout(timeout);
  fs.writeFileSync(path.join(output, 'stdout.bin'), stdoutBytes);
  fs.writeFileSync(path.join(output, 'stderr.txt'), stderr);
  fs.writeFileSync(path.join(output, 'events.json'), JSON.stringify(events.filter(e => e.type !== 'model_request'), null, 1));
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({...report, pass:!failure, requests}, null, 2));
  console.log('Evidence: ' + output);
}

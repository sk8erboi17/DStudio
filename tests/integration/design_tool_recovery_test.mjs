// Actual native Design loop with deliberately truncated model frames.
// The model responses are simulated; this tests dispatch/recovery, not inference.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const artifacts = path.join(root, 'tests/.artifacts');
fs.mkdirSync(artifacts, {recursive:true});
const output = fs.mkdtempSync(path.join(artifacts, 'design-tool-recovery-'));
const workspace = path.join(output, 'workspace');
fs.mkdirSync(workspace);
const stable = path.join(workspace, 'stable.txt');
const pending = path.join(workspace, 'pending.txt');
const invoke = (name, args) => `<｜DSML｜invoke name="${name}">` +
  Object.entries(args).map(([name, value]) => `<｜DSML｜parameter name="${name}" string="true">${value}</｜DSML｜parameter>`).join('') +
  '</｜DSML｜invoke>';
const batch = (...calls) => '<｜DSML｜tool_calls>' + calls.join('') + '</｜DSML｜tool_calls>';
const todo = status => invoke('todo_write', {todos:JSON.stringify([{text:'Save both complete files', status}])});
const write = (name, content) => invoke('write', {path:name, content});

let stdout = '', stderr = '', tail = '', requests = 0, started = false, failure;
const child = spawn(path.join(root, 'ds4/ds4-design'), [
  '--remote-base-url', 'http://127.0.0.1:1', '--remote-model', 'truncation-fixture',
  '--workspace', workspace, '--jsonl', '--nothink', '-c', '16384', '-n', '8192'
], {cwd:root, env:{...process.env, DSTUDIO_DESIGN_CACHE_DIR:path.join(output, 'cache')},
  stdio:['pipe','pipe','pipe']});
const fail = error => { failure ||= error; if(child.exitCode === null) child.kill('SIGKILL'); };
const exited = new Promise(resolve => {
  child.once('error', error => { failure = error; resolve({error:error.message}); });
  child.once('close', (code, signal) => resolve({code, signal}));
});
const timeout = setTimeout(() => fail(Error('Native recovery test exceeded 30 seconds')), 30000);
child.stdin.on('error', fail);
function modelRequest(event) {
  requests++;
  let text;
  if(requests === 1) text = batch(todo('in_progress'), write('stable.txt', 'Previously saved.'));
  else if(requests === 2) {
    assert.equal(fs.readFileSync(stable, 'utf8'), 'Previously saved.');
    text = '<｜DSML｜tool_calls>' + write('stable.txt', 'Must not be saved.') +
      '<｜DSML｜invoke name="write"><｜DSML｜parameter name="path" string="true">pending.txt</｜DSML｜parameter>' +
      '<｜DSML｜parameter name="content" string="true">unfinished bytes';
  } else if(requests === 3) {
    assert.equal(fs.readFileSync(stable, 'utf8'), 'Previously saved.', 'Unclosed batch overwrote a prior round');
    assert.equal(fs.existsSync(pending), false, 'Partial content was saved');
    const messages = JSON.parse(event.body).messages;
    const tool = messages.filter(message => message.role === 'tool').at(-1);
    assert.ok(tool, 'Recovery was not supplied as a tool response');
    assert.match(tool.content, /No calls in this batch were executed/);
    assert.match(tool.content, /one smaller complete call per round/);
    text = batch(write('stable.txt', 'First complete retry.'));
  } else if(requests === 4) {
    assert.equal(fs.readFileSync(stable, 'utf8'), 'First complete retry.');
    assert.equal(fs.existsSync(pending), false);
    text = batch(write('pending.txt', 'Second complete retry.'));
  } else if(requests === 5) {
    assert.equal(fs.readFileSync(pending, 'utf8'), 'Second complete retry.');
    text = batch(todo('completed'));
  } else {
    assert.equal(requests, 6, 'Unexpected extra recovery loop');
    text = 'Both files are complete.';
  }
  child.stdin.write('\x1e' + JSON.stringify({type:'model_delta', id:event.id, kind:'content', text}) + '\n' +
    '\x1e' + JSON.stringify({type:'model_done', id:event.id}) + '\n');
}
child.stdout.setEncoding('utf8');
child.stderr.setEncoding('utf8');
child.stdout.on('data', chunk => {
  stdout += chunk; tail += chunk;
  const lines = tail.split('\n'); tail = lines.pop();
  for(const line of lines) {
    const marker = line.indexOf('\x1e'); if(marker < 0) continue;
    try {
      const event = JSON.parse(line.slice(marker + 1));
      if(event.type === 'model_request') modelRequest(event);
    } catch(error) { fail(error); }
  }
});
child.stderr.on('data', chunk => {
  stderr += chunk;
  const waiting = (stderr.match(/\+DWARFSTAR_WAITING/g) || []).length;
  if(waiting && !started) {
    started = true;
    child.stdin.write('Create two local text files directly, recording the work in a todo plan.\n');
  } else if(waiting >= 2) child.stdin.end();
});
try {
  const result = await exited;
  if(failure) throw failure;
  assert.deepEqual(result, {code:0, signal:null});
  assert.equal(requests, 6);
  assert.equal(fs.readFileSync(stable, 'utf8'), 'First complete retry.');
  assert.equal(fs.readFileSync(pending, 'utf8'), 'Second complete retry.');
  console.log('design_tool_recovery_test: ok (real runtime, simulated model, exact saved bytes)');
} catch(error) {
  failure = error; throw error;
} finally {
  clearTimeout(timeout);
  fs.writeFileSync(path.join(output, 'stdout.txt'), stdout);
  fs.writeFileSync(path.join(output, 'stderr.txt'), stderr);
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({
    scope:'Native Design recovery with simulated model frames, no inference',
    pass:!failure, requests, error:failure?.message
  }, null, 2));
  console.log('Evidence: ' + output);
}

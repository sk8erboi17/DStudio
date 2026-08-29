import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const designBin = path.join(root, 'ds4', 'ds4-design');
assert.equal(fs.existsSync(designBin), true, 'ds4-design must be built');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ds4-design-interrupt-'));
const workspace = path.join(tmp, 'workspace');
const home = path.join(tmp, 'home');
fs.mkdirSync(workspace, { recursive: true });
fs.mkdirSync(home, { recursive: true });

let child;
let stdout = '';
let stderr = '';
let stdoutTail = '';
let waitingCount = 0;
let requestCount = 0;
let resumed = false;
let interrupted = false;
let firstPromptSent = false;
let secondPromptSent = false;
let inputEnded = false;
let resolveDone;
let rejectDone;
const completed = new Promise((resolve, reject) => {
  resolveDone = resolve;
  rejectDone = reject;
});

function modelFrames(id, content) {
  return `\x1e${JSON.stringify({ type: 'model_delta', id, kind: 'content', text: content })}\n` +
    `\x1e${JSON.stringify({ type: 'model_done', id })}\n`;
}

function handleEvent(event) {
  if (event.type === 'turn_interrupted') interrupted = true;
  if (event.type !== 'model_request') return;
  requestCount++;
  if (requestCount === 1) {
    /* This mirrors the launcher's remote-Design interrupt: the control frame
     * wakes the model-frame reader and SIGINT latches cancellation. */
    child.stdin.write('\x1e{"type":"control","name":"interrupt"}\n');
    child.kill('SIGINT');
    return;
  }
  if (requestCount === 2) {
    child.stdin.write(modelFrames(event.id, 'resumed successfully'));
    resumed = true;
  }
}

const timeout = setTimeout(() => {
  rejectDone(new Error(`interrupt test timed out\nSTDERR:\n${stderr}\nSTDOUT:\n${stdout}`));
  child?.kill('SIGKILL');
}, 20_000);

try {
  child = spawn(designBin, [
    '--remote-base-url', 'http://127.0.0.1:1',
    '--remote-model', 'interrupt-fixture',
    '--workspace', workspace,
    '--jsonl', '--nothink', '-c', '4096', '-n', '256',
  ], {
    cwd: root,
    env: { ...process.env, HOME: home },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');

  child.stdout.on('data', (chunk) => {
    stdout += chunk;
    stdoutTail += chunk;
    for (;;) {
      const nl = stdoutTail.indexOf('\n');
      if (nl < 0) break;
      const line = stdoutTail.slice(0, nl);
      stdoutTail = stdoutTail.slice(nl + 1);
      const marker = line.indexOf('\x1e');
      if (marker < 0) continue;
      try { handleEvent(JSON.parse(line.slice(marker + 1))); } catch {}
    }
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
    waitingCount = (stderr.match(/\+DWARFSTAR_WAITING/g) || []).length;
    if (waitingCount === 1 && !firstPromptSent) {
      firstPromptSent = true;
      child.stdin.write('First turn must be interrupted while its model stream is open.\n');
    } else if (waitingCount >= 2 && interrupted && !secondPromptSent) {
      secondPromptSent = true;
      child.stdin.write('Second turn must prove that the same runtime still accepts prompts.\n');
    } else if (waitingCount >= 3 && resumed && !inputEnded) {
      inputEnded = true;
      child.stdin.end();
    }
  });
  child.once('error', rejectDone);
  child.once('exit', (code, signal) => resolveDone({ code, signal }));

  const exit = await completed;
  assert.deepEqual(exit, { code: 0, signal: null },
    `Design engine must survive SIGINT and exit only after stdin EOF\n${stderr}\n${stdout}`);
  assert.equal(interrupted, true, 'turn_interrupted event must be emitted');
  assert.equal(requestCount, 2, 'the same process must accept a second model turn');
  assert.ok(waitingCount >= 3, 'the runtime must announce WAITING after the interrupted and resumed turns');
  assert.match(stdout, /turn interrupted; design runtime remains ready/);
  assert.match(stdout, /resumed successfully/);
  console.log('design_interrupt_test: ok');
} finally {
  clearTimeout(timeout);
  if (child && child.exitCode === null) child.kill('SIGKILL');
  fs.rmSync(tmp, { recursive: true, force: true });
}

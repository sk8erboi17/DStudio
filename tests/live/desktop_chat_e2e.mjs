// Native macOS window/keyboard/AX + real local model. No page JavaScript,
// headless browser, simulated response, or direct inference request.
// Attach only to an explicitly selected, task-owned test .app already on Chat.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { artifactRunDir, sleep } from '../support/real_harness.mjs';

assert.equal(process.platform, 'darwin');
const directory = fs.realpathSync(process.argv[2]);
assert.ok(directory.startsWith(path.resolve('tests/.artifacts/desktop-e2e-')), 'only a task-owned desktop test directory');
const pid = Number(process.argv[3]);
assert.ok(Number.isSafeInteger(pid) && pid > 1);
const base = new URL(process.argv[4]);
assert.equal(base.hostname, '127.0.0.1'); assert.equal(base.protocol, 'http:');
const app = path.join(directory, 'DStudio.app/Contents/MacOS/DStudio');
const observed = execFileSync('ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf8' }).trim();
assert.equal(fs.realpathSync(observed), fs.realpathSync(app), 'never type into an unrelated application');
const processIdentity = () => execFileSync('ps', ['-p', String(pid), '-o', 'uid=,lstart=,comm='],
  {encoding: 'utf8', timeout: 5000}).trim();
const admittedProcess = processIdentity();
const expectedModelFile = process.argv[5] || null;
const run = artifactRunDir('desktop-chat');
const report = { schema: 'dstudio.desktop-chat.v1', started: new Date().toISOString(),
  scope: 'Real foreground .app, native AX/keyboard interaction and actual local model; one Chat workflow, not four-mode or general quality qualification',
  directory, pid, base: base.origin, admittedProcess, expectedModelFile,
  appSha256: crypto.createHash('sha256').update(fs.readFileSync(app)).digest('hex'),
  visualReview: 'PENDING: screenshots must be opened and reviewed', actions: [] };
console.log(`Evidence: ${run}`);
const save = () => fs.writeFileSync(path.join(run, 'results.json'), JSON.stringify(report, null, 2) + '\n');
const json = async route => {
  const res = await fetch(new URL(route, base), { signal: AbortSignal.timeout(5000) });
  assert.equal(res.status, 200); return res.json();
};
const owner = `tell (first application process whose unix id is ${pid})`;
function ax(lines, activate = false) {
  assert.equal(processIdentity(), admittedProcess, 'desktop process identity changed before interaction');
  const args = ['tell application "System Events"', owner,
    ...(activate ? ['set frontmost to true'] : []),
    'if not frontmost then error "test application is not foreground"', ...lines, 'end tell', 'end tell'];
  const started = performance.now();
  const result = execFileSync('osascript', args.flatMap(x => ['-e', x]), {
    encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024,
  }).trim();
  report.actions.push({ commands: lines, activate, result, seconds: (performance.now() - started) / 1000 }); save();
  return result;
}
function screenshot(name) {
  const swift = 'import Foundation; import CoreGraphics; if let rows = CGWindowListCopyWindowInfo(.optionOnScreenOnly, kCGNullWindowID) as? [[String: Any]] { ' +
    `let matches = rows.filter { ($0[kCGWindowOwnerPID as String] as? Int) == ${pid} && ($0[kCGWindowLayer as String] as? Int) == 0 }; ` +
    'print(String(data: try JSONSerialization.data(withJSONObject: matches), encoding: .utf8)!) }';
  const rows = JSON.parse(execFileSync('swift', ['-e', swift], { encoding: 'utf8', timeout: 60000 }));
  assert.equal(rows.length, 1, 'exactly one owned visible app window');
  report.window = rows[0];
  execFileSync('screencapture', ['-x', '-l', String(rows[0].kCGWindowNumber), path.join(run, name)], { timeout: 15000 });
}
const conversation = 'group "Current conversation" of UI element 1 of scroll area 1 of group 1 of group 1 of window 1';
const composer = `group 1 of group 3 of ${conversation}`;
const prompt = 'Return only a JSON object with keys total and city. Add 7, 11 and 5 for total. The city must be Torino. Do not include Markdown or explanations.';
try {
  report.before = await json('/api/status');
  assert.equal(report.before.webdir, path.join(directory, 'profile'), 'isolated native profile');
  assert.equal(report.before.mode, 'server'); assert.equal(report.before.ready, true);
  if (expectedModelFile) assert.equal(report.before.modelFile, expectedModelFile, 'the requested model must actually be loaded');
  report.models = await json('/v1/models');
  const initial = await json('/api/store');
  report.beforeRevision = initial.rev;
  const initialMessageIds = new Set((initial.data?.chats || []).flatMap(chat =>
    (chat.messages || []).map(message => message.id)));
  ax([], true);
  assert.equal(ax([`get value of text area "Message" of ${composer}`]), '', 'do not overwrite an existing draft');
  screenshot('before.png');
  ax([`click text area "Message" of ${composer}`, `keystroke ${JSON.stringify(prompt)}`]);
  // AX keystroke returns before WebKit has necessarily consumed its queued key
  // events. Wait for the exact draft, never send a prefix or accept a mismatch.
  let draft = '';
  const inputDeadline = Date.now() + 5000;
  do {
    draft = ax([`get value of text area "Message" of ${composer}`]);
    if (draft === prompt) break;
    await sleep(50);
  } while (Date.now() < inputDeadline);
  assert.equal(draft, prompt, 'real keyboard input must reach the intended field');
  report.prompt = prompt; report.expected = { total: 7 + 11 + 5, city: 'Torino' };
  ax([`click button "Send message" of ${composer}`]);
  const until = Date.now() + 300000;
  let answer;
  while (Date.now() < until) {
    const store = await json('/api/store');
    const chats = store.data?.chats || [];
    for (const chat of chats) {
      const messages = chat.messages || [];
      const index = messages.findIndex(message => message.id && !initialMessageIds.has(message.id) &&
        message.role === 'user' && message.content === prompt);
      // A previous successful copy of this prompt is not a new desktop turn.
      // The adjacent response must belong to the input just submitted, never
      // to a later user turn or an already persisted answer.
      const candidate = index < 0 ? null : messages[index + 1];
      if (candidate?.id && !initialMessageIds.has(candidate.id) &&
          candidate.role === 'assistant' && candidate.content) answer = candidate;
      if (answer) break;
    }
    if (answer && !answer.streaming && answer.status !== 'streaming') {
      report.storeRevision = store.rev; report.answer = answer; save(); break;
    }
    await sleep(1000);
  }
  assert.ok(answer, 'model response must be persisted after submission through the actual desktop UI');
  assert.ok(!answer.streaming && answer.status !== 'streaming', 'response must finish before the deadline');
  assert.ok(!answer.error, 'a partial response with an error is not a completed turn');
  assert.deepEqual(JSON.parse(answer.content), report.expected, 'independently checked answer and requested format');
  const tree = ax(['get entire contents of window 1']);
  assert.ok(tree.includes('static text ' + answer.content + ' of '),
    'the final answer itself, not only matching words in the prompt, must be in the native accessibility tree');
  fs.writeFileSync(path.join(run, 'answer.ax.txt'), tree, { flag: 'wx' });
  screenshot('answer.png');
  report.after = await json('/api/status');
  assert.equal(report.after.ds4dir, report.before.ds4dir);
  assert.equal(report.after.modelFile, report.before.modelFile, 'no hidden model switch');
  report.status = 'pass';
} catch (error) {
  report.status = 'fail'; report.error = error.stack; process.exitCode = 1;
  try { screenshot('failure.png'); } catch (captureError) { report.captureError = captureError.message; }
}
report.finished = new Date().toISOString(); save();
console.log(`${report.status}: actual native desktop Chat; visual review remains separate`);

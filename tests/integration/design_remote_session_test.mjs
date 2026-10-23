// The actual native Design runtime in remote-model mode (llama.cpp, MLX, a
// LAN host): a conversation saved at the end of a turn must survive a runtime
// restart. After /switch the next model request must carry the previous
// messages byte for byte behind the current system prompt; a damaged file must
// restore nothing. Model frames are SIMULATED; no inference.
//   node tests/integration/design_remote_session_test.mjs <ds4-design>
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '../..');
const binary = path.resolve(process.argv[2] || path.join(root, 'ds4/ds4-design'));
fs.mkdirSync(path.join(root, 'tests/.artifacts'), { recursive: true });
const output = fs.mkdtempSync(path.join(root, 'tests/.artifacts/design-remote-session-'));
const workspace = path.join(output, 'workspace'), cache = path.join(output, 'cache');
fs.mkdirSync(workspace);
const report = { scope: 'Real native Design processes, files and a restart; SIMULATED model frames; no inference', binary, checks: [] };
const CLOSE = '</｜DSML｜parameter>';
// Design writes after a plan exists, as in its other runtime tests.
const write = (file, content) => '<｜DSML｜tool_calls>' +
  `<｜DSML｜invoke name="todo_write"><｜DSML｜parameter name="todos" string="true">${JSON.stringify([{ text: 'Write the notes', status: 'in_progress' }])}${CLOSE}</｜DSML｜invoke>` +
  '<｜DSML｜invoke name="write">' +
  `<｜DSML｜parameter name="path" string="true">${file}${CLOSE}` +
  `<｜DSML｜parameter name="content" string="true">${content}${CLOSE}</｜DSML｜invoke></｜DSML｜tool_calls>`;

function design() {
  const child = spawn(binary, ['--remote-base-url', 'http://127.0.0.1:1', '--remote-model', 'restore-fixture',
    '--workspace', workspace, '--jsonl', '--nothink', '-c', '16384', '-n', '2048'],
  { cwd: root, env: { ...process.env, DSTUDIO_DESIGN_CACHE_DIR: cache }, stdio: ['pipe', 'pipe', 'pipe'] });
  const state = { events: [], requests: [], stderr: '', reply: null };
  let tail = '';
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => { state.stderr += d; });
  child.stdout.on('data', (d) => {
    tail += d;
    const lines = tail.split('\n'); tail = lines.pop();
    for (const line of lines) {
      const at = line.indexOf('\x1e'); if (at < 0) continue;
      let ev; try { ev = JSON.parse(line.slice(at + 1)); } catch { continue; }
      state.events.push(ev);
      if (ev.type !== 'model_request') continue;
      state.requests.push(JSON.parse(ev.body));
      const text = state.reply(state.requests.length);
      child.stdin.write('\x1e' + JSON.stringify({ type: 'model_delta', id: ev.id, kind: 'content', text }) + '\n' +
        '\x1e' + JSON.stringify({ type: 'model_done', id: ev.id }) + '\n');
    }
  });
  const waiting = () => (state.stderr.match(/\+DWARFSTAR_WAITING/g) || []).length;
  const until = async (test, what) => {
    for (let i = 0; i < 400; i++) { if (test()) return; await new Promise((r) => setTimeout(r, 25)); }
    throw new Error(`timed out waiting for ${what}\n${state.stderr.slice(-1200)}`);
  };
  const send = async (line) => { const n = waiting(); child.stdin.write(line + '\n'); await until(() => waiting() > n, JSON.stringify(line)); };
  const status = (re) => state.events.filter((e) => e.type === 'session_status').map((e) => e.message).find((m) => re.test(m));
  return { child, state, send, until, status, ready: () => until(() => waiting() > 0, 'startup') };
}
const check = (name) => report.checks.push({ name, status: 'PASS' });
const live = [];
try {
  const first = design(); live.push(first.child);
  await first.ready();
  first.state.reply = (n) => (n === 1 ? write('notes.txt', 'Palette: sea blue\n') : 'Notes written.');
  await first.send('Write the palette notes.');
  assert.equal(fs.readFileSync(path.join(workspace, 'notes.txt'), 'utf8'), 'Palette: sea blue\n');
  const dir = path.join(cache, 'remote-sessions');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  assert.equal(files.length, 1, 'the turn was saved');
  const sha = files[0].slice(0, 8);
  await first.send('/list');
  const listed = first.state.events.filter((e) => e.type === 'sessions').at(-1);
  assert.deepEqual(listed.sessions.map((s) => [s.sha, s.current, s.transcriptOnly]), [[sha, true, true]]);
  const before = first.state.requests.at(-1).messages;
  check('turn saved and listed as current');
  first.child.kill('SIGKILL'); live.length = 0;

  const second = design(); live.push(second.child);
  await second.ready();
  await second.send(`/switch ${sha}`);
  assert.ok(second.status(new RegExp(`^switched to ${sha}`)), 'switch reported');
  second.state.reply = () => 'The notes say sea blue.';
  await second.send('What do the notes say?');
  const restored = second.state.requests[0].messages;
  assert.equal(restored[0].role, 'system');
  assert.deepEqual(restored.slice(1, -1), [...before.slice(1), { role: 'assistant', content: 'Notes written.' }],
    'the previous messages are resent unchanged');
  assert.deepEqual(restored.at(-1), { role: 'user', content: 'What do the notes say?' });
  check('restored conversation resent byte for byte after a restart');

  const file = path.join(dir, files[0]);
  const good = fs.readFileSync(file);
  fs.writeFileSync(file, good.subarray(0, good.length - 40));
  await second.send(`/switch ${sha}`);
  assert.ok(second.status(/^switch failed: session [0-9a-f]{8} is damaged or from another format; nothing restored/));
  second.state.requests.length = 0;
  second.state.reply = () => 'Still here.';
  await second.send('Are you there?');
  assert.ok(second.state.requests[0].messages.some((m) => m.content === 'What do the notes say?'), 'a failed restore keeps the live conversation');
  check('damaged file restores nothing');
  fs.writeFileSync(file, good);
  await second.send(`/del ${sha}`);
  assert.ok(second.status(new RegExp(`^deleted ${sha}`)));
  assert.equal(fs.existsSync(file), false);
  check('delete');
  report.status = 'PASS';
} catch (error) {
  report.status = 'FAIL'; report.error = String(error.stack || error); process.exitCode = 1;
} finally {
  for (const child of live) child.kill('SIGKILL');
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  if (report.error) console.log(report.error);
  console.log(`design_remote_session_test: ${report.status} ${report.checks.length} checks (real runtime and restart; simulated model frames); ${output}`);
}

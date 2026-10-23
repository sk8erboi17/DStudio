// The actual native Agent and Cowork runtimes in structured remote mode (the
// llama.cpp/MLX path): a conversation saved at the end of a turn must survive
// a runtime restart. After /switch, the next model request must carry the
// previous conversation byte for byte, and an old tool call must never run
// again. Model frames are SIMULATED; no inference.
//   node tests/integration/remote_session_restore_test.mjs <ds4-agent-jsonl>...
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { artifactRunDir, writeArtifact } from '../support/real_harness.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const binaries = process.argv.slice(2).map((p) => fs.realpathSync(p));
assert(binaries.length, 'Supply already-built native Agent binaries; no implicit build or weights');
const output = artifactRunDir('remote-session-restore');
const receipt = { scope: 'Real native Agent/Cowork processes, files and restarts; SIMULATED model frames; no inference', rows: [] };
const frame = (value) => '\x1e' + JSON.stringify(value) + '\n';
const STORY = 'The keeper read the note twice.\n';

// One runtime process, driven line by line like the host drives it.
function runtime(binary, kind, work, sessions) {
  const child = spawn(binary, ['--non-interactive', '--jsonl', '--remote-base-url', 'http://127.0.0.1:1',
    '--remote-model', 'restore-fixture', '--nothink', '-c', '8192', '-n', '256', '--chdir', work],
  { cwd: work, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env,
    DS4UI_REMOTE_TOOL_PROTOCOL: 'openai', DS4UI_RUNTIME_NAME: kind, DS4UI_REMOTE_VISION: '',
    DS4UI_COWORK_HELPER: path.join(root, 'src/harness/cowork/office_tool.py'),
    DSTUDIO_STEER_PORT: '', DSTUDIO_STEER_KEY: '', DS4UI_SESSION_CACHE_DIR: sessions } });
  const state = { stdout: '', stderr: '', requests: [], waiting: 0, handler: null };
  let tail = '';
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => { state.stderr += d; state.waiting = (state.stderr.match(/\+DWARFSTAR_WAITING/g) || []).length; });
  child.stdout.on('data', (d) => {
    state.stdout += d; tail += d;
    const lines = tail.split('\n'); tail = lines.pop();
    for (const line of lines) {
      const at = line.indexOf('\x1e'); if (at < 0) continue;
      let event; try { event = JSON.parse(line.slice(at + 1)); } catch { continue; }
      if (event.type !== 'model_request') continue;
      state.requests.push(JSON.parse(event.body));
      child.stdin.write(state.handler(event.id, state.requests.length));
    }
  });
  const until = async (test, what) => {
    for (let i = 0; i < 400; i++) { if (test()) return; await new Promise((r) => setTimeout(r, 25)); }
    throw new Error(`${kind}: timed out waiting for ${what}\n${state.stdout.slice(-1500)}\n${state.stderr.slice(-800)}`);
  };
  const send = async (line) => {
    const before = state.waiting;
    child.stdin.write(line + '\n');
    await until(() => state.waiting > before, `the turn after ${JSON.stringify(line)}`);
  };
  return { child, state, until, send, ready: () => until(() => state.waiting > 0, 'startup') };
}

const toolTurn = (writeName, id) => (rid, n) => n === 1
  ? frame({ type: 'model_tool_calls', id: rid, text: JSON.stringify([{ id, type: 'function',
    function: { name: writeName, arguments: JSON.stringify({ path: 'story.md', content: STORY }) } }]) }) +
    frame({ type: 'model_done', id: rid, text: 'tool_calls' })
  : frame({ type: 'model_delta', id: rid, kind: 'content', text: 'Saved.' }) + frame({ type: 'model_done', id: rid, text: 'stop' });
const answer = (text) => (rid) => frame({ type: 'model_delta', id: rid, kind: 'content', text }) + frame({ type: 'model_done', id: rid, text: 'stop' });

for (const binary of binaries) for (const kind of ['agent', 'cowork']) {
  const row = { binary, runtime: kind, status: 'running', checks: [] };
  receipt.rows.push(row);
  const work = path.join(output, `${receipt.rows.length}-${kind}`), sessions = path.join(work, '.sessions');
  fs.mkdirSync(work, { recursive: true });
  const live = [], procs = [];
  try {
    // First process: one tool round, then an answer; the turn ends with a save.
    const first = runtime(binary, kind, work, sessions); live.push(first.child); procs.push(first);
    await first.ready();
    const writeName = 'write';
    first.state.handler = toolTurn(writeName, 'w1');
    await first.send('Write the story.');
    assert.equal(fs.readFileSync(path.join(work, 'story.md'), 'utf8'), STORY);
    const saved = first.state.stdout.match(/saved session ([0-9a-f]{8}) \((\d+) messages\)/);
    assert.ok(saved, 'the end-of-turn autosave is announced');
    const files = fs.readdirSync(path.join(sessions, 'remote-sessions')).filter((f) => f.endsWith('.jsonl'));
    assert.equal(files.length, 1);
    assert.ok(files[0].startsWith(saved[1]));
    const before = first.state.requests.at(-1).messages;
    row.checks.push('turn saved');
    first.child.kill('SIGKILL'); live.length = 0;
    const storyStat = fs.statSync(path.join(work, 'story.md'));

    // Restart: a new process restores the conversation.
    const second = runtime(binary, kind, work, sessions); live.push(second.child); procs.push(second);
    await second.ready();
    await second.send(`/switch ${saved[1]}`);
    assert.match(second.state.stdout, new RegExp(`switched to session ${saved[1]} \\(${saved[2]} messages restored`));
    second.state.handler = answer('You wrote the keeper story to story.md.');
    await second.send('What did you write?');
    const restored = second.state.requests[0].messages;
    // Everything after the system prompt, exactly as before, then the new message.
    const assistantFinal = { role: 'assistant', content: 'Saved.' };
    assert.deepEqual(restored.slice(1, -1), [...before.slice(1), assistantFinal], 'the previous conversation is resent unchanged');
    // The runtime keeps the input line as received (with its line break), as
    // in the first process: compare with how that process sent its own prompt.
    assert.equal(before[1].content, 'Write the story.\n');
    assert.deepEqual(restored.at(-1), { role: 'user', content: 'What did you write?\n' });
    assert.equal(restored[0].role, 'system');
    row.checks.push('restored conversation resent byte for byte');

    // An old call ID can never be admitted again in the restored session.
    second.state.requests.length = 0;
    second.state.handler = toolTurn(writeName, 'w1');
    await second.send('Write it again.');
    assert.match(second.state.stdout, /Tool call ID already admitted in this session; no tool replayed/);
    assert.equal(fs.statSync(path.join(work, 'story.md')).mtimeMs, storyStat.mtimeMs, 'no effect was replayed');
    row.checks.push('old tool call not replayed');

    // List, damaged file, delete.
    await second.send('/list');
    assert.match(second.state.stdout, new RegExp(`${saved[1]} > Write the story`));
    const file = path.join(sessions, 'remote-sessions', files[0]);
    const good = fs.readFileSync(file);
    fs.writeFileSync(file, good.subarray(0, good.length - 20));
    const n = second.state.stdout.length;
    await second.send(`/switch ${saved[1]}`);
    assert.match(second.state.stdout.slice(n), /switch failed: session [0-9a-f]{8} is damaged or from another format; nothing restored/);
    second.state.requests.length = 0;
    second.state.handler = answer('Still here.');
    await second.send('Are you there?');
    assert.ok(second.state.requests[0].messages.some((m) => m.content === 'What did you write?\n'), 'a failed restore keeps the live conversation');
    fs.writeFileSync(file, good);
    await second.send(`/del ${saved[1]}`);
    assert.match(second.state.stdout, new RegExp(`deleted session ${saved[1]}`));
    row.checks.push('list, damaged restore, delete');
    row.status = 'PASS';
  } catch (error) {
    row.status = 'FAIL'; row.error = String(error.stack || error); process.exitCode = 1;
    row.output = procs.map((p) => ({ stdout: p.state.stdout.slice(-3000), stderr: p.state.stderr.slice(-1500) }));
  } finally {
    for (const child of live) child.kill('SIGKILL');
  }
  writeArtifact(output, 'results.json', receipt);
  console.log(`${row.status} ${kind} ${path.basename(path.dirname(binary))}${row.error ? `\n${row.error}` : ''}`);
}
const passed = receipt.rows.filter((r) => r.status === 'PASS').length;
console.log(`remote_session_restore_test: ${passed}/${receipt.rows.length} passed (real runtimes and restarts; simulated model frames); ${output}`);

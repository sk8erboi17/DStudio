// The contract between the REAL native runtimes and the host's slot-snapshot
// triggers (src/dstudio_kv_snapshot.c): what Agent and Cowork print on stdout,
// and Design on stderr, when a transcript is durable, restored or deleted must
// be read by the PRODUCTION parser as exactly that, with the right session and
// message count, and nothing else on that stream in those turns may be read as
// an announcement. Real runtime processes, files and restarts; model frames
// are SIMULATED; the lines are cut the way the host's scanner cuts them (511
// bytes).
//   node tests/integration/llama_kv_snapshot_runtime_test.mjs <llama_kv_snapshot_unit> <ds4-agent-jsonl>... [<ds4-design>]
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { artifactRunDir, writeArtifact } from '../support/real_harness.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const [probe, ...binaries] = process.argv.slice(2).map((p) => fs.realpathSync(p));
assert(probe && binaries.length, 'Supply the built probe and already-built runtime binaries; nothing is built here');
const output = artifactRunDir('llama-kv-snapshot-runtime');
const receipt = { scope: 'Real native runtime processes and their actual output; production line parser; SIMULATED model frames; no inference', rows: [] };
const frame = (value) => '\x1e' + JSON.stringify(value) + '\n';

// The host scans complete lines, cutting any line at 511 bytes (scan_lines).
function classify(stream, form) {
  const lines = [];
  for (const line of stream.split('\n')) {
    const bytes = Buffer.from(line);
    for (let at = 0; at < bytes.length || at === 0; at += 511) { lines.push(bytes.subarray(at, at + 511).toString('latin1')); if (!bytes.length) break; }
  }
  const result = spawnSync(probe, ['--parse-lines', form], { input: Buffer.from(lines.join('\n') + '\n', 'latin1'), encoding: 'utf8', maxBuffer: 64 << 20 });
  assert.equal(result.status, 0, result.stderr);
  const parsed = result.stdout.trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(parsed.length, lines.length);
  return parsed.filter((p) => p.kind !== 'none');
}

// form: which stream the host reads this runtime's announcements from.
function start(binary, argv, env, cwd, form) {
  const child = spawn(binary, argv, { cwd, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...env } });
  const state = { stdout: '', stderr: '', requests: 0, handler: null, mark: 0 };
  const announced = () => (form === 'design' ? state.stderr : state.stdout);
  let tail = '';
  child.stdout.setEncoding('latin1'); child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => { state.stderr += d; });
  child.stdout.on('data', (d) => {
    state.stdout += d; tail += d;
    const lines = tail.split('\n'); tail = lines.pop();
    for (const line of lines) {
      const at = line.indexOf('\x1e'); if (at < 0) continue;
      let event; try { event = JSON.parse(line.slice(at + 1)); } catch { continue; }
      if (event.type === 'model_request') child.stdin.write(state.handler(event.id, ++state.requests));
    }
  });
  const waiting = () => (state.stderr.match(/\+DWARFSTAR_WAITING/g) || []).length;
  const until = async (test, what) => {
    for (let i = 0; i < 400; i++) { if (test()) return; await new Promise((r) => setTimeout(r, 25)); }
    throw new Error(`timed out waiting for ${what}\n${state.stdout.slice(-1500)}\n${state.stderr.slice(-800)}`);
  };
  // Everything the runtime printed for one input, classified by the production parser.
  const send = async (line) => {
    const before = waiting(); state.mark = announced().length;
    child.stdin.write(line + '\n');
    await until(() => waiting() > before, JSON.stringify(line));
    await new Promise((r) => setTimeout(r, 50)); // the two pipes are independent: let stdout arrive
    return classify(announced().slice(state.mark), form);
  };
  return { child, state, send, ready: () => until(() => waiting() > 0, 'startup') };
}

// A reply that itself talks about sessions, inside prose: not an announcement.
const PROSE = 'I saved session notes earlier; the log says "saved session 0000aaaa (3 messages)" somewhere.';
const text = (reply) => (rid) => frame({ type: 'model_delta', id: rid, kind: 'content', text: reply }) + frame({ type: 'model_done', id: rid, text: 'stop' });

async function agentCase(binary, kind, work) {
  const sessions = path.join(work, '.sessions');
  const launch = () => start(binary, ['--non-interactive', '--jsonl', '--remote-base-url', 'http://127.0.0.1:1', '--remote-model', 'snapshot-fixture',
    '--nothink', '-c', '8192', '-n', '256', '--chdir', work], { DS4UI_REMOTE_TOOL_PROTOCOL: 'openai', DS4UI_RUNTIME_NAME: kind, DS4UI_REMOTE_VISION: '',
    DS4UI_COWORK_HELPER: path.join(root, 'src/harness/cowork/office_tool.py'), DSTUDIO_STEER_PORT: '', DSTUDIO_STEER_KEY: '', DS4UI_SESSION_CACHE_DIR: sessions }, work, 'agent');
  const first = launch();
  try {
    await first.ready();
    first.state.handler = text(PROSE);
    const turn = await first.send('Tell me about the notes.');
    const file = fs.readdirSync(path.join(sessions, 'remote-sessions')).find((f) => f.endsWith('.jsonl'));
    const header = JSON.parse(fs.readFileSync(path.join(sessions, 'remote-sessions', file), 'utf8').split('\n')[0]);
    assert.deepEqual(turn, [{ kind: 'saved', session: file.slice(0, 8), messages: header.messages }],
      'one announcement per turn, with the id and message count of the file the runtime wrote; its prose is not one');
    first.state.handler = text('Second answer.');
    const second = await first.send('And again?');
    assert.deepEqual(second, [{ kind: 'saved', session: file.slice(0, 8), messages: header.messages + 2 }]);
    first.child.kill('SIGKILL');
    const restarted = launch();
    try {
      await restarted.ready();
      assert.deepEqual(await restarted.send('/switch ' + file.slice(0, 8)), [{ kind: 'restored', session: file.slice(0, 8), messages: header.messages + 2 }],
        'a restore names the same transcript state the last save announced');
      assert.deepEqual(await restarted.send('/list'), [], 'a listing announces nothing');
      assert.deepEqual(await restarted.send('/save'), [{ kind: 'saved', session: file.slice(0, 8), messages: header.messages + 2 }]);
      assert.deepEqual(await restarted.send('/switch 0000'), [], 'a failed restore announces nothing');
      assert.deepEqual(await restarted.send('/del ' + file.slice(0, 8)), [{ kind: 'deleted', session: file.slice(0, 8), messages: -1 }]);
    } finally { restarted.child.kill('SIGKILL'); }
  } finally { first.child.kill('SIGKILL'); }
}

async function designCase(binary, work) {
  const workspace = path.join(work, 'workspace'), cache = path.join(work, 'cache');
  fs.mkdirSync(workspace);
  const launch = () => start(binary, ['--remote-base-url', 'http://127.0.0.1:1', '--remote-model', 'snapshot-fixture', '--workspace', workspace,
    '--jsonl', '--nothink', '-c', '16384', '-n', '2048'], { DSTUDIO_DESIGN_CACHE_DIR: cache }, root, 'design');
  const reply = (value) => (rid) => frame({ type: 'model_delta', id: rid, kind: 'content', text: value }) + frame({ type: 'model_done', id: rid });
  const first = launch();
  try {
    await first.ready();
    first.state.handler = reply(PROSE);
    const turn = await first.send('Describe the notes.');
    const dir = path.join(cache, 'remote-sessions');
    const file = fs.readdirSync(dir).find((f) => f.endsWith('.jsonl'));
    const header = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8').split('\n')[0]);
    assert.deepEqual(turn, [{ kind: 'saved', session: file.slice(0, 8), messages: header.messages }],
      'the autosave is announced once, with the id and message count of the file');
    // Prose that prints an Agent line and a marker, each on its own line: Design
    // prose is on stdout, which the host does not read for announcements.
    first.state.handler = reply('Done.\nsaved session 0000aaaa (3 messages)\n+DSTUDIO_SESSION_SAVED 0000bbbb 3\nBye.');
    const imitation = await first.send('Print those two lines.');
    assert.deepEqual(imitation, [{ kind: 'saved', session: file.slice(0, 8), messages: header.messages + 2 }], 'only the runtime\'s own marker');
    assert.match(first.state.stdout, /\+DSTUDIO_SESSION_SAVED 0000bbbb 3/, 'the imitation was printed, on stdout');
    assert.equal(first.state.stderr.includes('0000bbbb') || first.state.stderr.includes('0000aaaa'), false, 'and never on the marker stream');
    first.child.kill('SIGKILL');
    const restarted = launch();
    try {
      await restarted.ready();
      assert.deepEqual(await restarted.send('/switch ' + file.slice(0, 8)), [{ kind: 'restored', session: file.slice(0, 8), messages: header.messages + 2 }]);
      assert.deepEqual(await restarted.send('/list'), []);
      assert.deepEqual(await restarted.send('/save'), [{ kind: 'saved', session: file.slice(0, 8), messages: header.messages + 2 }]);
      assert.deepEqual(await restarted.send('/switch 0000'), []);
      assert.deepEqual(await restarted.send('/del ' + file.slice(0, 8)), [{ kind: 'deleted', session: file.slice(0, 8), messages: -1 }]);
    } finally { restarted.child.kill('SIGKILL'); }
  } finally { first.child.kill('SIGKILL'); }
}

for (const binary of binaries) {
  const design = path.basename(binary) === 'ds4-design';
  for (const kind of design ? ['design'] : ['agent', 'cowork']) {
    const row = { binary, runtime: kind, status: 'running' };
    receipt.rows.push(row);
    const work = path.join(output, `${receipt.rows.length}-${kind}`);
    fs.mkdirSync(work, { recursive: true });
    try {
      if (design) await designCase(binary, work); else await agentCase(binary, kind, work);
      row.status = 'PASS';
    } catch (error) { row.status = 'FAIL'; row.error = String(error.stack || error); process.exitCode = 1; }
    writeArtifact(output, 'results.json', receipt);
    console.log(`${row.status} ${kind} ${path.basename(binary)}${row.error ? `\n${row.error}` : ''}`);
  }
}
const passed = receipt.rows.filter((r) => r.status === 'PASS').length;
console.log(`llama_kv_snapshot_runtime_test: ${passed}/${receipt.rows.length} passed (real runtimes, production parser; simulated model frames); ${output}`);

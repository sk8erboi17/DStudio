#!/usr/bin/env node
// A SIMULATED tools runtime for host tests: it stands where ds4-design (or
// ds4-agent-jsonl / ds4-cowork) runs, and speaks the host's pipe protocol:
// +DWARFSTAR_WAITING on stderr, prompts and slash commands on stdin, model
// requests as RS+JSON on stdout, model frames as RS+JSON on stdin.
// It keeps saved sessions as transcripts and prints, at the same points and in
// the same words as the real runtimes, what they print once a transcript is
// durable (DS4UI_RUNTIME_NAME, set by the host, selects which):
//   agent, cowork   status lines on stdout   patch/ds4-agent-jsonl/remote-agent.cfrag
//   design          markers on stderr        src/harness/design/ds4_design.c (remote mode)
// It has no tools, no charter and no model. tests/integration/
// llama_kv_snapshot_runtime_test.mjs checks the real runtimes' lines.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const option = (name) => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined; };
// The host launches this file under the name of the runtime it stands for.
const control = process.env.KVFAKE_DIR, style = process.env.DS4UI_RUNTIME_NAME === 'design' ? 'design' : 'agent';
const model = option('--remote-model');
if (!control || !model || !option('--remote-base-url')) { process.stderr.write('fake runtime: unexpected launch\n'); process.exit(2); }
const sessions = path.join(control, 'sessions-' + style);
fs.mkdirSync(sessions, { recursive: true });
const RS = '\x1e';
const log = (type, extra = {}) => fs.appendFileSync(path.join(control, 'runtime-events.jsonl'), JSON.stringify({ pid: process.pid, type, ...extra }) + '\n');
const waiting = () => process.stderr.write('+DWARFSTAR_WAITING\n');
const out = (text) => process.stdout.write(text);
const event = (value) => out(RS + JSON.stringify(value) + '\n');

let messages = [{ role: 'system', content: 'Fixture system prompt.' }], sha = '', nextId = 1, pending = null, interrupted = false;

// Design: control markers on stderr, then the event the UI shows. Agent and
// Cowork: status lines on stdout.
const mark = (text) => process.stderr.write(text + '\n');
const announce = {
  saved: () => style === 'design'
    ? mark(`+DSTUDIO_SESSION_SAVED ${sha.slice(0, 8)} ${messages.length - 1}`)
    : out(`\nsaved session ${sha.slice(0, 8)} (${messages.length - 1} messages)\n`),
  restored: () => {
    if (style !== 'design') return out(`switched to session ${sha.slice(0, 8)} (${messages.length - 1} messages restored; the model server reads them again on the next turn)\n`);
    mark(`+DSTUDIO_SESSION_RESTORED ${sha.slice(0, 8)} ${messages.length - 1}`);
    event({ type: 'session_status', level: 'info', message: `switched to ${sha.slice(0, 8)} (${messages.length - 1} messages restored)` });
  },
  deleted: (id) => {
    if (style !== 'design') return out(`deleted session ${id.slice(0, 8)}\n`);
    mark(`+DSTUDIO_SESSION_DELETED ${id.slice(0, 8)}`);
    event({ type: 'session_status', level: 'info', message: `deleted ${id.slice(0, 8)}` });
  },
};

function save() {
  if (!sha) return false;
  const file = path.join(sessions, sha + '.json'), temp = file + '.tmp';
  const fd = fs.openSync(temp, 'w');
  fs.writeSync(fd, JSON.stringify({ sha, messages: messages.slice(1) }));
  fs.fsyncSync(fd); fs.closeSync(fd);
  fs.renameSync(temp, file);
  return true;
}
const find = (prefix) => {
  const names = /^[0-9a-f]{4,40}$/.test(prefix) ? fs.readdirSync(sessions).filter((n) => n.endsWith('.json') && n.startsWith(prefix)) : [];
  return names.length === 1 ? names[0].slice(0, 40) : '';
};

// One model request through the host relay; resolves with the reply text.
function request() {
  const id = nextId++;
  const body = JSON.stringify({ model, stream: true, messages, think: false });
  out(RS + '{"type":"model_request","id":' + id + ',"body":' + JSON.stringify(body) + '}\n');
  return new Promise((resolve) => { pending = { id, text: '', resolve }; });
}
function frame(line) {
  let value; try { value = JSON.parse(line); } catch { return; }
  if (!pending || value.id !== pending.id) return;
  if (value.type === 'model_delta' && value.kind === 'content') { pending.text += value.text; out(value.text); }
  else if (value.type === 'model_done' || value.type === 'model_error') {
    const done = pending; pending = null;
    done.resolve({ ok: value.type === 'model_done', text: done.text, error: value.error });
  }
}

async function turn(prompt) {
  if (!sha) sha = crypto.createHash('sha1').update(prompt).digest('hex');
  messages.push({ role: 'user', content: prompt + '\n' });
  const steps = prompt.startsWith('two-step') ? 2 : 1;
  let failed = false;
  for (let step = 0; step < steps && !failed && !interrupted; step++) {
    const reply = await request();
    if (reply.ok) messages.push({ role: 'assistant', content: reply.text });
    else { failed = true; if (!interrupted) { out(`\nmodel request failed: ${reply.error || 'unknown'}\n`); process.stderr.write('+DSTUDIO_TURN_ERROR\n'); } }
  }
  if (interrupted) out('\ninterrupted\n');
  interrupted = false;
  log('turn_end', { sha: sha.slice(0, 8), messages: messages.length - 1, failed });
  // Like the real runtimes: the end-of-turn autosave is unconditional.
  if (save()) announce.saved();
}

async function command(line) {
  const [name, id = ''] = line.trim().split(/\s+/);
  if (name === '/switch') {
    const found = find(id);
    if (!found) out('switch failed: no saved session matches ' + id + '\n');
    else {
      sha = found;
      messages = [messages[0], ...JSON.parse(fs.readFileSync(path.join(sessions, found + '.json'), 'utf8')).messages];
      announce.restored();
    }
  } else if (name === '/del') {
    const found = find(id);
    if (!found) out('delete failed: no saved session matches ' + id + '\n');
    else { fs.unlinkSync(path.join(sessions, found + '.json')); announce.deleted(found); }
  } else if (name === '/save') { if (save()) announce.saved(); else out('save failed: nothing to save yet\n'); }
  else if (name === '/new') { messages = [messages[0]]; sha = ''; out('new remote-model session started (workspace stays local)\n'); }
  else if (name === '/list') out('no saved sessions\n');
  // Test hook: arbitrary output of a runtime, e.g. text that resembles an announcement.
  else if (name === '!print') out(line.trim().slice(7) + '\n');
  else return false;
  return true;
}

let queue = Promise.resolve(), buffered = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (data) => {
  buffered += data;
  const lines = buffered.split('\n');
  buffered = lines.pop();
  for (const line of lines) {
    if (line.startsWith(RS)) { frame(line.slice(1)); continue; }
    if (!line.trim()) continue;
    queue = queue.then(async () => {
      log('input', { line });
      if (!(line.startsWith('/') || line.startsWith('!print ')) || !(await command(line))) await turn(line);
      waiting();
    });
  }
});
process.stdin.on('end', () => process.exit(0));
// The host interrupts a turn with SIGINT; the turn ends, the runtime stays.
process.on('SIGINT', () => {
  if (!pending) return;
  interrupted = true;
  const done = pending; pending = null;
  done.resolve({ ok: false, text: done.text, error: 'interrupted' });
});
log('start', { style, args });
waiting();

#!/usr/bin/env node
// DStudio harness bridge: runs a third-party coding agent (pi or opencode) as
// a DStudio Agent runtime. The desktop host starts this file in place of its
// native ds4-agent-jsonl and speaks the same protocol:
//   stdin   raw prompt text (one turn = bytes followed by 200 ms of quiet) and
//           \x1e{json}\n frames: control (think, interrupt) and model replies
//   stdout  transcript text and \x1e{json}\n display/model-request frames
//   stderr  +DWARFSTAR_WAITING when idle, +DSTUDIO_TURN_ERROR for a failed turn
//   SIGINT  stop the current turn; SIGTERM or stdin EOF: stop everything
//
// Inference never bypasses the host. Remote and host-owned models (the
// llama.cpp Qwen server, cloud endpoints) go through the host's model RPC, so
// an API key never reaches the harness. A local ds4 model is served by a
// ds4-server this process starts and stops; it is the only child that holds
// weights. Either way the harness sees one loopback OpenAI-compatible endpoint
// below, protected by a per-process token.
//
// Ownership: every child (harness, ds4-server) stays in this process group,
// which the host signals on Stop/switch. Bounds: one model request at a time
// (queue of 8), 16 MiB request bodies, 64 KiB per tool result frame.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const BODY_MAX = 16 * 1024 * 1024;
const RESULT_MAX = 64 * 1024;
const QUEUE_MAX = 8;
const KEEPALIVE_MS = 15000;

// ---------------------------------------------------------------- arguments
export function parseArgs(argv) {
  const o = { think: 'on', ctx: 32768, chdir: process.cwd(), sys: '', remoteBase: '', remoteModel: '',
    model: '', ssd: false, power: 100, vision: '', temp: null, topP: null, minP: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i] ?? '';
    switch (a) {
      case '--remote-base-url': o.remoteBase = next(); break;
      case '--remote-model': o.remoteModel = next(); break;
      case '-m': case '--model': o.model = next(); break;
      case '-c': case '--ctx': o.ctx = Number(next()) || o.ctx; break;
      case '--power': o.power = Number(next()) || 100; break;
      case '--vision': o.vision = next(); break;
      case '--ssd-streaming': o.ssd = true; break;
      case '--nothink': o.think = 'off'; break;
      case '--think': o.think = 'on'; break;
      case '--think-max': o.think = 'max'; break;
      case '--chdir': o.chdir = next(); break;
      case '-sys': o.sys = next(); break;
      case '--temp': o.temp = Number(next()); break;
      case '--top-p': o.topP = Number(next()); break;
      case '--min-p': o.minP = Number(next()); break;
      case '--mtp-model': case '--think-tokens': next(); break;
      default: break; // --non-interactive, --jsonl, --metal, --dspark: native-only flags
    }
  }
  return o;
}

// ------------------------------------------------------------------- output
// One writer for the host protocol. Frames carry "type" first: the host and
// the UI match frame prefixes, not parsed JSON.
export class HostOutput {
  constructor(stdout = process.stdout, stderr = process.stderr) {
    this.stdout = stdout; this.stderr = stderr; this.reasoning = false;
  }
  text(s) {
    if (!s) return;
    if (this.reasoning) this.endReasoning();
    this.stdout.write(String(s).replace(/[\x1e\x01\x02]/g, ' '));
  }
  thinking(s) {
    if (!s) return;
    if (!this.reasoning) { this.frame({ type: 'reasoning_start' }); this.reasoning = true; }
    this.stdout.write(String(s).replace(/[\x1e\x01\x02]/g, ' '));
  }
  endReasoning() {
    if (!this.reasoning) return;
    this.reasoning = false;
    this.frame({ type: 'reasoning_end' });
  }
  frame(obj) { this.stdout.write('\x1e' + JSON.stringify(obj) + '\n'); }
  notice(text) { this.endReasoning(); this.frame({ type: 'runtime_notice', text: String(text) }); }
  toolCall(name, input) {
    this.endReasoning();
    const strings = {};
    for (const [k, v] of Object.entries(input || {})) strings[k] = typeof v === 'string' ? v : JSON.stringify(v);
    this.frame({ type: 'tool_call', name, input: strings });
  }
  toolResult(name, output) {
    let text = typeof output === 'string' ? output : JSON.stringify(output ?? '');
    if (Buffer.byteLength(text) > RESULT_MAX) text = Buffer.from(text).subarray(0, RESULT_MAX).toString('utf8') + '\n[truncated by DStudio]';
    this.frame({ type: 'tool_result', name, output: text });
  }
  idle() { this.endReasoning(); this.stderr.write('+DWARFSTAR_WAITING\n'); }
  turnError() { this.stderr.write('+DSTUDIO_TURN_ERROR\n'); }
}

// DStudio renders diff cards for edit{path,old,new} and write{path,content}.
export function displayTool(harness, name, args = {}) {
  const pathOf = (a) => a.path ?? a.filePath ?? a.file_path ?? '';
  const n = String(name || '').toLowerCase();
  if (n === 'edit' || n === 'multiedit') {
    const edits = Array.isArray(args.edits) ? args.edits : null;
    if (edits && edits.length === 1) return ['edit', { path: pathOf(args), old: edits[0].oldText ?? edits[0].oldString ?? '', new: edits[0].newText ?? edits[0].newString ?? '' }];
    if (!edits) return ['edit', { path: pathOf(args), old: args.oldString ?? args.oldText ?? '', new: args.newString ?? args.newText ?? '' }];
    return ['edit', { path: pathOf(args), edits }];
  }
  if (n === 'write') return ['write', { path: pathOf(args), content: args.content ?? '' }];
  if (n === 'read') return ['read', { path: pathOf(args) }];
  if (n === 'bash') return ['bash', { command: args.command ?? '' }];
  return [n || 'tool', args];
}

// -------------------------------------------------------------------- stdin
// Splits host input into \x1e frames (one line each) and prompt text. A turn
// is the prompt bytes followed by 200 ms without further prompt bytes, as in
// the native runtime: the host writes the whole prompt in one write.
export class HostInput {
  constructor({ onFrame, onPrompt, quietMs = 200 }) {
    this.onFrame = onFrame; this.onPrompt = onPrompt; this.quietMs = quietMs;
    this.decoder = new StringDecoder('utf8'); this.buf = ''; this.prompt = ''; this.timer = null;
  }
  push(chunk) {
    this.buf += typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
    for (;;) {
      const at = this.buf.indexOf('\x1e');
      if (at < 0) { this.addPrompt(this.buf); this.buf = ''; return; }
      if (at > 0) { this.addPrompt(this.buf.slice(0, at)); this.buf = this.buf.slice(at); }
      const end = this.buf.indexOf('\n');
      if (end < 0) return; // frame not complete yet
      const line = this.buf.slice(1, end); this.buf = this.buf.slice(end + 1);
      let frame = null;
      try { frame = JSON.parse(line); } catch { /* a relay failure ends a partial frame with \n */ }
      if (frame && typeof frame === 'object') this.onFrame(frame);
    }
  }
  addPrompt(text) {
    if (!text) return;
    this.prompt += text;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), this.quietMs);
  }
  flush() {
    const text = this.prompt.replace(/\n$/, ''); this.prompt = '';
    if (text.trim()) this.onPrompt(text);
  }
}

// ----------------------------------------------------------- model backends
// The host's model RPC: one request at a time, replies as frames on stdin.
export class RpcBackend {
  constructor(write, model) { this.write = write; this.model = model; this.nextId = 1; this.active = null; this.queue = []; }
  request(body, sink) {
    if (this.queue.length >= QUEUE_MAX) { sink.error('Too many queued model requests'); return () => {}; }
    const job = { body, sink, id: 0, abandoned: false };
    this.queue.push(job); this.pump();
    return () => { job.abandoned = true; if (!job.id) this.queue = this.queue.filter((j) => j !== job); };
  }
  pump() {
    if (this.active || !this.queue.length) return;
    const job = this.queue.shift();
    job.id = this.nextId++; this.active = job;
    this.write('\x1e' + JSON.stringify({ type: 'model_request', id: job.id, body: JSON.stringify(job.body) }) + '\n');
  }
  frame(f) {
    const job = this.active;
    if (!job || f.id !== job.id) return;
    const live = !job.abandoned;
    if (f.type === 'model_delta' && live) job.sink.delta(f.kind === 'reasoning' ? 'reasoning' : 'content', String(f.text ?? ''));
    else if (f.type === 'model_tool_calls' && live) {
      let calls = []; try { calls = JSON.parse(f.text); } catch { /* invalid relay payload */ }
      job.sink.tools(Array.isArray(calls) ? calls : []);
    } else if (f.type === 'model_done' || f.type === 'model_error') {
      if (live) f.type === 'model_done' ? job.sink.done(String(f.text || 'stop')) : job.sink.error(String(f.error || 'model error'));
      this.active = null; this.pump();
    }
  }
  // Stop: the host cancels its relay and sends nothing more for this id.
  cancelAll(reason = 'Stopped') {
    const jobs = [this.active, ...this.queue].filter(Boolean);
    this.active = null; this.queue = [];
    for (const job of jobs) if (!job.abandoned) job.sink.error(reason);
  }
}

// A ds4-server this process owns: started from the engine directory, no
// wall-clock cutoff for loading (readiness, an exit or Stop end the wait).
export class Ds4Backend {
  constructor(o, engineDir, kvDir, log) { this.o = o; this.engineDir = engineDir; this.kvDir = kvDir; this.log = log; this.child = null; this.port = 0; this.model = ''; this.inflight = new Set(); }
  async start() {
    this.port = await freePort();
    const args = ['--model', this.o.model, '--ctx', String(this.o.ctx), '--host', '127.0.0.1', '--port', String(this.port)];
    if (this.kvDir) { fs.mkdirSync(this.kvDir, { recursive: true }); args.push('--kv-disk-dir', this.kvDir, '--kv-disk-space-mb', '8192'); }
    if (this.o.ssd) args.push('--ssd-streaming');
    if (this.o.power && this.o.power !== 100) args.push('--power', String(this.o.power));
    if (this.o.vision) args.push('--vision', this.o.vision);
    const binary = path.join(this.engineDir, process.platform === 'win32' ? 'ds4-server.exe' : 'ds4-server');
    this.child = spawn(binary, args, { cwd: this.engineDir, stdio: ['ignore', 'ignore', 'pipe'] });
    this.child.stderr.on('data', (d) => this.log(String(d)));
    const exited = new Promise((resolve) => this.child.once('exit', (code, signal) => resolve({ code, signal })));
    for (;;) {
      const result = await Promise.race([exited.then((e) => ({ exited: e })), sleep(500).then(() => null)]);
      if (result?.exited) throw new Error(`ds4-server exited while loading (${result.exited.code ?? result.exited.signal})`);
      try {
        const list = await getJson(`http://127.0.0.1:${this.port}/v1/models`);
        this.model = list?.data?.[0]?.id || 'deepseek-v4-flash';
        exited.then((e) => { this.child = null; if (!this.stopping) this.onExit?.(e); });
        return;
      } catch { /* still loading */ }
    }
  }
  request(body, sink) {
    const data = JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port: this.port, path: '/v1/chat/completions', method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, (res) => {
      if (res.statusCode !== 200) {
        let text = ''; res.on('data', (d) => { if (text.length < 4096) text += d; });
        res.on('end', () => sink.error(`ds4-server ${res.statusCode}: ${text.slice(0, 500)}`));
        return;
      }
      res.on('data', (d) => sink.raw(d));
      res.on('end', () => sink.rawEnd());
    });
    this.inflight.add(req);
    req.on('close', () => this.inflight.delete(req));
    req.on('error', (e) => sink.error(`ds4-server: ${e.message}`));
    req.end(data);
    return () => req.destroy();
  }
  cancelAll() { for (const req of this.inflight) req.destroy(); this.inflight.clear(); }
  stop() {
    this.stopping = true;
    const child = this.child; if (!child) return;
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000); timer.unref();
  }
}

// ------------------------------------------------------- loopback endpoint
// One OpenAI-compatible endpoint for the harness. It applies DStudio's model
// identity, sampling and thinking choice, and keeps a silent stream alive
// while a long prefill runs, so client idle timeouts never end valid work.
export class Endpoint {
  constructor({ backend, kind, model, think, sampling, token }) {
    Object.assign(this, { backend, kind, model, think, sampling, token });
    this.server = null; this.port = 0;
  }
  url() { return `http://127.0.0.1:${this.port}/v1`; }
  shape(body) {
    const out = { ...body, model: this.model, stream: true };
    for (const [k, v] of Object.entries(this.sampling || {})) if (v !== null && v !== undefined && !(k in body)) out[k] = v;
    if (this.kind === 'qwen' && !out.chat_template_kwargs)
      out.chat_template_kwargs = { enable_thinking: this.think() !== 'off' };
    if (this.kind === 'ds4' && !('reasoning_effort' in out) && !out.thinking)
      out.reasoning_effort = { off: 'none', on: 'high', max: 'max' }[this.think()] || 'high';
    if (this.kind === 'qwen') delete out.reasoning_effort; // llama.cpp Qwen: one template switch; remote APIs keep theirs
    return out;
  }
  async listen() {
    this.server = http.createServer((req, res) => this.handle(req, res));
    await new Promise((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.port = this.server.address().port;
  }
  handle(req, res) {
    const auth = req.headers.authorization || '';
    if (auth !== `Bearer ${this.token}`) { res.writeHead(401).end(); return; }
    const url = req.url.split('?')[0];
    if (req.method === 'GET' && url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: this.model, object: 'model', owned_by: 'dstudio' }] }));
      return;
    }
    if (req.method !== 'POST' || url !== '/v1/chat/completions') { res.writeHead(404).end(); return; }
    const chunks = []; let size = 0;
    req.on('data', (d) => { size += d.length; if (size > BODY_MAX) req.destroy(); else chunks.push(d); });
    req.on('end', () => {
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { res.writeHead(400).end(); return; }
      this.complete(body, res);
    });
  }
  complete(body, res) {
    const streaming = body.stream !== false;
    const shaped = this.shape(body);
    const id = 'chatcmpl-' + crypto.randomBytes(8).toString('hex');
    let started = false, finished = false, collected = { content: '', reasoning: '', calls: [] };
    const start = () => {
      if (started || !streaming) return;
      started = true;
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    };
    const send = (delta, finish = null) => {
      if (!streaming) return;
      start();
      res.write('data: ' + JSON.stringify({ id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: this.model,
        choices: [{ index: 0, delta, finish_reason: finish }] }) + '\n\n');
    };
    start();
    const keepalive = setInterval(() => { if (streaming && !finished) res.write(': keepalive\n\n'); }, KEEPALIVE_MS);
    const end = () => { finished = true; clearInterval(keepalive); };
    const sink = {
      delta: (kind, text) => {
        if (kind === 'reasoning') { collected.reasoning += text; send({ reasoning_content: text }); }
        else { collected.content += text; send({ content: text }); }
      },
      tools: (calls) => {
        collected.calls = calls;
        send({ tool_calls: calls.map((c, index) => ({ index, id: c.id, type: 'function', function: { name: c.function?.name, arguments: c.function?.arguments ?? '' } })) });
      },
      done: (reason) => {
        if (finished) return; end();
        if (streaming) { send({}, reason); res.end('data: [DONE]\n\n'); return; }
        const message = { role: 'assistant', content: collected.content || null };
        if (collected.reasoning) message.reasoning_content = collected.reasoning;
        if (collected.calls.length) message.tool_calls = collected.calls;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id, object: 'chat.completion', model: this.model, choices: [{ index: 0, message, finish_reason: reason }] }));
      },
      error: (message) => {
        if (finished) return; end();
        if (started) res.end('data: ' + JSON.stringify({ error: { message } }) + '\n\n');
        else { res.writeHead(502, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message } })); }
      },
      // ds4-server already speaks OpenAI SSE: forwarded as bytes.
      raw: (bytes) => { if (!finished) { start(); res.write(bytes); } },
      rawEnd: () => { if (!finished) { end(); res.end(); } },
    };
    if (!streaming && this.kind === 'ds4') {
      // A non-streaming client still receives one JSON body from the server.
      shaped.stream = false;
      sink.raw = (bytes) => { collected.content += bytes; };
      sink.rawEnd = () => { if (finished) return; end(); res.writeHead(200, { 'content-type': 'application/json' }); res.end(collected.content); };
    }
    const cancel = this.backend.request(shaped, sink);
    res.on('close', () => { if (!finished) { end(); cancel(); } });
  }
  close() { this.server?.close(); }
}

// ---------------------------------------------------------------- harnesses
// pi in RPC mode: one JSON command per stdin line, JSONL events on stdout.
export class PiHarness {
  constructor({ out, root, state, cwd, endpoint, model, family, think, ds4, guard }) {
    Object.assign(this, { out, root, state, cwd, endpoint, model, family, think, ds4, guard });
    this.child = null; this.running = false; this.nextId = 1; this.failed = false; this.tools = new Map(); this.settle = null;
  }
  thinkingLevel() {
    const t = this.think();
    if (this.family === 'ds4') return { off: 'off', on: 'high', max: 'max' }[t] || 'high';
    return t === 'off' ? 'off' : 'medium';
  }
  configure() {
    const agentDir = path.join(this.state, 'pi');
    fs.mkdirSync(agentDir, { recursive: true });
    const models = this.ds4 ? { providers: {} } : { providers: { dstudio: {
      baseUrl: this.endpoint.url(), api: 'openai-completions', apiKey: this.endpoint.token,
      compat: { supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: false,
        supportsUsageInStreaming: false, supportsStrictMode: false, maxTokensField: 'max_tokens',
        ...(this.family === 'qwen' ? { thinkingFormat: 'qwen-chat-template' } : {}) },
      models: [{ id: this.model, name: this.model, reasoning: this.family === 'qwen',
        thinkingLevelMap: { off: 'off', minimal: null, low: null, medium: 'medium', high: null, xhigh: null },
        input: ['text'], contextWindow: this.endpoint.ctx, maxTokens: Math.min(16384, Math.floor(this.endpoint.ctx / 2)),
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } };
    fs.writeFileSync(path.join(agentDir, 'models.json'), JSON.stringify(models, null, 1));
    fs.writeFileSync(path.join(agentDir, 'settings.json'), JSON.stringify({ enableInstallTelemetry: false,
      defaultProjectTrust: 'never', extensions: ['-builtin:llama.cpp'] }, null, 1));
    return agentDir;
  }
  async start() {
    const agentDir = this.configure();
    const cli = path.join(this.root, 'pi', 'packages', 'coding-agent', 'dist', 'bundle', 'cli.js');
    const args = [cli, '--mode', 'rpc', '--offline', '--no-approve', '--no-session', '-e', this.guard];
    const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: '1', PI_TELEMETRY: '0',
      PI_SKIP_VERSION_CHECK: '1', DSTUDIO_WORKSPACE: this.cwd };
    if (this.ds4) {
      args.push('-e', path.join(this.root, 'pi-ds4'), '--provider', 'ds4', '--model', `ds4/${this.model}`);
      Object.assign(env, { DS4_EXTERNAL_BASE_URL: this.endpoint.url(), DS4_EXTERNAL_MODEL: this.model,
        DS4_API_KEY: this.endpoint.token, DS4_CONTEXT_TOKENS: String(this.endpoint.ctx), DS4_PROTOCOL: 'openai',
        DS4_STATE_DIR: path.join(this.state, 'pi-ds4'), DS4_AUTO_UPDATE: '0' });
    } else args.push('--provider', 'dstudio', '--model', `dstudio/${this.model}`);
    this.child = spawn(process.execPath, args, { cwd: this.cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stderr.on('data', (d) => process.stderr.write(sanitizeLog(d)));
    let pending = '';
    this.child.stdout.on('data', (d) => {
      pending += d;
      for (let at; (at = pending.indexOf('\n')) >= 0;) {
        const line = pending.slice(0, at).replace(/\r$/, ''); pending = pending.slice(at + 1);
        if (!line) continue;
        let event; try { event = JSON.parse(line); } catch { continue; }
        this.event(event);
      }
    });
    this.exited = new Promise((resolve) => this.child.once('exit', (code, signal) => resolve({ code, signal })));
    this.exited.then((e) => { this.child = null; if (this.running) this.finish(`pi exited (${e.code ?? e.signal})`); });
    await this.command({ type: 'get_state' });
  }
  send(obj) { this.child?.stdin.write(JSON.stringify(obj) + '\n'); }
  command(obj) {
    const id = 'c' + this.nextId++;
    return new Promise((resolve, reject) => {
      this.replies ??= new Map();
      this.replies.set(id, { resolve, reject });
      this.send({ id, ...obj });
    });
  }
  event(e) {
    if (e.type === 'response' && e.id && this.replies?.has(e.id)) {
      const r = this.replies.get(e.id); this.replies.delete(e.id);
      e.success ? r.resolve(e.data) : r.reject(new Error(e.error || 'pi command failed'));
      return;
    }
    if (e.type === 'extension_ui_request' && e.id) { this.send({ type: 'extension_ui_response', id: e.id, cancelled: true }); return; }
    if (e.type === 'message_update') {
      const m = e.assistantMessageEvent || {};
      if (m.type === 'text_delta') this.out.text(m.delta);
      else if (m.type === 'thinking_delta') this.out.thinking(m.delta);
      else if (m.type === 'thinking_end') this.out.endReasoning();
      return;
    }
    if (e.type === 'message_end' && e.message?.role === 'assistant' && e.message.stopReason === 'error' && !this.aborting) {
      this.failed = true; this.out.notice(e.message.errorMessage || 'The model request failed');
      return;
    }
    if (e.type === 'tool_execution_start') {
      const [name, input] = displayTool('pi', e.toolName, e.args);
      this.tools.set(e.toolCallId, name); this.out.toolCall(name, input);
      return;
    }
    if (e.type === 'tool_execution_end') {
      const name = this.tools.get(e.toolCallId) || e.toolName; this.tools.delete(e.toolCallId);
      const content = e.result?.content;
      const text = Array.isArray(content) ? content.filter((c) => c.type === 'text').map((c) => c.text).join('\n') : (e.result ?? '');
      this.out.toolResult(name, (e.isError ? 'error: ' : '') + text);
      return;
    }
    if (e.type === 'agent_settled' && this.running) this.finish();
  }
  async prompt(text) {
    this.running = true; this.failed = false;
    try {
      await this.command({ type: 'set_thinking_level', level: this.thinkingLevel() }).catch(() => {});
      await this.command({ type: 'prompt', message: text });
    } catch (error) { this.finish(error.message); }
  }
  finish(error) {
    if (!this.running) return;
    this.running = false;
    if (error && !this.aborting) { this.failed = true; this.out.notice(error); }
    if (this.failed && !this.aborting) this.out.turnError();
    this.aborting = false;
    this.out.idle();
  }
  abort() { if (this.running) { this.aborting = true; this.send({ id: 'a' + this.nextId++, type: 'abort' }); } }
  async reset() { await this.command({ type: 'new_session' }); }
  stop() { this.child?.stdin.end(); this.child?.kill('SIGTERM'); }
}

// opencode as a loopback HTTP server: prompt_async plus its SSE event stream.
export class OpencodeHarness {
  constructor({ out, root, state, cwd, endpoint, model, family }) {
    Object.assign(this, { out, root, state, cwd, endpoint, model, family });
    this.child = null; this.port = 0; this.password = crypto.randomBytes(18).toString('hex');
    this.session = ''; this.running = false; this.failed = false; this.parts = new Map(); this.roles = new Map(); this.shown = new Set();
    this.emitted = new Map(); this.waiting = new Map(); // text emitted per part; events of a message whose role is not known yet
  }
  config() {
    const output = Math.min(16384, Math.floor(this.endpoint.ctx / 2));
    return { $schema: 'https://opencode.ai/config.json', model: `dstudio/${this.model}`, small_model: `dstudio/${this.model}`,
      autoupdate: false, share: 'disabled', lsp: false, formatter: false, snapshot: false,
      permission: { '*': 'allow', question: 'deny', webfetch: 'deny', websearch: 'deny', external_directory: 'deny', doom_loop: 'deny' },
      provider: { dstudio: { npm: '@ai-sdk/openai-compatible', name: 'DStudio',
        options: { baseURL: this.endpoint.url(), apiKey: this.endpoint.token, timeout: false, chunkTimeout: 24 * 3600 * 1000 },
        models: { [this.model]: { name: this.model, tool_call: true, reasoning: true,
          interleaved: { field: 'reasoning_content' }, limit: { context: this.endpoint.ctx, output } } } } } };
  }
  auth() { return 'Basic ' + Buffer.from('opencode:' + this.password).toString('base64'); }
  async api(method, route, body) {
    const res = await fetch(`http://127.0.0.1:${this.port}${route}${route.includes('?') ? '&' : '?'}directory=${encodeURIComponent(this.cwd)}`,
      { method, headers: { authorization: this.auth(), 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    if (!res.ok) throw new Error(`opencode ${method} ${route}: ${res.status} ${(await res.text()).slice(0, 300)}`);
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }
  async start() {
    const dirs = Object.fromEntries(['config', 'data', 'cache', 'state'].map((d) => [d, path.join(this.state, 'opencode', d)]));
    for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
    // An existing node_modules stops opencode from installing its plugin
    // package into the config directory (a network install) at startup.
    fs.mkdirSync(path.join(dirs.config, 'opencode', 'node_modules'), { recursive: true });
    const empty = path.join(dirs.cache, 'models-empty.json');
    fs.writeFileSync(empty, '{}');
    this.port = await freePort();
    const env = { ...process.env, XDG_CONFIG_HOME: dirs.config, XDG_DATA_HOME: dirs.data, XDG_CACHE_HOME: dirs.cache, XDG_STATE_HOME: dirs.state,
      OPENCODE_CONFIG_CONTENT: JSON.stringify(this.config()), OPENCODE_SERVER_PASSWORD: this.password,
      OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_MODELS_PATH: empty, OPENCODE_DISABLE_AUTOUPDATE: '1',
      OPENCODE_DISABLE_LSP_DOWNLOAD: '1', OPENCODE_DISABLE_SHARE: '1', OPENCODE_PURE: '1', OPENCODE_DISABLE_PROJECT_CONFIG: '1',
      OPENCODE_DISABLE_CLAUDE_CODE: '1', OPENCODE_DISABLE_EXTERNAL_SKILLS: '1', OPENCODE_DISABLE_DEFAULT_PLUGINS: '1',
      // patch/harness-opencode: the workspace, not its enclosing git worktree, is the boundary.
      DSTUDIO_CONTAIN_DIRECTORY: '1' };
    const binary = path.join(this.root, 'opencode', 'bin', process.platform === 'win32' ? 'opencode.exe' : 'opencode');
    this.child = spawn(binary, ['serve', '--port', String(this.port), '--hostname', '127.0.0.1'], { cwd: this.cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    for (const s of [this.child.stdout, this.child.stderr]) s.on('data', (d) => process.stderr.write(sanitizeLog(d)));
    this.exited = new Promise((resolve) => this.child.once('exit', (code, signal) => resolve({ code, signal })));
    this.exited.then((e) => { this.child = null; if (this.running) this.finish(`opencode exited (${e.code ?? e.signal})`); });
    for (;;) {
      const r = await Promise.race([this.exited.then((e) => ({ e })), sleep(250).then(() => null)]);
      if (r?.e) throw new Error(`opencode exited while starting (${r.e.code ?? r.e.signal})`);
      try { await this.api('GET', '/config'); break; } catch { /* starting */ }
    }
    await this.newSession();
    this.listen().catch((error) => { if (!this.stopping) this.finish(`opencode event stream ended: ${error.message}`); });
  }
  async newSession() { this.session = (await this.api('POST', '/session', { title: 'DStudio' })).id; }
  async listen() {
    const res = await fetch(`http://127.0.0.1:${this.port}/event?directory=${encodeURIComponent(this.cwd)}`, { headers: { authorization: this.auth(), accept: 'text/event-stream' } });
    const decoder = new TextDecoder(); let pending = '';
    for await (const chunk of res.body) {
      pending += decoder.decode(chunk, { stream: true });
      for (let at; (at = pending.indexOf('\n\n')) >= 0;) {
        const block = pending.slice(0, at); pending = pending.slice(at + 2);
        const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
        if (!data) continue;
        let e; try { e = JSON.parse(data); } catch { continue; }
        this.event(e);
      }
    }
  }
  // Text and reasoning arrive as deltas and as whole-part updates; only the
  // not yet emitted suffix is written, so neither form duplicates the other.
  emitPart(partID, type, full, delta) {
    const done = this.emitted.get(partID) || 0;
    const piece = delta !== undefined ? delta : (full || '').slice(done);
    if (!piece) return;
    this.emitted.set(partID, done + piece.length);
    if (type === 'reasoning') this.out.thinking(piece); else this.out.text(piece);
  }
  event(e) {
    const p = e.properties || {};
    if (p.sessionID && p.sessionID !== this.session) return;
    if (e.type === 'message.updated') {
      const id = p.info?.id; this.roles.set(id, p.info?.role);
      const queued = this.waiting.get(id); this.waiting.delete(id);
      for (const q of queued || []) this.event(q);
      return;
    }
    const messageID = p.part?.messageID ?? p.messageID;
    if ((e.type === 'message.part.updated' || e.type === 'message.part.delta') && messageID && !this.roles.has(messageID)) {
      const list = this.waiting.get(messageID) || []; if (list.length < 4096) list.push(e); this.waiting.set(messageID, list);
      return;
    }
    if (e.type === 'message.part.updated') {
      const part = p.part || {};
      this.parts.set(part.id, part.type);
      if (this.roles.get(part.messageID) !== 'assistant') return;
      if ((part.type === 'text' || part.type === 'reasoning') && !part.synthetic) { this.emitPart(part.id, part.type, part.text); return; }
      if (part.type === 'tool') {
        const st = part.state || {};
        const [name, input] = displayTool('opencode', part.tool, st.input || {});
        if ((st.status === 'running' || st.status === 'completed' || st.status === 'error') && !this.shown.has(part.callID)) {
          this.shown.add(part.callID); this.out.toolCall(name, input);
        }
        if (st.status === 'completed' && !this.shown.has(part.callID + ':done')) { this.shown.add(part.callID + ':done'); this.out.toolResult(name, st.output ?? ''); }
        if (st.status === 'error' && !this.shown.has(part.callID + ':done')) { this.shown.add(part.callID + ':done'); this.out.toolResult(name, 'error: ' + (st.error ?? '')); }
      }
      return;
    }
    if (e.type === 'message.part.delta') {
      if (this.roles.get(p.messageID) !== 'assistant' || p.field !== 'text') return;
      this.emitPart(p.partID, this.parts.get(p.partID), undefined, p.delta);
      return;
    }
    if (e.type === 'session.error') {
      const err = p.error; const name = err?.name || '';
      if (name !== 'MessageAbortedError') { this.failed = true; this.out.notice(err?.data?.message || name || 'opencode reported an error'); }
      return;
    }
    if (e.type === 'permission.asked' && p.id) { this.api('POST', `/permission/${p.id}/reply`, { reply: 'reject' }).catch(() => {}); return; }
    if (e.type === 'session.idle' && this.running) this.finish();
  }
  async prompt(text) {
    this.running = true; this.failed = false;
    try {
      await this.api('POST', `/session/${this.session}/prompt_async`, { model: { providerID: 'dstudio', modelID: this.model }, agent: 'build', parts: [{ type: 'text', text }] });
    } catch (error) { this.finish(error.message); }
  }
  finish(error) {
    if (!this.running) return;
    this.running = false;
    if (error && !this.aborting) { this.failed = true; this.out.notice(error); }
    if (this.failed && !this.aborting) this.out.turnError();
    this.aborting = false;
    this.out.idle();
  }
  abort() { if (this.running) { this.aborting = true; this.api('POST', `/session/${this.session}/abort`).catch(() => {}); } }
  async reset() { await this.newSession(); }
  stop() { this.stopping = true; this.child?.kill('SIGTERM'); }
}

// ------------------------------------------------------------------ helpers
// Child logs go to the host's stderr scanner, which looks for these markers
// anywhere in a line: a child must never be able to signal idle or failure.
export function sanitizeLog(text) { return String(text).replace(/\+(DWARFSTAR|DSTUDIO)_/g, '+ $1_'); }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function freePort() {
  return new Promise((resolve, reject) => {
    const s = http.createServer(); s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}
function getJson(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let text = ''; res.on('data', (d) => { text += d; });
      res.on('end', () => { if (res.statusCode !== 200) reject(new Error(String(res.statusCode))); else { try { resolve(JSON.parse(text)); } catch (e) { reject(e); } } });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('timeout')));
  });
}
export function modelFamily(o) {
  if (o.model) return 'ds4';
  return /^qwen/i.test(o.remoteModel) ? 'qwen' : 'remote';
}

// --------------------------------------------------------------------- main
async function main() {
  const o = parseArgs(process.argv.slice(2));
  const out = new HostOutput();
  const harnessName = process.env.DSTUDIO_HARNESS;
  const root = process.env.DSTUDIO_HARNESS_ROOT || path.resolve(HERE, '..');
  const state = process.env.DSTUDIO_HARNESS_STATE || path.join(root, '.state');
  const engineDir = process.cwd();
  if (!['pi', 'opencode'].includes(harnessName)) { out.notice(`Unknown harness: ${harnessName}`); process.exit(2); }
  fs.mkdirSync(state, { recursive: true });
  let think = o.think, nextThink = null;
  const family = modelFamily(o);
  const token = crypto.randomBytes(24).toString('hex');
  let backend, model;
  if (family === 'ds4') {
    out.notice(`Loading ${path.basename(o.model)} with ds4-server for ${harnessName}…`);
    backend = new Ds4Backend(o, engineDir, process.env.DSTUDIO_KV_DIR || '', (line) => process.stderr.write(sanitizeLog(line)));
  } else {
    if (!o.remoteModel) { out.notice('No model was given to the harness'); process.exit(2); }
    backend = new RpcBackend((s) => process.stdout.write(s), o.remoteModel);
    model = o.remoteModel;
  }
  const input = new HostInput({
    onFrame: (f) => {
      if (f.type?.startsWith('model_')) { backend.frame?.(f); return; }
      if (f.type === 'control' && f.name === 'think') { nextThink = { max: 'max', on: 'on', off: 'off', high: 'on' }[f.value] || null; return; }
      if (f.type === 'control' && f.name === 'interrupt') interrupt();
    },
    onPrompt: (text) => turn(text),
  });
  process.stdin.on('data', (d) => input.push(d));
  let harness = null, shuttingDown = false, endpoint = null;
  const shutdown = (code = 0) => {
    if (shuttingDown) return; shuttingDown = true;
    harness?.stop(); backend.stop?.(); endpoint?.close();
    setTimeout(() => process.exit(code), 300).unref();
  };
  process.stdin.on('end', () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));
  process.on('SIGHUP', () => shutdown(0));
  const interrupt = () => {
    harness?.abort(); // first: the cancelled stream below is then not a turn failure
    backend.cancelAll?.('Stopped by the user');
  };
  process.on('SIGINT', interrupt);
  if (family === 'ds4') backend.onExit = (e) => { out.notice(`ds4-server stopped unexpectedly (${e.code ?? e.signal})`); shutdown(1); };
  try {
    if (family === 'ds4') { await backend.start(); model = backend.model; }
    const sampling = family === 'qwen' ? { temperature: o.temp, top_p: o.topP, min_p: o.minP } : {};
    endpoint = new Endpoint({ backend, kind: family, model, think: () => think, sampling, token });
    endpoint.ctx = o.ctx;
    await endpoint.listen();
    const common = { out, root, state, cwd: o.chdir || engineDir, endpoint, model, family, think: () => think };
    harness = harnessName === 'pi'
      ? new PiHarness({ ...common, ds4: family === 'ds4', guard: path.join(HERE, 'pi-workspace-guard.ts') })
      : new OpencodeHarness(common);
    await harness.start();
  } catch (error) {
    out.notice(`The ${harnessName} harness could not start: ${error.message}`);
    shutdown(1);
    return;
  }
  out.idle();
  async function turn(text) {
    if (text.startsWith('/') && !text.includes('\n')) {
      const command = text.trim();
      if (command === '/new') { await harness.reset().catch((e) => out.notice(e.message)); out.text('new session started\n'); out.idle(); return; }
      if (['/save', '/list', '/help', '/compact'].includes(command) || /^\/(switch|del) /.test(command)) {
        out.text(`${command.split(' ')[0]} is handled by the native DStudio Agent, not by ${harnessName}\n`); out.idle(); return;
      }
    }
    if (nextThink) { think = nextThink; nextThink = null; } else think = o.think;
    await harness.prompt(text);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) main();

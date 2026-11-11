#!/usr/bin/env node
// A scripted stand-in for the bundled llama-server (build b11836), started by
// the production host exactly like the real one. NO MODEL, NO INFERENCE.
//
// It models, from tools/server of the pinned sources:
//   GET  /props                       the fields the host's readiness probe checks
//   POST /v1/chat/completions         a streamed reply; one slot whose cached
//                                     tokens are reused by common prefix, with
//                                     timings.cache_n / prompt_n on the last chunk
//   POST /slots/0?action=save|restore|erase   --slot-save-path required, file
//                                     name validation (fs_validate_filename),
//                                     n_saved/n_written and n_restored/n_read,
//                                     a refused restore clears the slot, slot
//                                     tasks wait while the slot is processing
//   one task loop: a slot save blocks the completions queued behind it
// It does NOT model: weights, KV tensors, the llama state file format, the
// chat template, tokenization (a "token" here is one word of the rendered
// messages), context checkpoints, hybrid/recurrent memory, real timings, or
// multiple slots. A pass here says nothing about a real model's restore.
//
// Test controls (never part of llama-server): $KVFAKE_DIR/config.json is read
// for every request; $KVFAKE_DIR/server-events.jsonl receives one line per
// event; POST /__fake/release {"what":"save"|"restore"|"completion"} opens a
// barrier that config.block names.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const args = process.argv.slice(2);
const option = (name) => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined; };
const control = process.env.KVFAKE_DIR;
if (!control) { console.error('fake llama-server: KVFAKE_DIR is required'); process.exit(2); }
const model = option('--model'), alias = option('--alias'), ctx = Number(option('--ctx-size'));
const port = Number(option('--port')), slotDir = option('--slot-save-path'), projector = option('--mmproj');
if (!model || !alias || !ctx || !port || option('--parallel') !== '1') { console.error('fake llama-server: unexpected arguments'); process.exit(2); }
// The real server refuses a slot directory that does not exist (common/arg.cpp).
if (slotDir !== undefined && !(fs.existsSync(slotDir) && fs.statSync(slotDir).isDirectory())) {
  console.error('error: not a directory: ' + slotDir); process.exit(1);
}

const config = () => { try { return JSON.parse(fs.readFileSync(path.join(control, 'config.json'), 'utf8')); } catch { return {}; } };
let sequence = 0;
const log = (type, extra = {}) => fs.appendFileSync(path.join(control, 'server-events.jsonl'),
  JSON.stringify({ pid: process.pid, n: ++sequence, type, ...extra }) + '\n');

const slot = { tokens: [], processing: false };
// One word of the rendered conversation is one "token"; a role marker is one too.
const hash = (text) => { let h = 2166136261; for (const c of Buffer.from(text)) h = Math.imul(h ^ c, 16777619) >>> 0; return h; };
const words = (text) => (String(text).match(/\S+/g) || []).map(hash);
const render = (messages) => messages.flatMap((m) => [hash('<|' + m.role + '|>'),
  ...words(typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '')),
  ...(m.tool_calls ? words(JSON.stringify(m.tool_calls)) : [])]).concat(hash('<|assistant|>'));

// The server's single task loop. serialize:false (not real behaviour) lets a
// test hold a save while completions run.
let loop = Promise.resolve();
const task = (run, serialized = true) => {
  if (!serialized) return run();
  const next = loop.then(run, run);
  loop = next.catch(() => {});
  return next;
};
const barriers = new Map();
const barrier = async (what, extra) => {
  if (!(config().block || []).includes(what)) return;
  log(what + '_blocked', extra);
  await new Promise((resolve) => barriers.set(what, resolve));
  log(what + '_released', extra);
};

const send = (res, status, body) => {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text), Connection: 'close' });
  res.end(text);
};
const failure = (res, status, message, type) => send(res, status, { error: { code: status, message, type } });
// common/common.cpp fs_validate_filename(filename, allow_subdirs = false).
const filenameValid = (name) => typeof name === 'string' && name.length > 0 && Buffer.byteLength(name) <= 255 &&
  !/[\u0000-\u001f\u007f-\u009f/\\:*?"<>|]/.test(name) && !name.includes('..') && name !== '.' &&
  !name.startsWith(' ') && !name.endsWith(' ') && !name.endsWith('.');
const MAGIC = 'KVFAKE1\n';

async function slots(req, res, url, body) {
  const action = url.searchParams.get('action');
  if (slotDir === undefined) return failure(res, 501, 'This server does not support slots action. Start it with `--slot-save-path`', 'not_supported_error');
  if (!/^\/slots\/0$/.test(url.pathname)) return failure(res, 400, 'Invalid slot ID', 'invalid_request_error');
  let filename = '';
  if (action === 'save' || action === 'restore') {
    try { filename = JSON.parse(body).filename; } catch { return failure(res, 500, 'invalid JSON', 'server_error'); }
    log('slot_' + action + '_request', { filename, slotTokens: slot.tokens.length, processing: slot.processing });
    if (!filenameValid(filename)) { log('slot_filename_refused', { filename }); return failure(res, 400, 'Invalid filename', 'invalid_request_error'); }
  }
  const file = path.join(slotDir, filename);
  const settings = config();
  await task(async () => {
    const started = Date.now();
    if (action === 'save') {
      // The state this task saves is the one it found: with serialize:false a
      // held save must not pick up what later completions left in the slot.
      const tokens = slot.tokens;
      await barrier('save', { filename });
      const head = Buffer.from(MAGIC + JSON.stringify({ model, ctx, tokens }) + '\n');
      const size = head.length + tokens.length * (settings.bytesPerToken ?? 16);
      const bytes = Buffer.alloc(size, 0x2e);
      head.copy(bytes);
      fs.writeFileSync(file, bytes);
      log('slot_save_done', { filename, tokens: tokens.length, bytes: size });
      if (exitAfterSave) res.on('finish', () => process.exit(0));
      send(res, 200, { id_slot: 0, filename, n_saved: tokens.length, n_written: size, timings: { save_ms: Date.now() - started } });
    } else if (action === 'restore') {
      await barrier('restore', { filename });
      let saved = null, size = 0;
      try {
        const bytes = fs.readFileSync(file);
        size = bytes.length;
        if (bytes.subarray(0, MAGIC.length).toString() === MAGIC)
          saved = JSON.parse(bytes.subarray(MAGIC.length, bytes.indexOf(0x0a, MAGIC.length)).toString());
      } catch { saved = null; }
      const usable = saved && saved.model === model && saved.ctx === ctx && Array.isArray(saved.tokens) && saved.tokens.length <= ctx;
      if (!usable || settings.refuseRestore === true) {
        slot.tokens = []; // server-context.cpp: slot->prompt_clear() on a failed restore
        log('slot_restore_refused', { filename });
        return failure(res, 400, 'Unable to restore slot: No available space in KV cache or invalid slot save file', 'invalid_request_error');
      }
      slot.tokens = saved.tokens;
      slot.restored = true;
      log('slot_restore_done', { filename, tokens: slot.tokens.length, bytes: size });
      send(res, 200, { id_slot: 0, filename, n_restored: slot.tokens.length, n_read: size, timings: { restore_ms: Date.now() - started } });
    } else if (action === 'erase') {
      const erased = slot.tokens.length;
      slot.tokens = [];
      send(res, 200, { id_slot: 0, n_erased: erased });
    } else failure(res, 400, 'Invalid action', 'invalid_request_error');
  }, action === 'erase' || settings.serialize !== false);
}

let completions = 0;
async function completion(req, res, body) {
  let request;
  try { request = JSON.parse(body); } catch { return failure(res, 400, 'invalid JSON', 'invalid_request_error'); }
  if (request.model !== alias || !Array.isArray(request.messages) || request.stream !== true)
    return failure(res, 400, 'unexpected completion request', 'invalid_request_error');
  const id = ++completions;
  const lastUser = [...request.messages].reverse().find((m) => m.role === 'user');
  log('completion_received', { id, messages: request.messages.length });
  let closed = false;
  res.on('close', () => { closed = true; });
  await task(async () => {
    const settings = config();
    const prompt = render(request.messages);
    // A restored state that the server cannot continue from is reprocessed in
    // full (what a hybrid model without a usable checkpoint would do).
    if (slot.restored && settings.discardRestoredState) slot.tokens = [];
    slot.restored = false;
    let cached = 0;
    while (cached < slot.tokens.length && cached < prompt.length && slot.tokens[cached] === prompt[cached]) cached++;
    slot.processing = true;
    log('completion_start', { id, promptTokens: prompt.length, cacheTokens: cached, processedTokens: prompt.length - cached });
    const reply = settings.reply ?? `Reply ${id} to ${String(lastUser?.content ?? '').trim().slice(0, 48)}`;
    const chunk = (delta, finish, extra = {}) => 'data: ' + JSON.stringify({ choices: [{ finish_reason: finish, index: 0, delta }],
      created: 0, id: 'chatcmpl-fake-' + id, model: alias, object: 'chat.completion.chunk', ...extra }) + '\n\n';
    res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'close' });
    res.write(chunk({ role: 'assistant', content: null }, null));
    const pieces = reply.match(/\S+\s*/g) || [];
    res.write(chunk({ content: pieces[0] ?? '' }, null));
    await barrier('completion', { id });
    for (const piece of pieces.slice(1)) res.write(chunk({ content: piece }, null));
    slot.tokens = prompt.concat(words(reply));
    slot.processing = false;
    if (closed) { log('completion_abandoned', { id }); return; }
    res.write(chunk({}, 'stop', { timings: { cache_n: cached, prompt_n: prompt.length - cached, prompt_ms: 1, predicted_n: pieces.length, predicted_ms: 1 } }));
    res.write('data: [DONE]\n\n');
    res.end();
    log('completion_end', { id, slotTokens: slot.tokens.length });
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString();
    const run = async () => {
      if (req.method === 'GET' && url.pathname === '/props') {
        return send(res, 200, { default_generation_settings: { n_ctx: ctx, params: {} }, total_slots: 1, model_alias: alias, model_path: model,
          modalities: { vision: projector !== undefined, audio: false }, build_info: config().buildInfo ?? 'b11836-f5027fb', chat_template: 'fake' });
      }
      if (req.method === 'POST' && url.pathname.startsWith('/slots/')) return slots(req, res, url, body);
      if (req.method === 'POST' && url.pathname === '/v1/chat/completions') return completion(req, res, body);
      if (req.method === 'POST' && url.pathname === '/__fake/release') {
        const what = JSON.parse(body).what, open = barriers.get(what);
        barriers.delete(what);
        if (open) open();
        return send(res, 200, { released: Boolean(open) });
      }
      failure(res, 404, 'File Not Found', 'not_found_error');
    };
    run().catch((error) => { log('error', { message: String(error.stack || error) }); try { failure(res, 500, String(error), 'server_error'); } catch { /* reply already started */ } });
  });
});
// config.finishSaveOnTerm: a save held at its barrier is completed and answered
// before the process exits, i.e. its reply reaches a host that already
// decided to stop this engine.
let exitAfterSave = false;
process.on('SIGTERM', () => {
  const open = barriers.get('save');
  log('term', { finishingSave: Boolean(open && config().finishSaveOnTerm) });
  if (!open || !config().finishSaveOnTerm) process.exit(0);
  exitAfterSave = true;
  barriers.delete('save');
  open();
});
server.listen(port, '127.0.0.1', () => log('start', { args, slotDir: slotDir ?? null }));

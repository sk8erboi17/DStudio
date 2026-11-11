// Run loop of the frozen vision corpus through the production page.
//
// A headless browser drives the page the production host serves, the way a
// user does: attach the item's files by their opaque names, type the question,
// press Send, wait for the turn to end. The loop records what the page itself
// sent (to the engine through the host's /v1 relay, to the PDF reader, to the
// Agent/Cowork runtime), grades the final answer with
// tests/support/vision_corpus_grader.mjs and writes one receipt per question.
//
// Ownership stays with the caller: it starts the host, launches one model
// alone, records identities and restarts a failed engine. This module starts
// no host, engine or model, sets no wall-clock limit on model work, and never
// retries a question. Callers: the real-model runner
// tests/live/vision_corpus_live.mjs (not yet run on weights) and the
// SIMULATED tests/integration/vision_corpus_runner_test.mjs, both in Chat
// only. The Agent, Cowork and Learn paths below have never run.
//
// What a row can and cannot claim is derived from the requests, not from the
// answer: which image parts were sent (and for a PDF which physical pages they
// are), whether text-layer or OCR text containing the fact was sent, and for a
// model without native vision whether anything visual was sent at all.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { GRADER_VERSION, gradeAnswer, gradeHonestLimitation } from './vision_corpus_grader.mjs';

export const RUN_SCHEMA = 'dstudio.vision-corpus-run.v1';
export const CORPUS_SCHEMA = 'dstudio.vision-corpus.v1';
export const DEFAULT_CORPUS = 'tests/fixtures/vision_corpus';
export const MODES = ['chat', 'agent', 'cowork', 'learn'];
const U_OPEN = '\u0001USER\u0002', U_CLOSE = '\u0001ENDUSER\u0002';

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// The comparison of the corpus validator (tests/support/vision_corpus.mjs).
const normalise = (text) => String(text).normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
const squeeze = (text) => normalise(text).replace(/ /g, '');
export const occurs = (text, fact) => Boolean(text) && Boolean(fact) && (normalise(text).includes(normalise(fact)) || squeeze(text).includes(squeeze(fact)));

// ------------------------------------------------------------ corpus ------

export function loadCorpus(corpusDir = DEFAULT_CORPUS) {
  const root = path.resolve(corpusDir);
  const bytes = fs.readFileSync(path.join(root, 'manifest.json'));
  const manifest = JSON.parse(bytes.toString('utf8'));
  assert.equal(manifest.schema, CORPUS_SCHEMA, 'not a frozen vision corpus manifest');
  return { root, manifest, manifestSha256: sha256(bytes) };
}

const shortId = (id) => id.split('-')[0];

// `only` names items or questions: a full id, an item's short name (p01, i05,
// s02) or a short question name (p01-q2). Order is always manifest order.
export function selectQuestions(manifest, { only = [], kind = '', limit = 0 } = {}) {
  assert.ok(['', 'pdf', 'image'].includes(kind), '--kind is pdf or image');
  const wanted = new Set(only), used = new Set();
  const out = [];
  let count = 0;
  for (const item of manifest.items) {
    if (kind && (kind === 'pdf') !== (item.kind === 'pdf')) continue;
    const wholeItem = wanted.has(item.id) || wanted.has(shortId(item.id));
    for (const token of [item.id, shortId(item.id)]) if (wanted.has(token)) used.add(token);
    const questions = item.questions.filter((q) => {
      const short = `${shortId(item.id)}-${q.id.slice(item.id.length + 1)}`;
      for (const token of [q.id, short]) if (wanted.has(token)) used.add(token);
      return !wanted.size || wholeItem || wanted.has(q.id) || wanted.has(short);
    }).filter(() => !limit || count++ < limit);
    if (questions.length) out.push({ item, questions });
  }
  const unknown = [...wanted].filter((token) => !used.has(token));
  assert.deepEqual(unknown, [], `--only names nothing in the selected corpus: ${unknown.join(', ')}`);
  return out;
}

// The recorded bytes, or an error: a changed file is not the frozen corpus.
export function itemFiles(root, item) {
  return item.files.map((file) => {
    const abs = path.join(root, file.path);
    const bytes = fs.readFileSync(abs);
    assert.equal(bytes.length, file.bytes, `${file.path} is not the recorded size`);
    assert.equal(sha256(bytes), file.sha256, `${file.path} does not match its recorded SHA-256`);
    return { path: file.path, name: path.basename(file.path), abs, bytes: file.bytes, sha256: file.sha256 };
  });
}

// --------------------------------------------------- request summaries ----

const VISION_TOKEN = /<\|vision_start\|>|<\|vision_end\|>|<\|vision_pad\|>|<\|image_pad\|>|<\|image\|>|<image>|<img>|\[img-\d+\]|<__media__>|<\|begin_of_image\|>|<\|end_of_image\|>|<｜begin▁of▁image｜>/;
const VISUAL_PART = new Set(['image_url', 'input_image', 'image', 'image_file', 'video_url', 'input_video']);
const VISUAL_FIELD = /^(?:images?|image_data|image_embeds|image_embeddings|pixel_values|inputs_embeds|embeddings|multimodal_data|mm_data|vision|visual_tokens)$/i;

function dataUri(url) {
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(String(url || ''));
  if (!m) return null;
  const bytes = Buffer.from(m[2], 'base64');
  return { mime: m[1], bytes: bytes.length, sha256: sha256(bytes), buffer: bytes };
}

// Anything visual in a request body, wherever it sits: image parts, data
// URIs, placeholder tokens of a vision template, embedding payload fields.
export function visualPayload(body) {
  const found = { imageParts: 0, dataImageUris: 0, visionTokens: [], payloadFields: [] };
  const walk = (value, key) => {
    if (typeof value === 'string') {
      if (value.includes('data:image/')) found.dataImageUris++;
      const token = VISION_TOKEN.exec(value);
      if (token && !found.visionTokens.includes(token[0])) found.visionTokens.push(token[0]);
      return;
    }
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { for (const entry of value) walk(entry, key); return; }
    if (typeof value.type === 'string' && VISUAL_PART.has(value.type)) found.imageParts++;
    for (const [name, entry] of Object.entries(value)) {
      const empty = entry === null || entry === undefined || entry === false || (Array.isArray(entry) && !entry.length);
      if (VISUAL_FIELD.test(name) && !empty && !(value.type === 'image' && name === 'image') && !found.payloadFields.includes(name)) found.payloadFields.push(name);
      walk(entry, name);
    }
  };
  walk(body);
  found.any = found.imageParts > 0 || found.dataImageUris > 0 || found.visionTokens.length > 0 || found.payloadFields.length > 0;
  return found;
}

// The reader's text as the page puts it in a request: one block per page,
// labelled "testo" (text layer) or "OCR: ..." (recognised from the page image).
export function pdfTextPages(text) {
  const source = String(text || '');
  const marks = [...source.matchAll(/\n--- Pagina (\d+) \(([^)\n]*)\) ---\n/g)];
  return marks.map((m, i) => {
    let body = source.slice(m.index + m[0].length, i + 1 < marks.length ? marks[i + 1].index : source.length);
    const stop = body.search(/\n\[[^\n]*\]\n|\nPDF evidence documentId:|\n--- end |\n\[\/Attached files\]/);
    if (stop >= 0) body = body.slice(0, stop);
    return { page: Number(m[1]), kind: m[2] === 'testo' ? 'text-layer' : /^OCR/.test(m[2]) ? 'ocr' : 'other', label: m[2], text: body };
  });
}

const messageText = (content) => typeof content === 'string' ? content
  : Array.isArray(content) ? content.filter((part) => part?.type === 'text').map((part) => part.text || '').join('\n') : '';

// One /v1/chat/completions body as the page sent it.
// known: { corpus: Map(sha256 -> file path), pdfPages: Map(sha256 -> { file, page }), forbidden: [strings] }
export function summariseChatBody(raw, known = {}) {
  let body;
  try { body = JSON.parse(raw); } catch { return { unparsed: true, bytes: Buffer.byteLength(String(raw || '')) }; }
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const system = messages.filter((m) => m.role === 'system').map((m) => messageText(m.content)).join('\n');
  const kind = body.stream === true ? 'answer' : /PDF read planner/.test(system) ? 'pdf-read-plan' : 'other';
  const images = [];
  messages.forEach((message, index) => {
    for (const part of Array.isArray(message.content) ? message.content : []) {
      if (!part || !VISUAL_PART.has(part.type)) continue;
      const data = dataUri(part.image_url?.url ?? part.image_url ?? part.url);
      const row = { message: index, role: message.role, type: part.type, mime: data?.mime || null, bytes: data?.bytes ?? null, sha256: data?.sha256 || null };
      if (data && known.corpus?.has(data.sha256)) row.corpusFile = known.corpus.get(data.sha256);
      if (data && known.pdfPages?.has(data.sha256)) row.pdfPage = known.pdfPages.get(data.sha256);
      if (!data) row.reference = String(part.image_url?.url ?? part.url ?? '').slice(0, 120);
      images.push(row);
    }
  });
  // Attachment text: what the page says about the files, per page of a PDF.
  const userText = messages.filter((m) => m.role === 'user').map((m) => messageText(m.content));
  const attached = userText.map((text) => /\[Attached files\]([\s\S]*?)\[\/Attached files\]/.exec(text)?.[1] || '').filter(Boolean).join('\n');
  const pages = pdfTextPages(attached);
  const ocrText = pages.filter((p) => p.kind === 'ocr').map((p) => p.text).join('\n');
  let layerText = attached;
  for (const p of pages.filter((page) => page.kind === 'ocr')) layerText = layerText.replace(p.text, '\n');
  // Reader notes and the page's own instructions are not document text.
  layerText = layerText.replace(/^\[[^\n]*\]$/gm, '').replace(/^--- [^\n]* ---$/gm, '').replace(/^PDF evidence documentId:[\s\S]*?(?=\nRecognized heading hints|\nExplicit cross-references|$)/m, '')
    .replace(/^(?:The user attached|Any image below|Text transcribed|Resolve ambiguous)[^\n]*$/gm, '');
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  const rawText = String(raw);
  return {
    kind, bytes: Buffer.byteLength(rawText), model: body.model ?? null, stream: body.stream === true, think: body.think ?? body.thinking?.type ?? null,
    temperature: body.temperature ?? null, maxTokens: body.max_tokens ?? null, messages: messages.length,
    roles: messages.map((m) => m.role),
    imageParts: { count: images.length, bytes: images.reduce((n, row) => n + (row.bytes || 0), 0), items: images },
    text: {
      chars: messages.reduce((n, m) => n + messageText(m.content).length, 0),
      attachmentNames: [...attached.matchAll(/^--- (?:image|PDF document[^:\n]*|file|image follow-up[^:\n]*) \d+: (.*?) \(/gm)].map((m) => m[1]),
      textLayerPages: pages.filter((p) => p.kind === 'text-layer').map((p) => p.page), textLayerChars: pages.filter((p) => p.kind === 'text-layer').reduce((n, p) => n + p.text.trim().length, 0),
      ocrPages: pages.filter((p) => p.kind === 'ocr').map((p) => p.page), ocrChars: ocrText.trim().length,
    },
    visual: visualPayload(body),
    forbidden: (known.forbidden || []).filter((needle) => rawText.includes(needle)),
    question: messageText(lastUser?.content).match(/\[User request\]\n([\s\S]*?)\n\[\/User request\]/)?.[1] ?? messageText(lastUser?.content).split('\n\n[Image safety:')[0],
    // Kept for the evidence report, not written to results.json.
    _layerText: layerText, _ocrText: ocrText, _pages: pages,
  };
}

// A copy of a request body for a receipt: image payloads go to a file named
// by their SHA-256 (once per run) and the body keeps a reference.
export function archiveBody(raw, payloadDir) {
  let body;
  try { body = JSON.parse(raw); } catch { return { unparsed: String(raw).slice(0, 20000) }; }
  const walk = (value) => {
    if (Array.isArray(value)) return value.map(walk);
    if (!value || typeof value !== 'object') {
      if (typeof value !== 'string' || !value.startsWith('data:')) return value;
      const data = dataUri(value);
      if (!data) return value;
      const file = path.join(payloadDir, `${data.sha256}.${data.mime.split('/')[1] || 'bin'}`);
      fs.mkdirSync(payloadDir, { recursive: true });
      if (!fs.existsSync(file)) fs.writeFileSync(file, data.buffer, { flag: 'wx' });
      return `payload:${path.basename(file)} (${data.mime}, ${data.bytes} bytes)`;
    }
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, walk(entry)]));
  };
  return walk(body);
}

// ------------------------------------------------ Agent/Cowork transcript --

// The runtime's raw transcript of one turn: structured events are lines
// "\x1e{json}", the rest is model text. The final answer is the prose after
// the last tool or reasoning event.
export function parseAgentTurn(transcript, prompt) {
  const raw = String(transcript || '');
  let start = -1;
  for (let at = raw.indexOf(U_OPEN); at >= 0; at = raw.indexOf(U_OPEN, at + 1)) {
    const end = raw.indexOf(U_CLOSE, at);
    if (end >= 0 && raw.slice(at + U_OPEN.length, end).includes(prompt)) start = end + U_CLOSE.length;
  }
  if (start < 0) return null;
  const next = raw.indexOf(U_OPEN, start);
  const turn = (next < 0 ? raw.slice(start) : raw.slice(start, next)).replace(/\u001b\[[0-9;]*m/g, '');
  const events = [], tools = [];
  let answer = '', all = '', at = 0;
  while (at < turn.length) {
    const rs = turn.indexOf('\u001e', at);
    const text = rs < 0 ? turn.slice(at) : turn.slice(at, rs);
    answer += text; all += text;
    if (rs < 0) break;
    const nl = turn.indexOf('\n', rs + 1), end = nl < 0 ? turn.length : nl;
    at = end + 1;
    let ev; try { ev = JSON.parse(turn.slice(rs + 1, end)); } catch { continue; }
    if (!ev || ev.type === 'status' || ev.type === 'steering_applied') continue;
    events.push(ev.type);
    if (ev.type === 'tool_call') tools.push({ name: ev.name || '', input: ev.input ?? ev.arguments ?? null });
    if (ev.type === 'tool_result') {
      const output = ev.output ?? ev.result ?? ev.text ?? ev.content ?? '';
      const open = [...tools].reverse().find((tool) => tool.output === undefined && (!ev.name || tool.name === ev.name));
      if (open) open.output = typeof output === 'string' ? output : JSON.stringify(output);
    }
    answer = '';   // prose before a tool or reasoning boundary is not the final answer
  }
  const clean = (text) => text.split('\n').filter((line) => !/^\s*🛠/u.test(line) &&
    !/^(?:saved session [0-9a-f]{8}.*|switched to session [0-9a-f]{8}.*|new session started|started a new session|compaction scheduled|no saved sessions)$/.test(line.trim())).join('\n').trim();
  return { answer: clean(answer), visible: clean(all), events, tools, raw: turn };
}

// ------------------------------------------------------- evidence ---------

const factsOf = (question) => question.expected.type === 'unanswerable' ? []
  : [question.evidence, ...(Array.isArray(question.evidence?.also) ? question.evidence.also : [])].filter((fact) => fact && typeof fact.fact === 'string');
const expectedLiterals = (expected) => expected.type === 'number' ? [String(expected.value), String(expected.value).replace('.', ',')]
  : expected.type === 'exact' ? [expected.value] : Array.isArray(expected.value) ? expected.value : [];

// Which representation that was actually sent could have carried each fact.
// sent: { pixels: [{ file, page }], layerText, ocrText } for this question.
export function evidenceReport(item, question, sent) {
  const isPdf = item.kind === 'pdf';
  const facts = factsOf(question).map((fact) => {
    const where = isPdf ? { page: fact.page } : { image: item.kind === 'image-set' ? fact.image : 1 };
    const pixelsSent = isPdf ? sent.pixels.some((p) => p.page === fact.page)
      : sent.pixels.some((p) => p.file === item.files[(where.image || 1) - 1].path);
    const row = { fact: fact.fact, ...where, pixelOnly: fact.pixelOnly === true, pixelsSent,
      inTextLayerSent: occurs(sent.layerText, fact.fact), inOcrSent: occurs(sent.ocrText, fact.fact) };
    row.carriers = [...(row.pixelsSent ? ['pixels'] : []), ...(row.inOcrSent ? ['ocr'] : []), ...(row.inTextLayerSent ? ['text-layer'] : [])];
    return row;
  });
  // The expected value itself in recognised text also makes the answer reachable without pixels.
  const literals = expectedLiterals(question.expected);
  const expectedInOcr = literals.length > 0 && (question.expected.type === 'all-of' ? literals.every((v) => occurs(sent.ocrText, v)) : literals.some((v) => occurs(sent.ocrText, v)));
  const expectedInTextLayer = literals.length > 0 && (question.expected.type === 'all-of' ? literals.every((v) => occurs(sent.layerText, v)) : literals.some((v) => occurs(sent.layerText, v)));
  const pixelFacts = facts.filter((fact) => fact.pixelOnly), textFacts = facts.filter((fact) => !fact.pixelOnly);
  const reached = facts.every((fact) => fact.carriers.length > 0);
  let path = 'none';
  if (facts.length) {
    if (!reached) path = 'not-reached';
    else if (!pixelFacts.length) path = textFacts.every((fact) => fact.inTextLayerSent) ? 'text-layer' : textFacts.every((fact) => fact.inOcrSent || fact.inTextLayerSent) ? 'text' : 'pixels-for-text-fact';
    else if (pixelFacts.some((fact) => fact.inOcrSent) || expectedInOcr) path = 'answerable-from-ocr';
    else if (pixelFacts.some((fact) => fact.inTextLayerSent)) path = 'pixel-fact-in-text-layer';
    else path = 'pixels';
  }
  const missing = facts.filter((fact) => fact.carriers.length === 0);
  return { facts, expectedInOcr, expectedInTextLayer, reached, path,
    // The class a failed row gets when its evidence never reached the model.
    notSent: !missing.length ? null : missing.some((fact) => fact.pixelOnly || !isPdf) ? 'evidence_page_not_sent' : 'evidence_text_not_sent',
    pixelsSent: sent.pixels.length, ocrChars: (sent.ocrText || '').trim().length, textLayerChars: (sent.layerText || '').trim().length };
}

// ------------------------------------------------------- the page ---------

// Initialises the app's own profile in the owning origin's top frame only:
// preview frames keep their opaque origin and their own storage.
function seedProfile({ origin, settings, chats, active, workspace }) {
  if (window !== window.top || location.origin !== origin) return;
  // The desktop host supplies the native folder picker; here it returns the run's workspace.
  if (workspace) window.ds4PickDirectory = async () => workspace;
  if (localStorage.getItem('ds4web.settings.v2')) return;
  localStorage.setItem('ds4web.onboarded.v2', JSON.stringify({ v: 2, done: true, at: Date.now() }));
  localStorage.setItem('ds4web.settings.v2', JSON.stringify(settings));
  if (chats) {
    localStorage.setItem('ds4web.chats.v2', JSON.stringify({ v: 2, chats, deleted: [] }));
    localStorage.setItem('ds4web.active.v2', JSON.stringify({ v: 2, ids: active }));
  }
}

class Capture {
  constructor() { this.engine = []; this.pdf = []; this.host = []; this.pageErrors = []; this.consoleErrors = []; }
  mark() { return { engine: this.engine.length, pdf: this.pdf.length, host: this.host.length, pageErrors: this.pageErrors.length, consoleErrors: this.consoleErrors.length }; }
  since(mark) { return Object.fromEntries(Object.entries(mark).map(([key, at]) => [key, this[key].slice(at)])); }
}

const HOST_CALLS = ['/api/agent/send', '/api/agent/attach-image', '/api/cowork/attach-file', '/api/start', '/api/agent/interrupt', '/api/design/session'];

function watch(page, capture, onEvent) {
  const entries = new Map();
  page.on('request', (request) => {
    if (request.method() !== 'POST') return;
    const pathname = new URL(request.url()).pathname;
    const list = pathname === '/v1/chat/completions' ? capture.engine : pathname === '/api/pdf/describe' ? capture.pdf : HOST_CALLS.includes(pathname) ? capture.host : null;
    if (!list) return;
    const entry = { path: pathname, at: Date.now(), body: request.postData() || '', done: false };
    entry.settled = new Promise((resolve) => { entry.settle = resolve; });
    list.push(entry); entries.set(request, entry);
    onEvent({ type: 'request', path: pathname, entry });
  });
  const finish = async (request, failure) => {
    const entry = entries.get(request);
    if (!entry) return;
    entries.delete(request);
    entry.ended = Date.now();
    if (failure) entry.failed = failure;
    else {
      try {
        const response = await request.response();
        entry.status = response?.status() ?? null;
        entry.response = response ? await response.text() : '';
      } catch (error) { entry.failed = String(error.message || error); }
    }
    entry.done = true; entry.settle();
    onEvent({ type: 'response', path: entry.path, entry });
  };
  page.on('requestfinished', (request) => { finish(request, null); });
  page.on('requestfailed', (request) => { finish(request, request.failure()?.errorText || 'request failed'); });
  page.on('pageerror', (error) => capture.pageErrors.push(String(error?.stack || error?.message || error)));
  page.on('console', (message) => { if (message.type() === 'error') capture.consoleErrors.push(message.text().slice(0, 2000)); });
}

// The stream the engine sent for one answer request.
export function parseSse(text) {
  let content = '', reasoning = '', finishReason = null, usage = null, error = null, done = false;
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (data === '[DONE]') { done = true; continue; }
    let event; try { event = JSON.parse(data); } catch { continue; }
    if (event.error) error = event.error.message || String(event.error);
    const choice = event.choices?.[0];
    content += choice?.delta?.content || '';
    reasoning += choice?.delta?.reasoning_content || choice?.delta?.reasoning || '';
    if (choice?.finish_reason) finishReason = choice.finish_reason;
    if (event.usage) usage = event.usage;
  }
  return { content, reasoning, finishReason, usage, error, done };
}

export class EngineFailure extends Error {}

// ------------------------------------------------------- the run ----------

// Statuses a question keeps once it has been asked (or refused before asking):
// a resumed run never asks it again, whatever its outcome.
export const FINAL_STATUSES = ['pass', 'fail', 'blocked', 'interrupted'];

// options:
//   runDir, baseUrl, corpus ({ root, manifest, manifestSha256 }), groups (selectQuestions)
//   mode ('chat' | 'agent' | 'cowork' | 'learn'), expect ('vision' | 'text-only')
//   settings ({ think, temperature, ctx }), freshPerQuestion, workspace (agent/cowork)
//   browser (a Playwright Browser), prepareContext(context) (a simulated launcher installs its routes here)
//   context: a BrowserContext the caller owns and keeps (one browser profile
//     across model switches); the loop opens its own page in it, which is a
//     reload of the app, and closes only that page
//   previous: the results.json of an earlier session of the same run. Its
//     asked questions keep their rows; a question left 'running' takes the
//     row its receipt recorded, or fails as 'interrupted'. Only questions
//     never asked are asked.
//   historyProbe ({ item }): with expect 'text-only', first continue the
//     conversation the page restores (the previous phase's last one, which
//     holds that item's attachments) with a question about them, and check
//     that no pixels of that history reach this model. Not graded as an answer.
//   assertAlive() throws EngineFailure when the owned host or engine is gone
//   afterFailure({ row }) restarts a failed engine or throws; resolves { reload: true } after a restart
//   control ({ stopTurn, abortRun }), onProgress(report), onEvent(event), report (the caller's receipt object)
export async function runVisionCorpus(options) {
  const { runDir, baseUrl, corpus, groups, mode = 'chat', expect = 'vision', browser } = options;
  assert.ok(MODES.includes(mode), `--mode is one of ${MODES.join(', ')}`);
  assert.ok(['vision', 'text-only'].includes(expect), '--expect is vision or text-only');
  const control = options.control || { stopTurn: false, abortRun: false };
  const onEvent = options.onEvent || (() => {});
  const assertAlive = options.assertAlive || (() => {});
  const origin = new URL(baseUrl).origin;
  const payloadDir = path.join(runDir, 'payloads');
  fs.mkdirSync(path.join(runDir, 'questions'), { recursive: true });

  const report = options.report || {};
  const rows = groups.flatMap(({ item, questions }) => questions.map((question) => ({ id: question.id, item: item.id, kind: item.kind, language: item.language,
    type: question.expected.type, tags: question.tags || [], pixelOnly: factsOf(question).some((fact) => fact.pixelOnly), status: 'pending' })));
  Object.assign(report, { schema: RUN_SCHEMA, grader: GRADER_VERSION, mode, expect,
    corpus: { directory: path.relative(process.cwd(), corpus.root), manifestSha256: corpus.manifestSha256, items: corpus.manifest.items.length,
      questions: corpus.manifest.items.reduce((n, item) => n + item.questions.length, 0) },
    selection: { items: groups.length, questions: rows.length, freshPerQuestion: options.freshPerQuestion === true },
    questions: rows, pageErrors: [] });
  const rowOf = (id) => rows.find((row) => row.id === id);
  const receiptDir = (row) => path.join(runDir, 'questions', `${String(rows.indexOf(row) + 1).padStart(3, '0')}-${row.id}`);
  if (options.previous) {
    const before = new Map((options.previous.questions || []).map((row) => [row.id, row]));
    let carried = 0, recovered = 0, interrupted = 0;
    for (const row of rows) {
      const old = before.get(row.id);
      if (!old) continue;
      if (FINAL_STATUSES.includes(old.status)) { Object.assign(row, old, { carried: true }); carried++; continue; }
      if (old.status !== 'running') continue;
      // The runner exited while this question ran. Its receipt is written
      // before results.json; when it exists it holds the recorded outcome.
      let receipt = null;
      try { receipt = JSON.parse(fs.readFileSync(path.join(receiptDir(row), 'row.json'), 'utf8')); } catch { /* not written */ }
      if (receipt && FINAL_STATUSES.includes(receipt.status)) { Object.assign(row, receipt, { carried: true, recoveredFromReceipt: true }); recovered++; }
      else { Object.assign(row, old, { status: 'interrupted', class: 'interrupted', carried: true, error: 'the runner exited while this question was running; its outcome is unknown and it is not asked again' }); interrupted++; }
    }
    report.resume = { carried, recoveredFromReceipt: recovered, interrupted, toAsk: rows.filter((row) => !row.carried).length };
  }
  const save = () => {
    const count = (status) => rows.filter((row) => row.status === status).length;
    const classes = {};
    for (const row of rows) if (row.class) classes[row.class] = (classes[row.class] || 0) + 1;
    report.summary = { denominator: rows.length, passed: count('pass'), failed: count('fail'), notRun: count('not_run'), blocked: count('blocked'), interrupted: count('interrupted'),
      pending: count('pending') + count('running'), classes,
      // Evidence for the pixel path: passed pixel-only questions whose fact reached the model as pixels and in no text.
      pixelPathPasses: rows.filter((row) => row.status === 'pass' && row.pixelOnly && row.evidence?.path === 'pixels').length,
      answerableFromOcrPasses: rows.filter((row) => row.status === 'pass' && row.evidence?.path === 'answerable-from-ocr').length,
      evidenceNotSent: rows.filter((row) => row.evidence && row.evidence.reached === false).length,
      visualPayloadViolations: rows.filter((row) => row.textOnly?.violation).length };
    fs.writeFileSync(path.join(runDir, 'results.json'), `${JSON.stringify(report, (key, value) => key.startsWith('_') ? undefined : value, 2)}\n`);
    options.onProgress?.(report);
  };
  save();

  const known = { corpus: new Map(), pdfPages: new Map(),
    // What must never reach a model: the descriptive ids of the corpus.
    forbidden: corpus.manifest.items.flatMap((item) => [item.id, ...item.questions.map((q) => q.id)]) };
  for (const item of corpus.manifest.items) for (const file of item.files) known.corpus.set(file.sha256, file.path);

  const capture = new Capture();
  const ownContext = !options.context;
  const context = options.context || await browser.newContext({ viewport: { width: 1440, height: 960 } });
  let page = null, appStatus = null, conversations = 0;
  const pageFetch = (url) => page.evaluate(async (target) => { const res = await fetch(target); return res.ok ? res.json() : null; }, url);
  const state = () => page.evaluate(() => {
    const visible = (node) => Boolean(node) && !node.hidden && node.getClientRects().length > 0;
    const study = document.querySelector('#roadmap-study');
    return {
      users: document.querySelectorAll('#messages .msg--user').length, assistants: document.querySelectorAll('#messages .msg--assistant').length,
      streaming: document.querySelectorAll('#messages .msg--streaming').length,
      inputDisabled: document.querySelector('#composer-input')?.disabled === true,
      sendDisabled: document.querySelector('#btn-send')?.disabled === true, sendVisible: visible(document.querySelector('#btn-send')),
      stopVisible: visible(document.querySelector('#btn-stop')),
      tiles: [...document.querySelectorAll('#composer-files .composer__file')].map((node) => ({ name: node.querySelector('.composer__file-name')?.textContent || '', busy: node.getAttribute('aria-busy') === 'true', failed: node.classList.contains('composer__file--failed') })),
      notice: document.querySelector('#composer-files .attachment-notice')?.textContent?.trim() || '',
      toasts: [...document.querySelectorAll('#toasts .toast')].map((node) => node.textContent.trim()),
      draft: document.querySelector('#composer-input')?.value || '',
      study: !visible(study) ? null : {
        users: study.querySelectorAll('.roadmap-study-msg--user').length, assistants: study.querySelectorAll('.roadmap-study-msg--assistant').length,
        thinking: study.querySelectorAll('.roadmap-study-msg__activity').length,
        sendDisabled: study.querySelector('.roadmap-study__send')?.disabled === true,
        tiles: [...study.querySelectorAll('.roadmap-study__files .roadmap-study__file')].map((node) => ({ name: node.querySelector('.roadmap-study__file-name')?.textContent || '' })),
        draft: study.querySelector('.roadmap-study__input')?.value || '',
      },
    };
  });

  try {
    await options.prepareContext?.(context);
    page = await context.newPage();
    watch(page, capture, onEvent);
    // The app's status and model list, read through the browser context as the
    // page reads them, from a same-origin JSON URL: loading the app here would
    // save its default settings before the profile below is seeded.
    await page.goto(`${baseUrl}/api/status`, { waitUntil: 'domcontentloaded' });
    appStatus = await pageFetch('/api/status');
    assert.ok(appStatus, 'the host did not answer /api/status');
    // A shared profile (a later phase of a run) keeps the settings the page saved.
    const profileExisted = await page.evaluate(() => localStorage.getItem('ds4web.settings.v2') !== null);
    const models = await pageFetch('/v1/models');
    const model = options.settings?.model || models?.data?.[0]?.id || null;
    const learnBlocks = options.freshPerQuestion ? rows.length : groups.length;
    const learnRoadmap = { version: 1, title: 'Reading attached material', goal: 'Answer questions about attached documents and images accurately.',
      stages: Array.from({ length: learnBlocks }, (_, i) => ({ id: `stage-${i + 1}`, title: `Material ${i + 1}`,
        topics: [{ id: `block-${i + 1}`, title: `Attached material ${i + 1}`, summary: 'Answer the learner\'s questions about the material they attach.', outcome: 'State exactly what the attached material shows.' }] })) };
    const now = Date.now();
    const seed = { origin, workspace: mode === 'agent' || mode === 'cowork' ? options.workspace : '',
      settings: { v: 2, onboarded: true, theme: 'dark', baseUrl: '', chatBackend: 'local', model, modelVariant: appStatus.variant || 'flash',
        modelGguf: appStatus.modelFile || '', thinkLevel: options.settings?.think || 'off', ctxSize: Number(appStatus.config?.ctx) || 65536,
        enginePower: Number(appStatus.config?.power) || 100, ssdStreaming: appStatus.config?.ssdStreaming || 'off',
        metalHotlistSeed: appStatus.config?.metalHotlistSeed === true, dspark: appStatus.config?.dspark === true,
        temperature: options.settings?.temperature ?? 0, webMode: 'off', qualityDefaultsVersion: 2,
        workdirs: options.workspace ? { agent: options.workspace, cowork: options.workspace } : {} },
      ...(mode === 'learn' ? { chats: [{ id: 'vision-corpus-learn', mode: 'roadmap', title: learnRoadmap.title, createdAt: now, updatedAt: now,
        messages: [{ id: 'vision-corpus-roadmap', role: 'assistant', content: `\`\`\`dstudio-roadmap\n${JSON.stringify(learnRoadmap)}\n\`\`\`` }] }], active: { roadmap: 'vision-corpus-learn' } } : {}) };
    await context.addInitScript(seedProfile, seed);
    report.app = { baseUrl, model, modelFile: appStatus.modelFile || null, mode: appStatus.mode || null, nativeVisionActive: appStatus.nativeVisionActive === true,
      deepseekVisionActive: appStatus.deepseekVisionActive === true, glmVisionActive: appStatus.glmVisionActive === true, config: appStatus.config || null,
      seededSettings: profileExisted ? undefined : seed.settings, profileKept: profileExisted || undefined,
      learnSetup: mode === 'learn' ? 'a seeded roadmap with one neutral study block per conversation; questions are asked in its Tutor room' : undefined };
    save();

    const load = async () => {
      await page.goto(`${baseUrl}/`, { waitUntil: 'domcontentloaded' });
      await page.locator('#composer-input').waitFor({ state: 'attached', timeout: 60_000 });
      // The model the page itself has selected, which decides what it sends.
      report.app.pageSettings = await page.evaluate(() => {
        try { const s = JSON.parse(localStorage.getItem('ds4web.settings.v2') || 'null'); return s && { model: s.model ?? null, modelGguf: s.modelGguf ?? null, thinkLevel: s.thinkLevel ?? null, ctxSize: s.ctxSize ?? null, chatBackend: s.chatBackend ?? null }; }
        catch { return null; }
      });
      if (mode === 'chat') await page.locator('#composer-input').waitFor({ state: 'visible', timeout: 60_000 });
      if (mode === 'learn') { await page.locator('#tab-roadmap').click(); await page.locator('.roadmap-topic').first().waitFor({ state: 'visible', timeout: 60_000 }); }
      if (mode === 'agent' || mode === 'cowork') {
        await page.locator(`#tab-${mode}`).click();
        // Loading the model into the runtime is model work: no limit, only liveness.
        for (;;) {
          const status = await pageFetch('/api/status');
          if (status?.mode === mode && status.running === true && status.ready === true) { appStatus = status; break; }
          if (status?.running === false && status.engineError) throw new EngineFailure(`the ${mode} runtime did not start: ${status.engineError}`);
          await assertAlive(); await sleep(500);
        }
        await page.locator('#agent-view').waitFor({ state: 'visible', timeout: 60_000 });
        report.app.pipeStatus = { mode: appStatus.mode, modelFile: appStatus.modelFile, nativeVisionActive: appStatus.nativeVisionActive === true, workdir: appStatus.workdir || null };
      }
    };
    await load();

    const visionActive = () => (report.app.pipeStatus ?? report.app).nativeVisionActive === true;
    // A selection that does not have the capability the run is about is not run.
    const capabilityBlock = expect === 'vision' && !visionActive() ? 'the app reports no active native vision for this selection'
      : expect === 'text-only' && visionActive() ? 'the app reports native vision as active: not a text-only selection' : '';

    // ---- one conversation ------------------------------------------------
    const openConversation = async () => {
      conversations++;
      if (mode === 'chat') {
        await page.locator('#btn-new-chat').click();
        await page.waitForFunction(() => document.querySelectorAll('#messages .msg').length === 0 && !document.querySelector('#composer-input').disabled, null, { timeout: 30_000 });
      } else if (mode === 'learn') {
        const title = `Attached material ${conversations}`;
        if (await page.locator('#roadmap-study').isVisible().catch(() => false)) await page.locator('#roadmap-study .roadmap-study__head button').first().click();
        const action = page.getByRole('button', { name: `Study ${title}`, exact: true });
        await page.locator('.roadmap-topic__node', { has: action }).hover();
        await action.click();
        await page.locator('.roadmap-study__input').waitFor({ state: 'visible', timeout: 30_000 });
        const level = { off: 'off', high: 'normal', max: 'max' }[options.settings?.think || 'off'] || 'off';
        if (await page.locator('.roadmap-study__think').inputValue() !== level && level !== 'max') await page.locator('.roadmap-study__think').selectOption(level);
      } else {
        // New chat asks for the folder (the native picker returns the run's
        // workspace) and starts a fresh runtime session in it.
        const before = capture.host.length;
        await page.locator('#btn-new-chat').click();
        await page.waitForFunction(() => !document.querySelector('#agent-view .seg') && !document.querySelector('#composer-input').disabled, null, { timeout: 60_000 });
        for (const entry of capture.host.slice(before)) await entry.settled;
      }
    };

    // Runs until the turn ended, was refused by the page, or was stopped.
    const waitTurn = async (baseline, turn) => {
      let started = false, calm = 0, idleSince = Date.now(), lastAlive = 0, stopClicked = false;
      const study = mode === 'learn', pipe = mode === 'agent' || mode === 'cowork';
      for (;;) {
        const s = await state();
        for (const toast of s.toasts) if (!turn.toasts.includes(toast)) turn.toasts.push(toast);
        const view = study ? s.study : s;
        if (!view) return { outcome: 'page_changed' };
        const answering = capture.engine.slice(baseline.engine).some((entry) => !entry.done);
        const reading = capture.pdf.slice(baseline.pdf).some((entry) => !entry.done);
        const sending = capture.host.slice(baseline.host).some((entry) => !entry.done);
        const busy = pipe ? s.stopVisible || sending || reading : study ? answering || reading || view.thinking > 0 || view.sendDisabled && view.tiles.length > 0 && view.users > baseline.state.study.users
          : s.streaming > 0 || s.inputDisabled || answering || reading;
        if (!started) started = pipe ? capture.host.slice(baseline.host).some((entry) => entry.path === '/api/agent/send') : view.users > (study ? baseline.state.study.users : baseline.state.users);
        if ((control.stopTurn || control.abortRun) && !stopClicked && (busy || started)) {
          stopClicked = true; turn.stopRequested = true;
          if (study) { if (!await page.evaluate(() => { const form = document.querySelector('.roadmap-study__form'); const stop = document.querySelector('#roadmap-study [aria-label*="Stop"]'); if (stop) stop.click(); return Boolean(stop) || Boolean(form); })) turn.stopUnavailable = true; }
          else if (s.stopVisible) await page.locator('#btn-stop').click();
          control.stopTurn = false;
        }
        const ended = started && !busy && (pipe ? s.sendVisible : view.assistants > (study ? baseline.state.study.assistants : baseline.state.assistants));
        calm = ended ? calm + 1 : 0;
        if (calm >= 2) return { outcome: stopClicked ? 'stopped' : 'ended' };
        if (busy || started) idleSince = Date.now();
        // Nothing started and nothing is running: the page did not accept the send.
        else if (Date.now() - idleSince > 15_000 || stopClicked) return { outcome: stopClicked ? 'stopped' : 'not_accepted', state: s };
        if (Date.now() - lastAlive > 5000) { lastAlive = Date.now(); await assertAlive(); }
        await sleep(200);
      }
    };

    // The page keeps a file it refused (an image for a model without vision)
    // in the composer, also across New chat. A user removes it before
    // attaching the next item's files; without this the next item's tiles
    // never matched and the loop waited for a count that could not occur.
    const clearPending = async (turn) => {
      const tiles = mode === 'learn' ? '#roadmap-study .roadmap-study__files .roadmap-study__file' : '#composer-files .composer__file';
      const remove = mode === 'learn' ? '.roadmap-study__file-remove' : '.composer__file-remove';
      const names = [];
      for (let left = await page.locator(tiles).count(); left > 0; left = await page.locator(tiles).count()) {
        const tile = page.locator(tiles).first();
        names.push(await tile.locator(mode === 'learn' ? '.roadmap-study__file-name' : '.composer__file-name').textContent().catch(() => ''));
        await tile.locator(remove).click();
        await page.waitForFunction(([selector, n]) => document.querySelectorAll(selector).length < n, [tiles, left], { timeout: 30_000 });
      }
      if (names.length) turn.removedBeforeAttach = names;
    };

    const attach = async (files, turn) => {
      const names = files.map((file) => file.name);
      if (mode !== 'agent') await clearPending(turn);
      if (mode === 'chat' || mode === 'cowork') {
        await page.locator('#chat-file-input').setInputFiles(files.map((file) => file.abs));
        await page.waitForFunction((n) => { const tiles = [...document.querySelectorAll('#composer-files .composer__file')]; return tiles.length === n && tiles.every((tile) => tile.getAttribute('aria-busy') !== 'true'); }, names.length, { timeout: 120_000 });
        const s = await state();
        turn.tiles = s.tiles.map((tile) => tile.name);
        assert.deepEqual(turn.tiles, names, 'the composer does not show the files in the stated order under their names');
        assert.ok(!s.tiles.some((tile) => tile.failed), 'the page could not prepare an attachment');
        return s;
      }
      if (mode === 'learn') {
        await page.locator('.roadmap-study__file-input').setInputFiles(files.map((file) => file.abs));
        await page.waitForFunction((n) => document.querySelectorAll('#roadmap-study .roadmap-study__files .roadmap-study__file').length === n, names.length, { timeout: 120_000 });
        // Reading the file is asynchronous: Send is enabled once every file is ready (or stays disabled when the page refuses it).
        await page.waitForFunction(() => !document.querySelector('#roadmap-study .attachment-activity'), null, { timeout: 120_000 });
        const s = await state();
        turn.tiles = s.study.tiles.map((tile) => tile.name);
        assert.deepEqual(turn.tiles, names, 'the study room does not show the files in the stated order under their names');
        return s;
      }
      // Agent: an image is dropped on the conversation and saved in the
      // workspace by the page; a PDF is a file of the workspace folder.
      const images = files.filter((file) => /\.png$/i.test(file.name)), others = files.filter((file) => !images.includes(file));
      for (const file of others) fs.copyFileSync(file.abs, path.join(options.workspace, file.name));
      if (images.length) {
        const before = capture.host.length;
        await page.evaluate((list) => {
          const transfer = new DataTransfer();
          for (const file of list) transfer.items.add(new File([Uint8Array.from(atob(file.base64), (c) => c.charCodeAt(0))], file.name, { type: 'image/png' }));
          const target = document.querySelector('.chat');
          for (const type of ['dragenter', 'dragover', 'drop']) target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer }));
        }, images.map((file) => ({ name: file.name, base64: fs.readFileSync(file.abs).toString('base64') })));
        await page.waitForFunction((n) => (document.querySelector('#composer-input').value.match(/\[USER_SCREENSHOT /g) || []).length === n, images.length, { timeout: 120_000 });
        for (const entry of capture.host.slice(before)) await entry.settled;
      }
      turn.tiles = names;
      return state();
    };

    const readStore = async () => (await pageFetch('/api/store'))?.data || null;
    // The persisted conversation is the page's own record of the answer.
    const storedTurn = (store, prompt) => {
      for (const chat of store?.chats || []) {
        if (mode === 'learn') {
          for (const message of chat.messages || []) for (const thread of Object.values(message.roadmapStudyThreads || {})) {
            const at = (thread.messages || []).findLastIndex((m) => m.role === 'user' && m.content === prompt);
            if (at >= 0) return { user: thread.messages[at], assistant: thread.messages[at + 1] || null };
          }
        } else if (mode === 'chat') {
          if ((chat.mode || 'chat') !== 'chat') continue;
          const at = (chat.messages || []).findLastIndex((m) => m.role === 'user' && m.content === prompt);
          if (at >= 0) return { user: chat.messages[at], assistant: chat.messages[at + 1] || null };
        } else if (chat.mode === mode && String(chat.transcript || '').includes(prompt)) return { transcript: chat.transcript };
      }
      return null;
    };

    // ---- one question ------------------------------------------------------
    const ask = async ({ item, question, files, firstOfConversation, row }) => {
      const turn = { toasts: [], tiles: [], attached: files.map((file) => ({ name: file.name, bytes: file.bytes, sha256: file.sha256 })) };
      const began = performance.now();
      let prompt = question.prompt;
      if (mode === 'agent' && item.kind === 'pdf') {
        // The Agent composer attaches images only: the user names the PDF of the folder.
        prompt = `${item.language === 'it' ? `Riguardo al file ${path.basename(item.files[0].path)} in questa cartella` : `About the file ${path.basename(item.files[0].path)} in this folder`}: ${prompt}`;
        turn.promptAdaptation = 'agent-file-reference';
      }
      const study = mode === 'learn', pipe = mode === 'agent' || mode === 'cowork';
      let now = await state();
      if (files.length) now = await attach(files, turn);
      const view = study ? now.study : now;
      const mark = capture.mark();
      const baseline = { ...mark, state: now };
      // The page refuses to send an image to a model without vision and keeps the attachment.
      if (!pipe && view.sendDisabled && (now.notice || study) && files.length) {
        turn.blocked = { notice: now.notice || 'Send is disabled while an image is attached to a model without vision', attachmentsKept: view.tiles.map((tile) => tile.name) };
      } else {
        const input = page.locator(study ? '.roadmap-study__input' : '#composer-input');
        await input.fill(pipe ? `${await input.inputValue()}${prompt}` : prompt);
        turn.sentAt = new Date().toISOString();
        await page.locator(study ? '.roadmap-study__send' : '#btn-send').click();
        const waited = await waitTurn(baseline, turn);
        turn.outcome = waited.outcome;
        if (waited.outcome === 'not_accepted') turn.blocked = { notice: waited.state.notice || turn.toasts.join(' | ') || 'the page did not accept the message', attachmentsKept: (study ? waited.state.study : waited.state)?.tiles.map((tile) => tile.name) || [] };
      }
      const seen = capture.since(mark);
      await Promise.all([...seen.engine, ...seen.pdf, ...seen.host].map((entry) => entry.settled));
      turn.elapsedMs = Math.round(performance.now() - began);

      // PDF reads of this turn: what the reader was asked and what it returned.
      turn.pdfReads = seen.pdf.map((entry) => {
        let asked = {}, got = {};
        try { asked = JSON.parse(entry.body); } catch { /* recorded as empty */ }
        try { got = JSON.parse(entry.response || '{}'); } catch { /* recorded as empty */ }
        const source = dataUri(asked.data_uri);
        const vision = (Array.isArray(got.vision) ? got.vision : []).map((v) => ({ page: v.page, ...(dataUri(v.image) || {}) }));
        for (const v of vision) if (v.sha256) known.pdfPages.set(v.sha256, { file: item.files[0].path, page: v.page });
        const pages = pdfTextPages(got.text || '');
        return { profile: asked.profile || null, pages: asked.pages || null, semanticQuery: asked.semantic_query || null, nativeVision: asked.native_vision === true, textOnly: asked.text_only === true,
          sourceSha256: source?.sha256 || null, sourceIsCorpusFile: source ? known.corpus.get(source.sha256) || false : null, status: entry.status ?? null, failed: entry.failed || null,
          ok: got.ok === true, readPlanRequired: got.readPlanRequired === true, completeText: got.completeText === true, total: got.total ?? null, textPages: got.textPages ?? null,
          scannedPages: got.scannedPages ?? null, ocrPages: got.ocrPages ?? null, ocrPendingPages: got.ocrPendingPages ?? null, ocrAvailable: got.ocrAvailable ?? null,
          truncated: got.truncated === true, sampled: got.sampled === true, error: got.error || null,
          visionPages: vision.map(({ page: n, bytes, sha256: digest }) => ({ page: n, bytes, sha256: digest })),
          textLayerPages: pages.filter((p) => p.kind === 'text-layer').map((p) => p.page), ocrTextPages: pages.filter((p) => p.kind === 'ocr').map((p) => p.page),
          _layerText: pages.filter((p) => p.kind === 'text-layer').map((p) => p.text).join('\n'), _ocrText: pages.filter((p) => p.kind === 'ocr').map((p) => p.text).join('\n') };
      });
      turn.engineRequests = seen.engine.map((entry) => ({ ...summariseChatBody(entry.body, known), status: entry.status ?? null, failed: entry.failed || null, _entry: entry }));
      turn.hostCalls = seen.host.map((entry) => {
        let asked = {}; try { asked = JSON.parse(entry.body); } catch { /* recorded as empty */ }
        const data = dataUri(asked.data_uri);
        let got = {}; try { got = JSON.parse(entry.response || '{}'); } catch { /* recorded as empty */ }
        return { path: entry.path, status: entry.status ?? null, failed: entry.failed || null, name: asked.name || null, rel: got.rel || null,
          sha256: data?.sha256 || null, bytes: data?.bytes ?? null, corpusFile: data ? known.corpus.get(data.sha256) || null : null,
          prompt: entry.path === '/api/agent/send' ? asked.prompt ?? null : undefined, mode: entry.path === '/api/start' ? asked.mode ?? null : undefined,
          forbidden: known.forbidden.filter((needle) => entry.body.includes(needle)) };
      });
      turn.pageErrors = seen.pageErrors; turn.consoleErrors = seen.consoleErrors;

      // The final answer.
      const answerRequest = turn.engineRequests.filter((request) => request.kind === 'answer').at(-1) || null;
      const stream = answerRequest?._entry.response ? parseSse(answerRequest._entry.response) : null;
      let stored = null;
      if (!turn.blocked) for (let i = 0; i < 100; i++) {
        stored = storedTurn(await readStore(), prompt);
        if (pipe ? stored?.transcript && parseAgentTurn(stored.transcript, prompt) : stored?.assistant && !stored.assistant.streaming) break;
        await sleep(200);
      }
      if (pipe) {
        const parsed = stored?.transcript ? parseAgentTurn(stored.transcript, prompt) : null;
        turn.answer = { text: parsed?.answer ?? '', source: parsed ? 'persisted transcript' : 'none', visibleChars: parsed?.visible.length ?? 0 };
        turn.agent = parsed ? { events: parsed.events, tools: parsed.tools.map((tool) => ({ name: tool.name, input: tool.input, outputChars: (tool.output || '').length })), _tools: parsed.tools, _raw: parsed.raw } : null;
      } else {
        const assistant = stored?.assistant && !stored.assistant.streaming ? stored.assistant : null;
        turn.answer = { text: assistant ? String(assistant.content || '') : stream?.content ?? '', source: assistant ? 'persisted conversation' : stream ? 'engine stream' : 'none',
          finishReason: assistant?.finishReason ?? stream?.finishReason ?? null, error: assistant?.error ?? (stream?.error ? { message: stream.error } : null),
          reasoningChars: (assistant?.reasoning || stream?.reasoning || '').length, usage: stream?.usage || null,
          streamContentChars: stream?.content.length ?? null, streamDone: stream?.done ?? null };
        turn.conversationAttachments = (stored?.user?.attachments || []).map((a) => ({ name: a.name, kind: a.kind, internal: a.internal === true }));
      }
      turn.promptSent = prompt;
      return turn;
    };

    // What of this question's evidence was actually sent.
    const sentFor = (item, turn) => {
      const pipe = mode === 'agent' || mode === 'cowork';
      if (!pipe) {
        const request = turn.engineRequests.filter((r) => r.kind === 'answer').at(-1);
        if (!request) return { pixels: [], layerText: '', ocrText: '' };
        const mine = new Set(item.files.map((file) => file.path));
        const pixels = request.imageParts.items.flatMap((part) => part.pdfPage && mine.has(part.pdfPage.file) ? [{ file: part.pdfPage.file, page: part.pdfPage.page }]
          : part.corpusFile && mine.has(part.corpusFile) ? [{ file: part.corpusFile, page: null }] : []);
        return { pixels, layerText: request._layerText, ocrText: request._ocrText };
      }
      // Agent and Cowork: pixels reach the model only through the image tool,
      // PDF text only through the reading tool. The page's request carries paths.
      const saved = new Map(turn.savedFiles.map((file) => [file.rel || file.name, file]));
      const tools = turn.agent?._tools || [];
      const pixels = [], texts = [];
      for (const tool of tools) {
        const target = String(tool.input?.path ?? tool.input?.file ?? tool.input?.image ?? '');
        if (/^(?:view_image|see_image)$/.test(tool.name)) {
          const file = [...saved.values()].find((entry) => target === entry.rel || target.endsWith(`/${entry.rel}`) || path.basename(target) === entry.name);
          const pageOf = /-page-(\d+)\.jpe?g$/i.exec(target);
          if (file?.corpusFile && item.files.some((f) => f.path === file.corpusFile)) pixels.push({ file: file.corpusFile, page: null });
          else if (pageOf) pixels.push({ file: item.files[0].path, page: Number(pageOf[1]) });
        } else if (/^(?:read_pdf|read_document)$/.test(tool.name)) texts.push(tool.output || '');
      }
      const pages = pdfTextPages(texts.map((text) => `\n${text}\n`).join(''));
      return { pixels, layerText: pages.filter((p) => p.kind === 'text-layer').map((p) => p.text).join('\n'), ocrText: pages.filter((p) => p.kind === 'ocr').map((p) => p.text).join('\n') };
    };

    const finishRow = (row, item, question, turn) => {
      const pipe = mode === 'agent' || mode === 'cowork';
      turn.savedFiles = (turn.hostCalls || []).filter((call) => /attach/.test(call.path));
      const sent = sentFor(item, turn);
      const evidence = evidenceReport(item, question, sent);
      const requests = turn.engineRequests.map(({ _entry, _layerText, _ocrText, _pages, ...rest }) => rest);
      const violations = [...turn.engineRequests.filter((r) => r.visual?.any).map((r) => ({ request: r.kind, ...r.visual })),
        ...(pipe ? (turn.agent?._tools || []).filter((tool) => /^(?:view_image|see_image)$/.test(tool.name)).map((tool) => ({ request: 'runtime tool', tool: tool.name })) : [])];
      const forbidden = [...new Set([...turn.engineRequests.flatMap((r) => r.forbidden || []), ...(turn.hostCalls || []).flatMap((c) => c.forbidden || [])])];
      Object.assign(row, { conversation: conversations, promptSent: turn.promptSent, promptAdaptation: turn.promptAdaptation, attached: turn.attached, tiles: turn.tiles,
        removedBeforeAttach: turn.removedBeforeAttach,
        elapsedMs: turn.elapsedMs, sentAt: turn.sentAt, outcome: turn.outcome || (turn.blocked ? 'blocked_by_page' : null), toasts: turn.toasts,
        requests, pdfReads: turn.pdfReads.map(({ _layerText, _ocrText, ...rest }) => rest), hostCalls: turn.hostCalls,
        agent: turn.agent ? { events: turn.agent.events, tools: turn.agent.tools } : undefined,
        answer: turn.answer, conversationAttachments: turn.conversationAttachments, evidence, itemIdsSent: forbidden,
        pageErrors: turn.pageErrors.length ? turn.pageErrors : undefined, consoleErrors: turn.consoleErrors.length ? turn.consoleErrors : undefined });
      if (turn.pageErrors.length) report.pageErrors.push(...turn.pageErrors.map((error) => ({ question: row.id, error })));
      const knownText = [...item.questions.flatMap((q) => factsOf(q).map((fact) => fact.fact)), sent.layerText, sent.ocrText].join('\n');
      const context = { language: item.language, knownText };
      const answer = turn.answer?.text ?? '';
      const answerError = turn.answer?.error || turn.engineRequests.some((r) => r.kind === 'answer' && (r.failed || (r.status && r.status >= 400)));

      if (expect === 'text-only') {
        // Nothing visual may reach this model, in any request of the turn.
        const visible = pipe ? false : evidence.facts.some((fact) => fact.pixelsSent);
        row.textOnly = { violation: violations.length > 0 || visible, payloads: violations,
          attachmentKept: turn.blocked ? turn.blocked.attachmentsKept.length === turn.attached.length || turn.attached.length === 0
            : pipe ? true : turn.attached.length === 0 || (turn.conversationAttachments || []).filter((a) => !a.internal).length >= turn.attached.length };
        if (row.textOnly.violation) return Object.assign(row, { status: 'fail', class: 'pixels_sent_to_text_only_model' });
        if (!row.textOnly.attachmentKept) return Object.assign(row, { status: 'fail', class: 'attachment_dropped' });
        if (turn.blocked) {
          // The page itself states the limitation and keeps the file: nothing was sent.
          row.grade = { passed: true, class: 'refused_by_app', type: 'honest-limitation', detail: { notice: turn.blocked.notice }, grader: GRADER_VERSION };
          return Object.assign(row, { status: 'pass', class: 'refused_by_app' });
        }
      } else if (turn.blocked) return Object.assign(row, { status: 'fail', class: 'send_refused_by_page', error: turn.blocked.notice });
      if (turn.outcome === 'stopped') return Object.assign(row, { status: 'fail', class: 'stopped', grade: null });
      if (turn.outcome !== 'ended') return Object.assign(row, { status: 'fail', class: turn.outcome || 'no_turn' });
      if (answerError && !answer.trim()) return Object.assign(row, { status: 'fail', class: 'engine_error', error: turn.answer?.error?.message || 'the engine request failed' });
      if (!pipe && turn.answer.finishReason && !['stop', 'length'].includes(turn.answer.finishReason)) {
        return Object.assign(row, { status: 'fail', class: turn.answer.finishReason === 'aborted' ? 'stopped' : turn.answer.error ? 'engine_error' : 'incomplete', error: turn.answer.error?.message });
      }
      // A model without pixels asked for a fact that exists only in pixels and in no text it received: the honest answer is a limitation.
      const limited = expect === 'text-only' && question.expected.type !== 'unanswerable' && evidence.reached === false;
      row.grade = limited ? gradeHonestLimitation(question, answer, context) : gradeAnswer(question, answer, context);
      if (limited && !row.grade.passed && gradeAnswer(question, answer, context).passed) row.grade.class = 'pixel_fact_stated_without_pixels';
      row.status = row.grade.passed ? 'pass' : 'fail';
      // A wrong answer to a question whose evidence was never sent is not a reading failure of the model.
      row.class = !row.grade.passed && !limited && evidence.notSent ? evidence.notSent : row.grade.class;
      if (row.grade.passed && !limited && question.expected.type !== 'unanswerable' && evidence.reached === false) row.unexplainedPass = true;
      if (turn.answer.finishReason === 'length') row.truncated = true;
      return row;
    };

    const writeReceipt = (row, turn, dir = receiptDir(row)) => {
      fs.mkdirSync(dir);
      const write = (name, value) => fs.writeFileSync(path.join(dir, name), typeof value === 'string' ? value : `${JSON.stringify(value, (key, entry) => key.startsWith('_') ? undefined : entry, 2)}\n`, { flag: 'wx' });
      if (turn) {
        turn.engineRequests.forEach((request, i) => {
          write(`engine-request-${i + 1}-${request.kind}.json`, archiveBody(request._entry.body, payloadDir));
          if (request._entry.response) write(`engine-response-${i + 1}-${request.kind}.txt`, request._entry.response);
        });
        if (turn.agent?._raw) write('runtime-transcript.txt', turn.agent._raw);
        write('answer.txt', turn.answer?.text ?? '');
      }
      write('row.json', row);
    };

    // ---- history probe (a model switch, then a reload) -------------------------
    const historyProbe = async () => {
      const { item } = options.historyProbe;
      const probe = { item: item.id, status: 'running' };
      report.historyProbe = probe;
      const s = await state();
      const activeId = await page.evaluate(() => { try { return JSON.parse(localStorage.getItem('ds4web.active.v2') || 'null')?.ids?.chat ?? null; } catch { return null; } });
      const attachmentsOf = (store) => ((store?.chats || []).find((c) => c.id === activeId)?.messages || [])
        .flatMap((m) => m.role === 'user' ? (m.attachments || []).map((a) => ({ name: a.name, kind: a.kind, internal: a.internal === true })) : []);
      probe.restored = { conversation: activeId, users: s.users, assistants: s.assistants, attachments: attachmentsOf(await readStore()) };
      if (mode !== 'chat' || !activeId || !s.users || !probe.restored.attachments.length)
        return Object.assign(probe, { status: 'fail', class: 'no_restored_conversation', error: 'the reloaded page did not restore a conversation with attachments to continue' });
      const kind = item.kind === 'pdf' ? (item.language === 'it' ? 'il documento' : 'the document') : (item.language === 'it' ? 'l\'immagine' : 'the image');
      const prompt = item.language === 'it' ? `Guarda di nuovo ${kind} che ho allegato prima in questa conversazione e descrivi che cosa mostra.`
        : `Look again at ${kind} I attached earlier in this conversation and describe what it shows.`;
      const turn = await ask({ item, question: { prompt, expected: { type: 'unanswerable' } }, files: [], firstOfConversation: false, row: probe });
      const violations = turn.engineRequests.filter((r) => r.visual?.any).map((r) => ({ request: r.kind, ...r.visual }));
      Object.assign(probe, { prompt, outcome: turn.outcome, toasts: turn.toasts, elapsedMs: turn.elapsedMs,
        requests: turn.engineRequests.map(({ _entry, _layerText, _ocrText, _pages, ...rest }) => rest), answer: turn.answer,
        conversationAttachments: turn.conversationAttachments, visualPayload: violations,
        pageErrors: turn.pageErrors.length ? turn.pageErrors : undefined });
      // The conversation still lists every attachment it had: nothing dropped to make the request text-only.
      probe.attachmentsAfter = attachmentsOf(await readStore());
      const kept = probe.attachmentsAfter.length >= probe.restored.attachments.length;
      if (violations.length) Object.assign(probe, { status: 'fail', class: 'pixels_sent_to_text_only_model' });
      else if (turn.outcome !== 'ended') Object.assign(probe, { status: 'fail', class: turn.outcome || 'no_turn' });
      else if (!turn.engineRequests.some((r) => r.kind === 'answer')) Object.assign(probe, { status: 'fail', class: 'no_request' });
      else Object.assign(probe, { status: kept ? 'pass' : 'fail', class: kept ? 'history_isolated' : 'attachment_dropped' });
      try { writeReceipt(probe, turn, path.join(runDir, 'questions', '000-history-probe')); } catch (error) { probe.receiptError = String(error.message); }
      save();
      return probe;
    };

    // ---- the loop ----------------------------------------------------------
    let stopReason = capabilityBlock;
    if (capabilityBlock) for (const row of rows) if (!row.carried) Object.assign(row, { status: 'blocked', class: 'capability_mismatch', error: capabilityBlock });
    if (options.historyProbe && !capabilityBlock) {
      assert.equal(expect, 'text-only', 'the history probe checks a text-only model');
      try { await historyProbe(); }
      catch (error) { Object.assign(report.historyProbe, { status: 'fail', class: error instanceof EngineFailure ? 'engine_failure' : 'runner_error', error: String(error.stack || error).slice(0, 4000) }); save(); }
      if (report.historyProbe.status !== 'pass') await load();
    }
    for (const { item, questions } of capabilityBlock ? [] : groups) {
      let files = null, clean = false;
      for (const question of questions) {
        const row = rowOf(question.id);
        // Asked in an earlier session of this run: never asked again.
        if (row.carried) {
          clean = false;
          if (row.class === 'interrupted' && !fs.existsSync(receiptDir(row))) try { writeReceipt(row, null); } catch { /* recorded in results.json */ }
          continue;
        }
        if (stopReason || control.abortRun) { Object.assign(row, { status: 'not_run', class: 'not_run', error: stopReason || 'the run was stopped' }); continue; }
        row.status = 'running'; row.started = new Date().toISOString(); save();
        let turn = null;
        try {
          files ??= itemFiles(corpus.root, item);
          const fresh = !clean || options.freshPerQuestion === true;
          if (fresh) await openConversation();
          turn = await ask({ item, question, files: fresh ? files : [], firstOfConversation: fresh, row });
          finishRow(row, item, question, turn);
          // The operator ended the run during this answer: not a model failure, not asked again.
          if (control.abortRun && turn.stopRequested && row.status !== 'pass')
            Object.assign(row, { status: 'interrupted', class: 'interrupted_by_operator', error: 'the run was stopped during this answer' });
          // A turn that did not end normally leaves the conversation in an unknown state.
          // The page ends a turn whose engine failed like any other, keeping
          // the partial text in its history: that is not a clean conversation either.
          clean = turn.outcome === 'ended' && !turn.blocked && !turn.answer?.error && [null, undefined, 'stop', 'length'].includes(turn.answer?.finishReason);
        } catch (error) {
          clean = false;
          Object.assign(row, control.abortRun ? { status: 'interrupted', class: 'interrupted_by_operator', error: String(error.stack || error).slice(0, 4000) }
            : { status: 'fail', class: error instanceof EngineFailure ? 'engine_failure' : 'runner_error', error: String(error.stack || error).slice(0, 4000) });
        }
        row.finished = new Date().toISOString();
        try { writeReceipt(row, turn); } catch (error) { row.receiptError = String(error.message); }
        save();
        onEvent({ type: 'row', row });
        console.log(`vision-corpus ${rows.indexOf(row) + 1}/${rows.length} ${row.id}: ${row.status}${row.class ? ` (${row.class})` : ''}`);
        if (control.abortRun) { stopReason = 'the run was stopped'; continue; }
        if (row.status === 'fail' && ['engine_failure', 'engine_error', 'incomplete', 'stopped', 'runner_error', 'no_turn', 'page_changed'].includes(row.class)) {
          try {
            const recovery = await options.afterFailure?.({ row });
            await assertAlive();
            if (recovery?.reload || row.class !== 'engine_error') await load();
          } catch (error) { stopReason = `stopped after ${row.id}: ${String(error.message || error).slice(0, 500)}`; }
        }
      }
      // A workspace keeps only the files of the conversation in progress.
      if ((mode === 'agent' || mode === 'cowork') && options.workspace) for (const name of fs.readdirSync(options.workspace)) {
        const file = path.join(options.workspace, name);
        if (fs.statSync(file).isFile()) fs.rmSync(file);
      }
    }
    for (const row of rows) if (row.status === 'pending' || row.status === 'running') Object.assign(row, { status: 'not_run', class: 'not_run', error: stopReason || 'the run did not reach this question' });
    report.stopReason = stopReason || undefined;
    save();
    report.status = rows.every((row) => row.status === 'pass') && !report.pageErrors.length &&
      (!report.historyProbe || report.historyProbe.status === 'pass') ? 'pass' : 'fail';
  } finally {
    report.finished = new Date().toISOString();
    for (const row of rows) if (row.status === 'pending' || row.status === 'running') Object.assign(row, { status: 'not_run', class: 'not_run', error: report.error || 'the run ended before this question' });
    save();
    // Routes a simulated launcher installed may be handling a poll right now.
    if (ownContext) { await context.unrouteAll({ behavior: 'ignoreErrors' }).catch(() => {}); await context.close().catch(() => {}); }
    else await page?.close().catch(() => {});
  }
  return report;
}

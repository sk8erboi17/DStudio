import assert from 'node:assert/strict';
import fs from 'node:fs';
const runtime = fs.readFileSync('extension/search/runtime.js', 'utf8');
const html = fs.readFileSync('web/index.html', 'utf8');
// Inline module extraction is harness plumbing; assertions execute the actual
// reply lifecycle, committed message and rendered text, never source wording.
const start = html.indexOf('      async function runAssistantReply(');
const end = html.indexOf('      function renderChatIfActive(', start);
const replySource = html.slice(start, end);
const query = 'Compare the sources in at most 80 words';
const answer = 'The sources disagree on guest inclusion [F1][F2].';
let chat, streaming, rendered, committed, inferenceCalls, engineStarts, announcements;
const noop = () => {};
const view = { setContent: text => { rendered = text; }, finalize: noop, setActivity: noop, appendReasoning: noop };
const Store = {
  getChat: id => id === chat.id ? chat : null,
  isChatStreaming: () => Boolean(streaming), getActiveChat: () => chat,
  mkMessage: (role, content) => ({ id: 'answer', role, content }),
  appendMessage: (_id, message) => chat.messages.push(message),
  setChatStreaming: (_id, controller) => { streaming = controller; },
  patchMessage: (_id, msgId, fields) => Object.assign(chat.messages.find(m => m.id === msgId), fields),
  commitMessage: (_id, msgId, fields) => { committed = fields; Object.assign(chat.messages.find(m => m.id === msgId), fields); },
  setConnection: noop,
};
const Messages = {
  renderChat: noop, beginAssistant: () => view, shouldAutoFollow: () => false, finishAutoFollow: noop,
  announce: text => announcements.push(text),
};
const Api = {
  invalidateHealth: noop,
  async *streamChat() { inferenceCalls++; yield { type: 'content', text: 'Ordinary streamed reply' }; yield { type: 'finish', reason: 'stop' }; },
};
const bindings = {
  Store, Messages, Api,
  Switcher: { ensureChatReady: async () => { engineStarts++; return {}; } },
  noopAssistantView: () => view, assistantInitialActivity: () => '',
  createContentHoldback: () => ({ push: content => ({ content }), flush: () => ({}) }),
  localNativeVisionSelected: () => false, testBuildHistory: () => [],
  extractVideoGenerationDirectiveFromAssistant: content => ({ content }),
  extractImageGenerationDirectiveFromAssistant: content => ({ content }),
  extractGeneratedFilesFromAssistant: content => ({ content, files: [] }),
  normalizeAssistantDiagramFences: text => text, runawayAsciiDiagramCutoff: () => -1,
  researchReportFilename: () => 'research.md', openGeneratedFilesCanvas: noop,
  webQueryForMessage: message => message.content,
};
const runReply = new Function(...Object.keys(bindings), `${runtime}\nbuildHistory = testBuildHistory;\n${replySource}\nreturn runAssistantReply;`)(...Object.values(bindings));
function reset(web) {
  streaming = null; rendered = null; committed = null; inferenceCalls = 0; engineStarts = 0; announcements = [];
  chat = { id: 'chat', messages: [{ id: 'question', role: 'user', content: query, web }] };
}
const reviewed = {
  mode: 'research', report: answer, elapsedMs: 2000, sources: [{ url: 'https://example.test/' }],
  reportQuality: { deliveryVersion: 1, reviewedText: answer, request: query, ok: true, audit: { ok: true } },
};
reset(reviewed);
await runReply('chat', 'question', {});
assert.equal(rendered, answer);
assert.equal(committed.content, answer);
assert.equal(committed.researchReport.markdown, answer);
assert.equal(committed.finishReason, 'stop');
assert.equal(committed.error, null);
assert.ok(committed.elapsedMs >= 2000, 'Direct delivery must not hide time spent collecting and reviewing evidence');
assert.equal(streaming, null);
assert.equal(inferenceCalls, 0, 'A reviewed answer must not be rewritten after its checks');
assert.equal(engineStarts, 0, 'Delivering prepared evidence does not require another model start');

for (const web of [
  { ...reviewed, report: answer + ' unreviewed addition' },
  { ...reviewed, stopReason: 'Evidence budget ended' },
  { ...reviewed, reportQuality: { ...reviewed.reportQuality, ok: false } },
  { ...reviewed, reportQuality: { ...reviewed.reportQuality, audit: null } },
]) {
  reset(web); await runReply('chat', 'question', {});
  assert.equal(committed.finishReason, 'incomplete');
  assert.equal(committed.error.type, 'research-review');
  assert.equal(inferenceCalls, 0);
  assert.deepEqual(announcements, ['Response incomplete']);
}
for (const web of [undefined, { mode: 'search' }, { mode: 'research', report: 'Legacy report' }]) {
  reset(web); await runReply('chat', 'question', {});
  assert.equal(committed.content, 'Ordinary streamed reply');
  assert.equal(inferenceCalls, 1, 'Ordinary Chat/Search and legacy contexts keep their original streaming path');
  assert.equal(engineStarts, 1);
}
console.log('research_reply_delivery: production reply commits/renders exact reviewed bytes, incomplete status, no second inference, ordinary Chat/Search preserved');

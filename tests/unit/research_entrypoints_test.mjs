// Public production entry points over actual HTTP with simulated model/page
// replies. No weights, external websites or model-quality claim.
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {createWebPipeline} from '../support/real_harness.mjs';

const sourceUrl = 'https://evidence.test/orchid';
const comparisonUrl = 'https://evidence.test/lily';
const sentence = 'Orchid waits for an acknowledgement before retrying.';
const comparisonSentence = 'Lily retries immediately without waiting for an acknowledgement.';
const answer = `Orchid attende la conferma prima di ritentare [F1].\n\nFonte: ${sourceUrl}`;
const calls = [];
let blockedRead, readEntered;
let comparison = false, judgeCalls = 0;
function json(res, value) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); }
const server = http.createServer(async (req, res) => {
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
  calls.push({path: req.url, body});
  if (req.url === '/api/status') return json(res, {ready: true, nativeVisionActive: false});
  if (req.url === '/api/web-search') return json(res, {ok: true, sources: [
    {url: comparisonUrl, title: 'Lily handbook', content: 'Official retry documentation'},
    {url: 'https://unrelated.test/orchid', title: 'Orchid flowers', content: 'Unrelated homonym'},
  ]});
  if (req.url === '/api/web-read') {
    if (blockedRead) { readEntered(); await blockedRead; }
    assert.ok([sourceUrl, comparisonUrl].includes(body.url), 'Only selected evidence may be read');
    return json(res, {ok: true, title: body.url === sourceUrl ? 'Orchid handbook' : 'Lily handbook', url: body.url,
      canonicalUrl: body.url, reader: 'simulated page', markdown: `${body.url === sourceUrl ? sentence : comparisonSentence}\n${'The official handbook describes retry handling and acknowledgements. '.repeat(12)}`});
  }
  assert.equal(req.url, '/v1/chat/completions');
  const system = body.messages[0].content;
  let content;
  if (system.includes('search classifier')) content = {needsSearch: comparison, explicitUrls: [], queries: comparison ? ['Orchid Lily retry'] : []};
  else if (system.includes('source picker')) content = {reason: 'The second handbook answers the comparison.', urls: [comparisonUrl]};
  else if (system.includes('evidence extractor')) {
    const fact = body.messages[1].content.includes(comparisonSentence) ? comparisonSentence : sentence;
    content = {facts: [{fact, excerpt: fact}]};
  }
  else if (system.includes('research sufficiency judge')) content = {decision: comparison && judgeCalls++ === 0 ? 'continue' : 'enough', reason: 'Read evidence checked.', answerFactIds: comparison ? ['F1', 'F2'] : ['F1'], gaps: []};
  else if (system.includes('Deep Research writer')) content = answer;
  else if (system.includes('final-answer evidence reviewer')) content = {claimsSupported: true, requestedPartsCovered: true, conflictsHandled: true, instructionsFollowed: true, issues: []};
  else { res.statusCode = 500; return json(res, {error: 'Unexpected simulated model request'}); }
  json(res, {choices: [{message: {content: typeof content === 'string' ? content : JSON.stringify(content)}}]});
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const bound = setTimeout(() => { server.closeAllConnections(); throw Error('Entrypoint test exceeded its isolated bound'); }, 10000);
try {
  const pipeline = createWebPipeline(`http://127.0.0.1:${server.address().port}`);
  const question = `Come gestisce Orchid il retry? Rispondi in italiano. ${sourceUrl}`;
  for (const mode of ['search', 'research']) {
    calls.length = 0; const traces = [];
    const result = mode === 'search'
      ? await pipeline.searchWithPlan(question, {model: 'simulated'}, trace => traces.push(trace))
      : await pipeline.runDeepResearch(question, {model: 'simulated'}, trace => traces.push(trace));
    assert.equal(result.plan.mode, mode); assert.equal(result.judge.decision, 'enough');
    assert.equal(result.sources.length, 1); assert.equal(result.sources[0].read, true);
    assert.equal(result.sources[0].explicit, true);
    assert.ok(result.sources[0].title.includes('Orchid'));
    assert.equal(result.facts[0].fact, sentence); assert.equal(result.facts[0].sourceUrl, sourceUrl);
    assert.ok(result.context.includes(question)); assert.ok(traces.at(-1).every(row => row.state !== 'active'));
    assert.equal(calls.filter(call => call.path === '/api/web-read').length, 1);
    assert.equal(calls.filter(call => call.path === '/api/web-search').length, 0, 'Sufficient explicit evidence needs no unrelated discovery');
    assert.ok(calls.filter(call => call.path === '/v1/chat/completions').every(call => call.body.think === false));
    if (mode === 'research') {
      assert.equal(result.report, answer); assert.equal(result.reportQuality.ok, true);
      assert.equal(result.reportSynthesisError, '');
    }
    console.log(`PASS: ${mode} entry point preserves evidence, language request, protocol and completion over HTTP`);
  }
  comparison = true; calls.length = 0;
  const compareQuestion = `Confronta il retry di Orchid e Lily. ${sourceUrl}`;
  const compared = await pipeline.searchWithPlan(compareQuestion, {model: 'simulated'});
  assert.deepEqual(compared.sources.map(source => source.url), [sourceUrl, comparisonUrl]);
  assert.deepEqual(compared.facts.map(fact => fact.fact), [sentence, comparisonSentence]);
  assert.ok(compared.context.includes(compareQuestion), 'Discovery must retain the requested comparison');
  assert.deepEqual(calls.filter(call => call.path.startsWith('/api/web-')).map(call => [call.path, call.body.url || call.body.query]), [
    ['/api/web-read', sourceUrl], ['/api/web-search', 'Orchid Lily retry'], ['/api/web-read', comparisonUrl],
  ], 'Read the supplied repository first, then only the selected comparison evidence');
  console.log('PASS: comparison reads explicit evidence first, keeps selected external evidence and skips unrelated homonyms');
  comparison = false;
  const controller = new AbortController(); let release;
  blockedRead = new Promise(resolve => {release = resolve;});
  const entered = new Promise(resolve => {readEntered = resolve;});
  const pending = pipeline.runDeepResearch(question, {model: 'simulated'}, undefined, {controller});
  const rejected = assert.rejects(pending, {name: 'AbortError'});
  await entered; controller.abort(); await rejected;
  const completedCalls = calls.length; release(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, completedCalls, 'A stopped read cannot advance to extraction or writing');
  console.log('PASS: research Stop rejects a blocked HTTP read and cannot start a late writer');
} finally {
  clearTimeout(bound); server.closeAllConnections(); server.close(); await once(server, 'close');
}

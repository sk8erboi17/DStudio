import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {verifyQwen38ToolTrace, verifyQwen38Workspace, qwenVisibleAnswer, qwenPartialResetProgress} from '../support/qwen38_tool_oracle.mjs';
const code = 'cedro-b3169d52db6b';
const status = '\x1e' + JSON.stringify({type: 'status', state: 'generating', generated: 4}) + '\n';
for (let split = 0; split <= code.length; split++) {
  const raw = '\x01USER\x02Which code?\x01ENDUSER\x02\n' +
    code.slice(0, split) + status + code.slice(split) + '\n';
  assert.equal(qwenVisibleAnswer(raw).trim(), code);
}
assert.equal(qwenVisibleAnswer('\x01USER\x02' + code + '\x01ENDUSER\x02\nwrong').trim(), 'wrong');
assert.equal(qwenVisibleAnswer('ordinary JSON: {"x":1}'), 'ordinary JSON: {"x":1}');
const terminal = '[[DSTUDIO_CORRECTNESS_COMPLETE]]';
for (let split = 0; split <= terminal.length; split++) {
  const raw = code + '\n\n' + terminal.slice(0, split) + status + terminal.slice(split) + '\n\n';
  assert.equal(qwenVisibleAnswer(raw).trim(), code);
}
assert.equal(qwenVisibleAnswer('wrong\n\n' + terminal).trim(), 'wrong');
assert.equal(qwenVisibleAnswer(terminal).trim(), '');
assert.notEqual(qwenVisibleAnswer(code + '\nextra prose\n' + terminal).trim(), code);
assert.notEqual(qwenVisibleAnswer(code + '\n' + terminal + '\n' + terminal).trim(), code);
assert.equal(qwenVisibleAnswer('literal ' + terminal + ' inside text'), 'literal ' + terminal + ' inside text');
const saved = 'saved session c55dc4c2 (4507 tokens)';
assert.equal(qwenVisibleAnswer(code + '\n\n' + saved).trim(), code);
assert.equal(qwenVisibleAnswer(code + '\n\n' + terminal + '\n\n' + saved).trim(), code);
assert.equal(qwenVisibleAnswer('wrong\n\n' + saved).trim(), 'wrong');
assert.notEqual(qwenVisibleAnswer(code + '\nextra prose\n' + saved).trim(), code);
assert.notEqual(qwenVisibleAnswer(code + '\nsaved session malformed').trim(), code);
assert.notEqual(qwenVisibleAnswer(code + '\n' + saved + '\n' + saved).trim(), code);
// Execute the actual UI's presentation path as an independent check that a
// native autosave receipt is a system item, not part of the model answer.
// Source extraction is harness loading; assertions are on returned segments.
const uiSource = fs.readFileSync(new URL('../../web/index.html', import.meta.url), 'utf8');
function loadUiFunction(name) {
  // These declarations share a stable outer indentation. Do not count raw
  // braces: the actual functions contain regex character classes with `{`.
  const start = new RegExp('^([ \\t]*)function ' + name + '\\(', 'm').exec(uiSource);
  if (!start) throw new Error('Cannot load UI function: ' + name);
  const rest = uiSource.slice(start.index);
  const end = new RegExp('^' + start[1] + '}', 'm').exec(rest);
  if (!end) throw new Error('Cannot load complete UI function: ' + name);
  return rest.slice(0, end.index + end[0].length);
}
const declarations = ['U_OPEN', 'U_CLOSE', 'CTRL_RE', 'SYS_LINE_RE'].map(name =>
  uiSource.match(new RegExp('^\\s*const ' + name + ' = .*;\\s*$', 'm'))[0]).join('\n');
const ui = new Function(declarations + '\n' + ['splitUserTurns', 'stripTruncatedEnginePrefix',
  'extractCompact', 'cleanRuntimeMarkup', 'pendingStructuredPhase', 'segmentAgent']
  .map(loadUiFunction).join('\n') + '\nreturn {splitUserTurns, segmentAgent};')();
for (const expected of [code, 'wrong']) {
  const raw = '\x01USER\x02Which code?\x01ENDUSER\x02\n' +
    expected.slice(0, 3) + status + expected.slice(3) + '\n\n' + terminal + '\n\n' + saved;
  const segments = ui.splitUserTurns(raw).filter(p => p.role === 'agent').flatMap(p => ui.segmentAgent(p.text));
  assert(segments.some(s => s.kind === 'sys' && s.text === saved));
  const visible = segments.filter(s => s.kind === 'text').map(s => s.text).join('\n\n').trim();
  assert.equal(visible, expected);
  assert.equal(qwenVisibleAnswer(raw).trim(), visible);
}
for (const bad of ['\x1e{', '\x1e{}\n', '\x1einvalid\n', '\x01USER\x02incomplete'])
  assert.throws(() => qwenVisibleAnswer(bad));
console.log('Qwen answer oracle: PASS — interleaved frames and terminal receipt decoded, wrong answers/extra prose retained, echoes excluded, malformed frames rejected');
const progress = (done, total) => ({type: 'status', state: 'prefill', prefillDone: done, prefillTotal: total});
for (const e of [progress(0, 4358), progress(4358, 4358), progress(9000, 8192),
  progress(-1, 10), progress(1, NaN), {...progress(1, 2), state: 'generating'}])
  assert.equal(qwenPartialResetProgress([e]), undefined);
for (const e of [progress(1, 4126), progress(8192, 10091)])
  assert.equal(qwenPartialResetProgress([progress(0, 1), e, progress(1, 1)]), e);
console.log('Qwen reset progress oracle: PASS — partial native work required; final-only progress cannot qualify cancellation');
const events = calls=>calls.flatMap(([name,path])=>[
  {type:'tool_call',name,input:{path}}, {type:'tool_result',name,output:'unit fixture'}]);
const good = [['read_document','tasks.json'],['list','.'],['read','tasks.json'],
  ['write_document','dispatch.md'],['read_document','dispatch.md'],['read','tasks.json']];
assert.equal(verifyQwen38ToolTrace('cowork',events(good),'dispatch.md').toolCalls,6);
assert.equal(verifyQwen38ToolTrace('agent',events([['read','tasks.json'],['write','ready.json'],['read','ready.json']]),'ready.json').toolCalls,3);
const agentListing = [['list','.'],['read','tasks.json'],['write','ready.json'],['read','ready.json']];
assert.equal(verifyQwen38ToolTrace('agent',events(agentListing),'ready.json').toolCalls,4);
for (const extra of [['list','..'], ['list','/'], ['read','unrelated.txt'],
  ['write','tasks.json'], ['bash','.'], ['visit_page','.']])
  assert.throws(() => verifyQwen38ToolTrace('agent',events([...agentListing,extra]),'ready.json'));
assert.throws(() => verifyQwen38ToolTrace('agent',events(agentListing).slice(0,-2),'ready.json'));
for (const bad of [
  good.filter(([name])=>name!=='read_document'),
  good.filter(([name])=>name!=='write_document'),
  good.filter(([,path])=>path!=='dispatch.md'),
  good.map(([name,path])=>[name,path==='dispatch.md'?'../dispatch.md':path]),
  [...good,['bash','dispatch.md']], [...good,['visit_page','dispatch.md']],
  [...good,['list','..']], [...good,['read','unrelated.txt']],
  [...good,['write_document','tasks.json']],
  good.filter(([name,path])=>!(name==='read_document'&&path==='dispatch.md')),
]) assert.throws(()=>verifyQwen38ToolTrace('cowork',events(bad),'dispatch.md'));
assert.throws(()=>verifyQwen38ToolTrace('cowork',events(good).slice(0,-1),'dispatch.md'));
console.log('Qwen tool oracle: PASS — required document tools/readback, permitted local inspection, rejected escapes/shell/network');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dstudio-qwen-oracle-'));
let index = 0;
function fixture(withGraph = true) {
  const workspace = path.join(temp, String(++index)); fs.mkdirSync(workspace);
  for (const file of ['tasks.json', 'result.txt']) fs.writeFileSync(path.join(workspace, file), 'unit fixture');
  const id = 'tg_100_20_1', dir = path.join(workspace, '.dstudio/task-graphs', id);
  if (withGraph) {
    fs.mkdirSync(dir, {recursive: true});
    fs.writeFileSync(path.join(dir, 'graph.json'), JSON.stringify({graphId: id, workspace}));
    fs.writeFileSync(path.join(dir, 'events.jsonl'), JSON.stringify({seq: 1, graphId: id, type: 'graph.succeeded'}) + '\n');
  }
  return {workspace, dir, id, check: () => verifyQwen38Workspace(workspace, ['tasks.json', 'result.txt'], withGraph ? [id] : [])};
}
try {
  assert.equal(fixture().check().graphIds.length, 1);
  assert.equal(fixture(false).check().receiptFiles, 0);
  for (const change of [
    f => fs.writeFileSync(path.join(f.workspace, 'unexpected.txt'), 'wrong'),
    f => fs.writeFileSync(path.join(f.workspace, '.dstudio/unrelated'), 'wrong'),
    f => fs.mkdirSync(path.join(f.dir, '../tg_200_30_2')),
    f => fs.symlinkSync(temp, path.join(f.dir, 'escape')),
    f => fs.writeFileSync(path.join(f.dir, 'graph.json'), JSON.stringify({graphId: 'wrong', workspace: f.workspace})),
    f => fs.writeFileSync(path.join(f.dir, 'graph.json'), JSON.stringify({graphId: f.id, workspace: temp})),
    f => fs.unlinkSync(path.join(f.dir, 'events.jsonl')),
    f => fs.writeFileSync(path.join(f.dir, 'events.jsonl'), JSON.stringify({seq: 2, graphId: f.id, type: 'graph.succeeded'})),
    f => fs.writeFileSync(path.join(f.dir, 'events.jsonl'), JSON.stringify({seq: 1, graphId: f.id, type: 'graph.started'})),
    f => { const file = path.join(f.dir, 'oversized'); fs.writeFileSync(file, ''); fs.truncateSync(file, 4 * 1024 * 1024 + 1); },
  ]) { const f = fixture(); change(f); assert.throws(f.check); }
  console.log('Qwen workspace oracle: PASS — actual graph identities/journal accepted; ten unrelated, incomplete or unbounded cases rejected');
} finally { fs.rmSync(temp, {recursive: true, force: true}); }

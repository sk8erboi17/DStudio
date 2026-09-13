import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// Status frames can occur between any two model tokens, not only between
// lines. Grade the visible answer, never a contiguous substring of raw JSONL
// transport or the echoed user prompt. Malformed/incomplete frames fail.
export function qwenVisibleAnswer(text) {
  const withoutFrames = String(text).replace(/\x1e([^\n]*)\n/g, (_frame, json) => {
    const event = JSON.parse(json);
    assert(event && typeof event.type === 'string', 'Invalid native event');
    return '';
  });
  assert(!withoutFrames.includes('\x1e'), 'Incomplete native event');
  const answer = withoutFrames.replace(/\x01USER\x02[\s\S]*?\x01ENDUSER\x02\n?/g, '');
  assert(!answer.includes('\x01'), 'Incomplete user echo');
  // The native Qwen3.8 autosave appends a system line, classified separately
  // by segmentAgent. Remove only its exact terminal protocol shape; malformed
  // lines or extra model prose remain visible and fail an exact-answer check.
  const prose = answer.replace(/(?:^|\r?\n)saved session [0-9a-f]{8} \(\d+ tokens\)[ \t\r\n]*$/, '');
  // The production Task Graph asks for this reserved final-line receipt and
  // cleanRuntimeMarkup hides it from the answer. Exclude only that terminal
  // protocol line here: extra prose, a wrong code or a repeated marker still
  // fails the caller's exact-answer assertion. Never use it as proof of recall.
  return prose.replace(/(?:^|\r?\n)[ \t]*\[\[DSTUDIO_CORRECTNESS_COMPLETE\]\][ \t\r\n]*$/, '');
}

// A final-only callback is not evidence that cancellation can be requested
// between native prefill chunks. Require genuinely unfinished work.
export function qwenPartialResetProgress(events) {
  return events.find(e => e.type === 'status' && e.state === 'prefill' &&
    Number.isInteger(e.prefillDone) && Number.isInteger(e.prefillTotal) &&
    e.prefillDone > 0 && e.prefillDone < e.prefillTotal);
}

// A workflow may inspect its own inputs more than once. That is an efficiency
// observation, not a violation of "no shell or network". The required document
// tools, target identities and read-after-write remain mandatory.
export function verifyQwen38ToolTrace(mode, events, output) {
  assert(['agent','cowork'].includes(mode));
  const calls = events.filter(e=>e.type==='tool_call');
  const results = events.filter(e=>e.type==='tool_result');
  assert(calls.length > 0 && calls.length <= 12, 'Tool budget');
  assert.deepEqual(results.map(e=>e.name), calls.map(e=>e.name), 'Every call needs its own ordered result');
  const reader = mode==='agent'?'read':'read_document';
  const writer = mode==='agent'?'write':'write_document';
  // Listing this exact workspace is local read-only inspection in both modes;
  // the prompt prohibits shell/network, not that native file operation.
  const allowed = mode==='agent'?['read','write','edit','list']:['read_document','write_document','list','read'];
  for (const call of calls) {
    assert(allowed.includes(call.name), 'Shell/network or another undeclared operation');
    const target = call.input?.path;
    if (call.name==='list') assert.equal(target,'.','Only the selected workspace may be listed');
    else if (['write','edit','write_document'].includes(call.name)) assert.equal(target,output,'Wrong mutation target');
    else assert(['tasks.json',output].includes(target),'Unrelated read target');
  }
  const written = calls.findIndex(e=>e.name===writer);
  assert(written>=0,'Missing required writer');
  assert(calls.slice(0,written).some(e=>e.name===reader && e.input.path==='tasks.json'),'Missing source read');
  assert(calls.slice(written+1).some(e=>e.name===reader && e.input.path===output),'Missing required document/file readback');
  return {toolCalls:calls.length,additionalReads:calls.filter(e=>e.name==='read'||e.name==='list').length};
}

// The HTTP host may wrap work in its real Task Graph. Its journal is not an
// unexpected model output. Accept only graph identities returned for these
// requests, with a complete durable journal, never arbitrary hidden files.
export function verifyQwen38Workspace(workspace, files, graphIds = []) {
  const ids = [...new Set(graphIds)];
  assert(ids.every(id => /^tg_[0-9]+_[0-9]+_[0-9]+$/.test(id)), 'Invalid graph identity');
  assert.deepEqual(fs.readdirSync(workspace).sort(), [...files, ...(ids.length ? ['.dstudio'] : [])].sort(),
    'Unexpected workspace files');
  for (const file of files) {
    const s = fs.lstatSync(path.join(workspace, file));
    assert(s.isFile() && !s.isSymbolicLink() && s.size < 65536, 'Unexpected document type/size');
  }
  if (!ids.length) return {graphIds: [], receiptFiles: 0, receiptBytes: 0};
  const own = path.join(workspace, '.dstudio'), graphs = path.join(own, 'task-graphs');
  for (const dir of [own, graphs]) assert(fs.lstatSync(dir).isDirectory(), 'Receipt directory must not be a symlink');
  assert.deepEqual(fs.readdirSync(own), ['task-graphs'], 'Unrelated hidden data');
  assert.deepEqual(fs.readdirSync(graphs).sort(), ids.sort(), 'Unrelated graph');
  let count = 0, bytes = 0;
  function walk(dir, depth) {
    assert(depth <= 8, 'Receipt depth');
    for (const leaf of fs.readdirSync(dir)) {
      const file = path.join(dir, leaf), s = fs.lstatSync(file);
      assert(++count <= 128, 'Receipt entry count');
      if (s.isDirectory()) walk(file, depth + 1);
      else {
        assert(s.isFile() && !s.isSymbolicLink() && s.size <= 4 * 1024 * 1024, 'Receipt type/size');
        bytes += s.size; assert(bytes <= 16 * 1024 * 1024, 'Receipt byte budget');
      }
    }
  }
  for (const id of ids) {
    const dir = path.join(graphs, id);
    assert(fs.lstatSync(dir).isDirectory(), 'Graph directory must not be a symlink');
    walk(dir, 0);
    const graph = JSON.parse(fs.readFileSync(path.join(dir, 'graph.json'), 'utf8'));
    assert.equal(graph.graphId, id);
    assert.equal(fs.realpathSync(graph.workspace), fs.realpathSync(workspace));
    const events = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert(events.length > 0 && events.every((e, i) => e.graphId === id && e.seq === i + 1), 'Broken graph journal');
    assert.equal(events.at(-1).type, 'graph.succeeded', 'Incomplete graph journal');
  }
  return {graphIds: ids, receiptFiles: count, receiptBytes: bytes};
}

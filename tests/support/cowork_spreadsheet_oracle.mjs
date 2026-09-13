// Independent workflow evidence, not model self-assessment or source matching.
// The saved workbook still needs a separate OOXML/value oracle in the caller.
import assert from 'node:assert/strict';

function completedOfficeCalls(events) {
  assert(Array.isArray(events) && events.length <= 256, 'Unbounded Office workflow');
  const calls = new Map(), pairs = [];
  for (const [index, event] of events.entries()) {
    if (event.type === 'tool_call' && ['excel', 'spreadsheet'].includes(event.name)) {
      assert.equal(typeof event.call_id, 'string');
      assert(event.call_id && !calls.has(event.call_id), 'Duplicate Office call id');
      calls.set(event.call_id, {call: event, callIndex: index});
    } else if (event.type === 'tool_result' && calls.has(event.call_id)) {
      const pair = calls.get(event.call_id);
      assert(!pair.result && pair.call.name === event.name, 'Mismatched Office result');
      pair.result = event; pair.resultIndex = index;
      if (event.outcome === 'returned' && typeof event.output === 'string') pairs.push(pair);
    }
  }
  return pairs;
}

function returnedAllCells(pair, expectedRows) {
  const output = pair.result.output;
  if (Buffer.byteLength(output) > 1_000_000) return false;
  const lines = output.split('\n'), scopes = lines.filter(line => line.startsWith('Read scope: '));
  if (scopes.length !== 1) return false;
  let scope;
  try {scope = JSON.parse(scopes[0].slice('Read scope: '.length));} catch {return false;}
  if (!scope || scope.complete !== true || scope.textTruncated !== false || scope.otherSheets !== 0 ||
      !Array.isArray(scope.omitted) || scope.omitted.length) return false;
  const rows = lines.slice(lines.indexOf(scopes[0]) + 1);
  while (rows.at(-1) === '') rows.pop();
  return JSON.stringify(rows.map(row => row.split('\t'))) ===
    JSON.stringify(expectedRows.map(row => row.map(String)));
}

export function assertSpreadsheetWorkflow(events, {sourcePath, sourceRows, outputPath, outputRows}) {
  const pairs = completedOfficeCalls(events);
  const action = pair => String(pair.call.input?.action ?? 'inspect').trim().toLowerCase();
  // CSV/TSV inspect returns cells through the real Office read path. XLSX
  // inspect returns only sheet metadata and is never a replacement for read.
  const sourceActions = /\.(csv|tsv)$/i.test(sourcePath) ? ['read', 'inspect'] : ['read'];
  const reads = pairs.filter(pair => pair.call.input?.path === sourcePath &&
    sourceActions.includes(action(pair)) && returnedAllCells(pair, sourceRows));
  const writes = pairs.filter(pair => pair.call.input?.path === outputPath && action(pair) === 'create');
  const readbacks = pairs.filter(pair => pair.call.input?.path === outputPath && action(pair) === 'read' &&
    returnedAllCells(pair, outputRows));
  for (const source of reads) for (const write of writes) for (const readback of readbacks) {
    if (source.resultIndex < write.callIndex && write.resultIndex < readback.callIndex) {
      return {sourceAction: action(source), sourceCall: source.call.call_id,
        createCall: write.call.call_id, readbackCall: readback.call.call_id,
        sourceCells: sourceRows.reduce((n, row) => n + row.length, 0),
        readbackCells: outputRows.reduce((n, row) => n + row.length, 0)};
    }
  }
  assert.fail('Missing complete source cells before creation or complete saved-cell readback after creation');
}

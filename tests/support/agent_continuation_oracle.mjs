import assert from 'node:assert/strict';

// Read actual native trace records, not application source. Prefill token dumps
// are inputs; only tokens between a completed prefill and generation completion
// are output. Private summary generation does not emit token records. Keeping
// the output active through compaction is essential for the same-loop backport.
export function continuationTrace(text) {
  let active = false;
  const bytes = [], rounds = [], compactions = [];
  for (const raw of text.split('\n')) {
    const line = raw.replace(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3} /, '');
    if (/^prefill sync done tool_round=/.test(line)) active = true;
    if (/^tokens label=/.test(line)) active = false;
    const done = /^generation finished tool_round=(\d+) generated=(\d+) carried=(\d+)/.exec(line);
    if (done) {
      rounds.push({round: +done[1], generated: +done[2], carried: +done[3]});
      active = false;
    }
    const compact = /^compacted reason="([^"]+)" old=(\d+) new=(\d+) tail_start=(\d+) tail=(\d+)/.exec(line);
    if (compact) compactions.push({reason: compact[1], before: +compact[2], after: +compact[3], tail: +compact[5]});
    const token = /^token index=\d+ id=\d+ bytes=(\d+) text=".*" hex=([0-9a-f]*)$/.exec(line);
    if (active && token) {
      const data = Buffer.from(token[2], 'hex');
      assert.equal(data.length, +token[1], 'Truncated native output token');
      bytes.push(data);
    }
  }
  return {response: Buffer.concat(bytes).toString('utf8'), tokens: bytes.length, rounds, compactions};
}

export function continuationCode(response, count) {
  assert(Number.isInteger(count) && count > 0 && count <= 512);
  let code = response.trim();
  // Markdown fences are presentation, not a repair to generated code. Do not
  // delete explanations, complete a missing brace or manufacture a function.
  if (/^```(?:c|C)?\r?\n/.test(code) && /\r?\n```$/.test(code))
    code = code.replace(/^```(?:c|C)?\r?\n/, '').replace(/\r?\n```$/, '');
  const lines = code.trim().split(/\r?\n/);
  assert.equal(lines.length, count, 'Exactly the requested one-function-per-line output is required');
  lines.forEach((line, i) => {
    const declaration = /^\s*int\s+value_(\d+)\s*\(\s*void\s*\)\s*\{\s*return\s+(\d+)\s*;\s*\}\s*$/.exec(line);
    assert(declaration, `Incomplete or unexpected C syntax on line ${i + 1}`);
    assert.equal(+declaration[1], i, `Missing, duplicate or reordered function on line ${i + 1}`);
    assert.equal(+declaration[2], i * i, `Incorrect return literal on line ${i + 1}`);
  });
  const oracle = Array.from({length: count}, (_, i) => `extern int value_${i}(void);`).join('\n') +
    '\nint main(void) {\n' + Array.from({length: count}, (_, i) =>
      `    if (value_${i}() != ${i * i}) return 1;`).join('\n') + '\n    return 0;\n}\n';
  return {code: code + '\n', oracle};
}

// The image prompt asks for lowercase color names separated by a comma; it
// does not prohibit whitespace around that delimiter. Order and content still
// match exactly. Text recovery is a separate, strict integer-answer check.
export function gradeQ36VisionAnswer(row, expected) {
  let answer = '';
  const valid = row && typeof row.textHex === 'string' &&
    row.textHex.length <= 8192 && /^(?:[0-9a-f]{2})*$/i.test(row.textHex);
  try {
    if (valid) answer = new TextDecoder('utf-8', {fatal: true}).decode(Buffer.from(row.textHex, 'hex'));
  } catch {return {answer, expected, status: 'fail'};}
  let matches = false;
  if (valid && typeof expected === 'string') {
    if (row.kind === 'textRecovery') matches = answer.trim() === expected;
    if (row.kind === 'imageAnswer') {
      const wanted = expected.split(',');
      const actual = answer.trim().split(',').map(part => part.trim());
      matches = wanted.every(color => /^[a-z]+$/.test(color)) &&
        actual.length === wanted.length && actual.every((color, index) => color === wanted[index]);
    }
  }
  return {answer, expected, status: valid && row.eos === true && row.finite === true && matches ? 'pass' : 'fail'};
}

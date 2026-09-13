// Native notice frames pass through the real UI segmenter. This is rendering
// logic, not browser acceptance or model quality. Optional input joins a native
// owner-probe receipt to this consumer without reconstructing its wire bytes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync('web/index.html', 'utf8');
function loadFunction(name) {
  // Load the complete declaration at its outer indentation; regex literals
  // contain braces, so counting raw braces is not JavaScript parsing.
  const start = new RegExp('^([ \\t]*)function ' + name + '\\(', 'm').exec(source);
  assert(start, 'Missing UI function ' + name);
  const rest = source.slice(start.index);
  const end = new RegExp('^' + start[1] + '}', 'm').exec(rest);
  assert(end, 'Missing UI function end ' + name);
  return rest.slice(0, end.index + end[0].length);
}
const context = vm.createContext({});
const constants = ['CTRL_RE', 'SYS_LINE_RE', 'U_OPEN', 'U_CLOSE', 'SLASH_CMD_RE', 'isSlashCommand']
  .map(name => source.match(new RegExp(`const ${name} = [^\\n]+`))[0]);
const visibilityStart = source.indexOf('const strippedVisibleText =');
const visibilityEnd = source.indexOf('\n\n', visibilityStart);
constants.push(source.slice(visibilityStart, visibilityEnd));
vm.runInContext(constants.join('\n') + '\n' + ['stripTruncatedEnginePrefix', 'extractCompact',
  'cleanRuntimeMarkup', 'parseGsaPhaseJsonText', 'pendingStructuredPhase', 'segmentAgent',
  'splitUserTurns', 'hasRenderableConversation', 'hasDesignConversationContent']
  .map(loadFunction).join('\n'), context);
const parse = input => {
  context.input = input;
  return JSON.parse(JSON.stringify(vm.runInContext('segmentAgent(input)', context)));
};
let notices = [{type: 'runtime_notice', text: 'Stopped by user'},
  {type: 'runtime_notice', text: 'Quote " and newline\nCafé 日本語'}];
if (process.argv[2]) {
  const receipt = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  assert(receipt.passed && receipt.inputsUnchanged);
  notices = receipt.notices;
}
let checks = 0;
for (const notice of notices) {
  const frame = '\x1e' + JSON.stringify(notice) + '\n';
  const expected = [{kind: 'text', text: 'Answer before'}, {kind: 'runtime_notice', text: notice.text},
    {kind: 'text', text: 'Answer after'}];
  for (let split = 0; split <= frame.length; split++) {
    const partial = parse('Answer before' + frame.slice(0, split));
    assert(!partial.filter(s => s.kind === 'text').some(s => /runtime_notice/.test(s.text)));
    assert.deepEqual(parse('Answer before' + frame.slice(0, split) + frame.slice(split) + 'Answer after'), expected);
    checks++;
  }
}
assert.deepEqual(parse('\x1e{"type":"runtime_notice","text":42}\nAnswer'), [{kind: 'text', text: 'Answer'}]);
assert.deepEqual(parse('Stopped by user'), [{kind: 'text', text: 'Stopped by user'}],
  'Model prose must not become an authoritative service notice');
checks += 2;
for (const fn of ['hasRenderableConversation', 'hasDesignConversationContent']) {
  for (const notice of notices) {
    context.input = '\x1e' + JSON.stringify(notice) + '\n';
    assert.equal(vm.runInContext(`${fn}(input)`, context), true,
      `${fn} hides a native notice received before any answer or user turn`);
    checks++;
  }
  for (const event of [{type: 'sessions', sessions: []}, {type: 'status', state: 'idle'},
    {type: 'runtime_notice', text: '  '}, {type: 'runtime_notice', text: 42}]) {
    context.input = '\x1e' + JSON.stringify(event) + '\n';
    assert.equal(vm.runInContext(`${fn}(input)`, context), false,
      `${fn} presents bookkeeping or an invalid notice as conversation content`);
    checks++;
  }
}
console.log(`Runtime notice consumer: ${checks} fragmented/event/empty-conversation checks PASS; no inference`);

// Execute the production Learn phase controls with simulated model frames.
// These are recovery/protocol tests, not inference or curriculum qualification.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {loadRoadmapFunctions} from '../support/roadmap_functions.mjs';
const api = loadRoadmapFunctions();
const cycle = Array.from({length: 45}, (_, i) => `Assumption ${i}: learner context and measurable practice ${i * 17}.`).join('\n');
const guard = api.createRoadmapRepetitionGuard();
let detected;
for (let i = 0, text = cycle.repeat(8); i < text.length && !detected; i += 137) detected = guard.push(text.slice(i, i + 137));
assert.ok(detected?.repeats >= 4);
assert.equal(detected.periodChars, cycle.length);
const varied = api.createRoadmapRepetitionGuard();
for (let i = 0; i < 700; i++) assert.equal(varied.push(`Step ${i}: a distinct example ${i * i}, its assumptions, dependencies, and evidence.\n`), null);
assert.equal(api.createRoadmapRepetitionGuard().push('A repeated short quotation. '.repeat(10)), null);
assert.ok(api.createRoadmapRepetitionGuard().push('yes '.repeat(3000)), 'Short-cycle degeneration is also detected once the repeated suffix is substantial');

// Long paragraphs with changing labels previously evaded both the paragraph
// window and exact periodic suffix. The repeated sentence, not elapsed time,
// must trigger recovery independently of SSE chunk boundaries.
const labelledCycle = Array.from({length: 40}, (_, i) => `Pass ${i}. ` +
  'The same unresolved assumption is reconsidered without delivering a verdict. '.repeat(35) +
  `End pass ${i}.\n\n`).join('');
for (const chunk of [37, 512, 4096, labelledCycle.length]) {
  const detector = api.createRoadmapRepetitionGuard(); let hit;
  for (let at = 0; at < labelledCycle.length && !hit; at += chunk)
    hit = detector.push(labelledCycle.slice(at, at + chunk));
  assert.ok(hit, `Changing labels cannot hide long-paragraph degeneration (chunk ${chunk})`);
}
const longDistinct = api.createRoadmapRepetitionGuard();
for (let i = 0; i < 180; i++) {
  const paragraph = Array.from({length: 35}, (_, j) =>
    `For specimen ${i}, observation ${j} has independently measured value ${i * 79 + j * 13} and uncertainty ${i + j + 1}.`).join(' ');
  assert.equal(longDistinct.push(paragraph + '\n\n'), null, 'Long productive paragraphs are not cycles');
}

const paragraphs = Array.from({length: 12}, (_, i) => `Reconsider source item ${i}: its definitions and exercise have already been checked against the supplied passage; no additional defect or missing prerequisite has been identified.`);
const reordered = Array.from({length: 12}, (_, round) => [
  ...paragraphs.slice(round % 12), ...paragraphs.slice(0, round % 12),
  `Round ${round}: a small new note interleaved with otherwise repeated conclusions.`,
].join('\n\n')).join('\n\n');
const unorderedGuard = api.createRoadmapRepetitionGuard();
let unorderedHit;
for (let i = 0; i < reordered.length && !unorderedHit; i += 137) unorderedHit = unorderedGuard.push(reordered.slice(i, i + 137));
assert.equal(unorderedHit?.kind, 'revisited-paragraphs');
assert.ok(unorderedHit.recurring >= 5);
const legitimate = api.createRoadmapRepetitionGuard();
for (let i = 0; i < 200; i++) {
  const text = `Example ${i}: premise ${i * 23}, alternative ${i * 17}, result ${i * i}. This derivation contributes a distinct observation and independently tested result.\n\n`;
  assert.equal(legitimate.push(text + (i % 10 === 0 ? paragraphs[0] + '\n\n' : '')), null);
}
if (process.env.DSTUDIO_TEST_REASONING_REPLAY) {
  const input = fs.readFileSync(process.env.DSTUDIO_TEST_REASONING_REPLAY, 'utf8');
  for (const chunkSize of [32, 128, 512, 2048]) {
    const guard = api.createRoadmapRepetitionGuard(); let hit;
    for (let offset = 0; offset < input.length && !hit; offset += chunkSize) {
      const result = guard.push(input.slice(offset, offset + chunkSize)); if (result) hit = {offset, ...result};
    }
    assert.equal(hit?.kind, 'revisited-paragraphs', 'The retained private failure must trigger recovery');
    console.log('Private reasoning replay (no transcript published):', JSON.stringify({chunkSize, ...hit}));
  }
}

const request = {messages: [{role: 'user', content: 'Trusted source evidence and a precise phase contract.'}], thinkLevel: 'max'};
const controller = new AbortController();
let calls = 0, active = 0, maxActive = 0;
const retries = [], saved = [], bodies = [];
const recovered = await api.completeRoadmapPhase({
  request, signal: controller.signal, label: 'Fixture audit', normalize: JSON.parse,
  async *stream(req, signal) {
    bodies.push(req); calls++; active++; maxActive = Math.max(maxActive, active);
    try {
      if (calls === 1) {
        for (let i = 0; i < 10 && !signal.aborted; i++) yield {type: 'reasoning', text: cycle};
        assert.fail('A confirmed cycle must close the first generator before recovery');
      } else {
        yield {type: 'reasoning', text: 'One distinct final check.'};
        yield {type: 'content', text: '{"pass":true}'};
        yield {type: 'finish', reason: 'stop'};
      }
    } finally { active--; }
  },
  onProgress: value => saved.push(value), onRetry: (...args) => retries.push(args),
});
assert.deepEqual(recovered, {pass: true});
assert.equal(calls, 2); assert.equal(maxActive, 1); assert.equal(active, 0);
assert.ok(retries[0][2].repetition); assert.ok(saved.some(x => x.reasoningChars && !x.content));
assert.equal(bodies[1].maxTokens, 0, 'Do not impose an output-token cutoff');
assert.ok(bodies[1].messages.at(-1).content.length < 25000, 'Recovery must not replay the repeated transcript');
assert.deepEqual(bodies[1].messages[0], request.messages[0]);

let invalidCalls = 0;
await assert.rejects(api.completeRoadmapPhase({request, signal: controller.signal, label: 'Invalid audit', normalize: JSON.parse,
  async *stream() { invalidCalls++; yield {type: 'content', text: '{invalid'}; yield {type: 'finish', reason: 'stop'}; },
}), error => error.name === 'RoadmapIncompleteError');
assert.equal(invalidCalls, 3, 'Invalid JSON cannot cause an infinite retry loop');
let transportCalls = 0;
await assert.rejects(api.completeRoadmapPhase({request, signal: controller.signal, label: 'Network', normalize: JSON.parse,
  async *stream() { transportCalls++; yield {type: 'error', message: 'Disconnected', errType: 'network'}; },
}), /Disconnected/);
assert.equal(transportCalls, 1);
for (const finish of [null, 'length']) {
  let count = 0;
  await assert.rejects(api.completeRoadmapPhase({request, signal: controller.signal, label: 'Unfinished', normalize: JSON.parse,
    async *stream() { count++; yield {type: 'content', text: '{}'}; if (finish) yield {type: 'finish', reason: finish}; },
  }), error => error.name === 'RoadmapIncompleteError');
  assert.equal(count, 3, 'Complete-looking JSON is not a completed transport response');
}
const cancel = new AbortController(); let cancelSnapshot;
await assert.rejects(api.completeRoadmapPhase({request, signal: cancel.signal, label: 'Cancelled', normalize: JSON.parse,
  async *stream() { yield {type: 'reasoning', text: 'Useful partial work'}; yield {type: 'content', text: '{}'}; },
  onProgress(value) { cancelSnapshot = value; cancel.abort(); },
}), error => error.name === 'AbortError');
assert.equal(cancelSnapshot.reasoning, 'Useful partial work');
let current = true, staleCommits = 0;
await assert.rejects(api.completeRoadmapPhase({request, signal: controller.signal, label: 'Stale', normalize() { staleCommits++; }, isCurrent: () => current,
  async *stream() { yield {type: 'reasoning', text: 'Before selection changed'}; current = false; yield {type: 'content', text: '{}'}; },
}), error => error.name === 'AbortError');
assert.equal(staleCommits, 0);
let oversizedCalls = 0;
await assert.rejects(api.completeRoadmapPhase({request, signal: controller.signal, label: 'Oversized', normalize: JSON.parse,
  async *stream() { oversizedCalls++; yield {type: 'content', text: 'x'.repeat(1048577)}; },
}), error => error.name === 'RoadmapIncompleteError');
assert.equal(oversizedCalls, 1, 'The output resource bound must stop only this phase, not spawn repeated oversized work');
let bounded;
await api.completeRoadmapPhase({request, signal: controller.signal, label: 'Long but productive', normalize: JSON.parse,
  async *stream() {
    // More than 64K of distinct reasoning must remain valid with bounded persistence.
    for (let i = 0; i < 1500; i++) yield {type: 'reasoning', text: `Distinct derivation ${i}: independent premise ${i * 31}, result ${i * i} and verification.\n`};
    yield {type: 'content', text: '<think>Last check</think>{"ok":true}'};
    yield {type: 'finish', reason: 'stop'};
  }, onProgress: value => { bounded = value; },
});
assert.ok(bounded.reasoning.length < 66000); assert.ok(bounded.reasoningOmittedChars > 0);
assert.match(bounded.reasoning, /middle omitted/); assert.match(bounded.reasoning, /Last check/);

const sources = new Set(['https://example.org/a', 'https://example.org/b', 'https://example.org/c']);
const topic = (id, prior) => ({id, title: id, prerequisites: prior ? [prior] : [], optional: false,
  summary: `Understand ${id} and connect it to earlier prerequisites through explicit observable examples.`, estimatedHours: 3,
  keyConcepts: ['Reasoning from evidence'], outcome: 'Demonstrate the result through an independently checked artifact.',
  practice: 'Build an observable example, test its behavior, and explain one intentional failure and its correction.',
  assessment: 'Pass an independent behavioral check and explain each result.',
  resources: [{title: 'Evidence', url: 'https://example.org/a'}]});
const roadmap = {version: 2, title: 'Fixture curriculum', goal: 'Learn a precise skill', audience: 'Beginner', estimatedDuration: '3 weeks', assumptions: ['Basic computer familiarity'],
  stages: [0, 1, 2].map(i => ({id: `stage-${i}`, title: `Stage ${i}`, objectives: ['Demonstrate mastery'],
    checkpoint: 'Produce and independently verify a complete working artifact.', topics: [topic(`topic-${i}`, i ? `topic-${i - 1}` : null)]})),
  capstone: {title: 'Integrated artifact', description: 'Combine and verify the acquired skills.', deliverables: ['Working artifact', 'Evidence report'], successCriteria: ['Correctness', 'Reproducibility', 'Explanation']}};
const outline = api.normalizeRoadmapOutline(JSON.stringify(roadmap));
assert.equal(outline.stages[0].topics[0].summary, undefined);
for (const field of ['estimatedDuration','assumptions']) {
 const overlong=structuredClone(roadmap);
 if(field==='assumptions')overlong.assumptions=['A complete learner assumption. '.repeat(20)];
 else overlong.estimatedDuration='One complete duration description. '.repeat(10);
 assert.throws(()=>api.normalizeRoadmapOutline(JSON.stringify(overlong)),/exceeds .* characters/,
  'An authored field must be retried rather than silently truncated');
}
const longStage=structuredClone(roadmap.stages[0]);longStage.topics[0].assessment='Complete assessment requirement. '.repeat(30);
assert.throws(()=>api.normalizeRoadmapStage(JSON.stringify(longStage),outline,0,sources),/exceeds .* characters/);
const crowdedOutline = structuredClone(roadmap);
crowdedOutline.stages[0].topics = Array.from({length: 14}, (_, i) => ({
  ...topic(`foundation-${i}`, null), prerequisites: i === 13 ? Array.from({length: 13}, (_, j) => `foundation-${j}`) : [],
}));
assert.throws(() => api.normalizeRoadmapOutline(JSON.stringify(crowdedOutline)), /prerequisites.*12/i,
  'An overlong prerequisite list must be refused, not silently changed');
for (const [field, count] of [['resources', 7], ['keyConcepts', 11]]) {
  const crowdedStage = structuredClone(roadmap.stages[0]);
  crowdedStage.topics[0][field] = Array.from({length: count}, (_, i) => field === 'resources'
    ? {title: `Reference ${i}`, url: 'https://example.org/a'} : `Concept ${i}`);
  assert.throws(() => api.normalizeRoadmapStage(JSON.stringify(crowdedStage), outline, 0, sources), /exceeds.*items/i,
    'Authored lists must retain their full meaning or request bounded recovery');
}
for (const [field, count] of [['assumptions',7],['objectives',9],['deliverables',11],['successCriteria',9]]) {
  const tooMany=structuredClone(roadmap);
  const owner=field==='assumptions'?tooMany:field==='objectives'?tooMany.stages[0]:tooMany.capstone;
  owner[field]=Array.from({length:count},(_,i)=>`Complete requirement ${i}.`);
  assert.throws(()=>api.normalizeRoadmapOutline(JSON.stringify(tooMany)),/exceeds.*items/);
}
const longEffort=structuredClone(roadmap.stages[0]);longEffort.topics[0].estimatedHours=300;
assert.throws(()=>api.normalizeRoadmapStage(JSON.stringify(longEffort),outline,0,sources),/exceeds 240/);
const block={...topic('custom-block',null),keyConcepts:['One','Two','Three']};
assert.equal(api.parseRoadmapBlockDirective(JSON.stringify(block),'','',[...sources]).title,block.title);
for(const field of ['keyConcepts','resources']) {
  const tooMany=structuredClone(block);
  tooMany[field]=Array.from({length:field==='resources'?7:11},(_,i)=>field==='resources'
    ?{title:`Reference ${i}`,url:'https://example.org/a'}:`Concept ${i}`);
  assert.throws(()=>api.parseRoadmapBlockDirective(JSON.stringify(tooMany),'','',[...sources]),/exceeds.*items/,
    'A manual generated block uses the same non-clipping admission policy');
}
let phaseCalls = [], checkpoints = [];
const complete = async ({messages, normalize}) => {
  const phase = messages.at(-1).content;
  phaseCalls.push(phase.match(/\[Roadmap phase: ([^\]]+)\]/)[1]);
  if (phase.includes('[Roadmap phase: outline]')) return normalize(JSON.stringify(roadmap));
  const id = phase.match(/\[Roadmap phase: stage ([^\]]+)\]/)[1];
  if (id === 'stage-1' && checkpoints.length === 2) throw new DOMException('Interrupted', 'AbortError');
  return normalize(JSON.stringify({stage: roadmap.stages.find(s => s.id === id)}));
};
await assert.rejects(api.generateRoadmapInStages({messages: [], complete, allowedUrls: sources,
  onCheckpoint: value => checkpoints.push(JSON.parse(JSON.stringify(value)))}), error => error.name === 'AbortError');
assert.equal(checkpoints.at(-1).stages.length, 1);
const initial = checkpoints.at(-1); checkpoints = [];
const learner = {id: 'learner', role: 'user', content: 'Learn a precise skill', attachments: [],
  web: {sources: [{title: 'Evidence', url: 'https://example.org/a', read: true, reader: 'browser', content: 'An independently read reference.'}]}};
const history = [{role: 'system', content: 'Complete the requested curriculum.'}, {role: 'user', content: learner.content}];
const inputKey = await api.roadmapDraftInputKey({userMsg: learner, messages: history});
const previous = {id: 'previous', role: 'assistant', sources: learner.web.sources,
  roadmapVerification: {effectiveThinking: 'max', contextTokens: 393216},
  roadmapBuild: {...initial, sourceMsgId: learner.id, inputKey}};
const chat = {messages: [learner, previous, {id: 'retry', role: 'assistant'}]};
const select = (overrides = {}) => api.findRoadmapDraft({chat, userMsg: learner, inputKey, allowedUrls: sources, excludeId: 'retry', ...overrides});
assert.equal(select().initial.stages.length, 1);
assert.equal(select().messageId, previous.id);
for (const level of ['off', 'high', 'max']) {
  const key = await api.roadmapDraftInputKey({userMsg: learner, messages: history,
    settings: {thinkLevel: level, ctxSize: level === 'max' ? 393216 : 65536, ssdStreaming: 'on'}});
  assert.equal(key, inputKey, 'Saved authored work survives runtime effort/context/memory changes');
}
for (const changed of [
  {...learner, content: 'Learn a different skill'},
  {...learner, web: {sources: [{...learner.web.sources[0], content: 'Changed reference text.'}]}},
  {...learner, attachments: [{kind: 'text', name: 'context.txt', content: 'Changed learner evidence.'}]},
]) {
  const changedKey = await api.roadmapDraftInputKey({userMsg: changed, messages: history});
  assert.notEqual(changedKey, inputKey);
  assert.equal(select({userMsg: changed, inputKey: changedKey}), null);
}
const newInstructions = await api.roadmapDraftInputKey({userMsg: learner, messages: [{role: 'system', content: 'A changed scope.'}, ...history.slice(1)]});
assert.equal(select({inputKey: newInstructions}), null, 'Changed instructions cannot reuse a keyed draft');
assert.equal(select({inputKey: null}), null, 'Insecure LAN without a digest cannot reuse checkpoints');
const legacy = structuredClone(previous); delete legacy.roadmapBuild.inputKey; legacy.roadmapBuild.dependencyKey = 'old-runtime-key';
assert.equal(select({chat: {messages: [learner, legacy]}}).initial.stages.length, 1,
  'A retained legacy artifact with the same source-message owner/evidence is an unverified draft');
legacy.sources[0].content = 'Changed evidence';
assert.equal(select({chat: {messages: [learner, legacy]}}), null);
assert.equal(select({chat: {messages: [learner]}}), null, 'Editing a user turn removes descendants and leaves no prior draft');
assert.equal(select({chat: {messages: [learner, {id: 'new-turn', role: 'user'}, previous]}}), null,
  'A different learner turn cannot adopt an older draft');
const corrupt = structuredClone(previous); corrupt.id = 'corrupt'; corrupt.roadmapBuild.stages[0].topics[0].id = 'wrong';
assert.equal(select({chat: {messages: [learner, previous, corrupt]}}).messageId, previous.id);
const result = await api.generateRoadmapInStages({messages: [], complete, initial, allowedUrls: sources});
assert.equal(result.stages.length, 3);
assert.deepEqual(phaseCalls, ['outline', 'stage stage-0', 'stage stage-1', 'stage stage-1', 'stage stage-2']);
const bad = structuredClone(roadmap.stages[0]); bad.topics[0].id = 'wrong-id';
assert.throws(() => api.normalizeRoadmapStage(JSON.stringify({stage: bad}), outline, 0, sources), /agreed topic/);
assert.throws(() => api.normalizeRoadmapStage(JSON.stringify(roadmap.stages[0]), outline, 0, new Set()), /exact URLs/);
const invented = structuredClone(roadmap.stages[0]); invented.topics[0].resources[0].url = 'https://invented.example/';
assert.throws(() => api.normalizeRoadmapStage(JSON.stringify(invented), outline, 0, sources), /exact URLs/);
console.log('PASS: Learn saved drafts across effort/context changes, source/instruction invalidation, legacy evidence validation, staged resume, cycle recovery, serial cancellation, bounded previews and finite retries (simulated frames)');

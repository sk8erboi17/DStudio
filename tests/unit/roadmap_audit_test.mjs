// Production Learn audits with simulated decisions. This checks evidence,
// persistence and control contracts, not model factual-answer quality.
import assert from 'node:assert/strict';
import {loadRoadmapFunctions} from '../support/roadmap_functions.mjs';
const api = loadRoadmapFunctions();
const source = {read: true, reader: 'browser', title: 'Fixture primary reference', url: 'https://example.org/reference',
  content: 'A conforming document exposes one visible main landmark. A second conflicting visible main landmark is invalid. The reference also defines practice, verification, and prerequisite order.'};
const roadmap = {title: 'Fixture roadmap', goal: 'Learn correct document structure', audience: 'Beginner', estimatedDuration: '2 weeks', assumptions: ['Basic familiarity'],
  stages: [0, 1].map(i => ({id: `stage-${i}`, title: `Stage ${i}`, description: 'Develop and verify document semantics.', duration: '1 week',
    objectives: ['Verify an observable artifact'], checkpoint: 'Build a document and independently verify its accessibility.',
    topics: [{id: `topic-${i}`, title: `Topic ${i}`, summary: 'Document semantics are checked against the actual supplied primary reference.',
      estimatedHours: 3, keyConcepts: ['One visible main landmark'], prerequisites: i ? ['topic-0'] : [],
      outcome: 'Produce a conforming document with observable semantic structure.', practice: 'Check the visible main landmark in a document.',
      assessment: 'Explain and independently verify document semantics.', resources: [{title: 'Primary reference',url: source.url,why: 'Defines visible main landmarks.'}]}]})),
  capstone: {title: 'Integrated document', description: 'Build and verify a conforming document.', deliverables: ['Document','Checks'], successCriteria: ['Conformance','Reproducibility','Explanation']}};
const jobs = api.roadmapAuditJobs(roadmap);
assert.ok(jobs.every(job => job.items.length <= 4));
const ids = jobs.flatMap(job => job.items.map(item => item.id));
assert.equal(ids.length, new Set(ids).size);
assert.ok(ids.includes('stage-0/topic-0/application'));
assert.ok(ids.includes('stage-1/topic-1/resources'));
assert.ok(ids.includes('global/stage-0/stage-1'));
assert.equal(jobs.filter(job => job.items[0].kind === 'consistency').length, 3);
assert.throws(() => api.roadmapAuditJobs({...roadmap,stages:Array.from({length:40},(_,i)=>({...roadmap.stages[0],id:`s${i}`}))}), error => error.name === 'RoadmapIncompleteError');
const evidenceSources = await api.roadmapAuditSources([source,{...source,url:'https://unread.example/',read:false}]);
assert.equal(evidenceSources.length, 1);
const attached = await api.roadmapAuditSources([{...source,url:'',reader:'attachment-extract'}]);
assert.equal(attached[0].fullText, source.content, 'Prepared text attachments remain available as evidence without a web URL');
const evidence = await api.roadmapAuditEvidence(jobs[0].items, evidenceSources);
assert.equal(evidence[0].fullText, source.content);
const checksFor = task => task.items.map(item => ({id:item.id, verdict:'supported',reason:'The supplied reference/input establishes this check.',
  evidence:[{sourceId:item.kind==='consistency'?'input':task.evidence[0].id, quote:item.kind==='consistency'?item.text.slice(0,80):task.evidence[0].text.slice(0,80)}], finding:null}));
const task = {items:jobs[0].items, evidence:evidence.map(({id,text})=>({id,text}))};
const checks = checksFor(task);
assert.equal(api.normalizeRoadmapCheckBatch({checks},jobs[0].items,evidence).length,4);
for (const mutate of [
  c=>c.pop(),
  c=>{c[0].reason={not:'a reason string'};},
  c=>{c[0].evidence[0].quote={not:'a quote'};},
  c=>{c[1].id=c[0].id;},
  c=>{c[0].evidence[0].sourceId='unknown-source';},
  c=>{c[0].evidence[0].quote='An invented passage absent from the reference.';},
  c=>{c[0].evidence=[{sourceId:'input',quote:jobs[0].items[0].text.slice(0,50)}];},
  c=>{c[0].evidence=[];},
]) {const copy=structuredClone(checks);mutate(copy);assert.throws(()=>api.normalizeRoadmapCheckBatch({checks:copy},jobs[0].items,evidence));}
const uncertain=structuredClone(checks);uncertain[0]={id:checks[0].id,verdict:'unverified',reason:'The supplied excerpt does not establish this claim.',evidence:[],finding:null};
assert.equal(api.normalizeRoadmapCheckBatch({checks:uncertain},jobs[0].items,evidence)[0].verdict,'unverified');
const contradiction=structuredClone(checks);
contradiction[0].verdict='contradicted';contradiction[0].finding={claim:'Stage 0',verdict:'incorrect',justification:'Fixture contradiction.',correction:'A corrected fixture.',confidence:.79};
assert.equal(api.normalizeRoadmapCheckBatch({checks:contradiction},jobs[0].items,evidence)[0].verdict,'unverified');
const consistency=jobs.find(job=>job.items[0].kind==='consistency');
assert.throws(()=>api.normalizeRoadmapCheckBatch({checks:[{id:consistency.items[0].id,verdict:'not_factual',reason:'Skip this',evidence:[],finding:null}]},consistency.items,[]));
let calls=[], ledger;
const complete=async ({messages,normalize})=>{
 const task=JSON.parse(messages.at(-1).content);calls.push(task);
 assert.ok(task.items.every(item=>item.kind==='consistency') || task.evidence.some(e=>e.text===source.content), 'The real read-source text must reach the produced audit request');
 return normalize(JSON.stringify({checks:checksFor(task)}));
};
const run=opts=>api.runRoadmapFactualChecks({roadmap,sources:[source],modelIdentity:{model:'fixture',revision:'one'},complete,
  signal:new AbortController().signal,onCheckpoint:value=>{ledger=structuredClone(value);},...opts});
await assert.rejects(run({sources:[],complete:async()=>{assert.fail('No model call without read-source evidence');}}),error=>error.name==='RoadmapIncompleteError');
const initial=await run();
assert.ok(initial.stageAudits.every(audit=>audit.pass));assert.equal(initial.globalAudit.pass,true);
assert.equal(ledger.completed,ledger.total);const coldCalls=calls.length;
calls=[];await run({initial:ledger});assert.equal(calls.length,0,'Identical checks and evidence are revalidated and reused');
const saved=structuredClone(ledger);
// Old content instructions and the ambiguous final-project scope cannot
// authorize new verdicts. Unchanged stage-pair checks keep their exact key.
const legacy=structuredClone(saved);
for(let index=0;index<jobs.length;index++) {
 const items=jobs[index].items.map(item=>{const copy={...item};delete copy.context;return copy;});
 const e=await api.roadmapAuditEvidence(items,evidenceSources);
 legacy.records[index].key=await api.roadmapAuditDigest(JSON.stringify({schema:2,protocol:api.ROADMAP_FACT_AUDIT_PROTOCOL,
  modelIdentity:{model:'fixture',revision:'one'},learner:{goal:roadmap.goal,audience:roadmap.audience},items,
  evidence:e.map(({id,digest,text})=>({id,digest,text}))}));
}
const untouchedLegacy=structuredClone(legacy);
calls=[];await run({initial:legacy});
assert.equal(calls.length,coldCalls-1);
assert.ok(!calls.some(task=>task.items[0].id==='global/stage-0/stage-1'),
 'Only the unchanged pair contract can reuse a prior verdict');
assert.ok(calls.some(task=>task.items[0].context?.capstoneScope==='whole-roadmap'));
assert.deepEqual(legacy,untouchedLegacy,'Retained earlier verdicts are never rewritten in place');
const altered=structuredClone(roadmap);altered.stages[0].topics[0].practice+=' Explain a corrected example.';
calls=[];await run({roadmap:altered,initial:saved});
assert.ok(calls.length>0 && calls.length<coldCalls);
assert.ok(calls.every(call=>call.items.some(item=>item.id==='stage-0/topic-0/application'||item.id==='global/stage-0/capstone'||item.id==='global/stage-0/stage-1')),
 'Only the changed content batch and dependent global pairs run again');
calls=[];await run({initial:saved,sources:[{...source,content:source.content+' A new source revision.'}],complete:async({messages,normalize})=>{
 const task=JSON.parse(messages.at(-1).content);calls.push(task);return normalize(JSON.stringify({checks:checksFor(task)}));
}});
assert.ok(calls.length>0);assert.ok(calls.every(task=>task.items[0].kind!=='consistency'),'Unchanged internal consistency checks do not depend on external source text');
calls=[];await run({initial:saved,sources:[{...source,title:'A changed source title'}]});
assert.ok(calls.length>0 && calls.every(task=>task.items[0].kind!=='consistency'), 'Changed source titles also invalidate dependent external verdicts');
calls=[];await run({initial:saved,modelIdentity:{model:'fixture',revision:'two'}});assert.equal(calls.length,coldCalls);
const cancel=new AbortController();let interrupted;
await assert.rejects(run({signal:cancel.signal,onCheckpoint(value){interrupted=structuredClone(value);cancel.abort();}}),error=>error.name==='AbortError');
assert.equal(interrupted.completed,4);
calls=[];await run({initial:interrupted});assert.equal(calls.length,coldCalls-1,'Resume starts after the saved batch');
let current=true,commits=0;
await assert.rejects(run({isCurrent:()=>current,complete:async args=>{
 const task=JSON.parse(args.messages.at(-1).content);
 // Make the response stale before normalization/publication. Partial verdicts
 // can now legitimately commit while a phase is still recovering other ids.
 current=false;return args.normalize(JSON.stringify({checks:checksFor(task)}));
},onCheckpoint(){commits++;}}),error=>error.name==='AbortError');
assert.equal(commits,0,'A stale completed response cannot publish a verdict');
const poisoned=structuredClone(saved);poisoned.records[0].checks[0].evidence[0].quote='Invented cached evidence that was never read.';
calls=[];await run({initial:poisoned});assert.equal(calls.length,1,'A malformed cached receipt is recomputed');
const unresolved=await run({complete:async({messages,normalize})=>{
 const task=JSON.parse(messages.at(-1).content);return normalize(JSON.stringify({checks:task.items.map(item=>({id:item.id,verdict:'unverified',reason:'Missing evidence for this assertion.',evidence:[],finding:null}))}));
}});
assert.equal(unresolved.globalAudit.pass,false);assert.ok(unresolved.stageAudits.every(audit=>!audit.pass && audit.unresolved.length));
await assert.rejects(api.roadmapAuditSources(Array.from({length:65},()=>source)),error=>error.name==='RoadmapIncompleteError');

// Run the actual streamed phase owner as well as the auditor: partial verdicts
// must become durable between requests, with exactly three serial attempts.
async function partialRun(respond, options = {}) {
 const requests=[], snapshots=[], retries=[]; let active=0, maxActive=0;
 const controller=options.controller || new AbortController();
 const complete=({messages,normalize,retryMessages,label})=>api.completeRoadmapPhase({
  request:{messages,thinkLevel:'high'},normalize,retryMessages,label,signal:controller.signal,
  isCurrent:options.isCurrent,
  onRetry(attempt,issue){retries.push({attempt,issue});},
  async *stream(request) {
   const task=JSON.parse(request.messages.at(-1).content);requests.push(task);
   active++;maxActive=Math.max(maxActive,active);
   try {
    const reply=await respond(task,requests.length);
    yield {type:'content',text:JSON.stringify({checks:reply.checks})};
    if(reply.beforeFinish)reply.beforeFinish();
    if(reply.failure)yield {type:'error',message:reply.failure,errType:'network'};
    else yield {type:'finish',reason:reply.finish || 'stop'};
   } finally {active--;}
  },
 });
 let result,error;
 try {result=await run({...options,signal:controller.signal,complete,onCheckpoint:async value=>{
  snapshots.push(structuredClone(value));await options.onCheckpoint?.(value);
 }});}catch(cause){error=cause;}
 assert.equal(active,0);assert.ok(maxActive<=1,'A retry cannot overlap the prior stream');
 return {result,error,requests,snapshots,retries};
}
const missing=jobs[0].items[2].id;
const recovered=await partialRun((task,index)=>({checks:checksFor(task).filter(check=>index!==1 || check.id!==missing)}));
assert.equal(recovered.error,undefined);
assert.equal(recovered.snapshots[0].completed,3,'The three admitted verdicts are saved before the missing request');
assert.deepEqual(recovered.requests[1].items.map(item=>item.id),[missing]);
assert.deepEqual(recovered.requests[1].evidence,recovered.requests[0].evidence,'Narrowing ids cannot change the evidence identity');
assert.equal(recovered.requests.length,coldCalls+1);
assert.equal(recovered.result.completed,recovered.result.total);
assert.equal(new Set(recovered.snapshots.at(-1).records[0].checks.map(check=>check.id)).size,4);

for(const defect of ['duplicate','invented-quote','unknown-id']) {
 const result=await partialRun((task,index)=>{
  const checks=checksFor(task);
  if(index===1) {
   if(defect==='duplicate')checks.push({...checks[0],verdict:'unverified',evidence:[]});
   else if(defect==='invented-quote')checks[0].evidence[0].quote='Fabricated source words absent from the reference.';
   else checks[0].id='unrequested-id';
  }
  return {checks};
 });
 assert.equal(result.error,undefined);
 assert.equal(result.snapshots[0].completed,3);
 assert.deepEqual(result.requests[1].items.map(item=>item.id),[jobs[0].items[0].id]);
 assert.ok(result.snapshots.every(snapshot=>snapshot.records.every(record=>record.checks.every(check=>check.id!=='unrequested-id'))));
}

const exhausted=await partialRun((task,index)=>({checks:index===1?checksFor(task).slice(0,3):[]}));
assert.equal(exhausted.error.name,'RoadmapIncompleteError');
assert.equal(exhausted.requests.length,3,'Partial responses do not multiply the automatic attempt budget');
assert.equal(exhausted.retries.length,3);
assert.deepEqual(exhausted.requests.slice(1).map(task=>task.items.length),[1,1]);
const partialLedger=exhausted.snapshots.at(-1);
assert.equal(partialLedger.completed,3);
const resumed=await partialRun(task=>({checks:checksFor(task)}),{initial:partialLedger});
assert.equal(resumed.error,undefined);
assert.deepEqual(resumed.requests[0].items.map(item=>item.id),[jobs[0].items[3].id]);
const retained={completed:4,roadmap,content:JSON.stringify({checks:checksFor({items:jobs[1].items,evidence:task.evidence}).slice(0,3)})};
const oldWholePrefix={version:2,records:[saved.records[0]],completed:4,total:saved.total};
const oldPartial=await partialRun(task=>({checks:checksFor(task)}),{initial:oldWholePrefix,retainedResponse:retained});
assert.equal(oldPartial.error,undefined);
assert.equal(oldPartial.snapshots[1].completed,7,'A matching older complete prefix permits validated retained siblings to be recovered');
assert.deepEqual(oldPartial.requests[0].items.map(item=>item.id),[jobs[1].items[3].id]);
const driftedOldPartial=await partialRun(task=>({checks:checksFor(task)}),{
 initial:oldWholePrefix,retainedResponse:retained,modelIdentity:{model:'fixture',revision:'changed'},
});
assert.equal(driftedOldPartial.error,undefined);
assert.equal(driftedOldPartial.requests[1].items.length,4,'A mismatching cached prefix cannot admit retained raw output');
const changedPending=structuredClone(roadmap);changedPending.stages[1].topics[0].summary+=' A changed assertion.';
const changedRetainedJob=await partialRun(task=>({checks:checksFor(task)}),{initial:oldWholePrefix,retainedResponse:retained,roadmap:changedPending});
assert.equal(changedRetainedJob.error,undefined);
assert.equal(changedRetainedJob.requests[0].items.length,4,'Unchanged earlier receipts cannot validate a changed pending item');
for(const changes of [
 {modelIdentity:{model:'fixture',revision:'changed'}},
 {sources:[{...source,content:source.content+' Additional source revision.'}]},
]) {
 const changed=await partialRun(task=>({checks:checksFor(task)}),{initial:partialLedger,...changes});
 assert.equal(changed.error,undefined);
 assert.equal(changed.requests[0].items.length,4,'Incompatible partial verdicts must not be reused');
}

const stopPartial=new AbortController();
const stopped=await partialRun(task=>({checks:checksFor(task).slice(0,3)}),{controller:stopPartial,onCheckpoint(){stopPartial.abort();}});
assert.equal(stopped.error.name,'AbortError');assert.equal(stopped.requests.length,1);
assert.equal(stopped.snapshots.at(-1).completed,3);
let activeOwner=true;
const stalePartial=await partialRun((task,index)=>({checks:index===1?checksFor(task).slice(0,3):checksFor(task),
 beforeFinish:index===2?()=>{activeOwner=false;}:undefined}),{isCurrent:()=>activeOwner});
assert.equal(stalePartial.error.name,'AbortError');assert.equal(stalePartial.snapshots.at(-1).completed,3);
const storageFailure=await partialRun(task=>({checks:checksFor(task).slice(0,3)}),{onCheckpoint(){
 const error=new Error('The checkpoint could not be saved.');error.name='RoadmapIncompleteError';throw error;
}});
assert.equal(storageFailure.error.name,'RoadmapIncompleteError');assert.equal(storageFailure.requests.length,1,'Storage failure cannot trigger more model work');

const truncated=await partialRun(task=>({checks:checksFor(task).slice(0,3),finish:'length'}));
assert.equal(truncated.error.name,'RoadmapIncompleteError');assert.equal(truncated.requests.length,3);
assert.equal(truncated.snapshots.length,0,'A truncated transport cannot admit even complete-looking partial JSON');
const disconnected=await partialRun((task,index)=>({checks:index===1?checksFor(task).slice(0,3):[],failure:index===2?'Disconnected':undefined}));
assert.equal(disconnected.error.message,'Disconnected');assert.equal(disconnected.snapshots.at(-1).completed,3);

const laterReceipts=structuredClone(saved);laterReceipts.records[0].checks.pop();
const stopCached=new AbortController();
const retainLater=await partialRun(()=>{assert.fail('The stop precedes inference');},{initial:laterReceipts,controller:stopCached,onCheckpoint(){stopCached.abort();}});
assert.equal(retainLater.error.name,'AbortError');assert.equal(retainLater.requests.length,0);
assert.equal(retainLater.snapshots[0].records.length,laterReceipts.records.length,'Partial checkpoints cannot erase later saved jobs');
const finishLater=await partialRun(task=>({checks:checksFor(task)}),{initial:retainLater.snapshots[0]});
assert.equal(finishLater.error,undefined);assert.equal(finishLater.requests.length,1,'All later valid jobs survive Stop/resume');

console.log('PASS: complete/partial audit admission, missing-id-only retries, exact quote validation, duplicate/unknown ids, durable 3-of-4 progress, three-attempt bound, Stop/reload, stale responses, storage/transport failures, selective identity invalidation and retained later jobs (simulated decisions)');

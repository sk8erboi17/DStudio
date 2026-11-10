// Production Learn retrieval and request contracts on authored references.
// No inference: these tests establish evidence transport, not model judgments.
import assert from 'node:assert/strict';
import {loadRoadmapFunctions} from '../support/roadmap_functions.mjs';
const api=loadRoadmapFunctions();
const menu=Array.from({length:90},(_,i)=>`[Reference curriculum ${i}](https://example.org/lessons/reference/curriculum/${i})`).join(' ');
const background='Background describes the history of the fictional workshop and its facilities. ';
const named='The Juniper case is a required exercise. Groups normally contain seven (7) participants; mixed-location groups are encouraged.';
const assessed='The oral defence lasts 23 minutes and is worth 35%. The report contains 2,100 words and is worth 65%.';
const definition='Calibration combines preparation, measurement, comparison and adjustment of the reference artefact.';
const source=(id,body)=>({id,title:`Reference ${id}`,url:`https://example.org/${id}`,canonicalUrl:`https://example.org/canonical/${id}`,fullText:body,digest:`authored-${id}`});
const documents=[
 source('S1',`# Workshop handbook ## Content ${menu} ## Definition ${definition} ${background.repeat(20)} ## Group work ${named} ## Other material ${background.repeat(25)} ## Assessment ${assessed} ## Visible links ${menu}`),
 ...[2,3,4,5,6].map(i=>source(`S${i}`,`# Source ${i} ## Content ${menu} ## Overview ${background.repeat(i)}`)),
];
const items=[
 {id:'workshop/stage',kind:'content',sourceUrls:[documents[0].url],text:JSON.stringify({title:'Laboratorio',description:background.repeat(12)})},
 {id:'workshop/calibration/concepts',kind:'content',sourceUrls:[],text:JSON.stringify({summary:'Studia preparation, measurement, comparison e adjustment del reference artefact.'})},
 {id:'workshop/group-work/application',kind:'content',sourceUrls:[],text:JSON.stringify({practice:'Produci 400 pagine fittizie e usa 900 etichette. Discuti il caso Juniper.'})},
 {id:'workshop/group-work/resources',kind:'content',sourceUrls:[documents[0].canonicalUrl],text:JSON.stringify({title:'A guide for learning',why:'Il caso Juniper usa gruppi di 7 partecipanti; le squadre miste sono consigliate. La valutazione prevede 23 minuti e 2100 parole, con pesi 35% e 65%.'})},
];
const copy=structuredClone(documents);
const evidence=await api.roadmapAuditEvidence(items,documents);
assert.equal(evidence.length,6);assert.deepEqual(documents,copy,'Retrieval must not mutate source evidence');
const primary=evidence.find(s=>s.id==='S1');
for(const fact of [definition,named,assessed])assert.ok(primary.text.includes(fact),`Lost an independently specified workshop fact: ${fact}`);
assert.ok(evidence.reduce((sum,s)=>sum+s.text.length,0)<=14400);
assert.ok(evidence.every(s=>s.text.length<=3600));
for(const s of evidence)for(const fragment of s.text.split(/ \[source excerpt \d+-\d+\] /))
 assert.ok(s.fullText.replace(/\s+/g,' ').trim().includes(fragment),'Retained passages must be literal source text');

// Swapping the metadata/earlier siblings cannot hide the fourth item's facts.
const reordered=await api.roadmapAuditEvidence([...items].reverse(),documents);
assert.ok(reordered.find(s=>s.id==='S1').text.includes(assessed));
const index=await api.roadmapAuditEvidence([{...items[3],text:JSON.stringify({why:'The handbook links the Iris notes.'})}],
 [source('index','# Course index ## Content [Iris notes](https://example.org/iris) ## Visible links [Iris notes](https://example.org/iris)')]);
assert.ok(index[0].text.includes('Iris notes'),'An index can establish that a resource is offered');

// Case folding and source clipping must not change the literal offsets or split
// supplementary Unicode. The limit applies to the prepared page, not just output.
const unicode=source('unicode',`# İstanbul guide ## Content ${'🌲 Arboriculture background. '.repeat(1600)} ## Reading The Prism-572 label identifies the calibrated specimen. ${background.repeat(8)}`);
const selected=await api.roadmapAuditEvidence([{...items[0],text:JSON.stringify({summary:'Locate the Prism-572 calibrated specimen.'})}],[unicode]);
assert.ok(selected[0].text.includes('The Prism-572 label identifies the calibrated specimen.'));
assert.ok(selected[0].text.isWellFormed());
const bounded=api.roadmapAuditPassages('x'.repeat(256000)+' A fact outside the read-source boundary.');
assert.equal(bounded.clean.length,256000);
assert.ok(!bounded.clean.includes('outside'));
const many=await api.roadmapAuditEvidence(items,Array.from({length:12},(_,i)=>source(`other-${i}`,`# Page ${i} ## Content ${background}`)));
assert.equal(many.length,8,'Source count admission remains bounded');
// Ranking must inspect substantive text beyond the leading navigation/sample,
// before applying the eight-source wire limit.
const lateSources = Array.from({length: 9}, (_, i) => source(`late-${i}`,
  '# Reference ## Background ' + background.repeat(160) +
  (i === 8 ? ' ## Procedure The exact Prism-572 procedure requires a calibrated specimen.' : '')));
for (const ordered of [lateSources, [...lateSources].reverse()]) {
  const selected = await api.roadmapAuditEvidence([{...items[0],sourceUrls:[],text:JSON.stringify({summary:'Explain the exact Prism-572 procedure.'})}], ordered);
  assert.ok(selected.some(s => s.id === 'late-8' && s.text.includes('Prism-572')),
    'A relevant late passage cannot be hidden by eight earlier background-only sources');
  assert.ok(selected.length <= 8 && selected.reduce((n,s) => n+s.text.length,0) <= 14400);
}
let preparing=true,controlServiced=false;
const large=Array.from({length:8},(_,i)=>source(`large-${i}`,
 `# Reference ## Content ${background.repeat(3600)}`));
const work=api.roadmapAuditEvidence([{...items[0],text:JSON.stringify({summary:'Describe the workshop facilities.'})}],large);
setTimeout(()=>{controlServiced=preparing;},0);
const largeEvidence=await work;preparing=false;
assert.ok(controlServiced,'Control callbacks must run before bulk preparation completes');
assert.ok(largeEvidence.reduce((sum,s)=>sum+s.text.length,0)<=14400);

// Hold actual preparation at its first event-loop yield; Stop or a changed
// owner cannot publish prepared evidence after the gate is released.
for(const stale of [false,true]) for(const yieldAt of [1,documents.length+1]) {
 const controller=new AbortController();let owner=true,entered,release;
 let yields=0;
 const gate=new Promise(resolve=>entered=resolve),original=globalThis.setTimeout;
 globalThis.setTimeout=(fn,delay,...args)=>{
  if(++yields!==yieldAt)return original(fn,delay,...args);
  release=()=>fn(...args);entered();return 0;
 };
 try {
  const pending=api.roadmapAuditEvidence(items,documents,{signal:controller.signal,isCurrent:()=>owner});
  await gate;if(stale)owner=false;else controller.abort();release();
  await assert.rejects(pending,{name:'AbortError'});
 }finally{globalThis.setTimeout=original;}
}

// The concrete task carries the project's whole-roadmap scope and schedule.
// The simulated reviewer checks that scope, and still rejects an actual
// course-wide prohibition that conflicts with the final project's requirement.
const roadmap={title:'Specimen workshop',goal:'Produce and explain a calibrated specimen',audience:'Beginner',
 stages:[{id:'basics',title:'Basics',description:'Teach basic labels.',topics:[],checkpoint:'Label one specimen.'},
 {id:'advanced',title:'Advanced',description:'Teach the full procedure.',topics:[],checkpoint:'Calibrate a specimen.'}],
 capstone:{title:'Final calibration',description:'After the whole course, apply the full procedure.',deliverables:['Specimen','Report'],successCriteria:['Calibration']}};
const jobs=api.roadmapAuditJobs(roadmap),project=jobs.find(j=>j.items[0].context?.evaluatedStageId==='basics').items[0];
assert.deepEqual(project.context,{capstoneScope:'whole-roadmap',evaluatedStageId:'basics',scheduledAfterStageIds:['basics','advanced'],laterStageIds:['advanced']});
const review=task=>task.context.capstoneScope==='whole-roadmap' && task.context.laterStageIds.includes('advanced') &&
 !JSON.parse(task.text).stage.description.includes('Course-wide: no network access') ? 'supported':'contradicted';
assert.equal(review(project),'supported','Requiring later skills at the end is not itself a contradiction');
const actualConflict=structuredClone(roadmap);actualConflict.stages[0].description='Course-wide: no network access.';
actualConflict.capstone.description='A network-only final project requires online access.';
assert.equal(review(api.roadmapAuditJobs(actualConflict).find(j=>j.items[0].context?.evaluatedStageId==='basics').items[0]),'contradicted');

// The actual produced request, rather than a prompt wording assertion, must
// carry the canonical URL and the scope. Missing evidence cannot become passed.
const seen=[];let ledger;
await api.runRoadmapFactualChecks({roadmap,sources:[{read:true,title:'Read reference',url:'https://example.org/requested',canonicalUrl:'https://example.org/canonical',content:definition}],
 modelIdentity:{model:'fixture'},signal:new AbortController().signal,onCheckpoint:value=>{ledger=value;},
 complete:async({messages,normalize})=>{const task=JSON.parse(messages.at(-1).content);seen.push(task);return normalize(JSON.stringify({checks:task.items.map(item=>({id:item.id,verdict:'unverified',reason:'No supplied proof establishes this requested assertion.',evidence:[],finding:null}))}));}});
assert.ok(seen.filter(t=>t.items[0].kind==='content').every(t=>t.evidence[0].canonicalUrl==='https://example.org/canonical'));
assert.deepEqual(seen.find(t=>t.items[0].context?.evaluatedStageId==='basics').items[0].context,project.context);
assert.ok(ledger.records.every(r=>r.checks.every(c=>c.verdict==='unverified')));
console.log('PASS: Learn fair evidence retrieval, menus, late names/numbers, canonical URLs, literal/Unicode/count/byte bounds, Stop/stale preparation and final-project scope (authored sources, simulated verdicts; no model)');

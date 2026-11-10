// Production graph edits and draft admission, without a model or live store.
import assert from 'node:assert/strict';
import {loadRoadmapFunctions} from '../support/roadmap_functions.mjs';
const api = loadRoadmapFunctions();
const base = {title:'Specimen procedure',goal:'Calibrate a specimen',audience:'Beginner',
  stages:[{id:'foundation',title:'Foundation',topics:[
    {id:'basics',title:'Basics',prerequisites:[]},
    {id:'procedure',title:'Procedure',prerequisites:['basics']},
    {id:'optional',title:'Independent reading',prerequisites:[],optional:true},
  ]},{id:'advanced',title:'Advanced',topics:[{id:'final',title:'Final calibration',prerequisites:['procedure']}]}]};
const original = structuredClone(base);
const message = {id:'message',content:'```dstudio-roadmap\n'+JSON.stringify(base)+'\n```',
  roadmapVerification:{status:'verified',verifiedAt:123,stageAudits:[{pass:true}],curriculumJudge:{pass:true}},
  roadmapAudit:{records:[{key:'previous-dependencies'}],completed:4,total:4},
  roadmapStudyThreads:{'topic:optional':{messages:['Retain until a valid deletion']},'topic:basics':{messages:['Keep']}}};
const before = structuredClone(message), progress = {basics:true,optional:true,final:false};
const reversed = structuredClone(base);reversed.stages[0].topics.reverse();
assert.throws(() => api.roadmapEditPatch(message,reversed,progress), /before its prerequisite/);
const missing = structuredClone(base);missing.stages[0].topics.shift();
assert.throws(() => api.roadmapEditPatch(message,missing,progress,['topic:basics']), /Cannot remove a prerequisite/);
const noStage = structuredClone(base);noStage.stages.shift();
assert.throws(() => api.roadmapEditPatch(message,noStage,progress), /Cannot remove a prerequisite/);
const duplicate = structuredClone(base);duplicate.stages[1].topics[0].id='basics';
assert.throws(() => api.roadmapEditPatch(message,duplicate), /unique/);
const empty = structuredClone(base);empty.stages[0].topics=[];
assert.throws(() => api.roadmapEditPatch(message,empty), /at least one block/);
assert.deepEqual(base,original);assert.deepEqual(message,before);
assert.deepEqual(progress,{basics:true,optional:true,final:false},'Rejected edits cannot erase completion state');

// Independent blocks can move; deleting an unreferenced leaf removes only its
// own progress/chat. The earlier verdict is explicitly no longer current.
const allowed = structuredClone(base);
allowed.stages[0].topics.unshift(allowed.stages[0].topics.pop());
const patch = api.roadmapEditPatch(message,allowed,progress);
assert.deepEqual(patch.roadmapOverride.stages[0].topics.map(t=>t.id),['optional','basics','procedure']);
assert.equal(patch.roadmapVerification.status,'modified');
assert.equal(patch.roadmapVerification.previousVerifiedAt,123);
assert.equal(patch.roadmapVerification.stageAudits,undefined);
assert.equal(patch.roadmapVerification.curriculumJudge,undefined);
const leafDeleted = structuredClone(base);leafDeleted.stages[0].topics.pop();
const deletion = api.roadmapEditPatch(message,leafDeleted,progress,['topic:optional']);
assert.deepEqual(deletion.roadmapProgress,{basics:true,final:false});
assert.equal(deletion.roadmapStudyThreads['topic:optional'],undefined);
assert.deepEqual(deletion.roadmapStudyThreads['topic:basics'],message.roadmapStudyThreads['topic:basics']);
assert.deepEqual(message,before,'Preparing a patch cannot mutate the owned message');
const edited = {...message,...patch};
assert.equal(api.roadmapForMessage(edited).stages[0].topics[0].id,'optional');
assert.deepEqual(edited.roadmapAudit,message.roadmapAudit,'Prior receipts stay retained; the new version does not inherit their status');

// A complete unverified draft is an explicit preview, not an accepted graph.
for (const status of ['fact-audit','incomplete','interrupted','failed']) {
  const draft = {...message,roadmapVerification:{status}};
  assert.equal(api.roadmapForMessage(draft),null);
  assert.equal(api.roadmapForMessage(draft,{includeDrafts:true}).title,base.title);
  assert.equal(draft.roadmapVerification.status,status);
}
console.log('PASS: Learn prerequisite-safe edits, immutable rejection, verdict retirement and explicit unverified previews (no model)');

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {cases,checkChat} from '../../extension/prompt-lookup/bench/fixtures.mjs';
import {summarize} from '../../extension/prompt-lookup/bench/summarize.mjs';
assert.equal(new Set(cases.map(c=>c.id)).size,cases.length);
for(const c of cases.filter(c=>c.surface==='chat')){
  if(c.expected) {assert.ok(checkChat(c,c.expected));assert.ok(!checkChat(c,c.expected+' tampered'));}
}
const tool=cases.find(c=>c.expectedTool);
assert.ok(checkChat(tool,'',[{function:{name:'store_note',arguments:JSON.stringify({body:tool.expectedTool.body})}}]));
assert.ok(!checkChat(tool,'',[{function:{name:'store_note',arguments:'{"body":"wrong"}'}}]));
const report={method:{surfaces:['chat'],modes:['off','batch'],caseIds:['one','two'],repeats:1},finishedAt:'done',runs:[
  {surface:'chat',mode:'off',caseId:'one',repeat:0,correct:true,wallMs:100,outputSha:'a',pld:{batches:0}},
  {surface:'chat',mode:'batch',caseId:'one',repeat:0,correct:true,wallMs:50,outputSha:'a',pld:{batches:2}},
  {surface:'chat',mode:'off',caseId:'two',repeat:0,correct:true,wallMs:100,outputSha:'b',pld:{batches:0}},
  {surface:'chat',mode:'batch',caseId:'two',repeat:0,correct:false,wallMs:1,outputSha:'bad',pld:{batches:1}},
]};
const s=summarize(report),batch=s.groups.find(g=>g.mode==='batch');
assert.ok(s.complete);assert.equal(batch.medianPairedSpeedup,2);
assert.equal(batch.comparableCorrectIdenticalPairs,1);assert.equal(batch.regressedCases.length,1);
assert.ok(!summarize({...report,runs:[...report.runs.slice(0,3),report.runs[0]]}).complete,'Duplicate rows cannot mask a missing measurement');
assert.ok(!summarize({...report,runs:report.runs.map((r,i)=>i?r:{...r,wallMs:0})}).complete,'Invalid timing cannot be published');
assert.ok(!summarize({...report,method:{...report.method,caseIds:[]},runs:[]}).complete,'An empty run is not a completed comparison');
report.finishedAt=null;assert.ok(!summarize(report).complete);
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dstudio-pld-publish-'));
try{
  const input=path.join(dir,'input.json'),output=path.join(dir,'public.json');
  const publish=(extra=[])=>spawnSync(process.execPath,['extension/prompt-lookup/bench/publish.mjs',input,output,...extra],{encoding:'utf8'});
  fs.writeFileSync(input,JSON.stringify(report));assert.notEqual(publish().status,0);
  report.finishedAt='done';report.hostContention=[{pid:123,cpu:75,game:true}];
  fs.writeFileSync(input,JSON.stringify(report));assert.notEqual(publish(['--shared-host']).status,0);
  report.method.hostMode='shared';report.method.hostLabel='Minecraft running';
  fs.writeFileSync(input,JSON.stringify(report));assert.notEqual(publish().status,0);
  assert.equal(publish(['--shared-host']).status,0);
  const published=JSON.parse(fs.readFileSync(output,'utf8'));
  assert.equal(published.publication.hostMode,'shared');
  assert.equal(published.publication.productionQualification,false);
  assert.equal(published.publication.allMeasuredTasksPassed,false);
  assert.match(published.publication.timingInterpretation,/Not an isolated speed guarantee/);
  assert.equal(published.summary.groups.find(g=>g.mode==='batch').correct,1);
  assert.notEqual(publish(['--shared-host']).status,0);
}finally{fs.rmSync(dir,{recursive:true,force:true});}
console.log('PLD benchmark validators: independent checks, incomplete runs, incorrect speedups and explicit shared-host publication passed');

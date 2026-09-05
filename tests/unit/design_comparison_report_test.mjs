// Synthetic receipts test report accounting, not design/model quality.
import assert from 'node:assert/strict';
import {compareDesignRuns} from '../support/design_comparison_report.mjs';

const sha='a'.repeat(64),suite={cases:[{id:'one',prompt:'Frozen brief',entry:'one.html'}]};
const names=['agent completed and registered its artifact',...Array.from({length:7},(_,i)=>'browser group '+i)];
const input={run:{label:'before',host:{cpu:'Test',memoryBytes:1},model:{path:'/model',bytes:1,mtimeMs:1},
  memory:'resident',engineIdentity:{commit:'same'},engineSourceSha256:{'ds4.c':sha,'ds4.h':sha,'ds4_metal.m':sha},
  inference:{context:32768,thinkTokens:1536,maxTokensPerRound:8192,seed:7,temperature:0.4},
  startupTimeoutMs:900000,turnTimeoutMs:1800000,binarySha256:sha,designSource:{sha256:sha},
  cases:[{...suite.cases[0],status:'idle',artifact:{entry:'one.html'},entryExists:true,ms:1000,exitCode:0,signal:null}]},
  audit:{label:'before',partial:false,notYetAudited:[],auditorSha256:sha,
    cases:[{id:'one',checks:names.map(name=>({name,pass:true}))}]} };
const copy=()=>structuredClone(input);
const compare=other=>compareDesignRuns(input,other,suite).results[1];
assert.equal(compare(copy()).satisfyAuditedRequirements,1);
let changed=copy();changed.audit.cases[0].checks[2].pass=false;
assert.equal(compare(changed).delivered,1);
assert.equal(compare(changed).satisfyAuditedRequirements,0);
changed=copy();changed.run.cases[0].generationLimitReached=true;
changed.audit.cases[0].checks[0].pass=false;
assert.equal(compare(changed).delivered,0);
assert.equal(compare(changed).satisfyAuditedRequirements,0);
changed=copy();changed.run.cases[0].status='turn-timeout';delete changed.run.cases[0].artifact;
changed.audit.cases[0].checks[0].pass=false;
assert.equal(compare(changed).delivered,0);
assert.equal(compare(changed).cases[0].browserGroupsPassed,7);
assert.equal(compare(changed).satisfyAuditedRequirements,0);
changed.run.cases[0].entryExists=false;
changed.audit.cases[0].checks=changed.audit.cases[0].checks.slice(0,1);
assert.equal(compare(changed).cases[0].browserGroupsRun,0);
assert.equal(compare(changed).satisfyAuditedRequirements,0);
for(const mutate of [
  x=>x.run.cases[0].status='running',
  x=>x.audit.partial=true,
  x=>x.audit.notYetAudited=['one'],
  x=>x.run.cases=[],
  x=>x.audit.cases=[],
  x=>x.run.cases.push(x.run.cases[0]),
  x=>x.audit.cases.push(x.audit.cases[0]),
  x=>x.audit.cases[0].checks.pop(),
  x=>x.audit.cases[0].checks[1].name=names[0],
  x=>x.audit.cases[0].checks[1].pass='true',
  x=>x.run.model.mtimeMs++,
  x=>x.run.inference.context=8192,
  x=>x.run.engineSourceSha256['ds4.c']='b'.repeat(64),
  x=>x.run.cases[0].prompt='Different task',
  x=>x.run.cases[0].entry='different.html',
  x=>x.run.cases[0].exitCode=1,
  x=>x.run.cases[0].ms=NaN,
  x=>x.audit.auditorSha256='b'.repeat(64),
  x=>x.audit.label='unrelated',
  x=>x.run.interrupted=true,
  x=>x.run.caseCount=2,
]) {
  changed=copy();mutate(changed);assert.throws(()=>compare(changed));
}
const missingSettings=copy();delete missingSettings.run.inference.seed;
assert.throws(()=>compareDesignRuns(missingSettings,missingSettings,suite));
console.log('design_comparison_report_test: PASS (synthetic receipts; failed, incomplete and mismatched comparisons are not promoted to quality passes)');

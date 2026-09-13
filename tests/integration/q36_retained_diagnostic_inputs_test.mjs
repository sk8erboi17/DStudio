// Fictional terminal receipts and actual patch application; no engine/weights.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {artifactRunDir,writeArtifact} from '../support/real_harness.mjs';
import {selectRetainedDiagnosticCase,validateRetainedDiagnosticRequest,
  verifyDiagnosticPatchStack,diagnosticSourceNames,retainedDiagnosticOptions} from '../support/q36_retained_diagnostic_inputs.mjs';

const run=artifactRunDir('q36-retained-diagnostic-inputs'), report={scope:'Simulated receipts, real private patch round-trip; no inference',tests:[]};
function test(name,body){body();report.tests.push({name,status:'pass'});}
const manifest={identity:'fixture-corpus',settings:{temperature:0,seed:20260909},
  cases:Array.from({length:100},(_,i)=>({id:i===87?'long_context-single-needle':`case-${i}`,
    category:i===87?'long_context':'code',prompt:'Fictional prompt',deadline_ms:900000,max_tokens:2048}))};
const original={corpus:manifest.identity,finished:'fixture-finished',status:'fail',requestedModel:'fixture-model',
  cases:manifest.cases.map((c,i)=>({id:c.id,status:i===87?'fail':'pass'})),
  summary:{denominator:100,passed:99,failed:1,notRun:0,pending:0}};
const before={finished:'fixture-finished',results:[{engine:'q36',status:'fail'}]},caseId=manifest.cases[87].id;
const payload={model:'fixture-model',messages:[{role:'user',content:'Fictional prompt'}],
  temperature:0,seed:20260909,max_tokens:2048,think:false,thinking:{type:'disabled'},stream:false};
try{
  test('explicit F16 candidate records the fourth patch without changing request inputs',()=>{
    const cli=['engine','model','prior',caseId,'hash'];
    const baseline=retainedDiagnosticOptions(cli);
    assert.equal(baseline.variant,'original-f16-diagnostic');assert.equal(baseline.preflightOnly,false);
    assert.equal(baseline.patchNames.length,3);assert.deepEqual(baseline.inputs,cli);
    for(const flags of [['--f16-attention'],['--preflight-only','--f16-attention'],['--f16-attention','--preflight-only']]){
      const candidate=retainedDiagnosticOptions([...cli,...flags]);
      assert.equal(candidate.variant,'bounded-f16-attention');assert.deepEqual(candidate.inputs,cli);
      assert.deepEqual(candidate.patchNames,[...baseline.patchNames,'q36-f16-attention']);
      assert.equal(candidate.preflightOnly,flags.includes('--preflight-only'));
    }
    assert.equal(retainedDiagnosticOptions([...cli,'--preflight-only']).preflightOnly,true);
    for(const flags of [['--unknown'],['--f16-attention','--f16-attention'],['--preflight-only','--preflight-only']])
      assert.throws(()=>retainedDiagnosticOptions([...cli,...flags]));
    assert.throws(()=>retainedDiagnosticOptions(cli.slice(0,4)));
  });
  test('canonical underscore case admitted without modifying receipts',()=>{
    const frozen=JSON.stringify({before,manifest,original,payload});
    const c=selectRetainedDiagnosticCase(before,manifest,original,caseId);
    assert.equal(c.index,87);assert.equal(c.item.deadline_ms,900000);
    validateRetainedDiagnosticRequest(payload,c.item,manifest,original);
    assert.equal(JSON.stringify({before,manifest,original,payload}),frozen);
  });
  test('path traversal, unknown and overlong case identities rejected',()=>{
    for(const id of ['../long_context-single-needle','x/y','x\\y','x'.repeat(129),'long_context-missing'])
      assert.throws(()=>selectRetainedDiagnosticCase(before,manifest,original,id));
  });
  test('partial, duplicate, changed-corpus and altered-denominator runs rejected',()=>{
    for(const mutate of [r=>delete r.finished,r=>r.status='running',r=>r.cases.pop(),
      r=>r.cases[1].id=r.cases[0].id,r=>r.corpus='changed',r=>r.summary.passed++,
      r=>r.cases[0].status='pending',r=>r.cases[87].status='pass']){
      const invalid=structuredClone(original);mutate(invalid);
      assert.throws(()=>selectRetainedDiagnosticCase(before,manifest,invalid,caseId));
    }
  });
  test('non-long or relaxed deadline cases rejected',()=>{
    for(const mutate of [c=>c.category='code',c=>c.deadline_ms=900001]){
      const m=structuredClone(manifest);mutate(m.cases[87]);
      assert.throws(()=>selectRetainedDiagnosticCase(before,m,original,caseId));
    }
  });
  test('every request field and extra tool instruction is frozen',()=>{
    for(const mutate of [p=>p.messages[0].content+='changed',p=>p.model='different',p=>p.temperature=1,
      p=>p.seed++,p=>p.max_tokens++,p=>p.think=true,p=>p.thinking.type='enabled',p=>p.stream=true,p=>p.tools=[]]){
      const p=structuredClone(payload);mutate(p);
      assert.throws(()=>validateRetainedDiagnosticRequest(p,manifest.cases[87],manifest,original));
    }
  });
  const engine=path.join(run,'candidate');fs.mkdirSync(engine);
  const input=path.join(engine,'unit.txt'),text='alpha\nmiddle2\nomega\nunrelated\n';fs.writeFileSync(input,text);
  execFileSync('git',['-C',engine,'init','-q']);execFileSync('git',['-C',engine,'add','unit.txt']);
  fs.mkdirSync(path.join(engine,'shaders'));fs.writeFileSync(path.join(engine,'shaders/new.txt'),'added by patch\n');
  test('snapshot includes untracked source added by a patch',()=>{
    assert.deepEqual(diagnosticSourceNames(engine).sort(),['shaders/new.txt','unit.txt']);
  });
  const patches=[1,2].map(n=>{const f=path.join(run,`layer${n}.patch`);
    fs.writeFileSync(f,`diff --git a/unit.txt b/unit.txt\n--- a/unit.txt\n+++ b/unit.txt\n@@ -1,3 +1,3 @@\n alpha\n-middle${n-1}\n+middle${n}\n omega\n`);return f;});
  const addedPatch=path.join(run,'added.patch');
  fs.writeFileSync(addedPatch,'diff --git a/shaders/new.txt b/shaders/new.txt\nnew file mode 100644\n--- /dev/null\n+++ b/shaders/new.txt\n@@ -0,0 +1 @@\n+added by patch\n');
  patches.push(addedPatch);
  test('overlapping patches reverse in order and reproduce exact bytes',()=>{
    const p=verifyDiagnosticPatchStack(engine,path.join(run,'roundtrip'),diagnosticSourceNames(engine),patches);
    assert.equal(p.roundTripIdentical,true);assert.deepEqual(p.restored,[...patches].reverse());
    assert.equal(fs.readFileSync(input,'utf8'),text);
    assert.equal(fs.readFileSync(path.join(engine,'shaders/new.txt'),'utf8'),'added by patch\n');
  });
  test('missing overlay rejected without changing source',()=>{
    fs.writeFileSync(input,text.replace('middle2','middle1'));
    assert.throws(()=>verifyDiagnosticPatchStack(engine,path.join(run,'partial'),diagnosticSourceNames(engine),patches));
    assert.equal(fs.readFileSync(input,'utf8'),text.replace('middle2','middle1'));
  });
  test('source drift rejected without changing source',()=>{
    fs.writeFileSync(input,text.replace('omega','drift'));
    assert.throws(()=>verifyDiagnosticPatchStack(engine,path.join(run,'drift'),diagnosticSourceNames(engine),patches));
    assert.equal(fs.readFileSync(input,'utf8'),text.replace('omega','drift'));
  });
  test('symlink, escaping names and occupied validation directory rejected',()=>{
    fs.symlinkSync(input,path.join(engine,'link.txt'));
    for(const name of ['link.txt','../candidate/unit.txt','/unit.txt'])
      assert.throws(()=>verifyDiagnosticPatchStack(engine,path.join(run,'confined'),[name],patches));
    assert.throws(()=>verifyDiagnosticPatchStack(engine,path.join(run,'roundtrip'),['unit.txt'],patches));
  });
  report.passed=true;
}catch(e){report.passed=false;report.error=e.stack;process.exitCode=1;}
finally{report.finished=new Date().toISOString();writeArtifact(run,'results.json',report);console.log(JSON.stringify({run,...report}));}

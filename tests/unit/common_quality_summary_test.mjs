import assert from 'node:assert/strict';
import { failureClass, summarizeCommonQuality } from '../support/common_quality_summary.mjs';

const areas = {arithmetic:12,reasoning:12,code:15,debugging:10,json:10,extraction:10,instructions:10,language:8,long_context:8,insufficient:5};
const cases = Object.entries(areas).flatMap(([category,n]) => Array.from({length:n},(_,i)=>({id:`${category}-${i}`,category,status:'pass'})));
const report = {schema:'dstudio.common-quality-run.v1',planned:100,cases,corpus:'a'.repeat(64),status:'pass',finished:'fixture-finished',
  evaluationUse:'simulated-summary-test',settings:{context:65536,temperature:0,thinking:'off',seed:20260909,max_tokens:2048},
  summary:{denominator:100,passed:100,failed:0,notRun:0,pending:0},
  runtime:{engine:'fixture',model:{path:'/Users/private/secret.gguf',sha256:'b'.repeat(64),bytes:100},binarySha256:'c'.repeat(64),argv:['secret']}};
const digest = 'd'.repeat(64);
let summary = summarizeCommonQuality(report,digest);
assert.equal(summary.summary.passed,100);
assert.ok(!JSON.stringify(summary).includes('secret'));
assert.ok(!JSON.stringify(summary).includes('/Users/'));
const format = {status:'fail',category:'arithmetic',grade:{passed:false,actual:{result:103},expected:103}};
assert.equal(failureClass(format),'right_value_wrong_container');
assert.equal(failureClass({...format,grade:{actual:{result:104},expected:103}}),'wrong_answer_or_structure');
assert.equal(failureClass({...format,grade:{actual:{result:false},expected:0}}),'wrong_answer_or_structure');
assert.equal(failureClass({status:'fail',category:'long_context',error:'fetch failed'}),'transport_or_engine_error');
Object.assign(report.cases[0],format);
report.status='fail';report.summary.passed=99;report.summary.failed=1;
summary=summarizeCommonQuality(report,digest);
assert.equal(summary.summary.passed,99,'diagnostic classification must never turn a failure into a pass');
assert.equal(summary.failures.right_value_wrong_container,1);
report.recoveryPolicy={maxEngineRestarts:1,failedCasesRetried:false};
report.recoveries=[{afterCaseId:report.cases[0].id,status:'ready',reason:'/Users/private/secret',base:'http://127.0.0.1:1234'}];
summary=summarizeCommonQuality(report,digest);
assert.deepEqual(summary.engineRestarts,{limit:1,requested:1,ready:1,failed:0,failedCasesRetried:false});
assert.ok(!JSON.stringify(summary).includes('secret'));
assert.ok(!JSON.stringify(summary).includes('127.0.0.1'));
for(const mutate of [r=>r.cases.pop(),r=>r.cases[1].id=r.cases[0].id,r=>r.status='running',
  r=>r.summary.passed=100,r=>r.cases[1].status='pending',r=>delete r.runtime,
  r=>r.recoveries[0].afterCaseId=r.cases[1].id,r=>r.recoveries[0].status='running',
  r=>r.recoveryPolicy.maxEngineRestarts=0,r=>r.recoveryPolicy.failedCasesRetried=true]) {
  const invalid=structuredClone(report);mutate(invalid);
  assert.throws(()=>summarizeCommonQuality(invalid,digest));
}
// The host runner (llama.cpp, MLX, expert SSD streaming) records every weight
// file, the engine install receipt and the host binary instead of one model file.
const hostRuntime = {
  engine:{identity:{dir:'/Users/private/engine',receipts:{'.dstudio-llama.json':{sha256:'e'.repeat(64),content:{commit:'f'.repeat(40)}}},
    executables:[{name:'bin/llama-server',bytes:7,sha256:'1'.repeat(64)}]},processes:[{pid:1,command:'/Users/private/secret --port 1'}]},
  selection:{modelFile:'gguf/secret.gguf',engine:'llama',quantization:'Q6'},
  weights:{totalBytes:100,files:[{name:'secret.gguf',bytes:100,sha256:'2'.repeat(64)}]},
  host:{baseUrl:'http://127.0.0.1:1234',binary:'/Users/private/host',binarySha256:'3'.repeat(64),repository:{head:'4'.repeat(40),dirty:false},patchSet:{sha256:'5'.repeat(64)}},
  effective:{ssdStreamingEffective:false,ctx:65536}};
const hostReport = {...structuredClone(report),runtime:hostRuntime};
let hosted = summarizeCommonQuality(hostReport,digest);
assert.deepEqual(hosted.model,{engine:'llama',quantization:'Q6',weightSha256:'2'.repeat(64),weightBytes:100,binarySha256:'1'.repeat(64),
  engineReceiptSha256:'e'.repeat(64),upstreamCommit:'f'.repeat(40),enginePins:undefined,hostBinarySha256:'3'.repeat(64),hostCommit:'4'.repeat(40),
  hostTreeDirty:false,patchSetSha256:'5'.repeat(64),ssdStreaming:false});
assert.ok(!/secret|\/Users\/|127\.0\.0\.1/.test(JSON.stringify(hosted)));
// A model folder is identified by one digest over its files, whatever their order.
const folder = structuredClone(hostReport);
folder.runtime.weights.files = [{name:'b.safetensors',bytes:60,sha256:'6'.repeat(64)},{name:'a.json',bytes:40,sha256:'7'.repeat(64)}];
const folderModel = summarizeCommonQuality(folder,digest).model;
assert.match(folderModel.weightSetSha256,/^[0-9a-f]{64}$/); assert.equal(folderModel.weightFiles,2); assert.equal(folderModel.weightSha256,undefined);
folder.runtime.weights.files.reverse();
assert.equal(summarizeCommonQuality(folder,digest).model.weightSetSha256,folderModel.weightSetSha256);
folder.runtime.weights.files[0].sha256='8'.repeat(64);
assert.notEqual(summarizeCommonQuality(folder,digest).model.weightSetSha256,folderModel.weightSetSha256);
hostRuntime.effective.ssdStreamingEffective = true;
assert.equal(summarizeCommonQuality({...hostReport,runtime:hostRuntime},digest).model.ssdStreaming,true);
for(const mutate of [r=>r.runtime.weights.files=[],r=>delete r.runtime.weights.files[0].sha256,r=>r.runtime.engine.identity.receipts={},
  r=>r.runtime.engine.identity.receipts.second={sha256:'9'.repeat(64),content:{}},
  r=>{r.runtime.engine.identity.receipts['.dstudio-llama.json'].sha256='';r.runtime.engine.identity.executables=[];}]) {
  const invalid=structuredClone(hostReport);mutate(invalid);
  assert.throws(()=>summarizeCommonQuality(invalid,digest));
}
console.log('PASS aggregate validation, privacy projection and no partial-credit regrading; synthetic unit data only');

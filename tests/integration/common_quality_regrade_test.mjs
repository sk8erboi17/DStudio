// Saved-answer regrading tests. Synthetic receipts, actual Python evaluator,
// no inference. Pass a separately prepared candidate grader during a live run.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {artifactRunDir} from '../support/real_harness.mjs';
import {regradeCommonQuality} from '../support/regrade_common_quality.mjs';
import {summarizeCommonQuality} from '../support/common_quality_summary.mjs';

const root=process.cwd(), run=artifactRunDir('common-quality-regrade-test');
const grader=path.resolve(process.argv[2]||'tests/support/common_model_quality.py');
const manifest=JSON.parse(execFileSync('python3',['-B',grader,'--manifest'],{encoding:'utf8',maxBuffer:4*1024**2}));
const answers=JSON.parse(execFileSync('python3',['-B','-c',
  "import sys,json,runpy;sys.path.insert(0,'tests/support');import common_model_quality as q;r=runpy.run_path('tests/unit/common_quality_interval_oracle_test.py');a=[q.golden_answer(c) for c in q.CASES];a[25]=r['REFERENCE'];print(json.dumps(a))"],
{encoding:'utf8',maxBuffer:1024**2}));
const json=(file,data)=>fs.writeFileSync(file,JSON.stringify(data,null,2)+'\n');
const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function fixture(name) {
  const source=path.join(run,name);fs.mkdirSync(source);
  const old=structuredClone(manifest);old.identity='f'.repeat(64);
  json(path.join(source,'manifest.json'),old);
  const report={schema:'dstudio.common-quality-run.v1',planned:100,status:'fail',finished:'synthetic-finished',
    corpus:old.identity,requestedModel:'synthetic-no-model',evaluationUse:'simulated-regrade-test',settings:old.settings,
    categoryCounts:old.counts,cases:old.cases.map(c=>({id:c.id,category:c.category,status:'not_run',reason:'fixture not executed'})),
    summary:{denominator:100,passed:1,failed:4,notRun:95,pending:0},
    runtime:{engine:'fixture',model:{path:'/Users/private/example.gguf',sha256:'a'.repeat(64),bytes:123},binarySha256:'b'.repeat(64)}};
  for(const i of [0,1,2,25,87]) {
    const spec=old.cases[i], row=report.cases[i];
    const directory=path.join(source,`${String(i+1).padStart(3,'0')}-${spec.id}`);fs.mkdirSync(directory);
    const answer=i===1?'0':answers[i];
    const usage={prompt_tokens:i===87?200:30000,completion_tokens:20};
    const finish=i===2?'length':'stop';
    Object.assign(row,{status:i===0?'pass':'fail',httpStatus:200,finishReason:finish,usage});delete row.reason;
    const request={model:report.requestedModel,messages:[{role:'user',content:spec.prompt}],
      temperature:old.settings.temperature,seed:old.settings.seed,max_tokens:spec.max_tokens,
      think:false,thinking:{type:'disabled'},stream:false};
    json(path.join(directory,'request.json'),request);
    json(path.join(directory,'response.json'),{model:report.requestedModel,usage,
      choices:[{finish_reason:finish,message:{role:'assistant',content:answer}}]});
    if(i!==2) {
      row.grade={passed:i===0||i===87,identity:old.identity,case_id:spec.id};
      if(i===25)row.grade.error='Synthetic historical list-only oracle rejects immutable pairs';
      fs.mkdirSync(path.join(directory,'oracle'));
      json(path.join(directory,'oracle/answer.json'),{identity:old.identity,answer});
      json(path.join(directory,'oracle/grade.json'),row.grade);
    }
    if(i===87)row.promptCoverage=false;
  }
  const file=path.join(source,'results.json');json(file,report);
  return {source,file,report};
}
const justification='Independent interval regression proves ordered immutable pairs satisfy the unchanged task; this test uses synthetic receipts only.';
const original=fixture('original'), originalHash=hash(original.file);
const corrected=regradeCommonQuality(original.file,path.join(run,'corrected'),{grader,justification});
assert.equal(hash(original.file),originalHash,'source receipt must remain byte-identical');
assert.deepEqual(corrected.summary,{denominator:100,passed:2,failed:3,notRun:95,pending:0});
assert.deepEqual(corrected.regrading.changedCases,[{id:'code-merge-intervals',before:'fail',after:'pass'}]);
assert.equal(corrected.cases[2].finishReason,'length');
assert.equal(corrected.cases[2].status,'fail','regrading cannot cure truncation');
assert.equal(corrected.cases[87].grade.passed,true);
assert.equal(corrected.cases[87].status,'fail','a correct short answer cannot cure missing long-context coverage');
assert.equal(corrected.regrading.inferenceRepeated,false);
const publicSummary=summarizeCommonQuality(corrected,hash(path.join(run,'corrected/results.json')));
assert.deepEqual(publicSummary.correction.originalSummary,original.report.summary);
assert.equal(publicSummary.correction.changedCaseCount,1);
assert.ok(!JSON.stringify(publicSummary).includes('/Users/private'));
assert.ok(!JSON.stringify(publicSummary).includes(justification));
assert.throws(()=>regradeCommonQuality(original.file,path.join(run,'corrected'),{grader,justification}),/exist/i);

const active=fixture('active');active.report.status='running';delete active.report.finished;json(active.file,active.report);
assert.throws(()=>regradeCommonQuality(active.file,path.join(run,'active-out'),{grader,justification}),/active|partial/);
assert.ok(!fs.existsSync(path.join(run,'active-out')));

const changed=fixture('changed-prompt');
const oldManifest=JSON.parse(fs.readFileSync(path.join(changed.source,'manifest.json')));
oldManifest.cases[0].prompt+=' CHANGED';json(path.join(changed.source,'manifest.json'),oldManifest);
assert.throws(()=>regradeCommonQuality(changed.file,path.join(run,'changed-out'),{grader,justification}),/changed prompts/);
assert.ok(!fs.existsSync(path.join(run,'changed-out')));

const tampered=fixture('replaced-answer');
const responseFile=path.join(tampered.source,'001-arithmetic-inventory/response.json');
const response=JSON.parse(fs.readFileSync(responseFile));response.choices[0].message.content='104';json(responseFile,response);
assert.throws(()=>regradeCommonQuality(tampered.file,path.join(run,'tampered-out'),{grader,justification}),/originally evaluated/);
assert.ok(!fs.existsSync(path.join(run,'tampered-out/results.json')));
assert.equal(JSON.parse(fs.readFileSync(path.join(run,'tampered-out/progress.json'))).status,'regrade_incomplete');

const escape=fixture('escaping-file');
const requestFile=path.join(escape.source,'001-arithmetic-inventory/request.json');
fs.renameSync(requestFile,path.join(run,'outside-request.json'));
fs.symlinkSync(path.join(run,'outside-request.json'),requestFile);
assert.throws(()=>regradeCommonQuality(escape.file,path.join(run,'escape-out'),{grader,justification}),/escaped/);
assert.ok(!fs.existsSync(path.join(run,'escape-out/results.json')));
console.log(`PASS original/corrected scores, identical requests, failed/absent case retention, privacy and source integrity; simulated receipt data. ${run}`);

// Re-evaluate saved answers after a documented oracle correction. No inference,
// no changes to the original receipt, and no retries replacing initial failures.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '../..');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const write = (file, object) => fs.writeFileSync(file, JSON.stringify(object, null, 2) + '\n', {flag: 'wx'});

export function regradeCommonQuality(sourceFile, destination, {
  grader = path.join(root, 'tests/support/common_model_quality.py'),
  python = 'python3', justification,
} = {}) {
  assert.ok(typeof justification === 'string' && justification.trim().length >= 20,
    'record the independently demonstrated grader defect before regrading');
  const sourceDirectory = fs.realpathSync(path.dirname(sourceFile));
  const audited = new Map();
  function read(file, parse = true) {
    const real = fs.realpathSync(file);
    assert.ok(real.startsWith(sourceDirectory + path.sep), 'receipt input escaped its source directory');
    const st = fs.statSync(real, {bigint:true});
    assert.ok(st.isFile() && st.size <= 4n * 1024n ** 2n, 'receipt file is missing or oversized');
    const bytes = fs.readFileSync(real);
    const identity = [st.dev,st.ino,st.size,st.mtimeNs,st.ctimeNs].map(String).join(':');
    audited.set(real, {identity,sha256:sha(bytes)});
    return parse ? JSON.parse(bytes) : bytes;
  }
  const original = read(sourceFile);
  assert.equal(original.schema, 'dstudio.common-quality-run.v1');
  assert.ok(original.finished && ['pass','fail'].includes(original.status), 'cannot regrade an active/partial run');
  assert.equal(original.planned, 100);
  assert.equal(original.cases.length, 100);
  assert.ok(original.cases.every(c => ['pass','fail','not_run'].includes(c.status)));
  assert.deepEqual(original.summary,{denominator:100,
    passed:original.cases.filter(c=>c.status==='pass').length,
    failed:original.cases.filter(c=>c.status==='fail').length,
    notRun:original.cases.filter(c=>c.status==='not_run').length,pending:0},'original denominator/score is inconsistent');
  const previousManifest = read(path.join(sourceDirectory, 'manifest.json'));
  assert.equal(previousManifest.identity, original.corpus);
  const nextManifest = JSON.parse(execFileSync(python, ['-B',grader,'--manifest'],
    {encoding:'utf8',maxBuffer:4 * 1024 ** 2,timeout:10000}));
  assert.deepEqual(previousManifest.cases, nextManifest.cases, 'changed prompts, formats or deadlines require a new inference run');
  assert.deepEqual(previousManifest.settings, nextManifest.settings, 'do not change generation settings during a regrade');
  assert.deepEqual(previousManifest.counts, nextManifest.counts);
  assert.notEqual(previousManifest.identity, nextManifest.identity, 'no grader change to evaluate');
  assert.deepEqual(original.cases.map(c=>c.id),nextManifest.cases.map(c=>c.id),'original case identities/order changed');
  fs.mkdirSync(destination);
  write(path.join(destination,'manifest.json'),nextManifest);
  const corrected = structuredClone(original);
  corrected.directory = path.resolve(destination);
  corrected.corpus = nextManifest.identity;
  corrected.status = 'regrading'; delete corrected.finished;
  corrected.regrading = {started:new Date().toISOString(),inferenceRepeated:false,justification,
    sourceInferenceFinished:original.finished,
    sourceReceiptSha256:audited.get(fs.realpathSync(sourceFile)).sha256,
    sourceCorpus:previousManifest.identity,graderCorpus:nextManifest.identity,
    requestCorpusSha256:sha(JSON.stringify({cases:nextManifest.cases,settings:nextManifest.settings})),
    originalSummary:original.summary,changedCases:[]};
  write(path.join(destination,'original-results.json'),original);
  const saveProgress = () => fs.writeFileSync(path.join(destination,'progress.json'), JSON.stringify(corrected,null,2)+'\n');
  saveProgress();
  try {
    for(let i=0;i<corrected.cases.length;i++) {
      const row = corrected.cases[i], spec=nextManifest.cases[i];
      assert.equal(row.category,spec.category);
      if(row.status==='not_run')continue;
      const directory = path.join(sourceDirectory,`${String(i+1).padStart(3,'0')}-${row.id}`);
      if(fs.existsSync(path.join(directory,'request.json'))) {
        const request = read(path.join(directory,'request.json'));
        assert.deepEqual(request,{model:original.requestedModel,messages:[{role:'user',content:spec.prompt}],
          temperature:nextManifest.settings.temperature,seed:nextManifest.settings.seed,max_tokens:spec.max_tokens,
          think:false,thinking:{type:'disabled'},stream:false},'recorded request differs from the frozen corpus');
      } else assert.ok(row.status==='fail' && row.httpStatus===undefined,'completed response has no recorded request');
      // HTTP/transport/truncation failures cannot be repaired by an answer grader.
      if(row.httpStatus!==200 || row.finishReason!=='stop') {
        assert.equal(row.status,'fail');
        if(fs.existsSync(path.join(directory,'response.json')))read(path.join(directory,'response.json'),false);
        continue;
      }
      const response=read(path.join(directory,'response.json'));
      assert.equal(response.choices?.length,1);
      assert.equal(response.choices[0].finish_reason,'stop');
      assert.deepEqual(response.usage,row.usage,'stored usage differs from the original response');
      const answer=response.choices[0].message?.content;
      if(typeof answer!=='string'||!answer.length){assert.equal(row.status,'fail');continue;}
      if(row.grade) {
        assert.deepEqual(read(path.join(directory,'oracle/answer.json')),{identity:previousManifest.identity,answer},
          'raw response differs from the answer originally evaluated');
        assert.deepEqual(read(path.join(directory,'oracle/grade.json')),row.grade,'original grade was replaced');
      }
      const out=path.join(destination,`${String(i+1).padStart(3,'0')}-${row.id}`);
      const result=JSON.parse(execFileSync(python,['-B',grader,'--grade',row.id,'--out',out],
        {input:JSON.stringify({identity:nextManifest.identity,answer}),encoding:'utf8',maxBuffer:1024**2,
          timeout:spec.kind==='patch'?25000:15000}));
      const covered=!spec.minimum_prompt_tokens || Number.isSafeInteger(response.usage?.prompt_tokens) && response.usage.prompt_tokens>=spec.minimum_prompt_tokens;
      row.originalStatus=row.status;
      row.originalGradeSha256=row.grade?sha(JSON.stringify(row.grade)):null;
      if(row.error)row.originalError=row.error;
      delete row.error;
      row.grade=result;row.promptCoverage=covered;
      row.status=result.passed&&covered?'pass':'fail';
      if(!covered)row.error='long-context coverage not demonstrated by actual prompt token usage';
      if(row.status!==row.originalStatus)corrected.regrading.changedCases.push({id:row.id,before:row.originalStatus,after:row.status});
      saveProgress();
    }
    // Detect source mutation/replacement throughout review; never overwrite or
    // silently take a later answer under the identity of an earlier attempt.
    for(const [file,expected] of audited) {
      const st=fs.statSync(file,{bigint:true});
      assert.equal([st.dev,st.ino,st.size,st.mtimeNs,st.ctimeNs].map(String).join(':'),expected.identity,'original evidence changed during review');
      assert.equal(sha(fs.readFileSync(file)),expected.sha256,'original evidence bytes changed');
    }
    const count=status=>corrected.cases.filter(c=>c.status===status).length;
    corrected.summary={denominator:100,passed:count('pass'),failed:count('fail'),notRun:count('not_run'),pending:0};
    assert.equal(corrected.summary.passed+corrected.summary.failed+corrected.summary.notRun,100);
    corrected.status=corrected.summary.passed===100?'pass':'fail';
    corrected.finished=new Date().toISOString();
    corrected.regrading.sourceFiles=Object.fromEntries([...audited].map(([file,value])=>[path.relative(sourceDirectory,file),value]));
    write(path.join(destination,'results.json'),corrected);
    saveProgress();
    return corrected;
  } catch(error) {
    corrected.regrading.error=error.stack;
    corrected.status='regrade_incomplete';saveProgress();
    throw error;
  }
}

if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  assert.equal(process.argv.length,5,'usage: node regrade_common_quality.mjs OLD_RESULTS.json NEW_DIRECTORY "documented defect"');
  const result=regradeCommonQuality(process.argv[2],process.argv[3],{justification:process.argv[4]});
  console.log(JSON.stringify({original:result.regrading.originalSummary,corrected:result.summary,changes:result.regrading.changedCases}));
}

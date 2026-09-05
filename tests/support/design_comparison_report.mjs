// Summarize completed native runs without converting partial delivery or the
// model's own critique into an independent quality score.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {pathToFileURL} from 'node:url';

const deliveryCheck='agent completed and registered its artifact';
const digest=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const hash=value=>assert.match(value,/^[a-f0-9]{64}$/);
const byId=rows=>{
  assert.ok(Array.isArray(rows));
  assert.equal(new Set(rows.map(r=>r.id)).size,rows.length,'Duplicate case');
  return new Map(rows.map(r=>[r.id,r]));
};

export function compareDesignRuns(before,after,suite) {
  assert.ok(suite.cases.length>0,'Frozen briefs required');
  const frozen=byId(suite.cases),ids=[...frozen.keys()].sort();
  for(const key of ['host','model','memory','engineIdentity','engineSourceSha256',
    'inference','startupTimeoutMs','turnTimeoutMs']) {
    assert.ok(before.run[key]!==undefined,'Missing comparison identity: '+key);
    assert.deepEqual(before.run[key],after.run[key],'Different '+key);
  }
  assert.ok(before.run.model.path && before.run.model.bytes>0 && Number.isFinite(before.run.model.mtimeMs));
  for(const key of ['context','thinkTokens','maxTokensPerRound','seed','temperature'])
    assert.ok(Number.isFinite(before.run.inference[key]),'Missing inference setting: '+key);
  for(const key of ['ds4.c','ds4.h','ds4_metal.m'])hash(before.run.engineSourceSha256[key]);
  assert.ok(before.run.startupTimeoutMs>0 && before.run.turnTimeoutMs>0);
  const results=[];
  let checkNames;
  for(const input of [before,after]) {
    const {run,audit}=input,rows=byId(run.cases),checks=byId(audit.cases);
    assert.ok(!run.interrupted,'Interrupted comparison');
    assert.equal(audit.partial,false,'A partial audit cannot stand for the whole run');
    assert.deepEqual(audit.notYetAudited,[],'Unaudited cases remain');
    assert.equal(audit.label,run.label,'Audit belongs to another run');
    hash(audit.auditorSha256);hash(run.binarySha256);hash(run.designSource.sha256);
    assert.deepEqual([...rows.keys()].sort(),ids,'Missing or unexpected native case');
    assert.deepEqual([...checks.keys()].sort(),ids,'Missing or unexpected audit case');
    assert.equal(run.caseCount??rows.size,ids.length,'Subset run');
    const cases=ids.map(id=>{
      const row=rows.get(id),review=checks.get(id),brief=frozen.get(id);
      assert.equal(row.prompt,brief.prompt,'Changed prompt: '+id);
      assert.equal(row.entry,brief.entry,'Changed entry: '+id);
      assert.ok(['idle','turn-timeout','startup-timeout','process-error','exited'].includes(row.status),
        'Nonterminal or unknown native status: '+id);
      assert.ok(Number.isFinite(row.ms) && row.ms>=0,'Missing elapsed time: '+id);
      assert.ok(review.checks.length>0 && review.checks.every(c=>typeof c.pass==='boolean'));
      const names=review.checks.map(c=>c.name).sort();
      assert.equal(new Set(names).size,names.length,'Duplicate audit group');
      assert.ok(names.includes(deliveryCheck),'Missing delivery check');
      // A missing entry legitimately cannot have browser checks. It remains a
      // failure, never an empty checklist that passes by vacuous truth.
      if(row.entryExists) {
        assert.ok(names.length>=8,'Incomplete browser audit');
        checkNames??=names;assert.deepEqual(names,checkNames,'Different browser checks');
      } else assert.deepEqual(names,[deliveryCheck]);
      const delivered=row.status==='idle' && Boolean(row.artifact) && row.entryExists===true &&
        row.exitCode===0 && !row.signal && !row.generationLimitReached;
      assert.equal(review.checks.find(c=>c.name===deliveryCheck).pass,delivered,'Inconsistent delivery receipt');
      const behavioral=review.checks.filter(c=>c.name!==deliveryCheck);
      return {id,status:row.status,delivered,elapsedSeconds:row.ms/1000,
        browserGroupsPassed:behavioral.filter(c=>c.pass).length,
        browserGroupsRun:behavioral.length,
        satisfiesAuditedRequirements:delivered && behavioral.length>0 && behavioral.every(c=>c.pass),
        failures:review.checks.filter(c=>!c.pass).map(c=>({name:c.name,error:c.error??'Failed'}))};
    });
    results.push({label:run.label,binarySha256:run.binarySha256,designSourceSha256:run.designSource.sha256,
      delivered:cases.filter(c=>c.delivered).length,
      satisfyAuditedRequirements:cases.filter(c=>c.satisfiesAuditedRequirements).length,cases});
  }
  assert.equal(before.audit.auditorSha256,after.audit.auditorSha256,'Different auditor revisions');
  return {scope:'Frozen development briefs; one generation per brief. Delivery, browser behavior and visual review are separate. No aesthetic score or speedup claim.',
    visualQuality:'Requires separate review of the actual screenshots; not inferred from these counts.',
    auditorSha256:before.audit.auditorSha256,caseCount:ids.length,results};
}

function loadRun(root) {
  const read=name=>JSON.parse(fs.readFileSync(path.join(root,name),'utf8'));
  const run=read('report.json'),audit=read('audit.json'),suite=read('frozen-cases.json');
  assert.equal(digest(fs.readFileSync(run.capturedBinary??run.binary)),run.binarySha256,'Executable changed');
  const localSource=path.join(root,'inputs/ds4_design.c');
  const source=run.designSource.capturedPath??(fs.existsSync(localSource)?localSource:run.designSource.path);
  assert.equal(digest(fs.readFileSync(source)),run.designSource.sha256,'Design source changed');
  for(const row of run.cases.filter(c=>c.entryExists)) {
    const workspace=fs.realpathSync(path.join(root,row.id,'workspace'));
    const entry=fs.realpathSync(path.join(workspace,row.entry));
    assert.ok(entry.startsWith(workspace+path.sep),'Entry escapes workspace');
    assert.equal(digest(fs.readFileSync(entry)),row.entrySha256,'Generated entry changed: '+row.id);
  }
  return {run,audit,suite};
}

if(process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  const [beforeArg,afterArg,outputArg]=process.argv.slice(2);
  assert.ok(beforeArg && afterArg && outputArg,
    'Usage: node tests/support/design_comparison_report.mjs BEFORE_DIR AFTER_DIR NEW_OUTPUT_DIR');
  const before=loadRun(path.resolve(beforeArg)),after=loadRun(path.resolve(afterArg));
  assert.deepEqual(before.suite.cases,after.suite.cases,'Frozen briefs differ');
  const report=compareDesignRuns(before,after,before.suite);
  const output=path.resolve(outputArg);
  assert.ok(!fs.existsSync(output),'Use a new output directory; preserve prior evidence');
  fs.mkdirSync(output,{recursive:true});
  fs.writeFileSync(path.join(output,'comparison.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));
}

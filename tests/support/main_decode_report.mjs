// Reanalyse preserved native receipts; never rewrite a failed original run.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {compareWorkloads,prefillMetrics} from './main_decode_metrics.mjs';

const [beforeDs,afterDs,beforeGlm,afterGlm,outputArg]=process.argv.slice(2);
assert.ok(outputArg,'Usage: node tests/support/main_decode_report.mjs BEFORE_DS AFTER_DS BEFORE_GLM AFTER_GLM NEW_OUTPUT_DIR');
const output=path.resolve(outputArg);assert.ok(!fs.existsSync(output));
function read(dir){
  const file=path.resolve(dir,'results.json'),bytes=fs.readFileSync(file),r=JSON.parse(bytes);
  assert.ok(r.finishedAt && !r.interrupted && !r.error,'run must have finished: '+dir);
  assert.equal(r.process.code,0,'engine must shut down cleanly');
  assert.equal(r.process.signal,null,'engine must not have been killed');
  const spans=[...fs.readFileSync(path.join(dir,'engine.log'),'utf8').matchAll(/chat ctx=\d+\.\.\d+:\d+ prompt done [0-9.]+s/g)];
  const rows=[...r.gates,...r.runs];
  assert.equal(spans.length,rows.length,'one native prefill per recorded request required');
  rows.forEach((row,i)=>{
    const p=prefillMetrics(spans[i][0]);assert.ok(p,'native prefill span required');
    assert.equal(p.tokens,row.response.usage.prompt_tokens,'this benchmark expects cold request prefixes');
    row.prefillTokens=p.tokens;row.prefillSeconds=p.seconds;row.prefillTokensPerSecond=p.tokensPerSecond;
    const usage=row.response.usage;
    row.tokens=usage.completion_tokens;
    row.tokensPerSecond=usage.ds4.decode_tokens_per_second;
    row.decodeSeconds=usage.ds4.decode_elapsed_seconds;
  });
  r.evidence={path:file,sha256:crypto.createHash('sha256').update(bytes).digest('hex')};return r;
}
const pairs=[['DeepSeek V4 in RAM',read(beforeDs),read(afterDs)],['GLM 5.3 SSD 32 GiB',read(beforeGlm),read(afterGlm)]];
const results=pairs.map(([name,b,a])=>({name,before:b.evidence,after:a.evidence,beforeCommit:b.commit,afterCommit:a.commit,
  host:b.host,model:b.model,comparison:compareWorkloads(b,a),
  correctness:{before:{gates:b.gates.map(r=>({id:r.id,status:r.status,answer:r.response.choices[0].message.content})),
    measuredPasses:b.runs.filter(r=>r.status==='pass').length,measuredTotal:b.runs.length},
    after:{gates:a.gates.map(r=>({id:r.id,status:r.status,answer:r.response.choices[0].message.content})),
    measuredPasses:a.runs.filter(r=>r.status==='pass').length,measuredTotal:a.runs.length}},
  identicalMeasuredAnswers:b.runs.every((r,i)=>r.response.choices[0].message.content===a.runs[i].response.choices[0].message.content)}));
fs.mkdirSync(output,{recursive:true});
fs.writeFileSync(path.join(output,'comparison.json'),JSON.stringify(results,null,2)+'\n');
const n=x=>typeof x==='number'?x.toFixed(2):'not qualified';
let md='# Native main update: prefill and decode\n\n';
md+='M2 Max, 96 GiB; 8K context, greedy, no PLD/MTP/DSpark. Same existing model files and three workloads repeated three times. Values are medians in tokens/second. Short prompts: not maximum long-context prefill. Desktop applications remained open. Preliminary before runs overlapped CPU builds, so small deltas are not controlled evidence of improvement.\n\n';
for(const r of results){
  md+='## '+r.name+'\n\n';
  md+='| Workload | Prefill before | Prefill after | Change | Decode before | Decode after | Change |\n| --- | ---: | ---: | ---: | ---: | ---: | ---: |\n';
  for(const [id,c] of Object.entries(r.comparison))md+=`| ${id} | ${n(c.before.prefill?.median)} | ${n(c.after.prefill?.median)} | ${n(c.prefillChangePercent)}% | ${n(c.before.decode?.median)} | ${n(c.after.decode?.median)} | ${n(c.decodeChangePercent)}% |\n`;
  md+='\nExact measured answers passed: '+r.correctness.before.measuredPasses+'/9 before, '+r.correctness.after.measuredPasses+'/9 after. Byte-identical measured answers: '+r.identicalMeasuredAnswers+'.\n\n';
  for(const stage of ['before','after'])for(const g of r.correctness[stage].gates)if(g.status!=='pass')md+='Auxiliary check **FAILED** ('+stage+', '+g.id+'): '+JSON.stringify(g.answer)+'.\n\n';
}
md+='No claim of general model quality or full-logit numerical equivalence. Missing/failed workloads are not used for speed comparisons. Original failed receipts remain unchanged.\n';
fs.writeFileSync(path.join(output,'REPORT.md'),md);console.log(md);console.log('Evidence: '+output);

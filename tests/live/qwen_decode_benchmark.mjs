// Actual native CLI measurements; engine-reported generation rate, not tokens
// divided by HTTP wall time. Three checked, identical long responses, sequential.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';

const root=process.cwd(), engine=path.join(root,'ds4-qwen38');
const base='Qwen3.8-Flash-Next-Q4KImatrixExperts-MXFP4Down-BF16Emb-BF16Control-Q8GDN-Q8QSA-Q8Shared-Q8Out.gguf';
const ple='Qwen3.8-Flash-Next-PLE-Q4_1.gguf';
const output=path.join(root,'tests/.artifacts/qwen-decode');fs.mkdirSync(output,{recursive:true});
const run=fs.mkdtempSync(path.join(output,'run-'));
const expected=Array.from({length:32},(_,i)=>`item_${String(i+1).padStart(2,'0')},${(i+1)*7}`).join('\n');
const prompt=`Copy the CSV below exactly. Return only its 32 lines, without Markdown fences or commentary. Do not add a header.\n\n${expected}`;
const argv=['--metal','-m',path.join(root,'ds4/gguf',base),'--ple',path.join(root,'ds4/gguf',ple),'--ctx','8192','--prefill-chunk','512','--nothink','--temp','0','--seed','42','--tokens','1024','-p',prompt];
const hash=crypto.createHash('sha256').update(fs.readFileSync(path.join(engine,'ds4'))).digest('hex');
const report={schema:'dstudio.qwen-decode.v1',started:new Date().toISOString(),host:{cpu:os.cpus()[0]?.model,memoryBytes:os.totalmem(),platform:os.platform()},mode:'resident Metal backbone + native SSD PLE; no expert streaming, PLD or MTP',method:'Three sequential native CLI processes, identical 32-line copy task. Generation tok/s reported by the native engine excludes load and prompt prefill. This is one workload, not a general model ranking.',binarySha256:hash,argv,expected,runs:[]};
report.host.backgroundActivity=process.env.DSTUDIO_BENCH_HOST_NOTE || 'Not controlled or measured by this script';
report.modelFiles=[base,ple].map(file=>({file,bytes:fs.statSync(path.join(root,'ds4/gguf',file)).size}));
const save=()=>fs.writeFileSync(path.join(run,'results.json'),JSON.stringify(report,null,2)+'\n');
let active;
const signalChild=signal=>{if(active && active.exitCode===null && active.signalCode===null){try{process.kill(-active.pid,signal);}catch{}}};
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{report.interrupted=true;save();signalChild('SIGTERM');setTimeout(()=>{signalChild('SIGKILL');process.exit(130);},5000);});
console.log(`Evidence: ${run}`);save();
for(let repeat=1;repeat<=3;repeat++){
  let stdout='',stderr='',error=null,timedOut=false;
  const t=performance.now();
  active=spawn(path.join(engine,'ds4'),argv,{cwd:engine,detached:true,env:process.env,stdio:['ignore','pipe','pipe']});
  active.stdout.on('data',chunk=>{stdout+=chunk;});active.stderr.on('data',chunk=>{stderr+=chunk;});
  const timer=setTimeout(()=>{timedOut=true;signalChild('SIGKILL');},240000);
  const outcome=await new Promise(resolve=>{active.once('error',e=>{error=e.message;resolve({code:null});});active.once('close',(code,signal)=>resolve({code,signal}));});
  clearTimeout(timer);
  fs.writeFileSync(path.join(run,`repeat-${repeat}.stdout.txt`),stdout);fs.writeFileSync(path.join(run,`repeat-${repeat}.stderr.txt`),stderr);
  const rates=[...stderr.matchAll(/prefill: ([0-9.]+) t\/s, generation: ([0-9.]+) t\/s/g)].at(-1);
  const row={repeat,...outcome,wallSeconds:(performance.now()-t)/1000,answer:stdout,correct:false,generationTokensPerSecond:rates?Number(rates[2]):null,prefillTokensPerSecond:rates?Number(rates[1]):null,error,timedOut};
  try{assert.equal(row.code,0);assert.ok(!timedOut);assert.equal(stdout.trim(),expected);assert.ok(row.generationTokensPerSecond>0);row.correct=true;}catch(e){row.error=e.message;}
  report.runs.push(row);save();console.log(`repeat ${repeat}: ${row.correct?'PASS':'FAIL'}, generation ${row.generationTokensPerSecond??'unavailable'} tok/s, end-to-end ${row.wallSeconds.toFixed(2)}s`);
}
const valid=report.runs.filter(r=>r.correct).map(r=>r.generationTokensPerSecond).sort((a,b)=>a-b);
report.finished=new Date().toISOString();report.allCorrect=valid.length===3;
report.medianCorrectGenerationTokensPerSecond=report.allCorrect?valid[1]:null;
report.correctGenerationRange=report.allCorrect?[valid[0],valid[2]]:null;
save();console.log(JSON.stringify({allCorrect:report.allCorrect,medianTokensPerSecond:report.medianCorrectGenerationTokensPerSecond,range:report.correctGenerationRange},null,2));
process.exitCode=report.allCorrect?0:1;

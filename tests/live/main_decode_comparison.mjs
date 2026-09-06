// Real, sequential native inference. No model downloads or simulated answers.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {spawn, execFileSync} from 'node:child_process';
import {freePort, sleep, jsonFetch} from '../support/real_harness.mjs';
import {prefillMetrics, workloadSummary} from '../support/main_decode_metrics.mjs';

const [label, engineArg, commit, mode, outputArg] = process.argv.slice(2);
assert.ok(label && engineArg && /^[0-9a-f]{40}$/.test(commit || '') && outputArg,
  'Usage: node tests/live/main_decode_comparison.mjs LABEL ENGINE COMMIT ds4-ram|glm-ssd NEW_OUTPUT_DIR');
assert.ok(['ds4-ram','glm-ssd'].includes(mode));
const engine=path.resolve(engineArg), output=path.resolve(outputArg);
assert.ok(!fs.existsSync(output), 'Use a new evidence directory');
const binary=path.join(engine,'ds4-server');
const model=path.resolve('ds4/gguf',mode==='glm-ssd'?'GLM-5.3-Flash-Q2.gguf':
  'DeepSeek-V4-Flash-IQ2XXS-w2Q2K-AProjQ8-SExpQ8-OutQ8-chat-v2-imatrix-0731.gguf');
const digest=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const stat=fs.statSync(model);assert.ok(stat.size>80*1024**3);
const overrides=Object.keys(process.env).filter(k=>/^DS4_|^DS4UI_|^DSTUDIO_|^METAL_/.test(k));
assert.equal(overrides.length,0,'Run without inherited engine diagnostic overrides: '+overrides.join(', '));
const snapshot=()=>{
  try{return {sysctl:execFileSync('sysctl',['vm.swapusage','kern.memorystatus_vm_pressure_level','iogpu.wired_limit_mb'],{encoding:'utf8'}),
    vmstat:execFileSync('vm_stat',{encoding:'utf8'})};}catch(e){return {error:e.message};}
};
const csv=Array.from({length:32},(_,i)=>`item_${String(i+1).padStart(2,'0')},${(i+1)*7}`).join('\n');
const nums=[31,-8,45,0,12,12,-19,27,64,-3,81,6,18,52,-40,9,7,22,-6,99,13,35,48,-2];
const records=Array.from({length:16},(_,i)=>({id:`R${String(i+1).padStart(2,'0')}`,units:i*3+2}));
const suite=[
  {id:'csv-copy',prompt:'Copy the CSV below exactly. Return only its 32 lines, without Markdown fences, a header or commentary.\n\n'+csv,expected:csv,kind:'text'},
  {id:'numeric-sort',prompt:'Sort these numbers in ascending order, preserving duplicates. Return ONLY the JSON array, no Markdown.\n'+JSON.stringify(nums),expected:[...nums].sort((a,b)=>a-b),kind:'json'},
  {id:'record-extraction',prompt:'Extract every record below in the same order. Return ONLY a JSON array of objects with keys id (string) and units (number). No Markdown or explanation.\n'+records.map(x=>`${x.id}: units ${x.units}; shelf west.`).join('\n'),expected:records,kind:'json'},
];
const gates=[
  {id:'warmup-arithmetic',prompt:'What is 17 multiplied by 19? Reply only with the integer.',expected:'323',kind:'text'},
  {id:'code-reasoning',prompt:'In Python: x = [3, 5, 8]; print(sum(v * 2 for v in x if v % 2 == 1)). What integer is printed? Reply only with that integer.',expected:'16',kind:'text'},
  {id:'unicode',prompt:'Return exactly this text, with no explanation: città già pronta',expected:'città già pronta',kind:'text'},
];
fs.mkdirSync(output,{recursive:true});
const port=await freePort(), base=`http://127.0.0.1:${port}`;
const args=['--metal','-m',model,'--host','127.0.0.1','--port',String(port),'--ctx','8192','--tokens','1024'];
if(mode==='ds4-ram')args.push('--prefill-chunk','512'); // GLM selects its own graph chunk.
if(mode==='glm-ssd')args.push('--ssd-streaming','--ssd-streaming-cache-experts','32GB');
const report={schema:'dstudio.main-decode-comparison.v1',label,commit,mode,startedAt:new Date().toISOString(),
  host:{cpu:os.cpus()[0]?.model,memoryBytes:os.totalmem(),platform:os.platform(),release:os.release()},
  method:'Same model file, prompts, greedy sampling and 8K context. Native usage.ds4 decode timing excludes load and prompt prefill. Three distinct workloads repeated three times, after three correctness/warmup requests. Live in-memory prefix/expert reuse is allowed equally; no disk KV, PLD, MTP or DSpark. Results characterize these workloads on this machine, not general quality or numerical equivalence.',
  backgroundActivity:'Existing desktop applications left open; no user processes stopped or OS memory limits changed.',
  binary:{path:binary,sha256:digest(binary)},shaders:Object.fromEntries(fs.readdirSync(path.join(engine,'metal')).filter(f=>f.endsWith('.metal')).map(f=>[f,digest(path.join(engine,'metal',f))])),
  model:{path:model,bytes:stat.size,mtimeMs:stat.mtimeMs},args,initialMemory:snapshot(),cases:suite,gates:[],runs:[]};
const save=()=>fs.writeFileSync(path.join(output,'results.json'),JSON.stringify(report,null,2)+'\n');
save();console.log('Evidence: '+output);
const fd=fs.openSync(path.join(output,'engine.log'),'wx');
const child=spawn(binary,args,{cwd:engine,detached:true,stdio:['ignore',fd,fd]});fs.closeSync(fd);
let exited=false;
const finished=new Promise(resolve=>{
  child.once('error',e=>{exited=true;resolve({error:e.message});});
  child.once('exit',(code,signal)=>{exited=true;resolve({code,signal});});
});
async function stop(){
  if(exited)return;
  try{process.kill(-child.pid,'SIGTERM');}catch{}
  const timer=setTimeout(()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}},5000);
  await finished;clearTimeout(timer);
}
for(const sig of ['SIGINT','SIGTERM'])process.once(sig,async()=>{
  report.interrupted=true;save();await stop();process.exit(130);
});
const start=performance.now();
try {
  let models;
  while(performance.now()-start<900000){
    if(exited)throw Error('Engine exited before readiness: '+JSON.stringify(await finished));
    try{models=await jsonFetch(base,'/v1/models',{timeoutMs:2000});break;}catch{}
    await sleep(1000);
  }
  assert.ok(models?.data?.length,'Engine readiness timeout');
  report.loadSeconds=(performance.now()-start)/1000;report.models=models;save();
  console.log(`${label}/${mode}: ready in ${report.loadSeconds.toFixed(1)}s`);
  const ask=async(c,repeat,group)=>{
    const row={id:c.id,repeat,request:{model:models.data[0].id,messages:[{role:'user',content:c.prompt}],
      temperature:0,seed:42,max_tokens:1024,think:false,thinking:{type:'disabled'},stream:false}};
    const logOffset=fs.statSync(path.join(output,'engine.log')).size;
    const begin=performance.now();group.push(row);save();
    try {
      row.response=await jsonFetch(base,'/v1/chat/completions',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify(row.request),timeoutMs:600000});
      const choice=row.response.choices?.[0], usage=row.response.usage;
      row.tokens=usage.completion_tokens;
      row.decodeSeconds=usage.ds4?.decode_elapsed_seconds;
      row.tokensPerSecond=usage.ds4?.decode_tokens_per_second;
      assert.equal(choice?.finish_reason,'stop','incomplete/truncated answer');
      const answer=choice.message.content.trim();
      if(c.kind==='json')assert.deepEqual(JSON.parse(answer),c.expected);else assert.equal(answer,c.expected);
      row.correct=true;
      assert.ok(row.tokens>0 && row.decodeSeconds>0 && row.tokensPerSecond>0,'native decode timing missing');
      assert.ok(Math.abs(row.tokens/row.decodeSeconds-row.tokensPerSecond)<0.02,'native timing/count mismatch');
      row.status='pass';
    }catch(e){row.status='fail';row.error=e.message;}
    row.wallSeconds=(performance.now()-begin)/1000;
    const prefill=prefillMetrics(fs.readFileSync(path.join(output,'engine.log')).subarray(logOffset).toString());
    if(prefill){row.prefillTokens=prefill.tokens;row.prefillSeconds=prefill.seconds;row.prefillTokensPerSecond=prefill.tokensPerSecond;}
    save();
    console.log(`${label}/${mode} ${c.id} #${repeat}: ${row.status}, ${row.tokensPerSecond??'n/a'} tok/s`);
    if(exited)throw Error('Engine exited during benchmark');
  };
  for(const c of gates)await ask(c,0,report.gates);
  for(let repeat=1;repeat<=3;repeat++)for(const c of suite)await ask(c,repeat,report.runs);
  report.allCorrect=[...report.gates,...report.runs].every(r=>r.status==='pass');
  // Auxiliary instruction checks stay visible and control the overall exit
  // status. A throughput row is qualified only by its own three exact answers;
  // it never turns a failed auxiliary check into a passing correctness suite.
  report.performanceWorkloadsCorrect=report.runs.every(r=>r.status==='pass');
  report.summary=Object.fromEntries(suite.map(c=>{
    return [c.id,workloadSummary(report.runs.filter(r=>r.id===c.id))];
  }));
}catch(e){report.error=e.message;report.allCorrect=false;console.error(e.message);}
finally {
  report.finalMemory=snapshot();await stop();report.process=await finished;
  if(report.process.code!==0 || report.process.signal){report.shutdownFailed=true;report.allCorrect=false;}
  report.finishedAt=new Date().toISOString();save();
}
console.log(JSON.stringify(report.summary||{error:report.error},null,2));
process.exitCode=report.allCorrect?0:1;

// Explicit, sequential live development checks. Actual Qwen weights and native
// DStudio Agent/Cowork tools, not held-out quality or desktop qualification.
// --qwen35 uses the existing Qwen3.6 fork without Qwen3.8's PLE or power flags.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn, spawnSync} from 'node:child_process';
import {artifactRunDir, writeArtifact} from '../support/real_harness.mjs';
import {ownGitRevision} from '../support/quality_baseline.mjs';
import {verifyQwen38ToolTrace} from '../support/qwen38_tool_oracle.mjs';

const root = path.resolve(import.meta.dirname, '../..');
assert.equal(process.platform,'darwin','This live runner currently qualifies Metal only');
const qwen35=process.argv.includes('--qwen35');
const inputs=process.argv.slice(2).filter(arg=>arg!=='--qwen35');
assert.equal(inputs.length,qwen35?2:3,'Supply candidate + model GGUF (+ PLE GGUF for Qwen3.8), optionally --qwen35');
const [engine,model,ple] = inputs.map(file=>fs.realpathSync(file));
const host = path.join(root,'tests/.build/agent-build-probe');
const run = artifactRunDir(qwen35?'qwen35-agent-live':'qwen38-agent-live');
const hash = data=>crypto.createHash('sha256').update(data).digest('hex');
const identity = file=>{
  const st=fs.statSync(file);
  return {path:file,bytes:st.size,mtimeMs:st.mtimeMs,ino:st.ino,dev:st.dev};
};
const report = {started:new Date().toISOString(), scope:'Two live development tool workflows; not held-out quality or host/UI admission',
  revision:ownGitRevision(engine), engine, family:qwen35?'Qwen3.6-35B-A3B':'Qwen3.8-Flash-Next',
  engineSource:Object.fromEntries(['ds4_agent.c','ds4.c','ds4.h'].map(file=>[file,hash(fs.readFileSync(path.join(engine,file)))])),
  weights:[identity(model),...(ple?[identity(ple)]:[])],
  host:{path:host,sha256:hash(fs.readFileSync(host))},
  memory:qwen35?'resident model weights; no PLE or expert streaming, MTP or DSpark':
    'resident backbone plus native SSD-backed PLE; no expert streaming, MTP or DSpark',
  settings:{backend:'Metal',context:16384,prefillChunk:512,maxTokensPerModelRound:1024,temperature:0,seed:42,
    thinking:'off',maxToolCalls:12,timeoutSecondsPerWorkflow:600,streamLimitBytes:3*1024*1024},
  cases:[],passed:false};
const save=()=>writeArtifact(run,'results.json',report);
const rows=[{id:15,state:'ready',minutes:12},{id:9,state:'queued',minutes:999},
  {id:4,state:'ready',minutes:7},{id:11,state:'ready',minutes:5},{id:18,state:'cancelled',minutes:70}];
const source=JSON.stringify(rows,null,2)+'\n';
const expected={ids:rows.filter(row=>row.state==='ready').map(row=>row.id).sort((a,b)=>a-b),
  totalMinutes:rows.filter(row=>row.state==='ready').reduce((sum,row)=>sum+row.minutes,0)};
// Prevent overlap with an existing inference engine. Do not terminate it, change
// app settings, or reuse its cache just to obtain a passing local test.
function noExistingEngine(){
 const result=spawnSync('ps',['-axo','pid=,comm='],{encoding:'utf8',timeout:5000});
 assert.equal(result.status,0,result.stderr);
 const active=result.stdout.split('\n').filter(line=>/\/(?:ds4(?:[-_](?:server|agent|cowork|design|native|cpu|pld|jsonl))+|ds4)$/.test(line.trim()));
 assert.equal(active.length,0,`Existing engine(s) must be handled separately, not by this runner: ${active.join('\n')}`);
}
const cleanEnv=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/^DS4(?:UI)?_|^DSTUDIO_/.test(key)));
async function execute(row,binary,args,env){
 const streams={stdout:'',stderr:''},fds={stdout:fs.openSync(path.join(row.directory,'stdout.log'),'wx'),
  stderr:fs.openSync(path.join(row.directory,'stderr.log'),'wx')};
 const start=performance.now();let failure,bytes=0,tail='',killTimer;
 const child=spawn(host,[root,engine,qwen35?'metal-sources':'metal-env-qwen38',binary,...args],
  {cwd:row.workspace,detached:true,stdio:['ignore','pipe','pipe'],env:{...cleanEnv,...env}});
 row.pid=child.pid;save();
 const stop=reason=>{
  if(failure)return;
  failure=reason;
  try{process.kill(-child.pid,'SIGTERM');}catch{}
  killTimer=setTimeout(()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}},3000);
 };
 const timer=setTimeout(()=>stop('workflow deadline exceeded'),report.settings.timeoutSecondsPerWorkflow*1000);
 let lastPhase='';
 for(const name of ['stdout','stderr'])child[name].on('data',chunk=>{
  bytes+=chunk.length;
  if(bytes>report.settings.streamLimitBytes){stop('stream byte limit exceeded');return;}
  fs.writeSync(fds[name],chunk);streams[name]+=chunk;
  if(name!=='stdout')return;
  tail+=chunk;const lines=tail.split('\n');tail=lines.pop();
  for(const line of lines){
   const index=line.indexOf('\x1e');if(index<0)continue;
   try{
    const event=JSON.parse(line.slice(index+1));row.events.push(event);
    if(event.type==='tool_call'){
     console.log(`${row.mode}: real tool ${event.name}`);
     if(row.events.filter(e=>e.type==='tool_call').length>report.settings.maxToolCalls)stop('tool call budget exceeded');
    }
    if(event.type==='status'&&event.state!==lastPhase){lastPhase=event.state;console.log(`${row.mode}: ${lastPhase}`);}
   }catch(e){stop(`invalid JSONL event: ${e.message}`);}
  }
 });
 const result=await new Promise(resolve=>{
  child.once('error',e=>resolve({error:String(e)}));child.once('close',(code,signal)=>resolve({code,signal}));
 });
 clearTimeout(timer);clearTimeout(killTimer);Object.values(fds).forEach(fd=>fs.closeSync(fd));
 Object.assign(row,{...result,failure,seconds:(performance.now()-start)/1000,streamBytes:bytes});save();
 assert(!failure&&!result.error&&result.code===0&&!result.signal,`${row.mode} process failed: ${failure||JSON.stringify(result)}`);
 assert(!streams.stderr.includes('not found (set DS4_METAL_'),'Shader discovery regressed');
 return streams;
}
try{
 for(const mode of ['agent','cowork']){
  const directory=path.join(run,mode),workspace=path.join(directory,'workspace with spaces');
  fs.mkdirSync(workspace,{recursive:true});
  fs.writeFileSync(path.join(workspace,'tasks.json'),source,{flag:'wx'});
  const output=mode==='agent'?'ready.json':'dispatch.md';
  const prompt=mode==='agent'
   ? 'Read tasks.json in this workspace. Create ready.json as a JSON object with exactly two fields: ids (numeric IDs of the ready items, sorted ascending) and totalMinutes (sum of minutes for ready items only). Derive values from the file; do not change tasks.json. Use read and write/edit file tools, not bash or network. Reopen ready.json with a tool to verify it, then give a brief final summary.'
   : 'Read tasks.json using read_document. Create dispatch.md using write_document. Its content must have exactly two lines: "Ready: " followed by the numeric IDs of ready items sorted ascending, separated by comma and space; and "Minutes: " followed by their total minutes. Derive values from the file; do not change tasks.json. Reopen dispatch.md using read_document to verify it, then give a brief final summary. Do not use shell or network.';
  const binary=path.join(engine,mode==='agent'?'ds4-agent-jsonl':'ds4-cowork');
  const args=['--non-interactive','--jsonl','--metal','-m',model,...(ple?['--ple',ple]:[]),'-c','16384','-n','1024',
   '--temp','0','--seed','42','--nothink','--prefill-chunk','512','--chdir',workspace,'-p',prompt];
  if(mode==='cowork')args.push('-sys',fs.readFileSync(path.join(root,'extension/cowork/COWORK.md'),'utf8'));
  const row={mode,directory,workspace,prompt,binary:{path:binary,sha256:hash(fs.readFileSync(binary))},
   args,events:[],passed:false};report.cases.push(row);save();
  try{
   noExistingEngine();
   await execute(row,binary,args,{DS4UI_RUNTIME_NAME:mode,DS4UI_COWORK_HELPER:path.join(root,'extension/cowork/office_tool.py'),
    DS4UI_SESSION_CACHE_DIR:path.join(directory,'private-kv-cache')});
   const file=path.join(workspace,output),st=fs.lstatSync(file);
   assert(st.isFile()&&!st.isSymbolicLink()&&st.size<65536,'Output must be a bounded regular file');
   const actual=fs.readFileSync(file,'utf8');
   if(mode==='agent')assert.deepEqual(JSON.parse(actual),expected);
   else assert.equal(actual.trim(),`Ready: ${expected.ids.join(', ')}\nMinutes: ${expected.totalMinutes}`);
   assert.equal(fs.readFileSync(path.join(workspace,'tasks.json'),'utf8'),source,'Source modified');
   assert.deepEqual(fs.readdirSync(workspace).sort(),['tasks.json',output].sort(),'Unexpected workspace files');
   row.toolChecks=verifyQwen38ToolTrace(mode,row.events,output);
   if(qwen35)assert(!fs.existsSync(path.join(directory,'private-kv-cache')),
     'Qwen3.6 must not create incomplete recurrent disk checkpoints');
   row.artifact={path:output,bytes:st.size,sha256:hash(actual)};
   row.passed=true;
  }catch(e){row.error=String(e.stack);console.error(row.error);}
  save();console.log(`${mode}: ${row.passed?'PASS':'FAIL'} (${row.seconds?.toFixed(2)||'?'} s)`);
 }
 assert.deepEqual([identity(model),...(ple?[identity(ple)]:[])],report.weights,'Weight identity changed during the run');
 report.passed=report.cases.length===2&&report.cases.every(row=>row.passed);
}catch(e){report.error=String(e.stack);console.error(report.error);}
finally{report.finished=new Date().toISOString();save();console.log(`Preserved real Qwen tool evidence: ${run}`);}
if(!report.passed)process.exitCode=1;

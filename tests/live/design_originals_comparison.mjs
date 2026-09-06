// Native agent with real local weights. Each process owns its workspace.
// Before/after are separate explicit invocations; no synthetic model responses.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import {StringDecoder} from 'node:string_decoder';
import {spawn,execFileSync} from 'node:child_process';
import {once} from 'node:events';
import assert from 'node:assert/strict';

const [label,binaryArg,engineArg,extensionArg,outputArg,sourceArg] = process.argv.slice(2);
assert.ok(label && binaryArg && engineArg && extensionArg && outputArg,
  'Usage: node tests/live/design_originals_comparison.mjs LABEL BINARY ENGINE_DIR EXTENSION_DIR OUTPUT_DIR [DESIGN_SOURCE]');
const binary=path.resolve(binaryArg), engine=path.resolve(engineArg), packs=path.resolve(extensionArg);
const output=path.resolve(outputArg);
assert.ok(!fs.existsSync(output),'Use a new output directory; never replace prior evidence');
fs.mkdirSync(output,{recursive:true});
// Freeze the executable and local design inputs once. Rebuilding or refining
// the working tree during a long run must not silently change later cases.
const capturedBinary=path.join(output,'native-design');
fs.copyFileSync(binary,capturedBinary);fs.chmodSync(capturedBinary,0o700);
const capturedPacks=path.join(output,'inputs');fs.mkdirSync(capturedPacks);
for(const folder of ['design-systems','craft'])
  fs.cpSync(path.join(packs,folder),path.join(capturedPacks,folder),{recursive:true});
const suite=JSON.parse(fs.readFileSync('tests/fixtures/design_agent_originals.json','utf8'));
const selected=process.env.DESIGN_COMPARE_CASES?.split(',');
if(selected)assert.ok(selected.every(id=>suite.cases.some(c=>c.id===id)),'Unknown case requested');
const cases=selected?suite.cases.filter(c=>selected.includes(c.id)):suite.cases;
assert.ok(cases.length);
const model=path.resolve('ds4/gguf/DeepSeek-V4-Flash-IQ2XXS-w2Q2K-AProjQ8-SExpQ8-OutQ8-chat-v2-imatrix-0731.gguf');
const stat=fs.statSync(model);
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const source=path.resolve(sourceArg||'extension/design/ds4_design.c');
const capturedSource=path.join(capturedPacks,'ds4_design.c');
fs.copyFileSync(source,capturedSource);
const startupTimeout=Number(process.env.DESIGN_COMPARE_STARTUP_TIMEOUT_MS||900000);
const turnTimeout=Number(process.env.DESIGN_COMPARE_TIMEOUT_MS||1800000);
assert.ok(startupTimeout>0 && Number.isFinite(startupTimeout) && turnTimeout>0 && Number.isFinite(turnTimeout));
let engineIdentity;
if(fs.existsSync(path.join(engine,'.git'))){
  assert.equal(fs.realpathSync(execFileSync('git',['-C',engine,'rev-parse','--show-toplevel'],{encoding:'utf8'}).trim()),fs.realpathSync(engine));
  engineIdentity={commit:execFileSync('git',['-C',engine,'rev-parse','HEAD'],{encoding:'utf8'}).trim()};
}else engineIdentity=JSON.parse(fs.readFileSync(path.join(engine,'.dstudio-source.json'),'utf8'));
const catalog=fs.readdirSync(path.join(capturedPacks,'design-systems')).sort().flatMap(id=>{
  const file=path.join(capturedPacks,'design-systems',id,'DESIGN.md');
  if(!fs.existsSync(file))return [];
  const text=fs.readFileSync(file,'utf8');
  return ['- '+id+': '+(text.match(/^description:\s*(.+)$/m)?.[1] || id)];
}).join('\n');
const system='Use only local project files and the supplied local packs. No network or media generation. '
  +'The brief is complete and explicitly requests direct building; do not ask discovery questions. '
  +'This is a working offline prototype with illustrative content, not a real service. '
  +'Available design systems:\n'+catalog
  +'\nAvailable craft: accessibility, layout-responsive, state-coverage, typography, color, motion, anti-slop.\n';
const report={label,scope:'Real native agent; quality is assessed independently, not by model self-ratings.',
  binary,capturedBinary,capturedPacks,caseCount:cases.length,
  binarySha256:sha(fs.readFileSync(capturedBinary)),engine,
  engineIdentity,engineSourceSha256:Object.fromEntries(['ds4.c','ds4.h','ds4_metal.m'].map(f=>[f,sha(fs.readFileSync(path.join(engine,f)))])),
  designSource:{path:source,capturedPath:capturedSource,sha256:sha(fs.readFileSync(capturedSource))},host:{cpu:os.cpus()[0]?.model,memoryBytes:os.totalmem()},
  model:{path:model,bytes:stat.size,mtimeMs:stat.mtimeMs},memory:'Resident DeepSeek V4 Flash Chat IQ2XXS, SSD expert streaming off',
  startupTimeoutMs:startupTimeout,turnTimeoutMs:turnTimeout,
  inference:{context:32768,thinkTokens:1536,maxTokensPerRound:8192,seed:20260905,temperature:0.4},
  cases:[]};
const save=()=>fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));
fs.writeFileSync(path.join(output,'system.txt'),system);
fs.copyFileSync('tests/fixtures/design_agent_originals.json',path.join(output,'frozen-cases.json'));
let active,activeReceipt,interrupted=false;
async function stop(child){
  if(!child || child.exitCode!==null || child.signalCode)return;
  const exited=once(child,'exit');
  try{process.kill(-child.pid,'SIGTERM');}catch{}
  const timer=setTimeout(()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}},5000);
  await exited;clearTimeout(timer);
}
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,async()=>{
  interrupted=true;report.interrupted=true;
  if(activeReceipt)activeReceipt.status='interrupted';
  save();await stop(active);process.exit(130);
});
try {
  for(const c of cases) {
    if(interrupted)break;
    const dir=path.join(output,c.id);fs.mkdirSync(dir);
    const workspace=path.join(dir,'workspace');fs.mkdirSync(workspace);
    const stdout=fs.createWriteStream(path.join(dir,'stdout.txt'),{flags:'wx'});
    const stderr=fs.createWriteStream(path.join(dir,'stderr.txt'),{flags:'wx'});
    const receipt={id:c.id,prompt:c.prompt,entry:c.entry,status:'running',tools:[],startedAt:new Date().toISOString()};
    activeReceipt=receipt;
    report.cases.push(receipt);save();
    const args=['--metal','-m',model,'-c','32768','-n','8192','--think','--think-tokens','1536',
      '--temp','0.4','--seed','20260905','--workspace',workspace,'--jsonl','-sys',system];
    fs.writeFileSync(path.join(dir,'launch.json'),JSON.stringify({binary:capturedBinary,args,packs:capturedPacks},null,2));
    const t=performance.now();
    const child=spawn(capturedBinary,args,{cwd:engine,env:{...process.env,DS4UI_SKILLS_DIR:capturedPacks,
      DS4UI_USER_SKILLS_DIR:path.join(dir,'user-skills'),DSTUDIO_DESIGN_CACHE_DIR:path.join(output,'system-cache')},
      detached:true,stdio:['pipe','pipe','pipe']});active=child;
    const outDecoder=new StringDecoder('utf8'),errDecoder=new StringDecoder('utf8');
    let sent=false,tail='',outTail='',settle;
    const done=new Promise(resolve=>settle=resolve);
    let timer=setTimeout(()=>settle('startup-timeout'),startupTimeout);
    child.once('error',e=>{receipt.error=e.message;settle('process-error');});
    child.once('exit',(code,signal)=>{receipt.exitCode=code;receipt.signal=signal;settle('exited');});
    child.stdout.on('data',chunk=>{
      stdout.write(chunk);outTail+=outDecoder.write(chunk);
      const lines=outTail.split('\n');outTail=lines.pop();
      for(const line of lines){
        const i=line.indexOf('\x1e');if(i<0)continue;
        try{const e=JSON.parse(line.slice(i+1));
          if(e.type==='tool_call'){receipt.tools.push(e.name);console.log(label+'/'+c.id+': '+e.name);save();}
          if(e.type==='artifact'){receipt.artifact=e;save();}
          if(e.type==='generation_limit_continue'){
            (receipt.generationContinuations??=[]).push(e);save();
          }
          if(e.type==='generation_limit_terminal'){receipt.generationLimitReached=true;save();}
        }catch{}
      }
    });
    child.stderr.on('data',chunk=>{
      stderr.write(chunk);tail+=errDecoder.write(chunk);
      let i;
      while((i=tail.indexOf('+DWARFSTAR_WAITING'))>=0){
        tail=tail.slice(i+'+DWARFSTAR_WAITING'.length);
        if(!sent){
          sent=true;receipt.readyMs=performance.now()-t;
          clearTimeout(timer);timer=setTimeout(()=>settle('turn-timeout'),turnTimeout);
          child.stdin.write(c.prompt+'\n');save();console.log(label+'/'+c.id+': model ready, brief submitted');
        }
        else settle('idle');
      }
      if(tail.length>10000)tail=tail.slice(-10000);
    });
    const outcome=await done;clearTimeout(timer);
    receipt.ms=performance.now()-t;receipt.status=outcome;
    receipt.entryExists=fs.existsSync(path.join(workspace,c.entry));
    if(receipt.entryExists)receipt.entrySha256=sha(fs.readFileSync(path.join(workspace,c.entry)));
    await stop(child);active=null;
    await Promise.all([new Promise(r=>stdout.end(r)),new Promise(r=>stderr.end(r))]);save();
    console.log(label+'/'+c.id+': '+outcome+', artifact='+Boolean(receipt.artifact)+', '+Math.round(receipt.ms/1000)+'s');
  }
} finally {await stop(active);save();}
console.log('Evidence: '+output);
if(report.cases.some(c=>c.status!=='idle'||!c.artifact||c.generationLimitReached))process.exitCode=1;

// Native agent with real local weights. Each process owns its workspace.
// Before/after are separate explicit invocations; no synthetic model responses.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {validateDesignProjects, observeSelectedDesignPack} from '../support/design_project_cases.mjs';
import {runDesignGeneration, designGenerationLimits} from '../support/design_generation_process.mjs';

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
const suiteFile=path.resolve(process.env.DESIGN_COMPARE_SUITE || 'tests/fixtures/design_agent_originals.json');
const suiteBytes=fs.readFileSync(suiteFile),suite=JSON.parse(suiteBytes);
const allCases=suite.schema==='dstudio.design-projects.v1'?validateDesignProjects(suite):suite.cases;
const selected=process.env.DESIGN_COMPARE_CASES?.split(',');
if(selected)assert.ok(selected.every(id=>allCases.some(c=>c.id===id)),'Unknown case requested');
const cases=selected?allCases.filter(c=>selected.includes(c.id)):allCases;
assert.ok(cases.length);
const model=path.resolve(process.env.DESIGN_COMPARE_MODEL || 'ds4/gguf/DeepSeek-V4-Flash-IQ2XXS-w2Q2K-AProjQ8-SExpQ8-OutQ8-chat-v2-imatrix-0731.gguf');
const stat=fs.statSync(model);
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const modelDigest=crypto.createHash('sha256');
for await(const chunk of fs.createReadStream(model,{highWaterMark:8*1024*1024}))modelDigest.update(chunk);
const modelAfter=fs.statSync(model);
for(const key of ['dev','ino','size','mtimeMs','ctimeMs'])assert.equal(modelAfter[key],stat[key],'Selected model changed while hashing');
const source=path.resolve(sourceArg||'extension/design/ds4_design.c');
const capturedSource=path.join(capturedPacks,'ds4_design.c');
fs.copyFileSync(source,capturedSource);
const startupTimeout=Number(process.env.DESIGN_COMPARE_STARTUP_TIMEOUT_MS||900000);
const turnTimeout=Number(process.env.DESIGN_COMPARE_TIMEOUT_MS||1800000);
assert.ok(Number.isSafeInteger(startupTimeout) && startupTimeout>0 && startupTimeout<=designGenerationLimits.startupMs
  && Number.isSafeInteger(turnTimeout) && turnTimeout>0 && turnTimeout<=designGenerationLimits.turnMs,
  'Explicit deadlines may tighten, not exceed, the frozen benchmark limits');
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
  harness:Object.fromEntries(['../live/design_originals_comparison.mjs','design_generation_process.mjs','design_project_cases.mjs']
    .map(file=>{const resolved=path.resolve(import.meta.dirname,'../support',file);
      const captured=path.join(capturedPacks,path.basename(file));fs.copyFileSync(resolved,captured);
      return [path.basename(file),{capturedPath:captured,sha256:sha(fs.readFileSync(captured))}];})),
  suite:{path:suiteFile,sha256:sha(suiteBytes),planned:allCases.length,selected:cases.map(c=>c.id)},
  model:{path:model,bytes:stat.size,mtimeMs:stat.mtimeMs,sha256:modelDigest.digest('hex')},memory:'Resident selected model, SSD expert streaming off; no model fallback',
  startupTimeoutMs:startupTimeout,turnTimeoutMs:turnTimeout,
  captureLimits:{...designGenerationLimits,startupMs:startupTimeout,turnMs:turnTimeout},
  inference:{context:32768,thinkTokens:1536,maxTokensPerRound:8192,seed:20260905,temperature:0.4},
  cases:[]};
const save=()=>fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));
fs.writeFileSync(path.join(output,'system.txt'),system);
fs.writeFileSync(path.join(output,'frozen-cases.json'),suiteBytes,{flag:'wx'});
let interrupted=false;
const controller=new AbortController();
const interrupt=()=>{
  interrupted=true;report.interrupted=true;
  controller.abort();
};
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,interrupt);
try {
  for(const c of cases) {
    if(interrupted)break;
    const dir=path.join(output,c.id);fs.mkdirSync(dir);
    const workspace=path.join(dir,'workspace');fs.mkdirSync(workspace);
    const expectedPack=c.designSystemId?fs.readFileSync(path.join(capturedPacks,'design-systems',c.designSystemId,'DESIGN.md'),'utf8'):null;
    if(expectedPack!==null)assert.ok(Buffer.byteLength(expectedPack)>0 && Buffer.byteLength(expectedPack)<=24*1024,'Selected pack must fit the native complete-file contract');
    const receipt={id:c.id,prompt:c.prompt,entry:c.entry,designSystemId:c.designSystemId,
      designSystemLoaded:c.designSystemId?false:undefined,qualityStatus:'not_reviewed',status:'running',tools:[],startedAt:new Date().toISOString()};
    report.cases.push(receipt);save();
    const args=['--metal','-m',model,'-c','32768','-n','8192','--think','--think-tokens','1536',
      '--temp','0.4','--seed','20260905','--workspace',workspace,'--jsonl','-sys',system];
    fs.writeFileSync(path.join(dir,'launch.json'),JSON.stringify({binary:capturedBinary,args,packs:capturedPacks},null,2));
    const captureStarted=performance.now();
    try {
      receipt.capture=await runDesignGeneration({binary:capturedBinary,args,cwd:engine,directory:dir,
        env:{...process.env,DS4UI_SKILLS_DIR:capturedPacks,DS4UI_USER_SKILLS_DIR:path.join(dir,'user-skills'),
          DSTUDIO_DESIGN_CACHE_DIR:path.join(output,'system-cache')},prompt:c.prompt,signal:controller.signal,
        limits:{startupMs:startupTimeout,turnMs:turnTimeout},
        onReady:ms=>{receipt.readyMs=ms;save();console.log(label+'/'+c.id+': model ready, brief submitted');},
        onEvent:e=>{
          if(expectedPack!==null)observeSelectedDesignPack(receipt,e,expectedPack);
          if(e.type==='tool_call'){
            assert.ok(typeof e.name==='string' && e.name.length>0 && e.name.length<=128,'Invalid tool identity');
            receipt.tools.push(e.name);console.log(label+'/'+c.id+': '+e.name);
          }
          if(e.type==='artifact')receipt.artifact=e;
          if(e.type==='generation_limit_continue'){
            (receipt.generationContinuations??=[]).push(e);
          }
          if(e.type==='generation_limit_terminal')receipt.generationLimitReached=true;
        }});
      for(const key of ['ms','status','exitCode','signal'])receipt[key]=receipt.capture[key];
    } catch(error) {receipt.status='capture-error';receipt.ms=performance.now()-captureStarted;receipt.error=String(error);}
    // All capture and process teardown has finished, including late stdout
    // delivered after the stderr idle marker. Only now evaluate the saved file.
    try {
      assert.ok(receipt.capture?.cleanupComplete,'Cannot inspect a still-running workspace');
      const entry=path.join(workspace,c.entry),info=fs.lstatSync(entry);receipt.entryExists=true;
      receipt.entryIsRegular=info.isFile()&&!info.isSymbolicLink()
        && fs.realpathSync(entry).startsWith(fs.realpathSync(workspace)+path.sep);
      assert.ok(receipt.entryIsRegular,'Generated entry must be a confined regular file');
      assert.ok(info.size<=32*1024*1024,'Generated entry exceeds the 32 MiB export limit');
      const fd=fs.openSync(entry,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
      try {
        const data=Buffer.alloc(info.size);
        for(let offset=0;offset<data.length;){
          const n=fs.readSync(fd,data,offset,data.length-offset,offset);
          assert.ok(n>0,'Generated entry ended before its recorded size');offset+=n;
        }
        for(const current of [fs.fstatSync(fd),fs.lstatSync(entry)])
          for(const key of ['dev','ino','size','mtimeMs','ctimeMs'])assert.equal(current[key],info[key],'Generated entry changed while hashing');
        receipt.entrySha256=sha(data);
      } finally {fs.closeSync(fd);}
    } catch(error) {
      if(error.code==='ENOENT')receipt.entryExists=false;
      receipt.entryError=String(error);
    }
    receipt.generationPassed=receipt.status==='idle' && receipt.capture?.cleanupComplete===true
      && receipt.exitCode===0 && !receipt.signal
      && receipt.capture.promptSubmitted && receipt.artifact?.entry===c.entry && receipt.entryIsRegular===true
      && Boolean(receipt.entrySha256) && !receipt.entryError
      && !receipt.generationLimitReached && (!c.designSystemId || receipt.designSystemLoaded===true);
    save();
    console.log(label+'/'+c.id+': '+receipt.status+', artifact='+Boolean(receipt.artifact)+', '+Math.round(receipt.ms/1000)+'s');
    if(!receipt.capture?.cleanupComplete)break; // Never overlap an unreaped model with the next case.
  }
} finally {
  for(const signal of ['SIGINT','SIGTERM'])process.removeListener(signal,interrupt);
  for(const c of cases)if(!report.cases.some(r=>r.id===c.id))report.cases.push({id:c.id,prompt:c.prompt,
    entry:c.entry,designSystemId:c.designSystemId,status:'not-run',
    generationPassed:false,reason:interrupted?'Campaign interrupted':'Earlier capture/cleanup did not complete'});
  save();
}
console.log('Evidence: '+output);
if(interrupted)process.exitCode=130;
else if(report.cases.length!==cases.length || report.cases.some(c=>!c.generationPassed))process.exitCode=1;

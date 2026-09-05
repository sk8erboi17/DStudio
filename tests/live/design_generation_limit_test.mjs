// Deliberate truncation with actual DS4 weights. This tests the local engine's
// termination/retry boundary, not the quality of the deliberately cut answer.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import {spawn,execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const engine=path.join(root,'ds4');
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
let binary=path.join(engine,'ds4-design'),source=path.join(root,'extension/design/ds4_design.c'),capturedReceipt;
if(process.argv[2]) {
  const captured=path.resolve(process.argv[2]);
  const original=JSON.parse(fs.readFileSync(path.join(captured,'report.json')));
  capturedReceipt=original;
  binary=original.capturedBinary??original.binary;
  const local=path.join(captured,'inputs/ds4_design.c');
  source=original.designSource.capturedPath??(fs.existsSync(local)?local:original.designSource.path);
  assert.equal(sha(fs.readFileSync(binary)),original.binarySha256,'Captured executable changed');
  assert.equal(sha(fs.readFileSync(source)),original.designSource.sha256,'Captured source changed');
}
const model=path.join(engine,'gguf/DeepSeek-V4-Flash-IQ2XXS-w2Q2K-AProjQ8-SExpQ8-OutQ8-chat-v2-imatrix-0731.gguf');
const modelStat=fs.statSync(model);
const modelIdentity={path:model,bytes:modelStat.size,mtimeMs:modelStat.mtimeMs};
let engineIdentity;
if(fs.existsSync(path.join(engine,'.git'))) {
  assert.equal(fs.realpathSync(execFileSync('git',['-C',engine,'rev-parse','--show-toplevel'],{encoding:'utf8'}).trim()),fs.realpathSync(engine));
  engineIdentity={commit:execFileSync('git',['-C',engine,'rev-parse','HEAD'],{encoding:'utf8'}).trim()};
} else engineIdentity=JSON.parse(fs.readFileSync(path.join(engine,'.dstudio-source.json')));
const engineSourceSha256=Object.fromEntries(['ds4.c','ds4.h','ds4_metal.m'].map(f=>[f,sha(fs.readFileSync(path.join(engine,f)))]));
if(capturedReceipt) {
  assert.deepEqual(engineIdentity,capturedReceipt.engineIdentity,'Different engine revision');
  assert.deepEqual(engineSourceSha256,capturedReceipt.engineSourceSha256,'Different engine/shader sources');
  assert.deepEqual(modelIdentity,capturedReceipt.model,'Different model identity');
}
fs.mkdirSync(path.join(root,'tests/.artifacts'),{recursive:true});
const output=fs.mkdtempSync(path.join(root,'tests/.artifacts/design-generation-limit-live-'));
const workspace=path.join(output,'workspace');fs.mkdirSync(workspace);
const sentinel='Previously saved project content.\n';
fs.writeFileSync(path.join(workspace,'keep.txt'),sentinel);
const capturedBinary=path.join(output,'native-design');
fs.copyFileSync(binary,capturedBinary);fs.chmodSync(capturedBinary,0o700);
fs.copyFileSync(source,path.join(output,'ds4_design.c'));
const prompt='Advice only: explain in prose how you would choose a readable type scale for a long article. Do not use tools, create files, or ask questions.';
const args=['--metal','-m',model,'-c','32768','-n','1','--think','--think-tokens','1536',
  '--temp','0','--seed','20260905','--workspace',workspace,'--jsonl'];
const report={scope:'Real model, one-token round bound deliberately prevents a finished answer. Runtime recovery/termination test, not a model-quality or speed benchmark.',
  startedAt:new Date().toISOString(),host:{cpu:os.cpus()[0]?.model,memoryBytes:os.totalmem()},
  binarySha256:sha(fs.readFileSync(capturedBinary)),designSourceSha256:sha(fs.readFileSync(source)),
  engineIdentity,engineSourceSha256,model:modelIdentity,
  memory:'Resident weights, expert SSD streaming off',args,prompt,continuations:[],terminal:[],tools:[]};
const started=performance.now();
const child=spawn(capturedBinary,args,{cwd:engine,detached:true,
  env:{...process.env,DSTUDIO_DESIGN_CACHE_DIR:path.join(output,'cache')},stdio:['pipe','pipe','pipe']});
let out='',err='',tail='',sent=false,done=false,failure,killTimer;
const stop=error=>{
  failure??=error;
  if(child.exitCode!==null||child.signalCode)return;
  try{process.kill(-child.pid,'SIGTERM');}catch{}
  killTimer??=setTimeout(()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}},5000);
};
const exited=new Promise(resolve=>{
  child.once('error',e=>{failure=e;resolve({error:e.message});});
  child.once('close',(code,signal)=>resolve({code,signal}));
});
const timer=setTimeout(()=>stop(Error('Live truncation test exceeded four minutes')),240000);
const onInterrupt=()=>stop(Error('Live truncation test interrupted'));
process.once('SIGINT',onInterrupt);process.once('SIGTERM',onInterrupt);
child.stdin.on('error',e=>{if(!done)stop(e);});
child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
child.stdout.on('data',chunk=>{
  out+=chunk;tail+=chunk;
  const lines=tail.split('\n');tail=lines.pop();
  for(const line of lines) {
    const marker=line.indexOf('\x1e');if(marker<0)continue;
    try {
      const event=JSON.parse(line.slice(marker+1));
      if(event.type==='generation_limit_continue')report.continuations.push(event);
      if(event.type==='generation_limit_terminal')report.terminal.push(event);
      if(event.type==='tool_call')report.tools.push(event.name);
    } catch(e){stop(e);}
  }
});
child.stderr.on('data',chunk=>{
  err+=chunk;
  const waits=(err.match(/\+DWARFSTAR_WAITING/g)||[]).length;
  if(waits && !sent) {
    sent=true;report.readyMs=performance.now()-started;child.stdin.write(prompt+'\n');
  } else if(waits>=2 && !done) {done=true;child.stdin.end();}
});
try {
  report.process=await exited;
  if(failure)throw failure;
  assert.deepEqual(report.process,{code:0,signal:null});
  assert.ok(done,'Native loop did not return to waiting for user input');
  assert.deepEqual(report.continuations.map(e=>e.attempt),[1,2,3]);
  assert.ok(report.continuations.every(e=>e.max===3));
  assert.equal(report.terminal.length,1);
  assert.equal(report.terminal[0].attempt,3);
  assert.deepEqual(report.tools,[],'Deliberately cut advice must not execute tools');
  const events=fs.readFileSync(path.join(workspace,'.ds4-design/history.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  report.runStatus=events.filter(e=>e.type==='run_done').at(-1)?.payload?.status;
  assert.equal(report.runStatus,'generation_limit','Truncated response was recorded as successful');
  assert.equal(fs.readFileSync(path.join(workspace,'keep.txt'),'utf8'),sentinel);
  // Returning to idle persists the native workspace summary even when the
  // model calls no tools. This is runtime metadata, not a generated artifact.
  report.workspaceFiles=fs.readdirSync(workspace).filter(f=>!f.startsWith('.')).sort();
  assert.deepEqual(report.workspaceFiles,['MEMORY.MD','keep.txt']);
  const memory=fs.readFileSync(path.join(workspace,'MEMORY.MD'),'utf8');
  assert.match(memory,/^- Phase: idle$/m);
  assert.match(memory,/^- Current artifact: \(none\)$/m);
  assert.match(memory,/^- Open todos: no$/m);
  report.pass=true;
  console.log('design_generation_limit_test: PASS (real weights, three bounded continuations, honest incomplete status, prior file preserved)');
} catch(e) {
  report.pass=false;report.error=e.message;process.exitCode=1;
  console.error('design_generation_limit_test: FAIL: '+e.message);
} finally {
  clearTimeout(timer);clearTimeout(killTimer);
  process.removeListener('SIGINT',onInterrupt);process.removeListener('SIGTERM',onInterrupt);
  report.elapsedMs=performance.now()-started;report.finishedAt=new Date().toISOString();
  fs.writeFileSync(path.join(output,'stdout.txt'),out);fs.writeFileSync(path.join(output,'stderr.txt'),err);
  fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2)+'\n');
  console.log('Evidence: '+output);
}

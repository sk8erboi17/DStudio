// Explicit one-case native Metal diagnosis. Original common-100 receipts are
// read-only; this is neither another common-100 run nor a quality qualification.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {spawn, spawnSync, execFileSync} from 'node:child_process';
import {artifactRunDir, writeArtifact, freePort, httpJsonRequest} from '../support/real_harness.mjs';
import {hashStableFile, fileIdentity, ownGitRevision} from '../support/quality_baseline.mjs';
import {selectRetainedDiagnosticCase, validateRetainedDiagnosticRequest,
  verifyDiagnosticPatchStack, diagnosticSourceNames, retainedDiagnosticOptions} from '../support/q36_retained_diagnostic_inputs.mjs';

const root=path.resolve(import.meta.dirname,'../..'), run=artifactRunDir('q36-retained-diagnostic');
const report={status:'running',started:new Date().toISOString(),
  scope:'One retained failed request, actual Qwen27B Metal and opt-in driver diagnostics. NOT held-out quality, common-100 completion, numerical parity or a speed comparison.',
  host:{platform:os.platform(),arch:os.arch(),cpu:os.cpus()[0]?.model,ramBytes:os.totalmem()},
  limits:{startupMs:180000,requestMs:null,responseBytes:2*1024*1024,logBytes:16*1024*1024,
    sourceBytes:128*1024*1024,terminateMs:5000,cleanupMs:15000},
  hashes:{},logBytes:{received:0,persisted:0},errors:[]};
const save=()=>writeArtifact(run,'results.json',report);
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
function read(file,max=8*1024*1024){const s=fs.statSync(file);assert.ok(s.isFile()&&s.size<=max,'Oversized input: '+file);return fs.readFileSync(file);}
function json(file){return JSON.parse(read(file));}
const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>
  !/^(Q36_|DS4|DSTUDIO_|DYLD_|LD_|GIT_|MAKEFLAGS$|MFLAGS$)/.test(key)));
env.Q36_METAL_ERROR_DETAILS='1';
let child,close,escalation,watch,model,modelIdentity,stopRequested=false,closed=false,interrupted=false;
const controller=new AbortController(), files={};
function error(reason){if(report.errors.length<8)report.errors.push(String(reason).slice(0,2048));}
function stop(reason){
  if(stopRequested)return;
  stopRequested=true;report.stopReason=reason;controller.abort(new Error(reason));
  if(!child?.pid||closed)return;
  try{process.kill(-child.pid,'SIGTERM');}catch(e){if(e.code!=='ESRCH')error(e);}
  escalation=setTimeout(()=>{if(!closed){report.escalated=true;
    try{process.kill(-child.pid,'SIGKILL');}catch(e){if(e.code!=='ESRCH')error(e);}}},report.limits.terminateMs);
}
const interrupt=()=>{interrupted=true;stop('Diagnostic interrupted');};
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,interrupt);
function engineProcesses(){
  const p=spawnSync('/bin/ps',['-axo','pid=,ppid=,comm='],{encoding:'utf8',timeout:5000,maxBuffer:1024*1024});
  assert.equal(p.status,0,'Cannot establish inference process ownership');
  return p.stdout.split('\n').map(s=>s.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/)).filter(Boolean)
    .filter(([,pid,,exe])=>Number(pid)!==child?.pid&&/\/(?:ds4(?:[-_][^/\s]+)?|q36(?:[-_][^/\s]+)?|q27|DStudio|dstudio)$/.test(exe))
    .map(([,pid,ppid,exe])=>({pid:Number(pid),ppid:Number(ppid),exe}));
}
async function request(url,body,ms){
  return httpJsonRequest(url,{method:body===undefined?'GET':'POST',
    headers:{'Content-Type':'application/json','X-Requested-With':'ds4web'},
    ...(body===undefined?{}:{body}),signal:AbortSignal.any([controller.signal,AbortSignal.timeout(ms)]),
    maxResponseBytes:report.limits.responseBytes});
}
function capture(name,data){
  report.logBytes.received+=data.length;
  const take=Math.min(data.length,report.limits.logBytes-report.logBytes.persisted);
  try{
    for(let offset=0;offset<take;){
      const n=fs.writeSync(files[name],data,offset,take-offset);assert.ok(n>0,'Log write made no progress');
      offset+=n;report.logBytes.persisted+=n;
    }
  }catch(e){error(e);stop('Diagnostic log write failed');}
  if(report.logBytes.received>report.limits.logBytes)stop('Diagnostic log limit exceeded');
}
console.log('Diagnostic evidence: '+run);save();
try{
  assert.equal(process.platform,'darwin','Metal diagnostic unavailable on this host');
  const {inputs:cli,preflightOnly,variant,patchNames}=retainedDiagnosticOptions(process.argv.slice(2));
  report.variant=variant;
  report.mode=preflightOnly?'preflight-only':'native-diagnostic';
  const [engineArg,modelArg,priorArg,caseId,expectedBinary]=cli;
  const engine=fs.realpathSync(engineArg),prior=fs.realpathSync(priorArg);
  model=fs.realpathSync(modelArg);
  assert.match(expectedBinary,/^[a-f0-9]{64}$/);
  assert.deepEqual(engineProcesses(),[],'Another inference engine is live; nothing else will be stopped');
  const before=json(path.join(prior,'results.json'));
  const common=path.join(prior,'q36-common-100'),manifest=json(path.join(common,'manifest.json')),
    original=json(path.join(common,'results.json'));
  const {entry,index,item:c,old}=selectRetainedDiagnosticCase(before,manifest,original,caseId);
  report.limits.requestMs=c.deadline_ms;
  const requestFile=path.join(common,`${String(index+1).padStart(3,'0')}-${caseId}`,'request.json');
  const requestBytes=read(requestFile),payload=JSON.parse(requestBytes);
  validateRetainedDiagnosticRequest(payload,c,manifest,original);
  report.original={run:prior,caseId,summary:original.summary,corpus:original.corpus,
    nativeFailure:{httpStatus:old.httpStatus,elapsedMs:old.elapsedMs,error:old.error},
    engineCommit:entry.inference.installer.commit,binarySHA256:entry.inference.binarySha256,
    requestFileSHA256:sha(requestBytes)};
  report.engine={directory:engine,git:ownGitRevision(engine)};
  assert.equal(report.engine.git?.head,'d02b6a20a7662300003c859e186ceb5bec7aa849','Use the reviewed diagnostic candidate');
  const binary=path.join(engine,'q36-server');assert.equal(sha(read(binary,64*1024*1024)),expectedBinary);
  const captured=path.join(run,'q36-server');fs.copyFileSync(binary,captured,fs.constants.COPYFILE_EXCL);fs.chmodSync(captured,0o700);
  report.binary={source:binary,captured,sha256:expectedBinary};
  const names=diagnosticSourceNames(engine);
  assert.ok(names.length>0&&names.length<4096);let bytes=0;
  for(const name of names){
    const file=path.join(engine,name),info=fs.lstatSync(file);assert.ok(info.isFile()&&!info.isSymbolicLink());
    bytes+=info.size;assert.ok(bytes<=report.limits.sourceBytes,'Source snapshot budget exceeded');
    report.hashes[file]=sha(read(file,64*1024*1024));
  }
  report.hashes[binary]=expectedBinary;report.hashes[captured]=expectedBinary;
  for(const file of [import.meta.filename,path.join(root,'tests/support/q36_retained_diagnostic_inputs.mjs'),
    path.join(root,'tests/support/real_harness.mjs'),path.join(root,'tests/support/quality_baseline.mjs'),requestFile,
    path.join(common,'results.json'),path.join(common,'manifest.json')])report.hashes[file]=sha(read(file));
  for(const [name,expected]of Object.entries(manifest.files)){
    const file=path.join(root,name);assert.equal(sha(read(file)),expected,'Frozen grader changed');report.hashes[file]=expected;
  }
  const patchFiles=[];
  for(const patch of patchNames){
    const file=path.join(root,'patch',patch,'runtime.patch');report.hashes[file]=sha(read(file));
    const capturedPatch=path.join(run,'patches',patch,'runtime.patch');
    fs.mkdirSync(path.dirname(capturedPatch),{recursive:true});
    fs.copyFileSync(file,capturedPatch,fs.constants.COPYFILE_EXCL);
    report.hashes[capturedPatch]=report.hashes[file];patchFiles.push(capturedPatch);
    const script=path.join(root,'scripts',`apply-${patch}.sh`);report.hashes[script]=sha(read(script));
  }
  report.patchValidation=verifyDiagnosticPatchStack(engine,path.join(run,'patch-validation'),names,patchFiles);
  const diff=execFileSync('git',['-C',engine,'diff','--binary','HEAD'],{timeout:10000,maxBuffer:16*1024*1024});
  fs.writeFileSync(path.join(run,'engine-changes.patch'),diff,{flag:'wx'});report.engine.diffSHA256=sha(diff);
  fs.writeFileSync(path.join(run,'retained-request.json'),requestBytes,{flag:'wx'});
  if(preflightOnly){
    report.status='preflight-pass';
    console.log('Preflight PASS; no weight hash, model load or inference performed');
  }else{
  console.log('Checking the complete pinned weight hash (no model loaded yet)');
  modelIdentity=await hashStableFile(model);report.model={path:model,...modelIdentity};
  assert.equal(modelIdentity.bytes,25299061664);assert.equal(modelIdentity.sha256,'701d8fa9ed214ab21bfc130cd2a7df19ca89bbef7713e2dfb19f3c63696aa917');
  assert.equal(modelIdentity.sha256,entry.inference.model.sha256);
  assert.deepEqual(engineProcesses(),[]);assert.ok(!interrupted,'Interrupted before model load');
  const port=await freePort(),base=`http://127.0.0.1:${port}`;
  const args=[...entry.inference.argv];args[args.indexOf('-m')+1]=model;args[args.indexOf('--port')+1]=String(port);
  assert.deepEqual(args.filter((_,i)=>i!==args.indexOf('-m')+1&&i!==args.indexOf('--port')+1),
    entry.inference.argv.filter((_,i)=>i!==entry.inference.argv.indexOf('-m')+1&&i!==entry.inference.argv.indexOf('--port')+1));
  report.launch={binary:captured,argv:args,port,diagnosticEnv:{Q36_METAL_ERROR_DETAILS:'1'},
    memory:'Resident Qwen27B, quality kernels, F16 KV, ctx65536, prefill128; no SSD expert streaming or fallback'};
  for(const name of ['stdout','stderr'])files[name]=fs.openSync(path.join(run,`native.${name}.log`),'wx',0o600);
  child=spawn(captured,args,{cwd:engine,env,detached:true,stdio:['ignore','pipe','pipe']});report.launch.pid=child.pid;save();
  close=new Promise(resolve=>{
    child.once('error',e=>{error(e);stop('Native process error');});
    child.once('close',(code,signal)=>{closed=true;report.exit={code,signal,at:new Date().toISOString()};
      if(!stopRequested)stop('Native engine exited before diagnostic completion');resolve();});
  });
  for(const name of ['stdout','stderr'])child[name].on('data',data=>capture(name,data));
  watch=setInterval(()=>{try{if(engineProcesses().length)stop('Another engine started; stopping only this diagnostic');}
    catch(e){error(e);stop('Process ownership observation failed');}},2000);
  const loading=performance.now();let catalog;
  for(;;){
    assert.ok(!controller.signal.aborted,'Diagnostic stopped during load');
    assert.ok(performance.now()-loading<report.limits.startupMs,'Native startup deadline');
    try{const response=await request(base+'/v1/models',undefined,1000);
      if(response.status===200){catalog=JSON.parse(await response.text());break;}}
    catch(e){if(controller.signal.aborted)throw e;}
    await new Promise(resolve=>setTimeout(resolve,200));
  }
  assert.deepEqual(catalog,entry.inference.models,'Native catalog differs from the retained model/configuration');
  report.loadMs=performance.now()-loading;report.requestStarted=new Date().toISOString();save();
  console.log(`Native model ready; replaying ${caseId}, original ${c.deadline_ms} ms deadline`);
  const began=performance.now(),body=JSON.stringify(payload);report.sentRequestSHA256=sha(body);
  try{
    const response=await request(base+'/v1/chat/completions',body,c.deadline_ms),raw=await response.text();
    fs.writeFileSync(path.join(run,'response.json'),raw,{flag:'wx'});report.httpStatus=response.status;
    assert.equal(response.status,200,`Native HTTP ${response.status}: ${raw.slice(0,2000)}`);
    const output=JSON.parse(raw);report.usage=output.usage;report.responseModel=output.model;
    assert.equal(output.choices?.length,1);assert.equal(output.choices[0].finish_reason,'stop');
    const answer=output.choices[0].message?.content;assert.equal(typeof answer,'string');
    report.grade=JSON.parse(execFileSync('python3',['-B',path.join(root,'tests/support/common_model_quality.py'),
      '--grade',caseId,'--out',path.join(run,'oracle')],{input:JSON.stringify({identity:manifest.identity,answer}),
      encoding:'utf8',timeout:15000,maxBuffer:1024*1024}));
    report.promptCoverage=Number.isSafeInteger(output.usage?.prompt_tokens)&&output.usage.prompt_tokens>=c.minimum_prompt_tokens;
    assert.ok(report.grade.passed&&report.promptCoverage,'Response did not pass the original oracle/coverage');
    report.status='pass';
  }finally{report.requestMs=performance.now()-began;save();}
  }
}catch(e){report.status='fail';error(e.stack||e);console.error(String(e));process.exitCode=1;}
finally{
  stop('Diagnostic finished');clearInterval(watch);
  if(close){let deadline;
    const reaped=await Promise.race([close.then(()=>true),new Promise(resolve=>{deadline=setTimeout(()=>resolve(false),report.limits.cleanupMs);})]);
    clearTimeout(deadline);report.reaped=reaped;
    if(!reaped){error('Native cleanup deadline');child.stdout.destroy();child.stderr.destroy();child.unref();}
  }
  clearTimeout(escalation);
  for(const fd of Object.values(files))try{fs.closeSync(fd);}catch(e){error(e);}
  report.changedInputs=Object.entries(report.hashes).filter(([file,digest])=>{try{return sha(read(file,64*1024*1024))!==digest;}catch{return true;}}).map(([file])=>file);
  if(modelIdentity&&fileIdentity(fs.statSync(model,{bigint:true}))!==modelIdentity.identity)error('Model identity changed');
  const logFile=path.join(run,'native.stderr.log');
  if(fs.existsSync(logFile)){
    const log=read(logFile,report.limits.logBytes).toString('utf8');
    report.metalDiagnostics=log.split('\n').filter(line=>/^q36: Metal (command buffer failed|diagnostic phase=|encoder index=)/.test(line));
  }
  if(report.changedInputs.length||report.errors.length||report.logBytes.received!==report.logBytes.persisted||(child&&!report.reaped)||interrupted){report.status='fail';process.exitCode=1;}
  report.finished=new Date().toISOString();save();
  for(const signal of ['SIGINT','SIGTERM'])process.removeListener(signal,interrupt);
  console.log(JSON.stringify({run,status:report.status,httpStatus:report.httpStatus,reaped:report.reaped,driverRows:report.metalDiagnostics?.length||0}));
}

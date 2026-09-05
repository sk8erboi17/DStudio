// Real network installation and model acceptance. No mocked engine or responses.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {spawn, execFileSync} from 'node:child_process';
import {freePort, sleep} from '../support/real_harness.mjs';

const root = process.cwd();
const install = process.argv.includes('--setup');
const infer = process.argv.includes('--infer');
const viaApp = process.argv.includes('--via-app');
if (!install && !infer) throw Error('Specify --setup and/or --infer; real network/model execution is explicit.');
const option = (name, fallback) => { const i=process.argv.indexOf(name); return i<0?fallback:process.argv[i+1]; };
const engines = option('--engines', install ? 'main,laguna,qwen' : 'main,laguna').split(',');
assert.ok(engines.every(x=>['main','laguna','qwen'].includes(x)));
assert.ok(!viaApp || (infer && engines.every(x=>x==='qwen')), '--via-app currently qualifies Qwen Chat integration only');
const output = path.join(root,'tests/.artifacts/engine-acceptance');
fs.mkdirSync(output,{recursive:true});
const run = fs.mkdtempSync(path.join(output,'run-'));
const installedRoot = install ? path.join(run,'fresh-install') : path.resolve(option('--installed-root',root));
if(install) fs.mkdirSync(installedRoot);
const app = path.resolve(option('--app','tests/.build/dstudio-server-test'));
const modelRoot = path.resolve(option('--model-root','ds4/gguf'));
const configs = {
  main: {dir:'ds4', file:'DeepSeek-V4-Flash-IQ2XXS-w2Q2K-AProjQ8-SExpQ8-OutQ8-chat-v2-imatrix-0731.gguf'},
  laguna: {dir:'ds4-laguna-s21', file:'laguna-s-2.1-Q4_K_M.gguf'},
  qwen: {dir:'ds4-qwen38',file:'Qwen3.8-Flash-Next-Q4KImatrixExperts-MXFP4Down-BF16Emb-BF16Control-Q8GDN-Q8QSA-Q8Shared-Q8Out.gguf'},
};
const report = {schema:'dstudio.engine-acceptance.v1',started:new Date().toISOString(),
  host:{platform:os.platform(),arch:os.arch(),memoryBytes:os.totalmem(),cpu:os.cpus()[0]?.model},
  installationRoot:installedRoot, scope:'Network setup and observable answer correctness, NOT full-logit numerical equivalence or a general capability benchmark.',results:[]};
const save = () => fs.writeFileSync(path.join(run,'results.json'),JSON.stringify(report,null,2)+'\n');
const hashFile = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const owned = new Set();
function launch(exe,args,log,cwd,env={}) {
  const fd=fs.openSync(log,'wx');
  const child=spawn(exe,args,{cwd,detached:true,stdio:['ignore',fd,fd],env:{...process.env,DS4UI_NO_WINDOW:'1',...env}});
  fs.closeSync(fd); owned.add(child);
  child.finished=new Promise(resolve=>{child.once('error',e=>resolve({error:e.message,code:null}));child.once('exit',(code,signal)=>{owned.delete(child);resolve({code,signal});});});
  return child;
}
async function stop(child) {
  if(!owned.has(child))return;
  try {process.kill(-child.pid,'SIGTERM');}catch{}
  let timer;
  const done=await Promise.race([child.finished,new Promise(resolve=>{timer=setTimeout(()=>resolve(null),10000);})]);
  clearTimeout(timer);
  if(!done){try{process.kill(-child.pid,'SIGKILL');}catch{} await child.finished;}
}
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,async()=>{for(const c of owned)await stop(c);report.interrupted=true;save();process.exit(130);});
async function bounded(child,ms) {
  let timer;
  const r=await Promise.race([child.finished,new Promise(resolve=>{timer=setTimeout(()=>resolve(null),ms);})]);
  clearTimeout(timer);
  if(!r){await stop(child);throw Error(`process timed out after ${ms}ms`);}
  assert.equal(r.code,0,JSON.stringify(r));
}
async function http(url,body,timeout=240000) {
  const res=await fetch(url,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json','X-Requested-With':'ds4web'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(timeout)});
  const text=await res.text(); assert.equal(res.status,200,text.slice(0,2000)); return JSON.parse(text);
}
async function inference(id, entry) {
  const cfg=configs[id], cwd=path.join(installedRoot,cfg.dir), file=path.join(modelRoot,cfg.file);
  if(!fs.existsSync(file))throw Error(`weights unavailable: ${file}`);
  const st=fs.statSync(file); assert.ok(st.size>1024**3,'real model must be present');
  const bin=path.join(cwd,'ds4-server'), port=await freePort(), base=`http://127.0.0.1:${port}`;
  const args=['--metal','-m',file,'--host','127.0.0.1','--port',String(port),'--ctx','8192','--tokens','256'];
  if(id!=='laguna')args.push('--prefill-chunk','512'); // Laguna rejects a custom chunk.
  // Explicit resident run: PLE for Qwen remains SSD-backed by model design.
  if(id==='qwen')args.push('--ple',path.join(modelRoot,'Qwen3.8-Flash-Next-PLE-Q4_1.gguf'));
  entry.inference={mode:id==='qwen'?'resident backbone + native SSD PLE':'Metal resident, no SSD expert streaming',transport:viaApp?'DStudio launch API and Chat HTTP proxy':'native engine HTTP',model:{path:file,bytes:st.size,mtime:st.mtime.toISOString()},binarySha256:hashFile(bin),argv:viaApp?undefined:args,cases:[]};
  if(id==='qwen') {
    const ple=path.join(modelRoot,'Qwen3.8-Flash-Next-PLE-Q4_1.gguf'), pst=fs.statSync(ple);
    assert.equal(pst.size,32000157440,'the complete required PLE must be present');
    entry.inference.ple={path:ple,bytes:pst.size,mtime:pst.mtime.toISOString()};
  }
  const begin=performance.now();
  let child;
  if(viaApp){
    assert.equal(fs.realpathSync(path.join(cwd,'gguf',cfg.file)),fs.realpathSync(file),'app must use the selected real model store');
    const data=path.join(run,'app-data'); fs.mkdirSync(data);
    const appArgs=[String(port),cwd];
    child=launch(app,appArgs,path.join(run,id+'-inference.log'),root,{DS4UI_DATA_DIR:data,DSTUDIO_KV_DIR:path.join(run,'app-kv'),DS4UI_TEST_MODE:'',DS4UI_DEFER_ENGINE_START:'1',DS4UI_HOST:'127.0.0.1'});
    entry.inference.launcher={sha256:hashFile(app),argv:appArgs};
    entry.inference.launcher.sourceSha256=Object.fromEntries(['ds4.c','ds4.h','ds4_cuda.cu','ds4_gpu.h','ds4_metal.m','ds4_server.c','ds4_agent.c','download_model.sh'].map(name=>[name,hashFile(path.join(cwd,name))]));
  }else child=launch(bin,args,path.join(run,id+'-inference.log'),cwd);
  try {
    if(viaApp){
      let ready=false;
      for(let i=0;i<120;i++){
        try{await http(base+'/api/status',undefined,2000);ready=true;break;}catch{}
        if(!owned.has(child))break;await sleep(250);
      }
      assert.ok(ready,'DStudio HTTP host failed to start');
      const catalog=await http(base+'/api/ggufs');
      const matches=catalog.ggufs.filter(g=>g.file===cfg.file);
      assert.equal(matches.length,1,'shared weights must not appear under multiple incompatible engines');
      assert.equal(fs.realpathSync(matches[0].engineDir),fs.realpathSync(cwd));
      entry.inference.launcher.catalogMatch=matches[0];
      entry.inference.launcher.preflight=[];
      for(const mode of ['agent','cowork','design']){
        const res=await fetch(base+'/api/start',{method:'POST',headers:{'Content-Type':'application/json','X-Requested-With':'ds4web'},body:JSON.stringify({mode,gguf:`gguf/${cfg.file}`,workdir:run}),signal:AbortSignal.timeout(15000)});
        const body=await res.json();
        assert.equal(res.status,409,JSON.stringify(body)); assert.equal(body.ok,false);
        assert.equal((await http(base+'/api/status')).running,false,'unsupported modes must not start a heavyweight process');
        entry.inference.launcher.preflight.push({mode,httpStatus:res.status,response:body,status:'pass'});
      }
      const launchRequest={mode:'server',gguf:`gguf/${cfg.file}`,port:await freePort(),ctx:8192,power:100,ssdStreaming:'off',dspark:false,think:'off'};
      entry.inference.launcher.request=launchRequest;
      const started=await http(base+'/api/start',launchRequest);
      entry.inference.launcher.response=started;
      assert.ok(started.ok && !started.shared,'must start its own real engine, never adopt an unrelated server');
      save();
    }
    let models;
    const until=Date.now()+900000;
    while(Date.now()<until){
      if(!owned.has(child))throw Error('engine exited before readiness; inspect inference log');
      if(viaApp){const status=await http(base+'/api/status',undefined,5000);if(status.engineError)throw Error(status.engineError);}
      try{models=await http(base+'/v1/models',undefined,2000);break;}catch{}
      await sleep(1000);
    }
    assert.ok(models?.data?.length,'engine did not become ready');
    entry.inference.loadSeconds=(performance.now()-begin)/1000;
    entry.inference.models=models;
    if(viaApp){
      const status=await http(base+'/api/status');
      assert.equal(status.modelFile,`gguf/${cfg.file}`);
      entry.inference.launcher.readyStatus=status;
      assert.equal(hashFile(bin),entry.inference.binarySha256,'Qwen Chat must execute the verified native binary');
    }
    const model=models.data[0].id;
    const request=(messages,extra={})=>({model,messages,temperature:0,seed:42,max_tokens:256,think:false,thinking:{type:'disabled'},stream:false,...extra});
    const ask=async(name,messages,verify,extra={})=>{
      const row={name,request:request(messages,extra)};const t=performance.now();
      try{row.response=await http(base+'/v1/chat/completions',row.request);row.seconds=(performance.now()-t)/1000;
        const c=row.response.choices?.[0];assert.equal(c?.finish_reason,'stop','truncated/incomplete answer');verify(c.message.content);row.status='pass';
      }catch(e){row.seconds=(performance.now()-t)/1000;row.status='fail';row.error=e.message;}
      entry.inference.cases.push(row);save();console.log(`${id}: ${name}: ${row.status}`);return row;
    };
    const user=text=>[{role:'user',content:text}];
    await ask('integer arithmetic',user('What is 17 multiplied by 19? Reply with only the integer.'),s=>assert.equal(s.trim(),'323'));
    await ask('negative arithmetic',user('Compute 14 - 29. Reply with only the integer.'),s=>assert.equal(s.trim(),'-15'));
    await ask('structured extraction',user('Return ONLY a JSON object with keys city and count. Record: city=Torino; count=7. count must be a number.'),s=>assert.deepEqual(JSON.parse(s),{city:'Torino',count:7}));
    await ask('ordering and duplicates',user('Sort [9, -2, 9, 4, 0] ascending, preserving duplicates. Return ONLY the JSON array.'),s=>assert.deepEqual(JSON.parse(s),[-2,0,4,9,9]));
    await ask('instruction and Unicode',user('Return exactly this text, with no explanation: città già pronta'),s=>assert.equal(s.trim(),'città già pronta'));
    const nonce=crypto.randomBytes(5).toString('hex');
    await ask('multi-turn recall',[{role:'user',content:`Remember the project code ${nonce}.`},{role:'assistant',content:'Understood.'},{role:'user',content:'What is the project code? Return only the code.'}],s=>assert.equal(s.trim(),nonce));
    const rows=Array.from({length:90},(_,i)=>`Item ${i}: location aisle-${i+3}; units ${i*3+2}.`).join('\n');
    await ask('longer-context retrieval',user(rows+'\nWhat are the units for Item 67? Reply with only the integer.'),s=>assert.equal(s.trim(),'203'));
    await ask('code execution reasoning',user('In Python: x = [3, 5, 8]; print(sum(v * 2 for v in x if v % 2 == 1)). What integer is printed? Reply only with that integer.'),s=>assert.equal(s.trim(),'16'));
    // A malformed real request must fail, and must not poison the next turn.
    const invalid=await fetch(base+'/v1/chat/completions',{method:'POST',headers:{'Content-Type':'application/json','X-Requested-With':'ds4web'},body:'{invalid',signal:AbortSignal.timeout(10000)});
    entry.inference.cases.push({name:'invalid request rejected',status:invalid.status>=400&&invalid.status<500?'pass':'fail',httpStatus:invalid.status,response:await invalid.text()});
    await ask('recovery after error',user('What is 6 + 8? Reply with only the integer.'),s=>assert.equal(s.trim(),'14'));
    const toolRow={name:'tool call and result round-trip'};
    try {
      const messages=user('Use read_stock to look up test-item, then tell me the returned quantity.');
      const tools=[{type:'function',function:{name:'read_stock',description:'Read actual item quantity from the local inventory.',parameters:{type:'object',properties:{item:{type:'string',enum:['test-item']}},required:['item'],additionalProperties:false}}}];
      toolRow.request=request(messages,{tools,tool_choice:{type:'function',function:{name:'read_stock'}}});
      toolRow.response=await http(base+'/v1/chat/completions',toolRow.request);
      const message=toolRow.response.choices?.[0]?.message;
      assert.equal(toolRow.response.choices?.[0]?.finish_reason,'tool_calls');
      assert.equal(message?.tool_calls?.length,1);const call=message.tool_calls[0];
      assert.equal(call.function.name,'read_stock');assert.deepEqual(JSON.parse(call.function.arguments),{item:'test-item'});
      // Deliberately a controlled inventory fixture, not a claim of autonomous tool execution.
      const quantity=17;
      toolRow.followupRequest=request([...messages,message,{role:'tool',tool_call_id:call.id,content:JSON.stringify({quantity})},{role:'user',content:'Reply with only the integer quantity returned by the tool.'}],{tools});
      toolRow.followupResponse=await http(base+'/v1/chat/completions',toolRow.followupRequest);
      assert.equal(toolRow.followupResponse.choices?.[0]?.finish_reason,'stop');
      assert.equal(toolRow.followupResponse.choices[0].message.content.trim(),String(quantity));
      toolRow.status='pass';
    }catch(e){toolRow.status='fail';toolRow.error=e.message;}
    entry.inference.cases.push(toolRow);save();console.log(`${id}: ${toolRow.name}: ${toolRow.status}`);
    const streamRow={name:'real SSE streaming',request:request(user('What is 12 + 9? Reply with only the integer.'),{stream:true})};
    const t=performance.now();
    try {
      const res=await fetch(base+'/v1/chat/completions',{method:'POST',headers:{'Content-Type':'application/json','X-Requested-With':'ds4web'},body:JSON.stringify(streamRow.request),signal:AbortSignal.timeout(240000)});
      assert.equal(res.status,200); let raw='',first=null;const decoder=new TextDecoder();
      for await(const chunk of res.body){if(first===null)first=performance.now();raw+=decoder.decode(chunk,{stream:true});}
      raw+=decoder.decode();
      streamRow.raw=raw; streamRow.firstByteSeconds=(first-t)/1000;streamRow.seconds=(performance.now()-t)/1000;
      const events=raw.split(/\r?\n/).filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trim());
      assert.equal(events.at(-1),'[DONE]');const parsed=events.slice(0,-1).map(l=>JSON.parse(l));
      const text=parsed.map(e=>e.choices?.[0]?.delta?.content||'').join('');assert.equal(text.trim(),'21');
      assert.ok(parsed.some(e=>e.choices?.[0]?.finish_reason==='stop'));streamRow.status='pass';
    }catch(e){streamRow.status='fail';streamRow.error=e.message;}
    entry.inference.cases.push(streamRow);save();
    assert.ok(entry.inference.cases.every(c=>c.status==='pass'),'one or more answer/protocol checks failed');
  } finally {
    await stop(child);
    if(viaApp){
      for(const [name,hash] of Object.entries(entry.inference.launcher.sourceSha256))
        assert.equal(hashFile(path.join(cwd,name)),hash,`Chat launch must not mutate native Qwen source: ${name}`);
      entry.inference.launcher.sourcePreserved=true;
    }
  }
}
console.log(`Evidence: ${run}`); save();
for(const id of engines){
  const entry={engine:id,status:'running'};report.results.push(entry);save();
  try {
    if(install){
      const target=path.join(installedRoot,configs[id].dir);assert.ok(!fs.existsSync(target),'fresh install starts without checkout');
      const before=performance.now();const child=launch(app,['--install-engine',id,installedRoot],path.join(run,id+'-install.log'),root);
      await bounded(child,1200000);
      entry.installation={seconds:(performance.now()-before)/1000,receipt:JSON.parse(fs.readFileSync(path.join(target,'.dstudio-source.json'),'utf8'))};
      for(const exe of id==='qwen'?['ds4','ds4-server','ds4-agent']:['ds4-server','ds4-agent-jsonl','ds4-cowork','ds4-design']){
        const help=execFileSync(path.join(target,exe),['--help'],{cwd:target,timeout:15000,encoding:'utf8',maxBuffer:1024*1024});
        assert.ok(help.length>20,`${exe} must actually execute`);
      }
      if(id!=='main')assert.equal(fs.realpathSync(path.join(target,'gguf')),fs.realpathSync(path.join(installedRoot,'ds4/gguf')));
      console.log(`${id}: network download, build and executable startup passed`);
    }
    if(infer)await inference(id,entry);
    entry.status='pass';
  }catch(e){entry.status='fail';entry.error=e.stack;console.error(`${id}: FAILED: ${e.message}`);}
  save();
}
report.finished=new Date().toISOString();save();
console.log(JSON.stringify(report.results.map(x=>({engine:x.engine,status:x.status,checks:x.inference?.cases.map(c=>({name:c.name,status:c.status}))})),null,2));
process.exitCode=report.results.every(x=>x.status==='pass')?0:1;

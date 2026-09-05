import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import net from 'node:net';
import {spawn,spawnSync} from 'node:child_process';
import {performance} from 'node:perf_hooks';
import {cases,checkChat} from './fixtures.mjs';

if(process.env.RUN_HEAVY!=='1')throw new Error('Set RUN_HEAVY=1 explicitly; this benchmark loads real weights.');
const option=(name,fallback)=>{const i=process.argv.indexOf(name);return i<0?fallback:process.argv[i+1];};
const root=process.cwd(),engineDir=path.resolve(option('--engine','ds4'));
const model=path.resolve(option('--model','ds4/gguf/DeepSeek-V4-Flash-IQ2XXS-w2Q2K-AProjQ8-SExpQ8-OutQ8-chat-v2-imatrix-0731.gguf'));
const out=path.resolve(option('--output',`tests/.artifacts/pld-real-${new Date().toISOString().replaceAll(':','-')}`));
const surfaces=option('--surfaces','chat,agent,cowork').split(',');
const modes=option('--modes','off,strict,batch').split(',');
const selected=option('--cases','').split(',').filter(Boolean);
const repeats=Number(option('--repeats','2'));
const context=Number(option('--ctx','8192')),power=Number(option('--power','70'));
const timeoutMs=Number(option('--timeout-ms','600000'));
const sharedHost=process.argv.includes('--allow-busy-host');
const hostLabel=option('--host-label',sharedHost?'Shared desktop workload':'No competing heavy workload requested');
if(modes.some(m=>!['off','strict','batch'].includes(m)))throw new Error('unknown mode');
if(surfaces.some(s=>!['chat','agent','cowork'].includes(s)))throw new Error('unknown surface');
if(selected.some(id=>!cases.some(c=>c.id===id)))throw new Error('unknown case');
if(!Number.isInteger(repeats)||repeats<1||repeats>10)throw new Error('invalid repeat count');
if(fs.existsSync(out))throw new Error(`Refusing to overwrite existing run ${out}`);
fs.mkdirSync(out,{recursive:true});
const sharedWorkspace=path.join(out,'workspace');fs.mkdirSync(sharedWorkspace);
const write=(name,value)=>fs.writeFileSync(path.join(out,name),typeof value==='string'?value:JSON.stringify(value,null,2)+'\n');
const read=file=>fs.existsSync(file)?fs.readFileSync(file,'utf8'):'';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const sha=text=>crypto.createHash('sha256').update(text).digest('hex');
const command=(cmd,args)=>spawnSync(cmd,args,{encoding:'utf8'}).stdout?.trim()||'';
const report={schemaVersion:1,benchmark:'prompt-lookup-real-engine',startedAt:new Date().toISOString(),
  model:{file:path.basename(model),bytes:fs.statSync(model).size,mtime:fs.statSync(model).mtime.toISOString(),context,power,ssdStreaming:false,dspark:false,temperature:0,thinking:'off'},
  hardware:{chip:command('sysctl',['-n','machdep.cpu.brand_string']),memoryBytes:os.totalmem(),os:`${os.type()} ${os.release()} ${os.arch()}`},
  source:{dstudio:command('git',['rev-parse','HEAD']),engine:command('git',['-C',engineDir,'rev-parse','HEAD']),
    dirty:!!command('git',['status','--porcelain']),patchHashes:{}},
  method:{repeats,modes,surfaces,caseIds:cases.filter(c=>surfaces.includes(c.surface)&&(!selected.length||selected.includes(c.id))).map(c=>c.id),
    hostMode:sharedHost?'shared':'isolated',hostLabel,hostNote:option('--host-note',''),
    fixedPromptEpoch:1788566400,promptTimezone:'UTC',
    scope:'Direct managed engine runtimes, not the DStudio UI or Task Graph wrapper. Synthetic public fixtures only.',
    order:'Reverse mode order on odd repeats. Separate warmup excluded; wall time includes prefill/tools/verification/replay. Model startup reported separately.',
    correctness:'Independent exact text/file or functional check; also compare full raw outputs to off. Never gate correctness on reported speed.',
    caveats:['Two repetitions are descriptive, not statistical proof.','Only one machine, model, greedy text-only, SSD off.','No general reliability claim or byte-equivalence guarantee for untested requests.']},
  startups:[],runs:[],overlap:[],memorySamples:[],warmups:[],hostContention:[]};
for(const file of ['pld.h','pld_core.c','pld_agent.inc','pld_server_eval.inc','pld_server_finish.inc'])
  report.source.patchHashes[file]=sha(fs.readFileSync(`patch/ds4-agent-jsonl/${file}`));
report.source.benchmarkHashes=Object.fromEntries(['run-real.mjs','fixtures.mjs'].map(file=>[file,sha(fs.readFileSync(`extension/prompt-lookup/bench/${file}`))]));
report.source.coworkSystemSha=sha(fs.readFileSync('extension/cowork/COWORK.md'));
report.source.binaryHashes=Object.fromEntries(surfaces.map(surface=>{
  const binary=surface==='chat'?'ds4-server-pld':surface==='agent'?'ds4-agent-jsonl':'ds4-cowork';
  return [binary,sha(fs.readFileSync(path.join(engineDir,binary)))];
}));
function persist(){report.updatedAt=new Date().toISOString();write('results.json',report);}
function counters(text){
  const rows=[...text.matchAll(/PLD (?:mode=\S+ )?lookups=(\d+) hits=(\d+) proposed=(\d+) matches=(\d+) batches=(\d+) fallback=(\d+)/g)];
  return Object.fromEntries(['lookups','hits','proposed','matches','batches','fallbacks'].map((k,i)=>[k,rows.reduce((n,r)=>n+Number(r[i+1]),0)]));
}
function memory(){return command('sysctl',['vm.swapusage']);}
function tracedTokens(text){return [...text.matchAll(/token index=(\d+) id=(\d+) bytes=/g)].map(m=>({position:Number(m[1]),id:Number(m[2])}));}
function snapshot(dir){
  const files={};
  function walk(base,rel=''){for(const entry of fs.readdirSync(base,{withFileTypes:true})){
    const name=path.join(rel,entry.name),full=path.join(base,entry.name);
    if(entry.isDirectory())walk(full,name);else files[name]=sha(fs.readFileSync(full));
  }}
  walk(dir);return files;
}
let active=null;
function hostContention(){
  return command('ps',['-axo','pid=,pcpu=,command=']).split('\n').flatMap(line=>{
    const m=line.match(/^\s*(\d+)\s+([\d.]+)\s+(\S+)(.*)$/);if(!m)return [];
    const pid=Number(m[1]),cpu=Number(m[2]),exe=m[3];
    if(pid===process.pid||pid===active?.child.pid)return [];
    const game=/\.lunarclient\/.*\/bin\/java$/.test(exe)||
      (path.basename(exe)==='java'&&/net\.minecraft\.client/.test(m[4]));
    return game||cpu>=50?[{pid,cpu,executable:exe,game}]:[];
  });
}
function engineConflicts(){
  return command('ps',['-axo','pid=,command=']).split('\n').filter(l=>{
    const match=l.match(/^\s*(\d+)\s+(\S+)(.*)$/);if(!match||Number(match[1])===active?.child.pid)return false;
    const exe=path.basename(match[2]);
    return /^(ds4-server(?:-pld)?|ds4-agent-jsonl|ds4-cowork)$/.test(exe)||
      (exe==='llama-server'&&/(?:^|\s)(?:-m|--model|--hf-repo)(?:\s|=)/.test(match[3]));
  });
}
const monitor=setInterval(()=>{
  if(!active)return;
  for(const conflict of engineConflicts())if(!report.overlap.includes(conflict))report.overlap.push(conflict);
  report.memorySamples.push({at:new Date().toISOString(),swap:memory(),rssKiB:Number(command('ps',['-p',String(active.child.pid),'-o','rss=']))||0});
  for(const task of hostContention())report.hostContention.push({at:new Date().toISOString(),...task});
},5000);
async function stop(){
  if(!active)return;
  const item=active;active=null;
  if(item.child.exitCode===null&&item.child.signalCode===null){
    item.child.kill('SIGTERM');
    await Promise.race([item.closed,sleep(10000)]);
    if(item.child.exitCode===null&&item.child.signalCode===null){item.child.kill('SIGKILL');await item.closed;}
  }
  item.log.end();
}
async function start(surface,mode,repeat){
  const id=`${surface}-${mode}-r${repeat}`,dir=path.join(out,id);fs.mkdirSync(dir);
  const env={...process.env,DS4UI_PLD:mode,DS4_MTP_SPEC_DISABLE:'1',DS4UI_BENCHMARK_EPOCH:'1788566400',TZ:'UTC'};
  for(const key of ['DS4UI_AGENT_PLD','DS4UI_COWORK_PLD','DS4UI_CHAT_PLD','DS4UI_REMOTE_BASE_URL'])delete env[key];
  const trace=path.join(dir,'trace.log');
  const base=['-m',model,'--metal','--ctx',String(context),'--power',String(power),'--trace',trace];
  let port;
  if(surface==='chat'){
    port=await new Promise((resolve,reject)=>{const s=net.createServer();s.once('error',reject);s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
    base.push('--host','127.0.0.1','--port',String(port),'--kv-cache-cold-max-tokens','0','--kv-cache-continued-interval-tokens','0');
  }else{
    // Reuse the same absolute cwd in every mode. Different mode-specific
    // paths in the system prompt would confound token-equivalence checks.
    for(const name of fs.readdirSync(sharedWorkspace))fs.rmSync(path.join(sharedWorkspace,name),{recursive:true,force:true});
    const workspace=sharedWorkspace;
    env.DS4UI_SESSION_CACHE_DIR=path.join(dir,'session-cache');
    env.DS4UI_RUNTIME_NAME=surface;
    env.DS4UI_COWORK_HELPER=path.join(root,'extension/cowork/office_tool.py');
    const system=(surface==='cowork'?fs.readFileSync(path.join(root,'extension/cowork/COWORK.md'),'utf8')+'\n\n':'')+
      'Work only within this benchmark workspace. Do not use the network. Follow the requested file operation, verify it with tools, then give a short final answer.';
    base.push('--jsonl','--non-interactive','--temp','0','--top-p','1','--min-p','0','--seed','314159',
      '--nothink','--tokens','1600','--chdir',workspace,'-sys',
      system);
  }
  const binary=path.join(engineDir,surface==='chat'?'ds4-server-pld':surface==='agent'?'ds4-agent-jsonl':'ds4-cowork');
  const log=fs.createWriteStream(path.join(dir,'process.log'));
  const started=performance.now(),child=spawn(binary,base,{cwd:engineDir,env,stdio:['pipe','pipe','pipe']});
  const item={child,dir,trace,port,log,stdout:'',stderr:'',closed:null};
  item.closed=new Promise(resolve=>child.once('close',(code,signal)=>resolve({code,signal})));
  child.stdout.on('data',b=>{item.stdout+=b;log.write(b);});child.stderr.on('data',b=>{item.stderr+=b;log.write(b);});
  child.on('error',e=>{item.error=e.message;});active=item;
  while(performance.now()-started<180000){
    if(item.error||child.exitCode!==null||child.signalCode)throw new Error(`engine startup failed: ${item.error||item.stderr.slice(-2500)}`);
    if(surface!=='chat'){if(item.stderr.includes('+DWARFSTAR_WAITING'))break;}
    else try{const r=await fetch(`http://127.0.0.1:${port}/v1/models`,{signal:AbortSignal.timeout(1000)});if(r.ok)break;}catch{}
    await sleep(500);
  }
  if(surface==='chat'){
    const probe=await fetch(`http://127.0.0.1:${port}/v1/models`,{signal:AbortSignal.timeout(3000)});
    if(!probe.ok)throw new Error('engine not ready');
  }else if(!item.stderr.includes('+DWARFSTAR_WAITING'))throw new Error('Agent/Cowork not ready');
  report.startups.push({surface,mode,repeat,seconds:(performance.now()-started)/1000,command:[binary,...base],swap:memory()});persist();
  if(surface!=='chat'){
    const traceText=read(trace),header=traceText.match(/tokens label=initial_system_prompt start=0 len=(\d+)/);
    if(!header)throw new Error('Missing initial prompt token trace');
    item.initialTokens=tracedTokens(traceText.slice(header.index)).slice(0,Number(header[1]));
    if(item.initialTokens.length!==Number(header[1])||item.initialTokens.some((t,i)=>t.position!==i))throw new Error('Incomplete initial prompt token trace');
    report.startups.at(-1).initialPromptSha=sha(JSON.stringify(item.initialTokens));
  }
  console.log(`${id}: model ready in ${report.startups.at(-1).seconds.toFixed(1)}s`);
  return item;
}

async function sendAgent(item,prompt){
  const errStart=item.stderr.length,outStart=item.stdout.length;
  item.child.stdin.write(prompt+'\n');
  const started=performance.now();
  while(performance.now()-started<timeoutMs){
    if(item.child.exitCode!==null||item.child.signalCode)throw new Error('Agent exited: '+item.stderr.slice(-1600));
    if(item.stderr.slice(errStart).includes('+DWARFSTAR_WAITING')){
      await sleep(30);return item.stdout.slice(outStart);
    }
    await sleep(20);
  }
  throw new Error('Agent turn timeout');
}
async function agent(item,test){
  const workspace=sharedWorkspace,caseDir=path.join(workspace,test.id);fs.mkdirSync(caseDir);
  for(const [name,content] of Object.entries(test.files||{}))fs.writeFileSync(path.join(caseDir,name),content);
  let prompt=test.prompt;
  for(const name of new Set([...Object.keys(test.files||{}),test.output]))prompt=prompt.replaceAll(name,`${test.id}/${name}`);
  await sendAgent(item,'/new');
  const beforeFiles=snapshot(workspace),beforeTrace=read(item.trace).length,started=performance.now();
  let raw='',error=null;
  try{raw=await sendAgent(item,prompt);}catch(e){error=e.message;}
  const wallMs=performance.now()-started,trace=read(item.trace).slice(beforeTrace),afterFiles=snapshot(workspace);
  const firstRound=trace.split('prefill sync done tool_round=0')[0];
  const header=firstRound.match(/prefill tool_round=0 transcript=(\d+) prompt=(\d+) cached=(\d+) suffix=(\d+)/);
  if(!header)throw new Error('Missing initial request prompt trace');
  const cached=Number(header[3]),suffix=tracedTokens(firstRound);
  const inputTokens=[...item.initialTokens.slice(0,cached),...suffix];
  if((cached!==0&&cached!==item.initialTokens.length)||inputTokens.length!==Number(header[2])||inputTokens.some((t,i)=>t.position!==i))
    throw new Error('Cannot reconstruct exact input tokens');
  const inputTokenSha=sha(JSON.stringify(inputTokens));
  const changed=[...new Set([...Object.keys(beforeFiles),...Object.keys(afterFiles)])].filter(f=>beforeFiles[f]!==afterFiles[f]);
  const allowed=path.join(test.id,test.output),unexpected=changed.filter(f=>f!==allowed);
  const outputPath=path.join(caseDir,test.output),answer=read(outputPath);
  const events=[...raw.matchAll(/\x1e(\{[^\r\n]*\})/g)].flatMap(m=>{try{return [JSON.parse(m[1])];}catch{return [];}});
  const toolCalls=events.filter(e=>e.type==='tool_call');
  let contentCorrect=fs.existsSync(outputPath)&&answer===test.expected;
  if(test.codeCheck&&fs.existsSync(outputPath)){
    // Execute generated code only in its owned benchmark folder, with a timeout.
    const check=spawnSync(process.execPath,['--input-type=module','-e',
      'import fs from "node:fs";const m=await import("data:text/javascript,"+encodeURIComponent(fs.readFileSync(process.argv[1],"utf8")));if(m.sum([])!==0||m.sum([1,2,3])!==6||m.sum([-2,5])!==3)process.exit(1);',outputPath],
      {cwd:caseDir,encoding:'utf8',timeout:5000});
    contentCorrect=check.status===0;
  }
  return {error,wallMs,answer,raw,trace,inputTokenSha,inputTokenCount:inputTokens.length,pld:counters(trace),toolCalls:toolCalls.length,changed,unexpected,
    correct:!error&&contentCorrect&&unexpected.length===0&&toolCalls.length>0,
    outputSha:sha(answer),transcriptSha:sha(raw.replace(/\x1e[^\r\n]*/g,'')),finish:error?'error':'complete'};
}
async function chat(item,test){
  const body={model:'deepseek-v4-flash',messages:[{role:'user',content:test.prompt}],temperature:0,top_p:1,min_p:0,
    seed:314159,max_tokens:test.maxTokens||1500,stream:!!test.stream,thinking:{type:'disabled'}};
  if(test.tools){body.tools=test.tools;body.tool_choice='required';}
  if(test.stop)body.stop=test.stop;
  if(test.stream)body.stream_options={include_usage:true};
  const before=read(item.trace).length,started=performance.now();let firstTokenMs=null,answer='',tools=[],usage=null,finish=null,raw='';
  let error=null,status=null;
  try{
    const response=await fetch(`http://127.0.0.1:${item.port}/v1/chat/completions`,{
      method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(timeoutMs)});
    status=response.status;
    if(test.stream&&response.ok){
      const decoder=new TextDecoder();let pending='';
      for await(const chunk of response.body){
        const str=decoder.decode(chunk,{stream:true});raw+=str;pending+=str;
        let at;while((at=pending.indexOf('\n'))>=0){
          const line=pending.slice(0,at).trim();pending=pending.slice(at+1);
          if(!line.startsWith('data:')||line==='data: [DONE]')continue;
          const event=JSON.parse(line.slice(5));
          if(event.error)throw new Error(JSON.stringify(event.error));
          const c=event.choices?.[0];if(c?.delta?.content){if(firstTokenMs===null)firstTokenMs=performance.now()-started;answer+=c.delta.content;}
          if(c?.finish_reason)finish=c.finish_reason;if(event.usage)usage=event.usage;
        }
      }
    }else{
      raw=await response.text();const result=JSON.parse(raw);
      if(!response.ok||result.error)throw new Error(JSON.stringify(result.error||result));
      const c=result.choices?.[0];answer=c?.message?.content||'';tools=c?.message?.tool_calls||[];finish=c?.finish_reason;usage=result.usage;
    }
  }catch(e){error=e.message;}
  const wallMs=performance.now()-started;
  await sleep(30); // Let the trace flush after the response; not part of timing.
  const trace=read(item.trace).slice(before);
  return {status,error,wallMs,firstTokenMs,answer,tools,usage,finish,raw,trace,pld:counters(trace),
    correct:!error&&finish!=='length'&&checkChat(test,answer,tools),
    outputSha:sha(JSON.stringify({answer,tools:tools.map(t=>({type:t.type,function:t.function}))}))};
}

for(const signal of ['SIGINT','SIGTERM'])process.once(signal,async()=>{report.interrupted=signal;persist();await stop();process.exit(130);});
try{
  const conflicts=engineConflicts();
  if(conflicts.length)throw new Error(`Refusing overlap with existing engines: ${conflicts.join('; ')}`);
  report.hostContention=hostContention();
  if(report.hostContention.length&&!sharedHost)
    throw new Error('Host is busy with a game or another CPU-heavy process. Use --allow-busy-host for explicitly labelled shared-host measurements.');
  persist();
  for(let repeat=0;repeat<repeats;repeat++)for(const surface of surfaces)for(const mode of repeat%2?[...modes].reverse():modes){
    const suite=cases.filter(c=>c.surface===surface&&(!selected.length||selected.includes(c.id)));if(!suite.length)continue;
    const item=await start(surface,mode,repeat);
    const warmupStarted=performance.now();
    if(surface==='chat'){
      const warmup=await chat(item,{prompt:'Reply with exactly READY',expected:'READY',maxTokens:16});
      report.warmups.push({surface,mode,repeat,wallMs:warmup.wallMs,correct:warmup.correct,error:warmup.error});
      if(warmup.error)throw new Error(`Warmup failed: ${warmup.error}`);
    }else{
      await sendAgent(item,'Reply briefly with READY. Do not use tools.');
      report.warmups.push({surface,mode,repeat,wallMs:performance.now()-warmupStarted});
    }
    for(const test of suite){
      console.log(`${surface} ${mode} r${repeat}: ${test.id} starting`);
      const result=await (surface==='chat'?chat(item,test):agent(item,test)),key=`${test.id}-${mode}-r${repeat}`;
      write(`${key}.json`,{input:test,...result});
      const previous=report.runs.find(r=>r.caseId===test.id);
      if(result.inputTokenSha&&previous?.inputTokenSha!==undefined&&previous.inputTokenSha!==result.inputTokenSha)
        throw new Error(`Unmatched input tokens for ${test.id}; refusing a confounded comparison`);
      const {raw,trace,...row}=result;report.runs.push({caseId:test.id,surface,family:test.family,mode,repeat,...row});persist();
      console.log(`${key}: correct=${result.correct} ${(result.wallMs/1000).toFixed(2)}s batches=${result.pld.batches} hits=${result.pld.hits}${result.error?' ERROR='+result.error:''}`);
      if(result.error&&surface!=='chat')throw new Error(`Incomplete Agent turn; stopping instead of mixing future transcripts: ${result.error}`);
    }
    await stop();
  }
  if(fs.statSync(model).mtime.toISOString()!==report.model.mtime)throw new Error('Model file changed during the run');
  report.finishedAt=new Date().toISOString();persist();
}catch(e){report.fatalError=e.stack;persist();console.error(e.stack);process.exitCode=1;}
finally{clearInterval(monitor);await stop();}
console.log(`Results: ${out}`);

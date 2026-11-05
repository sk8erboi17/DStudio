// Explicit, serial real-weight Learn audit checks through the production host.
// Authored evidence/oracles; no web retrieval or whole-roadmap qualification.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {once} from 'node:events';
import {loadRoadmapFunctions} from '../support/roadmap_functions.mjs';
import {artifactRunDir,freePort,jsonFetch,startMode,sleep,csrfHeaders,writeArtifact} from '../support/real_harness.mjs';
assert.equal(process.env.DSTUDIO_LIVE_ROADMAP_AUDIT,'1','Set DSTUDIO_LIVE_ROADMAP_AUDIT=1 to explicitly run weights');
const api=loadRoadmapFunctions();
const artifacts=artifactRunDir('roadmap-audit-real');
console.log('Real Learn audit evidence:',artifacts);
const root=process.cwd(), engineDir=path.resolve(process.env.DSTUDIO_REAL_DS4_DIR||'ds4');
const model=process.env.DSTUDIO_REAL_ROADMAP_GGUF||'gguf/DeepSeek-V4.1-Flash-1017-IQ2_XXS-Q2_K-imatrix.gguf';
assert.ok(fs.statSync(path.join(engineDir,model)).size>0,'Requested real weights must exist; no fallback or download');
const hostPort=await freePort(), enginePort=await freePort(), base=`http://127.0.0.1:${hostPort}`;
const log=fs.openSync(path.join(artifacts,'host.log'),'w',0o600);
const child=spawn(path.resolve(process.argv[2]||'dstudio'),[String(hostPort),engineDir],{
 cwd:root,env:{...process.env,DS4UI_HOST:'127.0.0.1',DS4UI_ENGINE_PORT:String(enginePort),DS4UI_DEFER_ENGINE_START:'1',DS4UI_NO_WINDOW:'1',
 DS4UI_DATA_DIR:path.join(artifacts,'profile'),DSTUDIO_KV_DIR:path.join(artifacts,'kv'),DS4UI_PAGE_FROM_DISK:'1'},
 stdio:['ignore',log,log],
});
const receipt={scope:'Real weights, five authored factual/consistency checks through production host and Learn phase normalizer; no full-roadmap quality claim',
 status:'RUNNING',htmlSHA256:createHash('sha256').update(fs.readFileSync('web/index.html')).digest('hex'),
 source:JSON.parse(fs.readFileSync(path.join(engineDir,'.dstudio-source.json'))),modelFile:model,
 modelBytes:fs.statSync(path.join(engineDir,model)).size,cases:[],attempts:[]};
writeArtifact(artifacts,'results.json',receipt);
const signals=new Set();let streamCount=0;
async function* stream(request,signal){
 const body={model:'ds4',messages:request.messages,stream:true,stream_options:{include_usage:true},think:true,reasoning_effort:'max',temperature:.35};
 const attempt=++streamCount;writeArtifact(artifacts,`request-${attempt}.json`,body);
 const res=await fetch(base+'/v1/chat/completions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal});
 assert.equal(res.status,200);
 const reader=res.body.getReader(),decoder=new TextDecoder();let pending='';
 try{
  for(;;){const {value,done}=await reader.read();pending+=done?decoder.decode():decoder.decode(value,{stream:true});
   const frames=pending.split(/\r?\n\r?\n/);pending=frames.pop();
   for(const frame of frames)for(const line of frame.split(/\r?\n/))if(line.startsWith('data:')){
    const data=line.slice(5).trim();if(data==='[DONE]')return;
    const event=JSON.parse(data),choice=event.choices?.[0],delta=choice?.delta;
    if(event.error)throw new Error(event.error.message);
    if(delta?.reasoning_content)yield{type:'reasoning',text:delta.reasoning_content};
    if(delta?.content)yield{type:'content',text:delta.content};
    if(choice?.finish_reason)yield{type:'finish',reason:choice.finish_reason};
    if(event.usage)yield{type:'usage',usage:event.usage};
   }
   if(done)throw new Error('Real stream ended before DONE');
  }
 }finally{await reader.cancel().catch(()=>{});}
}
try{
 for(;;){if(child.exitCode!==null)throw new Error('Test host exited during startup');try{await jsonFetch(base,'/api/status',{timeoutMs:1000});break;}catch{await sleep(200);}}
 const status=await startMode(base,{mode:'server',variant:'flash',gguf:model,port:enginePort,ctx:393216,power:100,think:'max',ssdStreaming:'on'},0);
 receipt.runtime={config:status.config,modelFile:status.modelFile,ds4dir:status.ds4dir};writeArtifact(artifacts,'results.json',receipt);
 assert.equal(status.config.ssdStreamingEffective,true,'This run must actually use SSD expert streaming');
 const source={id:'S1',title:'Authored invoice fixture',url:'https://example.invalid/authored-fixture',
  text:'The metric uses only paid invoices. Trial invoices are excluded. The reference dataset contains 18 paid invoices and 7 trial invoices. The approved rate is 4 units per paid invoice.'};
 const evidence=[{...source,fullText:source.text}];
 const groups=[{
  id:'source-checks',items:[
   {id:'invoice-count',kind:'content',text:'The reference dataset contains 18 paid invoices.'},
   {id:'trial-policy',kind:'content',text:'Trial invoices are included in the metric.'},
   {id:'missing-margin',kind:'content',text:'The reference dataset has a net profit margin of 23 percent.'},
   {id:'practice-task',kind:'content',text:'Draw a flow diagram of your preferred study routine as a practice exercise.'},
  ],evidence,expected:['supported','contradicted','unverified','not_factual'],
 },{
  id:'cross-stage-contradiction',items:[{id:'offline-conflict',kind:'consistency',text:JSON.stringify({firstStageRule:'Every exercise must run offline.',laterStageRequirement:'The final exercise requires an online-only API and has no offline alternative.'})}],evidence:[],expected:['contradicted'],
 }];
 for(const group of groups){
  const controller=new AbortController();signals.add(controller);const started=Date.now();let latest;
  const task={scope:group.id,items:group.items,evidence:group.evidence.map(({id,title,url,text})=>({id,title,url,text}))};
  const result=await api.completeRoadmapPhase({request:{messages:[{role:'system',content:api.ROADMAP_FACT_AUDIT_PROTOCOL},{role:'user',content:JSON.stringify(task)}],thinkLevel:'max'},
   signal:controller.signal,label:group.id,stream,normalize:raw=>api.normalizeRoadmapCheckBatch(JSON.parse(raw.trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'')),group.items,group.evidence),
   onProgress(snapshot){latest=snapshot;if(snapshot.settled)writeArtifact(artifacts,`${group.id}-attempt-${snapshot.attempt}.json`,snapshot);},
   onRetry(attempt,issue,snapshot){receipt.attempts.push({case:group.id,attempt,issue,repetition:snapshot.repetition});writeArtifact(artifacts,'results.json',receipt);},
  });
  signals.delete(controller);
  writeArtifact(artifacts,`${group.id}-answer.json`,result);
  const byId=new Map(result.map(check=>[check.id,check]));
  const actual=group.items.map(item=>byId.get(item.id)?.verdict);
  const row={id:group.id,expected:group.expected,actual,elapsedMs:Date.now()-started,reasoningChars:latest?.reasoningChars,usage:latest?.usage};
  receipt.cases.push(row);writeArtifact(artifacts,'results.json',receipt);
  assert.deepEqual(actual,group.expected,`Independently specified verdicts for ${group.id}`);
  console.log('PASS real checks',JSON.stringify(row));
 }
 receipt.status='PASS';
}catch(error){receipt.status='FAIL';receipt.error=String(error.stack||error);throw error;}
finally{
 for(const controller of signals)controller.abort();
 writeArtifact(artifacts,'results.json',receipt);
 try{await jsonFetch(base,'/api/stop',{method:'POST',headers:csrfHeaders,body:'{}',timeoutMs:10000});}catch{}
 if(child.exitCode===null){child.kill('SIGTERM');await Promise.race([once(child,'exit'),sleep(5000)]);if(child.exitCode===null)child.kill('SIGKILL');}
 fs.closeSync(log);
}

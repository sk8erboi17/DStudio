// Actual HTTP timing/cancellation. --long reproduces the five-minute fetch
// headers cliff without loading an LLM; never count this as model inference.
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {httpJsonRequest, artifactRunDir} from '../support/real_harness.mjs';

const long=process.argv.includes('--long');
const run=artifactRunDir('http-deadline');
const report={scope:'Actual local HTTP only; no model inference',node:process.version,undici:process.versions.undici,
  started:new Date().toISOString(),long,checks:[],status:'running'};
const save=()=>fs.writeFileSync(path.join(run,'results.json'),JSON.stringify(report,null,2)+'\n');
const server=http.createServer((req,res)=>{
  const chunks=[];req.on('data',chunk=>chunks.push(chunk));
  req.on('end',()=>{
    if(req.url==='/delay'||req.url==='/long') {
      const timer=setTimeout(()=>res.end(JSON.stringify({ok:true})),req.url==='/long'?305000:75);
      res.on('close',()=>clearTimeout(timer));
    } else if(req.url==='/stream') {
      res.writeHead(200);res.write('start');
      const timer=setInterval(()=>res.write('more'),10);res.on('close',()=>clearInterval(timer));
    } else if(req.url==='/truncated') {
      res.writeHead(200,{'Content-Length':'100'});res.write('short');setImmediate(()=>res.destroy());
    } else if(req.url==='/large')res.end('x'.repeat(128));
    else {
      if(req.url==='/failure')res.statusCode=503;
      res.end(JSON.stringify({received:Buffer.concat(chunks).toString('utf8'),bytes:Number(req.headers['content-length']||0)}));
    }
  });
});
server.timeout=0;
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${server.address().port}`;
async function check(name,fn){const start=performance.now();const row={name,status:'running'};report.checks.push(row);save();
  try{await fn(row);row.status='pass';}catch(error){row.status='fail';row.error=error.stack;throw error;}
  finally{row.elapsedMs=performance.now()-start;save();}}
try {
  await check('Unicode payload and HTTP error bytes remain observable',async()=>{
    const payload=JSON.stringify({text:'Perché città e π?'});
    const res=await httpJsonRequest(base+'/failure',{method:'POST',body:payload,signal:AbortSignal.timeout(1000)});
    assert.equal(res.status,503);assert.equal(res.ok,false);
    const body=JSON.parse(await res.text());assert.equal(body.received,payload);assert.equal(body.bytes,Buffer.byteLength(payload));
  });
  await check('Delayed headers honor the explicit request signal',async()=>{
    const start=performance.now();const res=await httpJsonRequest(base+'/delay',{signal:AbortSignal.timeout(1000)});
    assert.equal(JSON.parse(await res.text()).ok,true);assert.ok(performance.now()-start>=60);
    await assert.rejects(httpJsonRequest(base+'/delay',{signal:AbortSignal.timeout(15)}),e=>e.code==='ABORT_ERR');
  });
  await check('A total deadline is not extended by incoming body bytes',async()=>{
    const start=performance.now();
    await assert.rejects(httpJsonRequest(base+'/stream',{signal:AbortSignal.timeout(80)}),e=>e.code==='ABORT_ERR'||e.code==='DSTUDIO_HTTP_INTERRUPTED');
    assert.ok(performance.now()-start<1000);
  });
  await check('Response limit and interrupted response fail without hanging',async()=>{
    await assert.rejects(httpJsonRequest(base+'/large',{maxResponseBytes:32,signal:AbortSignal.timeout(1000)}),e=>e.code==='DSTUDIO_HTTP_RESPONSE_LIMIT');
    await assert.rejects(httpJsonRequest(base+'/truncated',{signal:AbortSignal.timeout(1000)}));
    await assert.rejects(httpJsonRequest(base+'/',{maxResponseBytes:0}),/byte limit/);
    await assert.rejects(httpJsonRequest('https://127.0.0.1/'),/requires http/);
  });
  if(long)await check('Real 305-second response outlives the old fetch headers deadline',async row=>{
    row.delayMs=305000;row.explicitDeadlineMs=320000;save();
    const started=performance.now();
    const legacy=fetch(base+'/long',{signal:AbortSignal.timeout(320000)}).then(async response=>({
      outcome:'response',body:await response.text(),elapsedMs:performance.now()-started}),error=>({
      outcome:'error',name:error.name,code:error.cause?.code||error.code,message:error.message,elapsedMs:performance.now()-started}));
    const response=await httpJsonRequest(base+'/long',{signal:AbortSignal.timeout(320000)});
    assert.equal(response.status,200);assert.equal(JSON.parse(await response.text()).ok,true);
    row.nativeElapsedMs=performance.now()-started;assert.ok(row.nativeElapsedMs>=305000);
    row.legacy=await legacy;
    assert.equal(row.legacy.outcome,'error');assert.equal(row.legacy.code,'UND_ERR_HEADERS_TIMEOUT');
  });
  report.status='pass';
  console.log(`PASS explicit HTTP deadlines, bounds and cleanup${long?' including the actual five-minute regression':''}. ${run}`);
}catch(error){report.status='fail';throw error;}
finally{report.finished=new Date().toISOString();save();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}

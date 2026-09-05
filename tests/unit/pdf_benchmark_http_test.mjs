// Transport behavior only; this test does not simulate or score model inference.
import assert from 'node:assert/strict';
import http from 'node:http';
import {postJson} from '../support/pdf_benchmark_http.mjs';

const server=http.createServer((req,res)=>{
  const chunks=[];req.on('data',b=>chunks.push(b));req.on('end',()=>{
    if(req.url==='/slow') {
      const timer=setTimeout(()=>res.end(JSON.stringify({ok:true})),75);
      res.on('close',()=>clearTimeout(timer));
    } else if(req.url==='/invalid')res.end('not json');
    else {
      res.writeHead(req.url==='/failure'?503:200,{'content-type':'application/json'});
      res.end(JSON.stringify({received:JSON.parse(Buffer.concat(chunks)),bytes:Number(req.headers['content-length'])}));
    }
  });
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const base=`http://127.0.0.1:${server.address().port}`;
try {
  const body={question:'Perché π è diverso da pi?',quote:'è'};
  const echo=await postJson(base+'/',body,{'content-type':'application/json'},1000);
  assert.equal(echo.httpStatus,200);assert.deepEqual(echo.result.received,body);
  assert.equal(echo.result.bytes,Buffer.byteLength(JSON.stringify(body)));
  const slow=await postJson(base+'/slow',{}, {},1000);
  assert.equal(slow.result.ok,true);assert.ok(slow.ms>=60);
  await assert.rejects(postJson(base+'/slow',{}, {},15),e=>e.code==='DSTUDIO_BENCH_TIMEOUT'&&e.elapsedMs>=10);
  const failure=await postJson(base+'/failure',{}, {},1000);
  assert.equal(failure.httpStatus,503,'keep HTTP errors observable to the benchmark');
  await assert.rejects(postJson(base+'/invalid',{}, {},1000),/invalid JSON/);
  console.log('PASS: Unicode payload, delayed headers, explicit total timeout, HTTP error, malformed JSON');
}finally{server.closeAllConnections();await new Promise(r=>server.close(r));}

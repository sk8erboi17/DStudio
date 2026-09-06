// Explicit local PDF-library benchmark. Input files are never modified.
// Inventory/reference extraction is separate from DStudio timing/retrieval.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import {execFileSync,spawn} from 'node:child_process';
import assert from 'node:assert/strict';
import {freePort,sleep,csrfHeaders} from '../support/real_harness.mjs';
import {postJson} from '../support/pdf_benchmark_http.mjs';

const [stage, argument, destination] = process.argv.slice(2);
const tool = name => {
  const found=['/opt/homebrew/bin','/usr/local/bin','/usr/bin'].map(d=>path.join(d,name)).find(f=>fs.existsSync(f));
  assert.ok(found, `${name} required; missing dependency is not a pass`);return found;
};
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const save = (file,value) => {
  const pending=`${file}.${process.pid}.pending`;
  fs.writeFileSync(pending,JSON.stringify(value,null,2)+'\n');fs.renameSync(pending,file);
};
const normalize = s => String(s).replace(/\s+/g,' ').trim();
const machine = () => ({platform:os.platform(),arch:os.arch(),cpus:os.cpus()[0]?.model,
  memoryBytes:os.totalmem(),node:process.version});
async function reader(run,label,existingCache) {
  const dir=fs.mkdtempSync(path.join(run,`${label}-`));
  for(const d of ['data','cache','embed','ds4/gguf'])fs.mkdirSync(path.join(dir,d),{recursive:true});
  fs.writeFileSync(path.join(dir,'ds4/Makefile'),'all:\n\t@true\n');
  const port=await freePort(),base=`http://127.0.0.1:${port}`,binary=path.resolve(process.env.DSTUDIO_PDF_BENCH_BIN||'tests/.build/dstudio-server-test');
  const fd=fs.openSync(path.join(dir,'server.log'),'wx');
  const child=spawn(binary,[String(port),path.join(dir,'ds4')],{detached:true,stdio:['ignore',fd,fd],
    env:{...process.env,DS4UI_TEST_MODE:'1',DS4UI_NO_WINDOW:'1',DS4UI_DEFER_ENGINE_START:'1',
      DS4UI_DATA_DIR:path.join(dir,'data'),DSTUDIO_PDF_CACHE_DIR:existingCache||path.join(dir,'cache'),
      DSTUDIO_EMBED_DIR:path.join(dir,'embed'),DS4UI_HOST:'127.0.0.1'}});
  fs.closeSync(fd);
  const stop=async()=>{try{process.kill(-child.pid,'SIGTERM');}catch{}await sleep(300);if(child.exitCode===null&&child.signalCode===null){try{process.kill(-child.pid,'SIGKILL');}catch{}}};
  try {
    let ready=false;
    for(let i=0;i<100;i++){try{if((await fetch(base+'/api/status')).ok){ready=true;break;}}catch{}await sleep(100);}
    assert.ok(ready,'reader did not start');
  }catch(e){await stop();throw e;}
  return {base,dir,stop,identity:{binary,sha256:sha(fs.readFileSync(binary)),pid:child.pid}};
}
async function request(base,body,timeout=1800000) {
  return postJson(base+'/api/pdf/describe',body,csrfHeaders,timeout);
}

if(stage==='inventory') {
  assert.ok(argument,'Usage: node tests/live/pdf_library_benchmark.mjs inventory PDF_DIRECTORY [ARTIFACT_DIRECTORY]');
  const root=fs.realpathSync(argument);
  fs.mkdirSync('tests/.artifacts',{recursive:true});
  const run=destination?path.resolve(destination):fs.mkdtempSync(path.resolve('tests/.artifacts/pdf-library-'));
  fs.mkdirSync(run,{recursive:true});fs.mkdirSync(path.join(run,'reference'),{recursive:true});
  const files=fs.readdirSync(root).filter(f=>/\.pdf$/i.test(f)).sort();
  const report={schema:'dstudio.pdf-library.v1',root,run,started:new Date().toISOString(),
    gitRevision:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),
    sourceSha256:sha(fs.readFileSync('src/dstudio_pdf.c')),machine:machine(),
    poppler:execFileSync(tool('pdftotext'),['-v'],{encoding:'utf8',stdio:['ignore','pipe','pipe']}),
    documents:[]};
  const started=performance.now();
  for(const [index,file] of files.entries()) {
    const full=path.join(root,file),stat=fs.statSync(full),id=String(index+1).padStart(3,'0');
    const row={id,file,bytes:stat.size,mtimeMs:stat.mtimeMs};report.documents.push(row);
    try {
      row.sha256=sha(fs.readFileSync(full));
      row.duplicateOf=report.documents.find(d=>d!==row&&d.sha256===row.sha256)?.id||null;
      const info=execFileSync(tool('pdfinfo'),[full],{encoding:'utf8',timeout:30000,maxBuffer:2**20});
      fs.writeFileSync(path.join(run,'reference',`${id}.info.txt`),info);
      row.pages=Number(info.match(/^Pages:\s+(\d+)/m)?.[1]||0);
      row.title=info.match(/^Title:[ \t]*([^\r\n]*)/m)?.[1]?.trim()||'';
      const output=path.join(run,'reference',`${id}.txt`),start=performance.now();
      execFileSync(tool('pdftotext'),['-layout','-enc','UTF-8',full,output],{timeout:180000,stdio:['ignore','pipe','pipe']});
      row.referenceExtractionMs=performance.now()-start;
      const text=fs.readFileSync(output,'utf8'),pages=text.split('\f');
      if(pages.at(-1)==='')pages.pop();
      row.extractedPages=pages.length;row.textBytes=Buffer.byteLength(text);
      row.sparsePages=pages.map((t,i)=>t.replace(/\s/g,'').length<24?i+1:0).filter(Boolean);
      row.head=text.slice(0,800);
      row.samples=[];
      for(const fraction of [0.2,0.5,0.8]) {
        const anchor=Math.min(pages.length-1,Math.floor(pages.length*fraction));
        let chosen=anchor;
        for(let offset=0;offset<Math.min(12,pages.length);offset++) {
          const p=(anchor+offset)%pages.length;
          if(pages[p].replace(/\s/g,'').length>=350){chosen=p;break;}
        }
        if(chosen>=0&&!row.samples.some(s=>s.page===chosen+1))row.samples.push({page:chosen+1,text:pages[chosen]});
      }
      const after=fs.statSync(full);
      assert.equal(after.size,stat.size);assert.equal(after.mtimeMs,stat.mtimeMs);
      row.status='pass';
    } catch(e) {row.status='fail';row.error=e.message;}
    save(path.join(run,'inventory.json'),report);
    console.log(`${row.id} ${row.status} ${row.pages||'?'} pages ${Math.round(row.bytes/1e6)} MB ${row.referenceExtractionMs?.toFixed(0)||'?'} ms | ${(row.title||row.head||row.file).replace(/\s+/g,' ').slice(0,115)}`);
  }
  report.finished=new Date().toISOString();report.referenceWallMs=performance.now()-started;
  report.summary={files:files.length,bytes:report.documents.reduce((n,d)=>n+d.bytes,0),
    pages:report.documents.reduce((n,d)=>n+(d.pages||0),0),
    failed:report.documents.filter(d=>d.status!=='pass').map(d=>d.id),
    sparsePages:report.documents.reduce((n,d)=>n+(d.sparsePages?.length||0),0)};
  save(path.join(run,'inventory.json'),report);console.log(JSON.stringify({run,...report.summary}));
} else if(stage==='read') {
  const run=fs.realpathSync(argument),inventory=JSON.parse(fs.readFileSync(path.join(run,'inventory.json')));
  const host=await reader(run,'read');
  const report={started:new Date().toISOString(),scope:'Real DStudio complete probe + bounded overview, no planner or answering inference. Cold means new DStudio cache, not a flushed OS disk cache.',reader:host.identity,documents:[]};
  const started=performance.now();
  try {
    for(const doc of inventory.documents) {
      const row={id:doc.id,file:doc.file};report.documents.push(row);
      try {
        const source=path.join(inventory.root,doc.file),stat=fs.statSync(source);
        assert.equal(stat.size,doc.bytes);assert.equal(stat.mtimeMs,doc.mtimeMs);
        const payload={path:source,profile:'complete',max_chars:20*1024,evidence:true};
        const first=await request(host.base,payload,240000);row.probe=first;
        assert.equal(first.httpStatus,200,first.result.error);assert.equal(first.result.ok,true);
        let read=first;
        if(first.result.readPlanRequired)read=await request(host.base,{...payload,profile:'interactive'},240000);
        row.overview=read;assert.equal(read.httpStatus,200,read.result.error);assert.equal(read.result.ok,true);
        row.firstReadMs=first.ms+(read===first?0:read.ms);
        row.selectedPages=[...String(read.result.text||'').matchAll(/--- Pagina (\d+) \(testo\) ---/g)].map(m=>Number(m[1]));
        assert.equal(read.result.total,doc.pages);
        const reference=fs.readFileSync(path.join(run,'reference',`${doc.id}.txt`),'utf8').split('\f');
        for(const page of row.selectedPages)assert.ok(page>=1&&page<=doc.pages);
        if(read.result.completeText) {
          const expected=reference.slice(0,doc.pages).map((s,i)=>`\n--- Pagina ${i+1} (testo) ---\n${s}\n`).join('');
          assert.equal(read.result.text,expected,'complete response must preserve every byte');
        }
        row.warm=[];
        for(let i=0;i<3;i++) {
          const warm=await request(host.base,{...payload,profile:first.result.readPlanRequired?'interactive':'complete'},240000);
          assert.equal(warm.httpStatus,200);assert.equal(warm.result.text,read.result.text);
          row.warm.push({ms:warm.ms,cached:warm.result.cached===true});
        }
        row.status='pass';
      }catch(e){row.status='fail';row.error=e.stack;}
      save(path.join(run,'read.json'),report);
      console.log(`${row.id} ${row.status}: first ${row.firstReadMs?.toFixed(0)} ms; warm ${row.warm?.map(w=>w.ms.toFixed(0)).join('/')} ms; ${row.overview?.result.textPages}/${row.overview?.result.total} text pages in prompt`);
    }
  }finally{await host.stop();report.wallMs=performance.now()-started;report.finished=new Date().toISOString();save(path.join(run,'read.json'),report);}
} else if(stage==='evidence-audit') {
  const run=fs.realpathSync(argument),batchDir=fs.realpathSync(path.join(run,destination));
  assert.ok(batchDir.startsWith(run+path.sep),'audit must use this benchmark\'s own cache');
  const batch=JSON.parse(fs.readFileSync(path.join(batchDir,'retrieval.json')));
  assert.ok(batch.finished,'do not audit a running batch');
  const host=await reader(run,'evidence-audit',path.join(batchDir,'cache'));
  const report={started:new Date().toISOString(),batch:destination,
    scope:'Post-hoc punctuation diagnosis via the real evidence endpoint. Does not replace original benchmark scores.',cases:[]};
  try {
    for(const c of batch.documents.flatMap(d=>d.cases).filter(c=>c.proof?.status==='not_found')) {
      const row={id:c.id,originalQuote:c.quote,variants:[]};report.cases.push(row);
      for(const suffix of ['', '.', ',', ':', ';', ')']) {
        const body={documentId:c.cold.result.documentId,page:c.page,quote:c.quote+suffix,render:false};
        const response=await fetch(host.base+'/api/pdf/evidence',{method:'POST',headers:csrfHeaders,
          body:JSON.stringify(body),signal:AbortSignal.timeout(30000)});
        const result=await response.json();row.variants.push({suffix,httpStatus:response.status,result});
        if(result.status==='matched'||response.status===410)break;
      }
      console.log(`${c.id}: ${row.variants.map(v=>JSON.stringify(v.suffix)+'='+v.result.status).join(', ')}`);
      save(path.join(host.dir,'audit.json'),report);
    }
  }finally{await host.stop();report.finished=new Date().toISOString();save(path.join(host.dir,'audit.json'),report);console.log(host.dir);}
} else if(stage==='retrieval'||stage==='retry') {
  const run=fs.realpathSync(argument),inventory=JSON.parse(fs.readFileSync(path.join(run,'inventory.json')));
  const questions=JSON.parse(fs.readFileSync(path.join(run,'questions.json')));
  const [lo,hi]=(destination||'001-999').split('-').map(Number);
  const docs=inventory.documents.filter(d=>Number(d.id)>=lo&&Number(d.id)<=(hi||lo));
  const cases=questions.cases.filter(c=>docs.some(d=>d.id===c.document));
  for(const doc of docs)assert.ok(cases.some(c=>c.document===doc.id),`missing question for ${doc.id}`);
  for(const c of cases) {
    const pages=fs.readFileSync(path.join(run,'reference',`${c.document}.txt`),'utf8').split('\f');
    if(c.groundTruth==='rendered-page') {
      assert.ok(fs.statSync(path.join(run,c.referenceImage)).size>0,'rendered ground truth required');
      assert.ok(c.expectedLimitation,'visual-only case must declare the extraction limitation');
      assert.ok(!normalize(pages[c.page-1]).includes(normalize(c.quote)),'visual-only control unexpectedly has searchable text');
    } else assert.ok(normalize(pages[c.page-1]).includes(normalize(c.quote)),`invalid source quotation ${c.id}`);
  }
  assert.equal((await fetch('http://127.0.0.1:28101/health',{signal:AbortSignal.timeout(1000)}).catch(()=>null)),null,
    'port 28101 must be free; do not adopt or stop an unrelated embedding server');
  const embeddingBinary=process.env.DSTUDIO_PDF_EMBED_BIN||path.join(process.env.HOME,'.dstudio/llama-embed/llama-b10034/llama-server');
  const model=process.env.DSTUDIO_PDF_EMBED_MODEL;
  assert.ok(model&&fs.statSync(model).size>0,'provide the existing embedding GGUF; this benchmark never downloads models');
  fs.accessSync(embeddingBinary,fs.constants.X_OK);
  const host=await reader(run,stage);
  const flags=['-m',fs.realpathSync(model),'--alias','Qwen/Qwen3-Embedding-0.6B-GGUF:Q8_0','--embeddings','--parallel','1',
    '--batch-size','8192','--ubatch-size','8192','--host','127.0.0.1','--port','28101','-c','8192','-ngl','999','--offline'];
  const fd=fs.openSync(path.join(host.dir,'embedding.log'),'wx');
  const engine=spawn(embeddingBinary,flags,{detached:true,stdio:['ignore',fd,fd],env:{...process.env,DYLD_LIBRARY_PATH:path.dirname(embeddingBinary)}});fs.closeSync(fd);
  const report={started:new Date().toISOString(),scope:'Real DStudio dense + BM25 retrieval over every text page of each file. Frozen source-grounded questions; no answering LLM, no cross-document index.',
    reader:host.identity,machine:machine(),harnessSha256:sha(fs.readFileSync(import.meta.filename)),questionsSha256:sha(JSON.stringify(cases)),embedding:{binary:embeddingBinary,sha256:sha(fs.readFileSync(embeddingBinary)),model:fs.realpathSync(model),modelBytes:fs.statSync(model).size,flags,pid:engine.pid},documents:[]};
  const output=path.join(host.dir,'retrieval.json'),started=performance.now();
  try {
    let ready=false;
    for(let i=0;i<120;i++){try{if((await fetch('http://127.0.0.1:28101/health')).ok){ready=true;break;}}catch{}await sleep(500);}
    assert.ok(ready,'embedding model did not become ready');
    report.embedding.models=await fetch('http://127.0.0.1:28101/v1/models').then(r=>r.json());
    for(const doc of docs) {
      const row={id:doc.id,file:doc.file,cases:[]};report.documents.push(row);save(output,report);
      for(const c of cases.filter(c=>c.document===doc.id)) {
        const item={...c,status:'running',started:new Date().toISOString()};row.cases.push(item);save(output,report);
        console.log(`START ${c.id}: index/search ${doc.pages} pages`);
        try {
          const sourceStat=fs.statSync(path.join(inventory.root,doc.file));
          assert.equal(sourceStat.size,doc.bytes);assert.equal(sourceStat.mtimeMs,doc.mtimeMs);
          const payload={path:path.join(inventory.root,doc.file),profile:'semantic',semantic_query:c.question,max_chars:20*1024,evidence:true};
          const cold=await request(host.base,payload);item.cold=cold;
          if(cold.httpStatus!==200||!cold.result.ok)throw Error(cold.result.error||`HTTP ${cold.httpStatus}`);
          assert.equal(cold.result.hybrid,true);assert.equal(cold.result.total,doc.pages);
          assert.equal(cold.result.documentId,doc.sha256,'retrieval must retain this exact original PDF');
          item.selectedPages=[...cold.result.text.matchAll(/--- Pagina (\d+) \(testo\) ---/g)].map(m=>Number(m[1]));
          item.pageRecall=item.selectedPages.includes(c.page);
          item.quoteRecall=normalize(cold.result.text).includes(normalize(c.quote));
          item.status=item.pageRecall&&item.quoteRecall?'pass':'miss';
          item.retrievalStatus=item.status;
          const warm=await request(host.base,payload,120000);
          assert.equal(warm.httpStatus,200);assert.equal(warm.result.text,cold.result.text);assert.equal(warm.result.cached,true);
          item.warmMs=warm.ms;
          // A different query string bypasses the response cache but reuses the index.
          // This measures index reuse, not a second independent quality question.
          const reuse=await request(host.base,{...payload,semantic_query:'Find the relevant passage. '+c.question});
          item.indexReuse={ms:reuse.ms,httpStatus:reuse.httpStatus,result:reuse.result};
          assert.equal(reuse.httpStatus,200);assert.equal(reuse.result.ok,true);
          assert.equal(reuse.result.embeddingIndexCached,true,'new query must reuse the real embedding index');
          assert.equal(reuse.result.textLayerCached,true);
          assert.notEqual(reuse.result.cached,true,'new query must bypass the response cache');
          if(item.quoteRecall) {
            const proof=await fetch(host.base+'/api/pdf/evidence',{method:'POST',headers:csrfHeaders,
              body:JSON.stringify({documentId:cold.result.documentId,page:c.page,quote:c.quote}),signal:AbortSignal.timeout(30000)}).then(r=>r.json());
            item.proof=proof;
            item.evidenceStatus=proof.status==='matched'&&proof.boxes?.length>0?'pass':'fail';
          }
        }catch(e){
          item.status='error';item.error=e.stack;item.errorCode=e.cause?.code||e.code;item.failedAfterMs=e.elapsedMs;
          if(e.elapsedMs!==undefined) {
            // A disconnected client does not imply the detached PDF worker
            // stopped. Abort and clean up this owned batch before another job
            // can compete with it; retain the incomplete/error receipt.
            item.finished=new Date().toISOString();save(output,report);throw e;
          }
        }
        item.finished=new Date().toISOString();
        save(output,report);
        console.log(`${c.id} ${item.status}: ${item.cold?.ms.toFixed(0)} ms first request, ${item.warmMs?.toFixed(0)} ms warm; pages ${item.selectedPages?.join(',')}; expected ${c.page}`);
      }
    }
    report.status='finished';
  } catch(e){report.status='failed';report.error=e.stack;throw e;}
  finally {
    await host.stop();try{process.kill(-engine.pid,'SIGTERM');}catch{}await sleep(500);
    if(engine.exitCode===null&&engine.signalCode===null){try{process.kill(-engine.pid,'SIGKILL');}catch{}}
    report.finished=new Date().toISOString();report.wallMs=performance.now()-started;save(output,report);console.log(`Evidence: ${output}`);
  }
} else {
  throw Error('Unknown stage. Start with inventory.');
}

// Bounded, deliberately defective pages exercise real browser events. These
// authored fixtures are not generated-project quality or performance scores.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {chromium,webkit} from 'playwright';
import {artifactRunDir,writeArtifact} from '../support/real_harness.mjs';
import {auditProjectView,serveProjectSnapshot} from '../support/design_project_audit.mjs';

const run=artifactRunDir('design-project-resources'), report={scope:'Authored failing fixtures, actual Chromium/WebKit; no LLM',checks:[]};
const content='Sample data. This local fixture tests the browser evidence collector and its cleanup. It makes no network request and contains no generated benchmark output.';
const html=script=>Buffer.from(`<!doctype html><html lang="en"><meta charset="utf-8"><style>body{font:18px system-ui;color:#111;background:#fff;margin:20px}p{max-width:320px;overflow-wrap:anywhere}</style><h1>Audit fixture</h1><p>${content}</p><script>${script}</script></html>`);
async function check(name,body){const row={name};report.checks.push(row);try{await body();row.status='pass';}
  catch(e){row.status='fail';row.error=e.stack;throw e;}finally{writeArtifact(run,'results.json',report);}}
try{
  for(const [engine,type] of [['chromium',chromium],['webkit',webkit]]){
    const browser=await type.launch({headless:true}),unrelated=await browser.newContext();
    let escapedRequests=0;
    const sentinel=http.createServer((req,res)=>{escapedRequests++;res.end('must never be fetched');});
    await new Promise(resolve=>sentinel.listen(0,'127.0.0.1',resolve));
    const sentinelURL=`http://127.0.0.1:${sentinel.address().port}/not-in-project`;
    try{
      const probe=await unrelated.newPage();await probe.setContent('<button>Unrelated context remains live</button>');
      for(const scenario of [
        {id:'late-error',script:'',late:true},
        {id:'count-overflow',script:'for(let i=0;i<200;i++)console.error("fixture error "+i)',limit:'count'},
        {id:'byte-overflow',script:'for(let i=0;i<32;i++)console.error("A".repeat(4000)+i)',limit:'bytes'},
        {id:'detail-overflow',script:'console.error("🪴".repeat(5000))',limit:'detail'},
        {id:'sparse-errors',script:'console.error("first fixture error");console.error("second fixture error")'},
        {id:'opaque-overflow',script:'for(let i=0;i<200;i++)console.error("frame fixture error "+i)',limit:'count',frame:true},
        {id:'script-overflow',script:'for(let i=0;i<200;i++)setTimeout(()=>{throw Error("script fixture "+i)},0)',limit:'count'},
        {id:'network-overflow',script:`for(let i=0;i<200;i++)fetch(${JSON.stringify(sentinelURL)}+i).catch(()=>{})`,limit:'count'},
      ])await check(`${engine}: ${scenario.id} is FAIL and only its own context is closed`,async()=>{
        const server=await serveProjectSnapshot({files:new Map([['index.html',html(scenario.script)]])});
        const settings={id:`${engine}-${scenario.id}`,engine,theme:'light',width:390,textScale:1,interactions:false,frame:!!scenario.frame};
        const record={...settings,checks:[],screenshots:[]};
        const save=()=>writeArtifact(run,`${settings.id}.json`,record);
        // A deterministic terminal barrier: this is a real page console event
        // after the last assertion and before the owning context's close.
        const facade={newContext:async options=>{
          const context=await browser.newContext(options),close=context.close.bind(context);
          if(scenario.late){let injected=false;context.close=async(...args)=>{
            if(!injected){injected=true;record.preCloseChecksPassed=record.checks.every(c=>c.status==='pass');
              await context.pages()[0].evaluate(()=>console.error('late fixture error'));}
            return close(...args);
          };}
          return context;
        }};
        try{
          await auditProjectView(facade,{url:server.base+(settings.frame?'/preview':'/project/index.html'),allowedPrefix:server.base+'/project/'},
            {id:'resource-fixture',requiredText:['Sample data']},settings,run,record,save);
          assert.equal(record.status,'fail','Browser errors discovered at teardown cannot be PASS');
          if(scenario.late){assert.equal(record.preCloseChecksPassed,true);assert.ok(record.problems.some(p=>p.message==='late fixture error'));}
          assert.equal(record.cleanupComplete,true);
          const capture=record.problemCapture;assert.ok(capture);
          assert.ok(record.problems.length<=capture.limits.count);
          assert.ok(Buffer.byteLength(JSON.stringify(record.problems))<=capture.limits.bytes);
          assert.equal(capture.exceeded,Boolean(scenario.limit));
          if(scenario.limit)assert.equal(capture.reason,scenario.limit);
          if(scenario.id==='count-overflow')assert.equal(record.problems.length,capture.limits.count);
          if(scenario.id==='detail-overflow'){
            assert.equal(record.problems[0].truncated,true);
            assert.ok(!record.problems[0].message.includes('\uFFFD'),'Do not split Unicode while bounding evidence');
            assert.ok(Buffer.byteLength(record.problems[0].message)<=capture.limits.detailBytes);
          }
          if(scenario.id==='sparse-errors')assert.deepEqual(record.problems.map(p=>p.message),['first fixture error','second fixture error']);
          if(scenario.id==='script-overflow')assert.ok(record.problems.some(p=>p.kind==='script-error'));
          if(scenario.id==='network-overflow')assert.ok(record.problems.some(p=>p.kind==='external-request'));
          assert.equal(escapedRequests,0,'Generated page contacted a non-project endpoint');
          assert.deepEqual(browser.contexts(),[unrelated]);
          assert.equal(await probe.getByRole('button').textContent(),'Unrelated context remains live');
        }finally{await server.close();}
      });
    }finally{await unrelated.close();await browser.close();sentinel.closeAllConnections();await new Promise(resolve=>sentinel.close(resolve));}
  }
  report.passed=true;
}catch(e){report.passed=false;report.error=e.stack;process.exitCode=1;}
finally{report.finished=new Date().toISOString();writeArtifact(run,'results.json',report);console.log(JSON.stringify({run,...report}));}

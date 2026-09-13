// Native Qwen parser and derived prompt/tool checks. Real native linking,
// deterministic model text, no model loading or inference-quality claim.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {artifactRunDir, writeArtifact} from '../support/real_harness.mjs';
import {ownGitRevision} from '../support/quality_baseline.mjs';
const root=path.resolve(import.meta.dirname,'../..');
assert.equal(process.platform,'darwin','This native link test currently targets macOS');
assert(process.argv[2],'Supply an already built Qwen3.8 candidate');
const engine=fs.realpathSync(process.argv[2]);
const upstream=process.argv.includes('--upstream');
const sanitize=process.argv.includes('--sanitize');
const run=artifactRunDir('qwen38-agent');
const report={started:new Date().toISOString(),scope:'Native Qwen parser/prompts/tools; identity double, no inference',
  upstream,engine,sanitizers:sanitize?'ASan/UBSan on Agent/parser/helper C objects; upstream engine objects not instrumented':'not enabled',
  commands:[],passed:false};
const hash=data=>crypto.createHash('sha256').update(data).digest('hex');
const save=()=>writeArtifact(run,'results.json',report);
function command(exe,args,cwd=root,extraEnv={}){
 const result=spawnSync(exe,args,{cwd,encoding:'utf8',timeout:120000,maxBuffer:16*1024*1024,
  env:{...process.env,...extraEnv}});
 const row={exe,args,status:result.status,signal:result.signal,error:String(result.error||'')};
 report.commands.push(row);save();
 writeArtifact(run,`command-${report.commands.length}.json`,{...row,stdout:result.stdout,stderr:result.stderr});
 assert.equal(result.status,0,result.stderr||result.error?.message||`Process ended: ${result.signal || result.status}`);return result.stdout;
}
try{
 const includes=[run,engine,path.join(root,'extension/remote'),path.join(root,'extension/cowork'),path.join(root,'patch/ds4-agent-jsonl')];
 const flags=['-O1','-std=c11',...(sanitize?['-g','-fno-omit-frame-pointer','-fsanitize=address,undefined','-fno-sanitize-recover=all']:[]),
  ...includes.flatMap(p=>['-I',p])];
 // An extracted source archive must never acquire the surrounding project's
 // Git identity. Exact source/object hashes remain recorded without Git.
 report.engineGit=ownGitRevision(engine);
 report.compiler=command('cc',['--version']).trim();
 report.sourceSHA256=hash(fs.readFileSync(path.join(engine,'ds4_agent.c')));
 if(upstream)fs.copyFileSync(path.join(engine,'ds4_agent.c'),path.join(run,'ds4_agent.c'));
 else{
  const emit=path.join(run,'emit');
  command('cc',['-O1','-std=c11','tests/support/emit_agent_patch.c','-o',emit]);
  command(emit,[path.join(engine,'ds4_agent.c'),path.join(run,'ds4_agent.c')]);
  command(emit,[path.join(engine,'ds4_web.c'),path.join(run,'ds4_web.c'),'--web']);
 }
 report.derivedSHA256=hash(fs.readFileSync(path.join(run,'ds4_agent.c')));
 const objects=['ds4','ds4_image','ds4_distributed','ds4_tp','ds4_ssd','ds4_metal',
  'ds4_layer_pack','ds4_help','ds4_prompt_prefix','ds4_kvstore','linenoise'].map(name=>path.join(engine,`${name}.o`));
 report.engineObjects=objects.map(file=>({file:path.basename(file),sha256:hash(fs.readFileSync(file))}));
 const gpuArgs=path.join(run,'gpu-args.o');
 command('cc',[...flags,'-c',path.join(engine,'ds4_gpu_args.c'),'-o',gpuArgs]);objects.push(gpuArgs);
 if(upstream)objects.push(path.join(engine,'ds4_web.o'));
 else for(const [name,source] of [['web',path.join(run,'ds4_web.c')],
  ['cowork',path.join(root,'extension/cowork/ds4_cowork.c')],
  ['remote',path.join(root,'extension/remote/dstudio_remote_llm.c')],
  ['pld',path.join(root,'patch/ds4-agent-jsonl/pld_core.c')]]){
  const output=path.join(run,`${name}.o`);command('cc',[...flags,'-c',source,'-o',output]);objects.push(output);
 }
 const binary=path.join(run,'probe');
 command('cc',[...flags,...(upstream?[]:['-DDSTUDIO_TEST_DERIVED']),'-Wno-unused-function',
  path.join(root,'tests/support/qwen38_agent_probe.c'),...objects,'-lm','-pthread',
  '-framework','Foundation','-framework','Metal','-o',binary]);
 const workspace=path.join(run,'workspace');fs.mkdirSync(workspace);
 fs.writeFileSync(path.join(run,'outside.md'),'outside fixture stays unchanged\n',{flag:'wx'});
 const output=command(binary,[],workspace,{DS4UI_COWORK_HELPER:path.join(root,'extension/cowork/office_tool.py')});
 report.rows=output.trim().split('\n').map(line=>JSON.parse(line));
 assert.equal(report.rows.find(row=>row.case==='upstream-agent-units').failures,0);
 assert.equal(report.rows.find(row=>row.case==='literal-markup-fragmentation').failures,0);
 assert.equal(report.rows.find(row=>row.case==='json-document-delimiter-escapes').failures,0);
 if(!upstream){
  const rows=report.rows.filter(row=>row.case==='prompt');assert.equal(rows.length,8);
  for(const row of rows){
   const open=row.text.indexOf('<tools>'),close=row.text.indexOf('</tools>',open);
   // These are runtime-produced schemas, not inspection of source literals.
   // Keep native Qwen's one complete JSON schema per nonempty line format.
   assert(open>=0&&close>open);
   const tools=row.text.slice(open+7,close).trim().split('\n').filter(line=>line.trim()).map(line=>JSON.parse(line));
   assert(tools.every(v=>v.type==='function'&&v.function?.name));
   const names=tools.map(v=>v.function.name);assert.equal(new Set(names).size,names.length);
   assert(names.includes('read')&&names.includes('write')&&names.includes('edit'));
   assert.equal(names.includes('view_image'),Boolean(row.vision));
   for(const name of ['document_table','excel','read_document','write_document','write_pdf','presentation'])
    assert.equal(names.includes(name),Boolean(row.cowork),name);
   assert(row.text.includes('<function=')&&row.text.includes('<parameter='));
  }
  assert(report.rows.some(row=>row.case==='real-tool-write'&&row.passed));
  assert(report.rows.some(row=>row.case==='real-cowork-documents'&&row.passed&&row.rejectedWrites===2));
  const events=report.rows.find(row=>row.case==='tool-events').text.split('\x1e').slice(1)
    .map(frame=>JSON.parse(frame.split('\n')[0]));
  const calls=events.filter(e=>e.type==='tool_call'),results=events.filter(e=>e.type==='tool_result');
  assert.equal(calls.length,5);assert.equal(results.length,5);
  assert.equal(fs.readFileSync(path.join(run,'outside.md'),'utf8'),'outside fixture stays unchanged\n');
 }
 report.passed=true;console.log('Qwen native protocol checks: PASS; model responses simulated');
}catch(e){report.error=String(e.stack);process.exitCode=1;console.error(report.error);}
finally{report.finished=new Date().toISOString();save();console.log(run);}

// Actual native parser, linking and local document actions. Model identity/text
// are simulated; this gate makes no inference or answer-quality claim.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {artifactRunDir,writeArtifact} from '../support/real_harness.mjs';
import {ownGitRevision} from '../support/quality_baseline.mjs';
const root=path.resolve(import.meta.dirname,'../..');
assert.equal(process.platform,'darwin','This native link gate currently targets macOS');
assert(process.argv[2],'Supply an already-built pinned Qwen3.6 engine');
const engine=fs.realpathSync(process.argv[2]);
const upstream=process.argv.includes('--upstream'),sanitize=process.argv.includes('--sanitize');
const run=artifactRunDir('qwen35-agent');
const report={started:new Date().toISOString(),scope:'Real native Qwen3.6 parser/prompts/tools; simulated model; no inference',
 engine,upstream,sanitizers:sanitize?'ASan/UBSan on Agent and DStudio C helpers only; prebuilt upstream objects not instrumented':'not enabled',commands:[],passed:false};
const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
const save=()=>writeArtifact(run,'results.json',report);
function command(exe,args,cwd=root,env={}){
 const r=spawnSync(exe,args,{cwd,encoding:'utf8',timeout:120000,maxBuffer:16*1024*1024,env:{...process.env,...env}});
 const row={exe,args,status:r.status,signal:r.signal,error:String(r.error||'')};report.commands.push(row);save();
 writeArtifact(run,`command-${report.commands.length}.json`,{...row,stdout:r.stdout,stderr:r.stderr});
 assert.equal(r.status,0,r.stderr||r.error?.message||`Process ended: ${r.signal||r.status}`);return r.stdout;
}
try{
 const flags=['-O1','-std=c11',...(sanitize?['-g','-fno-omit-frame-pointer','-fsanitize=address,undefined','-fno-sanitize-recover=all']:[]),
 ...[run,engine,path.join(root,'extension/remote'),path.join(root,'extension/cowork'),path.join(root,'patch/ds4-agent-jsonl')].flatMap(p=>['-I',p])];
 report.engineGit=ownGitRevision(engine);report.compiler=command('cc',['--version']);
 report.sourceSHA256=hash(fs.readFileSync(path.join(engine,'ds4_agent.c')));
 if(upstream)fs.copyFileSync(path.join(engine,'ds4_agent.c'),path.join(run,'ds4_agent.c'));
 else{
  const emitter=path.join(run,'emit');command('cc',['-O1','-std=c11','tests/support/emit_agent_patch.c','-o',emitter]);
  command(emitter,[path.join(engine,'ds4_agent.c'),path.join(run,'ds4_agent.c')]);
  command(emitter,[path.join(engine,'ds4_web.c'),path.join(run,'ds4_web.c'),'--web']);
 }
 report.derivedSHA256=hash(fs.readFileSync(path.join(run,'ds4_agent.c')));
 const objects=['ds4','ds4_distributed','ds4_tp','ds4_ssd','ds4_metal','ds4_layer_pack','ds4_help','ds4_kvstore','linenoise','ds4_gpu_args'].map(n=>path.join(engine,`${n}.o`));
 report.engineObjects=objects.map(file=>({file:path.basename(file),sha256:hash(fs.readFileSync(file))}));
 if(upstream)objects.push(path.join(engine,'ds4_web.o'));
 else for(const [name,file] of [['web',path.join(run,'ds4_web.c')],['cowork',path.join(root,'extension/cowork/ds4_cowork.c')],
  ['remote',path.join(root,'extension/remote/dstudio_remote_llm.c')],['pld',path.join(root,'patch/ds4-agent-jsonl/pld_core.c')]]){
  const object=path.join(run,`${name}.o`);command('cc',[...flags,'-c',file,'-o',object]);objects.push(object);
 }
 const binary=path.join(run,'probe');command('cc',[...flags,...(upstream?[]:['-DDSTUDIO_TEST_DERIVED']),'-Wno-unused-function',
  'tests/support/qwen35_agent_probe.c',...objects,'-lm','-pthread','-framework','Foundation','-framework','Metal','-o',binary]);
 const workspace=path.join(run,'workspace');fs.mkdirSync(workspace);
 fs.writeFileSync(path.join(run,'outside.md'),'Outside fixture stays unchanged.\n',{flag:'wx'});
 report.rows=command(binary,[],workspace,{DS4UI_COWORK_HELPER:path.join(root,'extension/cowork/office_tool.py')})
  .trim().split('\n').map(line=>JSON.parse(line));
 assert.equal(report.rows.find(r=>r.case==='native-agent-regressions').failures,0);
 assert.equal(report.rows.find(r=>r.case==='fragmentation-and-literal-markup').failures,0);
 if(!upstream){
  const prompts=report.rows.filter(r=>r.case.endsWith('-prompt'));assert.equal(prompts.length,4);
  for(const row of prompts){
   const start=row.text.indexOf('<tools>'),end=row.text.indexOf('</tools>',start);assert(start>=0&&end>start);
   const schemas=row.text.slice(start+7,end).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
   assert(schemas.every(s=>s.type==='function'&&s.function?.name));
   const names=schemas.map(s=>s.function.name);assert.equal(new Set(names).size,names.length);
   for(const name of ['read','write','edit'])assert(names.includes(name));
   assert(!names.includes('view_image'),'This native Qwen3.6 fork has no image tool');
   for(const name of ['document_table','excel','read_document','write_document','write_pdf','presentation'])
    assert.equal(names.includes(name),row.case==='cowork-prompt',name);
  }
  assert(report.rows.some(r=>r.case==='real-local-tools'&&r.passed&&r.rejectedEffects===3));
  const events=report.rows.find(r=>r.case==='tool-events').text.split('\x1e').slice(1).map(frame=>JSON.parse(frame.split('\n')[0]));
  assert.equal(events.filter(e=>e.type==='tool_call').length,6);assert.equal(events.filter(e=>e.type==='tool_result').length,6);
  assert.equal(fs.readFileSync(path.join(run,'outside.md'),'utf8'),'Outside fixture stays unchanged.\n');
 }
 report.passed=true;console.log('Qwen3.6 native parser/local tools: PASS (model simulated)');
}catch(error){report.error=String(error.stack||error);console.error(report.error);process.exitCode=1;}
finally{report.finished=new Date().toISOString();save();console.log(run);}

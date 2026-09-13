// Diagnostic patch lifecycle and actual Metal command options. Failure objects
// are simulated: this gate does not claim to reproduce the driver's watchdog.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {artifactRunDir, writeArtifact} from '../support/real_harness.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const run = artifactRunDir('q36-metal-diagnostics');
const tree = path.join(run, 'source'); fs.mkdirSync(tree);
const patch = path.join(root, 'patch/q36-metal-diagnostics/runtime.patch');
let source;
const report = {started: new Date().toISOString(), passed: false, commands: [],
  scope: 'Actual Metal submission/options; simulated errors/formatter; no LLM or driver-failure qualification'};
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
const save = () => writeArtifact(run, 'results.json', report);
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(GIT_|Q36_|DYLD_)/.test(k)));
Object.assign(env, {GIT_CEILING_DIRECTORIES:run, GIT_CONFIG_NOSYSTEM:'1', GIT_CONFIG_GLOBAL:'/dev/null'});
const code = path.join(tree, 'q36_metal.m');
function command(name, binary, args, cwd=tree, overrides={}) {
  const row = {name, binary, args}; report.commands.push(row); save();
  const r = spawnSync(binary, args, {cwd, env:{...env,...overrides}, timeout:60000, maxBuffer:1024*1024});
  Object.assign(row, {status:r.status, signal:r.signal, error:r.error?.message,
    stdout:r.stdout?.toString() || '', stderr:r.stderr?.toString() || ''}); save();
  assert.ifError(r.error); assert.equal(r.status,0,row.stderr);
  return row;
}
const script = path.join(root,'scripts/apply-q36-metal-diagnostics.sh');
const lifecycle = (name,action) => command(name,'/bin/sh',[script,action],tree,{Q36_DIR:tree});
try {
  assert.equal(process.platform, 'darwin', 'Metal unavailable: NOT RUN');
  assert.equal(process.argv.length,3,'Supply one built, reviewed q36 directory');
  source = fs.realpathSync(process.argv[2]);
  const files = ['q36_metal.m','q36_ssd.o','q36_gpu_core_metal.o','q36_image.o',
    ...fs.readdirSync(source).filter(n=>n.endsWith('.h') || n.endsWith('.inc')),
    ...fs.readdirSync(path.join(source,'metal')).filter(n=>n.endsWith('.metal')).map(n=>'metal/'+n)];
  report.inputs = {};
  for (const name of files) {
    const p = path.join(source,name), s = fs.lstatSync(p);
    assert(s.isFile() && s.size < 64*1024*1024 && fs.realpathSync(p) === p);
    report.inputs[name] = hash(fs.readFileSync(p));
  }
  report.patchSHA256 = hash(fs.readFileSync(patch));
  report.scriptSHA256 = hash(fs.readFileSync(script));
  report.harnessSHA256 = hash(fs.readFileSync(import.meta.filename));
  const probe = path.join(root,'tests/support/q36_metal_diagnostics_probe.m');
  report.probeSHA256 = hash(fs.readFileSync(probe));
  fs.copyFileSync(path.join(source,'q36_metal.m'),code);
  lifecycle('restore-copied-candidate','restore');
  const original = fs.readFileSync(code);
  fs.appendFileSync(code,'\n/* unrelated source retained by lifecycle fixture */\n');
  const baseline = fs.readFileSync(code);
  lifecycle('check','check'); lifecycle('apply','apply'); const adapted = fs.readFileSync(code);
  lifecycle('repeat-apply','apply'); assert.deepEqual(fs.readFileSync(code),adapted);
  lifecycle('restore','restore'); lifecycle('repeat-restore','restore');
  assert.deepEqual(fs.readFileSync(code),baseline);
  lifecycle('reapply','apply');
  const binary = path.join(run,'diagnostics-probe');
  command('build','clang',['-O2','-fno-fast-math','-ffp-contract=off','-fobjc-arc',
    `-DDSTUDIO_Q36_METAL_SOURCE=${JSON.stringify(code)}`,'-I',source,probe,
    'q36_ssd.o','q36_gpu_core_metal.o','q36_image.o',
    '-framework','Foundation','-framework','Metal','-lm','-pthread','-o',binary],source);
  report.binarySHA256 = hash(fs.readFileSync(binary));
  for (const setting of [undefined,'1','0','invalid']) {
    const on = setting === '1';
    const r = command('run-'+String(setting),binary,[on?'on':'off'],source,
      setting === undefined ? {} : {Q36_METAL_ERROR_DETAILS:setting});
    const data = JSON.parse(r.stdout); assert.equal(data.passed,true); assert.equal(data.diagnostics,on);
    assert.equal((r.stderr.match(/q36: Metal diagnostic phase=/g)||[]).length,on?4:0);
    assert.equal((r.stderr.match(/q36: Metal encoder index=/g)||[]).length,on?192:0);
    assert(r.stderr.length < 65536, 'Diagnostic byte limit exceeded');
    if (on) {
      assert(r.stderr.includes('encoders=100 shown=64'));
      assert(r.stderr.includes('encoders=0 shown=0'));
      for (let state=0;state<5;state++) assert(r.stderr.includes(`state=${state} label=`));
    }
  }
  lifecycle('final-restore','restore'); assert.deepEqual(fs.readFileSync(code),baseline);
  // Construct a real partial patch application; assertions concern atomic
  // rejection and preserved bytes, not text patterns in production source.
  const patchText = fs.readFileSync(patch,'utf8');
  const firstHunk = patchText.indexOf('\n@@');
  const secondHunk = patchText.indexOf('\n@@',firstHunk+1);
  assert(firstHunk > 0 && secondHunk > firstHunk);
  const partialPatch = path.join(run,'partial.patch');
  fs.writeFileSync(partialPatch,patchText.slice(0,secondHunk)+'\n');
  command('construct-partial','git',['apply',partialPatch]);
  const partial = fs.readFileSync(code);
  const partialRejected = spawnSync('/bin/sh',[script,'apply'],{cwd:tree,env:{...env,Q36_DIR:tree},timeout:10000});
  assert.equal(partialRejected.status,1); assert.deepEqual(fs.readFileSync(code),partial);
  report.partialRejected=true; fs.writeFileSync(code,baseline);
  fs.writeFileSync(code,baseline.subarray(0,1024));
  const drift = fs.readFileSync(code);
  const rejected = spawnSync('/bin/sh',[script,'apply'],{cwd:tree,env:{...env,Q36_DIR:tree},timeout:10000});
  assert.equal(rejected.status,1); assert.deepEqual(fs.readFileSync(code),drift);
  report.driftRejected=true;
  fs.writeFileSync(code,original);
  report.inputsPreserved = files.every(n => hash(fs.readFileSync(path.join(source,n))) === report.inputs[n]);
  assert(report.inputsPreserved); report.passed=true;
} catch (e) {report.error=e.stack; process.exitCode=1;}
finally {report.finished=new Date().toISOString();save();console.log(JSON.stringify({run,passed:report.passed,error:report.error}));}

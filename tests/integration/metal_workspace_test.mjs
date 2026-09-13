// Real GPU initialization from an unrelated workspace through the production
// child environment. Model-free: a tiny scalar oracle, not LLM quality/parity.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {artifactRunDir, writeArtifact} from '../support/real_harness.mjs';
import {ownGitRevision} from '../support/quality_baseline.mjs';

const root = path.resolve(import.meta.dirname, '../..');
assert.equal(process.platform, 'darwin', 'Real Metal hardware is required; no silent skip');
assert(process.argv.length >= 4, 'Supply the host probe and already-built engine directories');
const host = fs.realpathSync(process.argv[2]);
const engines = process.argv.slice(3).map(file => fs.realpathSync(file));
const run = artifactRunDir('metal-workspace');
const workspace = path.join(run, 'unrelated workspace with spaces');
fs.mkdirSync(workspace);
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
const report = {started:new Date().toISOString(), scope:'Native Metal initialization and 257 exact GPU additions per run; no model inference',
  host:{path:host, sha256:hash(fs.readFileSync(host))}, engines:[], passed:false};
const save = () => writeArtifact(run, 'results.json', report);
// An inherited shader override or optimization must not make a missing host
// path pass by accident. Only the child's environment changes, never user settings.
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^DS4(?:UI)?_/.test(key)));
async function command(row, label, exe, args, cwd, extraEnv = {}) {
  const file = `${report.engines.length}-${label}.log`, fd = fs.openSync(path.join(run, file), 'wx');
  const entry = {label, command:[exe,...args], cwd, log:file};
  row.commands.push(entry); save();
  const start = performance.now();
  const child = spawn(exe, args, {cwd, detached:true, stdio:['ignore',fd,fd], env:{...env,...extraEnv}});
  const timer = setTimeout(() => { entry.timeout = true; try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 120000);
  const result = await new Promise(resolve => {
    child.once('error', e => resolve({error:String(e)}));
    child.once('exit', (code, signal) => resolve({code,signal}));
  });
  clearTimeout(timer); fs.closeSync(fd);
  Object.assign(entry, result, {seconds:(performance.now()-start)/1000}); save();
  assert(!entry.timeout && result.code === 0 && !result.signal, `${label} failed; see ${file}`);
  return fs.readFileSync(path.join(run, file), 'utf8');
}
for (const engine of engines) {
  const row = {engine, revision:ownGitRevision(engine), commands:[], passed:false};
  report.engines.push(row); save();
  try {
    const inputs = ['ds4_gpu.h','ds4_metal.m','ds4_metal.o'];
    // Older forks do not have a separate image object. A fork that does have
    // that source must supply its built object, never silently omit it.
    if (fs.existsSync(path.join(engine, 'ds4_image.c'))) inputs.push('ds4_image.c','ds4_image.o');
    row.inputs = inputs.map(file => ({file, sha256:hash(fs.readFileSync(path.join(engine,file)))}));
    row.shaders = fs.readdirSync(path.join(engine,'metal')).filter(file=>file.endsWith('.metal')).sort()
      .map(file=>({file,sha256:hash(fs.readFileSync(path.join(engine,'metal',file)))}));
    const binary = path.join(run, `gpu-${report.engines.length}`);
    await command(row, 'compile', 'cc', ['-O1','-std=c11','-I',engine,
      path.join(root,'tests/support/metal_workspace_probe.c'),...inputs.filter(f=>f.endsWith('.o')).map(f=>path.join(engine,f)),
      '-framework','Foundation','-framework','Metal','-lm','-o',binary], root);
    for (const location of ['engine','workspace']) {
      const output = location === 'engine'
        ? await command(row, location, binary, [], engine)
        : await command(row, location, host, [root,engine,'metal-sources',binary], workspace,
          {DS4_METAL_DENSE_SOURCE:path.join(workspace,'stale-dense.metal')});
      const receipt = JSON.parse(output.trim().split('\n').at(-1));
      assert.deepEqual(receipt,{initialized:true,gpuAddChecks:257});
    }
    row.passed = true;
  } catch (error) { row.error = String(error.stack); console.error(row.error); }
  save();
  console.log(`${path.basename(engine)}: ${row.passed?'PASS':'FAIL'}`);
}
report.passed = report.engines.every(row=>row.passed);
report.finished = new Date().toISOString(); save();
if (!report.passed) process.exitCode = 1;
console.log(`Preserved Metal workspace evidence: ${run}`);

// Execute production supplemental Makefiles against each upstream Makefile.
// Native and DStudio link commands must select the same backend tool, flags,
// libraries and core objects. Compiler outputs are explicit stand-ins, not
// successful CUDA/ROCm compilation or inference. Real Metal builds are separate.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {artifactRunDir, writeArtifact} from '../support/real_harness.mjs';
import {ownGitRevision} from '../support/quality_baseline.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const run = artifactRunDir('backend-link');
const sources = process.argv.slice(2);
if (!sources.length) sources.push('ds4', 'ds4-laguna-s21', 'ds4-qwen38', 'ds4-qwen35');
const report = {scope: 'Real GNU Make backend routing with simulated compilers/linkers; no inference',
  started: new Date().toISOString(), cases: [], passed: false};
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
const save = () => writeArtifact(run, 'results.json', report);
const supplemental = path.join(root, 'patch/ds4-agent-jsonl/build.mk');
const design = path.join(root, 'extension/design/design.mk');
const probe = path.join(root, 'tests/support/build_link_probe.mjs');
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const tool = name => `${quote(process.execPath)} ${quote(probe)} ${name}`;
const common = [`CC=${tool('cc')}`, `NVCC=${tool('nvcc')}`, `HIPCC=${tool('hipcc')}`];
report.inputs = [supplemental, design, probe].map(file => ({file, sha256: hash(fs.readFileSync(file))}));

function snapshot(source, dest) {
  const directories = new Set(['metal', 'cuda', 'rocm', 'third_party', 'tests']);
  function copy(rel = '') {
    for (const entry of fs.readdirSync(path.join(source, rel), {withFileTypes: true})) {
      const name = path.join(rel, entry.name);
      if (entry.isDirectory() && (rel || directories.has(entry.name))) copy(name);
      else if (entry.isFile() && (/\.(?:c|h|m|mm|inc|metal|cu|cuh)$/.test(name) || entry.name === 'Makefile')) {
        const file = path.join(dest, name);
        fs.mkdirSync(path.dirname(file), {recursive: true});
        fs.copyFileSync(path.join(source, name), file, fs.constants.COPYFILE_EXCL);
      }
    }
  }
  copy();
}
function make(row, label, args, cwd, reject = false) {
  const log = path.join(run, `${row.id}-${label}.jsonl`);
  fs.writeFileSync(log, '', {flag: 'wx'});
  const result = spawnSync('make', ['-j1', ...args], {cwd, encoding: 'utf8',
    timeout: 60000, maxBuffer: 8 * 1024 * 1024, env: {...process.env,
      MAKEFLAGS: '', MFLAGS: '', DSTUDIO_LINK_WORK: run, DSTUDIO_LINK_LOG: log}});
  fs.writeFileSync(path.join(run, `${row.id}-${label}.log`), result.stdout + result.stderr, {flag: 'wx'});
  row.commands.push({label, args, code: result.status, error: result.error?.message}); save();
  assert(!result.error, `${label}: ${result.error}`);
  if (reject) assert.notEqual(result.status, 0, `${label}: invalid backend must be rejected`);
  else assert.equal(result.status, 0, `${label}: ${result.stderr}`);
  return fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}
function link(rows, output) {
  const matches = rows.filter(row => !row.args.includes('-c') &&
    row.args.includes('-o') && path.basename(row.args[row.args.indexOf('-o') + 1]) === output);
  assert.equal(matches.length, 1, `Exactly one real Make link command for ${output}`);
  const row = matches[0], start = row.args.indexOf('-o');
  const objects = row.args.filter(arg => arg.endsWith('.o'));
  const last = Math.max(...objects.map(object => row.args.lastIndexOf(object)));
  return {...row, prefix: row.args.slice(0, start), objects, libraries: row.args.slice(last + 1)};
}
try {
  for (const [index, input] of sources.entries()) {
    const source = fs.realpathSync(input);
    const identity = {source, git: ownGitRevision(source), makefileSHA256: hash(fs.readFileSync(path.join(source, 'Makefile')))};
    for (const backend of ['metal', 'cpu', 'cuda', 'rocm']) {
      const row = {id: `${index}-${backend}`, backend, identity, commands: [], passed: false};
      report.cases.push(row); save();
      try {
        const cwd = path.join(run, row.id); fs.mkdirSync(cwd); snapshot(source, cwd);
        let selected = [...common, `UNAME_S=${backend === 'metal' ? 'Darwin' : 'Linux'}`];
        if (backend === 'cpu') selected.push('CFLAGS=-O1 -DDS4_NO_GPU');
        if (backend === 'rocm') {
          const captures = make(row, 'select-rocm', ['rocm', ...selected, `MAKE=${tool('make')}`], cwd);
          const calls = captures.filter(call => call.tool === 'make');
          assert.equal(calls.length, 1, 'Upstream must select one bounded recursive build');
          selected.push(...calls[0].args.filter(arg => arg.includes('=') && !arg.startsWith('-')));
        }
        const native = link(make(row, 'native', [backend === 'cpu' ? 'cpu' : 'ds4-agent', ...selected], cwd), 'ds4-agent');
        const derivedRows = make(row, 'jsonl', ['-f', supplemental, './ds4-agent-jsonl', './ds4-server-pld', ...selected,
          'JSONL_AGENT_SRC=ds4_agent.c', 'JSONL_WEB_SRC=ds4_web.c', 'JSONL_SERVER_SRC=ds4_server.c',
          `DSTUDIO_REMOTE_DIR=${path.join(root, 'extension/remote')}`, `DSTUDIO_COWORK_DIR=${path.join(root, 'extension/cowork')}`], cwd);
        const designRows = make(row, 'design', ['-f', design, 'ds4-design', ...selected,
          `DESIGN_SRC=${path.join(root, 'extension/design/ds4_design.c')}`, `REMOTE_DIR=${path.join(root, 'extension/remote')}`], cwd);
        const frontend = new Set(['ds4_agent.o', 'ds4_agent_cpu.o', 'ds4_help.o', 'ds4_prompt_prefix.o',
          'ds4_web.o', 'ds4_kvstore.o', 'linenoise.o', 'ds4_gpu_args.o', 'ds4_gpu_args_cpu.o']);
        const nativeCore = native.objects.filter(object => !frontend.has(object));
        row.native = native; row.derived = [];
        for (const [name, rows] of [['ds4-agent-jsonl', derivedRows], ['ds4-server-pld', derivedRows], ['ds4-design', designRows]]) {
          const derived = link(rows, name); row.derived.push({name, ...derived}); save();
          assert.equal(derived.tool, native.tool, `${name}: backend linker must match upstream`);
          assert.deepEqual(derived.prefix, native.prefix, `${name}: backend link flags must match upstream`);
          assert.deepEqual(derived.libraries, native.libraries, `${name}: backend libraries must match upstream`);
          for (const object of nativeCore) {
            // The additive PLD core is a documented Metal-only replacement.
            if (object === 'ds4.o' && name !== 'ds4-design' && backend === 'metal' && derived.objects.includes('ds4_pld_core.o')) continue;
            assert(derived.objects.includes(object), `${name}: missing upstream core ${object}`);
          }
          if (backend === 'cpu') {
            assert(derived.objects.includes('ds4_cpu.o'), `${name}: CPU must link its CPU core`);
            assert(!derived.objects.some(object => /ds4_(metal|cuda|rocm)/.test(object)), 'CPU must not link a GPU core');
          }
        }
        for (const [name, file, variable] of [['ds4-agent-jsonl', supplemental, 'JSONL_LINK'], ['ds4-design', design, 'DESIGN_LINK']]) {
          const before = hash(fs.readFileSync(path.join(cwd, name)));
          const calls = make(row, `reject-${variable}`, ['-f', file, name, ...selected, `${variable}=`], cwd, true);
          assert.equal(calls.length, 0, 'Missing backend linker must be rejected before any compiler work');
          assert.equal(hash(fs.readFileSync(path.join(cwd, name))), before, 'Rejected selection must preserve the existing output');
        }
        assert.equal(hash(fs.readFileSync(path.join(source, 'Makefile'))), identity.makefileSHA256, 'Original source preserved');
        row.passed = true;
      } catch (error) { row.error = String(error.stack || error); }
      save(); console.log(`${path.basename(source)}/${backend}: ${row.passed ? 'PASS' : 'FAIL'}`);
    }
  }
  report.passed = report.cases.every(row => row.passed);
  if (!report.passed) process.exitCode = 1;
} catch (error) { report.error = String(error.stack || error); process.exitCode = 1; }
finally { report.finished = new Date().toISOString(); save(); console.log(`Backend routing evidence: ${run}`); }

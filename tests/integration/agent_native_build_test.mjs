// Real native builds and tool execution; model responses remain explicit fixtures.
// Snapshot only build sources into a unique test-owned directory. Never copy
// weights, reuse existing objects, or rebuild the supplied engine checkouts.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

assert.equal(process.platform, 'darwin', 'This native build gate currently qualifies macOS only');
const backend = process.env.DSTUDIO_AGENT_BUILD_BACKEND || 'metal';
const designOnly = process.env.DSTUDIO_NATIVE_DESIGN_ONLY === '1';
assert(['metal', 'cpu'].includes(backend), 'This host can qualify native Metal or CPU builds, not CUDA/ROCm');
const root = path.resolve(import.meta.dirname, '../..');
const inputs = process.argv.slice(2);
assert(inputs.length >= 2 && inputs.length <= 4, 'Supply main and Laguna; optionally add Qwen3.8 and Qwen3.6 source directories');
const parent = path.join(root, 'tests/.artifacts/agent-native-build');
fs.mkdirSync(parent, { recursive: true });
const output = fs.mkdtempSync(path.join(parent, 'run-'));
const host = process.env.DSTUDIO_AGENT_BUILD_HOST ? fs.realpathSync(process.env.DSTUDIO_AGENT_BUILD_HOST) : null;
const buildHost = host || path.join(root, 'tests/.build/agent-build-probe');
const buildArgs = engine => host ? ['--build-jsonl', engine] : [root, engine, 'build'];
const receipt = { scope: `Native ${backend} compilation/linking and real tools with simulated model responses; no inference or weights`, backend, designOnly,
  buildHost, started: new Date().toISOString(), runs: [], passed: false };
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const supportFiles = ['patch/ds4-agent-jsonl/remote-agent.cfrag', 'patch/ds4-agent-jsonl/remote-tools.cfrag',
  ...['manifest','main-v41.patch','main-current.patch','main-previous.patch','laguna.patch','qwen38.patch','qwen38-next.patch','qwen35.patch','pld_core.c',
    'pld_agent.inc','pld_agent_rewind.h','pld_agent_compaction.h','compaction_text.h'].map(f => `patch/ds4-agent-jsonl/${f}`),
  'patch/ds4-agent-jsonl/build.mk', 'extension/remote/dstudio_remote_llm.c', 'extension/remote/dstudio_remote_llm.h',
  'extension/remote/dstudio_wire_string.h', 'extension/remote/dstudio_json_tokens.h', 'extension/cowork/ds4_cowork.c',
  'tests/integration/remote_structured_tools_test.mjs', 'tests/unit/remote_turn_error_unit.c', 'src/dstudio_task_executor.c',
  'tests/support/agent_structured_probe.c', 'tests/support/agent_idle_probe.c'];
const ownerProbe = fs.realpathSync(process.env.DSTUDIO_STRUCTURED_OWNER_PROBE || path.join(root, 'tests/.build/remote-turn-error-unit'));
receipt.nativeProbes = [buildHost, ownerProbe].map(file => ({ file, sha256: digest(fs.readFileSync(file)) }));
receipt.support = supportFiles.map(file => {
  const bytes = fs.readFileSync(path.join(root, file)), target = path.join(output, 'support', file);
  fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(path.join(root, file), target);
  return { file, sha256: digest(bytes) };
});
const save = () => fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(receipt, null, 2) + '\n');
// Managed patch reversibility also depends on its native test sources.
const sourceDirs = new Set(['metal', 'cuda', 'rocm', 'third_party', 'tests']);
const sourceFile = name => /\.(?:c|h|m|mm|inc|metal|cu|cuh)$/.test(name) || name === 'Makefile' || name === '.gitignore';
function snapshot(input, dest) {
  const files = [];
  function visit(rel = '') {
    for (const entry of fs.readdirSync(path.join(input, rel), { withFileTypes: true })) {
      const name = path.join(rel, entry.name);
      if (entry.isDirectory() && (rel || sourceDirs.has(entry.name))) visit(name);
      else if (entry.isFile() && sourceFile(entry.name)) {
        const from = path.join(input, name), to = path.join(dest, name), data = fs.readFileSync(from);
        assert(data.length <= 32 * 1024 * 1024, `Oversized build source: ${name}`);
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
        files.push({ path: name, bytes: data.length, sha256: digest(data) });
      } else if (entry.isSymbolicLink() && sourceFile(entry.name)) {
        throw new Error(`Refusing linked source: ${name}`);
      }
    }
  }
  visit();
  for (const required of ['ds4_agent.c', 'ds4_web.c', 'ds4.c', 'ds4.h', 'Makefile', 'ds4_metal.m'])
    assert(files.some(file => file.path === required), `Missing build prerequisite ${required}`);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}
async function run(row, label, command, args, cwd = root, extraEnv = {}) {
  const start = performance.now(), log = path.join(output, `${row.name}-${label}.log`);
  const fd = fs.openSync(log, 'wx');
  const entry = { label, command: [command, ...args], log: path.basename(log) };
  row.commands.push(entry); save();
  // Limit one compiler at a time; the caller's parallel Make flags cannot fan out.
  const child = spawn(command, args, { cwd, detached: true, stdio: ['ignore', fd, fd],
    env: { ...process.env, MAKEFLAGS: '', MFLAGS: '',
      ...(backend === 'cpu' ? { CFLAGS: '-O1 -std=c11 -DDS4_NO_GPU',
        DS4UI_JSONL_CFLAGS: '-O1 -std=c11 -DDS4_NO_GPU', DS4UI_JSONL_CORE_OBJS: '', DS4UI_JSONL_LDLIBS: '' } : {}),
      ...extraEnv,
      ...(host ? { DS4UI_DATA_DIR: path.join(output, 'packaged-support'), DS4UI_NO_WINDOW: '1', DS4UI_DEFER_ENGINE_START: '1' } : {}) } });
  let timeout = false;
  const timer = setTimeout(() => { timeout = true; try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 300000);
  const result = await new Promise(resolve => {
    child.once('error', error => resolve({ error: String(error) }));
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(timer); fs.closeSync(fd);
  Object.assign(entry, result, { timeout, seconds: (performance.now() - start) / 1000 }); save();
  assert(!timeout && !result.error && result.code === 0 && !result.signal,
    `${row.name}/${label} failed; preserved ${log}`);
  console.log(`${row.name}/${label}: PASS (${entry.seconds.toFixed(2)} s)`);
}
async function designBuild(row) {
  await run(row, 'design-build', buildHost,
    host ? ['--build-design', row.engine] : [root, row.engine, 'design'], host ? '/' : root);
  const design = path.join(row.engine, 'ds4-design');
  row.binaries.push({file:'ds4-design',bytes:fs.statSync(design).size,sha256:digest(fs.readFileSync(design))});
  await run(row,'design-tools',process.execPath,[path.join(root,'tests/integration/runtime_steering_test.mjs'),design]);
  await run(row,'design-stop',process.execPath,[path.join(root,'tests/integration/runtime_model_interrupt_test.mjs'),design]);
}
try {
  for (const [i, input] of inputs.entries()) {
    const name = ['main', 'laguna', 'qwen38', 'qwen35'][i], source = fs.realpathSync(input);
    const engine = path.join(output, `${name} engine`);
    fs.mkdirSync(engine);
    const row = { name, source, engine, files: snapshot(source, engine), commands: [] };
    receipt.runs.push(row); save();
    const original = new Map(['ds4_agent.c', 'ds4_web.c', 'ds4_server.c'].map(file => [file, fs.readFileSync(path.join(engine, file))]));
    if (designOnly) {
      row.binaries=[];
      await designBuild(row);
      for(const file of row.files) {
        assert.equal(digest(fs.readFileSync(path.join(engine,file.path))),file.sha256,`Design changed snapshot input: ${file.path}`);
        assert.equal(digest(fs.readFileSync(path.join(source,file.path))),file.sha256,`Design changed supplied checkout: ${file.path}`);
      }
      row.passed=true;save();continue;
    }
    await run(row, 'build', buildHost, buildArgs(engine), host ? '/' : root);
    if (host) {
      row.packagedPatches = ['manifest', 'main-v41.patch', 'main-current.patch', 'main-previous.patch', 'laguna.patch', 'qwen38.patch', 'qwen38-next.patch', 'qwen35.patch', 'pld_agent_compaction.h', 'compaction_text.h', 'remote-agent.cfrag'].map(file => {
        const relative = path.join('patch/ds4-agent-jsonl', file);
        const sha256 = digest(fs.readFileSync(path.join(output, 'packaged-support', relative)));
        assert.equal(sha256, digest(fs.readFileSync(path.join(root, relative))), `Packaged input differs: ${file}`);
        return { file, sha256 };
      });
      for (const relative of ['patch/ds4-web-runtime/manifest', 'patch/ds4-web-runtime/browser.patch',
        'patch/ds4-server-pld/manifest', 'patch/ds4-server-pld/main-current.patch', 'patch/ds4-server-pld/main-previous.patch']) {
        const sha256 = digest(fs.readFileSync(path.join(output, 'packaged-support', relative)));
        assert.equal(sha256, digest(fs.readFileSync(path.join(root, relative))), `Packaged input differs: ${relative}`);
        row.packagedPatches.push({ file: relative, sha256 });
      }
    }
    for (const [file, bytes] of original) assert.deepEqual(fs.readFileSync(path.join(engine, file)), bytes,
      `Builder changed original ${file}`);
    row.binaries = ['ds4-agent-jsonl', 'ds4-cowork'].map(file => ({ file,
      bytes: fs.statSync(path.join(engine, file)).size, sha256: digest(fs.readFileSync(path.join(engine, file))) }));
    await run(row, 'tools', process.execPath, [path.join(root, 'tests/integration/runtime_steering_test.mjs'),
      ...row.binaries.map(file => path.join(engine, file.file))]);
    await run(row, 'stop', process.execPath, [path.join(root, 'tests/integration/runtime_model_interrupt_test.mjs'),
      ...row.binaries.map(file => path.join(engine, file.file))]);
    // Exercise the actual native renderer, including upstream's original unit
    // suite, with and without a JSONL worker. Use the same backend Make link;
    // only private Agent/helper objects are instrumented, not GPU/core objects.
    const renderer = path.join(engine, 'renderer-check'); fs.mkdirSync(renderer);
    const emitter = path.join(renderer, 'emit');
    await run(row, 'renderer-emitter', 'cc', ['-O1', '-std=c11',
      path.join(root, 'tests/support/emit_agent_patch.c'), '-o', emitter]);
    await run(row, 'renderer-source', emitter, [path.join(engine,'ds4_agent.c'),path.join(renderer,'agent-runtime.c')]);
    await run(row, 'renderer-web', emitter, [path.join(engine,'ds4_web.c'),path.join(renderer,'web.c'),'--web']);
    fs.copyFileSync(path.join(root,'tests/support/agent_renderer_probe.c'),path.join(renderer,'probe.c'));
    await run(row, 'renderer-build', 'make', ['-f',path.join(root,'patch/ds4-agent-jsonl/build.mk'),
      'JSONL_OUT=renderer-check','JSONL_AGENT_SRC=renderer-check/probe.c','JSONL_WEB_SRC=renderer-check/web.c',
      `JSONL_CFLAGS=-O1 -g -std=c11 -fno-omit-frame-pointer -fsanitize=address,undefined -fno-sanitize-recover=all${backend==='cpu'?' -DDS4_NO_GPU':''}`,
      `DSTUDIO_REMOTE_DIR=${path.join(root,'extension/remote')}`,`DSTUDIO_COWORK_DIR=${path.join(root,'extension/cowork')}`,
      `DSTUDIO_PLD_DIR=${path.join(root,'patch/ds4-agent-jsonl')}`,'renderer-check/ds4-agent-jsonl'],engine);
    await run(row, 'renderer', path.join(renderer,'ds4-agent-jsonl'), [], renderer);
    const structured = path.join(engine, 'structured-check'); fs.mkdirSync(structured);
    await run(row, 'structured-build', 'make', ['-f',path.join(root,'patch/ds4-agent-jsonl/build.mk'),
      'JSONL_OUT=structured-check','JSONL_AGENT_SRC=renderer-check/agent-runtime.c','JSONL_WEB_SRC=renderer-check/web.c',
      `JSONL_CFLAGS=-O1 -g -std=c11 -fno-omit-frame-pointer -fsanitize=address,undefined -fno-sanitize-recover=all${backend==='cpu'?' -DDS4_NO_GPU':''}`,
      `DSTUDIO_REMOTE_DIR=${path.join(root,'extension/remote')}`,`DSTUDIO_COWORK_DIR=${path.join(root,'extension/cowork')}`,
      `DSTUDIO_PLD_DIR=${path.join(root,'patch/ds4-agent-jsonl')}`,'structured-check/ds4-agent-jsonl'],engine);
    await run(row, 'structured-tools', process.execPath, [path.join(root,'tests/integration/remote_structured_tools_test.mjs'),
      path.join(engine,'ds4-agent-jsonl'), path.join(structured,'ds4-agent-jsonl')], root,
      { DSTUDIO_STRUCTURED_OWNER_PROBE: ownerProbe });
    fs.mkdirSync(path.join(engine, 'bounded-check'));
    await run(row, 'structured-bounds-build', 'make', ['-f',path.join(root,'patch/ds4-agent-jsonl/build.mk'),
      'JSONL_OUT=bounded-check',`JSONL_AGENT_SRC=${path.join(root,'tests/support/agent_structured_probe.c')}`,
      'JSONL_WEB_SRC=renderer-check/web.c',
      `JSONL_CFLAGS=-O1 -g -std=c11 -Irenderer-check -fno-omit-frame-pointer -fsanitize=address,undefined -fno-sanitize-recover=all${backend==='cpu'?' -DDS4_NO_GPU':''}`,
      `DSTUDIO_REMOTE_DIR=${path.join(root,'extension/remote')}`,`DSTUDIO_COWORK_DIR=${path.join(root,'extension/cowork')}`,
      `DSTUDIO_PLD_DIR=${path.join(root,'patch/ds4-agent-jsonl')}`,'bounded-check/ds4-agent-jsonl'],engine);
    await run(row, 'structured-bounds', path.join(engine,'bounded-check/ds4-agent-jsonl'), [], engine);
    fs.mkdirSync(path.join(engine, 'idle-check'));
    await run(row, 'idle-build', 'make', ['-f', path.join(root, 'patch/ds4-agent-jsonl/build.mk'),
      'JSONL_OUT=idle-check', `JSONL_AGENT_SRC=${path.join(root, 'tests/support/agent_idle_probe.c')}`,
      'JSONL_WEB_SRC=renderer-check/web.c',
      `JSONL_CFLAGS=-O1 -g -std=c11 -Irenderer-check -fno-omit-frame-pointer -fsanitize=address,undefined -fno-sanitize-recover=all${backend==='cpu'?' -DDS4_NO_GPU':''}`,
      `DSTUDIO_REMOTE_DIR=${path.join(root, 'extension/remote')}`, `DSTUDIO_COWORK_DIR=${path.join(root, 'extension/cowork')}`,
      `DSTUDIO_PLD_DIR=${path.join(root, 'patch/ds4-agent-jsonl')}`, 'idle-check/ds4-agent-jsonl'], engine);
    await run(row, 'idle-owner', path.join(engine, 'idle-check/ds4-agent-jsonl'), [], engine);
    await run(row, 'repeat', buildHost, buildArgs(engine), host ? '/' : root);
    // The application skips the unsupported Qwen PLD adapter by selected model,
    // not by the host CLI's default DeepSeek preference. Exercise that actual
    // admission with the selected Qwen identity in a native probe.
    const qwenServer = name === 'qwen38' || name === 'qwen35';
    await run(row, 'server-build', qwenServer ? path.join(root,'tests/.build/agent-build-probe') : buildHost,
      qwenServer ? [root, engine, `server-${name}`] :
        host ? ['--build-server-pld', engine] : [root, engine, 'server'], host && !qwenServer ? '/' : root);
    if (name === 'main') {
      const file = 'ds4-server-pld', binary = path.join(engine, file);
      assert(fs.statSync(binary).isFile());
      row.binaries.push({ file, bytes: fs.statSync(binary).size, sha256: digest(fs.readFileSync(binary)) });
      await run(row, 'server-cli', binary, ['--help'], engine);
    } else {
      assert(!fs.existsSync(path.join(engine, 'ds4-server-pld')), `${name} must retain its native unsupported Chat PLD ABI`);
      row.serverPLD = 'unsupported ABI; not an inference qualification';
    }
    await designBuild(row);
    for (const [file, bytes] of original) assert.deepEqual(fs.readFileSync(path.join(engine, file)), bytes,
      `Builder changed original ${file}`);
    for (const file of row.files) assert.equal(digest(fs.readFileSync(path.join(source, file.path))), file.sha256,
      `The supplied source checkout changed: ${file.path}`);
    row.passed = true; save();
  }
  for (const file of receipt.support) assert.equal(digest(fs.readFileSync(path.join(root, file.file))), file.sha256,
    `First-party support changed during the native gate: ${file.file}`);
  for (const probe of receipt.nativeProbes) assert.equal(digest(fs.readFileSync(probe.file)), probe.sha256,
    `Native harness changed during the gate: ${probe.file}`);
  receipt.passed = true;
} catch (error) {
  receipt.error = String(error.stack || error); process.exitCode = 1;
  console.error(receipt.error);
} finally {
  receipt.finished = new Date().toISOString(); save();
  console.log(`Preserved native build evidence: ${output}`);
}

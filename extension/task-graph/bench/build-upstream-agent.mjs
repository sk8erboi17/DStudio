// Builds the clean upstream ds4-agent of the six-agent comparison: the pinned
// antirez/ds4 sources bundled in src/engines/ds4, copied and verified by
// scripts/bundled_engine_sources.py into a directory this build owns, and
// compiled with upstream's own Makefile. No DStudio patch is applied, no
// installed engine is read or written, nothing is downloaded and no model is
// opened (the only program run afterwards is `ds4-agent --help`).
//
//   node extension/task-graph/bench/build-upstream-agent.mjs [--output DIR] [--jobs N]
//
// The default output is tests/.artifacts/upstream-agent-clean/<commit>. A
// finished build is reused only while its receipt still matches the bundled
// manifest, the copied sources and the binary; anything else is refused, never
// repaired in place: remove the directory and build again.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const UPSTREAM_AGENT_RECEIPT = 'upstream-agent.json';
export const UPSTREAM_AGENT_SCHEMA = 'dstudio.upstream-agent-build.v1';

const sha256File = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

export function bundledMain(repoRoot = REPO_ROOT) {
  const file = path.join(repoRoot, 'src', 'engines', 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  const main = manifest.engines?.main;
  if (!main?.commit || !main.files) throw new Error('src/engines/manifest.json has no main engine');
  return { commit: main.commit, repository: main.repository, files: main.files, manifestSHA256: sha256File(file) };
}

// DSTUDIO_UPSTREAM_AGENT_DIR names another build directory (a test states the
// machine it plans for); it is verified exactly like the default one.
export function defaultUpstreamAgentDir(repoRoot = REPO_ROOT) {
  if (process.env.DSTUDIO_UPSTREAM_AGENT_DIR) return path.resolve(process.env.DSTUDIO_UPSTREAM_AGENT_DIR);
  return path.join(repoRoot, 'tests', '.artifacts', 'upstream-agent-clean', bundledMain(repoRoot).commit.slice(0, 12));
}

// Names of the copied source files whose bytes are not the bundled ones.
function alteredSources(sourceDir, files) {
  return Object.entries(files).filter(([name, metadata]) => {
    try {
      return sha256File(path.join(sourceDir, name)) !== metadata.sha256;
    } catch {
      return true;
    }
  }).map(([name]) => name);
}

// { ok, reason, receipt }: whether `dir` holds a clean upstream agent built
// from the sources this repository bundles now. Reads files only.
export function inspectUpstreamAgent(dir = defaultUpstreamAgentDir(), repoRoot = REPO_ROOT) {
  let bundled;
  try {
    bundled = bundledMain(repoRoot);
  } catch (error) {
    return { ok: false, reason: error.message };
  }
  const receiptFile = path.join(dir, UPSTREAM_AGENT_RECEIPT);
  if (!fs.existsSync(receiptFile))
    return { ok: false, reason: `no clean upstream build at ${dir}: run node extension/task-graph/bench/build-upstream-agent.mjs` };
  let receipt;
  try {
    receipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
  } catch (error) {
    return { ok: false, reason: `unreadable build receipt ${receiptFile}: ${error.message}` };
  }
  if (receipt.schema !== UPSTREAM_AGENT_SCHEMA) return { ok: false, reason: `unknown build receipt schema in ${receiptFile}` };
  if (receipt.commit !== bundled.commit || receipt.manifestSHA256 !== bundled.manifestSHA256)
    return { ok: false, reason: `the clean upstream build at ${dir} is of ${receipt.commit}, the bundled pin is ${bundled.commit}` };
  if (!Array.isArray(receipt.patchesApplied) || receipt.patchesApplied.length)
    return { ok: false, reason: 'the build receipt names applied patches: not a clean upstream build' };
  const binary = path.join(dir, 'ds4', 'ds4-agent');
  if (!fs.existsSync(binary) || sha256File(binary) !== receipt.binarySHA256)
    return { ok: false, reason: `ds4-agent at ${binary} is missing or is not the binary the receipt records` };
  const altered = alteredSources(path.join(dir, 'ds4'), bundled.files);
  if (altered.length) return { ok: false, reason: `sources beside the binary differ from the bundled pin: ${altered.slice(0, 3).join(', ')}` };
  return { ok: true, binary, receipt };
}

export function buildUpstreamAgent({ output = defaultUpstreamAgentDir(), jobs = 4, repoRoot = REPO_ROOT, log = console.log } = {}) {
  const bundled = bundledMain(repoRoot);
  if (fs.existsSync(output)) {
    const existing = inspectUpstreamAgent(output, repoRoot);
    if (existing.ok) {
      log(`upstream_agent_build: reusing the verified build at ${output}`);
      return existing;
    }
    if (fs.readdirSync(output).length) throw new Error(`${output} is not empty and holds no valid build (${existing.reason}); remove it first`);
  }
  fs.mkdirSync(output, { recursive: true });
  const source = path.join(output, 'ds4');
  const run = (command, args, options) => {
    const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...options });
    return { status: result.status, output: `${result.stdout || ''}${result.stderr || ''}`, error: result.error?.message };
  };
  // Copies only files recorded in src/engines/manifest.json and fails when a
  // bundled file is missing or altered; it has no remote fallback.
  const copied = run('python3', [path.join(repoRoot, 'scripts', 'bundled_engine_sources.py'),
    '--engine', 'main', '--revision', bundled.commit, '--target', source], { cwd: repoRoot });
  fs.writeFileSync(path.join(output, 'copy.log'), copied.output);
  if (copied.status !== 0) throw new Error(`bundled ds4 sources could not be copied: ${copied.output.trim() || copied.error}`);
  // Upstream's own rule for its agent, with upstream's default flags and the
  // backend its Makefile selects for this platform. Compiling uses the CPU
  // only; the binary is not started with a model here.
  const environment = { PATH: process.env.PATH || '', HOME: process.env.HOME || '', TMPDIR: process.env.TMPDIR || '', LANG: 'C' };
  const startedAt = Date.now();
  const built = run('make', ['-C', source, `-j${Math.max(1, Number(jobs) || 1)}`, 'ds4-agent'], { env: environment, timeout: 3_600_000 });
  fs.writeFileSync(path.join(output, 'build.log'), built.output);
  const binary = path.join(source, 'ds4-agent');
  if (built.status !== 0 || !fs.existsSync(binary))
    throw new Error(`make ds4-agent failed (status ${built.status}); see ${path.join(output, 'build.log')}`);
  const altered = alteredSources(source, bundled.files);
  if (altered.length) throw new Error(`the build changed bundled sources: ${altered.slice(0, 5).join(', ')}`);
  const help = run(binary, ['--help'], { cwd: output, env: environment, timeout: 60_000 });
  if (help.status !== 0 || !/Usage: ds4-agent/.test(help.output) || !/--non-interactive/.test(help.output))
    throw new Error(`the built ds4-agent did not print its help (status ${help.status})`);
  const receipt = {
    schema: UPSTREAM_AGENT_SCHEMA,
    engine: 'main',
    repository: bundled.repository,
    commit: bundled.commit,
    manifestSHA256: bundled.manifestSHA256,
    sourceFiles: Object.keys(bundled.files).length,
    sourcesVerifiedAfterBuild: true,
    patchesApplied: [],
    makeTarget: 'ds4-agent',
    platform: `${process.platform} ${process.arch}`,
    compiler: run('cc', ['--version'], {}).output.split('\n')[0],
    buildSeconds: Math.round((Date.now() - startedAt) / 1000),
    binarySHA256: sha256File(binary),
    binaryBytes: fs.statSync(binary).size,
    modelLoaded: false,
    builtAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(output, UPSTREAM_AGENT_RECEIPT), `${JSON.stringify(receipt, null, 2)}\n`);
  log(`upstream_agent_build: built ${binary} from ds4 ${bundled.commit.slice(0, 12)} with no patch in ${receipt.buildSeconds} s`);
  return { ok: true, binary, receipt };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const value = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
  try {
    if (args.includes('--check')) {
      const state = inspectUpstreamAgent(value('--output') ? path.resolve(value('--output')) : undefined);
      console.log(state.ok ? `upstream_agent_build: verified ${state.binary}` : `upstream_agent_build: BLOCKED ${state.reason}`);
      process.exit(state.ok ? 0 : 1);
    }
    buildUpstreamAgent({ output: value('--output') ? path.resolve(value('--output')) : undefined, jobs: value('--jobs') });
  } catch (error) {
    console.error(`upstream_agent_build: FAILED ${error.message}`);
    process.exit(1);
  }
}

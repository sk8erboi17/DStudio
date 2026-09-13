// Read-only source/weight capture. Only a new ignored receipt directory is written.
// Hash one file at a time with a bounded buffer; never load weights into memory.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export function fileIdentity(st) {
  return [st.dev, st.ino, st.size, st.mtimeNs, st.ctimeNs].map(String).join(':');
}

export async function hashStableFile(file) {
  const handle = await fs.promises.open(file, 'r');
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) throw Error(`Not a regular file: ${file}`);
    const hash = crypto.createHash('sha256');
    const buffer = Buffer.allocUnsafe(4 * 1024 * 1024);
    let bytes = 0;
    for (;;) {
      const read = await handle.read(buffer, 0, buffer.length, null);
      if (!read.bytesRead) break;
      hash.update(buffer.subarray(0, read.bytesRead));
      bytes += read.bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    const current = await fs.promises.stat(file, { bigint: true });
    if (fileIdentity(before) !== fileIdentity(after) ||
        fileIdentity(before) !== fileIdentity(current) || BigInt(bytes) !== before.size) {
      throw Error(`File changed while hashing: ${file}`);
    }
    return { bytes, identity: fileIdentity(before), sha256: hash.digest('hex') };
  } finally {
    await handle.close();
  }
}

function git(dir, args, options = {}) {
  return execFileSync('git', ['-C', dir, ...args], {
    encoding: 'utf8', timeout: 30000, maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'], ...options,
  });
}

// git -C on an extracted archive can otherwise report DStudio's parent HEAD.
export function ownGitRevision(dir) {
  try {
    const top = fs.realpathSync(git(dir, ['rev-parse', '--show-toplevel']).trim());
    if (top !== fs.realpathSync(dir)) return null;
    return { head: git(dir, ['rev-parse', 'HEAD']).trim(),
      status: git(dir, ['status', '--porcelain=v1', '-uall']) };
  } catch { return null; }
}

const managedEngines = ['ds4', 'ds4-laguna-s21', 'ds4-qwen38', 'ds4-qwen35', 'q36'];

// Mirror the launcher's persisted checkout and fixed sibling search. Never
// enumerate a home directory, File Provider tree, or unrelated application data.
export function discoverInstallations(root, {
  environment = process.env, home = os.homedir(), platform = os.platform(), extraEngines = [],
} = {}) {
  const dataRoots = [];
  if (environment.DS4UI_DATA_DIR) dataRoots.push(path.resolve(environment.DS4UI_DATA_DIR));
  if (platform === 'darwin') dataRoots.push(path.join(home, 'Library/Application Support/DStudio'));
  else if (platform === 'win32') {
    if (environment.LOCALAPPDATA) dataRoots.push(path.join(environment.LOCALAPPDATA, 'DStudio'));
  } else dataRoots.push(path.join(environment.XDG_CONFIG_HOME || path.join(home, '.config'), 'dstudio'));
  const bases = new Set([path.resolve(root), ...dataRoots]);
  const candidates = new Set(extraEngines.map(dir => path.resolve(dir)));
  const profiles = [], errors = [];
  for (const data of new Set(dataRoots)) {
    const file = path.join(data, 'engine-checkout');
    try {
      // The production setting is a single bounded line, never arbitrary JSON
      // or conversation storage. Record only this setting and its provenance.
      const st = fs.statSync(file);
      if (!st.isFile() || st.size > 4096) throw Error('Invalid or oversized engine-checkout setting');
      const bytes = fs.readFileSync(file), selected = bytes.toString('utf8').split(/[\r\n]/, 1)[0];
      if (!selected || selected.includes('\0') || !path.isAbsolute(selected))
        throw Error('Persisted engine checkout is empty or not an absolute path');
      profiles.push({ file, selected, sha256: crypto.createHash('sha256').update(bytes).digest('hex') });
      candidates.add(selected); bases.add(path.dirname(selected));
    } catch (error) {
      if (error.code !== 'ENOENT') errors.push({ file, error: error.message });
    }
  }
  for (const base of bases) for (const name of managedEngines) candidates.add(path.join(base, name));
  const directories = new Map(), missing = [];
  for (const dir of candidates) {
    try {
      const real = fs.realpathSync(dir), st = fs.statSync(real);
      if (!st.isDirectory()) throw Error('Engine location is not a directory');
      if (directories.has(real)) directories.get(real).aliases.push(dir);
      else directories.set(real, { directory: real, aliases: [dir] });
    } catch (error) {
      if (error.code === 'ENOENT') missing.push(dir);
      else errors.push({ file: dir, error: error.message });
    }
  }
  return { dataRoots: [...new Set(dataRoots)], profiles, directories: [...directories.values()], missing, errors };
}

export function modelInventory(stores) {
  const files = new Map(), missingStores = [], errors = [];
  for (const store of stores) {
    if (!fs.existsSync(store)) { missingStores.push(store); continue; }
    let names;
    try { names = fs.readdirSync(store).sort(); }
    catch (error) { errors.push({ file: store, error: error.message }); continue; }
    for (const name of names) {
      if (!/\.(gguf|q27|tok|safetensors|incomplete|part)$/i.test(name)) continue;
      const file = path.join(store, name);
      let st;
      try { st = fs.statSync(file, { bigint: true }); }
      catch (error) { errors.push({ file, error: error.message }); continue; }
      if (!st.isFile()) continue;
      const key = `${st.dev}:${st.ino}`;
      if (files.has(key)) { files.get(key).aliases.push(file); continue; }
      const excluded = /(?:DeepSeek.*(?:V4[-_]Pro|[-_]Pro[-_])|GLM[-_]5[._]2)/i.test(name);
      const partial = /\.(incomplete|part)$/i.test(name);
      const component = /(?:^|[-_.])(?:encoder|projector|mmproj|ple|draft|tokenizer|mtp)(?:[-_.]|$)|dspark[-_]support/i.test(name) || /\.tok$/i.test(name);
      files.set(key, { file: fs.realpathSync(file), aliases: [file], bytes: Number(st.size),
        kind: partial ? 'partial' : component ? 'component' : 'checkpoint',
        status: excluded ? 'OUT_OF_SCOPE' : 'NOT_VERIFIED',
        reason: excluded ? 'DeepSeek Pro or unsupported GLM 5.2: preserved, never loaded by this campaign' :
          partial ? 'Partial artifact: never evidence of installed weights' : 'Inventory only, not inference readiness' });
    }
  }
  return { files: [...files.values()], missingStores, errors };
}

function sourceFiles(dir, prefix = '') {
  const out = [];
  for (const entry of fs.readdirSync(path.join(dir, prefix), { withFileTypes: true })) {
    if (entry.name.startsWith('.') || ['gguf', 'node_modules', 'build', 'target', '__pycache__'].includes(entry.name)) continue;
    const rel = path.join(prefix, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(dir, rel));
    else if (entry.isFile() && /(?:\.(?:c|cc|cpp|h|hpp|m|mm|metal|cu|cuh|comp|glsl|spv|inc|mk|cmake|sh|py|frag|cfrag)|(?:^|\/)(?:Makefile|CMakeLists\.txt))$/.test(rel)) out.push(rel);
  }
  return out.sort();
}

export async function captureBaseline(root, {
  fullWeights = false, extraStores = [], extraEngines = [], discoveryOptions = {},
} = {}) {
  root = fs.realpathSync(root);
  const parent = path.join(root, 'tests/.artifacts/quality-multihardware');
  fs.mkdirSync(parent, { recursive: true });
  const run = fs.mkdtempSync(path.join(parent, 'baseline-'));
  const write = (name, data) => fs.writeFileSync(path.join(run, name), data, { flag: 'wx', mode: 0o600 });
  const json = (name, value) => write(name, JSON.stringify(value, null, 2) + '\n');
  const receipt = { schema: 'dstudio.quality-baseline.v1', started: new Date().toISOString(),
    scope: 'Private source/build/weight provenance, NOT model correctness or runtime qualification.',
    host: { platform: os.platform(), release: os.release(), arch: os.arch(),
      cpu: os.cpus()[0]?.model, cpus: os.cpus().length, memoryBytes: os.totalmem() },
    repository: ownGitRevision(root), engines: [], files: [], errors: [] };
  console.log(`Baseline receipt: ${run}`);
  // Before any implementation, preserve the complete staged + unstaged change.
  write('worktree.patch', git(root, ['diff', '--binary', 'HEAD'], { encoding: 'buffer' }));
  const gitFiles = git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']).split('\0').filter(Boolean);
  for (const rel of [...new Set(gitFiles)].sort()) {
    const file = path.join(root, rel);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) continue;
    receipt.files.push({ path: rel, ...await hashStableFile(file) });
  }
  const discovery = discoverInstallations(root, { ...discoveryOptions, extraEngines });
  json('installation-paths.json', discovery);
  receipt.errors.push(...discovery.errors);
  const stores = [...extraStores];
  for (const location of discovery.directories) {
    const real = location.directory;
    // Root-level checkpoints are also valid native engine inputs.
    for (const alias of location.aliases) stores.push(alias, path.join(alias, 'gguf'));
    const engine = { ...location, git: ownGitRevision(real), sourceReceipt: null, sources: [], binaries: [] };
    const downloaded = path.join(real, '.dstudio-source.json');
    if (fs.existsSync(downloaded)) {
      try {
        if (fs.statSync(downloaded).size > 64 * 1024) throw Error('Oversized source receipt');
        engine.sourceReceipt = JSON.parse(fs.readFileSync(downloaded, 'utf8'));
      } catch (error) { receipt.errors.push({ file: downloaded, error: error.message }); }
    }
    for (const rel of sourceFiles(real)) engine.sources.push({ path: rel, ...await hashStableFile(path.join(real, rel)) });
    for (const name of ['ds4', 'ds4-server', 'ds4-agent', 'ds4-agent-jsonl', 'ds4-cowork', 'ds4-design', 'q36', 'q36-server']) {
      const bin = path.join(real, name);
      if (fs.existsSync(bin)) engine.binaries.push({ path: bin, ...await hashStableFile(bin), executed: false });
    }
    receipt.engines.push(engine);
  }
  const inventory = modelInventory([...new Set(stores)]);
  receipt.errors.push(...inventory.errors);
  json('inventory-initial.json', inventory);
  json('source-baseline.json', receipt);
  console.log(`Captured ${receipt.files.length} repository files, ${receipt.engines.length} engines, ${inventory.files.length} unique weight/component artifacts.`);
  if (fullWeights) for (const file of inventory.files) {
    if (file.status === 'OUT_OF_SCOPE' || file.kind === 'partial') continue;
    const started = performance.now();
    console.log(`Hashing ${path.basename(file.file)} (${(file.bytes / 1024 ** 3).toFixed(1)} GiB)`);
    try {
      Object.assign(file, await hashStableFile(file.file));
      file.status = 'HASHED_NOT_INFERENCE_TESTED';
    } catch (error) {
      file.status = 'FAIL'; file.error = error.message;
      receipt.errors.push(error.message);
    }
    file.hashSeconds = (performance.now() - started) / 1000;
    // Immutable per-file receipts retain completed hashes if a later file fails.
    json(`weight-${String(inventory.files.indexOf(file)).padStart(3, '0')}.json`, file);
  }
  receipt.finished = new Date().toISOString();
  json('inventory-final.json', inventory);
  json('completion.json', { started: receipt.started, finished: receipt.finished, errors: receipt.errors,
    fullWeightsRequested: fullWeights, modelRuns: 0, files: inventory.files.length });
  return { run, receipt, inventory };
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), extraStores = [], extraEngines = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--hash-weights') continue;
    if (args[i] === '--store' && args[i + 1]) { extraStores.push(path.resolve(args[++i])); continue; }
    if (args[i] === '--engine' && args[i + 1]) { extraEngines.push(path.resolve(args[++i])); continue; }
    throw Error(`Unknown or incomplete option: ${args[i]}`);
  }
  const result = await captureBaseline(process.cwd(), { fullWeights: args.includes('--hash-weights'), extraStores, extraEngines });
  process.exitCode = result.receipt.errors.length ? 1 : 0;
}

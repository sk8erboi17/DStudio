// Identities a campaign receipt binds to (PLAN.MD, evidence contract): the
// weights, the installed engine, the shipped patch set and the DStudio tree.
// Everything here reads; nothing is written except the weight-hash cache.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileIdentity, hashStableFile } from './quality_baseline.mjs';

const root = path.resolve(import.meta.dirname, '../..');

// One bounded read at a time; fails if the file changes while it is read.
export async function sha256File(file) {
  return (await hashStableFile(file instanceof URL ? file.pathname : file)).sha256;
}

function walkFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

// Weight-hash cache. Owner: the campaign harnesses; lifetime: until the entry's
// file changes. Key: real path, device, inode, size, mtime and ctime, so a
// replaced, rewritten or moved file is hashed again. A hit returns the digest computed
// from the same bytes; the cache is never an authority for another file.
// Bounded to the entries it is asked for (a few dozen weight files).
function loadCache(cacheFile) {
  try { return JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch { return {}; }
}

async function cachedSha256(file, cacheFile, onHash = () => {}) {
  const real = fs.realpathSync(file);
  const st = fs.statSync(real, { bigint: true });
  // The same identity the baseline tool records: device, inode, size, mtime and ctime in nanoseconds.
  const key = `${real}|${fileIdentity(st)}`;
  const cache = cacheFile ? loadCache(cacheFile) : {};
  if (cache[key]) return { sha256: cache[key], bytes: Number(st.size), hashed: 'cached' };
  onHash(real, Number(st.size));
  const hashed = await hashStableFile(real);
  if (hashed.identity !== fileIdentity(st)) throw new Error(`weights changed before they were hashed: ${real}`);
  const sha256 = hashed.sha256;
  if (cacheFile) {
    const current = loadCache(cacheFile);
    current[key] = sha256;
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    const temp = `${cacheFile}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(current, null, 1) + '\n');
    fs.renameSync(temp, cacheFile);
  }
  return { sha256, bytes: Number(st.size), hashed: 'computed' };
}

// A GGUF file or an MLX folder. `pinned` maps a file name to its expected
// {bytes, sha256}; a mismatch is reported, never repaired or ignored.
export async function weightIdentity(target, { cacheFile, pinned = {}, onHash } = {}) {
  const st = fs.statSync(target);
  const files = st.isDirectory() ? walkFiles(target) : [target];
  const base = st.isDirectory() ? target : path.dirname(target);
  const rows = [];
  for (const file of files) {
    const name = path.relative(base, file);
    const row = { name, ...await cachedSha256(file, cacheFile, onHash) };
    const pin = pinned[name];
    if (pin) row.pinned = { bytes: pin.bytes, sha256: pin.sha256, matches: pin.bytes === row.bytes && pin.sha256 === row.sha256 };
    rows.push(row);
  }
  const missingPinned = Object.keys(pinned).filter((name) => !rows.some((row) => row.name === name));
  return { format: st.isDirectory() ? 'folder' : 'gguf', totalBytes: rows.reduce((sum, row) => sum + row.bytes, 0), files: rows,
    missingPinned, verified: rows.length > 0 && missingPinned.length === 0 && rows.filter((row) => row.pinned).length > 0
      && rows.every((row) => !row.pinned || row.pinned.matches) && Object.keys(pinned).length > 0 };
}

// One digest for every versioned patch DStudio ships at this revision.
export function patchSetHash(repo = root) {
  const dir = path.join(repo, 'patch');
  const digest = crypto.createHash('sha256');
  let files = 0;
  for (const file of walkFiles(dir)) {
    digest.update(path.relative(dir, file)).update('\0')
      .update(crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')).update('\n');
    files++;
  }
  return { sha256: digest.digest('hex'), files };
}

// The ceiling keeps a parent repository from answering for a directory that is
// not itself a Git checkout.
export function repoIdentity(repo = root) {
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', timeout: 20000,
    stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_CEILING_DIRECTORIES: path.dirname(repo) } }).trim();
  try {
    const status = git('status', '--porcelain');
    return { head: git('rev-parse', 'HEAD'), dirty: status.length > 0, dirtyPaths: status.split('\n').filter(Boolean).slice(0, 40) };
  } catch (error) { return { error: String(error.message).slice(0, 300) }; }
}

// Receipts written by DStudio's own setup plus the hashes of the executables
// that will actually run. A missing receipt is recorded as missing.
export async function engineIdentity(dir, executables) {
  const out = { dir, receipts: {}, executables: [] };
  for (const name of ['.dstudio-source.json', '.dstudio-llama.json', '.dstudio-mlx.json']) {
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    out.receipts[name] = { sha256: crypto.createHash('sha256').update(text).digest('hex'), content: (() => { try { return JSON.parse(text); } catch { return null; } })() };
  }
  if (!Object.keys(out.receipts).length) out.receiptMissing = true;
  for (const name of executables) {
    const file = path.join(dir, name);
    out.executables.push(fs.existsSync(file) ? { name, bytes: fs.statSync(file).size, sha256: await sha256File(file) } : { name, missing: true });
  }
  return out;
}

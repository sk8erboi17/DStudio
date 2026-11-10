// Executes the identity helpers used by campaign receipts on task-owned files.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { engineIdentity, patchSetHash, repoIdentity, sha256File, weightIdentity } from '../support/campaign_identity.mjs';

const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'campaign-identity-'));
try {
  const cache = path.join(dir, 'cache', 'weights.json');
  const gguf = path.join(dir, 'model.gguf');
  fs.writeFileSync(gguf, 'weights-v1');
  const pin = { 'model.gguf': { bytes: 10, sha256: sha('weights-v1') } };
  const hashed = [];
  const onHash = (file) => hashed.push(path.basename(file));

  // First read computes, second is a cache hit with the same digest.
  let id = await weightIdentity(gguf, { cacheFile: cache, pinned: pin, onHash });
  assert.deepEqual([id.format, id.totalBytes, id.verified, id.files[0].hashed], ['gguf', 10, true, 'computed']);
  id = await weightIdentity(gguf, { cacheFile: cache, pinned: pin, onHash });
  assert.deepEqual([id.verified, id.files[0].hashed, id.files[0].sha256], [true, 'cached', sha('weights-v1')]);
  assert.deepEqual(hashed, ['model.gguf'], 'a cache hit does not read the weights again');

  // Rewritten bytes of the same length are hashed again and no longer match the pin.
  fs.writeFileSync(gguf, 'weights-v2');
  id = await weightIdentity(gguf, { cacheFile: cache, pinned: pin, onHash });
  assert.deepEqual([id.verified, id.files[0].hashed, id.files[0].pinned.matches], [false, 'computed', false]);
  // Without a pin there is a digest but never a verification claim.
  id = await weightIdentity(gguf, { cacheFile: cache });
  assert.equal(id.verified, false);
  // A wrong pinned size fails even when the digest matches.
  id = await weightIdentity(gguf, { pinned: { 'model.gguf': { bytes: 11, sha256: sha('weights-v2') } } });
  assert.equal(id.verified, false);

  // An MLX-style folder: every file is hashed, a missing pinned file is reported.
  const folder = path.join(dir, 'mlx-model'); fs.mkdirSync(path.join(folder, 'nested'), { recursive: true });
  fs.writeFileSync(path.join(folder, 'config.json'), '{}'); fs.writeFileSync(path.join(folder, 'nested', 'part.safetensors'), 'abc');
  const folderPin = { 'config.json': { bytes: 2, sha256: sha('{}') }, 'nested/part.safetensors': { bytes: 3, sha256: sha('abc') } };
  id = await weightIdentity(folder, { cacheFile: cache, pinned: folderPin });
  assert.deepEqual([id.format, id.totalBytes, id.verified, id.files.map((f) => f.name)], ['folder', 5, true, ['config.json', 'nested/part.safetensors']]);
  id = await weightIdentity(folder, { pinned: { ...folderPin, 'tokenizer.json': { bytes: 1, sha256: sha('x') } } });
  assert.deepEqual([id.verified, id.missingPinned], [false, ['tokenizer.json']]);
  // An unpinned extra file beside pinned ones is listed and does not hide a mismatch.
  fs.writeFileSync(path.join(folder, 'extra.bin'), 'zz');
  id = await weightIdentity(folder, { pinned: folderPin });
  assert.equal(id.files.length, 3); assert.equal(id.verified, true);

  // A damaged cache file is ignored, not trusted.
  fs.writeFileSync(cache, '{damaged');
  id = await weightIdentity(gguf, { cacheFile: cache });
  assert.equal(id.files[0].hashed, 'computed');
  assert.equal(JSON.parse(fs.readFileSync(cache, 'utf8'))[Object.keys(JSON.parse(fs.readFileSync(cache, 'utf8')))[0]], sha('weights-v2'));
  assert.equal(await sha256File(gguf), sha('weights-v2'));

  // Engine identity: receipts are parsed, a missing receipt and a missing binary are recorded.
  const engine = path.join(dir, 'engine'); fs.mkdirSync(path.join(engine, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(engine, '.dstudio-source.json'), JSON.stringify({ engine: 'main', commit: 'a'.repeat(40) }));
  fs.writeFileSync(path.join(engine, 'bin', 'server'), 'binary');
  let e = await engineIdentity(engine, ['bin/server', 'bin/absent']);
  assert.equal(e.receipts['.dstudio-source.json'].content.commit, 'a'.repeat(40));
  assert.deepEqual(e.executables.map((x) => x.missing ? 'missing' : x.sha256), [sha('binary'), 'missing']);
  assert.equal(e.receiptMissing, undefined);
  fs.rmSync(path.join(engine, '.dstudio-source.json'));
  e = await engineIdentity(engine, []);
  assert.equal(e.receiptMissing, true, 'an engine without a receipt has no bound revision');

  // A directory that is not itself a Git checkout never reports a parent repository's HEAD.
  const inside = path.join(process.cwd(), 'tests', '.artifacts', `identity-probe-${process.pid}`);
  fs.mkdirSync(inside, { recursive: true });
  try { assert.ok(repoIdentity(inside).error, 'a plain directory inside the repository has no identity of its own'); }
  finally { fs.rmSync(inside, { recursive: true, force: true }); }
  const own = repoIdentity(process.cwd());
  assert.match(own.head, /^[0-9a-f]{40}$/); assert.equal(typeof own.dirty, 'boolean');

  // The patch-set digest changes with any patch byte and is stable otherwise.
  const repo = path.join(dir, 'repo'); fs.mkdirSync(path.join(repo, 'patch', 'a'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'patch', 'a', 'x.patch'), 'one');
  const first = patchSetHash(repo);
  assert.deepEqual(patchSetHash(repo), first);
  fs.writeFileSync(path.join(repo, 'patch', 'a', 'x.patch'), 'two');
  assert.notEqual(patchSetHash(repo).sha256, first.sha256);
  assert.ok(patchSetHash().files > 10);
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
console.log('PASS: campaign identities: cached weight digests, pinned verification, folders, damaged cache, engine receipts, repository ceiling and patch-set digest (task-owned files; no model)');

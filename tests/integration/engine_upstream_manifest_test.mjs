// The shipped release-admission manifest against what is actually shipped:
// every patch-set entry must hash to the recorded SHA-256, and every target's
// installer must be the one the built app reports. Executes the app's real
// metadata command; no network, no Git history, no model. The commit-by-commit
// source review stays with the explicit `make check-engine-upstream`.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const app = process.argv[2];
assert.ok(app && fs.existsSync(app), 'usage: engine_upstream_manifest_test.mjs BUILT_APP');
const manifest = JSON.parse(fs.readFileSync('docs/engine-upstream.json', 'utf8'));
const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

const stale = [];
for (const [name, entries] of Object.entries(manifest.patchSets)) {
  assert.ok(entries.length > 0, `patch set ${name} is empty`);
  assert.equal(new Set(entries.map((entry) => entry.path)).size, entries.length, `patch set ${name} lists a file twice`);
  for (const entry of entries) {
    assert.ok(fs.existsSync(entry.path), `${name}: ${entry.path} is not shipped`);
    if (sha256(entry.path) !== entry.sha256) stale.push(`${name}: ${entry.path}`);
  }
}
assert.deepEqual(stale, [], 'patch-set entries whose file changed without refreshing the manifest');

const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('DS4')));
const result = spawnSync(app, ['--engine-pins'], { env: { ...env, DS4UI_NO_WINDOW: '1' }, encoding: 'utf8', timeout: 10000 });
assert.equal(result.status, 0, result.stderr);
const pins = new Map(JSON.parse(result.stdout).engines.map((engine) => [engine.id, engine]));
const tracks = new Map(manifest.tracks.map((track) => [track.id, track]));
assert.equal(tracks.size, manifest.tracks.length, 'duplicate track');
assert.equal(new Set(manifest.targets.map((target) => target.id)).size, manifest.targets.length, 'duplicate target');
for (const target of manifest.targets) {
  assert.ok(target.tracks.every((id) => tracks.has(id)) && target.tracks.includes(target.sourceTrack), `${target.id}: unknown or omitted source track`);
  assert.ok(manifest.patchSets[target.patchSet] || !('patchSet' in target), `${target.id}: unknown patch set ${target.patchSet}`);
  assert.equal(new Set(target.requiredGates).size, target.requiredGates.length, `${target.id}: a gate is listed twice`);
  const pin = pins.get(target.installerId);
  assert.ok(pin, `${target.id}: the built app has no installer ${target.installerId}`);
  assert.equal(pin.commit, target.revision, `${target.id}: the built app installs ${pin.commit}`);
  const repository = tracks.get(target.sourceTrack).repository.replace(/\.git$/, '');
  assert.equal(pin.archiveURL, `${repository.replace('https://github.com/', 'https://codeload.github.com/')}/tar.gz/${target.revision}`,
    `${target.id}: the installer source differs from the target's track`);
}
for (const id of pins.keys()) assert.ok(manifest.targets.some((target) => target.installerId === id), `installer ${id} has no admission target`);
const slots = manifest.targets.reduce((sum, target) => sum + target.requiredGates.length, 0);
const receipts = manifest.targets.reduce((sum, target) => sum + target.receipts.length, 0);
console.log(`PASS: admission manifest matches the shipped patches and the built app's installers: ${manifest.targets.length} targets, ${slots} required gate slots, ${receipts} linked receipts (no network, no source review)`);

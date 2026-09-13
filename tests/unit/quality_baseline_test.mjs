import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { hashStableFile, ownGitRevision, modelInventory, discoverInstallations, captureBaseline } from '../support/quality_baseline.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dstudio-baseline-test-'));
try {
  execFileSync('git', ['init', '-q', root]);
  const archive = path.join(root, 'archive'), models = path.join(root, 'models');
  fs.mkdirSync(archive); fs.mkdirSync(models);
  execFileSync('git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture']);
  assert.ok(ownGitRevision(root)?.head);
  assert.equal(ownGitRevision(archive), null, 'archive must not inherit parent Git identity');
  const data = Buffer.from('real bytes, independent SHA-256 oracle\n');
  const model = path.join(models, 'Flash.gguf');
  fs.writeFileSync(model, data);
  fs.linkSync(model, path.join(models, 'Flash-alias.gguf'));
  fs.writeFileSync(path.join(models, 'GLM-5.2.gguf'), 'excluded');
  fs.writeFileSync(path.join(models, 'Qwen-mmproj.gguf'), 'encoder');
  fs.writeFileSync(path.join(models, 'download.gguf.part'), 'partial');
  const hash = await hashStableFile(model);
  assert.equal(hash.bytes, data.length);
  assert.equal(hash.sha256, crypto.createHash('sha256').update(data).digest('hex'));
  const link = path.join(root, 'linked-models'); fs.symlinkSync(models, link);
  const inventory = modelInventory([models, link, path.join(root, 'missing')]);
  assert.equal(inventory.files.length, 4, 'hardlinks and shared stores must not double-count weights');
  assert.equal(inventory.missingStores.length, 1);
  assert.equal(inventory.files.find(x => x.file.endsWith('GLM-5.2.gguf')).status, 'OUT_OF_SCOPE');
  assert.equal(inventory.files.find(x => x.file.endsWith('Qwen-mmproj.gguf')).kind, 'component');
  assert.equal(inventory.files.find(x => x.file.endsWith('.part')).kind, 'partial');
  assert.equal(inventory.files.filter(x => x.sha256).length, 0, 'inventory must not pretend to have hashed weights');
  fs.symlinkSync(path.join(root, 'missing-weight'), path.join(models, 'broken.gguf'));
  const withBroken = modelInventory([models]);
  assert.equal(withBroken.files.length, 4, 'one broken link must not hide other installed files');
  assert.equal(withBroken.errors.length, 1, 'a broken weight link is not a successful inventory');
  for (const name of ['DeepSeek-V4-Flash-DSpark-support-0731.gguf',
    'DeepSeek-V4-Flash-Vision-Exp-DSpark-support.gguf', 'Qwen3.8-Flash-Next-MTP.gguf']) {
    fs.writeFileSync(path.join(models, name), 'auxiliary checkpoint');
  }
  fs.writeFileSync(path.join(models, 'Complex-Chat.gguf'), 'ordinary checkpoint');
  const components = modelInventory([models]);
  assert.equal(components.files.filter(x => x.kind === 'component').length, 4,
    'DSpark support and MTP are components, not independently selectable LLMs');
  assert.equal(components.files.find(x => x.file.endsWith('Complex-Chat.gguf')).kind, 'checkpoint',
    'PLE as a substring of an unrelated name must not turn a model into a component');

  const profile = path.join(root, 'isolated-profile'), elsewhere = path.join(root, 'elsewhere');
  const custom = path.join(elsewhere, 'custom engine');
  fs.mkdirSync(profile); fs.mkdirSync(custom, { recursive: true });
  fs.mkdirSync(path.join(elsewhere, 'ds4-qwen35'));
  const dense = path.join(elsewhere, 'q36');
  fs.mkdirSync(dense);
  fs.symlinkSync(dense, path.join(root, 'q36'));
  fs.writeFileSync(path.join(profile, 'engine-checkout'), custom + '\n');
  fs.symlinkSync(custom, path.join(root, 'ds4'));
  const options = { environment: { DS4UI_DATA_DIR: profile }, home: path.join(root, 'test-home'), platform: 'darwin' };
  const discovered = discoverInstallations(root, options);
  assert.equal(discovered.errors.length, 0);
  assert.equal(discovered.profiles.length, 1);
  assert.equal(discovered.profiles[0].selected, custom);
  assert.equal(discovered.directories.length, 3, 'persisted external checkout and all managed siblings, including q36, are included once');
  assert.equal(discovered.directories.find(x => x.directory === fs.realpathSync(custom)).aliases.length, 2);
  assert.equal(discovered.directories.find(x => x.directory === fs.realpathSync(dense)).aliases.length, 2,
    'The unselected 27B engine must be inventoried without counting its symlink as another installation');
  assert.equal(discoverInstallations(root, { ...options, extraEngines: [custom] }).directories.length, 3);

  // Exercise the full receipt producer on isolated files, not on this Mac's
  // real profile. Neither model bytes nor executable names imply a live test.
  fs.writeFileSync(path.join(root, '.gitignore'), 'tests/.artifacts/\n');
  const sourceBytes = {
    'q36.c': 'int scalar_reference(void) { return 7; }\n',
    'q36_metal.mm': '/* Objective-C++ fixture */\n',
    'prepare.cfrag': '/* included preparation fixture */\n',
    'backend.cpp': '// C++ fixture\n',
    'CMakeLists.txt': '# fixture build recipe\n',
    'flags.cmake': '# included build recipe\n',
  };
  for (const [file, bytes] of Object.entries(sourceBytes)) fs.writeFileSync(path.join(dense, file), bytes);
  const binaries = {q36: 'CLI binary fixture; never execute', 'q36-server': 'server binary fixture; never execute'};
  for (const [file, bytes] of Object.entries(binaries)) fs.writeFileSync(path.join(dense, file), bytes);
  const sourceReceipt = {repository: 'https://example.invalid/q36', commit: 'fixture-revision'};
  fs.writeFileSync(path.join(dense, '.dstudio-source.json'), JSON.stringify(sourceReceipt));
  const captured = await captureBaseline(root, {discoveryOptions: options});
  assert.deepEqual(captured.receipt.errors, []);
  assert.equal(captured.receipt.engines.length, 3);
  const engine = captured.receipt.engines.find(item => item.directory === fs.realpathSync(dense));
  assert.equal(engine.git, null, 'An installed archive cannot inherit the fixture project Git revision');
  assert.deepEqual(engine.sourceReceipt, sourceReceipt);
  assert.deepEqual(engine.sources.map(item => item.path).sort(), Object.keys(sourceBytes).sort());
  for (const item of engine.sources) assert.equal(item.sha256,
    crypto.createHash('sha256').update(sourceBytes[item.path]).digest('hex'));
  assert.deepEqual(engine.binaries.map(item => path.basename(item.path)).sort(), Object.keys(binaries).sort());
  for (const item of engine.binaries) {
    assert.equal(item.executed, false);
    assert.equal(item.sha256, crypto.createHash('sha256').update(binaries[path.basename(item.path)]).digest('hex'));
  }
  assert.equal(JSON.parse(fs.readFileSync(path.join(captured.run, 'completion.json'))).modelRuns, 0);
  fs.writeFileSync(path.join(profile, 'engine-checkout'), '../not-an-absolute-setting\n');
  assert.equal(discoverInstallations(root, options).errors.length, 1, 'invalid persisted provenance must be reported');
  fs.writeFileSync(path.join(profile, 'engine-checkout'), 'x'.repeat(8192));
  assert.equal(discoverInstallations(root, options).errors.length, 1, 'oversized settings must be bounded');
  const linux = discoverInstallations(root, { environment: { XDG_CONFIG_HOME: profile }, home: root, platform: 'linux' });
  assert.deepEqual(linux.dataRoots, [path.join(profile, 'dstudio')]);
  const windows = discoverInstallations(root, { environment: { LOCALAPPDATA: profile }, home: root, platform: 'win32' });
  assert.deepEqual(windows.dataRoots, [path.join(profile, 'DStudio')]);
  console.log('quality_baseline_test: PASS (actual files, hashes, Git provenance and store deduplication; no model inference)');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

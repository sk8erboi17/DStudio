// Six managed native adaptations, not the Agent/server-PLD/web fragment stacks.
// Work only on a new scratch copy. Patch headers route copies; all assertions
// concern actual apply/restore effects and file integrity.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const patches = [
  'ds4-visible-downloads/visible-partials.patch',
  'ds4-media-memory/residency-lease.patch',
  'ds4-server-metrics/usage-metrics.patch',
  'ds4-glm53-runtime/streaming-memory.patch',
  'ds4-glm53-m2max/native-decode.patch',
  'ds4-vision-streaming/vision-map.patch',
];
const m2Variants = [
  'ds4-glm53-m2max/build-main.patch',
  'ds4-glm53-m2max/build-main-current.patch',
  'ds4-glm53-m2max/legacy-selected-logging.patch',
  'ds4-visible-downloads/main-v41.patch',
  'ds4-glm53-runtime/main-v41.patch',
];
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

export function nativePatchRoundtrip({ support, source, scratch, environment = process.env }) {
  support = fs.realpathSync(support); source = fs.realpathSync(source);
  assert.equal(fs.existsSync(scratch), false, 'scratch must be new');
  fs.mkdirSync(scratch);
  scratch = fs.realpathSync(scratch);
  const files = new Set();
  const patchFiles = [...patches, ...m2Variants];
  for (const file of patchFiles) {
    for (const [, target] of fs.readFileSync(path.join(support, 'patch', file), 'utf8').matchAll(/^\+\+\+ b\/(.+)$/gm)) {
      assert.ok(!path.isAbsolute(target) && !target.split('/').includes('..'), 'invalid patch target');
      files.add(target);
    }
  }
  const before = {};
  for (const file of files) {
    const from = path.join(source, file), to = path.join(scratch, file);
    assert.ok(fs.lstatSync(from).isFile(), `expected regular installed source: ${file}`);
    before[file] = sha(from);
    fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(from, to);
  }
  const note = path.join(scratch, 'contributor-note.txt');
  fs.writeFileSync(note, 'unrelated user content\n', { flag: 'wx' });
  const noteHash = sha(note);
  const env = { ...environment, GIT_CEILING_DIRECTORIES: path.dirname(scratch), DS4_DIR: scratch };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete env[key];
  const stages = [];
  const snapshot = () => Object.fromEntries([...files].map(file => [file,
    fs.existsSync(path.join(scratch, file)) ? sha(path.join(scratch, file)) : null]));
  const apply = (file, reverse) => {
    const old = snapshot();
    const action = reverse ? 'restore' : 'apply';
    const stage = { file, action }; stages.push(stage);
    // Exercise production selection and integrity checks where available.
    // In particular M2 chooses different build hunks for older/current main.
    const script = file === 'ds4-glm53-m2max/native-decode.patch' ? 'glm53-m2max' :
      file === 'ds4-server-metrics/usage-metrics.patch' ? 'server-metrics' :
      file === 'ds4-visible-downloads/visible-partials.patch' ? 'visible-downloads' :
      file === 'ds4-glm53-runtime/streaming-memory.patch' ? 'glm53-runtime' : null;
    if (script) {
      stage.output = execFileSync('/bin/sh', [path.join(support, `scripts/apply-ds4-${script}.sh`), action],
        { env, encoding: 'utf8', timeout: 30000 });
    } else {
      stage.output = execFileSync('git', ['-C', scratch, 'apply', '--unidiff-zero',
        ...(reverse ? ['--reverse'] : []), path.join(support, 'patch', file)],
      { env, encoding: 'utf8', timeout: 30000 });
    }
    const after = snapshot();
    stage.changed = [...files].filter(file => old[file] !== after[file]);
    assert.ok(stage.changed.length, `patch ${action} did not actually change any source: ${file}`);
    stage.status = 'PASS';
  };
  try {
    for (const file of [...patches].reverse()) apply(file, true);
    const restored = snapshot();
    for (const file of patches) apply(file, false);
    assert.deepEqual(snapshot(), before, 'roundtrip changed source bytes');
    for (const file of files) assert.equal(sha(path.join(source, file)), before[file], 'original checkout changed');
    assert.equal(sha(note), noteHash, 'unrelated scratch data changed');
    return {
      scope: 'Six native adaptations, including production-selected M2 build hunks; no inference or complete Agent/web patch-stack claim',
      patches: patchFiles.map(file => ({ file, sha256: sha(path.join(support, 'patch', file)) })),
      scriptSha256: Object.fromEntries(['glm53-m2max', 'server-metrics', 'visible-downloads', 'glm53-runtime'].map(name =>
        [name, sha(path.join(support, `scripts/apply-ds4-${name}.sh`))])),
      filesChecked: files.size, before, restored, stages,
    };
  } finally {
    fs.writeFileSync(path.join(scratch, 'roundtrip-stages.json'), JSON.stringify(stages, null, 2) + '\n', { flag: 'wx' });
  }
}

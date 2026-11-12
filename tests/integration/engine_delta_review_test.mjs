// The main-track source-delta review. First the shipped one, without a clone:
// every review's evidence hashes to its record, names an inventoried commit
// once, and is exactly what the generator's rules give for the inventory and
// the files shipped in src/engines/. Then (macOS) the generator's "compiled"
// path rules against the real preprocessor over the shipped tree. Then the
// generator on a synthetic Git history, with its output passed to the real
// admission checker. No network, no upstream history, no engine, no model: a
// PASS here says nothing about what any commit does.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {checkUpstream} from '../../scripts/check-engine-upstream.mjs';
import {PATH_RULES, ruleFor, run} from '../../scripts/engine-delta-review.mjs';
import {artifactRunDir, writeArtifact} from '../support/real_harness.mjs';

const root = fs.realpathSync(process.cwd()), work = fs.realpathSync(artifactRunDir('engine-delta-review'));
const report = {scope: 'Delta-review generator and shipped review records; no engine qualification', started: new Date().toISOString(), cases: [], passed: false};
const pass = (name, detail) => {report.cases.push({name, passed: true, ...detail}); console.log('PASS: ' + name);};
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_') && !/^(MAKEFLAGS|MFLAGS|MAKELEVEL|MAKEOVERRIDES)$/.test(key)));
try {
  // ---- the shipped review ------------------------------------------------------
  const manifest = json('docs/engine-upstream.json'), track = manifest.tracks.find(t => t.id === 'main');
  const inventory = json(track.deltaInventory), row = inventory.tracks[0], ids = row.commits.map(c => c.id), known = new Set(ids);
  assert.deepEqual([row.id, row.base, row.tip], ['main', track.base, track.recordedTip], 'the inventory covers another interval');
  assert.equal(row.commitCount, ids.length); assert.equal(known.size, ids.length, 'a commit is inventoried twice');
  const shipped = inventory.shippedTrees.find(t => t.engine === 'main'), provenance = json('src/engines/manifest.json').engines.main;
  assert.deepEqual([shipped.commit, provenance.commit], [track.recordedTip, track.recordedTip], 'the compared tree is not the pinned one');
  assert.deepEqual([shipped.equal, shipped.missing, shipped.extra, shipped.different], [true, [], [], []]);
  assert.equal(shipped.shippedIdentical, Object.keys(provenance.files).length);
  assert.equal(shipped.shippedIdentical + shipped.declaredOmitted, shipped.upstreamFiles);
  const hashes = new Map(), counts = {}, unresolved = {};
  const targets = manifest.targets.filter(t => t.tracks.includes('main'));
  assert.ok(targets.length > 0);
  for (const target of targets) {
    const reviews = target.reviews.filter(r => r.track === 'main'), seen = new Set();
    assert.ok(target.reviews.length <= 8192);
    for (const review of reviews) {
      assert.ok(known.has(review.commit), `${target.id}: ${review.commit} is not in the inventory`);
      assert.ok(!seen.has(review.commit), `${target.id}: ${review.commit} is reviewed twice`); seen.add(review.commit);
      assert.ok(['integrated', 'equivalent', 'not-applicable'].includes(review.decision));
      assert.ok(review.reason.trim().length >= 20);
      assert.ok(review.evidence.length >= 1 && review.evidence.length <= 16);
      for (const entry of review.evidence) {
        const full = path.resolve(root, entry.path);
        assert.ok(full.startsWith(root + path.sep) && fs.lstatSync(full).isFile() && fs.realpathSync(full) === full, `${entry.path} is not a plain file of this repository`);
        if (!hashes.has(full)) hashes.set(full, sha(fs.readFileSync(full)));
        assert.equal(hashes.get(full), entry.sha256, `${target.id}: evidence ${entry.path} changed after ${review.commit} was reviewed`);
      }
      counts[review.decision] = (counts[review.decision] || 0) + 1;
    }
    assert.deepEqual(reviews.map(r => r.commit), ids.filter(id => seen.has(id)), `${target.id}: reviews are not in inventory order`);
    unresolved[target.id] = ids.length - seen.size;
  }
  // Laguna's porting review: exactly one hand-written verdict for every commit
  // the main targets integrate, none for any other, and the manifest carries a
  // review only for `present` (equivalent) and `not-applicable` verdicts.
  const laguna = manifest.targets.find(t => t.sourceTrack === 'laguna'), portCounts = {};
  if (laguna?.portReview) {
    const port = json(laguna.portReview), integrated = ids.filter(id => manifest.targets.find(t => t.sourceTrack === 'main').reviews
      .some(r => r.track === 'main' && r.commit === id && r.decision === 'integrated'));
    assert.equal(port.schema, 'dstudio.laguna-port-review.v1');
    assert.deepEqual([port.sources.main.base, port.sources.main.tip, port.sources.laguna.tip], [track.base, track.recordedTip, laguna.revision]);
    assert.deepEqual([port.inventory.path, port.inventory.sha256], [track.deltaInventory, sha(fs.readFileSync(track.deltaInventory))]);
    assert.deepEqual(port.reviews.map(r => r.commit), integrated, 'the porting review must give one verdict to each integrated main commit, in inventory order');
    const lagunaReviews = new Map(laguna.reviews.filter(r => r.track === 'main').map(r => [r.commit, r]));
    for (const entry of port.reviews) {
      portCounts[entry.verdict] = (portCounts[entry.verdict] || 0) + 1;
      assert.equal(entry.title, row.commits.find(c => c.id === entry.commit).title);
      assert.ok(entry.reason.trim().length >= 20 && entry.group);
      if (entry.verdict === 'candidate') assert.ok(entry.fixes && entry.laguna, entry.commit + ': a candidate says what it fixes and what Laguna has');
      if (entry.verdict === 'unresolved') assert.ok(entry.why, entry.commit + ': an unresolved verdict says why');
      const expected = {present: 'equivalent', 'not-applicable': 'not-applicable'}[entry.verdict];
      assert.equal(lagunaReviews.get(entry.commit)?.decision, expected, entry.commit + ': manifest review does not follow the porting verdict');
      if (expected) assert.ok(lagunaReviews.get(entry.commit).evidence.some(e => e.path === laguna.portReview));
    }
    assert.equal(unresolved[laguna.id], (portCounts.candidate || 0) + (portCounts.unresolved || 0));
    pass(`Laguna porting review: ${port.reviews.length} verdicts for ${integrated.length} integrated main commits, ${JSON.stringify(portCounts)}`, {portCounts});
  }

  // The production generator, reviews only: it refuses when src/engines/ is no
  // longer the tree the inventory compared, and must reproduce the file bytes.
  const again = run({root, check: true});
  assert.deepEqual(again.stale, [], 'docs/engine-upstream.json is not what the rules give for the inventory');
  for (const target of again.targets) assert.equal(target.unclassified.length, unresolved[target.target], target.target);
  pass(`shipped review: ${ids.length} inventoried commits, ${targets.length} targets, ${JSON.stringify(counts)}, unclassified per target ${JSON.stringify(unresolved)}`, {counts, unresolved});

  // ---- the "compiled" rules against the compiler -------------------------------
  if (process.platform === 'darwin') {
    const copy = path.join(work, 'ds4'); fs.cpSync('src/engines/ds4', copy, {recursive: true});
    const plan = spawnSync('make', ['-n', '-B', '-C', copy, 'all'], {env, encoding: 'utf8'});
    assert.equal(plan.status, 0, plan.stderr);
    const closure = new Set();
    for (const line of plan.stdout.split('\n')) {
      const words = line.trim().split(/\s+/), at = words.indexOf('-c');
      if (at < 0 || words[at + 1] !== '-o') continue;
      const deps = spawnSync(words[0], [...words.slice(1, at), '-MM', ...words.slice(at + 3)], {cwd: copy, env, encoding: 'utf8'});
      assert.equal(deps.status, 0, deps.stderr);
      for (const word of deps.stdout.replace(/\\\n/g, ' ').trim().split(/\s+/).slice(1)) closure.add(path.normalize(word));
    }
    const named = PATH_RULES.filter(rule => rule.basis === 'compiled').flatMap(rule => rule.files).sort();
    assert.ok(closure.size > 20, 'the dry run compiled almost nothing');
    assert.deepEqual([...closure].sort(), named, 'the compiled path rules are not the include closure of the macOS default build');
    for (const name of closure) assert.equal(ruleFor(name).class, 'runtime', name);
    pass(`compiled path rules equal the preprocessor's include closure of upstream's macOS default build (${closure.size} files)`, {files: closure.size});
  } else console.log('NOT RUN: the include-closure check needs the macOS toolchain');

  // ---- a synthetic history -----------------------------------------------------
  const seed = path.join(work, 'seed'), remote = path.join(work, 'remote.git'), candidate = path.join(work, 'candidate'), fixture = path.join(work, 'root');
  const git = (dir, args) => {
    const r = spawnSync('git', ['-C', dir, '-c', 'user.name=DStudio fixture', '-c', 'user.email=fixture@invalid', ...args], {env, encoding: 'utf8', timeout: 20000});
    assert.equal(r.status, 0, r.stderr || r.error?.message); return r.stdout.trim();
  };
  const put = (name, text) => {fs.mkdirSync(path.dirname(path.join(seed, name)), {recursive: true}); fs.writeFileSync(path.join(seed, name), text);};
  const commit = title => {git(seed, ['add', '-A']); git(seed, ['commit', '-qm', title]); return git(seed, ['rev-parse', 'HEAD']);};
  // The shell `else` inside the skipped branch is a continued recipe-style line, not a directive.
  const makefile = (other, shared) => `UNAME_S := $(shell uname -s)\nifeq ($(UNAME_S),Darwin)\nCORE = ds4.o\nelse\n` +
    `HOME ?= $(shell if true; then \\\n\tprintf a; \\\n\telse \\\n\tprintf b; fi)\nCORE = ${other}\nendif\n` +
    `ifneq ($(UNAME_S),Darwin)\nLINK = ${other}\nendif\nall: ${shared}\n`;
  fs.mkdirSync(seed); git(seed, ['init', '-q', '--initial-branch=main']);
  put('ds4.c', 'int value = 1;\n'); put('ds4_cuda.cu', '// 1\n'); put('Makefile', makefile('cuda.o', 'ds4')); put('README.md', 'notes\n');
  put('gguf-tools/data/big.txt', 'dataset 1\n'); put('download_model.sh', '#!/bin/sh\n'); fs.chmodSync(path.join(seed, 'download_model.sh'), 0o755);
  const base = commit('baseline');
  put('ds4_cuda.cu', '// 2\n'); const cuda = commit('cuda only');
  put('ds4.c', 'int value = 2;\n'); const core = commit('shared engine file');
  put('Makefile', makefile('cuda.o mmq.o', 'ds4')); put('cuda/mmq/mmq.cu', '// mmq\n'); const guarded = commit('cuda build rules');
  put('Makefile', makefile('cuda.o mmq.o', 'ds4 ds4-server')); const build = commit('default build rules');
  put('ds4_web.c', 'int web;\n'); const added = commit('add a runtime file');
  fs.rmSync(path.join(seed, 'ds4_web.c')); const dropped = commit('drop it again before the tip');
  put('firmware.bin', 'opaque\n'); const mystery = commit('a path no rule covers');
  fs.mkdirSync(path.join(seed, 'docs')); git(seed, ['mv', 'README.md', 'docs/NOTES.md']); const renamed = commit('move the notes');
  git(seed, ['checkout', '-q', '-b', 'side']); put('docs/NOTES.md', 'notes\nmore\n'); const side = commit('side: notes');
  git(seed, ['checkout', '-q', 'main']); git(seed, ['merge', '-q', '--no-ff', 'side', '-m', 'Merge side']); const merge = git(seed, ['rev-parse', 'HEAD']);
  put('gguf-tools/data/big.txt', 'dataset 2\n'); const tip = commit('dataset');
  git(work, ['clone', '-q', '--bare', seed, remote]); git(work, ['clone', '-q', remote, candidate]);

  const files = {}, omitted = {};
  for (const name of git(seed, ['ls-files']).split('\n')) {
    const from = path.join(seed, name), bytes = fs.readFileSync(from), executable = !!(fs.statSync(from).mode & 0o111);
    const record = {bytes: bytes.length, executable, sha256: sha(bytes)};
    if (name.startsWith('gguf-tools/')) {omitted[name] = {...record, reason: 'fixture dataset'}; continue;}
    const to = path.join(fixture, 'src/engines/ds4', name); fs.mkdirSync(path.dirname(to), {recursive: true});
    fs.writeFileSync(to, bytes); fs.chmodSync(to, executable ? 0o755 : 0o644); files[name] = record;
  }
  const write = (name, text) => {fs.mkdirSync(path.dirname(path.join(fixture, name)), {recursive: true}); fs.writeFileSync(path.join(fixture, name), text); return {path: name, sha256: sha(text)};};
  const provenancePath = path.join(fixture, 'src/engines/manifest.json');
  const writeProvenance = change => {const p = {schema: 'dstudio.engine-sources.v1', engines: {main: {commit: tip, directory: 'ds4', files: {...files}, omitted: {...omitted}}}}; change?.(p.engines.main); fs.writeFileSync(provenancePath, JSON.stringify(p, null, 2) + '\n');};
  writeProvenance();
  const patch = {...write('patch/core.patch', '--- a/ds4.c\n+++ b/ds4.c\n@@ -1 +1 @@\n-int value = 2;\n+int value = 3;\n'), check: 'apply'};
  const same = {repository: remote, ref: 'refs/heads/main', base: tip, recordedTip: tip};
  const target = (id, sourceTrack, extra) => ({id, sourceTrack, revision: tip, tracks: [...new Set(['main', sourceTrack])], platform: 'macos',
    requiredGates: ['behavior'], receipts: [], reviews: [], ...extra});
  const declared = {schemaVersion: 1, tracks: [{...same, id: 'main', base}, {...same, id: 'llama'}, {...same, id: 'laguna'}], patchSets: {main: [patch]},
    targets: [target('main/fixture', 'main', {patchSet: 'main'}), target('llama/fixture', 'llama', {patches: []}), target('laguna/fixture', 'laguna', {patches: []})]};
  const manifestPath = path.join(fixture, 'docs/engine-upstream.json');
  write('docs/engine-upstream.json', JSON.stringify(declared, null, 2) + '\n');

  const options = {root: fixture, repositories: {main: candidate}, captured: '2026-01-02', observedTip: tip};
  const first = run(options), produced = json(manifestPath), record = json(path.join(fixture, first.inventory));
  assert.deepEqual(first.written.sort(), ['docs/engine-upstream.json', 'docs/upstream/main-delta-2026-01-02.json']);
  const decisions = id => Object.fromEntries(produced.targets.find(t => t.id === id).reviews.map(r => [r.commit, r.decision]));
  const reason = (id, commitId) => produced.targets.find(t => t.id === id).reviews.find(r => r.commit === commitId).reason;
  const runtime = {[cuda]: 'not-applicable', [core]: 'integrated', [guarded]: 'not-applicable', [build]: 'integrated',
    [renamed]: 'not-applicable', [side]: 'not-applicable', [merge]: 'not-applicable', [tip]: 'not-applicable'};
  assert.deepEqual(decisions('main/fixture'), runtime, 'a path no rule covers must stay unclassified; the rest follow their paths');
  assert.deepEqual(decisions('llama/fixture'), runtime);
  assert.deepEqual(decisions('laguna/fixture'), {[cuda]: 'not-applicable', [guarded]: 'not-applicable', [renamed]: 'not-applicable',
    [side]: 'not-applicable', [merge]: 'not-applicable', [tip]: 'not-applicable'}, 'a separate branch gets no decision for a main runtime change');
  const open = [added, dropped, mystery];
  assert.deepEqual(first.targets.map(t => t.unclassified.map(u => u.commit)), [open, open, [core, build, ...open]],
    'undecidable: an uncovered path, a runtime file the shipped tree does not have, and any runtime change for a separate branch');
  assert.match(reason('main/fixture', core), /ds4\.c/); assert.match(reason('main/fixture', core), /patch\/core\.patch \(apply-checked at admission\)/);
  assert.match(reason('main/fixture', cuda), /ds4_cuda\.cu/); assert.match(reason('main/fixture', guarded), /GNU make skips on macOS/);
  assert.match(reason('llama/fixture', core), /llama-server serves the weights/); assert.match(reason('main/fixture', merge), /^Merge commit/);
  const fact = id => record.tracks[0].commits.find(c => c.id === id);
  assert.deepEqual(record.tracks[0].commits.map(c => c.id), git(candidate, ['rev-list', '--reverse', '--topo-order', base + '..' + tip]).split('\n'));
  assert.deepEqual([fact(guarded).makefile, fact(build).makefile, fact(cuda).makefile], ['non-darwin-branch', 'evaluated-on-macos', undefined]);
  assert.deepEqual(fact(renamed).files, [{status: 'R', path: 'docs/NOTES.md', from: 'README.md'}]);
  assert.deepEqual([fact(merge).parents, fact(merge).files], [2, [{status: 'M', path: 'docs/NOTES.md'}]]);
  assert.equal(fact(core).firstParentDiffSha256, sha(spawnSync('git', ['-C', candidate, 'show', '--format=', '--first-parent', '--abbrev=7', core],
    {env: {...env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1'}}).stdout));
  const tree = record.shippedTrees[0];
  assert.deepEqual([tree.equal, tree.upstreamFiles, tree.shippedIdentical, tree.declaredOmitted, tree.omittedByClass], [true, 8, 7, 1, {tooling: 1}]);
  assert.deepEqual(record.tracks[0].observedRemote, {date: '2026-01-02', sha: tip, descendsFromTip: true, commitsNotReviewed: 0});
  pass('synthetic history: CUDA-only and guarded build rules are not applicable, a shared file is integrated, an uncovered path stays unclassified', {decisions: runtime});

  const bytes = () => [fs.readFileSync(manifestPath, 'utf8'), fs.readFileSync(path.join(fixture, first.inventory), 'utf8')];
  const generated = bytes();
  assert.deepEqual(run(options).written, []); assert.deepEqual(bytes(), generated);
  assert.deepEqual(run({...options, captured: undefined, observedTip: undefined, check: true}).stale, []);
  assert.deepEqual(run({root: fixture, check: true}).stale, []);
  pass('a second run, with or without the review checkout, produces identical bytes');

  // The admission checker reads the generated reviews as it reads the shipped ones.
  const admission = checkUpstream({manifest: produced, root: fixture, repositories: {main: candidate, llama: candidate, laguna: candidate}});
  assert.deepEqual(admission.issueCounts, {MISSING_GATE: 3, UNCLASSIFIED_COMMIT: 11}, JSON.stringify(admission.issues));
  assert.deepEqual(admission.issues.filter(i => i.code === 'UNCLASSIFIED_COMMIT').map(i => i.subject + ' ' + i.message).sort(),
    [...open.flatMap(id => ['main', 'llama', 'laguna'].map(name => `${name}/fixture main/${id}`)), `laguna/fixture main/${build}`, `laguna/fixture main/${core}`].sort());
  pass('the real admission checker accepts every generated review and still reports each unclassified commit', {issueCounts: admission.issueCounts});

  const refused = (label, change, restore) => {
    change();
    for (const attempt of [options, {root: fixture}])
      assert.throws(() => run(attempt), error => error.code === 'SHIPPED_TREE_DIFFERS', label + (attempt.repositories ? '' : ' (reviews only)'));
    assert.deepEqual(bytes(), generated, label + ': a refused run wrote output');
    restore(); assert.deepEqual(run({root: fixture, check: true}).stale, []);
    pass('refused: ' + label);
  };
  const shippedFile = name => path.join(fixture, 'src/engines/ds4', name);
  refused('a shipped file differs from the pin', () => fs.appendFileSync(shippedFile('ds4.c'), '// local edit\n'), () => fs.writeFileSync(shippedFile('ds4.c'), 'int value = 2;\n'));
  refused('the shipped tree has a file upstream lacks', () => fs.writeFileSync(shippedFile('extra.c'), 'int extra;\n'), () => fs.rmSync(shippedFile('extra.c')));
  refused('a pinned file is not shipped', () => fs.rmSync(shippedFile('Makefile')), () => fs.writeFileSync(shippedFile('Makefile'), makefile('cuda.o mmq.o', 'ds4 ds4-server')));
  refused('a shipped file lost its executable bit', () => fs.chmodSync(shippedFile('download_model.sh'), 0o644), () => fs.chmodSync(shippedFile('download_model.sh'), 0o755));
  // Declared omitted, hashes intact: still not something "integrated" may rest on.
  assert.throws(() => {writeProvenance(main => {main.omitted['ds4.c'] = {...main.files['ds4.c'], reason: 'fixture'}; delete main.files['ds4.c'];}); fs.rmSync(shippedFile('ds4.c')); run(options);},
    error => error.code === 'SHIPPED_TREE_DIFFERS' && /omits files/.test(error.message));
  writeProvenance(); fs.writeFileSync(shippedFile('ds4.c'), 'int value = 2;\n'); assert.deepEqual(bytes(), generated);
  pass('refused: a runtime file declared omitted from the snapshot');
  fs.writeFileSync(manifestPath, generated[0].replace(`"base": "${base}"`, `"base": "${cuda}"`));
  assert.throws(() => run({root: fixture}), error => error.code === 'STALE_INVENTORY');
  fs.writeFileSync(manifestPath, generated[0]);
  pass('refused: an inventory of another interval than the manifest records');
  assert.throws(() => {const other = structuredClone(produced); other.targets[1].sourceTrack = 'laguna-next'; other.targets[1].tracks = ['main', 'laguna-next'];
    write('docs/engine-upstream.json', JSON.stringify(other, null, 2) + '\n'); run({root: fixture});}, error => error.code === 'UNKNOWN_TARGET');
  fs.writeFileSync(manifestPath, generated[0]);
  pass('refused: a target whose relation to main is not recorded');

  // A porting review for the separate target: its two runtime commits (core,
  // build) get hand-written verdicts. Written out of order and indented
  // differently; the generator renders it canonically.
  const portPath = 'docs/upstream/laguna-port-review-2026-01-03.json', portFull = path.join(fixture, portPath);
  const title = id => fact(id).title;
  const portReview = (change = r => r) => change({schema: 'dstudio.laguna-port-review.v1', capturedAt: '2026-01-03',
    sources: {repository: remote, readAt: '2026-01-03T00:00:00Z', main: {base, tip}, laguna: {tip}},
    inventory: {path: first.inventory, sha256: sha(fs.readFileSync(path.join(fixture, first.inventory)))},
    reviews: [
      {verdict: 'candidate', commit: build, title: title(build), group: 'build', reason: 'The fixture branch has the same default build rules.', fixes: 'builds ds4-server', laguna: 'Makefile: all'},
      {commit: core, title: title(core), group: 'engine-shared', verdict: 'not-applicable', reason: 'The fixture branch never executes this value.'}]});
  const withPort = structuredClone(produced); withPort.targets[2].portReview = portPath;
  fs.writeFileSync(manifestPath, JSON.stringify(withPort, null, 2) + '\n');
  fs.writeFileSync(portFull, JSON.stringify(portReview(), null, 2) + '\n');
  const ported = run({root: fixture}), portedManifest = json(manifestPath), canonical = json(portFull);
  assert.deepEqual(ported.written.sort(), ['docs/engine-upstream.json', portPath]);
  assert.deepEqual(canonical.reviews.map(r => [r.commit, Object.keys(r)]), [[core, ['commit', 'title', 'group', 'verdict', 'reason']],
    [build, ['commit', 'title', 'group', 'verdict', 'reason', 'fixes', 'laguna']]], 'inventory order and fixed key order');
  const portedLaguna = portedManifest.targets[2].reviews.find(r => r.commit === core);
  assert.equal(portedLaguna.decision, 'not-applicable'); assert.match(portedLaguna.reason, /^Porting review against this target's own branch: /);
  assert.deepEqual(portedLaguna.evidence.map(e => e.path), [first.inventory, portPath]);
  assert.equal(portedLaguna.evidence[1].sha256, sha(fs.readFileSync(portFull)));
  assert.ok(!portedManifest.targets[2].reviews.some(r => r.commit === build), 'a porting candidate is not a review');
  assert.deepEqual(ported.targets[2].unclassified.map(u => u.commit), [build, ...open]);
  assert.equal(ported.targets[2].unclassified[0].why, 'porting candidate: builds ds4-server');
  assert.deepEqual(run({root: fixture, check: true}).stale, []);
  const portAdmission = checkUpstream({manifest: portedManifest, root: fixture, repositories: {main: candidate, llama: candidate, laguna: candidate}});
  assert.deepEqual(portAdmission.issueCounts, {MISSING_GATE: 3, UNCLASSIFIED_COMMIT: 10}, 'the candidate stays an admission issue; the decided commit does not');
  pass('porting review: a not-applicable verdict becomes a review citing the file, a candidate stays unclassified, and the file is rendered canonically');

  const portBytes = fs.readFileSync(portFull, 'utf8'), manifestBytes = fs.readFileSync(manifestPath, 'utf8');
  const portRefused = (label, change, code) => {
    fs.writeFileSync(portFull, JSON.stringify(portReview(change), null, 2) + '\n');
    assert.throws(() => run({root: fixture}), error => error.code === code, label);
    assert.equal(fs.readFileSync(manifestPath, 'utf8'), manifestBytes, label + ': a refused run wrote the manifest');
    fs.writeFileSync(portFull, portBytes);
    pass('refused porting review: ' + label);
  };
  portRefused('a runtime commit without a verdict', r => ({...r, reviews: r.reviews.slice(1)}), 'STALE_PORT_REVIEW');
  portRefused('a verdict for a commit the path rules decide', r => ({...r, reviews: [...r.reviews, {...r.reviews[1], commit: cuda, title: title(cuda)}]}), 'STALE_PORT_REVIEW');
  portRefused('another commit inventory', r => ({...r, inventory: {...r.inventory, sha256: '0'.repeat(64)}}), 'STALE_PORT_REVIEW');
  portRefused('another Laguna revision', r => ({...r, sources: {...r.sources, laguna: {tip: base}}}), 'STALE_PORT_REVIEW');
  portRefused('an unknown verdict', r => ({...r, reviews: [{...r.reviews[0], verdict: 'probably-fine'}, r.reviews[1]]}), 'INVALID_PORT_REVIEW');
  portRefused('a candidate that does not say what Laguna has', r => ({...r, reviews: [{...r.reviews[0], laguna: ''}, r.reviews[1]]}), 'INVALID_PORT_REVIEW');
  portRefused('a verdict twice', r => ({...r, reviews: [...r.reviews, r.reviews[1]]}), 'INVALID_PORT_REVIEW');
  assert.deepEqual(run({root: fixture, check: true}).stale, []);
  report.passed = true;
} catch (error) {report.error = String(error.stack || error); console.error(report.error); process.exitCode = 1;}
finally {report.finished = new Date().toISOString(); writeArtifact(work, 'results.json', report); console.log(work);}

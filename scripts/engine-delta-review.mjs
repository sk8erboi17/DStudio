#!/usr/bin/env node
// Source-delta review of the ds4 `main` track for docs/engine-upstream.json.
//
//   node scripts/engine-delta-review.mjs --captured 2026-11-11 \
//     --repo main=/review/main --repo laguna=/review/laguna [--observed-tip SHA]
//       compares src/engines/ with the pinned upstream trees and refuses on any
//       difference, writes the commit inventory
//       docs/upstream/main-delta-<date>.json, then the reviews;
//   node scripts/engine-delta-review.mjs
//       rebuilds only the `reviews` arrays, from the committed inventory;
//   --check writes nothing and fails when a file would change.
//
// DStudio ships the pinned tree's files unmodified (datasets are declared
// omissions) and patches them at install. So "is this commit in DStudio" is a
// tree comparison, and "does it concern this target" is decided by the changed
// paths (PATH_RULES) plus one Makefile guard. Nothing here reads a diff for
// behaviour, runs an engine, fetches, moves a pin or adds a receipt. A commit
// the rules cannot decide gets no review, so admission keeps reporting it.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const TRACK = 'main';
const SHA = /^[0-9a-f]{40}$/;
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const fail = (code, message) => {throw Object.assign(new Error(message), {code});};

// First match wins. The `compiled` runtime rules are the include closure of
// upstream's Darwin `all` target, which DStudio's `make` builds and its Agent,
// Chat and Design builds link (tests/integration/engine_delta_review_test.mjs
// recomputes that closure with the compiler from the shipped tree). The other
// runtime rules are the Metal kernels ds4_metal.m reads from metal/ when it
// starts and the downloader src/dstudio.c executes. Every other class is
// something no macOS Metal runtime compiles or reads. A path no rule covers
// leaves its commit unclassified.
export const PATH_RULES = [
  {class: 'other-backend', label: 'CUDA, ROCm or Linux-only sources',
    patterns: ['^cuda/', '^rocm/', '\\.cuh?$', '^ds4_rocm', '^ds4_linux_memory\\.h$', '^ds4_iq2_tables_cuda\\.inc$', '^run-nvidia-tp-server\\.sh$']},
  {class: 'upstream-test', label: 'upstream tests, fixtures and test vectors', patterns: ['^tests/']},
  {class: 'tooling', label: 'conversion, quantization, steering and scoring tools with their data',
    patterns: ['^gguf-tools/', '^dir-steering/', '^misc/']},
  {class: 'benchmark', label: 'upstream benchmark programs and results', patterns: ['^speed-bench/']},
  {class: 'documentation', label: 'documentation, licences and repository metadata',
    patterns: ['\\.md$', '^docs/', '(^|/)LICENSE$', '^licenses/', '^logo\\.svg$', '(^|/)\\.gitignore$', '^\\.gitattributes$', '^\\.github/']},
  {class: 'runtime', basis: 'compiled', label: 'the engine core',
    files: ['ds4.c', 'ds4.h', 'ds4_gpu.h', 'ds4_gpu_copy.h', 'ds4_gpu_tp.h', 'ds4_gpu_mgpu.h', 'ds4_gpu_args.c', 'ds4_gpu_args.h',
      'ds4_image.c', 'ds4_image.h', 'third_party/iris/jpeg.h', 'third_party/iris/png.h', 'ds4_distributed.c', 'ds4_distributed.h',
      'ds4_tp.c', 'ds4_tp.h', 'ds4_ssd.c', 'ds4_ssd.h', 'ds4_layer_pack.c', 'ds4_layer_pack.h', 'ds4_engram.c', 'ds4_engram.h',
      'ds4_deepseek41_gpu.h', 'ds4_deepseek41_dspark.h', 'ds4_qwen4_vision.h', 'ds4_qwen4_unicode.inc', 'ds4_streaming_hotlist.inc',
      'ds4_streaming_hotlist_glm52.inc', 'ds4_tool_text.h', 'ds4_prompt_prefix.c', 'ds4_prompt_prefix.h', 'ds4_kvstore.c',
      'ds4_kvstore.h', 'ds4_help.c', 'ds4_help.h']},
  {class: 'runtime', basis: 'compiled', label: 'the Metal backend', files: ['ds4_metal.m']},
  {class: 'runtime', basis: 'read-at-run-time', label: 'the Metal kernels read at run time', patterns: ['^metal/[^/]+\\.metal$']},
  {class: 'runtime', basis: 'compiled', label: 'the Chat server', files: ['ds4_server.c', 'rax.c', 'rax.h', 'rax_malloc.h']},
  {class: 'runtime', basis: 'compiled', label: 'the Agent and its web helper', files: ['ds4_agent.c', 'ds4_web.c', 'ds4_web.h', 'linenoise.c', 'linenoise.h']},
  {class: 'runtime', basis: 'compiled', label: 'the command-line, benchmark and evaluation programs',
    files: ['ds4_cli.c', 'ds4_bench.c', 'ds4_eval.c', 'ds4_eval_cases.c', 'ds4_eval_cases.h']},
  {class: 'runtime', basis: 'executed-by-dstudio', label: 'the model downloader DStudio runs', files: ['download_model.sh']},
  // Decided per commit by makefileScope(): `runtime` unless every changed line
  // is in a branch GNU make skips on macOS.
  {class: 'build-rules', label: 'the build rules', files: ['Makefile']}
];
const compiled = PATH_RULES.map(rule => ({...rule, regex: (rule.patterns || []).map(p => new RegExp(p)), names: new Set(rule.files || [])}));
export const ruleFor = file => compiled.find(rule => rule.names.has(file) || rule.regex.some(r => r.test(file))) || null;

// How a target relates to the main tree, by its source track (src/dstudio_setup.c,
// src/dstudio_launch.c): `runtime` builds its engine from it; `frontend` is
// served by llama-server and has its Agent, Cowork and Design frontends built
// from the main checkout; `separate` builds everything from its own branch, so
// a main change reaches it only if someone ports it, which no path rule can
// judge. A target with another source track is refused, not guessed.
const MAIN_ROLE = {main: 'runtime', llama: 'frontend', laguna: 'separate'};

// Same isolation as the admission checker, and never a lazy fetch.
const GIT_ENV = {...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
  GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1'};
function git(dir, args, {text = true, input} = {}) {
  const r = spawnSync('git', ['-C', dir, ...args], {input, encoding: text ? 'utf8' : undefined, maxBuffer: 1024 * 1024 * 1024, env: GIT_ENV});
  if (r.error || r.signal || r.status !== 0) fail('GIT_UNAVAILABLE', r.error?.message || String(r.stderr).trim() || 'git ' + args[0] + ' failed');
  return r.stdout;
}
const gitTrue = (dir, args) => spawnSync('git', ['-C', dir, ...args], {stdio: 'ignore', env: GIT_ENV}).status === 0;

// Objects holding only scalars stay on one line; the rest indents like JSON.stringify(v, null, 2).
function render(value, pad = '') {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  const isArray = Array.isArray(value), entries = isArray ? value.map(v => [null, v]) : Object.entries(value);
  if (!entries.length) return isArray ? '[]' : '{}';
  const item = ([key, v], inner) => (isArray ? '' : JSON.stringify(key) + ': ') + render(v, inner);
  if (!isArray && entries.every(([, v]) => v === null || typeof v !== 'object'))
    return '{' + entries.map(e => item(e, pad)).join(', ') + '}';
  return (isArray ? '[' : '{') + '\n' + entries.map(e => pad + '  ' + item(e, pad + '  ')).join(',\n') + '\n' + pad + (isArray ? ']' : '}');
}

// ---- shipped tree against the pinned upstream tree --------------------------

function walk(directory, relative = '', out = []) {
  for (const entry of fs.readdirSync(path.join(directory, relative), {withFileTypes: true}).sort((a, b) => a.name < b.name ? -1 : 1)) {
    const name = relative ? relative + '/' + entry.name : entry.name;
    if (entry.isDirectory()) walk(directory, name, out); else out.push({name, file: entry.isFile()});
  }
  return out;
}
// One line per shipped file: content hash, executable bit, path.
function shippedDigest(root, directory) {
  return sha256(walk(path.join(root, directory)).map(({name, file}) => {
    const full = path.join(root, directory, name);
    return (file ? sha256(fs.readFileSync(full)) + ' ' + (fs.statSync(full).mode & 0o111 ? 'x' : '-') : 'not-a-regular-file -') + ' ' + name + '\n';
  }).join(''));
}
function upstreamTree(repo, commit) {
  const entries = git(repo, ['ls-tree', '-r', '-z', '--full-tree', commit]).split('\0').filter(Boolean).map(line => {
    const [meta, name] = [line.slice(0, line.indexOf('\t')), line.slice(line.indexOf('\t') + 1)];
    const [mode, type, oid] = meta.split(' ');
    return {name, mode, type, oid};
  });
  const blobs = entries.filter(e => e.type === 'blob');
  const out = git(repo, ['cat-file', '--batch'], {text: false, input: blobs.map(e => e.oid + '\n').join('')});
  let at = 0;
  for (const entry of blobs) {
    const end = out.indexOf(10, at), [oid, type, size] = out.subarray(at, end).toString().split(' ');
    if (oid !== entry.oid || type !== 'blob') fail('GIT_UNAVAILABLE', 'The review checkout lacks ' + entry.name + ' at ' + commit);
    entry.bytes = Number(size); entry.sha256 = sha256(out.subarray(end + 1, end + 1 + entry.bytes)); at = end + 2 + entry.bytes;
  }
  return entries;
}
export function compareShippedTree(root, repo, id, engine) {
  const directory = 'src/engines/' + engine.directory, missing = [], different = [], omittedByClass = {};
  let identical = 0, declaredOmitted = 0;
  const upstream = upstreamTree(repo, engine.commit), names = new Set(upstream.map(e => e.name));
  for (const entry of upstream) {
    const executable = entry.mode === '100755', full = path.join(root, directory, entry.name);
    const recorded = engine.files[entry.name], omitted = engine.omitted?.[entry.name], claim = recorded || omitted;
    if (entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode)) different.push(entry.name + ': upstream mode ' + entry.mode);
    else if (!claim) missing.push(entry.name);
    else if (claim.sha256 !== entry.sha256 || claim.bytes !== entry.bytes || claim.executable !== executable)
      different.push(entry.name + ': the provenance manifest differs from upstream');
    else if (omitted && !recorded) {
      const kind = ruleFor(entry.name)?.class || 'no-rule';
      declaredOmitted++; omittedByClass[kind] = (omittedByClass[kind] || 0) + 1;
    } else {
      const stat = fs.lstatSync(full, {throwIfNoEntry: false});
      if (!stat) missing.push(entry.name);
      else if (!stat.isFile() || sha256(fs.readFileSync(full)) !== entry.sha256) different.push(entry.name + ': shipped content differs from upstream');
      else if (!!(stat.mode & 0o111) !== executable) different.push(entry.name + ': executable bit differs from upstream');
      else identical++;
    }
  }
  const shipped = walk(path.join(root, directory)).map(e => e.name);
  const extra = [...new Set([...shipped, ...Object.keys(engine.files), ...Object.keys(engine.omitted || {})])].filter(name => !names.has(name)).sort();
  return {engine: id, directory, commit: engine.commit, tree: git(repo, ['rev-parse', engine.commit + '^{tree}']).trim(),
    upstreamFiles: upstream.length, shippedIdentical: identical, declaredOmitted, omittedByClass, missing, extra, different,
    equal: !missing.length && !extra.length && !different.length, shippedDigest: shippedDigest(root, directory)};
}

// ---- commit inventory ---------------------------------------------------------

// Per Makefile line: true when it sits in a branch GNU make never evaluates on
// macOS, the `else` side of `ifeq ($(UNAME_S),Darwin)` or the first side of
// `ifneq ($(UNAME_S),Darwin)`. Directive lines themselves count as evaluated.
export function nonDarwinLines(text) {
  const stack = [], out = [];
  let continued = false;
  for (const line of text.split('\n')) {
    const directive = !continued && !line.startsWith('\t') && /^ *(ifeq|ifneq|ifdef|ifndef|else|endif)\b(.*)$/.exec(line);
    continued = line.endsWith('\\');
    if (!directive) {out.push(stack.some(frame => frame.skipped)); continue;}
    out.push(false);
    const [, word, rest] = directive;
    if (word === 'endif') stack.pop();
    else if (word === 'else') {const top = stack[stack.length - 1]; if (top?.darwin) top.skipped = !top.firstSkipped;}
    else {
      const darwin = /^\s*\(\s*\$\(UNAME_S\)\s*,\s*Darwin\s*\)\s*$/.test(rest) && (word === 'ifeq' || word === 'ifneq');
      stack.push({darwin, firstSkipped: darwin && word === 'ifneq', skipped: darwin && word === 'ifneq'});
    }
  }
  return out;
}
function makefileScope(repo, parent, commit) {
  const side = rev => gitTrue(repo, ['cat-file', '-e', rev + ':Makefile']) ? nonDarwinLines(git(repo, ['show', rev + ':Makefile'])) : [];
  const before = side(parent), after = side(commit);
  let changed = 0, skipped = 0;
  for (const line of git(repo, ['diff', '-U0', '--no-color', '--no-ext-diff', parent, commit, '--', 'Makefile']).split('\n')) {
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!hunk) continue;
    for (const [lines, start, count] of [[before, +hunk[1], +(hunk[2] ?? 1)], [after, +hunk[3], +(hunk[4] ?? 1)]])
      for (let n = start; n < start + count; n++) {changed++; if (lines[n - 1]) skipped++;}
  }
  return changed > 0 && changed === skipped ? 'non-darwin-branch' : 'evaluated-on-macos';
}

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
export const DIFF_REPRESENTATION = 'git show --format= --first-parent --no-color --no-ext-diff --no-textconv --abbrev=7; binary changes are recorded as Git notices, not embedded binary patch payloads';
function readCommits(repo, base, tip, repository) {
  if (!gitTrue(repo, ['merge-base', '--is-ancestor', base, tip]))
    fail('DIVERGED_HISTORY', 'The recorded tip does not descend from the recorded base in ' + repo);
  return git(repo, ['rev-list', '--reverse', '--topo-order', base + '..' + tip]).split('\n').filter(Boolean).map(id => {
    const [parents, date, title] = git(repo, ['show', '-s', '--format=%P%x00%aI%x00%s', id]).replace(/\n$/, '').split('\0');
    const parent = parents ? parents.split(' ')[0] : EMPTY_TREE;
    const fields = git(repo, ['diff-tree', '-r', '-z', '-M50%', '--name-status', parent, id]).split('\0').filter(Boolean), files = [];
    for (let i = 0; i < fields.length;) {
      const status = fields[i++][0];
      if (status === 'R' || status === 'C') {files.push({status, path: fields[i + 1], from: fields[i]}); i += 2;}
      else files.push({status, path: fields[i++]});
    }
    const commit = {id, date, title, url: repository.replace(/\.git$/, '') + '/commit/' + id, parents: parents ? parents.split(' ').length : 0,
      firstParentDiffSha256: sha256(git(repo, ['show', '--format=', '--first-parent', '--no-color', '--no-ext-diff', '--no-textconv', '--abbrev=7', id], {text: false}))};
    if (files.some(f => f.path === 'Makefile' || f.from === 'Makefile')) commit.makefile = makefileScope(repo, parent, id);
    return {...commit, files};
  });
}

export function buildInventory({root, manifest, provenance, repositories, captured, observedTip}) {
  const track = manifest.tracks.find(t => t.id === TRACK);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(captured || '')) fail('INVALID_ARGUMENT', 'Supply --captured YYYY-MM-DD');
  if (!repositories[TRACK]) fail('MISSING_REPOSITORY', 'Supply --repo ' + TRACK + '=/path/to/review/checkout');
  const shippedTrees = Object.keys(repositories).sort().filter(id => provenance.engines[id])
    .map(id => compareShippedTree(root, repositories[id], id, provenance.engines[id]));
  const main = shippedTrees.find(t => t.engine === TRACK);
  if (!main) fail('MISSING_PROVENANCE', 'src/engines/manifest.json has no ' + TRACK + ' snapshot');
  if (main.commit !== track.recordedTip) fail('WRONG_CANDIDATE', 'src/engines pins ' + main.commit + ', not the recorded tip');
  const unequal = shippedTrees.filter(t => !t.equal);
  if (unequal.length) fail('SHIPPED_TREE_DIFFERS', unequal.map(t => t.directory + ' differs from upstream ' + t.commit + ': ' +
    [...t.missing.map(n => 'missing ' + n), ...t.extra.map(n => 'extra ' + n), ...t.different].join('; ')).join('\n'));
  // "Integrated" needs every file the macOS build compiles or reads to be shipped, not declared omitted.
  if (main.omittedByClass.runtime || main.omittedByClass['build-rules'] || main.omittedByClass['no-rule'])
    fail('SHIPPED_TREE_DIFFERS', main.directory + ' omits files that the macOS runtime compiles or reads, or that no path rule covers');
  const repo = repositories[TRACK], commits = readCommits(repo, track.base, track.recordedTip, track.repository);
  const row = {id: track.id, repository: track.repository, ref: track.ref, base: track.base, tip: track.recordedTip,
    status: 'Every commit of base..tip, in the admission checker\'s order. Every shipped file equals the tip\'s (shippedTrees); classification is by changed path.'};
  if (observedTip) {
    if (!SHA.test(observedTip)) fail('INVALID_ARGUMENT', 'Expected --observed-tip <40 hex>');
    const descends = gitTrue(repo, ['merge-base', '--is-ancestor', track.recordedTip, observedTip]);
    row.observedRemote = {date: captured, sha: observedTip, descendsFromTip: descends,
      commitsNotReviewed: descends ? Number(git(repo, ['rev-list', '--count', track.recordedTip + '..' + observedTip]).trim()) : null};
  }
  return {schema: 'dstudio.upstream-delta-inventory.v2', capturedAt: captured,
    scope: 'Complete commit inventory of the main track between its recorded base and tip, with the comparison of the shipped engine snapshots against their pinned upstream trees. Not a behavioural review, a release qualification or acceptance of commit-message claims.',
    limitations: [
      'Upstream commit titles are provenance, not independently verified claims about behaviour or performance.',
      'The classification derived from this file is by changed path, with one Makefile guard; no diff was reviewed for behaviour and no engine or model was run.',
      'For a merge commit the file list and diff hash describe its first-parent diff.',
      'Diff hashes are over Git\'s textual output with 7-digit abbreviated blob ids, which Git lengthens when one is ambiguous in the clone it runs in.',
      'The snapshots are not complete trees: files the provenance manifest declares omitted (datasets, test vectors and benchmark outputs) are not shipped, and only their recorded hashes were compared with upstream. omittedByClass counts them by path rule.',
      'Commits after the tip are not inventoried, and no Metal result is extrapolated to CUDA, ROCm or Vulkan.'],
    diffRepresentation: DIFF_REPRESENTATION,
    pathRules: PATH_RULES, shippedTrees, tracks: [{...row, commitCount: commits.length, commits}]};
}

// ---- reviews ------------------------------------------------------------------

const some = (items, max = 4) => items.slice(0, max).join(', ') + (items.length > max ? ' and ' + (items.length - max) + ' more' : '');
const joined = parts => parts.length < 2 ? parts.join('') : parts.slice(0, -1).join(', ') + ' and ' + parts[parts.length - 1];

// Pure: one commit of the inventory against one role. Returns a decision with
// its reason, or {unclassified: why}.
export function classifyCommit(commit, role, {tip = '', directory = 'src/engines/ds4', patches = new Map(), shipped = null} = {}) {
  const groups = new Map(), unknown = [];
  for (const file of commit.files) for (const name of file.from ? [file.from, file.path] : [file.path]) {
    const rule = ruleFor(name);
    if (!rule) {unknown.push(name); continue;}
    const skippedBuild = rule.class === 'build-rules' && commit.makefile === 'non-darwin-branch';
    const key = skippedBuild ? 'Makefile rules of other platforms' : rule.label;
    const group = groups.get(key) || {runtime: rule.class === 'runtime' || (rule.class === 'build-rules' && !skippedBuild), label: key, paths: []};
    if (!group.paths.includes(name)) group.paths.push(name);
    groups.set(key, group);
  }
  const describe = list => joined(list.map(g => g.label + ' (' + some(g.paths) + ')'));
  const runtime = [...groups.values()].filter(g => g.runtime), other = [...groups.values()].filter(g => !g.runtime);
  const merge = commit.parents > 1 ? 'Merge commit, judged by its first-parent diff. ' : '';
  if (unknown.length) return {unclassified: 'touches paths no rule covers: ' + some(unknown)};
  // A runtime file removed again before the tip is not something the shipped tree can show.
  const absent = shipped ? runtime.flatMap(g => g.paths).filter(name => !shipped.has(name)) : [];
  if (absent.length) return {unclassified: 'touches ' + some(absent) + ', which the shipped tree does not have'};
  if (!runtime.length) {
    const guard = commit.makefile === 'non-darwin-branch'
      ? ' Its Makefile lines all sit in a branch of the UNAME_S/Darwin conditional that GNU make skips on macOS.' : '';
    if (!other.length) return {decision: 'not-applicable', reason: merge + 'Changes no file relative to its first parent, so there is nothing to build or port.'};
    return {decision: 'not-applicable', reason: merge + 'Changes only ' + describe(other) + '. No macOS Metal runtime compiles or reads these' +
      (role === 'separate' ? ', so there is nothing here for this target\'s own branch to take.' : '.') + guard};
  }
  if (role === 'separate') return {unclassified: 'changes ' + describe(runtime) + ' on main; whether this target\'s own branch needs it is a source review'};
  const touched = runtime.flatMap(g => g.paths), applied = [...new Set(touched.flatMap(name => patches.get(name) || []))].sort();
  const rest = other.length ? ' Its other paths (' + joined(other.map(g => g.label)) + ') are outside the macOS runtime.' : '';
  const where = directory + ', whose shipped files equal upstream ' + tip.slice(0, 7) + ' byte for byte';
  if (role === 'frontend') return {decision: 'integrated', reason: merge + 'Changes ' + describe(runtime) + ' in the main ds4 checkout (' + where +
    '). This target\'s Agent, Cowork and Design frontends are built from that checkout while llama-server serves the weights. Whether those frontends link or execute the changed code was not analysed.' + rest};
  const onlyBuild = runtime.every(g => g.label === 'the build rules')
    ? ' GNU make parses the changed Makefile lines on macOS; whether they alter the default build was not analysed.' : '';
  return {decision: 'integrated', reason: merge + 'Changes ' + describe(runtime) + '. DStudio compiles or reads these from ' + where +
    ', so the change is in the runtime built for this target.' + onlyBuild +
    (applied.length ? ' The target\'s patch set also modifies these files: ' + applied.join(', ') + '.' : '') + rest};
}

// Upstream path -> the patches of a patch set that modify it.
function patchedFiles(root, entries) {
  const map = new Map();
  for (const entry of entries.filter(e => e.path.endsWith('.patch')))
    for (const match of fs.readFileSync(path.join(root, entry.path), 'utf8').matchAll(/^(?:--- a|\+\+\+ b)\/(\S+)/gm)) {
      const label = entry.path + (entry.check === 'apply' ? ' (apply-checked at admission)' : '');
      if (!(map.get(match[1]) || []).includes(label)) map.set(match[1], [...(map.get(match[1]) || []), label]);
    }
  return map;
}

export function buildReviews({root, manifest, inventory, inventoryPath, inventoryBytes}) {
  const track = manifest.tracks.find(t => t.id === TRACK), row = inventory.tracks.find(t => t.id === TRACK);
  if (!row || row.base !== track.base || row.tip !== track.recordedTip) fail('STALE_INVENTORY', 'The inventory does not cover the recorded base..tip');
  if (JSON.stringify(inventory.pathRules) !== JSON.stringify(PATH_RULES)) fail('STALE_INVENTORY', 'The inventory was built with other path rules');
  for (const tree of inventory.shippedTrees)
    if (!tree.equal || shippedDigest(root, tree.directory) !== tree.shippedDigest)
      fail('SHIPPED_TREE_DIFFERS', tree.directory + ' is no longer the tree that was compared with upstream ' + tree.commit);
  const shipped = inventory.shippedTrees.find(t => t.engine === TRACK && t.commit === row.tip);
  const snapshot = JSON.parse(fs.readFileSync(path.join(root, 'src/engines/manifest.json'), 'utf8')).engines[TRACK];
  if (!shipped || snapshot?.commit !== row.tip) fail('STALE_INVENTORY', 'No shipped-tree comparison for the tip');
  const shippedNames = new Set(Object.keys(snapshot.files));
  const evidence = [{path: inventoryPath, sha256: sha256(inventoryBytes)}], summary = [];
  for (const target of manifest.targets.filter(t => t.tracks.includes(TRACK))) {
    const role = MAIN_ROLE[target.sourceTrack];
    if (!role) fail('UNKNOWN_TARGET', target.id + ': no recorded relation between its source track and main');
    const patches = role === 'runtime' ? patchedFiles(root, target.patchSet ? manifest.patchSets[target.patchSet] : target.patches) : new Map();
    const counts = {integrated: 0, 'not-applicable': 0, equivalent: 0}, unclassified = [], reviews = target.reviews.filter(r => r.track !== TRACK);
    for (const commit of row.commits) {
      const result = classifyCommit(commit, role, {tip: row.tip, directory: shipped.directory, patches, shipped: shippedNames});
      if (result.unclassified) {unclassified.push({commit: commit.id, title: commit.title, why: result.unclassified}); continue;}
      counts[result.decision]++;
      reviews.push({track: TRACK, commit: commit.id, decision: result.decision, reason: result.reason, evidence});
    }
    target.reviews = reviews;
    summary.push({target: target.id, role, commits: row.commits.length, ...counts, unclassified});
  }
  return summary;
}

// The manifest keeps its two-space layout; each review takes one line.
export function renderManifest(manifest) {
  const held = new Map();
  const text = JSON.stringify({...manifest, targets: manifest.targets.map((target, index) => {
    if (!target.reviews.length) return target;
    held.set('@reviews:' + index, target.reviews); return {...target, reviews: '@reviews:' + index};
  })}, null, 2);
  return text.replace(/"(@reviews:\d+)"/g, (_, key) => '[\n' + held.get(key).map(r => '        ' + JSON.stringify(r)).join(',\n') + '\n      ]') + '\n';
}

export function run({root, repositories = {}, captured, observedTip, check = false}) {
  root = fs.realpathSync(root);
  const manifestPath = path.join(root, 'docs/engine-upstream.json'), manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const track = manifest.tracks.find(t => t.id === TRACK), outputs = new Map();
  let inventoryPath = track.deltaInventory, inventoryText;
  if (Object.keys(repositories).length) {
    const prior = inventoryPath && fs.existsSync(path.join(root, inventoryPath)) ? JSON.parse(fs.readFileSync(path.join(root, inventoryPath), 'utf8')) : null;
    if (check && prior) {captured ??= prior.capturedAt; observedTip ??= prior.tracks[0].observedRemote?.sha;}
    const provenance = JSON.parse(fs.readFileSync(path.join(root, 'src/engines/manifest.json'), 'utf8'));
    inventoryText = render(buildInventory({root, manifest, provenance, repositories, captured, observedTip})) + '\n';
    inventoryPath = track.deltaInventory = 'docs/upstream/' + TRACK + '-delta-' + captured + '.json';
    outputs.set(inventoryPath, inventoryText);
  } else {
    if (!inventoryPath) fail('MISSING_INVENTORY', 'No inventory recorded for the ' + TRACK + ' track; run with --repo first');
    inventoryText = fs.readFileSync(path.join(root, inventoryPath), 'utf8');
  }
  const summary = buildReviews({root, manifest, inventory: JSON.parse(inventoryText), inventoryPath, inventoryBytes: Buffer.from(inventoryText)});
  outputs.set('docs/engine-upstream.json', renderManifest(manifest));
  const stale = [...outputs].filter(([file, text]) => !fs.existsSync(path.join(root, file)) || fs.readFileSync(path.join(root, file), 'utf8') !== text).map(([file]) => file);
  if (!check) for (const file of stale) {
    fs.mkdirSync(path.dirname(path.join(root, file)), {recursive: true});
    fs.writeFileSync(path.join(root, file), outputs.get(file));
  }
  return {inventory: inventoryPath, written: check ? [] : stale, stale: check ? stale : [], targets: summary};
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = {root: process.cwd(), repositories: {}}, args = process.argv.slice(2);
    while (args.length) {
      const option = args.shift();
      if (option === '--root') options.root = args.shift();
      else if (option === '--captured') options.captured = args.shift();
      else if (option === '--observed-tip') options.observedTip = args.shift();
      else if (option === '--check') options.check = true;
      else if (option === '--repo') {
        const value = args.shift() || '', i = value.indexOf('=');
        if (i <= 0) fail('INVALID_ARGUMENT', 'Expected --repo track=/path');
        options.repositories[value.slice(0, i)] = fs.realpathSync(value.slice(i + 1));
      } else fail('INVALID_ARGUMENT', 'Unknown argument: ' + option);
    }
    const report = run(options);
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.stale.length ? 1 : 0;
  } catch (error) {console.error((error.code ? error.code + ': ' : '') + error.message); process.exitCode = 1;}
}

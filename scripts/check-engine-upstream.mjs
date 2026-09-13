// Release admission only: never fetch, reset, patch, build or launch an engine.
// Reviews are human/source judgments; this checks their coverage and identities,
// not their semantic truth or the correctness of a model's answers.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const SHA = /^[0-9a-f]{40}$/;
const HASH = /^[0-9a-f]{64}$/;
const ID = /^[a-z0-9][a-z0-9_./-]{0,127}$/;
const MAX_BYTES = 16 * 1024 * 1024;
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const identity = s => [s.dev,s.ino,s.size,s.mtimeNs,s.ctimeNs].join(':');
const fail = (code, message) => {throw Object.assign(new Error(message), {code});};
function requireValue(value, message) {if (!value) fail('INVALID_MANIFEST', message);}
function list(value, max, name, empty = false) {
  requireValue(Array.isArray(value) && value.length <= max && (empty || value.length > 0), name);
  return value;
}
function unique(items, name) {
  requireValue(new Set(items).size === items.length, 'Duplicate ' + name);
}
function localFile(root, relative) {
  requireValue(typeof relative === 'string' && relative.length < 1024 && !path.isAbsolute(relative), 'Expected repository-relative path');
  const full = path.resolve(root, relative);
  requireValue(full.startsWith(root + path.sep), 'Path escapes the evidence root');
  const actual = fs.realpathSync(full);
  requireValue(actual === full, 'Linked evidence/patch path is not accepted');
  const fd = fs.openSync(full, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const before = fs.fstatSync(fd, {bigint: true});
    requireValue(before.isFile() && before.size <= BigInt(MAX_BYTES), 'Missing or oversized evidence file');
    const bytes = fs.readFileSync(fd);
    requireValue(identity(before) === identity(fs.fstatSync(fd, {bigint:true})) &&
      identity(before) === identity(fs.lstatSync(full, {bigint:true})), 'Input changed while reading');
    return bytes;
  } finally {fs.closeSync(fd);}
}
function checkedFile(root, entry) {
  requireValue(entry && HASH.test(entry.sha256), 'Missing content hash');
  const bytes = localFile(root, entry.path);
  if (digest(bytes) !== entry.sha256) fail('CONTENT_CHANGED', entry.path);
  return bytes;
}
export function patchSetHash(patches) {
  return digest([...patches].sort((a,b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
    .map(p => p.path + '\0' + p.sha256 + '\n').join(''));
}
function git(dir, args, allowFailure = false) {
  // The caller may itself run inside a Git hook/worktree. Its environment must
  // not turn this checkout's HEAD, objects or origin into another repository's.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('GIT_')));
  const r = spawnSync('git', ['-C', dir, ...args], {encoding:'utf8', timeout:20000,
    maxBuffer:8 * 1024 * 1024, env:{...env, GIT_TERMINAL_PROMPT:'0',
      GIT_CONFIG_NOSYSTEM:'1', GIT_CONFIG_GLOBAL:'/dev/null', GIT_OPTIONAL_LOCKS:'0'}});
  if (r.error || r.signal || (!allowFailure && r.status !== 0))
    fail('GIT_UNAVAILABLE', r.error?.message || r.stderr.trim() || 'Git command failed');
  return r;
}
const canonicalRepo = s => s.replace(/\.git\/?$/, '').replace(/\/$/, '');
function repository(dir, remote) {
  if (typeof dir !== 'string' || !dir) fail('MISSING_REPOSITORY', 'Supply --repo track=/path/to/isolated-git-checkout');
  const actual = fs.realpathSync(dir);
  if (fs.realpathSync(git(actual, ['rev-parse','--show-toplevel']).stdout.trim()) !== actual)
    fail('PARENT_GIT_REJECTED', 'Archive installs cannot inherit a parent Git identity');
  const origin = git(actual, ['config','--get','remote.origin.url']).stdout.trim();
  if (canonicalRepo(origin) !== canonicalRepo(remote)) fail('WRONG_ORIGIN', 'Checkout origin differs from the reviewed repository');
  return actual;
}

export function checkUpstream({manifest, root, repositories = {}, offline = false, application, platform = 'all'}) {
  root = fs.realpathSync(root);
  const report = {schema:'dstudio.engine-upstream.v1', started:new Date().toISOString(),
    scope:'Upstream review and evidence admission; no builds, downloads, model runs or source mutations',
    platform, tracks:[], targets:[], outsideScope:[], issues:[], issueCount:0, issueCounts:{}, passed:false};
  const issue = (subject, error) => {
    const code = error.code || 'MISSING_INPUT';
    report.issueCount++;
    report.issueCounts[code] = (report.issueCounts[code] || 0) + 1;
    if (report.issues.length < 1024)
      report.issues.push({subject, code, message:error.message});
  };
  const attempt = (subject, fn) => {try {return fn();} catch(e) {issue(subject,e); return null;}};
  try {
    requireValue(manifest?.schemaVersion === 1, 'Unsupported manifest schema');
    const tracks = list(manifest.tracks, 16, 'tracks');
    const declaredTargets = list(manifest.targets, 256, 'targets');
    unique(tracks.map(t=>t.id), 'track'); unique(declaredTargets.map(t=>t.id), 'target');
    requireValue(['all','macos','linux','windows'].includes(platform), 'Unknown release platform');
    const targets = declaredTargets.filter(target => {
      requireValue(['macos','linux','windows'].includes(target.platform), 'Each target requires one explicit platform');
      if (platform === 'all' || target.platform === platform) return true;
      report.outsideScope.push({id:target.id,status:'NOT_APPLICABLE',reason:'Outside the selected ' + platform + ' release, not qualified by this run'});
      return false;
    });
    if (!targets.length) fail('MISSING_TARGETS','The selected platform has no declared target');
    const neededTracks = new Set(targets.flatMap(target=>list(target.tracks,16,'target tracks')));
    const installerPins = new Map();
    if (manifest.requireInstallerPins) attempt('application', () => {
      requireValue(manifest.requireInstallerPins === true && typeof application === 'string', 'Supply --application /path/to/built/DStudio');
      const binary = fs.realpathSync(application), before = fs.statSync(binary,{bigint:true});
      requireValue(before.isFile() && before.size <= 64n * 1024n * 1024n, 'Invalid metadata executable');
      const binarySHA256 = digest(fs.readFileSync(binary));
      // This native batch command returns before profile discovery, network,
      // process/model initialization and window creation. It does not install.
      // Older desktop builds do not recognize this option. Force their
      // headless entry point so their argument error cannot open a user window.
      const env = Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('DS4')));
      Object.assign(env,{DS4UI_NO_WINDOW:'1',DS4UI_TEST_MODE:'1',DS4UI_DEFER_ENGINE_START:'1'});
      const r = spawnSync(binary,['--engine-pins'],{env,encoding:'utf8',timeout:10000,killSignal:'SIGKILL',maxBuffer:65536});
      if (r.error || r.signal || r.status !== 0) fail('PIN_EXPORT_FAILED', 'The built app could not report its installer pins');
      requireValue(identity(before) === identity(fs.statSync(binary,{bigint:true})), 'Application changed during admission');
      const data = JSON.parse(r.stdout);
      requireValue(data.schema === 'dstudio.engine-pins.v1', 'Unknown installer pin protocol');
      list(data.engines,16,'installer pins');unique(data.engines.map(e=>e.id),'installer pin');
      for (const entry of data.engines) {
        requireValue(ID.test(entry.id) && SHA.test(entry.commit) && typeof entry.archiveURL === 'string', 'Invalid installer pin');
        installerPins.set(entry.id,entry);
      }
      report.application = {binarySHA256,engines:data.engines};
    });
    const trackMap = new Map(tracks.map(t=>[t.id,t]));
    const observed = new Map();
    const failedTracks = new Set();
    for (const track of tracks) {
      if (!neededTracks.has(track.id)) continue;
      const before = report.issueCount;
      const row = {id:track.id,base:track.base,recordedTip:track.recordedTip,passed:false};
      report.tracks.push(row);
      attempt(track.id, () => {
      requireValue(ID.test(track.id) && SHA.test(track.base) && SHA.test(track.recordedTip), 'Invalid track identity');
      requireValue(typeof track.repository === 'string' &&
        (/^https:\/\/[^\s]+$/.test(track.repository) || path.isAbsolute(track.repository)), 'Unsupported repository transport');
      requireValue(/^refs\/heads\/[A-Za-z0-9_./-]+$/.test(track.ref), 'Expected a branch ref');
      const dir = repository(repositories[track.id], track.repository);
      let tip;
      if (offline) {
        tip = git(dir, ['rev-parse', '--verify', track.ref]).stdout.trim();
        issue(track.id, {code:'FRESHNESS_UNVERIFIED',message:'Offline inspection cannot authorize promotion'});
      } else {
        const refs = git(root, ['ls-remote', '--exit-code', track.repository, track.ref]).stdout.trim().split('\n');
        requireValue(refs.length === 1, 'Ambiguous remote ref');
        const [sha, ref] = refs[0].split(/\s+/);
        requireValue(SHA.test(sha) && ref === track.ref, 'Invalid remote identity'); tip = sha;
      }
      row.remoteTip = tip;
      if (tip !== track.recordedTip) issue(track.id, {code:'UNREVIEWED_TIP',message:'Remote advanced or rewrote: ' + tip});
      git(dir, ['cat-file','-e',tip + '^{commit}']);
      if (git(dir, ['merge-base','--is-ancestor',track.base,tip], true).status !== 0)
        fail('DIVERGED_HISTORY', 'Remote is not a descendant of the recorded baseline');
      const commits = git(dir, ['rev-list','--reverse','--topo-order','--max-count=4097',track.base + '..' + tip])
        .stdout.trim().split('\n').filter(Boolean);
      requireValue(commits.length <= 4096, 'History exceeds the explicit review budget');
      row.commits = commits; observed.set(track.id, {dir, tip, commits, commitSet:new Set(commits)});
      });
      row.passed = report.issueCount === before;
      if (!row.passed) failedTracks.add(track.id);
    }
    for (const target of targets) {
      const before = report.issueCount;
      const row = {id:target.id,platform:target.platform,revision:target.revision,passed:false};
      report.targets.push(row);
      attempt(target.id, () => {
      requireValue(ID.test(target.id) && SHA.test(target.revision), 'Invalid engine/backend/checkpoint target');
      list(target.tracks,16,'target tracks'); unique(target.tracks,'target track');
      requireValue(target.tracks.every(id=>trackMap.has(id)) && target.tracks.includes(target.sourceTrack), 'Unknown or omitted source track');
      if (manifest.requireInstallerPins) {
        const pin = installerPins.get(target.installerId);
        if (!pin) issue(target.id,{code:'INSTALLER_MISSING',message:'No compiled installer for ' + target.installerId});
        else {
          if (pin.commit !== target.revision) issue(target.id,{code:'STALE_INSTALLER_PIN',message:'Built app installs ' + pin.commit + ', not ' + target.revision});
          const repo = trackMap.get(target.sourceTrack).repository;
          if (repo.startsWith('https://github.com/') && pin.archiveURL !== canonicalRepo(repo).replace('https://github.com/','https://codeload.github.com/') + '/tar.gz/' + target.revision)
            issue(target.id,{code:'WRONG_INSTALLER_ARCHIVE',message:'Compiled archive URL differs from the target source'});
        }
      }
      const source = observed.get(target.sourceTrack);
      if (!source) fail('SOURCE_UNAVAILABLE', 'Source history was not validated');
      if (git(source.dir, ['rev-parse','HEAD']).stdout.trim() !== target.revision)
        fail('WRONG_CANDIDATE', 'Actual checkout HEAD differs from the candidate revision');
      requireValue(Object.hasOwn(target,'patches') !== Object.hasOwn(target,'patchSet'), 'Choose inline patches or one named patch set');
      const patches = list(Object.hasOwn(target,'patchSet') ? manifest.patchSets?.[target.patchSet] : target.patches,
        64,'patch inputs',true);
      unique(patches.map(p=>p.path),'patch path');
      for (const patch of patches) {
        checkedFile(root,patch);
        if (patch.check) {
          requireValue(['apply','reverse'].includes(patch.check), 'Unknown patch state');
          const args = ['apply','--check','--whitespace=error'];
          if (patch.check === 'reverse') args.push('--reverse');
          args.push(path.join(root,patch.path));
          if (git(source.dir,args,true).status !== 0) fail('PATCH_CONFLICT', patch.path);
        }
      }
      const setHash = patchSetHash(patches);
      const gates = list(target.requiredGates,32,'required gates'); unique(gates,'required gate');
      requireValue(gates.every(gate=>typeof gate === 'string' && ID.test(gate)), 'Invalid gate identity');
      const receipts = list(target.receipts,128,'receipts',true);
      unique(receipts.map(entry=>entry.path),'receipt');
      const passedGates = new Set();
      for (const entry of receipts) attempt(target.id + '/' + entry.path, () => {
        const r = JSON.parse(checkedFile(root,entry));
        const q = r.qualification;
        requireValue(q?.schema === 'dstudio.engine-qualification.v1', 'Missing scoped qualification identity');
        if (q.target !== target.id || q.platform !== target.platform || q.engineRevision !== target.revision || q.patchSetSHA256 !== setHash)
          fail('STALE_RECEIPT', 'Receipt belongs to a different engine/patch/backend/checkpoint');
        requireValue(gates.includes(q.gate), 'Unexpected gate cannot satisfy this target');
        if (r.passed !== true || !Number.isFinite(Date.parse(r.finished)))
          fail('GATE_FAILED', 'Failed or unfinished ' + q.gate);
        for (const evidence of list(q.evidence,64,'raw evidence')) checkedFile(root,evidence);
        passedGates.add(q.gate);
      });
      for (const gate of gates) if (!passedGates.has(gate))
        issue(target.id, {code:'MISSING_GATE',message:gate});
      const reviews = list(target.reviews,8192,'reviews',true);
      unique(reviews.map(r=>r.track + '/' + r.commit),'review');
      const reviewMap = new Map();
      for (const review of reviews) {
        requireValue(target.tracks.includes(review.track) && SHA.test(review.commit), 'Unknown review identity');
        const history = observed.get(review.track);
        requireValue(!history || history.commitSet.has(review.commit), 'Review commit is outside the observed delta');
        reviewMap.set(review.track + '/' + review.commit, review);
      }
      for (const id of target.tracks) {
        const history = observed.get(id);
        if (!history) {issue(target.id,{code:'HISTORY_UNAVAILABLE',message:id}); continue;}
        for (const commit of history.commits) {
          const review = reviewMap.get(id + '/' + commit);
          if (!review) {issue(target.id,{code:'UNCLASSIFIED_COMMIT',message:id + '/' + commit}); continue;}
          attempt(target.id + '/' + commit, () => {
            requireValue(['integrated','equivalent','not-applicable'].includes(review.decision), 'Unresolved review');
            requireValue(typeof review.reason === 'string' && review.reason.trim().length >= 20, 'A substantive source rationale is required');
            for (const entry of list(review.evidence,16,'review evidence')) checkedFile(root,entry);
          });
        }
      }
      Object.assign(row,{patchSetSHA256:setHash,requiredGates:gates,passedGates:[...passedGates]});
      });
      row.issueCount = report.issueCount - before;
      row.passed = row.issueCount === 0 && Array.isArray(target.tracks) && target.tracks.every(id=>!failedTracks.has(id));
    }
  } catch(e) {issue('manifest',e);}
  report.finished = new Date().toISOString();
  report.passed = report.issueCount === 0;
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    let manifestPath = 'docs/engine-upstream.json', root = process.cwd(), offline = false, application, platform = 'all';
    const repositories = {}, args = process.argv.slice(2);
    while (args.length) {
      const option = args.shift();
      if (option === '--manifest') manifestPath = args.shift();
      else if (option === '--root') root = args.shift();
      else if (option === '--offline') offline = true;
      else if (option === '--application') application = args.shift();
      else if (option === '--platform') platform = args.shift();
      else if (option === '--repo') {
        const value = args.shift() || '', i = value.indexOf('=');
        requireValue(i > 0 && !Object.hasOwn(repositories,value.slice(0,i)), 'Expected unique --repo track=/path');
        repositories[value.slice(0,i)] = value.slice(i+1);
      } else fail('INVALID_ARGUMENT', 'Unknown argument: ' + option);
    }
    root = fs.realpathSync(root);
    requireValue(typeof manifestPath === 'string', 'Missing --manifest path');
    const manifest = JSON.parse(localFile(root,path.relative(root,path.resolve(root,manifestPath))));
    const report = checkUpstream({manifest,root,repositories,offline,application,platform});
    console.log(JSON.stringify(report,null,2)); process.exitCode = report.passed ? 0 : 1;
  } catch(e) {console.error(e.message); process.exitCode = 1;}
}

// Helpers shared by the held-out and long/recovery fixtures. An oracle built
// from these reads only what a task left in the workspace: file bytes, the
// output and exit status of a command it runs itself, and git's own records.
// It never reads what an agent said.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

// `files` maps a relative path to a string or a Buffer. The root is recreated.
export function writeCaseFiles(root, files) {
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
}

export function readBytes(root, relative) {
  try {
    return fs.readFileSync(path.join(root, relative));
  } catch {
    return null;
  }
}

export function readText(root, relative) {
  const bytes = readBytes(root, relative);
  return bytes === null ? null : bytes.toString('utf8');
}

export function exists(root, relative) {
  return fs.existsSync(path.join(root, relative));
}

export function bytesEqual(root, relative, expected) {
  const actual = readBytes(root, relative);
  return actual !== null && actual.equals(Buffer.isBuffer(expected) ? expected : Buffer.from(expected, 'utf8'));
}

// Every named fixture file still has the bytes the fixture wrote.
export function unchanged(root, files, names) {
  return names.every((name) => bytesEqual(root, name, files[name]));
}

// Regular files below `relative`, as sorted posix paths relative to it.
export function listFiles(root, relative = '') {
  const result = [];
  const visit = (dir) => {
    let entries = [];
    try { entries = fs.readdirSync(path.join(root, dir), { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const child = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) visit(child);
      else result.push(child);
    }
  };
  visit(relative);
  const prefix = relative ? `${relative}/` : '';
  return result.map((file) => file.slice(prefix.length)).sort();
}

export function parseJson(root, relative) {
  const text = readText(root, relative);
  if (text === null) return { error: `${relative} is missing` };
  try {
    return { value: JSON.parse(text) };
  } catch (error) {
    return { error: error.message };
  }
}

export function sameJson(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function run(command, args, { cwd, input, timeoutMs = 30_000 }) {
  const result = spawnSync(command, args, { cwd, input, encoding: 'utf8', timeout: timeoutMs });
  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    error: result.error ? result.error.message : null,
  };
}

// A program the task left behind, run by the oracle. -B: the oracle writes no
// bytecode cache into the workspace it is grading.
export function runPython(root, args, options = {}) {
  return run('python3', ['-B', ...args], { cwd: root, ...options });
}

// Checks the workspace never contained: `script` imports the task's modules
// from the case directory and must print HIDDEN_OK as its last line.
export function hiddenPython(root, script) {
  const result = run('python3', ['-I', '-B', '-c', `import sys\nsys.path.insert(0, '.')\n${script}\nprint('HIDDEN_OK')\n`],
    { cwd: root });
  return {
    ok: result.status === 0 && result.stdout.trimEnd().endsWith('HIDDEN_OK'),
    output: `${result.stdout}${result.stderr}`.trim().slice(-2000),
  };
}

export function git(cwd, args) {
  const result = run('git', args, { cwd });
  return { ok: result.status === 0, out: result.stdout.trim(), err: result.stderr.trim() };
}

// A repository with one commit holding `root` as it is now. Used by the
// fixtures whose task is to leave someone else's uncommitted work alone.
export function gitBaseline(workspace) {
  fs.rmSync(path.join(workspace, '.git'), { recursive: true, force: true });
  for (const args of [
    ['init', '--quiet'],
    ['config', 'user.name', 'DStudio Benchmark'],
    ['config', 'user.email', 'benchmark@localhost'],
    ['config', 'commit.gpgsign', 'false'],
    ['add', '-A'],
    ['commit', '--quiet', '-m', 'benchmark fixture'],
  ]) {
    const result = git(workspace, args);
    if (!result.ok) throw new Error(`git ${args.join(' ')} failed: ${result.err}`);
  }
}

// The repository still has its single fixture commit, nothing was stashed and
// the given path is still staged with the given bytes.
export function gitUntouched(workspace, staged = {}) {
  const commits = git(workspace, ['rev-list', '--count', 'HEAD']);
  if (!commits.ok || commits.out !== '1') return { ok: false, output: `history changed: ${commits.out || commits.err}` };
  const stash = git(workspace, ['stash', 'list']);
  if (!stash.ok || stash.out !== '') return { ok: false, output: 'work was stashed' };
  for (const [file, content] of Object.entries(staged)) {
    const entry = git(workspace, ['ls-files', '-s', '--', file]);
    const expected = spawnSync('git', ['hash-object', '--stdin'], { cwd: workspace, input: content })
      .stdout.toString().trim();
    if (!entry.ok || entry.out.split(/\s+/)[1] !== expected) return { ok: false, output: `staged ${file} changed` };
  }
  return { ok: true };
}

export function posixJoin(...parts) {
  return parts.join('/').replaceAll('//', '/');
}

export function completionMarker(prefix, caseId) {
  return `${prefix}_${caseId.replaceAll('-', '_').toUpperCase()}_DONE`;
}

export function finishInstruction(marker) {
  return `All paths are relative to the active workspace: do not cd to / or search outside the workspace. In the final answer include the requested result and then ${marker}.`;
}

// The first failed check decides the verdict; `output` names it.
export function verdict(checks) {
  for (const [name, passed, detail] of checks) {
    if (!passed) return { ok: false, output: detail ? `${name}: ${detail}` : name };
  }
  return { ok: true };
}

// An oracle that cannot finish its inspection has not accepted the result.
export function safeScore(score) {
  try {
    return score();
  } catch (error) {
    return { ok: false, output: `oracle could not inspect the workspace: ${error.message}` };
  }
}

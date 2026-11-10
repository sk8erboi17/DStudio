// Census of the test suites (PLAN.MD P0): which test files exist, which
// Makefile targets run them, and which broad gates reach them. It executes no
// test and judges no result; it reports files that no target or other test
// reaches, so an unrun test is visible instead of silently counted.
//
//   node tests/support/test_census.mjs [--json] [--root DIR]
import fs from 'node:fs';
import path from 'node:path';

const KINDS = ['unit', 'integration', 'browser', 'live'];
const TEST_PATH = /tests\/(?:unit|integration|browser|live)\/[A-Za-z0-9_./-]+\.(?:mjs|js|py|c|cc|mm|m|sh)/g;

// Minimal Makefile reader: rules with their prerequisites and recipe lines,
// with simple variables expanded. Later rules for the same target accumulate.
export function parseMakefile(text) {
  const vars = new Map(), rules = new Map();
  const expand = (value) => { let out = value; for (let i = 0; i < 8 && /\$\(([A-Za-z0-9_]+)\)/.test(out); i++)
    out = out.replace(/\$\(([A-Za-z0-9_]+)\)/g, (_, name) => vars.has(name) ? vars.get(name) : `$(${name})`); return out; };
  let current = [];
  for (const raw of text.replace(/\\\n/g, ' ').split('\n')) {
    if (raw.startsWith('\t')) { for (const target of current) rules.get(target).recipe.push(expand(raw.trim())); continue; }
    const line = raw.replace(/(^|\s)#.*$/, '');
    if (!line.trim()) { continue; }
    const assignment = line.match(/^([A-Za-z0-9_]+)\s*[:?+]?=\s*(.*)$/);
    if (assignment) { vars.set(assignment[1], expand(assignment[2].trim())); current = []; continue; }
    const rule = line.match(/^([^:=\t][^:=]*):(?!=)\s*(.*)$/);
    if (!rule) { current = []; continue; }
    const targets = expand(rule[1]).split(/\s+/).filter(Boolean);
    const prerequisites = expand(rule[2]).split(/\s+/).filter(Boolean);
    current = targets.filter((target) => target !== '.PHONY');
    for (const target of current) {
      if (!rules.has(target)) rules.set(target, { prerequisites: [], recipe: [] });
      rules.get(target).prerequisites.push(...prerequisites);
    }
  }
  return rules;
}

function closure(rules, start) {
  const seen = new Set(), stack = [start];
  while (stack.length) {
    const target = stack.pop();
    if (seen.has(target) || !rules.has(target)) continue;
    seen.add(target);
    stack.push(...rules.get(target).prerequisites);
  }
  return seen;
}

function listTests(root) {
  const out = [];
  const walk = (dir) => { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === '__pycache__' || entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (/\.(?:mjs|js|py|c|cc|mm|m|sh)$/.test(entry.name)) out.push(path.relative(root, full));
  } };
  for (const kind of KINDS) { const dir = path.join(root, 'tests', kind); if (fs.existsSync(dir)) walk(dir); }
  return out.sort();
}

export function census(root) {
  const rules = parseMakefile(fs.readFileSync(path.join(root, 'Makefile'), 'utf8'));
  const files = listTests(root);
  // Direct references: a file named in a rule's prerequisites or recipe.
  const direct = new Map(files.map((file) => [file, new Set()]));
  for (const [target, rule] of rules) for (const text of [...rule.prerequisites, ...rule.recipe]) {
    for (const match of text.match(TEST_PATH) || []) if (direct.has(match)) direct.get(match).add(target);
  }
  // A test started or imported by another test file is reached through it.
  const reachedBy = new Map(files.map((file) => [file, new Set()]));
  for (const file of files) {
    let text; try { text = fs.readFileSync(path.join(root, file), 'utf8'); } catch { continue; }
    for (const other of files) {
      if (other === file) continue;
      const base = path.basename(other);
      if (text.includes(other) || (path.dirname(other) === path.dirname(file) && new RegExp(`['"\`]\\./${base.replace(/[.]/g, '\\.')}['"\`]`).test(text)))
        reachedBy.get(other).add(file);
    }
  }
  const gates = Object.fromEntries(['check-fast', 'check-real'].map((gate) => [gate, closure(rules, gate)]));
  // A built test binary is reached through the target that depends on it.
  const targetsReaching = (file) => {
    const out = new Set(direct.get(file));
    for (let grew = true; grew;) { grew = false;
      for (const [target, rule] of rules) if (!out.has(target) && rule.prerequisites.some((p) => out.has(p))) { out.add(target); grew = true; } }
    return out;
  };
  const rows = files.map((file) => {
    const targets = targetsReaching(file);
    const via = [...reachedBy.get(file)];
    return { file, kind: file.split('/')[1], targets: [...direct.get(file)].sort(),
      gates: Object.keys(gates).filter((gate) => [...targets].some((target) => gates[gate].has(target))),
      reachedByTests: via.sort(), reached: targets.size > 0 || via.length > 0 };
  });
  // Reached only through another test: inherit that test's reachability.
  for (let changed = true; changed;) { changed = false;
    for (const row of rows) if (row.reached && row.targets.length === 0) {
      const parents = row.reachedByTests.map((file) => rows.find((r) => r.file === file));
      const inherited = [...new Set(parents.flatMap((p) => p.gates))].sort();
      if (inherited.join() !== row.gates.join() && inherited.length > row.gates.length) { row.gates = inherited; changed = true; }
      if (!parents.some((p) => p.targets.length || p.reachedByTests.length)) { row.reached = false; }
    }
  }
  // An explicit runner started by hand is still accounted for when a guide
  // gives its command; a file that nothing runs and nothing documents is not.
  const guides = [];
  const collect = (dir, depth) => { if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'history') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (depth > 0) collect(full, depth - 1); }
      else if (/\.(?:md|MD)$/.test(entry.name)) guides.push(full);
    } };
  for (const dir of ['docs', 'tests/docs', 'extension', 'patch']) collect(path.join(root, dir), 3);
  for (const file of ['README.md', 'tests/README.md', 'PLAN.MD']) if (fs.existsSync(path.join(root, file))) guides.push(path.join(root, file));
  const guideText = guides.map((file) => [path.relative(root, file), fs.readFileSync(file, 'utf8')]);
  for (const row of rows) if (!row.reached) row.documentedIn = guideText.filter(([, text]) => text.includes(row.file)).map(([file]) => file).sort();
  const count = (predicate) => rows.filter(predicate).length;
  return { root: '.', files: rows, summary: { total: rows.length,
    byKind: Object.fromEntries(KINDS.map((kind) => [kind, count((row) => row.kind === kind)])),
    inCheckFast: count((row) => row.gates.includes('check-fast')), inCheckReal: count((row) => row.gates.includes('check-real')),
    explicitOnly: count((row) => row.reached && row.gates.length === 0),
    // No target runs these. `documentedManual` have their command in a guide; `unreached` have nothing.
    documentedManual: rows.filter((row) => !row.reached && row.documentedIn.length).map((row) => row.file),
    unreached: rows.filter((row) => !row.reached && !row.documentedIn.length).map((row) => row.file) } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const args = process.argv.slice(2);
  const rootIndex = args.indexOf('--root');
  const result = census(path.resolve(rootIndex < 0 ? process.cwd() : args[rootIndex + 1]));
  if (args.includes('--json')) console.log(JSON.stringify(result, null, 1));
  else {
    const s = result.summary;
    console.log(`${s.total} test files: ${Object.entries(s.byKind).map(([kind, n]) => `${kind} ${n}`).join(', ')}`);
    console.log(`reached by check-fast ${s.inCheckFast}, by check-real ${s.inCheckReal}, by an explicit target only ${s.explicitOnly}, by a documented manual command only ${s.documentedManual.length}, by nothing ${s.unreached.length}`);
    for (const file of s.documentedManual) console.log(`MANUAL    ${file} (${result.files.find((row) => row.file === file).documentedIn.join(', ')})`);
    for (const file of s.unreached) console.log(`UNREACHED ${file}`);
  }
}

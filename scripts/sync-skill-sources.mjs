#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const manifestPath = path.join(root, 'extension/skills/sources.tsv');

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
  if (r.status !== 0) {
    const out = `${r.stdout || ''}${r.stderr || ''}`.trim();
    throw new Error(`${cmd} ${args.join(' ')} failed${out ? `: ${out}` : ''}`);
  }
  return (r.stdout || '').trim();
}

function parseManifest(text) {
  return text.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => {
      const [
        id,
        repo,
        ref,
        importedCommit,
        localPrefix,
        upstreamPath,
        kind = 'skills-dir',
        localTarget = 'extension/skills',
      ] = line.split('\t');
      if (!id || !repo || !ref || !importedCommit || !localPrefix || !upstreamPath) {
        throw new Error(`bad skill source manifest row: ${line}`);
      }
      return { id, repo, ref, importedCommit, localPrefix, upstreamPath, kind, localTarget };
    });
}

function writeManifest(sources) {
  const header = '# id\trepo\tref\timported_commit\tlocal_prefix\tupstream_path\tkind\tlocal_target\n';
  const rows = sources.map((s) =>
    [s.id, s.repo, s.ref, s.importedCommit, s.localPrefix, s.upstreamPath, s.kind || 'skills-dir', s.localTarget || 'extension/skills'].join('\t')
  );
  fs.writeFileSync(manifestPath, `${header}${rows.join('\n')}\n`);
}

function parseFrontmatter(content) {
  const m = content.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return { meta: {}, body: content };
  const meta = {};
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i].match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!kv) continue;
    let value = kv[2] || '';
    if (value === '|') {
      const block = [];
      while (i + 1 < lines.length && /^\s+/.test(lines[i + 1])) {
        block.push(lines[++i].replace(/^\s{2}/, ''));
      }
      value = block.join('\n').trim();
    }
    meta[kv[1]] = value.replace(/^['"]|['"]$/g, '');
  }
  return { meta, body: content.slice(m[0].length) };
}

function splitFrontmatter(content) {
  const m = content.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return { frontmatter: '', body: content, hadFrontmatter: false };
  return { frontmatter: m[1], body: content.slice(m[0].length), hadFrontmatter: true };
}

function titleFromId(id) {
  return id.split('-').map((part) => part ? part[0].toUpperCase() + part.slice(1) : part).join(' ');
}

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    if (ent.name === '.git') continue;
    const from = path.join(src, ent.name);
    const to = path.join(dst, ent.name);
    if (ent.isDirectory()) copyDir(from, to);
    else if (ent.isFile()) fs.copyFileSync(from, to);
  }
}

function removeDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function repoHead(repoDir) {
  return run('git', ['-C', repoDir, 'rev-parse', 'HEAD']);
}

function localPath(source) {
  const target = source.localTarget || 'extension/skills';
  return path.isAbsolute(target) ? target : path.join(root, target);
}

function updateFrontmatterField(content, key, value) {
  const m = content.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return content;
  const block = m[1];
  const line = `${key}: ${value}`;
  const re = new RegExp(`^${key}:.*$`, 'm');
  const next = re.test(block) ? block.replace(re, line) : `${block}\n${line}`;
  return `---\n${next}\n---\n${content.slice(m[0].length)}`;
}

function updateFrontmatterText(frontmatter, key, value) {
  const line = `${key}: ${value}`;
  const re = new RegExp(`^${key}:.*$`, 'm');
  return re.test(frontmatter) ? frontmatter.replace(re, line) : `${frontmatter}\n${line}`;
}

function stripTrailingWhitespace(content) {
  return String(content || '').replace(/[ \t]+$/gm, '');
}

function copyDirExcept(src, dst, skipNames = new Set()) {
  fs.mkdirSync(dst, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    if (ent.name === '.git' || skipNames.has(ent.name)) continue;
    const from = path.join(src, ent.name);
    const to = path.join(dst, ent.name);
    if (ent.isDirectory()) copyDir(from, to);
    else if (ent.isFile()) fs.copyFileSync(from, to);
  }
}

function copySelectedEntries(src, dst, names) {
  fs.mkdirSync(dst, { recursive: true });
  for (const name of names) {
    const from = path.join(src, name);
    if (!fs.existsSync(from)) continue;
    const to = path.join(dst, name);
    const st = fs.statSync(from);
    if (st.isDirectory()) copyDir(from, to);
    else if (st.isFile()) fs.copyFileSync(from, to);
  }
}

function localDirsByUpstream(localBase, mainFile, upstreamPrefix) {
  const map = new Map();
  if (!fs.existsSync(localBase)) return map;
  for (const ent of fs.readdirSync(localBase, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    const main = path.join(localBase, ent.name, mainFile);
    if (!fs.existsSync(main)) continue;
    const { meta } = parseFrontmatter(fs.readFileSync(main, 'utf8'));
    const up = meta.ds4_upstream || '';
    if (up.startsWith(upstreamPrefix)) map.set(up.slice(upstreamPrefix.length), path.join(localBase, ent.name));
  }
  return map;
}

function writePreservedMain(localDir, mainFile, upstreamContent, source, commit, defaults) {
  const localMain = path.join(localDir, mainFile);
  const upstreamBody = stripTrailingWhitespace(parseFrontmatter(upstreamContent).body.trimStart());
  if (fs.existsSync(localMain)) {
    const split = splitFrontmatter(fs.readFileSync(localMain, 'utf8'));
    let fm = split.frontmatter;
    fm = updateFrontmatterText(fm, 'ds4_source_repo', source.repo);
    fm = updateFrontmatterText(fm, 'ds4_source_ref', source.ref);
    fm = updateFrontmatterText(fm, 'ds4_source_commit', commit);
    fs.writeFileSync(localMain, stripTrailingWhitespace(`---\n${fm}\n---\n${upstreamBody}`));
    return;
  }
  const lines = ['---'];
  for (const [key, value] of Object.entries(defaults)) {
    if (value === undefined || value === null || value === '') continue;
    if (key === 'description') {
      lines.push('description: |');
      String(value).split(/\r?\n/).forEach((line) => lines.push(`  ${line}`));
    } else {
      lines.push(`${key}: ${value}`);
    }
  }
  lines.push(`ds4_source_repo: ${source.repo}`);
  lines.push(`ds4_source_ref: ${source.ref}`);
  lines.push(`ds4_source_commit: ${commit}`);
  lines.push('---');
  lines.push(upstreamBody);
  fs.mkdirSync(localDir, { recursive: true });
  fs.writeFileSync(localMain, stripTrailingWhitespace(`${lines.join('\n')}`));
}

function adaptSkillMd(upstreamMd, source, upstreamId, commit) {
  const { meta, body } = parseFrontmatter(upstreamMd);
  const description = (meta.description || '').trim() || `Imported ${source.id} skill.`;
  const title = titleFromId(upstreamId);
  const bodyWithTitle = /^\s*#\s+/m.test(body) ? body.trimStart() : `# ${title}\n\n${body.trimStart()}`;
  return [
    '---',
    `name: ${source.localPrefix}${upstreamId}`,
    'description: |',
    ...description.split(/\r?\n/).map((line) => `  ${line}`),
    'modes: [agent]',
    'ds4_category: imported-agent',
    'ds4_local_mode: reference',
    'ds4_output_kinds: markdown',
    `ds4_provider: ${source.id}`,
    `ds4_upstream: ${source.id}/${source.upstreamPath}/${upstreamId}`,
    `ds4_source_repo: ${source.repo}`,
    `ds4_source_ref: ${source.ref}`,
    `ds4_source_commit: ${commit}`,
    'ds4_modified_notice: Adapted for DStudio/DS4 Agent catalog; namespaced to avoid local skill collisions.',
    '---',
    bodyWithTitle,
    `\n> Imported from ${source.repo}.`,
    `> Original skill id: \`${upstreamId}\`.`,
    `> DStudio catalog id: \`${source.localPrefix}${upstreamId}\`.`,
    '',
  ].join('\n');
}

function syncSkillsDir(source, repoDir, commit) {
  const upstreamBase = path.join(repoDir, source.upstreamPath);
  if (!fs.existsSync(upstreamBase)) throw new Error(`${source.id}: upstream dir not found: ${source.upstreamPath}`);
  const localBase = localPath(source);
  let count = 0;
  for (const ent of fs.readdirSync(upstreamBase, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    const upstreamSkill = path.join(upstreamBase, ent.name);
    const upstreamMdPath = path.join(upstreamSkill, 'SKILL.md');
    if (!fs.existsSync(upstreamMdPath)) continue;
    const localSkill = path.join(localBase, `${source.localPrefix}${ent.name}`);
    removeDir(localSkill);
    copyDir(upstreamSkill, localSkill);
    const adapted = adaptSkillMd(fs.readFileSync(upstreamMdPath, 'utf8'), source, ent.name, commit);
    fs.writeFileSync(path.join(localSkill, 'SKILL.md'), adapted);
    count++;
  }
  console.log(`${source.id}: imported ${count} skill(s) at ${commit.slice(0, 12)}`);
  return count;
}

function syncAnthropicSecurityReview(source, repoDir, commit) {
  const localDir = localPath(source);
  const refs = path.join(localDir, 'references');
  fs.mkdirSync(refs, { recursive: true });
  const copies = [
    [source.upstreamPath, 'security-review-command.md'],
    ['docs/custom-security-scan-instructions.md', 'custom-security-scan-instructions.md'],
    ['docs/custom-filtering-instructions.md', 'custom-filtering-instructions.md'],
    ['examples/custom-security-scan-instructions.txt', 'custom-security-scan-instructions-example.txt'],
    ['examples/custom-false-positive-filtering.txt', 'custom-false-positive-filtering-example.txt'],
  ];
  let count = 0;
  for (const [fromRel, toName] of copies) {
    const from = path.join(repoDir, fromRel);
    if (!fs.existsSync(from)) throw new Error(`${source.id}: upstream file not found: ${fromRel}`);
    fs.writeFileSync(path.join(refs, toName), stripTrailingWhitespace(fs.readFileSync(from, 'utf8')));
    count++;
  }
  const skillMd = path.join(localDir, 'SKILL.md');
  if (fs.existsSync(skillMd)) {
    const updated = updateFrontmatterField(fs.readFileSync(skillMd, 'utf8'), 'ds4_source_commit', commit);
    fs.writeFileSync(skillMd, updated);
  }
  console.log(`${source.id}: updated ${count} reference file(s) at ${commit.slice(0, 12)}`);
  return count;
}

function syncPreserveSkillBodies(source, repoDir, commit) {
  const upstreamBase = path.join(repoDir, source.upstreamPath);
  if (!fs.existsSync(upstreamBase)) throw new Error(`${source.id}: upstream dir not found: ${source.upstreamPath}`);
  const localBase = localPath(source);
  const byUpstream = localDirsByUpstream(localBase, 'SKILL.md', `${source.id}/`);
  let count = 0;
  for (const ent of fs.readdirSync(upstreamBase, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    const upstreamDir = path.join(upstreamBase, ent.name);
    const upstreamMain = path.join(upstreamDir, 'SKILL.md');
    if (!fs.existsSync(upstreamMain)) continue;
    const localId = ent.name === 'pricing' ? 'pricing-strategy' : ent.name;
    const localDir = byUpstream.get(ent.name) || path.join(localBase, localId);
    if (fs.existsSync(localDir) && !byUpstream.get(ent.name)) {
      const maybeMain = path.join(localDir, 'SKILL.md');
      const up = fs.existsSync(maybeMain) ? (parseFrontmatter(fs.readFileSync(maybeMain, 'utf8')).meta.ds4_upstream || '') : '';
      if (up && up !== `${source.id}/${ent.name}`) {
        console.log(`${source.id}: skipped ${ent.name}; local id ${localId} belongs to ${up}`);
        continue;
      }
    }
    copyDirExcept(upstreamDir, localDir, new Set(['SKILL.md']));
    const { meta } = parseFrontmatter(fs.readFileSync(upstreamMain, 'utf8'));
    writePreservedMain(localDir, 'SKILL.md', fs.readFileSync(upstreamMain, 'utf8'), source, commit, {
      name: localId,
      description: meta.description || `Imported ${source.id} skill.`,
      'modes': '[agent, marketing]',
      'ds4_category': 'marketing',
      'ds4_local_mode': 'native',
      'ds4_output_kinds': 'markdown',
      'ds4_upstream': `${source.id}/${ent.name}`,
      'ds4_modified_notice': 'Adapted for DStudio/DS4; added ds4_* metadata and local-first catalog fields.',
    });
    count++;
  }
  console.log(`${source.id}: updated ${count} metadata-preserving skill body/bodies at ${commit.slice(0, 12)}`);
  return count;
}

function syncOpenDesignPreserve(source, repoDir, commit) {
  let count = 0;
  const pairs = [
    {
      upstreamDir: 'skills',
      localDir: 'extension/skills',
      main: 'SKILL.md',
      defaultOutput: 'html',
      support: ['example.html', 'example.md', 'assets', 'references', 'LICENSE', 'LICENSE.md', 'README.md'],
    },
    {
      upstreamDir: 'design-systems',
      localDir: 'extension/design-systems',
      main: 'DESIGN.md',
      defaultOutput: 'html',
      support: ['components.html', 'tokens.css', 'assets'],
    },
  ];
  for (const pair of pairs) {
    const upstreamBase = path.join(repoDir, pair.upstreamDir);
    if (!fs.existsSync(upstreamBase)) continue;
    const localBase = path.join(root, pair.localDir);
    const byUpstream = localDirsByUpstream(localBase, pair.main, 'open-design/');
    for (const ent of fs.readdirSync(upstreamBase, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue;
      const upstreamDir = path.join(upstreamBase, ent.name);
      const upstreamMain = path.join(upstreamDir, pair.main);
      if (!fs.existsSync(upstreamMain)) continue;
      const localDir = byUpstream.get(ent.name) || path.join(localBase, ent.name);
      if (fs.existsSync(localDir) && !byUpstream.get(ent.name)) {
        const maybeMain = path.join(localDir, pair.main);
        const up = fs.existsSync(maybeMain) ? (parseFrontmatter(fs.readFileSync(maybeMain, 'utf8')).meta.ds4_upstream || '') : '';
        if (up && up !== `open-design/${ent.name}`) {
          console.log(`open-design: skipped ${pair.upstreamDir}/${ent.name}; local id belongs to ${up}`);
          continue;
        }
      }
      copySelectedEntries(upstreamDir, localDir, pair.support);
      const { meta } = parseFrontmatter(fs.readFileSync(upstreamMain, 'utf8'));
      writePreservedMain(localDir, pair.main, fs.readFileSync(upstreamMain, 'utf8'), source, commit, {
        name: meta.name || ent.name,
        description: meta.description || `Imported Open Design ${pair.main === 'SKILL.md' ? 'skill' : 'design system'}.`,
        'ds4_category': 'general',
        'ds4_local_mode': 'reference',
        'ds4_output_kinds': pair.defaultOutput,
        'ds4_upstream': `open-design/${ent.name}`,
        'ds4_modified_notice': 'Adapted for DStudio/DS4; added ds4_* metadata and local-first blueprint classification where needed.',
      });
      count++;
    }
  }
  console.log(`open-design: updated ${count} metadata-preserving pack(s) at ${commit.slice(0, 12)}`);
  return count;
}

function syncSource(source) {
  if (source.kind === 'verify-only') {
    console.log(`${source.id}: verify-only source; checked by Update Doctor, not rewritten automatically`);
    return 0;
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `dstudio-${source.id}-`));
  try {
    const repoDir = path.join(tmp, source.id);
    run('git', ['clone', '--depth', '1', '--branch', source.ref, source.repo, repoDir]);
    const commit = repoHead(repoDir);
    let count = 0;
    if ((source.kind || 'skills-dir') === 'skills-dir') count = syncSkillsDir(source, repoDir, commit);
    else if (source.kind === 'anthropic-security-review') count = syncAnthropicSecurityReview(source, repoDir, commit);
    else if (source.kind === 'preserve-skill-bodies') count = syncPreserveSkillBodies(source, repoDir, commit);
    else if (source.kind === 'open-design-preserve') count = syncOpenDesignPreserve(source, repoDir, commit);
    else throw new Error(`${source.id}: unsupported sync kind: ${source.kind}`);
    source.importedCommit = commit;
    return count;
  } finally {
    removeDir(tmp);
  }
}

const argList = process.argv.slice(2);
const args = new Set(argList);
const wanted = argList.includes('--source') ? argList[argList.indexOf('--source') + 1] : '';
const sources = parseManifest(fs.readFileSync(manifestPath, 'utf8'));
const selected = args.has('--all') || !wanted ? sources : sources.filter((s) => s.id === wanted);
if (!selected.length) throw new Error(wanted ? `no such skill source: ${wanted}` : 'no skill sources selected');
let total = 0;
for (const source of selected) total += syncSource(source);
writeManifest(sources);
console.log(`done: ${total} skill(s) imported`);

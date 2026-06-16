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
      const [id, repo, ref, importedCommit, localPrefix, upstreamDir] = line.split('\t');
      if (!id || !repo || !ref || !importedCommit || !localPrefix || !upstreamDir) {
        throw new Error(`bad skill source manifest row: ${line}`);
      }
      return { id, repo, ref, importedCommit, localPrefix, upstreamDir };
    });
}

function writeManifest(sources) {
  const header = '# id\trepo\tref\timported_commit\tlocal_prefix\tupstream_dir\n';
  const rows = sources.map((s) =>
    [s.id, s.repo, s.ref, s.importedCommit, s.localPrefix, s.upstreamDir].join('\t')
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
    `ds4_upstream: ${source.id}/${upstreamId}`,
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

function syncSource(source) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `dstudio-${source.id}-`));
  try {
    const repoDir = path.join(tmp, source.id);
    run('git', ['clone', '--depth', '1', '--branch', source.ref, source.repo, repoDir]);
    const commit = run('git', ['-C', repoDir, 'rev-parse', 'HEAD']);
    const upstreamBase = path.join(repoDir, source.upstreamDir);
    if (!fs.existsSync(upstreamBase)) throw new Error(`${source.id}: upstream dir not found: ${source.upstreamDir}`);
    const localBase = path.join(root, 'extension/skills');
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
    source.importedCommit = commit;
    console.log(`${source.id}: imported ${count} skill(s) at ${commit.slice(0, 12)}`);
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

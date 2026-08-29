import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const GENERIC_CLASSES = new Set([
  'active', 'button', 'container', 'content', 'current', 'grid', 'hidden',
  'inner', 'item', 'link', 'open', 'section', 'selected', 'show', 'visible',
  'wrapper',
]);

function unique(values) {
  return [...new Set(values.filter(Boolean))].sort();
}

function round(value, digits = 3) {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function jaccard(left, right) {
  const a = new Set(left);
  const b = new Set(right);
  if (!a.size && !b.size) return 1;
  let common = 0;
  for (const value of a) if (b.has(value)) common++;
  return common / (a.size + b.size - common || 1);
}

function cssBlocks(html) {
  return [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)]
    .map((match) => match[1]).join('\n').replace(/\/\*[\s\S]*?\*\//g, ' ');
}

function resolveFontValue(value, variables) {
  return value.replace(/var\(\s*(--[-\w]+)\s*(?:,[^)]+)?\)/gi,
    (_whole, name) => variables.get(name) || name)
    .replace(/["']/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function fontFeatures(css) {
  const variables = new Map();
  for (const match of css.matchAll(/(--[-\w]*font[-\w]*)\s*:\s*([^;}]+)/gi))
    variables.set(match[1], match[2].trim());
  const stacks = [];
  let body = '';
  let display = '';
  for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const family = rule[2].match(/font-family\s*:\s*([^;}]+)/i)?.[1];
    if (!family) continue;
    const normalized = resolveFontValue(family, variables);
    stacks.push(normalized);
    if (!body && /(^|,)\s*(?:html\s+)?body(?:\s|,|$)/i.test(rule[1])) body = normalized;
    if (!display && /(?:^|[\s,.#>+~])(?:h1|h2|hero|display|masthead|title)(?:[\s,.#:[>+~]|$)/i.test(rule[1]))
      display = normalized;
  }
  const typeSizes = unique([...css.matchAll(/font-size\s*:\s*([^;}]+)/gi)]
    .map((match) => match[1].replace(/\s+/g, '').toLowerCase()).slice(0, 24));
  return {
    stacks: unique(stacks),
    primary: body || stacks[0] || 'browser-default',
    display: display || body || stacks[0] || 'browser-default',
    typeSizes,
  };
}

function htmlWithoutCode(html) {
  return html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--([\s\S]*?)-->/g, ' ');
}

function tagAndClassFeatures(html) {
  const clean = htmlWithoutCode(html);
  const tags = [];
  const classTokens = [];
  const roleTokens = [];
  for (const match of clean.matchAll(/<([a-z][\w:-]*)\b([^>]*)>/gi)) {
    if (match[0][1] === '/') continue;
    const tag = match[1].toLowerCase();
    tags.push(tag);
    const classes = match[2].match(/\bclass\s*=\s*["']([^"']+)["']/i)?.[1] || '';
    for (const token of classes.toLowerCase().split(/\s+/)) {
      const normalized = token.replace(/[^a-z0-9_-]/g, '');
      if (normalized.length >= 3 && !GENERIC_CLASSES.has(normalized)) classTokens.push(normalized);
    }
    const role = match[2].match(/\brole\s*=\s*["']([^"']+)["']/i)?.[1];
    if (role) roleTokens.push(`${tag}:${role.toLowerCase()}`);
  }
  const tagNgrams = [];
  for (let i = 0; i + 2 < tags.length; i++) tagNgrams.push(tags.slice(i, i + 3).join('>'));
  const main = clean.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1] || clean;
  const topLevel = [];
  let depth = 0;
  for (const match of main.matchAll(/<\/?([a-z][\w:-]*)\b[^>]*>/gi)) {
    const closing = /^<\//.test(match[0]);
    const selfClosing = /\/>$/.test(match[0]) || /^(?:img|input|br|hr|meta|link|source|track|area|base|embed|wbr)$/i.test(match[1]);
    if (closing) depth = Math.max(0, depth - 1);
    else {
      if (depth === 0) topLevel.push(match[1].toLowerCase());
      if (!selfClosing) depth++;
    }
  }
  return {
    tags,
    tagNgrams: unique(tagNgrams),
    classTokens: unique(classTokens),
    roleTokens: unique(roleTokens),
    topLevel: topLevel.slice(0, 20),
  };
}

function layoutFeatures(css, html) {
  const declarations = [];
  const capture = (name, regex) => {
    const count = [...css.matchAll(regex)].length;
    if (count) declarations.push(`${name}:${Math.min(count, 9)}`);
    return count;
  };
  const counts = {
    grid: capture('grid', /display\s*:\s*grid\b/gi),
    flex: capture('flex', /display\s*:\s*flex\b/gi),
    columns: capture('columns', /grid-template-columns\s*:/gi),
    absolute: capture('absolute', /position\s*:\s*absolute\b/gi),
    sticky: capture('sticky', /position\s*:\s*sticky\b/gi),
    vertical: capture('vertical', /writing-mode\s*:/gi),
    transforms: capture('transforms', /transform\s*:/gi),
    containerQueries: capture('container-query', /@container\b/gi),
  };
  for (const tag of ['article', 'aside', 'details', 'dialog', 'dl', 'figure', 'form', 'nav', 'section', 'table', 'video']) {
    const count = [...html.matchAll(new RegExp(`<${tag}\\b`, 'gi'))].length;
    if (count) declarations.push(`${tag}:${Math.min(count, 9)}`);
  }
  const radii = [...css.matchAll(/border-radius\s*:\s*([^;}]+)/gi)]
    .map((match) => match[1].replace(/\s+/g, '').toLowerCase());
  return { tokens: unique(declarations), counts, radii: unique(radii) };
}

function heroFeatures(html, css) {
  const clean = htmlWithoutCode(html);
  const mainStart = clean.search(/<main\b/i);
  const sample = clean.slice(mainStart >= 0 ? mainStart : 0, (mainStart >= 0 ? mainStart : 0) + 7000);
  const firstMedia = sample.match(/<(video|img|canvas|svg)\b/i)?.[1]?.toLowerCase() || 'none';
  const firstTags = [...sample.matchAll(/<([a-z][\w:-]*)\b/gi)]
    .slice(0, 18).map((match) => match[1].toLowerCase());
  let family = 'text-led';
  if (firstMedia === 'video' && /object-fit\s*:\s*cover|position\s*:\s*absolute[\s\S]{0,300}inset\s*:/i.test(css))
    family = 'immersive-motion';
  else if (firstMedia !== 'none' && /grid-template-columns\s*:[^;}]+/i.test(css))
    family = 'split-media';
  else if (/<(?:table|dl)\b/i.test(sample)) family = 'indexed-reference';
  else if (/<(?:button|input|select)\b/i.test(sample) && /(?:transport|track|mix|filter|wave|timeline)/i.test(sample))
    family = 'instrument-interface';
  else if (firstMedia !== 'none') family = 'inset-media';
  if (/writing-mode\s*:|rotate\s*\(|transform\s*:[^;}]*rotate/i.test(css) && /<h1\b/i.test(sample))
    family += '+kinetic-type';
  return { family, firstMedia, firstTags };
}

function paletteFeatures(css) {
  const raw = [
    ...[...css.matchAll(/#[0-9a-f]{3,8}\b/gi)].map((match) => match[0].toLowerCase()),
    ...[...css.matchAll(/\b(?:rgb|hsl|oklch|lab|color)\([^;)]+\)/gi)]
      .map((match) => match[0].replace(/\s+/g, '').toLowerCase()),
  ];
  return unique(raw).slice(0, 32);
}

export function analyzeSite(file) {
  const absolute = path.resolve(file);
  const html = fs.readFileSync(absolute, 'utf8');
  const css = cssBlocks(html);
  const structure = tagAndClassFeatures(html);
  const fonts = fontFeatures(css);
  const layout = layoutFeatures(css, html);
  const hero = heroFeatures(html, css);
  const palette = paletteFeatures(css);
  return {
    path: absolute,
    bytes: Buffer.byteLength(html),
    elementCount: structure.tags.length,
    sectionCount: [...html.matchAll(/<section\b/gi)].length,
    interactiveCount: [...html.matchAll(/<(?:a|button|input|select|textarea|details)\b/gi)].length,
    fonts,
    hero,
    layout,
    palette,
    structure: {
      topLevel: structure.topLevel,
      tagNgrams: structure.tagNgrams,
      classTokens: structure.classTokens,
      roleTokens: structure.roleTokens,
    },
  };
}

function compareSites(left, right, maximumPairwiseCloneScore) {
  const similarities = {
    dom: jaccard(left.structure.tagNgrams, right.structure.tagNgrams),
    classes: jaccard(left.structure.classTokens, right.structure.classTokens),
    fonts: jaccard(left.fonts.stacks, right.fonts.stacks),
    layout: jaccard(left.layout.tokens, right.layout.tokens),
    palette: jaccard(left.palette, right.palette),
    typeScale: jaccard(left.fonts.typeSizes, right.fonts.typeSizes),
    topLevel: left.structure.topLevel.join('>') === right.structure.topLevel.join('>') ? 1 :
      jaccard(left.structure.topLevel, right.structure.topLevel),
    hero: left.hero.family === right.hero.family ? 1 : 0,
  };
  const score = round(
    similarities.dom * 0.25 + similarities.classes * 0.12 +
    similarities.fonts * 0.14 + similarities.layout * 0.14 +
    similarities.palette * 0.07 + similarities.typeScale * 0.08 +
    similarities.topLevel * 0.1 + similarities.hero * 0.1,
  );
  const structuralClone = similarities.dom >= 0.88 &&
    similarities.layout >= 0.8 && similarities.topLevel >= 0.9;
  const pass = score < maximumPairwiseCloneScore && !structuralClone;
  return {
    left: left.path,
    right: right.path,
    score,
    structuralClone,
    pass,
    similarities: Object.fromEntries(Object.entries(similarities)
      .map(([key, value]) => [key, round(value)])),
  };
}

export function analyzeCreativity(files, options = {}) {
  assert.ok(Array.isArray(files) && files.length >= 2,
    'creativity gate requires at least two HTML files');
  const thresholds = {
    maximumPairwiseCloneScore: Number(options.maximumPairwiseCloneScore ?? 0.82),
    minimumDistinctHeroSchemas: Number(options.minimumDistinctHeroSchemas ?? 2),
    minimumDistinctPrimaryFontStacks: Number(options.minimumDistinctPrimaryFontStacks ?? files.length),
    minimumDistinctDisplayFontStacks: Number(options.minimumDistinctDisplayFontStacks ?? files.length),
    minimumDistinctTypeSystems: Number(options.minimumDistinctTypeSystems ?? files.length),
    minimumDistinctSectionCounts: Number(options.minimumDistinctSectionCounts ?? 1),
  };
  const sites = files.map(analyzeSite);
  const pairs = [];
  for (let i = 0; i < sites.length; i++) {
    for (let j = i + 1; j < sites.length; j++)
      pairs.push(compareSites(sites[i], sites[j], thresholds.maximumPairwiseCloneScore));
  }
  const distinctHeroSchemas = unique(sites.map((site) => site.hero.family));
  const distinctPrimaryFontStacks = unique(sites.map((site) => site.fonts.primary));
  const distinctDisplayFontStacks = unique(sites.map((site) => site.fonts.display));
  const distinctTypeSystems = unique(sites.map((site) =>
    `${site.fonts.primary} -> ${site.fonts.display}`));
  const distinctSectionCounts = [...new Set(sites.map((site) => site.sectionCount))]
    .sort((left, right) => left - right);
  const failures = [];
  for (const pair of pairs) {
    if (!pair.pass) failures.push(
      `${path.basename(pair.left)} and ${path.basename(pair.right)} are clone-like (score ${pair.score}${pair.structuralClone ? ', structural fingerprint match' : ''})`);
  }
  if (distinctHeroSchemas.length < thresholds.minimumDistinctHeroSchemas)
    failures.push(`only ${distinctHeroSchemas.length} distinct hero schema(s)`);
  if (distinctPrimaryFontStacks.length < thresholds.minimumDistinctPrimaryFontStacks)
    failures.push(`only ${distinctPrimaryFontStacks.length} distinct primary font stack(s)`);
  if (distinctDisplayFontStacks.length < thresholds.minimumDistinctDisplayFontStacks)
    failures.push(`only ${distinctDisplayFontStacks.length} distinct display font stack(s)`);
  if (distinctTypeSystems.length < thresholds.minimumDistinctTypeSystems)
    failures.push(`only ${distinctTypeSystems.length} distinct primary/display type system(s)`);
  if (distinctSectionCounts.length < thresholds.minimumDistinctSectionCounts)
    failures.push(`only ${distinctSectionCounts.length} distinct section count(s)`);
  return {
    schema: 'ds4.design.creativity.v1',
    generatedAt: new Date().toISOString(),
    pass: failures.length === 0,
    thresholds,
    aggregate: {
      siteCount: sites.length,
      pairCount: pairs.length,
      maximumObservedCloneScore: pairs.length ? Math.max(...pairs.map((pair) => pair.score)) : 0,
      distinctHeroSchemas,
      distinctPrimaryFontStacks,
      distinctDisplayFontStacks,
      distinctTypeSystems,
      distinctSectionCounts,
    },
    failures,
    sites,
    pairs,
  };
}

export function creativityMarkdown(report) {
  const lines = [
    '# DS4 Design creativity gate', '',
    `Result: **${report.pass ? 'PASS' : 'FAIL'}**`, '',
    `Sites: ${report.aggregate.siteCount} · maximum clone score: ${report.aggregate.maximumObservedCloneScore} · threshold: ${report.thresholds.maximumPairwiseCloneScore}`,
    `Distinct section counts: ${report.aggregate.distinctSectionCounts.join(', ')} · minimum distinct: ${report.thresholds.minimumDistinctSectionCounts}`,
    '', '## Site fingerprints', '',
    '| Site | Hero schema | Primary font | Display font | Elements | Sections |',
    '|---|---|---|---|---:|---:|',
  ];
  for (const site of report.sites) {
    lines.push(`| ${path.basename(site.path)} | ${site.hero.family} | ${site.fonts.primary.replaceAll('|', '\\|')} | ${site.fonts.display.replaceAll('|', '\\|')} | ${site.elementCount} | ${site.sectionCount} |`);
  }
  lines.push('', '## Pairwise comparison', '',
    '| Pair | Clone score | Structural clone | Result |',
    '|---|---:|---|---|');
  for (const pair of report.pairs) {
    lines.push(`| ${path.basename(pair.left)} ↔ ${path.basename(pair.right)} | ${pair.score} | ${pair.structuralClone ? 'yes' : 'no'} | ${pair.pass ? 'PASS' : 'FAIL'} |`);
  }
  if (report.failures.length) lines.push('', '## Failures', '', ...report.failures.map((failure) => `- ${failure}`));
  return `${lines.join('\n')}\n`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const outputAt = args.indexOf('--out');
  const output = outputAt >= 0 ? path.resolve(args[outputAt + 1]) : '';
  const files = args.filter((value, index) => index !== outputAt && index !== outputAt + 1);
  const report = analyzeCreativity(files);
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (output) {
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, json);
    fs.writeFileSync(output.replace(/\.json$/i, '.md'), creativityMarkdown(report));
  } else process.stdout.write(json);
  if (!report.pass) process.exitCode = 1;
}

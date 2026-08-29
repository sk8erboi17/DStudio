import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

function unique(values) {
  return [...new Set(values.filter(Boolean))].sort();
}

function dominant(fonts) {
  const sorted = [...(fonts || [])]
    .filter((font) => font.familyName && font.glyphCount > 0)
    .sort((left, right) => right.glyphCount - left.glyphCount ||
      left.familyName.localeCompare(right.familyName));
  return sorted[0]?.familyName?.trim().toLowerCase() || 'unknown';
}

async function renderedRole(cdp, rootId, selectors) {
  for (const selector of selectors) {
    const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: rootId, selector });
    if (!nodeId) continue;
    const { fonts = [] } = await cdp.send('CSS.getPlatformFontsForNode', { nodeId });
    const family = dominant(fonts);
    if (family !== 'unknown') return {
      selector,
      family,
      fonts: fonts.filter((font) => font.glyphCount > 0).map((font) => ({
        family: font.familyName,
        postScriptName: font.postScriptName,
        glyphCount: font.glyphCount,
        custom: font.isCustomFont,
      })).sort((left, right) => right.glyphCount - left.glyphCount),
    };
  }
  return { selector: null, family: 'unknown', fonts: [] };
}

export async function analyzeRenderedFontDiversity(chrome, files, options = {}) {
  assert.ok(chrome && fs.existsSync(chrome), 'rendered font gate requires Chrome/Chromium');
  assert.ok(Array.isArray(files) && files.length >= 2,
    'rendered font gate requires at least two HTML files');
  const { chromium } = await import('playwright');
  const thresholds = {
    minimumDistinctPrimaryFonts: Number(options.minimumDistinctPrimaryFonts ?? files.length),
    minimumDistinctDisplayFonts: Number(options.minimumDistinctDisplayFonts ?? files.length),
    minimumDistinctRenderedTypeSystems: Number(options.minimumDistinctRenderedTypeSystems ?? files.length),
  };
  const browser = await chromium.launch({
    executablePath: chrome,
    headless: true,
    args: ['--password-store=basic', '--use-mock-keychain', '--allow-file-access-from-files'],
  });
  const sites = [];
  try {
    for (const file of files) {
      const absolute = path.resolve(file);
      const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
      const page = await context.newPage();
      await page.goto(pathToFileURL(absolute).href, { waitUntil: 'load' });
      await page.evaluate(() => document.fonts?.ready);
      const cdp = await context.newCDPSession(page);
      await cdp.send('DOM.enable');
      await cdp.send('CSS.enable');
      const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
      const roles = {
        primary: await renderedRole(cdp, root.nodeId,
          ['main p', 'main li', 'article p', 'p', 'main', 'body']),
        display: await renderedRole(cdp, root.nodeId,
          ['h1', '[class*="hero"] h2', 'main h2', 'h2']),
        navigation: await renderedRole(cdp, root.nodeId,
          ['nav a', 'header a', 'nav']),
        metadata: await renderedRole(cdp, root.nodeId,
          ['time', '.mono', '[class*="meta"]', 'small', 'code']),
      };
      sites.push({
        path: absolute,
        roles,
        typeSystem: `${roles.primary.family} -> ${roles.display.family} -> ${roles.metadata.family}`,
      });
      await context.close();
    }
  } finally {
    await browser.close();
  }

  const distinctPrimaryFonts = unique(sites.map((site) => site.roles.primary.family));
  const distinctDisplayFonts = unique(sites.map((site) => site.roles.display.family));
  const distinctRenderedTypeSystems = unique(sites.map((site) => site.typeSystem));
  const failures = [];
  if (distinctPrimaryFonts.length < thresholds.minimumDistinctPrimaryFonts)
    failures.push(`only ${distinctPrimaryFonts.length} distinct rendered primary font(s)`);
  if (distinctDisplayFonts.length < thresholds.minimumDistinctDisplayFonts)
    failures.push(`only ${distinctDisplayFonts.length} distinct rendered display font(s)`);
  if (distinctRenderedTypeSystems.length < thresholds.minimumDistinctRenderedTypeSystems)
    failures.push(`only ${distinctRenderedTypeSystems.length} distinct rendered type system(s)`);
  if (sites.some((site) => site.roles.primary.family === 'unknown' ||
      site.roles.display.family === 'unknown'))
    failures.push('one or more sites have an unmeasurable primary/display font');
  const requiredFonts = Object.fromEntries(Object.entries(options.requiredFonts || {})
    .map(([file, family]) => [path.resolve(file), String(family).trim().toLowerCase()]));
  for (const [file, family] of Object.entries(requiredFonts)) {
    const site = sites.find((candidate) => candidate.path === file);
    if (!site) {
      failures.push(`required-font site was not measured: ${path.basename(file)}`);
      continue;
    }
    if (site.roles.primary.family !== family || site.roles.display.family !== family)
      failures.push(`${path.basename(file)} did not render the user-selected font ${family} for both primary and display roles (actual ${site.roles.primary.family} / ${site.roles.display.family})`);
  }
  return {
    schema: 'ds4.design.rendered-font-diversity.v1',
    generatedAt: new Date().toISOString(),
    pass: failures.length === 0,
    thresholds,
    aggregate: { distinctPrimaryFonts, distinctDisplayFonts, distinctRenderedTypeSystems },
    requiredFonts,
    failures,
    sites,
  };
}

export function renderedFontMarkdown(report) {
  const lines = [
    '# DS4 rendered font diversity gate', '',
    `Result: **${report.pass ? 'PASS' : 'FAIL'}**`, '',
    '| Site | Primary (actual) | Display (actual) | Navigation | Metadata |',
    '|---|---|---|---|---|',
  ];
  for (const site of report.sites) lines.push(
    `| ${path.basename(site.path)} | ${site.roles.primary.family} | ${site.roles.display.family} | ${site.roles.navigation.family} | ${site.roles.metadata.family} |`);
  if (report.failures.length)
    lines.push('', '## Failures', '', ...report.failures.map((failure) => `- ${failure}`));
  return `${lines.join('\n')}\n`;
}

const direct = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (direct) {
  const [chrome, ...files] = process.argv.slice(2);
  const report = await analyzeRenderedFontDiversity(chrome, files);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.pass) process.exitCode = 1;
}

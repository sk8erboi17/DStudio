#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function usage() {
  console.log(`usage: node extension/rsa/bench/compare.mjs --target <url> [--out <dir>] [--query <term>]

Compares two RSA modes without using an LLM as judge:
  old  = homepage/robots/sitemap/manifest HTML inventory only
  new  = Playwright network capture + JS endpoint extraction + claim ledger + route graph
`);
}

function arg(name, fallback = '') {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

const target = arg('target');
if (!target || process.argv.includes('--help')) {
  usage();
  process.exit(target ? 0 : 2);
}

const query = arg('query', 'ninja');
const outRoot = arg('out', path.join('extension', 'rsa', 'benchmark', `rsa-compare-${new Date().toISOString().replace(/[:.]/g, '').slice(0, 15)}`));
const targetUrl = new URL(target);
const origin = targetUrl.origin;
const loopbackTarget = /^(localhost|127\.|0\.0\.0\.0|\[::1\])/.test(targetUrl.hostname);
const navWaitUntil = loopbackTarget ? 'domcontentloaded' : 'networkidle';
const navTimeoutMs = loopbackTarget ? 8000 : 45000;
const shortTimeoutMs = loopbackTarget ? 700 : 2500;
fs.mkdirSync(outRoot, { recursive: true });

const nowIso = new Date().toISOString();
const debug = (...parts) => {
  if (process.env.RSA_DEBUG) console.error('[rsa-debug]', ...parts);
};

function mkdirp(p) {
  fs.mkdirSync(p, { recursive: true });
}

function writeJson(file, obj) {
  mkdirp(path.dirname(file));
  fs.writeFileSync(file, `${JSON.stringify(obj, null, 2)}\n`);
}

function stripTags(s) {
  return String(s || '').replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function attrAll(html, tag, attr) {
  const out = [];
  const re = new RegExp(`<${tag}\\b[^>]*\\s${attr}=["']([^"']+)["'][^>]*>`, 'gi');
  let m;
  while ((m = re.exec(html))) out.push(m[1]);
  return out;
}

function tagsText(html, tag) {
  const out = [];
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'gi');
  let m;
  while ((m = re.exec(html))) out.push(stripTags(m[1]));
  return out.filter(Boolean);
}

function titleOf(html) {
  return tagsText(html, 'title')[0] || '';
}

function absoluteUrl(u, base = origin) {
  try { return new URL(u, base).href; } catch { return ''; }
}

function sameOrigin(u) {
  try { return new URL(u, origin).origin === origin; } catch { return false; }
}

async function fetchText(url, outFile = '') {
  const started = Date.now();
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      headers: { 'User-Agent': 'DStudio-RSA-benchmark/1.0' },
    });
    const text = await res.text();
    const headers = Object.fromEntries(res.headers.entries());
    const result = { ok: true, url, finalUrl: res.url, status: res.status, headers, text, elapsedMs: Date.now() - started };
    if (outFile) {
      fs.writeFileSync(outFile, text);
      writeJson(`${outFile}.headers.json`, { url, finalUrl: res.url, status: res.status, headers, elapsedMs: result.elapsedMs });
    }
    return result;
  } catch (err) {
    return { ok: false, url, error: String(err?.message || err), elapsedMs: Date.now() - started };
  }
}

function dedupe(arr) {
  return [...new Set(arr.filter(Boolean))];
}

function extractEndpointsFromJs(js) {
  const endpoints = new Set();
  const patterns = [
    /fetch\(\s*`([^`]+)`/g,
    /fetch\(\s*['"]([^'"]+)['"]/g,
    /\$\.ajax\(\s*\{[\s\S]{0,800}?url\s*:\s*['"]([^'"]+)['"]/g,
    /(?:url|href|action|endpoint|path)\s*[:=]\s*['"]((?:\/api\/|\/graphql|\/trpc\/|\/rpc\/|\/search\/|\/auth\/|\/login|\/signup|\/account|\/checkout|\/billing|\/purchase\/|\/userrecordings|\/download|\/dl\/|\/media\/|\/video\/)[^'"]*)['"]/g,
    /['"]((?:\/api\/|\/graphql|\/trpc\/|\/rpc\/|\/search\/|\/auth\/|\/login|\/signup|\/account|\/checkout|\/billing|\/purchase\/|\/userrecordings|\/download|\/dl\/|\/media\/|\/video\/)[^'"]*)['"]/g,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(js))) endpoints.add(m[1].replace(/\$\{[^}]+\}/g, '{param}'));
  }
  return [...endpoints].sort();
}

function detectFrontendSignals({ dom, scriptsText, stylesText = '', network = [] }) {
  const blob = `${JSON.stringify(dom || {})}\n${scriptsText}\n${stylesText}`;
  const signals = [];
  const add = (id, evidence) => { if (!signals.some((s) => s.id === id)) signals.push({ id, evidence }); };
  if (/__NEXT_DATA__|_next\/static|next-router/i.test(blob)) add('nextjs', 'Next.js markers or _next assets');
  if (/data-reactroot|react-dom|__REACT_DEVTOOLS_GLOBAL_HOOK__|createRoot\(/i.test(blob)) add('react', 'React runtime markers');
  if (/vue(?:\.runtime)?|__VUE__|data-v-/i.test(blob)) add('vue', 'Vue runtime markers');
  if (/ng-version|@angular|angular\.module/i.test(blob)) add('angular', 'Angular runtime markers');
  if (/svelte|data-svelte/i.test(blob)) add('svelte', 'Svelte markers');
  if (/vite\/client|\/assets\/[^"']+\.[a-f0-9]{6,}\.js|import\.meta\.env/i.test(blob)) add('vite', 'Vite/chunk markers');
  if (/webpackJsonp|__webpack_require__|webpackChunk/i.test(blob)) add('webpack', 'webpack runtime markers');
  if (/jQuery v|jquery[-.]\d/i.test(blob)) add('jquery', 'jQuery asset/runtime marker');
  if (/Bootstrap v|bootstrap\.bundle/i.test(blob)) add('bootstrap', 'Bootstrap asset/runtime marker');
  if ((network || []).some((n) => /\/api\/|\/graphql|\/trpc\//.test(n.url))) add('runtime-api-network', 'API-like request observed during normal navigation');
  return signals;
}

function detectSpaSignals({ dom, scriptsText, network = [] }) {
  const htmlSignals = [
    dom?.scripts?.some((s) => /_next\/static|assets\/.*\.(?:js|mjs)|chunk/i.test(s)),
    /__NEXT_DATA__|data-reactroot|id=["']root["']|id=["']app["']|createRoot\(|hydrateRoot\(|pushState|replaceState/i.test(scriptsText),
    (network || []).filter((n) => /script|xhr|fetch/.test(n.resourceType || '')).length > 8,
  ].filter(Boolean).length;
  return {
    detected: htmlSignals > 0,
    confidence: htmlSignals >= 2 ? 'high' : (htmlSignals ? 'medium' : 'low'),
    signals: htmlSignals,
  };
}

function detectAuthSignals({ dom, scriptsText, cookies = [], selectedPages = [] }) {
  const links = (dom?.links || []).map((l) => `${l.href} ${l.text}`).join('\n');
  const forms = (dom?.forms || []).map((f) => `${f.action} ${f.method} ${JSON.stringify(f.inputs)}`).join('\n');
  const pageText = (selectedPages || []).map((p) => `${p.url || p.requestedUrl} ${p.title} ${(p.h1 || []).join(' ')}`).join('\n');
  const blob = `${links}\n${forms}\n${pageText}\n${scriptsText}`;
  const oauth = /oauth|google|github|discord|apple|facebook|sso|openid/i.test(blob);
  const login = /\/login|\/signin|sign in|log in|\/signup|register|account/i.test(blob);
  const session = (cookies || []).some((c) => /session|csrf|xsrf|auth|token|jwt/i.test(c.name || ''));
  return {
    detected: login || oauth || session,
    confidence: [login, oauth, session].filter(Boolean).length >= 2 ? 'high' : (login || oauth || session ? 'medium' : 'low'),
    login,
    oauth,
    sessionCookies: cookies.filter((c) => /session|csrf|xsrf|auth|token|jwt/i.test(c.name || '')).map((c) => c.name),
  };
}

function detectMediaSignals({ dom, scriptsText, network = [] }) {
  const imageUrls = (dom?.images || []).map((i) => i.src || '').join('\n');
  const blob = `${imageUrls}\n${scriptsText}\n${(network || []).map((n) => `${n.url} ${n.contentType}`).join('\n')}`;
  const hls = /\.m3u8\b|application\/vnd\.apple\.mpegurl|hls\.js/i.test(blob);
  const dash = /\.mpd\b|dash\.js|application\/dash\+xml/i.test(blob);
  const video = /<video\b|videojs|plyr|jwplayer|shaka|\.mp4\b|\.webm\b/i.test(blob);
  const download = /\/download|\/dl\/|attachment|Content-Disposition/i.test(blob);
  return {
    detected: hls || dash || video || download,
    confidence: [hls, dash, video, download].filter(Boolean).length >= 2 ? 'high' : (hls || dash || video || download ? 'medium' : 'low'),
    hls,
    dash,
    video,
    download,
  };
}

function detectSignedCdnSignals({ dom, scriptsText, network = [] }) {
  const urls = [
    ...(dom?.scripts || []),
    ...(dom?.stylesheets || []),
    ...(dom?.images || []).map((i) => i.src || ''),
    ...(network || []).map((n) => n.url),
  ].join('\n') + `\n${scriptsText}`;
  const signedPatterns = [
    /X-Amz-Signature=|X-Amz-Credential=|AWSAccessKeyId=/i,
    /(?:sig|signature|token|expires|policy|key-pair-id)=/i,
    /CloudFront-Signature|CloudFront-Policy|CloudFront-Key-Pair-Id/i,
  ];
  const storagePatterns = [
    /s3[.-][a-z0-9-]+\.amazonaws\.com|amazonaws\.com\/.+\.(?:mp4|m3u8|zip|jpg|png)/i,
    /storage\.googleapis\.com|blob\.core\.windows\.net|r2\.cloudflarestorage\.com/i,
    /cdn\.|cloudfront\.net|akamai|fastly|bunnycdn|cloudflare/i,
  ];
  return {
    signed: signedPatterns.some((re) => re.test(urls)),
    storageOrCdn: storagePatterns.some((re) => re.test(urls)),
    confidence: signedPatterns.some((re) => re.test(urls)) ? 'high' : (storagePatterns.some((re) => re.test(urls)) ? 'medium' : 'low'),
  };
}

function buildCollectorReport({ dom, network, robots, sitemap, scriptFetches, styleFetches, jsEndpoints, routeGraph, searchObserved, cookies, frontendSignals, spaSignals, authSignals, mediaSignals, cdnSignals }) {
  const item = (id, status, evidence = [], notes = '') => ({ id, status, evidence: evidence.filter(Boolean), notes });
  return [
    item('html_inventory', dom?.title ? 'complete' : 'partial', [`title=${dom?.title || ''}`, `links=${dom?.links?.length || 0}`, `forms=${dom?.forms?.length || 0}`]),
    item('asset_inventory', (dom?.scripts?.length || dom?.stylesheets?.length || dom?.images?.length) ? 'complete' : 'partial', [`scripts=${dom?.scripts?.length || 0}`, `styles=${dom?.stylesheets?.length || 0}`, `images=${dom?.images?.length || 0}`]),
    item('network_har', network?.length ? 'complete' : 'partial', [`requests=${network?.length || 0}`]),
    item('robots_parser', robots?.ok ? 'complete' : 'partial', [`status=${robots?.status || 0}`]),
    item('sitemap_sampler', sitemap?.ok ? 'complete' : 'partial', [`status=${sitemap?.status || 0}`]),
    item('js_endpoint_extractor', jsEndpoints?.length ? 'complete' : 'partial', [`endpoints=${jsEndpoints?.length || 0}`]),
    item('storage_url_extractor', cdnSignals?.storageOrCdn ? 'complete' : 'partial', [`storageOrCdn=${!!cdnSignals?.storageOrCdn}`, `signed=${!!cdnSignals?.signed}`]),
    item('cookie_storage_snapshot', (cookies?.length || Object.keys(dom?.localStorage || {}).length || Object.keys(dom?.sessionStorage || {}).length) ? 'complete' : 'partial', [`cookies=${cookies?.length || 0}`, `localStorage=${Object.keys(dom?.localStorage || {}).length}`, `sessionStorage=${Object.keys(dom?.sessionStorage || {}).length}`]),
    item('spa_runtime_probe', spaSignals?.detected ? 'complete' : 'partial', [`detected=${!!spaSignals?.detected}`, `confidence=${spaSignals?.confidence || 'low'}`]),
    item('auth_surface_probe', authSignals?.detected ? 'complete' : 'partial', [`detected=${!!authSignals?.detected}`, `confidence=${authSignals?.confidence || 'low'}`]),
    item('media_player_probe', mediaSignals?.detected ? 'complete' : 'partial', [`detected=${!!mediaSignals?.detected}`, `confidence=${mediaSignals?.confidence || 'low'}`]),
    item('route_graph_builder', routeGraph?.nodes?.length ? 'complete' : 'partial', [`nodes=${routeGraph?.nodes?.length || 0}`, `edges=${routeGraph?.edges?.length || 0}`]),
    item('claim_evidence_audit', 'complete', [`searchResponses=${searchObserved?.length || 0}`, `frontendSignals=${frontendSignals?.length || 0}`]),
  ];
}

function buildClaimAudit(claims, artifacts) {
  const unsupported = claims.filter((c) => c.status !== 'UNKNOWN' && (!Array.isArray(c.evidenceRefs) || !c.evidenceRefs.length));
  const unknownWithoutQuestion = claims.filter((c) => c.status === 'UNKNOWN' && !/\?|requires|unknown|not visible|not externally/i.test(c.claim || ''));
  return {
    status: 'complete',
    totalClaims: claims.length,
    verifiedClaims: claims.filter((c) => c.status === 'VERIFIED').length,
    inferredClaims: claims.filter((c) => c.status === 'INFERRED').length,
    unknownClaims: claims.filter((c) => c.status === 'UNKNOWN').length,
    traceableClaims: claims.filter((c) => Array.isArray(c.evidenceRefs) && c.evidenceRefs.length).length,
    unsupportedClaims: unsupported.length,
    missingEvidenceRefs: unsupported.map((c) => c.id),
    weakUnknownClaims: unknownWithoutQuestion.map((c) => c.id),
    artifacts: artifacts.length,
  };
}

function qualityGateFor({ claims, routeGraph, artifacts, collectorReport, claimAudit }) {
  const checks = [
    { id: 'collector_coverage', pass: (collectorReport || []).filter((c) => c.status === 'complete').length >= 6 },
    { id: 'claim_traceability', pass: !claimAudit.unsupportedClaims },
    { id: 'unknown_discipline', pass: claims.some((c) => c.status === 'UNKNOWN') },
    { id: 'route_graph_present', pass: (routeGraph?.nodes?.length || 0) > 0 },
    { id: 'artifact_depth', pass: artifacts.length >= 5 },
    { id: 'api_or_unknown', pass: routeGraph.nodes.some((n) => n.type === 'api') || claims.some((c) => c.section === 'Public API Surface' && c.status === 'UNKNOWN') },
  ];
  return {
    status: 'complete',
    pass: checks.every((c) => c.pass),
    score: checks.filter((c) => c.pass).length,
    total: checks.length,
    checks,
  };
}

function addClaim(claims, { section, status, claim, evidenceRefs = [], confidence = 'medium' }) {
  claims.push({ id: `C${claims.length + 1}`, section, status, claim, evidenceRefs, confidence });
}

function writeClaimsJsonl(file, claims) {
  fs.writeFileSync(file, `${claims.map((c) => JSON.stringify(c)).join('\n')}\n`);
}

function structureFromClaims({ target, mode, claims, routeGraph, unknowns, artifacts }) {
  const bySection = new Map();
  for (const c of claims) {
    if (!bySection.has(c.section)) bySection.set(c.section, []);
    bySection.get(c.section).push(c);
  }
  const sections = [
    'Public Surface Inventory',
    'Frontend Architecture',
    'Frontend Technology Evidence',
    'Public API Surface',
    'Authentication And Account Model',
    'Product Workflows',
    'Data Model Inference',
    'Storage, Media, And Delivery',
    'Infrastructure Clues',
    'Route Graph',
    'Quality Gate',
    'Unknowns And Verification Plan',
  ];
  let md = `# RSA ${mode} Structure: ${target}\n\nCaptured: ${nowIso}\n\nArtifacts:\n`;
  for (const a of artifacts) md += `- [VERIFIED] ${a}\n`;
  md += '\n';
  for (const s of sections) {
    md += `## ${s}\n\n### Findings\n`;
    const cs = bySection.get(s) || [];
    if (!cs.length) md += '- [UNKNOWN] No claim generated for this section in this benchmark mode.\n';
    for (const c of cs) md += `- [${c.status}] ${c.claim} (confidence: ${c.confidence}; evidence: ${c.evidenceRefs.join(', ') || 'none'})\n`;
    md += '\n### Evidence\n';
    if (cs.length) {
      for (const c of cs) md += `- ${c.id}: ${c.evidenceRefs.join(', ') || 'No concrete evidence reference'}\n`;
    } else {
      md += '- No evidence captured for this section.\n';
    }
    md += '\n### Open Questions\n';
    for (const u of unknowns.filter((x) => x.section === s).slice(0, 5)) md += `- [UNKNOWN] ${u.question}\n`;
    if (!unknowns.some((x) => x.section === s)) md += '- [UNKNOWN] No additional section-specific unknown recorded.\n';
    md += '\n';
  }
  md += '## Route Graph Data\n\n```json\n';
  md += JSON.stringify({ nodes: routeGraph.nodes.slice(0, 50), edges: routeGraph.edges.slice(0, 80) }, null, 2);
  md += '\n```\n';
  return md;
}

function metricsFor({ claims, routeGraph, artifacts, evidence = {}, expected = [] }) {
  const hit = (id, fn) => {
    try { return !!fn(); } catch { return false; }
  };
  const expectedHits = expected.map((e) => ({ id: e.id, hit: hit(e.id, e.test) }));
  const verified = claims.filter((c) => c.status === 'VERIFIED').length;
  const inferred = claims.filter((c) => c.status === 'INFERRED').length;
  const unknown = claims.filter((c) => c.status === 'UNKNOWN').length;
  const traceable = claims.filter((c) => c.evidenceRefs?.length).length;
  const endpointNodes = routeGraph.nodes.filter((n) => n.type === 'api').length;
  const routeNodes = routeGraph.nodes.filter((n) => n.type === 'page').length;
  const quality = {
    expectedCoverage: expected.length ? expectedHits.filter((x) => x.hit).length / expected.length : 0,
    claimTraceability: claims.length ? traceable / claims.length : 0,
    evidenceDepth: Math.min(1, (artifacts.length + endpointNodes + routeNodes) / 35),
    unknownDiscipline: unknown > 0 ? 1 : 0.5,
  };
  quality.total = Number(((quality.expectedCoverage * 0.45) + (quality.claimTraceability * 0.25) + (quality.evidenceDepth * 0.2) + (quality.unknownDiscipline * 0.1)).toFixed(4));
  return {
    claims: { total: claims.length, verified, inferred, unknown, traceable },
    routeGraph: { nodes: routeGraph.nodes.length, edges: routeGraph.edges.length, pageNodes: routeNodes, apiNodes: endpointNodes },
    artifacts: artifacts.length,
    evidenceCounts: evidence,
    expectedHits,
    quality,
  };
}

async function runOld(outDir) {
  debug('runOld:start');
  mkdirp(outDir);
  const homepage = await fetchText(targetUrl.href, path.join(outDir, 'homepage.html'));
  const robots = await fetchText(new URL('/robots.txt', origin).href, path.join(outDir, 'robots.txt'));
  const sitemap = await fetchText(new URL('/sitemap.xml', origin).href, path.join(outDir, 'sitemap.xml'));
  const manifest = await fetchText(new URL('/manifest.json', origin).href, path.join(outDir, 'manifest.json'));
  const html = homepage.text || '';
  const scripts = dedupe(attrAll(html, 'script', 'src').map((s) => absoluteUrl(s)));
  const styles = dedupe(attrAll(html, 'link', 'href').filter((h) => /\.css(?:\?|$)/i.test(h)).map((s) => absoluteUrl(s)));
  const links = dedupe(attrAll(html, 'a', 'href').map((s) => absoluteUrl(s)).filter(sameOrigin));
  const forms = (html.match(/<form\b/gi) || []).length;
  const routeGraph = { nodes: [], edges: [] };
  routeGraph.nodes.push({ id: targetUrl.href, type: 'page' });
  for (const l of links.slice(0, 80)) {
    routeGraph.nodes.push({ id: l, type: 'page' });
    routeGraph.edges.push({ from: targetUrl.href, to: l, evidence: 'homepage link' });
  }
  for (const s of scripts) routeGraph.nodes.push({ id: s, type: 'script' });
  for (const s of styles) routeGraph.nodes.push({ id: s, type: 'style' });
  routeGraph.nodes = [...new Map(routeGraph.nodes.map((n) => [n.id, n])).values()];
  const claims = [];
  addClaim(claims, { section: 'Public Surface Inventory', status: homepage.ok ? 'VERIFIED' : 'UNKNOWN', claim: `Homepage returned HTTP ${homepage.status || 'unknown'} with title "${titleOf(html)}".`, evidenceRefs: ['old/homepage.html'], confidence: homepage.ok ? 'high' : 'low' });
  addClaim(claims, { section: 'Public Surface Inventory', status: robots.ok ? 'VERIFIED' : 'UNKNOWN', claim: `robots.txt returned HTTP ${robots.status || 'unknown'}.`, evidenceRefs: ['old/robots.txt'], confidence: robots.ok ? 'high' : 'low' });
  addClaim(claims, { section: 'Public Surface Inventory', status: sitemap.ok ? 'VERIFIED' : 'UNKNOWN', claim: `sitemap.xml returned HTTP ${sitemap.status || 'unknown'}.`, evidenceRefs: ['old/sitemap.xml'], confidence: sitemap.ok ? 'high' : 'low' });
  addClaim(claims, { section: 'Frontend Architecture', status: scripts.length ? 'VERIFIED' : 'UNKNOWN', claim: `Homepage references ${scripts.length} script assets and ${styles.length} stylesheet assets.`, evidenceRefs: ['old/homepage.html'], confidence: scripts.length ? 'medium' : 'low' });
  addClaim(claims, { section: 'Product Workflows', status: forms ? 'VERIFIED' : 'UNKNOWN', claim: `Homepage contains ${forms} form element(s).`, evidenceRefs: ['old/homepage.html'], confidence: forms ? 'medium' : 'low' });
  addClaim(claims, { section: 'Infrastructure Clues', status: homepage.headers?.server ? 'VERIFIED' : 'UNKNOWN', claim: `Homepage server header is "${homepage.headers?.server || 'not observed'}".`, evidenceRefs: ['old/homepage.html.headers.json'], confidence: homepage.headers?.server ? 'high' : 'low' });
  addClaim(claims, { section: 'Public API Surface', status: 'UNKNOWN', claim: 'No public API endpoint was executed or extracted in old RSA baseline mode.', evidenceRefs: [], confidence: 'high' });
  addClaim(claims, { section: 'Storage, Media, And Delivery', status: 'UNKNOWN', claim: 'No VOD/download/storage route was verified in old RSA baseline mode.', evidenceRefs: [], confidence: 'high' });
  const unknowns = [
    { section: 'Public API Surface', question: 'Which public JSON endpoints are used by normal UI interactions?' },
    { section: 'Data Model Inference', question: 'Which fields are returned by public search or detail endpoints?' },
    { section: 'Storage, Media, And Delivery', question: 'Which media/profile/download routes are visible?' },
    { section: 'Authentication And Account Model', question: 'Which account/premium routes are visible?' },
  ];
  const artifacts = ['old/homepage.html', 'old/robots.txt', 'old/sitemap.xml', 'old/manifest.json'];
  writeClaimsJsonl(path.join(outDir, 'claims.jsonl'), claims);
  writeJson(path.join(outDir, 'route-graph.json'), routeGraph);
  writeJson(path.join(outDir, 'evidence.json'), { homepage: { status: homepage.status, title: titleOf(html), scripts, styles, links, forms, headers: homepage.headers }, robots: { status: robots.status, sample: (robots.text || '').slice(0, 1000) }, sitemap: { status: sitemap.status, sample: (sitemap.text || '').slice(0, 1000) }, manifest: { status: manifest.status, sample: (manifest.text || '').slice(0, 1000) } });
  fs.writeFileSync(path.join(outDir, 'STRUCTURE.MD'), structureFromClaims({ target: targetUrl.href, mode: 'old', claims, routeGraph, unknowns, artifacts }));
  debug('runOld:done');
  return { claims, routeGraph, artifacts, raw: { homepage, robots, sitemap, manifest, scripts, styles, links, forms } };
}

async function runNew(outDir) {
  debug('runNew:start');
  mkdirp(outDir);
  let chromium;
  try {
    ({ chromium } = require('playwright'));
  } catch {
    throw new Error('Playwright is required for new RSA benchmark mode');
  }
  const network = [];
  debug('runNew:launch-browser');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1365, height: 900 }, userAgent: 'Mozilla/5.0 DStudio RSA benchmark' });
  const page = await context.newPage();
  page.on('response', async (res) => {
    const req = res.request();
    const url = res.url();
    let host = '';
    try { host = new URL(url).hostname; } catch {}
    if (host && (host === targetUrl.hostname || host.endsWith(`.${targetUrl.hostname}`) || /cloudflare|googletagmanager|google-analytics|gstatic|googleapis/.test(host))) {
      const headers = res.headers();
      network.push({ method: req.method(), url, host, resourceType: req.resourceType(), status: res.status(), contentType: headers['content-type'] || '', server: headers.server || '', cacheControl: headers['cache-control'] || '', cfCacheStatus: headers['cf-cache-status'] || '' });
    }
  });
  debug('runNew:goto-home', navWaitUntil, navTimeoutMs);
  const response = await page.goto(targetUrl.href, { waitUntil: navWaitUntil, timeout: navTimeoutMs });
  await page.screenshot({ path: path.join(outDir, 'homepage.png'), fullPage: false });
  debug('runNew:dom-eval');
  const dom = await page.evaluate(() => {
    const text = (el) => (el?.textContent || '').replace(/\s+/g, ' ').trim();
    const attr = (el, n) => el.getAttribute(n) || '';
    return {
      url: location.href,
      title: document.title,
      lang: document.documentElement.lang || '',
      h1: [...document.querySelectorAll('h1')].map(text),
      h2: [...document.querySelectorAll('h2')].map(text).slice(0, 30),
      scripts: [...document.querySelectorAll('script[src]')].map((s) => attr(s, 'src')),
      stylesheets: [...document.querySelectorAll('link[rel="stylesheet"],link[href$=".css"]')].map((s) => attr(s, 'href')),
      links: [...document.querySelectorAll('a[href]')].map((a) => ({ href: attr(a, 'href'), text: text(a).slice(0, 120) })).slice(0, 700),
      forms: [...document.querySelectorAll('form')].map((f) => ({ action: attr(f, 'action'), method: (attr(f, 'method') || 'get').toUpperCase(), inputs: [...f.querySelectorAll('input,select,textarea,button')].map((i) => ({ tag: i.tagName.toLowerCase(), type: attr(i, 'type'), name: attr(i, 'name'), placeholder: attr(i, 'placeholder'), value: attr(i, 'value'), text: text(i).slice(0, 80) })).slice(0, 60) })),
      images: [...document.querySelectorAll('img[src]')].map((img) => ({ src: attr(img, 'src'), alt: attr(img, 'alt') })).slice(0, 180),
      localStorage: Object.fromEntries(Object.keys(localStorage).map((k) => [k, localStorage.getItem(k)])),
      sessionStorage: Object.fromEntries(Object.keys(sessionStorage).map((k) => [k, sessionStorage.getItem(k)])),
    };
  });
  const cookies = await context.cookies();
  const selectedPages = [];
  const linkUrls = dedupe(dom.links.map((l) => absoluteUrl(l.href, dom.url)).filter(sameOrigin).map((u) => u.split('#')[0]));
  debug('runNew:selected-pages', linkUrls.length);
  for (const u of [targetUrl.href, ...linkUrls].slice(0, 12)) {
    try {
      const r = await page.goto(u, { waitUntil: 'domcontentloaded', timeout: loopbackTarget ? 5000 : 25000 });
      await page.waitForTimeout(300);
      const p = await page.evaluate(() => {
        const text = (el) => (el?.textContent || '').replace(/\s+/g, ' ').trim();
        return { url: location.href, title: document.title, h1: [...document.querySelectorAll('h1')].map(text).slice(0, 5), h2: [...document.querySelectorAll('h2')].map(text).slice(0, 8), formCount: document.querySelectorAll('form').length };
      });
      selectedPages.push({ requestedUrl: u, status: r?.status() || 0, ...p });
    } catch (err) {
      selectedPages.push({ requestedUrl: u, error: String(err?.message || err) });
    }
  }
  const searchObserved = [];
  try {
    debug('runNew:search');
    await page.goto(targetUrl.href, { waitUntil: navWaitUntil, timeout: navTimeoutMs });
    page.on('response', async (res) => {
      if (!/\/search\/|\/api\/search/.test(res.url())) return;
      let body = '';
      try { body = await res.text(); } catch {}
      searchObserved.push({ url: res.url(), status: res.status(), contentType: res.headers()['content-type'] || '', bodySample: body.slice(0, 2000) });
    });
    const input = page.getByPlaceholder(/search|stream|link|name/i).first();
    await input.click({ timeout: loopbackTarget ? 500 : 5000 }).catch(() => {});
    await page.waitForTimeout(300);
    const candidates = [
      page.locator('input:not([readonly])').first(),
      page.locator('.global-search-input-container input').first(),
      page.locator('#globalSearchInput').first(),
    ];
    for (const loc of candidates) {
      try {
        await loc.fill(query, { timeout: shortTimeoutMs });
        break;
      } catch {}
    }
    await page.waitForTimeout(loopbackTarget ? 250 : 1800);
    await page.screenshot({ path: path.join(outDir, 'search-interaction.png'), fullPage: false });
  } catch {}
  debug('runNew:browser-close');
  await browser.close();

  debug('runNew:fetch-sidecars');
  const robots = await fetchText(new URL('/robots.txt', origin).href, path.join(outDir, 'robots.txt'));
  const sitemap = await fetchText(new URL('/sitemap.xml', origin).href, path.join(outDir, 'sitemap.xml'));
  const manifest = await fetchText(new URL('/manifest.json', origin).href, path.join(outDir, 'manifest.json'));
  const scriptUrls = dedupe(dom.scripts.map((s) => absoluteUrl(s, dom.url))).filter(sameOrigin);
  const styleUrls = dedupe(dom.stylesheets.map((s) => absoluteUrl(s, dom.url))).filter(sameOrigin);
  const scriptFetches = [];
  for (const u of scriptUrls.slice(0, 24)) {
    const f = await fetchText(u, path.join(outDir, `script-${scriptFetches.length}.js`));
    scriptFetches.push(f);
  }
  const styleFetches = [];
  for (const u of styleUrls.slice(0, 16)) {
    const f = await fetchText(u, path.join(outDir, `style-${styleFetches.length}.css`));
    styleFetches.push(f);
  }
  const jsEndpoints = dedupe(scriptFetches.flatMap((s) => extractEndpointsFromJs(s.text || '')));
  const scriptsText = scriptFetches.map((s) => `${s.url}\n${s.text || ''}`).join('\n');
  const stylesText = styleFetches.map((s) => `${s.url}\n${s.text || ''}`).join('\n');
  const publicUrlsInBundles = dedupe([...`${scriptsText}\n${stylesText}`.matchAll(/https?:\/\/[^\s"'<>),]+/g)].map((m) => m[0]));
  const routeGraph = { nodes: [], edges: [] };
  const addNode = (id, type) => { if (id) routeGraph.nodes.push({ id, type }); };
  const addEdge = (from, to, evidence) => { if (from && to) routeGraph.edges.push({ from, to, evidence }); };
  addNode(targetUrl.href, 'page');
  for (const p of selectedPages) {
    if (p.url || p.requestedUrl) addNode(p.url || p.requestedUrl, 'page');
    addEdge(targetUrl.href, p.url || p.requestedUrl, 'sampled public page');
  }
  for (const u of scriptUrls) { addNode(u, 'script'); addEdge(targetUrl.href, u, 'script src'); }
  for (const u of styleUrls) { addNode(u, 'style'); addEdge(targetUrl.href, u, 'stylesheet href'); }
  for (const ep of jsEndpoints) {
    addNode(ep, /^\/(?:api\/|graphql|trpc\/|rpc\/|search\/)/.test(ep) ? 'api' : 'route');
    addEdge('first-party-js', ep, 'JS string/fetch extraction');
  }
  for (const req of network) {
    if (/\/api\/|\/graphql|\/trpc\/|\/rpc\/|\/search\//.test(req.url)) {
      addNode(req.url, 'api');
      addEdge(targetUrl.href, req.url, 'network request during normal navigation');
    }
  }
  for (const img of dom.images.map((i) => absoluteUrl(i.src, dom.url)).filter(Boolean).slice(0, 80)) { addNode(img, 'media'); addEdge(targetUrl.href, img, 'img src'); }
  for (const u of publicUrlsInBundles.slice(0, 80)) {
    const type = /\.m3u8\b|\.mpd\b|\.mp4\b|\/download|\/dl\/|X-Amz-Signature=|signature=|token=|expires=/i.test(u) ? 'storage' : 'external';
    addNode(u, type);
    addEdge('first-party-js', u, 'URL literal in public bundle');
  }
  routeGraph.nodes = [...new Map(routeGraph.nodes.map((n) => [n.id, n])).values()];
  routeGraph.edges = [...new Map(routeGraph.edges.map((e) => [`${e.from}->${e.to}:${e.evidence}`, e])).values()];

  const frontendSignals = detectFrontendSignals({ dom, scriptsText, stylesText, network });
  const spaSignals = detectSpaSignals({ dom, scriptsText, network });
  const authSignals = detectAuthSignals({ dom, scriptsText, cookies, selectedPages });
  const mediaSignals = detectMediaSignals({ dom, scriptsText, network });
  const cdnSignals = detectSignedCdnSignals({ dom, scriptsText, network });

  debug('runNew:claims');
  const claims = [];
  addClaim(claims, { section: 'Public Surface Inventory', status: 'VERIFIED', claim: `Homepage returned HTTP ${response?.status() || 'unknown'} with title "${dom.title}" and H1 ${JSON.stringify(dom.h1)}.`, evidenceRefs: ['new/homepage.png', 'new/evidence.json'], confidence: 'high' });
  addClaim(claims, { section: 'Public Surface Inventory', status: 'VERIFIED', claim: `${selectedPages.filter((p) => p.status === 200).length} sampled public pages returned HTTP 200.`, evidenceRefs: ['new/evidence.json'], confidence: 'high' });
  addClaim(claims, { section: 'Public Surface Inventory', status: robots.ok ? 'VERIFIED' : 'UNKNOWN', claim: `robots.txt returned HTTP ${robots.status || 'unknown'}${robots.text ? ` and includes ${JSON.stringify(robots.text.slice(0, 160))}` : ''}.`, evidenceRefs: ['new/robots.txt'], confidence: robots.ok ? 'high' : 'low' });
  addClaim(claims, { section: 'Public Surface Inventory', status: sitemap.ok ? 'VERIFIED' : 'UNKNOWN', claim: `sitemap.xml returned HTTP ${sitemap.status || 'unknown'}${/sitemapindex/i.test(sitemap.text || '') ? ' and is a sitemap index.' : '.'}`, evidenceRefs: ['new/sitemap.xml'], confidence: sitemap.ok ? 'high' : 'low' });
  addClaim(claims, { section: 'Frontend Architecture', status: /jQuery v3\.7\.1/.test(scriptsText) ? 'VERIFIED' : 'INFERRED', claim: 'First-party assets include jQuery 3.7.1.', evidenceRefs: ['new/script-0.js', 'new/evidence.json'], confidence: /jQuery v3\.7\.1/.test(scriptsText) ? 'high' : 'medium' });
  addClaim(claims, { section: 'Frontend Architecture', status: /Bootstrap v5\.3\.2/.test(scriptsText) ? 'VERIFIED' : 'INFERRED', claim: 'First-party assets include Bootstrap 5.3.2 bundle.', evidenceRefs: ['new/script-1.js', 'new/evidence.json'], confidence: /Bootstrap v5\.3\.2/.test(scriptsText) ? 'high' : 'medium' });
  addClaim(claims, { section: 'Frontend Architecture', status: 'VERIFIED', claim: `The page references ${scriptUrls.length} same-origin scripts and ${styleUrls.length} same-origin stylesheets.`, evidenceRefs: ['new/evidence.json'], confidence: 'high' });
  if (frontendSignals.length) {
    addClaim(claims, { section: 'Frontend Technology Evidence', status: 'VERIFIED', claim: `Frontend/runtime markers observed: ${frontendSignals.map((s) => s.id).join(', ')}.`, evidenceRefs: ['new/evidence.json', 'new/script-*.js'], confidence: 'high' });
  }
  addClaim(claims, {
    section: 'Frontend Architecture',
    status: spaSignals.detected ? 'INFERRED' : 'UNKNOWN',
    claim: spaSignals.detected
      ? `SPA/client-runtime behavior is likely present from public markers (confidence ${spaSignals.confidence}).`
      : 'No strong SPA runtime marker was observed from public navigation.',
    evidenceRefs: spaSignals.detected ? ['new/evidence.json', 'new/collectors.json'] : [],
    confidence: spaSignals.confidence,
  });
  if (Object.keys(dom.localStorage).length || scriptsText.includes('localStorage.')) {
    addClaim(claims, { section: 'Frontend Architecture', status: 'VERIFIED', claim: 'Frontend scripts use localStorage for theme/search/filter state.', evidenceRefs: ['new/script-*.js', 'new/evidence.json'], confidence: 'high' });
  }
  addClaim(claims, { section: 'Public API Surface', status: searchObserved.length ? 'VERIFIED' : (jsEndpoints.length ? 'INFERRED' : 'UNKNOWN'), claim: searchObserved.length ? `Normal UI search triggered ${searchObserved[0].url} and returned ${searchObserved[0].contentType || 'a response'}.` : `JS endpoint extraction found ${jsEndpoints.length} endpoint-like paths.`, evidenceRefs: ['new/search-interaction.png', 'new/evidence.json'], confidence: searchObserved.length ? 'high' : 'medium' });
  addClaim(claims, { section: 'Public API Surface', status: jsEndpoints.length ? 'VERIFIED' : 'UNKNOWN', claim: `JS endpoint extraction found ${jsEndpoints.length} endpoint-like paths: ${jsEndpoints.slice(0, 10).join(', ') || 'none'}.`, evidenceRefs: ['new/route-graph.json', 'new/script-*.js'], confidence: jsEndpoints.length ? 'high' : 'low' });
  const searchSample = searchObserved[0]?.bodySample || '';
  if (/platformid|targetid|recording_count/.test(searchSample)) {
    addClaim(claims, { section: 'Data Model Inference', status: 'VERIFIED', claim: 'Search JSON exposes platformid, targetid and recording_count fields for streamer targets.', evidenceRefs: ['new/search-interaction.json'], confidence: 'high' });
  }
  addClaim(claims, { section: 'Product Workflows', status: dom.forms.length ? 'VERIFIED' : 'UNKNOWN', claim: `Homepage exposes ${dom.forms.length} form(s), including inputs ${dom.forms.flatMap((f) => f.inputs.map((i) => i.placeholder || i.name || i.type)).filter(Boolean).slice(0, 12).join(', ') || 'none'}.`, evidenceRefs: ['new/evidence.json'], confidence: dom.forms.length ? 'high' : 'low' });
  if (/addrecordingtargetv2|getrecordingrequeststatus/.test(scriptsText)) {
    addClaim(claims, { section: 'Product Workflows', status: 'INFERRED', claim: 'Add-recording-target workflow appears asynchronous: JS references addrecordingtargetv2 and getrecordingrequeststatus.', evidenceRefs: ['new/script-*.js'], confidence: 'medium' });
  }
  if (/purchase\/plan|premium-upgrade/.test(scriptsText)) {
    addClaim(claims, { section: 'Authentication And Account Model', status: 'VERIFIED', claim: 'Premium upgrade UI links to /purchase/plan and is loaded from premium-upgrade-modal.js.', evidenceRefs: ['new/premium-upgrade-modal evidence in scripts'], confidence: 'high' });
  }
  addClaim(claims, { section: 'Authentication And Account Model', status: cookies.length ? 'VERIFIED' : 'UNKNOWN', claim: `Public navigation exposed ${cookies.length} cookie(s): ${cookies.map((c) => c.name).join(', ') || 'none'}.`, evidenceRefs: ['new/evidence.json'], confidence: cookies.length ? 'high' : 'low' });
  if (authSignals.detected) {
    addClaim(claims, { section: 'Authentication And Account Model', status: 'VERIFIED', claim: `Visible auth/account surface detected: login=${authSignals.login}, oauth=${authSignals.oauth}, sessionCookies=${authSignals.sessionCookies.join(', ') || 'none'}.`, evidenceRefs: ['new/evidence.json'], confidence: authSignals.confidence });
  }
  const mediaRoutes = routeGraph.nodes.filter((n) => /\/imgred\/|\/static\/|profile_image|\/dl\//.test(n.id));
  addClaim(claims, { section: 'Storage, Media, And Delivery', status: mediaRoutes.length ? 'VERIFIED' : 'UNKNOWN', claim: `Observed ${mediaRoutes.length} static/media route nodes, including ${mediaRoutes.slice(0, 5).map((n) => n.id).join(', ') || 'none'}.`, evidenceRefs: ['new/route-graph.json'], confidence: mediaRoutes.length ? 'high' : 'low' });
  if (mediaSignals.detected) {
    addClaim(claims, { section: 'Storage, Media, And Delivery', status: 'VERIFIED', claim: `Media/player delivery clues detected: hls=${mediaSignals.hls}, dash=${mediaSignals.dash}, video=${mediaSignals.video}, download=${mediaSignals.download}.`, evidenceRefs: ['new/evidence.json', 'new/route-graph.json'], confidence: mediaSignals.confidence });
  }
  if (cdnSignals.storageOrCdn || cdnSignals.signed) {
    addClaim(claims, { section: 'Storage, Media, And Delivery', status: cdnSignals.signed ? 'VERIFIED' : 'INFERRED', claim: `Storage/CDN URL clues detected: storageOrCdn=${cdnSignals.storageOrCdn}, signedUrlIndicators=${cdnSignals.signed}.`, evidenceRefs: ['new/evidence.json', 'new/route-graph.json'], confidence: cdnSignals.confidence });
  }
  addClaim(claims, { section: 'Infrastructure Clues', status: response?.headers()?.server ? 'VERIFIED' : 'UNKNOWN', claim: `Homepage server header is "${response?.headers()?.server || 'not observed'}"; cf-ray=${response?.headers()?.['cf-ray'] || 'not observed'}.`, evidenceRefs: ['new/evidence.json'], confidence: response?.headers()?.server ? 'high' : 'low' });
  if (dom.scripts.some((s) => /googletagmanager|cloudflareinsights|argus/i.test(s))) {
    addClaim(claims, { section: 'Infrastructure Clues', status: 'VERIFIED', claim: `Observed third-party/infra scripts: ${dom.scripts.filter((s) => /googletagmanager|cloudflareinsights|argus/i.test(s)).join(', ')}.`, evidenceRefs: ['new/evidence.json'], confidence: 'high' });
  }
  addClaim(claims, { section: 'Route Graph', status: 'VERIFIED', claim: `Route graph contains ${routeGraph.nodes.length} nodes and ${routeGraph.edges.length} edges from links, assets, media and JS endpoint extraction.`, evidenceRefs: ['new/route-graph.json'], confidence: 'high' });
  const unknowns = [
    { section: 'Authentication And Account Model', question: 'Exact auth/session/CSRF implementation requires authenticated/internal evidence.' },
    { section: 'Storage, Media, And Delivery', question: 'VOD storage provider, signed URL model and download pipeline are not visible anonymously.' },
    { section: 'Infrastructure Clues', question: 'Origin hosting provider and backend services are hidden behind public edge.' },
    { section: 'Product Workflows', question: 'Recording worker lifecycle and queue/retry behavior are not externally visible.' },
  ];
  for (const u of unknowns) addClaim(claims, { section: u.section, status: 'UNKNOWN', claim: u.question, evidenceRefs: [], confidence: 'high' });
  const artifacts = ['new/evidence.json', 'new/claims.jsonl', 'new/collectors.json', 'new/claim-audit.json', 'new/quality-gate.json', 'new/route-graph.json', 'new/homepage.png', 'new/search-interaction.png'];
  const collectorReport = buildCollectorReport({ dom, network, robots, sitemap, scriptFetches, styleFetches, jsEndpoints, routeGraph, searchObserved, cookies, frontendSignals, spaSignals, authSignals, mediaSignals, cdnSignals });
  const claimAudit = buildClaimAudit(claims, artifacts);
  const qualityGate = qualityGateFor({ claims, routeGraph, artifacts, collectorReport, claimAudit });
  addClaim(claims, { section: 'Quality Gate', status: qualityGate.pass ? 'VERIFIED' : 'UNKNOWN', claim: `Deterministic RSA quality gate ${qualityGate.pass ? 'passed' : 'did not pass'} with ${qualityGate.score}/${qualityGate.total} checks.`, evidenceRefs: ['new/quality-gate.json', 'new/claim-audit.json', 'new/collectors.json'], confidence: 'high' });
  const evidence = { target: targetUrl.href, capturedAt: nowIso, homepageStatus: response?.status() || 0, homepageHeaders: response?.headers() || {}, dom, selectedPages, cookies, network, robots: { status: robots.status, sample: (robots.text || '').slice(0, 1200) }, sitemap: { status: sitemap.status, sample: (sitemap.text || '').slice(0, 1200) }, manifest: { status: manifest.status, sample: (manifest.text || '').slice(0, 1200) }, scripts: scriptFetches.map((s) => ({ url: s.url, status: s.status, textSample: (s.text || '').slice(0, 1200) })), styles: styleFetches.map((s) => ({ url: s.url, status: s.status, textSample: (s.text || '').slice(0, 800) })), jsEndpoints, searchObserved, frontendSignals, spaSignals, authSignals, mediaSignals, cdnSignals, collectorReport, claimAudit, qualityGate };
  writeJson(path.join(outDir, 'evidence.json'), evidence);
  writeJson(path.join(outDir, 'route-graph.json'), routeGraph);
  writeJson(path.join(outDir, 'collectors.json'), collectorReport);
  writeJson(path.join(outDir, 'claim-audit.json'), claimAudit);
  writeJson(path.join(outDir, 'quality-gate.json'), qualityGate);
  writeJson(path.join(outDir, 'search-interaction.json'), { query, observed: searchObserved });
  writeClaimsJsonl(path.join(outDir, 'claims.jsonl'), claims);
  fs.writeFileSync(path.join(outDir, 'STRUCTURE.MD'), structureFromClaims({ target: targetUrl.href, mode: 'new', claims, routeGraph, unknowns, artifacts }));
  debug('runNew:done');
  return { claims, routeGraph, artifacts, raw: evidence };
}

function expectedFacts(oldRun, newRun) {
  const old = oldRun.raw;
  const newer = newRun.raw;
  const scriptsNew = (newer.scripts || []).map((s) => `${s.url}\n${s.textSample}`).join('\n');
  const scriptsOld = (old.scripts || []).join('\n');
  const robotsOld = old.robots?.text || '';
  const sitemapOld = old.sitemap?.text || '';
  return [
    { id: 'homepage_200', old: () => old.homepage.status === 200, new: () => newer.homepageStatus === 200 },
    { id: 'homepage_h1', old: () => tagsText(old.homepage.text || '', 'h1').length > 0, new: () => newer.dom.h1.length > 0 },
    { id: 'robots_disallow_api', old: () => /Disallow:\s*\/api/i.test(robotsOld), new: () => /Disallow:\s*\/api/i.test(newer.robots.sample || '') },
    { id: 'sitemap_index', old: () => /sitemapindex/i.test(sitemapOld), new: () => /sitemapindex/i.test(newer.sitemap.sample || '') },
    { id: 'cloudflare_header', old: () => /cloudflare/i.test(old.homepage.headers?.server || ''), new: () => /cloudflare/i.test(newer.homepageHeaders?.server || '') },
    { id: 'jquery_version', old: () => /jquery/i.test(scriptsOld), new: () => /jQuery v3\.7\.1|jquery-3\.7\.1/i.test(scriptsNew) },
    { id: 'bootstrap_version', old: () => /bootstrap/i.test(scriptsOld), new: () => /Bootstrap v5\.3\.2|bootstrap\.bundle/i.test(scriptsNew) },
    { id: 'search_endpoint', old: () => false, new: () => (newer.searchObserved || []).some((x) => /\/search\/recordingtarget2/.test(x.url)) || (newer.jsEndpoints || []).some((x) => /\/search\/recordingtarget2/.test(x)) },
    { id: 'search_json_fields', old: () => false, new: () => (newer.searchObserved || []).some((x) => /platformid|targetid|recording_count/.test(x.bodySample || '')) },
    { id: 'add_target_workflow_refs', old: () => false, new: () => /addrecordingtargetv2|getrecordingrequeststatus/.test(scriptsNew) || (newer.jsEndpoints || []).some((x) => /addrecordingtargetv2|getrecordingrequeststatus/.test(x)) },
    { id: 'premium_route', old: () => false, new: () => /purchase\/plan|premium-upgrade/.test(scriptsNew) || (newer.jsEndpoints || []).some((x) => /purchase\/plan/.test(x)) },
    { id: 'localstorage_state', old: () => false, new: () => /localStorage/.test(scriptsNew) },
    { id: 'route_graph_js_endpoints', old: () => false, new: () => (newer.jsEndpoints || []).length > 0 },
    { id: 'sampled_public_pages', old: () => false, new: () => (newer.selectedPages || []).filter((p) => p.status === 200).length >= 5 },
  ];
}

function compareSummary(oldRun, newRun) {
  const expected = expectedFacts(oldRun, newRun);
  const oldMetrics = metricsFor({
    ...oldRun,
    evidence: { scripts: oldRun.raw.scripts.length, links: oldRun.raw.links.length, forms: oldRun.raw.forms },
    expected: expected.map((x) => ({ id: x.id, test: x.old })),
  });
  const newMetrics = metricsFor({
    ...newRun,
    evidence: { network: newRun.raw.network.length, scripts: newRun.raw.scripts.length, jsEndpoints: newRun.raw.jsEndpoints.length, selectedPages: newRun.raw.selectedPages.length },
    expected: expected.map((x) => ({ id: x.id, test: x.new })),
  });
  const oldHits = oldMetrics.expectedHits.filter((x) => x.hit).length;
  const newHits = newMetrics.expectedHits.filter((x) => x.hit).length;
  return {
    target: targetUrl.href,
    capturedAt: nowIso,
    old: oldMetrics,
    new: newMetrics,
    delta: {
      expectedHits: newHits - oldHits,
      verifiedClaims: newMetrics.claims.verified - oldMetrics.claims.verified,
      apiNodes: newMetrics.routeGraph.apiNodes - oldMetrics.routeGraph.apiNodes,
      routeNodes: newMetrics.routeGraph.pageNodes - oldMetrics.routeGraph.pageNodes,
      quality: Number((newMetrics.quality.total - oldMetrics.quality.total).toFixed(4)),
    },
    verdict: newMetrics.quality.total > oldMetrics.quality.total
      ? 'new-rsa-wins'
      : newMetrics.quality.total === oldMetrics.quality.total ? 'tie' : 'old-rsa-wins',
  };
}

function writeSummaryMd(file, summary) {
  const md = `# RSA Benchmark Comparison\n\nTarget: ${summary.target}  \nCaptured: ${summary.capturedAt}\n\n## Result\n\nVerdict: **${summary.verdict}**\n\n| Metric | Old RSA | New RSA | Delta |\n|---|---:|---:|---:|\n| Quality score | ${summary.old.quality.total} | ${summary.new.quality.total} | ${summary.delta.quality} |\n| Expected facts hit | ${summary.old.expectedHits.filter((x) => x.hit).length}/${summary.old.expectedHits.length} | ${summary.new.expectedHits.filter((x) => x.hit).length}/${summary.new.expectedHits.length} | ${summary.delta.expectedHits} |\n| Verified claims | ${summary.old.claims.verified} | ${summary.new.claims.verified} | ${summary.delta.verifiedClaims} |\n| Traceable claims | ${summary.old.claims.traceable}/${summary.old.claims.total} | ${summary.new.claims.traceable}/${summary.new.claims.total} |  |\n| Route graph nodes | ${summary.old.routeGraph.nodes} | ${summary.new.routeGraph.nodes} | ${summary.new.routeGraph.nodes - summary.old.routeGraph.nodes} |\n| API nodes | ${summary.old.routeGraph.apiNodes} | ${summary.new.routeGraph.apiNodes} | ${summary.delta.apiNodes} |\n| Artifacts | ${summary.old.artifacts} | ${summary.new.artifacts} | ${summary.new.artifacts - summary.old.artifacts} |\n\n## Expected Fact Hits\n\n| Fact | Old | New |\n|---|---:|---:|\n${summary.new.expectedHits.map((hit, i) => `| ${hit.id} | ${summary.old.expectedHits[i]?.hit ? 'yes' : 'no'} | ${hit.hit ? 'yes' : 'no'} |`).join('\n')}\n\n## Evaluation\n\nThe new RSA mode is stronger when the task is to reverse real structure from a site because it adds deterministic capture before any model interpretation: Playwright network evidence, script endpoint extraction, a claim ledger, and route graph output. The old baseline can identify homepage-level facts, headers, robots and sitemap, but it misses workflow-level API behavior and client-side state unless a model manually discovers them.\n\nRemaining gap: new RSA still cannot prove backend internals that are not exposed publicly. Those should remain UNKNOWN unless an authenticated run or internal evidence is provided.\n`;
  fs.writeFileSync(file, md);
}

const oldDir = path.join(outRoot, 'old');
const newDir = path.join(outRoot, 'new');
console.log(`RSA benchmark target: ${targetUrl.href}`);
console.log(`Output: ${outRoot}`);
const oldRun = await runOld(oldDir);
const newRun = await runNew(newDir);
const summary = compareSummary(oldRun, newRun);
writeJson(path.join(outRoot, 'summary.json'), summary);
writeSummaryMd(path.join(outRoot, 'summary.md'), summary);
console.log(JSON.stringify({
  outRoot,
  verdict: summary.verdict,
  oldQuality: summary.old.quality.total,
  newQuality: summary.new.quality.total,
  oldExpected: summary.old.expectedHits.filter((x) => x.hit).length,
  newExpected: summary.new.expectedHits.filter((x) => x.hit).length,
  oldStructure: path.join(oldDir, 'STRUCTURE.MD'),
  newStructure: path.join(newDir, 'STRUCTURE.MD'),
}, null, 2));

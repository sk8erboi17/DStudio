import fs from 'node:fs';
import assert from 'node:assert/strict';

const html = fs.readFileSync('web/index.html', 'utf8');
const readme = fs.readFileSync('README.md', 'utf8');
const thirdPartyNotices = fs.readFileSync('THIRD_PARTY_NOTICES.md', 'utf8');
const loadingHtml = fs.readFileSync('web/loading.html', 'utf8');
const launcherMain = fs.readFileSync('src/dstudio.c', 'utf8');
const launcherDomains = fs.readdirSync('src')
  .filter((name) => /^dstudio_.*\.c$/.test(name))
  .sort()
  .map((name) => fs.readFileSync(`src/${name}`, 'utf8'))
  .join('\n');
const launcher = `${launcherMain}\n${launcherDomains}`;
const app = fs.readFileSync('src/app.cc', 'utf8');
const webview = fs.readFileSync('src/webview.h', 'utf8');
const remoteHelper = fs.readFileSync('extension/remote/dstudio_remote_llm.c', 'utf8');
const remoteAgent = fs.readFileSync('patch/ds4-agent-jsonl/remote-agent.cfrag', 'utf8');
const remoteDesign = fs.readFileSync('extension/design/ds4_design.c', 'utf8');
const searchRuntime = fs.readFileSync('extension/search/runtime.js', 'utf8');
const windowsBuild = fs.readFileSync('scripts/build-windows.ps1', 'utf8');
const windowsDs4Build = fs.readFileSync('scripts/build-ds4-windows-cygwin.sh', 'utf8');
const gitignore = fs.readFileSync('.gitignore', 'utf8');
const gsaBenchRunner = fs.readFileSync('extension/gsa/bench/run.mjs', 'utf8');
const gsaRuntimeSource = fs.readFileSync('extension/gsa/dstudio_gsa.cfrag', 'utf8');
const skillSources = fs.readFileSync('extension/skills/sources.tsv', 'utf8');
const gsaTemplateText = fs.readdirSync('extension/gsa/templates')
  .filter((name) => ['.md', '.sh', '.ps1'].some((ext) => name.endsWith(ext)))
  .sort()
  .map((name) => fs.readFileSync(`extension/gsa/templates/${name}`, 'utf8'))
  .join('\n');
const gsaToolCatalogText = fs.readFileSync('extension/gsa/tools/catalog.json', 'utf8');
const gsaToolCatalog = JSON.parse(gsaToolCatalogText);
const gsaRuntime = `${gsaRuntimeSource}\n${gsaTemplateText}\n${gsaToolCatalogText}`;
const rsaRuntime = fs.readFileSync('extension/rsa/dstudio_rsa.cfrag', 'utf8');
const rsaBenchCompare = fs.readFileSync('extension/rsa/bench/compare.mjs', 'utf8');
const handleConnectionSource = (() => {
  const start = launcher.indexOf('static void handle_connection');
  assert.notEqual(start, -1, 'handle_connection should exist');
  const end = launcher.indexOf('/* ==================== main', start);
  assert.notEqual(end, -1, 'handle_connection should end before main section');
  return launcher.slice(start, end);
})();

function readPatchSet(dir, options = {}) {
  const manifestPath = `${dir}/manifest`;
  assert.ok(fs.existsSync(manifestPath), `${dir} manifest should exist`);
  const lines = fs.readFileSync(manifestPath, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
  const values = new Map();
  const edits = [];
  for (const line of lines) {
    const idx = line.indexOf('=');
    assert.notEqual(idx, -1, `${manifestPath} line should be key=value: ${line}`);
    const key = line.slice(0, idx);
    const value = line.slice(idx + 1);
    if (key === 'edit') edits.push(value);
    else values.set(key, value);
  }
  assert.ok(edits.length > 0, `${dir} should list at least one edit`);
  if (options.version) {
    assert.match(values.get('version') || '', /^[1-9]\d*$/, `${dir} should carry a positive patch version`);
  }
  for (const key of ['fragment', 'makefile']) {
    if (options[key]) {
      assert.ok(values.get(key), `${dir} manifest should include ${key}=`);
      assert.ok(fs.existsSync(`${dir}/${values.get(key)}`), `${dir}/${values.get(key)} should exist`);
    }
  }
  const bodies = edits.map((id) => {
    assert.match(id, /^[A-Za-z0-9_.-]+$/, `${dir} edit id should be a safe leaf name`);
    const findPath = `${dir}/${id}.find`;
    const replacePath = `${dir}/${id}.replace`;
    assert.ok(fs.existsSync(findPath), `${findPath} should exist`);
    assert.ok(fs.existsSync(replacePath), `${replacePath} should exist`);
    const find = fs.readFileSync(findPath, 'utf8');
    const replace = fs.readFileSync(replacePath, 'utf8');
    assert.ok(find.length > 0, `${findPath} should not be empty`);
    return { id, find, replace };
  });
  return { values, edits: bodies, text: bodies.map((e) => `${e.find}\n${e.replace}`).join('\n') };
}

const jsonlPatch = readPatchSet('patch/ds4-agent-jsonl', { version: true, fragment: true, makefile: true });
const webCdpPatch = readPatchSet('patch/ds4-web-cdp');
const webDirectNavPatch = readPatchSet('patch/ds4-web-direct-nav');

function scriptSource() {
  const m = html.match(/<script type="module">([\s\S]*?)<\/script>/);
  assert.ok(m, 'module script not found');
  return m[1];
}

function extractFunction(src, name) {
  let start = src.indexOf(`function ${name}`);
  assert.notEqual(start, -1, `${name} not found`);
  const asyncPrefix = 'async ';
  if (src.slice(Math.max(0, start - asyncPrefix.length), start) === asyncPrefix) {
    start -= asyncPrefix.length;
  }
  const brace = src.indexOf('{', start);
  assert.notEqual(brace, -1, `${name} body not found`);
  let depth = 0;
  for (let i = brace; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`${name} body is not balanced`);
}

const js = scriptSource();
const helpers = new Function(`
${extractFunction(js, 'isLoopbackHost')}
${extractFunction(js, 'adaptBaseUrl')}
${extractFunction(js, 'normalizeLanHostUrl')}
return { isLoopbackHost, adaptBaseUrl, normalizeLanHostUrl };
`)();
const healthHelpers = new Function(`
${extractFunction(js, 'probeLanHost')}
return { probeLanHost };
`)();
const lanModeHelpers = new Function(`
let settings = {};
let lanServed = false;
let stored = {};
const STORAGE_KEYS = { settings: 'settings' };
const localStorage = {
  getItem: (key) => stored[key] || null,
};
const Store = { getSettings: () => settings };
const location = { origin: 'http://192.168.1.93:5500' };
const pageIsLanServed = () => lanServed;
${extractFunction(js, 'storedLanClientHost')}
${extractFunction(js, 'configuredLanClientHost')}
${extractFunction(js, 'currentLanClientHost')}
return {
  currentLanClientHost,
  setLanServed: (value) => { lanServed = value; },
  setSettings: (value) => { settings = value; },
  setStoredSettings: (value) => { stored[STORAGE_KEYS.settings] = JSON.stringify(value); },
};
`)();
const webResearchHelpers = new Function(`
${extractFunction(js, 'sourceKey')}
${extractFunction(js, 'webSourceHost')}
${extractFunction(js, 'explicitUserUrls')}
${extractFunction(js, 'sourcePathParts')}
${extractFunction(js, 'seedExplicitUrlSources')}
${extractFunction(js, 'sourcePathIdentity')}
${extractFunction(js, 'userAskedExternalComparison')}
${extractFunction(js, 'sameExplicitSourceFamily')}
${extractFunction(js, 'selectableSourcesAfterExplicitRead')}
return { explicitUserUrls, seedExplicitUrlSources, selectableSourcesAfterExplicitRead };
`)();
const sourceAdapterHelpers = new Function(`
${extractFunction(js, 'compactText')}
${extractFunction(js, 'uniqueStrings')}
${extractFunction(js, 'sourceKey')}
${extractFunction(js, 'webSourceHost')}
${extractFunction(js, 'validSourceKinds')}
${extractFunction(js, 'normalizeSourceKind')}
${extractFunction(js, 'technicalQuestionLikely')}
${extractFunction(js, 'classifySourceKind')}
${extractFunction(js, 'sourceKindGuidance')}
${extractFunction(js, 'sourceAdapterProfile')}
${extractFunction(js, 'sourceMetadataSummary')}
${extractFunction(js, 'readSourceUnusable')}
${extractFunction(js, 'urlOriginAndParts')}
${extractFunction(js, 'adapterCandidateUrls')}
return {
  validSourceKinds,
  normalizeSourceKind,
  technicalQuestionLikely,
  classifySourceKind,
  sourceKindGuidance,
  sourceAdapterProfile,
  sourceMetadataSummary,
  readSourceUnusable,
  adapterCandidateUrls,
};
`)();
const artifactHelpers = new Function(`
${extractFunction(js, 'generatedFileLanguage')}
return { generatedFileLanguage };
`)();

assert.equal(helpers.isLoopbackHost('localhost'), true);
assert.equal(helpers.isLoopbackHost('127.0.0.1'), true);
assert.equal(helpers.isLoopbackHost('[::1]'), true);
assert.equal(helpers.isLoopbackHost('192.168.1.207'), false);

assert.equal(helpers.adaptBaseUrl('http://127.0.0.1:28000'), '');
assert.equal(helpers.adaptBaseUrl('http://192.168.1.207:28000'), '');
assert.equal(helpers.adaptBaseUrl('http://example.com:1234'), 'http://example.com:1234');

assert.equal(helpers.normalizeLanHostUrl('192.168.1.207'), 'http://192.168.1.207:5500');
assert.equal(helpers.normalizeLanHostUrl('192.168.1.207:5600'), 'http://192.168.1.207:5600');
assert.equal(helpers.normalizeLanHostUrl('http://192.168.1.207:5600/path?q=1'), 'http://192.168.1.207:5600');
assert.throws(() => helpers.normalizeLanHostUrl(''), /Insert the LAN address/);

assert.match(gitignore, /^node_modules\/$/m, 'local node_modules should stay out of git status');
assert.match(gitignore, /^extension\/gsa\/benchmark\/$/m, 'generated GSA benchmark runs should stay out of git status');
assert.match(gitignore, /^\*\.log\.gz$/m, 'compressed local timeline/log artifacts should stay out of git status');
assert.match(gitignore, /^MEMORY\.MD$/m, 'local memory scratch files should stay out of git status');
assert.match(gitignore, /^\.tmp\/$/m, 'local UI screenshots and scratch artifacts should stay out of git status');

for (const [file, upstream] of [
  ['extension/skills/ecc-security-review/SKILL.md', 'ecc/.agents/skills/security-review'],
  ['extension/skills/superpowers-systematic-debugging/SKILL.md', 'superpowers/skills/systematic-debugging'],
  ['extension/skills/anthropic-claude-code-security-review/SKILL.md', 'claude-code-security-review/.claude/commands/security-review.md'],
]) {
  assert.ok(fs.existsSync(file), `${file} should exist`);
  const skill = fs.readFileSync(file, 'utf8');
  assert.match(skill, /modes:\s*\[agent\]/, `${file} should be Agent-mode selectable`);
  assert.match(skill, new RegExp(`ds4_upstream:\\s*${upstream.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`), `${file} should preserve upstream attribution`);
}
assert.ok(fs.existsSync('extension/skills/_licenses/ecc-MIT.txt'), 'ECC imported skill license should be copied locally');
assert.ok(fs.existsSync('extension/skills/_licenses/superpowers-MIT.txt'), 'Superpowers imported skill license should be copied locally');
assert.match(skillSources, /superpowers\thttps:\/\/github\.com\/obra\/superpowers\tmain\t[0-9a-f]{40}\tsuperpowers-\tskills/, 'repo-imported skills should keep an updateable source manifest');
assert.ok(fs.existsSync('extension/skills/_licenses/anthropic-claude-code-security-review-MIT.txt'), 'Anthropic security review license should be copied locally');
assert.match(thirdPartyNotices, /ECC Agent Skills[\s\S]*extension\/skills\/ecc-\*/, 'Third-party notices should cover ECC Agent skills');
assert.match(thirdPartyNotices, /Superpowers Agent Skills[\s\S]*extension\/skills\/superpowers-\*/, 'Third-party notices should cover Superpowers Agent skills');
assert.match(thirdPartyNotices, /Anthropic Claude Code Security Review[\s\S]*anthropic-claude-code-security-review/, 'Third-party notices should cover Anthropic security-review skill');

assert.deepEqual(sourceAdapterHelpers.validSourceKinds(), ['article', 'docs', 'product', 'academic', 'social', 'repo', 'generic']);
assert.equal(sourceAdapterHelpers.classifySourceKind({ url: 'https://example.com/pricing', title: 'Pricing plans' }, 'quanto costa?'), 'product');
assert.equal(sourceAdapterHelpers.classifySourceKind({ url: 'https://docs.example.com/api', title: 'API reference' }, 'come uso api?'), 'docs');
assert.equal(sourceAdapterHelpers.classifySourceKind({ url: 'https://arxiv.org/abs/1234.5678', title: 'Abstract paper' }, 'paper'), 'academic');
assert.equal(sourceAdapterHelpers.classifySourceKind({ url: 'https://news.ycombinator.com/item?id=1', title: 'HN thread' }, 'opinioni'), 'social');
assert.equal(sourceAdapterHelpers.classifySourceKind({ url: 'https://codeberg.org/user/project', title: 'README repository' }, 'che stack usa?'), 'repo');
assert.equal(sourceAdapterHelpers.sourceAdapterProfile({ url: 'https://example.com/features' }, 'features').kind, 'product');
assert.match(sourceAdapterHelpers.sourceKindGuidance('academic'), /authors|results|limitations/i);
assert.match(sourceAdapterHelpers.sourceKindGuidance('social'), /anecdotes/i);
assert.equal(sourceAdapterHelpers.technicalQuestionLikely('che stack e licenza usa?'), true);
assert.equal(sourceAdapterHelpers.technicalQuestionLikely('qual e il prezzo?'), false);
assert.equal(sourceAdapterHelpers.readSourceUnusable({ title: 'File not found', content: 'Repository navigation' }), true);
assert.equal(sourceAdapterHelpers.readSourceUnusable({ title: 'LICENSE', content: 'BSD 3-Clause License Copyright permission' }), false);
assert.equal(artifactHelpers.generatedFileLanguage({ filename: 'stickman.c', mime: 'text/plain' }), 'c');
assert.equal(artifactHelpers.generatedFileLanguage({ filename: 'app.tsx', mime: '' }), 'typescript');
assert.equal(artifactHelpers.generatedFileLanguage({ filename: 'index.html', mime: 'text/html' }), 'html');
assert.equal(artifactHelpers.generatedFileLanguage({ filename: 'notes.txt', mime: 'text/plain' }), '');
assert.match(js, /function highlightCode\(code, lang\)/, 'artifact code preview should reuse the offline syntax highlighter');
assert.match(js, /body\.innerHTML = highlightCode\(file\.content \|\| '', lang\)/, 'artifact code files should render highlighted source');
assert.match(js, /body\.className = `artifact-canvas__content\$\{isMarkdown \? ' md' : ' artifact-canvas__code'\}\$\{lang && !isMarkdown \? ' hl' : ''\}`/, 'artifact previews should choose markdown or highlighted code classes explicitly');
assert.match(js, /function placeGearPopover\(\)[\s\S]*position = 'fixed'[\s\S]*window\.innerHeight[\s\S]*cbarPop\.style\.top/, 'composer gear popover should clamp its position into the viewport');
assert.match(js, /openGear\(\)[\s\S]*placeGearPopover\(\)[\s\S]*window\.addEventListener\('resize', placeGearPopover\)/, 'composer gear popover should be repositioned while open');
assert.match(js, /closeGear\(\)[\s\S]*clearGearPopoverPlacement\(\)[\s\S]*window\.removeEventListener\('resize', placeGearPopover\)/, 'composer gear popover should clean up fixed-position placement on close');
assert.match(js, /let sawDone = false;/, 'Chat stream should explicitly track the [DONE] sentinel');
assert.match(js, /type: 'incomplete'/, 'Chat stream EOF without [DONE] should emit an incomplete event');
assert.match(js, /stream ended before data: \[DONE\]/, 'Incomplete chat responses should expose the missing SSE completion marker');
assert.match(js, /m\.finishReason === 'incomplete'[\s\S]*data-act': 'continue'/, 'Incomplete chat responses should offer Continue');
assert.match(js, /streamStatusDiagnostic\(lastFinishReason\)/, 'Incomplete chat responses should include /api/status diagnostics');
{
  const urls = sourceAdapterHelpers.adapterCandidateUrls(
    { url: 'https://codeberg.org/user/project', title: 'Repository' },
    'analizza stack, makefile, licenza e test'
  );
  assert.ok(urls.some((u) => /README\.md$/.test(u)), 'repo adapter should discover README candidates');
  assert.ok(urls.some((u) => /Makefile$/.test(u)), 'repo adapter should discover build-file candidates');
  assert.ok(urls.some((u) => /\/tests$/.test(u)), 'repo adapter should discover test-directory candidates');
}
{
  const urls = sourceAdapterHelpers.adapterCandidateUrls(
    { url: 'https://example.com', title: 'Example product' },
    'pricing features docs'
  );
  assert.ok(urls.includes('https://example.com/pricing'), 'product adapter should discover pricing');
  assert.ok(urls.includes('https://example.com/features'), 'product adapter should discover features');
  assert.ok(urls.includes('https://example.com/docs'), 'product adapter should discover docs');
}

assert.deepEqual(webResearchHelpers.explicitUserUrls('read https://github.com/sk8erboi17/DStudio, please'), ['https://github.com/sk8erboi17/DStudio']);
{
  const byUrl = new Map();
  const seeded = webResearchHelpers.seedExplicitUrlSources('read https://github.com/sk8erboi17/DStudio', byUrl);
  assert.equal(seeded.length, 1);
  assert.equal(seeded[0].explicit, true);
  assert.match(seeded[0].title, /Explicit URL/);
  const sources = [
    seeded[0],
    { title: 'DStudio docs', url: 'https://dstudioproject.github.io/', content: 'Unrelated homonym' },
  ];
  const readUrls = new Set(['https://github.com/sk8erboi17/dstudio']);
  assert.deepEqual(
    webResearchHelpers.selectableSourcesAfterExplicitRead('Analizza tecnicamente questa repo', {}, sources, readUrls),
    [seeded[0]]
  );
  assert.equal(
    webResearchHelpers.selectableSourcesAfterExplicitRead('Analizza competitors di questa repo', {}, sources, readUrls).length,
    2
  );
}

lanModeHelpers.setLanServed(true);
lanModeHelpers.setSettings({ lanClientHost: 'http://192.168.1.207:5500' });
assert.equal(lanModeHelpers.currentLanClientHost(), 'http://192.168.1.207:5500');
lanModeHelpers.setSettings({ lanClientHost: '' });
assert.equal(lanModeHelpers.currentLanClientHost(), 'http://192.168.1.93:5500');
lanModeHelpers.setLanServed(false);
assert.equal(lanModeHelpers.currentLanClientHost(), '');
lanModeHelpers.setStoredSettings({ lanClientHost: 'http://25.17.235.135:5500' });
assert.equal(lanModeHelpers.currentLanClientHost(), 'http://25.17.235.135:5500');

const originalFetch = globalThis.fetch;
try {
  let requested = '';
  globalThis.fetch = async (url) => {
    requested = String(url);
    return { ok: true, json: async () => ({ ok: true, app: 'DStudio' }) };
  };
  await healthHelpers.probeLanHost('http://192.168.1.207:5500/');
  assert.equal(requested, 'http://192.168.1.207:5500/api/lan-health');

  globalThis.fetch = async () => { throw new Error('closed'); };
  await assert.rejects(
    healthHelpers.probeLanHost('http://192.168.1.207:5500'),
    /Cannot reach/
  );

  globalThis.fetch = async () => ({ ok: true, json: async () => ({ ok: true, app: 'Other' }) });
  await assert.rejects(
    healthHelpers.probeLanHost('http://192.168.1.207:5500'),
    /not a DStudio LAN host/
  );
} finally {
  globalThis.fetch = originalFetch;
}

assert.match(js, /theme:\s*'light'/, 'default theme should stay light');
assert.doesNotMatch(html, /id="doctor-strip"/, 'system check strip should not be visible in the main chat UI');
assert.doesNotMatch(html, /doctor-strip|doctor-badge|doctor-fix/, 'system check strip CSS/classes should be removed');
assert.doesNotMatch(js, /renderStrip|doctor-strip|doctor-badge|doctor-fix/, 'Doctor should not render the removed status strip');
assert.doesNotMatch(html, /Model: ready|Agent: ready|Design: ready|Web: ready/, 'ready badges should not be visible in host or LAN UI');
assert.match(html, /id="doctor-dialog"/, 'manual System check dialog should remain available');
assert.match(html, /id="doctor-recheck"/, 'manual System check dialog should keep Recheck');
assert.match(html, /id="doctor-detail"/, 'System check dialog should include workspace diagnostics details');
assert.match(html, /id="conn-info"[\s\S]*>Info<\/button>/, 'Server unreachable state should expose an explicit diagnostics Info button');
assert.match(js, /function openConnectionInfo\(e\)[\s\S]*Doctor\.open\(\)/, 'Connection Info button should open diagnostics instead of leaving users with a bare unreachable label');
assert.match(js, /async function diagnostics\(\)[\s\S]*\/api\/diagnostics/, 'Engine client should expose workspace diagnostics');
assert.match(js, /async function updatesCheck\(\)[\s\S]*\/api\/updates\/check/, 'Engine client should expose Update Doctor checks');
assert.match(js, /async function updatesRun\(tasks\)[\s\S]*\/api\/updates\/run/, 'Engine client should expose selected Update Doctor runs');
assert.match(html, /class="field updates-panel"[\s\S]*updates-panel__title[\s\S]*updates-task-grid[\s\S]*id="updates-list" class="updates-list"/, 'Update Doctor settings should use the structured maintenance panel layout');
assert.match(html, /id="updates-progress-dialog"[\s\S]*id="updates-progress-bar"[\s\S]*id="updates-progress-current"[\s\S]*id="updates-progress-steps"/, 'Update Doctor should have a modal progress UI with current action and task list');
assert.match(html, /Fetch ds4 upstream, then verify managed tools, templates, patch gates, skills and Open Design imports/, 'Update Doctor should describe which checks are real upstream fetches versus local verification');
assert.match(html, /id="updates-check"[\s\S]*>Check<\/button>[\s\S]*id="updates-run"[\s\S]*>Update \/ verify selected<\/button>/, 'Update Doctor should keep compact primary actions with honest update/verify wording');
assert.match(js, /function renderUpdates\(res\)[\s\S]*updates-badge--\$\{state\}[\s\S]*updates-row__label[\s\S]*updates-row__detail/, 'Update Doctor should render status rows with badges instead of freeform text');
assert.match(js, /async function openUpdatesProgress\(tasks\)[\s\S]*updatesProgressDialog[\s\S]*showModal/, 'Update Doctor should open a dedicated progress modal before running selected tasks');
assert.match(js, /for \(let i = 0; i < tasks\.length; i\+\+\)[\s\S]*Engine\.updatesRun\(\[task\]\)[\s\S]*markUpdatesProgressStep/, 'Update Doctor should run selected updates one task at a time so progress is visible');
assert.match(js, /async function tasks\(limit = 50\)[\s\S]*\/api\/tasks\?limit=/, 'Engine client should expose task summaries');
assert.match(js, /async function task\(id\)[\s\S]*\/api\/task\?id=/, 'Engine client should expose task detail lookup');
assert.match(js, /async function logs\(limit = 200\)[\s\S]*\/api\/logs\?limit=/, 'Engine client should expose recent logs');
assert.match(js, /Engine\.diagnostics\(\)/, 'Doctor should fetch workspace diagnostics');
assert.match(js, /function renderDiagnostics\(diag\)/, 'Doctor should render diagnostics instead of hiding backend state');
assert.match(js, /Recent diagnostics/, 'Doctor diagnostics section should label recent task and log failures');
assert.match(launcher, /#define CYBER_SKILLS_REL_DIR "extension\/gsa\/third_party\/anthropic-cybersecurity-skills\/skills"/, 'GSA should pin the vendored cybersecurity skills catalog path');
assert.match(launcher, /DS4UI_CYBER_SKILLS_DIR/, 'agent/design child processes should receive the vendored cybersecurity skills dir');
assert.match(launcher, /full catalog is[\s\S]*not injected into this prompt to keep Agent startup responsive/, 'Agent startup should not dump the vendored cybersecurity skill catalog into the system prompt');
assert.ok(Number(jsonlPatch.values.get('version')) >= 25, 'JSONL patch version should force rebuild after Agent web auto-approval changes');
assert.match(jsonlPatch.text, /--web-tool[\s\S]*google_search[\s\S]*visit_page/, 'JSONL agent should expose Search-backed google_search and visit_page helpers');
assert.match(jsonlPatch.text, /if \(w->cfg->non_interactive\)[\s\S]*return 1; \/\*DS4UI_JSONL: DStudio Agent web search is a managed read-only helper/, 'Agent native web tools should auto-approve managed Chrome startup in non-interactive DStudio mode');
assert.match(jsonlPatch.text, /Chrome startup is handled automatically by the managed read-only web helper/, 'Agent web prompt should not tell the model to wait for interactive Chrome approval in DStudio');
assert.match(launcher, /## AGENT WEB RESEARCH[\s\S]*same local DStudio Search\/Deep Research browser helper[\s\S]*user explicitly asks[\s\S]*when you are uncertain[\s\S]*visit_page[\s\S]*primary sources/, 'Agent runtime prompt should tell the model when to use DStudio Search-backed web tools');
assert.match(launcher, /patch_dir_newer_than\(JSONL_PATCH_DIR, bb\.st_mtime\)/, 'JSONL runtime rebuild should notice changed patch files, not only ds4 source mtimes');
assert.match(launcher, /patch_dir_newer_than\(WEB_CDP_PATCH_DIR, bb\.st_mtime\)/, 'JSONL runtime rebuild should notice changed web helper patch files');
assert.match(launcher, /patch_dir_newer_than\(WEB_DIRECT_NAV_PATCH_DIR, bb\.st_mtime\)/, 'JSONL runtime rebuild should notice changed direct-navigation patch files');
assert.match(launcher, /static void api_skills_search\(int fd, const char \*path\)/, 'backend should expose searchable skill metadata');
assert.match(launcher, /path_eq_clean\(path, "\/api\/skills\/search"\)/, 'router should serve /api/skills/search');
assert.match(launcher, /static int read_request_body_alloc\(int fd, const char \*req, size_t got, size_t header_len/, 'router should share bounded request-body reading instead of duplicating recv loops');
assert.match(launcher, /static int route_post_api\(int fd, const char \*path, const char \*body\)/, 'POST API dispatch should stay outside handle_connection');
assert.match(launcher, /static int route_get_or_static\(int fd, const char \*method, const char \*path, int head_only\)/, 'GET/static dispatch should stay outside handle_connection');
assert.match(handleConnectionSource, /read_request_body_alloc\(fd, req, got, header_len/, 'handle_connection should use the shared body reader');
assert.match(handleConnectionSource, /status = route_post_api\(fd, path, body\)/, 'handle_connection should delegate POST API dispatch');
assert.match(handleConnectionSource, /status = route_get_or_static\(fd, method, path, head_only\)/, 'handle_connection should delegate GET/static dispatch');
assert.match(launcher, /#include "\.\.\/extension\/gsa\/dstudio_gsa\.cfrag"/, 'launcher should include the GSA extension runtime');
assert.match(gsaRuntime, /static void api_gsa_start\(int fd, const char \*body\)/, 'backend should expose GSA start');
assert.match(gsaRuntimeSource, /static int gsa_start_parse_request/, 'GSA start should keep request parsing in a helper');
assert.match(gsaRuntimeSource, /static int gsa_start_write_target_artifact/, 'GSA start should keep target artifact rendering in a helper');
assert.match(gsaRuntimeSource, /static int gsa_start_prepare_automation_artifacts/, 'GSA start should keep automation artifact preparation in a helper');
assert.match(gsaRuntimeSource, /static int gsa_start_build_response/, 'GSA start should keep response assembly in a helper');
assert.match(gsaRuntime, /static void api_gsa_tools\(int fd\)/, 'backend should expose GSA tool status');
assert.match(gsaRuntime, /static void api_gsa_tools_install\(int fd\)/, 'backend should expose managed GSA tool install');
assert.match(launcher, /path_eq_clean\(path, "\/api\/gsa\/tools"\)/, 'router should serve /api/gsa/tools');
assert.match(launcher, /\/api\/gsa\/tools\/install/, 'router should serve /api/gsa/tools/install');
assert.ok(Array.isArray(gsaToolCatalog.tools), 'GSA tool catalog should be a JSON tools array');
assert.ok(gsaToolCatalog.tools.length >= 30, 'GSA tool catalog should keep the managed tool set in JSON');
assert.ok(gsaToolCatalog.tools.every((tool) => tool.name && tool.category && tool.aliases && tool.install && tool.notes), 'Every GSA tool catalog entry should carry required fields');
assert.match(gsaRuntimeSource, /static int gsa_load_tool_catalog/, 'GSA runtime should load the tool catalog from JSON');
assert.doesNotMatch(gsaRuntimeSource, /GSA_TOOL_SPECS/, 'GSA runtime should not keep the old compiled-in tool catalog');
assert.match(gsaRuntime, /mode\\":\\"tool-assisted/, 'GSA tool status should explicitly be tool-assisted');
assert.match(gsaRuntime, /externalToolsRequired\\":false/, 'GSA should not require external recon tools');
assert.doesNotMatch(gsaRuntime, /flashcards\/gsa-tools|LOCALAPPDATA.*gsa-tools/s, 'GSA managed tools should not install into the old shared app-data directory');
assert.match(gsaRuntime, /extension[\\/]gsa[\\/]tools[\\/]bin/, 'GSA managed tools should live under extension/gsa/tools/bin');
assert.match(gsaRuntime, /static const char \*gsa_tool_install_mode/, 'GSA should classify tool installer families');
assert.match(gsaRuntime, /missingInstaller/, 'GSA tool status should explain missing installer prerequisites');
assert.match(gsaRuntime, /notInstallable/, 'GSA tool status should count tools blocked by missing prerequisites');
assert.match(gsaRuntime, /Go is not installed; cannot install Go-based GSA tools/, 'GSA install scripts should fail loudly when Go-based managed tools cannot be installed');
assert.match(gsaRuntime, /Python 3 or pipx is not installed; cannot install Python-based GSA tools/, 'GSA install scripts should fail loudly when Python-based managed tools cannot be installed');
assert.match(gsaRuntime, /Installer failed\. Missing required managed tools\/data:[\s\S]*exit 1/, 'GSA install scripts should exit non-zero when managed tools or required data packs are missing');
assert.match(gsaRuntime, /export PATH="\$BIN:\/opt\/homebrew\/bin:\/usr\/local\/bin:\/usr\/bin:\/bin:\/usr\/sbin:\/sbin:\$\{PATH:-\}"/, 'GSA shell installer should see Homebrew and system toolchains when launched from the macOS app environment');
assert.match(gsaRuntime, /ensure_brew_tool "Go" "go" "go"[\s\S]*brew install "\$brew_pkg"/, 'GSA shell installer should install Go through Homebrew when Homebrew exists');
assert.match(gsaRuntime, /github\.com\/projectdiscovery\/subfinder/, 'GSA should include ProjectDiscovery subfinder support');
assert.match(gsaRuntime, /github\.com\/projectdiscovery\/nuclei/, 'GSA should include ProjectDiscovery nuclei support');
assert.match(gsaRuntime, /NUCLEI_TEMPLATES_DIR[\s\S]*-update-templates[\s\S]*-update-template-dir/, 'GSA tool installer should install/update managed nuclei templates');
assert.match(gsaRuntime, /projectdiscovery\/nuclei-templates[\s\S]*nuclei templates were not found after update[\s\S]*fail/, 'GSA nuclei template materialization should be explicit and fail when templates remain absent');
assert.match(gsaRuntime, /Installing\/validating system GSA tools[\s\S]*ensure_system_tool "trivy"/, 'GSA shell installer should install or validate declared system tools instead of leaving them manual');
assert.match(gsaRuntime, /Installing\/validating system GSA tools[\s\S]*Ensure-SystemTool 'trivy'/, 'GSA PowerShell installer should install or validate declared system tools instead of leaving them manual');
assert.match(gsaRuntime, /brew install[\s\S]*Homebrew package/, 'GSA tool installer should use Homebrew for missing system tools on macOS');
assert.match(gsaRuntime, /apt-get update[\s\S]*apt-get install -y/, 'GSA tool installer should use apt-get for missing system tools on Linux');
assert.match(gsaRuntime, /TRIVY_CACHE_DIR[\s\S]*--download-db-only[\s\S]*--download-java-db-only/, 'GSA tool installer should prefetch Trivy vulnerability databases when Trivy is installed');
assert.match(gsaRuntime, /GRYPE_DB_CACHE_DIR[\s\S]*grype[\s\S]*db update/, 'GSA tool installer should prefetch Grype vulnerability database when Grype is installed');
assert.match(gsaRuntime, /refreshing managed pipx venv[\s\S]*rm -rf[\s\S]*pipx install --force/, 'GSA tool installer should refresh managed pipx venvs before reinstalling Python tools');
assert.match(gsaRuntime, /PIP_CONSTRAINT[\s\S]*setuptools<81[\s\S]*pip install --upgrade pip "setuptools<81" wheel/, 'GSA Python installer should pin setuptools for legacy packages such as dtfabric/plaso');
assert.doesNotMatch(gsaRuntime, /Manual\/system tools still need OS packages|skipping trivy DB prefetch|skipping grype DB prefetch/, 'GSA installer should not keep silent manual-tool skips');
assert.match(gsaRuntime, /templatesDir[\s\S]*templatesFound[\s\S]*templateHint/, 'GSA tool status should expose nuclei template directory and readiness');
assert.match(gsaRuntime, /Do not pass guessed labels such as `xss`[\s\S]*to `nuclei -t`[\s\S]*Use `-tags`, `-id`, or explicit template paths/, 'GSA prompt policy should prevent invalid guessed nuclei template labels');
assert.match(gsaRuntime, /no templates provided for scan[\s\S]*retry the same nuclei task with a known valid tag\/path/, 'GSA nuclei policy should treat zero-template scans as same-tool argument failures');
assert.match(gsaRuntime, /For technology detection[\s\S]*-tags tech[\s\S]*http\/technologies[\s\S]*not `-tags tech-detect`/, 'GSA nuclei policy should use the valid tech tag or technologies path instead of tech-detect');
assert.match(gsaRuntime, /github\.com\/tomnomnom\/assetfinder/, 'GSA should include assetfinder support');
assert.match(gsaRuntime, /static int gsa_write_cyber_skill_shortlist/, 'GSA should build its shortlist from imported cybersecurity skills');
assert.match(gsaRuntime, /static char \*gsa_workspace_signals\(const char \*workdir, const char \*candidates_path\)/, 'GSA should rank imported skills with bounded workspace signals');
assert.match(gsaRuntime, /json_get_string\(body, "targetUrl", req->target_url/, 'GSA start should accept an optional authorized target URL');
assert.match(gsaRuntime, /gsa_extract_first_url\(req->mission, req->target_url/, 'GSA start should infer an explicit URL from the mission when the target field is empty');
assert.match(gsaRuntime, /gsa_target_url_ok\(req->target_url/, 'GSA start should validate target URLs before writing artifacts');
assert.match(gsaRuntime, /target_hits=%d, workspace_hits=%d/, 'GSA skill shortlist should explain target/workspace ranking signals');
assert.match(gsaRuntime, /target\.md/, 'GSA should write a target artifact for the agent to read');
assert.match(gsaRuntime, /toolStatus\.json/, 'GSA should write tool status into the run directory');
assert.match(gsaRuntimeSource, /gsa_render_template\("templates\/tool-retry-policy\.md"/, 'GSA should render the reusable external-tool retry policy from a template');
assert.doesNotMatch(gsaRuntimeSource, /static const char GSA_TOOL_RETRY_POLICY_MD/, 'GSA retry policy should no longer be embedded as a long C string');
assert.match(gsaRuntime, /applies to every enabled tool in `toolStatus\.json`/, 'GSA tool retry policy should apply to every enabled tool, not just httpx');
assert.match(gsaRuntime, /Do not degrade from any selected tool to curl, wget, Python requests/, 'GSA tool retry policy should forbid broad tool-to-curl degradation on invocation errors');
assert.match(gsaRuntime, /A timeout is still a selected-tool failure[\s\S]*retry the same tool with a corrected bounded invocation/, 'GSA tool retry policy should require same-tool timeout retries before fallback');
assert.match(gsaRuntime, /If `nuclei` times out[\s\S]*do not jump directly to Playwright[\s\S]*If `sqlmap` times out/, 'GSA timeout retry policy should cover nuclei and sqlmap specifically');
assert.match(gsaRuntime, /tool-retry-ledger\.jsonl/, 'GSA should track same-tool retry attempts in a ledger artifact');
assert.match(gsaRuntime, /inspect that same tool'?s (?:local )?help[\s\S]*retry that same tool|inspect the same tool help[\s\S]*retry that same tool/, 'GSA should require same-tool help inspection and retry before fallback');
assert.match(gsaRuntime, /semgrep[\s\S]*trivy[\s\S]*plaso[\s\S]*nmap[\s\S]*jq/, 'GSA same-tool retry policy should cover code, dependency, forensic, network and utility tools');
assert.match(gsaRuntimeSource, /gsa_render_template\("templates\/workbench\.md"/, 'GSA should render the shared Evidence Workbench guide from a template');
assert.doesNotMatch(gsaRuntimeSource, /static const char GSA_WORKBENCH_MD/, 'GSA workbench guide should no longer be embedded as a long C string');
assert.match(gsaRuntimeSource, /gsa_render_install_template\("templates\/install-gsa-tools\.sh"/, 'GSA should render the shell installer from a template');
assert.match(gsaRuntimeSource, /gsa_render_install_template\("templates\/install-gsa-tools\.ps1"/, 'GSA should render the PowerShell installer from a template');
assert.doesNotMatch(gsaRuntimeSource, /json_dyn_puts\(&sh|json_dyn_puts\(&ps/, 'GSA installers should no longer be embedded as long json_dyn_puts C strings');
assert.match(gsaRuntime, /gsa_write_workbench_artifacts/, 'GSA should seed Evidence Workbench artifacts for each run');
assert.match(gsaRuntime, /workbench-web\.jsonl[\s\S]*workbench-network\.jsonl[\s\S]*workbench-forensics\.jsonl[\s\S]*workbench-reverse\.jsonl[\s\S]*workbench-code\.jsonl[\s\S]*workbench-infra\.jsonl/, 'GSA workbench should cover web, network, forensics, reverse, code and infra domains');
assert.match(gsaRuntime, /workbench-blue\.jsonl[\s\S]*workbench-red\.jsonl[\s\S]*workbench-purple\.jsonl[\s\S]*workbench-blackhat\.jsonl/, 'GSA workbench should include blue, red, purple and black-hat artifacts');
assert.match(gsaRuntime, /static int gsa_execute_validation_plan[\s\S]*validation-plan\.json[\s\S]*validation-results\.json[\s\S]*evidence-graph\.json/, 'GSA should have a backend validation executor with first-class plan/results/graph artifacts');
assert.match(gsaRuntime, /semgrep_scan[\s\S]*http_probe[\s\S]*playwright_flow/, 'GSA validation executor should expose Semgrep, HTTP and Playwright adapters');
assert.match(gsaRuntime, /gsa_execute_validation_plan\(run_dir, abs, output/, 'GSA should execute the validation plan automatically after preflight is saved');
assert.match(gsaRuntime, /Backend validation-results\.json[\s\S]*Backend evidence-graph\.json/, 'GSA validation prompt should inline backend executor artifacts');
assert.match(gsaRuntime, /gsa_write_scope_safety_artifacts[\s\S]*scope\.json[\s\S]*safety-gate\.json/, 'GSA should seed scope and safety gate artifacts for gated profiles');
assert.match(gsaRuntime, /black-hat[\s\S]*does not generate or enforce [` ]*scope\.json[\s\S]*safety-gate\.json/, 'GSA should treat black-hat as ungated full-surface internal mode');
assert.match(gsaRuntime, /run_state\.json/, 'GSA should write explicit run lifecycle state');
assert.match(gsaRuntime, /scripts_manifest\.json/, 'GSA should track Python helper lifecycle');
assert.match(gsaRuntime, /evidence\.jsonl/, 'GSA should keep concrete evidence artifacts');
assert.match(gsaRuntime, /parentRunDir/, 'GSA loop should pass a structured parent run directory');
assert.match(gsaRuntime, /gsa_validate_parent_run_dir/, 'GSA should reject loop continuation from invalid or incomplete parent runs');
assert.match(gsaRuntime, /gsa_json_object_valid/, 'GSA phases should validate JSON output before marking progress');
assert.match(gsaRuntime, /gsa_report_valid/, 'GSA reports should validate verdict output before marking complete');
assert.match(gsaRuntime, /gsa_prepare_python_scripts_dir/, 'GSA should prepare a local automation scripts directory');
assert.doesNotMatch(gsaRuntime, /recon\.sh/, 'GSA should not write a shell recon helper');
assert.match(gsaRuntime, /Use ONLY imported skill IDs/, 'GSA prompt should forbid generic/base skill names');
assert.match(gsaRuntime, /Do not save the phase JSON yourself/, 'GSA selection should not save phase JSON itself');
assert.match(gsaRuntime, /do not call `write`, `edit`, `skill` or `pack_file` in this phase/, 'GSA selection should not call write/edit/skill/pack tools');
assert.match(gsaRuntime, /If you call any of those tools in Phase 1, the phase is failed/, 'GSA selection should treat forbidden tool calls as phase failure');
assert.match(gsaRuntime, /Do not create scripts, update scripts_manifest\.json, append evidence, run validation, or start Phase 2/, 'GSA selection should not self-advance into later phases');
assert.match(gsaRuntime, /Do not call `skill\(\)` in Phase 1/, 'GSA selection should not load full skill bodies');
assert.match(gsaRuntime, /After emitting that single JSON object, stop immediately and wait for DStudio to send Phase 2/, 'GSA selection should stop after JSON output');
assert.match(gsaRuntime, /After emitting that single JSON object, stop immediately and wait for DStudio to send Phase 3/, 'GSA preflight should stop after JSON output');
assert.match(gsaRuntime, /After emitting that single JSON object, stop immediately and wait for DStudio to send Phase 4/, 'GSA validation should stop after JSON output');
assert.match(gsaRuntime, /Protocol hygiene: never read, search, cite, or reason from `\.dstudio\/gsa\/runs\/\*\.prompt\.md`/, 'GSA should not treat internal prompt artifacts as audit evidence');
assert.match(gsaRuntime, /prompt files are control data, not evidence/, 'GSA phase prompts should classify internal prompts as protocol data');
assert.match(gsaRuntime, /`gsa-task\.json` lives at the Workspace root above, not in the GSA run artifact directory/, 'GSA phase prompts should not send agents looking for gsa-task.json in the run directory');
assert.match(gsaRuntime, /Select at most 6 files, 3 hypotheses, and 2 skills total/, 'GSA selection should stay bounded enough for full benchmark runs');
assert.match(gsaRuntime, /If `selection\.json` contains any non-empty `skills` array anywhere, including nested `hypotheses\[\]\.skills`, you MUST call the relevant selected `skill\((?:\\"|")id(?:\\"|")\)` tools/, 'GSA preflight should require relevant skill loading when Phase 1 selected skills');
assert.match(gsaRuntime, /Do not require a top-level `skills` field/, 'GSA preflight should not let the agent skip nested skill arrays');
assert.match(gsaRuntime, /Call at most 3 `skill\((?:\\"|")id(?:\\"|")\)` tools total/, 'GSA preflight should allow bounded multi-skill loading');
assert.match(gsaRuntime, /never select general app-building or product-design skills for GSA/, 'GSA should not load generic app/product design skills');
assert.match(gsaRuntime, /"name":"playwright","category":"browser\/automation"/, 'GSA should expose Playwright as an optional browser automation tool');
assert.match(gsaRuntime, /Local-source exception: for exported cryptographic, token, signature, serializer, parser, or policy primitives/, 'GSA should not require server routes for exported primitive defects in local source reviews');
assert.match(gsaRuntime, /missing service wiring belongs in `missing_evidence`, not automatic kill criteria/, 'GSA should carry missing service wiring as a limitation for exported primitive findings');
assert.match(gsaRuntime, /authorized-local-source-review[\s\S]*exported public API is the reviewed trust boundary/, 'GSA should treat exported package APIs as the local trust boundary in source reviews');
assert.match(gsaRuntime, /For cryptographic or signature reviews, prioritize sign\/verify\/envelope\/key-registry\/policy\/canonicalization files/, 'GSA selection should prioritize crypto/signature control files');
assert.match(gsaRuntime, /For crypto\/signature hypotheses, explicitly map: tag comparison control, caller-controlled key material\/reference, registry binding, deterministic nonce\/replay policy, canonicalization, and relevant audit\/config policy/, 'GSA preflight should map crypto controls and gaps generically');
assert.match(gsaRuntime, /For crypto\/signature validation, check and cite each relevant control or gap: constant-time tag comparison, key material versus key reference/, 'GSA validation should check crypto controls without assuming the defect');
assert.match(gsaRuntime, /preserve the finding at medium\/high confidence/, 'GSA validation should not downgrade exported primitive findings solely for missing production wiring');
assert.doesNotMatch(gsaBenchRunner, /function (?:validationRepairPrompt|reportRepairPrompt|reportOverconfirmRepairPrompt|selectionRepairPrompt|selectionFinalizePrompt|selectionEvidencePrompt|preflightFinalizePrompt|validationFinalizePrompt)\(/, 'GSA benchmark runner should not keep hidden repair/finalize prompt stages');
assert.doesNotMatch(gsaBenchRunner, /sendAgentTurnWithRetry|findingHasExportedPrimitiveEvidence|validationImpliesConfirmedIssue|validationBlocksConfirmedIssue|validationMayHaveArtifactReachabilityConflict/, 'GSA benchmark runner should not duplicate verdict policy with local heuristic guardrails');
assert.match(gsaBenchRunner, /async function restartAgentRuntime\(baseUrl, launchBody\)[\s\S]*await stopAgentRuntime\(baseUrl\)[\s\S]*await startMode\(baseUrl, launchBody, 30 \* 60_000\)/, 'GSA benchmark should restart the runtime cleanly for each case');
assert.match(gsaBenchRunner, /await restartAgentRuntime\(baseUrl, opts\.launchBody\)/, 'GSA benchmark cases should launch from a fresh runtime');
assert.match(gsaBenchRunner, /await stopAgentRuntime\(baseUrl\)/, 'GSA benchmark should stop the runtime after each case');
assert.match(gsaRuntime, /Do not copy their body, glossary or examples into your answer/i, 'GSA preflight should not echo full skill content');
assert.match(gsaRuntime, /Do not create or run scripts in this preflight phase/, 'GSA preflight should not spend budget running helpers');
assert.match(gsaRuntime, /Phase 3 owns execution/, 'GSA should defer helper execution to validation');
assert.match(gsaRuntime, /make at most one repair attempt/, 'GSA helper scripts should not loop on path repair');
assert.match(gsaRuntime, /Do not use `edit` on evidence\.jsonl; append only/, 'GSA validation should preserve append-only evidence');
assert.match(gsaRuntime, /Add at most 6 new evidence lines/, 'GSA validation should bound evidence growth');
assert.match(gsaRuntime, /Use the inline artifacts below/, 'GSA report prompt should inline phase artifacts instead of forcing tool reads');
assert.match(gsaRuntime, /Do not call `read`, `write`, `edit`, `run`, or `skill` in this report phase/, 'GSA report should not trigger tool churn');
assert.match(gsaRuntime, /Keep the report under 900 words/, 'GSA report should stay compact');
assert.match(gsaRuntime, /gsa_append_run_file_excerpt\(&p, run_dir, "validation\.json"/, 'GSA report prompt should include validation inline');
assert.match(gsaRuntime, /gsa_append_run_file_excerpt\(&p, run_dir, "evidence\.jsonl"/, 'GSA report prompt should include evidence inline');
assert.match(gsaBenchRunner, /--think <ignored>[\s\S]*GSA always uses thinking=max/, 'GSA benchmark CLI should document that GSA thinking is not configurable');
assert.match(gsaBenchRunner, /--cases <id,id,\.\.\.>/, 'GSA benchmark should support rerunning a targeted comma-separated case set');
assert.match(gsaBenchRunner, /--failures-from <dir>/, 'GSA benchmark should support checkpoint reruns from previous failures');
assert.match(gsaBenchRunner, /--list-cases/, 'GSA benchmark should expose a dry case-selection mode for checkpoint planning');
assert.match(gsaBenchRunner, /for \(const item of items\) console\.log\(item\.id\)/, 'GSA benchmark list-cases should print selected ids without launching the model');
assert.match(gsaBenchRunner, /function failureCaseIdsFromRun\(value\)/, 'GSA benchmark should derive failed case ids from benchmark artifacts');
assert.match(gsaBenchRunner, /row\.outcomeCorrect !== "true"/, 'GSA benchmark failure reruns should use scorer outcome correctness, not hardcoded case names');
assert.match(gsaBenchRunner, /unknown benchmark case id\(s\)/, 'GSA benchmark should reject mistyped targeted case ids before launching the model');
assert.match(gsaBenchRunner, /function phaseThinkLevel\(_phase, _opts\)[\s\S]*return "max"/, 'GSA benchmark should force thinking max for every phase');
assert.match(gsaBenchRunner, /const think = "max"/, 'GSA benchmark launch should force the agent runtime to thinking max');
assert.match(gsaBenchRunner, /phase \${phase} JSON captured[\s\S]*return raw/, 'GSA benchmark should leave a phase as soon as complete phase JSON is captured');
assert.match(gsaBenchRunner, /`\$\{phase\}\.raw\.live\.txt`/, 'GSA benchmark should save live raw transcript snapshots for interrupted phases');
assert.match(gsaBenchRunner, /raw\.length - lastLiveWriteBytes > 4096/, 'GSA benchmark live transcript snapshots should update during long streaming phases');
assert.doesNotMatch(gsaBenchRunner, /phase === "selection" \|\| phase === "report"[\s\S]*return "off"/, 'GSA benchmark must not disable thinking for selection/report phases');
assert.match(gsaBenchRunner, /function phaseTimeoutMs\(_phase, opts\)[\s\S]*const base = Number\(opts\.turnTimeoutMs \|\| 30 \* 60 \* 1000\)[\s\S]*return base/, 'GSA benchmark should let --timeout-min govern every phase when thinking max is enabled');
assert.doesNotMatch(gsaBenchRunner, /"selection-finalize":\s*2 \* 60 \* 1000/, 'GSA benchmark must not keep short finalize caps under thinking max');
assert.match(gsaBenchRunner, /const maxRawBytes = opts\.maxRawBytes \|\| \(thinkLevel === "max" \? 320_000 : 70_000\)/, 'GSA benchmark should respect per-phase transcript budgets and keep a high default for unbounded thinking max phases');
assert.match(gsaBenchRunner, /function selectionSkillIds\(jsonText\)/, 'GSA benchmark should parse skills selected in Phase 1');
assert.match(gsaBenchRunner, /preflight did not load a selected GSA skill/, 'GSA benchmark should fail when selected skill routing is skipped');
assert.match(gsaBenchRunner, /input\.name \|\| input\.id/, 'GSA benchmark should record skill tool calls that pass id instead of name');
assert.match(gsaBenchRunner, /const phaseOrder = \["selection", "preflight", "validation"\]/, 'GSA benchmark should run the three JSON phases as a simple linear sequence');
assert.match(gsaBenchRunner, /const raw = await sendAgentTurn\(/, 'GSA benchmark should use one agent turn per JSON phase');
assert.doesNotMatch(gsaBenchRunner, /selectionEvidencePass|selectionRepair|validationRepair|reportRepair|selectionFinalize/, 'GSA benchmark should not keep hidden benchmark-only repair passes');
assert.match(gsaBenchRunner, /A missing external command is not a hard failure/, 'GSA benchmark mission should match runtime behavior for missing optional tools');
assert.match(gsaBenchRunner, /clean or empty scanner result is never proof of safety/, 'GSA benchmark mission should not let scanners decide safety without manual evidence');
assert.match(gsaBenchRunner, /A positive scanner result is not enough by itself either/, 'GSA benchmark mission should require reachability evidence for positive scanner output');
assert.match(gsaBenchRunner, /script or external command remains only planned/, 'GSA benchmark mission should not count planned automation as validation evidence');
assert.doesNotMatch(gsaBenchRunner, /phaseThinkLevel\("(?:selection-evidence|selection-repair|selection-finalize|preflight-finalize|validation-repair|validation-finalize|report-repair)"/, 'GSA benchmark should not allocate thinking budgets to removed repair/finalize phases');
assert.match(gsaBenchRunner, /JSON\.stringify\(\{ type: "control", name: "think", value \}\)/, 'GSA benchmark should send per-turn think control frames');
assert.match(gsaBenchRunner, /thinkControl\("max"\)/, 'GSA benchmark should send thinking max in every agent turn');
assert.match(gsaBenchRunner, /function interruptStatusForReason\(reason\)/, 'GSA benchmark should classify technical interrupts');
assert.match(gsaBenchRunner, /JSON\.stringify\(\{ reason, status: finalStatus \}\)/, 'GSA benchmark should send interrupt reason and terminal status to the backend');
assert.match(gsaBenchRunner, /resetting agent session before next GSA phase/, 'GSA benchmark should close active turns explicitly before resetting sessions');
assert.match(gsaBenchRunner, /function normalizeSelectionJson\(jsonText, workspace, caseDir, manifest\)/, 'GSA benchmark should normalize selected paths before saving selection');
assert.match(gsaBenchRunner, /rel = rel\.replace\(\/\^workspace\\\/\+\/, ""\);/, 'GSA benchmark should strip accidental workspace/ prefixes from selected paths');
assert.match(gsaBenchRunner, /path\.posix\.basename\(c\) === base/, 'GSA benchmark should recover selected files by unique basename');
assert.match(gsaRuntime, /\\"targetUrl\\":\\"%s\\"[\s\S]*\\"think\\":\\"max\\"/, 'GSA start API should declare thinking max as the GSA contract');
assert.match(launcher, /static int display_prompt_is_guided_analysis\(const char \*display\)/, 'Agent send endpoint should detect guided GSA/RSA display prompts');
assert.match(launcher, /gsa_think_max_frame\[\][\s\S]*"value\\":\\"max\\"/, 'Agent send endpoint should have a GSA thinking max control frame');
assert.match(launcher, /force_gsa_think_max[\s\S]*fd_write_all\(g_in_fd, gsa_think_max_frame/, 'Agent send endpoint should prepend thinking max for GSA turns');
assert.match(js, /async function skillsSearch\(params = \{\}\)[\s\S]*\/api\/skills\/search/, 'Engine client should expose skill search');
assert.match(launcher, /static void api_skill_get\(int fd, const char \*path\)/, 'Backend should expose a skill body reader for local overrides');
assert.match(launcher, /path_eq_clean\(path, "\/api\/skills\/search"\)[\s\S]*\/api\/skills\/get/, 'Router should serve /api/skills/get before the catalog endpoint');
assert.match(js, /async function skillGet\(id\)[\s\S]*\/api\/skills\/get\?id=/, 'Engine client should expose skill body loading');
assert.match(js, /async function gsaStart\(workdir, mission, targetUrl = '', parentRunDir = '', disabledTools = '', profile = 'passive', authorized = false\)[\s\S]*JSON\.stringify\(\{ workdir, mission, targetUrl, parentRunDir, disabledTools, profile, authorized: !!authorized \}\)/, 'Engine client should send target URL, parent GSA run, disabled tools and security profile context');
assert.match(js, /Store\.setSettings\(\{ gsaMode: 'off', rsaMode: 'off', thinkLevel: 'max' \}\)/, 'Starting GSA should force the visible thinking state to max and clear RSA');
assert.match(js, /AgentView\.send\(res\.prompt,[\s\S]*\{ forceThink: 'max' \}\)/, 'GSA turns should force runtime thinking max');
assert.match(js, /function wirePromptForRuntime\(prompt, forceThink = ''\)[\s\S]*runtimeThinkControlFrame\(forceThink\) \+ prompt/, 'Runtime prompt wiring should support forced thinking for GSA');
assert.match(js, /Store\.setSettings\(\{ gsaMode: v,[\s\S]*thinkLevel: 'max'/, 'Enabling GSA should move the composer thinking pill to max');
assert.match(js, /Guided analysis always runs with Thinking: max/, 'Thinking selector should reject lowering guided analysis below max');
assert.match(js, /async function gsaTools\(\)[\s\S]*\/api\/gsa\/tools/, 'Engine client should expose GSA tool status');
assert.match(js, /async function gsaToolsInstall\(\)[\s\S]*\/api\/gsa\/tools\/install/, 'Engine client should expose managed GSA tool install');
assert.match(js, /\/gsa\s/, 'composer should expose the GSA slash command');
assert.match(html, /id="gsa-target-panel"[\s\S]*id="gsa-target-url"/, 'Agent composer should expose an optional GSA target URL field');
assert.match(js, /gsaTargetUrl: ''/, 'GSA target URL should be persisted as an explicit setting');
assert.match(js, /gsaLoop: 'off'/, 'GSA loop should be persisted as an explicit off/on setting');
assert.match(js, /gsaDisabledTools: \[\]/, 'GSA disabled tool choices should persist in settings');
assert.match(js, /enginePower: 90/, 'Engine power should default to ds4 --power 90');
assert.match(js, /ssdStreaming: 'auto'/, 'SSD streaming should default to automatic memory-pressure handling');
assert.match(js, /const launchBase = \(\) => \(\{ ctx: ctxSize\(\), power: enginePower\(\), ssdStreaming: ssdStreaming\(\) \}\)/, 'Engine starts should share persisted power and SSD streaming settings');
assert.doesNotMatch(js, /power: 100/, 'Engine launch should not hardcode --power 100');
assert.match(js, /function renderGsaTargetPanel\(\)[\s\S]*curMode === 'agent' && Store\.getSettings\(\)\.gsaMode === 'on'/, 'GSA target field should only appear for armed Agent turns');
assert.match(js, /Engine\.gsaStart\(workdir, mission, targetUrl, '', gsaDisabledToolsPayload\(\), securityProfileValue\(\), securityAuthorizedValue\(\)\)/, 'GSA command should pass target URL, disabled tools and security profile context through to the backend');
assert.match(js, /function renderGsaToolsPanel\(\)[\s\S]*Analysis automation[\s\S]*Open tools/, 'Composer plus menu should open shared analysis automation in a dedicated modal');
assert.match(html, /id="gsa-tools-dialog"[\s\S]*id="gsa-tools-dialog-grid"/, 'GSA tools should render in a modal grid instead of crowding the plus menu');
assert.match(html, /brief-gallery-panel[\s\S]*design-gallery-grid/, 'Design should expose an inline gallery section for visual starting points');
assert.match(html, /design-gallery-search[\s\S]*Search templates and systems/, 'Design gallery should expose an inline search field before the grid');
assert.match(js, /function designGalleryFilteredPresets\(\)[\s\S]*designGalleryQuery[\s\S]*toLowerCase\(\)/, 'Design gallery should filter templates and systems by search text');
assert.match(js, /new IntersectionObserver[\s\S]*frame\.dataset\.src[\s\S]*frame\.src = frame\.dataset\.src[\s\S]*iframe\[data-src\]/, 'Design gallery previews should mount iframes lazily to avoid scroll flashing');
assert.doesNotMatch(js, /Mythic Naturecore|SkyElite Private Jets|Casa Vellum/, 'Design gallery should not ship invented fallback presets');
assert.match(js, /DESIGN_GALLERY_LIMIT = 240/, 'Design gallery should not truncate the local design-system catalog to the old template-only count');
assert.match(js, /DESIGN_TEMPLATE_SOURCE = 'open-design\/'[\s\S]*hasExample[\s\S]*startsWith\(DESIGN_TEMPLATE_SOURCE\)/, 'Design gallery should include original Open Design template examples');
assert.match(js, /systemPresets = \(dsCache \|\| \[\]\)[\s\S]*designSystemId[\s\S]*\/api\/design-system-preview\/\$\{encodeURIComponent\(s\.id\)\}\/components\.html/, 'Design gallery should include local design systems through their original components.html previews');
assert.match(js, /Store\.setSettings\(\{ designSystem: preset\.designSystemId \}\)/, 'Selecting a design-system card should set the active design system for the next Design turn');
assert.match(js, /\/api\/skill-preview\/\$\{encodeURIComponent\(s\.id\)\}\/example\.html/, 'Design gallery previews should load original template examples through the backend');
assert.match(launcher, /preview_rel_asset_ok[\s\S]*\"css\"[\s\S]*\"js\"[\s\S]*\"woff2\"[\s\S]*\"mp4\"/, 'Backend preview route should allow original static assets required by template previews');
assert.match(launcher, /DESIGN_HEADERS[\s\S]*style-src 'self' 'unsafe-inline' https:[\s\S]*script-src 'self' 'unsafe-inline' https:[\s\S]*font-src 'self' data: https:/, 'Design preview CSP should allow original HTTPS-hosted template CSS, scripts and fonts');
assert.match(launcher, /api_skill_preview[\s\S]*ds4_upstream[\s\S]*open-design\//, 'Backend preview route should serve only original Open Design templates');
assert.match(launcher, /hasComponents/, 'Design-system catalog entries should report when components.html exists');
assert.match(launcher, /api_design_system_preview[\s\S]*extension\/design-systems[\s\S]*design_content_type/, 'Backend should serve original design-system preview files');
assert.match(launcher, /design_system_preview_rel_ok[\s\S]*preview_rel_asset_ok\(rel, "components\.html"\)/, 'Design-system preview route should allow local design-system preview assets without generated fallbacks');
assert.match(html, /id="design-preview-dialog"[\s\S]*id="design-preview-frame"/, 'Design cards should open a full preview modal');
assert.match(js, /function openDesignGalleryPreview\(preset\)[\s\S]*designPreviewFrame\.src = preset\.previewUrl/, 'Design preview modal should load the original preview URL');
assert.match(js, /function openDesignGallery\(\) \{[\s\S]*curMode === 'design' && AgentView\.openDesignGalleryInline[\s\S]*AgentView\.openDesignGalleryInline\(\)[\s\S]*return/, 'Design gallery should open inline from composer controls in Design mode');
assert.match(js, /curMode === 'design'[\s\S]*design-gallery-open[\s\S]*openDesignGallery\(\)/, 'Design plus menu should open the gallery from a dedicated action');
assert.match(js, /function renderGsaToolsDialog\(\)[\s\S]*gsa-tool-card__purpose/, 'GSA tools modal should render purpose text');
assert.match(js, /function renderGsaToolsDialog\(\)[\s\S]*gsa-tool-toggle/, 'GSA tools modal should render enable toggles');
assert.match(js, /function gsaToolInstallProblem\(tool\)[\s\S]*missingInstaller/, 'GSA tools modal should surface missing installer prerequisites');
assert.match(js, /function renderGsaToolsDialog\(\)[\s\S]*need installers/, 'GSA tools modal should summarize tools blocked by missing prerequisites');
assert.match(js, /function setGsaToolEnabled\(tool, enabled\)[\s\S]*gsaDisabledTools/, 'GSA tool toggles should persist enabled\/disabled state');
assert.match(js, /async function gsaStart\(workdir, mission, targetUrl = '', parentRunDir = '', disabledTools = '', profile = 'passive', authorized = false\)[\s\S]*disabledTools[\s\S]*profile[\s\S]*authorized/, 'Engine GSA start should send disabled tools and security profile context to the backend');
assert.match(gsaRuntime, /function gsa_tools_json_filtered|static int gsa_tools_json_filtered/, 'GSA runtime should support per-run filtered tool status');
assert.match(gsaRuntime, /\\"enabled\\":%s/, 'GSA toolStatus should expose whether a tool is enabled for the run');
assert.match(gsaRuntime, /json_get_string\(body, "disabledTools"/, 'GSA start endpoint should read disabled tool choices');
assert.match(js, /await ensureGsaToolsForRun\(\)[\s\S]*Engine\.gsaStart\(workdir, mission, targetUrl, '', gsaDisabledToolsPayload\(\), securityProfileValue\(\), securityAuthorizedValue\(\)\)/, 'GSA submit should preflight tool status before preparing the run with security profile context');
assert.match(js, /AgentView\.send\(res\.prompt, targetUrl \? `\$\{display\}\\nTarget: \$\{targetUrl\}` : display, \{ forceThink: 'max' \}\)/, 'GSA should hide the internal prompt while showing the visible mission and target while forcing thinking max');
assert.match(js, /function buildLoadedPacksRow\(text\)[\s\S]*loadedPacks\(text\)[\s\S]*class: 'skill-use__eye', text: 'USING'/, 'Agent transcript should show which imported skill/craft/brand is in use');
assert.match(js, /\(s\.ev\.input \|\| \{\}\)\.name \|\| \(s\.ev\.input \|\| \{\}\)\.id/, 'Agent skill usage badge should handle skill tool calls that pass id instead of name');
assert.match(js, /if \(viewMode === 'agent'\) \{[\s\S]*buildLoadedPacksRow\(partText\)/, 'Agent responses should render loaded skill usage outside the collapsed tool fold');
assert.match(js, /if \(name === 'skill' \|\| name === 'craft' \|\| name === 'design_system'\)[\s\S]*const kind = name === 'design_system' \? 'brand' : name/, 'tool labels should name loaded skills and design systems cleanly');
assert.match(html, /id="cyber-skills-view"[\s\S]*Cybersecurity skills[\s\S]*id="cyber-skills-query"/, 'Skills dialog should expose the imported cybersecurity skill catalog');
assert.match(js, /function renderCyberSkills\(query = ''\)[\s\S]*Engine\.skillsSearch\(\{ source: 'anthropic'/, 'Skills dialog should search imported cybersecurity skills');
assert.match(js, /gsaMode: 'off'/, 'GSA mode should be persisted as an explicit off/on setting');
assert.match(js, /cap: 'GSA'[\s\S]*items: \[\{ value: 'off', lead: 'Off' \}, \{ value: 'on', lead: 'On'/, 'Composer plus menu should expose GSA as an Off/On dropdown');
assert.match(js, /cap: 'RSA'[\s\S]*items: \[\{ value: 'off', lead: 'Off' \}, \{ value: 'on', lead: 'On'/, 'Composer plus menu should expose RSA as an Off/On dropdown');
assert.match(js, /function renderGsaLoopPill\(\)[\s\S]*cbar-loop-btn[\s\S]*Loop/, 'Composer should show a GSA Loop toggle near the primary controls');
assert.match(js, /let gsaRunState = null/, 'GSA UI should track the active phase pipeline separately from loop state');
assert.match(js, /function parseGsaPhaseJsonText\(text\)[\s\S]*"phase"[\s\S]*localScripts[\s\S]*hypotheses/, 'GSA raw phase JSON should be recognized as structured UI output instead of prose');
assert.match(js, /function buildGsaPhaseCard\(seg\)[\s\S]*GSA[\s\S]*Raw JSON/, 'GSA phase JSON should render as a compact card with collapsible raw JSON');
assert.match(js, /function buildGsaPhaseCard\(seg\)[\s\S]*Collectors[\s\S]*Route graph[\s\S]*Quality gate[\s\S]*Unknowns/, 'RSA phase cards should expose collectors, route graph, quality gate and unknowns without opening raw JSON');
assert.match(js, /function buildGsaPhaseCard\(seg\)[\s\S]*workbenchArtifacts[\s\S]*Evidence workbench/, 'GSA/RSA phase cards should expose Evidence Workbench summaries without opening raw JSON');
assert.match(js, /function buildGsaPhaseCard\(seg\)[\s\S]*validationPlan[\s\S]*Validation plan[\s\S]*validationExecutor[\s\S]*Validation executor[\s\S]*evidenceGraph[\s\S]*Evidence graph/, 'GSA phase cards should expose validation runtime plan, executor and evidence graph summaries');
assert.match(js, /res\.validationPlanPath[\s\S]*gsaRunState\.validationResultsPath[\s\S]*res\.evidenceGraphPath/, 'GSA UI should retain backend validation artifact paths returned by phase save');
assert.match(rsaRuntime, /deterministicCollectors[\s\S]*html_inventory[\s\S]*network_har[\s\S]*claim_evidence_audit/, 'RSA runtime should seed deterministic collector manifest artifacts');
assert.match(rsaRuntime, /gsa_write_tool_retry_artifacts\(run_dir/, 'RSA should seed the shared tool retry policy and ledger artifacts');
assert.match(rsaRuntime, /gsa_write_workbench_artifacts\(run_dir/, 'RSA should seed the shared Evidence Workbench artifacts');
assert.match(rsaRuntime, /Tool retry rule:[\s\S]*do not degrade to curl, wget, Python requests,[\s\S]*timeout[\s\S]*corrected timeout budget/, 'RSA prompts should enforce same-tool timeout retry before fallback');
assert.match(rsaRuntime, /This applies to all optional tools, including browser, HTTP, crawler, storage\/media, SAST, dependency, forensics, reverse, debugger and utility tools/, 'RSA capture prompt should apply retry discipline across tool classes');
assert.match(rsaRuntime, /Evidence Workbench rule:[\s\S]*workbench-\*\.jsonl/, 'RSA prompts should require normalized workbench rows before claims');
assert.match(rsaRuntime, /static int rsa_write_quality_gate[\s\S]*capture_evidence_present[\s\S]*claims_present[\s\S]*no_prompt_artifact_leak/, 'RSA runtime should enforce a quality gate before review completion');
assert.match(rsaRuntime, /static int rsa_write_claim_audit[\s\S]*unsupportedRisks/, 'RSA runtime should write automatic claim/evidence audit artifacts');
assert.match(rsaBenchCompare, /function buildCollectorReport[\s\S]*spa_runtime_probe[\s\S]*auth_surface_probe[\s\S]*media_player_probe/, 'RSA benchmark should run deterministic collectors for SPA, auth and media surfaces');
assert.match(rsaBenchCompare, /function detectSignedCdnSignals[\s\S]*X-Amz-Signature[\s\S]*CloudFront-Signature/, 'RSA benchmark should detect signed CDN and object-storage URL clues');
assert.match(js, /function extractLastGsaPhaseOutput\(raw, expectedPhase = ''\)[\s\S]*segmentAgent\(last\)[\s\S]*gsa_phase_json/, 'Agent idle should extract the last GSA phase JSON before advancing the pipeline');
assert.match(js, /async function advanceGsaPhase\(output\)[\s\S]*Engine\.rsaPhase\(gsaRunState\.workdir, gsaRunState\.runId, phase, output\.output\)[\s\S]*Engine\.gsaPhase\(gsaRunState\.workdir, gsaRunState\.runId, phase, output\.output\)/, 'Guided analysis UI should save RSA phases through /api/rsa/phase and GSA phases through /api/gsa/phase');
assert.match(js, /if \(res\.complete\)[\s\S]*finishGsaRunForLoop\(\)/, 'GSA Loop should wait for the report phase to complete before starting the next run');
assert.match(js, /function continueGsaLoop\(\)[\s\S]*const loopMission = nextGsaLoopMission\(\)[\s\S]*Engine\.gsaStart\(gsaLoopState\.workdir, loopMission, gsaLoopState\.targetUrl, gsaLoopState\.previousRunDir \|\| '', gsaDisabledToolsPayload\(\), securityProfileValue\(\), securityAuthorizedValue\(\)\)/, 'GSA Loop should start a fresh run with a structured parent run directory and security profile context');
assert.match(js, /securityProfile: 'passive'[\s\S]*securityAuthorized: false/, 'GSA/RSA UI should persist security profile and explicit scope authorization state');
assert.match(js, /function securityProfileValue\(\)[\s\S]*if \(!v\) return 'passive'[\s\S]*includes\(v\) \? v : v/, 'GSA/RSA UI should not silently downgrade invalid explicit security profiles');
assert.match(js, /cap: 'Profile'[\s\S]*red-authorized[\s\S]*black-hat/, 'Agent gear should expose security profiles for GSA/RSA');
assert.match(js, /black-hat'[\s\S]*Evil-speak, technical, no gate[\s\S]*Black-hat full-surface mode armed: evil-speak, highly technical explanations, no Scope\/Safety gate[\s\S]*may execute operational validation inside the authorized scope/, 'GSA/RSA UI should distinguish black-hat ungated technical voice from red authorized scope warnings');
assert.match(gsaRuntime, /gsa_blackhat_voice_rule[\s\S]*evil-speak[\s\S]*highly technical[\s\S]*request\/response shapes[\s\S]*payload structure/, 'GSA black-hat profile should inject evil-speak and highly technical explanation rules');
assert.match(rsaRuntime, /gsa_blackhat_voice_rule\(profile_effective\)/, 'RSA black-hat prompts should reuse the GSA black-hat voice rule');
assert.match(rsaRuntime, /Black-hat is active[\s\S]*full-surface attacker-minded/, 'RSA black-hat prompts should keep full-surface attacker-minded behavior');
assert.match(js, /Read the previous GSA run before choosing scope/, 'GSA Loop mission should tell the agent to read the previous run before exploring other paths');
assert.match(js, /const gsaArmed = Store\.getSettings\(\)\.gsaMode === 'on'[\s\S]*\/\^\\\/gsa\\b\/i\.test\(text\) \|\| gsaArmed[\s\S]*const targetUrl =[\s\S]*startGsaCommand\([\s\S]*`\/gsa \$\{text\}`, targetUrl\)/, 'GSA On should route the next Agent message through the GSA pipeline');
assert.match(js, /function switchGsa\(val\)[\s\S]*Store\.setSettings\(\{ gsaMode: v, \.\.\.\(v === 'on' \? \{ planMode: 'off', rsaMode: 'off', thinkLevel: 'max' \} : \{ gsaLoop: 'off' \}\) \}\)/, 'GSA On should be mutually exclusive with Plan/RSA, force thinking max and GSA Off should clear Loop');
assert.match(js, /function switchRsa\(val\)[\s\S]*Store\.setSettings\(\{ rsaMode: v, \.\.\.\(v === 'on' \? \{ planMode: 'off', gsaMode: 'off', gsaLoop: 'off', thinkLevel: 'max' \} : \{\}\) \}\)/, 'RSA On should be mutually exclusive with Plan and GSA and force thinking max');
assert.match(html, /id="cbar-right"[\s\S]*id="think-level"/, 'composer should keep thinking in the bottom-right control group');
assert.match(html, /id="cbar-gear" class="cbar-btn cbar-gear" title="More options"/, 'composer plus button should open secondary options');
assert.match(html, /\.messages\s*\{[\s\S]*overflow-x:\s*hidden/, 'message panes should not expose page-level horizontal overflow');
assert.match(html, /\.agent-view\s*\{[\s\S]*overflow-x:\s*hidden/, 'agent transcript should not expose horizontal overflow while streaming');
assert.match(html, /\.code-block pre\s*\{[\s\S]*white-space:\s*pre-wrap[\s\S]*overflow-wrap:\s*anywhere[\s\S]*overflow-x:\s*hidden/, 'markdown code blocks should wrap long JSON/text lines without an internal horizontal scrollbar');
assert.match(html, /\.diff-txt\s*\{[\s\S]*white-space:\s*pre-wrap[\s\S]*overflow-wrap:\s*anywhere[\s\S]*word-break:\s*break-word/, 'agent file-write diff lines should wrap without horizontal overflow');
assert.match(jsonlPatch.text, /DS4UI_CYBER_SKILLS_DIR/, 'agent JSONL patch should load vendored cybersecurity skills on demand');
assert.match(jsonlPatch.text, /ds4ui_read_cyber_skill_brief/, 'agent JSONL patch should compact vendored cybersecurity skills before returning them');
assert.match(jsonlPatch.text, /long examples, tool catalogs and output templates are intentionally omitted/, 'cyber skill loader should avoid returning full example-heavy manuals');
assert.match(remoteDesign, /DS4UI_CYBER_SKILLS_DIR/, 'design runtime should load vendored cybersecurity skills on demand');
assert.match(js, /label: 'System check'[\s\S]*run: \(\) => Doctor\.open\(\)/, 'System check should remain available from the gear menu');
assert.match(html, /class="loading-spinner"/, 'engine loading overlay should show a spinner');
assert.match(html, /id="loading-log"/, 'engine loading overlay should show a live log');
assert.match(js, /appendOverlayLog\(title\)/, 'engine loading overlay should log launch start');
assert.match(js, /updateOverlay\(st\.loadPct, st\.stage, st\.engineLine \|\| st\.engineError \|\| ''\)/, 'engine loading overlay should consume launcher log lines');
assert.match(js, /let launchTarget = null;/, 'mode switcher should track the launch target separately from the active mode');
assert.match(js, /launching: \(\) => launchTarget/, 'mode switcher should expose the current launch target');
assert.match(js, /launching === 'agent' \|\| launching === 'design'[\s\S]*render\(\);[\s\S]*return;[\s\S]*Api\.checkHealth\(\)/, 'statusbar should not run chat health while agent or design is launching');
assert.match(js, /Starting design agent\.\.\.[\s\S]*Starting coding agent\.\.\./, 'statusbar should show explicit startup state for design and agent');
assert.match(js, /if \(switching \|\| launchTarget\) return;[\s\S]*setMode\(isLanHostMode\(\) \? 'server'/, 'engine sync should not force the UI back to chat during a mode switch');
assert.match(js, /launchTarget = target;[\s\S]*Statusbar\.render\(\);[\s\S]*showOverlay\(title\)/, 'runSwitch should publish launch state before showing the startup overlay');
assert.match(js, /Launch task #\$\{launchTaskId\}/, 'startup overlay should expose the backend launch task id');
assert.match(js, /const timeoutMs = target === 'server' \? 180000 : 15 \* 60 \* 1000;/, 'agent/design startup should allow longer model and system-prompt loading than chat server startup');
assert.match(launcher, /\\"engineLine\\":\\"%s\\"/, 'status endpoint should expose the latest engine log line');
assert.match(launcher, /MODE_IS_PIPED\(g_mode\)[\s\S]*set_stage\("Ready", 100\)[\s\S]*maybe_complete_launch_task\(g_mode\)/, 'Agent/Design piped runtimes should become ready after context buffers are allocated');
assert.match(launcher, /#define TASK_RING_CAP 128/, 'launcher should keep a bounded task lifecycle ring buffer');
assert.match(launcher, /#define LOG_RING_CAP 768/, 'launcher should keep a bounded log ring buffer');
assert.match(launcher, /static void api_diagnostics\(int fd\)/, 'launcher should expose workspace diagnostics');
assert.match(launcher, /sysctl_iogpu_wired_limit_mb[\s\S]*len == sizeof\(int\)[\s\S]*memcpy\(&vi, &v, sizeof vi\)/, 'launcher should decode iogpu.wired_limit_mb when macOS returns a 32-bit sysctl value');
assert.match(launcher, /#define IOGPU_WIRED_MIN_MB 86016LL[\s\S]*#define IOGPU_WIRED_MAX_MB 90112LL[\s\S]*#define IOGPU_WIRED_TARGET_MB IOGPU_WIRED_MIN_MB/, 'launcher should keep the approved macOS IOGPU wired-limit range and recommended target');
assert.match(launcher, /iogpuWiredMinMb[\s\S]*iogpuWiredMaxMb/, 'diagnostics should expose the allowed IOGPU wired-limit range');
assert.match(launcher, /json_get_int\(body, "mb", IOGPU_WIRED_MIN_MB, IOGPU_WIRED_MAX_MB, &target\)/, 'IOGPU endpoint should accept only the approved custom range');
assert.match(launcher, /static void api_iogpu_wired_limit\(int fd, const char \*body\)[\s\S]*LaunchDaemons\/com\.dstudio\.iogpu-wired-limit\.plist[\s\S]*launchctl bootstrap system[\s\S]*persistent\\":true/, 'launcher should apply iogpu.wired_limit_mb and install a persistent LaunchDaemon');
assert.match(launcher, /static void api_updates_check\(int fd\)/, 'launcher should expose Update Doctor status');
assert.match(launcher, /static void api_updates_run\(int fd, const char \*body\)/, 'launcher should expose selected Update Doctor updates');
assert.match(gsaRuntime, /gsa_tool_catalog_status[\s\S]*gsa_tool_found/, 'Update Doctor should verify the full GSA tool catalog with runtime alias resolution');
assert.match(launcher, /GSA catalog %d\/%d tools ready[\s\S]*NUCLEI_TEMPLATES_DIR/, 'Update Doctor should report full GSA catalog and nuclei template readiness');
assert.match(launcher, /updates_ds4_managed_dirty_path[\s\S]*ds4-agent-jsonl[\s\S]*ds4-design[\s\S]*ds4_agent\.c\.ds4ui\.bak/, 'Update Doctor should recognize DStudio-generated ds4 artifacts as managed dirt');
assert.match(launcher, /updates_ds4_git_upstream[\s\S]*@\{u\}[\s\S]*origin\/main/, 'Update Doctor should resolve the real ds4 upstream before declaring latest status');
assert.match(launcher, /updates_skill_sources_status[\s\S]*sources\.tsv[\s\S]*updates_skill_source_remote_head/, 'Update Doctor should read repo-imported skill source metadata');
assert.match(launcher, /updates_skill_source_remote_head[\s\S]*"git", "ls-remote"/, 'Update Doctor should compare repo-imported skills against remote refs');
assert.match(launcher, /strcmp\(kind, "verify-only"\)[\s\S]*manual re-import required/, 'Update Doctor should identify truly verify-only skill sources instead of pretending update can rewrite them');
assert.match(launcher, /updates_run_imported_skills[\s\S]*sync-skill-sources\.mjs[\s\S]*"--all"/, 'Update Doctor should update repo-imported skills through the source sync script');
assert.match(skillSources, /superpowers[\s\S]*https:\/\/github\.com\/obra\/superpowers[\s\S]*skills-dir/, 'Skill source Doctor should monitor the Superpowers repo');
assert.match(skillSources, /ecc[\s\S]*https:\/\/github\.com\/affaan-m\/ECC[\s\S]*\.agents\/skills[\s\S]*skills-dir/, 'Skill source Doctor should monitor and sync the ECC skill repo');
assert.match(skillSources, /anthropic-security-review[\s\S]*https:\/\/github\.com\/anthropics\/claude-code-security-review[\s\S]*anthropic-security-review/, 'Skill source Doctor should monitor and sync the Anthropic security-review repo');
assert.match(skillSources, /marketingskills[\s\S]*preserve-skill-bodies[\s\S]*open-design[\s\S]*open-design-preserve[\s\S]*anthropic-cybersecurity-skills[\s\S]*verify-only/, 'Skill source Doctor should auto-update adapted skill repos through metadata-preserving importers and keep only raw cybersecurity skills verify-only');
assert.match(launcher, /git", "-C", g_ds4_dir, "fetch", "origin", "--prune"[\s\S]*rev-list", "--left-right", "--count", range/, 'Update Doctor check should fetch and compare local ds4 HEAD with upstream');
assert.match(launcher, /local %s is %d commit\(s\) behind %s[\s\S]*Run Update selected to pull\/build\/verify patches/, 'Update Doctor should warn when ds4 is behind upstream');
assert.match(launcher, /local %s matches %s[\s\S]*DStudio generated artifact\(s\) present and safe to regenerate/, 'Update Doctor should report managed generated artifacts only after confirming upstream is current');
assert.match(launcher, /dirty\[0\] && !updates_ds4_dirty_is_only_managed/, 'Update Doctor update run should still refuse non-DStudio local ds4 changes');
assert.match(js, /async function updatesCheck\(\)[\s\S]*AbortSignal\.timeout\(30000\)/, 'Update Doctor check should allow enough time for a real git fetch');
assert.match(launcher, /static void api_logs\(int fd, const char \*path\)/, 'launcher should expose recent logs');
assert.match(launcher, /static void api_tasks\(int fd, const char \*path\)/, 'launcher should expose task summaries');
assert.match(launcher, /path_eq_clean\(path, "\/api\/diagnostics"\)/, 'router should serve /api/diagnostics');
assert.match(launcher, /path_eq_clean\(path, "\/api\/updates\/check"\)/, 'router should serve /api/updates/check');
assert.match(launcher, /\/api\/updates\/run/, 'router should serve /api/updates/run');
assert.match(launcher, /\/api\/iogpu-wired-limit/, 'router should serve /api/iogpu-wired-limit');
assert.match(launcher, /path_eq_clean\(path, "\/api\/logs\/stream"\)/, 'router should serve streaming logs');
assert.match(launcher, /path_eq_clean\(path, "\/api\/tasks\/stream"\)/, 'router should serve streaming tasks');
assert.match(launcher, /task_mark_incomplete\(g_active_turn_task[\s\S]*engine process stopped before completing the turn/, 'engine death during Agent/Design should mark the turn incomplete');
assert.match(launcher, /g_active_turn_compacting/, 'Backend should track active Agent/Design context compaction');
assert.match(launcher, /context compaction during active turn/, 'Backend should log compaction during active Agent/Design turns');
assert.match(launcher, /static void api_agent_interrupt\(int fd, const char \*body\)/, 'Backend interrupt should accept a reason/status body');
assert.match(launcher, /task_mark_completed\(g_active_turn_task, msg\)[\s\S]*task_mark_incomplete\(g_active_turn_task, msg, msg\)/, 'Backend interrupt should distinguish completed technical interrupts from incomplete stalls');
assert.match(launcher, /g_interrupt_pending[\s\S]*agent\/design interrupt is still settling/, 'Backend should reject a new Agent prompt while SIGINT is still settling');
assert.match(launcher, /waitpid\(g_child, &st, WNOHANG\) == g_child[\s\S]*close_pipes\(\);[\s\S]*g_mode = ENGINE_NONE/, 'Backend should close child pipes after an engine exits to avoid a POLLHUP spin');
assert.match(launcher, /\\"taskId\\":%llu/, 'start/send/setup/download responses should carry taskId metadata');
assert.match(js, /task #\$\{res\.taskId\}/, 'Agent/Design send errors should show the backend task id');
assert.match(webview, /DS4_DIRECTORY_PICKER_SCRIPT/, 'native wrapper should inject the directory picker bridge');
assert.match(webview, /setAllowsInlineMediaPlayback[\s\S]*setMediaTypesRequiringUserActionForPlayback[\s\S]*setRequiresUserActionForMediaPlayback/, 'macOS WKWebView should allow inline media playback without an extra user gesture');
assert.match(html, /:root\[data-theme="light"\] \.ws-canvas[\s\S]*background: #f7f8fb;/, 'Design canvas should have a light-mode background tuned for the takeover');
assert.match(html, /:root\[data-theme="light"\] \.cv-bar[\s\S]*background: rgba\(255, 255, 255, 0\.96\)/, 'Design canvas floating prompt should be light in light mode');
assert.match(html, /:root\[data-theme="light"\] \.ws-canvas-hint[\s\S]*background: rgba\(255, 255, 255, 0\.90\)/, 'Design canvas help hint should not stay dark in light mode');
assert.match(html, /:root\[data-theme="light"\] \.ws-fs[\s\S]*background: rgba\(247, 248, 251, 0\.96\)/, 'Design fullscreen preview should not stay dark in light mode');
assert.match(html, /\.brief-send[\s\S]*color: #fff;/, 'Design send buttons should keep a light arrow on the accent background');
assert.match(launcher, /style-src 'self' 'unsafe-inline'/, 'Design preview CSP should allow local workspace stylesheets');
assert.match(launcher, /api_design_preview_file/, 'Design preview should have a path-based file endpoint for relative assets');
assert.match(launcher, /!strncmp\(path, "\/api\/design\/preview\/", 20\)/, 'Design preview route should be served by the local launcher');
assert.match(js, /designPreviewUrl = \(name, mtime\)/, 'Design preview should build path-based URLs for iframe assets');
assert.match(js, /Engine\.designPreviewUrl\(f\.name, f\.mtime\)/, 'Design canvas iframes should use the path-based preview route');
assert.match(js, /if \(seq <= state\.seq\) return false;/, 'Design runtime should ignore duplicate event seqs from stream and poll');
assert.match(js, /const reconcileTodos = \(todos\) =>/, 'Design runtime should reconcile stale todo_write checklists from real events');
assert.match(js, /state\.donePaths\.add\(payload\.path\)/, 'Design runtime should mark file-backed todos completed from file_written events');
assert.match(webview, /NSOpenPanel \*panel = \[NSOpenPanel openPanel\]/, 'macOS wrapper should open the native folder explorer');
assert.match(webview, /runOpenPanelWithParameters:\(WKOpenPanelParameters \*\)parameters/, 'macOS WKWebView should open the native file picker for chat attachments');
assert.match(webview, /gtk_file_chooser_dialog_new/, 'Linux wrapper should open the native folder explorer');
assert.match(webview, /IFileOpenDialog \*dlg = NULL/, 'Windows wrapper should open the native folder explorer');
assert.match(webview, /FOS_PICKFOLDERS/, 'Windows folder explorer should be configured for directories');
assert.match(webview, /ds4PickDirectory: \{ postMessage/, 'Windows WebView2 bridge should expose ds4PickDirectory');
assert.match(webview, /ds4_windows_resolve_directory/, 'Windows native picker should resolve the JS promise');
assert.match(webview, /ExecuteScript\(js, NULL\)/, 'Windows native picker should callback into the page');
assert.match(windowsBuild, /Write-Base64Header[\s\S]*loading\.html[\s\S]*LOADING_B64/, 'Windows build should embed loading.html');
assert.match(windowsBuild, /Get-NativeTool @\("clang-cl", "cl"\)/, 'Windows build should accept clang-cl or cl');
assert.match(windowsBuild, /\$Candidates = @\(/, 'Windows build should search common ds4 checkout locations');
assert.match(windowsBuild, /if \(Test-Path \$OutDir\) \{ Remove-Item \$OutDir -Recurse -Force \}/, 'Windows package should clean stale runtime files from the output folder before packaging');
assert.match(windowsDs4Build, /REMOTE_DIR="\$ROOT\/extension\/remote"/, 'Windows ds4-design build should include DStudio remote adapter');
assert.match(windowsDs4Build, /\/usr\/bin\/gcc \/ucrt64\/bin\/gcc \/mingw64\/bin\/gcc \/clang64\/bin\/gcc/, 'Windows DS4 build should prefer MSYS gcc for ds4 POSIX APIs');
assert.match(windowsBuild, /libgcc_s_seh-1\.dll/, 'Windows package should include the MinGW GCC runtime');
assert.doesNotMatch(windowsBuild, /Copy-Item \$src \$Ds4Dir -Force/, 'Windows package must not copy runtime DLLs next to DS4 engine binaries');
assert.doesNotMatch(windowsBuild, /msys-2\.0\.dll|cygwin1\.dll/, 'Windows package must not bundle copied MSYS/Cygwin root DLLs');
assert.match(windowsBuild, /pacman --noconfirm -S --needed make patch gcc/, 'Windows build should install the MSYS2 POSIX GCC toolchain without requiring git');
assert.doesNotMatch(windowsBuild, /pacman --noconfirm -S --needed make git patch gcc/, 'Windows build should not install git for managed ds4 setup');
assert.doesNotMatch(windowsBuild, /mingw-w64-ucrt-x86_64-gcc/, 'Windows DS4 build must not use UCRT GCC for ds4 POSIX sources');
assert.doesNotMatch(windowsBuild, /curl\.exe/, 'Windows package should not depend on curl.exe for LAN client remote model calls');
assert.match(windowsBuild, /ds4-agent-jsonl\.ver/, 'Windows package should include the JSONL runtime version marker');
assert.match(launcher, /win_prepare_engine_runtime/, 'Windows launcher should prepare runtime DLL lookup before spawning DS4 tools');
assert.match(launcher, /win_remove_copied_posix_runtime_from_ds4/, 'Windows launcher should remove stale copied MSYS/Cygwin DLLs from the selected DS4 folder');
assert.doesNotMatch(launcher, /win_copy_runtime_dlls_to_ds4/, 'Windows launcher must not copy packaged runtime DLLs into the selected DS4 folder');
assert.doesNotMatch(launcher, /DS4UI_CURL/, 'Windows launcher should not point remote model helpers at curl.exe');
assert.match(launcher, /SetErrorMode\(SEM_FAILCRITICALERRORS \| SEM_NOGPFAULTERRORBOX \| SEM_NOOPENFILEERRORBOX\)/, 'Windows launcher should suppress loader error dialogs and surface failures in DStudio');
assert.match(launcher, /C:\\\\msys64\\\\usr\\\\bin;C:\\\\msys64\\\\ucrt64\\\\bin;C:\\\\msys64\\\\mingw64\\\\bin/, 'Windows launcher PATH should include common MSYS2 runtime directories');
assert.doesNotMatch(remoteHelper, /\/tmp\/dstudio-remote-XXXXXX|remote_tempfile|mkstemp|popen|execvp|CreateProcessA|curl/, 'remote model helper must not use temp files, shell process launch or curl');
assert.match(remoteHelper, /model_request/, 'remote model helper should request LAN inference over the DStudio child protocol');
assert.match(remoteHelper, /model_delta/, 'remote model helper should consume streamed model deltas from DStudio');
assert.match(remoteHelper, /model_done/, 'remote model helper should consume model completion frames from DStudio');
assert.match(remoteHelper, /model_error/, 'remote model helper should surface model error frames from DStudio');
assert.match(remoteAgent, /\.in_think = false,[\s\S]*\.in_think = false,/, 'remote Agent stream state should not treat LAN content chunks as already inside a think block');
assert.match(remoteAgent, /if \(ctx->stream && ctx->stream->in_think\)[\s\S]*<\/think>\\n\\n[\s\S]*ctx->stream->dsml_in_think = false/, 'remote Agent should close stale thinking before streaming non-reasoning content or DSML tool calls');
assert.match(remoteAgent, /DS4UI_REMOTE_AUTO_CONTINUES 3/, 'remote Agent should automatically continue interrupted model streams');
assert.match(remoteAgent, /ds4ui_remote_continue_prompt[\s\S]*Re-emit the full intended DSML tool call/, 'remote Agent should repair cut-off DSML tool calls instead of continuing broken fragments');
assert.match(remoteAgent, /Remote model failed after automatic recovery[\s\S]*agent_set_status\(w, AGENT_WORKER_IDLE\)[\s\S]*return 0;/, 'remote Agent should stay alive and idle after unrecoverable model stream failures');
assert.match(remoteDesign, /DESIGN_REMOTE_AUTO_CONTINUES 3/, 'remote Design should automatically continue interrupted model streams');
assert.match(remoteDesign, /design_remote_continue_prompt[\s\S]*Re-emit the full intended DSML tool call/, 'remote Design should repair cut-off DSML tool calls instead of continuing broken fragments');
assert.match(remoteDesign, /Remote model failed after automatic recovery[\s\S]*design_project_finish_run\(&a->project, "error"\)[\s\S]*return 0;/, 'remote Design should stay alive after unrecoverable model stream failures');
assert.doesNotMatch(launcher, /static const char \*JSONL_EDITS\[\]\[2\]/, 'JSONL patch bodies must live under patch/, not in dstudio.c');
assert.doesNotMatch(launcher, /static const char \*WEB_CDP_EDITS\[\]\[2\]/, 'web CDP patch bodies must live under patch/, not in dstudio.c');
assert.doesNotMatch(launcher, /static const char \*WEB_DIRECT_NAV_EDITS\[\]\[2\]/, 'direct navigation patch bodies must live under patch/, not in dstudio.c');
assert.doesNotMatch(launcher, /static const char \*JSONL_MAKEFILE/, 'JSONL build fragment must live under patch/, not in dstudio.c');
assert.match(launcher, /patch_load_set\(JSONL_PATCH_DIR/, 'launcher should load the JSONL patch manifest from patch/');
assert.match(webCdpPatch.text, /web_open_tab_http_fallback/, 'web CDP fallback patch should live under patch/');
assert.match(jsonlPatch.text, /ds4ui_win32_bash_exec[\s\S]*bash\.exe -s[\s\S]*CreateProcessA/, 'Windows JSONL Agent should run bash through the Windows process API instead of MSYS popen');
assert.match(jsonlPatch.text, /ds4ui_win32_ensure_chrome\(9333\)/, 'Windows JSONL web tools should start or reuse Chrome CDP before creating ds4_web');
assert.doesNotMatch(remoteDesign, /remote design keeps local workspace files/, 'remote Design session sync should not emit repeated KV status errors');
assert.match(remoteDesign, /design_remote_emit_empty_sessions/, 'remote Design should answer session-list sync with a structured empty list');
assert.match(remoteDesign, /design_remote_slash_is\(p, "\/list"\)[\s\S]*design_remote_emit_empty_sessions\(\)/, 'remote Design /list should not become a session_status toast');
assert.match(launcher, /ds4_strndup_local\(vs, \(size_t\)\(ve - vs\)\)/, 'Windows launcher build should not depend on POSIX strndup');
assert.match(launcher, /ds4_strndup_local\(s, n\)/, 'Windows web reader should not depend on POSIX strndup');
assert.match(app, /CreateMutexA\(NULL, TRUE, "Local\\\\DStudioSingleInstance"\)/, 'Windows app startup should block a second DStudio instance');
assert.match(app, /flock\(fd, LOCK_EX \| LOCK_NB\)/, 'macOS/Linux app startup should use a non-blocking single-instance file lock');
assert.match(app, /another instance is already running; not opening a second window/, 'second app instance should exit before opening another window');
assert.match(app, /if \(getenv\("DS4UI_NO_WINDOW"\)[\s\S]*return ds4_serve_main\(argc, argv\);[\s\S]*if \(!acquire_single_instance_lock\(\)\)/, 'single-instance lock should apply only to the windowed app, not headless/test server modes');
assert.equal(fs.existsSync('rebuild.sh'), false, 'Do not ship personal rebuild scripts');
assert.match(js, /nativeDirectoryPickerAvailable/, 'Agent\/Design should prefer the native folder picker when available');
assert.match(js, /window\.ds4PickDirectory/, 'Agent\/Design should call the native directory picker bridge');
assert.match(js, /openWorkdirDialogFallback\(target, newSession/, 'custom workdir dialog should remain as fallback');
assert.match(html, /cdrop-menu\.drop-up[\s\S]*cdrop-menu\.drop-down/, 'gear dropdown menus should support opening up or down');
assert.match(js, /function placeMenu\(\)[\s\S]*getBoundingClientRect\(\)[\s\S]*window\.innerHeight[\s\S]*--cdrop-max-height/, 'gear dropdown menus should fit themselves to the available viewport space');
assert.match(launcher, /launch_workdir_missing[\s\S]*workdir_missing[\s\S]*send_json\(fd, "400 Bad Request"/, 'launcher should reject missing Agent/Design workdirs before spawning the engine');
assert.match(js, /res && res\.code === 'workdir_missing'[\s\S]*delete next\[target\][\s\S]*Store\.setSettingsNow\(\{ workdirs: next \}\)[\s\S]*openWorkdirDialog\(target, false\)/, 'UI should clear stale saved workdirs and reopen the picker after a missing-workdir start failure');
assert.doesNotMatch(html, /no LAN IP detected/, 'UI must not accept the stale no-LAN-IP placeholder');
assert.match(html, /LAN enabled - resolving address/, 'LAN toggle should show a resolving state while waiting');
assert.match(js, /enable\s*&&\s*r\.lan\s*&&\s*!r\.lanAddr/, 'LAN toggle must reject enabled-without-address responses');
assert.match(js, /\/api\/lan-health/, 'LAN client connect must use the minimal LAN health endpoint');
assert.match(js, /await connectLanClientMode\(f\.lanConnectAddress\.value\)/, 'settings LAN connect must health-check before saving');
assert.match(js, /await connectLanClientMode\(lanAddressInput\.value\)/, 'onboarding LAN connect must health-check before saving');
assert.match(js, /await connectLanClientMode\(qs\('#ds4dir-lan-address'\)\.value\)/, 'ds4 folder gate LAN connect must health-check before saving');
assert.match(html, /Checking LAN host/, 'LAN connect should show a checking state');
assert.doesNotMatch(html, /Model endpoint|Generation API|available from the LAN host/, 'LAN client diagnostics should not expose host model management language');
assert.match(js, /LAN_CLIENT_MODEL_ID\s*=\s*'ds4'/, 'LAN clients should use a protocol model id instead of host model selection');
assert.match(js, /const remoteModelLaunch = \(\) => \{/, 'Agent/Design LAN clients need a remote model launch payload');
assert.match(js, /lanClient:\s*true/, 'LAN Agent/Design starts should be marked as LAN-client launches');
assert.match(js, /modelBackend:\s*'remote'/, 'LAN Agent/Design should mark the model backend as remote');
assert.match(js, /const host = currentLanClientHost\(\)/, 'LAN Agent/Design should resolve the configured host before start');
assert.match(js, /remoteBaseUrl:\s*host/, 'LAN Agent/Design should call the configured host model URL');
assert.match(js, /remoteModel:\s*Store\.getSettings\(\)\.model \|\| LAN_CLIENT_MODEL_ID/, 'LAN Agent/Design should use the LAN protocol model id');
assert.match(js, /gguf:\s*isLanClientMode\(\) \? '' : modelGguf\(\)/, 'LAN Agent/Design should not send a local GGUF/model path');
assert.match(js, /function startServer\(\) \{[\s\S]*if \(isLanClientMode\(\)\)[\s\S]*setMode\('server'\)[\s\S]*return;[\s\S]*runSwitch\('server'/, 'LAN clients must not start a local server when switching back to Chat');
assert.match(js, /if \(!isLanClientMode\(\) && selectedGguf && selectedGguf !== runningModel\)/, 'LAN onboarding must not start a local selected model');
assert.doesNotMatch(js, /build:\s*'off'/, 'Agent/Design should keep Plan mode as a per-turn UI contract instead of a launch mode');
assert.match(js, /jsonl:\s*isLanClientMode\(\) \? true : Store\.getSettings\(\)\.useJsonlPatch !== false/, 'LAN Agent must force structured output for local tools');
assert.match(js, /startAgent[\s\S]*const remote = remoteModelLaunch\(\)[\s\S]*\.\.\.remote/, 'Agent start payload should include the remote model fields');
assert.match(js, /startDesign[\s\S]*const remote = remoteModelLaunch\(\)[\s\S]*\.\.\.remote/, 'Design start payload should include the remote model fields');
assert.match(js, /if \(isLanClientMode\(\)\)[\s\S]*return;[\s\S]*loadSetModels\(\)/, 'LAN clients should not scan local GGUFs from settings refresh');
assert.match(js, /async function loadSetModels\(\) \{[\s\S]*if \(isLanClientMode\(\)\)[\s\S]*return;[\s\S]*Engine\.ggufs\(\)/, 'LAN client settings must not scan local GGUFs even if called directly');
assert.match(js, /async function loadModelList\(\) \{[\s\S]*if \(isLanClientMode\(\)\)[\s\S]*return;[\s\S]*Engine\.ggufs\(\)/, 'LAN clients should not scan local GGUFs from the composer model picker');
assert.match(js, /function show\(\) \{[\s\S]*if \(isLanClientMode\(\)\) return;[\s\S]*loadGgufs\(\)/, 'LAN clients should not open onboarding into local ds4 discovery');
assert.match(js, /async function loadModelList\(\) \{[\s\S]*if \(isLanClientMode\(\)\)[\s\S]*cbarModel\.hidden = true/, 'LAN Design should hide shared model switching instead of exposing a local brief selector');
assert.match(js, /function downloadModel\(spec\) \{[\s\S]*if \(isLanClientMode\(\)\)[\s\S]*return;[\s\S]*\/api\/model\/download/, 'LAN clients must not start local model downloads');
assert.match(js, /if \(action === 'start-engine'\) \{[\s\S]*if \(isLanClientMode\(\)\)[\s\S]*return;[\s\S]*Engine\.start\(\{ mode: 'server' \}/, 'LAN client system check must not start a local engine');
assert.match(js, /function shouldStickToBottom\(/, 'streaming render should respect user scroll position and text selection');
assert.match(js, /selectionInside\(scroller\)/, 'autoscroll must stop while the user is selecting text');
assert.match(js, /function createFollowScroll\([\s\S]*function settle\(stick, previousTop,[\s\S]*const targetTop = Number\.isFinite\(previousTop\)[\s\S]*requestAnimationFrame\(\(\) => requestAnimationFrame\(\(\) =>/, 'scroll restoration should repeat after layout settles so renders do not jump upward');
assert.match(js, /let followBottomChatId = null/, 'Chat streaming should track bottom-follow intent across final re-renders');
assert.match(js, /function shouldAutoFollow\(chatId\)/, 'Chat streaming should expose bottom-follow state');
assert.match(js, /function finishAutoFollow\(chatId\)/, 'Chat streaming should consume bottom-follow state after the final render');
assert.match(js, /function onScroll\(\)[\s\S]*if \(movedUp\) following = false;[\s\S]*movedDown && isNearBottom\(s, 120\)[\s\S]*following = true/, 'User navigation should disable or re-enable stream autoscroll based on distance from bottom');
assert.match(js, /Messages\.renderChat\(Store\.getChat\(chat\.id\), \{ stickToBottom \}\)/, 'Final chat render should keep the viewport at bottom when the user did not navigate away');
assert.match(js, /Messages\.finishAutoFollow\(chat\.id\)/, 'Final chat render should clear stream autoscroll state');
assert.match(js, /const agentFollow = createFollowScroll\(\(\) => view/, 'Agent streaming should use the shared bottom-follow controller');
assert.match(js, /let agentSelectPointerDown = false/, 'Agent text selection should track pointer drags separately from normal scrolling');
assert.match(js, /on\(view, 'pointerdown', beginAgentSelectionPointer\)/, 'Agent selection lock should start before the browser has a non-collapsed selection');
assert.match(js, /on\(document, 'pointerup', endAgentSelectionPointer\)/, 'Agent selection lock should release when the drag ends');
assert.match(js, /on\(view, 'scroll', agentFollow\.onScroll\)/, 'Agent user navigation should flow through the shared scroll controller');
assert.match(js, /function shouldDeferAgentRenderForSelection\(\)[\s\S]*selectionInside\(view\)/, 'Agent streaming should defer repaint while text is selected');
assert.match(js, /on\(document, 'selectionchange', onAgentSelectionChange\)/, 'Agent should resume live rendering after text selection clears');
assert.match(js, /agentFollow\.settle\(stick, prevScrollTop/, 'Agent renders should preserve scroll position unless following the bottom');
assert.doesNotMatch(js, /const stick = shouldAgentFollow\(\) \|\| shouldStickToBottom\(view\)/, 'Agent renders must not force-follow bottom after the user scrolls away');
assert.match(html, /\.messages \{[\s\S]*overflow-anchor: none;/, 'Chat view should disable browser scroll anchoring that fights explicit scroll restoration');
assert.match(html, /\.agent-view \{[\s\S]*overflow-anchor: none;/, 'Agent view should disable browser scroll anchoring that fights live autoscroll');
assert.match(js, /function agentDeltaFromResponse\(res\)[\s\S]*if \(len <= since\) return ''/, 'Agent streaming must drop duplicate SSE/poll payloads by absolute offset');
assert.match(js, /return sliceUtf8From\(raw, since - payloadStart\)/, 'Agent streaming should keep only the unseen suffix of overlapping payloads');
assert.match(js, /if \(streamAbort\) \{ streamAbort\.abort\(\); streamAbort = null; \}[\s\S]*pollBusy = false;/, 'Agent restart should cancel the previous stream before opening a new one');
assert.match(js, /const deltaBytes = utf8ByteLength\(delta\)/, 'Agent transcript reattach should track byte offsets instead of JS string length');
assert.doesNotMatch(js, /res\.text && res\.text\.includes\('"type":"artifact"'\)/, 'Agent/design side effects should inspect deduped deltas, not raw overlapping payloads');
assert.match(js, /if \(viewMode === 'design' && delta\) drainSessionEvents\(delta\)/, 'Design session events should be drained only from deduped deltas');
assert.doesNotMatch(js, /Agent and Design run on the DStudio host\. LAN clients use Chat\./, 'LAN clients must be able to open Agent and Design');
assert.doesNotMatch(js, /if \(isLanClientMode\(\)\) \{ setMode\('server'\); return; \}/, 'LAN switches must not be forced back to Chat');
assert.match(js, /function isHostServedLanShell\(\)/, 'host-served LAN shell must be detectable');
assert.match(html, /Workspace, agent, design, settings and store APIs stay local-only/, 'LAN copy must document local workspace isolation');
assert.match(html, /keeps its own local chats, app state and workspaces/, 'LAN client settings should describe local workspaces');
assert.match(html, /id="lan-client-ds4dir-path"/, 'LAN client settings should show the managed local DS4 runtime folder');
assert.match(html, /id="lan-client-ds4dir-setup"/, 'LAN client settings should install the managed local DS4 runtime');
assert.match(html, /Local DS4 runtime/, 'LAN client settings should name the client-side DS4 runtime explicitly');
assert.doesNotMatch(js, /lanClientDs4Dir:\s*''/, 'LAN client settings should not persist a manual DS4 runtime folder');
assert.doesNotMatch(html, /Agent and Design requests run on the LAN host|uses the LAN host for Chat, Agent and Design/, 'LAN client copy must not imply host workspaces');
assert.match(js, /const apiUrl = \(path\) => `\$\{path\}`/, 'Engine APIs must stay local in LAN client mode');
assert.match(js, /syncLanClientDs4Dir\(\)/, 'Opening LAN client settings should check the local DS4 folder');
assert.match(js, /async function setupLanClientDs4\(\)[\s\S]*Engine\.setupDs4\(\)/, 'LAN client DS4 runtime setup should use the managed setup endpoint');
assert.doesNotMatch(js, /window\.ds4PickDirectory\(\{ mode: 'ds4' \}\)/, 'LAN client DS4 setup should not use the native DS4 folder picker');
assert.doesNotMatch(js, /Engine\.setDs4Dir/, 'UI should not keep the old manual ds4dir setter');
assert.doesNotMatch(js, /applySavedLanClientDs4Dir/, 'LAN clients should not reapply saved manual DS4 paths');
assert.match(js, /const webToolUrl = \(path\) => \{[\s\S]*isLanClientMode\(\) \? currentLanClientHost\(\)\.replace/, 'LAN clients should route Chat web tools to the host');
assert.match(js, /webToolFetch\('\/api\/web-search'/, 'LAN Chat Web Search should use the web tool fetch path');
assert.match(js, /webToolFetch\('\/api\/web-read'/, 'LAN Chat Web Read should use the web tool fetch path');
assert.match(js, /webToolFetch\('\/api\/http-probe'/, 'LAN Deep Research HTTP probes should use the web tool fetch path');
assert.match(js, /the LAN host browser\/search helper/, 'LAN Web Search consent should name the host browser helper');
assert.match(js, /const helperPlace = isLanClientMode\(\) \? 'LAN host web helper' : 'local web helper'/, 'LAN Web Search errors should name the host helper');
assert.doesNotMatch(js, /const apiBase = \(\) => isLanClientMode\(\) \? currentLanClientHost\(\)\.replace/, 'LAN clients must not route workspace APIs to the host');
assert.match(js, /Run DStudio locally on this device, then connect to LAN to use local workspaces/, 'host-served LAN shell must block Agent and Design workspaces');
assert.doesNotMatch(launcher, /path_eq_clean\(path, "\/api\/start"\) \|\|/, 'LAN host must not allow remote engine switching');
assert.doesNotMatch(launcher, /!strncmp\(path, "\/api\/design\/file\?", 17\) \|\|/, 'LAN host must not expose design workspace files');
assert.match(launcher, /remoteBaseUrl/, 'launcher must accept a remote model URL for LAN Agent\/Design');
assert.match(launcher, /remoteBaseUrl must be a safe http:\/\/ LAN URL/, 'remote model URL must be constrained to http LAN use');
assert.match(launcher, /json_get_bool\(body, "lanClient"\)/, 'launcher must recognize LAN-client remote model starts');
assert.match(launcher, /LAN client Agent\/Design requires a remote model host/, 'LAN-client Agent\/Design must not fall back to local model discovery');
assert.match(launcher, /if \(g_remote_base_url\[0\]\) g_use_jsonl = 1/, 'remote Agent must force structured JSONL output');
assert.match(launcher, /remote agent requires the structured ds4-agent-jsonl build/, 'remote Agent must not fall back to stock raw output');
assert.match(launcher, /"--remote-base-url"/, 'launcher must pass --remote-base-url to Agent\/Design');
assert.match(launcher, /"--remote-model"/, 'launcher must pass --remote-model to Agent\/Design');
assert.match(launcher, /!remote_model && port_listening\(ENGINE_DEFAULTS\.port\)/, 'remote Agent\/Design must not be blocked by a local engine port');
assert.match(launcher, /WEB_DIRECT_NAV_MARK/, 'web helper patch must include direct URL navigation');
assert.match(launcher, /web_direct_nav_source_has_fix/, 'web helper patch must detect direct navigation when it lands upstream');
assert.match(launcher, /web_direct_nav_apply\(&buf, &n\)/, 'generated ds4 web helper must receive the direct navigation patch');
assert.match(webDirectNavPatch.text, /web_open_tab\(web, url, &tab, err, err_len\)/, 'web reader should open the requested URL directly, not through about:blank navigation');
assert.match(webDirectNavPatch.text, /__attribute__\(\(unused\)\) web_cdp_navigate/, 'direct navigation patch should not leave an unused-function warning');
assert.match(launcher, /Access-Control-Allow-Headers: Content-Type, Accept, X-Requested-With/, 'LAN engine APIs must allow the app anti-CSRF header in CORS preflights');
assert.match(launcher, /!local_client && \(!strcmp\(method, "GET"\) \|\| head_only_req\) && loading_page_path\(path\)[\s\S]*send_redirect\(fd, "\/", head_only_req\)/, 'LAN clients opening loading.html should be redirected to the app shell');
assert.match(launcher, /if \(lan_root_path\(path\)\)[\s\S]*read_page\(&len\)/, 'root app shell should tolerate query strings');
assert.match(launcher, /DS4UI_PAGE_FROM_DISK[\s\S]*read_page_disk\(out_len\)[\s\S]*base64_decode\(PAGE_B64, out_len\)/, 'disk page mode should fall back to embedded index.html');
assert.match(launcher, /DS4UI_PAGE_FROM_DISK[\s\S]*read_loading_disk\(out_len\)[\s\S]*base64_decode\(LOADING_B64, out_len\)/, 'disk page mode should fall back to embedded loading.html');
assert.match(launcher, /canonicalUrl/, 'web-read should return the canonical URL');
assert.match(launcher, /sourceKind/, 'web-read should classify the source kind');
assert.match(launcher, /metadata/, 'web-read should return reader metadata');
assert.match(launcher, /warnings/, 'web-read should return reader warnings');
assert.match(js, /function isLanHostMode\(\)/, 'host LAN supervision needs a separate mode from LAN clients');
assert.match(js, /return !isLanClientMode\(\) && s\.lanEnabled === true/, 'host LAN mode must not apply to LAN clients');
assert.match(js, /tab\.disabled = hostLan/, 'host LAN mode must disable Agent and Design tabs');
assert.match(js, /setMode\(isLanHostMode\(\) \? 'server'/, 'host LAN mode must stay on the Chat screen');
assert.match(js, /if \(isLanHostMode\(\) && mode === 'chat'\) return state\.chats\.filter\(\(c\) => c\.lanMirror\)/, 'host LAN sidebar should show only LAN mirrors');
assert.match(js, /return state\.chats\.filter\(\(c\) => chatMode\(c\) === mode && hasContent\(c\)\)/, 'sidebar should not show empty New chat placeholders');
assert.match(js, /state\.chats = state\.chats\.filter\(\(c\) => c\.lanMirror \|\| chatMode\(c\) !== mode \|\| hasContent\(c\)\)/, 'New chat should replace prior empty placeholders instead of stacking cards');
assert.match(js, /function mirrorTranscriptMessages\(chat\)/, 'host LAN Chat view must render agent/design mirror transcripts read-only');

assert.match(html, /id="chat-file-input" class="native-file-input" multiple/, 'Chat composer should include a native multi-file picker');
assert.doesNotMatch(html, /id="chat-file-input"[^>]*hidden/, 'Chat file picker must not use the hidden attribute because WKWebView can ignore programmatic clicks');
assert.match(html, /<label id="cbar-attach" class="cbar-btn" title="Attach files" for="chat-file-input"/, 'Chat attach control should be a native label for the file picker');
assert.match(html, /id="cbar-attach-icon"/, 'Attach icon should update without replacing the nested file input');
assert.match(html, /\.native-file-input[\s\S]*position: absolute;[\s\S]*inset: 0;/, 'Chat file input should cover the attach button for a real user click');
assert.match(html, /id="composer-files"/, 'Chat composer should show pending file chips');
assert.match(html, /<form id="composer-form" class="composer__card">[\s\S]*id="composer-files"/, 'Pending chat files should be wrapped inside the composer card');
assert.match(js, /function buildFileTileIcon\(\)[\s\S]*const Chat = \(\(\) =>/, 'File tile icon helper must be shared by Chat and Composer, not scoped inside Chat only');
assert.match(html, /id="file-preview-dialog"/, 'Chat attachments should have a file preview dialog');
assert.match(html, /#settings-dialog\.settings-dialog[\s\S]*width: min\(96vw, 62rem\)/, 'Main settings dialog should use a wide landscape layout');
assert.match(html, /#settings-dialog \.settings[\s\S]*grid-template-columns: 218px minmax\(0, 1fr\)/, 'Main settings should use sidebar navigation with one content pane');
assert.match(html, /@keyframes ec-orbit/, 'Empty-state DStudio logo should rotate while floating');
assert.match(html, /:root\[data-theme="light"\] \.btn--primary \{ color: #fff; \}/, 'Light mode primary button text should stay white');
assert.match(html, /\*::-webkit-scrollbar-thumb/, 'App scrollbars should use the shared custom scrollbar style');
assert.match(js, /const CHAT_ATTACH_MAX_FILES = 6/, 'Chat file attachments need a per-message file cap');
assert.match(js, /function attachmentContextForModel\(m\)/, 'Chat attachments should be converted into model context');
assert.match(js, /\[Attached files\]/, 'Chat attachment prompt context should be explicitly delimited');
assert.match(js, /Treat them as primary source material for this turn/, 'Chat attachments should be presented as the primary source for the current turn');
assert.match(js, /\[User request\]/, 'Attached file prompts should separate the user request after the file content');
assert.match(js, /function citationAnchorHtml\(id\)/, 'Markdown renderer should turn [S1]/[F1] citations into clickable anchors');
assert.match(js, /function linkRawUrls\(s\)/, 'Markdown renderer should linkify raw source URLs');
assert.match(html, /\.latex-menu[\s\S]*\.latex-menu__item/, 'LaTeX formulas should use a compact right-click context menu');
assert.match(js, /function tableMatrixToAsciiArt\(matrix, headerRows = 1\)[\s\S]*visibleWidth[\s\S]*padRight[\s\S]*return out\.join\('\\n'\)/, 'Markdown tables should have a deterministic ASCII-art conversion algorithm');
assert.match(js, /function tableElementToAsciiArt\(table\)[\s\S]*tableMatrixToAsciiArt\(tableElementToMatrix\(table\), headerRows\)/, 'Rendered tables should convert from DOM cells to ASCII art');
assert.match(js, /function renderMathWithCopy\(mml, latex, display\)[\s\S]*data-latex="\$\{escapeHtml\(String\(latex \|\| ''\)\.trim\(\)\)\}"[\s\S]*mml[\s\S]*`<\/span>`/, 'Markdown math renderer should preserve original LaTeX without adding inline buttons');
assert.match(js, /function handleMarkdownContextMenu\(e\)[\s\S]*closest\?\.\('\.math-wrap\[data-latex\]'\)[\s\S]*showLatexContextMenu\(wrap, e\.clientX, e\.clientY\)/, 'Right-clicking rendered LaTeX should open the Copy LaTeX menu');
assert.match(js, /text: 'Copy LaTeX'/, 'LaTeX context menu should name the action explicitly');
assert.match(js, /function handleMarkdownContextMenu\(e\)[\s\S]*closest\?\.\('\.md table'\)[\s\S]*showTableContextMenu\(table, e\.clientX, e\.clientY\)/, 'Right-clicking a rendered Markdown table should open the ASCII art copy menu');
assert.match(js, /text: 'Copy table as ASCII art'/, 'Table context menu should name the ASCII art action explicitly');
assert.match(js, /on\(document, 'contextmenu', handleMarkdownContextMenu\)/, 'Markdown rendered anywhere should support the LaTeX context menu');
assert.match(js, /on\(document, 'click', closeMarkdownContextMenus\)/, 'Markdown context menus should close on outside click');
assert.doesNotMatch(html + js, /math-copy-btn|data-copy-latex/, 'LaTeX copy should not use inline buttons next to every formula');
assert.match(js, /function decorateCitationTargets\(root, sources = \[\]\)/, 'Rendered messages should resolve citation anchors to their sources/facts');
assert.match(js, /function sourceFavicon\(url\)/, 'Source cards should derive a favicon for each web source');
assert.match(html, /\.msg-source__favicon/, 'Source cards should style site favicons');
assert.match(launcher, /img-src data: http: https:/, 'Main app CSP should allow remote favicons for web source cards');
assert.match(js, /async function sendMessage\(text, \{ regenerate = false, attachments = \[\] \} = \{\}\)/, 'Chat send should accept attachments');
assert.match(js, /msg\.attachments = cleanAttachments/, 'User messages should persist attached file metadata/content');
assert.match(js, /buildAttachments\(m\.attachments, 'user'\)[\s\S]*article\.append\(el\('div', \{ class: 'msg__content'/, 'Sent user attachments should render above the text bubble');
assert.match(html, /\.msg--user-wrap[\s\S]*background: transparent/, 'User messages with attachments should use a transparent wrapper around separate file and text cards');
assert.match(html, /\.msg-attachments--user \.msg-attachment[\s\S]*flex-direction: row/, 'Sent user attachments should render as horizontal file cards');
assert.match(js, /function openChatFilePicker\(\)/, 'Chat attach button should open the file picker through a dedicated wrapper');
assert.match(js, /fileInput\.showPicker/, 'Chat attach button should prefer the native showPicker API when available');
assert.match(js, /function isChatComposerMode\(\)/, 'Chat file attachment logic should not depend on a single internal mode string');
assert.match(js, /AttachmentPreview\.open\(file\)/, 'Attached file chips should open a preview modal');
assert.match(js, /attachmentKindLabel\(a\)/, 'Attachment tiles should show a file-type badge');
assert.match(js, /function bindFileDrop\(target\)/, 'Chat composer should support drag-and-drop file attachments');
assert.match(js, /const chatSurface = qs\('\.chat'\);[\s\S]*bindFileDrop\(chatSurface\)/, 'File drag-and-drop should work across the whole Chat surface');
assert.match(js, /if \(!acceptsFileDrop\(\) \|\| !dragHasFiles\(e\)\) return/, 'File drag-and-drop should use the shared Chat/Agent/Design mode guard');
assert.match(js, /readChatFiles\(e\.dataTransfer\.files\)/, 'Dropped files should use the same attachment reader as the paperclip');
assert.match(html, /chat--drop \.composer__card/, 'Chat composer should expose a visible whole-chat drag-over state');
assert.match(js, /cbarAttach\.hidden = readOnly \|\| mode === 'agent'/, 'Attach button should show for Chat, stay for Design and hide in Agent/read-only host mode');
assert.match(js, /function placePrimaryControls\(\)[\s\S]*cbarThink\.hidden = false/, 'Composer should keep thinking visible in the bottom-right control group');
assert.doesNotMatch(js, /function parkNativeThinkSelect\(\)/, 'Composer should not use the old hidden-thinking gear layout');
assert.match(js, /cbarPop\.append\(cbarAttach\)/, 'Composer plus menu should own secondary attach/options controls');
assert.match(html, /body\.composer-raised \.chat \{ grid-template-rows: auto auto auto minmax\(0, 1fr\); \}/, 'empty conversations should raise the composer under the hero instead of pinning it at the bottom');
assert.match(html, /\.cbar-pop\s*\{[\s\S]*position:\s*fixed[\s\S]*overflow-y:\s*auto/, 'composer plus menu should be fixed-positioned and scrollable instead of covering or clipping controls');
assert.match(html, /\.cdrop-menu\s*\{[\s\S]*position:\s*fixed[\s\S]*--cdrop-top[\s\S]*--cdrop-left[\s\S]*--cdrop-width/, 'plus-menu dropdowns should be fixed-positioned so the scrollable plus menu cannot clip them');
assert.match(js, /if \(!document\.body\.contains\(menu\)\) document\.body\.appendChild\(menu\)/, 'plus-menu dropdowns should be mounted on body before placement');
assert.match(js, /window\.innerHeight - margin - height[\s\S]*menu\.style\.top/, 'plus-menu dropdown placement should clamp top inside the viewport');
assert.match(html, /id="set-power"[\s\S]*id="set-ssd-streaming"/, 'Settings should expose engine power and SSD streaming launch parameters');
assert.match(js, /enginePower:\s*90[\s\S]*ssdStreaming:\s*'auto'/, 'engine power and SSD streaming should have persisted defaults');
assert.match(js, /const launchBase = \(\) => \(\{ ctx: ctxSize\(\), power: enginePower\(\), ssdStreaming: ssdStreaming\(\) \}\)/, 'engine starts should share the persisted power and SSD streaming settings');
assert.match(js, /function applyEngineConfig\(\)[\s\S]*Restart to apply engine settings\?[\s\S]*restartCurrent\(\)/, 'engine launch setting changes should offer to restart the active engine');
assert.match(js, /setIogpuWiredLimit\(mb\)[\s\S]*\/api\/iogpu-wired-limit/, 'frontend should expose the IOGPU wired-limit apply endpoint');
assert.match(html, /id="set-iogpu-limit-mb"[\s\S]*min="86016"[\s\S]*max="90112"[\s\S]*id="set-iogpu-limit"[\s\S]*Apply wired limit[\s\S]*LaunchDaemon/, 'Settings should offer a custom persistent macOS IOGPU limit action');
assert.match(js, /const minMb = Number\(m\.iogpuWiredMinMb \|\| 86016\)[\s\S]*const maxMb = Number\(m\.iogpuWiredMaxMb \|\| 90112\)[\s\S]*const iogpuLimitRisk = m\.iogpuWiredLimitMb > maxMb/, 'memory doctor should only warn when iogpu.wired_limit_mb exceeds the approved range');
assert.match(js, /function generatedFilesForMessage\(m\)[\s\S]*extractGeneratedFilesFromAssistant\(m\?\.content \|\| ''\)\.files[\s\S]*function displayContentForMessage\(m\)[\s\S]*stripGeneratedFilePayloadPreview\(m\.content\)/, 'message rendering should convert dstudio-files fences into generated file tiles instead of showing the protocol block');
assert.match(html, /body\.composer-raised \.cbar-model-menu \{ top: calc\(100% \+ 6px\); bottom: auto; \}/, 'raised composer model menu should open downward with the other menus');
assert.match(html, /body\.composer-raised \.cbar-think-menu \{ top: calc\(100% \+ 6px\); bottom: auto; \}/, 'raised composer thinking menu should open downward with the other menus');
assert.match(html, /\.cbar-pop\s*\{[\s\S]*width:\s*min\(88vw,\s*300px\)[\s\S]*min-width:\s*240px/, 'plus menu should stay compact instead of using oversized rows');
assert.match(html, /\.cdrop-cap\s*\{ width:\s*30px; font-size:\s*9\.5px;/, 'plus menu dropdown labels should be compact');
assert.match(html, /id="skills-picker-view"[\s\S]*id="skills-category-list"[\s\S]*id="skills-picker-list"/, 'Skill picker should use a modal with category sidebar and skill grid');
assert.match(html, /id="skills-picker-manage"[\s\S]*>Add<\/button>/, 'Skill picker should label the authoring action Add, not Manage');
assert.doesNotMatch(html, /id="skills-picker-manage"[\s\S]*>Manage<\/button>/, 'Skill picker should not expose the old Manage label');
assert.match(js, /function openSkillPickerForCurrentMode\(\)[\s\S]*Skills\.openPicker/, 'Skill selection should open the modal picker from the plus menu');
assert.match(js, /function renderSkillPicker\(\)[\s\S]*skills-cat[\s\S]*skill-card/, 'Skill picker modal should render categories and skill cards');
assert.match(js, /\.filter\(\(s\) => s\.modes && s\.modes\.includes\('agent'\)\)/, 'Agent skill picker should expose Agent-mode skills only');
assert.match(js, /pushGroup\('agent-workflow', 'Agent \/ Workflow'/, 'Agent skill picker should use the Agent / Workflow category name');
assert.doesNotMatch(js, /pushGroup\('web-plan'/, 'Agent skill picker should not expose the removed planning-build category');
assert.match(js, /on\(pickerManage, 'click', \(\) => showEditor\(null, null, 'picker'\)\)/, 'Skill picker Add should open the editor directly');
assert.match(js, /skill-card__edit[\s\S]*showEditor\(it\.value, it\.raw, 'picker'\)/, 'Skill cards should expose an inline edit action');
assert.match(js, /Engine\.userSkillGet\(id\)[\s\S]*Engine\.skillGet\(id\)/, 'Editing a shipped skill should fall back to reading the shipped body');
assert.match(js, /Engine\.userSkillSave\(\{ id,[\s\S]*modes: editingModes/, 'Skill editor should preserve modes when saving local overrides');
assert.match(js, /function selectedSkillPromptForRuntime\([^)]*\)[\s\S]*DStudio selected skill/, 'Selected skills should apply to future turns without restarting the runtime');
assert.match(js, /const runtimeSkillAtLaunch = \{ agent: '', design: '' \}/, 'Runtime should track the skill that was injected at launch');
assert.match(js, /selectedSkillPromptForRuntime\([^)]*\)[\s\S]*id === \(runtimeSkillAtLaunch\[mode\] \|\| ''\)[\s\S]*return ''/, 'Selected skill prompt should not duplicate the skill already injected at runtime launch');
assert.match(js, /selectedSkillPromptForRuntime\([^)]*\)[\s\S]*load up to two additional skills[\s\S]*three or fewer/, 'Selected skill runtime prompt should allow bounded multi-skill use');
assert.match(launcher, /cap each user request at three `skill` calls total/, 'On-demand skill catalog should allow bounded multi-skill loading');
assert.doesNotMatch(extractFunction(js, 'switchSkill'), /restartCurrent\(/, 'Changing skill should not restart the model');
assert.match(js, /function setComposerRaised\(active\)[\s\S]*composer-raised/, 'empty-state renderer should explicitly toggle the raised composer layout');
assert.match(js, /function shouldFocusComposerFromSurfaceClick\(e\)[\s\S]*return !t\.closest\(\[[\s\S]*button', 'a', 'input', 'textarea', 'select'/, 'clicking a non-interactive chat surface should focus the shared composer');
assert.match(js, /on\(form, 'mousedown', \(e\) => \{[\s\S]*shouldFocusComposerFromSurfaceClick\(e\)[\s\S]*focusComposerInput\(\)/, 'clicking empty composer card space should focus the text input');
assert.match(js, /const chatSurface = qs\('\.chat'\);[\s\S]*on\(chatSurface, 'mousedown', \(e\) => \{[\s\S]*shouldFocusComposerFromSurfaceClick\(e\)[\s\S]*focusComposerInput\(\)/, 'clicking empty space anywhere in the chat surface should focus the text input');
assert.match(js, /function onClick\(e\)[\s\S]*if \(!actBtn\) \{[\s\S]*shouldFocusComposerFromSurfaceClick\(e\)[\s\S]*focusComposerInput\(\)/, 'Chat message surface clicks should focus the composer when not hitting controls');
assert.match(js, /function onClick\(e\)[\s\S]*if \(cmd\)[\s\S]*return;[\s\S]*if \(shouldFocusComposerFromSurfaceClick\(e\)\) focusComposerInput\(\)/, 'Agent and Design surface clicks should focus the composer when not hitting controls');
assert.match(js, /Messages\.renderChat\(chat, \{ stickToBottom: true \}\)/, 'Sending a chat message should force the new turn to the bottom instead of preserving an old scrollTop');
assert.match(js, /agentFollow\.setFollowing\(!isSlashCommand\(displayPrompt\) \|\| shouldStickToBottom\(view\)\)/, 'Sending an Agent or Design message should keep the new turn visible even if the previous scrollTop was high');
assert.match(js, /class: 'wd-path'[\s\S]*text: wd \|\| 'choose folder…'/, 'working folder row should use path-specific styling instead of applying monospace to every plus-menu action');
assert.doesNotMatch(html + js, /Runs entirely on your Mac|Write a message…|Ask the agent|Describe the design|A first-run onboarding screen|Refine the selected screen/, 'Chat, Agent and Design composer placeholders/privacy filler should not be visible');
assert.match(html, /\.btn--send[\s\S]*width: 34px;[\s\S]*height: 34px;[\s\S]*\.cbar-btn[\s\S]*width: 34px; height: 34px;[\s\S]*\.cbar-sel[\s\S]*height: 34px;[\s\S]*\.cbar-think-btn[\s\S]*height: 34px;[\s\S]*\.cbar-model-btn[\s\S]*height: 34px;/, 'model, thinking, plus and send controls should share the same height');
assert.match(js, /function renderThinkingPill\(\)[\s\S]*closeGear\(\);[\s\S]*closeModelMenu\(\);[\s\S]*thinkMenuOpen = next/, 'Opening Thinking should close the plus and model menus first');
assert.match(js, /function renderModelPill\(\)[\s\S]*closeGear\(\);[\s\S]*closeThinkMenu\(\);[\s\S]*modelMenuOpen = next/, 'Opening Model should close the plus and thinking menus first');
assert.match(js, /function openGear\(\)[\s\S]*closeThinkMenu\(\);[\s\S]*closeModelMenu\(\);[\s\S]*layoutControls\(\)/, 'Opening the plus menu should close model and thinking menus first');
assert.match(js, /if \(activeCdropCollapse && activeCdropCollapse !== collapse\) activeCdropCollapse\(\)/, 'Only one plus-menu custom dropdown should stay open at a time');
assert.match(js, /body\.classList\.toggle\('design-brief-staged'[\s\S]*stagedBrief[\s\S]*body\.classList\.toggle\('design-staged'[\s\S]*\(stagedQ \|\| stagedGen\)/, 'Design brief should not hide the shared composer; only questions/generating should');
assert.match(js, /setComposerRaised\(viewMode === 'agent' \|\| \(viewMode === 'design' && stagedBrief\)\)/, 'Design brief should keep the shared composer centered while showing the template grid');
assert.match(js, /doneTodoKeys: new Set\(\)/, 'Design generating progress should track synthetic todo completion from tool events');
assert.match(js, /function applyEvent\(ev\)[\s\S]*markTodosBeforeOperation\(state\.activeTool\)/, 'Design milestone tool calls should advance earlier build todos instead of leaving progress stuck');
assert.match(js, /type === 'file_written'[\s\S]*markActiveOrNextTodoDone\(\)/, 'Design file writes should advance the active build todo when the model forgets todo_write');
assert.match(js, /const markActiveOrNextTodoDone = \(\) => \{[\s\S]*!requiredOps\(String\(todo\?\.text \?\? ''\)\)\.length[\s\S]*if \(idx >= 0\) markTodoDone/, 'Design file writes should not complete verify/critique/artifact milestone todos');
assert.match(js, /type === 'run_started'[\s\S]*state\.todos = null[\s\S]*discoveryBlockedNotified = false/, 'Design runtime should clear stale todos and discovery warnings when a new run starts');
assert.match(js, /type === 'discovery_blocked'[\s\S]*Questions required before building[\s\S]*Design needs the Questions step before building/, 'Design UI should surface a skipped-discovery runtime block to the user');
assert.match(js, /function designPhase\(\)[\s\S]*DesignRuntime\.getState[\s\S]*return 'generating'/, 'Design stepper should use event-sourced runtime state, not only visible transcript text');
assert.match(js, /function designPhase\(\)[\s\S]*const emptyTranscript = viewMode === 'design' \? !hasDesignConversationContent\(text\) : !hasRenderableConversation\(text\)[\s\S]*if \(emptyTranscript && !working && !rt\?\.question && rt\?\.phase !== 'building'\) return 'brief'[\s\S]*ps0\.finalized/, 'Empty Design conversations should stay on Brief instead of inheriting stale runtime preview state');
assert.match(js, /function hasRenderableConversation\(raw = text\)[\s\S]*session_status[\s\S]*return false/, 'Agent/Design empty states should ignore service-only transcripts');
assert.match(js, /function hasDesignConversationContent\(raw = text\)[\s\S]*seg\.kind === 'proposal'[\s\S]*seg\.kind === 'artifact'[\s\S]*return false/, 'Design empty states should ignore reasoning-only or service-only transcripts');
assert.match(js, /staleNotice = !conv\.lanMirror &&[\s\S]*viewMode === 'design' \? hasDesignConversationContent\(conv\.transcript \|\| ''\) : hasRenderableConversation\(conv\.transcript \|\| ''\)[\s\S]*!conv\.sessionSha/, 'Service-only new Agent/Design conversations should not show the stale session warning');
assert.match(js, /const submitAnswer = \(answerText, lines = \[\]\) => \{[\s\S]*viewMode === 'design'[\s\S]*sendQuestionAnswer\(answerText\)/, 'Design question forms should submit with the runtime-recognized question answer marker');
assert.match(js, /viewMode === 'agent' \|\| viewMode === 'design'/, 'Design reasoning blocks should stay open like Agent reasoning blocks');
assert.match(html, /\.thinking \{[\s\S]*content-visibility: visible;[\s\S]*contain-intrinsic-size: auto;/, 'Open reasoning blocks should not use estimated content-visibility heights that can disturb scroll');
assert.doesNotMatch(remoteDesign, /BUILD\s+MODE\s+\(planned\)/, 'Design discovery gate should not keep the removed direct-build bypass');
assert.match(remoteDesign, /design_tool_allowed_before_discovery[\s\S]*skill[\s\S]*design_system[\s\S]*craft[\s\S]*pack_file[\s\S]*question/, 'Design discovery gate should allow only pack loading and question before discovery');
assert.match(remoteDesign, /design_discovery_gate_active[\s\S]*!pr->discovery_satisfied[\s\S]*!pr->current_artifact_entry\[0\]/, 'Design runtime should enforce discovery before first build tools on fresh projects');
assert.match(remoteDesign, /discovery_required[\s\S]*discovery_blocked/, 'Design runtime should log a structured event when it blocks a pre-discovery build tool');
assert.match(remoteDesign, /Tool error: discovery question required before building/, 'Design model should receive an explicit tool error when it skips the Questions step');
assert.match(js, /shared composer handles the brief and all controls[\s\S]*function buildBriefScreen\(\)[\s\S]*focusComposerInput\(\)/, 'Design brief should rely on the shared composer instead of a local input/control stack');
assert.match(js, /function buildBriefScreen\(\)[\s\S]*Composer\.buildDesignGalleryInline/, 'Design empty brief should render the gallery directly below the prompt');
assert.doesNotMatch(js, /Open gallery/, 'Design brief should not require an Open gallery toggle');
assert.doesNotMatch(html + js, /brief-field|brief-input|brief-chips|brief-ctrls|brief-sel|chip-sg|brief-wd/, 'Design brief should not keep duplicate local controls now that the shared composer owns them');
assert.match(js, /Store\.subscribe\('activeChat'[\s\S]*openConversation\(conv, \{ deferRestore: true \}\)[\s\S]*restoreIfNeeded: false/, 'Switching Agent/Design sidebar conversations should be view-only instead of restoring the KV session immediately');
assert.match(js, /function needsSessionRestoreBeforeSend\(conv, prompt\)[\s\S]*conv\.sessionSha[\s\S]*liveConvId !== conv\.id/, 'Agent/Design should restore a saved KV session lazily before the next real send');
assert.match(js, /function restoreBeforeSend\(conv, prompt, displayOverride, opts = \{\}\)[\s\S]*pendingAfterRestore[\s\S]*issueSwitch\(conv\)/, 'Lazy session restore should queue the user prompt and run /switch first');
assert.match(js, /function editUserMessage\(chatId, msgId, content, attachments = null\)/, 'User chat messages should be editable while preserving attachments');
assert.match(js, /data-act': 'edit-user-message'/, 'User message bubbles should expose an edit action');
assert.match(html, /\.msg-edit-button[\s\S]*position: absolute/, 'User message edit button should float beside the bubble without adding vertical space');
assert.match(html, /\.msg--user::before[\s\S]*right: 100%;[\s\S]*width: 46px;/, 'User message hover target should extend beside the bubble so the pencil appears from the side');
assert.match(html, /\.msg-edit-button:hover,[\s\S]*\.msg-edit-button:focus-visible/, 'User message edit button should stay visible when hovered outside the bubble');
assert.match(js, /class: 'msg-edit-button'[\s\S]*iconSvg\('refine', 14\)/, 'User message edit action should render as a pencil icon');
assert.doesNotMatch(js, /data-act': 'edit-user-message'[\s\S]{0,240}text: 'Edit'/, 'User message edit action should not add a text row under the bubble');
assert.match(html, /\.msg-edit__input/, 'User message edits should happen inline inside the message bubble');
assert.match(html, /\.msg-edit__input[\s\S]*resize: none;/, 'User message edit textarea should not show a resize handle');
assert.match(html, /\.msg--editing[\s\S]*background: transparent/, 'User message edit mode should not wrap attachments and editor in one large bubble');
assert.match(js, /function buildInlineUserEditor\(m, chat\)/, 'User message edits should render an inline editor');
assert.match(js, /if \(m\.attachments\?\.length\) article\.append\(buildAttachments\(m\.attachments, 'user'\)\);[\s\S]*article\.append\(el\('div', \{ class: 'msg-edit' \}/, 'User message edit mode should render attachments above the editor box');
assert.match(js, /data-act': 'save-user-edit'/, 'Inline user message editor should expose a save action');
assert.doesNotMatch(js, /startEditingUserMessage\(msgId\)/, 'User message edits should not load into the composer');
assert.match(js, /function fmtElapsedCompact\(ms\)/, 'Chat responses should format elapsed time compactly');
assert.match(js, /text: fmtElapsedCompact\(u\.elapsedMs \|\| m\.elapsedMs\)/, 'Chat response metadata should show elapsed time beside token usage');
assert.match(js, /Store\.commitMessage\(chat\.id, asst\.id,[\s\S]*elapsedMs,/, 'Chat response elapsed time should be persisted on the assistant message');
assert.match(js, /const streaming = !!chat\?\.id && Store\.isChatStreaming\(chat\.id\);[\s\S]*const stick = forceBottom \|\| shouldAutoFollow\(chat\?\.id\) \|\| \(!streaming && shouldStickToBottom\(root\)\);/, 'Chat render should not reacquire bottom-follow while a message is streaming');
assert.match(js, /const stick = shouldAutoFollow\(followBottomChatId\);/, 'Live chat streaming should only auto-scroll when the user is still following the stream');
assert.match(js, /CHAT_FILE_OUTPUT_PROTOCOL/, 'Chat should instruct the model how to emit downloadable files');
assert.match(js, /Emit downloadable file\(s\) only when the user explicitly asks/, 'Generated files should require an explicit model-level file request');
assert.match(js, /A programming language or format phrase such as "in C", "in Python", "as Markdown", "in JSON" or "HTML example" is not by itself a request for a downloadable file/, 'Language or format wording should not be treated as a download request');
assert.match(js, /Do not emit downloadable files for normal answers, code snippets, examples, translations or explanations/, 'Normal code answers should stay inline unless the user asks for a file');
assert.match(js, /package the most recent relevant answer or artifact already in the conversation; do not rewrite, regenerate or invent a new version/, 'Follow-up file requests should package the prior answer instead of regenerating it');
assert.match(js, /use exactly ```dstudio-files, not ```json/, 'Generated file protocol should tell the model not to use a json fence for file payloads');
assert.match(js, /Never print the file body outside the JSON content field[\s\S]*literal \\\\n, \\\\t, or ``` markers/, 'Generated file protocol should prohibit visible escaped file dumps');
assert.match(js, /function extractGeneratedFilesFromAssistant\(text\)/, 'Chat should parse model-emitted generated file blocks');
assert.match(js, /function parseGeneratedFilePayload\(raw\)/, 'Generated file parsing should validate the structured files schema');
assert.match(js, /function recoverLooseGeneratedMarkdown\(text\)[\s\S]*escapedLines < 6[\s\S]*generated\.md/, 'Generated file parsing should recover malformed escaped markdown dumps as a file card');
assert.match(js, /function stripReasoningTagFragments\(text\)/, 'Visible assistant content should remove stray reasoning tag fragments');
assert.match(js, /replace\(\/<\\\/\?\(\?:think\|reasoning\|analysis\)>\/gi, ''\)/, 'Stray reasoning tags should not leak into assistant content');
assert.match(js, /lang !== 'dstudio-files' && lang !== 'json'/, 'Generated file parsing should tolerate json fences when the model emits the files schema');
assert.match(js, /if \(!parsedFiles\.length\) return match;/, 'Generated file parsing should leave ordinary json/code fences visible');
assert.match(js, /content = content\.replace\([^,]+\$\/i, \(match, info, raw\) =>/, 'Generated file parsing should tolerate an unclosed final file fence');
assert.match(js, /function stripGeneratedFilePayloadPreview\(text\)/, 'Streaming should hide generated file payloads until they become file cards');
assert.match(js, /setMarkdown\(content, stripGeneratedFilePayloadPreview\(fullContent\)\)/, 'Streaming renderer should not show dstudio-files JSON as a giant code block');
assert.match(js, /function buildGeneratedFiles\(files\)/, 'Assistant messages should render generated files as chat cards');
assert.match(html, /<aside id="artifact-canvas" class="artifact-canvas"/, 'Generated files should open in a non-modal artifact canvas sidebar');
assert.match(html, /body\.artifact-open \.app[\s\S]*grid-template-columns: var\(--sidebar-w\) minmax\(0, 1fr\) clamp\(360px, 38vw, 720px\)/, 'Artifact canvas should resize the app grid instead of overlaying chat');
assert.match(html, /\.artifact-canvas[\s\S]*grid-column: 3;[\s\S]*position: relative;[\s\S]*transform: translateX\(22px\)/, 'Artifact canvas should be attached to the app grid on the right');
assert.match(html, /body\.artifact-open \.artifact-canvas\.open[\s\S]*transform: none/, 'Artifact canvas should be collapsible with an open class');
assert.match(html, /id="artifact-canvas-download"/, 'Artifact canvas should expose a download button');
assert.doesNotMatch(html, /id="artifact-canvas-lsp"|id="artifact-canvas-symbols"/, 'Artifact canvas should not show a separate LSP/symbol panel');
assert.match(js, /const ArtifactCanvas = \(\(\) =>/, 'Generated files should be previewed through the artifact canvas controller');
assert.match(js, /function generatedFileIsMarkdown\(file\)[\s\S]*text\/markdown[\s\S]*if \(isMarkdown\) \{[\s\S]*setMarkdown\(body, file\.content \|\| ''\)/, 'Artifact canvas should render Markdown files as Markdown instead of raw monospace text');
assert.match(html, /id="artifact-canvas-content" class="artifact-canvas__content"/, 'Artifact canvas content should be a renderable container instead of a raw pre-only surface');
assert.match(js, /panel\.classList\.add\('open'\)/, 'Artifact canvas controller should open the sidebar without a modal backdrop');
assert.match(js, /document\.body\.classList\.add\('artifact-open'\)/, 'Artifact canvas should mark the body so the grid can allocate the sidebar column');
assert.match(js, /document\.body\.classList\.remove\('artifact-open'\)/, 'Closing the artifact canvas should restore full chat width');
assert.match(js, /return \{ open, close \};/, 'Artifact canvas close must be exposed to route changes');
assert.match(js, /if \(qs\('#messages'\)\?\.hidden\) return;/, 'Artifact canvas must not open while the Chat view is hidden');
assert.match(js, /if \(m !== 'server'\) ArtifactCanvas\.close\(\);/, 'Switching away from Chat should close generated-file canvas');
assert.match(js, /generatedFileLanguage\(file\)/, 'Artifact canvas should detect code files');
assert.match(js, /highlightCode\(file\.content \|\| '', lang\)/, 'Artifact canvas should syntax-highlight generated code files');
assert.doesNotMatch(js, /codeLineSymbols|scrollArtifactCodeToLine|artifact-canvas-symbols/, 'Artifact canvas should not keep the removed visible symbol outline plumbing');
assert.doesNotMatch(js, /artifact-canvas-dialog[\s\S]*showModal/, 'Artifact canvas should not use a blocking modal dialog');
assert.match(js, /data-act': 'open-generated-file'/, 'Generated file cards should open the artifact canvas from chat');
assert.match(js, /if \(file\) ArtifactCanvas\.open\(file\)/, 'Generated file card clicks should open the canvas instead of downloading immediately');
assert.match(js, /function openGeneratedFilesCanvas\(files\)[\s\S]*requestAnimationFrame\(\(\) => ArtifactCanvas\.open\(file\)\)/, 'Generated file responses should have a dedicated artifact canvas auto-open helper');
assert.match(js, /Messages\.renderChat\(Store\.getChat\(chat\.id\), \{ stickToBottom \}\);[\s\S]*openGeneratedFilesCanvas\(generated\.files\);/, 'Generated file responses should open the artifact canvas automatically after the final render');
assert.match(js, /buildFileTileIcon\(\)[\s\S]*msg-attachment__name[\s\S]*attachmentKindLabel\(\{ name: f\.filename, type: f\.mime \}\)/, 'Generated file cards should use the same readable file tile layout as attachments');
assert.match(js, /function makeSimplePdfBlob\(text, title = 'DStudio file'\)/, 'PDF file requests should be packaged locally from model-provided content');
assert.match(js, /generatedFiles: generated\.files\.length \? generated\.files : undefined/, 'Generated files should be persisted on assistant messages');

assert.match(html, /agent-elapsed/, 'Agent and Design responses should render elapsed time');
assert.match(js, /function startTurnTimer\(targetConvId, responseIndex\)/, 'Agent and Design turns should start an elapsed timer on send');
assert.match(js, /Store\.setChatMeta\(conv\.id, \{ turnElapsed: next \}\)/, 'Agent and Design elapsed time should persist as conversation metadata');
assert.match(js, /buildElapsed\(elapsed\)/, 'Persisted Agent and Design elapsed time should render under responses');
assert.match(js, /class: 'agent-elapsed--live',[\s\S]*formatElapsed\(performance\.now\(\) - liveTurnStartedAt\)/, 'Live Agent and Design turns should show elapsed time while working');
assert.match(js, /const prog = performance\.now\(\) - progAt < 150[\s\S]*if \(prog\) \{ lastTop = s\.scrollTop; return; \}/, 'Agent scroll should ignore programmatic movement before changing follow-bottom state');
assert.match(js, /deferFileOps: working/, 'Live Agent and Design tails should defer full file diffs while streaming');
assert.match(js, /deferFreeText: working/, 'Live Agent and Design tails should hide unstable free text while the agent is still streaming');
assert.match(js, /deferFallbackToolText: working/, 'Live Agent and Design tails should stream structured reasoning/tool blocks while hiding raw fallback tool lines');
assert.match(js, /const drainingAfterMarker = !!delta && wasWorking && !backendWorking;[\s\S]*working = backendWorking \|\| drainingAfterMarker;/, 'Agent UI should stay busy while buffered output drains after the backend completion marker');
assert.doesNotMatch(js, /seg\.kind === 'reasoning'\) \{\s*if \(deferLiveText\) return;/, 'Live Agent and Design tails should not hide reasoning until the final transcript render');
assert.match(js, /seg\.kind === 'tool_text'\) \{[\s\S]*if \(deferLiveText \|\| deferFallbackToolText\) return;/, 'Live Agent and Design tails should suppress raw fallback tool/prose while streaming');
assert.match(js, /seg\.text && seg\.text\.trim\(\)\) \{[\s\S]*if \(deferFreeText\) return;/, 'Live Agent and Design tails should not render raw free-text payloads before the turn is stable');
assert.doesNotMatch(js, /activity\.push\(\{ t: 'say'/, 'Design generating activity should not stream raw free text as a live block');
assert.match(js, /function syncLiveTailChildren\(target, draft\)/, 'Live Agent and Design tails should morph DOM in place instead of flashing every update');
assert.match(js, /syncLiveTailChildren\(liveTail\.el, draft\)/, 'Live Agent and Design tails should update through the stable morph path');
assert.doesNotMatch(js, /function paintLiveTail\(\) \{[\s\S]{0,180}liveTail\.el\.replaceChildren\(\)/, 'Live Agent and Design tails must not clear and rebuild the whole live DOM on every frame');
assert.match(js, /const fileOpHasResult = \(idx, name\) =>[\s\S]*s\.kind === 'tool_result'/, 'Live file diffs should become visible as soon as the matching tool result arrives');
assert.match(js, /const fileOpPending = fileOp && deferFileOps && !fileOpHasResult\(segIdx, seg\.ev\.name\)/, 'Live file writes should stay pending only while the write event is incomplete');
assert.match(js, /function buildDiffPending\(ev\)/, 'Live file writes should render a compact pending state instead of raw partial diffs');
const diffCardCss = html.match(/\.diffcard \{[^}]*\}/)?.[0] || '';
const diffBodyCss = html.match(/\.diff-body \{[^}]*\}/)?.[0] || '';
assert.ok(diffCardCss, 'File diff container CSS missing');
assert.ok(diffBodyCss, 'File diff body CSS missing');
assert.match(diffCardCss, /overflow:\s*visible/, 'Completed write/edit/delete blocks should flow inline in the chat');
assert.doesNotMatch(diffCardCss, /overflow:\s*hidden/, 'Completed write/edit/delete blocks must not clip into a card');
assert.match(diffBodyCss, /max-height:\s*none/, 'Completed write/edit/delete blocks should not have an internal height cap');
assert.match(diffBodyCss, /overflow:\s*visible/, 'Completed write/edit/delete blocks should use the main chat scroll');
assert.doesNotMatch(diffBodyCss, /overflow:\s*auto/, 'Completed write/edit/delete blocks must not create an internal scrollbar');
assert.match(readme, /### Chat[\s\S]*assets\/demo\.gif/, 'README should feature the chat demo GIF in the Chat section');
assert.match(readme, /## Search & Deep Research[\s\S]*assets\/search\.gif[\s\S]*Web Search[\s\S]*Deep Research/, 'README should feature the Search/Deep Research demo GIF in its own section');
assert.match(readme, /### Agent[\s\S]*assets\/agent\.gif/, 'README should feature the agent demo GIF in the Agent section');
assert.match(readme, /## Skills: local task recipes[\s\S]*assets\/skills\.png[\s\S]*user skills[\s\S]*shipped skills[\s\S]*imported cybersecurity skills/, 'README should feature the Skills screenshot and explain local skill catalogs');
assert.match(readme, /## GSA: guided security analysis[\s\S]*assets\/gsa\.png[\s\S]*authorized[\s\S]*selection[\s\S]*preflight[\s\S]*validation[\s\S]*report/, 'README should feature the GSA screenshot and explain the security-analysis phases');
assert.match(readme, /## Design: a studio built \*\*on\*\* ds4[\s\S]*assets\/design\.gif[\s\S]*Brief and questions[\s\S]*Generating[\s\S]*Proposal[\s\S]*Canvas and export/, 'README should feature the Design pipeline demo GIF and concise pipeline explanation');
assert.doesNotMatch(readme, /(?:💬|🔎|🤖|🧩|🛡️|🎨|📝)/u, 'README should not use decorative emoji in headings or feature sections');
assert.doesNotMatch(readme, /assets\/README%20images\/design\/(?:brief|Design|proposal|canvas)\.png/, 'README Design section should not show the old static pipeline screenshots');
assert.doesNotMatch(readme, /assets\/README%20images\/build\.png/, 'README Plan mode section should not show the old Build/Plan screenshot');
assert.match(js, /cap: 'Plan'[\s\S]*ariaLabel: 'Plan mode'/, 'Agent composer should expose Plan mode');
assert.doesNotMatch(js, /cap: 'Build'[\s\S]*ariaLabel: 'Build\s+mode'/, 'Agent composer should not expose the removed label');
assert.match(js, /PLAN MODE — create a Markdown planning file/, 'Plan mode should convert the next agent prompt into a markdown planning request');
assert.ok(js.includes('PLAN MODE\\s*[—-]\\s*create a Markdown planning file for the request above'), 'Plan mode hidden contract should be removed from displayed chat bubbles');
assert.match(js, /First response requirement:[\s\S]*question-form[\s\S]*3-5 domain-specific questions/, 'Plan mode should force a structured clarification form before writing the plan');
assert.match(js, /Each option should have value, label, and a short description explaining the tradeoff/, 'Plan mode question options should carry useful decision context');
assert.match(js, /Make every question specific to the user request/, 'Plan mode should ask project-specific questions, not generic planning prompts');
assert.match(js, /Do not ask generic project-management questions/, 'Plan mode should reject generic optimize-for/scope/constraint questions by default');
assert.match(js, /Question construction method:[\s\S]*Extract 5-8 concrete project terms[\s\S]*Classify the task/, 'Plan mode should give the model a concrete method for deriving project-specific questions');
assert.match(js, /If a question would still make sense for any unrelated project, rewrite it/, 'Plan mode should self-check and rewrite generic questions before showing them');
assert.match(js, /For software plans, ask about the actual workflow, data model, integration points, users, UI states, platform, deployment, validation, or failure behavior/, 'Plan mode should map software planning questions to the actual project surface');
assert.match(js, /Switcher\.planArmed[\s\S]*!\(Switcher\.planPending && Switcher\.planPending\(\)\)[\s\S]*Switcher\.planArm/, 'Question answers should continue the pending plan instead of arming a new Plan turn');
assert.match(js, /Switcher\.planPending && Switcher\.planPending\(\) && !activeQuestionKey/, 'Plan mode should not show completion actions while a clarification card is active');
assert.match(js, /showPlanActions\(info\)/, 'Plan mode should show post-plan action choices');
assert.match(js, /Implement plan[\s\S]*Stay in plan mode[\s\S]*Chat about this/, 'Plan mode completion card should offer implement, continue planning, or chat actions');
assert.match(html, /\.md li\.task-list-item[\s\S]*\.task-list-label/, 'Markdown renderer should style task-list checkboxes used by plans');
assert.match(js, /li\[3\]\.match\(\/\^\\\[\( \|x\|X\)\\\]\\s\+\(\.\*\)\$\/\)/, 'Markdown renderer should parse GitHub-style task list items');
const switchPlanBody = js.match(/function switchPlan\(val\) \{[\s\S]*?\n      \}/)?.[0] || '';
assert.ok(switchPlanBody, 'switchPlan body missing');
assert.doesNotMatch(switchPlanBody, /restartCurrent\(/, 'Switching Plan mode should not restart the agent');
assert.doesNotMatch(js, /build: 'off'/, 'Agent/Design launch payloads should not carry removed planning-build state');
assert.doesNotMatch(launcher, new RegExp('g_' + 'build_mode|api_' + 'build_|/api/' + 'build'), 'Plan mode should not exist as a backend launch mode or helper endpoint');
assert.doesNotMatch(readme, new RegExp('Build\\\\s+mode for real web apps|guided app ' + 'builder|runnable web ' + 'app'), 'README should no longer market the removed app-generation flow');
assert.match(js, /function activeConversationForMode\(targetMode\)/, 'Agent/Design must explicitly bind a conversation for the current mode before sending');
assert.match(js, /const conv = activeConversationForMode\(viewMode\)/, 'Agent/Design startup must not reuse a chat from another mode');
assert.match(js, /if \(agentBusy\) \{[\s\S]*AgentView\.reconcileIdle/, 'Agent composer must reconcile stale busy state instead of silently dropping input');
assert.match(js, /toast\('Answer the question card first\.'/, 'Agent question mode must give feedback instead of silently swallowing input');
assert.match(js, /async function reconcileIdle\(\)/, 'Agent view should recover when the backend is idle but the UI is still marked busy');
assert.match(js, /function displayedWorking\(\)[\s\S]*return working && !!convId && convId === liveConvId;/, 'Agent visible busy state should belong only to the displayed live conversation');
assert.match(js, /function syncComposerBusy\(\)[\s\S]*Composer\.setAgentBusy\(activeView && displayedWorking\(\)\)/, 'Agent composer stop button should not follow unrelated backend work');
assert.match(js, /else if \(displayedWorking\(\)\)[\s\S]*buildAgentWorking\(\)/, 'Agent working footer should not render on a non-live new session');
assert.match(js, /function stopLiveGeneration\(opts = \{\}\)[\s\S]*streamAbort\.abort\(\)[\s\S]*Engine\.agentInterrupt\(reason, status\)/, 'Stopping Agent should abort the old SSE stream and clear backend work');
assert.match(js, /async function startNewSession\(target, wd\)[\s\S]*await AgentView\.stopLiveGeneration\(\{[\s\S]*new session started by user[\s\S]*status: 'incomplete'/, 'New Agent/Design sessions should interrupt an in-flight turn before creating the fresh session');
assert.match(js, /async function agentInterrupt\(reason = '', status = ''\)[\s\S]*body\.reason = reason[\s\S]*body\.status = status[\s\S]*JSON\.stringify\(body\)/, 'Agent interrupt API should carry explicit reason/status to the backend');
assert.match(js, /if \(!r\.ok && data && !data\.error\) data\.error = `send \$\{r\.status\}`/, 'Agent send should surface HTTP failures from the launcher');
assert.match(js, /Switcher\.wirePromptForRuntime \? Switcher\.wirePromptForRuntime\(prompt, opts\.forceThink\) : prompt/, 'AgentView must call the runtime prompt adapter through Switcher, not as an out-of-scope function');
assert.match(js, /return \{[\s\S]*wirePromptForRuntime,[\s\S]*planArmed/, 'Switcher should expose the runtime prompt adapter and Plan driver used by AgentView');
assert.match(js, /function runtimeIsSlashCommand\(t\)/, 'Switcher runtime prompt adapter must not depend on AgentView-only slash helpers');
assert.doesNotMatch(js.match(/function wirePromptForRuntime\(prompt, forceThink = ''\) \{[\s\S]*?\n      \}/)?.[0] || '', /isSlashCommand\(/, 'wirePromptForRuntime should use its own slash helper in Switcher scope');
assert.match(launcher, /api_agent_send_state_error/, 'Backend agent send failures should include engine state');
assert.match(launcher, /agent\/design runtime is not active/, 'Backend should report inactive Agent/Design runtime explicitly');
assert.match(launcher, /Engine process stopped before completing the turn[\s\S]*g_agent_working = 0;/, 'Backend should make child crashes visible and clear Agent/Design working state');
assert.match(js, /appendLocalSendFailure\(displayPrompt, msg, thisSend\)/, 'Agent/Design send failures should be persisted in the transcript');
assert.match(js, /target} did not start[\s\S]*\/api\/status reports mode=/, 'Startup should fail visibly if /api/status disagrees with the requested mode');

assert.match(js, /copy\.lanMirror\s*=\s*true/, 'LAN mirror rows should be marked read-only');
assert.match(js, /for \(const mode of \['chat', 'agent', 'design'\]\)/, 'mirror sync must cover chat, agent and design');
assert.match(html, /chat-item__lan/, 'sidebar should render the LAN badge for mirrored chats');
assert.match(js, /LAN mirrored chats are read-only/, 'mirrored chats must not be editable from the host');

const lanDialog = html.match(/<dialog id="lan-client-settings-dialog"[\s\S]*?<\/dialog>/)?.[0] || '';
assert.ok(lanDialog, 'LAN client settings dialog missing');
assert.match(lanDialog, /Change LAN/, 'LAN client settings should allow changing host');
assert.match(lanDialog, /Switch to host/, 'LAN client settings should allow switching to host mode');
assert.match(lanDialog, /id="lan-client-theme"/, 'LAN client settings should allow local theme changes');
assert.doesNotMatch(lanDialog, /Exit LAN/, 'LAN client settings should not use the old Exit LAN label');
assert.doesNotMatch(lanDialog, /Model|Network access|System prompt|Conversations/, 'LAN client settings should not expose host settings');
assert.match(js, /function switchToHostMode\(\)/, 'LAN client mode needs an explicit host switch flow');
assert.match(js, /window\.location\.href = '\/loading\.html'/, 'Switch to host should pass through the local loading gate');

const settingsDialog = html.match(/<dialog id="settings-dialog"[\s\S]*?<dialog id="lan-client-settings-dialog"/)?.[0] || '';
assert.match(settingsDialog, /Network access/, 'host settings should keep the LAN toggle');
assert.match(settingsDialog, /Connect to LAN/, 'settings should allow entering LAN client mode');

assert.match(loadingHtml, /lanClientHost/, 'loading gate must skip when this browser is a LAN client');
assert.match(loadingHtml, /settings\.onboarded !== true/, 'loading gate should wait until host onboarding is complete');
assert.match(loadingHtml, /hello are you alive\?/, 'loading gate should probe the local model');
assert.match(loadingHtml, /class="logo"[\s\S]*id="loading-progress"[\s\S]*id="loading-bar"[\s\S]*id="loading-stage"[\s\S]*id="loading-pct"/, 'loading page should show the DStudio logo above a labeled progress bar');
assert.match(loadingHtml, /showProgress\(st\.loadPct,[\s\S]*st\.stage/, 'loading progress should consume the launcher percentage and stage');
assert.match(loadingHtml, /idlePolls >= 3[\s\S]*location\.replace\('\/'\)/, 'loading gate should open the workspace instead of waiting forever when no engine launch is active');
assert.doesNotMatch(loadingHtml, /class="mark"|@keyframes spin/, 'loading page should not use the old rotating mark');

assert.match(gitignore, /^\/ds4\/$/m, 'managed upstream ds4 checkout should stay out of the DStudio source tree');
assert.match(launcher, /#define DS4_REPO_URL "https:\/\/github\.com\/antirez\/ds4"/, 'launcher should know the upstream ds4 repo URL');
assert.match(launcher, /#define DS4_UPSTREAM_COMMIT "efdadd41e20134af4f3381e1ed90e96fe4faef6f"/, 'managed ds4 setup should pin the current upstream commit in code');
assert.match(launcher, /#define DS4_ARCHIVE_URL "https:\/\/codeload\.github\.com\/antirez\/ds4\/tar\.gz\/" DS4_UPSTREAM_COMMIT/, 'managed ds4 setup should download a pinned GitHub source archive');
assert.match(launcher, /static int ds4_server_compatible\(int port\)[\s\S]*GET \/v1\/models[\s\S]*owned_by/, 'launcher should identify a compatible DS4 server before reusing an occupied engine port');
assert.match(launcher, /ds4_server_compatible\(ENGINE_DEFAULTS\.port\)[\s\S]*g_mode = ENGINE_SERVER;[\s\S]*g_ready = 1;/, 'startup should adopt a compatible DS4 engine already running locally');
assert.match(launcher, /static char\s+g_ds4_dir\[1024\]\s*=\s*"ds4"/, 'default ds4 folder should be managed inside the DStudio repo');
assert.match(launcher, /static int default_ds4_dir\([\s\S]*"%s\/ds4"/, 'default ds4 path should resolve under the DStudio checkout');
assert.match(launcher, /setup_download_ds4_archive[\s\S]*"curl"[\s\S]*"tar", "-xzf"/, 'setup helper should use curl+tar, not git, to download source archives');
assert.match(launcher, /setup_download_ds4_archive\(DS4_ARCHIVE_URL, DS4_UPSTREAM_COMMIT/, 'setup endpoint should pass the pinned DS4 archive to the download helper');
assert.doesNotMatch(launcher, /"git"\s*,\s*"clone"|git clone|Install git/, 'managed ds4 setup must not require git');
assert.match(launcher, /static int setup_run_cmd_capture[\s\S]*#ifdef _WIN32[\s\S]*CreateProcessA[\s\S]*PeekNamedPipe/, 'managed ds4 setup should capture command output on Windows');
assert.match(launcher, /setup_prepare_ds4_windows[\s\S]*setup_windows_engine_ready[\s\S]*setup_windows_build_ds4/, 'managed ds4 setup should prepare Windows DS4 from packaged binaries or source build');
assert.match(launcher, /setup_windows_build_ds4[\s\S]*build-ds4-windows-cygwin\.sh/, 'Windows managed setup should build the downloaded ds4 source through the existing MSYS2/Cygwin script');
assert.doesNotMatch(launcher, /managed ds4 download\/build is not implemented in the Windows launcher yet/, 'managed ds4 setup should not be disabled on Windows');
assert.match(launcher, /static int setup_ensure_gguf_dir[\s\S]*setup_gguf_dir_path[\s\S]*mkdir\(path, 0755\)[\s\S]*could not create model folder/, 'managed ds4 setup should create the gguf model folder automatically');
assert.match(launcher, /setup_send_json[\s\S]*ggufDirOk[\s\S]*setup_gguf_dir_ok_path/, 'setup endpoint JSON should expose whether the gguf folder exists');
assert.match(launcher, /api_setup_ds4[\s\S]*setup_ensure_gguf_dir\(gguf_err, sizeof gguf_err\)/, 'setup endpoint should ensure ds4/gguf exists before returning success');
assert.match(launcher, /api_setup_ds4[\s\S]*run_build_jsonl\("build"\)/, 'setup endpoint should apply the external JSONL/web patch build');
assert.match(launcher, /api_setup_ds4[\s\S]*run_ext_script\("extension\/design\/build-design\.sh", "build"\)/, 'setup endpoint should build the Design runtime after ds4 setup');
assert.match(launcher, /!strcmp\(path, "\/api\/ds4\/setup"\)[\s\S]*api_setup_ds4\(fd\)/, 'launcher should expose POST /api/ds4/setup');
assert.doesNotMatch(launcher, /\/api\/ds4dir|api_set_ds4dir/, 'launcher should not keep the old manual ds4dir endpoint');
assert.match(launcher, /"setup-ds4"/, 'doctor should offer managed ds4 setup when the engine folder is missing');
assert.match(html, /id="onboard-ds4dir-setup-btn"/, 'onboarding should offer one-click ds4 install');
assert.match(html, /id="onboard-model-recheck"/, 'onboarding model section should offer an explicit Recheck button');
assert.match(html, /id="onboard-lan-ds4dir-setup"[\s\S]*Install ds4/, 'LAN onboarding should offer local ds4 install for Agent/Design');
assert.match(html, /id="onboard-lan-ds4dir-path"/, 'LAN onboarding should show the managed local ds4 runtime path');
assert.doesNotMatch(html, /<h3>Folders<\/h3>|Good to know/, 'onboarding should stay compact without explanatory Folders or Good to know sections');
assert.match(html, /\.dialog--wide\s*\{[\s\S]*width:\s*min\(97vw,\s*58rem\)/, 'onboarding dialog should be slightly larger');
assert.doesNotMatch(html, /\.onboard__dl\s*\{[^}]*border-top/, 'onboarding model download row should not draw a divider');
const onboardingLocal = html.match(/<div id="onboard-local-panel"[\s\S]*?<section class="onboard__sec" id="onboard-model-sec">/)?.[0] || '';
assert.match(onboardingLocal, /id="onboard-ds4dir"[\s\S]*id="onboard-conn"/, 'onboarding should show the engine directory before the connection status');
assert.doesNotMatch(onboardingLocal, /onboard__status-k/, 'onboarding connection status should not duplicate the Engine heading');
assert.match(html, /id="ds4dir-setup"/, 'forced ds4 gate should offer one-click ds4 install');
assert.doesNotMatch(html, /id="onboard-ds4dir-browse-btn"|id="onboard-ds4dir-browse"|id="ds4dir-input"|id="ds4dir-save"|id="lan-client-ds4dir-choose"/, 'UI should not keep manual ds4 folder fallback controls');
assert.match(js, /async function setupReadyEnoughToSkipOnboarding\(\)[\s\S]*Engine\.doctor\(\)[\s\S]*Number\(d\.fatal \|\| 0\) === 0[\s\S]*Engine\.status\(\)/, 'onboarding first-run gate should consult Doctor/status before showing');
assert.match(js, /onboarded:\s*'ds4web\.onboarded\.v1'/, 'onboarding should have a durable marker independent from settings');
assert.match(js, /function onboardingComplete\(\)[\s\S]*state\.settings\.onboarded === true[\s\S]*onboardingMarkerDone\(\)[\s\S]*hasLocalConversationHistory\(\)/, 'onboarding completion should survive settings reset when marker or local history exists');
assert.match(js, /function markOnboarded\(\)[\s\S]*writeKey\(STORAGE_KEYS\.settings, JSON\.stringify\(state\.settings\)\)[\s\S]*persistOnboardingMarker\(\)/, 'onboarding completion should write settings and the durable marker immediately');
assert.match(js, /async function maybeShowInitialOnboarding\(\)[\s\S]*Store\.onboardingComplete\(\)[\s\S]*Store\.markOnboarded\(\)[\s\S]*setupReadyEnoughToSkipOnboarding\(\)[\s\S]*Store\.markOnboarded\(\)[\s\S]*if \(document\.querySelector\('dialog\[open\]'\)\) setTimeout\(tryShow, 400\)/, 'onboarding should never reopen for a completed setup and should mark a ready local setup as onboarded');
assert.match(js, /if \(!lanClientLanding\) maybeShowInitialOnboarding\(\)/, 'onboarding mount should use the idempotent first-run gate');
assert.match(js, /on\(dialog, 'cancel', \(e\) => e\.preventDefault\(\)\)/, 'onboarding should not close when Escape is pressed');
assert.match(js, /await refreshLocalSetupState\(\)/, 'onboarding Start should refresh /api/status before deciding it can close');
assert.match(js, /async function refreshLocalSetupState\(\)[\s\S]*Engine\.status\(\)[\s\S]*applyLocalSetupStatus\(st\)/, 'onboarding Start status refresh should repaint the live ds4 state');
assert.match(js, /const localVisible = !lanPanel \|\| lanPanel\.hidden;[\s\S]*!completingOnboarding && localVisible && forcedSetup && !lastDs4Ok/, 'onboarding close guard should only reopen for an incomplete Local setup');
assert.match(js, /let startResult = null;[\s\S]*await Engine\.start\(\{ mode: 'server', gguf: selectedGguf \}, true\)[\s\S]*startResult\.ok === false[\s\S]*Could not start selected model/, 'onboarding Start must show /api/start failures instead of silently closing');
assert.match(js, /function setSettingsNow\(patch\)[\s\S]*persistSettings\.cancel\(\)[\s\S]*writeKey\(STORAGE_KEYS\.settings, JSON\.stringify\(state\.settings\)\)/, 'settings still support an immediate write before navigation');
assert.match(js, /let shouldShowLoading = false;[\s\S]*shouldShowLoading = true;[\s\S]*if \(shouldShowLoading && !isLanClientMode\(\)\) location\.href = '\/loading\.html'/, 'onboarding Start should only show loading after it actually starts a different model');
assert.match(js, /async function connectLanAddress\(\)[\s\S]*await connectLanClientMode\(lanAddressInput\.value\)[\s\S]*completingOnboarding = true;[\s\S]*Store\.markOnboarded\(\);[\s\S]*dialog\.close\(\)/, 'LAN onboarding connect should complete onboarding only after a valid LAN health check');
assert.doesNotMatch(html, /onboard__cmd|onboard__list|fsfinder/, 'onboarding should not keep CSS for removed manual setup/finder UI');
assert.match(js, /delete state\.settings\.lanClientDs4Dir/, 'settings migration should remove the old LAN client ds4 folder cache key');
assert.match(js, /async function setupDs4\(\)[\s\S]*\/api\/ds4\/setup/, 'Engine API should call the managed ds4 setup endpoint');
assert.match(js, /async function setupDs4FromUi\(\)[\s\S]*Engine\.setupDs4\(\)/, 'onboarding setup button should call the managed setup endpoint');
assert.match(js, /function availableModelDownloads\(ggufs\)[\s\S]*MODEL_DOWNLOADS\.filter[\s\S]*d\.match\.test\(file\)/, 'download picker should hide model targets already present in the engine folder');
assert.match(js, /function renderSetModels\(\)[\s\S]*const choices = availableModelDownloads\(ggufs\)/, 'settings model download picker should use only missing model targets');
assert.match(js, /function renderModels\(\)[\s\S]*const choices = availableModelDownloads\(ggufs\)/, 'onboarding model download picker should use only missing model targets');
assert.match(js, /async function recheckModels\(\)[\s\S]*refreshModels\(\)[\s\S]*loadGgufs\(\)/, 'onboarding model Recheck should rescan status and GGUF files');
assert.match(js, /async function setupOnboardLanDs4\(\)[\s\S]*Engine\.setupDs4\(\)/, 'LAN onboarding local ds4 install should use the managed setup endpoint');
assert.match(html, /\.onboard__ctx[\s\S]*background-image:\s*url[\s\S]*appearance:\s*none/, 'onboarding dropdowns should use the polished custom select styling');
assert.match(js, /'setup-ds4': 'Install'/, 'system check should label managed ds4 setup clearly');
assert.match(js, /Onboarding\.setupDs4\(\)/, 'system check setup action should launch onboarding setup directly');
assert.doesNotMatch(js, /choose-ds4|verifyPath|toggleFinder|loadFinder|PATHS/, 'UI should not keep manual ds4 path fallback code');

assert.match(js, /function classifyResearchRequest\(/, 'web research should classify the request before searching');
assert.match(searchRuntime, /function classifyResearchRequest\(/, 'Search extension should own the research classifier runtime');
assert.match(searchRuntime, /async function runResearchPipeline\(/, 'Search extension should own the shared search/deep research pipeline');
assert.match(searchRuntime, /async function runDeepResearch\(/, 'Search extension should own Deep Research runtime');
assert.match(searchRuntime, /function buildResearchReportDraft\(/, 'Deep Research should build a fact-grounded report draft before final synthesis');
assert.match(searchRuntime, /async function synthesizeResearchReport\(/, 'Deep Research should run a dedicated report synthesis writer');
assert.match(searchRuntime, /function researchReportQuality\(/, 'Deep Research synthesis should pass a quality gate before replacing the deterministic report');
assert.match(searchRuntime, /function factIdsFromFacts\(facts\)/, 'Deep Research quality gate should use fact ids instead of domain-specific term lists');
assert.match(searchRuntime, /function uncitedEvidenceLines\(report\)/, 'Deep Research should detect uncited evidence lines before accepting synthesized reports');
assert.match(searchRuntime, /factCoverage === 1/, 'Deep Research synthesized reports should cover every extracted fact id');
assert.match(searchRuntime, /uncitedLines\.length === 0/, 'Deep Research synthesized reports should require citations in evidence-backed sections');
assert.match(searchRuntime, /DEEP_RESEARCH_SYNTHESIS_OUTPUT_PROTOCOL/, 'Deep Research final reply should preserve synthesized reports instead of expanding internal context');
assert.match(searchRuntime, /function researchReportWantsTechnical\(/, 'Deep Research should decide technical report structure generically from the query and facts');
assert.match(searchRuntime, /Do not include Source map, Stack\/technical findings/, 'Deep Research should not force technical sections for general questions');
assert.match(searchRuntime, /forbiddenGeneralTechnical/, 'Deep Research quality gate should reject technical sections in general reports');
assert.match(searchRuntime, /localArtifactLeak/, 'Deep Research quality gate should reject local artifact paths in ordinary reports');
assert.match(searchRuntime, /label:\s*'Synthesize report'/, 'Deep Research trace should expose the report synthesis phase');
assert.equal(
  html.slice(html.indexOf('      /* DSTUDIO_SEARCH_EXTENSION_START */') + '      /* DSTUDIO_SEARCH_EXTENSION_START */'.length,
             html.indexOf('      /* DSTUDIO_SEARCH_EXTENSION_END */')).replace(/^\n/, '').replace(/\n$/, '') + '\n',
  searchRuntime.replace(/\s*$/, '\n'),
  'web/index.html embedded Search block should be generated from extension/search/runtime.js',
);
assert.match(js, /function planNextResearchAction\(/, 'Deep Research should use an action planner loop');
assert.match(js, /function pickSourcesToRead\(/, 'web research should use a model source picker');
assert.match(js, /function extractFactsFromPage\(/, 'web research should extract facts from read pages');
assert.match(js, /Evidence extractor retry/, 'evidence extraction should retry with a shorter model call');
assert.match(js, /Return at most 12 facts/, 'evidence extraction should avoid oversized JSON responses while covering distinct subsystems');
assert.match(js, /identity\/purpose, runtime\/server\/entrypoint\/UI\/build/, 'evidence extraction should cover technical source categories instead of generic snippets');
assert.match(js, /function readSourceUnusable\(/, 'web research should mark not-found reader pages unusable');
assert.match(js, /source returned a not-found page/, 'not-found pages should not enter evidence extraction');
assert.match(js, /function judgeResearchSufficiency\(/, 'web research should judge evidence sufficiency');
assert.match(js, /Unread source-adapter candidates/, 'research state should expose unread adapter candidates to the judge');
assert.match(js, /do not return enough while relevant unread source-adapter candidates remain/, 'judge should not stop before relevant adapters are read');
assert.match(js, /function writeFinalFromFacts\(/, 'final contexts should be built from extracted facts');
assert.match(js, /function classifySourceKind\(/, 'web research should classify source kinds before extraction');
assert.match(js, /function adapterCandidateUrls\(/, 'web research should discover source-adapter candidate URLs');
assert.match(js, /function seedAdapterCandidateSources\(/, 'read pages should seed adapter candidates for the planner');
assert.match(js, /case 'article'/, 'source adapters must support articles');
assert.match(js, /case 'product'/, 'source adapters must support products');
assert.match(js, /case 'academic'/, 'source adapters must support academic sources');
assert.match(js, /case 'social'/, 'source adapters must support social discussions');
assert.match(js, /case 'repo'/, 'repo adapter should exist as one source kind, not the whole pipeline');
assert.match(js, /Cite facts as \[F1\]/, 'final answer context should be facts-first');
assert.match(js, /Excerpt: \$\{compactText\(f\.excerpt/, 'fact context should carry supporting excerpts');
assert.match(js, /Source kind: \$\{classifySourceKind\(s/, 'model read-selection context should expose source kinds');
assert.match(js, /const explicitPending = \[\.\.\.\(sources \|\| \[\]\)\]/, 'explicit URLs should take precedence over generic mandatory reads');
assert.match(js, /if \(explicitPending\.length\) return explicitPending/, 'pending explicit URLs should be read before generic primary matches');
assert.match(js, /\.filter\(\(r\) => r\.score >= 80\)/, 'mandatory reads should only force high-confidence primary sources');
assert.match(js, /function explicitUserUrls\(/, 'web research should extract explicit user URLs before search');
assert.match(js, /function seedExplicitUrlSources\(/, 'explicit user URLs should be seeded as read candidates');
assert.match(js, /source\?\.explicit\) score \+= 220/, 'explicit user URLs should be mandatory primary reads');
assert.match(js, /source\?\.explicit\)[\s\S]*matched = true/, 'explicit user URLs should not be filtered out by exact-match ranking');
assert.match(js, /label:\s*'Read URL'/, 'explicit or selected URLs should be read before final answer');
assert.match(js, /label:\s*'Extract facts'/, 'read pages should go through fact extraction');
assert.match(js, /Avoid unrelated homonyms that merely share the same product or project name/, 'read selector should avoid unrelated homonyms after an explicit URL read');
assert.match(js, /Explicit user URL: \$\{s\.explicit \? 'yes' : 'no'\}/, 'read selector context should mark explicit user URLs');
assert.match(js, /function selectableSourcesAfterExplicitRead\(/, 'explicit URL reads should narrow later read-selection to same-family sources');
assert.match(js, /return await runResearchPipeline\(userText, settings, \{ mode: 'search', onTrace \}\)/, 'Search should run through the generic research pipeline');
assert.match(js, /return await runResearchPipeline\(userText, settings, \{ mode: 'research', onTrace, job \}\)/, 'Deep Research should run through the generic research pipeline');
assert.match(js, /const deadline = performance\.now\(\) \+ WEB_RESEARCH_TOTAL_TIMEOUT_MS/, 'Search and Deep Research should share the long research pipeline budget');
assert.match(js, /async function selectSearchReads\(/, 'normal Web Search should have a model read-selection pass');
assert.match(js, /Do not answer about a software project, repository, technical stack, docs, package, company product, or pricing from snippets alone/, 'Web Search must not answer technical/project questions from snippets only');
assert.doesNotMatch(js, /For GitHub repositories|isGithubRepoSource|githubRepoIdentity|github\.com/, 'product web pipeline must not hardcode GitHub');
assert.match(js, /mandatoryPrimaryReadSources\(plan, sources, readUrls\)/, 'Search and Deep Research should merge mandatory primary reads');
assert.match(js, /Prefer evidence from read pages over snippets; treat unread search snippets as discovery, not proof/, 'Deep Research judge must prefer read pages over snippets');
assert.match(js, /Read page: \$\{s\.read \?/, 'final web contexts should expose whether a source was actually read');
assert.match(js, /Primary-source score: \$\{sourcePrimaryReadScore\(s, plan \|\| \{ mustMatch: \[\] \}\)\}/, 'read selector context should expose primary-source priority');

console.log('ui_contract_test: ok');

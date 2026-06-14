import fs from 'node:fs';
import assert from 'node:assert/strict';

const html = fs.readFileSync('web/index.html', 'utf8');
const readme = fs.readFileSync('README.md', 'utf8');
const loadingHtml = fs.readFileSync('web/loading.html', 'utf8');
const launcher = fs.readFileSync('src/dstudio.c', 'utf8');
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
const gsaRuntime = fs.readFileSync('extension/gsa/dstudio_gsa.cfrag', 'utf8');

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
${extractFunction(js, 'normalizeRemoteLanAddress')}
return { isLoopbackHost, adaptBaseUrl, normalizeLanHostUrl, normalizeRemoteLanAddress };
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
assert.equal(helpers.normalizeRemoteLanAddress('192.168.1.207:5600'), 'http://192.168.1.207:5600/remote');
assert.throws(() => helpers.normalizeLanHostUrl(''), /Insert the LAN address/);

assert.match(gitignore, /^node_modules\/$/m, 'local node_modules should stay out of git status');
assert.match(gitignore, /^extension\/gsa\/benchmark\/$/m, 'generated GSA benchmark runs should stay out of git status');
assert.match(gitignore, /^\*\.log\.gz$/m, 'compressed local timeline/log artifacts should stay out of git status');
assert.match(gitignore, /^MEMORY\.MD$/m, 'local memory scratch files should stay out of git status');

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
assert.match(js, /body\.classList\.toggle\('hl', !!lang\)/, 'artifact code previews should enable highlight token styling');
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
assert.match(js, /async function diagnostics\(\)[\s\S]*\/api\/diagnostics/, 'Engine client should expose workspace diagnostics');
assert.match(js, /async function tasks\(limit = 50\)[\s\S]*\/api\/tasks\?limit=/, 'Engine client should expose task summaries');
assert.match(js, /async function task\(id\)[\s\S]*\/api\/task\?id=/, 'Engine client should expose task detail lookup');
assert.match(js, /async function logs\(limit = 200\)[\s\S]*\/api\/logs\?limit=/, 'Engine client should expose recent logs');
assert.match(js, /Engine\.diagnostics\(\)/, 'Doctor should fetch workspace diagnostics');
assert.match(js, /function renderDiagnostics\(diag\)/, 'Doctor should render diagnostics instead of hiding backend state');
assert.match(js, /Recent diagnostics/, 'Doctor diagnostics section should label recent task and log failures');
assert.match(launcher, /#define CYBER_SKILLS_REL_DIR "extension\/gsa\/third_party\/anthropic-cybersecurity-skills\/skills"/, 'GSA should pin the vendored cybersecurity skills catalog path');
assert.match(launcher, /DS4UI_CYBER_SKILLS_DIR/, 'agent/design child processes should receive the vendored cybersecurity skills dir');
assert.ok(Number(jsonlPatch.values.get('version')) >= 24, 'JSONL patch version should force rebuild after cybersecurity skill loader changes');
assert.match(launcher, /patch_dir_newer_than\(JSONL_PATCH_DIR, bb\.st_mtime\)/, 'JSONL runtime rebuild should notice changed patch files, not only ds4 source mtimes');
assert.match(launcher, /patch_dir_newer_than\(WEB_CDP_PATCH_DIR, bb\.st_mtime\)/, 'JSONL runtime rebuild should notice changed web helper patch files');
assert.match(launcher, /patch_dir_newer_than\(WEB_DIRECT_NAV_PATCH_DIR, bb\.st_mtime\)/, 'JSONL runtime rebuild should notice changed direct-navigation patch files');
assert.match(launcher, /static void api_skills_search\(int fd, const char \*path\)/, 'backend should expose searchable skill metadata');
assert.match(launcher, /path_eq_clean\(path, "\/api\/skills\/search"\)/, 'router should serve /api/skills/search');
assert.match(launcher, /#include "\.\.\/extension\/gsa\/dstudio_gsa\.cfrag"/, 'launcher should include the GSA extension runtime');
assert.match(gsaRuntime, /static void api_gsa_start\(int fd, const char \*body\)/, 'backend should expose GSA start');
assert.match(gsaRuntime, /static void api_gsa_tools\(int fd\)/, 'backend should expose GSA tool status');
assert.match(gsaRuntime, /static void api_gsa_tools_install\(int fd\)/, 'backend should expose managed GSA tool install');
assert.match(launcher, /path_eq_clean\(path, "\/api\/gsa\/tools"\)/, 'router should serve /api/gsa/tools');
assert.match(launcher, /\/api\/gsa\/tools\/install/, 'router should serve /api/gsa/tools/install');
assert.match(gsaRuntime, /mode\\":\\"tool-assisted/, 'GSA tool status should explicitly be tool-assisted');
assert.match(gsaRuntime, /externalToolsRequired\\":false/, 'GSA should not require external recon tools');
assert.doesNotMatch(gsaRuntime, /flashcards\/gsa-tools|LOCALAPPDATA.*gsa-tools/s, 'GSA managed tools should not install into the old shared app-data directory');
assert.match(gsaRuntime, /extension[\\/]gsa[\\/]tools[\\/]bin/, 'GSA managed tools should live under extension/gsa/tools/bin');
assert.match(gsaRuntime, /static const char \*gsa_tool_install_mode/, 'GSA should classify tool installer families');
assert.match(gsaRuntime, /missingInstaller/, 'GSA tool status should explain missing installer prerequisites');
assert.match(gsaRuntime, /notInstallable/, 'GSA tool status should count tools blocked by missing prerequisites');
assert.match(gsaRuntime, /Go is not installed; skipping Go-based tools/, 'GSA install scripts should handle missing Go explicitly');
assert.match(gsaRuntime, /Python 3 or pipx is not installed; skipping Python-based tools/, 'GSA install scripts should handle missing Python explicitly');
assert.match(gsaRuntime, /github\.com\/projectdiscovery\/subfinder/, 'GSA should include ProjectDiscovery subfinder support');
assert.match(gsaRuntime, /github\.com\/projectdiscovery\/nuclei/, 'GSA should include ProjectDiscovery nuclei support');
assert.match(gsaRuntime, /github\.com\/tomnomnom\/assetfinder/, 'GSA should include assetfinder support');
assert.match(gsaRuntime, /static int gsa_write_cyber_skill_shortlist/, 'GSA should build its shortlist from imported cybersecurity skills');
assert.match(gsaRuntime, /static char \*gsa_workspace_signals\(const char \*workdir, const char \*candidates_path\)/, 'GSA should rank imported skills with bounded workspace signals');
assert.match(gsaRuntime, /json_get_string\(body, "targetUrl", target_url/, 'GSA start should accept an optional authorized target URL');
assert.match(gsaRuntime, /gsa_extract_first_url\(mission, target_url/, 'GSA start should infer an explicit URL from the mission when the target field is empty');
assert.match(gsaRuntime, /gsa_target_url_ok\(target_url/, 'GSA start should validate target URLs before writing artifacts');
assert.match(gsaRuntime, /target_hits=%d, workspace_hits=%d/, 'GSA skill shortlist should explain target/workspace ranking signals');
assert.match(gsaRuntime, /target\.md/, 'GSA should write a target artifact for the agent to read');
assert.match(gsaRuntime, /toolStatus\.json/, 'GSA should write tool status into the run directory');
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
assert.match(gsaRuntime, /If `selection\.json` contains any non-empty `skills` array anywhere, including nested `hypotheses\[\]\.skills`, you MUST call exactly one best-matching `skill\(\\"id\\"\)` tool/, 'GSA preflight should require skill loading when Phase 1 selected skills');
assert.match(gsaRuntime, /Do not require a top-level `skills` field/, 'GSA preflight should not let the agent skip nested skill arrays');
assert.match(gsaRuntime, /do not skip skill loading silently/, 'GSA preflight should not silently skip selected skills');
assert.match(gsaRuntime, /Local-source exception: for exported cryptographic, token, signature, serializer, parser, or policy primitives/, 'GSA should not require server routes for exported primitive defects in local source reviews');
assert.match(gsaRuntime, /missing service wiring belongs in `missing_evidence`, not automatic kill criteria/, 'GSA should carry missing service wiring as a limitation for exported primitive findings');
assert.match(gsaRuntime, /authorized-local-source-review[\s\S]*exported public API is the reviewed trust boundary/, 'GSA should treat exported package APIs as the local trust boundary in source reviews');
assert.match(gsaRuntime, /For cryptographic or signature reviews, prioritize sign\/verify\/envelope\/key-registry\/policy\/canonicalization files/, 'GSA selection should prioritize crypto/signature control files');
assert.match(gsaRuntime, /For crypto\/signature hypotheses, explicitly map: tag comparison control, caller-controlled key material\/reference, registry binding, deterministic nonce\/replay policy, canonicalization, and relevant audit\/config policy/, 'GSA preflight should map crypto controls and gaps generically');
assert.match(gsaRuntime, /For crypto\/signature validation, check and cite each relevant control or gap: constant-time tag comparison, key material versus key reference/, 'GSA validation should check crypto controls without assuming the defect');
assert.match(gsaRuntime, /preserve the finding at medium\/high confidence/, 'GSA validation should not downgrade exported primitive findings solely for missing production wiring');
assert.match(gsaBenchRunner, /Local-source exception: for exported cryptographic, token, signature, serializer, parser, or policy primitives/, 'GSA benchmark repair prompts should preserve exported primitive findings');
assert.match(gsaBenchRunner, /missing service wiring as automatic kill criteria/, 'GSA benchmark finalizers should not auto-kill exported primitive defects');
assert.match(gsaBenchRunner, /findingHasExportedPrimitiveEvidence/, 'GSA benchmark guardrails should recognize exported primitive reachability');
assert.match(gsaBenchRunner, /HTTP route, controller, or service wiring is missing/, 'GSA benchmark validation repair should handle missing app wiring as a limitation for local source reviews');
assert.match(gsaBenchRunner, /downstream consumer/, 'GSA benchmark should treat missing downstream consumers as a limitation for exported primitive source reviews');
assert.match(gsaRuntime, /do not copy its body, glossary or examples into your answer/, 'GSA preflight should not echo full skill content');
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
assert.match(gsaBenchRunner, /phaseThinkLevel\("selection-finalize", opts\)/, 'GSA selection finalize should use the configured thinking level');
assert.match(gsaBenchRunner, /phaseThinkLevel\("preflight-finalize", opts\)/, 'GSA preflight finalize should use the configured thinking level');
assert.match(gsaBenchRunner, /phaseThinkLevel\("validation-finalize", opts\)/, 'GSA validation finalize should use the configured thinking level');
assert.match(gsaBenchRunner, /treat that raw transcript as provisional evidence/, 'GSA validation finalize should not fail solely because evidence.jsonl is empty after an interrupt');
assert.match(gsaBenchRunner, /preserve the finding at medium\/high confidence/, 'GSA validation repair should preserve exported primitive findings with missing consumer wiring as a limitation');
assert.match(gsaBenchRunner, /A missing external command is not a hard failure/, 'GSA benchmark mission should match runtime behavior for missing optional tools');
assert.match(gsaBenchRunner, /clean or empty scanner result is never proof of safety/, 'GSA benchmark mission should not let scanners decide safety without manual evidence');
assert.match(gsaBenchRunner, /Positive tool output is advisory too/, 'GSA benchmark validation finalizer should require reachability evidence for positive tool output');
assert.match(gsaBenchRunner, /scripts or external commands are still only planned/, 'GSA benchmark validation finalizer should not count planned automation as validation evidence');
assert.match(gsaBenchRunner, /phaseThinkLevel\("selection-evidence", opts\)/, 'GSA selection evidence pass should use the configured thinking level');
assert.match(gsaBenchRunner, /phaseThinkLevel\("selection-repair", opts\)/, 'GSA selection repair should use the configured thinking level');
assert.match(gsaBenchRunner, /phaseThinkLevel\("validation-repair", opts\)/, 'GSA validation repair should use the configured thinking level');
assert.match(gsaBenchRunner, /phaseThinkLevel\("report-repair", opts\)/, 'GSA report repair should use the configured thinking level');
assert.match(gsaBenchRunner, /JSON\.stringify\(\{ type: "control", name: "think", value \}\)/, 'GSA benchmark should send per-turn think control frames');
assert.match(gsaBenchRunner, /thinkControl\("max"\)/, 'GSA benchmark should send thinking max in every agent turn');
assert.match(gsaBenchRunner, /function interruptStatusForReason\(reason\)/, 'GSA benchmark should classify technical interrupts');
assert.match(gsaBenchRunner, /JSON\.stringify\(\{ reason, status: finalStatus \}\)/, 'GSA benchmark should send interrupt reason and terminal status to the backend');
assert.match(gsaBenchRunner, /resetting agent session before next GSA phase/, 'GSA benchmark should close active turns explicitly before resetting sessions');
assert.match(gsaBenchRunner, /function normalizeSelectionJson\(jsonText, workspace, caseDir, manifest\)/, 'GSA benchmark should normalize selected paths before saving selection');
assert.match(gsaBenchRunner, /rel = rel\.replace\(\/\^workspace\\\/\+\/, ""\);/, 'GSA benchmark should strip accidental workspace/ prefixes from selected paths');
assert.match(gsaBenchRunner, /path\.posix\.basename\(c\) === base/, 'GSA benchmark should recover selected files by unique basename');
assert.match(gsaRuntime, /\\"targetUrl\\":\\"%s\\",\\"think\\":\\"max\\"/, 'GSA start API should declare thinking max as the GSA contract');
assert.match(launcher, /static int display_prompt_is_gsa\(const char \*display\)/, 'Agent send endpoint should detect GSA display prompts');
assert.match(launcher, /gsa_think_max_frame\[\][\s\S]*"value\\":\\"max\\"/, 'Agent send endpoint should have a GSA thinking max control frame');
assert.match(launcher, /force_gsa_think_max[\s\S]*fd_write_all\(g_in_fd, gsa_think_max_frame/, 'Agent send endpoint should prepend thinking max for GSA turns');
assert.match(js, /async function skillsSearch\(params = \{\}\)[\s\S]*\/api\/skills\/search/, 'Engine client should expose skill search');
assert.match(launcher, /static void api_skill_get\(int fd, const char \*path\)/, 'Backend should expose a skill body reader for local overrides');
assert.match(launcher, /path_eq_clean\(path, "\/api\/skills\/search"\)[\s\S]*\/api\/skills\/get/, 'Router should serve /api/skills/get before the catalog endpoint');
assert.match(js, /async function skillGet\(id\)[\s\S]*\/api\/skills\/get\?id=/, 'Engine client should expose skill body loading');
assert.match(js, /async function gsaStart\(workdir, mission, targetUrl = '', parentRunDir = '', disabledTools = ''\)[\s\S]*JSON\.stringify\(\{ workdir, mission, targetUrl, parentRunDir, disabledTools \}\)/, 'Engine client should send target URL, parent GSA run and disabled tools');
assert.match(js, /Store\.setSettings\(\{ gsaMode: 'off', thinkLevel: 'max' \}\)/, 'Starting GSA should force the visible thinking state to max');
assert.match(js, /AgentView\.send\(res\.prompt,[\s\S]*\{ forceThink: 'max' \}\)/, 'GSA turns should force runtime thinking max');
assert.match(js, /function wirePromptForRuntime\(prompt, forceThink = ''\)[\s\S]*runtimeThinkControlFrame\(forceThink\) \+ prompt/, 'Runtime prompt wiring should support forced thinking for GSA');
assert.match(js, /Store\.setSettings\(\{ gsaMode: v,[\s\S]*thinkLevel: 'max'/, 'Enabling GSA should move the composer thinking pill to max');
assert.match(js, /GSA always runs with Thinking: max/, 'Thinking selector should reject lowering GSA below max');
assert.match(js, /async function gsaTools\(\)[\s\S]*\/api\/gsa\/tools/, 'Engine client should expose GSA tool status');
assert.match(js, /async function gsaToolsInstall\(\)[\s\S]*\/api\/gsa\/tools\/install/, 'Engine client should expose managed GSA tool install');
assert.match(js, /\/gsa\s/, 'composer should expose the GSA slash command');
assert.match(html, /id="gsa-target-panel"[\s\S]*id="gsa-target-url"/, 'Agent composer should expose an optional GSA target URL field');
assert.match(js, /gsaTargetUrl: ''/, 'GSA target URL should be persisted as an explicit setting');
assert.match(js, /gsaLoop: 'off'/, 'GSA loop should be persisted as an explicit off/on setting');
assert.match(js, /gsaDisabledTools: \[\]/, 'GSA disabled tool choices should persist in settings');
assert.match(js, /function renderGsaTargetPanel\(\)[\s\S]*curMode === 'agent' && Store\.getSettings\(\)\.gsaMode === 'on'/, 'GSA target field should only appear for armed Agent turns');
assert.match(js, /Engine\.gsaStart\(workdir, mission, targetUrl, '', gsaDisabledToolsPayload\(\)\)/, 'GSA command should pass target URL and disabled tools through to the backend');
assert.match(js, /function renderGsaToolsPanel\(\)[\s\S]*GSA automation[\s\S]*Open tools/, 'Composer plus menu should open GSA tool automation in a dedicated modal');
assert.match(html, /id="gsa-tools-dialog"[\s\S]*id="gsa-tools-dialog-grid"/, 'GSA tools should render in a modal grid instead of crowding the plus menu');
assert.match(html, /id="design-gallery-dialog"[\s\S]*id="design-gallery-grid"/, 'Design should expose a gallery modal for visual starting points');
assert.match(js, /const DESIGN_GALLERY_PRESETS = \[[\s\S]*SkyElite Private Jets[\s\S]*AeroCore - Aerospace Engine Landing/, 'Design gallery should ship multiple visual prompt presets');
assert.match(js, /function openDesignGallery\(\)[\s\S]*renderDesignGallery\(\)[\s\S]*showModal/, 'Design gallery should render before opening the modal');
assert.match(js, /curMode === 'design'[\s\S]*design-gallery-open[\s\S]*openDesignGallery\(\)/, 'Design plus menu should open the gallery from a dedicated action');
assert.match(js, /function renderGsaToolsDialog\(\)[\s\S]*gsa-tool-card__purpose/, 'GSA tools modal should render purpose text');
assert.match(js, /function renderGsaToolsDialog\(\)[\s\S]*gsa-tool-toggle/, 'GSA tools modal should render enable toggles');
assert.match(js, /function gsaToolInstallProblem\(tool\)[\s\S]*missingInstaller/, 'GSA tools modal should surface missing installer prerequisites');
assert.match(js, /function renderGsaToolsDialog\(\)[\s\S]*need installers/, 'GSA tools modal should summarize tools blocked by missing prerequisites');
assert.match(js, /function setGsaToolEnabled\(tool, enabled\)[\s\S]*gsaDisabledTools/, 'GSA tool toggles should persist enabled\/disabled state');
assert.match(js, /async function gsaStart\(workdir, mission, targetUrl = '', parentRunDir = '', disabledTools = ''\)[\s\S]*disabledTools/, 'Engine GSA start should send disabled tools to the backend');
assert.match(gsaRuntime, /function gsa_tools_json_filtered|static int gsa_tools_json_filtered/, 'GSA runtime should support per-run filtered tool status');
assert.match(gsaRuntime, /\\"enabled\\":%s/, 'GSA toolStatus should expose whether a tool is enabled for the run');
assert.match(gsaRuntime, /json_get_string\(body, "disabledTools"/, 'GSA start endpoint should read disabled tool choices');
assert.match(js, /await ensureGsaToolsForRun\(\)[\s\S]*Engine\.gsaStart\(workdir, mission, targetUrl, '', gsaDisabledToolsPayload\(\)\)/, 'GSA submit should preflight tool status before preparing the run');
assert.match(js, /AgentView\.send\(res\.prompt, targetUrl \? `\$\{display\}\\nTarget: \$\{targetUrl\}` : display, \{ forceThink: 'max' \}\)/, 'GSA should hide the internal prompt while showing the visible mission and target while forcing thinking max');
assert.match(js, /function buildLoadedPacksRow\(text\)[\s\S]*loadedPacks\(text\)[\s\S]*class: 'skill-use__eye', text: 'USING'/, 'Agent transcript should show which imported skill/craft/brand is in use');
assert.match(js, /\(s\.ev\.input \|\| \{\}\)\.name \|\| \(s\.ev\.input \|\| \{\}\)\.id/, 'Agent skill usage badge should handle skill tool calls that pass id instead of name');
assert.match(js, /if \(viewMode === 'agent' && !inBuildDrive\)[\s\S]*buildLoadedPacksRow\(partText\)/, 'Agent responses should render loaded skill usage outside the collapsed tool fold');
assert.match(js, /if \(name === 'skill' \|\| name === 'craft' \|\| name === 'design_system'\)[\s\S]*const kind = name === 'design_system' \? 'brand' : name/, 'tool labels should name loaded skills and design systems cleanly');
assert.match(html, /id="cyber-skills-view"[\s\S]*Cybersecurity skills[\s\S]*id="cyber-skills-query"/, 'Skills dialog should expose the imported cybersecurity skill catalog');
assert.match(js, /function renderCyberSkills\(query = ''\)[\s\S]*Engine\.skillsSearch\(\{ source: 'anthropic'/, 'Skills dialog should search imported cybersecurity skills');
assert.match(js, /gsaMode: 'off'/, 'GSA mode should be persisted as an explicit off/on setting');
assert.match(js, /cap: 'GSA'[\s\S]*items: \[\{ value: 'off', lead: 'Off' \}, \{ value: 'on', lead: 'On'/, 'Composer plus menu should expose GSA as an Off/On dropdown');
assert.match(js, /function renderGsaLoopPill\(\)[\s\S]*cbar-loop-btn[\s\S]*Loop/, 'Composer should show a GSA Loop toggle near the primary controls');
assert.match(js, /let gsaRunState = null/, 'GSA UI should track the active phase pipeline separately from loop state');
assert.match(js, /function parseGsaPhaseJsonText\(text\)[\s\S]*"phase"[\s\S]*localScripts[\s\S]*hypotheses/, 'GSA raw phase JSON should be recognized as structured UI output instead of prose');
assert.match(js, /function buildGsaPhaseCard\(seg\)[\s\S]*GSA[\s\S]*Raw JSON/, 'GSA phase JSON should render as a compact card with collapsible raw JSON');
assert.match(js, /function extractLastGsaPhaseOutput\(raw, expectedPhase = ''\)[\s\S]*segmentAgent\(last\)[\s\S]*gsa_phase_json/, 'Agent idle should extract the last GSA phase JSON before advancing the pipeline');
assert.match(js, /async function advanceGsaPhase\(output\)[\s\S]*Engine\.gsaPhase\(gsaRunState\.workdir, gsaRunState\.runId, phase, output\.output\)/, 'GSA UI should save each phase through /api/gsa/phase');
assert.match(js, /if \(res\.complete\)[\s\S]*finishGsaRunForLoop\(\)/, 'GSA Loop should wait for the report phase to complete before starting the next run');
assert.match(js, /function continueGsaLoop\(\)[\s\S]*const loopMission = nextGsaLoopMission\(\)[\s\S]*Engine\.gsaStart\(gsaLoopState\.workdir, loopMission, gsaLoopState\.targetUrl, gsaLoopState\.previousRunDir \|\| '', gsaDisabledToolsPayload\(\)\)/, 'GSA Loop should start a fresh run with a structured parent run directory');
assert.match(js, /Read the previous GSA run before choosing scope/, 'GSA Loop mission should tell the agent to read the previous run before exploring other paths');
assert.match(js, /const gsaArmed = Store\.getSettings\(\)\.gsaMode === 'on'[\s\S]*\/\^\\\/gsa\\b\/i\.test\(text\) \|\| gsaArmed[\s\S]*const targetUrl =[\s\S]*startGsaCommand\([\s\S]*`\/gsa \$\{text\}`, targetUrl\)/, 'GSA On should route the next Agent message through the GSA pipeline');
assert.match(js, /function switchGsa\(val\)[\s\S]*Store\.setSettings\(\{ gsaMode: v, \.\.\.\(v === 'on' \? \{ buildMode: 'off', thinkLevel: 'max' \} : \{ gsaLoop: 'off' \}\) \}\)/, 'GSA On should be mutually exclusive with Plan mode, force thinking max and GSA Off should clear Loop');
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
assert.match(launcher, /#define TASK_RING_CAP 128/, 'launcher should keep a bounded task lifecycle ring buffer');
assert.match(launcher, /#define LOG_RING_CAP 768/, 'launcher should keep a bounded log ring buffer');
assert.match(launcher, /static void api_diagnostics\(int fd\)/, 'launcher should expose workspace diagnostics');
assert.match(launcher, /static void api_logs\(int fd, const char \*path\)/, 'launcher should expose recent logs');
assert.match(launcher, /static void api_tasks\(int fd, const char \*path\)/, 'launcher should expose task summaries');
assert.match(launcher, /path_eq_clean\(path, "\/api\/diagnostics"\)/, 'router should serve /api/diagnostics');
assert.match(launcher, /path_eq_clean\(path, "\/api\/logs\/stream"\)/, 'router should serve streaming logs');
assert.match(launcher, /path_eq_clean\(path, "\/api\/tasks\/stream"\)/, 'router should serve streaming tasks');
assert.match(launcher, /task_mark_incomplete\(g_active_turn_task[\s\S]*engine process stopped before completing the turn/, 'engine death during Agent/Design should mark the turn incomplete');
assert.match(launcher, /g_active_turn_compacting/, 'Backend should track active Agent/Design context compaction');
assert.match(launcher, /context compaction during active turn/, 'Backend should log compaction during active Agent/Design turns');
assert.match(launcher, /static void api_agent_interrupt\(int fd, const char \*body\)/, 'Backend interrupt should accept a reason/status body');
assert.match(launcher, /task_mark_completed\(g_active_turn_task, msg\)[\s\S]*task_mark_incomplete\(g_active_turn_task, msg, msg\)/, 'Backend interrupt should distinguish completed technical interrupts from incomplete stalls');
assert.match(launcher, /\\"taskId\\":%llu/, 'start/send/setup/download responses should carry taskId metadata');
assert.match(js, /task #\$\{res\.taskId\}/, 'Agent/Design send errors should show the backend task id');
assert.match(webview, /DS4_DIRECTORY_PICKER_SCRIPT/, 'native wrapper should inject the directory picker bridge');
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
assert.match(js, /build:\s*'off'/, 'Agent/Design should keep Plan mode as a per-turn UI contract instead of a launch mode');
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
assert.match(js, /let followBottomChatId = null/, 'Chat streaming should track bottom-follow intent across final re-renders');
assert.match(js, /function shouldAutoFollow\(chatId\)/, 'Chat streaming should expose bottom-follow state');
assert.match(js, /function finishAutoFollow\(chatId\)/, 'Chat streaming should consume bottom-follow state after the final render');
assert.match(js, /function onScroll\(\)[\s\S]*followBottom = isNearBottom\(root, 120\)/, 'User navigation should disable or re-enable stream autoscroll based on distance from bottom');
assert.match(js, /Messages\.renderChat\(Store\.getChat\(chat\.id\), \{ stickToBottom \}\)/, 'Final chat render should keep the viewport at bottom when the user did not navigate away');
assert.match(js, /Messages\.finishAutoFollow\(chat\.id\)/, 'Final chat render should clear stream autoscroll state');
assert.match(js, /let agentFollowBottom = false/, 'Agent streaming should track bottom-follow intent');
assert.match(js, /let agentLastScrollTop = 0/, 'Agent streaming should track scroll direction');
assert.match(js, /let agentSelectPointerDown = false/, 'Agent text selection should track pointer drags separately from normal scrolling');
assert.match(js, /function lockAgentSelectionScroll\(\)[\s\S]*view\.scrollTop = agentSelectScrollTop/, 'Agent text selection should freeze scrollTop while selecting streamed text');
assert.match(js, /on\(view, 'pointerdown', beginAgentSelectionPointer\)/, 'Agent selection lock should start before the browser has a non-collapsed selection');
assert.match(js, /on\(view, 'pointermove', maybeLockAgentSelectionScroll\)/, 'Agent selection lock should keep scroll stable during drag selection');
assert.match(js, /on\(document, 'pointerup', endAgentSelectionPointer\)/, 'Agent selection lock should release when the drag ends');
assert.match(js, /function onAgentScroll\(\)[\s\S]*const movedUp = view\.scrollTop < agentLastScrollTop - 2[\s\S]*agentFollowBottom = false/, 'Agent user navigation should disable autoscroll when the scrollbar moves upward');
assert.match(js, /if \(userWindow\) agentFollowBottom = nearBottom && !movedUp/, 'Agent autoscroll should re-enable only when user input returns near the bottom');
assert.match(js, /function shouldDeferAgentRenderForSelection\(\)[\s\S]*selectionInside\(view\)/, 'Agent streaming should defer repaint while text is selected');
assert.match(js, /on\(document, 'selectionchange', onAgentSelectionChange\)/, 'Agent should resume live rendering after text selection clears');
assert.match(js, /settleAgentScroll\(stick, prevScrollTop\)/, 'Agent renders should preserve scroll position unless following the bottom');
assert.doesNotMatch(js, /const stick = shouldAgentFollow\(\) \|\| shouldStickToBottom\(view\)/, 'Agent renders must not force-follow bottom after the user scrolls away');
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
assert.match(launcher, /else if \(lan_root_path\(path\)\)/, 'root app shell should tolerate query strings');
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
assert.match(html, /#settings-dialog\.settings-dialog[\s\S]*width: min\(94vw, 58rem\)/, 'Main settings dialog should use a wide landscape layout');
assert.match(html, /#settings-dialog \.set-body[\s\S]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/, 'Main settings sections should flow in two columns on wide windows');
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
assert.match(js, /if \(!isChatComposerMode\(\) \|\| !dragHasFiles\(e\)\) return/, 'Chat drag-and-drop should use the shared chat-mode guard');
assert.match(js, /readChatFiles\(e\.dataTransfer\.files\)/, 'Dropped files should use the same attachment reader as the paperclip');
assert.match(html, /chat--drop \.composer__card/, 'Chat composer should expose a visible whole-chat drag-over state');
assert.match(js, /cbarAttach\.hidden = readOnly \|\| mode === 'agent'/, 'Attach button should show for Chat, stay for Design and hide in Agent/read-only host mode');
assert.match(js, /function placePrimaryControls\(\)[\s\S]*cbarThink\.hidden = false/, 'Composer should keep thinking visible in the bottom-right control group');
assert.doesNotMatch(js, /function parkNativeThinkSelect\(\)/, 'Composer should not use the old hidden-thinking gear layout');
assert.match(js, /cbarPop\.append\(cbarAttach\)/, 'Composer plus menu should own secondary attach/options controls');
assert.match(html, /body\.composer-raised \.chat \{ grid-template-rows: auto auto auto minmax\(0, 1fr\); \}/, 'empty conversations should raise the composer under the hero instead of pinning it at the bottom');
assert.match(html, /body\.composer-raised \.cbar-pop \{ top: calc\(100% \+ 8px\); bottom: auto; \}/, 'raised composer plus menu should open downward instead of covering the hero');
assert.match(html, /body\.composer-raised \.cdrop-menu \{ top: calc\(100% \+ 6px\); bottom: auto; \}/, 'raised composer dropdown menus should open downward with the plus menu');
assert.match(html, /body\.composer-raised \.cbar-model-menu \{ top: calc\(100% \+ 6px\); bottom: auto; \}/, 'raised composer model menu should open downward with the other menus');
assert.match(html, /body\.composer-raised \.cbar-think-menu \{ top: calc\(100% \+ 6px\); bottom: auto; \}/, 'raised composer thinking menu should open downward with the other menus');
assert.match(html, /\.cbar-pop\s*\{[\s\S]*width:\s*min\(88vw,\s*300px\)[\s\S]*min-width:\s*240px/, 'plus menu should stay compact instead of using oversized rows');
assert.match(html, /\.cdrop-cap\s*\{ width:\s*30px; font-size:\s*9\.5px;/, 'plus menu dropdown labels should be compact');
assert.match(html, /id="skills-picker-view"[\s\S]*id="skills-category-list"[\s\S]*id="skills-picker-list"/, 'Skill picker should use a modal with category sidebar and skill grid');
assert.match(html, /id="skills-picker-manage"[\s\S]*>Add<\/button>/, 'Skill picker should label the authoring action Add, not Manage');
assert.doesNotMatch(html, /id="skills-picker-manage"[\s\S]*>Manage<\/button>/, 'Skill picker should not expose the old Manage label');
assert.match(js, /function openSkillPickerForCurrentMode\(\)[\s\S]*Skills\.openPicker/, 'Skill selection should open the modal picker from the plus menu');
assert.match(js, /function renderSkillPicker\(\)[\s\S]*skills-cat[\s\S]*skill-card/, 'Skill picker modal should render categories and skill cards');
assert.match(js, /on\(pickerManage, 'click', \(\) => showEditor\(null, null, 'picker'\)\)/, 'Skill picker Add should open the editor directly');
assert.match(js, /skill-card__edit[\s\S]*showEditor\(it\.value, it\.raw, 'picker'\)/, 'Skill cards should expose an inline edit action');
assert.match(js, /Engine\.userSkillGet\(id\)[\s\S]*Engine\.skillGet\(id\)/, 'Editing a shipped skill should fall back to reading the shipped body');
assert.match(js, /Engine\.userSkillSave\(\{ id,[\s\S]*modes: editingModes/, 'Skill editor should preserve modes when saving local overrides');
assert.match(js, /function selectedSkillPromptForRuntime\(\)[\s\S]*DStudio selected skill/, 'Selected skills should apply to future turns without restarting the runtime');
assert.doesNotMatch(extractFunction(js, 'switchSkill'), /restartCurrent\(/, 'Changing skill should not restart the model');
assert.match(js, /function setComposerRaised\(active\)[\s\S]*composer-raised/, 'empty-state renderer should explicitly toggle the raised composer layout');
assert.match(js, /function shouldFocusComposerFromSurfaceClick\(e\)[\s\S]*return !t\.closest\(\[[\s\S]*button', 'a', 'input', 'textarea', 'select'/, 'clicking a non-interactive chat surface should focus the shared composer');
assert.match(js, /on\(form, 'mousedown', \(e\) => \{[\s\S]*shouldFocusComposerFromSurfaceClick\(e\)[\s\S]*focusComposerInput\(\)/, 'clicking empty composer card space should focus the text input');
assert.match(js, /const chatSurface = qs\('\.chat'\);[\s\S]*on\(chatSurface, 'mousedown', \(e\) => \{[\s\S]*shouldFocusComposerFromSurfaceClick\(e\)[\s\S]*focusComposerInput\(\)/, 'clicking empty space anywhere in the chat surface should focus the text input');
assert.match(js, /function onClick\(e\)[\s\S]*if \(!actBtn\) \{[\s\S]*shouldFocusComposerFromSurfaceClick\(e\)[\s\S]*focusComposerInput\(\)/, 'Chat message surface clicks should focus the composer when not hitting controls');
assert.match(js, /function onClick\(e\)[\s\S]*if \(cmd\)[\s\S]*return;[\s\S]*if \(shouldFocusComposerFromSurfaceClick\(e\)\) focusComposerInput\(\)/, 'Agent and Design surface clicks should focus the composer when not hitting controls');
assert.match(js, /Messages\.renderChat\(chat, \{ stickToBottom: true \}\)/, 'Sending a chat message should force the new turn to the bottom instead of preserving an old scrollTop');
assert.match(js, /agentFollowBottom = !isSlashCommand\(displayPrompt\) \|\| shouldStickToBottom\(view\)/, 'Sending an Agent or Design message should keep the new turn visible even if the previous scrollTop was high');
assert.match(js, /class: 'wd-path'[\s\S]*text: wd \|\| 'choose folder…'/, 'working folder row should use path-specific styling instead of applying monospace to every plus-menu action');
assert.doesNotMatch(html + js, /Runs entirely on your Mac|Write a message…|Ask the agent|Describe the design|A first-run onboarding screen|Refine the selected screen/, 'Chat, Agent and Design composer placeholders/privacy filler should not be visible');
assert.match(html, /\.btn--send[\s\S]*width: 34px;[\s\S]*height: 34px;[\s\S]*\.cbar-btn[\s\S]*width: 34px; height: 34px;[\s\S]*\.cbar-sel[\s\S]*height: 34px;[\s\S]*\.cbar-think-btn[\s\S]*height: 34px;[\s\S]*\.cbar-model-btn[\s\S]*height: 34px;/, 'model, thinking, plus and send controls should share the same height');
assert.match(js, /function renderThinkingPill\(\)[\s\S]*closeGear\(\);[\s\S]*closeModelMenu\(\);[\s\S]*thinkMenuOpen = next/, 'Opening Thinking should close the plus and model menus first');
assert.match(js, /function renderModelPill\(\)[\s\S]*closeGear\(\);[\s\S]*closeThinkMenu\(\);[\s\S]*modelMenuOpen = next/, 'Opening Model should close the plus and thinking menus first');
assert.match(js, /function openGear\(\)[\s\S]*closeThinkMenu\(\);[\s\S]*closeModelMenu\(\);[\s\S]*layoutControls\(\)/, 'Opening the plus menu should close model and thinking menus first');
assert.match(js, /if \(activeCdropCollapse && activeCdropCollapse !== collapse\) activeCdropCollapse\(\)/, 'Only one plus-menu custom dropdown should stay open at a time');
assert.match(js, /body\.classList\.toggle\('design-brief-staged'[\s\S]*stagedBrief[\s\S]*body\.classList\.toggle\('design-staged'[\s\S]*\(stagedQ \|\| stagedGen\)/, 'Design brief should not hide the shared composer; only questions/generating should');
assert.match(js, /setComposerRaised\(viewMode === 'agent' \|\| \(viewMode === 'design' && stagedBrief\)\)/, 'Design brief should use the same raised composer layout as empty Agent/Chat');
assert.match(js, /doneTodoKeys: new Set\(\)/, 'Design generating progress should track synthetic todo completion from tool events');
assert.match(js, /function applyEvent\(ev\)[\s\S]*markTodosBeforeOperation\(state\.activeTool\)/, 'Design milestone tool calls should advance earlier build todos instead of leaving progress stuck');
assert.match(js, /type === 'file_written'[\s\S]*markActiveOrNextTodoDone\(\)/, 'Design file writes should advance the active build todo when the model forgets todo_write');
assert.match(js, /const markActiveOrNextTodoDone = \(\) => \{[\s\S]*!requiredOps\(String\(todo\?\.text \?\? ''\)\)\.length[\s\S]*if \(idx >= 0\) markTodoDone/, 'Design file writes should not complete verify/critique/artifact milestone todos');
assert.match(js, /type === 'run_started'[\s\S]*state\.todos = null[\s\S]*discoveryBlockedNotified = false/, 'Design runtime should clear stale todos and discovery warnings when a new run starts');
assert.match(js, /type === 'discovery_blocked'[\s\S]*Questions required before building[\s\S]*Design needs the Questions step before building/, 'Design UI should surface a skipped-discovery runtime block to the user');
assert.match(js, /function designPhase\(\)[\s\S]*DesignRuntime\.getState[\s\S]*return 'generating'/, 'Design stepper should use event-sourced runtime state, not only visible transcript text');
assert.match(js, /function designPhase\(\)[\s\S]*const emptyTranscript = !hasRenderableConversation\(text\)[\s\S]*if \(emptyTranscript && !working && !rt\?\.question && rt\?\.phase !== 'building'\) return 'brief'[\s\S]*ps0\.finalized/, 'Empty Design conversations should stay on Brief instead of inheriting stale runtime preview state');
assert.match(js, /function hasRenderableConversation\(raw = text\)[\s\S]*session_status[\s\S]*return false/, 'Agent/Design empty states should ignore service-only transcripts');
assert.match(js, /staleNotice = !conv\.lanMirror && hasRenderableConversation\(conv\.transcript \|\| ''\) && !conv\.sessionSha/, 'Service-only new Agent/Design conversations should not show the stale session warning');
assert.match(js, /const submitAnswer = \(answerText, lines = \[\]\) => \{[\s\S]*viewMode === 'design'[\s\S]*sendQuestionAnswer\(answerText\)/, 'Design question forms should submit with the runtime-recognized question answer marker');
assert.match(js, /viewMode === 'agent' \|\| viewMode === 'design' \|\| inBuildDrive/, 'Design reasoning blocks should stay open like Agent reasoning blocks');
assert.match(html, /\.thinking \{[\s\S]*content-visibility: visible;[\s\S]*contain-intrinsic-size: auto;/, 'Open reasoning blocks should not use estimated content-visibility heights that can disturb scroll');
assert.match(remoteDesign, /design_user_text_skips_discovery[\s\S]*build it directly[\s\S]*BUILD MODE \(planned\)/, 'Design discovery gate should exempt explicit build-direct driver prompts');
assert.match(remoteDesign, /design_tool_allowed_before_discovery[\s\S]*skill[\s\S]*design_system[\s\S]*craft[\s\S]*pack_file[\s\S]*question/, 'Design discovery gate should allow only pack loading and question before discovery');
assert.match(remoteDesign, /design_discovery_gate_active[\s\S]*!pr->discovery_satisfied[\s\S]*!pr->current_artifact_entry\[0\]/, 'Design runtime should enforce discovery before first build tools on fresh projects');
assert.match(remoteDesign, /discovery_required[\s\S]*discovery_blocked/, 'Design runtime should log a structured event when it blocks a pre-discovery build tool');
assert.match(remoteDesign, /Tool error: discovery question required before building/, 'Design model should receive an explicit tool error when it skips the Questions step');
assert.match(js, /shared composer handles the brief and all controls[\s\S]*function buildBriefScreen\(\)[\s\S]*focusComposerInput\(\)/, 'Design brief should rely on the shared composer instead of a local input/control stack');
assert.match(js, /function buildBriefScreen\(\)[\s\S]*Open gallery[\s\S]*Composer\.openDesignGallery/, 'Design empty brief should offer the same gallery without duplicating composer controls');
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
assert.match(js, /function extractGeneratedFilesFromAssistant\(text\)/, 'Chat should parse model-emitted generated file blocks');
assert.match(js, /function parseGeneratedFilePayload\(raw\)/, 'Generated file parsing should validate the structured files schema');
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
assert.match(js, /panel\.classList\.add\('open'\)/, 'Artifact canvas controller should open the sidebar without a modal backdrop');
assert.match(js, /document\.body\.classList\.add\('artifact-open'\)/, 'Artifact canvas should mark the body so the grid can allocate the sidebar column');
assert.match(js, /document\.body\.classList\.remove\('artifact-open'\)/, 'Closing the artifact canvas should restore full chat width');
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
assert.match(js, /buildElapsed\(performance\.now\(\) - liveTurnStartedAt, true\)/, 'Live Agent and Design turns should show elapsed time while working');
assert.match(js, /if \(userWindow\) agentFollowBottom = nearBottom && !movedUp;[\s\S]*else if \(movedUp\) agentFollowBottom = false;/, 'Agent scroll should only re-enable follow-bottom from user-driven movement');
assert.doesNotMatch(js, /if \(nearBottom\) agentFollowBottom = true;/, 'Agent scroll must not reacquire follow-bottom from repaint-generated scroll events');
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
assert.match(readme, /## Design: a studio built \*\*on\*\* ds4[\s\S]*assets\/design\.gif[\s\S]*Brief and questions[\s\S]*Generating[\s\S]*Proposal[\s\S]*Canvas and handoff/, 'README should feature the Design pipeline demo GIF and concise pipeline explanation');
assert.doesNotMatch(readme, /(?:💬|🔎|🤖|🧩|🛡️|🎨|📝)/u, 'README should not use decorative emoji in headings or feature sections');
assert.doesNotMatch(readme, /—|–/, 'README should avoid long dash separators');
assert.doesNotMatch(readme, /--/, 'README should avoid double-dash separators and spell out technical flags in prose');
assert.doesNotMatch(readme, /assets\/README%20images\/design\/(?:brief|Design|proposal|canvas)\.png/, 'README Design section should not show the old static pipeline screenshots');
assert.doesNotMatch(readme, /assets\/README%20images\/build\.png/, 'README Plan mode section should not show the old Build/Plan screenshot');
assert.match(js, /cap: 'Plan'[\s\S]*ariaLabel: 'Plan mode'/, 'Agent composer should expose Plan mode instead of Build mode');
assert.doesNotMatch(js, /cap: 'Build'[\s\S]*ariaLabel: 'Build mode'/, 'Agent composer should not expose the old Build mode label');
assert.match(js, /PLAN MODE — create a Markdown planning file/, 'Plan mode should convert the next agent prompt into a markdown planning request');
assert.ok(js.includes('PLAN MODE\\s*[—-]\\s*create a Markdown planning file for the request above'), 'Plan mode hidden contract should be removed from displayed chat bubbles');
assert.match(js, /showPlanActions\(info\)/, 'Plan mode should show post-plan action choices');
assert.match(js, /Implement plan[\s\S]*Stay in plan mode[\s\S]*Chat about this/, 'Plan mode completion card should offer implement, continue planning, or chat actions');
const switchBuildBody = js.match(/function switchBuild\(val\) \{[\s\S]*?\n      \}/)?.[0] || '';
assert.ok(switchBuildBody, 'switchBuild body missing');
assert.doesNotMatch(switchBuildBody, /restartCurrent\(/, 'Switching Plan mode should not restart the agent');
assert.match(js, /runSwitch\('agent'[\s\S]*build: 'off'/, 'Agent launch should keep Plan mode as a per-turn hidden prompt, not a launch prompt');
assert.match(launcher, /PLAN MODE — Markdown planning file only/, 'Plan mode launch prompt should keep the agent in planning-only behavior');
assert.doesNotMatch(readme, /Build mode for real web apps|guided app builder|runnable web app/, 'README should no longer market the old app-builder Build mode');
assert.match(js, /function activeConversationForMode\(targetMode\)/, 'Agent/Design must explicitly bind a conversation for the current mode before sending');
assert.match(js, /const conv = activeConversationForMode\(viewMode\)/, 'Agent/Design startup must not reuse a chat from another mode');
assert.match(js, /if \(agentBusy && !building\)[\s\S]*AgentView\.reconcileIdle/, 'Agent composer must reconcile stale busy state instead of silently dropping input');
assert.match(js, /toast\('Answer the question card first\.'/, 'Agent question mode must give feedback instead of silently swallowing input');
assert.match(js, /async function reconcileIdle\(\)/, 'Agent view should recover when the backend is idle but the UI is still marked busy');
assert.match(js, /if \(!r\.ok && data && !data\.error\) data\.error = `send \$\{r\.status\}`/, 'Agent send should surface HTTP failures from the launcher');
assert.match(js, /Switcher\.wirePromptForRuntime \? Switcher\.wirePromptForRuntime\(prompt, opts\.forceThink\) : prompt/, 'AgentView must call the runtime prompt adapter through Switcher, not as an out-of-scope function');
assert.match(js, /return \{[\s\S]*wirePromptForRuntime,[\s\S]*buildPlanActive/, 'Switcher should expose the runtime prompt adapter used by AgentView');
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
assert.match(loadingHtml, /onboardedVersion !== 8/, 'loading gate must skip before host onboarding is complete');
assert.match(loadingHtml, /hello are you alive\?/, 'loading gate should probe the local model');
assert.doesNotMatch(loadingHtml, /Loading the local model|Connecting to the local launcher|Waiting for the model to be ready|Open DStudio anyway/, 'loading page should show only the logo, not a status card');

assert.match(gitignore, /^\/ds4\/$/m, 'managed upstream ds4 checkout should stay out of the DStudio source tree');
assert.match(launcher, /#define DS4_REPO_URL "https:\/\/github\.com\/antirez\/ds4"/, 'launcher should know the upstream ds4 repo URL');
assert.match(launcher, /#define DS4_UPSTREAM_COMMIT "d881f2a05e8ff6bec001315a36b794b4aa310173"/, 'managed ds4 setup should pin the upstream commit in code');
assert.match(launcher, /#define DS4_ARCHIVE_URL "https:\/\/codeload\.github\.com\/antirez\/ds4\/tar\.gz\/" DS4_UPSTREAM_COMMIT/, 'managed ds4 setup should download a pinned GitHub source archive');
assert.match(launcher, /static char\s+g_ds4_dir\[1024\]\s*=\s*"ds4"/, 'default ds4 folder should be managed inside the DStudio repo');
assert.match(launcher, /static int default_ds4_dir\([\s\S]*"%s\/ds4"/, 'default ds4 path should resolve under the DStudio checkout');
assert.match(launcher, /setup_download_ds4_archive[\s\S]*"curl"[\s\S]*DS4_ARCHIVE_URL[\s\S]*"tar", "-xzf"/, 'setup endpoint should use curl+tar, not git, to download the pinned source archive');
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
assert.match(js, /const ONBOARD_VERSION = 8/, 'onboarding version should bump when first-run cache needs to be cleared');
assert.match(js, /on\(dialog, 'cancel', \(e\) => e\.preventDefault\(\)\)/, 'onboarding should not close when Escape is pressed');
assert.match(js, /await refreshLocalSetupState\(\)/, 'onboarding Start should refresh /api/status before deciding it can close');
assert.match(js, /async function refreshLocalSetupState\(\)[\s\S]*Engine\.status\(\)[\s\S]*applyLocalSetupStatus\(st\)/, 'onboarding Start status refresh should repaint the live ds4 state');
assert.match(js, /const localVisible = !lanPanel \|\| lanPanel\.hidden;[\s\S]*!completingOnboarding && localVisible && forcedSetup && !lastDs4Ok/, 'onboarding close guard should only reopen for an incomplete Local setup');
assert.match(js, /let startResult = null;[\s\S]*await Engine\.start\(\{ mode: 'server', gguf: selectedGguf \}, true\)[\s\S]*startResult\.ok === false[\s\S]*Could not start selected model/, 'onboarding Start must show /api/start failures instead of silently closing');
assert.match(js, /function setSettingsNow\(patch\)[\s\S]*persistSettings\.cancel\(\)[\s\S]*writeKey\(STORAGE_KEYS\.settings, JSON\.stringify\(state\.settings\)\)/, 'onboarding completion needs an immediate settings write before navigation');
assert.match(js, /let shouldShowLoading = false;[\s\S]*shouldShowLoading = true;[\s\S]*if \(shouldShowLoading && !isLanClientMode\(\)\) location\.href = '\/loading\.html'/, 'onboarding Start should only show loading after it actually starts a different model');
assert.match(js, /async function connectLanAddress\(\)[\s\S]*await connectLanClientMode\(lanAddressInput\.value\)[\s\S]*completingOnboarding = true;[\s\S]*Store\.setSettingsNow\(\{ onboarded: true, onboardedVersion: ONBOARD_VERSION \}\);[\s\S]*dialog\.close\(\)/, 'LAN onboarding connect should complete onboarding only after a valid LAN health check');
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

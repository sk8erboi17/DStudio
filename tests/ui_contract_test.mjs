import fs from 'node:fs';
import assert from 'node:assert/strict';

const html = fs.readFileSync('web/index.html', 'utf8');
const loadingHtml = fs.readFileSync('web/loading.html', 'utf8');
const launcher = fs.readFileSync('src/dstudio.c', 'utf8');
const webview = fs.readFileSync('src/webview.h', 'utf8');

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
assert.match(js, /label: 'System check'[\s\S]*run: \(\) => Doctor\.open\(\)/, 'System check should remain available from the gear menu');
assert.match(html, /class="loading-spinner"/, 'engine loading overlay should show a spinner');
assert.match(html, /id="loading-log"/, 'engine loading overlay should show a live log');
assert.match(js, /appendOverlayLog\(title\)/, 'engine loading overlay should log launch start');
assert.match(js, /updateOverlay\(st\.loadPct, st\.stage, st\.engineLine \|\| st\.engineError \|\| ''\)/, 'engine loading overlay should consume launcher log lines');
assert.match(launcher, /\\"engineLine\\":\\"%s\\"/, 'status endpoint should expose the latest engine log line');
assert.match(webview, /DS4_DIRECTORY_PICKER_SCRIPT/, 'native wrapper should inject the directory picker bridge');
assert.match(webview, /NSOpenPanel \*panel = \[NSOpenPanel openPanel\]/, 'macOS wrapper should open the native folder explorer');
assert.match(webview, /gtk_file_chooser_dialog_new/, 'Linux wrapper should open the native folder explorer');
assert.match(webview, /IFileOpenDialog \*dlg = NULL/, 'Windows wrapper should open the native folder explorer');
assert.match(webview, /FOS_PICKFOLDERS/, 'Windows folder explorer should be configured for directories');
assert.match(webview, /ds4PickDirectory: \{ postMessage/, 'Windows WebView2 bridge should expose ds4PickDirectory');
assert.match(webview, /ds4_windows_resolve_directory/, 'Windows native picker should resolve the JS promise');
assert.match(webview, /ExecuteScript\(js, NULL\)/, 'Windows native picker should callback into the page');
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
assert.match(js, /build:\s*isLanClientMode\(\) \? 'off' : buildMode\(\)/, 'LAN Agent should not enable planned Build mode against a remote host model');
assert.match(js, /jsonl:\s*isLanClientMode\(\) \? true : Store\.getSettings\(\)\.useJsonlPatch !== false/, 'LAN Agent must force structured output for local tools');
assert.match(js, /startAgent[\s\S]*const remote = remoteModelLaunch\(\)[\s\S]*\.\.\.remote/, 'Agent start payload should include the remote model fields');
assert.match(js, /startDesign[\s\S]*const remote = remoteModelLaunch\(\)[\s\S]*\.\.\.remote/, 'Design start payload should include the remote model fields');
assert.match(js, /if \(isLanClientMode\(\)\)[\s\S]*return;[\s\S]*loadSetModels\(\)/, 'LAN clients should not scan local GGUFs from settings refresh');
assert.match(js, /async function loadSetModels\(\) \{[\s\S]*if \(isLanClientMode\(\)\)[\s\S]*return;[\s\S]*Engine\.ggufs\(\)/, 'LAN client settings must not scan local GGUFs even if called directly');
assert.match(js, /async function loadModelList\(\) \{[\s\S]*if \(isLanClientMode\(\)\)[\s\S]*return;[\s\S]*Engine\.ggufs\(\)/, 'LAN clients should not scan local GGUFs from the composer model picker');
assert.match(js, /function show\(\) \{[\s\S]*if \(isLanClientMode\(\)\) return;[\s\S]*loadGgufs\(\)/, 'LAN clients should not open onboarding into local ds4 discovery');
assert.match(js, /ctrls\.append\(\.\.\.\(isLanClientMode\(\) \? \[\] : \[modelSel\]\), skillSel, dsSel, thinkSel\)/, 'LAN Design brief should not expose model switching');
assert.match(js, /function downloadModel\(spec\) \{[\s\S]*if \(isLanClientMode\(\)\)[\s\S]*return;[\s\S]*\/api\/model\/download/, 'LAN clients must not start local model downloads');
assert.match(js, /if \(action === 'start-engine'\) \{[\s\S]*if \(isLanClientMode\(\)\)[\s\S]*return;[\s\S]*Engine\.start\(\{ mode: 'server' \}/, 'LAN client system check must not start a local engine');
assert.match(js, /function shouldStickToBottom\(/, 'streaming render should respect user scroll position and text selection');
assert.match(js, /selectionInside\(scroller\)/, 'autoscroll must stop while the user is selecting text');
assert.doesNotMatch(js, /Agent and Design run on the DStudio host\. LAN clients use Chat\./, 'LAN clients must be able to open Agent and Design');
assert.doesNotMatch(js, /if \(isLanClientMode\(\)\) \{ setMode\('server'\); return; \}/, 'LAN switches must not be forced back to Chat');
assert.match(js, /function isHostServedLanShell\(\)/, 'host-served LAN shell must be detectable');
assert.match(html, /Workspace, agent, design, settings and store APIs stay local-only/, 'LAN copy must document local workspace isolation');
assert.match(html, /keeps its own local chats, app state and workspaces/, 'LAN client settings should describe local workspaces');
assert.doesNotMatch(html, /Agent and Design requests run on the LAN host|uses the LAN host for Chat, Agent and Design/, 'LAN client copy must not imply host workspaces');
assert.match(js, /const apiUrl = \(path\) => `\$\{path\}`/, 'Engine APIs must stay local in LAN client mode');
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
assert.match(launcher, /web_open_tab\(web, url, &tab, err, err_len\)/, 'web reader should open the requested URL directly, not through about:blank navigation');
assert.match(launcher, /__attribute__\(\(unused\)\) web_cdp_navigate/, 'direct navigation patch should not leave an unused-function warning');
assert.match(launcher, /Access-Control-Allow-Headers: Content-Type, Accept, X-Requested-With/, 'LAN engine APIs must allow the app anti-CSRF header in CORS preflights');
assert.match(launcher, /canonicalUrl/, 'web-read should return the canonical URL');
assert.match(launcher, /sourceKind/, 'web-read should classify the source kind');
assert.match(launcher, /metadata/, 'web-read should return reader metadata');
assert.match(launcher, /warnings/, 'web-read should return reader warnings');
assert.match(js, /function isLanHostMode\(\)/, 'host LAN supervision needs a separate mode from LAN clients');
assert.match(js, /return !isLanClientMode\(\) && s\.lanEnabled === true/, 'host LAN mode must not apply to LAN clients');
assert.match(js, /tab\.disabled = hostLan/, 'host LAN mode must disable Agent and Design tabs');
assert.match(js, /setMode\(isLanHostMode\(\) \? 'server'/, 'host LAN mode must stay on the Chat screen');
assert.match(js, /if \(isLanHostMode\(\) && mode === 'chat'\) return state\.chats\.filter\(\(c\) => c\.lanMirror\)/, 'host LAN sidebar should show only LAN mirrors');
assert.match(js, /function mirrorTranscriptMessages\(chat\)/, 'host LAN Chat view must render agent/design mirror transcripts read-only');

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
assert.match(loadingHtml, /onboardedVersion !== 6/, 'loading gate must skip before host onboarding is complete');
assert.match(loadingHtml, /hello are you alive\?/, 'loading gate should probe the local model');

assert.match(js, /function classifyResearchRequest\(/, 'web research should classify the request before searching');
assert.match(js, /function planNextResearchAction\(/, 'Deep Research should use an action planner loop');
assert.match(js, /function pickSourcesToRead\(/, 'web research should use a model source picker');
assert.match(js, /function extractFactsFromPage\(/, 'web research should extract facts from read pages');
assert.match(js, /Evidence extractor retry/, 'evidence extraction should retry with a shorter model call');
assert.match(js, /Return at most 8 facts/, 'evidence extraction should avoid oversized JSON responses');
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

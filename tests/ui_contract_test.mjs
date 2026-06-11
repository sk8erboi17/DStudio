import fs from 'node:fs';
import assert from 'node:assert/strict';

const html = fs.readFileSync('web/index.html', 'utf8');
const readme = fs.readFileSync('README.md', 'utf8');
const loadingHtml = fs.readFileSync('web/loading.html', 'utf8');
const launcher = fs.readFileSync('src/dstudio.c', 'utf8');
const app = fs.readFileSync('src/app.cc', 'utf8');
const webview = fs.readFileSync('src/webview.h', 'utf8');
const remoteHelper = fs.readFileSync('extension/remote/dstudio_remote_llm.c', 'utf8');
const windowsBuild = fs.readFileSync('scripts/build-windows.ps1', 'utf8');
const windowsDs4Build = fs.readFileSync('scripts/build-ds4-windows-cygwin.sh', 'utf8');

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
assert.match(js, /let launchTarget = null;/, 'mode switcher should track the launch target separately from the active mode');
assert.match(js, /launching: \(\) => launchTarget/, 'mode switcher should expose the current launch target');
assert.match(js, /launching === 'agent' \|\| launching === 'design'[\s\S]*render\(\);[\s\S]*return;[\s\S]*Api\.checkHealth\(\)/, 'statusbar should not run chat health while agent or design is launching');
assert.match(js, /Starting design agent\.\.\.[\s\S]*Starting coding agent\.\.\./, 'statusbar should show explicit startup state for design and agent');
assert.match(js, /if \(switching \|\| launchTarget\) return;[\s\S]*setMode\(isLanHostMode\(\) \? 'server'/, 'engine sync should not force the UI back to chat during a mode switch');
assert.match(js, /launchTarget = target;[\s\S]*Statusbar\.render\(\);[\s\S]*showOverlay\(title\)/, 'runSwitch should publish launch state before showing the startup overlay');
assert.match(js, /const timeoutMs = target === 'server' \? 180000 : 15 \* 60 \* 1000;/, 'agent/design startup should allow longer model and system-prompt loading than chat server startup');
assert.match(launcher, /\\"engineLine\\":\\"%s\\"/, 'status endpoint should expose the latest engine log line');
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
assert.match(windowsDs4Build, /REMOTE_DIR="\$ROOT\/extension\/remote"/, 'Windows ds4-design build should include DStudio remote adapter');
assert.match(windowsDs4Build, /\/ucrt64\/bin\/gcc \/mingw64\/bin\/gcc \/clang64\/bin\/gcc \/usr\/bin\/gcc/, 'Windows DS4 build should prefer native MinGW toolchains before MSYS gcc');
assert.match(windowsBuild, /libgcc_s_seh-1\.dll/, 'Windows package should include the MinGW GCC runtime');
assert.match(windowsBuild, /Copy-Item \$src \$Ds4Dir -Force/, 'Windows package should copy runtime DLLs next to DS4 engine binaries too');
assert.match(launcher, /win_prepare_engine_runtime/, 'Windows launcher should prepare runtime DLL lookup before spawning DS4 tools');
assert.match(launcher, /win_copy_runtime_dlls_to_ds4/, 'Windows launcher should copy packaged runtime DLLs into the selected DS4 folder');
assert.match(launcher, /SetErrorMode\(SEM_FAILCRITICALERRORS \| SEM_NOGPFAULTERRORBOX \| SEM_NOOPENFILEERRORBOX\)/, 'Windows launcher should suppress loader error dialogs and surface failures in DStudio');
assert.match(launcher, /C:\\\\msys64\\\\usr\\\\bin;C:\\\\msys64\\\\ucrt64\\\\bin;C:\\\\msys64\\\\mingw64\\\\bin/, 'Windows launcher PATH should include common MSYS2 runtime directories');
assert.doesNotMatch(remoteHelper, /\/tmp\/dstudio-remote-XXXXXX/, 'remote model helper must not hardcode /tmp on Windows clients');
assert.match(remoteHelper, /static const char \*remote_tmp_dir\(void\)[\s\S]*"TMPDIR"[\s\S]*"TMP"[\s\S]*"TEMP"[\s\S]*"USERPROFILE"/, 'remote model helper should use platform temp environment variables');
assert.match(remoteHelper, /static int remote_tempfile\(char \*path, size_t path_len\)/, 'remote model helper should create request body temp files portably');
assert.match(remoteHelper, /O_CREAT \| O_EXCL \| O_WRONLY \| O_BINARY/, 'remote model helper should create temp files atomically and in binary mode');
assert.match(remoteHelper, /#ifdef _WIN32[\s\S]*dstudio_remote_buf_puts\(b, "\\\\\\""\)/, 'remote model helper should quote curl arguments for cmd.exe on Windows');
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
assert.match(js, /let followBottomChatId = null/, 'Chat streaming should track bottom-follow intent across final re-renders');
assert.match(js, /function shouldAutoFollow\(chatId\)/, 'Chat streaming should expose bottom-follow state');
assert.match(js, /function finishAutoFollow\(chatId\)/, 'Chat streaming should consume bottom-follow state after the final render');
assert.match(js, /function onScroll\(\)[\s\S]*followBottom = isNearBottom\(root, 120\)/, 'User navigation should disable or re-enable stream autoscroll based on distance from bottom');
assert.match(js, /Messages\.renderChat\(Store\.getChat\(chat\.id\), \{ stickToBottom \}\)/, 'Final chat render should keep the viewport at bottom when the user did not navigate away');
assert.match(js, /Messages\.finishAutoFollow\(chat\.id\)/, 'Final chat render should clear stream autoscroll state');
assert.match(js, /let agentFollowBottom = false/, 'Agent streaming should track bottom-follow intent');
assert.match(js, /let agentLastScrollTop = 0/, 'Agent streaming should track scroll direction');
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
assert.match(html, /id="lan-client-ds4dir"/, 'LAN client settings should expose the local DS4 runtime folder');
assert.match(html, /id="lan-client-ds4dir-choose"/, 'LAN client settings should let the client choose its local DS4 folder');
assert.match(html, /Local DS4 runtime/, 'LAN client settings should name the client-side DS4 runtime explicitly');
assert.doesNotMatch(html, /Agent and Design requests run on the LAN host|uses the LAN host for Chat, Agent and Design/, 'LAN client copy must not imply host workspaces');
assert.match(js, /const apiUrl = \(path\) => `\$\{path\}`/, 'Engine APIs must stay local in LAN client mode');
assert.match(js, /syncLanClientDs4Dir\(\)/, 'Opening LAN client settings should check the local DS4 folder');
assert.match(js, /window\.ds4PickDirectory\(\{ mode: 'ds4' \}\)/, 'LAN client DS4 folder selection should use the native directory picker');
assert.match(js, /const r = await Engine\.setDs4Dir\(path\)/, 'LAN client DS4 folder selection should update the local launcher ds4dir');
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
assert.match(js, /bindFileDrop\(qs\('\.chat'\)\)/, 'File drag-and-drop should work across the whole Chat surface');
assert.match(js, /if \(!isChatComposerMode\(\) \|\| !dragHasFiles\(e\)\) return/, 'Chat drag-and-drop should use the shared chat-mode guard');
assert.match(js, /readChatFiles\(e\.dataTransfer\.files\)/, 'Dropped files should use the same attachment reader as the paperclip');
assert.match(html, /chat--drop \.composer__card/, 'Chat composer should expose a visible whole-chat drag-over state');
assert.match(js, /cbarAttach\.hidden = readOnly \|\| mode === 'agent'/, 'Attach button should show for Chat, stay for Design and hide in Agent/read-only host mode');
assert.match(js, /function parkNativeThinkSelect\(\)/, 'Composer should keep the native thinking select hidden in the DOM for shortcut compatibility');
assert.match(js, /cap: 'Thinking'/, 'Chat gear should render Thinking with the same custom dropdown component as Web');
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
assert.match(readme, /### 💬 Chat[\s\S]*assets\/demo\.gif/, 'README should feature the chat demo GIF in the Chat section');
assert.match(readme, /### 🤖 Agent[\s\S]*assets\/agent\.gif/, 'README should feature the agent demo GIF in the Agent section');

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
assert.doesNotMatch(loadingHtml, /Loading the local model|Connecting to the local launcher|Waiting for the model to be ready|Open DStudio anyway/, 'loading page should show only the logo, not a status card');

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

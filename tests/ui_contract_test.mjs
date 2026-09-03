import fs from 'node:fs';
import assert from 'node:assert/strict';

const html = fs.readFileSync('web/index.html', 'utf8');
const readme = fs.readFileSync('README.md', 'utf8');
const qualityGates = fs.readFileSync('docs/QUALITY_GATES.md', 'utf8');
const algebraRoadmapExport = fs.readFileSync('exports/abstract-algebra-roadmap.json', 'utf8');
const loadingHtml = fs.readFileSync('web/loading.html', 'utf8');
const designAnnotator = fs.readFileSync('web/design-annotator.js', 'utf8');
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
const jsonlPatchText = fs.readdirSync('patch/ds4-agent-jsonl')
  .filter((name) => name.endsWith('.replace'))
  .sort()
  .map((name) => fs.readFileSync(`patch/ds4-agent-jsonl/${name}`, 'utf8'))
  .join('\n');
const jsonlBuild = fs.readFileSync('patch/ds4-agent-jsonl/build.mk', 'utf8');
const glmRuntimePatch = fs.readFileSync('patch/ds4-glm53-runtime/streaming-memory.patch', 'utf8');
const glmRuntimeScript = fs.readFileSync('scripts/apply-ds4-glm53-runtime.sh', 'utf8');
const visibleDownloadsPatch = fs.readFileSync('patch/ds4-visible-downloads/visible-partials.patch', 'utf8');
const visibleDownloadsScript = fs.readFileSync('scripts/apply-ds4-visible-downloads.sh', 'utf8');
const designBuild = fs.readFileSync('extension/design/design.mk', 'utf8');
const remoteDesign = fs.readFileSync('extension/design/ds4_design.c', 'utf8');
const searchRuntime = fs.readFileSync('extension/search/runtime.js', 'utf8');
const embedServer = fs.readFileSync('scripts/embed-server.sh', 'utf8');
const imagePipelineScript = fs.readFileSync('scripts/image-pipeline-run.py', 'utf8');
const mediaMemoryPatch = fs.readFileSync('patch/ds4-media-memory/residency-lease.patch', 'utf8');
const ideogramScript = fs.readFileSync('scripts/ideogram4-run.py', 'utf8');
const hunyuanScript = fs.readFileSync('scripts/hunyuan-image3-edit.py', 'utf8');
const hunyuanShell = fs.readFileSync('scripts/hunyuan-image3-edit.sh', 'utf8');
const windowsBuild = fs.readFileSync('scripts/build-windows.ps1', 'utf8');
const windowsDs4Build = fs.readFileSync('scripts/build-ds4-windows-cygwin.sh', 'utf8');
const gitignore = fs.readFileSync('.gitignore', 'utf8');
const gsaBenchRunner = fs.readFileSync('extension/gsa/bench/run.mjs', 'utf8');
const gsaRuntimeSource = fs.readFileSync('extension/gsa/dstudio_gsa.cfrag', 'utf8');
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
    const alternatives = ['modern', 'laguna'].map((variant) => {
      const alternativeFind = `${dir}/${id}.${variant}.find`;
      const alternativeReplace = `${dir}/${id}.${variant}.replace`;
      assert.equal(fs.existsSync(alternativeFind), fs.existsSync(alternativeReplace),
        `${dir}/${id}.${variant} must provide both find and replace`);
      if (!fs.existsSync(alternativeFind)) return null;
      const variantFind = fs.readFileSync(alternativeFind, 'utf8');
      assert.ok(variantFind.length > 0, `${alternativeFind} should not be empty`);
      return {
        variant,
        find: variantFind,
        replace: fs.readFileSync(alternativeReplace, 'utf8'),
      };
    }).filter(Boolean);
    return { id, find, replace, alternatives };
  });
  return {
    values,
    edits: bodies,
    text: bodies.map((e) => [e.find, e.replace,
      ...e.alternatives.flatMap((alternative) => [alternative.find, alternative.replace])]
      .join('\n')).join('\n'),
  };
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
const roadmapHelpers = new Function(`
${extractFunction(js, 'stripReasoningTagFragments')}
${extractFunction(js, 'roadmapText')}
${extractFunction(js, 'roadmapSlug')}
${extractFunction(js, 'roadmapSafeUrl')}
${extractFunction(js, 'parseRoadmapDirective')}
${extractFunction(js, 'extractRoadmapFromAssistant')}
${extractFunction(js, 'parseRoadmapBlockDirective')}
${extractFunction(js, 'extractRoadmapBlockFromAssistant')}
return { extractRoadmapFromAssistant, extractRoadmapBlockFromAssistant };
`)();
const roadmapParsed = roadmapHelpers.extractRoadmapFromAssistant(`Percorso pronto.\n\n\`\`\`dstudio-roadmap
${JSON.stringify({
  version: 1,
  title: 'Web engineering',
  stages: [{
    id: 'foundations',
    title: 'Foundations',
    topics: [
      { id: 'html', title: 'HTML', resources: [{ title: 'Safe', url: 'https://developer.mozilla.org/' }] },
      { id: 'html', title: 'CSS', resources: [{ title: 'Unsafe', url: 'javascript:alert(1)' }] },
    ],
  }],
})}
\`\`\``);
assert.equal(roadmapParsed.content, 'Percorso pronto.', 'roadmap JSON should be removed from visible assistant prose');
assert.equal(roadmapParsed.roadmap?.title, 'Web engineering', 'roadmap directive should preserve its title');
assert.deepEqual(roadmapParsed.roadmap?.stages[0].topics.map((topic) => topic.id), ['html', 'html-2'], 'roadmap parser should make duplicate model ids stable and unique');
assert.equal(roadmapParsed.roadmap?.stages[0].topics[1].resources[0].url, '', 'roadmap resources should reject unsafe URL schemes');
const genericJsonRoadmap = roadmapHelpers.extractRoadmapFromAssistant(`\`\`\`json
${JSON.stringify({
  version: 2,
  title: 'Recovered roadmap',
  stages: [{ id: 'stage', title: 'Stage', topics: [{ id: 'topic', title: 'Topic' }] }],
})}
\`\`\``);
assert.equal(genericJsonRoadmap.roadmap?.title, 'Recovered roadmap',
  'a valid v2 roadmap in a generic JSON fence should be normalized without regeneration');
const unclosedGenericJsonRoadmap = roadmapHelpers.extractRoadmapFromAssistant(`\`\`\`json
${JSON.stringify({
  version: 2,
  title: 'Recovered unclosed roadmap',
  stages: [{ id: 'stage', title: 'Stage', topics: [{ id: 'topic', title: 'Topic' }] }],
})}`);
assert.equal(unclosedGenericJsonRoadmap.roadmap?.title, 'Recovered unclosed roadmap',
  'a complete v2 roadmap should survive a missing closing generic JSON fence');
const roadmapBlockParsed = roadmapHelpers.extractRoadmapBlockFromAssistant(`\`\`\`dstudio-roadmap-block
${JSON.stringify({
  title: 'Accessibilità HTML',
  summary: 'Struttura e nomi accessibili.',
  estimatedHours: 6,
  keyConcepts: ['Semantica', 'Nomi accessibili', 'Navigazione da tastiera'],
  outcome: 'Verifichi una pagina usando solo la tastiera.',
  practice: 'Correggi una pagina e documenta la verifica.',
  assessment: 'Supera una checklist e spiega le correzioni applicate.',
  optional: false,
  resources: [
    { title: 'MDN HTML', url: 'https://developer.mozilla.org/docs/Web/HTML' },
    { title: 'Invented', url: 'https://example.invalid/invented' },
  ],
})}
\`\`\``, '', '', ['https://developer.mozilla.org/docs/Web/HTML']);
assert.equal(roadmapBlockParsed?.title, 'Accessibilità HTML', 'a complete generated roadmap block should be accepted');
assert.deepEqual(roadmapBlockParsed?.resources.map((resource) => resource.url), ['https://developer.mozilla.org/docs/Web/HTML'],
  'generated blocks should retain only resource URLs already present in the roadmap');
assert.equal(roadmapHelpers.extractRoadmapBlockFromAssistant(JSON.stringify({ title: 'Incomplete', summary: 'Missing outcome and practice' })), null,
  'an incomplete generated roadmap block should be rejected instead of creating an empty topic');
const roadmapBlockAlias = roadmapHelpers.extractRoadmapBlockFromAssistant(`Model draft: ${JSON.stringify({
  title: 'Alias block', summary: 'A complete aliased block.', estimatedHours: 5,
  keyConcepts: ['First', 'Second', 'Third'], learningOutcome: 'Demonstrate the skill.',
  practiceTask: 'Build a small example.', masteryCheck: 'Explain and test the finished example.',
})}`);
assert.equal(roadmapBlockAlias?.outcome, 'Demonstrate the skill.', 'block parsing should recover common outcome/practice aliases and surrounding prose');
assert.match(html, /id="tab-roadmap"[\s\S]*>Learn</, 'sidebar should expose the Learn workspace');
assert.match(html, /:root\[data-theme="dark"\] body\.roadmap-mode[\s\S]*roadmap-stage__topics[\s\S]*background: var\(--surface\)/,
  'Learn should map its formerly white reference surfaces onto the selected dark theme');
assert.doesNotMatch(html, /roadmap-source-panel|roadmap-url-input/,
  'Roadmap links should come from the prompt without a duplicate source field');
assert.match(html, /id="roadmap-composer-peek"[\s\S]*Roadmap prompt/,
  'Generated Roadmaps should retain the visible up/down prompt handle');
assert.match(html, /body\.roadmap-mode:not\(\.composer-raised\) \.composer[\s\S]*translateY\(calc\(100% - var\(--roadmap-composer-reveal\)\)\)[\s\S]*\.composer:hover,[\s\S]*\.is-roadmap-composer-pinned[\s\S]*translateY\(0\)[\s\S]*\.is-roadmap-auto-lowering/,
  'The Roadmap prompt handle should animate the composer up and lower it again after Send');
assert.doesNotMatch(html, /\.composer:has\(#btn-stop:not\(\[hidden\]\)\)/,
  'The visible Stop button must not force the entire Roadmap composer to stay open');
assert.match(html, /shared prompt surface deliberately matches Agent[\s\S]*body\.roadmap-mode \.composer__card,[\s\S]*body\.roadmap-mode:not\(\.composer-raised\) \.composer__card \{ width: auto; max-width: 48rem;[\s\S]*border-radius: 20px/,
  'Roadmap should use the same 48rem, rounded composer surface as Agent');
assert.match(html, /body\.roadmap-mode \.composer__card:focus-within,[\s\S]*body\.roadmap-mode:not\(\.composer-raised\) \.composer__card:focus-within \{ border-color: var\(--border-2\); box-shadow: 0 8px 30px/,
  'Roadmap focus should match the Agent composer elevation');
assert.match(js, /document\.body\.classList\.remove\('chat-editorial'\)/,
  'Chat should not retain a separate editorial composer skin');
assert.match(js, /function configuredModelLabel\(\)[\s\S]*Flash · chat[\s\S]*ggufList === null \? configuredModelLabel\(\) : 'No model'/,
  'the shared composer should retain its saved model label while GGUF scanning is deferred');
assert.match(html, /\.roadmap-build-assembly[\s\S]*\.roadmap-build-rail[\s\S]*\.roadmap-build-piece--left[\s\S]*@keyframes roadmap-piece-assemble[\s\S]*\.roadmap-hero \.ec-mark \{ color: var\(--accent\)/,
  'Roadmap loading should assemble connected blue graph pieces instead of showing a static dot');
assert.match(js, /const roadmapMode = chat\.mode === 'roadmap';[\s\S]*settings = \{ \.\.\.settings, webMode: 'research', thinkLevel: 'max' \}/,
  'Roadmap requests should override global web/thinking settings with mandatory Deep Research and max');
assert.match(js, /reasoning_effort = thinkLevel === 'max' \? 'max' : 'high'/, 'maximum roadmap thinking should reach the model request body');
assert.match(js, /Roadmaps use true Thinking: max with a temporary 384k\+ local context\./,
  'Roadmap thinking selector should explain the effective true-Max context override');
assert.match(js, /const DS4_TRUE_MAX_CONTEXT = 393216;[\s\S]*ctxSize: Math\.max\([\s\S]*DS4_TRUE_MAX_CONTEXT\)/,
  'Roadmap generation should request the ds4 context threshold required for true Thinking max');
assert.doesNotMatch(js, /const trueMaxContext = \(\)/,
  'Design must not couple Thinking max to an unrelated hidden context override');
assert.doesNotMatch(extractFunction(js, 'startCowork'), /ctx:\s*trueMaxContext\(\)/,
  'Cowork must honor the context selected in Settings instead of silently forcing 392k');
assert.match(extractFunction(js, 'startCowork'), /\.\.\.launchBase\(/,
  'Cowork should inherit the saved context through the shared launch settings');
assert.match(extractFunction(js, 'startDesign'), /ctx:\s*ctxSize\(\)/,
  'Design must honor the context selected in Settings even at Thinking max');
assert.match(js, /function auditRoadmapStage\([\s\S]*function auditRoadmapGlobally\([\s\S]*Checking cross-stage contradictions/,
  'Roadmaps should receive per-stage factual audits followed by a global contradiction audit');
assert.match(js, /DStudio roadmap factual auditor[\s\S]*Ignore prose quality, curriculum completeness, pedagogy[\s\S]*DStudio roadmap curriculum judge[\s\S]*Do not fact-check/,
  'factual auditing and curriculum judging must remain separate model roles');
assert.match(js, /repairVerifiedRoadmap\([\s\S]*kind: 'facts'[\s\S]*continue;[\s\S]*judgeRoadmapCurriculum/,
  'verified factual defects should trigger complete repair and re-audit before curriculum judging');
assert.match(js, /maxTokens: 0,[\s\S]*thinkLevel: 'max'/,
  'Roadmap verification passes should omit arbitrary output-token caps and use Thinking max');
assert.doesNotMatch(algebraRoadmapExport, /campo di spezzamento di x\^3-2 non è di Galois/,
  'the saved abstract-algebra Roadmap must not retain the false splitting-field claim');
assert.match(algebraRoadmapExport, /Q\(cuberoot\(2\)\)\/Q non è di Galois[\s\S]*Q\(cuberoot\(2\), zeta_3\)\/Q è di Galois/,
  'the Galois regression fixture should distinguish the non-normal simple extension from its Galois splitting field');
assert.match(js, /DStudio learning-roadmap protocol:[\s\S]*exactly one fenced block whose info string is dstudio-roadmap, with no prose before or after it/, 'Roadmap prompt should require one structured graph payload without chat prose');
assert.match(js, /roadmapProgress[\s\S]*Store\.patchMessage/, 'Roadmap topic completion should persist on the assistant message');
assert.match(js, /msg--roadmap-direct[\s\S]*buildRoadmapCard/, 'Roadmap replies should render as a direct canvas instead of generic assistant chat chrome');
assert.match(js, /roadmapOverride[\s\S]*roadmapStudyThreads/, 'Roadmap node edits and per-node study threads should persist with the generated graph');
assert.match(js, /dedicated long-term tutor for exactly one block[\s\S]*normalizeTutorThinkLevel[\s\S]*thinkLevel: tutorThinkLevel/,
  'Each roadmap block should open a focused Tutor that forwards its selected thinking level');
assert.match(js, /class: 'roadmap-study__think'[\s\S]*Thinking: off[\s\S]*Thinking: normal[\s\S]*Thinking: max[\s\S]*thread\.thinkLevel = normalizeTutorThinkLevel/,
  'Tutor chats should expose and persist off, normal and max thinking choices');
assert.match(html, /\.roadmap-study__messages \{ width: min\(900px, 100%\)[\s\S]*\.roadmap-study-msg--assistant \{ width: 100%; max-width: none[\s\S]*\.roadmap-study__composer-inner \{ width: min\(900px, 100%\)/,
  'Tutor answers and composer should share one centered content measure');
assert.match(html, /\.roadmap-study__form \{[\s\S]*grid-template-rows: auto minmax\(58px, auto\) auto[\s\S]*border-radius: 20px[\s\S]*\.roadmap-study__controls/,
  'Tutor should use the same two-level rounded composer layout as normal Chat');
assert.match(js, /function beginTutorModelSession\(host\)[\s\S]*host\.append\(cbarModel\)[\s\S]*function endTutorModelSession\(\)[\s\S]*marker\.replaceWith\(cbarModel\)/,
  'Tutor should reuse and restore the real Chat model picker instead of rendering a dead copy');
assert.match(js, /DStudio Tutor[\s\S]*thinking thinking--reasoning[\s\S]*event\.type === 'reasoning'/, 'Tutor chats should visibly render and persist model thinking');
assert.match(js, /const tutorFollow = createFollowScroll[\s\S]*shouldDeferTutorRenderForSelection[\s\S]*selectionInside\(messagesEl\)[\s\S]*tutorFollow\.settle/,
  'Tutor streaming should preserve text selection and release bottom-follow when the learner scrolls up');
assert.match(js, /function studyAttachmentContext\(/, 'Tutor rooms should place attached material in the focused model context');
assert.match(js, /beginTutorAttachmentSession[\s\S]*prepareTutorAttachments/, 'Tutor rooms should reuse Chat file, PDF and local-vision attachments');
assert.match(js, /Chat\.tutorFormattingProtocols\(\)[\s\S]*DStudio Tutor file output protocol/, 'Tutor replies should inherit normal Chat math, ASCII and downloadable-file behavior');
assert.match(js, /dragHandle[\s\S]*dragstart[\s\S]*targetStage\.topics\.splice/, 'Roadmap blocks should support persisted drag-and-drop ordering');
assert.match(js, /New learning block title[\s\S]*New learning block description/, 'Adding a roadmap block should collect both its title and description');
assert.match(js, /function buildLearningSourceContext\([\s\S]*\[Learning source evidence\][\s\S]*function readLearningSourcesDirectly\([\s\S]*classifier skipped/,
  'Roadmap learning links should be read directly instead of waiting for the generic web classifier');
assert.match(searchRuntime, /The Roadmap composer has no separate URL field[\s\S]*domain\.tld\/path/,
  'Roadmap source extraction should recognize unambiguous links pasted directly into the prompt');
assert.match(js, /readsLearningSources[\s\S]*await readLearningSourcesDirectly\(webQuery, learningSourceUrls, updateTrace, signal\)/,
  'Roadmap preflight should route explicit learning links through the direct reader');
assert.match(js, /DStudio roadmap-block expansion protocol:[\s\S]*dstudio-roadmap-block[\s\S]*thinkLevel: 'max'/,
  'New roadmap blocks should be elaborated by a strict max-thinking model request');
assert.match(js, /generateRoadmapTopic[\s\S]*Store\.setChatStreaming\(chat\.id, runController\)[\s\S]*persistRoadmap\(next\)/,
  'The add form should expose and persist its asynchronous model generation lifecycle');
assert.match(js, /roadmapContext[\s\S]*targetStage[\s\S]*for \(;;\)[\s\S]*maxTokens: 8192[\s\S]*finishReason === 'length'[\s\S]*retrying attempt/,
  'Block generation should use compact context, a large budget and an abortable retry-until-valid loop');
assert.match(js, /function captureRoadmapCanvas\([\s\S]*function canvasRoadmapPdf\(/, 'Roadmap PNG/PDF export should render the graph locally');
assert.match(js, /clone\.style\.fontFamily = bodyStyle\.fontFamily[\s\S]*Math\.sqrt\(64_000_000[\s\S]*Math\.min\(3,[\s\S]*16_000 \/ width/,
  'Roadmap image export should render at up to 3x within a high-resolution pixel budget and preserve the app font');
assert.match(js, /Download roadmap[\s\S]*\['png', 'Image'\][\s\S]*\['pdf', 'Document'\][\s\S]*\['json', 'Data'\]/, 'Roadmaps should offer PNG, PDF and JSON downloads');
assert.match(html, /\.roadmap-card\s*\{[\s\S]*background:\s*transparent;[\s\S]*box-shadow:\s*none;/, 'The roadmap should render directly without a gradient card shell');
assert.match(js, /<details class="md-details"[\s\S]*md-details__body/, 'Tutor HTML hint markup should become safe native collapsible controls');
assert.match(js, /class: 'chat-item__rename'[\s\S]*startRename\(item\)/, 'Every writable sidebar conversation should expose a visible rename control');
const imageDirectiveHelpers = new Function(`
${extractFunction(js, 'stripReasoningTagFragments')}
${extractFunction(js, 'parseImageGenerationDirective')}
${extractFunction(js, 'extractImageGenerationDirectiveFromAssistant')}
return { extractImageGenerationDirectiveFromAssistant };
`)();
for (const [label, prompt] of [
  ['Italian', 'Una balena nello spazio'],
  ['Arabic', 'حوت يسبح بين النجوم'],
  ['Japanese', '星空を泳ぐクジラ'],
]) {
  const parsed = imageDirectiveHelpers.extractImageGenerationDirectiveFromAssistant(
    `Va bene.\n\n\`\`\`dstudio-image\n${JSON.stringify({ prompt })}\n\`\`\``,
  );
  assert.equal(parsed.directive?.prompt, prompt, `${label} image directive should preserve the model-selected prompt`);
  assert.equal(parsed.content, 'Va bene.', `${label} directive should be removed from visible chat content`);
}
assert.equal(
  imageDirectiveHelpers.extractImageGenerationDirectiveFromAssistant('Analizzo questa immagine senza crearne una.').directive,
  null,
  'ordinary assistant answers should not activate image generation',
);
const editDirective = imageDirectiveHelpers.extractImageGenerationDirectiveFromAssistant(
  'Procedo.\n```dstudio-image\n{"action":"edit","prompt":"Replace the body but preserve the face","preserve":"face"}\n```',
).directive;
assert.equal(editDirective?.action, 'edit', 'image edit directives should preserve the semantic action');
assert.equal(editDirective?.prompt, 'Replace the body but preserve the face', 'image edit directives should preserve editing instructions');
assert.equal(editDirective?.preserve, 'face', 'image edits should carry semantic face pixel-preservation intent');
assert.doesNotMatch(js, /function imageGenerationIntent\(/, 'the UI must not classify multilingual image intent with a keyword regex');
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
${extractFunction(js, 'balancedEvidenceText')}
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
  balancedEvidenceText,
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
const roadmapQualityReport = new Function(`
${extractFunction(js, 'roadmapQualityReport')}
return roadmapQualityReport;
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
assert.match(gitignore, /^\/design\/$/m, 'generated Design workspaces should stay out of git status');
assert.match(gitignore, /^\/exports\/$/m, 'generated exports should stay out of git status');

assert.deepEqual(sourceAdapterHelpers.validSourceKinds(), ['article', 'docs', 'product', 'academic', 'social', 'repo', 'generic']);
const balancedEvidence = sourceAdapterHelpers.balancedEvidenceText(
  `HEAD-${'a'.repeat(400)}-MIDDLE-${'b'.repeat(400)}-TAIL`,
  240,
);
assert.equal(balancedEvidence.length, 240);
assert.match(balancedEvidence, /^HEAD-/);
assert.match(balancedEvidence, /\[middle excerpt\]/);
assert.match(balancedEvidence, /\[closing excerpt\]/);
assert.match(balancedEvidence, /-TAIL$/);
assert.equal(sourceAdapterHelpers.classifySourceKind({ url: 'https://example.com/pricing', title: 'Pricing plans' }, 'quanto costa?'), 'product');
assert.equal(sourceAdapterHelpers.classifySourceKind({ url: 'https://docs.example.com/api', title: 'API reference' }, 'come uso api?'), 'docs');
assert.equal(sourceAdapterHelpers.classifySourceKind({ url: 'https://arxiv.org/abs/1234.5678', title: 'Abstract paper' }, 'paper'), 'academic');
assert.equal(sourceAdapterHelpers.classifySourceKind({ url: 'https://news.ycombinator.com/item?id=1', title: 'HN thread' }, 'opinioni'), 'social');
assert.equal(sourceAdapterHelpers.classifySourceKind({ url: 'https://codeberg.org/user/project', title: 'README repository' }, 'che stack usa?'), 'repo');
assert.equal(sourceAdapterHelpers.classifySourceKind({ url: 'https://dev.to/example/compiler-guide', title: 'How to build a compiler', content: 'A source-code study with abstract syntax trees.' }, 'impara i compilatori'), 'article');
assert.equal(sourceAdapterHelpers.classifySourceKind({ url: 'https://example.com/lesson', title: 'Source code study guide', content: 'Read the source code and study each chapter.' }, 'impara'), 'generic');
assert.equal(sourceAdapterHelpers.sourceAdapterProfile({ url: 'https://example.com/features' }, 'features').kind, 'product');
assert.match(sourceAdapterHelpers.sourceKindGuidance('academic'), /authors|results|limitations/i);
assert.match(sourceAdapterHelpers.sourceKindGuidance('social'), /anecdotes/i);
assert.equal(sourceAdapterHelpers.technicalQuestionLikely('che stack e licenza usa?'), true);
assert.equal(sourceAdapterHelpers.technicalQuestionLikely('qual e il prezzo?'), false);
assert.equal(sourceAdapterHelpers.readSourceUnusable({ title: 'File not found', content: 'Repository navigation' }), true);
assert.equal(sourceAdapterHelpers.readSourceUnusable({ title: 'LICENSE', content: 'BSD 3-Clause License Copyright permission' }), false);
const compactRoadmapQuality = roadmapQualityReport({
  title: 'Compact skill',
  goal: 'Learn one narrowly scoped skill in a short session.',
  audience: 'Experienced programmer',
  estimatedDuration: '4 hours',
  assumptions: ['The learner already understands programming fundamentals.'],
  stages: [{
    id: 'focused-stage',
    title: 'Focused stage',
    description: 'One coherent phase is sufficient for this deliberately narrow goal.',
    duration: '4 hours',
    objectives: ['Produce and explain a working artifact using the target skill.'],
    checkpoint: 'Complete the artifact unaided and explain every relevant choice.',
    topics: [{
      id: 'focused-topic',
      title: 'Focused topic',
      summary: 'A single coherent unit covering exactly the narrow requested outcome without artificial fragmentation.',
      estimatedHours: 4,
      prerequisites: [],
      keyConcepts: ['The concept required for the requested outcome'],
      outcome: 'Produce the requested artifact independently and explain its behavior.',
      practice: 'Build a complete small artifact, test it, and document the decisions made.',
      assessment: 'Rebuild the artifact without notes and pass a concrete behavior checklist.',
      resources: [
        { url: 'https://example.com/one' },
        { url: 'https://example.org/two' },
        { url: 'https://example.net/three' },
      ],
    }],
  }],
  capstone: {
    title: 'Focused artifact',
    description: 'Demonstrate the narrowly requested skill in a complete artifact.',
    deliverables: ['Working artifact', 'Short explanation'],
    successCriteria: ['Works as specified', 'Can be explained', 'Can be reproduced unaided'],
  },
});
assert.equal(compactRoadmapQuality.pass, true,
  `A complete one-stage, one-topic roadmap must not be rejected merely for being compact: ${JSON.stringify(compactRoadmapQuality)}`);
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
assert.match(js, /Store\.subscribe\('connection',[\s\S]*startLocalEngineRecovery\(\)/,
  'Chat/Roadmap should automatically recover the local engine when health turns down');
assert.match(js, /function startLocalEngineRecovery\([\s\S]*canRecoverLocalEngine\([\s\S]*Il motore locale non è in esecuzione\. DStudio lo sta avviando…[\s\S]*Switcher\.ensureChatReady\(/,
  'automatic local recovery should start the saved engine configuration and announce the attempt');
assert.match(js, /Il riavvio automatico non è riuscito:[\s\S]*Doctor\.open\(\)/,
  'a failed automatic recovery should show the diagnostic reason instead of silently leaving Chat unavailable');
assert.match(js, /isRecovering: \(\) => !!autoRecoveryFlight[\s\S]*Store\.subscribe\('connection', refresh\)[\s\S]*text: recovering \? 'Starting…' : actionLabel\(c\.action\)/,
  'an open System check should replace a stale Start action with an automatic-start status');
assert.doesNotMatch(extractFunction(js, 'restartEngineIfDown'), /askConfirm/,
  'manual connection recovery should no longer require confirmation');
assert.match(js, /async function diagnostics\(\)[\s\S]*\/api\/diagnostics/, 'Engine client should expose workspace diagnostics');
assert.match(js, /async function updatesCheck\(\)[\s\S]*\/api\/updates\/check/, 'Engine client should expose Update Doctor checks');
assert.match(js, /async function updatesRun\(tasks\)[\s\S]*\/api\/updates\/run/, 'Engine client should expose selected Update Doctor runs');
assert.match(html, /class="field updates-panel"[\s\S]*updates-panel__title[\s\S]*updates-task-grid[\s\S]*id="updates-list" class="updates-list"/, 'Update Doctor settings should use the structured maintenance panel layout');
assert.match(html, /id="updates-progress-dialog"[\s\S]*id="updates-progress-bar"[\s\S]*id="updates-progress-current"[\s\S]*id="updates-progress-steps"/, 'Update Doctor should have a modal progress UI with current action and task list');
assert.match(html, /Fetch ds4 upstream, then verify managed tools, patch gates and design systems\. Skills remain user-authored\./, 'Update Doctor should distinguish managed updates from user-authored skills');
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
assert.doesNotMatch(launcher, /CYBER_SKILLS_REL_DIR|DS4UI_CYBER_SKILLS_DIR/, 'launcher should not expose a downloaded cybersecurity skill catalog');
assert.match(launcher, /DStudio does not install a skill catalog/, 'Agent startup should state that skills are user-authored');
assert.ok(Number(jsonlPatch.values.get('version')) >= 46, 'JSONL patch version should force rebuild after remote transcript UTF-8 validation changes');
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
assert.match(gsaRuntimeSource, /gsa_tools_install_spawn[\s\S]*fork\(\)[\s\S]*execl\("\/bin\/bash"[\s\S]*gsa_tools_install_reap/, 'GSA install should execute the generated installer as a supervised background task');
assert.match(launcher, /path_eq_clean\(path, "\/api\/gsa\/tools"\)/, 'router should serve /api/gsa/tools');
assert.match(launcher, /\/api\/gsa\/tools\/install/, 'router should serve /api/gsa/tools/install');
assert.ok(Array.isArray(gsaToolCatalog.tools), 'GSA tool catalog should be a JSON tools array');
assert.ok(gsaToolCatalog.tools.length >= 30, 'GSA tool catalog should keep the managed tool set in JSON');
assert.ok(gsaToolCatalog.tools.every((tool) => tool.name && tool.category && tool.aliases && tool.install && tool.notes), 'Every GSA tool catalog entry should carry required fields');
const gsaCommandSpecs = html.slice(html.indexOf('const GSA_COMMAND_SPECS = ['), html.indexOf('const SUPPORT_COMMAND_SPECS = ['));
assert.ok(gsaCommandSpecs.length > 0, 'Agent timeline should declare semantic command specs for GSA tools');
for (const tool of gsaToolCatalog.tools) {
  const aliases = String(tool.aliases || '').split('|').filter(Boolean);
  assert.ok(aliases.some((alias) => gsaCommandSpecs.includes(`'${alias}'`)),
    `Agent timeline should recognize the catalog command for ${tool.name}`);
}
assert.match(html, /function semanticCommandSummary\(ev, live, lineCount = 0\)[\s\S]*parameters:/,
  'GSA shell actions should keep effective parameters in both live and completed timeline summaries');
assert.match(html, /function compactShellText\(text\)[\s\S]*map\(\(word\) => word\.raw\)/,
  'GSA parameter summaries should preserve the exact flags and values supplied to the tool');
assert.doesNotMatch(gsaCommandSpecs, /redact|SECRET_PARAMETER|SECRET_QUERY/,
  'GSA command presentation must not obscure credentials or other parameter values');
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
assert.doesNotMatch(gsaRuntimeSource, /gsa_write_user_skill_shortlist|gsa_workspace_signals|user_skills_dir|skills\.md/, 'GSA must not load or shortlist skills');
assert.match(gsaRuntime, /json_get_string\(body, "targetUrl", req->target_url/, 'GSA start should accept an optional authorized target URL');
assert.match(gsaRuntime, /gsa_extract_first_url\(req->mission, req->target_url/, 'GSA start should infer an explicit URL from the mission when the target field is empty');
assert.match(gsaRuntime, /gsa_target_url_ok\(req->target_url/, 'GSA start should validate target URLs before writing artifacts');
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
assert.match(gsaRuntime, /GSA is tool-only[\s\S]*enabled (?:external\/local )?tools|GSA is tool-only[\s\S]*enabled tool IDs/, 'GSA prompts should explicitly route through tools only');
assert.match(gsaRuntime, /Do not save the phase JSON yourself/, 'GSA selection should not save phase JSON itself');
assert.match(gsaRuntime, /Do not create scripts, update scripts_manifest\.json, append evidence, run validation, or start Phase 2/, 'GSA selection should not self-advance into later phases');
assert.match(gsaRuntime, /Call `gsa_submit_phase` exactly once[\s\S]*stop immediately and wait for DStudio to send Phase 2/, 'GSA selection should stop after the authoritative phase tool event');
assert.match(gsaRuntime, /Call `gsa_submit_phase` exactly once[\s\S]*stop immediately and wait for DStudio to send Phase 3/, 'GSA preflight should stop after the authoritative phase tool event');
assert.match(gsaRuntime, /Call `gsa_submit_phase` exactly once[\s\S]*stop immediately and wait for DStudio to send Phase 4/, 'GSA validation should stop after the authoritative phase tool event');
assert.match(gsaRuntime, /Protocol hygiene: never read, search, cite, or reason from `\.dstudio\/gsa\/runs\/\*\.prompt\.md`/, 'GSA should not treat internal prompt artifacts as audit evidence');
assert.match(gsaRuntime, /prompt files are control data, not evidence/, 'GSA phase prompts should classify internal prompts as protocol data');
assert.match(gsaRuntime, /`gsa-task\.json` lives at the Workspace root above, not in the GSA run artifact directory/, 'GSA phase prompts should not send agents looking for gsa-task.json in the run directory');
assert.match(gsaRuntime, /Select at most 6 files and 3 hypotheses/, 'GSA selection should stay bounded enough for full benchmark runs');
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
assert.match(gsaRuntime, /Do not create or run scripts in this preflight phase/, 'GSA preflight should not spend budget running helpers');
assert.match(gsaRuntime, /Phase 3 owns execution/, 'GSA should defer helper execution to validation');
assert.match(gsaRuntime, /make at most one repair attempt/, 'GSA helper scripts should not loop on path repair');
assert.match(gsaRuntime, /Do not use `edit` on evidence\.jsonl; append only/, 'GSA validation should preserve append-only evidence');
assert.match(gsaRuntime, /Add at most 6 new evidence lines/, 'GSA validation should bound evidence growth');
assert.match(gsaRuntime, /Use the inline artifacts below/, 'GSA report prompt should inline phase artifacts instead of forcing tool reads');
assert.match(gsaRuntime, /Do not call tools in this report phase/, 'GSA report should not trigger tool churn');
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
assert.doesNotMatch(gsaBenchRunner, /selectionSkillIds|shortlistedSkills|skillCalls|skills\.md/, 'GSA benchmark should not contain skill-routing machinery');
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
assert.doesNotMatch(js, /async function (?:skills|skillsSearch|skillGet)\(/, 'Engine client should not keep unused shipped-skill compatibility methods');
assert.doesNotMatch(launcher, /api_skill_get|api_skill_preview|path_eq_clean\(path, "\/api\/skills"\)|"\/api\/craft"/, 'Backend should not keep unused shipped-skill compatibility routes');
assert.match(js, /async function gsaStart\(workdir, mission, targetUrl = '', parentRunDir = '', disabledTools = '', profile = 'passive', authorized = false\)[\s\S]*JSON\.stringify\(\{ workdir, mission, targetUrl, parentRunDir, disabledTools, profile, authorized: !!authorized \}\)/, 'Engine client should send target URL, parent GSA run, disabled tools and security profile context');
assert.match(js, /Store\.setSettings\(\{ gsaMode: 'off', rsaMode: 'off', thinkLevel: 'max' \}\)/, 'Starting GSA should force the visible thinking state to max and clear RSA');
assert.match(js, /AgentView\.send\(res\.prompt,[\s\S]*\{ forceThink: 'max' \}\)/, 'GSA turns should force runtime thinking max');
assert.match(js, /function wirePromptForRuntime\(prompt, forceThink = ''\)[\s\S]*runtimeThinkControlFrame\(forceThink\) \+ prompt/, 'Runtime prompt wiring should support forced thinking for GSA');
assert.match(js, /Store\.setSettings\(\{ gsaMode: v,[\s\S]*thinkLevel: 'max'/, 'Enabling GSA should move the composer thinking pill to max');
assert.match(js, /Guided analysis always runs with Thinking: max/, 'Thinking selector should reject lowering guided analysis below max');
// Thinking: max only becomes real at DS4_TRUE_MAX_CONTEXT, so it must be an
// explicit choice that negotiates the context — never an imposed default.
assert.match(js, /thinkLevel: 'high',\s*\/\/ user may choose off\/high\/max/, 'a fresh profile should default to high thinking, not max');
assert.doesNotMatch(js, /thinkLevel: 'max', videoProfile: 'quality'/, 'the quality-defaults migration must not impose Thinking: max on existing installs');
assert.match(js, /qualityDefaultsVersion \|\| 0\) < 2[\s\S]*qualityDefaultsVersion: 2/, 'the quality-defaults migration should advance past the version that imposed max');
assert.doesNotMatch(js, /qualityDefaultsVersion \|\| 0\) < 2[\s\S]{0,180}videoProfile:/, 'the thinking migration must preserve an explicitly selected video profile');
assert.match(js, /async function confirmTrueThinkingMax\(\)[\s\S]*current >= DS4_TRUE_MAX_CONTEXT[\s\S]*Store\.setSettings\(\{ ctxSize: DS4_TRUE_MAX_CONTEXT, ctxBeforeThinkMax: current \}\)/, 'choosing max below the minimum context should offer to raise it and remember the previous value');
assert.match(js, /function restoreContextAfterThinkingMax\(\)[\s\S]*Store\.setSettings\(\{ ctxSize: previous, ctxBeforeThinkMax: 0 \}\)/, 'leaving max should hand the original context back');
assert.match(js, /if \(!ok\) \{ renderThinkingPill\(\); return; \}\s*\/\/ declined: keep the previous level/, 'declining the context raise must leave the thinking level untouched');
assert.match(js, /function metalResidencyEstimate\(ctxSize, memory\)[\s\S]*required <= budget/, 'the UI should estimate Metal residency before proposing a bigger context');
assert.match(js, /function flashContextMemoryBytes\(ctxSize\)[\s\S]*43 \* rawCap \* 512 \* 4/, 'the UI estimate should mirror flash_context_memory_bytes from the launcher');
assert.match(js, /drops off full residency onto the memory-mapped path/, 'the max prompt should state the residency cost when the raised context no longer fits');
assert.match(js, /maxUnderfed = !roadmapLocked && value === 'max' && ctxNow < DS4_TRUE_MAX_CONTEXT/, 'a persisted max below the minimum context should be flagged in the composer pill');
assert.match(html, /<option value="393216">384k tokens<\/option>/, 'the context pickers should be able to express the true-max minimum');
// Recovering your own prompt must not depend on dragging a selection across a
// transcript that keeps repainting underneath the cursor.
assert.match(js, /function buildAgentUserTurn\(text, pending = false\)[\s\S]*class: 'agent-user-copy'[\s\S]*copyTextToClipboard\(copy, parsed\.clean \|\| body\)/, 'every Agent/Cowork user turn should carry a copy button');
assert.match(html, /\.agent-user-turn:hover \.agent-user-copy,[\s\S]*\.agent-user-copy\.is-copied \{ opacity: 1; \}/, 'the user-turn copy button should reveal on hover and stay visible while confirming');
assert.match(js, /async function gsaTools\(\)[\s\S]*\/api\/gsa\/tools/, 'Engine client should expose GSA tool status');
assert.match(js, /async function gsaToolsInstall\(\)[\s\S]*\/api\/gsa\/tools\/install/, 'Engine client should expose managed GSA tool install');
assert.match(html, /\.msg__activity-dots[\s\S]*@keyframes msgactivity/, 'Chat streaming should show an animated activity indicator');
assert.match(js, /function assistantInitialActivity\(userMsg\)[\s\S]*Reading attached file[\s\S]*Reading sources[\s\S]*Preparing response/, 'Chat activity should describe file/source reading when applicable');
assert.match(js, /decodeTokPerSec: Number\(u\.ds4\?\.decode_tokens_per_second\) > 0/, 'Chat should read exact decode speed from the ds4 usage extension');
assert.doesNotMatch(js, /content\.length \+ reasoning\.length\) \/ 4/, 'Chat should not present chars/4 as live token speed');
assert.match(launcher, /setup_ensure_server_metrics_runtime[\s\S]*setup_binary_contains_ascii\(server, "decode_tokens_per_second"\)[\s\S]*"make", "-C", g_ds4_dir, "ds4-server"/, 'Chat startup should self-heal when an upstream make replaces the metrics-enabled server');
assert.match(launcher, /spawn_server[\s\S]*setup_ensure_server_metrics_runtime\(err, errsz\)/, 'Chat must verify exact-throughput support before launching ds4-server');
assert.match(js, /\/gsa\s/, 'composer should expose the GSA slash command');
assert.match(html, /id="gsa-target-panel"[\s\S]*id="gsa-target-url"/, 'Agent composer should expose an optional GSA target URL field');
assert.match(js, /gsaTargetUrl: ''/, 'GSA target URL should be persisted as an explicit setting');
assert.match(js, /gsaLoop: 'off'/, 'GSA loop should be persisted as an explicit off/on setting');
assert.match(js, /gsaDisabledTools: \[\]/, 'GSA disabled tool choices should persist in settings');
assert.match(js, /enginePower: 90/, 'Engine power should default to ds4 --power 90');
assert.match(js, /ssdStreaming: 'off'/, 'SSD streaming should default off while DS4 is the sole heavyweight model');
assert.match(js, /metalHotlistSeed: false/, 'Metal expert hotlist seed should default to off for stability');
assert.match(html, /id="set-metal-hotlist"/, 'Settings should expose the Metal expert hotlist seed toggle');
assert.match(js, /const launchBase = \(remote = false\)[\s\S]*\.\.\.\(remote \? \{\} : \{ ssdStreaming: ssdStreaming\(\), metalHotlistSeed: metalHotlistSeed\(\), dspark: dspark\(\) \}\)/, 'Engine starts should omit local streaming preferences for remote models');
assert.match(launcher, /json_get_bool\(body, "metalHotlistSeed"\)/, 'launcher should parse the Metal expert hotlist seed setting');
assert.match(launcher, /DS4_METAL_DISABLE_STREAMING_EXPERT_HOTLIST/, 'launcher should gate the Metal hotlist kill switch on the setting');
assert.match(js, /function modelIdForEngineStatus\(st\)[\s\S]*modelFile[\s\S]*deepseek-v4-pro[\s\S]*deepseek-v4-flash/, 'live engine status should map the running GGUF to the correct API model id');
assert.match(js, /liveModelId = modelIdForEngineStatus\(st\)[\s\S]*Store\.setSettings\(\{ model: liveModelId \}\)/, 'status sync should replace stale Flash/Pro labels with the running model id');
assert.match(js, /SSD streaming running \$\{runningSsd\}[\s\S]*next restart \$\{desiredSsd\}/, 'Settings should distinguish the running SSD mode from a pending restart preference');
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
assert.match(js, /systemPresets = \(dsCache \|\| \[\]\)[\s\S]*designSystemId[\s\S]*\/api\/design-system-preview\/\$\{encodeURIComponent\(s\.id\)\}\/components\.html/, 'Design gallery should include local design systems through their original components.html previews');
assert.match(js, /Store\.setSettings\(\{ designSystem: preset\.designSystemId \}\)/, 'Selecting a design-system card should set the active design system for the next Design turn');
assert.match(launcher, /preview_rel_asset_ok[\s\S]*\"css\"[\s\S]*\"js\"[\s\S]*\"woff2\"[\s\S]*\"mp4\"/, 'Backend preview route should allow original static assets required by template previews');
assert.match(launcher, /DESIGN_HEADERS[\s\S]*style-src 'self' 'unsafe-inline' https:[\s\S]*script-src 'self' 'unsafe-inline' https:[\s\S]*font-src 'self' data: https:/, 'Design preview CSP should allow original HTTPS-hosted template CSS, scripts and fonts');
assert.match(launcher, /hasComponents/, 'Design-system catalog entries should report when components.html exists');
assert.match(launcher, /api_design_system_preview[\s\S]*extension\/design-systems[\s\S]*design_content_type/, 'Backend should serve original design-system preview files');
assert.match(launcher, /design_system_preview_rel_ok[\s\S]*preview_rel_asset_ok\(rel, "components\.html"\)/, 'Design-system preview route should allow local design-system preview assets without generated fallbacks');
assert.match(html, /id="design-preview-dialog"[\s\S]*id="design-preview-frame"/, 'Design cards should open a full preview modal');
assert.match(js, /function openDesignGalleryPreview\(preset\)[\s\S]*designPreviewFrame\.src = preset\.previewUrl/, 'Design preview modal should load the original preview URL');
assert.match(js, /function openDesignGallery\(\) \{[\s\S]*curMode === 'design' && AgentView\.openDesignGalleryInline[\s\S]*AgentView\.openDesignGalleryInline\(\)[\s\S]*return/, 'Design gallery should open inline from composer controls in Design mode');
assert.match(js, /icon: 'spark', title: 'Visual starting points'[\s\S]*openDesignGallery\(\)/, 'Design plus menu should open the gallery from a dedicated labelled action');
assert.match(js, /function renderGsaToolsDialog\(\)[\s\S]*gsa-tool-card__purpose/, 'GSA tools modal should render purpose text');
assert.match(js, /function renderGsaToolsDialog\(\)[\s\S]*gsa-tool-toggle/, 'GSA tools modal should render enable toggles');
assert.match(js, /function gsaToolInstallProblem\(tool\)[\s\S]*missingInstaller/, 'GSA tools modal should surface missing installer prerequisites');
assert.match(js, /function renderGsaToolsDialog\(\)[\s\S]*gsaToolInstallBusy\(\)[\s\S]*Install missing/, 'GSA tools modal should summarize, execute and track missing-tool installation');
assert.match(html, /id="gsa-tools-search"[\s\S]*data-gsa-tools-filter="all"[\s\S]*data-gsa-tools-filter="enabled"[\s\S]*data-gsa-tools-filter="missing"/, 'GSA tools modal should match the reference search and segmented filters');
assert.match(js, /GSA_TOOL_GROUP_ORDER[\s\S]*Recon & scanning[\s\S]*Web & browser[\s\S]*Reverse & pwn/, 'GSA tools modal should group the catalog like the supplied layout');
assert.match(js, /function setGsaToolEnabled\(tool, enabled\)[\s\S]*gsaDisabledTools/, 'GSA tool toggles should persist enabled\/disabled state');
assert.match(js, /async function gsaStart\(workdir, mission, targetUrl = '', parentRunDir = '', disabledTools = '', profile = 'passive', authorized = false\)[\s\S]*disabledTools[\s\S]*profile[\s\S]*authorized/, 'Engine GSA start should send disabled tools and security profile context to the backend');
assert.match(gsaRuntime, /function gsa_tools_json_filtered|static int gsa_tools_json_filtered/, 'GSA runtime should support per-run filtered tool status');
assert.match(gsaRuntime, /\\"enabled\\":%s/, 'GSA toolStatus should expose whether a tool is enabled for the run');
assert.match(gsaRuntime, /json_get_string\(body, "disabledTools"/, 'GSA start endpoint should read disabled tool choices');
assert.match(js, /await ensureGsaToolsForRun\(\)[\s\S]*Engine\.gsaStart\(workdir, mission, targetUrl, '', gsaDisabledToolsPayload\(\), securityProfileValue\(\), securityAuthorizedValue\(\)\)/, 'GSA submit should preflight tool status before preparing the run with security profile context');
assert.match(js, /AgentView\.send\(res\.prompt, targetUrl \? `\$\{display\}\\nTarget: \$\{targetUrl\}` : display, \{ forceThink: 'max' \}\)/, 'GSA should hide the internal prompt while showing the visible mission and target while forcing thinking max');
assert.match(js, /function buildLoadedPacksRow\(text\)[\s\S]*loadedPacks\(text\)[\s\S]*class: 'skill-use__eye', text: 'USING'/, 'Agent transcript should show which user skill, craft or brand is in use');
assert.match(js, /\(s\.ev\.input \|\| \{\}\)\.name \|\| \(s\.ev\.input \|\| \{\}\)\.id/, 'Agent skill usage badge should handle skill tool calls that pass id instead of name');
assert.match(js, /if \(viewMode === 'agent'\) \{[\s\S]*buildLoadedPacksRow\(partText\)/, 'Agent responses should render loaded skill usage outside the collapsed tool fold');
assert.match(js, /if \(name === 'skill' \|\| name === 'craft' \|\| name === 'design_system'\)[\s\S]*const kind = name === 'design_system' \? 'brand' : name/, 'tool labels should name loaded skills and design systems cleanly');
assert.doesNotMatch(html, /id="cyber-skills-view"|id="cyber-skills-query"/, 'Skills dialog should not expose a downloaded cybersecurity catalog');
assert.doesNotMatch(js, /function renderCyberSkills|source: 'anthropic'/, 'Skills UI should not search downloaded skill catalogs');
assert.match(js, /gsaMode: 'off'/, 'GSA mode should be persisted as an explicit off/on setting');
assert.match(js, /composerToggleRow\(\{[\s\S]*badge: 'GSA', title: 'Guided Security Analysis'[\s\S]*Switcher\.switchGsa/, 'Composer plus menu should expose GSA as a semantic switch');
assert.match(js, /composerToggleRow\(\{[\s\S]*badge: 'RSA', title: 'Reverse Structure Analysis'[\s\S]*Switcher\.switchRsa/, 'Composer plus menu should expose RSA as a semantic switch');
assert.match(js, /function renderGsaLoopPill\(\)[\s\S]*cbar-loop-btn[\s\S]*Loop/, 'Composer should show a GSA Loop toggle near the primary controls');
assert.match(js, /let gsaRunState = null/, 'GSA UI should track the active phase pipeline separately from loop state');
assert.match(js, /function parseGsaPhaseJsonText\(text\)[\s\S]*"phase"[\s\S]*localScripts[\s\S]*hypotheses/, 'GSA prose JSON detector should recognize partial legacy-looking output for a bounded pending placeholder');
assert.match(js, /ty === 'gsa_phase'[\s\S]*payloadJson[\s\S]*kind: 'gsa_phase_json'/, 'only the native gsa_phase event should create authoritative phase output');
assert.match(js, /function buildPendingGsaPhaseCard\(seg\)[\s\S]*Waiting for the engine to submit the authoritative structured phase event/, 'pending prose JSON should render only a bounded wait card');
assert.match(js, /pendingStructuredPhase\(txt\)[\s\S]*kind: 'gsa_phase_pending'/, 'prose JSON should remain pending and never advance the pipeline');
assert.match(js, /return name !== 'gsa_submit_phase'/, 'the phase submission control tool should be hidden from the visible action timeline');
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
assert.match(js, /function securityProfileValue\(\)[\s\S]*return v \|\| 'passive'/, 'GSA/RSA UI should preserve explicit security profiles and default only empty values to passive');
assert.match(js, /cap: 'Profile'[\s\S]*red-authorized[\s\S]*black-hat/, 'Agent gear should expose security profiles for GSA/RSA');
assert.match(js, /black-hat'[\s\S]*Technical full-surface profile; Scope does not gate it[\s\S]*Black-hat full-surface mode armed: evil-speak, highly technical explanations, no Scope\/Safety gate[\s\S]*may execute operational validation inside the authorized scope/, 'GSA/RSA UI should distinguish black-hat ungated technical voice from red authorized scope warnings');
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
assert.doesNotMatch(jsonlPatchText, /DS4UI_CYBER_SKILLS_DIR|ds4ui_read_cyber_skill_brief/, 'agent JSONL runtime should load only user-created skills');
assert.match(jsonlPatchText, /DS4UI_USER_SKILLS_DIR[\s\S]*strcmp\(subdir, "skills"\)/, 'agent JSONL runtime should reserve skill loading for the user directory');
assert.match(jsonlPatchText, /ds4ui_workspace_mutation_guard[\s\S]*path must be relative to the selected workspace[\s\S]*write\/edit target is outside the selected workspace/, 'Agent write/edit tools must reject absolute, traversal and symlink-escaped paths');
assert.match(jsonlPatchText, /if \(!strcmp\(call->name, "write"\)\)[\s\S]*ds4ui_workspace_mutation_guard\(call\)[\s\S]*if \(!strcmp\(call->name, "edit"\)\)[\s\S]*ds4ui_workspace_mutation_guard\(call\)/, 'Agent dispatch must enforce the workspace guard before both write and edit');
assert.doesNotMatch(remoteDesign, /DS4UI_CYBER_SKILLS_DIR/, 'design runtime should not load vendored cybersecurity skills');
assert.match(remoteDesign, /DS4UI_USER_SKILLS_DIR[\s\S]*strcmp\(subdir, "skills"\)/, 'design runtime should reserve skill loading for the user directory');
assert.match(js, /label: 'System check'[\s\S]*run: \(\) => Doctor\.open\(\)/, 'System check should remain available from the gear menu');
assert.match(html, /class="loading-led"/, 'engine loading overlay should show an active runtime indicator');
assert.match(html, /id="loading-progress"[\s\S]*data-loading-segment[\s\S]*class="loading-gauges"[\s\S]*id="loading-log"[\s\S]*id="loading-raw"/, 'engine loading overlay should expose segmented progress, runtime gauges, structured logs and raw details');
assert.match(js, /appendOverlayLog\(title, 'launch'\)/, 'engine loading overlay should log launch start with a structured phase');
assert.match(js, /updateOverlay\(st\.loadPct, st\.stage, st\.engineLine \|\| st\.engineError \|\| ''\)/, 'engine loading overlay should consume launcher log lines');
assert.match(js, /let launchTarget = null;/, 'mode switcher should track the launch target separately from the active mode');
assert.match(js, /launching: \(\) => launchTarget/, 'mode switcher should expose the current launch target');
assert.match(js, /launching === 'agent' \|\| launching === 'design'[\s\S]*render\(\);[\s\S]*return;[\s\S]*Api\.checkHealth\(\)/, 'statusbar should not run chat health while agent or design is launching');
assert.match(js, /Starting design agent\.\.\.[\s\S]*Starting coding agent\.\.\./, 'statusbar should show explicit startup state for design and agent');
assert.match(js, /if \(switching \|\| launchTarget\) return;[\s\S]*setMode\(isLanHostMode\(\) \? 'server'/, 'engine sync should not force the UI back to chat during a mode switch');
assert.match(js, /launchTarget = target;[\s\S]*Statusbar\.render\(\);[\s\S]*showOverlay\(target, cfg, title\)/, 'runSwitch should publish launch state before showing the startup overlay');
assert.match(js, /Launch task #\$\{launchTaskId\}/, 'startup overlay should expose the backend launch task id');
assert.match(js, /const timeoutMs = target === 'server' \? 180000 : 15 \* 60 \* 1000;/, 'agent/design startup should allow longer model and system-prompt loading than chat server startup');
assert.match(launcher, /\\"engineLine\\":\\"%s\\"/, 'status endpoint should expose the latest engine log line');
assert.match(launcher, /context buffers[\s\S]*Prefilling the context/, 'Agent/Design should expose context allocation as prefill, not as a false ready state');
assert.match(launcher, /\"prefillDone\"[\s\S]*ds4-agent: system prefill %d\/%d tokens/,
  'Agent and Cowork should map their existing JSONL prefill status into a readable launcher line');
assert.match(launcher, /ds4-design: system prefill %d\/%d tokens[\s\S]*Prefilling %d \/ %d tokens/,
  'Design should expose real cold-prefill counters to the shared loading UI');
assert.match(launcherMain, /full pack is intentionally[\s\S]*loaded on demand[\s\S]*design_system\(\\\"%s\\\"\)[\s\S]*return buf;/,
  'Design startup should bind the selected pack id without injecting its complete body or catalog');
assert.match(remoteDesign, /sysprompt\.kv[\s\S]*restored system prompt cache[\s\S]*stored system prompt cache/,
  'Design should cache an exact-text system-prompt KV after the first cold prefill');
assert.match(js, /lastOverlayStage[\s\S]*lastOverlayLine[\s\S]*nextStage !== lastOverlayStage[\s\S]*nextLine !== lastOverlayLine/,
  'the shared loading overlay should deduplicate stage and engine lines independently across polls');
assert.match(js, /prefillIsIndeterminate[\s\S]*'prefilling…'/,
  'the loading overlay should not fabricate a linear ETA while prefill has no token counter');
assert.doesNotMatch(launcher.match(/else if \(strstr\(line, "context buffers"\)[\s\S]*?\n    \}/)?.[0] || '', /g_ready\s*=\s*1|maybe_complete_launch_task/, 'Piped runtimes must not become ready before their initial WAITING marker');
assert.match(launcher, /is_err && strstr\(acc, "\+DWARFSTAR_WAITING"\)[\s\S]*g_ready = 1;[\s\S]*g_agent_working = 0;/, 'The initial WAITING marker should be the authoritative ready/idle boundary');
assert.match(launcher, /#define TASK_RING_CAP 128/, 'launcher should keep a bounded task lifecycle ring buffer');
assert.match(launcher, /#define LOG_RING_CAP 768/, 'launcher should keep a bounded log ring buffer');
assert.match(launcher, /static void api_diagnostics\(int fd\)/, 'launcher should expose workspace diagnostics');
assert.match(launcher, /sysctl_iogpu_wired_limit_mb[\s\S]*len == sizeof\(int\)[\s\S]*memcpy\(&vi, &v, sizeof vi\)/, 'launcher should decode iogpu.wired_limit_mb when macOS returns a 32-bit sysctl value');
assert.match(launcher, /#define IOGPU_WIRED_MIN_MB 86016LL[\s\S]*#define IOGPU_WIRED_TARGET_MB IOGPU_WIRED_MIN_MB/, 'launcher should retain the minimum macOS IOGPU wired limit and default target');
assert.doesNotMatch(launcher, /IOGPU_WIRED_MAX_MB|iogpuWiredMaxMb/, 'launcher diagnostics should not impose or advertise an app-level IOGPU maximum');
assert.match(launcher, /json_get_int\(body, "mb", IOGPU_WIRED_MIN_MB, LONG_MAX, &target\)/, 'IOGPU endpoint should accept any integer at or above the minimum');
assert.match(launcher, /static void api_iogpu_wired_limit\(int fd, const char \*body\)[\s\S]*LaunchDaemons\/com\.dstudio\.iogpu-wired-limit\.plist[\s\S]*launchctl bootstrap system[\s\S]*persistent\\":true/, 'launcher should apply iogpu.wired_limit_mb and install a persistent LaunchDaemon');
assert.match(launcher, /static void api_updates_check\(int fd\)/, 'launcher should expose Update Doctor status');
assert.match(launcher, /static void api_updates_run\(int fd, const char \*body\)/, 'launcher should expose selected Update Doctor updates');
assert.match(gsaRuntime, /gsa_tool_catalog_status[\s\S]*gsa_tool_found/, 'Update Doctor should verify the full GSA tool catalog with runtime alias resolution');
assert.match(launcher, /GSA catalog %d\/%d tools ready[\s\S]*NUCLEI_TEMPLATES_DIR/, 'Update Doctor should report full GSA catalog and nuclei template readiness');
assert.match(launcher, /updates_ds4_managed_dirty_path[\s\S]*ds4-agent-jsonl[\s\S]*ds4-design[\s\S]*ds4_agent\.c\.ds4ui\.bak/, 'Update Doctor should recognize DStudio-generated ds4 artifacts as managed dirt');
assert.match(launcher, /updates_ds4_git_upstream[\s\S]*@\{u\}[\s\S]*origin\/main/, 'Update Doctor should resolve the real ds4 upstream before declaring latest status');
assert.match(launcher, /update_count_user_skills[\s\S]*DStudio does not download or update a skill catalog/, 'Update Doctor should report user-created skills without offering catalog updates');
assert.doesNotMatch(launcher, /updates_skill_source_remote_head|updates_run_imported_skills|sync-skill-sources\.mjs/, 'Update Doctor should not fetch or update skill catalogs');
assert.match(launcher, /updates_verify_design_systems[\s\S]*Open Design design systems are missing/, 'Update Doctor should continue to verify downloadable design systems');
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
assert.match(js, /agentSendWhenSettled[\s\S]*queuedMaintenance[\s\S]*600_000[\s\S]*Engine\.agentSend/,
  'Agent, Cowork and Design should queue prompts behind session maintenance and allow long Design context prefill');
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
assert.match(js, /Select to edit/, 'Design fullscreen should expose visual element selection');
assert.match(js, /\[DESIGN_SELECTION_JSON\]/, 'Design visual edits should send structured target evidence to the runtime');
assert.match(js, /el\('iframe', \{ class: 'fs-frame', sandbox: 'allow-scripts', title: f\.name \}\)/, 'Design fullscreen previews should keep generated artifacts in an opaque script sandbox');
assert.match(designAnnotator, /dstudio:annotator:selected/, 'the isolated preview bridge should report selected DOM evidence');
assert.match(designAnnotator, /getBoundingClientRect/, 'the preview bridge should report exact target geometry');
assert.match(launcher, /api_design_annotator_script/, 'the launcher should serve the embedded visual-selection bridge');
assert.match(launcher, /data-dstudio-preview-bridge/, 'annotated HTML previews should receive the isolated bridge script');
assert.match(remoteDesign, /DESIGN_SELECTION_JSON[\s\S]*inspect_layout\(entry, selector\)[\s\S]*see_page/, 'Design should measure and visually inspect selected targets before editing');
assert.match(windowsBuild, /design-annotator\.js[\s\S]*DESIGN_ANNOTATOR_B64/, 'Windows builds should embed the visual-selection bridge');
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
assert.doesNotMatch(windowsBuild, /\$Engine\s*=\s*@\([^\n]*ds4-agent\.exe/, 'Windows package should not ship the retired raw Agent binary');
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
assert.match(remoteHelper, /remote_utf8_scalar_len/, 'remote model requests should validate every Unicode scalar before JSON serialization');
assert.match(remoteHelper, /remote_utf8_append\(b, 0xfffd\)/, 'invalid tool-output bytes should be replaced instead of corrupting a remote request');
assert.match(remoteAgent, /\.in_think = false,[\s\S]*\.in_think = false,/, 'remote Agent stream state should not treat LAN content chunks as already inside a think block');
assert.match(remoteAgent, /if \(ctx->stream && ctx->stream->in_think\)[\s\S]*<\/think>\\n\\n[\s\S]*ctx->stream->dsml_in_think = false/, 'remote Agent should close stale thinking before streaming non-reasoning content or DSML tool calls');
assert.doesNotMatch(remoteAgent, /ctx->generated\+\+|w->status\.gen_tps\s*=\s*dt/, 'remote Agent must not report arbitrary SSE chunks as generated tokens or tok/s');
assert.match(remoteAgent, /An SSE delta is an arbitrary transport chunk, not a model token/, 'remote Agent should document why remote throughput remains unknown without provider token counts');
assert.match(remoteAgent, /DS4UI_REMOTE_AUTO_CONTINUES 3/, 'remote Agent should automatically continue interrupted model streams');
assert.match(remoteAgent, /ds4ui_remote_continue_prompt[\s\S]*Re-emit the full intended DSML tool call/, 'remote Agent should repair cut-off DSML tool calls instead of continuing broken fragments');
assert.match(jsonlPatchText, /spaced_ascii[\s\S]*< \| DSML \| tool_calls>/, 'JSONL patch should recover spaced ASCII DSML openings emitted by cloud models');
assert.match(jsonlPatchText, /Do not insert spaces inside the DSML marker[\s\S]*never emit a bare DSML/, 'invalid DSML retries should restate the canonical structural constraints');
assert.match(remoteAgent, /Remote model failed after automatic recovery[\s\S]*agent_set_status\(w, AGENT_WORKER_IDLE\)[\s\S]*return 0;/, 'remote Agent should stay alive and idle after unrecoverable model stream failures');
assert.match(remoteDesign, /DESIGN_REMOTE_AUTO_CONTINUES 3/, 'remote Design should automatically continue interrupted model streams');
assert.match(remoteDesign, /design_remote_continue_prompt[\s\S]*Re-emit the full intended DSML tool call/, 'remote Design should repair cut-off DSML tool calls instead of continuing broken fragments');
assert.match(remoteDesign, /Remote model failed after automatic recovery[\s\S]*design_project_finish_run\(&a->project, "error"\)[\s\S]*return 0;/, 'remote Design should stay alive after unrecoverable model stream failures');
assert.doesNotMatch(launcher, /static const char \*JSONL_EDITS\[\]\[2\]/, 'JSONL patch bodies must live under patch/, not in dstudio.c');
assert.doesNotMatch(launcher, /static const char \*WEB_CDP_EDITS\[\]\[2\]/, 'web CDP patch bodies must live under patch/, not in dstudio.c');
assert.doesNotMatch(launcher, /static const char \*WEB_DIRECT_NAV_EDITS\[\]\[2\]/, 'direct navigation patch bodies must live under patch/, not in dstudio.c');
assert.doesNotMatch(launcher, /static const char \*JSONL_MAKEFILE/, 'JSONL build fragment must live under patch/, not in dstudio.c');
assert.match(launcher, /patch_load_set\(JSONL_PATCH_DIR/, 'launcher should load the JSONL patch manifest from patch/');
assert.match(
  launcher,
  /static void api_wipe\(int fd\)[\s\S]*if \(g_child <= 0\)[\s\S]*agent_buf_reset\(\)[\s\S]*clear_dir\(kvroot\)/,
  'clear-all must discard a crashed Agent buffer before creating a fresh conversation',
);
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
assert.match(
  js,
  /function changeWorkdir\(\)[\s\S]*?openWorkdirDialog\(target, true\)/,
  'changing workspace must create a fresh session so prior workspace paths are not replayed',
);
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
assert.match(js, /function startServer\(requestedUiMode, launchSettings = null\) \{[\s\S]*if \(isLanClientMode\(\)\)[\s\S]*setMode\(chatUiTarget\)[\s\S]*return;[\s\S]*runSwitch\('server'/, 'LAN clients must not start a local server when switching back to Chat');
assert.match(js, /if \(!isLanClientMode\(\) && selectedGguf &&[\s\S]*!ggufIsRunning\(selectedGguf, runningModel, activeEngineDir\)\)/, 'LAN onboarding must not start a local selected model');
assert.match(launcher, /collect_engine_checkouts\([\s\S]*api_ggufs/, 'GGUF API should aggregate every managed DS4 checkout');
assert.match(launcher, /GGUF_SCAN_TIMEOUT_MS[\s\S]*typedef struct gguf_responder[\s\S]*deadline_ms[\s\S]*pid_t responder = fork\(\)/, 'GGUF discovery should run in a tracked responder outside the single HTTP loop');
assert.match(launcher, /gguf_responders_reap\([\s\S]*dstudio_now_ms\(\) >= r->deadline_ms[\s\S]*kill\(r->pid, SIGKILL\)/, 'GGUF responders should have a parent-enforced filesystem deadline');
assert.match(launcher, /gguf_catalog_build_known\([\s\S]*partial[\s\S]*g_gguf_directory_scan_blocked/, 'A blocked File Provider scan should fall back to exact installed DStudio model paths');
assert.match(launcher, /opendir_bounded\([\s\S]*O_NONBLOCK \| O_DIRECTORY[\s\S]*fdopendir/, 'GGUF enumeration should request a non-blocking directory descriptor');
assert.match(launcher, /\\"engineDir\\":[\s\S]*\\"engineName\\":[\s\S]*\\"branch\\":[\s\S]*\\"activeEngine\\":/, 'Every GGUF row should identify its checkout, branch and active state');
assert.match(js, /modelEngineDir/, 'Saved model selection should persist its owning checkout');
assert.match(js, /async function selectSavedModelCheckout\(\)[\s\S]*Engine\.ggufs\(\)[\s\S]*matches\.length === 1[\s\S]*modelEngineDir: dir/, 'Every model launch should restore the saved checkout and migrate legacy model picks');
assert.match(loadingHtml, /modelEngineDir[\s\S]*\/api\/ggufs[\s\S]*matches\.length === 1[\s\S]*\/api\/engine\/checkout[\s\S]*\/api\/start/, 'Native loading page should restore the model-specific checkout before launch');
assert.match(js, /async function switchToGguf\(path, label, engineDir = '', engineLabel = ''\)/, 'Model switching should carry checkout metadata');
assert.doesNotMatch(js, /build:\s*'off'/, 'Agent/Design should keep Plan mode as a per-turn UI contract instead of a launch mode');
assert.doesNotMatch(js, /useJsonlPatch|set-jsonl/, 'Agent should expose one structured protocol instead of a legacy raw mode');
assert.match(js, /startAgent[\s\S]*const remote = remoteModelLaunch\(\)[\s\S]*\.\.\.remote/, 'Agent start payload should include the remote model fields');
assert.match(js, /startDesign[\s\S]*const remote = remoteModelLaunch\(\)[\s\S]*\.\.\.remote/, 'Design start payload should include the remote model fields');
assert.match(js, /startAgent[\s\S]*launchBase\(remote\.modelBackend === 'remote'\)/, 'Agent cloud/LAN launches should omit SSD streaming');
assert.match(js, /startDesign[\s\S]*launchBase\(remote\.modelBackend === 'remote'\)/, 'Design cloud/LAN launches should omit SSD streaming');
assert.match(js, /if \(isLanClientMode\(\)\)[\s\S]*return;[\s\S]*loadSetModels\(\)/, 'LAN clients should not scan local GGUFs from settings refresh');
assert.match(js, /async function loadSetModels\(\) \{[\s\S]*if \(isLanClientMode\(\)\)[\s\S]*return;[\s\S]*Engine\.ggufs\(\)/, 'LAN client settings must not scan local GGUFs even if called directly');
assert.match(js, /async function loadModelList\(\) \{[\s\S]*if \(isLanClientMode\(\)\)[\s\S]*return;[\s\S]*Engine\.ggufs\(\)/, 'LAN clients should not scan local GGUFs from the composer model picker');
assert.match(js, /function show\(\) \{[\s\S]*if \(isLanClientMode\(\)\) return;[\s\S]*loadGgufs\(\)/, 'LAN clients should not open onboarding into local ds4 discovery');
assert.match(js, /async function loadModelList\(\) \{[\s\S]*if \(isLanClientMode\(\)\)[\s\S]*cbarModel\.hidden = true/, 'LAN Design should hide shared model switching instead of exposing a local brief selector');
assert.match(js, /async function downloadModel\(spec\) \{[\s\S]*if \(isLanClientMode\(\)\)[\s\S]*return;[\s\S]*\/api\/model\/download/, 'LAN clients must not start local model downloads');
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
assert.match(js, /function scheduleAgentSelectionRenderFlush\(\)[\s\S]*requestAnimationFrame\([\s\S]*shouldDeferAgentRenderForSelection\(\)/, 'Agent must wait a paint before flushing a render after pointerup so WebKit can commit the selection');
assert.match(js, /function shouldDeferAgentRenderForSelection\(\)[\s\S]*return !!view && \(agentSelectPointerDown \|\| selectionInside\(view\)\)/, 'Agent must preserve selections across idle as well as streaming repaints');
assert.doesNotMatch(js, /function shouldDeferAgentRenderForSelection\(\)[\s\S]{0,240}\(working \|\| agentSelectionPendingRender\)/, 'Agent selection protection must not end merely because generation became idle');
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
assert.match(js, /async function setupLanClientDs4\(dir\)[\s\S]*Engine\.setupDs4\(dir\)/, 'LAN client DS4 runtime setup should use the managed setup endpoint');
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
assert.match(launcher, /if \(!run_build_jsonl\("build"\)\)[\s\S]*agent requires the structured ds4-agent-jsonl build/, 'Agent startup must require the current structured runtime');
assert.doesNotMatch(launcher, /g_use_jsonl|stock\/raw|falling back to stock ds4-agent/, 'launcher must not retain the retired raw Agent path');
assert.doesNotMatch(launcher, /setup_windows_engine_ready\(void\)[\s\S]{0,500}file_present\("ds4-agent\.exe"\)/, 'Windows setup readiness should require only the structured Agent runtime');
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
assert.match(html, /set-nav__eyebrow">Engine<[\s\S]*data-pane="connection"[\s\S]*data-pane="models"[\s\S]*data-pane="performance"[\s\S]*data-pane="advanced"/, 'Settings should split engine controls into focused Connection, Models, Performance and Advanced panes');
assert.match(html, /set-nav__eyebrow">Capabilities<[\s\S]*set-nav__eyebrow">App</, 'Settings should group the remaining panes into Capabilities and App');
assert.match(html, /id="set-search"[\s\S]*id="set-model-filter"/, 'Settings should provide both global settings search and model filtering');
assert.match(js, /function filterSettingsNavigation\(\)[\s\S]*pane\?\.textContent[\s\S]*setPane\(firstMatch\.dataset\.pane\)/, 'Settings search should find matching controls across panes and open the first result');
assert.match(js, /class: 'set-model-quant'[\s\S]*class: 'set-model-size'[\s\S]*class: 'set-model-family'/, 'The model picker should group families and expose comparable quantization and size metadata');
assert.match(html, /@keyframes ec-orbit/, 'Empty-state DStudio logo should rotate while floating');
assert.match(html, /:root\[data-theme="light"\] \.btn--primary \{ color: #fff; \}/, 'Light mode primary button text should stay white');
assert.match(html, /\*::-webkit-scrollbar-thumb/, 'App scrollbars should use the shared custom scrollbar style');
assert.match(js, /const CHAT_ATTACH_MAX_FILES = 6/, 'Chat file attachments need a per-message file cap');
assert.match(js, /function attachmentContextForModel\(m, nativeImages = new Map\(\)\)/, 'Chat attachments should be converted into model context while native model pixels stay in multimodal blocks');
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
assert.match(js, /async function sendMessage\(text, \{ regenerate = false, attachments = \[\], roadmapSources = \[\] \} = \{\}\)/, 'Chat send should accept attachments');
assert.match(js, /msg\.attachments = cleanAttachments/, 'User messages should persist attached file metadata/content');
assert.match(js, /article\.append\(el\('div', \{ class: 'msg__content'[\s\S]*buildAttachments\(m\.attachments, 'user'\)/, 'Sent user attachments should render below the text bubble');
assert.match(html, /\.msg--user-wrap[\s\S]*background: transparent/, 'User messages with attachments should use a transparent wrapper around separate file and text cards');
assert.match(html, /\.msg-attachments--user[\s\S]*justify-content: flex-end;[\s\S]*align-self: flex-end;/,
  'Sent images should align with the user message instead of jumping to the left edge');
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
assert.match(js, /function prepareAttachmentMenuRow\(title, subtitle\)[\s\S]*cbarAttach\.replaceChildren[\s\S]*fileInput[\s\S]*cbarPop\.append\(composerMenuSection\('Add to this message'/, 'Composer plus menu should own the real attachment input inside its labelled action section');
assert.match(html, /body\.composer-raised \.chat \{ grid-template-rows: auto auto auto minmax\(0, 1fr\); \}/, 'empty conversations should raise the composer under the hero instead of pinning it at the bottom');
assert.match(html, /\.cbar-pop\s*\{[\s\S]*position:\s*fixed[\s\S]*overflow-y:\s*auto/, 'composer plus menu should be fixed-positioned and scrollable instead of covering or clipping controls');
assert.match(html, /\.cdrop-menu\s*\{[\s\S]*position:\s*fixed[\s\S]*--cdrop-top[\s\S]*--cdrop-left[\s\S]*--cdrop-width/, 'plus-menu dropdowns should be fixed-positioned so the scrollable plus menu cannot clip them');
assert.match(js, /if \(!document\.body\.contains\(menu\)\) document\.body\.appendChild\(menu\)/, 'plus-menu dropdowns should be mounted on body before placement');
assert.match(js, /window\.innerHeight - margin - height[\s\S]*menu\.style\.top/, 'plus-menu dropdown placement should clamp top inside the viewport');
assert.match(html, /id="set-power"[\s\S]*id="set-ssd-streaming"/, 'Settings should expose engine power and SSD streaming launch parameters');
assert.match(js, /enginePower:\s*90[\s\S]*ssdStreaming:\s*'off'[\s\S]*metalHotlistSeed:\s*false/, 'engine power, DS4-only SSD streaming and hotlist seed should have persisted defaults');
assert.match(js, /const launchBase = \(remote = false\)[\s\S]*\.\.\.\(remote \? \{\} : \{ ssdStreaming: ssdStreaming\(\), metalHotlistSeed: metalHotlistSeed\(\), dspark: dspark\(\) \}\)/, 'engine starts should keep SSD streaming, hotlist seed and DSpark local-only');
assert.match(js, /function applyEngineConfig\(\)[\s\S]*Restart to apply engine settings\?[\s\S]*restartCurrent\(\)/, 'engine launch setting changes should offer to restart the active engine');
assert.match(js, /setIogpuWiredLimit\(mb\)[\s\S]*\/api\/iogpu-wired-limit/, 'frontend should expose the IOGPU wired-limit apply endpoint');
assert.match(html, /id="set-iogpu-limit-mb"[\s\S]*min="86016"[\s\S]*id="set-iogpu-limit"[\s\S]*Apply wired limit[\s\S]*controls how many megabytes of unified memory[\s\S]*LaunchDaemon/, 'Settings should explain and expose the persistent macOS IOGPU limit action');
assert.doesNotMatch(html.match(/<input type="number" id="set-iogpu-limit-mb"[^>]*>/)?.[0] || '', /\smax=/, 'IOGPU input should not impose an upper limit');
assert.match(js, /const minMb = Number\(m\.iogpuWiredMinMb \|\| 86016\)[\s\S]*removeAttribute\('max'\)[\s\S]*const next = current >= minMb \? current : targetMb/, 'memory doctor should preserve any current IOGPU value at or above the minimum');
assert.match(js, /const mb = Number\(f\.iogpuLimitMb\?\.value \|\| '86016'\)[\s\S]*!Number\.isSafeInteger\(mb\) \|\| mb < minMb/, 'IOGPU apply validation should enforce only an integer minimum');
assert.doesNotMatch(js, /iogpuLimitRisk|iogpuAggressive|Above recommended media-headroom value|lower iogpu\.wired_limit_mb/, 'memory doctor should not warn against values solely because they exceed the former ceiling');
assert.match(js, /function generatedFilesForMessage\(m\)[\s\S]*extractGeneratedFilesFromAssistant\(m\?\.content \|\| ''\)\.files[\s\S]*function displayContentForMessage\(m\)[\s\S]*stripGeneratedFilePayloadPreview\(m\.content\)/, 'message rendering should convert dstudio-files fences into generated file tiles instead of showing the protocol block');
assert.match(html, /body\.composer-raised \.cbar-model-menu \{ top: calc\(100% \+ 6px\); bottom: auto; \}/, 'raised composer model menu should open downward with the other menus');
assert.match(js, /composerTarget:\s*'chat'/, 'the composer should default to the normal Chat target');
assert.match(js, /function appendH3PickerOption\(menu\)[\s\S]*MiniMax H3[\s\S]*Local video \+ audio[\s\S]*selectH3FromPicker/, 'the composer model picker should expose the managed MiniMax H3 video target');
assert.match(js, /stage === 'decoding'[\s\S]{0,180}video frames and final MP4 are being decoded and encoded locally/, 'H3 decoding progress must describe evidence available before the output audio streams are known');
assert.doesNotMatch(js, /stage === 'decoding'[^\n]*synchronized stereo audio/, 'H3 decoding progress must not promise an audio stream before output validation');
assert.match(js, /const H3_PROMPT_TEMPLATE = \[[\s\S]*'Scene: '[\s\S]*'Action: '[\s\S]*'Camera: '[\s\S]*'Look: '[\s\S]*'Audio: '/, 'H3 mode should offer the Context-IR-style prompt fields documented by h3.c');
assert.match(js, /function directH3VideoDirective\(chat, userMsg, settings\)[\s\S]*action: 'video'[\s\S]*useFirstFrame: candidates\.length === 1[\s\S]*useReferenceImages: candidates\.length === 2[\s\S]*sourceIds:/, 'an explicitly selected H3 target should route prompt text plus one opening frame or two reference images directly to video');
assert.match(js, /if \(directH3\) \{[\s\S]*directH3VideoDirective\(chat, userMsg, settings\)[\s\S]*runRoutedVideoReply/, 'direct H3 mode should bypass a formatting-only Chat turn');
assert.match(js, /if \(h3ComposerMode\(\)\) \{[\s\S]*images\.length > 2[\s\S]*referencesInstalled[\s\S]*Opening-frame image supplied directly to MiniMax H3[\s\S]*takePendingAttachments\(\)/, 'H3 composer mode should accept one opening frame or two installed-reference images without running vision analysis');
assert.match(html, /body\.composer-raised \.cbar-think-menu \{ top: calc\(100% \+ 6px\); bottom: auto; \}/, 'raised composer thinking menu should open downward with the other menus');
assert.match(html, /\/\* Composer "\+" menu: labelled actions and semantic controls\. \*\/[\s\S]*\.cbar-pop\s*\{[\s\S]*width:\s*min\(88vw,\s*352px\)[\s\S]*min-width:\s*min\(88vw,\s*326px\)/, 'plus menu should use the reference-width labelled action layout while staying viewport-safe');
assert.match(html, /\.cdrop-cap\s*\{ width:\s*30px; font-size:\s*9\.5px;/, 'plus menu dropdown labels should be compact');
assert.match(html, /id="skills-picker-view"[\s\S]*id="skills-category-list"[\s\S]*id="skills-picker-list"/, 'Skill picker should use a modal with category sidebar and skill grid');
assert.match(html, /id="skills-picker-manage"[\s\S]*>Add<\/button>/, 'Skill picker should label the authoring action Add, not Manage');
assert.doesNotMatch(html, /id="skills-picker-manage"[\s\S]*>Manage<\/button>/, 'Skill picker should not expose the old Manage label');
assert.match(js, /function openSkillPickerForCurrentMode\(\)[\s\S]*Skills\.openPicker/, 'Skill selection should open the modal picker from the plus menu');
assert.match(js, /function renderSkillPicker\(\)[\s\S]*skills-cat[\s\S]*skill-card/, 'Skill picker modal should render categories and skill cards');
assert.match(js, /pushGroup\('user', 'Your skills', userSkillCache \|\| \[\]\)/, 'Skill picker should expose only the current user catalog');
assert.doesNotMatch(js, /shippedSkillCache|marketingSkillCache|cyberSkillCache/, 'Skill picker should not keep downloadable catalog groups');
assert.doesNotMatch(js, /pushGroup\('web-plan'/, 'Agent skill picker should not expose the removed planning-build category');
assert.match(js, /on\(pickerManage, 'click', \(\) => showEditor\(null, null, 'picker'\)\)/, 'Skill picker Add should open the editor directly');
assert.match(js, /skill-card__edit[\s\S]*showEditor\(it\.value, it\.raw, 'picker'\)/, 'Skill cards should expose an inline edit action');
assert.match(js, /const s = await Engine\.userSkillGet\(id\)/, 'Skill editor should read only the user-created skill body');
assert.doesNotMatch(extractFunction(js, 'showEditor'), /Engine\.skillGet/, 'Skill editor should not fall back to a shipped skill body');
assert.match(js, /Engine\.userSkillSave\(\{ id,[\s\S]*modes: editingModes/, 'Skill editor should preserve modes when saving local overrides');
assert.match(js, /function selectedSkillPromptForRuntime\([^)]*\)[\s\S]*DStudio selected skill/, 'Selected skills should apply to future turns without restarting the runtime');
assert.match(js, /const runtimeSkillAtLaunch = \{ agent: '', cowork: '', design: '' \}/, 'Runtime should track the skill that was injected at launch for every agentic mode');
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
assert.match(js, /function composerWorkdirRow[\s\S]*value: wd \|\| 'Choose folder…'[\s\S]*mono: true/, 'working folder row should apply monospace styling only to its path value');
assert.doesNotMatch(html + js, /Runs entirely on your Mac|Write a message…|Ask the agent|Describe the design|A first-run onboarding screen|Refine the selected screen/, 'Chat, Agent and Design composer placeholders/privacy filler should not be visible');
assert.match(html, /\.btn--send[\s\S]*width: 34px;[\s\S]*height: 34px;[\s\S]*\.cbar-btn[\s\S]*width: 34px; height: 34px;[\s\S]*\.cbar-sel[\s\S]*height: 34px;[\s\S]*\.cbar-think-btn[\s\S]*height: 34px;[\s\S]*\.cbar-model-btn[\s\S]*height: 34px;/, 'model, thinking, plus and send controls should share the same height');
assert.match(js, /function renderThinkingPill\(\)[\s\S]*closeGear\(\);[\s\S]*closeModelMenu\(\);[\s\S]*thinkMenuOpen = next/, 'Opening Thinking should close the plus and model menus first');
assert.match(js, /function renderModelPill\(\)[\s\S]*closeGear\(\);[\s\S]*closeThinkMenu\(\);[\s\S]*modelMenuOpen = next/, 'Opening Model should close the plus and thinking menus first');
assert.match(js, /function openGear\(\)[\s\S]*closeThinkMenu\(\);[\s\S]*closeModelMenu\(\);[\s\S]*layoutControls\(\)/, 'Opening the plus menu should close model and thinking menus first');
assert.match(js, /if \(activeCdropCollapse && activeCdropCollapse !== collapse\) activeCdropCollapse\(\)/, 'Only one plus-menu custom dropdown should stay open at a time');
assert.match(js, /body\.classList\.toggle\('design-brief-staged'[\s\S]*stagedBrief[\s\S]*body\.classList\.toggle\('design-staged'[\s\S]*\(stagedQ \|\| stagedGen\)/, 'Design should keep explicit brief and question/generation stage state');
assert.doesNotMatch(html, /body\.design-staged \.composer\s*\{\s*display:\s*none/, 'Design questions and generation must not hide the shared chat composer');
assert.match(js, /setComposerRaised\(viewMode !== 'design'\)/, 'Design should keep the shared composer docked so its gallery cannot push the chat below the viewport');
assert.match(js, /mode === 'design'[\s\S]{0,120}Describe the screen, flow, audience and visual direction/, 'Design should expose a clear prompt in the shared chat composer');
assert.match(js, /doneTodoKeys: new Set\(\)/, 'Design generating progress should track synthetic todo completion from tool events');
assert.match(js, /function applyEvent\(ev\)[\s\S]*markTodosBeforeOperation\(state\.activeTool\)/, 'Design milestone tool calls should advance earlier build todos instead of leaving progress stuck');
assert.match(js, /type === 'file_written'[\s\S]*markActiveOrNextTodoDone\(\)/, 'Design file writes should advance the active build todo when the model forgets todo_write');
assert.match(js, /const markActiveOrNextTodoDone = \(\) => \{[\s\S]*!requiredOps\(String\(todo\?\.text \?\? ''\)\)\.length[\s\S]*if \(idx >= 0\) markTodoDone/, 'Design file writes should not complete verify/critique/artifact milestone todos');
assert.match(js, /type === 'run_started'[\s\S]*state\.todos = null[\s\S]*discoveryBlockedNotified = false/, 'Design runtime should clear stale todos and discovery warnings when a new run starts');
assert.match(js, /type === 'discovery_blocked'[\s\S]*Questions required before building[\s\S]*Design needs the Questions step before building/, 'Design UI should surface a skipped-discovery runtime block to the user');
assert.match(js, /function designPhase\(\)[\s\S]*DesignRuntime\.getState[\s\S]*return 'generating'/, 'Design stepper should use event-sourced runtime state, not only visible transcript text');
assert.match(js, /let streamCarry = '';[\s\S]*const input = streamCarry \+ String\(delta \|\| ''\);[\s\S]*streamCarry = input\.slice\(rs\)/, 'Design runtime should preserve JSONL events split across SSE or poll responses');
assert.match(js, /function designPhase\(\)[\s\S]*const emptyTranscript = viewMode === 'design' \? !hasDesignConversationContent\(text\) : !hasRenderableConversation\(text\)[\s\S]*if \(emptyTranscript && !working && !rt\?\.question && rt\?\.phase !== 'building'\) return 'brief'[\s\S]*ps0\.finalized/, 'Empty Design conversations should stay on Brief instead of inheriting stale runtime preview state');
assert.match(js, /function hasRenderableConversation\(raw = text\)[\s\S]*session_status[\s\S]*return false/, 'Agent/Design empty states should ignore service-only transcripts');
assert.match(js, /function hasDesignConversationContent\(raw = text\)[\s\S]*seg\.kind === 'proposal'[\s\S]*seg\.kind === 'artifact'[\s\S]*return false/, 'Design empty states should ignore reasoning-only or service-only transcripts');
assert.match(js, /staleNotice = !conv\.lanMirror &&[\s\S]*viewMode === 'design' \? hasDesignConversationContent\(conv\.transcript \|\| ''\) : hasRenderableConversation\(conv\.transcript \|\| ''\)[\s\S]*!conv\.sessionSha/, 'Service-only new Agent/Design conversations should not show the stale session warning');
assert.match(js, /const submitAnswer = \(answerText, lines = \[\]\) => \{[\s\S]*viewMode === 'design'[\s\S]*sendQuestionAnswer\(answerText\)/, 'Design question forms should submit with the runtime-recognized question answer marker');
assert.match(js, /viewMode === 'agent' \|\| viewMode === 'cowork' \|\| viewMode === 'design'/, 'Agent, Cowork and Design reasoning blocks should stay open');
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
assert.match(js, /deferFreeText: working && viewMode === 'design'/, 'Only Design should defer free text while Agent and Cowork stream their answer visibly');
assert.match(js, /streaming: working && \(viewMode === 'agent' \|\| viewMode === 'cowork'\)/, 'Agent and Cowork should use the same visible streaming answer surface');
assert.match(js, /const visibleBackendWorking = backendWorking && res\.sessionWorking !== true;[\s\S]*const drainingAfterMarker = !!delta && wasWorking && !visibleBackendWorking;[\s\S]*working = visibleBackendWorking \|\| drainingAfterMarker;/, 'Agent UI should stay busy while real turn output drains, without exposing session-maintenance commands as generation');
assert.doesNotMatch(js, /seg\.kind === 'reasoning'\) \{\s*if \(deferLiveText\) return;/, 'Live Agent and Design tails should not hide reasoning until the final transcript render');
assert.doesNotMatch(js, /tool_text|deferFallbackToolText|fallback = !hasEvents/, 'structured Agent rendering must not retain the raw transcript parser');
assert.match(js, /seg\.text && seg\.text\.trim\(\)\) \{[\s\S]*if \(deferFreeText\) return;[\s\S]*agent-answer-streaming/, 'Live Agent and Cowork tails should render structured free text with the streaming treatment while Design may defer it');
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
assert.match(readme, /## Skills: local task recipes[\s\S]*assets\/skills\.png[\s\S]*does not ship or download a skill marketplace[\s\S]*created by the current user/, 'README should feature Skills and explain the user-only catalog');
assert.match(readme, /## GSA: guided security analysis[\s\S]*assets\/gsa\.png[\s\S]*authorized[\s\S]*selection[\s\S]*preflight[\s\S]*validation[\s\S]*report/, 'README should feature the GSA screenshot and explain the security-analysis phases');
assert.match(readme, /## Design: a studio built \*\*on\*\* ds4[\s\S]*assets\/design\.gif[\s\S]*Brief and questions[\s\S]*Generating[\s\S]*Proposal[\s\S]*Quality gate, canvas and export/i, 'README should feature the Design pipeline demo GIF and concise gated pipeline explanation');
assert.doesNotMatch(readme, /(?:💬|🔎|🤖|🧩|🛡️|🎨|📝)/u, 'README should not use decorative emoji in headings or feature sections');
assert.doesNotMatch(readme, /assets\/README%20images\/design\/(?:brief|Design|proposal|canvas)\.png/, 'README Design section should not show the old static pipeline screenshots');
assert.doesNotMatch(readme, /assets\/README%20images\/build\.png/, 'README Plan mode section should not show the old Build/Plan screenshot');
assert.match(js, /function composerPlanControl\(\)[\s\S]*role: 'radiogroup'[\s\S]*'Ask first'[\s\S]*'Auto'/, 'Agent composer should expose Plan mode as an accessible segmented control');
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
assert.match(js, /let sessionCommandTail = Promise\.resolve\(\);[\s\S]*function sessionAction\(action, sha = '', opts = \{\}\)[\s\S]*sessionCommandTail\.then\(run, run\)/, 'Session maintenance commands should be serialized instead of being silently lost to busy races');
assert.match(js, /let sessionEventCarry = '';[\s\S]*const input = sessionEventCarry \+ String\(delta \|\| ''\);[\s\S]*sessionEventCarry = input\.slice\(rs\)/, 'Session metadata should survive a split JSONL frame');
assert.match(js, /const target = command\?\.action === 'list' \? command\.targetConvId : liveConvId;[\s\S]*Store\.setChatMeta\(target, \{ sessionSha: cur\.sha \}\)/, 'A delayed session list should bind its SHA to the originating conversation');
assert.match(js, /function displayedWorking\(\)[\s\S]*!suppressBusyUntilIdle && working && !!convId && convId === liveConvId/, 'Agent visible busy state should belong only to the displayed live conversation and stay hidden while Stop settles');
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
assert.match(launcher, /static int\s+g_agent_session_working = 0;/, 'Backend should track session maintenance separately from a visible model turn');
assert.match(launcher, /\\\"sessionWorking\\\":%s/, 'Backend poll/SSE payloads should expose the session-maintenance state');
assert.match(launcher, /if \(g_agent_working\)[\s\S]*session command is still settling[\s\S]*turn is still running/, 'Backend should reject a prompt while another pipe command owns the completion marker');
assert.match(launcher, /agent\/design runtime is not active/, 'Backend should report inactive Agent/Design runtime explicitly');
assert.match(launcher, /Engine process stopped before completing the turn[\s\S]*g_agent_working = 0;/, 'Backend should make child crashes visible and clear Agent/Design working state');
assert.match(js, /appendLocalSendFailure\(displayPrompt, msg, thisSend\)/, 'Agent/Design send failures should be persisted in the transcript');
assert.match(js, /target} did not start[\s\S]*\/api\/status reports mode=/, 'Startup should fail visibly if /api/status disagrees with the requested mode');
assert.match(js, /const launchWasSuperseded = async \(\)[\s\S]*Engine\.task\(launchTaskId\)[\s\S]*status === 'canceled'/, 'startup polling should detect a launch superseded by another window or request');
assert.match(js, /if \(await launchWasSuperseded\(\)\)[\s\S]*setMode\(st\.mode === 'server' \? chatUiTarget : st\.mode\)/, 'a superseded launch should adopt the newer ready mode without a false startup error');

assert.match(js, /copy\.lanMirror\s*=\s*true/, 'LAN mirror rows should be marked read-only');
assert.match(js, /for \(const mode of \['chat', 'agent', 'cowork', 'design', 'roadmap'\]\)/, 'mirror sync must cover chat, agent, cowork, design and roadmap');
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
assert.match(settingsDialog, /id="set-http-port"[\s\S]*id="set-http-port-apply"/, 'Network settings should expose the persisted DStudio web port');
assert.match(js, /async function changeHttpPort\(\)[\s\S]*Engine\.setHttpPort\(port\)[\s\S]*port-migrate=/, 'changing the web port should rebind live and migrate browser settings to the new origin');
assert.match(loadingHtml, /#port-migrate=[\s\S]*localStorage\.setItem\(key, value\)/, 'the loading gate should restore settings after a port-origin change');
assert.match(launcher, /static void api_http_port\(int fd, const char \*body\)[\s\S]*open_listener\(g_bind_host, port\)[\s\S]*persist_http_port\(port\)/, 'the launcher should bind and persist a requested web port without touching the model port');
assert.match(app, /static int saved_http_port\(void\)[\s\S]*http-port[\s\S]*int saved = saved_http_port\(\)/, 'the native app should reuse the saved web port at its next launch');
assert.match(js, /const SCHEMA_VERSION = 2;[\s\S]*settings: 'ds4web\.settings\.v2'/, 'current UI storage must use the breaking v2 schema');
assert.doesNotMatch(js, /function migrate\(|webSearchEnabled|ssdStreamingAutoMigrated|deepseekV4ModelMigrated|lanClientDs4Dir/, 'current UI must not carry previous-schema migration branches');
assert.match(js, /function mergeRemote\(remote\) \{[\s\S]*remote\.v !== SCHEMA_VERSION/, 'server chat sync must reject stores from a different schema');

assert.match(loadingHtml, /lanClientHost/, 'loading gate must skip when this browser is a LAN client');
assert.match(loadingHtml, /settings\.onboarded !== true/, 'loading gate should wait until host onboarding is complete');
assert.match(loadingHtml, /if \(!st\.ds4dirOk && engineDir\)[\s\S]*\/api\/engine\/checkout[\s\S]*st = await fetchJson\('\/api\/status'/, 'loading gate should restore a saved checkout before opening missing-engine setup');
assert.doesNotMatch(loadingHtml, /hello are you alive\?|askAlive/, 'loading gate should not block app opening on a full model generation');
assert.match(loadingHtml, /class="logo"[\s\S]*id="loading-stage"[\s\S]*id="loading-pct"[\s\S]*id="loading-progress"[\s\S]*id="loading-bar"[\s\S]*id="boot-steps"[\s\S]*Everything runs on this Mac/, 'loading page should show the DStudio logo above a labeled progress bar, startup stages and privacy footer');
assert.match(loadingHtml, /showProgress\(st\.loadPct,[\s\S]*st\.stage/, 'loading progress should consume the launcher percentage and stage');
assert.match(loadingHtml, /startWithSavedSettings\(\)[\s\S]*saved\.ctxSize[\s\S]*saved\.enginePower[\s\S]*saved\.ssdStreaming[\s\S]*saved\.metalHotlistSeed[\s\S]*saved\.dspark[\s\S]*\/api\/start/, 'native loading gate should start the engine with the persisted browser launch settings');
assert.match(loadingHtml, /startWithSavedSettings\(\)[\s\S]*\/api\/start[\s\S]*ssdStreaming,[\s\S]*metalHotlistSeed,[\s\S]*dspark,/, 'native loading gate should pass SSD, hotlist seed and DSpark through without rewriting them');
assert.doesNotMatch(loadingHtml, /useJsonlPatch|jsonl:/, 'native loading gate should use the single current Agent protocol');
assert.match(loadingHtml, /idlePolls >= 3[\s\S]*location\.replace\('\/'\)/, 'loading gate should open the workspace instead of waiting forever when no engine launch is active');
assert.doesNotMatch(loadingHtml, /class="mark"|@keyframes spin/, 'loading page should not use the old rotating mark');

assert.match(gitignore, /^\/ds4\/$/m, 'managed upstream ds4 checkout should stay out of the DStudio source tree');
assert.match(gitignore, /^\/ds4-glm5\.3\/$/m, 'legacy/local GLM 5.3 checkout should stay out of the DStudio source tree');
assert.match(gitignore, /^\/ds4-glm5\.3\.zip$/m, 'local GLM 5.3 checkout archive should stay out of source control');
assert.match(launcher, /#define DS4_REPO_URL "https:\/\/github\.com\/antirez\/ds4"/, 'launcher should know the upstream ds4 repo URL');
assert.match(launcher, /#define DS4_UPSTREAM_COMMIT "b0982a1b4ee9d0f157e600bfd102fbeac951a829"/, 'primary managed ds4 setup should pin the latest tested main revision containing GLM and DeepSeek native vision');
assert.match(launcher, /#define DS4_ARCHIVE_URL "https:\/\/codeload\.github\.com\/antirez\/ds4\/tar\.gz\/" DS4_UPSTREAM_COMMIT/, 'managed ds4 setup should download a pinned GitHub source archive');
assert.doesNotMatch(launcher, /DS4_GLM53_UPSTREAM_COMMIT|DS4_GLM53_DIR_NAME|api_setup_glm53/, 'GLM 5.3 must not retain a separate managed checkout or setup endpoint after its merge to main');
assert.equal(fs.existsSync('src/dstudio_glm53.c'), false, 'the obsolete GLM side-checkout domain should be removed');
assert.match(launcher, /#define DS4_LAGUNA_UPSTREAM_COMMIT "448d5695d1c86401a4e9447c440feb983b73e6de"/, 'managed Laguna checkout should pin the fetched laguna-s2.1 branch');
assert.match(launcher, /api_setup_laguna[\s\S]*DS4_LAGUNA_ARCHIVE_URL[\s\S]*setup_build_branch_runtimes\(target, "Laguna S 2\.1"/, 'Laguna setup should download and build all pinned side-by-side runtimes');
assert.match(launcher, /setup_apply_ds4_runtime_patches[\s\S]*apply-ds4-visible-downloads\.sh[\s\S]*apply-ds4-media-memory\.sh[\s\S]*apply-ds4-server-metrics\.sh[\s\S]*apply-ds4-glm53-runtime\.sh/, 'managed ds4 setup should apply visible downloads, media memory, metrics and GLM main patches together');
assert.match(glmRuntimeScript, /marker=DS4UI_GLM53_STREAMING[\s\S]*static bool ds4_model_is_glm53[\s\S]*non-GLM checkout skipped[\s\S]*already applied/, 'the GLM patch hook should skip other checkouts and remain idempotent');
assert.match(glmRuntimePatch, /DS4UI_GLM53_STREAMING[\s\S]*ds4_model_is_glm53\(\) \|\|[\s\S]*ds4_engine_is_glm53[\s\S]*glm-5\.3-flash/, 'the versioned GLM patch should remove its fixed host guard and expose the live GLM catalog');
assert.match(visibleDownloadsScript, /marker='Every transfer is written as a visible <filename>\.part file'[\s\S]*ds4f-vision-q2[\s\S]*glm53-q2[\s\S]*non-main checkout skipped[\s\S]*already applied/, 'the visible-download hook should be idempotent and skip unsupported engine branches');
assert.match(visibleDownloadsPatch, /download_model\.sh[\s\S]*curl -fL --show-error --retry 5 --retry-all-errors --progress-meter -C -[\s\S]*mv "\$part" "\$out"/, 'the versioned download patch should resume into a visible sibling .part and atomically promote it on completion');
assert.match(launcher, /api_engine_checkout_set[\s\S]*apply-ds4-visible-downloads\.sh[\s\S]*persist_ds4_checkout\(abs\)/, 'selecting an engine folder should apply the reversible download patch before persisting it');
assert.match(launcher, /setup_build_branch_runtimes[\s\S]*setup_apply_ds4_runtime_patches\(\)[\s\S]*run_build_jsonl\("build"\)[\s\S]*build-design\.sh/, 'optional engine setup should prepare server, Agent and Design consistently');
assert.match(jsonlBuild, /-I"\$\(DSTUDIO_REMOTE_DIR\)"[\s\S]*"\$\(DSTUDIO_REMOTE_DIR\)\/dstudio_remote_llm\.c"/, 'Agent build should quote the managed support path when it contains spaces');
assert.match(designBuild, /-I"\$\(REMOTE_DIR\)"[\s\S]*"\$\(DESIGN_SRC\)"[\s\S]*"\$\(REMOTE_DIR\)\/dstudio_remote_llm\.c"/, 'Design build should quote external sources under macOS Application Support');
assert.match(launcher, /!strcmp\(path, "\/api\/laguna\/setup"\)[\s\S]*api_setup_laguna\(fd\)/, 'launcher should expose POST /api/laguna/setup');
assert.doesNotMatch(launcher, /\/api\/glm53\/setup/, 'launcher should not expose the retired GLM side-checkout setup endpoint');
assert.match(launcher, /DS4_METAL_LAGUNA_SOURCE[\s\S]*laguna\.metal/, 'Agent and Design should resolve the Laguna Metal source from any workspace');
assert.match(launcher, /model_is_laguna\(\)[\s\S]*requires full model residency[\s\S]*SSD streaming cannot be forced on/, 'Laguna should disable automatic streaming and reject forced SSD streaming');
assert.match(js, /setupLaguna\(\)[\s\S]*\/api\/laguna\/setup/, 'Engine API should install the optional Laguna checkout');
assert.doesNotMatch(js, /setupGlm53|\/api\/glm53\/setup/, 'UI should not retain the retired GLM checkout installer');
assert.match(js, /target: 'laguna-q4', engine: 'laguna'/, 'model catalog should expose Laguna and route it to its managed engine');
assert.match(js, /target: 'glm53-q2', engine: 'main'[\s\S]*GLM-5\\\.3-Flash-Q2/, 'model catalog should route GLM 5.3 through primary main');
assert.match(js, /function confirmGlm53Load\(path\)[\s\S]*GLM 5\.3 uses most of unified memory[\s\S]*will not reduce the context or force SSD streaming/, 'GLM selection should show one non-blocking memory notice without changing launch settings');
assert.match(js, /async function switchToGguf\(path, label, engineDir = '', engineLabel = ''\)[\s\S]*await confirmGlm53Load\(path\)[\s\S]*Store\.setSettings/, 'the central GGUF switch should ask before persisting a GLM selection');
assert.match(launcher, /static char \*gguf_catalog_build\(void\)[\s\S]*!model_file_is_supported\(nm\)/, 'the GGUF catalog should expose only the supported GLM generation');
assert.match(launcher, /has_explicit_gguf && !model_file_is_supported\(gguf\)[\s\S]*unsupported_model[\s\S]*engine support files cannot be loaded directly/, 'the launcher should reject unsupported or auxiliary GGUF selections');
assert.match(js, /async function ensureModelDownloadEngine\(engine\)[\s\S]*Engine\.setupLaguna\(\)[\s\S]*Engine\.setEngineCheckout\(checkout\.dir\)/, 'the remaining Laguna-specific downloads should install and select their engine automatically');
assert.match(js, /function modelDownloadStatusText\(dl\)[\s\S]*dl\?\.stage[\s\S]*runs in the background/, 'model download row should expose a persistent setup/download phase');
assert.match(js, /function modelDownloadStateFromStatus\(st\)[\s\S]*st\?\.pausedDownload[\s\S]*stage: 'Paused:'[\s\S]*paused: true/, 'stopped resumable downloads should become a persistent paused UI state');
assert.match(js, /function appendModelDownloadStatus\(host, dl\)[\s\S]*text: 'Resume'[\s\S]*Switcher\.downloadModel\(choice\.body\)/, 'paused model feedback should include a Resume action');
assert.match(js, /function appendModelDownloadStatus\(host, dl\)[\s\S]*if \(dl\.paused\)[\s\S]*text: 'Delete partial'[\s\S]*Engine\.deleteModelPartials\(dl\.variant\)/, 'every paused visible download should offer confirmed partial cleanup');
assert.match(js, /async function deleteModelPartials\(target\)[\s\S]*JSON\.stringify\(\{ target, confirm: true \}\)/, 'partial cleanup client must send an explicit post-confirmation capability');
assert.match(js, /function appendModelDownloadStatus\(host, dl\)[\s\S]*text: 'Stop'[\s\S]*Engine\.stopModelDownload\(\)[\s\S]*Model download paused/, 'active model feedback should offer a Stop action that transitions to paused');
assert.match(js, /async function pollDownload\(\)[\s\S]*if \(st\.pausedDownload\)[\s\S]*modelDownloadStateFromStatus\(st\)[\s\S]*return;/, 'download polling should preserve the paused row instead of replacing it with the normal catalog');
assert.match(js, /function appendModelDownloadStatus\(host, dl\)[\s\S]*text: 'Open folder'[\s\S]*Engine\.openModelFolder/, 'active and paused model feedback should open the matching engine folder');
assert.match(js, /Models available to download:[\s\S]*text: 'Open folder'[\s\S]*Engine\.openModelFolder\(t\?\.body\.engine/, 'normal model picker should identify downloads clearly and expose Open folder for the selected engine family');
assert.match(js, /function modelDownloadOptionLabel\(choice\)[\s\S]*Not installed/, 'download choices must not look like already-installed or active models');
assert.match(js, /DeepSeek V4 Flash · abliterated \(experimental\)/, 'the abliterated model must not be presented as universally uncensored');
assert.match(js, /function modelDownloadStatusText\(dl\)[\s\S]*fmtGgufSize\(Number\(dl\.bytes\)\)[\s\S]*downloaded/, 'active model feedback should show transferred bytes as well as percentage');
assert.match(js, /async function downloadModel\(spec\)[\s\S]*Preparing Laguna S 2\.1 engine for[\s\S]*await ensureModelDownloadEngine\(engine\)[\s\S]*Starting download of/, 'the remaining optional engine compilation should provide feedback before the weight download starts');
assert.match(readme, /### GLM 5\.3 Flash \(optional\)[\s\S]*merged into upstream[\s\S]*ds4\/main[\s\S]*no separate GLM source checkout[\s\S]*glm53-vision[\s\S]*view_image/, 'README should document merged-main GLM and its native vision path');
assert.match(readme, /### DeepSeek V4 Flash Vision Experimental \(optional\)[\s\S]*separate language checkpoint[\s\S]*ds4f-vision-q2[\s\S]*ds4f-vision-encoder[\s\S]*ds4f-vision-dspark/, 'README should distinguish DeepSeek Vision-Exp from 0731 and document its matching downloads');
assert.match(readme, /### Laguna S 2\.1 \(experimental, optional\)[\s\S]*laguna-s2\.1[\s\S]*full model residency/, 'README should document the managed Laguna branch and residency requirement');
assert.match(launcher, /ds4_catalog_matches_selected_model[\s\S]*owned_by[\s\S]*static int ds4_server_compatible\(int port\)[\s\S]*GET \/v1\/models[\s\S]*return ds4_catalog_matches_selected_model/, 'launcher should identify a compatible DS4 server before reusing an occupied engine port');
assert.match(launcher, /collect_engine_checkouts[\s\S]*managed_names\[\][\s\S]*"ds4", DS4_LAGUNA_DIR_NAME/, 'engine catalog should probe only main and the remaining Laguna side checkout');
const checkoutCollector = launcher.match(/static int collect_engine_checkouts\([\s\S]*?^}/m)?.[0] || '';
assert.doesNotMatch(checkoutCollector, /DIR \*|readdir\s*\(/, 'engine catalog must not enumerate a macOS Documents workspace');
assert.match(launcher, /ds4_catalog_matches_selected_model[\s\S]*model_is_glm\(\)[\s\S]*glm-5\.3-flash[\s\S]*model_is_laguna\(\)[\s\S]*laguna-s-2\.1[\s\S]*deepseek-v4-/, 'server reuse should require the selected model family instead of adopting any DS4 process');
assert.match(launcher, /static pid_t ds4_instance_lock_owner\(void\)[\s\S]*flock\(fd, LOCK_EX \| LOCK_NB\)/, 'launcher should detect a DS4 process that owns the model lock before its port opens');
assert.match(launcher, /requested_mode == ENGINE_SERVER[\s\S]*reuse_external_ds4\(&cfg, 0, owner\)/, 'server startup should wait for and attach to an existing DS4 process instead of spawning into its lock');
assert.match(loadingHtml, /!st\.running && st\.engineError[\s\S]*location\.replace\('\/'\)/, 'loading page should leave a terminal engine error instead of remaining stuck on its stage');
assert.match(launcher, /ds4_server_compatible\(ENGINE_DEFAULTS\.port\)[\s\S]*reuse_external_ds4\(&ENGINE_DEFAULTS, 1, 0\)/, 'startup should adopt a compatible DS4 engine already running locally');
assert.match(app, /native loading page owns engine startup[\s\S]*DS4UI_DEFER_ENGINE_START/, 'native wrapper should defer engine launch until persisted browser settings are available');
assert.match(launcher, /getenv\("DS4UI_DEFER_ENGINE_START"\)[\s\S]*Applying saved engine settings/, 'native server child should wait for the loading page instead of launching C defaults');
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
assert.match(launcher, /!strcmp\(path, "\/api\/ds4\/setup"\)[\s\S]*api_setup_ds4\(fd, body\)/, 'launcher should expose POST /api/ds4/setup');
assert.doesNotMatch(launcher, /\/api\/ds4dir|api_set_ds4dir/, 'launcher should not keep the old manual ds4dir endpoint');
assert.match(launcher, /"setup-ds4"/, 'doctor should offer managed ds4 setup when the engine folder is missing');
assert.match(html, /id="onboard-ds4dir-setup-btn"/, 'onboarding should offer one-click ds4 install');
assert.match(html, /id="ds4dir-mode-path"[\s\S]*id="ds4dir-mode-lan"/, 'engine-folder dialog should offer Choose a path alongside Install and LAN');
assert.match(html, /id="ds4dir-path-in"[\s\S]*id="ds4dir-path-browse"[\s\S]*id="ds4dir-path-use"/, 'Choose a path should offer browse and use controls');
assert.match(html, /id="onboard-ds4dir-choose-btn"/, 'onboarding should offer a Choose button for an existing ds4 checkout');
assert.match(js, /async function pickDs4GatePath\(\)[\s\S]*window\.ds4PickDirectory[\s\S]*useDs4GatePath\(\)/, 'Choose a path should use the native folder picker');
assert.match(js, /async function useDs4GatePath\(\)[\s\S]*Engine\.setEngineCheckout\(path\)/, 'Choose a path should switch the engine checkout through the launcher API');
assert.match(js, /async function chooseDs4FromUi\(\)[\s\S]*Engine\.setEngineCheckout\(path\)/, 'onboarding Choose should switch the engine checkout');
assert.match(js, /let setModelScanning = false[\s\S]*if \(setModelScanFlight\) return setModelScanFlight[\s\S]*finally \{[\s\S]*setModelScanning = false[\s\S]*setModelScanFlight = null/, 'Settings model discovery should always leave its scanning state');
assert.match(js, /setModelScanError[\s\S]*text: 'Retry'[\s\S]*Could not scan the engine folders/, 'Settings model discovery should offer Retry after errors');
const openSettingsSource = js.match(/function openSettings\(\) \{[\s\S]*?\n      }\n\n      function openVideo/)?.[0] || '';
assert.match(openSettingsSource, /requestAnimationFrame\(\(\) => \{[\s\S]*dialog\.showModal\(\)[\s\S]*loadSetModels\(\)/, 'Settings should start its filesystem model scan after the deferred dialog open');
assert.match(html, /#ds4dir-dialog\.ds4dir-dialog\s*\{[\s\S]*width:\s*min\(94vw, 46rem\)[\s\S]*\.ds4dir-gate__path-row\s*\{[\s\S]*grid-template-columns:\s*minmax\(0, 1fr\) auto auto/, 'engine-folder dialog should keep long paths and actions readable');
assert.match(js, /ds4GateMode:\s*'local'[\s\S]*function setDs4GateMode\(mode, remember = true\)[\s\S]*Store\.setSettingsNow\(\{ ds4GateMode: mode \}\)[\s\S]*setDs4GateMode\(Store\.getSettings\(\)\.ds4GateMode \|\| 'local', false\)/, 'engine-folder dialog should remember the selected setup mode immediately');
assert.match(launcher, /static int persist_ds4_checkout\([\s\S]*engine-checkout[\s\S]*static int load_persisted_ds4_checkout\([\s\S]*api_engine_checkout_set[\s\S]*persist_ds4_checkout\(abs\)[\s\S]*load_persisted_ds4_checkout\(g_ds4_dir/, 'selected ds4 checkout should survive a launcher restart');
assert.match(html, /id="onboard-model-recheck"/, 'onboarding model section should offer an explicit Recheck button');
assert.match(html, /Required for local use/, 'local onboarding should clearly require a model');
assert.match(js, /await loadGgufs\(\);[\s\S]*if \(!selectedGguf\)[\s\S]*Download a model/, 'onboarding Start must refuse to finish without a selected local model');
assert.match(js, /start\.disabled = local && \(needsEngine \|\| needsModel\)/, 'onboarding Start must stay disabled until engine and model are ready');
assert.match(html, /id="onboard-lan-ds4dir-setup"[\s\S]*Install ds4/, 'LAN onboarding should offer local ds4 install for Agent/Design');
assert.match(html, /id="onboard-lan-ds4dir-path"/, 'LAN onboarding should show the managed local ds4 runtime path');
assert.doesNotMatch(html, /<h3>Folders<\/h3>|Good to know/, 'onboarding should stay compact without explanatory Folders or Good to know sections');
assert.match(html, /\.dialog--wide\s*\{[\s\S]*width:\s*min\(97vw,\s*58rem\)/, 'onboarding dialog should be slightly larger');
assert.doesNotMatch(html, /\.onboard__dl\s*\{[^}]*border-top/, 'onboarding model download row should not draw a divider');
const onboardingLocal = html.match(/<div id="onboard-local-panel"[\s\S]*?<section class="onboard__sec" id="onboard-model-sec">/)?.[0] || '';
assert.match(onboardingLocal, /id="onboard-ds4dir"[\s\S]*id="onboard-conn"/, 'onboarding should show the engine directory before the connection status');
assert.doesNotMatch(onboardingLocal, /onboard__status-k/, 'onboarding connection status should not duplicate the Engine heading');
assert.match(html, /id="ds4dir-setup"/, 'forced ds4 gate should offer one-click ds4 install');
assert.doesNotMatch(html, /id="onboard-ds4dir-browse-btn"|id="onboard-ds4dir-browse"|id="ds4dir-input"|id="ds4dir-save"/, 'UI should not keep retired manual ds4 folder fallback controls');
assert.match(js, /async function setupReadyEnoughToSkipOnboarding\(\)[\s\S]*Engine\.doctor\(\)[\s\S]*Number\(d\.fatal \|\| 0\) === 0[\s\S]*Engine\.status\(\)/, 'onboarding first-run gate should consult Doctor/status before showing');
assert.match(js, /onboarded:\s*'ds4web\.onboarded\.v2'/, 'onboarding should have a durable marker independent from settings');
assert.match(js, /function onboardingComplete\(\)[\s\S]*state\.settings\.onboarded === true[\s\S]*onboardingMarkerDone\(\)[\s\S]*hasLocalConversationHistory\(\)/, 'onboarding completion should survive settings reset when marker or local history exists');
assert.match(js, /function markOnboarded\(\)[\s\S]*writeKey\(STORAGE_KEYS\.settings, JSON\.stringify\(state\.settings\)\)[\s\S]*persistOnboardingMarker\(\)/, 'onboarding completion should write settings and the durable marker immediately');
assert.match(js, /async function maybeShowInitialOnboarding\(\)[\s\S]*Store\.onboardingComplete\(\)[\s\S]*Store\.markOnboarded\(\)[\s\S]*setupReadyEnoughToSkipOnboarding\(\)[\s\S]*Store\.markOnboarded\(\)[\s\S]*if \(document\.querySelector\('dialog\[open\]'\)\) setTimeout\(tryShow, 400\)/, 'onboarding should never reopen for a completed setup and should mark a ready local setup as onboarded');
assert.match(js, /if \(!lanClientLanding\) maybeShowInitialOnboarding\(\)/, 'onboarding mount should use the idempotent first-run gate');
assert.match(js, /on\(dialog, 'cancel', \(e\) => e\.preventDefault\(\)\)/, 'onboarding should not close when Escape is pressed');
assert.match(js, /await refreshLocalSetupState\(\)/, 'onboarding Start should refresh /api/status before deciding it can close');
assert.match(js, /async function refreshLocalSetupState\(\)[\s\S]*Engine\.status\(\)[\s\S]*applyLocalSetupStatus\(st\)/, 'onboarding Start status refresh should repaint the live ds4 state');
assert.match(js, /const localVisible = !lanPanel \|\| lanPanel\.hidden;[\s\S]*!completingOnboarding && localVisible && forcedSetup && !lastDs4Ok/, 'onboarding close guard should only reopen for an incomplete Local setup');
assert.match(js, /let startResult = null;[\s\S]*await Engine\.start\(\{ mode: 'server', gguf: selectedGguf\.path \}, true\)[\s\S]*startResult\.ok === false[\s\S]*Could not start selected model/, 'onboarding Start must show /api/start failures instead of silently closing');
assert.match(js, /function setSettingsNow\(patch\)[\s\S]*persistSettings\.cancel\(\)[\s\S]*writeKey\(STORAGE_KEYS\.settings, JSON\.stringify\(state\.settings\)\)/, 'settings still support an immediate write before navigation');
assert.match(js, /let shouldShowLoading = false;[\s\S]*shouldShowLoading = true;[\s\S]*if \(shouldShowLoading && !isLanClientMode\(\)\) location\.href = '\/loading\.html'/, 'onboarding Start should only show loading after it actually starts a different model');
assert.match(js, /async function connectLanAddress\(\)[\s\S]*await connectLanClientMode\(lanAddressInput\.value\)[\s\S]*completingOnboarding = true;[\s\S]*Store\.markOnboarded\(\);[\s\S]*dialog\.close\(\)/, 'LAN onboarding connect should complete onboarding only after a valid LAN health check');
assert.doesNotMatch(html, /onboard__cmd|onboard__list|fsfinder/, 'onboarding should not keep CSS for removed manual setup/finder UI');
assert.match(js, /async function setupDs4\(dir\)[\s\S]*\/api\/ds4\/setup/, 'Engine API should call the managed ds4 setup endpoint');
assert.match(js, /async function setupDs4FromUi\(\)[\s\S]*Engine\.setupDs4\(\)/, 'onboarding setup button should call the managed setup endpoint');
assert.match(js, /function availableModelDownloads\(ggufs\)[\s\S]*MODEL_DOWNLOADS\.filter[\s\S]*d\.match\.test\(file\)/, 'download picker should show every supported family while hiding files already present');
assert.match(js, /function renderSetModels\(\)[\s\S]*const choices = availableModelDownloads\(ggufs\)/, 'settings model download picker should expose the unified model catalog');
assert.match(html, /id="set-local-model-row"[\s\S]*id="set-deepseek-model-row"[\s\S]*deepseek-v4-flash[\s\S]*deepseek-v4-pro/, 'settings should provide separate local GGUF and DeepSeek cloud model pickers');
assert.match(js, /const syncBackendRows = \(\) =>[\s\S]*localModelRow\.hidden = cloud/, 'choosing the cloud backend should hide the local GGUF catalog');
assert.match(js, /async function refreshModels\(\)[\s\S]*cloudSelected[\s\S]*Api\.getModels[\s\S]*s\.chatBackend === 'deepseek'[\s\S]*deepseekModel: selected, model: selected/, 'settings should populate and persist the live DeepSeek cloud catalog');
assert.match(js, /const effectiveModel = cloud[\s\S]*deepseekModel \|\| 'deepseek-v4-flash'/, 'cloud chat requests should always use the selected DeepSeek model rather than a stale local model id');
assert.match(js, /if \(cloud\) \{[\s\S]*body\.thinking = \{ type: off \? 'disabled' : 'enabled' \}[\s\S]*body\.reasoning_effort = thinkLevel === 'max' \? 'max' : 'high'/, 'DeepSeek V4 cloud requests should honor the visible thinking control');
assert.match(js, /function renderModels\(\)[\s\S]*const choices = availableModelDownloads\(ggufs\)/, 'onboarding model download picker should expose the unified model catalog');
assert.match(js, /target: 'flash-abliterated'/, 'the uncensored model download should use the current target-based API');
assert.doesNotMatch(js, /body:\s*\{\s*variant:|typeof spec === 'string'/, 'model downloads should not retain the retired variant/string request formats');
const modelDownloadHandler = launcher.match(/static void api_model_download[\s\S]*?\nstatic void api_model_partials_delete/)?.[0] || '';
assert.match(modelDownloadHandler, /json_get_string\(body, "target"/, 'model download API should accept the current target field');
assert.doesNotMatch(modelDownloadHandler, /download-abliterated\.sh/, 'the default model must not depend on a script absent from the pinned ds4 checkout');
assert.match(launcher, /MODEL_ABLITERATED_HF_REVISION "08f6c6225ab4d29a735ab7d48d46bd0a3a767a07"[\s\S]*MODEL_ABLITERATED_SHA256 "55a46e7e9a51f3d6708559b8b284c3e60f6b97f9bab1f2c9633948c8331e99ee"[\s\S]*child_download_abliterated_resumable[\s\S]*child_curl_resumable\(part, final, MODEL_ABLITERATED_URL,[\s\S]*MODEL_ABLITERATED_SHA256/, 'the optional abliterated download should remain resumable and pinned by immutable revision, size and SHA-256');
assert.match(js, /target: 'ds4f-q2'[\s\S]*target: 'ds4f-q2-q4'[\s\S]*target: 'ds4f-q4'[\s\S]*target: 'ds4f-mxfp4'/, 'the UI should offer the ds4 0731 Flash quantizations with the new download targets');
assert.match(launcher, /"ds4f-q2", "ds4f-q2-q4", "ds4f-q4", "ds4f-mxfp4"/, 'the launcher whitelist should use the current download_model.sh target names');
assert.match(launcher, /MODEL_PRO\s+"gguf\/DeepSeek-V4-Pro-IQ2XXS-w2Q2K-AProjQ8-SExpQ8-OutQ8-Instruct-imatrix-0813\.gguf"/, 'the Pro target should follow the current upstream 0813 filename');
assert.match(launcher, /"ds4f-dspark", "flash-dspark"/, 'the launcher whitelist should include the DSpark support downloads');
assert.match(js, /target: 'ds4f-dspark'[\s\S]*target: 'flash-dspark'/, 'the UI should offer both DSpark support downloads');
assert.match(js, /target: 'ds4f-vision-q2'[\s\S]*target: 'ds4f-vision-q2-q4'[\s\S]*target: 'ds4f-vision-mxfp4'[\s\S]*target: 'ds4f-vision-dspark'[\s\S]*target: 'ds4f-vision-encoder'/, 'the UI should offer every upstream DeepSeek Vision-Exp model and matching support download');
assert.match(js, /function ggufIsDsparkSupport\(g\)[\s\S]*dspark\[-_ \]\*support/, 'the UI should classify DSpark GGUFs as engine support files');
assert.match(js, /function ggufIsEngineComponent\(g\)[\s\S]*ggufIsDsparkSupport\(g\)[\s\S]*ggufIsGlmVisionEncoder\(g\)[\s\S]*ggufIsDeepseekVisionEncoder\(g\)/, 'the UI should classify DSpark and both native vision encoders as engine components');
assert.match(js, /function renderSetModels\(\)[\s\S]*filter\(\(g\) => !ggufIsEngineComponent\(g\)\)[\s\S]*renderDsparkSupport\(\)[\s\S]*renderNativeVisionSupport\(\)/, 'Settings should exclude engine support files from selectable chat models and render them separately');
assert.match(js, /function renderDsparkSupport\(\)[\s\S]*DSpark draft file[\s\S]*Download this DSpark draft/, 'Advanced settings should manage installed and downloadable DSpark drafts');
assert.match(html, /data-pane="advanced"[\s\S]*id="set-dspark-support-row"[\s\S]*engine components, not chat models/, 'Advanced settings should explain that DSpark drafts are not chat models');
assert.match(html, /id="set-dspark"/, 'Settings should expose a DSpark toggle');
assert.match(js, /dspark: false/, 'DSpark should default to off');
assert.match(js, /dspark: dspark\(\)/, 'engine starts should send the DSpark preference');
assert.match(js, /const dsparkGreedy = !cloud && !!Store\.getSettings\(\)\.dspark[\s\S]*if \(dsparkGreedy\) body\.temperature = 0/, 'local Chat requests should use greedy decoding when DSpark is enabled');
assert.match(launcher, /json_get_bool\(body, "dspark"\)/, 'launcher should parse the DSpark setting');
assert.match(launcher, /--dspark[\s\S]*--mtp-model/, 'engine and agent spawns should pass the current upstream DSpark support-model flags');
assert.match(remoteDesign, /--mtp-model <gguf>[\s\S]*!strcmp\(arg, "--mtp"\)[\s\S]*glm_mtp = true[\s\S]*!strcmp\(arg, "--mtp-model"\)/, 'the Design runtime should share upstream MTP and external DSpark flag semantics');
assert.match(launcher, /child_download_dspark_resumable[\s\S]*MODEL_DSPARK_SHA256/, 'the uncensored DSpark download should be resumable and pinned by SHA-256');
assert.match(launcher, /MODEL_UNC "gguf\/DeepSeek-V4-Flash-0731-Abliterated-DS4-Headroom128\.gguf"/, 'the uncensored Flash model should point to the 0731 abliterated build');
assert.match(launcher, /MODEL_STD "gguf\/DeepSeek-V4-Flash-IQ2XXS-w2Q2K-AProjQ8-SExpQ8-OutQ8-chat-v2-imatrix-0731\.gguf"[\s\S]*MODEL_FLASH MODEL_STD/, 'Flash should default directly to the standard chat IQ2XXS GGUF');
assert.doesNotMatch(launcher, /MODEL_FLASH MODEL_UNC/, 'the default Flash variant must never alias the abliterated model');
assert.match(launcher, /ENGINE_DEFAULTS = \{[\s\S]{0,100}0, 28000, 65536, 90, 24576, 128, 1, 0, SSD_STREAMING_OFF/, 'native engine defaults should use the standard model, resident-friendly 64k context, unlimited Design reasoning and DS4-only streaming off');
assert.match(html, /id="set-design-think-tokens"[\s\S]*value="0"[\s\S]*Unlimited · recommended/, 'Settings should expose unlimited Design reasoning as the recommended default');
assert.match(js, /designThinkTokens:\s*0[\s\S]*designThinkTokens: designThinkTokens\(\)/, 'Design launches should default to and send unlimited reasoning');
assert.match(launcher, /--think-tokens[\s\S]*json_get_int\(body, "designThinkTokens"/, 'the native launcher should parse and forward the Design reasoning cap');
assert.match(qualityGates, /Design and Cowork default to EOS\/context-bound[\s\S]*no application token cap/, 'the release quality contract should document uncapped Max reasoning as the default');
assert.doesNotMatch(qualityGates, /Design additionally caps hidden reasoning at 16,384/, 'the release quality contract must not retain the obsolete mandatory 16k cap');
assert.match(qualityGates, /Ideogram 4, HunyuanImage and MiniMax H3[\s\S]*kernel-owned process[\s\S]*lock/, 'the release quality contract should document serialization of every local media worker');
assert.match(js, /runSwitch\('server', \{ mode: 'server', model: 'standard',[\s\S]*runSwitch\('agent', \{ mode: 'agent', model: 'standard',[\s\S]*runSwitch\('design', \{ mode: 'design', model: 'standard'/, 'Chat, Agent and Design should all launch the standard model by default');
assert.match(loadingHtml, /startWithSavedSettings\(\)[\s\S]*mode: 'server',[\s\S]*model: 'standard'/, 'the native loading gate should also start the standard model');
assert.match(js, /const DEFAULT_FLASH_GGUF =[\s\S]*function preferredDefaultGguf\(ggufs\)[\s\S]*g\?\.path[\s\S]*DEFAULT_FLASH_GGUF[\s\S]*preferredDefaultGguf\(ggufs\)/, 'fresh model discovery should prefer the standard chat GGUF instead of filesystem order');
assert.match(launcher, /flash_context_memory_bytes[\s\S]*flash_largest_safe_context[\s\S]*normalize_flash_memory_config[\s\S]*lazy memory-mapped path/, 'the launcher should preserve oversized Flash contexts through the lazy mapped path');
assert.doesNotMatch(launcher, /cfg->ctx\s*=\s*safe_ctx/, 'DS4-only SSD-off launches must not reduce the requested context');
assert.match(launcher, /auto disabled: DS4 is the sole active heavyweight model/, 'automatic SSD streaming should remain off when only DS4 is active');
assert.match(launcher, /resident_flash[\s\S]*unsetenv\("DS4_METAL_NO_RESIDENCY"\)[\s\S]*DS4_DSPARK_STATS/, 'a Flash configuration that fits should use Metal residency and expose DSpark statistics');
assert.doesNotMatch(launcher, /while \(\(de = readdir\(d\)\) != NULL\)[\s\S]{0,500}!strstr\(name, "DSpark"\)/, 'DSpark resolution must not fall back to an arbitrary incompatible support GGUF');
assert.match(js, /if \(res\.adjusted\)[\s\S]*patch\.ctxSize[\s\S]*patch\.dspark[\s\S]*Store\.setSettingsNow\(patch\)/, 'the UI should persist native memory-safety adjustments for every engine mode');
assert.match(loadingHtml, /if \(started\?\.adjusted\)[\s\S]*saved\.ctxSize[\s\S]*saved\.dspark[\s\S]*localStorage\.setItem/, 'the native loading gate should persist memory-safety adjustments before opening the app');
assert.match(launcher, /allowOverBudgetDspark[\s\S]*dspark_memory_confirmation[\s\S]*confirmationRequired[\s\S]*requiredBytes[\s\S]*budgetBytes/, 'an oversized DSpark launch should require an explicit structured confirmation instead of silently disabling DSpark');
assert.match(launcher, /Starting DSpark by user confirmation[\s\S]*g_dspark_enabled \? "true" : "false"/, 'the confirmed retry should preserve DSpark through the real engine spawn response');
assert.doesNotMatch(launcher, /DSpark disabled because the main and support models exceed the Metal memory budget/, 'the launcher must not silently disable an otherwise compatible DSpark configuration');
assert.match(js, /res\.code === 'dspark_memory_confirmation'[\s\S]*askConfirm\([\s\S]*Start DSpark anyway[\s\S]*allowOverBudgetDspark: true/, 'every in-app engine switch should explain the Metal risk and retry only after user confirmation');
assert.match(loadingHtml, /askDsparkMemoryConfirmation[\s\S]*dspark_memory_confirmation[\s\S]*allowOverBudgetDspark: true/, 'native app boot should expose the same DSpark memory confirmation instead of dropping the 409 response');
assert.match(modelDownloadHandler, /ds4f-vision-q2[\s\S]*ds4f-vision-q2-q4[\s\S]*ds4f-vision-mxfp4[\s\S]*ds4f-vision-encoder[\s\S]*ds4f-vision-dspark[\s\S]*glm53-q2[\s\S]*glm53-vision[\s\S]*laguna-q4/, 'model download API should whitelist DeepSeek Vision-Exp, GLM 5.3 and Laguna targets shown by the UI');
assert.match(launcher, /MODEL_GLM53_Q2 "gguf\/GLM-5\.3-Flash-Q2\.gguf"[\s\S]*MODEL_GLM53_Q2_EXPECTED_BYTES 96505816384LL[\s\S]*!strcmp\(target, "glm53-q2"\)/, 'GLM 5.3 Q2 download progress should use the exact upstream filename and byte size');
assert.match(launcher, /MODEL_GLM53_VISION "gguf\/GLM-5\.3-Flash-Vision-Encoder\.gguf"[\s\S]*MODEL_GLM53_VISION_EXPECTED_BYTES 1127280960LL[\s\S]*MODEL_GLM53_VISION_SHA256 "ae23e14c6979e889051b2e4a39351abcdafb161e18e606fae4d8c40095a4bf3a"[\s\S]*!strcmp\(target, "glm53-vision"\)/, 'native GLM vision should use the published encoder filename, exact size and SHA-256');
assert.match(launcher, /MODEL_DSVISION_ENCODER "gguf\/DeepSeek-V4-Flash-Vision-Encoder\.gguf"[\s\S]*MODEL_DSVISION_ENCODER_EXPECTED_BYTES 932857760LL[\s\S]*MODEL_DSVISION_ENCODER_SHA256 "00cd4d81a435364967400a95c42703343e11da6b6f18c5143fe76e1d94d5035f"[\s\S]*!strcmp\(target, "ds4f-vision-encoder"\)/, 'DeepSeek Vision-Exp should use the published encoder filename, exact size and SHA-256');
assert.match(launcher, /static const char \*native_selected_vision_encoder\(void\)[\s\S]*model_is_glm\(\)[\s\S]*MODEL_GLM53_VISION[\s\S]*model_is_deepseek_vision\(\)[\s\S]*MODEL_DSVISION_ENCODER/, 'the launcher should resolve the encoder matching the selected native-vision model');
assert.match(launcher, /spawn_server[\s\S]*native_selected_vision_encoder\(\)[\s\S]*"--vision"/, 'local native-vision Chat should attach the selected encoder automatically');
assert.match(launcher, /spawn_agent[\s\S]*native_selected_vision_encoder\(\)[\s\S]*vision_abs[\s\S]*"--vision"/, 'local native-vision Agent and Cowork should attach an absolute encoder path automatically');
assert.match(launcher, /const int native_vision[\s\S]*built-in `see_image`[\s\S]*built-in `view_image`[\s\S]*this engine is text-only in DStudio/, 'native-capable Agent and Design runtimes should use their own pixel tools while every other engine stays text-only');
assert.match(js, /function localLagunaSelected[\s\S]*Laguna S 2\.1 is text-only and cannot accept image attachments/, 'Chat should reject image attachments for Laguna');
assert.match(launcher, /model_is_laguna\(\)[\s\S]*DS4UI_DISABLE_VISION/, 'Laguna Agent and Cowork processes should fail closed for stale image-tool calls');
assert.doesNotMatch(jsonlPatchText, /ds4ui_tool_see_image|\/api\/vision/, 'Agent patches must not inject a visual sidecar');
assert.match(jsonlPatchText, /text_only\\":true/, 'patched PDF reads should always request text-layer extraction');
assert.match(launcher, /scannedPages[\s\S]{0,120}visionPages[\s\S]{0,120}figPages/, 'the PDF reader should report scanned pages and bounded native-vision pages');
assert.match(js, /function msgContentForModel\(m, nativeImages = new Map\(\)\)[\s\S]*type: 'image_url'[\s\S]*function buildHistory\(chat, settings, \{ nativeModelVision = false \} = \{\}\)/, 'Chat history should support native DeepSeek and GLM image blocks');
assert.match(js, /nativeVisionActive !== true[\s\S]*buildHistory\(chat, settings,[\s\S]*nativeModelVision: localNativeVisionSelected\([^)]+\) && readyStatus\?\.nativeVisionActive === true/, 'Chat should send native model image blocks only after the launcher confirms the encoder is active');
assert.doesNotMatch(js, /classifyImageRequestWithSource|runRoutedImageReply|describeVision/, 'Chat must not retain a secondary visual router');
assert.match(html, /id="set-native-vision-support"[\s\S]*Image workflows[\s\S]*no secondary visual router/, 'Vision settings should expose native encoders and direct image workflows');
assert.match(launcher, /!model_is_flash\(\) && g_dspark_enabled[\s\S]*DSpark disabled because it is only compatible with DeepSeek V4 Flash/, 'a saved DeepSeek DSpark toggle must not be attached to GLM 5.3');
assert.match(launcher, /g_dl_result = code == 0 \? 1 : -1[\s\S]*g_dl_result > 0[\s\S]*dl_pct = 100/, 'download completion should come from the downloader result for every model family');
assert.match(launcher, /model_download_bytes_present[\s\S]*"%s\.part"[\s\S]*g_dl_expected_bytes/, 'active downloads should report progress from the visible sibling .part file');
assert.match(launcher, /paused_model_download[\s\S]*stable_targets[\s\S]*glm53-q2[\s\S]*ds4f-vision-q2[\s\S]*stat\(part,[\s\S]*pausedDownloadBytes/, 'launcher status should rediscover visible DeepSeek and GLM partials after restart');
assert.match(js, /if \(dl\.paused\)[\s\S]*Delete partial/, 'every paused visible model partial should offer explicit deletion');
assert.match(launcher, /paused_model_download[\s\S]*DS4_LAGUNA_DIR_NAME[\s\S]*laguna-q4[\s\S]*pausedDownloadBytes[\s\S]*pausedDownloadPct/, 'launcher status should expose a stopped Laguna partial after restart');
assert.match(launcher, /paused_model_download[\s\S]*flash-abliterated[\s\S]*MODEL_ABLITERATED_EXPECTED_BYTES/, 'launcher status should expose a stopped abliterated-model partial after restart');
assert.match(launcher, /prepare_laguna_resumable_partial[\s\S]*rename\(best_path, part\)[\s\S]*child_curl_resumable[\s\S]*"--continue-at", "-"[\s\S]*rename\(part, final\)[\s\S]*child_download_laguna_resumable[\s\S]*child_curl_resumable\(part, final/, 'Laguna Resume should promote the largest legacy partial and continue into one stable curl file');
assert.match(launcher, /api_model_partials_delete[\s\S]*explicit partial deletion confirmation is required[\s\S]*stop the active model download before deleting[\s\S]*delete_laguna_partial_files[\s\S]*removedBytes/, 'partial cleanup API should require confirmation, reject active transfers and report permanently removed temporary bytes');
assert.match(launcher, /api_model_download_stop[\s\S]*kill\(-pid, SIGTERM\)[\s\S]*stopped\\":true/, 'model download stop API should terminate the isolated downloader process group');
assert.match(launcher, /!strcmp\(path, "\/api\/model\/download\/stop"\)[\s\S]*api_model_download_stop\(fd\)/, 'launcher should expose the model download stop endpoint');
assert.match(launcher, /api_model_folder_open[\s\S]*!strcmp\(engine, "main"\)[\s\S]*!strcmp\(engine, "laguna"\)[\s\S]*cstr_copy\(checkout, sizeof checkout, g_ds4_dir\)[\s\S]*execlp\("open", "open", folder/, 'model folder endpoint should resolve the shared GGUF directory from the active checkout in both source and native-app layouts');
assert.match(launcher, /!strcmp\(path, "\/api\/model\/folder\/open"\)[\s\S]*api_model_folder_open\(fd, body\)/, 'launcher should expose the model folder endpoint');
assert.match(launcher, /!strcmp\(path, "\/api\/model\/partials\/delete"\)[\s\S]*api_model_partials_delete\(fd, body\)/, 'launcher should expose the partial cleanup endpoint');
assert.match(launcher, /connect_loopback_with_retry[\s\S]*attempts[\s\S]*usleep[\s\S]*api_v1_proxy[\s\S]*connect_loopback_with_retry\(eport, 25, 100\)/, 'the local model proxy should tolerate the engine accept-loop handoff after long generations');
assert.doesNotMatch(modelDownloadHandler, /json_get_string\(body, "variant"|Legacy:/, 'model download API should reject retired variant aliases');
assert.match(js, /async function recheckModels\(\)[\s\S]*refreshModels\(\)[\s\S]*loadGgufs\(\)/, 'onboarding model Recheck should rescan status and GGUF files');
assert.match(js, /async function setupDs4FromUi\(\)[\s\S]*Engine\.setupDs4\(\)/, 'LAN onboarding local ds4 install should use the managed setup endpoint');
assert.match(html, /\.onboard__ctx[\s\S]*background-image:\s*url[\s\S]*appearance:\s*none/, 'onboarding dropdowns should use the polished custom select styling');
assert.match(js, /'setup-ds4': 'Install'/, 'system check should label managed ds4 setup clearly');
assert.match(js, /Onboarding\.setupDs4\(\)/, 'system check setup action should launch onboarding setup directly');
assert.doesNotMatch(js, /choose-ds4|verifyPath|toggleFinder|loadFinder|PATHS/, 'UI should not keep manual ds4 path fallback code');

assert.match(js, /function classifyResearchRequest\(/, 'web research should classify the request before searching');
assert.match(js, /async function generateImageFromDirective\(/, 'chat should dispatch the model image directive to the direct local pipeline');
assert.doesNotMatch(html, /id="set-vision-model"|Qwen3\.8-27B/, 'Vision settings must not expose a secondary visual model');
assert.match(html, /Image generation · creates images[\s\S]*Ideogram 4 FP8[\s\S]*Image editing · edits images[\s\S]*HunyuanImage-3\.0-Instruct/, 'Vision settings should expose both direct image-worker roles');
assert.match(js, /Understand the request semantically in whatever language the user uses; never depend on a keyword list/, 'the model prompt should classify image intent semantically in any language');
assert.match(js, /exactly one fenced block with info string dstudio-image/, 'the model prompt should emit a structured image-generation directive');
assert.match(js, /\{"action":"edit","prompt":"precise editing instructions","preserve":"none"\}/, 'the model prompt should distinguish edits that require source pixels');
assert.match(js, /Set preserve to "face" only when the user explicitly asks/, 'the model should semantically select Hunyuan identity preservation without a language regex');
assert.match(js, /function sourceImageForDirective\(chat, userMsg, directive, signal\)/, 'image edits should resolve the latest attached or generated source image');
assert.doesNotMatch(js, /VisualRoutingError|visualRoutingError|runRoutedImageReply/, 'Chat must not retain the retired preflight-router state machine');
assert.match(js, /imageAttachData\.get\(attachment\.id\)\?\.dataUri \|\| attachment\.thumb/, 'image edits should prefer original session pixels and fall back to the persisted preview');
assert.match(js, /preserve: directive\.preserve \|\| 'none'/, 'image edits should send semantic pixel-preservation intent to the backend');
assert.match(js, /never claim that the image is already generated/, 'the model confirmation must not claim completion before the selected local worker returns');
assert.match(js, /function extractImageGenerationDirectiveFromAssistant\(text\)/, 'chat should parse model-emitted image-generation directives');
assert.match(js, /\/api\/image\/generate/, 'chat should call the local image generation endpoint');
assert.match(js, /\/api\/image\/progress\?id=/, 'image generation should poll live job progress');
assert.match(extractFunction(js, 'stopLocalMediaJob'), /\['image', 'video'\][\s\S]*`\/api\/\$\{kind\}\/stop`[\s\S]*JSON\.stringify\(\{ job \}\)/,
  'media cancellation should use one bounded route allowlist and the exact generated job id');
assert.match(js, /async function generateImageFromDirective[\s\S]{0,3500}let completed = false[\s\S]*?job,[\s\S]*?completed = true[\s\S]*?if \(!completed\) stopLocalMediaJob\('image', job\)/,
  'an interrupted or disconnected image request must stop its exact backend worker');
assert.match(js, /async function generateVideoFromDirective[\s\S]{0,3500}let completed = false[\s\S]*?job,[\s\S]*?completed = true[\s\S]*?if \(!completed\) stopLocalMediaJob\('video', job\)/,
  'an interrupted or disconnected video request must stop its exact backend worker');
assert.match(js, /async function generateImageFromDirective\([\s\S]{0,1200}progress\?\.ok \|\| progress\?\.state === 'error'[\s\S]{0,80}onProgress\(progress\)/, 'image progress polling must surface terminal worker errors instead of silently discarding them');
assert.match(js, /function buildImageGenerationStatus\(status\)/, 'chat should render a dedicated image placeholder with progress');
assert.match(html, /\.msg-image-generation__[\s\S]*\.msg-image-generation__track[\s\S]*\.msg-image-generation__bar/, 'image placeholder should include progress UI styling');
assert.match(js, /imageGeneration = \{[\s\S]*stage: 'queued'[\s\S]*startedAt: Date\.now\(\)/, 'assistant messages should enter a visible image-generation state');
assert.match(js, /First use downloads the local image model once/, 'first-run model download should be explained in the placeholder without exposing implementation branding');
assert.match(fs.readFileSync('src/dstudio_image.c', 'utf8'), /static void api_image_progress\(/, 'backend should expose image job progress');
assert.match(ideogramScript, /QUALITY_STEPS = 48[\s\S]*def publish_inference_progress\([\s\S]*status_write\(path, "running", "sampling"[\s\S]*steps=QUALITY_STEPS/, 'Ideogram should publish full Quality-48 sampling progress through its shared status publisher');
assert.match(ideogramScript, /if step > last_step:[\s\S]*publish_inference_progress\([\s\S]*elif last_status_at == 0\.0 or now - last_status_at >= 30\.0:[\s\S]*heartbeat=True/, 'Ideogram should call the shared publisher for new sampling steps and 30-second heartbeats');
assert.match(hunyuanScript, /loading_editor[\s\S]*Loading full HunyuanImage-3\.0-Instruct NF4 into Metal/, 'Hunyuan editing should distinguish its full model-loading phase');
assert.match(hunyuanScript, /def validate_checkpoint_quantization[\s\S]*load_in_4bit[\s\S]*bnb_4bit_quant_type[\s\S]*bfloat16[\s\S]*dtype=torch\.bfloat16/, 'Hunyuan should validate the pinned full-Instruct NF4 map and retain BF16 compute');
assert.match(hunyuanShell, /--reasoning-output[\s\S]*--reasoning-file/, 'Hunyuan should unload Max reasoning before starting fresh diffusion');
assert.match(js, /function updateImageGeneration\(messageId, status\)[\s\S]*bar\.style\.width[\s\S]*return true/, 'image progress polling should update the existing placeholder without rebuilding the transcript');
assert.match(js, /Messages\.updateImageGeneration\(asst\.id, imageGeneration\)/, 'image pipeline progress should use the stable in-place placeholder update');
assert.match(js, /return \[priorGenerated\[0\], currentAttachments\[0\]\]/, 'identity-preserving edits should use the prior generated image as base and the current attachment as face reference');
assert.match(js, /referenceImage: sourceImages\?\.\[1\]/, 'multi-reference image edits should send the second source to the backend');
assert.match(js, /visualCandidateDataUri\(chat, candidate, signal\)/, 'explicit model-selected visual asset IDs should resolve to their original pixels');
assert.match(imagePipelineScript, /--action", choices=\("generate", "edit"\), required=True[\s\S]*if mode == "generate"[\s\S]*ideogram4-generate\.sh[\s\S]*else:[\s\S]*hunyuan-image3-edit\.sh/, 'the native model directive should select exactly Ideogram generation or Hunyuan editing');
assert.match(hunyuanScript, /prompt=prompt,[\s\S]*image=input_paths[\s\S]*bot_task="think_recaption"/, 'Hunyuan editing should receive every selected source and use full recaption reasoning');
assert.doesNotMatch(launcher, new RegExp(['visual_' + 'router_memory', '/api/' + 'vision'].join('|')), 'launcher domains must not retain the retired visual sidecar or its memory leases');
assert.match(js, /function routePdfReadPlan\([\s\S]*multilingual semantic PDF read planner[\s\S]*overview\|pages\|search/, 'Chat PDFs should use an LLM semantic read planner');
assert.match(js, /async function agentAttachImages\([\s\S]*\[USER_SCREENSHOT path="\$\{r\.rel\}"\][\s\S]*Exact user-supplied pixels are primary visual evidence[\s\S]*runtime's image tool/,
  'native-vision Agent and Design attachments must pass the exact workspace screenshot path to DS4');
assert.match(js, /on\(fileInput, 'change',[\s\S]*isWorkspaceFileDropMode\(\)[\s\S]*workspaceAttachFiles\(fileInput\.files\)/,
  'file-picker screenshots in Agent/Design must use the same exact-workspace path as paste and drop');
assert.match(js, /const runtimePrompt = Switcher\.wirePromptForRuntime[\s\S]*agentSendWhenSettled\(runtimePrompt, displayPrompt, expectedMode, thisSend\)/,
  'the USER_SCREENSHOT marker must remain in the runtime prompt sent to DS4');
assert.doesNotMatch(extractFunction(js, 'routePdfReadPlan'), /\.test\(/, 'PDF read intent must not use regular-expression classification');
assert.match(js, /profile:\s*readPlan\.mode === 'search' \? 'semantic' : 'interactive'[\s\S]*max_chars:\s*maxChars/, 'Chat PDFs should route to bounded overview/page reads or semantic retrieval');
assert.match(js, /cloudChat\s*\?\s*48\s*\*\s*1024[\s\S]*20\s*\*\s*1024/, 'PDF prompt budgets should stay bounded and adapt local versus cloud chat');
assert.match(launcher, /PDF_INTERACTIVE_MAX_TEXT_PAGES\s+48/, 'Long PDF chat reads should cap the representative page set');
assert.match(launcher, /pdf_select_interactive_pages[\s\S]*Farthest-point fill/, 'Long PDF selection should cover the whole document rather than only its first pages');
assert.match(launcher, /pdf_hybrid_page_scores[\s\S]*embed_call[\s\S]*pdf_select_semantic_pages/, 'Targeted PDF questions should retrieve across every page with multilingual embeddings');
assert.match(js, /readPlan\.mode === 'pages'[\s\S]*payload\.pages = readPlan\.pages/, 'LLM-selected physical page ranges should be sent directly to the PDF reader');
assert.match(js, /need\.needs !== 'embedding'[\s\S]*ensureEmbeddingSetup/, 'Semantic PDF retrieval should install its local embedding helper on demand');
assert.match(embedServer, /--parallel 1[\s\S]*--batch-size \$CTX[\s\S]*--ubatch-size \$CTX/, 'Metal embeddings should use one stable slot with a full-context physical batch');
assert.match(launcher, /PDF_RAG_EMBED_BATCH\s+4[\s\S]*pdf_embed_rag_batch[\s\S]*count \/ 2/, 'PDF RAG should use the measured embedding batch with recursive overflow splitting');
assert.match(launcher, /PDF_NATIVE_VISION_MAX_PAGES\s+4[\s\S]*pdf_render_native_pages[\s\S]*native_vision/,
  'PDF visual pages should be rendered only for the selected model native encoder');
assert.match(js, /native_vision:\s*!!opts\.nativeVision/,
  'Cowork should request PDF pixels only when the selected model exposes native vision');
assert.match(js, /coworkVisionPages[\s\S]*Native rendering of physical PDF page/,
  'Cowork should route rendered PDF pages to the current model through workspace image evidence');
assert.match(js, /selected model is text-only:[\s\S]*scanned\/image-only pages/,
  'Laguna and every text-only model should explain that scanned PDF pixels were not interpreted');
assert.match(launcher, /media_memory_begin\("image-pipeline"\)/, 'the direct image pipeline should acquire a temporary DS4 media lease');
assert.match(remoteDesign, /--ssd-streaming[\s\S]*c\.engine\.ssd_streaming = true/, 'design agent should accept the SSD-streaming launch option passed by DStudio');
assert.match(remoteDesign, /tool_call_building[\s\S]*tool_call_progress[\s\S]*raw_len/, 'Design should expose buffered DSML construction progress without exposing arguments');
assert.match(js, /toolBuildEventTail[\s\S]*captureToolBuildStatus[\s\S]*tool_call_building[\s\S]*tool_call_progress[\s\S]*building \$\{name \|\| 'tool call'\} · \$\{bytes\} byte buffered/, 'Design UI should reassemble split progress events and show the active tool name with buffered byte count');
assert.match(launcher, /model \+ reserve \+ 8ull \* gib > ram \* 82ull \/ 100ull/, 'media lease policy should evaluate model, pipeline reserve and physical RAM');
assert.doesNotMatch(jsonlPatchText, /ds4ui_tool_with_qwen_memory/, 'Agent PDF and native image tools must not load another vision model');
assert.match(mediaMemoryPatch, /ds4_gpu_model_residency_clear/, 'DS4 media patch should suspend Metal model residency for image and video workers');
assert.match(ideogramScript, /MODEL_REVISION = "bbee2ab2b14b2b5223448d12d6e31e5f9cec0546"/, 'Ideogram 4 FP8 weights should be pinned');
assert.match(ideogramScript, /QUALITY_STEPS = 48[\s\S]*Ideogram4Scheduler/, 'Ideogram generation should use the full official Quality-48 scheduler');
assert.match(hunyuanScript, /MODEL_REVISION = "98fda5c508c05f5407f036bca413149ca92c143b"/, 'HunyuanImage full-Instruct NF4 weights should be pinned');
assert.match(imagePipelineScript, /"secondaryVisionRouter": None[\s\S]*"serialized": True/, 'direct image provenance must prove that no secondary visual router ran');
assert.match(searchRuntime, /function classifyResearchRequest\(/, 'Search extension should own the research classifier runtime');
assert.match(searchRuntime, /function roadmapResearchQueries\(/,
  'Roadmap Deep Research should expand learner goals into curriculum, prerequisite, practice, and assessment searches');
assert.match(searchRuntime, /modelQueries\.slice\(0, 4\)[\s\S]*roadmapResearchQueries\(groundingSeed\)\.slice\(0, 2\)/,
  'Roadmap discovery should reserve search slots for open-courseware and university-catalogue evidence');
assert.match(searchRuntime, /never start from a preset topic catalogue/,
  'Roadmap topics must be derived from the learner goal and research instead of a built-in catalogue');
assert.match(searchRuntime, /there is no target count, minimum count, maximum count, or uniform stage shape/,
  'Roadmap stage and topic granularity should adapt to semantic breadth');
assert.doesNotMatch(searchRuntime, /5-8 stages|18-32 topic|3-6 topics per stage/,
  'Roadmap protocol must not impose fixed stage or topic quotas');
assert.match(searchRuntime, /purpose !== 'roadmap' && state\.judge\.decision === 'enough'/,
  'an explicit Roadmap URL must not suppress broader Deep Research');
assert.match(searchRuntime, /Roadmap research has not yet reached the minimum source diversity and evidence depth/,
  'Roadmap research should require source diversity and sufficient extracted evidence');
assert.match(searchRuntime, /pdfCount >= 2[\s\S]*Prefer HTML pages over PDF search results/,
  'Roadmap discovery should avoid exhausting its CDP read budget on PDF viewers that expose no body text');
assert.match(searchRuntime, /apps\.apple\.com[\s\S]*roadmapSourceSelectionScore\(source, question\) < 6/,
  'Roadmap source diversification should prefer fewer relevant pages over padding with app stores or weak candidates');
assert.match(searchRuntime, /quora\\\.com\|mathoverflow\\\.net[\s\S]*return 'social'/,
  'Roadmap research should treat Q&A communities as secondary social evidence');
assert.match(searchRuntime, /academicInstitutionPage[\s\S]*\\\.\(\?:edu\|ac\)/,
  'University course pages should be recognized as academic evidence across country-code education domains');
assert.match(searchRuntime, /'top_ans'[\s\S]*parsed\.searchParams\.delete/,
  'Canonical source keys should collapse answer and tracking variants instead of rereading one page');
assert.match(searchRuntime, /function roadmapResearchActionWithFallback\([\s\S]*automatic progress fallback after a no-op research plan/,
  'Roadmap research should replace repeated or already-completed model actions with unread CDP sources');
assert.match(searchRuntime, /fallbackReadBudget = Math\.max\(2, Math\.min\(4,[\s\S]*requireSubstantial && String\(source\.content \|\| ''\)\.length < 700/,
  'Roadmap fallback reads should scale to the evidence gap and reject insubstantial browser pages');
assert.match(searchRuntime, /for \(let attempt = 1; attempt <= 3; attempt\+\+\)[\s\S]*Research sufficiency judge retry/,
  'A truncated or malformed semantic research verdict should be retried instead of discarding completed research');
assert.match(searchRuntime, /Return the complete judgment[\s\S]*maxTokens: 0/,
  'Research judges should omit max_tokens so the server can return the complete verdict');
assert.match(searchRuntime, /SUCCESSFULLY READ PAGE MANIFEST \(authoritative; every URL below was opened and read\)[\s\S]*Never call a URL in that manifest unread/,
  'The semantic judge should receive an authoritative successful-read manifest and must not contradict it');
assert.match(searchRuntime, /skipped: the action produced no successfully read page or grounded fact/,
  'Failed CDP reads must not count as evidence progress or trigger another redundant verdict');
assert.match(searchRuntime, /Deep Research judge retry[\s\S]*normalizeResearchJudge\(obj\)/,
  'The generic Deep Research judge should also retry malformed complete JSON');
assert.doesNotMatch(searchRuntime, /Keep reason under 40 words|maxTokens: 1000 \+ attempt \* 300|uniqueStrings\(obj\?\.gaps \|\| \[\], (?:5|10)\)|uniqueStrings\(obj\?\.queries \|\| obj\?\.newQueries \|\| \[\], 12\)/,
  'Research judgments must not be shortened by arbitrary word, token, or array caps');
assert.doesNotMatch(searchRuntime, /Api\.completeText\(payload, AbortSignal\.timeout/,
  'Web and Roadmap model work should not be aborted by an automatic wall-clock timeout');
assert.match(js, /const WEB_SEARCH_PLAN_TIMEOUT_MS = Number\.POSITIVE_INFINITY;[\s\S]*const WEB_RESEARCH_TOTAL_TIMEOUT_MS = Number\.POSITIVE_INFINITY;/,
  'Every Web and Roadmap research budget should remain open until completion or manual Stop');
assert.match(js, /async function webSearch\(query, signal, options = \{\}\)[\s\S]*async function webRead\(url, signal, options = \{\}\)[\s\S]*async function httpProbe\(url, method = 'HEAD', signal\)/,
  'Web helpers should use only the manual cancellation signal, without automatic fetch deadlines');
assert.match(searchRuntime, /async function runResearchPipeline\(/, 'Search extension should own the shared search/deep research pipeline');
assert.match(js, /if \(roadmapMode\) settings = \{ \.\.\.settings, webMode: 'research', thinkLevel: 'max' \}/,
  'every Roadmap request must force Deep Research and maximum thinking independently of Chat settings');
assert.match(js, /async function runRoadmapReply\(/,
  'Roadmap generation should have a dedicated validated generation loop');
assert.match(js, /function roadmapQualityReport\(/,
  'Roadmap generation should reject shallow or structurally incomplete paths');
assert.doesNotMatch(js, /metrics\.stages < 5|metrics\.topics < 18|metrics\.smallestStage < 3/,
  'Roadmap quality validation must not force a uniform curriculum shape');
assert.doesNotMatch(js, /parsed\.stages\.slice\(0,\s*\d+\)|stage\?\.topics\s*:\s*\[\]\)\.slice\(0,\s*\d+\)/,
  'Roadmap parsing must not silently truncate semantically warranted stages or topics');
assert.match(js, /Roadmap reasoning and JSON may use every[\s\S]*maxTokens: 0/,
  'Roadmap generation should omit max_tokens and use all remaining physical context');
assert.doesNotMatch(js, /maxTokens: Math\.max\(Number\(lockedSettings\.maxTokens\) \|\| 0, 32768\)/,
  'Roadmap generation must not impose an arbitrary 32768-token response cap');
assert.match(js, /Improving roadmap depth · attempt/,
  'Roadmap quality failures should be repaired automatically until Stop');
assert.match(searchRuntime, /hasDeepResearchContext && !roadmapMode/,
  'Roadmap synthesis must not inherit the conflicting generic long-report Deep Research prompt');
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
assert.match(js, /return await runResearchPipeline\(userText, settings, \{[\s\S]*mode: 'research', onTrace, job, purpose: job\?\.purpose,[\s\S]*\}\)/, 'Deep Research should run through the generic research pipeline');
assert.match(js, /const deadline = performance\.now\(\) \+ WEB_RESEARCH_TOTAL_TIMEOUT_MS/, 'Search and Deep Research should share the long research pipeline budget');
assert.match(js, /async function selectSearchReads\(/, 'normal Web Search should have a model read-selection pass');
assert.match(js, /Do not answer about a software project, repository, technical stack, docs, package, company product, or pricing from snippets alone/, 'Web Search must not answer technical/project questions from snippets only');
assert.doesNotMatch(js, /For GitHub repositories|isGithubRepoSource|githubRepoIdentity|github\.com/, 'product web pipeline must not hardcode GitHub');
assert.match(js, /mandatoryPrimaryReadSources\(plan, sources, readUrls\)/, 'Search and Deep Research should merge mandatory primary reads');
assert.match(js, /Prefer evidence from read pages over snippets; treat unread search snippets as discovery, not proof/, 'Deep Research judge must prefer read pages over snippets');
assert.match(js, /Read page: \$\{s\.read \?/, 'final web contexts should expose whether a source was actually read');
assert.match(js, /Primary-source score: \$\{sourcePrimaryReadScore\(s, plan \|\| \{ mustMatch: \[\] \}\)\}/, 'read selector context should expose primary-source priority');

console.log('ui_contract_test: ok');

import fs from 'node:fs';
import assert from 'node:assert/strict';
const html = fs.readFileSync('web/index.html','utf8');
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
const engineError = new Function('deepseekMode', `${extractFunction(js, 'readableEngineError')}; return readableEngineError;`);
const localError = engineError(() => false);
const genericPrefill = localError('metal prefill failed: failed to encode down path');
assert.match(genericPrefill,/does not indicate insufficient memory/);
assert.match(genericPrefill,/failed to encode down path/,'retain engine diagnostics');
assert.doesNotMatch(genericPrefill,/64k|released|ran out of memory/);
for (const error of ['kIOGPUCommandBufferCallbackErrorOutOfMemory', 'Metal command batch failed: Insufficient Memory']) {
  assert.match(localError(error),/Metal reported insufficient memory/);
  assert.ok(localError(error).endsWith(error));
  assert.doesNotMatch(localError(error),/released/,'do not claim unverified model unloading');
  assert.equal(engineError(() => true)(error),error,'cloud errors are not rewritten');
}
assert.equal(localError('Connection refused'),'Connection refused');
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


console.log('Frontend behavior: parser, URLs, research adapters, LAN success/failure (no model) passed');

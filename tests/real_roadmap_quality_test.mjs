import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  artifactDir,
  completeTextStream,
  createWebPipeline,
  roadmapJudge,
  startDStudio,
  startMode,
  waitForModel,
  writeArtifact,
} from './real_harness.mjs';

const artifacts = artifactDir('roadmap-quality-real');

const cases = [
  {
    id: 'c-compiler',
    prompt: 'Voglio imparare a costruire da zero un compilatore C piccolo ma reale. Conosco la sintassi C di base ma non teoria dei compilatori né assembly. Ho 12 settimane e 8 ore a settimana; lavoro su macOS ma posso usare una VM Linux. Voglio arrivare a lexer, parser, AST, analisi semantica, type checking, una code generation semplice, test e debugging, con progetti progressivi e fonti autorevoli.',
  },
  {
    id: 'linear-algebra-ml',
    prompt: 'Crea un percorso profondo di algebra lineare per machine learning. Parto da algebra e trigonometria delle superiori, conosco Python base, posso studiare 6 ore a settimana per 10 settimane. Voglio intuizione geometrica, notazione rigorosa, dimostrazioni essenziali, esercizi a mano e implementazioni NumPy, fino a decomposizioni, least squares, PCA e stabilità numerica.',
  },
  {
    id: 'kubernetes-production',
    prompt: 'Sono uno sviluppatore backend che usa Docker e Linux ma non ha mai gestito Kubernetes. In 14 settimane con 7 ore a settimana voglio diventare capace di progettare, distribuire, mettere in sicurezza, osservare e diagnosticare workload Kubernetes in produzione. Includi networking, storage, scheduling, Helm o alternative, GitOps, policy, incident response, costi e un progetto realistico.',
  },
  {
    id: 'abstract-algebra',
    prompt: 'Voglio studiare algebra astratta in profondità, partendo da una buona preparazione di algebra lineare e dimostrazioni di base. Ho 24 settimane e 8 ore a settimana. Voglio una struttura che rifletta l’ampiezza reale del campo, i suoi prerequisiti e le dipendenze tra i diversi rami, con dimostrazioni, esercizi progressivi e verifiche di padronanza; non comprimere l’intera materia in un singolo blocco generico.',
  },
  {
    id: 'python-syntax-compact',
    prompt: 'Conosco già la programmazione in JavaScript e voglio solo imparare la sintassi Python di base necessaria per leggere e scrivere piccoli script. Ho 4 ore totali. Crea un percorso compatto, senza trasformare questo obiettivo circoscritto in una lunga roadmap artificiale.',
  },
];

function extractRoadmap(text) {
  const match = String(text || '').match(/```\s*dstudio-roadmap\s*([\s\S]*?)```/i) ||
    String(text || '').match(/```\s*dstudio-roadmap\s*([\s\S]*)$/i) ||
    String(text || '').match(/```\s*json\s*([\s\S]*?)```/i) ||
    String(text || '').match(/```\s*json\s*([\s\S]*)$/i);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1].trim());
    return parsed?.version === 2 && Array.isArray(parsed.stages) && parsed.stages.length ? parsed : null;
  } catch { return null; }
}

function normalizedUrl(value) {
  try { return new URL(String(value || '')).href; } catch { return ''; }
}

function deterministicRoadmapQuality(roadmap, sources) {
  const stages = Array.isArray(roadmap?.stages) ? roadmap.stages : [];
  const topics = stages.flatMap((stage) => Array.isArray(stage?.topics) ? stage.topics : []);
  const issues = [];
  const ratio = (predicate) => topics.length ? topics.filter(predicate).length / topics.length : 0;
  const stageRatio = (predicate) => stages.length ? stages.filter(predicate).length / stages.length : 0;
  const prior = new Set();
  const ids = new Set();
  let duplicateIds = 0;
  let dependencyEdges = 0;
  let invalidDependencies = 0;
  for (const stage of stages) {
    if (!stage?.id || ids.has(stage.id)) duplicateIds += 1;
    ids.add(stage?.id);
    for (const topic of stage.topics || []) {
      if (!topic?.id || ids.has(topic.id)) duplicateIds += 1;
      ids.add(topic?.id);
      for (const prerequisite of topic.prerequisites || []) {
        dependencyEdges += 1;
        if (!prior.has(prerequisite)) invalidDependencies += 1;
      }
      prior.add(topic.id);
    }
  }
  const sourceUrls = new Set((sources || []).map((source) => normalizedUrl(source.url)).filter(Boolean));
  const roadmapUrls = new Set(topics.flatMap((topic) => topic.resources || []).map((resource) => normalizedUrl(resource.url)).filter(Boolean));
  const inventedUrls = [...roadmapUrls].filter((url) => !sourceUrls.has(url));
  const metrics = {
    stages: stages.length,
    topics: topics.length,
    stageTopicCounts: stages.map((stage) => stage.topics?.length || 0),
    summaryCoverage: ratio((topic) => String(topic.summary || '').length >= 45),
    hoursCoverage: ratio((topic) => Number(topic.estimatedHours) > 0),
    conceptsCoverage: ratio((topic) => Array.isArray(topic.keyConcepts) && topic.keyConcepts.length >= 1),
    outcomeCoverage: ratio((topic) => String(topic.outcome || '').length >= 30),
    practiceCoverage: ratio((topic) => String(topic.practice || '').length >= 40),
    assessmentCoverage: ratio((topic) => String(topic.assessment || '').length >= 30),
    objectiveCoverage: stageRatio((stage) => Array.isArray(stage.objectives) && stage.objectives.length > 0),
    checkpointCoverage: stageRatio((stage) => String(stage.checkpoint || '').length >= 30),
    dependencyEdges,
    invalidDependencies,
    duplicateIds,
    researchedUrlsUsed: roadmapUrls.size,
    inventedUrls,
  };
  if (!metrics.stages || !metrics.topics) issues.push('The roadmap must contain the stages and topics warranted by the learner goal.');
  for (const [name, value, minimum] of [
    ['summary', metrics.summaryCoverage, .9], ['estimatedHours', metrics.hoursCoverage, .8],
    ['keyConcepts', metrics.conceptsCoverage, .9], ['outcome', metrics.outcomeCoverage, .9],
    ['practice', metrics.practiceCoverage, .9], ['assessment', metrics.assessmentCoverage, .9],
  ]) if (value < minimum) issues.push(`${name} coverage must be at least ${Math.round(minimum * 100)}%; found ${Math.round(value * 100)}%.`);
  if (metrics.objectiveCoverage < .8) issues.push('At least 80% of stages need objectives.');
  if (metrics.checkpointCoverage < 1) issues.push('Every stage needs a measurable checkpoint.');
  if (invalidDependencies) issues.push(`${invalidDependencies} prerequisite references are missing or point forward.`);
  if (duplicateIds) issues.push(`${duplicateIds} ids are missing or duplicated.`);
  if (roadmapUrls.size < 3) issues.push('Use at least three distinct researched URLs.');
  if (inventedUrls.length) issues.push(`Invented or unresearched URLs: ${inventedUrls.join(', ')}`);
  if (!roadmap?.goal || !roadmap?.audience || !roadmap?.estimatedDuration || !(roadmap?.assumptions || []).length) issues.push('Goal, audience, duration, and assumptions are required.');
  if (!roadmap?.capstone?.title || !roadmap?.capstone?.description || (roadmap?.capstone?.deliverables || []).length < 2 || (roadmap?.capstone?.successCriteria || []).length < 3) issues.push('Capstone needs a description, two deliverables, and three success criteria.');
  return { pass: issues.length === 0, score: Math.max(0, 100 - issues.length * 6), issues, metrics };
}

async function generateRoadmap(baseUrl, protocol, request, research, sources, caseId) {
  const baseMessages = [
    { role: 'system', content: protocol },
    { role: 'user', content: `${request}\n\n${research}` },
  ];
  let messages = baseMessages;
  let lastContent = '';
  let quality = null;
  const maxAttempts = Number(process.env.DSTUDIO_REAL_ROADMAP_ATTEMPTS || 3);
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let lastProgressWrite = 0;
    const result = await completeTextStream(baseUrl, messages, {
      // Zero omits max_tokens, matching the product path: the only remaining
      // boundary is the model's physical context window.
      maxTokens: Number(process.env.DSTUDIO_REAL_ROADMAP_MAX_TOKENS || 0),
      // Zero also omits the harness AbortSignal timeout. The product waits for
      // manual Stop, so a slow Thinking max roadmap must be tested the same way.
      timeoutMs: Number(process.env.DSTUDIO_REAL_ROADMAP_TIMEOUT_MS || 0),
      temperature: .25,
      thinkLevel: 'max',
      onProgress: ({ content, reasoning }) => {
        const now = Date.now();
        if (now - lastProgressWrite < 3000) return;
        lastProgressWrite = now;
        writeArtifact(artifacts, `${caseId}-generation-live.json`, {
          attempt,
          contentChars: content.length,
          reasoningChars: reasoning.length,
          contentTail: content.slice(-1200),
          reasoningTail: reasoning.slice(-1200),
        });
      },
    });
    lastContent = result.content;
    writeArtifact(artifacts, `${caseId}-generation-attempt-${attempt}-raw.md`, lastContent);
    writeArtifact(artifacts, `${caseId}-generation-attempt-${attempt}-reasoning.md`, result.reasoning);
    const roadmap = extractRoadmap(lastContent);
    quality = roadmap
      ? deterministicRoadmapQuality(roadmap, sources)
      : { pass: false, score: 0, issues: ['Missing or invalid dstudio-roadmap JSON fence.'], metrics: {} };
    if (quality.pass) return { roadmap, quality, attempts: attempt, content: lastContent, reasoning: result.reasoning };
    messages = [
      ...baseMessages,
      { role: 'assistant', content: lastContent },
      {
        role: 'user',
        content: [
          `[Roadmap quality repair · attempt ${attempt + 1}]`,
          'Return one complete repaired dstudio-roadmap JSON block. Fix every issue without deleting sound depth or researched URLs:',
          'Re-evaluate granularity semantically: split broad blocks with independent outcomes or prerequisite chains, combine narrow blocks that share one outcome, and never use preset topics, uniform stage sizes, or count padding.',
          'Keep hidden reasoning to a compact structural audit; do not draft every JSON field in reasoning before emitting the complete fenced block.',
          ...quality.issues.map((issue) => `- ${issue}`),
        ].join('\n'),
      },
    ];
  }
  throw new Error(`Roadmap failed quality after ${maxAttempts} attempts: ${JSON.stringify(quality)}\n${lastContent}`);
}

const requestedIds = String(process.env.DSTUDIO_REAL_ROADMAP_CASES || '').split(',').map((item) => item.trim()).filter(Boolean);
const selectedCases = requestedIds.length
  ? requestedIds.map((id) => cases.find((entry) => entry.id === id)).filter(Boolean)
  : cases;
assert.ok(selectedCases.length, 'No matching roadmap evaluation cases selected');
const selectedPrefixes = selectedCases.map((entry) => `${entry.id}-`);
const reuseResearch = process.env.DSTUDIO_REAL_ROADMAP_REUSE_RESEARCH === '1';
const reusableResearchSuffixes = [
  '-research-result.json', '-research-trace.json', '-research-sources.json', '-research-context.md',
];
for (const name of fs.readdirSync(artifacts)) {
  if (name === 'summary.json' || selectedPrefixes.some((prefix) => name.startsWith(prefix))) {
    if (reuseResearch && reusableResearchSuffixes.some((suffix) => name.endsWith(suffix))) continue;
    fs.rmSync(path.join(artifacts, name), { recursive: true, force: true });
  }
}

const server = await startDStudio({
  binaryArg: process.argv[2], label: 'dstudio-roadmap-real', isolatedEnginePort: true,
});
try {
  if (!server.external) {
    const gguf = server.ggufs.find((entry) => /DeepSeek-V4-Flash-IQ2XXS.*chat-v2.*0731/i.test(entry.file)) ||
      server.ggufs.find((entry) => /DeepSeek-V4-Flash/i.test(entry.file));
    if (!gguf) throw new Error('No DeepSeek V4 Flash GGUF is available for the real Roadmap benchmark.');
    await startMode(server.baseUrl, {
      mode: 'server', model: 'uncensored', variant: 'flash',
      gguf: gguf.file, port: server.enginePort, ctx: 65536, power: 90, think: 'off', ssdStreaming: 'auto',
    }, Number(process.env.DSTUDIO_REAL_TEST_TIMEOUT_MS || 1_800_000));
  }
  await waitForModel(server.baseUrl);
  const pipeline = createWebPipeline(server.baseUrl);
  const settings = { model: 'ds4', temperature: 0, maxTokens: 2200, thinkLevel: 'off' };
  const summary = [];

  for (const testCase of selectedCases) {
    let trace = [];
    const researchCheckpoint = path.join(artifacts, `${testCase.id}-research-result.json`);
    let research = null;
    if (reuseResearch && fs.existsSync(researchCheckpoint)) {
      research = JSON.parse(fs.readFileSync(researchCheckpoint, 'utf8'));
      trace = research.trace || [];
    } else {
      const controller = new AbortController();
      research = await pipeline.runDeepResearch(
        testCase.prompt,
        settings,
        (next) => {
          trace = next;
          writeArtifact(artifacts, `${testCase.id}-research-trace-live.json`, trace);
        },
        { purpose: 'roadmap', controller, cancelled: false },
      );
      research.trace = trace;
      // Persist the expensive CDP evidence phase before generation. A model
      // output experiment can then be restarted without repeating web reads.
      writeArtifact(artifacts, `${testCase.id}-research-result.json`, research);
      writeArtifact(artifacts, `${testCase.id}-research-trace.json`, trace);
      writeArtifact(artifacts, `${testCase.id}-research-sources.json`, research.sources);
      writeArtifact(artifacts, `${testCase.id}-research-context.md`, research.context);
    }
    const generated = await generateRoadmap(
      server.baseUrl,
      pipeline.roadmapOutputProtocol,
      testCase.prompt,
      research.context,
      research.sources,
      testCase.id,
    );
    const judge = await roadmapJudge(server.baseUrl, {
      request: testCase.prompt,
      roadmap: generated.roadmap,
      sources: research.sources,
      researchContext: research.context,
    });

    const readSources = (research.sources || []).filter((source) => source.read);
    const discoveredSources = (research.sources || []).filter((source) => source.searchProvider);
    const hosts = new Set(readSources.map((source) => {
      try { return new URL(source.url).hostname; } catch { return ''; }
    }).filter(Boolean));
    const labels = trace.map((step) => String(step.label || '').toLowerCase());
    assert.ok(labels.some((label) => label.includes('classify')), `${testCase.id}: research should classify`);
    assert.ok(labels.some((label) => label.includes('search')), `${testCase.id}: research should search`);
    assert.ok(labels.some((label) => label.includes('read url')), `${testCase.id}: research should read pages`);
    assert.ok(labels.some((label) => label.includes('extract facts')), `${testCase.id}: research should extract facts`);
    assert.ok(labels.some((label) => label.includes('judge')), `${testCase.id}: research should judge sufficiency`);
    assert.ok(readSources.length >= 5, `${testCase.id}: expected at least five substantial read sources`);
    assert.ok(hosts.size >= 4, `${testCase.id}: expected at least four independent source hosts`);
    assert.ok((research.facts || []).length >= 15, `${testCase.id}: expected at least fifteen grounded curriculum facts`);
    assert.ok(readSources.every((source) => source.reader === 'browser'),
      `${testCase.id}: every Roadmap source must be read through Chrome/CDP`);
    assert.ok(discoveredSources.length > 0 && discoveredSources.every((source) =>
      /via CDP$/.test(source.searchProvider) && source.searchCdpOnly === true
    ), `${testCase.id}: every discovered Roadmap source must come from a browser search through CDP`);
    const attempts = discoveredSources[0].searchAttempts || [];
    assert.equal(attempts[0]?.engine, 'Google', `${testCase.id}: Google must be attempted first`);
    if (attempts[0]?.status === 'failed') {
      assert.deepEqual(attempts.slice(1).map((attempt) => attempt.engine), ['Brave', 'Bing', 'DuckDuckGo'],
        `${testCase.id}: a blocked Google attempt must continue through all CDP engines`);
    }
    assert.equal(generated.quality.pass, true, `${testCase.id}: deterministic quality gate failed`);
    assert.ok(Number(judge.overall) >= 8 && judge.pass !== false, `${testCase.id}: roadmap judge failed: ${JSON.stringify(judge)}`);
    for (const value of Object.values(judge.dimensions || {})) {
      assert.ok(Number(value) >= 7, `${testCase.id}: a judge dimension scored below 7: ${JSON.stringify(judge)}`);
    }

    writeArtifact(artifacts, `${testCase.id}-request.txt`, testCase.prompt);
    writeArtifact(artifacts, `${testCase.id}-research-trace.json`, trace);
    writeArtifact(artifacts, `${testCase.id}-research-sources.json`, research.sources);
    writeArtifact(artifacts, `${testCase.id}-research-context.md`, research.context);
    writeArtifact(artifacts, `${testCase.id}-roadmap.json`, generated.roadmap);
    writeArtifact(artifacts, `${testCase.id}-roadmap-raw.md`, generated.content);
    writeArtifact(artifacts, `${testCase.id}-quality.json`, generated.quality);
    writeArtifact(artifacts, `${testCase.id}-judge.json`, judge);
    const generatedTopics = generated.roadmap.stages.flatMap((stage) => stage.topics || []);
    summary.push({
      id: testCase.id,
      attempts: generated.attempts,
      quality: generated.quality,
      judge,
      readSources: readSources.length,
      sourceHosts: hosts.size,
      shape: {
        stages: generated.roadmap.stages.length,
        topics: generatedTopics.length,
        estimatedHours: generatedTopics.reduce((sum, topic) => sum + (Number(topic.estimatedHours) || 0), 0),
        topicsPerStage: generated.roadmap.stages.map((stage) => (stage.topics || []).length),
      },
    });
  }

  const broad = summary.find((entry) => entry.id === 'abstract-algebra');
  const compact = summary.find((entry) => entry.id === 'python-syntax-compact');
  if (broad && compact) {
    assert.ok(broad.shape.stages > compact.shape.stages,
      `Adaptive granularity should give the broad domain more stages: ${JSON.stringify({ broad: broad.shape, compact: compact.shape })}`);
    assert.ok(broad.shape.topics > compact.shape.topics,
      `Adaptive granularity should give the broad domain more topics: ${JSON.stringify({ broad: broad.shape, compact: compact.shape })}`);
    assert.ok(broad.shape.estimatedHours > compact.shape.estimatedHours,
      `Adaptive granularity should allocate more effort to the broad domain: ${JSON.stringify({ broad: broad.shape, compact: compact.shape })}`);
  }

  writeArtifact(artifacts, 'summary.json', summary);
  console.log(`real_roadmap_quality_test: ok (${summary.map((entry) => `${entry.id}=${entry.judge.overall}/10`).join(', ')})`);
} finally {
  await server.stop();
}

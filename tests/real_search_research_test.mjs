import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  artifactDir,
  completeText,
  createWebPipeline,
  modelJudge,
  startDStudio,
  waitForModel,
  writeArtifact,
} from './real_harness.mjs';

const artifacts = artifactDir('search-research-real');
for (const name of fs.readdirSync(artifacts)) {
  fs.rmSync(path.join(artifacts, name), { recursive: true, force: true });
}
const server = await startDStudio({ binaryArg: process.argv[2], label: 'dstudio-search-real' });

function hasReadGithubRepo(sources) {
  return (sources || []).some((s) =>
    s?.read &&
    /github\.com\/sk8erboi17\/DStudio/i.test(String(s.url || ''))
  );
}

function traceHas(trace, label) {
  return (trace || []).some((s) => String(s.label || '').toLowerCase().includes(label.toLowerCase()));
}

function assertDStudioGrounding(answer, label) {
  assert.match(answer, /ds4/i, `${label} should mention ds4`);
  assert.match(answer, /(C launcher|launcher C|index\.html|Makefile|vanilla|native app|app locale|local-first)/i, `${label} should mention concrete DStudio implementation details`);
  assert.doesNotMatch(answer, /\b(CrewAI|Ollama|Streamlit|FastAPI|ChromaDB|LangChain|Python)\b/i, `${label} must not invent the unrelated Vane/Python stack`);
}

try {
  await waitForModel(server.baseUrl);
  const pipeline = createWebPipeline(server.baseUrl);
  const settings = {
    model: 'ds4',
    temperature: 0,
    maxTokens: 1800,
    thinkLevel: 'off',
  };

  const searchQuestion = [
    'Analizza tecnicamente il progetto DStudio partendo dalla fonte primaria:',
    'https://github.com/sk8erboi17/DStudio',
    'Dimmi stack, architettura e limiti verificabili. Leggi la repo/README prima di rispondere.',
  ].join(' ');

  let searchTrace = [];
  const searchResult = await pipeline.searchWithPlan(searchQuestion, settings, (t) => {
    searchTrace = t;
    writeArtifact(artifacts, 'search-trace-live.json', searchTrace);
  });
  const searchContext = searchResult.context || pipeline.buildWebContext(searchQuestion, searchResult.sources, searchResult.plan);
  const searchAnswer = await completeText(server.baseUrl, [
    {
      role: 'user',
      content: `${searchQuestion}\n\n${searchContext}`,
    },
  ], { maxTokens: 1800, temperature: 0, thinkLevel: 'off' });
  const searchJudge = await modelJudge(server.baseUrl, {
    question: searchQuestion,
    answer: searchAnswer,
    sources: searchResult.sources,
  });

  writeArtifact(artifacts, 'search-trace.json', searchTrace);
  writeArtifact(artifacts, 'search-sources.json', searchResult.sources);
  writeArtifact(artifacts, 'search-context.md', searchContext);
  writeArtifact(artifacts, 'search-answer.md', searchAnswer);
  writeArtifact(artifacts, 'search-judge.json', searchJudge);

  assert.equal(traceHas(searchTrace, 'Classify'), true, 'Search should classify the request');
  assert.equal(traceHas(searchTrace, 'Pick sources'), true, 'Search should pick sources');
  assert.equal(traceHas(searchTrace, 'Extract facts'), true, 'Search should extract facts from read pages');
  assert.equal(traceHas(searchTrace, 'Read URL'), true, 'Search should read at least one URL');
  assert.equal(hasReadGithubRepo(searchResult.sources), true, 'Search should read the GitHub DStudio repo');
  assert.match(searchContext, /ds4/i, 'Search context should contain facts from the DStudio repo');
  assertDStudioGrounding(searchAnswer, 'Search answer');
  assert.doesNotMatch(searchAnswer, /non (sono|è) disponibil[ie] dettagli sul codice|non verificabil[ei] direttamente dalle fonti/i);
  assert.ok(
    Number(searchJudge.score) >= 7 && searchJudge.pass !== false,
    `Search quality judge failed: ${JSON.stringify(searchJudge)}`
  );

  const researchQuestion = [
    'Fai una Deep Research tecnica su DStudio usando la fonte primaria GitHub:',
    'https://github.com/sk8erboi17/DStudio',
    'Voglio un report Markdown con Summary, Evidence, Stack, Gaps e Sources.',
  ].join(' ');

  let researchTrace = [];
  const researchResult = await pipeline.runDeepResearch(researchQuestion, settings, (t) => {
    researchTrace = t;
    writeArtifact(artifacts, 'research-trace-live.json', researchTrace);
  });
  const researchAnswer = await completeText(server.baseUrl, [
    {
      role: 'user',
      content: `${researchQuestion}\n\n${researchResult.context}`,
    },
  ], { maxTokens: 4200, temperature: 0, thinkLevel: 'off' });
  const researchJudge = await modelJudge(server.baseUrl, {
    question: researchQuestion,
    answer: researchAnswer,
    report: researchResult.context,
    sources: researchResult.sources,
  });

  writeArtifact(artifacts, 'research-trace.json', researchTrace);
  writeArtifact(artifacts, 'research-sources.json', researchResult.sources);
  writeArtifact(artifacts, 'research-probes.json', researchResult.probes);
  writeArtifact(artifacts, 'research-context.md', researchResult.context);
  writeArtifact(artifacts, 'research-answer.md', researchAnswer);
  writeArtifact(artifacts, 'research-judge.json', researchJudge);

  assert.equal(traceHas(researchTrace, 'Classify'), true, 'Deep Research should classify');
  assert.equal(traceHas(researchTrace, 'Search'), true, 'Deep Research should search');
  assert.equal(traceHas(researchTrace, 'Pick sources'), true, 'Deep Research should pick sources');
  assert.equal(traceHas(researchTrace, 'Read URL'), true, 'Deep Research should read URLs');
  assert.equal(traceHas(researchTrace, 'Extract facts'), true, 'Deep Research should extract facts');
  assert.equal(traceHas(researchTrace, 'Judge'), true, 'Deep Research should judge sufficiency');
  assert.equal(hasReadGithubRepo(researchResult.sources), true, 'Deep Research should read the GitHub DStudio repo');
  assertDStudioGrounding(researchAnswer, 'Deep Research answer');
  assert.match(researchAnswer, /summary/i, 'Deep Research answer should include Summary');
  assert.match(researchAnswer, /evidence|evidenze/i, 'Deep Research answer should include Evidence');
  assert.match(researchAnswer, /sources|fonti/i, 'Deep Research answer should include Sources');
  assert.ok(
    Number(researchJudge.score) >= 7 && researchJudge.pass !== false,
    `Deep Research quality judge failed: ${JSON.stringify(researchJudge)}`
  );

  console.log('real_search_research_test: ok');
} finally {
  await server.stop();
}

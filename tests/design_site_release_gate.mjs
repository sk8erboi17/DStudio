import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { findChrome, probeInteractiveButtons } from './design_control_probe.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const site = path.resolve(process.argv[2] || '');
const caseId = String(process.argv[3] || '').trim();
const evidence = path.resolve(process.argv[4] ||
  path.join(path.dirname(site), `${path.basename(site)}.release-evidence`));

if (!fs.statSync(site, { throwIfNoEntry: false })?.isDirectory() || !caseId) {
  console.error('usage: node tests/design_site_release_gate.mjs SITE_DIR CASE_ID [EVIDENCE_DIR]');
  process.exit(2);
}

const cases = JSON.parse(fs.readFileSync(path.join(root, 'extension/design/bench/cases.json'), 'utf8')).cases;
const testCase = cases.find(item => item.id === caseId);
assert.ok(testCase?.fullStack, `unknown full-stack benchmark case: ${caseId}`);

const releaseEntry = path.join(site, 'index.html');
const sourceAsset = path.join(site, testCase.generatedImage);
const editedAsset = path.join(site, testCase.editedImage);
const videoAsset = path.join(site, testCase.video);
const required = [
  'index.html', 'README.md', 'MEDIA_AND_MODELS.md', 'RELEASE_MANIFEST.json', '.nojekyll',
  testCase.generatedImage, testCase.editedImage, testCase.video,
  'evidence/inference-provenance.json', 'evidence/h3-native-provenance.json',
  'evidence/h3-native.log', 'evidence/benchmark-events.json',
  'evidence/qwen-vision-preflight.json',
  'evidence/ideogram-pipeline-provenance.json',
  'evidence/ideogram-route-provenance.json',
  'evidence/ideogram-native-provenance.json',
  'evidence/hunyuan-pipeline-provenance.json',
  'evidence/hunyuan-route-provenance.json',
  'evidence/hunyuan-native-provenance.json',
  'evidence/hunyuan-max-reasoning.json',
];
for (const relative of required) {
  const stat = fs.statSync(path.join(site, relative), { throwIfNoEntry: false });
  assert.ok(stat?.isFile(), `missing release file: ${relative}`);
  if (relative !== '.nojekyll') assert.ok(stat.size > 0, `empty release file: ${relative}`);
  assert.ok(stat.size < 100 * 1024 * 1024, `GitHub file limit exceeded: ${relative}`);
}

function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const absolute = path.join(directory, entry.name);
    assert.equal(entry.isSymbolicLink(), false, `release symlink is forbidden: ${absolute}`);
    return entry.isDirectory() ? walk(absolute) : [absolute];
  });
}

const allFiles = walk(site);
assert.equal(allFiles.some(file => path.basename(file) === '.DS_Store'), false,
  '.DS_Store is not releasable');
assert.equal(allFiles.some(file => /(?:^|\/)__pycache__(?:\/|$)/.test(file)), false,
  '__pycache__ is not releasable');
assert.equal(allFiles.some(file => fs.statSync(file).size >= 100 * 1024 * 1024), false,
  'release contains a file above the GitHub 100 MB limit');

const releaseManifest = JSON.parse(fs.readFileSync(path.join(site, 'RELEASE_MANIFEST.json'), 'utf8'));
assert.equal(releaseManifest.schema, 'ds4.design.release.v1', 'invalid release manifest schema');
assert.equal(releaseManifest.caseId, caseId, 'release manifest case does not match the requested benchmark');
assert.equal(releaseManifest.benchmarkPass, true, 'release manifest does not record a benchmark PASS');
assert.equal(releaseManifest.toolCompliance, true, 'release manifest does not record tool compliance');
assert.ok(Number(releaseManifest.elapsedMs) > 0, 'release manifest does not record measured generation time');
assert.match(String(releaseManifest.pagesUrl || ''),
  /^https:\/\/[a-z0-9-]+\.github\.io\/[a-z0-9._-]+\/?$/i,
  'release manifest does not contain a valid GitHub Pages URL');
let resumeProvenanceFile = null;
let resumeProvenance = null;
if (releaseManifest.resume) {
  assert.equal(releaseManifest.resume.evidence, 'evidence/resume-provenance.json',
    'release manifest points to an unexpected resume evidence path');
  assert.ok(Number(releaseManifest.resume.priorElapsedMs) > 0 &&
    Number(releaseManifest.resume.priorElapsedMs) < Number(releaseManifest.elapsedMs),
  'release resume duration is not included in the total measured time');
  resumeProvenanceFile = path.join(site, releaseManifest.resume.evidence);
  const resumeStat = fs.statSync(resumeProvenanceFile, { throwIfNoEntry: false });
  assert.ok(resumeStat?.isFile() && resumeStat.size > 0,
    'release resume provenance is missing or empty');
  required.push(releaseManifest.resume.evidence);
  resumeProvenance = JSON.parse(fs.readFileSync(resumeProvenanceFile, 'utf8'));
  assert.equal(resumeProvenance.schema, 'ds4.design.release-resume.v1',
    'invalid release resume provenance schema');
  assert.equal(resumeProvenance.caseId, caseId,
    'release resume provenance belongs to another benchmark case');
  assert.equal(Number(resumeProvenance.priorElapsedMs),
    Number(releaseManifest.resume.priorElapsedMs),
  'release manifest and resume provenance disagree on prior elapsed time');
  assert.deepEqual(resumeProvenance.checkpoint, releaseManifest.resume.checkpoint,
    'release manifest and resume provenance disagree on the checkpoint boundary');
  assert.match(String(resumeProvenance.sourceResumeSha256 || ''), /^[0-9a-f]{64}$/,
    'release resume provenance lacks the source resume SHA-256');
  assert.ok(Array.isArray(resumeProvenance.verifiedFiles) &&
    resumeProvenance.verifiedFiles.length > 0,
  'release resume provenance has no preserved files');
  for (const item of resumeProvenance.verifiedFiles) {
    const relative = String(item?.path || '');
    const absolute = path.resolve(site, relative);
    assert.ok(relative && !path.isAbsolute(relative) &&
      absolute.startsWith(`${site}${path.sep}`),
    `release resume provenance contains an unsafe path: ${relative}`);
    const stat = fs.statSync(absolute, { throwIfNoEntry: false });
    assert.ok(stat?.isFile(), `release resume preserved file is missing: ${relative}`);
    assert.equal(stat.size, Number(item.bytes),
      `release resume preserved file byte count changed: ${relative}`);
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex'),
      item.sha256, `release resume preserved file hash changed: ${relative}`);
  }
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(resumeProvenanceFile)).digest('hex'),
    releaseManifest.resume.sha256,
  'release resume provenance does not match its manifest SHA-256');
}
for (const relative of required.filter(item => !['.nojekyll', 'RELEASE_MANIFEST.json'].includes(item)))
  assert.ok(releaseManifest.files?.[relative], `release manifest does not cover ${relative}`);
for (const [relative, expected] of Object.entries(releaseManifest.files || {})) {
  const absolute = path.resolve(site, relative);
  assert.ok(absolute.startsWith(`${site}${path.sep}`), `manifest path escapes release: ${relative}`);
  const stat = fs.statSync(absolute, { throwIfNoEntry: false });
  assert.ok(stat?.isFile(), `manifest file is missing: ${relative}`);
  assert.equal(stat.size, Number(expected.bytes), `manifest byte count changed: ${relative}`);
  const actualHash = crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex');
  assert.equal(actualHash, expected.sha256, `manifest hash changed: ${relative}`);
}
const tracked = new Set(Object.keys(releaseManifest.files || {}).map(relative => path.resolve(site, relative)));
for (const file of allFiles) {
  if (['.nojekyll', 'RELEASE_MANIFEST.json'].includes(path.basename(file))) continue;
  assert.ok(tracked.has(file), `untracked release file: ${path.relative(site, file)}`);
}

const html = fs.readFileSync(releaseEntry, 'utf8');
const readme = fs.readFileSync(path.join(site, 'README.md'), 'utf8');
const mediaDocs = fs.readFileSync(path.join(site, 'MEDIA_AND_MODELS.md'), 'utf8');
const docs = `${readme}\n${mediaDocs}`;
const inference = JSON.parse(fs.readFileSync(
  path.join(site, 'evidence/inference-provenance.json'), 'utf8'));
const benchmarkEventsFile = path.join(site, 'evidence/benchmark-events.json');
const benchmarkQualityFile = path.join(site, 'evidence/benchmark-quality.json');
assert.equal(crypto.createHash('sha256').update(fs.readFileSync(benchmarkEventsFile)).digest('hex'),
  inference.sourceEvidence?.benchmarkEventsSha256,
  'original benchmark events do not match the inference sidecar');
assert.equal(crypto.createHash('sha256').update(fs.readFileSync(benchmarkQualityFile)).digest('hex'),
  inference.sourceEvidence?.benchmarkQualitySha256,
  'original benchmark quality report does not match the inference sidecar');
if (resumeProvenanceFile)
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(resumeProvenanceFile)).digest('hex'),
    inference.sourceEvidence?.resumeProvenanceSha256,
  'resume provenance does not match the inference sidecar');
const benchmarkQuality = JSON.parse(fs.readFileSync(benchmarkQualityFile, 'utf8'));
assert.equal(benchmarkQuality.pass, true, 'original benchmark quality report is not PASS');
assert.equal(benchmarkQuality.toolCompliance, true,
  'original benchmark quality report is not tool-compliant');
assert.deepEqual(benchmarkQuality.failed || [], [],
  'original benchmark quality report retains failures');
assert.equal(Number(benchmarkQuality.elapsedMs), Number(releaseManifest.elapsedMs),
  'benchmark quality report and release manifest disagree on elapsed time');
assert.equal(Boolean(benchmarkQuality.resumed), Boolean(resumeProvenance),
  'benchmark quality resume state was omitted from or invented by the release');
if (resumeProvenance) {
  assert.equal(Number(benchmarkQuality.resumed?.priorElapsedMs),
    Number(resumeProvenance.priorElapsedMs),
  'benchmark quality report and resume provenance disagree on prior elapsed time');
  assert.deepEqual(benchmarkQuality.resumed?.stopAfter, resumeProvenance.checkpoint,
    'benchmark quality report and resume provenance disagree on the checkpoint');
  assert.deepEqual(benchmarkQuality.resumed?.verifiedFiles, resumeProvenance.verifiedFiles,
    'benchmark quality report and resume provenance disagree on preserved files');
}
const benchmarkEvents = JSON.parse(fs.readFileSync(benchmarkEventsFile, 'utf8'));
const benchmarkCalls = benchmarkEvents.filter(event => event.type === 'tool_call');
const benchmarkResults = benchmarkEvents.filter(event => event.type === 'tool_result');
const benchmarkImageCalls = benchmarkCalls.filter(event => event.name === 'generate_image');
const benchmarkCorrespondenceCalls = benchmarkCalls.filter(event => event.name === 'see_image');
const benchmarkCorrespondenceResults = benchmarkResults.filter(event => event.name === 'see_image');
assert.equal(benchmarkImageCalls.length, 2,
  'original event trace does not contain exactly two image calls');
assert.equal(benchmarkCorrespondenceCalls.length, 2,
  'original event trace does not contain exactly two Qwen correspondence calls');
assert.equal(benchmarkImageCalls[0]?.input?.path, testCase.generatedImage,
  'original event trace has the wrong Ideogram source output path');
assert.ok(!String(benchmarkImageCalls[0]?.input?.source_path || '').trim(),
  'original event trace routed the first image call as an edit');
assert.equal(benchmarkImageCalls[1]?.input?.path, testCase.editedImage,
  'original event trace has the wrong Hunyuan edit output path');
assert.equal(benchmarkImageCalls[1]?.input?.source_path, testCase.generatedImage,
  'original event trace did not edit the exact Ideogram source asset');
assert.equal(benchmarkCorrespondenceCalls[0]?.input?.path, testCase.generatedImage,
  'original event trace inspected the wrong Ideogram asset with Qwen');
assert.equal(benchmarkCorrespondenceCalls[1]?.input?.path, testCase.editedImage,
  'original event trace inspected the wrong Hunyuan edit with Qwen');
assert.equal(benchmarkCorrespondenceResults.length, 2,
  'original event trace does not contain two terminal Qwen correspondence results');
for (const [index, expectedPath] of [testCase.generatedImage, testCase.editedImage].entries()) {
  const output = String(benchmarkCorrespondenceResults[index]?.output || '');
  assert.doesNotMatch(output, /^(?:Tool error:|see_image error)/i,
    `original Qwen correspondence ${index + 1} ended in an error`);
  assert.ok(output.startsWith(`[see_image: ${expectedPath}]\n`),
    `original Qwen correspondence ${index + 1} is not bound to ${expectedPath}`);
  assert.ok(output.length >= 200,
    `original Qwen correspondence ${index + 1} lacks substantive visible facts`);
}
const nativeVideoCalls = benchmarkCalls.filter(event => event.name === 'generate_video');
const nativeVideoResults = benchmarkResults.filter(event => event.name === 'generate_video');
const nativeVideoSuccesses = nativeVideoResults.filter(event =>
  /MiniMax H3 MP4 at quality profile/.test(event.output || ''));
const nativeVideoFailures = nativeVideoResults.filter(event => /^Tool error:/i.test(event.output || ''));
assert.equal(nativeVideoCalls.length, nativeVideoResults.length,
  'original event trace contains an H3 call without a result');
assert.ok(nativeVideoCalls.length >= 1 && nativeVideoCalls.length <= 2,
  'original event trace contains more than one failed H3 retry');
assert.equal(nativeVideoSuccesses.length, 1,
  'original event trace does not contain exactly one successful H3 result');
assert.equal(nativeVideoFailures.length, nativeVideoResults.length - 1,
  'original event trace contains a redundant H3 result');
for (const call of nativeVideoCalls) {
  assert.equal(call.input?.path, testCase.video,
    'original event trace has the wrong H3 output path');
  assert.equal(call.input?.first_frame, testCase.editedImage,
    'original event trace did not pass the exact Hunyuan edit to H3');
  assert.equal(Number(call.input?.duration), 5,
    'original event trace has the wrong H3 duration');
  assert.equal(call.input?.aspect, '16:9',
    'original event trace has the wrong H3 aspect');
  assert.ok(call.input?.license_accepted === true ||
    String(call.input?.license_accepted).toLowerCase() === 'true',
  'original event trace lacks explicit H3 license acceptance');
  assert.ok(String(call.input?.prompt || '').trim().length >= 80,
    'original event trace lacks a substantive H3 motion prompt');
}
const providerIndexes = {
  ideogram: benchmarkEvents.findIndex(event => event.type === 'tool_result' &&
    event.name === 'generate_image' && /Ideogram 4 Quality-48/.test(event.output || '')),
  hunyuan: benchmarkEvents.findIndex(event => event.type === 'tool_result' &&
    event.name === 'generate_image' && /HunyuanImage-3\.0-Instruct/.test(event.output || '')),
  h3: benchmarkEvents.findIndex(event => event === nativeVideoSuccesses[0]),
};
const correspondenceIndexes = benchmarkEvents.flatMap((event, index) =>
  event.type === 'tool_result' && event.name === 'see_image' ? [index] : []);
assert.equal(correspondenceIndexes.length, 2,
  'original event trace does not contain two terminal Qwen correspondence results');
assert.ok(providerIndexes.ideogram >= 0 &&
  providerIndexes.ideogram < correspondenceIndexes[0] &&
  correspondenceIndexes[0] < providerIndexes.hunyuan &&
  providerIndexes.hunyuan < correspondenceIndexes[1] &&
  correspondenceIndexes[1] < providerIndexes.h3,
  'original event trace is not serial Ideogram → Qwen → Hunyuan → Qwen → H3');
assert.equal(inference.schema, 'ds4.design.inference-provenance.v1',
  'invalid inference provenance schema');
assert.equal(inference.caseId, caseId, 'inference provenance case mismatch');
assert.equal(inference.profile, 'creative-full-stack', 'inference provenance profile mismatch');
assert.match(String(inference.model || ''), /DeepSeek-V4/i,
  'inference provenance does not identify DeepSeek V4');
assert.deepEqual(inference.launch, {
  contextTokens: 393216,
  thinking: 'max',
  designThinkingCap: 0,
  ssdStreaming: 'off',
  ssdStreamingEffective: false,
}, 'inference provenance does not prove Max/unbounded context with SSD streaming off');
assert.deepEqual(inference.modes, {
  image: 'real-qwen38-router-ideogram4-hunyuan3',
  vision: 'real-qwen3.8-27b-max',
  video: 'real-minimax-h3',
}, 'inference provenance contains a fallback or retired media mode');
assert.ok(['real-qwen38-router-ideogram4-hunyuan3', 'real-qwen']
  .includes(inference.sourceLabels?.imageMode),
  'inference provenance contains an unknown source image-mode label');
assert.deepEqual(inference.serialMedia?.order, [
  'Ideogram 4 Quality-48', 'Qwen3.8 correspondence',
  'HunyuanImage-3.0-Instruct', 'Qwen3.8 correspondence', 'MiniMax H3 Quality',
], 'inference provenance does not record the required serial media order');
assert.equal(inference.serialMedia?.imageCalls, 2,
  'inference provenance does not record exactly two image calls');
assert.equal(inference.serialMedia?.correspondenceCalls, 2,
  'inference provenance does not record exactly two Qwen correspondence calls');
assert.ok(Number(inference.serialMedia?.h3Calls) >= 1 &&
  Number(inference.serialMedia?.h3Calls) <= 2,
  'inference provenance records more than the requested H3 call plus one failed bug retry');
assert.equal(inference.serialMedia?.successfulH3Results, 1,
  'inference provenance must record exactly one successful H3 result');
assert.equal(inference.serialMedia?.failedH3Results,
  Number(inference.serialMedia?.h3Calls) - 1,
  'inference provenance contains a redundant H3 generation');

const evidenceHash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const qwenPreflightFile = path.join(site, 'evidence/qwen-vision-preflight.json');
const qwenPreflight = JSON.parse(fs.readFileSync(qwenPreflightFile, 'utf8'));
assert.equal(evidenceHash(qwenPreflightFile),
  inference.sourceEvidence?.qwenVisionPreflightSha256,
  'Qwen vision preflight bytes do not match the signed inference sidecar');
assert.deepEqual({
  ok: qwenPreflight.ok, supported: qwenPreflight.supported,
  oneShot: qwenPreflight.oneShot, installed: qwenPreflight.installed,
  state: qwenPreflight.state, pid: Number(qwenPreflight.pid), port: Number(qwenPreflight.port),
}, {
  ok: true, supported: true, oneShot: true, installed: true,
  state: 'ready', pid: 0, port: 0,
}, 'Qwen3.8 preflight does not prove a ready one-shot non-resident runtime');
assert.equal(qwenPreflight.hf, 'mlx-community/Qwen3.8-27B-8bit',
  'Qwen vision preflight identifies a fallback or retired model');
assert.match(String(qwenPreflight.revision || ''), /^[0-9a-f]{40}$/,
  'Qwen vision preflight revision is missing');
assert.deepEqual(inference.qwen, {
  model: qwenPreflight.hf,
  revision: qwenPreflight.revision,
  thinking: 'max',
  oneShot: true,
  successfulCorrespondenceResults: 2,
}, 'Qwen inference sidecar does not match the successful one-shot correspondence evidence');

const imageEvidenceFiles = {
  ideogramPipeline: path.join(site, 'evidence/ideogram-pipeline-provenance.json'),
  ideogramRoute: path.join(site, 'evidence/ideogram-route-provenance.json'),
  ideogramNative: path.join(site, 'evidence/ideogram-native-provenance.json'),
  hunyuanPipeline: path.join(site, 'evidence/hunyuan-pipeline-provenance.json'),
  hunyuanRoute: path.join(site, 'evidence/hunyuan-route-provenance.json'),
  hunyuanNative: path.join(site, 'evidence/hunyuan-native-provenance.json'),
  hunyuanReasoning: path.join(site, 'evidence/hunyuan-max-reasoning.json'),
};
const ideogramPipeline = JSON.parse(fs.readFileSync(imageEvidenceFiles.ideogramPipeline, 'utf8'));
const ideogramRoute = JSON.parse(fs.readFileSync(imageEvidenceFiles.ideogramRoute, 'utf8'));
const ideogramNative = JSON.parse(fs.readFileSync(imageEvidenceFiles.ideogramNative, 'utf8'));
const hunyuanPipeline = JSON.parse(fs.readFileSync(imageEvidenceFiles.hunyuanPipeline, 'utf8'));
const hunyuanRoute = JSON.parse(fs.readFileSync(imageEvidenceFiles.hunyuanRoute, 'utf8'));
const hunyuanNative = JSON.parse(fs.readFileSync(imageEvidenceFiles.hunyuanNative, 'utf8'));
const hunyuanReasoning = JSON.parse(fs.readFileSync(imageEvidenceFiles.hunyuanReasoning, 'utf8'));
for (const [kind, file, expected] of [
  ['Ideogram pipeline', imageEvidenceFiles.ideogramPipeline,
    inference.images?.ideogram?.pipelineProvenanceSha256],
  ['Ideogram route', imageEvidenceFiles.ideogramRoute,
    inference.images?.ideogram?.routeProvenanceSha256],
  ['Ideogram native', imageEvidenceFiles.ideogramNative,
    inference.images?.ideogram?.nativeProvenanceSha256],
  ['Hunyuan pipeline', imageEvidenceFiles.hunyuanPipeline,
    inference.images?.hunyuan?.pipelineProvenanceSha256],
  ['Hunyuan route', imageEvidenceFiles.hunyuanRoute,
    inference.images?.hunyuan?.routeProvenanceSha256],
  ['Hunyuan native', imageEvidenceFiles.hunyuanNative,
    inference.images?.hunyuan?.nativeProvenanceSha256],
  ['Hunyuan reasoning', imageEvidenceFiles.hunyuanReasoning,
    inference.images?.hunyuan?.reasoningArtifactSha256],
]) assert.equal(evidenceHash(file), expected, `${kind} bytes do not match the signed sidecar`);

const sourceHash = evidenceHash(sourceAsset);
const editedHash = evidenceHash(editedAsset);
assert.equal(inference.images?.ideogram?.outputSha256, sourceHash,
  'Ideogram job evidence does not match the released source PNG');
assert.equal(inference.images?.hunyuan?.sourceSha256, sourceHash,
  'Hunyuan job evidence is not bound to the released Ideogram PNG');
assert.equal(inference.images?.hunyuan?.outputSha256, editedHash,
  'Hunyuan job evidence does not match the released edited PNG');
assert.equal(ideogramPipeline.provider, 'ideogram4-fp8', 'Ideogram pipeline provider mismatch');
assert.equal(ideogramPipeline.serialized, true, 'Ideogram pipeline was not serialized');
assert.deepEqual(ideogramPipeline.router, {
  ...ideogramPipeline.router,
  model: qwenPreflight.hf, revision: qwenPreflight.revision,
  reasoning: 'max', decision: 'generate',
}, 'Ideogram pipeline router provenance is invalid');
assert.equal(ideogramRoute.router, qwenPreflight.hf, 'Ideogram route model mismatch');
assert.equal(ideogramRoute.revision, qwenPreflight.revision, 'Ideogram route revision mismatch');
assert.equal(ideogramRoute.reasoning, 'max', 'Ideogram route was not Max');
assert.equal(ideogramRoute.thinkingEnabled, true, 'Ideogram route disabled thinking');
assert.equal(ideogramRoute.thinkingBudget, null, 'Ideogram route imposed a thinking budget');
assert.equal(Number(ideogramRoute.nativeContext), 262144, 'Ideogram route context mismatch');
assert.equal(ideogramRoute.decision, 'generate', 'Ideogram route decision mismatch');
assert.deepEqual(ideogramRoute.sourceImages || [], [], 'Ideogram route unexpectedly used a source');
assert.equal(ideogramNative.provider, 'ideogram4-fp8', 'Ideogram native provider mismatch');
assert.equal(ideogramNative.model, 'Comfy-Org/Ideogram-4', 'Ideogram native model mismatch');
assert.equal(ideogramNative.revision, inference.images?.ideogram?.revision,
  'Ideogram native revision mismatch');
assert.deepEqual({
  profile: ideogramNative.quality?.profile, steps: ideogramNative.quality?.steps,
  sampler: ideogramNative.quality?.sampler, polishSteps: ideogramNative.quality?.polishSteps,
  vaeDecode: ideogramNative.quality?.vaeDecode,
}, {
  profile: 'V4_QUALITY_48', steps: 48, sampler: 'euler', polishSteps: 3,
  vaeDecode: 'overlapped-three-pass-tiled',
}, 'Ideogram native Quality-48 provenance is incomplete');
assert.deepEqual(ideogramNative.size, { width: 2048, height: 1152, aspect: '16:9' },
  'Ideogram native dimensions are invalid');
assert.equal(ideogramNative.outputValidation?.format, 'PNG', 'Ideogram output is not PNG');
assert.equal(ideogramNative.outputValidation?.mode, 'RGB', 'Ideogram output is not RGB');
assert.ok(Number(ideogramNative.outputValidation?.lumaEntropy) > 0 &&
  Number(ideogramNative.outputValidation?.significantLumaFraction) > 0.95,
  'Ideogram output validation reports an empty image');

assert.equal(hunyuanPipeline.provider, 'hunyuan-image3-instruct-nf4',
  'Hunyuan pipeline provider mismatch');
assert.equal(hunyuanPipeline.serialized, true, 'Hunyuan pipeline was not serialized');
assert.equal(hunyuanPipeline.router?.model, qwenPreflight.hf, 'Hunyuan router model mismatch');
assert.equal(hunyuanPipeline.router?.revision, qwenPreflight.revision,
  'Hunyuan router revision mismatch');
assert.equal(hunyuanPipeline.router?.reasoning, 'max', 'Hunyuan router was not Max');
assert.equal(hunyuanPipeline.router?.decision, 'edit', 'Hunyuan router decision mismatch');
assert.equal(hunyuanRoute.router, qwenPreflight.hf, 'Hunyuan route model mismatch');
assert.equal(hunyuanRoute.revision, qwenPreflight.revision, 'Hunyuan route revision mismatch');
assert.equal(hunyuanRoute.reasoning, 'max', 'Hunyuan route was not Max');
assert.equal(hunyuanRoute.thinkingEnabled, true, 'Hunyuan route disabled thinking');
assert.equal(hunyuanRoute.thinkingBudget, null, 'Hunyuan route imposed a thinking budget');
assert.equal(Number(hunyuanRoute.nativeContext), 262144, 'Hunyuan route context mismatch');
assert.equal(hunyuanRoute.decision, 'edit', 'Hunyuan route decision mismatch');
assert.deepEqual(hunyuanRoute.sourceImages, ['source.png'], 'Hunyuan route source mismatch');
assert.equal(hunyuanNative.provider, 'hunyuan-image3-instruct-nf4',
  'Hunyuan native provider mismatch');
assert.equal(hunyuanNative.model, 'EricRollei/HunyuanImage-3.0-Instruct-NF4-v2',
  'Hunyuan native model mismatch');
assert.equal(hunyuanNative.revision, inference.images?.hunyuan?.revision,
  'Hunyuan native revision mismatch');
assert.equal(hunyuanNative.baseRevision, inference.images?.hunyuan?.baseRevision,
  'Hunyuan native base revision mismatch');
assert.deepEqual(hunyuanNative.sourceImages, ['source.png'], 'Hunyuan native source mismatch');
assert.equal(hunyuanNative.quality?.profile, 'full-instruct-50',
  'Hunyuan profile is not full-instruct-50');
assert.equal(hunyuanNative.quality?.steps, 50, 'Hunyuan native step count is not 50');
assert.equal(hunyuanNative.quality?.maxNewTokens, null, 'Hunyuan reasoning is token-capped');
assert.equal(hunyuanNative.quality?.nativeContext, 22800, 'Hunyuan context mismatch');
assert.equal(hunyuanNative.quality?.nativeEagerMoELayers, 32, 'Hunyuan MoE layers incomplete');
assert.equal(hunyuanNative.quality?.customMoeKernel, false, 'Hunyuan used a custom MoE kernel');
assert.equal(hunyuanNative.quality?.dropsRoutedTokens, false, 'Hunyuan dropped routed tokens');
assert.equal(hunyuanNative.quality?.mpsRuntime?.nativeSdpa, true, 'Hunyuan did not use native SDPA');
assert.equal(hunyuanNative.quality?.mpsRuntime?.runtimeMonkeypatch, false,
  'Hunyuan used a runtime monkeypatch');
assert.equal(hunyuanReasoning.quality?.maxNewTokens, null,
  'Hunyuan bound reasoning artifact is token-capped');
assert.equal(hunyuanReasoning.quality?.nativeContext, 22800,
  'Hunyuan bound reasoning context mismatch');
const reasoningHash = crypto.createHash('sha256')
  .update(String(hunyuanReasoning.reasoning || '')).digest('hex');
assert.equal(reasoningHash, hunyuanReasoning.reasoningSha256,
  'Hunyuan bound reasoning transcript hash is invalid');
assert.equal(hunyuanNative.quality?.reasoningPhase?.sha256, reasoningHash,
  'Hunyuan diffusion did not reuse the bound Max reasoning artifact');
assert.equal(hunyuanReasoning.binding?.sourceImages?.[0]?.sha256, sourceHash,
  'Hunyuan bound reasoning is not tied to the released Ideogram asset');
assert.equal(hunyuanNative.outputValidation?.format, 'PNG', 'Hunyuan output is not PNG');
assert.equal(hunyuanNative.outputValidation?.mode, 'RGB', 'Hunyuan output is not RGB');
assert.ok(Number(hunyuanNative.outputValidation?.lumaEntropy) > 0 &&
  Number(hunyuanNative.outputValidation?.significantLumaFraction) > 0.95,
  'Hunyuan output validation reports an empty image');

const measuredHardware = inference.hardware || {};
for (const [label, value] of [
  ['platform', measuredHardware.platform], ['OS release', measuredHardware.release],
  ['architecture', measuredHardware.architecture],
  ['CPU/SoC', measuredHardware.appleChip || measuredHardware.cpu],
]) assert.ok(String(value || '').trim(), `inference provenance hardware ${label} is missing`);
assert.ok(Number(measuredHardware.logicalCpuCount) > 0,
  'inference provenance CPU core count is missing');
assert.ok(Number(measuredHardware.memoryGiB) > 0,
  'inference provenance memory capacity is missing');
assert.ok(Array.isArray(measuredHardware.displays) && measuredHardware.displays.length > 0 &&
  measuredHardware.displays.every(display => String(display?.chipset || '').trim()),
  'inference provenance GPU/Metal hardware is missing');

const videoSource = fs.readFileSync(path.join(root, 'src/dstudio_video.c'), 'utf8');
const runtimeDefine = name => {
  const match = videoSource.match(new RegExp(`^#define\\s+${name}\\s+\"([^\"]+)\"`, 'm'));
  assert.ok(match, `release gate cannot resolve runtime constant ${name}`);
  return match[1];
};
const expectedH3 = {
  engineCommit: runtimeDefine('H3_NATIVE_COMMIT'),
  patchFile: 'patch/h3-metal-watchdog/stage-command-submits.patch',
  patchSha256: runtimeDefine('H3_PATCH_SHA256'),
  modelRevision: runtimeDefine('H3_MODEL_REVISION'),
};
assert.deepEqual(Object.fromEntries(Object.entries(inference.h3 || {})
  .filter(([key]) => Object.hasOwn(expectedH3, key))), expectedH3,
  'release H3 provenance does not match the current managed runtime');
const patchHash = crypto.createHash('sha256').update(fs.readFileSync(
  path.join(root, expectedH3.patchFile))).digest('hex');
assert.equal(patchHash, expectedH3.patchSha256,
  'release H3 provenance points to patch bytes with a different SHA-256');
const nativeProvenanceFile = path.join(site, 'evidence/h3-native-provenance.json');
const nativeLogFile = path.join(site, 'evidence/h3-native.log');
const nativeH3 = JSON.parse(fs.readFileSync(nativeProvenanceFile, 'utf8'));
assert.equal(crypto.createHash('sha256').update(fs.readFileSync(videoAsset)).digest('hex'),
  inference.h3?.outputSha256,
  'release video bytes do not match the H3 job evidence');
assert.equal(crypto.createHash('sha256').update(fs.readFileSync(editedAsset)).digest('hex'),
  inference.h3?.firstFrameSha256,
  'Hunyuan edit bytes do not match the first frame used by H3');
assert.equal(crypto.createHash('sha256').update(fs.readFileSync(nativeProvenanceFile)).digest('hex'),
  inference.h3?.nativeProvenanceSha256,
  'native H3 provenance bytes do not match the signed inference sidecar');
assert.equal(crypto.createHash('sha256').update(fs.readFileSync(nativeLogFile)).digest('hex'),
  inference.h3?.nativeLogSha256,
  'native H3 log bytes do not match the signed inference sidecar');
assert.equal(nativeH3.provider, 'minimax-h3-native', 'native H3 provider is invalid');
assert.equal(nativeH3.model, 'MiniMaxAI/MiniMax-H3', 'native H3 model is invalid');
assert.equal(nativeH3.revision, expectedH3.modelRevision, 'native H3 model revision is invalid');
assert.equal(nativeH3.engine?.revision, expectedH3.engineCommit, 'native H3 engine commit is invalid');
assert.equal(nativeH3.engine?.patchSha256, expectedH3.patchSha256,
  'native H3 patch SHA-256 is invalid');
assert.deepEqual(nativeH3.quality,
  { profile: 'quality', steps: 20, transformerBlocks: 50, denoiserReuse: 1 },
  'native H3 provenance does not prove the complete Quality profile');
assert.equal(nativeH3.weightResidency, 'native-default',
  'native H3 provenance does not prove native-default residency');
assert.equal(String(nativeH3.commandBlocks), '1', 'native H3 commandBlocks is invalid');
assert.equal(String(nativeH3.stageSubmits), '1', 'native H3 stageSubmits is invalid');
assert.equal(String(nativeH3.sdpaQueryChunk), '8', 'native H3 SDPA query chunk is invalid');
assert.equal(nativeH3.metalCommandBufferErrors, 0,
  'native H3 provenance records a Metal command-buffer error');
assert.equal(nativeH3.firstFrame, 'first-frame.png',
  'native H3 provenance does not identify the edited first frame');
assert.deepEqual(nativeH3.referenceImages || [], [],
  'native H3 provenance contains unexpected reference images');
assert.equal(nativeH3.media?.fullyDecoded, true,
  'native H3 provenance does not prove a complete decode');
const nativeLog = fs.readFileSync(nativeLogFile, 'utf8');
assert.match(nativeLog, /denoise\s+20\/20/i,
  'native H3 log does not prove all denoise steps completed');
assert.doesNotMatch(nativeLog,
  /GPUCommandBufferCallbackError|Command Buffer execution failed|out of memory|Traceback|\bnan\b/i,
  'native H3 log contains a fatal inference signature');
for (const model of [
  'mlx-community/Qwen3.8-27B-8bit', 'Comfy-Org/Ideogram-4',
  'HunyuanImage-3.0-Instruct-NF4-v2', 'MiniMaxAI/MiniMax-H3',
]) assert.ok(docs.includes(model), `missing model provenance: ${model}`);
assert.ok(docs.includes(expectedH3.engineCommit), 'documentation omits the H3 engine commit');
assert.ok(docs.includes(expectedH3.patchSha256), 'documentation omits the H3 patch SHA-256');
assert.ok(docs.includes(expectedH3.modelRevision), 'documentation omits the H3 model revision');
assert.doesNotMatch(docs, /Qwen(?:2\.5|[- ]Image)/i,
  'retired Qwen Image/Qwen2.5 media path must not appear in the release');
assert.match(readme, /##\s+Hardware/i, 'README must report the benchmark hardware');
assert.match(readme, /(?:Generation time|Tempo di generazione)/i,
  'README must report the measured generation time');
const releaseDurationMs = Number(releaseManifest.elapsedMs);
const releaseTotalSeconds = Math.round(releaseDurationMs / 1000);
const releaseTimeText = `${Math.floor(releaseTotalSeconds / 3600)}h ${Math.floor(releaseTotalSeconds % 3600 / 60)}m ${releaseTotalSeconds % 60}s`;
assert.ok(readme.includes(releaseTimeText) &&
  readme.includes(releaseDurationMs.toLocaleString('en-US')),
'README generation time does not match the measured release duration');
for (const expectedHardwareLine of [
  `Platform: ${measuredHardware.platform} ${measuredHardware.release} (${measuredHardware.architecture})`,
  `CPU/SoC: ${measuredHardware.appleChip || measuredHardware.cpu}`,
  `Logical CPU cores: ${measuredHardware.logicalCpuCount}`,
  `Unified/system memory: ${measuredHardware.memoryGiB} GiB`,
]) assert.ok(readme.includes(expectedHardwareLine),
  `README hardware does not match measured evidence: ${expectedHardwareLine}`);
for (const display of measuredHardware.displays)
  assert.ok(readme.includes(String(display.chipset)),
    `README GPU/Metal does not match measured evidence: ${display.chipset}`);
if (resumeProvenance)
  assert.match(readme, /hash-verified resume provenance/i,
    'README must link the hash-verified resume provenance');
assert.match(readme, /393[,.]?216\s*(?:tokens|token)/i,
  'README must report the actual 393,216-token Design context');
assert.match(readme, /(?:Thinking|Reasoning)[^\n]*(?:Max|unlimited)|Max[^\n]*(?:Thinking|Reasoning)/i,
  'README must report Max, uncapped Design reasoning');
assert.match(readme, /SSD streaming[^\n]*off/i,
  'README must report DS4-only SSD streaming off');
assert.match(readme, /https:\/\/[a-z0-9-]+\.github\.io\/[a-z0-9._-]+\/?/i,
  'README must include the public GitHub Pages URL');
assert.ok(readme.includes(releaseManifest.pagesUrl),
  'README Pages URL does not match the release manifest');
assert.doesNotMatch(docs, /__[A-Z0-9_]+__/, 'unresolved documentation placeholder');
assert.doesNotMatch(html, /__[A-Z0-9_]+__/, 'unresolved HTML placeholder');

for (const text of testCase.requiredText || [])
  assert.ok(html.includes(text), `missing exact benchmark copy: ${text}`);
for (const structural of [/<header\b/i, /<main\b/i, /<footer\b/i, /<form\b/i, /<video\b/i])
  assert.match(html, structural, `missing semantic structure: ${structural}`);
assert.match(html, /class=["'][^"']*skip|skip-link/i, 'skip link missing');
assert.match(html, /aria-live/i, 'truthful local interaction status missing');
assert.match(html, /:focus-visible/i, 'visible keyboard focus CSS missing');
assert.match(html, /prefers-reduced-motion\s*:\s*reduce/i, 'reduced-motion CSS missing');
assert.match(html, /min-(?:height|width)\s*:\s*(?:44|4[5-9]|[5-9]\d)px/i,
  '44px interaction target rule missing');
assert.doesNotMatch(html, /lorem ipsum|placeholder text|your company|\bTBD\b|TODO|FIXME/i,
  'placeholder copy is not releasable');
assert.doesNotMatch(html,
  /<(?:script|img|source|video|audio|iframe)\b[^>]*\bsrc=["']https?:|<link\b[^>]*\bhref=["']https?:|@import\s+(?:url\()?\s*["']?https?:|url\(\s*["']?https?:/i,
  'remote runtime, font or media dependency');
assert.doesNotMatch(html, /javascript\s*:/i, 'javascript: URL is forbidden');

const videoTag = html.match(/<video\b[^>]*>/i)?.[0] || '';
for (const attribute of ['autoplay', 'muted', 'loop', 'playsinline'])
  assert.match(videoTag, new RegExp(`\\b${attribute}\\b`, 'i'), `video is missing ${attribute}`);
const escapedEdited = testCase.editedImage.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const escapedVideo = testCase.video.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
assert.match(videoTag, new RegExp(`\\bposter=["']${escapedEdited}["']`, 'i'),
  'H3 video must use the edited image as poster');
assert.match(html, new RegExp(`(?:<video\\b[^>]*\\bsrc=["']${escapedVideo}["']|<source\\b[^>]*\\bsrc=["']${escapedVideo}["'])`, 'i'),
  'page does not use the local H3 MP4');

const ids = [...html.matchAll(/\bid=["']([^"']+)["']/gi)].map(match => match[1]);
assert.equal(new Set(ids).size, ids.length, 'duplicate HTML id');
const idSet = new Set(ids);
for (const match of html.matchAll(/\bhref=["']#([^"']+)["']/gi))
  assert.ok(idSet.has(match[1]), `broken local target: #${match[1]}`);
for (const match of html.matchAll(/<img\b([^>]*)>/gi)) {
  const attrs = match[1];
  const decorative = /aria-hidden=["']true["']|role=["']presentation["']/i.test(attrs);
  const alt = attrs.match(/\balt=["']([^"']*)["']/i)?.[1];
  assert.ok(decorative || (alt && alt.trim().length >= 12), `non-specific image alt: ${match[0]}`);
}

function probe(file, entries) {
  const result = spawnSync('ffprobe', [
    '-v', 'error', '-show_entries', entries, '-of', 'json', file,
  ], { encoding: 'utf8', timeout: 60_000 });
  assert.equal(result.status, 0, result.stderr || `ffprobe failed: ${file}`);
  return JSON.parse(result.stdout);
}

for (const file of [sourceAsset, editedAsset]) {
  const media = probe(file, 'stream=codec_name,pix_fmt,width,height');
  const image = media.streams?.[0];
  assert.equal(image?.codec_name, 'png', `${path.basename(file)} is not a decoded PNG`);
  assert.ok(image.width >= 1000 && image.height >= 600, `${path.basename(file)} is below release resolution`);
  assert.ok(Math.abs(image.width / image.height - 16 / 9) < 0.03,
    `${path.basename(file)} is not the requested 16:9 asset`);
}

const videoMedia = probe(videoAsset,
  'stream=codec_name,pix_fmt,width,height:format=duration');
const video = videoMedia.streams?.find(stream => stream.codec_name);
assert.equal(video?.codec_name, 'h264', 'H3 release codec must be H.264');
assert.equal(video?.pix_fmt, 'yuv420p', 'H3 release pixel format must be yuv420p');
assert.equal(video?.width, 1344, 'H3 width must match the Quality profile');
assert.equal(video?.height, 768, 'H3 height must match the Quality profile');
assert.ok(Number(videoMedia.format?.duration) >= 4.5 && Number(videoMedia.format?.duration) <= 5.5,
  `H3 duration is ${videoMedia.format?.duration}s`);
const decode = spawnSync('ffmpeg', [
  '-v', 'error', '-nostdin', '-i', videoAsset, '-map', '0:v:0', '-f', 'null', '-',
], { encoding: 'utf8', timeout: 180_000 });
assert.equal(decode.status, 0, `full H3 decode failed: ${decode.stderr}`);

const mime = file => ({
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.mp4': 'video/mp4',
})[path.extname(file).toLowerCase()] || 'application/octet-stream';
const server = http.createServer((request, response) => {
  let pathname;
  try { pathname = decodeURIComponent(new URL(request.url || '/', 'http://127.0.0.1').pathname); }
  catch { response.writeHead(400).end('bad request'); return; }
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const absolute = path.resolve(site, relative);
  if (absolute !== site && !absolute.startsWith(`${site}${path.sep}`)) {
    response.writeHead(403).end('forbidden');
    return;
  }
  const stat = fs.statSync(absolute, { throwIfNoEntry: false });
  if (!stat?.isFile()) { response.writeHead(404).end('not found'); return; }
  response.writeHead(200, { 'Content-Type': mime(absolute), 'Content-Length': stat.size });
  fs.createReadStream(absolute).pipe(response);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
fs.rmSync(evidence, { recursive: true, force: true });
fs.mkdirSync(evidence, { recursive: true });

let browser;
const views = {};
try {
  try { browser = await chromium.launch(); }
  catch { browser = await chromium.launch({ channel: 'chrome' }); }
  for (const viewport of [
    { name: 'desktop', width: 1280, height: 900, isMobile: false },
    { name: 'mobile', width: 390, height: 844, isMobile: true },
  ]) {
    const context = await browser.newContext({ viewport, reducedMotion: 'no-preference' });
    const page = await context.newPage();
    const consoleErrors = [];
    const requestFailures = [];
    page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
    page.on('pageerror', error => consoleErrors.push(String(error)));
    page.on('requestfailed', request => requestFailures.push(`${request.url()} ${request.failure()?.errorText}`));
    await page.goto(origin, { waitUntil: 'networkidle' });
    const metrics = await page.evaluate(() => {
      const visible = element => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.visibility !== 'hidden' && style.display !== 'none' &&
          rect.width > 0 && rect.height > 0;
      };
      return {
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
        resources: performance.getEntriesByType('resource').map(entry => entry.name),
        unlabelled: [...document.querySelectorAll('button,input,select,textarea')]
          .filter(visible).filter(element => {
            const explicit = element.getAttribute('aria-label') ||
              element.getAttribute('aria-labelledby') || element.getAttribute('title');
            const native = element.labels?.length ||
              (element.tagName === 'BUTTON' && (element.textContent || '').trim());
            return !explicit && !native;
          }).map(element => ({
            tag: element.tagName, type: element.getAttribute('type') || '',
            name: element.getAttribute('name') || '',
          })),
        undersized: [...document.querySelectorAll('a[href],button,input,select,textarea,summary')]
          .filter(visible).map(element => {
            const rect = element.getBoundingClientRect();
            return {
              tag: element.tagName,
              text: (element.textContent || element.getAttribute('aria-label') || '').trim().slice(0, 80),
              width: rect.width, height: rect.height,
            };
          }).filter(item => item.width < 43.5 || item.height < 43.5),
      };
    });
    assert.equal(metrics.scrollWidth, metrics.clientWidth, `${viewport.name} horizontal overflow`);
    assert.ok(metrics.resources.every(resource => resource.startsWith(origin)),
      `${viewport.name} loaded a remote resource`);
    assert.deepEqual(metrics.unlabelled, [], `${viewport.name} has unlabelled controls`);
    assert.deepEqual(metrics.undersized, [], `${viewport.name} has undersized controls`);
    assert.deepEqual(consoleErrors, [], `${viewport.name} console errors`);
    assert.deepEqual(requestFailures, [], `${viewport.name} request failures`);

    await page.keyboard.press('Tab');
    const firstFocus = await page.evaluate(() => ({
      href: document.activeElement?.getAttribute('href'),
      outline: getComputedStyle(document.activeElement).outlineStyle,
      boxShadow: getComputedStyle(document.activeElement).boxShadow,
    }));
    assert.match(firstFocus.href || '', /^#/, `${viewport.name} first Tab does not reach the skip link`);
    assert.ok(firstFocus.outline !== 'none' || firstFocus.boxShadow !== 'none',
      `${viewport.name} skip-link focus is invisible`);

    const form = page.locator('form').first();
    await form.locator('input[required]').evaluateAll(elements => elements.forEach((element, index) => {
      if (element.type === 'email') element.value = 'visitor@example.test';
      else if (element.type === 'checkbox' || element.type === 'radio') element.checked = true;
      else element.value = `Visitor ${index + 1}`;
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
    }));
    await form.locator('select[required]').evaluateAll(elements => elements.forEach(element => {
      const option = [...element.options].find(item => item.value);
      if (option) element.value = option.value;
      element.dispatchEvent(new Event('change', { bubbles: true }));
    }));
    const beforeUrl = page.url();
    const liveBefore = await page.locator('[aria-live]').allTextContents();
    await form.locator('button[type="submit"],input[type="submit"]').first().click();
    try {
      await page.waitForFunction((before) => {
        const current = [...document.querySelectorAll('[aria-live]')]
          .map(element => (element.textContent || '').trim());
        return current.some((text, index) => text.length > 10 && text !== String(before[index] || '').trim());
      }, liveBefore, { timeout: 3000 });
    } catch {
      assert.fail(`${viewport.name} local form produced no new truthful visible status`);
    }
    assert.equal(page.url(), beforeUrl, `${viewport.name} local form navigated away`);
    const live = await page.locator('[aria-live]').allTextContents();
    assert.ok(live.some((text, index) => text.trim().length > 10 &&
      text.trim() !== String(liveBefore[index] || '').trim()),
    `${viewport.name} local form produced no new truthful visible status`);

    await page.screenshot({ path: path.join(evidence, `${viewport.name}.png`), fullPage: true });
    views[viewport.name] = { ...metrics, consoleErrors, requestFailures };
    await context.close();
  }

  const reduced = await browser.newContext({
    viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce',
  });
  const reducedPage = await reduced.newPage();
  await reducedPage.goto(origin, { waitUntil: 'networkidle' });
  await reducedPage.waitForTimeout(250);
  const motion = await reducedPage.locator('video').first().evaluate(element => ({
    paused: element.paused, autoplay: element.autoplay, currentTime: element.currentTime,
  }));
  assert.ok(motion.paused || !motion.autoplay,
    `reduced motion left the H3 video playing: ${JSON.stringify(motion)}`);
  await reduced.close();

  const chrome = findChrome();
  assert.ok(chrome, 'Chrome/Chromium is required for the interaction probe');
  const interactions = await probeInteractiveButtons(chrome, releaseEntry);
  assert.equal(interactions.available, true, interactions.error || 'interaction probe unavailable');
  assert.deepEqual(interactions.inert, [],
    `inert visible buttons: ${interactions.inert.map(item => item.label).join(', ')}`);

  const hashes = Object.fromEntries(required.filter(relative => relative !== '.nojekyll').map(relative => [
    relative,
    crypto.createHash('sha256').update(fs.readFileSync(path.join(site, relative))).digest('hex'),
  ]));
  const report = {
    ok: true, checkedAt: new Date().toISOString(), caseId, files: required,
    hashes, video: { ...video, duration: Number(videoMedia.format.duration) },
    fullVideoDecode: true, views, reducedMotion: motion, interactions,
  };
  fs.writeFileSync(path.join(evidence, 'release-gate.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ ok: true, caseId, evidence, video: report.video }, null, 2));
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}

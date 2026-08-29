#!/usr/bin/env node
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifactRoot = path.resolve(process.argv[2] || '');
const caseId = String(process.argv[3] || '').trim();
const destination = path.resolve(process.argv[4] || '');
const pagesUrl = String(process.argv[5] || '').trim();

if (!fs.statSync(artifactRoot, { throwIfNoEntry: false })?.isDirectory() ||
    !caseId || !process.argv[4] || !/^https:\/\/[a-z0-9-]+\.github\.io\/[a-z0-9._-]+\/?$/i.test(pagesUrl)) {
  console.error('usage: node scripts/package-design-release.mjs ARTIFACT_DIR CASE_ID OUT_DIR PAGES_URL');
  process.exit(2);
}
assert.equal(fs.lstatSync(destination, { throwIfNoEntry: false }), undefined,
  `release destination already exists; refusing to overwrite it: ${destination}`);

const cases = JSON.parse(fs.readFileSync(path.join(root, 'extension/design/bench/cases.json'), 'utf8')).cases;
const testCase = cases.find(item => item.id === caseId);
assert.ok(testCase?.fullStack, `unknown full-stack benchmark case: ${caseId}`);

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

const summary = readJson(path.join(artifactRoot, 'summary.json'));
const launch = readJson(path.join(artifactRoot, 'launch.json'));
const qwenVisionPreflightFile = path.join(artifactRoot, 'vision-preflight.json');
const qwenVisionPreflight = readJson(qwenVisionPreflightFile);
assert.deepEqual(summary.selectedCases, [caseId],
  'release packaging requires exactly the requested single benchmark');
assert.equal(summary.profile, 'creative-full-stack',
  'release packaging requires the creative full-stack benchmark profile');
assert.equal(summary.unbounded, true, 'benchmark was not run in unbounded mode');
assert.equal(summary.think, 'max', 'benchmark did not use Max thinking');
const canonicalImageMode = 'real-qwen38-router-ideogram4-hunyuan3';
assert.ok([canonicalImageMode, 'real-qwen'].includes(summary.imageMode),
  'benchmark summary contains an unknown or fallback image mode');
assert.equal(summary.videoMode, 'real-minimax-h3', 'benchmark did not use real MiniMax H3');
assert.equal(summary.visionMode, 'real-qwen3.8-27b-max', 'benchmark did not use real Qwen3.8 Max vision');
assert.equal(summary.passRate, 1, 'benchmark summary is not PASS 1/1');
assert.equal(summary.toolCompliance, 1, 'benchmark tool compliance is not 100%');
assert.equal(summary.safetyFailures, 0, 'benchmark contains a safety failure');
assert.equal(summary.ssdStreaming, 'off', 'benchmark did not request SSD streaming off');
assert.equal(summary.ssdStreamingEffective, false, 'SSD streaming was active during the DS4-only run');
assert.equal(Number(launch.ctx), 393216, 'benchmark context is not 393,216 tokens');
assert.equal(launch.think, 'max', 'launch did not request Max thinking');
assert.equal(Number(launch.designThinkTokens), 0, 'Design reasoning was capped');
assert.equal(launch.ssdStreaming, 'off', 'launch did not explicitly disable SSD streaming');
assert.match(String(summary.model || ''), /DeepSeek-V4/i,
  'benchmark summary does not identify the requested DeepSeek V4 model');
assert.equal(launch.gguf, summary.model,
  'launch GGUF does not match the model recorded by the benchmark summary');
assert.equal(qwenVisionPreflight.ok, true, 'Qwen3.8 vision preflight did not pass');
assert.equal(qwenVisionPreflight.supported, true, 'Qwen3.8 vision is not supported');
assert.equal(qwenVisionPreflight.oneShot, true, 'Qwen3.8 vision was not configured one-shot');
assert.equal(qwenVisionPreflight.installed, true, 'Qwen3.8 vision model was not installed');
assert.equal(qwenVisionPreflight.state, 'ready', 'Qwen3.8 vision was not ready before Design');
assert.equal(Number(qwenVisionPreflight.pid), 0,
  'Qwen3.8 vision was unexpectedly resident during the DS4-only preflight');
assert.equal(Number(qwenVisionPreflight.port), 0,
  'Qwen3.8 vision exposed a persistent port during the one-shot preflight');
assert.equal(qwenVisionPreflight.hf, 'mlx-community/Qwen3.8-27B-8bit',
  'vision preflight used a fallback or retired model');
assert.match(String(qwenVisionPreflight.revision || ''), /^[0-9a-f]{40}$/,
  'Qwen3.8 vision preflight revision is missing');

const hardware = summary.hardware || {};
assert.ok(String(hardware.platform || '').trim(), 'benchmark hardware platform is missing');
assert.ok(String(hardware.release || '').trim(), 'benchmark OS release is missing');
assert.ok(String(hardware.architecture || '').trim(), 'benchmark architecture is missing');
assert.ok(String(hardware.appleChip || hardware.cpu || '').trim(),
  'benchmark CPU/SoC is missing');
assert.ok(Number(hardware.logicalCpuCount) > 0, 'benchmark CPU core count is missing');
assert.ok(Number(hardware.memoryGiB) > 0, 'benchmark memory capacity is missing');
assert.ok(Array.isArray(hardware.displays) && hardware.displays.length > 0 &&
  hardware.displays.every(display => String(display?.chipset || '').trim()),
  'benchmark GPU/Metal hardware is missing');

const videoSource = fs.readFileSync(path.join(root, 'src/dstudio_video.c'), 'utf8');
function sourceDefine(name) {
  const match = videoSource.match(new RegExp(`^#define\\s+${name}\\s+\"([^\"]+)\"`, 'm'));
  assert.ok(match, `missing runtime constant: ${name}`);
  return match[1];
}
const h3EngineCommit = sourceDefine('H3_NATIVE_COMMIT');
const h3PatchSha256 = sourceDefine('H3_PATCH_SHA256');
const h3ModelRevision = sourceDefine('H3_MODEL_REVISION');
const h3PatchFile = path.join(root, 'patch/h3-metal-watchdog/stage-command-submits.patch');
const h3PatchActualSha256 = crypto.createHash('sha256')
  .update(fs.readFileSync(h3PatchFile)).digest('hex');
assert.equal(h3PatchActualSha256, h3PatchSha256,
  'the versioned H3 patch bytes do not match the runtime SHA-256');

const row = summary.cases?.find(item => item.id === caseId);
assert.equal(row?.pass, true, 'selected benchmark case is not PASS');
assert.equal(row?.toolCompliance, true, 'selected benchmark case failed tool compliance');
assert.deepEqual(row?.failed || [], [], 'selected benchmark retains failed checks');
const duration = Number(row?.elapsedMs);
assert.ok(duration > 0, 'measured benchmark time is missing');
const result = summary.resultPaths?.sites?.find(item => item.id === caseId);
assert.ok(result, 'benchmark result paths are missing');
const quality = readJson(path.join(artifactRoot, `${caseId}.quality.json`));
assert.equal(quality.pass, true, 'authoritative case quality report is not PASS');
assert.equal(quality.toolCompliance, true, 'authoritative case quality report is not tool-compliant');
assert.deepEqual(quality.failed || [], [], 'authoritative case quality report retains failures');
assert.equal(Number(quality.elapsedMs), duration,
  'benchmark summary and authoritative quality report disagree on elapsed time');
assert.deepEqual(quality.resumed || null, row.resumed || null,
  'benchmark summary and authoritative quality report disagree on resume evidence');

let resumeEvidence = null;
if (summary.resumed) {
  const resumeFile = path.join(artifactRoot, 'resume.json');
  assert.ok(fs.statSync(resumeFile, { throwIfNoEntry: false })?.isFile(),
    'resumed benchmark is missing resume.json evidence');
  const resume = readJson(resumeFile);
  const priorElapsedMs = Number(resume.priorElapsedMs);
  assert.equal(resume.schema, 'ds4.design.resume.v1', 'resume evidence schema is invalid');
  assert.equal(resume.caseId, caseId, 'resume evidence belongs to another benchmark case');
  assert.equal(summary.resumed.caseId, caseId,
    'benchmark summary resume evidence belongs to another case');
  assert.equal(Number(summary.resumed.priorElapsedMs), priorElapsedMs,
    'benchmark summary and resume evidence disagree on prior elapsed time');
  assert.equal(Number(row.resumed?.priorElapsedMs), priorElapsedMs,
    'case result and resume evidence disagree on prior elapsed time');
  assert.deepEqual(row.resumed?.stopAfter, resume.stopAfter,
    'case result and resume evidence disagree on the checkpoint boundary');
  assert.deepEqual(summary.resumed.verifiedFiles, resume.verifiedFiles,
    'benchmark summary and resume evidence disagree on preserved files');
  assert.deepEqual(row.resumed?.verifiedFiles, resume.verifiedFiles,
    'case result and resume evidence disagree on preserved files');
  assert.ok(Number.isFinite(priorElapsedMs) && priorElapsedMs > 0 && duration > priorElapsedMs,
    'logical benchmark time does not include the verified pre-interruption duration');
  assert.ok(Array.isArray(resume.verifiedFiles) && resume.verifiedFiles.length > 0,
    'resume evidence does not identify any hash-verified preserved file');
  const workspaceRoot = path.resolve(artifactRoot, 'workspace');
  for (const item of resume.verifiedFiles) {
    const relative = String(item?.path || '');
    const absolute = path.resolve(workspaceRoot, relative);
    assert.ok(relative && !path.isAbsolute(relative) &&
      absolute.startsWith(`${workspaceRoot}${path.sep}`),
    `resume evidence contains an unsafe preserved path: ${relative}`);
    const stat = fs.statSync(absolute, { throwIfNoEntry: false });
    assert.ok(stat?.isFile(), `resume preserved file is missing: ${relative}`);
    assert.equal(stat.size, Number(item.bytes),
      `resume preserved file byte count changed: ${relative}`);
    assert.equal(sha256(absolute), item.sha256,
      `resume preserved file hash changed: ${relative}`);
  }
  resumeEvidence = {
    schema: 'ds4.design.release-resume.v1',
    caseId,
    priorElapsedMs,
    checkpoint: resume.stopAfter,
    verifiedFiles: resume.verifiedFiles,
    sourceResumeSha256: sha256(resumeFile),
  };
}
const eventsFile = path.join(artifactRoot, `${caseId}.events.json`);
const events = readJson(eventsFile);
const toolCalls = events.filter(event => event.type === 'tool_call').map(event => event.name);
const imageCallEvents = events.filter(event =>
  event.type === 'tool_call' && event.name === 'generate_image');
const correspondenceCallEvents = events.filter(event =>
  event.type === 'tool_call' && event.name === 'see_image');
const correspondenceResultEvents = events.filter(event =>
  event.type === 'tool_result' && event.name === 'see_image');
assert.equal(toolCalls.filter(name => name === 'generate_image').length, 2,
  'release transcript must contain exactly the requested source and edit calls');
assert.equal(toolCalls.filter(name => name === 'see_image').length, 2,
  'release transcript must contain exactly two correspondence checks');
assert.equal(imageCallEvents[0]?.input?.path, testCase.generatedImage,
  'first image call did not target the requested Ideogram source path');
assert.ok(!String(imageCallEvents[0]?.input?.source_path || '').trim(),
  'first image call unexpectedly requested editing instead of generation');
assert.equal(imageCallEvents[1]?.input?.path, testCase.editedImage,
  'second image call did not target the requested Hunyuan edit path');
assert.equal(imageCallEvents[1]?.input?.source_path, testCase.generatedImage,
  'second image call did not edit the exact Ideogram source asset');
assert.equal(correspondenceCallEvents[0]?.input?.path, testCase.generatedImage,
  'first Qwen correspondence call did not inspect the Ideogram source asset');
assert.equal(correspondenceCallEvents[1]?.input?.path, testCase.editedImage,
  'second Qwen correspondence call did not inspect the Hunyuan edit');
assert.equal(correspondenceResultEvents.length, 2,
  'release transcript must contain exactly two terminal Qwen correspondence results');
for (const [index, expectedPath] of [testCase.generatedImage, testCase.editedImage].entries()) {
  const output = String(correspondenceResultEvents[index]?.output || '');
  assert.doesNotMatch(output, /^(?:Tool error:|see_image error)/i,
    `Qwen correspondence ${index + 1} ended in an error`);
  assert.ok(output.startsWith(`[see_image: ${expectedPath}]\n`),
    `Qwen correspondence ${index + 1} is not bound to ${expectedPath}`);
  assert.ok(output.length >= 200,
    `Qwen correspondence ${index + 1} did not return substantive visible facts`);
}
assert.ok(events.some(event => event.type === 'tool_result' && event.name === 'generate_image' &&
  /Ideogram 4 Quality-48/.test(event.output || '')), 'release transcript lacks successful Ideogram Quality-48 provenance');
assert.ok(events.some(event => event.type === 'tool_result' && event.name === 'generate_image' &&
  /HunyuanImage-3\.0-Instruct/.test(event.output || '')), 'release transcript lacks successful Hunyuan edit provenance');
const h3Calls = events.filter(event => event.type === 'tool_call' && event.name === 'generate_video');
const h3Results = events.filter(event => event.type === 'tool_result' && event.name === 'generate_video');
const successfulH3Results = h3Results.filter(event =>
  /MiniMax H3 MP4 at quality profile/.test(event.output || ''));
const failedH3Results = h3Results.filter(event => /^Tool error:/i.test(event.output || ''));
assert.equal(h3Calls.length, h3Results.length,
  'release transcript contains an H3 call without a terminal result');
assert.ok(h3Calls.length >= 1 && h3Calls.length <= 2,
  'release transcript permits only the requested H3 call and at most one failed bug retry');
assert.equal(successfulH3Results.length, 1,
  'release transcript must contain exactly one successful H3 Quality result');
assert.equal(failedH3Results.length, h3Results.length - 1,
  'every additional H3 result must be an explicit failed attempt, not a redundant generation');
for (const call of h3Calls) {
  assert.equal(call.input?.path, testCase.video,
    'H3 call did not target the requested local MP4 path');
  assert.equal(call.input?.first_frame, testCase.editedImage,
    'H3 call did not use the exact Hunyuan edit as first frame');
  assert.equal(Number(call.input?.duration), 5,
    'H3 call did not request the five-second benchmark duration');
  assert.equal(call.input?.aspect, '16:9',
    'H3 call did not request the benchmark 16:9 aspect');
  assert.ok(call.input?.license_accepted === true ||
    String(call.input?.license_accepted).toLowerCase() === 'true',
  'H3 call did not include explicit license acceptance');
  assert.ok(String(call.input?.prompt || '').trim().length >= 80,
    'H3 call does not retain a substantive motion prompt');
}

const ideogramResultIndex = events.findIndex(event => event.type === 'tool_result' &&
  event.name === 'generate_image' && /Ideogram 4 Quality-48/.test(event.output || ''));
const hunyuanResultIndex = events.findIndex(event => event.type === 'tool_result' &&
  event.name === 'generate_image' && /HunyuanImage-3\.0-Instruct/.test(event.output || ''));
const qwenResultIndexes = events.flatMap((event, index) =>
  event.type === 'tool_result' && event.name === 'see_image' ? [index] : []);
const h3ResultIndex = events.findIndex(event => event === successfulH3Results[0]);
assert.equal(qwenResultIndexes.length, 2,
  'release transcript must retain exactly two terminal Qwen correspondence results');
assert.ok(ideogramResultIndex >= 0 && ideogramResultIndex < qwenResultIndexes[0] &&
  qwenResultIndexes[0] < hunyuanResultIndex && hunyuanResultIndex < qwenResultIndexes[1] &&
  qwenResultIndexes[1] < h3ResultIndex,
  'media results were not completed serially as Ideogram → Qwen → Hunyuan → Qwen → H3');

const workspace = path.resolve(artifactRoot, 'workspace');
function workspaceFile(relative) {
  const absolute = path.resolve(workspace, relative);
  assert.ok(absolute.startsWith(`${workspace}${path.sep}`), `release path escapes workspace: ${relative}`);
  assert.ok(fs.statSync(absolute, { throwIfNoEntry: false })?.isFile(), `missing benchmark output: ${relative}`);
  return absolute;
}

const entry = workspaceFile(testCase.entry);
const media = [testCase.generatedImage, testCase.editedImage, testCase.video]
  .map(relative => ({ relative, absolute: workspaceFile(relative) }));

const imageEvidenceRoot = path.join(artifactRoot, 'diagnostics', 'image-native-evidence');
function isRegularFile(file) {
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  return Boolean(stat?.isFile() && !stat.isSymbolicLink());
}

function findNativeImageEvidence(assetFile, config) {
  assert.ok(fs.lstatSync(imageEvidenceRoot, { throwIfNoEntry: false })?.isDirectory(),
    `native image evidence directory is missing: ${imageEvidenceRoot}`);
  const expectedSize = fs.statSync(assetFile).size;
  const expectedHash = sha256(assetFile);
  const matches = [];
  for (const entry of fs.readdirSync(imageEvidenceRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const job = path.join(imageEvidenceRoot, entry.name);
    const pipelineFile = path.join(job, 'image-pipeline-provenance.json');
    const routeFile = path.join(job, 'image-route-provenance.json');
    const nativeFile = path.join(job, config.nativeFile);
    const statusFile = path.join(job, 'status.json');
    if (![pipelineFile, routeFile, nativeFile, statusFile].every(isRegularFile)) continue;
    const pipeline = readJson(pipelineFile);
    if (pipeline.provider !== config.provider) continue;
    for (const candidate of fs.readdirSync(job, { withFileTypes: true })) {
      if (!candidate.isFile() || candidate.isSymbolicLink() ||
          path.extname(candidate.name).toLowerCase() !== '.png') continue;
      const output = path.join(job, candidate.name);
      if (fs.statSync(output).size === expectedSize && sha256(output) === expectedHash) {
        matches.push({
          job, output, pipelineFile, routeFile, nativeFile, statusFile,
          pipeline, route: readJson(routeFile), native: readJson(nativeFile),
          status: readJson(statusFile),
        });
      }
    }
  }
  assert.equal(matches.length, 1,
    `expected exactly one ${config.provider} job matching the release PNG, found ${matches.length}`);
  const match = matches[0];
  const { pipeline, route, native, status } = match;
  assert.equal(pipeline.router?.model, qwenVisionPreflight.hf,
    `${config.provider} pipeline used a different Qwen router model`);
  assert.equal(pipeline.router?.revision, qwenVisionPreflight.revision,
    `${config.provider} pipeline used a different Qwen router revision`);
  assert.equal(pipeline.router?.reasoning, 'max',
    `${config.provider} pipeline did not use Qwen Max routing`);
  assert.equal(pipeline.router?.decision, config.decision,
    `${config.provider} pipeline recorded the wrong routing decision`);
  assert.equal(pipeline.serialized, true,
    `${config.provider} pipeline was not serialized`);
  assert.ok(Number(pipeline.elapsedSeconds) > 0,
    `${config.provider} pipeline elapsed time is missing`);
  assert.equal(route.router, qwenVisionPreflight.hf,
    `${config.provider} route provenance used a different Qwen model`);
  assert.equal(route.revision, qwenVisionPreflight.revision,
    `${config.provider} route provenance used a different Qwen revision`);
  assert.equal(route.reasoning, 'max',
    `${config.provider} route provenance did not use Max reasoning`);
  assert.equal(route.thinkingEnabled, true,
    `${config.provider} route provenance disabled thinking`);
  assert.equal(route.thinkingBudget, null,
    `${config.provider} route provenance imposed a thinking budget`);
  assert.equal(Number(route.nativeContext), 262144,
    `${config.provider} route provenance did not use native 262,144 context`);
  assert.equal(route.decision, config.decision,
    `${config.provider} route provenance recorded the wrong decision`);
  assert.deepEqual(route.sourceImages || [], config.decision === 'edit' ? ['source.png'] : [],
    `${config.provider} route provenance contains the wrong source-image set`);
  assert.equal(status.ok, true, `${config.provider} native job did not complete successfully`);
  assert.equal(status.state, 'complete', `${config.provider} native job is not terminal`);
  assert.equal(status.provider, config.provider, `${config.provider} status provider mismatch`);
  assert.equal(status.quality, config.statusQuality, `${config.provider} status quality mismatch`);
  assert.equal(native.provider, config.provider, `${config.provider} native provider mismatch`);
  assert.equal(native.model, config.model, `${config.provider} native model mismatch`);
  assert.match(String(native.revision || ''), /^[0-9a-f]{40}$/,
    `${config.provider} native revision is missing`);
  assert.ok(Number(native.elapsedSeconds) > 0,
    `${config.provider} native elapsed time is missing`);
  assert.equal(native.outputValidation?.format, 'PNG',
    `${config.provider} output validation format is not PNG`);
  assert.equal(native.outputValidation?.mode, 'RGB',
    `${config.provider} output validation mode is not RGB`);
  assert.equal(native.outputValidation?.width, config.width,
    `${config.provider} output validation width mismatch`);
  assert.equal(native.outputValidation?.height, config.height,
    `${config.provider} output validation height mismatch`);
  assert.ok(Number(native.outputValidation?.lumaEntropy) > 0,
    `${config.provider} output validation entropy is invalid`);
  assert.ok(Number(native.outputValidation?.significantLumaFraction) > 0.95,
    `${config.provider} output validation reports an empty image`);

  const promptFile = path.join(match.job, 'prompt.txt');
  assert.ok(isRegularFile(promptFile) && fs.statSync(promptFile).size > 0,
    `${config.provider} bound prompt is missing`);
  for (const artifactName of Object.values(route.responseArtifacts || {})) {
    assert.match(String(artifactName), /^[A-Za-z0-9._-]+$/,
      `${config.provider} route response artifact name is unsafe`);
    const responseFile = path.join(match.job, artifactName);
    assert.ok(isRegularFile(responseFile) && fs.statSync(responseFile).size > 0,
      `${config.provider} route response artifact is missing: ${artifactName}`);
  }

  let reasoningFile = null;
  if (config.decision === 'generate') {
    assert.equal(native.quality?.profile, 'V4_QUALITY_48',
      'Ideogram native profile is not Quality-48');
    assert.equal(native.quality?.steps, 48, 'Ideogram native step count is not 48');
    assert.equal(native.quality?.sampler, 'euler', 'Ideogram native sampler is not Euler');
    assert.equal(native.quality?.polishSteps, 3, 'Ideogram native polish pass is incomplete');
    assert.equal(native.quality?.vaeDecode, 'overlapped-three-pass-tiled',
      'Ideogram native VAE decode path is not the validated quality path');
    assert.deepEqual(native.size, { width: 2048, height: 1152, aspect: '16:9' },
      'Ideogram native dimensions are not the requested 16:9 release size');
    assert.equal(route.wroteIdeogramCaption, true,
      'Ideogram route did not retain the Qwen caption artifact');
  } else {
    const sourceFile = path.join(match.job, 'source.png');
    assert.ok(isRegularFile(sourceFile), 'Hunyuan native source image is missing');
    assert.equal(fs.statSync(sourceFile).size, fs.statSync(config.sourceAsset).size,
      'Hunyuan native source byte count differs from the Ideogram asset');
    assert.equal(sha256(sourceFile), sha256(config.sourceAsset),
      'Hunyuan native source bytes differ from the Ideogram asset');
    assert.deepEqual(native.sourceImages, ['source.png'],
      'Hunyuan native provenance has the wrong source-image set');
    assert.equal(native.quality?.profile, 'full-instruct-50',
      'Hunyuan native profile is not full-instruct-50');
    assert.equal(native.quality?.steps, 50, 'Hunyuan native step count is not 50');
    assert.equal(native.quality?.maxNewTokens, null,
      'Hunyuan native reasoning has an application token cap');
    assert.equal(native.quality?.nativeContext, 22800,
      'Hunyuan native context differs from the model context');
    assert.equal(native.quality?.nativeEagerMoELayers, 32,
      'Hunyuan native eager MoE layer count is incomplete');
    assert.equal(native.quality?.customMoeKernel, false,
      'Hunyuan native provenance used a custom MoE kernel');
    assert.equal(native.quality?.dropsRoutedTokens, false,
      'Hunyuan native provenance dropped routed tokens');
    assert.equal(native.quality?.mpsRuntime?.nativeSdpa, true,
      'Hunyuan native provenance did not use native SDPA');
    assert.equal(native.quality?.mpsRuntime?.runtimeMonkeypatch, false,
      'Hunyuan native provenance used a runtime monkeypatch');
    assert.equal(native.quality?.mpsRuntime?.customAttentionKernel, false,
      'Hunyuan native provenance used a custom attention kernel');
    assert.equal(native.quality?.mpsRuntime?.customMoeKernel, false,
      'Hunyuan native provenance used a custom MoE kernel');
    reasoningFile = path.join(match.job, 'hunyuan-max-reasoning.json');
    assert.ok(isRegularFile(reasoningFile), 'Hunyuan Max reasoning artifact is missing');
    const reasoning = readJson(reasoningFile);
    assert.equal(reasoning.quality?.maxNewTokens, null,
      'Hunyuan bound reasoning artifact has an application token cap');
    assert.equal(reasoning.quality?.nativeContext, 22800,
      'Hunyuan bound reasoning artifact has the wrong context');
    assert.equal(reasoning.binding?.prompt?.sha256, sha256(promptFile),
      'Hunyuan reasoning artifact is not bound to the job prompt');
    assert.equal(reasoning.binding?.sourceImages?.[0]?.sha256, sha256(config.sourceAsset),
      'Hunyuan reasoning artifact is not bound to the Ideogram source');
    const reasoningHash = crypto.createHash('sha256')
      .update(String(reasoning.reasoning || '')).digest('hex');
    assert.equal(reasoningHash, reasoning.reasoningSha256,
      'Hunyuan reasoning transcript hash is invalid');
    assert.equal(native.quality?.reasoningPhase?.sha256, reasoning.reasoningSha256,
      'Hunyuan diffusion did not reuse the bound Max reasoning artifact');
  }
  return { ...match, outputSha256: expectedHash, promptFile, reasoningFile };
}

const ideogramEvidence = findNativeImageEvidence(
  media.find(item => item.relative === testCase.generatedImage).absolute,
  {
    provider: 'ideogram4-fp8', decision: 'generate', nativeFile: 'ideogram4-provenance.json',
    model: 'Comfy-Org/Ideogram-4', statusQuality: 'quality-48', width: 2048, height: 1152,
  },
);
const hunyuanEvidence = findNativeImageEvidence(
  media.find(item => item.relative === testCase.editedImage).absolute,
  {
    provider: 'hunyuan-image3-instruct-nf4', decision: 'edit',
    nativeFile: 'hunyuan-image3-provenance.json',
    model: 'EricRollei/HunyuanImage-3.0-Instruct-NF4-v2',
    statusQuality: 'full-50', width: 1280, height: 720,
    sourceAsset: media.find(item => item.relative === testCase.generatedImage).absolute,
  },
);

function findNativeH3Evidence(videoFile, expectedFirstFrame) {
  const runtime = path.resolve(process.env.DSTUDIO_H3_HOME ||
    path.join(os.homedir(), '.dstudio/minimax-h3'));
  const jobs = path.join(runtime, 'jobs');
  assert.ok(fs.statSync(jobs, { throwIfNoEntry: false })?.isDirectory(),
    `MiniMax H3 job evidence directory is missing: ${jobs}`);
  const expectedSize = fs.statSync(videoFile).size;
  const expectedHash = sha256(videoFile);
  const matches = [];
  for (const entry of fs.readdirSync(jobs, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const job = path.join(jobs, entry.name);
    const provenanceFile = path.join(job, 'h3-provenance.json');
    if (!fs.statSync(provenanceFile, { throwIfNoEntry: false })?.isFile() ||
        fs.lstatSync(provenanceFile).isSymbolicLink()) continue;
    for (const candidate of fs.readdirSync(job, { withFileTypes: true })) {
      if (!candidate.isFile() || candidate.isSymbolicLink() ||
          path.extname(candidate.name).toLowerCase() !== '.mp4') continue;
      const output = path.join(job, candidate.name);
      if (fs.statSync(output).size !== expectedSize || sha256(output) !== expectedHash) continue;
      const provenance = readJson(provenanceFile);
      const nativeLogName = String(provenance.nativeLog || '');
      assert.match(nativeLogName, /^[A-Za-z0-9._-]+\.log$/,
        `unsafe native H3 log name in ${provenanceFile}`);
      const nativeLog = path.join(job, nativeLogName);
      assert.ok(fs.statSync(nativeLog, { throwIfNoEntry: false })?.isFile() &&
        !fs.lstatSync(nativeLog).isSymbolicLink(),
      `native H3 log is missing for matching job ${entry.name}`);
      matches.push({ job, output, provenanceFile, provenance, nativeLog });
    }
  }
  assert.equal(matches.length, 1,
    `expected exactly one native H3 job matching the release MP4, found ${matches.length}`);
  const match = matches[0];
  const native = match.provenance;
  assert.equal(native.provider, 'minimax-h3-native', 'matching H3 job has the wrong provider');
  assert.equal(native.model, 'MiniMaxAI/MiniMax-H3', 'matching H3 job has the wrong model');
  assert.equal(native.revision, h3ModelRevision, 'matching H3 job has the wrong model revision');
  assert.equal(native.engine?.revision, h3EngineCommit, 'matching H3 job has the wrong engine commit');
  assert.equal(native.engine?.patchSha256, h3PatchSha256,
    'matching H3 job has the wrong Metal patch SHA-256');
  assert.deepEqual(native.quality, {
    profile: 'quality', steps: 20, transformerBlocks: 50, denoiserReuse: 1,
  }, 'matching H3 job did not use the complete Quality profile');
  assert.equal(native.weightResidency, 'native-default',
    'matching H3 job did not use native-default weight residency');
  assert.equal(String(native.commandBlocks), '1',
    'matching H3 job did not use one DiT command block per submit');
  assert.equal(String(native.stageSubmits), '1',
    'matching H3 job did not use staged command submits');
  assert.equal(String(native.sdpaQueryChunk), '8',
    'matching H3 job did not use the validated SDPA query chunk');
  assert.equal(native.metalCommandBufferErrors, 0,
    'matching H3 job recorded a Metal command-buffer error');
  assert.equal(native.powerAssertion, 'caffeinate-idle-system-sleep',
    'matching H3 job did not retain the idle-sleep assertion');
  assert.equal(native.durationRequestedSeconds, 5,
    'matching H3 job did not request the benchmark duration');
  assert.equal(native.aspect, '16:9', 'matching H3 job did not request 16:9');
  assert.equal(native.firstFrame, 'first-frame.png',
    'matching H3 job did not use the edited first frame');
  assert.deepEqual(native.referenceImages || [], [],
    'matching H3 job unexpectedly used additional reference images');
  const firstFrame = path.join(match.job, native.firstFrame);
  const firstFrameStat = fs.statSync(firstFrame, { throwIfNoEntry: false });
  assert.ok(firstFrameStat?.isFile() && !fs.lstatSync(firstFrame).isSymbolicLink(),
    'matching H3 job first frame is missing or is a symlink');
  const expectedFirstFrameStat = fs.statSync(expectedFirstFrame);
  const expectedFirstFrameHash = sha256(expectedFirstFrame);
  assert.equal(firstFrameStat.size, expectedFirstFrameStat.size,
    'matching H3 job first frame byte count differs from the Hunyuan edit');
  assert.equal(sha256(firstFrame), expectedFirstFrameHash,
    'matching H3 job first frame bytes differ from the Hunyuan edit');
  assert.equal(native.media?.codec, 'h264', 'matching H3 job provenance codec is not H.264');
  assert.equal(native.media?.pixelFormat, 'yuv420p',
    'matching H3 job provenance pixel format is not yuv420p');
  assert.equal(native.media?.width, 1344, 'matching H3 job provenance width is not Quality');
  assert.equal(native.media?.height, 768, 'matching H3 job provenance height is not Quality');
  assert.equal(native.media?.fullyDecoded, true,
    'matching H3 job did not fully decode its output');
  assert.ok(Number(native.media?.durationSeconds) >= 4.5 &&
    Number(native.media?.durationSeconds) <= 5.5,
  'matching H3 job provenance duration is invalid');
  assert.ok(Number(native.elapsedSeconds) > 0, 'matching H3 job elapsed time is missing');
  const nativeLog = fs.readFileSync(match.nativeLog, 'utf8');
  assert.match(nativeLog, /denoise\s+20\/20/i,
    'matching H3 native log does not prove all denoise steps completed');
  assert.doesNotMatch(nativeLog,
    /GPUCommandBufferCallbackError|Command Buffer execution failed|out of memory|Traceback|\bnan\b/i,
  'matching H3 native log contains a fatal inference signature');
  return { ...match, videoSha256: expectedHash, firstFrameSha256: expectedFirstFrameHash };
}

const h3Evidence = findNativeH3Evidence(
  media.find(item => item.relative === testCase.video).absolute,
  media.find(item => item.relative === testCase.editedImage).absolute,
);
const parent = path.dirname(destination);
fs.mkdirSync(parent, { recursive: true });
const staging = path.join(parent, `.${path.basename(destination)}.staging-${process.pid}`);
assert.equal(fs.lstatSync(staging, { throwIfNoEntry: false }), undefined,
  `staging path already exists: ${staging}`);
fs.mkdirSync(staging);

const totalSeconds = Math.round(duration / 1000);
const timeText = `${Math.floor(totalSeconds / 3600)}h ${Math.floor(totalSeconds % 3600 / 60)}m ${totalSeconds % 60}s`;
const gpu = (hardware.displays || []).map(item =>
  [item.chipset, item.cores ? `${item.cores} GPU cores` : '', item.metal || ''].filter(Boolean).join(' · '),
).join('; ') || 'not reported';
const title = testCase.requiredText?.[0] || caseId;

try {
  fs.copyFileSync(entry, path.join(staging, 'index.html'));
  fs.copyFileSync(entry, path.join(staging, path.basename(testCase.entry)));
  for (const item of media) {
    const output = path.join(staging, item.relative);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.copyFileSync(item.absolute, output);
  }
  fs.writeFileSync(path.join(staging, '.nojekyll'), '');

  const evidenceDir = path.join(staging, 'evidence');
  fs.mkdirSync(evidenceDir);
  for (const [source, name] of [
    [path.join(artifactRoot, `${caseId}.desktop.png`), 'desktop.png'],
    [path.join(artifactRoot, `${caseId}.mobile.png`), 'mobile.png'],
    [path.join(artifactRoot, `${caseId}.quality.json`), 'benchmark-quality.json'],
    [eventsFile, 'benchmark-events.json'],
    [qwenVisionPreflightFile, 'qwen-vision-preflight.json'],
  ]) {
    assert.ok(fs.statSync(source, { throwIfNoEntry: false })?.isFile(), `missing benchmark evidence: ${source}`);
    fs.copyFileSync(source, path.join(evidenceDir, name));
  }
  for (const [source, name] of [
    [ideogramEvidence.pipelineFile, 'ideogram-pipeline-provenance.json'],
    [ideogramEvidence.routeFile, 'ideogram-route-provenance.json'],
    [ideogramEvidence.nativeFile, 'ideogram-native-provenance.json'],
    [hunyuanEvidence.pipelineFile, 'hunyuan-pipeline-provenance.json'],
    [hunyuanEvidence.routeFile, 'hunyuan-route-provenance.json'],
    [hunyuanEvidence.nativeFile, 'hunyuan-native-provenance.json'],
    [hunyuanEvidence.reasoningFile, 'hunyuan-max-reasoning.json'],
  ]) fs.copyFileSync(source, path.join(evidenceDir, name));
  fs.copyFileSync(h3Evidence.provenanceFile,
    path.join(evidenceDir, 'h3-native-provenance.json'));
  fs.copyFileSync(h3Evidence.nativeLog, path.join(evidenceDir, 'h3-native.log'));
  const resumeEvidenceFile = path.join(evidenceDir, 'resume-provenance.json');
  if (resumeEvidence)
    fs.writeFileSync(resumeEvidenceFile, `${JSON.stringify(resumeEvidence, null, 2)}\n`);

  const readme = [
    `# ${title}`, '',
    `Live site: ${pagesUrl}`, '',
    `Benchmark: **${caseId} — PASS**`, '',
    '## Hardware', '',
    `- Platform: ${hardware.platform || 'unknown'} ${hardware.release || ''} (${hardware.architecture || 'unknown'})`,
    `- CPU/SoC: ${hardware.appleChip || hardware.cpu || 'unknown'}`,
    `- Logical CPU cores: ${hardware.logicalCpuCount || 'unknown'}`,
    `- Unified/system memory: ${hardware.memoryGiB || 'unknown'} GiB`,
    `- GPU/Metal: ${gpu}`, '',
    '## Generation time', '',
    `Measured end-to-end logical benchmark time: **${timeText}** (${duration.toLocaleString('en-US')} ms).`,
    summary.resumed ? 'This total includes the hash-verified pre-interruption work and the resumed run after core bug fixes.' : '', '',
    '## Inference configuration', '',
    `- DS4 model: ${summary.model}`,
    '- Context: 393,216 tokens',
    '- Thinking: Max; Design reasoning: unlimited (no application token cap)',
    '- DS4-only SSD streaming: off',
    '- Image routing/review: Qwen3.8-27B Q8, Max',
    `- Qwen3.8 revision: \`${qwenVisionPreflight.revision}\``,
    '- New image: Ideogram 4, Quality-48',
    `- Ideogram revision: \`${ideogramEvidence.native.revision}\``,
    '- Image edit: HunyuanImage 3 Instruct, full-quality NF4/BF16 compute',
    `- Hunyuan edit revision: \`${hunyuanEvidence.native.revision}\``,
    `- Hunyuan base revision: \`${hunyuanEvidence.native.baseRevision}\``,
    '- Video: MiniMax H3, Quality 1344×768, 5 seconds, 20 steps, 50 layers', '',
    `- H3 engine commit: \`${h3EngineCommit}\``,
    `- H3 Metal patch SHA-256: \`${h3PatchSha256}\``,
    `- H3 model revision: \`${h3ModelRevision}\``, '',
    '## Verification evidence', '',
    '- [Desktop render](evidence/desktop.png)',
    '- [Mobile render](evidence/mobile.png)',
    '- [Benchmark quality report](evidence/benchmark-quality.json)',
    '- [Original benchmark tool events](evidence/benchmark-events.json)',
    resumeEvidence ? '- [Hash-verified resume provenance](evidence/resume-provenance.json)' : undefined,
    '- [Qwen3.8 vision preflight](evidence/qwen-vision-preflight.json)',
    '- [Ideogram pipeline provenance](evidence/ideogram-pipeline-provenance.json)',
    '- [Ideogram native provenance](evidence/ideogram-native-provenance.json)',
    '- [Hunyuan pipeline provenance](evidence/hunyuan-pipeline-provenance.json)',
    '- [Hunyuan native provenance](evidence/hunyuan-native-provenance.json)',
    '- [Hunyuan Max reasoning artifact](evidence/hunyuan-max-reasoning.json)',
    '- [Inference provenance](evidence/inference-provenance.json)',
    '- [Native H3 job provenance](evidence/h3-native-provenance.json)',
    '- [Native H3 inference log](evidence/h3-native.log)',
    '- Local release gate: full MP4 decode, local-only dependencies, responsive browser checks, keyboard/focus, reduced motion and interaction probe.', '',
    '## Media', '',
    `- Ideogram source: \`${testCase.generatedImage}\``,
    `- Hunyuan edit / H3 poster: \`${testCase.editedImage}\``,
    `- MiniMax H3 video: \`${testCase.video}\``, '',
  ].filter(line => line !== undefined).join('\n');
  fs.writeFileSync(path.join(staging, 'README.md'), `${readme}\n`);

  const mediaDocs = [
    '# Media and model provenance', '',
    'All media was generated locally and used serially; heavyweight models were never resident together.', '',
    '## Models', '',
    '- `mlx-community/Qwen3.8-27B-8bit` — Max visual correspondence and edit-vs-generate routing; no asset quality gate.',
    `  - Revision: \`${qwenVisionPreflight.revision}\``,
    '- `Comfy-Org/Ideogram-4` — FP8 new-image generation at Quality-48.',
    `  - Revision: \`${ideogramEvidence.native.revision}\``,
    '- `HunyuanImage-3.0-Instruct-NF4-v2` — instructed image editing with BF16 compute.',
    `  - Revision: \`${hunyuanEvidence.native.revision}\``,
    `  - Base revision: \`${hunyuanEvidence.native.baseRevision}\``,
    '- `MiniMaxAI/MiniMax-H3` — local high-quality video generation through the versioned h3.c Metal patch.',
    `  - Engine commit: \`${h3EngineCommit}\``,
    `  - Patch: \`patch/h3-metal-watchdog/stage-command-submits.patch\``,
    `  - Patch SHA-256: \`${h3PatchSha256}\``,
    `  - Model revision: \`${h3ModelRevision}\``, '',
    '## Output hashes', '',
    ...media.map(item => `- \`${item.relative}\` — SHA-256 \`${sha256(item.absolute)}\``), '',
  ].join('\n');
  fs.writeFileSync(path.join(staging, 'MEDIA_AND_MODELS.md'), mediaDocs);

  const inferenceProvenance = {
    schema: 'ds4.design.inference-provenance.v1',
    caseId,
    profile: summary.profile,
    model: summary.model,
    launch: {
      contextTokens: Number(launch.ctx),
      thinking: launch.think,
      designThinkingCap: Number(launch.designThinkTokens),
      ssdStreaming: launch.ssdStreaming,
      ssdStreamingEffective: summary.ssdStreamingEffective,
    },
    modes: {
      image: canonicalImageMode,
      vision: summary.visionMode,
      video: summary.videoMode,
    },
    sourceLabels: { imageMode: summary.imageMode },
    sourceEvidence: {
      benchmarkEventsSha256: sha256(eventsFile),
      benchmarkQualitySha256: sha256(path.join(artifactRoot, `${caseId}.quality.json`)),
      qwenVisionPreflightSha256: sha256(qwenVisionPreflightFile),
      ...(resumeEvidence ? { resumeProvenanceSha256: sha256(resumeEvidenceFile) } : {}),
    },
    qwen: {
      model: qwenVisionPreflight.hf,
      revision: qwenVisionPreflight.revision,
      thinking: 'max',
      oneShot: true,
      successfulCorrespondenceResults: correspondenceResultEvents.length,
    },
    images: {
      ideogram: {
        provider: ideogramEvidence.native.provider,
        model: ideogramEvidence.native.model,
        revision: ideogramEvidence.native.revision,
        outputSha256: ideogramEvidence.outputSha256,
        pipelineProvenanceSha256: sha256(ideogramEvidence.pipelineFile),
        routeProvenanceSha256: sha256(ideogramEvidence.routeFile),
        nativeProvenanceSha256: sha256(ideogramEvidence.nativeFile),
      },
      hunyuan: {
        provider: hunyuanEvidence.native.provider,
        model: hunyuanEvidence.native.model,
        revision: hunyuanEvidence.native.revision,
        baseModel: hunyuanEvidence.native.baseModel,
        baseRevision: hunyuanEvidence.native.baseRevision,
        sourceSha256: ideogramEvidence.outputSha256,
        outputSha256: hunyuanEvidence.outputSha256,
        pipelineProvenanceSha256: sha256(hunyuanEvidence.pipelineFile),
        routeProvenanceSha256: sha256(hunyuanEvidence.routeFile),
        nativeProvenanceSha256: sha256(hunyuanEvidence.nativeFile),
        reasoningArtifactSha256: sha256(hunyuanEvidence.reasoningFile),
      },
    },
    serialMedia: {
      order: ['Ideogram 4 Quality-48', 'Qwen3.8 correspondence',
        'HunyuanImage-3.0-Instruct', 'Qwen3.8 correspondence', 'MiniMax H3 Quality'],
      imageCalls: toolCalls.filter(name => name === 'generate_image').length,
      correspondenceCalls: toolCalls.filter(name => name === 'see_image').length,
      h3Calls: h3Calls.length,
      successfulH3Results: successfulH3Results.length,
      failedH3Results: failedH3Results.length,
    },
    h3: {
      engineCommit: h3EngineCommit,
      patchFile: 'patch/h3-metal-watchdog/stage-command-submits.patch',
      patchSha256: h3PatchSha256,
      modelRevision: h3ModelRevision,
      outputSha256: h3Evidence.videoSha256,
      firstFrameSha256: h3Evidence.firstFrameSha256,
      nativeProvenanceSha256: sha256(h3Evidence.provenanceFile),
      nativeLogSha256: sha256(h3Evidence.nativeLog),
    },
    hardware,
  };
  fs.writeFileSync(path.join(evidenceDir, 'inference-provenance.json'),
    `${JSON.stringify(inferenceProvenance, null, 2)}\n`);

  const releaseFiles = [
    'index.html', path.basename(testCase.entry), 'README.md', 'MEDIA_AND_MODELS.md',
    ...media.map(item => item.relative),
    'evidence/desktop.png', 'evidence/mobile.png', 'evidence/benchmark-quality.json',
    'evidence/benchmark-events.json',
    'evidence/qwen-vision-preflight.json',
    'evidence/ideogram-pipeline-provenance.json',
    'evidence/ideogram-route-provenance.json',
    'evidence/ideogram-native-provenance.json',
    'evidence/hunyuan-pipeline-provenance.json',
    'evidence/hunyuan-route-provenance.json',
    'evidence/hunyuan-native-provenance.json',
    'evidence/hunyuan-max-reasoning.json',
    'evidence/inference-provenance.json', 'evidence/h3-native-provenance.json',
    'evidence/h3-native.log',
    ...(resumeEvidence ? ['evidence/resume-provenance.json'] : []),
  ];
  const manifest = {
    schema: 'ds4.design.release.v1', caseId, pagesUrl,
    benchmarkPass: true, toolCompliance: true, elapsedMs: duration,
    resume: resumeEvidence ? {
      priorElapsedMs: resumeEvidence.priorElapsedMs,
      checkpoint: resumeEvidence.checkpoint,
      evidence: 'evidence/resume-provenance.json',
      sha256: sha256(resumeEvidenceFile),
    } : null,
    generatedAt: new Date().toISOString(),
    files: Object.fromEntries(releaseFiles.map(relative => [relative, {
      bytes: fs.statSync(path.join(staging, relative)).size,
      sha256: sha256(path.join(staging, relative)),
    }])),
  };
  fs.writeFileSync(path.join(staging, 'RELEASE_MANIFEST.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  fs.renameSync(staging, destination);
  process.stdout.write(`${JSON.stringify({ ok: true, destination, caseId, pagesUrl, elapsedMs: duration }, null, 2)}\n`);
} catch (error) {
  fs.rmSync(staging, { recursive: true, force: true });
  throw error;
}

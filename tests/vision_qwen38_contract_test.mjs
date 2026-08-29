import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';

const root = path.resolve(import.meta.dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const vision = read('src/dstudio_vision.c');
const websearch = read('src/dstudio_websearch.c');
const memory = read('src/dstudio_qwen_memory.c');
const image = read('src/dstudio_image.c');
const video = read('src/dstudio_video.c');
const setup = read('scripts/vision-setup.sh');
const runner = read('scripts/vision-qwen38-run.py');
const runnerSh = read('scripts/vision-qwen38-run.sh');
const imageRouter = read('scripts/image-route-qwen38.py');
const imageRouterSh = read('scripts/image-route-qwen38.sh');
const designBenchmark = read('tests/real_design_quality_test.mjs');
const imagePipeline = read('scripts/image-pipeline-run.py');
const ideogram = read('scripts/ideogram4-run.py');
const ideogramSh = read('scripts/ideogram4-generate.sh');
const hunyuan = read('scripts/hunyuan-image3-edit.py');
const hunyuanSh = read('scripts/hunyuan-image3-edit.sh');
const hunyuanPatch = read('scripts/hunyuan-image3-mps-patch.py');
const transformersMpsBackport = read('scripts/transformers-mps-warmup-backport.py');
const h3 = read('scripts/h3-generate.sh');
const h3Run = read('scripts/h3-run.py');
const design = read('extension/design/ds4_design.c');
const html = read('web/index.html');

const model = 'mlx-community/Qwen3.8-27B-8bit';
assert.doesNotMatch(imageRouter, /qwen-image/i,
  'the Qwen3.8 router must not retain retired Qwen Image process branding');
assert.match(designBenchmark, /real-qwen38-router-ideogram4-hunyuan3/,
  'benchmark provenance must name Qwen3.8 routing, Ideogram generation and Hunyuan editing');
assert.doesNotMatch(designBenchmark, /imageMode:\s*realImage\s*\?\s*'real-qwen'/,
  'benchmark provenance must not mislabel the retired image pipeline as Qwen');
const revision = '815b83c0df8ffd1d1b5244cf75fd6ef14fca9ef9';
for (const [name, source] of Object.entries({ vision, setup, runner, html })) {
  assert.match(source, new RegExp(model.replaceAll('.', '\\.') ), `${name} must use the sole Qwen3.8 Q8 model`);
  assert.doesNotMatch(source, /Qwen2\.5|qwen2\.5|vision-3b|vision-7b/i, `${name} must not retain the old vision fallback`);
}
assert.match(vision, new RegExp(revision), 'native vision must require the pinned revision');
assert.match(vision, /web_curl_capture\(argv, -1, &st\)/, 'Qwen3.8 Max must have no DStudio wall-clock deadline');
assert.match(websearch, /const int no_deadline = timeout_ms < 0[\s\S]*!no_deadline && left <= 0/, 'capture runtime must support explicit user-stoppable unbounded workers');
assert.match(setup, new RegExp(revision), 'setup must download the pinned revision');
assert.match(runner, new RegExp(revision), 'runner must resolve the pinned revision');
assert.match(setup, /MLX_VLM_VERSION=0\.6\.8[\s\S]*mlx-vlm==\$MLX_VLM_VERSION/, 'mlx-vlm must be pinned');
assert.match(runner, /local_files_only=True/, 'inference must never substitute a network fallback');
assert.match(runner, /reasoning_effort[^\n]*"max"[\s\S]*enable_thinking=thinking/, 'Qwen3.8 must default to its full thinking path');
assert.match(runner, /max_tokens=native_context/, 'generation may stop only at EOS or the model-native context boundary');
assert.doesNotMatch(runner, /body\.get\("max_tokens"/, 'DStudio must not apply a request-level Qwen output cap');
assert.doesNotMatch(vision, /json_get_int\(body, "max_tokens"|\\"max_tokens\\"/, 'the native endpoint must not forward a Qwen output cap');
assert.match(runner, /if reasoning_effort == "high"[\s\S]*thinking_budget/, 'only the user-selected High profile may budget visual reasoning');
assert.match(runner, /temperature=1\.0 if thinking[\s\S]*top_p=0\.95 if thinking[\s\S]*top_k=20/, 'Max should use the official Qwen3.8 thinking sampler');
assert.match(runner, /remove_pid\(\)[\s\S]*os\._exit\(0\)/, 'the one-shot worker must bypass the confirmed MLX teardown crash only after flushing a complete answer');
assert.equal((html.match(/<option value="mlx-community\/Qwen3\.8-27B-8bit">/g) || []).length, 1, 'settings must expose exactly one vision model');
assert.match(html, /visionThinkLevel: 'max'[\s\S]*videoProfile: 'quality'/, 'Qwen3.8 Max and H3 Quality must be the quality-first defaults');
assert.match(h3Run, /--profile", default="quality"/, 'the direct H3 runner must default to Quality');
assert.match(video, /char profile\[16\] = "quality"/, 'the H3 HTTP endpoint must default to Quality when no profile is supplied');
assert.match(html, /id="set-vision-thinking"[\s\S]*Max · unbudgeted thinking until EOS[\s\S]*High · bounded reasoning[\s\S]*Off · direct answer/, 'visual reasoning must remain user-selectable');
assert.match(html, /reasoning_effort: reasoningEffort/, 'the selected visual reasoning level must reach the native endpoint');

for (const [name, source, kind] of [
  ['Qwen3.8', runnerSh, 'qwen3.8-vision'],
  ['Qwen3.8 image router', imageRouterSh, 'qwen3.8-image-router'],
  ['Ideogram 4', ideogramSh, 'ideogram4-fp8'],
  ['HunyuanImage 3', hunyuanSh, 'hunyuan-image3-instruct-nf4'],
  ['MiniMax H3', h3, 'minimax-h3'],
]) {
  assert.match(source, /heavy-model-lock\.py/, `${name} must use the shared heavyweight lock`);
  assert.match(source, new RegExp(`--kind ${kind}`), `${name} must identify its lock owner`);
}
assert.match(memory, /image-pipeline"\)\) reserve = 80ull \* gib/, 'the serialized image pipeline must reserve 80 GiB');
assert.match(memory, /"vision"[\s\S]*reserve = 40ull \* gib/, 'Qwen3.8 vision must reserve 40 GiB');
assert.match(memory, /video-generation"\)\) reserve = 48ull \* gib/, 'H3 must reserve 48 GiB');
assert.match(image, /qwen_memory_ready\(&lease\)/, 'image generation must fail closed if DS4 cannot release memory');
assert.match(video, /qwen_memory_ready\(&lease\)/, 'video generation must fail closed if DS4 cannot release memory');
assert.match(design, /ds4_engine_memory_pressure_begin/, 'Design must evacuate DS4 before a heavyweight worker');
assert.doesNotMatch(design, /DS4UI_SSD_STREAMING_EFFECTIVE\s*==\s*1[\s\S]{0,300}return fn/, 'SSD streaming must not bypass DS4 evacuation');
const imageToolSource = design.slice(
  design.indexOf('static char *design_tool_generate_image'),
  design.indexOf('static bool design_has_mp4_extension'),
);
const videoToolSource = design.slice(
  design.indexOf('static char *design_tool_generate_video'),
  design.indexOf('static int design_chrome_executable'),
);
assert.doesNotMatch(imageToolSource, /--max-time/,
  'image inference must not receive a transport deadline');
assert.doesNotMatch(videoToolSource, /--max-time/,
  'H3 inference must not receive a transport deadline');
assert.match(design, /design_stop_media_job[\s\S]*--max-time/,
  'interrupt cleanup must remain bounded even though inference is unbounded');
assert.match(imageRouter, /MODEL_ID = "mlx-community\/Qwen3\.8-27B-8bit"[\s\S]*default="max"/, 'Qwen3.8 must be the sole authoritative router with Max default');
assert.match(imageRouter, /mode not in \{"edit", "generate"\}[\s\S]*caption_messages/, 'Qwen3.8 must decide edit versus generation before authoring an Ideogram caption');
assert.match(imageRouter, /if args\.reasoning_effort == "high"[\s\S]*thinking_budget/, 'only the explicit High router option may add a thinking budget');
assert.doesNotMatch(imageRouter, /Qwen2\.5/, 'the image router must not retain the retired vision backend');
assert.match(imageRouter, /class InferenceHeartbeat[\s\S]*elapsedSeconds[\s\S]*workerPid[\s\S]*heartbeat=True/, 'uncapped Qwen routing and captioning must expose a liveness heartbeat');
assert.equal((imageRouter.match(/with InferenceHeartbeat\(/g) || []).length, 2, 'both Qwen routing and Ideogram captioning must emit heartbeats');
assert.match(ideogram, /QUALITY_STEPS = 48[\s\S]*QUALITY_CFG = 7\.0[\s\S]*QUALITY_POLISH_CFG = 3\.0/, 'Ideogram must use the official full Quality-48 sampler');
assert.doesNotMatch(ideogram, /QUALITY_(?:TURBO|PREVIEW|LIGHTNING)|QUALITY_STEPS\s*=\s*(?:[1-9]|[1-3]\d)\b/i, 'Ideogram must not expose a reduced-quality sampler fallback');
assert.match(hunyuan, /MODEL_ID = "EricRollei\/HunyuanImage-3\.0-Instruct-NF4-v2"[\s\S]*QUALITY_STEPS = 50/, 'editing must use full HunyuanImage Instruct at 50 steps');
assert.match(hunyuan, /model\.generation_config\.diff_infer_steps = QUALITY_STEPS[\s\S]*bot_task="think_recaption"/, 'Hunyuan editing must retain full reasoning and explicitly pin its 50-step diffusion path');
assert.match(hunyuanSh, /--reasoning-output[\s\S]*--reasoning-file/, 'Hunyuan must unload Max reasoning before starting diffusion in a fresh sequential process');
assert.match(hunyuan, /reasoning_binding[\s\S]*reasoningSha256[\s\S]*load_reasoning_artifact/, 'the phase boundary must cryptographically bind Max reasoning to the exact request');
assert.doesNotMatch(hunyuan, /BitsAndBytesConfig/, 'Hunyuan must use the pinned checkpoint quantization map instead of overriding its BF16 exclusions');
assert.match(hunyuan, /validate_checkpoint_quantization\(model\)[\s\S]*bf16ProtectedModules/, 'Hunyuan must validate and disclose every protected BF16 module');
assert.doesNotMatch(hunyuan, /moe_drop_tokens\s*=\s*True/, 'Hunyuan quality mode must preserve every routed token from the checkpoint default');
assert.match(hunyuan, /if bool\(model\.config\.moe_drop_tokens\):[\s\S]*unexpectedly enables routed-token dropping/, 'Hunyuan must fail closed if a checkpoint ever enables token dropping');
assert.match(hunyuan, /"dropsRoutedTokens": bool\(model\.config\.moe_drop_tokens\)/, 'Hunyuan provenance must disclose routed-token preservation');
assert.match(hunyuan, /class ReasoningHeartbeat[\s\S]*elapsedSeconds[\s\S]*workerPid[\s\S]*heartbeat=True/, 'uncapped Hunyuan reasoning must expose a liveness heartbeat');
assert.match(hunyuan, /validate_native_model_runtime\(model\)[\s\S]*nativeEagerMoELayers/, 'Hunyuan must validate and disclose the official native eager MoE');
assert.doesNotMatch(hunyuan, /memory_efficient_moe_forward|slot_major_expert_route|install_memory_efficient_moe|install_mps_allocator_warmup_guard|install_vision_input_device_guard/, 'the production runner must not install custom numerical or loading monkeypatches');
assert.match(hunyuanPatch, /sync_official_moe_block[\s\S]*# DeepSeekMoE implementation[\s\S]*tencent-official-eager-moe/, 'the runtime source must be composed from the pinned official Tencent MoE');
assert.doesNotMatch(hunyuanPatch, /def memory_efficient_moe_forward|module\.forward\s*=|types\.MethodType/, 'the source portability patch must not provide a DStudio MoE forward');
assert.match(transformersMpsBackport, /PINNED_VERSION = "4\.57\.1"[\s\S]*elif device\.type == \\"mps\\"[\s\S]*continue/, 'the compatible Transformers release must receive only the upstream MPS warm-up skip');
assert.match(hunyuanSh, /transformers-mps-warmup-backport\.py[\s\S]*--official-modeling/, 'setup must install the upstream loader fix before composing official model source');
assert.match(imagePipeline, /run\(route_command\)[\s\S]*if mode == "generate"[\s\S]*ideogram4-generate\.sh[\s\S]*else:[\s\S]*hunyuan-image3-edit\.sh/, 'the selected backend must start only after the Qwen router exits');
assert.doesNotMatch(imagePipeline, /fallback|except[\s\S]{0,200}(ideogram|hunyuan)/i, 'the image coordinator must not switch models after a backend failure');
assert.match(imagePipeline, /ACTIVE_PROCESS[\s\S]*os\.killpg[\s\S]*start_new_session=True/,
  'image cancellation must terminate the selected backend process group');
assert.match(imagePipeline, /--cancel-file[\s\S]*worker_pid\.write_text[\s\S]*cancelled before worker startup/,
  'the image worker must publish its pid and honor durable pre-start cancellation');
assert.match(image, /IMAGE_JOB_OWNER_FILE\s+"server-owner"[\s\S]*image_claim_job\(dir\)/,
  'image jobs must be atomically owned by one DStudio server');
assert.match(image, /api_image_stop[\s\S]*image_request_cancel\(dir\)[\s\S]*worker\.pid/,
  'image stop must persist cancellation before racing worker startup');
assert.match(design, /design-image-%d-%llu[\s\S]*\/api\/image\/stop/,
  'Design interrupt cleanup must stop the exact image job it created');

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', code => resolve({ code, stdout, stderr }));
  });
}

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dstudio-qwen38-contract-'));
try {
  const request = path.join(temp, 'request.json');
  fs.writeFileSync(request, JSON.stringify({
    messages: [{ role: 'user', content: [
      { type: 'text', text: 'Describe the interface.' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } },
    ] }],
    reasoning_effort: 'max',
  }));
  const mocked = await run('/usr/bin/python3', [path.join(root, 'scripts/vision-qwen38-run.py'), '--request', request], {
    env: { ...process.env, DSTUDIO_VISION_TEST_MODE: '1', DSTUDIO_QWEN38_VISION_HOME: path.join(temp, 'runtime') },
  });
  assert.equal(mocked.code, 0, mocked.stderr || mocked.stdout);
  const response = JSON.parse(mocked.stdout.trim());
  assert.equal(response.model, model);
  assert.match(response.choices[0].message.content, /Qwen3\.8/);

  const imagePrompt = path.join(temp, 'image-request.txt');
  const imageSource = path.join(temp, 'source.png');
  fs.writeFileSync(imagePrompt, 'Create a quiet scientific image of Saturn.');
  fs.writeFileSync(imageSource, Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  ));
  const runPipelineFixture = async (mode, inputs = []) => {
    const outdir = path.join(temp, `pipeline-${mode}`);
    const status = path.join(outdir, 'status.json');
    const args = [
      path.join(root, 'scripts/image-pipeline-run.sh'),
      '--prompt-file', imagePrompt,
      '--outdir', outdir,
      '--status-file', status,
      '--aspect', '3:2',
      '--reasoning-effort', 'max',
    ];
    for (const input of inputs) args.push('--input', input);
    const result = await run('/bin/sh', args, {
      env: {
        ...process.env,
        DSTUDIO_IMAGE_TEST_MODE: '1',
        DSTUDIO_IMAGE_ROUTE_TEST_RESULT: mode,
        DSTUDIO_HEAVY_MODEL_DIR: path.join(temp, `pipeline-lock-${mode}`),
      },
    });
    assert.equal(result.code, 0, result.stderr || result.stdout);
    return {
      pipeline: JSON.parse(fs.readFileSync(path.join(outdir, 'image-pipeline-provenance.json'), 'utf8')),
      route: JSON.parse(fs.readFileSync(path.join(outdir, 'image-route-provenance.json'), 'utf8')),
    };
  };
  const generation = await runPipelineFixture('generate');
  assert.equal(generation.pipeline.router.decision, 'generate');
  assert.equal(generation.pipeline.provider, 'ideogram4-fp8');
  assert.equal(generation.pipeline.serialized, true);
  assert.equal(generation.route.decision, 'generate');
  assert.equal(generation.route.reasoning, 'max');
  assert.equal(generation.route.testMode, true);
  assert.ok(generation.route.elapsedSeconds >= 0);
  const editing = await runPipelineFixture('edit', [imageSource]);
  assert.equal(editing.pipeline.router.decision, 'edit');
  assert.equal(editing.pipeline.provider, 'hunyuan-image3-instruct-nf4');
  assert.equal(editing.pipeline.serialized, true);
  assert.equal(editing.route.decision, 'edit');
  assert.deepEqual(editing.route.sourceImages, ['source.png']);

  const cancelledOutdir = path.join(temp, 'pipeline-cancelled');
  fs.mkdirSync(cancelledOutdir, { recursive: true });
  const cancelledStatus = path.join(cancelledOutdir, 'status.json');
  const cancelMarker = path.join(cancelledOutdir, 'cancel-requested');
  fs.writeFileSync(cancelMarker, 'cancelled\n');
  const cancelled = await run('/bin/sh', [
    path.join(root, 'scripts/image-pipeline-run.sh'),
    '--prompt-file', imagePrompt,
    '--outdir', cancelledOutdir,
    '--status-file', cancelledStatus,
    '--cancel-file', cancelMarker,
    '--aspect', '3:2',
    '--reasoning-effort', 'max',
  ], {
    env: {
      ...process.env,
      DSTUDIO_IMAGE_TEST_MODE: '1',
      DSTUDIO_HEAVY_MODEL_DIR: path.join(temp, 'pipeline-lock-cancelled'),
    },
  });
  assert.equal(cancelled.code, 130, cancelled.stderr || cancelled.stdout);
  const cancelledPayload = JSON.parse(fs.readFileSync(cancelledStatus, 'utf8'));
  assert.equal(cancelledPayload.ok, false);
  assert.equal(cancelledPayload.state, 'error');
  assert.equal(cancelledPayload.stage, 'cancelled');
  assert.equal(fs.existsSync(path.join(cancelledOutdir, 'worker.pid')), false);
  assert.equal(fs.readdirSync(cancelledOutdir).some(name => name.endsWith('.png')), false);

  const lockEnv = { ...process.env, DSTUDIO_HEAVY_MODEL_DIR: path.join(temp, 'lock') };
  const lock = path.join(root, 'scripts/heavy-model-lock.py');
  const sleeper = ['/usr/bin/python3', lock, '--kind', 'contract', '--', '/usr/bin/python3', '-c', 'import time; time.sleep(0.3)'];
  const started = performance.now();
  const [first, second] = await Promise.all([
    run(sleeper[0], sleeper.slice(1), { env: lockEnv }),
    run(sleeper[0], sleeper.slice(1), { env: lockEnv }),
  ]);
  const elapsed = performance.now() - started;
  assert.equal(first.code, 0, first.stderr);
  assert.equal(second.code, 0, second.stderr);
  assert.ok(elapsed >= 540, `heavy workers overlapped: elapsed ${elapsed.toFixed(0)} ms`);
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

console.log('Qwen3.8 vision and heavyweight-memory contract: OK');

import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (file) => fs.readFileSync(file, 'utf8');
const web = read('web/index.html');
const server = read('src/dstudio.c');
const video = read('src/dstudio_video.c');
const worker = read('scripts/h3-run.py');
const wrapper = read('scripts/h3-generate.sh');

assert.match(worker, /COMFY_COMMIT\s*=\s*"[a-f0-9]{40}"/,
  'ComfyUI must be pinned to an immutable revision');
assert.match(worker, /MPS_ACCELERATOR_COMMIT\s*=\s*"[a-f0-9]{40}"/,
  'the Apple-Silicon INT8 accelerator must be pinned to an immutable revision');
assert.match(worker, /COMFY_REQUIRED_FILES/,
  'the managed checkout must verify real runtime files, not HEAD alone');
assert.match(worker, /"checkout",\s*"--force",\s*"--detach"/,
  'an empty or partial no-checkout worktree must be repaired');
assert.match(worker, /MODEL_REVISION\s*=\s*"[a-f0-9]{40}"/,
  'the open H3 checkpoint must be pinned to an immutable revision');
assert.match(worker, /Comfy-Org\/MiniMax-H3/);
assert.match(worker, /MiniMaxH3ImageToVideo/);
assert.match(worker, /VAEDecodeAudio/);
assert.match(worker, /CreateVideo/);
assert.match(worker, /SaveVideo/);
assert.match(worker, /--disable-api-nodes/,
  'hosted ComfyUI API nodes must be disabled in the managed local runtime');
assert.match(worker, /--whitelist-custom-nodes["',\s]+MPS_ACCELERATOR_DIR/,
  'only the managed Apple-Silicon accelerator may bypass the custom-node block');
assert.match(worker, /PYTORCH_ENABLE_MPS_FALLBACK/,
  'the Apple Metal runtime needs the MPS compatibility path');
assert.match(worker, /PYTORCH_MPS_PREFER_METAL/,
  'the H3 worker should prefer native Metal matrix kernels');
assert.match(worker, /configure_apple_accelerator_env/,
  'the H3 worker must select kernels for the actual Apple GPU generation');
for (const gate of [
  'ASFP8_INT8_EXT', 'ASFP8_FP8_EXT', 'ASFP8_FP8_NATIVE',
  'ASFP8_INT4_EXT', 'ASFP8_CONV_IM2COL',
  'MTLFLASHATTN_SDPA', 'MTLFLASHATTN_SHIM',
]) {
  assert.match(worker, new RegExp(gate), `${gate} must be guarded on pre-M5 Macs`);
}
assert.match(worker, /MIN_SAMPLER_STEPS\s*=\s*20/,
  'H3 must retain the official 20-step sampler floor');
assert.match(worker, /--use-pytorch-cross-attention/,
  'H3 attention must pass through the accelerator-patched PyTorch SDPA path');
assert.match(worker, /--mmap-torch-files/,
  'large pinned checkpoints should be memory-mapped on unified-memory Macs');
assert.doesNotMatch(worker, /["']--cache-none["']|["']--disable-smart-memory["']/,
  'the worker must retain Comfy caching and smart memory management');
assert.match(worker, /start_new_session=True/,
  'the initialized Comfy/Metal runtime must survive the short request worker');
assert.match(worker, /SERVER_RUNTIME_VERSION/);
assert.match(worker, /SAMPLER_PROGRESS_RE/,
  'video progress must come from real ComfyUI sampler steps');
assert.doesNotMatch(worker, /api\.minimax\.io|MINIMAX_API_KEY|authorization:\s*bearer/i,
  'the worker must not contain a hosted MiniMax generation path');

for (const filename of [
  'minimax_h3_fl2va_pruned_int8_convrot.safetensors',
  'minimax_h3_fl2va_pruned_bf16.safetensors',
  'qwen3vl_32b_minimax_h3_int8_convrot.safetensors',
  'minimax_h3_video_vae_fp16.safetensors',
  'minimax_h3_audio_vae_fp32.safetensors',
]) {
  assert.match(worker, new RegExp(filename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(video, new RegExp(filename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
}
assert.match(worker, /selected_diffusion_spec/,
  'high-memory M1-M4 Macs should use the official BF16 diffusion checkpoint');
assert.match(video, /video_use_bf16_diffusion/,
  'setup status must track the same hardware-selected diffusion checkpoint');

assert.match(wrapper, /h3-run\.py/);
assert.ok((fs.statSync('scripts/h3-generate.sh').mode & 0o111) !== 0,
  'the managed H3 launcher must be executable');
assert.match(server, /#include "dstudio_video\.c"/);
for (const route of ['status', 'setup', 'generate', 'progress', 'file', 'stop']) {
  assert.match(server, new RegExp(`/api/video/${route}`), `missing /api/video/${route}`);
}
assert.match(video, /451 Unavailable For Legal Reasons/,
  'setup and generation require an explicit license authorization assertion');
assert.match(video, /Content-Range/);
assert.match(video, /Accept-Ranges/);
assert.match(video, /video_runtime_shutdown/,
  'the detached H3 runtime must be stopped when DStudio exits');

assert.match(web, /data-pane="video"/);
assert.match(web, /id="set-video-license"/);
assert.match(web, /id="set-video-profile"/);
assert.match(web, /Preview · ~0\.2 MP, 20 steps/,
  'the fast H3 profile may reduce canvas area but must keep 20 sampler steps');
assert.match(web, /videoLicenseAccepted:\s*false/,
  'license authorization must be opt-in');
assert.match(web, /dstudio-video/);
assert.match(web, /"duration":null,"aspect":null/,
  'model routing must preserve saved user defaults when values are unspecified');
assert.match(web, /"firstFramePrompt":null/,
  'the video directive must support a Qwen-generated opening frame');
assert.match(web, /generatedFirstFrame\s*=\s*await generateImageFromDirective/,
  'Qwen Image must run before H3 when a generated first frame is requested');
assert.match(web, /firstFrame\s*=\s*await blobToDataUri/,
  'the locally generated Qwen image must be passed to H3 as first-frame data');
assert.match(web, /value\.diffusionPrecision\s*===\s*'bf16'/,
  'Settings must report the hardware-selected BF16 or INT8 diffusion precision');
assert.match(web, /fetch\('\/api\/video\/generate'/);
assert.match(web, /<video|el\('video'/);
assert.match(web, /download:\s*video\.name/);
assert.match(web, /await Switcher\.ensureChatReady\(/,
  'the chat runtime must be restored after H3 releases memory');
assert.doesNotMatch(web, /fetch\([^\n]*api\.minimax\.io/i,
  'the UI must not call the hosted MiniMax generation API');

console.log('video_open_weight_contract_test: ok');

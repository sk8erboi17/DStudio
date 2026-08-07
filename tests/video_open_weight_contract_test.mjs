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
assert.match(worker, /SAMPLER_PROGRESS_RE/,
  'video progress must come from real ComfyUI sampler steps');
assert.doesNotMatch(worker, /api\.minimax\.io|MINIMAX_API_KEY|authorization:\s*bearer/i,
  'the worker must not contain a hosted MiniMax generation path');

for (const filename of [
  'minimax_h3_fl2va_pruned_int8_convrot.safetensors',
  'qwen3vl_32b_minimax_h3_int8_convrot.safetensors',
  'minimax_h3_video_vae_fp16.safetensors',
  'minimax_h3_audio_vae_fp32.safetensors',
]) {
  assert.match(worker, new RegExp(filename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(video, new RegExp(filename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
}

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

assert.match(web, /data-pane="video"/);
assert.match(web, /id="set-video-license"/);
assert.match(web, /id="set-video-profile"/);
assert.match(web, /videoLicenseAccepted:\s*false/,
  'license authorization must be opt-in');
assert.match(web, /dstudio-video/);
assert.match(web, /"duration":null,"aspect":null/,
  'model routing must preserve saved user defaults when values are unspecified');
assert.match(web, /fetch\('\/api\/video\/generate'/);
assert.match(web, /<video|el\('video'/);
assert.match(web, /download:\s*video\.name/);
assert.match(web, /await Switcher\.ensureChatReady\(/,
  'the chat runtime must be restored after H3 releases memory');
assert.doesNotMatch(web, /fetch\([^\n]*api\.minimax\.io/i,
  'the UI must not call the hosted MiniMax generation API');

console.log('video_open_weight_contract_test: ok');

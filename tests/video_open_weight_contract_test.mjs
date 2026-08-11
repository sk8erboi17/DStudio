import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (file) => fs.readFileSync(file, 'utf8');
const web = read('web/index.html');
const server = read('src/dstudio.c');
const video = read('src/dstudio_video.c');
const worker = read('scripts/h3-run.py');
const wrapper = read('scripts/h3-generate.sh');

assert.match(worker, /H3_REPOSITORY\s*=\s*"https:\/\/github\.com\/antirez\/h3\.c\.git"/);
assert.match(worker, /H3_COMMIT\s*=\s*"[a-f0-9]{40}"/,
  'the native engine must be pinned to an immutable h3.c revision');
assert.match(worker, /H3_REQUIRED_FILES/,
  'the managed native checkout must validate source/runtime sentinels');
assert.match(worker, /"checkout",\s*"--force",\s*"--detach"/,
  'an empty or partial --no-checkout h3.c worktree must be repaired');
assert.match(worker, /MODEL_REPOSITORY\s*=\s*"MiniMaxAI\/MiniMax-H3"/);
assert.match(worker, /MODEL_REVISION\s*=\s*"[a-f0-9]{40}"/,
  'the official H3 checkpoint must be pinned to an immutable snapshot');
for (const path of [
  'FL2VA/text_encoder',
  'FL2VA/transformer',
  'FL2VA/tokenizer/tokenizer.json',
  'FL2VA/video_vae/source/model.safetensors',
  'FL2VA/audio_vae/model.safetensors',
]) {
  assert.match(worker, new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
}
assert.match(worker, /MODEL_TOTAL_BYTES/);
assert.match(worker, /144_023_550_851|144023550851/,
  'the manifest must cover the complete official FL2VA tree used by h3.c');
assert.match(worker, /make,\s*f"-j\{jobs\}",\s*H3_BINARY/,
  'setup must compile the native executable without invoking it');
assert.match(worker, /native_command/);
for (const flag of ['--seconds', '--steps', '--layers', '--reuse', '--first-frame']) {
  assert.match(worker, new RegExp(flag), `native h3.c command is missing ${flag}`);
}
assert.match(worker, /MIN_SAMPLER_STEPS\s*=\s*20/,
  'all DStudio profiles must keep the 20-step sampler schedule');
assert.match(worker, /H3_PROGRESS_RE/,
  'video progress must be parsed from native h3.c callback output');
assert.match(worker, /start_new_session=True/,
  'the native child needs an isolated process group for reliable cancellation');
assert.match(worker, /os\.killpg/,
  'cancelling a worker must also terminate the native h3.c child');
assert.doesNotMatch(worker, /COMFY_COMMIT|MPS_ACCELERATOR_COMMIT|torch|api\.minimax\.io|MINIMAX_API_KEY/i,
  'the native worker must not retain the old Comfy/PyTorch or hosted API engine');
for (const converted of [
  'minimax_h3_fl2va_pruned_int8_convrot.safetensors',
  'qwen3vl_32b_minimax_h3_int8_convrot.safetensors',
]) {
  assert.doesNotMatch(worker, new RegExp(converted));
  assert.doesNotMatch(video, new RegExp(converted));
}

assert.match(wrapper, /h3-run\.py/);
assert.ok((fs.statSync('scripts/h3-generate.sh').mode & 0o111) !== 0,
  'the managed H3 launcher must be executable');
assert.match(server, /#include "dstudio_video\.c"/);
for (const route of ['status', 'setup', 'generate', 'progress', 'file', 'stop']) {
  assert.match(server, new RegExp(`/api/video/${route}`), `missing /api/video/${route}`);
}
assert.match(video, /H3_NATIVE_COMMIT\s+"[a-f0-9]{40}"/);
assert.match(video, /H3_MODEL_REVISION\s+"[a-f0-9]{40}"/);
assert.match(video, /H3_MODEL_TOTAL_SIZE\s+144023550851LL/);
assert.match(video, /h3\.c\/Metal/);
assert.match(video, /451 Unavailable For Legal Reasons/,
  'setup and generation require an explicit license authorization assertion');
assert.match(video, /Content-Range/);
assert.match(video, /Accept-Ranges/);
assert.match(video, /video_runtime_shutdown/,
  'in-flight one-shot H3 workers must be stopped when DStudio exits');

assert.match(web, /data-pane="video"/);
assert.match(web, /id="set-video-license"/);
assert.match(web, /id="set-video-profile"/);
assert.match(web, /Preview · reduced native canvas, 20 steps/);
assert.match(web, /Official BF16 · required by native h3\.c/);
assert.doesNotMatch(web, /option value="community"/,
  'the native checkpoint contract cannot load the old converted community encoder');
assert.match(web, /videoLicenseAccepted:\s*false/,
  'license authorization must be opt-in');
assert.match(web, /134 GiB/);
assert.match(web, /dstudio-video/);
assert.match(web, /"duration":null,"aspect":null/,
  'model routing must preserve saved user defaults when values are unspecified');
assert.match(web, /"firstFramePrompt":null/,
  'the video directive must support a Qwen-generated opening frame');
assert.match(web, /generatedFirstFrame\s*=\s*await generateImageFromDirective/,
  'Qwen Image must run before H3 when a generated first frame is requested');
assert.match(web, /firstFrame\s*=\s*await blobToDataUri/,
  'the locally generated Qwen image must be passed to H3 as first-frame data');
assert.match(web, /fetch\('\/api\/video\/generate'/);
assert.match(web, /<video|el\('video'/);
assert.match(web, /download:\s*video\.name/);
assert.match(web, /await Switcher\.ensureChatReady\(/,
  'the chat runtime must be restored after the one-shot H3 process releases memory');
assert.doesNotMatch(web, /fetch\([^\n]*api\.minimax\.io/i,
  'the UI must not call the hosted MiniMax generation API');

console.log('video_open_weight_contract_test: ok');

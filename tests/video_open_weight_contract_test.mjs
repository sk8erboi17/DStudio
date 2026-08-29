import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';

const read = (file) => fs.readFileSync(file, 'utf8');
const web = read('web/index.html');
const server = read('src/dstudio.c');
const video = read('src/dstudio_video.c');
const worker = read('scripts/h3-run.py');
const wrapper = read('scripts/h3-generate.sh');
const h3PatchScript = read('scripts/apply-h3-metal-watchdog.sh');
const h3StagePatch = read('patch/h3-metal-watchdog/stage-command-submits.patch');
const h3StagePatchSha256 = crypto.createHash('sha256').update(
  fs.readFileSync('patch/h3-metal-watchdog/stage-command-submits.patch')).digest('hex');

assert.match(worker, /H3_REPOSITORY\s*=\s*"https:\/\/github\.com\/antirez\/h3\.c\.git"/);
assert.match(worker, /H3_COMMIT\s*=\s*"[a-f0-9]{40}"/,
  'the native engine must be pinned to an immutable h3.c revision');
assert.match(worker, /apply_h3_runtime_patch/,
  'the managed builder must apply the versioned H3 source patch');
assert.match(worker, /finally:\s*\n\s*restore_h3_runtime_patch\(checkout\)/,
  'the managed builder must restore pinned H3 sources even after a failed build');
assert.match(worker, /h3_runtime_revision/,
  'the native runtime marker must include the exact patch digest');
assert.match(worker, /patchSha256/,
  'accepted H3 provenance must identify the applied source patch');
assert.match(h3PatchScript, /git -C "\$h3_dir" apply --reverse --check/,
  'the H3 patch launcher must recognize an exact existing patch');
assert.match(h3PatchScript, /refusing to mix with an unknown source delta/,
  'the H3 patch launcher must fail closed on unknown local source edits');
assert.match(h3PatchScript, /managed_sources="h3_dit\.c h3_gpu\.m"/,
  'the H3 patch launcher must guard every upstream source touched by the patch');
assert.match(h3StagePatch, /H3_DIT_STAGE_SUBMITS/,
  'the watchdog scheduling change must live in a versioned upstream patch');
assert.match(h3StagePatch, /H3_SDPA_QUERY_CHUNK/,
  'the patch must partition full attention by independent query rows');
assert.match(worker, /QUALITY_SDPA_QUERY_CHUNK\s*=\s*"8"/,
  'quality scheduling must bound pre-M5 MPSGraph attention commands');
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
assert.match(worker, /class H3ProgressStreamParser/,
  'native carriage-return progress must be framed even without a final newline');
assert.match(worker, /progress_parser\.poll\(time\.monotonic\(\), force=True\)/,
  'the final undelimited native progress record must be flushed at EOF');
assert.match(worker, /inspect_video_output\(output, width, height, args\.duration\)/,
  'native output must pass a real ffprobe media gate');
assert.match(worker, /ffmpeg,\s*"-v",\s*"error",\s*"-xerror"[\s\S]*"-f",\s*"null"/,
  'the terminal media gate must decode the complete MP4, not only inspect metadata');
assert.match(worker, /configure_dit_scheduling/);
assert.match(worker, /H3_DIT_COMMAND_BLOCKS/,
  'quality and file-backed inference must use bounded byte-identical Metal command buffers');
assert.match(worker, /TRANSFORMER_COPY_MINIMUM_MEMORY_BYTES/,
  'H3 residency must be based on its largest simultaneously live model phase');
assert.match(worker, /start_metal_log_monitor/,
  'real H3 inference must monitor macOS GPU command-buffer failures');
assert.match(worker, /start_power_assertion/,
  'real H3 inference must own a macOS idle-sleep assertion');
assert.match(worker, /\[caffeinate, "-i", "-w", str\(process_id\)\]/,
  'the sleep assertion must be bound to the exact native H3 process lifetime');
assert.match(worker, /metalCommandBufferErrors/,
  'accepted H3 provenance must record an error-free Metal gate');
assert.match(worker, /"powerAssertion": POWER_ASSERTION_MODE/,
  'accepted H3 provenance must record its active power assertion');
assert.match(worker, /dstudio\.h3\.failure\.v1/,
  'failed H3 inference must preserve structured native phase evidence');
assert.match(worker, /NATIVE_STATUS_HEARTBEAT_SECONDS\s*=\s*30\.0/);
assert.match(worker, /publish_native_status/,
  'native H3 progress must remain observable between long denoise steps');
for (const mediaRequirement of ['h264', 'yuv420p', 'durationSeconds']) {
  assert.match(worker, new RegExp(mediaRequirement), `H3 provenance/media gate is missing ${mediaRequirement}`);
}
assert.match(worker, /h3-provenance\.json/,
  'production H3 output must record pinned model, engine, quality, seed and media provenance');
assert.match(worker, /start_new_session=True/,
  'the native child needs an isolated process group for reliable cancellation');
assert.match(worker, /os\.killpg/,
  'cancelling a worker must also terminate the native h3.c child');
assert.match(worker, /--cancel-file/,
  'the native wrapper must accept the server-owned durable cancellation marker');
assert.match(worker,
  /worker_pid\.write_text[\s\S]*args\.cancel_file[\s\S]*cancelled before worker startup/,
  'h3-run must publish its pid before honoring a pre-start cancellation');
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
const serverPatchSha = video.match(/H3_PATCH_SHA256\s+"([a-f0-9]{64})"/)?.[1];
assert.equal(serverPatchSha, h3StagePatchSha256,
  'the server installation marker must pin the exact managed H3 patch bytes');
assert.match(video, /H3_RUNTIME_REVISION\s+H3_NATIVE_COMMIT\s+"\+"\s+H3_PATCH_SHA256/,
  'the server and Python builder must share commit+patch runtime identity');
assert.match(video,
  /video_marker_matches\(native_marker, H3_RUNTIME_REVISION\)/,
  'a patched native runtime must be recognized by its complete marker');
assert.match(video, /enginePatchSha256/,
  'the video status API must expose the exact managed patch digest');
assert.match(video, /engineRuntimeRevision/,
  'the video status API must expose the complete runtime identity');
assert.match(video, /H3_MODEL_REVISION\s+"[a-f0-9]{40}"/);
assert.match(video, /H3_MODEL_TOTAL_SIZE\s+144023550851LL/);
assert.match(video, /h3\.c\/Metal/);
assert.match(video, /451 Unavailable For Legal Reasons/,
  'setup and generation require an explicit license authorization assertion');
assert.match(video, /Content-Range/);
assert.match(video, /Accept-Ranges/);
assert.match(video, /video_runtime_shutdown/,
  'in-flight one-shot H3 workers must be stopped when DStudio exits');
assert.match(video, /H3_JOB_OWNER_FILE\s+"server-owner"/,
  'each H3 job must record the DStudio server that launched it');
assert.match(video,
  /video_runtime_shutdown\(void\)[\s\S]*video_job_owned\(job_dir\)[\s\S]*video_stop_worker_pid_path/,
  'server shutdown must stop only H3 workers owned by that server instance');
assert.match(video,
  /api_video_stop\(int fd, const char \*body\)[\s\S]*video_job_owned\(dir\)[\s\S]*kill\(\(pid_t\)pid, SIGTERM\)/,
  'the stop endpoint must not terminate an H3 worker owned by another server');
assert.match(video, /video_claim_job\(dir\)/,
  'H3 generation must claim its job before launching the worker');
assert.match(video, /H3_JOB_CANCEL_FILE\s+"cancel-requested"/,
  'H3 cancellation must have a durable per-job marker');
assert.match(video,
  /api_video_stop\(int fd, const char \*body\)[\s\S]*video_request_cancel\(dir\)[\s\S]*worker\.pid/,
  'the stop endpoint must persist cancellation before racing worker startup');
assert.match(video,
  /--cancel-file[\s\S]*qwen_memory_begin\("video-generation"\)[\s\S]*video_cancel_requested\(dir\)[\s\S]*setup_run_cmd_capture/,
  'the coordinator and worker must both honor cancellation before inference starts');
assert.match(video, /O_WRONLY\s*\|\s*O_CREAT\s*\|\s*O_EXCL/,
  'POSIX H3 job ownership must use an atomic exclusive create');
assert.match(video, /CreateFileA\([\s\S]*CREATE_NEW/,
  'Windows H3 job ownership must use an atomic exclusive create');
assert.doesNotMatch(video,
  /(?:ERROR_FILE_EXISTS|errno\s*==\s*EEXIST)[\s\S]{0,120}video_job_owned\(job_dir\)/,
  'an existing H3 job id must not be reusable even by the same server');
assert.match(server, /video_runtime_init\(\);[\s\S]*open_(?:first_)?listener/,
  'the H3 owner token must exist before request workers fork');

assert.match(web, /data-pane="video"/);
assert.match(web, /progress\?\.ok\s*\|\|\s*progress\?\.state\s*===\s*'error'/,
  'the video progress UI must surface terminal errors whose ok flag is false');
assert.match(web, /id="set-video-license"/);
assert.match(web, /id="set-video-profile"/);
assert.match(web, /Preview · reduced native canvas, 20 steps/);
assert.match(web, /Official BF16 · required by native h3\.c/);
assert.doesNotMatch(web, /option value="community"/,
  'the native checkpoint contract cannot load the old converted community encoder');
assert.match(web, /videoLicenseAccepted:\s*false/,
  'license authorization must be opt-in');
assert.match(web, /composerTarget:\s*'chat'/,
  'H3 must be an explicit composer selection rather than the default Chat target');
assert.match(web, /function appendH3PickerOption\(menu\)[\s\S]*MiniMax H3/,
  'the composer model picker must expose H3 as a selectable local media model');
assert.match(web, /function directH3VideoDirective\(chat, userMsg, settings\)/,
  'selecting H3 must route raw composer prompts directly to local video generation');
assert.match(web, /Scene · Action · Camera · Look \/ lighting · Audio/,
  'the H3 composer should teach the upstream Context-IR prompt shape');
assert.match(web, /134 GiB/);
assert.match(web, /dstudio-video/);
assert.match(web, /"duration":null,"aspect":null/,
  'model routing must preserve saved user defaults when values are unspecified');
assert.match(web, /"firstFramePrompt":null/,
  'the video directive must support a locally generated opening frame');
assert.match(web, /generatedFirstFrame\s*=\s*await generateImageFromDirective/,
  'the Qwen3.8-routed Ideogram pipeline must run before H3 for a generated first frame');
assert.match(web, /firstFrame\s*=\s*await blobToDataUri/,
  'the locally generated Ideogram image must be passed to H3 as first-frame data');
assert.match(web, /fetch\('\/api\/video\/generate'/);
assert.match(web, /<video|el\('video'/);
assert.match(web, /download:\s*video\.name/);
assert.match(web, /await Switcher\.ensureChatReady\(/,
  'the chat runtime must be restored after the one-shot H3 process releases memory');
assert.doesNotMatch(web, /fetch\([^\n]*api\.minimax\.io/i,
  'the UI must not call the hosted MiniMax generation API');

console.log('video_open_weight_contract_test: ok');

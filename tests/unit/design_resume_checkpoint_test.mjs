import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  loadResumeManifest,
  trimResumeTranscript,
  verifyResumeFiles,
} from '../support/design_resume_checkpoint.mjs';

const event = (type, name, output = '') =>
  `\x1e${JSON.stringify({ type, name, output })}\n`;
const transcript = [
  'visible prelude\n',
  event('tool_call', 'generate_image'),
  event('tool_result', 'generate_image', 'source'),
  event('tool_call', 'see_image'),
  event('tool_result', 'see_image', 'source corresponds'),
  event('tool_call', 'generate_image'),
  event('tool_result', 'generate_image', 'edit'),
  event('tool_call', 'see_image'),
  event('tool_result', 'see_image', 'edit mismatch'),
  'reasoning that must be discarded\n',
  event('tool_call', 'generate_image'),
].join('');

const trimmed = trimResumeTranscript(transcript, {
  type: 'tool_result', name: 'see_image', occurrence: 2,
});
assert.match(trimmed.raw, /edit mismatch/);
assert.doesNotMatch(trimmed.raw, /must be discarded/);
assert.equal((trimmed.raw.match(/\"name\":\"generate_image\"/g) || []).length, 4,
  'checkpoint keeps exactly two image calls and their two results');
assert.throws(() => trimResumeTranscript(transcript, {
  type: 'tool_result', name: 'see_image', occurrence: 3,
}), /not found/);

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dstudio-resume-test-'));
try {
  const workspace = path.join(temp, 'workspace');
  fs.mkdirSync(path.join(workspace, 'assets'), { recursive: true });
  const asset = path.join(workspace, 'assets', 'still.png');
  fs.writeFileSync(asset, Buffer.from('resume-asset'));
  const sha256 = 'e2988d1faadf44cea122cfad73c6481744186c3e1b6aa6f09a9c0ecfd2cf95de';
  const manifestPath = path.join(temp, 'resume.json');
  fs.writeFileSync(manifestPath, JSON.stringify({
    schema: 'ds4.design.resume.v1',
    caseId: 'one-case',
    transcript: 'partial.raw.txt',
    stopAfter: { type: 'tool_result', name: 'see_image', occurrence: 2 },
    priorElapsedMs: 123,
    prompt: 'Continue from the verified checkpoint.',
    files: { 'assets/still.png': { sha256, minimumBytes: 8 } },
  }));
  const loaded = loadResumeManifest(manifestPath, ['one-case']);
  assert.equal(loaded.manifest.caseId, 'one-case');
  assert.deepEqual(verifyResumeFiles(workspace, loaded.manifest.files), [{
    path: 'assets/still.png', bytes: 12, sha256,
  }]);
  assert.throws(() => verifyResumeFiles(workspace, {
    '../escape.png': { minimumBytes: 1 },
  }), /escapes workspace/);
  assert.throws(() => loadResumeManifest(manifestPath, ['other-case']), /one selected/);
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

console.log('design_resume_checkpoint_test: ok');

import assert from 'node:assert/strict';
import fs from 'node:fs';

const design = fs.readFileSync('extension/design/ds4_design.c', 'utf8');
const image = fs.readFileSync('scripts/image-pipeline-run.py', 'utf8');
const launcher = fs.readFileSync('src/dstudio.c', 'utf8');

assert.match(design, /design_native_vision_describe/);
assert.match(design, /direct-local-media/);
assert.match(image, /choices=\(\"generate\", \"edit\"\)/);
assert.match(launcher, /DeepSeek Vision-Exp \/ GLM 5\.3/);
assert.equal(fs.existsSync('scripts/vision-server.sh'), false);
assert.equal(fs.existsSync('scripts/vision-setup.sh'), false);
assert.equal(fs.existsSync('scripts/image-route-' + 'retired-vlm.py'), false);

const retired = ['api/' + 'vision', 'secondary_' + 'vision_router'].join('|');
assert.doesNotMatch(design, new RegExp(retired, 'i'));
assert.doesNotMatch(image, new RegExp(retired, 'i'));

console.log('design_release_native_contract_test: ok');

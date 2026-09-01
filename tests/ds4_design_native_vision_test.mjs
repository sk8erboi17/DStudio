import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync('extension/design/ds4_design.c', 'utf8');

assert.match(source, /static char \*design_native_vision_describe\(/,
  'Design must implement image inspection inside the selected model runtime');
assert.match(source, /ds4_engine_has_vision\(pr->engine\)/,
  'Design must fail closed when the selected engine has no native encoder');
assert.match(source, /ds4_engine_vision_encode_file\(pr->engine/,
  'Design must encode project pixels with the selected engine');
assert.match(source, /ds4_chat_append_multimodal_message\(pr->engine/,
  'Design must construct a native multimodal turn');
assert.match(source, /ds4_session_sync_multimodal/,
  'Design must synchronize image embeddings into its isolated inspection session');
assert.match(source, /Available only with DeepSeek Vision-Exp or GLM 5\.3 Vision/,
  'the visual tool contract must expose the native-only boundary');
assert.match(source, /source_b64 \? "edit" : "generate"/,
  'the direct media request must choose edit or generation from source pixels');
assert.match(source, /direct-local-media/,
  'media provenance must report the direct pipeline');
assert.doesNotMatch(source, new RegExp(['api/' + 'vision', 'secondary_' + 'vision_router'].join('|'), 'i'),
  'Design must not retain the retired visual sidecar/router');
assert.doesNotMatch(source, /reasoning_effort/,
  'the direct image pipeline must not expose a retired router reasoning setting');

console.log('ds4_design_native_vision_test: ok');

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');

const launcher = read('src/dstudio.c');
const setup = read('src/dstudio_setup.c');
const ui = read('web/index.html');
const charter = read('extension/cowork/COWORK.md');
const office = read('extension/cowork/office_tool.py');
const bridge = read('extension/cowork/ds4_cowork.c');
const patchManifest = read('patch/ds4-agent-jsonl/manifest');
const dispatchPatch = read('patch/ds4-agent-jsonl/061.replace');
const cachePatch = read('patch/ds4-agent-jsonl/062.replace');
const dsmlPatch = read('patch/ds4-agent-jsonl/063.replace');
const modernPromptPatch = read('patch/ds4-agent-jsonl/063.modern.replace');
const glmPatch = read('patch/ds4-agent-jsonl/064.replace');
const lagunaPatch = read('patch/ds4-agent-jsonl/064.laguna.replace');
const makefile = read('Makefile');

assert.match(launcher, /ENGINE_NONE = 0, ENGINE_SERVER, ENGINE_AGENT, ENGINE_COWORK, ENGINE_DESIGN/);
assert.match(launcher, /want_cowork = !strcmp\(mode, "cowork"\)/);
assert.match(launcher, /want_cowork \? spawn_agent\(&cfg, workdir, 1/);
assert.match(launcher, /cowork_mode \? "ds4-cowork" : "ds4-agent-jsonl"/);
assert.match(launcher, /DS4UI_COWORK_HELPER/);
assert.match(launcher, /extension\/cowork\/COWORK\.md/);
assert.match(launcher, /path_eq_clean\(path, "\/api\/cowork\/attach-file"\)/);
assert.match(launcher, /64u \* 1024 \* 1024/);
assert.match(launcher, /O_WRONLY \| O_CREAT \| O_EXCL/);
assert.match(setup, /ENGINE_COWORK/);

assert.match(ui, /id="tab-cowork"/);
assert.match(ui, /async function startCowork\(workdir\)/);
assert.match(ui, /runSwitch\('cowork', \{\s*mode: 'cowork'/);
assert.match(ui, /const piped = m === 'agent' \|\| m === 'cowork' \|\| m === 'design'/);
assert.match(ui, /async function coworkAttachFiles\(fileList\)/);
assert.match(ui, /fetch\('\/api\/cowork\/attach-file'/);
assert.match(ui, /Cowork spreadsheet[\s\S]*Inspect it with the excel tool/);
assert.match(ui, /prepareCoworkPendingAttachments[\s\S]*coworkAttachmentDisplayMarker/);
assert.doesNotMatch(ui, /input\.value[\s\S]{0,180}coworkAttachmentHint/,
  'Cowork attachment instructions must stay out of the visible composer text');
assert.match(ui, /cowork: 'New workspace'/);
assert.match(ui, /active: \{ chat: null, agent: null, cowork: null, design: null, roadmap: null \}/);

for (const tool of ['excel', 'read_pdf', 'read_document', 'write_document', 'write_pdf', 'presentation']) {
  assert.ok(charter.includes('`' + tool + '`') || charter.includes(`"name":"${tool}"`), `Cowork charter should describe ${tool}`);
}
assert.match(charter, /reconcile totals, signs, units, date periods and\s+formulas/i);
assert.match(charter, /untrusted\s+content/i);
assert.match(charter, /re-open the written range or document and verify/i);

assert.match(office, /class Workspace/);
assert.match(office, /resolved\.relative_to\(self\.root\)/);
assert.match(office, /MAX_ZIP_ENTRIES/);
assert.match(office, /MAX_ZIP_EXPANDED/);
assert.match(office, /def create_xlsx/);
assert.match(office, /def update_xlsx/);
assert.match(office, /def create_docx/);
assert.match(office, /def create_pdf/);
assert.match(office, /def create_pptx/);
assert.doesNotMatch(bridge, /\bsystem\s*\(/);
assert.match(bridge, /execlp\(python, python, helper/);
assert.match(bridge, /COWORK_OUTPUT_MAX/);

assert.match(patchManifest, /version=77/);
assert.match(patchManifest, /edit=063[\s\S]*edit=064[\s\S]*edit=065[\s\S]*edit=067[\s\S]*edit=068[\s\S]*edit=069/);
const textToolObservationPatch = fs.readFileSync(path.join(root, 'patch/ds4-agent-jsonl/068.replace'), 'utf8');
assert.match(textToolObservationPatch, /if \(!obs->image_count\)[\s\S]*ds4_chat_append_message[\s\S]*else \{[\s\S]*ds4_chat_append_multimodal_message/,
  'text-only tool observations must bypass the native multimodal helper');
assert.match(dispatchPatch, /runtime && !strcmp\(runtime, "cowork"\)/);
assert.match(read('patch/ds4-agent-jsonl/067.replace'), /ds4ui_cowork_workspace_guard/);
assert.match(read('patch/ds4-agent-jsonl/067.replace'), /bash is unavailable/);
assert.match(cachePatch, /\.ds4\/cowork-kvcache/);
for (const schema of ['excel', 'read_document', 'write_document', 'write_pdf', 'presentation']) {
  assert.ok(dsmlPatch.includes(`name\\\":\\\"${schema}`), `DSML prompt patch should expose ${schema}`);
  assert.ok(modernPromptPatch.includes(`name\\\":\\\"${schema}`), `modern DSML/GLM prompt patch should expose ${schema}`);
}
assert.match(modernPromptPatch, /agent_build_cowork_dsml_tools_prompt/);
assert.match(modernPromptPatch, /agent_build_cowork_glm_tools_prompt/);
assert.match(modernPromptPatch, /cfg && cfg->edit_upto/);
assert.match(glmPatch, /one unified tool prompt/);
assert.match(lagunaPatch, /agent_cowork_tool_schemas/);
assert.match(read('patch/ds4-agent-jsonl/069.replace'), /reasoning_start/,
  'live Cowork and Agent reasoning should open its disclosure before the first token');
assert.match(read('patch/ds4-agent-jsonl/069.laguna.replace'), /reasoning_start/,
  'Laguna reasoning should use the same structured disclosure event');
assert.match(makefile, /extension\/cowork/);

console.log('ds4-cowork contract: ok');

// Explicit model-free browser matrix. Every suite below owns its simulated
// HTTP runtime; this runner never starts DStudio, an engine or a weight download.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

const suites = [
  'ui_loading_playwright_test', 'ui_loading_startup_playwright_test',
  'ui_sidebar_playwright_test', 'ui_model_picker_playwright_test',
  'ui_agent_design_playwright_test', 'ui_gear_popover_test',
  'ui_think_max_context_test', 'ui_attachment_preview_playwright_test',
  'ui_chat_images_playwright_test', 'ui_chat_controls_playwright_test', 'ui_stream_selection_playwright_test',
  'ui_selection_stability_playwright_test', 'ui_stream_interaction_playwright_test',
  'ui_reasoning_spacing_test', 'ui_roadmap_playwright_test', 'ui_roadmap_hover_controls_playwright_test',
  'ui_settings_redesign_playwright_test', 'ui_video_generation_playwright_test',
  'ui_research_progress_playwright_test', 'ui_launch_control_playwright_test',
  'ui_plan_mode_playwright_test', 'ui_plan_mode_matrix_test',
  'ui_gsa_playwright_test', 'ui_rsa_playwright_test', 'ui_workflow_playwright_test',
];
const browsers = process.env.DSTUDIO_TEST_BROWSER ? [process.env.DSTUDIO_TEST_BROWSER] : ['webkit', 'chromium'];
assert.ok(browsers.every(browser => ['webkit', 'chromium'].includes(browser)));
const executions = [
  ...suites.map(suite => ({ suite, name: suite })),
  ...['qwen38', 'qwen35', 'qwen27'].map(model => ({ suite: 'ui_roadmap_playwright_test',
    name: `ui_roadmap_${model}_stale_checkout`, model })),
];
fs.mkdirSync('tests/.artifacts/ui-simulated', { recursive: true });
const dir = fs.mkdtempSync('tests/.artifacts/ui-simulated/run-');
const report = { scope: 'Production UI in real WebKit/Chromium; all inference, tools, installs and downloads simulated',
  startedAt: new Date().toISOString(), cases: [] };
const save = () => fs.writeFileSync(path.join(dir, 'receipt.json'), JSON.stringify(report, null, 2) + '\n');
const digest = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
console.log(`Simulated UI matrix: ${dir}`);

for (const browser of browsers) for (const { suite, name, model } of executions) {
  const file = path.join('tests/browser', suite + '.mjs');
  const sources = Object.fromEntries(['web/index.html', 'web/loading.html', file,
    'tests/support/ui_mock_server.mjs', 'tests/support/ui_stream_fixture.mjs'].map(file => [file, digest(file)]));
  const fd = fs.openSync(path.join(dir, `${browser}-${name}.log`), 'wx');
  const started = performance.now();
  const env = { ...process.env, DSTUDIO_TEST_BROWSER: browser };
  // A focused local replay must not silently shrink the complete matrix.
  delete env.DSTUDIO_SELECTION_CASE;
  delete env.DSTUDIO_STABILITY_CASE;
  delete env.DSTUDIO_STABILITY_DOCUMENT;
  delete env.DSTUDIO_INTERACTION_CASE;
  delete env.DSTUDIO_INTERACTION_DOCUMENT;
  delete env.DSTUDIO_ROADMAP_HOVER_DOCUMENT;
  delete env.DSTUDIO_TEST_MODEL;
  delete env.DSTUDIO_TEST_STALE_CHECKOUT;
  if (model) { env.DSTUDIO_TEST_MODEL = model; env.DSTUDIO_TEST_STALE_CHECKOUT = '1'; }
  let timedOut = false;
  const child = spawn(process.execPath, [file], { env, detached: process.platform !== 'win32', stdio: ['ignore', fd, fd] });
  fs.closeSync(fd);
  const signal = name => {
    try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, name); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  };
  let escalation;
  // This deadline belongs to an isolated test process, never to production
  // generation. Only this runner's child group can be terminated.
  const deadline = setTimeout(() => {
    timedOut = true; signal('SIGTERM');
    escalation = setTimeout(() => signal('SIGKILL'), 2000);
  }, 180000);
  const result = await new Promise(resolve => {
    child.once('error', error => resolve({ error: String(error) }));
    child.once('exit', (exitCode, terminationSignal) => resolve({ exitCode, terminationSignal }));
  });
  clearTimeout(deadline); clearTimeout(escalation);
  const row = { browser, suite, name, model, status: !timedOut && result.exitCode === 0 ? 'PASS' : 'FAIL',
    ...result, timedOut, sources, elapsedSeconds: Math.round((performance.now() - started) / 100) / 10 };
  report.cases.push(row); save();
  console.log(`${browser} ${name}: ${row.status}`);
}
report.finishedAt = new Date().toISOString(); save();
const passed = report.cases.filter(row => row.status === 'PASS').length;
console.log(`${passed}/${report.cases.length} passing; receipt: ${dir}/receipt.json`);
if (passed !== report.cases.length) process.exitCode = 1;

#!/usr/bin/env bash
set -euo pipefail

bin="${1:?usage: http_lan_test.sh /path/to/dstudio-server-test}"
if ! command -v curl >/dev/null 2>&1; then
  echo "http_lan_test: curl missing, skipping"
  exit 0
fi
if ! command -v node >/dev/null 2>&1; then
  echo "http_lan_test: node missing, skipping"
  exit 0
fi

tmp="$(mktemp -d "${TMPDIR:-/tmp}/dstudio-lan-test.XXXXXX")"
pid=""
cleanup() {
  if [ -n "${pid}" ] && kill -0 "${pid}" >/dev/null 2>&1; then
    kill "${pid}" >/dev/null 2>&1 || true
    wait "${pid}" >/dev/null 2>&1 || true
  fi
  rm -rf "${tmp}"
}
trap cleanup EXIT

mkdir -p "${tmp}/home" "${tmp}/ds4"
mkdir -p "${tmp}/project/src"
printf '%s\n' 'export async function getUser(req, db) { return db.user.findUnique({ where: { id: req.query.id } }); }' >"${tmp}/project/src/api.ts"
printf '%s\n' 'export function verifyJwt(token) { return jwt.verify(token, process.env.JWT_SECRET); }' >"${tmp}/project/src/auth.ts"
printf '%s\n' 'POST /api/users/:id/delete requires tenant_id and admin role' >"${tmp}/project/openapi.txt"
port="$(
  node - <<'NODE'
const net = require('net');
const s = net.createServer();
s.listen(0, '127.0.0.1', () => {
  const port = s.address().port;
  s.close(() => process.stdout.write(String(port)));
});
NODE
)"

HOME="${tmp}/home" DS4UI_TEST_MODE=1 DSTUDIO_IMAGE_TEST_MODE=1 DSTUDIO_GSA_INSTALL_DRY_RUN=1 DS4UI_PAGE_FROM_DISK=1 "${bin}" "${port}" "${tmp}/ds4" >"${tmp}/server.log" 2>&1 &
pid="$!"

base="http://127.0.0.1:${port}"
for _ in $(seq 1 80); do
  if curl -fsS --max-time 1 "${base}/api/status" >"${tmp}/status.json" 2>/dev/null; then
    break
  fi
  sleep 0.1
done
curl -fsS --max-time 2 "${base}/api/status" >"${tmp}/status.json"
curl -fsS --max-time 2 "${base}/api/lan-health" >"${tmp}/lan-health-local.json"
curl -fsS --max-time 2 "${base}/api/diagnostics" >"${tmp}/diagnostics.json"
curl -fsS --max-time 2 "${base}/api/logs?limit=10" >"${tmp}/logs.json"
curl -fsS --max-time 2 "${base}/api/tasks?limit=10" >"${tmp}/tasks.json"
curl -fsS --max-time 2 "${base}/api/embed/status" >"${tmp}/embed-status.json"
curl -fsS --max-time 2 "${base}/api/skills/get?id=analytics" >"${tmp}/skill-analytics.json"
curl -fsS --max-time 10 -X POST "${base}/api/image/generate" \
  -H 'Content-Type: application/json' -H 'X-Requested-With: ds4web' \
  -d '{"prompt":"test image","job":"image-http-test"}' >"${tmp}/image-generate.json"
curl -fsS --max-time 2 "${base}/api/image/progress?id=image-http-test" >"${tmp}/image-progress.json"
curl -fsS --max-time 10 -X POST "${base}/api/image/generate" \
  -H 'Content-Type: application/json' -H 'X-Requested-With: ds4web' \
  -d '{"action":"edit","prompt":"make it blue","preserve":"face","image":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=","referenceImage":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=","job":"image-edit-http-test"}' >"${tmp}/image-edit.json"
[ -s "${tmp}/home/.dstudio/qwen-image/jobs/image-edit-http-test/source.png" ]
[ -s "${tmp}/home/.dstudio/qwen-image/jobs/image-edit-http-test/reference.png" ]
curl -fsS --max-time 2 "${base}/api/image/progress?id=image-edit-http-test" >"${tmp}/image-edit-progress.json"
node - "${tmp}/agent-send-large.json" <<'NODE'
const fs = require('fs');
const text = 'technical architecture prompt '.repeat(3000);
fs.writeFileSync(process.argv[2], JSON.stringify({ prompt: text, displayPrompt: text }));
NODE
curl -sS --max-time 5 -o "${tmp}/agent-send-large-response.json" -w "%{http_code}" \
  -X POST "${base}/api/agent/send" \
  -H 'Content-Type: application/json' -H 'X-Requested-With: ds4web' \
  --data-binary @"${tmp}/agent-send-large.json" >"${tmp}/agent-send-large-code.txt"
curl -fsS --max-time 2 "${base}/api/gsa/tools" >"${tmp}/gsa-tools-before.json"
curl -fsS --max-time 5 -X POST "${base}/api/gsa/tools/install" \
  -H 'Content-Type: application/json' -H 'X-Requested-With: ds4web' >"${tmp}/gsa-tools-install.json"
curl -fsS --max-time 2 "${base}/api/gsa/tools" >"${tmp}/gsa-tools-after.json"
curl -fsS --max-time 2 "${base}/loading.html" >"${tmp}/loading.html"
grep -q 'startWithSavedSettings' "${tmp}/loading.html"
if grep -q 'hello are you alive' "${tmp}/loading.html"; then
  echo "loading page must not block startup on a model generation" >&2
  exit 1
fi
grep -q 'lanClientHost' "${tmp}/loading.html"
grep -q 'settings.onboarded !== true' "${tmp}/loading.html"
curl -fsS --max-time 2 "${base}/?firstLaunch=1" >"${tmp}/root-query.html"
grep -q 'DStudio' "${tmp}/root-query.html"
curl -fsS --max-time 2 "${base}/index.html?firstLaunch=1" >"${tmp}/index-query.html"
grep -q 'DStudio' "${tmp}/index-query.html"
node - "${tmp}/status.json" <<'NODE'
const fs = require('fs');
const st = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (st.lan !== false) throw new Error('server should start localhost-only');
if (st.httpPort <= 0) throw new Error('status.httpPort missing');
NODE
node - "${tmp}/lan-health-local.json" <<'NODE'
const fs = require('fs');
const h = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (!h.ok || h.app !== 'DStudio') throw new Error('lan-health should identify DStudio');
if (h.lan !== false) throw new Error('lan-health should start localhost-only');
NODE
node - "${tmp}/diagnostics.json" "${tmp}/logs.json" "${tmp}/tasks.json" <<'NODE'
const fs = require('fs');
const diag = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const logs = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
const tasks = JSON.parse(fs.readFileSync(process.argv[4], 'utf8'));
if (!diag.ok || !diag.summary || !diag.runtime || !diag.tasks || !diag.logs) throw new Error('diagnostics shape incomplete');
if (!logs.ok || !Array.isArray(logs.logs) || typeof logs.seq !== 'number') throw new Error('logs shape incomplete');
if (!tasks.ok || !Array.isArray(tasks.tasks) || typeof tasks.seq !== 'number') throw new Error('tasks shape incomplete');
NODE
node - "${tmp}/embed-status.json" <<'NODE'
const fs = require('fs');
const r = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (!r.ok || r.supported !== true || typeof r.installed !== 'boolean' || typeof r.state !== 'string') {
  throw new Error('embedding status shape incomplete');
}
NODE
node - "${tmp}/skill-analytics.json" <<'NODE'
const fs = require('fs');
const r = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (!r.ok || r.id !== 'analytics' || r.source !== 'dstudio') throw new Error('skill get should load shipped analytics metadata');
if (!String(r.body || '').includes('Analytics Tracking')) throw new Error('skill get should include the shipped skill body');
if (!String(r.modes || '').includes('agent')) throw new Error('skill get should preserve shipped modes');
NODE
node - "${tmp}/image-generate.json" "${tmp}/image-progress.json" <<'NODE'
const fs = require('fs');
const generated = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const progress = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
if (!generated.ok || !generated.url || generated.id !== 'image-http-test') throw new Error(`image generation response incomplete: ${JSON.stringify(generated)}`);
if (!progress.ok || progress.state !== 'complete' || progress.progress !== 100) throw new Error(`image progress should reach complete: ${JSON.stringify(progress)}`);
NODE
node - "${tmp}/image-edit.json" "${tmp}/image-edit-progress.json" <<'NODE'
const fs = require('fs');
const edited = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const progress = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
if (!edited.ok || !edited.url || edited.id !== 'image-edit-http-test') throw new Error(`image edit response incomplete: ${JSON.stringify(edited)}`);
if (!progress.ok || progress.state !== 'complete' || progress.progress !== 100) throw new Error(`image edit progress should reach complete: ${JSON.stringify(progress)}`);
NODE
node - "${tmp}/agent-send-large-code.txt" "${tmp}/agent-send-large-response.json" <<'NODE'
const fs = require('fs');
const code = fs.readFileSync(process.argv[2], 'utf8').trim();
const body = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
if (code === '413') throw new Error('large agent send should not be rejected by the generic API body cap');
if (code !== '409' || body.error !== 'agent/design runtime is not active') {
  throw new Error(`large agent send should reach the handler and fail only because no runtime is active, got ${code} ${JSON.stringify(body)}`);
}
NODE
missing_workdir_code="$(
  curl -sS -o "${tmp}/agent-missing-workdir.json" -w '%{http_code}' --max-time 5 \
    -X POST "${base}/api/start" \
    -H 'Content-Type: application/json' -H 'X-Requested-With: ds4web' \
    -d "{\"mode\":\"agent\",\"workdir\":\"${tmp}/project-missing\"}"
)"
if [ "${missing_workdir_code}" != "400" ]; then
  echo "expected missing Agent workdir to return 400, got ${missing_workdir_code}" >&2
  cat "${tmp}/agent-missing-workdir.json" >&2
  exit 1
fi
node - "${tmp}/agent-missing-workdir.json" "${tmp}/project-missing" <<'NODE'
const fs = require('fs');
const r = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (r.ok !== false || r.code !== 'workdir_missing' || r.mode !== 'agent' || r.workdir !== process.argv[3]) {
  throw new Error(`missing workdir response should be structured, got ${JSON.stringify(r)}`);
}
NODE
node - "${tmp}/gsa-tools-before.json" "${tmp}/gsa-tools-install.json" "${tmp}/gsa-tools-after.json" <<'NODE'
const fs = require('fs');
const before = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const install = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
const after = JSON.parse(fs.readFileSync(process.argv[4], 'utf8'));
for (const r of [before, install, after]) {
  if (!r.ok || !r.gsaTools || !Array.isArray(r.gsaTools.tools)) throw new Error('GSA tools shape incomplete');
}
const names = after.gsaTools.tools.map((t) => t.name).sort();
if (!names.includes('subfinder') || !names.includes('nuclei') || !names.includes('httpx') || !names.includes('plaso')) throw new Error(`GSA tool registry missing expected tools: ${names.join(',')}`);
const nuclei = after.gsaTools.tools.find((t) => t.name === 'nuclei');
if (!nuclei || !nuclei.templatesDir || typeof nuclei.templatesFound !== 'boolean' || !/NUCLEI_TEMPLATES_DIR/.test(nuclei.templateHint || '') || !/-tags/.test(nuclei.templateHint || '')) {
  throw new Error(`GSA nuclei status should expose managed templates and usage hints: ${JSON.stringify(nuclei)}`);
}
if (after.gsaTools.mode !== 'tool-assisted' || after.gsaTools.externalToolsRequired !== false) throw new Error('GSA should report optional tool-assisted mode');
if (install.installed !== 0 || !install.installSh || !install.installPs1) throw new Error('GSA install endpoint should prepare install scripts without running network installs');
if (!/tool data/.test(install.detail || '') || !/nuclei templates/.test(install.detail || '')) throw new Error(`GSA install detail should mention managed tool data: ${install.detail}`);
if (!install.taskId) throw new Error('GSA tool install should return a task id');
NODE

curl -fsS --max-time 5 -X POST "${base}/api/gsa/start" \
  -H 'Content-Type: application/json' -H 'X-Requested-With: ds4web' \
  -d "{\"workdir\":\"${tmp}/project\",\"mission\":\"backend API auth IDOR review\",\"targetUrl\":\"https://test.example/api/users/42\"}" >"${tmp}/gsa-start.json"
node - "${tmp}/gsa-start.json" <<'NODE'
const fs = require('fs');
const r = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (!r.ok || !r.runDir || !r.prompt || !r.skillCount) throw new Error('GSA start should return runDir, prompt and skillCount');
if (r.targetUrl !== 'https://test.example/api/users/42') throw new Error('GSA start should return the authorized target URL');
if (r.think !== 'max') throw new Error('GSA start should require thinking=max');
if (!r.statePath || !fs.existsSync(r.statePath)) throw new Error('GSA start should return a run_state path');
if (r.iteration !== 1) throw new Error('initial GSA run should be iteration 1');
const target = fs.readFileSync(`${r.runDir}/target.md`, 'utf8');
if (!target.includes('https://test.example/api/users/42')) throw new Error('GSA target.md should include the authorized target URL');
if (!target.includes('Authorized target host: test.example')) throw new Error('GSA target.md should include the derived target host');
if (!target.includes('tool-retry-policy.md')) throw new Error('GSA target.md should route retry behavior through the policy artifact');
if (!target.includes('toolStatus.json')) throw new Error('GSA target.md should route managed tool details through toolStatus.json');
if (!target.includes('scope.json') || !target.includes('safety-gate.json')) throw new Error('GSA target.md should mention scope and safety gate artifacts');
if (!target.includes('workbench.json') || !target.includes('web, network, forensics, reverse, code and infra')) throw new Error('GSA target.md should mention the Evidence Workbench domains');
const toolStatus = JSON.parse(fs.readFileSync(`${r.runDir}/toolStatus.json`, 'utf8'));
if (toolStatus.mode !== 'tool-assisted' || toolStatus.externalToolsRequired !== false || !Array.isArray(toolStatus.tools) || toolStatus.tools.length < 10) throw new Error('GSA tool status should list optional external tools without requiring them');
if (!fs.existsSync(`${r.runDir}/scripts/README.md`)) throw new Error('GSA should prepare a local scripts directory');
if (!fs.existsSync(`${r.runDir}/scripts_manifest.json`)) throw new Error('GSA should prepare scripts_manifest.json');
if (!fs.existsSync(`${r.runDir}/evidence.jsonl`)) throw new Error('GSA should prepare evidence.jsonl');
if (!fs.existsSync(`${r.runDir}/tool-retry-policy.md`)) throw new Error('GSA should prepare tool-retry-policy.md');
if (!fs.existsSync(`${r.runDir}/tool-retry-ledger.jsonl`)) throw new Error('GSA should prepare tool-retry-ledger.jsonl');
for (const artifact of ['scope.json', 'safety-gate.json', 'workbench.json', 'workbench.md', 'workbench-tool-runs.jsonl', 'workbench-web.jsonl', 'workbench-network.jsonl', 'workbench-forensics.jsonl', 'workbench-reverse.jsonl', 'workbench-code.jsonl', 'workbench-infra.jsonl', 'workbench-blue.jsonl', 'workbench-red.jsonl', 'workbench-purple.jsonl', 'workbench-blackhat.jsonl']) {
  if (!fs.existsSync(`${r.runDir}/${artifact}`)) throw new Error(`GSA should prepare ${artifact}`);
}
const workbench = JSON.parse(fs.readFileSync(`${r.runDir}/workbench.json`, 'utf8'));
if (!Array.isArray(workbench.domains) || !workbench.domains.some((d) => d.id === 'web') || !workbench.domains.some((d) => d.id === 'reverse') || !workbench.domains.some((d) => d.id === 'forensics') || !workbench.domains.some((d) => d.id === 'blue') || !workbench.domains.some((d) => d.id === 'blackhat')) {
  throw new Error('GSA workbench manifest should cover core and profile-specific domains');
}
const retryPolicy = fs.readFileSync(`${r.runDir}/tool-retry-policy.md`, 'utf8');
if (!retryPolicy.includes('applies to every enabled tool') || !retryPolicy.includes('A timeout is still a selected-tool failure') || !retryPolicy.includes('If `nuclei` times out') || !retryPolicy.includes('If `sqlmap` times out') || !retryPolicy.includes('semgrep') || !retryPolicy.includes('trivy') || !retryPolicy.includes('nmap') || !retryPolicy.includes('jq')) {
  throw new Error('GSA tool retry policy should be generic across all enabled tools');
}
if (fs.readFileSync(`${r.runDir}/tool-retry-ledger.jsonl`, 'utf8') !== '') throw new Error('GSA tool retry ledger should start empty');
const state = JSON.parse(fs.readFileSync(`${r.runDir}/run_state.json`, 'utf8'));
if (state.status !== 'ready' || state.phase !== 'selection' || state.targetHost !== 'test.example' || state.profileEffective !== 'passive') throw new Error('GSA run state should be ready for selection with a passive default profile');
if (fs.existsSync(`${r.runDir}/recon.sh`)) throw new Error('GSA should not write an implicit recon.sh helper');
const skills = fs.readFileSync(`${r.runDir}/skills.md`, 'utf8');
if (!skills.includes('extension/gsa/third_party/anthropic-cybersecurity-skills/skills')) throw new Error('GSA skills.md should use the vendored cybersecurity skills catalog');
if (!skills.includes('reason: catalog=anthropic-cybersecurity-skills') || !skills.includes('target_hits=') || !skills.includes('workspace_hits=')) throw new Error('GSA skills.md should explain catalog target/workspace ranking');
if (!/testing-api-for-broken-object-level-authorization|exploiting-broken-function-level-authorization/.test(skills)) throw new Error('GSA shortlist should include imported auth/API skills');
if (!r.prompt.includes('Use ONLY imported skill IDs')) throw new Error('GSA prompt should forbid generic/base skills');
if (!r.prompt.includes('Authorized target URL:')) throw new Error('GSA prompt should expose the target URL artifact context');
if (!r.prompt.includes('tool-assisted') || !r.prompt.includes('/scripts/')) throw new Error('GSA prompt should route automation through optional tools and local scripts');
if (!r.prompt.includes('tool-retry-policy.md') || !r.prompt.includes('same-tool retry') || !r.prompt.includes('timeout retry') || !r.prompt.includes('substitute/fallback')) throw new Error('GSA prompt should route retry and fallback behavior through the policy artifact');
if (!r.prompt.includes('workbench.json') || !r.prompt.includes('Evidence Workbench') || !r.prompt.includes('workbench-network.jsonl')) throw new Error('GSA prompt should expose the Evidence Workbench artifacts');
if (/recon\.sh|missing scanner/i.test(r.prompt)) throw new Error('GSA prompt should not require implicit recon helpers');
NODE
gsa_run_dir="$(node - "${tmp}/gsa-start.json" <<'NODE'
const fs = require('fs');
process.stdout.write(JSON.parse(fs.readFileSync(process.argv[2], 'utf8')).runDir);
NODE
)"
curl -fsS --max-time 5 -X POST "${base}/api/gsa/start" \
  -H 'Content-Type: application/json' -H 'X-Requested-With: ds4web' \
  -d "{\"workdir\":\"${tmp}/project\",\"mission\":\"authorized red profile should require scope authorization\",\"targetUrl\":\"https://test.example/api/users/42\",\"profile\":\"red-authorized\"}" >"${tmp}/gsa-red-start.json"
node - "${tmp}/gsa-red-start.json" <<'NODE'
const fs = require('fs');
const r = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (!r.ok || r.profileRequested !== 'red-authorized' || r.profileEffective !== 'passive') throw new Error('red-authorized without explicit authorization should downgrade to passive');
const gate = JSON.parse(fs.readFileSync(`${r.runDir}/safety-gate.json`, 'utf8'));
if (!gate.downgraded || gate.profileEffective !== 'passive' || !String(gate.blockedReasons || '').includes('authorized:true')) throw new Error('safety gate should explain red-authorized downgrade');
NODE
curl -fsS --max-time 5 -X POST "${base}/api/gsa/start" \
  -H 'Content-Type: application/json' -H 'X-Requested-With: ds4web' \
  -d "{\"workdir\":\"${tmp}/project\",\"mission\":\"black-hat profile should cover the full internal surface without scope gates\",\"targetUrl\":\"https://test.example/\",\"profile\":\"black-hat\"}" >"${tmp}/gsa-blackhat-start.json"
node - "${tmp}/gsa-blackhat-start.json" <<'NODE'
const fs = require('fs');
const r = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (!r.ok || r.profileRequested !== 'black-hat' || r.profileEffective !== 'black-hat') throw new Error('black-hat profile should remain effective without explicit scope authorization');
if (r.scopePath !== '' || r.safetyGatePath !== '') throw new Error('black-hat profile should not return scope or safety gate paths');
if (fs.existsSync(`${r.runDir}/scope.json`) || fs.existsSync(`${r.runDir}/safety-gate.json`)) throw new Error('black-hat profile should not generate scope.json or safety-gate.json');
if (/Read `scope\.json`/.test(r.prompt) || /Read scope\.json/.test(r.prompt)) throw new Error('black-hat prompt should not require reading scope.json');
const state = JSON.parse(fs.readFileSync(`${r.runDir}/run_state.json`, 'utf8'));
if (state.profileEffective !== 'black-hat' || state.scopePath !== '' || state.safetyGatePath !== '') throw new Error('black-hat run state should keep profile effective with no scope or safety gate');
NODE
gsa_blackhat_run_id="$(node - "${tmp}/gsa-blackhat-start.json" <<'NODE'
const fs = require('fs');
process.stdout.write(JSON.parse(fs.readFileSync(process.argv[2], 'utf8')).runId);
NODE
)"
gsa_blackhat_run_dir="$(node - "${tmp}/gsa-blackhat-start.json" <<'NODE'
const fs = require('fs');
process.stdout.write(JSON.parse(fs.readFileSync(process.argv[2], 'utf8')).runDir);
NODE
)"
node - "${tmp}/gsa-blackhat-selection-payload.json" "${tmp}/project" "${gsa_blackhat_run_id}" <<'NODE'
const fs = require('fs');
const output = {
  phase: 'selection',
  profileEffective: 'black-hat',
  targetUrl: 'https://test.example/',
  files: ['src/api.ts', 'src/auth.ts'],
  hypotheses: [{ title: 'API authorization path can be validated', why: 'Exercise backend validation runtime.' }],
  skills: ['testing-api-for-broken-object-level-authorization']
};
fs.writeFileSync(process.argv[2], JSON.stringify({ workdir: process.argv[3], runId: process.argv[4], phase: 'selection', output: JSON.stringify(output) }));
NODE
curl -fsS --max-time 5 -X POST "${base}/api/gsa/phase" \
  -H 'Content-Type: application/json' -H 'X-Requested-With: ds4web' \
  --data-binary @"${tmp}/gsa-blackhat-selection-payload.json" >"${tmp}/gsa-blackhat-selection-phase.json"
node - "${tmp}/gsa-blackhat-selection-phase.json" "${gsa_blackhat_run_dir}" <<'NODE'
const fs = require('fs');
const r = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const dir = process.argv[3];
if (!r.ok || r.complete !== false || !r.nextPrompt.includes('GSA Phase 2/4: preflight')) throw new Error('GSA selection should advance to preflight');
if (!r.nextPrompt.includes('validationPlan') || !r.nextPrompt.includes('semgrep_scan') || !r.nextPrompt.includes('playwright_flow')) throw new Error('GSA preflight prompt should request backend-executable validationPlan adapters');
if (!fs.existsSync(`${dir}/selection.json`) || !fs.existsSync(`${dir}/preflight.prompt.md`)) throw new Error('GSA selection should save output and next prompt');
NODE
node - "${tmp}/gsa-blackhat-preflight-payload.json" "${tmp}/project" "${gsa_blackhat_run_id}" <<'NODE'
const fs = require('fs');
const output = {
  phase: 'preflight',
  profileEffective: 'black-hat',
  hypotheses: [{
    title: 'API auth validation runtime',
    entrypoints: ['src/api.ts:1'],
    attacker: 'internal black-hat validation',
    evidence_needed: ['Run Semgrep adapter and reject unsupported adapter deterministically.'],
    kill_criteria: ['No reachable authorization-sensitive sink.'],
    chain_candidates: ['request id -> user lookup -> tenant boundary']
  }],
  validationPlan: {
    schemaVersion: 1,
    steps: [
      { id: 'vp-semgrep', adapter: 'semgrep_scan', purpose: 'code validation adapter', inputs: { paths: ['src'] }, dependsOn: [], timeoutSec: 30, maxRetries: 0 },
      { id: 'vp-invalid', adapter: 'unsupported_adapter', purpose: 'negative adapter validation', inputs: {}, dependsOn: [], timeoutSec: 5, maxRetries: 0 }
    ]
  }
};
fs.writeFileSync(process.argv[2], JSON.stringify({ workdir: process.argv[3], runId: process.argv[4], phase: 'preflight', output: JSON.stringify(output) }));
NODE
curl -fsS --max-time 10 -X POST "${base}/api/gsa/phase" \
  -H 'Content-Type: application/json' -H 'X-Requested-With: ds4web' \
  --data-binary @"${tmp}/gsa-blackhat-preflight-payload.json" >"${tmp}/gsa-blackhat-preflight-phase.json"
node - "${tmp}/gsa-blackhat-preflight-phase.json" "${gsa_blackhat_run_dir}" <<'NODE'
const fs = require('fs');
const r = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const dir = process.argv[3];
if (!r.ok || r.complete !== false || !r.nextPrompt.includes('GSA Phase 3/4: validation')) throw new Error('GSA preflight should advance to validation');
for (const key of ['validationPlanPath', 'validationResultsPath', 'evidenceGraphPath']) {
  if (!r[key] || !fs.existsSync(r[key])) throw new Error(`GSA preflight response should return existing ${key}`);
}
for (const artifact of ['validation-plan.json', 'validation-results.json', 'evidence-graph.json', 'workbench-tool-runs.jsonl', 'workbench-code.jsonl', 'evidence.jsonl']) {
  if (!fs.existsSync(`${dir}/${artifact}`)) throw new Error(`GSA validation runtime should prepare ${artifact}`);
}
const plan = JSON.parse(fs.readFileSync(`${dir}/validation-plan.json`, 'utf8'));
if (plan.profile !== 'black-hat' || !Array.isArray(plan.steps) || plan.steps.length < 2 || !plan.steps.some((s) => s.adapter === 'semgrep_scan')) throw new Error('validation-plan.json should capture black-hat executable steps');
const results = JSON.parse(fs.readFileSync(`${dir}/validation-results.json`, 'utf8'));
if (!Array.isArray(results.steps) || results.steps.length < 2) throw new Error('validation-results.json should record executor steps');
if (!results.steps.some((s) => s.adapter === 'semgrep_scan' && s.status === 'skipped')) throw new Error('test-mode Semgrep adapter should be recorded as skipped');
if (!results.steps.some((s) => s.adapter === 'unsupported_adapter' && s.status === 'failed')) throw new Error('unsupported adapter should be recorded as failed, not crash the run');
const graph = JSON.parse(fs.readFileSync(`${dir}/evidence-graph.json`, 'utf8'));
if (!Array.isArray(graph.nodes) || !Array.isArray(graph.edges) || !Array.isArray(graph.missingLinks) || !graph.missingLinks.length) throw new Error('evidence-graph.json should link steps and missing evidence');
const ledger = fs.readFileSync(`${dir}/tool-retry-ledger.jsonl`, 'utf8');
if (!ledger.includes('unsupported validation adapter rejected')) throw new Error('failed adapter should be recorded in retry ledger');
if (!r.nextPrompt.includes('validation-results.json') || !r.nextPrompt.includes('Backend validation-results.json') || !r.nextPrompt.includes('evidence-graph.json')) throw new Error('validation prompt should inline backend executor artifacts');
if (fs.existsSync(`${dir}/scope.json`) || fs.existsSync(`${dir}/safety-gate.json`)) throw new Error('black-hat validation runtime should not create scope/safety gate artifacts');
NODE
legacy_blackhat_code="$(
  curl -sS -o "${tmp}/gsa-blackhat-legacy-start.json" -w '%{http_code}' --max-time 5 \
    -X POST "${base}/api/gsa/start" \
    -H 'Content-Type: application/json' -H 'X-Requested-With: ds4web' \
    -d "{\"workdir\":\"${tmp}/project\",\"mission\":\"legacy black-hat-emulation should not be accepted\",\"targetUrl\":\"https://test.example/\",\"profile\":\"black-hat-emulation\"}"
)"
if [ "${legacy_blackhat_code}" != "400" ]; then
  echo "expected legacy black-hat-emulation profile to return 400, got ${legacy_blackhat_code}" >&2
  cat "${tmp}/gsa-blackhat-legacy-start.json" >&2
  exit 1
fi
node - "${tmp}/gsa-blackhat-legacy-start.json" <<'NODE'
const fs = require('fs');
const r = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (r.ok !== false || !String(r.error || '').includes('invalid security profile')) throw new Error('legacy black-hat-emulation should be rejected, not downgraded');
NODE
parent_code="$(
  curl -sS -o "${tmp}/gsa-parent-incomplete.json" -w '%{http_code}' --max-time 5 \
    -X POST "${base}/api/gsa/start" \
    -H 'Content-Type: application/json' -H 'X-Requested-With: ds4web' \
    -d "{\"workdir\":\"${tmp}/project\",\"mission\":\"loop should not continue incomplete parent\",\"targetUrl\":\"https://test.example/api/users/42\",\"parentRunDir\":\"${gsa_run_dir}\"}"
)"
if [ "${parent_code}" != "409" ]; then
  echo "expected GSA parent incomplete start to return 409, got ${parent_code}" >&2
  cat "${tmp}/gsa-parent-incomplete.json" >&2
  exit 1
fi
phase_code="$(
  curl -sS -o "${tmp}/gsa-phase-invalid.json" -w '%{http_code}' --max-time 5 \
    -X POST "${base}/api/gsa/phase" \
    -H 'Content-Type: application/json' -H 'X-Requested-With: ds4web' \
    -d "{\"workdir\":\"${tmp}/project\",\"runId\":\"$(basename "${gsa_run_dir}")\",\"phase\":\"selection\",\"output\":\"not json\"}"
)"
if [ "${phase_code}" != "400" ]; then
  echo "expected invalid GSA phase to return 400, got ${phase_code}" >&2
  cat "${tmp}/gsa-phase-invalid.json" >&2
  exit 1
fi
node - "${tmp}/gsa-phase-invalid.json" "${gsa_run_dir}/run_state.json" <<'NODE'
const fs = require('fs');
const phase = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (phase.ok !== false || !phase.error || !phase.invalidOutputPath) throw new Error('invalid GSA phase should return structured error details');
const state = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
if (state.status !== 'incomplete' || state.phase !== 'selection' || !state.error) throw new Error('invalid GSA phase should mark run_state incomplete');
NODE
node - "${gsa_run_dir}/toolStatus.json" <<'NODE'
const fs = require('fs');
const s = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (s.externalToolsRequired !== false || s.mode !== 'tool-assisted') throw new Error('GSA toolStatus should remain optional tool-assisted');
NODE

curl -fsS --max-time 2 "${base}/api/rsa/tools" >"${tmp}/rsa-tools.json"
node - "${tmp}/rsa-tools.json" <<'NODE'
const fs = require('fs');
const r = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (!r.ok || !r.rsaTools || !Array.isArray(r.rsaTools.tools)) throw new Error('RSA tools shape incomplete');
if (r.rsaTools.externalToolsRequired !== false || r.rsaTools.mode !== 'tool-assisted') throw new Error('RSA should share optional tool-assisted mode');
NODE
node - "${tmp}/rsa-start-payload.json" "${tmp}/project" <<'NODE'
const fs = require('fs');
fs.writeFileSync(process.argv[2], JSON.stringify({
  workdir: process.argv[3],
  targetUrl: 'https://streamrecorder.io/',
  mission: 'Reverse the public website structure of https://streamrecorder.io into STRUCTURE.MD using passive evidence only.'
}));
NODE
curl -fsS --max-time 5 -X POST "${base}/api/rsa/start" \
  -H 'Content-Type: application/json' -H 'X-Requested-With: ds4web' \
  --data-binary @"${tmp}/rsa-start-payload.json" >"${tmp}/rsa-start.json"
node - "${tmp}/rsa-start.json" <<'NODE'
const fs = require('fs');
const r = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (!r.ok || !r.runId || !r.runDir || !r.statePath || !r.structurePath || !r.prompt) throw new Error('RSA start should return run metadata and prompt');
if (r.think !== 'max') throw new Error('RSA start should force thinking=max');
if (r.skillCount < 4) throw new Error('RSA should expose dedicated RSA skills');
if (r.targetUrl !== 'https://streamrecorder.io/') throw new Error('RSA start should preserve target URL');
if (!fs.existsSync(r.statePath)) throw new Error('RSA run_state should exist');
if (!fs.existsSync(r.structurePath)) throw new Error('RSA should seed STRUCTURE.MD');
for (const artifact of ['scope.json', 'safety-gate.json', 'collectors.json', 'claims.jsonl', 'claim-audit.json', 'quality-gate.json', 'route-graph.json', 'tool-retry-policy.md', 'tool-retry-ledger.jsonl', 'workbench.json', 'workbench.md', 'workbench-tool-runs.jsonl', 'workbench-web.jsonl', 'workbench-network.jsonl', 'workbench-forensics.jsonl', 'workbench-reverse.jsonl', 'workbench-code.jsonl', 'workbench-infra.jsonl', 'workbench-blue.jsonl', 'workbench-red.jsonl', 'workbench-purple.jsonl', 'workbench-blackhat.jsonl']) {
  if (!fs.existsSync(`${r.runDir}/${artifact}`)) throw new Error(`RSA should prepare ${artifact}`);
}
const rsaTarget = fs.readFileSync(`${r.runDir}/target.md`, 'utf8');
if (!rsaTarget.includes('tool-retry-policy.md') || !rsaTarget.includes('retried with the same tool')) throw new Error('RSA target.md should mention same-tool retry before fallback');
if (!rsaTarget.includes('scope.json') || !rsaTarget.includes('safety-gate.json')) throw new Error('RSA target.md should mention scope and safety gate artifacts');
if (!rsaTarget.includes('workbench.json') || !rsaTarget.includes('web, network, forensics, reverse, code and infra')) throw new Error('RSA target.md should mention the Evidence Workbench domains');
const workbench = JSON.parse(fs.readFileSync(`${r.runDir}/workbench.json`, 'utf8'));
if (!Array.isArray(workbench.domains) || !workbench.domains.some((d) => d.id === 'web') || !workbench.domains.some((d) => d.id === 'network') || !workbench.domains.some((d) => d.id === 'reverse') || !workbench.domains.some((d) => d.id === 'purple') || !workbench.domains.some((d) => d.id === 'blackhat')) {
  throw new Error('RSA workbench manifest should cover core and profile-specific domains');
}
const retryPolicy = fs.readFileSync(`${r.runDir}/tool-retry-policy.md`, 'utf8');
if (!retryPolicy.includes('applies to every enabled tool') || !retryPolicy.includes('A timeout is still a selected-tool failure') || !retryPolicy.includes('playwright') || !retryPolicy.includes('semgrep') || !retryPolicy.includes('jq')) {
  throw new Error('RSA shared tool retry policy should be generic across all enabled tools');
}
if (fs.readFileSync(`${r.runDir}/tool-retry-ledger.jsonl`, 'utf8') !== '') throw new Error('RSA tool retry ledger should start empty');
const structure = fs.readFileSync(r.structurePath, 'utf8');
if (!structure.includes('# Reverse Structure Analysis') || !structure.includes('[UNKNOWN] Not enriched yet')) throw new Error('RSA should seed a labeled STRUCTURE.MD');
const collectors = JSON.parse(fs.readFileSync(`${r.runDir}/collectors.json`, 'utf8'));
if (!Array.isArray(collectors.deterministicCollectors) || collectors.deterministicCollectors.length < 8) throw new Error('RSA should seed deterministic collectors');
if (!collectors.deterministicCollectors.some((c) => c.id === 'claim_evidence_audit')) throw new Error('RSA collector manifest should include claim_evidence_audit');
const state = JSON.parse(fs.readFileSync(r.statePath, 'utf8'));
if (state.module !== 'rsa' || state.status !== 'ready' || state.phase !== 'inventory' || state.iteration !== 1 || state.profileEffective !== 'passive') throw new Error('RSA run_state should start at inventory with passive default profile');
const skills = fs.readFileSync(`${r.runDir}/skills.md`, 'utf8');
for (const id of ['rsa-structure-reconstruction', 'rsa-frontend-api-map', 'rsa-media-storage-pipeline', 'rsa-product-system-model']) {
  if (!skills.includes(id)) throw new Error(`RSA skills.md missing ${id}`);
}
if (skills.includes('web-app')) throw new Error('RSA skills should not fall back to the removed web-app skill');
if (!r.prompt.includes('RSA Phase 1/4: inventory') || !r.prompt.includes('No fuzzing')) throw new Error('RSA prompt should describe the bounded passive inventory phase');
if (!r.prompt.includes('Tool retry rule') || !r.prompt.includes('do not degrade to curl') || !r.prompt.includes('retry that same tool') || !r.prompt.includes('corrected timeout budget')) throw new Error('RSA prompt should enforce same-tool retry before fallback');
if (!r.prompt.includes('Evidence Workbench rule') || !r.prompt.includes('workbench.json') || !r.prompt.includes('workbench.md')) throw new Error('RSA prompt should expose the Evidence Workbench artifacts');
NODE
curl -fsS --max-time 5 -X POST "${base}/api/rsa/start" \
  -H 'Content-Type: application/json' -H 'X-Requested-With: ds4web' \
  -d "{\"workdir\":\"${tmp}/project\",\"mission\":\"black-hat RSA should not use scope gates\",\"targetUrl\":\"https://streamrecorder.io/\",\"profile\":\"black-hat\"}" >"${tmp}/rsa-blackhat-start.json"
node - "${tmp}/rsa-blackhat-start.json" <<'NODE'
const fs = require('fs');
const r = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (!r.ok || r.profileRequested !== 'black-hat' || r.profileEffective !== 'black-hat') throw new Error('RSA black-hat profile should remain effective without explicit scope authorization');
if (r.scopePath !== '' || r.safetyGatePath !== '') throw new Error('RSA black-hat should not return scope or safety gate paths');
if (fs.existsSync(`${r.runDir}/scope.json`) || fs.existsSync(`${r.runDir}/safety-gate.json`)) throw new Error('RSA black-hat should not generate scope.json or safety-gate.json');
if (/Read scope\.json/.test(r.prompt) || /Read `scope\.json`/.test(r.prompt)) throw new Error('RSA black-hat prompt should not require reading scope.json');
const state = JSON.parse(fs.readFileSync(`${r.runDir}/run_state.json`, 'utf8'));
if (state.profileEffective !== 'black-hat' || state.scopePath !== '' || state.safetyGatePath !== '') throw new Error('RSA black-hat run state should keep profile effective with no scope or safety gate');
NODE
rsa_legacy_blackhat_code="$(
  curl -sS -o "${tmp}/rsa-blackhat-legacy-start.json" -w '%{http_code}' --max-time 5 \
    -X POST "${base}/api/rsa/start" \
    -H 'Content-Type: application/json' -H 'X-Requested-With: ds4web' \
    -d "{\"workdir\":\"${tmp}/project\",\"mission\":\"legacy black-hat-emulation should not be accepted by RSA\",\"targetUrl\":\"https://streamrecorder.io/\",\"profile\":\"black-hat-emulation\"}"
)"
if [ "${rsa_legacy_blackhat_code}" != "400" ]; then
  echo "expected legacy RSA black-hat-emulation profile to return 400, got ${rsa_legacy_blackhat_code}" >&2
  cat "${tmp}/rsa-blackhat-legacy-start.json" >&2
  exit 1
fi
node - "${tmp}/rsa-blackhat-legacy-start.json" <<'NODE'
const fs = require('fs');
const r = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (r.ok !== false || !String(r.error || '').includes('invalid security profile')) throw new Error('legacy RSA black-hat-emulation should be rejected, not downgraded');
NODE
rsa_run_id="$(node - "${tmp}/rsa-start.json" <<'NODE'
const fs = require('fs');
process.stdout.write(JSON.parse(fs.readFileSync(process.argv[2], 'utf8')).runId);
NODE
)"
rsa_run_dir="$(node - "${tmp}/rsa-start.json" <<'NODE'
const fs = require('fs');
process.stdout.write(JSON.parse(fs.readFileSync(process.argv[2], 'utf8')).runDir);
NODE
)"
rsa_structure_path="$(node - "${tmp}/rsa-start.json" <<'NODE'
const fs = require('fs');
process.stdout.write(JSON.parse(fs.readFileSync(process.argv[2], 'utf8')).structurePath);
NODE
)"
node - "${tmp}/rsa-inventory-payload.json" "${tmp}/project" "${rsa_run_id}" <<'NODE'
const fs = require('fs');
const output = {
  phase: 'inventory',
  kind: 'rsa',
  targetUrl: 'https://streamrecorder.io/',
  targetHost: 'streamrecorder.io',
  surface: [{ url: 'https://streamrecorder.io/', type: 'page', evidence: 'Public homepage selected for capture.' }],
  sections: [{ name: 'Frontend Architecture', status: 'weak', nextEvidence: 'Capture public HTML, scripts and initial network requests.' }],
  skills: ['rsa-structure-reconstruction'],
  nextActions: ['Capture public homepage HTML and asset URLs.']
};
fs.writeFileSync(process.argv[2], JSON.stringify({ workdir: process.argv[3], runId: process.argv[4], phase: 'inventory', output: JSON.stringify(output) }));
NODE
curl -fsS --max-time 5 -X POST "${base}/api/rsa/phase" \
  -H 'Content-Type: application/json' -H 'X-Requested-With: ds4web' \
  --data-binary @"${tmp}/rsa-inventory-payload.json" >"${tmp}/rsa-inventory.json"
node - "${tmp}/rsa-inventory.json" "${rsa_run_dir}" <<'NODE'
const fs = require('fs');
const r = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const dir = process.argv[3];
if (!r.ok || r.complete !== false || !r.nextPrompt.includes('RSA Phase 2/4: capture')) throw new Error('RSA inventory should advance to capture');
if (!r.nextPrompt.includes('tool-retry-policy.md') || !r.nextPrompt.includes('This applies to all optional tools') || !r.nextPrompt.includes('Do not jump directly')) throw new Error('RSA capture prompt should enforce same-tool retry across optional tools');
if (!r.nextPrompt.includes('workbench-web.jsonl') || !r.nextPrompt.includes('workbench-forensics.jsonl') || !r.nextPrompt.includes('workbench-reverse.jsonl')) throw new Error('RSA capture prompt should instruct agents to populate Evidence Workbench domain files');
if (!fs.existsSync(`${dir}/inventory.json`) || !fs.existsSync(`${dir}/capture.prompt.md`)) throw new Error('RSA inventory should save output and next prompt');
const state = JSON.parse(fs.readFileSync(`${dir}/run_state.json`, 'utf8'));
if (state.status !== 'working' || state.phase !== 'capture') throw new Error('RSA state should advance to capture');
NODE
node - "${tmp}/rsa-capture-payload.json" "${tmp}/project" "${rsa_run_id}" <<'NODE'
const fs = require('fs');
const output = {
  phase: 'capture',
  kind: 'rsa',
  evidence: [{ status: 'VERIFIED', source: 'url', evidence: 'Public homepage URL exists as capture target.', confidence: 'high' }],
  files: ['evidence.jsonl'],
  sectionsReady: ['Frontend Architecture'],
  unknowns: ['Backend internals are not externally visible.']
};
fs.writeFileSync(process.argv[2], JSON.stringify({ workdir: process.argv[3], runId: process.argv[4], phase: 'capture', output: JSON.stringify(output) }));
NODE
curl -fsS --max-time 5 -X POST "${base}/api/rsa/phase" \
  -H 'Content-Type: application/json' -H 'X-Requested-With: ds4web' \
  --data-binary @"${tmp}/rsa-capture-payload.json" >"${tmp}/rsa-capture.json"
node - "${tmp}/rsa-capture.json" "${rsa_run_dir}" <<'NODE'
const fs = require('fs');
const r = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const dir = process.argv[3];
if (!r.ok || r.complete !== false || !r.nextPrompt.includes('RSA Phase 3/4: structure')) throw new Error('RSA capture should advance to structure');
const state = JSON.parse(fs.readFileSync(`${dir}/run_state.json`, 'utf8'));
if (state.status !== 'working' || state.phase !== 'structure') throw new Error('RSA state should advance to structure');
NODE
node - "${tmp}/rsa-structure-payload.json" "${tmp}/project" "${rsa_run_id}" "${rsa_structure_path}" <<'NODE'
const fs = require('fs');
const output = {
  phase: 'structure',
  kind: 'rsa',
  structurePath: process.argv[5],
  updatedSections: ['Frontend Architecture'],
  claims: [{ status: 'VERIFIED', section: 'Frontend Architecture', evidence: 'Public homepage selected and captured as a normal navigation target.' }],
  unknowns: ['Backend internals remain unknown without public evidence.'],
  nextTargets: ['Public API Surface']
};
fs.writeFileSync(process.argv[2], JSON.stringify({ workdir: process.argv[3], runId: process.argv[4], phase: 'structure', output: JSON.stringify(output) }));
NODE
curl -fsS --max-time 5 -X POST "${base}/api/rsa/phase" \
  -H 'Content-Type: application/json' -H 'X-Requested-With: ds4web' \
  --data-binary @"${tmp}/rsa-structure-payload.json" >"${tmp}/rsa-structure.json"
node - "${tmp}/rsa-structure.json" "${rsa_run_dir}" <<'NODE'
const fs = require('fs');
const r = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const dir = process.argv[3];
if (!r.ok || r.complete !== false || !r.nextPrompt.includes('RSA Phase 4/4: review')) throw new Error('RSA structure should advance to review');
if (!r.claimAuditPath || !fs.existsSync(r.claimAuditPath)) throw new Error('RSA structure save should return claimAuditPath');
const state = JSON.parse(fs.readFileSync(`${dir}/run_state.json`, 'utf8'));
if (state.status !== 'working' || state.phase !== 'review') throw new Error('RSA state should advance to review');
NODE
node - "${tmp}/rsa-review-payload.json" "${tmp}/project" "${rsa_run_id}" "${rsa_structure_path}" <<'NODE'
const fs = require('fs');
const output = {
  phase: 'review',
  kind: 'rsa',
  structurePath: process.argv[5],
  status: 'complete',
  fixed: [],
  remainingUnknowns: ['Backend internals remain unknown.'],
  nextRecommendedLoop: 'Public API Surface'
};
fs.writeFileSync(process.argv[2], JSON.stringify({ workdir: process.argv[3], runId: process.argv[4], phase: 'review', output: JSON.stringify(output) }));
NODE
curl -fsS --max-time 5 -X POST "${base}/api/rsa/phase" \
  -H 'Content-Type: application/json' -H 'X-Requested-With: ds4web' \
  --data-binary @"${tmp}/rsa-review-payload.json" >"${tmp}/rsa-review.json"
node - "${tmp}/rsa-review.json" "${rsa_run_dir}" <<'NODE'
const fs = require('fs');
const r = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const dir = process.argv[3];
if (!r.ok || r.complete !== true || r.nextPrompt !== '') throw new Error('RSA review should complete the run');
if (!r.qualityGatePath || !fs.existsSync(r.qualityGatePath)) throw new Error('RSA review should return qualityGatePath');
const gate = JSON.parse(fs.readFileSync(r.qualityGatePath, 'utf8'));
if (!gate.pass || !Array.isArray(gate.checks) || gate.checks.length < 8) throw new Error('RSA quality gate should pass with detailed checks');
const state = JSON.parse(fs.readFileSync(`${dir}/run_state.json`, 'utf8'));
if (state.status !== 'complete' || state.phase !== 'review') throw new Error('RSA state should be complete after review');
NODE
node - "${tmp}/rsa-loop-payload.json" "${tmp}/project" "${rsa_run_dir}" <<'NODE'
const fs = require('fs');
fs.writeFileSync(process.argv[2], JSON.stringify({
  workdir: process.argv[3],
  targetUrl: 'https://streamrecorder.io/',
  mission: 'Continue RSA enrichment for the public API surface.',
  parentRunDir: process.argv[4]
}));
NODE
curl -fsS --max-time 5 -X POST "${base}/api/rsa/start" \
  -H 'Content-Type: application/json' -H 'X-Requested-With: ds4web' \
  --data-binary @"${tmp}/rsa-loop-payload.json" >"${tmp}/rsa-loop.json"
node - "${tmp}/rsa-loop.json" <<'NODE'
const fs = require('fs');
const r = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (!r.ok || r.iteration !== 2 || !r.parentRunDir) throw new Error('RSA should allow a second loop only after a completed parent');
if (!fs.existsSync(`${r.runDir}/loop_context.md`)) throw new Error('RSA loop should write loop_context.md');
NODE

agent_send_code="$(
  curl -sS -o "${tmp}/agent-send-inactive.json" -w '%{http_code}' --max-time 2 \
    -X POST "${base}/api/agent/send" \
    -H 'Content-Type: application/json' -H 'X-Requested-With: ds4web' \
    -d '{"prompt":"hello"}'
)"
[ "${agent_send_code}" = "409" ] || { echo "expected inactive /api/agent/send to be 409, got ${agent_send_code}"; exit 1; }
agent_task_id="$(
  node - "${tmp}/agent-send-inactive.json" <<'NODE'
const fs = require('fs');
const r = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (r.ok !== false || !r.taskId || !/runtime is not active/.test(r.error || '')) throw new Error('inactive agent send should include taskId and explicit error');
process.stdout.write(String(r.taskId));
NODE
)"
curl -fsS --max-time 2 "${base}/api/task?id=${agent_task_id}" >"${tmp}/agent-send-task.json"
curl -fsS --max-time 2 "${base}/api/diagnostics" >"${tmp}/diagnostics-after-agent-send.json"
node - "${tmp}/agent-send-task.json" "${tmp}/diagnostics-after-agent-send.json" "${agent_task_id}" <<'NODE'
const fs = require('fs');
const detail = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const diag = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
const id = Number(process.argv[4]);
if (!detail.ok || detail.task.id !== id || detail.task.status !== 'failed') throw new Error('inactive agent send task should be failed');
if (!Array.isArray(detail.events) || detail.events.length < 2) throw new Error('inactive agent send task should include lifecycle events');
if (!diag.tasks.recent.some((t) => t.id === id && t.status === 'failed')) throw new Error('diagnostics should include the failed agent task');
if (!diag.logs.recentErrors.some((l) => l.taskId === id)) throw new Error('diagnostics should include the failed task log');
NODE

store_code="$(
  curl -sS -o "${tmp}/store-no-csrf.txt" -w '%{http_code}' --max-time 2 \
    -X POST "${base}/api/store" -H 'Content-Type: application/json' -d '{"v":1}'
)"
[ "${store_code}" = "403" ] || { echo "expected POST /api/store without CSRF to be 403, got ${store_code}"; exit 1; }

lan_no_csrf_code="$(
  curl -sS -o "${tmp}/lan-no-csrf.txt" -w '%{http_code}' --max-time 2 \
    -X POST "${base}/api/lan" -H 'Content-Type: application/json' -d '{"enable":true}'
)"
[ "${lan_no_csrf_code}" = "403" ] || { echo "expected POST /api/lan without CSRF to be 403, got ${lan_no_csrf_code}"; exit 1; }

curl -fsS --max-time 2 -X POST "${base}/api/store" \
  -H 'Content-Type: application/json' -H 'X-Requested-With: ds4web' \
  -d '{"v":1,"chats":[],"deleted":[]}' >"${tmp}/store-set.json"
curl -fsS --max-time 2 "${base}/api/store" >"${tmp}/store-get.json"
node - "${tmp}/store-set.json" "${tmp}/store-get.json" <<'NODE'
const fs = require('fs');
const set = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const get = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
if (!set.ok || typeof set.rev !== 'number') throw new Error('store set failed');
if (!get.data || !Array.isArray(get.data.chats)) throw new Error('store get did not return data');
NODE

mirror='{"clientId":"client-one","clientName":"Linux box","updatedAt":1710000000000,"chats":[{"id":"chat-1","mode":"chat","title":"Chat one","updatedAt":1710000000001,"messages":[{"role":"user","content":"hi"}]},{"id":"agent-1","mode":"agent","title":"Agent one","updatedAt":1710000000002,"messages":[{"role":"user","content":"ship"}],"transcript":"agent transcript"},{"id":"design-1","mode":"design","title":"Design one","updatedAt":1710000000003,"messages":[{"role":"assistant","content":"mockup"}],"transcript":"design transcript"}]}'
curl -fsS --max-time 2 -X POST "${base}/api/lan-client/chats" \
  -H 'Content-Type: application/json' -d "${mirror}" >"${tmp}/mirror-set.json"
curl -fsS --max-time 2 "${base}/api/lan-client/chats" >"${tmp}/mirror-get.json"
node - "${tmp}/mirror-set.json" "${tmp}/mirror-get.json" <<'NODE'
const fs = require('fs');
const set = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const get = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
if (!set.ok || typeof set.rev !== 'number') throw new Error('mirror set failed');
if (!get.ok || !Array.isArray(get.clients) || get.clients.length !== 1) throw new Error('mirror get failed');
const modes = new Set(get.clients[0].chats.map((c) => c.mode));
for (const mode of ['chat', 'agent', 'design']) {
  if (!modes.has(mode)) throw new Error(`missing mirrored ${mode} conversation`);
}
NODE

invalid_code="$(
  curl -sS -o "${tmp}/mirror-invalid.txt" -w '%{http_code}' --max-time 2 \
    -X POST "${base}/api/lan-client/chats" -H 'Content-Type: application/json' \
    -d '{"clientId":"bad id","chats":[]}'
)"
[ "${invalid_code}" = "400" ] || { echo "expected invalid mirror snapshot to be 400, got ${invalid_code}"; exit 1; }

curl -isS --max-time 2 -X OPTIONS "${base}/api/lan-client/chats" >"${tmp}/options.txt"
grep -q '204 No Content' "${tmp}/options.txt"
grep -qi 'Access-Control-Allow-Origin: \*' "${tmp}/options.txt"

lan_json="$(
  curl -sS --max-time 3 -X POST "${base}/api/lan" \
    -H 'Content-Type: application/json' -H 'X-Requested-With: ds4web' \
    -d '{"enable":true}'
)"
printf '%s' "${lan_json}" >"${tmp}/lan.json"
lan_ok="$(
  node - "${tmp}/lan.json" <<'NODE'
const fs = require('fs');
const r = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (r.ok && r.lan && !r.lanAddr) throw new Error('LAN enabled without lanAddr');
process.stdout.write(r.ok && r.lan && r.lanAddr ? 'yes' : 'no');
NODE
)"

if [ "${lan_ok}" = "yes" ]; then
  lan_addr="$(node - "${tmp}/lan.json" <<'NODE'
const fs = require('fs');
const r = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
process.stdout.write(r.lanAddr);
NODE
)"
  node - "${tmp}/lan.json" "${port}" <<'NODE'
const fs = require('fs');
const r = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const requested = Number(process.argv[3]);
if (!r.lanAddr.includes(':')) throw new Error('lanAddr must include host:port');
if (r.httpPort !== requested) throw new Error(`LAN should stay on the running app port (${requested}), got ${r.httpPort}`);
NODE

  lan_base="http://${lan_addr}"
  curl -isS --max-time 4 "${lan_base}/api/lan-health" >"${tmp}/lan-health.txt" || true
  if grep -q '^HTTP/1.1 200' "${tmp}/lan-health.txt"; then
    grep -qi 'Access-Control-Allow-Origin: \*' "${tmp}/lan-health.txt"
    sed -n '/^\r$/,$p' "${tmp}/lan-health.txt" | tr -d '\r' >"${tmp}/lan-health-body.json"
    node - "${tmp}/lan-health-body.json" <<'NODE'
const fs = require('fs');
const raw = fs.readFileSync(process.argv[2], 'utf8').trim();
const h = JSON.parse(raw);
if (!h.ok || h.app !== 'DStudio' || !h.lan || !h.lanAddr) throw new Error('LAN health response incomplete');
NODE
  fi

  lan_root_code="$(
    curl -sS -o "${tmp}/lan-root.html" -w '%{http_code}' --connect-timeout 2 --max-time 4 \
      "${lan_base}/" || true
  )"
  if [ "${lan_root_code}" != "000" ] && [ "${lan_root_code}" != "200" ]; then
    echo "expected LAN GET / to be 200 or unreachable in CI, got ${lan_root_code}"
    exit 1
  fi

  lan_loading_code="$(
    curl -sS -o "${tmp}/lan-loading.html" -w '%{http_code}' --connect-timeout 2 --max-time 4 \
      "${lan_base}/loading.html" || true
  )"
  if [ "${lan_loading_code}" != "000" ] && [ "${lan_loading_code}" != "302" ]; then
    echo "expected LAN GET /loading.html to redirect to / or be unreachable in CI, got ${lan_loading_code}"
    exit 1
  fi

  lan_v1_code="$(
    curl -isS -o "${tmp}/lan-v1.txt" -w '%{http_code}' --connect-timeout 2 --max-time 4 \
      "${lan_base}/v1/models" || true
  )"
  if [ "${lan_v1_code}" != "000" ]; then
    grep -qi 'Access-Control-Allow-Origin: \*' "${tmp}/lan-v1.txt"
  fi

  for ep in /api/web-search /api/web-read /api/http-probe; do
    name="${ep##*/}"
    lan_web_options_code="$(
      curl -isS -o "${tmp}/lan-${name}-options.txt" -w '%{http_code}' --connect-timeout 2 --max-time 4 \
        -X OPTIONS "${lan_base}${ep}" || true
    )"
    if [ "${lan_web_options_code}" != "000" ] && [ "${lan_web_options_code}" != "204" ]; then
      echo "expected LAN OPTIONS ${ep} to be 204 or unreachable in CI, got ${lan_web_options_code}"
      exit 1
    fi
    if [ "${lan_web_options_code}" = "204" ]; then
      grep -qi 'Access-Control-Allow-Origin: \*' "${tmp}/lan-${name}-options.txt"
    fi

    lan_web_post_code="$(
      curl -isS -o "${tmp}/lan-${name}-post.txt" -w '%{http_code}' --connect-timeout 2 --max-time 4 \
        -X POST "${lan_base}${ep}" -H 'Content-Type: application/json' -H 'X-Requested-With: ds4web' \
        -d '{}' || true
    )"
    if [ "${lan_web_post_code}" != "000" ] && [ "${lan_web_post_code}" != "400" ]; then
      echo "expected LAN POST ${ep} with invalid JSON body to be 400 or unreachable in CI, got ${lan_web_post_code}"
      exit 1
    fi
    if [ "${lan_web_post_code}" = "400" ]; then
      grep -qi 'Access-Control-Allow-Origin: \*' "${tmp}/lan-${name}-post.txt"
    fi
  done

  lan_start_options_code="$(
    curl -isS -o "${tmp}/lan-start-options.txt" -w '%{http_code}' --connect-timeout 2 --max-time 4 \
      -X OPTIONS "${lan_base}/api/start" || true
  )"
  if [ "${lan_start_options_code}" != "000" ] && [ "${lan_start_options_code}" != "403" ]; then
    echo "expected LAN OPTIONS /api/start to be 403 or unreachable in CI, got ${lan_start_options_code}"
    exit 1
  fi

  lan_status_code="$(
    curl -isS -o "${tmp}/lan-status.txt" -w '%{http_code}' --connect-timeout 2 --max-time 4 \
      "${lan_base}/api/status" || true
  )"
  if [ "${lan_status_code}" != "000" ] && [ "${lan_status_code}" != "403" ]; then
    echo "expected LAN GET /api/status to be 403 or unreachable in CI, got ${lan_status_code}"
    exit 1
  fi

  for ep in /api/diagnostics /api/logs /api/tasks /api/task?id=1; do
    name="$(printf '%s' "${ep}" | tr '/?=' '---')"
    lan_diag_code="$(
      curl -isS -o "${tmp}/lan-${name}.txt" -w '%{http_code}' --connect-timeout 2 --max-time 4 \
        "${lan_base}${ep}" || true
    )"
    if [ "${lan_diag_code}" != "000" ] && [ "${lan_diag_code}" != "403" ]; then
      echo "expected LAN GET ${ep} to be 403 or unreachable in CI, got ${lan_diag_code}"
      exit 1
    fi
  done

  lan_design_file_code="$(
    curl -isS -o "${tmp}/lan-design-file.txt" -w '%{http_code}' --connect-timeout 2 --max-time 4 \
      "${lan_base}/api/design/file?name=missing.html" || true
  )"
  if [ "${lan_design_file_code}" != "000" ] && [ "${lan_design_file_code}" != "403" ]; then
    echo "expected LAN GET /api/design/file to be 403 or unreachable in CI, got ${lan_design_file_code}"
    exit 1
  fi

  lan_store_code="$(
    curl -sS -o "${tmp}/lan-store.txt" -w '%{http_code}' --connect-timeout 2 --max-time 4 \
      "${lan_base}/api/store" || true
  )"
  if [ "${lan_store_code}" = "200" ]; then
    echo "expected LAN GET /api/store to be host-only, got 200"
    exit 1
  fi
  if [ "${lan_store_code}" != "000" ] && [ "${lan_store_code}" != "403" ]; then
    echo "expected LAN GET /api/store to be 403 or unreachable in CI, got ${lan_store_code}"
    exit 1
  fi

  lan_mirror_get_code="$(
    curl -sS -o "${tmp}/lan-mirror-get.txt" -w '%{http_code}' --connect-timeout 2 --max-time 4 \
      "${lan_base}/api/lan-client/chats" || true
  )"
  if [ "${lan_mirror_get_code}" = "200" ]; then
    echo "expected LAN GET /api/lan-client/chats to be host-only, got 200"
    exit 1
  fi
  if [ "${lan_mirror_get_code}" != "000" ] && [ "${lan_mirror_get_code}" != "403" ]; then
    echo "expected LAN GET /api/lan-client/chats to be 403 or unreachable in CI, got ${lan_mirror_get_code}"
    exit 1
  fi

  lan_post_code="$(
    curl -sS -o "${tmp}/lan-mirror-post.txt" -w '%{http_code}' --connect-timeout 2 --max-time 4 \
      -X POST "${lan_base}/api/lan-client/chats" -H 'Content-Type: application/json' \
      -d '{"clientId":"client-two","clientName":"LAN browser","chats":[{"id":"chat-2","mode":"chat","messages":[{"role":"user","content":"from lan"}]}]}' || true
  )"
  if [ "${lan_post_code}" = "200" ]; then
    curl -fsS --max-time 2 "${base}/api/lan-client/chats" >"${tmp}/mirror-get-2.json"
    node - "${tmp}/mirror-get-2.json" <<'NODE'
const fs = require('fs');
const get = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const ids = new Set(get.clients.map((c) => c.clientId));
if (!ids.has('client-two')) throw new Error('LAN POST mirror was not visible to host');
NODE
  elif [ "${lan_post_code}" != "000" ]; then
    echo "expected LAN POST /api/lan-client/chats to be 200 or unreachable in CI, got ${lan_post_code}"
    exit 1
  fi
else
  echo "http_lan_test: LAN enable returned no routable IPv4 on this machine, non-loopback assertions skipped"
fi

curl -fsS --max-time 2 -X POST "${base}/api/lan" \
  -H 'Content-Type: application/json' -H 'X-Requested-With: ds4web' \
  -d '{"enable":false}' >"${tmp}/lan-off.json"
node - "${tmp}/lan-off.json" <<'NODE'
const fs = require('fs');
const r = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (!r.ok || r.lan !== false) throw new Error('LAN disable failed');
NODE

echo "http_lan_test: ok"

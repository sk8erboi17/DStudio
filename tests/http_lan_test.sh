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

HOME="${tmp}/home" DS4UI_TEST_MODE=1 DSTUDIO_GSA_INSTALL_DRY_RUN=1 DS4UI_PAGE_FROM_DISK=1 "${bin}" "${port}" "${tmp}/ds4" >"${tmp}/server.log" 2>&1 &
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
curl -fsS --max-time 2 "${base}/api/skills/search?q=authorization&source=anthropic&limit=5" >"${tmp}/skills-search.json"
curl -fsS --max-time 2 "${base}/api/gsa/tools" >"${tmp}/gsa-tools-before.json"
curl -fsS --max-time 5 -X POST "${base}/api/gsa/tools/install" \
  -H 'Content-Type: application/json' -H 'X-Requested-With: ds4web' >"${tmp}/gsa-tools-install.json"
curl -fsS --max-time 2 "${base}/api/gsa/tools" >"${tmp}/gsa-tools-after.json"
curl -fsS --max-time 2 "${base}/loading.html" >"${tmp}/loading.html"
grep -q 'hello are you alive' "${tmp}/loading.html"
grep -q 'lanClientHost' "${tmp}/loading.html"
grep -q 'onboardedVersion !== 8' "${tmp}/loading.html"
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
node - "${tmp}/skills-search.json" <<'NODE'
const fs = require('fs');
const r = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (!r.ok || !Array.isArray(r.skills)) throw new Error('skills search shape incomplete');
if (!r.skills.some((s) => s.source === 'anthropic-cybersecurity-skills')) throw new Error('skills search should expose vendored cybersecurity skills');
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
if (after.gsaTools.mode !== 'tool-assisted' || after.gsaTools.externalToolsRequired !== false) throw new Error('GSA should report optional tool-assisted mode');
if (install.installed !== 0 || !install.installSh || !install.installPs1) throw new Error('GSA install endpoint should prepare install scripts without running network installs');
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
const toolStatus = JSON.parse(fs.readFileSync(`${r.runDir}/toolStatus.json`, 'utf8'));
if (toolStatus.mode !== 'tool-assisted' || toolStatus.externalToolsRequired !== false || !Array.isArray(toolStatus.tools) || toolStatus.tools.length < 10) throw new Error('GSA tool status should list optional external tools without requiring them');
if (!fs.existsSync(`${r.runDir}/scripts/README.md`)) throw new Error('GSA should prepare a local scripts directory');
if (!fs.existsSync(`${r.runDir}/scripts_manifest.json`)) throw new Error('GSA should prepare scripts_manifest.json');
if (!fs.existsSync(`${r.runDir}/evidence.jsonl`)) throw new Error('GSA should prepare evidence.jsonl');
const state = JSON.parse(fs.readFileSync(`${r.runDir}/run_state.json`, 'utf8'));
if (state.status !== 'ready' || state.phase !== 'selection' || state.targetHost !== 'test.example') throw new Error('GSA run state should be ready for selection');
if (fs.existsSync(`${r.runDir}/recon.sh`)) throw new Error('GSA should not write an implicit recon.sh helper');
const skills = fs.readFileSync(`${r.runDir}/skills.md`, 'utf8');
if (!skills.includes('extension/gsa/third_party/anthropic-cybersecurity-skills/skills')) throw new Error('GSA skills.md should use the vendored cybersecurity skills catalog');
if (!skills.includes('reason: catalog=anthropic-cybersecurity-skills') || !skills.includes('target_hits=') || !skills.includes('workspace_hits=')) throw new Error('GSA skills.md should explain catalog target/workspace ranking');
if (!/testing-api-for-broken-object-level-authorization|exploiting-broken-function-level-authorization/.test(skills)) throw new Error('GSA shortlist should include imported auth/API skills');
if (!r.prompt.includes('Use ONLY imported skill IDs')) throw new Error('GSA prompt should forbid generic/base skills');
if (!r.prompt.includes('Authorized target URL:')) throw new Error('GSA prompt should expose the target URL artifact context');
if (!r.prompt.includes('tool-assisted') || !r.prompt.includes('/scripts/')) throw new Error('GSA prompt should route automation through optional tools and local scripts');
if (/recon\.sh|missing scanner/i.test(r.prompt)) throw new Error('GSA prompt should not require implicit recon helpers');
NODE
gsa_run_dir="$(node - "${tmp}/gsa-start.json" <<'NODE'
const fs = require('fs');
process.stdout.write(JSON.parse(fs.readFileSync(process.argv[2], 'utf8')).runDir);
NODE
)"
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

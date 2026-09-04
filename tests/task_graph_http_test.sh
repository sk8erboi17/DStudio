#!/usr/bin/env bash
set -euo pipefail

bin="${1:?usage: task_graph_http_test.sh /path/to/dstudio-server-test}"
if ! command -v curl >/dev/null 2>&1 || ! command -v node >/dev/null 2>&1; then
  echo "task_graph_http: curl/node missing, skipping"
  exit 0
fi

tmp="$(mktemp -d "${TMPDIR:-/tmp}/dstudio-task-graph-http.XXXXXX")"
server_pid=""
cleanup() {
  if [ -n "${server_pid}" ] && kill -0 "${server_pid}" >/dev/null 2>&1; then
    kill "${server_pid}" >/dev/null 2>&1 || true
    wait "${server_pid}" >/dev/null 2>&1 || true
  fi
  rm -rf "${tmp}"
}
trap cleanup EXIT

mkdir -p "${tmp}/home" "${tmp}/data" "${tmp}/workspace" "${tmp}/ds4/gguf"
printf '%s\n' 'all:' >"${tmp}/ds4/Makefile"
port="$(node - <<'NODE'
const net = require('net');
const s = net.createServer();
s.listen(0, '127.0.0.1', () => { const p=s.address().port; s.close(() => process.stdout.write(String(p))); });
NODE
)"
HOME="${tmp}/home" DS4UI_DATA_DIR="${tmp}/data" DS4UI_TEST_MODE=1 DS4UI_PAGE_FROM_DISK=1 \
  "${bin}" "${port}" "${tmp}/ds4" >"${tmp}/server.log" 2>&1 &
server_pid="$!"
base="http://127.0.0.1:${port}"
for _ in $(seq 1 80); do
  if curl -fsS --max-time 1 "${base}/api/status" >/dev/null 2>&1; then break; fi
  sleep 0.05
done
curl -fsS --max-time 2 "${base}/api/status" >/dev/null

post() {
  local endpoint="$1" body="$2" output="$3"
  local code
  code="$(curl -sS --max-time 4 -o "${output}" -w '%{http_code}' -X POST "${base}${endpoint}" \
    -H 'Content-Type: application/json' -H 'X-Requested-With: ds4web' \
    --data-binary "@${body}")"
  if [ "${code}" -lt 200 ] || [ "${code}" -ge 300 ]; then
    echo "${endpoint} returned HTTP ${code}: $(cat "${output}")" >&2
    return 1
  fi
}

node - "${tmp}/graph.json" "${tmp}/workspace" <<'NODE'
const fs = require('fs');
fs.writeFileSync(process.argv[2], JSON.stringify({
  schemaVersion: 1, policy: 'test.synthetic.v1', executorMode: 'synthetic', mode: 'agent',
  goal: 'HTTP lifecycle', workspace: process.argv[3],
  nodes: [
    {id:'inspect', kind:'host_tool', title:'Inspect', synthetic:{delayMs:20}},
    {id:'verify', kind:'gate', title:'Verify', dependsOn:['inspect'], synthetic:{delayMs:20}},
  ],
}));
NODE

csrf_code="$(curl -sS --max-time 2 -o "${tmp}/csrf.json" -w '%{http_code}' \
  -X POST "${base}/api/task-graph/create" -H 'Content-Type: application/json' \
  --data-binary "@${tmp}/graph.json")"
[ "${csrf_code}" = "403" ]

post /api/task-graph/validate "${tmp}/graph.json" "${tmp}/validate.json"
post /api/task-graph/create "${tmp}/graph.json" "${tmp}/create.json"
node - "${tmp}/validate.json" "${tmp}/create.json" "${tmp}/start-stale.json" "${tmp}/start.json" <<'NODE'
const fs = require('fs');
const valid = JSON.parse(fs.readFileSync(process.argv[2]));
const created = JSON.parse(fs.readFileSync(process.argv[3]));
if (!valid.ok || !valid.valid || !valid.executionAvailable) throw new Error('validate response');
if (!created.ok || created.graph.state !== 'ready' || !created.graph.graphId || !created.graph.executionAvailable) throw new Error('create response');
const common = {graphId:created.graph.graphId, workspace:created.graph.workspace, expectedRevision:created.graph.revision};
fs.writeFileSync(process.argv[4], JSON.stringify({...common, expectedLastEventSeq:created.graph.lastEventSeq - 1}));
fs.writeFileSync(process.argv[5], JSON.stringify({...common, expectedLastEventSeq:created.graph.lastEventSeq}));
NODE
stale_code="$(curl -sS --max-time 3 -o "${tmp}/stale-response.json" -w '%{http_code}' \
  -X POST "${base}/api/task-graph/start" -H 'Content-Type: application/json' -H 'X-Requested-With: ds4web' \
  --data-binary "@${tmp}/start-stale.json")"
[ "${stale_code}" = "409" ]
post /api/task-graph/start "${tmp}/start.json" "${tmp}/started.json"

graph_id="$(node -e "const r=require(process.argv[1]);process.stdout.write(r.graph.graphId)" "${tmp}/create.json")"
encoded_workspace="$(node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "${tmp}/workspace")"
for _ in $(seq 1 80); do
  curl -fsS --max-time 2 "${base}/api/task-graph?graphId=${graph_id}&workspace=${encoded_workspace}" >"${tmp}/current.json"
  state="$(node -e "const r=require(process.argv[1]);process.stdout.write(r.graph.state)" "${tmp}/current.json")"
  [ "${state}" = "succeeded" ] && break
  sleep 0.03
done
[ "${state}" = "succeeded" ]
curl -fsS --max-time 2 "${base}/api/task-graph/events?graphId=${graph_id}&workspace=${encoded_workspace}&since=0" >"${tmp}/events.json"
curl -fsS --max-time 2 "${base}/api/task-graphs?workspace=${encoded_workspace}" >"${tmp}/list.json"
node - "${tmp}/current.json" "${tmp}/events.json" "${tmp}/list.json" <<'NODE'
const fs=require('fs');
const current=JSON.parse(fs.readFileSync(process.argv[2]));
const events=JSON.parse(fs.readFileSync(process.argv[3]));
const list=JSON.parse(fs.readFileSync(process.argv[4]));
if (current.graph.progress.completed !== 2 || current.graph.nodes.some(n => n.state !== 'succeeded')) throw new Error('lifecycle did not complete');
if (!events.ok || events.events.length < 8 || events.events.at(-1).seq !== events.lastEventSeq) throw new Error('event stream incomplete');
for (let i=1;i<events.events.length;i++) if (events.events[i].seq !== events.events[i-1].seq+1) throw new Error('event sequence gap');
if (!list.graphs.some(g => g.graphId === current.graph.graphId && g.state === 'succeeded')) throw new Error('graph missing from list');
NODE

# Pause/resume settles cooperatively without blocking the HTTP loop.
node - "${tmp}/pause-graph.json" "${tmp}/workspace" <<'NODE'
const fs=require('fs');
fs.writeFileSync(process.argv[2], JSON.stringify({schemaVersion:1,policy:'test.synthetic.v1',executorMode:'synthetic',goal:'pause',workspace:process.argv[3],nodes:[
  {id:'slow',kind:'host_tool',title:'Slow',synthetic:{delayMs:120}},
  {id:'after',kind:'join',title:'After',dependsOn:['slow']},
]}));
NODE
post /api/task-graph/create "${tmp}/pause-graph.json" "${tmp}/pause-created.json"
node - "${tmp}/pause-created.json" "${tmp}/pause-start.json" <<'NODE'
const fs=require('fs'), r=JSON.parse(fs.readFileSync(process.argv[2])).graph;
fs.writeFileSync(process.argv[3],JSON.stringify({graphId:r.graphId,workspace:r.workspace,expectedRevision:r.revision,expectedLastEventSeq:r.lastEventSeq}));
NODE
post /api/task-graph/start "${tmp}/pause-start.json" "${tmp}/pause-started.json"
node - "${tmp}/pause-started.json" "${tmp}/pause-request.json" <<'NODE'
const fs=require('fs'), r=JSON.parse(fs.readFileSync(process.argv[2])).graph;
fs.writeFileSync(process.argv[3],JSON.stringify({graphId:r.graphId,workspace:r.workspace,expectedRevision:r.revision,expectedLastEventSeq:r.lastEventSeq}));
NODE
post /api/task-graph/pause "${tmp}/pause-request.json" "${tmp}/pausing.json"
pause_id="$(node -e "const r=require(process.argv[1]);process.stdout.write(r.graph.graphId)" "${tmp}/pause-created.json")"
for _ in $(seq 1 80); do
  curl -fsS --max-time 2 "${base}/api/task-graph?graphId=${pause_id}&workspace=${encoded_workspace}" >"${tmp}/paused.json"
  state="$(node -e "const r=require(process.argv[1]);process.stdout.write(r.graph.state)" "${tmp}/paused.json")"
  [ "${state}" = "paused" ] && break
  sleep 0.03
done
[ "${state}" = "paused" ]
node - "${tmp}/paused.json" "${tmp}/resume.json" <<'NODE'
const fs=require('fs'), r=JSON.parse(fs.readFileSync(process.argv[2])).graph;
fs.writeFileSync(process.argv[3],JSON.stringify({graphId:r.graphId,workspace:r.workspace,expectedRevision:r.revision,expectedLastEventSeq:r.lastEventSeq}));
NODE
post /api/task-graph/resume "${tmp}/resume.json" "${tmp}/resumed.json"

# Graph approval and node approval are distinct explicit controls.
node - "${tmp}/approval-graph.json" "${tmp}/workspace" <<'NODE'
const fs=require('fs');
fs.writeFileSync(process.argv[2],JSON.stringify({schemaVersion:1,policy:'test.synthetic.v1',executorMode:'synthetic',goal:'approval',workspace:process.argv[3],approval:{required:true},nodes:[{id:'work',kind:'host_tool',title:'Work'}]}));
NODE
post /api/task-graph/create "${tmp}/approval-graph.json" "${tmp}/approval-created.json"
node - "${tmp}/approval-created.json" "${tmp}/approval-request.json" <<'NODE'
const fs=require('fs'),r=JSON.parse(fs.readFileSync(process.argv[2])).graph;
if(r.state!=='validated'||!r.approvalRequired)throw new Error('approval gate missing');
fs.writeFileSync(process.argv[3],JSON.stringify({graphId:r.graphId,workspace:r.workspace,expectedRevision:r.revision,expectedLastEventSeq:r.lastEventSeq}));
NODE
post /api/task-graph/approve "${tmp}/approval-request.json" "${tmp}/approved.json"
node - "${tmp}/approved.json" <<'NODE'
const r=require(process.argv[2]).graph;if(r.state!=='ready'||!r.approved)throw new Error('graph approval failed');
NODE

node - "${tmp}/node-approval-graph.json" "${tmp}/workspace" <<'NODE'
const fs=require('fs');
fs.writeFileSync(process.argv[2],JSON.stringify({schemaVersion:1,policy:'test.synthetic.v1',executorMode:'synthetic',goal:'node approval',workspace:process.argv[3],nodes:[{id:'approval',kind:'approval',title:'Approval'},{id:'after',kind:'join',title:'After',dependsOn:['approval']}]}));
NODE
post /api/task-graph/create "${tmp}/node-approval-graph.json" "${tmp}/node-approval-created.json"
node - "${tmp}/node-approval-created.json" "${tmp}/node-approval-start.json" <<'NODE'
const fs=require('fs'),r=JSON.parse(fs.readFileSync(process.argv[2])).graph;
fs.writeFileSync(process.argv[3],JSON.stringify({graphId:r.graphId,workspace:r.workspace,expectedRevision:r.revision,expectedLastEventSeq:r.lastEventSeq}));
NODE
post /api/task-graph/start "${tmp}/node-approval-start.json" "${tmp}/node-waiting.json"
node - "${tmp}/node-waiting.json" "${tmp}/node-approve.json" <<'NODE'
const fs=require('fs'),r=JSON.parse(fs.readFileSync(process.argv[2])).graph;
if(r.state!=='waiting_approval'||r.nodes[0].state!=='waiting_approval')throw new Error('node approval did not wait');
fs.writeFileSync(process.argv[3],JSON.stringify({graphId:r.graphId,workspace:r.workspace,nodeId:'approval',expectedRevision:r.revision,expectedLastEventSeq:r.lastEventSeq}));
NODE
post /api/task-graph/node/approve "${tmp}/node-approve.json" "${tmp}/node-approved.json"

# Cancel a live graph and verify stale concurrency remains rejected.
node - "${tmp}/cancel-graph.json" "${tmp}/workspace" <<'NODE'
const fs=require('fs');
fs.writeFileSync(process.argv[2],JSON.stringify({schemaVersion:1,policy:'test.synthetic.v1',executorMode:'synthetic',goal:'cancel',workspace:process.argv[3],nodes:[{id:'slow',kind:'host_tool',title:'Slow',synthetic:{delayMs:5000}}]}));
NODE
post /api/task-graph/create "${tmp}/cancel-graph.json" "${tmp}/cancel-created.json"
node - "${tmp}/cancel-created.json" "${tmp}/cancel-start.json" <<'NODE'
const fs=require('fs'),r=JSON.parse(fs.readFileSync(process.argv[2])).graph;
fs.writeFileSync(process.argv[3],JSON.stringify({graphId:r.graphId,workspace:r.workspace,expectedRevision:r.revision,expectedLastEventSeq:r.lastEventSeq}));
NODE
post /api/task-graph/start "${tmp}/cancel-start.json" "${tmp}/cancel-started.json"
node - "${tmp}/cancel-started.json" "${tmp}/cancel-request.json" <<'NODE'
const fs=require('fs'),r=JSON.parse(fs.readFileSync(process.argv[2])).graph;
fs.writeFileSync(process.argv[3],JSON.stringify({graphId:r.graphId,workspace:r.workspace,expectedRevision:r.revision,expectedLastEventSeq:r.lastEventSeq}));
NODE
post /api/task-graph/cancel "${tmp}/cancel-request.json" "${tmp}/cancelled.json"
node - "${tmp}/cancelled.json" <<'NODE'
const r=require(process.argv[2]).graph;if(r.state!=='cancelled'||r.nodes[0].state!=='cancelled')throw new Error('cancel did not settle');
NODE

# Native host actions execute through closed-world policy, create a durable
# checkpoint, verify through a real gate, and expose an honest undo receipt.
node - "${tmp}/native-graph.json" "${tmp}/workspace" <<'NODE'
const fs=require('fs');
fs.writeFileSync(process.argv[2],JSON.stringify({schemaVersion:1,policy:'agent.general.v1',mode:'agent',executorMode:'native',goal:'native host lifecycle',workspace:process.argv[3],nodes:[
  {id:'write',kind:'host_tool',title:'Write file',mutation:'workspace_write',capabilities:['filesystem.write'],outputs:[{name:'file',path:'native-http.txt',required:true,minimumBytes:6}],action:{name:'workspace.write',path:'native-http.txt',text:'native\n'}},
  {id:'verify',kind:'gate',title:'Verify file',dependsOn:['write'],capabilities:['filesystem.read'],action:{name:'workspace.assert',path:'native-http.txt',contains:'native'}},
  {id:'done',kind:'join',title:'Done',dependsOn:['verify']},
]}));
NODE
post /api/task-graph/validate "${tmp}/native-graph.json" "${tmp}/native-valid.json"
post /api/task-graph/create "${tmp}/native-graph.json" "${tmp}/native-created.json"
node - "${tmp}/native-valid.json" "${tmp}/native-created.json" "${tmp}/native-start.json" <<'NODE'
const fs=require('fs'),valid=JSON.parse(fs.readFileSync(process.argv[2])),r=JSON.parse(fs.readFileSync(process.argv[3])).graph;
if(!valid.executionAvailable||!r.executionAvailable||!/^[0-9a-f]{16}$/.test(r.policyDigest))throw new Error('native policy unavailable');
fs.writeFileSync(process.argv[4],JSON.stringify({graphId:r.graphId,workspace:r.workspace,expectedRevision:r.revision,expectedLastEventSeq:r.lastEventSeq}));
NODE
post /api/task-graph/start "${tmp}/native-start.json" "${tmp}/native-started.json"
native_id="$(node -e "const r=require(process.argv[1]);process.stdout.write(r.graph.graphId)" "${tmp}/native-created.json")"
for _ in $(seq 1 80); do
  curl -fsS --max-time 2 "${base}/api/task-graph?graphId=${native_id}&workspace=${encoded_workspace}" >"${tmp}/native-current.json"
  state="$(node -e "const r=require(process.argv[1]);process.stdout.write(r.graph.state)" "${tmp}/native-current.json")"
  [ "${state}" = "succeeded" ] && break
  sleep 0.03
done
[ "${state}" = "succeeded" ]
[ "$(cat "${tmp}/workspace/native-http.txt")" = "native" ]
node - "${tmp}/native-current.json" "${tmp}/native-undo.json" <<'NODE'
const fs=require('fs'),r=JSON.parse(fs.readFileSync(process.argv[2])).graph,w=r.nodes.find(n=>n.id==='write');
if(!w.undo.available||w.undo.applied)throw new Error('checkpoint not exposed');
fs.writeFileSync(process.argv[3],JSON.stringify({graphId:r.graphId,workspace:r.workspace,nodeId:'write',expectedRevision:r.revision,expectedLastEventSeq:r.lastEventSeq}));
NODE
post /api/task-graph/node/undo "${tmp}/native-undo.json" "${tmp}/native-undone.json"
[ ! -e "${tmp}/workspace/native-http.txt" ]
node - "${tmp}/native-undone.json" <<'NODE'
const r=require(process.argv[2]).graph,w=r.nodes.find(n=>n.id==='write');
if(!w.undo.applied||!w.undo.fullyReversed||!w.undo.message.includes('Declared target bytes'))throw new Error('honest undo receipt missing');
NODE

# Invalid control data and oversized normal API bodies stay bounded.
printf '%s' '{"goal":"bad","nodes":[{"id":"a","kind":"join","title":"A","dependsOn":["a"]}]}' >"${tmp}/bad.json"
bad_code="$(curl -sS --max-time 3 -o "${tmp}/bad-response.json" -w '%{http_code}' \
  -X POST "${base}/api/task-graph/validate" -H 'Content-Type: application/json' -H 'X-Requested-With: ds4web' --data-binary "@${tmp}/bad.json")"
[ "${bad_code}" = "422" ]

# Valid future-policy proposals may be persisted and inspected, but the V1
# runtime must reject start before mutating state when no executor is bound.
node - "${tmp}/proposal.json" "${tmp}/workspace" <<'NODE'
const fs=require('fs');
fs.writeFileSync(process.argv[2],JSON.stringify({schemaVersion:1,policy:'agent.general.v1',mode:'agent',goal:'future adapter proposal',workspace:process.argv[3],nodes:[{id:'inspect',kind:'agent_turn',title:'Inspect',capabilities:['filesystem.read']}]}));
NODE
post /api/task-graph/validate "${tmp}/proposal.json" "${tmp}/proposal-valid.json"
post /api/task-graph/create "${tmp}/proposal.json" "${tmp}/proposal-created.json"
node - "${tmp}/proposal-valid.json" "${tmp}/proposal-created.json" "${tmp}/proposal-start.json" <<'NODE'
const fs=require('fs'),valid=JSON.parse(fs.readFileSync(process.argv[2])),r=JSON.parse(fs.readFileSync(process.argv[3])).graph;
if(!valid.valid||valid.executionAvailable!==false||r.executionAvailable!==false||r.state!=='ready')throw new Error('proposal execution availability');
fs.writeFileSync(process.argv[4],JSON.stringify({graphId:r.graphId,workspace:r.workspace,expectedRevision:r.revision,expectedLastEventSeq:r.lastEventSeq}));
NODE
proposal_start_code="$(curl -sS --max-time 3 -o "${tmp}/proposal-start-response.json" -w '%{http_code}' \
  -X POST "${base}/api/task-graph/start" -H 'Content-Type: application/json' -H 'X-Requested-With: ds4web' \
  --data-binary "@${tmp}/proposal-start.json")"
[ "${proposal_start_code}" = "422" ]
proposal_id="$(node -e "const r=require(process.argv[1]);process.stdout.write(r.graph.graphId)" "${tmp}/proposal-created.json")"
curl -fsS --max-time 2 "${base}/api/task-graph?graphId=${proposal_id}&workspace=${encoded_workspace}" >"${tmp}/proposal-current.json"
node - "${tmp}/proposal-created.json" "${tmp}/proposal-start-response.json" "${tmp}/proposal-current.json" <<'NODE'
const fs=require('fs'),created=JSON.parse(fs.readFileSync(process.argv[2])).graph,rejected=JSON.parse(fs.readFileSync(process.argv[3])),now=JSON.parse(fs.readFileSync(process.argv[4])).graph;
if(!/not registered/.test(rejected.error||''))throw new Error('missing executor rejection');
if(now.state!=='ready'||now.revision!==created.revision||now.lastEventSeq!==created.lastEventSeq)throw new Error('rejected start mutated proposal');
NODE

echo "task_graph_http: lightweight synthetic + native lifecycle checks passed"

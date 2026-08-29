#!/usr/bin/env bash
set -euo pipefail

bin="${1:?usage: ds4_cowork_http_test.sh /path/to/dstudio-server-test}"
if ! command -v curl >/dev/null 2>&1 || ! command -v node >/dev/null 2>&1; then
  echo "ds4-cowork http: curl/node missing, skipping"
  exit 0
fi

tmp="$(mktemp -d "${TMPDIR:-/tmp}/dstudio-cowork-http.XXXXXX")"
server_pid=""
cleanup() {
  if [ -n "${server_pid}" ] && kill -0 "${server_pid}" >/dev/null 2>&1; then
    kill "${server_pid}" >/dev/null 2>&1 || true
    wait "${server_pid}" >/dev/null 2>&1 || true
  fi
  rm -rf "${tmp}"
}
trap cleanup EXIT

mkdir -p "${tmp}/home" "${tmp}/ds4/gguf" "${tmp}/workspace"
printf '%s\n' 'all:' >"${tmp}/ds4/Makefile"
port="$(node - <<'NODE'
const net = require('net');
const server = net.createServer();
server.listen(0, '127.0.0.1', () => {
  const port = server.address().port;
  server.close(() => process.stdout.write(String(port)));
});
NODE
)"

HOME="${tmp}/home" DS4UI_TEST_MODE=1 DS4UI_PAGE_FROM_DISK=1 \
  "${bin}" "${port}" "${tmp}/ds4" >"${tmp}/server.log" 2>&1 &
server_pid="$!"
base="http://127.0.0.1:${port}"
for _ in $(seq 1 80); do
  if curl -fsS --max-time 1 "${base}/api/status" >/dev/null 2>&1; then break; fi
  sleep 0.1
done
curl -fsS --max-time 2 "${base}/api/status" >/dev/null

payload="$(printf 'cowork local payload' | base64 | tr -d '\r\n')"
upload_body="${tmp}/upload.json"
node - "${upload_body}" "${tmp}/workspace" "${payload}" <<'NODE'
const fs = require('fs');
fs.writeFileSync(process.argv[2], JSON.stringify({
  dir: process.argv[3],
  name: '../../quarterly report.pdf',
  data_uri: `data:application/pdf;base64,${process.argv[4]}`,
}));
NODE

curl -fsS --max-time 5 -X POST "${base}/api/cowork/attach-file" \
  -H 'Content-Type: application/json' -H 'X-Requested-With: ds4web' \
  --data-binary @"${upload_body}" >"${tmp}/first.json"
curl -fsS --max-time 5 -X POST "${base}/api/cowork/attach-file" \
  -H 'Content-Type: application/json' -H 'X-Requested-With: ds4web' \
  --data-binary @"${upload_body}" >"${tmp}/second.json"

node - "${tmp}/first.json" "${tmp}/second.json" "${tmp}/workspace" <<'NODE'
const fs = require('fs');
const path = require('path');
const first = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const second = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
const workspace = process.argv[4];
if (!first.ok || first.name !== 'quarterly-report.pdf' || first.rel !== './quarterly-report.pdf') throw new Error(JSON.stringify(first));
if (!second.ok || second.name !== 'quarterly-report-2.pdf') throw new Error(JSON.stringify(second));
for (const name of [first.name, second.name]) {
  if (fs.readFileSync(path.join(workspace, name), 'utf8') !== 'cowork local payload') throw new Error(`wrong payload: ${name}`);
}
NODE

node - "${tmp}/bad.json" "${tmp}/workspace" "${payload}" <<'NODE'
const fs = require('fs');
fs.writeFileSync(process.argv[2], JSON.stringify({ dir: process.argv[3], name: 'macro.xlsm', data_uri: process.argv[4] }));
NODE
bad_code="$(curl -sS --max-time 5 -o "${tmp}/bad-response.json" -w '%{http_code}' \
  -X POST "${base}/api/cowork/attach-file" \
  -H 'Content-Type: application/json' -H 'X-Requested-With: ds4web' \
  --data-binary @"${tmp}/bad.json")"
[ "${bad_code}" = "415" ]

csrf_code="$(curl -sS --max-time 5 -o "${tmp}/csrf-response.json" -w '%{http_code}' \
  -X POST "${base}/api/cowork/attach-file" \
  -H 'Content-Type: application/json' --data-binary @"${upload_body}")"
[ "${csrf_code}" = "403" ]

echo "ds4-cowork http: ok"

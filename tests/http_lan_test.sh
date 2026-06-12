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

HOME="${tmp}/home" DS4UI_TEST_MODE=1 DS4UI_PAGE_FROM_DISK=1 "${bin}" "${port}" "${tmp}/ds4" >"${tmp}/server.log" 2>&1 &
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
curl -fsS --max-time 2 "${base}/loading.html" >"${tmp}/loading.html"
grep -q 'hello are you alive' "${tmp}/loading.html"
grep -q 'lanClientHost' "${tmp}/loading.html"
grep -q 'onboardedVersion !== 7' "${tmp}/loading.html"
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

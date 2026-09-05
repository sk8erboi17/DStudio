#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
APP=${1:-"$ROOT/DStudio.app"}

if [ "$(uname -s)" != "Darwin" ]; then
  echo "macOS bundle smoke test: skipped (not macOS)"
  exit 0
fi

test -x "$APP/Contents/MacOS/DStudio"
plutil -lint "$APP/Contents/Info.plist" >/dev/null
codesign --verify --deep --strict "$APP"
test ! -e "$APP/Contents/Resources/DStudio/ds4"
test -z "$(find "$APP/Contents/Resources/DStudio" \
  \( -name __pycache__ -o -name '*.pyc' -o -name '*.pyo' \) -print -quit)"

TMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/dstudio-macos-smoke.XXXXXX")
SERVER_PID=
cleanup() {
  if [ -n "$SERVER_PID" ]; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  rm -rf "$TMP_ROOT"
}
trap cleanup EXIT HUP INT TERM

/usr/bin/ditto "$APP" "$TMP_ROOT/DStudio.app"
PORT=$(python3 - <<'PY'
import socket
s = socket.socket()
s.bind(("127.0.0.1", 0))
print(s.getsockname()[1])
s.close()
PY
)

(
  cd /
  DS4UI_DATA_DIR="$TMP_ROOT/support" \
  DS4UI_TEST_MODE=1 \
  "$TMP_ROOT/DStudio.app/Contents/MacOS/DStudio" "$PORT"
) >"$TMP_ROOT/server.log" 2>&1 &
SERVER_PID=$!

READY=0
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
  if curl -fsS "http://127.0.0.1:$PORT/api/status" -o "$TMP_ROOT/status.json" 2>/dev/null; then
    READY=1
    break
  fi
  sleep 0.25
done

if [ "$READY" -ne 1 ]; then
  sed -n '1,160p' "$TMP_ROOT/server.log" >&2
  echo "macOS bundle smoke test: server did not start" >&2
  exit 1
fi

python3 - "$TMP_ROOT/status.json" "$TMP_ROOT/support" <<'PY'
import json
import os
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    status = json.load(handle)
support = os.path.realpath(sys.argv[2])
if status.get("webdir") != support or not status.get("webdirOk"):
    raise SystemExit(f"bundle support was not materialized: {status.get('webdir')!r}")
if status.get("ds4dir") != os.path.join(support, "ds4"):
    raise SystemExit(f"managed ds4 path is wrong: {status.get('ds4dir')!r}")
PY

test -f "$TMP_ROOT/support/extension/design/build-design.sh"
test -f "$TMP_ROOT/support/extension/task-graph/bench/manifest.json"
test -f "$TMP_ROOT/support/patch/ds4-agent-jsonl/manifest"
test -f "$TMP_ROOT/support/scripts/apply-ds4-server-metrics.sh"
python3 "$TMP_ROOT/support/scripts/download-qwen35.py" --help >/dev/null
codesign --verify --deep --strict "$TMP_ROOT/DStudio.app"

echo "macOS bundle smoke test: ok"

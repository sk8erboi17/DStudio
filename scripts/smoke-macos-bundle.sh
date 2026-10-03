#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
APP=${1:-"$ROOT/DStudio.app"}

# A Finder launch has no recursive-make jobserver. Subprocesses in this test
# close its descriptors, so inheriting the parent's MAKEFLAGS under `make -j`
# would pass stale descriptor numbers to the bundled build command.
unset MAKEFLAGS MFLAGS MAKELEVEL MAKEOVERRIDES GNUMAKEFLAGS

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
  exec env DS4UI_DATA_DIR="$TMP_ROOT/support" \
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

test -f "$TMP_ROOT/support/src/harness/design/build-design.sh"
test -f "$TMP_ROOT/support/extension/task-graph/bench/manifest.json"
test -f "$TMP_ROOT/support/patch/ds4-agent-jsonl/manifest"
test -f "$TMP_ROOT/support/scripts/apply-ds4-server-metrics.sh"
curl -fsS "http://127.0.0.1:$PORT/api/design-systems" -o "$TMP_ROOT/catalog.json"
python3 - "$TMP_ROOT/catalog.json" <<'PY'
import json
import sys
with open(sys.argv[1], encoding="utf-8") as handle:
    catalog = json.load(handle)["designSystems"]
assert sorted(item["id"] for item in catalog) == [
    "atlas", "canvas", "commons", "counter", "datasheet", "depot", "docket", "folio", "forma",
    "grove", "hearth", "larder", "ledger", "letter", "manual", "market", "pipeline", "pulse",
    "relay", "roster", "signal", "tally", "tempo", "transit", "walkthrough",
]
assert all(item["hasComponents"] and item["hasAssets"] and item["hasReferences"] for item in catalog)
PY
curl -fsS -X POST -H 'X-Requested-With: ds4web' \
  "http://127.0.0.1:$PORT/api/setup/content" -o "$TMP_ROOT/content.json"
python3 - "$TMP_ROOT/content.json" <<'PY'
import json
import sys
with open(sys.argv[1], encoding="utf-8") as handle:
    result = json.load(handle)
assert result["ok"] and result["bundled"] and result["contentOk"]
PY
python3 "$TMP_ROOT/support/scripts/download-qwen35.py" --help >/dev/null
# Exercise the materialized llama.cpp installer without building or loading
# weights. Packaging admission is distinct from model/inference qualification.
python3 "$TMP_ROOT/support/scripts/install-llama.py" --root "$TMP_ROOT" --revision unused --manifest >/dev/null
python3 - "$TMP_ROOT/DStudio.app/Contents/MacOS/DStudio" "$TMP_ROOT" <<'PY'
import json, os, re, subprocess, sys
from pathlib import Path
app, root = sys.argv[1:]
env = {**os.environ, 'DS4UI_DATA_DIR': os.path.join(root, 'metadata support'), 'DS4UI_TEST_MODE': '1'}
def produced_json(command):
    return json.loads(subprocess.check_output(command, cwd='/', env=env, text=True, timeout=15))
pins = produced_json([app, '--engine-pins'])
assert pins['schema'] == 'dstudio.engine-pins.v1'
engines = {entry['id']: entry for entry in pins['engines']}
assert len(engines) == len(pins['engines'])
assert set(engines) == {'main', 'laguna', 'llama'}
assert engines['llama']['directory'] == 'llama.cpp'
assert re.fullmatch(r'[0-9a-f]{40}', engines['llama']['commit'])
assert engines['llama']['commit'] in engines['llama']['archiveURL']
installer = produced_json([sys.executable, os.path.join(root, 'support/scripts/install-llama.py'),
                           '--root', root, '--revision', 'unused', '--manifest'])
assert installer['commit'] == engines['llama']['commit'], 'installer and native pin agree'
source_root = Path(root, 'support/src/engines')
assert {p.name for p in source_root.iterdir() if p.is_dir()} == {
    'ds4', 'ds4-laguna-s21', 'llama.cpp'
}, 'the materialized app must include only active engine snapshots'
source_manifest = json.loads((source_root / 'manifest.json').read_text())
assert set(source_manifest['engines']) == set(engines)
for engine, pin in engines.items():
    bundled = source_manifest['engines'][engine]
    assert bundled['commit'] == pin['commit']
    assert 'src/engines/' + bundled['directory'] == pin['sourceDirectory']
# Harnesses: the pinned pi/opencode/pi-ds4 snapshots stay in the signed bundle
# (not the per-launch support copy) and verify byte for byte from there; the
# bridge is part of the support payload the installer copies from.
harness_sources = Path(app).parents[1] / 'Resources' / 'HarnessSources'
sys.path.insert(0, os.path.join(root, 'support/scripts'))
import bundled_engine_sources as bundled_sources
harness_manifest = json.loads((harness_sources / 'src/harness/manifest.json').read_text())
assert set(harness_manifest['engines']) == {'pi', 'opencode', 'pi-ds4'}
for harness_name, harness_entry in harness_manifest['engines'].items():
    bundled_sources.transfer(harness_sources, harness_name, harness_entry['commit'], catalog=bundled_sources.HARNESSES)
assert not Path(root, 'support/src/harness/pi').exists(), 'harness snapshots are not copied at every launch'
# MLX: the pinned wheels stay in the bundle and verify against their manifest.
import importlib.util as mlx_util
mlx_spec = mlx_util.spec_from_file_location('install_mlx', os.path.join(root, 'support/scripts/install-mlx.py'))
install_mlx = mlx_util.module_from_spec(mlx_spec); mlx_spec.loader.exec_module(install_mlx)
mlx_packages = Path(app).parents[1] / 'Resources' / 'MlxPackages'
mlx_manifest, _ = install_mlx.load_manifest(mlx_packages)
install_mlx.verify_wheels(mlx_packages, mlx_manifest)
assert not Path(root, 'support/src/engines/mlx').exists(), 'MLX wheels are not copied at every launch'
for mlx_patch in install_mlx.PATCHES:
    assert Path(root, 'support', mlx_patch).is_file(), mlx_patch
mlx_pins = produced_json([sys.executable, os.path.join(root, 'support/scripts/download-mlx-qwen36.py'), '--manifest'])
assert mlx_pins['files'] and len(mlx_pins['files']) == 20 and re.fullmatch(r'[0-9a-f]{40}', mlx_pins['revision'])
for bridge_file in ('dstudio-harness.mjs', 'pi-workspace-guard.ts'):
    assert Path(root, 'support/src/harness/bridge', bridge_file).is_file(), bridge_file
manifest = produced_json([sys.executable, os.path.join(root, 'support/scripts/download-qwen27.py'), '--manifest'])
assert re.fullmatch(r'[0-9a-f]{40}', manifest['revision'])
assert set(manifest['files']) == {'model', 'vision'}
assert len({item['file'] for item in manifest['files'].values()}) == 2
for item in manifest['files'].values():
    assert item['bytes'] > 0 and re.fullmatch(r'[0-9a-f]{64}', item['sha256'])
assert not os.path.exists(os.path.join(root, 'metadata support')), 'metadata commands must not initialize a profile'
PY
# The compiled .app must dispatch Design's batch command without opening a
# window or an HTTP server. This minimal Make fixture tests command routing,
# private preparation and cleanup only; it is not an installed engine.
mkdir "$TMP_ROOT/build command fixture"
printf '%s\n' 'CC=cc' 'UNAME_S=Darwin' 'CFLAGS=-O1 -DDS4_NO_GPU' \
  > "$TMP_ROOT/build command fixture/Makefile"
python3 - "$TMP_ROOT/DStudio.app/Contents/MacOS/DStudio" "$TMP_ROOT" <<'PY'
import os, signal, subprocess, sys
app, root = sys.argv[1:]
env = {**os.environ, 'DS4UI_DATA_DIR': os.path.join(root, 'batch support')}
for key in ('DS4UI_TEST_MODE', 'DS4UI_NO_WINDOW', 'DS4UI_CHILD'):
    env.pop(key, None)
child = subprocess.Popen([app, '--build-design', os.path.join(root, 'build command fixture'), 'status'],
                         cwd='/', env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                         text=True, start_new_session=True)
try:
    stdout, stderr = child.communicate(timeout=15)
    assert child.returncode == 0, (stdout, stderr)
    assert 'binary: missing' in stdout, (stdout, stderr)
    assert not any(name.startswith('.ds4ui-design-build-') for name in os.listdir(os.path.join(root, 'build command fixture')))
finally:
    if child.poll() is None:
        try: os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError: pass
    child.wait()
PY
codesign --verify --deep --strict "$TMP_ROOT/DStudio.app"

# Run the production Chat preparation against the current main source shape
# using materialized bundle assets, from Finder's cwd. Compilation is simulated
# in this lifecycle harness; the native build is a separate gate. An old bundle
# that omits the current PLD patch must fail before it reaches that compiler.
node "$ROOT/tests/integration/server_pld_build_test.mjs" \
  "$TMP_ROOT/DStudio.app/Contents/MacOS/DStudio" --latest --bundle-profile

echo "macOS bundle smoke test: ok"

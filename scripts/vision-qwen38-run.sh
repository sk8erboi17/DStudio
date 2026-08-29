#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
RUNTIME_ROOT=${DSTUDIO_QWEN38_VISION_HOME:-$HOME/.dstudio/qwen38-vision}
PYTHON_BIN=$RUNTIME_ROOT/venv/bin/python

[ -x "$PYTHON_BIN" ] || {
  echo "Qwen3.8 vision runtime is not installed; run vision setup first" >&2
  exit 127
}

exec /usr/bin/python3 "$SCRIPT_DIR/heavy-model-lock.py" \
  --kind qwen3.8-vision -- \
  "$PYTHON_BIN" "$SCRIPT_DIR/vision-qwen38-run.py" "$@"

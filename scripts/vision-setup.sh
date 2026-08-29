#!/bin/sh
# Install the only supported DStudio vision reader: Qwen3.8-27B Q8 for MLX.
# The model is pinned and cached once, but never kept resident: every describe
# request runs through vision-qwen38-run.sh and exits before DS4 is restored.
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
RUNTIME_ROOT=${DSTUDIO_QWEN38_VISION_HOME:-$HOME/.dstudio/qwen38-vision}
MODEL_ID=mlx-community/Qwen3.8-27B-8bit
MODEL_REVISION=815b83c0df8ffd1d1b5244cf75fd6ef14fca9ef9
MLX_VLM_VERSION=0.6.8

[ "$(uname -s)" = Darwin ] && [ "$(uname -m)" = arm64 ] || {
  echo "vision-setup: Qwen3.8 Q8/MLX currently requires Apple Silicon" >&2
  exit 2
}

UV_BIN=$(command -v uv || true)
[ -n "$UV_BIN" ] || [ ! -x /opt/homebrew/bin/uv ] || UV_BIN=/opt/homebrew/bin/uv
[ -n "$UV_BIN" ] || {
  echo "vision-setup: uv is required (install with: brew install uv)" >&2
  exit 3
}

HF_BIN=$(command -v hf || true)
[ -n "$HF_BIN" ] || [ ! -x /opt/homebrew/bin/hf ] || HF_BIN=/opt/homebrew/bin/hf
[ -n "$HF_BIN" ] || {
  echo "vision-setup: the Hugging Face hf CLI is required" >&2
  exit 3
}

mkdir -p "$RUNTIME_ROOT"
if [ ! -x "$RUNTIME_ROOT/venv/bin/python" ]; then
  "$UV_BIN" venv --python 3.12 "$RUNTIME_ROOT/venv"
fi

STAMP=$RUNTIME_ROOT/mlx-vlm-$MLX_VLM_VERSION
if [ ! -f "$STAMP" ]; then
  "$UV_BIN" pip install --python "$RUNTIME_ROOT/venv/bin/python" "mlx-vlm==$MLX_VLM_VERSION"
  : > "$STAMP"
fi

echo "vision-setup: downloading pinned $MODEL_ID Q8 snapshot" >&2
SNAPSHOT=$(
  "$HF_BIN" download "$MODEL_ID" --revision "$MODEL_REVISION" 2>&1 |
  tee /dev/stderr |
  tail -n 1
)
[ -d "$SNAPSHOT" ] || {
  # Older hf clients can print progress after the path. Resolve the pinned
  # snapshot from the cache without accepting another revision.
  SNAPSHOT=$(
    "$RUNTIME_ROOT/venv/bin/python" - "$MODEL_ID" "$MODEL_REVISION" <<'PY'
from huggingface_hub import snapshot_download
import sys
print(snapshot_download(sys.argv[1], revision=sys.argv[2], local_files_only=True))
PY
  )
}
[ -d "$SNAPSHOT" ] || { echo "vision-setup: pinned model snapshot is incomplete" >&2; exit 4; }

printf '%s\n' "$MODEL_REVISION" > "$RUNTIME_ROOT/.model-revision"
printf '%s\n' "$SNAPSHOT" > "$RUNTIME_ROOT/.model-path"
printf '%s\n' "$MODEL_ID" > "$RUNTIME_ROOT/.model-id"

# Validate imports and the exact local revision without loading 29.5 GB into
# memory. Inference itself always runs under the heavyweight-model lock.
"$RUNTIME_ROOT/venv/bin/python" - "$MODEL_ID" "$MODEL_REVISION" <<'PY'
from huggingface_hub import snapshot_download
import importlib.metadata
import sys
snapshot_download(sys.argv[1], revision=sys.argv[2], local_files_only=True)
print(f"vision-setup: Qwen3.8 Q8 ready with mlx-vlm {importlib.metadata.version('mlx-vlm')}")
PY

chmod +x "$SCRIPT_DIR/vision-qwen38-run.sh" "$SCRIPT_DIR/vision-qwen38-run.py" \
  "$SCRIPT_DIR/heavy-model-lock.py" 2>/dev/null || true

#!/bin/sh
# Qwen3.8-27B Q8 is the sole image-operation router. It exits before either
# image backend is allowed to load.
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
runtime_root=${DSTUDIO_QWEN38_VISION_HOME:-${HOME}/.dstudio/qwen38-vision}
python_bin=$runtime_root/venv/bin/python

if [ "${DSTUDIO_IMAGE_ROUTE_TEST_MODE:-0}" = 1 ]; then
    exec /usr/bin/python3 "$script_dir/heavy-model-lock.py" --kind qwen3.8-image-router -- \
        /usr/bin/python3 "$script_dir/image-route-qwen38.py" "$@"
fi

[ -x "$python_bin" ] || {
    echo "Qwen3.8-27B Q8 is not installed; run vision setup first" >&2
    exit 127
}

exec /usr/bin/python3 "$script_dir/heavy-model-lock.py" --kind qwen3.8-image-router -- \
    "$python_bin" "$script_dir/image-route-qwen38.py" "$@"

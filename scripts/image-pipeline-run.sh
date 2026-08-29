#!/bin/sh
# The coordinator itself never owns the heavyweight lock: its Qwen router and
# selected image worker acquire it in sequence, making overlap impossible.
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if [ "${DSTUDIO_IMAGE_TEST_MODE:-0}" = 1 ]; then
    export DSTUDIO_IMAGE_ROUTE_TEST_MODE=1
    export DSTUDIO_IDEOGRAM4_TEST_MODE=1
    export DSTUDIO_HUNYUAN_IMAGE3_TEST_MODE=1
fi
if command -v python3 >/dev/null 2>&1; then
    python_bin=$(command -v python3)
else
    python_bin=/usr/bin/python3
fi

exec "$python_bin" "$script_dir/image-pipeline-run.py" "$@"

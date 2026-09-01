#!/bin/sh
# The coordinator dispatches the native model's explicit generate/edit action
# to exactly one local image worker.
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if [ "${DSTUDIO_IMAGE_TEST_MODE:-0}" = 1 ]; then
    export DSTUDIO_IDEOGRAM4_TEST_MODE=1
    export DSTUDIO_HUNYUAN_IMAGE3_TEST_MODE=1
fi
if command -v python3 >/dev/null 2>&1; then
    python_bin=$(command -v python3)
else
    python_bin=/usr/bin/python3
fi

exec "$python_bin" "$script_dir/image-pipeline-run.py" "$@"

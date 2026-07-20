#!/bin/sh
set -eu

ds4_dir=${DS4_DIR:-}
if [ -z "$ds4_dir" ] || [ ! -f "$ds4_dir/ds4.c" ]; then
    echo "DStudio Qwen memory patch: invalid DS4_DIR" >&2
    exit 2
fi

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
patch_file="$script_dir/../patch/ds4-qwen-hot-memory/hot-memory.patch"

action=${1:-apply}
if [ "$action" = "restore" ]; then
    if ! grep -q 'ds4_engine_memory_pressure_begin' "$ds4_dir/ds4.c"; then
        echo "DStudio Qwen memory patch: already restored"
        exit 0
    fi
    patch -d "$ds4_dir" -p1 --reverse --batch < "$patch_file"
    echo "DStudio Qwen memory patch: restored"
    exit 0
fi

if [ "$action" != "apply" ] && [ "$action" != "build" ]; then
    echo "DStudio Qwen memory patch: expected apply, build, or restore" >&2
    exit 2
fi

if grep -q 'ds4_engine_memory_pressure_begin' "$ds4_dir/ds4.c"; then
    echo "DStudio Qwen memory patch: already applied"
    exit 0
fi

if ! patch -d "$ds4_dir" -p1 --forward --batch < "$patch_file"; then
    echo "DStudio Qwen memory patch: source anchors no longer match upstream" >&2
    exit 1
fi
echo "DStudio Qwen memory patch: applied"

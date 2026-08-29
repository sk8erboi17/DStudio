#!/bin/sh
set -eu

ds4_dir=${DS4_DIR:-}
if [ -z "$ds4_dir" ] || [ ! -f "$ds4_dir/ds4.c" ]; then
    echo "DStudio GLM 5.3 runtime patch: invalid DS4_DIR" >&2
    exit 2
fi

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
patch_file="$script_dir/../patch/ds4-glm53-runtime/streaming-memory.patch"
marker=DS4UI_GLM53_STREAMING
action=${1:-apply}

# This hook runs for main and every optional checkout. Only the upstream GLM
# 5.3 branch contains this model predicate and the matching source anchors.
if ! grep -q 'static bool ds4_model_is_glm53' "$ds4_dir/ds4.c"; then
    echo "DStudio GLM 5.3 runtime patch: non-GLM checkout skipped"
    exit 0
fi

if [ "$action" = "restore" ]; then
    if ! grep -q "$marker" "$ds4_dir/ds4.c"; then
        echo "DStudio GLM 5.3 runtime patch: already restored"
        exit 0
    fi
    patch -d "$ds4_dir" -p1 --reverse --batch < "$patch_file"
    echo "DStudio GLM 5.3 runtime patch: restored"
    exit 0
fi

if [ "$action" != "apply" ] && [ "$action" != "build" ]; then
    echo "DStudio GLM 5.3 runtime patch: expected apply, build, or restore" >&2
    exit 2
fi

if grep -q "$marker" "$ds4_dir/ds4.c"; then
    echo "DStudio GLM 5.3 runtime patch: already applied"
    exit 0
fi

if ! patch -d "$ds4_dir" -p1 --forward --batch < "$patch_file"; then
    echo "DStudio GLM 5.3 runtime patch: source anchors no longer match upstream" >&2
    exit 1
fi
echo "DStudio GLM 5.3 runtime patch: applied"

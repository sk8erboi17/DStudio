#!/bin/sh
set -eu

h3_dir=${H3_DIR:-}
if [ -z "$h3_dir" ] || [ ! -f "$h3_dir/h3_dit.c" ]; then
    echo "DStudio H3 Metal watchdog patch: invalid H3_DIR" >&2
    exit 2
fi

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
patch_file="$script_dir/../patch/h3-metal-watchdog/stage-command-submits.patch"
action=${1:-apply}

if [ ! -f "$patch_file" ]; then
    echo "DStudio H3 Metal watchdog patch: patch file is missing" >&2
    exit 2
fi

managed_sources="h3_dit.c h3_gpu.m"

if [ "$action" = "restore" ]; then
    if git -C "$h3_dir" apply --reverse --check "$patch_file" \
            >/dev/null 2>&1; then
        git -C "$h3_dir" apply --reverse "$patch_file"
        echo "DStudio H3 Metal watchdog patch: restored"
        exit 0
    fi
    if git -C "$h3_dir" diff --quiet -- $managed_sources; then
        echo "DStudio H3 Metal watchdog patch: already restored"
        exit 0
    fi
    echo "DStudio H3 Metal watchdog patch: refusing to overwrite an unknown source delta" >&2
    exit 1
fi

if [ "$action" != "apply" ]; then
    echo "DStudio H3 Metal watchdog patch: expected apply or restore" >&2
    exit 2
fi

if git -C "$h3_dir" apply --reverse --check "$patch_file" \
        >/dev/null 2>&1; then
    echo "DStudio H3 Metal watchdog patch: already applied"
    exit 0
fi
if ! git -C "$h3_dir" diff --quiet -- $managed_sources; then
    echo "DStudio H3 Metal watchdog patch: refusing to mix with an unknown source delta" >&2
    exit 1
fi
if ! git -C "$h3_dir" apply --check "$patch_file" ||
   ! git -C "$h3_dir" apply "$patch_file"; then
    echo "DStudio H3 Metal watchdog patch: source anchors no longer match upstream" >&2
    exit 1
fi
echo "DStudio H3 Metal watchdog patch: applied"

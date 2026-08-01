#!/bin/sh
set -eu

ds4_dir=${DS4_DIR:-}
if [ -z "$ds4_dir" ] || [ ! -f "$ds4_dir/ds4_server.c" ]; then
    echo "DStudio server metrics patch: invalid DS4_DIR" >&2
    exit 2
fi

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
patch_file="$script_dir/../patch/ds4-server-metrics/usage-metrics.patch"
marker=DS4UI_SERVER_METRICS
action=${1:-apply}

if [ "$action" = "restore" ]; then
    if ! grep -q "$marker" "$ds4_dir/ds4_server.c"; then
        echo "DStudio server metrics patch: already restored"
        exit 0
    fi
    patch -d "$ds4_dir" -p1 --reverse --batch < "$patch_file"
    echo "DStudio server metrics patch: restored"
    exit 0
fi

if [ "$action" != "apply" ]; then
    echo "DStudio server metrics patch: expected apply or restore" >&2
    exit 2
fi

if grep -q "$marker" "$ds4_dir/ds4_server.c"; then
    echo "DStudio server metrics patch: already applied"
    exit 0
fi

if ! patch -d "$ds4_dir" -p1 --forward --batch < "$patch_file"; then
    echo "DStudio server metrics patch: source anchors no longer match upstream" >&2
    exit 1
fi
echo "DStudio server metrics patch: applied"

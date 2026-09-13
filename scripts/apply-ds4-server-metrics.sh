#!/bin/sh
set -eu

ds4_dir=${DS4_DIR:-}
if [ -z "$ds4_dir" ] || [ ! -f "$ds4_dir/ds4_server.c" ] ||
   [ -L "$ds4_dir/ds4_server.c" ]; then
    echo "DStudio server metrics patch: invalid DS4_DIR" >&2
    exit 2
fi

ds4_dir=$(CDPATH= cd -- "$ds4_dir" && pwd -P)
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
patch_file="$script_dir/../patch/ds4-server-metrics/usage-metrics.patch"
action=${1:-apply}
case "$action" in apply|check|restore) ;; *)
    echo 'DStudio server metrics patch: expected apply, check, or restore' >&2
    exit 2 ;;
esac

apply_metrics() (
    # Check the complete delta, not a marker that also occurs in a partial patch.
    # Archive installs must not inherit the enclosing application's Git index.
    unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE
    GIT_CEILING_DIRECTORIES="$(dirname -- "$ds4_dir")" git -C "$ds4_dir" apply "$@" "$patch_file"
)
if apply_metrics --reverse --check >/dev/null 2>&1; then
    if [ "$action" = restore ]; then
        apply_metrics --reverse
        echo 'DStudio server metrics patch: restored'
    else
        echo 'DStudio server metrics patch: already applied'
    fi
elif apply_metrics --check --whitespace=error >/dev/null 2>&1; then
    case "$action" in
        restore) echo 'DStudio server metrics patch: already restored' ;;
        check) echo 'DStudio server metrics patch: applicable' ;;
        apply) apply_metrics --whitespace=error; echo 'DStudio server metrics patch: applied' ;;
    esac
else
    echo 'DStudio server metrics patch: wrong source, drift or partial patch; no files changed' >&2
    exit 1
fi

#!/bin/sh
# Laguna S 2.1 long-prompt prefill on Metal (patch/ds4-laguna-prefill-chunk):
# a requested prefill batch (--prefill-chunk, then DS4_METAL_PREFILL_CHUNK),
# 4096 rows by default on Metal instead of the branch's fixed 16384; prefill
# attention in passes of at most 4096 keys per dispatch, so no GPU thread walks
# ~20k keys and trips the macOS interactivity watchdog; and a sliding-window
# ring commit that writes each slot once. Files: ds4.c, ds4_help.c,
# ds4_metal.m, metal/laguna.metal.
set -eu
action=${1:-apply}
case "$action" in apply|build|check|restore) ;; *)
    echo "DStudio Laguna prefill chunk patch: expected apply, build, check, or restore" >&2
    exit 2 ;;
esac
ds4_dir=${DS4_DIR:-}
if [ -z "$ds4_dir" ] || [ ! -f "$ds4_dir/ds4.c" ] || [ -L "$ds4_dir/ds4.c" ]; then
    echo "DStudio Laguna prefill chunk patch: invalid DS4_DIR" >&2
    exit 2
fi
# ds4 main and other checkouts have no Laguna graph to adapt (whatever other
# files they hold); only a Laguna checkout must hold every file the patch edits.
if ! grep -q '^static bool laguna_graph_alloc(' "$ds4_dir/ds4.c" &&
   ! grep -q 'ds4_laguna_prefill_chunk(' "$ds4_dir/ds4.c"; then
    echo "DStudio Laguna prefill chunk patch: not needed (no Laguna graph); skipped"
    exit 0
fi
for file in ds4_help.c ds4_metal.m metal/laguna.metal; do
    if [ ! -f "$ds4_dir/$file" ] || [ -L "$ds4_dir/$file" ]; then
        echo "DStudio Laguna prefill chunk patch: invalid DS4_DIR (missing $file)" >&2
        exit 2
    fi
done
ds4_dir=$(CDPATH= cd -- "$ds4_dir" && pwd -P)
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
patch_file="$script_dir/../patch/ds4-laguna-prefill-chunk/prefill-chunk.patch"
apply_patch() (
    # Check the complete delta. Archive installs must not inherit the
    # enclosing application's Git index.
    unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE
    GIT_CEILING_DIRECTORIES="$(dirname -- "$ds4_dir")" git -C "$ds4_dir" apply "$@" "$patch_file"
)
if apply_patch --reverse --check >/dev/null 2>&1; then
    if [ "$action" = restore ]; then
        apply_patch --reverse
        echo "DStudio Laguna prefill chunk patch: restored"
    else
        echo "DStudio Laguna prefill chunk patch: already applied"
    fi
elif apply_patch --check --whitespace=error >/dev/null 2>&1; then
    case "$action" in
        restore) echo "DStudio Laguna prefill chunk patch: already restored" ;;
        check) echo "DStudio Laguna prefill chunk patch: applicable" ;;
        *) apply_patch --whitespace=error
           echo "DStudio Laguna prefill chunk patch: applied" ;;
    esac
elif grep -q 'ds4_laguna_prefill_chunk(' "$ds4_dir/ds4.c"; then
    echo "DStudio Laguna prefill chunk patch: partial or edited patch; no files changed" >&2
    exit 1
else
    echo "DStudio Laguna prefill chunk patch: source drift in the Laguna graph; no files changed" >&2
    exit 1
fi

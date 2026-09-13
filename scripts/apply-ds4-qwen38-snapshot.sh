#!/bin/sh
# Publish native speculative snapshot readiness only after complete allocation.
set -eu
action=${1:-apply}
case "$action" in apply|check|restore) ;; *)
    echo 'Qwen snapshot patch: expected apply, check, or restore' >&2; exit 2 ;;
esac
engine_dir=${DS4_DIR:-}
if [ -z "$engine_dir" ] || [ ! -f "$engine_dir/ds4.c" ] || [ -L "$engine_dir/ds4.c" ] ||
   [ ! -f "$engine_dir/ds4.h" ] || [ -L "$engine_dir/ds4.h" ]; then
    echo 'Qwen snapshot patch: expected regular core source/header' >&2; exit 2
fi
if ! grep -q '^bool ds4_engine_is_qwen4(ds4_engine \*e);' "$engine_dir/ds4.h"; then
    echo 'Qwen snapshot patch: wrong engine ABI' >&2; exit 1
fi
engine_dir=$(CDPATH= cd -- "$engine_dir" && pwd -P)
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
if grep -q '^static bool qwen4_graph_ensure_snap0(' "$engine_dir/ds4.c"; then
    variant=snapshot-allocation.patch
elif grep -q '^static bool qwen4_graph_ensure_snap2(' "$engine_dir/ds4.c"; then
    variant=depth3-allocation.patch
else
    echo 'Qwen snapshot patch: earlier source has no lazy speculative snapshot sets'
    exit 0
fi
apply_input() (
    unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE
    GIT_CEILING_DIRECTORIES="$(dirname -- "$engine_dir")" git -C "$engine_dir" apply "$@" \
        "$script_dir/../patch/ds4-qwen38-snapshot/$variant"
)
if apply_input --reverse --check >/dev/null 2>&1; then
    if [ "$action" = restore ]; then
        apply_input --reverse
        echo "Qwen snapshot patch: restored ($variant)"
    else
        echo "Qwen snapshot patch: already applied ($variant)"
    fi
elif apply_input --check --whitespace=error >/dev/null 2>&1; then
    case "$action" in
        restore) echo "Qwen snapshot patch: already restored ($variant)" ;;
        check) echo "Qwen snapshot patch: applicable ($variant)" ;;
        apply) apply_input --whitespace=error; echo "Qwen snapshot patch: applied ($variant)" ;;
    esac
else
    echo 'Qwen snapshot patch: drift or partial source; no files changed' >&2
    exit 1
fi

#!/bin/sh
# Qwen3.6 discovery only; inference, templates and legacy request aliases stay native.
set -eu
action=${1:-apply}
case "$action" in apply|check|restore) ;; *)
    echo 'Qwen catalog patch: expected apply, check, or restore' >&2; exit 2 ;;
esac
engine_dir=${DS4_DIR:-}
if [ -z "$engine_dir" ] || [ ! -f "$engine_dir/ds4_server.c" ] ||
   [ -L "$engine_dir/ds4_server.c" ] || [ ! -f "$engine_dir/ds4.h" ]; then
    echo 'Qwen catalog patch: expected a regular ds4_server.c in DS4_DIR' >&2
    exit 2
fi
if ! grep -q '^bool ds4_engine_is_qwen35moe(ds4_engine \*e);' "$engine_dir/ds4.h"; then
    echo 'Qwen catalog patch: not a Qwen3.5/3.6 native engine ABI' >&2
    exit 1
fi
engine_dir=$(CDPATH= cd -- "$engine_dir" && pwd -P)
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
catalog_patch="$script_dir/../patch/ds4-qwen35-catalog/native-model-id.patch"
apply_catalog() (
    # An archive inside DStudio must never inherit or modify DStudio's index.
    unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE
    GIT_CEILING_DIRECTORIES="$(dirname -- "$engine_dir")" git -C "$engine_dir" apply "$@" "$catalog_patch"
)
if apply_catalog --reverse --check >/dev/null 2>&1; then
    if [ "$action" = restore ]; then
        apply_catalog --reverse
        echo 'Qwen catalog patch: restored'
    else
        echo 'Qwen catalog patch: already applied'
    fi
elif apply_catalog --check --whitespace=error >/dev/null 2>&1; then
    case "$action" in
        restore) echo 'Qwen catalog patch: already restored' ;;
        check) echo 'Qwen catalog patch: applicable' ;;
        apply) apply_catalog --whitespace=error; echo 'Qwen catalog patch: applied' ;;
    esac
else
    echo 'Qwen catalog patch: wrong source, drift or partial patch; no files changed' >&2
    exit 1
fi

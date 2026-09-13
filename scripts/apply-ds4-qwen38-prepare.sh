#!/bin/sh
# Qwen's unpublished reset candidate may be discarded between GPU layers.
set -eu
action=${1:-apply}
case "$action" in apply|check|restore) ;; *)
    echo 'Qwen candidate patch: expected apply, check, or restore' >&2; exit 2 ;;
esac
engine_dir=${DS4_DIR:-}
if [ -z "$engine_dir" ] || [ ! -f "$engine_dir/ds4.c" ] ||
   [ -L "$engine_dir/ds4.c" ] || [ ! -f "$engine_dir/ds4.h" ] ||
   [ -L "$engine_dir/ds4.h" ]; then
    echo 'Qwen candidate patch: expected regular ds4.c and ds4.h in DS4_DIR' >&2
    exit 2
fi
if ! grep -q '^bool ds4_engine_is_qwen4(ds4_engine \*e);' "$engine_dir/ds4.h"; then
    echo 'Qwen candidate patch: not a Qwen3.8 native engine ABI' >&2
    exit 1
fi
engine_dir=$(CDPATH= cd -- "$engine_dir" && pwd -P)
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
apply_input() (
    unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE
    GIT_CEILING_DIRECTORIES="$(dirname -- "$engine_dir")" git -C "$engine_dir" apply "$@" "$input_patch"
)
for variant in prepare-current.patch prepare-empty.patch; do
input_patch="$script_dir/../patch/ds4-qwen38-prepare/$variant"
if apply_input --reverse --check >/dev/null 2>&1; then
    if [ "$action" = restore ]; then
        apply_input --reverse
        echo 'Qwen candidate patch: restored'
    else
        echo 'Qwen candidate patch: already applied'
    fi
    exit 0
elif apply_input --check --whitespace=error >/dev/null 2>&1; then
    case "$action" in
        restore) echo 'Qwen candidate patch: already restored' ;;
        check) echo 'Qwen candidate patch: applicable' ;;
        apply) apply_input --whitespace=error; echo 'Qwen candidate patch: applied' ;;
    esac
    exit 0
fi
done
echo 'Qwen candidate patch: source drift, partial patch or wrong source; no files changed' >&2
exit 1

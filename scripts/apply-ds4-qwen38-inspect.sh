#!/bin/sh
# Metadata inspection must not ask the OS to preload the 32 GB PLE table.
set -eu
action=${1:-apply}
case "$action" in apply|check|restore) ;; *)
    echo 'Qwen PLE inspection patch: expected apply, check, or restore' >&2; exit 2 ;;
esac
engine_dir=${DS4_DIR:-}
if [ -z "$engine_dir" ] || [ ! -f "$engine_dir/ds4.c" ] ||
   [ -L "$engine_dir/ds4.c" ] || [ ! -f "$engine_dir/ds4.h" ]; then
    echo 'Qwen PLE inspection patch: expected a regular ds4.c in DS4_DIR' >&2
    exit 2
fi
if ! grep -q '^bool ds4_engine_is_qwen4(ds4_engine \*e);' "$engine_dir/ds4.h"; then
    echo 'Qwen PLE inspection patch: not a Qwen3.8 native engine ABI' >&2
    exit 1
fi
engine_dir=$(CDPATH= cd -- "$engine_dir" && pwd -P)
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
apply_input() (
    unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE
    GIT_CEILING_DIRECTORIES="$(dirname -- "$engine_dir")" git -C "$engine_dir" apply "$@" "$input_patch"
)
for variant in metadata-current.patch metadata-only-ple.patch; do
input_patch="$script_dir/../patch/ds4-qwen38-inspect/$variant"
if apply_input --reverse --check >/dev/null 2>&1; then
    if [ "$action" = restore ]; then
        apply_input --reverse
        echo "Qwen PLE inspection patch: restored ($variant)"
    else
        echo "Qwen PLE inspection patch: already applied ($variant)"
    fi
    exit 0
elif apply_input --check --whitespace=error >/dev/null 2>&1; then
    case "$action" in
        restore) echo 'Qwen PLE inspection patch: already restored' ;;
        check) echo 'Qwen PLE inspection patch: applicable' ;;
        apply) apply_input --whitespace=error; echo 'Qwen PLE inspection patch: applied' ;;
    esac
    exit 0
fi
done
echo 'Qwen PLE inspection patch: source drift or wrong source; no files changed' >&2
exit 1

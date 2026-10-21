#!/bin/sh
# Pair DeepSeek V4.1 vision sidecars with the language GGUF by source revision
# (antirez/ds4 PR #1225) instead of one hard-coded checkpoint revision.
set -eu
action=${1:-apply}
case "$action" in apply|build|check|restore) ;; *)
    echo "DStudio V4.1 vision pairing patch: expected apply, build, check, or restore" >&2
    exit 2 ;;
esac
ds4_dir=${DS4_DIR:-}
if [ -z "$ds4_dir" ] || [ ! -f "$ds4_dir/ds4.c" ]; then
    echo "DStudio V4.1 vision pairing patch: invalid DS4_DIR" >&2
    exit 2
fi
ds4_dir=$(CDPATH= cd -- "$ds4_dir" && pwd)
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
patch_file="$script_dir/../patch/ds4-v41-vision-pairing/vision-revision.patch"
apply_patch() (
    unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE
    GIT_CEILING_DIRECTORIES="$(dirname -- "$ds4_dir")" git -C "$ds4_dir" apply "$@" "$patch_file"
)
if apply_patch --reverse --check >/dev/null 2>&1; then
    if [ "$action" = restore ]; then
        apply_patch --reverse
        echo "DStudio V4.1 vision pairing patch: restored"
    else
        echo "DStudio V4.1 vision pairing patch: already applied"
    fi
elif apply_patch --check --whitespace=error >/dev/null 2>&1; then
    case "$action" in
        restore) echo "DStudio V4.1 vision pairing patch: already restored" ;;
        check) echo "DStudio V4.1 vision pairing patch: applicable" ;;
        *) apply_patch --whitespace=error
           echo "DStudio V4.1 vision pairing patch: applied" ;;
    esac
elif ! grep -q 'df42c109f1defefcbfcedbe7d905718a12266e40' "$ds4_dir/ds4.c" &&
     ! grep -q 'ds4_str_eq(language, vision)' "$ds4_dir/ds4.c"; then
    # No V4.1 vision encoder, or upstream already pairs by source revision.
    # A file carrying our own marker but failing the reverse check is drift.
    echo "DStudio V4.1 vision pairing patch: not needed (no hard-coded V4.1 revision); skipped"
else
    echo "DStudio V4.1 vision pairing patch: source drift or partial patch; no files changed" >&2
    exit 1
fi

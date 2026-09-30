#!/bin/sh
set -eu

ds4_dir=${DS4_DIR:-}
if [ -z "$ds4_dir" ] || [ ! -f "$ds4_dir/ds4.c" ]; then
    echo "DStudio media memory patch: invalid DS4_DIR" >&2
    exit 2
fi
ds4_dir=$(CDPATH= cd -- "$ds4_dir" && pwd -P)

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
patch_file="$script_dir/../patch/ds4-media-memory/residency-lease.patch"

action=${1:-apply}
case "$action" in apply|build|check|restore) ;; *)
    echo "DStudio media memory patch: expected apply, build, check, or restore" >&2; exit 2 ;;
esac
# Check every file before mutation. A marker or fuzzy patch(1) success can hide
# a partial adaptation when an upstream CUDA context changes.
apply_input() (
    unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE
    GIT_CEILING_DIRECTORIES="$(dirname -- "$ds4_dir")" git -C "$ds4_dir" apply "$@" "$patch_file"
)
if apply_input --reverse --check >/dev/null 2>&1; then
    if [ "$action" = restore ]; then
        apply_input --reverse
        echo "DStudio media memory patch: restored"
    else
        echo "DStudio media memory patch: already applied"
    fi
    exit 0
elif apply_input --check --whitespace=error >/dev/null 2>&1; then
    case "$action" in
        restore) echo "DStudio media memory patch: already restored" ;;
        check) echo "DStudio media memory patch: applicable" ;;
        *) apply_input --whitespace=error; echo "DStudio media memory patch: applied" ;;
    esac
    exit 0
fi
echo "DStudio media memory patch: source drift or partial patch; no files changed" >&2
exit 1

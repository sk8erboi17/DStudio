#!/bin/sh
# Keep native encoder/routing weights valid across Metal SSD span replacement.
set -eu
action=${1:-apply}
case "$action" in apply|build|check|restore) ;; *)
    echo "DStudio vision streaming patch: expected apply, build, check, or restore" >&2
    exit 2 ;;
esac
ds4_dir=${DS4_DIR:-}
if [ -z "$ds4_dir" ] || [ ! -f "$ds4_dir/ds4.c" ]; then
    echo "DStudio vision streaming patch: invalid DS4_DIR" >&2
    exit 2
fi
ds4_dir=$(CDPATH= cd -- "$ds4_dir" && pwd)
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
patch_file="$script_dir/../patch/ds4-vision-streaming/vision-map.patch"
if [ "$(uname -s)" != Darwin ] ||
   ! grep -q 'static int ds4_engine_vision_encode_image' "$ds4_dir/ds4.c"; then
    echo "DStudio vision streaming patch: unsupported platform/encoder skipped"
    exit 0
fi
apply_patch() (
    unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE
    GIT_CEILING_DIRECTORIES="$(dirname -- "$ds4_dir")" git -C "$ds4_dir" apply "$@" "$patch_file"
)
if apply_patch --reverse --check >/dev/null 2>&1; then
    if [ "$action" = restore ]; then
        apply_patch --reverse
        echo "DStudio vision streaming patch: restored"
    else
        echo "DStudio vision streaming patch: already applied"
    fi
elif apply_patch --check --whitespace=error >/dev/null 2>&1; then
    case "$action" in
        restore) echo "DStudio vision streaming patch: already restored" ;;
        check) echo "DStudio vision streaming patch: applicable" ;;
        *) apply_patch --whitespace=error
           echo "DStudio vision streaming patch: applied" ;;
    esac
else
    echo "DStudio vision streaming patch: source drift or partial patch; no files changed" >&2
    exit 1
fi

#!/bin/sh
# Select a complete versioned delta; never accept a marker or fuzzy partial apply.
set -eu
action=${1:-apply}
case "$action" in apply|build|check|restore) ;; *)
    echo "DStudio visible downloads patch: expected apply, build, check, or restore" >&2
    exit 2 ;;
esac
ds4_dir=${DS4_DIR:-}
if [ -z "$ds4_dir" ] || [ ! -f "$ds4_dir/download_model.sh" ]; then
    echo "DStudio visible downloads patch: invalid DS4_DIR" >&2
    exit 2
fi
ds4_dir=$(CDPATH= cd -- "$ds4_dir" && pwd)
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if grep -q 'qwen38-q4k' "$ds4_dir/download_model.sh" ||
   ! grep -q 'ds4f-vision-q2' "$ds4_dir/download_model.sh" ||
   ! grep -q 'glm53-q2' "$ds4_dir/download_model.sh"; then
    echo "DStudio visible downloads patch: non-main checkout skipped"
    exit 0
fi

apply_file() (
    patch_file=$1
    shift
    unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE
    GIT_CEILING_DIRECTORIES="$(dirname -- "$ds4_dir")" git -C "$ds4_dir" apply  "$@" "$patch_file"
)
for variant in main-v41.patch visible-partials.patch; do
    patch_file="$script_dir/../patch/ds4-visible-downloads/$variant"
    if apply_file "$patch_file" --reverse --check >/dev/null 2>&1; then
        if [ "$action" = restore ]; then
            apply_file "$patch_file" --reverse
            echo "DStudio visible downloads patch: restored ($variant)"
        else
            echo "DStudio visible downloads patch: already applied ($variant)"
        fi
        exit 0
    fi
    if apply_file "$patch_file" --check --whitespace=error >/dev/null 2>&1; then
        case "$action" in
            restore) echo "DStudio visible downloads patch: already restored ($variant)" ;;
            check) echo "DStudio visible downloads patch: applicable ($variant)" ;;
            *) apply_file "$patch_file" --whitespace=error
               echo "DStudio visible downloads patch: applied ($variant)" ;;
        esac
        exit 0
    fi
done
echo "DStudio visible downloads patch: source drift or partial patch; no files changed" >&2
exit 1

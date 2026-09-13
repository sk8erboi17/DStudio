#!/bin/sh
# Select a complete versioned delta; never accept a marker or fuzzy partial apply.
set -eu
action=${1:-apply}
case "$action" in apply|build|check|restore) ;; *)
    echo "DStudio GLM 5.3 runtime patch: expected apply, build, check, or restore" >&2
    exit 2 ;;
esac
ds4_dir=${DS4_DIR:-}
if [ -z "$ds4_dir" ] || [ ! -f "$ds4_dir/ds4.c" ]; then
    echo "DStudio GLM 5.3 runtime patch: invalid DS4_DIR" >&2
    exit 2
fi
ds4_dir=$(CDPATH= cd -- "$ds4_dir" && pwd)
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if ! grep -q 'static bool ds4_model_is_glm53' "$ds4_dir/ds4.c"; then
    echo "DStudio GLM 5.3 runtime patch: non-GLM checkout skipped"
    exit 0
fi

apply_file() (
    patch_file=$1
    shift
    unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE
    GIT_CEILING_DIRECTORIES="$(dirname -- "$ds4_dir")" git -C "$ds4_dir" apply --unidiff-zero "$@" "$patch_file"
)
for variant in main-v41.patch streaming-memory.patch; do
    patch_file="$script_dir/../patch/ds4-glm53-runtime/$variant"
    if apply_file "$patch_file" --reverse --check >/dev/null 2>&1; then
        if [ "$action" = restore ]; then
            apply_file "$patch_file" --reverse
            echo "DStudio GLM 5.3 runtime patch: restored ($variant)"
        else
            echo "DStudio GLM 5.3 runtime patch: already applied ($variant)"
        fi
        exit 0
    fi
    if apply_file "$patch_file" --check --whitespace=error >/dev/null 2>&1; then
        case "$action" in
            restore) echo "DStudio GLM 5.3 runtime patch: already restored ($variant)" ;;
            check) echo "DStudio GLM 5.3 runtime patch: applicable ($variant)" ;;
            *) apply_file "$patch_file" --whitespace=error
               echo "DStudio GLM 5.3 runtime patch: applied ($variant)" ;;
        esac
        exit 0
    fi
done
echo "DStudio GLM 5.3 runtime patch: source drift or partial patch; no files changed" >&2
exit 1

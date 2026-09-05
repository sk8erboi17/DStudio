#!/bin/sh
# Managed source patch, not a model mode: never enables SSD streaming or MTP.
set -eu

action=${1:-apply}
case "$action" in apply|build|check|restore) ;; *)
    echo "DStudio M2 Max patch: expected apply, build, check, or restore" >&2
    exit 2 ;;
esac
ds4_dir=${DS4_DIR:-}
if [ -z "$ds4_dir" ] || [ ! -f "$ds4_dir/ds4.c" ]; then
    echo "DStudio M2 Max patch: invalid DS4_DIR" >&2
    exit 2
fi
ds4_dir=$(CDPATH= cd -- "$ds4_dir" && pwd)
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
patch_file="$script_dir/../patch/ds4-glm53-m2max/native-decode.patch"

# Only macOS builds consume this port. The compiled runtime still checks the
# exact Apple M2 Max / GLM53 Q2 / top-8 / token-one / SSD shape at dispatch.
if [ "$(uname -s)" != Darwin ] ||
   ! grep -q 'static bool ds4_model_is_glm53' "$ds4_dir/ds4.c"; then
    echo "DStudio M2 Max patch: unsupported platform or non-GLM checkout skipped"
    exit 0
fi
command -v git >/dev/null 2>&1 || {
    echo "DStudio M2 Max patch: git from Apple Command Line Tools is required" >&2
    exit 1
}

# git apply checks the entire eight-file patch before writing, unlike a series
# of patch(1) edits that can leave a half-applied runtime. A source archive can
# live under another Git checkout; never discover or write that parent index.
apply_file() (
    input_patch=$1
    shift
    unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE
    GIT_CEILING_DIRECTORIES="$(dirname -- "$ds4_dir")" git -C "$ds4_dir" apply "$@" "$input_patch"
)
apply_patch() { apply_file "$patch_file" "$@"; }
if apply_patch --reverse --check >/dev/null 2>&1; then
    if [ "$action" = restore ]; then
        apply_patch --reverse
        echo "DStudio M2 Max patch: restored"
    else
        echo "DStudio M2 Max patch: already applied"
    fi
elif apply_patch --check --whitespace=error >/dev/null 2>&1; then
    case "$action" in
        restore) echo "DStudio M2 Max patch: already restored" ;;
        check) echo "DStudio M2 Max patch: applicable" ;;
        *) apply_patch --whitespace=error
           echo "DStudio M2 Max patch: applied" ;;
    esac
else
    # Recognize the COMPLETE previously shipped port before upgrading its one
    # wrong batch-resource bound. Never partially repair a drifted port. Derive
    # the old patch mechanically to avoid shipping a duplicate eight-file delta.
    legacy_patch=$(mktemp "${TMPDIR:-/tmp}/dstudio-m2-legacy.XXXXXX")
    trap 'rm -f "$legacy_patch"' EXIT HUP INT TERM
    sed 's/^+        n_entries > DS4_METAL_STREAM_EXPERT_CACHE_MAX_EXPERT ||$/+        n_entries > DS4_METAL_MAX_ROUTED_EXPERT_USED ||/' \
        "$patch_file" > "$legacy_patch"
    if apply_file "$legacy_patch" --reverse --check >/dev/null 2>&1; then
        case "$action" in
            check) echo "DStudio M2 Max patch: batch-limit upgrade available (no changes)" ;;
            restore) apply_file "$legacy_patch" --reverse
                     echo "DStudio M2 Max patch: legacy port restored" ;;
            *) apply_file "$script_dir/../patch/ds4-glm53-m2max/batch-entry-limit.patch" --whitespace=error
               echo "DStudio M2 Max patch: upgraded batch resource limit" ;;
        esac
        exit 0
    fi
    echo "DStudio M2 Max patch: source drift or partial patch; no files changed" >&2
    echo "Restore/rebase the complete managed patch before rebuilding. Local edits were preserved." >&2
    exit 1
fi

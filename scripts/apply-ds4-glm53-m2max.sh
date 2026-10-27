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
patch_file="$script_dir/../patch/ds4-glm53-m2max/native-decode-main-qwen.patch"

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

# The bundled main already fixes ds4_image linkage and adds Metal tests: keep
# the runtime delta, replace its build hunks, add the hot-list layout, and
# check/apply everything as a single atomic git patch.
main_patch=
cleanup() {
    [ -z "$main_patch" ] || rm -f "$main_patch"
}
trap cleanup EXIT HUP INT TERM
main_patch=$(mktemp "${TMPDIR:-/tmp}/dstudio-m2-main.XXXXXX")
awk '/^diff --git / { skip = ($3 == "a/Makefile" || $3 == "a/.gitignore") }
     !skip { print }' "$patch_file" > "$main_patch"
cat "$script_dir/../patch/ds4-glm53-m2max/build-main-current.patch" \
    "$script_dir/../patch/ds4-glm53-m2max/hotlist-main-layout.patch" >> "$main_patch"
patch_file=$main_patch

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
    echo "DStudio M2 Max patch: source drift or partial patch; no files changed" >&2
    echo "Restore/rebase the complete managed patch before rebuilding. Local edits were preserved." >&2
    exit 1
fi

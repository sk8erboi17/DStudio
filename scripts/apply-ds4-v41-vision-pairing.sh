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
else
    # Neither direction applies. Skip only when the vision bind no longer pins
    # a V4.1 checkpoint: any 40-hex revision in it other than Vision-Exp's
    # means a hard-coded V4.1 revision this patch does not know (for example
    # upstream switched it to another checkpoint), and skipping would silently
    # refuse the sidecars it does not name. Our own marker is a partial patch.
    bind_revisions=$(awk '/^static void deepseek4_vision_weights_bind\(/ {inside = 1}
                          inside {print} inside && /^}/ {exit}' "$ds4_dir/ds4.c" |
        grep -Eo '"[0-9a-f]{40}"' | grep -v '"e46e16bf6035c6f317eb2ac7458eb0362926d402"' || true)
    if grep -q 'ds4_str_eq(language, vision)' "$ds4_dir/ds4.c"; then
        echo "DStudio V4.1 vision pairing patch: partial or edited patch; no files changed" >&2
        exit 1
    elif [ -n "$bind_revisions" ]; then
        echo "DStudio V4.1 vision pairing patch: source drift, the vision bind still hard-codes a V4.1 revision ($(echo $bind_revisions | tr -d '"')); no files changed" >&2
        exit 1
    else
        # No V4.1 vision encoder, or upstream no longer pins one checkpoint.
        echo "DStudio V4.1 vision pairing patch: not needed (no hard-coded V4.1 revision); skipped"
    fi
fi

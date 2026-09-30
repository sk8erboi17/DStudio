#!/bin/sh
# Qwen3.6 fork only: correct the Q6_K nibble order in the fused MoE Metal
# kernels. Shaders compile from source at engine start, so no rebuild is needed.
set -eu
action=${1:-apply}
case "$action" in apply|check|restore) ;; *)
    echo 'Qwen3.6 Q6_K MoE patch: expected apply, check, or restore' >&2; exit 2 ;;
esac
engine_dir=${DS4_DIR:-}
if [ -z "$engine_dir" ] || [ ! -f "$engine_dir/metal/qwen35.metal" ] ||
   [ -L "$engine_dir/metal/qwen35.metal" ] || [ -L "$engine_dir/metal" ] ||
   [ ! -f "$engine_dir/ds4.h" ]; then
    echo 'Qwen3.6 Q6_K MoE patch: expected a regular metal/qwen35.metal in DS4_DIR' >&2
    exit 2
fi
if ! grep -q '^bool ds4_engine_is_qwen35moe(ds4_engine \*e);' "$engine_dir/ds4.h"; then
    echo 'Qwen3.6 Q6_K MoE patch: not a Qwen3.5/3.6 native engine ABI' >&2
    exit 1
fi
engine_dir=$(CDPATH= cd -- "$engine_dir" && pwd -P)
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
patch_file="$script_dir/../patch/ds4-qwen35-q6k-moe/moe-q6k-nibble.patch"
apply_patch() (
    # An archive inside DStudio must never inherit or modify DStudio's index.
    unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE
    GIT_CEILING_DIRECTORIES="$(dirname -- "$engine_dir")" git -C "$engine_dir" apply "$@" "$patch_file"
)
# Git checks every hunk before writing: a partial or drifted source is rejected
# as a whole and left unchanged.
if apply_patch --reverse --check >/dev/null 2>&1; then
    if [ "$action" = restore ]; then
        apply_patch --reverse
        echo 'Qwen3.6 Q6_K MoE patch: restored'
    else
        echo 'Qwen3.6 Q6_K MoE patch: already applied'
    fi
elif apply_patch --check --whitespace=error >/dev/null 2>&1; then
    case "$action" in
        restore) echo 'Qwen3.6 Q6_K MoE patch: already restored' ;;
        check) echo 'Qwen3.6 Q6_K MoE patch: applicable' ;;
        apply) apply_patch --whitespace=error; echo 'Qwen3.6 Q6_K MoE patch: applied' ;;
    esac
else
    echo 'Qwen3.6 Q6_K MoE patch: wrong source, drift or partial patch; no files changed' >&2
    exit 1
fi

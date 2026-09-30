#!/bin/sh
# Pinned q36 Metal operator/publication adaptation; no model or build side effects.
set -eu
action=${1:-apply}
case "$action" in apply|check|restore) ;; *) echo 'Expected apply, check, or restore' >&2; exit 2 ;; esac
variant=${2:-pinned}
# Each runtime variant targets one reviewed upstream GPU ABI. 1305843 adds only
# q36_gpu_gdn_front_tensor, which q36.c calls outside Metal builds (#ifndef
# Q36_METAL); the Metal adaptation is otherwise the 8362010 runtime rebased.
previous_abi=27e0000128e353d82d4ba730ac64435919f48e93
current_abi=bcfa9e3d5bccc911d48b14c77ee08f76a8642f45
case "$variant" in
    pinned) patch_name=runtime.patch; abis=$previous_abi ;;
    next-review) patch_name=next-review.patch; abis=$previous_abi ;;
    current) patch_name=runtime-1305843.patch; abis=$current_abi ;;
    cache-usage) patch_name=cache-usage.patch; abis="$previous_abi $current_abi" ;;
    *) echo 'Expected pinned, next-review, current or cache-usage patch variant' >&2; exit 2 ;;
esac
[ "$#" -le 2 ] || { echo 'Unexpected patch arguments' >&2; exit 2; }
engine_dir=${Q36_DIR:-}
if [ -z "$engine_dir" ] || [ -L "$engine_dir" ] || [ ! -d "$engine_dir" ]; then
    echo 'Expected a real Q36_DIR directory' >&2; exit 2
fi
engine_dir=$(CDPATH= cd -- "$engine_dir" && pwd -P)
for file in q36_gpu.h q36.h q36.c q36_metal.m q36_server.c metal/recurrent.metal tests/q36_test.c; do
    if [ ! -f "$engine_dir/$file" ] || [ -L "$engine_dir/$file" ]; then
        echo "Expected a regular q36 source file: $file" >&2; exit 2
    fi
done
if [ -L "$engine_dir/metal" ]; then echo 'Linked shader directory rejected' >&2; exit 2; fi
if [ -L "$engine_dir/tests" ]; then echo 'Linked test directory rejected' >&2; exit 2; fi
if [ -e "$engine_dir/metal/vision.metal" ] || [ -L "$engine_dir/metal/vision.metal" ]; then
    if [ ! -f "$engine_dir/metal/vision.metal" ] || [ -L "$engine_dir/metal/vision.metal" ]; then
        echo 'Linked/nonregular vision shader rejected' >&2; exit 2
    fi
fi
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
input_patch="$script_dir/../patch/q36-metal-runtime/$patch_name"
source_git() {
    env -i PATH="$PATH" LC_ALL=C GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null \
        GIT_CEILING_DIRECTORIES="$(dirname -- "$engine_dir")" git -C "$engine_dir" "$@"
}
# Freeze the GPU ABI, not every byte of the editable implementation. Unrelated
# contributor edits survive apply/restore; new upstream ABIs require review.
abi=$(source_git hash-object q36_gpu.h)
case " $abis " in *" $abi "*) ;; *)
    echo 'Unsupported q36 GPU ABI; no files changed' >&2; exit 1 ;;
esac
if source_git apply --reverse --check "$input_patch" >/dev/null 2>&1; then
    if [ "$action" = restore ]; then source_git apply --reverse "$input_patch"; fi
elif source_git apply --check --whitespace=error "$input_patch" >/dev/null 2>&1; then
    if [ "$action" = apply ]; then source_git apply --whitespace=error "$input_patch"; fi
else
    echo 'q36 Metal: source drift, partial adaptation or wrong base; no files changed' >&2
    exit 1
fi
echo "q36 Metal: $action ok"

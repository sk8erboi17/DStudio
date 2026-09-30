#!/bin/sh
# Overlay after the complete q36 Metal runtime adaptation.
set -eu
action=${1:-apply}
case "$action" in apply|check|restore) ;; *) echo 'Expected apply, check, or restore' >&2; exit 2 ;; esac
variant=${2:-pinned}
case "$variant" in
    pinned) patch_name=runtime.patch ;;
    online) patch_name=online-1305843.patch ;;
    *) echo 'Expected pinned or online attention variant' >&2; exit 2 ;;
esac
[ "$#" -le 2 ] || { echo 'Unexpected patch arguments' >&2; exit 2; }
engine_dir=${Q36_DIR:-}
if [ -z "$engine_dir" ] || [ -L "$engine_dir" ] || [ ! -d "$engine_dir" ]; then
    echo 'Expected a real Q36_DIR directory' >&2; exit 2
fi
engine_dir=$(CDPATH= cd -- "$engine_dir" && pwd -P)
if [ -L "$engine_dir/metal" ]; then echo 'Linked shader directory rejected' >&2; exit 2; fi
for file in q36_metal.m metal/attention.metal; do
    if [ -L "$engine_dir/$file" ] || [ ! -f "$engine_dir/$file" ]; then
        echo 'Expected regular q36 attention source' >&2; exit 2
    fi
done
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
input_patch="$script_dir/../patch/q36-f16-attention/$patch_name"
source_git() {
    env -i PATH="$PATH" LC_ALL=C GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null \
        GIT_CEILING_DIRECTORIES="$(dirname -- "$engine_dir")" git -C "$engine_dir" "$@"
}
if [ "$variant" = online ]; then
    if [ -L "$engine_dir/q36_gpu.h" ] || [ ! -f "$engine_dir/q36_gpu.h" ]; then
        echo 'Expected regular q36 GPU ABI' >&2; exit 2
    fi
    if [ "$(source_git hash-object q36_gpu.h)" != bcfa9e3d5bccc911d48b14c77ee08f76a8642f45 ]; then
        echo 'Unsupported q36 GPU ABI for online attention; no files changed' >&2; exit 1
    fi
fi
if source_git apply --reverse --check "$input_patch" >/dev/null 2>&1; then
    if [ "$action" = restore ]; then source_git apply --reverse "$input_patch"; fi
elif source_git apply --check --whitespace=error "$input_patch" >/dev/null 2>&1; then
    if [ "$action" = apply ]; then source_git apply --whitespace=error "$input_patch"; fi
else
    echo 'q36 F16 attention: wrong base, partial state or drift; no source changed' >&2
    exit 1
fi
echo "q36 F16 attention: $action ok"

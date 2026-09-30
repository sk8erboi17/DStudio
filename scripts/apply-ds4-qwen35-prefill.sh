#!/bin/sh
# Bounded Metal prefill overlay on vagrillo/ds4 73434c4, after Q6_K MoE fix.
set -eu
action=${1:-apply}
case "$action" in apply|check|restore) ;; *) echo 'Expected apply, check, or restore' >&2; exit 2 ;; esac
[ "$#" -le 1 ] || { echo 'Unexpected patch arguments' >&2; exit 2; }
engine_dir=${DS4_DIR:-}
if [ -z "$engine_dir" ] || [ -L "$engine_dir" ] || [ ! -d "$engine_dir" ]; then
    echo 'Expected a real DS4_DIR directory' >&2; exit 2
fi
engine_dir=$(CDPATH= cd -- "$engine_dir" && pwd -P)
for file in ds4.c ds4.h ds4_gpu.h ds4_metal.m metal/qwen35.metal; do
    if [ ! -f "$engine_dir/$file" ] || [ -L "$engine_dir/$file" ]; then
        echo "Expected regular Qwen3.6 source: $file" >&2; exit 2
    fi
done
[ ! -L "$engine_dir/metal" ] || { echo 'Linked shader directory rejected' >&2; exit 2; }
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
input_patch="$script_dir/../patch/ds4-qwen35-prefill/prefill-73434c4.patch"
source_git() {
    env -i PATH="$PATH" LC_ALL=C GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null \
        GIT_CEILING_DIRECTORIES="$(dirname -- "$engine_dir")" git -C "$engine_dir" "$@"
}
# The public engine ABI is unchanged; edits to unrelated implementation survive.
if [ "$(source_git hash-object ds4.h)" != 5e05a8daf252b7807a05e85a767bea380b210ac9 ]; then
    echo 'Unsupported Qwen3.6 engine ABI; no files changed' >&2; exit 1
fi
if source_git apply --reverse --check "$input_patch" >/dev/null 2>&1; then
    if [ "$action" = restore ]; then source_git apply --reverse "$input_patch"; fi
elif source_git apply --check --whitespace=error "$input_patch" >/dev/null 2>&1; then
    if [ "$action" = apply ]; then source_git apply --whitespace=error "$input_patch"; fi
else
    echo 'Qwen3.6 prefill: wrong base, partial patch or drift; no files changed' >&2; exit 1
fi
echo "Qwen3.6 prefill: $action ok"

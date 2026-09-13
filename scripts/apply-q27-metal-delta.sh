#!/bin/sh
# Exact-context native DeltaNet column tiling; no builds, model or process changes.
set -eu
action=${1:-apply}
case "$action" in apply|check|restore) ;; *) echo 'Expected apply, check, or restore' >&2; exit 2 ;; esac
engine_dir=${Q27_DIR:-}
if [ -z "$engine_dir" ] || [ -L "$engine_dir" ] || [ ! -d "$engine_dir" ]; then
    echo 'Expected a real Q27_DIR directory' >&2; exit 2
fi
engine_dir=$(CDPATH= cd -- "$engine_dir" && pwd -P)
for dir in src src/metal; do
    if [ -L "$engine_dir/$dir" ] || [ ! -d "$engine_dir/$dir" ]; then
        echo "Linked/missing source directory: $dir" >&2; exit 2
    fi
done
for file in src/metal/metal_backend.h src/metal/metal_backend.mm src/metal/q27_kernels.metal; do
    if [ ! -f "$engine_dir/$file" ] || [ -L "$engine_dir/$file" ]; then
        echo "Expected a regular q27 source file: $file" >&2; exit 2
    fi
done
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
input_patch="$script_dir/../patch/q27-metal-delta/columns64.patch"
source_git() {
    env -i PATH="$PATH" LC_ALL=C GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null \
        GIT_CEILING_DIRECTORIES="$(dirname -- "$engine_dir")" git -C "$engine_dir" "$@"
}
if [ "$(source_git hash-object src/metal/metal_backend.h)" != 08a85a261a45ad6dbcf3f4be0b12247c170948aa ]; then
    echo 'Unsupported q27 Metal ABI; no files changed' >&2; exit 1
fi
if source_git apply --reverse --check "$input_patch" >/dev/null 2>&1; then
    if [ "$action" = restore ]; then source_git apply --reverse "$input_patch"; fi
elif source_git apply --check --whitespace=error "$input_patch" >/dev/null 2>&1; then
    if [ "$action" = apply ]; then source_git apply --whitespace=error "$input_patch"; fi
else
    echo 'q27 Metal: source drift, partial adaptation or wrong base; no files changed' >&2
    exit 1
fi
echo "q27 Metal DeltaNet: $action ok"

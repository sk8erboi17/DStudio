#!/bin/sh
# Diagnostic candidate only; apply after the reviewed q36 Metal runtime patch.
set -eu
action=${1:-apply}
case "$action" in apply|check|restore) ;; *) echo 'Expected apply, check, or restore' >&2; exit 2 ;; esac
engine_dir=${Q36_DIR:-}
if [ -z "$engine_dir" ] || [ -L "$engine_dir" ] || [ ! -d "$engine_dir" ]; then
    echo 'Expected a real Q36_DIR directory' >&2; exit 2
fi
engine_dir=$(CDPATH= cd -- "$engine_dir" && pwd -P)
if [ -L "$engine_dir/q36_metal.m" ] || [ ! -f "$engine_dir/q36_metal.m" ]; then
    echo 'Expected regular q36_metal.m source' >&2; exit 2
fi
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
input_patch="$script_dir/../patch/q36-metal-diagnostics/runtime.patch"
source_git() {
    env -i PATH="$PATH" LC_ALL=C GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null \
        GIT_CEILING_DIRECTORIES="$(dirname -- "$engine_dir")" git -C "$engine_dir" "$@"
}
if source_git apply --reverse --check "$input_patch" >/dev/null 2>&1; then
    if [ "$action" = restore ]; then source_git apply --reverse "$input_patch"; fi
elif source_git apply --check --whitespace=error "$input_patch" >/dev/null 2>&1; then
    if [ "$action" = apply ]; then source_git apply --whitespace=error "$input_patch"; fi
else
    echo 'q36 Metal diagnostics: wrong base, partial state or drift; no source changed' >&2
    exit 1
fi
echo "q36 Metal diagnostics: $action ok"

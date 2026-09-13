#!/bin/sh
# Candidate private-terminal lifetime fix; no download, build or process launch.
set -eu
action=${1:-apply}
case "$action" in apply|check|restore) ;; *) echo 'Expected apply, check, or restore' >&2; exit 2 ;; esac
variant=${2:-pinned}
case "$variant" in
    pinned) patch_name=runtime.patch ;;
    monitor) patch_name=monitor.patch ;;
    monitor-owner) patch_name=monitor-owner.patch ;;
    *) echo 'Expected pinned, monitor or monitor-owner patch variant' >&2; exit 2 ;;
esac
[ "$#" -le 2 ] || { echo 'Unexpected patch arguments' >&2; exit 2; }
engine_dir=${Q36_DIR:-}
if [ -z "$engine_dir" ] || [ -L "$engine_dir" ] || [ ! -d "$engine_dir" ]; then
    echo 'Expected a real Q36_DIR directory' >&2; exit 2
fi
engine_dir=$(CDPATH= cd -- "$engine_dir" && pwd -P)
if [ -L "$engine_dir/tests" ]; then echo 'Linked test directory rejected' >&2; exit 2; fi
for file in q36_agent.c tests/test_agent_password.py; do
    if [ ! -f "$engine_dir/$file" ] || [ -L "$engine_dir/$file" ]; then
        echo "Expected regular source: $file" >&2; exit 2
    fi
done
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
input_patch="$script_dir/../patch/q36-agent-tty/$patch_name"
source_git() {
    env -i PATH="$PATH" LC_ALL=C GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null \
        GIT_CEILING_DIRECTORIES="$(dirname -- "$engine_dir")" git -C "$engine_dir" "$@"
}
if [ "$variant" = monitor-owner ] &&
   ! source_git apply --reverse --check "$script_dir/../patch/q36-agent-tty/monitor.patch" >/dev/null 2>&1; then
    echo 'q36 Agent monitor ownership requires the complete monitor patch first; no files changed' >&2
    exit 1
fi
if source_git apply --reverse --check "$input_patch" >/dev/null 2>&1; then
    if [ "$action" = restore ]; then source_git apply --reverse "$input_patch"; fi
elif source_git apply --check --whitespace=error "$input_patch" >/dev/null 2>&1; then
    if [ "$action" = apply ]; then source_git apply --whitespace=error "$input_patch"; fi
else
    echo 'q36 Agent tty: wrong base, partial adaptation or source drift; no files changed' >&2
    exit 1
fi
echo "q36 Agent tty: $action ok"

#!/bin/sh
set -eu

if [ "$(uname -s)" != "Darwin" ]; then
    echo "h3_sdpa_query_chunk_equivalence: NOT RUN (Metal requires macOS)" >&2
    exit 1
fi

h3_test_root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
h3_runtime_root=${DSTUDIO_H3_HOME:-${HOME}/.dstudio/minimax-h3}
h3_checkout=${DSTUDIO_H3_CHECKOUT:-${h3_runtime_root}/h3.c}
h3_patch=${h3_test_root}/patch/h3-metal-watchdog/stage-command-submits.patch
h3_test_source=${h3_test_root}/tests/live/h3_sdpa_query_chunk_equivalence.c

for h3_required in git clang; do
    if ! command -v "$h3_required" >/dev/null 2>&1; then
        echo "h3_sdpa_query_chunk_equivalence: NOT RUN ($h3_required missing)" >&2
        exit 1
    fi
done

if [ ! -d "$h3_checkout/.git" ]; then
    echo "h3_sdpa_query_chunk_equivalence: NOT RUN (managed H3 checkout missing)" >&2
    exit 1
fi
if [ ! -f "$h3_patch" ] || [ ! -f "$h3_test_source" ]; then
    echo "h3_sdpa_query_chunk_equivalence: required test input missing" >&2
    exit 1
fi

h3_temp_root=${TMPDIR:-/tmp}
h3_test_tmp=$(mktemp -d "${h3_temp_root%/}/dstudio-h3-sdpa.XXXXXX")
cleanup_h3_equivalence_test() {
    case "$h3_test_tmp" in
        "${h3_temp_root%/}"/dstudio-h3-sdpa.*)
            if [ -d "$h3_test_tmp" ]; then
                rm -rf -- "$h3_test_tmp"
            fi
            ;;
        *)
            echo "refusing unsafe H3 test cleanup: $h3_test_tmp" >&2
            return 1
            ;;
    esac
}
trap cleanup_h3_equivalence_test EXIT HUP INT TERM

git -c advice.detachedHead=false clone --quiet --no-hardlinks \
    "$h3_checkout" "$h3_test_tmp/h3.c"
git -C "$h3_test_tmp/h3.c" apply "$h3_patch"

h3_cflags="-std=c11 -O2 -Wall -Wextra -Wpedantic -Wshadow -Wconversion -Wno-sign-conversion -D_DARWIN_C_SOURCE"
# shellcheck disable=SC2086
clang $h3_cflags -fobjc-arc -I"$h3_test_tmp/h3.c" \
    -c "$h3_test_tmp/h3.c/h3_gpu.m" -o "$h3_test_tmp/h3_gpu.o"
# shellcheck disable=SC2086
clang $h3_cflags -I"$h3_test_tmp/h3.c" \
    -c "$h3_test_source" -o "$h3_test_tmp/equivalence.o"
clang -o "$h3_test_tmp/h3_sdpa_query_chunk_equivalence" \
    "$h3_test_tmp/equivalence.o" "$h3_test_tmp/h3_gpu.o" \
    -framework Foundation -framework Metal \
    -framework MetalPerformanceShaders \
    -framework MetalPerformanceShadersGraph \
    -framework Accelerate -licucore -lm

"$h3_test_tmp/h3_sdpa_query_chunk_equivalence" \
    "$h3_test_tmp/h3.c/h3_shaders.metal"

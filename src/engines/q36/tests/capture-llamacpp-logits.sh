#!/bin/sh
set -e

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
MODEL=${Q36_TEST_MODEL:-"$ROOT/gguf/Qwen3.6-35B-A3B-Q8_0.gguf"}
exec make -C "$ROOT" test-vectors-local REFERENCE_MODEL="$MODEL" "$@"

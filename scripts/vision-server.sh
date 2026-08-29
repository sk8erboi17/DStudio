#!/bin/sh
# Compatibility entry point. DStudio no longer starts a persistent vision
# server: Qwen3.8-27B Q8 runs once under the shared heavyweight-model lock.
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec "$SCRIPT_DIR/vision-qwen38-run.sh" "$@"

#!/bin/sh
# Launch the MiniMax H3 open-weight worker with a Python that is available to
# GUI-launched macOS applications as well as terminal sessions.
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

if command -v python3 >/dev/null 2>&1; then
  PYTHON_BIN=$(command -v python3)
elif [ -x /usr/bin/python3 ]; then
  PYTHON_BIN=/usr/bin/python3
else
  echo "python3 is required for the local MiniMax H3 runtime" >&2
  exit 127
fi

exec "$PYTHON_BIN" "$SCRIPT_DIR/h3-run.py" "$@"

#!/usr/bin/env bash
set -euo pipefail
export PATH="/usr/local/bin:/usr/bin:/bin:/ucrt64/bin:/mingw64/bin:/clang64/bin:$PATH"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DS4_DIR="${1:-$ROOT/../ds4}"

if [ ! -f "$DS4_DIR/Makefile" ]; then
  echo "ds4 checkout not found: $DS4_DIR" >&2
  exit 1
fi

CPU_CFLAGS="-O3 -ffast-math -g -Wall -Wextra -std=gnu99 -D_GNU_SOURCE -DDS4_NO_GPU"
MAKE_BIN="${MAKE:-make}"
if ! command -v "$MAKE_BIN" >/dev/null 2>&1; then
  for candidate in /usr/bin/make /mingw64/bin/mingw32-make /ucrt64/bin/mingw32-make /clang64/bin/mingw32-make; do
    if [ -x "$candidate" ]; then MAKE_BIN="$candidate"; break; fi
  done
fi
if ! command -v "$MAKE_BIN" >/dev/null 2>&1 && [ ! -x "$MAKE_BIN" ]; then
  echo "make not found in PATH=$PATH" >&2
  exit 127
fi

CC_BIN="${CC:-}"
if [ -z "$CC_BIN" ]; then
  for candidate in /usr/bin/gcc /ucrt64/bin/gcc /mingw64/bin/gcc /clang64/bin/gcc; do
    if [ -x "$candidate" ]; then CC_BIN="$candidate"; break; fi
  done
fi
if ! command -v "$CC_BIN" >/dev/null 2>&1 && [ ! -x "$CC_BIN" ]; then
  echo "gcc not found in PATH=$PATH" >&2
  exit 127
fi

echo "windows-cygwin: building ds4 CPU binaries"
"$MAKE_BIN" -C "$DS4_DIR" cpu CC="$CC_BIN" CFLAGS="$CPU_CFLAGS" LDLIBS="-lm -pthread"

echo "windows-cygwin: building DStudio jsonl patch helper"
(
  cd "$ROOT"
  /usr/bin/gcc -O2 -Wall -Wextra -std=gnu11 -D_GNU_SOURCE -o dstudio-jsonl-builder src/dstudio.c
  ./dstudio-jsonl-builder --check-anchors "$DS4_DIR"
  rm -f "$DS4_DIR/ds4-agent-jsonl" "$DS4_DIR/ds4-agent-jsonl.exe" \
        "$DS4_DIR/ds4_agent_jsonl.o" "$DS4_DIR/dstudio_remote_llm.o"
  DS4UI_JSONL_CC="$CC_BIN" \
  DS4UI_JSONL_CFLAGS="$CPU_CFLAGS" \
  DS4UI_JSONL_CORE_OBJS="ds4_cpu.o ds4_distributed.o ds4_ssd.o" \
  DS4UI_JSONL_LDLIBS="-lm -pthread" \
    ./dstudio-jsonl-builder --build-jsonl "$DS4_DIR"
)

echo "windows-cygwin: building ds4-design"
"$MAKE_BIN" -C "$DS4_DIR" -f "$ROOT/extension/design/design.mk" \
  CC="$CC_BIN" \
  DESIGN_SRC="$ROOT/extension/design/ds4_design.c" \
  REMOTE_DIR="$ROOT/extension/remote" \
  CFLAGS="$CPU_CFLAGS" \
  CORE_OBJS="ds4_cpu.o ds4_distributed.o ds4_ssd.o" \
  METAL_LDLIBS="-lm -pthread" \
  ds4-design

for exe in ds4-server ds4-agent ds4-agent-jsonl ds4-design; do
  if [ ! -f "$DS4_DIR/$exe" ] && [ ! -f "$DS4_DIR/$exe.exe" ]; then
    echo "missing expected engine binary: $exe" >&2
    exit 1
  fi
done

echo "windows-cygwin: DS4 CPU staging ready"

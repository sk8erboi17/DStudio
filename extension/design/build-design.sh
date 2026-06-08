#!/usr/bin/env bash
#
# build-design.sh — builds ds4-design in the ds4 repo from the DStudio source.
#
# Simpler than build-jsonl.sh: ds4_design.c is a SELF-CONTAINED file (no
# patch, no backup/restore). The ds4 repo stays pristine: the source lives
# here, only the untracked outputs ds4_design.o and ds4-design land in the
# ds4 repo (like ds4-agent-jsonl).
#
#   build-design.sh [build]   compile if needed (idempotent)
#   build-design.sh status    print binary presence/freshness
set -uo pipefail

EXT="$(cd "$(dirname "$0")" && pwd)"
DS4_DIR="${DS4_DIR:-$(cd "$EXT/../../../ds4" 2>/dev/null && pwd)}"
SRC="$EXT/ds4_design.c"
MK="$EXT/design.mk"
BIN="$DS4_DIR/ds4-design"

die() { echo "build-design: $*" >&2; exit 1; }
[ -f "$SRC" ] || die "source not found: $SRC"
[ -f "$DS4_DIR/Makefile" ] || die "ds4 repo not found: $DS4_DIR"

case "${1:-build}" in
  status)
    if [ ! -f "$BIN" ]; then echo "binary: missing"
    elif [ "$BIN" -nt "$SRC" ] && [ "$BIN" -nt "$MK" ]; then echo "binary: up to date ($BIN)"
    else echo "binary: needs rebuild"
    fi
    exit 0 ;;
  build) ;;
  *) die "unknown command: $1" ;;
esac

# idempotence: skip if the binary is newer than both the source and the mk
if [ -f "$BIN" ] && [ "$BIN" -nt "$SRC" ] && [ "$BIN" -nt "$MK" ]; then
  echo "build-design: ds4-design already up to date, nothing to do"
  exit 0
fi

echo "build-design: compiling ds4-design…"
( cd "$DS4_DIR" && make -f "$MK" DESIGN_SRC="$SRC" ds4-design ) || die "make failed"
[ -f "$BIN" ] || die "build finished without errors but the binary is missing?"
echo "build-design: OK — $BIN ready"

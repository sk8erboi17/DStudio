#!/usr/bin/env bash
#
# build-design.sh — builds ds4-design in the ds4 repo from the DStudio source.
#
# ds4_design.c is a self-contained frontend, but its image-worker handoff uses
# DStudio's versioned DS4 memory-pressure patch. Apply that patch only for the
# fingerprint/build and restore it on every exit when this script applied it.
# The tracked DS4 checkout therefore stays pristine; only build outputs land in
# it (like ds4-agent-jsonl).
#
#   build-design.sh [build]   compile if needed (idempotent)
#   build-design.sh status    print binary presence/freshness
set -uo pipefail

EXT="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$EXT/../.." && pwd)"
if [ -n "${DS4_DIR:-}" ]; then
  DS4_DIR="$(cd "$DS4_DIR" 2>/dev/null && pwd)" || {
    echo "build-design: invalid DS4_DIR: $DS4_DIR" >&2
    exit 1
  }
elif [ -f "$EXT/../../ds4/Makefile" ]; then
  # Source checkouts keep the managed engine inside the DStudio tree.
  DS4_DIR="$(cd "$EXT/../../ds4" && pwd)"
else
  # Installed extension bundles sit beside their managed engine checkout.
  DS4_DIR="$(cd "$EXT/../../../ds4" 2>/dev/null && pwd)"
fi
SRC="$EXT/ds4_design.c"
MK="$EXT/design.mk"
SCRIPT="$EXT/build-design.sh"
REMOTE_DIR="$(cd "$EXT/../remote" && pwd)"
BIN="$DS4_DIR/ds4-design"
STAMP="$DS4_DIR/ds4-design.ver"
PATCHER="$ROOT/scripts/apply-ds4-qwen-hot-memory.sh"
PATCH_FILE="$ROOT/patch/ds4-qwen-hot-memory/hot-memory.patch"
PATCH_APPLIED_BY_US=0
STAMP_TMP=""

die() { echo "build-design: $*" >&2; exit 1; }
[ -f "$SRC" ] || die "source not found: $SRC"
[ -f "$DS4_DIR/Makefile" ] || die "ds4 repo not found: $DS4_DIR"
[ -f "$REMOTE_DIR/dstudio_remote_llm.c" ] || die "remote helper source not found: $REMOTE_DIR"
[ -f "$PATCHER" ] || die "memory-pressure patcher not found: $PATCHER"
[ -f "$PATCH_FILE" ] || die "memory-pressure patch not found: $PATCH_FILE"

cleanup() {
  rc=$?
  trap - EXIT HUP INT TERM
  [ -z "$STAMP_TMP" ] || rm -f "$STAMP_TMP"
  if [ "$PATCH_APPLIED_BY_US" -eq 1 ]; then
    if ! DS4_DIR="$DS4_DIR" sh "$PATCHER" restore >/dev/null; then
      echo "build-design: failed to restore the DS4 memory-pressure patch" >&2
      rc=1
    fi
  fi
  exit "$rc"
}
trap cleanup EXIT HUP INT TERM

if ! grep -q 'ds4_engine_memory_pressure_begin' "$DS4_DIR/ds4.c"; then
  DS4_DIR="$DS4_DIR" sh "$PATCHER" apply >/dev/null ||
    die "memory-pressure patch does not apply to this DS4 checkout"
  PATCH_APPLIED_BY_US=1
fi

# A binary newer than the DStudio extension is still stale when its linked DS4
# checkout advanced (or a tracked runtime patch was applied/restored). Record
# both the immutable commit and the linked tracked diff. ds4_server.c is not a
# Design link input and may independently carry the metrics patch. Managed
# checkouts are Git repositories; fail closed and rebuild otherwise.
ds4_signature() {
  if command -v git >/dev/null 2>&1 &&
     git -C "$DS4_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    ds4_head="$(git -C "$DS4_DIR" rev-parse HEAD)" || return 1
    ds4_diff="$(git -C "$DS4_DIR" diff --binary --no-ext-diff HEAD -- . \
      ':(exclude)ds4_server.c' |
      git hash-object --stdin)" || return 1
    printf '%s:%s' "$ds4_head" "$ds4_diff"
    return 0
  fi
  return 1
}

DS4_SIGNATURE="$(ds4_signature 2>/dev/null || true)"

binary_is_fresh() {
  [ -n "$DS4_SIGNATURE" ] || return 1
  [ -f "$BIN" ] && [ -f "$STAMP" ] || return 1
  [ "$BIN" -nt "$SRC" ] && [ "$BIN" -nt "$MK" ] &&
    [ "$BIN" -nt "$SCRIPT" ] &&
    [ "$BIN" -nt "$PATCH_FILE" ] &&
    [ "$BIN" -nt "$REMOTE_DIR/dstudio_remote_llm.c" ] &&
    [ "$BIN" -nt "$REMOTE_DIR/dstudio_remote_llm.h" ] || return 1
  IFS= read -r stamped_signature < "$STAMP" || return 1
  [ "$stamped_signature" = "$DS4_SIGNATURE" ]
}

case "${1:-build}" in
  status)
    if [ ! -f "$BIN" ]; then echo "binary: missing"
    elif binary_is_fresh; then echo "binary: up to date ($BIN)"
    else echo "binary: needs rebuild"
    fi
    exit 0 ;;
  build) ;;
  *) die "unknown command: $1" ;;
esac

# Idempotence is safe only for the exact DS4 tree recorded by the last build.
if binary_is_fresh; then
  echo "build-design: ds4-design already up to date, nothing to do"
  exit 0
fi

echo "build-design: compiling ds4-design…"
rm -f "$STAMP"
( cd "$DS4_DIR" && make -f "$MK" DESIGN_SRC="$SRC" REMOTE_DIR="$REMOTE_DIR" ds4-design ) || die "make failed"
[ -f "$BIN" ] || die "build finished without errors but the binary is missing?"
DS4_SIGNATURE="$(ds4_signature)" || die "could not fingerprint the built DS4 checkout"
STAMP_TMP="${STAMP}.tmp.$$"
printf '%s\n' "$DS4_SIGNATURE" > "$STAMP_TMP" || die "could not write build stamp"
mv -f "$STAMP_TMP" "$STAMP" || die "could not install build stamp"
STAMP_TMP=""
echo "build-design: OK — $BIN ready"

#!/usr/bin/env bash
# Build in a private snapshot under the host's inherited native build lease.
# Original sources, shared objects and the running executable remain intact.
set -euo pipefail
EXT="$(cd "$(dirname "$0")" && pwd -P)"
ROOT="$(cd "$EXT/../.." && pwd -P)"
die() { echo "build-design: $*" >&2; exit 1; }
DS4_DIR="$(cd "${DS4_DIR:-$ROOT/ds4}" && pwd -P)" || die "invalid engine directory"
ACTION="${1:-build}"
case "$ACTION" in build|status) ;; *) die "expected build or status" ;; esac

# Direct invocations use the app's lease too, not another locking scheme.
if [ -z "${DSTUDIO_DESIGN_LOCK_FD:-}" ]; then
  HOST="${DSTUDIO_BUILD_HOST:-$ROOT/dstudio}"
  [ -x "$HOST" ] || die "build DStudio first, or set DSTUDIO_BUILD_HOST to its current native binary"
  exec "$HOST" --build-design "$DS4_DIR" "$ACTION"
fi
case "$DSTUDIO_DESIGN_LOCK_FD" in *[!0-9]*|'') die "invalid build lease" ;; esac
[ -e "/dev/fd/$DSTUDIO_DESIGN_LOCK_FD" ] || die "missing inherited build lease"
STAGE="${DSTUDIO_DESIGN_STAGE:-}"
case "$STAGE" in "$DS4_DIR"/.ds4ui-design-build-*) ;; *) die "invalid private build directory" ;; esac
[ -d "$STAGE" ] && [ ! -L "$STAGE" ] || die "private build directory was replaced"
# The native parent entered the retained directory before exec. Relative
# scratch I/O remains anchored even if a compiler renames its original path.
[ "$(pwd -P)" = "$STAGE" ] || die "build did not start in its private directory"
STAGE=.
if command -v shasum >/dev/null 2>&1; then DIGEST=(shasum -a 256)
elif command -v sha256sum >/dev/null 2>&1; then DIGEST=(sha256sum)
else die "SHA-256 tool unavailable"; fi

BIN="$DS4_DIR/ds4-design"
STAMP="$DS4_DIR/ds4-design.ver"
mkdir "$STAGE/engine" "$STAGE/support" "$STAGE/support/design" "$STAGE/support/remote"

# Never enumerate weights, caches or build trees. Linked sources/directories
# are rejected; the source snapshot has explicit file, byte and depth bounds.
engine_files() (
  cd "$1"
  find . -mindepth 1 -maxdepth 1 \( -type f -o -type l \) \
    \( -name '*.c' -o -name '*.h' -o -name '*.m' -o -name '*.mm' -o -name '*.inc' \
       -o -name '*.cu' -o -name '*.cuh' -o -name '*.mk' -o -name Makefile -o -name .dstudio-source.json \) -print
  for dir in metal cuda rocm vulkan third_party; do
    [ ! -L "$dir" ] || die "linked source directory: $dir"
    [ -d "$dir" ] || continue
    find "$dir" -maxdepth 16 -type l -print
    find "$dir" -maxdepth 16 -type f \
      \( -name '*.c' -o -name '*.h' -o -name '*.m' -o -name '*.mm' -o -name '*.inc' \
         -o -name '*.metal' -o -name '*.cu' -o -name '*.cuh' -o -name '*.mk' \
         -o -name '*.comp' -o -name '*.glsl' -o -name Makefile \) -print
  done
)

snapshot_sources() {
  local from="$1" destination="$2" file bytes count=0 total=0
  local -a files=()
  engine_files "$from" | LC_ALL=C sort > "$STAGE/source-list.next" || return 1
  while IFS= read -r file; do
    [ -f "$from/$file" ] && [ ! -L "$from/$file" ] || die "invalid or linked source: $file"
    bytes=$(wc -c < "$from/$file") || return 1
    count=$((count + 1)); total=$((total + bytes))
    [ "$count" -le 4096 ] && [ "$bytes" -le 33554432 ] && [ "$total" -le 134217728 ] || die "source snapshot exceeds its file/byte budget"
    if [ -n "$destination" ]; then
      mkdir -p "$destination/$(dirname "$file")" || return 1
      cp "$from/$file" "$destination/$file" || return 1
    fi
    files+=("$file")
  done < "$STAGE/source-list.next"
  [ "$count" -gt 0 ] || die "empty source snapshot"
  (cd "$from" && "${DIGEST[@]}" "${files[@]}") | "${DIGEST[@]}" | awk '{print $1}'
}

support_files=(extension/design/build-design.sh extension/design/design.mk
  extension/design/ds4_design.c extension/design/design_system_catalog.h
  extension/remote/dstudio_remote_llm.c extension/remote/dstudio_remote_llm.h
  extension/remote/dstudio_wire_string.h
  patch/ds4-media-memory/residency-lease.patch patch/ds4-media-memory/legacy-labels.patch)
support_signature() (
  for file in "${support_files[@]}"; do
    from="$ROOT/$file"
    if [ -n "${1:-}" ]; then
      case "$file" in
        extension/design/*) from="$1/design/${file##*/}" ;;
        extension/remote/*) from="$1/remote/${file##*/}" ;;
        patch/*) from="$1/${file##*/}" ;;
      esac
    fi
    [ -f "$from" ] && [ ! -L "$from" ] || die "invalid support input: $file"
    [ "$(wc -c < "$from")" -le 33554432 ] || die "oversized support input: $file"
    hash=$("${DIGEST[@]}" "$from" | awk '{print $1}') || return 1
    printf '%s %s\n' "$hash" "$file"
  done
)
support_signature > "$STAGE/support-inputs"
SUPPORT_SIGNATURE=$("${DIGEST[@]}" "$STAGE/support-inputs" | awk '{print $1}')
for file in "${support_files[@]}"; do
  case "$file" in
    extension/design/*) cp "$ROOT/$file" "$STAGE/support/design/" ;;
    extension/remote/*) cp "$ROOT/$file" "$STAGE/support/remote/" ;;
    patch/*) cp "$ROOT/$file" "$STAGE/support/" ;;
  esac
done
[ "$(support_signature "$STAGE/support" | "${DIGEST[@]}" | awk '{print $1}')" = "$SUPPORT_SIGNATURE" ] || die "support changed during snapshot"
SOURCE_SIGNATURE=$(snapshot_sources "$DS4_DIR" "$STAGE/engine")
[ "$(snapshot_sources "$STAGE/engine" '')" = "$SOURCE_SIGNATURE" ] || die "source changed during snapshot"
MK=../support/design/design.mk

# Make resolves the actual selected CPU/Metal/CUDA/ROCm flags and compiler.
build_config() (
  cd "$STAGE/engine"
  make --no-print-directory -s -f "$MK" dstudio-design-config
)
build_config > "$STAGE/compiler-config"
CONFIG_SIGNATURE=$("${DIGEST[@]}" "$STAGE/compiler-config" | awk '{print $1}')
engine_identity() {
  local top
  top=$(git -C "$DS4_DIR" rev-parse --show-toplevel 2>/dev/null || true)
  if [ -n "$top" ] && [ "$(cd "$top" && pwd -P)" = "$DS4_DIR" ]; then
    git -C "$DS4_DIR" rev-parse HEAD
  else printf 'archive\n'; fi
}
SOURCE_ID=$(engine_identity)
SIGNATURE="design-v2:$SOURCE_ID:$SOURCE_SIGNATURE:$SUPPORT_SIGNATURE:$CONFIG_SIGNATURE"
binary_is_fresh() {
  # A quoted/custom wrapper that cannot be resolved is still buildable, but
  # cannot borrow a cached receipt from a compiler whose bytes we cannot name.
  ! grep -q '^dstudio-tool-unverified:' "$STAGE/compiler-config" || return 1
  [ -f "$BIN" ] && [ ! -L "$BIN" ] && [ -s "$BIN" ] && [ -x "$BIN" ] &&
    [ -f "$STAMP" ] && [ ! -L "$STAMP" ] || return 1
  local expected actual
  expected=$(printf '%s\n' "$SIGNATURE"; "${DIGEST[@]}" "$BIN" | awk '{print $1}')
  actual=$(<"$STAMP")
  [ "$actual" = "$expected" ]
}
if [ "$ACTION" = status ]; then
  if [ ! -e "$BIN" ]; then echo "binary: missing"
  elif binary_is_fresh; then echo "binary: up to date ($BIN)"
  else echo "binary: needs rebuild"; fi
  exit 0
fi
if binary_is_fresh; then
  echo "build-design: ds4-design already up to date, nothing to do"
  exit 0
fi

# Validate the entire patch, not a marker. All applications remain private.
export GIT_CEILING_DIRECTORIES="$(pwd -P)"
PATCH=../support/residency-lease.patch
if git -C "$STAGE/engine" apply --check "$PATCH" 2>/dev/null; then
  git -C "$STAGE/engine" apply "$PATCH"
elif ! git -C "$STAGE/engine" apply --reverse --check "$PATCH" 2>/dev/null; then
  # A recorded old installation has four obsolete log labels and one comment.
  # Normalize only this complete known delta, only inside the private copy,
  # then still require the entire residency implementation to reverse exactly.
  LEGACY=../support/legacy-labels.patch
  git -C "$STAGE/engine" apply --check "$LEGACY" 2>/dev/null &&
    git -C "$STAGE/engine" apply "$LEGACY" &&
    git -C "$STAGE/engine" apply --reverse --check "$PATCH" 2>/dev/null ||
    die "memory-pressure patch is partial, drifted or incompatible; existing runtime preserved"
fi

echo "build-design: compiling in a private source snapshot…"
(cd "$STAGE/engine"; make --no-print-directory -f "$MK" \
  DESIGN_SRC=../support/design/ds4_design.c \
  REMOTE_DIR=../support/remote ds4-design) || die "make failed; existing runtime preserved"
PREPARED="$STAGE/engine/ds4-design"
[ -f "$PREPARED" ] && [ ! -L "$PREPARED" ] && [ -s "$PREPARED" ] && [ -x "$PREPARED" ] || die "build did not produce an executable regular file"
[ "$(snapshot_sources "$DS4_DIR" '')" = "$SOURCE_SIGNATURE" ] || die "engine sources changed during build; prepared binary discarded"
[ "$(engine_identity)" = "$SOURCE_ID" ] || die "engine revision changed during build; prepared binary discarded"
[ "$(support_signature | "${DIGEST[@]}" | awk '{print $1}')" = "$SUPPORT_SIGNATURE" ] || die "DStudio support changed during build; prepared binary discarded"
[ "$(build_config | "${DIGEST[@]}" | awk '{print $1}')" = "$CONFIG_SIGNATURE" ] || die "compiler configuration changed during build; prepared binary discarded"
for file in "$BIN" "$STAMP"; do
  [ ! -e "$file" ] || { [ -f "$file" ] && [ ! -L "$file" ]; } || die "invalid publication target: $file"
  [ ! -L "$file" ] || die "linked publication target: $file"
done
printf '%s\n' "$SIGNATURE" > "$STAGE/prepared.ver"
"${DIGEST[@]}" "$PREPARED" | awk '{print $1}' >> "$STAGE/prepared.ver"
# Only the owning native parent publishes. If it died during compilation this
# candidate stays private, even if make/bash survived and finished successfully.
echo "build-design: prepared — awaiting native publication"

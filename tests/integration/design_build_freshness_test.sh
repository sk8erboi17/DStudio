#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "$0")/../.." && pwd)
builder="$root/extension/design/build-design.sh"
patcher="$root/scripts/apply-ds4-media-memory.sh"
temporary=$(mktemp -d "${TMPDIR:-/tmp}/dstudio-design-build.XXXXXX")
fixture="$temporary/ds4"
trap 'rm -rf "$temporary"' EXIT HUP INT TERM

git clone -q --shared "$root/ds4" "$fixture"
git -C "$fixture" config user.email test@dstudio.invalid
git -C "$fixture" config user.name DStudio-Test

signature() {
  local head diff already_applied=0
  if grep -q 'ds4_engine_memory_pressure_begin' "$fixture/ds4.c"; then
    already_applied=1
  else
    DS4_DIR="$fixture" sh "$patcher" apply >/dev/null
  fi
  head=$(git -C "$fixture" rev-parse HEAD)
  diff=$(git -C "$fixture" diff --binary --no-ext-diff HEAD -- . \
    ':(exclude)ds4_server.c' | git hash-object --stdin)
  if [[ "$already_applied" -eq 0 ]]; then
    DS4_DIR="$fixture" sh "$patcher" restore >/dev/null
  fi
  printf '%s:%s' "$head" "$diff"
}

mark_fresh() {
  printf '%s\n' "$(signature)" > "$fixture/ds4-design.ver"
  : > "$fixture/ds4-design"
  touch -t 203001010000 "$fixture/ds4-design"
}

expect_status() {
  local wanted=$1 output
  output=$(DS4_DIR="$fixture" "$builder" status)
  if [[ "$output" != *"$wanted"* ]]; then
    printf 'expected status containing %q, got: %s\n' "$wanted" "$output" >&2
    exit 1
  fi
}

expect_clean() {
  if ! git -C "$fixture" diff --quiet --exit-code; then
    git -C "$fixture" diff --stat >&2
    printf 'build status left the managed DS4 checkout dirty\n' >&2
    exit 1
  fi
}

mark_fresh
expect_status 'up to date'
expect_clean

printf '\nDesign build freshness fixture.\n' >> "$fixture/README.md"
git -C "$fixture" add README.md
git -C "$fixture" commit -q -m upstream-change
expect_status 'needs rebuild'
expect_clean

mark_fresh
expect_status 'up to date'
expect_clean

printf '\nDirty tracked fixture.\n' >> "$fixture/README.md"
expect_status 'needs rebuild'

git -C "$fixture" checkout -q -- README.md
mark_fresh
rm -f "$fixture/ds4-design.ver"
expect_status 'needs rebuild'
expect_clean

# A caller that already owns the runtime patch also owns its restoration.
DS4_DIR="$fixture" sh "$patcher" apply >/dev/null
mark_fresh
expect_status 'up to date'
grep -q 'ds4_engine_memory_pressure_begin' "$fixture/ds4.c"
DS4_DIR="$fixture" sh "$patcher" restore >/dev/null
expect_clean

printf 'design_build_freshness_test: ok\n'

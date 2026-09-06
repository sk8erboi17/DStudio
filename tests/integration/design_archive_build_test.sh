#!/usr/bin/env bash
# Real archive compilation and executable startup. No model or network.
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
builder="$root/extension/design/build-design.sh"
temporary=$(mktemp -d "${TMPDIR:-/tmp}/dstudio-design-archive.XXXXXX")
fixture="$temporary/engine"
trap 'rm -rf "$temporary"' EXIT HUP INT TERM
mkdir "$fixture"
git -C "$root/ds4" archive HEAD | tar -xf - -C "$fixture"

build() {
  if ! DS4_DIR="$fixture" "$builder" build >"$temporary/build.log" 2>&1; then
    cat "$temporary/build.log" >&2
    exit 1
  fi
  "$fixture/ds4-design" --help >"$temporary/help.log" 2>&1
}
status_is() {
  local output
  output=$(DS4_DIR="$fixture" "$builder" status)
  [[ "$output" == *"$1"* ]] || { printf 'unexpected status: %s\n' "$output" >&2; exit 1; }
}

# This source tree has no Git metadata anywhere above it.
build
initial=$(<"$fixture/ds4-design.ver")
[[ "$initial" == archive-sha256:* ]]
status_is 'up to date'

# A surrounding project must not become the engine identity. Its tracked diff
# does not include the untracked engine, just like a managed DStudio install.
git init -q "$temporary"
git -C "$temporary" config user.email test@dstudio.invalid
git -C "$temporary" config user.name DStudio-Test
printf 'Parent project, not the engine.\n' >"$temporary/README"
git -C "$temporary" add README
git -C "$temporary" commit -q -m parent-fixture
status_is 'up to date'

printf '\n/* Archive build regression: changed linked engine source. */\n' >>"$fixture/ds4.c"
touch -t 203001010000 "$fixture/ds4-design"
status_is 'needs rebuild'
build
updated=$(<"$fixture/ds4-design.ver")
[[ "$updated" == archive-sha256:* && "$updated" != "$initial" ]]
status_is 'up to date'
git -C "$temporary" diff --quiet --exit-code
printf 'design_archive_build_test: ok (real build, startup, ancestor Git isolation, source invalidation)\n'

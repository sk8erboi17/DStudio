#!/usr/bin/env bash
# Kept as the existing public entry point. Assertions execute the production
# builder and real files/processes; compiler responses are explicitly simulated.
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
cd "$root"
make tests/.build/agent-build-probe
exec node tests/integration/design_build_test.mjs tests/.build/agent-build-probe

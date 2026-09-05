#!/bin/sh
# A subprocess probe, not an inference engine: expose the actual launcher argv/env.
printf 'ARG:%s\n' "$@"
printf 'RESIDENCY:%s\n' "${DS4_METAL_NO_RESIDENCY-unset}"
printf 'SKIP:%s\n' "${DS4_Q35_SKIP-unset}"
printf 'PREFILL:%s\n' "${DS4_METAL_PREFILL_CHUNK-unset}"

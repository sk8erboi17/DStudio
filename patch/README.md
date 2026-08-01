# DStudio upstream patches

This directory contains the patches that DStudio applies to the upstream DS4 checkout when building its managed runtimes.

Derived helper binaries use a `manifest` with ordered `NNN.find` / `NNN.replace` anchors. Small engine/server extensions use unified patches through dedicated scripts. Both paths fail explicitly when upstream anchors drift.

`ds4-server-metrics/usage-metrics.patch` exposes ds4's own measured decode rate in the OpenAI-compatible usage object. The UI never estimates token speed from character counts.

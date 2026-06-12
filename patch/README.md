# DStudio upstream patches

This directory contains the anchored patches that DStudio applies to the upstream DS4 checkout when building derived helper binaries.

Each patch set has a `manifest` file and ordered `NNN.find` / `NNN.replace` files. The launcher applies each `find` exactly once and fails with an explicit patch path if an anchor is missing or ambiguous.

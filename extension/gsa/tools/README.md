# GSA Managed Tools

This directory is for optional local GSA tools installed by DStudio.

- `bin/` contains downloaded tool binaries and is ignored by git.
- `nuclei-templates/` contains the managed ProjectDiscovery nuclei template
  checkout/update and is ignored by git.
- `trivy-cache/` and `grype/` contain managed vulnerability database/cache data
  when those system tools are available and are ignored by git.
- `go/` and `cargo/` are temporary managed build caches; Go's download cache is
  cleaned after installation. Python/pipx environments use the space-safe
  per-user path `~/.dstudio/gsa/`.
- `install-gsa-tools.sh`, `install-gsa-tools.ps1` and their log are generated
  locally and ignored by git. DStudio executes the platform script as a
  supervised background task and refreshes the catalog when it exits.
- GSA must still treat these tools as advisory evidence; source/artifact validation remains required.

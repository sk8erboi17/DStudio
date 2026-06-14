# GSA Managed Tools

This directory is for optional local GSA tools installed by DStudio.

- `bin/` contains downloaded tool binaries and is ignored by git.
- `go/`, `cargo/`, `pipx/`, and `python/` are local dependency/runtime caches
  used by generated installers and are ignored by git.
- `install-gsa-tools.sh` and `install-gsa-tools.ps1` are generated locally and ignored by git.
- GSA must still treat these tools as advisory evidence; source/artifact validation remains required.

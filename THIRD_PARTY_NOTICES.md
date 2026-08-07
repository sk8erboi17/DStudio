# Third-Party Notices

This repository includes design-system content adapted from Open Design and
integrations that download optional third-party runtimes or model weights on
demand. Downloaded runtimes and weights are not committed to this repository.

## qwen-image-mps (optional runtime)

DStudio can install qwen-image-mps on demand for local text-to-image generation.
The project and its Python dependencies are not vendored into this repository.

- Source: https://github.com/ivanfioravanti/qwen-image-mps
- Pinned commit: `fe70bd7b245307143d95cde5bc62c9aeff401e69`
- License: MIT
- Install location: `~/.dstudio/qwen-image/venv`

Model weights are downloaded separately by the upstream Hugging Face pipeline
and remain subject to their respective model licenses and terms.

## Open Design

- Source: https://github.com/nexu-io/open-design
- Copyright: 2026 Open Design contributors
- Imported from commit: `8123cc69808137ff765aad782e5eabf750249ca5`
- License: Apache License 2.0
- Local license copy: `third_party/open-design/LICENSE`
- Imported locations:
  - `extension/design-systems/*` entries with `ds4_upstream: open-design/...`

The imported Markdown pack files were modified for DStudio/DS4 by adding
`ds4_*` frontmatter metadata and local-first blueprint classification where
provider-backed workflows cannot run directly inside DS4. Modified imported
files carry a `ds4_modified_notice` frontmatter field.

## Optional GSA Recon Tools

DStudio can install command-line tools and ProjectDiscovery nuclei templates
into the user's local app-data directory for authorized GSA runs. The binaries,
package environments, vulnerability databases and template checkout are not
vendored or committed in this repository.

The authoritative current inventory and install methods are maintained in
[`extension/gsa/tools/catalog.json`](extension/gsa/tools/catalog.json); the
managed-directory layout is documented in
[`extension/gsa/tools/README.md`](extension/gsa/tools/README.md). Each optional
download remains subject to its own upstream license and terms.

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

## MiniMax H3 and ComfyUI (optional runtime)

DStudio can download MiniMax H3 weights and run them locally through ComfyUI on
Apple Silicon. Neither ComfyUI nor the model weights are vendored into this
repository.

- ComfyUI source: https://github.com/Comfy-Org/ComfyUI
- Pinned ComfyUI commit: `2f40b7131cb26c7255d48f6f6d821bd5fd56bedf`
- ComfyUI license: GPL-3.0
- Apple-Silicon compatibility layer: https://github.com/pawel-mazurkiewicz/ComfyUI-AppleSilicon-FP8
- Pinned compatibility-layer commit/tag: `3cc65dd8d8b98f4ab69cf48b8912a831dc8ccff3` (`v1.3.0`)
- Compatibility-layer license: MIT
- Original model: https://huggingface.co/MiniMaxAI/MiniMax-H3
- Pinned ComfyUI model repack: https://huggingface.co/Comfy-Org/MiniMax-H3/tree/eb8a16107c595128b3a578f82d2ce2f75920c355
- Model terms: [MiniMax H3 Community License Agreement](https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/LICENSE)
- Install location: `~/.dstudio/minimax-h3`

The managed compatibility layer installs its declared optional-runtime Python
dependencies (including `mtlflashattn` and `ninja`) into H3's isolated virtual
environment. These packages and the compatibility-layer checkout are downloaded
on demand and are not committed to or redistributed by this repository.

The optional community text encoder is a third-party derivative, not an
official Comfy-Org weight:

- Source: https://huggingface.co/linjian257/qwen3vl_32b_minimax_h3_int8_convrot_uncensored-by-linjian257
- Pinned revision: `19a1c202af96b9c3d51dd346ecd0168c2720b0d3`
- Declared terms: [pinned model-card license section](https://huggingface.co/linjian257/qwen3vl_32b_minimax_h3_int8_convrot_uncensored-by-linjian257/blob/19a1c202af96b9c3d51dd346ecd0168c2720b0d3/README.md#license)

The pinned community repository declares personal/non-commercial-only terms in
its metadata and model card, but the referenced standalone `LICENSE.md` is not
present in that revision. DStudio therefore labels this encoder unverified and
non-commercial rather than representing those terms as a verified license file.

Users must review the current upstream terms and confirm that their territory
and intended use are authorized before DStudio downloads or runs H3. DStudio
does not redistribute the downloaded weights or grant model-use rights.

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

# Third-Party Notices

DStudio's locally authored design systems — Folio, Signal, Forma, Grove, Pulse,
Market, Commons, Atlas and Canvas —
are included in [`extension/design-systems/`](extension/design-systems/) under the
[repository license](LICENSE). No third-party design catalog is bundled or
downloaded. DStudio bundles the pinned ds4 and llama.cpp source snapshots below under their
original licenses. Optional media/tool runtimes and model weights are still downloaded
on demand and are not committed. See [bundled source provenance and limits](docs/BUNDLED_ENGINES.md).

## ds4 (managed local inference engine)

- Source: https://github.com/antirez/ds4
- Pinned main commit: `0aaea5a238fb41a35106a551e73c8409dfb751ac`
- Source license: [MIT](https://github.com/antirez/ds4/blob/0aaea5a238fb41a35106a551e73c8409dfb751ac/LICENSE)
- Copyright: 2026 The ds4.c authors; 2023–2026 The ggml authors.
- Distributed sources: [`src/engines/ds4/`](src/engines/ds4/), retaining the
  [complete MIT notice](src/engines/ds4/LICENSE), including DeepSeek attribution.
- Laguna source: [`src/engines/ds4-laguna-s21/`](src/engines/ds4-laguna-s21/),
  commit `448d5695d1c86401a4e9447c440feb983b73e6de`, with its
  [MIT notice](src/engines/ds4-laguna-s21/LICENSE).
- Bundled Iris decoder: Copyright 2026 Salvatore Sanfilippo; its
  [MIT license](src/engines/ds4/third_party/iris/LICENSE) is retained in every
  snapshot that contains Iris.
- Upstream vision test images include synthetic fixtures and NASA's public-domain
  Apollo 17 image AS17-148-22727. The original
  [fixture attribution](src/engines/ds4/tests/vision-fixtures/glm53/README.md)
  is retained, including its source link.
- DStudio adaptations: [`patch/`](patch/README.md).

## llama.cpp (bundled engine for the local Qwen models)

- Source: https://github.com/ggml-org/llama.cpp, tag `b11371`
- Pinned commit: `99b95488cac0f00ce3f05af113a8c1e287753f87`
- Source license: [MIT](src/engines/llama.cpp/LICENSE), Copyright 2023–2026 The ggml authors.
- Distributed sources: [`src/engines/llama.cpp/`](src/engines/llama.cpp/). DStudio builds only
  `llama-server` from them ([installer](scripts/install-llama.py)); the snapshot is unmodified.
- Vendored components retained with their notices inside the snapshot:
  [cpp-httplib](src/engines/llama.cpp/vendor/cpp-httplib/LICENSE) (MIT),
  [nlohmann/json](src/engines/llama.cpp/licenses/LICENSE-jsonhpp) (MIT),
  [xxHash](src/engines/llama.cpp/vendor/hash/xxhash/LICENSE) (BSD-2-Clause),
  [rotate-bits](src/engines/llama.cpp/vendor/hash/rotate-bits/LICENSE.md) (MIT),
  [stb_image](src/engines/llama.cpp/vendor/stb/stb_image.h) (public domain or MIT),
  [miniaudio](src/engines/llama.cpp/vendor/miniaudio/miniaudio.h) (public domain or MIT-0) and
  [subprocess.h](src/engines/llama.cpp/vendor/sheredom/subprocess.h) (Unlicense), as stated in their headers.
- Omitted from the snapshot (hashes in the [manifest](src/engines/manifest.json)): test vocabulary
  GGUFs, generated per-backend operator tables (`docs/ops/*.csv`) and published benchmark runs.

Managed installs retain the upstream license. Model weights have their own
terms; the engine's license does not replace them. Main now includes
Qwen3.8-Flash-Next. Laguna retains a separate engine pin; Qwen3.6 MoE and Qwen27B run on
the bundled llama.cpp below.

DeepSeek V4.1 GGUFs are downloaded separately from
[`antirez/deepseek-v4.1-flash-gguf`](https://huggingface.co/antirez/deepseek-v4.1-flash-gguf/tree/dd8a266f7145edc19e2334b46e19b6821f221dc7),
revision `dd8a266f7145edc19e2334b46e19b6821f221dc7`; that pinned model card
declares MIT. The upstream engine retains the provenance of the DeepSeek
tokenizer/Engram metadata and its source notices. Engram tables and any matching
vision weights are model components, not DStudio-authored assets.

### Retired Qwen side engines

Until October 3, 2026 DStudio also distributed the
[`vagrillo/ds4`](https://github.com/vagrillo/ds4/tree/73434c4bb9d8bb18425a2577edada69d25d44c47)
Qwen3.6 fork (`73434c4`, MIT, ds4.c and ggml authors) and the
[`Ninnix/q36`](https://github.com/Ninnix/q36/tree/1305843c735380f912619548b121cba8601f2f85)
Qwen27B engine (`1305843`, MIT, Copyright 2026 Nicolo' D'Evangelista, the ds4.c
authors and the ggml authors), with DStudio patches for both and a reviewed
[`signalnine/q27`](https://github.com/signalnine/q27/tree/8cd708389f8b5a2c5a7c481237b00c8d7f570e7f)
Metal adaptation (MIT, Copyright 2026 Gabe Ortiz). None of them is distributed
any more; their sources, patches and notices remain in Git history. The Qwen3.6
tool-parser adaptation in the retired `qwen35` Agent patch came from the
MIT-licensed `ivanfioravanti/ds4-metal` source below.

### Qwen3.8-Flash-Next in main and historical fork attribution

- Source: [`ivanfioravanti/ds4-metal`](https://github.com/ivanfioravanti/ds4-metal/tree/ff4f0ff4fdff70d6b7c3941ef437b91dde960e14).
- Historical separate-engine source: `ff4f0ff4fdff70d6b7c3941ef437b91dde960e14`,
  retained in Git history, not distributed as an installable source snapshot.
  Five exact compressed files from this and two earlier revisions are retained
  solely as [historical patch regression inputs](tests/fixtures/retired-qwen-next/),
  with [per-file provenance](tests/fixtures/retired-qwen-next/provenance.json) and
  the upstream [MIT notice](tests/fixtures/retired-qwen-next/LICENSE).
- Active source: antirez/ds4 main at `0aaea5a238fb41a35106a551e73c8409dfb751ac`,
  which includes the Qwen merge. The original contributors' attribution remains.
- Source license: MIT, retaining upstream ds4.c and ggml notices in
  [the active bundled engine](src/engines/ds4/LICENSE). Historical patches and
  the retired Qwen3.6 tool-parser adaptation retain their upstream attribution.
- The older metadata-only PLE prefetch correction remains as a historical
  [regression patch](patch/ds4-qwen38-inspect/README.md), not a main install step.
- The structured Agent/Cowork adaptation is an explicit
  [patch](patch/ds4-agent-jsonl/README.md), applied to private build sources.
- Main already performs correct native snapshot-allocation cleanup; the older
  [correction](patch/ds4-qwen38-snapshot/README.md) is retained for historical tests.
- Current single-file Q2/Q4 weights, including original BF16 n-grams, come from
  [`antirez/qwen3.8-flash-next-gguf`](https://huggingface.co/antirez/qwen3.8-flash-next-gguf/tree/d600fe1a43d2e1cdcadb85144ce3142f66f9eefe),
  revision `d600fe1a43d2e1cdcadb85144ce3142f66f9eefe`. They retain their own model
  terms and provenance; DStudio's or the engine's license does not replace them.
- [Migration, exact hashes and compatibility limits](docs/QWEN_NEXT_MAIN_MIGRATION.md).

### Qwen3.8-27B weights

- The Q6_K_XL language-model candidate and tested F16 vision component come from
  [`unsloth/Qwen3.8-27B-GGUF`](https://huggingface.co/unsloth/Qwen3.8-27B-GGUF/blob/4ca720788d1e01f1bff70c033e0d0028fd02e502/README.md),
  revision `4ca720788d1e01f1bff70c033e0d0028fd02e502`, whose model card
  declares Apache-2.0. Both are downloaded separately, not committed; exact
  filenames, sizes and hashes are pinned in `scripts/download-qwen27.py`.
  An encoder differential test is not full language-model qualification.

## MLX runtime (bundled wheels for Qwen3.6 on Apple Silicon)

- **MLX** https://github.com/ml-explore/mlx v0.32.3 (`64ea011`) and **MLX LM**
  https://github.com/ml-explore/mlx-lm v0.32.0 (`a9bd8af`): MIT, Copyright © 2023 Apple Inc.
  The `mlx-metal` wheel also contains Apple's metal-cpp headers (Apache-2.0).
- DStudio ships the unmodified PyPI wheels for macOS 26 arm64 and CPython 3.12–3.14 in
  [`src/engines/mlx/wheels/`](src/engines/mlx/wheels/), with their SHA-256 and declared license in
  [`src/engines/mlx/manifest.json`](src/engines/mlx/manifest.json). Each wheel keeps its own license
  file in its `.dist-info`. [`scripts/install-mlx.py`](scripts/install-mlx.py) installs them offline
  into a private virtual environment and applies
  [`patch/mlx-lm-single-model`](patch/mlx-lm-single-model/README.md),
  [`patch/mlx-lm-reasoning-content`](patch/mlx-lm-reasoning-content/README.md) and
  [`patch/mlx-lm-tool-streaming`](patch/mlx-lm-tool-streaming/README.md) to the installed
  MLX LM server.
- The 32 runtime dependencies keep their own licenses: Apache-2.0 (hf-xet, huggingface_hub,
  safetensors, sentencepiece, tokenizers, transformers); Apache-2.0 or BSD-2-Clause (packaging);
  Apache-2.0 and CNRI-Python (regex); BSD-2-Clause (Pygments); BSD-3-Clause (click, fsspec,
  httpcore, httpx, idna, Jinja2, MarkupSafe, protobuf); BSD-3-Clause, 0BSD, MIT, Zlib and CC0-1.0
  (numpy); ISC (shellingham); MIT (annotated-doc, anyio, filelock, h11, markdown-it-py, mdurl,
  PyYAML, rich, typer); MPL-2.0 (certifi); MPL-2.0 and MIT (tqdm); PSF-2.0 (typing_extensions).
  The MPL-2.0 packages are redistributed unmodified; their source is available from PyPI.

### Qwen3.6-35B-A3B MLX weights

- [`mlx-community/Qwen3.6-35B-A3B-mxfp8`](https://huggingface.co/mlx-community/Qwen3.6-35B-A3B-mxfp8/tree/5c216c8705fed28a7a16fc92555befd507628709),
  revision `5c216c8705fed28a7a16fc92555befd507628709`, Apache-2.0 per its model card. Downloaded
  separately, not committed; the 20 files, sizes and SHA-256 are pinned in
  [`scripts/download-mlx-qwen36.py`](scripts/download-mlx-qwen36.py).

## pi, pi-ds4 and OpenCode (optional Agent harnesses)

- **pi**: https://github.com/earendil-works/pi at `a276dabe57911253350bffb93cb7d7aff6a73261`,
  [MIT](src/harness/pi/LICENSE), Copyright 2025 Mario Zechner. Snapshot in
  [`src/harness/pi/`](src/harness/pi/), unmodified; six prebuilt native addons (`*.node`) are
  omitted and listed with their hashes in the [harness manifest](src/harness/manifest.json).
- **pi-ds4**: https://github.com/mitsuhiko/pi-ds4 at `db8806cd52757fbaf957fe56b54700a1094a30b8`,
  [MIT](src/harness/pi-ds4/LICENSE), Copyright 2026 Armin Ronacher. Snapshot in
  [`src/harness/pi-ds4/`](src/harness/pi-ds4/); DStudio applies
  [`patch/harness-pi-ds4/external-server.patch`](patch/harness-pi-ds4/README.md) at installation.
- **OpenCode**: https://github.com/anomalyco/opencode at `907b3bc518fa48e90e8ec24dd327d13eee71c36c`,
  [MIT](src/harness/opencode/LICENSE), Copyright 2025 opencode. Snapshot in
  [`src/harness/opencode/`](src/harness/opencode/); 60 symbolic links, 9 marketing/help videos and
  15 generated demo outputs are omitted and listed in the manifest. DStudio applies
  [`patch/harness-opencode/directory-confinement.patch`](patch/harness-opencode/README.md).
- Their JavaScript dependencies (npm packages and, for OpenCode, the Bun build tool `bun@1.3.14`)
  are **not** distributed with DStudio. [`scripts/install-harness.py`](scripts/install-harness.py)
  downloads them at the user's explicit request, pinned by each project's lockfile, into the
  user's managed installation; each package keeps its own license there. The built OpenCode
  executable embeds those dependencies under their licenses.

## Ideogram 4 FP8 (optional image-generation runtime)

DStudio downloads Ideogram 4 and its runtime on demand; neither code nor model
weights are vendored in this repository.

- Official source: https://github.com/ideogram-oss/ideogram4
- Pinned source commit: `990fe1c4e950bb9e9dc90e01c0ad98ba434f83c2`
- Source license: Apache-2.0
- FP8 model repack: https://huggingface.co/Comfy-Org/Ideogram-4
- Pinned model revision: `bbee2ab2b14b2b5223448d12d6e31e5f9cec0546`
- Model terms: [Ideogram 4 Non-Commercial License](https://github.com/ideogram-oss/ideogram4/blob/main/model_licenses/LICENSE-IDEOGRAM-4-NON-COMMERCIAL)
- ComfyUI source/commit: https://github.com/comfyanonymous/ComfyUI/tree/b78cec879b9460d5cb25228a83a942fb78d2cd24
- Ideogram node source/commit: https://github.com/ideogram-oss/ComfyUI-Ideogram4/tree/c05545d71e61b7ce47534a972eaeefd958a3719f
- Apple-Silicon FP8 compatibility source/commit: https://github.com/pawel-mazurkiewicz/ComfyUI-AppleSilicon-FP8/tree/911294ca35093eef56f7f2695414ff8810e88e50
- Install location: `~/.dstudio/ideogram4`

The compatibility node preserves the downloaded FP8 values while using a
Metal-supported compute representation; it does not replace the model with a
lower-quality checkpoint. Users are responsible for complying with the model's
non-commercial terms.

## HunyuanImage-3.0-Instruct (optional image-editing runtime)

- Official base model: https://huggingface.co/tencent/HunyuanImage-3.0-Instruct
- Pinned base revision: `2ec2c78bee7d4b94157341fba86c4c2c7b1858b2`
- Full-Instruct NF4 v2 quantization: https://huggingface.co/EricRollei/HunyuanImage-3.0-Instruct-NF4-v2
- Pinned quantized revision: `98fda5c508c05f5407f036bca413149ca92c143b`
- Model terms: [Tencent Hunyuan Community License](https://huggingface.co/tencent/HunyuanImage-3.0/blob/main/LICENSE.txt)
- Install location: `~/.dstudio/hunyuan-image`

The NF4 v2 repository declares the official full Instruct base and keeps its
VAE, attention projections, embeddings and other quality-critical layers in
BF16. DStudio uses it because the official BF16 and INT8 checkpoints cannot fit
the 96 GB unified-memory reference machine together with inference activations;
no distilled checkpoint is substituted. Runtime setup composes the eager
DeepSeek MoE block from the pinned official Tencent source revision and applies
the later upstream Transformers MPS allocator-warmup skip to the compatible
pinned loader. DStudio does not substitute a custom numerical attention or MoE
implementation.

## MiniMax H3 and h3.c (optional video runtime)

- Native engine: https://github.com/antirez/h3.c
- Pinned engine commit: `8974cc055ea9c02fcd14cc27dfda3e1027c05153`
- Engine license: MIT
- Official model: https://huggingface.co/MiniMaxAI/MiniMax-H3
- Pinned model revision: `9ac0dd7aabc2c651fcf0ace4c00b2bffd9c8c8a6`
- Model terms: [MiniMax H3 Community License Agreement](https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/LICENSE)
- Install location: `~/.dstudio/minimax-h3`

DStudio runs the official checkpoint through the pinned native Metal engine,
not a hosted API. Users must review the current model terms and confirm that
their territory and intended use are authorized before download or generation.
DStudio does not redistribute the downloaded weights or grant model-use rights.

## Optional GSA Recon Tools

DStudio can install command-line tools and ProjectDiscovery nuclei templates
into the user's local app-data directory for authorized GSA runs. The binaries,
package environments, vulnerability databases and template checkout are not
vendored or committed in this repository.

The authoritative current inventory and install methods are maintained in
[`src/harness/gsa/tools/catalog.json`](src/harness/gsa/tools/catalog.json); the
managed-directory layout is documented in
[`src/harness/gsa/tools/README.md`](src/harness/gsa/tools/README.md). Each optional
download remains subject to its own upstream license and terms.

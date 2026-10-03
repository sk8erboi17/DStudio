# Bundled engine sources

DStudio includes its inference engine sources in Git and in the macOS app.
Cloning DStudio once supplies the engine code: setup copies the pinned sources
locally, applies the existing versioned patches, and compiles. It does not clone
engine repositories, download source archives, or fall back to remote sources.
The Updates screen no longer fetches or pulls engine revisions. New engine pins
are distributed with DStudio updates.

Weights still require a separate, explicit download or an existing local model.
Source installation is not model readiness or inference qualification. Existing
runtime checkouts, user changes, settings and model paths are preserved.

| Engine | Source snapshot | Upstream revision |
| --- | --- | --- |
| Main: DeepSeek, GLM and current Qwen Next | [ds4](../src/engines/ds4/) | `0aaea5a238fb41a35106a551e73c8409dfb751ac` |
| Laguna S 2.1 | [ds4-laguna-s21](../src/engines/ds4-laguna-s21/) | `448d5695d1c86401a4e9447c440feb983b73e6de` |
| Qwen3.6-35B-A3B and Qwen3.8-27B (llama-server) | [llama.cpp](../src/engines/llama.cpp/) | `99b95488cac0f00ce3f05af113a8c1e287753f87` (tag `b11371`) |
| Qwen3.6-35B-A3B MXFP8 on Apple Silicon (MLX server) | [mlx wheels](../src/engines/mlx/) | mlx 0.32.3 (`64ea011`), mlx-lm 0.32.0 (`a9bd8af`); [see below](#mlx-runtime-apple-silicon) |

Only active engines are distributed. Qwen Next uses main; its retired separate
fork is preserved in Git history and the historical patches, without shipping
its source snapshot. Its earlier separate PLE format is not silently converted
or selected. The former Qwen side engines (vagrillo/ds4 for Qwen3.6 and
Ninnix/q36 for the dense 27B) were retired on October 3, 2026 in favour of
llama.cpp; see [their retirement](#retired-qwen-side-engines).

## Source identity and installation

The three distributed snapshots contain 4290 files (main 457, Laguna 194,
llama.cpp 3639) matching their pinned archives byte for byte. Their upstream
formatting is retained. The original five-snapshot import was independently repeated; its staged scan recorded
2902 inherited findings across 35 unchanged upstream files; authored changes
pass the whitespace check. No engine source was rewritten to conceal those
upstream formatting differences.

[The manifest](../src/engines/manifest.json) records each repository, exact
commit, distributed file digest, byte count and executable mode. Engine code,
headers, shaders, build files, scripts, upstream tests and license notices retain
their upstream bytes. Training/imatrix datasets, large upstream benchmark
receipts and compiled/model outputs are omitted and identified individually in
the manifest. No local weights, chats, caches, binaries or nested Git databases
are committed. [Third-party notices](../THIRD_PARTY_NOTICES.md) remain applicable.

The shared source helper checks the native pin against the manifest, rejects
missing, extra, linked, special or altered files, and copies into a private
candidate. It revalidates source identity and the target before exclusive
publication. One preparation per target is admitted; byte/file limits are
256 MiB and 8192 files, with at most two failed source candidates retained for
review. Process exit releases the installation lease. Source installation does
not have an elapsed-work cutoff. Failed preparations are reported explicitly;
there is no network fallback. Final durability failure reports that publication
occurred, instead of claiming success or deleting the installed bytes.

The macOS app materializes signed support assets into its existing writable
support directory, then installs working sources at `ds4/`,
`ds4-laguna-s21/` or `llama.cpp/`. Source builds use the same relative
runtime paths. The immutable distributed snapshots remain in `src/engines/`;
runtime patching and builds never edit them. Optional engines retain the shared
`ds4/gguf` model store. Existing nonempty unrecognized targets are refused.

llama.cpp is installed by [its own helper](../scripts/install-llama.py), never on
the native HTTP loop. It copies and verifies the bundled snapshot in a private
stage, builds only `llama-server` (no web UI, no HTTPS, build number and commit
passed explicitly so the enclosing repository's Git identity is never read),
checks that the binary reports the pinned build, and publishes `llama.cpp/` with
an exclusive rename. Its receipt records the pin, the exact CMake options and the
SHA-256 of every published file; an installation is reused only when all match.

The build recipe depends on the platform, following Ollama's approach:

| Platform | Layout | Backends | Status |
| --- | --- | --- | --- |
| macOS (Apple Silicon) | One static executable | Metal | Tested: real 10/10 host workflows |
| Linux x86-64 / arm64 | `llama-server` + shared `libllama`/`libggml` + one module per backend in `bin/` | Every CPU variant (ggml picks the best for the processor at startup); CUDA if `nvcc` is found, ROCm/HIP if `hipconfig` is found, Vulkan if `glslc` and the Vulkan headers are found | Compiles; not run on Linux hardware |
| Windows x64 | Same as Linux, with DLLs next to `llama-server.exe` | Same detection (`CUDA_PATH`, `HIP_PATH`, `VULKAN_SDK`) | Compiles; not run on Windows |

`DSTUDIO_LLAMA_BACKENDS=cpu,cuda,hip,vulkan` restricts or requests backends
explicitly; a requested backend whose toolchain is missing fails the
installation instead of being dropped silently. Each distinct backend set is a
distinct build identity, so installing a GPU toolkit later triggers a rebuild.
In the dynamic layout every file in `bin/` is recorded, because ggml loads any
`libggml-*` module it finds next to the server: an unrecorded module makes the
installation not current. The server runs with `bin/` as its working directory
for the same reason. On these platforms DStudio omits `--n-gpu-layers` and lets
llama.cpp's `--fit` place layers by the free memory of the devices it opened,
the rest on CPU; the context is always set explicitly, so fitting never lowers
it. Windows has no guard process: the server runs in a kill-on-close Job Object
owned by DStudio, which also holds the shared installation lease with
`LockFileEx`. Linux adds `PR_SET_PDEATHSIG` so a killed guard takes the server
with it. `make test-llama-dynamic-build` builds this dynamic layout for real on
macOS (CPU variants plus the Metal module); CUDA, ROCm, Vulkan, Linux and
Windows themselves remain unexecuted. `.dstudio-llama-install.lock` is taken exclusively to build or
replace, and held shared by every running DStudio llama-server, so an engine in
use is verified but never replaced. A canceled build deletes its stage; a failed
build keeps only its log, at most two of them. Files the helper did not publish
are never removed. The snapshot omits llama.cpp's test vocabulary GGUFs,
generated per-backend operator tables and published benchmark runs; all are
listed with digests in the manifest.

### MLX runtime (Apple Silicon)

MLX is not compiled from source: DStudio ships the unmodified PyPI wheels for
macOS 26 on arm64 and CPython 3.12, 3.13 and 3.14 (46 files, about 116 MB) with a
[manifest](../src/engines/mlx/manifest.json) of their names, versions, licenses,
sizes and SHA-256. [`scripts/install-mlx.py`](../scripts/install-mlx.py), run in
the background before the first launch or the weight download, verifies every
wheel, picks the newest supported Python on the Mac, creates a private virtual
environment with copied interpreter files, and installs with `pip --no-index
--require-hashes`, so nothing is fetched and only the hashes for that Python's
ABI are accepted. It then applies
[`patch/mlx-lm-single-model`](../patch/mlx-lm-single-model/README.md) and
[`patch/mlx-lm-reasoning-content`](../patch/mlx-lm-reasoning-content/README.md),
checks the installed versions and that Metal is available, and publishes `mlx/`
with a receipt (manifest digest, copied interpreter SHA-256, patch SHA-256s and
the base Python files the environment still executes). A changed wheel set,
interpreter, patch or base Python (for example after a Homebrew upgrade
removes the old version) makes the installation not current, so it is rebuilt
instead of failing at launch. The server starts with one request at a time and
a default response limit equal to the configured context, because upstream's
512-token default would cut a request that sets no limit. The wheels live
outside the app's startup payload (`Contents/Resources/MlxPackages`), so they
are not copied on every launch. MLX is admitted only on Apple Silicon; Linux and
Windows reject the MLX model explicitly.

The model is the folder `ds4/mlx/Qwen3.6-35B-A3B-mxfp8`, filled by
[`scripts/download-mlx-qwen36.py`](../scripts/download-mlx-qwen36.py) (20 pinned
files of `mlx-community/Qwen3.6-35B-A3B-mxfp8` at `5c216c8`, 36.67 GB, the same
resumable per-file verification as the 27B download). That folder may be a link
to an existing copy; DStudio admits it by its target's identity and never
copies or moves the weights.

Setup requires Python 3 and the existing native build tools; on macOS that means
Apple Command Line Tools, Make and Git for local patch application. The
llama.cpp engine also needs CMake (found on `PATH`, in Homebrew's locations,
CMake.app, `/usr/bin` or `C:\Program Files\CMake`); without it the launch fails
with that explanation. Git is not used to fetch an engine. The Windows portable
packaging script includes the same source assets; Windows and Linux
installation have only been cross-compiled (`zig cc`), not executed, and remain
unqualified.

## Verification

The September 30, 2026 change ran the existing native installer guards and all
44 q36 installer regressions before editing production behavior. The added
source-copy tests exercise real files, digests, exclusive publication, owner
leases, racing targets, retained-failure limits and interrupted durability
acknowledgement. Fixture compilation in those regressions is explicitly
simulated; it is not engine or model validation.

```sh
make test-engine-sources test-engine-pins test-engine-setup-unit test-engine-updates
make test-resident-unit test-resident-guard
make test-macos-bundle
make test-first-launch-e2e
```

The first-launch gate relocates the signed app, starts an empty profile, uses
the real WebKit onboarding/model controls, and builds main and Laguna. It also
invokes the bundled CLI (`--install-engine llama`) for a fresh llama.cpp build
and checks the pinned `--version`. macOS denies external outbound connections
for the app and its installer/compiler children; loopback remains available for
UI/host requests. The builds, help probes, model-store identity checks and patch
roundtrips run without weights or inference. Before October 3 the same gate
built Qwen3.6 and q36 instead of llama.cpp; those receipts are history. An
existing engine-port listener is checked and preserved throughout.

The retained update regression first failed against the old behavior and then
passed after upstream fetching was removed. Update checks expose no engine-pull
action; stale `ds4-latest` requests fail before restoring patches or running Git.
These checks qualify the installation path on this Mac, not model quality, CUDA,
Vulkan, Windows, the native window or a complete release.

The subsequent removal of the retired Qwen Next source snapshot excludes
577 files (31,503,887 bytes) from new source distributions and app bundles.
The original Git commit and historical patches retain its provenance. Follow-up
verification runs `make test-engine-sources test-engine-pins
test-engine-setup-unit test-engine-updates test-macos-bundle`: all 18 source
cases passed, only the then-active engines could be copied, and the relocated app
materialized only their source snapshots with pins matching its native metadata.
The retired source cannot be copied or installed, and its old HTTP installer
remains unavailable. These checks do not rerun inference or the full quality
suite.

## Retired Qwen side engines

On October 3, 2026 the vagrillo/ds4 fork (`ds4-qwen35`, commit `73434c4`) and
Ninnix/q36 (`q36`, commit `1305843`) stopped shipping. Their snapshots, patches,
apply scripts, the q36 installer, the hash-only legacy q36 inventories and their
dedicated tests were removed; Git history retains all of them. The same pinned
Qwen weights now run on llama.cpp from the main installation's `gguf/` store.
A leftover `ds4-qwen35/` or `q36/` directory is recognized and left untouched: it
is no longer offered, selected or rebuilt, a persisted selection falls back to
the sibling `ds4/`, and the old setup endpoint answers 410 Gone.

Before the removal, the replacement passed real inference through the production
host with both models (`tests/live/llama_resident_live_test.mjs`, receipts in
`tests/.artifacts/llama-resident-live/`): Agent file read/compute/write, Agent
answers from a workspace file, Cowork document creation, Chat through `/v1` with
thinking on and off (and an image for the 27B), mode switches reusing the loaded
server, and no llama-server left after the host is killed. One earlier run is
retained as a failure: with thinking off, Qwen3.6 multiplied two numbers wrongly.

## Refreshing reviewed source snapshots

[The import tool](../scripts/vendor-engine-sources.py) accepts an exact local Git
archive or a pinned upstream archive already obtained by an explicit review.
It never fetches sources and refuses an existing output snapshot. Use a private
output directory for preparation, review provenance and exclusions, then update
only the versioned source snapshots and manifest in the repository. Keep all
engine adaptations as versioned patches, update native pins and every affected
consumer, and rerun the offline installation gates before publication.

```sh
git -C UPSTREAM_CHECKOUT archive --format=tar --output PINNED_SOURCE.tar EXACT_COMMIT
python3 scripts/vendor-engine-sources.py --engine main --directory ds4 \
  --repository https://github.com/antirez/ds4 --revision EXACT_COMMIT \
  --archive PINNED_SOURCE.tar --output-root PRIVATE_PREPARATION
```

For a GitHub archive, add `--strip-prefix`; its directory prefix must match the
exact repository name and commit. The archive's Git commit identity must also
match, for either archive format. Reimporting the same revision produces the
same file inventory. Upstream network admission audits remain explicit
development commands, separate from app setup and updates.

Add a refreshed snapshot with `git add -f`: upstream trees contain names that
this repository's ignore rules match (a `core/` directory, nested
`.gitignore` files), and an ignored file would be missing from every clone
although the local tree verifies. `make test-engine-sources` checks that Git
tracks exactly the manifest's files and modes, for the engines, the harness
snapshots in `src/harness/` and the MLX wheels.

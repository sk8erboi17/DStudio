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
| Qwen3.6 MoE | [ds4-qwen35](../src/engines/ds4-qwen35/) | `73434c4bb9d8bb18425a2577edada69d25d44c47` |
| Qwen27B | [q36](../src/engines/q36/) | `1305843c735380f912619548b121cba8601f2f85` |
| Historical Qwen Next fork, source reference only | [ds4-qwen38](../src/engines/ds4-qwen38/) | `ff4f0ff4fdff70d6b7c3941ef437b91dde960e14` |

The historical fork is not an active installer target. Qwen Next uses main;
its earlier separate PLE format is not silently converted or selected.

## Source identity and installation

The exact upstream import was independently repeated: all five manifests and
2069 distributed files match their pinned Git archives byte for byte. Imported
upstream formatting is retained. The full staged whitespace scan recorded
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
`ds4-laguna-s21/`, `ds4-qwen35/` or `q36/`. Source builds use the same relative
runtime paths. The immutable distributed snapshots remain in `src/engines/`;
runtime patching and builds never edit them. Optional engines retain the shared
`ds4/gguf` model store. Existing nonempty unrecognized targets are refused.

q36 keeps its existing private build, lifetime lease, cancellation supervision,
managed-file inventory and atomic upgrade transaction. Original archive file
inventories for `d67687e` and `8362010` are included as hash-only provenance;
legacy ownership reconstruction no longer downloads those archives. Only files
provably owned by the prior installer may be replaced. User files and cache
identity, retained failures and previous-engine recovery records are preserved.

Setup requires Python 3 and the existing native build tools; on macOS that means
Apple Command Line Tools, Make and Git for local patch application. Git is not
used to fetch an engine. The Windows portable packaging script includes the
same source assets; Windows and Linux installation were not exercised in this
macOS change and remain unqualified here.

## Verification

The September 30, 2026 change ran the existing native installer guards and all
44 q36 installer regressions before editing production behavior. The added
source-copy tests exercise real files, digests, exclusive publication, owner
leases, racing targets, retained-failure limits and interrupted durability
acknowledgement. Fixture compilation in those regressions is explicitly
simulated; it is not engine or model validation.

```sh
make test-engine-sources test-engine-pins test-engine-setup-unit test-engine-updates
make test-q36-install
make test-macos-bundle
make test-first-launch-e2e
```

The first-launch gate relocates the signed app, starts an empty profile, uses
the real WebKit onboarding/model controls, and builds main, Laguna and Qwen3.6.
It also invokes the bundled CLI for a fresh q36 build. macOS denies external
outbound connections for the app and its installer/compiler children; loopback
remains available for UI/host requests. All four builds, help probes, model-store
identity checks and patch roundtrips run without weights or inference. An
existing engine-port listener is checked and preserved throughout.

The retained update regression first failed against the old behavior and then
passed after upstream fetching was removed. Update checks expose no engine-pull
action; stale `ds4-latest` requests fail before restoring patches or running Git.
These checks qualify the installation path on this Mac, not model quality, CUDA,
Vulkan, Windows, the native window or a complete release.

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

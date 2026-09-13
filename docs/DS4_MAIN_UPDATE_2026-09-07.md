# ds4 main update — September 7, 2026

The first-install pin is now
[`f62ca29a308724cde5bc99134ede19104b2a3260`](https://github.com/antirez/ds4/commit/f62ca29a308724cde5bc99134ede19104b2a3260),
checked on September 7. The earlier update that day advanced from `f4d03f6` to
`c0a6119`. No model weights, model selections, context limits or SSD settings
are changed. Updating the installer pin does not itself update an existing
checkout or running app. Laguna and Qwen retain separate revisions.

The final two upstream commits change the README and GLM's Metal SSD cache
seeding: recently used prompt experts retain their ranking but receive bounded
initial priority, allowing later decode demand to replace them. Agent, web,
server, headers, shaders and build rules are unchanged in this small delta.
[Comparison from the earlier September 7 pin](https://github.com/antirez/ds4/compare/c0a6119f363ef82125877142f13fb3fe491cba14...f62ca29a308724cde5bc99134ede19104b2a3260).

## What users gain

- More reliable file reads, atomic file replacements and background shell jobs.
- Better handling of literal tool markers, output limits and interrupted
  speculative generation, without changing tool arguments into instructions.
- Fixes to session snapshots, GLM prefill attention and Metal SSD memory/cache
  handling. A snapshot no longer loses its final byte.

[Complete upstream comparison](https://github.com/antirez/ds4/compare/f4d03f6cf9f11c1e7b630bcb160853acfba7c52a...c0a6119f363ef82125877142f13fb3fe491cba14).
This update has **no new real-model speed or quality benchmark**. The
[September 5 measurements](DS4_MAIN_UPDATE_2026-09-05.md) remain historical;
they must not be presented as results for this revision.

## DStudio compatibility

The original Agent/Cowork patch 87 retained upstream's capability-dependent vision schemas,
file-tool limits and exact-sampling boundaries. Greedy opportunistic drafts
remain usable across tool-parser transitions; exact sampled generation still
re-evaluates the boundary token. Old main and pinned Laguna keep their matching
patch variants. The remote DeepSeek path remains text-only DSML.
Patch 89 additionally preserves upstream's renderer-only captures when no
JSONL worker exists, fixing a null access exposed by the original native tests
under UBSan. The historical migration oracle remains unchanged; its test
reverses only that separately documented correction before comparing bytes.
Its new Qwen candidate variant does not change main's model routing.

The launcher now supplies the complete absolute Metal shader paths for main,
Laguna and both Qwen forks. Previously, a successful build could still fail
when Agent/Cowork changed to the user's workspace: GLM/vision, DFlash and Qwen
source paths were missing. `make test-metal-workspace` reproduces initialization
from both locations and checks an actual GPU result for each fork. This is a
model-free regression test, not evidence that a model's vision is enabled.

Chat PLD patch 3 preserves the native GLM/DSML tracker identity, token limits
and speculative cleanup. The ordinary generation path remains the reference;
the optional batch verifier is still experimental, not newly qualified here.

Versions 87 and 3 migrate the former transformations to complete `.patch` files
without changing their derived source behavior; web uses one complete patch.
Private Agent/Cowork and Chat staging preserves prior working executables on
failed links. This is not full dependency-signature or crash-atomic pair qualification.

The M2 patch retains upstream's newer variable-length diagnostic output and
uses compatible build rules. All runtime hunks are preflighted together.
Apply/restore on old and current source layouts remains supported; unrelated
source edits must survive. The managed source checkout was fast-forwarded only
after reversing the old patches and confirming no tracked local edits remained.

## Verification

Apple M2 Max / macOS. The following are model-free checks: no user weights or
app/model restarts. Numerical tests use small deterministic fixtures and actual
Metal kernels, not complete-model inference.

The `f62ca29` revision passes native patch apply/repeat/restore, upstream
frontend/session/attention/Metal streaming/SSD-cache tests, and fresh native
Agent/Cowork/Design builds with real filesystem tools and simulated model frames,
on both CPU and Metal. The managed checkout was then fast-forwarded and its
native and DStudio-derived binaries rebuilt; pre-existing untracked files were
preserved. This does not replace or restart the user's desktop app.
Chat PLD compiles and its CLI starts. Those checks do not establish a GLM
response-quality or speed improvement. The broader checks listed below also
document the earlier `c0a6119` migration; they are not all new-pin release results.

```sh
make test-agent-pld test-pld-build test-glm53-m2max-patch test-main-decode-metrics
make test-engine-setup-unit
make test-steering-patch
node tests/integration/glm53_m2max_patch_test.mjs ds4
node tests/integration/upstream_agent_prompt_test.mjs ds4
node tests/integration/runtime_steering_test.mjs \
  ds4/ds4-agent-jsonl ds4/ds4-cowork ds4/ds4-design
make -C ds4 test-frontends test-session-state test-glm-attention \
  test-metal-stream-index test-metal-ssd-experts test-ssd-cache
node tests/live/engine_acceptance.mjs --setup --engines main
```

The prompt test executes ten compiled native/remote Agent/Cowork builders and
parses their emitted tool schemas. It checks actual vision availability and
GLM envelope placement. The PLD suite includes state/output parity and sampling
mode transitions; 27,979 deterministic checks pass against stateful doubles.
The complete patch lifecycle is also tested against a clean source copy.

Native frontend, session/TP-command, attention, streaming-cache/index and SSD
cache tests pass. Chat, Agent, Cowork and Design compile with the current patch
stack. CUDA/ROCm runtime behavior and real-model numerical equivalence are not
validated by these macOS checks.

The empty-directory setup also passes: DStudio downloads the exact pinned
archive over HTTPS, builds its runtimes and checks executable startup. No model
weights are downloaded and no inference is claimed by that installation check.
The desktop host test binary is rebuilt; packaging checks from the earlier
tranche are not a new-pin release qualification.

Derived runtime Makefiles now inherit upstream's CPU objects and CUDA/ROCm
linker/libraries instead of using the Metal link recipe for every platform.
`make test-backend-link` executes 16 actual Makefile paths with simulated
compilers and rejects missing linkers before touching an output. Separate real
CPU/Metal builds pass for main and Laguna. NVIDIA/AMD hardware and Windows
builds are still **not run**; successful routing is not numerical compatibility.

The first compatibility attempt correctly rejected the old Agent/Chat anchors
and obsolete Metal logging/build hunks; they were rebased before updating the
working engine. An initial frontend build also collided with a temporary Agent
patch build in the same isolated checkout; the complete frontend gate was rerun
after restoration. Builds that temporarily patch a checkout must run serially
with other source-consuming builds in that checkout.

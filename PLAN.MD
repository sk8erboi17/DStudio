# DStudio — complete quality and multihardware support plan

Assessment: September 7, 2026. Priorities: stability, correctness, quality,
hardware coverage, then performance.

**Current operational status: publication checkpoint.** The user has closed the
current implementation slice and paused the remaining P0–P11 campaign, which is
incomplete. Publishing the sources and documentation does not authorize resuming
implementation, downloading models, starting engines or restarting the app.
See [WORK_IN_PROGRESS.md](docs/WORK_IN_PROGRESS.md) for the current status.
The September 12 instruction to prioritize new upstream commits, DeepSeek V4.1 Q2
and a real SSD test with a `.txt` file on the Desktop, then continue the full
P0–P11 plan (then an active goal), followed the Qwen pause checkpoint and the
rebuilds requested by the user. That resume instruction is historical, not
current authorization. It did not authorize downloads or launches outside its scope.
Status, limitations and commands are in [QWEN_CHECKPOINT.md](docs/QWEN_CHECKPOINT.md).
The full plan remains open; rebuilding the app alone does not close it.

**Verified status:** the plan is ready as a document, but its execution
is not complete. The broad model-free gate also passed after migrating
Agent/Cowork, web and Chat PLD to `.patch`, with sources unchanged during the run.
The subsequent cleanup fix has focused evidence, sanitizer checks and real builds
from the bundle; the earlier broad gate is not attributed to it. Following explicit
authorization, only FlashStudy's ds4 engine on port 28000 was stopped with SIGTERM;
the app and its data remained intact. The first attempt blocked by the external
engine remains a failed receipt, separate from the subsequent successful gate.
Qwen3.8 has experimental Agent/Cowork support in the host: two real workflows
passed on the historical `66b0e3f` pin, without updating the user's old checkout.
The subsequent replay on candidate `82d0314` has Agent PASS and Cowork FAIL after
the reset; the historical result does not qualify the new candidate.
The complete quality tests,
desktop matrix, Qwen27B qualification, generated projects for the nine design
systems and final comparisons
remain open. At the time these results were recorded, there was no qualified
final build or campaign push. The current source-publication checkpoint does
not qualify a final release.

This document distinguishes **what exists, what has been tested and what
remains to be implemented**. The first deliverable was the plan after code analysis.
The user subsequently requested its completion, then a pause, then a resumption
of the full plan, and finally the current publication checkpoint and pause.
**The full campaign is incomplete and paused.**
The assessment history remains separate from the new evidence in the log.

### P2/P6 — upstream update and DeepSeek V4.1, September 12

- P3/P5, September 13 at 01:19 UTC: cache-overlay binary verified through
  HTTP/images/tools/cache **46/46** (`run-Erzu5e`) and inside DStudio **14/14**
  (`run-KduHiw`), including Agent Python/Excel Cowork, unchanged inputs and
  terminated processes. The subsequent fault test finds a command still alive
  after the installer receives SIGKILL. Added supervision with a lifetime pipe
  and reserved process identity: **42/42** installer checks, including output
  already closed, ignored SIGTERM and byte limits. The original RED remains in
  `q36-installer-death.DKYxTQ`.
  The new installer is a separate change from the binary in the preceding replays;
  its network/build/inference replay `run-jkibs2` ends at 01:20:45 UTC
  **8/8 PASS**, with actual reuse of the legacy cache and binaries identical to
  the 46/46 and 14/14 replays. Final admission check **16/16**, host **94 unit + 15
  simulated scenarios**, unchanged inputs and terminated processes. Learn and
  the mode/desktop matrix, broad quality and
  long context, other engines/backends and the full P5 matrix remain incomplete;
  these checks alone close no chapter.
- P3/P5, September 13 at 00:58 UTC: q36 upgrade now tested with an actual
  continuation of the legacy checkpoint and a comparison without cache. The first
  extended attempt `q36-upgrade-live/run-sOSwzz` remains **3 PASS, 1 FAIL,
  4 not run**: actual cache reuse, but an HTTP count of zero. New
  `cache-usage.patch` after runtime/monitor/owner, with no numerical changes.
  Native ASan/UBSan gate **78/78 single, 68/68 batch**, patch/build cycle
  **12/12**, installer **38/38** and admission **16/16**. Simulated numerics
  in the model-free gates. Real `run-MsDxvv` **8/8 PASS**, 33 legacy tokens reused,
  answer identical to the process without cache; project C/Makefile/links,
  settings and weights preserved. Inputs rechecked and processes terminated.
  The preceding host `run-tDuo5n` ends 14/14 on the old patch stack,
  and does not automatically qualify the new binary. Common quality
  61/100, Learn/Design, long contexts, desktop, other engines/backends and
  the full P5 matrix remain open. Hashes and failure in the upstream checkpoint.
- P5, September 13 at 00:10 UTC: implemented q36 upgrade through staging,
  reconstruction of legacy ownership from the verified archive, atomic swap
  and preservation of the old directory/user data. **35** installer tests
  PASS; descendant cleanup fixed and cancellation/fsync/reopening tested.
  First real run `q36-upgrade-live/run-Xqm7MP`: **1 PASS, 1 FAIL, 4 not run**,
  because the initial legacy build gives an unintelligible answer before
  the upgrade. The subsequent prior build `d67687ed`/`75764a9f`, without
  changing the prompt/assert/deadline, passes the entire flow **6/6** in `run-42nhJa`:
  native answer before/after, download/patch/build of `8362010`, preservation
  of project, settings, weights and real cache, reopening without double commit.
  Inputs/hashes unchanged and processes terminated. **0 cached tokens** in the new
  answer: reuse of the old KV format not demonstrated. This does not close all
  of P5, the other engines, every mode or general quality at 61/100.
- P3/P5, 23:36 UTC: real replay of the new installation/protection
  `q36-host-live/run-JgGSg0` **14/14 PASS**: Chat, Agent Python, Excel Cowork,
  four images and return to Chat in the same process. Protection remains
  active until native exit; Stop releases the process, port and protection.
  Inputs unchanged, host exit 0 and host/model verified absent. No
  weight download or restart of the user's app. This does not close Design, Learn,
  common quality at 61/100 or the full P3/P6/P7 matrix.
- P2/P5, 23:27 UTC: installation use protection owned by the
  actual Qwen process until it exits; acquisition and binary checking
  outside the HTTP loop. Read-only verification remains compatible
  with Chat → Agent. RED `q36-host/run-Jm7a0A` reproduced; now **94/94** unit
  and **15/15** lifecycle checks in normal (`run-ZKdGZO`) and ASan/UBSan
  (`run-fnFCOq`) runs.
  Inference is simulated in these gates. **22** installer tests PASS, including
  concurrency, FIFO, bounded inventory and later data not adopted.
  Real network installation `engine-acceptance/run-37al3S` **main + q36
  PASS**, with a q36 inventory of 147 sources and 255 managed files. No
  weight download or intervention on the user's app. These are prerequisites
  for P5: reconstruction of ownership in old receipts, upgrade, recoverable
  publication and the preservation matrix remain incomplete. Details and
  retained failures in the [upstream checkpoint](docs/DS41_UPDATE_CHECKPOINT.md).
- P2/P3/P5, 22:51 UTC: q36 installer candidate updated to `8362010`,
  with explicit application of `next-review` → `monitor` → `monitor-owner`.
  Receipt with order/hashes and revalidation of the installer itself before
  publication. Installer fixtures **14 PASS**, including a change during
  build (simulated compilation in that regression); native metadata **4/4**
  `engine-pins/run-3R7xoz`, setup/selection and launch control **11/11**
  `launch-control/http-8XNTpQ`, without inference.
  Actual empty installation from the network `engine-acceptance/run-jVF1xy`
  **main + q36 PASS**, both compiled: main `bd66c402`, q36 `8362010`.
  The 147 q36 inputs, patches and binaries are rechecked; no weight download.
  The q36 server matches the preceding native gate's server byte for byte,
  but the following test actually uses the new installation.
  `q36-host-live/run-pkigpi` **14/14 PASS**: Chat, stream, same resident process,
  Agent with Python edit and four original asserts, Excel Cowork reread
  by tools and an independent OOXML oracle, four images through tools,
  return to Chat and Stop with the port released. Host exit 0, inputs unchanged,
  host/model verified absent. The model issues one incorrect directory-change
  command, then corrects it: the original log remains intact.
  This is not held-out quality, Task Graph, Learn or the actual `.app` matrix.
  Runner admission updated for the new installer without pretending it is a
  Git checkout: **14/14** `q36-http-install/run-bsmPUH`; historical native copies
  **13/13** `q36-http-review/run-aGwGJa`. No model in these two gates;
  the replay on the new installation `q36-http-vision-live/run-oGEVFX`
  ends at 22:55 UTC **46/46 PASS**, without `--next`: 157 inputs and weights
  unchanged, four checkpoints identical after Stop, same result and eight
  continuation reuse fields (1,302 tokens). Native exit 0 and PID
  terminated. No deadline extension or changes to the oracles.
  Upgrading existing installations still needs implementation and verification:
  conservative refusal to overwrite them does not count as a successful upgrade.
- Agent v102: new candidate following the defects in the Laguna/MoE v101 summaries.
  The runtime supplies the response's open/finished state; the prompt
  distinguishes current progress from old pending steps. Reserve calculated
  with both messages tokenized, without changing the generation budget.
  Seven-base migration `run-B6HMz1` PASS with frozen predecessors;
  Laguna `agent-compaction/run-EJUCfG` passes 14/50/18 and MoE `run-Kl7ppp`
  14/53/16 (publication/tokenizer/loop, simulated inference, ASan/UBSan).
  The preceding v101 with the historical helper fails exactly the two new
  state tests (`run-tDsUKF`, `run-4iJ6ks`). Three failed compilation attempts
  caused by incomplete reserve callers are retained and corrected.
  Full rebuild `agent-native-build/run-Ethbt2` PASS 77/77 at 21:41 UTC,
  across four engines, inputs unchanged and simulated responses. Laguna v102 replay
  `agent-continuation-live/run-b3xpGT` ended at 21:46 UTC: 6/6 workflows
  PASS, code compiled/executed, real tools, exit 0 and PID terminated.
  Separate review of the two summaries PASS for facts/progress/effects:
  57/200 while the response is open, 200/200 after completion.
  MoE v102 `run-V4I1gQ` ends at 22:05 UTC: **1 PASS, 1 FAIL due to timeout,
  4 not run**. The second turn reaches 174/200 functions at the original
  600 s deadline; the engine was still generating and is terminated by
  the runner with SIGTERM. Summary and reconstruction take 282.767 s. The
  separate review also finds 55 complete functions and one partial function,
  whereas the summary counts 56 as emitted; facts and requirements remain preserved.
  Original receipt intact, 32 inputs and model identity rechecked
  unchanged after exit. No qualification, extended deadline or inputs still
  frozen by this terminated run.
  PLD 28,633
  checks, builder/validator and admission/metadata fixtures PASS. No
  new general qualification, `.app` restart or closure of P0–P11.
- q36 `8362010`, new verification with separate identities for the checkout and
  the copy actually compiled: `q36-metal-runtime/run-nY4HeX` **43/43 PASS**,
  including projector, operators, cache and preservation of the 52 compiled inputs.
  The preceding receipt remains unchanged: it recorded the checkout hashes,
  not the comments added to the copy by the lifecycle test. The new
  CLI check `q36-http-review/run-fOY8Ec` passes **13/13**, without models: it rejects
  incorrect binaries/sources/hashes/receipts and Git identity inherited from the parent.
  Real images/tools/cache replay `q36-http-vision-live/run-jfuPOr` finished
  at 22:19 UTC: **46/46 PASS** on the new commit, inputs unchanged and engine
  exit 0/PID terminated. After Stop, the four checkpoints remain identical and
  the eight reuse fields match uninterrupted continuation
  (1,302 tokens reused). No general qualification or installer promotion;
  results from the previous revision are not attributed to the new one.
- Main and Qwen Next updated to pins `bd66c402` and `ff4f0ff`, with patch
  migration and consumer builds; the Qwen3.6 MoE fork receives pin `73434c4`
  with upstream documentation changes only. Laguna has no new commits.
  Complete inventory of the 146 new commits and their transferability in the
  [update checkpoint](docs/DS41_UPDATE_CHECKPOINT.md).
- Q2 weights for V4.1 downloaded (365,713,686,528 bytes), full SHA-256 verified,
  also available in `ds4/gguf` without duplicating the 341 GiB. Real test
  `ds41-update.08fcss/ssd-benchmark-01`: 14 requests completed, **13/14 compliant**,
  one retained format error (correct Python calculation but an unrequested
  explanation), process without crashes and clean exit. Requested report on
  the Desktop: `DeepSeek-V4.1-Flash-Q2-SSD-performance.txt`. The benchmark remains
  failed for that instruction; measurements are observations, not a qualified
  comparison or a statement of general quality. No app restart,
  selection/preference change or system-limit change.
- q36 candidate `8ce8924`: rebase resolved in `next-review.patch`, image
  preparation in the worker and private publication, native tool fingerprints/IDs
  preserved, prelude metadata by ID also in disk format v3.
  `q36-metal-runtime/run-J6CLJ5`: **41/41 phases PASS**, after the V4.1
  model finished. Includes 61 image/ownership cases, 97 tool persistence, 66 arguments/API,
  private-copy regressions and Metal operators; no new LLM qualification.
  Original fixture errors and corrections also applied to the baseline
  remain documented. The subsequent `run-GZfZjK` passes **42/42 phases**, including
  the real encoder against a scalar reference (15,385 asserts, limits unchanged).
  The real replay `q36-http-vision-live/run-vf7idm` passes **40/40 workflows**
  Qwen27B/Metal: the preceding 28 cases and 12 new image/tool checks on
  OpenAI, Responses and Anthropic, including preserving omitted pixels in
  authenticated continuation and changing the answer when new pixels arrive.
  Hashes unchanged and engine terminated normally; no app restarted.
  The q36 installer is still on the preceding pin: full quality, long context,
  disk cache and in-app integration still needed qualification on the new pin;
  the subsequent completed cache replay is recorded separately below.
  The subsequent disk-cache `run-MO5enE` is **43/46 FAIL**: the 40 image/tool cases
  pass, the five existing checkpoints remain identical during Stop and the
  engine terminates normally. However, the first text after the new image sequence
  goes through visual preparation without cache staging; the checkpoint required
  by the continuation oracle is therefore missing. In addition, the new
  upstream canonicalizer removes the empty prelude despite
  `preserve_thinking: 1`, while the GGUF template retains it in the following prompt:
  reuse correctly rejected, but unnecessary full recomputation. Both
  observations are documented; no assertion weakened and no failed
  receipt replaced. Fixed with patch `582f57e7…`: **35/35** native regressions
  (previously 30/35), **42/42** complete gate with projector and **32/32** GGUF
  templates. The real replay `run-6jY0tA` is **45/46 FAIL**: exact reuse and resumption
  after Stop pass, but the previous session is saved before the
  commit and adds a checkpoint during the cancelled request. The four
  preceding files and the conversation remain intact; the check remains FAIL.
  Final patch `5d3ccc8a…` moves that save after the commit, without shared
  locks. Eleven new cases reproduce the defect: **35/46 → 46/46** on the
  single path, **25/36 → 36/36** on the batched path, with barriers and ASan/UBSan.
  Saving/rereading the old session after a successful commit verified.
  The final patch also passes **42/42** native/projector phases
  (`run-w0clga`) and **32/32** GGUF templates (`run-gtvwb8u2`), hashes unchanged.
  The final replay `q36-http-vision-live/run-fSs5iW` passes **46/46**: all
  40 image/tool workflows and the six cache/Stop cases, same cases and limits. The four
  checkpoints remain identical, no temporary files left behind, exact answer and
  eight continuation fields unchanged before/after Stop (1,302 tokens reused).
  Inputs unchanged, engine exit 0 and process verified terminated. This closes
  the run's cache defect, not general quality, long context or the
  application matrix. No old FAIL removed; installer pin unchanged.
- q27 candidate `8cd7083`: fixed the Metal M2 DeltaNet thread limit
  through `.patch`, upstream suite and scalar oracle passed; no qualification
  of the q27 weight format, CUDA or the full model inferred from these operators.
- Laguna/Qwen3.6 MoE compaction prerequisite: comparison with
  `e33a5b2` reproduced premature updates to the transcript and
  `MEMORY.MD`, with failure to check a Stop received after prefill.
  Fixed in Agent v98 patches: private preparation, brief publication
  by the owner alone, KV invalidation on error and previous memory preserved.
  Export after commit; export failure also reported in piped mode.
  Same final ASan/UBSan harness: **4/14 → 14/14 per branch**, receipts before
  `run-XvWWAk`/`run-ZQ7QxN`, after native transformation of the patches
  `run-KKPyWK`/`run-wGTgjx`. Complete seven-base migration
  `run-oxb0ru` PASS, including historical v97/v86 identities without changing the oracles.
  These are tests of native functions with simulated sessions/tokenizers, not LLM
  quality. The two new slow-preparation cases keep control accessible;
  worker layout unchanged, no timer added to production.
  Consumer v98 verification `agent-native-build/run-l6tfMX`: **69/69 phases PASS**
  on main/Laguna/Qwen Next/MoE, with Agent/Cowork/Design, real tools but simulated
  model responses, Stop/resume and ASan/UBSan parser. Inputs and checkouts unchanged.
  Builder, 39 patch checks and upstream admission regressions also PASS.
  No model launch, app restart or push in this slice.
- Laguna/Qwen MoE continuation now implemented in Agent v99 patches,
  reproducible from upstream bases without modifying their original sources.
  Native BPE/ChatML boundaries and original tail tokens preserved; summary
  as a user message, same renderer and output limit through resumption.
  Incomplete tool never executed, explicit small retry, Stop/error preserve
  transcript and previous effects. The test also detected an error at the
  second compaction: newly exported `MEMORY.MD` was reimported into the
  system prefix, changing the open-response boundary. Fixed
  by using the stable prefix during compaction; startup/reset unchanged.
  Initial failed receipts `run-iBnqeM`/`run-Vwpree` retained.
  Native production gate `run-Jntg6Y`/`run-CGHiec`: **50/50 and 53/53** boundaries
  with the real GGUF tokenizers, **15/15 and 13/13** loop cases with simulated
  inference, plus the **14/14** publication cases per branch, ASan/UBSan and inputs
  unchanged. Same final harness on v98: **4/15 and 3/13**, original receipts
  `run-5DMOsP`/`run-kAfUMN`. Three compactions in 18,000 tokens, rendered bytes
  identical to the oracle without compaction, limits, thinking, Laguna speculative path,
  memory export and an actual write exactly once after a complete retry.
  Seven-base migration `run-IR3WkB` PASS, v98/v97/v86 oracles unchanged.
  Consumer v99 `agent-native-build/run-ocDekM` PASS on main/Laguna/Next/MoE,
  with Agent/Cowork/Design builds and real tools/Stop/parser, controlled responses.
  **LLM continuation tests remain open**, along with summary quality, desktop and
  other backends: no quality PASS inferred from tokenizers or simulated loops.
  No weight loading, app restart, commit or push in this slice.
- First real MoE v99 continuation run `agent-continuation-live/run-lFiDBs`:
  **4/6 PASS**. The 200 generated C functions cross one compaction and
  pass independent compilation/execution; recovered facts and real tools
  before/after Stop are correct. The two FAILs remain in the receipts: premature WAITING
  on manual `/compact` and Stop receipt suppressed in noninteractive mode.
  Inputs unchanged, engine exited 0, PID terminated; no user app stopped.
  V100 fixes ownership/quiescence and JSONL feedback in the seven adaptations.
  Migration `run-ZdqwZF` PASS; Laguna/MoE **20/20** native tests each versus
  **8/20** on v99, with a preparation barrier and identical final oracle.
  Receipts `agent-idle/run-Gggw40`/`run-3IXGWm`, baseline `run-XVGr4f`/`run-LlVhrB`.
  WebKit/Chromium and 135 notification consumption/visibility checks PASS;
  Design with notification only verified in light/dark, screenshots and contrast
  checked (simulated engine responses). Complete rebuild
  `agent-native-build/run-YInkMT`: **77/77 phases PASS** on four engines,
  inputs and harness unchanged; retains the preceding `run-HP2HES`, which failed
  due to concurrent recompilation of the probe.
- Real v100 replays: MoE `agent-continuation-live/run-raYfjK` **5/6**, Laguna
  `run-krSaOZ` **4/6**, both exit 0, inputs unchanged and processes terminated.
  Manual compaction and Stop are correct. MoE generates functions without a return
  type from the first line; the independent C11 compiler also
  rejects them. Laguna compiles/executes the 200 functions, but the first summary loses
  the values to remember: `after.json` is missing. Tools after Stop
  work, but the preceding-file check remains FAIL. Receipts intact.
  The Qwen v99/v100 comparison is not an A/B with identical tokens: the native message
  with startup date/time differs, despite identical user prompts and parameters.
  First Laguna attempt `run-yftqXG` failed before loading: unsupported prefill
  override, six cases not run; the runner now uses Laguna's native
  choice and retains chunk 512 on Qwen. No test limit weakened.
- V101 strengthens summary instructions in the seven adaptations: preserve
  facts requested for future use and previous memory that is still valid, distinguish
  corrections and the internal request from the user's activity. No second
  authoritative store. Explicit `.patch` deltas, migration `run-glX1Vq` PASS
  with frozen v100/v99/v98/v97/v86 predecessors. Native builds, tokenizers and
  real replays are being rerun; this is not yet quality qualification.
  Meanwhile, v101 passes Laguna `agent-compaction/run-Os8ka2` (14 publication,
  50 tokenizer, 16 loop) and MoE `run-uw7FJ3` (14/53/14), ASan/UBSan and unchanged
  identities; real tokenizers but simulated inference in these tests.
  V101 rebuild `agent-native-build/run-dtNcgs`: **77/77 PASS**, four engines,
  frozen inputs unchanged. Real Laguna v101 replay `run-QcP9k6` **6/6 PASS**:
  200 functions compiled/executed, values recovered after two compactions,
  real tools before/after Stop, exit 0 and process terminated. However, review of
  the first summary finds the task declared complete while the response is still
  open: the retained context allows this run to finish correctly,
  but summary fidelity and general qualification remain open. Current request
  and progress must be preserved along with previous facts, using
  the actual state of the open response. No app restarted; receipts intact.
- q36 monitor: new native regression `q36-monitor-control/run-SDJGtD`
  reproduces blocked control during a slow log write, with a
  deterministic barrier and ASan/UBSan. Mutex held and state accessor
  blocked until writing resumes; output preserved, real shell
  terminated normally. No model loaded. Open defect: the fix
  must cover output ownership, signals and reaping, without adding
  PID races or losing terminal messages. This is not another passing gate phase.
  Attribution with the same final harness: original upstream source
  `run-p2HLgN` and adaptation `run-ChNShO` fail identically, preserving
  normal output and exit. The blocked write does not originate in DStudio's
  terminal patch. The new MoE v101 replay `run-lC2uDg`, started after
  Laguna exited, ends at 20:53 UTC: **6/6 PASS**, inputs unchanged, exit 0
  and PID terminated. The 200 C fragments are compiled and executed; facts, tools,
  manual compaction and Stop pass. However, the separate summary review
  remains FAIL: the first correctly remembers 65/200 functions, the second
  copies that state as still incomplete after actual completion and
  uses tool-call form, without executing it during compaction.
  Preserving and updating current/previous progress is the next Agent
  fix; do not alter v101 receipts or qualify fidelity from 6/6.
  The input-freeze constraint for this run ended with the run.
  The live suite now stops the remaining
  cases after a timeout: it does not queue requests behind a turn with an unknown outcome.
- q36 control: new `monitor-owner.patch` on top of candidate `8362010`
  separates I/O and publication, keeps Stop available during a stalled write,
  retains PID/PGID identity for signals in flight and deduplicates
  terminal notifications. **7/7 native cases + 14/14 lifecycle PASS** in
  `q36-monitor-control/run-g38GQE` (ASan/UBSan) and `run-PnMjJT` (ThreadSanitizer),
  without weights or changes to the original checkout. Same C oracle: upstream
  `run-QWH68o` and terminal-only `run-puGjgb` **1/5**; two notification-delivery
  tests are additions for the new implementation. Full Agent/PTY
  `q36-agent-tty/run-gd2ap6_q`: **28 phases PASS**, 32 jobs without leaks. The first
  profile discovered a busy loop at EOF (`run-fPmMoX`), subsequently fixed and
  covered by a visit counter. Job 1,208→1,216 bytes, worker unchanged; no
  additional threads. The patch remains an explicit candidate, not engine
  promotion or closure of the numerical/long-context issues and the full plan.
- q36 rechecked at new `8362010`: upstream exit/save fixes,
  worker ownership and Google links reviewed; core/server/kernel unchanged from
  `8ce8924`. Dedicated terminal monitor patch, **24 phases PASS** and zero leaks
  across 32 jobs (`run-zro9_7ab`); the new commit also passes **42/42**
  native/projector phases (`run-0Ykf7q`), hashes unchanged. No installer promotion
  and no automatic
  attribution of preceding LLM tests to the new commit. The full upstream
  Vulkan+SSD session tests remain not run on this Mac.
- Resumption: complete the real q36 checks, then the remaining applicable backports
  and P0–P11 acceptance tests. The preceding long-context anomalies remain open.
  The campaign is not complete and these updates have not been pushed.

### P3 — Chat and tools on the resident 27B server, September 9

- Normal startup with persisted 27B checkout: the desktop test exposed
  a ds4 recovery check incorrectly applied to q36. Regression-tested the actual
  bootstrap without test mode, with deferred inference: **3/4 → 4/4**, also
  ASan/UBSan, preserving ds4 checkout errors/backups. Lifecycle **14/14**,
  setup/preflight and updated bundle PASS. New Chat in the isolated macOS
  window `desktop-chat/run-VXqvBB` PASS: native selection, keyboard, exact JSON
  saved and visible, screenshot inspected, window closed with
  processes and ports released. One workflow, not the full P7 matrix.
- P0: fixed q36's omission from discovery, binaries and registered source
  types. Isolated-filesystem test RED→GREEN; current baseline
  `baseline-gKB1Mm`: 1,108 project files, six engines and 16 unique files, no
  error, new weight hash or model launch. This does not close the suite inventory.
- Agent/Cowork images: original-byte handoff to the owned 27B only,
  confinement, limits and recovery after decoder/transport failure implemented
  (`remote-vision.patch`). Simulated host/tools **17/17**, also with an
  ASan/UBSan host; build/probe on the four native bases and patch migrations PASS.
  Real gate extended to 14 checks `run-PnuF7a` **14/14 PASS**, with inputs
  unchanged. Traffic inspection found a prompt and host state that
  denied an available capability: RED regression `run-zN1ydR`, fix verified
  **17/17** (`run-1ZbWEm`), also ASan/UBSan host (`run-hO9Plw`). The UI now admits
  the 27B projector in attachment functions, **24/24**, previously 20/24; real
  browser/host with simulated inference **19/19** in both browsers and themes.
  Fixed the reset of omitted parameters on mode changes, which unnecessarily
  reloaded the model (RED host regression, then **12/12**). The additional
  browser check for saving and a visible final answer passes
  **19/19** in the four combinations; extended lifecycle **14/14** and tools
  **17/17**, also with ASan/UBSan host. Real run on the updated inputs
  `run-9er45q` finished **17/17 PASS** at 07:43:20 UTC: text and two
  pixel counterfactuals from WebKit Chat correct and saved; Agent, Cowork,
  images in tools, return to Chat and effective Stop PASS. Inputs unchanged,
  host exit 0 and processes reaped; the first failed Agent command is also retained,
  recovered without changing tests, deadlines or requests.
  No old PASS is automatically transferred.
  No closure of vision, the Qwen family or the full plan.
- Prompt: removed the duplicate catalog from the structured 27B path and
  preserved explicit selection during private compilation. Cowork charter
  without duplicating the signatures already emitted by the runtimes. Host/tools
  **15/15**, also ASan/UBSan; main/GLM 10 prompts, Laguna 6, Qwen3.6 and prepared
  Qwen3.8 PASS, with simulated inference. Previous FAILs and missing Qwen3.8
  prerequisites retained. Real replay `run-IfkKfV` interrupted:
  6 PASS, 1 INTERRUPTED, 3 not run. `run-VN7pK3`: Agent and Cowork finish
  and the files pass the oracles, but the gate records 7 PASS, 1 FAIL from the
  CSV verifier, 2 not run. The new oracle accepts CSV inspect only
  with complete cells and correct ordering; it does not accept XLSX metadata, partial
  data or files not reread. Sixteen regressions of the real helper PASS;
  original failures and timeouts retained. `run-jUOR7P` ends **10/10 PASS**:
  Agent 137.2 s, Cowork 234.9 s, return to Chat and effective Stop, inputs unchanged
  and host exit 0. The turn limit remains 240 seconds; a successful run does not
  demonstrate general reliability or erase timeouts. Receipts and fingerprints in
  `qwen27-prompt.9HVCJl`; no P3/P6 closure.
- Focused Metal diagnostics `q36-sync-profile/run-Nd9StF`: same prompt,
  eight greedy choices and full logits identical with/without counters. No
  kernel or numerical check removed. These are tests of instrumentation, not
  Agent quality or speedup. They do not replace a correct baseline and P10.
- P3/P6: fixed Excel read/save receipts, XLSX dimensions
  derived from actual cells and the UTF-8 serialization limit. Office
  **17/17**, document tables **15/15**, bridge/HTTP/preview PASS; C bridge also
  ASan/UBSan. These are not LLM quality tests. Real replay `run-DRYH5n`: 7 PASS,
  1 Cowork timeout after reading the 16 correct cells, 2 not run. Final
  replay `run-MvbQ1F`: 6 PASS, 1 Agent timeout before verification, 3 not run;
  inputs unchanged. Originals and commands in `cowork-read-scope.zKdqdQ`, no
  increase to the 240 s deadline. Qualification and the final app remain open.
- P3/P5: 27B download from Settings connected to asynchronous q36 preparation and
  verification of the two pinned components, without changing the selected model.
  Fixed Stop of the pre-exec child and bound progress/Open folder to the admitted
  store, not the subsequently selected checkout. HTTP **7/7** normal and
  ASan/UBSan, downloader **25/25**, UI functions **18/18**, browser **5/5** in
  each WebKit/Chromium × light/dark combination. Installer/browser bytes
  simulated, process tests real; reuse with verification of real weights is
  separate (`qwen27-download-settings-live/run-C0HYkz` PASS), without new inference.
  Receipts and limits in `docs/QWEN_CHECKPOINT.md` and the ignored checkpoint
  `qwen27-settings.zWoJQm`. New app, mode qualification and all of P5 remain open.
- Real 27B Chat through headless WebKit: latest completed replay
  `q36-host-live/run-GYWiHi` **8/8 PASS**, before subsequent changes
  to the Agent/Cowork connection. This is not the installed `.app` window.
- The local connection now separates the weights server and the DStudio tools frontend;
  no replacement q36 Agent, additional copy of weights or cloud fallback.
  Model PID/generation/lease are also revalidated at RPC delivery.
  Preparation checks the q36 and Agent/Cowork binaries separately.
- `q36-agent-host/run-5QgR9n` **10/10**, `q36-host/run-JdjefV` **12/12** and
  parser/lease **82/82 PASS**, with a simulated model. Real tools and files,
  cancelled/failed launches without losing the previous runtime, Stop, late
  response, server loss and Max at 96k. Repeated with ASan/UBSan host:
  parser/lease 82/82, lifecycle 12/12 (`run-zLkKfZ`) and Agent/Cowork 10/10
  (`run-Z1YUZy`), without diagnostics; simulated inference.
- Network installation and main/q36 build in `qwen27-agent.sZoEZ2` completed;
  existing weights verified and linked, never duplicated. Main pin f62ca29 and
  q36 d67687e. Remote assessment observed newer main `6289c516` and q36
  `d02b6a20`: delta to examine in P2, no automatic promotion.
- Transport updated: ingress 18/18, lifecycle 6/6, stream 61/61 + HTTP
  63/63 + HTTPS 63/63, interruption 36/36 PASS. Receipts in the Qwen checkpoint.
- New real gate keeps the seven Chat checks and adds repair with
  Python tests, Cowork XLSX export reread independently and return to Chat.
  `run-qSbThA` **6/10 FAIL** due to tester submission before readiness;
  `run-K51Sxx` **6/10 FAIL** due to a real turn exceeding 240 seconds. Agent
  fixed the file after a rejected edit, but did not finish/verify within
  the limit. Cowork not run; originals retained, deadline unchanged.
- Diagnostic `run-Pbm6tm` remains **6/10 FAIL** but identifies the lost prefix:
  q36 omits empty-reasoning markers required by the GGUF templates. Patch
  `09bd9201…` fixes the renderer; new Jinja oracle against the native function
  ASan/UBSan: before **14/32 FAIL**, after **32/32 PASS**, on 27B and 35B. This is not
  LLM quality. Main/q36 sources downloaded again and compiled in `qwen27-template.aqfV1K`.
  Native gate `run-NSyTS0` FAIL due to an obsolete image oracle (19 bytes missing
  from the expectation), now corrected with an entire-prompt assertion and a new regression;
  full gate repeated `run-EhGLEr` **36/36 PASS**, images 48/48.
- Normal/diagnostic replays `q36-host-live/run-9G0TiY` and `run-rhl0st`: **7/10,
  FAIL**. Agent actually edits the program and runs the four unchanged tests;
  Cowork reads but does not create the Excel file. q36 interprets the `sheets_json`
  parameter, declared as a string, as an array. The model had produced correct data;
  DStudio validation is not weakened. Two final checks not run.
- Patch `73441ab5…`: schema-guided strings in decoder, SSE and RAM/disk
  replay, plus the upstream test caller adapted in the same `.patch`.
  Common corpus extended: before **27/66 FAIL** (`run-QYwbCB`), after **66/66 PASS**
  (`run-C7PHzU`), ASan/UBSan; no new LLM quality inferred from fixtures.
  Native gate `q36-metal-runtime/run-mxZQJM` **40/40 PASS**. The first attempt
  `run-9TP4TH` remains FAIL due to a test caller not yet updated; no
  test excluded. Jinja repeated 32/32. New main/q36 network installation in
  `qwen27-tools.nvhVvB`; real replay `run-6TDIrp` **7/10 FAIL**: Agent completes
  the four tests in 235.9 s; Cowork now creates the Excel file with correct arguments but
  exceeds 240 s before completion. A subsequent independent oracle verifies
  16 cells and unchanged CSV; the FAIL is not converted to PASS. The last
  two checks not run and cleanup remain separate. New diagnostic
  trace `run-LAUIAW` finished **7/10 FAIL**, without sampling/deadline changes.
  Agent 153.1 s; Cowork fixes JSON with an extra bracket and creates the
  separately verified file (16 cells), but does not finish the turn. Tool
  turns retain cache hits. The two runs are not a performance comparison.
- New GSA/RSA host regression: `q36-agent-host/run-QEnrMH` **2/15 FAIL**
  reproduces Max accepted at 8k through `/api/agent/send`. Fix shared
  with startup, before admission, repeated at every graph dispatch; original
  request also preserved for Goal and resumption on a different runtime.
  First candidate `run-ZJ01pq` **12/15 FAIL** finds another defect: Bash's
  ANSI code before the RS frame prevents Goal from accepting a verification
  that actually succeeded. Decoder aligned with the host reader's framing, with regressions
  for interrupted/unknown outcomes, timeouts, failed commands and misleading stdout.
  `run-u2Dq20` **13/15 FAIL** then finds a search for the clarification marker
  beyond the buffer's current length: fixed with a copy of the attempt alone
  and four cases of residual bytes/missing terminator/interleaved events.
  After the first normal and sanitizer 15/15 results, `run-XohLVt` **4/15 FAIL** documents
  the strengthened budget test: a rejected context must not consume turns.
  Preflight now also runs at start/resume, before the journal; revalidation retained
  at dispatch. The same Goal finishes after valid context is restored.
  Final normal host gate `run-3bbPe3` **15/15**, ASan/UBSan host `run-2nXmmo`
  **15/15**; Task Graph 2,556 and Goal pass normal and sanitizer runs; q36
  lifecycle 12/12 (`run-46qbcK`), parser 82/82 sanitizer. Task Graph HTTP, preflight
  28/28, launch-control 11/11 (`http-7TSTiC`) and spawn 16/16 PASS. Simulated
  inference, no additional LLM quality. The Goal unit test now uses the real
  WAITING reader instead of omitting the mandatory terminal receipt;
  failures and commands retained in `qwen27-admission.atwL6u`.
- All of P0–P11 remains required, including the 11/12 quality FAIL. No newly
  installed app, closure of the Qwen family or publication is inferred
  from this connection. Bundle still from September 8 at 14:01:10 CEST.

### Resumption of the full plan — September 8, 2026

- The active objective is now to **implement the full PLAN.MD**. The old Qwen
  pause below is historical: P0–P11 remain in scope and are not replaced
  by the slice covering only the two Qwen models already present.
- Receipts recovered after interruption: the replay process is no longer
  active and `qwen38-host-live/run-xdrRmf/results.json` records completion
  at 23:58:52 UTC on September 7, Agent/Cowork **2/2 PASS**. Reset interrupted,
  previous context preserved, reset completed and files reread; no
  increase to the 15-second Stop limit.
- Patch 92 and `ds4-qwen38-prepare/prepare-empty.patch` allow discarding
  only the private reset session between GPU layers. No change
  to chunk, context, precision or the meaning of the live checkpoint.
  `qwen38-prepare-live/run-8t4x4R`: eight real checks PASS, state/logits
  byte-identical across 8,193 tokens and eight decodes. This is not general quality.
- `qwen38-host-live/run-8zpOrR` remains FAIL: Cowork Stop beyond the deadline;
  the tester had also not prepared the vision patch before freezing
  the source. Preparation complete in the new replay, immutability check
  unchanged. The preceding FAIL at `82d0314` on tool selection remains separate.
- Deterministic resets: `agent-session-reset/run-Md5AYw` 7/7 Qwen3.8,
  `run-kpWPiQ` 6/6 Qwen3.6; sanitizers on the adapters, simulated inference.
  Migration of the five patches: `agent-patch-migration/run-ykhUI1` PASS.
  Native apply/repeat/restore/drift/partial/symlink lifecycle: PASS on
  b4c3550, 0bb323a, 66b0e3f, 82d0314 and b85a617. Old bd9cfbc is
  rejected without changes; user upgrade still requires qualification.
- The user's latest explicit rebuild is documented in
  `qwen-app-rebuild.fP2MPq/BUILD-RECEIPT.md`: bundle and focused gates PASS,
  patch 92 included, executable `90a5f53c…`, compiled at 09:39:40 CEST
  on September 8. The two installed copies are
  updated; the previous copies preserved. No model started or engine
  updated. Previous rebuilds `Fpb7JM`, `p30oMP`, `BvnwvV` and `Zl9MhG`
  remain in the history.
  The subsequent P3 slice does not replace or restart these copies; installed
  engines are not updated by rebuilding alone.
- New remote check on September 8: main f62ca29 and
  Laguna 448d569 unchanged; Qwen3.8 b85a617; Qwen3.6 upstream now
  `73434c4bb9d8bb18425a2577edada69d25d44c47`, ahead of pin
  60fca11f. The subsequent comparison result is recorded below; no
  automatic promotion.
- P2.10: implemented Git/delta/patch/receipt checking and native command
  `--engine-pins`, using the same source definition as the installer.
  The gate reads the bundle binary and precedes the `dist-macos` archive;
  it does not run on normal `.app` rebuilds. Initial matrix of 39
  platform/backend/checkpoint targets; rows are requirements, not established support.
  Windows publication still needs to be connected to the gate.
- The new Qwen3.6 delta was read in full: only
  `dynamicmoeinference.md` changes; the other 1,525 Git entries are identical. Publishable
  receipt `docs/upstream/qwen35-2026-09-08.json`. The two commits are
  classified as unrelated to execution; no external runtime linked from
  the document is imported or started. The installation pin remains 60fca11f.
- Six isolated Git checkouts and real checking in
  `engine-upstream-alignment.amPJQV`. `admission-3.json` ends FAIL as
  expected: 39 targets retained, 510 gates without a receipt, 2,155
  commit/target review cells still missing, two differing installer pins/URLs and
  three 27B targets without an installer. These are qualification gaps repeated
  per combination, not 2,672 new inference errors. No old PASS
  rewritten or green wrapper added to historical tests.
- Verifier gate with local Git, real conflicts and fixture
  publication: `engine-upstream/run-1YWEXh` PASS (48 cases). RED
  `run-wPgECE` reproduced contamination from external Git variables,
  fixed in the verifier; `run-GqYGbh` retains a fixture error
  in the ZIP path, corrected without changing the publication recipe.
  Complete totals even beyond the 1,024-detail limit; no failed
  target disappears. A Windows result cannot qualify macOS/Linux.
- Native metadata command: `engine-pins/run-8DJPp7` 4/4 PASS and
  `run-IR3wlM` 4/4 with the actual desktop executable relocated to a path with spaces.
  Isolated bundle build and smoke in `metadata-check/` PASS; installer,
  Qwen3.6 runtime fixture and 34 simulated session capabilities PASS.
  No model or user app started/stopped. This is not P6/P7 completed.

### P1/P3 — checkout and Metal 27B candidate, September 8

- The rebuild turn is **packaging progress**, not completion of the
  plan. The newly delivered app remains unchanged during this slice.
- Chat/Learn: repairing an engine path updated the store but
  left the captured request stale. REDs retained in
  `chat-checkout-readiness/run-fxO0zg` and `run-Y6tBQt`. Each consumer
  now receives only the repaired path/revision, preserving its own question, sampling,
  context and thinking; Stop and A→B→A selection remain invalidating.
  Rebuild `g4ZOea` includes the fix: readiness 12/12, binding 16/16,
  checkout 9/9 and scroll 5/5; commands and receipts in BUILD-RECEIPT.
- Learn/Tutor browser with simulated engine and three moved checkouts: Qwen3.6
  WebKit `roadmap-browser/run-kGbzcj` and Qwen3.8 Chromium `run-07chjX` PASS
  on the latest UI. Qwen3.8 WebKit `run-DdRHp1` precedes the latest queue fix.
  These are not real quality or the `.app` window's P7 matrix.
- The clean q36 Metal build `d67687ed…` failed because MRoPE was not implemented
  (`qwen27-bootstrap.dvAtNW/build-metal.log`). The first implementation
  fails 4,320 comparisons, maximum error 0.0192851; the attempt with
  `precise::pow` alone also remains FAIL. Precise trigonometry reduces the error to
  1.19209e-7, without expanding the original `1e-5` tolerance.
- Assessment correction: `q36_engine_uses_vulkan_runtime` already includes
  Metal. The name and message were misleading; MRoPE and the encoder's
  GPU operations were missing, and it used CPU matmul/attention. The
  [q36 patch](patch/q36-metal-runtime/README.md) now completes those
  operations. The shared span path still needs testing with an LLM.
- A single atomic `runtime.patch`, pinned ABI, F16 weights reread from fd/offset,
  FP32 activations, 64 MiB scratch (128 MiB transiently during resize),
  1,024 patches and output preserved after failed reads. Command-buffer
  allocation outside the mutex; barrier for blocking, duplicates and stale
  candidates. Full P10 profiling remains open.
- The attempt with two dependent patches did not apply to the clean base:
  `q36-metal-runtime/run-VgerGU` retains the FAIL and inputs. The single delta
  passes lifecycle, drift/partial/ABI/symlink checks, real build and operators;
  upstream precompiled binaries were not used.
- Downloaded only the F16 projector: 927,607,488 bytes, HF revision
  `4ca720788d1e01f1bff70c033e0d0028fd02e502`, SHA-256
  `cbb841a9ee0636b2ec172f5bb8df2ea8dfeb01e90fe7c6126581d662a0b4e43e`,
  in `qwen27-vision.LOCdEp`. No new LLM weights.
- `make test-q36-metal-runtime Q36_SOURCE=… QWEN27_PROJECTOR=…`:
  `q36-metal-runtime/run-ZOk4i9`, **17 phases PASS**, frozen inputs.
  Operators against independent scalar oracles; **two RGB inputs with a real
  projector** against the native scalar encoder. Maximum embedding error 0.00170898
  within 0.01; maximum relative L2 2.60071e-5 within 5e-4. These are not model
  answers or visual quality; numerical comparisons are not LLM questions.
- Installer/catalog/doctor, 27B weights, text/vision inference,
  KV sessions/cancellation, four modes, quality and CUDA/Vulkan remain open.
  No P3/P4/P6/P7 closure, push or update of the user's app.

### P3 — 27B installation and numerical regressions, September 8

- The preceding turn is verified packaging progress; the new app has been
  delivered and remains unchanged during the work described here. All of P0–P11
  remains open until its respective criteria are met, not replaced by Qwen alone.
- 27B downloader pin/hash, resume, byte limit, single leader and
  no-clobber publication: 21/21 real HTTP/filesystem tests with fixtures. The tester's first
  two errors on `/var` and `/private/var` paths remain retained; new
  regression for the same file reached through an alias. No oracle relaxed.
- Installed Q6_K_XL, 25,299,061,664 bytes, SHA-256
  `701d8fa9ed214ab21bfc130cd2a7df19ca89bbef7713e2dfb19f3c63696aa917`,
  HF revision `4ca720788d1e01f1bff70c033e0d0028fd02e502`. F16 projector
  reused without duplicating its bytes. No other LLM family downloaded.
- q36 CLI installer: bounded private preparation, verified archive,
  atomic patch, forced build and source/patch/binary receipt; fsync before
  publication without replacement. Reapplication verified, checkout with
  drift preserved; fixture gate 12/12. Real gate `engine-acceptance/run-49XS30`
  starts empty, downloads from the network and compiles the current patch. Setup PASS,
  not quality or the full P5 upgrade matrix.
- First actual Q6/Metal `engine-acceptance/run-AFZhdJ`: **FAIL, 1/12**; only the
  malformed request is correctly rejected. Corrupted answers, wrong model name
  and all failures retained. The tester's process terminated,
  and was not relaunched merely because an observation period expired.
- Native diagnosis in `qwen27-numerics.5si6Od`: CPU with nonfinite data and 26
  failed asserts in the trajectory comparison. Isolated quantized
  Q4/Q5/Q6 rows pass; this does not qualify the complete model.
- Reproduced and fixed in the `.patch`: CPU FFN input reinterpreted as
  another quantization format; Q extraction, V extraction and Metal
  convolution history still sized for 35B; HTTP identity of 27B.
  CPU RED `q36-dense-quant/run-tuSG1X`, 30/75; Metal RED `shape-red-runtime.log`,
  21 errors. Initial harness errors (symbol and cwd) also retained.
- Current gate `q36-metal-runtime/run-jMFlvY`: **21 phases PASS**, lifecycle of
  all five files, native build, 75 CPU ASan/UBSan, real HTTP with three model
  fixtures, Metal layout and F16 projector. No tolerance change.
  Subsequent repetition of numerics/answers with real weights is a separate gate.
- The DStudio catalog temporarily rejects 27B and recognizes its projector
  as a component, instead of sending them to the DeepSeek engine. This does not replace
  the required integration: lifecycle/catalog, image server (HTTP handoff
  to the vision core missing), DStudio Agent/Cowork adapters, Learn, numerics/100 cases,
  desktop and CUDA/Vulkan remain incomplete. The block is not a final
  support decision or a reduction of the requested family.

### P3/P6 — real images and cancelled admission, September 8

- The newly completed rebuild is verified progress, not closure of the goal.
  The new 08:30 app remains unchanged during this slice; all
  P0–P11 requirements, including other engines/modes/backends, remain in the plan.
- Already completed numerics recorded: `qwen27-numerics.5si6Od/parity-after.log`
  passes three prompts, nine CPU/Metal steps and twelve quantized-row checks.
  HTTP replay `engine-acceptance/run-aJmoWY` passes 11/12, not 12/12:
  the Python answer is `10` instead of `16`. `run-yOjMQq` retains the error both
  cold and after other turns. Probe `q36-request-parity/run-wtdYbQ`, using
  the real HTTP parser and CPU/Metal cores, finds numerical agreement but two
  equally wrong answers. It remains FAIL; no architectural equivalence inferred.
- Four original PNGs without informative text/metadata pass through decoder,
  F16 projector, spans and Metal LLM: colors and left/right ordering, then return
  to text. `q36-vision-session/run-QQLVls` retains a grader false negative
  for the space after the comma, allowed by the prompt. Corrected with 28
  regressions; all eight outputs are regraded in a new receipt
  `q36-vision-session-regrade/run-mfAjdw`. The subsequent replay actually
  executed, `run-tLBw0g`, passes 8/8; this is not the held-out 30-PDF/20-image corpus.
- Reproduced another defect: an already cancelled sync clears the state before
  checking. RED with real weights `q36-vision-session/run-Sf3DkD` fails
  in all four text/image combinations, while preserving the eight
  correct answers. `q36-cancel-admission/run-eixygn` reproduces 20 failed asserts
  in 24 scenarios with ASan/UBSan; the preceding fixture compilation error
  `run-Hr2VDb` remains separate, and is not an engine bug.
- Fix in `.patch`: validation and pre-cancel check before reset or
  cache hit. Patch `61843ae655b11f74016100d440b84d057c6b3728ff61e9a0674bec4083694055`;
  remote q36 pin confirmed `d67687ed15ad9f52b755a9b5fdfc0214ea937555`.
  No change to kernels, sampling or numerical oracles.
- New network installation `qwen27-cancellation.jDoZoT/fresh install/q36`;
  the first command without a root directory is a prerequisite FAIL retained in
  `install.log`; `install-retry.log` records download/build/publication PASS.
  Installation `engine-acceptance/run-49XS30`, used in the real REDs, remained
  unchanged; changes were prepared in the working candidate checkout.
- `q36-metal-runtime/run-o5XhJV`: 22 phases PASS, lifecycle of the patch's five files,
  75 CPU compositions, 24 ASan/UBSan admission scenarios, Metal operators and
  projector. `q36-vision-session/run-gfJtza`: four pre-cancels preserve tokens,
  position, vision state and full logits; eight answers still PASS.
- Explicit limitation: this slice does not resolve cancellation during
  prefill. Private preparation and owner-side publication are needed in the
  HTTP/app path. The server image handoff, catalog/lifecycle and
  all DStudio 27B modes, broad quality and other backends are still missing. No
  different model downloaded, user process stopped, push or additional rebuild.

### P3 — HTTP image transport and private session, September 8

- The preceding turn is **verified packaging progress**: manual rebuild
  at 09:39, receipt `qwen-app-rebuild.fP2MPq`. P0–P11 remain intact;
  no implicit 27B promotion or further app replacement.
- The parser lost pixels: RED `q36-http-vision/run-ys7psO`, 1/5 PASS.
  Native OpenAI Chat PNG/JPEG handoff, typed byte positions, image ordering,
  limits of 8 images/8 MiB each/32 MiB aggregate; incompatible inputs rejected.
  No arbitrary URL download or invisible conversion to text alone.
- Images and the vision → text return prepare a single candidate session,
  with the same weights and context. Encoding/sync outside the lock; publication
  after identity/context/stop revalidation, private callbacks and release outside
  the mutex. Metadata reads immutable context, not the replaceable session.
  No text-only cache associated with pixels.
- First real HTTP `q36-http-vision-live/run-rqYyfG`, 13/13. TCP extension:
  deterministic REDs `q36-http-vision/run-Y4vEw1` and `run-WJYuHa`, 44/45;
  real model `q36-http-vision-live/run-rCNL7p`, 14/16. macOS also reported
  POLLHUP for legal SHUT_WR, misinterpreted as cancellation. Now checks
  the actual socket error; the tester also observes the worker terminated before
  the barrier. No deadline increased or oracle weakened.
- q36 remote rechecked, `d67687ed…` unchanged. New network installation
  `qwen27-http-halfclose.aNqNx7/q36`, patch `5904134e…`, server `750771ac…`.
  Gate `q36-metal-runtime/run-ySicfJ`: 23 phases PASS, including 45 HTTP tests with
  ASan/UBSan (9 ownership cases with simulated worker), lifecycle and real projector.
  Real replay `q36-http-vision-live/run-wRCPws`: **16/16 PASS**, same inputs
  and oracles; JSON/SSE after half-close, colors/order, invalid decoder and recovery.
  Test processes terminated; no different inference, weight download or push.
- Compiled arm64 layout: request 160 → 168 bytes, message 56 → 64,
  job 296 → 312; server 800, slot 216 and HTTP request 280 unchanged.
  Probe and results in `qwen27-http-halfclose.aNqNx7`. These are limits/layout,
  not a speed benchmark or a result on the held-out dataset.
- Stop by request ID and DStudio control, transactional text → text prefill,
  pressure/admission and persistent cache, catalog/lifecycle,
  tools/Learn/Cowork and desktop/quality/backend tests remain open. FIN alone does not prove
  client abandonment. Batch vision and Anthropic/Responses images still
  rejected, not qualified by the OpenAI single-session path alone. This does not close
  P3/P4/P6/P7 or the full campaign.

### P3 — request identity and native cancellation, September 8

- The preceding turn is **verified packaging progress**: requested rebuild
  at 10:05:30, receipt `qwen-app-rebuild.lcS8Ym`, executable `4144f205…`.
  That app remains unchanged and is not launched. The P0–P11 plan remains whole.
- The q36 server admits a unique ID per attempt before the body, with 16
  generation leases and four additional threads bounded for headers/controls.
  Stop by ID: upload and queue interrupted, other turn preserved, ID removed
  before releasing the job. `202` means cancellation requested, not
  confirmation of completion or undo; `404` is not success.
- Atomic flag read by the worker and rechecked by the candidate session's
  owner; lookup/publication bounded by active count and 64-byte IDs.
  I/O, parsing, inference and release remain outside the mutex. Headers/bodies
  with ambiguous framing or beyond limits are rejected before expensive work.
- Also reproduced a complete tool emitted after an error: parser fixed to
  preserve failed bytes without delivering them as an executable call.
  RED `q36-http-control/run-6fs9Dp` (0/3), failed iteration `run-zrVSbM`,
  tool RED `run-4ZFZSg` (8/9). Final `run-Boknx2`: 9/9 scenarios, 103 asserts,
  ASan/UBSan, real HTTP over sockets and simulated tokenizer/worker where declared.
- New real installation `qwen27-http-control.KX03QB/q36`, remote pin
  rechecked `d67687ed…`, patch `586c4f5b…`, server `9358a1d5…`.
  Gate `q36-metal-runtime/run-eb8vLH`: **24 phases PASS**, including 47
  HTTP/ownership scenarios (`run-Ctmrcs`), native control, patch lifecycle and projector.
- Replay with the same real 27B/projector and settings: RED **19/21** in
  `q36-http-vision-live/run-VltcsY`; GREEN **21/21** in `run-g7fUZ8`.
  All preceding cases remain; new cases for upload, cancelled images,
  text resumption and completed identity. Both processes exited with code 0.
- arm64 layout versus the preceding slice: server 800 → 816 bytes,
  job 312 → 336; request 168, message 64, slot 216, HTTP request 280 unchanged.
  Opt-in mutex probe with 1/8/16 fixtures, 128 repetitions and recorded timer
  limits; no throughput claim or benchmark published. The four
  metadata requests during real vision took 2.1–3.6 ms.
- Still to do: transactional/cancel-cooperative text prefill, terminal races
  and DStudio Stop wiring, sustained pressure, persistent cache, 27B lifecycle/catalog,
  tools and four modes, vision/PDF and broad numerical/quality corpus,
  desktop and other backends. `q36_session_save_snapshot` saves tokens and recomputes:
  it is not equivalent to cloning KV/GDN. No P3 closure or reduction of the rest of the plan.

### P3 — native text and payload preparation, September 8

- The preceding turn is **verified packaging progress**: rebuild at
  12:02:51, installation at 12:04:32, `qwen-app-rebuild.cacLYD/BUILD-RECEIPT.md`,
  executable `b1f855ab…`. This app remains unchanged during the new slice.
- Text preparation in a private session with shared weights: copy
  of active KV/GDN/logit state and the same native boundaries, without precision
  conversion or context reduction. Payload restoration adds a
  private session with reads of up to 64 KiB between cancellation checks.
  Invalid headers/tokens/configuration, short reads and memory failures
  preserve source and output pointer. Token-only payloads keep
  native replay; they do not acquire full KV snapshot semantics.
- External changes entirely in `patch/q36-metal-runtime/runtime.patch`,
  SHA `4653d679…`, manifest updated. Remote q36 pin rechecked and unchanged
  `d67687ed…`. New network installation `qwen27-payload-prepare.S05oAQ/q36`,
  server `16ac1e4c…`, no change to engines already installed by the user.
- `q36-metal-runtime/run-7P1jrx`: **28 phases PASS**, complete patch cycle, real
  build, Metal operators/projector and CPU sanitizers. Payload `run-Tx5GOH`:
  9,745 scenarios, 48,504 asserts, no native allocations left behind; text
  `run-gfdu33`: 1,926 scenarios, 4,014 asserts and copy cost proportional to
  active tokens, not capacity. These are not CPU forwards or MTP/Vulkan parity.
- Original direct-payload RED `run-AFtq5Q` retained: 10,585 failed asserts
  in the first corpus revision. No oracle made more permissive.
- Real corpus extended with the same 27B weights: baseline
  `q36-text-prepare/run-ZEWZsd` **2/13**, new `run-MYoJb3` **13/13**.
  Seven text and six payload cases, including the final byte missing and Stop after
  the final byte; all require four subsequent decodes, complete state and
  finite logits byte-identical to the native reference. In-memory FILE, not
  an SSD benchmark or independent architectural reference.
- New installation's image HTTP `q36-http-vision-live/run-8QWeCd`:
  **21/21 PASS**. Installer fixtures 12/12 and upstream checker
  `engine-upstream/run-eIVJWg` PASS; not release-matrix admission.
- The private restore API is a prerequisite, not yet the consumer of generic
  HTTP cache load. Migration must keep sampled tokens/BPE,
  prefill, cold/continued cache, tool replay and owner publication together;
  I/O/inference cannot remain under the existing cache/tool locks. Therefore
  host Stop, 27B lifecycle/catalog, tools and modes, broad quality,
  desktop, other backends and the other chapters of the plan remain open. No push, new
  app or weight download; only tester processes were started/terminated.

### P3 — tool recovery in the HTTP worker, September 8

- The preceding turn is packaging progress requested by the user: build
  12:47:14 CEST, installed copy verified at 12:49, receipt
  `qwen-app-rebuild.RHX0X1/BUILD-RECEIPT.md`, executable `f78960f5…`.
  The app remains unchanged during this slice; P0–P11 remain incomplete.
- The single-session worker now owns cache and tool recovery. HTTP
  clients validate without modifying their LRU/content; the worker resolves IDs from
  the captured body using the OpenAI/Responses/Anthropic parser. Moves only
  derived rendering, preserves sampling/model/limits/stop sequences and checks context
  against the exact prompt. Cache/tool I/O and trace do not hold those shared locks in
  the single-session path. No growth in server/job/request/slot records.
- External changes exported in `patch/q36-metal-runtime/runtime.patch`,
  SHA `4c43f699…`, q36 base `d67687ed…` and manifest updated. Separate
  network installation `qwen27-http-replay.kNhpDS/q36`, server `543cb290…`.
  No changes to the user's engines or already verified weights.
- HTTP/control corpus with sanitizers: baseline `run-9nv6Ad` **9/16**,
  candidate `run-YersA0` **16/16**. Intermediate candidate `run-dia8n7`
  passes 15/16 and identifies trace still under lock, subsequently fixed. Tokenizer
  and worker are simulated; sockets, parser and output FILE are real. Preceding
  receipts remain, including the initial fixture that did not distinguish native
  whitespace: input corrected on both variants, asserts unchanged.
- Complete gate `q36-metal-runtime/run-rrgf3z`: **28 phases PASS**, including
  Metal build/operators/projector and full patch cycle. Installer fixtures
  **12/12**, upstream checker `run-rfM0gF` **48/48**; not release admission.
- Sequential real inference: `q36-http-vision-live/run-j4TKTA` **24/24**
  OpenAI; expanded corpus `run-TeqqR4` **28/28**. The model actually generates
  `read_file`; reading private files with different contents, exact answer
  in all three API formats and native RAM-replay trace. All 21
  image/cancel/recovery cases remain included. The second corpus also checks
  exact capitalization, without increasing timeouts. This is not DStudio Agent or
  a performance benchmark, held-out quality or disk replay.
- Next work unchanged: private preparation of the entire textual HTTP request,
  including cache load, sampled tokens/BPE and cold/continued checkpoints;
  then lifecycle/Stop/catalog wiring and Agent/Cowork/Learn 27B tools.
  Limits/cancellation for disk tool recovery and batched
  paths with I/O under lock also remain open. These are not accepted architectural exceptions.
  The 11/12 language FAIL, other backends, desktop and every other phase
  remain open. No push or new app in this slice.

### P3 — HTTP text/cache transactions, September 8

- The user-requested rebuild is packaging progress, not closure of the
  goal: receipt `qwen-app-rebuild.diofB9/BUILD-RECEIPT.md`, binary `ca5b916f…`,
  installed at 14:02:19 CEST. During this slice the delivered copies,
  user's engines, weights and settings remain unchanged.
- The single-session HTTP worker prepares the entire textual prompt on a private
  session: native fork without forward, exact token/BPE prefixes, private payload
  restore, complete prefill and cold/continued checkpoints. Publishes after checking
  Stop/shutdown, session identity and context. Failure and cancellation
  do not replace the session, counters or previously published files.
- Private temporary checkpoints: maximum 64, no more than the configured disk budget
  with an 8 GiB ceiling, duplicate destinations coalesced. Counting uses the tool bytes
  actually serialized, not those deduplicated in RAM. A rename error does not
  advance the saved frontier. The cache is derived and retains upstream's lack
  of fsync: atomic publication does not mean durability on power loss.
- The payload writer now checks Stop at least every 64 KiB, including after the final
  byte. Token-history reservation is recoverable before forward;
  preparation must not terminate the process because its allocation failed.
  All external changes are in patch `c392ca1a…`, base `d67687ed…`,
  installed from the network in `qwen27-http-transaction.mSaZzr/q36` without overwriting
  existing checkouts. Frozen server `c70cc99f…`.
- Gate `q36-metal-runtime/run-32JrVf`: **29 phases PASS**, including full patch
  lifecycle, Metal build/operators/projector, 2,070 text cases and 9,757 payload cases
  with sanitizers. HTTP/control 16, images 47, text/cache transactions 24.
  The old server passes **3/24** (`run-xrAbiU`); the candidate **24/24**
  (`run-u8wJ2F`). Intermediate RED **23/24** (`run-BOrIUG`) reproduced
  undercounting of serialized tool blocks and remains retained.
- The **13/13** native checks with real 27B were rerun on the current
  patch (`q36-text-prepare/run-ZPQJ3L`): finite payload/logits byte-identical,
  cancellations including the final byte and four subsequent decodes per case.
  These are not answer quality or speed benchmarks.
- First real HTTP/cache **32/33** (`run-lNVzga`) retained. The final test
  incorrectly required a RAM hit when the renderer omits empty thinking
  from history. The new check without Stop reproduces that different prefix;
  continuation after Stop must preserve all eight native
  frontier/cache-choice fields and the exact answer. First corrected corpus **34/34**
  (`run-qE4rPn`), with all 28 preceding image/control/tool cases included.
- Final comparison with the same frozen harness: candidate **34/34**
  (`run-0Zm67V`), preceding **31/34** (`run-Yu1RjC`). Stop was actually
  sent to both: candidate 1.24 s with the same five checkpoints,
  preceding 34.65 s, HTTP 200 instead of 499 and eleven files published instead
  of the initial five. These are individual diagnostic observations, not a throughput
  benchmark. The first baseline `run-yFScLN`, also 31/34, remains separate:
  it waited for a private phase absent from the old server and had not sent Stop.
  Corrected synchronization observes the native checkpoint on both
  variants and retains the private-publication assertion and the same timeouts.
- arm64 layout measurement: server/job/request/slot records unchanged; progress from
  104 to 112 bytes, pending header 48, node 40 plus bounded paths. This is not
  P10 latency profiling. The heavy test remains sequential and yields
  resources by stopping only its own engine if the user starts the app or a model.
- Next connections: q36 host lifecycle/catalog/Stop and explicit local transport
  for the DStudio Agent/Cowork loop, then Learn and vision/PDF. The tool replay
  source also requires semantic checks of name/arguments/count and
  order, as well as ID. Private probe `tool-replay-identity.c` reproduces
  **4/6 FAIL** on both the clean upstream pin and the candidate: the same ID can
  cause the old block's name/path/arguments to be reinserted in place of the new ones.
  No tool is executed by the probe. The defect must be fixed and made a
  permanent regression before promoting that adapter.
  Cancellable/bounded tool scans, batched synchronization,
  11/12 language FAIL, independent numerical reference, other backends
  and all remaining P0–P11 acceptance tests remain open. No push or new app in this slice.

### P3 — semantic tool replay identity, September 8

- The preceding slice is verified progress: native 13/13 and HTTP/cache
  34/34, with a new defect reproduced on tool IDs. It was not closure
  of the plan.
- Fixed reuse of old text when the same ID arrives with different tools,
  arguments, types, call counts or ordering. Equivalent JSON objects
  may reorder fields, including nested fields; arrays, large integers, types and positional
  IDs remain distinct. Ambiguous JSON, lossily decoded surrogates
  and unrelated text/reasoning before the block do not authorize a hit.
- The reader retains a reference to the immutable block and prepares outside
  `tool_mu`; before publication it rechecks block, generation and
  position of each ID. Replaced or evicted mappings cannot publish
  old results. Evicted blocks still being read remain in the byte budget;
  the last reader releases them outside the mutex. Tests with deterministic barriers
  prove overlapping preparations and cache-owner availability.
- Optimization limits: 128 calls, 256-byte IDs, 1 MiB of arguments
  and sampled text, 8,192 comparison nodes and depth 64. Beyond the limit,
  the renderer preserves all received calls. The v1 disk map continues
  to recover single calls, but does not invent missing group positions
  or claim ambiguous IDs recovered. Complete group persistence still open.
- All external changes are in patch `6b7f295b…`, still on
  `Ninnix/q36 d67687ed…`. New empty network installation
  `qwen27-tool-identity-final.tsfrhX/q36`, server `61014765…`;
  preceding checkouts, weights, settings and the delivered app are unchanged.
- Permanent regression `test-q36-tool-replay-identity`: **93/93 PASS**
  (`run-UzuU0g`), preceding c392 **22/93** (`run-7gypfj`), same frozen
  harness `53bc1ddb…`, ASan/UBSan. Includes real disk maps, structured
  comparisons, limits and four concurrent scenarios. It does not execute a model/tool.
  Initial receipts remain: 12/52 from the preceding version, initial corrected 52/52,
  and the two unrelated-prefix failures found in the subsequent iteration.
- Two upstream tests assumed replacement of a different command or
  reinserted omitted arguments. Positive disk round trips retained and
  negative verification added; the old crashed test remains in receipt
  `native-server-old-oracle.log`. No checks or timeouts removed.
- Complete gate `q36-metal-runtime/run-IKF6tM`: **30 phases PASS**, apply/repeat/
  restore/partial/drift/symlink, real Metal build/operators/projector, native
  and HTTP suites with sanitizers, inputs unchanged through completion.
  The 12 behavioral installer checks also PASS again;
  they do not replace the network installation performed separately.
- Real 27B Metal, with the same weights and settings: **34/34 HTTP/cache PASS**
  (`run-aLM8rI`), including tool/result in the three API formats, images, SSE and Stop.
  Stop 1.25 s in this single test; this is not a decoding benchmark or general
  quality. Test process terminated and handle collected; no user engine stopped.
- arm64 layout: block 48 bytes unchanged, ID entry 64 → 72, cache 72 → 80,
  server 816 → 824; job/request/slot unchanged. Opt-in profile of the real reader,
  128 repetitions on 1/16/256 KiB and ceilings 128/100,000 with only one active ID:
  same resident bytes and 256 critical sections per row. Comparison times
  grow outside the lock; finite-resolution clock, no claim of zero cost
  when it measures zero. Private receipt `tool-replay-profile.json`; this is not
  P10 qualification or a public benchmark. Public charts remain Matplotlib.
- Next actual work: recoverability of parser/cache allocations,
  ordered group persistence, bounded/cancellable tool scans and
  migration of batched writers, which still allocate/scan/perform I/O
  under lock. These are not accepted exceptions. Then q36 host connection and
  local adapter for the DStudio loop, Learn, PDF and the other P0–P11 acceptance tests.
  The 11/12 language FAIL and all quality/desktop/backend gates remain open.
  No push or new bundle in this slice.

### P3 — persistent tool groups and cache writer, September 8

- The preceding turn is classified as **progress**: it introduced the group
  format and reproduced 19 errors out of 36. In this resumption, terminated
  handles were collected and actual files checked; no duplicate process.
- Map v2: group text saved once, IDs with ordinals, recovery after
  RAM release, same semantic check before replay. Single v1 maps
  remain readable; no ordinals invented for ambiguous v1 groups.
  A historical ID does not replace a current RAM mapping. Complete private parsing
  before admission prevents partial imports of corrupted files.
- Two specific bounded indexes replace root allocations under
  `tool_mu`: lazy tables totaling 256 KiB, chains of at most 32 entries and a plan
  of at most 64 evictions. Preparation/allocation/capacity failures
  preserve previous entries. ID copies in blocks of 16; hashing, text
  comparison, allocations, writes and retirement outside the tool-cache mutex.
  Issues with the outer disk-catalog mutex remain separate and unqualified.
- A single snapshot for budget, flags and serialization. Maps: maximum 64 MiB,
  4,096 groups and 100,000 IDs; replacement file at most 8 GiB and always within
  the configured budget. No early truncation: temporary write,
  file and mapping recheck, rename. No fsync guarantee stronger than upstream's
  cache is invented; user journals are unchanged.
- Reproducible patch `2ea07d80…`, q36 pin `d67687ed…`. New
  network installation `qwen27-tool-map-final.kTOaoN/q36`, server `586bf7c1…`.
  Preceding user checkouts, models, settings and bundle preserved.
- `test-q36-tool-map`: **84/84 PASS**, `run-6CnyhY`, sanitizers. Includes
  an exhaustive case with 247 truncation points, duplicates across groups,
  allocations and limits, concurrent/stale candidates, digest collisions,
  blocked writes and changed destinations. The common
  36-case corpus failed 19 checks before the fix; no FAIL lost.
- Complete gate `q36-metal-runtime/run-zREUQa`: **31 phases PASS**, including
  **93/93** semantic checks (`run-LIBRjR`), real operators/projector, patch lifecycle,
  clean build and immutable hashes. The gate also rechecks the inputs of
  the two tool suites at the end, in addition to their individual receipts.
- The disk-budget oracle now checks the bytes of the v1 or v2 format actually
  produced: **24/24 PASS** on both the preceding version (`run-W9zHLU`) and the candidate
  (`run-Ic13Hz`). The one-byte-too-small limit and absence of writes
  remain unchanged; `run-mveaXo` retains the FAIL from the old RAM/disk assumption.
- Real 27B HTTP/cache replay: **34/34 PASS**, `run-cfxg9H`, same Q6_K_XL and
  projector, context 8,192, F16 K/V, chunk 128, four threads, greedy/thinking
  Off, expert streaming Off, 4 GiB disk cache. Stop 1.39 s in this test;
  five preceding files unchanged. Test PID terminated and collected. This is not
  general quality, independent numerics or desktop Agent.
- Opt-in `--tool-store` profile, 128 repetitions per 1/16/256 KiB and ceilings
  128/100,000: bounded tool lock, but greater total preparation time.
  Both results retained; no inference speedup claimed.
  arm64 layout: entry 72→88, block 48→96, cache 80→72, server 824→816 bytes.
  Evidence and commands in the new installation's private checkpoint; benchmark/
  Matplotlib publication and full P10 remain separate.
- Next work: batched disk catalog (both `kv_mu` and outer `inference_mu`)
  and cancellable scans, recoverable
  parser, then host integration of the q36 server through the DStudio loop
  (not `q36-agent`) in Chat/Agent/Cowork/Learn. The 11/12 language FAIL remains,
  27B is not selectable and P0–P11 is not complete. No new bundle or push.

### P3 — separable GPU serialization, batched gate still failed

- The preceding turn is **progress**: the new test reproduced blocked
  decoding during cache writing. Terminal receipt
  `q36-cache-owner/run-T8XRNP` recovered, **FAIL** with 7 asserts out of 26;
  no process left active or relaunched because an observation period expired.
- The problem remains in the server: `kv_mu` and `inference_mu` enclose I/O,
  catalog and GPU reads. The new native API
  `q36_session_save_payload_scheduled` separates GPU reads bounded to 64 KiB
  from writing. The session remains immutable and exclusive to its owner;
  paired callbacks acquire/release the backend for reading only,
  with release also after errors or cancellation. No copy of the entire KV.
  The preceding API remains the single-owner consumer of the same writer.
- Patch `20632cf6…` on `d67687ed…`, six files as before, manifest updated.
  `q36_gpu.h` unchanged; Metal and Vulkan readback implementations read.
  Vulkan not run and no inference of CUDA support. The arm64 writer
  descriptor grows from 32 to 40 bytes, optional callbacks 24 bytes; no
  per-token/session type changes.
- Native test on **real Metal buffers, without weights**: **82/82 PASS**,
  `q36-payload-schedule/run-TihkbA`. Separately assembled byte oracle,
  35B/27B shapes with four initialized layers, nine K/V pairs,
  recurrent precision and logit position, context 1,024/8,192, admission/
  read/output errors and cancellation. An independent GPU operation
  proceeds while the writer is blocked, **through a fixture scheduler**:
  this is not server decoding or model quality.
- The test of the real scheduler/cache with simulated numerical sessions is now
  mandatory in the full gate, with no exemption for a known error. Run
  `q36-metal-runtime/run-MvD4ha` ends **FAIL: 32 phases passed out of 33**.
  `q36-cache-owner/run-XMMYx1` retains the blocking; API success does not
  conceal the still-incomplete consumer. Patch lifecycle, clean build,
  operators, projector and preceding regressions continue to pass.
  The preceding 32-phase gate `run-TuzlJ1` predated the addition of this
  acceptance test: it must not be presented as batched qualification.
- Next step: migrate catalog owner, GPU readback/restore and
  checkpoint callbacks during prefill together; then read/write barriers,
  stale/cancel and real batched inference. Removing the mutex alone would produce
  concurrent command-buffer access, not a fix.
- The `.app` remains `ca5b916f…`, 27B is not selectable and the 11/12 language
  FAIL remains open. No model downloaded/started, rebuild/restart or push.
  The real 34/34 replay still belongs to preceding patch `2ea07d80…`.
  Operational receipt in `qwen27-payload-scheduling.MNSqsX/CHECKPOINT.md`,
  among ignored artifacts. All of P0–P11 remains in the goal, not just this slice.

### P3 — private restore and cache concurrency, September 8

- Recovered gate `q36-metal-runtime/run-V6Efpq`: **FAIL, 32/33**, patch
  `af87743f…`. The preceding work is **progress**: writing, cancellation
  and prefill checkpoints passed; restore continued to block decode.
- The new consumer uses the catalog with only one admitted preparation, without
  holding `kv_mu` during I/O. Callbacks take the existing backend only
  for bounded transfers; no new worker or authoritative store.
  The writer preserves native bytes and cancellation; prefill checkpoints
  are saved at the exact frontier after releasing the backend.
- Restore creates a private native session, with the same weights/configuration.
  Disk reads outside the backend, initialization/upload in 64 KiB blocks,
  revalidation of slot/job, cancellation and decoder before the pointer swap.
  Error/corruption/stale results do not destroy previous state. This is not token-only
  replay in place of KV/GDN; old token-only payloads retain
  native replay. Removed `inference_mu`, now without consumers.
- Reproducible patch `8079006fc246deab1a0a09cd97c9527d153ee3699da4f1e85788ce21d6346e17`,
  six files on `d67687ed…`. **33/33 PASS** in gate `q36-metal-runtime/run-A7Xzt1`:
  138 Metal-buffer cases (`q36-payload-schedule/run-oydDe3`), seven on the real
  scheduler/cache with simulated numerics (`q36-cache-owner/run-4yf4iO`), plus
  patch lifecycle, build, operators, projector and preceding regressions.
  The four read cases fail on the preceding patch in the same
  test (`run-hrSJgq`); all RED receipts retained.
- CPU payload **9,761 PASS** (`q36-payload-prepare/run-ZW9TIP`); text HTTP
  **24/24 PASS** (`q36-http-text-prepare/run-P5wEgA`). New empty
  network installation in `qwen27-cache-restore.84nAwX/q36`, without downloading weights;
  server `2820c6e2…`, identical to the clean gate's binary.
- Still open: atomic cancellation of the entire batched prefill, cancellable/
  bounded scans, parser allocations, real profiling. Vulkan source
  retains allocations/driver calls under an internal mutex: a separate defect,
  not AMD qualification acquired from these Metal tests. No CUDA test.
  The real-model batched test is separate from fixture tests; no statement
  of speed or general quality follows from the 138 native cases.
- `.app` unchanged `ca5b916f…`; 27B still not selectable. The 11/12 language
  FAIL, every mode and all of P0–P11 remain open. Operational checkpoint
  in `qwen27-cache-restore.84nAwX/CHECKPOINT.md` among ignored artifacts.

Subsequent verification of the same slice:

- The first test with real 27B (`q36-batched-cache-live/run-h86Z5P`) remains
  **FAIL 8/10**, with seven exact answers: the tester's cold-cache limit
  excluded prompts and the engine lost the final save at shutdown.
  The new deterministic case reproduces the latter defect on patch
  `8079006f` (`q36-cache-owner/run-lXtZjd`, 7/8).
- Once workers/clients have terminated, persistence passes to the shutdown thread alone,
  without requesting access to the already stopped scheduler. Patch for that slice
  `960b1505f0a7ca820872257d51dca0cdf8968d061b2db9c774304ea1f25e1f46`;
  native gate `run-uOcLI0` **33/33**, Metal `run-9e6Sy7` **138/138**,
  scheduler/files with simulated numerics `run-QTxTht` **8/8**.
- Empty network installation `qwen27-cache-shutdown.dgTuVl/q36`, server
  `3f3acf1a…`. Real test `q36-batched-cache-live/run-5YYWki` **11/11 PASS**:
  seven exact answers, actual disk restore, final checkpoint read and
  six preceding files preserved except hit/last-use counters. Both
  test processes exited with code 0; no user process stopped.
- Two slots and concurrent requests, but no decode with a two-element batch:
  this is not batch numerical parity. A restore waits 19.749 seconds during
  concurrent prefill, versus about 0.94 seconds without that contention.
  Fairness/profiling and atomic cancellation of the entire prompt remain open.
  No conclusion about general quality or speed, no rebuild/push.
  Operational checkpoint updated in `qwen27-cache-shutdown.dgTuVl/CHECKPOINT.md`.

### P3 — atomic batched prefill and real Stop, September 8

- Batched HTTP prefill now prepares the entire prompt in a private session,
  including KV restore/copy and temporary caches. Publishes only after
  revalidation of job, session, lifecycle, cancellation and decoder handoff.
  Device-native copies up to 64 KiB, allocations outside GPU admission;
  no host/disk snapshot to clone state, no precision reduction.
- Patch **`1677e0f68110ba504c0f0d1172a42cf95e19dbd3c75ef2ee18d41851e63c19b7`**,
  base `d67687ed…`, complete export verified. Network installer
  `qwen27-batched-text.2Avqau/q36`; server **`fa508a5c…`**, CLI **`1d2c1200…`**.
- Native gate **34/34 PASS** (`q36-metal-runtime/run-sYymEs`), including
  **186/186** Metal buffers, **24/24** single HTTP and **24/24** batched with
  simulated numerics, **8/8** scheduler/files. The old batched path
  passes only 4/24; RED evidence and fixture defects retained, corrected
  without changing preservation requirements or the copy limit.
- Scheduled native APIs with real 27B **13/13 PASS**
  (`q36-text-prepare/run-6XiThB`): state/logits identical byte for byte and four
  subsequent steps per case, including nonempty token-only payload. This is a
  fixture for exclusive GPU access, not an HTTP concurrency test.
- Real HTTP **15/15 PASS** (`q36-batched-cache-live/run-nBAiqZ`). After Stop,
  the resident frontier remains 1,905 tokens, preceding files are intact and
  the subsequent answer/cache decision matches the control without Stop.
  Same harness on patch `960b1505`: **13/15 FAIL** (`run-jCwuDn`), because
  cancellation allows prefill to finish and replaces state with 3,913
  tokens. All test processes terminated with code 0, not orphaned.
- The first extended check (`run-36aNCy`) remains **12/13 FAIL**: it incorrectly
  required a RAM hit. Normalization of Qwen thinking markers
  chooses disk even in the control without Stop; this is now proved on both
  revisions. Answer, interruption HTTP, previous frontier
  and file integrity have not been weakened. No retry erases a receipt.
- Profiles/fairness, parser/scan limits, unqualified backends,
  lifecycle and four 27B modes, broad quality and all P0–P11 criteria remain open.
  The 11/12 language FAIL remains a FAIL. App `ca5b916f…` unchanged, no push.
  Operational checkpoint: ignored `qwen27-batched-text.2Avqau/CHECKPOINT.md`.

### P3 — scratch reuse between sessions, September 8

- The preceding turn is **progress**: HTTP Stop qualified and new
  upstream 1/2/4/8 numerical test. The latter found a real FAIL in both
  KV modes (`q36-session-batch/run-yrtczD`): the last four rows of the
  batch of eight diverge by up to 9.62949 and one chooses a different token.
- Cause in the pinned q36 core: Q/K reuse the whole QKV panel; the per-session
  loop writes K over subsequent projections not yet consumed. Minimal
  fix: all convolutions before deltas, without new allocations,
  fewer sessions or increasing the upstream 0.25 tolerance.
- Patch **`aa26ffa9a1862863df2aacdffddcd51f021d8ac7f1d7a2acd0fe9707a8ccd32b`**.
  New native Metal test with synthetic weights: 96 cases, 9,216 asserts, both
  35B/27B structures, rows 1..8, capacities 8/16, fused/unfused/
  mixed convolution and two steps. Before: 24 cases FAIL / 336 asserts (`run-6liaiS`), after: all
  PASS and zero byte difference (`run-YwJ3PC`). The first probe compilation error
  (`run-VMOR7S`) is retained, not counted as numerical execution.
- Network installer `qwen27-recurrent-batch.AbJrSq/q36`, same base and existing
  weights, server `c31774ec…`, CLI `5b15faf6…`. Patch/runtime gate **35/35
  PASS** (`q36-metal-runtime/run-HLyNYz`), including real projector.
- The unchanged upstream test with real 27B passes **both KV phases**, all
  30 full-logit comparisons 1/2/4/8 and upstream asserts on
  tokens, payload, errors and fallback (`q36-session-batch/run-KstvbC`). Max abs
  F16/F16 **0.00828552**, Q8_0/Q4_0 **0.214759**, below the upstream 0.25 limit;
  no argmax difference. This is not bitwise equivalence or general quality.
  Both processes exit 0, reaped. HTTP follow-up on the new binary
  **15/15 PASS** (`q36-batched-cache-live/run-jkvwOI`): cache/Stop and pre-cancel
  frontier preserved, subsequent answer exact and equal to the control.
  Both test servers terminate with exit 0, without orphans.
- Latest harness, with explicit interruption cleanup, reconfirmed 96/96 and
  9,216/9,216 (`q36-recurrent-batch/run-XxRlF9`). Deliberate interruption of
  the compiler in `run-j2MvFm` retains the interrupted outcome, reaps its own child
  and does not start the numerical probe; this is not a model test or a product FAIL.
- No push, settings change, app rebuild/restart or new weight download.
  P0–P11, 27B integration and the 11/12 language FAIL remain open.
  Operational checkpoint: ignored `qwen27-recurrent-batch.AbJrSq/CHECKPOINT.md`.

### P3 — structured transport and runtime Stop, September 8

- The HTTP/SSE connection now preserves tool IDs, names and arguments, including
  fragmented or interleaved values. It does not publish an executable group before a
  valid conclusion; errors, duplicates, exceeded limits and incomplete streams
  remain failures. Escaped Unicode text is no longer replaced by `?`.
- Initial regression **2/12 PASS**, retained in `model-rpc-stream/run-EuINKN`.
  Extended suite **60/60 PASS** normal (`run-soSifu`) and ASan/UBSan
  (`run-4Yjtmc`). Real HTTP and native consumers, simulated model responses:
  this is not model quality or structured-dispatcher integration.
- Stop through Task Graph and watchdog left the reader waiting: **6/18**
  before the fix. The runtime now consults its owner's latch, with nonblocking
  stdin and flag restoration; POSIX Stop does not write to the data pipe.
  Already queued bytes from the cancelled turn are discarded within an explicit
  limit, before WAITING. **36/36 PASS**, also ASan/UBSan, including
  SA_RESTART, partial messages, discarded candidates and no residual bytes.
- The real binaries also reproduced the cancellation latch inherited by the
  following turn (`runtime-model-interrupt/run-S3PXwP`) and a cancelled frame
  entering the new prompt (`run-KjiluE`). Both fixed without restarting the
  process or weakening file checks. Comparison with the old binary
  remains **0/9 PASS** (`run-yZkxpv`), with the same grader corrected only for
  the CR/LF terminator consumed by Design; the preceding grader error and
  its logs remain in `run-5C9I3x`.
- Agent manifest **94**, all consumers updated. The five variants
  retain their upstream hashes; the first-party change is recorded in
  `remote-interrupt-fix.patch`. Migration/restore **5/5 PASS** (`run-kF2tHZ`),
  Agent builder **8/8**, Design **18/18**, Qwen3.6 parser/tools PASS and Task Graph
  **2,555 checks**, HTTP and publication validation PASS.
- Full native build **main/Laguna/Qwen3.8 PASS** (`agent-native-build/run-pSEI6b`):
  Agent, Cowork and Design compiled in isolated copies, real tools/steering with
  simulated model, Stop/resume and renderer with ASan/UBSan. No CUDA,
  ROCm or Vulkan test and no promotion of model quality.
  Final repetition **27/27 PASS** on the nine binaries with the current harness:
  `runtime-model-interrupt/run-1U0YAr`, all processes terminated with code 0.
- The cancellable bounded HTTP worker, protection against
  late responses after a process change, serialization of pipe
  writes and separate lifecycle of the resident server remain open. Tool
  structure and transcript groups still need integration into DStudio Agent.
  Do not use the current transport as evidence for these requirements or enable 27B.
- Operational checkpoint: ignored `model-rpc-sanitized.H78CmB/CHECKPOINT.md`.
  q36 engine and weights unchanged; no model started in this slice,
  no `.app` rebuild/restart, no push. P0–P11 remain open.

### P3 — owned and cancellable transport worker, September 8

- Real reproduction of the reused descriptor: the old detached worker
  delivered **139 bytes** (text and completion) to the subsequent runtime.
  `model-rpc-lifecycle.x1Vvem/baseline.json` and the preceding binary remain
  retained. The fixed path delivers **zero bytes** after the change.
- The new first-party module `src/dstudio_model_rpc.c` performs networking, DNS,
  TLS and parsing in an exec copy of the same host. The worker does not inherit
  runtime stdin, listener or other application descriptors. The owner forwards
  only data for the still-valid PID/pipe/epoch identity; Stop revokes that
  delivery before signaling the runtime and terminates the private group.
- One worker, one pending request during reaping, body of
  at most 16 MiB and 16 KiB staging. Bounded IPC steps, monotonic request/delivery
  deadlines, asynchronous escalation and a single writer on the runtime
  channel. The owner record measures **24,776 bytes**, the worker job **1,624 bytes**;
  maximum 32 MiB of admitted bodies in the host. These limits do not qualify the
  initial envelope parser, which still needs to move outside the control loop.
- Credentials and request captured at admission. Curl starts without a shell
  and receives body/headers through already unlinked file descriptors: cancellation
  and owner death leave no named files containing request data.
- Normal and ASan/UBSan gates: **61/61** direct, **63/63** host HTTP and **63/63**
  host HTTPS. Include large frames, Stop during a pending connection,
  forced death of the test host only, group disappearance and staging cleanup.
  ASan receipts: `model-rpc-stream/run-1kRwKE`, `run-Jj8pcr`, `run-4nzpyG`.
- Lifecycle **6/6**, receipts `model-rpc-lifecycle/run-6jWjAj` and ASan
  `run-jNLtWd`: FD reuse, 200 duplicates rejected, credential snapshot,
  worker SIGSTOP with escalation, full channel and usable HTTP Stop,
  crash, deadline, oversized body and request queued before Stop.
  The **36/36** reader/HTTP/Task Graph/watchdog cases now include the real
  HTTP connection and worker reaping; PASS also with sanitizers.
- Graders corrected with evidence, without changing binaries to make them pass:
  Node's incremental UTF-8 decoder; flag comparison with an independent POSIX pipe
  after writing (`FWASWRITTEN` Darwin); local HTTP fields distinct from the already
  existing HTTPS protocol; process inventory instead of inferring absence from EPERM.
  Original FAILs `run-IoAG1g`, `run-ACkZNt`, `run-viJjzl` retained with notes.
- Task Graph **2,555 checks**, HTTP and steering PASS; native host and window
  object compiled. Simulated models, no model started. No Windows/CUDA/ROCm/Vulkan
  runtime test; no new `.app`, restart or publication.
  Envelope ingress/limits on the control loop, desktop test and profiles remain open,
  then structured dispatcher/transcript and separate resident server. Qwen27B
  is not enabled and the **11/12** language FAIL remains open. P0–P11 are not
  complete. Operational checkpoint `model-rpc-lifecycle.x1Vvem/CHECKPOINT.md`.

### P3 — bounded native ingress and private decoding, September 8

- The preceding turn was status only, therefore **no implementation
  progress**. This slice changes native ingress and its
  tests; it does not close P3 or the full plan.
- Two REDs retained in `model-rpc-input/run-vJXv26`: nested data interpreted
  as a model request and 524,288 bytes consumed in one pass.
  Same cases green after the fix (`run-GrUehM`), without changing the oracle.
- Inspected first-party writer `rpc_send_request`: its canonical
  type/id/body header is unchanged. The host recognizes only that prefix, and does not search
  for commands in document bodies. The prefix epoch survives fragmentation;
  a header started before Stop is not readmitted after cancellation.
- Incremental transfer with 16 KiB staging and 8 KiB stdout suffix,
  real backpressure and 64 KiB of read work per pipe/pass. The
  worker reconstructs and validates at most 16 MiB decoded, including escapes,
  surrogate pairs, UTF-8 and JSON, before opening the connection. No copy
  of the potentially 96 MiB envelope on the control owner. A single Unicode decoder
  also serves caller buffers, with exact-capacity and sentinel tests.
- Input **16/16 ASan/UBSan** (`model-rpc-input/run-BB5glZ`), including a large
  message from the real client, independent comparison by the HTTP peer, worker stopped
  with SIGSTOP, Stop still usable, rejections without HTTP traffic, incomplete
  envelope, overflow and expired terminal delivery on an actually full pipe.
  The watchdog no longer counts a `tool_call` nested inside an artifact event.
- The transport corpus now passes through envelope admission: HTTP **63/63**
  (`model-rpc-stream/run-TeefaO`) and HTTPS **63/63** (`run-ImL5RB`); ASan
  repetitions **63/63** `run-baDWtp` and `run-LhURyK`. Direct **61/61**, Stop **36/36**,
  lifecycle **6/6**, steering, Goal and Unicode PASS. Simulated models, not
  inference, quality, 27B speed or other backends.
- Layout: owner 41,192 B (previously 24,776 B), added staging 16,384 B, maximum
  two records and one worker. Display events have an explicit 4 MiB ceiling,
  consistent with transcript capacity; an oversized record fails without
  publishing a false completed tool. Hashing and display publication of the
  entire record remain on the control path and still require review.
- Normal input repetition **16/16** `run-fAgXR0`, lifecycle **6/6**
  `model-rpc-lifecycle/run-OXgy3K`, Task Graph **2,556**, preflight **28/28**,
  spawn **16/16**. `agent-native-build/run-0pjwW5` recompiles the nine
  main/Laguna/Qwen3.8 Agent/Cowork/Design runtimes and executes their tools, renderer and
  Stop/resume with a simulated model response. No installed engine is
  recompiled in place; this is not a new inference or other-backend test.
- Final extension **18/18** normal `model-rpc-input/run-c5ToRd`, ASan
  `run-3L6ah7`. RED `run-swHLm7` **16/18**: EPIPE during a still-open upload
  overwrote the error receipt already produced by the worker. The new
  path closes only the upload and preserves receipt reading; crash/EOF
  remain errors, never invented completions. The SIGSTOP/SIGCONT barrier and
  `waitid(WNOWAIT)` make the case deterministic without losing process
  ownership. A 24 MiB body rejected with the actual reason, without HTTP.
  Also repeated: 61/61 direct, 63/63 HTTP/HTTPS, 36/36 Stop and 6/6 lifecycle,
  normal and ASan/UBSan; compiled `build/dstudio.o`, user bundle unchanged.
- P10 profiling, Windows/Stop allocation failure, structured dispatcher
  and atomic tool groups, separately owned q36 server,
  27B catalog/modes and all P0–P11 gates remain open. The 11/12 language FAIL
  is retained. App `ca5b916f…` unchanged; no restart, model or push.

### P3 — structured native tools and receipts, September 8, 22:31

- Implemented the DStudio runtime's explicit structured protocol in
  Agent patch 95, without using a q36/q27 Agent or transforming Qwen text into
  DSML. Schemas derived from actual tools, validation of the entire
  batch before effects, results with original IDs and indivisible history
  groups during compaction. The ID registry survives
  compaction; this is not yet exactly-once persistence across a crash.
- Cowork retains Office/documents and does not receive an arbitrary shell. Stop preserves
  preceding effects and terminates only the current shell job. Errors and
  interruptions of individual invocations produce exit codes distinct from success.
  Model text cannot forge JSONL records in the structured path.
- Reproduced and fixed: overly permissive Laguna search schema, transport IDs
  included in the anti-loop comparison, a failed turn converted to success
  when the engine returned idle, and incorrect Git anchoring in the historical Stop delta.
  Task, node, receipt and reloaded journal now agree on failure.
- `agent-native-build/run-8Xg54L`: 33 scenarios x four bases x normal/sanitized,
  **264/264 executions PASS**, real tools/files but simulated model; main/Laguna/
  Qwen3.8/Qwen3.6 Agent/Cowork/Design builds and DSML paths preserved.
  The same gate executes native limits/lifetime (5,196 checks per base), layout
  and microbenchmarks without models. Upstream core/GPU are not sanitized.
- `agent-patch-migration/run-F1FDrj`: all five bases PASS without changing
  historical hashes. Task Graph 2,556 checks + HTTP PASS; new error/idle test
  with ASan/UBSan and journal recovery. Transport ingress 18/18, stream
  61/63/63, lifecycle 6/6, Stop 36/36 and UTF-8 PASS. Original failures retained.
- P3 remains open: resident server/PID/lease/27B routing, images, durable
  remote history and real-model tests per mode. The watchdog retains the limit
  on comparison of serialized payloads; no general argument equivalence
  is claimed. P0–P11, broad quality, desktop and other backends are not
  replaced by this gate. Installed app unchanged, no push.

### P3 — native supervision of the 27B server, September 8, 23:13

- The preceding summary was status, not implementation progress. In
  this slice, added the private owner channel to the q36 `.patch`:
  control before loading, receipt only after engine/session/
  listen, actual PID and configuration, identity from open file descriptors.
  Pathname replacement cannot attribute new weights to the server.
- The supervision thread does not own sessions and does not block the model
  owner. EOF/unexpected commands request normal shutdown; after three
  seconds it terminates only its own process if preparation/drain remains
  blocked. Close-on-exec FD, bounded nonblocking response, standalone
  unchanged. The host does not consume this receipt yet: PID/lease and routing
  in modes remain the next work, not already exposed capabilities.
- Patch `467020d6…`, base `Ninnix/q36 d67687ed…`. `q36-owner/run-x4c3OQ`
  **52/52 PASS**: 24 process/socket/identity scenarios, normal and ASan/UBSan,
  plus four real-server launches; simulated models. Complete Metal gate
  `q36-metal-runtime/run-6GePLX` **36/36 PASS**, clean build, real projector,
  preceding regressions and immutable inputs. Installer fixtures **12/12 PASS**.
- `q36-owner-live/run-cBaWGZ`: **5/5 PASS with real 27B**. Ready, catalog,
  two exact answers and clean process/port shutdown after owner EOF.
  Already verified Q6 weights and F16 projector; Metal, context 8,192, no expert SSD,
  no disk KV. This check does not fix or replace the 11/12 quality
  FAIL, is not a speed benchmark and does not close the other P0–P11 gates.
- Tester errors and RED receipts retained. Initial saturation was
  drained by Node's buffer: a native socketpair without readers makes the case
  deterministic, without increasing limits or weakening the assertion.
- No user engine stopped; only the process started by the test terminated.
  No download, limit changes, app rebuild/restart or push. Status
  and next steps in `qwen27-owner.0bacFq/CHECKPOINT.md` among ignored artifacts.

### Previous Qwen resumption — September 8, 2026

- The preceding turn produced a new bundle compiled, signed and
  verified in isolation, then installed in the two requested locations:
  `qwen-app-rebuild.AvJmFa/BUILD-RECEIPT.md`. This is packaging progress,
  not inference or completion of the plan. No user engine/app started.
- The new local installation pin is `82d031408c50419957fd44b7e9c2d423890b24bd`.
  Upstream build and kernels, fresh main/Qwen setup, patches and adapters were
  tested in isolated copies (`qwen38-plan.c0OVd2`,
  `engine-acceptance/run-JGbW06`); the personal checkout remains `bd9cfbc`.
- Real replay `qwen38-host-live/run-21AjQy` retains Agent PASS and Cowork
  FAIL: after reset, the model called `read`, not the required `read_document`,
  and announced another read without performing it. No
  relaxation of the oracle and no promotion of the old 2/2 to this pin.
- P3 Learn: native Qwen3.6 thinking on/off and Qwen3.8 xhigh; removed the
  DeepSeek requirement of 393,216 tokens from curriculum, audit, expansion and
  Qwen Tutor. Settings snapshot carried into all
  research/judge/repair/Tutor requests; this is not yet a real Learn quality test.
- P1/P3: REDs retained `chat-request-binding/run-PSXYDF` and `run-WBcdKM`.
  Fixed mutation of already captured settings, A → B → A sequence,
  late prompt/sampling changes, SSE events already buffered after Stop
  or model change. Ephemeral selection identity, not serialized.
- P1: RED `chat-model-readiness/run-ObQU23`; cancellation of the final
  consumer prevents subsequent launch during readiness/preparation.
  Another valid consumer retains its shared launch; maximum
  32 observers per preparation. This is not evidence of interruption inside a kernel.
- Scroll: three races in the common controller reproduced with deterministic frames
  (`follow-scroll/run-fNi77U`) and fixed. Separately, WebKit FAIL
  `roadmap-browser/run-px3CcU` was diagnosed: no JS write or
  DOM mutation during movement 110 → 0; same animation reproduced
  without DStudio by the tester's synthetic WheelEvent. The test now uses real
  wheel input and a stream barrier; assertions remain unchanged.
- Also fixed the displayed Qwen3.6 name for GGUF paths and variants
  not recognized by exact filename alone. Function test first FAIL,
  then PASS; visible selection is checked in the Tutor suite.
- `make test-frontend-unit`: PASS; readiness 11/11
  (`run-c0xApt`), API 12/12 (`run-dpSnVh`), scroll 5/5 (`run-QSEKeS`), plus
  preceding frontend regressions. These are functions/browsers with simulated
  responses, not model quality. Browser matrix after the latest fixes
  still running; do not attribute a premature PASS to it.
- Remotes rechecked `2026-09-07T22:40:17Z`: main remains `f62ca29`;
  Qwen3.8 advanced to `b85a6174da6d0ea3139b48194a2ca108097657b1`.
  New delta marked DA_ANALIZZARE (to be analyzed), not qualified or selected in the launcher.
  The user's old checkout is not overwritten or implicitly updated.

All cited receipts are under ignored `tests/.artifacts/`. Verified
upgrade, real Learn, numerics/100 cases, desktop,
vision and new 27B relevant to the family remain mandatory. No push from this resumption.

### Execution log — September 7, 2026

- P0 started: `tests/support/quality_baseline.mjs` preserves the initial diff,
  identities/hashes of 1,112 DStudio files, sources/binaries of the four engines,
  and a deduplicated inventory. Private receipt `baseline-JQOBC7` under
  `tests/.artifacts/quality-multihardware/`.
- SHA-256 completed for **13 files, 828,609,819,360 bytes**, in 437.159 s total
  capture time; 14 files inventoried, with GLM 5.2 excluded and not read for hashing.
  No read/mutation errors detected. This identifies the local bytes:
  it does **not** prove checkpoint authenticity, readiness, or numerical quality.
- Remote main `c0a6119f363ef82125877142f13fb3fe491cba14` reconfirmed through
  `git ls-remote`. No engine update applied in this tranche.
- P1: reproduced four failures out of six initial HTTP requests
  (`tests/.artifacts/design-start/http-vm7Tm9/results.json`), including model/skill
  mutation on rejected requests. Failed receipt retained.
- Implemented private validation of config, model, credentials, and style
  before task admission; no fallback for an explicitly selected missing GGUF.
  Distinguished supported IDs from installed/complete packs. UI: deduplicated
  catalog loading, migration persisted before the first start, error/retry for
  an unavailable network, and no clearing of the selection for an incomplete pack.
- Checks run: `make test-design-start test-quality-baseline` (**13/13**
  HTTP cases plus JS functions/provenance), `make test-lan-unit
  test-engine-setup-unit`; `node tests/browser/ui_agent_design_playwright_test.mjs`
  in both Chromium and `DSTUDIO_TEST_BROWSER=webkit`. Both UI runs check
  the first request with the catalog held behind a barrier. Final HTTP receipt
  for the tranche: `tests/.artifacts/design-start/http-98J6Jg/results.json`.
  **These are model-free regressions**, not inference or desktop E2E.
- Native Qwen3.6 baseline run with
  `node tests/live/engine_acceptance.mjs --infer --engines qwen35`, receipt
  `tests/.artifacts/engine-acceptance/run-m8zF5Z/`: **FAIL, 11/12**. In the
  Python case filtering odd numbers, the answer is `22`, whereas independent
  execution with Python produces `16`. No correction to the grader: the
  failure remains in the denominator. Load time 10.041 s, context 8,192,
  temperature 0, seed 42, thinking disabled; these short development cases
  are neither the 100 held-out questions nor a numerical comparison against
  a reference. The log reports a resident model of 29.65 GiB, without an expert
  streaming flag. No user process/model stopped.
- Also found a separate defect in the Qwen3.6 fork: `send_models()` publishes
  DeepSeek aliases when the model is not GLM, without the Qwen branch already
  present in `server_model_id_from_engine()`. The response repeats the requested
  alias. This explains the incorrect API identity; it does **not** establish
  that the wrong Python answer is a regression in inference computation.
- Native main/Laguna/Qwen3.8 baselines completed sequentially with the same suite,
  receipt `tests/.artifacts/engine-acceptance/run-4ilcGl/`: main **11/12**,
  Laguna **10/12**, Qwen3.8 **12/12**. Main answers `:16` in the Python case:
  correct number but wrong format. Laguna returns `197` instead of `203`
  for context retrieval; in the Python case it correctly explains `16` but
  does not comply with «solo l'intero» (only the integer). No grader relaxed.
  Including Qwen3.6: **44/48** checks overall, not four fully qualified engines.
- Supplemental inventory `baseline-g9Avrv`: also verified the persisted checkout,
  profile paths, and GGUFs in the root directory. Still four engines and 14 unique
  files, with no inventory errors; no new weights found.
- P2, first isolated correction: Qwen3.6 catalog `.patch` and setup hook.
  `tests/integration/qwen35_catalog_patch_test.mjs` compiles the native HTTP
  serializer and verifies the full patch lifecycle, including drift, partial
  patches, incorrect ABI, and symlinks. PASS in `qwen35-catalog/run-cqYGp9`.
  Metadata checked: this is **not** real inference.
- P5 started early to verify the hook on the real path:
  `node tests/live/engine_acceptance.mjs --setup --engines main,laguna,qwen,qwen35`,
  empty installation `engine-acceptance/run-Q3aikw`: **4/4** downloads, builds,
  and `--help` launches succeeded. This is not yet the upgrade/interruption/
  concurrency gate, nor four modes for every model.
- Newly installed Qwen3.6, with real weights: corrected catalog verified in
  `engine-acceptance/run-KOR1D3`; answers **11/12**, same `22` error.
  Diagnostic replay `run-M8fKPe`: the same question produces `22` both cold
  and after the other requests. **11/13** including the extra diagnostic case;
  sequence consistency verified, answer correctness NOT verified.
  This is not evidence that the checkpoint or inference is numerically correct.
- P1: removed `force:true` from automatic launch on the loading screen.
  A saved preference does not authorize stopping an external engine. The new
  `loading_launch_test.mjs` executes the production function and verifies a port
  conflict without a forced retry, normal launch, and preservation of an active runtime.
- The interactive browser tool connection could not be initialized
  (`node:process` not permitted by the tool runtime). Native macOS automation
  through Accessibility is available: P7 started on a real `.app` built in
  `desktop-e2e-hPIK7K`, with an isolated profile and no headless flags.
  Qwen3.6 model selected and loaded using native controls; window screenshot
  captured and inspected. Chat workflow `run-jqz0DK` is PASS:
  real keyboard input, exact final JSON, persistence, and AX text verified;
  response screenshot inspected and separate review retained.
  Observed time 180.758 s, 685 tokens generated, thinking High, context 65,536.
  This is neither evidence of good performance nor qualification of the four modes.
  Attempt `desktop-chat/run-Kc9yLG` is a tester failure before submission:
  the AX field was read while typing was in progress. The final screenshot
  and subsequent read prove that the full text arrived; added a bounded wait
  for the exact value, without accepting prefixes or different text.
  The original receipt remains retained; no inference counted for that attempt.
  Separate browser tests do not replace this desktop test.
- P1: reproduced loss of the current session on unsupported Qwen
  Agent/Cowork/Design requests: `launch-preflight/run-gEOzcA`, **0/6**.
  The real handler stopped the process before rejection. The capability decision
  is now shared between private preflight and spawn; **6/6** after the fix in
  `run-kQ2wL5`. A real echo process keeps responding, and configuration,
  task, and steering do not change. No model in this test, no false claim
  that Qwen adapters have been implemented. `make test-design-start
  test-engine-setup-unit` PASS; new HTTP receipt `http-uen2TW` **13/13**.
- Isolated `.app` closed with Command-Q: test parent, host, and engine
  no longer present; no user model terminated. Inspection of the inventory
  also found DSpark classified as an LLM: corrected the component distinction,
  with behavioral fixtures, while preserving the original hash receipts.
- P0: compared all **123 inventoried sources** from Laguna against the
  upstream archive `448d569` and the newly rebuilt DStudio installation. No
  added/missing sources or changes against the baseline; six files differ
  from upstream due to DStudio adaptations. Compared with the fresh install,
  only four log strings and one comment in three files remain different.
  Full diffs in `laguna-provenance/run-shIggr`; this is not a fabricated receipt
  of the historical download and does not by itself prove the original binary's quality.
- Native GGUF inspection: initial **8/9** in `model-metadata/run-rETzZn`.
  Qwen3.8 requires the separate PLE; corrected attempt `run-tqKfCp` then
  timed out because the fork requested prefetch of the entire PLE even in `--inspect`.
  The `.patch` `ds4-qwen38-inspect/metadata-only-ple.patch` removes that prefetch
  only for inspection. Native test `qwen38-inspect/run-OMlJ4J`: before the change,
  observed a request for all **32,000,157,440 bytes**; afterward, zero hints;
  identical metadata output and successful CLI without interposition, **1,223 tensors**.
  Metadata therefore read for all nine LLMs, but both initial failures remain
  retained. No generation or numerical equivalence in this test.
  Normal CPU startup also retains the first prefetch (interrupted by the probe
  before inference). Lifecycle/ABI/symlink verified in `run-majkZA`.
- Real setup after the new Qwen3.8 hook: main and Qwen from an empty directory,
  `engine-acceptance/run-WhJ0F0`, **2/2** downloads/builds/CLI launches PASS.
  Supplemental source snapshot `baseline-52KLnf`: 1,128 DStudio files,
  four engines, 14 weight/component files; it does not replace the initial baseline.
- Broad gate `make check-fast`, `quality-check-fast/run-fsRLFN`: FAIL in
  the Research tester; the extracted closure did not include `takeSteering` and `turns`.
  Updated the tester with the real production dequeue, plus new-context and
  cancelled-context cases; no stub that bypasses the logic. Old assertions
  retained. `make test-search-evidence` PASS.
- Second gate `quality-check-fast/run-0RHK2r`: FAIL in browser testers
  that injected preferences into isolated iframes. Reproduced in the gear,
  context, attachments, Plan, GSA, and RSA tests; scope corrected to the app's
  frame/origin only, without removing the sandbox or suppressing errors.
  Original attempts in `quality-browser/run-HsKKvs` and `run-EVPVJm`.
  The targeted suites now pass; gear/context/attachments also pass in WebKit.
  Simulated engine responses.
- P1 extended: shared preflight for checkpoint, Qwen engine, PLE/drafter, and
  SSD compatibility on private values. Before: `launch-preflight/run-UFaGtR`
  **6/20**; all 14 newly rejected combinations stopped the current process.
  After: `run-Pe51ZO`, **20/20**; responsive echo process, no mutation of
  config/credentials/memory/steering or task admission.
  `test-engine-setup-unit` and `test-lan-unit` PASS. The Design fixture was
  strengthened to actually reach a child build that fails: explicitly fake model,
  three invocations recorded exactly once; HTTP `http-RW87OH` **13/13**.
  This is neither inference nor the complete asynchronous lifecycle.
- `make check-fast` rerun from the beginning: **PASS**, receipt
  `quality-check-fast/run-ZQLGEM`, 375.859 s. Includes preflight, browser,
  Task Graph, Cowork, Design, and the other existing model-free targets.
  It does not qualify inference or a full release. Failed receipts remain;
  subsequent changes require their own checks.
- The same preflight also passes with **ASan + UBSan, 20/20**, receipt
  `launch-preflight-sanitize/run-4hOKDN`; no model in memory.
- Qwen3.8: `make test-qwen4-kernels` on the newly installed fork, receipt
  `qwen38-kernels/run-7HLVY8`, **154 numerical comparisons PASS** using upstream
  references and tolerances. Executed the real Metal kernels on a synthetic
  1.5 GiB arena: GDN, PLE, attention, MoE, dense, and MTP. These are not real
  weights, held-out answers, vision, or CUDA/Vulkan parity.
- Real first headless launch from an isolated bundle, `first-launch-jVyFOQ`:
  **7/8 phases PASS, overall result FAIL**. Download/build of the four engines
  and rediscovery after reload succeeded; the final patch roundtrip failed.
  The tester tried the old Make M2 variant; after using the production selector,
  `native-patch-roundtrip/run-gV14lT` also detects stale context in the metrics
  patch. Both failures are retained.
- P2: made the metrics patch compatible without changing the resulting C or
  losing the new upstream recovery-attempt count. The script now verifies the
  entire delta with `git apply`; no success based solely on a marker.
  `server-metrics-patch/run-pMtbtK`: **66 JSON/SSE executions PASS**, with checked
  counters, on current main, previous main, and Laguna; full lifecycle,
  drift/partial patch/symlink, and unrelated changes verified. First attempt
  `run-OyahiM` remains FAIL due to tester errors (linking and default directory).
  `native-patch-roundtrip/run-KR4NUU` PASS on six native adaptations; this is
  not the complete Agent/server-PLD/web migration. `test-main-decode-metrics` PASS.
  Reported times remain those of the last native decode pass, not a new
  end-to-end measurement or a measurement of the entire possible recovery.
  Supplemental receipt `server-metrics-patch/run-CRZJNS`: same **66/66**,
  with compiler, commands, hashes, and its own Git identity recorded.
  `make test-glm53-m2max-patch test-lan-unit` PASS after the new hook.
- New first-launch installation, `first-launch-j1Ufck`: **8/8 phases PASS**
  from isolated bundle `quality-packaging/run-Theisl/DStudio.app`. Main 46.697 s,
  Laguna 36.549 s, Qwen3.8 18.509 s, Qwen3.6 14.969 s for their respective
  installation/CLI verification phases. Six screenshots inspected, with a
  separate review in the receipt. External listener preserved; test app stopped
  by the tester. Automatic model startup and weight downloads are blocked at
  the test boundary: the screenshots also retain the corresponding warnings.
  This is not a qualified first Chat, a native desktop test, inference, or model speed.
- Subsequent audit `quality-multihardware/plan-audit-EbLyVT`: checked the
  original document, sources, and receipts; **40/40** targeted native cases PASS,
  but browser FAIL on `uid is not defined`. The generator was private to the
  Store closure and was called by Switcher: corrected at the launch point.
  The same Agent/Design suite returns to PASS in Chromium and WebKit. The old
  `check-fast` result was not attributed to the new code.
- P1: build and instruction preparation now uses a separate host process
  with a lease, limits, and a private result. The owner continues to serve status
  and the current runtime; it revalidates model/components/workspace/binary
  before stopping it and publishing the new launch. Cancellation for the exact
  task, nonblocking stop, and cleanup of the preparer's process group after host death.
  Initial test `launch-control/http-TGXBdw` reproduces the status blockage;
  the first seven scenarios pass in `http-BVAzNA` and `http-vGHsWq`.
- Further races reproduced and corrected: an encoder installed during
  preparation was not captured as a dependency (`http-eS80bq`, **10/11**),
  late readiness reactivated the Ready flag after cancel (`http-8az3Ax`,
  **9/11**, including a subsequent case blocked by a stop still in progress).
  The check now includes both the identity and absence of the encoder/drafter
  and ignores readiness progress after cancellation. Receipt `http-6ggi0G`,
  **11/11** PASS, with real processes but explicitly fake checkpoints/builds.
  The readiness test was strengthened: the parser must have consumed both
  late markers before the assertion; observing the final stop alone is insufficient.
- P1 UI: five scenarios with held HTTP responses verify the Cancel button,
  correct nonce and task, concurrent window, preserved preferences/chat,
  and readiness. First attempt `launch-ui/run-8pytns` FAIL due to a missing
  picker in the fixture; corrected the tester without changing the app.
  `run-feuj2I` then reproduces an old error's timer hiding a new launch.
  Timers and callbacks now belong to their own attempt.
  `run-3yK6ql` Chromium and `run-NKLXhb` WebKit: **5/5 each**, dark loading
  screenshots inspected. No inference or desktop E2E claimed.
  `make test-launch-control test-design-start test-engine-setup-unit
  test-lan-unit` PASS; Design HTTP `http-S2uZFb` **13/13**, preflight **20/20**.
  New targets `test-launch-control` and `test-ui-launch` added to `check-fast`.
- P1 is not yet closed: real-runtime tests and the complete desktop/model-switch
  matrix remain. The in-place Agent builder was subsequently replaced in the
  following P2 tranche; verified recovery of previously damaged old checkouts
  remains open.
- Subsequent audit: `make check-fast` **PASS, 401.699 s**, plus Agent/Design
  WebKit **PASS, 36.509 s**, without source changes during the gate.
  Receipts `quality-check-fast/run-bb3QAY/results.json` and `plan-review.json`;
  baseline `quality-multihardware/baseline-SCzQH7`, 1,136 project files.
  This result precedes the P2 changes described below and does not automatically
  qualify the new builder.
- P2 Agent/Cowork: captured transformer 86's output before replacing it.
  Three complete `.patch` files for main `c0a6119`, previous `f4d03f6`, and
  Laguna `448d569`; manifest **87**, bases/hashes in
  `patch/ds4-agent-jsonl/bases.json`. The shared remote include retains its
  original position. Byte-for-byte parity with the previous oracle, independent
  Git application and reversibility, CRLF, unrelated changes, repeat/partial/drift
  verified on all three bases (`agent-patch-migration/run-uBlXLn`).
  Removed the **154** inactive Agent `.find/.replace` operations; recoverable
  copy under `agent-patch-migration/run-fWozkD/legacy-anchors`. Web/server not yet migrated.
- The builder now prepares Agent/Cowork sources and binaries in a private
  directory, preserves previous executables if compilation fails, revalidates
  the two original sources, and serializes its compilers with an inherited lease.
  **8/8** native builder tests with a simulated compiler: failure/incomplete link,
  concurrent modification, killing the entire group, parent-only death,
  contender excluded, symbolic link rejected, and untrusted legacy backup.
  Receipt `agent-build/run-L5IkT3`; no model loaded.
- **34/34** native applicator tests, also with ASan+UBSan: exact contexts,
  order, bounded/regular files, malformed manifests, ambiguity, and no
  publication on error. The new mid-line case reproduced a flaw, corrected
  by requiring a line start; the assertion was not weakened.
  Filesystem sanitizer receipt `unified-patch/run-mA8a6m`.
- The Qwen suite then found a regression in the new lock: an unsupported PLD
  call still created `.ds4ui-native-build.lock` in the Qwen checkout.
  Moved rejection before admission and added an assertion that no mutation
  occurs; `test-engine-setup-unit` returned to PASS without changing cleanup
  to hide the file. Test-owned directory `dstudio-qwen35-unit.2PFOHJ`
  retains the file that caused the initial failure.
- Real main/Laguna builds from **source-only** copies, without reusing compiled
  objects and without weights: `agent-native-build/run-t93v4D` PASS. Repeated
  through the isolated `.app` binary, starting from `/` and using assets
  materialized from the bundle: `agent-native-build/run-fDSySC` PASS. Checked
  hashes of the five actual patch assets and the four Agent/Cowork runtimes:
  real filesystem tools, two appends in the same turn, and no duplicated effect.
  Model responses **simulated**, so no new quality/numerical evidence. Ten native/
  schema prompts PASS in `agent-prompts/run-xqBBEk`; real main Chat PLD link PASS.
- Test `.app` `agent-patch-bundle-y3rZ9P/DStudio.app`: build, signing, and smoke
  check of materialized support PASS. No restart of the user's app. The Cygwin
  script now invalidates the stamp without first deleting the old Agent/Cowork;
  `bash -n` PASS, **Windows/CUDA/ROCm builds not run**.
- Final targeted gate **PASS, 49.079 s**, full log/command in
  `agent-patch-gates-A05aLi/results.json`: `test-unified-patch`, `test-agent-build`,
  `test-agent-patch-migration`, `test-pld-build`, `test-engine-setup-unit`,
  `test-lan-unit`, `test-design-start` (20 preflight +13 HTTP), `test-ui-launch`
  (5 Chromium +5 WebKit). The first two targets are added to `check-fast`.
  New baseline `quality-multihardware/baseline-CeCAFt`: 993 project files,
  four engines, 14 checkpoints/components inventoried; no recomputation of the
  large weight hashes. Only the log documentation changes after capture.
- `test-launch-control` for the new tranche: **FAIL**,
  `launch-control/http-CNIHLr`, because the external FlashStudy engine was
  already on port 28000. First responsiveness test PASS, then `external_server`
  rejection; subsequent scenarios were not run. `force` was not used, the
  process was not stopped, and no test shortcut was added to the launcher.
  At that time, there was no authority to stop it.
- Subsequent authorization recorded in `AGENTS.md`: FlashStudy ds4 process
  rechecked for executable, UID, start date, and port, then terminated using
  SIGTERM alone. Receipt `flashstudy-engine-stop-LM4Ios`; no GUI closure or
  changes to data, checkpoints, caches, or settings. Port 28000 free.
- Full gate restarted from the beginning after the Agent/Cowork migration:
  `make check-fast` **PASS, 409.038 s**, `quality-check-fast/run-D4T7YV`.
  Hashes of the entire source set unchanged between start and finish. Includes
  the new launch HTTP check (`launch-control/http-sEOZlB`), Design browser
  tests, and all other required model-free targets; this is neither inference
  nor numerical evidence or complete release qualification.
- P2, web/server migration: the five pinned web sources (current main,
  previous main, Laguna, and both Qwen forks) have identical bytes. One common
  `.patch` replaces CDP, direct navigation, and page capture; two Chat PLD
  `.patch` files preserve current/previous main even after the metrics patch.
  Native test and independent Git oracle: **9/9**, bytes identical to the outputs
  frozen before migration (`runtime-patch-migration/run-KRN7h6`, repeated in
  `run-osXRTI`). Application/repeat/reverse, unrelated changes, CRLF, drift,
  and partial patches verified. Public metadata in
  `patch/ds4-web-runtime/bases.json` and `patch/ds4-server-pld/bases.json`.
- Removed the 34 old web/server `.find`/`.replace` files and the three
  web manifests after byte comparison and real builds. Exact backup with hashes
  in `web-server-patch-migration-tVeHcy/legacy-anchors`. The legacy native reader
  is removed; no fallback to anchors or markers to declare a patch complete.
- Found a separate Chat publication regression: a failing linker overwrote
  the previous executable with partial output. Receipt
  `server-pld-build/run-ENdScf` retains the FAIL. Chat now also compiles source,
  derived objects, and the binary in a private directory, revalidates the server
  source, and publishes a single regular/executable file with rename. `run-NzsbGA`
  PASS: failure, missing/empty/symlink/nonexecutable output, and source changes
  during the build preserve the previous runtime. These are simulated compilers,
  not inference. Cache, Metal invalidation, spaces, cleanup, and old ABI remain
  covered without narrowing previous tests.
- Real web verification `web-visual-tmSDcZ`: compiled all four helpers, decoded
  JPEG images, and checked colors in isolated Chrome; preserved text, below-the-fold
  capture, text-only path, frame limit, and tab identity PASS.
  This is not evidence that a model interprets the images correctly.
- Source-only macOS build `agent-native-build/run-Vwaa6V` PASS: four Agent/Cowork
  runtimes with real filesystem tools and simulated responses; real main Chat
  PLD link/CLI. Laguna explicitly rejects PLD and is not counted as a qualified
  PLD runtime. Isolated `.app` `runtime-patch-bundle-tjktQE` rebuilt,
  signed, and support smoke check PASS; no restart of the user's app.
- Targeted gate after legacy removal PASS: `test-unified-patch` (34),
  `test-agent-build` (8, including conflict with the server builder after parent death),
  `test-runtime-patch-migration` (9), `test-pld-build`, `test-engine-setup-unit`,
  `test-steering-patch`, `test-main-decode-metrics`. Qwen tester compilation
  depended on a removed legacy function: the JSON output counter is now local
  to the test, with the same assertions and no dead production code.
- P2 still open: complete signature of all dependencies, crash-atomic
  publication of the binary pair, verified legacy recovery, coordination with
  the other builders, upstream alignment of the forks, and backend tests.
  Private staging may remain after a kill; the version/mtime stamp is not a
  complete signature. No overall closure claimed.
- Full gate after the web/Chat migrations: `quality-check-fast/run-hqD9BS`,
  **PASS, 419.856 s**, sources unchanged during the run; HTTP checks
  `launch-control/http-R7aR5K` **11/11**. This receipt precedes the following fix.
- Reproduced a build-cleanup defect: replacing the staging pathname with
  a symlink caused a file in the replacement directory to be deleted.
  Only test-owned fixtures; FAIL retained in `build-cleanup-audit-acUrIj`.
  Agent and Chat now retain the directory descriptor, revalidate device/inode
  before publication, and clean up using `unlinkat`, without following symlinks
  or recursing into subdirectories and with a limit of 128 visits.
  Replaced/renamed directories or unexpected entries may remain for diagnosis.
- Cleanup: **39/39** native cases (`unified-patch/run-qlIviE`), also ASan+UBSan
  (`run-cMtLTr`); server builder `server-pld-build/run-tie6vQ` PASS and Agent
  `agent-build/run-Ah3LuV` **8/8**. Attempt `server-pld-build/run-BiAniv`
  retains a tester error: the new case preceded an assertion of the previous
  count; cases reordered, assertions not weakened.
- Final bundle for this tranche `runtime-patch-final-bundle-bQC5I6/DStudio.app`:
  build, signing, and smoke PASS. Native builds from the bundle
  `agent-native-build/run-wlgaJO` PASS for main and Laguna Agent/Cowork, real
  tools with simulated responses, and main Chat PLD. No model or user app launched.
- Subsequent remote recheck: main advanced to
  `f62ca29a308724cde5bc99134ede19104b2a3260`, Qwen3.8 to
  `b4c355079d375d20821ece732e99195c71b32c06`; Laguna and Qwen3.6 unchanged.
  Isolated audit `upstream-main-audit-RA18fI`: main changes only the README and
  five lines in GLM Metal cache priority; Qwen changes many surfaces and
  requires separate qualification. Previous pins remain identified as those
  used for the tests already run; no PASS is transferred to the new sources.
- Main `f62ca29` is now both the installation pin and the local checkout.
  Before the fast-forward: private copy, backup of the 12 adaptation entries,
  reverse of the six patches, and verification that no tracked changes remained.
  Afterward: patches reapplied, sources compared with the tested copy, and all
  15 preexisting untracked files preserved (`upstream-main-audit-RA18fI/promote-OCSewX`).
  Upstream frontend/session/attention/Metal/SSD tests and native builds PASS
  (`native-N2Ch2j`); empty network installation on the new pin PASS
  (`engine-acceptance/run-e7ZIyt`). Actually rebuilt local CLI/server/Agent,
  Agent JSONL/Cowork, Chat PLD, and Design (`native-Qonqyb`), with real tools
  and simulated responses. No new inference, `.app`, or user restart.
- P2 backend: executable Makefile comparison reproduced **12/16 FAIL**
  (`backend-link/run-c975Su`): CPU objects were missing, and derived runtimes
  used the Metal linker even on CUDA/ROCm paths. Agent/Cowork/Design now inherit
  objects, linker, and libraries from the upstream backend; removed the obsolete
  CPU list from Cygwin. **16/16 PASS** across four engines and four paths,
  including rejection before compilation when the linker is missing (`run-D5WRkB`).
  This test executes the Makefiles with simulated compilers, not NVIDIA/AMD GPUs.
- Separate test with real compilers: main and Laguna Agent/Cowork/Design,
  both Metal (`agent-native-build/run-495X7M`) and CPU (`run-TDnfuD`), PASS with
  real filesystem tools and simulated model frames. Main Chat PLD compiles;
  Laguna continues to reject the unsupported combination. Cygwin `bash -n` PASS,
  real Windows/CUDA/ROCm NOT RUN. Targeted applicator/build/patch-lifecycle
  gates and `test-engine-setup-unit` PASS. The previous broad gate is not
  attributed to these subsequent changes.
- Qwen3.8 candidate `b4c3550` remains isolated and unpromoted. Native upstream
  tests `test-frontends test-session-state test-qwen4-kernels test-qwen4-q2`
  pass (`upstream-main-audit-RA18fI/native-fp1b18`): real compilers and small
  Metal buffers, not full weights or inference. The overall audit of the
  core/server/backend delta is not yet complete.
- Added `patch/ds4-agent-jsonl/qwen38.patch`: preserves the native Qwen tool
  parser and format, PLE options, and template; inserts the six Cowork tools
  in the correct envelope. It does not yet enable Qwen modes in the launcher.
  The upstream parser failed **242/242** fragmentations when a document's content
  literally contained `</tool_call>` (`qwen38-agent/run-7GW16r`). The patch
  waits for the actual parameter terminator; incomplete calls remain nonexecutable.
  Document content is not changed to work around the bug.
- The extended gate then reproduced two separate defects: a null access in
  DStudio's projection of `<think>` without a worker (`run-dl9Q4H`, confirmed
  by UBSan in `run-wcMcbv`), and a missing separator between native and Cowork
  schemas (`run-s8PvE7`). Both corrected; the first correction applies to all
  four variants, manifest **89**. `renderer-events-fix.patch` documents the
  already included delta: it is not applied twice. Historical comparisons
  retain the same hashes from version 86 after reversing only that explicit correction.
- `make test-qwen38-agent QWEN38_AGENT_TREE=tests/.artifacts/upstream-main-audit-RA18fI/qwen38`
  PASS with ASan/UBSan on private Agent/parser/helper sources, not GPU core objects.
  Receipt `qwen38-agent/run-KVDJwc`: original upstream unit tests,
  242 fragmentations, three nonexecutable calls, eight prompts produced by
  the real functions, real file writing and Cowork document creation/rereading,
  two external writes rejected, and five pairs of tool events observed.
  Model text and engine identity are fixtures, not evidence of its quality.
- The Qwen build also exposed an applicability error in the GLM M2 patch:
  context failure (`agent-native-build/run-vTtpr9`), then a violation of the
  256 KiB scratch limit after the attempted adaptation (`run-16ihdS`). The Qwen
  fork now retains its own kernels; no limit raised to hide incompatibility.
  The hook rejects a GLM adaptation already present in the fork instead of
  declaring it valid. Lifecycle/skip/rejection without changes PASS.
- Real Agent/Cowork/Design builds on three engines, main/Laguna/Qwen candidate:
  CPU PASS (`agent-native-build/run-mPAGAe`), Metal PASS (`run-uBC5HZ`), with real
  tools and steering but simulated responses. The second gate includes native
  unit tests and 108 fragmented-renderer checks per engine with ASan/UBSan;
  the same extension then also passes on CPU (`run-aRU2ey`). Main Chat PLD
  compiles; Laguna/Qwen retain explicit rejection of the unsupported ABI.
  All checkouts supplied to the test remain intact; private copies are compiled
  without weights. No restart of the user's `.app`.
- Lifecycle of the four variants PASS (`agent-patch-migration/run-YKWXY2`):
  native applicator, independent Git, restore, CRLF, unrelated changes,
  drift/partial/repeat. `test-agent-build` reported the stale grader value
  `87` against the new stamp `89` (`run-JpyT1w`); the comparison now uses
  the version declared in release metadata, retaining all tests of effects,
  source identity, concurrency, and binary preservation.
  Rerun PASS (`agent-build/run-CJk1W5`), as were Chat PLD build
  (`server-pld-build/run-MlPVci`), `test-engine-setup-unit`, `test-steering-patch`,
  and the 27,979 PLD checks with a stateful double. Applicator: 39 checks PASS
  (`unified-patch/run-OcYF9r`). These targeted gates are not the full release.
- The subsequent remote check observes Qwen `0bb323aa63cf7ed6167ae91a7606e1d875d404a3`.
  Compared with `b4c3550`, only the geometry of the two-token MTP mixer on
  M3 Ultra changes, with variant tests; Agent/core/server remain byte-identical.
  New private worktree `upstream-main-audit-RA18fI/qwen-next-0VsPlv`:
  CLI/server/Agent/Cowork build and native/kernel unit tests PASS. The final
  command initially fails due to an incorrect path in the tester, retained in
  the original receipt. The installed Qwen pin remains `bd9cfbc`: no implicit
  promotion of the candidate or claim of a complete fork audit.
- P2, Metal launcher: reproduced a real defect on **4/4** forks from an
  external directory (`metal-workspace/run-E2nLrP`); the same GPU objects
  work in the engine directory. Eight absolute overrides for GLM/vision,
  DFlash, and Qwen shaders were missing. Corrected `child_setenv_metal_sources`:
  `metal-workspace/run-L63qfJ` PASS on all four forks, each inside/outside
  the engine, **257 exact additions per launch**. Permanent test
  `make test-metal-workspace`; real Metal library and computation, without weights.
  Loading the vision shader does not enable a model vision capability.
- Qwen candidate `0bb323a`, new tests with real weights and native tools:
  `qwen38-agent-live/run-2NaM4d` initially **1/2**; Agent produces the correct
  JSON, Cowork the correct document, but the grader prohibited additional local
  reads/listings that the request did not prohibit. Receipt not overwritten.
  Grader corrected with regressions for target, shell/network, required document
  tools, results, and rereading; no file requirement weakened.
  New complete run `run-8Z20w2` **2/2**, with reading, writing, and concrete
  artifact verification, sources intact. Observed end-to-end times:
  Agent 71.426 s, Cowork 89.264 s; this is not a speed comparison.
  Resident backbone 68.32 GiB plus native SSD PLE, context 16,384,
  prefill 512, temperature 0/seed 42, thinking/MTP/DSpark disabled.
  This is a development smoke test, **not** the 100 held-out questions,
  numerical equivalence, or desktop E2E. No external engine/app stopped;
  test processes terminated. Qwen Agent/Cowork/Design launcher still disabled.
- Subsequent targeted gate PASS in
  `upstream-main-audit-RA18fI/workspace-gates-jho0Sv`: setup unit,
  asynchronous launch control, preflight **20/20**, Design HTTP **13/13**,
  tool oracle, lifecycle of the four patches, Qwen parser ASan/UBSan
  (`qwen38-agent/run-nFBSyM`), and the entire Qwen kernel suite from the external directory.
  This receipt does not replace the broad gate or missing desktop tests.
  Concrete next step: complete passing the absolute PLE path and instructions
  in the Agent/Cowork launcher, align setup/capabilities with the qualified
  candidate, and verify launch through the real host. A complete comparison
  of the core/server/backend delta remains necessary before promoting the installed pin.
- P2/P3, Qwen3.8 in the host: new installation pin
  `66b0e3fc3bf0f548db1ec0c0dd19f4e43567a7f8`, observed on the remote after
  `0bb323a`. The latest commit adds GPU argmax for MTP drafts; the Agent source
  remains byte-identical to the two candidate bases already tested. The user's
  `ds4-qwen38` checkout remains at `bd9cfbc`, not overwritten. Full fork
  comparison and multihardware qualification remain separate work.
- Corrected passing the absolute PLE path to Agent/Cowork: upstream changes
  directory before loading assets. Also removed the DSML instruction from the
  shared charter because it is incompatible with the native Qwen format.
  Preflight and spawn now admit Qwen3.8 Agent/Cowork only on the integrated Metal
  backend; operational Qwen3.6 and Qwen Design remain rejected before stopping
  the current runtime. CLI setup builds the runtimes; in the app, their
  preparation on first launch uses the existing asynchronous worker. No new
  blocking work added to the installation HTTP handler, which remains to be
  completed in P5.
- Real empty network installation of main/Qwen: `engine-acceptance/run-geQqkJ`,
  **2/2 PASS**. Verified native binaries and Agent JSONL/Cowork on the new pin;
  the installation gate does not load weights. Targeted gates PASS in
  `upstream-main-audit-RA18fI/host-gates-AwNmzC`: native frontend/sessions/kernels,
  kernels from the external directory, preflight **24/24**, asynchronous launch,
  Design HTTP **13/13**, lifecycle of the four patches, and Qwen parser/tools
  with ASan/UBSan on private sources. Metal tests do not qualify CUDA/ROCm.
- Real HTTP host, new `tests/live/qwen38_host_smoke.mjs`: first test
  `qwen38-host-live/run-Uh95Y3` fails in the grader after Agent produced the
  correct file and completed the Task Graph. The grader also prohibited
  the `.dstudio` receipts directory; the original receipt remains failed.
  The corrected oracle admits only graph IDs received from the host and checks
  workspace identity, completed append-only journal, sequence, limits, and
  absence of symlinks. Added regressions for ten workspace violations and the
  previous tool cases; no blanket ignoring of extra model files.
- Complete rerun `qwen38-host-live/run-OA3r4y`: **2/2 PASS** with real weights.
  Agent reads/writes/rereads the exact JSON through the automatic Task Graph;
  Cowork produces and rereads the document with its tools. Both perform another
  read after a rejected Design switch; also verified the Agent → Cowork PID
  change and shutdown of test processes only. Observed times 58.63 s and
  73.61 s, including startup and recovery: not a comparative benchmark.
  Resident backbone 68.32 GiB plus SSD PLE, context 16,384, thinking/DSpark/MTP
  not requested, and production Agent sampling, different from the old CLI test.
  These are not the 100 held-out questions, a desktop test, or numerical equivalence.
- Also corrected descriptor cleanup on partial pipe/fork failure during
  Agent/Cowork startup. `make test-agent-spawn` verifies all eight combinations
  using the real spawn and deterministic failpoints, without launching weights/processes.
  Settings, README, and notices now distinguish integrated capabilities from tests performed.
- Final targeted gate for the Qwen tranche PASS:
  `upstream-main-audit-RA18fI/host-final-gates-eYoJCa`. Host rebuilt,
  preflight 24/24, cleanup 8/8 also ASan/UBSan, setup/oracle, inspect lifecycle
  on fresh install `66b0e3f`, Chromium/WebKit picker, and whitespace.
  The browser tester now preserves every attempt in a separate directory.
  Subsequent visual review: the menu is anchored, but the Send button can
  leave the composer at 390 px. This is a gap in the old assertions, not a
  PASS for the full layout; a separate regression started for all controls.
- P1/P7, narrow composer: reproduced Send extending beyond the edge in WebKit
  (`model-picker/webkit/run-Wgn6qr`, right edge 342.77 px with viewport 320).
  Constrained the toolbar to its area, allowed the model picker to shrink,
  and preserved space for the reasoning level. At narrow widths, the level
  remains readable, with its full accessible name. No controls hidden to make
  space. The first new assertion tried rounded corners (`run-0LSBWd`);
  corrected to use centerline points. Chromium also exposed the drawer still
  exiting (`run-T07Prf`, `run-wZQc94`): the tester now waits for the actual
  transition, without disabling it or extending the timeout. Failed receipts
  retained. Extended checks PASS in Chromium `run-0SaRmn` and WebKit
  `run-rnFTrO`; WebKit light 390/dark 320 screenshots inspected.
  This does not amount to the 40 desktop workflows required by P7.
- Qwen source audit continued on the `bd9cfbc` → `66b0e3f` delta: completed
  reading the affected core/server/Metal and Qwen/common shaders, plus CUDA/ROCm
  and memory entry points. Private note
  `upstream-main-audit-RA18fI/qwen38-source-review-66b.md`.
  Also read CUDA/MMQ/ROCm include deltas; hipBLASLt paths with fixed indices
  check version/revision and preserve the synchronous fallback.
  Hardware/numerical qualification and vision/eval paths remain separate:
  reading the code does not replace those tests.
- After the composer fix, full `make test-ui-browser` PASS; Agent/Design,
  gear, and context also repeated in WebKit, plus host build and whitespace
  PASS (`upstream-main-audit-RA18fI/composer-gates-oTVjSj`). Simulated engines
  in these UI suites; no new inference or reopening of the user's `.app`.
- Supplemental baseline `baseline-5KprYm`: 979 repository files, five checkouts,
  and 14 weight/component artifacts inventoried without errors. Weights were
  not reread in full and no models launched; this identifies the state before
  the subsequent Design builder tranche.
- P2, Design builder: reproduced replacement of a working program with
  incomplete linker output in the old script (`design-build/run-yHaxGo`,
  FAIL retained). Preparation now copies only bounded sources into a private
  directory and shares the native lease with Agent/Chat; it does not change
  original sources, objects, backups, or weights. The native parent publishes
  the candidate after the worker returns, not an orphaned compiler.
  The derived receipt binds the binary digest, sources/support, and Make
  configuration/compiler version. An interruption between the two renames
  does not certify a fresh build. This does not yet close all compiler/linker
  identity requirements or P2's multihardware matrix.
- First new suite `design-build/run-ZJqEKx`, 12/12 PASS. The extension anchoring
  scratch to `/dev/fd/N/child` fails on macOS devfs
  (`run-JKYB45`, `design-archive-build/run-6wH21w`): corrected using the retained
  descriptor's cwd and `openat` cleanup without following symlinks. No timeout
  extended; the tester now stops waiting for the barrier if the builder has
  already exited and copies the probe binary to prevent changes during the run.
  `run-O9vR8Y` and `run-aUQM4G`, 15/15 PASS; native Metal archive build with
  launch and invalidation after a change: `design-archive-build/run-70iSVk` PASS.
- Main Design build with real tools and simulated responses PASS, but the first
  matrix stops on Laguna (`agent-native-build/run-sLOsFD`, FAIL). The new full
  check detects four old logs, a comment, and an irrelevant header context
  that the old marker-only check ignored. Recorded `legacy-labels.patch`:
  it normalizes only the complete known delta in the private copy, then verifies
  the entire residency adaptation again. The new header context preserves
  the same resulting C. No change to the user's Laguna checkout or weakening
  of partial-implementation verification. `design-build/run-R1WDgJ`, 16/16
  PASS, includes complete and partial legacy cases; native adaptation
  roundtrip `run-Y8ACmy` PASS.
- Shared builder checks: Agent 8/8 (`agent-build/run-WQsfZo`), preflight 24/24,
  Design HTTP 13/13 (`http-GS8912`), asynchronous lifecycle 11/11
  (`launch-control/http-pQDwAU`), and setup unit tests PASS. Bundle built in
  `design-build-package-NN7IDr`: signing, catalog, and new batch command
  `--build-design ... status` PASS without a window or models. This is an isolated
  test bundle, not a restart of the user's `.app` or a qualified final release.
- Native Design matrix for the tranche repeated in full: **main, Laguna, and
  Qwen3.8, 3/3 Metal** (`agent-native-build/run-8G438L`) and **3/3 CPU**
  (`run-3HMHJl`), each with tools actually executed on simulated model frames.
  Original sources/objects and input checkpoints preserved. This neither
  enables Qwen Design in the host nor proves inference quality, CUDA/ROCm
  numerics, or model-generated projects.
- Toolchain signature strengthened with digests of compiler/linker programs,
  resolved Apple tools, and SDK identity. An unresolvable command can still
  compile, but does not reuse a cached receipt. Regression with real Make:
  changing a wrapper while keeping `--version` identical restarts the build.
  `design-build/run-o3U6a2`, **17/17 PASS**; new archive built/launched with
  invalidation `design-archive-build/run-CM5SCi` PASS. The previous ASan/UBSan
  gate on 16 cases is PASS (`run-9WAMnG`); the extended test is separate.
- Extended test **17/17 also ASan/UBSan** (`design-build/run-MnMQ8H`).
  Final bundle for this tranche alone,
  `design-build-package-NN7IDr/Verified-DStudio.app`, recreated with the new
  scripts/patches: smoke, signing, and windowless CLI dispatch PASS. No
  installation or reopening of the user's app, no push. The full campaign's
  quality and release gates remain open.
- P0 remains open (complete inventory of suites/cases and inference baseline
  for every variant), as does P1 (asynchronous lifecycle/responsive controls,
  races, and complete desktop regressions), along with phases P2–P11. No push
  or installation of the user's `.app` performed in this tranche.

### Qwen3.6 tranche — native tools, desktop enablement still pending

- Base `vagrillo/ds4` reconfirmed at `60fca11`: the server understands ChatML
  and `<function=...>/<parameter=...>`, whereas the original Agent recognizes
  only DSML/GLM. Real parser regression, without weights: **261/261 failures**
  across stream splits (`qwen35-agent/run-3fIGSr`), existing native unit tests
  green. The original receipt remains retained.
- New explicit variant `patch/ds4-agent-jsonl/qwen35.patch`, manifest 90:
  XML parser adapted from Qwen3.8 to the pin, native schema and Cowork tools,
  DStudio loop events/steering. Qwen3.6 fork tokenizer, ChatML terminators,
  weights/kernels, and loop retained; no DeepSeek Max prefix, PLE, expert
  streaming, or hidden new engine. The builder applies the variant to its
  own copy without modifying the original `ds4_agent.c`.
- An initial parser stress test times out (`run-NB6iAz`): repeated scans of
  the value and tail detected. Now uses an incremental value and fixed tail;
  deterministic counters verify linear cost at 4,096/65,536 bytes. Explicit
  limits: 1 MiB, 32 calls, 64 parameters/call, 127-byte names; rejection of
  duplicates, NUL, and incomplete calls. No timeout raised to hide the defect.
- New JSON case finds another alteration of escaped delimiters
  (`qwen35-agent/run-dGmKPU`, FAIL), also reproduced on the Qwen3.8 variant
  (`qwen38-agent/run-RoCXO6`, FAIL). Correction in **both** `.patch` files,
  retaining format and byte checks. Final ASan/UBSan parser/helper gates:
  Qwen3.6 `run-9jGF1S`, Qwen3.8 `run-pOfSo0`, PASS. Core/GPU objects not
  instrumented; simulated model frames, real filesystem.
- Complete patch qualification **5/5** (`agent-patch-migration/run-pxzSiM`):
  independent apply/reverse with Git, repeat/partial/drift rejected, and
  unrelated changes preserved. First attempt `run-EWVgAy` fails because it
  pointed to the old Qwen3.8 checkout; repeated with the exact archive already
  installed, without changing the expected baseline or redownloading sources/weights.
- First test with real Qwen3.6 weights: Agent and Cowork **2/2** in
  `qwen35-agent-live/run-rErOb7`, exact files and read after write;
  132.43 s and 403.36 s end-to-end, context 16k, temperature 0, seed 42,
  thinking off, resident model 29.65 GiB. These are development workflows,
  not a held-out benchmark or speed comparison. Light builds ran on the same
  host during part of the run; do not use these times to infer causality.
- Verification also finds the incomplete cache: the fork does not serialize
  Qwen3.6 recurrent state, but the original Agent produces `sysprompt.kv`.
  The variant now prevents reading/writing those checkpoints before the
  incomplete API, preserves live context, and does not present them as valid
  resume state. No old user file deleted. Behavioral guards PASS; final
  isolated native build retained in `qwen35-agent-port-4xl0lM/final-build.json`.
  Final rerun **2/2 PASS** (`qwen35-agent-live/run-J1p49a`): Agent 133.12 s,
  Cowork 405.08 s, same tasks and settings as the first test; exact contents,
  real read/write/reread tools, and absence of the incomplete-checkpoint
  directory verified in both cases. These times describe two development
  workflows, not a general quality measurement or performance comparison.
  No test process left running at the end.
- Native tests do not automatically qualify the host, menu, or desktop. The
  following tranche introduces Agent/Cowork launch in the host code, but
  cancellation/resume and packaging still require verification. No result
  here closes the 11/12 quality gap or remaining P3/P6/P7 requirements.
  No push, new weight download, or restart of the user's `.app`.

### Qwen3.6 tranche — host and session control under verification

- Host and menu now prepare Agent/Cowork on the correct Qwen3.6 checkout.
  Design, incorrect checkouts, a missing model, and forced expert SSD streaming
  remain rejected; rejection does not stop a working engine. The 28
  `make test-launch-preflight` cases pass. The explicitly missing file case
  must return 400 from the parser, not 409 from admission: oracle corrected,
  without weakening the state check or changing production.
- The fork accepts `--power`, but its Qwen3.6 path does not use DeepSeek graph
  throttling. The host omits that flag and reports effective power 100,
  leaving the requested preference intact for other models. No PLE, pruning,
  DSpark, expert streaming, or incomplete recurrent checkpoint.
- `/api/status` exposes `agentDiskCheckpointsSupported`; unsupported
  save/list/switch/delete operations are rejected before writing to the pipe
  or reassigning the conversation. `/new` remains distinct from checkpoint
  restoration. Tests on real pipes/processes without a model, 30 simulated
  UI-queue cases, frontend regressions, and Chromium/WebKit browser tests pass.
  These do not test model quality or the real desktop window.
- First real host test `qwen35-host-live/run-MJEBA6`: correct creation of
  `ready.json`, rereading, Task Graph journal, and continuation after Design
  rejection pass. The overall test remains **FAIL**: the subsequent turn used
  for interruption ends after only the text `1`, before the test observes
  generation. No interruption/reset validated; Cowork not run in this attempt.
  The cause remains to be distinguished between early native completion and
  observation of the state transition. Original receipt retained; question
  and deadline unchanged in the diagnostic rerun.
- Rerun `qwen35-host-live/run-ESmjuE`: **2/2 PASS** for headless Agent and
  Cowork workflows, with real generation interruption, `/new`, and rereading
  without altering earlier files. Resets completed in 197.30 s and 424.00 s:
  times from this development replay, not a comparable benchmark.
  Test host and children closed, and PIDs verified absent. The retry does not
  replace the first failure, whose cause remains unproven.
- New UI regression reproduced and corrected: the view could change during
  `await poll()`, and a now-stale command was still sent, also reassigning
  the conversation. The request is now revalidated before both effects.
  Six new Agent/Cowork cases prove rejection without sending or mutations;
  original red receipt in
  `qwen35-host-integration.uCG9pG/ui-stale-session-red.json`, then 30/30 PASS.
  Chromium and WebKit browser tests PASS with simulated engine responses.
- Real installation from an empty directory `engine-acceptance/run-VWIizT`:
  main and Qwen3.6 **2/2 PASS**, pinned downloads, compilation, and execution
  of the four/five expected binaries, including Qwen3.6 Agent/Cowork. No weight
  download or inference attributed to this gate. CLI repetition, HTTP setup,
  catalog, and selection: `qwen35-http-3JXnE1`, PASS; protected sources and
  binaries unchanged and GGUF store still empty. Light builds/network shared
  the host with part of the replay: times not used as a benchmark.
- Further issue to correct in native control: `/new` calls synchronous
  reset/prefill from the thread reading the pipe instead of delegating it
  to the worker. During Qwen3.6 reset, the host responds, but new progress
  events remain in the native buffer; interrupt handling also depends on
  returning to that loop. Reset completion followed by a reread does not
  prove cancellation or streaming during reset. A regression with blocked
  preparation, handoff to the worker, and correct preservation of previous
  state on error/cancellation is required before closing P1/P3.
- The user's `.app` has not been replaced or restarted. Desktop qualification,
  complete real controls, and P6 quality remain open; enablement in the worktree
  does not amount to a qualified release.

### Requested checkpoint — consolidate Qwen, then pause

- To provide the requested stopping point, this tranche consolidates the
  already integrated Qwen3.6/3.8. The resume summary is in
  [docs/QWEN_CHECKPOINT.md](docs/QWEN_CHECKPOINT.md); do not start other chapters
  automatically. Qwen27B and full P3 parity remain open.
- Corrected piped reset for both Qwen variants with `.patch` files, manifest **91**.
  The pipe thread admits work to the existing worker, which prepares a single
  candidate session with unchanged context and shared weights. Errors and
  interruptions do not destroy the previous conversation. Commit after
  revalidation, old buffers released outside the mutex, and terminal receipt
  before idle. The other three adapters and TTY reset have not been modified
  or qualified by these tests.
- Qwen3.8 publishes an autosave identity only after successful saving;
  previous images and metadata remain valid on failure. Qwen3.6 continues
  to reject incomplete recurrent checkpoints. No change to tokenizer,
  tensors, kernels, expert count, or precision.
- Red native baselines reproduced for both Qwen variants. With the distributed
  patch: Qwen3.6 **6/6** in `agent-session-reset/run-mHCmsD`, Qwen3.8 **7/7**
  in `agent-session-reset/run-wZAYRH`. Deterministic barriers, native threads,
  simulated inference; ASan/UBSan on adapters, not the precompiled core.
  The arm64 workers remain 2,144 and 2,184 bytes respectively; at most two
  total sessions during preparation. This is not a decode benchmark.
- Migration/application of the five adapters **5/5 PASS** in
  `agent-patch-migration/run-gk25s5`. Qwen3.6 parser/tools
  `qwen35-agent/run-uWi4Ah` and Qwen3.8 `qwen38-agent/run-B3Hnd8` PASS.
  CLI/HTTP setup repeated with patch 91: `qwen35-http-dqrmY1`, PASS,
  sources preserved, store still empty; no inference attributed to setup.
- The UI retains the link to the old conversation until reset succeeds;
  it consumes session receipts in Agent/Cowork as well as Design. Queue
  tests **34/34**, preflight **28/28**, pipes/processes **16/16**, frontend,
  Chromium, and WebKit PASS. The browsers use simulated responses and do
  not constitute E2E of the real `.app`.
- Two initial real Qwen3.6 replays remain **FAIL**: `run-KaB607` and
  `run-l76E5r` under `qwen35-host-live`. The first test searched for a contiguous
  code in the JSONL bytes; the second included the internal Task Graph marker
  hidden by the UI. Both visible responses contain the exact code; corrected
  the shared decoder for both Qwen variants, with regressions for interleaved
  frames, echoed question, terminal receipt, incorrect codes, and additional
  text. No original receipt rewritten. The separate counting failure
  `run-MJEBA6` still has no proven cause.
- Final replay results, stopping point, and resume commands are recorded
  in the checkpoint. The worktree remains local: no push, weight download,
  replacement, or restart of the user's `.app` in this tranche.
- Qwen3.6 reset replay `qwen35-host-live/run-rTxWZs`: **2/2 PASS**, Agent and
  Cowork, context recalled without tools after cancellation, second reset
  completed, and real reading of previous artifacts. Sources/weights preserved
  and test processes verified absent after shutdown.
- First Qwen3.8 reset replay `run-uAb5iW`: **FAIL retained**. The 4,358-token
  prompt fits in the single native block of 8,192: reset succeeds, but there
  is no observable intermediate point at which to test interruption.
  Upstream `ds4_session_sync` publishes `prefill_chunk` after each block.
  Extended only the inert Qwen3.8 fixture to exercise two blocks, without
  changing the engine or deadlines; the shared grader now requires
  `0 < done < total`. The four already passing Qwen3.6 receipts also satisfy
  this condition, without being rewritten.
- Second Qwen3.8 replay `run-QQtql2`: **FAIL retained** because the test
  erroneously included the technical autosave line in the answer. Reset had
  been cancelled and the code recalled correctly. Decoder corrected for both
  models, with a regression that executes the real UI segmenter and distinguishes
  system message, correct answer, and incorrect answer.
- Final Qwen3.8 replay `qwen38-host-live/run-pebGA0`: **2/2 PASS**, Agent and
  Cowork with real weights, two resets each (cancelled with context preserved,
  then completed), real tools, and reading of previous artifacts.
  No change to inference, chunks, precision, or deadlines to make the test
  pass. Different fixtures reflect different progress granularity and do
  not constitute a speed comparison.
- Stopping point reached: this reset campaign retains **six script attempts**,
  four documented initial failures, and two complete successful final runs.
  All replay processes are closed and verified absent; final targeted
  setup/preflight/spawn/oracle gates PASS, syntax and whitespace PASS.
  No new full gate, performance profile, `.app` release build, commit, or push
  attributed to the tranche. **Stop here until a new request.** P3/P6/P7 and
  the other chapters remain open.

Reference requirements: `Prompt_Codex_DStudio_Quality_Multihardware.md`,
SHA-256 `48598c56cdf2b8dfad9a66d4dedd56f6b1694d9285b10cbb3903fa2529c1fa74`.
The original file remains outside the repository. The user's subsequent
instructions about changes to external repositories are incorporated in
[AGENTS.md](AGENTS.md): changes must be preserved in versioned `.patch`
files, with the exact base and reproducible application.

## Contents

1. [Expected outcome and scope](#1-expected-outcome-and-scope)
2. [Baseline and existing work](#2-baseline-and-existing-work)
3. [Problems identified in the code](#3-problems-identified-in-the-code)
4. [Execution order and evidence recording](#4-execution-order-and-evidence-recording)
5. [P0 — Inventory, receipts, and baseline preservation](#5-p0--inventory-receipts-and-baseline-preservation)
6. [P1 — Startup stability and Design migration](#6-p1--startup-stability-and-design-migration)
7. [P2 — Upstream updates and patches for all engines](#7-p2--upstream-updates-and-patches-for-all-engines)
8. [P3 — Qwen27B and mode parity](#8-p3--qwen27b-and-mode-parity)
9. [P4 — PDFs, vision, and isolation of text models](#9-p4--pdfs-vision-and-isolation-of-text-models)
10. [P5 — Real clean installation and upgrades](#10-p5--real-clean-installation-and-upgrades)
11. [P6 — All suites, numerical quality, and answer quality](#11-p6--all-suites-numerical-quality-and-answer-quality)
12. [P7 — E2E of the real desktop app](#12-p7--e2e-of-the-real-desktop-app)
13. [P8 — Nine design systems and generated projects](#13-p8--nine-design-systems-and-generated-projects)
14. [P9 — Agent, Codex, Pi, and OpenCode comparisons](#14-p9--agent-codex-pi-and-opencode-comparisons)
15. [P10 — Profiling and permitted optimizations](#15-p10--profiling-and-permitted-optimizations)
16. [P11 — Final build, documentation, and publication](#16-p11--final-build-documentation-and-publication)
17. [Complete requirements map and closure](#17-complete-requirements-map-and-closure)

<a id="scope"></a>
## 1. Expected outcome and scope

Every included model must actually work in **Chat, Agent, Learn, and Cowork**,
with the selected model, the correct tools, and verified results.
Design is a fifth path, to preserve and improve separately.
Successful startup does not amount to quality; a model that currently fails
is not removed from the denominator. The four modes are not four labels for Chat.

### Observed physical inventory

Reading the shared `ds4/gguf/` directory found the following nine supported
LLM checkpoints. Sizes are the bytes actually observed, **not new SHA-256
checks**. Presence and size do not certify integrity. The abbreviated names
below identify variants, not interchangeable files.

| Campaign ID | Installed model/variant | Bytes | Current engine |
| --- | --- | ---: | --- |
| flash-iq2 | DeepSeek V4 Flash Chat IQ2XXS, 0731 | 86,720,111,488 | main |
| flash-abliterated | Flash 0731 Abliterated Headroom128 | 86,720,111,552 | main |
| flash-mixed | Flash Layers37–42Q4K / other experts IQ2XXS-Q2K | 97,591,747,456 | main |
| flash-mxfp4 | Flash MXFP4Experts / Q8Attn | 155,976,458,848 | main |
| flash-vision | Flash Vision-Exp IQ2XXS | 86,720,111,776 | main |
| glm53 | GLM 5.3 Flash Q2 | 96,505,816,384 | main |
| laguna | Laguna S 2.1 Q4_K_M | 68,248,759,648 | laguna-s2.1 |
| qwen38-next | Qwen3.8-Flash-Next Q4K/MXFP4 | 73,371,680,704 | qwen3.8-flash-next |
| qwen36 | Qwen3.6-35B-A3B UD-Q6_K_XL | 31,843,777,504 | qwen35moe-support |
| qwen38-27b | **Only new LLM family to download** | not installed | to be integrated |

Components observed in the same store:

- DeepSeek Vision-Exp encoder: 932,857,760 bytes.
- Qwen3.8-Flash-Next PLE: 32,000,157,440 bytes; this is a required component,
  not a tenth Chat model and not expert streaming.
- Flash 0731 drafter: 5,989,114,272 bytes; Vision-Exp drafter:
  5,989,114,528 bytes. Verify the exact pairing before DSpark tests.
- Encoder `GLM-5.3-Flash-Vision-Encoder.gguf`: **not present in this store**.
  Downloading the compatible component is included work, not a reason to
  exclude GLM vision. Also check the other managed paths before declaring
  it absent from the entire machine.

The final P0 inventory must query configured paths and deduplicate links
to the same store, preserving full filenames and file identities.
The catalog will not be used as an inventory of completed downloads.

### Explicit exclusions

| Item | Status/reason | Action |
| --- | --- | --- |
| DeepSeek V4 Pro, even if present elsewhere | OUT_OF_SCOPE, explicit request: too heavy | Do not load, download, or schedule inference |
| Other uninstalled LLM families | OUT_OF_SCOPE | No download; they do not become blocked work to complete |
| GLM 5.2 present, 262,036,650,048 bytes | OUT_OF_SCOPE: unsupported by the current `model_file_is_supported` filter | Preserve the file; do not use its presence as a reason to launch it |
| Ideogram 4 | OUT_OF_SCOPE, generation worker; provider `ideogram4-fp8` | Do not download/run |
| HunyuanImage 3 | OUT_OF_SCOPE, editing worker; provider `hunyuan-image3-instruct-nf4` | Do not download/run |
| MiniMax H3 | OUT_OF_SCOPE, video worker; API `MiniMaxAI/MiniMax-H3`, runtime `h3.c/Metal` | Do not download/run |
| llama.cpp | OUT_OF_SCOPE, explicitly excluded engine | No runtime, router, installation, executable numerical check, or fallback based on it |

The three worker IDs are confirmed in
[image-pipeline-run.py](scripts/image-pipeline-run.py) and
[dstudio_video.c](src/dstudio_video.c); they are not entries in the LLM picker.
Their existing functions must not be removed. Cases requiring those workers
must be inventoried and marked excluded, not replaced by fake images claimed
to be real. Still included: images/PDFs **input to LLMs**, desktop screenshots,
required vision encoders/projectors/processors, and local/CSS/SVG assets for Design.

### Capabilities to distinguish

- Standard Flash and Laguna currently have text paths; Vision-Exp and GLM 5.3
  have native vision integrations to verify with the exact components.
- Qwen3.6 and Qwen3.8-Flash-Next have text Chat and experimental Metal
  Agent/Cowork on their respective pins, but not yet Design. This is the state
  of the DStudio adapter, **not evidence that the checkpoint cannot have
  vision capabilities**. Verify original metadata, templates, and components.
  A dedicated projector already exists for Qwen3.6 in the q36 candidate:
  it must be analyzed, not excluded because the current launcher does not use it.
- Qwen27B requires both the text path and the vision/PDF path provided by
  the checkpoint. Do not call the integration complete after text decode alone.
- API, weight format, GPU backend, model, capability, mode, and memory
  configuration are separate axes. AMD Vulkan is not ROCm; `.q27` is not GGUF.

<a id="baseline"></a>
## 2. Baseline and existing work

### Observed identity

| Component | Observed reference | Evidence limit |
| --- | --- | --- |
| DStudio HEAD | `c42eaafcf3bc49c2ba261945b53a8b7ab3e4053c` | Heavily modified worktree: HEAD alone does not identify the current app |
| Local ds4 main / current pin / last verified remote | `f62ca29a308724cde5bc99134ede19104b2a3260` | Conservative fast-forward, native builds and network setup PASS; no new inference |
| ds4 main from the first campaign tests | `c0a6119f363ef82125877142f13fb3fe491cba14` | Previous receipts remain tied to this pin |
| Laguna launcher pin | `448d5695d1c86401a4e9447c440feb983b73e6de` | Archive directory; a source receipt to use as standalone evidence is missing here |
| Local Qwen3.8 fork | `bd9cfbccc03a709a3f00b50e0ac1cc41c3fcf02d` | Fork separate from updated main |
| Qwen3.8 installation pin / last verified remote | `66b0e3fc3bf0f548db1ec0c0dd19f4e43567a7f8` | Fresh install, build/kernels, and two real host workflows PASS; user checkout not updated, complete audit/matrix open |
| Qwen3.6 pin/local receipt | `60fca11f0c8b16ca50c757324dddd717ba043098` | `.dstudio-source.json` present; do not use the parent project's Git identity |
| Agent/Cowork | Manifest 86 at baseline, now 91 in `patch/ds4-agent-jsonl/` | Five `.patch` files, including both Qwen variants; complete qualification and other backends still open |
| Chat PLD | Manifest 3 in `patch/ds4-server-pld/` | Batch verification remains separate from ordinary generation |
| Available Mac | Apple M2 Max, 12 logical CPUs, 96 GiB RAM | macOS 26.5.2, build 25F84; approximately 1 TiB of free disk space at reconnaissance |
| Codex CLI | `codex-cli 0.153.4` | Only version/help checked; no inference request |

Warning: `git -C ds4-laguna-s21 log` and `git -C ds4-qwen35 log` climb to the
DStudio repository and return its commit. **They do not identify those engines.**
The Design build signature already avoids this error; other inventories and
runners must do the same. The declared Laguna pin must be checked against
the archive contents before qualification.

### Already implemented: preserve and extend

- Native installer with pins, shared store, resumable Qwen downloads, and
  artifact verification; headless setup using the production path.
- Agent derived from `ds4_agent.c`; Cowork uses the same structured runtime
  with Office tools; Design owns its loop in
  [ds4_design.c](extension/design/ds4_design.c). Do not replace them with the
  new engines' agents. Reusable transport lives in `extension/remote/`.
- Task Graph: real executors, policy, watchdog, append-only journal,
  pause/resume/recovery, checkpoints, and undo with declared limits.
- Goals and messages during execution in the worktree: scheduler, receipts,
  steering, and transport; tests with simulated frames do not qualify all LLMs.
- PDF: Poppler, full reading when within budget, dense+BM25 search,
  verifiable citations and evidence, modal highlighting on the physical page.
- Learn/Tutor: research → curriculum → audit → tutor pipeline, saved learning
  paths and progress. It must not be recreated from scratch.
- Five original offline packs: Folio, Signal, Forma, Grove, Pulse; gallery,
  iframe isolation, and geometric checks of generated results.
- Recent UI in the worktree: compact light/dark PDF sources, chooser for
  repeated citations, model picker anchored to the composer button.

### Previous evidence found and what it means

| Evidence | Retained result | What it does NOT prove |
| --- | --- | --- |
| [Engine acceptance of September 5](docs/ENGINE_ACCEPTANCE.md) | Flash 11/12, Laguna 10/12, Qwen3.8 12/12 | General quality, numerical equivalence, four modes, or new main |
| [Headless E2E of installed models](docs/HEADLESS_E2E.md) | Nine checkpoints, three checks each; **Qwen3.6 3/3 real** | Native desktop, 100 questions, Agent/Learn/Cowork, or visual understanding |
| Private receipt `installed-models-URjDda/results.json` | Initial run FAIL: eight models passed, Qwen3.8 failed a UI check | Must not be rewritten as nine passed |
| Receipt `installed-models-8aPJcF/results.json` | Targeted Qwen3.8 retry 3/3 | Does not replace the first run or requalify the other eight |
| [GLM M2 report](patch/ds4-glm53-m2max/PERF_GLM53_M2MAX96.md) | 100 continuations, 11,559 tokens, NLL 0.458046251, first-token 89/100, mean greedy prefix 7.110 | Does not mean 100 correct answers; the reference provides no logprob; does not qualify `c0a6119` |
| [Main update of September 5](docs/DS4_MAIN_UPDATE_2026-09-05.md) | 36/36 measured outputs correct; total including auxiliary cases **44/48** | Not an all-green campaign or measurements of September 7 main |
| [Main update of September 7](docs/DS4_MAIN_UPDATE_2026-09-07.md) | Native builds, patches, 27,979 PLD checks with a double, small Metal tests, and network setup of main | No new complete inference or CUDA/ROCm parity |
| [Real PLD](extension/prompt-lookup/bench/README.md) | 78 attempts: 66 PASS / 12 FAIL; Cowork newline defects retained | Universal batch speed/correctness, or results updated to the latest main |
| [Task Graph](extension/task-graph/README.md) | 50 tasks; direct DStudio baseline 42/50, checked/Pi/OpenCode 50/50 | The baseline named Native is NOT clean upstream ds4-agent |
| [Design](docs/DESIGN_AGENT_EXPERIMENT.md) | Real comparisons and defects retained; workshop regeneration timed out | An attractive screenshot or working controls do not turn a timeout into successful delivery |
| [PDF library](docs/PDF_LIBRARY_BENCHMARK.md) | Extraction/retrieval with real documents and embeddings | Correctness of the generated answer or understanding of pixels |

The cited private receipts are under `tests/.artifacts/`. Do not publish their
contents without review. Before using GLM data retained outside the project,
transfer only authorized evidence into a persistent ignored directory and
verify its hashes. Do not depend on `/tmp` for qualification.

**Discrepancy to correct in future documentation:** the README and tests README
still say Qwen3.6 has no validated real inference, but the 3/3 result above exists.
Correct wording distinguishes this small historical test from broad quality
and verification of the final build, both still missing.

<a id="problems"></a>
## 3. Problems identified in the code

These are reconnaissance findings, not fixes already applied by this delivery.
Behavioral reproduction will be required before correcting them.

| Inspected path | Concrete finding | Required action |
| --- | --- | --- |
| `web/index.html`: `loadDs`, `startDesign` | The old style is cleaned up when the gallery loads; the first start may send it earlier | Migrate before use, check the first request, P1 |
| `src/dstudio.c`: `api_start` | `task_begin` precedes design-system validation; the error branch does not end that task; other globals have already changed | Prepare/validate without mutations, admit once, close every failure, P1 |
| `tests/browser/ui_agent_design_playwright_test.mjs` | The start mock can accept the retired style; cleanup observed later | Assert the first start body and real endpoint behavior |
| `src/dstudio.c`: `spawn_agent`, `spawn_design` | Qwen explicitly rejected because the structured adapter is missing | Implement the contract, then remove the block; do not merely remove the if |
| `src/dstudio_engine_install.c` | Four engines, optional ones limited to macOS; Qwen builds only upstream runtimes | Set up DStudio runtimes and new backends, P2/P3/P5 |
| Launcher and supplemental make rules | Linker/libraries/objects now inherited from upstream: routing 16/16, real main/Laguna CPU/Metal builds | Launch/runtime and real Windows/CUDA/ROCm tests remain; simulated linking does not qualify them |
| `extension/design/build-design.sh` | Archive signature covers C/H/M/Metal/inc/mk but not all CUDA/Vulkan sources | Include `.cu`, `.cuh`, shaders, and relevant dependencies; prove an actual rebuild |
| `web/index.html`: Learn/Tutor | Requirement `DS4_TRUE_MAX_CONTEXT = 393216` is also used in generic paths | Derive thinking/context from model/engine; do not impose DeepSeek semantics on Qwen |
| `tests/live/real_roadmap_quality_test.mjs` | Five real cases, hardcoded Flash selection, and launch at 64k/off; deletion of previous artifacts | Parameterize, align with the product, add tutor/persistence; immutable receipts |
| `extension/task-graph/bench/run-cli-competitors.mjs` | Pi/OpenCode only; model pin and thinking limited to Chat Completions; clears results directory | Real Codex Responses, unique receipts, parameter/protocol verification, P9 |
| `src/dstudio.c` and UI | Several capabilities inferred from filenames/family | Distinguish checkpoint, adapter, encoder, and effective runtime capabilities |
| `src/dstudio_pdf.c` | Poppler and actual limits: 2,000 pages, visual handoff of at most four pages | Test limits/omissions/cancel and visual quality; do not remove budgets to improve the score |
| `docs/QUALITY_GATES.md`, Makefile | Historical gates specific to DeepSeek/resident/media; `check-real` does not include all real suites | Matrix and selection by requirement, without losing Learn, vision, or long-context coverage |
| Derived Agent/server/web patches | Agent migrated to three `.patch` files; web/server still `.find/.replace` | Complete the other migrations without losing behavior or variants |

<a id="order"></a>
## 4. Execution order and evidence recording

Planned sequence: **P0 → P1 → P2/P3/P4 → P5 → P6/P7/P8 → P9 → P10 → P11**.
P2 reopens before final validation if upstream has advanced. Deterministic
regressions accompany each tranche; they are not deferred until the end.
Builds applying patches in the same checkout and inference runs on the same
GPU are serial. Test environments are isolated from the personal installation.

For plan tasks, use `TO_DO`, `IN_PROGRESS`, `IMPLEMENTED_PENDING_VERIFICATION`,
`VERIFIED`. For every executed test, use only `PASS`, `FAIL`, `BLOCKED`,
`NOT_APPLICABLE`, with a reason; exclusions use `OUT_OF_SCOPE`.
A task not yet run is not PASS. Missing hardware may block a test; it cannot
turn a missing adapter into implemented code.

Each matrix row must contain:

```text
caseId, suiteRevision, mode, feature,
checkpointId, weightFormat, quantization, weightSHA256,
engineRepository, engineCommit, patchSetHash, binarySHA256,
backend, GPU/device, platform, driver/toolchain,
encoder/projector/processor identities,
requestedSettings, effectiveSettings, contextCapacity, processedTokens,
runId, repetition, inputHash, expectedResult, observedResult,
status, reason, timings, memory, artifactHashes, rawReceipt
```

The initial matrix has at least 10 planned LLM selections, not ten new families.
Different Qwen27B formats/quantizations and other backends require separate
rows. Do not create a Cartesian product of nonexistent combinations: identify
those supported or required, explaining the nonapplicable ones. The four
modes are always mandatory for every included model.

Proposed paths, **to be created during the campaign**:

- `tests/.artifacts/quality-multihardware/<run-id>/`: private inventory, diff,
  logs, requests, responses, screenshots, and original outputs; a new directory per run.
- `tests/fixtures/quality/`: frozen publishable cases, expected results, and rubrics.
- `tests/live/quality_multihardware.mjs`: coordinate the matrix using existing
  runners; not a second inference framework or application scheduler.
- `docs/benchmarks/quality-multihardware/`: reviewed public results,
  matrices, methods, Matplotlib scripts, and PNGs.
- `docs/ENGINE_UPSTREAM_ALIGNMENT.md` and its data matrix: upstream deltas,
  porting decisions, and gates; proposed names, not existing files.

<a id="p0"></a>
## 5. P0 — Inventory, receipts, and baseline preservation

Status: **IN_PROGRESS: local hashes completed; executable baseline still partial**.

1. Capture the commit, binary diff, and hashes of untracked files entering
   the DStudio build. Preserve preexisting changes without resets or mass
   reorganization. Also identify the bundles and binaries actually installed.
2. Enumerate configured stores, links, and files, separating LLMs, drafters,
   PLE, encoders, partial files, and excluded checkpoints. Verify GGUF/.q27
   metadata and full hashes with bounded sequential I/O. Reuse a verified
   receipt only when identity and integrity policy allow it.
3. For each engine, capture the real repository or archive receipt, commit,
   content/patch hashes, compiler, options, driver, and binary. A parent Git
   repository does not count. Laguna requires reconstruction of missing provenance.
4. Freeze the included/excluded manifest. Future downloads permitted only for
   Qwen27B and components required for included models' vision. No implicit
   LLM downloads by upstream runners or competitors.
5. Inventory **all** suites, individual cases, prerequisites, and latest
   results: unit, integration, browser, live, upstream, and publication.
   Excluded suites remain in the report with a reason; they do not disappear
   from the inventory.
6. Before execution, correct runners that empty results directories. Every
   run/retry retains a new receipt, input, environment, and artifacts; a resume
   appends events and identifies the original attempt instead of rewriting its result.
7. Resource preflight: space for archive/build/new checkpoint, RAM/GPU/SSD,
   concurrent processes. Heavy inference runs one at a time. Do not stop the
   user's app or models as a test side effect: coordinate GPU use and stop
   only processes belonging to the authorized campaign.
8. Capture a working baseline for every existing integration before updating
   sources or tool adapters. Historical receipts remain a comparison, but do
   not replace the baseline of the actual content to be changed.

Acceptance: manifest with no lost/duplicated files, all targets identified,
no inherited Git identity, no deleted results, reproducible tests tied to
binaries and sources. Full local hashes are now in the execution log;
coverage of all paths and the current baseline remains to be completed.

<a id="p1"></a>
## 6. P1 — Startup stability and Design migration

Status: **IN_PROGRESS: validation/migration fix verified without a model;
lifecycle/races and desktop test still to complete**.

Main files: [web/index.html](web/index.html),
[dstudio.c](src/dstudio.c),
[catalog](extension/design/design_system_catalog.h),
[UI test](tests/browser/ui_agent_design_playwright_test.mjs).

1. Reproduce with a persisted retired setting and an immediate click on Design.
   Record the first `/api/start` request, response, and task state, including
   with the catalog artificially held behind a deterministic barrier.
2. UI: validate/migrate the setting **before** constructing the payload. Reuse
   the authoritative catalog; no second hardcoded list. Distinguish a valid
   empty catalog from a failed network/not-yet-loaded catalog. Preserve project,
   skill, model, and other preferences; show an explanation and a usable selection.
3. Backend: construct a launch candidate with model, engine, mode, resources,
   skill, workdir, and design system. Parsing and validation must not alter
   current-runtime globals. Revalidate identity/generation before admission
   and before publication after build/loading.
4. An explicitly invalid ID through the API remains an error, not a fallback.
   If the task is not yet admitted, do not create it; if already created, end
   it once with a consistent error and taskId. The current model must remain
   usable after a rejected request. Catalog/package/runtime must agree.
5. Test valid, empty/none, retired, unknown, incomplete/missing pack,
   slow/offline catalog, reopening, style change, and double click. Assert
   the first launch, persisted state, and no hanging task, not source strings.
6. Extend to model races: DeepSeek → Qwen → DeepSeek, late readiness/download
   response, cancellation during prepare/load, long-running tool, error,
   window closure, and restart. Verify PID ownership, no orphans, exactly-once
   effects, and restoration of other models' SSD preferences.

Verification: real native HTTP tests with failpoints, labeled simulated
Chromium/WebKit browser tests, then the real desktop/model path in P7. A late
toast or a test that makes the mock green does not close the bug shown by the user.

<a id="p2"></a>
## 7. P2 — Upstream updates and patches for all engines

Status: **Agent/Cowork, web, and Chat PLD migrations verified on macOS;
main updated, Qwen3.8 in the Agent/Cowork launcher with two real workflows;
shader paths from external workspaces and private Design publication resolved;
complete qualification, upgrade of the old Qwen checkout, and the rest of P2 TO_DO**.

Remote main advanced from `c0a6119` to `f62ca29` during the campaign.
Changing main alone does not update the Laguna/Qwen forks.
Before each tranche and before the final gate, recheck the remote and record
the date/SHA, without performing a moving-target pull at startup.

### Common procedure

1. Record each engine's base, ancestor/delta if available, and already working
   adaptations: kernels, formats, quants, tokenizer, templates, vision, memory,
   KV, speculation, build, and DStudio tools. Preserve a working runtime.
2. Examine all main changes since the documented base, not just their titles.
   Map each to a model/backend. Examples in the current delta: session snapshot,
   GLM attention, Metal SSD, parser/tool boundary, and file/background tools.
3. Mandatory matrix: `upstream SHA/diff → engine → backend → model →
   previous behavior → equivalent adaptation → before/after tests`.
   States: integrated, already equivalent, not relevant with technical
   justification, unresolved. Divergence or complexity is not a reason for exclusion.
4. ds4 forks: integrate in isolated working copies with justified merges/
   cherry-picks/rebases, preserving integrations. q36/q27 engines: equivalent
   porting within their architecture where relevant. Do not replace the fork
   with clean main or apply DeepSeek patches to incompatible Qwen parsers/tensors.
5. Every change to an external repository goes into `.patch` files under
   `patch/`, with repository/exact base, order, and hashes. Scripts orchestrate
   application, verification, and restore: no adaptations available only in
   the dirty checkout.
6. Migrate historical Agent/server/web `.find/.replace` sequences into explicit
   patches for each supported base. First prove they produce equivalent
   sources and behavior; then update builders, manifests, bundles, and the
   [patch README](patch/README.md). Do not combine this with numerical changes.
7. Test fresh apply, repeat, restore, build crash/failure, partial patch,
   drift, incorrect order, wrong checkout, and preservation of unrelated
   changes. No ignored partial application. Tests exercise behavior as well
   as verifying source reconstruction.
8. Complete build signature: source/header/Metal/CUDA/Vulkan, manifest, adapter,
   compiler/linker/backend. Changing a dependency in a test must actually
   produce a new binary; the presence of a version number alone is insufficient.
9. Correct launchers and supplemental make rules to use the selected backend's
   arguments, objects, linker, and libraries. Preserve CPU, Metal, CUDA, and
   ROCm already present in main, and Vulkan where introduced. Do not declare
   a GPU supported because a CPU object compiles.
10. Add an automatic upstream-distance check, for example
    `scripts/check-engine-upstream.mjs`, with a revisions/delta manifest. It must
    detect new unclassified commits, lost patches, missing receipts, and
    regressions per combination; it must block promotion. Test it with
    divergent fixture Git repositories and real conflicts.
11. Keep only verified pins in the launcher. A broken build does not replace
    a working one; report the backend as not updated until gates pass.
    Repeat the analysis if upstream changes before final delivery.

P2.10 is now implemented and verified for the checker and macOS publication:
[method and limits](docs/ENGINE_UPSTREAM_ALIGNMENT.md),
[initial matrix](docs/engine-upstream.json). Missing reviews and receipts
remain admission errors; fixture PASS does not declare complete alignment
or the Windows workflow finished.

Acceptance: no unresolved relevant delta misrepresented as aligned, fully
reproducible patches, and coverage of previous integrations. Missing hardware:
procedure ready and runtime BLOCKED; missing port: incomplete requirement.

<a id="p3"></a>
## 8. P3 — Qwen27B and mode parity

Current status: **Qwen27B Q6_K_XL verified, CLI installer and real Chat
integrated, Settings download connected; first complete real path
Chat → Agent → Cowork → Chat → Stop 10/10 PASS** (`run-jUOR7P`). The fifteen
simulated host/tool scenarios also pass with an ASan/UBSan host. The real
test retains the four Python tests and independently verifies the Excel file;
it does not yet qualify all modes or general reliability. Previous Agent/Cowork
timeouts remain retained, without raising the 240 s limit. See the September 9
log above. Complete Learn, images/PDFs, other backends, and broad quality
remain open. Native computation history: after the numerical fixes, the text
replay passes 11/12, pixel/text replay 8/8, and the extended targeted HTTP/cache
replay 34/34 (images/control, tool results in all three native API formats,
and text checkpoints). Already-cancelled admission, native Stop by ID, and
private HTTP image preparation implemented. The private native text and payload
APIs pass 13 real cases; tool recovery is now owner-only, and the single-session
HTTP cache/prefill consumer prepares a private session. Semantic tool identity
passes 93 regressions, and the real HTTP/cache replay is confirmed 34/34 on
patch 2ea07d80; the v2 map recovers groups and ordinals and passes 84 native
checks. Recoverable parser allocations and scan limits remain. The batched
disk catalog and entire prefill now use private preparation and bounded GPU
transfers: 186 Metal cases, eight real-scheduler regressions with simulated
numerics, and full gate 34/34 PASS on patch 1677e0f6; real scheduled APIs
13/13 and HTTP cache/restart/Stop 15/15 versus 13/15 in the previous version.
The HTTP test did not observe a two-item decode batch. Subsequent upstream
numerical verification at 1/2/4/8 found scratch corruption at eight sessions:
fix `aa26ffa9`, 96 Metal regressions, and runtime gate 35/35; both real KV
phases now pass all 30 rows with matching argmax, and repeated HTTP 15/15.
The new transport passes 60 HTTP/pipe cases, and the interruptible reader
passes 36 host/runtime cases, also ASan/UBSan, with a simulated model.
Complete real-model qualification, HTTP worker cancellation, application
Stop of the resident server, broad quality, and mode gates remain. These
targeted tests do not amount to P3 closure.

### Candidates verified during reconnaissance

| Base and observed remote revision | Elements in the code | Plan decision |
| --- | --- | --- |
| [QuarkStar q36](https://github.com/Ninnix/q36/tree/d67687ed15ad9f52b755a9b5fdfc0214ea937555), `d67687ed15ad9f52b755a9b5fdfc0214ea937555` | Metal/Vulkan runtime, server API, Qwen27B GGUF, and dedicated projector | First choice to qualify for Apple + AMD |
| [Quasar q27](https://github.com/signalnine/q27/tree/bd8d8caf0941ff66eb6997c9cbb4780215899792), `bd8d8caf0941ff66eb6997c9cbb4780215899792` | CUDA server, `.q27` + tokenizer, tool/Responses parser; separate Metal path | First choice to qualify for NVIDIA |
| [ornith15](https://github.com/audreyt/ds4/tree/bde007a5757e2701761ce30c869fa7f82771857e), `bde007a5757e2701761ce30c869fa7f82771857e` | Qwen/DFlash APIs and dedicated tests in the ds4 fork | Alternative to compare for core reuse, not an automatic replacement of main |

Choosing q36 + q27 limits new engines to two and uses their respective hardware
paths. This is an implementation decision **conditional on the gates**, not
a claim of already verified support. Before downloads, also pin licenses,
checkpoints, quantizations, hashes, compatible tokenizer, and processor.

Correction to the reconnaissance, verified during implementation: in
[q36.c at the pin](https://github.com/Ninnix/q36/blob/d67687ed15ad9f52b755a9b5fdfc0214ea937555/q36.c),
the helper named `q36_engine_uses_vulkan_runtime`, used by
`q36_engine_vision_encode` and `q36_session_sync_vision`, already accepts Metal
as well. The error message was misleading. The Metal link lacked the MRoPE
operator, and the encoder used CPU matmul/attention: the patch completes Metal
operations; shared span insertion is now tested with four PNGs and the real
model. OpenAI HTTP transport now passes 21 targeted tests; app integration
and required visual quality remain open.
In the inspected q27 path (`src/server.cu`, `src/api_common.h`), no equivalent
image handoff was found: CUDA vision implementation remains to be completed
and verified, not relabeled as text-only.
[PR 844](https://github.com/antirez/ds4/pull/844) must be evaluated for its
actual Qwen/DFlash coverage, without automatically attributing vision or
numerical parity to it.

### Work on the new engines

1. Separate model in catalog/UI, with the internal engine selected from the
   device's actual capabilities; do not reintroduce the technical branch
   dropdown. Detect GPU/driver/features/versions and show limits and actual configuration.
2. Extend the native installer, `download-model.sh`, bundle, and doctor. The
   upstream q36 downloader uses moving `resolve/main` URLs: DStudio must pin
   the revision and hash, with resumable transfer and atomic promotion after verification.
3. For Apple/AMD, select a compatible Qwen27B GGUF after quality comparison;
   for NVIDIA, use `.q27` artifacts and the matching tokenizer. Do not rename
   GGUF files or also download Qwen3.6 through the candidate's default target.
   Avoid duplicate downloads except required representations of the same 27B.
4. Engine startup, readiness, stop, error, deadline, stream, and cancellation
   must enter the DStudio lifecycle, with the actual binary and model in the receipt.
5. Port the expected encoder, preprocessing/resize/tiling, projector, image
   tokens, positions, and KV synchronization to Metal/CUDA; qualify the
   existing Vulkan path. Integrate PDF → rendered pages without confusing it
   with the model's native input. All external changes are `.patch` files;
   no hidden use of another model's encoder.
6. Compare q36/q27/ornith before promoting an alternative choice: correctness,
   memory, session behavior, and maintainability before tok/s. The q27 Metal
   path does not receive parity by inference from its CUDA path.

### All models: four modes actually integrated

1. Extend the adapters of the already installed Qwen3.6/3.8 as well as the new
   family. Preserve the forks' kernels/layouts/quants and working behavior.
2. Retain the loop and tools of ds4-agent as adapted by DStudio. In the forks'
   native core, adapt templates, reasoning, tool parser/envelope, results with
   call IDs, and subsequent turns. For engines with a different API, reuse
   the `extension/remote/` transport boundary with an explicit local adapter,
   not the q36/q27 agent. The model renderer remains in its engine.
3. The current remote adapter constructs text messages: extend it where
   needed to structured tools/images without converting Qwen format to DSML
   through simple string replacement. Test real produced and consumed frames,
   errors, and arguments byte for byte.
4. If an inference server remains resident while the Agent/Cowork frontend
   is lightweight, identify its PID, ownership, lease, and cancellation
   separately. Do not load two copies of the weights or reuse another user's server.
5. Cowork retains confined Office/document tools, without arbitrary shell;
   adapt tool/schema/result selection, `document_table`, and persistence.
6. Learn uses the selected server: make thinking and context, JSON templates,
   research, audit, and Tutor model-specific. Do not impose 393,216 tokens
   because DeepSeek Max requires them, or silently lower the setting. Expose
   any incompatibility and implement the corresponding native semantics.
7. Separate capability record for checkpoint/engine/backend/mode/encoder.
   Replace obsolete Qwen whitelists only after implementation and tests.
   The displayed model must match every call, including judge, tutor, tool
   round, retry, and resume. No hidden DeepSeek fallback.
8. Preserve and verify Design where already integrated; do not degrade
   DeepSeek, GLM, or Laguna to add Qwen. Any newly exposed Design integrations
   must receive the same qualification, not an automatic label.

Acceptance for each available combination: real installation, response, tool
with a verified effect, complete Learn, Cowork with reopened export, streaming,
and cancellation; vision where required. For inaccessible NVIDIA/AMD hardware,
prepare builds/scripts and report runtime BLOCKED without using maintainers' hosts.

<a id="p4"></a>
## 9. P4 — PDFs, vision, and isolation of text models

Status: **PDF/vision foundation present; complete coverage and new adapters TO_DO**.

Reuse [dstudio_pdf.c](src/dstudio_pdf.c), evidence/embedding modules,
attachment/history preparation in `web/index.html`, Cowork tools, and native
vision. Do not add a second RAG system or a fallback VLM.

1. For each checkpoint, establish original vision capability and exact
   encoder/projector/tokenizer/processor compatibility. Distinct states:
   native to the checkpoint, implemented in the engine, component installed,
   active in the mode, verified on that backend. A missing adapter remains open work.
2. Verify component downloads, revision/format/hash mismatches, corrupted
   caches, cancellation, and resume. Record the component actually loaded,
   not only the one available in the catalog. Complete GLM and Qwen where required.
3. Explicit limits for bytes, pages, resolution, patches/tiling, context, and
   memory. Rendering/encoding outside interactive control and shared locks;
   cancellation interrupts work and prevents late results.
4. Preserve original bytes, document/page hashes, physical numbering, and
   quotes. Distinguish direct reading, text retrieval, possible OCR, and pixel
   understanding. Report omitted pages/truncation and unreadable PDFs.
5. For every vision model, create **at least 30 PDFs + 20 images**, in addition
   to the 100 text cases: native, scanned, mixed, multipage, table/chart/diagram,
   small text, rotations, image order, and unanswerable questions. Include
   facts available only in pixels, with an independent oracle and checks that
   extracted text does not contain the solution.
6. Run these cases on the real model/encoder; preserve payloads and hashes,
   expected results, outputs, times, and failures. Exercise Chat, Agent, Learn,
   and Cowork with attachments or tools; the same encoder must actually receive the images.
7. Test protected/corrupt PDFs, missing pages, large inputs, missing or incorrect
   encoder, cancellation during rendering/encoding, resource exhaustion, and
   a subsequent valid request. No “read everything” after partial truncation.
8. For Laguna and every **verified text-only** checkpoint, block pixels,
   visual embeddings, audio/video, and vision tokens in UI, API, history builder,
   tools, and runtime. Attachments remain saved; the UI explains the limit.
   Test the payload actually received and that the encoder is not activated,
   not merely the absence of a button.
9. Vision → text → vision, in all four modes, after reload: history, tool
   results, summaries, cache, and KV must not reinject incompatible data.
   Complete cache key, model/generation revalidation, and discarding of late
   responses. No encoder download triggered by a text-only model.
10. Text models may receive extracted text through a declared tool; a scan
    without text produces an explicit limit, not an invented description.
    Vision NOT_APPLICABLE does not exempt a model from negative multimodal tests.
11. Verify citation → chooser → page → highlight with Poppler and a real
    browser, light/dark and a reopened session. Finding a quote does not mean
    the answer or calculation is semantically correct.
12. Add these suites to the gates for engine/backend/encoder, context, memory,
    and mode updates. Avoid any blanket “no multimodal” exclusion.

Acceptance: verified facts with a documented pixel path for vision models;
observable isolation for text models; files and pages intact after errors/cancel.
The user's private PDFs do not become public fixtures: publish aggregates
and hashes/provenance, not texts, questions, quotes, or personal paths.

<a id="p5"></a>
## 10. P5 — Real clean installation and upgrades

Status: **runners already exist; extension to the entire matrix TO_DO**.

Reuse `src/dstudio_setup.c`, `src/dstudio_engine_install.c`,
`tests/live/engine_acceptance.mjs`, `first_launch_e2e.mjs`, and
`installed_models_e2e.mjs`. The existing headless test intentionally blocks
weight downloads and model startup: it cannot alone satisfy the new complete chain.

For **each included engine**:

1. Empty engine/cache directory, task-owned profile, launch from a relocated
   bundle and a path with spaces. Use the production UI and resolver: model →
   engine → pinned archive → integrity → patches/adaptations → build → binary → readiness.
2. Reuse the other verified weights through a shared path without copying or
   moving them. Actually download Qwen27B into the managed path; include its
   required formats and authorized vision components.
3. Record the resolved URL, commit, archive hash where available, contents and
   dependencies, logs, patch manifest, and build. Verify hash/version/path of
   the **launched binary** and loaded encoders. Do not accept an old binary
   after the new one fails to compile.
4. Run controlled inference and a complete task for each of the four modes.
   For vision models, also pixels/PDFs; for text models, no vision components.
5. Repeat from a previous working installation, preserving settings, projects,
   required local patches, compatible format/KV, and the model store.
6. Fault matrix: unavailable/failing network, interrupted/resumed download,
   corrupt cache/archive, partial installation, missing dependency, patch/build
   failure, concurrent installation/update requests, reopening, and reused cache.
   No overwrite of a nonempty user directory and no double publication.
7. Preflight/staging outside locks, small commit after revalidation. Distinct
   downloading/verified/selected/loading/running states and real progress;
   recoverable pause/stop without lost bytes or premature “100%”.
8. Equivalent bootstrap on every available platform; scripts and BLOCKED
   results for unavailable hardware. Headless/HTTP help cover the fault matrix,
   but the real desktop chain remains P7.

Current entry points, **to be parameterized before new runs**:

```sh
make test-engine-setup-unit test-qwen35-download
make test-first-launch-e2e
node tests/live/engine_acceptance.mjs --setup --engines main,laguna,qwen,qwen35
node tests/live/engine_acceptance.mjs --infer --engines qwen35 --via-app
node tests/live/installed_models_e2e.mjs tests/.artifacts/first-launch-<run> ds4/gguf
```

New Qwen27B/backend IDs and manifest filters will be options implemented
in P3/P5, not arguments already accepted by these commands. Do not execute
heavy entry points before P0 preflight and separation of out-of-scope cases.

<a id="p6"></a>
## 11. P6 — All suites, numerical quality, and answer quality

Status: **initial inventory of existing suites completed; full campaign TO_DO**.

### Suites to preserve and extend

| Surface | Existing entry points | Campaign work |
| --- | --- | --- |
| Setup/inference | `test-engine-acceptance`, `test-inference-live`, `installed_models_e2e.mjs`, `test-qwen-chat-live` | Every included model, no fallback, actual context/memory |
| PLD/ABI/patches | `test-agent-pld`, `test-pld-build`, `test-glm53-m2max-patch`, `test-main-decode-metrics`, `test-steering-patch` | All relevant bases, `.patch` lifecycle, separate real numerical tests |
| State/Goals/steering | `test-goal`, `test-steering`, `test-steering-runtime`, `test-task-graph-unit`, `test-task-graph-http` | Races, durable replay, exactly-once tools, all adapters |
| Cowork | `test-cowork`, `test-cowork-bench-validate`, `test-real-cowork`, `test-real-cowork-long` | Every LLM, sources, formulas, revisions, reopened exports |
| Design | `test-design-runtime`, `test-design-bench-validate`, `test-real-design`, `test-real-design-long`, `design_originals_comparison.mjs` | Packs and runtime; explicit excluded worker cases, not pixel exclusion |
| Learn | `test-real-roadmap-quality`, `real_roadmap_audit_stress_test.mjs`, roadmap browser tests | Parameterized model, product pipeline, Tutor/assessments/progress/reopen, and vision |
| PDF | `test-pdf-complete`, `test-pdf-evidence`, `test-real-pdf-rag`, `pdf_library_benchmark.mjs` | Extraction, retrieval, and answering are three different results |
| Vision/Metal | `test-vision-streaming-live`, `test-ssd-prefill-batch-live`, `test-ui-live-vision` | Small kernels and layers do not replace the full model; expand backends |
| Other existing quality coverage | `test-real-search-research`, `research_pipeline_benchmark.mjs`, `search_quality_benchmark.mjs`, `test-real-ascii-diagrams`, `test-real-math-explanations` | Record every applicable case, failure, and context |
| Remote transport | `test-real-remote`, UTF-8/LAN/HTTP and remote runtime | Common code mandatory; cloud tests BLOCKED if credentials/access unavailable, no new LLM download |
| Browser/packaging | Settings/picker/Agent/roadmap tests, `test-macos-bundle`, `test-design-originals` | Chromium + WebKit; packaging is neither desktop E2E nor quality |
| Performance/product | Task Graph, PLD, main-decode, product comparison runners | Separate baselines and samples; no old run republished as new |

The P0 inventory must also include suites not named in this table and assign
every case a status/cause. Media suites remain inventoried as OUT_OF_SCOPE
for this campaign. Model-free checks of common boundaries may remain
applicable without launching excluded workers.

`make check-real` currently calls only some live suites. `make check` is
therefore not a shortcut for “all required tests”. Prepare a campaign runner
that checks coverage and denominators, not a shell command that continues
while ignoring exit codes. Also run standard/long and slow cases.

### A. Numerical correctness

1. Use the inspected upstream oracles:
   [QA](https://github.com/antirez/ds4/blob/c0a6119f363ef82125877142f13fb3fe491cba14/QA_BEFORE_RELEASES.md),
   [TESTING](https://github.com/antirez/ds4/blob/c0a6119f363ef82125877142f13fb3fe491cba14/docs/TESTING.md),
   [quality-testing](https://github.com/antirez/ds4/tree/c0a6119f363ef82125877142f13fb3fe491cba14/gguf-tools/quality-testing).
   Personal machines named upstream are not available infrastructure.
2. For tokenizer/templates, token IDs, and stop markers, use fixtures from
   the correct checkpoint. Flash 0731, Vision-Exp, abliterated, GLM, and Qwen
   do not share identical vectors by name. Where a compatible oracle is missing,
   prepare it or record the blocker; do not transfer a PASS from another family.
3. Verify finite logits, prefill/decode, quant/dequant, attention/GDN,
   recurrence, KV save/load/replay/rewind, the last snapshot byte, multiple
   sessions, context boundaries, and cancellation. Numerical regressions
   with justified model/quant/backend tolerances; exact identity only where
   the contract requires it.
4. Vision: preprocessing, resize/tiling, encoder/projector, image order,
   inserted embeddings, positions, and session state; compare every new path
   with a compatible oracle. A correct Poppler render does not qualify the encoder.
5. Run relevant upstream gates for OpenAI/Responses/Anthropic servers,
   tools/reasoning, caching, and kernels with ASan/UBSan where available.
   Distribution and multi-GPU: explicit applicability, hardware test BLOCKED
   if required but unavailable. Do not start aggregate targets that load Pro/GLM5.2.
6. GLM 5.3: rerun the **100 continuations** for the matching checkpoint and
   relevant long-context cases; preserve NLL, first-token, greedy agreement,
   and logprob coverage. Compare the historical baseline without calling it
   100% accuracy. `score_official` must be verified for each architecture;
   Qwen does not automatically inherit support because an executable compiles.
7. Use references already available and relevant; no llama.cpp installation
   or download of another family to produce an oracle. An archived vector has
   its own provenance and limits; it is not proof of a runtime executed here.

### B. Controlled answers: at least 100 common cases per LLM

September 9 progress: common corpus and executable grader implemented;
`make test-common-quality-oracle` passes with reference/simulated responses,
not with an LLM. First real 27B run ended in
`tests/.artifacts/engine-acceptance/run-pnsGev`; context 65,536, quality/F16,
thinking off, and corpus/criteria frozen before inference: 55 PASS, 33 FAIL,
12 not run. Separate re-evaluation after an independent interval-grader
regression: 56 PASS, 32 FAIL, 12 not run; only one result changes, without
new inference or altered inputs. One FAIL is transport-related: the client
interrupted the first long context at 300 s instead of the required 900 s.
Corrected by reusing the native HTTP client and verified with a real response
at 305 s; limits were not raised. Calculation, code, patch, and format failures
remain in the run. The next attempt must be `development-replay`, with all
original receipts retained. This does not close P6: a complete result, analysis,
all included selections, and the other numerical/product tests are required.
Details and limits in the Qwen checkpoint.

Replay `engine-acceptance/run-04wsyc` ended on September 9 at 10:04:21 UTC:
same model/binary, context, prompts, and deadlines; new interval-grader
identity and corrected transport. **56 PASS, 32 FAIL, 12 not run**. One FAIL
is native, not an answer failure: HTTP 500 after 748.26 s, Metal command
interrupted with `ImpactingInteractivity` at token 25,344 of 50,869. The
subsequent nonfinite-values message alone does not distinguish a numerical
error from GPU failure. Tester engine closed and port released. Native
correction still to be found; this is neither complete qualification nor
a timeout at the planned 900 s deadline. Model-free Design builds/browser
tests also ran on the same host during the run: no causal latency or speed
comparison is inferred.

The isolated F16 command then reproduces `ImpactingInteractivity` without
weights. Patch `75764a9f…` splits queries without changing shaders, precision,
arithmetic order, or context. Gate `q36-metal-runtime/run-ImYLpv` **40/40 PASS**,
including comparison of every query, view limits, and submission failures.
Network installation into an empty directory PASS. New real run
`engine-acceptance/run-82sH0Q` starts at 10:28:36 UTC, same 100 cases and limits,
with explicit supervision: at most eight restarts of the tester's engine only,
reaped before the next, without retrying or deleting failed cases.
Result still in progress; this is not qualification of the model or final app.

Subsequent results from the same run: case 88 still a native FAIL,
`ImpactingInteractivity`, full-attention layer 23 at token 26,240, 830.63 s.
Cases 89–91 fail at the original deadline of approximately 900 s. Snapshot
while case 92 is in progress: 56 PASS, 35 FAIL, 9 still to finish. Four restarts
of the owned engine verify shutdown before new admission and continue with
the next case, never with a retry that erases an error. The query patch alone
does not resolve the failure in the full model; GPU command diagnosis remains open.

September 9 source tranche: complete review of the new q36 commit `d02b6a20`
only (CLI/PTY and tests, no core/kernel changes), terminal patch `a45090e3…`,
and gate `q36-agent-tty/run-sruxs17f` **24 phases PASS**. `NO_TERMINAL` baseline
retained, seven scenarios with fake secrets, 32 normal/cancelled jobs without
leaks, unchanged layout, identical oracle correction for both variants.
The previous timeout remains FAIL: it was a reader loop on EOF, now reproduced
and corrected without raising limits. This is not Agent quality.
Installer/upgrade to this pin still to be promoted; no new app.

OS profile `q36-live-diagnosis.fboseS/native.sample.txt`, three seconds of
case 91, attributes 2,143/2,642 worker samples to the attention-tile wait;
disassembly of the frozen binary confirms the point after `endEncoding`,
not the preceding preparation. This is a time sample, not the proven cause
of the watchdog or a benchmark. Separate diagnostic patch `83c792f8…` enables
driver encoder states only on request, with four reports of at most 64 lines
per GPU initialization, no mathematical or run changes. Gate
`q36-metal-diagnostics/run-5p3pcw` PASS (real Metal + labeled simulated errors),
diagnostic server build PASS. Real reproduction with diagnostics must wait
for this run to finish; do not launch a second LLM. P0–P11, numerical tests,
and all 100 cases remain in scope.

`run-82sH0Q` closed on September 9 at **14:42:14 CEST**: **61 PASS,
39 FAIL, 0 not run/pending**. Cases 93 and 94 also failed due to
`ImpactingInteractivity` (token 23,168/layer19 and 23,552/layer43), not deadline
expiry. Long-context total: three native errors and five 900 s deadlines;
the other 31 failures are answer/format failures. Last engine 83745 reaped,
port 63809 free; eight handoffs verified without retrying failed cases.
Sources/weights preserved; aggregate still ignored with the original receipts.
P6 is not closed: the diagnostic command has not yet been reproduced with the
new binary, other models/oracles/modes remain, and no speed benchmark or
final qualification is inferred from the 61/100 result.

The subsequent targeted reproduction ends in `q36-retained-diagnostic/run-fX3sws`
at 15:19:26 CEST: HTTP 500 after 882.23 s, before the original 900 s limit.
Single driver encoder **Faulted=4**, `q36_attention_f16_parallel`, command
`attention-tile pos=27196 queries=12 heads=24`; full-attention error at layer23,
chunk start 27136. The F16 command involved is now identified, not merely
a wait in the OS profile. This does not prove RAM exhaustion or yet resolve
the defect. Same weights/hashes, request, and settings; diagnostic candidate
d02b6a20 with explicit patches, no mathematical change and no retry.
26,663 bytes of full logs, inputs/sources unchanged, engine 89128 reaped
exit 0, runner exit 1 for the inference FAIL, and port 65048 released.
61/100 remains unchanged. Originally failed ID/snapshot preflights retained;
admission helper and overlapping-patch roundtrip verify 10 groups, including
files added by a patch and preservation of unrelated changes. New correction
of the F16 path, operators/numerics, and the full model still to complete;
no updated app or publication is inferred from the diagnosis.

Subsequent F16 tranche: new overlay `patch/q36-f16-attention/runtime.patch`,
SHA `f4ff02bb…`, on candidate d02b6a20 after the three recorded overlays.
Two ordered passes, at most 1,024 positions and 8,192 query/head pairs per
command, 64 KiB of private temporary state. No change to precision, context,
requested prefill, or sum/FMA order. The original kernel remains the
independent reference and short path. Metal build PASS; 13 GPU numerical
cases PASS (`run-rbLfBX`), including thresholds, sinks/extreme values, views,
allocations, submissions, and failure at each of the eight encoder-creation stages.
18/18 lifecycle PASS (`run-IYU0dg`): the tester found and corrected ambiguity
in partial application and incompatibility with unrelated appends. Originals
`run-fwTex3`, `run-ian9Sq`, `run-bf2pDf` retained. Make dependency verification
is distinct from a fresh installation or full P2 binary qualification.
Owner 52/52, cache 8/8, HTTP batched 24/24, and cancelled admission PASS,
with simulated numerical sessions and sanitizers where specified.
Preflight `run-QGuUWs` PASS, four patches restored/reapplied in a private copy
and 210 files preserved. Real replay `q36-retained-diagnostic/run-DKItGr`
started with the original request, full weight hash, and 900 s deadline:
wait for the terminal receipt. Do not promote the patch in the launcher or
change the 61/100 baseline because of these gates; real qualification, other
selections, and the whole of P0–P11 remain open.

`run-DKItGr` result: **FAIL at the original 900 s deadline**, no answer;
last prefill before expiry 29,952/50,869 (58.9%). The next chunk completes
during teardown at 30,080; it does not count as completion. No new Metal
error recorded, no evidence of a complete fix. Inputs, sources, and weights
preserved, 29,106 bytes of full logs, engine 8401 reaped exit 0 without
escalation, and port 50928 free. A 3 s OS profile of the active worker:
1,683/2,613 samples in the segmented F16 wait; this does not identify each
shader's cost or prove a speedup. The HTTP catalog remains queryable during
prefill. Next work: profile both passes and correct prefill cost without
weakening precision, context, results, or deadlines. P6 open.

Update verified on September 12: F16 overlay `893f7f07…`, queries in registers,
value prefetch, and 4 KiB of threadgroup scratch. Lifecycle gate 18/18 and
operators 18/18; five alternating AB/BA pairs all pass the same 18 cases.
On synthetic inputs of 50,741 positions/128 queries, median operator wall
time 423.343→301.241 ms and GPU time 351.618→232.675 ms. These are not chat
or quality measurements. Subsequent real replay
`q36-retained-diagnostic/run-ylEDRa` is **FAIL** at the unchanged 900 s deadline:
last chunk within the deadline 33,152/50,869 (65.2%), no answer; chunk 33,280
completes only during teardown. No new Metal error recorded, engine exit 0
reaped without escalation, 32,172 bytes of logs, and inputs/sources/weights
preserved. No test still active, promotion to the installer/app, deadline
increase, or change to the 61/100 baseline. The distinction between upstream,
adaptation, and grader defects is explicit in the public checkpoint.
P6 and the rest of P0–P11 remain open.

Prepared for P11: report `extension/benchmarks/qwen-quality/`: public JSON
identical to the retained 61/100 aggregate (SHA 503df97d…), Matplotlib script,
and inspected PNG, linked from the README. No private answer, prompt, or
personal path exported; counts remain those of the original receipt
(61 PASS/39 FAIL). The chart does not measure the new F16 patch or an Agent
and does not compare speed. Bar/denominator tests and the public projector's
unit test pass. This is not yet a push or final P11 delivery.

Freeze at least this initial distribution, identical for every included model:

| Area | Minimum cases | Oracle |
| --- | ---: | --- |
| Calculation and explicit units | 12 | Independent calculation, problem conditions |
| Verifiable reasoning | 12 | Solution/constraint checker |
| Generated code | 15 | Tests executed outside the model |
| Debugging | 10 | Before/after tests and files to preserve |
| JSON/schema | 10 | Parser and semantic schema |
| Extraction | 10 | Expected fields and frozen sources |
| Strict instructions/format | 10 | Observable constraints, without retrospective leniency |
| Italian/English | 8 | Expected result/rubric appropriate to the task |
| Long context | 8 | Needle/relationships not revealed by the final prompt |
| Insufficient information | 5 | Verified absence, no invented facts |
| **Total** | **100** | |

- These are additional to upstream continuations, tool/document tests, and
  the 30 PDFs + 20 images for each vision model. With ten selections, the
  initial minimum is 1,000 text executions on one path each; additional
  backends/quants require new rows, not a shared result.
- Substantially expand the Qwen3.6 3/3. Startup checks remain smoke tests;
  changing their title does not turn them into a quality battery.
- Deterministic graders where possible; frozen rubrics for open outputs.
  A separate, declared LLM judge may assist but cannot be the sole decision-maker
  for its own answer. Distinguish development replay from held-out evaluation.
- Wrong answers, omissions, timeouts, context/truncation, and crashes remain
  in the denominator. Grader corrections only with evidence of a defect,
  a regression, and identical application to all variants; never raise a timeout
  to hide a bug.

### C. Product quality

For every LLM, verify complete Chat, Agent, Learn, and Cowork tasks, persisted
state, and reopened outputs. In Learn, verify facts, prerequisites, consistency
between lesson/exercise/correction, references actually provided, and progress.
In Cowork, check cells/formulas, data, revisions, DOCX/PDF/XLSX/PPTX content,
and exports. Include failed tools, intermediate instructions, and resume
without duplicated effects.

Concurrency tests use barriers: a blocked worker does not block status/cancel,
a stale candidate cannot commit, duplicates cannot double-publish, failure
does not lose data, and journal replay preserves order and durability. Do
not add tests that check for comments, CSS, or names in the source.

<a id="p7"></a>
## 12. P7 — E2E of the real desktop app

Status: **IN_PROGRESS: one Qwen3.6 Chat workflow and one Qwen27B Chat workflow
verified in the real app; model/mode matrix and desktop regressions still to complete**.

Previous headless WebKit coverage is a complementary layer. The new test must
use the real `DStudio.app` in the foreground, mouse/keyboard or desktop
accessibility, the launcher, and real weights. Do not replace it with DOM
scripting or a separate browser.

1. Prepare an isolated copy/profile with the tested bundle and its own ports;
   request any necessary desktop/accessibility/recording permissions. Verify
   available tools before announcing automation. In this session,
   Accessibility/AppleScript and capture of the macOS window alone work;
   the interactive browser tool connection does not.
2. Define executable procedures with actions, expected results, windows, and
   target files; screenshots before/during/after significant steps and visual
   inspection. Video if the tool permits it, without including personal content.
3. First launch and normal launch, setup, model/backend picker, loading,
   switching, persisted settings, and reopening. Also native dialogs, focus,
   keyboard, resizing, scrolling, readable errors, and return to operation.
4. **Every model × four modes**: at least one complete path each (initial
   minimum 40 for ten selections), in addition to critical regressions:

   - Chat: send/stream/copy/stop, new question after stop, text attachment;
   - Agent: choose project, read/search, edit, run tests, and independently
     verify files and absence of changes outside the objective;
   - Learn: create a learning path from a topic/source, open a lesson, ask a
     question/do an exercise, verify correction and progress, save/reopen Tutor;
   - Cowork: open documents/PDFs/tables, edit/export them, and reopen them.
5. For every vision model, repeat PDF/image input in all four modes. For
   every text model, attempt incompatible inputs and verify the payload and
   explicit message while retaining attachments. Repeat vision → Laguna →
   vision with history, cache, tool results, and conversation reopening.
6. Messages during generation/long-running tools, waiting state, pause/resume,
   cancellation, tool error, runtime restart, and multiple sessions. Verify
   order/ACK, terminal task state, and no double writes, not only the UI.
7. Design: gallery, valid style and old setting, real generation, interactive
   preview, revision request, export, and standalone reopening.
8. Correlate actions and screenshots with UI/host/engine logs, weight identity,
   artifact hashes, and build revision. Repeat critical paths after fixes and
   on the final build. “Completed” in chat does not replace verification.

If desktop control is impossible, record the exact missing permission/tool,
ready procedure, and BLOCKED status. Continue available tests, but do not close
P7 as PASS based on headless screenshots or mocks.

<a id="p8"></a>
## 13. P8 — Nine design systems and generated projects

Status: **nine original packs implemented and browser/offline-control tests PASS;
18 generated projects, desktop qualification, and final build still TO_DO**.

September 9 progress: Market, Commons, Atlas, and Canvas each have the five
required files, coordinated palettes, and distinct structures and interactions.
Native catalog, tools, and bundle admission include all nine IDs; the UI picker
continues to consume the authoritative catalog. No external catalog or new
framework. `design-originals-175lpc` passes **114 aggregate checks**, in
Chromium/WebKit: four widths, both themes, contrast/text at 200%, focus/forms/
dialogs, radio buttons with a separate column, domain interactions even inside
the opaque iframe, bounded cart, undo limited to 30 states, and direct `file:`
opening without APIs. `design-originals-PtrnI5` retained: the new regression
on button words failed before the Canvas toolbar correction. Desktop/mobile
screenshots of the new packs inspected; no model-quality evidence is inferred
from hand-authored previews. Native pack-reading and bundle tests are extended;
the subsequent receipt must record their result.

The subsequent keyboard-focus regression fails in `design-originals-whXayR`
before the Canvas fix. Final gate `design-originals-WnuNo6` passes **114/114**,
including correct object focus and removal of the last cart item.
`make test-design-self` passes after the private build (`design-build/run-XX03mS`),
with the dispatcher tested on all nine IDs; `make app test-macos-bundle` passes.
New project bundle: September 9, 11:57:59 CEST, executable SHA-256
`35cdb4d3cc9b508161d9be9fcfceb55b73244c71d8e80d26f5b51562b149c200`.
The app in Applications remains the previous one and has not been restarted.
The Windows recipe copies the entire extension tree, but the Windows build
was not run on this Mac. No P8 closure: the 18 real projects, their interaction/
visual review, and final desktop qualification are still missing.

Prepared corpus `tests/fixtures/design_pack_projects.json`: two original
briefs and distinct interactions for each of the nine packs. The native
generator selects it explicitly, freezes prompts and inputs, records the
full weight hash, and verifies the actual response from the selected pack's
tool. Prompt-composition and loading-receipt tests PASS, without an LLM.
The old three-brief auditor is now rejected for this corpus: it must not
promote to PASS 18 interactions it does not execute. Dedicated auditor,
real generations, and visual review are still TO_DO; 18 projects have not
already been produced. No manual editing of benchmark outputs.

Dedicated auditor now IN_PROGRESS: eighteen explicit browser scenarios,
confined immutable export, separate receipts for browser/theme/width/text
at 200% and opaque iframe. `test-design-project-auditor` verifies the common
path and first scenario on fixtures explicitly authored for the tester:
29 groups PASS (`run-l6TcMN`), Chromium/WebKit and light/dark, including
deliberate defects in radio buttons, Clear, and dialog content. The full
regression found a tester error involving service workers in opaque iframes:
only tester initialization corrected, without changing the sandbox or ignoring
errors. The other seventeen oracles still need qualification with positive/
negative cases; uncovered domain constraints still need completing, and all
18 real projects still need generation/verification. These grader tests
are not Agent quality.

Subsequent P8 tranche, September 9: the native runner no longer ignores
malformed JSON events and waits for both streams/log closure before evaluating
the artifact. CLI regression `design-generation-process/run-qFTgIv` retains
the previous false PASS. Capture, lines/events, and files have explicit limits;
I/O with backpressure, cancellation, real write error with an OS limit on the
test process alone, end of input, owned groups, and invalid files/symlinks/entries
are verified with a simulated peer, not an LLM. Subsequent gate
`design-generation-process/run-h4NRFS` passes 33 tests. Generation and teardown
latencies remain separate, and comparison rejects different versions/limits.

`design-project-auditor/run-QI1rac` passes 63 groups: in addition to the previous
editorial-search, it verifies reading/notes for each essay and the repair
queue in Chromium/WebKit, standalone/opaque iframe, and light/dark pipeline.
Nine deliberate defects in the two new scenarios are rejected; fixture
screenshots inspected. These are not model outputs, publishable Design
examples, or aesthetic scores. Fifteen interaction oracles still need
qualification, as do additional domain constraints and all 18 generated
projects. Final receipt checking must preserve NOT RUN for projects not
started and must not trust the generationPassed flag alone. No new engine,
model, `.app`, or push is attributed to this tester tranche.

Final P8 tranche gate repeated in full:
`make test-design-generation-process test-design-project-cases test-design-comparison-report test-design-project-auditor`
PASS, plus `git diff --check`. Updated receipts: 33/33 in
`design-generation-process/run-jZAoVh`, 63/63 in
`design-project-auditor/run-DcbJ1O`, admission in `run-RLatep`. The latter
rejects a falsified delivery flag without opening a browser/workspace and
retains 17 unstarted projects as NOT RUN in the denominator of 18. The legacy
report also verifies complete capture and identities; it is not artificially
extended to qualify all 18 interactions.

Subsequent tester tranche, September 9: reproduced a false PASS for a console
error arriving after the final assertion but before teardown
(`design-project-resources/run-XBUIQw`, original FAIL). Publication now also
waits for context closure and checks terminal evidence. Collection limited
to 64 issues/64 KiB per view, 4 KiB per detail without splitting Unicode;
explicit overload FAIL, closure of the owned context only, first errors
retained. Console/script/opaque iframe/blocked network and an unrelated
context still usable: 16/16 PASS (`run-lcX6io`). This is not a browser RSS limit.

The full gate also detects a tester false FAIL on WebKit Escape closure
(`design-project-auditor/run-2NzaxI`): key-dispatch completion preceded the
closed state. A fixture with deferred closure reproduces the defect in
Chromium too (`run-AoaAzw`). It now waits for the observable state within the
same 3 s allowed for the action; permanently blocked Escape remains FAIL.
Subsequent full gate 67/67 (`run-OKF0xz`), without changing generated outputs
or extending deadlines. The same function applies to every compared variant.
Report, admission/corpus, and capture 33/33 (`run-GBrKJe`) also pass. Fifteen
domain oracles and all 18 real projects remain; P8 is not closed.

Subsequent tranche: `design-project-auditor/run-xYkYTn` **91/91 PASS**,
fourth oracle added on authored fixtures for incident assignment/resolution.
It verifies unapplied drafts, independent assignments, counts, filters,
reopening, empty state, and complete history in actual order. Both browsers/
themes and opaque iframe; no hand-repaired generation. Tester false FAILs
`run-QUWHIH` (valid nested label) and `run-wAH0Wo` (optional HTML value)
retained, corrected by using the accessible name and actually selected
option. `run-QULeRl` retains the false PASS for stale counts before the
strengthening. 14 oracles and all 18 actually generated projects,
their visual audits, and the complete matrix remain.

Preserve Folio, Signal, Forma, Grove, Pulse. Verify that the proposed names
are not taken at implementation time; create at least:

| Pack | Distinctive structure and interactions | Two minimum briefs |
| --- | --- | --- |
| Market | Catalog, filters, variants, comparison, and cart; commercial hierarchy | Catalog with comparison; configurator with cart summary |
| Commons | Feed/thread/profile, membership, and moderation states | Community with discussion; profile and demo report review |
| Atlas | Synchronized map/list, places, and itinerary | Places directory; itinerary building and review |
| Canvas | Central area, tools, inspector, selection, and undo | Object editor; creative workspace with action history |

1. Differentiate typography, composition, density, navigation, components,
   interactions, states, and recipes. Not four recolors. Atlas uses offline
   fixtures and a working local map; any dependencies must be declared.
2. Structure: `DESIGN.md`, `tokens.css`, `components.html`, `assets/preview.js`,
   `references/recipes.md`, as in the originals. Original assets or reuse with
   correct provenance. No return to the retired external catalog.
3. Update the authoritative C catalog, macOS/Windows bundles, loader, preview,
   UI/gallery, migration, and docs. Incomplete-pack errors before startup.
4. Test all nine packs, light/dark, 320/390/768/1440 px, text at 200%, keyboard/
   focus/return from dialogs, contrast, wrapping, overflow, overlap, image
   proportions, modals, and forms. At least 72 pack/theme/width combinations
   per browser before additional text and state tests.
5. Chromium and WebKit, including inside the real opaque iframe; do not relax
   CSP or isolation. Verify that exports include local dependencies and work
   without DStudio, network, CDNs, or catalog APIs.
6. **At least two model-generated projects for each pack: minimum 18.**
   Also freeze two distinct briefs for each of the five originals. Use included
   LLMs, recorded identities, and local/CSS/SVG assets. None of the three
   excluded media workers. Pixel references only for vision models; text only for Laguna.
7. Open generated projects and actually use controls, forms, radio buttons,
   dialogs, selections, filters, Back, undo, and persistence where required.
   Desktop/mobile screenshots and visual review separate from the geometric score.
8. If a result has misaligned radio buttons or other defects, correct the
   runtime, guidance, or tools and **regenerate/iterate through the Agent**.
   No human correction of HTML published as a benchmark. Preserve the original
   output, attempts, times, timeouts, and grader: a new run does not erase
   the failed one. A model that ends by timeout is not a PASS delivery.

Acceptance: nine distinct design languages working offline, 18 real projects
with verified outputs and visual inspection. Static packs, model self-critique,
or a geometry score alone do not demonstrate aesthetic or functional quality.

<a id="p9"></a>
## 14. P9 — Agent, Codex, Pi, and OpenCode comparisons

Status: **50 fixtures and historical comparison present; new campaign TO_DO**.

### Six distinct subjects

1. Clean upstream ds4-agent, only with models that are actually compatible.
2. Direct DStudio Agent with patches, without benchmark orchestration.
3. The same Agent with Task Graph/check.
4. Pi.
5. OpenCode.
6. Codex CLI.

Do not call the second “upstream”: the old native/checked comparison already
uses DStudio patches in both variants. Prepare upstream in an isolated copy;
do not remove patches from the installation used by the app.

### Codex: a real adapter, not a name in a table

The reconnaissance used **OpenAI Docs** to verify the boundary before planning
the adapter. The
[official configuration](https://learn.chatgpt.com/docs/config-file/config-reference)
documents custom providers with `wire_api = "responses"`;
[noninteractive mode](https://learn.chatgpt.com/docs/non-interactive-mode)
exposes `codex exec --json` and resume by ID. Local 0.153.4 help confirms JSONL,
`--ignore-user-config`, `--ephemeral`, `--cd`, and `--output-last-message`.

ds4 main already has `/v1/responses`, so there is no need to assume a new engine.
What is needed is to test the installed CLI's actual compatibility with our
endpoint's tools, reasoning, events, stop, and session. The current runner's
proxy verifies model and thinking only on `/v1/chat/completions`.

Changes in `extension/task-graph/bench/run-cli-competitors.mjs`:

- Add real Codex invocation with explicit test configuration, confined
  workspace, captured JSONL, deadline/cancel, and exit/terminal checks.
  Do not inherit unrelated hooks/plugins or credentials, and do not print secrets.
- Test Responses tool call → file/command execution → tool result → answer,
  partial inputs and outputs, IDs, cache/continuation, and resume. No fake
  adapter that translates only final text and ignores tool effects.
- Verify the model pin and effective parameters on Responses as well,
  including unrepresentable native defaults. If they are not equivalent,
  the same-model lane is BLOCKED/not comparable, not an invented favorable measurement.
- Test the adapter first with a controlled server, labeled as a protocol
  test, then with a real model. No quality PASS derived from the fixture.

### Two separate lanes

**A — same model and conditions.** Equivalent checkpoint, quant, backend,
context, sampling, thinking, budget, available tools, and cache; compare
actual requests/launches and hashes, not just the configuration file.
Codex enters only after real testing of the same endpoint/protocol. No
fallback, hidden submodel, or undeclared asymmetric tool restriction.

**B — complete product.** Each system with its already available model/
configuration. No new LLM downloads for competitors. Data separate from
lane A because model and runtime may differ. Common text coding; any
document/vision comparisons in separate tables according to capabilities.
Missing credentials or access are BLOCKED, while the other competitors
are still tested.

### Corpus, counting, and metrics

1. Preserve the 50 existing fixtures and add **at least 20 held-out cases**
   that do not enter optimization. Frozen manifest with independent oracles.
2. Add long/recovery scenarios: dirty repository, failed tool, timeout,
   partial patch, steering during a tool, cancellation/resume, and multiple
   sessions. Preexisting user content must survive; do not authorize extra cleanup.
3. Isolated copies of the same initial workspace, counterbalanced or seeded
   randomized order, at least three repetitions under comparable conditions.
   For one complete lane: at least 70 × 6 × 3 = 1,260 attempts, plus long/
   recovery scenarios. If a variant is unavailable, retain its row and reason.
4. Verify files, tests, and answers outside the Agent: success/pass@1, false
   completions, regressions, duplicated/failed tools, recovery, and cancel/resume.
   A waiting/done marker or a check chosen by the model is not the oracle.
5. Measure time to the **verified** result, initial latency, prefill/decode,
   tool/check time, cache, memory/RSS/GPU, and tokens/costs where available.
   Report distributions, medians, and samples; p95 only with an adequate count.
   Tokens from different tokenizers and unexposed costs are not equivalent values.
6. JSONL: fragmentation, split Unicode, interleaved events, order, tool executed
   once, reasoning not exposed as the answer, steering ACK, exact task
   completion. Apply to every adapter, not only main.
7. PLD off/strict/batch ablation where implemented: strict is observation,
   not acceleration; for batch, count verifications actually performed/accepted,
   outputs and state after rejection, boundaries, stop, replay, and errors.
   A hit is not a speedup. MTP/DSpark/DFlash are separate experiments with
   compatible targets/drafters.
8. Preserve all failures and retries. Compare speed only for correct,
   comparable pairs, while still showing the complete denominator.

<a id="p10"></a>
## 15. P10 — Profiling and permitted optimizations

Status: **TO_DO, only after a correct baseline**.

Profile the case that fails or slows down: prepare/prefill, repeated cache
work, tool I/O, parsing, retries, stream consumption, verification, and
orchestration. Distinguish cold load, first response, warm reuse, and shutdown.
Low average CPU does not rule out a blocked queue or saturated thread.

For every change, record before/after: preparation, owner wait, lock wait,
lock hold, commit, interactive latency, throughput, and RAM/GPU/SSD. Tests
with artificially blocked preparation: status/cancel must respond, and lock
hold must not grow with preparation cost. Preserve determinism, order,
results, journal/fsync, and recovery capability.

Reduce duplicated work and algorithmic cost before caches or workers.
Every cache/pool requires an owner, complete identity, invalidation, budget,
lifetime, eviction, and equivalent fallback. Every queue has limits and
fairness. No massive allocation at commit or scanning capacity when active
state is sufficient; verify with visit counters as well as wall time.

Do not win by reducing context, thinking, precision, verification, or grader
strictness. Do not raise wired memory or stop unrelated programs. Fast paths
and fallbacks must produce the same effects/validation; numerical changes
require specific tolerances and oracles, not an arbitrary promise of identity.
Retain only improvements that pass every affected gate and previously
successful case. No “always better than Native/Codex” guarantee.

<a id="p11"></a>
## 16. P11 — Final build, documentation, and publication

Status: **TO_DO after implementation and measurements**.

1. Recheck upstream main and every equivalence map. If relevant changes exist,
   integrate them in `.patch` files, rebuild, and rerun invalidated results.
2. Freeze the final build with the DStudio commit + diff/hashes of dirty and
   new files, identified engine/base/patch/binary/checkpoint/encoder. Do not
   use HEAD alone to qualify a build with local changes.
3. Run all applicable release gates, all invalidated suites, and final critical
   desktop paths. No old PASS transferred to a new engine/encoder/parser
   without testing. Remaining errors must remain visible.
4. Update README, tests README, ENGINE_ACCEPTANCE, QUALITY_GATES,
   DESIGN_SYSTEMS, patch docs, hardware matrix, and THIRD_PARTY_NOTICES.
   Correct “Qwen3.6 untested”, ambiguous “four modes”, and obsolete limits
   only in light of specific evidence. Do not remove limits that remain real.
5. Publish reviewed JSON/CSV results, **Matplotlib** scripts, and PNGs on GitHub,
   embedded in the README or a linked report as with Task Graph. Understandable
   titles, units, n, failures, hardware, and configuration; inspect rendered
   images. Separate quality, latency, and coverage: no speed chart hiding
   wrong answers or nonequivalent comparisons.
6. Review privacy: no private PDFs, personal quotes/questions, machine paths,
   secrets, or user transcripts in public files. For private datasets, publish
   aggregates, limits, and provenance/hashes, declaring that raw data cannot
   be distributed and complete public reproducibility is unavailable.
7. Attach the included/excluded matrix, fresh/upgrade installations, four-mode
   tests, vision/isolation, desktop, generated projects, six Agents/two lanes,
   before/after, failures, and exact instructions to unblock missing hardware.
8. Prepare separate commits by cause and reviewed diffs. Push only within the
   campaign's authorized scope, not implied by this planning request. Beforehand:
   privacy, whitespace, and documentation checks; normal push, verify remote SHA.
   A rebuild does not mean the user's app is updated: installation/restart must be explicit.

<a id="closure"></a>
## 17. Complete requirements map and closure

| Section of the requested document | Coverage in this plan | Evidence required for closure |
| --- | --- | --- |
| 0: included/excluded, only new Qwen27B, no llama.cpp | §1, P0, P3, P4, P6 | File/hash manifest, components, no out-of-scope download |
| 0: Chat/Agent/Learn/Cowork for all; Design separate | P3, P6, P7, P8 | Real tasks, model identity, and persisted outputs |
| 1: code/docs/baseline, historical vs current | §2–4, P0 | Commit/diff/build/hash and matrix per combination |
| 1-a: latest ds4 on all relevant engines/backends | P2, P11 | Complete delta/equivalence/test map and automatic gate |
| 1-bis: download/patch/build/startup/fresh/upgrade | P2, P3, P5 | Installer receipts, actual binary/encoder, and inference |
| 2: real desktop app, four modes, attachments/reopen | P7 | Real actions, screenshots, logs, and independent checks |
| 3: retired style, hanging tasks, races, and settings | §3, P1 | Reproduction, fix, and first-request regression + real endpoint |
| 4: Qwen27B Apple/NVIDIA/AMD and four modes | P2–P5 | Core/adapter/weights/vision and separate hardware results |
| 5A: numerics and upstream | P6A | Oracles/tolerances, logits/KV/GDN/spec/encoder, GLM100 |
| 5B: 100 cases/LLM +30 PDFs/+20 images | P4, P6B | Frozen corpus, expected answers, all results |
| 5C: product quality and text models without multimodality | P3, P4, P6C, P7 | Reopened outputs, real payloads, and isolated cache/session |
| 5: all suites, including long ones | P0, P6, P11 | Complete inventory and no silent omission |
| 6: five packs preserved +four originals | P1, P8 | Nine packs, themes/width/WebKit, at least 18 real projects |
| 7: six Agents, two lanes, 50+20, long, three repetitions | P9 | External grader, immutable raw evidence, identities, and denominators |
| 7: PLD/spec/JSONL/profiling with correctness first | P2, P6, P9, P10 | Equivalent state/effects, real batches, profiles, and before/after |
| 8: documentation, receipts, final delivery, and honest blockers | P0, P11, §17 | Evidence tied to the final build, Matplotlib/GitHub, limits |
| Subsequent instruction: external changes as `.patch` files | AGENTS.md, P2–P5 | Reproducible versioned patches and verified lifecycle |

### Current delivery status

- [x] Read the requirements document and contributor instructions.
- [x] Analyzed real setup, launcher, Design, Learn, PDF, patch/build, Task Graph,
      and runner paths; compared available reports and receipts.
- [x] Inventoried weights in the main shared store and distinguished components.
- [x] Verified remote main and revisions of the three Qwen27B candidates;
      identified the q36 Metal vision gap and Codex adapter boundaries.
- [x] Updated AGENTS.md to require `.patch` files for external repositories.
- [x] Written this plan with changes, dependencies, criteria, and complete coverage.
- [ ] Completed full P0: full hashes, all paths, current baseline.
- [ ] Corrected and tested Design startup and the other P1 problems.
- [ ] Aligned all engines/backends and completed `.patch` migrations.
- [ ] Downloaded/integrated Qwen27B and completed all four modes for every model.
- [ ] Completed vision/PDF and text-model isolation for every combination.
- [ ] Run fresh/upgrade installations and all numerical/quality suites.
- [ ] Run real desktop paths and projects for the nine design systems.
- [ ] Run six Agents/two lanes and optimizations grounded in profiles.
- [ ] Validated the final build and published reviewed measurements on GitHub.

**Final criterion:** the plan can be delivered now; the campaign cannot be
declared complete until the implementations and all required executable
tests are finished. Missing hardware/credentials/permissions remain BLOCKED
with a procedure and exact requirement; they do not become PASS or completed
implementations. No claim of SOTA parity, universal superiority, or complete
multihardware support without corresponding evidence.

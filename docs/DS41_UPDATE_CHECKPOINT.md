# DeepSeek V4.1 update checkpoint — 12 September 2026

This is work in progress, not a release or a performance claim. The existing
Qwen quality failures and the remaining `PLAN.MD` acceptance work remain open.

**Publication checkpoint — September 13:** the current slice is closed and the
remaining implementation campaign is paused. See the [plain-language WIP
status](WORK_IN_PROGRESS.md) for what is usable and what remains unqualified.
The dated entries below preserve the evidence and state at each earlier step;
a source publication does not convert an earlier failure into a pass.

## Installer death and final cache-overlay replay — 13 September, 01:22 UTC

The cache-overlay binary passes the complete actual HTTP/image/tool/cache replay
**46/46**, `q36-http-vision-live/run-Erzu5e`, finished **01:03:51 UTC**, native
exit 0. All 158 frozen inputs and both weights remain unchanged; its PID is
verified absent. Receipt SHA-256:
`11b70c658bd74dc84f41974427e6bba7107b62d7f27a9ec25d48cebde9203e91`.
The actual DStudio workflow on that binary then passes **14/14** in
`q36-host-live/run-KduHiw`, finished **01:12:23 UTC**: exact Chat/streaming,
Agent Python repair with the original four tests, independently reopened
Cowork Excel, four image-tool questions, return to Chat and Stop. No generated
file was corrected manually. Inputs are unchanged, host exit 0, host and model
PIDs verified absent. Receipt SHA-256:
`3e4f901e0404c9ad2bd32638cb747332c70a52dab3ff42d81c5bacebad9b2fb8`.

A separate P5 fault probe then exposes an installer ownership gap: SIGKILL of
the installer bypassed Python cleanup and left its blocked command running.
The retained original is `q36-installer-death.DKYxTQ/red.txt`; the test releases
only its own authenticated socket on failure, not an advertised/unrelated PID.
The installer now uses one bounded supervisor per sequential command. The
caller owns the sole lifetime-pipe writer; its loss cancels the real command
even after stdout EOF. Only the command's actual parent signals its reserved
process group, then reaps and verifies drain. There is no worker pool or model
operation. The original work deadline and 2 MiB raw-output ceiling remain;
bounded cleanup time and UTF-8 replacement transport are accounted separately.

`python3 -B tests/integration/q36_install_test.py` passes **42/42** in 10.673 s,
including caller SIGKILL, early stdout closure, ignored SIGTERM, unreaped group
identity, exact decoded bytes and raw-byte limits. Source SHA-256:
`c931384c399497a1bbaf4635ac044c40c90c1eefaa3bb349a556772339ebb28a`;
harness SHA-256:
`e98202bed709da9c463257dacbdcee7abd222d9665d1eb136bad0708f4bf228a`.
These execute actual local processes/files but do not turn fixture builds into
real installation or infer model quality. The 46/46 and 14/14 receipts above
precede this installer-only supervision change, not a new inference patch.

The final supervised network/build/real-model upgrade is also complete:
`q36-upgrade-live/run-jkibs2`, **8/8 PASS** at **01:20:45 UTC**. It retains
projects/settings/model identity, reuses the old 33-token cache, matches the
cold continuation and reopens without another exchange. Original inputs/full
weight hash are unchanged; every recorded phase exits 0, its PIDs and all
supervisor processes are verified absent. Receipt SHA-256:
`7dcfe73fdba1c111a5ee96e3931b63a9052565456b104af00f27779a31d80b0c`.
The resulting server is byte-identical to the one in the 46/46 and 14/14
replays (`7bcd7240bcf5e694661ab7f729d9e09d8d93244d7166d70da99f132ef829f5fe`);
that establishes binary identity, not additional inference attempts.
Final production-install admission passes **16/16**, `run-GxCWsL`, and the host
gate passes **94/94 unit + 15/15 simulated lifecycle**, `q36-host/run-KvIxIl`.
The simulated host remains responsive during blocked loading and preserves
ownership, cancellation and foreign-process rejection; no model quality is
inferred from those fixtures. `git diff --check` and changed JS/shell syntax
checks pass. All original failed receipts remain, and the user app was not
recompiled, restarted or replaced by these checks.

Full P5/mode/hardware qualification and the common 61/100 quality failures
remain open; no final release/build or campaign push is claimed.

## q36 cross-version cache reuse and user projects — 13 September, 00:58 UTC

The installer source census no longer treats an unrelated C project or linked
project directory as native compiler input. Source areas are reviewed against
both exact legacy/current Makefiles; actual engine source/shader changes still
reject admission. User project bytes, modes and links survive publication and
reopening, and cannot enter the managed inventory or be compiled by setup.
Three added behavioral regressions bring the model-free installer suite to
**38/38 PASS** (`python3 -B tests/integration/q36_install_test.py`, 8.130 s).
The original three red cases remain in `q36-install-code.sPwDYw/red.txt`.
Earlier real project-preservation replay `q36-upgrade-live/run-WkkSAg` passes
6/6; SHA-256 `dd23e7299739af0fd30569d5dde72873299a52f83d91b6d5dfcdd978ff576e6e`.

Extending that gate to actual cache reuse exposed a native HTTP usage bug:
`q36-upgrade-live/run-sOSwzz` is **3 PASS, 1 FAIL, 4 not run**. The upgraded
server really loaded the old 33-token checkpoint and answered correctly, but
returned `cached_tokens: 0`. Its retained receipt SHA-256 is
`42ecb0a1875394e34c09f27aad0053853e25e9674161865f9c7cd37a31b07603`.

The separate [cache-usage overlay](../patch/q36-metal-runtime/cache-usage.patch)
targets `Ninnix/q36` **8362010a301b3360296e435703f58ffc230a024a** after the existing
`next-review` → `monitor` → `monitor-owner` stack. It publishes text reuse only
after owner commit and preserves the zero-usage initial Responses event. It
does not change tensors, KV encoding, precision, hot layouts or model answers.
Patch SHA-256: `8cb85f1831b9e9810fed7bb8ae62064e63d205f95667a2e9e9545d5918703832`.
Installer SHA-256: `a6abf022038b10a8c3162c00dcf44b0d9bddeadca60b42c4ea5a40c769ad9dcd`.
Applier SHA-256: `fc80003bc0890061a99dd6281704727807b183951828a34a93ef9fd81a1be666`.

The native HTTP/cache gate, with simulated session numerics and ASan/UBSan,
goes from **54/78 PASS, 24 FAIL** (`run-DbNrrM`) to **78/78 PASS** single-session
(`run-7tdelm`); the batched suite passes **68/68** (`run-7e76tr`). Cold/disk/both
memory-prefix modes are checked in JSON and SSE across all four native API
surfaces. Initial Responses placeholders are not mistaken for final usage;
original invalid harness attempts are retained separately. The complete patch
lifecycle, unrelated-edit, partial/drift/alias/ABI and native build-dependency
gate passes **12/12**, `q36-cache-usage-patch/run-4DUukX`, unchanged inputs.
Receipt SHA-256: `5469612789d7aba59cd361363d8a34f45b37eda2e316dcf29f75c542257760f8`.

The unchanged expanded real upgrade gate then finishes at **00:58:34 UTC:
8/8 PASS**, `q36-upgrade-live/run-MsDxvv`. The newly built process loads the old
checkpoint and reports **33 cached tokens**; a separate cold process reports
zero and returns the identical correct answer and completion-token count.
Project C/Makefile/link, settings, cache and shared weight alias survive; the
reopened installation is verified without a second exchange. All six child
processes exit 0 and are verified absent, original installation and full model
hash remain unchanged. Receipt SHA-256:
`863a4856bae1b2ace0c9a070c768cea773ce013e59344161f498c38076e8f322`.
The production source-census admission gate subsequently passes **16/16** on
that actual installation (`q36-http-install/run-mA2qUq`); this is model-free.

The earlier actual DStudio workflow `q36-host-live/run-tDuo5n` is also terminal:
**14/14 PASS**, host exit 0, unchanged inputs, at 00:21:48 UTC. Receipt SHA-256:
`1dfffa4a2f3ff1226323fe1db6318ac3c8dfef522587d7682060f78ffe007e0e`.
It uses the preceding installer/three-patch binary and is not attributed to the
new overlay. These are targeted development regressions, not a new quality or
performance claim. General 27B quality remains **61/100**; full Learn/Design,
long contexts, desktop, other engines/hardware and P5's complete matrix remain
open. No user app restart, weight download or commit/push was performed.

## Existing q36 installation upgrades — 13 September, 00:10 UTC

The installer now upgrades the reviewed q36 bases through private preparation
and one atomic directory exchange, retaining the previous engine and a bounded
identity journal. Legacy Metal ownership is reconstructed against the original
archive SHA-256 plus recorded source/runtime hashes. Unknown user paths are
preserved rather than adopted. Unrecorded legacy objects, build logs and extra
upstream CLI programs remain unchanged; their newly built counterparts are
retained separately. DStudio's two selected q36 executables and runtime sources
are always the newly verified version. Shared user-file hardlinks are **not**
an immutable backup or an undo of subsequent user edits. Additional patch
requirements, edited owned files and unreviewed revisions reject the update.

Thirty-five model-free installer tests pass. They execute real filesystem and
process behavior, with network/build simulation except for the native busy-peer
fixture. New cases cover interruption before/after exchange, failed final fsync,
reopening without a second commit, active runtime admission and data races. An
existing deadline test first exposed premature command cleanup: a descendant
still owned its listener when the helper returned. Cleanup now reserves the
leader's identity until its final signal and verifies group drain; macOS zombie
groups are checked through libproc. The initial copied `/bin/sleep` fixture was
killed with SIGKILL before admission; a compiled peer with a READY handshake
replaces that invalid fixture without changing the rejection requirement.
These earlier failures remain distinct from the passing final test run.

The first real attempt, `q36-upgrade-live/run-Xqm7MP`, is **1 PASS, 1 FAIL,
4 not run**. Its early legacy build (runtime patch `6067da89`) returned
gibberish despite loading the correctly hashed 27B; no upgrade was attempted.
Receipt SHA-256: `4d2495a44538da616dc1e48424ec2d80d101275057b93e10c187d7bcd2f7e9de`.

The unchanged six-phase harness then uses the later `d67687ed` installation
with patch `75764a9f` and native server `e94a2c75`, previously used by the common
quality run. `q36-upgrade-live/run-42nhJa` finishes at **00:09:58 UTC: 6/6
PASS**. Both old and upgraded engines answer the exact same request correctly;
the production native installer downloads both archive identities, applies the
current three patches and builds `8362010`. Its core executable hashes match
the earlier fresh installation. Settings, project, shared model alias and an
actual **160,049,582-byte** KV file survive the exchange; the original source
installation and complete model hash are unchanged. Every test-owned process
exits 0 and is verified absent. The new response reports **0 cached tokens**:
this proves preservation and a correct response with the retained directory,
not old/new cache reuse or format equivalence. Receipt SHA-256:
`4a07db7ca4f1b6cfef294715a421be68603901c5509a9b8dc49e9624db93a8eb`.
Installer SHA-256: `9dbf3c85185c02931184d29b9df0dfa75b7dc6719abbb58a4044db748976bd61`.

No user installation, model or application was moved/restarted. This closes a
targeted real legacy-upgrade workflow, **not P5 as a whole**: additional engines,
all modes, full failure/recovery matrix, cache compatibility, desktop and other
hardware remain separate acceptance work. General 27B quality remains 61/100.

## Qwen installation-use lease and ownership inventory — 23:27 UTC

The native launcher now acquires a non-waiting shared installation-use lease
in the new inference child, revalidates the executable identity after acquiring
it, and retains the descriptor through exec and native teardown. The HTTP
owner and its fork-only relays never hold copies. An exclusive updater cannot
overlap loading, inference or drain; read-only installer verification still
coexists with mode reuse. This is a process-lifetime admission lease, not a
shared application-state mutex. No filesystem work was added to the parent
control path. The pinned `8362010` server's production path was checked for
subprocess/fd lifetime before using this contract; no upstream source or
shader was changed in this tranche. Persistent host sizes remain 9,004 bytes
for the launch spec and 11,112 for the one owned-runtime record.

The old launcher accepts a launch under an exclusive updater in
`q36-host/run-Jm7a0A` (retained FAIL). With the fix, 94 identity/protocol cases
and 15 host lifecycle scenarios pass normally (`run-ZKdGZO`) and under
ASan/UBSan (`run-fnFCOq`). The simulated peer has real loading/drain barriers:
host SIGKILL cannot prematurely release a still-live child's lease, Stop
admission is not exit, and an unrelated relay cannot retain the lease after
the engine exits. The intermediate `run-hqBj7p` failure is also retained: the
test cleanup expected Stop success even after the rejected launch had already
fully terminated. Cleanup now stops only remaining owned work; the expected
launch rejection and all existing lifecycle assertions are unchanged.
Normal receipt SHA-256:
`42836f7be2687e019e681a972f6a2612f3d9e8ccd483cd699e69bdb6e392a474`;
ASan/UBSan receipt SHA-256:
`22793b9a0dfbb5fd1c00a4dfb94eba800c67bea8d098879bf7e994c0356bd7a5`.
These are model-free behavior tests, not LLM or GPU-quality evidence.

The installer now records the complete managed-file inventory in a fresh
receipt (at most 8,192 entries, 20 path components, 1,024 chars per path and
512 MiB of owned files). Reverification only claims the originally recorded
files, preserving later user notes, cache and model aliases. Input hashing
rejects nonregular files before reading, bounds actual bytes and detects
concurrent changes. Twenty-two installer tests pass, including a three-second
FIFO rejection oracle and publication racing SH-to-EX conversion. These
tests use real files/processes but simulated network/compilation where noted.
The setup/unit/UI capability tests and all eleven launch-control scenarios
also pass (`launch-control/http-yDP64T`); their model replies remain simulated.

The separate real network installation `engine-acceptance/run-37al3S` finished
at **23:27:11 UTC**, passing main `bd66c402` and q36 `8362010`. q36 records
147 compiler sources and **255 managed files**; both checked runtime binaries
match the previous native build. Installer SHA-256:
`865890d7e72adbb97fa6cf3171f281d05ce575caff82731eb79db1004b726afb`.
Setup receipt SHA-256:
`4389503adea19ee342b8561d2502e62993b462f3e5fe8e2b1c96cbfd1d79ad1c`.
No weights were downloaded and no installed user application was restarted.

The corresponding real host replay `q36-host-live/run-JgGSg0` finished at
**23:36:35 UTC: 14/14 PASS**. It exercises Chat/streaming, Agent Python repair,
independently reopened Cowork XLSX, four pixel-only tool observations, return
to Chat and Stop using the same resident 27B process. Independent lease probes
reject exclusive admission during use, allow shared verification during reuse,
and allow exclusive admission only after native Stop. Host exit 0, captured
inputs unchanged, and both host/model PIDs verified absent. Resident Q6_K_XL,
F16 projector/KV, 8k context, 128-token prefill chunks and a 256 MiB disk-KV
budget; expert SSD streaming is off. Receipt SHA-256:
`c87586da8c45d6392433ca6e5ac67e34760473648c0118727c25cc4b60c7cefd`.
This targeted development replay is not Design, held-out quality or a new
speed benchmark; the original 61/100 common-quality result remains visible.

This does **not** complete existing-install migration. Legacy receipts retain
their historical verification scope and do not establish ownership of their
unrecorded files. Still required: legacy ownership reconstruction, private
upgrade preparation, revalidated publication/recovery, and real old-to-new
inference workflows with settings/projects/KV/model-store preservation.
Linux/Vulkan runtime lifetime, Learn, long context, full quality, desktop and
the remaining P0–P11 work are not qualified by this tranche.

## Fresh q36 installation and DStudio tools — 22:51 UTC

The installer candidate now pins `8362010` and explicitly applies the runtime
`next-review`, terminal `monitor`, then `monitor-owner` patches. Its receipt
records that order, all patch/script hashes and the installer hash captured
before preparation and revalidated before publication. Fourteen installer
fixture tests pass, including a changed installer/patch during a simulated
build; those fixtures are not real installation evidence.

The separate network run `engine-acceptance/run-jVF1xy` starts with an empty
private directory and passes both **main and q36** source download, patching,
native build and actual executable startup. Main is `bd66c402`, q36 is
`8362010`. All 147 q36 source inputs and its built binaries are rechecked.
Receipt SHA-256: `b6d1cd96884dc5b907bba7f0972ff8ada14c084ea5da5df1f7312fd962d87b1f`.
No weights are downloaded. Existing divergent installations remain untouched;
their required upgrade workflow is still open, not a passing refusal test.

Using that installation and existing hard-linked Q6_K_XL/F16-projector weights,
`q36-host-live/run-pkigpi` passes **14/14** actual DStudio host checks. Chat,
streaming, same-process reuse, an Agent Python repair with four unchanged
assertions, a Cowork workbook independently reopened as OOXML, four visual
tool observations, return to Chat and owned Stop all pass. The model's first
verification command explicitly changes to the wrong directory; its failed
tool receipt and subsequent correction remain in the log. No grader change
or manual file repair was used. Host exit is 0, captured inputs unchanged,
and both host and resident model are verified absent after the run.
Receipt SHA-256: `9bd6c41fec72c302c8feaa9d0d5e0aca33f0ee1514960af070ee3ede354b2aeb`.
This is one development workflow, not held-out quality, Learn, Task Graph,
long-context, the actual macOS window or non-Metal qualification.

The native live runner now admits the new managed installation without claiming
a Git review checkout. It recomputes the full installed source inventory and
verifies binary/patch/installer identity and patch order, retaining all 46
current API/cache cases. Fourteen deliberate managed-receipt fault cases pass
(`q36-http-install/run-bsmPUH`), alongside the existing 13 source-copy admission
cases (`q36-http-review/run-aGwGJa`). Both are model-free preflight only.

The corresponding real managed-install replay `q36-http-vision-live/run-oGEVFX`
finishes at **22:55 UTC**, passing **46/46** without `--next`. It verifies both
complete weight hashes, freezes/rechecks 157 inputs, retains the same four
published cache files byte for byte after Stop, and returns the exact answer
with the same eight continuation fields (1,302 reused tokens). Native exit is
0 and its PID is verified absent. Prompts, expected answers and deadlines are
unchanged; no earlier failure is regraded or removed. Receipt SHA-256:
`97b0eb5f83a299a359458b8a7a7702da26852787c97da931b97277489e28fd6a`.
The run uses resident Q6_K_XL, F16 projector/KV, 8k context and a 4 GiB disk-KV
budget, not expert SSD streaming. It is a development correctness replay,
not a throughput benchmark or a new general-quality score.

## Latest continuation and shell-control evidence

Agent v102 is a new candidate for the two summary-fidelity defects below. It
supplies actual open/closed reply state, requests reconciliation of prior
pending work with later evidence, and keeps private summaries separate from
tool execution. All seven versioned deltas preserve the exact v101 predecessor;
migration `agent-patch-migration/run-B6HMz1` passes. The native reserve calculation
includes both state messages using the selected tokenizer, not character counts.
Initial compile failures `agent-compaction/run-y4BK7G`, `run-4Xqcd8` and
`agent-native-build/run-TadZ42` exposed missed reserve callers and remain retained.

After correcting those callers, Laguna `agent-compaction/run-EJUCfG` passes
14 publication + 50 framing + 18 loop checks, and MoE `run-Kl7ppp` passes
14 + 53 + 16. Inputs stay unchanged, with ASan/UBSan on the Agent/helpers and
real native vocabulary but scripted inference. Their receipt hashes are
`fa4b0171a093d97a8cd4798509e522dfb5520a509773113519a4662b89028843` and
`e94dcfd660b8c98729cd3957ae566af12cc21c6bdc48bce771cb82e1395c4818`.
The same C oracle against frozen v101 and its historical helper
(`run-tDsUKF`, `run-4iJ6ks`) fails exactly the two added reply-state checks;
all earlier loop/publication checks still pass. Full native-consumer build
`agent-native-build/run-Ethbt2` finished at **21:41 UTC**, passing **77/77**
stages (main 20, Laguna 19, Next 19, MoE 19), with captured source/support
identities unchanged. Receipt SHA-256:
`19de4f5ec372c2fb8aa8b42f832cdb3771d11a797ccb7c3e266a8910f5a48ea4`.
These tool/Stop/parser/Design checks use simulated model replies. The v102
real Laguna replay `agent-continuation-live/run-b3xpGT` finished at **21:46 UTC**:
**6/6 workflows pass**, inputs unchanged, exit 0 and owned PID terminated.
Its separate scoped summary review also passes: 57/200 functions accurately
pending during the open reply, then all 200 recognized after completion, with
both remembered facts retained and no fabricated tool effects. The independently
compiled/executed code and real write/read/Stop results remain in the original
receipt. Receipt SHA-256:
`f279b57b85a3fb0313bd605ac2075a644cb4a8115999c568005023d66d321408`;
separate review SHA-256:
`43b02e65cc493331a7a2f9edac297a101e4932f15c4c6e71877b886e820cfcfb`.
This is one development replay, not general fidelity or a token-identical A/B.
The sequential v102 MoE replay `agent-continuation-live/run-V4I1gQ` finished
at **22:05 UTC**: **1 PASS, 1 deadline FAIL, 4 NOT_RUN**. The code turn reached
174/200 complete functions at the original 600-second deadline; the runner
terminated only its owned engine with SIGTERM and queued no further requests.
Summary generation took 98.702 s and rebuilt-context prefill 184.061 s
(282.767 s total compaction wall time). The separate review is also FAIL:
the summary preserves facts and requirements but counts 56 emitted functions
when only 55 are complete and `value_55` still lacks its terminator. The exact
native reply tail survives and is completed after resumption; that does not
make the summary's progress accounting accurate. Closed-reply summary and
remaining workflows were not run. All 32 captured input hashes and model file
identity were rechecked unchanged after exit, separately from the failed receipt.
Receipt SHA-256: `5a73b6f91b7dcc945da6b6ca838b55115c1b439cf5e84ddada64cd55e37b3b14`;
trace SHA-256: `ac42a765210f68f09775d695ba9688c756c0d2fa32ca2cce304d5171044b6e7c`.
No timeout was increased and no fidelity/speed result is inferred from Laguna.
The PLD controlled gate also passes 28,633 checks and its builder/validator
tests; release-admission fixtures and installer metadata tests pass separately.
Those fixtures do not qualify current real engines for a release.

The exact `8362010` q36 native/projector rebuild `q36-metal-runtime/run-nY4HeX`
passes **43/43 stages** at **22:14 UTC**. It now records 52 actual compiler and
shader input hashes separately from the original checkout. The lifecycle test
deliberately appends unrelated comments in the private build, so those two
inventories must not be conflated. The original 42-stage receipt remains intact;
its missing compiled-input inventory cannot qualify the new source-copy path.
Native receipt SHA-256:
`c1ad01b387af0ee4c0b1674ca19413f1084698a34aeece1ef2109d6e9f26c7ea`.

`q36-http-review/run-fOY8Ec` passes **13/13 actual CLI admission cases**,
including successful admission and deliberately stale/failed receipts, binary
or shader drift, invalid paths and archive Git-parent isolation. No weights or
socket are started and zero inference cases are reported; `preflight-pass` is
not a model-quality PASS. Receipt SHA-256:
`d05d3396c94741f24ee55923d0c4b8ac29a37fc4de685e6e156647811cb3c1cf`.
The fresh real HTTP/image/tool/cache replay `run-jfuPOr` finished at
**22:19 UTC**, passing **46/46** on `8362010`. All 59 captured inputs and both
verified weight identities remain unchanged. The native engine exits 0 and
its exact PID is absent. Four published checkpoint files survive Stop unchanged;
the correct answer and all eight continuation fields match the uninterrupted
oracle (1,302 reused tokens). Observed control latency is 1.38 ms and Stop
completion 1.55 s in this one diagnostic run, not a percentile or speed claim.
Receipt SHA-256:
`d0835a2f19478cf6a5cdee4911f3aecaa9b10c65c5040498f409ac8b43d84493`.
The earlier revision's real results are not transferred to this run. No
installer pin or app has been changed; long-context, broad quality and host
integration on the new source remain separate acceptance work.

MoE Agent v101 `agent-continuation-live/run-lC2uDg` finished at **20:53 UTC**:
**6/6 real workflows pass**, exit 0, captured inputs unchanged and owned PID
confirmed terminated. This includes all 200 C functions compiled/executed by
the independent oracle, fact recall across compaction, real file tools and
Stop/recovery. Model/settings remain resident Q6_K_XL, Metal, 8k context/output,
temperature 0, seed 12345 and no SSD/PLD/MTP/DFlash. Receipt SHA-256:
`f34013de59833fa1a9c5218b197e885ffa68c5356ecd3e2210d19b67db81cd5c`.

The separate manual fidelity review is **FAIL**. The first summary correctly
records 65/200 completed functions and the future-use values. After the full
200-function reply finishes, the second summary incorrectly preserves the old
pending work and takes the shape of a write-tool request. The explicit
compaction receipt has no tool-call/result events; the private summary is not
evidence that a write ran. Later requested tool work still passes. This review
does not rewrite the six-case receipt or erase previous failed replays.
Along with Laguna's premature-completion summary, it requires reconciliation
with actual current/open-reply state. Six passing workflows are not proof of
summary fidelity, general quality or a token-identical A/B speed comparison.

The separate [q36 monitor-owner patch](../patch/q36-agent-tty/README.md), layered
after `monitor.patch` on `8362010`, fixes blocked status/Stop, output-writer
ownership, signal/reap PID lifetime, duplicate terminal notices and EOF polling.
Native receipt `q36-monitor-control/run-g38GQE` passes **7/7 cases + 14/14 patch
lifecycle checks** under ASan/UBSan; `run-PnMjJT` passes the same set with
ThreadSanitizer on the included Agent/probe. Existing linked helper objects are
not sanitizer-instrumented. Their receipt hashes are, respectively,
`4fecfe3a33745e691744d585e6565714bdf37c1a0ed07266e68891a4fa210133` and
`22fd03f4d1ff011014075b35808cf720a13e8732de4cd93909afc428ffbb201b`.
Upstream `run-QWH68o` and terminal-only `run-puGjgb` retain **1/5** on the same
common C oracle; two additional owner-notice cases are not in that denominator.

Full native Agent/password/PTY `q36-agent-tty/run-gd2ap6_q` passes **28 stages**
and 32 leak-free job lifetimes. Job size grows 1,208→1,216 bytes, worker unchanged
at 2,736; no worker or output queue is added. Probe-only profiling found and
prompted correction of an initial EOF busy loop (`run-fPmMoX`); bounded visits
are now tested. Slow filesystem completion can still delay that monitor's own
join; available status and Stop are not a promise of preemptible disk writes.
The reviewed checkout was preserved. This candidate is not installer promotion,
an inference improvement, a new desktop build or closure of long-context issues.

## Fresh source snapshot

Remote branch tips were checked with Git on 12 September 2026. The GitHub
commits listing was cached; the individual commit and Git refs identify the
actual update.

| Engine track | Observed upstream revision | Update status |
| --- | --- | --- |
| antirez/ds4, main | `bd66c402070042bf0a79ad6ece8242de4c93680c` | Installer and managed checkout updated; complete native stack, Metal Engram/GGUF/operator/frontend tests and first launch pass |
| antirez/ds4, laguna-s2.1 | `448d5695d1c86401a4e9447c440feb983b73e6de` | No newer upstream commit observed |
| ivanfioravanti/ds4-metal, qwen3.8-flash-next | `ff4f0ff4fdff70d6b7c3941ef437b91dde960e14` | Two more commits appeared after the initial `2dda88e` snapshot; installer/managed checkout updated; native frontend, snapshot, patch, real-metadata, complete consumer-build and final first-launch checks pass |
| vagrillo/ds4, qwen35moe-support | `73434c4bb9d8bb18425a2577edada69d25d44c47` | Reviewed documentation-only update applied; runtime source/kernels unchanged; installer pin updated |
| Ninnix/q36, main | `8362010a301b3360296e435703f58ffc230a024a` | Exit/save, worker ownership and Google-link changes reviewed. Final monitor-owner gate passes 28 native/PTY stages; new 43-stage native/projector, 13 CLI admission and 46 real HTTP/image/tool/cache checks pass on this exact revision. Broad quality/long-context and host integration remain open; installer unchanged |
| signalnine/q27, master | `8cd708389f8b5a2c5a7c481237b00c8d7f570e7f` | Fresh isolated checkout; native CPU fixtures pass; a reproduced Metal DeltaNet failure is fixed and tested as a versioned patch. No real-model or CUDA qualification |

Main, Qwen Next and the Qwen3.6 MoE fork's installer pins have advanced. q36 and q27 remain
isolated review candidates, not promoted runtimes. Original model files and
settings are preserved. The older Qwen Next checkout has divergent upstream
history: its old branch/revision is retained and the reviewed new revision is
selected detached, without resetting the old branch or deleting its model link.

Main adds programming hints, continuation across context compaction, retained
vision context across tools, related release tests, and finally DeepSeek V4.1
Flash Metal support. Qwen Next already merges the pre-V4.1 changes; duplicate
cherry-picks are not needed. Architecture-specific Engram, attention, tokenizer
and tensor changes cannot be copied into the other model families wholesale.

The latest Qwen Next review reproduced an upstream allocation-failure defect:
lazy speculative snapshots published their PLE pointer before all recurrent
buffers existed. The [versioned fix](../patch/ds4-qwen38-snapshot/README.md)
publishes readiness last and cleans up failed candidates. Ten deterministic
allocation failpoints pass with ASan/UBSan, including retry and preservation of
the live state. The new main-to-Qwen vision-cache width fix and pre-verify rewind
commit are retained, not overwritten by DStudio's older patch context.

q36's new vision/context/SSD-accounting update overlaps DStudio's preparation
and ownership adaptation. The isolated three-way review is now resolved and
exported as [next-review.patch](../patch/q36-metal-runtime/next-review.patch),
but its complete runtime and real-model qualification remain open. It is not
promoted by the installer. Upstream's multimodal parser holds the inference
mutex while encoding images; the candidate instead retains request-owned
encoded bytes and prepares pixels on the existing inference worker. A private
visual-session copy is published only after owner, job, context and cancellation
revalidation. Native pending-call and image-identity checks are retained.
Its Metal attention kernel is unchanged by the update, so the earlier failed
long-context F16 replay is not resolved. q27's new tokenizer, prompt, sampler,
KV and DFlash changes require backend-specific qualification; this Mac has no
CUDA hardware. q27 also has its own Metal backend and custom q4s weight format;
neither is interchangeable with DStudio's existing Qwen GGUF installation.

q27's unchanged native Metal operator suite exposed a second real upstream
defect: its 512-thread DeltaNet dispatch exceeded that pipeline's M2 Max limit.
The [versioned correction](../patch/q27-metal-delta/README.md) assigns two
64-column groups to each head, with 256 threads per group and unchanged
per-column arithmetic. Both the original failure and the passing corrected
suite are retained. This is operator-level evidence, not a Qwen27B quality or
tokens-per-second result, and does not promote a new installed runtime.

The [complete new-commit inventory](upstream/engine-deltas-2026-09-12.json)
records 6 main, 0 Laguna, 66 Qwen Next, 2 Qwen3.6 MoE, 3 q36 and 69 q27 commits
from their displayed review baselines. Full first-parent diffs are hashed;
commit-message speed claims are not accepted benchmark results.
The [per-change portability review](upstream/main-portability-2026-09-12.md)
separates already integrated behavior, worthwhile unfinished backports and
architecture-specific changes that do not belong in other model families.

## Completed scoped evidence

- First real Qwen MoE continuation run `agent-continuation-live/run-lFiDBs`
  on Agent v99: **4/6 passed**, Metal resident Q6 weights, 8k context, same
  process throughout. All 200 generated C functions compiled and passed an
  independent executable oracle across actual mid-answer compaction. Original
  facts produced the correct file through real write/read tools; tools worked
  after Stop without changing the earlier file. Manual `/compact` falsely
  announced readiness before its commit, and non-interactive mode suppressed
  the Stop notice. These two failures remain in the denominator. Captured
  inputs were unchanged; the engine exited normally with code 0 and its owned
  PID was confirmed gone. No other engine was stopped. This is a development
  workflow regression, not held-out quality, desktop acceptance or a speed
  comparison. The original requests, answers, native traces and failures remain
  in ignored artifacts.
- Agent v100 addresses those two feedback/ownership defects across seven
  source variants. The native worker retains ownership until all deferred work
  finishes; pending commands cannot be overwritten or admitted concurrently.
  Stop survives the admission/dispatch gap, and JSONL service notices are
  displayed separately from the answer. Seven-base migration `run-ZdqwZF`
  passes, including reversal to unchanged v99/v98/v97/v86 predecessors.
  Laguna and MoE native barrier receipts `agent-idle/run-Gggw40` and
  `run-3IXGWm` pass **20/20 each**, with unchanged inputs and 2,144-byte workers.
  The same final probe on v99 passes **8/20 each**, retained as `run-XVGr4f`
  and `run-LlVhrB`. Initial probe receipts `run-zRt5un` / `run-Ua2Xyv` incorrectly
  expected a requested power value to be effective before the blocked API
  returned; the corrected oracle requires the earlier effective value in both
  variants. No production behavior was weakened to pass that check.
  The UI consumes actual native notice records in 135 fragmented-frame/visibility checks;
  the WebKit and Chromium app workflows also pass. Their engine responses are
  simulated. Light/dark notice-only Design screenshots were reviewed, including
  actual on-screen geometry and contrast; receipts `webkit-ohVk0e` and
  `chromium-Pn6ZYj` are under `agent-notice-visibility/`.
  The first attempt revealed notices being
  hidden with session bookkeeping; a distinct renderable service-notice type
  fixes that. The full consumer rebuild below and the separate real replays
  must not be confused with those browser fixtures.
- V100 native-consumer attempt `agent-native-build/run-HP2HES` completed all
  77 build/tool/Stop/parser/owner stages, but **failed final provenance**: a
  parallel host-builder check rebuilt `agent-build-probe` while the run was in
  progress. The original receipt is retained and is not accepted as a passing
  build or a prerequisite for real inference. This was test orchestration, not
  an inference crash. Full frozen-input rerun `agent-native-build/run-YInkMT`
  subsequently passes **77/77** stages: main 20, Laguna 19, Qwen Next 19 and
  older MoE 19. Final source, patch/helper and harness identities are unchanged.
  Receipt SHA-256:
  `223ca17eecc37d839b9d1a8f302f86b6a4f718c5a6bcadee72425044ce9c7e90`.
  The earlier provenance failure remains a failure, not an edited receipt.
  These are real builds/tools and controlled model replies, not LLM quality.
  Separate compaction receipts `run-IGbMfL` / `run-5OjAIG` pass 50/53 native
  framing, 16/14 scripted-loop and 14 publication checks per family. The added
  pre-dispatch Stop check fails on v99 (17 tokens generated instead of zero),
  retained in `run-i7SfOL`; it passes on v100. Qwen reset barriers also pass
  (`agent-session-reset/run-Qjavm5`, `run-eOvDQk`).
- V100 real MoE replay `agent-continuation-live/run-raYfjK` passes **5/6**.
  Manual compaction now commits before readiness, Stop emits its real JSONL
  notice, and facts/tool effects survive Stop. Generated C nevertheless omits
  every return type from its first line, before compaction. The original output
  fails both the strict syntax oracle and a separate C11 `-Werror` compiler;
  it is not repaired or excluded. Engine exit 0, captured inputs unchanged.
  Receipt SHA-256:
  `7862b683ccbf461d4627049cd0e82de114a7468cdc74abb121f6089e770276ea`.
  The v99/v100 initial system bytes and user prompts match, but the native
  session-date message differs. Therefore 4/6 versus 5/6 is not a controlled
  quality A/B comparison or evidence of numerical regression/improvement.
- V100 Laguna replay `agent-continuation-live/run-krSaOZ` passes **4/6**.
  All 200 generated functions compile and execute through actual compaction;
  manual compaction and Stop pass. The first summary drops the two explicit
  future-use facts, which are then unavailable for creating `after.json`.
  Native write/read works after Stop, but that case's prior-file invariant
  still fails because `after.json` was never created. No failed case is removed.
  Exit 0, inputs unchanged, owned process verified gone. Initial `run-yftqXG`
  retains its pre-load rejection of custom prefill with six cases not run.
  The runner now lets Laguna select its native prefill rather than supplying
  Qwen's 512-token override; context/output/model/sampling limits are unchanged.
- V101 changes only the private summary policy across the seven Agent variants:
  retain explicit future-use facts with their exact values, carry forward
  applicable prior durable state, distinguish corrections and don't mistake
  this internal request for user activity. No new authoritative memory store,
  cache, lock or automatic retry is introduced. Versioned `*-durable-summary.patch`
  deltas are folded into the full variants; seven-base migration `run-glX1Vq`
  passes with all frozen v100/v99/v98/v97/v86 predecessors preserved.
  V101 native consumer `agent-native-build/run-dtNcgs` passes **77/77**, with
  final captured source/patch/helper identities unchanged; receipt SHA-256
  `c22b750702fcaada92b1a9048e513450a7f0cbc3a49df8b732e7194e99063a77`.
  Native compaction `run-Os8ka2` / `run-uw7FJ3` passes 14 publication cases
  per family, 50/53 GGUF-tokenizer cases and 16/14 scripted-loop checks,
  including repeated compaction and Stop under ASan/UBSan. Native vocabulary
  is real, generation in these checks is simulated. The actual model replays
  are separate; a prompt change alone is not proof of summary fidelity or
  final campaign completion.
  The v101 real Laguna replay `agent-continuation-live/run-QcP9k6` subsequently
  passes **6/6**, retaining both values through two compactions and real
  write/read checks before/after Stop. All 200 C functions compile and pass
  the independent executable oracle. Exit 0, captured inputs unchanged and
  PID verified gone; receipt SHA-256
  `f22d6889d7f9d4e223c50fac7f257fac21cf68137cc0d1dfadd16f6c10efa461`.
  **Remaining fidelity gap:** manual review of the first private summary finds
  it calls the 200-function task complete while the reply is still open.
  Only 65 complete functions (`value_0` through `value_64`) exist at that
  boundary, after 1,063 output tokens and before any generation-complete event.
  The separate `manual-summary-review.json` is **FAIL** and pins its trace and
  original workflow receipt; it is not hidden inside the 6/6 workflow result.
  The preserved native tail lets generation finish correctly in this run,
  but 6/6 does not qualify summary truthfulness or the whole model. The next
  compaction change must preserve the current request/progress as well as
  older facts and use actual open-reply state; no model self-report authorizes
  task completion. The original 4/6 remains retained; this is a development
  replay, not a token-identical A/B or speed comparison. MoE v101 is separate.
- Fresh q36 `8362010` review retains its exact upstream Agent/web changes and
  the separate [monitor terminal patch](../patch/q36-agent-tty/README.md).
  `q36-agent-tty/run-zro9_7ab` passes all **24 stages**, including native
  ownership tests, fictional-password PTY interactions and 32 normal/cancelled
  job lifetimes with zero leaked descriptors. Completed historical jobs retain
  only their native master descriptor, not the added slave. Report SHA-256:
  `b846939e105fab0412fe19fced0add10c1d416d7e6bede7b5f5ebe631976519e`.
  The new upstream full-session PTY script targets Vulkan+SSD and has not been
  run unchanged on this Mac. Core, Metal kernels and server are unchanged since
  `8ce8924`, but neither that fact nor terminal tests qualify inference or the
  remaining long-context and monitor critical-path issues.
  The new exact-revision native/projector run `q36-metal-runtime/run-0Ykf7q`
  also passes **42/42**, including final input-identity verification; SHA-256
  `eb7fe695f41456419eb0bea803d16e81d28171282783aaba6e2e17faf071f6af`.
  Its real projector/scalar test does not load the Qwen language model.
  The compiled production search extractor passes 13/13 controlled-page
  cases in Chromium `run-Isb3Cz` and WebKit `run-W9TijB`. The same final harness
  on `8ce8924` passes 9/13 in each (`run-D1lr73`, `run-dIrVma`), retaining opaque
  redirect/title failures. These are `q36-search-extract/` artifacts with exact
  source provenance, not live Google, native CDP transport or model-quality tests.
  A separate native ASan/UBSan regression now reproduces the monitor critical
  path problem: `q36-monitor-control/run-SDJGtD` holds one output-file write
  behind a deterministic barrier. The real job-state query cannot finish and
  the job mutex is unavailable until that write resumes. Output is preserved,
  the real shell exits normally, inputs remain unchanged and no model runs.
  Job/worker sizes are 1,208/2,736 bytes. This is an open production defect,
  not another passing terminal test; moving signal/reap/output ownership needs
  its own complete fix and regressions before that path is qualified.
  The final same-harness attribution runs fail identically on the original
  upstream Git object (`run-p2HLgN`, job 1,200 bytes) and adapted source
  (`run-ChNShO`, job 1,208 bytes). Both execute the same native control accessor,
  preserve exact output/normal exit and retain unchanged input hashes. This
  particular blocked-write defect predates DStudio's terminal patch.
- Agent patch v98: compaction publication corrected for Laguna `448d569`
  and the older MoE fork `73434c4` (unchanged native Agent since `60fca11`).
  During the main-portability review, both published a candidate transcript
  and exported memory before successful rebuild. Late cancellation was also
  accepted. The [recorded correction](../patch/ds4-agent-jsonl/README.md) keeps
  the original conversation and memory on failure and publishes only through
  the worker after identity/cancellation revalidation. Export errors are
  reported in piped mode; no inferred rollback of previously committed tools.
  The final 14-case native-function harness passes **4/14 before → 14/14 after**
  per branch: `agent-compaction/run-XvWWAk` and `run-ZQ7QxN` retain the failures;
  `run-KKPyWK` and `run-wGTgjx` pass using production native patch
  transformation, not a network-installation test.
  All original failed receipts remain, including the first hidden export warning.
  These are deterministic session/tokenizer fixtures under ASan/UBSan, not
  model-quality tests. Worker layout stays 2,144 bytes on arm64. Barrier holds
  of 20/200 ms leave the control path accessible; opt-in probe observations
  separate preparation, lock and publication timings without production timers.
  Seven-base migration `agent-patch-migration/run-oxb0ru` passes apply/reverse,
  repeat/partial/drift rejection, unrelated-edit preservation and unchanged
  frozen v86/v97 identities. The exact derived SHA-256 values are
  `28cbb07f5857afd39a1287d864d2f46b3b799ac159255f8d1c1eb617a63f5827` (Laguna) and
  `02655465c0ebd17e40e353fe1998397769cb303fcabbffe0a71668c17dfcd693` (MoE);
  the reversible delta is `16202998886f9d4bd46467b0e0749d41a81fda3f3209bcb711b0bcfb67a34ace`.
  This v98 regression established publication, not automatic continuation;
  the separate v99 continuation evidence follows below.
- V98 complete native-consumer rerun `agent-native-build/run-l6tfMX` passes:
  all 69 stages over main, Laguna, Qwen Next and older MoE, including actual
  Agent/Cowork/Design builds, real workspace tool effects with simulated model
  replies, Stop/next-turn behavior and native parser/sanitizer probes.
  Source snapshots, supplied checkouts, patch/helper bytes and probes remain
  unchanged throughout. Receipt SHA-256:
  `ea3eee70be586feb998ab66c85f37e6e56c9e962ad7c9dc42e50250c383a096e`.
  `test-agent-build`, all 39 `test-unified-patch` checks and
  `test-engine-upstream` regressions also pass. This is not a fresh network
  install, real-model acceptance, final app rebuild or release push.
- Agent patch v99 now backports text continuation to Laguna and older MoE.
  Native BPE/ChatML framing, original retained token IDs, the same renderer and
  output budget survive repeated compaction. Incomplete tools are not executed;
  an explicit smaller complete retry performs its actual file write once.
  The intermediate tests also exposed memory being re-imported into the system
  prefix after export, invalidating the second open-answer boundary. Compaction
  now uses the stable system prefix; startup/reset memory behavior is unchanged.
  Original failing receipts `run-iBnqeM` / `run-Vwpree` remain retained.
  Production `make test-agent-continuation` receipts `run-Jntg6Y` / `run-CGHiec`
  pass 50/50 Laguna and 53/53 Qwen native-vocabulary framing checks, 15/15 and
  13/13 scripted native-loop checks, plus all 14 publication cases per branch
  under ASan/UBSan. The same final loop harness passes only 4/15 and 3/13 on v98
  (`run-5DMOsP` / `run-kAfUMN`). These tests read GGUF vocabulary/metadata, not
  weight tensors; they are not real-model summary quality or numerical parity.
  Seven-base migration `run-IR3WkB` passes with unchanged v98/v97/v86 oracles.
  Exact derived hashes are recorded in
  [bases.json](../patch/ds4-agent-jsonl/bases.json); separate per-branch deltas
  reproduce the change without editing original upstream Agent files.
- V99 complete native-consumer rerun `agent-native-build/run-ocDekM` passes
  main/Laguna/Qwen Next/older MoE Agent, Cowork and Design builds, actual tools
  with simulated model replies, Stop/next-turn behavior and parser sanitizers.
  All captured inputs remain unchanged. Receipt SHA-256:
  `cd9d617d2e8d58d9bf6737c2ce7aa90ccc1500bb98ca3678588842c103d10bbb`.
  Real-model long-answer continuation, summary quality, desktop and other
  backend acceptance remain open; no missing release receipt is filled here.
- First launch `first-launch-5a7HTl`: a relocated signed headless app, empty
  profile, real network source downloads and native builds for main, Laguna,
  Qwen Next (`2dda88e`) and Qwen3.6. All pass. The subsequent final-pin rerun
  `first-launch-WGejQn` also passes every engine at the revisions above, including
  source download, native compilation, browser reload discovery and six-patch
  restoration/reapplication. No weights or language generation in this gate.
- `agent-native-build/run-TFR8VE`: native main/Laguna/Qwen `2dda88e` Agent,
  Cowork, Design and parser/sanitizer checks pass with simulated model replies.
- `agent-native-build/run-xm4NJM`: final main/Laguna/Qwen Next/Qwen3.6 MoE
  consumer builds and native tool/parser checks pass. These are actual tools
  driven by simulated model replies, not new model-quality results.
- `backend-link/run-CIwGOr`: all 16 engine/backend Makefile routing cases pass
  with explicitly simulated compilers. This verifies dependency/link selection,
  not CUDA, ROCm or CPU numerical parity.
- `agent-prompts/run-U5CKVT` and `run-U5cZGE`: ten main and six Laguna native
  prompt builders pass. Initial `run-n4ptiw` exposed a missing Engram object in
  the main test harness's link list; the corrected harness retains the same
  observable schema assertions and the failed receipt.
- `agent-patch-migration/run-6YVqmf`: all seven explicit variants pass with
  independent Git application/reversal and unchanged historical oracles;
  Qwen Next's recorded Agent base is now `ff4f0ff` (identical Agent bytes).
- `qwen38-inspect/run-cjy37f`: native `ff4f0ff` CLI, real GGUF/PLE metadata,
  original full-prefault reproduction and zero-prefetch corrected inspection.
- `qwen38-prepare-patch/run-LAKCws`: complete multi-file lifecycle on `ff4f0ff`,
  partial/drift/ABI/symlink rejection and preservation of unrelated edits.
- `qwen38-snapshot/run-XjpM5H`: actual native helpers, ten simulated allocation
  failpoints, ASan/UBSan, retry, cleanup and patch lifecycle. Initial failing
  receipts, including the corrected drift-fixture error, remain retained.
- `ds41-update.08fcss/main-upgrade/qualification.json`: exact six-patch managed
  upgrade rehearsal, real Metal/operator and native frontend tests. The same
  reviewed stack was restored, fast-forwarded and reapplied in the managed main;
  native CLI/server/benchmark and Agent/Cowork/Design/PLD builds pass.
- `q27-metal-delta/run-G1s3Ld`: reproduced the original 512-thread failure;
  the corrected native Metal suite, CLI and server compile and pass. Twenty-four
  additional cases compare every recurrence/state output with an independent
  double-precision scalar oracle, including 48 heads and 96-token chunks.
  Observed maximum absolute error is about `1.011e-7` (unchanged upstream
  scaled tolerance `2e-3`); GPU chunked/serial results are bit-identical.
  Apply/repeat/restore, drift, partial, symlink and mixed host/shader ABI
  rejection pass while preserving unrelated edits. No model weights used.
- q36 `8ce8924` native CPU build, prompt-prefix/API parsing, extractor,
  sampling, quantization, SSD-cache, tool-format, vector and server fixtures
  pass. The 30 Python quality-harness checks exercise the harness, not 30
  model answers. The unchanged native Metal build still fails to link
  `q36_gpu_rope_qwen_mrope_rows_tensor`; the existing DStudio runtime patch
  supplies that missing implementation. The Agent test also needed a
  [test-only macOS header correction](../patch/q36-upstream-tests/README.md).
  Original failed logs are retained in `ds41-update.08fcss`.
- The isolated q36 rebase now builds the complete Metal CLI/server/benchmark,
  native Agent and test binary. This is compilation, not Agent qualification.
  `q36-dense-quant/run-VeFdSv` passes 75 CPU checks;
  `q36-recurrent-batch/run-uA1dp0` passes 96 actual Metal fixture cases and
  9,216 assertions with unchanged recurrent output. Neither loads an LLM.
- `q36-cancel-admission/run-W7Gvbc` retains the initial four failures caused
  by an outdated test image lacking native vision boundary tokens. The
  corrected input remains a valid image on both revisions and preserves all
  24 scenarios and 192 cancellation/state-integrity assertions. The same
  fixture passes the earlier patched core (`run-r1u1Fd`) and the new isolated
  candidate (`run-TtUOcQ`); no production validation was relaxed.
- `q36-vision-prepare-unit/run-RYJWyp`: 1,098 initialized-state scenarios and
  2,655 assertions cover exact image identity, private active-state copying,
  allocation/cancellation failures and unchanged source state. No CPU image
  inference is claimed. The previous text preparation still passes 2,070
  scenarios (`q36-text-prepare-unit/run-DPhCMW`). Both final-source reruns pass
  after the overflow guard: visual `run-UyhUDP` and text `run-LFfYPe`, with
  unchanged counts, zero leaked allocations and active-copy bytes independent
  of configured capacity (872 visual; 768 text).
- `q36-tool-schema/run-WxkMu9`: all 66 exact tool-argument and fragmented API
  replay cases pass on the candidate. Actual native functions, simulated model
  replies; not language-model quality. The request is now 216 bytes on arm64.
- `q36-tool-map/run-AP1c8i` preserves a failed NUL-ID corruption fixture: it
  targeted the old version-2 record offset, which is a flag in version 3.
  The corrected byte offset passes on both the candidate (`run-GBDSo3`, all
  255 truncation positions) and prior runtime (`run-ZZmWw0`, all 247 positions),
  retaining every corruption scenario. The additional version-3 gate
  `run-xt7Tpe` passes all 97 cases, including distinct per-ID preludes for shared
  sampled text, actual disk-only replay, explicit v1/v2 legacy wire fixtures,
  invalid flags and a blocked-write race where only the prelude changes.
- Native `q36_test --server` passes on pristine CPU and the Metal candidate
  after the same [test-only historical-prelude scenario correction](../patch/q36-upstream-tests/README.md).
  Independently, the native renderer matches all 32 cases from the original
  Qwen27B/Qwen3.6 GGUF templates (`q36-chat-template/run-j0ybk47s`). These are
  prompt-format checks; earlier real-model long-context failures remain open.
- `q36-http-vision/run-9osDLX`: 39 native parser/renderer cases and 11
  deterministic owner-publication cases pass on the new ABI. Exact image bytes,
  native random marker positions, Anthropic/Responses/tool images, existing
  count/byte bounds and cancellation are checked. The prior runtime passes its
  48 applicable cases (`run-s6mjI1`). The initial next-ABI probe accidentally
  selected KAT instead of Qwen by reversing its two profile booleans; its two
  failed history receipts (`run-AonIGR`) remain. Only that fixture call was
  corrected, not the expected Qwen rendering or production function. Full
  image-worker, live continuation and language-model qualification remain open.
- `q36-http-vision/run-W36zC0` extends the next-ABI gate to 61 passing cases:
  the same 11 owner scenarios now also run with prepared synthetic image spans
  and pending tool IDs. Failure/cancellation preserves both the previous session
  and its pending IDs; successful publication alone retires them. The updated
  common fixture also passes the prior runtime (`run-zNT4OU`, 48 cases). Pixel
  encoding is not simulated as a passing model answer; real image continuation
  remains a separate requirement.
- The complete candidate gate `q36-metal-runtime/run-1WSb3C` stopped at a
  version-2-only wire-size fixture. After extending that independent size
  oracle to version 3, the same 24 scenarios pass the prior runtime
  (`q36-http-text-prepare/run-Fq8YCv`) and candidate, including the unchanged
  one-byte-below-budget rejection. The subsequent complete run `run-s0HQy4`
  passes all executed lifecycle, build, control, cache, tool and Metal operator
  stages, but its final harness check compared the selected review hash to the
  old default patch file. This is retained as **FAIL**, not relabeled PASS.
  After the selected-file identity correction, the complete rerun
  `q36-metal-runtime/run-J6CLJ5` passes **all 41 stages**, including the expanded
  61-case image/owner gate and all final source/patch/harness identity checks.
  It ran after the V4.1 model exited, without overlapping GPU inference.
  No projector was supplied: real encoder embeddings and full-model quality
  remain NOT RUN for this receipt, and no installer pin is promoted by it.
- `q36-metal-runtime/run-GZfZjK` repeats the complete gate with the verified
  original Qwen27B F16 projector: **42/42 stages pass**. The actual Metal encoder
  and native scalar reference pass 15,385 assertions on two original RGB
  inputs, including failed-read integrity. Maximum absolute error is
  `0.001709`, relative L2 `0.00002601`, within the unchanged numerical bounds.
  This qualifies that bounded encoder comparison, not full LLM answers,
  long-context completion, desktop integration or another backend.
- `q36-http-vision-live/run-vf7idm`: **40/40 real Qwen27B/Metal workflows pass**
  on the rebuilt `8ce8924` review candidate. All 28 previous HTTP workflows
  remain, including original pixels, exact answers, real fixture-file tool
  reads, JSON/SSE, half-close, explicit cancellation and recovery. Twelve new
  checks exercise actual model-generated tool IDs and tool-only image
  continuation through OpenAI, Responses and Anthropic. Each preserves the
  original red image without resending its bytes; supplying blue pixels in
  the tool result changes the exact answer to blue. Native usage reports the
  retained 448/452/449-token image-conditioned prefix, respectively.
  Original model/projector hashes, complete source/patch identity and binary
  are revalidated after the run. The test ends normally with engine exit 0;
  no user app or other process was stopped. Receipt SHA-256:
  `68961c691984825b6815cee7bc6a138c65ef7d836c4fd7408334780a85bb28c6`.
  This is a development regression at 8k context with F16 KV, not a held-out
  quality score, full numerical equivalence, DStudio Agent loop or Qwen3.6
  model qualification. Disk-cache continuation was not enabled in this run.
- The extended disk-cache run `q36-http-vision-live/run-MO5enE` is **FAIL,
  43/46**, and is retained unchanged. All 40 image/tool workflows pass, as do
  exact disk-prefix restoration and Stop after a real private checkpoint.
  All five previously committed files remain byte-identical through Stop;
  the engine exits normally. The newly added image/tool scenarios leave a
  visual session immediately before the original cold-text scenario: that
  transition uses the visual preparation helper, which does not stage text
  checkpoints. No cold cache exists, the uninterrupted disk-hit assertion
  fails, and its dependent final continuation comparison cannot run. The
  earlier 40/40 receipt is not disk-cache qualification.

  Separately, the trace exposed an upstream/template incompatibility:
  `preserve_thinking: 1` retains Qwen's
  empty reasoning prelude in the next actual prompt, while the new native
  checkpoint canonicalizer removes it. The first mismatch is token 1292
  (live `LM`, incoming `<think>`); the server correctly rejects stale reuse,
  but rebuilds the whole prompt. The branch exists in pristine `8ce8924`
  and precedes its reasoning-preservation guard. Do not weaken template parity
  or accept an arbitrary cache path to make this pass. The subsequent correction
  below keeps the template and enforces an exact review-version frontier oracle.
- Review patch `582f57e7…` corrects that checkpoint gate and sends independent
  text after images through the private text/cache transaction. Matching text
  cannot authorize image-state reuse; pending tool IDs retire only on successful
  publication. Both single-session and batched publication revalidate the job.
  Native before/after is **30/35 → 35/35** (`q36-http-text-prepare/run-NQKZq2`
  and `run-UtpMgF`); the old pinned runtime retains 24 passing applicable cases.
  The complete native/projector gate passes **42/42** (`q36-metal-runtime/run-lS3fD1`),
  and actual native rendering matches **32/32** original GGUF template histories
  (`q36-chat-template/run-79jg4pky`). No LLM answer is inferred from those gates.
- The corresponding real run `q36-http-vision-live/run-6jY0tA` is **45/46 FAIL**.
  All 40 image/tool workflows, cold checkpoint preparation, exact memory-token
  continuation, disk-prefix restoration and continuation after Stop pass.
  The strict Stop/cache assertion catches one extra file: starting an unrelated
  prompt saves the newer 1,302-token prior session before the replacement is
  admitted. All four existing files retain their exact names, sizes and hashes;
  the old live session and all eight continuation-frontier fields are intact.
  Stop completes in 1.45 s, metadata in 1.25 ms, and the engine exits 0. These
  single observations are control diagnostics, not a performance benchmark.
  Neither the failure nor the unchanged-directory assertion is regraded.
- Final review patch `5d3ccc8a…` defers that eviction save until owner publication,
  outside shared locks and before retiring the old session. The new session's
  checkpoint frontier cannot inherit the evicted session's frontier. Eleven
  new deterministic scenarios retain a newer live session beside an older disk
  checkpoint: the previous review fails all eleven, in both scheduling modes.
  Full targeted results are **35/46 → 46/46** (`run-PZbA0t` → `run-c8NFg4`) and
  **25/36 → 36/36** (`run-Y9Ku4N` → `run-E66nSW`), under
  `q36-http-text-prepare`. Cancellation, native failure, late cancellation,
  stale session/job, changed context and shutdown cannot publish/evict any file.
  Successful retirement reloads the exact old fixture tokens/logits. Numerical
  work is simulated; production HTTP/cache/ownership and ASan/UBSan are real.
  Records remain 3,848/256/112/160 bytes (server/slot/progress/trace, arm64).
  The final-source `q36-metal-runtime/run-w0clga` passes all **42/42** stages,
  including the actual pinned projector/scalar comparison and final input
  identity checks. `q36-chat-template/run-gtvwb8u2` passes all **32/32** original
  GGUF history renderings on the same source. Complete native receipt SHA-256:
  `ab09656b7e506d6dc8ef176e6fbcb028a8d255f9c13f55a7a6939bfa22f81f64`.
  These native passes do not by themselves qualify model answers.
- Final-source real run `q36-http-vision-live/run-fSs5iW` passes **46/46**,
  without changing the corpus order, expected answers, cache-file assertions
  or deadlines from the preceding 45/46 run. All 40 image/tool workflows and
  all six cold/disk/live-cache/Stop scenarios pass on the original Qwen27B
  Q6_K_XL and F16 projector, Metal, 8k context, F16 KV and a 4 GiB disk-cache
  limit. Stop occurs after a real 512-token private checkpoint is written;
  all four published filenames, sizes and SHA-256 hashes remain identical,
  and no temporary checkpoint escapes cleanup. Before/after-Stop continuation
  returns the exact code and identical eight-field native cache decisions:
  1,302 live/common/cached tokens, 1,326 prompt tokens, `memory-token`, zero
  disk-cached tokens. Metadata takes 1.30 ms and Stop 2.51 s, inside the original
  bounds; these are single control observations, not a speedup or percentile.
  The run finishes at 16:44:49 UTC, engine exit 0, PID reaped, all captured
  source/patch/binary/model/projector identities unchanged. Receipt SHA-256:
  `a99490a2b87eaa70fb5b4fc00c193ef6e3a1082a5e8f8c8a4ecd800e125bd264`.
  It ran after the complete native gate, with no overlapping GPU test/model,
  user app restart, system-limit change or unrelated process termination.
  The failed 43/46 and 45/46 receipts remain, not replaced by this passing run.
  Full held-out answer quality, long-context execution, DStudio Agent/Cowork/app
  and other backends remain unqualified on the review pin; installer unchanged.

These ignored receipts do not qualify all model modes or platforms. No earlier
failed quality receipt has been removed or replaced.

## Requested model and measurement

The authorized download is `antirez/deepseek-v4.1-flash-gguf`, revision
`dd8a266f7145edc19e2334b46e19b6821f221dc7`, file
`DeepSeek-V4.1-Flash-Q2.gguf` (365,713,686,528 bytes), SHA-256
`1ce6a8f8806205c13330d7ca287bd198331dc5ca35ccc5d8a9a92a188a6f6f42`.
It was downloaded into an isolated ignored staging directory and made available
only after complete verification; the app's selected model was not changed.
Engram's native disk-backed table and expert SSD streaming are separate
mechanisms and must be reported separately.

The Q2 download completed on 12 September at 15:29 UTC with the exact expected
file size. `ds41-update.08fcss/ssd-benchmark-01` verified the complete SHA-256
in 157.66 seconds before admitting the model process. A no-clobber hard link
also makes the verified file available in `ds4/gguf/`; no duplicate 341 GiB
copy, weight replacement or saved preference change was made. The real model
started at 15:32 UTC and reached HTTP readiness in 7.02 seconds.

The first run uses 32,768 context capacity and an 8 GiB combined cache/prefill
budget. Native diagnostics confirm SSD expert streaming with 9.37 GiB static
weights, 7.12 GiB prefill reserve, only 0.88 GiB dynamic cache (95 experts), and
25.25 GiB planned total memory. The native engine warns that this small cache
will churn; this is not a peak-throughput configuration. Engram stays disk-only.

The measurement host is an Apple M2 Max with 96 GiB of unified memory. Upstream
documents a Q2 SSD-streaming example on a 128 GiB Mac; that is not qualification
for this smaller host. No wired-memory limits or unrelated applications have
been changed. The complete run finished at 15:41 UTC: **13/14 conforming answers**,
one retained format failure, no incomplete requests and a clean engine exit 0.
Python arithmetic returns the correct `56` but includes unwanted explanatory
text. The benchmark therefore exits 1; the checker is not loosened and no
fully qualified speed comparison is claimed. All three repetitions of copy,
numeric ordering and record extraction pass, but do not erase that failure.

The requested `DeepSeek-V4.1-Flash-Q2-SSD-performance.txt` is written on the
Desktop. It includes the failed gate, native memory warning, per-workload
observed timings and limitations. Its measurements are explicitly not a fully
qualified speed result: observed median decode is 4.07/4.20/4.11 token/s for
copy/order/extraction, while prefill is 4.52/3.95/50.59 token/s. The 1,453-token
extraction prompt uses upstream's bulk prefill; the two short prompts are below
its 256-token SSD threshold. No peak, cross-model or before/after claim is made.
The test-owned engine was stopped normally; desktop selection and settings
remain unchanged. Results have not been published or pushed.

Remaining: complete q36's broad quality, long-context, Learn, existing-install
upgrade and desktop/backend qualification, plus the wider plan's model/backend
acceptance. Scoped fresh-install and DStudio tool evidence is recorded above;
it does not close these requirements. Main/Qwen Next
consumer builds, model-byte verification, real SSD loading, retained answer
checks and the requested Desktop report are done at their explicitly recorded
scope. Complete the applicable cross-engine review before promoting further pins.

Source: [ds4 V4.1 support commit](https://github.com/antirez/ds4/commit/bd66c402070042bf0a79ad6ece8242de4c93680c),
[pinned model repository](https://huggingface.co/antirez/deepseek-v4.1-flash-gguf/tree/dd8a266f7145edc19e2334b46e19b6821f221dc7).

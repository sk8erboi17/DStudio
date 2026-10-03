# pi-ds4: host-owned ds4-server

Base: [mitsuhiko/pi-ds4](https://github.com/mitsuhiko/pi-ds4) at
`db8806cd52757fbaf957fe56b54700a1094a30b8`, the snapshot in
[`src/harness/pi-ds4`](../../src/harness/pi-ds4/). Apply order: `external-server.patch`.
`scripts/install-harness.py` applies it with `git apply --check` first, so a
drifted base fails before any byte changes; the receipt records its SHA-256.

Unpatched, pi-ds4 owns its inference server: it clones antirez/ds4 when no
runtime is configured, always runs `make ds4-server`, starts the server
detached with a watchdog, and keeps state in `~/.pi/ds4`. Inside DStudio that
server would escape Stop and could load a second large model beside the
app's own. The patch adds two opt-in environment variables:

- `DS4_STATE_DIR` replaces `~/.pi/ds4` for settings, locks and logs.
- `DS4_EXTERNAL_BASE_URL` (with `DS4_EXTERNAL_MODEL`, `DS4_CONTEXT_TOKENS`,
  `DS4_API_KEY`, optional `DS4_EXTERNAL_MODEL_NAME`/`DS4_EXTERNAL_VISION`)
  registers the `ds4` provider for an existing endpoint and returns. It never
  clones, builds, starts, watches or stops a server, and writes no state.

Model metadata is unchanged: DeepSeek thinking format, reasoning content on
assistant messages, the `off`/`high`/`max` thinking levels and the protocol
choice (`DS4_PROTOCOL`). Without these variables pi-ds4 behaves exactly as
upstream. The DStudio bridge owns the ds4-server process and points this
extension at its loopback endpoint.

Verification: `make test-harness-patches` (apply, repeat-apply rejection,
reverse, drift rejection) and the live harness gate.

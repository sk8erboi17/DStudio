# Pinned upstream engine sources

These source snapshots ship with DStudio and are copied locally during setup.
No separate engine clone or source download is required. Engine code retains
its upstream bytes and licenses; DStudio adaptations remain in `patch/`.

[Installation, provenance, verification and refresh workflow](../../docs/BUNDLED_ENGINES.md).
[Per-file identities and declared omissions](manifest.json).

Only active engine snapshots are distributed. Qwen Next uses `ds4/`; the
retired separate fork remains documented in `patch/` and Git history.
Writable installed engines, models, caches and build products remain outside
these snapshots and are not committed.

# Existing Qwen3.6 archive: documentation-only upstream update

[`documentation-73434c4.patch`](documentation-73434c4.patch) is the exact combined
upstream diff from `vagrillo/ds4` `60fca11f0c8b16ca50c757324dddd717ba043098` to
`73434c4bb9d8bb18425a2577edada69d25d44c47`. Both commits change only
`dynamicmoeinference.md`; all 1,525 other Git tree entries are identical.
MIT notices remain applicable. External llama.cpp links in the document do not
import that runtime into DStudio or qualify its reported benchmark.

Fresh installs download the new pinned archive, so they must not apply this
already-upstream delta again. It records the reviewed update of an existing
archive without replacing its inference sources, DStudio adaptations, binaries,
model symlink or unrelated local files. Exact old-file identity and forward
applicability are checked before application; the archive provenance metadata
records the old/new revision and this patch. This is not an inference change.

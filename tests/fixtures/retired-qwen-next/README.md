# Historical Qwen Next regression inputs

These five compressed upstream files keep archived patch regressions available
offline after removing the obsolete installed `ds4-qwen38/` checkout. They are
test data; the active Qwen Next runtime uses the bundled main engine.

| Exact upstream revision | Files | Consumer |
| --- | --- | --- |
| `b4c355079d375d20821ece732e99195c71b32c06` | `ds4_agent.c` | Historical Agent patch migration |
| `bd9cfbccc03a709a3f00b50e0ac1cc41c3fcf02d` | `ds4_web.c` | Historical Web patch migration |
| `ff4f0ff4fdff70d6b7c3941ef437b91dde960e14` | `ds4_agent.c`, `ds4.c`, `ds4.h` | Agent migration and inspection-patch lifecycle |

Repository: [ivanfioravanti/ds4-metal](https://github.com/ivanfioravanti/ds4-metal).
The files retain the upstream [MIT license](LICENSE) and embedded notices.
[Provenance](provenance.json) records each original and compressed size and
SHA-256. Each input was read with `git show REVISION:FILE`, checked against the
existing patch manifest where applicable, and compressed with gzip level 9 and
`mtime=0`. No DStudio adaptation is included in these original bytes.

The shared test reader verifies both hashes and bounds decompression before the
production patch functions consume the source. The lifecycle tests retain their
independent Git apply/reversal oracle, drift rejection and unrelated-edit checks.

Native inspection still requires an explicitly supplied full historical source
checkout and existing matching weights. These inputs contain no binaries, models,
Git checkout or complete engine build tree. Historical backend build routing can
still be tested by passing an explicit source directory to its integration test.

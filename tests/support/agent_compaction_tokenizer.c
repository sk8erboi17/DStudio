/* Test-only access to the exact pinned GGUF vocab and native chat encoder.
 * Same metadata path as ds4_dump_text_tokenization(): no weights, sessions or
 * GPU resources are loaded. Compile instead of ds4.o, never edit the checkout. */
#include "ds4.c"

ds4_engine *dstudio_test_tokenizer_open(const char *path) {
    ds4_engine *engine = calloc(1, sizeof(*engine));
    if (!engine) return NULL;
    model_open(&engine->model, path, false, false);
    config_validate_model(&engine->model);
    vocab_load(&engine->vocab, &engine->model);
    return engine;
}

void dstudio_test_tokenizer_close(ds4_engine *engine) {
    if (!engine) return;
    vocab_free(&engine->vocab);
    model_close(&engine->model);
    free(engine);
}

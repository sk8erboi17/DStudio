/* Real Qwen engine/weights; public session API only. Development regression,
 * not a held-out language-quality evaluation or an independent engine oracle. */
#include "ds4.h"
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

static char error[512];
#define REQUIRE(x) do { if (!(x)) { \
    fprintf(stderr, "FAIL line %d: %s; %s\n", __LINE__, #x, error); exit(1); \
} } while (0)
static double seconds(void) {
    struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t);
    return (double)t.tv_sec + (double)t.tv_nsec / 1e9;
}
typedef struct {
    int cancel_layer, layers, chunks, last_layer, total_layers;
    bool cancelled;
    double cancel_at;
} control;
static bool cancelled(void *ud) { return ((control *)ud)->cancelled; }
static void display(void *ud, const char *event, int current, int total) {
    control *c = ud;
    if (strcmp(event, "prefill_layer")) return;
    REQUIRE(current > 0 && current <= total);
    REQUIRE(c->last_layer == 0 || current == c->last_layer + 1 || current == 1);
    c->last_layer = current; c->total_layers = total; c->layers++;
    if (current == c->cancel_layer) { c->cancel_at = seconds(); c->cancelled = true; }
}
static void progress(void *ud, const char *event, int current, int total) {
    control *c = ud;
    if (!strcmp(event, "prefill_chunk")) {
        REQUIRE(current > 0 && current <= total); c->chunks++;
    }
}
static void attach(ds4_session *s, control *c) {
    ds4_session_set_cancel(s, cancelled, c);
    ds4_session_set_display_progress(s, display, c);
    ds4_session_set_progress(s, progress, c);
}
static ds4_session *session(ds4_engine *e) {
    ds4_session *s = NULL;
    REQUIRE(ds4_session_create(&s, e, 16384) == 0 && s);
    return s;
}
static void snapshot(ds4_session *s, ds4_session_snapshot *out) {
    REQUIRE(ds4_session_save_snapshot(s, out, error, sizeof(error)) == 0);
    REQUIRE(out->len > 0 && out->len < 1024ull * 1024ull * 1024ull);
}
static void same_snapshot(ds4_session *s, const ds4_session_snapshot *expected) {
    ds4_session_snapshot got = {0}; snapshot(s, &got);
    REQUIRE(got.len == expected->len && !memcmp(got.ptr, expected->ptr, got.len));
    ds4_session_snapshot_free(&got);
}
static void invalid_candidate(ds4_session *s) {
    ds4_session_snapshot snap = {0};
    REQUIRE(ds4_session_pos(s) == 0);
    REQUIRE(ds4_session_save_snapshot(s, &snap, error, sizeof(error)) != 0);
    ds4_session_snapshot_free(&snap); error[0] = 0;
}
static int equal_logits(ds4_session *a, ds4_session *b, int vocab, float *x, float *y) {
    REQUIRE(ds4_session_copy_logits(a, x, vocab) == vocab);
    REQUIRE(ds4_session_copy_logits(b, y, vocab) == vocab);
    int top = 0;
    for (int i = 0; i < vocab; i++) {
        REQUIRE(isfinite(x[i]) && isfinite(y[i]));
        if (x[i] > x[top]) top = i;
    }
    REQUIRE(!memcmp(x, y, (size_t)vocab * sizeof(float)));
    return top;
}
int main(int argc, char **argv) {
    REQUIRE(argc == 3);
    setvbuf(stdout, NULL, _IOLBF, 0);
    ds4_engine_options options = {.model_path = argv[1], .ple_path = argv[2],
        .backend = DS4_BACKEND_METAL, .n_threads = 8, .context_size = 16384,
        .power_percent = 100, .placement_ctx_hint = 16384, .placement_session_count_hint = 2};
    ds4_engine *engine = NULL;
    double began = seconds();
    REQUIRE(ds4_engine_open(&engine, &options) == 0 && engine);
    REQUIRE(ds4_engine_is_qwen4(engine));
    printf("{\"case\":\"load\",\"seconds\":%.6f,\"context\":16384,\"expertStreaming\":false}\n", seconds()-began);
    ds4_tokens seed = {0}, long_prompt = {0};
    ds4_tokenize_text(engine, "Keep the exact code RIVER-7294. This fixture tests recurrent session isolation.\n", &seed);
    REQUIRE(seed.len > 0);
    for (int i = 0; i < 8193; i++) ds4_tokens_push(&long_prompt, seed.v[i % seed.len]);
    ds4_session *live = session(engine);
    REQUIRE(ds4_session_sync(live, &seed, error, sizeof(error)) == 0);
    ds4_session_snapshot live_before = {0}; snapshot(live, &live_before);
    REQUIRE(ds4_session_prepare_empty(live, &seed, error, sizeof(error)) != 0);
    same_snapshot(live, &live_before); error[0] = 0;
    printf("{\"case\":\"nonempty-rejected-unchanged\",\"passed\":true}\n");
    for (int at = 0; at < 3; at++) {
        const int layer = at == 0 ? 0 : at == 1 ? 1 : 4;
        ds4_session *candidate = session(engine);
        control c = {.cancel_layer = layer, .cancelled = layer == 0};
        attach(candidate, &c); began = seconds();
        const int rc = ds4_session_prepare_empty(candidate, &long_prompt, error, sizeof(error));
        const double elapsed = seconds() - began;
        const double delay = layer ? seconds() - c.cancel_at : elapsed;
        REQUIRE(rc == DS4_SESSION_SYNC_INTERRUPTED);
        REQUIRE(c.layers == layer && c.chunks == 0 && delay < 15.0);
        invalid_candidate(candidate); ds4_session_free(candidate);
        same_snapshot(live, &live_before);
        printf("{\"case\":\"cancel\",\"layer\":%d,\"elapsedSeconds\":%.6f,\"cancelReturnSeconds\":%.6f,\"oldSnapshotUnchanged\":true,\"passed\":true}\n", layer, elapsed, delay);
    }
    ds4_session *candidate = session(engine);
    ds4_tokens invalid = {0}; ds4_tokens_push(&invalid, -1);
    REQUIRE(ds4_session_prepare_empty(candidate, &invalid, error, sizeof(error)) != 0);
    invalid_candidate(candidate); same_snapshot(live, &live_before); ds4_tokens_free(&invalid);
    printf("{\"case\":\"invalid-prompt-preserves-live\",\"passed\":true}\n");
    /* Reuse the invalidated private candidate. Compare against the unchanged
     * normal sync oracle, including both sides of the 8,192-token boundary. */
    control c = {0}; attach(candidate, &c);
    ds4_session_invalidate(live); began = seconds();
    REQUIRE(ds4_session_sync(live, &long_prompt, error, sizeof(error)) == 0);
    const double reference_s = seconds() - began;
    began = seconds();
    REQUIRE(ds4_session_prepare_empty(candidate, &long_prompt, error, sizeof(error)) == 0);
    const double candidate_s = seconds() - began;
    REQUIRE(c.total_layers > 4 && c.layers == c.total_layers * 2 && c.chunks == 2);
    const int vocab = ds4_engine_vocab_size(engine);
    REQUIRE(vocab > 0 && vocab < 2000000);
    float *a = malloc((size_t)vocab * sizeof(float)), *b = malloc((size_t)vocab * sizeof(float));
    REQUIRE(a && b);
    int token = equal_logits(live, candidate, vocab, a, b);
    ds4_session_snapshot expected = {0}; snapshot(live, &expected); same_snapshot(candidate, &expected);
    printf("{\"case\":\"prefill-parity\",\"tokens\":8193,\"vocab\":%d,\"referenceSeconds\":%.6f,\"candidateSeconds\":%.6f,\"snapshotBytes\":%llu,\"bitExactLogitsAndState\":true,\"passed\":true}\n",
           vocab, reference_s, candidate_s, (unsigned long long)expected.len);
    ds4_session_snapshot_free(&expected);
    for (int i = 0; i < 8; i++) {
        REQUIRE(ds4_session_eval(live, token, error, sizeof(error)) == 0);
        REQUIRE(ds4_session_eval(candidate, token, error, sizeof(error)) == 0);
        token = equal_logits(live, candidate, vocab, a, b);
    }
    snapshot(live, &expected); same_snapshot(candidate, &expected);
    printf("{\"case\":\"decode-parity\",\"tokens\":8,\"bitExactLogitsAndState\":true,\"passed\":true}\n");
    ds4_session_snapshot_free(&expected); ds4_session_snapshot_free(&live_before);
    free(a); free(b); ds4_tokens_free(&seed); ds4_tokens_free(&long_prompt);
    ds4_session_free(candidate); ds4_session_free(live); ds4_engine_close(engine);
    return 0;
}

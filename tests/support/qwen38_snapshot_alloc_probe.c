/* Execute the actual native allocation helpers with deterministic allocation
 * failures. No model weights, GPU work or replacement inference math. */
#define ds4_gpu_tensor_alloc snapshot_test_alloc
#define ds4_gpu_tensor_free snapshot_test_free
#define ds4_gpu_tensor_fill_f32 snapshot_test_fill
#include "ds4.c"
#undef ds4_gpu_tensor_alloc
#undef ds4_gpu_tensor_free
#undef ds4_gpu_tensor_fill_f32
#include <assert.h>

static unsigned calls, fail_at, live;
ds4_gpu_tensor *snapshot_test_alloc(uint64_t bytes) {
    assert(bytes && bytes < 65536);
    if (++calls == fail_at) return NULL;
    ds4_gpu_tensor *t = malloc(sizeof(*t)); assert(t);
    t->bytes = bytes; live++; return t;
}
void snapshot_test_free(ds4_gpu_tensor *t) {
    if (!t) return;
    assert(live); live--; free(t);
}
int snapshot_test_fill(ds4_gpu_tensor *t, float value, uint64_t count) {
    assert(t && value == 0 && count * sizeof(float) == t->bytes); return 1;
}
static ds4_gpu_tensor marker = {.bytes = 16};
static void setup(ds4_qwen4_gpu_graph *g) {
    memset(g, 0, sizeof(*g));
    g->snap_ple_hist = &marker;
    g->snap_lin_state[0] = g->snap_lin_state[2] = &marker;
    g->pos = 73; g->mrope_delta = 11;
    g->ple_prev[0] = 29;
}
static void check_set(ds4_qwen4_gpu_graph *g, bool zero, bool complete) {
    ds4_gpu_tensor **state = zero ? g->snap0_lin_state : g->snap2_lin_state;
    ds4_gpu_tensor **hist = zero ? g->snap0_lin_hist : g->snap2_lin_hist;
    ds4_gpu_tensor *ple = zero ? g->snap0_ple_hist : g->snap2_ple_hist;
    assert((ple != NULL) == complete);
    for (unsigned i = 0; i < DS4_MAX_LAYER; i++) {
        const bool expected = complete && (i == 0 || i == 2);
        assert((state[i] != NULL) == expected);
        assert((hist[i] != NULL) == expected);
    }
    assert(g->pos == 73 && g->mrope_delta == 11 && g->ple_prev[0] == 29);
    assert(g->snap_ple_hist == &marker && g->snap_lin_state[0] == &marker && g->snap_lin_state[2] == &marker);
}
static void retire(ds4_qwen4_gpu_graph *g, bool zero) {
    ds4_gpu_tensor **state = zero ? g->snap0_lin_state : g->snap2_lin_state;
    ds4_gpu_tensor **hist = zero ? g->snap0_lin_hist : g->snap2_lin_hist;
    snapshot_test_free(zero ? g->snap0_ple_hist : g->snap2_ple_hist);
    for (unsigned i = 0; i < DS4_MAX_LAYER; i++) {snapshot_test_free(state[i]); snapshot_test_free(hist[i]);}
}
int main(void) {
    g_ds4_shape.n_layer = 3; g_ds4_shape.n_embd = 4; g_ds4_shape.n_hc = 2;
    g_ds4_shape.n_lin_k_head = 1; g_ds4_shape.n_lin_v_head = 2;
    g_ds4_shape.n_lin_head_dim = 2; g_ds4_shape.n_lin_conv = 3;
    g_ds4_shape.n_ple_conv = 3; g_ds4_shape.n_ple_ngram = 2;
    for (unsigned which = 0; which < 2; which++) {
        const bool zero = which == 0;
        bool (*ensure)(ds4_qwen4_gpu_graph *) = zero ? qwen4_graph_ensure_snap0 : qwen4_graph_ensure_snap2;
        for (unsigned failure = 1; failure <= 5; failure++) {
            ds4_qwen4_gpu_graph g; setup(&g); calls = 0; fail_at = failure;
            assert(!ensure(&g));
            fprintf(stderr, "snapshot=%u failure=%u outstanding=%u\n", zero ? 0 : 2, failure, live);
            assert(live == 0); check_set(&g, zero, false);
            // Retry must allocate a complete set, not mistake a partial PLE
            // pointer left by the failed attempt for an admitted snapshot.
            fail_at = 0; calls = 0;
            assert(ensure(&g)); assert(live == 5); check_set(&g, zero, true);
            const unsigned before = calls;
            assert(ensure(&g)); assert(calls == before); check_set(&g, zero, true);
            retire(&g, zero); assert(live == 0);
        }
    }
    puts("qwen38 snapshot allocation: PASS (10 allocation failpoints, complete retries, no leaks or live-state changes)");
    return 0;
}

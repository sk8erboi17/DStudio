// Real Metal operator and command-publication checks, no engine/model opening.
// Including the implementation permits a deterministic driver-allocation gate;
// assertions exercise native operations and results, not source declarations.
#include DSTUDIO_Q36_METAL_SOURCE
#include <math.h>
#include <dispatch/dispatch.h>
#include <time.h>

static unsigned checks, failures;
static double max_error;
#define CHECK(expr) do { checks++; if (!(expr)) { failures++; \
    fprintf(stderr, "FAIL line %d: %s\n", __LINE__, #expr); } } while (0)

static void reference(float *out, uint32_t heads, uint32_t tokens, const uint32_t *positions) {
    // Scalar oracle for the pinned Vulkan contract: FP32 frequency recurrence,
    // then independently evaluated libm sine/cosine and the 2D rotation.
    const float step = (float)pow(10000000.0, -2.0 / 64.0);
    for (uint32_t t = 0; t < tokens; t++) for (uint32_t h = 0; h < heads; h++) {
        float *row = out + ((uint64_t)t * heads + h) * 256u;
        for (uint32_t pair = 0; pair < 32u; pair++) {
            float theta = (float)positions[(uint64_t)t * 3u + pair % 3u];
            for (uint32_t i = 0; i < pair; i++) theta *= step;
            float cs = (float)cos((double)theta), sn = (float)sin((double)theta);
            float a = row[pair], b = row[pair + 32u];
            row[pair] = a * cs - b * sn;
            row[pair + 32u] = a * sn + b * cs;
        }
    }
}

static void operator_case(uint32_t heads, uint32_t tokens) {
    const size_t count = (size_t)heads * tokens * 256u, prefix = 16u, total = count + 2u * prefix;
    float *original = malloc(total * sizeof(float)), *expected = malloc(count * sizeof(float));
    float *actual = malloc(total * sizeof(float));
    uint32_t *positions = malloc((size_t)tokens * 3u * sizeof(uint32_t));
    CHECK(original && expected && actual && positions);
    if (!original || !expected || !actual || !positions) goto host_done;
    for (size_t i = 0; i < total; i++) original[i] = (float)((int)(i * 23u % 127u) - 63) / 64.0f;
    const uint32_t samples[][3] = {{0, 0, 0}, {7, 11, 19}, {131072, 1023, 2047}, {262143, 262141, 262139}};
    for (uint32_t i = 0; i < tokens; i++) memcpy(positions + i * 3u, samples[i % 4], sizeof(samples[0]));
    memcpy(expected, original + prefix, count * sizeof(float));
    reference(expected, heads, tokens, positions);
    q36_gpu_tensor *base = q36_gpu_tensor_alloc(total * sizeof(float));
    q36_gpu_tensor *view = q36_gpu_tensor_view(base, prefix * sizeof(float), count * sizeof(float));
    CHECK(base && view);
    if (base && view) {
        CHECK(q36_gpu_tensor_write(base, 0, original, total * sizeof(float)));
        CHECK(q36_gpu_rope_qwen_mrope_rows_tensor(view, heads, positions, tokens));
        // A pending command must own its uploaded positions, not this array.
        memset(positions, 0, (size_t)tokens * 3u * sizeof(uint32_t));
        CHECK(q36_gpu_tensor_read(base, 0, actual, total * sizeof(float)));
        CHECK(memcmp(actual, original, prefix * sizeof(float)) == 0);
        CHECK(memcmp(actual + prefix + count, original + prefix + count, prefix * sizeof(float)) == 0);
        for (size_t i = 0; i < count; i++) {
            double delta = fabs((double)actual[prefix + i] - expected[i]);
            if (delta > max_error) max_error = delta;
            CHECK(isfinite(actual[prefix + i]) && delta <= 1e-5);
            if (i % 256u >= 64u) CHECK(memcmp(actual + prefix + i, original + prefix + i, sizeof(float)) == 0);
        }
        CHECK(!q36_gpu_rope_qwen_mrope_rows_tensor(NULL, heads, positions, tokens));
        CHECK(!q36_gpu_rope_qwen_mrope_rows_tensor(view, 0, positions, tokens));
        CHECK(!q36_gpu_rope_qwen_mrope_rows_tensor(view, heads, NULL, tokens));
        CHECK(!q36_gpu_rope_qwen_mrope_rows_tensor(view, heads, positions, 0));
        CHECK(!q36_gpu_rope_qwen_mrope_rows_tensor(view, heads, positions, tokens + 1));
        CHECK(!q36_gpu_rope_qwen_mrope_rows_tensor(view, UINT32_MAX, positions, UINT32_MAX));
        CHECK(q36_gpu_tensor_read(base, 0, original, total * sizeof(float)));
        CHECK(memcmp(actual, original, total * sizeof(float)) == 0);
    }
    q36_gpu_tensor_free(view); q36_gpu_tensor_free(base);
host_done:
    free(original); free(expected); free(actual); free(positions);
}

static void shape_case(bool dense, uint32_t tokens) {
    // These are the two pinned architectures, not dimensions inferred from a
    // view's capacity. Q extraction and recurrent history must keep every row.
    const uint32_t heads = dense ? 24u : 16u, values = dense ? 6144u : 4096u;
    const uint32_t conv = 4096u + values;
    const size_t qcount = (size_t)tokens * heads * 256u, guard = 16u;
    const size_t qtotal = qcount + 2u * guard;
    float *qg = malloc(qcount * 2u * sizeof(float));
    float *want = malloc(qtotal * sizeof(float)), *got = malloc(qtotal * sizeof(float));
    CHECK(qg && want && got);
    if (!qg || !want || !got) { free(qg); free(want); free(got); return; }
    q36_gpu_set_dense_model(dense);
    for (size_t i = 0; i < qcount * 2u; i++) qg[i] = (float)(i % 131071u);
    for (size_t i = 0; i < qtotal; i++) want[i] = -913.0f;
    q36_gpu_tensor *qsrc = q36_gpu_tensor_alloc(qcount * 2u * sizeof(float));
    q36_gpu_tensor *qbase = q36_gpu_tensor_alloc(qtotal * sizeof(float));
    q36_gpu_tensor *qout = q36_gpu_tensor_view(qbase, guard * sizeof(float), qcount * sizeof(float));
    CHECK(qsrc && qbase && qout);
    if (qsrc && qbase && qout) {
        CHECK(q36_gpu_tensor_write(qsrc, 0, qg, qcount * 2u * sizeof(float)));
        CHECK(q36_gpu_tensor_write(qbase, 0, want, qtotal * sizeof(float)));
        for (size_t row = 0; row < (size_t)heads * tokens; row++)
            memcpy(want + guard + row * 256u, qg + row * 512u, 256u * sizeof(float));
        CHECK(q36_gpu_extract_full_attn_q_tensor(qout, qsrc, tokens));
        CHECK(q36_gpu_tensor_read(qbase, 0, got, qtotal * sizeof(float)));
        CHECK(memcmp(got, want, qtotal * sizeof(float)) == 0);
        CHECK(!q36_gpu_extract_full_attn_q_tensor(qout, qsrc, tokens + 1u));
        CHECK(!q36_gpu_extract_full_attn_q_tensor(qout, qsrc, UINT32_MAX / heads + 2u));
        CHECK(q36_gpu_tensor_read(qbase, 0, got, qtotal * sizeof(float)));
        CHECK(memcmp(got, want, qtotal * sizeof(float)) == 0);
    }
    q36_gpu_tensor_free(qout); q36_gpu_tensor_free(qbase); q36_gpu_tensor_free(qsrc);
    free(qg); free(want); free(got);

    const size_t ccount = (size_t)tokens * conv, vcount = (size_t)tokens * values;
    const size_t history = 3u * conv, window = 4u * ccount;
    float *cur = malloc(ccount * sizeof(float)), *state = malloc(history * sizeof(float));
    float *expected_state = malloc(history * sizeof(float)), *expected = malloc(window * sizeof(float));
    float *observed = malloc(window * sizeof(float)), *v = malloc(vcount * sizeof(float));
    CHECK(cur && state && expected_state && expected && observed && v);
    if (!cur || !state || !expected_state || !expected || !observed || !v) goto done;
    for (size_t i = 0; i < ccount; i++) cur[i] = (float)(i + 1u);
    for (size_t i = 0; i < history; i++) state[i] = -(float)(i + 1u);
    memcpy(expected_state, state, history * sizeof(float));
    for (uint32_t t = 0; t < tokens; t++) {
        memcpy(expected + (size_t)t * 4u * conv, expected_state, history * sizeof(float));
        memcpy(expected + ((size_t)t * 4u + 3u) * conv, cur + (size_t)t * conv, conv * sizeof(float));
        memmove(expected_state, expected_state + conv, 2u * conv * sizeof(float));
        memcpy(expected_state + 2u * conv, cur + (size_t)t * conv, conv * sizeof(float));
    }
    q36_gpu_tensor *input = q36_gpu_tensor_alloc(ccount * sizeof(float));
    q36_gpu_tensor *cache = q36_gpu_tensor_alloc(history * sizeof(float));
    q36_gpu_tensor *windows = q36_gpu_tensor_alloc(window * sizeof(float));
    q36_gpu_tensor *out = q36_gpu_tensor_alloc(vcount * sizeof(float));
    CHECK(input && cache && windows && out);
    if (input && cache && windows && out) {
        CHECK(q36_gpu_tensor_write(input, 0, cur, ccount * sizeof(float)));
        CHECK(q36_gpu_tensor_write(cache, 0, state, history * sizeof(float)));
        memset(observed, 0, window * sizeof(float));
        memset(v, 0, vcount * sizeof(float));
        CHECK(q36_gpu_tensor_write(windows, 0, observed, window * sizeof(float)));
        CHECK(q36_gpu_tensor_write(out, 0, v, vcount * sizeof(float)));
        CHECK(q36_gpu_extract_recurrent_v_tensor(out, input, tokens));
        CHECK(q36_gpu_tensor_read(out, 0, v, vcount * sizeof(float)));
        for (uint32_t t = 0; t < tokens; t++)
            CHECK(memcmp(v + (size_t)t * values, cur + (size_t)t * conv + 4096u,
                         values * sizeof(float)) == 0);
        CHECK(q36_gpu_recurrent_conv_step_tensor(cache, input, windows, tokens));
        CHECK(q36_gpu_tensor_read(windows, 0, observed, window * sizeof(float)));
        CHECK(memcmp(observed, expected, window * sizeof(float)) == 0);
        CHECK(q36_gpu_tensor_read(cache, 0, state, history * sizeof(float)));
        CHECK(memcmp(state, expected_state, history * sizeof(float)) == 0);
        q36_gpu_tensor *short_window = q36_gpu_tensor_view(windows, 0, (window - 1u) * sizeof(float));
        CHECK(short_window != NULL);
        CHECK(!q36_gpu_recurrent_conv_step_tensor(cache, input, short_window, tokens));
        CHECK(q36_gpu_tensor_read(cache, 0, state, history * sizeof(float)));
        CHECK(memcmp(state, expected_state, history * sizeof(float)) == 0);
        q36_gpu_tensor_free(short_window);
    }
    q36_gpu_tensor_free(out); q36_gpu_tensor_free(windows);
    q36_gpu_tensor_free(cache); q36_gpu_tensor_free(input);
done:
    free(cur); free(state); free(expected_state); free(expected); free(observed); free(v);
    q36_gpu_set_dense_model(false);
}

@interface DStudioQueueGate : NSObject
@property(strong) id<MTLCommandQueue> realQueue;
@property(strong) dispatch_semaphore_t entered;
@property(strong) dispatch_semaphore_t continueGate;
@property unsigned calls;
@end
@implementation DStudioQueueGate
- (id<MTLCommandBuffer>)commandBuffer {
    unsigned call;
    @synchronized(self) { call = ++_calls; }
    if (call == 1) {
        dispatch_semaphore_signal(_entered);
        dispatch_semaphore_wait(_continueGate, DISPATCH_TIME_FOREVER);
    }
    return [_realQueue commandBuffer];
}
@end

static void *prepare_command(void *result) {
    @autoreleasepool { *(int *)result = q36_gpu_begin_commands(); }
    return NULL;
}

static void publication_case(bool replace_queue) {
    CHECK(q36_gpu_synchronize());
    id<MTLCommandQueue> real = q36_queue;
    DStudioQueueGate *gate = [DStudioQueueGate new];
    gate.realQueue = real; gate.entered = dispatch_semaphore_create(0); gate.continueGate = dispatch_semaphore_create(0);
    q36_queue = (id<MTLCommandQueue>)gate;
    pthread_t worker; int result = -1;
    int created = pthread_create(&worker, NULL, prepare_command, &result);
    CHECK(created == 0);
    if (created != 0) { q36_queue = real; return; }
    CHECK(dispatch_semaphore_wait(gate.entered, dispatch_time(DISPATCH_TIME_NOW, 5 * NSEC_PER_SEC)) == 0);
    // At a deterministic blocked allocation, accounting/owner publication must
    // remain available. Never enter a blocking mutex call if the old bug holds it.
    int lock_result = pthread_mutex_trylock(&q36_mu);
    CHECK(lock_result == 0);
    id<MTLCommandBuffer> winner = nil;
    if (lock_result == 0) {
        pthread_mutex_unlock(&q36_mu);
        q36_gpu_tensor *independent = q36_gpu_tensor_alloc(64);
        CHECK(independent != NULL); q36_gpu_tensor_free(independent);
        if (replace_queue) {
            pthread_mutex_lock(&q36_mu); q36_queue = real; pthread_mutex_unlock(&q36_mu);
        } else {
            CHECK(q36_gpu_begin_commands());
            winner = q36_batch;
        }
    }
    dispatch_semaphore_signal(gate.continueGate); pthread_join(worker, NULL);
    CHECK(result == (replace_queue ? 0 : 1));
    CHECK(q36_batch == winner); // stale candidates and racing losers never publish
    q36_queue = real;
    CHECK(q36_gpu_synchronize());
}

int main(void) {
    @autoreleasepool {
        if (!q36_gpu_init()) { fprintf(stderr, "Metal unavailable: NOT RUN\n"); return 2; }
        operator_case(1, 1); operator_case(3, 4); operator_case(16, 33);
        shape_case(false, 1); shape_case(false, 5);
        shape_case(true, 1); shape_case(true, 5);
        publication_case(false); publication_case(true);
        q36_gpu_cleanup();
        printf("{\"checks\":%u,\"failures\":%u,\"maxAbsoluteError\":%.9g,\"tolerance\":1e-5,\"passed\":%s}\n",
               checks, failures, max_error, failures ? "false" : "true");
        return failures ? 1 : 0;
    }
}

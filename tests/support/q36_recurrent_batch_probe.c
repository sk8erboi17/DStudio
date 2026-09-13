/* Exercise the production batch composition with real Metal operations and
 * synthetic weights. The reference uses the same arithmetic but independent
 * Q/K storage: it cannot overwrite a later session's unread QKV projection.
 * This isolates scratch lifetime, not model quality or quantization accuracy. */
#include "q36.c"
#include <assert.h>

enum { WIDTH = 256, MAX_ROWS = 8, MAP_BYTES = 32 * 1024 * 1024 };
static unsigned cases, checks, failures;
static unsigned case_failures;
static double max_error;
#define CHECK(x) do { checks++; if (!(x)) { failures++; case_failures++; } } while (0)

static q36_tensor weight(unsigned char *map, size_t *used, uint32_t in,
                         uint32_t out, bool quantized, float scale, float bias) {
    *used = (*used + 63u) & ~(size_t)63u;
    q36_tensor t = {.type = quantized ? Q36_TENSOR_Q8_0 : Q36_TENSOR_F32,
        .ndim = 2, .dim = {in, out}, .elements = (uint64_t)in * out,
        .abs_offset = *used};
    uint64_t row_bytes;
    assert(tensor_nbytes(t.type, in, &row_bytes));
    t.bytes = row_bytes * out; assert(*used + t.bytes <= MAP_BYTES);
    float *row = malloc(in * sizeof(float)); assert(row);
    for (uint32_t r = 0; r < out; r++) {
        for (uint32_t c = 0; c < in; c++)
            row[c] = bias + scale * (float)((int)((r * 13u + c * 7u) % 97u) - 48);
        unsigned char *dest = map + *used + r * row_bytes;
        if (quantized) q36_quant_q8_0(row, dest, in);
        else memcpy(dest, row, row_bytes);
    }
    free(row); *used += t.bytes; return t;
}

static void fill(q36_gpu_tensor *tensor, unsigned seed) {
    size_t bytes = q36_gpu_tensor_bytes(tensor), n = bytes / sizeof(float);
    float *data = malloc(bytes); assert(data);
    for (size_t i = 0; i < n; i++) data[i] = (float)((int)((i * 17u + seed * 19u) % 251u) - 125) / 1024.0f;
    assert(q36_gpu_tensor_write(tensor, 0, data, bytes)); free(data);
}

static void same(q36_gpu_tensor *a, q36_gpu_tensor *b, size_t bytes) {
    float *x = malloc(bytes), *y = malloc(bytes); assert(x && y);
    CHECK(q36_gpu_tensor_read(a, 0, x, bytes));
    CHECK(q36_gpu_tensor_read(b, 0, y, bytes));
    bool finite = true;
    for (size_t i = 0; i < bytes / sizeof(float); i++) {
        finite &= isfinite(x[i]) && isfinite(y[i]);
        max_error = fmax(max_error, fabs((double)x[i] - y[i]));
    }
    CHECK(finite); CHECK(!memcmp(x, y, bytes)); free(x); free(y);
}

static void run_case(q36_engine *engine, q36_layer_weights *layer,
                     unsigned rows, unsigned cap, unsigned conv_mode) {
    q36_session sessions[2][MAX_ROWS] = {0};
    q36_decode_item items[2][MAX_ROWS] = {0};
    case_failures = 0; cases++;
    for (unsigned variant = 0; variant < 2; variant++) for (unsigned r = 0; r < rows; r++) {
        q36_vulkan_runtime *rt = q36_vulkan_runtime_create(16, cap, false, false, false,
            Q36_KV_CACHE_F16, Q36_KV_CACHE_F16, NULL);
        assert(rt);
        rt->recur_conv_fused = conv_mode == 0 || (conv_mode == 2 && r % 2 == 0);
        sessions[variant][r].engine = engine; sessions[variant][r].runtime = rt;
        items[variant][r].session = &sessions[variant][r];
        fill(rt->recurrent[0].conv, r + 1); fill(rt->recurrent[0].state, r + 23);
        if (variant == 1) {
            /* Reference only: retire views, retain the QKV owner and give each
             * full Q/K panel an independent allocation of the same capacity. */
            size_t bytes = q36_gpu_tensor_bytes(rt->recur_q);
            q36_gpu_tensor_free(rt->recur_q); q36_gpu_tensor_free(rt->recur_k);
            rt->recur_q = q36_gpu_tensor_alloc(bytes); rt->recur_k = q36_gpu_tensor_alloc(bytes);
            assert(rt->recur_q && rt->recur_k);
        }
    }
    for (unsigned step = 0; step < 2; step++) {
        for (unsigned variant = 0; variant < 2; variant++) {
            q36_vulkan_runtime *rt = sessions[variant][0].runtime;
            fill(rt->norm, step + 137);
            CHECK(q36_sessions_recurrent_vulkan(items[variant], rows, layer, 0, rt->norm, rt->next_hidden));
            CHECK(q36_gpu_synchronize());
        }
        q36_vulkan_runtime *got = sessions[0][0].runtime, *want = sessions[1][0].runtime;
        same(got->next_hidden, want->next_hidden, rows * WIDTH * sizeof(float));
        same(got->recur_conv, want->recur_conv, rows * Q36_N_SSM_CONV_DIM * sizeof(float));
        for (unsigned r = 0; r < rows; r++) {
            got = sessions[0][r].runtime; want = sessions[1][r].runtime;
            same(got->recurrent[0].conv, want->recurrent[0].conv, q36_gpu_tensor_bytes(got->recurrent[0].conv));
            same(got->recurrent[0].state, want->recurrent[0].state, q36_gpu_tensor_bytes(got->recurrent[0].state));
        }
    }
    if (case_failures) fprintf(stderr, "FAIL dense=%d rows=%u capacity=%u conv_mode=%u checks_failed=%u\n",
        Q36_MODEL_DENSE, rows, cap, conv_mode, case_failures);
    for (unsigned variant = 0; variant < 2; variant++) for (unsigned r = 0; r < rows; r++)
        q36_vulkan_runtime_free(sessions[variant][r].runtime);
}

int main(void) {
    /* Reserve the non-fused window too; each case selects fused, unfused or
     * mixed per-session convolution without changing the production operator. */
    setenv("Q36_VK_RECURRENT_CONV_DECODE", "0", 1);
    for (unsigned dense = 0; dense < 2; dense++) {
        g_q36_shape = dense ? Q36_SHAPE_27B : Q36_SHAPE_35B_A3B;
        /* Retain the real recurrent widths and alias geometry, but one layer
         * and small synthetic projections keep this a bounded model-free test. */
        g_q36_shape.n_layer = 1; g_q36_shape.n_embd = WIDTH;
        g_q36_shape.n_vocab = WIDTH; g_q36_shape.n_ff_shared = WIDTH;
        assert(q36_gpu_init()); q36_gpu_set_dense_model(dense);
        unsigned char *map = mmap(NULL, MAP_BYTES, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANON, -1, 0);
        assert(map != MAP_FAILED); size_t used = 0;
        q36_tensor qkv = weight(map, &used, WIDTH, Q36_N_SSM_CONV_DIM, true, 0.0009f, 0);
        q36_tensor z = weight(map, &used, WIDTH, Q36_N_SSM_INNER, true, 0.0007f, 0);
        q36_tensor alpha = weight(map, &used, WIDTH, Q36_N_SSM_DT_RANK, false, 0.0004f, 0);
        q36_tensor beta = weight(map, &used, WIDTH, Q36_N_SSM_DT_RANK, false, 0.0003f, 0);
        q36_tensor conv = weight(map, &used, Q36_N_SSM_CONV, Q36_N_SSM_CONV_DIM, false, 0.01f, 0);
        q36_tensor dt = weight(map, &used, Q36_N_SSM_DT_RANK, 1, false, 0.003f, 0);
        q36_tensor a = weight(map, &used, Q36_N_SSM_DT_RANK, 1, false, 0, -1);
        q36_tensor norm = weight(map, &used, Q36_N_SSM_STATE, 1, false, 0, 1);
        q36_tensor output = weight(map, &used, Q36_N_SSM_INNER, WIDTH, false, 0.0001f, 0);
        q36_engine *engine = calloc(1, sizeof(*engine)); assert(engine);
        engine->model.map = map; engine->model.size = MAP_BYTES;
        q36_layer_weights layer = {.attn_qkv = &qkv, .attn_gate = &z, .ssm_alpha = &alpha,
            .ssm_beta = &beta, .ssm_conv1d = &conv, .ssm_dt = &dt, .ssm_a = &a,
            .ssm_norm = &norm, .ssm_out = &output};
        assert(q36_gpu_set_model_map(map, MAP_BYTES));
        for (unsigned cap = 8; cap <= 16; cap += 8)
            for (unsigned rows = 1; rows <= MAX_ROWS; rows++)
                for (unsigned mode = 0; mode < 3; mode++) run_case(engine, &layer, rows, cap, mode);
        assert(q36_gpu_synchronize()); q36_gpu_cleanup();
        munmap(map, MAP_BYTES); free(engine);
    }
    printf("{\"cases\":%u,\"checks\":%u,\"failures\":%u,\"maxAbs\":%.9g,"
           "\"scope\":\"Real Metal recurrent batch vs independent Q/K storage; synthetic weights\"}\n",
           cases, checks, failures, max_error);
    return failures ? 1 : 0;
}

/* Execute the real dense FFN with deliberately mixed GGUF weight formats.
 * The oracle composes independent native linear calls, each preparing its own
 * activation representation. This tests composition, not quantization quality. */
#define Q36_NO_GPU
#include "q36.c"

enum { WIDTH = 256, MAX_TOKENS = 5 };

static uint32_t random_state = 19;
static unsigned random_byte(void) {
    random_state = random_state * 1664525u + 1013904223u;
    return random_state >> 24;
}

static q36_tensor fixture_tensor(uint8_t *map, uint64_t *offset, uint32_t type) {
    uint64_t row_bytes = 0;
    if (!tensor_nbytes(type, WIDTH, &row_bytes)) abort();
    q36_tensor t = {.type = type, .ndim = 2, .elements = WIDTH * WIDTH,
                    .dim = {WIDTH, WIDTH}, .abs_offset = *offset,
                    .bytes = row_bytes * WIDTH};
    for (unsigned row = 0; row < WIDTH; row++) {
        uint8_t *dst = map + *offset + row * row_bytes;
        if (type == Q36_TENSOR_F32 || type == Q36_TENSOR_F16 || type == Q36_TENSOR_Q8_0) {
            float values[WIDTH];
            for (unsigned i = 0; i < WIDTH; i++)
                values[i] = ((int)random_byte() - 128) / 8192.0f;
            if (type == Q36_TENSOR_F32) memcpy(dst, values, sizeof values);
            else if (type == Q36_TENSOR_F16)
                for (unsigned i = 0; i < WIDTH; i++)
                    ((uint16_t *)dst)[i] = q36_f32_to_f16(values[i]);
            else q36_quant_q8_0(values, dst, WIDTH);
        } else {
            for (uint64_t i = 0; i < row_bytes; i++) dst[i] = random_byte();
            if (type == Q36_TENSOR_Q5_K) {
                q36_block_q5_k *b = (void *)dst;
                b->d = q36_f32_to_f16(0.00004f);
                b->dmin = q36_f32_to_f16(0.00003f);
            } else if (type == Q36_TENSOR_Q6_K) {
                q36_block_q6_k *b = (void *)dst;
                b->d = q36_f32_to_f16(0.00001f);
            } else abort();
        }
    }
    *offset += t.bytes;
    return t;
}

int main(void) {
    static const uint32_t types[] = {Q36_TENSOR_F32, Q36_TENSOR_F16,
        Q36_TENSOR_Q5_K, Q36_TENSOR_Q6_K, Q36_TENSOR_Q8_0};
    static const unsigned counts[] = {1, 2, 5};
    unsigned checks = 0, failures = 0;
    g_q36_shape = Q36_SHAPE_27B;
    g_q36_shape.n_embd = WIDTH;
    g_q36_shape.n_ff_shared = WIDTH;
    g_q36_shape.n_ff_exp = WIDTH;
    for (unsigned a = 0; a < sizeof types / sizeof *types; a++) {
        for (unsigned b = 0; b < sizeof types / sizeof *types; b++) {
            uint8_t *map = calloc(3 * WIDTH * WIDTH, sizeof(float));
            if (!map) return 2;
            uint64_t offset = 0;
            q36_tensor gate = fixture_tensor(map, &offset, types[a]);
            q36_tensor up = fixture_tensor(map, &offset, types[b]);
            q36_tensor down = fixture_tensor(map, &offset, Q36_TENSOR_Q6_K);
            q36_engine engine = {.model = {.map = map, .size = offset}, .n_threads = 1};
            q36_layer_weights layer = {.ffn_gate_shexp = &gate,
                .ffn_up_shexp = &up, .ffn_down_shexp = &down};
            float x[MAX_TOKENS * WIDTH], got[MAX_TOKENS * WIDTH];
            float want[MAX_TOKENS * WIDTH], gates[MAX_TOKENS * WIDTH];
            float ups[MAX_TOKENS * WIDTH], mids[MAX_TOKENS * WIDTH];
            float scratch[WIDTH];
            uint8_t packed[MAX_TOKENS * Q36_MAX_Q8_K_BYTES];
            q36_cpu_runtime rt = {.work2 = gates, .work3 = ups, .work4 = mids,
                .work5 = scratch, .batch_ffn_shared_gate = gates,
                .batch_ffn_shared_up = ups, .batch_ffn_shared_mid = mids,
                .batch_xq = packed};
            for (unsigned i = 0; i < MAX_TOKENS * WIDTH; i++)
                x[i] = sinf((float)i * 0.17f) * 0.75f;
            for (unsigned t = 0; t < MAX_TOKENS; t++) {
                float g[WIDTH], u[WIDTH], mid[WIDTH];
                if (!q36_tensor_matvec(&engine, &gate, x + t * WIDTH, g, scratch, WIDTH, WIDTH) ||
                    !q36_tensor_matvec(&engine, &up, x + t * WIDTH, u, scratch, WIDTH, WIDTH)) return 3;
                for (unsigned i = 0; i < WIDTH; i++) mid[i] = q36_siluf(g[i]) * u[i];
                if (!q36_tensor_matvec(&engine, &down, mid, want + t * WIDTH,
                                       scratch, WIDTH, WIDTH)) return 4;
            }
            for (unsigned c = 0; c < sizeof counts / sizeof *counts; c++) {
                unsigned tokens = counts[c];
                memset(packed, 0xa5, sizeof packed);
                memset(got, 0, sizeof got);
                int ok = tokens == 1 ? q36_forward_ffn(&engine, &layer, x, got, &rt) :
                    q36_forward_ffn_batch(&engine, &layer, x, got, tokens, &rt);
                float error = 0.0f;
                for (unsigned i = 0; i < tokens * WIDTH; i++) {
                    if (!isfinite(got[i])) ok = 0;
                    error = fmaxf(error, fabsf(got[i] - want[i]));
                }
                checks++;
                if (!ok || error > 5e-6f) {
                    failures++;
                    fprintf(stderr, "FAIL gate=%s up=%s tokens=%u ok=%d max_abs=%g\n",
                        tensor_type_name(gate.type), tensor_type_name(up.type), tokens, ok, error);
                }
            }
            free(map);
        }
    }
    printf("{\"checks\":%u,\"failures\":%u,\"scope\":\"CPU dense FFN composition, synthetic weights\"}\n",
           checks, failures);
    return failures ? 1 : 0;
}

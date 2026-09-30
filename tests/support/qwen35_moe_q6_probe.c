/* Execute the Qwen3.6 fork's production Metal MoE kernels on synthetic
 * Q6_K/Q8_0 weights and compare them with an independent scalar oracle.
 * The oracle follows ggml's published block layouts; it does not call engine
 * code. No model weights are loaded: this is kernel correctness, not quality. */
#include "ds4_gpu.h"

#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>

#define QK_K 256
#define Q6_BYTES 210u
#define Q8_BYTES 34u

typedef struct {
    uint8_t ql[QK_K / 2];
    uint8_t qh[QK_K / 4];
    int8_t scales[QK_K / 16];
    _Float16 d;
} oracle_q6_k;

typedef struct {
    _Float16 d;
    int8_t qs[32];
} oracle_q8_0;

_Static_assert(sizeof(oracle_q6_k) == Q6_BYTES, "ggml block_q6_K layout");
_Static_assert(sizeof(oracle_q8_0) == Q8_BYTES, "ggml block_q8_0 layout");

static uint64_t rng_state = 0x9e3779b97f4a7c15ull;
static uint32_t rng_u32(void) {
    rng_state ^= rng_state << 13; rng_state ^= rng_state >> 7; rng_state ^= rng_state << 17;
    return (uint32_t)(rng_state >> 11);
}
static float rng_unit(void) { return (float)(rng_u32() & 0xffffff) / (float)0x800000 - 1.0f; }

/* ggml dequantize_row_q6_K: within each 128-value half, quarters 0/1 use the
 * low nibbles of ql[l] and ql[l+32], quarters 2/3 their high nibbles. */
static void oracle_dequant_q6_k(const oracle_q6_k *b, float out[QK_K]) {
    const float d = (float)b->d;
    const uint8_t *ql = b->ql, *qh = b->qh;
    const int8_t *sc = b->scales;
    for (int n = 0; n < QK_K; n += 128) {
        for (int l = 0; l < 32; l++) {
            const int is = l / 16;
            const int q1 = ((ql[l] & 0xF) | (((qh[l] >> 0) & 3) << 4)) - 32;
            const int q2 = ((ql[l + 32] & 0xF) | (((qh[l] >> 2) & 3) << 4)) - 32;
            const int q3 = ((ql[l] >> 4) | (((qh[l] >> 4) & 3) << 4)) - 32;
            const int q4 = ((ql[l + 32] >> 4) | (((qh[l] >> 6) & 3) << 4)) - 32;
            out[n + l + 0] = d * sc[is + 0] * q1;
            out[n + l + 32] = d * sc[is + 2] * q2;
            out[n + l + 64] = d * sc[is + 4] * q3;
            out[n + l + 96] = d * sc[is + 6] * q4;
        }
        ql += 64; qh += 32; sc += 8;
    }
}

static void oracle_dequant_q8_0(const oracle_q8_0 *b, float out[32]) {
    for (int i = 0; i < 32; i++) out[i] = (float)b->d * b->qs[i];
}

static uint64_t row_bytes(int q6, uint32_t width) {
    return q6 ? (uint64_t)(width / QK_K) * Q6_BYTES : (uint64_t)(width / 32u) * Q8_BYTES;
}

static void fill_row(uint8_t *dst, int q6, uint32_t width) {
    if (q6) {
        for (uint32_t b = 0; b < width / QK_K; b++) {
            oracle_q6_k *blk = (oracle_q6_k *)(dst + (uint64_t)b * Q6_BYTES);
            for (size_t i = 0; i < sizeof blk->ql; i++) blk->ql[i] = (uint8_t)rng_u32();
            for (size_t i = 0; i < sizeof blk->qh; i++) blk->qh[i] = (uint8_t)rng_u32();
            for (size_t i = 0; i < sizeof blk->scales; i++) blk->scales[i] = (int8_t)(rng_u32() % 41) - 20;
            blk->d = (_Float16)(0.002f + 0.001f * (float)(rng_u32() % 8));
        }
    } else {
        for (uint32_t b = 0; b < width / 32u; b++) {
            oracle_q8_0 *blk = (oracle_q8_0 *)(dst + (uint64_t)b * Q8_BYTES);
            blk->d = (_Float16)(0.004f + 0.001f * (float)(rng_u32() % 8));
            for (int i = 0; i < 32; i++) blk->qs[i] = (int8_t)(rng_u32() % 255) - 127;
        }
    }
}

static double oracle_dot(const uint8_t *row, int q6, uint32_t width, const float *x) {
    double s = 0.0;
    float w[QK_K];
    if (q6) {
        for (uint32_t b = 0; b < width / QK_K; b++) {
            oracle_dequant_q6_k((const oracle_q6_k *)(row + (uint64_t)b * Q6_BYTES), w);
            for (int i = 0; i < QK_K; i++) s += (double)w[i] * x[b * QK_K + i];
        }
    } else {
        for (uint32_t b = 0; b < width / 32u; b++) {
            oracle_dequant_q8_0((const oracle_q8_0 *)(row + (uint64_t)b * Q8_BYTES), w);
            for (int i = 0; i < 32; i++) s += (double)w[i] * x[b * 32 + i];
        }
    }
    return s;
}

typedef struct { double max_abs, max_rel; uint64_t bad, total; } error_stats;

static void compare(error_stats *e, const float *got, const double *want, uint64_t n) {
    for (uint64_t i = 0; i < n; i++) {
        const double diff = fabs((double)got[i] - want[i]);
        const double rel = diff / (1.0 + fabs(want[i]));
        if (diff > e->max_abs) e->max_abs = diff;
        if (rel > e->max_rel) e->max_rel = rel;
        /* FP32 accumulation of 2048 products: 1e-3 relative is far looser
         * than rounding and far tighter than a wrong nibble (~1e-1). */
        if (rel > 1e-3) e->bad++;
        e->total++;
    }
}

enum { N_EMBD = 2048, N_FF = 512, N_EXPERT = 16, N_USED = 8 };

static int run_case(const char *name, int routed_q6, int shexp_q6, int down_q6, int shdown_q6) {
    const uint64_t g_row = row_bytes(routed_q6, N_EMBD), sg_row = row_bytes(shexp_q6, N_EMBD);
    const uint64_t d_row = row_bytes(down_q6, N_FF), sd_row = row_bytes(shdown_q6, N_FF);
    const uint64_t exp_gate = (uint64_t)N_FF * g_row, exp_down = (uint64_t)N_EMBD * d_row;
    const uint64_t off_gate = 0, off_up = off_gate + N_EXPERT * exp_gate;
    const uint64_t off_sg = off_up + N_EXPERT * exp_gate, off_su = off_sg + N_FF * sg_row;
    const uint64_t off_down = off_su + N_FF * sg_row, off_sd = off_down + N_EXPERT * exp_down;
    const uint64_t used = off_sd + N_EMBD * sd_row, page = 16384;
    const uint64_t map_size = (used + page - 1) / page * page;
    uint8_t *map = mmap(NULL, map_size, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANON, -1, 0);
    if (map == MAP_FAILED) { perror("mmap"); return 2; }
    for (uint64_t r = 0; r < (uint64_t)N_EXPERT * N_FF; r++) {
        fill_row(map + off_gate + r * g_row, routed_q6, N_EMBD);
        fill_row(map + off_up + r * g_row, routed_q6, N_EMBD);
    }
    for (uint64_t r = 0; r < N_FF; r++) {
        fill_row(map + off_sg + r * sg_row, shexp_q6, N_EMBD);
        fill_row(map + off_su + r * sg_row, shexp_q6, N_EMBD);
    }
    for (uint64_t r = 0; r < (uint64_t)N_EXPERT * N_EMBD; r++) fill_row(map + off_down + r * d_row, down_q6, N_FF);
    for (uint64_t r = 0; r < N_EMBD; r++) fill_row(map + off_sd + r * sd_row, shdown_q6, N_FF);
    /* Register the synthetic weights exactly as the engine registers a GGUF. */
    if (!ds4_gpu_set_model_map(map, map_size)) {
        fprintf(stderr, "%s: model map registration failed\n", name); return 2;
    }

    float x[N_EMBD];
    for (int i = 0; i < N_EMBD; i++) x[i] = rng_unit();
    int32_t sel[N_USED] = {3, 0, 15, 7, 9, 1, 12, 5};
    uint32_t n_sel = N_USED;

    ds4_gpu_tensor *tx = ds4_gpu_tensor_alloc(sizeof x);
    ds4_gpu_tensor *tmid = ds4_gpu_tensor_alloc((uint64_t)(N_USED + 1) * N_FF * sizeof(float));
    ds4_gpu_tensor *tpart = ds4_gpu_tensor_alloc((uint64_t)(N_USED + 1) * N_EMBD * sizeof(float));
    ds4_gpu_tensor *tsel = ds4_gpu_tensor_alloc(sizeof sel);
    ds4_gpu_tensor *tnsel = ds4_gpu_tensor_alloc(sizeof n_sel);
    if (!tx || !tmid || !tpart || !tsel || !tnsel ||
        !ds4_gpu_tensor_write(tx, 0, x, sizeof x) ||
        !ds4_gpu_tensor_write(tsel, 0, sel, sizeof sel) ||
        !ds4_gpu_tensor_write(tnsel, 0, &n_sel, sizeof n_sel)) {
        fprintf(stderr, "%s: GPU tensor setup failed\n", name); return 2;
    }
    if (!ds4_gpu_qwen35_moe_gate_up_tensor(tmid, tx, map, map_size, off_gate, off_up, off_sg, off_su,
            exp_gate, exp_gate, routed_q6, routed_q6, shexp_q6, shexp_q6, tsel, tnsel,
            N_EXPERT, N_USED, N_EMBD, N_FF)) {
        fprintf(stderr, "%s: gate/up dispatch failed\n", name); return 2;
    }
    static float mid[(N_USED + 1) * N_FF];
    static double want_mid[(N_USED + 1) * N_FF];
    if (!ds4_gpu_tensor_read(tmid, 0, mid, sizeof mid)) return 2;
    for (int s = 0; s <= N_USED; s++) {
        for (int r = 0; r < N_FF; r++) {
            const int shared = s == N_USED;
            const uint8_t *gr = shared ? map + off_sg + (uint64_t)r * sg_row
                                       : map + off_gate + (uint64_t)sel[s] * exp_gate + (uint64_t)r * g_row;
            const uint8_t *ur = shared ? map + off_su + (uint64_t)r * sg_row
                                       : map + off_up + (uint64_t)sel[s] * exp_gate + (uint64_t)r * g_row;
            const int q6 = shared ? shexp_q6 : routed_q6;
            const double g = oracle_dot(gr, q6, N_EMBD, x), u = oracle_dot(ur, q6, N_EMBD, x);
            want_mid[s * N_FF + r] = g / (1.0 + exp(-g)) * u;
        }
    }
    error_stats gu = {0};
    compare(&gu, mid, want_mid, (uint64_t)(N_USED + 1) * N_FF);

    /* Stage 2 consumes the oracle's stage-1 result, so a stage-1 defect
     * cannot hide or cause a stage-2 verdict. */
    static float mid_in[(N_USED + 1) * N_FF];
    for (int i = 0; i < (N_USED + 1) * N_FF; i++) mid_in[i] = (float)want_mid[i];
    if (!ds4_gpu_tensor_write(tmid, 0, mid_in, sizeof mid_in) ||
        !ds4_gpu_qwen35_moe_down_tensor(tpart, tmid, map, map_size, off_down, off_sd, exp_down,
            down_q6, shdown_q6, tsel, tnsel, N_EXPERT, N_USED, N_FF, N_EMBD)) {
        fprintf(stderr, "%s: down dispatch failed\n", name); return 2;
    }
    static float part[(N_USED + 1) * N_EMBD];
    static double want_part[(N_USED + 1) * N_EMBD];
    if (!ds4_gpu_tensor_read(tpart, 0, part, sizeof part)) return 2;
    for (int s = 0; s <= N_USED; s++) {
        for (int r = 0; r < N_EMBD; r++) {
            const int shared = s == N_USED;
            const uint8_t *dr = shared ? map + off_sd + (uint64_t)r * sd_row
                                       : map + off_down + (uint64_t)sel[s] * exp_down + (uint64_t)r * d_row;
            want_part[s * N_EMBD + r] = oracle_dot(dr, shared ? shdown_q6 : down_q6, N_FF, mid_in + s * N_FF);
        }
    }
    error_stats dn = {0};
    compare(&dn, part, want_part, (uint64_t)(N_USED + 1) * N_EMBD);

    printf("{\"case\":\"%s\",\"routedGateUp\":\"%s\",\"sharedGateUp\":\"%s\",\"routedDown\":\"%s\",\"sharedDown\":\"%s\","
           "\"gateUp\":{\"maxAbs\":%.6g,\"maxRel\":%.6g,\"bad\":%llu,\"total\":%llu},"
           "\"down\":{\"maxAbs\":%.6g,\"maxRel\":%.6g,\"bad\":%llu,\"total\":%llu}}\n",
           name, routed_q6 ? "Q6_K" : "Q8_0", shexp_q6 ? "Q6_K" : "Q8_0",
           down_q6 ? "Q6_K" : "Q8_0", shdown_q6 ? "Q6_K" : "Q8_0",
           gu.max_abs, gu.max_rel, (unsigned long long)gu.bad, (unsigned long long)gu.total,
           dn.max_abs, dn.max_rel, (unsigned long long)dn.bad, (unsigned long long)dn.total);
    ds4_gpu_tensor_free(tx); ds4_gpu_tensor_free(tmid); ds4_gpu_tensor_free(tpart);
    ds4_gpu_tensor_free(tsel); ds4_gpu_tensor_free(tnsel);
    munmap(map, map_size);
    return gu.bad || dn.bad;
}

/* Control: the fork's dense Q6_K matvec must agree with the same oracle.
 * If it did not, a MoE mismatch could be an oracle defect rather than a
 * kernel defect. */
static int run_dense_control(void) {
    enum { IN = N_EMBD, OUT = 256 };
    const uint64_t rb = row_bytes(1, IN), page = 16384;
    const uint64_t map_size = (OUT * rb + page - 1) / page * page;
    uint8_t *map = mmap(NULL, map_size, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANON, -1, 0);
    if (map == MAP_FAILED || !ds4_gpu_set_model_map(map, map_size)) return 2;
    for (int r = 0; r < OUT; r++) fill_row(map + (uint64_t)r * rb, 1, IN);
    float x[IN], got[OUT];
    double want[OUT];
    for (int i = 0; i < IN; i++) x[i] = rng_unit();
    ds4_gpu_tensor *tx = ds4_gpu_tensor_alloc(sizeof x), *tout = ds4_gpu_tensor_alloc(sizeof got);
    if (!tx || !tout || !ds4_gpu_tensor_write(tx, 0, x, sizeof x) ||
        !ds4_gpu_qwen35_matvec_q6_k_tensor(tout, map, map_size, 0, IN, OUT, tx) ||
        !ds4_gpu_tensor_read(tout, 0, got, sizeof got)) return 2;
    for (int r = 0; r < OUT; r++) want[r] = oracle_dot(map + (uint64_t)r * rb, 1, IN, x);
    error_stats e = {0};
    compare(&e, got, want, OUT);
    printf("{\"case\":\"dense-q6-control\",\"matvec\":{\"maxAbs\":%.6g,\"maxRel\":%.6g,\"bad\":%llu,\"total\":%llu}}\n",
           e.max_abs, e.max_rel, (unsigned long long)e.bad, (unsigned long long)e.total);
    ds4_gpu_tensor_free(tx); ds4_gpu_tensor_free(tout);
    munmap(map, map_size);
    return e.bad ? 3 : 0;
}

int main(void) {
    if (!ds4_gpu_init()) { fprintf(stderr, "Metal initialization failed\n"); return 2; }
    int failed = 0, rc;
    /* An oracle that disagrees with the reference kernel invalidates the run. */
    if ((rc = run_dense_control()) != 0) return rc;
    /* The installed UD-Q6_K_XL file: 39 layers with Q6_K routed gate/up and
     * Q8_0 shared/down tensors; one layer is Q8_0 throughout. */
    if ((rc = run_case("ud-q6-layer", 1, 0, 0, 0)) == 2) return 2; failed |= rc;
    if ((rc = run_case("ud-q8-layer", 0, 0, 0, 0)) == 2) return 2; failed |= rc;
    /* Every Q6_K branch the kernels implement, including unused ones. */
    if ((rc = run_case("all-q6", 1, 1, 1, 1)) == 2) return 2; failed |= rc;
    return failed ? 1 : 0;
}

#ifndef Q36_QUANTS_H
#define Q36_QUANTS_H

/*
 * Narrow quantization API used by the Q36 GGUF writer.
 *
 * The enum values intentionally match GGUF/GGML type IDs so template metadata
 * can be copied without translation.  Only the formats used by the Q36
 * quantization recipes are implemented as output targets.
 */

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define Q36Q_MAX_DIMS 4

typedef enum {
    Q36Q_TYPE_F32     = 0,
    Q36Q_TYPE_F16     = 1,
    Q36Q_TYPE_Q4_0    = 2,
    Q36Q_TYPE_Q4_1    = 3,
    Q36Q_TYPE_Q5_0    = 6,
    Q36Q_TYPE_Q5_1    = 7,
    Q36Q_TYPE_Q8_0    = 8,
    Q36Q_TYPE_Q8_1    = 9,
    Q36Q_TYPE_Q2_K    = 10,
    Q36Q_TYPE_Q3_K    = 11,
    Q36Q_TYPE_Q4_K    = 12,
    Q36Q_TYPE_Q5_K    = 13,
    Q36Q_TYPE_Q6_K    = 14,
    Q36Q_TYPE_Q8_K    = 15,
    Q36Q_TYPE_IQ2_XXS = 16,
    Q36Q_TYPE_IQ2_XS  = 17,
    Q36Q_TYPE_IQ3_XXS = 18,
    Q36Q_TYPE_IQ1_S   = 19,
    Q36Q_TYPE_IQ4_NL  = 20,
    Q36Q_TYPE_IQ3_S   = 21,
    Q36Q_TYPE_IQ2_S   = 22,
    Q36Q_TYPE_IQ4_XS  = 23,
    Q36Q_TYPE_I8      = 24,
    Q36Q_TYPE_I16     = 25,
    Q36Q_TYPE_I32     = 26,
    Q36Q_TYPE_I64     = 27,
    Q36Q_TYPE_F64     = 28,
    Q36Q_TYPE_IQ1_M   = 29,
    Q36Q_TYPE_BF16    = 30,
    Q36Q_TYPE_TQ1_0   = 34,
    Q36Q_TYPE_TQ2_0   = 35,
    Q36Q_TYPE_MXFP4   = 39,
    Q36Q_TYPE_NVFP4   = 40,
    Q36Q_TYPE_Q1_0    = 41,
    Q36Q_TYPE_COUNT   = 42,
} q36q_type;

static inline size_t q36q_pad(size_t x, size_t n) {
    return ((x + n - 1) / n) * n;
}

const char *q36q_type_name(q36q_type type);
bool q36q_can_quantize(q36q_type type);
int64_t q36q_block_size(q36q_type type);
size_t q36q_row_size(q36q_type type, int64_t ne);
bool q36q_requires_imatrix(q36q_type type);
void q36q_quantize_init(q36q_type type);
size_t q36q_quantize_chunk(q36q_type type, const float *src, void *dst,
                           int64_t start, int64_t nrows, int64_t ncols,
                           const float *imatrix);

float q36q_f16_to_f32(uint16_t bits);
float q36q_bf16_to_f32(uint16_t bits);
void q36q_f32_to_f16_row(const float *src, uint16_t *dst, int64_t n);
void q36q_f32_to_bf16_row(const float *src, uint16_t *dst, int64_t n);

#endif

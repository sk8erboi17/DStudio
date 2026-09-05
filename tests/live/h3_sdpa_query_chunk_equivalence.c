#include "h3_gpu.h"

#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

enum {
    SEQUENCE = 23,
    HEADS = 4,
    HEAD_DIM = 16,
};

static void fail(const char *message) {
    fprintf(stderr, "FAIL h3_sdpa_query_chunk_equivalence: %s\n", message);
    exit(1);
}

static void require_gpu(h3_gpu *gpu, int condition, const char *operation) {
    if (condition) return;
    fprintf(stderr, "FAIL h3_sdpa_query_chunk_equivalence: %s: %s\n",
            operation, h3_gpu_error(gpu));
    exit(1);
}

static uint16_t f32_to_bf16(float value) {
    uint32_t bits;
    memcpy(&bits, &value, sizeof(bits));
    return (uint16_t)(bits >> 16);
}

static float bf16_to_f32(uint16_t value) {
    uint32_t bits = (uint32_t)value << 16;
    float result;
    memcpy(&result, &bits, sizeof(result));
    return result;
}

static void fill_values(uint16_t *values, size_t count, uint32_t seed,
                        float scale) {
    uint32_t state = seed;
    for (size_t index = 0; index < count; index++) {
        state = state * 1664525u + 1013904223u;
        int32_t centered = (int32_t)((state >> 8) % 2001u) - 1000;
        values[index] = f32_to_bf16((float)centered * scale / 1000.0f);
    }
}

static void run_attention(h3_gpu *gpu, h3_gpu_tensor *output,
                          const h3_gpu_tensor *query,
                          const h3_gpu_tensor *key,
                          const h3_gpu_tensor *value) {
    require_gpu(gpu, h3_gpu_begin(gpu), "begin attention command stream");
    require_gpu(gpu, h3_gpu_sdpa_bf16(
        gpu, output, query, key, value, SEQUENCE, HEADS, HEAD_DIM,
        1.0f / sqrtf((float)HEAD_DIM)), "encode attention");
    require_gpu(gpu, h3_gpu_submit(gpu), "submit attention command stream");
}

int main(int argc, char **argv) {
    if (argc != 2) {
        fprintf(stderr, "usage: %s /path/to/h3_shaders.metal\n", argv[0]);
        return 2;
    }

    char error[512];
    h3_gpu *gpu = h3_gpu_create(argv[1], error, sizeof(error));
    if (!gpu) {
        fprintf(stderr, "FAIL h3_sdpa_query_chunk_equivalence: %s\n", error);
        return 1;
    }

    const size_t elements = (size_t)SEQUENCE * HEADS * HEAD_DIM;
    uint16_t *query_values = malloc(elements * sizeof(*query_values));
    uint16_t *key_values = malloc(elements * sizeof(*key_values));
    uint16_t *value_values = malloc(elements * sizeof(*value_values));
    uint16_t *baseline_values = malloc(elements * sizeof(*baseline_values));
    uint16_t *chunked_values = malloc(elements * sizeof(*chunked_values));
    if (!query_values || !key_values || !value_values || !baseline_values ||
        !chunked_values) fail("host allocation failed");

    fill_values(query_values, elements, 0x13579bdfu, 0.75f);
    fill_values(key_values, elements, 0x2468ace0u, 0.50f);
    fill_values(value_values, elements, 0x10203040u, 1.25f);

    h3_gpu_tensor *query = h3_gpu_tensor_from_bf16(
        gpu, query_values, elements);
    h3_gpu_tensor *key = h3_gpu_tensor_from_bf16(gpu, key_values, elements);
    h3_gpu_tensor *value = h3_gpu_tensor_from_bf16(
        gpu, value_values, elements);
    h3_gpu_tensor *baseline = h3_gpu_tensor_new_bf16(gpu, elements);
    h3_gpu_tensor *chunked = h3_gpu_tensor_new_bf16(gpu, elements);
    if (!query || !key || !value || !baseline || !chunked)
        fail("Metal tensor allocation failed");

    unsetenv("H3_SDPA_QUERY_CHUNK");
    h3_gpu_stats before;
    h3_gpu_stats after;
    require_gpu(gpu, h3_gpu_get_stats(gpu, &before), "read initial stats");
    run_attention(gpu, baseline, query, key, value);
    require_gpu(gpu, h3_gpu_get_stats(gpu, &after), "read baseline stats");
    if (after.mps_sdpa_dispatches - before.mps_sdpa_dispatches != 1)
        fail("baseline did not issue exactly one SDPA dispatch");
    if (!h3_gpu_tensor_read_bf16(baseline, baseline_values, elements))
        fail("cannot read baseline output");

    const unsigned chunks[] = {1, 2, 7, 8, SEQUENCE - 1};
    for (size_t candidate = 0;
         candidate < sizeof(chunks) / sizeof(*chunks); candidate++) {
        char chunk_text[32];
        snprintf(chunk_text, sizeof(chunk_text), "%u", chunks[candidate]);
        if (setenv("H3_SDPA_QUERY_CHUNK", chunk_text, 1) != 0)
            fail("cannot set chunk environment");

        require_gpu(gpu, h3_gpu_get_stats(gpu, &before),
                    "read pre-chunk stats");
        run_attention(gpu, chunked, query, key, value);
        require_gpu(gpu, h3_gpu_get_stats(gpu, &after),
                    "read post-chunk stats");
        const uint64_t expected_dispatches =
            (SEQUENCE + chunks[candidate] - 1u) / chunks[candidate];
        if (after.mps_sdpa_dispatches - before.mps_sdpa_dispatches !=
            expected_dispatches)
            fail("chunked path issued the wrong SDPA dispatch count");
        if (!h3_gpu_tensor_read_bf16(chunked, chunked_values, elements))
            fail("cannot read chunked output");

        size_t mismatches = 0;
        float maximum_absolute = 0.0f;
        for (size_t index = 0; index < elements; index++) {
            if (chunked_values[index] != baseline_values[index]) mismatches++;
            float difference = fabsf(bf16_to_f32(chunked_values[index]) -
                                      bf16_to_f32(baseline_values[index]));
            if (difference > maximum_absolute) maximum_absolute = difference;
        }
        printf("chunk=%u dispatches=%llu mismatches=%zu max_abs=%.9g\n",
               chunks[candidate], (unsigned long long)expected_dispatches,
               mismatches, maximum_absolute);
        if (mismatches != 0 || maximum_absolute != 0.0f)
            fail("query partition changed BF16 attention output");
    }

    unsetenv("H3_SDPA_QUERY_CHUNK");
    h3_gpu_tensor_free(chunked);
    h3_gpu_tensor_free(baseline);
    h3_gpu_tensor_free(value);
    h3_gpu_tensor_free(key);
    h3_gpu_tensor_free(query);
    h3_gpu_free(gpu);
    free(chunked_values);
    free(baseline_values);
    free(value_values);
    free(key_values);
    free(query_values);
    puts("h3_sdpa_query_chunk_equivalence: ok");
    return 0;
}

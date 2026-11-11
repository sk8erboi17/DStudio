/* Calls the patched Laguna engine's prefill-batch resolver, linked from a
 * DS4_TEST_HOOKS build of the patched ds4.c (patch/ds4-laguna-prefill-chunk).
 * Usage: laguna_prefill_chunk_probe metal|cuda REQUESTED
 * DS4_METAL_PREFILL_CHUNK is read from the environment by the engine itself.
 * Prints "chunk=N" (0 = refused) and the engine's refusal text. */
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "ds4.h"

uint32_t ds4_test_laguna_prefill_chunk(int backend, uint32_t requested,
                                       char *err, size_t errlen);

int main(int argc, char **argv) {
    if (argc != 3) return 2;
    int backend;
    if (!strcmp(argv[1], "metal")) backend = DS4_BACKEND_METAL;
    else if (!strcmp(argv[1], "cuda")) backend = DS4_BACKEND_CUDA;
    else return 2;
    char *end = NULL;
    const unsigned long requested = strtoul(argv[2], &end, 10);
    if (end == argv[2] || *end || requested > UINT32_MAX) return 2;
    char err[256] = "";
    const uint32_t chunk = ds4_test_laguna_prefill_chunk(
        backend, (uint32_t)requested, err, sizeof err);
    printf("chunk=%u\nerror=%s\n", (unsigned)chunk, err);
    return 0;
}

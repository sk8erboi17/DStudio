/* Real Metal/encoder regression, no language-model load or server restart.
 * Compile against the selected ds4 source checkout (private engine state is
 * needed to replay its cached vision-map flag after SSD span replacement).
 */
#include "ds4.c"

#define REQUIRE(expr) do { if (!(expr)) { \
    fprintf(stderr, "FAIL line %d: %s\n", __LINE__, #expr); return 1; \
} } while (0)

static uint64_t probe_hash_bytes(const void *data, size_t bytes) {
    const uint8_t *p = data;
    uint64_t hash = UINT64_C(14695981039346656037);
    for (size_t i = 0; i < bytes; i++) hash = (hash ^ p[i]) * UINT64_C(1099511628211);
    return hash;
}

static int install_language_spans(void *map, size_t bytes) {
    static unsigned next_layer;
    const uint64_t shift = (next_layer++ % 2) * (bytes / 4);
    uint64_t offsets[] = {shift, bytes / 2 + shift};
    uint64_t sizes[] = {bytes / 4, bytes / 4};
    return ds4_gpu_set_model_map_spans(map, bytes, offsets, sizes, 2, 1024);
}

static int router_probe(ds4_engine *e, void *map, size_t bytes,
                        int32_t *selection, float *weight_out) {
    enum { ROWS = 2, EXPERTS = 256 };
    float logits[ROWS * EXPERTS];
    int32_t ids[ROWS] = {17, 129281}; /* text then synthetic image ID */
    for (int i = 0; i < ROWS * EXPERTS; i++) logits[i] = (float)((i * 37) % 257) / 128.0f - 1.0f;
    ds4_gpu_tensor *s = ds4_gpu_tensor_alloc(sizeof(int32_t) * ROWS * EXPERTS);
    ds4_gpu_tensor *w = ds4_gpu_tensor_alloc(sizeof(float) * ROWS * EXPERTS);
    ds4_gpu_tensor *p = ds4_gpu_tensor_alloc(sizeof(float) * ROWS * EXPERTS);
    ds4_gpu_tensor *l = ds4_gpu_tensor_alloc(sizeof(logits));
    ds4_gpu_tensor *t = ds4_gpu_tensor_alloc(sizeof(ids));
    int ok = s && w && p && l && t && ds4_gpu_tensor_write(l, 0, logits, sizeof(logits)) &&
        ds4_gpu_tensor_write(t, 0, ids, sizeof(ids)) &&
        ds4_gpu_router_select_batch_visual_tensor(s, w, p, map, bytes, 0, 0, 0, false, false,
            e->vision_model.map, e->vision_model.size, e->deepseek4_vision_weights.visual_router_bias[0],
            l, t, 129280, EXPERTS, 6, 1.5f, ROWS) &&
        ds4_gpu_tensor_read(s, 0, selection, sizeof(int32_t) * ROWS * 6) &&
        ds4_gpu_tensor_read(w, 0, weight_out, sizeof(float) * ROWS * 6);
    ds4_gpu_tensor_free(t); ds4_gpu_tensor_free(l); ds4_gpu_tensor_free(p);
    ds4_gpu_tensor_free(w); ds4_gpu_tensor_free(s);
    return ok;
}

int main(int argc, char **argv) {
    if (argc != 2) { fprintf(stderr, "usage: probe <DeepSeek Vision-Exp encoder.gguf>\n"); return 2; }
    /* Explicitly bounded: only the ~0.93 GB encoder, a tiny synthetic image,
     * and four host pages representing the language model's changing spans. */
    setenv("DS4_METAL_NO_RESIDENCY", "1", 1);
    setenv("DS4_METAL_NO_MODEL_WARMUP", "1", 1);
    ds4_gpu_set_ssd_streaming(true);
    ds4_engine *e = calloc(1, sizeof(*e));
    REQUIRE(e);
    model_open(&e->vision_model, argv[1], true, false);
    REQUIRE(e->vision_model.size < 1024ull * 1024ull * 1024ull);
    deepseek4_vision_weights_bind(&e->deepseek4_vision_weights, &e->vision_model);
    e->vision_kind = DS4_VISION_DEEPSEEK4;
    e->vision_ready = true;
    e->backend = DS4_BACKEND_METAL;
    e->metal_ready = ds4_gpu_init() != 0;
    REQUIRE(e->metal_ready);
    size_t bytes = (size_t)getpagesize() * 4;
    void *map = mmap(NULL, bytes, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANON, -1, 0);
    REQUIRE(map != MAP_FAILED);
    ds4_image image = {.width = 84, .height = 84};
    image.rgb = malloc((size_t)image.width * image.height * 3);
    REQUIRE(image.rgb);
    for (size_t i = 0; i < (size_t)image.width * image.height * 3; i++) image.rgb[i] = (uint8_t)((i * 11) % 251);
    ds4_vision_embedding baseline = {0};
    char error[256] = {0};
    REQUIRE(install_language_spans(map, bytes));
    REQUIRE(ds4_engine_vision_encode_image(e, &image, &baseline, error, sizeof(error)));
    REQUIRE(baseline.token_count > 0 && baseline.data);
    size_t values = (size_t)baseline.token_count * 4096;
    for (size_t i = 0; i < values; i++) REQUIRE(isfinite(baseline.data[i]));
    int32_t selected_ref[12]; float weights_ref[12];
    REQUIRE(router_probe(e, map, bytes, selected_ref, weights_ref));
    for (size_t i = 0; i < 12; i++) {
        REQUIRE(selected_ref[i] >= 0 && selected_ref[i] < 256);
        REQUIRE(isfinite(weights_ref[i]) && weights_ref[i] >= 0.0f);
    }
    /* Compare baseline bytes across the separate unpatched/patched builds,
     * as well as every post-remap result within each process. */
    printf("baseline: %016llx %016llx %016llx\n",
           (unsigned long long)probe_hash_bytes(baseline.data, values * sizeof(float)),
           (unsigned long long)probe_hash_bytes(selected_ref, sizeof(selected_ref)),
           (unsigned long long)probe_hash_bytes(weights_ref, sizeof(weights_ref)));
    int failures = 0;
    for (int round = 0; round < 3; round++) {
        REQUIRE(install_language_spans(map, bytes));
        int32_t selected[12]; float weights[12];
        int routed = router_probe(e, map, bytes, selected, weights);
        if (!routed || memcmp(selected, selected_ref, sizeof(selected)) ||
            memcmp(weights, weights_ref, sizeof(weights))) {
            fprintf(stderr, "FAIL: visual router after SSD span replacement (round %d)\n", round);
            failures++;
        }
        ds4_vision_embedding next = {0};
        int encoded = ds4_engine_vision_encode_image(e, &image, &next, error, sizeof(error));
        if (!encoded || next.token_count != baseline.token_count ||
            memcmp(next.data, baseline.data, values * sizeof(float))) {
            fprintf(stderr, "FAIL: encoder after SSD span replacement (round %d): %s\n", round, error);
            failures++;
        }
        ds4_vision_embedding_free(&next);
    }
    ds4_vision_embedding_free(&baseline);
    ds4_image_free(&image);
    /* GPU work is synchronous and complete; process exit releases the Metal
     * views. Do not unmap their backing memory while those objects are alive. */
    printf("vision_stream_mapping_probe: %s; %d failures; 3 SSD remaps; %s; no LLM loaded\n",
           failures ? "FAIL" : "PASS", failures,
           failures ? "encoder/routing mapping regression reproduced" :
           "encoder + text/image routing byte-identical to pre-remap baseline");
    return failures ? 1 : 0;
}

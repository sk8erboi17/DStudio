/* Execute the real first transformer layer with real weights, SSD and a 128k
 * allocation. This is a numerical layer regression, NOT a full-LLM answer test. */
#include "ds4.c"

int main(int argc, char **argv) {
    if (argc != 6) return 2;
    unsigned count = (unsigned)strtoul(argv[4], NULL, 10);
    if (count < 1 || count > 1024) return 2;
    setenv("DS4_LOCK_FILE", argv[3], 1);
    setenv("DS4_METAL_NO_RESIDENCY", "1", 1);
    setenv("DS4_METAL_NO_MODEL_WARMUP", "1", 1);
    setenv("DS4_METAL_GRAPH_TOKEN_SPLIT_LAYERS", "0", 1);
    setenv("DS4_METAL_LAYER_STAGE_PROFILE", "1", 1);
    setenv("DS4_METAL_LAYER_STAGE_PROFILE_LAYER", "0", 1);
    ds4_engine_options opts = {
        .model_path=argv[1], .vision_path=argv[2], .backend=DS4_BACKEND_METAL,
        .context_size=131072, .prefill_chunk=1024, .n_threads=2,
        .power_percent=100, .ssd_streaming=true, .ssd_streaming_cache_experts=256,
        .load_slice=true, .load_layer_start=0, .load_layer_end=0
    };
    ds4_engine *e = NULL;
    if (ds4_engine_open(&e, &opts)) return 3;
    ds4_session *s = NULL;
    if (ds4_session_create(&s, e, 131072)) return 4;
    const size_t cells = (size_t)count * DS4_N_HC * DS4_N_EMBD;
    int *tokens = calloc(count, sizeof *tokens);
    float *out = malloc(cells * sizeof *out);
    if (!tokens || !out) return 5;
    for (unsigned i = 0; i < count; ++i) tokens[i] = 17 + i % 5;
    for (size_t i = 0; i < cells; ++i) out[i] = NAN;
    char err[512] = {0};
    int selected = metal_graph_stream_prefill_batch_selected_addr_enabled(&s->graph, &e->weights, count);
    fprintf(stderr, "PROBE: real layer=0 context=131072 SSD=on tokens=%u selected=%d\n", count, selected);
    if (selected != (count >= 2 && count <= 760)) return 6;
    int rc = ds4_session_eval_layer_slice(s, tokens, count, 0, 0, 0,
        NULL, out, false, NULL, err, sizeof err);
    if (rc) {
        fprintf(stderr, "LAYER FAIL: %s\n", err);
        return 1;
    }
    double squares = 0;
    for (size_t i = 0; i < cells; ++i) {
        if (!isfinite(out[i])) return 7;
        squares += (double)out[i] * out[i];
    }
    if (!(squares > 0)) return 8;
    FILE *f = fopen(argv[5], "wb");
    if (!f || fwrite(out, sizeof *out, cells, f) != cells || fclose(f)) return 9;
    printf("LAYER PASS: tokens=%u finite_values=%zu squared_norm=%.17g\n", count, cells, squares);
    free(tokens); free(out);
    ds4_session_free(s); ds4_engine_close(e);
    return 0;
}

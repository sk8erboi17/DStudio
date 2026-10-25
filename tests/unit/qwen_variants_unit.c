/* Executes the host's production catalog loader and every consumer of it on
 * real fixture files: recognition, routing, labels, preflight, launch spec and
 * dependencies, MLX/llama.cpp arguments, listing, download details, progress,
 * paused detection and partial cleanup. Model files are empty or sparse; no
 * process, network, engine or weights. */
#define _GNU_SOURCE
#include <assert.h>
#define main dstudio_embedded_main_for_tests
#include "../../src/dstudio.c"
#undef main

#include <ftw.h>

#define CATALOG "scripts/qwen-variants.json"
static char g_tmp[64] = "/tmp/dstudio-qwen-variants.XXXXXX";

static char *slurp(const char *path, size_t *len) {
    FILE *f = fopen(path, "rb");
    assert(f);
    assert(fseek(f, 0, SEEK_END) == 0);
    long n = ftell(f);
    assert(n > 0 && fseek(f, 0, SEEK_SET) == 0);
    char *data = malloc((size_t)n + 1);
    assert(data && fread(data, 1, (size_t)n, f) == (size_t)n && fclose(f) == 0);
    data[n] = '\0';
    if (len) *len = (size_t)n;
    return data;
}

/* A file of exactly `size` bytes, sparse: no disk space for pinned sizes. */
static void fixture(const char *rel, long long size) {
    char path[2048];
    snprintf(path, sizeof path, "%s/ds4/%s", g_tmp, rel);
    for (char *p = path + strlen(g_tmp) + 1; *p; p++) {
        if (*p != '/') continue;
        *p = '\0'; (void)mkdir(path, 0700); *p = '/';
    }
    int fd = open(path, O_CREAT | O_TRUNC | O_WRONLY, 0600);
    assert(fd >= 0 && ftruncate(fd, size) == 0 && close(fd) == 0);
}
static void remove_fixture(const char *rel) {
    char path[2048];
    snprintf(path, sizeof path, "%s/ds4/%s", g_tmp, rel);
    assert(unlink(path) == 0);
}

static int remove_entry(const char *path, const struct stat *st, int flag, struct FTW *ftw) {
    (void)st; (void)flag; (void)ftw;
    return remove(path);
}

/* The handler writes its whole reply before this test reads it. */
static int reply_pair(int pair[2]) {
    if (socketpair(AF_UNIX, SOCK_STREAM, 0, pair) != 0) return -1;
    int size = 1024 * 1024;
    for (int i = 0; i < 2; i++)
        if (setsockopt(pair[i], SOL_SOCKET, SO_SNDBUF, &size, sizeof size) ||
            setsockopt(pair[i], SOL_SOCKET, SO_RCVBUF, &size, sizeof size)) return -1;
    return 0;
}

static void response(int pair[2], char *out, size_t cap) {
    shutdown(pair[0], SHUT_WR);
    size_t used = 0;
    for (ssize_t n; used + 1 < cap && (n = read(pair[1], out + used, cap - 1 - used)) > 0;) used += (size_t)n;
    out[used] = '\0'; close(pair[0]); close(pair[1]);
}

static const char *preflight(int power, int ctx, const char *model, char *err, size_t errsz) {
    engine_cfg cfg = ENGINE_DEFAULTS;
    cfg.power = power; cfg.ctx = ctx; cfg.ssd_streaming = SSD_STREAMING_OFF;
    return native_launch_preflight(&cfg, ENGINE_AGENT, model, 0, 0, err, errsz);
}

/* tests/fixtures/qwen-variants/invalid-edits.json: the same textual edits the
 * Python loader must reject. */
static void invalid_edits_are_rejected(const char *catalog, size_t catalog_len) {
    size_t len = 0;
    char *json = slurp("tests/fixtures/qwen-variants/invalid-edits.json", &len);
    dtg_json_token *t = malloc(8192 * sizeof *t);
    int n = dtg_json_tokenize(json, len, t, 8192), checked = 0;
    assert(t && n > 0);
    int cases = dtg_json_object_field(json, t, n, 0, "cases");
    for (int c = cases + 1; c < n && t[c].start < t[cases].end; c++) {
        if (t[c].parent != cases) continue;
        char name[128], edited_path[128];
        int at = dtg_json_object_field(json, t, n, c, "name");
        assert(dtg_json_token_string(json, &t[at], name, sizeof name));
        int all_at = dtg_json_object_field(json, t, n, c, "all");
        int all = all_at >= 0 && dtg_json_primitive_eq(json, &t[all_at], "true");
        size_t cap = catalog_len * 2 + 4096;
        char *text = malloc(cap), *next = malloc(cap);
        assert(text && next);
        memcpy(text, catalog, catalog_len + 1);
        int edits = dtg_json_object_field(json, t, n, c, "edits");
        for (int e = edits + 1; e < n && t[e].start < t[edits].end; e++) {
            if (t[e].parent != edits) continue;
            char find[512], replace[512];
            assert(dtg_json_token_string(json, &t[dtg_json_array_nth(t, n, e, 0)], find, sizeof find));
            assert(dtg_json_token_string(json, &t[dtg_json_array_nth(t, n, e, 1)], replace, sizeof replace));
            char *from = text, *to = next, *hit = strstr(text, find);
            assert(hit);
            while (hit) {
                memcpy(to, from, (size_t)(hit - from)); to += hit - from;
                memcpy(to, replace, strlen(replace)); to += strlen(replace);
                from = hit + strlen(find);
                hit = all ? strstr(from, find) : NULL;
            }
            strcpy(to, from);
            char *swap = text; text = next; next = swap;
        }
        snprintf(edited_path, sizeof edited_path, "%s/edited.json", g_tmp);
        FILE *f = fopen(edited_path, "wb");
        assert(f && fputs(text, f) >= 0 && fclose(f) == 0);
        if (qwen_catalog_load_file(edited_path)) { fprintf(stderr, "accepted invalid catalog: %s\n", name); assert(0); }
        /* Rejection publishes the compiled original pins, never a partial catalog. */
        assert(!g_qwen_catalog && g_qwen_catalog_error[0]);
        assert(qwen_variant_by_id("qwen36-q6") && qwen_variant_by_id("qwen27-q6") && qwen_variant_by_id("qwen36-mlx"));
        assert(!qwen_variant_by_id("qwen36-q4_k_m"));
        unlink(edited_path); free(text); free(next);
        checked++;
    }
    assert(checked >= 20);
    printf("qwen_variants_unit: %d invalid catalog edits rejected with the original pins kept\n", checked);
    free(t); free(json);
}

int main(int argc, char **argv) {
    (void)argc;
    char err[512];
    assert(mkdtemp(g_tmp));
    assert(getcwd(g_web_dir, sizeof g_web_dir));
    assert(realpath(argv[0], g_launch_executable));

    /* 1. Without a catalog: exactly the compiled original pins. */
    assert(!g_qwen_catalog && qwen_catalog_current()->count == 3);
    assert(model_file_is_supported(MODEL_QWEN35) && model_file_is_supported(MODEL_QWEN27) && model_file_is_mlx(MODEL_QWEN36_MLX));
    assert(!model_file_is_supported("gguf/Qwen3.6-35B-A3B-UD-Q4_K_M.gguf") && !model_file_is_mlx("mlx/Qwen3.8-27B-4bit"));
    int pair[2]; static char out[256 * 1024];
    assert(reply_pair(pair) == 0);
    api_qwen_variants(pair[0]); response(pair, out, sizeof out);
    assert(strstr(out, "200 OK") && strstr(out, "\"fallback\":true") && strstr(out, "\"id\":\"qwen36-q6\"") &&
           strstr(out, "\"id\":\"qwen27-q6\"") && strstr(out, "\"id\":\"qwen36-mlx\"") && !strstr(out, "qwen36-q4_k_m") &&
           strstr(out, "\"requires\":[\"qwen27-mmproj-f16\"]") && strstr(out, "Qwen3.8-27B-mmproj-F16.gguf"));

    /* 2. The shipped catalog: 63 variants, the compiled pins unchanged. */
    size_t catalog_len = 0;
    char *catalog = slurp(CATALOG, &catalog_len);
    assert(qwen_catalog_reload());
    const qwen_catalog *loaded = qwen_catalog_current();
    int counts[3][3] = {{0}};
    for (int i = 0; i < loaded->count; i++) counts[loaded->variants[i].family][loaded->variants[i].engine]++;
    assert(loaded->count == 63 && counts[QWEN_FAMILY_36][QWEN_ENGINE_LLAMA] == 24 && counts[QWEN_FAMILY_36][QWEN_ENGINE_MLX] == 8 &&
           counts[QWEN_FAMILY_27][QWEN_ENGINE_LLAMA] == 25 && counts[QWEN_FAMILY_27][QWEN_ENGINE_MLX] == 6);
    const qwen_catalog *compiled = qwen_compiled_catalog();
    for (int i = 0; i < compiled->count; i++) {
        const qwen_variant *want = &compiled->variants[i], *got = qwen_variant_by_id(want->id);
        assert(got && got != want && !strcmp(got->path, want->path) && got->bytes == want->bytes &&
               got->family == want->family && got->engine == want->engine && !strcmp(got->quant, want->quant) &&
               got->parts == want->parts && got->projector == want->projector);
        for (int f = 0; f < want->parts + want->projector; f++)
            assert(!strcmp(got->files[f].name, want->files[f].name) && got->files[f].bytes == want->files[f].bytes);
    }
    assert(reply_pair(pair) == 0);
    api_qwen_variants(pair[0]); response(pair, out, sizeof out);
    char *body = strstr(out, "\r\n\r\n");
    assert(strstr(out, "200 OK") && body && strlen(body + 4) == catalog_len && !memcmp(body + 4, catalog, catalog_len));

    /* 3. Malformed catalogs are refused as a whole. */
    invalid_edits_are_rejected(catalog, catalog_len);
    char missing[128]; snprintf(missing, sizeof missing, "%s/none.json", g_tmp);
    assert(!qwen_catalog_load_file(missing) && strstr(g_qwen_catalog_error, "none.json"));
    assert(qwen_catalog_reload() && qwen_catalog_current()->count == 63 && !g_qwen_catalog_error[0]);

    /* 4. Recognition: pinned names only, split parts hidden, modified refused. */
    assert(model_file_is_supported("gguf/Qwen3.6-35B-A3B-UD-Q4_K_M.gguf") && model_file_is_resident("gguf/Qwen3.6-35B-A3B-UD-Q4_K_M.gguf"));
    assert(model_file_is_supported("Qwen3.8-27B-UD-IQ2_XXS.gguf") && model_file_is_supported("gguf/Qwen3.6-35B-A3B-Q8_0.gguf"));
    assert(model_file_is_supported("gguf/Qwen3.6-35B-A3B-BF16-00001-of-00002.gguf"));
    assert(!model_file_is_supported("gguf/Qwen3.6-35B-A3B-BF16-00002-of-00002.gguf") &&
           model_file_is_auxiliary("Qwen3.6-35B-A3B-BF16-00002-of-00002.gguf") &&
           !model_file_is_resident("gguf/Qwen3.8-27B-BF16-00002-of-00002.gguf"));
    assert(model_file_is_auxiliary("Qwen3.8-27B-mmproj-F16.gguf") && !model_file_is_supported("Qwen3.8-27B-mmproj-F16.gguf"));
    const char *refused[] = {"Qwen3.8-27B-Q4_K_M.gguf", "gguf/Qwen3.6-35B-A3B-Q4_K_M.gguf", "Qwen3.8-27B-mmproj-BF16.gguf",
        "gguf/Qwen3.6-35B-A3B-abliterated-UD-Q4_K_M.gguf", "gguf/Qwen3.8-27B-Uncensored-UD-Q4_K_M.gguf",
        "mlx/Huihui-Qwen3.6-35B-A3B-abliterated-4.4bit-msq", "mlx/Qwen3.6-35B-A3B-4bit-DWQ", "mlx/Qwen3.8-27B-MTP-4bit",
        "mlx/Qwen3.8-27B-4bit/../Qwen3.8-27B-8bit", "gguf/Qwen3.8-27B-4bit", "mlx/Qwen3.6-35B-A3B-UD-Q4_K_M.gguf", NULL};
    for (int i = 0; refused[i]; i++) {
        if (model_file_is_supported(refused[i]) || model_file_is_resident(refused[i])) { fprintf(stderr, "admitted %s\n", refused[i]); assert(0); }
    }
    assert(model_file_is_mlx("mlx/Qwen3.8-27B-4bit") && model_file_is_mlx("mlx/qwen3.8-27b-4BIT") &&
           model_file_is_supported("mlx/Qwen3.6-35B-A3B-nvfp4") && model_file_is_resident("mlx/Qwen3.8-27B-bf16"));
    assert(!strcmp(resident_model_id("mlx/Qwen3.8-27B-4bit"), "qwen3.8-27b-mlx"));
    assert(!strcmp(resident_model_id("mlx/Qwen3.6-35B-A3B-4bit"), "qwen3.6-35b-a3b-mlx"));
    assert(!strcmp(resident_model_id("gguf/Qwen3.8-27B-BF16-00001-of-00002.gguf"), "qwen3.8-27b"));
    assert(!strcmp(resident_model_id(MODEL_QWEN35), "qwen3.6-35b-a3b") && !strcmp(resident_model_id(MODEL_QWEN36_MLX), "qwen3.6-35b-a3b-mlx"));
    assert(!strcmp(resident_model_label("mlx/Qwen3.8-27B-4bit"), "Qwen3.8-27B 4-bit (MLX)"));
    assert(!strcmp(resident_model_label("mlx/Qwen3.6-35B-A3B-nvfp4"), "Qwen3.6-35B-A3B NVFP4 (MLX)"));
    assert(!strcmp(resident_model_label("gguf/Qwen3.6-35B-A3B-UD-Q4_K_M.gguf"), "Qwen3.6-35B-A3B UD-Q4_K_M"));
    /* Images: the projector exists for 27B GGUF only; MLX 27B is text only. */
    assert(!native_vision_encoder_rel_for_model("mlx/Qwen3.8-27B-4bit"));
    assert(!native_vision_encoder_rel_for_model("gguf/Qwen3.6-35B-A3B-UD-Q4_K_M.gguf"));
    assert(!strcmp(native_vision_encoder_rel_for_model("gguf/Qwen3.8-27B-UD-Q4_K_M.gguf"), MODEL_QWEN27_VISION));
    assert(!strcmp(native_vision_encoder_rel_for_model("gguf/Qwen3.8-27B-BF16-00001-of-00002.gguf"), MODEL_QWEN27_VISION));
    const int modes[] = {ENGINE_SERVER, ENGINE_AGENT, ENGINE_COWORK, ENGINE_DESIGN};
    for (int m = 0; m < 4; m++)
        assert(native_launch_mode_supported(modes[m], "mlx/Qwen3.8-27B-4bit", 0, err, sizeof err) &&
               native_launch_mode_supported(modes[m], "gguf/Qwen3.6-35B-A3B-BF16-00001-of-00002.gguf", 0, err, sizeof err));

    /* 5. Preflight on fixture files: every component, engine and setting. */
    snprintf(g_ds4_dir, sizeof g_ds4_dir, "%s/ds4", g_tmp);
    fixture("ds4.c", 1);
    const char *bf16 = "gguf/Qwen3.6-35B-A3B-BF16-00001-of-00002.gguf";
    fixture(bf16, 49913715424LL);
    const char *code = preflight(100, 65536, bf16, err, sizeof err);
    assert(code && !strcmp(code, "model_component_missing") && strstr(err, "Qwen3.6-35B-A3B-BF16-00002-of-00002.gguf") && strstr(err, "qwen36-bf16"));
    fixture("gguf/Qwen3.6-35B-A3B-BF16-00002-of-00002.gguf", 19462922752LL);
    assert(!preflight(100, 65536, bf16, err, sizeof err));
    assert(!strcmp(preflight(90, 65536, bf16, err, sizeof err), "unsupported_power"));
    assert(!strcmp(preflight(100, 393216, bf16, err, sizeof err), "unsupported_context"));
    const char *q27 = "gguf/Qwen3.8-27B-UD-Q4_K_M.gguf";
    fixture(q27, 16464440224LL);
    code = preflight(100, 65536, q27, err, sizeof err);
    assert(code && !strcmp(code, "model_component_missing") && strstr(err, "projector") && strstr(err, "qwen27-q4_k_m"));
    fixture(MODEL_QWEN27_VISION, 927607488LL);
    assert(!preflight(100, 65536, q27, err, sizeof err));
    const char *mlx27 = "mlx/Qwen3.8-27B-4bit";
    code = preflight(100, 65536, mlx27, err, sizeof err);
#if defined(__APPLE__) && defined(__aarch64__)
    assert(code && !strcmp(code, "model_unavailable"));         /* no folder yet */
    fixture("mlx/Qwen3.8-27B-4bit/config.json", 4932);
    fixture("mlx/Qwen3.8-27B-4bit/model.safetensors.index.json", 218281);
    fixture("mlx/Qwen3.8-27B-4bit/model-00001-of-00003.safetensors", 5343268662LL);
    assert(!preflight(100, 65536, mlx27, err, sizeof err));
    code = preflight(90, 65536, mlx27, err, sizeof err);
    assert(code && !strcmp(code, "unsupported_power") && strstr(err, "MLX"));
#else
    assert(code && !strcmp(code, "unsupported_backend"));
    fixture("mlx/Qwen3.8-27B-4bit/config.json", 4932);
    fixture("mlx/Qwen3.8-27B-4bit/model.safetensors.index.json", 218281);
    fixture("mlx/Qwen3.8-27B-4bit/model-00001-of-00003.safetensors", 5343268662LL);
#endif
    engine_cfg ssd = ENGINE_DEFAULTS; ssd.power = 100; ssd.ctx = 65536; ssd.ssd_streaming = SSD_STREAMING_ON;
    code = native_launch_preflight(&ssd, ENGINE_SERVER, q27, 0, 0, err, sizeof err);
    assert(code && !strcmp(code, "unsupported_memory_mode"));

    /* 6. Launch: resident spec, dependencies and the server arguments. */
    launch_job *job = calloc(1, sizeof *job);
    assert(job);
    job->request.mode = ENGINE_AGENT; job->request.cfg = ENGINE_DEFAULTS; job->request.cfg.ctx = 65536; job->request.cfg.power = 100;
    cstr_copy(job->request.engine_dir, sizeof job->request.engine_dir, g_ds4_dir);
    cstr_copy(job->request.assets_dir, sizeof job->request.assets_dir, g_web_dir);
    cstr_copy(job->request.model, sizeof job->request.model, mlx27);
    assert(launch_resident_init(job) && job->resident->kind == RESIDENT_MLX && !job->resident->vision[0]);
    assert(!strcmp(job->resident->model_id, "qwen3.8-27b-mlx") && strstr(job->resident->install, "/mlx"));
    assert(launch_capture_dependencies(job) && job->dependency_count <= LAUNCH_DEP_MAX);
    int catalog_dep = 0, config_dep = 0;
    for (int i = 0; i < job->dependency_count; i++) {
        catalog_dep |= !strcmp(strrchr(job->dependencies[i].path, '/'), "/qwen-variants.json") && strcmp(job->dependencies[i].identity, "missing");
        config_dep |= strstr(job->dependencies[i].path, "Qwen3.8-27B-4bit/config.json") != NULL;
    }
    assert(catalog_dep && config_dep && !job->resident->vision_identity[0]);
    resident_paths paths = {0}; char *args[40];
    cstr_copy(job->resident->binary_identity, sizeof job->resident->binary_identity, "fixture");
    job->resident->cfg.port = 47000 + (int)(getpid() % 1000);
    assert(resident_prepare(job->resident, &paths, err, sizeof err));
    int count = resident_server_args(job->resident, &paths, args, 0), model_arg = 0;
    assert(count > 0 && !strcmp(args[0], "-m") && !strcmp(args[1], "mlx_lm") && !strcmp(args[2], "server"));
    for (int i = 0; i + 1 < count; i++) {
        assert(strcmp(args[i], "--mmproj"));
        if (!strcmp(args[i], "--model")) model_arg = !strcmp(args[i + 1], paths.model) && strstr(paths.model, "/ds4/mlx/Qwen3.8-27B-4bit");
    }
    assert(model_arg);
    free(job->resident); free(job);
    job = calloc(1, sizeof *job);
    assert(job);
    job->request.mode = ENGINE_COWORK; job->request.cfg = ENGINE_DEFAULTS; job->request.cfg.ctx = 65536; job->request.cfg.power = 100;
    cstr_copy(job->request.engine_dir, sizeof job->request.engine_dir, g_ds4_dir);
    cstr_copy(job->request.assets_dir, sizeof job->request.assets_dir, g_web_dir);
    cstr_copy(job->request.model, sizeof job->request.model, "gguf/Qwen3.8-27B-BF16-00001-of-00002.gguf");
    fixture("gguf/Qwen3.8-27B-BF16-00001-of-00002.gguf", 49986159616LL);
    fixture("gguf/Qwen3.8-27B-BF16-00002-of-00002.gguf", 4671576000LL);
    assert(launch_resident_init(job) && job->resident->kind == RESIDENT_LLAMA && !strcmp(job->resident->vision, MODEL_QWEN27_VISION));
    assert(launch_capture_dependencies(job) && job->dependency_count <= LAUNCH_DEP_MAX);
    int part_dep = 0;
    for (int i = 0; i < job->dependency_count; i++) part_dep |= strstr(job->dependencies[i].path, "BF16-00002-of-00002.gguf") != NULL;
    assert(part_dep && job->resident->vision_identity[0] && strcmp(job->resident->vision_identity, "missing"));
    cstr_copy(job->resident->binary_identity, sizeof job->resident->binary_identity, "fixture");
    job->resident->cfg.port = 48000 + (int)(getpid() % 1000);
    assert(resident_prepare(job->resident, &paths, err, sizeof err));
    count = resident_server_args(job->resident, &paths, args, 0);
    int projector_arg = 0, alias_arg = 0, first_part = 0;
    for (int i = 0; i + 1 < count; i++) {
        projector_arg |= !strcmp(args[i], "--mmproj") && strstr(args[i + 1], "/gguf/Qwen3.8-27B-mmproj-F16.gguf");
        alias_arg |= !strcmp(args[i], "--alias") && !strcmp(args[i + 1], "qwen3.8-27b");
        first_part |= !strcmp(args[i], "--model") && strstr(args[i + 1], "/gguf/Qwen3.8-27B-BF16-00001-of-00002.gguf");
    }
    assert(projector_arg && alias_arg && first_part);
    free(job->resident); free(job);

    /* 7. Listing: pinned files and MLX folders only; parts listed as components. */
    fixture("gguf/Qwen3.6-35B-A3B-UD-Q4_K_M.gguf", 22134528992LL);
    fixture("gguf/Qwen3.8-27B-Q4_K_M.gguf", 16);
    fixture("gguf/Qwen3.6-35B-A3B-abliterated-UD-Q4_K_M.gguf", 16);
    fixture("mlx/Qwen3.6-35B-A3B-4bit-DWQ/config.json", 16);
    fixture("mlx/Qwen3.6-35B-A3B-4bit-DWQ/model.safetensors", 16);
    char *listing = gguf_catalog_build();
    assert(listing && strstr(listing, "\"path\":\"gguf/Qwen3.6-35B-A3B-UD-Q4_K_M.gguf\"") &&
           strstr(listing, "\"file\":\"Qwen3.6-35B-A3B-BF16-00002-of-00002.gguf\"") &&
           strstr(listing, "\"path\":\"mlx/Qwen3.8-27B-4bit\"") && strstr(listing, "\"format\":\"mlx\"") &&
           !strstr(listing, "Qwen3.8-27B-Q4_K_M.gguf") && !strstr(listing, "abliterated") && !strstr(listing, "DWQ"));
    free(listing);
    listing = gguf_catalog_build_known();
    assert(listing && strstr(listing, "\"path\":\"gguf/Qwen3.8-27B-UD-Q4_K_M.gguf\"") &&
           strstr(listing, "\"path\":\"gguf/Qwen3.8-27B-BF16-00002-of-00002.gguf\""));
    const char *first = strstr(listing, "\"path\":\"gguf/Qwen3.8-27B-mmproj-F16.gguf\"");
    assert(first && !strstr(first + 1, "\"path\":\"gguf/Qwen3.8-27B-mmproj-F16.gguf\"")); /* a shared projector, listed once */
    free(listing);

    /* 8. Download details, byte progress and paused detection after a restart. */
    char rel[1024]; long long want = 0;
    model_download_details("qwen27-q4_k_m", rel, sizeof rel, &want);
    assert(!strcmp(rel, "gguf/Qwen3.8-27B-UD-Q4_K_M.gguf") && want == 16464440224LL + 927607488LL);
    model_download_details("qwen36-bf16", rel, sizeof rel, &want);
    assert(!strcmp(rel, bf16) && want == 69376638176LL);
    model_download_details("qwen27-mlx-4bit", rel, sizeof rel, &want);
    assert(!strcmp(rel, mlx27) && want == qwen_variant_by_id("qwen27-mlx-4bit")->bytes);
    model_download_details("qwen36-q6", rel, sizeof rel, &want);
    assert(!strcmp(rel, MODEL_QWEN35) && want == MODEL_QWEN35_BYTES);
    remove_fixture(bf16);
    fixture("gguf/" QWEN_STAGE_DIR "/Qwen3.6-35B-A3B-BF16-00001-of-00002.gguf/data.part", 1000);
    int partial = 0;
    const qwen_variant *split = qwen_variant_by_id("qwen36-bf16");
    assert(qwen_download_bytes(g_ds4_dir, split, &partial) == 1000 + 19462922752LL && partial);
    cstr_copy(g_dl_variant, sizeof g_dl_variant, "qwen36-bf16");
    cstr_copy(g_dl_directory, sizeof g_dl_directory, g_ds4_dir);
    g_dl_qwen = *split; g_dl_qwen_valid = 1;
    model_download_details(g_dl_variant, g_dl_rel, sizeof g_dl_rel, &g_dl_expected_bytes);
    assert(model_download_bytes_present() == 1000 + 19462922752LL && g_dl_expected_bytes == 69376638176LL);
    char target[48]; long long have = 0, expected = 0;
    g_dl_variant[0] = g_dl_rel[0] = g_dl_directory[0] = '\0'; g_dl_qwen_valid = 0; /* an app restart */
    assert(paused_model_download(target, sizeof target, &have, &expected));
    assert(!strcmp(target, "qwen36-bf16") && have == 1000 + 19462922752LL && expected == 69376638176LL);
    assert(reply_pair(pair) == 0);
    api_model_partials_delete(pair[0], "{\"target\":\"qwen36-bf16\",\"confirm\":true}"); response(pair, out, sizeof out);
    assert(strstr(out, "409 Conflict"));
    remove_fixture("gguf/" QWEN_STAGE_DIR "/Qwen3.6-35B-A3B-BF16-00001-of-00002.gguf/data.part");
    /* A projector-only stage belongs to the 27B variant whose model is published. */
    fixture("gguf/" QWEN_STAGE_DIR "/Qwen3.8-27B-mmproj-F16.gguf/data.part", 10);
    remove_fixture(MODEL_QWEN27_VISION);
    remove_fixture("gguf/Qwen3.8-27B-BF16-00001-of-00002.gguf");
    assert(paused_model_download(target, sizeof target, &have, &expected) && !strcmp(target, "qwen27-q4_k_m"));
    assert(have == 16464440224LL + 10 && expected == 16464440224LL + 927607488LL);
    remove_fixture(q27);
    assert(paused_model_download(target, sizeof target, &have, &expected) && !strcmp(target, "qwen27-q6"));
    remove_fixture("gguf/" QWEN_STAGE_DIR "/Qwen3.8-27B-mmproj-F16.gguf/data.part");
    fixture("mlx/Qwen3.8-27B-4bit/" QWEN_STAGE_DIR "/model-00002-of-00003.safetensors/data.part", 50);
    assert(paused_model_download(target, sizeof target, &have, &expected) && !strcmp(target, "qwen27-mlx-4bit"));
    assert(have > 5343268662LL && expected == qwen_variant_by_id("qwen27-mlx-4bit")->bytes);
    assert(reply_pair(pair) == 0);
    api_model_partials_delete(pair[0], "{\"target\":\"qwen27-mlx-4bit\",\"confirm\":true}"); response(pair, out, sizeof out);
    assert(strstr(out, "409 Conflict"));
    assert(reply_pair(pair) == 0);
    api_model_download(pair[0], "{\"target\":\"qwen36-q2_k\"}"); response(pair, out, sizeof out);
    assert(strstr(out, "400 Bad Request") && strstr(out, "unknown model/target"));

    /* 9. A support directory without the file: back to the compiled pins. */
    cstr_copy(g_web_dir, sizeof g_web_dir, g_tmp);
    assert(!qwen_catalog_reload() && qwen_catalog_current()->count == 3);
    assert(!model_file_is_mlx(mlx27) && !model_file_is_supported("gguf/Qwen3.6-35B-A3B-UD-Q4_K_M.gguf"));
    assert(model_file_is_resident(MODEL_QWEN27) && !strcmp(native_vision_encoder_rel_for_model(MODEL_QWEN27), MODEL_QWEN27_VISION));
    free(catalog);
    /* Only the mkdtemp tree this test created (sparse fixtures). */
    assert(!strncmp(g_tmp, "/tmp/dstudio-qwen-variants.", 27) && nftw(g_tmp, remove_entry, 16, FTW_DEPTH | FTW_PHYS) == 0);
    printf("qwen_variants_unit: ok (63 pinned variants; original pins equal the compiled ones; recognition, preflight, "
           "launch, listing, progress and paused detection on fixture files; sizeof(qwen_variant)=%zu)\n", sizeof(qwen_variant));
    return 0;
}

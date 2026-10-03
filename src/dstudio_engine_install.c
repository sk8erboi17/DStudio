/* CLI and optional-Qwen setup use the same bundled-source installer/build helpers as
 * first-run setup. No model loading, listeners or unrelated process shutdown. */
typedef struct {
    const char *id, *name, *url, *commit;
} engine_install_source;

/* One source for installation and the read-only release-admission command.
 * This describes installer pins, never the user's currently running engine. */
static const engine_install_source engine_install_sources[] = {
    {"main", "ds4", DS4_ARCHIVE_URL, DS4_UPSTREAM_COMMIT},
    {"laguna", DS4_LAGUNA_DIR_NAME, DS4_LAGUNA_ARCHIVE_URL, DS4_LAGUNA_UPSTREAM_COMMIT},
    {"llama", LLAMA_DIR_NAME, LLAMA_ARCHIVE_URL, LLAMA_UPSTREAM_COMMIT}
};

static const engine_install_source *setup_engine_source(const char *id) {
    for (size_t i = 0; i < sizeof engine_install_sources / sizeof engine_install_sources[0]; i++)
        if (id && !strcmp(id, engine_install_sources[i].id)) return &engine_install_sources[i];
    return NULL;
}

static int setup_engine_pins_cli(int argc) {
    if (argc != 2) { fprintf(stderr, "usage: DStudio --engine-pins\n"); return 2; }
    printf("{\"schema\":\"dstudio.engine-pins.v1\",\"engines\":[");
    for (size_t i = 0; i < sizeof engine_install_sources / sizeof engine_install_sources[0]; i++) {
        const engine_install_source *s = &engine_install_sources[i];
        /* All fields are compile-time installer constants, not external text. */
        printf("%s{\"id\":\"%s\",\"directory\":\"%s\",\"commit\":\"%s\",\"archiveURL\":\"%s\",\"bundled\":true,\"sourceDirectory\":\"src/engines/%s\"}",
               i ? "," : "", s->id, s->name, s->commit, s->url, s->name);
    }
    printf("]}\n");
    return ferror(stdout) ? 1 : 0;
}

/* The bundled MLX wheels: a source checkout holds them in src/engines/mlx; a
 * release bundle keeps them in Resources/MlxPackages (same layout), outside
 * the support payload copied at every launch. */
static int setup_mlx_assets(char *out, size_t cap) {
    char probe[DSTUDIO_PATH_MAX + 64];
    snprintf(probe, sizeof probe, "%s/src/engines/mlx/manifest.json", g_web_dir);
    if (g_web_dir[0] && access(probe, R_OK) == 0) { cstr_copy(out, cap, g_web_dir); return 1; }
#ifdef __APPLE__
    char exe[DSTUDIO_PATH_MAX]; cstr_copy(exe, sizeof exe, g_launch_executable);
    char *slash = strrchr(exe, '/');
    if (slash) {
        *slash = '\0';
        int n = snprintf(out, cap, "%s/../Resources/MlxPackages", exe);
        snprintf(probe, sizeof probe, "%s/src/engines/mlx/manifest.json", out);
        if (n > 0 && (size_t)n < cap && access(probe, R_OK) == 0) return 1;
    }
#endif
    return 0;
}

/* MLX is a verified offline wheel installation, not a source snapshot: it has
 * no entry in the engine-pin table. Background preparation only. */
static int setup_install_mlx(const char *root, char *target, size_t targetsz, int *downloaded,
                             char *err, size_t errsz) {
#ifndef __APPLE__
    (void)root; (void)target; (void)targetsz; (void)downloaded;
    snprintf(err, errsz, "MLX runs on macOS with Apple Silicon only"); return 0;
#else
    char script[DSTUDIO_PATH_MAX + 64], assets[DSTUDIO_PATH_MAX], output[8192];
    int n = snprintf(target, targetsz, "%s/mlx", root);
    int m = snprintf(script, sizeof script, "%s/scripts/install-mlx.py", g_web_dir);
    if (n < 0 || (size_t)n >= targetsz || m < 0 || (size_t)m >= sizeof script || !g_web_dir[0] ||
        !setup_mlx_assets(assets, sizeof assets)) {
        snprintf(err, errsz, "DStudio's bundled MLX runtime is unavailable"); return 0;
    }
    struct stat before, after;
    int before_rc = lstat(target, &before), absent = before_rc != 0 && errno == ENOENT;
    char *args[] = {"python3", script, "--root", (char *)root, "--assets", assets, NULL};
    int rc = setup_run_cmd_capture(NULL, args, output, sizeof output);
    if (rc) { snprintf(err, errsz, "MLX installation failed (%d): %.7000s", rc, output); return 0; }
    if (lstat(target, &after) || !S_ISDIR(after.st_mode)) { snprintf(err, errsz, "MLX installation disappeared after verification"); return 0; }
    *downloaded = absent || before.st_dev != after.st_dev || before.st_ino != after.st_ino;
    printf("%s", output);
    return 1;
#endif
}

static int setup_install_engine(const char *engine, const char *root,
                                char *target, size_t targetsz, int *downloaded,
                                char *err, size_t errsz) {
    if (engine && !strcmp(engine, "mlx")) return setup_install_mlx(root, target, targetsz, downloaded, err, errsz);
    const engine_install_source *source = setup_engine_source(engine);
    if (!source) { snprintf(err, errsz, "unknown engine: %s", engine ? engine : "(null)"); return 0; }
    struct stat root_st;
    if (!root || strlen(root) >= sizeof g_web_dir ||
        stat(root, &root_st) != 0 || !S_ISDIR(root_st.st_mode)) {
        snprintf(err, errsz, "installation root must be an existing directory with a supported path length"); return 0;
    }
    const char *name = source->name, *commit = source->commit;
    if (!strcmp(engine, "llama")) {
        /* Background preparation only: the helper copies the bundled sources,
         * builds llama-server offline in a private stage and publishes it
         * atomically. Never call this from the native HTTP control loop. */
        char script[DSTUDIO_PATH_MAX + 64], output[8192];
        int n = snprintf(target, targetsz, "%s/%s", root, name);
        int m = snprintf(script, sizeof script, "%s/scripts/install-llama.py", g_web_dir);
        if (n < 0 || (size_t)n >= targetsz || m < 0 || (size_t)m >= sizeof script || !g_web_dir[0]) {
            snprintf(err, errsz, "llama.cpp installer path is unavailable or too long"); return 0;
        }
        struct stat before, after;
        int before_rc = lstat(target, &before), absent = before_rc != 0 && errno == ENOENT;
        if (before_rc && !absent) {
            snprintf(err, errsz, "cannot inspect the existing llama.cpp installation: %s", strerror(errno)); return 0;
        }
        char *args[] = {"python3", script, "--root", (char *)root, "--revision", (char *)commit, NULL};
        int rc = setup_run_cmd_capture(NULL, args, output, sizeof output);
        if (rc) { snprintf(err, errsz, "llama.cpp installation failed (%d): %.7000s", rc, output); return 0; }
        if (lstat(target, &after) || !S_ISDIR(after.st_mode)) {
            snprintf(err, errsz, "llama.cpp installation disappeared after verification"); return 0;
        }
        /* Built means a newly published directory; reuse is verification only. */
        *downloaded = absent || before.st_dev != after.st_dev || before.st_ino != after.st_ino;
        printf("%s", output);
        return 1;
    }
#if !defined(__APPLE__)
    if (strcmp(engine, "main")) {
        snprintf(err, errsz, "this optional engine currently requires macOS Metal"); return 0;
    }
#endif
    int n = snprintf(target, targetsz, "%s/%s", root, name);
    if (n < 0 || (size_t)n >= targetsz) { snprintf(err, errsz, "engine path too long"); return 0; }
    char log_tail[8192] = "";
    *downloaded = 0;
    if (!ds4_dir_valid_path(target)) {
        struct stat st;
        if (lstat(target, &st) == 0) {
            int empty = 0;
            if (!S_ISDIR(st.st_mode) || !setup_dir_empty(target, &empty) || !empty) {
                snprintf(err, errsz, "target contains local data, refusing to replace: %.900s", target); return 0;
            }
        }
        printf("install-engine: copying bundled %s at %s\n", engine, commit);
        if (!setup_install_bundled_sources(engine, commit, target, log_tail, sizeof log_tail, err, errsz)) return 0;
        *downloaded = 1;

    }
    /* Model paths are resolved against the installation root, independently of
     * the patch/assets root. Never relocate or duplicate existing model data. */
    if (strcmp(engine, "main")) {
        char saved[DSTUDIO_PATH_MAX]; cstr_copy(saved, sizeof saved, g_web_dir);
        cstr_copy(g_web_dir, sizeof g_web_dir, root);
        int linked = setup_link_shared_gguf(target, err, errsz);
        cstr_copy(g_web_dir, sizeof g_web_dir, saved);
        if (!linked) return 0;
    } else {
        char models[DSTUDIO_PATH_MAX + 16]; snprintf(models, sizeof models, "%s/gguf", target);
        if (mkdir(models, 0755) != 0 && errno != EEXIST) {
            snprintf(err, errsz, "cannot create model directory: %s", strerror(errno)); return 0;
        }
    }
    printf("install-engine: building %s (no model loaded)\n", engine);
    return setup_build_branch_runtimes(target, engine, log_tail, sizeof log_tail, err, errsz);
}

static int setup_engine_cli(int argc, char **argv) {
    if (argc < 3 || argc > 4) {
        fprintf(stderr, "usage: %s --install-engine main|laguna|llama|mlx [existing-install-root]\n", argv[0]); return 2;
    }
    resolve_web_dir();
    char root[DSTUDIO_PATH_MAX], target[DSTUDIO_PATH_MAX], err[8600] = "";
    if (!realpath(argc == 4 ? argv[3] : ".", root)) {
        fprintf(stderr, "installation root must already exist: %s\n", strerror(errno)); return 2;
    }
    int downloaded = 0;
    int ok = setup_install_engine(argv[2], root, target, sizeof target, &downloaded, err, sizeof err);
    if (!ok) fprintf(stderr, "install-engine: FAILED: %s\n", err);
    else printf("install-engine: OK engine=%s bundled=1 sourcesInstalled=%d path=%s\n", argv[2], downloaded, target);
    return ok ? 0 : 1;
}

static void api_setup_qwen(int fd) {
    /* A stale client must never reinstall the retired checkout. */
    send_json(fd, "410 Gone", "{\"ok\":false,\"engine\":\"main\",\"error\":\"Qwen Next is included in ds4 main. Update DStudio and download the single-file Qwen Next Q2 or Q4 model from Settings > Models.\"}");
}

static void api_setup_qwen35(int fd) {
    /* A stale client must never reinstall the retired vagrillo/ds4 engine. */
    send_json(fd, "410 Gone", "{\"ok\":false,\"engine\":\"llama\",\"error\":\"Qwen3.6 now runs on DStudio's bundled llama.cpp engine, which is built on first use. Choose the model from the model menu; old files are preserved.\"}");
}

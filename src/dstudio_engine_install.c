/* CLI and optional-Qwen setup use the same archive installer/build helpers as
 * first-run setup. No model loading, listeners or unrelated process shutdown. */
typedef struct {
    const char *id, *name, *url, *commit;
} engine_install_source;

/* One source for installation and the read-only release-admission command.
 * This describes installer pins, never the user's currently running engine. */
static const engine_install_source engine_install_sources[] = {
    {"main", "ds4", DS4_ARCHIVE_URL, DS4_UPSTREAM_COMMIT},
    {"laguna", DS4_LAGUNA_DIR_NAME, DS4_LAGUNA_ARCHIVE_URL, DS4_LAGUNA_UPSTREAM_COMMIT},
    {"qwen", DS4_QWEN_DIR_NAME, DS4_QWEN_ARCHIVE_URL, DS4_QWEN_UPSTREAM_COMMIT},
    {"qwen35", DS4_QWEN35_DIR_NAME, DS4_QWEN35_ARCHIVE_URL, DS4_QWEN35_UPSTREAM_COMMIT},
    {"q36", Q36_DIR_NAME, Q36_ARCHIVE_URL, Q36_UPSTREAM_COMMIT}
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
        printf("%s{\"id\":\"%s\",\"directory\":\"%s\",\"commit\":\"%s\",\"archiveURL\":\"%s\"}",
               i ? "," : "", s->id, s->name, s->commit, s->url);
    }
    printf("]}\n");
    return ferror(stdout) ? 1 : 0;
}

static int setup_install_engine(const char *engine, const char *root,
                                char *target, size_t targetsz, int *downloaded,
                                char *err, size_t errsz) {
    const engine_install_source *source = setup_engine_source(engine);
    if (!source) { snprintf(err, errsz, "unknown engine: %s", engine ? engine : "(null)"); return 0; }
    int qwen = !strcmp(engine, "qwen") || !strcmp(engine, "qwen35");
    struct stat root_st;
    if (!root || strlen(root) >= sizeof g_web_dir ||
        stat(root, &root_st) != 0 || !S_ISDIR(root_st.st_mode)) {
        snprintf(err, errsz, "installation root must be an existing directory with a supported path length"); return 0;
    }
    const char *name = source->name, *url = source->url, *commit = source->commit;
    if (!strcmp(engine, "q36")) {
#ifdef _WIN32
        snprintf(err, errsz, "q36 currently requires Apple Silicon Metal or Linux Vulkan"); return 0;
#else
        /* CLI/background preparation only. The helper owns a private bounded
         * candidate and atomically publishes after build/identity checks. Never
         * call this synchronously from the native HTTP control loop. */
        char script[DSTUDIO_PATH_MAX + 64], output[8192];
        int n = snprintf(target, targetsz, "%s/%s", root, name);
        int m = snprintf(script, sizeof script, "%s/scripts/install-q36.py", g_web_dir);
        if (n < 0 || (size_t)n >= targetsz || m < 0 || (size_t)m >= sizeof script || !g_web_dir[0]) {
            snprintf(err, errsz, "q36 installer path is unavailable or too long"); return 0;
        }
        struct stat before;
        int before_rc = lstat(target, &before);
        int absent = before_rc != 0 && errno == ENOENT;
        if (before_rc && !absent) {
            snprintf(err, errsz, "cannot inspect the existing q36 installation: %s", strerror(errno)); return 0;
        }
        char *args[] = {"python3", script, "--root", (char *)root, "--revision", (char *)commit, NULL};
        int rc = setup_run_cmd_capture(NULL, args, output, sizeof output);
        if (rc) { snprintf(err, errsz, "q36 installation failed (%d): %.7000s", rc, output); return 0; }
        /* A standalone CLI install need not bootstrap DeepSeek. In a DStudio
         * installation, use its existing model store without copying weights. */
        char primary[DSTUDIO_PATH_MAX + 16]; struct stat primary_st;
        snprintf(primary, sizeof primary, "%s/ds4", root);
        if (!stat(primary, &primary_st) && S_ISDIR(primary_st.st_mode)) {
            char saved[DSTUDIO_PATH_MAX]; cstr_copy(saved, sizeof saved, g_web_dir);
            cstr_copy(g_web_dir, sizeof g_web_dir, root);
            int linked = setup_link_shared_gguf(target, err, errsz);
            cstr_copy(g_web_dir, sizeof g_web_dir, saved);
            if (!linked) return 0;
        }
        struct stat after;
        if (lstat(target, &after) || !S_ISDIR(after.st_mode)) {
            snprintf(err, errsz, "q36 installation disappeared after verification"); return 0;
        }
        /* A successful upgrade also downloads/builds a candidate. The Python
         * helper publishes a new directory inode atomically; same-inode reuse
         * is verification only, not another download. */
        *downloaded = absent || before.st_dev != after.st_dev || before.st_ino != after.st_ino;
        printf("%s", output);
        return 1;
#endif
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
        printf("install-engine: downloading %s at %s\n", engine, commit);
        if (!setup_download_ds4_archive(url, commit, target, log_tail, sizeof log_tail, err, errsz)) return 0;
        *downloaded = 1;
        char receipt[DSTUDIO_PATH_MAX + 32], data[512];
        snprintf(receipt, sizeof receipt, "%s/.dstudio-source.json", target);
        snprintf(data, sizeof data, "{\"engine\":\"%s\",\"commit\":\"%s\",\"url\":\"%s\"}\n", engine, commit, url);
        if (!jsonl_write_file(receipt, data, strlen(data))) {
            snprintf(err, errsz, "could not write source download receipt"); return 0;
        }
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
    if (qwen) {
        if (!strcmp(engine, "qwen") &&
            !run_ext_script_for_dir("scripts/apply-ds4-qwen38-inspect.sh", "apply", target)) {
            snprintf(err, errsz, "Qwen3.8 PLE inspection patch did not apply; source changes preserved");
            return 0;
        }
        if (!strcmp(engine, "qwen") &&
            !run_ext_script_for_dir("scripts/apply-ds4-qwen38-prepare.sh", "apply", target)) {
            snprintf(err, errsz, "Qwen3.8 candidate-preparation patch did not apply; source changes preserved");
            return 0;
        }
        if (!strcmp(engine, "qwen") &&
            !run_ext_script_for_dir("scripts/apply-ds4-qwen38-snapshot.sh", "apply", target)) {
            snprintf(err, errsz, "Qwen3.8 snapshot-allocation patch did not apply; source changes preserved");
            return 0;
        }
        if (!strcmp(engine, "qwen35") &&
            !run_ext_script_for_dir("scripts/apply-ds4-qwen35-catalog.sh", "apply", target)) {
            snprintf(err, errsz, "Qwen3.6 model-catalog patch did not apply; source changes preserved");
            return 0;
        }
        /* Both forks retain their own inference semantics. Their structured
         * Agent/Cowork patches are built separately in launch preparation. */
        char *args[] = {"make", "-j2", "-C", target, "ds4", "ds4-server", "ds4-agent", NULL};
        int rc = setup_run_cmd_capture(NULL, args, log_tail, sizeof log_tail);
        if (rc) { snprintf(err, errsz, "Qwen native build failed (%d): %.7000s", rc, log_tail); return 0; }
        return 1;
    }
    return setup_build_branch_runtimes(target, engine, log_tail, sizeof log_tail, err, errsz);
}

static int setup_engine_cli(int argc, char **argv) {
    if (argc < 3 || argc > 4) {
        fprintf(stderr, "usage: %s --install-engine main|laguna|qwen|qwen35|q36 [existing-install-root]\n", argv[0]); return 2;
    }
    resolve_web_dir();
    char root[DSTUDIO_PATH_MAX], target[DSTUDIO_PATH_MAX], err[8600] = "";
    if (!realpath(argc == 4 ? argv[3] : ".", root)) {
        fprintf(stderr, "installation root must already exist: %s\n", strerror(errno)); return 2;
    }
    int downloaded = 0;
    int ok = setup_install_engine(argv[2], root, target, sizeof target, &downloaded, err, sizeof err);
    /* The CLI has no interactive owner to block. In the app, this additional
     * build belongs to the existing asynchronous launch preparation worker,
     * not the synchronous optional-engine HTTP installer. */
    if (ok && (!strcmp(argv[2], "qwen") || !strcmp(argv[2], "qwen35"))) {
        cstr_copy(g_ds4_dir, sizeof g_ds4_dir, target);
        ok = run_build_jsonl("build");
        if (!ok)
            snprintf(err, sizeof err, "Qwen Agent/Cowork build failed; existing source and model data preserved%s%s",
                     g_engine_err[0] ? ": " : "", g_engine_err[0] ? g_engine_err : "");
    }
    if (!ok) fprintf(stderr, "install-engine: FAILED: %s\n", err);
    else printf("install-engine: OK engine=%s downloaded=%d path=%s\n", argv[2], downloaded, target);
    return ok ? 0 : 1;
}

static void api_setup_qwen(int fd) {
    resolve_web_dir();
    char target[DSTUDIO_PATH_MAX], err[8600] = ""; int downloaded = 0;
    int ok = setup_install_engine("qwen", g_web_dir, target, sizeof target, &downloaded, err, sizeof err);
    json_dyn_buf b = {0};
    json_dyn_printf(&b, "{\"ok\":%s,\"downloaded\":%s,\"built\":%s,\"capability\":\"chat-agent-cowork\",\"error\":",
                    ok ? "true" : "false", downloaded ? "true" : "false", ok ? "true" : "false");
    json_dyn_put_escaped(&b, err); json_dyn_puts(&b, "}");
    send_json(fd, ok ? "200 OK" : "409 Conflict", b.ptr ? b.ptr : "{\"ok\":false}");
    free(b.ptr);
}

static void api_setup_qwen35(int fd) {
    resolve_web_dir();
    char root[DSTUDIO_PATH_MAX], target[DSTUDIO_PATH_MAX], err[8600] = "";
    int downloaded = 0;
    /* Sources must be siblings of the user's active checkout, not hidden in
     * Application Support while its GGUF store lives in a source workspace. */
    if (!realpath(g_ds4_dir, root)) cstr_copy(root, sizeof root, g_web_dir);
    else {
        char *slash = strrchr(root, '/');
        if (slash && slash != root) *slash = '\0';
        else cstr_copy(root, sizeof root, g_web_dir);
    }
    int ok = setup_install_engine("qwen35", root, target, sizeof target, &downloaded, err, sizeof err);
    json_dyn_buf b = {0};
    json_dyn_printf(&b, "{\"ok\":%s,\"downloaded\":%s,\"built\":%s,\"capability\":\"chat-agent-cowork\",\"error\":",
                    ok ? "true" : "false", downloaded ? "true" : "false", ok ? "true" : "false");
    json_dyn_put_escaped(&b, err); json_dyn_puts(&b, "}");
    send_json(fd, ok ? "200 OK" : "409 Conflict", b.ptr ? b.ptr : "{\"ok\":false}");
    free(b.ptr);
}

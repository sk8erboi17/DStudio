/* CLI and optional-Qwen setup use the same archive installer/build helpers as
 * first-run setup. No model loading, listeners or unrelated process shutdown. */
static int setup_install_engine(const char *engine, const char *root,
                                char *target, size_t targetsz, int *downloaded,
                                char *err, size_t errsz) {
    const char *name, *url, *commit;
    int qwen = !strcmp(engine, "qwen");
    struct stat root_st;
    if (!root || strlen(root) >= sizeof g_web_dir ||
        stat(root, &root_st) != 0 || !S_ISDIR(root_st.st_mode)) {
        snprintf(err, errsz, "installation root must be an existing directory with a supported path length"); return 0;
    }
    if (!strcmp(engine, "main")) {
        name = "ds4"; url = DS4_ARCHIVE_URL; commit = DS4_UPSTREAM_COMMIT;
    } else if (!strcmp(engine, "laguna")) {
        name = DS4_LAGUNA_DIR_NAME; url = DS4_LAGUNA_ARCHIVE_URL; commit = DS4_LAGUNA_UPSTREAM_COMMIT;
    } else if (qwen) {
        name = DS4_QWEN_DIR_NAME; url = DS4_QWEN_ARCHIVE_URL; commit = DS4_QWEN_UPSTREAM_COMMIT;
    } else { snprintf(err, errsz, "unknown engine: %s", engine); return 0; }
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
        /* Qwen's native tool syntax is not yet ported to DStudio's structured
         * Agent/Cowork/Design patch. Offer Chat/native inference, not a false
         * claim that the DeepSeek tool parser works for this architecture. */
        char *args[] = {"make", "-j2", "-C", target, "ds4", "ds4-server", "ds4-agent", NULL};
        int rc = setup_run_cmd_capture(NULL, args, log_tail, sizeof log_tail);
        if (rc) { snprintf(err, errsz, "Qwen native build failed (%d): %.7000s", rc, log_tail); return 0; }
        return 1;
    }
    return setup_build_branch_runtimes(target, engine, log_tail, sizeof log_tail, err, errsz);
}

static int setup_engine_cli(int argc, char **argv) {
    if (argc < 3 || argc > 4) {
        fprintf(stderr, "usage: %s --install-engine main|laguna|qwen [existing-install-root]\n", argv[0]); return 2;
    }
    resolve_web_dir();
    char root[DSTUDIO_PATH_MAX], target[DSTUDIO_PATH_MAX], err[8600] = "";
    if (!realpath(argc == 4 ? argv[3] : ".", root)) {
        fprintf(stderr, "installation root must already exist: %s\n", strerror(errno)); return 2;
    }
    int downloaded = 0;
    int ok = setup_install_engine(argv[2], root, target, sizeof target, &downloaded, err, sizeof err);
    if (!ok) fprintf(stderr, "install-engine: FAILED: %s\n", err);
    else printf("install-engine: OK engine=%s downloaded=%d path=%s\n", argv[2], downloaded, target);
    return ok ? 0 : 1;
}

static void api_setup_qwen(int fd) {
    resolve_web_dir();
    char target[DSTUDIO_PATH_MAX], err[8600] = ""; int downloaded = 0;
    int ok = setup_install_engine("qwen", g_web_dir, target, sizeof target, &downloaded, err, sizeof err);
    json_dyn_buf b = {0};
    json_dyn_printf(&b, "{\"ok\":%s,\"downloaded\":%s,\"built\":%s,\"capability\":\"chat-native\",\"error\":",
                    ok ? "true" : "false", downloaded ? "true" : "false", ok ? "true" : "false");
    json_dyn_put_escaped(&b, err); json_dyn_puts(&b, "}");
    send_json(fd, ok ? "200 OK" : "409 Conflict", b.ptr ? b.ptr : "{\"ok\":false}");
    free(b.ptr);
}

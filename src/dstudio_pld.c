/* Derived Chat runtime: patch a temporary translation unit, never the original
 * server/core source, objects or binary. Uses the same adapter as Agent/Cowork.
 * Return 1 built/current, -1 unsupported ABI (use native), 0 actual failure. */
static int run_build_server_pld_locked(void) {
#ifdef _WIN32
    return -1;
#else
    char root[DSTUDIO_PATH_MAX];
    if (!realpath(g_ds4_dir, root)) return 0;
    char source[DSTUDIO_PATH_MAX + 80], core[DSTUDIO_PATH_MAX + 80];
    char header[DSTUDIO_PATH_MAX + 80], bin[DSTUDIO_PATH_MAX + 80];
    char sentinel[DSTUDIO_PATH_MAX + 80], makefile[DSTUDIO_PATH_MAX + 80];
    char native[DSTUDIO_PATH_MAX + 80];
    snprintf(source, sizeof source, "%s/ds4_server.c", root);
    snprintf(core, sizeof core, "%s/ds4.c", root);
    snprintf(header, sizeof header, "%s/ds4.h", root);
    snprintf(bin, sizeof bin, "%s/ds4-server-pld", root);
    snprintf(sentinel, sizeof sentinel, "%s/.ds4ui-server-pld-version", root);
    snprintf(makefile, sizeof makefile, "%s/Makefile", root);
    snprintf(native, sizeof native, "%s/ds4-server", root);

    size_t hdr_size = 0, impl_size = 0;
    char *hdr = unified_read(header, &hdr_size);
    char *impl = unified_read(core, &impl_size);
    if (!hdr || !impl) { free(hdr); free(impl); return 0; }
    int supported = strstr(hdr, "dspark_exact_sampling") != NULL &&
                    strstr(impl, "\nvoid ds4_session_gpu_warmup") != NULL;
    free(hdr); free(impl);
    if (!supported) return -1;

    if (!run_ext_script("scripts/apply-ds4-glm53-m2max.sh", "apply") ||
        !run_ext_script("scripts/apply-ds4-vision-streaming.sh", "apply")) return 0;

    const char *patch_dir = "patch/ds4-server-pld";
    ds4ui_patch_set patch;
    if (!patch_load_set(patch_dir, &patch)) return 0;
    int version = patch.version;
    struct stat bs, dep;
    const char *inputs[] = {source, core, header, makefile, native};
    int fresh = version > 0 && access(bin, X_OK) == 0 && stat(bin, &bs) == 0;
    for (size_t i = 0; fresh && i < sizeof inputs / sizeof inputs[0]; i++)
        fresh = stat(inputs[i], &dep) == 0 && bs.st_mtime >= dep.st_mtime;
    if (fresh && !engine_metal_source_newer_than(root, &bs) &&
        !patch_dir_newer_than(patch_dir, bs.st_mtime) &&
        !patch_dir_newer_than(JSONL_PATCH_DIR, bs.st_mtime) &&
        jsonl_sentinel_ok(sentinel, version)) {
        patch_free_set(&patch);
        return 1;
    }

    /* A failed linker can leave a new executable behind. Never let the old
     * success stamp qualify that partial output on the next launch. */
    jsonl_unlink_if_exists(sentinel);

    char stage[DSTUDIO_PATH_MAX + 64];
    snprintf(stage, sizeof stage, "%s/.ds4ui-server-build-XXXXXX", root);
    if (!mkdtemp(stage)) {
        patch_free_set(&patch);
        return patch_fail("cannot create private Chat PLD build directory");
    }
    int stage_fd = jsonl_open_stage(stage);
    if (stage_fd < 0) { patch_free_set(&patch); return 0; }
    const char *leaf = strrchr(stage, '/') + 1;
    char temp[DSTUDIO_PATH_MAX + 96], prepared[DSTUDIO_PATH_MAX + 96], target[128];
    snprintf(temp, sizeof temp, "%s/ds4_server.c", stage);
    snprintf(prepared, sizeof prepared, "%s/ds4-server-pld", stage);
    snprintf(target, sizeof target, "%s/ds4-server-pld", leaf);
    size_t original_size = 0;
    char *original = unified_read(source, &original_size);
    size_t len = original_size;
    char *src = original ? ds4_strdup_local(original) : NULL;
    int ok = src != NULL;
    if (ok) {
        jsonl_normalize_newlines(src, &len);
        ok = patch_apply_unified(&patch, &src, &len, "ds4_server.c");
    }
    patch_free_set(&patch);
    if (ok) ok = jsonl_write_file(temp, src, len);
    free(src);
    if (ok) ok = jsonl_make(root, target, leaf);
    if (ok && !unified_source_unchanged(source, original, original_size))
        ok = patch_fail("Chat server source changed during build; prepared runtime discarded");
    free(original);
    if (ok && !jsonl_stage_matches(stage, stage_fd))
        ok = patch_fail("private Chat build directory changed; prepared runtime discarded");
    struct stat built;
    if (ok && (lstat(prepared, &built) || !S_ISREG(built.st_mode) ||
               !built.st_size || access(prepared, X_OK)))
        ok = patch_fail("Chat build did not produce an executable runtime file");
    /* One same-filesystem rename publishes only a complete, revalidated file.
     * Failed/killed compilers cannot replace the previous executable. A killed
     * build may leave its private directory; its absent stamp forces a rebuild. */
    if (ok && rename(prepared, bin))
        ok = patch_fail("cannot publish completed Chat PLD build");
    jsonl_clean_stage(stage, stage_fd);
    if (ok) {
        char stamp[32];
        int n = snprintf(stamp, sizeof stamp, "%d\n", version);
        ok = jsonl_write_file(sentinel, stamp, (size_t)n);
    }
    return ok;
#endif
}

static int run_build_server_pld(void) {
    /* Unsupported Qwen is a read-only no-op, not a build admission. Do not
     * create a lock file in a checkout that this adapter must never modify. */
    if (model_is_qwen()) return -1;
#ifdef _WIN32
    return -1;
#else
    char root[DSTUDIO_PATH_MAX];
    if (!realpath(g_ds4_dir, root)) return 0;
    int lock = jsonl_build_lock(root);
    if (lock < 0) return 0;
    int ok = run_build_server_pld_locked();
    close(lock);
    return ok;
#endif
}

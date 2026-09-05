/* Derived Chat runtime: patch a temporary translation unit, never the original
 * server/core source, objects or binary. Uses the same adapter as Agent/Cowork.
 * Return 1 built/current, -1 unsupported ABI (use native), 0 actual failure. */
static int run_build_server_pld(void) {
    if (model_is_qwen()) return -1; /* No unvalidated DeepSeek PLD adapter on Qwen. */
#ifdef _WIN32
    return -1;
#else
    char root[DSTUDIO_PATH_MAX];
    if (!realpath(g_ds4_dir, root)) return 0;
    char source[DSTUDIO_PATH_MAX + 80], core[DSTUDIO_PATH_MAX + 80];
    char header[DSTUDIO_PATH_MAX + 80], bin[DSTUDIO_PATH_MAX + 80];
    char temp[DSTUDIO_PATH_MAX + 80], obj[DSTUDIO_PATH_MAX + 80];
    char sentinel[DSTUDIO_PATH_MAX + 80], makefile[DSTUDIO_PATH_MAX + 80];
    char native[DSTUDIO_PATH_MAX + 80];
    snprintf(source, sizeof source, "%s/ds4_server.c", root);
    snprintf(core, sizeof core, "%s/ds4.c", root);
    snprintf(header, sizeof header, "%s/ds4.h", root);
    snprintf(bin, sizeof bin, "%s/ds4-server-pld", root);
    snprintf(temp, sizeof temp, "%s/ds4_server_pld.c", root);
    snprintf(obj, sizeof obj, "%s/ds4_server_pld.o", root);
    snprintf(sentinel, sizeof sentinel, "%s/.ds4ui-server-pld-version", root);
    snprintf(makefile, sizeof makefile, "%s/Makefile", root);
    snprintf(native, sizeof native, "%s/ds4-server", root);

    char *hdr = jsonl_read_file(header, NULL);
    char *impl = jsonl_read_file(core, NULL);
    if (!hdr || !impl) { free(hdr); free(impl); return 0; }
    int supported = strstr(hdr, "dspark_exact_sampling") != NULL &&
                    strstr(impl, "\nvoid ds4_session_gpu_warmup") != NULL;
    free(hdr); free(impl);
    if (!supported) return -1;

    if (!run_ext_script("scripts/apply-ds4-glm53-m2max.sh", "apply")) return 0;

    const char *patch_dir = "patch/ds4-server-pld";
    ds4ui_patch_set patch;
    if (!patch_load_set(patch_dir, &patch)) return 0;
    int version = patch.version;
    struct stat bs, dep;
    const char *inputs[] = {source, core, header, makefile, native};
    int fresh = version > 0 && access(bin, X_OK) == 0 && stat(bin, &bs) == 0;
    for (size_t i = 0; fresh && i < sizeof inputs / sizeof inputs[0]; i++)
        fresh = stat(inputs[i], &dep) == 0 && bs.st_mtime >= dep.st_mtime;
    if (fresh && !patch_dir_newer_than(patch_dir, bs.st_mtime) &&
        !patch_dir_newer_than(JSONL_PATCH_DIR, bs.st_mtime) &&
        jsonl_sentinel_ok(sentinel, version)) {
        patch_free_set(&patch);
        return 1;
    }

    /* A failed linker can leave a new executable behind. Never let the old
     * success stamp qualify that partial output on the next launch. */
    jsonl_unlink_if_exists(sentinel);

    size_t len = 0;
    char *src = jsonl_read_file(source, &len);
    int ok = src != NULL;
    if (ok) {
        jsonl_normalize_newlines(src, &len);
        ok = patch_apply_edits(&patch, &src, &len, source);
    }
    patch_free_set(&patch);
    if (ok) ok = jsonl_write_file(temp, src, len);
    free(src);
    if (ok) ok = jsonl_make(root, "ds4-server-pld");
    jsonl_unlink_if_exists(temp);
    jsonl_unlink_if_exists(obj);
    if (ok) {
        char stamp[32];
        int n = snprintf(stamp, sizeof stamp, "%d\n", version);
        ok = jsonl_write_file(sentinel, stamp, (size_t)n);
    }
    return ok;
#endif
}

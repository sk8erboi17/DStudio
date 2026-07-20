/* ---- Optional GLM 5.2 engine checkout (ds4 branch glm5.2) ---- */

static int glm_dir_path(char *out, size_t outsz) {
    if (!g_web_dir[0]) return 0;
    int n = snprintf(out, outsz, "%s/%s", g_web_dir, DS4_GLM_DIR_NAME);
    return n > 0 && (size_t)n < outsz;
}

/* True when the local Metal model-view fix from patch/ds4-glm52/ is present in
 * the checkout (the patch adds a DS4_GLM_PATCH_MARK marker comment). */
static int glm_patch_applied(const char *dir) {
    char src[DSTUDIO_PATH_MAX + 32];
    snprintf(src, sizeof src, "%s/ds4_metal.m", dir);
    size_t n = 0;
    char *body = jsonl_read_file(src, &n);
    if (!body) return 0;
    int found = strstr(body, DS4_GLM_PATCH_MARK) != NULL;
    free(body);
    return found;
}

/* Fully usable: looks like a ds4 checkout, server binary built, patch applied. */
static int glm_checkout_ready(const char *dir) {
    return ds4_dir_valid_path(dir) &&
           (file_present_in_dir(dir, "ds4-server") || file_present_in_dir(dir, "ds4-server.exe")) &&
           glm_patch_applied(dir);
}

static void glm_send_json(int fd, const char *status, int ok, unsigned long long task_id,
                          const char *dir, int downloaded, int patched, int built,
                          const char *error) {
    if (task_id) {
        if (ok) task_mark_completed(task_id, "GLM engine setup completed");
        else task_mark_failed(task_id, error && error[0] ? error : "GLM engine setup failed",
                              dir ? dir : "");
    }
    json_dyn_buf b = {0};
    int good = json_dyn_puts(&b, "{\"ok\":") &&
               json_dyn_puts(&b, ok ? "true" : "false") &&
               json_dyn_printf(&b, ",\"taskId\":%llu", task_id) &&
               json_dyn_puts(&b, ",\"commit\":") &&
               json_dyn_put_escaped(&b, DS4_GLM_UPSTREAM_COMMIT) &&
               json_dyn_puts(&b, ",\"dir\":") &&
               json_dyn_put_escaped(&b, dir ? dir : "") &&
               json_dyn_printf(&b, ",\"downloaded\":%s,\"patched\":%s,\"built\":%s",
                               downloaded ? "true" : "false",
                               patched ? "true" : "false",
                               built ? "true" : "false") &&
               json_dyn_puts(&b, ",\"error\":") &&
               json_dyn_put_escaped(&b, error ? error : "") &&
               json_dyn_puts(&b, "}");
    if (!good) {
        free(b.ptr);
        send_json(fd, "500 Internal Server Error", "{\"ok\":false,\"error\":\"out of memory\"}");
        return;
    }
    send_json(fd, status, b.ptr);
    free(b.ptr);
}

/* POST /api/glm/setup — optional second engine: downloads antirez/ds4 at the
 * pinned glm5.2 commit into ./ds4-glm52 (curl + tar, no git), applies the local
 * Metal model-view fix from patch/ds4-glm52/ (the fix is never vendored into
 * the checkout sources in git — it is re-applied on every fresh install), and
 * builds. The running engine is left alone: swapping to the GLM checkout
 * happens from the model menu's Engine-branch section. */
static void api_setup_glm(int fd) {
#ifdef _WIN32
    send_json(fd, "409 Conflict",
              "{\"ok\":false,\"error\":\"the GLM engine checkout is not supported on the Windows portable build yet\"}");
#else
    resolve_web_dir();
    if (!web_dir_valid()) {
        glm_send_json(fd, "409 Conflict", 0, 0, "", 0, 0, 0,
                      "DStudio checkout not found; cannot locate patch/ds4-glm52");
        return;
    }
    char target[DSTUDIO_PATH_MAX];
    if (!glm_dir_path(target, sizeof target)) {
        glm_send_json(fd, "500 Internal Server Error", 0, 0, "", 0, 0, 0,
                      "GLM checkout path is too long");
        return;
    }
    unsigned long long task_id = task_begin("setup", "Install GLM engine", "glm",
                                            g_mode, target, 0, 1);
    task_mark_working(task_id, "preparing the GLM engine checkout");

    char log_tail[8192] = "";
    int downloaded = 0;
    struct stat st;
    int exists = stat(target, &st) == 0;
    if (exists && !S_ISDIR(st.st_mode)) {
        glm_send_json(fd, "409 Conflict", 0, task_id, target, 0, 0, 0,
                      "DStudio/ds4-glm52 exists but is not a folder");
        return;
    }
    if (!exists || !ds4_dir_valid_path(target)) {
        int can_download = !exists;
        if (exists) {
            int empty = 0;
            if (!setup_dir_empty(target, &empty)) {
                glm_send_json(fd, "409 Conflict", 0, task_id, target, 0, 0, 0,
                              "DStudio/ds4-glm52 exists but could not be inspected");
                return;
            }
            can_download = empty;
        }
        if (!can_download) {
            glm_send_json(fd, "409 Conflict", 0, task_id, target, 0, 0, 0,
                          "DStudio/ds4-glm52 exists but is not a ds4 checkout; remove it and run setup again");
            return;
        }
        char err[8600];
        if (!setup_download_ds4_archive(DS4_GLM_ARCHIVE_URL, DS4_GLM_UPSTREAM_COMMIT, target,
                                        log_tail, sizeof log_tail, err, sizeof err)) {
            glm_send_json(fd, "500 Internal Server Error", 0, task_id, target, 0, 0, 0, err);
            return;
        }
        downloaded = 1;
    }

    int patched = glm_patch_applied(target);
    if (!patched) {
        char patch_file[DSTUDIO_PATH_MAX + 64];
        snprintf(patch_file, sizeof patch_file, "%s/%s", g_web_dir, DS4_GLM_METAL_PATCH);
        char *patch_argv[] = { "patch", "-p1", "-N", "-d", target, "-i", patch_file, NULL };
        int rc = setup_run_cmd_capture(NULL, patch_argv, log_tail, sizeof log_tail);
        if (rc != 0 || !glm_patch_applied(target)) {
            char err[8600];
            snprintf(err, sizeof err,
                     "GLM metal patch failed (exit %d). DStudio setup needs curl, tar and patch. Output: %.7700s",
                     rc, log_tail[0] ? log_tail : "(no output)");
            glm_send_json(fd, "500 Internal Server Error", 0, task_id, target, downloaded, 0, 0, err);
            return;
        }
        patched = 1;
    }

    task_mark_working(task_id, "building the GLM engine (make)");
    char *make_argv[] = { "make", "-C", target, NULL };
    int rc = setup_run_cmd_capture(NULL, make_argv, log_tail, sizeof log_tail);
    if (rc != 0) {
        char err[8600];
        snprintf(err, sizeof err, "GLM engine make failed (exit %d). Output: %.7800s",
                 rc, log_tail[0] ? log_tail : "(no output)");
        glm_send_json(fd, "500 Internal Server Error", 0, task_id, target, downloaded, patched, 0, err);
        return;
    }

    printf("glm: engine checkout ready at %s (commit %.12s)\n", target, DS4_GLM_UPSTREAM_COMMIT);
    glm_send_json(fd, "200 OK", 1, task_id, target, downloaded, patched, 1, "");
#endif
}

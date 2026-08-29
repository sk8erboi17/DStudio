/* ---- Optional GLM 5.3 engine checkout (ds4 branch glm-5.3-flash) -------- */

static int glm53_dir_path(char *out, size_t outsz) {
    if (!g_web_dir[0]) return 0;
    int n = snprintf(out, outsz, "%s/%s", g_web_dir, DS4_GLM53_DIR_NAME);
    return n > 0 && (size_t)n < outsz;
}

static int glm53_checkout_ready(const char *dir) {
    return ds4_dir_valid_path(dir) &&
           (file_present_in_dir(dir, "ds4-server") ||
            file_present_in_dir(dir, "ds4-server.exe"));
}

static void glm53_send_json(int fd, const char *status, int ok,
                            unsigned long long task_id, const char *dir,
                            int downloaded, int built, const char *error) {
    if (task_id) {
        if (ok) task_mark_completed(task_id, "GLM 5.3 engine setup completed");
        else task_mark_failed(task_id,
                              error && error[0] ? error : "GLM 5.3 engine setup failed",
                              dir ? dir : "");
    }
    json_dyn_buf b = {0};
    int good = json_dyn_puts(&b, "{\"ok\":") &&
               json_dyn_puts(&b, ok ? "true" : "false") &&
               json_dyn_printf(&b, ",\"taskId\":%llu", task_id) &&
               json_dyn_puts(&b, ",\"commit\":") &&
               json_dyn_put_escaped(&b, DS4_GLM53_UPSTREAM_COMMIT) &&
               json_dyn_puts(&b, ",\"dir\":") &&
               json_dyn_put_escaped(&b, dir ? dir : "") &&
               json_dyn_printf(&b, ",\"downloaded\":%s,\"built\":%s",
                               downloaded ? "true" : "false",
                               built ? "true" : "false") &&
               json_dyn_puts(&b, ",\"modelDir\":\"ds4/gguf\",\"error\":") &&
               json_dyn_put_escaped(&b, error ? error : "") &&
               json_dyn_puts(&b, "}");
    if (!good) {
        free(b.ptr);
        send_json(fd, "500 Internal Server Error",
                  "{\"ok\":false,\"error\":\"out of memory\"}");
        return;
    }
    send_json(fd, status, b.ptr);
    free(b.ptr);
}

/* POST /api/glm53/setup — install the pinned inference branch beside main.
 * The branch gets no private model store: ./ds4-glm5.3/gguf points to the
 * primary ./ds4/gguf directory. */
static void api_setup_glm53(int fd) {
#ifdef _WIN32
    send_json(fd, "409 Conflict",
              "{\"ok\":false,\"error\":\"the optional GLM 5.3 checkout is not supported on Windows yet\"}");
#else
    resolve_web_dir();
    if (!web_dir_valid()) {
        glm53_send_json(fd, "409 Conflict", 0, 0, "", 0, 0,
                        "DStudio checkout not found");
        return;
    }
    char target[DSTUDIO_PATH_MAX];
    if (!glm53_dir_path(target, sizeof target)) {
        glm53_send_json(fd, "500 Internal Server Error", 0, 0, "", 0, 0,
                        "GLM 5.3 checkout path is too long");
        return;
    }
    unsigned long long task_id =
        task_begin("setup", "Install GLM 5.3 engine", "glm53",
                   g_mode, target, 0, 1);
    task_mark_working(task_id, "preparing the GLM 5.3 checkout");

    char log_tail[8192] = "";
    int downloaded = 0;
    struct stat st;
    int exists = stat(target, &st) == 0;
    if (exists && !S_ISDIR(st.st_mode)) {
        glm53_send_json(fd, "409 Conflict", 0, task_id, target, 0, 0,
                        "DStudio/ds4-glm5.3 exists but is not a folder");
        return;
    }
    if (!exists || !ds4_dir_valid_path(target)) {
        int can_download = !exists;
        if (exists) {
            int empty = 0;
            if (!setup_dir_empty(target, &empty)) {
                glm53_send_json(fd, "409 Conflict", 0, task_id, target, 0, 0,
                                "DStudio/ds4-glm5.3 could not be inspected");
                return;
            }
            can_download = empty;
        }
        if (!can_download) {
            glm53_send_json(fd, "409 Conflict", 0, task_id, target, 0, 0,
                            "DStudio/ds4-glm5.3 is not a ds4 checkout; move it aside and retry");
            return;
        }
        char err[8600];
        if (!setup_download_ds4_archive(DS4_GLM53_ARCHIVE_URL,
                                        DS4_GLM53_UPSTREAM_COMMIT, target,
                                        log_tail, sizeof log_tail,
                                        err, sizeof err)) {
            glm53_send_json(fd, "500 Internal Server Error", 0, task_id,
                            target, 0, 0, err);
            return;
        }
        downloaded = 1;
    }

    char link_err[1600] = "";
    if (!setup_link_shared_gguf(target, link_err, sizeof link_err)) {
        glm53_send_json(fd, "409 Conflict", 0, task_id, target,
                        downloaded, 0, link_err);
        return;
    }

    task_mark_working(task_id, "building the GLM 5.3 engine, Agent and Design runtimes");
    char runtime_err[8600] = "";
    if (!setup_build_branch_runtimes(target, "GLM 5.3",
                                     log_tail, sizeof log_tail,
                                     runtime_err, sizeof runtime_err) ||
        !glm53_checkout_ready(target)) {
        char err[8600];
        snprintf(err, sizeof err, "%s",
                 runtime_err[0] ? runtime_err : "GLM 5.3 runtime preparation failed");
        glm53_send_json(fd, "500 Internal Server Error", 0, task_id,
                        target, downloaded, 0, err);
        return;
    }

    printf("glm53: engine checkout ready at %s (commit %.12s); models in ds4/gguf\n",
           target, DS4_GLM53_UPSTREAM_COMMIT);
    glm53_send_json(fd, "200 OK", 1, task_id, target, downloaded, 1, "");
#endif
}

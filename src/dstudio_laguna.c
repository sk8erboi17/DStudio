/* ---- Optional Laguna S 2.1 engine checkout (ds4 branch laguna-s2.1) ---- */

static int laguna_dir_path(char *out, size_t outsz) {
    if (!g_web_dir[0]) return 0;
    int n = snprintf(out, outsz, "%s/%s", g_web_dir, DS4_LAGUNA_DIR_NAME);
    return n > 0 && (size_t)n < outsz;
}

static int laguna_checkout_ready(const char *dir) {
    return ds4_dir_valid_path(dir) &&
           (file_present_in_dir(dir, "ds4-server") ||
            file_present_in_dir(dir, "ds4-server.exe"));
}

static void laguna_send_json(int fd, const char *status, int ok,
                             unsigned long long task_id, const char *dir,
                             int downloaded, int built, const char *error) {
    if (task_id) {
        if (ok) task_mark_completed(task_id, "Laguna engine setup completed");
        else task_mark_failed(task_id,
                              error && error[0] ? error : "Laguna engine setup failed",
                              dir ? dir : "");
    }
    json_dyn_buf b = {0};
    int good = json_dyn_puts(&b, "{\"ok\":") &&
               json_dyn_puts(&b, ok ? "true" : "false") &&
               json_dyn_printf(&b, ",\"taskId\":%llu", task_id) &&
               json_dyn_puts(&b, ",\"commit\":") &&
               json_dyn_put_escaped(&b, DS4_LAGUNA_UPSTREAM_COMMIT) &&
               json_dyn_puts(&b, ",\"dir\":") &&
               json_dyn_put_escaped(&b, dir ? dir : "") &&
               json_dyn_printf(&b, ",\"downloaded\":%s,\"built\":%s",
                               downloaded ? "true" : "false",
                               built ? "true" : "false") &&
               json_dyn_puts(&b, ",\"error\":") &&
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

/* POST /api/laguna/setup — downloads the pinned upstream Laguna branch into
 * ./ds4-laguna-s21 and builds it. The active engine is not switched implicitly;
 * the user selects the checkout from the model menu. */
static void api_setup_laguna(int fd) {
#if defined(_WIN32) || !defined(__APPLE__)
    send_json(fd, "409 Conflict",
              "{\"ok\":false,\"error\":\"Laguna S 2.1 currently requires the macOS Metal backend\"}");
#else
    resolve_web_dir();
    if (!web_dir_valid()) {
        laguna_send_json(fd, "409 Conflict", 0, 0, "", 0, 0,
                         "DStudio checkout not found");
        return;
    }
    char target[DSTUDIO_PATH_MAX];
    if (!laguna_dir_path(target, sizeof target)) {
        laguna_send_json(fd, "500 Internal Server Error", 0, 0, "", 0, 0,
                         "Laguna checkout path is too long");
        return;
    }
    unsigned long long task_id =
        task_begin("setup", "Install Laguna S 2.1 engine", "laguna",
                   g_mode, target, 0, 1);
    task_mark_working(task_id, "preparing the Laguna S 2.1 checkout");

    char log_tail[8192] = "";
    int downloaded = 0;
    struct stat st;
    int exists = stat(target, &st) == 0;
    if (exists && !S_ISDIR(st.st_mode)) {
        laguna_send_json(fd, "409 Conflict", 0, task_id, target, 0, 0,
                         "DStudio/ds4-laguna-s21 exists but is not a folder");
        return;
    }
    if (!exists || !ds4_dir_valid_path(target)) {
        int can_download = !exists;
        if (exists) {
            int empty = 0;
            if (!setup_dir_empty(target, &empty)) {
                laguna_send_json(fd, "409 Conflict", 0, task_id, target, 0, 0,
                                 "DStudio/ds4-laguna-s21 could not be inspected");
                return;
            }
            can_download = empty;
        }
        if (!can_download) {
            laguna_send_json(fd, "409 Conflict", 0, task_id, target, 0, 0,
                             "DStudio/ds4-laguna-s21 is not a ds4 checkout; remove it and retry");
            return;
        }
        char err[8600];
        if (!setup_download_ds4_archive(DS4_LAGUNA_ARCHIVE_URL,
                                        DS4_LAGUNA_UPSTREAM_COMMIT, target,
                                        log_tail, sizeof log_tail,
                                        err, sizeof err)) {
            laguna_send_json(fd, "500 Internal Server Error", 0, task_id,
                             target, 0, 0, err);
            return;
        }
        downloaded = 1;
    }

    task_mark_working(task_id, "building the Laguna engine, Agent and Design runtimes");
    char runtime_err[8600] = "";
    if (!setup_build_branch_runtimes(target, "Laguna S 2.1",
                                     log_tail, sizeof log_tail,
                                     runtime_err, sizeof runtime_err) ||
        !laguna_checkout_ready(target)) {
        char err[8600];
        snprintf(err, sizeof err, "%s",
                 runtime_err[0] ? runtime_err : "Laguna runtime preparation failed");
        laguna_send_json(fd, "500 Internal Server Error", 0, task_id,
                         target, downloaded, 0, err);
        return;
    }

    printf("laguna: engine checkout ready at %s (commit %.12s)\n",
           target, DS4_LAGUNA_UPSTREAM_COMMIT);
    laguna_send_json(fd, "200 OK", 1, task_id, target, downloaded, 1, "");
#endif
}

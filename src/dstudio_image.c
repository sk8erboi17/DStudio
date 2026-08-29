/* Local image endpoint. Qwen3.8-27B Max makes the authoritative edit/generate
 * decision, exits, and only then may Ideogram 4 or HunyuanImage load. The
 * worker is detached so the main HTTP loop stays responsive during inference. */

#define IMAGE_JOB_OWNER_FILE "server-owner"
#define IMAGE_JOB_CANCEL_FILE "cancel-requested"

static char g_image_owner_token[96];

static void image_runtime_init(void) {
    if (g_image_owner_token[0]) return;
    snprintf(g_image_owner_token, sizeof g_image_owner_token, "%ld-%lld",
             (long)getpid(), dstudio_now_ms());
}

static int image_job_file_path(const char *job_dir, const char *name,
                               char *out, size_t outsz) {
    if (!job_dir || !job_dir[0] || !name || !name[0] || !out || outsz == 0)
        return 0;
    int len = snprintf(out, outsz, "%s/%s", job_dir, name);
    return len > 0 && (size_t)len < outsz;
}

static int image_job_owned(const char *job_dir) {
    char owner_path[DSTUDIO_PATH_MAX];
    if (!g_image_owner_token[0] ||
        !image_job_file_path(job_dir, IMAGE_JOB_OWNER_FILE,
                             owner_path, sizeof owner_path))
        return 0;
    size_t n = 0;
    char *raw = jsonl_read_file(owner_path, &n);
    if (!raw || n == 0 || n >= sizeof g_image_owner_token) {
        free(raw);
        return 0;
    }
    while (n > 0 && (raw[n - 1] == '\n' || raw[n - 1] == '\r' ||
                     raw[n - 1] == ' '))
        raw[--n] = '\0';
    int owned = !strcmp(raw, g_image_owner_token);
    free(raw);
    return owned;
}

static int image_claim_job(const char *job_dir) {
    image_runtime_init();
    char owner_path[DSTUDIO_PATH_MAX];
    if (!image_job_file_path(job_dir, IMAGE_JOB_OWNER_FILE,
                             owner_path, sizeof owner_path))
        return 0;
    size_t token_len = strlen(g_image_owner_token);
#ifdef _WIN32
    HANDLE owner = CreateFileA(owner_path, GENERIC_WRITE, 0, NULL, CREATE_NEW,
                               FILE_ATTRIBUTE_NORMAL, NULL);
    if (owner == INVALID_HANDLE_VALUE) return 0;
    DWORD wrote = 0;
    int ok = WriteFile(owner, g_image_owner_token, (DWORD)token_len,
                       &wrote, NULL) && wrote == (DWORD)token_len;
    CloseHandle(owner);
#else
    int owner = open(owner_path, O_WRONLY | O_CREAT | O_EXCL, 0600);
    if (owner < 0) return 0;
    size_t offset = 0;
    while (offset < token_len) {
        ssize_t wrote = write(owner, g_image_owner_token + offset,
                              token_len - offset);
        if (wrote < 0 && errno == EINTR) continue;
        if (wrote <= 0) break;
        offset += (size_t)wrote;
    }
    int ok = offset == token_len;
    close(owner);
#endif
    if (!ok) (void)unlink(owner_path);
    return ok;
}

static int image_cancel_requested(const char *job_dir) {
    char path[DSTUDIO_PATH_MAX];
    struct stat st;
    return image_job_file_path(job_dir, IMAGE_JOB_CANCEL_FILE,
                               path, sizeof path) &&
           stat(path, &st) == 0 && S_ISREG(st.st_mode);
}

static int image_request_cancel(const char *job_dir) {
    char path[DSTUDIO_PATH_MAX];
    static const char marker[] = "cancelled\n";
    if (!image_job_file_path(job_dir, IMAGE_JOB_CANCEL_FILE,
                             path, sizeof path))
        return 0;
    if (image_cancel_requested(job_dir)) return 1;
    return jsonl_write_file(path, marker, sizeof marker - 1);
}

static void image_stop_worker_pid_path(const char *pid_path) {
#ifndef _WIN32
    size_t n = 0;
    char *raw = jsonl_read_file(pid_path, &n);
    if (!raw || n == 0 || n > 32) { free(raw); return; }
    char *end = NULL;
    long value = strtol(raw, &end, 10);
    free(raw);
    if (value <= 1 || value == (long)getpid()) return;
    pid_t pid = (pid_t)value;
    if (kill(pid, 0) == 0 || errno == EPERM) {
        (void)kill(pid, SIGTERM);
        for (int i = 0; i < 80 && kill(pid, 0) == 0; i++) usleep(100000);
        if (kill(pid, 0) == 0) (void)kill(pid, SIGKILL);
    }
    (void)unlink(pid_path);
#else
    (void)pid_path;
#endif
}

static void image_runtime_shutdown(void) {
#ifndef _WIN32
    if (!g_image_owner_token[0]) return;
    const char *home = getenv("HOME");
    if (!home || !home[0]) return;
    char jobs_path[DSTUDIO_PATH_MAX];
    snprintf(jobs_path, sizeof jobs_path, "%s/.dstudio/image/jobs", home);
    DIR *jobs = opendir(jobs_path);
    if (!jobs) return;
    struct dirent *entry;
    while ((entry = readdir(jobs)) != NULL) {
        if (entry->d_name[0] == '.') continue;
        char job_dir[DSTUDIO_PATH_MAX], pid_path[DSTUDIO_PATH_MAX];
        int job_len = snprintf(job_dir, sizeof job_dir, "%s/%s",
                               jobs_path, entry->d_name);
        if (job_len <= 0 || (size_t)job_len >= sizeof job_dir ||
            !image_job_owned(job_dir))
            continue;
        if (image_job_file_path(job_dir, "worker.pid", pid_path, sizeof pid_path))
            image_stop_worker_pid_path(pid_path);
    }
    closedir(jobs);
#endif
}

static int image_safe_component(const char *s) {
    if (!s || !s[0]) return 0;
    for (const unsigned char *p = (const unsigned char *)s; *p; p++)
        if (!(isalnum(*p) || *p == '-' || *p == '_' || *p == '.')) return 0;
    return strstr(s, "..") == NULL;
}

static int image_safe_job_id(const char *s) {
    size_t n = s ? strlen(s) : 0;
    if (n < 3 || n > 72) return 0;
    for (const unsigned char *p = (const unsigned char *)s; *p; p++)
        if (!(isalnum(*p) || *p == '-' || *p == '_')) return 0;
    return 1;
}

static int image_jobs_dir(char *out, size_t outsz) {
    const char *home = getenv("HOME");
    if (!home || !home[0]) return 0;
    snprintf(out, outsz, "%s/.dstudio/image/jobs", home);
    mkpath(out);
    struct stat st;
    return stat(out, &st) == 0 && S_ISDIR(st.st_mode);
}

static int image_find_png(const char *dir, char *name, size_t namesz) {
    DIR *d = opendir(dir);
    if (!d) return 0;
    struct dirent *e;
    int ok = 0;
    while ((e = readdir(d)) != NULL) {
        size_t n = strlen(e->d_name);
        if (n > 4 && strncmp(e->d_name, "source.", 7) &&
            strncmp(e->d_name, "reference", 9) &&
            !strcasecmp(e->d_name + n - 4, ".png") &&
            image_safe_component(e->d_name)) {
            cstr_copy(name, namesz, e->d_name);
            ok = 1;
            break;
        }
    }
    closedir(d);
    return ok;
}

static void image_write_status(const char *dir, const char *state, const char *stage,
                               const char *label, int progress) {
    char path[DSTUDIO_PATH_MAX], tmp[DSTUDIO_PATH_MAX];
    snprintf(path, sizeof path, "%s/status.json", dir);
    snprintf(tmp, sizeof tmp, "%s/status.%d.tmp", dir, (int)getpid());
    json_dyn_buf b = {0};
    json_dyn_printf(&b, "{\"ok\":%s,\"state\":", strcmp(state, "error") ? "true" : "false") &&
    json_dyn_put_escaped(&b, state) &&
    json_dyn_puts(&b, ",\"stage\":") && json_dyn_put_escaped(&b, stage) &&
    json_dyn_puts(&b, ",\"label\":") && json_dyn_put_escaped(&b, label) &&
    json_dyn_printf(&b, ",\"progress\":%d,\"updatedAt\":%lld}", progress, dstudio_now_ms());
    if (b.ptr && jsonl_write_file(tmp, b.ptr, strlen(b.ptr))) (void)rename(tmp, path);
    else (void)unlink(tmp);
    free(b.ptr);
}

static void image_generation_cancelled(int fd, const char *dir) {
    image_write_status(dir, "error", "cancelled",
                       "Image generation cancelled.", 100);
    web_json_error(fd, "409 Conflict", "image generation cancelled");
}

static int image_error_label_json(const char *data, char *label, size_t labelsz) {
    char state[24] = "";
    if (!data || !json_get_string(data, "state", state, sizeof state) ||
        strcmp(state, "error")) return 0;
    if (!json_get_string(data, "label", label, labelsz) || !label[0])
        cstr_copy(label, labelsz, "Local image inference failed.");
    return 1;
}

static int image_read_error_status(const char *status_path, char *label, size_t labelsz) {
    size_t n = 0;
    char *data = jsonl_read_file(status_path, &n);
    if (!data || n == 0 || n > 65536) {
        free(data);
        return 0;
    }
    int found = image_error_label_json(data, label, labelsz);
    free(data);
    return found;
}

static int image_status_has_state(const char *status_path, const char *expected) {
    size_t n = 0;
    char *data = jsonl_read_file(status_path, &n);
    if (!data || n == 0 || n > 65536) {
        free(data);
        return 0;
    }
    char state[24] = "";
    int match = json_get_string(data, "state", state, sizeof state) &&
                !strcmp(state, expected);
    free(data);
    return match;
}

static int image_write_source(const char *body, const char *field, const char *stem,
                              int required, const char *dir, char *out, size_t outsz,
                              char *err, size_t errsz) {
    char *data = json_get_string_alloc_rpc(body, field);
    if (!data || !data[0]) {
        free(data);
        out[0] = '\0';
        if (required) cstr_copy(err, errsz, "an attached source image is required");
        return !required;
    }
    const char *b64 = data;
    const char *ext = ".png";
    if (!strncmp(data, "data:", 5)) {
        const char *comma = strchr(data, ',');
        const char *semi = strchr(data, ';');
        if (!comma || !semi || semi > comma || strncmp(semi, ";base64", 7) || semi + 7 != comma) {
            free(data); cstr_copy(err, errsz, "malformed source image data URI"); return 0;
        }
        size_t ml = (size_t)(semi - (data + 5));
        if (ml == strlen("image/jpeg") && !strncmp(data + 5, "image/jpeg", ml)) ext = ".jpg";
        else if (ml == strlen("image/png") && !strncmp(data + 5, "image/png", ml)) ext = ".png";
        else if (ml == strlen("image/webp") && !strncmp(data + 5, "image/webp", ml)) ext = ".webp";
        else {
            free(data); cstr_copy(err, errsz, "source image must be PNG, JPEG or WebP"); return 0;
        }
        b64 = comma + 1;
    }
    size_t n = 0;
    char *bytes = base64_decode(b64, &n);
    free(data);
    if (!bytes || n == 0 || n > 16u * 1024 * 1024) {
        free(bytes); cstr_copy(err, errsz, "invalid or oversized source image (16MB max)"); return 0;
    }
    snprintf(out, outsz, "%s/%s%s", dir, stem, ext);
    int ok = jsonl_write_file(out, bytes, n);
    free(bytes);
    if (!ok) { cstr_copy(err, errsz, "cannot save source image"); return 0; }
    return 1;
}

static void api_image_generate_run(int fd, const char *body) {
    char *prompt = json_get_string_alloc_rpc(body, "prompt");
    if (!prompt || !prompt[0] || strlen(prompt) > 12000) {
        free(prompt);
        web_json_error(fd, "400 Bad Request", "prompt is required (max 12000 bytes)");
        return;
    }
    char action[16] = "generate";
    (void)json_get_string(body, "action", action, sizeof action);
    if (strcmp(action, "generate") && strcmp(action, "edit")) {
        free(prompt); web_json_error(fd, "400 Bad Request", "action must be generate or edit"); return;
    }
    char preserve[16] = "none";
    (void)json_get_string(body, "preserve", preserve, sizeof preserve);
    if (strcmp(preserve, "none") && strcmp(preserve, "face")) {
        free(prompt); web_json_error(fd, "400 Bad Request", "preserve must be none or face"); return;
    }
    char aspect[16] = "16:9";
    (void)json_get_string(body, "aspect", aspect, sizeof aspect);
    if (strcmp(aspect, "16:9") && strcmp(aspect, "9:16") && strcmp(aspect, "3:2") &&
        strcmp(aspect, "2:3") && strcmp(aspect, "4:3") && strcmp(aspect, "3:4") &&
        strcmp(aspect, "1:1")) {
        free(prompt); web_json_error(fd, "400 Bad Request", "unsupported image aspect ratio"); return;
    }
    char reasoning[16] = "max";
    (void)json_get_string(body, "reasoning_effort", reasoning, sizeof reasoning);
    if (strcmp(reasoning, "max") && strcmp(reasoning, "high") && strcmp(reasoning, "off")) {
        free(prompt); web_json_error(fd, "400 Bad Request", "reasoning_effort must be max, high or off"); return;
    }
    char base[DSTUDIO_PATH_MAX], id[80], dir[DSTUDIO_PATH_MAX];
    if (!image_jobs_dir(base, sizeof base)) {
        free(prompt); web_json_error(fd, "500 Internal Server Error", "cannot create image job directory"); return;
    }
    char *requested_id = json_get_string_alloc_rpc(body, "job");
    if (requested_id && image_safe_job_id(requested_id)) cstr_copy(id, sizeof id, requested_id);
    else snprintf(id, sizeof id, "image-%lld-%d", dstudio_now_ms(), (int)getpid());
    free(requested_id);
    snprintf(dir, sizeof dir, "%s/%s", base, id);
    mkpath(dir);
    struct stat dst;
    if (stat(dir, &dst) != 0 || !S_ISDIR(dst.st_mode)) {
        free(prompt); web_json_error(fd, "500 Internal Server Error", "cannot create image output directory"); return;
    }
    if (!image_claim_job(dir)) {
        free(prompt); web_json_error(fd, "409 Conflict",
            "the requested image job id already exists or belongs to another DStudio server");
        return;
    }
    char input_path[DSTUDIO_PATH_MAX] = "", reference_path[DSTUDIO_PATH_MAX] = "";
    char reference2_path[DSTUDIO_PATH_MAX] = "", reference3_path[DSTUDIO_PATH_MAX] = "";
    char source_err[160] = "";
    if (!image_write_source(body, "image", "source", 0, dir,
                            input_path, sizeof input_path, source_err, sizeof source_err) ||
        !image_write_source(body, "referenceImage", "reference", 0, dir,
                            reference_path, sizeof reference_path, source_err, sizeof source_err) ||
        !image_write_source(body, "referenceImage2", "reference2", 0, dir,
                            reference2_path, sizeof reference2_path, source_err, sizeof source_err) ||
        !image_write_source(body, "referenceImage3", "reference3", 0, dir,
                            reference3_path, sizeof reference3_path, source_err, sizeof source_err)) {
        free(prompt); image_write_status(dir, "error", "error", source_err, 100);
        web_json_error(fd, "400 Bad Request", source_err); return;
    }
    char prompt_path[DSTUDIO_PATH_MAX];
    snprintf(prompt_path, sizeof prompt_path, "%s/prompt.txt", dir);
    if (!jsonl_write_file(prompt_path, prompt, strlen(prompt))) {
        free(prompt); web_json_error(fd, "500 Internal Server Error", "cannot write image prompt"); return;
    }
    free(prompt);
    image_write_status(dir, "running", "preparing", "Preparing Qwen3.8 Max image routing…", 3);
    if (image_cancel_requested(dir)) {
        image_generation_cancelled(fd, dir);
        return;
    }

    char script[DSTUDIO_PATH_MAX + 256], cancel_path[DSTUDIO_PATH_MAX];
    snprintf(script, sizeof script, "%s/scripts/image-pipeline-run.sh", g_web_dir);
    if (!image_job_file_path(dir, IMAGE_JOB_CANCEL_FILE,
                             cancel_path, sizeof cancel_path)) {
        image_write_status(dir, "error", "error",
                           "Image cancellation path is too long.", 100);
        web_json_error(fd, "500 Internal Server Error",
                       "image cancellation path is too long");
        return;
    }
    char log[16384] = "";
    char status_path[DSTUDIO_PATH_MAX];
    snprintf(status_path, sizeof status_path, "%s/status.json", dir);
    char *argv[30] = { "/bin/sh", script, "--prompt-file", prompt_path,
                       "--outdir", dir, "--status-file", status_path,
                       "--aspect", aspect, "--reasoning-effort", reasoning,
                       "--preserve", preserve, "--cancel-file", cancel_path, NULL };
    int ai = 16;
    if (input_path[0]) { argv[ai++] = "--input"; argv[ai++] = input_path; }
    if (reference_path[0]) { argv[ai++] = "--input"; argv[ai++] = reference_path; }
    if (reference2_path[0]) { argv[ai++] = "--input"; argv[ai++] = reference2_path; }
    if (reference3_path[0]) { argv[ai++] = "--input"; argv[ai++] = reference3_path; }
    argv[ai] = NULL;
    qwen_memory_lease lease = qwen_memory_begin("image-pipeline");
    if (!qwen_memory_ready(&lease)) {
        if (image_cancel_requested(dir)) {
            image_generation_cancelled(fd, dir);
            return;
        }
        image_write_status(dir, "error", "memory", "DS4 memory could not be released; the image pipeline was not started.", 100);
        web_json_error(fd, "503 Service Unavailable",
                       "DS4 memory could not be released; the image pipeline was not started");
        return;
    }
    if (image_cancel_requested(dir)) {
        qwen_memory_end(&lease);
        image_generation_cancelled(fd, dir);
        return;
    }
    int rc = setup_run_cmd_capture(NULL, argv, log, sizeof log);
    qwen_memory_end(&lease);
    if (image_cancel_requested(dir)) {
        image_generation_cancelled(fd, dir);
        return;
    }

    char filename[256] = "";
    if (rc != 0 || !image_find_png(dir, filename, sizeof filename)) {
        char failure[1024] = "";
        if (!image_read_error_status(status_path, failure, sizeof failure)) {
            cstr_copy(failure, sizeof failure,
                      rc != 0 ? "Local image inference failed." :
                                "The local image pipeline produced no PNG.");
            image_write_status(dir, "error", "error", failure, 100);
        }
        json_dyn_buf b = {0};
        json_dyn_puts(&b, "{\"ok\":false,\"error\":") &&
        json_dyn_put_escaped(&b, failure) &&
        json_dyn_puts(&b, ",\"log\":") && json_dyn_put_escaped(&b, log) && json_dyn_puts(&b, "}");
        send_json(fd, "500 Internal Server Error", b.ptr ? b.ptr : "{\"ok\":false}");
        free(b.ptr);
        return;
    }
    /* The backend's terminal status carries its exact provider, quality,
     * geometry, and inference provenance.  Do not replace that evidence with
     * a generic API-level payload.  A worker that exits zero without proving
     * completion is an error, not an implicit success. */
    if (!image_status_has_state(status_path, "complete")) {
        const char *failure = "The local image worker exited without a complete terminal status.";
        image_write_status(dir, "error", "error", failure, 100);
        web_json_error(fd, "500 Internal Server Error", failure);
        return;
    }
    json_dyn_buf b = {0};
    json_dyn_puts(&b, "{\"ok\":true,\"id\":") && json_dyn_put_escaped(&b, id) &&
    json_dyn_puts(&b, ",\"filename\":") && json_dyn_put_escaped(&b, filename) &&
    json_dyn_puts(&b, ",\"url\":") && json_dyn_printf(&b, "\"/api/image/file?id=%s&name=%s\"}", id, filename);
    send_json(fd, "200 OK", b.ptr ? b.ptr : "{\"ok\":false}");
    free(b.ptr);
}

static void api_image_progress(int fd, const char *path) {
    char id[80] = "";
    query_param(path, "id", id, sizeof id);
    if (!image_safe_job_id(id)) {
        web_json_error(fd, "400 Bad Request", "invalid image job"); return;
    }
    char base[DSTUDIO_PATH_MAX], dir[DSTUDIO_PATH_MAX], status[DSTUDIO_PATH_MAX];
    if (!image_jobs_dir(base, sizeof base)) {
        web_json_error(fd, "404 Not Found", "image job not found"); return;
    }
    snprintf(dir, sizeof dir, "%s/%s", base, id);
    snprintf(status, sizeof status, "%s/status.json", dir);
    struct stat st;
    if (stat(status, &st) != 0 || !S_ISREG(st.st_mode) || st.st_size <= 0 || st.st_size > 65536) {
        if (stat(dir, &st) == 0 && S_ISDIR(st.st_mode)) {
            send_json(fd, "200 OK", "{\"ok\":true,\"state\":\"queued\",\"stage\":\"queued\",\"label\":\"Waiting for the local image pipeline…\",\"progress\":1}");
        } else {
            web_json_error(fd, "404 Not Found", "image job not found");
        }
        return;
    }
    size_t n = 0;
    char *data = jsonl_read_file(status, &n);
    if (!data) { web_json_error(fd, "500 Internal Server Error", "cannot read image progress"); return; }
    send_json(fd, "200 OK", data);
    free(data);
}

static void api_image_generate(int fd, const char *body) {
#ifdef _WIN32
    (void)body;
    web_json_error(fd, "501 Not Implemented", "the local image pipeline is not available on Windows yet");
#else
    pid_t pid = fork();
    if (pid < 0) { api_image_generate_run(fd, body); return; }
    if (pid == 0) {
        if (fork() > 0) _exit(0);
        if (g_srv_fd >= 0) close(g_srv_fd);
        if (g_out_fd >= 0) close(g_out_fd);
        if (g_err_fd >= 0) close(g_err_fd);
        if (g_in_fd >= 0) close(g_in_fd);
        api_image_generate_run(fd, body);
        close(fd);
        _exit(0);
    }
    waitpid(pid, NULL, 0);
#endif
}

static void api_image_stop(int fd, const char *body) {
    char id[80] = "";
    (void)json_get_string(body, "job", id, sizeof id);
    if (!image_safe_job_id(id)) {
        web_json_error(fd, "400 Bad Request", "invalid image job"); return;
    }
    char base[DSTUDIO_PATH_MAX], dir[DSTUDIO_PATH_MAX];
    char status_path[DSTUDIO_PATH_MAX], pid_path[DSTUDIO_PATH_MAX];
    if (!image_jobs_dir(base, sizeof base)) {
        web_json_error(fd, "404 Not Found", "image job not found"); return;
    }
    snprintf(dir, sizeof dir, "%s/%s", base, id);
    if (!image_job_owned(dir)) {
        web_json_error(fd, "409 Conflict",
                       "the image job belongs to another DStudio server");
        return;
    }
    snprintf(status_path, sizeof status_path, "%s/status.json", dir);
    if (image_status_has_state(status_path, "complete") ||
        image_status_has_state(status_path, "error") ||
        image_status_has_state(status_path, "cancelled")) {
        send_json(fd, "200 OK",
                  "{\"ok\":true,\"running\":false,\"terminal\":true}");
        return;
    }
    if (!image_request_cancel(dir)) {
        web_json_error(fd, "500 Internal Server Error",
                       "could not persist image cancellation request");
        return;
    }
    snprintf(pid_path, sizeof pid_path, "%s/worker.pid", dir);
    size_t n = 0;
    char *raw = jsonl_read_file(pid_path, &n);
    if (!raw) {
        image_write_status(dir, "error", "cancelled",
                           "Image generation cancelled before worker startup.", 100);
        send_json(fd, "200 OK",
                  "{\"ok\":true,\"running\":false,\"cancellationQueued\":true}");
        return;
    }
    char *end = NULL;
    long pid = strtol(raw, &end, 10);
    free(raw);
    if (pid <= 1 || pid == (long)getpid()) {
        web_json_error(fd, "409 Conflict", "invalid image worker pid"); return;
    }
#ifndef _WIN32
    int stopped = kill((pid_t)pid, SIGTERM) == 0 || errno == ESRCH;
#else
    int stopped = 0;
#endif
    image_write_status(dir, stopped ? "error" : "running",
                       stopped ? "cancelled" : "inference",
                       stopped ? "Image generation cancelled." :
                                 "Could not stop image generation.",
                       stopped ? 100 : 50);
    send_json(fd, stopped ? "200 OK" : "409 Conflict",
              stopped ? "{\"ok\":true,\"running\":false}" :
                        "{\"ok\":false,\"error\":\"could not stop image worker\"}");
}

static void api_image_file(int fd, const char *path, int head_only) {
    char id[80] = "", name[256] = "";
    query_param(path, "id", id, sizeof id);
    query_param(path, "name", name, sizeof name);
    if (!image_safe_component(id) || !image_safe_component(name)) {
        send_text(fd, "400 Bad Request", "invalid image path\n", head_only); return;
    }
    char base[DSTUDIO_PATH_MAX], file[DSTUDIO_PATH_MAX];
    if (!image_jobs_dir(base, sizeof base)) { send_text(fd, "404 Not Found", "not found\n", head_only); return; }
    snprintf(file, sizeof file, "%s/%s/%s", base, id, name);
    struct stat st;
    if (stat(file, &st) != 0 || !S_ISREG(st.st_mode) || st.st_size <= 0 || st.st_size > 64 * 1024 * 1024) {
        send_text(fd, "404 Not Found", "not found\n", head_only); return;
    }
    size_t n = 0;
    char *data = jsonl_read_file(file, &n);
    if (!data) { send_text(fd, "500 Internal Server Error", "read failed\n", head_only); return; }
    send_response(fd, "200 OK", "image/png", data, n, head_only);
    free(data);
}

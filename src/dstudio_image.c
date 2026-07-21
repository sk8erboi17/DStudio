/* Local text-to-image endpoint backed by ivanfioravanti/qwen-image-mps. The
 * worker is detached so the main HTTP loop stays responsive during model load. */

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
    snprintf(out, outsz, "%s/.dstudio/qwen-image/jobs", home);
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
            strncmp(e->d_name, "reference.", 10) &&
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
    json_dyn_puts(&b, "{\"ok\":true,\"state\":") && json_dyn_put_escaped(&b, state) &&
    json_dyn_puts(&b, ",\"stage\":") && json_dyn_put_escaped(&b, stage) &&
    json_dyn_puts(&b, ",\"label\":") && json_dyn_put_escaped(&b, label) &&
    json_dyn_printf(&b, ",\"progress\":%d,\"updatedAt\":%lld}", progress, dstudio_now_ms());
    if (b.ptr && jsonl_write_file(tmp, b.ptr, strlen(b.ptr))) (void)rename(tmp, path);
    else (void)unlink(tmp);
    free(b.ptr);
}

static int image_write_edit_source(const char *body, const char *field, const char *stem,
                                   int required, const char *dir, char *out, size_t outsz,
                                   char *err, size_t errsz) {
    char *data = json_get_string_alloc_rpc(body, field);
    if (!data || !data[0]) {
        free(data);
        out[0] = '\0';
        if (required) cstr_copy(err, errsz, "edit action requires an attached source image");
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
    if (strcmp(action, "edit")) cstr_copy(preserve, sizeof preserve, "none");
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
    char input_path[DSTUDIO_PATH_MAX] = "", reference_path[DSTUDIO_PATH_MAX] = "";
    if (!strcmp(action, "edit")) {
        char source_err[160] = "";
        if (!image_write_edit_source(body, "image", "source", 1, dir,
                                     input_path, sizeof input_path, source_err, sizeof source_err) ||
            !image_write_edit_source(body, "referenceImage", "reference", 0, dir,
                                     reference_path, sizeof reference_path, source_err, sizeof source_err)) {
            free(prompt); image_write_status(dir, "error", "error", source_err, 100);
            web_json_error(fd, "400 Bad Request", source_err); return;
        }
    }
    char prompt_path[DSTUDIO_PATH_MAX];
    snprintf(prompt_path, sizeof prompt_path, "%s/prompt.txt", dir);
    if (!jsonl_write_file(prompt_path, prompt, strlen(prompt))) {
        free(prompt); web_json_error(fd, "500 Internal Server Error", "cannot write image prompt"); return;
    }
    free(prompt);
    image_write_status(dir, "running", "preparing", "Preparing the local Qwen Image runtime…", 3);

    char script[DSTUDIO_PATH_MAX + 256];
    snprintf(script, sizeof script, "%s/scripts/qwen-image-generate.sh", g_web_dir);
    char log[16384] = "";
    char status_path[DSTUDIO_PATH_MAX];
    snprintf(status_path, sizeof status_path, "%s/status.json", dir);
    char *argv[] = { "/bin/sh", script, prompt_path, dir, status_path, action,
                     input_path, preserve, reference_path, NULL };
    qwen_memory_lease lease = qwen_memory_begin("image-generation");
    int rc = setup_run_cmd_capture(NULL, argv, log, sizeof log);
    qwen_memory_end(&lease);

    char filename[256] = "";
    if (rc != 0 || !image_find_png(dir, filename, sizeof filename)) {
        image_write_status(dir, "error", "error",
                           rc != 0 ? "Qwen Image generation failed." : "Qwen Image produced no PNG.", 100);
        json_dyn_buf b = {0};
        json_dyn_puts(&b, "{\"ok\":false,\"error\":") &&
        json_dyn_put_escaped(&b, rc != 0 ? "Qwen image generation failed" : "Qwen produced no PNG") &&
        json_dyn_puts(&b, ",\"log\":") && json_dyn_put_escaped(&b, log) && json_dyn_puts(&b, "}");
        send_json(fd, "500 Internal Server Error", b.ptr ? b.ptr : "{\"ok\":false}");
        free(b.ptr);
        return;
    }
    image_write_status(dir, "complete", "complete", "Image ready.", 100);
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
            send_json(fd, "200 OK", "{\"ok\":true,\"state\":\"queued\",\"stage\":\"queued\",\"label\":\"Waiting for Qwen Image…\",\"progress\":1}");
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
    web_json_error(fd, "501 Not Implemented", "qwen-image-mps is not available on Windows yet");
#else
    pid_t pid = fork();
    if (pid < 0) { api_image_generate_run(fd, body); return; }
    if (pid == 0) {
        if (fork() > 0) _exit(0);
        if (g_srv_fd >= 0) close(g_srv_fd);
        if (g_out_fd >= 0) close(g_out_fd);
        if (g_err_fd >= 0) close(g_err_fd);
        if (g_in_fd >= 0) close(g_in_fd);
        struct timeval tv = { 3600, 0 };
        (void)setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof tv);
        api_image_generate_run(fd, body);
        close(fd);
        _exit(0);
    }
    waitpid(pid, NULL, 0);
#endif
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

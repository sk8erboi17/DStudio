/* Local text-to-image endpoint backed by ivanfioravanti/qwen-image-mps. The
 * worker is detached so the main HTTP loop stays responsive during model load. */

static int image_safe_component(const char *s) {
    if (!s || !s[0]) return 0;
    for (const unsigned char *p = (const unsigned char *)s; *p; p++)
        if (!(isalnum(*p) || *p == '-' || *p == '_' || *p == '.')) return 0;
    return strstr(s, "..") == NULL;
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
        if (n > 4 && !strcasecmp(e->d_name + n - 4, ".png") &&
            image_safe_component(e->d_name)) {
            cstr_copy(name, namesz, e->d_name);
            ok = 1;
            break;
        }
    }
    closedir(d);
    return ok;
}

static void api_image_generate_run(int fd, const char *body) {
    char *prompt = json_get_string_alloc_rpc(body, "prompt");
    if (!prompt || !prompt[0] || strlen(prompt) > 12000) {
        free(prompt);
        web_json_error(fd, "400 Bad Request", "prompt is required (max 12000 bytes)");
        return;
    }
    char base[DSTUDIO_PATH_MAX], id[64], dir[DSTUDIO_PATH_MAX];
    if (!image_jobs_dir(base, sizeof base)) {
        free(prompt); web_json_error(fd, "500 Internal Server Error", "cannot create image job directory"); return;
    }
    snprintf(id, sizeof id, "%lld-%d", dstudio_now_ms(), (int)getpid());
    snprintf(dir, sizeof dir, "%s/%s", base, id);
    mkpath(dir);
    struct stat dst;
    if (stat(dir, &dst) != 0 || !S_ISDIR(dst.st_mode)) {
        free(prompt); web_json_error(fd, "500 Internal Server Error", "cannot create image output directory"); return;
    }
    char prompt_path[DSTUDIO_PATH_MAX];
    snprintf(prompt_path, sizeof prompt_path, "%s/prompt.txt", dir);
    if (!jsonl_write_file(prompt_path, prompt, strlen(prompt))) {
        free(prompt); web_json_error(fd, "500 Internal Server Error", "cannot write image prompt"); return;
    }
    free(prompt);

    char script[DSTUDIO_PATH_MAX + 256];
    snprintf(script, sizeof script, "%s/scripts/qwen-image-generate.sh", g_web_dir);
    char log[16384] = "";
    char *argv[] = { "/bin/sh", script, prompt_path, dir, NULL };
    qwen_memory_lease lease = qwen_memory_begin("image-generation");
    int rc = setup_run_cmd_capture(NULL, argv, log, sizeof log);
    qwen_memory_end(&lease);

    char filename[256] = "";
    if (rc != 0 || !image_find_png(dir, filename, sizeof filename)) {
        json_dyn_buf b = {0};
        json_dyn_puts(&b, "{\"ok\":false,\"error\":") &&
        json_dyn_put_escaped(&b, rc != 0 ? "Qwen image generation failed" : "Qwen produced no PNG") &&
        json_dyn_puts(&b, ",\"log\":") && json_dyn_put_escaped(&b, log) && json_dyn_puts(&b, "}");
        send_json(fd, "500 Internal Server Error", b.ptr ? b.ptr : "{\"ok\":false}");
        free(b.ptr);
        return;
    }
    json_dyn_buf b = {0};
    json_dyn_puts(&b, "{\"ok\":true,\"id\":") && json_dyn_put_escaped(&b, id) &&
    json_dyn_puts(&b, ",\"filename\":") && json_dyn_put_escaped(&b, filename) &&
    json_dyn_puts(&b, ",\"url\":") && json_dyn_printf(&b, "\"/api/image/file?id=%s&name=%s\"}", id, filename);
    send_json(fd, "200 OK", b.ptr ? b.ptr : "{\"ok\":false}");
    free(b.ptr);
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

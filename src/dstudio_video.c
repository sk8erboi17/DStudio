/* Local MiniMax H3 text/image-to-video endpoints.
 *
 * The managed worker uses stock ComfyUI on Apple Silicon and downloads only
 * open-weight checkpoints. No hosted MiniMax generation endpoint exists in
 * this implementation. H3's community license excludes several territories,
 * so setup and generation both require an explicit authorization assertion
 * from the local Settings UI before any weights are downloaded or loaded. */

#define H3_DIFFUSION_NAME "minimax_h3_fl2va_pruned_int8_convrot.safetensors"
#define H3_DIFFUSION_SIZE 20970379616LL
#define H3_VIDEO_VAE_NAME "minimax_h3_video_vae_fp16.safetensors"
#define H3_VIDEO_VAE_SIZE 5207808496LL
#define H3_AUDIO_VAE_NAME "minimax_h3_audio_vae_fp32.safetensors"
#define H3_AUDIO_VAE_SIZE 605254808LL
#define H3_OFFICIAL_ENCODER_NAME "qwen3vl_32b_minimax_h3_int8_convrot.safetensors"
#define H3_OFFICIAL_ENCODER_SIZE 27141342152LL
#define H3_COMMUNITY_ENCODER_NAME "qwen3vl_32b_minimax_h3_int8_convrot_uncensored-by-linjian257.safetensors"
#define H3_COMMUNITY_ENCODER_SIZE 25772287417LL
#define H3_MPS_ACCELERATOR_MARKER ".apple-silicon-fp8-revision"

static int video_root_dir(char *out, size_t outsz) {
    const char *configured = getenv("DSTUDIO_H3_HOME");
    const char *home = getenv("HOME");
    if (configured && configured[0]) snprintf(out, outsz, "%s", configured);
    else if (home && home[0]) snprintf(out, outsz, "%s/.dstudio/minimax-h3", home);
    else return 0;
    mkpath(out);
    struct stat st;
    return stat(out, &st) == 0 && S_ISDIR(st.st_mode);
}

static int video_jobs_dir(char *out, size_t outsz) {
    char root[DSTUDIO_PATH_MAX];
    if (!video_root_dir(root, sizeof root)) return 0;
    snprintf(out, outsz, "%s/jobs", root);
    mkpath(out);
    struct stat st;
    return stat(out, &st) == 0 && S_ISDIR(st.st_mode);
}

static long long video_file_bytes(const char *path) {
    struct stat st;
    return stat(path, &st) == 0 && S_ISREG(st.st_mode) && st.st_size > 0
        ? (long long)st.st_size : 0;
}

static int video_encoder_parse(const char *body, char *out, size_t outsz) {
    cstr_copy(out, outsz, "official");
    (void)json_get_string(body ? body : "", "encoder", out, outsz);
    return !strcmp(out, "official") || !strcmp(out, "community");
}

static int video_license_asserted(const char *body) {
    return json_get_bool(body ? body : "", "licenseAccepted");
}

static int video_find_output(const char *dir, char *name, size_t namesz) {
    DIR *d = opendir(dir);
    if (!d) return 0;
    struct dirent *e;
    int ok = 0;
    while ((e = readdir(d)) != NULL) {
        size_t n = strlen(e->d_name);
        const char *ext = n > 4 ? e->d_name + n - 4 : "";
        int video = !strcasecmp(ext, ".mp4") || !strcasecmp(ext, ".mov") ||
                    (n > 5 && !strcasecmp(e->d_name + n - 5, ".webm")) ||
                    (n > 4 && !strcasecmp(ext, ".mkv"));
        if (video && image_safe_component(e->d_name)) {
            cstr_copy(name, namesz, e->d_name);
            ok = 1;
            break;
        }
    }
    closedir(d);
    return ok;
}

static const char *video_content_type(const char *name) {
    size_t n = name ? strlen(name) : 0;
    if (n >= 5 && !strcasecmp(name + n - 5, ".webm")) return "video/webm";
    if (n >= 4 && !strcasecmp(name + n - 4, ".mov")) return "video/quicktime";
    if (n >= 4 && !strcasecmp(name + n - 4, ".mkv")) return "video/x-matroska";
    return "video/mp4";
}

static void video_write_status_path(const char *path, const char *state, const char *stage,
                                    const char *label, int progress) {
    char tmp[DSTUDIO_PATH_MAX];
    snprintf(tmp, sizeof tmp, "%s.%d.tmp", path, (int)getpid());
    json_dyn_buf b = {0};
    json_dyn_puts(&b, "{\"ok\":true,\"state\":") && json_dyn_put_escaped(&b, state) &&
    json_dyn_puts(&b, ",\"stage\":") && json_dyn_put_escaped(&b, stage) &&
    json_dyn_puts(&b, ",\"label\":") && json_dyn_put_escaped(&b, label) &&
    json_dyn_printf(&b, ",\"progress\":%d,\"updatedAt\":%lld}", progress, dstudio_now_ms());
    if (b.ptr && jsonl_write_file(tmp, b.ptr, strlen(b.ptr))) (void)rename(tmp, path);
    else (void)unlink(tmp);
    free(b.ptr);
}

static void video_write_status(const char *dir, const char *state, const char *stage,
                               const char *label, int progress) {
    char path[DSTUDIO_PATH_MAX];
    snprintf(path, sizeof path, "%s/status.json", dir);
    video_write_status_path(path, state, stage, label, progress);
}

static void api_video_status(int fd, const char *path) {
    char encoder[24] = "official";
    query_param(path, "encoder", encoder, sizeof encoder);
    if (strcmp(encoder, "official") && strcmp(encoder, "community"))
        cstr_copy(encoder, sizeof encoder, "official");
    char root[DSTUDIO_PATH_MAX];
    if (!video_root_dir(root, sizeof root)) {
        web_json_error(fd, "500 Internal Server Error", "cannot resolve MiniMax H3 runtime directory");
        return;
    }
    char comfy[DSTUDIO_PATH_MAX], marker[DSTUDIO_PATH_MAX], accelerator_marker[DSTUDIO_PATH_MAX];
    snprintf(comfy, sizeof comfy, "%s/ComfyUI", root);
    snprintf(marker, sizeof marker, "%s/.comfy-runtime-revision", root);
    snprintf(accelerator_marker, sizeof accelerator_marker, "%s/%s", root, H3_MPS_ACCELERATOR_MARKER);
    char diffusion[DSTUDIO_PATH_MAX], video_vae[DSTUDIO_PATH_MAX], audio_vae[DSTUDIO_PATH_MAX], encoder_path[DSTUDIO_PATH_MAX];
    snprintf(diffusion, sizeof diffusion, "%s/models/diffusion_models/%s", comfy, H3_DIFFUSION_NAME);
    snprintf(video_vae, sizeof video_vae, "%s/models/vae/%s", comfy, H3_VIDEO_VAE_NAME);
    snprintf(audio_vae, sizeof audio_vae, "%s/models/vae/%s", comfy, H3_AUDIO_VAE_NAME);
    const char *encoder_name = !strcmp(encoder, "community") ? H3_COMMUNITY_ENCODER_NAME : H3_OFFICIAL_ENCODER_NAME;
    long long encoder_size = !strcmp(encoder, "community") ? H3_COMMUNITY_ENCODER_SIZE : H3_OFFICIAL_ENCODER_SIZE;
    snprintf(encoder_path, sizeof encoder_path, "%s/models/text_encoders/%s", comfy, encoder_name);
    long long total = H3_DIFFUSION_SIZE + H3_VIDEO_VAE_SIZE + H3_AUDIO_VAE_SIZE + encoder_size;
    long long have = 0;
    long long n = video_file_bytes(diffusion); have += n > H3_DIFFUSION_SIZE ? H3_DIFFUSION_SIZE : n;
    n = video_file_bytes(video_vae); have += n > H3_VIDEO_VAE_SIZE ? H3_VIDEO_VAE_SIZE : n;
    n = video_file_bytes(audio_vae); have += n > H3_AUDIO_VAE_SIZE ? H3_AUDIO_VAE_SIZE : n;
    n = video_file_bytes(encoder_path); have += n > encoder_size ? encoder_size : n;
    int accelerator_installed = video_file_bytes(accelerator_marker) > 0;
    int installed = video_file_bytes(diffusion) == H3_DIFFUSION_SIZE &&
                    video_file_bytes(video_vae) == H3_VIDEO_VAE_SIZE &&
                    video_file_bytes(audio_vae) == H3_AUDIO_VAE_SIZE &&
                    video_file_bytes(encoder_path) == encoder_size &&
                    video_file_bytes(marker) > 0 && accelerator_installed;
    char setup_path[DSTUDIO_PATH_MAX];
    snprintf(setup_path, sizeof setup_path, "%s/setup-status.json", root);
    size_t setup_n = 0;
    char *setup = jsonl_read_file(setup_path, &setup_n);
    if (setup && (setup_n > 65536 || setup[0] != '{')) { free(setup); setup = NULL; }
    json_dyn_buf b = {0};
    json_dyn_puts(&b, "{\"ok\":true,") &&
#if defined(__APPLE__) && (defined(__aarch64__) || defined(__arm64__))
    json_dyn_puts(&b, "\"supported\":true,") &&
#else
    json_dyn_puts(&b, "\"supported\":false,") &&
#endif
    json_dyn_printf(&b, "\"installed\":%s,\"acceleratorInstalled\":%s,\"downloadedBytes\":%lld,\"totalBytes\":%lld,",
                    installed ? "true" : "false", accelerator_installed ? "true" : "false", have, total) &&
    json_dyn_puts(&b, "\"encoder\":") && json_dyn_put_escaped(&b, encoder) &&
    json_dyn_puts(&b, ",\"model\":\"MiniMaxAI/MiniMax-H3\",\"runtime\":\"ComfyUI/MPS\",\"dir\":") &&
    json_dyn_put_escaped(&b, root) && json_dyn_puts(&b, ",\"setup\":") &&
    json_dyn_puts(&b, setup ? setup : "null") && json_dyn_puts(&b, "}");
    send_json(fd, "200 OK", b.ptr ? b.ptr : "{\"ok\":false}");
    free(setup);
    free(b.ptr);
}

static void api_video_setup_run(int fd, const char *body) {
    if (!video_license_asserted(body)) {
        web_json_error(fd, "451 Unavailable For Legal Reasons",
            "MiniMax H3 setup requires explicit confirmation of a valid license/territory authorization");
        return;
    }
    char encoder[24];
    if (!video_encoder_parse(body, encoder, sizeof encoder)) {
        web_json_error(fd, "400 Bad Request", "encoder must be official or community"); return;
    }
    resolve_web_dir();
    if (!web_dir_valid()) {
        web_json_error(fd, "409 Conflict", "DStudio checkout not found"); return;
    }
    char root[DSTUDIO_PATH_MAX], status[DSTUDIO_PATH_MAX], script[DSTUDIO_PATH_MAX + 64];
    if (!video_root_dir(root, sizeof root)) {
        web_json_error(fd, "500 Internal Server Error", "cannot create MiniMax H3 runtime directory"); return;
    }
    snprintf(status, sizeof status, "%s/setup-status.json", root);
    snprintf(script, sizeof script, "%s/scripts/h3-generate.sh", g_web_dir);
    video_write_status_path(status, "running", "queued", "Preparing the MiniMax H3 open weights…", 1);
    char log[32768] = "";
    char *argv[] = { "/bin/sh", script, "--setup-only", "--status-file", status,
                     "--encoder", encoder, NULL };
    int rc = setup_run_cmd_capture(NULL, argv, log, sizeof log);
    if (rc != 0) {
        json_dyn_buf b = {0};
        json_dyn_puts(&b, "{\"ok\":false,\"error\":\"MiniMax H3 setup failed\",\"log\":") &&
        json_dyn_put_escaped(&b, log) && json_dyn_puts(&b, "}");
        send_json(fd, "500 Internal Server Error", b.ptr ? b.ptr : "{\"ok\":false}");
        free(b.ptr);
        return;
    }
    send_json(fd, "200 OK", "{\"ok\":true,\"model\":\"MiniMaxAI/MiniMax-H3\",\"runtime\":\"ComfyUI/MPS\"}");
}

static void api_video_setup(int fd, const char *body) {
#ifdef _WIN32
    (void)body;
    web_json_error(fd, "501 Not Implemented", "MiniMax H3 local setup requires Apple Silicon");
#else
    pid_t pid = fork();
    if (pid < 0) { api_video_setup_run(fd, body); return; }
    if (pid == 0) {
        if (fork() > 0) _exit(0);
        if (g_srv_fd >= 0) close(g_srv_fd);
        if (g_out_fd >= 0) close(g_out_fd);
        if (g_err_fd >= 0) close(g_err_fd);
        if (g_in_fd >= 0) close(g_in_fd);
        struct timeval tv = { 24 * 60 * 60, 0 };
        (void)setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof tv);
        api_video_setup_run(fd, body);
        close(fd);
        _exit(0);
    }
    waitpid(pid, NULL, 0);
#endif
}

static void api_video_generate_run(int fd, const char *body) {
    if (!video_license_asserted(body)) {
        web_json_error(fd, "451 Unavailable For Legal Reasons",
            "Enable MiniMax H3 in Settings and confirm your license/territory authorization first");
        return;
    }
    char encoder[24];
    if (!video_encoder_parse(body, encoder, sizeof encoder)) {
        web_json_error(fd, "400 Bad Request", "encoder must be official or community"); return;
    }
    char *prompt = json_get_string_alloc_rpc(body, "prompt");
    if (!prompt || !prompt[0] || strlen(prompt) > 12000) {
        free(prompt); web_json_error(fd, "400 Bad Request", "prompt is required (max 12000 bytes)"); return;
    }
    long duration = 5;
    int duration_result = json_get_int(body, "duration", 5, 15, &duration);
    if (duration_result < 0) {
        free(prompt); web_json_error(fd, "400 Bad Request", "duration must be between 5 and 15 seconds"); return;
    }
    char aspect[16] = "16:9";
    (void)json_get_string(body, "aspect", aspect, sizeof aspect);
    if (strcmp(aspect, "16:9") && strcmp(aspect, "9:16") && strcmp(aspect, "1:1") &&
        strcmp(aspect, "4:3") && strcmp(aspect, "3:4")) {
        free(prompt); web_json_error(fd, "400 Bad Request", "unsupported video aspect ratio"); return;
    }
    char profile[16] = "balanced";
    (void)json_get_string(body, "profile", profile, sizeof profile);
    if (strcmp(profile, "preview") && strcmp(profile, "balanced") && strcmp(profile, "quality")) {
        free(prompt); web_json_error(fd, "400 Bad Request", "profile must be preview, balanced or quality"); return;
    }
    char base[DSTUDIO_PATH_MAX], id[80], dir[DSTUDIO_PATH_MAX];
    if (!video_jobs_dir(base, sizeof base)) {
        free(prompt); web_json_error(fd, "500 Internal Server Error", "cannot create video job directory"); return;
    }
    char *requested_id = json_get_string_alloc_rpc(body, "job");
    if (requested_id && image_safe_job_id(requested_id)) cstr_copy(id, sizeof id, requested_id);
    else snprintf(id, sizeof id, "video-%lld-%d", dstudio_now_ms(), (int)getpid());
    free(requested_id);
    snprintf(dir, sizeof dir, "%s/%s", base, id);
    mkpath(dir);
    struct stat dst;
    if (stat(dir, &dst) != 0 || !S_ISDIR(dst.st_mode)) {
        free(prompt); web_json_error(fd, "500 Internal Server Error", "cannot create video output directory"); return;
    }
    char first_frame[DSTUDIO_PATH_MAX] = "", source_err[180] = "";
    if (!image_write_edit_source(body, "image", "first-frame", 0, dir,
                                 first_frame, sizeof first_frame, source_err, sizeof source_err)) {
        free(prompt); video_write_status(dir, "error", "error", source_err, 100);
        web_json_error(fd, "400 Bad Request", source_err); return;
    }
    char prompt_path[DSTUDIO_PATH_MAX], status_path[DSTUDIO_PATH_MAX];
    snprintf(prompt_path, sizeof prompt_path, "%s/prompt.txt", dir);
    snprintf(status_path, sizeof status_path, "%s/status.json", dir);
    if (!jsonl_write_file(prompt_path, prompt, strlen(prompt))) {
        free(prompt); web_json_error(fd, "500 Internal Server Error", "cannot write video prompt"); return;
    }
    free(prompt);
    video_write_status(dir, "running", "preparing", "Preparing the local MiniMax H3 runtime…", 2);
    resolve_web_dir();
    char script[DSTUDIO_PATH_MAX + 64], duration_s[16];
    snprintf(script, sizeof script, "%s/scripts/h3-generate.sh", g_web_dir);
    snprintf(duration_s, sizeof duration_s, "%ld", duration);
    char log[32768] = "";
    char *argv[24];
    int a = 0;
    argv[a++] = "/bin/sh"; argv[a++] = script;
    argv[a++] = "--prompt-file"; argv[a++] = prompt_path;
    argv[a++] = "--outdir"; argv[a++] = dir;
    argv[a++] = "--status-file"; argv[a++] = status_path;
    argv[a++] = "--duration"; argv[a++] = duration_s;
    argv[a++] = "--aspect"; argv[a++] = aspect;
    argv[a++] = "--profile"; argv[a++] = profile;
    argv[a++] = "--encoder"; argv[a++] = encoder;
    if (first_frame[0]) { argv[a++] = "--first-frame"; argv[a++] = first_frame; }
    argv[a] = NULL;
    int rc = setup_run_cmd_capture(NULL, argv, log, sizeof log);
    char filename[256] = "";
    if (rc != 0 || !video_find_output(dir, filename, sizeof filename)) {
        video_write_status(dir, "error", "error",
                           rc != 0 ? "MiniMax H3 generation failed." : "MiniMax H3 produced no video.", 100);
        json_dyn_buf b = {0};
        json_dyn_puts(&b, "{\"ok\":false,\"error\":") &&
        json_dyn_put_escaped(&b, rc != 0 ? "MiniMax H3 generation failed" : "MiniMax H3 produced no video") &&
        json_dyn_puts(&b, ",\"log\":") && json_dyn_put_escaped(&b, log) && json_dyn_puts(&b, "}");
        send_json(fd, "500 Internal Server Error", b.ptr ? b.ptr : "{\"ok\":false}");
        free(b.ptr);
        return;
    }
    video_write_status(dir, "complete", "complete", "Video H3 ready — generated locally.", 100);
    json_dyn_buf b = {0};
    json_dyn_puts(&b, "{\"ok\":true,\"id\":") && json_dyn_put_escaped(&b, id) &&
    json_dyn_puts(&b, ",\"filename\":") && json_dyn_put_escaped(&b, filename) &&
    json_dyn_puts(&b, ",\"model\":\"MiniMaxAI/MiniMax-H3\",\"profile\":") &&
    json_dyn_put_escaped(&b, profile) && json_dyn_puts(&b, ",\"url\":") &&
    json_dyn_printf(&b, "\"/api/video/file?id=%s&name=%s\"}", id, filename);
    send_json(fd, "200 OK", b.ptr ? b.ptr : "{\"ok\":false}");
    free(b.ptr);
}

static void api_video_generate(int fd, const char *body) {
#ifdef _WIN32
    (void)body;
    web_json_error(fd, "501 Not Implemented", "MiniMax H3 local generation requires Apple Silicon");
#else
    pid_t pid = fork();
    if (pid < 0) { api_video_generate_run(fd, body); return; }
    if (pid == 0) {
        if (fork() > 0) _exit(0);
        if (g_srv_fd >= 0) close(g_srv_fd);
        if (g_out_fd >= 0) close(g_out_fd);
        if (g_err_fd >= 0) close(g_err_fd);
        if (g_in_fd >= 0) close(g_in_fd);
        struct timeval tv = { 24 * 60 * 60, 0 };
        (void)setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof tv);
        api_video_generate_run(fd, body);
        close(fd);
        _exit(0);
    }
    waitpid(pid, NULL, 0);
#endif
}

static void api_video_progress(int fd, const char *path) {
    char id[80] = "";
    query_param(path, "id", id, sizeof id);
    if (!image_safe_job_id(id)) {
        web_json_error(fd, "400 Bad Request", "invalid video job"); return;
    }
    char base[DSTUDIO_PATH_MAX], dir[DSTUDIO_PATH_MAX], status[DSTUDIO_PATH_MAX];
    if (!video_jobs_dir(base, sizeof base)) {
        web_json_error(fd, "404 Not Found", "video job not found"); return;
    }
    snprintf(dir, sizeof dir, "%s/%s", base, id);
    snprintf(status, sizeof status, "%s/status.json", dir);
    struct stat st;
    if (stat(status, &st) != 0 || !S_ISREG(st.st_mode) || st.st_size <= 0 || st.st_size > 65536) {
        if (stat(dir, &st) == 0 && S_ISDIR(st.st_mode))
            send_json(fd, "200 OK", "{\"ok\":true,\"state\":\"queued\",\"stage\":\"queued\",\"label\":\"Waiting for MiniMax H3…\",\"progress\":1}");
        else web_json_error(fd, "404 Not Found", "video job not found");
        return;
    }
    size_t n = 0;
    char *data = jsonl_read_file(status, &n);
    if (!data) { web_json_error(fd, "500 Internal Server Error", "cannot read video progress"); return; }
    send_json(fd, "200 OK", data);
    free(data);
}

static void api_video_stop(int fd, const char *body) {
    char id[80] = "";
    (void)json_get_string(body, "job", id, sizeof id);
    if (!image_safe_job_id(id)) {
        web_json_error(fd, "400 Bad Request", "invalid video job"); return;
    }
    char base[DSTUDIO_PATH_MAX], pid_path[DSTUDIO_PATH_MAX], dir[DSTUDIO_PATH_MAX];
    if (!video_jobs_dir(base, sizeof base)) {
        web_json_error(fd, "404 Not Found", "video job not found"); return;
    }
    snprintf(dir, sizeof dir, "%s/%s", base, id);
    snprintf(pid_path, sizeof pid_path, "%s/worker.pid", dir);
    size_t n = 0;
    char *raw = jsonl_read_file(pid_path, &n);
    if (!raw) { send_json(fd, "200 OK", "{\"ok\":true,\"running\":false}"); return; }
    char *end = NULL;
    long pid = strtol(raw, &end, 10);
    free(raw);
    if (pid <= 1 || pid == (long)getpid()) {
        web_json_error(fd, "409 Conflict", "invalid video worker pid"); return;
    }
#ifndef _WIN32
    int stopped = kill((pid_t)pid, SIGTERM) == 0 || errno == ESRCH;
#else
    int stopped = 0;
#endif
    video_write_status(dir, stopped ? "error" : "running", stopped ? "cancelled" : "inference",
                       stopped ? "Video generation cancelled." : "Could not stop video generation.", stopped ? 100 : 50);
    send_json(fd, stopped ? "200 OK" : "409 Conflict",
              stopped ? "{\"ok\":true,\"running\":false}" : "{\"ok\":false,\"error\":\"could not stop video worker\"}");
}

static const char *video_find_range_header(const char *req, size_t hlen) {
    if (!req) return NULL;
    const char *p = req;
    const char *end = req + hlen;
    while (p < end) {
        const char *nl = memchr(p, '\n', (size_t)(end - p));
        const char *line_end = nl ? nl : end;
        if ((size_t)(line_end - p) >= 13 && !strncasecmp(p, "Range: bytes=", 13)) return p + 13;
        p = nl ? nl + 1 : end;
    }
    return NULL;
}

static int video_parse_range(const char *raw, long long size, long long *start, long long *end) {
    if (!raw) return 0;
    /* Work on the Range header value only. Looking for commas in the whole
     * remaining request would incorrectly reject a valid range whenever a
     * later Accept header contains a comma (normal browser behaviour). */
    size_t spec_len = strcspn(raw, "\r\n");
    if (spec_len == 0 || spec_len >= 128) return -1;
    char spec[128];
    memcpy(spec, raw, spec_len);
    spec[spec_len] = '\0';
    raw = spec;
    if (strchr(raw, ',')) return -1;
    char *tail = NULL;
    if (*raw == '-') {
        long long suffix = strtoll(raw + 1, &tail, 10);
        if (tail == raw + 1 || *tail || suffix <= 0) return -1;
        *start = suffix >= size ? 0 : size - suffix;
        *end = size - 1;
        return 1;
    }
    long long first = strtoll(raw, &tail, 10);
    if (tail == raw || first < 0 || *tail != '-') return -1;
    raw = tail + 1;
    long long last = size - 1;
    if (*raw >= '0' && *raw <= '9') {
        last = strtoll(raw, &tail, 10);
        if (tail == raw || *tail || last < first) return -1;
    } else if (*raw) {
        return -1;
    }
    if (first >= size) return -1;
    if (last >= size) last = size - 1;
    *start = first; *end = last;
    return 1;
}

static void api_video_file(int fd, const char *path, int head_only,
                           const char *req, size_t header_len) {
    char id[80] = "", name[256] = "";
    query_param(path, "id", id, sizeof id);
    query_param(path, "name", name, sizeof name);
    if (!image_safe_job_id(id) || !image_safe_component(name)) {
        send_text(fd, "400 Bad Request", "invalid video path\n", head_only); return;
    }
    char base[DSTUDIO_PATH_MAX], file[DSTUDIO_PATH_MAX];
    if (!video_jobs_dir(base, sizeof base)) { send_text(fd, "404 Not Found", "not found\n", head_only); return; }
    snprintf(file, sizeof file, "%s/%s/%s", base, id, name);
    struct stat st;
    if (stat(file, &st) != 0 || !S_ISREG(st.st_mode) || st.st_size <= 0) {
        send_text(fd, "404 Not Found", "not found\n", head_only); return;
    }
    long long start = 0, end = (long long)st.st_size - 1;
    int ranged = video_parse_range(video_find_range_header(req, header_len), (long long)st.st_size, &start, &end);
    if (ranged < 0) {
        char hdr[256];
        int hn = snprintf(hdr, sizeof hdr,
            "HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */%lld\r\nContent-Length: 0\r\n%s\r\n",
            (long long)st.st_size, SEC_HEADERS);
        if (hn > 0 && (size_t)hn < sizeof hdr) send_all(fd, hdr, (size_t)hn);
        return;
    }
    long long length = end - start + 1;
    char hdr[1536];
    int hn;
    if (ranged > 0) {
        hn = snprintf(hdr, sizeof hdr,
            "HTTP/1.1 206 Partial Content\r\nContent-Type: %s\r\nContent-Length: %lld\r\n"
            "Content-Range: bytes %lld-%lld/%lld\r\nAccept-Ranges: bytes\r\n"
            "Content-Disposition: inline; filename=\"%s\"\r\n%s\r\n",
            video_content_type(name), length, start, end, (long long)st.st_size, name, SEC_HEADERS);
    } else {
        hn = snprintf(hdr, sizeof hdr,
            "HTTP/1.1 200 OK\r\nContent-Type: %s\r\nContent-Length: %lld\r\n"
            "Accept-Ranges: bytes\r\nContent-Disposition: inline; filename=\"%s\"\r\n%s\r\n",
            video_content_type(name), length, name, SEC_HEADERS);
    }
    if (hn <= 0 || (size_t)hn >= sizeof hdr || send_all(fd, hdr, (size_t)hn) < 0 || head_only) return;
    FILE *f = fopen(file, "rb");
    if (!f) return;
    if (fseeko(f, (off_t)start, SEEK_SET) != 0) { fclose(f); return; }
    char buf[128 * 1024];
    long long left = length;
    while (left > 0) {
        size_t want = left < (long long)sizeof buf ? (size_t)left : sizeof buf;
        size_t got = fread(buf, 1, want, f);
        if (!got || send_all(fd, buf, got) < 0) break;
        left -= (long long)got;
    }
    fclose(f);
}

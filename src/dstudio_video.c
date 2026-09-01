/* Local MiniMax H3 text/image/reference-to-video endpoints.
 *
 * The managed worker builds the pinned native antirez/h3.c Metal engine and
 * downloads the original official FL2VA snapshot plus the optional Ref2VA
 * reference transformer. No ComfyUI, Python ML stack or hosted MiniMax
 * generation endpoint is part of inference. H3's community license excludes
 * several territories, so setup and generation both require an explicit
 * authorization assertion before weights are downloaded/loaded. */

#define H3_NATIVE_COMMIT "8974cc055ea9c02fcd14cc27dfda3e1027c05153"
#define H3_PATCH_SHA256 "5845dce1d8b4fb02bb55c4006b686e97a6fb738aed61cb7a35e67093507d6600"
#define H3_RUNTIME_REVISION H3_NATIVE_COMMIT "+" H3_PATCH_SHA256
#define H3_MODEL_REVISION "9ac0dd7aabc2c651fcf0ace4c00b2bffd9c8c8a6"
#define H3_MODEL_TOTAL_SIZE 144023550851LL
#define H3_REFERENCE_MODEL_TOTAL_SIZE 66280524863LL
#define H3_NATIVE_MARKER ".h3c-runtime-revision"
#define H3_MODEL_MARKER ".model-revision"
#define H3_REFERENCE_MODEL_MARKER ".ref2va-model-revision"
#define H3_JOB_OWNER_FILE "server-owner"
#define H3_JOB_CANCEL_FILE "cancel-requested"

/* Each DStudio server owns only the H3 jobs it launched. The token is created
 * before request workers fork and is inherited by those workers; another
 * server sharing the same model/job root therefore cannot terminate them. */
static char g_video_owner_token[96];

static void video_runtime_init(void) {
    if (g_video_owner_token[0]) return;
    snprintf(g_video_owner_token, sizeof g_video_owner_token, "%ld-%lld",
             (long)getpid(), dstudio_now_ms());
}

static int video_job_owned(const char *job_dir) {
    if (!job_dir || !job_dir[0] || !g_video_owner_token[0]) return 0;
    char owner_path[DSTUDIO_PATH_MAX];
    int len = snprintf(owner_path, sizeof owner_path, "%s/%s",
                       job_dir, H3_JOB_OWNER_FILE);
    if (len <= 0 || (size_t)len >= sizeof owner_path) return 0;
    size_t n = 0;
    char *raw = jsonl_read_file(owner_path, &n);
    if (!raw || n == 0 || n >= sizeof g_video_owner_token) {
        free(raw);
        return 0;
    }
    while (n > 0 && (raw[n - 1] == '\n' || raw[n - 1] == '\r' ||
                     raw[n - 1] == ' '))
        raw[--n] = '\0';
    int owned = !strcmp(raw, g_video_owner_token);
    free(raw);
    return owned;
}

static int video_claim_job(const char *job_dir) {
    if (!job_dir || !job_dir[0]) return 0;
    video_runtime_init();
    char owner_path[DSTUDIO_PATH_MAX];
    int len = snprintf(owner_path, sizeof owner_path, "%s/%s",
                       job_dir, H3_JOB_OWNER_FILE);
    if (len <= 0 || (size_t)len >= sizeof owner_path) return 0;
    size_t token_len = strlen(g_video_owner_token);
#ifdef _WIN32
    HANDLE owner = CreateFileA(owner_path, GENERIC_WRITE, 0, NULL, CREATE_NEW,
                               FILE_ATTRIBUTE_NORMAL, NULL);
    if (owner == INVALID_HANDLE_VALUE) {
        DWORD error = GetLastError();
        if (error == ERROR_FILE_EXISTS || error == ERROR_ALREADY_EXISTS)
            return 0;
        return 0;
    }
    DWORD wrote = 0;
    int ok = WriteFile(owner, g_video_owner_token, (DWORD)token_len,
                       &wrote, NULL) && wrote == (DWORD)token_len;
    CloseHandle(owner);
#else
    int owner = open(owner_path, O_WRONLY | O_CREAT | O_EXCL, 0600);
    if (owner < 0) {
        return 0;
    }
    size_t offset = 0;
    while (offset < token_len) {
        ssize_t wrote = write(owner, g_video_owner_token + offset,
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

static int video_job_cancel_path(const char *job_dir, char *out, size_t outsz) {
    if (!job_dir || !job_dir[0] || !out || outsz == 0) return 0;
    int len = snprintf(out, outsz, "%s/%s", job_dir, H3_JOB_CANCEL_FILE);
    return len > 0 && (size_t)len < outsz;
}

static int video_cancel_requested(const char *job_dir) {
    char path[DSTUDIO_PATH_MAX];
    struct stat st;
    return video_job_cancel_path(job_dir, path, sizeof path) &&
           stat(path, &st) == 0 && S_ISREG(st.st_mode);
}

static int video_request_cancel(const char *job_dir) {
    char path[DSTUDIO_PATH_MAX];
    static const char marker[] = "cancelled\n";
    if (!video_job_cancel_path(job_dir, path, sizeof path)) return 0;
    if (video_cancel_requested(job_dir)) return 1;
    return jsonl_write_file(path, marker, sizeof marker - 1);
}

static const long long H3_TEXT_ENCODER_SHARD_SIZES[] = {
    4932328944LL, 4875990528LL, 4875990552LL, 4875990584LL,
    4875990584LL, 4875990584LL, 4875990584LL, 4875990584LL,
    4875990584LL, 4875990584LL, 4875990584LL, 4875990584LL,
    4875990584LL, 3270697008LL
};
static const long long H3_TRANSFORMER_SHARD_SIZES[] = {
    5227812968LL, 5164578856LL, 5164578872LL, 5164578896LL,
    5164578896LL, 5164578896LL, 5164578896LL, 5164578896LL,
    5164578896LL, 5164578896LL, 5164578896LL, 5164578896LL,
    4242305176LL
};

static void video_stop_worker_pid_path(const char *pid_path) {
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

/* h3.c is one-shot and retains no detached server or model residency. Only a
 * generation already in flight must be stopped when the desktop server exits. */
static void video_runtime_shutdown(void) {
#ifndef _WIN32
    if (!g_video_owner_token[0]) return;
    const char *configured = getenv("DSTUDIO_H3_HOME");
    const char *home = getenv("HOME");
    char root[DSTUDIO_PATH_MAX], jobs_path[DSTUDIO_PATH_MAX];
    if (configured && configured[0]) cstr_copy(root, sizeof root, configured);
    else if (home && home[0]) snprintf(root, sizeof root, "%s/.dstudio/minimax-h3", home);
    else return;
    snprintf(jobs_path, sizeof jobs_path, "%s/jobs", root);
    DIR *jobs = opendir(jobs_path);
    if (!jobs) return;
    struct dirent *entry;
    while ((entry = readdir(jobs)) != NULL) {
        if (entry->d_name[0] == '.') continue;
        char job_dir[DSTUDIO_PATH_MAX], pid_path[DSTUDIO_PATH_MAX];
        int job_len = snprintf(job_dir, sizeof job_dir, "%s/%s",
                               jobs_path, entry->d_name);
        if (job_len <= 0 || (size_t)job_len >= sizeof job_dir ||
            !video_job_owned(job_dir))
            continue;
        int len = snprintf(pid_path, sizeof pid_path, "%s/worker.pid", job_dir);
        if (len > 0 && (size_t)len < sizeof pid_path)
            video_stop_worker_pid_path(pid_path);
    }
    closedir(jobs);
#endif
}

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

static int video_marker_matches(const char *path, const char *expected) {
    size_t n = 0;
    char *raw = jsonl_read_file(path, &n);
    if (!raw || n == 0 || n > 128) { free(raw); return 0; }
    while (n > 0 && (raw[n - 1] == '\n' || raw[n - 1] == '\r' || raw[n - 1] == ' '))
        raw[--n] = '\0';
    int match = !strcmp(raw, expected);
    free(raw);
    return match;
}

static void video_model_file_progress(const char *model, const char *relative,
                                      long long expected, long long *have,
                                      int *complete) {
    char path[DSTUDIO_PATH_MAX], partial[DSTUDIO_PATH_MAX];
    int len = snprintf(path, sizeof path, "%s/%s", model, relative);
    if (len <= 0 || (size_t)len >= sizeof path) { *complete = 0; return; }
    long long final_bytes = video_file_bytes(path);
    if (final_bytes == expected) { *have += expected; return; }
    *complete = 0;
    len = snprintf(partial, sizeof partial, "%s.part", path);
    long long partial_bytes = len > 0 && (size_t)len < sizeof partial
        ? video_file_bytes(partial) : 0;
    long long credit = final_bytes > partial_bytes ? final_bytes : partial_bytes;
    if (credit > expected) credit = expected;
    if (credit > 0) *have += credit;
}

static long long video_model_progress(const char *root, int *complete) {
    char model[DSTUDIO_PATH_MAX], relative[256];
    snprintf(model, sizeof model, "%s/MiniMax-H3", root);
    long long have = 0;
    *complete = 1;
    video_model_file_progress(model, "FL2VA/audio_vae/config.json", 1973LL, &have, complete);
    video_model_file_progress(model, "FL2VA/audio_vae/model.safetensors", 605429308LL, &have, complete);
    video_model_file_progress(model, "FL2VA/text_encoder/config.json", 1474LL, &have, complete);
    for (size_t i = 0; i < sizeof H3_TEXT_ENCODER_SHARD_SIZES / sizeof H3_TEXT_ENCODER_SHARD_SIZES[0]; i++) {
        snprintf(relative, sizeof relative, "FL2VA/text_encoder/model-%05zu-of-00014.safetensors", i + 1);
        video_model_file_progress(model, relative, H3_TEXT_ENCODER_SHARD_SIZES[i], &have, complete);
    }
    video_model_file_progress(model, "FL2VA/text_encoder/model.safetensors.index.json", 97831LL, &have, complete);
    video_model_file_progress(model, "FL2VA/tokenizer/tokenizer.json", 7032403LL, &have, complete);
    video_model_file_progress(model, "FL2VA/transformer/config.json", 604LL, &have, complete);
    for (size_t i = 0; i < sizeof H3_TRANSFORMER_SHARD_SIZES / sizeof H3_TRANSFORMER_SHARD_SIZES[0]; i++) {
        snprintf(relative, sizeof relative, "FL2VA/transformer/model-%05zu-of-00013.safetensors", i + 1);
        video_model_file_progress(model, relative, H3_TRANSFORMER_SHARD_SIZES[i], &have, complete);
    }
    video_model_file_progress(model, "FL2VA/transformer/model.safetensors.index.json", 38323LL, &have, complete);
    video_model_file_progress(model, "FL2VA/video_vae/config.json", 1807LL, &have, complete);
    video_model_file_progress(model, "FL2VA/video_vae/source/model.safetensors", 10415548320LL, &have, complete);
    return have > H3_MODEL_TOTAL_SIZE ? H3_MODEL_TOTAL_SIZE : have;
}

static void video_model_file_required(const char *model, const char *relative,
                                      long long expected, int *complete) {
    char path[DSTUDIO_PATH_MAX];
    int len = snprintf(path, sizeof path, "%s/%s", model, relative);
    if (len <= 0 || (size_t)len >= sizeof path || video_file_bytes(path) != expected)
        *complete = 0;
}

static long long video_reference_model_progress(const char *root, int *complete) {
    char model[DSTUDIO_PATH_MAX], relative[256];
    snprintf(model, sizeof model, "%s/MiniMax-H3", root);
    long long have = 0;
    *complete = 1;
    video_model_file_progress(model, "Ref2VA/transformer/config.json", 604LL, &have, complete);
    for (size_t i = 0; i < sizeof H3_TRANSFORMER_SHARD_SIZES / sizeof H3_TRANSFORMER_SHARD_SIZES[0]; i++) {
        snprintf(relative, sizeof relative, "Ref2VA/transformer/model-%05zu-of-00013.safetensors", i + 1);
        video_model_file_progress(model, relative, H3_TRANSFORMER_SHARD_SIZES[i], &have, complete);
    }
    video_model_file_progress(model, "Ref2VA/transformer/model.safetensors.index.json", 38323LL, &have, complete);

    /* These are symlinked to byte-identical FL2VA assets by the managed setup.
     * They do not consume or contribute another copy to the progress total. */
    video_model_file_required(model, "Ref2VA/audio_vae/config.json", 1973LL, complete);
    video_model_file_required(model, "Ref2VA/audio_vae/model.safetensors", 605429308LL, complete);
    video_model_file_required(model, "Ref2VA/text_encoder/config.json", 1474LL, complete);
    for (size_t i = 0; i < sizeof H3_TEXT_ENCODER_SHARD_SIZES / sizeof H3_TEXT_ENCODER_SHARD_SIZES[0]; i++) {
        snprintf(relative, sizeof relative, "Ref2VA/text_encoder/model-%05zu-of-00014.safetensors", i + 1);
        video_model_file_required(model, relative, H3_TEXT_ENCODER_SHARD_SIZES[i], complete);
    }
    video_model_file_required(model, "Ref2VA/text_encoder/model.safetensors.index.json", 97831LL, complete);
    video_model_file_required(model, "Ref2VA/tokenizer/tokenizer.json", 7032403LL, complete);
    video_model_file_required(model, "Ref2VA/video_vae/config.json", 1807LL, complete);
    video_model_file_required(model, "Ref2VA/video_vae/source/model.safetensors", 10415548320LL, complete);
    return have > H3_REFERENCE_MODEL_TOTAL_SIZE ? H3_REFERENCE_MODEL_TOTAL_SIZE : have;
}

static int video_reference_model_installed(const char *root) {
    char marker[DSTUDIO_PATH_MAX];
    int complete = 0;
    (void)video_reference_model_progress(root, &complete);
    snprintf(marker, sizeof marker, "%s/%s", root, H3_REFERENCE_MODEL_MARKER);
    return complete && video_marker_matches(marker, H3_MODEL_REVISION);
}

static int video_encoder_parse(const char *body, char *out, size_t outsz) {
    cstr_copy(out, outsz, "official");
    (void)json_get_string(body ? body : "", "encoder", out, outsz);
    return !strcmp(out, "official");
}

static int video_license_asserted(const char *body) {
    return json_get_bool(body ? body : "", "licenseAccepted");
}

static int video_json_string_present(const char *body, const char *field) {
    char *value = json_get_string_alloc_rpc(body ? body : "", field);
    int present = value && value[0];
    free(value);
    return present;
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
    int ok_state = strcmp(state, "error") && strcmp(state, "cancelled");
    json_dyn_printf(&b, "{\"ok\":%s,\"state\":", ok_state ? "true" : "false") &&
    json_dyn_put_escaped(&b, state) &&
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

static void video_generation_cancelled(int fd, const char *dir) {
    video_write_status(dir, "error", "cancelled",
                       "Video generation cancelled.", 100);
    web_json_error(fd, "409 Conflict", "video generation cancelled");
}

static int video_status_has_state(const char *status_path, const char *expected) {
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

static void api_video_status(int fd, const char *path) {
    (void)path;
    const char *encoder = "official";
    char root[DSTUDIO_PATH_MAX];
    if (!video_root_dir(root, sizeof root)) {
        web_json_error(fd, "500 Internal Server Error", "cannot resolve MiniMax H3 runtime directory");
        return;
    }
    char native_marker[DSTUDIO_PATH_MAX], model_marker[DSTUDIO_PATH_MAX], binary[DSTUDIO_PATH_MAX];
    snprintf(native_marker, sizeof native_marker, "%s/%s", root, H3_NATIVE_MARKER);
    snprintf(model_marker, sizeof model_marker, "%s/%s", root, H3_MODEL_MARKER);
    snprintf(binary, sizeof binary, "%s/h3.c/h3", root);
    int model_complete = 0;
    long long have = video_model_progress(root, &model_complete);
    int reference_model_complete = 0;
    long long reference_have = video_reference_model_progress(root, &reference_model_complete);
    int native_installed = video_file_bytes(binary) > 0 &&
                           video_marker_matches(native_marker, H3_RUNTIME_REVISION);
    int installed = native_installed && model_complete &&
                    video_marker_matches(model_marker, H3_MODEL_REVISION);
    int references_installed = installed && reference_model_complete &&
                               video_reference_model_installed(root);
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
    json_dyn_printf(&b, "\"installed\":%s,\"nativeInstalled\":%s,\"downloadedBytes\":%lld,\"totalBytes\":%lld,",
                    installed ? "true" : "false", native_installed ? "true" : "false", have, H3_MODEL_TOTAL_SIZE) &&
    json_dyn_printf(&b, "\"referencesInstalled\":%s,\"referenceDownloadedBytes\":%lld,\"referenceTotalBytes\":%lld,",
                    references_installed ? "true" : "false", reference_have, H3_REFERENCE_MODEL_TOTAL_SIZE) &&
    json_dyn_puts(&b, "\"encoder\":") && json_dyn_put_escaped(&b, encoder) &&
    json_dyn_puts(&b, ",\"diffusion\":\"official FL2VA + optional Ref2VA\",\"diffusionPrecision\":\"bf16\"") &&
    json_dyn_puts(&b, ",\"model\":\"MiniMaxAI/MiniMax-H3\",\"runtime\":\"h3.c/Metal\",") &&
    json_dyn_puts(&b, "\"engineCommit\":\"") && json_dyn_puts(&b, H3_NATIVE_COMMIT) &&
    json_dyn_puts(&b, "\",\"enginePatchSha256\":\"") && json_dyn_puts(&b, H3_PATCH_SHA256) &&
    json_dyn_puts(&b, "\",\"engineRuntimeRevision\":\"") && json_dyn_puts(&b, H3_RUNTIME_REVISION) &&
    json_dyn_puts(&b, "\",\"modelRevision\":\"") && json_dyn_puts(&b, H3_MODEL_REVISION) &&
    json_dyn_puts(&b, "\",\"dir\":") &&
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
        web_json_error(fd, "400 Bad Request", "native h3.c supports the official encoder only"); return;
    }
    int include_references = json_get_bool(body ? body : "", "references");
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
    video_write_status_path(status, "running", "queued", include_references
        ? "Preparing the MiniMax H3 Ref2VA reference weights…"
        : "Preparing the MiniMax H3 FL2VA open weights…", 1);
    char log[32768] = "";
    char *argv[10];
    int a = 0;
    argv[a++] = "/bin/sh"; argv[a++] = script;
    argv[a++] = "--setup-only";
    argv[a++] = "--status-file"; argv[a++] = status;
    argv[a++] = "--encoder"; argv[a++] = encoder;
    if (include_references) argv[a++] = "--include-references";
    argv[a] = NULL;
    int rc = setup_run_cmd_capture(NULL, argv, log, sizeof log);
    if (rc != 0) {
        json_dyn_buf b = {0};
        json_dyn_puts(&b, "{\"ok\":false,\"error\":\"MiniMax H3 setup failed\",\"log\":") &&
        json_dyn_put_escaped(&b, log) && json_dyn_puts(&b, "}");
        send_json(fd, "500 Internal Server Error", b.ptr ? b.ptr : "{\"ok\":false}");
        free(b.ptr);
        return;
    }
    send_json(fd, "200 OK", include_references
        ? "{\"ok\":true,\"model\":\"MiniMaxAI/MiniMax-H3\",\"runtime\":\"h3.c/Metal\",\"references\":true}"
        : "{\"ok\":true,\"model\":\"MiniMaxAI/MiniMax-H3\",\"runtime\":\"h3.c/Metal\",\"references\":false}");
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
        web_json_error(fd, "400 Bad Request", "native h3.c supports the official encoder only"); return;
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
    char profile[16] = "quality";
    (void)json_get_string(body, "profile", profile, sizeof profile);
    if (strcmp(profile, "preview") && strcmp(profile, "balanced") && strcmp(profile, "quality")) {
        free(prompt); web_json_error(fd, "400 Bad Request", "profile must be preview, balanced or quality"); return;
    }
    int has_first_frame = video_json_string_present(body, "image");
    int has_reference_1 = video_json_string_present(body, "referenceImage1");
    int has_reference_2 = video_json_string_present(body, "referenceImage2");
    int reference_count = has_reference_1 + has_reference_2;
    if (has_first_frame && reference_count) {
        free(prompt); web_json_error(fd, "400 Bad Request",
            "H3 frame anchors cannot be combined with ordered reference images"); return;
    }
    if (!has_reference_1 && has_reference_2) {
        free(prompt); web_json_error(fd, "400 Bad Request",
            "referenceImage2 requires referenceImage1"); return;
    }
    if (reference_count) {
        char runtime_root[DSTUDIO_PATH_MAX];
        if (!video_root_dir(runtime_root, sizeof runtime_root) ||
            !video_reference_model_installed(runtime_root)) {
            free(prompt); web_json_error(fd, "409 Conflict",
                "Ordered H3 image references require the optional Ref2VA checkpoint; prepare it in Settings > Video first");
            return;
        }
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
    if (!video_claim_job(dir)) {
        free(prompt); web_json_error(fd, "409 Conflict",
            "the requested H3 job id already exists or belongs to another DStudio server"); return;
    }
    char first_frame[DSTUDIO_PATH_MAX] = "";
    char reference_image_1[DSTUDIO_PATH_MAX] = "", reference_image_2[DSTUDIO_PATH_MAX] = "";
    char source_err[180] = "";
    if (!image_write_source(body, "image", "first-frame", 0, dir,
                                 first_frame, sizeof first_frame, source_err, sizeof source_err) ||
        !image_write_source(body, "referenceImage1", "reference-1", 0, dir,
                                 reference_image_1, sizeof reference_image_1, source_err, sizeof source_err) ||
        !image_write_source(body, "referenceImage2", "reference-2", 0, dir,
                                 reference_image_2, sizeof reference_image_2, source_err, sizeof source_err)) {
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
    video_write_status(dir, "running", "preparing", reference_count
        ? "Preparing native h3.c/Metal ordered references…"
        : "Preparing native h3.c/Metal…", 2);
    if (video_cancel_requested(dir)) {
        video_generation_cancelled(fd, dir);
        return;
    }
    resolve_web_dir();
    char script[DSTUDIO_PATH_MAX + 64], duration_s[16], cancel_path[DSTUDIO_PATH_MAX];
    snprintf(script, sizeof script, "%s/scripts/h3-generate.sh", g_web_dir);
    snprintf(duration_s, sizeof duration_s, "%ld", duration);
    if (!video_job_cancel_path(dir, cancel_path, sizeof cancel_path)) {
        video_write_status(dir, "error", "error",
                           "MiniMax H3 cancellation path is too long.", 100);
        web_json_error(fd, "500 Internal Server Error",
                       "MiniMax H3 cancellation path is too long");
        return;
    }
    char log[32768] = "";
    char *argv[30];
    int a = 0;
    argv[a++] = "/bin/sh"; argv[a++] = script;
    argv[a++] = "--prompt-file"; argv[a++] = prompt_path;
    argv[a++] = "--outdir"; argv[a++] = dir;
    argv[a++] = "--status-file"; argv[a++] = status_path;
    argv[a++] = "--duration"; argv[a++] = duration_s;
    argv[a++] = "--aspect"; argv[a++] = aspect;
    argv[a++] = "--profile"; argv[a++] = profile;
    argv[a++] = "--encoder"; argv[a++] = encoder;
    argv[a++] = "--cancel-file"; argv[a++] = cancel_path;
    if (first_frame[0]) { argv[a++] = "--first-frame"; argv[a++] = first_frame; }
    if (reference_image_1[0]) { argv[a++] = "--reference-image"; argv[a++] = reference_image_1; }
    if (reference_image_2[0]) { argv[a++] = "--reference-image"; argv[a++] = reference_image_2; }
    argv[a] = NULL;
    media_memory_lease lease = media_memory_begin("video-generation");
    if (!media_memory_ready(&lease)) {
        if (video_cancel_requested(dir)) {
            video_generation_cancelled(fd, dir);
            return;
        }
        video_write_status(dir, "error", "memory", "DS4 memory could not be released; MiniMax H3 was not started.", 100);
        web_json_error(fd, "503 Service Unavailable",
                       "DS4 memory could not be released; MiniMax H3 was not started");
        return;
    }
    if (video_cancel_requested(dir)) {
        media_memory_end(&lease);
        video_generation_cancelled(fd, dir);
        return;
    }
    int rc = setup_run_cmd_capture(NULL, argv, log, sizeof log);
    media_memory_end(&lease);
    if (video_cancel_requested(dir)) {
        video_generation_cancelled(fd, dir);
        return;
    }
    char filename[256] = "";
    if (rc != 0 || !video_find_output(dir, filename, sizeof filename)) {
        if (!video_status_has_state(status_path, "error"))
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
    /* Preserve the native worker's terminal profile, dimensions and quality
     * evidence.  A zero exit plus an MP4 is insufficient if the worker did
     * not also publish a complete, validated status. */
    if (!video_status_has_state(status_path, "complete")) {
        const char *failure = "MiniMax H3 exited without a complete terminal status.";
        video_write_status(dir, "error", "error", failure, 100);
        web_json_error(fd, "500 Internal Server Error", failure);
        return;
    }
    json_dyn_buf b = {0};
    json_dyn_puts(&b, "{\"ok\":true,\"id\":") && json_dyn_put_escaped(&b, id) &&
    json_dyn_puts(&b, ",\"filename\":") && json_dyn_put_escaped(&b, filename) &&
    json_dyn_puts(&b, ",\"model\":\"MiniMaxAI/MiniMax-H3\",\"profile\":") &&
    json_dyn_put_escaped(&b, profile) && json_dyn_printf(&b, ",\"referenceCount\":%d,\"url\":", reference_count) &&
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
    char base[DSTUDIO_PATH_MAX], pid_path[DSTUDIO_PATH_MAX];
    char dir[DSTUDIO_PATH_MAX], status_path[DSTUDIO_PATH_MAX];
    if (!video_jobs_dir(base, sizeof base)) {
        web_json_error(fd, "404 Not Found", "video job not found"); return;
    }
    snprintf(dir, sizeof dir, "%s/%s", base, id);
    if (!video_job_owned(dir)) {
        web_json_error(fd, "409 Conflict",
            "the H3 job belongs to another DStudio server");
        return;
    }
    snprintf(status_path, sizeof status_path, "%s/status.json", dir);
    if (video_status_has_state(status_path, "complete") ||
        video_status_has_state(status_path, "error") ||
        video_status_has_state(status_path, "cancelled")) {
        send_json(fd, "200 OK",
                  "{\"ok\":true,\"running\":false,\"terminal\":true}");
        return;
    }
    if (!video_request_cancel(dir)) {
        web_json_error(fd, "500 Internal Server Error",
                       "could not persist H3 cancellation request");
        return;
    }
    snprintf(pid_path, sizeof pid_path, "%s/worker.pid", dir);
    size_t n = 0;
    char *raw = jsonl_read_file(pid_path, &n);
    if (!raw) {
        video_write_status(dir, "error", "cancelled",
                           "Video generation cancelled before worker startup.", 100);
        send_json(fd, "200 OK",
                  "{\"ok\":true,\"running\":false,\"cancellationQueued\":true}");
        return;
    }
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

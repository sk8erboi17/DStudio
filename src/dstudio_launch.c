/* One pending launch, owned by the HTTP loop. Build/charter work happens in an
 * exec'd copy of this executable, never in a thread sharing host globals.
 * The worker has no authority to replace the live engine. Its result is a
 * bounded, explicit JSON message, separate from build stdout/stderr.
 * Lifetime: admission -> prepare -> revalidate -> stop old -> publish/spawn.
 * Limits: one worker group, 15 min preparation, 5 s cancellation grace,
 * 64 KiB charter, 64 KiB pipe work per tick, 2 KiB retained diagnostics.
 * This is not a cache: every attempt revalidates its dependencies and binary. */
#define LAUNCH_SYS_MAX 65536
#define LAUNCH_RESULT_MAX (6 * LAUNCH_SYS_MAX + 4096)
#define LAUNCH_PREPARE_MS (15 * 60 * 1000)
#define LAUNCH_CANCEL_MS 5000
#define LAUNCH_DEP_MAX 24

typedef struct {
    engine_cfg cfg;
    remote_start_cfg remote;
    int mode, force, dspark, hotlist, adjusted;
    char variant[16], model[1024], skill[64], design_system[64];
    char workdir[1024], engine_dir[1024], assets_dir[1024], note[384], request_id[64];
} launch_request;

typedef struct {
    char path[DSTUDIO_PATH_MAX + 1024], identity[192];
    int directory;
} launch_dependency;

typedef struct {
    launch_request request;
    launch_prepared prepared;
    unsigned long long task_id;
    pid_t worker;
    int client, output, errors, guard, killed, canceled, received, stopping;
    long long deadline;
    char *result;
    size_t result_len;
    char last_log[2048], failure[256], binary_identity[192];
    launch_dependency dependencies[LAUNCH_DEP_MAX];
    int dependency_count;
    /* Allocated only for the separately owned dense-Qwen server. Legacy
     * launches do not carry another model's process payload. */
    q36_launch_spec *q36;
    int validated, q36_started;
#ifdef _WIN32
    HANDLE worker_job;
#endif
} launch_job;
static launch_job *g_launch = NULL;
static int launch_workdir_missing(int requested_mode, const char *workdir);
static void launch_commit(launch_job *job);

static int launch_preparation_busy(void) { return g_launch != NULL; }

/* Directories identify a location, not their changing children. Files bind the
 * candidate to bytes that must not change during preparation. ctime prevents
 * accepting an in-place edit merely because its mtime was restored. */
static int launch_identity(const char *path, int directory, char *out, size_t cap) {
    struct stat s;
    if (stat(path, &s) != 0) {
        if (errno != ENOENT) return 0;
        cstr_copy(out, cap, "missing");
        return 1;
    }
    if (directory ? !S_ISDIR(s.st_mode) : !S_ISREG(s.st_mode)) return 0;
    long mn = 0, cn = 0;
#ifdef __APPLE__
    mn = s.st_mtimespec.tv_nsec; cn = s.st_ctimespec.tv_nsec;
#elif !defined(_WIN32)
    mn = s.st_mtim.tv_nsec; cn = s.st_ctim.tv_nsec;
#endif
    int n = directory
        ? snprintf(out, cap, "%llu:%llu", (unsigned long long)s.st_dev, (unsigned long long)s.st_ino)
        : snprintf(out, cap, "%llu:%llu:%lld:%lld:%ld:%lld:%ld",
                   (unsigned long long)s.st_dev, (unsigned long long)s.st_ino,
                   (long long)s.st_size, (long long)s.st_mtime, mn, (long long)s.st_ctime, cn);
    return n > 0 && (size_t)n < cap;
}

static const char *launch_binary(int mode, int pld, int q36) {
    if (q36) return "q36-server";
#ifdef _WIN32
    return mode == ENGINE_SERVER ? "ds4-server.exe" : mode == ENGINE_AGENT ? "ds4-agent-jsonl.exe"
        : mode == ENGINE_COWORK ? "ds4-cowork.exe" : "ds4-design.exe";
#else
    return mode == ENGINE_SERVER ? (pld > 0 ? "ds4-server-pld" : "ds4-server")
        : mode == ENGINE_AGENT ? "ds4-agent-jsonl" : mode == ENGINE_COWORK ? "ds4-cowork" : "ds4-design";
#endif
}

static int launch_add_dependency(launch_job *j, const char *root, const char *rel, int directory) {
    if (j->dependency_count >= LAUNCH_DEP_MAX) return 0;
    launch_dependency *d = &j->dependencies[j->dependency_count];
    int n = snprintf(d->path, sizeof d->path, "%s%s%s", root, rel && rel[0] ? "/" : "", rel ? rel : "");
    d->directory = directory;
    if (n < 0 || (size_t)n >= sizeof d->path || !launch_identity(d->path, directory, d->identity, sizeof d->identity)) return 0;
    if (j->q36 && rel && !strcmp(root, j->request.engine_dir)) {
        if (!strcmp(rel, j->request.model))
            cstr_copy(j->q36->model_identity, sizeof j->q36->model_identity, d->identity);
        if (!strcmp(rel, MODEL_QWEN27_VISION))
            cstr_copy(j->q36->vision_identity, sizeof j->q36->vision_identity, d->identity);
    }
    j->dependency_count++;
    return 1;
}

static void launch_result_error(launch_job *j, const char *code, const char *message) {
    if (j->client < 0) return;
    char escaped[600], out[900];
    json_escape_into(escaped, sizeof escaped, message, strlen(message));
    snprintf(out, sizeof out, "{\"ok\":false,\"taskId\":%llu,\"code\":\"%s\",\"error\":\"%s\"}", j->task_id, code, escaped);
    send_json(j->client, "409 Conflict", out);
    close(j->client); j->client = -1;
}

static void launch_worker_kill(launch_job *j) {
    if (j->worker <= 0 || j->killed) return;
    /* The direct child has not been reaped: its PID still pins the group ID. */
#ifdef _WIN32
    if (j->worker_job) TerminateJobObject(j->worker_job, 1);
    else kill(j->worker, SIGKILL);
#else
    kill(-j->worker, SIGKILL);
#endif
    j->killed = 1;
}

static void launch_dispose(launch_job *j) {
    if (g_active_launch_task == j->task_id) {
        dstudio_task *task = task_find(j->task_id);
        if (!task || task_status_terminal(task->status)) {
            g_active_launch_task = 0;
            g_active_launch_mode = ENGINE_NONE;
        }
    }
    if (j->client >= 0) close(j->client);
    if (j->output >= 0) close(j->output);
    if (j->errors >= 0) close(j->errors);
    if (j->guard >= 0) close(j->guard);
#ifdef _WIN32
    if (j->worker_job) CloseHandle(j->worker_job);
#endif
    free(j->result); free(j->prepared.skill_sys); free(j->q36);
    /* Credentials never cross the preparation process boundary or its logs. */
    memset(&j->request.remote, 0, sizeof j->request.remote);
    free(j); g_launch = NULL;
}

static void launch_cancel(const char *reason) {
    launch_job *j = g_launch;
    if (!j || j->canceled) return;
    j->canceled = 1;
    if (j->q36_started && g_q36.launch_task == j->task_id)
        q36_request_stop(reason);
    cstr_copy(j->failure, sizeof j->failure, reason);
    task_mark_canceled(j->task_id, reason);
    launch_result_error(j, "launch_canceled", reason);
    j->deadline = dstudio_now_ms() + LAUNCH_CANCEL_MS;
    /* EOF asks the worker to interrupt its complete process group and finish
     * its existing source-restore path. The owner never waits for that cleanup. */
    if (j->guard >= 0) { close(j->guard); j->guard = -1; }
#ifdef _WIN32
    launch_worker_kill(j);
#endif
}

#ifndef _WIN32
static void launch_worker_term(int sig) { (void)sig; g_launch_worker_cancel = 1; }
static void *launch_worker_guard(void *unused) {
    (void)unused;
    char byte;
    ssize_t n;
    do { n = read(STDIN_FILENO, &byte, 1); } while (n < 0 && errno == EINTR);
    /* This helper is a fresh process-group leader. The guard also covers a
     * crashed/killed host; no inherited app sockets keep it alive. */
    kill(-getpid(), SIGTERM);
    for (int i = 0; i < 50; i++) usleep(100000);
    kill(-getpid(), SIGKILL);
    return NULL;
}
#endif

static int launch_prepare_cli(int argc, char **argv) {
    if (argc != 12) return 2;
    int mode = !strcmp(argv[2], "server") ? ENGINE_SERVER : !strcmp(argv[2], "agent") ? ENGINE_AGENT
        : !strcmp(argv[2], "cowork") ? ENGINE_COWORK : !strcmp(argv[2], "design") ? ENGINE_DESIGN : ENGINE_NONE;
    if (!mode || strlen(argv[3]) >= sizeof g_ds4_dir || strlen(argv[4]) >= sizeof g_web_dir ||
        strlen(argv[5]) >= sizeof g_model_override || strlen(argv[6]) >= sizeof g_skill ||
        strlen(argv[7]) >= sizeof g_design_system) return 2;
    cstr_copy(g_ds4_dir, sizeof g_ds4_dir, argv[3]);
    cstr_copy(g_web_dir, sizeof g_web_dir, argv[4]);
    cstr_copy(g_model_override, sizeof g_model_override, argv[5]);
    cstr_copy(g_skill, sizeof g_skill, argv[6]);
    cstr_copy(g_design_system, sizeof g_design_system, argv[7]);
    if (!strcmp(argv[8], "remote")) cstr_copy(g_remote_base_url, sizeof g_remote_base_url, "prepare-only");
    int result_fd;
#ifdef _WIN32
    result_fd = _dup(_fileno(stdout));
    if (result_fd < 0 || _dup2(_fileno(stderr), _fileno(stdout))) return 2;
#else
    if (getpgrp() != getpid()) return 2;
    struct sigaction action = {0}; action.sa_handler = launch_worker_term;
    sigaction(SIGTERM, &action, NULL); sigaction(SIGINT, &action, NULL);
    signal(SIGPIPE, SIG_IGN);
    result_fd = dup(STDOUT_FILENO);
    if (result_fd < 0 || dup2(STDERR_FILENO, STDOUT_FILENO) < 0) return 2;
    fcntl(result_fd, F_SETFD, FD_CLOEXEC);
    pthread_t guard;
    if (pthread_create(&guard, NULL, launch_worker_guard, NULL) != 0) return 2;
    pthread_detach(guard);
#endif
    char error[256] = "", identity[192] = "", binary[DSTUDIO_PATH_MAX + 64];
    char agent_directory[1024] = "", agent_identity[192] = "";
    int ok = 1, pld = -1;
    const int q36 = !g_remote_base_url[0] && model_file_is_qwen27(current_model_rel());
    /* Explicit force may release an external port only when the admitting
     * owner had no engine child. Never kill the still-running previous model. */
    if (!strcmp(argv[10], "release-external")) {
        char *end = NULL; long port = strtol(argv[11], &end, 10);
        ok = end && !*end && port >= 1024 && port <= 65535 &&
            ((mode == ENGINE_SERVER && ds4_server_compatible((int)port)) || kill_external_server((int)port));
    }
    if (g_launch_worker_cancel) ok = 0;
    if (ok && q36) {
            char root[1024], target[1024]; int downloaded = 0;
            cstr_copy(root, sizeof root, g_ds4_dir);
            char *slash = strrchr(root, '/');
            if (!slash || slash == root || strcmp(slash + 1, Q36_DIR_NAME)) ok = 0;
            else {
                *slash = '\0';
                ok = setup_install_engine("q36", root, target, sizeof target, &downloaded, error, sizeof error) &&
                    !strcmp(target, g_ds4_dir);
            }
            if (ok && MODE_IS_PIPED(mode)) {
                ok = q36_agent_directory(g_ds4_dir, agent_directory, sizeof agent_directory);
                if (ok && !ds4_dir_valid_path(agent_directory))
                    ok = setup_install_engine("main", root, target, sizeof target, &downloaded, error, sizeof error) &&
                        !strcmp(target, agent_directory);
                if (ok) {
                    /* Only this private worker changes its build checkout.
                     * The host selection remains q36, and this binary will
                     * use RPC rather than opening a second model. */
                    cstr_copy(g_ds4_dir, sizeof g_ds4_dir, agent_directory);
                    cstr_copy(g_remote_base_url, sizeof g_remote_base_url, "prepare-only");
                    ok = run_build_jsonl("build");
                    snprintf(binary, sizeof binary, "%s/%s", agent_directory, launch_binary(mode, -1, 0));
                    if (ok) ok = !access(binary, X_OK) && launch_identity(binary, 0, agent_identity, sizeof agent_identity);
                    cstr_copy(g_ds4_dir, sizeof g_ds4_dir, argv[3]);
                    /* Remote-only compilation does not change the selected
                     * local model's capabilities. Restore this private worker
                     * before it builds the charter from the captured files. */
                    g_remote_base_url[0] = '\0';
                }
            }
            if (ok) {
                char kv[DSTUDIO_PATH_MAX]; kv_dir_for_model(current_model_rel(), kv, sizeof kv); mkpath(kv);
            }
    } else if (ok && mode == ENGINE_SERVER) {
#ifndef _WIN32
        ok = setup_ensure_server_metrics_runtime(error, sizeof error);
        if (ok && !g_launch_worker_cancel) { pld = run_build_server_pld(); ok = pld != 0; }
#else
        win_prepare_engine_runtime();
        ok = file_present("ds4-server.exe");
#endif
        if (ok && !model_is_qwen35()) {
            char kv[DSTUDIO_PATH_MAX]; kv_dir_for_model(current_model_rel(), kv, sizeof kv); mkpath(kv);
        }
    } else if (ok && mode == ENGINE_DESIGN) {
#ifdef _WIN32
        win_prepare_engine_runtime(); ok = file_present("ds4-design.exe");
#else
        ok = run_ext_script("scripts/apply-ds4-glm53-m2max.sh", "apply") && !g_launch_worker_cancel &&
             run_ext_script("scripts/apply-ds4-vision-streaming.sh", "apply") && !g_launch_worker_cancel &&
             run_ext_script("extension/design/build-design.sh", "build");
#endif
    } else if (ok) ok = run_build_jsonl("build");
    if (g_launch_worker_cancel) ok = 0;
    /* The owned q36 tool runtime is built with remote-only compilation, but
     * its admitted protocol remains structured. Do not derive prompt schemas
     * from the worker's temporary "prepare-only" build setting. */
    char *sys = ok && MODE_IS_PIPED(mode) ? build_piped_skill_sys(mode, q36) : NULL;
    if (sys && strlen(sys) > LAUNCH_SYS_MAX) { cstr_copy(error, sizeof error, "launch charter exceeds 64 KiB"); ok = 0; }
    snprintf(binary, sizeof binary, "%s/%s", g_ds4_dir, launch_binary(mode, pld, q36));
    if (ok && (access(binary, X_OK) || !launch_identity(binary, 0, identity, sizeof identity))) ok = 0;
    if (!ok && !error[0]) cstr_copy(error, sizeof error, g_launch_worker_cancel ? "Preparation canceled" : "Runtime preparation failed; see the launcher build log");
    json_dyn_buf result = {0};
    json_dyn_printf(&result, "{\"v\":1,\"task\":\"%s\",\"ok\":%s,\"pld\":%d,\"identity\":", argv[9], ok ? "true" : "false", pld);
    json_dyn_put_escaped(&result, identity);
    json_dyn_puts(&result, ",\"agentIdentity\":"); json_dyn_put_escaped(&result, agent_identity);
    json_dyn_puts(&result, ",\"error\":"); json_dyn_put_escaped(&result, error);
    json_dyn_puts(&result, ",\"sys\":"); json_dyn_put_escaped(&result, ok && sys ? sys : "");
    json_dyn_puts(&result, "}\n"); free(sys);
    if (result.ptr && result.len < LAUNCH_RESULT_MAX) {
        size_t sent = 0;
        while (sent < result.len) {
#ifdef _WIN32
            int n = _write(result_fd, result.ptr + sent, (unsigned int)(result.len - sent));
#else
            ssize_t n = write(result_fd, result.ptr + sent, result.len - sent);
#endif
            if (n < 0 && errno == EINTR) continue;
            if (n <= 0) break;
            sent += (size_t)n;
        }
    }
    free(result.ptr);
    /* Keep the direct child alive until the owner has killed/reaped the group.
     * A successful script cannot leave a daemon behind or race PID reuse. */
    for (;;) {
#ifdef _WIN32
        Sleep(1000);
#else
        pause();
#endif
    }
}

static int launch_worker_spawn(launch_job *j, char *error, size_t cap) {
    char task[32], port[16]; snprintf(task, sizeof task, "%llu", j->task_id);
    snprintf(port, sizeof port, "%d", ENGINE_DEFAULTS.port);
    launch_request *r = &j->request;
    char *args[] = { g_launch_executable, "--prepare-launch", (char *)mode_name(r->mode), r->engine_dir,
        r->assets_dir, r->model, r->skill, r->design_system, r->remote.base_url[0] ? "remote" : "local", task,
        r->force && g_child <= 0 && !q36_running() && !j->q36 && !r->remote.base_url[0]
            ? "release-external" : "keep-external", port, NULL };
#ifdef _WIN32
    /* Suspended creation prevents a child escaping the owned job before the
     * kill-on-close boundary is attached. No user runtime joins this job. */
    SECURITY_ATTRIBUTES sa = { sizeof sa, NULL, TRUE };
    HANDLE input_r = NULL, input_w = NULL, output_r = NULL, output_w = NULL, error_r = NULL, error_w = NULL;
    HANDLE job = CreateJobObjectA(NULL, NULL);
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = {0}; limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if (!job || !SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof limits) ||
        !CreatePipe(&input_r, &input_w, &sa, 0) || !CreatePipe(&output_r, &output_w, &sa, 0) || !CreatePipe(&error_r, &error_w, &sa, 0)) goto win_fail;
    SetHandleInformation(input_w, HANDLE_FLAG_INHERIT, 0);
    SetHandleInformation(output_r, HANDLE_FLAG_INHERIT, 0); SetHandleInformation(error_r, HANDLE_FLAG_INHERIT, 0);
    STARTUPINFOA si = {0}; PROCESS_INFORMATION pi = {0};
    si.cb = sizeof si; si.dwFlags = STARTF_USESTDHANDLES;
    si.hStdInput = input_r; si.hStdOutput = output_w; si.hStdError = error_w;
    char cmd[32768] = ""; for (int i = 0; args[i]; i++) win_arg_append(cmd, sizeof cmd, args[i]);
    if (!CreateProcessA(NULL, cmd, NULL, NULL, TRUE, CREATE_SUSPENDED | CREATE_NO_WINDOW, NULL, r->engine_dir, &si, &pi)) goto win_fail;
    if (!AssignProcessToJobObject(job, pi.hProcess)) {
        TerminateProcess(pi.hProcess, 1); CloseHandle(pi.hThread); CloseHandle(pi.hProcess); goto win_fail;
    }
    ResumeThread(pi.hThread); CloseHandle(pi.hThread);
    CloseHandle(input_r); CloseHandle(output_w); CloseHandle(error_w);
    j->guard = (int)(intptr_t)input_w; j->output = (int)(intptr_t)output_r; j->errors = (int)(intptr_t)error_r;
    j->worker = (pid_t)pi.hProcess; j->worker_job = job; return 1;
win_fail:
    if (job) CloseHandle(job);
    if (input_r) CloseHandle(input_r); if (input_w) CloseHandle(input_w);
    if (output_r) CloseHandle(output_r); if (output_w) CloseHandle(output_w);
    if (error_r) CloseHandle(error_r); if (error_w) CloseHandle(error_w);
    snprintf(error, cap, "Could not create the preparation worker (Windows %lu)", GetLastError()); return 0;
#else
    int input[2] = {-1,-1}, output[2] = {-1,-1}, errors[2] = {-1,-1};
    if (pipe(input) || pipe(output) || pipe(errors)) goto fail;
    long maxfd = sysconf(_SC_OPEN_MAX);
    if (maxfd < 0) maxfd = 1024;
    pid_t pid = fork();
    if (pid < 0) goto fail;
    if (!pid) {
        if (setpgid(0, 0) || dup2(input[0], STDIN_FILENO) < 0 ||
            dup2(output[1], STDOUT_FILENO) < 0 || dup2(errors[1], STDERR_FILENO) < 0) _exit(127);
        /* async-signal-safe operations only between fork and exec. */
        for (int fd = 3; fd < maxfd; fd++) close(fd);
        execv(args[0], args); _exit(127);
    }
    (void)setpgid(pid, pid);
    close(input[0]); close(output[1]); close(errors[1]);
    j->worker = pid; j->guard = input[1]; j->output = output[0]; j->errors = errors[0];
    fcntl(j->guard, F_SETFD, FD_CLOEXEC); fcntl(j->output, F_SETFD, FD_CLOEXEC); fcntl(j->errors, F_SETFD, FD_CLOEXEC);
    set_nonblock(j->output); set_nonblock(j->errors);
    return 1;
fail:
    for (int i = 0; i < 2; i++) { if (input[i] >= 0) close(input[i]); if (output[i] >= 0) close(output[i]); if (errors[i] >= 0) close(errors[i]); }
    snprintf(error, cap, "Could not create the preparation worker: %s", strerror(errno)); return 0;
#endif
}

static int launch_request_current(const launch_job *j) {
    const launch_request *r = &j->request;
    dstudio_task *task = task_find(j->task_id);
    return task && !task_status_terminal(task->status) &&
        !strcmp(g_ds4_dir, r->engine_dir) && !strcmp(g_web_dir, r->assets_dir);
}

static int launch_revalidate(launch_job *j) {
    launch_request *r = &j->request;
    if (!launch_request_current(j)) return 0;
    for (int i = 0; i < j->dependency_count; i++) {
        launch_dependency *d = &j->dependencies[i]; char current[192];
        if (!launch_identity(d->path, d->directory, current, sizeof current) || strcmp(d->identity, current)) return 0;
    }
    char binary[DSTUDIO_PATH_MAX + 64], current[192], error[256];
    snprintf(binary, sizeof binary, "%s/%s", r->engine_dir, launch_binary(r->mode, j->prepared.server_pld, j->q36 != NULL));
    if (access(binary, X_OK) || !launch_identity(binary, 0, current, sizeof current) || strcmp(current, j->binary_identity)) return 0;
    if (j->q36 && MODE_IS_PIPED(r->mode)) {
        snprintf(binary, sizeof binary, "%s/%s", j->q36->agent_dir, launch_binary(r->mode, -1, 0));
        if (!j->q36->agent_identity[0] || access(binary, X_OK) ||
            !launch_identity(binary, 0, current, sizeof current) || strcmp(current, j->q36->agent_identity)) return 0;
    }
    return !launch_workdir_missing(r->mode, r->workdir) &&
        !native_launch_preflight(&r->cfg, r->mode, r->model, r->remote.base_url[0] != '\0', r->dspark, error, sizeof error);
}

static void launch_begin(int fd, const launch_request *request, unsigned long long resume_task) {
    if (g_launch || g_child_stop_requested || (q36_running() && g_q36.stopping)) {
        send_json(fd, "409 Conflict", "{\"ok\":false,\"code\":\"launch_busy\",\"error\":\"An engine transition is already in progress. Wait or cancel it first.\"}"); return;
    }
    launch_job *j = calloc(1, sizeof *j);
    if (!j) { send_json(fd, "503 Service Unavailable", "{\"ok\":false,\"error\":\"Cannot allocate a launch candidate\"}"); return; }
    j->client = -1; j->guard = j->output = j->errors = -1; j->worker = -1;
    j->request = *request;
    j->result = malloc(LAUNCH_RESULT_MAX);
    int q36 = !request->remote.base_url[0] && model_file_is_qwen27(request->model);
    if (q36) {
        j->q36 = calloc(1, sizeof *j->q36);
        if (j->q36) {
            j->q36->cfg = request->cfg;
            cstr_copy(j->q36->directory, sizeof j->q36->directory, request->engine_dir);
            cstr_copy(j->q36->model, sizeof j->q36->model, request->model);
            cstr_copy(j->q36->vision, sizeof j->q36->vision, MODEL_QWEN27_VISION);
            if (request->cfg.kv_space_mb > 0)
                kv_dir_for_model(request->model, j->q36->kv_dir, sizeof j->q36->kv_dir);
        }
    }
    int ok = j->result && (!q36 || j->q36) && launch_add_dependency(j, request->engine_dir, "", 1) && launch_add_dependency(j, request->assets_dir, "", 1);
    if (ok && q36 && MODE_IS_PIPED(request->mode)) {
        ok = q36_agent_directory(request->engine_dir, j->q36->agent_dir, sizeof j->q36->agent_dir) &&
            launch_add_dependency(j, j->q36->agent_dir, "", 1);
        j->prepared.runtime_dir = j->q36->agent_dir;
    }
    if (ok && request->workdir[0]) ok = launch_add_dependency(j, request->workdir, "", 1);
    if (ok) ok = launch_add_dependency(j, g_launch_executable, "", 0);
    if (ok && !request->remote.base_url[0]) ok = launch_add_dependency(j, request->engine_dir, request->model, 0);
    if (ok && !request->remote.base_url[0]) {
        const char *vision = native_vision_encoder_rel_for_model(request->model);
        if (vision) ok = launch_add_dependency(j, request->engine_dir, vision, 0);
        if (ok && request->dspark) ok = launch_add_dependency(j, request->engine_dir, dspark_rel_for_model(request->model), 0);
        if (ok && model_file_is_qwen38(request->model)) ok = launch_add_dependency(j, request->engine_dir, MODEL_QWEN_PLE, 0);
    }
    if (ok) ok = launch_add_dependency(j, request->assets_dir, "extension/cowork/COWORK.md", 0);
    if (ok && request->skill[0]) {
        char dir[1100], rel[96]; user_skills_dir(dir, sizeof dir);
        snprintf(rel, sizeof rel, "%s/SKILL.md", request->skill);
        ok = launch_add_dependency(j, dir, rel, 0);
    }
    const char *scripts[] = {"scripts/apply-ds4-glm53-m2max.sh", "scripts/apply-ds4-vision-streaming.sh", "scripts/apply-ds4-server-metrics.sh", "scripts/apply-ds4-qwen38-prepare.sh", "extension/design/build-design.sh", NULL};
    for (int i = 0; ok && scripts[i]; i++) ok = launch_add_dependency(j, request->assets_dir, scripts[i], 0);
    if (q36) {
        const char *inputs[] = {"scripts/install-q36.py", "scripts/apply-q36-metal-runtime.sh", "patch/q36-metal-runtime/next-review.patch",
                               "scripts/apply-q36-agent-tty.sh", "patch/q36-agent-tty/monitor.patch", "patch/q36-agent-tty/monitor-owner.patch", NULL};
        for (int i = 0; ok && inputs[i]; i++) ok = launch_add_dependency(j, request->assets_dir, inputs[i], 0);
        if (ok) ok = launch_add_dependency(j, request->engine_dir, ".dstudio-source.json", 0);
    }
    if (ok && request->mode == ENGINE_DESIGN && request->design_system[0]) {
        const char *files[] = {"DESIGN.md", "tokens.css", "components.html", "assets/preview.js", "references/recipes.md", NULL};
        for (int i = 0; ok && files[i]; i++) {
            char rel[256]; snprintf(rel, sizeof rel, "extension/design-systems/%s/%s", request->design_system, files[i]);
            ok = launch_add_dependency(j, request->assets_dir, rel, 0);
        }
    }
    if (!ok || !g_launch_executable[0]) {
        launch_dispose(j); send_json(fd, "409 Conflict", "{\"ok\":false,\"error\":\"Could not capture the launch dependencies\"}"); return;
    }
    char title[96]; snprintf(title, sizeof title, "Prepare %s", mode_name(request->mode));
    j->task_id = resume_task ? resume_task : task_begin("launch", title, mode_name(request->mode), request->mode, request->workdir, 0, 1);
    char error[256];
    if (!launch_worker_spawn(j, error, sizeof error)) {
        task_mark_failed(j->task_id, error, "preparation process creation failed");
        j->client = fd; launch_result_error(j, "launch_prepare_failed", error); launch_dispose(j);
        g_launch_adopt = fd >= 0; return;
    }
    j->client = fd; j->deadline = dstudio_now_ms() + LAUNCH_PREPARE_MS;
    g_launch = j; g_launch_adopt = fd >= 0;
    task_mark_working(j->task_id, "Preparing runtime; current engine is unchanged");
}

static int launch_resume_saved_server(void) {
    if (g_launch) return 1;
    launch_request r = {0}; r.cfg = g_cfg; r.mode = ENGINE_SERVER;
    r.dspark = g_dspark_enabled; r.hotlist = g_metal_hotlist_seed;
    cstr_copy(r.variant, sizeof r.variant, g_variant);
    cstr_copy(r.model, sizeof r.model, current_model_rel());
    cstr_copy(r.skill, sizeof r.skill, g_skill);
    cstr_copy(r.design_system, sizeof r.design_system, g_design_system);
    cstr_copy(r.engine_dir, sizeof r.engine_dir, g_ds4_dir);
    cstr_copy(r.assets_dir, sizeof r.assets_dir, g_web_dir);
    launch_begin(-1, &r, g_active_launch_task);
    return g_launch != NULL;
}

static void launch_preparation_tick(void) {
    launch_job *j = g_launch;
    if (!j) return;
    if (j->worker > 0 && !j->killed) {
        char chunk[4096];
        for (size_t bytes = 0; bytes < 65536;) {
            ssize_t n = read(j->errors, chunk, sizeof chunk);
            if (n <= 0) break;
            bytes += (size_t)n;
            size_t keep = (size_t)n < sizeof j->last_log - 1 ? (size_t)n : sizeof j->last_log - 1;
            memcpy(j->last_log, chunk + n - keep, keep); j->last_log[keep] = '\0';
        }
        for (size_t bytes = 0; bytes < 65536 && !j->received;) {
            ssize_t n = read(j->output, chunk, sizeof chunk);
            if (n < 0) break;
            if (!n) { cstr_copy(j->failure, sizeof j->failure, "Preparation worker exited without a complete result"); launch_worker_kill(j); break; }
            bytes += (size_t)n;
            if (j->result_len + (size_t)n >= LAUNCH_RESULT_MAX) {
                cstr_copy(j->failure, sizeof j->failure, "Preparation result exceeded its byte limit"); launch_worker_kill(j); break;
            }
            memcpy(j->result + j->result_len, chunk, (size_t)n); j->result_len += (size_t)n; j->result[j->result_len] = '\0';
            if (memchr(j->result, '\n', j->result_len)) {
                char task[32], expected[32]; long version = 0, pld = 0;
                snprintf(expected, sizeof expected, "%llu", j->task_id);
                int valid = json_get_int(j->result, "v", 1, 1, &version) > 0 && json_get_string(j->result, "task", task, sizeof task) && !strcmp(task, expected);
                if (!valid || !json_get_bool(j->result, "ok")) {
                    if (!valid || !json_get_string(j->result, "error", j->failure, sizeof j->failure))
                        cstr_copy(j->failure, sizeof j->failure, "Invalid preparation result");
                } else if (json_get_int(j->result, "pld", -1, 1, &pld) <= 0 || !pld ||
                           !json_get_string(j->result, "identity", j->binary_identity, sizeof j->binary_identity)) {
                    cstr_copy(j->failure, sizeof j->failure, "Preparation did not identify its executable");
                } else {
                    j->prepared.server_pld = (int)pld;
                    if (MODE_IS_PIPED(j->request.mode)) {
                        j->prepared.skill_sys = malloc(LAUNCH_SYS_MAX + 1);
                        if (!j->prepared.skill_sys || !json_get_string(j->result, "sys", j->prepared.skill_sys, LAUNCH_SYS_MAX + 1))
                            cstr_copy(j->failure, sizeof j->failure, "Invalid prepared charter");
                        if (j->q36 && !json_get_string(j->result, "agentIdentity", j->q36->agent_identity, sizeof j->q36->agent_identity))
                            cstr_copy(j->failure, sizeof j->failure, "Preparation did not identify the DStudio tool runtime");
                    }
                }
                j->received = 1; launch_worker_kill(j);
            }
        }
        if (dstudio_now_ms() >= j->deadline) {
            if (!j->canceled) launch_cancel("Runtime preparation exceeded its deadline");
            else { cstr_copy(j->failure, sizeof j->failure, "Preparation cancellation required forced termination; source recovery may be needed"); launch_worker_kill(j); }
        }
    }
    if (j->worker > 0 && j->killed) {
        int status; pid_t done = waitpid(j->worker, &status, WNOHANG);
        if (done != j->worker && !(done < 0 && errno == ECHILD)) return;
        j->worker = -1;
        if (j->guard >= 0) { close(j->guard); j->guard = -1; }
    }
    if (j->worker > 0) return;
    if (j->q36_started && (!q36_running() || g_q36.stopping)) {
        if (!j->failure[0]) cstr_copy(j->failure, sizeof j->failure,
            g_q36.error[0] ? g_q36.error : "The owned Qwen server stopped before launch completed");
    }
    if (j->canceled || j->failure[0] || !j->received) {
        if (j->q36_started && g_q36.launch_task == j->task_id) q36_request_stop("Launch failed or canceled");
        if (!j->canceled) {
            task_mark_failed(j->task_id, j->failure, j->last_log);
            launch_result_error(j, "launch_prepare_failed", j->failure[0] ? j->failure : "Preparation failed");
        }
        if (g_active_launch_task == j->task_id) {
            g_active_launch_task = 0; g_active_launch_mode = ENGINE_NONE;
            if (g_child <= 0) {
                cstr_copy(g_engine_err, sizeof g_engine_err, j->failure);
                cstr_copy(g_stage, sizeof g_stage, "Runtime preparation failed");
            }
        }
        launch_dispose(j); return;
    }
    /* Do not rescan files on every loading/teardown tick. The request remains
     * owner-validated throughout; dependency validation runs at the handoffs. */
    if (!launch_request_current(j) || (!j->validated && !launch_revalidate(j))) {
        task_mark_failed(j->task_id, "Launch dependencies changed during preparation", "stale candidate rejected");
        launch_result_error(j, "launch_stale", "The model, workspace, runtime or style changed during preparation. Retry with the current selection.");
        if (j->q36_started && g_q36.launch_task == j->task_id) q36_request_stop("Stale launch rejected");
        launch_dispose(j); return;
    }
    j->validated = 1;
    if (g_child > 0) {
        if (!j->stopping) {
            j->stopping = 1;
            task_mark_working(j->task_id, "Runtime prepared; stopping the previous engine");
            request_child_stop();
        }
        return;
    }
    if (j->q36) cstr_copy(j->q36->binary_identity, sizeof j->q36->binary_identity, j->binary_identity);
    if (q36_running() && (!j->q36 || (!j->q36_started && !q36_same_launch(j->q36)))) {
        q36_request_stop("Switching the selected model or configuration");
        return;
    }
    if (j->q36 && !j->q36_started && !q36_running()) {
        if (!launch_revalidate(j)) {
            cstr_copy(j->failure, sizeof j->failure, "Launch dependencies changed while stopping the previous engine");
            return;
        }
        if (!q36_start_owned(j->q36, j->task_id, j->failure, sizeof j->failure)) return;
        j->q36_started = 1;
        dstudio_task *task = task_find(j->task_id);
        if (task) task->pid = (int)g_q36.pid;
        task_mark_working(j->task_id, "Loading Qwen27B; waiting for the owned engine's readiness receipt");
        return;
    }
    if (j->q36 && !q36_ready()) return;
    if (!launch_revalidate(j)) {
        cstr_copy(j->failure, sizeof j->failure, "Launch dependencies changed before publication");
        return;
    }
    launch_commit(j);
    launch_dispose(j);
}

static void launch_preparation_shutdown(void) {
    if (!g_launch) return;
    launch_cancel("DStudio closed during launch preparation");
    long long deadline = dstudio_now_ms() + LAUNCH_CANCEL_MS + 1000;
    while (g_launch && dstudio_now_ms() < deadline) { launch_preparation_tick(); usleep(10000); }
    if (g_launch) { launch_worker_kill(g_launch); launch_dispose(g_launch); }
}

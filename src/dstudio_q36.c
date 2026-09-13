/* One separately owned dense-Qwen inference process. The HTTP owner alone
 * changes this record; a lightweight Agent must never take over this PID.
 * No weights/KV live here. Launch preparation supplies file identities, and
 * native readiness describes the files actually opened by the child.
 * Bounds: one process, 1536-byte receipt, 256-byte diagnostic tail, 64 KiB per
 * stream/tick, 120 s loading and 4 s parent-side teardown. No log is readiness.
 * This is process ownership, not a reusable endpoint/session cache. */
#include "../extension/remote/dstudio_json_tokens.h"

typedef struct {
    engine_cfg cfg;
    char directory[1024], model[1024], vision[1024], kv_dir[DSTUDIO_PATH_MAX];
    char binary_identity[192], model_identity[192], vision_identity[192];
    /* Optional lightweight DStudio tools, built from the primary checkout.
     * Their identity is not part of the resident weights/session identity. */
    char agent_dir[1024], agent_identity[192];
} q36_launch_spec;

typedef struct {
    q36_launch_spec spec;
    pid_t pid, frontend;
    int owner, output, errors, ready, stopping, killed;
    unsigned long long launch_task;
    long long deadline;
    size_t received;
    char receipt[1536], last_log[256], error[256];
} q36_owned_runtime;
static q36_owned_runtime g_q36 = {.pid = -1, .owner = -1, .output = -1, .errors = -1};

#ifndef _WIN32
/* Cold, child-private executable identity parsed before fork. No allocator or
 * stdio operation is needed between fork and exec to revalidate publication. */
typedef struct {
    unsigned long long device, inode;
    long long size, modified, changed;
    long modified_ns, changed_ns;
} q36_exec_identity;

static int q36_exec_identity_parse(const char *text, q36_exec_identity *out) {
    char extra;
    return sscanf(text, "%llu:%llu:%lld:%lld:%ld:%lld:%ld%c", &out->device, &out->inode,
        &out->size, &out->modified, &out->modified_ns, &out->changed, &out->changed_ns, &extra) == 7 &&
        out->size >= 0 && out->modified_ns >= 0 && out->modified_ns < 1000000000 &&
        out->changed_ns >= 0 && out->changed_ns < 1000000000;
}

static int q36_exec_identity_matches(const q36_exec_identity *expected, const struct stat *actual) {
#ifdef __APPLE__
    long mn = actual->st_mtimespec.tv_nsec, cn = actual->st_ctimespec.tv_nsec;
#else
    long mn = actual->st_mtim.tv_nsec, cn = actual->st_ctim.tv_nsec;
#endif
    return S_ISREG(actual->st_mode) && expected->device == (unsigned long long)actual->st_dev &&
        expected->inode == (unsigned long long)actual->st_ino && expected->size == (long long)actual->st_size &&
        expected->modified == (long long)actual->st_mtime && expected->modified_ns == mn &&
        expected->changed == (long long)actual->st_ctime && expected->changed_ns == cn;
}

static void q36_exec_installation_lease(const char *root, const char *binary, const q36_exec_identity *expected) {
    /* Executed ONLY in the new inference child, never the HTTP owner. This is
     * a non-waiting installation-use lease, not a shared application-state
     * mutex: readers may verify/reuse this engine, replacement needs exclusive
     * admission. Keep fd4 through exec and native drain. The host and its relay
     * children never own a copy, so neither host death nor Stop releases it
     * before the real engine exits. The pinned q36 server does not exec/fork
     * production subprocesses; review that lifetime when updating the pin. */
    int directory = open(root, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    int lease = directory < 0 ? -1 : openat(directory, ".dstudio-q36-install.lock",
        O_RDWR | O_CREAT | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC, 0600);
    struct stat held, named, parent, current_parent, executable;
    static const char invalid[] = "Qwen installation lease or executable changed; launch rejected\n";
    static const char busy[] = "Qwen installation is being updated; retry after the update finishes\n";
    if (lease < 0 || fstat(lease, &held) || !S_ISREG(held.st_mode) || held.st_nlink != 1 ||
        held.st_uid != geteuid() || (held.st_mode & (S_IWGRP | S_IWOTH))) goto invalid;
    if (flock(lease, LOCK_SH | LOCK_NB)) {
        (void)write(2, busy, sizeof busy - 1); _exit(125);
    }
    if (fstatat(directory, ".dstudio-q36-install.lock", &named, AT_SYMLINK_NOFOLLOW) ||
        held.st_dev != named.st_dev || held.st_ino != named.st_ino || named.st_nlink != 1 ||
        fstat(directory, &parent) || lstat(root, &current_parent) || !S_ISDIR(current_parent.st_mode) ||
        parent.st_dev != current_parent.st_dev || parent.st_ino != current_parent.st_ino ||
        lstat(binary, &executable) || !q36_exec_identity_matches(expected, &executable)) goto invalid;
    close(directory);
    if (dup2(lease, 4) < 0 || fcntl(4, F_SETFD, 0)) goto invalid;
    if (lease != 4) close(lease);
    return;
invalid:
    (void)write(2, invalid, sizeof invalid - 1); _exit(126);
}

static int q36_fork_guard_installed;
static void q36_after_fork_child(void) {
    /* CLOEXEC alone is insufficient: PDF/catalog/proxy workers may fork and
     * keep running without exec. Their copied endpoints must not keep the
     * model alive after its actual owner dies. Only async-signal-safe closes
     * and private child-state changes are permitted in this callback. */
    if (g_q36.owner >= 0) close(g_q36.owner);
    if (g_q36.output >= 0) close(g_q36.output);
    if (g_q36.errors >= 0) close(g_q36.errors);
    g_q36.owner = g_q36.output = g_q36.errors = -1;
    g_q36.pid = -1; g_q36.ready = 0;
}
#endif

static int q36_running(void) { return g_q36.pid > 0; }
static int q36_ready(void) { return q36_running() && g_q36.ready && !g_q36.stopping; }
static int q36_vision_ready(void) {
    return q36_ready() && g_q36.spec.vision[0] && g_q36.spec.vision_identity[0];
}

static int q36_endpoint(char *url, size_t cap) {
    if (!q36_ready()) return 0;
    int n = snprintf(url, cap, "http://127.0.0.1:%d", g_q36.spec.cfg.port);
    return n > 0 && (size_t)n < cap;
}

static void q36_bind_frontend(pid_t pid) { g_q36.frontend = pid; }

static int q36_rpc_current(pid_t pid, unsigned long long generation) {
    return q36_ready() && pid == g_q36.pid && generation == g_q36.launch_task &&
        g_child > 0 && g_child == g_q36.frontend && !g_child_stop_requested &&
        (g_mode == ENGINE_AGENT || g_mode == ENGINE_COWORK);
}

static unsigned long long q36_rpc_owner(pid_t *pid, char *url, size_t cap) {
    if (!q36_rpc_current(g_q36.pid, g_q36.launch_task) || !q36_endpoint(url, cap)) return 0;
    *pid = g_q36.pid;
    return g_q36.launch_task;
}

static int q36_agent_directory(const char *engine, char *out, size_t cap) {
    const char *slash = strrchr(engine, '/');
    if (engine[0] != '/' || !slash || slash == engine || strcmp(slash + 1, Q36_DIR_NAME)) return 0;
    int n = snprintf(out, cap, "%.*s/ds4", (int)(slash - engine), engine);
    return n > 0 && (size_t)n < cap;
}

static void q36_request_stop(const char *reason) {
    if (!q36_running() || g_q36.stopping) return;
    g_q36.stopping = 1; g_q36.ready = 0;
    g_ready = 0;
    cstr_copy(g_stage, sizeof g_stage, "Stopping the owned Qwen engine…");
    g_q36.deadline = dstudio_now_ms() + 4000;
    /* Closing our exclusive endpoint activates the native guard, including
     * during model loading. Keep the PID until waitpid reaps it. */
    if (g_q36.owner >= 0) { close(g_q36.owner); g_q36.owner = -1; }
    dstudio_log_event("info", "engine", g_q36.launch_task,
                      "stopping owned Qwen server pid %d: %s", (int)g_q36.pid, reason);
}

static void q36_fail(const char *reason) {
    if (!g_q36.error[0]) cstr_copy(g_q36.error, sizeof g_q36.error, reason);
    g_ready = 0;
    model_rpc_cancel();
    if (g_active_turn_task) {
        task_mark_incomplete(g_active_turn_task, "The owned model stopped before completing the turn", reason);
        g_active_turn_task = 0;
    }
    if (g_active_launch_task == g_q36.launch_task) {
        task_mark_failed(g_active_launch_task, reason, g_q36.last_log);
        g_active_launch_task = 0; g_active_launch_mode = ENGINE_NONE;
    }
    q36_request_stop(reason);
    /* A sibling tool frontend cannot continue against a dead/replaced model.
     * Its earlier effects remain; no transcript is replayed automatically. */
    if (g_child > 0) request_child_stop();
    cstr_copy(g_engine_err, sizeof g_engine_err, reason);
    cstr_copy(g_stage, sizeof g_stage, "Qwen engine stopped");
}

static int q36_receipt_matches(const char *json) {
    dtg_json_token tokens[64]; char error[128];
    if (!dtg_json_validate_complete(json, '{', error, sizeof error)) return 0;
    int count = dtg_json_tokenize(json, strlen(json), tokens, 64);
    if (count <= 0 || tokens[0].type != DTG_JSON_OBJECT) return 0;
    /* Reject duplicate/unknown fields instead of accepting whichever a string
     * accessor happens to find. Native v1 has exactly these fourteen keys. */
    const char *keys[] = {"version", "event", "pid", "host", "port", "context", "model", "backend",
        "cache_k", "cache_v", "ssd_streaming", "model_file", "vision_file", "mtp_file"};
    const char *strings[] = {NULL, "ready", NULL, "127.0.0.1", NULL, NULL, "qwen3.8-27b", "metal",
        "f16", "f16", NULL, g_q36.spec.model_identity, g_q36.spec.vision_identity, ""};
    unsigned seen = 0;
    for (int i = 1; i < count; i += 2) {
        if (i + 1 >= count || tokens[i].parent != 0 || tokens[i + 1].parent != 0 ||
            tokens[i].type != DTG_JSON_STRING ||
            (tokens[i + 1].type != DTG_JSON_STRING && tokens[i + 1].type != DTG_JSON_PRIMITIVE)) return 0;
        unsigned k;
        for (k = 0; k < sizeof keys / sizeof keys[0]; k++)
            if ((size_t)(tokens[i].end - tokens[i].start) == strlen(keys[k]) &&
                !memcmp(json + tokens[i].start, keys[k], strlen(keys[k]))) break;
        if (k == sizeof keys / sizeof keys[0] || (seen & (1u << k))) return 0;
        seen |= 1u << k;
        if (k == 0 || k == 2 || k == 4 || k == 5) {
            long long value, expected = k == 0 ? 1 : k == 2 ? (long long)g_q36.pid :
                k == 4 ? g_q36.spec.cfg.port : g_q36.spec.cfg.ctx;
            if (!dtg_json_token_int(json, &tokens[i + 1], expected, expected, &value)) return 0;
        }
        if (k == 10 && (tokens[i+1].type != DTG_JSON_PRIMITIVE ||
            tokens[i+1].end - tokens[i+1].start != 5 || memcmp(json + tokens[i+1].start, "false", 5))) return 0;
        if (strings[k]) {
            char got[192];
            if (!dtg_json_token_string(json, &tokens[i + 1], got, sizeof got) || strcmp(got, strings[k])) return 0;
        }
    }
    if (seen != (1u << (sizeof keys / sizeof keys[0])) - 1u) return 0;
    return 1;
}

static void q36_tick(void) {
#ifndef _WIN32
    if (!q36_running()) return;
    char chunk[4096];
    int *streams[] = {&g_q36.output, &g_q36.errors};
    for (int s = 0; s < 2; s++) for (size_t used = 0; *streams[s] >= 0 && used < 65536;) {
        ssize_t n = read(*streams[s], chunk, sizeof chunk);
        if (n < 0 && errno == EINTR) continue;
        if (!n) { close(*streams[s]); *streams[s] = -1; }
        if (n <= 0) break;
        used += (size_t)n;
        size_t keep = (size_t)n < sizeof g_q36.last_log - 1 ? (size_t)n : sizeof g_q36.last_log - 1;
        memcpy(g_q36.last_log, chunk + n - keep, keep); g_q36.last_log[keep] = '\0';
    }
    if (g_q36.owner >= 0 && !g_q36.stopping) {
        /* A second record, a truncated receipt or closure is never success. */
        ssize_t n = read(g_q36.owner, chunk, sizeof chunk);
        if (n == 0) q36_fail("Qwen owner channel closed");
        else if (n < 0 && errno != EINTR && errno != EAGAIN && errno != EWOULDBLOCK)
            q36_fail("Could not read the Qwen owner channel");
        else if (n > 0) {
            if (g_q36.ready || g_q36.received + (size_t)n >= sizeof g_q36.receipt || memchr(chunk, '\0', (size_t)n))
                q36_fail("Invalid or oversized Qwen readiness receipt");
            else {
                memcpy(g_q36.receipt + g_q36.received, chunk, (size_t)n);
                g_q36.received += (size_t)n; g_q36.receipt[g_q36.received] = '\0';
                char *end = strchr(g_q36.receipt, '\n');
                if (end) {
                    if (end != g_q36.receipt + g_q36.received - 1 || !q36_receipt_matches(g_q36.receipt))
                        q36_fail("Qwen readiness does not match the admitted model and configuration");
                    else g_q36.ready = 1; /* launch owner still validates the live request */
                }
            }
        }
    }
    if (!g_q36.ready && !g_q36.stopping && dstudio_now_ms() >= g_q36.deadline)
        q36_fail("Qwen model loading exceeded its deadline");
    if (g_q36.stopping && !g_q36.killed && dstudio_now_ms() >= g_q36.deadline) {
        kill(g_q36.pid, SIGKILL); g_q36.killed = 1;
    }
    int status;
    pid_t done = waitpid(g_q36.pid, &status, WNOHANG);
    if (done != g_q36.pid && !(done < 0 && errno == ECHILD)) return;
    int unexpected = !g_q36.stopping;
    if (unexpected) q36_fail("The owned Qwen inference process exited unexpectedly");
    for (int i = 0; i < 2; i++) if (*streams[i] >= 0) close(*streams[i]);
    if (g_q36.owner >= 0) close(g_q36.owner);
    g_q36.pid = -1; g_q36.owner = g_q36.output = g_q36.errors = -1;
    g_q36.ready = 0;
    if (g_child <= 0) {
        g_mode = ENGINE_NONE; g_ready = 0;
        if (!unexpected && !g_q36.error[0]) cstr_copy(g_stage, sizeof g_stage, "Stopped");
    }
#endif
}

static int q36_pollfds(struct pollfd *fds) {
    int streams[] = {g_q36.owner, g_q36.output, g_q36.errors}, count = 0;
    if (q36_running()) for (int i = 0; i < 3; i++) if (streams[i] >= 0)
        fds[count++] = (struct pollfd){.fd = streams[i], .events = POLLIN};
    return count;
}

static int q36_same_launch(const q36_launch_spec *spec) {
    const q36_launch_spec *current = &g_q36.spec;
    return q36_ready() && current->cfg.ctx == spec->cfg.ctx && current->cfg.port == spec->cfg.port &&
        current->cfg.kv_space_mb == spec->cfg.kv_space_mb && current->cfg.kv_min_tok == spec->cfg.kv_min_tok &&
        !strcmp(current->directory, spec->directory) && !strcmp(current->model, spec->model) &&
        !strcmp(current->vision, spec->vision) && !strcmp(current->kv_dir, spec->kv_dir) &&
        !strcmp(current->binary_identity, spec->binary_identity) &&
        !strcmp(current->model_identity, spec->model_identity) && !strcmp(current->vision_identity, spec->vision_identity);
}

static int q36_start_owned(const q36_launch_spec *spec, unsigned long long task, char *error, size_t cap) {
#ifdef _WIN32
    (void)spec; (void)task;
    cstr_copy(error, cap, "The q36 resident runtime is not available on Windows"); return 0;
#else
    if (q36_running() || g_child > 0) { cstr_copy(error, cap, "A previous model process is still owned"); return 0; }
    if (!spec || spec->directory[0] != '/' || !spec->model[0] || !spec->binary_identity[0] ||
        !spec->model_identity[0] || !strcmp(spec->model_identity, "missing") ||
        (spec->vision[0] != '\0') != (spec->vision_identity[0] != '\0') ||
        spec->cfg.ctx <= 0 || spec->cfg.ctx > 262144 || spec->cfg.port < 1024 || spec->cfg.port > 65535 ||
        spec->cfg.power != 100 || spec->cfg.ssd_streaming == SSD_STREAMING_ON ||
        spec->cfg.kv_space_mb < 0 || spec->cfg.kv_min_tok < 1 ||
        (spec->cfg.kv_space_mb > 0 && !spec->kv_dir[0])) {
        cstr_copy(error, cap, "Incomplete or unsupported Qwen launch configuration"); return 0;
    }
    if (port_listening(spec->cfg.port)) {
        cstr_copy(error, cap, "The Qwen port is occupied by another process; DStudio will not attach to or stop it");
        return 0;
    }
    char model[DSTUDIO_PATH_MAX + 1024], vision[DSTUDIO_PATH_MAX + 1024], binary[1200], install_root[1024];
    const char *slash = strrchr(spec->directory, '/');
    q36_exec_identity executable;
    if (!slash || slash == spec->directory || strcmp(slash + 1, Q36_DIR_NAME) ||
        !q36_exec_identity_parse(spec->binary_identity, &executable)) {
        cstr_copy(error, cap, "Invalid Qwen installation path or executable identity"); return 0;
    }
    size_t root_length = (size_t)(slash - spec->directory);
    memcpy(install_root, spec->directory, root_length); install_root[root_length] = '\0';
    int n = snprintf(binary, sizeof binary, "%s/q36-server", spec->directory);
    int m = snprintf(model, sizeof model, "%s/%s", spec->directory, spec->model);
    int v = snprintf(vision, sizeof vision, "%s/%s", spec->directory, spec->vision);
    if (n < 0 || (size_t)n >= sizeof binary || m < 0 || (size_t)m >= sizeof model ||
        v < 0 || (size_t)v >= sizeof vision) { cstr_copy(error, cap, "Qwen launch path is too long"); return 0; }
    char context[16], port[16], space[24], minimum[16];
    snprintf(context, sizeof context, "%d", spec->cfg.ctx); snprintf(port, sizeof port, "%d", spec->cfg.port);
    snprintf(space, sizeof space, "%d", spec->cfg.kv_space_mb); snprintf(minimum, sizeof minimum, "%d", spec->cfg.kv_min_tok);
    char *args[36]; int a = 0;
    args[a++] = binary; args[a++] = "--model"; args[a++] = model;
    if (spec->vision[0]) { args[a++] = "--vision"; args[a++] = vision; }
    args[a++] = "--metal"; args[a++] = "--quality"; args[a++] = "--ctx"; args[a++] = context;
    args[a++] = "--cache-type-k"; args[a++] = "f16"; args[a++] = "--cache-type-v"; args[a++] = "f16";
    args[a++] = "--prefill-chunk"; args[a++] = "128";
    args[a++] = "--host"; args[a++] = "127.0.0.1"; args[a++] = "--port"; args[a++] = port;
    args[a++] = "--dstudio-owner-fd"; args[a++] = "3"; args[a++] = "--cors";
    if (spec->cfg.kv_space_mb > 0) {
        args[a++] = "--kv-disk-dir"; args[a++] = (char *)spec->kv_dir;
        args[a++] = "--kv-disk-space-mb"; args[a++] = space;
        args[a++] = "--kv-cache-min-tokens"; args[a++] = minimum;
    }
    args[a] = NULL;
    /* Prepare the environment before fork. Experimental native overrides and
     * injected libraries must not silently alter the admitted runtime policy. */
    extern char **environ;
    char *environment[513]; size_t entries = 0, bytes = 0;
    for (char **entry = environ; entry && *entry; entry++) {
        if (!strncmp(*entry, "Q36_", 4) || !strncmp(*entry, "DS4_", 4) ||
            !strncmp(*entry, "DYLD_", 5) || !strncmp(*entry, "LD_", 3)) continue;
        bytes += strlen(*entry) + 1;
        if (entries >= 512 || bytes > 512 * 1024) {
            cstr_copy(error, cap, "Qwen launch environment exceeds its count or byte limit"); return 0;
        }
        environment[entries++] = *entry;
    }
    environment[entries] = NULL;
    if (!q36_fork_guard_installed) {
        int rc = pthread_atfork(NULL, NULL, q36_after_fork_child);
        if (rc) { snprintf(error, cap, "Could not isolate Qwen process ownership across fork: %s", strerror(rc)); return 0; }
        q36_fork_guard_installed = 1;
    }
    int pair[2] = {-1, -1}, output[2] = {-1, -1}, errors[2] = {-1, -1};
    if (socketpair(AF_UNIX, SOCK_STREAM, 0, pair) || pipe(output) || pipe(errors)) goto fail;
    int *descriptors[] = {&pair[0], &pair[1], &output[0], &output[1], &errors[0], &errors[1]};
    for (int i = 0; i < 6; i++) {
        int *fd = descriptors[i];
        if (*fd < 3) {
            int moved = fcntl(*fd, F_DUPFD_CLOEXEC, 3);
            if (moved < 0) goto fail;
            close(*fd); *fd = moved;
        }
        if (fcntl(*fd, F_SETFD, FD_CLOEXEC) < 0) goto fail;
    }
    int parent_fds[] = {pair[0], output[0], errors[0]};
    for (int i = 0; i < 3; i++) {
        int flags = fcntl(parent_fds[i], F_GETFL);
        if (flags < 0 || fcntl(parent_fds[i], F_SETFL, flags | O_NONBLOCK)) goto fail;
    }
    long maxfd = sysconf(_SC_OPEN_MAX); if (maxfd < 0) maxfd = 1024;
    pid_t pid = fork();
    if (pid < 0) goto fail;
    if (!pid) {
        /* Duplicate stdout/stderr before assigning fd3: pipe descriptors may
         * originally occupy that slot. No shared host state is touched. */
        close(pair[0]);
        if (dup2(output[1], 1) < 0 || dup2(errors[1], 2) < 0 ||
            dup2(pair[1], 3) < 0 || fcntl(3, F_SETFD, 0)) _exit(127);
        for (int fd = 4; fd < maxfd; fd++) close(fd);
        q36_exec_installation_lease(install_root, binary, &executable);
        if (chdir(spec->directory)) _exit(127);
        close(0);
        execve(binary, args, environment); _exit(127);
    }
    close(pair[1]); close(output[1]); close(errors[1]);
    memset(&g_q36, 0, sizeof g_q36); g_q36.spec = *spec;
    g_q36.pid = pid; g_q36.owner = pair[0]; g_q36.output = output[0]; g_q36.errors = errors[0];
    g_q36.launch_task = task; g_q36.deadline = dstudio_now_ms() + 120000;
    reset_progress("Loading Qwen27B…");
    return 1;
fail:
    for (int i = 0; i < 2; i++) { if (pair[i] >= 0) close(pair[i]); if (output[i] >= 0) close(output[i]); if (errors[i] >= 0) close(errors[i]); }
    snprintf(error, cap, "Could not start the owned Qwen server: %s", strerror(errno)); return 0;
#endif
}

static void q36_shutdown(void) {
    q36_request_stop("DStudio shutdown");
    while (q36_running()) { q36_tick(); if (q36_running()) usleep(10000); }
}

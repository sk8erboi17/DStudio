/* One DStudio-owned llama-server (the bundled llama.cpp) serving a local Qwen
 * checkpoint. The HTTP owner alone changes this record; a lightweight Agent
 * frontend never takes over its PID. No weights or KV live here.
 *
 * Process tree: host -> guard (this executable, --resident-guard, a new
 * process group holding the installation lease) -> llama-server. The guard's
 * fd 3 is one end of a socketpair owned by the host: when the host closes it
 * (Stop, model switch) or dies, the guard terminates the server (SIGTERM, then
 * SIGKILL after 4 s) and exits. Without the guard, a crashed host would leave
 * tens of GB of weights mapped by an orphan.
 *
 * Windows has no guard process (NOT TESTED there): the host owns a Job
 * Object with kill-on-close around llama-server, so the same "no orphan after
 * host death" holds, and the host itself holds the shared installation lease.
 * Linux additionally sets PR_SET_PDEATHSIG on the server (NOT TESTED there).
 *
 * Readiness is GET /props on loopback reporting the admitted model path,
 * alias, build, context, exactly one slot and vision exactly when a projector
 * was admitted. Logs are progress text, never readiness.
 * Bounds: one process group, one probe connection at a time (every 500 ms),
 * 256 KiB probe response, 256-byte diagnostic tail, 64 KiB per stream per
 * tick, 4 s teardown. Loading has no wall-clock cap: it ends on readiness, an
 * actual failure or Stop. This is process ownership, not an endpoint cache. */
#include "../extension/remote/dstudio_json_tokens.h"

#define RESIDENT_INSTALL_DIR "llama.cpp"
#ifdef _WIN32
#define RESIDENT_BINARY "bin/llama-server.exe"
#else
#define RESIDENT_BINARY "bin/llama-server"
#endif
#ifdef __linux__
#include <sys/prctl.h>
#endif
#define RESIDENT_LEASE ".dstudio-llama-install.lock"
#define RESIDENT_BUILD_INFO "b11371-99b9548" /* scripts/install-llama.py BUILD_NUMBER + PIN[:7] */
#define RESIDENT_PROBE_MAX (256 * 1024)
/* The same owner serves two backends. MLX (macOS on Apple Silicon): the
 * bundled mlx-lm server in <root>/mlx (scripts/install-mlx.py), run by its
 * own copied interpreter; readiness is /v1/models listing exactly the admitted
 * model directory (patch/mlx-lm-single-model). */
enum { RESIDENT_LLAMA = 0, RESIDENT_MLX = 1 };
#define RESIDENT_MLX_DIR "mlx"
#define RESIDENT_MLX_BINARY "venv/bin/python3"
#define RESIDENT_MLX_LEASE ".dstudio-mlx-install.lock"
static const char *resident_dir_name(int kind) { return kind == RESIDENT_MLX ? RESIDENT_MLX_DIR : RESIDENT_INSTALL_DIR; }
static const char *resident_binary_rel(int kind) { return kind == RESIDENT_MLX ? RESIDENT_MLX_BINARY : RESIDENT_BINARY; }
static const char *resident_lease_name(int kind) { return kind == RESIDENT_MLX ? RESIDENT_MLX_LEASE : RESIDENT_LEASE; }
static const char *resident_engine_label(int kind) { return kind == RESIDENT_MLX ? "MLX" : "llama.cpp"; }

typedef struct {
    engine_cfg cfg;
    /* directory: the main ds4 installation holding gguf/ and the Agent
     * runtime. install: its sibling llama.cpp/. model/vision are relative to
     * directory. model_id is the alias the server must report. */
    char directory[1024], install[1024], model[1024], vision[1024], model_id[48];
    char binary_identity[192], model_identity[192], vision_identity[192];
    /* The lightweight DStudio tools frontend (ds4-agent-jsonl/ds4-cowork).
     * Its identity is not part of the resident weights identity. */
    char agent_dir[1024], agent_identity[192];
    int kind; /* RESIDENT_LLAMA | RESIDENT_MLX */
} resident_launch_spec;

typedef struct {
    resident_launch_spec spec;
    pid_t pid, frontend;          /* pid: the guard, leader of the server's group */
    int owner, output, errors, ready, stopping, killed;
    int probe, probe_phase;       /* -1 | connected socket; 0 sending, 1 reading */
    unsigned long long launch_task;
    long long deadline;           /* Stop escalation only; loading has no cap. */
    long long probe_at;
    size_t probe_len;
    char *probe_buf;
    char last_log[256], error[256];
    char model_real[DSTUDIO_PATH_MAX]; /* MLX readiness: the admitted directory, resolved */
#ifdef _WIN32
    HANDLE job, lease;            /* kill-on-close job; shared installation lease */
#endif
} resident_runtime;
static resident_runtime g_resident = {.pid = -1, .owner = -1, .output = -1, .errors = -1, .probe = -1};

static int resident_path_absolute(const char *path) {
#ifdef _WIN32
    if (((path[0] >= 'A' && path[0] <= 'Z') || (path[0] >= 'a' && path[0] <= 'z')) &&
        path[1] == ':' && (path[2] == '/' || path[2] == '\\')) return 1;
#endif
    return path[0] == '/';
}

static const char *resident_last_separator(const char *path) {
    const char *slash = strrchr(path, '/');
#ifdef _WIN32
    const char *back = strrchr(path, '\\');
    if (back && (!slash || back > slash)) slash = back;
#endif
    return slash;
}

/* <parent of the ds4 installation>/llama.cpp or /mlx, the installer's target. */
static int resident_install_dir_kind(int kind, const char *engine_dir, char *out, size_t cap) {
    const char *slash = resident_last_separator(engine_dir);
    if (!resident_path_absolute(engine_dir) || !slash || slash == engine_dir) return 0;
    int n = snprintf(out, cap, "%.*s/%s", (int)(slash - engine_dir), engine_dir, resident_dir_name(kind));
    return n > 0 && (size_t)n < cap;
}

#ifndef _WIN32
static int resident_fork_guard_installed;
static void resident_after_fork_child(void) {
    /* CLOEXEC alone is insufficient: PDF/catalog/proxy workers may fork and
     * keep running without exec. Their copied endpoints must not keep the
     * model alive after its actual owner dies. Only async-signal-safe closes
     * and private child-state changes are permitted in this callback. */
    if (g_resident.owner >= 0) close(g_resident.owner);
    if (g_resident.output >= 0) close(g_resident.output);
    if (g_resident.errors >= 0) close(g_resident.errors);
    if (g_resident.probe >= 0) close(g_resident.probe);
    g_resident.owner = g_resident.output = g_resident.errors = g_resident.probe = -1;
    g_resident.pid = -1; g_resident.ready = 0;
}
#endif

static int resident_running(void) { return g_resident.pid > 0; }
static int resident_ready(void) { return resident_running() && g_resident.ready && !g_resident.stopping; }
static int resident_vision_ready(void) {
    return resident_ready() && g_resident.spec.vision[0] && g_resident.spec.vision_identity[0];
}

static int resident_endpoint(char *url, size_t cap) {
    if (!resident_ready()) return 0;
    int n = snprintf(url, cap, "http://127.0.0.1:%d", g_resident.spec.cfg.port);
    return n > 0 && (size_t)n < cap;
}

static void resident_bind_frontend(pid_t pid) { g_resident.frontend = pid; }
static const char *resident_served_model(void) { return g_resident.spec.model_id; }

static int resident_rpc_current(pid_t pid, unsigned long long generation) {
    return resident_ready() && pid == g_resident.pid && generation == g_resident.launch_task &&
        g_child > 0 && g_child == g_resident.frontend && !g_child_stop_requested &&
        MODE_IS_PIPED(g_mode);
}

static unsigned long long resident_rpc_owner(pid_t *pid, char *url, size_t cap, const char **model_id) {
    if (!resident_rpc_current(g_resident.pid, g_resident.launch_task) || !resident_endpoint(url, cap)) return 0;
    *pid = g_resident.pid;
    *model_id = g_resident.spec.model_id;
    return g_resident.launch_task;
}

static void resident_probe_close(void) {
    if (g_resident.probe >= 0) close(g_resident.probe);
    g_resident.probe = -1; g_resident.probe_phase = 0; g_resident.probe_len = 0;
}

static void resident_request_stop(const char *reason) {
    if (!resident_running() || g_resident.stopping) return;
    g_resident.stopping = 1; g_resident.ready = 0;
    g_ready = 0;
    resident_probe_close();
    snprintf(g_stage, sizeof g_stage, "Stopping the %s engine…", resident_engine_label(g_resident.spec.kind));
    g_resident.deadline = dstudio_now_ms() + 4000;
    /* Closing our end of the owner socket makes the guard stop the server,
     * including during model loading. Keep the PID until waitpid reaps it. */
    if (g_resident.owner >= 0) { close(g_resident.owner); g_resident.owner = -1; }
    dstudio_log_event("info", "engine", g_resident.launch_task,
                      "stopping llama.cpp guard pid %d: %s", (int)g_resident.pid, reason);
}

static void resident_fail(const char *reason);
/* "<engine> <what>: <last line the guard or server wrote>", so a failed start
 * names its engine and its actual cause instead of a bare channel state. */
static void resident_fail_engine(const char *what) {
    char line[sizeof g_resident.last_log], reason[sizeof g_resident.error];
    cstr_copy(line, sizeof line, g_resident.last_log);
    size_t n = strlen(line);
    while (n && (line[n - 1] == '\n' || line[n - 1] == '\r' || line[n - 1] == ' ')) line[--n] = '\0';
    char *last = strrchr(line, '\n');
    const char *tail = last ? last + 1 : line;
    snprintf(reason, sizeof reason, "The %s %s%s%.180s", resident_engine_label(g_resident.spec.kind), what, *tail ? ": " : "", tail);
    resident_fail(reason);
}
static void resident_fail(const char *reason) {
    if (!g_resident.error[0]) cstr_copy(g_resident.error, sizeof g_resident.error, reason);
    g_ready = 0;
    model_rpc_cancel();
    if (g_active_turn_task) {
        task_mark_incomplete(g_active_turn_task, "The local model stopped before completing the turn", reason);
        g_active_turn_task = 0;
    }
    if (g_active_launch_task == g_resident.launch_task) {
        task_mark_failed(g_active_launch_task, reason, g_resident.last_log);
        g_active_launch_task = 0; g_active_launch_mode = ENGINE_NONE;
    }
    resident_request_stop(reason);
    /* A sibling tool frontend cannot continue against a dead/replaced model.
     * Its earlier effects remain; no transcript is replayed automatically. */
    if (g_child > 0) request_child_stop();
    cstr_copy(g_engine_err, sizeof g_engine_err, reason);
    snprintf(g_stage, sizeof g_stage, "%s engine stopped", resident_engine_label(g_resident.spec.kind));
}

/* MLX: /v1/models lists exactly the admitted directory once it is loaded. */
static int resident_mlx_models_match(const char *json, size_t len) {
    char error[128];
    if (!dtg_json_validate_complete(json, '{', error, sizeof error)) return -1;
    enum { TOKENS = 256 };
    dtg_json_token tokens[TOKENS];
    int count = dtg_json_tokenize(json, len, tokens, TOKENS);
    if (count <= 0 || tokens[0].type != DTG_JSON_OBJECT) return -1;
    int data = dtg_json_object_field(json, tokens, count, 0, "data");
    if (data < 0 || tokens[data].type != DTG_JSON_ARRAY) return -1;
    if (tokens[data].size != 1) return 0;
    int item = dtg_json_array_nth(tokens, count, data, 0);
    int id = item >= 0 ? dtg_json_object_field(json, tokens, count, item, "id") : -1;
    char text[DSTUDIO_PATH_MAX];
    if (id < 0 || !dtg_json_token_string(json, &tokens[id], text, sizeof text)) return -1;
    return g_resident.model_real[0] && !strcmp(text, g_resident.model_real);
}

/* 1: matches the admitted launch, 0: not this launch (fatal), -1: unreadable. */
static int resident_props_match(const char *json, size_t len) {
    if (g_resident.spec.kind == RESIDENT_MLX) return resident_mlx_models_match(json, len);
    char error[128];
    if (!dtg_json_validate_complete(json, '{', error, sizeof error)) return -1;
    enum { TOKENS = 8192 };
    dtg_json_token *tokens = malloc(TOKENS * sizeof *tokens);
    if (!tokens) return -1;
    int count = dtg_json_tokenize(json, len, tokens, TOKENS), ok = 0;
    char path[DSTUDIO_PATH_MAX + 1024], text[DSTUDIO_PATH_MAX + 1024];
    long long value = 0;
    if (count <= 0 || tokens[0].type != DTG_JSON_OBJECT) { free(tokens); return -1; }
    snprintf(path, sizeof path, "%s/%s", g_resident.spec.directory, g_resident.spec.model);
    int at = dtg_json_object_field(json, tokens, count, 0, "model_path");
    if (at < 0 || !dtg_json_token_string(json, &tokens[at], text, sizeof text) || strcmp(text, path)) goto done;
    at = dtg_json_object_field(json, tokens, count, 0, "model_alias");
    if (at < 0 || !dtg_json_token_string(json, &tokens[at], text, sizeof text) || strcmp(text, g_resident.spec.model_id)) goto done;
    at = dtg_json_object_field(json, tokens, count, 0, "build_info");
    if (at < 0 || !dtg_json_token_string(json, &tokens[at], text, sizeof text) || strcmp(text, RESIDENT_BUILD_INFO)) goto done;
    at = dtg_json_object_field(json, tokens, count, 0, "total_slots");
    if (at < 0 || !dtg_json_token_int(json, &tokens[at], 1, 1, &value)) goto done;
    int settings = dtg_json_object_field(json, tokens, count, 0, "default_generation_settings");
    at = dtg_json_object_field(json, tokens, count, settings, "n_ctx");
    if (at < 0 || !dtg_json_token_int(json, &tokens[at], g_resident.spec.cfg.ctx, g_resident.spec.cfg.ctx, &value)) goto done;
    int modalities = dtg_json_object_field(json, tokens, count, 0, "modalities");
    at = dtg_json_object_field(json, tokens, count, modalities, "vision");
    if (at < 0 || !dtg_json_primitive_eq(json, &tokens[at], g_resident.spec.vision[0] ? "true" : "false")) goto done;
    ok = 1;
done:
    free(tokens);
    return ok;
}

/* Nonblocking loopback socket helpers: poll() on POSIX; select() and
 * ioctlsocket() on Windows, whose host poll() only reports readable pipes. */
static int resident_socket_connect(int port) {
    int fd = socket(AF_INET, SOCK_STREAM, 0);
    if (fd < 0) return -1;
    struct sockaddr_in address = {0};
    address.sin_family = AF_INET;
    address.sin_port = htons((uint16_t)port);
    address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
#ifdef _WIN32
    u_long nonblocking = 1;
    if (ioctlsocket((SOCKET)(intptr_t)fd, FIONBIO, &nonblocking)) { close(fd); return -1; }
    if (connect((SOCKET)(intptr_t)fd, (struct sockaddr *)&address, sizeof address) &&
        WSAGetLastError() != WSAEWOULDBLOCK) { close(fd); return -1; }
#else
    int flags = fcntl(fd, F_GETFL);
#ifdef SO_NOSIGPIPE
    int one = 1;
    (void)setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &one, sizeof one);
#endif
    if (flags < 0 || fcntl(fd, F_SETFL, flags | O_NONBLOCK) || fcntl(fd, F_SETFD, FD_CLOEXEC)) { close(fd); return -1; }
    if (connect(fd, (struct sockaddr *)&address, sizeof address) && errno != EINPROGRESS) { close(fd); return -1; }
#endif
    return fd;
}

/* 1 ready, 0 not yet, -1 failed. */
static int resident_socket_wait(int fd, int write) {
#ifdef _WIN32
    fd_set ready, failed;
    FD_ZERO(&ready); FD_ZERO(&failed);
    FD_SET((SOCKET)(intptr_t)fd, &ready); FD_SET((SOCKET)(intptr_t)fd, &failed);
    struct timeval now = {0, 0};
    int rc = select(0, write ? NULL : &ready, write ? &ready : NULL, &failed, &now);
    if (rc < 0 || FD_ISSET((SOCKET)(intptr_t)fd, &failed)) return -1;
    return rc > 0;
#else
    struct pollfd p = {.fd = fd, .events = write ? POLLOUT : POLLIN};
    int rc = poll(&p, 1, 0);
    if (rc < 0) return errno == EINTR ? 0 : -1;
    if (rc && write && (p.revents & (POLLERR | POLLNVAL))) return -1;
    if (rc && write) {
        int error = 0; socklen_t length = sizeof error;
        if (getsockopt(fd, SOL_SOCKET, SO_ERROR, &error, &length) || error) return -1;
    }
    return rc > 0;
#endif
}

/* A complete Connection: close response, NUL-terminated. llama-server answers
 * HTTP/1.1; the MLX server (Python's BaseHTTPServer) answers HTTP/1.0 without
 * Content-Length, so the body is everything up to EOF in both cases. Chunked
 * bodies are not decoded and therefore never accepted. */
static int resident_probe_verdict(char *response) {
    char *body = strstr(response, "\r\n\r\n");
    int ok = (!strncmp(response, "HTTP/1.1 200 ", 13) || !strncmp(response, "HTTP/1.0 200 ", 13)) && body &&
             !mem_contains_ci(response, (size_t)(body - response), "transfer-encoding:");
    return ok ? resident_props_match(body + 4, strlen(body + 4)) : -1;
}

/* One nonblocking HTTP exchange per attempt; never waits in the owner loop. */
static void resident_probe_step(void) {
    long long now = dstudio_now_ms();
    if (g_resident.probe < 0) {
        if (now < g_resident.probe_at) return;
        g_resident.probe_at = now + 500;
        int fd = resident_socket_connect(g_resident.spec.cfg.port);
        if (fd < 0) return;
        g_resident.probe = fd; g_resident.probe_phase = 0; g_resident.probe_len = 0;
        return;
    }
    if (g_resident.probe_phase == 0) {
        int writable = resident_socket_wait(g_resident.probe, 1);
        if (writable < 0) { resident_probe_close(); return; }
        if (!writable) return;
        static const char props[] = "GET /props HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n";
        static const char models[] = "GET /v1/models HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n";
        const char *request = g_resident.spec.kind == RESIDENT_MLX ? models : props;
        size_t request_len = strlen(request);
#ifdef MSG_NOSIGNAL
        int flags = MSG_NOSIGNAL;
#else
        int flags = 0;
#endif
        if (send(g_resident.probe, request, request_len, flags) != (ssize_t)request_len) {
            resident_probe_close(); return;
        }
        g_resident.probe_phase = 1;
        return;
    }
    if (!g_resident.probe_buf && !(g_resident.probe_buf = malloc(RESIDENT_PROBE_MAX + 1))) { resident_probe_close(); return; }
    for (;;) {
        int readable = resident_socket_wait(g_resident.probe, 0);
        if (readable < 0) { resident_probe_close(); return; }
        if (!readable) return;
        ssize_t n = recv(g_resident.probe, g_resident.probe_buf + g_resident.probe_len,
                         RESIDENT_PROBE_MAX - g_resident.probe_len, 0);
#ifdef _WIN32
        if (n < 0) { resident_probe_close(); return; } /* select() reported it readable */
#endif
        if (n < 0 && errno == EINTR) continue;
        if (n < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) return;
        if (n < 0) { resident_probe_close(); return; }
        if (n > 0) {
            g_resident.probe_len += (size_t)n;
            if (g_resident.probe_len >= RESIDENT_PROBE_MAX) { resident_probe_close(); return; }
            continue;
        }
        break; /* EOF: the complete response, Connection: close */
    }
    g_resident.probe_buf[g_resident.probe_len] = '\0';
    int verdict = resident_probe_verdict(g_resident.probe_buf);
    resident_probe_close();
    /* 503 while loading and partial reads simply retry; a ready server that
     * reports another model, build or configuration is never accepted. */
    if (verdict == 0) resident_fail(g_resident.spec.kind == RESIDENT_MLX ? "MLX reports a different model than DStudio admitted"
        : "llama.cpp reports a different model, build or configuration than DStudio admitted");
    else if (verdict == 1) {
        g_resident.ready = 1; /* the launch owner still validates the live request */
        free(g_resident.probe_buf); g_resident.probe_buf = NULL;
    }
}

#ifdef _WIN32
/* Up to 64 KiB of one anonymous pipe without blocking; -1 at EOF. */
static int resident_win_drain(int *stream, char *chunk, size_t cap) {
    for (size_t used = 0; *stream >= 0 && used < 65536;) {
        DWORD available = 0, got = 0;
        HANDLE pipe = (HANDLE)(intptr_t)*stream;
        if (!PeekNamedPipe(pipe, NULL, 0, NULL, &available, NULL)) {
            CloseHandle(pipe); *stream = -1; return -1; /* ERROR_BROKEN_PIPE: writer gone */
        }
        if (!available) return 0;
        if (!ReadFile(pipe, chunk, (DWORD)(available < cap ? available : cap), &got, NULL) || !got) return 0;
        used += got;
        size_t keep = got < sizeof g_resident.last_log - 1 ? got : sizeof g_resident.last_log - 1;
        memcpy(g_resident.last_log, chunk + got - keep, keep); g_resident.last_log[keep] = '\0';
    }
    return 0;
}
#endif

static void resident_tick(void) {
    if (!resident_running()) return;
    char chunk[4096];
    int *streams[] = {&g_resident.output, &g_resident.errors};
#ifdef _WIN32
    for (int s = 0; s < 2; s++) (void)resident_win_drain(streams[s], chunk, sizeof chunk);
    /* No guard here: the job is the owner channel. Stop has no graceful
     * phase to wait for, since llama-server keeps no durable state. */
    if (!g_resident.ready && !g_resident.stopping && g_resident.job) resident_probe_step();
    if (g_resident.stopping && !g_resident.killed) {
        if (g_resident.job) TerminateJobObject(g_resident.job, 1);
        g_resident.killed = 1;
    }
    int status;
    pid_t done = waitpid(g_resident.pid, &status, WNOHANG); /* closes the process handle on exit */
    if (done != g_resident.pid) return;
    int unexpected = !g_resident.stopping;
    if (unexpected) resident_fail_engine("server exited unexpectedly");
    /* Closing the job kills anything the server may have started. */
    if (g_resident.job) { CloseHandle(g_resident.job); g_resident.job = NULL; }
    for (int i = 0; i < 2; i++) if (*streams[i] >= 0) CloseHandle((HANDLE)(intptr_t)*streams[i]);
    if (g_resident.lease && g_resident.lease != INVALID_HANDLE_VALUE) CloseHandle(g_resident.lease);
    g_resident.lease = NULL;
#else
    for (int s = 0; s < 2; s++) for (size_t used = 0; *streams[s] >= 0 && used < 65536;) {
        ssize_t n = read(*streams[s], chunk, sizeof chunk);
        if (n < 0 && errno == EINTR) continue;
        if (!n) { close(*streams[s]); *streams[s] = -1; }
        if (n <= 0) break;
        used += (size_t)n;
        size_t keep = (size_t)n < sizeof g_resident.last_log - 1 ? (size_t)n : sizeof g_resident.last_log - 1;
        memcpy(g_resident.last_log, chunk + n - keep, keep); g_resident.last_log[keep] = '\0';
    }
    if (g_resident.owner >= 0 && !g_resident.stopping) {
        /* The guard never writes: EOF means it is gone. */
        ssize_t n = read(g_resident.owner, chunk, sizeof chunk);
        if (n == 0) resident_fail_engine("server guard stopped");
        else if (n > 0) resident_fail_engine("guard wrote on its owner channel");
        else if (errno != EINTR && errno != EAGAIN && errno != EWOULDBLOCK)
            resident_fail_engine("owner channel could not be read");
    }
    if (!g_resident.ready && !g_resident.stopping && g_resident.owner >= 0) resident_probe_step();
    if (g_resident.stopping && !g_resident.killed && dstudio_now_ms() >= g_resident.deadline) {
        kill(-g_resident.pid, SIGKILL); g_resident.killed = 1;
    }
    int status;
    pid_t done = waitpid(g_resident.pid, &status, WNOHANG);
    if (done != g_resident.pid && !(done < 0 && errno == ECHILD)) return;
    int unexpected = !g_resident.stopping;
    if (unexpected) resident_fail_engine("server exited unexpectedly");
    /* The guard reaped the server; nothing in its group may outlive it. */
    kill(-g_resident.pid, SIGKILL);
    for (int i = 0; i < 2; i++) if (*streams[i] >= 0) close(*streams[i]);
    if (g_resident.owner >= 0) close(g_resident.owner);
#endif
    resident_probe_close();
    free(g_resident.probe_buf); g_resident.probe_buf = NULL;
    g_resident.pid = -1; g_resident.owner = g_resident.output = g_resident.errors = -1;
    g_resident.ready = 0;
    if (g_child <= 0) {
        g_mode = ENGINE_NONE; g_ready = 0;
        if (!unexpected && !g_resident.error[0]) cstr_copy(g_stage, sizeof g_stage, "Stopped");
    }
}

static int resident_pollfds(struct pollfd *fds) {
    int count = 0;
    if (!resident_running()) return 0;
    int streams[] = {g_resident.owner, g_resident.output, g_resident.errors};
    for (int i = 0; i < 3; i++) if (streams[i] >= 0)
        fds[count++] = (struct pollfd){.fd = streams[i], .events = POLLIN};
    if (g_resident.probe >= 0)
        fds[count++] = (struct pollfd){.fd = g_resident.probe, .events = g_resident.probe_phase ? POLLIN : POLLOUT};
    return count;
}

static int resident_same_launch(const resident_launch_spec *spec) {
    const resident_launch_spec *current = &g_resident.spec;
    return resident_ready() && current->kind == spec->kind && current->cfg.ctx == spec->cfg.ctx && current->cfg.port == spec->cfg.port &&
        !strcmp(current->directory, spec->directory) && !strcmp(current->install, spec->install) &&
        !strcmp(current->model, spec->model) && !strcmp(current->vision, spec->vision) &&
        !strcmp(current->model_id, spec->model_id) &&
        !strcmp(current->binary_identity, spec->binary_identity) &&
        !strcmp(current->model_identity, spec->model_identity) && !strcmp(current->vision_identity, spec->vision_identity);
}

#ifndef _WIN32
/* Cold executable identity parsed before fork; compared after exec admission. */
typedef struct {
    unsigned long long device, inode;
    long long size, modified, changed;
    long modified_ns, changed_ns;
} resident_exec_identity;

static int resident_exec_identity_parse(const char *text, resident_exec_identity *out) {
    char extra;
    return sscanf(text, "%llu:%llu:%lld:%lld:%ld:%lld:%ld%c", &out->device, &out->inode,
        &out->size, &out->modified, &out->modified_ns, &out->changed, &out->changed_ns, &extra) == 7 &&
        out->size >= 0 && out->modified_ns >= 0 && out->modified_ns < 1000000000 &&
        out->changed_ns >= 0 && out->changed_ns < 1000000000;
}

static int resident_exec_identity_matches(const resident_exec_identity *expected, const struct stat *actual) {
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

static volatile sig_atomic_t g_resident_guard_stop;
static void resident_guard_signal(int sig) { (void)sig; g_resident_guard_stop = 1; }

/* DStudio --resident-guard <install> <identity> <server argv...>
 * Runs as the leader of a fresh process group with fd 3 = owner socket. */
static int resident_guard_cli(int argc, char **argv) {
    static const char busy[] = "The local engine is being installed; retry after the installation finishes\n";
    static const char invalid[] = "The local engine installation or executable changed; launch rejected\n";
    if (argc < 5 || getpgrp() != getpid()) return 2;
    const char *install = argv[2], *identity = argv[3], *binary = argv[4];
    char root[1024], expected_binary[1200];
    const char *slash = strrchr(install, '/');
    if (!slash || slash == install || (size_t)(slash - install) >= sizeof root) return 2;
    int kind = !strcmp(slash + 1, RESIDENT_INSTALL_DIR) ? RESIDENT_LLAMA : !strcmp(slash + 1, RESIDENT_MLX_DIR) ? RESIDENT_MLX : -1;
    if (kind < 0) return 2;
    memcpy(root, install, (size_t)(slash - install)); root[slash - install] = '\0';
    snprintf(expected_binary, sizeof expected_binary, "%s/%s", install, resident_binary_rel(kind));
    resident_exec_identity executable;
    if (strcmp(binary, expected_binary) || !resident_exec_identity_parse(identity, &executable)) return 2;
    /* Shared installation lease for this server's lifetime: the installer
     * needs it exclusively and never replaces an engine in use. */
    int directory = open(root, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    int lease = directory < 0 ? -1 : openat(directory, resident_lease_name(kind),
        O_RDWR | O_CREAT | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC, 0600);
    struct stat held, file;
    if (lease < 0 || fstat(lease, &held) || !S_ISREG(held.st_mode) || held.st_nlink != 1 ||
        held.st_uid != geteuid() || (held.st_mode & (S_IWGRP | S_IWOTH))) {
        (void)write(2, invalid, sizeof invalid - 1); return 126;
    }
    if (flock(lease, LOCK_SH | LOCK_NB)) { (void)write(2, busy, sizeof busy - 1); return 125; }
    if (lstat(binary, &file) || !resident_exec_identity_matches(&executable, &file)) {
        (void)write(2, invalid, sizeof invalid - 1); return 126;
    }
    if (directory >= 0) close(directory);
    struct sigaction action = {0}; action.sa_handler = resident_guard_signal;
    sigaction(SIGTERM, &action, NULL); sigaction(SIGINT, &action, NULL); sigaction(SIGHUP, &action, NULL);
    signal(SIGPIPE, SIG_IGN);
    extern char **environ;
#ifdef __linux__
    pid_t guard = getpid();
#endif
    pid_t server = fork();
    if (server < 0) return 127;
    if (!server) {
        close(3); close(lease);
        signal(SIGTERM, SIG_DFL); signal(SIGINT, SIG_DFL); signal(SIGHUP, SIG_DFL); signal(SIGPIPE, SIG_DFL);
#ifdef __linux__
        /* Even a SIGKILLed guard takes the server with it (NOT TESTED on
         * Linux); the check closes the race with a guard that already died. */
        if (prctl(PR_SET_PDEATHSIG, SIGKILL) || getppid() != guard) _exit(127);
#endif
        execve(binary, argv + 4, environ); _exit(127);
    }
    int status = 0, stopped = 0;
    long long kill_at = 0;
    for (;;) {
        pid_t done = waitpid(server, &status, WNOHANG);
        if (done == server) break;
        if (!stopped) {
            struct pollfd owner = {.fd = 3, .events = POLLIN};
            int ready = poll(&owner, 1, 250);
            char byte;
            /* The host never writes; readable means EOF (owner gone) or misuse. */
            if (g_resident_guard_stop || (ready > 0 && read(3, &byte, 1) <= 0) ||
                (ready > 0 && (owner.revents & (POLLHUP | POLLERR | POLLNVAL)))) {
                kill(server, SIGTERM); stopped = 1; kill_at = dstudio_now_ms() + 4000;
            }
        } else {
            if (dstudio_now_ms() >= kill_at) { kill(server, SIGKILL); kill_at = LLONG_MAX; }
            usleep(50000);
        }
    }
    return WIFEXITED(status) ? WEXITSTATUS(status) : 128 + (WIFSIGNALED(status) ? WTERMSIG(status) : 0);
}
#endif

/* Server arguments shared by every platform; storage stays with the caller. */
typedef struct {
    char model[DSTUDIO_PATH_MAX + 1024], vision[DSTUDIO_PATH_MAX + 1024], binary[1200], workdir[1200];
    char context[16], port[16], identity[192];
} resident_paths;

static int resident_prepare(const resident_launch_spec *spec, resident_paths *p, char *error, size_t cap) {
    if (resident_running() || g_child > 0) { cstr_copy(error, cap, "A previous model process is still owned"); return 0; }
    if (!spec || !resident_path_absolute(spec->directory) || !resident_path_absolute(spec->install) ||
        !spec->model[0] || !spec->model_id[0] ||
        !spec->binary_identity[0] || !spec->model_identity[0] || !strcmp(spec->model_identity, "missing") ||
        (spec->vision[0] != '\0') != (spec->vision_identity[0] != '\0') || !strcmp(spec->vision_identity, "missing") ||
        spec->cfg.ctx <= 0 || spec->cfg.ctx > 262144 || spec->cfg.port < 1024 || spec->cfg.port > 65535 ||
        spec->cfg.power != 100 || spec->cfg.ssd_streaming == SSD_STREAMING_ON || !g_launch_executable[0]) {
        cstr_copy(error, cap, "Incomplete or unsupported llama.cpp launch configuration"); return 0;
    }
    if (port_listening(spec->cfg.port)) {
        cstr_copy(error, cap, "The llama.cpp port is occupied by another process; DStudio will not attach to or stop it");
        return 0;
    }
    int n = snprintf(p->binary, sizeof p->binary, "%s/%s", spec->install, resident_binary_rel(spec->kind));
    int m = snprintf(p->model, sizeof p->model, "%s/%s", spec->directory, spec->model);
    int v = snprintf(p->vision, sizeof p->vision, "%s/%s", spec->directory, spec->vision);
#ifdef __APPLE__
    int w = snprintf(p->workdir, sizeof p->workdir, "%s", spec->directory);
#else
    /* ggml loads backend modules from the executable's directory and the
     * current one: both must be the installation's bin/, never a model or
     * project directory that could hold a stray libggml-*.so. */
    int w = snprintf(p->workdir, sizeof p->workdir, "%s/bin", spec->install);
#endif
    if (n < 0 || (size_t)n >= sizeof p->binary || m < 0 || (size_t)m >= sizeof p->model ||
        v < 0 || (size_t)v >= sizeof p->vision || w < 0 || (size_t)w >= sizeof p->workdir) {
        cstr_copy(error, cap, "llama.cpp launch path is too long"); return 0;
    }
    snprintf(p->context, sizeof p->context, "%d", spec->cfg.ctx);
    snprintf(p->port, sizeof p->port, "%d", spec->cfg.port);
    cstr_copy(p->identity, sizeof p->identity, spec->binary_identity);
    return 1;
}

/* One slot owns the whole context: DStudio sends one turn at a time, and a
 * split context would silently shrink what the user configured. */
static int resident_server_args(const resident_launch_spec *spec, resident_paths *p, char **args, int a) {
    if (spec->kind == RESIDENT_MLX) {
        /* One request at a time, as for llama.cpp. MLX allocates its KV cache
         * as the conversation grows; the context limit is the client's. A
         * request without max_tokens means "until the model stops" in DStudio
         * (llama.cpp: up to the context); upstream MLX would cut it at 512
         * tokens (finish_reason=length, run-JzTNjb), so the default is the
         * configured context instead. */
        args[a++] = "-m"; args[a++] = "mlx_lm"; args[a++] = "server";
        args[a++] = "--model"; args[a++] = p->model;
        args[a++] = "--max-tokens"; args[a++] = p->context;
        args[a++] = "--host"; args[a++] = "127.0.0.1"; args[a++] = "--port"; args[a++] = p->port;
        args[a++] = "--prompt-concurrency"; args[a++] = "1"; args[a++] = "--decode-concurrency"; args[a++] = "1";
        args[a++] = "--log-level"; args[a++] = "WARNING";
        args[a] = NULL;
        return a;
    }
    args[a++] = "--model"; args[a++] = p->model;
    if (spec->vision[0]) { args[a++] = "--mmproj"; args[a++] = p->vision; }
    args[a++] = "--alias"; args[a++] = (char *)spec->model_id;
    args[a++] = "--ctx-size"; args[a++] = p->context; args[a++] = "--parallel"; args[a++] = "1";
#ifdef __APPLE__
    /* Unified memory: every layer on Metal (the tested configuration). */
    args[a++] = "--n-gpu-layers"; args[a++] = "999"; args[a++] = "--flash-attn"; args[a++] = "on";
#else
    /* As Ollama does, place layers by the free memory of the devices the
     * server opened (llama.cpp --fit), the rest on CPU. The context is set
     * explicitly, so fitting never lowers it. NOT TESTED on Linux/Windows. */
    args[a++] = "--fit"; args[a++] = "on"; args[a++] = "--flash-attn"; args[a++] = "auto";
#endif
    args[a++] = "--jinja"; args[a++] = "--reasoning-format"; args[a++] = "deepseek";
    args[a++] = "--host"; args[a++] = "127.0.0.1"; args[a++] = "--port"; args[a++] = p->port;
    args[a++] = "--no-webui";
    args[a] = NULL;
    return a;
}

static void resident_publish(const resident_launch_spec *spec, unsigned long long task, pid_t pid,
                             int owner, int output, int errors) {
    free(g_resident.probe_buf);
#ifdef _WIN32
    HANDLE job = g_resident.job, lease = g_resident.lease;
#endif
    memset(&g_resident, 0, sizeof g_resident); g_resident.spec = *spec;
#ifdef _WIN32
    g_resident.job = job; g_resident.lease = lease;
#endif
    g_resident.pid = pid; g_resident.owner = owner; g_resident.output = output; g_resident.errors = errors;
    g_resident.probe = -1; g_resident.launch_task = task;
    g_resident.probe_at = dstudio_now_ms() + 250;
    char stage[96]; snprintf(stage, sizeof stage, "Loading %s with %s…", resident_model_label(spec->model), resident_engine_label(spec->kind));
    reset_progress(stage);
}

#ifdef _WIN32
static int launch_identity(const char *path, int directory, char *out, size_t cap); /* dstudio_launch.c */
/* NOT TESTED on Windows. The host holds the shared installation lease (the
 * installer's LockFileEx on byte 0) for the server's lifetime, keeps the
 * executable open without write/delete sharing from its identity check until
 * the process exists, and puts the server in a kill-on-close job. */
static int resident_start_owned(const resident_launch_spec *spec, unsigned long long task, char *error, size_t cap) {
    if (spec && spec->kind == RESIDENT_MLX) { cstr_copy(error, cap, "MLX runs on macOS with Apple Silicon only"); return 0; }
    resident_paths p;
    if (!resident_prepare(spec, &p, error, cap)) return 0;
    char *args[40]; int a = 0;
    args[a++] = p.binary;
    resident_server_args(spec, &p, args, a);
    char cmd[32768] = "";
    for (int i = 0; args[i]; i++) win_arg_append(cmd, sizeof cmd, args[i]);
    if (strlen(cmd) >= sizeof cmd - 8) { cstr_copy(error, cap, "llama.cpp command line is too long"); return 0; }
    /* Environment block without engine overrides, bounded like on POSIX. */
    char *block = malloc(512 * 1024 + 2); size_t used = 0, entries = 0;
    LPCH inherited = GetEnvironmentStringsA();
    if (!block || !inherited) { free(block); if (inherited) FreeEnvironmentStringsA(inherited);
        cstr_copy(error, cap, "Could not prepare the llama.cpp environment"); return 0; }
    for (const char *entry = inherited; *entry; entry += strlen(entry) + 1) {
        if (!_strnicmp(entry, "LLAMA_", 6) || !_strnicmp(entry, "GGML_", 5) || !_strnicmp(entry, "DS4_", 4)) continue;
        size_t len = strlen(entry) + 1;
        if (++entries > 512 || used + len > 512 * 1024) {
            FreeEnvironmentStringsA(inherited); free(block);
            cstr_copy(error, cap, "llama.cpp launch environment exceeds its count or byte limit"); return 0;
        }
        memcpy(block + used, entry, len); used += len;
    }
    block[used++] = '\0'; if (used == 1) block[used++] = '\0';
    FreeEnvironmentStringsA(inherited);

    HANDLE lease = INVALID_HANDLE_VALUE, image = INVALID_HANDLE_VALUE, job = NULL, nul = INVALID_HANDLE_VALUE;
    HANDLE out_r = NULL, out_w = NULL, err_r = NULL, err_w = NULL;
    LPPROC_THREAD_ATTRIBUTE_LIST attributes = NULL;
    PROCESS_INFORMATION pi = {0};
    const char *failure = NULL;
    char root[1024], path[1300], current[192];
    const char *slash = resident_last_separator(spec->install);
    if (!slash || (size_t)(slash - spec->install) >= sizeof root) { failure = "Invalid llama.cpp installation path"; goto fail; }
    memcpy(root, spec->install, (size_t)(slash - spec->install)); root[slash - spec->install] = '\0';
    snprintf(path, sizeof path, "%s/%s", root, RESIDENT_LEASE);
    lease = CreateFileA(path, GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                        NULL, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT, NULL);
    BY_HANDLE_FILE_INFORMATION info;
    if (lease == INVALID_HANDLE_VALUE || !GetFileInformationByHandle(lease, &info) || info.nNumberOfLinks != 1 ||
        (info.dwFileAttributes & (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_DIRECTORY))) {
        failure = "The llama.cpp installation or executable changed; launch rejected"; goto fail;
    }
    OVERLAPPED range = {0};
    if (!LockFileEx(lease, LOCKFILE_FAIL_IMMEDIATELY, 0, 1, 0, &range)) {
        failure = "The llama.cpp engine is being installed; retry after the installation finishes"; goto fail;
    }
    image = CreateFileA(p.binary, GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
    if (image == INVALID_HANDLE_VALUE || !launch_identity(p.binary, 0, current, sizeof current) ||
        strcmp(current, p.identity)) {
        failure = "The llama.cpp installation or executable changed; launch rejected"; goto fail;
    }
    SECURITY_ATTRIBUTES sa = {sizeof sa, NULL, TRUE};
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = {0};
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    job = CreateJobObjectA(NULL, NULL);
    nul = CreateFileA("NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, &sa, OPEN_EXISTING, 0, NULL);
    if (!job || !SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof limits) ||
        nul == INVALID_HANDLE_VALUE || !CreatePipe(&out_r, &out_w, &sa, 0) || !CreatePipe(&err_r, &err_w, &sa, 0) ||
        !SetHandleInformation(out_r, HANDLE_FLAG_INHERIT, 0) || !SetHandleInformation(err_r, HANDLE_FLAG_INHERIT, 0)) {
        failure = "Could not create the llama.cpp process boundary"; goto fail;
    }
    /* Only these three handles reach the server, not every inheritable
     * handle other host children happen to own. */
    SIZE_T size = 0;
    InitializeProcThreadAttributeList(NULL, 1, 0, &size);
    attributes = (LPPROC_THREAD_ATTRIBUTE_LIST)malloc(size);
    HANDLE inherit[3] = {nul, out_w, err_w};
    if (!attributes || !InitializeProcThreadAttributeList(attributes, 1, 0, &size) ||
        !UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, inherit, sizeof inherit, NULL, NULL)) {
        failure = "Could not restrict llama.cpp handle inheritance"; goto fail;
    }
    STARTUPINFOEXA si = {0};
    si.StartupInfo.cb = sizeof si; si.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    si.StartupInfo.hStdInput = nul; si.StartupInfo.hStdOutput = out_w; si.StartupInfo.hStdError = err_w;
    si.lpAttributeList = attributes;
    /* Suspended until the job holds it: no window in which it can escape. */
    if (!CreateProcessA(p.binary, cmd, NULL, NULL, TRUE,
                        CREATE_SUSPENDED | CREATE_NO_WINDOW | EXTENDED_STARTUPINFO_PRESENT,
                        block, p.workdir, &si.StartupInfo, &pi)) {
        failure = "Could not start the llama.cpp server"; goto fail;
    }
    if (!AssignProcessToJobObject(job, pi.hProcess)) {
        TerminateProcess(pi.hProcess, 1); CloseHandle(pi.hThread); CloseHandle(pi.hProcess);
        failure = "Could not place the llama.cpp server in its job"; goto fail;
    }
    ResumeThread(pi.hThread); CloseHandle(pi.hThread);
    CloseHandle(image); CloseHandle(nul); CloseHandle(out_w); CloseHandle(err_w);
    DeleteProcThreadAttributeList(attributes); free(attributes); free(block);
    g_resident.job = job; g_resident.lease = lease;
    resident_publish(spec, task, (pid_t)(intptr_t)pi.hProcess, -1, (int)(intptr_t)out_r, (int)(intptr_t)err_r);
    return 1;
fail:
    snprintf(error, cap, "%s (Windows error %lu)", failure, GetLastError());
    if (attributes) { DeleteProcThreadAttributeList(attributes); free(attributes); }
    if (job) CloseHandle(job);
    HANDLE handles[] = {image, nul, out_r, out_w, err_r, err_w, lease};
    for (size_t i = 0; i < sizeof handles / sizeof *handles; i++)
        if (handles[i] && handles[i] != INVALID_HANDLE_VALUE) CloseHandle(handles[i]);
    free(block);
    return 0;
}
#else
static int resident_start_owned(const resident_launch_spec *spec, unsigned long long task, char *error, size_t cap) {
    resident_paths p;
    if (!resident_prepare(spec, &p, error, cap)) return 0;
    char *args[40]; int a = 0;
    args[a++] = g_launch_executable; args[a++] = "--resident-guard"; args[a++] = (char *)spec->install;
    args[a++] = p.identity; args[a++] = p.binary;
    resident_server_args(spec, &p, args, a);
    /* Prepare the environment before fork. Injected libraries and engine
     * overrides must not silently alter the admitted runtime policy. */
    extern char **environ;
    char *environment[520]; size_t entries = 0, bytes = 0;
    /* MLX: the patched single-model server, no network, no user site-packages. */
    static char *mlx_env[] = {"DSTUDIO_MLX_SINGLE_MODEL=1", "DSTUDIO_MLX_REASONING_CONTENT=1", "HF_HUB_OFFLINE=1", "TRANSFORMERS_OFFLINE=1",
                              "PYTHONNOUSERSITE=1", "PYTHONDONTWRITEBYTECODE=1", NULL};
    if (spec->kind == RESIDENT_MLX) for (char **e = mlx_env; *e; e++) environment[entries++] = *e;
    for (char **entry = environ; entry && *entry; entry++) {
        if (!strncmp(*entry, "LLAMA_", 6) || !strncmp(*entry, "GGML_", 5) || !strncmp(*entry, "DS4_", 4) ||
            !strncmp(*entry, "DYLD_", 5) || !strncmp(*entry, "LD_", 3)) continue;
        if (spec->kind == RESIDENT_MLX && (!strncmp(*entry, "PYTHON", 6) || !strncmp(*entry, "VIRTUAL_ENV", 11) ||
            !strncmp(*entry, "HF_", 3) || !strncmp(*entry, "TRANSFORMERS_", 13) || !strncmp(*entry, "MLX_", 4) ||
            !strncmp(*entry, "DSTUDIO_MLX_", 12))) continue;
        bytes += strlen(*entry) + 1;
        if (entries >= 512 || bytes > 512 * 1024) {
            cstr_copy(error, cap, "Local engine launch environment exceeds its count or byte limit"); return 0;
        }
        environment[entries++] = *entry;
    }
    environment[entries] = NULL;
    char model_real[DSTUDIO_PATH_MAX] = "";
    if (spec->kind == RESIDENT_MLX && !realpath(p.model, model_real)) {
        snprintf(error, cap, "The MLX model folder is not readable: %s", strerror(errno)); return 0;
    }
    if (!resident_fork_guard_installed) {
        int rc = pthread_atfork(NULL, NULL, resident_after_fork_child);
        if (rc) { snprintf(error, cap, "Could not isolate llama.cpp process ownership across fork: %s", strerror(rc)); return 0; }
        resident_fork_guard_installed = 1;
    }
    int pair[2] = {-1, -1}, output[2] = {-1, -1}, errors[2] = {-1, -1};
    if (socketpair(AF_UNIX, SOCK_STREAM, 0, pair) || pipe(output) || pipe(errors)) goto fail;
    int *descriptors[] = {&pair[0], &pair[1], &output[0], &output[1], &errors[0], &errors[1]};
    for (int i = 0; i < 6; i++) {
        int *fd = descriptors[i];
        if (*fd < 4) {
            int moved = fcntl(*fd, F_DUPFD_CLOEXEC, 4);
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
        /* A fresh group: Stop and escalation reach the guard and the server,
         * never DStudio. stdout/stderr before fd3: pipes may occupy that slot. */
        setpgid(0, 0);
        close(pair[0]);
        if (dup2(output[1], 1) < 0 || dup2(errors[1], 2) < 0 ||
            dup2(pair[1], 3) < 0 || fcntl(3, F_SETFD, 0)) _exit(127);
        for (int fd = 4; fd < maxfd; fd++) close(fd);
        if (chdir(p.workdir)) _exit(127);
        int null = open("/dev/null", O_RDONLY);
        if (null >= 0 && null != 0) { dup2(null, 0); close(null); }
        execve(g_launch_executable, args, environment); _exit(127);
    }
    setpgid(pid, pid); /* also from the parent: no window before kill(-pid) works */
    close(pair[1]); close(output[1]); close(errors[1]);
    resident_publish(spec, task, pid, pair[0], output[0], errors[0]);
    cstr_copy(g_resident.model_real, sizeof g_resident.model_real, model_real);
    return 1;
fail:
    for (int i = 0; i < 2; i++) { if (pair[i] >= 0) close(pair[i]); if (output[i] >= 0) close(output[i]); if (errors[i] >= 0) close(errors[i]); }
    snprintf(error, cap, "Could not start the llama.cpp server: %s", strerror(errno)); return 0;
}
#endif

static void resident_shutdown(void) {
    resident_request_stop("DStudio shutdown");
    while (resident_running()) {
        resident_tick();
#ifdef _WIN32
        if (resident_running()) Sleep(10);
#else
        if (resident_running()) usleep(10000);
#endif
    }
}

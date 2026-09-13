/* Model transport has one process owner and one publication path. Network,
 * DNS, TLS and parsing run in an exec'd copy of this exact host. It has only
 * private stdin/stdout, never the runtime's pipe or the HTTP listener.
 *
 * Bounds: one worker, one pending request only while cancellation reaps the
 * old worker, 16 MiB decoded body, 16 KiB upload and 16 KiB delivery staging,
 * 4 KiB metadata and 4 KiB terminal receipt. Native bodies are decoded only
 * by the worker; direct-body probes retain the same bounded relay semantics.
 * Each owner pass transfers at most 64 KiB per direction.
 * Runtime PID + pipe + admission epoch fence every write. Stop invalidates
 * delivery before signaling the runtime, then asynchronously reaps the group.
 * No retries of a model/tool action are inferred from a transport failure. */
#include "../extension/remote/dstudio_json_tokens.h"
#define MODEL_RPC_BODY_MAX (16u * 1024u * 1024u)
#define MODEL_RPC_WIRE_MAX (6u * MODEL_RPC_BODY_MAX + 4u)
#define MODEL_RPC_FRAME_MAX (16u * 1024u * 1024u)
#define MODEL_RPC_PASS_BYTES (64u * 1024u)
#define MODEL_RPC_DEADLINE_MS (1800LL * 1000)

typedef struct {
    int id, runtime_fd, saved_flags, flags_changed;
    pid_t runtime, worker;
    pid_t resident; /* optional owned-local endpoint, independent from the tool PID */
    unsigned long long resident_generation;
    unsigned long long epoch;
    int input, output, canceled, stopping;
#ifdef _WIN32
    HANDLE worker_job;
#endif
    long long deadline, stop_deadline, delivery_deadline;
    char *body;
    size_t body_len, body_sent;
    /* Encoded native requests are forwarded as bounded chunks, not assembled
     * or unescaped on the owner. Only the worker owns the decoded body. */
    int encoded, input_complete;
    size_t wire_bytes, upload_len, upload_sent;
    char upload[16384];
    char metadata[4096];
    size_t metadata_len, metadata_sent;
    char header[32];
    size_t header_len, frame_left;
    int final_frame, have_final;
    char bytes[16384];
    size_t bytes_len, bytes_sent;
    char final[4096];
    size_t final_len, final_sent;
} model_rpc_relay;

static model_rpc_relay *g_model_rpc, *g_model_rpc_next;
static unsigned long long g_model_rpc_epoch;
static void model_rpc_tick(void);
static void request_child_stop(void);
static int dtg_json_validate_complete(const char *, char, char *, size_t);

static long long model_rpc_now_ms(void) {
#ifdef _WIN32
    return (long long)GetTickCount64();
#else
    struct timespec now;
    clock_gettime(CLOCK_MONOTONIC, &now);
    return (long long)now.tv_sec * 1000 + now.tv_nsec / 1000000;
#endif
}

static int model_rpc_pipe_nonblock(int fd, int *old) {
#ifdef _WIN32
    /* These write handles are host-created byte pipes in PIPE_WAIT mode.
     * We do synchronous, nonblocking writes (not overlapped/background I/O).
     * SetNamedPipeHandleState explicitly also accepts CreatePipe handles. */
    DWORD mode = PIPE_READMODE_BYTE | PIPE_NOWAIT;
    *old = PIPE_WAIT;
    return SetNamedPipeHandleState((HANDLE)(intptr_t)fd, &mode, NULL, NULL) != 0;
#else
    *old = fcntl(fd, F_GETFL);
    return *old >= 0 && fcntl(fd, F_SETFL, *old | O_NONBLOCK) == 0;
#endif
}

static ssize_t model_rpc_pipe_read(int fd, char *bytes, size_t count) {
#ifdef _WIN32
    DWORD available = 0, got = 0;
    if (!PeekNamedPipe((HANDLE)(intptr_t)fd, NULL, 0, NULL, &available, NULL)) {
        if (GetLastError() == ERROR_BROKEN_PIPE) return 0;
        errno = EIO; return -1;
    }
    if (!available) { errno = EAGAIN; return -1; }
    if (count > available) count = available;
    if (!ReadFile((HANDLE)(intptr_t)fd, bytes, (DWORD)count, &got, NULL)) { errno = EIO; return -1; }
    return (ssize_t)got;
#else
    return read(fd, bytes, count);
#endif
}

static ssize_t model_rpc_pipe_write(int fd, const char *bytes, size_t count) {
#ifdef _WIN32
    DWORD sent = 0;
    if (!WriteFile((HANDLE)(intptr_t)fd, bytes, (DWORD)count, &sent, NULL)) { errno = EPIPE; return -1; }
    if (!sent) { errno = EAGAIN; return -1; }
    return (ssize_t)sent;
#else
    return write(fd, bytes, count);
#endif
}

static int model_rpc_owner_matches(const model_rpc_relay *j) {
    return j->epoch == g_model_rpc_epoch && j->runtime == g_child &&
           j->runtime_fd == g_in_fd && g_in_fd >= 0 &&
           (!j->resident || q36_rpc_current(j->resident, j->resident_generation));
}

static void model_rpc_restore_pipe(model_rpc_relay *j) {
    if (j->flags_changed && j->runtime == g_child && j->runtime_fd == g_in_fd) {
#ifdef _WIN32
        DWORD mode = (DWORD)j->saved_flags;
        (void)SetNamedPipeHandleState((HANDLE)(intptr_t)j->runtime_fd, &mode, NULL, NULL);
#else
        (void)fcntl(j->runtime_fd, F_SETFL, j->saved_flags);
#endif
    }
    j->flags_changed = 0;
}

static void model_rpc_free_relay(model_rpc_relay *j) {
    if (!j) return;
    model_rpc_restore_pipe(j);
    if (j->input >= 0) close(j->input);
    if (j->output >= 0) close(j->output);
#ifdef _WIN32
    if (j->worker_job) CloseHandle(j->worker_job);
#endif
    free(j->body);
    memset(j->metadata, 0, sizeof j->metadata);
    free(j);
}

static void model_rpc_stop_worker(model_rpc_relay *j) {
    if (!j->stopping) j->delivery_deadline = model_rpc_now_ms() + 30000;
    if (!j->stopping && j->worker > 0) {
#ifdef _WIN32
        (void)TerminateJobObject(j->worker_job, 1);
#else
        /* The unreaped direct child is also the group leader: this identity
         * cannot be reused while we retain it. Never signal a reaped PID. */
        (void)kill(-j->worker, SIGTERM);
#endif
        j->stop_deadline = model_rpc_now_ms() + 1000;
    }
    j->stopping = 1;
    if (j->input >= 0) { close(j->input); j->input = -1; }
    if (j->output >= 0) { close(j->output); j->output = -1; }
    free(j->body); j->body = NULL;
    memset(j->metadata, 0, sizeof j->metadata);
}

static void model_rpc_cancel(void) {
    ++g_model_rpc_epoch;
    model_rpc_free_relay(g_model_rpc_next); g_model_rpc_next = NULL;
    if (!g_model_rpc) return;
    model_rpc_relay *j = g_model_rpc;
    j->canceled = 1;
    j->bytes_len = j->bytes_sent = j->final_len = j->final_sent = 0;
    model_rpc_restore_pipe(j);
    model_rpc_stop_worker(j);
}

static void model_rpc_relay_fail(model_rpc_relay *j, const char *reason) {
    model_rpc_stop_worker(j);
    j->bytes_len = j->bytes_sent = 0;
    /* A leading newline also terminates any partially delivered JSON frame.
     * The consumer then receives an explicit failure, never a synthetic done. */
    json_dyn_buf receipt = {0};
    json_dyn_printf(&receipt, "\n\x1e{\"type\":\"model_error\",\"id\":%d,\"error\":", j->id);
    json_dyn_put_escaped(&receipt, reason);
    json_dyn_puts(&receipt, "}\n");
    if (receipt.ptr && receipt.len < sizeof j->final) {
        memcpy(j->final, receipt.ptr, receipt.len);
        j->final_len = receipt.len; j->final_sent = 0; j->have_final = 1;
    } else j->canceled = 1;
    free(receipt.ptr);
}

#ifndef _WIN32
static void *model_rpc_worker_guard(void *unused) {
    (void)unused;
    char byte;
    ssize_t n;
    do { n = read(STDIN_FILENO, &byte, 1); } while (n < 0 && errno == EINTR);
    /* Stdin remains the parent's lifetime lease after the bounded request.
     * All descendants belong to this verified private process group. */
    if (getpgrp() == getpid()) kill(-getpid(), SIGKILL);
    _exit(2);
}
#endif

static int model_rpc_worker_read(char *bytes, size_t count) {
    while (count) {
#ifdef _WIN32
        DWORD got = 0;
        ssize_t n = ReadFile(GetStdHandle(STD_INPUT_HANDLE), bytes, (DWORD)count, &got, NULL) ? (ssize_t)got : -1;
#else
        ssize_t n = read(STDIN_FILENO, bytes, count);
#endif
        if (n < 0 && errno == EINTR) continue;
        if (n <= 0) return 0;
        bytes += n; count -= (size_t)n;
    }
    return 1;
}

/* rpc_send_request's public envelope has a fixed type/id/body header. The
 * owner validates that short header; this worker decodes the quoted body and
 * requires the exact closing brace/newline before opening a network socket.
 * A partial Unicode scalar/escape needs at most 12 bytes across pipe reads.
 * Memory is one private 16 MiB body + 16 KiB input, never a 96 MiB wire copy. */
static int model_rpc_worker_body(char **result, char *error, size_t error_size) {
    char *body = malloc(MODEL_RPC_BODY_MAX + 1);
    if (!body) { snprintf(error, error_size, "Could not allocate the private model request"); return 0; }
    char input[16384], unit[16];
    size_t used = 0, wire = 0, have = 0, need = 0;
    int phase = 0;
    const char *failure = "Invalid or incomplete internal model request envelope";
    for (;;) {
#ifdef _WIN32
        DWORD got = 0;
        ssize_t n = ReadFile(GetStdHandle(STD_INPUT_HANDLE), input, sizeof input, &got, NULL) ? (ssize_t)got : -1;
#else
        ssize_t n = read(STDIN_FILENO, input, sizeof input);
#endif
        if (n < 0 && errno == EINTR) continue;
        if (n <= 0) break;
        if ((size_t)n > MODEL_RPC_WIRE_MAX - wire) break;
        wire += (size_t)n;
        for (ssize_t i = 0; i < n; i++) {
            unsigned char c = (unsigned char)input[i];
            if (phase == 0) { if (c != '"') goto invalid; phase = 1; continue; }
            if (phase == 2) { if (c != '}') goto invalid; phase = 3; continue; }
            if (phase == 3) {
                if (c != '\n' || i + 1 != n) goto invalid;
                body[used] = '\0';
                if (!dtg_json_validate_complete(body, '{', error, error_size)) { free(body); return 0; }
                *result = body; return 1;
            }
            if (!have) {
                if (c == '"') { phase = 2; continue; }
                if (c < 0x20) goto invalid;
                if (c < 0x80 && c != '\\') {
                    if (used == MODEL_RPC_BODY_MAX) goto oversized;
                    body[used++] = (char)c; continue;
                }
                need = c == '\\' || (c >= 0xc2 && c <= 0xdf) ? 2 :
                       c >= 0xe0 && c <= 0xef ? 3 : c >= 0xf0 && c <= 0xf4 ? 4 : 0;
                if (!need) goto invalid;
                unit[0] = '"';
            }
            unit[1 + have++] = (char)c;
            if (have == 2 && unit[1] == '\\' && unit[2] == 'u') need = 6;
            if (have == 6 && need == 6) {
                unsigned scalar = dstudio_wire_hex4(unit + 3);
                if (scalar >= 0xd800 && scalar <= 0xdbff) need = 12;
            }
            if (have == need) {
                char decoded[5]; size_t count = 0;
                unit[1 + have] = '"';
                if (!dstudio_wire_string_decode(unit, unit + have + 2, decoded, sizeof decoded, &count)) goto invalid;
                if (count > MODEL_RPC_BODY_MAX - used) goto oversized;
                memcpy(body + used, decoded, count); used += count; have = need = 0;
            }
        }
    }
    goto invalid;
oversized:
    failure = "Internal model request exceeds the 16 MiB body limit";
invalid:
    free(body); snprintf(error, error_size, "%s", failure); return 0;
}

/* The local endpoint is pinned by the owner, and its body must name the same
 * model. Decode only in the private worker: at most 32768 JSON tokens (640 KiB),
 * released before network I/O. Nested prose cannot select another checkpoint. */
static int model_rpc_bound_model(const char *body, const char *expected) {
    char error[128];
    if (!dtg_json_validate_complete(body, '{', error, sizeof error)) return 0;
    dtg_json_token *tokens = calloc(32768, sizeof *tokens);
    if (!tokens) return 0;
    int count = dtg_json_tokenize(body, strlen(body), tokens, 32768);
    int children = 0, found = 0, valid = count > 0;
    for (int i = 1; valid && i + 1 < count; i++) {
        if (tokens[i].parent != 0 || (children++ & 1)) continue;
        char key[128];
        if (!dtg_json_token_string(body, &tokens[i], key, sizeof key)) { valid = 0; break; }
        if (strcmp(key, "model")) continue;
        char value[128];
        valid = !found++ && dtg_json_token_string(body, &tokens[i + 1], value, sizeof value) && !strcmp(value, expected);
    }
    free(tokens);
    return valid && found == 1;
}

static int model_rpc_worker_cli(int argc) {
    if (argc != 2) return 2;
#ifndef _WIN32
    if (getpgrp() != getpid()) return 2;
    signal(SIGPIPE, SIG_IGN);
#endif
    char header[4096], expected_model[128] = ""; size_t count = 0;
    do {
        if (count + 1 >= sizeof header || !model_rpc_worker_read(header + count, 1)) return 2;
    } while (header[count++] != '\n');
    header[count] = '\0';
    model_rpc_job job = {0}; long id = -1, length = -1, encoded = 0;
    if (json_get_int(header, "id", 0, INT_MAX, &id) <= 0 ||
        json_get_int(header, "bytes", 0, MODEL_RPC_BODY_MAX, &length) <= 0 ||
        json_get_string(header, "url", job.base_url, sizeof job.base_url) <= 0 ||
        json_get_string(header, "key", job.api_key, sizeof job.api_key) <= 0) return 2;
    if (json_get_int(header, "encoded", 0, 1, &encoded) < 0 ||
        (encoded ? length != 0 : length == 0)) return 2;
    json_get_string(header, "expectedModel", expected_model, sizeof expected_model);
    memset(header, 0, sizeof header);
    job.id = (int)id; job.framed_output = 1;
#ifdef _WIN32
    job.in_fd = (int)(intptr_t)GetStdHandle(STD_OUTPUT_HANDLE);
#else
    job.in_fd = STDOUT_FILENO;
#endif
    char error[512] = "";
    int prepared;
    if (encoded) prepared = model_rpc_worker_body(&job.body, error, sizeof error);
    else {
        job.body = malloc((size_t)length + 1);
        prepared = job.body && model_rpc_worker_read(job.body, (size_t)length);
        if (prepared) job.body[length] = '\0';
        else snprintf(error, sizeof error, "Incomplete private model request");
    }
#ifndef _WIN32
    pthread_t guard;
    if (prepared) {
        if (pthread_create(&guard, NULL, model_rpc_worker_guard, NULL)) { free(job.body); return 2; }
        pthread_detach(guard);
    }
#endif
    int identity_ok = !expected_model[0] || (prepared && model_rpc_bound_model(job.body, expected_model));
    if (prepared && !identity_ok)
        snprintf(error, sizeof error, "The tool request does not name the admitted local model, or exceeds its JSON identity limit");
    int ok = prepared && identity_ok && model_rpc_http_stream(&job, error, sizeof error);
    int delivered = model_rpc_write_frame(&job, ok ? "model_done" : "model_error",
                                         ok ? "finish_reason" : NULL, ok ? job.finish_reason : error);
    model_rpc_release(&job); free(job.body);
    memset(job.api_key, 0, sizeof job.api_key);
    if (!delivered) return 2;
    if (!prepared) return 2; /* No descendants exist; the owner still reaps us. */
    /* Keep ownership of the group until the parent has the full terminal
     * receipt and terminates/reaps us. No PID-reuse window or orphan curl. */
    for (;;) {
#ifdef _WIN32
        Sleep(1000);
#else
        pause();
#endif
    }
}

static int model_rpc_spawn_worker(model_rpc_relay *j) {
    if (!model_rpc_owner_matches(j) || !g_launch_executable[0]) return 0;
    if (!model_rpc_pipe_nonblock(j->runtime_fd, &j->saved_flags)) return 0;
    j->flags_changed = 1;
#ifdef _WIN32
    SECURITY_ATTRIBUTES sa = {sizeof sa, NULL, TRUE};
    HANDLE ir = NULL, iw = NULL, or = NULL, ow = NULL, null = INVALID_HANDLE_VALUE;
    HANDLE job = CreateJobObjectA(NULL, NULL);
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = {0};
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    STARTUPINFOEXA si = {0}; PROCESS_INFORMATION pi = {0};
    int attributes_initialized = 0;
    SIZE_T attributes_size = 0;
    if (!job || !SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof limits) ||
        !CreatePipe(&ir, &iw, &sa, 0) || !CreatePipe(&or, &ow, &sa, 0)) goto fail;
    null = CreateFileA("NUL", GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE, &sa, OPEN_EXISTING, 0, NULL);
    if (null == INVALID_HANDLE_VALUE || !SetHandleInformation(iw, HANDLE_FLAG_INHERIT, 0) ||
        !SetHandleInformation(or, HANDLE_FLAG_INHERIT, 0)) goto fail;
    InitializeProcThreadAttributeList(NULL, 1, 0, &attributes_size);
    si.lpAttributeList = malloc(attributes_size);
    if (!si.lpAttributeList || !InitializeProcThreadAttributeList(si.lpAttributeList, 1, 0, &attributes_size)) goto fail;
    attributes_initialized = 1;
    HANDLE handles[] = {ir, ow, null};
    if (!UpdateProcThreadAttribute(si.lpAttributeList, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
                                   handles, sizeof handles, NULL, NULL)) goto fail;
    si.StartupInfo.cb = sizeof si; si.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    si.StartupInfo.hStdInput = ir; si.StartupInfo.hStdOutput = ow; si.StartupInfo.hStdError = null;
    char command[2 * DSTUDIO_PATH_MAX + 64];
    snprintf(command, sizeof command, "\"%s\" --model-rpc-worker", g_launch_executable);
    if (!CreateProcessA(g_launch_executable, command, NULL, NULL, TRUE,
                        CREATE_SUSPENDED | CREATE_NO_WINDOW | EXTENDED_STARTUPINFO_PRESENT,
                        NULL, NULL, &si.StartupInfo, &pi)) goto fail;
    if (!AssignProcessToJobObject(job, pi.hProcess)) {
        TerminateProcess(pi.hProcess, 1); CloseHandle(pi.hThread); CloseHandle(pi.hProcess); goto fail;
    }
    if (ResumeThread(pi.hThread) == (DWORD)-1) {
        TerminateProcess(pi.hProcess, 1); CloseHandle(pi.hThread); CloseHandle(pi.hProcess); goto fail;
    }
    CloseHandle(pi.hThread);
    DeleteProcThreadAttributeList(si.lpAttributeList); free(si.lpAttributeList);
    CloseHandle(ir); CloseHandle(ow); CloseHandle(null);
    j->worker = (pid_t)pi.hProcess; j->worker_job = job;
    j->input = (int)(intptr_t)iw; j->output = (int)(intptr_t)or;
    int ignored = 0;
    if (!model_rpc_pipe_nonblock(j->input, &ignored)) { model_rpc_stop_worker(j); return 0; }
    return 1;
fail:
    if (attributes_initialized) DeleteProcThreadAttributeList(si.lpAttributeList);
    free(si.lpAttributeList);
    if (job) CloseHandle(job);
    if (ir) CloseHandle(ir); if (iw) CloseHandle(iw); if (or) CloseHandle(or); if (ow) CloseHandle(ow);
    if (null != INVALID_HANDLE_VALUE) CloseHandle(null);
    return 0;
#else
    int input[2] = {-1, -1}, output[2] = {-1, -1}, null = -1;
    if (pipe(input) || pipe(output) || (null = open("/dev/null", O_WRONLY)) < 0) goto fail;
    long maxfd = sysconf(_SC_OPEN_MAX); if (maxfd < 0) maxfd = 1024;
    char *args[] = {g_launch_executable, "--model-rpc-worker", NULL};
    pid_t child = fork();
    if (child < 0) goto fail;
    if (!child) {
        if (setpgid(0, 0) || dup2(input[0], STDIN_FILENO) < 0 ||
            dup2(output[1], STDOUT_FILENO) < 0 || dup2(null, STDERR_FILENO) < 0) _exit(127);
        for (int fd = 3; fd < maxfd; fd++) close(fd);
        execv(args[0], args); _exit(127);
    }
    (void)setpgid(child, child);
    close(input[0]); close(output[1]); close(null);
    j->worker = child; j->input = input[1]; j->output = output[0];
    fcntl(j->input, F_SETFD, FD_CLOEXEC); fcntl(j->output, F_SETFD, FD_CLOEXEC);
    int ignored = 0;
    if (!model_rpc_pipe_nonblock(j->input, &ignored) || !model_rpc_pipe_nonblock(j->output, &ignored)) {
        model_rpc_stop_worker(j); return 0;
    }
    return 1;
fail:
    for (int i = 0; i < 2; i++) { if (input[i] >= 0) close(input[i]); if (output[i] >= 0) close(output[i]); }
    if (null >= 0) close(null);
    return 0;
#endif
}

static model_rpc_relay *model_rpc_new_relay(int id, char *body) {
    model_rpc_relay *j = calloc(1, sizeof *j);
    if (!j) { free(body); return NULL; }
    j->id = id; j->runtime = g_child; j->runtime_fd = g_in_fd;
    j->epoch = ++g_model_rpc_epoch;
    j->worker = j->input = j->output = -1;
    j->body = body;
    j->body_len = body ? strnlen(body, MODEL_RPC_BODY_MAX + 1) : 0;
    j->deadline = model_rpc_now_ms() + MODEL_RPC_DEADLINE_MS;
    return j;
}

static int model_rpc_start(int id, char *body, int encoded) {
    model_rpc_tick();
    char local_url[96] = "";
    pid_t resident = 0;
    unsigned long long generation = q36_rpc_owner(&resident, local_url, sizeof local_url);
    if (g_in_fd < 0 || g_child <= 0 || g_model_rpc_next ||
        (!generation && !g_remote_base_url[0]) ||
        (g_model_rpc && !g_model_rpc->canceled)) { free(body); return 0; }
    model_rpc_relay *j = model_rpc_new_relay(id, body);
    if (!j) return 0;
    j->encoded = encoded;
    j->resident = resident; j->resident_generation = generation;
    if (!encoded && (!j->body_len || j->body_len > MODEL_RPC_BODY_MAX)) {
        model_rpc_relay_fail(j, "Internal model request exceeds the 16 MiB body limit");
    } else {
        json_dyn_buf metadata = {0};
        int ok = json_dyn_printf(&metadata, "{\"id\":%d,\"bytes\":%zu,\"encoded\":%d,\"url\":", id, j->body_len, encoded) &&
            json_dyn_put_escaped(&metadata, generation ? local_url : g_remote_base_url) && json_dyn_puts(&metadata, ",\"key\":") &&
            json_dyn_put_escaped(&metadata, generation ? "" : g_remote_api_key) &&
            json_dyn_puts(&metadata, ",\"expectedModel\":") &&
            json_dyn_put_escaped(&metadata, generation ? "qwen3.8-27b" : "") && json_dyn_puts(&metadata, "}\n");
        if (ok && metadata.len < sizeof j->metadata) {
            memcpy(j->metadata, metadata.ptr, metadata.len); j->metadata_len = metadata.len;
        } else model_rpc_relay_fail(j, "Internal model request metadata is invalid or too large");
        if (metadata.ptr) memset(metadata.ptr, 0, metadata.len);
        free(metadata.ptr);
    }
    if (g_model_rpc) { g_model_rpc_next = j; return 1; }
    g_model_rpc = j;
    if (!j->have_final && !model_rpc_spawn_worker(j)) model_rpc_relay_fail(j, "Could not start the model transport worker");
    return 1;
}

static model_rpc_relay *model_rpc_input_owner(unsigned long long epoch) {
    model_rpc_relay *j = g_model_rpc_next ? g_model_rpc_next : g_model_rpc;
    return j && j->epoch == epoch && model_rpc_owner_matches(j) && j->encoded &&
           !j->canceled && !j->stopping && !j->input_complete ? j : NULL;
}

static size_t model_rpc_input_room(unsigned long long epoch) {
    model_rpc_relay *j = model_rpc_input_owner(epoch);
    if (!j) return SIZE_MAX; /* revoked input is discarded through its newline */
    return j->upload_len == j->upload_sent ? sizeof j->upload : sizeof j->upload - j->upload_len;
}

static size_t model_rpc_input_append(unsigned long long epoch, const char *bytes, size_t count) {
    model_rpc_relay *j = model_rpc_input_owner(epoch);
    if (!j) return count;
    if (j->upload_len == j->upload_sent) j->upload_len = j->upload_sent = 0;
    size_t room = sizeof j->upload - j->upload_len;
    if (count > room) count = room;
    if (count > MODEL_RPC_WIRE_MAX - j->wire_bytes) {
        model_rpc_relay_fail(j, "Internal model request exceeds its encoded wire limit");
        return count;
    }
    memcpy(j->upload + j->upload_len, bytes, count);
    j->upload_len += count; j->wire_bytes += count;
    if (count && bytes[count - 1] == '\n') j->input_complete = 1;
    return count;
}

static void model_rpc_send_start_error(long id, const char *message) {
    if (g_in_fd < 0) return;
    /* Invalid concurrent requests fail the admitted request, without
     * interleaving another frame into an in-flight JSON record. */
    model_rpc_relay *j = g_model_rpc_next ? g_model_rpc_next : g_model_rpc;
    if (!j || j->canceled) {
        j = model_rpc_new_relay((int)id, NULL);
        if (!j) return;
        if (g_model_rpc) g_model_rpc_next = j; else g_model_rpc = j;
    }
    model_rpc_relay_fail(j, message);
}

static int model_rpc_deliver(model_rpc_relay *j, const char *bytes, size_t length, size_t *sent) {
    if (!model_rpc_owner_matches(j) || j->canceled) return -1;
    if (!j->flags_changed) {
        if (!model_rpc_pipe_nonblock(j->runtime_fd, &j->saved_flags)) return -1;
        j->flags_changed = 1;
    }
    ssize_t n = model_rpc_pipe_write(j->runtime_fd, bytes + *sent, length - *sent);
    if (n < 0 && (errno == EINTR || errno == EAGAIN || errno == EWOULDBLOCK)) return 0;
    if (n <= 0) return -1;
    *sent += (size_t)n;
    return *sent == length;
}

static void model_rpc_tick(void) {
    model_rpc_relay *j = g_model_rpc;
    if (!j) return;
    if (!j->canceled && !model_rpc_owner_matches(j)) { model_rpc_cancel(); j = g_model_rpc; }
    if (!j->canceled && j->have_final && model_rpc_now_ms() >= j->delivery_deadline) {
        const char *reason = "Runtime stopped consuming its model response";
        if (g_active_turn_task) {
            task_mark_failed(g_active_turn_task, reason, reason); g_active_turn_task = 0;
        }
        request_child_stop();
        cstr_copy(g_engine_err, sizeof g_engine_err, reason);
        return;
    }
    if (!j->canceled && !j->have_final && model_rpc_now_ms() >= j->deadline)
        model_rpc_relay_fail(j, "Model request exceeded its 30 minute deadline");
    if (j->stopping && j->worker > 0) {
        if (j->stop_deadline && model_rpc_now_ms() >= j->stop_deadline) {
#ifdef _WIN32
            (void)TerminateJobObject(j->worker_job, 1);
#else
            (void)kill(-j->worker, SIGKILL);
#endif
            j->stop_deadline = 0;
        }
        int status = 0;
        if (waitpid(j->worker, &status, WNOHANG) == j->worker) j->worker = -1;
    }
    if (j->worker <= 0 && (j->canceled || j->have_final)) {
        if (!j->canceled) {
            int delivered = model_rpc_deliver(j, j->final, j->final_len, &j->final_sent);
            if (!delivered) return;
            if (delivered < 0) { model_rpc_cancel(); j = g_model_rpc; }
        }
        model_rpc_free_relay(j); g_model_rpc = g_model_rpc_next; g_model_rpc_next = NULL;
        j = g_model_rpc;
        if (j && !j->have_final && !model_rpc_spawn_worker(j)) model_rpc_relay_fail(j, "Could not start the model transport worker");
        return;
    }
    if (j->stopping) return;
    size_t budget = MODEL_RPC_PASS_BYTES;
    while (budget && j->input >= 0 && (j->metadata_sent < j->metadata_len || j->body_sent < j->body_len || j->upload_sent < j->upload_len)) {
        int metadata = j->metadata_sent < j->metadata_len;
        const char *bytes = metadata ? j->metadata : j->encoded ? j->upload : j->body;
        size_t *sent = metadata ? &j->metadata_sent : j->encoded ? &j->upload_sent : &j->body_sent;
        size_t left = (metadata ? j->metadata_len : j->encoded ? j->upload_len : j->body_len) - *sent;
        if (left > budget) left = budget;
        ssize_t n = model_rpc_pipe_write(j->input, bytes + *sent, left);
        if (n < 0 && (errno == EINTR || errno == EAGAIN || errno == EWOULDBLOCK)) break;
        if (n <= 0) {
            /* A validator can reject before consuming the whole upload. Its
             * terminal error may already be waiting in the other pipe. Stop
             * uploading, then drain that receipt (or detect output EOF/crash)
             * instead of overwriting the actual failure with an EPIPE error. */
            close(j->input); j->input = -1;
            break;
        }
        *sent += (size_t)n; budget -= (size_t)n;
    }
    if (j->body && j->body_sent == j->body_len) { free(j->body); j->body = NULL; memset(j->metadata, 0, sizeof j->metadata); }
    budget = MODEL_RPC_PASS_BYTES;
    while (budget) {
        if (j->bytes_sent < j->bytes_len) {
            int delivered = model_rpc_deliver(j, j->bytes, j->bytes_len, &j->bytes_sent);
            if (delivered < 0) model_rpc_cancel();
            if (delivered <= 0) return;
            j->bytes_sent = j->bytes_len = 0;
        }
        if (!j->frame_left) {
            char byte;
            ssize_t n = model_rpc_pipe_read(j->output, &byte, 1);
            if (n < 0 && (errno == EINTR || errno == EAGAIN || errno == EWOULDBLOCK)) return;
            if (n <= 0) { model_rpc_relay_fail(j, "Model worker exited without a terminal receipt"); return; }
            budget--;
            if (j->header_len + 1 >= sizeof j->header) { model_rpc_relay_fail(j, "Invalid model worker frame header"); return; }
            j->header[j->header_len++] = byte;
            if (byte != '\n') continue;
            j->header[j->header_len] = '\0';
            char kind = j->header[0], *end = NULL;
            unsigned long count = strtoul(j->header + 2, &end, 10);
            if ((kind != 'D' && kind != 'F') || j->header[1] != ' ' ||
                end == j->header + 2 || strcmp(end, "\n") || !count || count > MODEL_RPC_FRAME_MAX ||
                (kind == 'F' && count > sizeof j->final)) {
                model_rpc_relay_fail(j, "Invalid model worker frame size"); return;
            }
            j->header_len = 0; j->frame_left = count; j->final_frame = kind == 'F';
            continue;
        }
        size_t count = j->frame_left;
        size_t capacity = j->final_frame ? sizeof j->final - j->final_len : sizeof j->bytes;
        if (count > capacity) count = capacity;
        if (count > budget) count = budget;
        char *target = j->final_frame ? j->final + j->final_len : j->bytes;
        ssize_t n = model_rpc_pipe_read(j->output, target, count);
        if (n < 0 && (errno == EINTR || errno == EAGAIN || errno == EWOULDBLOCK)) return;
        if (n <= 0) { model_rpc_relay_fail(j, "Model worker exited during a frame"); return; }
        j->frame_left -= (size_t)n; budget -= (size_t)n;
        if (j->final_frame) {
            j->final_len += (size_t)n;
            if (!j->frame_left) { j->have_final = 1; model_rpc_stop_worker(j); return; }
        } else { j->bytes_len = (size_t)n; j->bytes_sent = 0; }
    }
}

static int model_rpc_pollfds(struct pollfd *fds) {
    model_rpc_relay *j = g_model_rpc;
    if (!j || j->canceled) return 0;
    int count = 0;
    if (!j->stopping && j->input >= 0 && (j->metadata_sent < j->metadata_len || j->body_sent < j->body_len || j->upload_sent < j->upload_len))
        fds[count++] = (struct pollfd){.fd = j->input, .events = POLLOUT};
    if (!j->stopping && j->bytes_sent == j->bytes_len)
        fds[count++] = (struct pollfd){.fd = j->output, .events = POLLIN};
    if (j->bytes_sent < j->bytes_len || (j->worker <= 0 && j->have_final))
        fds[count++] = (struct pollfd){.fd = j->runtime_fd, .events = POLLOUT};
    return count;
}

static void model_rpc_shutdown(void) {
    model_rpc_cancel();
    /* Shutdown only; interactive Stop uses nonblocking tick/reap. */
    while (g_model_rpc) { model_rpc_tick(); if (g_model_rpc) usleep(1000); }
}

static void interrupt_piped_runtime(void) {
    model_rpc_cancel();
#ifdef _WIN32
    /* A Stop frame must not block the HTTP owner behind a full model pipe.
     * It shares this bounded delivery path and follows cancellation/reaping.
     * The newline terminates any old partially delivered data frame. */
    model_rpc_relay *j = model_rpc_new_relay(0, NULL);
    if (!j) return;
    static const char control[] = "\n\x1e{\"type\":\"control\",\"name\":\"interrupt\"}\n";
    memcpy(j->final, control, sizeof control - 1);
    j->final_len = sizeof control - 1; j->have_final = j->stopping = 1;
    j->delivery_deadline = model_rpc_now_ms() + 30000;
    if (g_model_rpc) g_model_rpc_next = j; else g_model_rpc = j;
#else
    if (g_child > 0) kill(g_child, SIGINT);
#endif
}

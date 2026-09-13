/* Real host request worker and sockets; the remote model is a barrier fixture.
 * This deliberately reuses an OS descriptor, not a mocked generation number. */
#define main dstudio_embedded_main
#include "../../src/dstudio.c"
#undef main

static pid_t owned_peers[8];
static size_t owned_peer_count;
static void retain_peer(pid_t pid) {
    if (pid > 0 && owned_peer_count < sizeof owned_peers / sizeof *owned_peers)
        owned_peers[owned_peer_count++] = pid;
}
static void cleanup_owned_processes(void) {
    model_rpc_shutdown();
    for (size_t i = 0; i < owned_peer_count; i++) {
        int status;
        /* A still-owned, unreaped child cannot have had its PID reused. */
        if (waitpid(owned_peers[i], &status, WNOHANG) == 0) {
            kill(owned_peers[i], SIGKILL);
            while (waitpid(owned_peers[i], &status, 0) < 0 && errno == EINTR) {}
        }
    }
}

static void require(int ok, const char *message) {
    if (!ok) { fprintf(stderr, "FAIL: %s (%s)\n", message, strerror(errno)); exit(2); }
}

static const char response[] =
    "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n"
    "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"OLD RESPONSE\"},\"finish_reason\":null}]}\n\n"
    "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n"
    "data: [DONE]\n\n";

static void wait_barrier(int fd, char expected) {
    char received = 0;
    long long deadline = dstudio_now_ms() + 4000;
    while (!received && dstudio_now_ms() < deadline) {
        drain_child();
        if (read(fd, &received, 1) != 1) received = 0;
        if (!received) usleep(1000);
    }
    require(received == expected, "network/process barrier reached");
}

static int runtime_interrupt_fd;
static void runtime_interrupt(int sig) { (void)sig; (void)write(runtime_interrupt_fd, "I", 1); }

static int written_pipe_flags_oracle(void) {
    /* Independent POSIX oracle: Darwin adds FWASWRITTEN after the first write.
     * F_SETFL cannot remove that kernel-owned history bit. Compare equivalent
     * I/O, without masking arbitrary differences or assuming a numeric value. */
    int p[2]; require(!pipe(p), "unmodified pipe oracle");
    int original = fcntl(p[1], F_GETFL);
    require(original >= 0 && !fcntl(p[1], F_SETFL, original | O_NONBLOCK), "oracle nonblocking mode");
    char bytes[4096] = {0};
    while (write(p[1], bytes, sizeof bytes) > 0) {}
    require(errno == EAGAIN && !fcntl(p[1], F_SETFL, original), "restore original flags on independent pipe");
    int result = fcntl(p[1], F_GETFL);
    printf("{\"case\":\"independent-written-pipe-flags\",\"before\":%d,\"afterWriteAndRestore\":%d}\n", original, result);
    close(p[0]); close(p[1]); return result;
}

static void check_admission_and_pressure(void) {
    int runtime[2], interrupted[2], admitted[2], release[2];
    require(!pipe(runtime) && !pipe(interrupted) && !pipe(admitted) && !pipe(release), "pressure fixture pipes");
    int listener = socket(AF_INET, SOCK_STREAM, 0);
    struct sockaddr_in address = {0}; address.sin_family = AF_INET;
    address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    require(listener >= 0 && !bind(listener, (struct sockaddr *)&address, sizeof address) && !listen(listener, 2), "pressure endpoint");
    socklen_t size = sizeof address;
    require(!getsockname(listener, (struct sockaddr *)&address, &size), "pressure endpoint identity");
    snprintf(g_remote_base_url, sizeof g_remote_base_url, "http://127.0.0.1:%d", ntohs(address.sin_port));
    fflush(NULL);
    pid_t actor = fork(); require(actor >= 0, "owned unresponsive runtime fixture");
    if (!actor) {
        close(listener); close(runtime[0]); close(runtime[1]); close(interrupted[0]);
        close(admitted[0]); close(admitted[1]); close(release[0]); close(release[1]);
        runtime_interrupt_fd = interrupted[1];
        struct sigaction action = {0}; action.sa_handler = runtime_interrupt;
        sigaction(SIGINT, &action, NULL);
        if (!fd_write_all(interrupted[1], "A", 1)) _exit(3);
        for (;;) pause();
    }
    retain_peer(actor);
    close(interrupted[1]); set_nonblock(interrupted[0]);
    wait_barrier(interrupted[0], 'A');
    pid_t peer = fork(); require(peer >= 0, "independent two-request network peer");
    if (!peer) {
        close(runtime[0]); close(runtime[1]); close(interrupted[0]); close(admitted[0]); close(release[1]);
        for (int round = 0; round < 2; round++) {
            int client = accept(listener, NULL, NULL);
            char request[8192] = ""; size_t count = 0;
            while (client >= 0 && count + 1 < sizeof request) {
                ssize_t n = read(client, request + count, sizeof request - count - 1);
                if (n <= 0) _exit(4);
                count += (size_t)n; request[count] = '\0';
                if (strstr(request, "\r\n\r\n{}")) break;
            }
            const char *credential = round ? "Authorization: Bearer new-fixture-key\r\n" : "Authorization: Bearer old-fixture-key\r\n";
            if (client < 0 || !strstr(request, credential) || !fd_write_all(admitted[1], "R", 1)) _exit(4);
            char command;
            if (read(release[0], &command, 1) != 1) _exit(4);
            if (!round) (void)fd_write_all(client, response, sizeof response - 1);
            else {
                const char prefix[] = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\ndata: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"";
                const char suffix[] = "\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n";
                char bytes[4096]; memset(bytes, 'X', sizeof bytes);
                if (!fd_write_all(client, prefix, sizeof prefix - 1)) _exit(4);
                for (int i = 0; i < 128; i++) if (!fd_write_all(client, bytes, sizeof bytes)) _exit(4);
                if (!fd_write_all(client, suffix, sizeof suffix - 1)) _exit(4);
            }
            close(client);
        }
        close(listener); _exit(0);
    }
    retain_peer(peer);
    close(listener); close(admitted[1]); close(release[0]);
    set_nonblock(admitted[0]); set_nonblock(runtime[0]);
    g_child = actor; g_mode = ENGINE_AGENT; g_in_fd = runtime[1]; g_ready = g_agent_working = 1;
    g_interrupt_pending = 0;
    int original_flags = fcntl(g_in_fd, F_GETFL);
    int written_flags = written_pipe_flags_oracle();
    cstr_copy(g_remote_api_key, sizeof g_remote_api_key, "old-fixture-key");
    /* A listener created after both fixtures fork must not leak to the helper. */
    int sentinel = socket(AF_INET, SOCK_STREAM, 0);
    address.sin_port = 0;
    require(sentinel >= 0 && !bind(sentinel, (struct sockaddr *)&address, sizeof address) && !listen(sentinel, 1), "sentinel listener");
    require(!getsockname(sentinel, (struct sockaddr *)&address, &size), "sentinel identity");
    require(model_rpc_start(21, strdup("{}"), 0), "admit captured-credential request");
    cstr_copy(g_remote_api_key, sizeof g_remote_api_key, "new-fixture-key");
    wait_barrier(admitted[0], 'R');
    close(sentinel);
    sentinel = socket(AF_INET, SOCK_STREAM, 0);
    require(sentinel >= 0 && !bind(sentinel, (struct sockaddr *)&address, sizeof address), "model worker did not inherit a host listener");
    close(sentinel);
    pid_t first_worker = g_model_rpc->worker;
    for (int i = 0; i < 100; i++) require(!model_rpc_start(100 + i, strdup("{}"), 0), "active duplicate rejected before spawning");
    require(g_model_rpc->worker == first_worker && !g_model_rpc_next, "one worker, no duplicate pending request");
    /* Prevent graceful exit to exercise the actual asynchronous escalation. */
    require(!kill(first_worker, SIGSTOP), "stop only the task-owned model helper at its barrier");
    char filler[4096]; memset(filler, 'Q', sizeof filler);
    while (write(g_in_fd, filler, sizeof filler) > 0) {}
    require(errno == EAGAIN, "runtime pipe saturated");
    model_rpc_cancel();
    require(g_model_rpc->saved_flags == original_flags && fcntl(g_in_fd, F_GETFL) == written_flags,
            "Stop restores the same flags as an independent written pipe");
    require(model_rpc_start(22, strdup("{}"), 0), "one next request admitted while old helper is reaped");
    require(g_model_rpc_next && g_model_rpc_next->worker == -1 && g_model_rpc->worker == first_worker,
            "next request cannot start a second worker before reaping");
    for (int i = 0; i < 100; i++) require(!model_rpc_start(300 + i, strdup("{}"), 0), "pending admission is bounded");
    while (read(runtime[0], filler, sizeof filler) > 0) {}
    require(fd_write_all(release[1], "G", 1), "release canceled peer");
    wait_barrier(admitted[0], 'R');
    require(kill(first_worker, 0) < 0 && errno == ESRCH, "old process reaped before new network request");
    require(fd_write_all(release[1], "G", 1), "release large streamed response");
    long long deadline = dstudio_now_ms() + 3000;
    while (dstudio_now_ms() < deadline) {
        drain_child();
        if (g_model_rpc && g_model_rpc->bytes_sent < g_model_rpc->bytes_len) {
            struct pollfd writable = {.fd = g_in_fd, .events = POLLOUT};
            require(poll(&writable, 1, 0) >= 0, "inspect full output pipe");
            if (!(writable.revents & POLLOUT)) break;
        }
        usleep(1000);
    }
    require(g_model_rpc && g_model_rpc->bytes_sent < g_model_rpc->bytes_len, "real large frame is backpressured");
    size_t staged = g_model_rpc->bytes_len;
    require(staged <= 16384, "bounded delivery staging");
    int http[2]; require(!socketpair(AF_UNIX, SOCK_STREAM, 0, http), "HTTP control probe");
    api_agent_interrupt(http[0], "{}"); close(http[0]);
    char receipt[1024] = ""; ssize_t n = read(http[1], receipt, sizeof receipt - 1);
    require(n > 0 && strstr(receipt, "200 OK"), "HTTP Stop responds while model output pipe is full");
    close(http[1]); wait_barrier(interrupted[0], 'I');
    model_rpc_shutdown();
    require(fcntl(g_in_fd, F_GETFL) == written_flags, "backpressured cancellation matches the independent pipe oracle");
    int status;
    require(waitpid(peer, &status, 0) == peer && WIFEXITED(status) && WEXITSTATUS(status) == 0, "peer checked both captured credentials and wrote full large fixture");
    require(!kill(actor, SIGTERM) && waitpid(actor, &status, 0) == actor, "reap only the owned runtime fixture");
    close_pipes(); close(runtime[0]); close(interrupted[0]); close(admitted[0]); close(release[1]);
    g_child = -1; g_ready = g_agent_working = g_interrupt_pending = 0; g_mode = ENGINE_NONE; g_remote_api_key[0] = '\0';
    printf("{\"case\":\"bounded-admission-credentials-full-pipe-stop\",\"pass\":true,\"rejectedDuplicates\":200,\"maxWorkers\":1,\"stagedBytes\":%zu,\"httpStatus\":200}\n", staged);
}

static void check_worker_failure_and_limits(void) {
    for (int scenario = 0; scenario < 3; scenario++) {
        int runtime[2]; require(!pipe(runtime), "error-delivery runtime pipe");
        set_nonblock(runtime[0]);
        g_in_fd = runtime[1]; g_child = getpid(); g_mode = ENGINE_AGENT;
        g_agent_working = 1; g_interrupt_pending = 0;
        cstr_copy(g_remote_base_url, sizeof g_remote_base_url, "http://127.0.0.1:1");
        char *body;
        if (scenario == 2) {
            body = malloc(MODEL_RPC_BODY_MAX + 2); require(body != NULL, "oversized bounded fixture");
            memset(body, 'x', MODEL_RPC_BODY_MAX + 1); body[MODEL_RPC_BODY_MAX + 1] = '\0';
        } else body = strdup("{}");
        require(model_rpc_start(31 + scenario, body, 0), "admit request or its explicit error");
        pid_t worker = g_model_rpc->worker;
        if (!scenario) require(worker > 0 && !kill(worker, SIGKILL), "explicit owned helper crash");
        else if (scenario == 1) g_model_rpc->deadline = model_rpc_now_ms();
        else require(worker == -1, "oversized body cannot launch any network worker");
        char receipt[8192] = ""; size_t count = 0;
        long long deadline = dstudio_now_ms() + 3000;
        while (dstudio_now_ms() < deadline) {
            drain_child();
            ssize_t n = read(runtime[0], receipt + count, sizeof receipt - count - 1);
            if (n > 0) count += (size_t)n;
            else if (!g_model_rpc) break;
            if (n <= 0) usleep(1000);
        }
        require(!g_model_rpc && strstr(receipt, "\"type\":\"model_error\"") &&
                !strstr(receipt, "\"type\":\"model_done\""), "failure produces error, never completion");
        if (scenario == 1) require(strstr(receipt, "deadline") != NULL, "deadline error remains explicit");
        if (scenario == 2) require(strstr(receipt, "16 MiB") != NULL, "body limit remains explicit");
        if (worker > 0) require(kill(worker, 0) < 0 && errno == ESRCH, "failed worker reaped");
        close_pipes(); close(runtime[0]);
        printf("{\"case\":\"%s\",\"pass\":true,\"errorReceiptBytes\":%zu}\n",
                scenario == 0 ? "worker-crash" : scenario == 1 ? "request-deadline" : "body-byte-limit", count);
    }
    g_child = -1; g_mode = ENGINE_NONE; g_agent_working = 0;
    g_interrupt_pending = 1;
    const char stale[] = "\x1e{\"type\":\"model_request\",\"id\":99,\"body\":\"{}\"}\n";
    require(drain_child_stdout_data(stale, sizeof stale - 1) == sizeof stale - 1, "consume stale queued request");
    require(!g_model_rpc && !g_model_rpc_next, "a request queued before Stop cannot create a late worker");
    g_interrupt_pending = 0;
    puts("{\"case\":\"request-queued-before-stop\",\"pass\":true}");
}

int main(int argc, char **argv) {
    if (argc > 1) return dstudio_embedded_main(argc, argv);
    signal(SIGPIPE, SIG_IGN);
    atexit(cleanup_owned_processes);
    alarm(15);
    require(realpath(argv[0], g_launch_executable) != NULL, "resolve this exact host build");
    printf("{\"layout\":\"model-rpc\",\"ownerBytes\":%zu,\"workerJobBytes\":%zu,\"maxQueuedBodyBytes\":%u,\"deliveryStagingBytes\":%zu}\n",
            sizeof(model_rpc_relay), sizeof(model_rpc_job), 2 * MODEL_RPC_BODY_MAX, sizeof g_model_rpc->bytes);
    int listener = socket(AF_INET, SOCK_STREAM, 0);
    struct sockaddr_in address = {0};
    address.sin_family = AF_INET;
    address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    require(listener >= 0 && !bind(listener, (struct sockaddr *)&address, sizeof address) &&
            !listen(listener, 1), "listen on task-owned ephemeral endpoint");
    socklen_t address_size = sizeof address;
    require(!getsockname(listener, (struct sockaddr *)&address, &address_size), "fixture endpoint");
    snprintf(g_remote_base_url, sizeof g_remote_base_url, "http://127.0.0.1:%d", ntohs(address.sin_port));
    int admitted[2], release[2], old_runtime[2], next_runtime[2];
    require(!pipe(admitted) && !pipe(release) && !pipe(old_runtime) && !pipe(next_runtime), "fixture pipes");
    g_in_fd = fcntl(old_runtime[1], F_DUPFD_CLOEXEC, 64);
    require(g_in_fd >= 64, "reserve an exact runtime descriptor for reuse");
    close(old_runtime[1]);
    pid_t peer = fork();
    require(peer >= 0, "fork independent network peer");
    if (!peer) {
        close(admitted[0]); close(release[1]); close(g_in_fd);
        close(old_runtime[0]); close(next_runtime[0]); close(next_runtime[1]);
        int client = accept(listener, NULL, NULL);
        char request[4096] = ""; size_t count = 0;
        while (client >= 0 && count + 1 < sizeof request) {
            ssize_t n = read(client, request + count, sizeof request - count - 1);
            if (n <= 0) _exit(3);
            count += (size_t)n; request[count] = '\0';
            if (strstr(request, "\r\n\r\n{}")) break;
        }
        if (client < 0 || !fd_write_all(admitted[1], "R", 1)) _exit(3);
        char command;
        if (read(release[0], &command, 1) != 1) _exit(3);
        /* A fixed implementation may already have closed the connection. */
        (void)fd_write_all(client, response, sizeof response - 1);
        close(client); close(listener); _exit(0);
    }
    retain_peer(peer);
    close(listener); close(admitted[1]); close(release[0]);
    g_child = getpid(); g_mode = ENGINE_AGENT; g_agent_working = 1;
    require(model_rpc_start(17, strdup("{}"), 0), "admit old request");
    set_nonblock(admitted[0]);
    char acknowledged = 0;
    long long deadline = dstudio_now_ms() + 3000;
    while (dstudio_now_ms() < deadline && !acknowledged) {
        drain_child();
        if (read(admitted[0], &acknowledged, 1) != 1) acknowledged = 0;
        if (!acknowledged) usleep(1000);
    }
    require(acknowledged == 'R', "HTTP request reached the barrier before replacing the runtime");
    int reused_fd = g_in_fd;
    close_pipes();
    require(dup2(next_runtime[1], reused_fd) == reused_fd, "reuse the precise old descriptor");
    close(next_runtime[1]); g_in_fd = reused_fd;
    require(fd_write_all(release[1], "G", 1), "release the old response only after descriptor reuse");
    set_nonblock(next_runtime[0]);
    char leaked[4096] = ""; size_t leaked_count = 0;
    deadline = dstudio_now_ms() + 500;
    while (dstudio_now_ms() < deadline) {
        drain_child();
        ssize_t n = read(next_runtime[0], leaked + leaked_count, sizeof leaked - leaked_count - 1);
        if (n > 0) leaked_count += (size_t)n;
        if (leaked_count || n == 0) break;
        usleep(1000);
    }
    int status = 0;
    require(waitpid(peer, &status, 0) == peer && WIFEXITED(status) && WEXITSTATUS(status) == 0,
            "fixture reached terminal state");
    close_pipes(); close(old_runtime[0]); close(next_runtime[0]); close(release[1]); close(admitted[0]);
    printf("{\"case\":\"late-response-after-exact-fd-reuse\",\"descriptor\":%d,\"leakedBytes\":%zu,\"pass\":%s}\n",
           reused_fd, leaked_count, leaked_count ? "false" : "true");
    if (leaked_count) fprintf(stderr, "Old response reached next runtime: %s\n", leaked);
    else {
        require(!g_model_rpc, "canceled request worker actually reaped");
        g_child = -1;
        check_admission_and_pressure();
        check_worker_failure_and_limits();
    }
    return leaked_count ? 1 : 0;
}

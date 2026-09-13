/* Actual HTTP interrupt handler and runtime pipe wait. Model data is a fixture;
 * only children created here are signalled. No engine or model weights. */
#include <assert.h>
#define main dstudio_embedded_main
#include "../../src/dstudio.c"
#undef main
#include "../../extension/remote/dstudio_remote_llm.h"

static volatile sig_atomic_t interrupted;
static void latch_interrupt(int sig) { (void)sig; interrupted = 1; }
static int is_interrupted(void *owner) { (void)owner; return interrupted != 0; }

static int read_line_timeout(int fd, char *text, size_t cap) {
    size_t n = 0;
    while (n + 1 < cap) {
        struct pollfd ready = {.fd = fd, .events = POLLIN};
        int result;
        do { result = poll(&ready, 1, 1000); } while (result < 0 && errno == EINTR);
        if (result <= 0 || read(fd, text + n, 1) != 1) return 0;
        if (text[n++] == '\n') { text[n] = 0; return 1; }
    }
    return 0;
}

static pid_t start_held_peer(int *admitted) {
    int listener = socket(AF_INET, SOCK_STREAM, 0), signal_pipe[2];
    struct sockaddr_in address = {0}; address.sin_family = AF_INET;
    address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    assert(listener >= 0 && !pipe(signal_pipe));
    assert(!bind(listener, (struct sockaddr *)&address, sizeof address) && !listen(listener, 1));
    socklen_t size = sizeof address;
    assert(!getsockname(listener, (struct sockaddr *)&address, &size));
    snprintf(g_remote_base_url, sizeof g_remote_base_url, "http://127.0.0.1:%d", ntohs(address.sin_port));
    fflush(NULL);
    pid_t child = fork(); assert(child >= 0);
    if (!child) {
        close(signal_pipe[0]);
        if (g_in_fd >= 0) close(g_in_fd);
        int client = accept(listener, NULL, NULL);
        char request[8192] = ""; size_t count = 0;
        while (client >= 0 && count + 1 < sizeof request) {
            ssize_t n = read(client, request + count, sizeof request - count - 1);
            if (n <= 0) _exit(3);
            count += (size_t)n; request[count] = '\0';
            char *end = strstr(request, "\r\n\r\n"), *length = strstr(request, "Content-Length: ");
            if (end && length && count >= (size_t)(end + 4 - request) + strtoul(length + 16, NULL, 10)) break;
        }
        if (client < 0 || !fd_write_all(signal_pipe[1], "R\n", 2)) _exit(3);
        char unexpected;
        ssize_t n;
        do { n = read(client, &unexpected, 1); } while (n < 0 && errno == EINTR);
        /* The actual request must be closed, not merely ignored by its UI. */
        close(client); close(listener); _exit(n == 0 || (n < 0 && errno == ECONNRESET) ? 0 : 4);
    }
    close(listener); close(signal_pipe[1]); *admitted = signal_pipe[0];
    set_nonblock(*admitted); return child;
}

static int check_mode(int mode, int structured, int path, int nonblocking) {
    int input[2], output[2], http[2];
    assert(!pipe(input) && !pipe(output) && !socketpair(AF_UNIX, SOCK_STREAM, 0, http));
    fflush(NULL);
    pid_t pid = fork(); assert(pid >= 0);
    if (!pid) {
        close(input[1]); close(output[0]); close(http[0]); close(http[1]);
        assert(dup2(input[0], STDIN_FILENO) == STDIN_FILENO);
        assert(dup2(output[1], STDOUT_FILENO) == STDOUT_FILENO);
        close(input[0]); close(output[1]);
        struct sigaction action = {0};
        action.sa_handler = latch_interrupt;
        action.sa_flags = SA_RESTART;
        sigemptyset(&action.sa_mask);
        assert(!sigaction(SIGINT, &action, NULL));
        int flags = fcntl(STDIN_FILENO, F_GETFL); assert(flags >= 0);
        if (nonblocking) { flags |= O_NONBLOCK; assert(!fcntl(STDIN_FILENO, F_SETFL, flags)); }
        char err[512] = "", *calls = NULL;
        int rc = structured ? dstudio_remote_chat_stream_tools("http://127.0.0.1:1", "fixture-qwen", "[]", "[]",
            0, 0, 1, 0, 64, NULL, NULL, is_interrupted, &calls, err, sizeof err) :
            dstudio_remote_chat_stream("http://127.0.0.1:1", "fixture-ds4", "[]", 0, 0, 1, 0, 64,
                NULL, NULL, is_interrupted, err, sizeof err);
        int restored = fcntl(STDIN_FILENO, F_GETFL) == flags;
        struct pollfd pending = {.fd = STDIN_FILENO, .events = POLLIN};
        int drained = poll(&pending, 1, 0) >= 0 && !(pending.revents & POLLIN);
        int ok = rc == 2 && calls == NULL && restored && drained;
        printf("result:%d:%d\n", rc, calls == NULL); fflush(stdout); free(calls);
        _exit(ok ? 0 : 1);
    }
    close(input[0]); close(output[1]);
    char request[4096], reply[512] = "", response[1024];
    assert(read_line_timeout(output[0], request, sizeof request)); /* Child is inside the model wait. */
    assert(strstr(request, "\"type\":\"model_request\""));
    g_child = pid; g_mode = mode; g_in_fd = input[1]; g_ready = g_agent_working = 1;
    if (structured) {
        const char *frame = "\x1e{\"type\":\"model_tool_calls\",\"id\":1,\"text\":\"[{\\\"id\\\":\\\"call-one\\\",\\\"type\\\":\\\"function\\\",\\\"function\\\":{\\\"name\\\":\\\"write\\\",\\\"arguments\\\":\\\"{}\\\"}}]\"}\n";
        assert(fd_write_all(input[1], frame, strlen(frame)));
    }
    if (nonblocking) {
        const char partial[] = "\x1e{\"type\":\"model_delta\",\"id\":1,\"text\":\"unfinished";
        assert(fd_write_all(input[1], partial, sizeof partial - 1));
    }
    int admitted;
    pid_t peer = start_held_peer(&admitted);
    assert(drain_child_stdout_data(request, strlen(request)) == strlen(request));
    assert(g_model_rpc);
    pid_t worker = g_model_rpc->worker; assert(worker > 0);
    char connected = 0; long long connection_deadline = dstudio_now_ms() + 3000;
    while (!connected && dstudio_now_ms() < connection_deadline) {
        drain_child();
        if (read(admitted, &connected, 1) != 1) connected = 0;
        if (!connected) usleep(1000);
    }
    assert(connected == 'R'); close(admitted);
    if (!path) {
        api_agent_interrupt(http[0], "{}"); close(http[0]);
        ssize_t n = read(http[1], response, sizeof response - 1); assert(n > 0); response[n] = 0;
        close(http[1]); assert(strstr(response, "200 OK"));
    } else {
        close(http[0]); close(http[1]);
        dtg_node node = {0};
        g_dtg_agent_owner_node = &node;
        if (path == 1) { assert(dtg_executor_cancel(NULL, &node, "fixture cancellation")); assert(node.native_cancel_requested); }
        else { dtg_watchdog_trip(&node, "fixture watchdog"); assert(node.watchdog_tripped); }
        g_dtg_agent_owner_node = NULL;
    }
    int replied = read_line_timeout(output[0], reply, sizeof reply);
    model_rpc_shutdown();
    int peer_status = 0;
    assert(waitpid(peer, &peer_status, 0) == peer && WIFEXITED(peer_status) && WEXITSTATUS(peer_status) == 0);
    assert(kill(worker, 0) < 0 && errno == ESRCH);
    close(input[1]); close(output[0]);
    g_in_fd = -1; g_child = -1; g_mode = ENGINE_NONE; g_remote_base_url[0] = 0;
    g_ready = g_agent_working = g_interrupt_pending = 0;
    int status = 0;
    pid_t result = waitpid(pid, &status, WNOHANG);
    if (!result) {
        if (!replied) assert(!kill(pid, SIGTERM));
        assert(waitpid(pid, &status, 0) == pid);
    } else assert(result == pid);
    int ok = replied && !strcmp(reply, "result:2:1\n") && WIFEXITED(status) && WEXITSTATUS(status) == 0;
    printf("%s %s %s %s %s — consumer wakes; HTTP closes; worker reaped; queued bytes discarded; flags restored\n",
        ok ? "PASS" : "FAIL", mode == ENGINE_AGENT ? "Agent" : mode == ENGINE_COWORK ? "Cowork" : "Design",
        structured ? "structured" : "legacy", path == 0 ? "HTTP" : path == 1 ? "graph-cancel" : "watchdog",
        nonblocking ? "nonblocking-partial" : "blocking-idle");
    return ok;
}

int main(int argc, char **argv) {
    if (argc > 1) return dstudio_embedded_main(argc, argv);
    assert(realpath(argv[0], g_launch_executable));
    signal(SIGPIPE, SIG_IGN);
    alarm(60);
    int passed = 0, modes[] = {ENGINE_AGENT, ENGINE_COWORK, ENGINE_DESIGN};
    for (unsigned i = 0; i < sizeof modes / sizeof *modes; i++)
        for (int structured = 0; structured < 2; structured++)
            for (int path = 0; path < 3; path++)
                for (int nonblocking = 0; nonblocking < 2; nonblocking++)
                    passed += check_mode(modes[i], structured, path, nonblocking);
    printf("model_rpc_interrupt: %d/36 (simulated inference)\n", passed);
    free(g_abuf);
    return passed == 36 ? 0 : 1;
}

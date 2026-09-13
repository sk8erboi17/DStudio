/* Native stdout admission, real pipes and an isolated HTTP peer. No weights. */
#define main dstudio_embedded_main
#include "../../src/dstudio.c"
#undef main
#include "../../extension/remote/dstudio_remote_llm.h"

static pid_t fixture_actor = -1;
static void cleanup(void) {
    model_rpc_shutdown();
    if (fixture_actor > 0) {
        int status;
        if (waitpid(fixture_actor, &status, WNOHANG) == 0) {
            kill(fixture_actor, SIGKILL);
            while (waitpid(fixture_actor, &status, 0) < 0 && errno == EINTR) {}
        }
    }
}
static void require(int ok, const char *why) {
    if (!ok) { fprintf(stderr, "FAIL: %s\n", why); exit(2); }
}

static volatile sig_atomic_t client_canceled;
static void client_interrupt(int sig) { (void)sig; client_canceled = 1; }
static int client_cancelled(void *unused) { (void)unused; return client_canceled != 0; }
static void client_delta(void *ud, const char *kind, const char *text, size_t length) {
    if (!strcmp(kind, "content")) json_dyn_putn(ud, text, length);
}

static void check_native_pipe(const char *url, int cancel) {
    int input[2], output[2]; require(!pipe(input) && !pipe(output), "native client pipes");
    fflush(NULL);
    fixture_actor = fork(); require(fixture_actor >= 0, "actual remote client fixture");
    if (!fixture_actor) {
        close(input[1]); close(output[0]);
        if (dup2(input[0], STDIN_FILENO) < 0 || dup2(output[1], STDOUT_FILENO) < 0) _exit(3);
        close(input[0]); close(output[1]);
        struct sigaction action = {0}; action.sa_handler = client_interrupt; sigaction(SIGINT, &action, NULL);
        const char pattern[] = "é 🦊 \\\"\n\x1e";
        size_t length = (sizeof pattern - 1) * 100000;
        char *text = malloc(length + 1); if (!text) _exit(3);
        for (size_t i = 0; i < 100000; i++) memcpy(text + i * (sizeof pattern - 1), pattern, sizeof pattern - 1);
        text[length] = '\0';
        dstudio_remote_buf messages = {0}; int count = 0;
        dstudio_remote_messages_append(&messages, &count, "user", text); free(text);
        char *snapshot = dstudio_remote_messages_snapshot(&messages);
        char error[512] = ""; json_dyn_buf answer = {0};
        int rc = dstudio_remote_chat_stream(url, "fixture-qwen", snapshot, 0, 0, 1, 0, 64,
                                           client_delta, &answer, client_cancelled, error, sizeof error);
        int good = cancel ? rc == 2 : rc == 0 && answer.ptr && !strcmp(answer.ptr, "INPUT_OK");
        printf("\x1e{\"type\":\"input_test_result\",\"rc\":%d,\"ok\":%s}\n", rc, good ? "true" : "false"); fflush(stdout);
        free(snapshot); dstudio_remote_buf_free(&messages); free(answer.ptr);
        _exit(good ? 0 : 3);
    }
    close(input[0]); close(output[1]);
    g_child = fixture_actor; g_in_fd = input[1]; g_out_fd = output[0]; set_nonblock(g_out_fd);
    g_mode = ENGINE_AGENT; g_agent_working = g_ready = 1;
    cstr_copy(g_remote_base_url, sizeof g_remote_base_url, url);
    pid_t stopped_worker = -1; size_t max_staged = 0, max_pending = 0;
    int interrupted = 0, status = 0, finished = 0; long long control_ms = -1;
    long long deadline = model_rpc_now_ms() + 8000;
    while (model_rpc_now_ms() < deadline) {
        drain_child();
        if (g_model_rpc) {
            if (cancel && !interrupted && stopped_worker <= 0) {
                stopped_worker = g_model_rpc->worker;
                require(stopped_worker > 0 && !kill(stopped_worker, SIGSTOP), "hold the verified owned upload worker");
            }
            size_t staged = g_model_rpc->upload_len - g_model_rpc->upload_sent;
            if (staged > max_staged) max_staged = staged;
            if (g_child_stdout_len - g_child_stdout_used > max_pending) max_pending = g_child_stdout_len - g_child_stdout_used;
            require(!g_model_rpc->body && g_child_event_line.len == 0, "owner never assembles a model body or full envelope");
            if (cancel && !interrupted && !child_stdout_can_drain()) {
                int http[2]; require(!socketpair(AF_UNIX, SOCK_STREAM, 0, http), "Stop HTTP fixture");
                long long start = model_rpc_now_ms(); api_agent_interrupt(http[0], "{}"); control_ms = model_rpc_now_ms() - start;
                close(http[0]); char receipt[1024] = "";
                ssize_t n = read(http[1], receipt, sizeof receipt - 1); close(http[1]);
                require(n > 0 && strstr(receipt, "200 OK"), "Stop is served with the upload worker intentionally blocked");
                interrupted = 1;
            }
        }
        if (waitpid(fixture_actor, &status, WNOHANG) == fixture_actor) { finished = 1; fixture_actor = -1; break; }
        usleep(1000);
    }
    require(finished && WIFEXITED(status) && WEXITSTATUS(status) == 0, "actual shared runtime validates reply or cancellation");
    drain_child();
    char marker[128];
    int marker_size = snprintf(marker, sizeof marker, "\x1e{\"type\":\"input_test_result\",\"rc\":%d,\"ok\":true}\n", cancel ? 2 : 0);
    require(g_abuf && g_alen == (size_t)marker_size && !memcmp(g_abuf, marker, (size_t)marker_size),
            "only the exact client result reaches the length-delimited transcript");
    if (cancel) require(interrupted && control_ms < 1000, "control deadline met without unblocking preparation");
    model_rpc_shutdown();
    if (stopped_worker > 0) require(kill(stopped_worker, 0) < 0 && errno == ESRCH, "blocked upload worker is actually reaped");
    printf("{\"case\":\"native-%s\",\"pass\":true,\"maxUploadStagingBytes\":%zu,\"maxRetainedStdoutBytes\":%zu,\"stopHttpMs\":%lld}\n",
           cancel ? "stop-upload" : "pipe", max_staged, max_pending, control_ms);
    close_pipes(); g_child = -1;
}

static void check_encoded_body(const char *name, int reply_fd) {
    FILE *input = tmpfile(); require(input != NULL, "encoded request fixture");
    const char header[] = "\x1e{\"type\":\"model_request\",\"id\":29,\"body\":";
    require(fwrite(header, 1, sizeof header - 1, input) == sizeof header - 1, "canonical request header");
    const char *body = NULL;
    if (!strcmp(name, "escaped-unicode")) body = "\"{\\\"x\\\":\\\"\\ud83e\\udd8a\\u4e16\\u754c\\\"}\"}\n";
    else if (!strcmp(name, "invalid-escape")) body = "\"{\\\"x\\\":\\\"\\z\\\"}\"}\n";
    else if (!strcmp(name, "lone-surrogate")) body = "\"{\\\"x\\\":\\\"\\ud83e\\\"}\"}\n";
    else if (!strcmp(name, "decoded-nul")) body = "\"{\\\"x\\\":\\\"\\u0000\\\"}\"}\n";
    else if (!strcmp(name, "duplicate-envelope-body")) body = "\"{}\",\"body\":\"{}\"}\n";
    else if (!strcmp(name, "truncated-envelope")) body = "\"{\\\"x\\\":\\\"unterminated";
    else if (!strcmp(name, "invalid-body-json")) body = "\"{bad json}\"}\n";
    else if (!strcmp(name, "decoded-body-limit") || !strcmp(name, "decoded-body-limit-early")) {
        require(fputs("\"{\\\"x\\\":\\\"", input) >= 0, "large body start");
        char bytes[8192]; memset(bytes, 'X', sizeof bytes);
        size_t payload = MODEL_RPC_BODY_MAX + (!strcmp(name, "decoded-body-limit-early") ? MODEL_RPC_BODY_MAX / 2 : 0);
        for (size_t i = 0; i < payload / sizeof bytes; i++)
            require(fwrite(bytes, 1, sizeof bytes, input) == sizeof bytes, "oversized body payload");
        body = "\\\"}\"}\n";
    }
    require(body && fputs(body, input) >= 0 && !fflush(input) && !fseek(input, 0, SEEK_SET), "complete test fixture");
    g_out_fd = fileno(input); set_nonblock(reply_fd);
    char receipt[8192] = ""; size_t count = 0, max_staging = 0;
    long long deadline = model_rpc_now_ms() + 8000;
    do {
        drain_child();
        if (g_model_rpc) {
            require(!g_model_rpc->body && g_child_event_line.len == 0, "model envelope remains off the control owner");
            size_t staged = g_model_rpc->upload_len - g_model_rpc->upload_sent;
            if (staged > max_staging) max_staging = staged;
        }
        ssize_t n = read(reply_fd, receipt + count, sizeof receipt - count - 1);
        if (n > 0) count += (size_t)n;
        if (!g_model_rpc && count) break;
        usleep(1000);
    } while (model_rpc_now_ms() < deadline);
    int success = !strcmp(name, "escaped-unicode");
    require(!g_model_rpc && strstr(receipt, success ? "model_done" : "model_error"), "correct terminal outcome from the actual worker");
    if (!success) require(!strstr(receipt, "model_done"), "invalid body cannot be promoted to completion");
    if (!strncmp(name, "decoded-body-limit", 18)) {
        if (!strstr(receipt, "16 MiB")) fprintf(stderr, "Actual size-limit receipt: %s\n", receipt);
        require(strstr(receipt, "16 MiB") != NULL, "decoded size bound has an explicit error");
    }
    printf("{\"case\":\"%s\",\"pass\":true,\"maxUploadStagingBytes\":%zu,\"error\":%s}\n", name, max_staging, success ? "false" : "true");
    g_out_fd = -1; fclose(input);
}

int main(int argc, char **argv) {
    if (argc == 2 && !strcmp(argv[1], "--model-rpc-worker")) return dstudio_embedded_main(argc, argv);
    require(argc == 2 || argc == 3, "case argument and optional fixture endpoint");
    signal(SIGPIPE, SIG_IGN); atexit(cleanup); alarm(10);
    require(realpath(argv[0], g_launch_executable) != NULL, "exact host executable");
    printf("{\"layout\":\"model-rpc-input\",\"ownerBytes\":%zu,\"uploadStagingBytes\":%zu,\"retainedStdoutBytes\":%zu,\"workerDecodedBodyLimit\":%u}\n",
           sizeof(model_rpc_relay), sizeof g_model_rpc->upload, sizeof g_child_stdout_pending, MODEL_RPC_BODY_MAX);
    if (!strncmp(argv[1], "native-", 7)) {
        require(argc == 3, "native HTTP endpoint");
        check_native_pipe(argv[2], !strcmp(argv[1], "native-stop-upload")); return 0;
    }
    int runtime[2]; require(!pipe(runtime), "runtime reply pipe");
    fixture_actor = fork(); require(fixture_actor >= 0, "owned runtime fixture");
    if (!fixture_actor) { close(runtime[0]); close(runtime[1]); for (;;) pause(); }
    g_child = fixture_actor; g_in_fd = runtime[1]; g_mode = ENGINE_AGENT;
    g_agent_working = g_ready = 1;
    cstr_copy(g_remote_base_url, sizeof g_remote_base_url, argc == 3 ? argv[2] : "http://127.0.0.1:1");

    if (!strcmp(argv[1], "stop-in-header")) {
        const char first[] = "\x1e{\"type\":\"model_request\",\"id\":";
        const char last[] = "91,\"body\":\"{}\"}\n";
        require(drain_child_stdout_data(first, sizeof first - 1) == sizeof first - 1, "first header fragment");
        model_rpc_cancel(); /* the same epoch invalidation used by Stop/WAITING */
        require(drain_child_stdout_data(last, sizeof last - 1) == sizeof last - 1, "late header fragment");
        require(!g_model_rpc && !g_model_rpc_next && !g_alen, "a stale fragmented header cannot gain a new admission identity");
        puts("{\"case\":\"stop-in-header\",\"pass\":true}"); return 0;
    }
    if (!strcmp(argv[1], "invalid-header-id")) {
        const char bad[] = "\x1e{\"type\":\"model_request\",\"id\":2147483648,\"body\":\"{}\"}\n";
        require(drain_child_stdout_data(bad, sizeof bad - 1) == sizeof bad - 1, "invalid header consumed once");
        require(!g_model_rpc && g_child_stop_requested && strstr(g_engine_err, "header"), "unidentifiable request is an explicit runtime failure");
        puts("{\"case\":\"invalid-header-id\",\"pass\":true}"); return 0;
    }
    if (!strcmp(argv[1], "terminal-delivery-deadline")) {
        const char bad[] = "\x1e{\"type\":\"model_request\",\"id\":30,\"body\":\"{invalid}\"}\n";
        require(drain_child_stdout_data(bad, sizeof bad - 1) == sizeof bad - 1 && g_model_rpc, "admit request before saturating its reply pipe");
        char filler[4096]; memset(filler, 'Q', sizeof filler);
        while (write(g_in_fd, filler, sizeof filler) > 0) {}
        require(errno == EAGAIN, "reply pipe is actually full");
        long long deadline = model_rpc_now_ms() + 3000;
        while (model_rpc_now_ms() < deadline && (!g_model_rpc->have_final || g_model_rpc->worker > 0)) {
            model_rpc_tick(); usleep(1000);
        }
        require(g_model_rpc && g_model_rpc->have_final && g_model_rpc->worker <= 0 &&
                g_model_rpc->final_sent < g_model_rpc->final_len, "complete terminal receipt is blocked only on its runtime");
        g_model_rpc->delivery_deadline = model_rpc_now_ms(); /* deterministic monotonic deadline fault */
        model_rpc_tick();
        require(g_child_stop_requested && strstr(g_engine_err, "stopped consuming"), "delivery expiry fails/stops the owned runtime instead of reporting completion");
        model_rpc_shutdown();
        puts("{\"case\":\"terminal-delivery-deadline\",\"pass\":true}"); return 0;
    }
    if (!strcmp(argv[1], "early-worker-error")) {
        const char header[] = "\x1e{\"type\":\"model_request\",\"id\":35,\"body\":";
        require(drain_child_stdout_data(header, sizeof header - 1) == sizeof header - 1 && g_model_rpc, "admit early-error fixture");
        pid_t worker = g_model_rpc->worker;
        require(worker > 0 && !kill(worker, SIGSTOP), "hold only the owned helper before its body read");
        char invalid[8192]; memset(invalid, 'X', sizeof invalid); /* not a quoted body */
        int full = 0;
        for (int i = 0; i < 512 && !full; i++) {
            drain_child_stdout_data(invalid, sizeof invalid); model_rpc_tick();
            struct pollfd writable = {.fd = g_model_rpc->input, .events = POLLOUT};
            require(poll(&writable, 1, 0) >= 0, "observe helper request-pipe pressure");
            full = !child_stdout_can_drain() && !(writable.revents & POLLOUT);
        }
        require(full && !g_model_rpc->have_final, "owned upload is backpressured before preparation is released");
        require(!kill(worker, SIGCONT), "release the owned body validator");
        siginfo_t info = {0}; long long deadline = model_rpc_now_ms() + 3000;
        do {
            require(!waitid(P_PID, (id_t)worker, &info, WEXITED | WNOHANG | WNOWAIT), "observe exit without reaping or losing process identity");
            if (!info.si_pid) usleep(1000);
        } while (!info.si_pid && model_rpc_now_ms() < deadline);
        require(info.si_pid == worker, "worker has written its error and exited before the owner resumes upload");
        set_nonblock(runtime[0]); char receipt[8192] = ""; size_t count = 0;
        deadline = model_rpc_now_ms() + 3000;
        do {
            model_rpc_tick();
            ssize_t n = read(runtime[0], receipt + count, sizeof receipt - count - 1);
            if (n > 0) count += (size_t)n;
            if (!g_model_rpc && count) break;
            usleep(1000);
        } while (model_rpc_now_ms() < deadline);
        if (!strstr(receipt, "envelope")) fprintf(stderr, "Actual early-worker receipt: %s\n", receipt);
        require(!g_model_rpc && strstr(receipt, "model_error") && strstr(receipt, "envelope") && !strstr(receipt, "model_done"),
                "closed upload pipe must not overwrite the worker's already-produced failure receipt");
        puts("{\"case\":\"early-worker-error\",\"pass\":true}"); return 0;
    }
    if (!strcmp(argv[1], "display-byte-limit")) {
        const char prefix[] = "\x1e{\"type\":\"tool_result\",\"output\":\"";
        require(drain_child_stdout_data(prefix, sizeof prefix - 1) == sizeof prefix - 1, "display prefix");
        char bytes[8192]; memset(bytes, 'X', sizeof bytes);
        for (size_t i = 0; i < AGENT_BUF_CAP / sizeof bytes; i++)
            require(drain_child_stdout_data(bytes, sizeof bytes) == sizeof bytes, "bounded display data consumption");
        require(!g_model_rpc && g_child_stop_requested && strstr(g_engine_err, "4 MiB") &&
                g_child_event_line.len <= AGENT_BUF_CAP && !g_alen, "oversized display record is an explicit failure, not a truncated successful tool event");
        puts("{\"case\":\"display-byte-limit\",\"pass\":true}"); return 0;
    }

    if (!strcmp(argv[1], "nested-data")) {
        const char event[] = "\x1e{\"type\":\"artifact\",\"data\":{\"type\":\"model_request\",\"id\":91,\"body\":\"{}\"}}\n";
        drain_child_stdout_data(event, sizeof event - 1);
        int no_request = !g_model_rpc && !g_model_rpc_next;
        int preserved = g_alen == sizeof event - 1 && !memcmp(g_abuf, event, sizeof event - 1);
        printf("{\"case\":\"nested-data\",\"networkRequestAdmitted\":%s,\"dataPreserved\":%s,\"pass\":%s}\n",
               no_request ? "false" : "true", preserved ? "true" : "false", no_request && preserved ? "true" : "false");
        return no_request && preserved ? 0 : 1;
    }
    if (strcmp(argv[1], "read-budget")) { check_encoded_body(argv[1], runtime[0]); return 0; }
    FILE *input = tmpfile(), *errors = tmpfile(); require(input && errors, "task-owned anonymous stdout/stderr fixtures");
    char bytes[8192]; memset(bytes, 'x', sizeof bytes);
    for (int i = 0; i < 64; i++) require(fwrite(bytes, 1, sizeof bytes, input) == sizeof bytes &&
                                          fwrite(bytes, 1, sizeof bytes, errors) == sizeof bytes, "prepare continuous stdout and stderr");
    require(!fflush(input) && !fseek(input, 0, SEEK_SET) && !fflush(errors) && !fseek(errors, 0, SEEK_SET), "rewind fixtures");
    g_out_fd = fileno(input); g_err_fd = fileno(errors);
    drain_child();
    off_t consumed = lseek(g_out_fd, 0, SEEK_CUR);
    off_t errors_consumed = lseek(g_err_fd, 0, SEEK_CUR);
    int bounded = consumed > 0 && consumed <= 65536 && errors_consumed > 0 && errors_consumed <= 65536;
    printf("{\"case\":\"read-budget\",\"availableBytesPerPipe\":524288,\"firstPassBytes\":%lld,\"stderrPassBytes\":%lld,\"pass\":%s}\n",
           (long long)consumed, (long long)errors_consumed, bounded ? "true" : "false");
    if (bounded) {
        for (int i = 0; i < 16; i++) drain_child();
        require(g_alen == 524288 && !memcmp(g_abuf, bytes, sizeof bytes), "bounded passes preserve all stdout bytes");
        for (size_t i = 0; i < g_alen; i++) require(g_abuf[i] == 'x', "stdout ordering and integrity");
    }
    g_out_fd = g_err_fd = -1; fclose(input); fclose(errors);
    return bounded ? 0 : 1;
}

/* Production HTTP/SSE relay, deterministic peer. No engine or model weights. */
#define main dstudio_embedded_main
#include "../../src/dstudio.c"
#undef main
#include "../../extension/remote/dstudio_remote_llm.h"

static volatile sig_atomic_t probe_cancel;
static void request_cancel(int sig) { (void)sig; probe_cancel = 1; }

static void runtime_delta(void *ud, const char *kind, const char *text, size_t len) {
    (void)ud; (void)len;
    model_rpc_job output = {.id = 0, .in_fd = STDOUT_FILENO};
    model_rpc_write_frame(&output, "probe_delta", kind, text);
}

int main(int argc, char **argv) {
    if (argc > 1 && !strcmp(argv[1], "--model-rpc-worker")) return dstudio_embedded_main(argc, argv);
    if (argc != 2 && argc != 3) return 2;
    signal(SIGPIPE, SIG_IGN);
    if (argc == 3 && !strcmp(argv[2], "--owner-relay")) {
        signal(SIGUSR1, request_cancel);
        int runtime[2];
        if (pipe(runtime) || !realpath(argv[0], g_launch_executable)) return 2;
        set_nonblock(runtime[0]);
        g_child = getpid(); g_mode = ENGINE_AGENT; g_in_fd = runtime[1]; g_agent_working = 1;
        cstr_copy(g_remote_base_url, sizeof g_remote_base_url, argv[1]);
        const char request[] = "\x1e{\"type\":\"model_request\",\"id\":17,\"body\":\"{\\\"model\\\":\\\"fixture-qwen\\\",\\\"messages\\\":[{\\\"role\\\":\\\"user\\\",\\\"content\\\":\\\"test\\\"}],\\\"stream\\\":true}\"}\n";
        if (drain_child_stdout_data(request, sizeof request - 1) != sizeof request - 1 || !g_model_rpc) return 2;
        pid_t worker = g_model_rpc->worker;
        int terminal = 0, failed = 0;
        json_dyn_buf line = {0};
        long long deadline = dstudio_now_ms() + 9000;
        for (;;) {
            if (probe_cancel) model_rpc_cancel();
            drain_child();
            char bytes[16384]; ssize_t n = read(runtime[0], bytes, sizeof bytes);
            if (n > 0) {
                if (!fd_write_all(STDOUT_FILENO, bytes, (size_t)n)) return 2;
                for (ssize_t i = 0; i < n; i++) {
                    json_dyn_putn(&line, bytes + i, 1);
                    if (bytes[i] == '\n') {
                        char type[64] = "";
                        json_get_string(line.ptr, "type", type, sizeof type);
                        if (!strcmp(type, "model_error")) { terminal++; failed = 1; }
                        if (!strcmp(type, "model_done")) terminal++;
                        line.len = 0; line.ptr[0] = '\0';
                    }
                }
            } else if (!g_model_rpc) break;
            if (dstudio_now_ms() >= deadline) { failed = 1; break; }
            if (n <= 0) usleep(1000);
        }
        model_rpc_shutdown(); close_pipes(); close(runtime[0]); free(line.ptr);
        if (probe_cancel) {
            printf("\x1e{\"type\":\"probe_canceled\",\"workerPid\":%d,\"terminalFrames\":%d}\n", (int)worker, terminal);
            return terminal ? 1 : 0;
        }
        return failed || terminal != 1 ? 1 : 0;
    }
    if (argc == 3) {
        char error[512] = "", *calls = NULL;
        int legacy = !strcmp(argv[2], "legacy");
        const char *messages = "[{\"role\":\"user\",\"content\":\"Tool request é 🦊\"}]";
        const char *schemas = "[{\"type\":\"function\",\"function\":{\"name\":\"write\",\"parameters\":{\"type\":\"object\",\"properties\":{\"path\":{\"type\":\"string\"},\"content\":{\"type\":\"string\"}}}}}]";
        int rc = legacy ? dstudio_remote_chat_stream(argv[1], "fixture-qwen", messages, 0,
            0, 1, 0, 256, runtime_delta, NULL, NULL, error, sizeof error) :
            dstudio_remote_chat_stream_tools(argv[1], "fixture-qwen", messages, schemas, 0,
                0, 1, 0, 256, runtime_delta, NULL, NULL, &calls, error, sizeof error);
        json_dyn_buf out = {0};
        json_dyn_printf(&out, "\x1e{\"type\":\"probe_result\",\"rc\":%d,\"calls\":", rc);
        json_dyn_puts(&out, calls ? calls : "null");
        json_dyn_puts(&out, ",\"error\":"); json_dyn_put_escaped(&out, error);
        json_dyn_puts(&out, "}\n"); fd_write_all(STDOUT_FILENO, out.ptr, out.len);
        free(out.ptr); free(calls);
        return 0;
    }
    model_rpc_job job = {0};
    job.id = 17;
    job.in_fd = STDOUT_FILENO;
    cstr_copy(job.base_url, sizeof job.base_url, argv[1]);
    job.body = "{\"model\":\"fixture-qwen\",\"messages\":[{\"role\":\"user\",\"content\":\"test\"}],\"stream\":true}";
    char err[512] = "";
    int ok = model_rpc_http_stream(&job, err, sizeof err);
    model_rpc_write_frame(&job, ok ? "model_done" : "model_error", ok ? "finish_reason" : NULL, ok ? job.finish_reason : err);
    model_rpc_release(&job);
    return ok ? 0 : 1;
}

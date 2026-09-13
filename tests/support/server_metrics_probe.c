/* Real native JSON/SSE serializers with controlled counters; no inference. */
#define DS4_SERVER_TEST
#define DS4_SERVER_TEST_NO_MAIN
#include "ds4_server.c"

int main(int argc, char **argv) {
    if (argc != 3) return 2;
    const int scenario = atoi(argv[1]);
    request r = {0};
    r.kind = REQ_CHAT;
    r.model = "metrics-fixture";
    r.api = API_OPENAI;
    r.stream = true;
    r.stream_include_usage = scenario != 4;
    r.cache_read_tokens = scenario == 3 ? 70 : 7;
    r.cache_write_tokens = scenario == 3 ? 30 : 3;
#ifdef METRICS_PATCHED
    r.ds4_decode_tokens_per_second = scenario == 1 ? 0.0 : scenario == 2 ? -1.0 : 2.5;
    r.ds4_decode_elapsed_seconds = 0.8;
#endif
    if (strcmp(argv[2], "json") == 0) {
        buf b = {0};
        append_openai_usage_json(&b, scenario == 5 ? NULL : &r, 10, 2);
        if (fwrite(b.ptr, 1, b.len, stdout) != b.len) return 3;
        buf_free(&b);
    } else if (strcmp(argv[2], "sse") == 0) {
        int pair[2];
        if (socketpair(AF_UNIX, SOCK_STREAM, 0, pair) != 0) return 4;
        if (!sse_done(pair[0], &r, "metrics-probe", 10, 2)) return 5;
        shutdown(pair[0], SHUT_WR);
        char bytes[4096];
        ssize_t count;
        while ((count = read(pair[1], bytes, sizeof bytes)) > 0)
            if (fwrite(bytes, 1, (size_t)count, stdout) != (size_t)count) return 6;
        close(pair[0]); close(pair[1]);
        if (count < 0) return 7;
    } else return 2;
    return 0;
}

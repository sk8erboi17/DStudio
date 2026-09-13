/* Compile beside the actual derived Agent source with its normal native link.
 * No engine, network request or model is started by these renderer checks. */
#define DS4_AGENT_TEST
#define DS4_AGENT_TEST_NO_MAIN
#include "agent-runtime.c"
#include <assert.h>

int main(void) {
    ds4_agent_unit_tests_run();
    assert(agent_test_failures == 0);
    const char *text = "<think>planning</think>final answer";
    size_t checks = 0;
    for (int mode = 0; mode < 3; mode++) {
        for (size_t split = 0; split <= strlen(text); split++) {
            agent_config cfg = {.jsonl = mode == 2};
            agent_worker worker = {.cfg = &cfg, .wake_fd = {-1, -1}};
            assert(pthread_mutex_init(&worker.mu, NULL) == 0);
            agent_tail_capture capture = {.cap = 16384};
            agent_token_renderer renderer = {
                .worker = mode ? &worker : NULL, .capture = &capture,
                .format_thinking = true, .last_output_newline = true
            };
            agent_dsml_parser parser = {.syntax = AGENT_TOOL_SYNTAX_DSML, .state = AGENT_DSML_SEARCH};
            agent_stream_renderer stream = {.renderer = &renderer, .parser = &parser,
                                             .syntax = AGENT_TOOL_SYNTAX_DSML};
            agent_stream_text(&stream, text, split, false);
            agent_stream_text(&stream, text + split, strlen(text) - split, false);
            agent_stream_text(&stream, NULL, 0, true);
            renderer_finish(&renderer);
            char *visible = agent_tail_capture_take(&capture, NULL);
            assert(strstr(visible, "planning") && strstr(visible, "final answer"));
            assert(!strstr(visible, "<think>") && !strstr(visible, "</think>"));
            assert(!stream.in_think && !renderer.in_think);
            if (mode == 2) {
                assert(worker.out && !strcmp(worker.out,
                    "\x1e{\"type\":\"reasoning_start\"}\n"
                    "\x1e{\"type\":\"reasoning_end\"}\n"));
            } else assert(!worker.out_len);
            free(visible); free(worker.out); agent_dsml_parser_free(&parser);
            pthread_mutex_destroy(&worker.mu);
            checks++;
        }
    }
    printf("Renderer: %zu fragmented-stream checks PASS, native unit suite PASS; no inference\n", checks);
    return 0;
}

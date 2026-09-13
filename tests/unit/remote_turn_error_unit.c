/* Execute the native stderr/control owner: an errored turn may become idle,
 * but WAITING is not a success receipt. No process/model needs to be started. */
#define main dstudio_embedded_main
#include "../../src/dstudio.c"
#undef main
#include <assert.h>

/* Consume records produced by the native Agent, not reconstructed JSON: field
 * order must not let a changing transport ID evade the existing watchdog. */
static int watchdog_calls(void) {
    dtg_node node = {0};
    g_dtg_agent_owner_node = &node;
    char *line = NULL; size_t capacity = 0; unsigned count = 0;
    while (getline(&line, &capacity, stdin) >= 0) {
        assert(++count <= 4);
        dtg_watchdog_observe_event_line(line);
        assert(node.watchdog_tool_calls == count);
        assert(node.watchdog_repeated_calls == count);
        assert(node.watchdog_tripped == (count == 4));
    }
    free(line); g_dtg_agent_owner_node = NULL;
    assert(count == 4);
    puts("native emitted calls: fourth identical action stopped despite distinct IDs");
    return 0;
}

static void graph_turn(int failed) {
    char workspace[] = "tests/.artifacts/remote-owner-XXXXXX", resolved[PATH_MAX];
    mkpath("tests/.artifacts");
    assert(mkdtemp(workspace) && realpath(workspace, resolved));
    json_dyn_buf body = {0}; char error[512] = "";
    assert(json_dyn_puts(&body, "{\"schemaVersion\":1,\"policy\":\"agent.general.v1\",\"mode\":\"agent\",\"executorMode\":\"native\",\"goal\":\"Owner error regression\",\"workspace\":"));
    assert(json_dyn_put_escaped(&body, resolved));
    assert(json_dyn_puts(&body, ",\"nodes\":[{\"id\":\"turn\",\"kind\":\"agent_turn\",\"title\":\"Turn\",\"mutation\":\"read_only\",\"action\":{\"name\":\"agent.prompt\",\"text\":\"Read only\"}}]}"));
    dtg_runtime *rt = dtg_store_create(body.ptr, 0, error, sizeof error);
    free(body.ptr);
    if (!rt) fprintf(stderr, "graph fixture: %s\n", error);
    assert(rt);
    int input[2]; assert(pipe(input) == 0);
    /* Simulated runtime transport. No engine is launched or signalled. */
    g_child = getpid(); g_in_fd = input[1]; g_mode = ENGINE_AGENT;
    g_ready = 1; g_agent_working = g_agent_session_working = 0;
    cstr_copy(g_workdir, sizeof g_workdir, resolved);
    assert(dtg_scheduler_start(rt, error, sizeof error));
    dtg_scheduler_tick(dstudio_now_ms());
    dtg_node *node = dtg_find_node(&rt->graph, "turn");
    assert(node && node == g_dtg_agent_owner_node && node->operation_task_id);
    unsigned long long id = node->operation_task_id;
    const char *frames = failed ? "+DSTUDIO_TURN_ERROR\n+DWARFSTAR_WAITING\n" : "+DWARFSTAR_WAITING\n";
    char accumulator[256] = ""; size_t length = 0;
    scan_lines(frames, strlen(frames), accumulator, &length, 1);
    assert(!g_agent_working && g_ready);
    assert(!strcmp(task_find(id)->status, failed ? "failed" : "completed"));
    for (int i = 0; i < 3; i++) dtg_scheduler_tick(dstudio_now_ms() + i);
    assert(!g_dtg_agent_owner_node);
    assert(node->state == (failed ? DTG_NODE_FAILED : DTG_NODE_SUCCEEDED));
    assert(rt->graph.state == (failed ? DTG_GRAPH_FAILED : DTG_GRAPH_SUCCEEDED));
    assert(!strcmp(task_find(id)->status, failed ? "failed" : "completed"));
    char result_path[DTG_STORE_PATH_MAX]; size_t bytes = 0;
    assert(dtg_attempt_file(rt, node, "turn_a1", "result", result_path, sizeof result_path, error, sizeof error));
    char *result = dtg_read_file_bounded(result_path, 8192, &bytes, error, sizeof error);
    dtg_json_token tokens[128];
    assert(result && dtg_json_validate_complete(result, '{', error, sizeof error));
    int count = dtg_json_tokenize(result, bytes, tokens, 128);
    assert(count > 0);
    int at = dtg_json_object_field(result, tokens, count, 0, "ok");
    assert(at >= 0 && dtg_json_primitive_eq(result, &tokens[at], failed ? "false" : "true"));
    free(result);
    char graph_id[DTG_ID_MAX + 1]; cstr_copy(graph_id, sizeof graph_id, rt->graph.id);
    dtg_registry_forget(rt);
    rt = dtg_store_load(resolved, graph_id, error, sizeof error);
    assert(rt && rt->graph.state == (failed ? DTG_GRAPH_FAILED : DTG_GRAPH_SUCCEEDED));
    assert(dtg_find_node(&rt->graph, "turn")->state == (failed ? DTG_NODE_FAILED : DTG_NODE_SUCCEEDED));
    dtg_registry_forget(rt);
    close(input[0]); close(input[1]); g_child = 0; g_in_fd = -1;
    printf("graph %s: task, node, result receipt and durable replay agree (%s)\n", failed ? "error" : "success", workspace);
}

int main(int argc, char **argv) {
    if (argc == 2 && !strcmp(argv[1], "--watchdog-calls")) return watchdog_calls();
    const char frames[] = "+DSTUDIO_TURN_ERROR\n+DWARFSTAR_WAITING\n";
    size_t checks = 0;
    for (size_t split = 0; split <= sizeof frames - 1; split++) {
        g_mode = ENGINE_AGENT; g_agent_working = 1; g_ready = 0;
        unsigned long long id = task_begin("agent", "error fixture", "agent", ENGINE_AGENT, ".", 0, 1);
        g_active_turn_task = id;
        char accumulator[512] = ""; size_t length = 0;
        scan_lines(frames, split, accumulator, &length, 1);
        scan_lines(frames + split, sizeof frames - 1 - split, accumulator, &length, 1);
        dstudio_task *task = task_find(id);
        assert(task && !strcmp(task->status, "failed"));
        assert(task->completed_ms && !task->cancelable && !g_active_turn_task);
        assert(g_ready && !g_agent_working);
        checks++;
    }
    const char *ignored[] = {"quoted +DSTUDIO_TURN_ERROR\n", "+DSTUDIO_TURN_ERROR suffix\n"};
    for (int i = 0; i < 3; i++) {
        unsigned long long id = task_begin("agent", "continued fixture", "agent", ENGINE_AGENT, ".", 0, 1);
        g_active_turn_task = id;
        char accumulator[512] = ""; size_t length = 0;
        const char *text = i < 2 ? ignored[i] : "+DSTUDIO_TURN_ERROR\n";
        scan_lines(text, strlen(text), accumulator, &length, i < 2);
        assert(g_active_turn_task == id && !strcmp(task_find(id)->status, "submitted"));
        text = "+DWARFSTAR_WAITING\n";
        scan_lines(text, strlen(text), accumulator, &length, 1);
        assert(!g_active_turn_task && !strcmp(task_find(id)->status, "completed"));
        checks++;
    }
    printf("remote_turn_error: %zu split-frame/error/next-turn checks PASS\n", checks);
    graph_turn(0);
    graph_turn(1);
    return 0;
}

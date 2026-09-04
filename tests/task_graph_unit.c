#ifndef _GNU_SOURCE
#define _GNU_SOURCE
#endif

#include <assert.h>
#include <stdio.h>
#include <string.h>

#define main dstudio_embedded_main_for_task_graph_tests
#include "../src/dstudio.c"
#undef main

static int checks = 0;
#define CHECK(expr) do { checks++; if (!(expr)) { \
    fprintf(stderr, "CHECK failed at %s:%d: %s\n", __FILE__, __LINE__, #expr); exit(1); \
} } while (0)

static void remove_tree(const char *path) {
    DIR *dir = opendir(path);
    if (!dir) { unlink(path); return; }
    struct dirent *entry;
    char child[PATH_MAX];
    while ((entry = readdir(dir)) != NULL) {
        if (!strcmp(entry->d_name, ".") || !strcmp(entry->d_name, "..")) continue;
        snprintf(child, sizeof child, "%s/%s", path, entry->d_name);
        struct stat st;
        if (lstat(child, &st) == 0 && S_ISDIR(st.st_mode)) remove_tree(child);
        else unlink(child);
    }
    closedir(dir);
    rmdir(path);
}

static char *graph_json(const char *workspace, const char *nodes, const char *extra) {
    json_dyn_buf out = {0};
    CHECK(json_dyn_puts(&out, "{\"schemaVersion\":1,\"policy\":\"test.synthetic.v1\",\"mode\":\"agent\",\"executorMode\":\"synthetic\",\"goal\":\"Synthetic validation\",\"workspace\":"));
    CHECK(json_dyn_put_escaped(&out, workspace));
    CHECK(json_dyn_puts(&out, ",\"limits\":{\"maxParallelHostNodes\":3,\"maxParallelLlmNodes\":1,\"maxAttemptsPerNode\":4},\"nodes\":["));
    CHECK(json_dyn_puts(&out, nodes));
    CHECK(json_dyn_puts(&out, "]"));
    if (extra && extra[0]) { CHECK(json_dyn_puts(&out, ",")); CHECK(json_dyn_puts(&out, extra)); }
    CHECK(json_dyn_puts(&out, "}"));
    return out.ptr;
}

static dtg_runtime *create_graph(const char *workspace, const char *nodes, const char *extra) {
    char *json = graph_json(workspace, nodes, extra);
    char err[512] = "";
    dtg_runtime *rt = dtg_store_create(json, 0, err, sizeof err);
    if (!rt) fprintf(stderr, "create_graph: %s\n%s\n", err, json);
    CHECK(rt != NULL);
    free(json);
    return rt;
}

static void drive(dtg_runtime *rt, long long advance, int rounds) {
    long long now = dstudio_now_ms() + advance;
    for (int i = 0; i < rounds && !dtg_graph_terminal(rt->graph.state); i++)
        dtg_scheduler_tick(now + i * (advance ? advance : 1));
}

static void test_json_and_validation(void) {
    char err[512] = "";
    dtg_graph graph;
    const char *valid =
        "{\"schemaVersion\":1,\"policy\":\"test.synthetic.v1\",\"executorMode\":\"synthetic\",\"goal\":\"x\","
        "\"nodes\":[{\"id\":\"a\",\"kind\":\"host_tool\",\"title\":\"A\"},"
        "{\"id\":\"b\",\"kind\":\"join\",\"title\":\"B\",\"dependsOn\":[\"a\"]}]}";
    CHECK(dtg_parse_graph_json(valid, &graph, err, sizeof err));
    CHECK(graph.node_count == 2 && graph.edge_count == 1);
    CHECK(dtg_policy_validate(&graph, 0, err, sizeof err));
    size_t order[2] = {99, 99};
    CHECK(dtg_topological_order(&graph, order, err, sizeof err));
    CHECK(order[0] == 0 && order[1] == 1);
    json_dyn_buf serialized = {0};
    CHECK(dtg_graph_definition_json(&graph, &serialized));
    dtg_graph roundtrip;
    CHECK(dtg_parse_graph_json(serialized.ptr, &roundtrip, err, sizeof err));
    CHECK(roundtrip.node_count == graph.node_count && roundtrip.edge_count == graph.edge_count);
    dtg_graph_free(&roundtrip); free(serialized.ptr); dtg_graph_free(&graph);

    const char *key_like_value =
        "{\"goal\":\"approval\",\"approval\":{\"required\":true},\"policy\":\"test.synthetic.v1\","
        "\"executorMode\":\"synthetic\",\"nodes\":[{\"id\":\"a\",\"kind\":\"join\",\"title\":\"a\"}]}";
    CHECK(dtg_parse_graph_json(key_like_value, &graph, err, sizeof err));
    CHECK(graph.approval_required == 1);
    dtg_graph_free(&graph);

    const char *bad_syntax[] = {
        "", "[]", "{", "{\"goal\":true,}", "{\"goal\":NaN}",
        "{\"goal\":\"x\" \"nodes\":[]}", "{\"goal\":\"x\"} trailing",
        "{\"goal\":\"x\",\"goal\":\"y\",\"nodes\":[]}",
        "{\"go\\u0061l\":\"x\",\"goal\":\"y\",\"nodes\":[]}"
    };
    for (size_t i = 0; i < sizeof bad_syntax / sizeof bad_syntax[0]; i++) {
        err[0] = '\0'; CHECK(!dtg_parse_graph_json(bad_syntax[i], &graph, err, sizeof err)); CHECK(err[0]);
    }

    const char *invalid_graphs[] = {
        /* duplicate id */
        "{\"goal\":\"x\",\"policy\":\"test.synthetic.v1\",\"nodes\":[{\"id\":\"a\",\"kind\":\"join\",\"title\":\"a\"},{\"id\":\"a\",\"kind\":\"join\",\"title\":\"b\"}]}",
        /* self edge */
        "{\"goal\":\"x\",\"policy\":\"test.synthetic.v1\",\"nodes\":[{\"id\":\"a\",\"kind\":\"join\",\"title\":\"a\",\"dependsOn\":[\"a\"]}]}",
        /* missing node */
        "{\"goal\":\"x\",\"policy\":\"test.synthetic.v1\",\"nodes\":[{\"id\":\"a\",\"kind\":\"join\",\"title\":\"a\",\"dependsOn\":[\"z\"]}]}",
        /* cycle */
        "{\"goal\":\"x\",\"policy\":\"test.synthetic.v1\",\"nodes\":[{\"id\":\"a\",\"kind\":\"join\",\"title\":\"a\",\"dependsOn\":[\"b\"]},{\"id\":\"b\",\"kind\":\"join\",\"title\":\"b\",\"dependsOn\":[\"a\"]}]}",
        /* traversal output */
        "{\"goal\":\"x\",\"policy\":\"test.synthetic.v1\",\"nodes\":[{\"id\":\"a\",\"kind\":\"host_tool\",\"title\":\"a\",\"outputs\":[{\"name\":\"x\",\"path\":\"../escape\"}]}]}",
        /* automatic non-idempotent retry */
        "{\"goal\":\"x\",\"policy\":\"test.synthetic.v1\",\"nodes\":[{\"id\":\"a\",\"kind\":\"host_tool\",\"title\":\"a\",\"idempotent\":false,\"retry\":{\"automatic\":true,\"maxAttempts\":2}}]}",
        /* capability outside synthetic policy */
        "{\"goal\":\"x\",\"policy\":\"test.synthetic.v1\",\"nodes\":[{\"id\":\"a\",\"kind\":\"host_tool\",\"title\":\"a\",\"capabilities\":[\"network\"]}]}",
        /* too many LLM nodes */
        "{\"goal\":\"x\",\"policy\":\"test.synthetic.v1\",\"limits\":{\"maxParallelLlmNodes\":2},\"nodes\":[{\"id\":\"a\",\"kind\":\"agent_turn\",\"title\":\"a\"}]}"
    };
    for (size_t i = 0; i < sizeof invalid_graphs / sizeof invalid_graphs[0]; i++) {
        err[0] = '\0';
        int parsed = dtg_parse_graph_json(invalid_graphs[i], &graph, err, sizeof err);
        if (parsed) { CHECK(!dtg_policy_validate(&graph, 0, err, sizeof err)); dtg_graph_free(&graph); }
        else CHECK(err[0]);
    }

    CHECK(dtg_id_valid("node.alpha_1-x"));
    CHECK(!dtg_id_valid("../node"));
    CHECK(!dtg_id_valid("node/slash"));
    CHECK(dtg_relative_path_valid("reports/result.json"));
    CHECK(!dtg_relative_path_valid("/tmp/result.json"));
    CHECK(!dtg_relative_path_valid("reports/../result.json"));
    CHECK(dtg_node_transition_allowed(DTG_NODE_DRAFT, DTG_NODE_PENDING));
    CHECK(!dtg_node_transition_allowed(DTG_NODE_DRAFT, DTG_NODE_SUCCEEDED));
    CHECK(dtg_graph_transition_allowed(DTG_GRAPH_READY, DTG_GRAPH_RUNNING));
    CHECK(!dtg_graph_transition_allowed(DTG_GRAPH_SUCCEEDED, DTG_GRAPH_RUNNING));
}

static void test_store_scheduler(const char *workspace) {
    char err[512] = "";
    dtg_runtime *rt = create_graph(workspace,
        "{\"id\":\"inspect\",\"kind\":\"host_tool\",\"title\":\"Inspect\",\"synthetic\":{\"delayMs\":0}},"
        "{\"id\":\"left\",\"kind\":\"host_tool\",\"title\":\"Left\",\"dependsOn\":[\"inspect\"],\"synthetic\":{\"delayMs\":25}},"
        "{\"id\":\"right\",\"kind\":\"host_tool\",\"title\":\"Right\",\"dependsOn\":[\"inspect\"],\"synthetic\":{\"delayMs\":25}},"
        "{\"id\":\"join\",\"kind\":\"join\",\"title\":\"Join\",\"dependsOn\":[\"left\",\"right\"]}", "");
    CHECK(rt->graph.state == DTG_GRAPH_READY);
    unsigned long long before = rt->graph.last_event_seq;
    CHECK(dtg_scheduler_start(rt, err, sizeof err));
    CHECK(rt->graph.state == DTG_GRAPH_RUNNING);
    CHECK(rt->graph.last_event_seq > before);
    dtg_scheduler_tick(dstudio_now_ms() + 2);
    CHECK(dtg_find_node(&rt->graph, "left")->state == DTG_NODE_RUNNING);
    CHECK(dtg_find_node(&rt->graph, "right")->state == DTG_NODE_RUNNING);
    drive(rt, 100, 8);
    CHECK(rt->graph.state == DTG_GRAPH_SUCCEEDED);
    CHECK(dtg_find_node(&rt->graph, "join")->state == DTG_NODE_SUCCEEDED);
    char graph_id[DTG_ID_MAX + 1]; cstr_copy(graph_id, sizeof graph_id, rt->graph.id);
    unsigned long long last_seq = rt->graph.last_event_seq;
    char directory[DTG_STORE_PATH_MAX]; cstr_copy(directory, sizeof directory, rt->directory);
    char events[DTG_STORE_PATH_MAX]; snprintf(events, sizeof events, "%s/events.jsonl", directory);
    FILE *f = fopen(events, "ab"); CHECK(f != NULL); CHECK(fwrite("{\"seq\":", 1, 7, f) == 7); fclose(f);
    dtg_registry_forget(rt);
    rt = dtg_store_load(workspace, graph_id, err, sizeof err);
    CHECK(rt != NULL);
    CHECK(rt->graph.state == DTG_GRAPH_SUCCEEDED && rt->graph.last_event_seq == last_seq);
    char state_path[DTG_STORE_PATH_MAX]; snprintf(state_path, sizeof state_path, "%s/state.json", directory);
    CHECK(access(state_path, R_OK) == 0);
    char request_path[DTG_STORE_PATH_MAX];
    snprintf(request_path, sizeof request_path, "%s/attempts/inspect/inspect_a1.request.json", directory);
    CHECK(access(request_path, R_OK) == 0);
    CHECK(!dtg_write_attempt_request(rt, dtg_find_node(&rt->graph, "inspect"), "inspect_a1", err, sizeof err));
}

static void test_retry_failure_and_terminal_dep(const char *workspace) {
    char err[512] = "";
    dtg_runtime *rt = create_graph(workspace,
        "{\"id\":\"flaky\",\"kind\":\"host_tool\",\"title\":\"Flaky\",\"retry\":{\"maxAttempts\":2,\"automatic\":true},\"synthetic\":{\"result\":\"failed\"}}",
        "");
    CHECK(dtg_scheduler_start(rt, err, sizeof err));
    drive(rt, 10, 8);
    CHECK(rt->graph.state == DTG_GRAPH_FAILED);
    CHECK(dtg_find_node(&rt->graph, "flaky")->attempts_started == 2);

    rt = create_graph(workspace,
        "{\"id\":\"optional_fail\",\"kind\":\"host_tool\",\"title\":\"Optional\",\"optional\":true,\"synthetic\":{\"result\":\"failed\"}},"
        "{\"id\":\"cleanup\",\"kind\":\"join\",\"title\":\"Cleanup\",\"dependsOn\":[{\"nodeId\":\"optional_fail\",\"condition\":\"terminal\"}]}", "");
    CHECK(dtg_scheduler_start(rt, err, sizeof err));
    drive(rt, 10, 8);
    CHECK(dtg_find_node(&rt->graph, "cleanup")->state == DTG_NODE_SUCCEEDED);
    CHECK(rt->graph.state == DTG_GRAPH_SUCCEEDED);
}

static void test_approval_pause_cancel(const char *workspace) {
    char err[512] = "";
    dtg_runtime *rt = create_graph(workspace,
        "{\"id\":\"work\",\"kind\":\"host_tool\",\"title\":\"Work\"}",
        "\"approval\":{\"required\":true}");
    CHECK(rt->graph.state == DTG_GRAPH_VALIDATED);
    CHECK(!dtg_scheduler_start(rt, err, sizeof err));
    CHECK(dtg_scheduler_approve_graph(rt, err, sizeof err));
    CHECK(rt->graph.state == DTG_GRAPH_READY && rt->graph.approved);
    CHECK(dtg_scheduler_start(rt, err, sizeof err)); drive(rt, 10, 4);
    CHECK(rt->graph.state == DTG_GRAPH_SUCCEEDED);

    rt = create_graph(workspace,
        "{\"id\":\"approve\",\"kind\":\"approval\",\"title\":\"Approve\"},"
        "{\"id\":\"after\",\"kind\":\"join\",\"title\":\"After\",\"dependsOn\":[\"approve\"]}", "");
    CHECK(dtg_scheduler_start(rt, err, sizeof err));
    CHECK(rt->graph.state == DTG_GRAPH_WAITING_APPROVAL);
    CHECK(dtg_find_node(&rt->graph, "approve")->state == DTG_NODE_WAITING_APPROVAL);
    CHECK(dtg_scheduler_approve_node(rt, "approve", err, sizeof err));
    drive(rt, 10, 4); CHECK(rt->graph.state == DTG_GRAPH_SUCCEEDED);

    rt = create_graph(workspace,
        "{\"id\":\"slow\",\"kind\":\"host_tool\",\"title\":\"Slow\",\"synthetic\":{\"delayMs\":100}},"
        "{\"id\":\"later\",\"kind\":\"host_tool\",\"title\":\"Later\",\"dependsOn\":[\"slow\"]}", "");
    CHECK(dtg_scheduler_start(rt, err, sizeof err));
    CHECK(dtg_scheduler_pause(rt, err, sizeof err));
    dtg_scheduler_tick(dstudio_now_ms() + 200);
    CHECK(rt->graph.state == DTG_GRAPH_PAUSED);
    CHECK(dtg_scheduler_resume(rt, err, sizeof err)); drive(rt, 10, 5);
    CHECK(rt->graph.state == DTG_GRAPH_SUCCEEDED);

    rt = create_graph(workspace,
        "{\"id\":\"slow\",\"kind\":\"host_tool\",\"title\":\"Slow\",\"synthetic\":{\"delayMs\":500}}", "");
    CHECK(dtg_scheduler_start(rt, err, sizeof err));
    CHECK(dtg_scheduler_cancel(rt, err, sizeof err));
    CHECK(rt->graph.state == DTG_GRAPH_CANCELLED);
    CHECK(dtg_find_node(&rt->graph, "slow")->state == DTG_NODE_CANCELLED);
}

static void test_global_leases(const char *workspace) {
    char err[512] = "";
    dtg_runtime *a = create_graph(workspace,
        "{\"id\":\"llm_a\",\"kind\":\"agent_turn\",\"title\":\"LLM A\",\"synthetic\":{\"delayMs\":500}}", "");
    dtg_runtime *b = create_graph(workspace,
        "{\"id\":\"llm_b\",\"kind\":\"agent_turn\",\"title\":\"LLM B\",\"synthetic\":{\"delayMs\":500}}", "");
    CHECK(dtg_scheduler_start(a, err, sizeof err));
    CHECK(dtg_scheduler_start(b, err, sizeof err));
    CHECK(dtg_find_node(&a->graph, "llm_a")->state == DTG_NODE_RUNNING);
    CHECK(dtg_find_node(&b->graph, "llm_b")->state == DTG_NODE_READY);
    CHECK(dtg_scheduler_cancel(a, err, sizeof err));
    dtg_scheduler_tick(dstudio_now_ms() + 1);
    CHECK(dtg_find_node(&b->graph, "llm_b")->state == DTG_NODE_RUNNING);
    CHECK(dtg_scheduler_cancel(b, err, sizeof err));

    a = create_graph(workspace,
        "{\"id\":\"write_a\",\"kind\":\"host_tool\",\"title\":\"Writer A\",\"mutation\":\"workspace_write\",\"synthetic\":{\"delayMs\":500}}", "");
    b = create_graph(workspace,
        "{\"id\":\"write_b\",\"kind\":\"host_tool\",\"title\":\"Writer B\",\"mutation\":\"workspace_write\",\"synthetic\":{\"delayMs\":500}}", "");
    CHECK(dtg_scheduler_start(a, err, sizeof err)); CHECK(dtg_scheduler_start(b, err, sizeof err));
    CHECK(dtg_find_node(&a->graph, "write_a")->state == DTG_NODE_RUNNING);
    CHECK(dtg_find_node(&b->graph, "write_b")->state == DTG_NODE_READY);
    CHECK(dtg_scheduler_cancel(a, err, sizeof err)); CHECK(dtg_scheduler_cancel(b, err, sizeof err));
}

static void test_unregistered_executor_guard(const char *workspace) {
    json_dyn_buf body = {0};
    char err[512] = "";
    CHECK(json_dyn_puts(&body,
        "{\"schemaVersion\":1,\"policy\":\"agent.general.v1\",\"mode\":\"agent\","
        "\"goal\":\"Validated future executor proposal\",\"workspace\":"));
    CHECK(json_dyn_put_escaped(&body, workspace));
    CHECK(json_dyn_puts(&body,
        ",\"nodes\":[{\"id\":\"inspect\",\"kind\":\"agent_turn\",\"title\":\"Inspect\","
        "\"capabilities\":[\"filesystem.read\"]}]}"));
    dtg_runtime *rt = dtg_store_create(body.ptr, 0, err, sizeof err);
    free(body.ptr);
    CHECK(rt != NULL);
    CHECK(rt->graph.state == DTG_GRAPH_READY);
    unsigned revision = rt->graph.revision;
    unsigned long long sequence = rt->graph.last_event_seq;
    err[0] = '\0';
    CHECK(!dtg_scheduler_start(rt, err, sizeof err));
    CHECK(strstr(err, "not registered") != NULL);
    CHECK(rt->graph.state == DTG_GRAPH_READY);
    CHECK(rt->graph.revision == revision && rt->graph.last_event_seq == sequence);
}

static void test_native_policy_checkpoint_undo_and_watchdog(const char *workspace) {
    char err[512] = "", target[PATH_MAX];
    snprintf(target, sizeof target, "%s/native-undo.txt", workspace);
    FILE *seed = fopen(target, "wb");
    CHECK(seed != NULL);
    CHECK(fwrite("before\n", 1, 7, seed) == 7);
    CHECK(fclose(seed) == 0);

    json_dyn_buf body = {0};
    CHECK(json_dyn_puts(&body,
        "{\"schemaVersion\":1,\"policy\":\"agent.general.v1\",\"mode\":\"agent\","
        "\"executorMode\":\"native\",\"goal\":\"Native checkpoint lifecycle\",\"workspace\":"));
    CHECK(json_dyn_put_escaped(&body, workspace));
    CHECK(json_dyn_puts(&body,
        ",\"nodes\":["
        "{\"id\":\"write\",\"kind\":\"host_tool\",\"title\":\"Write\",\"mutation\":\"workspace_write\","
        "\"capabilities\":[\"filesystem.write\"],\"outputs\":[{\"name\":\"changed\",\"path\":\"native-undo.txt\",\"required\":true,\"minimumBytes\":6}],"
        "\"action\":{\"name\":\"workspace.write\",\"path\":\"native-undo.txt\",\"text\":\"after\\n\"}},"
        "{\"id\":\"gate\",\"kind\":\"gate\",\"title\":\"Verify\",\"dependsOn\":[\"write\"],"
        "\"capabilities\":[\"filesystem.read\"],\"action\":{\"name\":\"workspace.assert\",\"path\":\"native-undo.txt\",\"contains\":\"after\"}},"
        "{\"id\":\"join\",\"kind\":\"join\",\"title\":\"Done\",\"dependsOn\":[\"gate\"]}]}"));
    dtg_runtime *rt = dtg_store_create(body.ptr, 0, err, sizeof err);
    free(body.ptr);
    if (!rt) fprintf(stderr, "native create: %s\n", err);
    CHECK(rt != NULL && dtg_executor_graph_is_available(&rt->graph));
    char digest[17] = "";
    CHECK(dtg_policy_digest(&rt->graph, digest) && strlen(digest) == 16);
    CHECK(dtg_scheduler_start(rt, err, sizeof err));
    drive(rt, 2, 12);
    CHECK(rt->graph.state == DTG_GRAPH_SUCCEEDED);
    size_t changed_len = 0;
    char *changed = dtg_read_file_bounded(target, 128, &changed_len, err, sizeof err);
    CHECK(changed && !strcmp(changed, "after\n")); free(changed);
    dtg_node *writer = dtg_find_node(&rt->graph, "write");
    CHECK(writer && writer->undo_available);
    CHECK(dtg_executor_undo(rt, writer, err, sizeof err));
    char *restored = dtg_read_file_bounded(target, 128, &changed_len, err, sizeof err);
    CHECK(restored && !strcmp(restored, "before\n")); free(restored);
    CHECK(writer->undo_applied && writer->undo_fully_reversed);

    /* Same decision for the same malformed action, before dispatch. */
    const char *denied =
        "{\"schemaVersion\":1,\"policy\":\"agent.general.v1\",\"mode\":\"agent\",\"executorMode\":\"native\","
        "\"goal\":\"deny\",\"nodes\":[{\"id\":\"bad\",\"kind\":\"host_tool\",\"title\":\"Bad\","
        "\"mutation\":\"read_only\",\"capabilities\":[\"filesystem.write\"],"
        "\"action\":{\"name\":\"workspace.write\",\"path\":\"x\",\"text\":\"x\"}}]}";
    dtg_graph graph;
    CHECK(dtg_parse_graph_json(denied, &graph, err, sizeof err));
    CHECK(!dtg_policy_validate(&graph, 1, err, sizeof err));
    CHECK(strstr(err, "workspace.write requires") != NULL);
    dtg_graph_free(&graph);

    /* Structured tool-event watchdog: fourth identical call trips exactly. */
    g_dtg_agent_owner_rt = rt;
    g_dtg_agent_owner_node = writer;
    writer->watchdog_tripped = 0;
    writer->watchdog_tool_calls = 0;
    g_dtg_watchdog_last_call = 0;
    g_dtg_watchdog_same_call = 0;
    const char *event = "\x1e{\"type\":\"tool_call\",\"name\":\"read\",\"input\":{\"path\":\"same\"}}\n";
    for (int i = 0; i < 3; i++) dtg_watchdog_observe_event_line(event);
    CHECK(!writer->watchdog_tripped);
    dtg_watchdog_observe_event_line(event);
    CHECK(writer->watchdog_tripped && writer->watchdog_tool_calls == 4);
    g_dtg_agent_owner_node = NULL;
    g_dtg_agent_owner_rt = NULL;

    /* Real argv-array tool process (no shell), followed by a real gate. */
    json_dyn_buf test_graph = {0};
    CHECK(json_dyn_puts(&test_graph,
        "{\"schemaVersion\":1,\"policy\":\"agent.general.v1\",\"mode\":\"agent\","
        "\"executorMode\":\"native\",\"goal\":\"Native process\",\"workspace\":"));
    CHECK(json_dyn_put_escaped(&test_graph, workspace));
    CHECK(json_dyn_puts(&test_graph,
        ",\"nodes\":[{\"id\":\"test\",\"kind\":\"host_tool\",\"title\":\"Run test\","
        "\"mutation\":\"workspace_write\",\"capabilities\":[\"test.run\"],"
        "\"action\":{\"name\":\"test.run\",\"argv\":[\"python3\",\"-c\",\"open('native-test.txt','w').write('ok')\"]}},"
        "{\"id\":\"test_gate\",\"kind\":\"gate\",\"title\":\"Test gate\",\"dependsOn\":[\"test\"],"
        "\"capabilities\":[\"filesystem.read\"],\"action\":{\"name\":\"workspace.assert\",\"path\":\"native-test.txt\",\"contains\":\"ok\"}}]}"));
    rt = dtg_store_create(test_graph.ptr, 0, err, sizeof err);
    free(test_graph.ptr);
    CHECK(rt && dtg_scheduler_start(rt, err, sizeof err));
    for (int i = 0; i < 200 && !dtg_graph_terminal(rt->graph.state); i++) {
        dtg_scheduler_tick(dstudio_now_ms());
        usleep(10000);
    }
    CHECK(rt->graph.state == DTG_GRAPH_SUCCEEDED);
    dtg_node *test_node = dtg_find_node(&rt->graph, "test");
    CHECK(test_node && test_node->undo_available);
    CHECK(dtg_executor_undo(rt, test_node, err, sizeof err));
    CHECK(!test_node->undo_applied && !test_node->undo_fully_reversed);
    CHECK(strstr(test_node->undo_message, "No automatic undo") != NULL);

    json_dyn_buf approval = {0};
    CHECK(json_dyn_puts(&approval,
        "{\"schemaVersion\":1,\"policy\":\"agent.general.v1\",\"mode\":\"agent\","
        "\"executorMode\":\"native\",\"goal\":\"Native approval\",\"workspace\":"));
    CHECK(json_dyn_put_escaped(&approval, workspace));
    CHECK(json_dyn_puts(&approval,
        ",\"nodes\":[{\"id\":\"approve\",\"kind\":\"approval\",\"title\":\"Approve\"},"
        "{\"id\":\"after\",\"kind\":\"join\",\"title\":\"After\",\"dependsOn\":[\"approve\"]}]}"));
    rt = dtg_store_create(approval.ptr, 0, err, sizeof err);
    free(approval.ptr);
    CHECK(rt && dtg_scheduler_start(rt, err, sizeof err));
    CHECK(rt->graph.state == DTG_GRAPH_WAITING_APPROVAL);
    CHECK(dtg_scheduler_approve_node(rt, "approve", err, sizeof err));
    drive(rt, 2, 6);
    CHECK(rt->graph.state == DTG_GRAPH_SUCCEEDED);
}

static void test_automatic_correctness_route_and_receipt(const char *workspace) {
    const char *reason = NULL;
    CHECK(dtg_agent_auto_route("Qual è il modello migliore?", &reason) == DTG_AUTO_DIRECT);
    CHECK(dtg_agent_auto_route("Come implemento questa funzione nel codice?", &reason) == DTG_AUTO_DIRECT);
    CHECK(dtg_agent_auto_route("Analizza il codice in src/main.c", &reason) == DTG_AUTO_READ_ONLY);
    CHECK(dtg_agent_auto_route("Analizza app.py ma non modificare il file", &reason) == DTG_AUTO_READ_ONLY);
    CHECK(dtg_agent_auto_route("Read facts.txt and do not modify any file", &reason) == DTG_AUTO_READ_ONLY);
    CHECK(dtg_agent_auto_route("Migliora questa implementazione", &reason) == DTG_AUTO_WORKSPACE_WRITE);
    CHECK(dtg_agent_auto_route("Run the tests in this project", &reason) == DTG_AUTO_WORKSPACE_WRITE);
    CHECK(dtg_agent_auto_route("/new", &reason) == DTG_AUTO_DIRECT);

    char old_workdir[DSTUDIO_PATH_MAX];
    cstr_copy(old_workdir, sizeof old_workdir, g_workdir);
    cstr_copy(g_workdir, sizeof g_workdir, workspace);
    json_dyn_buf automatic = {0};
    CHECK(dtg_build_automatic_agent_graph("Fix app.py and run its test", "Fix app.py", DTG_AUTO_WORKSPACE_WRITE, &automatic));
    dtg_graph graph;
    char err[512] = "";
    CHECK(dtg_parse_graph_json(automatic.ptr, &graph, err, sizeof err));
    CHECK(dtg_policy_validate(&graph, 1, err, sizeof err));
    CHECK(graph.node_count == 3);
    CHECK(!strcmp(graph.nodes[0].action_display, "Fix app.py"));
    CHECK(graph.nodes[0].action_require_tool_result == 1);
    CHECK(graph.nodes[0].automatic_retry == 1 && graph.nodes[0].idempotent == 0);
    CHECK(!strcmp(graph.nodes[1].action_name, "agent.receipt.verify"));
    dtg_graph_free(&graph);
    free(automatic.ptr);
    cstr_copy(g_workdir, sizeof g_workdir, old_workdir);

    char *old_abuf = g_abuf;
    size_t old_alen = g_alen, old_abase = g_abase, old_acap = g_acap;
    dtg_node node;
    memset(&node, 0, sizeof node);
    node.action_expect = "[[DSTUDIO_CORRECTNESS_COMPLETE]]";
    node.action_require_tool_result = 1;
    node.watchdog_tool_calls = 1;

    const char valid[] =
        "\x01" "USER\x02 request [[DSTUDIO_CORRECTNESS_COMPLETE]]\x01" "ENDUSER\x02\n"
        "\x1e{\"type\":\"tool_call\",\"name\":\"read\"}\n"
        "\x1e{\"type\":\"tool_result\",\"result\":\"ok\"}\n"
        "Done\n[[DSTUDIO_COR"
        "\x1e{\"type\":\"status\",\"state\":\"generating\"}\n"
        "RECTNESS_COMPLETE]]\n";
    g_abuf = strdup(valid); CHECK(g_abuf != NULL);
    g_abase = 0; g_alen = strlen(valid); g_acap = g_alen + 1;
    node.transcript_from = 0; node.transcript_to = g_alen;
    CHECK(dtg_agent_completion_contract(&node, err, sizeof err));
    free(g_abuf);

    const char premature[] =
        "\x01" "USER\x02 request\x01" "ENDUSER\x02\n"
        "[[DSTUDIO_CORRECTNESS_COMPLETE]]\n"
        "\x1e{\"type\":\"tool_result\",\"result\":\"late\"}\n";
    g_abuf = strdup(premature); CHECK(g_abuf != NULL);
    g_alen = strlen(premature); g_acap = g_alen + 1;
    node.transcript_to = g_alen;
    err[0] = '\0'; CHECK(!dtg_agent_completion_contract(&node, err, sizeof err));
    CHECK(strstr(err, "did not follow") != NULL);
    free(g_abuf);

    const char prose_only[] =
        "\x01" "USER\x02 request [[DSTUDIO_CORRECTNESS_COMPLETE]]\x01" "ENDUSER\x02\n"
        "I will do it now.\n";
    g_abuf = strdup(prose_only); CHECK(g_abuf != NULL);
    g_alen = strlen(prose_only); g_acap = g_alen + 1;
    node.transcript_to = g_alen; node.watchdog_tool_calls = 0;
    err[0] = '\0'; CHECK(!dtg_agent_completion_contract(&node, err, sizeof err));
    CHECK(strstr(err, "tool action") != NULL);
    free(g_abuf);

    g_abuf = old_abuf; g_alen = old_alen; g_abase = old_abase; g_acap = old_acap;
}

static void test_recovery_failpoints_and_lock(const char *workspace) {
    char err[512] = "";
    dtg_runtime *rt = create_graph(workspace,
        "{\"id\":\"one\",\"kind\":\"host_tool\",\"title\":\"One\"}", "");
    char id[DTG_ID_MAX + 1]; cstr_copy(id, sizeof id, rt->graph.id);
    long long created_ms = rt->graph.created_ms;
    CHECK(setenv("DTG_FAIL_AFTER_EVENT_APPEND", "1", 1) == 0);
    CHECK(!dtg_scheduler_start(rt, err, sizeof err));
    unsetenv("DTG_FAIL_AFTER_EVENT_APPEND");
    CHECK(rt->graph.state == DTG_GRAPH_READY);
    dtg_registry_forget(rt);
    rt = dtg_store_load(workspace, id, err, sizeof err);
    CHECK(rt != NULL && rt->graph.state == DTG_GRAPH_RUNNING);
    CHECK(rt->graph.created_ms == created_ms && rt->graph.started_ms >= created_ms);
    char state_path[DTG_STORE_PATH_MAX];
    snprintf(state_path, sizeof state_path, "%s/state.json", rt->directory);
    size_t state_len = 0;
    char *state_json = dtg_read_file_bounded(state_path, BODY_MAX, &state_len, err, sizeof err);
    CHECK(state_json != NULL && state_len > 0 && strstr(state_json, "\"state\":\"running\"") != NULL);
    free(state_json);
    drive(rt, 10, 5); CHECK(rt->graph.state == DTG_GRAPH_SUCCEEDED);

    rt = create_graph(workspace,
        "{\"id\":\"two\",\"kind\":\"host_tool\",\"title\":\"Two\"}", "");
    cstr_copy(id, sizeof id, rt->graph.id);
    CHECK(setenv("DTG_FAIL_BEFORE_STATE_RENAME", "1", 1) == 0);
    CHECK(!dtg_scheduler_start(rt, err, sizeof err));
    unsetenv("DTG_FAIL_BEFORE_STATE_RENAME");
    dtg_registry_forget(rt);
    rt = dtg_store_load(workspace, id, err, sizeof err);
    CHECK(rt != NULL && rt->graph.state == DTG_GRAPH_RUNNING);
    drive(rt, 10, 5); CHECK(rt->graph.state == DTG_GRAPH_SUCCEEDED);

    rt = create_graph(workspace,
        "{\"id\":\"locked\",\"kind\":\"host_tool\",\"title\":\"Locked\"}", "");
    char lock_path[DTG_STORE_PATH_MAX]; snprintf(lock_path, sizeof lock_path, "%s/lock", rt->directory);
    int lock_fd = open(lock_path, O_RDWR | O_CREAT, 0600); CHECK(lock_fd >= 0);
    CHECK(flock(lock_fd, LOCK_EX | LOCK_NB) == 0);
    err[0] = '\0'; CHECK(!dtg_scheduler_start(rt, err, sizeof err)); CHECK(strstr(err, "locked") != NULL);
    flock(lock_fd, LOCK_UN); close(lock_fd);
    CHECK(dtg_scheduler_start(rt, err, sizeof err)); drive(rt, 10, 4);

    /* A duplicated control key in the authoritative journal must corrupt the
     * load instead of being interpreted first-wins or last-wins. */
    rt = create_graph(workspace,
        "{\"id\":\"corrupt\",\"kind\":\"host_tool\",\"title\":\"Corrupt\"}", "");
    cstr_copy(id, sizeof id, rt->graph.id);
    char events_path[DTG_STORE_PATH_MAX];
    snprintf(events_path, sizeof events_path, "%s/events.jsonl", rt->directory);
    unsigned long long duplicate_seq = rt->graph.last_event_seq + 1;
    int events_fd = open(events_path, O_WRONLY | O_APPEND); CHECK(events_fd >= 0);
    CHECK(dprintf(events_fd,
        "{\"seq\":%llu,\"seq\":%llu,\"ts\":%lld,\"type\":\"graph.ready\",\"graphId\":\"%s\",\"revision\":%u,\"graphState\":\"ready\",\"approved\":false,\"message\":\"ambiguous\"}\n",
        duplicate_seq, duplicate_seq, dstudio_now_ms(), id, rt->graph.revision) > 0);
    CHECK(fsync(events_fd) == 0); close(events_fd);
    dtg_registry_forget(rt);
    err[0] = '\0';
    CHECK(dtg_store_load(workspace, id, err, sizeof err) == NULL);
    CHECK(strstr(err, "duplicate JSON object key") != NULL);
}

static double monotonic_ms(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (double)ts.tv_sec * 1000.0 + (double)ts.tv_nsec / 1000000.0;
}

static void test_light_benchmark(const char *workspace) {
    static const char *fixture =
        "{\"schemaVersion\":1,\"policy\":\"test.synthetic.v1\",\"executorMode\":\"synthetic\",\"goal\":\"bench\","
        "\"nodes\":[{\"id\":\"a\",\"kind\":\"host_tool\",\"title\":\"A\"},{\"id\":\"b\",\"kind\":\"host_tool\",\"title\":\"B\",\"dependsOn\":[\"a\"]},{\"id\":\"c\",\"kind\":\"gate\",\"title\":\"C\",\"dependsOn\":[\"b\"]}]}";
    char err[512] = "";
    double parse_start = monotonic_ms();
    for (int i = 0; i < 1000; i++) {
        dtg_graph graph;
        CHECK(dtg_parse_graph_json(fixture, &graph, err, sizeof err));
        CHECK(dtg_policy_validate(&graph, 0, err, sizeof err));
        dtg_graph_free(&graph);
    }
    double parse_ms = monotonic_ms() - parse_start;
    CHECK(parse_ms < 5000.0);

    double durable_start = monotonic_ms();
    for (int run = 0; run < 6; run++) {
        json_dyn_buf nodes = {0};
        for (int i = 0; i < 8; i++) {
            if (i) CHECK(json_dyn_puts(&nodes, ","));
            CHECK(json_dyn_printf(&nodes,
                "{\"id\":\"n%d\",\"kind\":\"%s\",\"title\":\"Node %d\"",
                i, i == 7 ? "gate" : "host_tool", i));
            if (i) CHECK(json_dyn_printf(&nodes, ",\"dependsOn\":[\"n%d\"]", i - 1));
            CHECK(json_dyn_puts(&nodes, ",\"synthetic\":{\"delayMs\":0}}"));
        }
        dtg_runtime *rt = create_graph(workspace, nodes.ptr, "");
        free(nodes.ptr);
        CHECK(dtg_scheduler_start(rt, err, sizeof err));
        drive(rt, 2, 24);
        CHECK(rt->graph.state == DTG_GRAPH_SUCCEEDED);
        char id[DTG_ID_MAX + 1]; cstr_copy(id, sizeof id, rt->graph.id);
        unsigned long long seq = rt->graph.last_event_seq;
        long long created = rt->graph.created_ms, started = rt->graph.started_ms;
        long long completed = rt->graph.completed_ms, node_finished = rt->graph.nodes[7].finished_ms;
        dtg_registry_forget(rt);
        rt = dtg_store_load(workspace, id, err, sizeof err);
        CHECK(rt && rt->graph.state == DTG_GRAPH_SUCCEEDED && rt->graph.last_event_seq == seq);
        CHECK(rt->graph.created_ms == created && rt->graph.started_ms == started &&
              rt->graph.completed_ms == completed && rt->graph.nodes[7].finished_ms == node_finished);
        dtg_registry_forget(rt);
    }
    double durable_ms = monotonic_ms() - durable_start;
    CHECK(durable_ms < 15000.0);
    printf("task_graph_light_benchmark: parse+validate=%.2fms/1000, durable schedule+replay=%.2fms/6\n",
           parse_ms, durable_ms);
}

int main(void) {
    char workspace[] = "/tmp/dstudio-task-graph.XXXXXX";
    CHECK(mkdtemp(workspace) != NULL);
    CHECK(setenv("DS4UI_TEST_MODE", "1", 1) == 0);
    CHECK(setenv("DS4UI_DATA_DIR", workspace, 1) == 0);
    test_json_and_validation();
    test_store_scheduler(workspace);
    test_retry_failure_and_terminal_dep(workspace);
    test_approval_pause_cancel(workspace);
    test_global_leases(workspace);
    test_unregistered_executor_guard(workspace);
    test_native_policy_checkpoint_undo_and_watchdog(workspace);
    test_automatic_correctness_route_and_receipt(workspace);
    test_recovery_failpoints_and_lock(workspace);
    test_light_benchmark(workspace);
    dtg_store_shutdown();
    remove_tree(workspace);
    printf("task_graph_unit: %d lightweight checks passed\n", checks);
    return 0;
}

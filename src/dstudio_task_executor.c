/* DStudio Task Graph V1 — executor boundary and deterministic synthetic worker. */

static int dtg_attempt_file(const dtg_runtime *rt, const dtg_node *node,
                            const char *attempt_id, const char *suffix,
                            char *out, size_t outsz, char *err, size_t errsz) {
    if (!dtg_id_valid(node->id) || !dtg_id_valid(attempt_id)) {
        snprintf(err, errsz, "invalid attempt identity"); return 0;
    }
    char directory[DTG_STORE_PATH_MAX];
    int n = snprintf(directory, sizeof directory, "%s/attempts/%s", rt->directory, node->id);
    if (n < 0 || (size_t)n >= sizeof directory) { snprintf(err, errsz, "attempt directory is too long"); return 0; }
    mkpath(directory);
    n = snprintf(out, outsz, "%s/%s.%s.json", directory, attempt_id, suffix);
    if (n < 0 || (size_t)n >= outsz) { snprintf(err, errsz, "attempt file is too long"); return 0; }
    return 1;
}

static int dtg_write_attempt_request(const dtg_runtime *rt, const dtg_node *node,
                                     const char *attempt_id,
                                     char *err, size_t errsz) {
    json_dyn_buf body = {0};
    int ok = json_dyn_puts(&body, "{\"schemaVersion\":1,\"graphId\":") &&
        json_dyn_put_escaped(&body, rt->graph.id) &&
        json_dyn_puts(&body, ",\"nodeId\":") && json_dyn_put_escaped(&body, node->id) &&
        json_dyn_puts(&body, ",\"attemptId\":") && json_dyn_put_escaped(&body, attempt_id) &&
        json_dyn_puts(&body, ",\"executor\":\"synthetic\",\"title\":") &&
        json_dyn_put_escaped(&body, node->title) &&
        json_dyn_printf(&body, ",\"requestedAtMs\":%lld}", dstudio_now_ms());
    char path[DTG_STORE_PATH_MAX], directory[DTG_STORE_PATH_MAX];
    ok = ok && dtg_attempt_file(rt, node, attempt_id, "request", path, sizeof path, err, errsz);
    if (ok) {
        cstr_copy(directory, sizeof directory, path);
        char *slash = strrchr(directory, '/');
        if (!slash) ok = 0;
        else { *slash = '\0'; ok = dtg_write_atomic(directory, slash + 1, body.ptr, body.len, 1, err, errsz); }
    }
    free(body.ptr);
    if (!ok && !err[0]) snprintf(err, errsz, "cannot persist attempt request");
    return ok;
}

static int dtg_write_attempt_result(const dtg_runtime *rt, const dtg_node *node,
                                    const char *attempt_id, int succeeded,
                                    const char *message, char *err, size_t errsz) {
    json_dyn_buf body = {0};
    int ok = json_dyn_puts(&body, "{\"schemaVersion\":1,\"graphId\":") &&
        json_dyn_put_escaped(&body, rt->graph.id) &&
        json_dyn_puts(&body, ",\"nodeId\":") && json_dyn_put_escaped(&body, node->id) &&
        json_dyn_puts(&body, ",\"attemptId\":") && json_dyn_put_escaped(&body, attempt_id) &&
        json_dyn_printf(&body, ",\"ok\":%s,\"completedAtMs\":%lld,\"message\":",
                        succeeded ? "true" : "false", dstudio_now_ms()) &&
        json_dyn_put_escaped(&body, message ? message : "") && json_dyn_puts(&body, "}");
    char path[DTG_STORE_PATH_MAX], directory[DTG_STORE_PATH_MAX];
    ok = ok && dtg_attempt_file(rt, node, attempt_id, "result", path, sizeof path, err, errsz);
    if (ok) {
        cstr_copy(directory, sizeof directory, path);
        char *slash = strrchr(directory, '/');
        if (!slash) ok = 0;
        else { *slash = '\0'; ok = dtg_write_atomic(directory, slash + 1, body.ptr, body.len, 1, err, errsz); }
    }
    free(body.ptr);
    if (!ok && !err[0]) snprintf(err, errsz, "cannot persist attempt result");
    return ok;
}

static int dtg_executor_can_dispatch(const dtg_node *node) {
    if (!node) return 0;
    if (node->kind == DTG_NODE_AGENT_TURN && (g_agent_working || g_agent_session_working)) return 0;
    return 1;
}

/* Validation and execution are intentionally separate contracts.  Plan and
 * future Agent/GSA/RSA adapters may persist a valid proposal before their
 * executor is registered, but start must remain side-effect free in that
 * case.  In particular, never append graph.started and then discover at the
 * first node that only the deterministic test executor exists. */
static int dtg_executor_graph_is_available(const dtg_graph *graph) {
    if (graph && !strcmp(graph->executor_mode, "synthetic") &&
        !strcmp(graph->policy, "test.synthetic.v1")) return 1;
    return 0;
}

static int dtg_executor_graph_available(const dtg_graph *graph,
                                        char *err, size_t errsz) {
    if (dtg_executor_graph_is_available(graph)) return 1;
    snprintf(err, errsz,
             "executor for policy '%s' is not registered; graph remains a validated proposal",
             graph && graph->policy[0] ? graph->policy : "unknown");
    return 0;
}

static int dtg_executor_begin_synthetic(dtg_runtime *rt, dtg_node *node,
                                        long long now, char *attempt_id, size_t attempt_sz,
                                        unsigned long long *operation_task_id,
                                        long long *due_ms, char *err, size_t errsz) {
    if (strcmp(rt->graph.executor_mode, "synthetic") || strcmp(rt->graph.policy, "test.synthetic.v1")) {
        snprintf(err, errsz, "task graph is not bound to the synthetic executor");
        return 0;
    }
    int n = snprintf(attempt_id, attempt_sz, "%s_a%d", node->id, node->attempts_started + 1);
    if (n < 0 || (size_t)n >= attempt_sz || !dtg_id_valid(attempt_id)) {
        snprintf(err, errsz, "attemptId exceeds its bound"); return 0;
    }
    if (!dtg_write_attempt_request(rt, node, attempt_id, err, errsz)) return 0;
    *operation_task_id = task_begin("task-graph-node", node->title, rt->graph.id,
                                    ENGINE_AGENT, rt->graph.workspace, 0, 1);
    task_mark_working(*operation_task_id, "Synthetic task graph node running");
    *due_ms = now + node->synthetic_delay_ms;
    return 1;
}

static int dtg_executor_finish_synthetic(dtg_runtime *rt, dtg_node *node,
                                         int *succeeded, char *err, size_t errsz) {
    *succeeded = !node->synthetic_should_fail;
    const char *message = *succeeded ? "Synthetic executor completed" : "Synthetic executor injected failure";
    if (!dtg_write_attempt_result(rt, node, node->active_attempt_id, *succeeded,
                                  message, err, errsz)) return 0;
    if (node->operation_task_id) {
        if (*succeeded) task_mark_completed(node->operation_task_id, message);
        else task_mark_failed(node->operation_task_id, message, "deterministic synthetic result");
    }
    return 1;
}

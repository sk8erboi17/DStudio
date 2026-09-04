/* DStudio Task Graph V1 — host-local bounded HTTP API. */

static int dtg_query_value(const char *path, const char *key, char *out, size_t outsz) {
    if (!path || !key || !out || !outsz) return 0;
    out[0] = '\0';
    const char *query = strchr(path, '?');
    if (!query) return 0;
    query++;
    size_t keylen = strlen(key);
    while (*query) {
        const char *end = strchr(query, '&');
        if (!end) end = query + strlen(query);
        const char *eq = memchr(query, '=', (size_t)(end - query));
        if (eq && (size_t)(eq - query) == keylen && !memcmp(query, key, keylen)) {
            size_t o = 0;
            for (const char *p = eq + 1; p < end && o + 1 < outsz; p++) {
                if (*p == '+' ) { out[o++] = ' '; continue; }
                if (*p == '%' && p + 2 < end && isxdigit((unsigned char)p[1]) && isxdigit((unsigned char)p[2])) {
                    int hi = dtg_hex_value((unsigned char)p[1]);
                    int lo = dtg_hex_value((unsigned char)p[2]);
                    char c = (char)((hi << 4) | lo);
                    if (!c) return 0;
                    out[o++] = c; p += 2; continue;
                }
                out[o++] = *p;
            }
            out[o] = '\0';
            return 1;
        }
        query = *end ? end + 1 : end;
    }
    return 0;
}

static void dtg_api_error(int fd, const char *status, const char *error) {
    json_dyn_buf out = {0};
    if (json_dyn_puts(&out, "{\"ok\":false,\"error\":") &&
        json_dyn_put_escaped(&out, error ? error : "Task Graph error") && json_dyn_puts(&out, "}"))
        send_json(fd, status, out.ptr);
    else send_json(fd, "500 Internal Server Error", "{\"ok\":false,\"error\":\"out of memory\"}");
    free(out.ptr);
}

static int dtg_runtime_json(const dtg_runtime *rt, json_dyn_buf *out) {
    const dtg_graph *graph = &rt->graph;
    char policy_digest[17] = "unavailable";
    (void)dtg_policy_digest(graph, policy_digest);
    size_t done = 0;
    for (size_t i = 0; i < graph->node_count; i++) if (dtg_node_terminal(graph->nodes[i].state)) done++;
    int ok = json_dyn_puts(out, "{\"ok\":true,\"graph\":{\"graphId\":") &&
        json_dyn_put_escaped(out, graph->id) &&
        json_dyn_printf(out, ",\"schemaVersion\":%u,\"revision\":%u,\"lastEventSeq\":%llu",
                        graph->schema_version, graph->revision, graph->last_event_seq) &&
        json_dyn_puts(out, ",\"state\":") && json_dyn_put_escaped(out, dtg_graph_state_name(graph->state)) &&
        json_dyn_puts(out, ",\"policy\":") && json_dyn_put_escaped(out, graph->policy) &&
        json_dyn_puts(out, ",\"mode\":") && json_dyn_put_escaped(out, graph->mode) &&
        json_dyn_puts(out, ",\"executorMode\":") && json_dyn_put_escaped(out, graph->executor_mode) &&
        json_dyn_printf(out, ",\"executionAvailable\":%s",
                        dtg_executor_graph_is_available(graph) ? "true" : "false") &&
        json_dyn_puts(out, ",\"policyDigest\":") && json_dyn_put_escaped(out, policy_digest) &&
        json_dyn_puts(out, ",\"goal\":") && json_dyn_put_escaped(out, graph->goal) &&
        json_dyn_puts(out, ",\"workspace\":") && json_dyn_put_escaped(out, graph->workspace) &&
        json_dyn_printf(out, ",\"approvalRequired\":%s,\"approved\":%s,\"progress\":{\"completed\":%zu,\"total\":%zu},\"createdMs\":%lld,\"updatedMs\":%lld,\"startedMs\":%lld,\"completedMs\":%lld,\"error\":",
                        graph->approval_required ? "true" : "false", graph->approved ? "true" : "false",
                        done, graph->node_count, graph->created_ms, graph->updated_ms,
                        graph->started_ms, graph->completed_ms) &&
        json_dyn_put_escaped(out, graph->error) && json_dyn_puts(out, ",\"nodes\":[");
    for (size_t i = 0; ok && i < graph->node_count; i++) {
        const dtg_node *node = &graph->nodes[i];
        int undo_available = 0, undo_applied = 0, undo_fully = 0;
        char undo_message[256] = "";
        dtg_executor_undo_summary(rt, node, &undo_available, &undo_applied,
                                  &undo_fully, undo_message, sizeof undo_message);
        if (i) ok = json_dyn_puts(out, ",");
        ok = ok && json_dyn_puts(out, "{\"id\":") && json_dyn_put_escaped(out, node->id) &&
            json_dyn_puts(out, ",\"title\":") && json_dyn_put_escaped(out, node->title) &&
            json_dyn_puts(out, ",\"description\":") && json_dyn_put_escaped(out, node->description) &&
            json_dyn_puts(out, ",\"kind\":") && json_dyn_put_escaped(out, dtg_node_kind_name(node->kind)) &&
            json_dyn_puts(out, ",\"state\":") && json_dyn_put_escaped(out, dtg_node_state_name(node->state)) &&
            json_dyn_puts(out, ",\"mutation\":") && json_dyn_put_escaped(out, dtg_mutation_name(node->mutation)) &&
            json_dyn_puts(out, ",\"action\":") && json_dyn_put_escaped(out, node->action_name) &&
            json_dyn_printf(out, ",\"optional\":%s,\"priority\":%d,\"attemptsStarted\":%d,\"maxAttempts\":%d,\"operationTaskId\":%llu,\"watchdog\":{\"toolCalls\":%u,\"repeatedCalls\":%u,\"tripped\":%s},\"undo\":{\"available\":%s,\"applied\":%s,\"fullyReversed\":%s,\"message\":",
                            node->optional ? "true" : "false", node->priority,
                            node->attempts_started, node->max_attempts, node->operation_task_id,
                            node->watchdog_tool_calls, node->watchdog_repeated_calls,
                            node->watchdog_tripped ? "true" : "false",
                            undo_available ? "true" : "false",
                            undo_applied ? "true" : "false",
                            undo_fully ? "true" : "false") &&
            json_dyn_put_escaped(out, undo_message) &&
            json_dyn_puts(out, "},\"attemptId\":") &&
            json_dyn_put_escaped(out, node->active_attempt_id) && json_dyn_puts(out, ",\"dependsOn\":[");
        for (size_t d = 0; ok && d < node->dependency_count; d++) {
            if (d) ok = json_dyn_puts(out, ",");
            ok = ok && json_dyn_puts(out, "{\"nodeId\":") &&
                json_dyn_put_escaped(out, node->dependencies[d].node_id) &&
                json_dyn_puts(out, ",\"condition\":") &&
                json_dyn_put_escaped(out, node->dependencies[d].condition == DTG_DEP_TERMINAL ? "terminal" : "succeeded") &&
                json_dyn_puts(out, "}");
        }
        ok = ok && json_dyn_puts(out, "]}");
    }
    return ok && json_dyn_puts(out, "]}}");
}

static int dtg_api_send_runtime(int fd, const dtg_runtime *rt) {
    json_dyn_buf out = {0};
    if (!dtg_runtime_json(rt, &out)) {
        free(out.ptr); dtg_api_error(fd, "500 Internal Server Error", "cannot serialize task graph"); return 500;
    }
    send_json(fd, "200 OK", out.ptr);
    free(out.ptr);
    return 200;
}

static dtg_runtime *dtg_api_load_body(const char *body, int require_precondition,
                                      int *http_status, char *err, size_t errsz) {
    char graph_id[DTG_ID_MAX + 1] = "", workspace[DSTUDIO_PATH_MAX] = "";
    if (!json_get_string(body, "graphId", graph_id, sizeof graph_id) || !dtg_id_valid(graph_id)) {
        snprintf(err, errsz, "graphId is required"); *http_status = 400; return NULL;
    }
    (void)json_get_string(body, "workspace", workspace, sizeof workspace);
    dtg_runtime *rt = NULL;
    if (!workspace[0]) {
        for (int i = 0; i < DTG_MAX_REGISTRY; i++) {
            if (g_dtg_registry[i].used && !strcmp(g_dtg_registry[i].graph.id, graph_id)) {
                if (rt) { snprintf(err, errsz, "workspace is required because graphId is ambiguous"); *http_status = 400; return NULL; }
                rt = &g_dtg_registry[i];
            }
        }
    }
    if (!rt) rt = dtg_store_load(workspace, graph_id, err, errsz);
    if (!rt) { *http_status = strstr(err, "locked") ? 409 : 404; return NULL; }
    if (require_precondition) {
        long revision = 0, seq = -1;
        int rr = json_get_int(body, "expectedRevision", 1, LONG_MAX, &revision);
        int rs = json_get_int(body, "expectedLastEventSeq", 0, LONG_MAX, &seq);
        if (rr != 1 || rs != 1) {
            snprintf(err, errsz, "expectedRevision and expectedLastEventSeq are required");
            *http_status = 400; return NULL;
        }
        if ((unsigned long)revision != rt->graph.revision || (unsigned long long)seq != rt->graph.last_event_seq) {
            snprintf(err, errsz, "task graph revision precondition failed");
            *http_status = 409; return NULL;
        }
    }
    *http_status = 200;
    return rt;
}

static int api_dtg_create(int fd, const char *body) {
    char err[512] = "";
    dtg_runtime *rt = dtg_store_create(body, 0, err, sizeof err);
    if (!rt) { dtg_api_error(fd, "400 Bad Request", err); return 400; }
    return dtg_api_send_runtime(fd, rt);
}

static int api_dtg_validate(int fd, const char *body) {
    char err[512] = "";
    char graph_id[DTG_ID_MAX + 1] = "";
    int executable = 0;
    if (json_get_string(body, "graphId", graph_id, sizeof graph_id) && !strstr(body, "\"nodes\"")) {
        int status = 200;
        dtg_runtime *rt = dtg_api_load_body(body, 0, &status, err, sizeof err);
        if (!rt) { dtg_api_error(fd, status == 404 ? "404 Not Found" : "400 Bad Request", err); return status; }
        if (!dtg_policy_validate(&rt->graph, 1, err, sizeof err)) {
            dtg_api_error(fd, "422 Unprocessable Entity", err); return 422;
        }
        executable = dtg_executor_graph_available(&rt->graph, err, sizeof err);
    } else {
        dtg_graph graph;
        if (!dtg_parse_graph_json(body, &graph, err, sizeof err)) {
            dtg_api_error(fd, "400 Bad Request", err); return 400;
        }
        int ok = dtg_policy_validate(&graph, 1, err, sizeof err);
        if (ok) executable = dtg_executor_graph_available(&graph, err, sizeof err);
        dtg_graph_free(&graph);
        if (!ok) { dtg_api_error(fd, "422 Unprocessable Entity", err); return 422; }
    }
    send_json(fd, "200 OK", executable
        ? "{\"ok\":true,\"valid\":true,\"executionAvailable\":true}"
        : "{\"ok\":true,\"valid\":true,\"executionAvailable\":false}");
    return 200;
}

typedef int (*dtg_graph_mutation_fn)(dtg_runtime *, char *, size_t);

static int api_dtg_graph_mutation(int fd, const char *body, dtg_graph_mutation_fn fn) {
    char err[512] = "";
    int status = 200;
    dtg_runtime *rt = dtg_api_load_body(body, 1, &status, err, sizeof err);
    if (!rt) {
        dtg_api_error(fd, status == 409 ? "409 Conflict" : status == 404 ? "404 Not Found" : "400 Bad Request", err);
        return status;
    }
    if (!fn(rt, err, sizeof err)) {
        const char *http = strstr(err, "locked") ? "409 Conflict" : "422 Unprocessable Entity";
        dtg_api_error(fd, http, err); return strstr(err, "locked") ? 409 : 422;
    }
    return dtg_api_send_runtime(fd, rt);
}

static int dtg_node_cancel(dtg_runtime *rt, const char *node_id, char *err, size_t errsz) {
    dtg_node *node = rt ? dtg_find_node(&rt->graph, node_id) : NULL;
    if (!node || dtg_node_terminal(node->state)) { snprintf(err, errsz, "node is missing or terminal"); return 0; }
    if (node->state == DTG_NODE_RUNNING || node->state == DTG_NODE_LEASED) {
        (void)dtg_executor_cancel(rt, node, "Task graph node cancelled");
        if (!dtg_scheduler_set_node(rt, node, "node.cancelling", DTG_NODE_CANCELLING,
                                    "Node cancellation requested", err, errsz)) return 0;
    }
    if (node->operation_task_id) task_mark_canceled(node->operation_task_id, "Task graph node cancelled");
    return dtg_scheduler_set_node(rt, node, "node.cancelled", DTG_NODE_CANCELLED,
                                  "Node cancelled", err, errsz);
}

static int dtg_node_undo(dtg_runtime *rt, const char *node_id, char *err, size_t errsz) {
    dtg_node *node = rt ? dtg_find_node(&rt->graph, node_id) : NULL;
    if (!node) { snprintf(err, errsz, "node is missing"); return 0; }
    return dtg_executor_undo(rt, node, err, errsz);
}

static int api_dtg_node_mutation(int fd, const char *body,
                                 int (*fn)(dtg_runtime *, const char *, char *, size_t)) {
    char err[512] = "", node_id[DTG_ID_MAX + 1] = "";
    int status = 200;
    dtg_runtime *rt = dtg_api_load_body(body, 1, &status, err, sizeof err);
    if (!rt) {
        dtg_api_error(fd, status == 409 ? "409 Conflict" : status == 404 ? "404 Not Found" : "400 Bad Request", err);
        return status;
    }
    if (!json_get_string(body, "nodeId", node_id, sizeof node_id) || !dtg_id_valid(node_id)) {
        dtg_api_error(fd, "400 Bad Request", "nodeId is required"); return 400;
    }
    if (!fn(rt, node_id, err, sizeof err)) {
        dtg_api_error(fd, strstr(err, "locked") ? "409 Conflict" : "422 Unprocessable Entity", err);
        return strstr(err, "locked") ? 409 : 422;
    }
    return dtg_api_send_runtime(fd, rt);
}

static int api_dtg_get(int fd, const char *path) {
    char graph_id[DTG_ID_MAX + 1] = "", workspace[DSTUDIO_PATH_MAX] = "", err[512] = "";
    if (!dtg_query_value(path, "graphId", graph_id, sizeof graph_id) &&
        !dtg_query_value(path, "id", graph_id, sizeof graph_id)) {
        dtg_api_error(fd, "400 Bad Request", "graphId query parameter is required"); return 400;
    }
    (void)dtg_query_value(path, "workspace", workspace, sizeof workspace);
    dtg_runtime *rt = dtg_store_load(workspace, graph_id, err, sizeof err);
    if (!rt) { dtg_api_error(fd, "404 Not Found", err); return 404; }
    return dtg_api_send_runtime(fd, rt);
}

static int api_dtg_events(int fd, const char *path) {
    char graph_id[DTG_ID_MAX + 1] = "", workspace[DSTUDIO_PATH_MAX] = "", since_text[32] = "", err[512] = "";
    if (!dtg_query_value(path, "graphId", graph_id, sizeof graph_id) &&
        !dtg_query_value(path, "id", graph_id, sizeof graph_id)) {
        dtg_api_error(fd, "400 Bad Request", "graphId query parameter is required"); return 400;
    }
    (void)dtg_query_value(path, "workspace", workspace, sizeof workspace);
    unsigned long long since = 0;
    if (dtg_query_value(path, "since", since_text, sizeof since_text)) {
        char *end = NULL; errno = 0;
        since = strtoull(since_text, &end, 10);
        if (errno || !end || *end) { dtg_api_error(fd, "400 Bad Request", "invalid since sequence"); return 400; }
    }
    dtg_runtime *rt = dtg_store_load(workspace, graph_id, err, sizeof err);
    if (!rt) { dtg_api_error(fd, "404 Not Found", err); return 404; }
    char events_path[DTG_STORE_PATH_MAX];
    if (!dtg_path_join(events_path, sizeof events_path, rt->directory, "events.jsonl")) {
        dtg_api_error(fd, "500 Internal Server Error", "event path is too long"); return 500;
    }
    size_t len = 0;
    char *events = dtg_read_file_bounded(events_path, 32u * 1024u * 1024u, &len, err, sizeof err);
    if (!events) { dtg_api_error(fd, "500 Internal Server Error", err); return 500; }
    json_dyn_buf out = {0};
    int ok = json_dyn_puts(&out, "{\"ok\":true,\"events\":[");
    size_t start = 0, emitted = 0;
    while (ok && start < len && emitted < 1024) {
        char *nl = memchr(events + start, '\n', len - start);
        if (!nl) break;
        size_t line_len = (size_t)(nl - (events + start));
        char seq_pattern[48];
        snprintf(seq_pattern, sizeof seq_pattern, "\"seq\":");
        const char *seq_at = line_len ? strstr(events + start, seq_pattern) : NULL;
        unsigned long long seq = seq_at && seq_at < events + start + line_len ? strtoull(seq_at + strlen(seq_pattern), NULL, 10) : 0;
        if (line_len && seq > since) {
            if (emitted++) ok = json_dyn_puts(&out, ",");
            ok = ok && json_dyn_putn(&out, events + start, line_len);
        }
        start += line_len + 1;
    }
    free(events);
    ok = ok && json_dyn_printf(&out, "],\"lastEventSeq\":%llu}", rt->graph.last_event_seq);
    if (!ok) { free(out.ptr); dtg_api_error(fd, "500 Internal Server Error", "cannot serialize events"); return 500; }
    send_json(fd, "200 OK", out.ptr); free(out.ptr); return 200;
}

static int api_dtg_list(int fd, const char *path) {
    char workspace[DSTUDIO_PATH_MAX] = "", workspace_real[DSTUDIO_PATH_MAX], root[DTG_STORE_PATH_MAX], err[512] = "";
    (void)dtg_query_value(path, "workspace", workspace, sizeof workspace);
    if (!dtg_store_root(workspace, workspace_real, sizeof workspace_real, root, sizeof root, err, sizeof err)) {
        dtg_api_error(fd, "400 Bad Request", err); return 400;
    }
    json_dyn_buf out = {0};
    int ok = json_dyn_puts(&out, "{\"ok\":true,\"graphs\":[");
    int first = 1;
    DIR *dir = opendir(root);
    if (dir) {
        struct dirent *entry;
        while (ok && (entry = readdir(dir)) != NULL) {
            if (!dtg_id_valid(entry->d_name)) continue;
            dtg_runtime *rt = dtg_store_load(workspace, entry->d_name, err, sizeof err);
            if (!rt) { err[0] = '\0'; continue; }
            if (!first) ok = json_dyn_puts(&out, ",");
            first = 0;
            ok = ok && json_dyn_puts(&out, "{\"graphId\":") && json_dyn_put_escaped(&out, rt->graph.id) &&
                json_dyn_puts(&out, ",\"goal\":") && json_dyn_put_escaped(&out, rt->graph.goal) &&
                json_dyn_puts(&out, ",\"state\":") && json_dyn_put_escaped(&out, dtg_graph_state_name(rt->graph.state)) &&
                json_dyn_printf(&out, ",\"revision\":%u,\"lastEventSeq\":%llu,\"updatedMs\":%lld}",
                                rt->graph.revision, rt->graph.last_event_seq, rt->graph.updated_ms);
        }
        closedir(dir);
    }
    ok = ok && json_dyn_puts(&out, "]}");
    if (!ok) { free(out.ptr); dtg_api_error(fd, "500 Internal Server Error", "cannot serialize graph list"); return 500; }
    send_json(fd, "200 OK", out.ptr); free(out.ptr); return 200;
}

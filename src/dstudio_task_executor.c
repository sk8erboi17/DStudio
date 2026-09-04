/* DStudio Task Graph V1 — deterministic native and synthetic executors. */

static dtg_runtime *g_dtg_agent_owner_rt = NULL;
static dtg_node *g_dtg_agent_owner_node = NULL;
static unsigned long long g_dtg_watchdog_last_call = 0;
static unsigned long long g_dtg_watchdog_last_result = 0;
static unsigned g_dtg_watchdog_same_call = 0;
static unsigned g_dtg_watchdog_same_result = 0;

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

static int dtg_attempt_write(const dtg_runtime *rt, const dtg_node *node,
                             const char *attempt_id, const char *suffix,
                             const char *data, size_t len, int immutable,
                             char *err, size_t errsz) {
    char path[DTG_STORE_PATH_MAX], directory[DTG_STORE_PATH_MAX];
    if (!dtg_attempt_file(rt, node, attempt_id, suffix, path, sizeof path, err, errsz)) return 0;
    cstr_copy(directory, sizeof directory, path);
    char *slash = strrchr(directory, '/');
    if (!slash) { snprintf(err, errsz, "attempt directory is invalid"); return 0; }
    *slash = '\0';
    return dtg_write_atomic(directory, slash + 1, data ? data : "", len,
                            immutable, err, errsz);
}

static const char *dtg_executor_name(const dtg_graph *graph) {
    return graph && !strcmp(graph->executor_mode, "native") ? "native" : "synthetic";
}

static int dtg_write_attempt_request(const dtg_runtime *rt, const dtg_node *node,
                                     const char *attempt_id,
                                     char *err, size_t errsz) {
    char digest[17] = "unavailable";
    (void)dtg_policy_digest(&rt->graph, digest);
    json_dyn_buf body = {0};
    int ok = json_dyn_puts(&body, "{\"schemaVersion\":1,\"graphId\":") &&
        json_dyn_put_escaped(&body, rt->graph.id) &&
        json_dyn_puts(&body, ",\"nodeId\":") && json_dyn_put_escaped(&body, node->id) &&
        json_dyn_puts(&body, ",\"attemptId\":") && json_dyn_put_escaped(&body, attempt_id) &&
        json_dyn_puts(&body, ",\"executor\":") && json_dyn_put_escaped(&body, dtg_executor_name(&rt->graph)) &&
        json_dyn_puts(&body, ",\"action\":") && json_dyn_put_escaped(&body, node->action_name) &&
        json_dyn_puts(&body, ",\"policyDigest\":") && json_dyn_put_escaped(&body, digest) &&
        json_dyn_puts(&body, ",\"title\":") && json_dyn_put_escaped(&body, node->title) &&
        json_dyn_printf(&body, ",\"requestedAtMs\":%lld}", dstudio_now_ms());
    ok = ok && dtg_attempt_write(rt, node, attempt_id, "request", body.ptr, body.len, 1, err, errsz);
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
        json_dyn_puts(&body, ",\"executor\":") && json_dyn_put_escaped(&body, dtg_executor_name(&rt->graph)) &&
        json_dyn_printf(&body, ",\"ok\":%s,\"completedAtMs\":%lld,\"watchdog\":{\"toolCalls\":%u,\"repeatedCalls\":%u,\"tripped\":%s},\"message\":",
                        succeeded ? "true" : "false", dstudio_now_ms(),
                        node->watchdog_tool_calls, node->watchdog_repeated_calls,
                        node->watchdog_tripped ? "true" : "false") &&
        json_dyn_put_escaped(&body, message ? message : "") && json_dyn_puts(&body, "}");
    ok = ok && dtg_attempt_write(rt, node, attempt_id, "result", body.ptr, body.len, 1, err, errsz);
    free(body.ptr);
    if (!ok && !err[0]) snprintf(err, errsz, "cannot persist attempt result");
    return ok;
}

static int dtg_write_policy_receipt(const dtg_runtime *rt, const dtg_node *node,
                                    const char *attempt_id, int allowed,
                                    const char *reason, char *err, size_t errsz) {
    char digest[17] = "unavailable";
    (void)dtg_policy_digest(&rt->graph, digest);
    json_dyn_buf body = {0};
    int ok = json_dyn_puts(&body, "{\"schemaVersion\":1,\"decision\":") &&
        json_dyn_put_escaped(&body, allowed ? "allow" : "deny") &&
        json_dyn_puts(&body, ",\"policy\":") && json_dyn_put_escaped(&body, rt->graph.policy) &&
        json_dyn_puts(&body, ",\"policyDigest\":") && json_dyn_put_escaped(&body, digest) &&
        json_dyn_puts(&body, ",\"nodeId\":") && json_dyn_put_escaped(&body, node->id) &&
        json_dyn_puts(&body, ",\"action\":") && json_dyn_put_escaped(&body, node->action_name) &&
        json_dyn_puts(&body, ",\"mutation\":") && json_dyn_put_escaped(&body, dtg_mutation_name(node->mutation)) &&
        json_dyn_puts(&body, ",\"reason\":") && json_dyn_put_escaped(&body, reason ? reason : "") &&
        json_dyn_printf(&body, ",\"decidedAtMs\":%lld}", dstudio_now_ms());
    ok = ok && dtg_attempt_write(rt, node, attempt_id, "policy", body.ptr, body.len, 1, err, errsz);
    free(body.ptr);
    return ok;
}

static int dtg_write_approval_receipt(const dtg_runtime *rt, const dtg_node *node,
                                      char *err, size_t errsz) {
    char digest[17] = "unavailable";
    (void)dtg_policy_digest(&rt->graph, digest);
    json_dyn_buf body = {0};
    int ok = json_dyn_puts(&body, "{\"schemaVersion\":1,\"scope\":") &&
        json_dyn_put_escaped(&body, node ? "node" : "graph") &&
        json_dyn_puts(&body, ",\"graphId\":") && json_dyn_put_escaped(&body, rt->graph.id) &&
        json_dyn_puts(&body, ",\"nodeId\":") && json_dyn_put_escaped(&body, node ? node->id : "") &&
        json_dyn_puts(&body, ",\"attemptId\":") && json_dyn_put_escaped(&body, node ? node->active_attempt_id : "") &&
        json_dyn_puts(&body, ",\"policyDigest\":") && json_dyn_put_escaped(&body, digest) &&
        json_dyn_printf(&body, ",\"approved\":true,\"approvedAtMs\":%lld}", dstudio_now_ms());
    if (ok && node)
        ok = dtg_attempt_write(rt, node, node->active_attempt_id, "approval",
                               body.ptr, body.len, 1, err, errsz);
    else if (ok)
        ok = dtg_write_atomic(rt->directory, "approval.json", body.ptr, body.len, 1, err, errsz);
    free(body.ptr);
    return ok;
}

static int dtg_path_inside_workspace(const dtg_runtime *rt, const char *path) {
    size_t n = strlen(rt->workspace_real);
    return !strncmp(path, rt->workspace_real, n) &&
           (path[n] == '\0' || path[n] == '/' || path[n] == '\\');
}

static int dtg_native_resolve_path(const dtg_runtime *rt, const char *relative,
                                   int may_not_exist, char *out, size_t outsz,
                                   char *err, size_t errsz) {
    if (!dtg_relative_path_valid(relative) || !relative[0]) {
        snprintf(err, errsz, "action path must be workspace-relative"); return 0;
    }
    char joined[DTG_STORE_PATH_MAX];
    if (!dtg_path_join(joined, sizeof joined, rt->workspace_real, relative)) {
        snprintf(err, errsz, "action path is too long"); return 0;
    }
    char resolved[DSTUDIO_PATH_MAX];
    if (realpath(joined, resolved)) {
        if (!dtg_path_inside_workspace(rt, resolved)) {
            snprintf(err, errsz, "action path escapes workspace through a symlink"); return 0;
        }
        cstr_copy(out, outsz, resolved);
        return 1;
    }
    if (!may_not_exist || errno != ENOENT) {
        snprintf(err, errsz, "action path does not exist: %s", relative); return 0;
    }
    char parent[DTG_STORE_PATH_MAX];
    cstr_copy(parent, sizeof parent, joined);
    char *slash = strrchr(parent, '/');
#ifdef _WIN32
    char *backslash = strrchr(parent, '\\');
    if (!slash || (backslash && backslash > slash)) slash = backslash;
#endif
    if (!slash) { snprintf(err, errsz, "action path has no parent"); return 0; }
    char leaf[DSTUDIO_PATH_MAX];
    cstr_copy(leaf, sizeof leaf, slash + 1);
    *slash = '\0';
    if (!realpath(parent, resolved) || !dtg_path_inside_workspace(rt, resolved)) {
        snprintf(err, errsz, "action parent is missing or escapes workspace"); return 0;
    }
    int n = snprintf(out, outsz, "%s/%s", resolved, leaf);
    if (n < 0 || (size_t)n >= outsz) {
        snprintf(err, errsz, "resolved action path is too long"); return 0;
    }
    return 1;
}

static int dtg_file_fingerprint(const char *path, char digest[17],
                                unsigned long long *bytes, int *present,
                                char *err, size_t errsz) {
    FILE *file = fopen(path, "rb");
    if (!file && errno == ENOENT) {
        cstr_copy(digest, 17, "absent"); *bytes = 0; *present = 0; return 1;
    }
    if (!file) { snprintf(err, errsz, "cannot open checkpoint target: %s", strerror(errno)); return 0; }
    unsigned long long hash = 1469598103934665603ULL, count = 0;
    unsigned char buffer[32768];
    for (;;) {
        size_t got = fread(buffer, 1, sizeof buffer, file);
        if (got) { hash = dtg_fnv1a64_bytes(hash, buffer, got); count += got; }
        if (got < sizeof buffer) {
            if (ferror(file)) { fclose(file); snprintf(err, errsz, "cannot read checkpoint target"); return 0; }
            break;
        }
    }
    fclose(file);
    snprintf(digest, 17, "%016llx", hash); *bytes = count; *present = 1; return 1;
}

static int dtg_write_checkpoint_receipt(dtg_runtime *rt, dtg_node *node,
                                        const char *attempt_id,
                                        char *err, size_t errsz) {
    const int reversible_write = !strcmp(node->action_name, "workspace.write");
    char before[17] = "not-observed", after[17] = "not-observed";
    unsigned long long before_bytes = 0, after_bytes = 0;
    int original_present = 0, after_present = 0;
    char target[DSTUDIO_PATH_MAX] = "";
    if (reversible_write) {
        if (!dtg_native_resolve_path(rt, node->action_path, 1, target, sizeof target, err, errsz) ||
            !dtg_file_fingerprint(target, before, &before_bytes, &original_present, err, errsz)) return 0;
        if (original_present) {
            if (before_bytes > node->action_max_bytes) {
                snprintf(err, errsz, "checkpoint target exceeds action maxBytes"); return 0;
            }
            size_t len = 0;
            char *backup = dtg_read_file_bounded(target, (size_t)node->action_max_bytes, &len, err, errsz);
            if (!backup || !dtg_attempt_write(rt, node, attempt_id, "backup", backup,
                                              len, 1, err, errsz)) { free(backup); return 0; }
            free(backup);
        }
        unsigned long long expected = dtg_fnv1a64_bytes(0, node->action_text, strlen(node->action_text));
        snprintf(after, sizeof after, "%016llx", expected);
        after_bytes = strlen(node->action_text);
        after_present = 1;
    }
    const int mutates = node->mutation == DTG_MUTATION_WORKSPACE_WRITE ||
                        node->mutation == DTG_MUTATION_EXTERNAL_SIDE_EFFECT;
    json_dyn_buf body = {0};
    int ok = json_dyn_puts(&body, "{\"schemaVersion\":1,\"nodeId\":") &&
        json_dyn_put_escaped(&body, node->id) &&
        json_dyn_puts(&body, ",\"attemptId\":") && json_dyn_put_escaped(&body, attempt_id) &&
        json_dyn_puts(&body, ",\"path\":") && json_dyn_put_escaped(&body, node->action_path) &&
        json_dyn_printf(&body, ",\"mutationObserved\":%s,\"reversible\":%s,\"originalPresent\":%s,\"beforeBytes\":%llu,\"afterBytes\":%llu,\"afterPresent\":%s",
                        mutates ? "true" : "false", reversible_write ? "true" : "false",
                        original_present ? "true" : "false", before_bytes, after_bytes,
                        after_present ? "true" : "false") &&
        json_dyn_puts(&body, ",\"beforeDigest\":") && json_dyn_put_escaped(&body, before) &&
        json_dyn_puts(&body, ",\"expectedAfterDigest\":") && json_dyn_put_escaped(&body, after) &&
        json_dyn_puts(&body, ",\"honesty\":") &&
        json_dyn_put_escaped(&body, reversible_write ?
            "byte-exact target snapshot written before mutation" :
            (mutates ? "evidence only; executor cannot prove or reverse every nested filesystem effect" :
                       "read-only action; no undo is necessary")) &&
        json_dyn_printf(&body, ",\"preparedAtMs\":%lld}", dstudio_now_ms());
    ok = ok && dtg_attempt_write(rt, node, attempt_id, "checkpoint", body.ptr, body.len, 1, err, errsz);
    free(body.ptr);
    if (ok) node->undo_available = mutates;
    return ok;
}

static int dtg_native_write_text(dtg_runtime *rt, dtg_node *node,
                                 char *err, size_t errsz) {
    char target[DSTUDIO_PATH_MAX], directory[DSTUDIO_PATH_MAX];
    if (!dtg_native_resolve_path(rt, node->action_path, 1, target, sizeof target, err, errsz)) return 0;
    cstr_copy(directory, sizeof directory, target);
    char *slash = strrchr(directory, '/');
    if (!slash || !slash[1]) { snprintf(err, errsz, "write target is invalid"); return 0; }
    *slash = '\0';
    if (!dtg_write_atomic(directory, slash + 1, node->action_text,
                          strlen(node->action_text), 0, err, errsz)) return 0;
    char digest[17]; unsigned long long bytes = 0; int present = 0;
    if (!dtg_file_fingerprint(target, digest, &bytes, &present, err, errsz) || !present) return 0;
    snprintf(node->native_message, sizeof node->native_message,
             "Wrote %llu bytes to %s (fnv1a64:%s)", bytes, node->action_path, digest);
    return 1;
}

static int dtg_native_read(dtg_runtime *rt, dtg_node *node,
                           char *err, size_t errsz) {
    char target[DSTUDIO_PATH_MAX];
    if (!dtg_native_resolve_path(rt, node->action_path, 0, target, sizeof target, err, errsz)) return 0;
    size_t len = 0;
    char *data = dtg_read_file_bounded(target, (size_t)node->action_max_bytes, &len, err, errsz);
    if (!data) return 0;
    json_dyn_buf artifact = {0};
    int ok = json_dyn_puts(&artifact, "{\"path\":") && json_dyn_put_escaped(&artifact, node->action_path) &&
             json_dyn_printf(&artifact, ",\"bytes\":%zu,\"content\":", len) &&
             json_dyn_put_escaped(&artifact, data) && json_dyn_puts(&artifact, "}") &&
             dtg_attempt_write(rt, node, node->active_attempt_id,
                               "artifact", artifact.ptr, artifact.len, 1, err, errsz);
    free(artifact.ptr); free(data);
    if (ok) snprintf(node->native_message, sizeof node->native_message,
                     "Read %zu bytes from %s", len, node->action_path);
    return ok;
}

static int dtg_native_assert_file(dtg_runtime *rt, dtg_node *node,
                                  const char *path, unsigned long long minimum,
                                  const char *contains, char *err, size_t errsz) {
    char target[DSTUDIO_PATH_MAX];
    if (!dtg_native_resolve_path(rt, path, 0, target, sizeof target, err, errsz)) return 0;
    size_t len = 0;
    char *data = dtg_read_file_bounded(target, (size_t)node->action_max_bytes, &len, err, errsz);
    if (!data) return 0;
    int ok = len >= minimum && (!contains || !contains[0] || strstr(data, contains));
    free(data);
    if (!ok) {
        snprintf(err, errsz, "gate failed for %s: bytes/contains contract not satisfied", path); return 0;
    }
    return 1;
}

static int dtg_native_verify_outputs(dtg_runtime *rt, dtg_node *gate,
                                     char *err, size_t errsz) {
    size_t verified = 0;
    for (size_t d = 0; d < gate->dependency_count; d++) {
        const dtg_node *source = dtg_find_node_const(&rt->graph, gate->dependencies[d].node_id);
        if (!source) continue;
        for (size_t o = 0; o < source->output_count; o++) {
            const dtg_output_contract *output = &source->outputs[o];
            if (!output->required) continue;
            if (!output->path[0] ||
                !dtg_native_assert_file(rt, gate, output->path, output->minimum_bytes,
                                        NULL, err, errsz)) return 0;
            verified++;
        }
    }
    snprintf(gate->native_message, sizeof gate->native_message,
             "Verified %zu required output contract%s", verified, verified == 1 ? "" : "s");
    return 1;
}

static int dtg_test_executable_allowed(const char *program) {
    static const char *allowed[] = { "make", "cmake", "ctest", "ninja", "npm", "node",
        "python", "python3", "pytest", "cargo", "go", "swift", "xcodebuild", NULL };
    if (!program || !program[0] || strchr(program, '/') || strchr(program, '\\')) return 0;
    for (int i = 0; allowed[i]; i++) if (!strcmp(program, allowed[i])) return 1;
    return 0;
}

static int dtg_native_start_test(dtg_runtime *rt, dtg_node *node,
                                 char *err, size_t errsz) {
#ifdef _WIN32
    (void)rt; (void)node;
    snprintf(err, errsz, "native test.run is not yet available on Windows"); return 0;
#else
    if (!dtg_test_executable_allowed(node->action_argv[0])) {
        snprintf(err, errsz, "test.run executable '%s' is outside the deterministic allowlist",
                 node->action_argv[0]); return 0;
    }
    char log_path[DTG_STORE_PATH_MAX];
    if (!dtg_attempt_file(rt, node, node->active_attempt_id, "stream", log_path,
                          sizeof log_path, err, errsz)) return 0;
    int logfd = open(log_path, O_WRONLY | O_CREAT | O_EXCL, 0600);
    if (logfd < 0) { snprintf(err, errsz, "cannot create test stream: %s", strerror(errno)); return 0; }
    pid_t child = fork();
    if (child < 0) { close(logfd); snprintf(err, errsz, "cannot fork test: %s", strerror(errno)); return 0; }
    if (child == 0) {
        (void)setpgid(0, 0);
        if (chdir(rt->workspace_real) != 0 || dup2(logfd, STDOUT_FILENO) < 0 ||
            dup2(logfd, STDERR_FILENO) < 0) _exit(126);
        close(logfd);
        char *argv[DTG_MAX_ACTION_ARGS + 1];
        for (size_t i = 0; i < node->action_argc; i++) argv[i] = node->action_argv[i];
        argv[node->action_argc] = NULL;
        execvp(argv[0], argv);
        _exit(127);
    }
    close(logfd);
    (void)setpgid(child, child);
    node->native_pid = child;
    snprintf(node->native_message, sizeof node->native_message,
             "Test process %ld running", (long)child);
    return 1;
#endif
}

static int dtg_write_agent_transcript(dtg_runtime *rt, dtg_node *node,
                                      char *err, size_t errsz) {
    size_t from = node->transcript_from < g_abase ? g_abase : node->transcript_from;
    size_t to = g_alen;
    size_t len = to > from ? to - from : 0;
    if (len > 1024u * 1024u) { from = to - 1024u * 1024u; len = to - from; }
    const char *data = len && g_abuf ? g_abuf + (from - g_abase) : "";
    char *copy = malloc(len + 1);
    if (!copy) { snprintf(err, errsz, "out of memory persisting agent transcript"); return 0; }
    if (len) memcpy(copy, data, len);
    copy[len] = '\0';
    json_dyn_buf body = {0};
    int ok = json_dyn_printf(&body, "{\"from\":%zu,\"to\":%zu,\"truncated\":%s,\"content\":",
                             from, to, from != node->transcript_from ? "true" : "false") &&
             json_dyn_put_escaped(&body, copy) && json_dyn_puts(&body, "}") &&
             dtg_attempt_write(rt, node, node->active_attempt_id, "transcript",
                               body.ptr, body.len, 1, err, errsz);
    free(copy); free(body.ptr);
    node->transcript_to = to;
    return ok;
}

static int dtg_executor_can_dispatch(const dtg_node *node) {
    if (!node) return 0;
    if (node->kind == DTG_NODE_AGENT_TURN &&
        (g_agent_working || g_agent_session_working || g_dtg_agent_owner_node)) return 0;
    return 1;
}

static int dtg_agent_turn_owned(void) {
    return g_dtg_agent_owner_node != NULL;
}

static void dtg_agent_owner_release_if_terminal(void) {
    if (g_dtg_agent_owner_node && dtg_node_terminal(g_dtg_agent_owner_node->state)) {
        g_dtg_agent_owner_node = NULL;
        g_dtg_agent_owner_rt = NULL;
    }
}

static int dtg_executor_graph_is_available(const dtg_graph *graph) {
    if (!graph) return 0;
    if (!strcmp(graph->executor_mode, "synthetic") &&
        !strcmp(graph->policy, "test.synthetic.v1")) return 1;
    if (!strcmp(graph->executor_mode, "native") &&
        !strcmp(graph->policy, "agent.general.v1") && !strcmp(graph->mode, "agent")) {
        char err[512] = "";
        for (size_t i = 0; i < graph->node_count; i++)
            if (!dtg_native_action_policy(graph, &graph->nodes[i], err, sizeof err)) return 0;
        return 1;
    }
    return 0;
}

static int dtg_executor_graph_available(const dtg_graph *graph,
                                        char *err, size_t errsz) {
    if (dtg_executor_graph_is_available(graph)) return 1;
    if (graph && !strcmp(graph->executor_mode, "native")) {
        if (strcmp(graph->mode, "agent"))
            snprintf(err, errsz, "native executor requires mode 'agent'");
        else {
            for (size_t i = 0; i < graph->node_count; i++)
                if (!dtg_native_action_policy(graph, &graph->nodes[i], err, errsz)) return 0;
            snprintf(err, errsz, "native executor policy is unavailable");
        }
        return 0;
    }
    snprintf(err, errsz,
             "executor for policy '%s' is not registered; graph remains a validated proposal",
             graph && graph->policy[0] ? graph->policy : "unknown");
    return 0;
}

static int dtg_attempt_identity(dtg_node *node, char *attempt_id, size_t attempt_sz,
                                char *err, size_t errsz) {
    int n = snprintf(attempt_id, attempt_sz, "%s_a%d", node->id, node->attempts_started + 1);
    if (n < 0 || (size_t)n >= attempt_sz || !dtg_id_valid(attempt_id)) {
        snprintf(err, errsz, "attemptId exceeds its bound"); return 0;
    }
    return 1;
}

static int dtg_executor_begin_synthetic(dtg_runtime *rt, dtg_node *node,
                                        long long now, char *attempt_id, size_t attempt_sz,
                                        unsigned long long *operation_task_id,
                                        long long *due_ms, char *err, size_t errsz) {
    if (strcmp(rt->graph.executor_mode, "synthetic") || strcmp(rt->graph.policy, "test.synthetic.v1")) {
        snprintf(err, errsz, "task graph is not bound to the synthetic executor"); return 0;
    }
    if (!dtg_attempt_identity(node, attempt_id, attempt_sz, err, errsz) ||
        !dtg_write_attempt_request(rt, node, attempt_id, err, errsz)) return 0;
    *operation_task_id = task_begin("task-graph-node", node->title, rt->graph.id,
                                    ENGINE_AGENT, rt->graph.workspace, 0, 1);
    task_mark_working(*operation_task_id, "Synthetic task graph node running");
    *due_ms = now + node->synthetic_delay_ms;
    return 1;
}

static int dtg_executor_begin_native(dtg_runtime *rt, dtg_node *node,
                                     long long now, char *attempt_id, size_t attempt_sz,
                                     unsigned long long *operation_task_id,
                                     long long *due_ms, char *err, size_t errsz) {
    (void)now;
    if (!dtg_attempt_identity(node, attempt_id, attempt_sz, err, errsz)) return 0;
    char decision[512] = "closed-world action, capability, mutation and path checks passed";
    if (!dtg_native_action_policy(&rt->graph, node, err, errsz)) {
        char denied[512]; cstr_copy(denied, sizeof denied, err);
        char receipt_err[256] = "";
        (void)dtg_write_policy_receipt(rt, node, attempt_id, 0, denied,
                                       receipt_err, sizeof receipt_err);
        return 0;
    }
    if (!dtg_write_policy_receipt(rt, node, attempt_id, 1, decision, err, errsz) ||
        !dtg_write_attempt_request(rt, node, attempt_id, err, errsz)) return 0;

    cstr_copy(node->active_attempt_id, sizeof node->active_attempt_id, attempt_id);
    node->native_pid = 0;
    node->native_done = 0;
    node->native_success = 0;
    node->native_cancel_requested = 0;
    node->watchdog_tool_calls = node->watchdog_repeated_calls = 0;
    node->watchdog_tripped = 0;
    node->native_message[0] = '\0';
    if (!dtg_write_checkpoint_receipt(rt, node, attempt_id, err, errsz)) {
        *operation_task_id = task_begin("task-graph-node", node->title, rt->graph.id,
                                        ENGINE_AGENT, rt->graph.workspace, 0, 1);
        node->native_done = 1;
        node->native_success = 0;
        cstr_copy(node->native_message, sizeof node->native_message, err);
        if (errsz) err[0] = '\0';
        return 1;
    }

    if (!strcmp(node->action_name, "agent.prompt")) {
        char active_workspace[DSTUDIO_PATH_MAX] = "";
        if (!g_workdir[0] || !realpath(g_workdir, active_workspace) ||
            strcmp(active_workspace, rt->workspace_real)) {
            *operation_task_id = task_begin("task-graph-agent", node->title, rt->graph.id,
                                            ENGINE_AGENT, rt->graph.workspace, 0, 1);
            node->native_done = 1;
            cstr_copy(node->native_message, sizeof node->native_message,
                      "Agent runtime workspace does not match Task Graph workspace");
            return 1;
        }
        json_dyn_buf prompt = {0};
        int ok = json_dyn_puts(&prompt,
            "[DStudio Task Graph policy]\nExecute only this bounded graph action. ") &&
            json_dyn_puts(&prompt, node->mutation == DTG_MUTATION_READ_ONLY ?
                "This node is READ-ONLY: inspect and answer, do not edit files.\n" :
                "Workspace writes are declared; stay inside the active workspace.\n") &&
            json_dyn_puts(&prompt,
                "Avoid repeated identical tool calls; stop and explain if no progress is possible.\n\n") &&
            json_dyn_puts(&prompt, node->action_text);
        if (!ok) { free(prompt.ptr); snprintf(err, errsz, "cannot build bounded agent prompt"); return 0; }
        if (!dtg_agent_submit_for_graph(node->title, prompt.ptr, operation_task_id,
                                        &node->transcript_from, err, errsz)) {
            free(prompt.ptr);
            if (!*operation_task_id)
                *operation_task_id = task_begin("task-graph-agent", node->title, rt->graph.id,
                                                ENGINE_AGENT, rt->graph.workspace, 0, 1);
            node->native_done = 1;
            node->native_success = 0;
            cstr_copy(node->native_message, sizeof node->native_message, err);
            if (errsz) err[0] = '\0';
            return 1;
        }
        free(prompt.ptr);
        g_dtg_agent_owner_rt = rt;
        g_dtg_agent_owner_node = node;
        g_dtg_watchdog_last_call = g_dtg_watchdog_last_result = 0;
        g_dtg_watchdog_same_call = g_dtg_watchdog_same_result = 0;
        cstr_copy(node->native_message, sizeof node->native_message, "Agent turn running");
        return 1;
    }

    *operation_task_id = task_begin("task-graph-node", node->title, rt->graph.id,
                                    ENGINE_AGENT, rt->graph.workspace, 0, 1);
    task_mark_working(*operation_task_id, "Native task graph action running");
    node->operation_task_id = *operation_task_id;
    int ok = 1;
    if (!strcmp(node->action_name, "workspace.read"))
        ok = dtg_native_read(rt, node, err, errsz);
    else if (!strcmp(node->action_name, "workspace.write"))
        ok = dtg_native_write_text(rt, node, err, errsz);
    else if (!strcmp(node->action_name, "workspace.assert")) {
        ok = dtg_native_assert_file(rt, node, node->action_path, 0,
                                    node->action_expect, err, errsz);
        if (ok) snprintf(node->native_message, sizeof node->native_message,
                         "Gate verified %s", node->action_path);
    } else if (!strcmp(node->action_name, "outputs.verify"))
        ok = dtg_native_verify_outputs(rt, node, err, errsz);
    else if (!strcmp(node->action_name, "test.run"))
        ok = dtg_native_start_test(rt, node, err, errsz);
    else if (!strcmp(node->action_name, "approval.wait"))
        cstr_copy(node->native_message, sizeof node->native_message, "Awaiting explicit approval");
    else if (!strcmp(node->action_name, "join.all"))
        cstr_copy(node->native_message, sizeof node->native_message, "Dependency join completed");
    else { snprintf(err, errsz, "native action is not implemented"); ok = 0; }
    if (!ok) {
        node->native_done = 1; node->native_success = 0;
        cstr_copy(node->native_message, sizeof node->native_message, err);
        if (errsz) err[0] = '\0';
    } else if (!node->native_pid && strcmp(node->action_name, "approval.wait")) {
        node->native_done = 1; node->native_success = 1;
    }
    *due_ms = 0;
    return 1;
}

static int dtg_executor_begin(dtg_runtime *rt, dtg_node *node, long long now,
                              char *attempt_id, size_t attempt_sz,
                              unsigned long long *operation_task_id,
                              long long *due_ms, char *err, size_t errsz) {
    if (!strcmp(rt->graph.executor_mode, "native"))
        return dtg_executor_begin_native(rt, node, now, attempt_id, attempt_sz,
                                         operation_task_id, due_ms, err, errsz);
    return dtg_executor_begin_synthetic(rt, node, now, attempt_id, attempt_sz,
                                        operation_task_id, due_ms, err, errsz);
}

static void dtg_watchdog_trip(dtg_node *node, const char *reason) {
    if (!node || node->watchdog_tripped) return;
    node->watchdog_tripped = 1;
    node->native_success = 0;
    cstr_copy(node->native_message, sizeof node->native_message, reason);
    if (g_child > 0 && g_agent_working) {
        kill(g_child, SIGINT);
        g_interrupt_pending = 1;
    }
    if (node->operation_task_id)
        task_mark_working(node->operation_task_id, reason);
}

/* Moven-inspired bounded progress monitor.  Only a graph-owned Agent turn is
 * observed; ordinary interactive turns retain their existing semantics. */
static void dtg_watchdog_observe_event_line(const char *line) {
    dtg_node *node = g_dtg_agent_owner_node;
    if (!node || !line || node->watchdog_tripped) return;
    const char *event = (unsigned char)line[0] == 0x1e ? line + 1 : line;
    int is_call = strstr(event, "\"type\":\"tool_call\"") != NULL;
    int is_result = strstr(event, "\"type\":\"tool_result\"") != NULL;
    if (!is_call && !is_result) return;
    /* Transport ids may change even when the semantic call is identical.
     * Hash from the stable payload field so retries cannot evade the bound. */
    const char *stable = is_call ? strstr(event, "\"name\":") : strstr(event, "\"result\":");
    if (!stable && is_result) stable = strstr(event, "\"output\":");
    if (!stable) stable = event;
    unsigned long long signature = dtg_fnv1a64_bytes(0, stable, strlen(stable));
    if (is_call) {
        node->watchdog_tool_calls++;
        if (signature == g_dtg_watchdog_last_call) g_dtg_watchdog_same_call++;
        else { g_dtg_watchdog_last_call = signature; g_dtg_watchdog_same_call = 1; }
        node->watchdog_repeated_calls = g_dtg_watchdog_same_call;
        if (g_dtg_watchdog_same_call >= 4)
            dtg_watchdog_trip(node, "Watchdog stopped four identical Agent tool calls");
        else if (node->watchdog_tool_calls >= 128)
            dtg_watchdog_trip(node, "Watchdog stopped Agent turn after 128 tool calls");
    } else {
        if (signature == g_dtg_watchdog_last_result) g_dtg_watchdog_same_result++;
        else { g_dtg_watchdog_last_result = signature; g_dtg_watchdog_same_result = 1; }
        if (g_dtg_watchdog_same_result >= 4)
            dtg_watchdog_trip(node, "Watchdog stopped four identical tool results without progress");
    }
}

static int dtg_executor_cancel(dtg_runtime *rt, dtg_node *node,
                               const char *reason) {
    (void)rt;
    if (!node) return 0;
    node->native_cancel_requested = 1;
#ifndef _WIN32
    if (node->native_pid > 0) {
        pid_t child = node->native_pid;
        (void)kill(-child, SIGTERM);
        int status = 0;
        for (int i = 0; i < 25; i++) {
            pid_t waited = waitpid(child, &status, WNOHANG);
            if (waited == child || (waited < 0 && errno == ECHILD)) break;
            usleep(10000);
        }
        if (waitpid(child, &status, WNOHANG) == 0) {
            (void)kill(-child, SIGKILL);
            while (waitpid(child, &status, 0) < 0 && errno == EINTR) {}
        }
        node->native_pid = 0;
        node->native_done = 1;
        node->native_success = 0;
    }
#endif
    if (node == g_dtg_agent_owner_node && g_child > 0 && g_agent_working) {
        (void)kill(g_child, SIGINT);
        g_interrupt_pending = 1;
    }
    cstr_copy(node->native_message, sizeof node->native_message,
              reason ? reason : "Executor cancellation requested");
    return 1;
}

static int dtg_executor_poll(dtg_runtime *rt, dtg_node *node, long long now,
                             int *finished, int *succeeded,
                             char *err, size_t errsz) {
    *finished = 0; *succeeded = 0;
    if (!strcmp(rt->graph.executor_mode, "synthetic")) {
        if (node->synthetic_due_ms > now) return 1;
        *finished = 1; *succeeded = !node->synthetic_should_fail && !node->native_cancel_requested;
        cstr_copy(node->native_message, sizeof node->native_message,
                  *succeeded ? "Synthetic executor completed" : "Synthetic executor injected failure");
        return 1;
    }
    if (node->kind == DTG_NODE_APPROVAL) return 1;
    if (node == g_dtg_agent_owner_node) {
        if (g_agent_working) return 1;
        if (!dtg_write_agent_transcript(rt, node, err, errsz)) return 0;
        node->native_done = 1;
        node->native_success = !node->watchdog_tripped && !node->native_cancel_requested &&
                               g_child > 0 && g_ready;
        if (node->native_success)
            cstr_copy(node->native_message, sizeof node->native_message, "Agent turn completed at WAITING boundary");
        else if (!node->watchdog_tripped && !node->native_cancel_requested)
            cstr_copy(node->native_message, sizeof node->native_message,
                      "Agent runtime exited before a healthy completion boundary");
        g_dtg_agent_owner_node = NULL;
        g_dtg_agent_owner_rt = NULL;
    }
#ifndef _WIN32
    if (node->native_pid > 0) {
        int status = 0;
        pid_t waited = waitpid(node->native_pid, &status, WNOHANG);
        if (waited == 0) return 1;
        if (waited < 0 && errno == EINTR) return 1;
        node->native_done = 1;
        node->native_success = waited == node->native_pid && WIFEXITED(status) && WEXITSTATUS(status) == 0 &&
                               !node->native_cancel_requested;
        snprintf(node->native_message, sizeof node->native_message,
                 node->native_success ? "Test process completed successfully" :
                 "Test process failed or was cancelled (status=%d)", status);
        node->native_pid = 0;
    }
#endif
    if (node->native_done) { *finished = 1; *succeeded = node->native_success; }
    return 1;
}

static int dtg_executor_finish(dtg_runtime *rt, dtg_node *node, int succeeded,
                               char *err, size_t errsz) {
    const char *message = node->native_message[0] ? node->native_message :
                          (succeeded ? "Executor completed" : "Executor failed");
    if (!dtg_write_attempt_result(rt, node, node->active_attempt_id, succeeded,
                                  message, err, errsz)) return 0;
    if (node->operation_task_id) {
        if (succeeded) task_mark_completed(node->operation_task_id, message);
        else task_mark_failed(node->operation_task_id, message,
                              node->watchdog_tripped ? "anti-loop watchdog" : "native executor result");
    }
    return 1;
}

static void dtg_executor_undo_summary(const dtg_runtime *rt, const dtg_node *node,
                                      int *available, int *applied, int *fully,
                                      char *message, size_t message_sz) {
    *available = node->undo_available;
    *applied = node->undo_applied;
    *fully = node->undo_fully_reversed;
    cstr_copy(message, message_sz, node->undo_message);
    if (!node->active_attempt_id[0]) return;
    char path[DTG_STORE_PATH_MAX], local_err[128] = "";
    if (dtg_attempt_file(rt, node, node->active_attempt_id, "checkpoint",
                         path, sizeof path, local_err, sizeof local_err) &&
        access(path, R_OK) == 0 && node->mutation != DTG_MUTATION_READ_ONLY)
        *available = 1;
    if (!dtg_attempt_file(rt, node, node->active_attempt_id, "undo",
                          path, sizeof path, local_err, sizeof local_err) ||
        access(path, R_OK) != 0) return;
    size_t len = 0;
    char *receipt = dtg_read_file_bounded(path, 128 * 1024, &len,
                                          local_err, sizeof local_err);
    if (!receipt) return;
    *applied = json_get_bool(receipt, "applied");
    *fully = json_get_bool(receipt, "fullyReversed");
    (void)json_get_string(receipt, "message", message, message_sz);
    free(receipt);
}

static int dtg_persist_undo_receipt(dtg_runtime *rt, dtg_node *node,
                                    int applied, int fully, int manual,
                                    const char *message, char *err, size_t errsz) {
    json_dyn_buf receipt = {0};
    int ok = json_dyn_printf(&receipt,
        "{\"schemaVersion\":1,\"scope\":\"declared target bytes and existence\",\"applied\":%s,\"fullyReversed\":%s,\"manualReviewRequired\":%s,\"nodeId\":",
        applied ? "true" : "false", fully ? "true" : "false", manual ? "true" : "false") &&
        json_dyn_put_escaped(&receipt, node->id) &&
        json_dyn_puts(&receipt, ",\"attemptId\":") && json_dyn_put_escaped(&receipt, node->active_attempt_id) &&
        json_dyn_puts(&receipt, ",\"message\":") && json_dyn_put_escaped(&receipt, message) &&
        json_dyn_printf(&receipt, ",\"createdAtMs\":%lld}", dstudio_now_ms()) &&
        dtg_attempt_write(rt, node, node->active_attempt_id, "undo", receipt.ptr,
                          receipt.len, 1, err, errsz);
    free(receipt.ptr);
    if (!ok) return 0;
    node->undo_available = 1; node->undo_applied = applied;
    node->undo_fully_reversed = fully;
    cstr_copy(node->undo_message, sizeof node->undo_message, message);
    return dtg_store_node_event(rt, node, "node.undo.receipt", node->state,
                                node->attempts_started, node->active_attempt_id,
                                node->operation_task_id, 0, message, err, errsz);
}

static int dtg_executor_undo(dtg_runtime *rt, dtg_node *node,
                             char *err, size_t errsz) {
    if (!rt || !node || !node->active_attempt_id[0]) {
        snprintf(err, errsz, "node has no completed attempt to undo"); return 0;
    }
    if (rt->graph.state != DTG_GRAPH_PAUSED && !dtg_graph_terminal(rt->graph.state)) {
        snprintf(err, errsz, "undo requires a paused or terminal graph"); return 0;
    }
    char checkpoint_path[DTG_STORE_PATH_MAX];
    if (!dtg_attempt_file(rt, node, node->active_attempt_id, "checkpoint",
                          checkpoint_path, sizeof checkpoint_path, err, errsz)) return 0;
    size_t receipt_len = 0;
    char *checkpoint = dtg_read_file_bounded(checkpoint_path, 128 * 1024,
                                             &receipt_len, err, errsz);
    if (!checkpoint) return 0;
    int reversible = json_get_bool(checkpoint, "reversible");
    int original_present = json_get_bool(checkpoint, "originalPresent");
    char expected_after[32] = "", relative[DSTUDIO_PATH_MAX] = "";
    (void)json_get_string(checkpoint, "expectedAfterDigest", expected_after, sizeof expected_after);
    (void)json_get_string(checkpoint, "path", relative, sizeof relative);
    free(checkpoint);

    int applied = 0, fully = 0, manual = 0;
    char message[256] = "";
    if (!reversible) {
        manual = node->mutation != DTG_MUTATION_READ_ONLY;
        snprintf(message, sizeof message, "%s", manual ?
                 "No automatic undo: nested effects were not observed file-by-file" :
                 "No mutation was declared; nothing needed undo");
        fully = !manual;
    } else {
        char target[DSTUDIO_PATH_MAX], current[17];
        unsigned long long current_bytes = 0; int present = 0;
        if (!dtg_native_resolve_path(rt, relative, 1, target, sizeof target, err, errsz) ||
            !dtg_file_fingerprint(target, current, &current_bytes, &present, err, errsz)) return 0;
        size_t observed_len = 0;
        char *observed = present ? dtg_read_file_bounded(target, (size_t)node->action_max_bytes,
                                                         &observed_len, err, errsz) : NULL;
        const size_t intended_len = node->action_text ? strlen(node->action_text) : 0;
        const int exact_post_state = present && observed && observed_len == intended_len &&
                                     !memcmp(observed, node->action_text, intended_len);
        free(observed);
        if (!exact_post_state) {
            char refused[256], receipt_err[256] = "";
            snprintf(refused, sizeof refused,
                     "Undo refused: target changed after checkpoint (expected %s, found %s)",
                     expected_after, current);
            (void)dtg_persist_undo_receipt(rt, node, 0, 0, 1, refused,
                                           receipt_err, sizeof receipt_err);
            snprintf(err, errsz, "%s", refused);
            return 0;
        }
        if (original_present) {
            char backup_path[DTG_STORE_PATH_MAX], directory[DSTUDIO_PATH_MAX];
            if (!dtg_attempt_file(rt, node, node->active_attempt_id, "backup",
                                  backup_path, sizeof backup_path, err, errsz)) return 0;
            size_t len = 0;
            char *backup = dtg_read_file_bounded(backup_path, (size_t)node->action_max_bytes,
                                                 &len, err, errsz);
            if (!backup) return 0;
            cstr_copy(directory, sizeof directory, target);
            char *slash = strrchr(directory, '/');
            if (!slash) { free(backup); snprintf(err, errsz, "undo target is invalid"); return 0; }
            *slash = '\0';
            if (!dtg_write_atomic(directory, slash + 1, backup, len, 0, err, errsz)) {
                free(backup); return 0;
            }
            size_t restored_len = 0;
            char *restored_bytes = dtg_read_file_bounded(target, len, &restored_len, err, errsz);
            fully = restored_bytes && restored_len == len && !memcmp(restored_bytes, backup, len);
            free(restored_bytes);
            free(backup);
        } else if (unlink(target) != 0 && errno != ENOENT) {
            snprintf(err, errsz, "cannot remove file created by action: %s", strerror(errno)); return 0;
        } else {
            fully = access(target, F_OK) != 0 && errno == ENOENT;
        }
        applied = fully;
        snprintf(message, sizeof message, "%s", fully ?
                 "Declared target bytes/existence restored; unrelated filesystem metadata was outside checkpoint scope" :
                 "Restore completed but byte verification failed");
    }

    return dtg_persist_undo_receipt(rt, node, applied, fully, manual,
                                    message, err, errsz);
}

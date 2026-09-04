/* DStudio Task Graph V1 — cooperative, non-blocking scheduler. */

static int dtg_dependency_satisfied(const dtg_graph *graph, const dtg_dependency *dep,
                                    int *permanently_failed) {
    const dtg_node *source = dtg_find_node_const(graph, dep->node_id);
    if (!source) { *permanently_failed = 1; return 0; }
    if (dep->condition == DTG_DEP_TERMINAL) return dtg_node_terminal(source->state);
    if (source->state == DTG_NODE_SUCCEEDED || source->state == DTG_NODE_SKIPPED) return 1;
    if (dtg_node_terminal(source->state)) *permanently_failed = 1;
    return 0;
}

static int dtg_graph_running_nodes(const dtg_graph *graph, dtg_node_kind kind,
                                   int writers_only) {
    int count = 0;
    for (size_t i = 0; i < graph->node_count; i++) {
        const dtg_node *node = &graph->nodes[i];
        if (node->state != DTG_NODE_RUNNING && node->state != DTG_NODE_LEASED &&
            node->state != DTG_NODE_CANCELLING) continue;
        if (kind != DTG_NODE_KIND_INVALID && node->kind != kind) continue;
        if (writers_only && node->mutation != DTG_MUTATION_WORKSPACE_WRITE &&
            node->mutation != DTG_MUTATION_EXTERNAL_SIDE_EFFECT) continue;
        count++;
    }
    return count;
}

static int dtg_global_llm_busy(void) {
    for (int r = 0; r < DTG_MAX_REGISTRY; r++) {
        if (!g_dtg_registry[r].used) continue;
        if (dtg_graph_running_nodes(&g_dtg_registry[r].graph, DTG_NODE_AGENT_TURN, 0)) return 1;
    }
    return 0;
}

static int dtg_global_writer_busy(void) {
    for (int r = 0; r < DTG_MAX_REGISTRY; r++) {
        if (!g_dtg_registry[r].used) continue;
        if (dtg_graph_running_nodes(&g_dtg_registry[r].graph, DTG_NODE_KIND_INVALID, 1)) return 1;
    }
    return 0;
}

static int dtg_scheduler_set_node(dtg_runtime *rt, dtg_node *node,
                                  const char *type, dtg_node_state state,
                                  const char *message, char *err, size_t errsz) {
    return dtg_store_node_event(rt, node, type, state, node->attempts_started,
                                node->active_attempt_id, node->operation_task_id,
                                node->synthetic_due_ms, message, err, errsz);
}

static int dtg_scheduler_recompute_ready(dtg_runtime *rt, char *err, size_t errsz) {
    dtg_graph *graph = &rt->graph;
    for (size_t i = 0; i < graph->node_count; i++) {
        dtg_node *node = &graph->nodes[i];
        if (node->state != DTG_NODE_PENDING && node->state != DTG_NODE_BLOCKED) continue;
        int all = 1, permanent = 0;
        for (size_t d = 0; d < node->dependency_count; d++) {
            int failed = 0;
            if (!dtg_dependency_satisfied(graph, &node->dependencies[d], &failed)) all = 0;
            if (failed) permanent = 1;
        }
        if (permanent && node->state != DTG_NODE_BLOCKED) {
            if (!dtg_scheduler_set_node(rt, node, "node.blocked", DTG_NODE_BLOCKED,
                                        "A required dependency did not succeed", err, errsz)) return 0;
        } else if (!permanent && all && node->state != DTG_NODE_READY) {
            if (node->state == DTG_NODE_BLOCKED &&
                !dtg_scheduler_set_node(rt, node, "node.unblocked", DTG_NODE_PENDING,
                                        "Dependencies changed", err, errsz)) return 0;
            if (!dtg_scheduler_set_node(rt, node, "node.ready", DTG_NODE_READY,
                                        "Dependencies satisfied", err, errsz)) return 0;
        }
    }
    return 1;
}

static dtg_node *dtg_scheduler_next_ready(dtg_runtime *rt) {
    dtg_node *best = NULL;
    for (size_t i = 0; i < rt->graph.node_count; i++) {
        dtg_node *node = &rt->graph.nodes[i];
        if (node->state != DTG_NODE_READY || !dtg_executor_can_dispatch(node)) continue;
        if (node->kind == DTG_NODE_AGENT_TURN && dtg_global_llm_busy()) continue;
        if ((node->mutation == DTG_MUTATION_WORKSPACE_WRITE ||
             node->mutation == DTG_MUTATION_EXTERNAL_SIDE_EFFECT) && dtg_global_writer_busy()) continue;
        if (node->kind == DTG_NODE_HOST_TOOL &&
            dtg_graph_running_nodes(&rt->graph, DTG_NODE_HOST_TOOL, 0) >= rt->graph.max_parallel_host_nodes) continue;
        /* Gates and approvals outrank regular work. Then explicit priority and FIFO. */
        int node_class = (node->kind == DTG_NODE_GATE || node->kind == DTG_NODE_APPROVAL) ? 2 :
                         node->kind == DTG_NODE_JOIN ? 1 : 0;
        int best_class = best ? ((best->kind == DTG_NODE_GATE || best->kind == DTG_NODE_APPROVAL) ? 2 :
                         best->kind == DTG_NODE_JOIN ? 1 : 0) : -1;
        if (!best || node_class > best_class ||
            (node_class == best_class && node->priority > best->priority) ||
            (node_class == best_class && node->priority == best->priority && node->ready_ms < best->ready_ms))
            best = node;
    }
    return best;
}

static int dtg_scheduler_dispatch(dtg_runtime *rt, dtg_node *node,
                                  long long now, char *err, size_t errsz) {
    if (!dtg_scheduler_set_node(rt, node, "node.leased", DTG_NODE_LEASED,
                                "Executor lease acquired", err, errsz)) return 0;
    char attempt[DTG_ID_MAX + 1] = "";
    unsigned long long operation = 0;
    long long due = 0;
    if (!dtg_executor_begin(rt, node, now, attempt, sizeof attempt,
                            &operation, &due, err, errsz)) {
        char persist_err[256] = "";
        (void)dtg_store_node_event(rt, node, "node.dispatch_deferred", DTG_NODE_READY,
                                   node->attempts_started, "", 0, 0,
                                   err, persist_err, sizeof persist_err);
        return 0;
    }
    int attempts = node->attempts_started + 1;
    if (!dtg_store_node_event(rt, node, "attempt.started", DTG_NODE_RUNNING,
                              attempts, attempt, operation, due,
                              !strcmp(rt->graph.executor_mode, "native") ?
                                "Native attempt started with policy receipt" :
                                "Synthetic attempt started", err, errsz)) {
        task_mark_failed(operation, "Task graph state persistence failed", err);
        return 0;
    }
    if (node->kind == DTG_NODE_APPROVAL) {
        if (!dtg_scheduler_set_node(rt, node, "node.waiting_approval", DTG_NODE_WAITING_APPROVAL,
                                    "Waiting for explicit user approval", err, errsz)) return 0;
        if (!dtg_store_graph_event(rt, "graph.waiting_approval", DTG_GRAPH_WAITING_APPROVAL,
                                   rt->graph.approved, "Waiting for node approval", err, errsz)) return 0;
    }
    return 1;
}

static int dtg_scheduler_finish_node(dtg_runtime *rt, dtg_node *node,
                                     long long now, char *err, size_t errsz) {
    int finished = 0, succeeded = 0;
    if (!dtg_executor_poll(rt, node, now, &finished, &succeeded, err, errsz)) return 0;
    if (!finished) return 1;
    if (!dtg_executor_finish(rt, node, succeeded, err, errsz)) return 0;
    char attempt[DTG_ID_MAX + 1];
    cstr_copy(attempt, sizeof attempt, node->active_attempt_id);
    unsigned long long operation = node->operation_task_id;
    if (succeeded) {
        return dtg_store_node_event(rt, node, "attempt.succeeded", DTG_NODE_SUCCEEDED,
                                    node->attempts_started, attempt, operation, 0,
                                    "Node completed and result persisted", err, errsz);
    }
    if (!dtg_store_node_event(rt, node, "attempt.failed", DTG_NODE_FAILED,
                              node->attempts_started, attempt, operation, 0,
                              node->native_message[0] ? node->native_message : "Node executor failed",
                              err, errsz)) return 0;
    const int proven_no_effect_agent_attempt =
        !strcmp(node->action_name, "agent.prompt") &&
        node->action_require_tool_result && node->watchdog_tool_calls == 0;
    if (node->automatic_retry && (node->idempotent || proven_no_effect_agent_attempt) &&
        node->attempts_started < node->max_attempts) {
        return dtg_store_node_event(rt, node, "node.retry_scheduled", DTG_NODE_PENDING,
                                    node->attempts_started, "", 0, 0,
                                    proven_no_effect_agent_attempt && !node->idempotent
                                      ? "Automatic retry scheduled: transcript proves zero tool calls"
                                      : "Idempotent automatic retry scheduled",
                                    err, errsz);
    }
    return 1;
}

static int dtg_scheduler_finalize_graph(dtg_runtime *rt, char *err, size_t errsz) {
    dtg_graph *graph = &rt->graph;
    int unfinished = 0, required_failure = 0;
    for (size_t i = 0; i < graph->node_count; i++) {
        dtg_node *node = &graph->nodes[i];
        if (!dtg_node_terminal(node->state)) unfinished = 1;
        if (!node->optional && (node->state == DTG_NODE_FAILED || node->state == DTG_NODE_CANCELLED ||
                                node->state == DTG_NODE_BLOCKED)) required_failure = 1;
    }
    if (required_failure && graph->state == DTG_GRAPH_RUNNING) {
        cstr_copy(graph->error, sizeof graph->error, "A required node failed or became blocked");
        return dtg_store_graph_event(rt, "graph.failed", DTG_GRAPH_FAILED, graph->approved,
                                     graph->error, err, errsz);
    }
    if (!unfinished && graph->state == DTG_GRAPH_RUNNING) {
        return dtg_store_graph_event(rt, "graph.succeeded", DTG_GRAPH_SUCCEEDED, graph->approved,
                                     "All required nodes completed", err, errsz);
    }
    return 1;
}

static int dtg_scheduler_process_cancelling(dtg_runtime *rt, char *err, size_t errsz) {
    dtg_graph *graph = &rt->graph;
    if (graph->state != DTG_GRAPH_CANCELLING) return 1;
    for (size_t i = 0; i < graph->node_count; i++) {
        dtg_node *node = &graph->nodes[i];
        if (dtg_node_terminal(node->state)) continue;
        if (node->state == DTG_NODE_RUNNING || node->state == DTG_NODE_LEASED) {
            if (!dtg_scheduler_set_node(rt, node, "node.cancelling", DTG_NODE_CANCELLING,
                                        "Graph cancellation requested", err, errsz)) return 0;
        }
        if (node->state == DTG_NODE_CANCELLING) {
            (void)dtg_executor_cancel(rt, node, "Task graph cancelled");
            if (node->operation_task_id) task_mark_canceled(node->operation_task_id, "Task graph cancelled");
            if (!dtg_scheduler_set_node(rt, node, "node.cancelled", DTG_NODE_CANCELLED,
                                        "Graph cancelled", err, errsz)) return 0;
        } else if (!dtg_scheduler_set_node(rt, node, "node.cancelled", DTG_NODE_CANCELLED,
                                           "Graph cancelled before dispatch", err, errsz)) return 0;
    }
    return dtg_store_graph_event(rt, "graph.cancelled", DTG_GRAPH_CANCELLED,
                                 graph->approved, "Graph cancellation settled", err, errsz);
}

static void dtg_scheduler_tick(long long now) {
    for (int r = 0; r < DTG_MAX_REGISTRY; r++) {
        dtg_runtime *rt = &g_dtg_registry[r];
        if (!rt->used || rt->corrupt) continue;
        dtg_graph *graph = &rt->graph;
        char err[512] = "";
        if (graph->state == DTG_GRAPH_CANCELLING) {
            if (!dtg_scheduler_process_cancelling(rt, err, sizeof err))
                dstudio_log_event("error", "task-graph", 0, "%s", err);
            continue;
        }
        if (graph->state == DTG_GRAPH_PAUSING) {
            for (size_t i = 0; i < graph->node_count; i++) {
                dtg_node *node = &graph->nodes[i];
                if (node->state == DTG_NODE_RUNNING &&
                    !dtg_scheduler_finish_node(rt, node, now, err, sizeof err)) break;
            }
            if (!dtg_graph_running_nodes(graph, DTG_NODE_KIND_INVALID, 0)) {
                for (size_t i = 0; i < graph->node_count; i++) {
                    dtg_node *node = &graph->nodes[i];
                    if (node->state == DTG_NODE_READY &&
                        !dtg_scheduler_set_node(rt, node, "node.paused", DTG_NODE_PAUSED,
                                                "Graph paused", err, sizeof err)) break;
                }
                (void)dtg_store_graph_event(rt, "graph.paused", DTG_GRAPH_PAUSED,
                                            graph->approved, "Graph paused", err, sizeof err);
            }
            continue;
        }
        if (graph->state != DTG_GRAPH_RUNNING) continue;

        /* Recovery may observe graph.started after its durable event but before
         * the per-node pending events were appended. Complete that idempotent
         * initialization here instead of leaving a running graph with drafts. */
        for (size_t i = 0; i < graph->node_count; i++) {
            dtg_node *node = &graph->nodes[i];
            if (node->state == DTG_NODE_DRAFT &&
                !dtg_scheduler_set_node(rt, node, "node.pending", DTG_NODE_PENDING,
                                        "Recovered scheduler initialization", err, sizeof err)) break;
        }
        if (err[0]) { dstudio_log_event("error", "task-graph", 0, "%s", err); continue; }

        for (size_t i = 0; i < graph->node_count; i++) {
            dtg_node *node = &graph->nodes[i];
            if (node->state != DTG_NODE_RUNNING) continue;
            if (!strcmp(graph->executor_mode, "native") && !node->native_done &&
                !node->native_pid && node != g_dtg_agent_owner_node &&
                node->kind != DTG_NODE_APPROVAL && !node->native_message[0]) {
                node->native_done = 1;
                node->native_success = 0;
                cstr_copy(node->native_message, sizeof node->native_message,
                          "Attempt interrupted by host restart; no live executor lease exists");
            }
            if (node->timeout_ms > 0 && node->started_ms > 0 && now - node->started_ms > node->timeout_ms) {
                (void)dtg_executor_cancel(rt, node, "Node timeout reached");
                if (!dtg_scheduler_finish_node(rt, node, now, err, sizeof err)) break;
            } else {
                if (!dtg_scheduler_finish_node(rt, node, now, err, sizeof err)) break;
            }
        }
        if (err[0]) { dstudio_log_event("error", "task-graph", 0, "%s", err); continue; }
        if (!dtg_scheduler_recompute_ready(rt, err, sizeof err)) {
            dstudio_log_event("error", "task-graph", 0, "%s", err); continue;
        }
        int budget = 32;
        while (budget-- > 0) {
            dtg_node *node = dtg_scheduler_next_ready(rt);
            if (!node) break;
            if (!dtg_scheduler_dispatch(rt, node, now, err, sizeof err)) break;
            if (graph->state != DTG_GRAPH_RUNNING) break;
        }
        if (err[0]) { dstudio_log_event("error", "task-graph", 0, "%s", err); continue; }
        (void)dtg_scheduler_finalize_graph(rt, err, sizeof err);
        if (err[0]) dstudio_log_event("error", "task-graph", 0, "%s", err);
    }
}

static int dtg_scheduler_start(dtg_runtime *rt, char *err, size_t errsz) {
    if (!rt || rt->corrupt) { snprintf(err, errsz, "task graph is unavailable"); return 0; }
    if (rt->graph.approval_required && !rt->graph.approved) {
        snprintf(err, errsz, "graph requires approval before start"); return 0;
    }
    if (rt->graph.state != DTG_GRAPH_READY) {
        snprintf(err, errsz, "graph is not ready"); return 0;
    }
    if (!dtg_executor_graph_available(&rt->graph, err, errsz)) return 0;
    if (!dtg_store_graph_event(rt, "graph.started", DTG_GRAPH_RUNNING,
                               rt->graph.approved, "Graph execution started", err, errsz)) return 0;
    for (size_t i = 0; i < rt->graph.node_count; i++) {
        dtg_node *node = &rt->graph.nodes[i];
        if (node->state == DTG_NODE_DRAFT &&
            !dtg_scheduler_set_node(rt, node, "node.pending", DTG_NODE_PENDING,
                                    "Node entered the scheduler", err, errsz)) return 0;
    }
    dtg_scheduler_tick(dstudio_now_ms());
    return 1;
}

static int dtg_scheduler_pause(dtg_runtime *rt, char *err, size_t errsz) {
    if (!rt || rt->graph.state != DTG_GRAPH_RUNNING) {
        snprintf(err, errsz, "only a running graph can be paused"); return 0;
    }
    return dtg_store_graph_event(rt, "graph.pausing", DTG_GRAPH_PAUSING,
                                 rt->graph.approved, "Pause requested", err, errsz);
}

static int dtg_scheduler_resume(dtg_runtime *rt, char *err, size_t errsz) {
    if (!rt || rt->graph.state != DTG_GRAPH_PAUSED) {
        snprintf(err, errsz, "only a paused graph can be resumed"); return 0;
    }
    if (!dtg_store_graph_event(rt, "graph.resumed", DTG_GRAPH_RUNNING,
                               rt->graph.approved, "Graph resumed", err, errsz)) return 0;
    for (size_t i = 0; i < rt->graph.node_count; i++) {
        dtg_node *node = &rt->graph.nodes[i];
        if (node->state == DTG_NODE_PAUSED &&
            !dtg_scheduler_set_node(rt, node, "node.ready", DTG_NODE_READY,
                                    "Graph resumed", err, errsz)) return 0;
    }
    return 1;
}

static int dtg_scheduler_cancel(dtg_runtime *rt, char *err, size_t errsz) {
    if (!rt || dtg_graph_terminal(rt->graph.state)) {
        snprintf(err, errsz, "task graph is already terminal"); return 0;
    }
    if (rt->graph.state == DTG_GRAPH_DRAFT || rt->graph.state == DTG_GRAPH_VALIDATED ||
        rt->graph.state == DTG_GRAPH_READY) {
        for (size_t i = 0; i < rt->graph.node_count; i++) {
            dtg_node *node = &rt->graph.nodes[i];
            if (!dtg_node_terminal(node->state) &&
                !dtg_scheduler_set_node(rt, node, "node.cancelled", DTG_NODE_CANCELLED,
                                        "Graph cancelled before start", err, errsz)) return 0;
        }
        return dtg_store_graph_event(rt, "graph.cancelled", DTG_GRAPH_CANCELLED,
                                     rt->graph.approved, "Graph cancelled", err, errsz);
    }
    if (!dtg_store_graph_event(rt, "graph.cancelling", DTG_GRAPH_CANCELLING,
                               rt->graph.approved, "Cancellation requested", err, errsz)) return 0;
    return dtg_scheduler_process_cancelling(rt, err, errsz);
}

static int dtg_scheduler_approve_graph(dtg_runtime *rt, char *err, size_t errsz) {
    if (!rt || !rt->graph.approval_required || rt->graph.approved ||
        rt->graph.state != DTG_GRAPH_VALIDATED) {
        snprintf(err, errsz, "graph is not awaiting approval"); return 0;
    }
    if (!dtg_write_approval_receipt(rt, NULL, err, errsz)) return 0;
    return dtg_store_graph_event(rt, "graph.approved", DTG_GRAPH_READY, 1,
                                 "Graph approved by user", err, errsz);
}

static int dtg_scheduler_approve_node(dtg_runtime *rt, const char *node_id,
                                      char *err, size_t errsz) {
    dtg_node *node = rt ? dtg_find_node(&rt->graph, node_id) : NULL;
    if (!node || node->kind != DTG_NODE_APPROVAL || node->state != DTG_NODE_WAITING_APPROVAL) {
        snprintf(err, errsz, "node is not awaiting approval"); return 0;
    }
    if (!dtg_write_approval_receipt(rt, node, err, errsz)) return 0;
    if (node->operation_task_id) task_mark_completed(node->operation_task_id, "Approval granted");
    if (!dtg_write_attempt_result(rt, node, node->active_attempt_id, 1,
                                  "Approval granted", err, errsz)) return 0;
    if (!dtg_store_node_event(rt, node, "node.approved", DTG_NODE_SUCCEEDED,
                              node->attempts_started, node->active_attempt_id,
                              node->operation_task_id, 0, "Node approved by user", err, errsz)) return 0;
    if (rt->graph.state == DTG_GRAPH_WAITING_APPROVAL)
        return dtg_store_graph_event(rt, "graph.resumed_after_approval", DTG_GRAPH_RUNNING,
                                     rt->graph.approved, "Approval granted", err, errsz);
    return 1;
}

static int dtg_scheduler_retry_node(dtg_runtime *rt, const char *node_id,
                                    char *err, size_t errsz) {
    dtg_node *node = rt ? dtg_find_node(&rt->graph, node_id) : NULL;
    if (!node || node->state != DTG_NODE_FAILED) { snprintf(err, errsz, "node is not failed"); return 0; }
    if (node->attempts_started >= node->max_attempts) { snprintf(err, errsz, "node exhausted maxAttempts"); return 0; }
    if (!node->idempotent && node->mutation != DTG_MUTATION_READ_ONLY) {
        snprintf(err, errsz, "non-idempotent mutating node cannot be retried automatically"); return 0;
    }
    return dtg_store_node_event(rt, node, "node.retry_requested", DTG_NODE_PENDING,
                                node->attempts_started, "", 0, 0,
                                "Explicit retry requested", err, errsz);
}

static int dtg_scheduler_skip_node(dtg_runtime *rt, const char *node_id,
                                   char *err, size_t errsz) {
    dtg_node *node = rt ? dtg_find_node(&rt->graph, node_id) : NULL;
    if (!node || !node->optional || (node->state != DTG_NODE_PENDING &&
        node->state != DTG_NODE_READY && node->state != DTG_NODE_BLOCKED)) {
        snprintf(err, errsz, "only an optional pending node can be skipped"); return 0;
    }
    return dtg_store_node_event(rt, node, "node.skipped", DTG_NODE_SKIPPED,
                                node->attempts_started, node->active_attempt_id,
                                node->operation_task_id, 0, "Optional node skipped", err, errsz);
}

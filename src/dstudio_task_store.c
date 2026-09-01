/*
 * DStudio Task Graph V1 — persistent, event-sourced graph store.
 *
 * events.jsonl is authoritative. state.json is a materialized cache rebuilt by
 * replay, so a crash after the durable append but before the atomic snapshot
 * never loses an accepted transition.  The HTTP server is single threaded,
 * but the per-graph advisory lock also protects future workers and a second
 * DStudio process using the same workspace.
 */

#define DTG_STORE_PATH_MAX (DSTUDIO_PATH_MAX + 320)
#define DTG_EVENT_LINE_MAX (128u * 1024u)

typedef struct {
    int used;
    int corrupt;
    dtg_graph graph;
    char directory[DTG_STORE_PATH_MAX];
    char workspace_real[DSTUDIO_PATH_MAX];
    long long loaded_ms;
} dtg_runtime;

static dtg_runtime g_dtg_registry[DTG_MAX_REGISTRY];
static unsigned long long g_dtg_graph_counter = 0;

static int dtg_policy_validate(const dtg_graph *graph, int requested_strict,
                               char *err, size_t errsz);

static int dtg_path_join(char *out, size_t outsz, const char *a, const char *b) {
    int n = snprintf(out, outsz, "%s/%s", a ? a : "", b ? b : "");
    return n >= 0 && (size_t)n < outsz;
}

static int dtg_failpoint(const char *name) {
    const char *test = getenv("DS4UI_TEST_MODE");
    const char *value = getenv(name);
    return test && test[0] && value && value[0] && strcmp(value, "0");
}

static int dtg_workspace_resolve(const char *workspace, char *out, size_t outsz,
                                 char *err, size_t errsz) {
    if (!workspace || !workspace[0]) {
        if (!dstudio_data_dir_path(out, outsz)) {
            snprintf(err, errsz, "DStudio data directory is unavailable");
            return 0;
        }
        return 1;
    }
#ifdef _WIN32
    char resolved[DSTUDIO_PATH_MAX];
    if (!_fullpath(resolved, workspace, sizeof resolved)) {
        snprintf(err, errsz, "workspace does not exist");
        return 0;
    }
    struct _stat st;
    if (_stat(resolved, &st) != 0 || !(st.st_mode & _S_IFDIR)) {
        snprintf(err, errsz, "workspace is not a directory");
        return 0;
    }
#else
    char resolved[DSTUDIO_PATH_MAX];
    struct stat st;
    if (!realpath(workspace, resolved) || stat(resolved, &st) != 0 || !S_ISDIR(st.st_mode)) {
        snprintf(err, errsz, "workspace is not an existing directory");
        return 0;
    }
#endif
    if (snprintf(out, outsz, "%s", resolved) < 0 || strlen(resolved) >= outsz) {
        snprintf(err, errsz, "workspace path is too long");
        return 0;
    }
    return 1;
}

static int dtg_store_root(const char *workspace, char *workspace_real, size_t wsz,
                          char *root, size_t rootsz, char *err, size_t errsz) {
    if (!dtg_workspace_resolve(workspace, workspace_real, wsz, err, errsz)) return 0;
    int n;
    if (workspace && workspace[0])
        n = snprintf(root, rootsz, "%s/.dstudio/task-graphs", workspace_real);
    else
        n = snprintf(root, rootsz, "%s/task-graphs", workspace_real);
    if (n < 0 || (size_t)n >= rootsz) {
        snprintf(err, errsz, "task graph store path is too long");
        return 0;
    }
    return 1;
}

static char *dtg_read_file_bounded(const char *path, size_t limit, size_t *out_len,
                                   char *err, size_t errsz) {
    if (out_len) *out_len = 0;
    FILE *f = fopen(path, "rb");
    if (!f) {
        snprintf(err, errsz, "cannot read %s: %s", path, strerror(errno));
        return NULL;
    }
    if (fseek(f, 0, SEEK_END) != 0) { fclose(f); snprintf(err, errsz, "cannot seek %s", path); return NULL; }
    long raw = ftell(f);
    if (raw < 0 || (unsigned long)raw > limit) {
        fclose(f); snprintf(err, errsz, "%s exceeds its bounded size", path); return NULL;
    }
    rewind(f);
    size_t len = (size_t)raw;
    char *buf = malloc(len + 1);
    if (!buf) { fclose(f); snprintf(err, errsz, "out of memory reading graph store"); return NULL; }
    if (len && fread(buf, 1, len, f) != len) {
        free(buf); fclose(f); snprintf(err, errsz, "short read from %s", path); return NULL;
    }
    fclose(f);
    buf[len] = '\0';
    if (out_len) *out_len = len;
    return buf;
}

static int dtg_fsync_directory(const char *directory) {
#ifdef _WIN32
    (void)directory;
    return 1;
#else
    int fd = open(directory, O_RDONLY | O_DIRECTORY);
    if (fd < 0) return 0;
    int ok = fsync(fd) == 0;
    close(fd);
    return ok;
#endif
}

static int dtg_write_atomic(const char *directory, const char *name,
                            const char *data, size_t len, int immutable,
                            char *err, size_t errsz) {
    char final_path[DTG_STORE_PATH_MAX], temp_path[DTG_STORE_PATH_MAX];
    if (!dtg_path_join(final_path, sizeof final_path, directory, name)) {
        snprintf(err, errsz, "store filename is too long"); return 0;
    }
    if (immutable && access(final_path, F_OK) == 0) {
        snprintf(err, errsz, "immutable store file already exists: %s", name); return 0;
    }
    int n = snprintf(temp_path, sizeof temp_path, "%s/.%s.tmp.%ld.%llu", directory,
                     name, (long)getpid(), ++g_dtg_graph_counter);
    if (n < 0 || (size_t)n >= sizeof temp_path) {
        snprintf(err, errsz, "temporary store path is too long"); return 0;
    }
#ifdef _WIN32
    int flags = _O_WRONLY | _O_CREAT | _O_BINARY | (immutable ? _O_EXCL : _O_TRUNC);
    int fd = _open(temp_path, flags, _S_IREAD | _S_IWRITE);
#else
    int flags = O_WRONLY | O_CREAT | (immutable ? O_EXCL : O_TRUNC);
    int fd = open(temp_path, flags, 0600);
#endif
    if (fd < 0) { snprintf(err, errsz, "cannot create %s: %s", temp_path, strerror(errno)); return 0; }
    size_t off = 0;
    while (off < len) {
#ifdef _WIN32
        int w = _write(fd, data + off, (unsigned)((len - off) > INT_MAX ? INT_MAX : (len - off)));
#else
        ssize_t w = write(fd, data + off, len - off);
#endif
        if (w < 0 && errno == EINTR) continue;
        if (w <= 0) break;
        off += (size_t)w;
    }
#ifdef _WIN32
    int ok = off == len && _commit(fd) == 0 && _close(fd) == 0;
#else
    int ok = off == len && fsync(fd) == 0 && close(fd) == 0;
#endif
    if (!ok) {
        unlink(temp_path); snprintf(err, errsz, "cannot durably write %s", name); return 0;
    }
    if (!strcmp(name, "state.json") && dtg_failpoint("DTG_FAIL_BEFORE_STATE_RENAME")) {
        unlink(temp_path); snprintf(err, errsz, "injected failure before state rename"); return 0;
    }
    if (rename(temp_path, final_path) != 0) {
        unlink(temp_path); snprintf(err, errsz, "cannot replace %s: %s", name, strerror(errno)); return 0;
    }
    if (!dtg_fsync_directory(directory)) {
        snprintf(err, errsz, "cannot fsync task graph directory"); return 0;
    }
    return 1;
}

static int dtg_lock_graph(const dtg_runtime *rt, int *fd_out,
                          char *err, size_t errsz) {
    char path[DTG_STORE_PATH_MAX];
    if (!dtg_path_join(path, sizeof path, rt->directory, "lock")) {
        snprintf(err, errsz, "graph lock path is too long"); return 0;
    }
#ifdef _WIN32
    int fd = _open(path, _O_RDWR | _O_CREAT | _O_BINARY, _S_IREAD | _S_IWRITE);
    if (fd < 0) { snprintf(err, errsz, "cannot open graph lock"); return 0; }
    /* The server is single threaded on Windows V1. O_EXCL graph directory
     * creation plus the process-local registry prevent concurrent mutations. */
#else
    int fd = open(path, O_RDWR | O_CREAT, 0600);
    if (fd < 0 || flock(fd, LOCK_EX | LOCK_NB) != 0) {
        if (fd >= 0) close(fd);
        snprintf(err, errsz, "task graph is locked by another writer"); return 0;
    }
    if (ftruncate(fd, 0) == 0) {
        char owner[96];
        int n = snprintf(owner, sizeof owner, "pid=%ld acquiredMs=%lld\n",
                         (long)getpid(), dstudio_now_ms());
        if (n > 0) { (void)write(fd, owner, (size_t)n); (void)fsync(fd); }
    }
#endif
    *fd_out = fd;
    return 1;
}

static void dtg_unlock_graph(int fd) {
    if (fd < 0) return;
#ifdef _WIN32
    _close(fd);
#else
    (void)flock(fd, LOCK_UN);
    close(fd);
#endif
}

static int dtg_state_json(const dtg_runtime *rt, json_dyn_buf *b) {
    const dtg_graph *g = &rt->graph;
    int ok = json_dyn_printf(b, "{\"schemaVersion\":%u", DTG_SCHEMA_VERSION) &&
        json_dyn_puts(b, ",\"graphId\":") && json_dyn_put_escaped(b, g->id) &&
        json_dyn_printf(b, ",\"revision\":%u,\"lastAppliedEventSeq\":%llu", g->revision, g->last_event_seq) &&
        json_dyn_puts(b, ",\"state\":") && json_dyn_put_escaped(b, dtg_graph_state_name(g->state)) &&
        json_dyn_printf(b, ",\"approved\":%s,\"createdMs\":%lld,\"updatedMs\":%lld,\"startedMs\":%lld,\"completedMs\":%lld",
                        g->approved ? "true" : "false", g->created_ms, g->updated_ms,
                        g->started_ms, g->completed_ms) &&
        json_dyn_puts(b, ",\"error\":") && json_dyn_put_escaped(b, g->error) &&
        json_dyn_puts(b, ",\"nodes\":[");
    for (size_t i = 0; ok && i < g->node_count; i++) {
        const dtg_node *node = &g->nodes[i];
        if (i) ok = json_dyn_puts(b, ",");
        ok = ok && json_dyn_puts(b, "{\"id\":") && json_dyn_put_escaped(b, node->id) &&
            json_dyn_puts(b, ",\"state\":") && json_dyn_put_escaped(b, dtg_node_state_name(node->state)) &&
            json_dyn_printf(b, ",\"attemptsStarted\":%d,\"operationTaskId\":%llu",
                            node->attempts_started, node->operation_task_id) &&
            json_dyn_puts(b, ",\"activeAttemptId\":") && json_dyn_put_escaped(b, node->active_attempt_id) &&
            json_dyn_printf(b, ",\"readyMs\":%lld,\"startedMs\":%lld,\"finishedMs\":%lld,\"syntheticDueMs\":%lld}",
                            node->ready_ms, node->started_ms, node->finished_ms, node->synthetic_due_ms);
    }
    return ok && json_dyn_puts(b, "]}");
}

static int dtg_write_snapshot_locked(dtg_runtime *rt, char *err, size_t errsz) {
    json_dyn_buf state = {0};
    int ok = dtg_state_json(rt, &state) &&
             dtg_write_atomic(rt->directory, "state.json", state.ptr, state.len, 0, err, errsz);
    if (!ok && (!err || !err[0])) snprintf(err, errsz, "cannot serialize task graph state");
    free(state.ptr);
    return ok;
}

static int dtg_append_event_locked(dtg_runtime *rt, const char *type,
                                   const dtg_node *node,
                                   dtg_graph_state graph_state,
                                   dtg_node_state node_state,
                                   int approved, int attempts,
                                   const char *attempt_id,
                                   unsigned long long operation_task_id,
                                   long long synthetic_due_ms,
                                   const char *message,
                                   unsigned long long *seq_out,
                                   long long *timestamp_out,
                                   char *err, size_t errsz) {
    unsigned long long seq = rt->graph.last_event_seq + 1;
    long long timestamp = dstudio_now_ms();
    json_dyn_buf event = {0};
    int ok = json_dyn_printf(&event, "{\"seq\":%llu,\"ts\":%lld,\"type\":", seq, timestamp) &&
        json_dyn_put_escaped(&event, type) && json_dyn_puts(&event, ",\"graphId\":") &&
        json_dyn_put_escaped(&event, rt->graph.id) &&
        json_dyn_printf(&event, ",\"revision\":%u,\"graphState\":", rt->graph.revision) &&
        json_dyn_put_escaped(&event, dtg_graph_state_name(graph_state)) &&
        json_dyn_printf(&event, ",\"approved\":%s", approved ? "true" : "false");
    if (ok && node) {
        ok = json_dyn_puts(&event, ",\"nodeId\":") && json_dyn_put_escaped(&event, node->id) &&
             json_dyn_puts(&event, ",\"nodeState\":") && json_dyn_put_escaped(&event, dtg_node_state_name(node_state)) &&
             json_dyn_printf(&event, ",\"attemptsStarted\":%d,\"operationTaskId\":%llu,\"syntheticDueMs\":%lld",
                             attempts, operation_task_id, synthetic_due_ms) &&
             json_dyn_puts(&event, ",\"attemptId\":") && json_dyn_put_escaped(&event, attempt_id ? attempt_id : "");
    }
    ok = ok && json_dyn_puts(&event, ",\"message\":") && json_dyn_put_escaped(&event, message ? message : "") &&
         json_dyn_puts(&event, "}\n");
    if (!ok) { free(event.ptr); snprintf(err, errsz, "out of memory serializing task graph event"); return 0; }
    char path[DTG_STORE_PATH_MAX];
    if (!dtg_path_join(path, sizeof path, rt->directory, "events.jsonl")) {
        free(event.ptr); snprintf(err, errsz, "event path is too long"); return 0;
    }
#ifdef _WIN32
    int fd = _open(path, _O_WRONLY | _O_CREAT | _O_APPEND | _O_BINARY, _S_IREAD | _S_IWRITE);
#else
    int fd = open(path, O_WRONLY | O_CREAT | O_APPEND, 0600);
#endif
    if (fd < 0) { free(event.ptr); snprintf(err, errsz, "cannot append graph event: %s", strerror(errno)); return 0; }
    size_t off = 0;
    while (off < event.len) {
#ifdef _WIN32
        int w = _write(fd, event.ptr + off, (unsigned)(event.len - off));
#else
        ssize_t w = write(fd, event.ptr + off, event.len - off);
#endif
        if (w < 0 && errno == EINTR) continue;
        if (w <= 0) break;
        off += (size_t)w;
    }
#ifdef _WIN32
    ok = off == event.len && _commit(fd) == 0 && _close(fd) == 0;
#else
    ok = off == event.len && fsync(fd) == 0 && close(fd) == 0;
#endif
    free(event.ptr);
    if (!ok) { snprintf(err, errsz, "cannot durably append task graph event"); return 0; }
    if (seq_out) *seq_out = seq;
    if (timestamp_out) *timestamp_out = timestamp;
    if (dtg_failpoint("DTG_FAIL_AFTER_EVENT_APPEND")) {
        snprintf(err, errsz, "injected failure after event append"); return 0;
    }
    return 1;
}

static int dtg_store_graph_event(dtg_runtime *rt, const char *type,
                                 dtg_graph_state target, int approved,
                                 const char *message, char *err, size_t errsz) {
    if (target != rt->graph.state && !dtg_graph_transition_allowed(rt->graph.state, target)) {
        snprintf(err, errsz, "illegal graph transition %s -> %s",
                 dtg_graph_state_name(rt->graph.state), dtg_graph_state_name(target));
        return 0;
    }
    int lockfd = -1;
    if (!dtg_lock_graph(rt, &lockfd, err, errsz)) return 0;
    unsigned long long seq = 0;
    long long event_ts = 0;
    int ok = dtg_append_event_locked(rt, type, NULL, target, DTG_NODE_STATE_INVALID,
                                     approved, 0, NULL, 0, 0, message, &seq, &event_ts, err, errsz);
    if (ok) {
        if (target != rt->graph.state) ok = dtg_transition_graph_raw(&rt->graph, target, event_ts, err, errsz);
        else rt->graph.updated_ms = event_ts;
        rt->graph.approved = approved;
        rt->graph.last_event_seq = seq;
        if (ok) ok = dtg_write_snapshot_locked(rt, err, errsz);
    }
    dtg_unlock_graph(lockfd);
    return ok;
}

static int dtg_store_node_event(dtg_runtime *rt, dtg_node *node,
                                const char *type, dtg_node_state target,
                                int attempts, const char *attempt_id,
                                unsigned long long operation_task_id,
                                long long synthetic_due_ms,
                                const char *message, char *err, size_t errsz) {
    if (!node) { snprintf(err, errsz, "task graph node is missing"); return 0; }
    if (target != node->state && !dtg_node_transition_allowed(node->state, target)) {
        snprintf(err, errsz, "illegal node transition %s -> %s for %s",
                 dtg_node_state_name(node->state), dtg_node_state_name(target), node->id);
        return 0;
    }
    int lockfd = -1;
    if (!dtg_lock_graph(rt, &lockfd, err, errsz)) return 0;
    unsigned long long seq = 0;
    long long event_ts = 0;
    int ok = dtg_append_event_locked(rt, type, node, rt->graph.state, target,
                                     rt->graph.approved, attempts, attempt_id,
                                     operation_task_id, synthetic_due_ms,
                                     message, &seq, &event_ts, err, errsz);
    if (ok) {
        if (target != node->state) ok = dtg_transition_node_raw(&rt->graph, node, target, event_ts, err, errsz);
        else rt->graph.updated_ms = event_ts;
        node->attempts_started = attempts;
        cstr_copy(node->active_attempt_id, sizeof node->active_attempt_id, attempt_id ? attempt_id : "");
        node->operation_task_id = operation_task_id;
        node->synthetic_due_ms = synthetic_due_ms;
        rt->graph.last_event_seq = seq;
        if (ok) ok = dtg_write_snapshot_locked(rt, err, errsz);
    }
    dtg_unlock_graph(lockfd);
    return ok;
}

static int dtg_event_apply_line(dtg_runtime *rt, const char *line, size_t len,
                                char *err, size_t errsz) {
    if (!len || len > DTG_EVENT_LINE_MAX) { snprintf(err, errsz, "invalid task graph event length"); return 0; }
    char *copy = malloc(len + 1);
    if (!copy) { snprintf(err, errsz, "out of memory replaying task graph event"); return 0; }
    memcpy(copy, line, len); copy[len] = '\0';
    if (!dtg_json_validate_complete(copy, '{', err, errsz)) { free(copy); return 0; }
    size_t cap = len / 2 + 64;
    dtg_json_token *tokens = calloc(cap, sizeof *tokens);
    int count = tokens ? dtg_json_tokenize(copy, len, tokens, cap) : -2;
    if (count < 1 || tokens[0].type != DTG_JSON_OBJECT) {
        free(tokens); free(copy); snprintf(err, errsz, "malformed task graph event"); return 0;
    }
    long long seq = 0, timestamp = 0, revision = 0, attempts = 0, op = 0, due = 0;
    char graph_id[DTG_ID_MAX + 1] = "", graph_state[40] = "", node_id[DTG_ID_MAX + 1] = "";
    char node_state[40] = "", attempt_id[DTG_ID_MAX + 1] = "", type[64] = "", message[512] = "";
    int approved = 0;
    int ok = dtg_json_unique_object_keys(copy, tokens, count, err, errsz) &&
        dtg_json_object_int(copy, tokens, count, 0, "seq", 0, 1, LLONG_MAX, &seq, err, errsz) &&
        dtg_json_object_int(copy, tokens, count, 0, "ts", 0, 1, LLONG_MAX, &timestamp, err, errsz) &&
        dtg_json_object_string(copy, tokens, count, 0, "type", type, sizeof type, 1, err, errsz) &&
        dtg_json_object_int(copy, tokens, count, 0, "revision", 0, 1, UINT_MAX, &revision, err, errsz) &&
        dtg_json_object_string(copy, tokens, count, 0, "graphId", graph_id, sizeof graph_id, 1, err, errsz) &&
        dtg_json_object_string(copy, tokens, count, 0, "graphState", graph_state, sizeof graph_state, 1, err, errsz) &&
        dtg_json_object_bool(copy, tokens, count, 0, "approved", 0, &approved, err, errsz) &&
        dtg_json_object_string(copy, tokens, count, 0, "nodeId", node_id, sizeof node_id, 0, err, errsz) &&
        dtg_json_object_string(copy, tokens, count, 0, "nodeState", node_state, sizeof node_state, 0, err, errsz) &&
        dtg_json_object_int(copy, tokens, count, 0, "attemptsStarted", 0, 0, INT_MAX, &attempts, err, errsz) &&
        dtg_json_object_string(copy, tokens, count, 0, "attemptId", attempt_id, sizeof attempt_id, 0, err, errsz) &&
        dtg_json_object_int(copy, tokens, count, 0, "operationTaskId", 0, 0, LLONG_MAX, &op, err, errsz) &&
        dtg_json_object_int(copy, tokens, count, 0, "syntheticDueMs", 0, 0, LLONG_MAX, &due, err, errsz) &&
        dtg_json_object_string(copy, tokens, count, 0, "message", message, sizeof message, 1, err, errsz);
    if (ok && ((unsigned long long)seq != rt->graph.last_event_seq + 1 ||
               strcmp(graph_id, rt->graph.id) || (unsigned)revision != rt->graph.revision)) {
        snprintf(err, errsz, "task graph event sequence or identity mismatch"); ok = 0;
    }
    dtg_graph_state gs = dtg_graph_state_parse(graph_state);
    if (ok && gs == DTG_GRAPH_STATE_INVALID) { snprintf(err, errsz, "event has invalid graph state"); ok = 0; }
    if (ok && gs != rt->graph.state && !dtg_graph_transition_allowed(rt->graph.state, gs)) {
        snprintf(err, errsz, "event has illegal graph transition %s -> %s",
                 dtg_graph_state_name(rt->graph.state), dtg_graph_state_name(gs)); ok = 0;
    }
    dtg_node *event_node = NULL;
    dtg_node_state ns = DTG_NODE_STATE_INVALID;
    if (ok && node_id[0]) {
        event_node = dtg_find_node(&rt->graph, node_id);
        ns = dtg_node_state_parse(node_state);
        if (!event_node || ns == DTG_NODE_STATE_INVALID) {
            snprintf(err, errsz, "event references an invalid node"); ok = 0;
        } else if (ns != event_node->state && !dtg_node_transition_allowed(event_node->state, ns)) {
            snprintf(err, errsz, "event has illegal node transition %s -> %s for %s",
                     dtg_node_state_name(event_node->state), dtg_node_state_name(ns), node_id); ok = 0;
        }
    }
    if (ok) {
        if (gs != rt->graph.state)
            ok = dtg_transition_graph_raw(&rt->graph, gs, timestamp, err, errsz);
        else
            rt->graph.updated_ms = timestamp;
    }
    if (ok) {
        if (!strcmp(type, "graph.created")) rt->graph.created_ms = timestamp;
        if (!strcmp(type, "graph.failed")) cstr_copy(rt->graph.error, sizeof rt->graph.error, message);
        rt->graph.approved = approved;
        rt->graph.last_event_seq = (unsigned long long)seq;
        if (event_node) {
            if (ns != event_node->state)
                ok = dtg_transition_node_raw(&rt->graph, event_node, ns, timestamp, err, errsz);
            event_node->attempts_started = (int)attempts;
            cstr_copy(event_node->active_attempt_id, sizeof event_node->active_attempt_id, attempt_id);
            event_node->operation_task_id = (unsigned long long)op;
            event_node->synthetic_due_ms = due;
        }
    }
    free(tokens); free(copy);
    return ok;
}

static int dtg_replay_events(dtg_runtime *rt, char *err, size_t errsz) {
    char path[DTG_STORE_PATH_MAX];
    if (!dtg_path_join(path, sizeof path, rt->directory, "events.jsonl")) return 0;
    size_t len = 0;
    char *events = dtg_read_file_bounded(path, 32u * 1024u * 1024u, &len, err, errsz);
    if (!events) return 0;
    rt->graph.state = DTG_GRAPH_DRAFT;
    rt->graph.approved = 0;
    rt->graph.last_event_seq = 0;
    rt->graph.created_ms = 0;
    rt->graph.updated_ms = 0;
    rt->graph.started_ms = 0;
    rt->graph.completed_ms = 0;
    rt->graph.error[0] = '\0';
    for (size_t i = 0; i < rt->graph.node_count; i++) {
        rt->graph.nodes[i].state = DTG_NODE_DRAFT;
        rt->graph.nodes[i].attempts_started = 0;
        rt->graph.nodes[i].active_attempt_id[0] = '\0';
        rt->graph.nodes[i].operation_task_id = 0;
        rt->graph.nodes[i].ready_ms = 0;
        rt->graph.nodes[i].started_ms = 0;
        rt->graph.nodes[i].finished_ms = 0;
        rt->graph.nodes[i].synthetic_due_ms = 0;
    }
    size_t start = 0;
    int ok = 1;
    while (start < len) {
        char *nl = memchr(events + start, '\n', len - start);
        if (!nl) break; /* Only the final partial line is ignored. */
        size_t line_len = (size_t)(nl - (events + start));
        if (line_len && !dtg_event_apply_line(rt, events + start, line_len, err, errsz)) { ok = 0; break; }
        start += line_len + 1;
    }
    free(events);
    if (!ok) rt->corrupt = 1;
    return ok;
}

static dtg_runtime *dtg_registry_find(const char *workspace_real, const char *graph_id) {
    for (int i = 0; i < DTG_MAX_REGISTRY; i++) {
        if (!g_dtg_registry[i].used) continue;
        if (!strcmp(g_dtg_registry[i].graph.id, graph_id) &&
            !strcmp(g_dtg_registry[i].workspace_real, workspace_real)) return &g_dtg_registry[i];
    }
    return NULL;
}

static dtg_runtime *dtg_registry_allocate(void) {
    for (int i = 0; i < DTG_MAX_REGISTRY; i++) if (!g_dtg_registry[i].used) return &g_dtg_registry[i];
    int victim = -1;
    long long oldest = LLONG_MAX;
    for (int i = 0; i < DTG_MAX_REGISTRY; i++) {
        if (!dtg_graph_terminal(g_dtg_registry[i].graph.state)) continue;
        if (g_dtg_registry[i].loaded_ms < oldest) { oldest = g_dtg_registry[i].loaded_ms; victim = i; }
    }
    if (victim < 0) return NULL;
    dtg_graph_free(&g_dtg_registry[victim].graph);
    memset(&g_dtg_registry[victim], 0, sizeof g_dtg_registry[victim]);
    return &g_dtg_registry[victim];
}

static void dtg_registry_forget(dtg_runtime *rt) {
    if (!rt) return;
    dtg_graph_free(&rt->graph);
    memset(rt, 0, sizeof *rt);
}

static dtg_runtime *dtg_store_load(const char *workspace, const char *graph_id,
                                   char *err, size_t errsz) {
    if (!dtg_id_valid(graph_id)) { snprintf(err, errsz, "invalid graphId"); return NULL; }
    char workspace_real[DSTUDIO_PATH_MAX], root[DTG_STORE_PATH_MAX];
    if (!dtg_store_root(workspace, workspace_real, sizeof workspace_real, root, sizeof root, err, errsz)) return NULL;
    dtg_runtime *cached = dtg_registry_find(workspace_real, graph_id);
    if (cached) return cached;
    dtg_runtime *rt = dtg_registry_allocate();
    if (!rt) { snprintf(err, errsz, "too many active task graphs"); return NULL; }
    memset(rt, 0, sizeof *rt);
    rt->used = 1;
    cstr_copy(rt->workspace_real, sizeof rt->workspace_real, workspace_real);
    if (snprintf(rt->directory, sizeof rt->directory, "%s/%s", root, graph_id) < 0 ||
        strlen(root) + strlen(graph_id) + 2 > sizeof rt->directory) {
        dtg_registry_forget(rt); snprintf(err, errsz, "graph directory is too long"); return NULL;
    }
    char graph_path[DTG_STORE_PATH_MAX];
    if (!dtg_path_join(graph_path, sizeof graph_path, rt->directory, "graph.json")) {
        dtg_registry_forget(rt); return NULL;
    }
    size_t graph_len = 0;
    char *definition = dtg_read_file_bounded(graph_path, BODY_MAX, &graph_len, err, errsz);
    (void)graph_len;
    if (!definition || !dtg_parse_graph_json(definition, &rt->graph, err, errsz)) {
        free(definition); dtg_registry_forget(rt); return NULL;
    }
    free(definition);
    if (strcmp(rt->graph.id, graph_id)) {
        dtg_registry_forget(rt); snprintf(err, errsz, "graph directory identity mismatch"); return NULL;
    }
    if (!dtg_replay_events(rt, err, errsz)) { dtg_registry_forget(rt); return NULL; }
    /* events.jsonl is authoritative. Refresh the materialized cache on every
     * cold load so recovery after append-before-rename leaves state.json in
     * sync before the scheduler accepts another mutation. */
    int lockfd = -1;
    if (!dtg_lock_graph(rt, &lockfd, err, errsz) ||
        !dtg_write_snapshot_locked(rt, err, errsz)) {
        dtg_unlock_graph(lockfd);
        dtg_registry_forget(rt);
        return NULL;
    }
    dtg_unlock_graph(lockfd);
    rt->loaded_ms = dstudio_now_ms();
    return rt;
}

static int dtg_make_graph_id(char *out, size_t outsz) {
    for (int tries = 0; tries < 1000; tries++) {
        unsigned long long counter = ++g_dtg_graph_counter;
        int n = snprintf(out, outsz, "tg_%lld_%ld_%llu", dstudio_now_ms(), (long)getpid(), counter);
        if (n > 0 && (size_t)n < outsz && dtg_id_valid(out)) return 1;
    }
    return 0;
}

static dtg_runtime *dtg_store_create(const char *definition, int strict,
                                     char *err, size_t errsz) {
    dtg_graph graph;
    if (!dtg_parse_graph_json(definition, &graph, err, errsz)) return NULL;
    if (!dtg_policy_validate(&graph, strict, err, errsz)) { dtg_graph_free(&graph); return NULL; }
    if (!graph.id[0] && !dtg_make_graph_id(graph.id, sizeof graph.id)) {
        dtg_graph_free(&graph); snprintf(err, errsz, "cannot allocate graphId"); return NULL;
    }
    char workspace_real[DSTUDIO_PATH_MAX], root[DTG_STORE_PATH_MAX];
    if (!dtg_store_root(graph.workspace, workspace_real, sizeof workspace_real, root, sizeof root, err, errsz)) {
        dtg_graph_free(&graph); return NULL;
    }
    mkpath(root);
    char directory[DTG_STORE_PATH_MAX];
    if (snprintf(directory, sizeof directory, "%s/%s", root, graph.id) < 0 ||
        strlen(root) + strlen(graph.id) + 2 > sizeof directory) {
        dtg_graph_free(&graph); snprintf(err, errsz, "graph directory is too long"); return NULL;
    }
    if (mkdir(directory, 0700) != 0) {
        dtg_graph_free(&graph); snprintf(err, errsz, errno == EEXIST ? "graphId already exists" : "cannot create graph directory: %s", strerror(errno)); return NULL;
    }
    dtg_runtime *rt = dtg_registry_allocate();
    if (!rt) { dtg_graph_free(&graph); snprintf(err, errsz, "too many active task graphs"); return NULL; }
    memset(rt, 0, sizeof *rt);
    rt->used = 1;
    rt->graph = graph;
    rt->loaded_ms = dstudio_now_ms();
    cstr_copy(rt->workspace_real, sizeof rt->workspace_real, workspace_real);
    cstr_copy(rt->directory, sizeof rt->directory, directory);
    cstr_copy(rt->graph.workspace, sizeof rt->graph.workspace, graph.workspace[0] ? workspace_real : "");

    json_dyn_buf graph_json = {0};
    int ok = dtg_graph_definition_json(&rt->graph, &graph_json) &&
             dtg_write_atomic(rt->directory, "graph.json", graph_json.ptr, graph_json.len, 1, err, errsz) &&
             dtg_write_atomic(rt->directory, "artifacts.json", "{\"artifacts\":[]}", 16, 1, err, errsz) &&
             dtg_write_atomic(rt->directory, "metadata.json", "{\"schemaVersion\":1}", 19, 1, err, errsz);
    free(graph_json.ptr);
    int lockfd = -1;
    unsigned long long seq = 0;
    long long event_ts = 0;
    if (ok) ok = dtg_lock_graph(rt, &lockfd, err, errsz);
    if (ok) ok = dtg_append_event_locked(rt, "graph.created", NULL, DTG_GRAPH_DRAFT,
                                         DTG_NODE_STATE_INVALID, 0, 0, NULL, 0, 0,
                                         "Graph created", &seq, &event_ts, err, errsz);
    if (ok) {
        rt->graph.created_ms = rt->graph.updated_ms = event_ts;
        rt->graph.last_event_seq = seq;
        ok = dtg_write_snapshot_locked(rt, err, errsz);
    }
    dtg_unlock_graph(lockfd);
    if (!ok) { dtg_registry_forget(rt); return NULL; }
    if (!dtg_store_graph_event(rt, "graph.validated", DTG_GRAPH_VALIDATED, 0,
                               "Graph validated", err, errsz)) {
        dtg_registry_forget(rt); return NULL;
    }
    if (!rt->graph.approval_required &&
        !dtg_store_graph_event(rt, "graph.ready", DTG_GRAPH_READY, 0,
                               "Graph ready", err, errsz)) {
        dtg_registry_forget(rt); return NULL;
    }
    return rt;
}

static void dtg_store_shutdown(void) {
    for (int i = 0; i < DTG_MAX_REGISTRY; i++) dtg_registry_forget(&g_dtg_registry[i]);
}

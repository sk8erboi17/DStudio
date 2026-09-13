/* OpenAI Chat Completions stream boundary for the native Agent relay.
 * Included after the existing complete JSON grammar; no inference/tokenizer
 * implementation lives here. A worker owns its candidate calls until DONE.
 * At most 16 calls / 2 MiB decoded payload, 1 MiB per argument object, a 2 MiB
 * SSE line and 4096 JSON tokens. Failure discards the whole executable batch;
 * already streamed display text is not treated as a completed tool action. */
#define MODEL_RPC_JSON_TOKENS 4096
typedef struct {
    const char *json;
    dtg_json_token *tokens;
    int count;
} model_rpc_json;

static void model_rpc_fail(model_rpc_job *job, const char *error) {
    if (!job->error[0]) cstr_copy(job->error, sizeof job->error, error);
    job->done = 1;
}

static int model_rpc_json_open(model_rpc_json *doc, const char *json) {
    memset(doc, 0, sizeof *doc);
    doc->json = json;
    char error[256];
    if (!json || strlen(json) > MODEL_RPC_SSE_LINE_MAX ||
        !dtg_json_validate_complete(json, '{', error, sizeof error)) return 0;
    doc->tokens = calloc(MODEL_RPC_JSON_TOKENS, sizeof *doc->tokens);
    if (!doc->tokens) return 0;
    doc->count = dtg_json_tokenize(json, strlen(json), doc->tokens, MODEL_RPC_JSON_TOKENS);
    if (doc->count < 1 || !dtg_json_unique_object_keys(json, doc->tokens, doc->count, error, sizeof error)) goto invalid;
    /* The shared grammar checks syntax, not Unicode scalar validity. Validate
     * every string before schema lookup, including unknown fields and keys. */
    for (int i = 0; i < doc->count; i++) {
        dtg_json_token *t = &doc->tokens[i];
        if (t->type != DTG_JSON_STRING) continue;
        char *value = dstudio_wire_string(json + t->start - 1, json + t->end + 1);
        if (!value) goto invalid;
        free(value);
    }
    return 1;
invalid:
    free(doc->tokens); doc->tokens = NULL;
    return 0;
}

static int model_rpc_field(const model_rpc_json *doc, int object, const char *name) {
    if (object < 0 || object >= doc->count || doc->tokens[object].type != DTG_JSON_OBJECT) return -1;
    int child = 0;
    for (int i = object + 1; i < doc->count && doc->tokens[i].start < doc->tokens[object].end; i++) {
        if (doc->tokens[i].parent != object || (child++ & 1)) continue;
        const dtg_json_token *t = &doc->tokens[i];
        char *key = dstudio_wire_string(doc->json + t->start - 1, doc->json + t->end + 1);
        int matches = key && !strcmp(key, name);
        free(key);
        if (matches) return i + 1;
    }
    return -1;
}

static int model_rpc_null(const model_rpc_json *doc, int at) {
    return at < 0 || dtg_json_primitive_eq(doc->json, &doc->tokens[at], "null");
}

static char *model_rpc_string(const model_rpc_json *doc, int at) {
    if (at < 0 || doc->tokens[at].type != DTG_JSON_STRING) return NULL;
    const dtg_json_token *t = &doc->tokens[at];
    return dstudio_wire_string(doc->json + t->start - 1, doc->json + t->end + 1);
}

static int model_rpc_append_field(model_rpc_job *job, const model_rpc_json *doc,
                                   int object, const char *key, char *fixed, size_t cap,
                                   json_dyn_buf *dynamic) {
    int at = model_rpc_field(doc, object, key);
    if (at < 0) return 1;
    char *text = model_rpc_string(doc, at);
    if (!text) return 0;
    size_t n = strlen(text), prior = dynamic ? dynamic->len : strlen(fixed);
    int ok = n < cap && prior < cap - n && n <= MODEL_RPC_TOOL_BYTES_MAX - job->tool_bytes;
    if (ok) {
        if (dynamic) ok = json_dyn_putn(dynamic, text, n);
        else memcpy(fixed + prior, text, n + 1);
    }
    if (ok) job->tool_bytes += n;
    free(text);
    return ok;
}

static int model_rpc_tools_delta(model_rpc_job *job, const model_rpc_json *doc, int array) {
    if (doc->tokens[array].type != DTG_JSON_ARRAY || doc->tokens[array].size > MODEL_RPC_CALLS_MAX) return 0;
    unsigned indexes = 0;
    for (int n = 0; n < doc->tokens[array].size; n++) {
        int call = dtg_json_array_nth(doc->tokens, doc->count, array, n);
        if (call < 0 || doc->tokens[call].type != DTG_JSON_OBJECT) return 0;
        int index = model_rpc_field(doc, call, "index");
        long long ordinal;
        if (index < 0 || !dtg_json_token_int(doc->json, &doc->tokens[index], 0, MODEL_RPC_CALLS_MAX - 1, &ordinal) ||
            (indexes & (1u << ordinal))) return 0;
        indexes |= 1u << ordinal;
        if (!job->calls) {
            job->calls = calloc(MODEL_RPC_CALLS_MAX, sizeof *job->calls);
            if (!job->calls) return 0;
        }
        model_rpc_call *target = &job->calls[ordinal];
        target->seen = 1;
        if (job->call_count <= ordinal) job->call_count = (int)ordinal + 1;
        int type = model_rpc_field(doc, call, "type");
        if (type >= 0) {
            char *value = model_rpc_string(doc, type);
            int valid = value && !strcmp(value, "function");
            free(value);
            if (!valid) return 0;
            target->function_type = 1;
        }
        if (!model_rpc_append_field(job, doc, call, "id", target->id, sizeof target->id, NULL)) return 0;
        int function = model_rpc_field(doc, call, "function");
        if (function >= 0 && (doc->tokens[function].type != DTG_JSON_OBJECT ||
            !model_rpc_append_field(job, doc, function, "name", target->name, sizeof target->name, NULL) ||
            !model_rpc_append_field(job, doc, function, "arguments", NULL, MODEL_RPC_ARGUMENT_MAX + 1, &target->arguments))) return 0;
    }
    return 1;
}

static void model_rpc_sse_line(model_rpc_job *job, const char *line) {
    if (job->error[0] || strncmp(line, "data:", 5)) return;
    const char *json = line + 5;
    while (*json == ' ' || *json == '\t') json++;
    if (!strncmp(json, "[DONE]", 6)) {
        const char *tail = json + 6;
        while (*tail == '\r' || *tail == '\n' || *tail == ' ' || *tail == '\t') tail++;
        if (*tail) model_rpc_fail(job, "invalid model completion sentinel");
        job->done = 1;
        return;
    }
    model_rpc_json doc;
    if (!model_rpc_json_open(&doc, json)) { model_rpc_fail(job, "invalid, ambiguous or oversized model JSON"); return; }
    int error = model_rpc_field(&doc, 0, "error");
    if (!model_rpc_null(&doc, error)) { model_rpc_fail(job, "model returned an error event"); goto done; }
    int choices = model_rpc_field(&doc, 0, "choices");
    if (choices < 0 || doc.tokens[choices].type != DTG_JSON_ARRAY || doc.tokens[choices].size > 1) goto invalid;
    if (!doc.tokens[choices].size) goto done; /* Separate usage chunk. */
    int choice = dtg_json_array_nth(doc.tokens, doc.count, choices, 0);
    int index = model_rpc_field(&doc, choice, "index");
    long long ordinal;
    if (index < 0 || !dtg_json_token_int(json, &doc.tokens[index], 0, 0, &ordinal)) goto invalid;
    int delta = model_rpc_field(&doc, choice, "delta");
    if (delta < 0 || doc.tokens[delta].type != DTG_JSON_OBJECT) goto invalid;
    if (job->finish_reason[0] && doc.tokens[delta].size) goto invalid;
    int tools = model_rpc_field(&doc, delta, "tool_calls");
    if (!model_rpc_null(&doc, tools) && !model_rpc_tools_delta(job, &doc, tools)) goto invalid;
    const char *fields[] = {"reasoning_content", "content"};
    const char *kinds[] = {"reasoning", "content"};
    char *parts[2] = {NULL, NULL};
    for (int i = 0; i < 2; i++) {
        int field = model_rpc_field(&doc, delta, fields[i]);
        if (model_rpc_null(&doc, field)) continue;
        parts[i] = model_rpc_string(&doc, field);
        if (!parts[i]) { free(parts[0]); free(parts[1]); goto invalid; }
    }
    int finish = model_rpc_field(&doc, choice, "finish_reason");
    if (!model_rpc_null(&doc, finish)) {
        char *value = model_rpc_string(&doc, finish);
        int ok = value && *value && strlen(value) < sizeof job->finish_reason &&
                 (!job->finish_reason[0] || !strcmp(job->finish_reason, value));
        if (ok) cstr_copy(job->finish_reason, sizeof job->finish_reason, value);
        free(value);
        if (!ok) { free(parts[0]); free(parts[1]); goto invalid; }
    }
    for (int i = 0; i < 2; i++) {
        if (parts[i] && parts[i][0] && !model_rpc_write_frame(job, "model_delta", kinds[i], parts[i]))
            model_rpc_fail(job, "model stream consumer is unavailable");
        free(parts[i]);
    }
    goto done;
invalid:
    model_rpc_fail(job, "invalid model choice, tool delta or completion state");
done:
    free(doc.tokens);
}

static int model_rpc_complete(model_rpc_job *job, char *err, size_t errsz) {
    if (job->error[0]) goto fail;
    if (strcmp(job->finish_reason, "stop") && strcmp(job->finish_reason, "tool_calls")) {
        snprintf(job->error, sizeof job->error, "model completion is incomplete (finish_reason=%s)",
                 job->finish_reason[0] ? job->finish_reason : "missing");
        goto fail;
    }
    if (!job->call_count) {
        if (!strcmp(job->finish_reason, "stop")) return 1;
        model_rpc_fail(job, "model declared tool completion without tool calls"); goto fail;
    }
    if (!job->done || strcmp(job->finish_reason, "tool_calls")) {
        model_rpc_fail(job, "tool batch did not finish successfully"); goto fail;
    }
    /* Validate every call before publishing ANY. JSON argument whitespace and
     * key order are retained, not re-rendered or converted to DSML. */
    for (int i = 0; i < job->call_count; i++) {
        model_rpc_call *call = &job->calls[i];
        if (!call->seen || !call->function_type || !call->id[0] || !call->name[0] || !call->arguments.ptr) goto invalid;
        for (int k = 0; k < i; k++) if (!strcmp(call->id, job->calls[k].id)) goto invalid;
        model_rpc_json args;
        if (!model_rpc_json_open(&args, call->arguments.ptr)) goto invalid;
        free(args.tokens);
    }
    json_dyn_buf calls = {0};
    int ok = json_dyn_puts(&calls, "[");
    for (int i = 0; ok && i < job->call_count; i++) {
        model_rpc_call *call = &job->calls[i];
        ok = (!i || json_dyn_puts(&calls, ",")) && json_dyn_puts(&calls, "{\"id\":") &&
             json_dyn_put_escaped(&calls, call->id) && json_dyn_puts(&calls, ",\"type\":\"function\",\"function\":{\"name\":") &&
             json_dyn_put_escaped(&calls, call->name) && json_dyn_puts(&calls, ",\"arguments\":") &&
             json_dyn_put_escaped(&calls, call->arguments.ptr) && json_dyn_puts(&calls, "}}");
    }
    ok = ok && json_dyn_puts(&calls, "]") && model_rpc_write_frame(job, "model_tool_calls", NULL, calls.ptr);
    free(calls.ptr);
    if (ok) return 1;
    model_rpc_fail(job, "could not deliver completed tool batch"); goto fail;
invalid:
    model_rpc_fail(job, "incomplete, duplicate or invalid model tool call");
fail:
    cstr_copy(err, errsz, job->error);
    return 0;
}

static void model_rpc_release(model_rpc_job *job) {
    for (int i = 0; i < job->call_count; i++) free(job->calls[i].arguments.ptr);
    free(job->calls);
    job->calls = NULL;
    job->call_count = 0;
    job->tool_bytes = 0;
}

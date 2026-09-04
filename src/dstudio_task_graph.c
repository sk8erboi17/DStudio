/*
 * DStudio Task Graph V1 — bounded, host-authoritative DAG model.
 *
 * This file deliberately contains no engine or HTTP code.  The model can be
 * parsed and validated without a running DS4 process, which makes it the
 * trust boundary between planner proposals and execution.  Runtime state is
 * separate from graph.json and is mutated only through the transition helpers
 * below.  See extension/task-graph/README.md.
 */

#define DTG_SCHEMA_VERSION          1u
#define DTG_ID_MAX                 64
#define DTG_TITLE_MAX             192
#define DTG_DESC_MAX             2048
#define DTG_GOAL_MAX             4096
#define DTG_MAX_NODES             256
#define DTG_MAX_EDGES            1024
#define DTG_MAX_DEPS_PER_NODE      64
#define DTG_MAX_OUTPUTS            32
#define DTG_MAX_CAPABILITIES       32
#define DTG_CAPABILITY_MAX         64
#define DTG_POLICY_MAX             96
#define DTG_MODE_MAX               32
#define DTG_EXECUTOR_MAX           32
#define DTG_MAX_REGISTRY           32
#define DTG_ACTION_NAME_MAX        64
#define DTG_ACTION_TEXT_MAX     16384
#define DTG_ACTION_ARG_MAX        512
#define DTG_MAX_ACTION_ARGS        32

typedef enum {
    DTG_NODE_AGENT_TURN = 0,
    DTG_NODE_HOST_TOOL,
    DTG_NODE_GATE,
    DTG_NODE_APPROVAL,
    DTG_NODE_JOIN,
    DTG_NODE_KIND_INVALID
} dtg_node_kind;

typedef enum {
    DTG_GRAPH_DRAFT = 0,
    DTG_GRAPH_VALIDATED,
    DTG_GRAPH_READY,
    DTG_GRAPH_RUNNING,
    DTG_GRAPH_PAUSING,
    DTG_GRAPH_PAUSED,
    DTG_GRAPH_WAITING_APPROVAL,
    DTG_GRAPH_NEEDS_INPUT,
    DTG_GRAPH_SUCCEEDED,
    DTG_GRAPH_FAILED,
    DTG_GRAPH_CANCELLING,
    DTG_GRAPH_CANCELLED,
    DTG_GRAPH_CORRUPT,
    DTG_GRAPH_STATE_INVALID
} dtg_graph_state;

typedef enum {
    DTG_NODE_DRAFT = 0,
    DTG_NODE_PENDING,
    DTG_NODE_READY,
    DTG_NODE_LEASED,
    DTG_NODE_RUNNING,
    DTG_NODE_WAITING_APPROVAL,
    DTG_NODE_PAUSED,
    DTG_NODE_CANCELLING,
    DTG_NODE_INTERRUPTED,
    DTG_NODE_SUCCEEDED,
    DTG_NODE_FAILED,
    DTG_NODE_CANCELLED,
    DTG_NODE_BLOCKED,
    DTG_NODE_SKIPPED,
    DTG_NODE_STATE_INVALID
} dtg_node_state;

typedef enum {
    DTG_MUTATION_READ_ONLY = 0,
    DTG_MUTATION_ARTIFACT_ONLY,
    DTG_MUTATION_WORKSPACE_WRITE,
    DTG_MUTATION_EXTERNAL_SIDE_EFFECT,
    DTG_MUTATION_INVALID
} dtg_mutation_class;

typedef enum {
    DTG_DEP_SUCCEEDED = 0,
    DTG_DEP_TERMINAL
} dtg_dependency_condition;

typedef struct {
    char node_id[DTG_ID_MAX + 1];
    dtg_dependency_condition condition;
} dtg_dependency;

typedef struct {
    char name[96];
    char type[32];
    char path[DSTUDIO_PATH_MAX];
    int required;
    unsigned long long minimum_bytes;
} dtg_output_contract;

typedef struct {
    char id[DTG_ID_MAX + 1];
    char title[DTG_TITLE_MAX + 1];
    char description[DTG_DESC_MAX + 1];
    dtg_node_kind kind;
    dtg_node_state state;
    dtg_mutation_class mutation;

    dtg_dependency *dependencies;
    size_t dependency_count;
    dtg_output_contract *outputs;
    size_t output_count;
    char (*capabilities)[DTG_CAPABILITY_MAX + 1];
    size_t capability_count;

    int max_attempts;
    int attempts_started;
    int automatic_retry;
    int idempotent;
    int optional;
    int priority;
    long long timeout_ms;

    /* Phase-3 deterministic executor configuration.  It is accepted only by
     * test.synthetic.v1 and never invokes a shell or external side effect. */
    int synthetic_delay_ms;
    int synthetic_should_fail;

    /* Native V1 actions are deliberately closed-world.  The parser does not
     * retain an arbitrary JSON blob: every executable byte is represented by
     * one of these bounded fields and is checked again immediately before
     * dispatch by dstudio_task_policy.c. */
    char action_name[DTG_ACTION_NAME_MAX + 1];
    char action_path[DSTUDIO_PATH_MAX];
    char *action_text;
    char *action_display;
    char *action_expect;
    int action_require_tool_result;
    char (*action_argv)[DTG_ACTION_ARG_MAX + 1];
    size_t action_argc;
    unsigned long long action_max_bytes;

    char active_attempt_id[DTG_ID_MAX + 1];
    unsigned long long operation_task_id;
    long long ready_ms;
    long long started_ms;
    long long finished_ms;
    long long synthetic_due_ms;

    /* In-memory executor state.  Process identifiers are intentionally not
     * replayed after a crash: recovery records an interrupted attempt instead
     * of pretending that an unowned process is still controllable. */
    pid_t native_pid;
    int native_done;
    int native_success;
    int native_cancel_requested;
    size_t transcript_from;
    size_t transcript_to;
    unsigned watchdog_tool_calls;
    unsigned watchdog_repeated_calls;
    int watchdog_tripped;
    char native_message[512];

    int undo_available;
    int undo_applied;
    int undo_fully_reversed;
    char undo_message[256];
} dtg_node;

typedef struct {
    char id[DTG_ID_MAX + 1];
    unsigned revision;
    unsigned schema_version;
    dtg_graph_state state;
    char policy[DTG_POLICY_MAX + 1];
    char mode[DTG_MODE_MAX + 1];
    char executor_mode[DTG_EXECUTOR_MAX + 1];
    char goal[DTG_GOAL_MAX + 1];
    char workspace[DSTUDIO_PATH_MAX];
    int approval_required;
    int approved;
    int max_parallel_host_nodes;
    int max_parallel_llm_nodes;
    int max_attempts_per_node;
    dtg_node *nodes;
    size_t node_count;
    size_t edge_count;
    unsigned long long last_event_seq;
    long long created_ms;
    long long updated_ms;
    long long started_ms;
    long long completed_ms;
    char error[512];
} dtg_graph;

/* ---------- Small complete JSON tokenizer (jsmn-style, no dependency). ---------- */

typedef enum {
    DTG_JSON_UNDEFINED = 0,
    DTG_JSON_OBJECT,
    DTG_JSON_ARRAY,
    DTG_JSON_STRING,
    DTG_JSON_PRIMITIVE
} dtg_json_type;

typedef struct {
    dtg_json_type type;
    int start;
    int end;
    int size;
    int parent;
} dtg_json_token;

typedef struct {
    unsigned pos;
    unsigned next;
    int super;
} dtg_json_parser;

/* The tokenizer below indexes an already-valid document.  Keep grammar
 * validation separate so missing commas/colons and invalid primitives cannot
 * be normalized into an apparently valid graph. */
static const char *dtg_json_syntax_value(const char *p, const char *end,
                                         int depth, char *err, size_t errsz);

static const char *dtg_json_syntax_ws(const char *p, const char *end) {
    while (p < end && isspace((unsigned char)*p)) p++;
    return p;
}

static const char *dtg_json_syntax_string(const char *p, const char *end,
                                          char *err, size_t errsz) {
    if (p >= end || *p++ != '"') return NULL;
    while (p < end) {
        unsigned char c = (unsigned char)*p++;
        if (c == '"') return p;
        if (c < 0x20) { snprintf(err, errsz, "control character in JSON string"); return NULL; }
        if (c != '\\') continue;
        if (p >= end) { snprintf(err, errsz, "unterminated JSON escape"); return NULL; }
        c = (unsigned char)*p++;
        if (c == 'u') {
            for (int i = 0; i < 4; i++) {
                if (p >= end || !isxdigit((unsigned char)*p++)) {
                    snprintf(err, errsz, "bad JSON unicode escape"); return NULL;
                }
            }
        } else if (!strchr("\"/\\bfnrt", c)) {
            snprintf(err, errsz, "bad JSON escape"); return NULL;
        }
    }
    snprintf(err, errsz, "unterminated JSON string");
    return NULL;
}

static const char *dtg_json_syntax_number(const char *p, const char *end,
                                          char *err, size_t errsz) {
    if (p < end && *p == '-') p++;
    if (p >= end) goto bad;
    if (*p == '0') p++;
    else if (*p >= '1' && *p <= '9') while (p < end && isdigit((unsigned char)*p)) p++;
    else goto bad;
    if (p < end && *p == '.') {
        p++;
        if (p >= end || !isdigit((unsigned char)*p)) goto bad;
        while (p < end && isdigit((unsigned char)*p)) p++;
    }
    if (p < end && (*p == 'e' || *p == 'E')) {
        p++;
        if (p < end && (*p == '+' || *p == '-')) p++;
        if (p >= end || !isdigit((unsigned char)*p)) goto bad;
        while (p < end && isdigit((unsigned char)*p)) p++;
    }
    return p;
bad:
    snprintf(err, errsz, "bad JSON number");
    return NULL;
}

static const char *dtg_json_syntax_array(const char *p, const char *end,
                                         int depth, char *err, size_t errsz) {
    p = dtg_json_syntax_ws(p + 1, end);
    if (p < end && *p == ']') return p + 1;
    for (;;) {
        p = dtg_json_syntax_value(p, end, depth + 1, err, errsz);
        if (!p) return NULL;
        p = dtg_json_syntax_ws(p, end);
        if (p < end && *p == ',') { p = dtg_json_syntax_ws(p + 1, end); continue; }
        if (p < end && *p == ']') return p + 1;
        snprintf(err, errsz, "expected ',' or ']' in JSON array");
        return NULL;
    }
}

static const char *dtg_json_syntax_object(const char *p, const char *end,
                                          int depth, char *err, size_t errsz) {
    p = dtg_json_syntax_ws(p + 1, end);
    if (p < end && *p == '}') return p + 1;
    for (;;) {
        if (p >= end || *p != '"') { snprintf(err, errsz, "expected JSON object key"); return NULL; }
        p = dtg_json_syntax_string(p, end, err, errsz);
        if (!p) return NULL;
        p = dtg_json_syntax_ws(p, end);
        if (p >= end || *p != ':') { snprintf(err, errsz, "expected ':' after JSON object key"); return NULL; }
        p = dtg_json_syntax_value(p + 1, end, depth + 1, err, errsz);
        if (!p) return NULL;
        p = dtg_json_syntax_ws(p, end);
        if (p < end && *p == ',') { p = dtg_json_syntax_ws(p + 1, end); continue; }
        if (p < end && *p == '}') return p + 1;
        snprintf(err, errsz, "expected ',' or '}' in JSON object");
        return NULL;
    }
}

static const char *dtg_json_syntax_value(const char *p, const char *end,
                                         int depth, char *err, size_t errsz) {
    if (depth > 64) { snprintf(err, errsz, "JSON nesting too deep"); return NULL; }
    p = dtg_json_syntax_ws(p, end);
    if (p >= end) { snprintf(err, errsz, "expected JSON value"); return NULL; }
    if (*p == '"') return dtg_json_syntax_string(p, end, err, errsz);
    if (*p == '{') return dtg_json_syntax_object(p, end, depth, err, errsz);
    if (*p == '[') return dtg_json_syntax_array(p, end, depth, err, errsz);
    if (*p == '-' || isdigit((unsigned char)*p)) return dtg_json_syntax_number(p, end, err, errsz);
    if (end - p >= 4 && !memcmp(p, "true", 4)) return p + 4;
    if (end - p >= 5 && !memcmp(p, "false", 5)) return p + 5;
    if (end - p >= 4 && !memcmp(p, "null", 4)) return p + 4;
    snprintf(err, errsz, "bad JSON value");
    return NULL;
}

static int dtg_json_validate_complete(const char *json, char required_first,
                                      char *err, size_t errsz) {
    if (!json) { snprintf(err, errsz, "missing JSON"); return 0; }
    const char *end = json + strlen(json);
    const char *p = dtg_json_syntax_ws(json, end);
    if (required_first && (p >= end || *p != required_first)) {
        snprintf(err, errsz, "JSON must start with '%c'", required_first); return 0;
    }
    p = dtg_json_syntax_value(p, end, 0, err, errsz);
    if (!p) return 0;
    p = dtg_json_syntax_ws(p, end);
    if (p != end) { snprintf(err, errsz, "trailing data after JSON value"); return 0; }
    return 1;
}

static dtg_json_token *dtg_json_alloc_token(dtg_json_parser *p,
                                             dtg_json_token *tokens,
                                             size_t count) {
    if (p->next >= count) return NULL;
    dtg_json_token *t = &tokens[p->next++];
    t->type = DTG_JSON_UNDEFINED;
    t->start = t->end = -1;
    t->size = 0;
    t->parent = -1;
    return t;
}

static int dtg_json_parse_string_token(dtg_json_parser *p, const char *json,
                                        size_t len, dtg_json_token *tokens,
                                        size_t count) {
    unsigned start = p->pos + 1;
    for (p->pos++; p->pos < len; p->pos++) {
        unsigned char c = (unsigned char)json[p->pos];
        if (c == '"') {
            dtg_json_token *t = dtg_json_alloc_token(p, tokens, count);
            if (!t) return -2;
            t->type = DTG_JSON_STRING;
            t->start = (int)start;
            t->end = (int)p->pos;
            t->parent = p->super;
            if (p->super >= 0) tokens[p->super].size++;
            return 0;
        }
        if (c < 0x20) return -1;
        if (c == '\\') {
            if (++p->pos >= len) return -1;
            c = (unsigned char)json[p->pos];
            if (c == 'u') {
                for (int n = 0; n < 4; n++) {
                    if (++p->pos >= len || !isxdigit((unsigned char)json[p->pos])) return -1;
                }
            } else if (!strchr("\"/\\bfnrt", c)) {
                return -1;
            }
        }
    }
    return -1;
}

static int dtg_json_parse_primitive_token(dtg_json_parser *p, const char *json,
                                           size_t len, dtg_json_token *tokens,
                                           size_t count) {
    unsigned start = p->pos;
    for (; p->pos < len; p->pos++) {
        unsigned char c = (unsigned char)json[p->pos];
        if (isspace(c) || c == ',' || c == ']' || c == '}') break;
        if (c < 0x20 || c >= 0x7f || c == ':' || c == '[' || c == '{' || c == '"') return -1;
    }
    if (p->pos == start) return -1;
    dtg_json_token *t = dtg_json_alloc_token(p, tokens, count);
    if (!t) return -2;
    t->type = DTG_JSON_PRIMITIVE;
    t->start = (int)start;
    t->end = (int)p->pos;
    t->parent = p->super;
    if (p->super >= 0) tokens[p->super].size++;
    p->pos--;
    return 0;
}

static int dtg_json_tokenize(const char *json, size_t len,
                             dtg_json_token *tokens, size_t count) {
    dtg_json_parser p = {0, 0, -1};
    for (; p.pos < len; p.pos++) {
        unsigned char c = (unsigned char)json[p.pos];
        if (isspace(c) || c == ':' || c == ',') continue;
        if (c == '{' || c == '[') {
            dtg_json_token *t = dtg_json_alloc_token(&p, tokens, count);
            if (!t) return -2;
            t->type = c == '{' ? DTG_JSON_OBJECT : DTG_JSON_ARRAY;
            t->start = (int)p.pos;
            t->parent = p.super;
            if (p.super >= 0) tokens[p.super].size++;
            p.super = (int)p.next - 1;
            continue;
        }
        if (c == '}' || c == ']') {
            dtg_json_type want = c == '}' ? DTG_JSON_OBJECT : DTG_JSON_ARRAY;
            int found = -1;
            for (int i = (int)p.next - 1; i >= 0; i--) {
                if (tokens[i].start >= 0 && tokens[i].end < 0) { found = i; break; }
            }
            if (found < 0 || tokens[found].type != want) return -1;
            tokens[found].end = (int)p.pos + 1;
            p.super = tokens[found].parent;
            continue;
        }
        if (c == '"') {
            int rc = dtg_json_parse_string_token(&p, json, len, tokens, count);
            if (rc) return rc;
            continue;
        }
        int rc = dtg_json_parse_primitive_token(&p, json, len, tokens, count);
        if (rc) return rc;
    }
    for (unsigned i = 0; i < p.next; i++) if (tokens[i].end < 0) return -1;
    if (!p.next) return -1;
    return (int)p.next;
}

static int dtg_hex_value(int c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

static int dtg_json_token_string(const char *json, const dtg_json_token *t,
                                 char *out, size_t outsz) {
    if (!t || t->type != DTG_JSON_STRING || !out || !outsz) return 0;
    size_t o = 0;
    for (int i = t->start; i < t->end; i++) {
        unsigned char c = (unsigned char)json[i];
        if (c == '\\') {
            if (++i >= t->end) return 0;
            c = (unsigned char)json[i];
            if (c == 'u') {
                if (i + 4 >= t->end) return 0;
                unsigned cp = 0;
                for (int n = 0; n < 4; n++) {
                    int h = dtg_hex_value((unsigned char)json[++i]);
                    if (h < 0) return 0;
                    cp = (cp << 4) | (unsigned)h;
                }
                if (cp < 0x80) c = (unsigned char)cp;
                else if (cp < 0x800) {
                    if (o + 2 >= outsz) return 0;
                    out[o++] = (char)(0xc0 | (cp >> 6));
                    c = (unsigned char)(0x80 | (cp & 0x3f));
                } else {
                    if (o + 3 >= outsz) return 0;
                    out[o++] = (char)(0xe0 | (cp >> 12));
                    out[o++] = (char)(0x80 | ((cp >> 6) & 0x3f));
                    c = (unsigned char)(0x80 | (cp & 0x3f));
                }
            } else {
                c = c == 'n' ? '\n' : c == 'r' ? '\r' : c == 't' ? '\t' :
                    c == 'b' ? '\b' : c == 'f' ? '\f' : c;
            }
        }
        if (o + 1 >= outsz) return 0;
        out[o++] = (char)c;
    }
    out[o] = '\0';
    return 1;
}

static int dtg_json_token_eq(const char *json, const dtg_json_token *t,
                             const char *value) {
    size_t n = strlen(value);
    return t && t->type == DTG_JSON_STRING && t->end - t->start == (int)n &&
           !memcmp(json + t->start, value, n);
}

static int dtg_json_object_field(const char *json, const dtg_json_token *tokens,
                                 int count, int object, const char *key) {
    if (object < 0 || object >= count || tokens[object].type != DTG_JSON_OBJECT) return -1;
    int direct_child = 0;
    for (int i = object + 1; i + 1 < count && tokens[i].start < tokens[object].end; i++) {
        if (tokens[i].parent != object) continue;
        int is_key = (direct_child++ & 1) == 0;
        if (!is_key || !dtg_json_token_eq(json, &tokens[i], key)) continue;
        if (tokens[i + 1].parent != object) return -1; /* tokenizer invariant */
        return i + 1;
    }
    return -1;
}

static int dtg_json_array_nth(const dtg_json_token *tokens, int count,
                              int array, int nth) {
    if (array < 0 || array >= count || tokens[array].type != DTG_JSON_ARRAY) return -1;
    int seen = 0;
    for (int i = array + 1; i < count && tokens[i].start < tokens[array].end; i++) {
        if (tokens[i].parent == array && seen++ == nth) return i;
    }
    return -1;
}

/* Reject duplicate object keys before schema lookup.  Accepting the first
 * occurrence while another parser accepts the last is a classic structured
 * control-data ambiguity, so Task Graph and GSA use one unambiguous document. */
static int dtg_json_unique_object_keys(const char *json, const dtg_json_token *tokens,
                                       int count, char *err, size_t errsz) {
    for (int object = 0; object < count; object++) {
        if (tokens[object].type != DTG_JSON_OBJECT) continue;
        int child_count = 0;
        for (int i = object + 1; i < count && tokens[i].start < tokens[object].end; i++)
            if (tokens[i].parent == object) child_count++;
        if (child_count % 2) { snprintf(err, errsz, "JSON object has an incomplete key/value pair"); return 0; }
        char **keys = child_count ? calloc((size_t)child_count / 2, sizeof *keys) : NULL;
        if (child_count && !keys) { snprintf(err, errsz, "out of memory checking JSON keys"); return 0; }
        int child = 0, key_count = 0, ok = 1;
        for (int i = object + 1; i < count && tokens[i].start < tokens[object].end; i++) {
            if (tokens[i].parent != object) continue;
            if ((child++ & 1) != 0) continue; /* value */
            if (tokens[i].type != DTG_JSON_STRING || tokens[i].end - tokens[i].start > 255) {
                snprintf(err, errsz, "JSON object key is invalid or too long"); ok = 0; break;
            }
            keys[key_count] = calloc(256, 1);
            if (!keys[key_count] || !dtg_json_token_string(json, &tokens[i], keys[key_count], 256)) {
                snprintf(err, errsz, "JSON object key cannot be decoded"); ok = 0; break;
            }
            for (int k = 0; k < key_count; k++) {
                if (!strcmp(keys[k], keys[key_count])) {
                    snprintf(err, errsz, "duplicate JSON object key '%s'", keys[key_count]); ok = 0; break;
                }
            }
            if (!ok) break;
            key_count++;
        }
        for (int k = 0; k < key_count + (!ok && key_count < child_count / 2 ? 1 : 0); k++) free(keys[k]);
        free(keys);
        if (!ok) return 0;
    }
    return 1;
}

static int dtg_json_primitive_eq(const char *json, const dtg_json_token *t,
                                 const char *value) {
    size_t n = strlen(value);
    return t && t->type == DTG_JSON_PRIMITIVE && t->end - t->start == (int)n &&
           !memcmp(json + t->start, value, n);
}

static int dtg_json_token_int(const char *json, const dtg_json_token *t,
                              long long lo, long long hi, long long *out) {
    if (!t || t->type != DTG_JSON_PRIMITIVE || t->end <= t->start || t->end - t->start >= 48) return 0;
    char tmp[48];
    memcpy(tmp, json + t->start, (size_t)(t->end - t->start));
    tmp[t->end - t->start] = '\0';
    char *end = NULL;
    errno = 0;
    long long v = strtoll(tmp, &end, 10);
    if (errno || !end || *end || v < lo || v > hi) return 0;
    *out = v;
    return 1;
}

static int dtg_json_object_string(const char *json, const dtg_json_token *tokens,
                                  int count, int object, const char *key,
                                  char *out, size_t outsz, int required,
                                  char *err, size_t errsz) {
    int at = dtg_json_object_field(json, tokens, count, object, key);
    if (at < 0) {
        if (required) snprintf(err, errsz, "missing string field '%s'", key);
        return !required;
    }
    if (!dtg_json_token_string(json, &tokens[at], out, outsz)) {
        snprintf(err, errsz, "field '%s' is not a valid bounded string", key);
        return 0;
    }
    return 1;
}

static int dtg_json_object_bool(const char *json, const dtg_json_token *tokens,
                                int count, int object, const char *key, int def,
                                int *out, char *err, size_t errsz) {
    int at = dtg_json_object_field(json, tokens, count, object, key);
    if (at < 0) { *out = def; return 1; }
    if (dtg_json_primitive_eq(json, &tokens[at], "true")) { *out = 1; return 1; }
    if (dtg_json_primitive_eq(json, &tokens[at], "false")) { *out = 0; return 1; }
    snprintf(err, errsz, "field '%s' must be boolean", key);
    return 0;
}

static int dtg_json_object_int(const char *json, const dtg_json_token *tokens,
                               int count, int object, const char *key,
                               long long def, long long lo, long long hi,
                               long long *out, char *err, size_t errsz) {
    int at = dtg_json_object_field(json, tokens, count, object, key);
    if (at < 0) { *out = def; return 1; }
    if (!dtg_json_token_int(json, &tokens[at], lo, hi, out)) {
        snprintf(err, errsz, "field '%s' must be an integer in [%lld,%lld]", key, lo, hi);
        return 0;
    }
    return 1;
}

/* ---------- Model parsing / names ---------- */

static const char *dtg_node_kind_name(dtg_node_kind v) {
    return v == DTG_NODE_AGENT_TURN ? "agent_turn" :
           v == DTG_NODE_HOST_TOOL ? "host_tool" :
           v == DTG_NODE_GATE ? "gate" :
           v == DTG_NODE_APPROVAL ? "approval" :
           v == DTG_NODE_JOIN ? "join" : "invalid";
}

static dtg_node_kind dtg_node_kind_parse(const char *s) {
    return !strcmp(s, "agent_turn") ? DTG_NODE_AGENT_TURN :
           !strcmp(s, "host_tool") ? DTG_NODE_HOST_TOOL :
           !strcmp(s, "gate") ? DTG_NODE_GATE :
           !strcmp(s, "approval") ? DTG_NODE_APPROVAL :
           !strcmp(s, "join") ? DTG_NODE_JOIN : DTG_NODE_KIND_INVALID;
}

static const char *dtg_mutation_name(dtg_mutation_class v) {
    return v == DTG_MUTATION_READ_ONLY ? "read_only" :
           v == DTG_MUTATION_ARTIFACT_ONLY ? "artifact_only" :
           v == DTG_MUTATION_WORKSPACE_WRITE ? "workspace_write" :
           v == DTG_MUTATION_EXTERNAL_SIDE_EFFECT ? "external_side_effect" : "invalid";
}

static dtg_mutation_class dtg_mutation_parse(const char *s) {
    return !s[0] || !strcmp(s, "read_only") ? DTG_MUTATION_READ_ONLY :
           !strcmp(s, "artifact_only") ? DTG_MUTATION_ARTIFACT_ONLY :
           !strcmp(s, "workspace_write") ? DTG_MUTATION_WORKSPACE_WRITE :
           !strcmp(s, "external_side_effect") ? DTG_MUTATION_EXTERNAL_SIDE_EFFECT : DTG_MUTATION_INVALID;
}

static const char *dtg_node_state_name(dtg_node_state v) {
    static const char *names[] = { "draft", "pending", "ready", "leased", "running",
        "waiting_approval", "paused", "cancelling", "interrupted", "succeeded",
        "failed", "cancelled", "blocked", "skipped" };
    return v >= DTG_NODE_DRAFT && v < DTG_NODE_STATE_INVALID ? names[v] : "invalid";
}

static dtg_node_state dtg_node_state_parse(const char *s) {
    for (int i = DTG_NODE_DRAFT; i < DTG_NODE_STATE_INVALID; i++)
        if (!strcmp(s, dtg_node_state_name((dtg_node_state)i))) return (dtg_node_state)i;
    return DTG_NODE_STATE_INVALID;
}

static const char *dtg_graph_state_name(dtg_graph_state v) {
    static const char *names[] = { "draft", "validated", "ready", "running", "pausing",
        "paused", "waiting_approval", "needs_input", "succeeded", "failed",
        "cancelling", "cancelled", "corrupt" };
    return v >= DTG_GRAPH_DRAFT && v < DTG_GRAPH_STATE_INVALID ? names[v] : "invalid";
}

static dtg_graph_state dtg_graph_state_parse(const char *s) {
    for (int i = DTG_GRAPH_DRAFT; i < DTG_GRAPH_STATE_INVALID; i++)
        if (!strcmp(s, dtg_graph_state_name((dtg_graph_state)i))) return (dtg_graph_state)i;
    return DTG_GRAPH_STATE_INVALID;
}

static int dtg_id_valid(const char *s) {
    size_t n = s ? strlen(s) : 0;
    if (!n || n > DTG_ID_MAX || strstr(s, "..")) return 0;
    for (size_t i = 0; i < n; i++)
        if (!isalnum((unsigned char)s[i]) && s[i] != '.' && s[i] != '_' && s[i] != '-') return 0;
    return 1;
}

static int dtg_relative_path_valid(const char *s) {
    if (!s || !s[0]) return 1;
    if (s[0] == '/' || s[0] == '\\' || (isalpha((unsigned char)s[0]) && s[1] == ':')) return 0;
    const char *p = s;
    while (*p) {
        while (*p == '/' || *p == '\\') p++;
        const char *start = p;
        while (*p && *p != '/' && *p != '\\') p++;
        size_t n = (size_t)(p - start);
        if ((n == 1 && start[0] == '.') || (n == 2 && start[0] == '.' && start[1] == '.')) return 0;
    }
    return 1;
}

static void dtg_graph_free(dtg_graph *g) {
    if (!g) return;
    for (size_t i = 0; i < g->node_count; i++) {
        free(g->nodes[i].dependencies);
        free(g->nodes[i].outputs);
        free(g->nodes[i].capabilities);
        free(g->nodes[i].action_text);
        free(g->nodes[i].action_display);
        free(g->nodes[i].action_expect);
        free(g->nodes[i].action_argv);
    }
    free(g->nodes);
    memset(g, 0, sizeof *g);
}

static int dtg_json_object_alloc_string(const char *json,
                                        const dtg_json_token *tokens,
                                        int count, int object,
                                        const char *key, char **out,
                                        size_t limit, char *err, size_t errsz) {
    int at = dtg_json_object_field(json, tokens, count, object, key);
    *out = NULL;
    if (at < 0) return 1;
    if (tokens[at].type != DTG_JSON_STRING ||
        tokens[at].end < tokens[at].start ||
        (size_t)(tokens[at].end - tokens[at].start) > limit) {
        snprintf(err, errsz, "field '%s' is not a bounded string", key);
        return 0;
    }
    size_t cap = (size_t)(tokens[at].end - tokens[at].start) + 1;
    char *value = calloc(cap, 1);
    if (!value || !dtg_json_token_string(json, &tokens[at], value, cap)) {
        free(value); snprintf(err, errsz, "cannot decode field '%s'", key); return 0;
    }
    *out = value;
    return 1;
}

static int dtg_parse_action(const char *json, const dtg_json_token *tokens,
                            int count, int object, dtg_node *node,
                            char *err, size_t errsz) {
    int action = dtg_json_object_field(json, tokens, count, object, "action");
    node->action_max_bytes = 1024u * 1024u;
    if (action < 0) return 1;
    if (tokens[action].type != DTG_JSON_OBJECT) {
        snprintf(err, errsz, "node '%s' action must be an object", node->id); return 0;
    }
    if (!dtg_json_object_string(json, tokens, count, action, "name",
                                node->action_name, sizeof node->action_name, 1, err, errsz) ||
        !dtg_json_object_string(json, tokens, count, action, "path",
                                node->action_path, sizeof node->action_path, 0, err, errsz) ||
        !dtg_json_object_alloc_string(json, tokens, count, action, "text",
                                      &node->action_text, DTG_ACTION_TEXT_MAX, err, errsz) ||
        !dtg_json_object_alloc_string(json, tokens, count, action, "display",
                                      &node->action_display, DTG_ACTION_TEXT_MAX, err, errsz) ||
        !dtg_json_object_alloc_string(json, tokens, count, action, "contains",
                                      &node->action_expect, DTG_ACTION_TEXT_MAX, err, errsz)) return 0;
    if (!dtg_json_object_bool(json, tokens, count, action, "requireToolResult", 0,
                              &node->action_require_tool_result, err, errsz)) return 0;
    long long max_bytes = 1024 * 1024;
    if (!dtg_json_object_int(json, tokens, count, action, "maxBytes",
                             max_bytes, 1, 16 * 1024 * 1024,
                             &max_bytes, err, errsz)) return 0;
    node->action_max_bytes = (unsigned long long)max_bytes;

    int argv = dtg_json_object_field(json, tokens, count, action, "argv");
    if (argv < 0) return 1;
    if (tokens[argv].type != DTG_JSON_ARRAY || tokens[argv].size < 1 ||
        tokens[argv].size > DTG_MAX_ACTION_ARGS) {
        snprintf(err, errsz, "node '%s' action argv must contain 1..%d strings",
                 node->id, DTG_MAX_ACTION_ARGS); return 0;
    }
    node->action_argc = (size_t)tokens[argv].size;
    node->action_argv = calloc(node->action_argc, sizeof *node->action_argv);
    if (!node->action_argv) { snprintf(err, errsz, "out of memory parsing action argv"); return 0; }
    for (size_t i = 0; i < node->action_argc; i++) {
        int at = dtg_json_array_nth(tokens, count, argv, (int)i);
        if (at < 0 || !dtg_json_token_string(json, &tokens[at],
                                             node->action_argv[i],
                                             sizeof node->action_argv[i])) {
            snprintf(err, errsz, "node '%s' action argv[%zu] is not a bounded string",
                     node->id, i); return 0;
        }
    }
    return 1;
}

static int dtg_add_dependency(dtg_node *node, const char *id,
                              dtg_dependency_condition condition,
                              char *err, size_t errsz) {
    if (node->dependency_count >= DTG_MAX_DEPS_PER_NODE) {
        snprintf(err, errsz, "node '%s' exceeds %d dependencies", node->id, DTG_MAX_DEPS_PER_NODE);
        return 0;
    }
    for (size_t i = 0; i < node->dependency_count; i++) {
        if (strcmp(node->dependencies[i].node_id, id)) continue;
        if (node->dependencies[i].condition != condition)
            snprintf(err, errsz, "node '%s' has conflicting duplicate dependency '%s'", node->id, id);
        else
            snprintf(err, errsz, "node '%s' has duplicate dependency '%s'", node->id, id);
        return 0;
    }
    dtg_dependency *next = realloc(node->dependencies,
        (node->dependency_count + 1) * sizeof *node->dependencies);
    if (!next) { snprintf(err, errsz, "out of memory adding dependency"); return 0; }
    node->dependencies = next;
    dtg_dependency *d = &node->dependencies[node->dependency_count++];
    memset(d, 0, sizeof *d);
    cstr_copy(d->node_id, sizeof d->node_id, id);
    d->condition = condition;
    return 1;
}

static int dtg_parse_string_array(const char *json, const dtg_json_token *tokens,
                                  int count, int array,
                                  char (**out)[DTG_CAPABILITY_MAX + 1], size_t *out_count,
                                  char *err, size_t errsz) {
    if (array < 0) { *out = NULL; *out_count = 0; return 1; }
    if (tokens[array].type != DTG_JSON_ARRAY) { snprintf(err, errsz, "capabilities must be an array"); return 0; }
    size_t n = (size_t)tokens[array].size;
    if (n > DTG_MAX_CAPABILITIES) { snprintf(err, errsz, "too many capabilities"); return 0; }
    char (*items)[DTG_CAPABILITY_MAX + 1] = n ? calloc(n, sizeof *items) : NULL;
    if (n && !items) { snprintf(err, errsz, "out of memory parsing capabilities"); return 0; }
    for (size_t i = 0; i < n; i++) {
        int at = dtg_json_array_nth(tokens, count, array, (int)i);
        if (at < 0 || !dtg_json_token_string(json, &tokens[at], items[i], sizeof items[i])) {
            free(items); snprintf(err, errsz, "capability %zu is not a bounded string", i); return 0;
        }
    }
    *out = items; *out_count = n;
    return 1;
}

static int dtg_parse_outputs(const char *json, const dtg_json_token *tokens,
                             int count, int array, dtg_node *node,
                             char *err, size_t errsz) {
    if (array < 0) return 1;
    if (tokens[array].type != DTG_JSON_ARRAY || tokens[array].size > DTG_MAX_OUTPUTS) {
        snprintf(err, errsz, "node '%s' outputs must be an array of at most %d items", node->id, DTG_MAX_OUTPUTS);
        return 0;
    }
    size_t n = (size_t)tokens[array].size;
    node->outputs = n ? calloc(n, sizeof *node->outputs) : NULL;
    if (n && !node->outputs) { snprintf(err, errsz, "out of memory parsing outputs"); return 0; }
    node->output_count = n;
    for (size_t i = 0; i < n; i++) {
        int at = dtg_json_array_nth(tokens, count, array, (int)i);
        if (at < 0 || tokens[at].type != DTG_JSON_OBJECT) {
            snprintf(err, errsz, "node '%s' output %zu must be an object", node->id, i); return 0;
        }
        dtg_output_contract *o = &node->outputs[i];
        if (!dtg_json_object_string(json, tokens, count, at, "name", o->name, sizeof o->name, 1, err, errsz) ||
            !dtg_json_object_string(json, tokens, count, at, "type", o->type, sizeof o->type, 0, err, errsz) ||
            !dtg_json_object_string(json, tokens, count, at, "path", o->path, sizeof o->path, 0, err, errsz) ||
            !dtg_json_object_bool(json, tokens, count, at, "required", 0, &o->required, err, errsz)) return 0;
        long long minimum = 0;
        if (!dtg_json_object_int(json, tokens, count, at, "minimumBytes", 0, 0, LLONG_MAX, &minimum, err, errsz)) return 0;
        o->minimum_bytes = (unsigned long long)minimum;
    }
    return 1;
}

static int dtg_parse_dependencies(const char *json, const dtg_json_token *tokens,
                                  int count, int array, dtg_node *node,
                                  char *err, size_t errsz) {
    if (array < 0) return 1;
    if (tokens[array].type != DTG_JSON_ARRAY || tokens[array].size > DTG_MAX_DEPS_PER_NODE) {
        snprintf(err, errsz, "node '%s' dependsOn must be an array of at most %d items", node->id, DTG_MAX_DEPS_PER_NODE);
        return 0;
    }
    for (int i = 0; i < tokens[array].size; i++) {
        int at = dtg_json_array_nth(tokens, count, array, i);
        char id[DTG_ID_MAX + 1] = "";
        dtg_dependency_condition condition = DTG_DEP_SUCCEEDED;
        if (at >= 0 && tokens[at].type == DTG_JSON_STRING) {
            if (!dtg_json_token_string(json, &tokens[at], id, sizeof id)) {
                snprintf(err, errsz, "node '%s' dependency id is invalid", node->id); return 0;
            }
        } else if (at >= 0 && tokens[at].type == DTG_JSON_OBJECT) {
            char cond[32] = "";
            if (!dtg_json_object_string(json, tokens, count, at, "nodeId", id, sizeof id, 1, err, errsz) ||
                !dtg_json_object_string(json, tokens, count, at, "condition", cond, sizeof cond, 0, err, errsz)) return 0;
            if (cond[0] && strcmp(cond, "succeeded") && strcmp(cond, "terminal")) {
                snprintf(err, errsz, "node '%s' dependency '%s' has unsupported condition '%s'", node->id, id, cond); return 0;
            }
            if (!strcmp(cond, "terminal")) condition = DTG_DEP_TERMINAL;
        } else {
            snprintf(err, errsz, "node '%s' dependency %d must be a string or object", node->id, i); return 0;
        }
        if (!dtg_id_valid(id) || !dtg_add_dependency(node, id, condition, err, errsz)) return 0;
    }
    return 1;
}

static int dtg_parse_node(const char *json, const dtg_json_token *tokens,
                          int count, int object, dtg_node *node,
                          char *err, size_t errsz) {
    char kind[32] = "", mutation[40] = "";
    memset(node, 0, sizeof *node);
    node->state = DTG_NODE_DRAFT;
    node->max_attempts = 1;
    node->idempotent = 1;
    node->priority = 50;
    node->timeout_ms = 900000;
    if (!dtg_json_object_string(json, tokens, count, object, "id", node->id, sizeof node->id, 1, err, errsz) ||
        !dtg_json_object_string(json, tokens, count, object, "kind", kind, sizeof kind, 1, err, errsz) ||
        !dtg_json_object_string(json, tokens, count, object, "title", node->title, sizeof node->title, 1, err, errsz) ||
        !dtg_json_object_string(json, tokens, count, object, "description", node->description, sizeof node->description, 0, err, errsz) ||
        !dtg_json_object_string(json, tokens, count, object, "mutation", mutation, sizeof mutation, 0, err, errsz)) return 0;
    node->kind = dtg_node_kind_parse(kind);
    node->mutation = dtg_mutation_parse(mutation);
    if (!dtg_id_valid(node->id)) { snprintf(err, errsz, "invalid node id '%s'", node->id); return 0; }
    if (node->kind == DTG_NODE_KIND_INVALID) { snprintf(err, errsz, "node '%s' has unknown kind '%s'", node->id, kind); return 0; }
    if (node->mutation == DTG_MUTATION_INVALID) { snprintf(err, errsz, "node '%s' has unknown mutation '%s'", node->id, mutation); return 0; }

    int deps = dtg_json_object_field(json, tokens, count, object, "dependsOn");
    int outputs = dtg_json_object_field(json, tokens, count, object, "outputs");
    int caps = dtg_json_object_field(json, tokens, count, object, "capabilities");
    if (!dtg_parse_dependencies(json, tokens, count, deps, node, err, errsz) ||
        !dtg_parse_outputs(json, tokens, count, outputs, node, err, errsz) ||
        !dtg_parse_string_array(json, tokens, count, caps, &node->capabilities, &node->capability_count, err, errsz) ||
        !dtg_parse_action(json, tokens, count, object, node, err, errsz)) return 0;
    if (!node->action_name[0] && node->kind == DTG_NODE_APPROVAL)
        cstr_copy(node->action_name, sizeof node->action_name, "approval.wait");
    if (!node->action_name[0] && node->kind == DTG_NODE_JOIN)
        cstr_copy(node->action_name, sizeof node->action_name, "join.all");

    long long v = 0;
    int retry = dtg_json_object_field(json, tokens, count, object, "retry");
    if (retry >= 0 && tokens[retry].type != DTG_JSON_OBJECT) { snprintf(err, errsz, "node '%s' retry must be an object", node->id); return 0; }
    if (retry >= 0) {
        if (!dtg_json_object_int(json, tokens, count, retry, "maxAttempts", 1, 1, 32, &v, err, errsz)) return 0;
        node->max_attempts = (int)v;
        if (!dtg_json_object_bool(json, tokens, count, retry, "automatic", 0, &node->automatic_retry, err, errsz)) return 0;
    }
    if (!dtg_json_object_bool(json, tokens, count, object, "idempotent", 1, &node->idempotent, err, errsz) ||
        !dtg_json_object_bool(json, tokens, count, object, "optional", 0, &node->optional, err, errsz) ||
        !dtg_json_object_int(json, tokens, count, object, "priority", 50, -1000, 1000, &v, err, errsz)) return 0;
    node->priority = (int)v;
    if (!dtg_json_object_int(json, tokens, count, object, "timeoutMs", 900000, 1, 86400000, &v, err, errsz)) return 0;
    node->timeout_ms = v;

    int mock = dtg_json_object_field(json, tokens, count, object, "synthetic");
    if (mock >= 0) {
        char result[24] = "succeeded";
        if (tokens[mock].type != DTG_JSON_OBJECT ||
            !dtg_json_object_int(json, tokens, count, mock, "delayMs", 0, 0, 60000, &v, err, errsz) ||
            !dtg_json_object_string(json, tokens, count, mock, "result", result, sizeof result, 0, err, errsz)) {
            if (!err[0]) snprintf(err, errsz, "node '%s' synthetic must be an object", node->id);
            return 0;
        }
        if (result[0] && strcmp(result, "succeeded") && strcmp(result, "failed")) {
            snprintf(err, errsz, "node '%s' synthetic result must be succeeded or failed", node->id); return 0;
        }
        node->synthetic_delay_ms = (int)v;
        node->synthetic_should_fail = !strcmp(result, "failed");
    }
    return 1;
}

static dtg_node *dtg_find_node(dtg_graph *g, const char *id) {
    if (!g || !id) return NULL;
    for (size_t i = 0; i < g->node_count; i++) if (!strcmp(g->nodes[i].id, id)) return &g->nodes[i];
    return NULL;
}

static const dtg_node *dtg_find_node_const(const dtg_graph *g, const char *id) {
    return dtg_find_node((dtg_graph *)g, id);
}

static int dtg_parse_graph_json(const char *json, dtg_graph *g,
                                char *err, size_t errsz) {
    if (err && errsz) err[0] = '\0';
    if (!json || !g) { snprintf(err, errsz, "graph JSON is missing"); return 0; }
    size_t len = strlen(json);
    if (!len || len > BODY_MAX) { snprintf(err, errsz, "graph JSON exceeds the bounded API size"); return 0; }
    if (!dtg_json_validate_complete(json, '{', err, errsz)) return 0;
    size_t cap = len / 2 + 256;
    if (cap < 256) cap = 256;
    if (cap > 65536) cap = 65536;
    dtg_json_token *tokens = calloc(cap, sizeof *tokens);
    if (!tokens) { snprintf(err, errsz, "out of memory tokenizing graph"); return 0; }
    int count = dtg_json_tokenize(json, len, tokens, cap);
    if (count < 1 || tokens[0].type != DTG_JSON_OBJECT) {
        free(tokens); snprintf(err, errsz, count == -2 ? "graph JSON has too many tokens" : "graph JSON is malformed"); return 0;
    }
    if (!dtg_json_unique_object_keys(json, tokens, count, err, errsz)) { free(tokens); return 0; }
    memset(g, 0, sizeof *g);
    g->schema_version = DTG_SCHEMA_VERSION;
    g->revision = 1;
    g->state = DTG_GRAPH_DRAFT;
    g->max_parallel_host_nodes = 3;
    g->max_parallel_llm_nodes = 1;
    g->max_attempts_per_node = 3;
    cstr_copy(g->policy, sizeof g->policy, "agent.general.v1");
    cstr_copy(g->mode, sizeof g->mode, "agent");

    long long v = 0;
    if (!dtg_json_object_int(json, tokens, count, 0, "schemaVersion", 1, 1, UINT_MAX, &v, err, errsz)) goto fail;
    g->schema_version = (unsigned)v;
    if (!dtg_json_object_int(json, tokens, count, 0, "revision", 1, 1, UINT_MAX, &v, err, errsz)) goto fail;
    g->revision = (unsigned)v;
    if (!dtg_json_object_string(json, tokens, count, 0, "graphId", g->id, sizeof g->id, 0, err, errsz) ||
        !dtg_json_object_string(json, tokens, count, 0, "policy", g->policy, sizeof g->policy, 0, err, errsz) ||
        !dtg_json_object_string(json, tokens, count, 0, "mode", g->mode, sizeof g->mode, 0, err, errsz) ||
        !dtg_json_object_string(json, tokens, count, 0, "executorMode", g->executor_mode, sizeof g->executor_mode, 0, err, errsz) ||
        !dtg_json_object_string(json, tokens, count, 0, "goal", g->goal, sizeof g->goal, 1, err, errsz) ||
        !dtg_json_object_string(json, tokens, count, 0, "workspace", g->workspace, sizeof g->workspace, 0, err, errsz)) goto fail;
    if (g->id[0] && !dtg_id_valid(g->id)) { snprintf(err, errsz, "invalid graphId '%s'", g->id); goto fail; }
    int approval = dtg_json_object_field(json, tokens, count, 0, "approval");
    if (approval >= 0) {
        if (tokens[approval].type != DTG_JSON_OBJECT ||
            !dtg_json_object_bool(json, tokens, count, approval, "required", 0, &g->approval_required, err, errsz)) {
            if (!err[0]) snprintf(err, errsz, "approval must be an object");
            goto fail;
        }
    }
    int limits = dtg_json_object_field(json, tokens, count, 0, "limits");
    if (limits >= 0) {
        if (tokens[limits].type != DTG_JSON_OBJECT) { snprintf(err, errsz, "limits must be an object"); goto fail; }
        if (!dtg_json_object_int(json, tokens, count, limits, "maxParallelHostNodes", 3, 1, 16, &v, err, errsz)) goto fail;
        g->max_parallel_host_nodes = (int)v;
        if (!dtg_json_object_int(json, tokens, count, limits, "maxParallelLlmNodes", 1, 1, 1, &v, err, errsz)) goto fail;
        g->max_parallel_llm_nodes = (int)v;
        if (!dtg_json_object_int(json, tokens, count, limits, "maxAttemptsPerNode", 3, 1, 32, &v, err, errsz)) goto fail;
        g->max_attempts_per_node = (int)v;
    }
    int nodes = dtg_json_object_field(json, tokens, count, 0, "nodes");
    if (nodes < 0 || tokens[nodes].type != DTG_JSON_ARRAY || tokens[nodes].size < 1 || tokens[nodes].size > DTG_MAX_NODES) {
        snprintf(err, errsz, "nodes must contain 1..%d objects", DTG_MAX_NODES); goto fail;
    }
    g->node_count = (size_t)tokens[nodes].size;
    g->nodes = calloc(g->node_count, sizeof *g->nodes);
    if (!g->nodes) { snprintf(err, errsz, "out of memory allocating graph nodes"); goto fail; }
    for (size_t i = 0; i < g->node_count; i++) {
        int at = dtg_json_array_nth(tokens, count, nodes, (int)i);
        if (at < 0 || tokens[at].type != DTG_JSON_OBJECT) { snprintf(err, errsz, "node %zu must be an object", i); goto fail; }
        if (!dtg_parse_node(json, tokens, count, at, &g->nodes[i], err, errsz)) goto fail;
    }

    /* Edges are accepted as a second, equivalent representation and merged
     * into dependsOn.  A duplicate is rejected instead of silently changing
     * dependency semantics. */
    int edges = dtg_json_object_field(json, tokens, count, 0, "edges");
    if (edges >= 0) {
        if (tokens[edges].type != DTG_JSON_ARRAY || tokens[edges].size > DTG_MAX_EDGES) {
            snprintf(err, errsz, "edges must be an array of at most %d items", DTG_MAX_EDGES); goto fail;
        }
        for (int i = 0; i < tokens[edges].size; i++) {
            int at = dtg_json_array_nth(tokens, count, edges, i);
            char from[DTG_ID_MAX + 1] = "", to[DTG_ID_MAX + 1] = "", condition[24] = "";
            if (at < 0 || tokens[at].type != DTG_JSON_OBJECT ||
                !dtg_json_object_string(json, tokens, count, at, "from", from, sizeof from, 1, err, errsz) ||
                !dtg_json_object_string(json, tokens, count, at, "to", to, sizeof to, 1, err, errsz) ||
                !dtg_json_object_string(json, tokens, count, at, "condition", condition, sizeof condition, 0, err, errsz)) goto fail;
            dtg_node *target = dtg_find_node(g, to);
            if (!target) { snprintf(err, errsz, "edge target '%s' does not exist", to); goto fail; }
            dtg_dependency_condition cond = !strcmp(condition, "terminal") ? DTG_DEP_TERMINAL : DTG_DEP_SUCCEEDED;
            int already = 0;
            for (size_t d = 0; d < target->dependency_count; d++) {
                if (strcmp(target->dependencies[d].node_id, from)) continue;
                if (target->dependencies[d].condition != cond) { snprintf(err, errsz, "edge %s -> %s conflicts with dependsOn", from, to); goto fail; }
                already = 1;
            }
            if (!already && !dtg_add_dependency(target, from, cond, err, errsz)) goto fail;
        }
    }
    g->edge_count = 0;
    for (size_t i = 0; i < g->node_count; i++) g->edge_count += g->nodes[i].dependency_count;
    g->created_ms = g->updated_ms = dstudio_now_ms();
    free(tokens);
    return 1;
fail:
    free(tokens);
    dtg_graph_free(g);
    return 0;
}

/* ---------- Validation and topological ordering ---------- */

static int dtg_capability_allowed(const char *policy, const char *capability) {
    static const char *allowed[] = {
        "filesystem.read", "filesystem.write", "git.read", "terminal",
        "network", "browser", "artifact.register", "test.run", NULL
    };
    if (!strcmp(policy, "test.synthetic.v1")) return !strncmp(capability, "synthetic.", 10) || !strcmp(capability, "filesystem.read");
    for (int i = 0; allowed[i]; i++) if (!strcmp(capability, allowed[i])) return 1;
    return 0;
}

static int dtg_node_has_downstream_gate(const dtg_graph *g, size_t start) {
    unsigned char seen[DTG_MAX_NODES] = {0};
    size_t queue[DTG_MAX_NODES], qh = 0, qt = 0;
    queue[qt++] = start; seen[start] = 1;
    while (qh < qt) {
        size_t cur = queue[qh++];
        for (size_t i = 0; i < g->node_count; i++) {
            if (seen[i]) continue;
            int edge = 0;
            for (size_t d = 0; d < g->nodes[i].dependency_count; d++)
                if (!strcmp(g->nodes[i].dependencies[d].node_id, g->nodes[cur].id)) { edge = 1; break; }
            if (!edge) continue;
            if (g->nodes[i].kind == DTG_NODE_GATE) return 1;
            seen[i] = 1; queue[qt++] = i;
        }
    }
    return 0;
}

static int dtg_topological_order(const dtg_graph *g, size_t *order,
                                 char *err, size_t errsz) {
    if (!g || !g->node_count || g->node_count > DTG_MAX_NODES) return 0;
    unsigned indegree[DTG_MAX_NODES] = {0};
    size_t queue[DTG_MAX_NODES], qh = 0, qt = 0, emitted = 0;
    for (size_t i = 0; i < g->node_count; i++) indegree[i] = (unsigned)g->nodes[i].dependency_count;
    for (size_t i = 0; i < g->node_count; i++) if (!indegree[i]) queue[qt++] = i;
    while (qh < qt) {
        size_t n = queue[qh++];
        if (order) order[emitted] = n;
        emitted++;
        for (size_t i = 0; i < g->node_count; i++) {
            for (size_t d = 0; d < g->nodes[i].dependency_count; d++) {
                if (strcmp(g->nodes[i].dependencies[d].node_id, g->nodes[n].id)) continue;
                if (indegree[i] && --indegree[i] == 0) queue[qt++] = i;
            }
        }
    }
    if (emitted != g->node_count) {
        snprintf(err, errsz, "graph contains a dependency cycle (%zu/%zu nodes sortable)", emitted, g->node_count);
        return 0;
    }
    return 1;
}

static int dtg_validate_graph(const dtg_graph *g, int strict,
                              char *err, size_t errsz) {
    if (err && errsz) err[0] = '\0';
    if (!g) { snprintf(err, errsz, "graph is missing"); return 0; }
    if (g->schema_version != DTG_SCHEMA_VERSION) { snprintf(err, errsz, "unknown task graph schema version %u", g->schema_version); return 0; }
    if (!g->node_count || g->node_count > DTG_MAX_NODES || g->edge_count > DTG_MAX_EDGES) {
        snprintf(err, errsz, "graph exceeds V1 node/edge limits"); return 0;
    }
    if (g->max_parallel_llm_nodes != 1) { snprintf(err, errsz, "V1 requires maxParallelLlmNodes=1"); return 0; }
    if (strcmp(g->policy, "agent.general.v1") && strcmp(g->policy, "plan.v1") && strcmp(g->policy, "test.synthetic.v1")) {
        snprintf(err, errsz, "unknown task graph policy '%s'", g->policy); return 0;
    }
    if (g->executor_mode[0] && strcmp(g->executor_mode, "synthetic") &&
        strcmp(g->executor_mode, "native")) {
        snprintf(err, errsz, "unknown executorMode '%s'", g->executor_mode); return 0;
    }
    if (!strcmp(g->executor_mode, "synthetic") && strcmp(g->policy, "test.synthetic.v1")) {
        snprintf(err, errsz, "synthetic executor is restricted to test.synthetic.v1"); return 0;
    }
    if (!strcmp(g->executor_mode, "native") && strcmp(g->policy, "agent.general.v1")) {
        snprintf(err, errsz, "native executor is restricted to agent.general.v1"); return 0;
    }
    int has_approval = 0;
    for (size_t i = 0; i < g->node_count; i++) {
        const dtg_node *n = &g->nodes[i];
        for (size_t j = i + 1; j < g->node_count; j++) {
            if (!strcmp(n->id, g->nodes[j].id)) { snprintf(err, errsz, "duplicate node id '%s'", n->id); return 0; }
        }
        if (n->kind == DTG_NODE_APPROVAL) has_approval = 1;
        /* A mutating Agent turn may be retried only under the stronger
         * completion contract.  The scheduler below still retries it solely
         * when the structured transcript proves that zero tool calls ran, so
         * no mutation was dispatched. */
        if (n->automatic_retry && !n->idempotent &&
            (strcmp(n->action_name, "agent.prompt") || !n->action_require_tool_result)) {
            snprintf(err, errsz, "node '%s' enables automatic retry but is not idempotent", n->id);
            return 0;
        }
        if (n->max_attempts > g->max_attempts_per_node) { snprintf(err, errsz, "node '%s' exceeds graph maxAttemptsPerNode", n->id); return 0; }
        for (size_t c = 0; c < n->capability_count; c++) {
            if (!dtg_capability_allowed(g->policy, n->capabilities[c])) {
                snprintf(err, errsz, "node '%s' requests capability '%s' outside policy '%s'", n->id, n->capabilities[c], g->policy); return 0;
            }
        }
        for (size_t o = 0; o < n->output_count; o++) {
            if (!dtg_relative_path_valid(n->outputs[o].path)) { snprintf(err, errsz, "node '%s' output '%s' escapes the workspace", n->id, n->outputs[o].name); return 0; }
        }
        for (size_t d = 0; d < n->dependency_count; d++) {
            const dtg_dependency *dep = &n->dependencies[d];
            if (!strcmp(dep->node_id, n->id)) { snprintf(err, errsz, "node '%s' has a self-edge", n->id); return 0; }
            if (!dtg_find_node_const(g, dep->node_id)) { snprintf(err, errsz, "node '%s' depends on missing node '%s'", n->id, dep->node_id); return 0; }
        }
        if (strict && n->mutation == DTG_MUTATION_WORKSPACE_WRITE && !dtg_node_has_downstream_gate(g, i)) {
            snprintf(err, errsz, "workspace writer '%s' has no downstream verification gate", n->id); return 0;
        }
    }
    for (size_t i = 0; i < g->node_count; i++) {
        if (g->nodes[i].mutation == DTG_MUTATION_EXTERNAL_SIDE_EFFECT && (!g->approval_required || !has_approval)) {
            snprintf(err, errsz, "external side-effect node '%s' requires graph approval and an approval node", g->nodes[i].id); return 0;
        }
    }
    return dtg_topological_order(g, NULL, err, errsz);
}

/* ---------- Central state transition authority ---------- */

static int dtg_node_terminal(dtg_node_state s) {
    return s == DTG_NODE_SUCCEEDED || s == DTG_NODE_FAILED ||
           s == DTG_NODE_CANCELLED || s == DTG_NODE_SKIPPED;
}

static int dtg_graph_terminal(dtg_graph_state s) {
    return s == DTG_GRAPH_SUCCEEDED || s == DTG_GRAPH_FAILED ||
           s == DTG_GRAPH_CANCELLED || s == DTG_GRAPH_CORRUPT;
}

static int dtg_node_transition_allowed(dtg_node_state from, dtg_node_state to) {
    if (from == to) return 1;
    switch (from) {
        case DTG_NODE_DRAFT: return to == DTG_NODE_PENDING || to == DTG_NODE_CANCELLED;
        case DTG_NODE_PENDING: return to == DTG_NODE_READY || to == DTG_NODE_BLOCKED || to == DTG_NODE_SKIPPED || to == DTG_NODE_CANCELLED;
        case DTG_NODE_READY: return to == DTG_NODE_LEASED || to == DTG_NODE_PAUSED || to == DTG_NODE_CANCELLED || to == DTG_NODE_SKIPPED;
        case DTG_NODE_LEASED: return to == DTG_NODE_RUNNING || to == DTG_NODE_READY || to == DTG_NODE_CANCELLING;
        case DTG_NODE_RUNNING: return to == DTG_NODE_SUCCEEDED || to == DTG_NODE_FAILED || to == DTG_NODE_WAITING_APPROVAL || to == DTG_NODE_CANCELLING || to == DTG_NODE_INTERRUPTED;
        case DTG_NODE_WAITING_APPROVAL: return to == DTG_NODE_READY || to == DTG_NODE_SUCCEEDED || to == DTG_NODE_CANCELLED || to == DTG_NODE_FAILED;
        case DTG_NODE_PAUSED: return to == DTG_NODE_READY || to == DTG_NODE_CANCELLED;
        case DTG_NODE_CANCELLING: return to == DTG_NODE_CANCELLED || to == DTG_NODE_INTERRUPTED;
        case DTG_NODE_INTERRUPTED: return to == DTG_NODE_READY || to == DTG_NODE_WAITING_APPROVAL || to == DTG_NODE_FAILED || to == DTG_NODE_CANCELLED;
        case DTG_NODE_FAILED: return to == DTG_NODE_PENDING; /* explicit/validated retry creates a new attempt */
        case DTG_NODE_BLOCKED: return to == DTG_NODE_PENDING || to == DTG_NODE_SKIPPED || to == DTG_NODE_CANCELLED;
        default: return 0;
    }
}

static int dtg_graph_transition_allowed(dtg_graph_state from, dtg_graph_state to) {
    if (from == to) return 1;
    switch (from) {
        case DTG_GRAPH_DRAFT: return to == DTG_GRAPH_VALIDATED || to == DTG_GRAPH_CORRUPT || to == DTG_GRAPH_CANCELLED;
        case DTG_GRAPH_VALIDATED: return to == DTG_GRAPH_READY || to == DTG_GRAPH_WAITING_APPROVAL || to == DTG_GRAPH_CANCELLED;
        case DTG_GRAPH_READY: return to == DTG_GRAPH_RUNNING || to == DTG_GRAPH_CANCELLED;
        case DTG_GRAPH_RUNNING: return to == DTG_GRAPH_PAUSING || to == DTG_GRAPH_WAITING_APPROVAL || to == DTG_GRAPH_NEEDS_INPUT || to == DTG_GRAPH_SUCCEEDED || to == DTG_GRAPH_FAILED || to == DTG_GRAPH_CANCELLING;
        case DTG_GRAPH_PAUSING: return to == DTG_GRAPH_PAUSED || to == DTG_GRAPH_CANCELLING;
        case DTG_GRAPH_PAUSED: return to == DTG_GRAPH_RUNNING || to == DTG_GRAPH_CANCELLING;
        case DTG_GRAPH_WAITING_APPROVAL: return to == DTG_GRAPH_READY || to == DTG_GRAPH_RUNNING || to == DTG_GRAPH_CANCELLING || to == DTG_GRAPH_FAILED;
        case DTG_GRAPH_NEEDS_INPUT: return to == DTG_GRAPH_RUNNING || to == DTG_GRAPH_CANCELLING || to == DTG_GRAPH_FAILED;
        case DTG_GRAPH_CANCELLING: return to == DTG_GRAPH_CANCELLED;
        default: return 0;
    }
}

static int dtg_transition_node_raw(dtg_graph *g, dtg_node *n,
                                   dtg_node_state to, long long now,
                                   char *err, size_t errsz) {
    if (!g || !n || !dtg_node_transition_allowed(n->state, to)) {
        snprintf(err, errsz, "illegal node transition %s -> %s%s%s",
                 n ? dtg_node_state_name(n->state) : "missing",
                 dtg_node_state_name(to), n ? " for " : "", n ? n->id : "");
        return 0;
    }
    n->state = to;
    if (to == DTG_NODE_PENDING) {
        n->ready_ms = 0;
        n->started_ms = 0;
        n->finished_ms = 0;
    }
    if (to == DTG_NODE_READY && !n->ready_ms) n->ready_ms = now;
    if (to == DTG_NODE_RUNNING) n->started_ms = now;
    if (dtg_node_terminal(to)) n->finished_ms = now;
    g->updated_ms = now;
    return 1;
}

static int dtg_transition_graph_raw(dtg_graph *g, dtg_graph_state to,
                                    long long now, char *err, size_t errsz) {
    if (!g || !dtg_graph_transition_allowed(g->state, to)) {
        snprintf(err, errsz, "illegal graph transition %s -> %s",
                 g ? dtg_graph_state_name(g->state) : "missing", dtg_graph_state_name(to));
        return 0;
    }
    g->state = to;
    if (to == DTG_GRAPH_RUNNING && !g->started_ms) g->started_ms = now;
    if (dtg_graph_terminal(to)) g->completed_ms = now;
    g->updated_ms = now;
    return 1;
}

/* Deterministic graph definition serializer. Runtime state is intentionally
 * absent; state.json owns attempts, timings and transitions. */
static int dtg_graph_definition_json(const dtg_graph *g, json_dyn_buf *b) {
    int ok = json_dyn_puts(b, "{\"schemaVersion\":") && json_dyn_printf(b, "%u", g->schema_version) &&
        json_dyn_puts(b, ",\"graphId\":") && json_dyn_put_escaped(b, g->id) &&
        json_dyn_printf(b, ",\"revision\":%u", g->revision) &&
        json_dyn_puts(b, ",\"policy\":") && json_dyn_put_escaped(b, g->policy) &&
        json_dyn_puts(b, ",\"mode\":") && json_dyn_put_escaped(b, g->mode) &&
        json_dyn_puts(b, ",\"executorMode\":") && json_dyn_put_escaped(b, g->executor_mode) &&
        json_dyn_puts(b, ",\"status\":\"draft\",\"goal\":") && json_dyn_put_escaped(b, g->goal) &&
        json_dyn_puts(b, ",\"workspace\":") && json_dyn_put_escaped(b, g->workspace) &&
        json_dyn_printf(b, ",\"approval\":{\"required\":%s},\"limits\":{\"maxParallelHostNodes\":%d,\"maxParallelLlmNodes\":%d,\"maxAttemptsPerNode\":%d},\"nodes\":[",
                        g->approval_required ? "true" : "false", g->max_parallel_host_nodes,
                        g->max_parallel_llm_nodes, g->max_attempts_per_node);
    for (size_t i = 0; ok && i < g->node_count; i++) {
        const dtg_node *n = &g->nodes[i];
        if (i) ok = json_dyn_puts(b, ",");
        ok = ok && json_dyn_puts(b, "{\"id\":") && json_dyn_put_escaped(b, n->id) &&
            json_dyn_puts(b, ",\"kind\":") && json_dyn_put_escaped(b, dtg_node_kind_name(n->kind)) &&
            json_dyn_puts(b, ",\"title\":") && json_dyn_put_escaped(b, n->title) &&
            json_dyn_puts(b, ",\"description\":") && json_dyn_put_escaped(b, n->description) &&
            json_dyn_puts(b, ",\"mutation\":") && json_dyn_put_escaped(b, dtg_mutation_name(n->mutation)) &&
            json_dyn_puts(b, ",\"dependsOn\":[");
        for (size_t d = 0; ok && d < n->dependency_count; d++) {
            if (d) ok = json_dyn_puts(b, ",");
            ok = ok && json_dyn_puts(b, "{\"nodeId\":") && json_dyn_put_escaped(b, n->dependencies[d].node_id) &&
                 json_dyn_puts(b, ",\"condition\":") && json_dyn_put_escaped(b, n->dependencies[d].condition == DTG_DEP_TERMINAL ? "terminal" : "succeeded") && json_dyn_puts(b, "}");
        }
        ok = ok && json_dyn_puts(b, "],\"capabilities\":[");
        for (size_t c = 0; ok && c < n->capability_count; c++) {
            if (c) ok = json_dyn_puts(b, ",");
            ok = ok && json_dyn_put_escaped(b, n->capabilities[c]);
        }
        ok = ok && json_dyn_puts(b, "],\"outputs\":[");
        for (size_t o = 0; ok && o < n->output_count; o++) {
            if (o) ok = json_dyn_puts(b, ",");
            ok = ok && json_dyn_puts(b, "{\"name\":") && json_dyn_put_escaped(b, n->outputs[o].name) &&
                json_dyn_puts(b, ",\"type\":") && json_dyn_put_escaped(b, n->outputs[o].type) &&
                json_dyn_puts(b, ",\"path\":") && json_dyn_put_escaped(b, n->outputs[o].path) &&
                json_dyn_printf(b, ",\"required\":%s,\"minimumBytes\":%llu}", n->outputs[o].required ? "true" : "false", n->outputs[o].minimum_bytes);
        }
        ok = ok && json_dyn_printf(b, "],\"retry\":{\"maxAttempts\":%d,\"automatic\":%s},\"timeoutMs\":%lld,\"idempotent\":%s,\"optional\":%s,\"priority\":%d,\"synthetic\":{\"delayMs\":%d,\"result\":\"%s\"}",
            n->max_attempts, n->automatic_retry ? "true" : "false", n->timeout_ms,
            n->idempotent ? "true" : "false", n->optional ? "true" : "false", n->priority,
            n->synthetic_delay_ms, n->synthetic_should_fail ? "failed" : "succeeded");
        if (ok && n->action_name[0]) {
            ok = json_dyn_puts(b, ",\"action\":{\"name\":") &&
                 json_dyn_put_escaped(b, n->action_name) &&
                 json_dyn_puts(b, ",\"path\":") && json_dyn_put_escaped(b, n->action_path) &&
                 json_dyn_printf(b, ",\"maxBytes\":%llu", n->action_max_bytes);
            if (ok && n->action_text)
                ok = json_dyn_puts(b, ",\"text\":") && json_dyn_put_escaped(b, n->action_text);
            if (ok && n->action_display)
                ok = json_dyn_puts(b, ",\"display\":") && json_dyn_put_escaped(b, n->action_display);
            if (ok && n->action_expect)
                ok = json_dyn_puts(b, ",\"contains\":") && json_dyn_put_escaped(b, n->action_expect);
            if (ok && n->action_require_tool_result)
                ok = json_dyn_puts(b, ",\"requireToolResult\":true");
            if (ok && n->action_argc) {
                ok = json_dyn_puts(b, ",\"argv\":[");
                for (size_t a = 0; ok && a < n->action_argc; a++) {
                    if (a) ok = json_dyn_puts(b, ",");
                    ok = ok && json_dyn_put_escaped(b, n->action_argv[a]);
                }
                ok = ok && json_dyn_puts(b, "]");
            }
            ok = ok && json_dyn_puts(b, "}");
        }
        ok = ok && json_dyn_puts(b, "}");
    }
    return ok && json_dyn_puts(b, "],\"edges\":[]}");
}

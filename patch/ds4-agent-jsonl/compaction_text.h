/* Text-only compaction shared by the older native Laguna/Qwen MoE Agents.
 * Role wrappers come from their pinned chat encoders, not DeepSeek token IDs.
 * All scans/preparation run on the exclusive inference worker outside mu.
 * No persistent cache or alternate transcript is introduced here. */
#ifndef DSTUDIO_COMPACTION_TEXT_H
#define DSTUDIO_COMPACTION_TEXT_H

typedef enum {
    AGENT_COMPACT_NO_ROLE, AGENT_COMPACT_USER, AGENT_COMPACT_ASSISTANT,
    AGENT_COMPACT_TOOL, AGENT_COMPACT_SYSTEM
} agent_compact_role;

static bool agent_compact_is_laguna(agent_worker *w) {
#ifdef DSTUDIO_COMPACTION_LAGUNA
    return ds4_engine_is_laguna(w->engine);
#else
    (void)w; return false;
#endif
}
static bool agent_compact_is_qwen(agent_worker *w) {
#ifdef DSTUDIO_COMPACTION_QWEN35
    return ds4_engine_is_qwen35moe(w->engine);
#else
    (void)w; return false;
#endif
}

/* A BPE piece may contain the end of a tag and the first payload characters.
 * Compare rendered bytes across pieces; do not require one special-token ID
 * or an independently tokenized prefix to equal the complete-message BPE. */
static bool agent_compact_prefix_at(agent_worker *w, int pos, int limit,
                                    const char *prefix, int *end) {
    size_t matched = 0, length = strlen(prefix);
    for (int i = pos; i < limit && matched < length; i++) {
        size_t n = 0; char *piece = ds4_token_text(w->engine, w->transcript.v[i], &n);
        size_t take = length - matched;
        if (take > n) take = n;
        bool ok = piece && take && !memcmp(piece, prefix + matched, take);
        free(piece);
        if (!ok) return false;
        matched += take;
        if (matched == length) { if (end) *end = i + 1; return true; }
    }
    return false;
}
static agent_compact_role agent_compact_role_at(agent_worker *w, int pos,
                                               int limit, int *end) {
    if (pos < 0 || pos >= limit) return AGENT_COMPACT_NO_ROLE;
    if (agent_compact_is_qwen(w)) {
        static const char *const names[] = {
            NULL, "<|im_start|>user\n", "<|im_start|>assistant\n",
            NULL, "<|im_start|>system\n"
        };
        if (w->transcript.v[pos] != ds4_token_user(w->engine)) return AGENT_COMPACT_NO_ROLE;
        if (agent_compact_prefix_at(w, pos, limit, "<|im_start|>user\n<tool_response>", end))
            return AGENT_COMPACT_TOOL;
        for (int role = AGENT_COMPACT_USER; role <= AGENT_COMPACT_SYSTEM; role++)
            if (names[role] && agent_compact_prefix_at(w, pos, limit, names[role], end))
                return (agent_compact_role)role;
        return AGENT_COMPACT_NO_ROLE;
    }
    if (w->transcript.v[pos] == ds4_token_assistant(w->engine)) {
        if (end) *end = pos + 1;
        return AGENT_COMPACT_ASSISTANT;
    }
    if (agent_compact_is_laguna(w)) {
        static const char *const names[] = {NULL, "<user>", NULL, "<tool_response>", "<system>"};
        for (int role = AGENT_COMPACT_USER; role <= AGENT_COMPACT_SYSTEM; role++)
            if (names[role] && agent_compact_prefix_at(w, pos, limit, names[role], end))
                return (agent_compact_role)role;
        return AGENT_COMPACT_NO_ROLE;
    }
    if (w->transcript.v[pos] == ds4_token_user(w->engine)) {
        if (end) *end = pos + 1;
        return AGENT_COMPACT_USER;
    }
    if (ds4_engine_is_glm_dsa(w->engine) &&
        agent_compact_prefix_at(w, pos, limit, "<|observation|>", end))
        return AGENT_COMPACT_TOOL;
    return AGENT_COMPACT_NO_ROLE;
}

static int agent_compact_last_role(agent_worker *w, int pos, int floor,
                                   agent_compact_role *role) {
    for (int i = pos - 1; i >= floor; i--) {
        agent_compact_role found = agent_compact_role_at(w, i, pos, NULL);
        if (found != AGENT_COMPACT_NO_ROLE) { *role = found; return i; }
    }
    *role = AGENT_COMPACT_NO_ROLE;
    return -1;
}

/* Fixed-size lexical wrapper state, including tags which start in the middle
 * of a BPE piece. This only reconstructs framing; retained token IDs are never
 * decoded and re-tokenized. The needles are fixed native wrapper literals. */
static bool agent_compact_wrapper_open(agent_worker *w, int start, int end,
                                       const char *open, const char *close,
                                       bool initial) {
    char tail[64] = {0};
    size_t used = 0, a = strlen(open), b = strlen(close);
    bool active = initial;
    for (int i = start; i < end; i++) {
        size_t n = 0; char *piece = ds4_token_text(w->engine, w->transcript.v[i], &n);
        for (size_t j = 0; piece && j < n; j++) {
            if (used == sizeof(tail)) { memmove(tail, tail + 1, --used); }
            tail[used++] = piece[j];
            if (a && used >= a && !memcmp(tail + used - a, open, a)) active = true;
            if (b && used >= b && !memcmp(tail + used - b, close, b)) active = false;
        }
        free(piece);
    }
    return active;
}

/* Native ordinary-BPE closing tags may begin inside a piece (for example
 * ".</"). Move a cut to the first overlapping token, preserving that entire
 * token in the verbatim tail. The bounded window cannot grow with context. */
static int agent_compact_align_boundary(agent_worker *w, int pos) {
    if (pos <= 0 || pos >= w->transcript.len) return pos;
    int first = pos > 32 ? pos - 32 : 0;
    int last = pos + 32 < w->transcript.len ? pos + 32 : w->transcript.len;
    size_t offsets[65] = {0};
    agent_buf text = {0};
    for (int i = first; i < last; i++) {
        size_t n = 0; char *piece = ds4_token_text(w->engine, w->transcript.v[i], &n);
        if (!piece || n > 16384 - text.len) { free(piece); free(text.ptr); return -1; }
        offsets[i - first] = text.len;
        agent_buf_append(&text, piece, n);
        free(piece);
    }
    offsets[last - first] = text.len;
    size_t cut = offsets[pos - first];
    static const char *const markers[] = {
        "<user>", "</user>", "<system>", "</system>",
        "<assistant>", "</assistant>", "<tool_response>", "</tool_response>",
        "<tool_result>", "</tool_result>", "<think>", "</think>",
        "<|im_start|>user\n", "<|im_start|>assistant\n", "<|im_start|>system\n",
        "<|im_end|>", "<|observation|>"
    };
    int aligned = pos;
    for (size_t m = 0; m < sizeof(markers)/sizeof(markers[0]); m++) {
        size_t n = strlen(markers[m]);
        for (size_t j = cut >= n ? cut - n + 1 : 0; j < cut && j + n <= text.len; j++) {
            if (j + n <= cut || memcmp(text.ptr + j, markers[m], n)) continue;
            for (int i = first; i < pos; i++)
                if (offsets[i-first] <= j && offsets[i-first+1] > j && i < aligned)
                    aligned = i;
        }
    }
    free(text.ptr);
    return aligned;
}

/* Prefer the newest complete user turn (up to twice the tail budget). If no
 * user fits, preserve a complete assistant/tool message before using a bounded
 * fragment of a single long message. A role prefix is never cut in half. */
static int agent_compact_tail_start(agent_worker *w, int bottom, int sys_len) {
    int budget = agent_worker_effective_ctx_size(w) / AGENT_COMPACT_TAIL_DIVISOR;
    if (budget > AGENT_COMPACT_TAIL_CAP_TOKENS) budget = AGENT_COMPACT_TAIL_CAP_TOKENS;
    if (budget < 1) budget = 1;
    int earliest = bottom - 2 * budget;
    if (earliest < sys_len) earliest = sys_len;
    int any = -1;
    for (int i = bottom - 1; i >= earliest; i--) {
        agent_compact_role role = agent_compact_role_at(w, i, bottom, NULL);
        if (role == AGENT_COMPACT_USER) return i;
        if (any < 0 && role != AGENT_COMPACT_NO_ROLE) any = i;
    }
    if (any >= 0) return any;
    int target = bottom - budget;
    return target < sys_len ? sys_len : target;
}

static bool agent_compact_thinking_at(agent_worker *w, int start, int end) {
    return agent_compact_wrapper_open(w, start, end, "<think>", "</think>", false);
}

static bool agent_compact_append_tail_prefix(agent_worker *w, ds4_tokens *out,
                                             int pos, int sys_len) {
    agent_compact_role role;
    int start = agent_compact_last_role(w, pos, sys_len, &role);
    if (start < 0) return false;
    if (role == AGENT_COMPACT_ASSISTANT) {
        ds4_chat_append_assistant_prefix(w->engine, out,
            agent_compact_thinking_at(w, start, pos) ? DS4_THINK_HIGH : DS4_THINK_NONE);
        return true;
    }
    const char *prefix = NULL;
    if (agent_compact_is_laguna(w)) {
        prefix = role == AGENT_COMPACT_USER ? "<user>" :
                 role == AGENT_COMPACT_TOOL ? "<tool_response>" : "<system>";
    } else if (agent_compact_is_qwen(w)) {
        prefix = role == AGENT_COMPACT_SYSTEM ? "<|im_start|>system\n" :
                 role == AGENT_COMPACT_TOOL ? "<|im_start|>user\n<tool_response>" :
                 "<|im_start|>user\n";
    } else if (ds4_engine_is_glm_dsa(w->engine)) {
        prefix = role == AGENT_COMPACT_TOOL ? "<|observation|><tool_response>" : "<|user|>";
    } else prefix = "<｜User｜>";
    ds4_tokenize_rendered_chat(w->engine, prefix, out);
    if (role == AGENT_COMPACT_USER && !agent_compact_is_laguna(w)) {
        const char *a = agent_compact_is_qwen(w) ? "<tool_response>" : "<tool_result>";
        const char *b = agent_compact_is_qwen(w) ? "</tool_response>" : "</tool_result>";
        if (agent_compact_wrapper_open(w, start, pos, a, b, false))
            ds4_tokenize_rendered_chat(w->engine, a, out);
    }
    return true;
}

/* Private summary requests must start a new native message, even when the
 * bounded historical prefix ends inside an old user/assistant/tool message.
 * These closing tokens affect only the private summary prompt. */
static bool agent_compact_close_summary_prefix(agent_worker *w, ds4_tokens *out,
                                               int pos, int sys_len) {
    agent_compact_role role;
    int start = agent_compact_last_role(w, pos, sys_len, &role);
    if (start < 0) return false;
    const char *close = NULL;
    if (agent_compact_is_qwen(w)) close = "<|im_end|>";
    else if (agent_compact_is_laguna(w))
        close = role == AGENT_COMPACT_USER ? "</user>" :
                role == AGENT_COMPACT_ASSISTANT ? "</assistant>" :
                role == AGENT_COMPACT_TOOL ? "</tool_response>" : "</system>";
    if (!close || !agent_compact_wrapper_open(w, start, pos, "", close, true)) return true;
    if (role == AGENT_COMPACT_ASSISTANT && agent_compact_thinking_at(w, start, pos))
        ds4_tokenize_rendered_chat(w->engine, "</think>", out);
    if ((role == AGENT_COMPACT_USER || role == AGENT_COMPACT_TOOL) && agent_compact_is_qwen(w) &&
        agent_compact_wrapper_open(w, start, pos, "<tool_response>", "</tool_response>", false))
        ds4_tokenize_rendered_chat(w->engine, "</tool_response>", out);
    ds4_tokenize_rendered_chat(w->engine, close, out);
    ds4_tokenize_rendered_chat(w->engine, "\n", out);
    return true;
}

static int agent_compact_summary_budget(int ctx) {
    int budget = ctx / 8;
    if (budget < 256) budget = 256;
    if (budget > AGENT_COMPACT_SUMMARY_MAX_TOKENS) budget = AGENT_COMPACT_SUMMARY_MAX_TOKENS;
    return budget;
}
static int agent_compact_reserve_tokens(agent_worker *w) {
    int prompt_tokens = 0;
    /* Reserve both native-tokenized runtime states before generating. String
     * length is not a token bound, and the longer state differs by tokenizer. */
    for (int open = 0; open <= 1; open++) {
        char *text = agent_compact_make_prompt("context pressure before continuing the current task", open != 0);
        ds4_tokens tokens = {0};
        ds4_chat_append_message(w->engine, &tokens, "user", text);
        ds4_chat_append_assistant_prefix(w->engine, &tokens, DS4_THINK_NONE);
        if (tokens.len > prompt_tokens) prompt_tokens = tokens.len;
        free(text); ds4_tokens_free(&tokens);
    }
    return prompt_tokens + 128 + agent_compact_summary_budget(agent_worker_effective_ctx_size(w));
}

static bool agent_stream_compaction_needs_lookahead(const agent_stream_renderer *sr) {
    return !sr->dsml_active && sr->parser->state == AGENT_DSML_SEARCH &&
           (sr->pending_len || sr->dsml_start_len);
}
#endif

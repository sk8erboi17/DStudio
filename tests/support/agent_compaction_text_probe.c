/* Native GGUF vocabulary + actual compaction framing; no model generation.
 * Expected message identity comes from the calls that constructed the fixture,
 * not from the compactor's scanner. All original suffix token IDs must survive. */
#include "ds4.h"
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#define DS4_AGENT_TEST
#define DS4_AGENT_TEST_NO_MAIN
#include "ds4_agent.c"

ds4_engine *dstudio_test_tokenizer_open(const char *path);
void dstudio_test_tokenizer_close(ds4_engine *engine);
static int checks, failures;
static void check(const char *name, bool passed) {
    checks++; failures += !passed;
    printf("{\"case\":\"%s\",\"passed\":%s}\n", name, passed ? "true" : "false");
}
static char *render(ds4_engine *engine, const ds4_tokens *tokens, size_t *offsets) {
    agent_buf text = {0};
    for (int i = 0; i < tokens->len; i++) {
        size_t n = 0; char *piece = ds4_token_text(engine, tokens->v[i], &n);
        assert(piece);
        if (offsets) offsets[i] = text.len;
        agent_buf_append(&text, piece, n); free(piece);
    }
    if (offsets) offsets[tokens->len] = text.len;
    return agent_buf_take(&text);
}
static void reset(agent_worker *w, int *sys_len) {
    ds4_tokens_free(&w->transcript);
    ds4_chat_begin(w->engine, &w->transcript);
    ds4_chat_append_message(w->engine, &w->transcript, "system", "Preserve source text.");
    *sys_len = w->transcript.len;
}
static int containing_token(const size_t *offsets, int count, size_t byte) {
    for (int i = 0; i < count; i++) if (offsets[i] <= byte && byte < offsets[i + 1]) return i;
    return count;
}
static void message_case(agent_worker *w, const char *role, agent_compact_role expected,
                         const char *payload, ds4_think_mode think, const char *label) {
    int sys_len; reset(w, &sys_len);
    const int start = w->transcript.len;
    if (expected == AGENT_COMPACT_ASSISTANT) {
        ds4_chat_append_assistant_prefix(w->engine, &w->transcript, think);
        ds4_tokenize_rendered_chat(w->engine, payload, &w->transcript);
    } else ds4_chat_append_message(w->engine, &w->transcript, role, payload);
    const int bottom = w->transcript.len;
    char name[160];
    snprintf(name, sizeof(name), "%s/native-role", label);
    check(name, agent_compact_role_at(w, start, bottom, NULL) == expected);

    size_t *offsets = calloc((size_t)bottom + 1, sizeof(*offsets)); assert(offsets);
    char *text = render(w->engine, &w->transcript, offsets);
    /* Independent byte-offset oracle: a cut inside a known native wrapper
     * moves to the token containing that wrapper's first byte, even if the
     * same BPE piece also contains a preceding full stop. */
    static const char *const tags[] = {"<user>", "</user>", "<assistant>", "</assistant>",
        "<tool_response>", "</tool_response>", "<think>", "</think>",
        "<|im_start|>user\n", "<|im_start|>assistant\n", "<|im_end|>"};
    bool aligned = true; int crossing = 0;
    for (int cut = start + 1; cut < bottom; cut++) {
        int wanted = cut;
        for (size_t t = 0; t < sizeof(tags)/sizeof(tags[0]); t++) {
            const char *at = text + offsets[start];
            while ((at = strstr(at, tags[t]))) {
                size_t a = (size_t)(at - text), b = a + strlen(tags[t]);
                if (a < offsets[cut] && offsets[cut] < b) {
                    int token = containing_token(offsets, bottom, a);
                    if (token < wanted) wanted = token;
                }
                at++;
            }
        }
        crossing += wanted != cut;
        if (agent_compact_align_boundary(w, cut) != wanted) aligned = false;
    }
    snprintf(name, sizeof(name), "%s/all-token-boundaries", label); check(name, aligned);
    fprintf(stderr, "%s: %d token cuts, %d native wrapper crossings\n", label, bottom-start-1, crossing);

    /* Choose a fragment within payload, not within a role/think delimiter. */
    const char *marker = strstr(text + offsets[start], "RETAINED_FRAGMENT"); assert(marker);
    int cut = containing_token(offsets, bottom, (size_t)(marker - text));
    cut = agent_compact_align_boundary(w, cut);
    agent_compact_role actual;
    agent_compact_last_role(w, cut, sys_len, &actual);
    snprintf(name, sizeof(name), "%s/fragment-role", label); check(name, actual == expected);
    ds4_tokens rebuilt = {0};
    bool framed = agent_compact_append_tail_prefix(w, &rebuilt, cut, sys_len);
    const int dst = rebuilt.len;
    agent_tokens_append_range(&rebuilt, &w->transcript, cut, bottom);
    bool unchanged = framed && rebuilt.len - dst == bottom - cut &&
        !memcmp(rebuilt.v + dst, w->transcript.v + cut, (size_t)(bottom - cut) * sizeof(int));
    snprintf(name, sizeof(name), "%s/original-token-suffix", label); check(name, unchanged);
    char *tail = render(w->engine, &rebuilt, NULL);
    const bool laguna = agent_compact_is_laguna(w);
    const char *prefix = expected == AGENT_COMPACT_USER ? (laguna ? "<user>" : "<|im_start|>user\n") :
        expected == AGENT_COMPACT_TOOL ? (laguna ? "<tool_response>" : "<|im_start|>user\n<tool_response>") :
        (laguna ? "<assistant>" : "<|im_start|>assistant\n");
    snprintf(name, sizeof(name), "%s/reopened-native-wrapper", label);
    check(name, !strncmp(tail, prefix, strlen(prefix)));
    if (expected == AGENT_COMPACT_ASSISTANT) {
        bool wanted_thinking = ds4_think_mode_enabled(think) && !strstr(payload, "</think>");
        snprintf(name, sizeof(name), "%s/thinking-state", label);
        check(name, agent_compact_thinking_at(w, start, cut) == wanted_thinking);
    }
    ds4_tokens prompt = {0}; agent_tokens_append_range(&prompt, &w->transcript, 0, cut);
    bool closed = agent_compact_close_summary_prefix(w, &prompt, cut, sys_len);
    char *private_prompt = render(w->engine, &prompt, NULL);
    const char *closing = laguna ? (expected == AGENT_COMPACT_USER ? "</user>\n" :
        expected == AGENT_COMPACT_TOOL ? "</tool_response>\n" : "</assistant>\n") : "<|im_end|>\n";
    size_t n = strlen(private_prompt), c = strlen(closing);
    snprintf(name, sizeof(name), "%s/private-summary-closed", label);
    check(name, closed && n >= c && !strcmp(private_prompt + n-c, closing));
    if (expected == AGENT_COMPACT_TOOL && !laguna) {
        snprintf(name, sizeof(name), "%s/tool-inner-wrapper-closed", label);
        check(name, strstr(private_prompt, "</tool_response><|im_end|>") != NULL);
    }
    if (expected != AGENT_COMPACT_ASSISTANT) {
        ds4_tokens_free(&prompt); ds4_tokens_copy(&prompt, &w->transcript);
        closed = agent_compact_close_summary_prefix(w, &prompt, bottom, sys_len);
        snprintf(name, sizeof(name), "%s/complete-message-no-extra-close", label);
        check(name, closed && prompt.len == bottom);
    }
    free(private_prompt); free(tail); free(offsets); free(text);
    ds4_tokens_free(&prompt); ds4_tokens_free(&rebuilt);
}
int main(int argc, char **argv) {
    assert(argc == 2);
    ds4_engine *engine = dstudio_test_tokenizer_open(argv[1]); assert(engine);
    agent_config cfg = {.gen = {.ctx_size = 4096, .think_mode = DS4_THINK_NONE}};
    agent_worker w = {.engine = engine, .cfg = &cfg, .wake_fd = {-1, -1}};
    assert(!pthread_mutex_init(&w.mu, NULL)); assert(!pthread_cond_init(&w.cond, NULL));
    const char *plain = "You must preserve the original bytes. Café 日本語. RETAINED_FRAGMENT is unfinished.";
    message_case(&w, "user", AGENT_COMPACT_USER, plain, DS4_THINK_NONE, "user-bpe");
    message_case(&w, "tool", AGENT_COMPACT_TOOL, plain, DS4_THINK_NONE, "tool-bpe");
    message_case(&w, "assistant", AGENT_COMPACT_ASSISTANT, plain, DS4_THINK_NONE, "answer");
    message_case(&w, "assistant", AGENT_COMPACT_ASSISTANT, plain, DS4_THINK_HIGH, "thinking");
    message_case(&w, "assistant", AGENT_COMPACT_ASSISTANT,
        "Consider source only.</think> RETAINED_FRAGMENT must remain visible.", DS4_THINK_HIGH, "thinking-ended");
    message_case(&w, "tool", AGENT_COMPACT_TOOL,
        "Literal <user> is file content, not a new role. RETAINED_FRAGMENT belongs to the tool.",
        DS4_THINK_NONE, "literal-user-in-tool");
    message_case(&w, "tool", AGENT_COMPACT_TOOL,
        "Literal </tool_response> is escaped by the native encoder. RETAINED_FRAGMENT still belongs to the tool.",
        DS4_THINK_NONE, "escaped-close-in-tool");
    int sys_len; reset(&w, &sys_len);
    const int user_start = w.transcript.len;
    ds4_chat_append_message(engine, &w.transcript, "user", "Keep the user's exact requirements.");
    ds4_chat_append_assistant_prefix(engine, &w.transcript, DS4_THINK_NONE);
    ds4_tokenize_rendered_chat(engine, "Working.", &w.transcript);
    agent_worker_append_assistant_turn_end(&w);
    ds4_chat_append_message(engine, &w.transcript, "tool", "A later tool result.");
    check("complete-user-before-tool-tail", agent_compact_tail_start(&w, w.transcript.len, sys_len) == user_start);
    ds4_tokens_free(&w.transcript); free(w.out);
    pthread_mutex_destroy(&w.mu); pthread_cond_destroy(&w.cond);
    dstudio_test_tokenizer_close(engine);
    printf("{\"case\":\"total\",\"passed\":%s,\"checks\":%d,\"failed\":%d}\n",
           failures ? "false" : "true", checks, failures);
    return failures ? 1 : 0;
}

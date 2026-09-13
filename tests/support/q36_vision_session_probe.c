/* Real PNG -> native projector -> image spans -> Metal language model.
 * Expected pixel answers live in the independent test driver. No HTTP adapter
 * or app integration is claimed; this qualifies their native prerequisite. */
#include "q36.h"
#include <math.h>
#include <stdlib.h>
#include <string.h>

static int checks, failures;
#define CHECK(value) do { checks++; if (!(value)) { failures++; \
    fprintf(stderr, "FAIL line %d: %s\n", __LINE__, #value); } } while (0)

static bool finite_logits(q36_session *session) {
    int count = 0;
    const float *logits = q36_session_logits(session, &count);
    if (!logits || count <= 0 || count > 524288) return false;
    for (int i = 0; i < count; i++) if (!isfinite(logits[i])) return false;
    return true;
}

static bool already_cancelled(void *ud) { (*(int *)ud)++; return true; }

static void cancelled_sync(q36_session *session, const q36_tokens *prompt,
                           const q36_vision_span *span, unsigned index) {
    int vocab = 0, visits = 0, before_failures = failures;
    const float *logits = q36_session_logits(session, &vocab);
    int old_pos = q36_session_pos(session);
    bool old_vision = q36_session_has_vision_state(session);
    q36_tokens saved_tokens = {0};
    q36_tokens_copy(&saved_tokens, q36_session_tokens(session));
    CHECK(logits && vocab > 0 && vocab <= 524288 && old_pos > 0);
    if (failures != before_failures) {q36_tokens_free(&saved_tokens); return;}
    float *saved = malloc((size_t)vocab * sizeof(float));
    CHECK(saved);
    if (!saved) {q36_tokens_free(&saved_tokens); return;}
    memcpy(saved, logits, (size_t)vocab * sizeof(float));
    char error[256] = {0};
    q36_session_set_cancel(session, already_cancelled, &visits);
    int result = span ? q36_session_sync_vision(session, prompt, span, 1, error, sizeof error) :
                        q36_session_sync(session, prompt, error, sizeof error);
    q36_session_set_cancel(session, NULL, NULL);
    CHECK(result == Q36_SESSION_SYNC_INTERRUPTED && visits == 1);
    const q36_tokens *after_tokens = q36_session_tokens(session);
    CHECK(after_tokens && after_tokens->len == saved_tokens.len &&
          !memcmp(after_tokens->v, saved_tokens.v, (size_t)saved_tokens.len * sizeof(int)));
    CHECK(q36_session_pos(session) == old_pos && q36_session_has_vision_state(session) == old_vision);
    int after_vocab = 0;
    const float *after = q36_session_logits(session, &after_vocab);
    CHECK(after && after_vocab == vocab && !memcmp(saved, after, (size_t)vocab * sizeof(float)));
    printf("{\"case\":%u,\"kind\":\"preCancelledSync\",\"imageRequest\":%s,\"previousVision\":%s,\"previousTokens\":%d,\"result\":%d,\"preserved\":%s}\n",
        index, span ? "true" : "false", old_vision ? "true" : "false", old_pos, result,
        failures == before_failures ? "true" : "false");
    fflush(stdout);
    free(saved); q36_tokens_free(&saved_tokens);
}

static bool generate(q36_engine *engine, q36_session *session, unsigned index, const char *kind) {
    char error[256] = {0}, text[4096];
    size_t used = 0;
    int count = 0;
    bool eos = false, finite = true;
    for (; count < 32; count++) {
        finite = finite && finite_logits(session);
        if (!finite) break;
        int token = q36_session_argmax(session);
        if (token == q36_token_eos(engine)) { eos = true; break; }
        if (token < 0 || token >= q36_engine_vocab_size(engine)) break;
        size_t bytes = 0;
        char *piece = q36_token_text(engine, token, &bytes);
        if (!piece || bytes > sizeof(text) - used) { free(piece); break; }
        memcpy(text + used, piece, bytes); used += bytes; free(piece);
        if (q36_session_eval(session, token, error, sizeof(error))) break;
    }
    printf("{\"case\":%u,\"kind\":\"%s\",\"tokens\":%d,\"eos\":%s,\"finite\":%s,\"textHex\":\"",
           index, kind, count, eos ? "true" : "false", finite ? "true" : "false");
    for (size_t i = 0; i < used; i++) printf("%02x", (unsigned char)text[i]);
    printf("\"}\n"); fflush(stdout);
    return eos && finite && !error[0];
}

static void image_case(q36_engine *engine, const char *file, unsigned index) {
    q36_vision_embedding embedding = {0};
    q36_vision_span span = {0};
    q36_tokens prompt = {0}, text_prompt = {0}, cancelled_prompt = {0};
    q36_session *session = NULL;
    char error[256] = {0};
    int before_failures = failures;
    fprintf(stderr, "Native image session case %u\n", index);
    int ok = q36_engine_vision_encode_file(engine, file, &embedding, error, sizeof(error));
    CHECK(ok);
    if (!ok) goto done;
    CHECK(embedding.data && embedding.token_count && embedding.width == 128 && embedding.height == 128);
    CHECK(embedding.grid_width * embedding.grid_height == embedding.token_count);
    if (failures != before_failures) goto done;
    size_t values = (size_t)embedding.token_count * (size_t)q36_qwen35_n_embd();
    for (size_t i = 0; i < values; i++) CHECK(isfinite(embedding.data[i]));
    q36_chat_begin(engine, &prompt);
    const char *question = index == 2 ?
        "This image has two colored halves. What color is the LEFT half and what color is the RIGHT half? Reply only with the two basic English color names, lowercase, separated by a comma, with no explanation." :
        "What is the color of this image? Reply only with one basic English color name in lowercase, with no explanation.";
    ok = q36_chat_append_vision_message(engine, &prompt, "user", question, &span, &embedding, error, sizeof(error));
    CHECK(ok && !embedding.data);
    if (!ok) goto done;
    q36_chat_append_assistant_prefix(engine, &prompt, Q36_THINK_NONE);
    CHECK(q36_session_create(&session, engine, 8192) == 0);
    if (!session) goto done;

    q36_encode_chat_prompt(engine, "", "What is 6 + 8? Reply with only the integer.", Q36_THINK_NONE, &text_prompt);
    CHECK(q36_session_sync(session, &text_prompt, error, sizeof(error)) == 0);
    CHECK(!q36_session_has_vision_state(session));
    int vocab = 0, old_pos = q36_session_pos(session);
    const float *old_logits = q36_session_logits(session, &vocab);
    float *saved = vocab > 0 && vocab <= 524288 ? malloc((size_t)vocab * sizeof(float)) : NULL;
    CHECK(old_logits && saved);
    if (!saved || !old_logits) {free(saved); goto done;}
    memcpy(saved, old_logits, (size_t)vocab * sizeof(float));
    q36_vision_span invalid = span;
    invalid.token_start = UINT32_MAX;
    CHECK(q36_session_sync_vision(session, &prompt, &invalid, 1, error, sizeof(error)) != 0);
    CHECK(q36_session_pos(session) == old_pos && !q36_session_has_vision_state(session));
    int after_vocab = 0;
    const float *after = q36_session_logits(session, &after_vocab);
    CHECK(after && after_vocab == vocab && !memcmp(saved, after, (size_t)vocab * sizeof(float)));
    free(saved);
    error[0] = 0;

    if (index == 0) {
        q36_encode_chat_prompt(engine, "", "What is 9 + 2? Reply only with the integer.", Q36_THINK_NONE, &cancelled_prompt);
        cancelled_sync(session, &cancelled_prompt, NULL, index);
    }
    if (index == 1) cancelled_sync(session, &prompt, &span, index);

    ok = q36_session_sync_vision(session, &prompt, &span, 1, error, sizeof(error));
    CHECK(ok == 0);
    if (ok) goto done;
    CHECK(q36_session_has_vision_state(session) && q36_session_pos(session) == prompt.len);
    printf("{\"case\":%u,\"kind\":\"imageSpan\",\"imageTokens\":%u,\"tokenStart\":%u,\"promptTokens\":%d,\"width\":%u,\"height\":%u}\n",
           index, span.embedding.token_count, span.token_start, prompt.len, span.embedding.width, span.embedding.height);
    fflush(stdout);
    CHECK(generate(engine, session, index, "imageAnswer"));

    if (index == 2) cancelled_sync(session, &text_prompt, NULL, index);
    if (index == 3) cancelled_sync(session, &prompt, &span, index);

    /* Same session, new text-only prompt. An old image must not remain
     * authoritative merely because its KV slots were populated earlier. */
    error[0] = 0;
    CHECK(q36_session_sync(session, &text_prompt, error, sizeof(error)) == 0);
    CHECK(!q36_session_has_vision_state(session) && q36_session_pos(session) == text_prompt.len);
    CHECK(generate(engine, session, index, "textRecovery"));
done:
    if (error[0]) fprintf(stderr, "case %u: %s\n", index, error);
    q36_session_free(session);
    q36_tokens_free(&prompt); q36_tokens_free(&text_prompt); q36_tokens_free(&cancelled_prompt);
    q36_vision_embedding_free(&span.embedding); q36_vision_embedding_free(&embedding);
}

int main(int argc, char **argv) {
    if (argc != 7) { fprintf(stderr, "Supply pinned LLM/projector and four PNG paths\n"); return 2; }
    q36_engine_options options = {.model_path = argv[1], .vision_path = argv[2],
        .backend = Q36_BACKEND_METAL, .n_threads = 4, .prefill_chunk = 128,
        .quality = true, .cache_type_k = Q36_KV_CACHE_F16, .cache_type_v = Q36_KV_CACHE_F16};
    q36_engine *engine = NULL;
    if (q36_engine_open(&engine, &options)) return 2;
    CHECK(!strcmp(q36_engine_model_name(engine), "qwen3.8-27b") && q36_engine_has_vision(engine));
    CHECK(q36_qwen35_n_embd() == 5120);
    if (!failures) for (unsigned index = 0; index < 4; index++) image_case(engine, argv[index + 3], index);
    q36_engine_close(engine);
    printf("{\"kind\":\"summary\",\"checks\":%d,\"failures\":%d}\n", checks, failures);
    return failures ? 1 : 0;
}

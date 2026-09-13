/* Real HTTP request rendering and native CPU/Metal inference. The reference
 * is q36's CPU path, not an independent model implementation. No server starts.
 * Keep semantic answer correctness separate from numerical agreement. */
#define main dstudio_unused_q36_server_main
#include "q36_server.c"
#undef main
#include <math.h>

enum { PROBE_STEPS = 4, PROBE_TOP = 64, PROBE_VOCAB_LIMIT = 524288 };

static void token_hex(q36_engine *engine, int token) {
    size_t length = 0;
    char *piece = q36_token_text(engine, token, &length);
    printf("\"");
    for (size_t i = 0; piece && i < length; i++) printf("%02x", (unsigned char)piece[i]);
    printf("\"");
    free(piece);
}

static bool finite_logits(const float *logits, int count) {
    if (!logits || count <= 0 || count > PROBE_VOCAB_LIMIT) return false;
    for (int i = 0; i < count; i++) if (!isfinite(logits[i])) return false;
    return true;
}

static int overlap(const q36_token_score *a, const q36_token_score *b, int count) {
    int matches = 0;
    for (int i = 0; i < count; i++) for (int j = 0; j < count; j++) {
        if (a[i].id == b[j].id) { matches++; break; }
    }
    return matches;
}

int main(int argc, char **argv) {
    if (argc != 3) { fprintf(stderr, "Expected model and bounded JSON request file\n"); return 2; }
    FILE *file = fopen(argv[2], "rb");
    if (!file) return 2;
    char body[65537];
    size_t bytes = fread(body, 1, sizeof(body), file);
    bool file_ok = !ferror(file) && bytes > 0 && bytes < sizeof(body);
    fclose(file);
    if (!file_ok || memchr(body, 0, bytes)) return 2;
    body[bytes] = 0;

    q36_engine_options options = {.model_path = argv[1], .backend = Q36_BACKEND_CPU,
        .n_threads = 8, .prefill_chunk = 512, .quality = true,
        .cache_type_k = Q36_KV_CACHE_F16, .cache_type_v = Q36_KV_CACHE_F16};
    q36_engine *engine = NULL;
    q36_session *session = NULL;
    request req = {0};
    q36_tokens prompt = {0};
    float *reference[PROBE_STEPS] = {0};
    int tokens[PROBE_STEPS] = {0};
    q36_token_score ranked[PROBE_STEPS][PROBE_TOP];
    int steps = 0, vocab = 0, result = 1;
    char error[256] = {0};
    bool agreement = true;

    for (int phase = 0; phase < 2; phase++) {
        options.backend = phase ? Q36_BACKEND_METAL : Q36_BACKEND_CPU;
        const char *name = phase ? "metal" : "cpu";
        fprintf(stderr, "Native %s request replay\n", name);
        if (q36_engine_open(&engine, &options)) goto done;
        if (strcmp(q36_engine_model_name(engine), "qwen3.8-27b")) goto done;
        if (!parse_chat_request(engine, NULL, body, 256, 8192, &req, error, sizeof(error))) goto done;
        if (req.think_mode != Q36_THINK_NONE || req.temperature != 0 || req.has_tools) {
            snprintf(error, sizeof(error), "Expected deterministic, non-thinking, tool-free request");
            goto done;
        }
        if (!phase) q36_tokens_copy(&prompt, &req.prompt);
        else if (prompt.len != req.prompt.len ||
                 memcmp(prompt.v, req.prompt.v, (size_t)prompt.len * sizeof(int))) {
            snprintf(error, sizeof(error), "CPU and Metal rendered different prompt tokens");
            goto done;
        }
        printf("{\"phase\":\"%s\",\"promptTokens\":[", name);
        for (int i = 0; i < req.prompt.len; i++) printf("%s%d", i ? "," : "", req.prompt.v[i]);
        printf("]}\n"); fflush(stdout);
        if (q36_session_create(&session, engine, 8192) ||
            q36_session_sync(session, &req.prompt, error, sizeof(error))) goto done;

        for (int step = 0; step < (phase ? steps : PROBE_STEPS); step++) {
            int count = 0;
            const float *logits = q36_session_logits(session, &count);
            if (!finite_logits(logits, count)) { snprintf(error, sizeof(error), "Nonfinite logits"); goto done; }
            int token = q36_session_argmax(session);
            q36_token_score top[PROBE_TOP];
            if (token < 0 || token >= count || q36_session_top_logprobs(session, top, PROBE_TOP) != PROBE_TOP) goto done;
            printf("{\"phase\":\"%s\",\"step\":%d,\"argmax\":%d,\"tokenHex\":", name, step, token);
            token_hex(engine, token);
            printf(",\"eos\":%s,\"vocab\":%d,\"finite\":true", token == q36_token_eos(engine) ? "true" : "false", count);
            if (!phase) {
                if (!vocab) vocab = count;
                if (vocab != count) goto done;
                reference[step] = malloc((size_t)count * sizeof(float));
                if (!reference[step]) goto done;
                memcpy(reference[step], logits, (size_t)count * sizeof(float));
                memcpy(ranked[step], top, sizeof(top));
                tokens[step] = token;
                steps++;
            } else {
                if (count != vocab) goto done;
                double square = 0, maximum = 0, top20_max = 0;
                for (int i = 0; i < count; i++) {
                    double difference = (double)logits[i] - reference[step][i];
                    square += difference * difference;
                    if (fabs(difference) > maximum) maximum = fabs(difference);
                }
                for (int i = 0; i < 20; i++) {
                    int id = ranked[step][i].id;
                    double difference = fabs((double)logits[id] - reference[step][id]);
                    if (difference > top20_max) top20_max = difference;
                }
                int top5 = overlap(ranked[step], top, 5), top20 = overlap(ranked[step], top, 20);
                int top64 = overlap(ranked[step], top, 64);
                /* Same strict distribution criteria as the pinned upstream
                 * CPU/GPU gate. No claim of byte-exact numerical equivalence. */
                bool matched = token == tokens[step] && top5 >= 4 && top20 >= 15 &&
                               top64 >= 40 && top20_max <= 8.0;
                agreement = agreement && matched;
                printf(",\"referenceArgmax\":%d,\"top5Overlap\":%d,\"top20Overlap\":%d,"
                       "\"top64Overlap\":%d,\"rms\":%.9g,\"maxAbsolute\":%.9g,"
                       "\"top20MaxAbsolute\":%.9g,\"matched\":%s",
                       tokens[step], top5, top20, top64, sqrt(square / count), maximum,
                       top20_max, matched ? "true" : "false");
            }
            printf("}\n"); fflush(stdout);
            /* Teacher-force the reference token on the candidate even on a
             * mismatch: subsequent comparisons must share the exact prefix. */
            int next = phase ? tokens[step] : token;
            if (next == q36_token_eos(engine) || step + 1 >= (phase ? steps : PROBE_STEPS)) break;
            if (q36_session_eval(session, next, error, sizeof(error))) goto done;
        }
        q36_session_free(session); session = NULL;
        request_free(&req); memset(&req, 0, sizeof(req));
        q36_engine_close(engine); engine = NULL;
    }
    result = agreement && steps > 0 ? 0 : 1;
done:
    q36_session_free(session);
    request_free(&req);
    q36_engine_close(engine);
    q36_tokens_free(&prompt);
    for (int i = 0; i < PROBE_STEPS; i++) free(reference[i]);
    if (result) fprintf(stderr, "Request parity failed: %s\n", error[0] ? error : "numerical comparison or native operation");
    return result;
}

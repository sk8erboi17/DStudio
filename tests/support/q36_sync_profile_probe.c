/* A bounded replay of an actual recorded request through the native renderer
 * and Metal core. Eight greedy steps isolate calculation cost; they do NOT
 * replace the original sampling/tool loop or qualify answer correctness. */
#define main dstudio_unused_q36_server_main
#include "q36_server.c"
#undef main
#include <math.h>
#include <CommonCrypto/CommonDigest.h>

#ifdef DSTUDIO_Q36_SYNC_PROFILE
void dstudio_q36_sync_begin(void);
void dstudio_q36_sync_end(const char *phase);
#else
static void dstudio_q36_sync_begin(void) {}
static void dstudio_q36_sync_end(const char *phase) { (void)phase; }
#endif

int main(int argc, char **argv) {
    if (argc != 3) return 2;
    FILE *file = fopen(argv[2], "rb");
    if (!file) return 2;
    char body[65537];
    size_t bytes = fread(body, 1, sizeof(body), file);
    bool valid = !ferror(file) && bytes && bytes < sizeof(body) && !memchr(body, 0, bytes);
    fclose(file);
    if (!valid) return 2;
    body[bytes] = 0;
    q36_engine_options options = {.model_path = argv[1], .backend = Q36_BACKEND_METAL,
        .prefill_chunk = 128, .quality = true,
        .cache_type_k = Q36_KV_CACHE_F16, .cache_type_v = Q36_KV_CACHE_F16};
    q36_engine *engine = NULL;
    q36_session *session = NULL;
    request req = {0};
    char error[256] = {0};
    int result = 1;
    if (q36_engine_open(&engine, &options)) goto done;
    if (strcmp(q36_engine_model_name(engine), "qwen3.8-27b")) goto done;
    if (!parse_chat_request(engine, NULL, body, 256, 8192, &req, error, sizeof(error))) goto done;
    if (req.think_mode != Q36_THINK_NONE || (req.images && req.images->len) || req.prompt.len > 8000) goto done;
    printf("{\"kind\":\"prompt\",\"tokens\":[");
    for (int i = 0; i < req.prompt.len; i++) printf("%s%d", i ? "," : "", req.prompt.v[i]);
    puts("]}"); fflush(stdout);
    if (q36_session_create(&session, engine, 8192)) goto done;
    dstudio_q36_sync_begin();
    double started = now_sec();
    int sync_result = q36_session_sync(session, &req.prompt, error, sizeof(error));
    printf("{\"kind\":\"phase\",\"phase\":\"prefill\",\"elapsedMs\":%.6f,\"ok\":%s}\n",
           (now_sec() - started) * 1000, sync_result ? "false" : "true");
    dstudio_q36_sync_end("prefill");
    if (sync_result) goto done;
    dstudio_q36_sync_begin();
    started = now_sec();
    for (int step = 0; step < 8; step++) {
        int count = 0;
        const float *logits = q36_session_logits(session, &count);
        if (!logits || count < 1 || count > 524288) goto done;
        for (int i = 0; i < count; i++) if (!isfinite(logits[i])) goto done;
        /* Preserve every logit bit in a bounded digest. The independent runner
         * compares the uninstrumented replay, not the model's self-assessment. */
        unsigned char digest[CC_SHA256_DIGEST_LENGTH];
        CC_SHA256(logits, (CC_LONG)((size_t)count * sizeof(float)), digest);
        int token = q36_session_argmax(session);
        bool eos = token == q36_token_eos(engine);
        printf("{\"kind\":\"step\",\"step\":%d,\"argmax\":%d,\"vocab\":%d,"
               "\"finite\":true,\"logitsSHA256\":\"", step, token, count);
        for (unsigned i = 0; i < sizeof(digest); i++) printf("%02x", digest[i]);
        printf("\",\"eos\":%s}\n", eos ? "true" : "false");
        fflush(stdout);
        if (eos || step == 7) break;
        if (q36_session_eval(session, token, error, sizeof(error))) goto done;
    }
    printf("{\"kind\":\"phase\",\"phase\":\"decode\",\"elapsedMs\":%.6f,\"ok\":true}\n", (now_sec() - started) * 1000);
    dstudio_q36_sync_end("decode");
    result = 0;
done:
    q36_session_free(session);
    request_free(&req);
    q36_engine_close(engine);
    if (result) fprintf(stderr, "Native diagnostic failed: %s\n", error);
    return result;
}

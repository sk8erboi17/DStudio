/* Real native text prefill. The direct build reproduces the old in-place
 * behavior; the candidate build must preserve the source and exactly match
 * a normal, separately prepared native session. This is not model quality. */
#include "q36.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include <time.h>

typedef struct {
    q36_session *source;
    int source_pos, chunks, changed_during_prepare, cancel_at;
    bool cancelled;
} probe_progress;

static bool cancel_probe(void *ud) { return ((probe_progress *)ud)->cancelled; }
#ifdef DSTUDIO_Q36_SCHEDULED
/* A single-owner scheduling fixture for native numerical parity; the real
 * server's independent-slot scheduling is covered separately. */
static bool device_owned;
static int device_enter(void *ud) {(void)ud; if (device_owned) return 1; device_owned = true; return 0;}
static void device_leave(void *ud) {(void)ud; if (!device_owned) abort(); device_owned = false;}
static const q36_payload_device_access access = {device_enter, device_leave, NULL, NULL};
#endif
static void progress_probe(void *ud, const char *phase, int done, int total) {
    probe_progress *p = ud;
    if (strcmp(phase, "prefill_chunk")) return;
    p->chunks++;
    if (q36_session_pos(p->source) != p->source_pos) p->changed_during_prepare++;
    if ((p->cancel_at == 1 && done < total) || (p->cancel_at == 2 && done == total))
        p->cancelled = true;
}

static char *payload(q36_session *s, size_t *bytes) {
    char error[256], *data = NULL;
    uint64_t expected = q36_session_payload_bytes(s);
    if (!expected || expected > 512u * 1024u * 1024u) return NULL;
    FILE *fp = open_memstream(&data, bytes);
    if (!fp) return NULL;
    int rc = q36_session_save_payload(s, fp, error, sizeof error);
    if (fclose(fp) || rc || *bytes != expected) { free(data); return NULL; }
    return data;
}

static bool equal_state(q36_session *a, q36_session *b) {
    size_t na = 0, nb = 0;
    char *pa = payload(a, &na), *pb = payload(b, &nb);
    bool ok = pa && pb && na == nb && !memcmp(pa, pb, na);
    free(pa); free(pb);
    int va = 0, vb = 0;
    const float *la = q36_session_logits(a, &va), *lb = q36_session_logits(b, &vb);
    if (!la || !lb || va != vb || va <= 0) return false;
    for (int i = 0; i < va; i++) if (!isfinite(la[i]) || !isfinite(lb[i])) return false;
    return ok && !memcmp(la, lb, (size_t)va * sizeof(float));
}

typedef struct {FILE *fp; size_t at;} payload_cancel;
static bool cancel_read(void *ud) {
    payload_cancel *p = ud;
    off_t at = ftello(p->fp);
    return at < 0 || (p->at != SIZE_MAX && (uint64_t)at >= p->at);
}

static int payload_checks(q36_engine *engine, const q36_tokens *anchor, const q36_tokens *changed) {
    q36_session *target = NULL;
    char error[256] = {0}; size_t bytes = 0;
    if (q36_session_create(&target, engine, 4096) || q36_session_sync(target, changed, error, sizeof error)) return 6;
    char *saved = payload(target, &bytes);
    q36_session_snapshot legacy = {0};
    if (!saved || q36_session_save_snapshot(target, &legacy, error, sizeof error)) {
        free(saved); q36_session_free(target); return 6;
    }
    q36_session_free(target);
    const char *names[] = {"payload pre-cancel", "payload cancel during logits read",
        "payload last byte missing", "payload cancel at final byte", "full native payload restore",
        "legacy token-only native replay"};
    int failures = 0;
    for (int index = 0; index < 6; index++) {
        q36_session *source = NULL, *candidate = NULL, *reference = NULL;
        if (q36_session_create(&source, engine, 4096) || q36_session_sync(source, anchor, error, sizeof error)) return 6;
        size_t before_bytes = 0, after_bytes = 0;
        char *before = payload(source, &before_bytes);
        size_t declared = index == 5 ? (size_t)legacy.len : bytes;
        FILE *fp = fmemopen(index == 5 ? legacy.ptr : (void *)saved, declared - (index == 2 ? 1 : 0), "rb");
        if (!fp) return 6;
        payload_cancel p = {.fp = fp, .at = index == 0 ? 0 : index == 1 ? 65537 : index == 3 ? declared : SIZE_MAX};
        struct timespec start, end; clock_gettime(CLOCK_MONOTONIC, &start);
#ifdef DSTUDIO_Q36_DIRECT_BASELINE
        q36_session_set_cancel(source, cancel_read, &p);
        int rc = q36_session_load_payload(source, fp, declared, error, sizeof error);
        q36_session_set_cancel(source, NULL, NULL);
        if (!rc) candidate = source;
#elif defined(DSTUDIO_Q36_SCHEDULED)
        int rc = q36_session_prepare_load_payload_scheduled(&candidate, source, fp, declared,
            cancel_read, &p, &access, error, sizeof error);
#else
        int rc = q36_session_prepare_load_payload(&candidate, source, fp, declared, cancel_read, &p, error, sizeof error);
#endif
        clock_gettime(CLOCK_MONOTONIC, &end);
        off_t read_bytes = ftello(fp); fclose(fp);
        char *after = payload(source, &after_bytes);
        bool preserved = before && after && before_bytes == after_bytes && !memcmp(before, after, before_bytes);
        free(before); free(after);
        bool result = index < 4 ? !candidate && (index == 2 ? rc != 0 : rc == Q36_SESSION_SYNC_INTERRUPTED) : rc == 0 && candidate;
        if (index == 0) result = result && read_bytes == 0;
        if (index == 1) result = result && read_bytes <= 65537 + 65536;
        q36_session *continued = index < 4 ? source : candidate;
        bool parity = continued && q36_session_create(&reference, engine, 4096) == 0 &&
            q36_session_sync(reference, index < 4 ? anchor : changed, error, sizeof error) == 0 && equal_state(continued, reference);
        int decoded = 0;
        for (int step = 0; parity && step < 4; step++) {
            int token = q36_session_argmax(reference);
            parity = token >= 0 && token == q36_session_argmax(continued) &&
                q36_session_eval(reference, token, error, sizeof error) == 0 &&
                q36_session_eval(continued, token, error, sizeof error) == 0 && equal_state(continued, reference);
            if (parity) decoded++;
        }
        bool passed = result && preserved && parity;
        failures += !passed;
        printf("{\"kind\":\"payload-case\",\"id\":%d,\"name\":\"%s\",\"passed\":%s,"
               "\"sourcePreserved\":%s,\"nativeParity\":%s,\"rc\":%d,\"decodeChecks\":%d,"
               "\"declaredBytes\":%zu,\"readBytes\":%lld,\"seconds\":%.6f}\n",
               index, names[index], passed ? "true" : "false", preserved ? "true" : "false",
               parity ? "true" : "false", rc, decoded, declared, (long long)read_bytes,
               end.tv_sec - start.tv_sec + (end.tv_nsec - start.tv_nsec) / 1e9);
        fflush(stdout);
        if (candidate != source) q36_session_free(candidate);
        q36_session_free(reference); q36_session_free(source);
    }
    free(saved); q36_session_snapshot_free(&legacy);
    return failures;
}

int main(int argc, char **argv) {
    if (argc != 2) return 2;
    q36_engine_options options = {.model_path = argv[1], .backend = Q36_BACKEND_METAL,
        .n_threads = 4, .prefill_chunk = 128, .quality = true,
        .cache_type_k = Q36_KV_CACHE_F16, .cache_type_v = Q36_KV_CACHE_F16};
    q36_engine *engine = NULL;
    if (q36_engine_open(&engine, &options)) return 2;
    q36_tokens anchor = {0}, changed = {0}, extended = {0};
    q36_tokenize_rendered_chat(engine, "The private conversation anchor is seven.\n", &anchor);
    for (int i = 0; i < 48; i++)
        q36_tokenize_rendered_chat(engine, "A separate sentence about blue stones.\n", &changed);
    q36_tokens_copy(&extended, &anchor);
    for (int i = 0; i < changed.len; i++) q36_tokens_push(&extended, changed.v[i]);
    if (anchor.len <= 0 || changed.len <= 256 || extended.len >= 4096) return 2;
    const char *names[] = {"pre-cancelled cache hit", "cancel replacement after first chunk",
        "cancel extension after first chunk", "cancel at final chunk",
        "replacement matches direct native sync", "extension matches direct native sync",
        "cache hit retains all state"};
    int failures = 0;
    for (int index = 0; index < 7; index++) {
        q36_session *source = NULL, *candidate = NULL, *reference = NULL;
        char error[256] = {0};
        bool ok = q36_session_create(&source, engine, 4096) == 0 &&
                  q36_session_sync(source, &anchor, error, sizeof error) == 0;
        if (!ok) {fprintf(stderr, "source: %s\n", error); return 2;}
        const q36_tokens *target = index == 0 || index == 6 ? &anchor :
                                  index == 2 || index == 5 ? &extended : &changed;
        probe_progress p = {.source = source, .source_pos = anchor.len,
            .cancel_at = index == 1 || index == 2 ? 1 : index == 3 ? 2 : 0,
            .cancelled = index == 0};
        size_t before_bytes = 0, after_bytes = 0;
        char *before = payload(source, &before_bytes);
        struct timespec started, finished;
        clock_gettime(CLOCK_MONOTONIC, &started);
#ifdef DSTUDIO_Q36_DIRECT_BASELINE
        q36_session_set_progress(source, progress_probe, &p);
        q36_session_set_cancel(source, cancel_probe, &p);
        int rc = q36_session_sync(source, target, error, sizeof error);
        q36_session_set_progress(source, NULL, NULL);
        q36_session_set_cancel(source, NULL, NULL);
        if (!rc) candidate = source;
#elif defined(DSTUDIO_Q36_SCHEDULED)
        int rc = q36_session_fork_for_prompt_scheduled(&candidate, source, target,
            cancel_probe, &p, &access, error, sizeof error);
        if (!rc) {
            q36_session_set_progress(candidate, progress_probe, &p);
            q36_session_set_cancel(candidate, cancel_probe, &p);
            rc = q36_session_sync_prefix_scheduled(candidate, target, &access, error, sizeof error);
            q36_session_set_progress(candidate, NULL, NULL);
            q36_session_set_cancel(candidate, NULL, NULL);
            if (rc) {q36_session_free(candidate); candidate = NULL;}
        }
        if (device_owned) abort();
#else
        int rc = q36_session_prepare_sync(&candidate, source, target,
            progress_probe, &p, cancel_probe, &p, error, sizeof error);
#endif
        clock_gettime(CLOCK_MONOTONIC, &finished);
        char *after = payload(source, &after_bytes);
        bool preserved = before && after && before_bytes == after_bytes &&
                         !memcmp(before, after, before_bytes) && !p.changed_during_prepare;
        free(before); free(after);
        bool cancelled = index < 4;
        bool result_ok = cancelled ? rc == Q36_SESSION_SYNC_INTERRUPTED && !candidate : rc == 0 && candidate;
        bool parity = false;
        int decode_checks = 0;
        q36_session *continued = cancelled ? source : candidate;
        if (continued && q36_session_create(&reference, engine, 4096) == 0) {
            ok = q36_session_sync(reference, &anchor, error, sizeof error) == 0;
            if (!cancelled) ok = ok && q36_session_sync(reference, target, error, sizeof error) == 0;
            parity = ok && equal_state(continued, reference);
            for (int step = 0; parity && step < 4; step++) {
                int token = q36_session_argmax(reference);
                parity = token >= 0 && token == q36_session_argmax(continued) &&
                    q36_session_eval(reference, token, error, sizeof error) == 0 &&
                    q36_session_eval(continued, token, error, sizeof error) == 0 &&
                    equal_state(continued, reference);
                if (parity) decode_checks++;
            }
        }
        bool expected_chunks = index == 0 || index == 6 ? p.chunks == 0 :
                               index == 1 || index == 2 ? p.chunks == 1 : p.chunks >= 3;
        bool pass = result_ok && preserved && parity && expected_chunks;
        failures += !pass;
        double seconds = finished.tv_sec - started.tv_sec + (finished.tv_nsec - started.tv_nsec) / 1e9;
        printf("{\"kind\":\"case\",\"id\":%d,\"name\":\"%s\",\"passed\":%s,"
               "\"sourcePreserved\":%s,\"nativeParity\":%s,\"rc\":%d,\"chunks\":%d,"
               "\"decodeChecks\":%d,\"targetTokens\":%d,\"stateBytes\":%zu,\"seconds\":%.6f}\n",
               index, names[index], pass ? "true" : "false", preserved ? "true" : "false",
               parity ? "true" : "false", rc, p.chunks, decode_checks, target->len, before_bytes, seconds);
        fflush(stdout);
        if (candidate != source) q36_session_free(candidate);
        q36_session_free(reference); q36_session_free(source);
    }
    failures += payload_checks(engine, &anchor, &changed);
    q36_tokens_free(&anchor); q36_tokens_free(&changed); q36_tokens_free(&extended);
    q36_engine_close(engine);
    printf("{\"kind\":\"summary\",\"cases\":13,\"failures\":%d}\n", failures);
    return failures ? 1 : 0;
}

/* Production generate_job/cache/files/HTTP with a deliberately blocked native
 * worker. Numerical state-copy and actual inference have separate real-core
 * tests. No assertions on source text or timing used as an ownership oracle. */
#include "q36.h"
#include <assert.h>
#include <pthread.h>
#include <stdatomic.h>

static int probe_create(q36_session **, q36_engine *, int);
static void probe_free(q36_session *);
static int probe_ctx(q36_session *);
static int probe_pos(q36_session *);
static const q36_tokens *probe_tokens(q36_session *);
static int probe_common(q36_session *, const q36_tokens *);
static bool probe_vision(q36_session *);
static void probe_invalidate(q36_session *);
static void probe_progress(q36_session *, q36_session_progress_fn, void *);
static void probe_cancel(q36_session *, q36_session_cancel_fn, void *);
static int probe_sync(q36_session *, const q36_tokens *, char *, size_t);
static int probe_fork(q36_session **, const q36_session *, const q36_tokens *,
    q36_session_cancel_fn, void *, char *, size_t);
static int probe_prepare_sync(q36_session **, const q36_session *, const q36_tokens *,
    q36_session_progress_fn, void *, q36_session_cancel_fn, void *, char *, size_t);
#ifdef Q36_TEXT_SCHEDULE_API
static int probe_fork_scheduled(q36_session **, const q36_session *, const q36_tokens *,
    q36_session_cancel_fn, void *, const q36_payload_device_access *, char *, size_t);
static int probe_sync_scheduled(q36_session *, const q36_tokens *, const q36_payload_device_access *, char *, size_t);
#define q36_session_fork_for_prompt_scheduled probe_fork_scheduled
#define q36_session_sync_prefix_scheduled probe_sync_scheduled
#endif
static uint64_t probe_bytes(q36_session *);
static int probe_save(q36_session *, FILE *, char *, size_t);
#ifdef Q36_PAYLOAD_SCHEDULE_API
static int probe_save_scheduled(q36_session *, FILE *, const q36_payload_device_access *, char *, size_t);
#define q36_session_save_payload_scheduled probe_save_scheduled
#endif
static int probe_load(q36_session *, FILE *, uint64_t, char *, size_t);
static int probe_prepare_load(q36_session **, const q36_session *, FILE *, uint64_t,
    q36_session_cancel_fn, void *, char *, size_t);
#ifdef Q36_PAYLOAD_RESTORE_SCHEDULE_API
static int probe_prepare_load_scheduled(q36_session **, const q36_session *, FILE *, uint64_t,
    q36_session_cancel_fn, void *, const q36_payload_device_access *, char *, size_t);
#define q36_session_prepare_load_payload_scheduled probe_prepare_load_scheduled
#endif
static char *probe_text(q36_engine *, int, size_t *);
static void probe_tokenize(q36_engine *, const char *, q36_tokens *);
static int probe_quant(q36_engine *);
static int probe_rename(const char *, const char *);

#define q36_session_create probe_create
#define q36_session_free probe_free
#define q36_session_ctx probe_ctx
#define q36_session_pos probe_pos
#define q36_session_tokens probe_tokens
#define q36_session_common_prefix probe_common
#define q36_session_has_vision_state probe_vision
#define q36_session_invalidate probe_invalidate
#define q36_session_set_progress probe_progress
#define q36_session_set_cancel probe_cancel
#define q36_session_sync probe_sync
#define q36_session_fork_for_prompt probe_fork
#define q36_session_prepare_sync probe_prepare_sync
#define q36_session_payload_bytes probe_bytes
#define q36_session_save_payload probe_save
#define q36_session_load_payload probe_load
#define q36_session_prepare_load_payload probe_prepare_load
#define q36_token_text probe_text
#define q36_tokenize_rendered_chat probe_tokenize
#define q36_engine_routed_quant_bits probe_quant
#define rename probe_rename
#define Q36_SERVER_TEST
#define Q36_SERVER_TEST_NO_MAIN
#include "q36_server.c"
#undef rename

typedef struct {
    q36_tokens tokens;
    int ids[32], ctx;
    float logits[4];
    bool retired, vision;
    q36_session_progress_fn progress;
    q36_session_cancel_fn cancel;
    void *progress_ud, *cancel_ud;
} simulated_session;
static server srv;
static server_slot text_slots[2];
#define published text_slots[0]
static job active;
static simulated_session *allocated[12], *original, *replacement;
static unsigned allocations, syncs, reads, writes, failed_renames;
static void (*probe_save_pause)(void);
static void (*probe_load_pause)(void);
static atomic_uint failures, checks;
static int mode;
static bool running, reached, released, finished;
static char *tool_block_fixture;
static pthread_mutex_t barrier_mu = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t barrier_cv = PTHREAD_COND_INITIALIZER;
static void checked(bool ok, int line) {
    atomic_fetch_add(&checks, 1);
    if (!ok) {atomic_fetch_add(&failures, 1); fprintf(stderr, "mode=%d line=%d invariant failed\n", mode, line);}
}
#define CHECK(x) checked((x), __LINE__)
#ifdef DSTUDIO_Q36_CACHE_USAGE_TEST
static void check_usage_value(const char *wire, const char *key, int expected) {
    char field[96]; snprintf(field, sizeof field, "\"%s\":", key);
    const char *next = wire; unsigned count = 0;
    while ((next = strstr(next, field))) {
        next += strlen(field); char *end;
        long actual = strtol(next, &end, 10);
        CHECK(end != next && actual == expected);
        CHECK(*end == ',' || *end == '}' || *end == ']');
        next = end; count++;
    }
    CHECK(count > 0); /* Actual HTTP/SSE bytes, not request fields alone. */
}
#endif
static void outside_locks(void) {
    pthread_mutex_t *locks[] = {&srv.mu, &srv.kv_mu, &srv.tool_mu,
#ifndef Q36_PAYLOAD_RESTORE_SCHEDULE_API
        &srv.inference_mu,
#endif
    };
    for (unsigned i = 0; i < sizeof locks / sizeof *locks; i++) {
        int rc = pthread_mutex_trylock(locks[i]); CHECK(rc == 0);
        if (!rc) pthread_mutex_unlock(locks[i]);
    }
}
static simulated_session *new_session(void) {
    assert(allocations < sizeof allocated / sizeof *allocated);
    simulated_session *s = calloc(1, sizeof *s); assert(s);
    allocated[allocations++] = s;
    s->tokens.v = s->ids; s->tokens.cap = 32; s->ctx = 32;
    return s;
}
static void fill_state(simulated_session *s, int first, int count) {
    s->tokens.len = count;
    for (int i = 0; i < count; i++) s->ids[i] = first + i;
    for (int i = 0; i < 4; i++) s->logits[i] = (float)(first + count + i);
}
static int probe_create(q36_session **out, q36_engine *e, int ctx) {
    outside_locks(); CHECK(e == srv.engine && ctx == 32);
    if (running && mode == 5) return 1;
    *out = (q36_session *)new_session(); return 0;
}
static void probe_free(q36_session *session) {
    if (!session) return;
    outside_locks(); simulated_session *s = (simulated_session *)session;
    CHECK(!s->retired); CHECK(!s->cancel && !s->progress); s->retired = true;
    /* Retain only this bounded fixture allocation so the oracle can inspect
     * retirement without dereferencing freed memory. Freed at process cleanup. */
}
static int probe_ctx(q36_session *s) {return ((simulated_session *)s)->ctx;}
static int probe_pos(q36_session *s) {return ((simulated_session *)s)->tokens.len;}
static const q36_tokens *probe_tokens(q36_session *s) {return &((simulated_session *)s)->tokens;}
static bool probe_vision(q36_session *s) {return ((simulated_session *)s)->vision;}
static void probe_invalidate(q36_session *s) {((simulated_session *)s)->tokens.len = 0;}
static int probe_common(q36_session *s, const q36_tokens *p) {
    const q36_tokens *t = probe_tokens(s); int i = 0;
    while (i < t->len && i < p->len && t->v[i] == p->v[i]) i++;
    return i;
}
static void probe_progress(q36_session *session, q36_session_progress_fn fn, void *ud) {
    simulated_session *s = (simulated_session *)session; s->progress = fn; s->progress_ud = ud;
}
static void probe_cancel(q36_session *session, q36_session_cancel_fn fn, void *ud) {
    simulated_session *s = (simulated_session *)session; s->cancel = fn; s->cancel_ud = ud;
}
static void wait_at_preparation(void) {
    pthread_mutex_lock(&barrier_mu);
    if (!reached) {
        reached = true; pthread_cond_broadcast(&barrier_cv);
        while (!released) pthread_cond_wait(&barrier_cv, &barrier_mu);
    }
    pthread_mutex_unlock(&barrier_mu);
}
static int probe_fork(q36_session **out, const q36_session *source, const q36_tokens *p,
    q36_session_cancel_fn cancel, void *ud, char *err, size_t len) {
    (void)err; (void)len; outside_locks();
    if (cancel && cancel(ud)) return Q36_SESSION_SYNC_INTERRUPTED;
    q36_session *candidate = NULL;
    if (probe_create(&candidate, srv.engine, 32)) return 1;
    simulated_session *a = (simulated_session *)source, *b = (simulated_session *)candidate;
    if (!a->vision && probe_common((q36_session *)source, p) == a->tokens.len && p->len >= a->tokens.len) {
        b->tokens.len = a->tokens.len;
        memcpy(b->ids, a->ids, sizeof b->ids); memcpy(b->logits, a->logits, sizeof b->logits);
    }
    *out = candidate; return 0;
}
static int probe_sync(q36_session *session, const q36_tokens *p, char *err, size_t len) {
    outside_locks(); syncs++;
    simulated_session *s = (simulated_session *)session;
    if (s->cancel && s->cancel(s->cancel_ud)) return Q36_SESSION_SYNC_INTERRUPTED;
    int from = probe_common(session, p) == s->tokens.len ? s->tokens.len : 0;
    while (from < p->len) {
        int end = from + 4; if (end > p->len) end = p->len;
        memcpy(s->ids, p->v, (size_t)end * sizeof(int)); s->tokens.len = end;
        for (int i = 0; i < 4; i++) s->logits[i] = (float)(p->v[0] + end + i);
        if (s->progress) s->progress(s->progress_ud, "prefill_chunk", end, p->len);
        wait_at_preparation();
        if (s->cancel && s->cancel(s->cancel_ud)) return Q36_SESSION_SYNC_INTERRUPTED;
        if (mode == 1 || mode == 7 || mode == 18) {
            snprintf(err, len, "injected native prefill failure"); return 1;
        }
        from = end;
    }
    if (mode == 3 && p->len == 10) CHECK(server_cancel_request(&srv, active.request_id));
    if (mode == 15) s->ctx = 31;
    return 0;
}
static int probe_prepare_sync(q36_session **out, const q36_session *source, const q36_tokens *p,
    q36_session_progress_fn progress, void *progress_ud,
    q36_session_cancel_fn cancel, void *cancel_ud, char *err, size_t len) {
    q36_session *candidate = NULL;
    int rc = probe_fork(&candidate, source, p, cancel, cancel_ud, err, len);
    if (rc) return rc;
    probe_progress(candidate, progress, progress_ud); probe_cancel(candidate, cancel, cancel_ud);
    rc = probe_sync(candidate, p, err, len);
    probe_progress(candidate, NULL, NULL); probe_cancel(candidate, NULL, NULL);
    if (rc) probe_free(candidate); else *out = candidate;
    return rc;
}
static uint64_t probe_bytes(q36_session *s) {
    if (running && mode == 23) return 8ull * 1024 * 1024 * 1024;
    return 4 + 4ull * probe_pos(s) + 16;
}
#ifdef Q36_TEXT_SCHEDULE_API
static int probe_fork_scheduled(q36_session **out, const q36_session *source, const q36_tokens *prompt,
    q36_session_cancel_fn cancel, void *ud, const q36_payload_device_access *access, char *err, size_t len) {
    q36_session *candidate = NULL;
    int rc = probe_fork(&candidate, source, prompt, cancel, ud, err, len);
    if (rc) return rc;
    if (access) {
        rc = access->enter(access->userdata);
        if (!rc) {outside_locks(); CHECK(srv.model_busy); access->leave(access->userdata);}
    }
    if (!rc && cancel && cancel(ud)) rc = Q36_SESSION_SYNC_INTERRUPTED;
    if (rc) probe_free(candidate); else *out = candidate;
    return rc;
}
static int probe_sync_scheduled(q36_session *s, const q36_tokens *prompt,
    const q36_payload_device_access *access, char *err, size_t len) {
    int rc = access->enter(access->userdata); if (rc) return rc;
    CHECK(srv.model_busy); CHECK(s != (q36_session *)original);
    rc = probe_sync(s, prompt, err, len); access->leave(access->userdata); return rc;
}
#endif
static int probe_save(q36_session *session, FILE *fp, char *err, size_t len) {
    outside_locks(); writes++;
    if (probe_save_pause) probe_save_pause();
    if (running && mode == 12) {snprintf(err, len, "injected disk failure"); return 1;}
    simulated_session *s = (simulated_session *)session;
    uint8_t bytes[4 + 32 * 4 + 16]; le_put32(bytes, s->tokens.len);
    for (int i = 0; i < s->tokens.len; i++) le_put32(bytes + 4 + i * 4, s->ids[i]);
    memcpy(bytes + 4 + 4 * s->tokens.len, s->logits, 16);
    return fwrite(bytes, 1, (size_t)probe_bytes(session), fp) == probe_bytes(session) ? 0 : 1;
}
#ifdef Q36_PAYLOAD_SCHEDULE_API
static int probe_save_scheduled(q36_session *session, FILE *fp,
    const q36_payload_device_access *access, char *err, size_t len) {
    /* The numerical fixture borrows the actual server scheduler. Native GPU
     * readback/byte/cancel behavior has its own real-Metal gate. */
    if (access) {
        int rc = access->enter(access->userdata); if (rc) return rc;
        outside_locks(); CHECK(srv.model_busy);
        access->leave(access->userdata);
        if (access->cancelled && access->cancelled(access->userdata)) return Q36_SESSION_SYNC_INTERRUPTED;
    }
    return probe_save(session, fp, err, len);
}
#endif
static int probe_load(q36_session *session, FILE *fp, uint64_t bytes, char *err, size_t len) {
    (void)err; (void)len; outside_locks(); reads++;
    if (probe_load_pause) probe_load_pause();
    uint8_t buf[4 + 32 * 4 + 16];
    if (bytes > sizeof buf || bytes < 20 || fread(buf, 1, bytes, fp) != bytes) return 1;
    simulated_session *s = (simulated_session *)session;
    uint32_t n = le_get32(buf);
    if (n > 32 || 4ull + n * 4 + 16 != bytes) {s->tokens.len = 0; return 1;}
    s->tokens.len = n;
    for (uint32_t i = 0; i < n; i++) s->ids[i] = le_get32(buf + 4 + i * 4);
    memcpy(s->logits, buf + 4 + n * 4, 16); return 0;
}
static int probe_prepare_load(q36_session **out, const q36_session *source, FILE *fp, uint64_t bytes,
    q36_session_cancel_fn cancel, void *ud, char *err, size_t len) {
    CHECK(source == (q36_session *)original);
    q36_session *candidate = NULL;
    if (probe_create(&candidate, srv.engine, 32)) return 1;
    int rc = probe_load(candidate, fp, bytes, err, len);
    if (mode == 8) wait_at_preparation();
    if (cancel && cancel(ud)) rc = Q36_SESSION_SYNC_INTERRUPTED;
    if (rc) probe_free(candidate); else *out = candidate;
    return rc;
}
#ifdef Q36_PAYLOAD_RESTORE_SCHEDULE_API
static int probe_prepare_load_scheduled(q36_session **out, const q36_session *source, FILE *fp, uint64_t bytes,
    q36_session_cancel_fn cancel, void *ud, const q36_payload_device_access *access, char *err, size_t len) {
    q36_session *candidate = NULL;
    int rc = probe_prepare_load(&candidate, source, fp, bytes, cancel, ud, err, len);
    if (rc) return rc;
    if (access) {
        rc = access->enter(access->userdata);
        if (!rc) {outside_locks(); CHECK(srv.model_busy); access->leave(access->userdata);}
        if (!rc && access->cancelled && access->cancelled(access->userdata)) rc = Q36_SESSION_SYNC_INTERRUPTED;
    }
    if (rc) probe_free(candidate); else *out = candidate;
    return rc;
}
#endif
static char *probe_text(q36_engine *e, int token, size_t *n) {
    if (token == 2000) {*n = strlen(tool_block_fixture); return strdup(tool_block_fixture);}
    (void)e; char *p = malloc(3); assert(p);
    if (token == 1000) {p[0] = 'k'; p[1] = 'l'; p[2] = 0; *n = 2;}
    else {p[0] = (char)token; p[1] = 0; *n = 1;}
    return p;
}
static void probe_tokenize(q36_engine *e, const char *s, q36_tokens *out) {
    (void)e; out->len = 0;
    for (const unsigned char *p = (const unsigned char *)s; *p; p++) q36_tokens_push(out, *p);
}
static int probe_quant(q36_engine *e) {(void)e; return 6;}
static int probe_rename(const char *from, const char *to) {
    outside_locks();
    if (running && mode == 13) {failed_renames++; errno = EIO; return -1;}
    return rename(from, to);
}
q36_engine *dstudio_catalog_engine(unsigned);
static void *run_job(void *unused) {
    (void)unused; generate_job(&srv, &published, &active);
    pthread_mutex_lock(&barrier_mu); finished = true; pthread_cond_broadcast(&barrier_cv); pthread_mutex_unlock(&barrier_mu);
    return NULL;
}
static unsigned file_count(bool temporary) {
    DIR *dir = opendir(srv.kv.dir); assert(dir); unsigned n = 0; struct dirent *e;
    while ((e = readdir(dir))) {
        if (temporary ? strstr(e->d_name, ".tmp.") != NULL :
            strlen(e->d_name) == 43 && !strcmp(e->d_name + 40, ".kv")) n++;
    }
    closedir(dir); return n;
}
static uint32_t disk_hits(const char *path) {
    FILE *f = fopen(path, "rb"); assert(f); kv_entry e = {0}; uint32_t text;
    assert(kv_read_header(f, &e, &text)); fclose(f); return e.hits;
}
static void file_sha(const char *path, char out[41]) {
    FILE *f = fopen(path, "rb"); assert(f); uint8_t bytes[2048];
    size_t n = fread(bytes, 1, sizeof bytes, f); assert(feof(f)); fclose(f); sha1_bytes_hex(bytes, n, out);
}
static void pending_limits(void) {
    unsigned before = file_count(false), initial_writes = writes;
    if (mode == 21) {
        buf block = {0}; buf_puts(&block, "\n<tool_call>\n<function=read_file>\n<parameter=path>\n");
        for (int i = 0; i < 2048; i++) buf_puts(&block, "a");
        buf_puts(&block, "\n</parameter>\n</function>\n</tool_call>");
        tool_block_fixture = buf_take(&block);
        for (int i = 0; i < 4; i++) {
            char id[32]; snprintf(id, sizeof id, "repeated-call-%d", i);
            tool_memory_put_source(&srv, id, tool_block_fixture, TOOL_MEMORY_RAM);
        }
        original->ids[0] = 2000;
        size_t text_len; char *text = render_tokens_text(srv.engine, &original->tokens, &text_len);
        FILE *f = tmpfile(); assert(f); uint64_t tool_bytes = 0;
        CHECK(kv_tool_map_write(&srv, f, text, &tool_bytes)); CHECK((uint64_t)ftello(f) == tool_bytes);
        /* The budget follows actual produced wire bytes, independent of RAM
         * layout. v1 repeats text per ID; v2 groups ordinal/ID records; v3
         * adds one explicit 32-bit prelude flag per ID. The budget remains one
         * byte below the independently checked wire size on every revision. */
        rewind(f); uint8_t map_header[8]; CHECK(fread(map_header, 1, sizeof map_header, f) == sizeof map_header);
        CHECK(map_header[0] == 'K' && map_header[1] == 'T' && map_header[2] == 'M');
        uint64_t expected = 8;
        CHECK(map_header[3] >= 1 && map_header[3] <= 3);
        CHECK(le_get32(map_header + 4) == (map_header[3] == 1 ? 4u : 1u));
        if (map_header[3] >= 2) expected += 12 + strlen(tool_block_fixture);
        for (int i = 0; i < 4; i++) {
            char id[32]; snprintf(id, sizeof id, "repeated-call-%d", i);
            expected += (map_header[3] == 3 ? 12u : 8u) + strlen(id) +
                        (map_header[3] == 1 ? strlen(tool_block_fixture) : 0);
        }
        CHECK(tool_bytes == expected); fclose(f); free(text);
        srv.kv.budget_bytes = KV_CACHE_FIXED_HEADER + 4ull + text_len + probe_bytes((q36_session *)original) + tool_bytes - 1;
    }
    if (mode == 23) srv.kv.budget_bytes = UINT64_MAX;
#ifndef DSTUDIO_Q36_TEXT_BASELINE
    kv_pending pending = {0};
    if (mode == 22) {
        for (int i = 0; i < 65; i++) {
            original->ids[0] = 33 + i;
            CHECK(kv_cache_store_live_prefix_pending(&srv, &published, &original->tokens, 4, "cold", &pending) == (i < 64));
            CHECK(pending.count == (unsigned)(i < 64 ? i + 1 : 64));
        }
        CHECK(writes == initial_writes + 64 && file_count(true) == 64);
        original->ids[0] = 33;
        CHECK(kv_cache_store_live_prefix_pending(&srv, &published, &original->tokens, 4, "cold", &pending));
        CHECK(pending.count == 64 && writes == initial_writes + 64);
    } else {
        CHECK(!kv_cache_store_live_prefix_pending(&srv, &published, &original->tokens, 4, "cold", &pending));
        CHECK(pending.count == 0 && pending.bytes == 0 && writes == initial_writes);
    }
    CHECK(file_count(false) == before);
    kv_pending_discard(&pending);
    CHECK(!pending.head && !pending.tail && pending.count == 0 && pending.bytes == 0);
#else
    (void)kv_cache_store_live_prefix(&srv, &published, &original->tokens, 4, "cold");
    CHECK(file_count(false) == before && writes == initial_writes);
#endif
    CHECK(file_count(true) == 0);
    tool_memory_free(&srv.tool_mem); free(tool_block_fixture);
}
#ifdef DSTUDIO_Q36_NEXT_REVIEW
static void checkpoint_template_policy(void) {
    const char *p = "[{\"role\":\"user\",\"content\":\"First question\"},"
        "{\"role\":\"assistant\",\"content\":\"14\"},"
        "{\"role\":\"user\",\"content\":\"Next question\"}]";
    chat_msgs msgs = {0}; CHECK(parse_messages(&p, &msgs));
    for (int preserve = 0; preserve < 2; preserve++) {
        request r; request_init(&r, REQ_CHAT, 128);
        r.think_mode = Q36_THINK_NONE; r.preserve_thinking = preserve;
        r.prompt_preserves_reasoning = chat_prompt_preserves_reasoning(&msgs, preserve);
        char *rendered = render_chat_prompt_text_profile(&msgs, NULL, NULL, Q36_THINK_NONE, false, preserve);
        const char *assistant = preserve ? "<|im_start|>assistant\n<think>\n\n</think>\n\n14<|im_end|>\n" :
            "<|im_start|>assistant\n14<|im_end|>\n";
        CHECK(strstr(rendered, assistant) != NULL);
        thinking_state state = {.inside = false};
        /* The native mutation gate must agree with the actual next rendered
         * history, including an empty prelude. No model or source-text oracle. */
        CHECK(should_canonicalize_thinking_checkpoint(&r, &state, "stop") == !preserve);
        CHECK(!should_canonicalize_thinking_checkpoint(&r, &state, "length"));
        CHECK(!should_canonicalize_thinking_checkpoint(&r, &state, "error"));
        state.inside = true; CHECK(!should_canonicalize_thinking_checkpoint(&r, &state, "stop"));
        request_free(&r); free(rendered);
    }
    chat_msgs_free(&msgs);
}
#endif
int main(int argc, char **argv) {
    if (argc != 3) return 2;
    mode = atoi(argv[1]);
#ifdef DSTUDIO_Q36_CACHE_USAGE_TEST
    int usage_format = -1, expected_cached = 0;
    if (mode >= 46 && mode < 78) {
        static const int cache_modes[] = {0, 6, 10, 11};
        int cache = (mode - 46) % 4;
        usage_format = (mode - 46) / 4;
        expected_cached = cache ? 4 : 0;
        mode = cache_modes[cache];
    }
#endif
    bool after_vision = false, stale_job = false, unpersisted_live = false;
#ifdef DSTUDIO_Q36_NEXT_REVIEW
    if (mode >= 35 && mode <= 45) {
        static const int retirement_modes[] = {0, 1, 2, 3, 4, 6, 7, 8, 14, 15, 4};
        stale_job = mode == 45;
        mode = retirement_modes[mode - 35]; unpersisted_live = true;
    }
    if (mode == 33 || mode == 34) {
        after_vision = mode == 33; stale_job = true; mode = 4;
    }
    if (mode == 24) {
        checkpoint_template_policy();
        printf("{\"checks\":%u,\"failures\":%u}\n", atomic_load(&checks), atomic_load(&failures));
        return atomic_load(&failures) ? 1 : 0;
    }
    if (mode >= 25 && mode <= 32) {
        static const int transition_modes[] = {0, 1, 2, 4, 6, 10, 7, 8};
        mode = transition_modes[mode - 25]; after_vision = true;
    }
#endif
    if (mode < 0 || mode > 23) return 2;
    pthread_mutex_t *locks[] = {&srv.mu, &srv.kv_mu, &srv.tool_mu, &srv.model_mu,
#ifndef Q36_PAYLOAD_RESTORE_SCHEDULE_API
        &srv.inference_mu,
#endif
    };
    for (unsigned i = 0; i < sizeof locks / sizeof *locks; i++) pthread_mutex_init(locks[i], NULL);
    pthread_cond_init(&srv.model_cv, NULL);
    srv.engine = dstudio_catalog_engine(1); srv.ctx_size = 32;
    srv.kv.enabled = true; srv.kv.dir = strdup(argv[2]); srv.kv.budget_bytes = 1024 * 1024;
    srv.kv.opt = (kv_cache_options){.min_tokens = 4, .cold_max_tokens = 32,
        .continued_interval_tokens = 4, .boundary_align_tokens = 4};
    assert(mkdir(srv.kv.dir, 0700) == 0);
    original = new_session(); fill_state(original, !after_vision && (mode == 10 || mode == 11 || mode == 18) ? 'k' : 'a', 4);
    published = (server_slot){.srv = &srv, .session = (q36_session *)original, .continued_last_store_tokens = 4};
    CHECK(kv_cache_store_live_prefix(&srv, &published, &original->tokens, 4, "cold"));
    size_t text_len; char *old_text = render_tokens_text(srv.engine, &original->tokens, &text_len), sha[41];
    sha1_bytes_hex(old_text, text_len, sha); free(old_text); char *old_path = kv_path_for_sha(&srv.kv, sha), old_hash[41];
    file_sha(old_path, old_hash);
    if (mode >= 21) {
        running = true; pending_limits();
        free(old_path); free(original);
        printf("{\"checks\":%u,\"failures\":%u}\n", atomic_load(&checks), atomic_load(&failures));
        return atomic_load(&failures) ? 1 : 0;
    }
    bool disk = (mode >= 6 && mode <= 9) || mode == 19;
    char *disk_path = NULL;
    if (disk) {
        simulated_session *saved = new_session(); fill_state(saved, 'k', 4);
        server_slot holder = {.srv = &srv, .session = (q36_session *)saved};
        CHECK(kv_cache_store_live_prefix(&srv, &holder, &saved->tokens, 4, "cold"));
        sha1_bytes_hex("klmn", 4, sha); disk_path = kv_path_for_sha(&srv.kv, sha);
        if (mode == 9 || mode == 19) {
            FILE *f = fopen(disk_path, "r+b"); assert(f);
            assert(fseek(f, mode == 9 ? KV_CACHE_FIXED_HEADER + 8 : 8, SEEK_SET) == 0);
            uint8_t bad[4]; le_put32(bad, mode == 9 ? 99 : 7);
            assert(fwrite(bad, 1, 4, f) == 4); assert(!fclose(f));
        }
        probe_free((q36_session *)saved);
    }
    if (mode == 17) srv.kv.budget_bytes = 1;
    if (mode == 20) srv.kv.enabled = false;
#ifdef DSTUDIO_Q36_NEXT_REVIEW
    if (after_vision) {
        /* A prior text checkpoint is independent of the now-resident image
         * state. Matching image tokens must not accidentally select that text
         * file instead of exercising rejection of the live visual prefix. */
        if (mode == 10) fill_state(original, 'k', 4);
        original->vision = true;
        published.pending_ids = calloc(2, sizeof(char *)); assert(published.pending_ids);
        published.pending_ids[0] = strdup("previous-image-tool-a");
        published.pending_ids[1] = strdup("previous-image-tool-b");
        published.pending_count = 2; published.pending_pos = 4;
        published.pending_api = API_OPENAI; published.pending_tools = strdup("original-image-schema");
    }
#endif
    char *retired_path = NULL;
    if (unpersisted_live) {
        /* A completed live answer can be newer than its last disk checkpoint.
         * Starting an unrelated prompt must not publish/evict cache files until
         * the owner accepts that prompt. Preserve both the old disk snapshot
         * and the newer live state when preparation fails or is cancelled. */
        fill_state(original, 'e', 4);
        sha1_bytes_hex("efgh", 4, sha); retired_path = kv_path_for_sha(&srv.kv, sha);
        CHECK(access(retired_path, F_OK) != 0);
    }
    const int retained_first = unpersisted_live ? 'e' :
        mode == 10 || mode == 11 || mode == 18 ? 'k' : 'a';
    unsigned initial_files = file_count(false);
    int pair[2]; assert(!socketpair(AF_UNIX, SOCK_STREAM, 0, pair));
    active.fd = pair[0]; active.deadline = now_sec() + 20;
    active.request_id = "text-transaction-fixture"; atomic_init(&active.cancelled, false);
    active.req.kind = REQ_COMPLETION; active.req.api = API_OPENAI; active.req.max_tokens = 0;
#ifdef DSTUDIO_Q36_CACHE_USAGE_TEST
    if (usage_format >= 0) {
        int api = usage_format / 2;
        active.req.kind = api == 0 ? REQ_COMPLETION : REQ_CHAT;
        active.req.api = api == 2 ? API_RESPONSES : api == 3 ? API_ANTHROPIC : API_OPENAI;
        active.req.stream = usage_format % 2 != 0;
        active.req.stream_include_usage = true;
    }
#endif
    active.req.model = strdup("qwen3.8-27b"); active.req.prompt_text = strdup("klmnopqrst");
    probe_tokenize(srv.engine, active.req.prompt_text, &active.req.prompt);
    if (mode == 11) {active.req.prompt.v[0] = 1000; memmove(active.req.prompt.v + 1, active.req.prompt.v + 2, 8 * sizeof(int)); active.req.prompt.len = 9;}
    CHECK(server_admit_job(&srv, &active) == 0);
    published.current_job = &active;
#ifdef DSTUDIO_Q36_TEXT_BATCHED_TEST
    srv.batched_mode = true; srv.slots = text_slots; srv.slot_count = 2;
    srv.last_prefill_slot = 1;
    published.current_job = &active;
    text_slots[1] = (server_slot){.srv = &srv, .id = 1};
#endif
    if (mode == 16) CHECK(server_cancel_request(&srv, active.request_id));
    if (mode == 4 && !stale_job) {replacement = new_session(); fill_state(replacement, 'x', 3);}
    running = true; pthread_t worker; assert(!pthread_create(&worker, NULL, run_job, NULL));
    pthread_mutex_lock(&barrier_mu);
    while (!reached && !finished) pthread_cond_wait(&barrier_cv, &barrier_mu);
    bool barrier = reached; pthread_mutex_unlock(&barrier_mu);
    if (mode != 5 && mode != 16) CHECK(barrier);
    if (barrier) {
        CHECK(published.session == (q36_session *)original && !original->retired);
        CHECK(original->tokens.len == 4 && original->ids[0] == retained_first);
        CHECK(original->logits[0] == (float)(original->ids[0] + 4));
        CHECK(published.continued_last_store_tokens == 4);
        CHECK(file_count(false) == initial_files);
#ifdef DSTUDIO_Q36_NEXT_REVIEW
        if (after_vision) {
            CHECK(original->vision && published.pending_count == 2);
            CHECK(!strcmp(published.pending_ids[0], "previous-image-tool-a"));
            CHECK(!strcmp(published.pending_tools, "original-image-schema"));
        }
#endif
        if (disk_path) CHECK(disk_hits(disk_path) == 0);
#ifdef DSTUDIO_Q36_CACHE_USAGE_TEST
        CHECK(active.req.cached_tokens == 0); /* Private preparation is not published reuse. */
#endif
        outside_locks();
        int control[2]; assert(!socketpair(AF_UNIX, SOCK_STREAM, 0, control));
        CHECK(send_models(&srv, control[0])); shutdown(control[0], SHUT_WR);
        char reply[8192]; ssize_t n = read(control[1], reply, sizeof reply - 1); CHECK(n > 0);
        if (n > 0) {reply[n] = 0; CHECK(strstr(reply, "200 OK") && strstr(reply, "qwen3.8-27b"));}
        close(control[0]); close(control[1]);
        if (mode == 2 || mode == 8) CHECK(server_cancel_request(&srv, active.request_id));
        pthread_mutex_lock(&srv.mu);
        if (mode == 4) {
            if (stale_job) published.current_job = NULL;
            else published.session = (q36_session *)replacement;
        }
        if (mode == 14) srv.stopping = true;
        pthread_mutex_unlock(&srv.mu);
        pthread_mutex_lock(&barrier_mu); released = true; pthread_cond_broadcast(&barrier_cv); pthread_mutex_unlock(&barrier_mu);
    }
    pthread_join(worker, NULL); shutdown(pair[0], SHUT_WR);
    char response[16384]; ssize_t got = read(pair[1], response, sizeof response - 1); CHECK(got > 0);
    if (got > 0) response[got] = 0; else response[0] = 0;
    bool success = mode == 0 || mode == 6 || mode == 9 || mode == 10 || mode == 11 ||
        mode == 12 || mode == 13 || mode == 17 || mode == 19 || mode == 20;
    if (success) {
        CHECK(strstr(response, "200 OK") != NULL); CHECK(original->retired);
        simulated_session *s = (simulated_session *)published.session;
        CHECK(s != original && s->tokens.len == 10 && s->ctx == 32);
        for (int i = 0; i < 10 && i < s->tokens.len; i++) CHECK(s->ids[i] == 'k' + i);
        CHECK(s->logits[0] == (float)('k' + 10));
        if (mode == 12 || mode == 13 || mode == 17 || mode == 20) CHECK(file_count(false) == initial_files);
        else CHECK(file_count(false) > initial_files);
        if (mode == 6) CHECK(disk_hits(disk_path) == 1);
        if (mode == 13) CHECK(failed_renames > 0 && published.continued_last_store_tokens == 0);
    } else {
        CHECK(strstr(response, mode == 1 || mode == 5 || mode == 7 || mode == 18 ? "500" : "499") != NULL);
        CHECK(published.session == (q36_session *)(mode == 4 && !stale_job ? replacement : original));
        CHECK(!original->retired && original->tokens.len == 4 && original->logits[0] == (float)(original->ids[0] + 4));
        CHECK(published.continued_last_store_tokens == 4 && file_count(false) == initial_files);
        if (disk_path) CHECK(disk_hits(disk_path) == 0);
    }
    CHECK(file_count(true) == 0);
#ifdef DSTUDIO_Q36_CACHE_USAGE_TEST
    if (!success) CHECK(active.req.cached_tokens == 0);
    if (usage_format >= 0) {
        fprintf(stderr, "HTTP_USAGE_RECEIPT_BEGIN\n%s\nHTTP_USAGE_RECEIPT_END\n", response);
        CHECK(success && active.req.cached_tokens == expected_cached);
        const char *usage = response;
        if (active.req.api == API_RESPONSES && active.req.stream) {
            char *terminal = strstr(response, "event: response.completed\n");
            CHECK(terminal != NULL);
            if (terminal) {
                char saved = *terminal; *terminal = 0;
                check_usage_value(response, "input_tokens", 0);
                check_usage_value(response, "cached_tokens", 0);
                *terminal = saved; usage = terminal;
            }
        }
        if (active.req.api == API_ANTHROPIC) {
            check_usage_value(usage, "cache_read_input_tokens", expected_cached);
            check_usage_value(usage, "input_tokens", 10 - expected_cached);
        } else {
            check_usage_value(usage, "cached_tokens", expected_cached);
            check_usage_value(usage, active.req.api == API_RESPONSES ? "input_tokens" : "prompt_tokens", 10);
        }
    }
#endif
    if (unpersisted_live) {
        if (success) {
            FILE *fp = fopen(retired_path, "rb"); CHECK(fp != NULL);
            if (fp) {
                kv_entry entry = {0}; uint32_t text_bytes = 0; char text[4] = {0};
                CHECK(kv_read_header(fp, &entry, &text_bytes));
                CHECK(entry.tokens == 4 && text_bytes == sizeof text);
                CHECK(fread(text, 1, sizeof text, fp) == sizeof text && !memcmp(text, "efgh", 4));
                simulated_session *restored = new_session(); char error[160];
                CHECK(probe_load((q36_session *)restored, fp, entry.payload_bytes, error, sizeof error) == 0);
                CHECK(restored->tokens.len == 4 && !memcmp(restored->ids, original->ids, 4 * sizeof(int)));
                CHECK(!memcmp(restored->logits, original->logits, sizeof original->logits));
                fclose(fp); probe_free((q36_session *)restored);
            }
        } else CHECK(access(retired_path, F_OK) != 0);
    }
#ifdef DSTUDIO_Q36_NEXT_REVIEW
    if (after_vision) {
        if (success) {
            CHECK(!probe_vision(published.session));
            CHECK(!published.pending_count && !published.pending_ids && !published.pending_tools);
            if (mode == 10) CHECK(active.req.cached_tokens == 0);
        } else {
            CHECK(original->vision && published.pending_count == 2);
            CHECK(!strcmp(published.pending_ids[1], "previous-image-tool-b"));
            CHECK(!strcmp(published.pending_tools, "original-image-schema"));
        }
        slot_pending_clear(&published);
    }
#else
    (void)after_vision;
#endif
    char retained[41]; file_sha(old_path, retained); CHECK(!strcmp(old_hash, retained));
    if (mode == 16 || mode == 5) CHECK(syncs == 0);
    if (mode == 10 || mode == 11 || mode == 18) CHECK(reads == 0);
    CHECK(!((simulated_session *)published.session)->progress && !((simulated_session *)published.session)->cancel);
    server_release_job(&srv, &active);
    request_free(&active.req); close(pair[0]); close(pair[1]); free(old_path); free(disk_path); free(retired_path);
    for (unsigned i = 0; i < allocations; i++) free(allocated[i]);
    printf("{\"cases\":1,\"checks\":%u,\"failures\":%u,\"allocations\":%u,\"syncs\":%u,\"loads\":%u,\"writes\":%u,"
           "\"serverBytes\":%zu,\"slotBytes\":%zu,\"progressBytes\":%zu,\"traceBytes\":%zu}\n",
        atomic_load(&checks), atomic_load(&failures), allocations, syncs, reads, writes,
        sizeof(server), sizeof(server_slot), sizeof(server_prefill_progress), sizeof(trace_cache_diag));
    return atomic_load(&failures) ? 1 : 0;
}

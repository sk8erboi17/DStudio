/* Execute the production HTTP preparation/publication path with a deterministic
 * simulated native worker. The real-model HTTP test separately checks pixels
 * and inference. No lock timing, source text or model self-assessment oracle. */
#include "q36.h"
#include <assert.h>
#include <pthread.h>
#include <stdatomic.h>

static int probe_create(q36_session **, q36_engine *, int);
static void probe_free(q36_session *);
static int probe_ctx(q36_session *);
static void probe_progress(q36_session *, q36_session_progress_fn, void *);
static void probe_cancel(q36_session *, q36_session_cancel_fn, void *);
static int probe_sync(q36_session *, const q36_tokens *, char *, size_t);
static int probe_prepare(q36_session **, const q36_session *, const q36_tokens *,
    q36_session_progress_fn, void *, q36_session_cancel_fn, void *, char *, size_t);
static int probe_sync_vision(q36_session *, const q36_tokens *, const q36_vision_span *, size_t, char *, size_t);
static int probe_encode(q36_engine *, const uint8_t *, size_t, q36_vision_embedding *, char *, size_t);
static void probe_tokenize(q36_engine *, const char *, q36_tokens *);
static int probe_append(q36_engine *, q36_tokens *, q36_vision_span *, q36_vision_embedding *, char *, size_t);
#ifdef DSTUDIO_Q36_NEXT_REVIEW
static int probe_pos(q36_session *);
static int probe_visual_fork(q36_session **, const q36_session *, const q36_tokens *,
    const q36_vision_span *, size_t, q36_session_cancel_fn, void *, char *, size_t);
#define q36_session_pos probe_pos
#define q36_session_fork_for_vision_prompt probe_visual_fork
#endif

#define q36_session_create probe_create
#define q36_session_free probe_free
#define q36_session_ctx probe_ctx
#define q36_session_set_progress probe_progress
#define q36_session_set_cancel probe_cancel
#define q36_session_sync probe_sync
#define q36_session_prepare_sync probe_prepare
#define q36_session_sync_vision probe_sync_vision
#define q36_engine_vision_encode_memory probe_encode
#define q36_tokenize_rendered_chat probe_tokenize
#define q36_prompt_append_vision probe_append
#define Q36_SERVER_TEST
#define Q36_SERVER_TEST_NO_MAIN
#include "q36_server.c"

typedef struct {
    int ctx, generation, tokens[16];
    float logits[16];
    q36_session_progress_fn progress;
    q36_session_cancel_fn cancel;
    void *progress_ud, *cancel_ud;
} simulated_session;

static server srv;
static pthread_mutex_t barrier_mu = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t barrier_cv = PTHREAD_COND_INITIALIZER;
static bool prepared, release_worker, worker_finished;
static int mode, created, retired;
static bool with_image;
static atomic_uint failures, assertions;
static void checked(bool condition, int line) {
    atomic_fetch_add(&assertions, 1);
    if (!condition) {
        atomic_fetch_add(&failures, 1);
        fprintf(stderr, "HTTP ownership invariant failed at probe line %d\n", line);
    }
}
#define check(condition) checked((condition), __LINE__)
static void outside_publication(void) {
    int rc = pthread_mutex_trylock(&srv.mu);
    check(rc == 0);
    if (rc == 0) pthread_mutex_unlock(&srv.mu);
}
static simulated_session *new_state(int generation) {
    simulated_session *s = calloc(1, sizeof(*s));
    assert(s);
    s->ctx = 8192; s->generation = generation;
    for (int i = 0; i < 16; i++) {s->tokens[i] = generation * 100 + i; s->logits[i] = (float)i / 8;}
    return s;
}
static int probe_create(q36_session **out, q36_engine *engine, int ctx) {
    outside_publication(); check(engine == srv.engine); check(ctx == srv.ctx_size);
    if (mode == 6) return 1;
    simulated_session *s = new_state(2);
    if (mode == 7) s->ctx--;
    *out = (q36_session *)s; created++; return 0;
}
static void probe_free(q36_session *session) {
    if (!session) return;
    outside_publication(); retired++; free(session);
}
static int probe_ctx(q36_session *session) {return ((simulated_session *)session)->ctx;}
static void probe_progress(q36_session *session, q36_session_progress_fn fn, void *ud) {
    simulated_session *s = (simulated_session *)session; s->progress = fn; s->progress_ud = ud;
}
static void probe_cancel(q36_session *session, q36_session_cancel_fn fn, void *ud) {
    simulated_session *s = (simulated_session *)session; s->cancel = fn; s->cancel_ud = ud;
}
static int probe_sync(q36_session *session, const q36_tokens *prompt, char *err, size_t len) {
    (void)err; (void)len;
    simulated_session *s = (simulated_session *)session;
    outside_publication(); check(s->generation == 2); check(prompt->len == 4);
    for (int i = 0; i < prompt->len; i++) s->tokens[i] = prompt->v[i];
    s->logits[0] = 9.5f;
    if (s->progress) s->progress(s->progress_ud, "prefill_chunk", 2, 4);
    pthread_mutex_lock(&barrier_mu);
    prepared = true; pthread_cond_signal(&barrier_cv);
    while (!release_worker) pthread_cond_wait(&barrier_cv, &barrier_mu);
    pthread_mutex_unlock(&barrier_mu);
    if (s->cancel && s->cancel(s->cancel_ud)) return Q36_SESSION_SYNC_INTERRUPTED;
    return mode == 1 ? 1 : 0;
}
static int probe_sync_vision(q36_session *s, const q36_tokens *t, const q36_vision_span *v, size_t n, char *e, size_t l) {
    check(with_image && n == 1 && v != NULL);
    if (v && n == 1) check(v->token_start == 1 && v->embedding.token_count == 1 &&
        v->embedding.fingerprint[0] == 0x35 && v->embedding.data && v->embedding.data[0] == 42.0f);
    return probe_sync(s, t, e, l);
}
#ifdef DSTUDIO_Q36_NEXT_REVIEW
static int probe_pos(q36_session *s) {(void)s; return 0;}
static int probe_visual_fork(q36_session **out, const q36_session *source, const q36_tokens *prompt,
    const q36_vision_span *images, size_t count, q36_session_cancel_fn cancel, void *ud, char *err, size_t len) {
    (void)err; (void)len;
    outside_publication(); check(with_image && source != NULL && prompt->len == 4);
    check(count == 1 && images && images[0].embedding.fingerprint[0] == 0x35);
    if (cancel && cancel(ud)) return Q36_SESSION_SYNC_INTERRUPTED;
    return probe_create(out, srv.engine, srv.ctx_size);
}
#endif
static int probe_prepare(q36_session **out, const q36_session *source, const q36_tokens *t,
    q36_session_progress_fn progress, void *progress_ud, q36_session_cancel_fn cancel, void *cancel_ud,
    char *err, size_t len) {
    /* Simulated native boundary only; the separate core/real-weight probes
     * test the actual state copy and preparation implementation. */
    check(source != NULL);
    q36_session *candidate = NULL;
    if (probe_create(&candidate, srv.engine, srv.ctx_size)) return 1;
    probe_progress(candidate, progress, progress_ud); probe_cancel(candidate, cancel, cancel_ud);
    int rc = probe_sync(candidate, t, err, len);
    probe_progress(candidate, NULL, NULL); probe_cancel(candidate, NULL, NULL);
    if (rc) probe_free(candidate);
    else *out = candidate;
    return rc;
}
static int probe_encode(q36_engine *e, const uint8_t *b, size_t n, q36_vision_embedding *o, char *err, size_t len) {
    (void)e; (void)b; (void)n; (void)o; (void)err; (void)len; check(false); return 0;
}
static void probe_tokenize(q36_engine *e, const char *s, q36_tokens *t) {(void)e; (void)s; (void)t; check(false);}
static int probe_append(q36_engine *e, q36_tokens *t, q36_vision_span *v, q36_vision_embedding *m, char *err, size_t len) {
    (void)e; (void)t; (void)v; (void)m; (void)err; (void)len; check(false); return 0;
}

q36_engine *dstudio_catalog_engine(unsigned family);
typedef struct {server_slot *slot; job *j; int rc; char err[160];} work;
static void *prepare_main(void *arg) {
    work *w = arg;
    w->rc = server_prepare_visual_request(&srv, w->slot, w->j, w->err, sizeof(w->err));
    pthread_mutex_lock(&barrier_mu);
    worker_finished = true; pthread_cond_broadcast(&barrier_cv);
    pthread_mutex_unlock(&barrier_mu);
    return NULL;
}

static void tcp_pair(int pair[2]) {
    int listener = socket(AF_INET, SOCK_STREAM, 0); assert(listener >= 0);
    struct sockaddr_in addr = {.sin_family = AF_INET, .sin_addr.s_addr = htonl(INADDR_LOOPBACK)};
    assert(bind(listener, (struct sockaddr *)&addr, sizeof(addr)) == 0);
    socklen_t len = sizeof(addr);
    assert(getsockname(listener, (struct sockaddr *)&addr, &len) == 0);
    assert(listen(listener, 1) == 0);
    pair[1] = socket(AF_INET, SOCK_STREAM, 0); assert(pair[1] >= 0);
    assert(connect(pair[1], (struct sockaddr *)&addr, len) == 0);
    pair[0] = accept(listener, NULL, NULL); assert(pair[0] >= 0);
    close(listener);
}

int main(int argc, char **argv) {
    if (argc != 2) return 2;
    const int scenario = atoi(argv[1]);
#ifdef DSTUDIO_Q36_NEXT_REVIEW
    if (scenario < 0 || scenario > 21) return 2;
    with_image = scenario >= 11; mode = scenario % 11;
#else
    mode = scenario; if (mode < 0 || mode > 10) return 2;
#endif
    pthread_mutex_init(&srv.mu, NULL);
    srv.ctx_size = 8192; srv.engine = dstudio_catalog_engine(1); srv.default_tokens = 32;
    simulated_session *previous = new_state(1), before;
    memcpy(&before, previous, sizeof(before));
    server_slot slot = {.srv = &srv, .session = (q36_session *)previous};
    simulated_session *replacement = mode == 5 ? new_state(3) : NULL;
    int pair[2]; tcp_pair(pair);
    job j = {.fd = pair[0], .deadline = now_sec() + 30};
    /* The real single-session worker binds its admitted job before generation. */
    slot.current_job = &j;
    atomic_init(&j.cancelled, false);
#ifdef DSTUDIO_Q36_NEXT_REVIEW
    if (with_image) {
        /* Already prepared synthetic embedding. Pixel decoding and native core
         * identity copying are separate tests; this exercises their real HTTP
         * publication/retirement boundary, including prior pending tool IDs. */
        j.req.images = calloc(1, sizeof(*j.req.images)); assert(j.req.images);
        j.req.image_count = 1; j.req.images[0].token_start = 1;
        j.req.images[0].embedding = (q36_vision_embedding){.token_count = 1,
            .width = 1, .height = 1, .grid_width = 1, .grid_height = 1};
        memset(j.req.images[0].embedding.fingerprint, 0x35, 32);
        j.req.images[0].embedding.data = malloc(sizeof(float)); assert(j.req.images[0].embedding.data);
        j.req.images[0].embedding.data[0] = 42.0f;
        slot.pending_count = 1; slot.pending_ids = calloc(1, sizeof(char *)); assert(slot.pending_ids);
        slot.pending_ids[0] = xstrdup("previous-tool"); slot.pending_tools = xstrdup("previous-schema");
    }
#endif
    if (mode == 9 || mode == 10) {
        j.request_id = "prepare-cancel-unique";
        check(server_admit_job(&srv, &j) == 0);
        if (mode == 10) check(server_cancel_request(&srv, j.request_id));
    }
    for (int i = 0; i < 4; i++) q36_tokens_push(&j.req.prompt, 30 + i);
    if (mode == 2) j.deadline = now_sec() - 1;
    if (mode == 8) assert(shutdown(pair[1], SHUT_WR) == 0);
    work w = {.slot = &slot, .j = &j, .rc = -1};
    pthread_t worker;
    assert(pthread_create(&worker, NULL, prepare_main, &w) == 0);
    if (mode != 2 && mode != 6 && mode != 10) {
        pthread_mutex_lock(&barrier_mu);
        while (!prepared && !worker_finished) pthread_cond_wait(&barrier_cv, &barrier_mu);
        const bool reached_preparation = prepared;
        pthread_mutex_unlock(&barrier_mu);
        check(reached_preparation);
        if (reached_preparation) {
        check(slot.session == (q36_session *)previous);
        check(!memcmp(previous, &before, sizeof(before)));
#ifdef DSTUDIO_Q36_NEXT_REVIEW
        if (with_image) check(slot.pending_count == 1 && !strcmp(slot.pending_ids[0], "previous-tool"));
#endif
        outside_publication();
        /* A real metadata response completes while preparation is deliberately
         * blocked after changing its private state. No engine substitute here. */
        int control[2]; assert(socketpair(AF_UNIX, SOCK_STREAM, 0, control) == 0);
        check(send_models(&srv, control[0]));
        shutdown(control[0], SHUT_WR);
        char response[8192]; ssize_t n = recv(control[1], response, sizeof(response) - 1, 0);
        check(n > 0);
        if (n > 0) {response[n] = '\0'; check(strstr(response, "HTTP/1.1 200") != NULL); check(strstr(response, "qwen3.8-27b") != NULL);}
        close(control[0]); close(control[1]);
        if (mode == 9) check(server_cancel_request(&srv, j.request_id));
        if (mode == 3) {
            /* HTTP uses TCP. An abortive reset is observably different from
             * FIN: a legal half-close still permits the response to be read. */
            struct linger reset = {.l_onoff = 1, .l_linger = 0};
            assert(setsockopt(pair[1], SOL_SOCKET, SO_LINGER, &reset, sizeof(reset)) == 0);
            close(pair[1]); pair[1] = -1;
            struct pollfd ready = {.fd = pair[0], .events = POLLIN};
            assert(poll(&ready, 1, 1000) > 0);
        }
        pthread_mutex_lock(&srv.mu);
        if (mode == 4) srv.stopping = true;
        if (mode == 5) slot.session = (q36_session *)replacement;
        pthread_mutex_unlock(&srv.mu);
        pthread_mutex_lock(&barrier_mu); release_worker = true; pthread_cond_signal(&barrier_cv); pthread_mutex_unlock(&barrier_mu);
        }
    }
    pthread_join(worker, NULL);
    bool success = mode == 0 || mode == 8;
    check((w.rc == 0) == success);
#ifdef DSTUDIO_Q36_NEXT_REVIEW
    if (with_image) {
        if (success) check(!slot.pending_count && !slot.pending_ids && !slot.pending_tools && j.req.cached_tokens == 0);
        else check(slot.pending_count == 1 && !strcmp(slot.pending_ids[0], "previous-tool") &&
            !strcmp(slot.pending_tools, "previous-schema"));
        slot_pending_clear(&slot);
    }
#endif
    if (success) {
        simulated_session *current = (simulated_session *)slot.session;
        check(current != previous && current->generation == 2);
        check(current->tokens[0] == 30 && current->logits[0] == 9.5f);
        check(current->progress == NULL && current->cancel == NULL);
        check(retired == 1 && created == 1);
        probe_free(slot.session);
    } else {
        check(slot.session == (q36_session *)(replacement ? replacement : previous));
        check(!memcmp(previous, &before, sizeof(before)));
        check(created == retired);
        probe_free((q36_session *)previous);
        if (replacement) probe_free((q36_session *)replacement);
    }
    request_free(&j.req);
    server_release_job(&srv, &j);
    close(pair[0]); if (pair[1] >= 0) close(pair[1]);
    pthread_mutex_destroy(&srv.mu);
    printf("{\"case\":%d,\"rc\":%d,\"assertions\":%u,\"failures\":%u}\n", scenario, w.rc,
           atomic_load(&assertions), atomic_load(&failures));
    return atomic_load(&failures) ? 1 : 0;
}

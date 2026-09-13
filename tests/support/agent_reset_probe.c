/* Actual native command handler + worker threads; the inference/session API is
 * a deterministic barrier fixture. This is ownership/recovery, not model QA. */
#include "ds4.h"
#include "ds4_kvstore.h"
#include <assert.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

struct ds4_session {
    ds4_tokens tokens;
    int value, ctx, power;
    ds4_session_progress_fn progress;
    void *progress_ud;
    ds4_session_cancel_fn cancel;
    void *cancel_ud;
};
static pthread_mutex_t gate_mu = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t gate_cv = PTHREAD_COND_INITIALIZER;
static int entered, released, command_returned, create_fail, sync_fail;
static int live_sessions, peak_sessions, save_failure, late_cancel;
#ifdef DSTUDIO_RESET_QWEN38
static int prepare_calls;
#endif
static pthread_t prepare_thread;
static void probe_interrupt(void *ud);

static bool probe_qwen(ds4_engine *e) { (void)e; return true; }
static void probe_chat_begin(ds4_engine *e, ds4_tokens *t) {
    (void)e; ds4_tokens_free(t); ds4_tokens_push(t, 101);
}
static void probe_message(ds4_engine *e, ds4_tokens *t, const char *role, const char *content) {
    (void)e; (void)role; (void)content; ds4_tokens_push(t, 102);
}
static char *probe_render(ds4_engine *e, const ds4_tokens *t, size_t *len) {
    (void)e; (void)t; char *s = strdup("system fixture"); *len = strlen(s); return s;
}
static int probe_create(ds4_session **out, ds4_engine *e, int ctx) {
    (void)e;
    if (create_fail) return 1;
    *out = calloc(1, sizeof(**out)); assert(*out); (*out)->ctx = ctx;
    pthread_mutex_lock(&gate_mu);
    if (++live_sessions > peak_sessions) peak_sessions = live_sessions;
    pthread_mutex_unlock(&gate_mu); return 0;
}
static void probe_free(ds4_session *s) {
    if (!s) return;
    ds4_tokens_free(&s->tokens); free(s);
    pthread_mutex_lock(&gate_mu); live_sessions--; pthread_mutex_unlock(&gate_mu);
}
static int probe_ctx(ds4_session *s) { return s->ctx; }
static int probe_pos(ds4_session *s) { return s->tokens.len; }
static int probe_common(ds4_session *s, const ds4_tokens *t) {
    int n = 0;
    while (n < s->tokens.len && n < t->len && s->tokens.v[n] == t->v[n]) n++;
    return n;
}
static const ds4_tokens *probe_tokens(ds4_session *s) { return &s->tokens; }
static int probe_power(ds4_session *s, int value) { s->power = value; return 0; }
static void probe_progress(ds4_session *s, ds4_session_progress_fn fn, void *ud) {
    s->progress = fn; s->progress_ud = ud;
}
static void probe_display(ds4_session *s, ds4_session_progress_fn fn, void *ud) {
    (void)s; (void)fn; (void)ud;
}
static void probe_cancel(ds4_session *s, ds4_session_cancel_fn fn, void *ud) {
    s->cancel = fn; s->cancel_ud = ud;
}
static int probe_sync(ds4_session *s, const ds4_tokens *t, char *err, size_t cap) {
    if (save_failure) { assert(s->value == 707 && probe_common(s, t) == t->len); return 0; }
    /* Deliberately mutate preparation state before an error/cancel. The old
     * authoritative session must be a different object and remain untouched. */
    s->value = 909; ds4_tokens_copy(&s->tokens, t);
    if (s->progress) s->progress(s->progress_ud, "prefill_chunk", 1, t->len);
    pthread_mutex_lock(&gate_mu);
    prepare_thread = pthread_self(); entered = 1; pthread_cond_broadcast(&gate_cv);
    while (!released) pthread_cond_wait(&gate_cv, &gate_mu);
    pthread_mutex_unlock(&gate_mu);
    /* Return success despite a just-arrived interrupt: only owner-side
     * revalidation can reject this prepared candidate. */
    if (late_cancel) { probe_interrupt(s->cancel_ud); return 0; }
    if (s->cancel && s->cancel(s->cancel_ud)) {
        snprintf(err, cap, "interrupted"); return DS4_SESSION_SYNC_INTERRUPTED;
    }
    if (sync_fail) { snprintf(err, cap, "injected prefill failure"); return 1; }
    return 0;
}
#ifdef DSTUDIO_RESET_QWEN38
static int probe_prepare(ds4_session *s, const ds4_tokens *t, char *err, size_t cap) {
    assert(s->tokens.len == 0 && s->value != 707);
    prepare_calls++;
    return probe_sync(s, t, err, cap);
}
#define ds4_session_prepare_empty probe_prepare
#endif
#ifdef DSTUDIO_RESET_QWEN38
static int probe_quant(ds4_engine *e) { (void)e; return 4; }
static int probe_model(ds4_engine *e) { (void)e; return 1; }
static int probe_stage(ds4_session *s, ds4_session_payload_file *out, char *err, size_t n) {
    (void)s; (void)out; assert(save_failure);
    snprintf(err, n, "injected checkpoint failure"); return 1;
}
#define ds4_engine_routed_quant_bits probe_quant
#define ds4_engine_model_id probe_model
#define ds4_session_stage_payload probe_stage
#endif

#ifdef DSTUDIO_RESET_QWEN38
#define ds4_engine_is_qwen4 probe_qwen
#else
#define ds4_engine_is_qwen35moe probe_qwen
#endif
#define ds4_chat_begin probe_chat_begin
#define ds4_chat_append_message probe_message
#define ds4_kvstore_render_tokens_text probe_render
#define ds4_session_create probe_create
#define ds4_session_free probe_free
#define ds4_session_ctx probe_ctx
#define ds4_session_pos probe_pos
#define ds4_session_common_prefix probe_common
#define ds4_session_tokens probe_tokens
#define ds4_session_set_power probe_power
#define ds4_session_set_progress probe_progress
#define ds4_session_set_display_progress probe_display
#define ds4_session_set_cancel probe_cancel
#define ds4_session_sync probe_sync
#define DS4_AGENT_TEST
#define DS4_AGENT_TEST_NO_MAIN
#include "ds4_agent.c"
static void probe_interrupt(void *ud) { worker_interrupt(ud); }

static void *command_thread(void *arg) {
    ds4ui_handle_slash_idle(arg, "/new");
    pthread_mutex_lock(&gate_mu);
    command_returned = 1; pthread_cond_broadcast(&gate_cv);
    pthread_mutex_unlock(&gate_mu); return NULL;
}
static void wait_gate(int *flag) {
    struct timespec until; clock_gettime(CLOCK_REALTIME, &until); until.tv_sec += 5;
    pthread_mutex_lock(&gate_mu);
    while (!*flag) assert(pthread_cond_timedwait(&gate_cv, &gate_mu, &until) == 0);
    pthread_mutex_unlock(&gate_mu);
}
static int transcript_is_old(agent_worker *w) {
    return w->transcript.len == 2 && w->transcript.v[0] == 777 && w->transcript.v[1] == 778;
}

int main(int argc, char **argv) {
    assert(argc == 2);
    const int cancel = !strcmp(argv[1], "cancel");
    late_cancel = !strcmp(argv[1], "late_cancel");
    save_failure = !strcmp(argv[1], "save_failure");
    const int duplicate = !strcmp(argv[1], "duplicate");
    sync_fail = !strcmp(argv[1], "failure");
    const int allocation = !strcmp(argv[1], "allocation");
    assert(cancel || late_cancel || save_failure || duplicate || sync_fail || allocation || !strcmp(argv[1], "success"));
    agent_config cfg = {.jsonl = true, .non_interactive = true,
        .gen = {.ctx_size = 16384, .raw_prompt = true, .system = "fixture"}};
    agent_worker w = {.cfg = &cfg, .wake_fd = {-1,-1}};
    assert(!pthread_mutex_init(&w.mu, NULL)); assert(!pthread_cond_init(&w.cond, NULL));
    assert(!probe_create(&w.session, NULL, 16384));
    ds4_session *old = w.session; old->value = 707;
    ds4_tokens_push(&w.transcript, 777); ds4_tokens_push(&w.transcript, 778);
    ds4_tokens_copy(&old->tokens, &w.transcript);
    w.session_title = strdup("Previous conversation");
    strcpy(w.session_sha, "previous"); w.session_created_at = 123;
    w.user_activity = true; w.session_dirty = false;
    if (save_failure) {
        free(w.session_title); w.session_title = NULL;
        w.session_created_at = 0; w.session_dirty = true;
        w.cache_dir = strdup(getenv("DS4UI_SESSION_CACHE_DIR")); assert(w.cache_dir);
    }
#ifdef DSTUDIO_RESET_QWEN38
    if (!save_failure) {
        w.images = calloc(1, sizeof(*w.images)); assert(w.images);
        w.image_count = w.image_cap = 1;
    }
    ds4_vision_span *prior_images = w.images;
#endif
    assert(!pthread_create(&w.thread, NULL, worker_main, &w));
    for (int i=0; !worker_is_initialized(&w, NULL) && i<5000; i++) usleep(1000);
    assert(worker_is_initialized(&w, NULL));
    create_fail = allocation;
    pthread_t input_thread; assert(!pthread_create(&input_thread, NULL, command_thread, &w));
    int owner_ok = 1, unchanged_during = 1, control_returned = 1, progress_seen = 1;
    if (!allocation && !save_failure) {
        wait_gate(&entered);
        pthread_mutex_lock(&w.mu);
        unchanged_during = w.session == old && old->value == 707 && transcript_is_old(&w) &&
            !strcmp(w.session_sha, "previous") && w.session_created_at == 123;
        pthread_mutex_unlock(&w.mu);
        owner_ok = pthread_equal(prepare_thread, w.thread);
        /* A command must have returned before releasing preparation. Waiting
         * for this marker tests the handoff, not how fast inference happens. */
        if (owner_ok) wait_gate(&command_returned);
        if (duplicate) {
            pthread_t other; assert(!pthread_create(&other, NULL, command_thread, &w));
            pthread_join(other, NULL);
        }
        pthread_mutex_lock(&gate_mu); control_returned = command_returned; pthread_mutex_unlock(&gate_mu);
        char *out = NULL; size_t length = 0; worker_consume(&w, &out, &length, NULL);
        progress_seen = out && strstr(out, "\"state\":\"prefill\""); free(out);
        if (cancel) worker_interrupt(&w);
        pthread_mutex_lock(&gate_mu); released = 1; pthread_cond_broadcast(&gate_cv); pthread_mutex_unlock(&gate_mu);
    }
    pthread_join(input_thread, NULL);
    for (int i=0; !worker_is_idle(&w) && i<5000; i++) usleep(1000);
    const int idle = worker_is_idle(&w);
    int final_ok;
    pthread_mutex_lock(&w.mu);
    if (save_failure)
        final_ok = w.session == old && old->value == 707 && transcript_is_old(&w) &&
            !strcmp(w.session_sha, "previous") && !w.session_title && !w.session_created_at &&
            w.user_activity && w.session_dirty;
    else if (cancel || late_cancel || sync_fail || allocation)
        final_ok = w.session == old && old->value == 707 && transcript_is_old(&w) &&
            !strcmp(w.session_sha, "previous") && w.session_created_at == 123 &&
            w.user_activity && !w.session_dirty;
    else
        final_ok = w.session != old && w.session->value == 909 &&
            !transcript_is_old(&w) && !w.session_sha[0] && !w.session_title &&
            !w.session_created_at && !w.user_activity && !w.session_dirty;
#ifdef DSTUDIO_RESET_QWEN38
    if (!save_failure) final_ok = final_ok && (cancel || late_cancel || sync_fail || allocation ?
        w.images == prior_images && w.image_count == 1 : !w.images && !w.image_count);
#endif
    pthread_mutex_unlock(&w.mu);
    worker_stop(&w); pthread_join(w.thread, NULL);
    int api_ok = 1;
#ifdef DSTUDIO_RESET_QWEN38
    api_ok = prepare_calls == ((allocation || save_failure) ? 0 : 1);
#endif
    const int passed = owner_ok && unchanged_during && control_returned && progress_seen && idle &&
        final_ok && peak_sessions <= 2 && live_sessions == 1 && api_ok;
    printf("{\"case\":\"%s\",\"passed\":%s,\"ownerOnly\":%d,\"unchangedDuring\":%d,"
        "\"controlReturned\":%d,\"progressBeforeRelease\":%d,\"idle\":%d,\"finalState\":%d,"
        "\"peakSessions\":%d,\"workerBytes\":%zu,\"preparationApi\":%d}\n", argv[1], passed ? "true":"false",
        owner_ok, unchanged_during, control_returned, progress_seen, idle, final_ok, peak_sessions, sizeof(w), api_ok);
    probe_free(w.session); assert(live_sessions == 0);
    ds4_tokens_free(&w.transcript); free(w.session_title); free(w.out); free(w.cache_dir);
#ifdef DSTUDIO_RESET_QWEN38
    agent_worker_images_clear(&w);
#endif
    pthread_cond_destroy(&w.cond); pthread_mutex_destroy(&w.mu);
    return passed ? 0 : 1;
}

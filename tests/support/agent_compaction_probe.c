/* Production compaction + real control methods, with a deterministic session
 * API. These tests establish publication/cancellation, not model quality,
 * tokenizer equivalence or numerical inference correctness. */
#include "ds4.h"
#include <assert.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

struct ds4_session {
    ds4_tokens tokens;
    int evaluated, invalidated, ctx;
    ds4_session_progress_fn progress;
    void *progress_ud;
    ds4_session_cancel_fn cancel;
    void *cancel_ud;
};
static pthread_mutex_t gate_mu = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t gate_cv = PTHREAD_COND_INITIALIZER;
static int sync_count, barrier_stage, entered, released, done;
static int fail_sync, cancel_sync, fail_eval, empty_summary, late_cancel, late_stop;
static int stale_session, stale_transcript, memory_failure;
static long preparation_delay_ns;
static void *active_worker;
static void invalidate_candidate(void);
static pthread_mutex_t *watched_mu;
static ds4_tokens *published_transcript;
static _Thread_local int owner_thread;
static _Thread_local double lock_started, lock_acquired;
static _Thread_local int *tokens_at_lock;
static double owner_wait, owner_hold_max, publication_wait, publication_hold;
static double prepare_seconds, control_seconds;
static int owner_locks, publications;
static double probe_clock(void) {
    struct timespec ts; clock_gettime(CLOCK_MONOTONIC, &ts);
    return (double)ts.tv_sec + (double)ts.tv_nsec / 1e9;
}
/* Instrument the executed mutex calls only in this probe. Production has no
 * per-lock timers. A pointer change under the owner lock identifies the actual
 * publication without parsing source text or adding production test hooks. */
static int probe_mutex_lock(pthread_mutex_t *mu) {
    double start = probe_clock();
    int rc = pthread_mutex_lock(mu);
    if (!rc && mu == watched_mu && owner_thread) {
        lock_started = start; lock_acquired = probe_clock();
        tokens_at_lock = published_transcript->v;
        owner_wait += lock_acquired - start; owner_locks++;
    }
    return rc;
}
static int probe_mutex_unlock(pthread_mutex_t *mu) {
    if (mu == watched_mu && owner_thread) {
        double hold = probe_clock() - lock_acquired;
        if (hold > owner_hold_max) owner_hold_max = hold;
        if (published_transcript->v != tokens_at_lock) {
            publications++;
            publication_wait += lock_acquired - lock_started;
            publication_hold += hold;
        }
    }
    return pthread_mutex_unlock(mu);
}

static bool probe_no(ds4_engine *e) { (void)e; return false; }
static bool probe_yes(ds4_engine *e) { (void)e; return true; }
static void probe_begin(ds4_engine *e, ds4_tokens *t) {
    (void)e; ds4_tokens_push(t, 100);
}
static void probe_message(ds4_engine *e, ds4_tokens *t, const char *role, const char *text) {
    (void)e; (void)text;
    ds4_tokens_push(t, !strcmp(role, "system") ? 101 : 102);
}
static void probe_prefix(ds4_engine *e, ds4_tokens *t, ds4_think_mode mode) {
    (void)e; (void)mode; ds4_tokens_push(t, 103);
}
static void probe_tokenize(ds4_engine *e, const char *text, ds4_tokens *t) {
    (void)e;
    ds4_tokens_push(t, !strcmp(text, "<｜User｜>") || !strcmp(text, "<|user|>") ? 102 : 104);
}
static int probe_user_token(ds4_engine *e) { (void)e; return 102; }
static int probe_assistant_token(ds4_engine *e) { (void)e; return 103; }
static char *probe_text(ds4_engine *e, int token, size_t *length) {
    (void)e;
#ifdef DSTUDIO_COMPACT_LAGUNA
    const char *user = "<user>", *assistant = "<assistant>";
#else
    const char *user = "<|im_start|>user\n", *assistant = "<|im_start|>assistant\n";
#endif
    const char *text = token == 102 ? user : token == 103 ? assistant :
                       token == 901 ? "summary-fixture" : " fixture";
    char *s = strdup(text);
    *length = strlen(s); return s;
}
static bool probe_stop(ds4_engine *e, int token, ds4_think_mode mode) {
    (void)e; (void)mode; return token == 900;
}
static int probe_ctx(ds4_session *s) { return s->ctx; }
static int probe_pos(ds4_session *s) { return s->tokens.len; }
static int probe_common(ds4_session *s, const ds4_tokens *t) {
    int n = 0;
    while (n < s->tokens.len && n < t->len && s->tokens.v[n] == t->v[n]) n++;
    return n;
}
static void probe_progress(ds4_session *s, ds4_session_progress_fn fn, void *ud) {
    s->progress = fn; s->progress_ud = ud;
}
static void probe_display(ds4_session *s, ds4_session_progress_fn fn, void *ud) {
    (void)s; (void)fn; (void)ud;
}
static void probe_cancel(ds4_session *s, ds4_session_cancel_fn fn, void *ud) {
    s->cancel = fn; s->cancel_ud = ud;
}
static int probe_argmax(ds4_session *s) { return empty_summary || s->evaluated ? 900 : 901; }
static int probe_eval(ds4_session *s, int token, char *err, size_t cap) {
    if (fail_eval) { snprintf(err, cap, "injected summary evaluation failure"); return 1; }
    s->evaluated++; ds4_tokens_push(&s->tokens, token); return 0;
}
static void probe_invalidate(ds4_session *s) {
    s->invalidated++; ds4_tokens_free(&s->tokens);
}
static int probe_sync(ds4_session *s, const ds4_tokens *tokens, char *err, size_t cap) {
    const double started = probe_clock();
    sync_count++;
    ds4_tokens_copy(&s->tokens, tokens);
    if (s->progress) s->progress(s->progress_ud, "prefill_chunk", 1, tokens->len);
    if (sync_count == barrier_stage) {
        pthread_mutex_lock(&gate_mu);
        entered = 1; pthread_cond_broadcast(&gate_cv);
        while (!released) pthread_cond_wait(&gate_cv, &gate_mu);
        pthread_mutex_unlock(&gate_mu);
        /* Simulate an API returning success just as control invalidates the
         * candidate. A cancellation callback check alone cannot cover this. */
        if (late_cancel || late_stop || stale_session || stale_transcript)
            invalidate_candidate();
    }
    prepare_seconds += probe_clock() - started;
    if (sync_count == cancel_sync && s->cancel && s->cancel(s->cancel_ud)) {
        snprintf(err, cap, "interrupted"); return DS4_SESSION_SYNC_INTERRUPTED;
    }
    if (sync_count == fail_sync) { snprintf(err, cap, "injected sync failure"); return 1; }
    return 0;
}

#define ds4_engine_is_glm_dsa probe_no
#ifdef DSTUDIO_COMPACT_LAGUNA
#define ds4_engine_is_laguna probe_yes
#else
#define ds4_engine_is_qwen35moe probe_yes
#endif
#define ds4_chat_begin probe_begin
#define ds4_chat_append_message probe_message
#define ds4_chat_append_assistant_prefix probe_prefix
#define ds4_tokenize_rendered_chat probe_tokenize
#define ds4_token_text probe_text
#define ds4_token_user probe_user_token
#define ds4_token_assistant probe_assistant_token
#define ds4_token_is_stop_for_think_mode probe_stop
#define ds4_session_ctx probe_ctx
#define ds4_session_pos probe_pos
#define ds4_session_common_prefix probe_common
#define ds4_session_set_progress probe_progress
#define ds4_session_set_display_progress probe_display
#define ds4_session_set_cancel probe_cancel
#define ds4_session_argmax probe_argmax
#define ds4_session_eval probe_eval
#define ds4_session_invalidate probe_invalidate
#define ds4_session_sync probe_sync
#define pthread_mutex_lock probe_mutex_lock
#define pthread_mutex_unlock probe_mutex_unlock
#define DS4_AGENT_TEST
#define DS4_AGENT_TEST_NO_MAIN
#include "ds4_agent.c"
#undef pthread_mutex_lock
#undef pthread_mutex_unlock

static ds4_session replacement = {.ctx = 4096};
static void invalidate_candidate(void) {
    agent_worker *w = active_worker;
    if (late_cancel) worker_interrupt(w);
    pthread_mutex_lock(&w->mu);
    if (late_stop) w->stop = true;
    if (stale_session) w->session = &replacement;
    if (stale_transcript) w->transcript.len--;
    pthread_mutex_unlock(&w->mu);
}
static bool compact_ok;
static char compact_error[256];
static void *compact_thread(void *arg) {
    owner_thread = 1;
    compact_ok = agent_worker_compact(arg, "controlled regression", compact_error, sizeof(compact_error));
    pthread_mutex_lock(&gate_mu);
    done = 1; pthread_cond_broadcast(&gate_cv);
    pthread_mutex_unlock(&gate_mu); return NULL;
}
static char *read_memory(void) {
    FILE *fp = fopen("MEMORY.MD", "rb");
    if (!fp) return NULL;
    char *s = calloc(1, 65537); assert(s);
    size_t n = fread(s, 1, 65536, fp);
    assert(!ferror(fp)); s[n] = 0; fclose(fp); return s;
}
static int same_tokens(const ds4_tokens *a, const ds4_tokens *b) {
    return a->len == b->len && !memcmp(a->v, b->v, (size_t)a->len * sizeof(*a->v));
}
int main(int argc, char **argv) {
    assert(argc == 2);
    const char *scenario = argv[1];
    fail_sync = !strcmp(scenario, "summary_failure") ? 1 : !strcmp(scenario, "rebuild_failure") ? 2 : 0;
    cancel_sync = !strcmp(scenario, "summary_cancel") ? 1 : !strcmp(scenario, "rebuild_cancel") ? 2 : 0;
    fail_eval = !strcmp(scenario, "summary_eval_failure");
    empty_summary = !strcmp(scenario, "empty_summary");
    late_cancel = !strcmp(scenario, "late_cancel");
    late_stop = !strcmp(scenario, "late_stop");
    stale_session = !strcmp(scenario, "stale_session");
    stale_transcript = !strcmp(scenario, "stale_transcript");
    memory_failure = !strcmp(scenario, "memory_failure");
    preparation_delay_ns = !strcmp(scenario, "delayed_20ms") ? 20000000L :
        !strcmp(scenario, "delayed_200ms") ? 200000000L : 0;
    const int success = !strcmp(scenario, "success") || memory_failure || preparation_delay_ns;
    assert(fail_sync || cancel_sync || fail_eval || empty_summary ||
           late_cancel || late_stop || stale_session || stale_transcript || success);
    barrier_stage = fail_sync == 1 || cancel_sync == 1 || fail_eval || empty_summary ? 1 : 2;
    agent_config cfg = {.jsonl = true, .non_interactive = true,
        .gen = {.ctx_size = 4096, .think_mode = DS4_THINK_NONE}};
    ds4_session session = {.ctx = 4096};
    agent_worker w = {.cfg = &cfg, .session = &session, .wake_fd = {-1, -1}};
    active_worker = &w;
    watched_mu = &w.mu; published_transcript = &w.transcript;
    assert(!pthread_mutex_init(&w.mu, NULL)); assert(!pthread_cond_init(&w.cond, NULL));
    agent_worker_build_system_tokens(&w, &w.transcript);
    ds4_tokens_push(&w.transcript, 102);
    for (int i = 0; i < 2000; i++) ds4_tokens_push(&w.transcript, 1000 + i);
    ds4_tokens before = {0}; ds4_tokens_copy(&before, &w.transcript);
    ds4_tokens_copy(&session.tokens, &w.transcript);
    w.last_system_prompt_reminder_at = 7;
    char *memory_before = read_memory(); assert(memory_before);
    pthread_t worker; assert(!pthread_create(&worker, NULL, compact_thread, &w));
    struct timespec until; clock_gettime(CLOCK_REALTIME, &until); until.tv_sec += 5;
    pthread_mutex_lock(&gate_mu);
    while (!entered && !done) assert(!pthread_cond_timedwait(&gate_cv, &gate_mu, &until));
    pthread_mutex_unlock(&gate_mu);
    assert(entered && !done);
    /* Stop/status consumption must finish while prefill is deliberately
     * blocked. The outer runner bounds the process independently. */
    const double control_start = probe_clock();
    pthread_mutex_lock(&w.mu);
    int unchanged_during = same_tokens(&w.transcript, &before) &&
        !w.session_dirty && w.last_system_prompt_reminder_at == 7 && w.session == &session;
    pthread_mutex_unlock(&w.mu);
    char *memory_during = read_memory(); assert(memory_during);
    int memory_unchanged_during = !strcmp(memory_before, memory_during);
    free(memory_during);
    char *out = NULL; size_t out_len = 0;
    worker_consume(&w, &out, &out_len, NULL);
    int control_progress = out && out_len; free(out);
    if (cancel_sync) worker_interrupt(&w);
    control_seconds = probe_clock() - control_start;
    if (memory_failure) {
        /* A concurrent filesystem failure, not a permission-dependent test.
         * Keep the previous file recoverable and prevent the export rename. */
        assert(!rename("MEMORY.MD", "PRIOR_MEMORY.MD"));
        assert(!mkdir("MEMORY.MD", 0700));
    }
    if (preparation_delay_ns) {
        struct timespec delay = {.tv_nsec = preparation_delay_ns};
        while (nanosleep(&delay, &delay)) assert(errno == EINTR);
    }
    pthread_mutex_lock(&gate_mu);
    released = 1; pthread_cond_broadcast(&gate_cv);
    pthread_mutex_unlock(&gate_mu);
    pthread_join(worker, NULL);
    int memory_ok = 0, warning_ok = 1;
    if (memory_failure) {
        struct stat st; memory_ok = !stat("MEMORY.MD", &st) && S_ISDIR(st.st_mode);
        worker_consume(&w, &out, &out_len, NULL);
        warning_ok = out && strstr(out, "MEMORY.MD could not be updated");
        free(out);
    } else {
        char *memory_after = read_memory(); assert(memory_after);
        memory_ok = success ? strstr(memory_after, "summary-fixture") != NULL :
            !strcmp(memory_before, memory_after);
        free(memory_after);
    }
    int tokens_ok;
    if (success) tokens_ok = !same_tokens(&w.transcript, &before) &&
        w.session_dirty && same_tokens(&w.transcript, &session.tokens) &&
        w.last_system_prompt_reminder_at == w.transcript.len;
    else {
        if (stale_transcript) before.len--;
        tokens_ok = same_tokens(&w.transcript, &before) &&
            !w.session_dirty && w.last_system_prompt_reminder_at == 7 &&
            session.invalidated > 0;
    }
    int identity_ok = w.session == (stale_session ? &replacement : &session);
    int publication_ok = publications == (success ? 1 : 0);
    int passed = compact_ok == success && unchanged_during && memory_unchanged_during &&
        control_progress && tokens_ok && identity_ok && memory_ok && warning_ok && publication_ok;
    printf("{\"case\":\"%s\",\"passed\":%s,\"result\":%s,\"unchangedDuring\":%d,"
        "\"memoryUnchangedDuring\":%d,\"controlProgress\":%d,\"tokens\":%d,"
        "\"identity\":%d,\"memory\":%d,\"warning\":%d,\"syncs\":%d,"
        "\"workerBytes\":%zu,\"sessionInvalidated\":%d,\"publications\":%d,"
        "\"profile\":{\"scope\":\"simulated preparation; instrumented native owner\","
        "\"prepareMs\":%.6f,\"controlMs\":%.6f,\"ownerLockCount\":%d,"
        "\"ownerWaitUs\":%.6f,\"ownerMaxHoldUs\":%.6f,"
        "\"publicationWaitUs\":%.6f,\"publicationHoldUs\":%.6f}}\n", scenario,
        passed ? "true" : "false", compact_ok ? "true" : "false", unchanged_during,
        memory_unchanged_during, control_progress, tokens_ok, identity_ok, memory_ok,
        warning_ok, sync_count, sizeof(w), session.invalidated, publications,
        prepare_seconds * 1000, control_seconds * 1000, owner_locks, owner_wait * 1e6,
        owner_hold_max * 1e6, publication_wait * 1e6, publication_hold * 1e6);
    if (compact_error[0]) fprintf(stderr, "%s\n", compact_error);
    ds4_tokens_free(&w.transcript); ds4_tokens_free(&before);
    ds4_tokens_free(&session.tokens); ds4_tokens_free(&replacement.tokens);
    free(memory_before); free(w.out);
    pthread_mutex_destroy(&w.mu); pthread_cond_destroy(&w.cond);
    return passed ? 0 : 1;
}

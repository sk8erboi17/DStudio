/* Production worker/command functions with one explicitly blocked power API.
 * No model or GPU is opened. Readiness must mean the owner is quiescent,
 * including the interval after it consumes a deferred request's queue flag. */
#include "ds4.h"
#include <assert.h>
#include <pthread.h>
#include <stdio.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

static pthread_mutex_t gate_mu = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t gate_cv = PTHREAD_COND_INITIALIZER;
static int entered, released, applied, applied_power;
static int probe_power(ds4_session *session, int power) {
    (void)session;
    pthread_mutex_lock(&gate_mu);
    entered = 1;
    pthread_cond_broadcast(&gate_cv);
    while (!released) pthread_cond_wait(&gate_cv, &gate_mu);
    applied++;
    applied_power = power;
    pthread_mutex_unlock(&gate_mu);
    return 0;
}
#define ds4_session_set_power probe_power
#define DS4_AGENT_TEST
#define DS4_AGENT_TEST_NO_MAIN
#include "agent-runtime.c"

static int checks, failures;
static void check(const char *name, bool ok) {
    checks++;
    failures += !ok;
    printf("{\"case\":\"%s\",\"passed\":%s}\n", name, ok ? "true" : "false");
}
static void wait_entered(void) {
    struct timespec deadline;
    clock_gettime(CLOCK_REALTIME, &deadline);
    deadline.tv_sec += 5;
    pthread_mutex_lock(&gate_mu);
    while (!entered) assert(!pthread_cond_timedwait(&gate_cv, &gate_mu, &deadline));
    pthread_mutex_unlock(&gate_mu);
}
static void discard_test_submission(agent_worker *w) {
    /* Baseline admissions are retained as failed checks. The worker has not
     * started, or is held at the fixture barrier, so fixture cleanup is safe. */
    pthread_mutex_lock(&w->mu);
    char *text = w->cmd_text;
    w->cmd_text = NULL;
    w->status.state = AGENT_WORKER_IDLE;
    pthread_mutex_unlock(&w->mu);
    free(text);
}

int main(void) {
    agent_config cfg = {.non_interactive = true, .jsonl = true,
                        .gen = {.raw_prompt = true, .ctx_size = 8192}};
    agent_worker w = {.cfg = &cfg, .initialized = true, .wake_fd = {-1, -1},
                      .status = {.state = AGENT_WORKER_IDLE}};
    assert(!pthread_mutex_init(&w.mu, NULL));
    assert(!pthread_cond_init(&w.cond, NULL));
    check("initially-quiescent", worker_is_idle(&w));
    worker_request_compact(&w);
    check("pending-compaction-not-ready", !worker_is_idle(&w));
    check("pending-compaction-rejects-turn", !worker_submit(&w, "must not run"));
    discard_test_submission(&w);
    assert(worker_take_compact_requested(&w));
    worker_request_save(&w);
    check("pending-save-not-ready", !worker_is_idle(&w));
    check("pending-save-rejects-turn", !worker_submit(&w, "must not run"));
    discard_test_submission(&w);
    assert(worker_take_save_requested(&w));
    worker_request_power(&w, 35);
    check("pending-power-not-ready", !worker_is_idle(&w));
    check("pending-power-rejects-turn", !worker_submit(&w, "must not run"));
    discard_test_submission(&w);
    assert(!pthread_create(&w.thread, NULL, worker_main, &w));
    wait_entered();
    pthread_mutex_lock(&w.mu);
    bool taken = !w.power_requested;
    pthread_mutex_unlock(&w.mu);
    check("deferred-operation-taken", taken);
    check("running-deferred-operation-not-ready", !worker_is_idle(&w));
    check("running-deferred-operation-rejects-turn", !worker_submit(&w, "must not run"));
    discard_test_submission(&w);
    bool responsive = true;
    for (int i = 0; i < 1000; i++) {
        agent_status status;
        worker_get_status(&w, &status);
        // The requested value is not effective before the blocked API returns.
        responsive &= status.power_percent == 100 && !worker_is_idle(&w);
    }
    check("control-available-while-preparation-blocked", responsive);
    worker_interrupt(&w);
    check("stop-latched-during-deferred-operation", worker_should_interrupt(&w));
    pthread_mutex_lock(&gate_mu);
    released = 1;
    pthread_cond_broadcast(&gate_cv);
    pthread_mutex_unlock(&gate_mu);
    for (int i = 0; !worker_is_idle(&w) && i < 5000; i++) usleep(1000);
    check("ready-only-after-worker-completion", worker_is_idle(&w));
    worker_stop(&w);
    pthread_join(w.thread, NULL);
    check("exactly-one-owner-operation", applied == 1 && applied_power == 35);
    check("shutdown-rejects-new-turn", !worker_submit(&w, "must not run"));
    check("shutdown-not-ready", !worker_is_idle(&w));
    free(w.out); w.out = NULL; w.out_len = w.out_cap = 0;
    agent_publish_system_status(&w, "Stopped by user");
    const char *stop = "\x1e{\"type\":\"runtime_notice\",\"text\":\"Stopped by user\"}\n";
    check("jsonl-stop-receipt", w.out && !strcmp(w.out, stop));
    if (w.out) fputs(w.out, stdout);
    free(w.out); w.out = NULL; w.out_len = w.out_cap = 0;
    agent_publish_system_status(&w, "Quote \" and newline\nCafé 日本語");
    check("jsonl-notice-escaped", w.out && !strcmp(w.out,
        "\x1e{\"type\":\"runtime_notice\",\"text\":\"Quote \\\" and newline\\nCafé 日本語\"}\n"));
    if (w.out) fputs(w.out, stdout);
    free(w.out); w.out = NULL; w.out_len = w.out_cap = 0;
    char oversized[1026]; memset(oversized, 'x', sizeof oversized - 1); oversized[1025] = 0;
    agent_publish_system_status(&w, oversized);
    check("jsonl-notice-bounded", w.out && strstr(w.out, "Runtime notice exceeds its display limit"));
    free(w.out); w.out = NULL; w.out_len = w.out_cap = 0;
    cfg.jsonl = false;
    agent_publish_system_status(&w, "Stopped by user");
    check("plain-pipe-keeps-service-messages-out-of-answer", !w.out_len);
    free(w.out);
    pthread_cond_destroy(&w.cond); pthread_mutex_destroy(&w.mu);
    printf("{\"case\":\"total\",\"passed\":%s,\"checks\":%d,\"failures\":%d,\"workerBytes\":%zu}\n",
           failures ? "false" : "true", checks, failures, sizeof(agent_worker));
    return failures ? 1 : 0;
}

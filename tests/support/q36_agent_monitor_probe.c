/* Real shell/monitor/control functions with one deterministic slow-disk barrier.
 * No model, GPU inference, browser, password or user process is involved. */
#include <errno.h>
#include <pthread.h>
#include <stdbool.h>
#include <stdio.h>
#include <string.h>
#include <time.h>
#include <unistd.h>
#include <signal.h>
#include <sys/wait.h>
#include <stdatomic.h>
#include <stdint.h>

static pthread_mutex_t probe_mu = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t probe_cond = PTHREAD_COND_INITIALIZER;
static bool probe_entered, probe_release, query_started, query_finished;
static bool signal_entered, signal_release, cancel_finished;
static bool cancel_case, signal_case, failure_case, terminal_case, terminal_timeout, thread_failure_case;
static pid_t failed_create_pid;
static char failed_create_path[1024];
static int partial_fd = -1;
static size_t query_bytes;
static double query_seconds;
static const char marker[] = "monitor-control-fixture\n";
static _Atomic(pthread_mutex_t *) watched_mu;
static atomic_ullong lock_count, lock_wait_ns, lock_hold_ns, lock_max_ns, output_prepare_ns;
static _Thread_local uint64_t held_since;

static uint64_t probe_ns(void) {
    struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t);
    return (uint64_t)t.tv_sec * 1000000000ULL + t.tv_nsec;
}

/* Profiling exists only in this compiled probe. The first native initialized
 * mutex belongs to the first job; the test worker mutex is initialized outside
 * these macros. No profiling code or atomics enter the production patch. */
static int probe_mutex_init(pthread_mutex_t *mu, const pthread_mutexattr_t *attr) {
    int rc = pthread_mutex_init(mu, attr);
    pthread_mutex_t *empty = NULL;
    if (!rc) atomic_compare_exchange_strong(&watched_mu, &empty, mu);
    return rc;
}

static int probe_mutex_lock(pthread_mutex_t *mu) {
    bool watched = mu == atomic_load(&watched_mu);
    uint64_t start = watched ? probe_ns() : 0;
    int rc = pthread_mutex_lock(mu);
    if (!rc && watched) {
        held_since = probe_ns();
        atomic_fetch_add(&lock_wait_ns, held_since - start);
        atomic_fetch_add(&lock_count, 1);
    }
    return rc;
}

static int probe_mutex_unlock(pthread_mutex_t *mu) {
    bool watched = mu == atomic_load(&watched_mu) && held_since;
    uint64_t elapsed = watched ? probe_ns() - held_since : 0;
    if (watched) held_since = 0;
    int rc = pthread_mutex_unlock(mu);
    if (!rc && watched) {
        atomic_fetch_add(&lock_hold_ns, elapsed);
        unsigned long long maximum = atomic_load(&lock_max_ns);
        while (elapsed > maximum && !atomic_compare_exchange_weak(&lock_max_ns, &maximum, elapsed)) {}
    }
    return rc;
}

static ssize_t probe_write(int fd, const void *data, size_t n) {
    if (n == sizeof(marker)-1 && !memcmp(data, marker, n)) {
        uint64_t start = probe_ns();
        pthread_mutex_lock(&probe_mu);
        probe_entered = true;
        pthread_cond_broadcast(&probe_cond);
        while (!probe_release) pthread_cond_wait(&probe_cond, &probe_mu);
        pthread_mutex_unlock(&probe_mu);
        ssize_t result;
        if (failure_case) {
            partial_fd = fd;
            result = write(fd, data, 5); /* Real short write, then injected ENOSPC. */
        } else result = write(fd, data, n);
        atomic_store(&output_prepare_ns, probe_ns() - start);
        return result;
    }
    if (failure_case && fd == partial_fd) { errno = ENOSPC; return -1; }
    return write(fd, data, n);
}

static int probe_kill(pid_t pid, int sig) {
    if (signal_case && pid < 0) {
        pthread_mutex_lock(&probe_mu);
        signal_entered = true; pthread_cond_broadcast(&probe_cond);
        while (!signal_release) pthread_cond_wait(&probe_cond, &probe_mu);
        pthread_mutex_unlock(&probe_mu);
    }
    return kill(pid, sig);
}

static int probe_thread_create(pthread_t *, const pthread_attr_t *, void *(*)(void *), void *);

#define write probe_write
#define kill probe_kill
#define pthread_create probe_thread_create
#define pthread_mutex_init probe_mutex_init
#define pthread_mutex_lock probe_mutex_lock
#define pthread_mutex_unlock probe_mutex_unlock
#define Q36_AGENT_TEST
#define Q36_AGENT_TEST_NO_MAIN
#include "q36_agent.c"
#undef write
#undef kill
#undef pthread_create
#undef pthread_mutex_init
#undef pthread_mutex_lock
#undef pthread_mutex_unlock

static int probe_thread_create(pthread_t *thread, const pthread_attr_t *attr,
                               void *(*fn)(void *), void *arg) {
    if (thread_failure_case && fn == agent_bash_monitor) {
        agent_bash_job *job = arg;
        failed_create_pid = job->pid;
        snprintf(failed_create_path, sizeof(failed_create_path), "%s", job->path);
        return EAGAIN;
    }
    return pthread_create(thread, attr, fn, arg);
}

static bool await_flag(const bool *flag, int milliseconds) {
    struct timespec deadline;
    clock_gettime(CLOCK_REALTIME, &deadline);
    deadline.tv_sec += milliseconds / 1000;
    deadline.tv_nsec += (milliseconds % 1000) * 1000000L;
    if (deadline.tv_nsec >= 1000000000L) {
        deadline.tv_sec++; deadline.tv_nsec -= 1000000000L;
    }
    pthread_mutex_lock(&probe_mu);
    while (!*flag) {
        int rc = pthread_cond_timedwait(&probe_cond, &probe_mu, &deadline);
        if (rc == ETIMEDOUT) break;
        if (rc) { pthread_mutex_unlock(&probe_mu); return false; }
    }
    bool result = *flag;
    pthread_mutex_unlock(&probe_mu);
    return result;
}

static void *query_job(void *arg) {
    pthread_mutex_lock(&probe_mu);
    query_started = true; pthread_cond_broadcast(&probe_cond);
    pthread_mutex_unlock(&probe_mu);
    uint64_t start = probe_ns();
    (void)agent_bash_is_running(arg); /* Actual production control accessor. */
    agent_bash_job *job = arg;
    pthread_mutex_lock(&job->mu);
    query_bytes = job->bytes;
    pthread_mutex_unlock(&job->mu);
    query_seconds = (probe_ns() - start) / 1e9;
    pthread_mutex_lock(&probe_mu);
    query_finished = true; pthread_cond_broadcast(&probe_cond);
    pthread_mutex_unlock(&probe_mu);
    return NULL;
}

static void *cancel_job(void *arg) {
#ifdef DSTUDIO_Q36_MONITOR_OWNER_TEST
    if (terminal_case) {
        /* Actual bounded handoff used by the password UI. Repeated failure
         * delivery cannot overwrite the first reason or duplicate its bytes. */
        agent_bash_terminal_failure(arg, terminal_timeout);
        agent_bash_terminal_failure(arg, !terminal_timeout);
    } else
#endif
    agent_bash_signal(arg, signal_case ? SIGTERM : SIGKILL);
    pthread_mutex_lock(&probe_mu);
    cancel_finished = true; pthread_cond_broadcast(&probe_cond);
    pthread_mutex_unlock(&probe_mu);
    return NULL;
}

static bool child_waitable(pid_t pid, int milliseconds) {
    double deadline = now_sec() + milliseconds / 1000.0;
    do {
        siginfo_t info = {0};
        int rc = waitid(P_PID, pid, &info, WEXITED | WNOHANG | WNOWAIT);
        if (!rc && info.si_pid == pid) return true;
        if (rc < 0 && errno != EINTR) return false;
        usleep(1000);
    } while (now_sec() < deadline);
    return false;
}

int main(int argc, char **argv) {
    cancel_case = argc == 2 && !strcmp(argv[1], "--cancel");
    signal_case = argc == 2 && !strcmp(argv[1], "--signal-race");
    failure_case = argc == 2 && !strcmp(argv[1], "--write-failure");
    thread_failure_case = argc == 2 && !strcmp(argv[1], "--thread-failure");
#ifdef DSTUDIO_Q36_MONITOR_OWNER_TEST
    terminal_case = argc == 2 && (!strcmp(argv[1], "--terminal-cancel") || !strcmp(argv[1], "--terminal-timeout"));
    terminal_timeout = terminal_case && !strcmp(argv[1], "--terminal-timeout");
#endif
    if (argc > 2 || (argc == 2 && !cancel_case && !signal_case && !failure_case && !terminal_case && !thread_failure_case)) return 2;
    agent_config cfg = {.non_interactive = true};
    agent_worker w = {0}; w.cfg = &cfg;
    pthread_mutex_init(&w.mu, NULL); pthread_cond_init(&w.cond, NULL);
    if (pipe(w.wake_fd) != 0) return 2;
    set_nonblock(w.wake_fd[0], true, NULL); set_nonblock(w.wake_fd[1], true, NULL);
    char err[160] = {0}, output_path[PATH_MAX];
    if (thread_failure_case) {
        int before = 0, after = 0;
        for (int fd = 0; fd < 4096; fd++) if (fcntl(fd, F_GETFD) >= 0) before++;
        agent_bash_job *failed = agent_bash_start(&w, "exec sleep 30", 5, err, sizeof(err));
        for (int fd = 0; fd < 4096; fd++) if (fcntl(fd, F_GETFD) >= 0) after++;
        errno = 0;
        bool reaped = failed_create_pid > 0 && waitpid(failed_create_pid, NULL, WNOHANG) == -1 && errno == ECHILD;
        bool passed = !failed && !w.bash_jobs && before == after && reaped &&
            failed_create_path[0] && access(failed_create_path, F_OK) == -1 && strstr(err, "shell monitor");
        printf("{\"case\":\"monitor-thread-creation-failure\",\"passed\":%s,\"childReaped\":%s,"
               "\"descriptorsBefore\":%d,\"descriptorsAfter\":%d}\n",
               passed?"true":"false", reaped?"true":"false", before, after);
        if (failed) agent_bash_remove_job(&w, failed);
        close(w.wake_fd[0]); close(w.wake_fd[1]);
        free(w.out); pthread_mutex_destroy(&w.mu); pthread_cond_destroy(&w.cond);
        return passed ? 0 : 1;
    }
    agent_bash_job *job = agent_bash_start(&w, cancel_case || failure_case || terminal_case ?
        "printf 'monitor-control-fixture\\n'; exec sleep 30" :
        "printf 'monitor-control-fixture\\n'", 5, err, sizeof(err));
    if (!job) { fprintf(stderr, "%s\n", err); return 2; }
    snprintf(output_path, sizeof(output_path), "%s", job->path);
    bool barrier = await_flag(&probe_entered, 3000);
    pthread_t canceller;
    int cancel_rc = -1;
    if (cancel_case || signal_case || terminal_case)
        cancel_rc = pthread_create(&canceller, NULL, cancel_job, job);
    bool signal_barrier = !signal_case || (!cancel_rc && await_flag(&signal_entered, 1000));
    int lock = barrier ? pthread_mutex_trylock(&job->mu) : -1;
    if (!lock) pthread_mutex_unlock(&job->mu);
    pthread_t query;
    int query_rc = pthread_create(&query, NULL, query_job, job);
    bool started = !query_rc && await_flag(&query_started, 1000);
    // The fixed barrier establishes the phase; trylock distinguishes shared
    // lock ownership from mere scheduling noise in this bounded observation.
    bool control = started && await_flag(&query_finished, 250);
    bool unpublished = control && query_bytes == 0;
    bool cancelled_during_io = !(cancel_case || terminal_case) || (!cancel_rc && await_flag(&cancel_finished, 250));
    bool exited_during_io = !(cancel_case || terminal_case) || (cancelled_during_io && child_waitable(job->pid, 250));
    /* A distinct real job must finish while this monitor is parked. */
    agent_bash_job *other = agent_bash_start(&w, "printf independent-output", 3, err, sizeof(err));
    bool independent = false;
    if (other) {
        agent_bash_refresh_for(&w, other, 1);
        bool complete = false;
        char *observed = agent_bash_observation(other, false, &complete);
        independent = complete && strstr(observed, "exit_status=0") && strstr(observed, "independent-output");
        free(observed);
        char other_path[PATH_MAX]; snprintf(other_path, sizeof(other_path), "%s", other->path);
        agent_bash_remove_job(&w, other); unlink(other_path);
    }
    pthread_mutex_lock(&probe_mu);
    probe_release = true; pthread_cond_broadcast(&probe_cond);
    pthread_mutex_unlock(&probe_mu);
    bool held_pid = true;
    if (signal_case) {
        /* Let the monitor see EOF while the signal syscall remains parked.
         * The exited child must remain waitable, protecting its PID/PGID. */
        held_pid = signal_barrier && child_waitable(job->pid, 250);
        usleep(100000);
        held_pid = held_pid && child_waitable(job->pid, 1);
        pthread_mutex_lock(&probe_mu);
        signal_release = true; pthread_cond_broadcast(&probe_cond);
        pthread_mutex_unlock(&probe_mu);
    }
    if (!cancel_rc) pthread_join(canceller, NULL);
    if (!query_rc) pthread_join(query, NULL);
    agent_bash_refresh_for(&w, job, 3);
    bool done = !agent_bash_is_running(job);
    if (job->thread_started && done) {
        pthread_join(job->thread, NULL); job->thread_started = false;
    }
    FILE *file = fopen(output_path, "rb"); char bytes[128] = {0};
    size_t read_bytes = file ? fread(bytes, 1, sizeof(bytes), file) : 0;
    if (file) fclose(file);
    char expected[128];
    snprintf(expected, sizeof(expected), "%s%s", marker, terminal_case ? (terminal_timeout ?
        "Password entry timed out.\n" : "Password entry cancelled or unavailable.\n") : "");
    bool output_ok = read_bytes == (failure_case ? 5 : strlen(expected)) && !memcmp(bytes, expected, read_bytes);
    bool normal = done && job->exit_status == (cancel_case || failure_case || terminal_case ? 128 + SIGKILL : 0);
    bool metadata = done && job->bytes == read_bytes &&
        job->newline_count == (failure_case ? 0 : terminal_case ? 2 : 1) &&
        job->output_error == (failure_case ? ENOSPC : 0) && job->timed_out == terminal_timeout;
    errno = 0;
    bool reaped_once = done && waitpid(job->pid, NULL, WNOHANG) == -1 && errno == ECHILD;
    bool bounded_polling = atomic_load(&lock_count) < 256;
    bool passed = atomic_load(&watched_mu) == &job->mu && bounded_polling &&
        barrier && started && lock == 0 && control && unpublished && independent &&
        normal && output_ok && metadata && reaped_once && signal_barrier && held_pid &&
        cancelled_during_io && exited_during_io;
    printf("{\"case\":\"%s\",\"passed\":%s,"
           "\"barrierReached\":%s,\"queryStarted\":%s,\"mutexAvailableDuringIO\":%s,"
           "\"controlCompletedDuringIO\":%s,\"expectedExit\":%s,\"outputPreserved\":%s,"
           "\"unpublishedBeforeWrite\":%s,\"independentJobCompleted\":%s,\"metadataCorrect\":%s,"
           "\"reapedExactlyOnce\":%s,\"signalBarrier\":%s,\"pidHeldDuringSignal\":%s,"
           "\"cancelCompletedDuringIO\":%s,\"childExitedDuringIO\":%s,\"queryMilliseconds\":%.6f,"
           "\"boundedMonitorPolling\":%s,"
           "\"profile\":{\"jobLockCount\":%llu,\"jobLockWaitMs\":%.6f,\"jobLockHoldMs\":%.6f,"
           "\"maxJobLockHoldMs\":%.6f,\"outputPreparationWithInjectedWaitMs\":%.6f},"
           "\"jobBytes\":%zu,\"workerBytes\":%zu}\n",
           terminal_case ? (terminal_timeout ? "terminal-timeout-handoff" : "terminal-cancel-handoff") :
               cancel_case ? "cancel-during-blocked-write" : signal_case ? "signal-exit-race" :
               failure_case ? "partial-write-then-failure" : "blocked-output-keeps-control-accessible",
           passed?"true":"false", barrier?"true":"false", started?"true":"false",
           lock==0?"true":"false", control?"true":"false", normal?"true":"false",
           output_ok?"true":"false", unpublished?"true":"false", independent?"true":"false",
           metadata?"true":"false", reaped_once?"true":"false", signal_barrier?"true":"false",
           held_pid?"true":"false", cancelled_during_io?"true":"false", exited_during_io?"true":"false",
           query_seconds * 1000, bounded_polling?"true":"false",
           atomic_load(&lock_count), atomic_load(&lock_wait_ns) / 1e6,
           atomic_load(&lock_hold_ns) / 1e6, atomic_load(&lock_max_ns) / 1e6,
           atomic_load(&output_prepare_ns) / 1e6, sizeof(*job), sizeof(w));
    agent_bash_remove_job(&w, job);
    unlink(output_path); /* Only the output file created by this test's job. */
    close(w.wake_fd[0]); close(w.wake_fd[1]);
    free(w.out);
    pthread_mutex_destroy(&w.mu); pthread_cond_destroy(&w.cond);
    return passed ? 0 : 1;
}

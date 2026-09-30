/* Production owner ticks with real task-owned child processes and pipe barriers.
 * The clock advances four hours without spending GPU time or hiding a failure.
 * This is lifecycle/cancellation verification, not inference quality. */
#define _GNU_SOURCE
#include <time.h>
#include <sys/time.h>
static long long work_elapsed_seconds;
static int work_clock_gettime(clockid_t id, struct timespec *out) {
    int rc = clock_gettime(id, out);
    if (!rc && id == CLOCK_MONOTONIC) out->tv_sec += work_elapsed_seconds;
    return rc;
}
static int work_gettimeofday(struct timeval *out, void *zone) {
    int rc = gettimeofday(out, zone);
    if (!rc) out->tv_sec += work_elapsed_seconds;
    return rc;
}
#define gettimeofday work_gettimeofday
#define clock_gettime work_clock_gettime
#define main dstudio_embedded_main
#include "../../src/dstudio.c"
#undef main
#undef clock_gettime
#undef gettimeofday

static pid_t owned[8];
static size_t owned_count;
static void cleanup(void) {
    for (size_t i = 0; i < owned_count; i++) {
        int status;
        if (waitpid(owned[i], &status, WNOHANG) == 0) {
            kill(owned[i], SIGKILL);
            while (waitpid(owned[i], &status, 0) < 0 && errno == EINTR) {}
        }
    }
}
static void require(int ok, const char *why) {
    if (!ok) { fprintf(stderr, "FAIL: %s\n", why); exit(1); }
}
static pid_t blocked_child(void) {
    int barrier[2]; require(!pipe(barrier), "child barrier");
    pid_t pid = fork(); require(pid >= 0, "owned child");
    if (!pid) {
        close(barrier[0]); setpgid(0, 0);
        (void)write(barrier[1], "R", 1);
        for (;;) pause();
    }
    owned[owned_count++] = pid;
    close(barrier[1]); char ready;
    require(read(barrier[0], &ready, 1) == 1 && ready == 'R', "worker is blocked");
    close(barrier[0]); return pid;
}
static void tick_until_reaped(void (*tick)(void), pid_t pid) {
    struct timespec start, now; clock_gettime(CLOCK_MONOTONIC, &start);
    do {
        tick();
        if (kill(pid, 0) < 0 && errno == ESRCH) return;
        usleep(1000); clock_gettime(CLOCK_MONOTONIC, &now);
    } while (now.tv_sec - start.tv_sec < 3);
    require(0, "canceled owned process is reaped");
}
static void loading(void) {
    work_elapsed_seconds = 0;
    pid_t pid = blocked_child(); int owner[2];
    require(!socketpair(AF_UNIX, SOCK_STREAM, 0, owner), "loading owner socket");
    set_nonblock(owner[0]);
    memset(&g_q36, 0, sizeof g_q36);
    g_q36.pid = pid; g_q36.owner = owner[0]; g_q36.output = g_q36.errors = -1;
    g_q36.deadline = dstudio_now_ms() + 120000;
    g_q36.spec.cfg.ctx = 8192; g_q36.spec.cfg.port = 42001;
    cstr_copy(g_q36.spec.model_identity, sizeof g_q36.spec.model_identity, "opened-model");
    work_elapsed_seconds = 4 * 60 * 60;
    q36_tick();
    require(q36_running() && !g_q36.stopping && !q36_ready() && !g_q36.error[0],
            "four hours of loading is still loading, not failure or readiness");
    json_dyn_buf receipt = {0};
    require(json_dyn_printf(&receipt,
        "{\"version\":1,\"event\":\"ready\",\"pid\":%d,\"host\":\"127.0.0.1\",\"port\":42001,"
        "\"context\":8192,\"model\":\"qwen3.8-27b\",\"backend\":\"metal\",\"cache_k\":\"f16\","
        "\"cache_v\":\"f16\",\"ssd_streaming\":false,\"model_file\":\"opened-model\","
        "\"vision_file\":\"\",\"mtp_file\":\"\"}\n", (int)pid), "late readiness receipt");
    require(fd_write_all(owner[1], receipt.ptr, receipt.len), "send actual readiness bytes");
    free(receipt.ptr); q36_tick(); require(q36_ready(), "valid late readiness publishes");
    q36_request_stop("Unit-test Stop");
    work_elapsed_seconds += 5;
    tick_until_reaped(q36_tick, pid);
    require(!q36_running(), "Stop still drains a slow engine"); close(owner[1]);
}
static void preparation(void) {
    work_elapsed_seconds = 0;
    pid_t pid = blocked_child(); int output[2], errors[2];
    require(!pipe(output) && !pipe(errors), "preparation channels");
    set_nonblock(output[0]); set_nonblock(errors[0]);
    launch_job *j = calloc(1, sizeof *j); require(j != NULL, "preparation record");
    j->worker = pid; j->client = j->guard = -1;
    j->output = output[0]; j->errors = errors[0]; j->result = calloc(1, LAUNCH_RESULT_MAX);
    require(j->result != NULL, "bounded preparation result");
    j->deadline = dstudio_now_ms() + 900000;
    g_launch = j;
    work_elapsed_seconds = 4 * 60 * 60;
    launch_preparation_tick();
    require(g_launch == j && !j->canceled && !j->killed && !j->failure[0],
            "four hours of preparation does not cancel the worker or publish a result");
    launch_cancel("Unit-test Stop"); work_elapsed_seconds += 6;
    tick_until_reaped(launch_preparation_tick, pid);
    require(!g_launch, "Stop retires preparation after its bounded cancellation grace");
    close(output[1]); close(errors[1]);
}
static void inference(void) {
    work_elapsed_seconds = 0;
    int runtime[2], output[2]; require(!pipe(runtime) && !pipe(output), "inference channels");
    set_nonblock(runtime[0]); set_nonblock(output[0]);
    g_child = getpid(); g_in_fd = runtime[1];
    model_rpc_relay *j = model_rpc_new_relay(41, strdup("{}"));
    require(j != NULL, "production relay admission");
    pid_t pid = blocked_child(); j->worker = pid; j->output = output[0]; g_model_rpc = j;
    work_elapsed_seconds = 4 * 60 * 60;
    model_rpc_tick();
    require(g_model_rpc == j && !j->stopping && !j->have_final && !j->canceled,
            "four silent hours do not produce a model error or stop its worker");
    const char final[] = "F\n{\"type\":\"model_done\",\"id\":41}\n";
    /* The same real worker framing used in production, with exact byte count. */
    char frame[256]; int n = snprintf(frame, sizeof frame, "F %zu\n%s", strlen(final + 2), final + 2);
    require(n > 0 && fd_write_all(output[1], frame, (size_t)n), "late complete frame");
    for (int i = 0; i < 100 && !j->have_final; i++) model_rpc_tick();
    require(j->have_final && !j->canceled, "late response reaches its owner");
    tick_until_reaped(model_rpc_tick, pid);
    for (int i = 0; i < 100 && g_model_rpc; i++) model_rpc_tick();
    require(!g_model_rpc, "completed relay retires");
    char received[256] = ""; ssize_t len = read(runtime[0], received, sizeof received - 1);
    require(len > 0 && strstr(received, "model_done") && !strstr(received, "model_error"), "late result is delivered exactly once");
    close(output[1]);
    require(!pipe(output), "second inference barrier"); set_nonblock(output[0]);
    j = model_rpc_new_relay(42, strdup("{}")); require(j != NULL, "second relay admission");
    pid = blocked_child(); j->worker = pid; j->output = output[0]; g_model_rpc = j;
    work_elapsed_seconds += 4 * 60 * 60;
    model_rpc_tick(); require(!j->stopping && !j->have_final, "slow canceled turn still awaits inference");
    require(fd_write_all(output[1], frame, (size_t)n), "queue a late response behind Stop");
    model_rpc_cancel(); work_elapsed_seconds += 2;
    tick_until_reaped(model_rpc_tick, pid);
    for (int i = 0; i < 100 && g_model_rpc; i++) model_rpc_tick();
    require(!g_model_rpc, "Stop reaps the silent model helper");
    require(read(runtime[0], received, sizeof received) < 0 && errno == EAGAIN,
            "canceled late response cannot publish into the runtime pipe");
    close(output[1]); close(runtime[0]); close(runtime[1]); g_in_fd = -1; g_child = -1;
}
static void shared_loading(void) {
    work_elapsed_seconds = 0;
    char lock_path[] = "/tmp/dstudio-slow-lock-XXXXXX";
    int lock = mkstemp(lock_path), barrier[2];
    require(lock >= 0 && !pipe(barrier), "private shared-engine lock/barrier");
    pid_t pid = fork(); require(pid >= 0, "private shared-engine fixture");
    if (!pid) {
        close(barrier[0]); require(!flock(lock, LOCK_EX), "fixture owns private model lock");
        char identity[32]; int n = snprintf(identity, sizeof identity, "%d\n", (int)getpid());
        require(pwrite(lock, identity, (size_t)n, 0) == n, "lock owner identity");
        (void)write(barrier[1], "R", 1); for (;;) pause();
    }
    owned[owned_count++] = pid; close(lock); close(barrier[1]);
    char ready; require(read(barrier[0], &ready, 1) == 1, "shared owner barrier"); close(barrier[0]);
    require(!setenv("DS4_LOCK_FILE", lock_path, 1), "isolate the shared-engine lock");
    int reserve = socket(AF_INET, SOCK_STREAM, 0);
    struct sockaddr_in address = {.sin_family = AF_INET, .sin_addr.s_addr = htonl(INADDR_LOOPBACK)};
    require(reserve >= 0 && !bind(reserve, (struct sockaddr *)&address, sizeof address), "reserve an unopened fixture port");
    socklen_t size = sizeof address;
    require(!getsockname(reserve, (struct sockaddr *)&address, &size), "reserved port identity");
    engine_cfg cfg = g_cfg; cfg.port = ntohs(address.sin_port);
    reuse_external_ds4(&cfg, 0, pid);
    unsigned long long task_id = task_begin("launch", "Wait for shared fixture", "server", ENGINE_SERVER, "", (int)pid, 1);
    g_active_launch_task = task_id; g_active_launch_mode = ENGINE_SERVER;
    work_elapsed_seconds = 4 * 60 * 60;
    int http[2]; require(!socketpair(AF_UNIX, SOCK_STREAM, 0, http), "real status response");
    api_status(http[1]); close(http[1]);
    char bytes[32768]; ssize_t n = read(http[0], bytes, sizeof bytes - 1); close(http[0]);
    require(n > 0, "HTTP status returned while shared model still loads"); bytes[n] = 0;
    require(strstr(bytes, "\"running\":true") && strstr(bytes, "\"ready\":false") &&
            g_external_server && !g_engine_err[0], "four-hour shared loading remains alive and unready");
    require(!socketpair(AF_UNIX, SOCK_STREAM, 0, http), "wrong cancellation response");
    char request[128]; snprintf(request, sizeof request, "{\"taskId\":%llu}", task_id + 1);
    api_launch_cancel(http[1], request); close(http[1]);
    n = read(http[0], bytes, sizeof bytes - 1); close(http[0]); require(n > 0, "wrong cancellation replied"); bytes[n] = 0;
    require(strstr(bytes, "409") && g_external_server && kill(pid, 0) == 0, "wrong task cannot detach or stop the shared engine");
    require(!socketpair(AF_UNIX, SOCK_STREAM, 0, http), "matching cancellation response");
    snprintf(request, sizeof request, "{\"taskId\":%llu}", task_id);
    api_launch_cancel(http[1], request); close(http[1]);
    n = read(http[0], bytes, sizeof bytes - 1); close(http[0]); require(n > 0, "matching cancellation replied"); bytes[n] = 0;
    require(strstr(bytes, "200") && !g_external_server && !g_active_launch_task &&
            !strcmp(task_find(task_id)->status, "canceled") && kill(pid, 0) == 0,
            "Cancel retires only its launch wait and leaves the shared engine alive");
    reuse_external_ds4(&cfg, 0, pid);
    g_active_launch_task = task_begin("launch", "Second wait", "server", ENGINE_SERVER, "", (int)pid, 1);
    require(!socketpair(AF_UNIX, SOCK_STREAM, 0, http), "Stop wait response");
    api_stop(http[1]); close(http[1]);
    n = read(http[0], bytes, sizeof bytes - 1); close(http[0]); require(n > 0, "Stop wait replied"); bytes[n] = 0;
    require(strstr(bytes, "200") && !g_external_server && kill(pid, 0) == 0, "Stop also cancels only the shared-engine wait");
    close(reserve); unlink(lock_path); unsetenv("DS4_LOCK_FILE");
}
int main(void) {
    signal(SIGPIPE, SIG_IGN); atexit(cleanup);
    loading(); preparation(); inference(); shared_loading();
    puts("slow_runtime: PASS — four-hour simulated loading, preparation and inference; late readiness/result; bounded Stop and reap");
    return 0;
}

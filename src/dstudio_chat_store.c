/* The HTTP owner grants one store-write lease (64 MiB maximum). The worker
 * owns the immutable candidate and performs JSON validation/file I/O without
 * host locks. While the lease exists, writes/wipe are refused as busy; reads
 * retain the prior revision. Only the HTTP owner publishes the result/ack.
 * No worker ever reads g_store or writes to a client socket. */
typedef struct {
    char *body;
    size_t len;
    long revision;
    long long clear_epoch;
    int client, wipe, done, ok, published, invalid, error_number, joined;
    char path[DSTUDIO_PATH_MAX];
#ifdef _WIN32
    HANDLE thread;
#else
    pthread_t thread;
#endif
} chat_store_write;
static chat_store_write *g_store_write;
#ifdef _WIN32
static SRWLOCK g_store_write_lock = SRWLOCK_INIT;
#define STORE_LOCK() AcquireSRWLockExclusive(&g_store_write_lock)
#define STORE_UNLOCK() ReleaseSRWLockExclusive(&g_store_write_lock)
#else
static pthread_mutex_t g_store_write_lock = PTHREAD_MUTEX_INITIALIZER;
#define STORE_LOCK() pthread_mutex_lock(&g_store_write_lock)
#define STORE_UNLOCK() pthread_mutex_unlock(&g_store_write_lock)
#endif
#ifdef DSTUDIO_CHAT_STORE_TEST
static void (*g_store_before_publish)(void);
static int g_store_test_write_failure, g_store_test_directory_failure;
#endif

static int chat_store_write_file(chat_store_write *job) {
    char dir[DSTUDIO_PATH_MAX], temp[DSTUDIO_PATH_MAX + 80];
    snprintf(dir, sizeof dir, "%s", job->path);
    char *slash = strrchr(dir, '/');
#ifdef _WIN32
    char *backslash = strrchr(dir, '\\');
    if (!slash || (backslash && backslash > slash)) slash = backslash;
#endif
    if (!slash) { errno = EINVAL; return 0; }
    *slash = 0;
    mkpath(dir);
#ifdef _WIN32
    int n = snprintf(temp, sizeof temp, "%s.tmp-%ld-%ld-%llu", job->path, (long)getpid(), job->revision + 1, (unsigned long long)GetTickCount64());
#else
    int n = snprintf(temp, sizeof temp, "%s.tmp-XXXXXX", job->path);
#endif
    if (n < 0 || (size_t)n >= sizeof temp) { errno = ENAMETOOLONG; return 0; }
#ifdef _WIN32
    int file = _open(temp, _O_CREAT | _O_EXCL | _O_WRONLY | _O_BINARY, _S_IREAD | _S_IWRITE);
#else
    int file = mkstemp(temp);
    if (file >= 0) (void)fcntl(file, F_SETFD, FD_CLOEXEC);
#endif
    if (file < 0) return 0;
    int ok = 1, saved_errno = 0;
    for (size_t offset = 0; offset < job->len;) {
        size_t count = job->len - offset;
        if (count > 65536) count = 65536;
#ifdef _WIN32
        int wrote = _write(file, job->body + offset, (unsigned)count);
#else
        ssize_t wrote = write(file, job->body + offset, count);
#endif
        if (wrote < 0 && errno == EINTR) continue;
        if (wrote <= 0) { ok = 0; saved_errno = errno ? errno : EIO; break; }
        offset += (size_t)wrote;
    }
#ifdef _WIN32
    if (ok && _commit(file)) { ok = 0; saved_errno = errno; }
    if (_close(file) && ok) { ok = 0; saved_errno = errno; }
#else
    if (ok && fsync(file)) { ok = 0; saved_errno = errno; }
    if (close(file) && ok) { ok = 0; saved_errno = errno; }
    int directory = ok ? open(dir, O_RDONLY | O_DIRECTORY | O_CLOEXEC) : -1;
    if (ok && directory < 0) { ok = 0; saved_errno = errno; }
#endif
#ifdef DSTUDIO_CHAT_STORE_TEST
    if (ok && g_store_before_publish) g_store_before_publish();
    if (ok && g_store_test_write_failure) { ok = 0; saved_errno = EIO; }
#endif
    if (ok) {
#ifdef _WIN32
        if (!MoveFileExA(temp, job->path, MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)) {
            ok = 0; saved_errno = EIO;
        }
#else
        if (rename(temp, job->path)) { ok = 0; saved_errno = errno; }
#endif
        else job->published = 1;
    }
#ifndef _WIN32
    if (ok && fsync(directory)) { ok = 0; saved_errno = errno; }
#ifdef DSTUDIO_CHAT_STORE_TEST
    if (ok && g_store_test_directory_failure) { ok = 0; saved_errno = EIO; }
#endif
    if (directory >= 0) close(directory);
#endif
    if (!job->published) unlink(temp);
    errno = saved_errno;
    return ok;
}

#ifdef _WIN32
static DWORD WINAPI chat_store_worker(LPVOID context) {
#else
static void *chat_store_worker(void *context) {
#endif
    chat_store_write *job = context;
    char error[160];
    int invalid = memchr(job->body, 0, job->len) != NULL ||
        !dtg_json_validate_complete(job->body, '{', error, sizeof error);
    int ok = !invalid && chat_store_write_file(job);
    int error_number = ok ? 0 : (errno ? errno : EIO);
    STORE_LOCK();
    job->invalid = invalid; job->ok = ok; job->error_number = error_number;
    job->done = 1;
    STORE_UNLOCK();
    return 0;
}

/* A deferred response transfers client/body ownership to this lease. */
static int chat_store_begin(int client, char *body, size_t len, long revision, int wipe, long long clear_epoch) {
    if (g_store_write) {
        free(body);
        send_json(client, "409 Conflict", "{\"ok\":false,\"code\":\"store_busy\",\"error\":\"A conversation save is already in progress\"}");
        return 0;
    }
    if (revision >= 0 && revision != g_store_rev) {
        free(body);
        send_json(client, "409 Conflict", "{\"ok\":false,\"code\":\"store_conflict\",\"error\":\"Conversation history changed; merge it before saving\"}");
        return 0;
    }
    chat_store_write *job = calloc(1, sizeof *job);
    if (!job) { free(body); send_json(client, "503 Service Unavailable", "{\"ok\":false,\"error\":\"Conversation save could not be prepared\"}"); return 0; }
    job->body = body; job->len = len; job->client = client;
    job->revision = g_store_rev; job->wipe = wipe;
    job->clear_epoch = clear_epoch;
#ifdef _WIN32
    SetHandleInformation((HANDLE)(intptr_t)client, HANDLE_FLAG_INHERIT, 0);
#else
    (void)fcntl(client, F_SETFD, FD_CLOEXEC);
#endif
    store_file_path(job->path, sizeof job->path);
    g_store_write = job;
#ifdef _WIN32
    job->thread = CreateThread(NULL, 0, chat_store_worker, job, 0, NULL);
    int started = job->thread != NULL;
#else
    int started = pthread_create(&job->thread, NULL, chat_store_worker, job) == 0;
#endif
    if (!started) {
        g_store_write = NULL; free(body); free(job);
        send_json(client, "503 Service Unavailable", "{\"ok\":false,\"error\":\"Conversation save worker could not start\"}");
    }
    return started;
}

static void chat_store_wipe_committed(int client, long long clear_epoch);
static void chat_store_tick(void) {
    chat_store_write *job = g_store_write;
    if (!job) return;
    STORE_LOCK(); int done = job->done; STORE_UNLOCK();
    if (!done) return;
    /* This deferred endpoint is loopback-only. Do not inherit ambient CORS
     * state from a different request handled while the disk worker ran. */
    int reply_cors = g_reply_cors;
    char origin[sizeof g_cors_origin]; memcpy(origin, g_cors_origin, sizeof origin);
    g_reply_cors = 0; g_cors_origin[0] = 0;
#ifdef _WIN32
    if (!job->joined) WaitForSingleObject(job->thread, INFINITE);
    CloseHandle(job->thread);
#else
    if (!job->joined) pthread_join(job->thread, NULL);
#endif
    /* The exclusive lease prevents revision drift, including during wipe.
     * Rename followed by a failed directory sync is explicitly uncertain:
     * memory follows the published file, but the response never claims durability. */
    if (job->published && g_store_rev == job->revision) {
        free(g_store); g_store = job->body; g_store_len = job->len;
        job->body = NULL; g_store_rev++;
    }
    if (job->ok && g_store_rev == job->revision + 1) {
        if (job->wipe) chat_store_wipe_committed(job->client, job->clear_epoch);
        else {
            char response[96];
            snprintf(response, sizeof response, "{\"ok\":true,\"durable\":true,\"rev\":%ld}", g_store_rev);
            send_json(job->client, "200 OK", response);
        }
    } else {
        char response[256];
        snprintf(response, sizeof response,
            "{\"ok\":false,\"code\":\"%s\",\"errno\":%d,\"error\":\"%s\"}",
            job->invalid ? "store_invalid" : job->published ? "store_durability_unknown" : "store_write_failed",
            job->error_number, job->invalid ? "Invalid conversation JSON" : "The local app could not durably save conversation history");
        send_json(job->client, job->invalid ? "400 Bad Request" : "503 Service Unavailable", response);
    }
    close(job->client); free(job->body); free(job); g_store_write = NULL;
    g_reply_cors = reply_cors; memcpy(g_cors_origin, origin, sizeof origin);
}

static void chat_store_shutdown(void) {
    if (!g_store_write) return;
#ifdef _WIN32
    WaitForSingleObject(g_store_write->thread, INFINITE);
#else
    /* join occurs in tick after the worker has signaled completion. Shutdown
     * may wait for an admitted save; the interactive loop never does. */
    pthread_join(g_store_write->thread, NULL);
    g_store_write->joined = 1;
#endif
    chat_store_tick();
}

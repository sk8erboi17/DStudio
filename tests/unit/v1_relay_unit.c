/* Production relay on actual sockets. The poll shim supplies 601 idle ticks
 * behind a deterministic barrier; no model or ten-minute sleep is involved. */
#define _GNU_SOURCE
#include <assert.h>
#include <pthread.h>
#include <poll.h>
#include <sys/socket.h>
#include <time.h>
#include <unistd.h>
static int engine_target, client_target, idle_ticks;
static pthread_mutex_t barrier_mu = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t barrier_cv = PTHREAD_COND_INITIALIZER;
static int waiting;
static int relay_poll(struct pollfd *fds, nfds_t n, int timeout) {
    if (n == 2 && fds[0].fd == engine_target && fds[1].fd == client_target) {
        pthread_mutex_lock(&barrier_mu);
        if (idle_ticks < 601) {
            idle_ticks++;
            pthread_mutex_unlock(&barrier_mu);
            return 0;
        }
        waiting = 1;
        pthread_cond_signal(&barrier_cv);
        pthread_mutex_unlock(&barrier_mu);
    }
    return poll(fds, n, timeout);
}
#define poll relay_poll
#define main dstudio_embedded_main_for_tests
#include "../../src/dstudio.c"
#undef main
#undef poll

static int cors;
static void *relay(void *unused) {
    (void)unused;
    relay_engine_response(client_target, engine_target, cors);
    close(engine_target); close(client_target);
    return NULL;
}
static pthread_t start(int engine[2], int client[2], int allow_cors) {
    int listener = socket(AF_INET, SOCK_STREAM, 0);
    struct sockaddr_in address = {.sin_family = AF_INET, .sin_addr.s_addr = htonl(INADDR_LOOPBACK)};
    assert(listener >= 0 && !bind(listener, (struct sockaddr *)&address, sizeof address) && !listen(listener, 1));
    socklen_t size = sizeof address;
    assert(!getsockname(listener, (struct sockaddr *)&address, &size));
    engine[0] = socket(AF_INET, SOCK_STREAM, 0);
    assert(engine[0] >= 0 && !connect(engine[0], (struct sockaddr *)&address, sizeof address));
    engine[1] = accept(listener, NULL, NULL); assert(engine[1] >= 0); close(listener);
    assert(!socketpair(AF_UNIX, SOCK_STREAM, 0, client));
    engine_target = engine[0]; client_target = client[0];
    idle_ticks = waiting = 0; cors = allow_cors;
    /* Even an inherited, expired receive deadline cannot end a silent prefill. */
    struct timeval tv = {0, 1000};
    assert(!setsockopt(engine[0], SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof tv));
    pthread_t thread; assert(!pthread_create(&thread, NULL, relay, NULL));
    pthread_mutex_lock(&barrier_mu);
    struct timespec deadline; assert(!clock_gettime(CLOCK_REALTIME, &deadline)); deadline.tv_sec += 5;
    while (!waiting) assert(!pthread_cond_timedwait(&barrier_cv, &barrier_mu, &deadline));
    assert(idle_ticks == 601);
    pthread_mutex_unlock(&barrier_mu);
    return thread;
}
static size_t receive_all(int fd, char *out, size_t cap) {
    size_t n = 0;
    while (n < cap) {
        struct pollfd p = {fd, POLLIN, 0}; assert(poll(&p, 1, 5000) > 0);
        ssize_t got = read(fd, out + n, cap - n);
        assert(got >= 0); if (!got) return n; n += (size_t)got;
    }
    assert(0 && "response exceeded test bound"); return n;
}
int main(void) {
    signal(SIGPIPE, SIG_IGN);
    for (int c = 0; c < 2; c++) {
        int e[2], p[2]; pthread_t thread = start(e, p, c);
        const char h[] = "HTTP/1.1 503 Service Unavailable\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n";
        const char b[] = "{\"error\":\"preserved\"}\n\0binary\303\250";
        assert(!send_all(e[1], h, 13)); assert(!send_all(e[1], h + 13, sizeof h - 1 - 13));
        assert(!send_all(e[1], b, sizeof b - 1)); close(e[1]);
        char out[1024]; size_t n = receive_all(p[1], out, sizeof out); close(p[1]);
        assert(!pthread_join(thread, NULL));
        const char extra[] = "\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Methods: GET, POST, OPTIONS\r\nAccess-Control-Allow-Headers: Content-Type, Accept, X-Requested-With";
        char expected[1024]; size_t len = sizeof h - 1 - 4;
        memcpy(expected, h, len);
        if (c) { memcpy(expected + len, extra, sizeof extra - 1); len += sizeof extra - 1; }
        memcpy(expected + len, "\r\n\r\n", 4); len += 4;
        memcpy(expected + len, b, sizeof b - 1); len += sizeof b - 1;
        assert(n == len && !memcmp(out, expected, len));
    }
    /* Disconnect before response headers: the backend socket closes promptly,
     * allowing its existing cancellation path to observe the abandoned call. */
    int e[2], p[2]; pthread_t thread = start(e, p, 0); close(p[1]);
    char byte; struct pollfd peer = {e[1], POLLIN, 0};
    assert(poll(&peer, 1, 5000) > 0);
    assert(read(e[1], &byte, 1) < 0 && errno == ECONNRESET); close(e[1]);
    assert(!pthread_join(thread, NULL));
    puts("PASS: silent prefill, exact fragmented/error/binary response, CORS, TCP reset cancels abandoned inference");
    return 0;
}

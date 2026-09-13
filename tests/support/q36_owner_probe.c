/* Run native lifetime/control/receipt functions in real isolated processes.
 * The deliberate load barrier replaces model computation, never the owner
 * protocol, opened-file evidence, signals, socket writes or OS process lifetime. */
#define Q36_SERVER_TEST
#define Q36_SERVER_TEST_NO_MAIN
#include "q36_server.c"

q36_engine *dstudio_owner_fixture(const char *, const char *, const char *);
q36_session *dstudio_owner_fixture_session(void);
int dstudio_owner_identity_failure_preserves(q36_engine *);

int main(int argc, char **argv) {
    if (argc < 2) return 2;
    const char *mode = argv[1];
    if (!strcmp(mode, "exec-closed"))
        return fcntl(3, F_GETFD) == -1 && errno == EBADF ? 0 : 1;
    if (!strcmp(mode, "parse")) {
        server_config c = parse_options(argc - 1, argv + 1);
        printf("%d\n", c.dstudio_owner_fd);
        return 0;
    }
    signal(SIGPIPE, SIG_IGN);
    struct sigaction sa = {0};
    sa.sa_handler = stop_signal_handler;
    sigemptyset(&sa.sa_mask);
    sigaction(SIGTERM, &sa, NULL);
    sigaction(SIGINT, &sa, NULL);
    if (!strcmp(mode, "disabled")) return dstudio_owner_start(-1) ? 0 : 1;
    int fd = !strcmp(mode, "stdio") ? 1 : 3;
    if (!dstudio_owner_start(fd)) return 2;
    if (!strcmp(mode, "invalid")) return 1; /* must have rejected above */
    if (!strcmp(mode, "flags")) {
        if (!(fcntl(3, F_GETFD) & FD_CLOEXEC) || !(fcntl(3, F_GETFL) & O_NONBLOCK)) return 1;
        pid_t child = fork();
        if (child < 0) return 1;
        if (!child) { execl(argv[0], argv[0], "exec-closed", (char *)NULL); _exit(2); }
        int status;
        if (waitpid(child, &status, 0) != child) return 1;
        return WIFEXITED(status) && !WEXITSTATUS(status) ? 0 : 1;
    }
    if (argc < 3) return 2;
    q36_engine *engine = dstudio_owner_fixture(argv[2], argc > 3 ? argv[3] : NULL,
                                             argc > 4 ? argv[4] : NULL);
    if (!strcmp(mode, "bad-identity"))
        return dstudio_owner_identity_failure_preserves(engine) ? 0 : 1;
    puts("preparing"); fflush(stdout);
    /* The test controls this barrier through a separate inherited pipe. */
    if (!strcmp(mode, "blocked")) for (;;) pause();
    char go;
    ssize_t n;
    do { n = read(4, &go, 1); } while (n < 0 && errno == EINTR && !g_stop_requested);
    if (g_stop_requested) return 130;
    if (n != 1 || go != 'G') return 3;
    if (!strcmp(mode, "cancelled")) g_stop_requested = 1;
    int congested[2] = {-1, -1};
    if (!strcmp(mode, "saturated")) {
        /* Neither endpoint is exposed to Node's eager socket read buffer. */
        if (socketpair(AF_UNIX, SOCK_STREAM, 0, congested) ||
            fcntl(congested[0], F_SETFL, O_NONBLOCK)) return 4;
        fd = congested[0];
        int small = 1024;
        setsockopt(fd, SOL_SOCKET, SO_SNDBUF, &small, sizeof small);
        char bytes[1024]; memset(bytes, 'x', sizeof bytes);
        size_t total = 0;
        while (write(fd, bytes, sizeof bytes) > 0) {
            total += sizeof bytes;
            if (total > 1024 * 1024) return 4;
        }
        /* A rejected 1 KiB write can leave room for the smaller receipt. Fill
         * the remaining socket credit too; no consumer reads this fixture. */
        while (write(fd, bytes, 1) > 0)
            if (++total > 1024 * 1024) return 4;
    }
    int listener = !strcmp(mode, "bad-listener") ? -1 : listen_on("127.0.0.1", 0);
    bool ready = dstudio_owner_ready(fd, listener, engine, dstudio_owner_fixture_session());
    if (congested[0] >= 0) { close(congested[0]); close(congested[1]); }
    if (listener >= 0) close(listener);
    if (!strcmp(mode, "cancelled") || !strcmp(mode, "saturated") || !strcmp(mode, "bad-listener"))
        return ready ? 1 : 0;
    if (!ready) return 5;
    puts("ready"); fflush(stdout);
    while (!g_stop_requested) poll(NULL, 0, 10);
    return 0;
}

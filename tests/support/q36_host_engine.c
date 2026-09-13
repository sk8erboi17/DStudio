/* A deliberately controllable protocol peer for the real DStudio launcher.
 * No tensors, GPU, model loading or inference are simulated as quality evidence. */
#define _GNU_SOURCE
#include <assert.h>
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <unistd.h>

static const char *arg(int argc, char **argv, const char *key) {
    for (int i = 1; i + 1 < argc; i++) if (!strcmp(argv[i], key)) return argv[i+1];
    return NULL;
}
static void identity(const char *file, char out[192]) {
    int fd = open(file, O_RDONLY); struct stat s;
    assert(fd >= 0 && !fstat(fd, &s));
#ifdef __APPLE__
    long mn = s.st_mtimespec.tv_nsec, cn = s.st_ctimespec.tv_nsec;
#else
    long mn = s.st_mtim.tv_nsec, cn = s.st_ctim.tv_nsec;
#endif
    snprintf(out, 192, "%llu:%llu:%lld:%lld:%ld:%lld:%ld", (unsigned long long)s.st_dev,
        (unsigned long long)s.st_ino, (long long)s.st_size, (long long)s.st_mtime, mn, (long long)s.st_ctime, cn);
    close(fd);
}
int main(int argc, char **argv) {
    if (argc == 2 && !strcmp(argv[1], "--help")) return 0;
    signal(SIGPIPE, SIG_IGN);
    const char *owner_arg = arg(argc, argv, "--dstudio-owner-fd");
    assert(owner_arg && atoi(owner_arg) == 3);
    assert(!getenv("Q36_UNQUALIFIED_OVERRIDE"));
    const char *model = arg(argc, argv, "--model"), *vision = arg(argc, argv, "--vision");
    const char *context = arg(argc, argv, "--ctx"), *port = arg(argc, argv, "--port");
    assert(model && vision && context && port);
    char mi[192], vi[192], mode[64] = "valid"; identity(model, mi); identity(vision, vi);
    FILE *f = fopen("fixture-mode", "r"); if (f) { assert(fscanf(f, "%63s", mode) == 1); fclose(f); }
    f = fopen("fixture-launches", "a"); assert(f); fprintf(f, "%ld\n", (long)getpid()); fclose(f);
    const char *space = arg(argc, argv, "--kv-disk-space-mb");
    const char *minimum = arg(argc, argv, "--kv-cache-min-tokens");
    assert(space && minimum);
    f = fopen("fixture-config.json", "w"); assert(f);
    fprintf(f, "{\"pid\":%ld,\"port\":%d,\"ctx\":%d,\"kvSpaceMb\":%d,\"kvMinTokens\":%d}\n",
        (long)getpid(), atoi(port), atoi(context), atoi(space), atoi(minimum));
    fclose(f);
    f = fopen("fixture-entered", "w"); assert(f); fprintf(f, "%ld\n", (long)getpid()); fclose(f);
    /* Deliberately expose a listener and misleading log BEFORE authentication. */
    int server = socket(AF_INET, SOCK_STREAM, 0); assert(server >= 0);
    int on = 1; setsockopt(server, SOL_SOCKET, SO_REUSEADDR, &on, sizeof on);
    struct sockaddr_in address = {.sin_family = AF_INET, .sin_port = htons(atoi(port)), .sin_addr.s_addr = htonl(INADDR_LOOPBACK)};
    assert(!bind(server, (struct sockaddr *)&address, sizeof address) && !listen(server, 8));
    puts("ready: server listening; this log is not a readiness receipt"); fflush(stdout);
    int sent = 0, held = -1;
    for (;;) {
        struct pollfd fds[2] = {{.fd = 3, .events = POLLIN}, {.fd = server, .events = POLLIN}};
        assert(poll(fds, 2, 10) >= 0 || errno == EINTR);
        if (fds[0].revents & (POLLIN | POLLHUP | POLLERR)) {
            char byte;
            if (read(3, &byte, 1) <= 0) {
                if (!strcmp(mode, "ignore-close")) { for (;;) pause(); }
                if (!strcmp(mode, "hold-upload")) {
                    FILE *closed = fopen("fixture-owner-closed", "w"); assert(closed);
                    fputs("owner gone, native teardown deliberately blocked\n", closed); fclose(closed);
                    while (access("fixture-drain-release", F_OK)) usleep(1000);
                }
                close(server); return 0;
            }
        }
        if (fds[1].revents & POLLIN) {
            int fd = accept(server, NULL, NULL);
            if (fd >= 0) {
                FILE *accepted = fopen("fixture-accepted", "w"); assert(accepted);
                fprintf(accepted, "connected\n"); fclose(accepted);
                if (!strcmp(mode, "hold-upload") && held < 0) {
                    held = fd; assert(fcntl(held, F_SETFL, O_NONBLOCK) == 0);
                } else {
                    const char reply[] = "HTTP/1.1 200 OK\r\nContent-Length: 11\r\nConnection: close\r\n\r\n{\"ok\":true}";
                    (void)write(fd, reply, sizeof reply - 1); close(fd);
                }
            }
        }
        if (held >= 0) {
            char data[4096]; ssize_t n = read(held, data, sizeof data);
            if (n > 0) {
                FILE *received = fopen("fixture-upload", "w"); assert(received);
                fprintf(received, "relay delivered request bytes\n"); fclose(received);
            }
        }
        if (!sent && !access("fixture-release", F_OK)) {
            char frame[1536];
            int n = snprintf(frame, sizeof frame,
                "{\"version\":1,\"event\":\"ready\",\"pid\":%ld,\"host\":\"127.0.0.1\",\"port\":%s,\"context\":%s,"
                "\"model\":\"qwen3.8-27b\",\"backend\":\"metal\",\"cache_k\":\"f16\",\"cache_v\":\"f16\","
                "\"ssd_streaming\":false,\"model_file\":\"%s\",\"vision_file\":\"%s\",\"mtp_file\":\"\"}\n",
                (long)getpid() + (!strcmp(mode, "wrong-pid") ? 1 : 0), port, context, mi, vi);
            assert(n > 0 && n < (int)sizeof frame);
            if (!strcmp(mode, "fragment")) {
                assert(write(3, frame, 17) == 17); usleep(50000);
                if (write(3, frame + 17, (size_t)n - 17) < 0) return 0;
            } else if (write(3, frame, (size_t)n) < 0) return 0;
            if (!strcmp(mode, "duplicate")) (void)write(3, frame, (size_t)n);
            if (!strcmp(mode, "exit")) return 19;
            sent = 1;
        }
    }
}

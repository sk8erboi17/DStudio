/* app.cc — entry point of DStudio as a native-window application.
 *
 * On startup it forks: the CHILD runs the HTTP server (ds4_serve_main, from
 * dstudio.c) and supervises the ds4 engine; the PARENT opens the webview window
 * pointed at http://127.0.0.1:PORT and, on close, terminates the child.
 *
 * Headless: with DS4UI_NO_WINDOW=1 no window — classic headless-server behavior
 * (useful for binding on the LAN or for use from a remote terminal).
 *
 * Compiled as Objective-C++ on macOS, C++ on Linux (see Makefile).
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <signal.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <sys/wait.h>
#include "webview.h"

extern "C" int ds4_serve_main(int argc, char **argv);
/* Set by us before forking so the server (ds4_serve_main) binds the SAME free port we open. */
extern "C" int ds4ui_forced_port;

/* Pick the first FREE port at/after `start` (test-bind on 127.0.0.1). Without this, if 5500 is
 * squatted (e.g. a leftover Django runserver) the server can't bind and the window opens onto the
 * squatter (or nothing) — a blank screen. With it, DStudio just opens on the next free port. */
static int pick_free_port(int start) {
    for (int p = start; p <= start + 40 && p <= 65535; p++) {
        int fd = socket(AF_INET, SOCK_STREAM, 0);
        if (fd < 0) return start;
        int on = 1; setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &on, sizeof on);
        struct sockaddr_in a;
        memset(&a, 0, sizeof a);
        a.sin_family = AF_INET;
        a.sin_port = htons((uint16_t)p);
        inet_pton(AF_INET, "127.0.0.1", &a.sin_addr);
        int ok = bind(fd, (struct sockaddr *)&a, sizeof a) == 0;
        close(fd);   /* a bind+close with no connections releases immediately (no TIME_WAIT) */
        if (ok) return p;
    }
    return start;
}

static int port_from_argv(int argc, char **argv) {
    if (argc > 1) {
        char *end = NULL;
        long p = strtol(argv[1], &end, 10);
        if (end != argv[1] && *end == '\0' && p >= 1 && p <= 65535) return (int)p;
    }
    return 5500;
}

/* Wait until the server accepts connections on 127.0.0.1:port. */
static int wait_for_port(int port, int timeout_ms) {
    for (int waited = 0; waited <= timeout_ms; waited += 100) {
        int fd = socket(AF_INET, SOCK_STREAM, 0);
        if (fd < 0) return 0;
        struct sockaddr_in a;
        memset(&a, 0, sizeof a);
        a.sin_family = AF_INET;
        a.sin_port = htons((uint16_t)port);
        inet_pton(AF_INET, "127.0.0.1", &a.sin_addr);
        int r = connect(fd, (struct sockaddr *)&a, sizeof a);
        close(fd);
        if (r == 0) return 1;
        usleep(100 * 1000);
    }
    return 0;
}

static pid_t g_server_pid = 0;
static void stop_server(void) {
    if (g_server_pid > 0) { kill(g_server_pid, SIGTERM); g_server_pid = 0; }
}

int main(int argc, char **argv) {
    /* Batch/CLI modes and windowless mode run the server entry DIRECTLY — no
     * fork, no window. Otherwise the parent would wait for a server the batch
     * child never starts, then open a window (the --build-jsonl "hang"). */
    if (getenv("DS4UI_NO_WINDOW") ||
        (argc > 1 && (!strcmp(argv[1], "--build-jsonl") || !strcmp(argv[1], "--check-anchors"))))
        return ds4_serve_main(argc, argv);

    int port = pick_free_port(port_from_argv(argc, argv));
    ds4ui_forced_port = port;   /* the forked server binds THIS port (set before fork → inherited) */
    if (port != port_from_argv(argc, argv))
        fprintf(stderr, "DStudio: port %d busy — opening on %d instead\n", port_from_argv(argc, argv), port);

    pid_t pid = fork();
    if (pid < 0) { perror("fork"); return 1; }
    if (pid == 0) {
        /* child: HTTP server + engine supervision only */
        _exit(ds4_serve_main(argc, argv));
    }

    g_server_pid = pid;
    atexit(stop_server);   /* [NSApp terminate] calls exit() → here we stop the server */

    if (!wait_for_port(port, 8000))
        fprintf(stderr, "DStudio: server not ready yet on :%d, opening the window anyway\n", port);

    char url[64];
    snprintf(url, sizeof url, "http://127.0.0.1:%d", port);

    webview_t w = webview_create(1280, 860, "DS4");
    webview_navigate(w, url);
    webview_run(w);   /* blocks while the window stays open */

    stop_server();
    waitpid(pid, NULL, 0);
    return 0;
}

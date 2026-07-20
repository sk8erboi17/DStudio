/* app.cc — entry point of DStudio as a native-window application.
 *
 * On startup it forks: the CHILD runs the HTTP server (ds4_serve_main, from
 * dstudio.c) and supervises the ds4 engine; the PARENT opens the webview window
 * pointed at the local loading gate and, on close, terminates the child.
 *
 * Headless: with DS4UI_NO_WINDOW=1 no window — classic headless-server behavior
 * (useful for binding on the LAN or for use from a remote terminal).
 *
 * Compiled as Objective-C++ on macOS, C++ on Linux (see Makefile).
 */
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <string.h>
#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#else
#include <unistd.h>
#include <signal.h>
#include <fcntl.h>
#include <sys/file.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <sys/wait.h>
#endif
#include "webview.h"

extern "C" int ds4_serve_main(int argc, char **argv);
/* Set by us before forking so the server (ds4_serve_main) binds the SAME free port we open. */
extern "C" int ds4ui_forced_port;

#ifdef _WIN32
typedef SOCKET app_socket_t;
#define APP_INVALID_SOCKET INVALID_SOCKET
static void wsa_start(void) {
    static int started = 0;
    if (!started) { WSADATA w; WSAStartup(MAKEWORD(2, 2), &w); started = 1; }
}
#else
typedef int app_socket_t;
#define APP_INVALID_SOCKET (-1)
#endif

/* Pick the first FREE port at/after `start` for the host the server will bind.
 * Without this, if 5500 is
 * squatted (e.g. a leftover Django runserver) the server can't bind and the window opens onto the
 * squatter (or nothing) — a blank screen. With it, DStudio just opens on the next free port. */
static int pick_free_port(const char *host, int start) {
#ifdef _WIN32
    wsa_start();
#endif
    const char *bind_host = (host && host[0]) ? host : "127.0.0.1";
    for (int p = start; p <= start + 40 && p <= 65535; p++) {
        app_socket_t fd = socket(AF_INET, SOCK_STREAM, 0);
        if (fd == APP_INVALID_SOCKET) return start;
        int on = 1;
        setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, (const char *)&on, sizeof on);
        struct sockaddr_in a;
        memset(&a, 0, sizeof a);
        a.sin_family = AF_INET;
        a.sin_port = htons((uint16_t)p);
        if (inet_pton(AF_INET, bind_host, &a.sin_addr) != 1) {
#ifdef _WIN32
            closesocket(fd);
#else
            close(fd);
#endif
            return start;
        }
        int ok = bind(fd, (struct sockaddr *)&a, sizeof a) == 0;
#ifdef _WIN32
        closesocket(fd);
#else
        close(fd);   /* a bind+close with no connections releases immediately (no TIME_WAIT) */
#endif
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
#ifdef _WIN32
    wsa_start();
#endif
    for (int waited = 0; waited <= timeout_ms; waited += 100) {
        app_socket_t fd = socket(AF_INET, SOCK_STREAM, 0);
        if (fd == APP_INVALID_SOCKET) return 0;
        struct sockaddr_in a;
        memset(&a, 0, sizeof a);
        a.sin_family = AF_INET;
        a.sin_port = htons((uint16_t)port);
        inet_pton(AF_INET, "127.0.0.1", &a.sin_addr);
        int r = connect(fd, (struct sockaddr *)&a, sizeof a);
#ifdef _WIN32
        closesocket(fd);
        if (r == 0) return 1;
        Sleep(100);
#else
        close(fd);
        if (r == 0) return 1;
        usleep(100 * 1000);
#endif
    }
    return 0;
}

#ifdef _WIN32
static HANDLE g_instance_mutex = NULL;
static int acquire_single_instance_lock(void) {
    g_instance_mutex = CreateMutexA(NULL, TRUE, "Local\\DStudioSingleInstance");
    if (!g_instance_mutex) return 1; /* fail open: do not lock users out on OS errors */
    if (GetLastError() == ERROR_ALREADY_EXISTS) {
        CloseHandle(g_instance_mutex);
        g_instance_mutex = NULL;
        return 0;
    }
    return 1;
}
static void release_single_instance_lock(void) {
    if (g_instance_mutex) {
        ReleaseMutex(g_instance_mutex);
        CloseHandle(g_instance_mutex);
        g_instance_mutex = NULL;
    }
}
#else
static int g_instance_lock_fd = -1;
static int acquire_single_instance_lock(void) {
    const char *tmp = getenv("TMPDIR");
    if (!tmp || !tmp[0]) tmp = "/tmp";
    char path[512];
    snprintf(path, sizeof path, "%s/dstudio-%ld.lock", tmp, (long)getuid());
    int fd = open(path, O_RDWR | O_CREAT, 0600);
    if (fd < 0) return 1; /* fail open: a broken tmp dir should not brick startup */
    fcntl(fd, F_SETFD, FD_CLOEXEC); /* never let an exec'd child inherit/hold the lock */
    if (flock(fd, LOCK_EX | LOCK_NB) != 0) {
        close(fd);
        return 0;
    }
    char buf[64];
    int n = snprintf(buf, sizeof buf, "%ld\n", (long)getpid());
    ftruncate(fd, 0);
    if (n > 0) (void)write(fd, buf, (size_t)n);
    g_instance_lock_fd = fd;
    return 1;
}
static void release_single_instance_lock(void) {
    if (g_instance_lock_fd >= 0) {
        close(g_instance_lock_fd);
        g_instance_lock_fd = -1;
    }
}
#endif

#ifdef _WIN32
static HANDLE g_server_proc = NULL;
static void stop_server(void) {
    if (g_server_proc) {
        TerminateProcess(g_server_proc, 0);
        CloseHandle(g_server_proc);
        g_server_proc = NULL;
    }
}

static void quote_arg(char *cmd, size_t cap, const char *arg) {
    size_t o = strlen(cmd);
    if (o && o + 1 < cap) cmd[o++] = ' ';
    if (o + 1 >= cap) return;
    cmd[o++] = '"';
    for (const char *p = arg ? arg : ""; *p && o + 3 < cap; p++) {
        if (*p == '"' || *p == '\\') cmd[o++] = '\\';
        cmd[o++] = *p;
    }
    if (o + 1 < cap) cmd[o++] = '"';
    cmd[o] = '\0';
}

static int spawn_server_process(int argc, char **argv, int port) {
    char exe[MAX_PATH];
    DWORD n = GetModuleFileNameA(NULL, exe, sizeof exe);
    if (n == 0 || n >= sizeof exe) return 0;
    char cmd[32768] = "";
    quote_arg(cmd, sizeof cmd, exe);
    quote_arg(cmd, sizeof cmd, "--serve-child");
    char ports[16];
    snprintf(ports, sizeof ports, "%d", port);
    quote_arg(cmd, sizeof cmd, ports);
    for (int i = 2; i < argc; i++) quote_arg(cmd, sizeof cmd, argv[i]);
    STARTUPINFOA si;
    PROCESS_INFORMATION pi;
    memset(&si, 0, sizeof si);
    memset(&pi, 0, sizeof pi);
    si.cb = sizeof si;
    BOOL ok = CreateProcessA(NULL, cmd, NULL, NULL, FALSE,
                             CREATE_NO_WINDOW, NULL, NULL, &si, &pi);
    if (!ok) return 0;
    CloseHandle(pi.hThread);
    g_server_proc = pi.hProcess;
    return 1;
}
#else
static pid_t g_server_pid = 0;
static void stop_server(void) {
    pid_t pid = g_server_pid;
    if (pid <= 0) return;
    g_server_pid = 0;   /* idempotent: webview_run return + atexit both call this */
    /* The server child is a process-group LEADER (see setpgid after the fork), so
     * its group holds the HTTP child, the ds4 engine it supervises AND any
     * streaming relay/worker subprocesses. Signal the whole GROUP — not just the
     * child — so a running chat/agent/design generation is actually torn down when
     * the window closes, instead of being orphaned and left holding the GPU. */
    kill(-pid, SIGTERM);   /* graceful: the child's handler stops the engine + saves KV */
    kill(pid, SIGTERM);    /* belt-and-suspenders if setpgid did not take */
    for (int i = 0; i < 8; i++) {   /* up to ~800ms grace, but return early once gone */
        if (waitpid(pid, NULL, WNOHANG) == pid) return;   /* exited cleanly → engine already stopped */
        usleep(100 * 1000);
    }
    kill(-pid, SIGKILL);   /* still running (busy mid-generation) → force the whole group down */
    kill(pid, SIGKILL);
    waitpid(pid, NULL, 0);
}
#endif

int main(int argc, char **argv) {
    /* Batch/CLI modes and windowless mode run the server entry DIRECTLY — no
     * fork, no window. Otherwise the parent would wait for a server the batch
     * child never starts, then open a window (the --build-jsonl "hang"). */
#ifdef _WIN32
    if ((argc > 1 && !strcmp(argv[1], "--serve-child"))) {
        char **child_argv = argv + 1;
        child_argv[0] = argv[0];
        return ds4_serve_main(argc - 1, child_argv);
    }
#endif
    if (getenv("DS4UI_NO_WINDOW") || getenv("DS4UI_TEST_MODE") ||
        (argc > 1 && (!strcmp(argv[1], "--build-jsonl") || !strcmp(argv[1], "--check-anchors"))))
        return ds4_serve_main(argc, argv);

    if (!acquire_single_instance_lock()) {
        fprintf(stderr, "DStudio: another instance is already running; not opening a second window.\n");
        return 0;
    }
    atexit(release_single_instance_lock);

    const char *bind_host = getenv("DS4UI_HOST");
    if (!bind_host || !bind_host[0]) bind_host = "127.0.0.1";
    int requested_port = port_from_argv(argc, argv);
    int port = pick_free_port(bind_host, requested_port);
    ds4ui_forced_port = port;   /* the forked server binds THIS port (set before fork → inherited) */
    if (port != requested_port)
        fprintf(stderr, "DStudio: port %d busy on %s — opening on %d instead\n", requested_port, bind_host, port);

    /* The native loading page owns engine startup because it can read the
     * user's persisted browser settings (ctx/power/SSD mode/model). Starting
     * here would race ahead with the C defaults and make a saved `Off` appear
     * as an effective `Auto` runtime. The server child inherits this flag. */
#ifdef _WIN32
    _putenv_s("DS4UI_DEFER_ENGINE_START", "1");
#else
    setenv("DS4UI_DEFER_ENGINE_START", "1", 1);
#endif

#ifdef _WIN32
    if (!spawn_server_process(argc, argv, port)) {
        fprintf(stderr, "DStudio: failed to start server child\n");
        return 1;
    }
#else
    pid_t pid = fork();
    if (pid < 0) { perror("fork"); return 1; }
    if (pid == 0) {
        /* child: HTTP server + engine supervision only. Become a process-group
         * leader so the parent can tear down the WHOLE tree (server + engine +
         * streaming relays) in one shot when the window closes — otherwise a busy
         * agent/design generation can outlive the window. */
        setpgid(0, 0);
        _exit(ds4_serve_main(argc, argv));
    }
    setpgid(pid, pid);   /* race-safe: also set from the parent (harmless if the child won the race) */

    g_server_pid = pid;
#endif
    atexit(stop_server);   /* [NSApp terminate] calls exit() → here we stop the server */

    if (!wait_for_port(port, 8000))
        fprintf(stderr, "DStudio: server not ready yet on :%d, opening the window anyway\n", port);

    char url[96];
    const char *path = getenv("DS4UI_SKIP_LOADING") ? "/" : "/loading.html";
    snprintf(url, sizeof url, "http://127.0.0.1:%d%s", port, path);

    webview_t w = webview_create(1280, 860, "DS4");
    webview_navigate(w, url);
    webview_run(w);   /* blocks while the window stays open */

    stop_server();
#ifndef _WIN32
    waitpid(pid, NULL, 0);
#endif
    return 0;
}

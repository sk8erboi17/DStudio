/*
 * dstudio.c — launcher and HTTP server for DStudio.
 *
 * Serves the single page index.html and supervises THE ds4 engine, which can
 * run in three mutually exclusive modes (the ds4 instance-lock forbids
 * two large processes together):
 *
 *   - server : ds4-server, the HTTP API for normal chat (port 28000)
 *   - agent  : ds4-agent --non-interactive, the coding agent via pipe
 *   - design : ds4-design --jsonl, the design agent (HTML in a workspace)
 *
 * Makes start.sh obsolete: all of its parameters are here.
 *
 * Compile:  cc -O2 -Wall -Wextra -o dstudio dstudio.c
 * Run:      ./dstudio [web_port] [ds4_dir]      (default 5500, ../ds4)
 *
 * Local API (only from this page, see anti-CSRF):
 *   GET  /api/status                  engine state, progress, models
 *   POST /api/start {mode, ...cfg}    (re)starts in server or agent
 *   POST /api/stop                    stops the engine
 *   POST /api/agent/send {prompt}     sends a prompt to the agent (agent only)
 *   GET  /api/agent/poll?since=N      incremental stream of the agent output
 *   GET  /api/design/status           design workspace and run state
 *   GET  /api/design/files            list of design project files (JSON)
 *   GET  /api/design/file?name=R      one project file (path R sandboxed)
 *
 * Security:
 *  - bind 127.0.0.1 by default. The explicit LAN toggle exposes the app shell,
 *    /remote, /v1, LAN mirror publishing and Chat web tools;
 *    host settings/store/download APIs stay local.
 *  - spawn with fork+execv and an argv ARRAY: no shell, no command
 *    injection. Model from a fixed ENUM, integers validated with explicit
 *    ranges, working dir passed as a single argv to --chdir (never concatenated in a shell).
 *  - anti-CSRF: POST /api requests require the custom header X-Requested-With:
 *    ds4web, which another site cannot add without a CORS preflight; workspace,
 *    agent/design and settings APIs remain host-local even when LAN is enabled.
 *  - bounded buffers (header REQ_BUF, body BODY_MAX), logging with escaping of
 *    non-printable bytes, I/O timeout, SIGPIPE ignored, partial writes handled.
 *  - page CSP allows http/https fetches so LAN clients can call the host API.
 *  - SIGINT/SIGTERM also shut down the child engine.
 */
#ifndef _GNU_SOURCE
#define _GNU_SOURCE
#endif
#include <ctype.h>
#include <errno.h>
#include <limits.h>
#include <signal.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <sys/stat.h>
#ifndef PATH_MAX
#define PATH_MAX 4096
#endif
#if PATH_MAX < 4096
#define DSTUDIO_PATH_MAX 4096
#else
#define DSTUDIO_PATH_MAX PATH_MAX
#endif
#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <direct.h>
#include <fcntl.h>
#include <io.h>
#include <process.h>
typedef intptr_t pid_t;
typedef SSIZE_T ssize_t;
typedef unsigned long nfds_t;
#ifndef R_OK
#define R_OK 4
#endif
#ifndef X_OK
#define X_OK 0
#endif
#ifndef STDIN_FILENO
#define STDIN_FILENO 0
#define STDOUT_FILENO 1
#define STDERR_FILENO 2
#endif
#ifndef S_ISREG
#define S_ISREG(m) (((m) & _S_IFMT) == _S_IFREG)
#endif
#ifndef S_ISDIR
#define S_ISDIR(m) (((m) & _S_IFMT) == _S_IFDIR)
#endif
#ifndef S_ISLNK
#define S_ISLNK(m) (0)
#endif
#ifndef F_GETFL
#define F_GETFL 3
#endif
#ifndef F_SETFL
#define F_SETFL 4
#endif
#ifndef O_NONBLOCK
#define O_NONBLOCK 0x4000
#endif
#define access _access
#define chdir _chdir
#define getpid _getpid
#define lstat stat
#define mkdir(path, mode) _mkdir(path)
#define realpath(path, out) _fullpath((out), (path), DSTUDIO_PATH_MAX)
#define rmdir _rmdir
#define unlink _unlink
#define usleep(us) Sleep((DWORD)((us) / 1000))
#define setenv(k, v, overwrite) _putenv_s((k), (v))
#define WNOHANG 1
#define SIGKILL SIGTERM
#define SIGPIPE 13
#define WIFEXITED(st) (1)
#define WEXITSTATUS(st) ((st) & 0xff)
#define WIFSIGNALED(st) (0)
#define WTERMSIG(st) (0)
#ifndef POLLIN
#define POLLIN 0x0001
#endif
#ifndef POLLHUP
#define POLLHUP 0x0010
#endif
struct sigaction { void (*sa_handler)(int); };
static int sigaction(int sig, const struct sigaction *sa, struct sigaction *old) {
    void (*prev)(int) = signal(sig, sa ? sa->sa_handler : SIG_DFL);
    if (old) old->sa_handler = prev;
    return prev == SIG_ERR ? -1 : 0;
}
typedef struct {
    HANDLE h;
    WIN32_FIND_DATAA data;
    struct { char d_name[MAX_PATH]; } de;
    int first;
} DIR;
static DIR *opendir(const char *path) {
    char pat[4096];
    snprintf(pat, sizeof pat, "%s\\*", path);
    DIR *d = (DIR *)calloc(1, sizeof *d);
    if (!d) return NULL;
    d->h = FindFirstFileA(pat, &d->data);
    if (d->h == INVALID_HANDLE_VALUE) { free(d); return NULL; }
    d->first = 1;
    return d;
}
static struct dirent { char d_name[MAX_PATH]; } *readdir(DIR *d) {
    if (!d) return NULL;
    if (!d->first && !FindNextFileA(d->h, &d->data)) return NULL;
    d->first = 0;
    snprintf(d->de.d_name, sizeof d->de.d_name, "%s", d->data.cFileName);
    return (struct dirent *)&d->de;
}
static int closedir(DIR *d) {
    if (!d) return -1;
    FindClose(d->h);
    free(d);
    return 0;
}
static void ds4_win_wsa_start(void) {
    static int started = 0;
    if (!started) { WSADATA w; WSAStartup(MAKEWORD(2, 2), &w); started = 1; }
}
static int ds4_socket(int domain, int type, int protocol) {
    ds4_win_wsa_start();
    SOCKET s = socket(domain, type, protocol);
    return s == INVALID_SOCKET ? -1 : (int)(intptr_t)s;
}
static int ds4_accept(intptr_t s, void *addr, void *len) {
    SOCKET a = accept((SOCKET)s, (struct sockaddr *)addr, (int *)len);
    return a == INVALID_SOCKET ? -1 : (int)(intptr_t)a;
}
static int ds4_close(intptr_t fd) {
    if (fd < 0) return 0;
    if (closesocket((SOCKET)fd) == 0) return 0;
    return CloseHandle((HANDLE)fd) ? 0 : -1;
}
static ssize_t ds4_send(intptr_t fd, const char *buf, size_t len, int flags) {
    int n = send((SOCKET)fd, buf, (int)len, flags);
    if (n >= 0) return n;
    if (WSAGetLastError() != WSAENOTSOCK) return -1;
    DWORD wrote = 0;
    return WriteFile((HANDLE)fd, buf, (DWORD)len, &wrote, NULL) ? (ssize_t)wrote : -1;
}
static ssize_t ds4_recv(intptr_t fd, char *buf, size_t len, int flags) {
    DWORD avail = 0;
    if (PeekNamedPipe((HANDLE)fd, NULL, 0, NULL, &avail, NULL)) {
        if (avail == 0) { errno = EAGAIN; return -1; }
        DWORD got = 0;
        return ReadFile((HANDLE)fd, buf, (DWORD)len, &got, NULL) ? (ssize_t)got : -1;
    }
    int n = recv((SOCKET)fd, buf, (int)len, flags);
    return n >= 0 ? n : -1;
}
static ssize_t ds4_read(intptr_t fd, void *buf, size_t len) { return ds4_recv(fd, (char *)buf, len, 0); }
static ssize_t ds4_write(intptr_t fd, const void *buf, size_t len) { return ds4_send(fd, (const char *)buf, len, 0); }
static int ds4_pipe(int p[2]) {
    SECURITY_ATTRIBUTES sa = { sizeof(sa), NULL, TRUE };
    HANDLE r = NULL, w = NULL;
    if (!CreatePipe(&r, &w, &sa, 0)) return -1;
    p[0] = (int)(intptr_t)r;
    p[1] = (int)(intptr_t)w;
    return 0;
}
static int ds4_poll(struct pollfd *pfd, nfds_t nfds, int timeout_ms) {
    DWORD start = GetTickCount();
    for (;;) {
        int ready = 0;
        for (nfds_t i = 0; i < nfds; i++) {
            pfd[i].revents = 0;
            if (!(pfd[i].events & POLLIN) || pfd[i].fd < 0) continue;
            DWORD avail = 0;
            if (PeekNamedPipe((HANDLE)pfd[i].fd, NULL, 0, NULL, &avail, NULL)) {
                if (avail > 0) { pfd[i].revents |= POLLIN; ready++; }
                continue;
            }
            fd_set rfds;
            FD_ZERO(&rfds);
            FD_SET((SOCKET)pfd[i].fd, &rfds);
            struct timeval tv = {0, 0};
            int rc = select(0, &rfds, NULL, NULL, &tv);
            if (rc > 0 && FD_ISSET((SOCKET)pfd[i].fd, &rfds)) {
                pfd[i].revents |= POLLIN;
                ready++;
            }
        }
        if (ready || timeout_ms == 0) return ready;
        if (timeout_ms > 0 && (int)(GetTickCount() - start) >= timeout_ms) return 0;
        Sleep(10);
    }
}
static int ds4_fcntl(int fd, int cmd, ...) { (void)fd; (void)cmd; return 0; }
static pid_t ds4_waitpid(pid_t pid, int *status, int options) {
    if (pid <= 0) return -1;
    DWORD wait = WaitForSingleObject((HANDLE)pid, options == WNOHANG ? 0 : INFINITE);
    if (wait == WAIT_TIMEOUT) return 0;
    if (wait != WAIT_OBJECT_0) return -1;
    DWORD code = 0;
    GetExitCodeProcess((HANDLE)pid, &code);
    if (status) *status = (int)code;
    CloseHandle((HANDLE)pid);
    return pid;
}
static int ds4_kill(pid_t pid, int sig) {
    (void)sig;
    return (pid > 0 && TerminateProcess((HANDLE)pid, 1)) ? 0 : -1;
}
static DWORD g_last_spawn_win_pid = 0;
static pid_t fork(void) { errno = ENOSYS; return -1; }
#define dup2 _dup2
#define execl(path, ...) (-1)
#define execlp(path, ...) (-1)
#define execv(path, argv) (-1)
#define open _open
#define _exit(code) ExitProcess((UINT)(code))
#define accept ds4_accept
#define close ds4_close
#define fcntl ds4_fcntl
#define pipe ds4_pipe
#define poll ds4_poll
#define read ds4_read
#define recv ds4_recv
#define send ds4_send
#define socket ds4_socket
#define waitpid ds4_waitpid
#define write ds4_write
#define kill ds4_kill
#else
#include <arpa/inet.h>
#include <dirent.h>
#include <fcntl.h>
#include <ifaddrs.h>      /* getifaddrs: report the LAN IP for the network toggle */
#include <net/if.h>
#include <netinet/in.h>
#include <poll.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <sys/wait.h>
#include <unistd.h>
#endif
#ifdef __APPLE__
#include <mach-o/dyld.h>   /* _NSGetExecutablePath: resolve ds4 dir from bundle */
#endif

static char *ds4_strdup_local(const char *s) {
    const char *src = s ? s : "";
    size_t n = strlen(src);
    char *out = (char *)malloc(n + 1);
    if (!out) return NULL;
    memcpy(out, src, n);
    out[n] = '\0';
    return out;
}

static char *ds4_strndup_local(const char *s, size_t n) {
    const char *src = s ? s : "";
    char *out = (char *)malloc(n + 1);
    if (!out) return NULL;
    memcpy(out, src, n);
    out[n] = '\0';
    return out;
}

/* The page is embedded into the binary in base64 at build time
 * (page_data.h, generated by the Makefile from index.html). This way the binary is
 * self-sufficient: no dependency on the file on disk. To iterate in
 * development you can serve from disk with DS4UI_PAGE_FROM_DISK=1. */
#if __has_include("page_data.h")
#  include "page_data.h"          /* defines: static const char PAGE_B64[] */
#  define HAVE_EMBEDDED_PAGE 1
#endif
#if __has_include("loading_data.h")
#  include "loading_data.h"       /* defines: static const char LOADING_B64[] */
#  define HAVE_EMBEDDED_LOADING 1
#endif

#define DEFAULT_PORT 5500
/* DS4UI_PAGE_FROM_DISK reads this, relative to the cwd (the repo root). */
#define PAGE_PATH    "web/index.html"
#define LOADING_PATH "web/loading.html"
#define MAX_PAGE     (8 * 1024 * 1024)
#define REQ_BUF      65536
#define BODY_MAX     32768   /* roomy enough for a user-authored skill body */
#define IO_TIMEOUT_S 5
#define WEB_HELPER_SEARCH_TIMEOUT_MS 25000
#define WEB_HELPER_VISIT_TIMEOUT_MS 45000
#define AGENT_BUF_CAP (4 * 1024 * 1024)   /* cap of the agent transcript in RAM */

#define MODEL_STD "ds4flash.gguf"
#define MODEL_UNC "gguf/cyberneurova-DeepSeek-V4-Flash-abliterated-IQ2XXS-w2Q2K-AProjQ8-SExpQ8-OutQ8-chat-v2-imatrix-aligned.gguf"
/* Model variants the UI can pick: flash = the abliterated Flash above, pro =
 * the official V4-Pro IQ2XXS (download_model.sh pro-q2-imatrix). */
#define MODEL_FLASH MODEL_UNC
#define MODEL_PRO   "gguf/DeepSeek-V4-Pro-IQ2XXS-w2Q2K-AProjQ8-SExpQ8-OutQ8-Instruct-imatrix.gguf"
#define MODEL_PRO_EXPECTED_BYTES 430000000000LL  /* ~430 GB (pro-q2-imatrix), for the % */

enum { ENGINE_NONE = 0, ENGINE_SERVER, ENGINE_AGENT, ENGINE_DESIGN };

/* The piped modes (agent and design) share transcript and protocol
 * (+DWARFSTAR_WAITING, \x1e events): same send/poll endpoints. */
#define MODE_IS_PIPED(m) ((m) == ENGINE_AGENT || (m) == ENGINE_DESIGN)

typedef struct {
    int uncensored;   /* 0 standard, 1 uncensored */
    int port;         /* server: HTTP port. default 28000 */
    int ctx;          /* default 262144 */
    int power;        /* 1..100, default 100 */
    int kv_space_mb;  /* server: default 24576 */
    int kv_min_tok;   /* server: default 128 */
    int think;        /* agent/design: 0 nothink, 1 think (high), 2 think-max. default 1 */
} engine_cfg;

static const engine_cfg ENGINE_DEFAULTS = { 1, 28000, 262144, 100, 24576, 128, 1 };

/* ---- global engine state ---- */
static int       g_mode = ENGINE_NONE;
static pid_t     g_child = -1;
static engine_cfg g_cfg;
static char      g_ds4_dir[1024] = "../ds4";
static char      g_web_dir[1024] = "";       /* this DStudio checkout (holds extension/) */
static char      g_workdir[1024] = "";       /* agent: --chdir; design: --workspace */
static char      g_remote_base_url[1024] = ""; /* LAN client: local agent/design, remote model */
static char      g_remote_model[128] = "";
static char      g_design_dir[1024] = "";    /* last design workspace: the preview
                                                stays servable even after stop */

static int  g_in_fd  = -1;   /* agent stdin (write) */
static int  g_out_fd = -1;   /* child stdout (read)  */
static int  g_err_fd = -1;   /* child stderr (read)  */

/* Local client state (chat history). An opaque JSON blob the page reads/merges/
 * writes; persisted to disk. rev bumps on every write → browser tabs poll it
 * cheaply to spot changes. Non-loopback LAN clients are not allowed to reach
 * this store; only the explicit /remote share is public. */
static char  *g_store = NULL;
static size_t g_store_len = 0;
static long   g_store_rev = 0;

/* LAN client mirrors: clients keep their own local stores, but publish snapshots
 * here so the host can inspect their chats. GET is host-local; LAN clients only
 * get POST access to write their own snapshot. */
typedef struct lan_client_snapshot {
    char id[128];
    char name[160];
    char *json;
    size_t json_len;
    long updated_ms;
    struct lan_client_snapshot *next;
} lan_client_snapshot;
static lan_client_snapshot *g_lan_clients = NULL;
static long g_lan_clients_rev = 0;

/* /remote share: one chat intentionally exposed to LAN clients. It is separate
 * from the local workspace, sidebar, settings and full conversation store. */
static int    g_remote_enabled = 0;
static char  *g_remote_chat = NULL;      /* raw JSON chat snapshot */
static size_t g_remote_chat_len = 0;
static long   g_remote_rev = 0;

/* loading progress */
static int  g_load_pct = 0;
static char g_stage[96] = "";
static int  g_ready = 0;
static int  g_agent_working = 0;   /* true between send and the next WAITING */
/* The agent can run patched (ds4-agent-jsonl --jsonl, structured events for the
 * UI) or stock (ds4-agent, raw text that the UI parses heuristically). The UI
 * requests it via /api/start {jsonl}; if the patch build FAILS (e.g. the agent
 * was reworked upstream and the anchors no longer apply) we fall back to stock. */
static int  g_use_jsonl = 1;       /* requested by the UI (default on) */
static int  g_jsonl_active = 0;    /* effective: 1 = patched, 0 = stock/raw */

/* agent transcript (absolute offsets, with a base that advances if truncated) */
static char  *g_abuf = NULL;
static size_t g_alen = 0;          /* absolute offset = total bytes seen */
static size_t g_abase = 0;         /* absolute offset of the first byte in g_abuf */
static size_t g_acap = 0;

static char g_line_out[512];       /* line accumulator for milestone parsing (stdout) */
static size_t g_line_out_len = 0;
static char g_line_err[512];
static size_t g_line_err_len = 0;
static char g_last_engine_line[256] = ""; /* last substantive line the engine printed (any stream) */
static char g_engine_err[256] = "";       /* why the engine last died, surfaced to the UI; "" = none */

/* connect-src widened to http/https: with bind on the LAN the page, loaded
 * from another host, must be able to contact ds4-server on the server IP (no
 * longer just loopback). default-src stays 'none'. */
static const char SEC_HEADERS[] =
    "Connection: close\r\n"
    "Cache-Control: no-store\r\n"
    "X-Content-Type-Options: nosniff\r\n"
    "Referrer-Policy: no-referrer\r\n"
    "Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; "
    "script-src 'unsafe-inline'; img-src data:; connect-src http: https:; "
    "frame-src 'self'\r\n";

/* Headers for the design files served in the preview iframe: the CSP allows
 * only inline style/script and img data:, NO external request — it is the
 * same self-sufficiency rule imposed on the model by the system prompt. */
static const char DESIGN_HEADERS[] =
    "Connection: close\r\n"
    "Cache-Control: no-store\r\n"
    "X-Content-Type-Options: nosniff\r\n"
    "Referrer-Policy: no-referrer\r\n"
    "Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; "
    "script-src 'unsafe-inline'; img-src data:\r\n";

/* Bind address of the HTTP listener. Default 127.0.0.1 (localhost only): LAN is
 * OFF by default. The user enables it from Settings (POST /api/lan {enable}),
 * which rebinds the listener to 0.0.0.0 live; DS4UI_HOST overrides the boot host. */
static char g_bind_host[64] = "127.0.0.1";
static int  g_srv_fd = -1;     /* HTTP listen socket (rebindable for the LAN toggle) */
static int  g_http_port = 5500;
static int  g_reply_cors = 0;
/* Set by the windowed launcher (app.cc) BEFORE forking the server: a pre-picked FREE port,
 * so if 5500 is squatted (e.g. a leftover Django runserver) DStudio opens on the next free
 * port instead of a blank window. 0 = not forced (CLI/headless uses the argv/default port). */
int ds4ui_forced_port = 0;

/* ==================== basic I/O ==================== */

static int send_all(int fd, const char *p, size_t n) {
    while (n > 0) {
        ssize_t w = send(fd, p, n, 0);
        if (w < 0) { if (errno == EINTR) continue; return -1; }
        p += w; n -= (size_t)w;
    }
    return 0;
}

static void send_response_hdrs(int fd, const char *status, const char *ctype,
                               const char *body, size_t blen, int head_only,
                               const char *extra_headers) {
    char hdr[1024];
    static const char CORS_RESPONSE_HEADERS[] =
        "Access-Control-Allow-Origin: *\r\n"
        "Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n"
        "Access-Control-Allow-Headers: Content-Type, Accept, X-Requested-With\r\n";
    int add_cors = g_reply_cors && !(extra_headers && strstr(extra_headers, "Access-Control-Allow-Origin:"));
    int n = snprintf(hdr, sizeof hdr,
                     "HTTP/1.1 %s\r\nContent-Type: %s\r\nContent-Length: %zu\r\n%s%s\r\n",
                     status, ctype, blen, extra_headers ? extra_headers : "",
                     add_cors ? CORS_RESPONSE_HEADERS : "");
    if (n < 0 || (size_t)n >= sizeof hdr) return;
    if (send_all(fd, hdr, (size_t)n) < 0) return;
    if (!head_only && blen > 0) send_all(fd, body, blen);
}

static void send_response(int fd, const char *status, const char *ctype,
                          const char *body, size_t blen, int head_only) {
    send_response_hdrs(fd, status, ctype, body, blen, head_only, SEC_HEADERS);
}

static void send_text(int fd, const char *status, const char *body, int head_only) {
    send_response(fd, status, "text/plain; charset=utf-8", body, strlen(body), head_only);
}

static void send_redirect(int fd, const char *location, int head_only) {
    char extra[1024];
    int n = snprintf(extra, sizeof extra, "Location: %s\r\n%s", location, SEC_HEADERS);
    if (n < 0 || (size_t)n >= sizeof extra) {
        send_text(fd, "500 Internal Server Error", "redirect header too large\n", head_only);
        return;
    }
    send_response_hdrs(fd, "302 Found", "text/plain; charset=utf-8", "", 0, head_only, extra);
}

static void send_json(int fd, const char *status, const char *body) {
    send_response(fd, status, "application/json; charset=utf-8", body, strlen(body), 0);
}

static void send_json_cors(int fd, const char *status, const char *body) {
    static const char CORS_JSON_HEADERS[] =
        "Access-Control-Allow-Origin: *\r\n"
        "Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n"
        "Access-Control-Allow-Headers: Content-Type, Accept, X-Requested-With\r\n";
    send_response_hdrs(fd, status, "application/json; charset=utf-8", body, strlen(body), 0,
                       CORS_JSON_HEADERS);
}

static void send_cors_options(int fd) {
    static const char CORS_OPTIONS_HEADERS[] =
        "Access-Control-Allow-Origin: *\r\n"
        "Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n"
        "Access-Control-Allow-Headers: Content-Type, Accept, X-Requested-With\r\n"
        "Access-Control-Max-Age: 600\r\n";
    send_response_hdrs(fd, "204 No Content", "text/plain; charset=utf-8", "", 0, 0,
                       CORS_OPTIONS_HEADERS);
}

static int ascii_eq_ci(char a, char b) {
    if (a >= 'A' && a <= 'Z') a = (char)(a + ('a' - 'A'));
    if (b >= 'A' && b <= 'Z') b = (char)(b + ('a' - 'A'));
    return a == b;
}

static int mem_contains_ci(const char *hay, size_t hlen, const char *needle) {
    size_t nlen = strlen(needle);
    if (!hay || !needle || nlen == 0 || hlen < nlen) return 0;
    for (size_t i = 0; i + nlen <= hlen; i++) {
        size_t j = 0;
        while (j < nlen && ascii_eq_ci(hay[i + j], needle[j])) j++;
        if (j == nlen) return 1;
    }
    return 0;
}

static void relay_engine_response(int client_fd, int engine_fd, int cors) {
    char head[65536];
    size_t got = 0;
    int sent_head = 0;
    while (got < sizeof head - 1) {
        ssize_t n = read(engine_fd, head + got, sizeof head - 1 - got);
        if (n <= 0) break;
        got += (size_t)n;
        head[got] = '\0';
        char *end = strstr(head, "\r\n\r\n");
        if (!end) continue;
        size_t hlen = (size_t)(end - head);
        if (send_all(client_fd, head, hlen) != 0) return;
        if (cors && !mem_contains_ci(head, hlen, "\r\nAccess-Control-Allow-Origin:")) {
            static const char CORS_RESPONSE_HEADERS[] =
                "\r\nAccess-Control-Allow-Origin: *"
                "\r\nAccess-Control-Allow-Methods: GET, POST, OPTIONS"
                "\r\nAccess-Control-Allow-Headers: Content-Type, Accept, X-Requested-With";
            if (send_all(client_fd, CORS_RESPONSE_HEADERS, strlen(CORS_RESPONSE_HEADERS)) != 0) return;
        }
        if (send_all(client_fd, "\r\n\r\n", 4) != 0) return;
        size_t body = hlen + 4;
        if (got > body && send_all(client_fd, head + body, got - body) != 0) return;
        sent_head = 1;
        break;
    }
    if (!sent_head && got > 0) {
        if (send_all(client_fd, head, got) != 0) return;
    }
    char buf[16384];
    ssize_t n;
    while ((n = read(engine_fd, buf, sizeof buf)) > 0) {
        if (send_all(client_fd, buf, (size_t)n) != 0) break;
    }
}

static int set_nonblock(int fd) {
    int fl = fcntl(fd, F_GETFL, 0);
    if (fl < 0) return -1;
    return fcntl(fd, F_SETFL, fl | O_NONBLOCK);
}

static char *read_html_disk(const char *path, size_t *out_len) {
    FILE *f = fopen(path, "rb");
    if (!f) return NULL;
    if (fseek(f, 0, SEEK_END) != 0) { fclose(f); return NULL; }
    long sz = ftell(f);
    if (sz < 0 || sz > MAX_PAGE) { fclose(f); return NULL; }
    rewind(f);
    char *buf = malloc((size_t)sz > 0 ? (size_t)sz : 1);
    if (!buf) { fclose(f); return NULL; }
    if (fread(buf, 1, (size_t)sz, f) != (size_t)sz) { free(buf); fclose(f); return NULL; }
    fclose(f);
    *out_len = (size_t)sz;
    return buf;
}

static char *read_page_disk(size_t *out_len) {
    return read_html_disk(PAGE_PATH, out_len);
}

static char *read_loading_disk(size_t *out_len) {
    return read_html_disk(LOADING_PATH, out_len);
}

#if defined(HAVE_EMBEDDED_PAGE) || defined(HAVE_EMBEDDED_LOADING)
/* Decodes base64 → malloc'd buffer. Ignores spaces/newlines. Returns
 * NULL on malformed input. Table: value+1 for valid characters, 0 = not
 * valid (so 'A'→1 is distinguished from the default zeroed entries). */
static char *base64_decode(const char *in, size_t *out_len) {
    static const unsigned char T[256] = {
        ['A']=1,['B']=2,['C']=3,['D']=4,['E']=5,['F']=6,['G']=7,['H']=8,
        ['I']=9,['J']=10,['K']=11,['L']=12,['M']=13,['N']=14,['O']=15,['P']=16,
        ['Q']=17,['R']=18,['S']=19,['T']=20,['U']=21,['V']=22,['W']=23,['X']=24,
        ['Y']=25,['Z']=26,['a']=27,['b']=28,['c']=29,['d']=30,['e']=31,['f']=32,
        ['g']=33,['h']=34,['i']=35,['j']=36,['k']=37,['l']=38,['m']=39,['n']=40,
        ['o']=41,['p']=42,['q']=43,['r']=44,['s']=45,['t']=46,['u']=47,['v']=48,
        ['w']=49,['x']=50,['y']=51,['z']=52,['0']=53,['1']=54,['2']=55,['3']=56,
        ['4']=57,['5']=58,['6']=59,['7']=60,['8']=61,['9']=62,['+']=63,['/']=64,
    };
    size_t inlen = strlen(in);
    char *out = malloc(inlen / 4 * 3 + 4);
    if (!out) return NULL;
    size_t o = 0;
    unsigned int acc = 0; int nbits = 0;  /* unsigned: the <<6 accumulator must not overflow a signed int (UB) */
    for (size_t i = 0; i < inlen; i++) {
        unsigned char c = (unsigned char)in[i];
        if (c == '=') break;
        if (c == '\n' || c == '\r' || c == ' ' || c == '\t') continue;
        unsigned char t = T[c];
        if (t == 0) { free(out); return NULL; }   /* non base64 character */
        acc = (acc << 6) | (t - 1);
        nbits += 6;
        if (nbits >= 8) {
            nbits -= 8;
            out[o++] = (char)((acc >> nbits) & 0xFF);
        }
    }
    *out_len = o;
    return out;
}
#endif

/* Serves the embedded page (default) or, with DS4UI_PAGE_FROM_DISK, the
 * index.html file on disk (handy in development). */
static char *read_page(size_t *out_len) {
#ifdef HAVE_EMBEDDED_PAGE
    if (!getenv("DS4UI_PAGE_FROM_DISK")) {
        return base64_decode(PAGE_B64, out_len);
    }
    char *disk = read_page_disk(out_len);
    if (disk) return disk;
    return base64_decode(PAGE_B64, out_len);
#else
    return read_page_disk(out_len);
#endif
}

static char *read_loading_page(size_t *out_len) {
#ifdef HAVE_EMBEDDED_LOADING
    if (!getenv("DS4UI_PAGE_FROM_DISK")) {
        return base64_decode(LOADING_B64, out_len);
    }
    char *disk = read_loading_disk(out_len);
    if (disk) return disk;
    return base64_decode(LOADING_B64, out_len);
#else
    return read_loading_disk(out_len);
#endif
}

static void sanitize(char *s) {
    for (; *s; s++) {
        unsigned char c = (unsigned char)*s;
        if (c < 32 || c > 126) *s = '?';
    }
}

/* ==================== minimal JSON ==================== */

/* Extracts "key":"value" with basic escape decoding. 1 if found. */
static int json_get_string(const char *body, const char *key, char *out, size_t outsz) {
    char pat[64];
    snprintf(pat, sizeof pat, "\"%s\"", key);
    const char *p = strstr(body, pat);
    if (!p) return 0;
    p += strlen(pat);
    while (*p == ' ' || *p == '\t') p++;
    if (*p != ':') return 0;
    p++;
    while (*p == ' ' || *p == '\t') p++;
    if (*p != '"') return 0;
    p++;
    size_t o = 0;
    while (*p && *p != '"') {
        char c = *p++;
        if (c == '\\' && *p) {
            char e = *p++;
            switch (e) {
                case 'n': c = '\n'; break;
                case 't': c = '\t'; break;
                case 'r': c = '\r'; break;
                case '"': c = '"';  break;
                case '\\': c = '\\'; break;
                case '/': c = '/';  break;
                case 'u': {
                    /* \uXXXX: only basic BMP; not critical for prompts */
                    if (p[0] && p[1] && p[2] && p[3]) {
                        char hx[5] = { p[0], p[1], p[2], p[3], 0 };
                        long v = strtol(hx, NULL, 16);
                        p += 4;
                        if (v < 0x80) c = (char)v;
                        else { /* 2-byte UTF-8 encoding for U+0080..U+07FF, otherwise '?' */
                            if (v < 0x800 && o + 2 < outsz) {
                                out[o++] = (char)(0xC0 | (v >> 6));
                                c = (char)(0x80 | (v & 0x3F));
                            } else c = '?';
                        }
                    } else c = '?';
                    break;
                }
                default: c = e; break;
            }
        }
        if (o + 1 < outsz) out[o++] = c;
        else break;
    }
    out[o] = '\0';
    return 1;
}

/* Integer "key": N with range. 1 found+valid, 0 absent, -1 invalid. */
static int json_get_int(const char *body, const char *key, long lo, long hi, long *out) {
    char pat[64];
    snprintf(pat, sizeof pat, "\"%s\"", key);
    const char *p = strstr(body, pat);
    if (!p) return 0;
    p += strlen(pat);
    while (*p == ' ' || *p == '\t') p++;
    if (*p != ':') return -1;
    p++;
    while (*p == ' ' || *p == '\t') p++;
    char *end = NULL;
    long v = strtol(p, &end, 10);
    if (end == p || v < lo || v > hi) return -1;
    *out = v;
    return 1;
}

/* "key":true → 1, "key":false / absent → 0. Tolerant (no validation). */
static int json_get_bool(const char *body, const char *key) {
    char pat[64];
    snprintf(pat, sizeof pat, "\"%s\"", key);
    const char *p = strstr(body, pat);
    if (!p) return 0;
    p += strlen(pat);
    while (*p == ' ' || *p == '\t' || *p == ':') p++;
    return strncmp(p, "true", 4) == 0;
}

/* "model":"standard"|"uncensored" → 0/1; def if absent; -1 invalid. */
static int json_get_model(const char *body, int def) {
    const char *p = strstr(body, "\"model\"");
    if (!p) return def;
    p += 7;
    while (*p == ' ' || *p == '\t') p++;
    if (*p != ':') return -1;
    p++;
    while (*p == ' ' || *p == '\t') p++;
    if (!strncmp(p, "\"uncensored\"", 12)) return 1;
    if (!strncmp(p, "\"standard\"", 10)) return 0;
    return -1;
}

/* Appends src to out as a JSON-escaped string. Returns bytes written. */
static size_t json_escape_into(char *out, size_t outsz, const char *src, size_t n) {
    size_t o = 0;
    for (size_t i = 0; i < n && o + 7 < outsz; i++) {
        unsigned char c = (unsigned char)src[i];
        switch (c) {
            case '"':  out[o++]='\\'; out[o++]='"';  break;
            case '\\': out[o++]='\\'; out[o++]='\\'; break;
            case '\n': out[o++]='\\'; out[o++]='n';  break;
            case '\r': out[o++]='\\'; out[o++]='r';  break;
            case '\t': out[o++]='\\'; out[o++]='t';  break;
            default:
                if (c < 0x20) o += (size_t)snprintf(out + o, outsz - o, "\\u%04x", c);
                else out[o++] = (char)c;
        }
    }
    out[o] = '\0';
    return o;
}

typedef struct {
    char *ptr;
    size_t len;
    size_t cap;
} json_dyn_buf;

static int json_dyn_reserve(json_dyn_buf *b, size_t add) {
    size_t need = b->len + add + 1;
    if (need <= b->cap) return 1;
    size_t nc = b->cap ? b->cap * 2 : 8192;
    while (nc < need) nc *= 2;
    char *np = realloc(b->ptr, nc);
    if (!np) return 0;
    b->ptr = np;
    b->cap = nc;
    return 1;
}

static int json_dyn_putn(json_dyn_buf *b, const char *s, size_t n) {
    if (!json_dyn_reserve(b, n)) return 0;
    memcpy(b->ptr + b->len, s, n);
    b->len += n;
    b->ptr[b->len] = '\0';
    return 1;
}

static int json_dyn_puts(json_dyn_buf *b, const char *s) {
    return json_dyn_putn(b, s, strlen(s));
}

static int json_dyn_printf(json_dyn_buf *b, const char *fmt, ...) {
    va_list ap, aq;
    va_start(ap, fmt);
    va_copy(aq, ap);
    int n = vsnprintf(NULL, 0, fmt, ap);
    va_end(ap);
    if (n < 0 || !json_dyn_reserve(b, (size_t)n)) {
        va_end(aq);
        return 0;
    }
    vsnprintf(b->ptr + b->len, b->cap - b->len, fmt, aq);
    va_end(aq);
    b->len += (size_t)n;
    return 1;
}

static int json_dyn_put_escaped(json_dyn_buf *b, const char *s) {
    if (!json_dyn_puts(b, "\"")) return 0;
    for (; s && *s; s++) {
        unsigned char c = (unsigned char)*s;
        char tmp[8];
        switch (c) {
            case '"':  if (!json_dyn_puts(b, "\\\"")) return 0; break;
            case '\\': if (!json_dyn_puts(b, "\\\\")) return 0; break;
            case '\n': if (!json_dyn_puts(b, "\\n")) return 0; break;
            case '\r': if (!json_dyn_puts(b, "\\r")) return 0; break;
            case '\t': if (!json_dyn_puts(b, "\\t")) return 0; break;
            default:
                if (c < 0x20) {
                    snprintf(tmp, sizeof tmp, "\\u%04x", c);
                    if (!json_dyn_puts(b, tmp)) return 0;
                } else if (!json_dyn_putn(b, (const char *)&c, 1)) {
                    return 0;
                }
        }
    }
    return json_dyn_puts(b, "\"");
}

static void cstr_copy(char *dst, size_t dstsz, const char *src) {
    if (!dstsz) return;
    if (!src) src = "";
    size_t n = strlen(src);
    if (n >= dstsz) n = dstsz - 1;
    memcpy(dst, src, n);
    dst[n] = '\0';
}

static int path_join(char *dst, size_t dstsz, const char *dir, const char *name) {
    if (!dstsz) return 0;
    int n = snprintf(dst, dstsz, "%s/%s", dir ? dir : "", name ? name : "");
    if (n < 0 || (size_t)n >= dstsz) {
        dst[0] = '\0';
        return 0;
    }
    return 1;
}

/* ==================== model / kv / port ==================== */

static const char *model_rel(int uncensored) { return uncensored ? MODEL_UNC : MODEL_STD; }

/* Active model variant the UI picked ("flash" | "pro"). Flash is the default
 * (the abliterated Flash GGUF). When "pro", the engine launches with MODEL_PRO. */
static char g_variant[16] = "flash";
static pid_t g_dl_pid = -1;          /* background model download, if any */
static char  g_dl_variant[16] = "";  /* which variant is downloading */
static char  g_model_override[1024] = ""; /* explicit GGUF the user picked (rel to ds4 dir); "" = use the variant */
static char  g_skill[64] = "";            /* active skill id (extension/skills/<id>); "" = none */
static char  g_design_system[64] = "";    /* active design-system id (design only); "" = none */
static int   g_build_mode = 0;            /* agent Build mode: 0 off, 2 plan (driver) */
static char  g_build_dir[1024] = "";      /* the Build workspace (plan.md / pages live here); set on a build start */
#ifdef _WIN32
static DWORD g_child_win_pid = 0;
#endif

static const char *variant_rel(const char *v) {
    return (v && !strcmp(v, "pro")) ? MODEL_PRO : MODEL_FLASH;
}
/* The GGUF the engine loads: the user's explicit pick, else the variant default. */
static const char *current_model_rel(void) {
    return g_model_override[0] ? g_model_override : variant_rel(g_variant);
}
static int file_present(const char *rel) {
    char full[2048];
    snprintf(full, sizeof full, "%s/%s", g_ds4_dir, rel);
    struct stat st;
    return stat(full, &st) == 0 && S_ISREG(st.st_mode) && st.st_size > 0;
}

static int model_present(int uncensored) {
    char full[2048];
    snprintf(full, sizeof full, "%s/%s", g_ds4_dir, model_rel(uncensored));
    return access(full, R_OK) == 0;
}

/* The ds4 dir is "valid" if it exists AND looks like a ds4 checkout/install:
 * one of the engine binaries, the Makefile, or the Metal sources is present.
 * When this is false the UI prompts the user for the correct path. */
static int ds4_dir_valid(void) {
    struct stat st;
    if (stat(g_ds4_dir, &st) != 0 || !S_ISDIR(st.st_mode)) return 0;
    return file_present("ds4-server") || file_present("ds4-agent") ||
           file_present("ds4-server.exe") || file_present("ds4-agent.exe") ||
           file_present("Makefile")   || file_present("metal/ds4.metal") ||
           file_present("ds4.c");
}

/* True if g_web_dir points at a DStudio checkout — i.e. the design extension
 * (and so the jsonl patch / build scripts) is reachable under it. */
static int web_dir_valid(void) {
    if (!g_web_dir[0]) return 0;
    struct stat st;
    char marker[2200];
    snprintf(marker, sizeof marker, "%s/extension/design/build-design.sh", g_web_dir);
    return stat(marker, &st) == 0 && S_ISREG(st.st_mode);
}

static int rel_exists(const char *rel) {
    char full[2048];
    snprintf(full, sizeof full, "%s/%s", g_ds4_dir, rel);
    return access(full, R_OK) == 0;
}

static int any_gguf_present(void) {
    const char *subs[2] = { "gguf", "" };
    for (int di = 0; di < 2; di++) {
        char dir[2048];
        snprintf(dir, sizeof dir, "%s%s%s", g_ds4_dir, subs[di][0] ? "/" : "", subs[di]);
        DIR *d = opendir(dir);
        if (!d) continue;
        struct dirent *e;
        while ((e = readdir(d))) {
            const char *dot = strrchr(e->d_name, '.');
            if (!dot || strcmp(dot, ".gguf")) continue;
            char full[2300];
            if (!path_join(full, sizeof full, dir, e->d_name)) continue;
            struct stat st;
            if (stat(full, &st) == 0 && S_ISREG(st.st_mode) && st.st_size > 0) {
                closedir(d);
                return 1;
            }
        }
        closedir(d);
    }
    return 0;
}

static int executable_on_path(const char *name) {
    const char *path = getenv("PATH");
    if (!path || !path[0]) return 0;
    char buf[4096];
    cstr_copy(buf, sizeof buf, path);
    for (char *p = buf; p && *p; ) {
        char *colon = strchr(p, ':');
        if (colon) *colon = '\0';
        if (p[0]) {
            char full[PATH_MAX];
            if (!path_join(full, sizeof full, p, name)) {
                p = colon ? colon + 1 : NULL;
                continue;
            }
            if (access(full, X_OK) == 0) return 1;
        }
        p = colon ? colon + 1 : NULL;
    }
    return 0;
}

static int chrome_available(void) {
#ifdef _WIN32
    return 1; /* The Windows portable build does not use the ds4_web helper yet. */
#else
#ifdef __APPLE__
    if (access("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", X_OK) == 0) return 1;
    if (access("/Applications/Chromium.app/Contents/MacOS/Chromium", X_OK) == 0) return 1;
    if (access("/Applications/Google Chrome.app", F_OK) == 0) return 1;
    if (access("/Applications/Chromium.app", F_OK) == 0) return 1;
#endif
    const char *paths[] = {
        "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable",
        "/usr/bin/chromium", "/usr/bin/chromium-browser",
        "/snap/bin/chromium", "/opt/google/chrome/chrome",
    };
    for (size_t i = 0; i < sizeof paths / sizeof paths[0]; i++)
        if (access(paths[i], X_OK) == 0) return 1;
    return executable_on_path("google-chrome") ||
           executable_on_path("google-chrome-stable") ||
           executable_on_path("chromium") ||
           executable_on_path("chromium-browser");
#endif
}

/* The KV disk cache is prefix state computed from a SPECIFIC model's weights —
 * it is only valid for that exact GGUF. Keying it by anything coarser (e.g. a
 * standard/uncensored flag) means switching models (Flash <-> Pro, or any other
 * GGUF) would reuse another model's cached KV tensors and corrupt generation.
 * So each model gets its OWN cache directory under ds4-kv/<model-key>, derived
 * from the GGUF file name. Switching back and forth keeps each model's cache. */
static void kv_root(char *out, size_t outsz) {
#ifdef _WIN32
    const char *base = getenv("LOCALAPPDATA");
    if (!base || !base[0]) base = getenv("USERPROFILE");
    snprintf(out, outsz, "%s\\DStudio\\ds4-kv", base ? base : ".");
#else
    const char *home = getenv("HOME");
    snprintf(out, outsz, "%s/.local/share/flashcards/ds4-kv", home ? home : ".");
#endif
}
static void kv_dir_for_model(const char *rel, char *out, size_t outsz) {
    char root[1600];
    kv_root(root, sizeof root);
    const char *slash = strrchr(rel, '/');
#ifdef _WIN32
    const char *bslash = strrchr(rel, '\\');
    if (!slash || (bslash && bslash > slash)) slash = bslash;
#endif
    const char *base = slash ? slash + 1 : rel;   /* the GGUF file name */
    char key[200];
    size_t k = 0;
    for (const char *p = base; *p && k < sizeof key - 1; p++) {
        unsigned char c = (unsigned char)*p;
        key[k++] = (isalnum(c) || c == '.' || c == '-' || c == '_') ? (char)c : '-';
    }
    key[k] = '\0';
    if (!key[0]) snprintf(key, sizeof key, "default");
#ifdef _WIN32
    snprintf(out, outsz, "%s\\%s", root, key);
#else
    snprintf(out, outsz, "%s/%s", root, key);
#endif
}

static void mkpath(const char *path) {
    char tmp[2048];
    snprintf(tmp, sizeof tmp, "%s", path);
    for (char *p = tmp + 1; *p; p++) {
        if (*p == '/' || *p == '\\') { char sep = *p; *p = '\0'; mkdir(tmp, 0755); *p = sep; }
    }
    mkdir(tmp, 0755);
}

static int port_listening(int port) {
    int s = socket(AF_INET, SOCK_STREAM, 0);
    if (s < 0) return 0;
#ifdef _WIN32
    int tv = 300;
    (void)setsockopt((SOCKET)(intptr_t)s, SOL_SOCKET, SO_RCVTIMEO, (const char *)&tv, sizeof tv);
    (void)setsockopt((SOCKET)(intptr_t)s, SOL_SOCKET, SO_SNDTIMEO, (const char *)&tv, sizeof tv);
#else
    struct timeval tv = { 0, 300000 };
    (void)setsockopt(s, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof tv);
    (void)setsockopt(s, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof tv);
#endif
    struct sockaddr_in a;
    memset(&a, 0, sizeof a);
    a.sin_family = AF_INET;
    a.sin_port = htons((uint16_t)port);
    a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    int ok = connect(s, (struct sockaddr *)&a, sizeof a) == 0;
    close(s);
    return ok;
}

/* Opens an HTTP listen socket bound to `host`:`port`. Returns the fd or -1. */
static int open_listener(const char *host, int port) {
    int s = socket(AF_INET, SOCK_STREAM, 0);
    if (s < 0) return -1;
#ifndef _WIN32
    int fdfl = fcntl(s, F_GETFD, 0);
    if (fdfl >= 0) (void)fcntl(s, F_SETFD, fdfl | FD_CLOEXEC);
#endif
    int yes = 1;
#ifdef _WIN32
    (void)setsockopt((SOCKET)(intptr_t)s, SOL_SOCKET, SO_REUSEADDR, (const char *)&yes, sizeof yes);
#else
    (void)setsockopt(s, SOL_SOCKET, SO_REUSEADDR, &yes, sizeof yes);
#endif
    struct sockaddr_in addr;
    memset(&addr, 0, sizeof addr);
    addr.sin_family = AF_INET;
    addr.sin_port = htons((uint16_t)port);
    if (inet_pton(AF_INET, host, &addr.sin_addr) != 1) { close(s); return -1; }
    if (bind(s, (struct sockaddr *)&addr, sizeof addr) < 0) { close(s); return -1; }
    if (listen(s, 16) < 0) { close(s); return -1; }
    return s;
}

static int open_first_listener(const char *host, int *port_io) {
    int start = *port_io;
    int end = start + 40;
    if (end > 65535) end = 65535;
    for (int p = start; p <= end; p++) {
        int fd = open_listener(host, p);
        if (fd >= 0) {
            *port_io = p;
            return fd;
        }
    }
    return -1;
}

static int ipv4_usable_lan(uint32_t ip) {
    if ((ip >> 24) == 127) return 0;        /* loopback */
    if ((ip >> 16) == 0xA9FE) return 0;     /* 169.254 link-local */
    if (ip == 0) return 0;
    return 1;
}

static int ipv4_private_lan(uint32_t ip) {
    return (ip >> 24) == 10 ||
           ((ip >> 24) == 192 && ((ip >> 16) & 0xFF) == 168) ||
           ((ip >> 24) == 172 && ((ip >> 20) & 0xF) == 1);
}

static int lan_ip_text(const char *text, char *out, size_t outsz) {
    if (!text || !out || outsz == 0) return 0;
    while (*text && isspace((unsigned char)*text)) text++;
    char tmp[INET_ADDRSTRLEN];
    size_t n = strcspn(text, " \t\r\n");
    if (n == 0 || n >= sizeof tmp) return 0;
    memcpy(tmp, text, n);
    tmp[n] = '\0';
    struct in_addr a;
    if (inet_pton(AF_INET, tmp, &a) != 1) return 0;
    if (!ipv4_usable_lan(ntohl(a.s_addr))) return 0;
    snprintf(out, outsz, "%s", tmp);
    return 1;
}

static int lan_ip_route(char *out, size_t outsz) {
    int s = socket(AF_INET, SOCK_DGRAM, 0);
    if (s < 0) return 0;
    struct sockaddr_in dst;
    memset(&dst, 0, sizeof dst);
    dst.sin_family = AF_INET;
    dst.sin_port = htons(80);
    if (inet_pton(AF_INET, "8.8.8.8", &dst.sin_addr) != 1) { close(s); return 0; }
    if (connect(s, (struct sockaddr *)&dst, sizeof dst) != 0) { close(s); return 0; }
    struct sockaddr_in local;
    socklen_t len = sizeof local;
    if (getsockname(s, (struct sockaddr *)&local, &len) != 0) { close(s); return 0; }
    close(s);
    uint32_t ip = ntohl(local.sin_addr.s_addr);
    if (!ipv4_usable_lan(ip)) return 0;
    return inet_ntop(AF_INET, &local.sin_addr, out, (socklen_t)outsz) != NULL;
}

#ifdef __APPLE__
static int lan_ip_macos_command(const char *cmd, char *out, size_t outsz) {
    FILE *p = popen(cmd, "r");
    if (!p) return 0;
    char line[256] = "";
    if (!fgets(line, sizeof line, p)) line[0] = '\0';
    pclose(p);
    return lan_ip_text(line, out, outsz);
}

static int lan_ip_macos_service(char *out, size_t outsz) {
    FILE *p = popen("/usr/sbin/route -n get default 2>/dev/null", "r");
    char iface[64] = "";
    if (p) {
        char line[256];
        while (fgets(line, sizeof line, p)) {
            char *s = strstr(line, "interface:");
            if (!s) continue;
            s += strlen("interface:");
            while (*s && isspace((unsigned char)*s)) s++;
            size_t n = strcspn(s, " \t\r\n");
            if (n > 0 && n < sizeof iface) {
                memcpy(iface, s, n);
                iface[n] = '\0';
            }
            break;
        }
        pclose(p);
    }
    if (iface[0]) {
        int safe = 1;
        for (char *s = iface; *s; s++) {
            unsigned char c = (unsigned char)*s;
            if (!(isalnum(c) || c == '-' || c == '_' || c == '.')) { safe = 0; break; }
        }
        if (safe) {
            char cmd[160];
            snprintf(cmd, sizeof cmd, "/usr/sbin/ipconfig getifaddr %s 2>/dev/null", iface);
            if (lan_ip_macos_command(cmd, out, outsz)) return 1;
        }
    }

    const char *ifaces[] = { "en0", "en1", "en2", "en3", "en4", "en5", "en6", "en7", "en8", "en9", "en10", "en11", "en12" };
    for (size_t i = 0; i < sizeof ifaces / sizeof ifaces[0]; i++) {
        char cmd[160];
        snprintf(cmd, sizeof cmd, "/usr/sbin/ipconfig getifaddr %s 2>/dev/null", ifaces[i]);
        if (lan_ip_macos_command(cmd, out, outsz)) return 1;
    }
    return 0;
}
#endif

/* Best-effort primary LAN IPv4 of this machine (skips loopback / link-local /
 * down interfaces). Prefers a private range (192.168/10/172.16-31). Writes the
 * dotted IP into `out`; returns 1 if one was found, 0 otherwise. */
static int lan_ip(char *out, size_t outsz) {
#ifdef _WIN32
    return lan_ip_route(out, outsz);
#else
    char routed[INET_ADDRSTRLEN] = "";
    (void)lan_ip_route(routed, sizeof routed);

    struct ifaddrs *ifs = NULL;
    if (getifaddrs(&ifs) != 0) {
        if (routed[0]) { snprintf(out, outsz, "%s", routed); return 1; }
#ifdef __APPLE__
        return lan_ip_macos_service(out, outsz);
#else
        return 0;
#endif
    }
    char first[INET_ADDRSTRLEN] = "", priv[INET_ADDRSTRLEN] = "";
    for (struct ifaddrs * a = ifs; a; a = a->ifa_next) {
        if (!a->ifa_addr || a->ifa_addr->sa_family != AF_INET) continue;
        if (!(a->ifa_flags & IFF_UP) || (a->ifa_flags & IFF_LOOPBACK)) continue;
        struct sockaddr_in *sin = (struct sockaddr_in *)a->ifa_addr;
        uint32_t ip = ntohl(sin->sin_addr.s_addr);
        if (!ipv4_usable_lan(ip)) continue;
        char buf[INET_ADDRSTRLEN];
        if (!inet_ntop(AF_INET, &sin->sin_addr, buf, sizeof buf)) continue;
        if (!first[0]) snprintf(first, sizeof first, "%s", buf);
        if (ipv4_private_lan(ip) && !priv[0]) snprintf(priv, sizeof priv, "%s", buf);
    }
    freeifaddrs(ifs);
    const char *pick = priv[0] ? priv : first;
    if (!pick[0] && routed[0]) pick = routed;
    if (!pick[0]) {
#ifdef __APPLE__
        return lan_ip_macos_service(out, outsz);
#else
        return 0;
#endif
    }
    snprintf(out, outsz, "%s", pick);
    return 1;
#endif
}

/* LAN reachability: writes "IP:port" into `addr` (empty if no LAN IP) and
 * returns 1 if the listener is bound beyond localhost. */
static int lan_status(char *addr, size_t addrsz) {
    int on = strcmp(g_bind_host, "127.0.0.1") != 0;
    addr[0] = '\0';
    char ip[INET_ADDRSTRLEN];
    if (lan_ip(ip, sizeof ip)) snprintf(addr, addrsz, "%s:%d", ip, g_http_port);
    return on;
}

static int rebind_http_listener(const char *want) {
    if (!strcmp(g_bind_host, want)) return 1;
    char old[64];
    snprintf(old, sizeof old, "%s", g_bind_host);
    if (g_srv_fd >= 0) close(g_srv_fd);
    int nf = open_listener(want, g_http_port);
    if (nf < 0) {
        g_srv_fd = open_listener(old, g_http_port);
        if (g_srv_fd < 0) {
            g_srv_fd = open_listener("127.0.0.1", g_http_port);
            snprintf(g_bind_host, sizeof g_bind_host, "127.0.0.1");
        }
        return 0;
    }
    g_srv_fd = nf;
    snprintf(g_bind_host, sizeof g_bind_host, "%s", want);
    return 1;
}

/* ==================== loading progress ==================== */

static void set_stage(const char *stage, int pct) {
    snprintf(g_stage, sizeof g_stage, "%s", stage);
    if (pct > g_load_pct) g_load_pct = pct;   /* monotonic: no steps backward */
}

/* Maps an engine log line to a loading milestone. */
static void progress_from_line(const char *line) {
    if (g_ready) return;
    if (strstr(line, "mapped") || strstr(line, "model views") || strstr(line, "mmap"))
        set_stage("Mapping the model…", 40);
    else if (strstr(line, "context buffers") || strstr(line, "KV disk cache"))
        set_stage("Allocating the context…", 75);
    else if (strstr(line, "warming") || strstr(line, "expert"))
        set_stage("Warming up…", 85);
    else if (strstr(line, "listening on"))      /* server ready */
        { set_stage("Ready", 100); g_ready = 1; }
}

/* Scans a stream line by line, applying milestones and agent markers. */
static void scan_lines(const char *data, size_t n, char *acc, size_t *acc_len, int is_err) {
    for (size_t i = 0; i < n; i++) {
        char c = data[i];
        if (c == '\n' || *acc_len + 1 >= 512) {
            acc[*acc_len] = '\0';
            if (*acc_len > 0) {
                progress_from_line(acc);
                /* keep the last substantive line so that, if the engine dies,
                 * reap_child can report WHY instead of a bare "unreachable". */
                if (!strstr(acc, "+DWARFSTAR_"))
                    snprintf(g_last_engine_line, sizeof g_last_engine_line, "%s", acc);
                if (is_err && strstr(acc, "+DWARFSTAR_WAITING")) {
                    set_stage("Ready", 100);
                    g_ready = 1;
                    g_agent_working = 0;
                }
            }
            *acc_len = 0;
            if (c != '\n') acc[(*acc_len)++] = c;
        } else {
            acc[(*acc_len)++] = c;
        }
    }
}

/* ==================== transcript agent ==================== */

static void agent_buf_append(const char *data, size_t n) {
    if (!n) return;
    if (g_alen - g_abase + n > g_acap) {
        size_t need = g_alen - g_abase + n;
        size_t cap = g_acap ? g_acap : 65536;
        while (cap < need && cap < AGENT_BUF_CAP) cap *= 2;
        if (cap > AGENT_BUF_CAP) cap = AGENT_BUF_CAP;
        char *nb = realloc(g_abuf, cap);
        if (nb) { g_abuf = nb; g_acap = cap; }
    }
    /* If it still does not fit (ceiling reached), drop the oldest head. */
    if (g_alen - g_abase + n > g_acap) {
        size_t keep = g_acap > n ? g_acap - n : 0;
        size_t cur = g_alen - g_abase;
        if (cur > keep) {
            size_t drop = cur - keep;
            memmove(g_abuf, g_abuf + drop, cur - drop);
            g_abase += drop;
        }
    }
    size_t off = g_alen - g_abase;
    if (off + n <= g_acap) {
        memcpy(g_abuf + off, data, n);
        g_alen += n;
    }
}

static void agent_buf_reset(void) {
    g_alen = g_abase = 0;
    g_line_out_len = g_line_err_len = 0;
}

static void sse_close_all_fwd(void);

/* ==================== process management ==================== */

static void reap_child(void) {
    if (g_dl_pid > 0) {
        int dst;
        if (waitpid(g_dl_pid, &dst, WNOHANG) == g_dl_pid) {
            printf("model: download of %s finished (exit %d)\n", g_dl_variant,
                   WIFEXITED(dst) ? WEXITSTATUS(dst) : -1);
            g_dl_pid = -1;   /* keep g_dl_variant so status can report 100 / completion once */
        }
    }
    if (g_child <= 0) return;
    int st;
    if (waitpid(g_child, &st, WNOHANG) == g_child) {
        /* The child died on its own (a clean stop goes through stop_child, which
         * reaps it there). Record WHY — exit code/signal + its last line — so the
         * UI can show the reason instead of just "Server unreachable". */
        if (WIFSIGNALED(st))
            snprintf(g_engine_err, sizeof g_engine_err, "engine stopped (signal %d)%s%.200s",
                     WTERMSIG(st), g_last_engine_line[0] ? " — " : "", g_last_engine_line);
        else
            snprintf(g_engine_err, sizeof g_engine_err, "engine exited (code %d)%s%.200s",
                     WIFEXITED(st) ? WEXITSTATUS(st) : -1,
                     g_last_engine_line[0] ? " — " : "", g_last_engine_line);
        printf("engine: pid %d terminated — %s\n", (int)g_child, g_engine_err);
        g_child = -1;
#ifdef _WIN32
        g_child_win_pid = 0;
#endif
        g_mode = ENGINE_NONE;
        g_ready = 0;
    }
}

static void close_pipes(void) {
    if (g_in_fd  >= 0) { close(g_in_fd);  g_in_fd  = -1; }
    if (g_out_fd >= 0) { close(g_out_fd); g_out_fd = -1; }
    if (g_err_fd >= 0) { close(g_err_fd); g_err_fd = -1; }
}

static void stop_child(void) {
    sse_close_all_fwd();
    if (g_child <= 0) { g_mode = ENGINE_NONE; return; }
    printf("engine: stopping pid %d…\n", (int)g_child);
    kill(g_child, SIGTERM);
    for (int i = 0; i < 30; i++) {
        int st;
        if (waitpid(g_child, &st, WNOHANG) == g_child) { g_child = -1; break; }
        usleep(100000);
    }
    if (g_child > 0) { kill(g_child, SIGKILL); waitpid(g_child, NULL, 0); g_child = -1; }
#ifdef _WIN32
    g_child_win_pid = 0;
#endif
    close_pipes();
    g_mode = ENGINE_NONE;
    g_ready = 0;
    g_agent_working = 0;
}

/* Kills the EXTERNAL process holding a port (a ds4-server started outside the
 * launcher, e.g. from a terminal): the ds4 instance-lock forbids two large
 * processes, so to switch to agent/design we must free port 28000. Finds the
 * listeners via lsof, SIGTERMs them (never ourselves / our own child), waits
 * for the port to free, escalates to SIGKILL. Best-effort: returns 1 if the
 * port is free afterwards. The launcher runs as the user, so this only ever
 * touches the user's own processes. */
static int kill_external_server(int port) {
#ifdef _WIN32
    /* Windows v1 avoids taskkill heuristics: DStudio can supervise processes it
     * starts, but external listeners must be stopped explicitly by the user. */
    return !port_listening(port);
#else
    char cmd[96];
    snprintf(cmd, sizeof cmd, "lsof -nP -iTCP:%d -sTCP:LISTEN -t 2>/dev/null", port);
    pid_t pids[32];
    int np = 0;
    FILE *fp = popen(cmd, "r");
    if (fp) {
        char ln[32];
        while (np < 32 && fgets(ln, sizeof ln, fp)) {
            long v = strtol(ln, NULL, 10);
            if (v > 0 && (pid_t)v != getpid() && (pid_t)v != g_child) pids[np++] = (pid_t)v;
        }
        pclose(fp);
    }
    if (np == 0) return !port_listening(port); /* nothing found: maybe already gone */
    for (int i = 0; i < np; i++) { printf("engine: freeing port %d — SIGTERM %d\n", port, (int)pids[i]); kill(pids[i], SIGTERM); }
    for (int t = 0; t < 30 && port_listening(port); t++) usleep(100000); /* up to 3s */
    if (port_listening(port)) {
        for (int i = 0; i < np; i++) kill(pids[i], SIGKILL);
        for (int t = 0; t < 20 && port_listening(port); t++) usleep(100000); /* up to 2s */
    }
    return !port_listening(port);
#endif
}

/* Common to both spawns: prepares the Metal env in the child. */
static void child_setenv_metal(void) {
    setenv("DS4_METAL_NO_RESIDENCY", "1", 1);
    setenv("DS4_METAL_NO_MODEL_WARMUP", "1", 1);
    setenv("DS4_METAL_PREFILL_CHUNK", "1024", 1);
    setenv("DS4_METAL_GRAPH_TOKEN_SPLIT_LAYERS", "0", 1);
}

/* The 19 Metal sources are loaded relative to the cwd (ds4_metal.m). With
 * the agent's --chdir the cwd becomes the project working dir, so they must
 * be forced to absolute via the env overrides, otherwise "metal backend
 * unavailable". (envvar, file) mirror the list in ds4_metal.m. */
static const char *const METAL_SRC[][2] = {
    {"DS4_METAL_FLASH_ATTN_SOURCE", "flash_attn.metal"},
    {"DS4_METAL_DENSE_SOURCE",      "dense.metal"},
    {"DS4_METAL_MOE_SOURCE",        "moe.metal"},
    {"DS4_METAL_DSV4_HC_SOURCE",    "dsv4_hc.metal"},
    {"DS4_METAL_UNARY_SOURCE",      "unary.metal"},
    {"DS4_METAL_DSV4_KV_SOURCE",    "dsv4_kv.metal"},
    {"DS4_METAL_DSV4_ROPE_SOURCE",  "dsv4_rope.metal"},
    {"DS4_METAL_DSV4_MISC_SOURCE",  "dsv4_misc.metal"},
    {"DS4_METAL_ARGSORT_SOURCE",    "argsort.metal"},
    {"DS4_METAL_CPY_SOURCE",        "cpy.metal"},
    {"DS4_METAL_CONCAT_SOURCE",     "concat.metal"},
    {"DS4_METAL_GET_ROWS_SOURCE",   "get_rows.metal"},
    {"DS4_METAL_SUM_ROWS_SOURCE",   "sum_rows.metal"},
    {"DS4_METAL_SOFTMAX_SOURCE",    "softmax.metal"},
    {"DS4_METAL_REPEAT_SOURCE",     "repeat.metal"},
    {"DS4_METAL_GLU_SOURCE",        "glu.metal"},
    {"DS4_METAL_NORM_SOURCE",       "norm.metal"},
    {"DS4_METAL_BIN_SOURCE",        "bin.metal"},
    {"DS4_METAL_SET_ROWS_SOURCE",   "set_rows.metal"},
};

static void child_setenv_metal_sources(const char *ds4_abs) {
    char p[DSTUDIO_PATH_MAX + 64];
    for (size_t i = 0; i < sizeof METAL_SRC / sizeof METAL_SRC[0]; i++) {
        snprintf(p, sizeof p, "%s/metal/%s", ds4_abs, METAL_SRC[i][1]);
        setenv(METAL_SRC[i][0], p, 1);
    }
}

/* Writable directory for USER-authored skills (created via the web UI). Each skill is
 * <dir>/<id>/SKILL.md, available to the agent (and design) like a shipped pack. */
static void user_skills_dir(char *out, size_t outsz) {
#ifdef _WIN32
    const char *base = getenv("LOCALAPPDATA");
    if (!base || !base[0]) base = getenv("USERPROFILE");
    snprintf(out, outsz, "%s\\DStudio\\ds4-skills", base ? base : ".");
#else
    const char *home = getenv("HOME");
    snprintf(out, outsz, "%s/.local/share/flashcards/ds4-skills", home ? home : ".");
#endif
}

/* Point the engine's on-demand skill()/design_system() tools at this DStudio checkout's
 * shipped pack library (extension/) AND the writable user-skills directory. Set in the
 * child before exec; an absent dir → the tools fall back / report "no pack" gracefully. */
static void child_setenv_skills(void) {
    if (g_web_dir[0]) {
        char p[1100];
        snprintf(p, sizeof p, "%s/extension", g_web_dir);
        setenv("DS4UI_SKILLS_DIR", p, 1);
    }
    char u[1100];
    user_skills_dir(u, sizeof u);
    setenv("DS4UI_USER_SKILLS_DIR", u, 1);
}

static void reset_progress(const char *stage0) {
    g_load_pct = 5;
    g_ready = 0;
    snprintf(g_stage, sizeof g_stage, "%s", stage0);
    g_line_out_len = g_line_err_len = 0;
    g_engine_err[0] = g_last_engine_line[0] = '\0';   /* fresh start: clear the last death reason */
}

#ifdef _WIN32
static void win_arg_append(char *cmd, size_t cap, const char *arg) {
    size_t o = strlen(cmd);
    if (o && o + 1 < cap) cmd[o++] = ' ';
    if (o + 1 >= cap) return;
    cmd[o++] = '"';
    int bs = 0;
    for (const char *p = arg ? arg : ""; *p && o + 4 < cap; p++) {
        if (*p == '\\') { bs++; continue; }
        if (*p == '"') {
            while (bs-- > 0 && o + 1 < cap) cmd[o++] = '\\';
            if (o + 1 < cap) cmd[o++] = '\\';
            if (o + 1 < cap) cmd[o++] = '"';
            bs = 0;
            continue;
        }
        while (bs-- > 0 && o + 1 < cap) cmd[o++] = '\\';
        cmd[o++] = *p;
        bs = 0;
    }
    while (bs-- > 0 && o + 2 < cap) { cmd[o++] = '\\'; cmd[o++] = '\\'; }
    if (o + 1 < cap) cmd[o++] = '"';
    cmd[o] = '\0';
}

static void win_join_path(char *out, size_t outsz, const char *a, const char *b) {
    snprintf(out, outsz, "%s\\%s", a ? a : ".", b ? b : "");
}

static int win_spawn(const char *cwd, char *const argv[], int want_stdin,
                     int *in_w, int *out_r, int *err_r, pid_t *pid_out,
                     char *err, size_t errsz) {
    SECURITY_ATTRIBUTES sa = { sizeof(sa), NULL, TRUE };
    HANDLE in_r = NULL, in_w_h = NULL, out_r_h = NULL, out_w = NULL, err_r_h = NULL, err_w = NULL;
    if (want_stdin && !CreatePipe(&in_r, &in_w_h, &sa, 0)) {
        snprintf(err, errsz, "CreatePipe(stdin) failed");
        return 0;
    }
    if (!CreatePipe(&out_r_h, &out_w, &sa, 0) || !CreatePipe(&err_r_h, &err_w, &sa, 0)) {
        snprintf(err, errsz, "CreatePipe(stdout/stderr) failed");
        if (in_r) CloseHandle(in_r); if (in_w_h) CloseHandle(in_w_h);
        if (out_r_h) CloseHandle(out_r_h); if (out_w) CloseHandle(out_w);
        if (err_r_h) CloseHandle(err_r_h); if (err_w) CloseHandle(err_w);
        return 0;
    }
    if (in_w_h) SetHandleInformation(in_w_h, HANDLE_FLAG_INHERIT, 0);
    SetHandleInformation(out_r_h, HANDLE_FLAG_INHERIT, 0);
    SetHandleInformation(err_r_h, HANDLE_FLAG_INHERIT, 0);

    char cmd[32768] = "";
    for (int i = 0; argv[i]; i++) win_arg_append(cmd, sizeof cmd, argv[i]);

    STARTUPINFOA si;
    PROCESS_INFORMATION pi;
    memset(&si, 0, sizeof si);
    memset(&pi, 0, sizeof pi);
    si.cb = sizeof si;
    si.dwFlags = STARTF_USESTDHANDLES;
    si.hStdInput = want_stdin ? in_r : GetStdHandle(STD_INPUT_HANDLE);
    si.hStdOutput = out_w;
    si.hStdError = err_w;
    BOOL ok = CreateProcessA(NULL, cmd, NULL, NULL, TRUE,
                             CREATE_NEW_PROCESS_GROUP, NULL, cwd, &si, &pi);
    if (in_r) CloseHandle(in_r);
    CloseHandle(out_w);
    CloseHandle(err_w);
    if (!ok) {
        snprintf(err, errsz, "CreateProcess failed for %s (error %lu)", argv[0], GetLastError());
        if (in_w_h) CloseHandle(in_w_h);
        CloseHandle(out_r_h);
        CloseHandle(err_r_h);
        return 0;
    }
    CloseHandle(pi.hThread);
    g_last_spawn_win_pid = pi.dwProcessId;
    if (want_stdin) *in_w = (int)(intptr_t)in_w_h;
    else if (in_w) *in_w = -1;
    *out_r = (int)(intptr_t)out_r_h;
    *err_r = (int)(intptr_t)err_r_h;
    *pid_out = (pid_t)pi.hProcess;
    return 1;
}
#endif

/* Starts ds4-server. out/err piped to us for progress. */
static int spawn_server(const engine_cfg *cfg, char *err, size_t errsz) {
    if (!file_present(current_model_rel())) {
        snprintf(err, errsz, "model %.16s not found in %.180s",
                 g_variant, g_ds4_dir);
        return 0;
    }
    if (port_listening(cfg->port)) {
        snprintf(err, errsz, "port %d already in use: close the other process or change port", cfg->port);
        return 0;
    }
    char kvdir[2048];
    kv_dir_for_model(current_model_rel(), kvdir, sizeof kvdir);  /* per-model cache */
    mkpath(kvdir);

#ifdef _WIN32
    if (!file_present("ds4-server.exe")) {
        snprintf(err, errsz, "ds4-server.exe not found in %s — use the Windows CPU artifact", g_ds4_dir);
        return 0;
    }
    int op[2], ep[2];
    (void)op; (void)ep;
    char exe[2200];
    win_join_path(exe, sizeof exe, g_ds4_dir, "ds4-server.exe");
    char ports[16], ctxs[16], pows[16], kvs[16], mins[16];
    snprintf(ports, sizeof ports, "%d", cfg->port);
    snprintf(ctxs,  sizeof ctxs,  "%d", cfg->ctx);
    snprintf(pows,  sizeof pows,  "%d", cfg->power);
    snprintf(kvs,   sizeof kvs,   "%d", cfg->kv_space_mb);
    snprintf(mins,  sizeof mins,  "%d", cfg->kv_min_tok);
    char *argv[] = {
        exe, "-m", (char *)current_model_rel(), "--cpu",
        "--host", g_bind_host, "--port", ports, "--ctx", ctxs, "--power", pows,
        "--kv-disk-dir", kvdir, "--kv-disk-space-mb", kvs,
        "--kv-cache-min-tokens", mins, "--cors", NULL
    };
    pid_t pid = 0;
    if (!win_spawn(g_ds4_dir, argv, 0, NULL, &g_out_fd, &g_err_fd, &pid, err, errsz))
        return 0;
    g_child_win_pid = g_last_spawn_win_pid;
    g_child = pid; g_mode = ENGINE_SERVER; g_cfg = *cfg;
    reset_progress("Starting the server…");
    printf("engine: server pid %ld (port %d, windows cpu)\n", (long)pid, cfg->port);
    return 1;
#else
    int op[2], ep[2];
    if (pipe(op) != 0 || pipe(ep) != 0) { snprintf(err, errsz, "pipe failed"); return 0; }

    char ports[16], ctxs[16], pows[16], kvs[16], mins[16];
    snprintf(ports, sizeof ports, "%d", cfg->port);
    snprintf(ctxs,  sizeof ctxs,  "%d", cfg->ctx);
    snprintf(pows,  sizeof pows,  "%d", cfg->power);
    snprintf(kvs,   sizeof kvs,   "%d", cfg->kv_space_mb);
    snprintf(mins,  sizeof mins,  "%d", cfg->kv_min_tok);

    pid_t pid = fork();
    if (pid < 0) { snprintf(err, errsz, "fork: %s", strerror(errno)); return 0; }
    if (pid == 0) {
        if (chdir(g_ds4_dir) != 0) _exit(127);
        child_setenv_metal();
        dup2(op[1], STDOUT_FILENO);
        dup2(ep[1], STDERR_FILENO);
        close(op[0]); close(op[1]); close(ep[0]); close(ep[1]);
        if (g_srv_fd >= 0) close(g_srv_fd);
        char *argv[] = {
            "./ds4-server", "-m", (char *)current_model_rel(),
            "--host", g_bind_host, "--port", ports, "--ctx", ctxs, "--power", pows,
            "--kv-disk-dir", kvdir, "--kv-disk-space-mb", kvs,
            "--kv-cache-min-tokens", mins, "--cors", NULL
        };
        execv("./ds4-server", argv);
        _exit(127);
    }
    close(op[1]); close(ep[1]);
    g_out_fd = op[0]; g_err_fd = ep[0];
    set_nonblock(g_out_fd); set_nonblock(g_err_fd);
    g_child = pid; g_mode = ENGINE_SERVER; g_cfg = *cfg;
    reset_progress("Starting the server…");
    printf("engine: server pid %d (port %d, %s)\n", (int)pid, cfg->port,
           cfg->uncensored ? "uncensored" : "standard");
    return 1;
#endif
}

/* ============================================================================
 * --jsonl extension: ALL here (no external scripts/files).
 * Reversible and additive patch of ds4_agent.c: adds a --jsonl flag (opt-in,
 * gated), the event emitters (tool_call/tool_result/reasoning_*) on a
 * JSON line prefixed by \x1e, and (v3+) the dispatch of the session slash
 * commands (/save /list /new /switch /del /compact /help) + the end-of-turn
 * autosave in the non-interactive loop. Builds ds4-agent-jsonl under a SEPARATE NAME
 * reusing the existing .o (via `make -f -` that includes the ds4 Makefile),
 * then immediately RESTORES the source from the .bak. The canonical ds4-agent and ds4_agent.o
 * are never touched. Crash-clean at startup if the source stays patched.
 * The edits below are generated (escaping verified) from an anchored table.
 * ============================================================================ */
#define JSONL_MARK "/*DS4UI_JSONL*/"
#define WEB_CDP_MARK "/*DS4UI_WEB_CDP*/"
#define WEB_DIRECT_NAV_MARK "/*DS4UI_WEB_DIRECT_NAV*/"
#define JSONL_PATCH_VERSION 19  /* bump when the edits change: forces the rebuild */
#define JSONL_REMOTE_AGENT_FRAGMENT "extension/remote/ds4_agent_remote.cfrag"

static const char *JSONL_EDITS[][2] = {
  { "#include \"ds4_web.h\"\n",
    "#include \"ds4_web.h\"\n#include \"dstudio_remote_llm.h\" /*DS4UI_JSONL*/\n" },
  { "    bool non_interactive;\n",
    "    bool non_interactive;\n    bool jsonl; /*DS4UI_JSONL*/\n    bool web_tool_mode; /*DS4UI_JSONL*/\n    const char *web_tool; /*DS4UI_JSONL*/\n    const char *web_query; /*DS4UI_JSONL*/\n    const char *web_url; /*DS4UI_JSONL*/\n    const char *remote_base_url; /*DS4UI_JSONL*/\n    const char *remote_model; /*DS4UI_JSONL*/\n" },
  { "        } else if (!strcmp(arg, \"--non-interactive\")) {\n            c.non_interactive = true;\n",
    "        } else if (!strcmp(arg, \"--non-interactive\")) {\n            c.non_interactive = true;\n        } else if (!strcmp(arg, \"--jsonl\")) {   /*DS4UI_JSONL*/\n            c.jsonl = true;\n        } else if (!strcmp(arg, \"--web-tool\")) {   /*DS4UI_JSONL*/\n            c.web_tool_mode = true;\n            c.web_tool = need_arg(&i, argc, argv, arg);\n        } else if (!strcmp(arg, \"--query\")) {   /*DS4UI_JSONL*/\n            c.web_query = need_arg(&i, argc, argv, arg);\n        } else if (!strcmp(arg, \"--url\")) {   /*DS4UI_JSONL*/\n            c.web_url = need_arg(&i, argc, argv, arg);\n        } else if (!strcmp(arg, \"--remote-base-url\")) {   /*DS4UI_JSONL*/\n            c.remote_base_url = need_arg(&i, argc, argv, arg);\n        } else if (!strcmp(arg, \"--remote-model\")) {   /*DS4UI_JSONL*/\n            c.remote_model = need_arg(&i, argc, argv, arg);\n" },
  { "static void renderer_write(agent_token_renderer *r, const char *s, size_t n) {\n",
    "/*DS4UI_JSONL*/\n/* Opt-in structured output for the UI: one JSON line per event, prefixed by\n * \\x1e (Record Separator) so the consumer tells events from text without\n * heuristics. Additive: active only with --jsonl. */\nstatic void ds4ui_json_escape(const char *s, char *out, size_t cap) {\n    size_t o = 0;\n    for (; s && *s && o + 7 < cap; s++) {\n        unsigned char c = (unsigned char)*s;\n        if (c == '\"' || c == '\\\\') { out[o++] = '\\\\'; out[o++] = (char)c; }\n        else if (c == '\\n') { out[o++] = '\\\\'; out[o++] = 'n'; }\n        else if (c == '\\r') { out[o++] = '\\\\'; out[o++] = 'r'; }\n        else if (c == '\\t') { out[o++] = '\\\\'; out[o++] = 't'; }\n        else if (c < 0x20) { o += (size_t)snprintf(out + o, cap - o, \"\\\\u%04x\", c); }\n        else out[o++] = (char)c;\n    }\n    out[o] = '\\0';\n}\nstatic void ds4ui_emit_event(agent_worker *w, const char *type) {\n    char line[128];\n    int k = snprintf(line, sizeof line, \"\\x1e{\\\"type\\\":\\\"%s\\\"}\\n\", type);\n    agent_publish(w, line, (size_t)k);\n}\nstatic void ds4ui_emit_tool_call(agent_worker *w, const agent_tool_call *tc) {\n    char nm[256];\n    ds4ui_json_escape(tc->name ? tc->name : \"\", nm, sizeof nm);\n    char line[16384];   /* edit old/new + write content need room for the diff the UI renders */\n    int k = snprintf(line, sizeof line,\n        \"\\x1e{\\\"type\\\":\\\"tool_call\\\",\\\"name\\\":\\\"%s\\\",\\\"input\\\":{\", nm);\n    /* snprintf returns the REQUESTED length, not the written one: never add to k\n     * a value that does not fit (k past the buffer = OOB on line+k and a publish\n     * of stack bytes). An arg that does not fit truncates HERE, at a JSON boundary. */\n    for (int j = 0; j < tc->argc; j++) {\n        char an[128], av[6144];\n        ds4ui_json_escape(tc->args[j].name ? tc->args[j].name : \"\", an, sizeof an);\n        ds4ui_json_escape(tc->args[j].value ? tc->args[j].value : \"\", av, sizeof av);\n        int r = snprintf(line + k, sizeof line - k, \"%s\\\"%s\\\":\\\"%s\\\"\", j ? \",\" : \"\", an, av);\n        if (r < 0 || r >= (int)(sizeof line - k) - 4) { line[k] = '\\0'; break; }\n        k += r;\n    }\n    k += snprintf(line + k, sizeof line - k, \"}}\\n\");\n    agent_publish(w, line, (size_t)k);\n}\nstatic void ds4ui_emit_tool_result(agent_worker *w, const char *name, const char *res) {\n    char nm[256];\n    ds4ui_json_escape(name ? name : \"\", nm, sizeof nm);\n    size_t rl = res ? strlen(res) : 0;\n    size_t cap = rl * 6 + 512;\n    char *line = (char *)malloc(cap);\n    if (!line) return;\n    int k = snprintf(line, cap,\n        \"\\x1e{\\\"type\\\":\\\"tool_result\\\",\\\"name\\\":\\\"%s\\\",\\\"output\\\":\\\"\", nm);\n    char *esc = (char *)malloc(rl * 6 + 8);\n    if (esc) { ds4ui_json_escape(res ? res : \"\", esc, rl * 6 + 8);\n               k += snprintf(line + k, cap - k, \"%s\", esc); free(esc); }\n    k += snprintf(line + k, cap - k, \"\\\"}\\n\");\n    agent_publish(w, line, (size_t)k);\n    free(line);\n}\nstatic void renderer_write(agent_token_renderer *r, const char *s, size_t n) {\n" },
  { "static void ds4ui_emit_tool_call(agent_worker *w, const agent_tool_call *tc) {\n",
    "static void ds4ui_emit_question(agent_worker *w, const char *id, const char *title, const char *questions_json) {\n"
    "    char iid[256], ttl[512];\n"
    "    ds4ui_json_escape(id ? id : \"question\", iid, sizeof iid);\n"
    "    ds4ui_json_escape(title ? title : \"Question\", ttl, sizeof ttl);\n"
    "    const char *q = (questions_json && questions_json[0]) ? questions_json : \"[]\";\n"
    "    size_t ql = strlen(q), cap = ql + 1024;\n"
    "    char *line = (char *)malloc(cap);\n"
    "    if (!line) return;\n"
    "    int k = snprintf(line, cap, \"\\x1e{\\\"type\\\":\\\"question\\\",\\\"id\\\":\\\"%s\\\",\\\"title\\\":\\\"%s\\\",\\\"questions\\\":\", iid, ttl);\n"
    "    for (; *q && k + 2 < (int)cap; q++) {\n"
    "        char c = *q;\n"
    "        if (c == '\\n' || c == '\\r' || c == '\\x1e') c = ' ';\n"
    "        line[k++] = c;\n"
    "    }\n"
    "    k += snprintf(line + k, cap - (size_t)k, \"}\\n\");\n"
    "    agent_publish(w, line, (size_t)k);\n"
    "    free(line);\n"
    "}\n"
    "static void ds4ui_emit_tool_call(agent_worker *w, const agent_tool_call *tc) {\n" },
  { "        char *res = agent_execute_tool_call(w, &calls->v[i]);\n",
    "        if (w->cfg->jsonl) ds4ui_emit_tool_call(w, &calls->v[i]);   /*DS4UI_JSONL*/\n        char *res = agent_execute_tool_call(w, &calls->v[i]);\n        if (w->cfg->jsonl) ds4ui_emit_tool_result(w, calls->v[i].name, res);   /*DS4UI_JSONL*/\n" },
  { "            sr->in_think = true;\n            sr->renderer->in_think = true;\n",
    "            sr->in_think = true;\n            sr->renderer->in_think = true;\n            if (sr->renderer->worker->cfg->jsonl) ds4ui_emit_event(sr->renderer->worker, \"reasoning_start\");   /*DS4UI_JSONL*/\n" },
  { "            sr->in_think = false;\n            sr->renderer->in_think = false;\n",
    "            sr->in_think = false;\n            sr->renderer->in_think = false;\n            if (sr->renderer->worker->cfg->jsonl) ds4ui_emit_event(sr->renderer->worker, \"reasoning_end\");   /*DS4UI_JSONL*/\n" },

  /* ---- v3: slash commands + session autosave on the non-interactive pipe ----
   * Without these edits every stdin line (even "/save", "/switch …") would be
   * submitted to the MODEL as a prompt: the agent's KV sessions would be out of
   * reach for the web UI. The C handlers already exist (save/list/new/
   * switch/del); this only adds the dispatch to an idle worker + the
   * end-of-turn autosave (same save-on-turn as ds4-design), gated on --jsonl. */
  { "static int run_agent_non_interactive(ds4_engine *engine, agent_config *cfg) {\n",
    "/*DS4UI_JSONL*/\n"
    "/* Slash commands on the pipe (web UI): in the non-interactive loop every\n"
    " * stdin line would end up at the MODEL as a prompt; here /save /list /new\n"
    " * /switch /del /compact /help are actually executed (idle worker only),\n"
    " * with text output on stdout -> the UI transcript. Only with --jsonl. */\n"
    "static void ds4ui_slash_trim(const char *line, char *cmd, size_t cap) {\n"
    "    while (*line == ' ' || *line == '\\t' || *line == '\\n' || *line == '\\r') line++;\n"
    "    size_t n = 0;\n"
    "    for (; line[n] && line[n] != '\\n' && n < cap - 1; n++) cmd[n] = line[n];\n"
    "    cmd[n] = '\\0';\n"
    "    while (n && (cmd[n-1] == ' ' || cmd[n-1] == '\\t' || cmd[n-1] == '\\r')) cmd[--n] = '\\0';\n"
    "}\n"
    "static bool ds4ui_pipe_slash(const char *line) {\n"
    "    char cmd[256];\n"
    "    ds4ui_slash_trim(line, cmd, sizeof(cmd));\n"
    "    if (cmd[0] != '/') return false;\n"
    "    const char *p = line;\n"
    "    while (*p == ' ' || *p == '\\t' || *p == '\\n' || *p == '\\r') p++;\n"
    "    p = strchr(p, '\\n');\n"
    "    if (p) {\n"
    "        while (*p == ' ' || *p == '\\t' || *p == '\\n' || *p == '\\r') p++;\n"
    "        if (*p) return false; /* multi-line: it is a prompt, not a command */\n"
    "    }\n"
    "    return !strcmp(cmd, \"/save\") || !strcmp(cmd, \"/list\") ||\n"
    "           !strcmp(cmd, \"/new\") || !strcmp(cmd, \"/help\") ||\n"
    "           !strcmp(cmd, \"/compact\") ||\n"
    "           agent_slash_command_with_args(cmd, \"/switch\") ||\n"
    "           agent_slash_command_with_args(cmd, \"/del\");\n"
    "}\n"
    "static void ds4ui_handle_slash_idle(agent_worker *w, const char *line) {\n"
    "    char cmd[256];\n"
    "    char err[160] = {0};\n"
    "    ds4ui_slash_trim(line, cmd, sizeof(cmd));\n"
    "    if (!strcmp(cmd, \"/save\")) {\n"
    "        if (!agent_worker_save_session(w, err, sizeof(err)))\n"
    "            printf(\"save failed: %s\\n\", err);\n"
    "    } else if (!strcmp(cmd, \"/list\")) {\n"
    "        agent_worker_list_sessions(w);\n"
    "    } else if (!strcmp(cmd, \"/help\")) {\n"
    "        printf(\"commands: /save /list /new /switch <sha> /del <sha> /compact\\n\");\n"
    "    } else if (!strcmp(cmd, \"/compact\")) {\n"
    "        worker_request_compact(w);\n"
    "        printf(\"compaction scheduled\\n\");\n"
    "    } else if (!strcmp(cmd, \"/new\")) {\n"
    "        if (agent_worker_needs_save(w) &&\n"
    "            !agent_worker_save_session(w, err, sizeof(err)))\n"
    "            printf(\"save failed: %s\\n\", err);\n"
    "        err[0] = '\\0';\n"
    "        if (!agent_worker_reset_to_sysprompt(w, err, sizeof(err)))\n"
    "            printf(\"new session failed: %s\\n\", err);\n"
    "        else\n"
    "            printf(\"new session started\\n\");\n"
    "    } else if (agent_slash_command_with_args(cmd, \"/switch\")) {\n"
    "        char *arg = cmd + 7;\n"
    "        while (*arg == ' ' || *arg == '\\t') arg++;\n"
    "        if (!arg[0]) {\n"
    "            printf(\"usage: /switch <sha-prefix>\\n\");\n"
    "        } else {\n"
    "            char *sha = arg;\n"
    "            while (*arg && *arg != ' ' && *arg != '\\t') arg++;\n"
    "            *arg = '\\0';\n"
    "            if (agent_worker_needs_save(w) &&\n"
    "                !agent_worker_save_session(w, err, sizeof(err)))\n"
    "                printf(\"save failed: %s\\n\", err);\n"
    "            err[0] = '\\0';\n"
    "            if (!agent_worker_switch_session(w, sha, 0, err, sizeof(err)))\n"
    "                printf(\"switch failed: %s\\n\", err);\n"
    "        }\n"
    "    } else if (agent_slash_command_with_args(cmd, \"/del\")) {\n"
    "        char *arg = cmd + 4;\n"
    "        while (*arg == ' ' || *arg == '\\t') arg++;\n"
    "        if (!arg[0]) {\n"
    "            printf(\"usage: /del <sha-prefix>\\n\");\n"
    "        } else {\n"
    "            char *sha_arg = arg;\n"
    "            while (*arg && *arg != ' ' && *arg != '\\t') arg++;\n"
    "            *arg = '\\0';\n"
    "            char sha[41] = {0};\n"
    "            if (agent_worker_delete_session(w, sha_arg, sha, err, sizeof(err)))\n"
    "                printf(\"deleted session %.8s\\n\", sha);\n"
    "            else\n"
    "                printf(\"delete failed: %s\\n\", err);\n"
    "        }\n"
    "    }\n"
    "    fflush(stdout);\n"
    "}\n"
    "static int run_agent_non_interactive(ds4_engine *engine, agent_config *cfg) {\n" },
  { "            agent_noninteractive_marker(\"+DWARFSTAR_WAITING\");\n            waiting_announced = true;\n",
    "            if (cfg->jsonl && agent_worker_needs_save(&worker)) {   /*DS4UI_JSONL: save-on-turn like ds4-design*/\n"
    "                char ds4ui_err[160] = {0};\n"
    "                if (!agent_worker_save_session(&worker, ds4ui_err, sizeof(ds4ui_err)))\n"
    "                    printf(\"save failed: %s\\n\", ds4ui_err);\n"
    "                fflush(stdout);\n"
    "            }\n"
    "            agent_noninteractive_marker(\"+DWARFSTAR_WAITING\");\n            waiting_announced = true;\n" },
  { "            char *prompt = agent_input_buf_take(&input);\n            if (worker_is_idle(&worker) && queue.len == 0) {\n                if (!worker_submit(&worker, prompt)) {\n",
    "            char *prompt = agent_input_buf_take(&input);\n"
    "            if (cfg->jsonl && ds4ui_pipe_slash(prompt)) {   /*DS4UI_JSONL*/\n"
    "                if (worker_is_idle(&worker) && queue.len == 0) {\n"
    "                    ds4ui_handle_slash_idle(&worker, prompt);\n"
    "                } else {\n"
    "                    printf(\"command ignored (model busy)\\n\");\n"
    "                    fflush(stdout);\n"
    "                }\n"
    "            } else if (worker_is_idle(&worker) && queue.len == 0) {\n                if (!worker_submit(&worker, prompt)) {\n" },
  { "static char *agent_execute_tool_call(agent_worker *w, const agent_tool_call *call) {\n",
    "/*DS4UI_JSONL*/\n/* Post-edit verification (DStudio): after a write/edit, run a cheap single-file\n * syntax check on the touched path and append any errors to the tool result, so\n * the model fixes them in the same turn instead of shipping broken code. Only\n * reliable single-file checkers (no project context) are used, so false\n * positives are rare; C falls back to cc -fsyntax-only and suppresses\n * missing-include noise. Gated on --jsonl. */\nstatic char *ds4ui_verify_after(agent_worker *w, const agent_tool_call *call, char *result) {\n    if (!w || !w->cfg || !w->cfg->jsonl || !result) return result;\n    if (!strncmp(result, \"Tool error\", 10)) return result;\n    const char *path = agent_tool_arg_value(call, \"path\");\n    if (!path || !path[0]) return result;\n    const char *dot = strrchr(path, '.');\n    if (!dot) return result;\n    const char *argv[6] = {0};\n    int is_c = 0;\n    if (!strcmp(dot, \".js\") || !strcmp(dot, \".mjs\") || !strcmp(dot, \".cjs\") || !strcmp(dot, \".jsx\")) {\n        argv[0] = \"node\"; argv[1] = \"--check\"; argv[2] = path;\n    } else if (!strcmp(dot, \".py\")) {\n        argv[0] = \"python3\"; argv[1] = \"-m\"; argv[2] = \"py_compile\"; argv[3] = path;\n    } else if (!strcmp(dot, \".sh\") || !strcmp(dot, \".bash\")) {\n        argv[0] = \"bash\"; argv[1] = \"-n\"; argv[2] = path;\n    } else if (!strcmp(dot, \".rb\")) {\n        argv[0] = \"ruby\"; argv[1] = \"-c\"; argv[2] = path;\n    } else if (!strcmp(dot, \".json\")) {\n        argv[0] = \"python3\"; argv[1] = \"-m\"; argv[2] = \"json.tool\"; argv[3] = path; argv[4] = \"/dev/null\";\n    } else if (!strcmp(dot, \".go\")) {\n        argv[0] = \"gofmt\"; argv[1] = \"-e\"; argv[2] = path;\n    } else if (!strcmp(dot, \".c\") || !strcmp(dot, \".h\") || !strcmp(dot, \".cc\") || !strcmp(dot, \".cpp\")) {\n        argv[0] = \"cc\"; argv[1] = \"-fsyntax-only\"; argv[2] = path; is_c = 1;\n    } else {\n        return result;\n    }\n    int pfd[2];\n    if (pipe(pfd) != 0) return result;\n    pid_t pid = fork();\n    if (pid < 0) { close(pfd[0]); close(pfd[1]); return result; }\n    if (pid == 0) {\n        dup2(pfd[1], STDOUT_FILENO); dup2(pfd[1], STDERR_FILENO);\n        close(pfd[0]); close(pfd[1]);\n        int dn = open(\"/dev/null\", O_RDONLY);\n        if (dn >= 0) { dup2(dn, STDIN_FILENO); close(dn); }\n        execvp(argv[0], (char *const *)argv);\n        _exit(127);\n    }\n    close(pfd[1]);\n    char out[4096]; size_t n = 0; char chunk[1024]; ssize_t r;\n    while ((r = read(pfd[0], chunk, sizeof(chunk))) > 0) {\n        size_t room = sizeof(out) - 1 - n;\n        if (room > 0) { size_t c = (size_t)r < room ? (size_t)r : room; memcpy(out + n, chunk, c); n += c; }\n    }\n    out[n] = '\\0';\n    close(pfd[0]);\n    int status = 0; waitpid(pid, &status, 0);\n    int failed = !(WIFEXITED(status) && WEXITSTATUS(status) == 0);\n    if (!failed) return result;\n    if (n == 0) return result;\n    if (is_c && strstr(out, \"fatal error\")) return result;\n    agent_buf b = {0};\n    agent_buf_puts(&b, result);\n    if (result[0] && result[strlen(result) - 1] != '\\n') agent_buf_puts(&b, \"\\n\");\n    agent_buf_puts(&b, \"[verify] \");\n    agent_buf_puts(&b, argv[0]);\n    agent_buf_puts(&b, \" reported problems in \");\n    agent_buf_puts(&b, path);\n    agent_buf_puts(&b, \" - fix them before continuing:\\n\");\n    agent_buf_puts(&b, out);\n    agent_buf_puts(&b, \"\\n\");\n    free(result);\n    return agent_buf_take(&b);\n}\nstatic char *agent_execute_tool_call(agent_worker *w, const agent_tool_call *call) {\n" },
  { "    if (!strcmp(call->name, \"write\")) return agent_tool_write(w, call);\n    if (!strcmp(call->name, \"list\")) return agent_tool_list(call);\n    if (!strcmp(call->name, \"edit\")) return agent_tool_edit(w, call);\n",
    "    if (!strcmp(call->name, \"write\")) return ds4ui_verify_after(w, call, agent_tool_write(w, call));   /*DS4UI_JSONL*/\n    if (!strcmp(call->name, \"list\")) return agent_tool_list(call);\n    if (!strcmp(call->name, \"edit\")) return ds4ui_verify_after(w, call, agent_tool_edit(w, call));   /*DS4UI_JSONL*/\n" },
  { "    bool sigint_installed = !cfg.non_interactive &&\n        sigaction(SIGINT, &sa, &old_int) == 0;",
    "    bool sigint_installed = (!cfg.non_interactive || cfg.jsonl) &&   /*DS4UI_JSONL: install the SIGINT handler in piped mode so a turn can be interrupted*/\n        sigaction(SIGINT, &sa, &old_int) == 0;" },
	  { "        int prc = poll(pfd, (nfds_t)nfds, timeout_ms);\n        if (prc < 0) {",
	    "        int prc = poll(pfd, (nfds_t)nfds, timeout_ms);\n        if (cfg->jsonl && agent_sigint) {   /*DS4UI_JSONL: SIGINT aborts the current turn (the UI deleted the live conversation) without killing the engine*/\n            agent_sigint = 0;\n            if (!worker_is_idle(&worker)) worker_interrupt(&worker);\n        }\n        if (prc < 0) {" },

	  /* ---- MEMORY.MD for ds4-agent-jsonl (DStudio) ----
	   * The upstream source is not edited permanently.  The generated JSONL agent
	   * reads a project-root MEMORY.MD into system context and writes the true
	   * compact summary back after antirez's compaction succeeds. */
	  { "static void agent_worker_build_system_tokens(agent_worker *w, ds4_tokens *out) {\n",
	    "/*DS4UI_JSONL*/\n"
	    "#define DS4UI_MEMORY_MAX_BYTES (32 * 1024)\n"
	    "static char *ds4ui_memory_read_md(void) {\n"
	    "    FILE *fp = fopen(\"MEMORY.MD\", \"rb\");\n"
	    "    if (!fp) return NULL;\n"
	    "    agent_buf b = {0};\n"
	    "    char tmp[4096];\n"
	    "    while (b.len < DS4UI_MEMORY_MAX_BYTES) {\n"
	    "        size_t room = DS4UI_MEMORY_MAX_BYTES - b.len;\n"
	    "        size_t want = room < sizeof(tmp) ? room : sizeof(tmp);\n"
	    "        size_t n = fread(tmp, 1, want, fp);\n"
	    "        if (n) agent_buf_append(&b, tmp, n);\n"
	    "        if (n < want) break;\n"
	    "    }\n"
	    "    fclose(fp);\n"
	    "    return agent_buf_take(&b);\n"
	    "}\n"
	    "static void ds4ui_memory_write_md(const char *summary, const char *reason) {\n"
	    "    if (!summary || !summary[0]) return;\n"
	    "    time_t t = time(NULL);\n"
	    "    struct tm tmv;\n"
	    "    gmtime_r(&t, &tmv);\n"
	    "    char ts[32];\n"
	    "    strftime(ts, sizeof(ts), \"%Y-%m-%dT%H:%M:%SZ\", &tmv);\n"
	    "    agent_buf b = {0};\n"
	    "    agent_buf_puts(&b, \"# MEMORY.MD\\n\\n\");\n"
	    "    agent_buf_puts(&b, \"Shared durable memory for DS4 agents working in this workspace.\\n\\n\");\n"
	    "    agent_buf_puts(&b, \"## Durable Summary\\n\\n\");\n"
	    "    agent_buf_puts(&b, summary);\n"
	    "    if (b.len && b.ptr[b.len - 1] != '\\n') agent_buf_puts(&b, \"\\n\");\n"
	    "    agent_buf_puts(&b, \"\\n## Runtime State\\n\\n- Updated: \");\n"
	    "    agent_buf_puts(&b, ts);\n"
	    "    agent_buf_puts(&b, \"\\n- Runtime: ds4-agent-jsonl\");\n"
	    "    if (reason && reason[0]) { agent_buf_puts(&b, \"\\n- Last compact reason: \"); agent_buf_puts(&b, reason); }\n"
	    "    agent_buf_puts(&b, \"\\n\");\n"
	    "    char tmp_path[64];\n"
	    "    snprintf(tmp_path, sizeof(tmp_path), \"MEMORY.MD.tmp.%ld\", (long)getpid());\n"
	    "    FILE *fp = fopen(tmp_path, \"wb\");\n"
	    "    if (!fp) { free(b.ptr); return; }\n"
	    "    bool ok = fwrite(b.ptr ? b.ptr : \"\", 1, b.len, fp) == b.len;\n"
	    "    ok = fclose(fp) == 0 && ok;\n"
	    "    if (ok) rename(tmp_path, \"MEMORY.MD\"); else unlink(tmp_path);\n"
	    "    free(b.ptr);\n"
	    "}\n"
	    "static void agent_worker_build_system_tokens(agent_worker *w, ds4_tokens *out) {\n" },
	  { "    agent_append_system_prompt(w->engine, out, w->cfg->gen.system);\n}\n",
	    "    agent_append_system_prompt(w->engine, out, w->cfg->gen.system);\n"
	    "    if (w->cfg->jsonl) {   /*DS4UI_JSONL*/\n"
	    "        char *mem = ds4ui_memory_read_md();\n"
	    "        if (mem && mem[0]) {\n"
	    "            agent_buf m = {0};\n"
	    "            agent_buf_puts(&m, \"PROJECT MEMORY (runtime summary from MEMORY.MD):\\n\\n\");\n"
	    "            agent_buf_puts(&m, mem);\n"
	    "            ds4_chat_append_message(w->engine, out, \"system\", m.ptr ? m.ptr : \"\");\n"
	    "            free(m.ptr);\n"
	    "        }\n"
	    "        free(mem);\n"
	    "    }\n"
	    "}\n" },
	  { "    ds4_chat_append_message(w->engine, &compacted, \"system\", summary_msg.ptr);\n    free(summary_msg.ptr);\n    free(summary.ptr);\n\n    agent_tokens_append_range(&compacted, &w->transcript, tail_start, bottom);\n",
	    "    ds4_chat_append_message(w->engine, &compacted, \"system\", summary_msg.ptr);\n    free(summary_msg.ptr);\n    if (w->cfg->jsonl) ds4ui_memory_write_md(summary.ptr, reason);   /*DS4UI_JSONL*/\n    free(summary.ptr);\n\n    agent_tokens_append_range(&compacted, &w->transcript, tail_start, bottom);\n" },

	  /* ---- on-demand skill / design-system tools (DStudio) ----
   * The model can pull a focused recipe or brand mid-conversation, no restart, by
   * calling skill(name) / design_system(name). The packs live in this DStudio checkout
   * (DS4UI_SKILLS_DIR set by the launcher); name is sanitised so it can't escape it.
   * Two edits: define the loaders before agent_tool_read, register them in the dispatch. */
  { "static char *agent_tool_read(agent_worker *w, const agent_tool_call *call) {\n",
    "/*DS4UI_JSONL*/\n"
    "static int ds4ui_pack_name_ok(const char *s) {\n"
    "    if (!s || !s[0]) return 0;\n"
    "    for (const char *p = s; *p; p++)\n"
    "        if (!((*p >= 'a' && *p <= 'z') || (*p >= '0' && *p <= '9') || *p == '-')) return 0;\n"
    "    return 1;\n"
    "}\n"
    "static char *ds4ui_read_file_buf(const char *path) {\n"
    "    FILE *f = fopen(path, \"rb\");\n"
    "    if (!f) return NULL;\n"
    "    agent_buf b = {0};\n"
    "    char chunk[4096]; size_t n;\n"
    "    while ((n = fread(chunk, 1, sizeof chunk, f)) > 0) agent_buf_append(&b, chunk, n);\n"
    "    fclose(f);\n"
    "    return agent_buf_take(&b);\n"
    "}\n"
    "static char *ds4ui_read_file_buf_limit(const char *path, size_t cap, int *truncated) {\n"
    "    if (truncated) *truncated = 0;\n"
    "    FILE *f = fopen(path, \"rb\");\n"
    "    if (!f) return NULL;\n"
    "    agent_buf b = {0};\n"
    "    char chunk[4096];\n"
    "    while (b.len < cap) {\n"
    "        size_t room = cap - b.len;\n"
    "        size_t want = room < sizeof(chunk) ? room : sizeof(chunk);\n"
    "        size_t n = fread(chunk, 1, want, f);\n"
    "        if (n) agent_buf_append(&b, chunk, n);\n"
    "        if (n < want) break;\n"
    "    }\n"
    "    if (!feof(f) && truncated) *truncated = 1;\n"
    "    fclose(f);\n"
    "    return agent_buf_take(&b);\n"
    "}\n"
    "static int ds4ui_pack_file_ext_ok(const char *rel) {\n"
    "    const char *dot = strrchr(rel, '.');\n"
    "    if (!dot) return 0;\n"
    "    return !strcmp(dot, \".md\") || !strcmp(dot, \".html\") ||\n"
    "           !strcmp(dot, \".css\") || !strcmp(dot, \".js\") ||\n"
    "           !strcmp(dot, \".json\") || !strcmp(dot, \".svg\") ||\n"
    "           !strcmp(dot, \".txt\") || !strcmp(dot, \".csv\");\n"
    "}\n"
    "static int ds4ui_pack_file_rel_ok(const char *rel, char *err, size_t errsz) {\n"
    "    if (!rel || !rel[0]) { snprintf(err, errsz, \"pack_file path is required\"); return 0; }\n"
    "    if (rel[0] == '/' || rel[0] == '~') { snprintf(err, errsz, \"pack_file path must be relative\"); return 0; }\n"
    "    if (strlen(rel) > 512) { snprintf(err, errsz, \"pack_file path too long\"); return 0; }\n"
    "    if (strcmp(rel, \"example.html\") && strncmp(rel, \"assets/\", 7) && strncmp(rel, \"references/\", 11)) {\n"
    "        snprintf(err, errsz, \"pack_file path must be example.html, assets/*, or references/*\"); return 0;\n"
    "    }\n"
    "    if (!ds4ui_pack_file_ext_ok(rel)) { snprintf(err, errsz, \"pack_file extension is not allowed\"); return 0; }\n"
    "    const char *seg = rel;\n"
    "    for (const char *p = rel; ; p++) {\n"
    "        unsigned char c = (unsigned char)*p;\n"
    "        if (c && !(isalnum(c) || c == '/' || c == '-' || c == '_' || c == '.')) {\n"
    "            snprintf(err, errsz, \"pack_file path contains invalid characters\"); return 0;\n"
    "        }\n"
    "        if (c == '/' || c == '\\0') {\n"
    "            size_t n = (size_t)(p - seg);\n"
    "            if (n == 0 || (n == 1 && seg[0] == '.') || (n == 2 && seg[0] == '.' && seg[1] == '.')) {\n"
    "                snprintf(err, errsz, \"pack_file path must not contain . or .. segments\"); return 0;\n"
    "            }\n"
    "            if (!c) break;\n"
    "            seg = p + 1;\n"
    "        }\n"
    "    }\n"
    "    return 1;\n"
    "}\n"
    "static size_t ds4ui_pack_file_cap(const char *rel) {\n"
    "    if (!strcmp(rel, \"example.html\") || !strncmp(rel, \"assets/\", 7)) return 96 * 1024;\n"
    "    return 32 * 1024;\n"
    "}\n"
    "static const char *ds4ui_pack_type_subdir(const char *type, int *allow_user) {\n"
    "    if (allow_user) *allow_user = 0;\n"
    "    if (!type) return NULL;\n"
    "    if (!strcmp(type, \"skill\") || !strcmp(type, \"skills\")) { if (allow_user) *allow_user = 1; return \"skills\"; }\n"
    "    if (!strcmp(type, \"design_system\") || !strcmp(type, \"design-system\") || !strcmp(type, \"design-systems\")) return \"design-systems\";\n"
    "    if (!strcmp(type, \"craft\")) return \"craft\";\n"
    "    return NULL;\n"
    "}\n"
    "static int ds4ui_pack_resolve_existing_file(const char *pack_root, const char *rel, char *out, size_t outsz, char *err, size_t errsz) {\n"
    "    char real_root[PATH_MAX];\n"
    "    if (!realpath(pack_root, real_root)) { snprintf(err, errsz, \"pack root unavailable\"); return 0; }\n"
    "    char joined[PATH_MAX];\n"
    "    if ((size_t)snprintf(joined, sizeof(joined), \"%s/%s\", pack_root, rel) >= sizeof(joined)) { snprintf(err, errsz, \"pack_file path too long\"); return 0; }\n"
    "    char real_file[PATH_MAX];\n"
    "    if (!realpath(joined, real_file)) { snprintf(err, errsz, \"pack_file not found\"); return 0; }\n"
    "    size_t rl = strlen(real_root);\n"
    "    if (strncmp(real_file, real_root, rl) != 0 || (real_file[rl] != '\\0' && real_file[rl] != '/')) {\n"
    "        snprintf(err, errsz, \"pack_file escapes the pack directory\"); return 0;\n"
    "    }\n"
    "    struct stat st;\n"
    "    if (stat(real_file, &st) != 0 || !S_ISREG(st.st_mode)) { snprintf(err, errsz, \"pack_file is not a regular file\"); return 0; }\n"
    "    if ((size_t)snprintf(out, outsz, \"%s\", real_file) >= outsz) { snprintf(err, errsz, \"pack_file path too long\"); return 0; }\n"
    "    return 1;\n"
    "}\n"
    "static char *ds4ui_load_pack(const agent_tool_call *call, const char *subdir, const char *file, int allow_user) {\n"
    "    const char *name = agent_tool_arg_value(call, \"name\");\n"
    "    if (!ds4ui_pack_name_ok(name)) return xstrdup(\"Tool error: name must be a simple id (a-z, 0-9, -)\\n\");\n"
    "    char path[2300]; char *body = NULL;\n"
    "    if (allow_user) {\n"
    "        const char *u = getenv(\"DS4UI_USER_SKILLS_DIR\");\n"
    "        if (u && u[0]) { snprintf(path, sizeof path, \"%s/%s/SKILL.md\", u, name); body = ds4ui_read_file_buf(path); }\n"
    "    }\n"
    "    if (!body) {\n"
    "        const char *root = getenv(\"DS4UI_SKILLS_DIR\");\n"
    "        if (root && root[0]) { snprintf(path, sizeof path, \"%s/%s/%s/%s\", root, subdir, name, file); body = ds4ui_read_file_buf(path); }\n"
    "    }\n"
    "    if (!body) return xstrdup(\"Tool error: no such pack (see the catalog in the system context)\\n\");\n"
    "    return body;\n"
    "}\n"
    "static char *ds4ui_tool_skill(const agent_tool_call *call) { return ds4ui_load_pack(call, \"skills\", \"SKILL.md\", 1); }\n"
    "static char *ds4ui_tool_design_system(const agent_tool_call *call) { return ds4ui_load_pack(call, \"design-systems\", \"DESIGN.md\", 0); }\n"
    "static char *ds4ui_tool_pack_file(const agent_tool_call *call) {\n"
    "    const char *type = agent_tool_arg_value(call, \"type\");\n"
    "    const char *name = agent_tool_arg_value(call, \"name\");\n"
    "    const char *rel = agent_tool_arg_value(call, \"path\");\n"
    "    int allow_user = 0;\n"
    "    const char *subdir = ds4ui_pack_type_subdir(type, &allow_user);\n"
    "    if (!subdir) return xstrdup(\"Tool error: type must be skill, design_system, or craft\\n\");\n"
    "    if (!ds4ui_pack_name_ok(name)) return xstrdup(\"Tool error: name must be a simple id (a-z, 0-9, -)\\n\");\n"
    "    char err[256] = {0};\n"
    "    if (!ds4ui_pack_file_rel_ok(rel, err, sizeof(err))) { agent_buf e = {0}; agent_buf_puts(&e, \"Tool error: \"); agent_buf_puts(&e, err); agent_buf_puts(&e, \"\\n\"); return agent_buf_take(&e); }\n"
    "    char pack_root[2300], full[PATH_MAX];\n"
    "    int found = 0;\n"
    "    if (allow_user) {\n"
    "        const char *u = getenv(\"DS4UI_USER_SKILLS_DIR\");\n"
    "        if (u && u[0]) { snprintf(pack_root, sizeof(pack_root), \"%s/%s\", u, name); found = ds4ui_pack_resolve_existing_file(pack_root, rel, full, sizeof(full), err, sizeof(err)); }\n"
    "    }\n"
    "    if (!found) {\n"
    "        const char *root = getenv(\"DS4UI_SKILLS_DIR\");\n"
    "        if (root && root[0]) { snprintf(pack_root, sizeof(pack_root), \"%s/%s/%s\", root, subdir, name); found = ds4ui_pack_resolve_existing_file(pack_root, rel, full, sizeof(full), err, sizeof(err)); }\n"
    "    }\n"
    "    if (!found) { agent_buf e = {0}; agent_buf_puts(&e, \"Tool error: \"); agent_buf_puts(&e, err[0] ? err : \"pack_file not found\"); agent_buf_puts(&e, \"\\n\"); return agent_buf_take(&e); }\n"
    "    int truncated = 0;\n"
    "    size_t cap = ds4ui_pack_file_cap(rel);\n"
    "    char *body = ds4ui_read_file_buf_limit(full, cap, &truncated);\n"
    "    if (!body) return xstrdup(\"Tool error: pack_file could not be read\\n\");\n"
    "    agent_buf out = {0};\n"
    "    agent_buf_puts(&out, \"[ds4-agent pack_file: \");\n"
    "    agent_buf_puts(&out, type);\n"
    "    agent_buf_puts(&out, \"/\");\n"
    "    agent_buf_puts(&out, name);\n"
    "    agent_buf_puts(&out, \"/\");\n"
    "    agent_buf_puts(&out, rel);\n"
    "    agent_buf_puts(&out, \"]\\n\");\n"
    "    agent_buf_puts(&out, body);\n"
    "    if (truncated) { agent_buf_puts(&out, \"\\n\\n[Truncated pack_file at \"); char nbuf[32]; snprintf(nbuf, sizeof(nbuf), \"%zu\", cap); agent_buf_puts(&out, nbuf); agent_buf_puts(&out, \" bytes. Load a narrower reference if needed.]\\n\"); }\n"
    "    free(body);\n"
    "    return agent_buf_take(&out);\n"
    "}\n"
    "static char *agent_tool_read(agent_worker *w, const agent_tool_call *call) {\n" },
  { "static char *agent_tool_read(agent_worker *w, const agent_tool_call *call) {\n",
    "static const char *ds4ui_json_ws(const char *p, const char *end) { while (p < end && (*p == ' ' || *p == '\\t' || *p == '\\n' || *p == '\\r')) p++; return p; }\n"
    "static int ds4ui_json_hex(char c) { return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F'); }\n"
    "static const char *ds4ui_json_skip_value(const char *p, const char *end, int depth, char *err, size_t errsz);\n"
    "static const char *ds4ui_json_skip_string(const char *p, const char *end, char *err, size_t errsz) {\n"
    "    if (p >= end || *p != '\\\"') { snprintf(err, errsz, \"expected JSON string\"); return NULL; }\n"
    "    for (p++; p < end;) {\n"
    "        unsigned char c = (unsigned char)*p++;\n"
    "        if (c == '\\\"') return p;\n"
    "        if (c < 0x20) { snprintf(err, errsz, \"control character in JSON string\"); return NULL; }\n"
    "        if (c != '\\\\') continue;\n"
    "        if (p >= end) { snprintf(err, errsz, \"unterminated JSON escape\"); return NULL; }\n"
    "        char e = *p++;\n"
    "        if (e == '\\\"' || e == '\\\\' || e == '/' || e == 'b' || e == 'f' || e == 'n' || e == 'r' || e == 't') continue;\n"
    "        if (e == 'u') {\n"
    "            if (end - p < 4 || !ds4ui_json_hex(p[0]) || !ds4ui_json_hex(p[1]) || !ds4ui_json_hex(p[2]) || !ds4ui_json_hex(p[3])) { snprintf(err, errsz, \"bad JSON unicode escape\"); return NULL; }\n"
    "            p += 4; continue;\n"
    "        }\n"
    "        snprintf(err, errsz, \"bad JSON escape\"); return NULL;\n"
    "    }\n"
    "    snprintf(err, errsz, \"unterminated JSON string\"); return NULL;\n"
    "}\n"
    "static const char *ds4ui_json_skip_number(const char *p, const char *end, char *err, size_t errsz) {\n"
    "    if (p < end && *p == '-') p++;\n"
    "    if (p >= end) { snprintf(err, errsz, \"bad JSON number\"); return NULL; }\n"
    "    if (*p == '0') p++;\n"
    "    else if (*p >= '1' && *p <= '9') { while (p < end && isdigit((unsigned char)*p)) p++; }\n"
    "    else { snprintf(err, errsz, \"bad JSON number\"); return NULL; }\n"
    "    if (p < end && *p == '.') { p++; if (p >= end || !isdigit((unsigned char)*p)) { snprintf(err, errsz, \"bad JSON number\"); return NULL; } while (p < end && isdigit((unsigned char)*p)) p++; }\n"
    "    if (p < end && (*p == 'e' || *p == 'E')) { p++; if (p < end && (*p == '+' || *p == '-')) p++; if (p >= end || !isdigit((unsigned char)*p)) { snprintf(err, errsz, \"bad JSON number\"); return NULL; } while (p < end && isdigit((unsigned char)*p)) p++; }\n"
    "    return p;\n"
    "}\n"
    "static char *agent_tool_read(agent_worker *w, const agent_tool_call *call) {\n" },
  { "static char *agent_tool_read(agent_worker *w, const agent_tool_call *call) {\n",
    "static const char *ds4ui_json_skip_array(const char *p, const char *end, int depth, char *err, size_t errsz) {\n"
    "    p++; p = ds4ui_json_ws(p, end);\n"
    "    if (p < end && *p == ']') return p + 1;\n"
    "    for (;;) { p = ds4ui_json_skip_value(p, end, depth + 1, err, errsz); if (!p) return NULL; p = ds4ui_json_ws(p, end); if (p < end && *p == ',') { p++; continue; } if (p < end && *p == ']') return p + 1; snprintf(err, errsz, \"expected ',' or ']' in JSON array\"); return NULL; }\n"
    "}\n"
    "static const char *ds4ui_json_skip_object(const char *p, const char *end, int depth, char *err, size_t errsz) {\n"
    "    p++; p = ds4ui_json_ws(p, end);\n"
    "    if (p < end && *p == '}') return p + 1;\n"
    "    for (;;) { p = ds4ui_json_ws(p, end); if (p >= end || *p != '\\\"') { snprintf(err, errsz, \"expected JSON object key\"); return NULL; } p = ds4ui_json_skip_string(p, end, err, errsz); if (!p) return NULL; p = ds4ui_json_ws(p, end); if (p >= end || *p != ':') { snprintf(err, errsz, \"expected ':' after JSON object key\"); return NULL; } p++; p = ds4ui_json_skip_value(p, end, depth + 1, err, errsz); if (!p) return NULL; p = ds4ui_json_ws(p, end); if (p < end && *p == ',') { p++; continue; } if (p < end && *p == '}') return p + 1; snprintf(err, errsz, \"expected ',' or '}' in JSON object\"); return NULL; }\n"
    "}\n"
    "static char *agent_tool_read(agent_worker *w, const agent_tool_call *call) {\n" },
  { "static char *agent_tool_read(agent_worker *w, const agent_tool_call *call) {\n",
    "static const char *ds4ui_json_skip_value(const char *p, const char *end, int depth, char *err, size_t errsz) {\n"
    "    if (depth > 64) { snprintf(err, errsz, \"JSON nesting too deep\"); return NULL; }\n"
    "    p = ds4ui_json_ws(p, end);\n"
    "    if (p >= end) { snprintf(err, errsz, \"expected JSON value\"); return NULL; }\n"
    "    if (*p == '\\\"') return ds4ui_json_skip_string(p, end, err, errsz);\n"
    "    if (*p == '{') return ds4ui_json_skip_object(p, end, depth, err, errsz);\n"
    "    if (*p == '[') return ds4ui_json_skip_array(p, end, depth, err, errsz);\n"
    "    if (*p == '-' || isdigit((unsigned char)*p)) return ds4ui_json_skip_number(p, end, err, errsz);\n"
    "    if (end - p >= 4 && !memcmp(p, \"true\", 4)) return p + 4;\n"
    "    if (end - p >= 5 && !memcmp(p, \"false\", 5)) return p + 5;\n"
    "    if (end - p >= 4 && !memcmp(p, \"null\", 4)) return p + 4;\n"
    "    snprintf(err, errsz, \"bad JSON value\"); return NULL;\n"
    "}\n"
    "static int ds4ui_json_validate_array(const char *json, char *err, size_t errsz) {\n"
    "    if (!json) { snprintf(err, errsz, \"missing JSON\"); return 0; }\n"
    "    const char *end = json + strlen(json);\n"
    "    const char *p = ds4ui_json_ws(json, end);\n"
    "    if (p >= end || *p != '[') { snprintf(err, errsz, \"JSON must start with '['\"); return 0; }\n"
    "    p = ds4ui_json_skip_value(p, end, 0, err, errsz);\n"
    "    if (!p) return 0;\n"
    "    p = ds4ui_json_ws(p, end);\n"
    "    if (p != end) { snprintf(err, errsz, \"trailing data after JSON value\"); return 0; }\n"
    "    return 1;\n"
    "}\n"
    "static char *ds4ui_tool_question(agent_worker *w, const agent_tool_call *call) {\n"
    "    const char *id = agent_tool_arg_value(call, \"id\");\n"
    "    const char *title = agent_tool_arg_value(call, \"title\");\n"
    "    const char *questions = agent_tool_arg_value(call, \"questions\");\n"
    "    if (!id || !id[0]) return xstrdup(\"Tool error: question requires id\\n\");\n"
    "    if (!title || !title[0]) return xstrdup(\"Tool error: question requires title\\n\");\n"
    "    if (!questions || !questions[0]) return xstrdup(\"Tool error: question requires questions\\n\");\n"
    "    char err[256];\n"
    "    if (!ds4ui_json_validate_array(questions, err, sizeof err)) { agent_buf b = {0}; agent_buf_puts(&b, \"Tool error: \"); agent_buf_puts(&b, err); agent_buf_puts(&b, \"\\n\"); return agent_buf_take(&b); }\n"
    "    ds4ui_emit_question(w, id, title, questions);\n"
    "    return xstrdup(\"Question event emitted. Stop this turn and wait for the user's answer.\\n\");\n"
    "}\n"
    "static char *agent_tool_read(agent_worker *w, const agent_tool_call *call) {\n" },
  { "    if (!strcmp(call->name, \"read\")) return agent_tool_read(w, call);\n",
    "    if (!strcmp(call->name, \"read\")) return agent_tool_read(w, call);\n"
    "    if (!strcmp(call->name, \"skill\")) return ds4ui_tool_skill(call);   /*DS4UI_JSONL*/\n"
    "    if (!strcmp(call->name, \"design_system\")) return ds4ui_tool_design_system(call);   /*DS4UI_JSONL*/\n"
    "    if (!strcmp(call->name, \"pack_file\")) return ds4ui_tool_pack_file(call);   /*DS4UI_JSONL*/\n" },
  { "    if (!strcmp(call->name, \"skill\")) return ds4ui_tool_skill(call);   /*DS4UI_JSONL*/\n",
    "    if (!strcmp(call->name, \"question\")) return ds4ui_tool_question(w, call);   /*DS4UI_JSONL*/\n"
    "    if (!strcmp(call->name, \"skill\")) return ds4ui_tool_skill(call);   /*DS4UI_JSONL*/\n" },
  { "#ifndef DS4_AGENT_TEST_NO_MAIN\n",
    "/*DS4UI_JSONL*/\n"
    "static int ds4ui_web_confirm_auto(void *privdata, const char *message, char *err, size_t err_len) {\n"
    "    (void)privdata; (void)message; if (err && err_len) err[0] = '\\0'; return 1;\n"
    "}\n"
    "static void ds4ui_web_log_stderr(void *privdata, const char *message) {\n"
    "    (void)privdata; if (message && message[0]) fprintf(stderr, \"web: %s\\n\", message);\n"
    "}\n"
    "static bool ds4ui_web_cancel_never(void *privdata) { (void)privdata; return false; }\n"
    "static void ds4ui_web_print_json(const char *tool, bool ok, const char *body_key, const char *body) {\n"
    "    char t[128]; ds4ui_json_escape(tool ? tool : \"\", t, sizeof t);\n"
    "    const char *bk = body_key ? body_key : (ok ? \"markdown\" : \"error\");\n"
    "    size_t bl = body ? strlen(body) : 0;\n"
    "    char *esc = (char *)malloc(bl * 6 + 16);\n"
    "    if (!esc) { printf(\"{\\\"ok\\\":false,\\\"tool\\\":\\\"%s\\\",\\\"error\\\":\\\"out of memory\\\"}\\n\", t); return; }\n"
    "    ds4ui_json_escape(body ? body : \"\", esc, bl * 6 + 16);\n"
    "    printf(\"{\\\"ok\\\":%s,\\\"tool\\\":\\\"%s\\\",\\\"%s\\\":\\\"%s\\\"}\\n\", ok ? \"true\" : \"false\", t, bk, esc);\n"
    "    free(esc);\n"
    "}\n"
    "static int ds4ui_run_web_tool(const agent_config *cfg) {\n"
    "    if (!cfg || !cfg->web_tool || !cfg->web_tool[0]) {\n"
    "        ds4ui_web_print_json(\"\", false, \"error\", \"--web-tool is required\"); return 2;\n"
    "    }\n"
    "    ds4_web_config web_cfg = {\n"
    "        .home_dir = getenv(\"HOME\"),\n"
    "        .port = 9333,\n"
    "        .confirm = ds4ui_web_confirm_auto,\n"
    "        .log = ds4ui_web_log_stderr,\n"
    "        .cancel = ds4ui_web_cancel_never,\n"
    "    };\n"
    "    ds4_web *web = ds4_web_create(&web_cfg);\n"
    "    char err[256] = {0};\n"
    "    char *out = NULL;\n"
    "    if (!strcmp(cfg->web_tool, \"google_search\")) {\n"
    "        if (!cfg->web_query || !cfg->web_query[0]) { ds4ui_web_print_json(cfg->web_tool, false, \"error\", \"--query is required\"); ds4_web_free(web); return 2; }\n"
    "        out = ds4_web_google_search(web, cfg->web_query, err, sizeof err);\n"
    "    } else if (!strcmp(cfg->web_tool, \"visit_page\")) {\n"
    "        if (!cfg->web_url || !cfg->web_url[0]) { ds4ui_web_print_json(cfg->web_tool, false, \"error\", \"--url is required\"); ds4_web_free(web); return 2; }\n"
    "        out = ds4_web_visit_page(web, cfg->web_url, err, sizeof err);\n"
    "    } else {\n"
    "        ds4ui_web_print_json(cfg->web_tool, false, \"error\", \"unknown web tool\"); ds4_web_free(web); return 2;\n"
    "    }\n"
    "    ds4_web_free(web);\n"
    "    if (!out) { ds4ui_web_print_json(cfg->web_tool, false, \"error\", err[0] ? err : \"web tool failed\"); return 1; }\n"
    "    ds4ui_web_print_json(cfg->web_tool, true, \"markdown\", out);\n"
    "    free(out);\n"
    "    return 0;\n"
    "}\n"
    "#ifndef DS4_AGENT_TEST_NO_MAIN\n" },
  { "int main(int argc, char **argv) {\n    agent_config cfg = parse_options(argc, argv);\n",
    "int main(int argc, char **argv) {\n    agent_config cfg = parse_options(argc, argv);\n    if (cfg.web_tool_mode) return ds4ui_run_web_tool(&cfg);   /*DS4UI_JSONL*/\n" },
  { "    ds4_engine *engine = NULL;\n",
    "    if (cfg.remote_base_url && cfg.remote_base_url[0]) return ds4ui_run_remote_agent(&cfg);   /*DS4UI_JSONL*/\n    ds4_engine *engine = NULL;\n" },
};

static const char *WEB_CDP_EDITS[][2] = {
  { "static bool web_open_tab(ds4_web *web, const char *url, web_tab *tab,\n"
    "                         char *err, size_t err_len) {\n"
    "    memset(tab, 0, sizeof(*tab));\n"
    "\n"
    "    char *browser_url = web_browser_ws_url(web, err, err_len);\n"
    "    if (!browser_url) return false;\n"
    "    cdp_ws browser = {.fd = -1, .web = web};\n"
    "    if (web_ws_connect(browser_url, &browser, err, err_len) != 0) {\n"
    "        free(browser_url);\n"
    "        return false;\n"
    "    }\n"
    "    free(browser_url);\n"
    "\n"
    "    char *qurl = web_json_quote(url);\n"
    "    web_buf params = {0};\n"
    "    web_buf_puts(&params, \"{\\\"url\\\":\");\n"
    "    web_buf_puts(&params, qurl);\n"
    "    web_buf_puts(&params, \",\\\"background\\\":true,\\\"newWindow\\\":false}\");\n"
    "    free(qurl);\n"
    "    char *params_s = web_buf_take(&params);\n"
    "    char *resp = web_cdp_call(&browser, \"Target.createTarget\",\n"
    "                              params_s, err, err_len);\n"
    "    free(params_s);\n"
    "    web_ws_close(&browser);\n"
    "    if (!resp) return false;\n"
    "\n"
    "    tab->id = web_json_get_string(resp, \"targetId\");\n"
    "    free(resp);\n"
    "    if (!tab->id) {\n"
    "        web_tab_free(tab);\n"
    "        web_set_err(err, err_len, \"Chrome did not return a page target id\");\n"
    "        return false;\n"
    "    }\n"
    "\n"
    "    char ws_url[PATH_MAX + 128];\n"
    "    snprintf(ws_url, sizeof(ws_url), \"ws://127.0.0.1:%d/devtools/page/%s\",\n"
    "             web->port, tab->id);\n"
    "    tab->ws_url = web_xstrdup(ws_url);\n"
    "    return true;\n"
    "}\n",
    WEB_CDP_MARK "\n"
    "static bool ds4ui_web_json_get_int(const char *json, const char *key, int *out) {\n"
    "    char pat[128];\n"
    "    snprintf(pat, sizeof(pat), \"\\\"%s\\\"\", key);\n"
    "    const char *p = json;\n"
    "    while ((p = strstr(p, pat)) != NULL) {\n"
    "        p += strlen(pat);\n"
    "        while (*p == ' ' || *p == '\\t' || *p == '\\r' || *p == '\\n') p++;\n"
    "        if (*p++ != ':') continue;\n"
    "        while (*p == ' ' || *p == '\\t' || *p == '\\r' || *p == '\\n') p++;\n"
    "        char *end = NULL;\n"
    "        long v = strtol(p, &end, 10);\n"
    "        if (end != p) {\n"
    "            if (out) *out = (int)v;\n"
    "            return true;\n"
    "        }\n"
    "    }\n"
    "    return false;\n"
    "}\n"
    "\n"
    "static void ds4ui_web_json_excerpt(const char *json, char *out, size_t out_len) {\n"
    "    if (!out || out_len == 0) return;\n"
    "    out[0] = '\\0';\n"
    "    if (!json) return;\n"
    "    size_t j = 0;\n"
    "    bool space = false;\n"
    "    for (const char *p = json; *p && j + 1 < out_len; p++) {\n"
    "        unsigned char c = (unsigned char)*p;\n"
    "        if (c == '\\r' || c == '\\n' || c == '\\t' || c == ' ') {\n"
    "            if (space) continue;\n"
    "            c = ' ';\n"
    "            space = true;\n"
    "        } else {\n"
    "            space = false;\n"
    "        }\n"
    "        out[j++] = (char)c;\n"
    "    }\n"
    "    out[j] = '\\0';\n"
    "}\n"
    "\n"
    "static void ds4ui_web_cdp_response_error(const char *resp, char *out, size_t out_len) {\n"
    "    if (!out || out_len == 0) return;\n"
    "    char *msg = web_json_get_string(resp, \"message\");\n"
    "    int code = 0;\n"
    "    bool has_code = ds4ui_web_json_get_int(resp, \"code\", &code);\n"
    "    if (msg && msg[0] && has_code) {\n"
    "        web_set_err(out, out_len, \"CDP error %d: %s\", code, msg);\n"
    "    } else if (msg && msg[0]) {\n"
    "        web_set_err(out, out_len, \"CDP error: %s\", msg);\n"
    "    } else {\n"
    "        char excerpt[240];\n"
    "        ds4ui_web_json_excerpt(resp, excerpt, sizeof(excerpt));\n"
    "        web_set_err(out, out_len, \"CDP response missing targetId: %s\",\n"
    "                    excerpt[0] ? excerpt : \"empty response\");\n"
    "    }\n"
    "    free(msg);\n"
    "}\n"
    "\n"
    "static void ds4ui_web_tab_set_ws_from_id(ds4_web *web, web_tab *tab) {\n"
    "    char ws_url[PATH_MAX + 128];\n"
    "    snprintf(ws_url, sizeof(ws_url), \"ws://127.0.0.1:%d/devtools/page/%s\",\n"
    "             web->port, tab->id);\n"
    "    tab->ws_url = web_xstrdup(ws_url);\n"
    "}\n"
    "\n"
    "static bool ds4ui_web_open_tab_cdp_once(ds4_web *web, const char *url, web_tab *tab,\n"
    "                                       char *detail, size_t detail_len) {\n"
    "    char local_err[256] = {0};\n"
    "\n"
    "    memset(tab, 0, sizeof(*tab));\n"
    "    if (web_set_cancel_err(web, detail, detail_len)) return false;\n"
    "\n"
    "    char *browser_url = web_browser_ws_url(web, local_err, sizeof(local_err));\n"
    "    if (!browser_url) {\n"
    "        web_set_err(detail, detail_len, \"%s\",\n"
    "                    local_err[0] ? local_err : \"Chrome did not return a browser WebSocket URL\");\n"
    "        return false;\n"
    "    }\n"
    "    cdp_ws browser = {.fd = -1, .web = web};\n"
    "    if (web_ws_connect(browser_url, &browser, local_err, sizeof(local_err)) != 0) {\n"
    "        free(browser_url);\n"
    "        web_set_err(detail, detail_len, \"%s\",\n"
    "                    local_err[0] ? local_err : \"could not connect to Chrome browser WebSocket\");\n"
    "        return false;\n"
    "    }\n"
    "    free(browser_url);\n"
    "\n"
    "    char *qurl = web_json_quote(url);\n"
    "    web_buf params = {0};\n"
    "    web_buf_puts(&params, \"{\\\"url\\\":\");\n"
    "    web_buf_puts(&params, qurl);\n"
    "    web_buf_puts(&params, \",\\\"background\\\":true,\\\"newWindow\\\":false}\");\n"
    "    free(qurl);\n"
    "    char *params_s = web_buf_take(&params);\n"
    "    char *resp = web_cdp_call(&browser, \"Target.createTarget\",\n"
    "                              params_s, local_err, sizeof(local_err));\n"
    "    free(params_s);\n"
    "    web_ws_close(&browser);\n"
    "    if (!resp) {\n"
    "        web_set_err(detail, detail_len, \"%s\",\n"
    "                    local_err[0] ? local_err : \"Target.createTarget returned no response\");\n"
    "        return false;\n"
    "    }\n"
    "\n"
    "    tab->id = web_json_get_string(resp, \"targetId\");\n"
    "    if (!tab->id) {\n"
    "        ds4ui_web_cdp_response_error(resp, detail, detail_len);\n"
    "        free(resp);\n"
    "        web_tab_free(tab);\n"
    "        return false;\n"
    "    }\n"
    "    free(resp);\n"
    "\n"
    "    ds4ui_web_tab_set_ws_from_id(web, tab);\n"
    "    return true;\n"
    "}\n"
    "\n"
    "static bool ds4ui_web_open_tab_http_fallback(ds4_web *web, const char *url, web_tab *tab,\n"
    "                                            char *detail, size_t detail_len) {\n"
    "    char local_err[256] = {0};\n"
    "\n"
    "    memset(tab, 0, sizeof(*tab));\n"
    "    if (web_set_cancel_err(web, detail, detail_len)) return false;\n"
    "\n"
    "    char *enc = web_url_encode(url);\n"
    "    web_buf path = {0};\n"
    "    web_buf_puts(&path, \"/json/new?\");\n"
    "    web_buf_puts(&path, enc);\n"
    "    free(enc);\n"
    "\n"
    "    char *path_s = web_buf_take(&path);\n"
    "    char *body = web_http_request(\"PUT\", web->port, path_s, local_err, sizeof(local_err));\n"
    "    free(path_s);\n"
    "    if (!body) {\n"
    "        web_set_err(detail, detail_len, \"%s\",\n"
    "                    local_err[0] ? local_err : \"/json/new returned no response\");\n"
    "        return false;\n"
    "    }\n"
    "\n"
    "    tab->id = web_json_get_string(body, \"id\");\n"
    "    tab->ws_url = web_json_get_string(body, \"webSocketDebuggerUrl\");\n"
    "    if (!tab->id) {\n"
    "        ds4ui_web_cdp_response_error(body, detail, detail_len);\n"
    "        free(body);\n"
    "        web_tab_free(tab);\n"
    "        return false;\n"
    "    }\n"
    "    if (!tab->ws_url || !tab->ws_url[0]) {\n"
    "        free(tab->ws_url);\n"
    "        tab->ws_url = NULL;\n"
    "        ds4ui_web_tab_set_ws_from_id(web, tab);\n"
    "    }\n"
    "    free(body);\n"
    "    return true;\n"
    "}\n"
    "\n"
    "static bool web_open_tab(ds4_web *web, const char *url, web_tab *tab,\n"
    "                         char *err, size_t err_len) {\n"
    "    char last_cdp[512] = {0};\n"
    "    char fallback_err[512] = {0};\n"
    "    static const int backoff_ms[] = {150, 300};\n"
    "\n"
    "    memset(tab, 0, sizeof(*tab));\n"
    "    for (int attempt = 0; attempt < 3; attempt++) {\n"
    "        char detail[512] = {0};\n"
    "        if (ds4ui_web_open_tab_cdp_once(web, url, tab, detail, sizeof(detail)))\n"
    "            return true;\n"
    "        web_set_err(last_cdp, sizeof(last_cdp), \"%s\",\n"
    "                    detail[0] ? detail : \"Target.createTarget failed\");\n"
    "        if (web_err_is_interrupted(last_cdp)) {\n"
    "            web_set_err(err, err_len, \"%s\", last_cdp);\n"
    "            return false;\n"
    "        }\n"
    "        if (attempt < 2 && !web_sleep_ms(web, backoff_ms[attempt])) {\n"
    "            web_set_err(err, err_len, \"interrupted\");\n"
    "            return false;\n"
    "        }\n"
    "    }\n"
    "\n"
    "    if (ds4ui_web_open_tab_http_fallback(web, url, tab, fallback_err, sizeof(fallback_err)))\n"
    "        return true;\n"
    "    if (web_err_is_interrupted(fallback_err)) {\n"
    "        web_set_err(err, err_len, \"%s\", fallback_err);\n"
    "        return false;\n"
    "    }\n"
    "\n"
    "    web_set_err(err, err_len,\n"
    "                \"Chrome could not create a page target: %s; fallback /json/new failed: %s\",\n"
    "                last_cdp[0] ? last_cdp : \"Target.createTarget failed\",\n"
    "                fallback_err[0] ? fallback_err : \"unknown error\");\n"
    "    return false;\n"
    "}\n" },
};

static const char *WEB_DIRECT_NAV_EDITS[][2] = {
  { "    web_tab tab = {0};\n"
    "    if (!web_open_tab(web, \"about:blank\", &tab, err, err_len)) return NULL;\n",
    WEB_DIRECT_NAV_MARK "\n"
    "    web_tab tab = {0};\n"
    "    if (!web_open_tab(web, url, &tab, err, err_len)) return NULL;\n" },
  { "    if (!web_cdp_navigate(&ws, url, err, err_len) ||\n"
    "        !web_wait_navigated_ready(&ws, url, err, err_len))\n"
    "    {\n"
    "        web_ws_close(&ws);\n"
    "        web_close_tab(web, &tab);\n"
    "        web_tab_free(&tab);\n"
    "        return NULL;\n"
    "    }\n",
    "    if (!web_wait_navigated_ready(&ws, url, err, err_len))\n"
    "    {\n"
    "        web_ws_close(&ws);\n"
    "        web_close_tab(web, &tab);\n"
    "        web_tab_free(&tab);\n"
    "        return NULL;\n"
    "    }\n" },
  { "static bool web_cdp_navigate(cdp_ws *ws, const char *url,\n",
    "static bool __attribute__((unused)) web_cdp_navigate(cdp_ws *ws, const char *url,\n" },
};

/* Inline Makefile for `make -f -`: includes the ds4 Makefile (reuses
 * CFLAGS/CORE_OBJS/METAL_LDLIBS) and compiles only the patched agent under a
 * separate name. The recipe lines MUST start with a TAB. */
static const char *JSONL_MAKEFILE =
    "include Makefile\n"
    "JSONL_CFLAGS ?= $(CFLAGS)\n"
    "JSONL_CORE_OBJS ?= $(CORE_OBJS)\n"
    "JSONL_LDLIBS ?= $(METAL_LDLIBS)\n"
    "DSTUDIO_REMOTE_DIR ?= ../DStudio/extension/remote\n"
    "ds4_agent_jsonl.o: ds4_agent.c\n"
    "\t$(CC) $(JSONL_CFLAGS) -I$(DSTUDIO_REMOTE_DIR) -c -o $@ ds4_agent.c\n"
    "ds4_web_ds4ui.o: ds4_web_ds4ui.c\n"
    "\t$(CC) $(JSONL_CFLAGS) -c -o $@ ds4_web_ds4ui.c\n"
    "dstudio_remote_llm.o: $(DSTUDIO_REMOTE_DIR)/dstudio_remote_llm.c $(DSTUDIO_REMOTE_DIR)/dstudio_remote_llm.h\n"
    "\t$(CC) $(JSONL_CFLAGS) -I$(DSTUDIO_REMOTE_DIR) -c -o $@ $(DSTUDIO_REMOTE_DIR)/dstudio_remote_llm.c\n"
    "ds4-agent-jsonl: ds4_agent_jsonl.o dstudio_remote_llm.o ds4_help.o ds4_web_ds4ui.o ds4_kvstore.o linenoise.o $(JSONL_CORE_OBJS)\n"
    "\t$(CC) $(JSONL_CFLAGS) -o $@ ds4_agent_jsonl.o dstudio_remote_llm.o ds4_help.o ds4_web_ds4ui.o ds4_kvstore.o linenoise.o $(JSONL_CORE_OBJS) $(JSONL_LDLIBS)\n";

static char *jsonl_read_file(const char *path, size_t *len) {
    FILE *f = fopen(path, "rb");
    if (!f) return NULL;
    if (fseek(f, 0, SEEK_END) != 0) { fclose(f); return NULL; }
    long sz = ftell(f);
    if (sz < 0) { fclose(f); return NULL; }
    rewind(f);
    char *b = malloc((size_t)sz + 1);
    if (!b) { fclose(f); return NULL; }
    if (fread(b, 1, (size_t)sz, f) != (size_t)sz) { free(b); fclose(f); return NULL; }
    fclose(f);
    b[sz] = '\0';
    if (len) *len = (size_t)sz;
    return b;
}

static int jsonl_write_file(const char *path, const char *data, size_t len) {
    FILE *f = fopen(path, "wb");
    if (!f) return 0;
    int ok = fwrite(data, 1, len, f) == len;
    fclose(f);
    return ok;
}

static int jsonl_insert_remote_agent_fragment(char **buf, size_t *n);

static void jsonl_normalize_newlines(char *b, size_t *len) {
    size_t r = 0, w = 0, n = len ? *len : strlen(b);
    while (r < n) {
        if (b[r] == '\r') {
            if (r + 1 < n && b[r + 1] == '\n') r++;
            b[w++] = '\n';
            r++;
        } else {
            b[w++] = b[r++];
        }
    }
    b[w] = '\0';
    if (len) *len = w;
}

/* Skill id sanitiser: only [a-z0-9-], so it can never escape extension/skills/. */
static int skill_id_ok(const char *s) {
    if (!s || !s[0]) return 0;
    for (const char *p = s; *p; p++) {
        char c = *p;
        if (!((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-')) return 0;
    }
    return 1;
}

static void fm_field(const char *content, const char *key, char *out, size_t outsz);  /* fwd */

/* Append "label:\n- id: description\n…" for every pack directly under <dir> (each a
 * <dir>/<id>/<file>) to a bounded buffer, for the on-demand catalog. */
static void catalog_append(char *out, size_t cap, size_t *o, const char *dir,
                           const char *file, const char *label) {
    DIR *d = opendir(dir);
    if (!d) return;
    int any = 0;
    struct dirent *de;
    while ((de = readdir(d)) != NULL && *o < cap - 256) {
        const char *id = de->d_name;
        if (id[0] == '.' || !skill_id_ok(id)) continue;
        char md[2300];
        snprintf(md, sizeof md, "%s/%s/%s", dir, id, file);
        size_t len = 0;
        char *content = jsonl_read_file(md, &len);
        if (!content) continue;
        char desc[320], cat[120], local_mode[80], output[160], provider[120];
        fm_field(content, "description", desc, sizeof desc);
        fm_field(content, "ds4_category", cat, sizeof cat);
        fm_field(content, "ds4_local_mode", local_mode, sizeof local_mode);
        fm_field(content, "ds4_output_kinds", output, sizeof output);
        fm_field(content, "ds4_provider", provider, sizeof provider);
        free(content);
        char assets[2300], refs[2300], example[2300];
        snprintf(assets, sizeof assets, "%s/%s/assets", dir, id);
        snprintf(refs, sizeof refs, "%s/%s/references", dir, id);
        snprintf(example, sizeof example, "%s/%s/example.html", dir, id);
        int has_assets = access(assets, R_OK) == 0;
        int has_refs = access(refs, R_OK) == 0;
        int has_example = access(example, R_OK) == 0;
        if (!any) { *o += (size_t)snprintf(out + *o, cap - *o, "%s:\n", label); any = 1; }
        *o += (size_t)snprintf(out + *o, cap - *o, "- %s: %s", id, desc);
        if (cat[0] || local_mode[0] || output[0] || provider[0] ||
            has_assets || has_refs || has_example)
        {
            *o += (size_t)snprintf(out + *o, cap - *o, " [");
            int first = 1;
            if (cat[0]) { *o += (size_t)snprintf(out + *o, cap - *o, "cat=%s", cat); first = 0; }
            if (local_mode[0]) { *o += (size_t)snprintf(out + *o, cap - *o, "%smode=%s", first ? "" : "; ", local_mode); first = 0; }
            if (output[0]) { *o += (size_t)snprintf(out + *o, cap - *o, "%sout=%s", first ? "" : "; ", output); first = 0; }
            if (provider[0]) { *o += (size_t)snprintf(out + *o, cap - *o, "%sprovider=%s", first ? "" : "; ", provider); first = 0; }
            if (has_assets || has_refs || has_example) {
                *o += (size_t)snprintf(out + *o, cap - *o, "%sfiles=", first ? "" : "; ");
                if (has_assets) *o += (size_t)snprintf(out + *o, cap - *o, "assets");
                if (has_refs) *o += (size_t)snprintf(out + *o, cap - *o, "%sreferences", has_assets ? "," : "");
                if (has_example) *o += (size_t)snprintf(out + *o, cap - *o, "%sexample", (has_assets || has_refs) ? "," : "");
            }
            *o += (size_t)snprintf(out + *o, cap - *o, "]");
        }
        *o += (size_t)snprintf(out + *o, cap - *o, "\n");
    }
    closedir(d);
    if (any) *o += (size_t)snprintf(out + *o, cap - *o, "\n");
}

/* Read the body of the active skill, preferring a USER skill (<userdir>/<id>/SKILL.md)
 * over a shipped one (<web>/extension/skills/<id>/SKILL.md). Caller frees. */
static char *read_selected_skill(size_t *len) {
    char path[2300], udir[1100];
    user_skills_dir(udir, sizeof udir);
    snprintf(path, sizeof path, "%s/%s/SKILL.md", udir, g_skill);
    char *c = jsonl_read_file(path, len);
    if (c) return c;
    snprintf(path, sizeof path, "%s/extension/skills/%s/SKILL.md", g_web_dir, g_skill);
    return jsonl_read_file(path, len);
}

/* Append a file's bytes to a growing buffer with a blank-line separator. Frees src. */
static void sys_append(char **buf, size_t *len, size_t *cap, char *src, size_t slen) {
    if (!src) return;
    size_t need = *len + slen + 4;
    if (need > *cap) {
        size_t nc = need + 1024;
        char *nb = realloc(*buf, nc);
        if (!nb) { free(src); return; }
        *buf = nb; *cap = nc;
    }
    if (*len) { (*buf)[(*len)++] = '\n'; (*buf)[(*len)++] = '\n'; }
    memcpy(*buf + *len, src, slen); *len += slen;
    (*buf)[*len] = '\0';
    free(src);
}

/* Build the -sys text injected into the agent and design engines: the shared charter
 * (extension/skills/AGENT.md), the active design-system's DESIGN.md (design only), and
 * the active skill's SKILL.md. Order: charter -> brand -> task, so the skill checklist
 * stays freshest. Returns a malloc'd string the caller frees, or NULL when there is
 * nothing to inject. The packs live in this DStudio checkout (g_web_dir), read here —
 * NOT through an engine tool — so the agents need no change and no access outside their
 * workspace. include_design_system gates the brand layer to design mode. */
static char *build_skill_sys(int include_design_system, int include_agent_question) {
    if (!g_web_dir[0]) return NULL;
    char path[2300];
    char *buf = NULL; size_t len = 0, cap = 0;

    size_t n = 0;
    snprintf(path, sizeof path, "%s/extension/skills/AGENT.md", g_web_dir);
    sys_append(&buf, &len, &cap, jsonl_read_file(path, &n), n);

    if (include_design_system && g_design_system[0]) {
        snprintf(path, sizeof path, "%s/extension/design-systems/%s/DESIGN.md", g_web_dir, g_design_system);
        n = 0;
        sys_append(&buf, &len, &cap, jsonl_read_file(path, &n), n);
    }
    if (g_skill[0]) {
        n = 0;
        sys_append(&buf, &len, &cap, read_selected_skill(&n), n);  /* user pref over shipped */
    }

    /* On-demand catalog: the packs the model can pull at any time via the skill() /
     * design_system() tools, plus the tool schemas (the agent's native prompt lacks
     * them; design also has them natively). The user's selected packs above are already
     * loaded — this lets the model reach the OTHERS without a restart. */
    const size_t catcap = 256 * 1024;
    char *cat = malloc(catcap);
    if (cat) {
        size_t o = 0;
        char dir[2048], udir[1100];
        o += (size_t)snprintf(cat + o, catcap - o,
            "## On-demand packs\n\n"
            "Load any pack below at any time WITHOUT restarting, by calling these tools "
            "(DSML, exactly like your other tools):\n\n"
            "{\"type\":\"function\",\"function\":{\"name\":\"skill\",\"description\":\"Load a skill recipe (layout patterns + checklist) by id, then follow its checklist.\",\"parameters\":{\"type\":\"object\",\"properties\":{\"name\":{\"type\":\"string\"}},\"required\":[\"name\"]}}}\n"
            "{\"type\":\"function\",\"function\":{\"name\":\"design_system\",\"description\":\"Load a brand pack (color tokens, type, components, voice) by id, then bind its tokens.\",\"parameters\":{\"type\":\"object\",\"properties\":{\"name\":{\"type\":\"string\"}},\"required\":[\"name\"]}}}\n"
            "{\"type\":\"function\",\"function\":{\"name\":\"pack_file\",\"description\":\"Read an allowlisted pack file such as assets/template.html, references/checklist.md, references/layouts.md, or example.html after a pack lists available files.\",\"parameters\":{\"type\":\"object\",\"properties\":{\"type\":{\"type\":\"string\"},\"name\":{\"type\":\"string\"},\"path\":{\"type\":\"string\"}},\"required\":[\"type\",\"name\",\"path\"]}}}\n");
        if (!include_design_system && include_agent_question)
            o += (size_t)snprintf(cat + o, catcap - o,
                "{\"type\":\"function\",\"function\":{\"name\":\"question\",\"description\":\"Emit a structured question event for the UI. Use when you need the user to choose or clarify, then stop the turn.\",\"parameters\":{\"type\":\"object\",\"properties\":{\"id\":{\"type\":\"string\"},\"title\":{\"type\":\"string\"},\"questions\":{\"type\":\"string\",\"description\":\"JSON array of question objects, e.g. [{id,label,type,options}].\"}},\"required\":[\"id\",\"title\",\"questions\"]}}}\n");
        if (include_design_system)
            o += (size_t)snprintf(cat + o, catcap - o,
                "{\"type\":\"function\",\"function\":{\"name\":\"craft\",\"description\":\"Load a universal craft rules pack by id (accessibility before shipping; layout-responsive before any resize).\",\"parameters\":{\"type\":\"object\",\"properties\":{\"name\":{\"type\":\"string\"}},\"required\":[\"name\"]}}}\n");
        o += (size_t)snprintf(cat + o, catcap - o, "\n");
        user_skills_dir(udir, sizeof udir);
        catalog_append(cat, catcap, &o, udir, "SKILL.md", "Your skills");
        snprintf(dir, sizeof dir, "%s/extension/skills", g_web_dir);
        catalog_append(cat, catcap, &o, dir, "SKILL.md", "Design skills");
        if (include_design_system) {
            snprintf(dir, sizeof dir, "%s/extension/design-systems", g_web_dir);
            catalog_append(cat, catcap, &o, dir, "DESIGN.md", "Available design systems");
            snprintf(dir, sizeof dir, "%s/extension/craft", g_web_dir);
            catalog_append(cat, catcap, &o, dir, "CRAFT.md", "Craft rules (universal)");
        }
        if (g_skill[0] || (include_design_system && g_design_system[0]))
            o += (size_t)snprintf(cat + o, catcap - o,
                "The pack(s) the user selected are already loaded above; use the tools to pull others.\n");
        sys_append(&buf, &len, &cap, cat, o);  /* frees cat */
    }
    return buf;  /* NULL if nothing was appended */
}

/* copies src->dst preserving the mtime (idempotency relies on the timestamps). */
static int jsonl_copy_preserve(const char *src, const char *dst) {
    size_t n;
    char *b = jsonl_read_file(src, &n);
    if (!b) return 0;
    int ok = jsonl_write_file(dst, b, n);
    free(b);
    if (!ok) return 0;
    struct stat st;
    if (stat(src, &st) == 0) {
#ifdef _WIN32
        HANDLE h = CreateFileA(dst, FILE_WRITE_ATTRIBUTES,
                               FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                               NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
        if (h != INVALID_HANDLE_VALUE) {
            ULONGLONG ticks = ((ULONGLONG)st.st_mtime + 11644473600ULL) * 10000000ULL;
            FILETIME ft;
            ft.dwLowDateTime = (DWORD)ticks;
            ft.dwHighDateTime = (DWORD)(ticks >> 32);
            SetFileTime(h, NULL, &ft, &ft);
            CloseHandle(h);
        }
#else
        struct timeval tv[2] = { { st.st_mtime, 0 }, { st.st_mtime, 0 } };
        utimes(dst, tv);
#endif
    }
    return 1;
}

/* replaces the single occurrence of find (realloc). 0 if it is not exactly one. */
static int jsonl_replace_once(char **buf, size_t *len, const char *find, const char *repl) {
    char *p = strstr(*buf, find);
    if (!p || strstr(p + 1, find)) return 0;
    size_t fl = strlen(find), rl = strlen(repl), off = (size_t)(p - *buf);
    size_t newlen = *len - fl + rl;
    char *nb = malloc(newlen + 1);
    if (!nb) return 0;
    memcpy(nb, *buf, off);
    memcpy(nb + off, repl, rl);
    memcpy(nb + off + rl, p + fl, *len - off - fl);
    nb[newlen] = '\0';
    free(*buf);
    *buf = nb; *len = newlen;
    return 1;
}

/* applies the anchored edits of JSONL_EDITS; 0 on missing/ambiguous anchor. */
static int jsonl_apply(const char *src_path) {
    size_t n;
    char *buf = jsonl_read_file(src_path, &n);
    if (!buf) return 0;
    jsonl_normalize_newlines(buf, &n);
    if (strstr(buf, JSONL_MARK)) { free(buf); return 0; }  /* already patched */
    int nedits = (int)(sizeof JSONL_EDITS / sizeof JSONL_EDITS[0]);
    for (int i = 0; i < nedits; i++) {
        if (!jsonl_replace_once(&buf, &n, JSONL_EDITS[i][0], JSONL_EDITS[i][1])) {
            free(buf);
            return 0;
        }
    }
    if (!jsonl_insert_remote_agent_fragment(&buf, &n)) {
        free(buf);
        return 0;
    }
    int ok = jsonl_write_file(src_path, buf, n);
    free(buf);
    return ok;
}

static int web_cdp_source_has_fix(const char *buf) {
    return buf &&
           strstr(buf, "web_open_tab_http_fallback") &&
           strstr(buf, "Chrome could not create a page target");
}

static int web_direct_nav_source_has_fix(const char *buf) {
    return buf &&
           strstr(buf, "web_open_tab(web, url, &tab, err, err_len)") &&
           !strstr(buf, "web_open_tab(web, \"about:blank\", &tab, err, err_len)") &&
           !strstr(buf, "web_cdp_navigate(&ws, url, err, err_len)");
}

static int web_cdp_apply(char **buf, size_t *n) {
    if (strstr(*buf, WEB_CDP_MARK) || web_cdp_source_has_fix(*buf))
        return 1;  /* already patched or integrated upstream */
    int nedits = (int)(sizeof WEB_CDP_EDITS / sizeof WEB_CDP_EDITS[0]);
    for (int i = 0; i < nedits; i++) {
        if (!jsonl_replace_once(buf, n, WEB_CDP_EDITS[i][0], WEB_CDP_EDITS[i][1]))
            return 0;
    }
    return 1;
}

static int web_direct_nav_apply(char **buf, size_t *n) {
    if (strstr(*buf, WEB_DIRECT_NAV_MARK) || web_direct_nav_source_has_fix(*buf))
        return 1;
    int nedits = (int)(sizeof WEB_DIRECT_NAV_EDITS / sizeof WEB_DIRECT_NAV_EDITS[0]);
    for (int i = 0; i < nedits; i++) {
        if (!jsonl_replace_once(buf, n, WEB_DIRECT_NAV_EDITS[i][0], WEB_DIRECT_NAV_EDITS[i][1]))
            return 0;
    }
    return 1;
}

static int web_cdp_write_temp(const char *src_path, const char *tmp_path) {
    size_t n;
    char *buf = jsonl_read_file(src_path, &n);
    if (!buf) return 0;
    jsonl_normalize_newlines(buf, &n);
    int ok = web_cdp_apply(&buf, &n) &&
             web_direct_nav_apply(&buf, &n) &&
             jsonl_write_file(tmp_path, buf, n);
    free(buf);
    return ok;
}

static void jsonl_unlink_if_exists(const char *path) {
    if (path && path[0]) unlink(path);
}

static char *jsonl_read_remote_agent_fragment(size_t *len) {
    char path[DSTUDIO_PATH_MAX + 256];
    if (g_web_dir[0]) {
        snprintf(path, sizeof path, "%s/%s", g_web_dir, JSONL_REMOTE_AGENT_FRAGMENT);
        char *body = jsonl_read_file(path, len);
        if (body) return body;
    }
    return jsonl_read_file(JSONL_REMOTE_AGENT_FRAGMENT, len);
}

static int jsonl_insert_remote_agent_fragment(char **buf, size_t *n) {
    static const char anchor[] =
        "static int run_agent_non_interactive(ds4_engine *engine, agent_config *cfg) {\n";
    if (strstr(*buf, "/*DS4UI_REMOTE_AGENT*/")) return 0;
    size_t frag_len = 0;
    char *frag = jsonl_read_remote_agent_fragment(&frag_len);
    if (!frag) return 0;
    jsonl_normalize_newlines(frag, &frag_len);
    size_t repl_len = frag_len + strlen(anchor) + 2;
    char *repl = malloc(repl_len);
    if (!repl) { free(frag); return 0; }
    int k = snprintf(repl, repl_len, "%s\n%s", frag, anchor);
    free(frag);
    if (k < 0 || (size_t)k >= repl_len) { free(repl); return 0; }
    int ok = jsonl_replace_once(buf, n, anchor, repl);
    free(repl);
    return ok;
}

static int web_cdp_check_anchors(const char *src_path) {
    size_t n;
    char *buf = jsonl_read_file(src_path, &n);
    if (!buf) { printf("check-anchors: cannot read %s\n", src_path); return -1; }
    jsonl_normalize_newlines(buf, &n);
    int fails = 0;
    if (web_cdp_source_has_fix(buf)) {
        printf("check-anchors: web CDP fix already present upstream\n");
    } else if (strstr(buf, WEB_CDP_MARK)) {
        printf("check-anchors: NOTE source already contains %s (already patched?)\n", WEB_CDP_MARK);
    } else {
        int nedits = (int)(sizeof WEB_CDP_EDITS / sizeof WEB_CDP_EDITS[0]);
        for (int i = 0; i < nedits; i++) {
            const char *find = WEB_CDP_EDITS[i][0];
            const char *repl = WEB_CDP_EDITS[i][1];
            int cnt = 0;
            for (char *q = strstr(buf, find); q; q = strstr(q + 1, find)) cnt++;
            const char *verdict = cnt == 1 ? "ok" : (cnt == 0 ? "MISSING" : "AMBIGUOUS");
            if (cnt != 1) fails++;
            char preview[56]; size_t k = 0;
            for (const char *s = find; *s && *s != '\n' && k + 1 < sizeof preview; s++) preview[k++] = *s;
            preview[k] = '\0';
            printf("  web anchor %2d/%d  %-9s  %s%s\n", i + 1, nedits, verdict, preview,
                   k < strlen(find) ? " ..." : "");
            if (cnt == 1 && !jsonl_replace_once(&buf, &n, find, repl)) fails++;
        }
    }

    if (strstr(buf, WEB_DIRECT_NAV_MARK) || web_direct_nav_source_has_fix(buf)) {
        printf("check-anchors: web direct navigation already present\n");
    } else {
        int nedits = (int)(sizeof WEB_DIRECT_NAV_EDITS / sizeof WEB_DIRECT_NAV_EDITS[0]);
        for (int i = 0; i < nedits; i++) {
            const char *find = WEB_DIRECT_NAV_EDITS[i][0];
            const char *repl = WEB_DIRECT_NAV_EDITS[i][1];
            int cnt = 0;
            for (char *q = strstr(buf, find); q; q = strstr(q + 1, find)) cnt++;
            const char *verdict = cnt == 1 ? "ok" : (cnt == 0 ? "MISSING" : "AMBIGUOUS");
            if (cnt != 1) fails++;
            char preview[56]; size_t k = 0;
            for (const char *s = find; *s && *s != '\n' && k + 1 < sizeof preview; s++) preview[k++] = *s;
            preview[k] = '\0';
            printf("  web nav anchor %2d/%d  %-9s  %s%s\n", i + 1, nedits, verdict, preview,
                   k < strlen(find) ? " ..." : "");
            if (cnt == 1 && !jsonl_replace_once(&buf, &n, find, repl)) fails++;
        }
    }
    free(buf);
    printf("check-anchors: web direct navigation %s\n", fails ? "would fail" : "ok");
    return fails;
}

/* Dry-run for CI: verify every JSONL_EDITS anchor is present exactly once in
 * src_path WITHOUT modifying it. Prints a per-anchor report; returns the number
 * of anchors that would fail to apply (0 = the patch applies cleanly). Catches an
 * upstream ds4_agent.c rework before it silently drops users to Raw. */
static int jsonl_check_anchors(const char *src_path) {
    size_t n;
    char *buf = jsonl_read_file(src_path, &n);
    if (!buf) { printf("check-anchors: cannot read %s\n", src_path); return -1; }
    jsonl_normalize_newlines(buf, &n);
    if (strstr(buf, JSONL_MARK))
        printf("check-anchors: NOTE source already contains %s (already patched?)\n", JSONL_MARK);
    int nedits = (int)(sizeof JSONL_EDITS / sizeof JSONL_EDITS[0]);
    int fails = 0;
    for (int i = 0; i < nedits; i++) {
        const char *find = JSONL_EDITS[i][0];
        const char *repl = JSONL_EDITS[i][1];
        int cnt = 0;
        for (char *q = strstr(buf, find); q; q = strstr(q + 1, find)) cnt++;
        const char *verdict = cnt == 1 ? "ok" : (cnt == 0 ? "MISSING" : "AMBIGUOUS");
        if (cnt != 1) fails++;
        char preview[56]; size_t k = 0;
        for (const char *s = find; *s && *s != '\n' && k + 1 < sizeof preview; s++) preview[k++] = *s;
        preview[k] = '\0';
        printf("  anchor %2d/%d  %-9s  %s%s\n", i + 1, nedits, verdict, preview,
               k < strlen(find) ? " …" : "");
        if (cnt == 1 && !jsonl_replace_once(&buf, &n, find, repl)) fails++;
    }
    if (jsonl_insert_remote_agent_fragment(&buf, &n)) {
        printf("  remote fragment     ok         %s\n", JSONL_REMOTE_AGENT_FRAGMENT);
    } else {
        printf("  remote fragment     MISSING    %s or run_agent_non_interactive anchor\n",
               JSONL_REMOTE_AGENT_FRAGMENT);
        fails++;
    }
    free(buf);
    printf("check-anchors: %d/%d ok, %d would fail\n",
           (nedits + 1) - fails, nedits + 1, fails);
    return fails;
}

/* `make -f - <target>` in the ds4 dir, with the inline makefile on stdin. */
static int jsonl_make(const char *ds4_abs, const char *target) {
#ifdef _WIN32
    (void)ds4_abs; (void)target;
    return 0;
#else
    int pp[2];
    if (pipe(pp) != 0) return 0;
    pid_t pid = fork();
    if (pid < 0) { close(pp[0]); close(pp[1]); return 0; }
    if (pid == 0) {
        if (chdir(ds4_abs) != 0) _exit(127);
        dup2(pp[0], STDIN_FILENO);
        close(pp[0]); close(pp[1]);
        char core_arg[4096], libs_arg[4096], cflags_arg[4096], cc_arg[4096], remote_arg[4096];
        char *argv[12];
        int ai = 0;
        argv[ai++] = "make";
        argv[ai++] = "-f";
        argv[ai++] = "-";
        argv[ai++] = (char *)target;
        const char *cc = getenv("DS4UI_JSONL_CC");
        const char *cf = getenv("DS4UI_JSONL_CFLAGS");
        const char *co = getenv("DS4UI_JSONL_CORE_OBJS");
        const char *ll = getenv("DS4UI_JSONL_LDLIBS");
        if (cc && cc[0]) { snprintf(cc_arg, sizeof cc_arg, "CC=%s", cc); argv[ai++] = cc_arg; }
        if (cf && cf[0]) { snprintf(cflags_arg, sizeof cflags_arg, "JSONL_CFLAGS=%s", cf); argv[ai++] = cflags_arg; }
        if (co && co[0]) { snprintf(core_arg, sizeof core_arg, "JSONL_CORE_OBJS=%s", co); argv[ai++] = core_arg; }
        if (ll && ll[0]) { snprintf(libs_arg, sizeof libs_arg, "JSONL_LDLIBS=%s", ll); argv[ai++] = libs_arg; }
        if (g_web_dir[0]) { snprintf(remote_arg, sizeof remote_arg, "DSTUDIO_REMOTE_DIR=%s/extension/remote", g_web_dir); argv[ai++] = remote_arg; }
        argv[ai] = NULL;
        execvp("make", argv);
        _exit(127);
    }
    close(pp[0]);
    size_t off = 0, total = strlen(JSONL_MAKEFILE);
    while (off < total) {
        ssize_t w = write(pp[1], JSONL_MAKEFILE + off, total - off);
        if (w <= 0) break;
        off += (size_t)w;
    }
    close(pp[1]);
    int st;
    if (waitpid(pid, &st, 0) != pid) return 0;
    return WIFEXITED(st) && WEXITSTATUS(st) == 0;
#endif
}

static int jsonl_sentinel_ok(const char *path) {
    size_t n;
    char *b = jsonl_read_file(path, &n);
    if (!b) return 0;
    int v = atoi(b);
    free(b);
    return v == JSONL_PATCH_VERSION;
}

/* Resolves g_ds4_dir when it is RELATIVE and the cwd does not contain it (launch
 * from Finder/bundle: cwd = "/"). Order: cwd → next to the executable → folder
 * containing the bundle (Contents/MacOS → ../../..) → ~/Documents/dev/ds4. */
static void resolve_ds4_dir(void) {
    char abs[DSTUDIO_PATH_MAX];
    if (realpath(g_ds4_dir, abs) && access(abs, R_OK) == 0) {
        cstr_copy(g_ds4_dir, sizeof g_ds4_dir, abs);
        return;
    }
#ifdef __APPLE__
    char exe[DSTUDIO_PATH_MAX];
    uint32_t n = sizeof exe;
    if (_NSGetExecutablePath(exe, &n) == 0) {
        char exabs[DSTUDIO_PATH_MAX];
        if (realpath(exe, exabs)) {
            char *slash = strrchr(exabs, '/');
            if (slash) {
                *slash = '\0';
                char cand[DSTUDIO_PATH_MAX + 2048];
                snprintf(cand, sizeof cand, "%s/%s", exabs, g_ds4_dir);
                if (realpath(cand, abs) && access(abs, R_OK) == 0) {
                    cstr_copy(g_ds4_dir, sizeof g_ds4_dir, abs);
                    return;
                }
                snprintf(cand, sizeof cand, "%s/../../../%s", exabs, g_ds4_dir);
                if (realpath(cand, abs) && access(abs, R_OK) == 0) {
                    cstr_copy(g_ds4_dir, sizeof g_ds4_dir, abs);
                    return;
                }
            }
        }
    }
#endif
#ifdef _WIN32
    char exe[DSTUDIO_PATH_MAX];
    DWORD en = GetModuleFileNameA(NULL, exe, sizeof exe);
    if (en > 0 && en < sizeof exe) {
        char *slash = strrchr(exe, '\\');
        if (slash) {
            *slash = '\0';
            char cand[DSTUDIO_PATH_MAX + 2048];
            snprintf(cand, sizeof cand, "%s\\%s", exe, g_ds4_dir);
            if (realpath(cand, abs) && access(abs, R_OK) == 0) {
                cstr_copy(g_ds4_dir, sizeof g_ds4_dir, abs);
                return;
            }
            snprintf(cand, sizeof cand, "%s\\ds4", exe);
            if (realpath(cand, abs) && access(abs, R_OK) == 0) {
                cstr_copy(g_ds4_dir, sizeof g_ds4_dir, abs);
                return;
            }
        }
    }
#endif
    const char *home = getenv("HOME");
#ifdef _WIN32
    if (!home || !home[0]) home = getenv("USERPROFILE");
#endif
    if (home && home[0]) {
        char cand[DSTUDIO_PATH_MAX];
#ifdef _WIN32
        snprintf(cand, sizeof cand, "%s\\Documents\\dev\\ds4", home);
#else
        snprintf(cand, sizeof cand, "%s/Documents/dev/ds4", home);
#endif
        if (access(cand, R_OK) == 0) {
            cstr_copy(g_ds4_dir, sizeof g_ds4_dir, cand);
            return;
        }
    }
    fprintf(stderr, "DStudio: ds4 directory not found (%s)\n", g_ds4_dir);
}

/* "build" | "restore". 1 = ok. Applies ALL the JSONL_EDITS edits (jsonl events
 * + slash command/autosave sessions of the non-interactive loop).
 * All in C: backup .bak, patch, make, restore.
 * Replaces the former extension/jsonl/build-jsonl.sh + inject.py script. */
static int run_build_jsonl(const char *action) {
#ifdef _WIN32
    (void)action;
    return file_present("ds4-agent-jsonl.exe");
#else
    char ds4_abs[DSTUDIO_PATH_MAX];
    if (!realpath(g_ds4_dir, ds4_abs)) return 0;
    char src[DSTUDIO_PATH_MAX + 64], bak[DSTUDIO_PATH_MAX + 64];
    char web_src[DSTUDIO_PATH_MAX + 64], web_tmp[DSTUDIO_PATH_MAX + 64], web_obj[DSTUDIO_PATH_MAX + 64];
    char bin[DSTUDIO_PATH_MAX + 64], ver[DSTUDIO_PATH_MAX + 64];
    snprintf(src, sizeof src, "%s/ds4_agent.c", ds4_abs);
    snprintf(bak, sizeof bak, "%s/ds4_agent.c.ds4ui.bak", ds4_abs);
    snprintf(web_src, sizeof web_src, "%s/ds4_web.c", ds4_abs);
    snprintf(web_tmp, sizeof web_tmp, "%s/ds4_web_ds4ui.c", ds4_abs);
    snprintf(web_obj, sizeof web_obj, "%s/ds4_web_ds4ui.o", ds4_abs);
    snprintf(bin, sizeof bin, "%s/ds4-agent-jsonl", ds4_abs);
    snprintf(ver, sizeof ver, "%s/ds4-agent-jsonl.ver", ds4_abs);

    jsonl_unlink_if_exists(web_tmp);
    jsonl_unlink_if_exists(web_obj);

    char *cur = jsonl_read_file(src, NULL);
    if (!cur) return 0;
    int patched = strstr(cur, JSONL_MARK) != NULL;
    free(cur);

    /* crash-clean: source left patched by a crash → restore from the .bak */
    if (patched) {
        if (access(bak, R_OK) != 0) return 0;  /* no .bak: do not touch at random */
        jsonl_copy_preserve(bak, src);
    }
    if (strcmp(action, "restore") == 0) return 1;

    /* idempotence: skip if the binary is newer than the source and the patch
     * version matches (a change to the edits bumps JSONL_PATCH_VERSION). */
    struct stat sb, wb, bb;
    if (access(bin, X_OK) == 0 &&
        stat(src, &sb) == 0 && stat(web_src, &wb) == 0 && stat(bin, &bb) == 0 &&
        bb.st_mtime >= sb.st_mtime && bb.st_mtime >= wb.st_mtime &&
        jsonl_sentinel_ok(ver)) {
        return 1;
    }

    if (!jsonl_copy_preserve(src, bak)) return 0;
    if (!web_cdp_write_temp(web_src, web_tmp)) {
        jsonl_copy_preserve(bak, src);
        jsonl_unlink_if_exists(web_tmp);
        return 0;
    }
    if (!jsonl_apply(src)) {
        jsonl_copy_preserve(bak, src);
        jsonl_unlink_if_exists(web_tmp);
        jsonl_unlink_if_exists(web_obj);
        return 0;
    }
    int ok = jsonl_make(ds4_abs, "ds4-agent-jsonl");
    jsonl_copy_preserve(bak, src);  /* ALWAYS restore, even if the build fails */
    jsonl_unlink_if_exists(web_tmp);
    jsonl_unlink_if_exists(web_obj);
    if (ok) {
        char vs[16];
        int vn = snprintf(vs, sizeof vs, "%d\n", JSONL_PATCH_VERSION);
        jsonl_write_file(ver, vs, (size_t)vn);
    }
    return ok;
#endif
}

/* Runs an extension script (build/restore of the derived binaries).
 * Our own scripts, fixed args → no shell-injection. Blocks until the end;
 * 1 if ok. */
/* Locate this DStudio checkout (the one holding extension/) so helper scripts
 * resolve from the BUNDLE too: launched from Finder the cwd is "/", so a
 * relative "extension/..." path would not be found. Tries cwd, then next to
 * the executable, then up out of the .app bundle (DStudio.app/Contents/MacOS). */
static void resolve_web_dir(void) {
    char cand[DSTUDIO_PATH_MAX + 2048], abs[DSTUDIO_PATH_MAX];
    snprintf(cand, sizeof cand, "extension");
    if (realpath(cand, abs) && access(abs, R_OK) == 0) {
        char *slash = strrchr(abs, '/'); if (slash) *slash = '\0';
        cstr_copy(g_web_dir, sizeof g_web_dir, abs);
        return;
    }
#ifdef __APPLE__
    char exe[DSTUDIO_PATH_MAX]; uint32_t n = sizeof exe;
    if (_NSGetExecutablePath(exe, &n) == 0) {
        char exabs[DSTUDIO_PATH_MAX];
        if (realpath(exe, exabs)) {
            char *slash = strrchr(exabs, '/');
            if (slash) {
                *slash = '\0';
                const char *rels[] = { "%s/extension", "%s/../../../extension" };
                for (int i = 0; i < 2; i++) {
                    snprintf(cand, sizeof cand, rels[i], exabs);
                    if (realpath(cand, abs) && access(abs, R_OK) == 0) {
                        char *s2 = strrchr(abs, '/'); if (s2) *s2 = '\0';
                        cstr_copy(g_web_dir, sizeof g_web_dir, abs);
                        return;
                    }
                }
            }
        }
    }
#endif
#ifdef _WIN32
    char exe[DSTUDIO_PATH_MAX];
    DWORD n = GetModuleFileNameA(NULL, exe, sizeof exe);
    if (n > 0 && n < sizeof exe) {
        char *slash = strrchr(exe, '\\');
        if (slash) {
            *slash = '\0';
            const char *rels[] = { "%s\\extension", "%s\\..\\extension" };
            for (int i = 0; i < 2; i++) {
                snprintf(cand, sizeof cand, rels[i], exe);
                if (realpath(cand, abs) && access(abs, R_OK) == 0) {
                    char *s2 = strrchr(abs, '\\'); if (s2) *s2 = '\0';
                    cstr_copy(g_web_dir, sizeof g_web_dir, abs);
                    return;
                }
            }
        }
    }
#endif
    g_web_dir[0] = '\0'; /* fall back to a relative path in run_ext_script */
}

static int run_ext_script(const char *script, const char *action) {
#ifdef _WIN32
    (void)script; (void)action;
    return file_present("ds4-design.exe");
#else
    char ds4_abs[DSTUDIO_PATH_MAX];
    if (!realpath(g_ds4_dir, ds4_abs)) return 0;
    /* Absolute script path so it resolves regardless of cwd (bundle = "/"). */
    char abs_script[DSTUDIO_PATH_MAX + 1024];
    if (g_web_dir[0]) snprintf(abs_script, sizeof abs_script, "%s/%s", g_web_dir, script);
    else snprintf(abs_script, sizeof abs_script, "%s", script);
    pid_t pid = fork();
    if (pid < 0) return 0;
    if (pid == 0) {
        setenv("DS4_DIR", ds4_abs, 1);
        execl("/bin/sh", "sh", abs_script, action, (char *)NULL);
        _exit(127);
    }
    int st;
    if (waitpid(pid, &st, 0) != pid) return 0;
    return WIFEXITED(st) && WEXITSTATUS(st) == 0;
#endif
}

/* Starts ds4-agent-jsonl --non-interactive --jsonl. in/out/err on pipe. */
static int spawn_agent(const engine_cfg *cfg, const char *workdir, char *err, size_t errsz) {
    int remote_model = g_remote_base_url[0] != '\0';
    if (!remote_model && !file_present(current_model_rel())) {
        snprintf(err, errsz, "model %.16s not found in %.180s",
                 g_variant, g_ds4_dir);
        return 0;
    }
    /* At this point any engine started by us has already been stopped
     * (api_start calls stop_child first). If the server port still responds,
     * there is an EXTERNAL ds4-server: ds4's instance-lock forbids two large
     * processes together, so we refuse with a clear message. */
    if (!g_remote_base_url[0] && port_listening(ENGINE_DEFAULTS.port)) {
        snprintf(err, errsz,
                 "a ds4-server is running outside the launcher (port %d): close it before "
                 "switching to the agent — the instance-lock forbids two large processes",
                 ENGINE_DEFAULTS.port);
        return 0;
    }
    /* Patched agent if requested AND the jsonl build succeeds (idempotent build,
     * restores the source immediately). If the patch is off, or its build FAILS
     * (e.g. the agent was reworked upstream and the anchors no longer apply), run
     * the STOCK ds4-agent — the UI parses its raw output instead. */
    int use_jsonl = g_use_jsonl && run_build_jsonl("build");
    if (remote_model && !use_jsonl) {
        snprintf(err, errsz, "remote agent requires the structured ds4-agent-jsonl build");
        return 0;
    }
    if (g_use_jsonl && !use_jsonl)
        printf("engine: jsonl patch unavailable — falling back to stock ds4-agent (raw output)\n");
    const char *agent_bin = use_jsonl
#ifdef _WIN32
        ? "ds4-agent-jsonl.exe" : "ds4-agent.exe";
#else
        ? "ds4-agent-jsonl" : "ds4-agent";
#endif
    if (!file_present(agent_bin)) {
        snprintf(err, errsz, "%.32s not found in %.150s — build ds4 first (make)", agent_bin, g_ds4_dir);
        return 0;
    }
#ifdef _WIN32
    int ip[2] = {-1, -1}, op[2] = {-1, -1}, ep[2] = {-1, -1};
    (void)ip; (void)op; (void)ep;
#else
    int ip[2], op[2], ep[2];
    if (pipe(ip) != 0 || pipe(op) != 0 || pipe(ep) != 0) { snprintf(err, errsz, "pipe failed"); return 0; }
#endif

    char ctxs[16], pows[16];
    snprintf(ctxs, sizeof ctxs, "%d", cfg->ctx);
    snprintf(pows, sizeof pows, "%d", cfg->power);
    char wd[1024];
    snprintf(wd, sizeof wd, "%s", (workdir && workdir[0]) ? workdir : (getenv("HOME") ? getenv("HOME") : "."));

    /* The agent's --chdir changes cwd BEFORE loading the assets, so both the
     * model and the Metal sources must be passed as ABSOLUTE paths. */
    char cand[DSTUDIO_PATH_MAX + 256], model_abs[DSTUDIO_PATH_MAX] = "", ds4_abs[DSTUDIO_PATH_MAX];
    if (!remote_model) {
        snprintf(cand, sizeof cand, "%s/%s", g_ds4_dir, current_model_rel());
        if (!realpath(cand, model_abs)) {
            snprintf(err, errsz, "model not resolvable: %.200s", cand);
            return 0;
        }
    }
    if (!realpath(g_ds4_dir, ds4_abs)) {
        snprintf(err, errsz, "ds4 dir not resolvable: %.200s", g_ds4_dir);
        return 0;
    }

    /* Built in the parent so the forked child inherits it (used before execv); the
     * parent frees its copy after the fork. The shared charter + active skill go in
     * via the agent's own -sys flag — no change to ds4-agent itself. The design-system
     * (brand) layer is design-only, so it is excluded here (0). */
    char *skill_sys = build_skill_sys(0, use_jsonl);
    if (!g_build_mode && use_jsonl) {
        /* Normal agent, Build Off: keep Claude-like discovery for direction-sensitive
         * work without slowing down straightforward code edits.  This is injected via
         * -sys only; antirez's ds4_agent.c stays untouched. */
        static const char *normal_agent_discovery =
            "\n\n## NORMAL AGENT DISCOVERY (Build Off)\n"
            "Default to action, but ask before committing to a direction when the missing "
            "choice would materially change the result.\n"
            "Ask a compact clarification first, then stop, when the user asks for a NEW "
            "app/site/UI/product flow/brand-facing page and two or more of these are missing "
            "from the prompt and repository context: target user, primary workflow, required "
            "stack/framework, page/screen list, visual direction/brand/reference, must-have "
            "data or integrations, non-goals/constraints.\n"
            "For UI/design work, ask especially when the visual direction is absent: audience, "
            "vibe, reference/brand, and scope are direction-setting. When you ask, use the "
            "question(id,title,questions) tool and STOP. Do not ask in plain prose. The "
            "questions argument is a JSON array string with 1-4 objects: {id,label,type,options}; "
            "type is radio, checkbox, select, text, or textarea. Prefer choices over free text.\n"
            "When the next user message starts with §QUESTION_ANSWER, treat it as the user's "
            "answer to that UI question form and continue with a brief plan plus implementation.\n"
            "Do NOT ask first for bug fixes, tests, reviews, refactors with clear files, shell "
            "commands, dependency updates, or small requested changes. Inspect the repo first "
            "when files can answer the question. If only one minor ambiguity remains, state a "
            "reasonable assumption and proceed.\n"
            "Never ask the same clarification twice; once the user answers, proceed with a "
            "brief plan and implementation.\n";
        size_t cur = skill_sys ? strlen(skill_sys) : 0, dl = strlen(normal_agent_discovery);
        char *nb = realloc(skill_sys, cur + dl + 1);
        if (nb) { skill_sys = nb; memcpy(skill_sys + cur, normal_agent_discovery, dl + 1); }
    } else {
        /* Build mode (planned): a deterministic driver (the web UI) first asks the model to
         * propose a plan (pages + style), writes plan.md, then walks it ONE page at a time —
         * the designer makes each page, the agent wires it. Each agent turn handles exactly
         * one page. The proto keeps the agent in that lane (no hands-off whole-app build). */
        static const char *proto_plan =
            "\n\n## BUILD MODE (planned) — wire ONE page at a time\n"
            "You are in planned Build mode: a driver feeds you the app ONE page at a time and "
            "tracks progress from a `plan.md` in this directory. Each turn you are told exactly "
            "ONE page to wire — its static design HTML is already here.\n"
            "- Do EXACTLY the page you're told this turn — nothing else. Don't build other pages, "
            "don't scaffold ahead, don't 'finish the app'. The driver decides what comes next.\n"
            "- Scaffold the backend on the FIRST page only (per your skill, e.g. web-app/Django: "
            "project, base.html, settings, requirements.txt). On later pages, reuse it.\n"
            "- Convert that page's HTML into a template that extends the shared base, wire its "
            "model/view/URL/form, keep the look intact, and make the page render.\n"
            "- Run `manage.py check` (and a quick `runserver` sanity) before ending the turn. "
            "Then STOP — do NOT request design pages (the driver supplies them), do NOT continue "
            "to another page. The driver verifies the result on disk and feeds you the next page.\n";
        size_t cur = skill_sys ? strlen(skill_sys) : 0, pl = strlen(proto_plan);
        char *nb = realloc(skill_sys, cur + pl + 1);
        if (nb) { skill_sys = nb; memcpy(skill_sys + cur, proto_plan, pl + 1); }
    }

#ifdef _WIN32
    char exe[2200];
    win_join_path(exe, sizeof exe, g_ds4_dir, agent_bin);
    char *think_flag = cfg->think == 0 ? "--nothink"
                     : cfg->think == 2 ? "--think-max"
                     : "--think";
    char *argv[26]; int n = 0;
    argv[n++] = exe;
    argv[n++] = "--non-interactive";
    if (use_jsonl) argv[n++] = "--jsonl";
    if (remote_model) {
        argv[n++] = "--remote-base-url"; argv[n++] = g_remote_base_url;
        argv[n++] = "--remote-model"; argv[n++] = g_remote_model[0] ? g_remote_model : "ds4";
    } else {
        argv[n++] = "--cpu";
        argv[n++] = "-m"; argv[n++] = model_abs;
    }
    argv[n++] = "-c"; argv[n++] = ctxs;
    argv[n++] = "--power"; argv[n++] = pows;
    argv[n++] = think_flag;
    argv[n++] = "--chdir"; argv[n++] = wd;
    if (skill_sys && skill_sys[0]) { argv[n++] = "-sys"; argv[n++] = skill_sys; }
    argv[n] = NULL;
    pid_t pid = 0;
    if (!win_spawn(g_ds4_dir, argv, 1, &g_in_fd, &g_out_fd, &g_err_fd, &pid, err, errsz)) {
        free(skill_sys);
        return 0;
    }
    g_child_win_pid = g_last_spawn_win_pid;
    free(skill_sys);
#else
    pid_t pid = fork();
    if (pid < 0) { snprintf(err, errsz, "fork: %s", strerror(errno)); free(skill_sys); return 0; }
    if (pid == 0) {
        if (chdir(g_ds4_dir) != 0) _exit(127);   /* to find ./ds4-agent */
        if (!remote_model) {
            child_setenv_metal();
            child_setenv_metal_sources(ds4_abs); /* absolute: survive --chdir */
        }
        child_setenv_skills();                   /* on-demand skill()/design_system() packs */
        dup2(ip[0], STDIN_FILENO);
        dup2(op[1], STDOUT_FILENO);
        dup2(ep[1], STDERR_FILENO);
        close(ip[0]); close(ip[1]); close(op[0]); close(op[1]); close(ep[0]); close(ep[1]);
        if (g_srv_fd >= 0) close(g_srv_fd);
        char binpath[64];
        snprintf(binpath, sizeof binpath, "./%s", agent_bin);
        char *think_flag = cfg->think == 0 ? "--nothink"
                         : cfg->think == 2 ? "--think-max"
                         : "--think";
        char *argv[26]; int n = 0;
        argv[n++] = binpath;
        argv[n++] = "--non-interactive";
        if (use_jsonl) argv[n++] = "--jsonl";
        if (remote_model) {
            argv[n++] = "--remote-base-url"; argv[n++] = g_remote_base_url;
            argv[n++] = "--remote-model"; argv[n++] = g_remote_model[0] ? g_remote_model : "ds4";
        } else {
            argv[n++] = "--metal";
            argv[n++] = "-m"; argv[n++] = model_abs;
        }
        argv[n++] = "-c"; argv[n++] = ctxs;
        argv[n++] = "--power"; argv[n++] = pows;
        argv[n++] = think_flag;
        argv[n++] = "--chdir"; argv[n++] = wd;
        if (skill_sys && skill_sys[0]) { argv[n++] = "-sys"; argv[n++] = skill_sys; }
        argv[n] = NULL;
        execv(binpath, argv);
        _exit(127);
    }
    free(skill_sys);
    close(ip[0]); close(op[1]); close(ep[1]);
    g_in_fd = ip[1]; g_out_fd = op[0]; g_err_fd = ep[0];
    set_nonblock(g_out_fd); set_nonblock(g_err_fd);
#endif
    g_child = pid; g_mode = ENGINE_AGENT; g_cfg = *cfg;
    g_jsonl_active = use_jsonl;
    snprintf(g_workdir, sizeof g_workdir, "%s", wd);
    agent_buf_reset();
    reset_progress("Starting the agent…");
    g_agent_working = 0;
    printf("engine: agent pid %d (chdir %s, %s, %s)\n", (int)pid, wd,
           cfg->uncensored ? "uncensored" : "standard",
           remote_model ? "jsonl/remote-model" : (use_jsonl ? "jsonl" : "stock/raw"));
    return 1;
}

/* Starts ds4-design --jsonl. Like the agent but without --chdir: the cwd stays
 * the ds4 dir (binary, model and relative Metal sources work), and the design
 * only exits into the workspace passed with --workspace. The source lives in
 * THIS repo (extension/design/ds4_design.c, native \x1e events): the script
 * compiles it in the ds4 repo as an untracked output, without patch or .bak. */
static int spawn_design(const engine_cfg *cfg, const char *workdir, char *err, size_t errsz) {
    int remote_model = g_remote_base_url[0] != '\0';
    if (!remote_model && !file_present(current_model_rel())) {
        snprintf(err, errsz, "model %.16s not found in %.180s",
                 g_variant, g_ds4_dir);
        return 0;
    }
    if (!remote_model && port_listening(ENGINE_DEFAULTS.port)) {
        snprintf(err, errsz,
                 "a ds4-server is running outside the launcher (port %d): close it before "
                 "switching to the design — the instance-lock forbids two large processes",
                 ENGINE_DEFAULTS.port);
        return 0;
    }
#ifdef _WIN32
    if (!file_present("ds4-design.exe")) {
        snprintf(err, errsz, "ds4-design.exe not found in %s — use the Windows CPU artifact", g_ds4_dir);
        return 0;
    }
#else
    if (!run_ext_script("extension/design/build-design.sh", "build")) {
        snprintf(err, errsz, "build of ds4-design failed (see the serve terminal)");
        return 0;
    }
#endif
#ifdef _WIN32
    int ip[2] = {-1, -1}, op[2] = {-1, -1}, ep[2] = {-1, -1};
    (void)ip; (void)op; (void)ep;
#else
    int ip[2], op[2], ep[2];
    if (pipe(ip) != 0 || pipe(op) != 0 || pipe(ep) != 0) { snprintf(err, errsz, "pipe failed"); return 0; }
#endif

    char ctxs[16], pows[16];
    snprintf(ctxs, sizeof ctxs, "%d", cfg->ctx);
    snprintf(pows, sizeof pows, "%d", cfg->power);
    char wd[1024];
    if (workdir && workdir[0]) {
        snprintf(wd, sizeof wd, "%s", workdir);
    } else {
        const char *home = getenv("HOME");
        snprintf(wd, sizeof wd, "%s/Documents/ds4-designs", home ? home : ".");
    }

    /* Same as the agent, but design also gets the active design-system (brand) layer (1):
     * charter + DESIGN.md + SKILL.md, injected via ds4-design's -sys flag. */
    char *skill_sys = build_skill_sys(1, 0);

#ifdef _WIN32
    char exe[2200];
    win_join_path(exe, sizeof exe, g_ds4_dir, "ds4-design.exe");
    char *think_flag = cfg->think == 0 ? "--nothink"
                     : cfg->think == 2 ? "--think-max"
                     : "--think";
    char *argv[24]; int n = 0;
    argv[n++] = exe;
    argv[n++] = "--jsonl";
    if (remote_model) {
        argv[n++] = "--remote-base-url"; argv[n++] = g_remote_base_url;
        argv[n++] = "--remote-model"; argv[n++] = g_remote_model[0] ? g_remote_model : "ds4";
    } else {
        argv[n++] = "--cpu";
        argv[n++] = "-m"; argv[n++] = (char *)current_model_rel();
    }
    argv[n++] = "-c"; argv[n++] = ctxs;
    argv[n++] = "--power"; argv[n++] = pows;
    argv[n++] = think_flag;
    argv[n++] = "--workspace"; argv[n++] = wd;
    if (skill_sys && skill_sys[0]) { argv[n++] = "-sys"; argv[n++] = skill_sys; }
    argv[n] = NULL;
    pid_t pid = 0;
    if (!win_spawn(g_ds4_dir, argv, 1, &g_in_fd, &g_out_fd, &g_err_fd, &pid, err, errsz)) {
        free(skill_sys);
        return 0;
    }
    g_child_win_pid = g_last_spawn_win_pid;
    free(skill_sys);
#else
    pid_t pid = fork();
    if (pid < 0) { snprintf(err, errsz, "fork: %s", strerror(errno)); free(skill_sys); return 0; }
    if (pid == 0) {
        if (chdir(g_ds4_dir) != 0) _exit(127);   /* to find ./ds4-design */
        if (!remote_model) child_setenv_metal();
        child_setenv_skills();                   /* on-demand skill()/design_system() packs */
        dup2(ip[0], STDIN_FILENO);
        dup2(op[1], STDOUT_FILENO);
        dup2(ep[1], STDERR_FILENO);
        close(ip[0]); close(ip[1]); close(op[0]); close(op[1]); close(ep[0]); close(ep[1]);
        if (g_srv_fd >= 0) close(g_srv_fd);
        char *think_flag = cfg->think == 0 ? "--nothink"
                         : cfg->think == 2 ? "--think-max"
                         : "--think";
        char *argv[24]; int n = 0;
        argv[n++] = "./ds4-design";
        argv[n++] = "--jsonl";
        if (remote_model) {
            argv[n++] = "--remote-base-url"; argv[n++] = g_remote_base_url;
            argv[n++] = "--remote-model"; argv[n++] = g_remote_model[0] ? g_remote_model : "ds4";
        } else {
            argv[n++] = "--metal";
            argv[n++] = "-m"; argv[n++] = (char *)current_model_rel();
        }
        argv[n++] = "-c"; argv[n++] = ctxs;
        argv[n++] = "--power"; argv[n++] = pows;
        argv[n++] = think_flag;
        argv[n++] = "--workspace"; argv[n++] = wd;
        if (skill_sys && skill_sys[0]) { argv[n++] = "-sys"; argv[n++] = skill_sys; }
        argv[n] = NULL;
        execv("./ds4-design", argv);
        _exit(127);
    }
    free(skill_sys);
    close(ip[0]); close(op[1]); close(ep[1]);
    g_in_fd = ip[1]; g_out_fd = op[0]; g_err_fd = ep[0];
    set_nonblock(g_out_fd); set_nonblock(g_err_fd);
#endif
    g_child = pid; g_mode = ENGINE_DESIGN; g_cfg = *cfg;
    g_jsonl_active = 1; /* design uses its own native --jsonl (DStudio's extension) */
    snprintf(g_workdir, sizeof g_workdir, "%s", wd);
    snprintf(g_design_dir, sizeof g_design_dir, "%s", wd);
    agent_buf_reset();
    reset_progress("Starting the design agent…");
    g_agent_working = 0;
    printf("engine: design pid %d (workspace %s, %s%s)\n", (int)pid, wd,
           cfg->uncensored ? "uncensored" : "standard",
           remote_model ? ", remote-model" : "");
    return 1;
}

/* Reads whatever is available from the child's pipes (non-blocking). */
static void drain_child(void) {
    if (g_out_fd < 0 && g_err_fd < 0) return;
    char buf[8192];
    if (g_out_fd >= 0) {
        for (;;) {
            ssize_t n = read(g_out_fd, buf, sizeof buf);
            if (n > 0) {
                if (MODE_IS_PIPED(g_mode)) agent_buf_append(buf, (size_t)n);
                scan_lines(buf, (size_t)n, g_line_out, &g_line_out_len, 0);
            } else if (n == 0) { break; }
            else { break; } /* EAGAIN or error: retry on the next pass */
            if (n < (ssize_t)sizeof buf) break;
        }
    }
    if (g_err_fd >= 0) {
        for (;;) {
            ssize_t n = read(g_err_fd, buf, sizeof buf);
            if (n > 0) {
                scan_lines(buf, (size_t)n, g_line_err, &g_line_err_len, 1);
            } else break;
            if (n < (ssize_t)sizeof buf) break;
        }
    }
    /* Server readiness: besides the log, confirm via the listening port. */
    if (g_mode == ENGINE_SERVER && !g_ready && port_listening(g_cfg.port)) {
        set_stage("Ready", 100);
        g_ready = 1;
    }
}

/* ==================== API handlers ==================== */

static const char *mode_name(int m) {
    return m == ENGINE_SERVER ? "server" :
           m == ENGINE_AGENT ? "agent" :
           m == ENGINE_DESIGN ? "design" : "none";
}

/* POST /api/model/download {variant} — fetch a model variant's GGUF in the
 * background by running ds4's download script (pro → download_model.sh
 * pro-q2-imatrix; flash → download-abliterated.sh), logging to a file. The
 * percentage is read from the growing file in /api/status. */
static void api_model_download(int fd, const char *body) {
#ifdef _WIN32
    (void)body;
    send_json(fd, "501 Not Implemented",
              "{\"ok\":false,\"error\":\"model download scripts are not available in the Windows portable build yet\"}");
    return;
#else
    char variant[16] = {0}, target[48] = {0};
    json_get_string(body, "variant", variant, sizeof variant);
    json_get_string(body, "target", target, sizeof target);

    /* Whitelist of download_model.sh targets (the different quantizations). */
    static const char *TARGETS[] = {
        "q2-imatrix", "q2-q4-imatrix", "q4-imatrix",
        "pro-q2-imatrix", "pro-q4-layers00-30", "pro-q4-layers31-output", "pro-q4-split",
    };
    int valid = 0;
    for (size_t i = 0; i < sizeof TARGETS / sizeof TARGETS[0]; i++)
        if (!strcmp(target, TARGETS[i])) valid = 1;
    /* Legacy: variant=flash → the abliterated script; variant=pro → pro-q2 target. */
    int abliterated = !target[0] && !strcmp(variant, "flash");
    if (!target[0] && !strcmp(variant, "pro")) { snprintf(target, sizeof target, "pro-q2-imatrix"); valid = 1; }
    if (!valid && !abliterated) {
        send_json(fd, "400 Bad Request", "{\"ok\":false,\"error\":\"unknown model/target\"}");
        return;
    }
    if (g_dl_pid > 0) {
        send_json(fd, "409 Conflict", "{\"ok\":false,\"error\":\"a download is already running\"}");
        return;
    }
    char ds4_abs[DSTUDIO_PATH_MAX];
    if (!realpath(g_ds4_dir, ds4_abs)) {
        send_json(fd, "500 Internal Server Error", "{\"ok\":false,\"error\":\"ds4 dir not found\"}");
        return;
    }
    pid_t pid = fork();
    if (pid < 0) { send_json(fd, "500 Internal Server Error", "{\"ok\":false,\"error\":\"fork failed\"}"); return; }
    if (pid == 0) {
        if (chdir(ds4_abs) != 0) _exit(127);
        int log = open("/tmp/ds4-model-dl.log", O_WRONLY | O_CREAT | O_TRUNC, 0644);
        if (log >= 0) { dup2(log, STDOUT_FILENO); dup2(log, STDERR_FILENO); close(log); }
        int dn = open("/dev/null", O_RDONLY); if (dn >= 0) { dup2(dn, STDIN_FILENO); close(dn); }
        if (abliterated) execl("/bin/sh", "sh", "download-abliterated.sh", (char *)NULL);
        else            execl("/bin/sh", "sh", "download_model.sh", target, (char *)NULL);
        _exit(127);
    }
    g_dl_pid = pid;
    cstr_copy(g_dl_variant, sizeof g_dl_variant, abliterated ? "flash" : target);
    printf("model: downloading %s (pid %d) — log /tmp/ds4-model-dl.log\n", abliterated ? "abliterated" : target, (int)pid);
    char out[96];
    snprintf(out, sizeof out, "{\"ok\":true,\"target\":\"%s\"}", abliterated ? "flash" : target);
    send_json(fd, "200 OK", out);
#endif
}

static void api_status(int fd) {
    reap_child();
    char stage_esc[192];
    json_escape_into(stage_esc, sizeof stage_esc, g_stage, strlen(g_stage));
    char wd_esc[1100];
    json_escape_into(wd_esc, sizeof wd_esc, g_workdir, strlen(g_workdir));

    char cfg[256];
    if (g_child > 0)
        snprintf(cfg, sizeof cfg, "{\"model\":\"%s\",\"port\":%d,\"ctx\":%d,\"power\":%d,\"think\":\"%s\"}",
                 g_cfg.uncensored ? "uncensored" : "standard", g_cfg.port, g_cfg.ctx, g_cfg.power,
                 g_cfg.think == 0 ? "off" : g_cfg.think == 2 ? "max" : "high");
    else
        snprintf(cfg, sizeof cfg, "null");

    /* download progress (variant GGUF): % from the partial file size. */
    long long dl_pct = -1;
    if (g_dl_variant[0]) {
        char full[2048];
        snprintf(full, sizeof full, "%s/%s", g_ds4_dir, variant_rel(g_dl_variant));
        struct stat st;
        long long have = (stat(full, &st) == 0) ? (long long)st.st_size : 0;
        dl_pct = have * 100 / MODEL_PRO_EXPECTED_BYTES;
        if (dl_pct > 99) dl_pct = 99;            /* 100 only when the file is complete */
        if (file_present(variant_rel(g_dl_variant)) && g_dl_pid <= 0) dl_pct = 100;
    }

    char d4_esc[2100], web_esc[2100], err_esc[600], line_esc[600], mf_esc[1100];
    json_escape_into(d4_esc, sizeof d4_esc, g_ds4_dir, strlen(g_ds4_dir));
    json_escape_into(web_esc, sizeof web_esc, g_web_dir, strlen(g_web_dir));
    json_escape_into(err_esc, sizeof err_esc, g_engine_err, strlen(g_engine_err));
    json_escape_into(line_esc, sizeof line_esc, g_last_engine_line, strlen(g_last_engine_line));
    json_escape_into(mf_esc, sizeof mf_esc, current_model_rel(), strlen(current_model_rel()));

    char lan_addr[80];
    int lan_on = lan_status(lan_addr, sizeof lan_addr);

    char body[12288];
    snprintf(body, sizeof body,
        "{\"mode\":\"%s\",\"running\":%s,\"ready\":%s,\"loadPct\":%d,\"stage\":\"%s\","
        "\"agentWorking\":%s,\"workdir\":\"%s\",\"config\":%s,\"jsonl\":%s,"
        "\"ds4dir\":\"%s\",\"ds4dirOk\":%s,\"webdir\":\"%s\",\"webdirOk\":%s,"
        "\"lan\":%s,\"lanAddr\":\"%s\",\"httpPort\":%d,"
        "\"models\":{\"standard\":%s,\"uncensored\":%s},"
        "\"variants\":{\"flash\":%s,\"pro\":%s},\"variant\":\"%s\","
        "\"download\":%s,\"downloadVariant\":\"%s\",\"downloadPct\":%lld,"
        "\"engineError\":\"%s\",\"engineLine\":\"%s\",\"modelFile\":\"%s\",\"skill\":\"%s\",\"designSystem\":\"%s\",\"build\":%d}",
        mode_name(g_mode), g_child > 0 ? "true" : "false", g_ready ? "true" : "false",
        g_load_pct, stage_esc, g_agent_working ? "true" : "false", wd_esc, cfg,
        g_jsonl_active ? "true" : "false",
        d4_esc, ds4_dir_valid() ? "true" : "false", web_esc, web_dir_valid() ? "true" : "false",
        lan_on ? "true" : "false", lan_addr, g_http_port,
        model_present(0) ? "true" : "false", model_present(1) ? "true" : "false",
        file_present(MODEL_FLASH) ? "true" : "false", file_present(MODEL_PRO) ? "true" : "false",
        g_variant, g_dl_variant[0] ? "true" : "false", g_dl_variant, dl_pct, err_esc, line_esc, mf_esc, g_skill, g_design_system,
        g_build_mode);
    send_json(fd, "200 OK", body);
}

static void api_lan_health(int fd) {
    char lan_addr[80];
    int lan_on = lan_status(lan_addr, sizeof lan_addr);
    char body[180];
    snprintf(body, sizeof body,
             "{\"ok\":true,\"app\":\"DStudio\",\"lan\":%s,\"lanAddr\":\"%s\",\"httpPort\":%d}",
             lan_on ? "true" : "false", lan_addr, g_http_port);
    send_json_cors(fd, "200 OK", body);
}

static int doctor_add_check(json_dyn_buf *b, int *first, const char *id, const char *label,
                            const char *state, const char *message, const char *action) {
    int ok = json_dyn_puts(b, *first ? "" : ",") &&
             json_dyn_puts(b, "{\"id\":") &&
             json_dyn_put_escaped(b, id) &&
             json_dyn_puts(b, ",\"label\":") &&
             json_dyn_put_escaped(b, label) &&
             json_dyn_puts(b, ",\"state\":") &&
             json_dyn_put_escaped(b, state) &&
             json_dyn_puts(b, ",\"message\":") &&
             json_dyn_put_escaped(b, message ? message : "") &&
             json_dyn_puts(b, ",\"action\":");
    ok = ok && (action ? json_dyn_put_escaped(b, action) : json_dyn_puts(b, "null"));
    ok = ok && json_dyn_puts(b, "}");
    if (ok) *first = 0;
    return ok;
}

/* GET /api/doctor — cheap first-run/preflight checks. It intentionally does not
 * auto-discover, clone, install, build, or launch anything: it reports what is
 * ready and gives the UI an action code for the next user-controlled step. */
static void api_doctor(int fd) {
    reap_child();
    int ds4_ok = ds4_dir_valid();
    int model_ok = ds4_ok && (file_present(current_model_rel()) || any_gguf_present());
    int current_model_ok = ds4_ok && file_present(current_model_rel());
    int agent_ok = ds4_ok && (rel_exists("ds4-agent") || rel_exists("ds4-agent.exe") ||
                              rel_exists("ds4-agent-jsonl") || rel_exists("ds4-agent-jsonl.exe"));
    int agent_src_ok = ds4_ok && rel_exists("ds4_agent.c");
    int design_ok = ds4_ok && (rel_exists("ds4-design") || rel_exists("ds4-design.exe") ||
                               rel_exists("ds4_design.c"));
    int web_ok = ds4_ok && agent_src_ok && chrome_available();
    int engine_port_owned = g_child > 0;
    int engine_port_busy = port_listening(ENGINE_DEFAULTS.port) && !engine_port_owned;
    int server_ok = (g_mode == ENGINE_SERVER && g_child > 0 && g_ready) || port_listening(ENGINE_DEFAULTS.port);

    char ds4_msg[1400];
    snprintf(ds4_msg, sizeof ds4_msg, ds4_ok ? "Using %s" : "Choose the ds4 folder that contains the engine binaries.", g_ds4_dir);

    json_dyn_buf b = {0};
    int first = 1, fatal = 0, warn = 0, ok = 1;
    ok = ok && json_dyn_puts(&b, "{\"ok\":true,\"checks\":[");

    if (!ds4_ok) fatal++;
    ok = ok && doctor_add_check(&b, &first, "ds4", "Engine folder",
        ds4_ok ? "ok" : "error", ds4_msg, ds4_ok ? NULL : "choose-ds4");

    if (!model_ok) fatal++;
    else if (!current_model_ok) warn++;
    ok = ok && doctor_add_check(&b, &first, "model", "Model",
        model_ok ? (current_model_ok ? "ok" : "warn") : "error",
        model_ok ? (current_model_ok ? "Selected GGUF is present." : "A GGUF is present; pick it from the model menu if needed.")
                 : "Download or copy a DeepSeek V4 GGUF into the ds4 folder.",
        model_ok ? NULL : "download-model");

    if (!server_ok) warn++;
    ok = ok && doctor_add_check(&b, &first, "chat", "Chat",
        server_ok ? "ok" : (model_ok ? "warn" : "error"),
        server_ok ? "Engine is reachable." : (model_ok ? "Start the local engine." : "Needs a model first."),
        server_ok ? NULL : (model_ok ? "start-engine" : "download-model"));

    if (!agent_ok) warn++;
    ok = ok && doctor_add_check(&b, &first, "agent", "Agent",
        agent_ok ? "ok" : "warn",
        agent_ok ? "Agent binary is available." : "Build ds4 once, then Agent can start from the workspace picker.",
        agent_ok ? NULL : "open-settings");

    if (!design_ok) warn++;
    ok = ok && doctor_add_check(&b, &first, "design", "Design",
        design_ok ? "ok" : "warn",
        design_ok ? "Design runtime is available." : "Open Design once after ds4 is set; DStudio will prepare the runtime.",
        design_ok ? NULL : "open-settings");

    if (!web_ok) warn++;
    ok = ok && doctor_add_check(&b, &first, "web", "Web",
        web_ok ? "ok" : "warn",
        web_ok ? "Local browser search is ready." :
                 (chrome_available() ? "Web Search will build the DS4 helper on first use." : "Install Chrome or Chromium for Web Search."),
        web_ok ? NULL : "open-settings");

    if (engine_port_busy) warn++;
    ok = ok && doctor_add_check(&b, &first, "port", "Port",
        engine_port_busy ? "warn" : "ok",
        engine_port_busy ? "Another ds4-server is already listening on the engine port." :
        (engine_port_owned ? "DStudio is managing the engine port." : "Engine port is available."),
        engine_port_busy ? "open-settings" : NULL);

    char lan_addr[80];
    int lan_on = lan_status(lan_addr, sizeof lan_addr);
    if (lan_on) warn++;
    ok = ok && doctor_add_check(&b, &first, "network", "Network",
        lan_on ? "warn" : "ok",
        lan_on ? "LAN access is enabled; use only on trusted networks." : "Localhost only.",
        lan_on ? "open-settings" : NULL);

    ok = ok && json_dyn_puts(&b, "],\"ready\":") &&
         json_dyn_puts(&b, fatal ? "false" : "true") &&
         json_dyn_puts(&b, ",\"fatal\":");
    char nums[80];
    snprintf(nums, sizeof nums, "%d,\"warnings\":%d", fatal, warn);
    ok = ok && json_dyn_puts(&b, nums) &&
         json_dyn_puts(&b, ",\"summary\":") &&
         json_dyn_put_escaped(&b, fatal ? "Setup needed" : (warn ? "Ready with notes" : "Ready")) &&
         json_dyn_puts(&b, "}");

    if (!ok) {
        free(b.ptr);
        send_json(fd, "500 Internal Server Error", "{\"ok\":false,\"error\":\"out of memory\"}");
        return;
    }
    send_json(fd, "200 OK", b.ptr);
    free(b.ptr);
}

/* GET /api/ggufs — list the .gguf files in the engine folder (and its gguf/
 * subdir) with sizes. The UI parses the filenames to label model/quant/kind.
 * Symlinks are skipped so the same file is not listed twice. */
static void api_ggufs(int fd) {
    char body[4096];
    int o = snprintf(body, sizeof body, "{\"ok\":true,\"ggufs\":[");
    int n = 0;
    const char *subs[2] = { "gguf", "" };
    for (int di = 0; di < 2 && o < (int)sizeof body - 800; di++) {
        char dir[2200];
        snprintf(dir, sizeof dir, "%s%s%s", g_ds4_dir, subs[di][0] ? "/" : "", subs[di]);
        DIR *d = opendir(dir);
        if (!d) continue;
        struct dirent *de;
        while ((de = readdir(d)) != NULL && o < (int)sizeof body - 800) {
            const char *nm = de->d_name;
            size_t L = strlen(nm);
            if (L < 6 || strcmp(nm + L - 5, ".gguf")) continue;
            char full[3200]; struct stat st;
            snprintf(full, sizeof full, "%s/%s", dir, nm);
            if (lstat(full, &st) != 0 || !S_ISREG(st.st_mode)) continue;  /* skip symlinks/dirs */
            char esc[700];
            json_escape_into(esc, sizeof esc, nm, strlen(nm));
            o += snprintf(body + o, sizeof body - o,
                          "%s{\"file\":\"%s\",\"path\":\"%s%s\",\"size\":%lld}",
                          n++ ? "," : "", esc, subs[di][0] ? "gguf/" : "", esc, (long long)st.st_size);
        }
        closedir(d);
    }
    snprintf(body + o, sizeof body - o, "]}");
    send_json(fd, "200 OK", body);
}

/* Extract a top-of-file YAML frontmatter scalar (a `key: value` line) into out.
 * Only matches at a line start and within the first ~800 bytes (the frontmatter),
 * so body prose can't masquerade as a field. Surrounding [] / quotes are kept raw. */
static void fm_field(const char *content, const char *key, char *out, size_t outsz) {
    out[0] = '\0';
    size_t klen = strlen(key);
    const char *p = content;
    int at_line_start = 1;
    int fm_delims = 0;
    size_t scanned = 0;
    while (*p && scanned < 8192) {
        if (at_line_start && p[0] == '-' && p[1] == '-' && p[2] == '-') {
            fm_delims++;
            if (fm_delims >= 2) return;
        }
        if (at_line_start && !strncmp(p, key, klen) && p[klen] == ':') {
            p += klen + 1;
            while (*p == ' ' || *p == '\t') p++;
            if (*p == '|' || *p == '>') {
                const char *nl = strchr(p, '\n');
                if (!nl) return;
                p = nl + 1;
                int indent = -1;
                size_t o = 0;
                while (*p && scanned < 8192) {
                    const char *line = p;
                    const char *end = strchr(line, '\n');
                    size_t len = end ? (size_t)(end - line) : strlen(line);
                    if (len >= 3 && line[0] == '-' && line[1] == '-' && line[2] == '-') break;
                    int ind = 0;
                    while (line[ind] == ' ' || line[ind] == '\t') ind++;
                    if (line[ind] && indent < 0) indent = ind;
                    if (line[ind] && indent >= 0 && ind < indent) break;
                    if (line[ind] && indent >= 0) {
                        const char *s = line + indent;
                        const char *e = line + len;
                        while (e > s && (e[-1] == ' ' || e[-1] == '\t' || e[-1] == '\r')) e--;
                        if (e > s) {
                            if (o && o < outsz - 1) out[o++] = ' ';
                            while (s < e && o < outsz - 1) out[o++] = *s++;
                        }
                    }
                    if (!end) break;
                    scanned += len + 1;
                    p = end + 1;
                }
                out[o] = '\0';
                return;
            }
            size_t o = 0;
            while (*p && *p != '\n' && *p != '\r' && o < outsz - 1) out[o++] = *p++;
            while (o > 0 && (out[o - 1] == ' ' || out[o - 1] == '\t')) o--;
            out[o] = '\0';
            return;
        }
        at_line_start = (*p == '\n');
        p++; scanned++;
    }
}

/* Emit a JSON catalog of the Markdown packs under extension/<subdir>/<id>/<file>,
 * reading each pack's frontmatter name/description/modes. Shared by /api/skills and
 * /api/design-systems. key is the top-level JSON array name. */
static void md_catalog(int fd, const char *subdir, const char *file, const char *key) {
    json_dyn_buf body = {0};
    if (!json_dyn_printf(&body, "{\"ok\":true,\"%s\":[", key)) {
        send_json(fd, "500 Internal Server Error", "{\"ok\":false}");
        return;
    }
    int n = 0;
    if (g_web_dir[0]) {
        char dir[12288];
        snprintf(dir, sizeof dir, "%s/extension/%s", g_web_dir, subdir);
        DIR *d = opendir(dir);
        if (d) {
            struct dirent *de;
            while ((de = readdir(d)) != NULL) {
                const char *id = de->d_name;
                if (id[0] == '.' || !skill_id_ok(id)) continue;
                size_t mdlen = strlen(dir) + 1 + strlen(id) + 1 + strlen(file) + 1;
                char *md = malloc(mdlen);
                if (!md) continue;
                snprintf(md, mdlen, "%s/%s/%s", dir, id, file);
                size_t len = 0;
                char *content = jsonl_read_file(md, &len);
                free(md);
                if (!content) continue;
                char nm[300], desc[900], modes[200], cat[160], local_mode[120];
                char output[240], provider[180], upstream[400];
                fm_field(content, "name", nm, sizeof nm);
                fm_field(content, "description", desc, sizeof desc);
                fm_field(content, "modes", modes, sizeof modes);
                fm_field(content, "ds4_category", cat, sizeof cat);
                fm_field(content, "ds4_local_mode", local_mode, sizeof local_mode);
                fm_field(content, "ds4_output_kinds", output, sizeof output);
                fm_field(content, "ds4_provider", provider, sizeof provider);
                fm_field(content, "ds4_upstream", upstream, sizeof upstream);
                free(content);
                if (!nm[0]) cstr_copy(nm, sizeof nm, id);
                char assets[2300], refs[2300], example[2300];
                snprintf(assets, sizeof assets, "%s/%s/assets", dir, id);
                snprintf(refs, sizeof refs, "%s/%s/references", dir, id);
                snprintf(example, sizeof example, "%s/%s/example.html", dir, id);
                int has_assets = access(assets, R_OK) == 0;
                int has_refs = access(refs, R_OK) == 0;
                int has_example = access(example, R_OK) == 0;

                if (!json_dyn_puts(&body, n++ ? ",{" : "{")) goto oom;
                if (!json_dyn_puts(&body, "\"id\":") || !json_dyn_put_escaped(&body, id)) goto oom;
                if (!json_dyn_puts(&body, ",\"name\":") || !json_dyn_put_escaped(&body, nm)) goto oom;
                if (!json_dyn_puts(&body, ",\"description\":") || !json_dyn_put_escaped(&body, desc)) goto oom;
                if (!json_dyn_puts(&body, ",\"modes\":") || !json_dyn_put_escaped(&body, modes)) goto oom;
                if (!json_dyn_puts(&body, ",\"category\":") || !json_dyn_put_escaped(&body, cat)) goto oom;
                if (!json_dyn_puts(&body, ",\"localMode\":") || !json_dyn_put_escaped(&body, local_mode)) goto oom;
                if (!json_dyn_puts(&body, ",\"outputKinds\":") || !json_dyn_put_escaped(&body, output)) goto oom;
                if (!json_dyn_puts(&body, ",\"provider\":") || !json_dyn_put_escaped(&body, provider)) goto oom;
                if (!json_dyn_puts(&body, ",\"upstream\":") || !json_dyn_put_escaped(&body, upstream)) goto oom;
                if (!json_dyn_printf(&body,
                                      ",\"hasAssets\":%s,\"hasReferences\":%s,\"hasExample\":%s}",
                                      has_assets ? "true" : "false",
                                      has_refs ? "true" : "false",
                                      has_example ? "true" : "false"))
                    goto oom;
            }
            closedir(d);
        }
    }
    if (!json_dyn_puts(&body, "]}")) goto oom;
    send_json(fd, "200 OK", body.ptr ? body.ptr : "{\"ok\":true}");
    free(body.ptr);
    return;
oom:
    free(body.ptr);
    send_json(fd, "500 Internal Server Error", "{\"ok\":false,\"error\":\"catalog memory\"}");
}

/* GET /api/skills — skill packs (extension/skills/<id>/SKILL.md). */
static void api_skills(int fd) { md_catalog(fd, "skills", "SKILL.md", "skills"); }

/* GET /api/design-systems — brand systems (extension/design-systems/<id>/DESIGN.md). */
static void api_design_systems(int fd) { md_catalog(fd, "design-systems", "DESIGN.md", "designSystems"); }

/* GET /api/craft — universal craft rule packs (extension/craft/<id>/CRAFT.md). */
static void api_craft(int fd) { md_catalog(fd, "craft", "CRAFT.md", "craft"); }

/* ---- user-authored skills (created/edited from the web UI gear; the agent has NO
 * preset skills — these are the user's own) ----------------------------------------
 * Stored writable as <user_skills_dir>/<id>/SKILL.md. The on-demand skill() tool and the
 * catalog read them like shipped packs (user dir takes precedence). */

/* GET /api/user-skills — list the user's skills (id, name, description; no body). */
static void api_user_skills(int fd) {
    char body[16384];
    int o = snprintf(body, sizeof body, "{\"ok\":true,\"skills\":[");
    int n = 0;
    char dir[1100];
    user_skills_dir(dir, sizeof dir);
    DIR *d = opendir(dir);
    if (d) {
        struct dirent *de;
        while ((de = readdir(d)) != NULL && o < (int)sizeof body - 1400) {
            const char *id = de->d_name;
            if (id[0] == '.' || !skill_id_ok(id)) continue;
            char md[1600];
            snprintf(md, sizeof md, "%s/%s/SKILL.md", dir, id);
            size_t len = 0;
            char *content = jsonl_read_file(md, &len);
            if (!content) continue;
            char nm[300], desc[600];
            fm_field(content, "name", nm, sizeof nm);
            fm_field(content, "description", desc, sizeof desc);
            free(content);
            if (!nm[0]) cstr_copy(nm, sizeof nm, id);
            char ide[200], nme[400], dse[1200];
            json_escape_into(ide, sizeof ide, id, strlen(id));
            json_escape_into(nme, sizeof nme, nm, strlen(nm));
            json_escape_into(dse, sizeof dse, desc, strlen(desc));
            o += snprintf(body + o, sizeof body - o,
                "%s{\"id\":\"%s\",\"name\":\"%s\",\"description\":\"%s\"}", n++ ? "," : "", ide, nme, dse);
        }
        closedir(d);
    }
    snprintf(body + o, sizeof body - o, "]}");
    send_json(fd, "200 OK", body);
}

/* GET /api/user-skills/get?id=<id> — one skill's name/description/body, for the editor. */
static void api_user_skill_get(int fd, const char *path) {
    char id[64] = {0};
    const char *q = strstr(path, "id=");
    if (q) { q += 3; size_t i = 0; while (q[i] && q[i] != '&' && i < sizeof id - 1) { id[i] = q[i]; i++; } id[i] = '\0'; }
    if (!skill_id_ok(id)) { send_json(fd, "400 Bad Request", "{\"ok\":false,\"error\":\"bad id\"}"); return; }
    char dir[1100], md[1300];
    user_skills_dir(dir, sizeof dir);
    snprintf(md, sizeof md, "%s/%s/SKILL.md", dir, id);
    size_t len = 0;
    char *content = jsonl_read_file(md, &len);
    if (!content) { send_json(fd, "404 Not Found", "{\"ok\":false,\"error\":\"no such skill\"}"); return; }
    char nm[200], desc[600];
    fm_field(content, "name", nm, sizeof nm);
    fm_field(content, "description", desc, sizeof desc);
    /* body = everything after the closing frontmatter "---" line; else the whole file. */
    const char *b = content;
    if (!strncmp(content, "---", 3)) {
        const char *e = strstr(content + 3, "\n---");
        if (e) { b = e + 4; while (*b == '\n' || *b == '\r') b++; }
    }
    size_t blen = strlen(b);
    char *be = malloc(blen * 6 + 16);
    char nme[400], dse[1200];
    json_escape_into(nme, sizeof nme, nm[0] ? nm : id, strlen(nm[0] ? nm : id));
    json_escape_into(dse, sizeof dse, desc, strlen(desc));
    if (be) json_escape_into(be, blen * 6 + 16, b, blen);
    char *out = malloc(blen * 6 + 2048);
    if (out) {
        snprintf(out, blen * 6 + 2048,
            "{\"ok\":true,\"id\":\"%s\",\"name\":\"%s\",\"description\":\"%s\",\"body\":\"%s\"}",
            id, nme, dse, be ? be : "");
        send_json(fd, "200 OK", out);
        free(out);
    } else send_json(fd, "500 Internal Server Error", "{\"ok\":false}");
    free(be); free(content);
}

/* POST /api/user-skills {id,name,description,body} — create or overwrite a user skill. */
static void api_user_skill_save(int fd, const char *reqbody) {
    char id[64] = {0}, name[256] = {0}, desc[600] = {0};
    static char skbody[32768];
    json_get_string(reqbody, "id", id, sizeof id);
    if (!skill_id_ok(id)) { send_json(fd, "400 Bad Request", "{\"ok\":false,\"error\":\"id must be a-z, 0-9, -\"}"); return; }
    json_get_string(reqbody, "name", name, sizeof name);
    json_get_string(reqbody, "description", desc, sizeof desc);
    if (!json_get_string(reqbody, "body", skbody, sizeof skbody)) skbody[0] = '\0';
    if (!name[0]) snprintf(name, sizeof name, "%s", id);
    /* frontmatter is line-based: keep name/description single-line. */
    for (char *p = name; *p; p++) if (*p == '\n' || *p == '\r') *p = ' ';
    for (char *p = desc; *p; p++) if (*p == '\n' || *p == '\r') *p = ' ';
    char dir[1100], sub[1200], md[1300];
    user_skills_dir(dir, sizeof dir);
    snprintf(sub, sizeof sub, "%s/%s", dir, id);
    mkpath(sub);
    snprintf(md, sizeof md, "%s/SKILL.md", sub);
    static char filebuf[40000];
    int fo = snprintf(filebuf, sizeof filebuf,
        "---\nname: %s\ndescription: %s\nmodes: [agent]\n---\n\n%s\n", name, desc, skbody);
    if (fo < 0 || !jsonl_write_file(md, filebuf, (size_t)fo)) {
        send_json(fd, "500 Internal Server Error", "{\"ok\":false,\"error\":\"could not write the skill\"}");
        return;
    }
    char out[260];
    char ide[200];
    json_escape_into(ide, sizeof ide, id, strlen(id));
    snprintf(out, sizeof out, "{\"ok\":true,\"id\":\"%s\"}", ide);
    send_json(fd, "200 OK", out);
}

/* POST /api/user-skills/delete {id} — remove a user skill. */
static void api_user_skill_delete(int fd, const char *reqbody) {
    char id[64] = {0};
    json_get_string(reqbody, "id", id, sizeof id);
    if (!skill_id_ok(id)) { send_json(fd, "400 Bad Request", "{\"ok\":false,\"error\":\"bad id\"}"); return; }
    char dir[1100], md[1300], sub[1200];
    user_skills_dir(dir, sizeof dir);
    snprintf(md, sizeof md, "%s/%s/SKILL.md", dir, id);
    snprintf(sub, sizeof sub, "%s/%s", dir, id);
    unlink(md);
    rmdir(sub);
    if (!strcmp(g_skill, id)) g_skill[0] = '\0';   /* deselect if it was active */
    send_json(fd, "200 OK", "{\"ok\":true}");
}

static void parse_cfg(const char *body, engine_cfg *cfg, int *bad) {
    long v;
    int m = json_get_model(body, model_present(1) ? 1 : 0);
    if (m < 0) { *bad = 1; m = ENGINE_DEFAULTS.uncensored; }
    cfg->uncensored = m;
    int r;
    r = json_get_int(body, "port", 1024, 65535, &v);     if (r < 0) *bad = 1; else if (r) cfg->port = (int)v;
    r = json_get_int(body, "ctx", 1024, 1048576, &v);    if (r < 0) *bad = 1; else if (r) cfg->ctx = (int)v;
    r = json_get_int(body, "power", 1, 100, &v);         if (r < 0) *bad = 1; else if (r) cfg->power = (int)v;
    r = json_get_int(body, "kvSpaceMb", 256, 262144, &v);if (r < 0) *bad = 1; else if (r) cfg->kv_space_mb = (int)v;
    r = json_get_int(body, "kvMinTokens", 1, 100000, &v);if (r < 0) *bad = 1; else if (r) cfg->kv_min_tok = (int)v;
    /* think level: chat-style selector in the agent/design composer.
     * "off"/"none"/"nothink" -> 0, "high"/"think"/"on" -> 1, "max"/"think-max" -> 2. */
    char think[16];
    if (json_get_string(body, "think", think, sizeof think) && think[0]) {
        if (!strcmp(think, "off") || !strcmp(think, "none") || !strcmp(think, "nothink"))
            cfg->think = 0;
        else if (!strcmp(think, "max") || !strcmp(think, "think-max"))
            cfg->think = 2;
        else
            cfg->think = 1; /* high / think / on */
    }
}

static int remote_value_safe(const char *s) {
    if (!s || !s[0]) return 0;
    for (const char *p = s; *p; p++) {
        unsigned char c = (unsigned char)*p;
        if (c <= 0x20 || c == '"' || c == '\'' || c == '\\') return 0;
    }
    return 1;
}

static int parse_remote_start(const char *body, int allow, char *err, size_t errsz) {
    char backend[32] = "";
    char base[1024] = "";
    char model[128] = "ds4";
    json_get_string(body, "modelBackend", backend, sizeof backend);
    json_get_string(body, "remoteBaseUrl", base, sizeof base);
    json_get_string(body, "remoteModel", model, sizeof model);
    int lan_client = json_get_bool(body, "lanClient");
    int enabled = !strcmp(backend, "remote") || base[0];
    if (!enabled) {
        if (allow && lan_client) {
            snprintf(err, errsz, "LAN client Agent/Design requires a remote model host");
            return 0;
        }
        g_remote_base_url[0] = '\0';
        g_remote_model[0] = '\0';
        return 1;
    }
    if (!allow) {
        snprintf(err, errsz, "remote model backend is only valid for agent/design");
        return 0;
    }
    if (strcmp(backend, "remote") && backend[0]) {
        snprintf(err, errsz, "modelBackend must be remote or local");
        return 0;
    }
    if (!base[0]) {
        snprintf(err, errsz, "remoteBaseUrl is required");
        return 0;
    }
    if (strncmp(base, "http://", 7) != 0 || !remote_value_safe(base)) {
        snprintf(err, errsz, "remoteBaseUrl must be a safe http:// LAN URL");
        return 0;
    }
    if (!model[0]) snprintf(model, sizeof model, "ds4");
    if (!remote_value_safe(model) || strlen(model) >= sizeof g_remote_model) {
        snprintf(err, errsz, "remoteModel is invalid");
        return 0;
    }
    snprintf(g_remote_base_url, sizeof g_remote_base_url, "%s", base);
    snprintf(g_remote_model, sizeof g_remote_model, "%s", model);
    return 1;
}

static void api_start(int fd, const char *body) {
    char mode[16] = "server";
    json_get_string(body, "mode", mode, sizeof mode);
    int want_agent = !strcmp(mode, "agent");
    int want_design = !strcmp(mode, "design");
    if (!want_agent && !want_design && strcmp(mode, "server")) {
        send_json(fd, "400 Bad Request", "{\"ok\":false,\"error\":\"mode must be server, agent or design\"}");
        return;
    }

    engine_cfg cfg = ENGINE_DEFAULTS;
    int bad = 0;
    parse_cfg(body, &cfg, &bad);
    if (bad) {
        send_json(fd, "400 Bad Request", "{\"ok\":false,\"error\":\"parameters out of range\"}");
        return;
    }

    char remote_err[256] = "";
    if (!parse_remote_start(body, want_agent || want_design, remote_err, sizeof remote_err)) {
        char out[512], esc[384];
        json_escape_into(esc, sizeof esc, remote_err, strlen(remote_err));
        snprintf(out, sizeof out, "{\"ok\":false,\"error\":\"%s\"}", esc);
        send_json(fd, "400 Bad Request", out);
        return;
    }

    char workdir[1024] = "";
    json_get_string(body, "workdir", workdir, sizeof workdir);
    int force = json_get_bool(body, "force");
    /* Whether to try the jsonl patch (default on if the key is absent). */
    g_use_jsonl = strstr(body, "\"jsonl\"") ? json_get_bool(body, "jsonl") : 1;
    if (g_remote_base_url[0]) g_use_jsonl = 1;

    /* Model variant ("flash"|"pro") — picked in the composer. Default stays. */
    char variant[16] = {0};
    json_get_string(body, "variant", variant, sizeof variant);
    if (!strcmp(variant, "flash") || !strcmp(variant, "pro")) {
        snprintf(g_variant, sizeof g_variant, "%s", variant);
        g_model_override[0] = '\0';   /* a variant choice drops any explicit gguf */
    }
    /* Explicit GGUF pick (path relative to the ds4 dir) wins over the variant. */
    char gguf[1024] = {0};
    if (json_get_string(body, "gguf", gguf, sizeof gguf) && gguf[0] && !strstr(gguf, "..") && file_present(gguf))
        snprintf(g_model_override, sizeof g_model_override, "%s", gguf);

    /* Active skill for agent/design (extension/skills/<id>): injected as -sys at spawn.
     * Empty or "none" clears it; an unknown/invalid id is ignored (falls back to the
     * charter only). The key may be absent — then the previous choice is kept. */
    char skill[64] = {0};
    if (json_get_string(body, "skill", skill, sizeof skill)) {
        if (!skill[0] || !strcmp(skill, "none")) g_skill[0] = '\0';
        else if (skill_id_ok(skill)) snprintf(g_skill, sizeof g_skill, "%s", skill);
    }

    /* Active design-system (brand) for design mode (extension/design-systems/<id>):
     * injected as -sys at spawn alongside the skill. Same sanitising as the skill. */
    char ds[64] = {0};
    if (json_get_string(body, "designSystem", ds, sizeof ds)) {
        if (!ds[0] || !strcmp(ds, "none")) g_design_system[0] = '\0';
        else if (skill_id_ok(ds)) snprintf(g_design_system, sizeof g_design_system, "%s", ds);
    }

    /* Build mode (planned): on/off. The web UI sends "plan"/"on" or "off".
     * On also remembers the workspace so the driver's /api/build endpoints
     * (plan.md, file listing) target the right folder. */
    if (strstr(body, "\"build\"")) {
        char bv[16] = "";
        json_get_string(body, "build", bv, sizeof bv);
        if (!strcmp(bv, "plan") || !strcmp(bv, "on")) g_build_mode = 2;
        else                                          g_build_mode = 0;
        if (g_build_mode && (want_agent || want_design) && workdir[0])
            snprintf(g_build_dir, sizeof g_build_dir, "%s", workdir);
    }

    if (g_child > 0) stop_child();

    /* After stopping our own child, anything still on the engine port is an
     * EXTERNAL ds4-server (started outside the launcher). The instance-lock
     * forbids two large processes, so we cannot start agent/design (and a
     * server start would collide too). Without `force` we report a structured
     * error so the UI can offer "kill it & restart"; with `force` we free the
     * port first. */
    if (port_listening(ENGINE_DEFAULTS.port)) {
        if (!force) {
            char out[320];
            snprintf(out, sizeof out,
                "{\"ok\":false,\"code\":\"external_server\",\"port\":%d,"
                "\"error\":\"a ds4-server is running outside the launcher (port %d). "
                "Stop it to free the instance-lock, or let the launcher restart it.\"}",
                ENGINE_DEFAULTS.port, ENGINE_DEFAULTS.port);
            send_json(fd, "409 Conflict", out);
            return;
        }
        if (!kill_external_server(ENGINE_DEFAULTS.port)) {
            send_json(fd, "409 Conflict",
                "{\"ok\":false,\"error\":\"could not free the engine port — stop the external ds4-server manually\"}");
            return;
        }
    }

    char err[256] = "";
    int ok = want_agent ? spawn_agent(&cfg, workdir, err, sizeof err)
           : want_design ? spawn_design(&cfg, workdir, err, sizeof err)
                         : spawn_server(&cfg, err, sizeof err);
    if (!ok) {
        char out[512];
        snprintf(out, sizeof out, "{\"ok\":false,\"error\":\"%s\"}", err);
        send_json(fd, "409 Conflict", out);
        return;
    }
    char out[128];
    snprintf(out, sizeof out, "{\"ok\":true,\"mode\":\"%s\"}", mode_name(g_mode));
    send_json(fd, "200 OK", out);
}

static void api_stop(int fd) {
    reap_child();
    if (g_child <= 0) {
        send_json(fd, "409 Conflict", "{\"ok\":false,\"error\":\"no engine started by DStudio\"}");
        return;
    }
    stop_child();
    send_json(fd, "200 OK", "{\"ok\":true}");
}

static void api_agent_send(int fd, const char *body) {
    if (!MODE_IS_PIPED(g_mode) || g_in_fd < 0) {
        send_json(fd, "409 Conflict", "{\"ok\":false,\"error\":\"agent not active\"}");
        return;
    }
    if (!g_ready) {
        send_json(fd, "409 Conflict", "{\"ok\":false,\"error\":\"agent still loading\"}");
        return;
    }
    static char prompt[BODY_MAX];
    if (!json_get_string(body, "prompt", prompt, sizeof prompt) || !prompt[0]) {
        send_json(fd, "400 Bad Request", "{\"ok\":false,\"error\":\"prompt missing\"}");
        return;
    }
    size_t len = strlen(prompt);
    /* Echo of the prompt into the transcript, marked, so the UI shows it right
     * away. The literals are SPLIT because \x is greedy on hex: "\x01E" would be
     * read as 0x1E. "\x01" "USER" keeps 0x01 separate from 'U'/'E'. */
    agent_buf_append("\x01" "USER\x02", 6);
    agent_buf_append(prompt, len);
    agent_buf_append("\x01" "ENDUSER\x02\n", 10);
    /* send on the agent's stdin + newline as turn terminator */
    if (write(g_in_fd, prompt, len) < 0 || write(g_in_fd, "\n", 1) < 0) {
        send_json(fd, "500 Internal Server Error", "{\"ok\":false,\"error\":\"write to agent failed\"}");
        return;
    }
    g_agent_working = 1;
    g_ready = 1;
    char out[64];
    snprintf(out, sizeof out, "{\"ok\":true,\"at\":%zu}", g_alen);
    send_json(fd, "200 OK", out);
}

/* POST /api/agent/interrupt — abort the current agent/design turn (the UI
 * deleted the conversation that owns the live generation). Sends SIGINT to the
 * piped child; the non-interactive loop catches it (jsonl patch) and returns the
 * worker to idle WITHOUT killing the engine, so the next prompt still works. */
static void api_agent_interrupt(int fd) {
    if (!MODE_IS_PIPED(g_mode) || g_child <= 0) {
        send_json(fd, "409 Conflict", "{\"ok\":false,\"error\":\"agent not active\"}");
        return;
    }
#ifdef _WIN32
    if (g_child_win_pid) GenerateConsoleCtrlEvent(CTRL_BREAK_EVENT, g_child_win_pid);
#else
    kill(g_child, SIGINT);
#endif
    g_agent_working = 0; /* the WAITING marker will reconfirm; clear early so the UI does not flicker */
    send_json(fd, "200 OK", "{\"ok\":true}");
}

/* Engine session commands (agent AND design): routes {action, sha?} as a
 * slash command ("/save", "/list", "/switch <sha>", "/del <sha>", "/new")
 * onto the child's stdin, like api_agent_send. Both pipe children dispatch
 * slash commands (jsonl patch v3); the response (design: sessions event,
 * agent: plain status line) comes back on the /api/agent/poll stream. Used
 * e.g. to delete the KV session when its conversation is deleted in the UI. */
static void api_design_session(int fd, const char *body) {
    if ((g_mode != ENGINE_DESIGN && g_mode != ENGINE_AGENT) || g_in_fd < 0) {
        send_json(fd, "409 Conflict", "{\"ok\":false,\"error\":\"agent/design not active\"}");
        return;
    }
    if (!g_ready) {
        send_json(fd, "409 Conflict", "{\"ok\":false,\"error\":\"engine still loading\"}");
        return;
    }
    char action[24] = {0};
    if (!json_get_string(body, "action", action, sizeof action) || !action[0]) {
        send_json(fd, "400 Bad Request", "{\"ok\":false,\"error\":\"action missing\"}");
        return;
    }
    /* optional sha: sanitized to hex only (max 40) so it cannot inject
     * newlines/spaces and therefore a second command on the pipe. */
    char sha_raw[96] = {0}, sha[41] = {0};
    json_get_string(body, "sha", sha_raw, sizeof sha_raw);
    size_t sn = 0;
    for (size_t i = 0; sha_raw[i] && sn < sizeof(sha) - 1; i++) {
        char c = sha_raw[i];
        if ((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F'))
            sha[sn++] = c;
    }
    sha[sn] = '\0';

    char cmd[80];
    if (!strcmp(action, "save"))        snprintf(cmd, sizeof cmd, "/save");
    else if (!strcmp(action, "list"))   snprintf(cmd, sizeof cmd, "/list");
    else if (!strcmp(action, "new"))    snprintf(cmd, sizeof cmd, "/new");
    else if (!strcmp(action, "switch")) {
        if (!sha[0]) { send_json(fd, "400 Bad Request", "{\"ok\":false,\"error\":\"sha missing\"}"); return; }
        snprintf(cmd, sizeof cmd, "/switch %s", sha);
    } else if (!strcmp(action, "del")) {
        if (!sha[0]) { send_json(fd, "400 Bad Request", "{\"ok\":false,\"error\":\"sha missing\"}"); return; }
        snprintf(cmd, sizeof cmd, "/del %s", sha);
    } else {
        send_json(fd, "400 Bad Request", "{\"ok\":false,\"error\":\"unknown action\"}");
        return;
    }

    /* One atomic write (cmd + newline): two concurrent session requests must
     * not interleave their bytes on the pipe — "/list/list\n\n" is garbage. */
    char out[96];
    int olen = snprintf(out, sizeof out, "%s\n", cmd);
    if (olen < 0 || olen >= (int)sizeof out || write(g_in_fd, out, (size_t)olen) < 0) {
        send_json(fd, "500 Internal Server Error", "{\"ok\":false,\"error\":\"write to engine failed\"}");
        return;
    }
    send_json(fd, "200 OK", "{\"ok\":true}");
}

/* ==================== agent SSE stream ====================
 * Same payload as the poll, PUSHED: GET /api/agent/poll?since=N&stream=1
 * answers text/event-stream and the fd is adopted by this registry; the main
 * loop flushes new buffer data / working flips as they happen (the pipe wakes
 * poll() immediately → chat-like latency instead of the 500ms poll cadence).
 * A client that stalls or errors is dropped: the UI falls back to polling,
 * and the absolute offsets keep continuity either way. */
#define SSE_MAX 8
static int    g_sse_fd[SSE_MAX];
static size_t g_sse_since[SSE_MAX];
static int    g_sse_working[SSE_MAX];
static int    g_sse_n = 0;
static int    g_sse_tick = 0;
static int    g_sse_adopt = 0;   /* set when the current request fd moves here */

static void sse_drop(int i) {
    close(g_sse_fd[i]);
    g_sse_fd[i] = g_sse_fd[g_sse_n - 1];
    g_sse_since[i] = g_sse_since[g_sse_n - 1];
    g_sse_working[i] = g_sse_working[g_sse_n - 1];
    g_sse_n--;
}

static void sse_close_all(void) { while (g_sse_n) sse_drop(0); }
static void sse_close_all_fwd(void) { sse_close_all(); }

/* One event with the SAME JSON shape as the poll response. */
static int sse_send_chunk(int fd, size_t *since, int *last_working) {
    size_t from = *since;
    if (from < g_abase) from = g_abase;
    if (from > g_alen) from = g_alen;
    size_t avail = g_alen - from;
    size_t cap = avail * 6 + 512;
    char *out = malloc(cap + 16);
    if (!out) return -1;
    int hn = snprintf(out, cap,
        "data: {\"base\":%zu,\"len\":%zu,\"working\":%s,\"ready\":%s,\"loadPct\":%d,\"text\":\"",
        g_abase, g_alen, g_agent_working ? "true" : "false",
        g_ready ? "true" : "false", g_load_pct);
    size_t o = (size_t)hn;
    if (avail) o += json_escape_into(out + o, cap - o, g_abuf + (from - g_abase), avail);
    o += (size_t)snprintf(out + o, cap + 16 - o, "\"}\n\n");
    ssize_t w = write(fd, out, o);
    free(out);
    if (w != (ssize_t)o) return -1;  /* partial/EAGAIN/EPIPE: drop, the UI re-syncs */
    *since = g_alen;
    *last_working = g_agent_working;
    return 0;
}

/* Push pending data / state changes; periodic heartbeat detects dead peers. */
static void sse_flush(void) {
    int beat = (++g_sse_tick % 75) == 0;   /* ~15s with the 200ms loop tick */
    for (int i = 0; i < g_sse_n; ) {
        int dirty = g_sse_since[i] != g_alen ||
                    g_sse_working[i] != g_agent_working;
        if (dirty) {
            if (sse_send_chunk(g_sse_fd[i], &g_sse_since[i], &g_sse_working[i]) != 0) {
                sse_drop(i);
                continue;
            }
        } else if (beat) {
            if (write(g_sse_fd[i], ": ping\n\n", 8) != 8) { sse_drop(i); continue; }
        }
        i++;
    }
}

static void api_agent_poll(int fd, const char *path) {
    /* since= absolute offset requested by the client */
    size_t since = 0;
    const char *q = strstr(path, "since=");
    if (q) since = (size_t)strtoul(q + 6, NULL, 10);
    if (since < g_abase) since = g_abase;            /* the client was behind: realign */
    if (since > g_alen) since = g_alen;

    /* stream=1 → SSE: adopt the fd, the main loop will push from now on. */
    if (strstr(path, "stream=1")) {
        if (g_sse_n >= SSE_MAX) {
            send_json(fd, "503 Service Unavailable", "{\"ok\":false,\"error\":\"too many streams\"}");
            return;
        }
        const char *hdr = "HTTP/1.1 200 OK\r\n"
                          "Content-Type: text/event-stream\r\n"
                          "Cache-Control: no-cache\r\n"
                          "Connection: keep-alive\r\n\r\n";
        if (write(fd, hdr, strlen(hdr)) != (ssize_t)strlen(hdr)) return; /* closed by caller */
        int fl = fcntl(fd, F_GETFL, 0);
        if (fl >= 0) fcntl(fd, F_SETFL, fl | O_NONBLOCK);
        g_sse_fd[g_sse_n] = fd;
        g_sse_since[g_sse_n] = since;
        g_sse_working[g_sse_n] = -1;   /* force the initial snapshot event */
        g_sse_n++;
        sse_flush();
        g_sse_adopt = 1;
        return;
    }

    size_t avail = g_alen - since;
    /* JSON-escape the requested segment into a response buffer */
    size_t cap = avail * 6 + 512;
    char *out = malloc(cap);
    if (!out) { send_json(fd, "500 Internal Server Error", "{\"ok\":false}"); return; }
    int hn = snprintf(out, cap,
        "{\"base\":%zu,\"len\":%zu,\"working\":%s,\"ready\":%s,\"loadPct\":%d,\"text\":\"",
        g_abase, g_alen, g_agent_working ? "true" : "false",
        g_ready ? "true" : "false", g_load_pct);
    size_t o = (size_t)hn;
    if (avail) o += json_escape_into(out + o, cap - o, g_abuf + (since - g_abase), avail);
    o += (size_t)snprintf(out + o, cap - o, "\"}");
    send_response(fd, "200 OK", "application/json; charset=utf-8", out, o, 0);
    free(out);
}

/* ==================== design: project and workspace ==================== */
/* The design workspace is a PROJECT DIR of free files:
 * the UI shows the list as tabs and renders the files in an iframe. serve acts
 * only as a sandboxed reader: relative paths validated, never free paths. */

/* Minimal dynamic buffer for responses whose length is not known in advance. */
typedef struct { char *ptr; size_t len; size_t cap; } design_buf_t;

static void dbuf_puts(design_buf_t *b, const char *s) {
    size_t n = strlen(s);
    if (b->len + n + 1 > b->cap) {
        size_t cap = b->cap ? b->cap * 2 : 4096;
        while (cap < b->len + n + 1) cap *= 2;
        char *np = realloc(b->ptr, cap);
        if (!np) return; /* truncated but valid response: better than a crash */
        b->ptr = np;
        b->cap = cap;
    }
    memcpy(b->ptr + b->len, s, n);
    b->len += n;
    b->ptr[b->len] = '\0';
}

static void api_design_status(int fd) {
    char wd_esc[1100];
    json_escape_into(wd_esc, sizeof wd_esc, g_design_dir, strlen(g_design_dir));
    char body[1300];
    snprintf(body, sizeof body, "{\"ok\":true,\"workdir\":\"%s\",\"running\":%s}",
             wd_esc, g_mode == ENGINE_DESIGN && g_child > 0 ? "true" : "false");
    send_json(fd, "200 OK", body);
}

/* Same validation as the ds4-design tool-layer: relative, no "..",
 * no absolutes, no control bytes or backslashes. */
static int design_rel_path_ok(const char *rel) {
    if (!rel || !rel[0] || rel[0] == '/' || rel[0] == '~') return 0;
    size_t len = strlen(rel);
    if (len > 512) return 0;
    for (size_t i = 0; i < len; i++) {
        unsigned char c = (unsigned char)rel[i];
        if (c < 0x20 || c == '\\') return 0;
    }
    const char *p = rel;
    while (*p) {
        const char *seg = p;
        while (*p && *p != '/') p++;
        size_t seglen = (size_t)(p - seg);
        if (seglen == 0 || (seglen == 1 && seg[0] == '.') ||
            (seglen == 2 && seg[0] == '.' && seg[1] == '.'))
            return 0;
        if (*p == '/') p++;
    }
    return 1;
}

/* Decode %XX of a query string value (the rest stays as is). */
static void url_decode_into(const char *src, size_t n, char *out, size_t outsz) {
    size_t o = 0;
    for (size_t i = 0; i < n && o + 1 < outsz; i++) {
        if (src[i] == '%' && i + 2 < n && isxdigit((unsigned char)src[i+1]) &&
            isxdigit((unsigned char)src[i+2])) {
            char hx[3] = { src[i+1], src[i+2], 0 };
            out[o++] = (char)strtol(hx, NULL, 16);
            i += 2;
        } else {
            out[o++] = src[i];
        }
    }
    out[o] = '\0';
}

/* Recursive listing of the project files as JSON (depth and count
 * bounded: a design project dir holds dozens of files, not thousands). */
static void design_files_json(design_buf_t *b, const char *base, const char *rel,
                              int depth, int *count) {
    if (depth > 3 || *count > 200) return;
    char full[2048];
    snprintf(full, sizeof full, "%s%s%s", base, rel[0] ? "/" : "", rel);
    DIR *d = opendir(full);
    if (!d) return;
    struct dirent *de;
    while ((de = readdir(d)) != NULL && *count <= 200) {
        if (de->d_name[0] == '.') continue;
        char child_rel[1024];
        snprintf(child_rel, sizeof child_rel, "%s%s%s",
                 rel, rel[0] ? "/" : "", de->d_name);
        char child_full[2048];
        snprintf(child_full, sizeof child_full, "%s/%s", base, child_rel);
        struct stat st;
        if (lstat(child_full, &st) != 0) continue;
        if (S_ISDIR(st.st_mode)) {
            design_files_json(b, base, child_rel, depth + 1, count);
        } else if (S_ISREG(st.st_mode)) {
            char esc[2100];
            json_escape_into(esc, sizeof esc, child_rel, strlen(child_rel));
            char item[2400];
            snprintf(item, sizeof item, "%s{\"name\":\"%s\",\"size\":%lld,\"mtime\":%lld}",
                     *count ? "," : "", esc, (long long)st.st_size,
                     (long long)st.st_mtime);
            dbuf_puts(b, item);
            (*count)++;
        }
    }
    closedir(d);
}

static void api_design_files(int fd) {
    design_buf_t b = {0};
    char wd_esc[1100];
    json_escape_into(wd_esc, sizeof wd_esc, g_design_dir, strlen(g_design_dir));
    char head[1300];
    snprintf(head, sizeof head, "{\"ok\":true,\"workdir\":\"%s\",\"running\":%s,\"files\":[",
             wd_esc, g_mode == ENGINE_DESIGN && g_child > 0 ? "true" : "false");
    dbuf_puts(&b, head);
    int count = 0;
    if (g_design_dir[0]) design_files_json(&b, g_design_dir, "", 0, &count);
    dbuf_puts(&b, "]}");
    send_response(fd, "200 OK", "application/json; charset=utf-8",
                  b.ptr ? b.ptr : "{}", b.len, 0);
    free(b.ptr);
}

static long design_line_seq(const char *line) {
    const char *p = strstr(line, "\"seq\"");
    if (!p) return -1;
    p += 5;
    while (*p && (*p == ' ' || *p == '\t' || *p == ':')) p++;
    if (!isdigit((unsigned char)*p)) return -1;
    return strtol(p, NULL, 10);
}

static char *read_small_file(const char *path, size_t max, size_t *len_out) {
    FILE *f = fopen(path, "rb");
    if (!f) return NULL;
    if (fseek(f, 0, SEEK_END) != 0) { fclose(f); return NULL; }
    long sz = ftell(f);
    if (sz < 0 || (size_t)sz > max) { fclose(f); return NULL; }
    rewind(f);
    char *buf = malloc((size_t)sz + 1);
    if (!buf) { fclose(f); return NULL; }
    size_t got = fread(buf, 1, (size_t)sz, f);
    fclose(f);
    if (got != (size_t)sz) { free(buf); return NULL; }
    buf[got] = '\0';
    if (len_out) *len_out = got;
    return buf;
}

static void api_design_events(int fd, const char *path) {
    long since = 0;
    const char *q = strstr(path, "since=");
    if (q) since = strtol(q + 6, NULL, 10);
    design_buf_t b = {0};
    dbuf_puts(&b, "{\"ok\":true,\"events\":[");
    int count = 0;
    if (g_design_dir[0]) {
        char hist[2048];
        snprintf(hist, sizeof hist, "%s/.ds4-design/history.jsonl", g_design_dir);
        FILE *f = fopen(hist, "rb");
        if (f) {
            char line[65536];
            while (fgets(line, sizeof line, f)) {
                size_t n = strlen(line);
                if (!n || line[n - 1] != '\n') continue; /* ignore partial tail */
                long seq = design_line_seq(line);
                if (seq <= since) continue;
                line[n - 1] = '\0';
                if (count) dbuf_puts(&b, ",");
                dbuf_puts(&b, line);
                count++;
                if (count >= 500) break;
            }
            fclose(f);
        }
    }
    dbuf_puts(&b, "]}");
    send_response(fd, "200 OK", "application/json; charset=utf-8",
                  b.ptr ? b.ptr : "{\"ok\":true,\"events\":[]}", b.len, 0);
    free(b.ptr);
}

static void api_design_state(int fd) {
    if (!g_design_dir[0]) {
        send_json(fd, "200 OK", "{\"ok\":true,\"state\":{\"schema\":\"ds4.design.state.v1\",\"seq\":0,\"phase\":\"idle\",\"todos\":[],\"todosHaveInProgress\":false}}");
        return;
    }
    char path[2048];
    snprintf(path, sizeof path, "%s/.ds4-design/state.json", g_design_dir);
    size_t len = 0;
    char *state = read_small_file(path, 1024 * 1024, &len);
    if (!state) {
        send_json(fd, "200 OK", "{\"ok\":true,\"state\":{\"schema\":\"ds4.design.state.v1\",\"seq\":0,\"phase\":\"idle\",\"todos\":[],\"todosHaveInProgress\":false}}");
        return;
    }
    design_buf_t b = {0};
    dbuf_puts(&b, "{\"ok\":true,\"state\":");
    dbuf_puts(&b, state);
    dbuf_puts(&b, "}");
    send_response(fd, "200 OK", "application/json; charset=utf-8", b.ptr, b.len, 0);
    free(state);
    free(b.ptr);
}

static void api_design_artifacts(int fd) {
    design_buf_t b = {0};
    dbuf_puts(&b, "{\"ok\":true,\"artifacts\":[");
    int count = 0;
    if (g_design_dir[0]) {
        char dir[2048];
        snprintf(dir, sizeof dir, "%s/.ds4-design/artifacts", g_design_dir);
        DIR *d = opendir(dir);
        if (d) {
            struct dirent *de;
            while ((de = readdir(d)) != NULL && count < 500) {
                if (de->d_name[0] == '.') continue;
                size_t nl = strlen(de->d_name);
                if (nl < 6 || strcmp(de->d_name + nl - 5, ".json")) continue;
                char file[12288];
                snprintf(file, sizeof file, "%s/%s", dir, de->d_name);
                size_t len = 0;
                char *m = read_small_file(file, 1024 * 1024, &len);
                if (!m) continue;
                if (count) dbuf_puts(&b, ",");
                dbuf_puts(&b, m);
                free(m);
                count++;
            }
            closedir(d);
        }
    }
    dbuf_puts(&b, "]}");
    send_response(fd, "200 OK", "application/json; charset=utf-8",
                  b.ptr ? b.ptr : "{\"ok\":true,\"artifacts\":[]}", b.len, 0);
    free(b.ptr);
}

static const char *design_content_type(const char *name);   /* defined below */

/* ---- Build mode (planned) workspace endpoints -------------------------------
 * The Build driver (web UI) persists plan.md / STYLE.md into the build workspace
 * and reads back the file list to track progress DETERMINISTICALLY from disk —
 * "step done" = the expected file exists, never the model's say-so. All target
 * g_build_dir (captured when a build engine started). The write sits behind the
 * same anti-CSRF header as every other POST. */

static void api_build_files(int fd) {
    design_buf_t b = {0};
    char wd_esc[1100];
    json_escape_into(wd_esc, sizeof wd_esc, g_build_dir, strlen(g_build_dir));
    char head[1300];
    snprintf(head, sizeof head, "{\"ok\":true,\"workdir\":\"%s\",\"build\":%d,\"files\":[",
             wd_esc, g_build_mode);
    dbuf_puts(&b, head);
    int count = 0;
    if (g_build_dir[0]) design_files_json(&b, g_build_dir, "", 0, &count);
    dbuf_puts(&b, "]}");
    send_response(fd, "200 OK", "application/json; charset=utf-8",
                  b.ptr ? b.ptr : "{}", b.len, 0);
    free(b.ptr);
}

static void api_build_file(int fd, const char *path, int head_only) {
    if (!g_build_dir[0]) { send_text(fd, "404 Not Found", "no build workspace\n", head_only); return; }
    const char *q = strstr(path, "name=");
    if (!q) { send_text(fd, "400 Bad Request", "name missing\n", head_only); return; }
    q += 5;
    size_t qlen = strcspn(q, "&");
    char name[1024];
    url_decode_into(q, qlen, name, sizeof name);
    if (!design_rel_path_ok(name)) { send_text(fd, "400 Bad Request", "invalid path\n", head_only); return; }
    char file[2048];
    snprintf(file, sizeof file, "%s/%s", g_build_dir, name);
    FILE *f = fopen(file, "rb");
    if (!f) { send_text(fd, "404 Not Found", "file not found\n", head_only); return; }
    if (fseek(f, 0, SEEK_END) != 0) { fclose(f); send_text(fd, "500 Internal Server Error", "seek\n", head_only); return; }
    long sz = ftell(f);
    if (sz < 0 || sz > MAX_PAGE) { fclose(f); send_text(fd, "500 Internal Server Error", "file too large\n", head_only); return; }
    rewind(f);
    char *buf = malloc((size_t)sz > 0 ? (size_t)sz : 1);
    if (!buf) { fclose(f); send_text(fd, "500 Internal Server Error", "memory\n", head_only); return; }
    size_t got = fread(buf, 1, (size_t)sz, f);
    fclose(f);
    if (got != (size_t)sz) { free(buf); send_text(fd, "500 Internal Server Error", "read\n", head_only); return; }
    send_response_hdrs(fd, "200 OK", design_content_type(name), buf, got, head_only, DESIGN_HEADERS);
    free(buf);
}

/* POST /api/build/write {name, content} — write a small driver file (plan.md, STYLE.md)
 * to the build workspace ROOT. name is one safe component (no '/'); content is JSON-
 * unescaped from the body (bounded by BODY_MAX). */
static void api_build_write(int fd, const char *body) {
    if (!g_build_dir[0]) { send_json(fd, "409 Conflict", "{\"ok\":false,\"error\":\"no build workspace\"}"); return; }
    char name[256] = "";
    json_get_string(body, "name", name, sizeof name);
    if (!name[0] || strchr(name, '/') || !design_rel_path_ok(name)) {
        send_json(fd, "400 Bad Request", "{\"ok\":false,\"error\":\"invalid name\"}"); return;
    }
    char *content = malloc(BODY_MAX);
    if (!content) { send_json(fd, "500 Internal Server Error", "{\"ok\":false,\"error\":\"memory\"}"); return; }
    content[0] = '\0';
    json_get_string(body, "content", content, BODY_MAX);   /* absent → empty file */
    char file[2048];
    snprintf(file, sizeof file, "%s/%s", g_build_dir, name);
    FILE *f = fopen(file, "wb");
    if (!f) { free(content); send_json(fd, "500 Internal Server Error", "{\"ok\":false,\"error\":\"open\"}"); return; }
    size_t len = strlen(content);
    size_t wrote = fwrite(content, 1, len, f);
    int ok = (fclose(f) == 0) && (wrote == len);
    free(content);
    if (!ok) { send_json(fd, "500 Internal Server Error", "{\"ok\":false,\"error\":\"write\"}"); return; }
    char out[64];
    snprintf(out, sizeof out, "{\"ok\":true,\"bytes\":%zu}", len);
    send_json(fd, "200 OK", out);
}

/* POST /api/fs/list {path} — directory browser for the working-dir picker:
 * lists the SUBDIRECTORIES of a path (no files, no dotdirs, no .app bundles
 * — on macOS they are directories, but never a working dir). Also returns
 * "entries" = visible content count (files + dirs), so the UI can require
 * an EMPTY folder for the design workspace. Path defaults to $HOME. Same
 * trust model as /api/start (which accepts any workdir). */
/* POST /api/fs/mkdir {path} — create a folder (for the picker's "New folder").
 * The parent must exist and be a readable dir; same trust model as fs/list. */
static void api_fs_mkdir(int fd, const char *body) {
    char path[1024] = {0};
    json_get_string(body, "path", path, sizeof path);
    if (!path[0] || strstr(path, "..")) {
        send_json(fd, "400 Bad Request", "{\"ok\":false,\"error\":\"invalid path\"}");
        return;
    }
    /* parent must already exist (we only create the leaf) */
    char parent[1024];
    snprintf(parent, sizeof parent, "%s", path);
    char *sl = strrchr(parent, '/');
    if (sl && sl != parent) {
        *sl = '\0';
        struct stat ps;
        if (stat(parent, &ps) != 0 || !S_ISDIR(ps.st_mode)) {
            send_json(fd, "400 Bad Request", "{\"ok\":false,\"error\":\"parent folder not found\"}");
            return;
        }
    }
    if (mkdir(path, 0755) != 0 && errno != EEXIST) {
        char out[160];
        snprintf(out, sizeof out, "{\"ok\":false,\"error\":\"mkdir failed: %s\"}", strerror(errno));
        send_json(fd, "500 Internal Server Error", out);
        return;
    }
    char abs[DSTUDIO_PATH_MAX], esc[DSTUDIO_PATH_MAX * 2 + 1];
    if (!realpath(path, abs)) snprintf(abs, sizeof abs, "%s", path);
    json_escape_into(esc, sizeof esc, abs, strlen(abs));
    char out[DSTUDIO_PATH_MAX * 2 + 64];
    snprintf(out, sizeof out, "{\"ok\":true,\"path\":\"%s\"}", esc);
    send_json(fd, "200 OK", out);
}

/* POST /api/ds4dir {path} — point the launcher at a different ds4 directory
 * (used when the health check finds the auto-resolved one missing). Validates
 * it is a real directory, then KILLS any active ds4 (our own child plus a stray
 * ds4-server holding the engine port) and RESTARTS the same mode/config in the
 * NEW location, so the engine comes back pointed at the folder the user just
 * gave. The UI re-checks ds4dirOk and reports whether the restart succeeded. */
static void api_set_ds4dir(int fd, const char *body) {
    char path[1024] = {0};
    json_get_string(body, "path", path, sizeof path);
    if (!path[0] || strstr(path, "..")) { send_json(fd, "400 Bad Request", "{\"ok\":false,\"error\":\"invalid path\"}"); return; }
    char abs[DSTUDIO_PATH_MAX];
    struct stat st;
    if (!realpath(path, abs) || stat(abs, &st) != 0 || !S_ISDIR(st.st_mode)) {
        send_json(fd, "400 Bad Request", "{\"ok\":false,\"error\":\"not a folder\"}");
        return;
    }

    /* Remember what was running so we can bring the SAME mode back up in the
     * new location after killing it. */
    reap_child();
    int        prev_mode = g_mode;
    engine_cfg prev_cfg  = g_cfg;
    char       prev_wd[1024];
    snprintf(prev_wd, sizeof prev_wd, "%s", g_workdir);
    int was_running = (g_child > 0) || (prev_mode != ENGINE_NONE);

    cstr_copy(g_ds4_dir, sizeof g_ds4_dir, abs);
    int valid = ds4_dir_valid();

    /* Kill the active ds4: our own child first, then any external ds4-server
     * still holding the engine port (the instance-lock forbids two at once). */
    if (g_child > 0) stop_child();
    kill_external_server(ENGINE_DEFAULTS.port);

    /* Restart in the new location, same mode/config, when it's a real ds4 install. */
    int restarted = 0;
    char err[256] = "";
    if (was_running && valid) {
        int ok = prev_mode == ENGINE_AGENT  ? spawn_agent(&prev_cfg, prev_wd, err, sizeof err)
               : prev_mode == ENGINE_DESIGN ? spawn_design(&prev_cfg, prev_wd, err, sizeof err)
                                            : spawn_server(&prev_cfg, err, sizeof err);
        restarted = ok ? 1 : 0;
    }

    char err_esc[300];
    json_escape_into(err_esc, sizeof err_esc, err, strlen(err));
    char out[512];
    snprintf(out, sizeof out,
        "{\"ok\":true,\"ds4dirOk\":%s,\"wasRunning\":%s,\"restarted\":%s,\"mode\":\"%s\",\"error\":\"%s\"}",
        valid ? "true" : "false", was_running ? "true" : "false",
        restarted ? "true" : "false", mode_name(g_mode), err_esc);
    send_json(fd, "200 OK", out);
}

/* Point the launcher at a different DStudio checkout (where extension/ lives:
 * the design build + the jsonl patch). Verified: it must be a real folder that
 * contains extension/design/build-design.sh, else the change is refused. */
static void api_set_webdir(int fd, const char *body) {
    char path[1024] = {0};
    json_get_string(body, "path", path, sizeof path);
    if (!path[0] || strstr(path, "..")) { send_json(fd, "400 Bad Request", "{\"ok\":false,\"error\":\"invalid path\"}"); return; }
    char abs[DSTUDIO_PATH_MAX];
    struct stat st;
    if (!realpath(path, abs) || stat(abs, &st) != 0 || !S_ISDIR(st.st_mode)) {
        send_json(fd, "400 Bad Request", "{\"ok\":false,\"error\":\"not a folder\"}");
        return;
    }
    char marker[DSTUDIO_PATH_MAX + 1024];
    snprintf(marker, sizeof marker, "%s/extension/design/build-design.sh", abs);
    if (stat(marker, &st) != 0 || !S_ISREG(st.st_mode)) {
        send_json(fd, "400 Bad Request", "{\"ok\":false,\"error\":\"not a DStudio folder (extension/design missing)\"}");
        return;
    }
    cstr_copy(g_web_dir, sizeof g_web_dir, abs);
    char out[80];
    snprintf(out, sizeof out, "{\"ok\":true,\"webdirOk\":%s}", web_dir_valid() ? "true" : "false");
    send_json(fd, "200 OK", out);
}

/* Network toggle: enable=true rebinds the HTTP listener to 0.0.0.0 (reachable on
 * the LAN), enable=false back to 127.0.0.1 (localhost only). Non-loopback clients
 * can fetch the app shell, /remote, the /v1 model proxy and the engine-control
 * endpoints needed by Chat/Agent/Design. Host settings, store and model-download
 * APIs stay local-only. This POST is behind the anti-CSRF header like other
 * mutating routes. */
static void api_lan(int fd, const char *body) {
    int enable = json_get_bool(body, "enable");
    const char *want = enable ? "0.0.0.0" : "127.0.0.1";
    char addr[80], out[200];
    if (strcmp(g_bind_host, want)) {
        if (!rebind_http_listener(want)) {
            send_json(fd, "500 Internal Server Error", "{\"ok\":false,\"error\":\"could not rebind the listener\"}");
            return;
        }
        if (enable) {
            char ip[INET_ADDRSTRLEN] = "";
            lan_ip(ip, sizeof ip);
        printf("\n  !  LAN ENABLED from Settings (%s:%d): non-local clients can open the app shell, /remote, /v1 and Chat web tools. Workspace APIs stay host-local.\n",
                   ip[0] ? ip : "0.0.0.0", g_http_port);
            printf("     Host settings, store and model-download APIs remain loopback-only.\n\n");
        } else {
            if (g_remote_enabled) { g_remote_enabled = 0; g_remote_rev++; }
            printf("DStudio: LAN disabled — localhost only again.\n");
        }
        /* The engine STAYS on 127.0.0.1: serve reverse-proxies /v1 to it, so LAN
         * clients reach the model through serve without the engine being exposed
         * on the network, and there is nothing for the user to configure. */
    }
    int on = lan_status(addr, sizeof addr);
    if (enable && on && !addr[0]) {
        (void)rebind_http_listener("127.0.0.1");
        send_json(fd, "500 Internal Server Error",
                  "{\"ok\":false,\"error\":\"LAN enabled but no LAN IPv4 address was detected\"}");
        return;
    }
    snprintf(out, sizeof out, "{\"ok\":true,\"lan\":%s,\"lanAddr\":\"%s\",\"httpPort\":%d,\"engineRestart\":false}",
             on ? "true" : "false", addr, g_http_port);
    send_json(fd, "200 OK", out);
}

static void api_fs_list(int fd, const char *body) {
    char path[1024] = {0};
    json_get_string(body, "path", path, sizeof path);
    const char *home = getenv("HOME");
    if (!path[0] && home) snprintf(path, sizeof path, "%s", home);
    char abs[DSTUDIO_PATH_MAX];
    if (!realpath(path, abs)) {
        send_json(fd, "404 Not Found", "{\"ok\":false,\"error\":\"path not found\"}");
        return;
    }
    struct stat st;
    if (stat(abs, &st) != 0 || !S_ISDIR(st.st_mode)) {
        send_json(fd, "400 Bad Request", "{\"ok\":false,\"error\":\"not a directory\"}");
        return;
    }
    design_buf_t b = {0};
    char esc[2100];
    json_escape_into(esc, sizeof esc, abs, strlen(abs));
    dbuf_puts(&b, "{\"ok\":true,\"path\":\"");
    dbuf_puts(&b, esc);
    dbuf_puts(&b, "\",\"dirs\":[");
    DIR *d = opendir(abs);
    int n = 0, entries = 0;
    if (d) {
        struct dirent *de;
        while ((de = readdir(d)) != NULL && n < 400) {
            if (de->d_name[0] == '.') continue;
            char p[3200];
            snprintf(p, sizeof p, "%s/%s", abs, de->d_name);
            struct stat ds;
            if (stat(p, &ds) != 0) continue;
            entries++; /* visible content: files AND dirs (bundles included) */
            if (!S_ISDIR(ds.st_mode)) continue;
            size_t nl = strlen(de->d_name);
            if (nl > 4 && strcmp(de->d_name + nl - 4, ".app") == 0) continue;
            json_escape_into(esc, sizeof esc, de->d_name, strlen(de->d_name));
            if (n++) dbuf_puts(&b, ",");
            dbuf_puts(&b, "\"");
            dbuf_puts(&b, esc);
            dbuf_puts(&b, "\"");
        }
        closedir(d);
    }
    char tail[48];
    snprintf(tail, sizeof tail, "],\"entries\":%d}", entries);
    dbuf_puts(&b, tail);
    send_response(fd, "200 OK", "application/json; charset=utf-8",
                  b.ptr ? b.ptr : "{}", b.len, 0);
    free(b.ptr);
}

/* POST /api/design/clean — empties the design workspace: deleting the LAST
 * design conversation in the UI also clears the project files (regular files
 * only, top level, no dotfiles — never recursive, never outside the dir). */
static void api_design_clean(int fd) {
    if (!g_design_dir[0]) {
        send_json(fd, "409 Conflict", "{\"ok\":false,\"error\":\"no design workspace\"}");
        return;
    }
    int removed = 0;
    DIR *d = opendir(g_design_dir);
    if (d) {
        struct dirent *de;
        while ((de = readdir(d)) != NULL) {
            if (de->d_name[0] == '.') continue;          /* no dotfiles, no traversal */
            if (strchr(de->d_name, '/')) continue;
            char p[2200];
            snprintf(p, sizeof p, "%s/%s", g_design_dir, de->d_name);
            struct stat st;
            if (lstat(p, &st) != 0 || !S_ISREG(st.st_mode)) continue; /* files only */
            if (unlink(p) == 0) removed++;
        }
        closedir(d);
    }
    char out[64];
    snprintf(out, sizeof out, "{\"ok\":true,\"removed\":%d}", removed);
    send_json(fd, "200 OK", out);
}

/* POST /api/design/import {path} — copy a folder's files INTO the design
 * workspace so the designer can read an existing app and build on it. Regular
 * text-like files only, bounded depth/count/size, skips dotfiles and heavy
 * build dirs. Source = any readable dir the user picked (same trust model as
 * the workdir picker); dest names come from the source's relative paths, so
 * nothing is ever written outside the workspace. */
#define IMPORT_MAX_FILES       400
#define IMPORT_MAX_FILE_BYTES  (512 * 1024)
#define IMPORT_MAX_TOTAL_BYTES (16 * 1024 * 1024)
#define IMPORT_MAX_DEPTH       6

static void import_mkdir_p(const char *path) {
    char tmp[12288];
    cstr_copy(tmp, sizeof tmp, path);
    for (char *p = tmp + 1; *p; p++) {
        if (*p == '/') { *p = '\0'; mkdir(tmp, 0755); *p = '/'; }
    }
    mkdir(tmp, 0755);
}

static int import_copy_file(const char *src, const char *dst) {
    char dir[12288];
    cstr_copy(dir, sizeof dir, dst);
    char *sl = strrchr(dir, '/');
    if (sl) { *sl = '\0'; import_mkdir_p(dir); }
    FILE *in = fopen(src, "rb");
    if (!in) return -1;
    FILE *out = fopen(dst, "wb");
    if (!out) { fclose(in); return -1; }
    char buf[8192]; size_t n; int rc = 0;
    while ((n = fread(buf, 1, sizeof buf, in)) > 0) {
        if (fwrite(buf, 1, n, out) != n) { rc = -1; break; }
    }
    fclose(in);
    if (fclose(out) != 0) rc = -1;
    return rc;
}

static int import_skip_dir(const char *name) {
    const char *skip[] = { "node_modules", "dist", "build", "vendor", "target",
        ".next", ".git", "out", "__pycache__", ".cache", "coverage", NULL };
    for (int i = 0; skip[i]; i++) if (!strcmp(name, skip[i])) return 1;
    return 0;
}

/* Only DESIGN-relevant files are imported (the user attaches a folder so the
 * designer can study an existing app): markup/style/script sources, plus
 * reference images. Everything else (binaries, archives, data dumps…) is
 * skipped, so the workspace stays focused on what informs the design. */
static int import_allow_ext(const char *name) {
    const char *dot = strrchr(name, '.');
    if (!dot || dot == name || !dot[1]) return 0;
    char ext[16];
    size_t i = 0;
    for (const char *p = dot; *p && i < sizeof ext - 1; p++)
        ext[i++] = (char)tolower((unsigned char)*p);
    ext[i] = '\0';
    static const char *ok[] = {
        ".html", ".htm", ".css", ".scss", ".sass", ".less",
        ".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".vue", ".svelte", ".astro",
        ".json", ".md", ".markdown", ".txt", ".svg", ".xml",
        ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".ico",
        NULL };
    for (int j = 0; ok[j]; j++) if (!strcmp(ext, ok[j])) return 1;
    return 0;
}

static void import_walk(const char *src_root, const char *rel, const char *dst_root,
                        int depth, int *files, long *total) {
    if (depth > IMPORT_MAX_DEPTH || *files >= IMPORT_MAX_FILES ||
        *total >= IMPORT_MAX_TOTAL_BYTES) return;
    char dir[12288];
    if (rel[0]) snprintf(dir, sizeof dir, "%s/%s", src_root, rel);
    else        snprintf(dir, sizeof dir, "%s", src_root);
    DIR *d = opendir(dir);
    if (!d) return;
    struct dirent *de;
    while ((de = readdir(d)) != NULL) {
        if (de->d_name[0] == '.') continue;            /* dotfiles/dotdirs */
        if (import_skip_dir(de->d_name)) continue;     /* heavy build dirs */
        char child_rel[8192];
        if (rel[0]) snprintf(child_rel, sizeof child_rel, "%s/%s", rel, de->d_name);
        else        snprintf(child_rel, sizeof child_rel, "%s", de->d_name);
        char src_path[12288];
        snprintf(src_path, sizeof src_path, "%s/%s", src_root, child_rel);
        struct stat st;
        if (lstat(src_path, &st) != 0 || S_ISLNK(st.st_mode)) continue; /* no symlinks */
        if (S_ISDIR(st.st_mode)) {
            import_walk(src_root, child_rel, dst_root, depth + 1, files, total);
            if (*files >= IMPORT_MAX_FILES || *total >= IMPORT_MAX_TOTAL_BYTES) break;
            continue;
        }
        if (!S_ISREG(st.st_mode) || st.st_size > IMPORT_MAX_FILE_BYTES) continue;
        if (!import_allow_ext(de->d_name)) continue; /* design-relevant files only */
        if (*files >= IMPORT_MAX_FILES ||
            *total + (long)st.st_size > IMPORT_MAX_TOTAL_BYTES) break;
        char dst_path[12288];
        snprintf(dst_path, sizeof dst_path, "%s/%s", dst_root, child_rel);
        if (import_copy_file(src_path, dst_path) == 0) { (*files)++; *total += (long)st.st_size; }
    }
    closedir(d);
}

static void api_design_import(int fd, const char *body) {
    if (g_mode != ENGINE_DESIGN || !g_design_dir[0]) {
        send_json(fd, "409 Conflict", "{\"ok\":false,\"error\":\"design is not active\"}");
        return;
    }
    char path[1024] = {0};
    json_get_string(body, "path", path, sizeof path);
    if (!path[0]) { send_json(fd, "400 Bad Request", "{\"ok\":false,\"error\":\"path required\"}"); return; }
    char abs[DSTUDIO_PATH_MAX];
    if (!realpath(path, abs)) { send_json(fd, "404 Not Found", "{\"ok\":false,\"error\":\"folder not found\"}"); return; }
    struct stat st;
    if (stat(abs, &st) != 0 || !S_ISDIR(st.st_mode)) {
        send_json(fd, "400 Bad Request", "{\"ok\":false,\"error\":\"not a folder\"}");
        return;
    }
    char dst_abs[DSTUDIO_PATH_MAX];
    if (realpath(g_design_dir, dst_abs) &&
        (strcmp(abs, dst_abs) == 0 ||
         (strncmp(dst_abs, abs, strlen(abs)) == 0 && dst_abs[strlen(abs)] == '/'))) {
        /* refuse importing the workspace into itself (or an ancestor). The
         * trailing-'/' check is a path boundary: a sibling like /a/proj vs the
         * workspace /a/proj-x is NOT an ancestor and must be allowed. */
        send_json(fd, "400 Bad Request", "{\"ok\":false,\"error\":\"choose a folder outside the project\"}");
        return;
    }
    int files = 0; long total = 0;
    import_walk(abs, "", g_design_dir, 0, &files, &total);
    char out[96];
    snprintf(out, sizeof out, "{\"ok\":true,\"files\":%d,\"bytes\":%ld}", files, total);
    send_json(fd, "200 OK", out);
}

static const char *design_content_type(const char *name) {
    const char *dot = strrchr(name, '.');
    const char *ext = dot ? dot + 1 : "";
    if (!strcmp(ext, "html") || !strcmp(ext, "htm")) return "text/html; charset=utf-8";
    if (!strcmp(ext, "css"))  return "text/css; charset=utf-8";
    if (!strcmp(ext, "js") || !strcmp(ext, "mjs")) return "text/javascript; charset=utf-8";
    if (!strcmp(ext, "svg"))  return "image/svg+xml";
    if (!strcmp(ext, "json")) return "application/json; charset=utf-8";
    if (!strcmp(ext, "png"))  return "image/png";
    if (!strcmp(ext, "jpg") || !strcmp(ext, "jpeg")) return "image/jpeg";
    if (!strcmp(ext, "webp")) return "image/webp";
    if (!strcmp(ext, "md") || !strcmp(ext, "txt")) return "text/plain; charset=utf-8";
    return "application/octet-stream";
}

/* Serve a project file: /api/design/file?name=<relative-path>. The path
 * passes the SAME validation as the agent's tool-layer; the filesystem outside
 * the workspace stays unreachable. */
static void api_design_file(int fd, const char *path, int head_only) {
    if (!g_design_dir[0]) {
        send_text(fd, "404 Not Found", "no design workspace\n", head_only);
        return;
    }
    const char *q = strstr(path, "name=");
    if (!q) { send_text(fd, "400 Bad Request", "name missing\n", head_only); return; }
    q += 5;
    size_t qlen = strcspn(q, "&");
    char name[1024];
    url_decode_into(q, qlen, name, sizeof name);
    if (!design_rel_path_ok(name)) {
        send_text(fd, "400 Bad Request", "invalid path\n", head_only);
        return;
    }
    char file[2048];
    snprintf(file, sizeof file, "%s/%s", g_design_dir, name);

    FILE *f = fopen(file, "rb");
    if (!f) { send_text(fd, "404 Not Found", "file not found\n", head_only); return; }
    if (fseek(f, 0, SEEK_END) != 0) { fclose(f); send_text(fd, "500 Internal Server Error", "seek\n", head_only); return; }
    long sz = ftell(f);
    if (sz < 0 || sz > MAX_PAGE) { fclose(f); send_text(fd, "500 Internal Server Error", "file too large\n", head_only); return; }
    rewind(f);
    char *buf = malloc((size_t)sz > 0 ? (size_t)sz : 1);
    if (!buf) { fclose(f); send_text(fd, "500 Internal Server Error", "memory\n", head_only); return; }
    size_t got = fread(buf, 1, (size_t)sz, f);
    fclose(f);
    if (got != (size_t)sz) { free(buf); send_text(fd, "500 Internal Server Error", "read\n", head_only); return; }
    send_response_hdrs(fd, "200 OK", design_content_type(name), buf, got, head_only, DESIGN_HEADERS);
    free(buf);
}

/* ==================== header helpers ==================== */

static int header_has(const char *req, size_t hlen, const char *needle_lower) {
    char low[REQ_BUF + 1];
    size_t n = hlen < REQ_BUF ? hlen : REQ_BUF;
    for (size_t i = 0; i < n; i++) {
        char c = req[i];
        low[i] = (c >= 'A' && c <= 'Z') ? (char)(c + 32) : c;
    }
    low[n] = '\0';
    /* The needle ("x-requested-with: ds4web") must START a header LINE: binding
     * it to the header NAME stops it matching as the VALUE of an unrelated
     * header (e.g. a cross-origin "Accept-Language: x-requested-with: ds4web"). */
    for (const char *p = low; (p = strstr(p, needle_lower)) != NULL; p++) {
        if (p == low || p[-1] == '\n') return 1;
    }
    return 0;
}

static long content_length(const char *req, size_t hlen) {
    char low[REQ_BUF + 1];
    size_t n = hlen < REQ_BUF ? hlen : REQ_BUF;
    for (size_t i = 0; i < n; i++) {
        char c = req[i];
        low[i] = (c >= 'A' && c <= 'Z') ? (char)(c + 32) : c;
    }
    low[n] = '\0';
    const char *p = strstr(low, "content-length:");
    if (!p) return 0;
    long v = strtol(p + 15, NULL, 10);
    return v < 0 ? -1 : v;
}

/* ==================== signals ==================== */

static volatile sig_atomic_t g_stop = 0;
/* Set the flag and nudge the child: the main loop exits on its own and runs
 * the real cleanup (sse_close_all + stop_child) instead of dying via _exit. */
static void on_term(int sig) { (void)sig; g_stop = 1; if (g_child > 0) kill(g_child, SIGTERM); }

/* ==================== shared chat store ==================== */

static void store_file_path(char *out, size_t n) {
#ifdef _WIN32
    const char *base = getenv("LOCALAPPDATA");
    if (!base || !base[0]) base = getenv("USERPROFILE");
    snprintf(out, n, "%s\\DStudio\\ds4web-store.json", base ? base : ".");
#else
    const char *home = getenv("HOME");
    snprintf(out, n, "%s/.local/share/flashcards/ds4web-store.json", home ? home : ".");
#endif
}
static void store_load(void) {
    char p[2048];
    store_file_path(p, sizeof p);
    FILE *f = fopen(p, "rb");
    if (!f) return;
    fseek(f, 0, SEEK_END);
    long sz = ftell(f);
    rewind(f);
    if (sz > 0 && sz < 64L * 1024 * 1024) {
        char *b = malloc((size_t)sz + 1);
        if (b && fread(b, 1, (size_t)sz, f) == (size_t)sz) {
            b[sz] = '\0';
            free(g_store);
            g_store = b; g_store_len = (size_t)sz; g_store_rev = 1;
        } else free(b);
    }
    fclose(f);
}
static void store_save(void) {
    char p[2048];
    store_file_path(p, sizeof p);
    char dir[2048];
    snprintf(dir, sizeof dir, "%s", p);
    char *s = strrchr(dir, '/');
#ifdef _WIN32
    char *bs = strrchr(dir, '\\');
    if (!s || (bs && bs > s)) s = bs;
#endif
    if (s) { *s = '\0'; mkpath(dir); }
    FILE *f = fopen(p, "wb");
    if (!f) return;
    if (g_store && g_store_len) fwrite(g_store, 1, g_store_len, f);
    fclose(f);
}
/* GET → {"rev":N,"data":<the stored blob, raw JSON | null>} */
static void api_store_get(int fd) {
    size_t cap = g_store_len + 64;
    char *out = malloc(cap);
    if (!out) { send_json(fd, "200 OK", "{\"rev\":0,\"data\":null}"); return; }
    int n = snprintf(out, cap, "{\"rev\":%ld,\"data\":", g_store_rev);
    if (g_store && g_store_len) { memcpy(out + n, g_store, g_store_len); n += (int)g_store_len; }
    else { memcpy(out + n, "null", 4); n += 4; }
    out[n++] = '}'; out[n] = '\0';
    send_json(fd, "200 OK", out);
    free(out);
}
/* POST: replaces the store with `body` (ownership transferred here), persists it. */
static void api_store_set(int fd, char *body, size_t len) {
    free(g_store);
    g_store = body; g_store_len = len; g_store_rev++;
    store_save();
    char out[64];
    snprintf(out, sizeof out, "{\"ok\":true,\"rev\":%ld}", g_store_rev);
    send_json(fd, "200 OK", out);
}

static int lan_client_id_ok(const char *id) {
    size_t n = strlen(id);
    if (n < 3 || n >= 120) return 0;
    for (const char *p = id; *p; p++) {
        unsigned char c = (unsigned char)*p;
        if (!(isalnum(c) || c == '-' || c == '_' || c == '.')) return 0;
    }
    return 1;
}

static lan_client_snapshot *lan_client_find(const char *id) {
    for (lan_client_snapshot *c = g_lan_clients; c; c = c->next)
        if (!strcmp(c->id, id)) return c;
    return NULL;
}

static void api_lan_client_chats_set(int fd, char *body, size_t len) {
    char id[128] = "", name[160] = "";
    json_get_string(body, "clientId", id, sizeof id);
    json_get_string(body, "clientName", name, sizeof name);
    size_t end = len;
    while (end > 0 && isspace((unsigned char)body[end - 1])) end--;
    if (!lan_client_id_ok(id) || len < 2 || body[0] != '{' || end == 0 || body[end - 1] != '}') {
        free(body);
        send_json_cors(fd, "400 Bad Request", "{\"ok\":false,\"error\":\"invalid client snapshot\"}");
        return;
    }
    lan_client_snapshot *c = lan_client_find(id);
    if (!c) {
        c = calloc(1, sizeof *c);
        if (!c) {
            free(body);
            send_json_cors(fd, "500 Internal Server Error", "{\"ok\":false}");
            return;
        }
        snprintf(c->id, sizeof c->id, "%s", id);
        c->next = g_lan_clients;
        g_lan_clients = c;
    }
    snprintf(c->name, sizeof c->name, "%s", name[0] ? name : id);
    free(c->json);
    c->json = body;
    c->json_len = len;
    c->updated_ms = (long)(time(NULL) * 1000L);
    g_lan_clients_rev++;
    char out[80];
    snprintf(out, sizeof out, "{\"ok\":true,\"rev\":%ld}", g_lan_clients_rev);
    send_json_cors(fd, "200 OK", out);
}

static void api_lan_client_chats_get(int fd) {
    json_dyn_buf b = {0};
    int first = 1;
    int ok = json_dyn_puts(&b, "{\"ok\":true,\"rev\":") &&
             json_dyn_printf(&b, "%ld", g_lan_clients_rev) &&
             json_dyn_puts(&b, ",\"clients\":[");
    for (lan_client_snapshot *c = g_lan_clients; ok && c; c = c->next) {
        ok = json_dyn_puts(&b, first ? "" : ",") &&
             json_dyn_putn(&b, c->json, c->json_len);
        first = 0;
    }
    ok = ok && json_dyn_puts(&b, "]}");
    if (!ok) {
        free(b.ptr);
        send_json(fd, "500 Internal Server Error", "{\"ok\":false,\"error\":\"out of memory\"}");
        return;
    }
    send_json(fd, "200 OK", b.ptr);
    free(b.ptr);
}

/* Recursive remove (no shell). Used by the "clear all" wipe for the KV dirs. */
static void rm_rf(const char *path) {
    struct stat st;
    if (lstat(path, &st) != 0) return;
    if (S_ISDIR(st.st_mode)) {
        DIR *d = opendir(path);
        if (d) {
            struct dirent *e;
            while ((e = readdir(d))) {
                if (!strcmp(e->d_name, ".") || !strcmp(e->d_name, "..")) continue;
                char child[4096];
                snprintf(child, sizeof child, "%s/%s", path, e->d_name);
                rm_rf(child);
            }
            closedir(d);
        }
        rmdir(path);
    } else {
        unlink(path);
    }
}
static void clear_dir(const char *path) {       /* delete the contents, keep the dir */
    DIR *d = opendir(path);
    if (!d) return;
    struct dirent *e;
    while ((e = readdir(d))) {
        if (!strcmp(e->d_name, ".") || !strcmp(e->d_name, "..")) continue;
        char child[4096];
        snprintf(child, sizeof child, "%s/%s", path, e->d_name);
        rm_rf(child);
    }
    closedir(d);
}

/* "Clear all conversations": empties the shared chat store, and (when no engine
 * is running, so it's not in use) the on-disk KV cache. Behind the anti-CSRF
 * header. The page wipes its own localStorage separately. */
static void api_wipe(int fd) {
    free(g_store); g_store = NULL; g_store_len = 0; g_store_rev++;
    store_save();
    int kv_cleared = 0;
    if (g_child <= 0) {        /* the engine isn't running → the KV files are free */
        char kvroot[2048];
        kv_root(kvroot, sizeof kvroot);        /* all per-model caches live under here */
        clear_dir(kvroot);
        kv_cleared = 1;
    }
    char out[80];
    snprintf(out, sizeof out, "{\"ok\":true,\"kvCleared\":%s}", kv_cleared ? "true" : "false");
    send_json(fd, "200 OK", out);
}

typedef struct {
    char title[256];
    char url[1024];
    char *content;
} web_source;

typedef struct {
    web_source *items;
    int len;
    int cap;
} web_source_list;

static char *json_get_string_alloc(const char *body, const char *key) {
    char pat[96];
    snprintf(pat, sizeof pat, "\"%s\"", key);
    const char *p = strstr(body, pat);
    if (!p) return NULL;
    p += strlen(pat);
    while (*p == ' ' || *p == '\t' || *p == '\n' || *p == '\r') p++;
    if (*p != ':') return NULL;
    p++;
    while (*p == ' ' || *p == '\t' || *p == '\n' || *p == '\r') p++;
    if (*p != '"') return NULL;
    p++;
    json_dyn_buf b = {0};
    while (*p && *p != '"') {
        char c = *p++;
        if (c == '\\' && *p) {
            char e = *p++;
            switch (e) {
                case 'n': c = '\n'; break;
                case 't': c = '\t'; break;
                case 'r': c = '\r'; break;
                case '"': c = '"';  break;
                case '\\': c = '\\'; break;
                case '/': c = '/';  break;
                case 'u': {
                    if (p[0] && p[1] && p[2] && p[3]) {
                        char hx[5] = { p[0], p[1], p[2], p[3], 0 };
                        long v = strtol(hx, NULL, 16);
                        p += 4;
                        if (v < 0x80) c = (char)v;
                        else c = '?';
                    } else c = '?';
                    break;
                }
                default: c = e; break;
            }
        }
        if (!json_dyn_putn(&b, &c, 1)) { free(b.ptr); return NULL; }
    }
    return b.ptr ? b.ptr : ds4_strdup_local("");
}

static int remote_json_ok(const char *body, size_t len) {
    size_t i = 0;
    while (i < len && isspace((unsigned char)body[i])) i++;
    return i < len && body[i] == '{';
}

static const char *json_value_end_ptr(const char *p) {
    p += strspn(p, " \t\r\n");
    if (*p == '"') {
        for (p++; *p; p++) {
            if (*p == '\\' && p[1]) { p++; continue; }
            if (*p == '"') return p + 1;
        }
        return NULL;
    }
    if (*p == '{' || *p == '[') {
        char open = *p, close = open == '{' ? '}' : ']';
        int depth = 0, in_str = 0, esc = 0;
        for (; *p; p++) {
            if (in_str) {
                if (esc) esc = 0;
                else if (*p == '\\') esc = 1;
                else if (*p == '"') in_str = 0;
                continue;
            }
            if (*p == '"') in_str = 1;
            else if (*p == open) depth++;
            else if (*p == close && --depth == 0) return p + 1;
        }
        return NULL;
    }
    const char *s = p;
    while (*p && *p != ',' && *p != '}' && *p != ']' &&
           !isspace((unsigned char)*p)) p++;
    return p > s ? p : NULL;
}

static char *json_top_value_dup(const char *json, const char *key, char required_first) {
    const char *p = json;
    if (!p) return NULL;
    p += strspn(p, " \t\r\n");
    if (*p++ != '{') return NULL;
    size_t key_len = strlen(key);
    while (*p) {
        p += strspn(p, " \t\r\n");
        if (*p == '}') return NULL;
        if (*p != '"') return NULL;
        const char *ks = ++p;
        while (*p && !(*p == '"' && p[-1] != '\\')) p++;
        if (!*p) return NULL;
        size_t kl = (size_t)(p - ks);
        p++;
        p += strspn(p, " \t\r\n");
        if (*p++ != ':') return NULL;
        p += strspn(p, " \t\r\n");
        const char *vs = p;
        const char *ve = json_value_end_ptr(vs);
        if (!ve) return NULL;
        if (kl == key_len && !strncmp(ks, key, key_len) &&
            (!required_first || *vs == required_first)) {
            return ds4_strndup_local(vs, (size_t)(ve - vs));
        }
        p = ve;
        p += strspn(p, " \t\r\n");
        if (*p == ',') { p++; continue; }
        if (*p == '}') return NULL;
    }
    return NULL;
}

static void remote_ensure_empty_chat(void) {
    if (g_remote_chat) return;
    const char *empty = "{\"id\":\"remote\",\"title\":\"Remote\",\"model\":\"\",\"settings\":{},\"messages\":[]}";
    g_remote_chat = ds4_strdup_local(empty);
    if (g_remote_chat) g_remote_chat_len = strlen(empty);
}

static char *remote_messages_only_update(char *body) {
    remote_ensure_empty_chat();
    char *messages = json_top_value_dup(body, "messages", '[');
    if (!messages) return NULL;
    char *id = json_top_value_dup(g_remote_chat, "id", '"');
    char *title = json_top_value_dup(g_remote_chat, "title", '"');
    char *model = json_top_value_dup(g_remote_chat, "model", '"');
    char *settings = json_top_value_dup(g_remote_chat, "settings", '{');
    if (!id) id = strdup("\"remote\"");
    if (!title) title = strdup("\"Remote\"");
    if (!model) model = strdup("\"\"");
    if (!settings) settings = strdup("{}");
    json_dyn_buf out = {0};
    int ok = id && title && model && settings &&
             json_dyn_puts(&out, "{\"id\":") &&
             json_dyn_puts(&out, id) &&
             json_dyn_puts(&out, ",\"title\":") &&
             json_dyn_puts(&out, title) &&
             json_dyn_puts(&out, ",\"model\":") &&
             json_dyn_puts(&out, model) &&
             json_dyn_puts(&out, ",\"settings\":") &&
             json_dyn_puts(&out, settings) &&
             json_dyn_puts(&out, ",\"messages\":") &&
             json_dyn_puts(&out, messages) &&
             json_dyn_puts(&out, "}");
    free(id); free(title); free(model); free(settings); free(messages);
    if (!ok) { free(out.ptr); return NULL; }
    free(body);
    return out.ptr;
}

static void remote_addr_url(char *addr, size_t addrsz, char *url, size_t urlsz) {
    int on = lan_status(addr, addrsz);
    if (on && addr[0]) snprintf(url, urlsz, "http://%s/remote", addr);
    else url[0] = '\0';
}

static void api_remote_status(int fd) {
    char addr[80], url[128];
    remote_addr_url(addr, sizeof addr, url, sizeof url);
    json_dyn_buf out = {0};
    if (!json_dyn_puts(&out, "{\"ok\":true,\"enabled\":") ||
        !json_dyn_puts(&out, g_remote_enabled ? "true" : "false") ||
        !json_dyn_printf(&out, ",\"rev\":%ld,\"lan\":", g_remote_rev) ||
        !json_dyn_puts(&out, strcmp(g_bind_host, "127.0.0.1") ? "true" : "false") ||
        !json_dyn_puts(&out, ",\"lanAddr\":") ||
        !json_dyn_put_escaped(&out, addr) ||
        !json_dyn_puts(&out, ",\"url\":") ||
        !json_dyn_put_escaped(&out, url) ||
        !json_dyn_puts(&out, "}")) {
        free(out.ptr);
        send_json(fd, "500 Internal Server Error", "{\"ok\":false}");
        return;
    }
    send_json(fd, "200 OK", out.ptr);
    free(out.ptr);
}

static void api_remote_control(int fd, const char *body) {
    int enable = json_get_bool(body, "enable");
    if (enable) {
        if (!rebind_http_listener("0.0.0.0")) {
            send_json(fd, "500 Internal Server Error", "{\"ok\":false,\"error\":\"could not rebind the listener\"}");
            return;
        }
        remote_ensure_empty_chat();
        g_remote_enabled = 1;
        g_remote_rev++;
        char ip[INET_ADDRSTRLEN] = "";
        lan_ip(ip, sizeof ip);
        printf("\n  !  REMOTE CHAT ENABLED (%s:%d/remote): shared chat is available at /remote.\n\n",
               ip[0] ? ip : "0.0.0.0", g_http_port);
    } else {
        g_remote_enabled = 0;
        g_remote_rev++;
        printf("DStudio: remote chat disabled.\n");
    }
    api_remote_status(fd);
}

static void api_remote_chat_get(int fd) {
    char addr[80], url[128];
    remote_addr_url(addr, sizeof addr, url, sizeof url);
    json_dyn_buf out = {0};
    int ok = json_dyn_puts(&out, "{\"ok\":true,\"enabled\":") &&
             json_dyn_puts(&out, g_remote_enabled ? "true" : "false") &&
             json_dyn_printf(&out, ",\"rev\":%ld,\"url\":", g_remote_rev) &&
             json_dyn_put_escaped(&out, url) &&
             json_dyn_puts(&out, ",\"chat\":");
    if (ok && g_remote_chat && g_remote_chat_len) ok = json_dyn_putn(&out, g_remote_chat, g_remote_chat_len);
    else if (ok) ok = json_dyn_puts(&out, "null");
    if (ok) ok = json_dyn_puts(&out, "}");
    if (!ok) {
        free(out.ptr);
        send_json(fd, "500 Internal Server Error", "{\"ok\":false}");
        return;
    }
    send_json(fd, "200 OK", out.ptr);
    free(out.ptr);
}

static void api_remote_chat_set(int fd, char *body, size_t len, int local_client) {
    if (!g_remote_enabled) {
        free(body);
        send_json(fd, "409 Conflict", "{\"ok\":false,\"error\":\"remote chat is not enabled\"}");
        return;
    }
    if (!remote_json_ok(body, len)) {
        free(body);
        send_json(fd, "400 Bad Request", "{\"ok\":false,\"error\":\"remote chat must be a JSON object\"}");
        return;
    }
    if (!local_client) {
        char *merged = remote_messages_only_update(body);
        if (!merged) {
            free(body);
            send_json(fd, "400 Bad Request", "{\"ok\":false,\"error\":\"remote clients can only update messages\"}");
            return;
        }
        body = merged;
        len = strlen(body);
    }
    free(g_remote_chat);
    g_remote_chat = body;
    g_remote_chat_len = len;
    g_remote_rev++;
    char out[64];
    snprintf(out, sizeof out, "{\"ok\":true,\"rev\":%ld}", g_remote_rev);
    send_json(fd, "200 OK", out);
}

static const char REMOTE_PAGE[] =
"<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
"<title>DStudio Remote</title><style>"
":root{color-scheme:dark;--bg:#070809;--panel:#111317;--line:#2b3038;--text:#f4f5f7;--muted:#969ca6;--accent:#8fb7ff}"
"*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:16px/1.5 Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,\"Segoe UI\",sans-serif}"
".app{min-height:100vh;display:flex;flex-direction:column}.top{height:58px;display:flex;align-items:center;gap:12px;padding:0 18px;border-bottom:1px solid var(--line);background:#0b0c0f}"
".mark{width:24px;height:24px;border-radius:50%;display:inline-block;background:radial-gradient(circle at 50% 50%,#dbe8ff 0 14%,transparent 15%),conic-gradient(from 20deg,var(--accent) 0 14%,transparent 14% 25%,var(--accent) 25% 39%,transparent 39% 50%,var(--accent) 50% 64%,transparent 64% 75%,var(--accent) 75% 89%,transparent 89%)}"
".brand{font-weight:650}.tag{font-size:12px;color:var(--accent);border:1px solid #315386;border-radius:999px;padding:2px 8px}.status{margin-left:auto;color:var(--muted);font-size:13px}"
".messages{flex:1;overflow:auto;padding:28px 16px 120px}.empty{max-width:760px;margin:20vh auto 0;color:var(--muted);text-align:center}"
".msg{max-width:920px;margin:0 auto 24px}.msg.user{display:flex;flex-direction:column;align-items:flex-end}.start{display:flex;align-items:center;gap:8px;color:var(--muted);font:12px ui-monospace,monospace;margin-bottom:7px}.msg.user .start{justify-content:flex-end}"
".bubble{white-space:pre-wrap;overflow-wrap:anywhere}.msg.user .bubble{max-width:min(760px,88vw);background:#233044;border-radius:18px;padding:12px 16px}.msg.assistant .bubble{font-size:17px;color:#f0f1f4}"
".composer{position:fixed;left:0;right:0;bottom:0;padding:14px 16px 18px;background:linear-gradient(180deg,rgba(7,8,9,0),#070809 22%)}"
".bar{max-width:920px;margin:auto;display:flex;align-items:flex-end;gap:10px;border:1px solid var(--line);border-radius:18px;padding:8px;background:#090a0c}"
"textarea{flex:1;min-height:42px;max-height:160px;resize:none;background:transparent;border:0;color:var(--text);font:inherit;outline:0;padding:8px}button{width:42px;height:42px;border:0;border-radius:13px;background:var(--accent);color:#07101e;font-size:20px;font-weight:700;cursor:pointer}button:disabled{opacity:.45;cursor:not-allowed}"
".settings-btn{width:auto;height:34px;border:1px solid var(--line);border-radius:10px;background:#151922;color:var(--text);font-size:13px;font-weight:600;padding:0 12px}.modal[hidden]{display:none}.modal{position:fixed;inset:0;background:rgba(0,0,0,.62);display:grid;place-items:center;padding:20px;z-index:20}.modal-card{width:min(92vw,430px);background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:18px;box-shadow:0 24px 80px rgba(0,0,0,.55)}.modal-card h2{font-size:18px;margin:0 0 6px}.modal-card p{margin:0 0 14px;color:var(--muted);font-size:13px}.modal-row{display:flex;gap:8px}.modal-row input{flex:1;min-width:0;background:#08090b;border:1px solid var(--line);border-radius:10px;color:var(--text);font:14px ui-monospace,monospace;padding:10px}.modal-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:14px}.modal-actions button,.modal-row button{width:auto;height:38px;font-size:13px;border-radius:10px;padding:0 12px}.btn-plain{background:#171a20!important;color:var(--text)!important}.btn-danger{background:#3a1720!important;color:#ffdce5!important}.lan-msg{min-height:18px;margin-top:8px;color:#ff9d91;font-size:12px}"
"</style></head><body><div class=\"app\"><header class=\"top\"><span class=\"mark\"></span><span class=\"brand\">DStudio</span><span class=\"tag\">Remote</span><span id=\"status\" class=\"status\">Connecting...</span><button id=\"settings\" type=\"button\" class=\"settings-btn\">Settings</button></header><main id=\"messages\" class=\"messages\"></main><div id=\"modal\" class=\"modal\" hidden><div class=\"modal-card\"><h2>LAN connection</h2><p>This Remote client cannot change the host model or host settings. It can only switch LAN address or switch this device to host mode.</p><label><p>LAN address</p><div class=\"modal-row\"><input id=\"lanaddr\" type=\"text\" spellcheck=\"false\" placeholder=\"192.168.1.207:5500\"><button id=\"lanconnect\" type=\"button\">Connect</button></div></label><div id=\"lanmsg\" class=\"lan-msg\"></div><div class=\"modal-actions\"><button id=\"lanexit\" type=\"button\" class=\"btn-danger\">Switch to host</button><button id=\"modalclose\" type=\"button\" class=\"btn-plain\">Close</button></div></div></div><form id=\"form\" class=\"composer\"><div class=\"bar\"><textarea id=\"input\" placeholder=\"Write a message...\" rows=\"1\"></textarea><button id=\"send\" type=\"submit\">&#8593;</button></div></form></div>"
"<script>"
"const $=s=>document.querySelector(s);let chat=null,rev=-1,busy=false,saveTimer=null;"
"const uid=()=>crypto.randomUUID?crypto.randomUUID():('m_'+Date.now().toString(36)+Math.random().toString(36).slice(2));"
"function setStatus(t){$('#status').textContent=t||''}"
"function remoteUrl(raw){let v=String(raw||'').trim();if(!v)throw new Error('Insert the LAN address.');if(!/^https?:\\/\\//i.test(v))v='http://'+v;let u;try{u=new URL(v)}catch{throw new Error('Use an address like 192.168.1.207:5500.')}if(!u.hostname)throw new Error('Use an address like 192.168.1.207:5500.');if(!u.port)u.port='5500';u.pathname='/remote';u.search='';u.hash='';return u.toString()}"
"function openSettings(){ $('#lanaddr').value=location.host||''; $('#lanmsg').textContent=''; $('#modal').hidden=false }"
"function closeSettings(){ $('#modal').hidden=true }"
"function connectLan(){try{location.href=remoteUrl($('#lanaddr').value)}catch(e){$('#lanmsg').textContent=e.message||'Invalid LAN address.'}}"
"function exitLan(){location.href='http://127.0.0.1:'+((location&&location.port)||'5500')+'/loading.html'}"
"function start(role){const d=document.createElement('div');d.className='start';d.innerHTML='<span class=\"mark\"></span><span>'+(role==='user'?'You':'DStudio')+'</span>';return d}"
"function render(){const box=$('#messages');box.innerHTML='';if(!chat){const p=document.createElement('p');p.className='empty';p.textContent='Remote chat is not active. Run /remote on the host.';box.append(p);return}for(const m of chat.messages||[]){if(m.role!=='user'&&m.role!=='assistant')continue;const a=document.createElement('article');a.className='msg '+(m.role==='user'?'user':'assistant');const b=document.createElement('div');b.className='bubble';b.textContent=m.content||'';a.append(start(m.role),b);box.append(a)}box.scrollTop=box.scrollHeight}"
"async function load(){try{const j=await (await fetch('/api/remote/chat',{cache:'no-store'})).json();if(!j.enabled){chat=null;rev=j.rev;setStatus('Waiting for /remote');render();return}if(j.rev!==rev){chat=j.chat||{title:'Remote',settings:{},messages:[]};rev=j.rev;setStatus(chat.title||'Remote');render()}}catch(e){setStatus('Disconnected')}}"
"async function save(){if(!chat)return;const j=await (await fetch('/api/remote/chat',{method:'POST',headers:{'X-Requested-With':'ds4web','Content-Type':'application/json'},body:JSON.stringify(chat)})).json();if(typeof j.rev==='number')rev=j.rev}"
"function queueSave(){clearTimeout(saveTimer);saveTimer=setTimeout(()=>save().catch(()=>{}),600)}"
"function sse(block,a){for(const line of block.split('\\n')){if(!line.startsWith('data:'))continue;const data=line.slice(5).trim();if(!data||data==='[DONE]')continue;try{const j=JSON.parse(data);const d=(j.choices&&j.choices[0]&&j.choices[0].delta)||{};const t=d.content||d.reasoning_content||d.reasoning||'';if(t){a.content+=t;render();queueSave()}}catch{}}}"
"async function stream(res,a){const reader=res.body.getReader();const dec=new TextDecoder();let buf='';for(;;){const x=await reader.read();if(x.done)break;buf+=dec.decode(x.value,{stream:true});const parts=buf.split('\\n\\n');buf=parts.pop()||'';for(const p of parts)sse(p,a)}if(buf)sse(buf,a)}"
"async function send(text){if(!chat||busy||!text.trim())return;busy=true;$('#send').disabled=true;chat.messages=chat.messages||[];chat.messages.push({id:uid(),role:'user',content:text.trim(),createdAt:Date.now()});const a={id:uid(),role:'assistant',content:'',createdAt:Date.now(),streaming:true};chat.messages.push(a);render();await save().catch(()=>{});try{const msgs=[];const sys=chat.settings&&chat.settings.systemPrompt;if(sys)msgs.push({role:'system',content:sys});for(const m of chat.messages){if(m.role==='user'||(m.role==='assistant'&&m.content&&!m.streaming))msgs.push({role:m.role,content:m.content})}const body={model:chat.model||'ds4',messages:msgs,stream:true,temperature:(chat.settings&&chat.settings.temperature)||0.6};if(chat.settings&&chat.settings.maxTokens)body.max_tokens=chat.settings.maxTokens;const res=await fetch('/v1/chat/completions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});if(!res.ok)throw new Error('HTTP '+res.status);await stream(res,a)}catch(e){a.content+=(a.content?'\\n\\n':'')+'[Remote error: '+(e.message||e)+']'}finally{delete a.streaming;busy=false;$('#send').disabled=false;await save().catch(()=>{});render()}}"
"$('#form').addEventListener('submit',e=>{e.preventDefault();const i=$('#input');const t=i.value;i.value='';send(t)});$('#input').addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();$('#form').requestSubmit()}});"
"$('#settings').addEventListener('click',openSettings);$('#modalclose').addEventListener('click',closeSettings);$('#modal').addEventListener('click',e=>{if(e.target.id==='modal')closeSettings()});$('#lanconnect').addEventListener('click',connectLan);$('#lanaddr').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();connectLan()}});$('#lanexit').addEventListener('click',exitLan);"
"load();setInterval(()=>{if(!busy)load()},1500);"
"</script></body></html>";

static void serve_remote_page(int fd, int head_only) {
    send_response(fd, "200 OK", "text/html; charset=utf-8", REMOTE_PAGE, strlen(REMOTE_PAGE), head_only);
}

static int client_is_loopback(int fd) {
    struct sockaddr_storage ss;
#ifdef _WIN32
    int slen = (int)sizeof ss;
#else
    socklen_t slen = sizeof ss;
#endif
    if (getpeername(fd, (struct sockaddr *)&ss, &slen) != 0) return 0;
    if (ss.ss_family == AF_INET) {
        struct sockaddr_in *sin = (struct sockaddr_in *)&ss;
        uint32_t ip = ntohl(sin->sin_addr.s_addr);
        return (ip >> 24) == 127;
    }
#ifdef AF_INET6
    if (ss.ss_family == AF_INET6) {
        struct sockaddr_in6 *sin6 = (struct sockaddr_in6 *)&ss;
        return IN6_IS_ADDR_LOOPBACK(&sin6->sin6_addr);
    }
#endif
    return 0;
}

static int path_eq_clean(const char *path, const char *want) {
    size_t n = strcspn(path, "?");
    return strlen(want) == n && !strncmp(path, want, n);
}

static int lan_root_path(const char *path) {
    return path_eq_clean(path, "/") || path_eq_clean(path, "/index.html");
}

static int loading_page_path(const char *path) {
    return path_eq_clean(path, "/loading.html");
}

static int remote_page_path(const char *path) {
    return path_eq_clean(path, "/remote") || path_eq_clean(path, "/remote/") ||
           path_eq_clean(path, "/remote/index.html");
}

static int lan_web_tool_path(const char *path) {
    return path_eq_clean(path, "/api/web-search") ||
           path_eq_clean(path, "/api/web-read") ||
           path_eq_clean(path, "/api/http-probe");
}

static int lan_public_path_allowed(const char *method, const char *path) {
    int get = !strcmp(method, "GET") || !strcmp(method, "HEAD");
    int lan_on = strcmp(g_bind_host, "127.0.0.1") != 0;
    if (!strcmp(method, "OPTIONS") &&
        (!strncmp(path, "/v1/", 4) || path_eq_clean(path, "/api/lan-client/chats") ||
         path_eq_clean(path, "/api/lan-health") || (lan_on && lan_web_tool_path(path)))) return 1;
    if (get && (remote_page_path(path) || lan_root_path(path))) return 1;
    if (get && (path_eq_clean(path, "/api/remote/status") || path_eq_clean(path, "/api/remote/chat"))) return 1;
    if (get && path_eq_clean(path, "/api/lan-health")) return 1;
    if (!strcmp(method, "POST") && path_eq_clean(path, "/api/remote/chat")) return 1;
    if (!strcmp(method, "POST") && path_eq_clean(path, "/api/lan-client/chats")) return 1;
    if (lan_on && !strcmp(method, "POST") && lan_web_tool_path(path)) return 1;
    if (lan_on && !strncmp(path, "/v1/", 4)) return 1;
    return 0;
}

static int web_url_ok(const char *url) {
    return url && (!strncmp(url, "http://", 7) || !strncmp(url, "https://", 8));
}

static int web_sources_push(web_source_list *list, const char *title, size_t tl, const char *url, size_t ul) {
    if (list->len >= list->cap) {
        int nc = list->cap ? list->cap * 2 : 16;
        web_source *np = realloc(list->items, (size_t)nc * sizeof *np);
        if (!np) return 0;
        list->items = np;
        list->cap = nc;
    }
    web_source *s = &list->items[list->len];
    memset(s, 0, sizeof *s);
    if (tl >= sizeof s->title) tl = sizeof s->title - 1;
    if (ul >= sizeof s->url) ul = sizeof s->url - 1;
    memcpy(s->title, title, tl); s->title[tl] = '\0';
    memcpy(s->url, url, ul); s->url[ul] = '\0';
    list->len++;
    return 1;
}

static int web_sources_parse_links(const char *md, web_source_list *sources) {
    const char *p = md ? md : "";
    while ((p = strstr(p, "- [")) != NULL) {
        const char *ts = p + 3;
        const char *mid = strstr(ts, "](");
        if (!mid) { p += 3; continue; }
        const char *us = mid + 2;
        const char *ue = strchr(us, ')');
        if (!ue) { p = us; continue; }
        size_t tl = (size_t)(mid - ts);
        size_t ul = (size_t)(ue - us);
        if (tl > 0 && ul > 0 && tl < sizeof(((web_source *)0)->title) && ul < sizeof(((web_source *)0)->url)) {
            char url[1024];
            memcpy(url, us, ul); url[ul] = '\0';
            if (web_url_ok(url)) {
                int dup = 0;
                for (int i = 0; i < sources->len; i++) if (!strcmp(sources->items[i].url, url)) dup = 1;
                if (!dup) {
                    if (!web_sources_push(sources, ts, tl, us, ul)) return 0;
                }
            }
        }
        p = ue + 1;
    }
    return 1;
}

static char *web_markdown_excerpt(const char *md, size_t cap) {
    const char *p = md ? strstr(md, "## Content") : NULL;
    p = p ? p + strlen("## Content") : (md ? md : "");
    while (*p == '\n' || *p == '\r' || *p == ' ' || *p == '\t') p++;
    size_t n = strlen(p);
    if (n > cap) n = cap;
    while (n && (p[n - 1] == '\n' || p[n - 1] == '\r' || p[n - 1] == ' ' || p[n - 1] == '\t')) n--;
    return ds4_strndup_local(p, n);
}

static char *web_strndup_cap(const char *s, size_t n, size_t cap);
static int web_starts_ci(const char *s, const char *prefix);

static char *web_markdown_title(const char *md) {
    const char *p = md ? md : "";
    while (*p) {
        const char *line = p;
        const char *end = strpbrk(line, "\r\n");
        size_t n = end ? (size_t)(end - line) : strlen(line);
        if (n > 2 && line[0] == '#' && line[1] == ' ') {
            line += 2;
            n -= 2;
            while (n && isspace((unsigned char)*line)) { line++; n--; }
            while (n && isspace((unsigned char)line[n - 1])) n--;
            if (n) return web_strndup_cap(line, n, 240);
        }
        p = end ? end + ((*end == '\r' && end[1] == '\n') ? 2 : 1) : line + n;
    }
    return strdup("Page");
}

static char *web_markdown_canonical_url(const char *md, const char *fallback) {
    const char *p = md ? md : "";
    while (*p) {
        const char *line = p;
        const char *end = strpbrk(line, "\r\n");
        size_t n = end ? (size_t)(end - line) : strlen(line);
        if (n > 4 && web_starts_ci(line, "URL:")) {
            line += 4;
            n -= 4;
            while (n && isspace((unsigned char)*line)) { line++; n--; }
            while (n && isspace((unsigned char)line[n - 1])) n--;
            if (n) return web_strndup_cap(line, n, 2048);
        }
        p = end ? end + ((*end == '\r' && end[1] == '\n') ? 2 : 1) : line + n;
    }
    return strdup(fallback ? fallback : "");
}

static const char *web_last_header_split(const char *s);

static int web_starts_ci(const char *s, const char *prefix) {
    while (*prefix) {
        if (tolower((unsigned char)*s++) != tolower((unsigned char)*prefix++)) return 0;
    }
    return 1;
}

static const char *web_find_ci(const char *s, const char *needle) {
    if (!s || !needle || !needle[0]) return NULL;
    for (const char *p = s; *p; p++) {
        if (tolower((unsigned char)*p) == tolower((unsigned char)needle[0]) &&
            web_starts_ci(p, needle)) return p;
    }
    return NULL;
}

static const char *web_skip_block_tag(const char *p, const char *tag) {
    char open[48], close[48];
    snprintf(open, sizeof open, "<%s", tag);
    snprintf(close, sizeof close, "</%s>", tag);
    if (!web_starts_ci(p, open)) return NULL;
    const char *end = web_find_ci(p, close);
    return end ? end + strlen(close) : p + 1;
}

static char *web_html_text_excerpt(const char *raw, size_t cap) {
    const char *p = web_last_header_split(raw ? raw : "");
    if (!p) p = raw ? raw : "";
    char *out = malloc(cap + 1);
    if (!out) return NULL;
    size_t o = 0;
    int space = 1;
    while (*p && o + 1 < cap) {
        if (*p == '<') {
            const char *skip = NULL;
            const char *skip_tags[] = { "script", "style", "nav", "footer", "aside", "svg", "noscript", "form" };
            for (size_t i = 0; i < sizeof skip_tags / sizeof skip_tags[0]; i++) {
                skip = web_skip_block_tag(p, skip_tags[i]);
                if (skip) break;
            }
            if (skip) {
                p = skip;
                if (!space && o + 1 < cap) { out[o++] = ' '; space = 1; }
                continue;
            }
            const char *gt = strchr(p, '>');
            p = gt ? gt + 1 : p + 1;
            if (!space && o + 1 < cap) { out[o++] = ' '; space = 1; }
            continue;
        }
        unsigned char c = (unsigned char)*p++;
        if (c == '&') {
            if (!strncmp(p, "amp;", 4)) { c = '&'; p += 4; }
            else if (!strncmp(p, "lt;", 3)) { c = '<'; p += 3; }
            else if (!strncmp(p, "gt;", 3)) { c = '>'; p += 3; }
            else if (!strncmp(p, "quot;", 5)) { c = '"'; p += 5; }
            else if (!strncmp(p, "apos;", 5)) { c = '\''; p += 5; }
            else if (!strncmp(p, "nbsp;", 5)) { c = ' '; p += 5; }
            else c = ' ';
        }
        if (c < 0x20 || c == 0x7f || c == ' ' || c == '\n' || c == '\r' || c == '\t') {
            if (!space && o + 1 < cap) out[o++] = ' ';
            space = 1;
            continue;
        }
        out[o++] = (char)c;
        space = 0;
    }
    while (o && out[o - 1] == ' ') o--;
    out[o] = '\0';
    return out;
}

static const char *web_guess_source_kind(const char *url, const char *title, const char *text) {
    char blob[4096];
    snprintf(blob, sizeof blob, "%s %s %s", url ? url : "", title ? title : "", text ? text : "");
    if (web_find_ci(blob, "repository") || web_find_ci(blob, "source code") ||
        web_find_ci(blob, "readme") || web_find_ci(blob, "package.json") ||
        web_find_ci(blob, "makefile") || web_find_ci(blob, "pyproject.toml") ||
        web_find_ci(blob, "cargo.toml") || web_find_ci(blob, "go.mod") ||
        web_find_ci(blob, "github.") || web_find_ci(blob, "gitlab.") ||
        web_find_ci(blob, "bitbucket.") || web_find_ci(blob, "codeberg.org")) return "repo";
    if (web_find_ci(blob, "arxiv") || web_find_ci(blob, "doi") ||
        web_find_ci(blob, "pubmed") || web_find_ci(blob, "journal") ||
        web_find_ci(blob, "conference") || web_find_ci(blob, "abstract")) return "academic";
    if (web_find_ci(blob, "reddit.com") || web_find_ci(blob, "news.ycombinator.com") ||
        web_find_ci(blob, "twitter.com") || web_find_ci(blob, "x.com") ||
        web_find_ci(blob, "youtube.com") || web_find_ci(blob, "thread") ||
        web_find_ci(blob, "comments")) return "social";
    if (web_find_ci(blob, "/docs") || web_find_ci(blob, "documentation") ||
        web_find_ci(blob, "api reference") || web_find_ci(blob, "quickstart") ||
        web_find_ci(blob, "manual")) return "docs";
    if (web_find_ci(blob, "/pricing") || web_find_ci(blob, "/features") ||
        web_find_ci(blob, "/product") || web_find_ci(blob, "plans") ||
        web_find_ci(blob, "customers") || web_find_ci(blob, "enterprise")) return "product";
    if (web_find_ci(blob, "/blog/") || web_find_ci(blob, "/news/") ||
        web_find_ci(blob, "published") || web_find_ci(blob, "press release")) return "article";
    return "generic";
}

static void web_sources_free(web_source_list *sources) {
    if (!sources) return;
    for (int i = 0; i < sources->len; i++) free(sources->items[i].content);
    free(sources->items);
    sources->items = NULL;
    sources->len = 0;
    sources->cap = 0;
}

static void web_json_error(int fd, const char *status, const char *msg) {
    json_dyn_buf b = {0};
    if (!json_dyn_puts(&b, "{\"ok\":false,\"error\":") ||
        !json_dyn_put_escaped(&b, msg ? msg : "web search failed") ||
        !json_dyn_puts(&b, "}")) {
        free(b.ptr);
        send_json(fd, "500 Internal Server Error", "{\"ok\":false,\"error\":\"out of memory\"}");
        return;
    }
    send_json(fd, status, b.ptr);
    free(b.ptr);
}

static long long web_now_ms(void);

static char *web_curl_capture(char *const argv[], int timeout_ms, int *exit_status) {
#ifdef _WIN32
    (void)argv; (void)timeout_ms; (void)exit_status;
    return NULL;
#else
    int pfd[2];
    if (pipe(pfd) != 0) return NULL;
    pid_t pid = fork();
    if (pid < 0) { close(pfd[0]); close(pfd[1]); return NULL; }
    if (pid == 0) {
        dup2(pfd[1], STDOUT_FILENO);
        dup2(pfd[1], STDERR_FILENO);
        close(pfd[0]); close(pfd[1]);
        int dn = open("/dev/null", O_RDONLY);
        if (dn >= 0) { dup2(dn, STDIN_FILENO); close(dn); }
        execvp("curl", argv);
        _exit(127);
    }
    close(pfd[1]);
    int flags = fcntl(pfd[0], F_GETFL, 0);
    if (flags >= 0) (void)fcntl(pfd[0], F_SETFL, flags | O_NONBLOCK);
    json_dyn_buf out = {0};
    char buf[8192];
    int st = 0, done = 0, killed = 0, reaped = 0;
    long long deadline = web_now_ms() + (timeout_ms > 0 ? timeout_ms : 20000);
    while (!done) {
        ssize_t r;
        while ((r = read(pfd[0], buf, sizeof buf)) > 0) {
            if (out.len + (size_t)r > 768 * 1024) {
                killed = 1;
                kill(pid, SIGKILL);
                break;
            }
            if (!json_dyn_putn(&out, buf, (size_t)r)) {
                free(out.ptr);
                out.ptr = NULL;
                killed = 1;
                kill(pid, SIGKILL);
                break;
            }
        }
        if (killed) break;
        if (r == 0) { done = 1; break; }
        if (r < 0 && errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR) break;
        pid_t wp = waitpid(pid, &st, WNOHANG);
        if (wp == pid) {
            reaped = 1;
            done = 1;
            while ((r = read(pfd[0], buf, sizeof buf)) > 0) {
                if (out.len + (size_t)r > 768 * 1024) break;
                if (!json_dyn_putn(&out, buf, (size_t)r)) { free(out.ptr); out.ptr = NULL; break; }
            }
            break;
        }
        if (wp < 0 && errno != EINTR) break;
        long long left = deadline - web_now_ms();
        if (left <= 0) {
            killed = 1;
            kill(pid, SIGKILL);
            break;
        }
        struct pollfd pf = { pfd[0], POLLIN | POLLHUP, 0 };
        int wait_ms = left > 250 ? 250 : (int)left;
        (void)poll(&pf, 1, wait_ms);
    }
    close(pfd[0]);
    if (killed) kill(pid, SIGKILL);
    if (!reaped) waitpid(pid, &st, 0);
    if (killed) {
        free(out.ptr);
        if (exit_status) *exit_status = 124;
        return strdup("");
    }
    if (exit_status) *exit_status = WIFEXITED(st) ? WEXITSTATUS(st) : 127;
    return out.ptr ? out.ptr : strdup("");
#endif
}

static char *web_curl_visit_page(const char *url, char *err, size_t err_len) {
#ifdef _WIN32
    (void)url; (void)err; (void)err_len;
    return NULL;
#else
    char *argv[20];
    int n = 0;
    argv[n++] = "curl";
    argv[n++] = "-sS";
    argv[n++] = "-L";
    argv[n++] = "--compressed";
    argv[n++] = "-i";
    argv[n++] = "--max-redirs"; argv[n++] = "8";
    argv[n++] = "--connect-timeout"; argv[n++] = "12";
    argv[n++] = "--max-time"; argv[n++] = "45";
    argv[n++] = "-A"; argv[n++] = "Mozilla/5.0 DStudio/1.0";
    argv[n++] = "-w"; argv[n++] = "\n__DSTUDIO_CURL_META__%{http_code} %{url_effective}\n";
    argv[n++] = (char *)url;
    argv[n] = NULL;

    int st = 0;
    char *raw = web_curl_capture(argv, 60000, &st);
    if (!raw) {
        snprintf(err, err_len, "curl failed to start");
        return NULL;
    }
    int status = 0;
    char final_url[2048] = "";
    char *marker = strstr(raw, "\n__DSTUDIO_CURL_META__");
    if (marker) {
        *marker = '\0';
        const char *meta = marker + strlen("\n__DSTUDIO_CURL_META__");
        char *end = NULL;
        long code = strtol(meta, &end, 10);
        if (code >= 0 && code <= 999) status = (int)code;
        while (end && (*end == ' ' || *end == '\t')) end++;
        if (end) {
            size_t fl = strcspn(end, "\r\n");
            if (fl >= sizeof final_url) fl = sizeof final_url - 1;
            memcpy(final_url, end, fl); final_url[fl] = '\0';
        }
    }
    char *text = web_html_text_excerpt(raw, 24000);
    free(raw);
    if (!text || strlen(text) < 24) {
        snprintf(err, err_len, "%s", st == 124 ? "curl timed out" :
                 st != 0 ? "curl returned no readable text" : "page returned no readable text");
        free(text);
        return NULL;
    }
    json_dyn_buf md = {0};
    int ok = json_dyn_puts(&md, "# Page\n\nURL: ") &&
             json_dyn_puts(&md, final_url[0] ? final_url : url) &&
             json_dyn_puts(&md, "\n") &&
             (status ? json_dyn_printf(&md, "\nHTTP status: %d\n", status) : 1) &&
             json_dyn_puts(&md, "\n## Content\n\n") &&
             json_dyn_puts(&md, text);
    free(text);
    if (!ok) {
        free(md.ptr);
        snprintf(err, err_len, "out of memory");
        return NULL;
    }
    return md.ptr;
#endif
}

static const char *web_last_header_split(const char *s) {
    const char *last = NULL;
    for (const char *p = s; p && *p; ) {
        const char *a = strstr(p, "\r\n\r\n");
        const char *b = strstr(p, "\n\n");
        const char *hit = NULL;
        if (a && b) hit = a < b ? a : b;
        else hit = a ? a : b;
        if (!hit) break;
        last = hit + (hit[0] == '\r' ? 4 : 2);
        p = last;
    }
    return last;
}

static char *web_strndup_cap(const char *s, size_t n, size_t cap) {
    if (!s) s = "";
    if (n > cap) n = cap;
    return ds4_strndup_local(s, n);
}

static long long web_now_ms(void) {
#ifdef _WIN32
    return (long long)GetTickCount64();
#else
    struct timeval tv;
    gettimeofday(&tv, NULL);
    return (long long)tv.tv_sec * 1000LL + (long long)(tv.tv_usec / 1000);
#endif
}

static char *web_helper_capture(const char *tool, const char *arg_kind, const char *arg_value,
                                int timeout_ms, int *exit_status) {
#ifdef _WIN32
    (void)tool; (void)arg_kind; (void)arg_value; (void)timeout_ms; (void)exit_status;
    return NULL;
#else
    static int web_helper_ready = 0;
    if (!web_helper_ready) {
        if (!run_build_jsonl("build")) return NULL;
        web_helper_ready = 1;
    }
    int pfd[2];
    if (pipe(pfd) != 0) return NULL;
    pid_t pid = fork();
    if (pid < 0) { close(pfd[0]); close(pfd[1]); return NULL; }
    if (pid == 0) {
        if (chdir(g_ds4_dir) != 0) _exit(127);
        dup2(pfd[1], STDOUT_FILENO);
        close(pfd[0]); close(pfd[1]);
        int dn = open("/dev/null", O_RDONLY);
        if (dn >= 0) { dup2(dn, STDIN_FILENO); close(dn); }
        char *argv[8]; int n = 0;
        argv[n++] = "./ds4-agent-jsonl";
        argv[n++] = "--web-tool"; argv[n++] = (char *)tool;
        argv[n++] = (char *)arg_kind; argv[n++] = (char *)arg_value;
        argv[n] = NULL;
        execv("./ds4-agent-jsonl", argv);
        _exit(127);
    }
    close(pfd[1]);
    int flags = fcntl(pfd[0], F_GETFL, 0);
    if (flags >= 0) (void)fcntl(pfd[0], F_SETFL, flags | O_NONBLOCK);
    json_dyn_buf out = {0};
    char buf[8192];
    int st = 0, done = 0, killed = 0, reaped = 0;
    long long deadline = web_now_ms() + (timeout_ms > 0 ? timeout_ms : WEB_HELPER_SEARCH_TIMEOUT_MS);
    while (!done) {
        ssize_t r;
        while ((r = read(pfd[0], buf, sizeof buf)) > 0) {
            if (out.len + (size_t)r > 2 * 1024 * 1024) {
                killed = 1;
                kill(pid, SIGKILL);
                break;
            }
            if (!json_dyn_putn(&out, buf, (size_t)r)) {
                free(out.ptr);
                out.ptr = NULL;
                killed = 1;
                kill(pid, SIGKILL);
                break;
            }
        }
        if (killed) break;
        if (r == 0) { done = 1; break; }
        if (r < 0 && errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR) break;

        pid_t wp = waitpid(pid, &st, WNOHANG);
        if (wp == pid) {
            reaped = 1;
            done = 1;
            while ((r = read(pfd[0], buf, sizeof buf)) > 0) {
                if (out.len + (size_t)r > 2 * 1024 * 1024) break;
                if (!json_dyn_putn(&out, buf, (size_t)r)) { free(out.ptr); out.ptr = NULL; break; }
            }
            break;
        }
        if (wp < 0 && errno != EINTR) break;

        long long left = deadline - web_now_ms();
        if (left <= 0) {
            killed = 1;
            kill(pid, SIGKILL);
            break;
        }
        struct pollfd pf = { pfd[0], POLLIN | POLLHUP, 0 };
        int wait_ms = left > 250 ? 250 : (int)left;
        (void)poll(&pf, 1, wait_ms);
    }
    close(pfd[0]);
    if (killed) kill(pid, SIGKILL);
    if (!reaped) waitpid(pid, &st, 0);
    if (killed) {
        free(out.ptr);
        if (exit_status) *exit_status = 124;
        return strdup("{\"error\":\"web helper timed out\"}");
    }
    if (exit_status) *exit_status = WIFEXITED(st) ? WEXITSTATUS(st) : 127;
    return out.ptr ? out.ptr : ds4_strdup_local("");
#endif
}

static void api_http_probe_run(int fd, const char *body) {
    char url[2048], method[16];
    method[0] = '\0';
    if (!json_get_string(body, "url", url, sizeof url) || !url[0]) {
        web_json_error(fd, "400 Bad Request", "url is required");
        return;
    }
    if (!web_url_ok(url)) {
        web_json_error(fd, "400 Bad Request", "url must be http or https");
        return;
    }
    if (!json_get_string(body, "method", method, sizeof method) || !method[0]) cstr_copy(method, sizeof method, "HEAD");
    for (char *p = method; *p; p++) *p = (char)toupper((unsigned char)*p);
    if (strcmp(method, "HEAD") && strcmp(method, "GET")) {
        web_json_error(fd, "400 Bad Request", "method must be HEAD or GET");
        return;
    }
#ifdef _WIN32
    web_json_error(fd, "501 Not Implemented", "http probe is not available in the Windows build yet");
    return;
#else
    char *argv[18];
    int n = 0;
    argv[n++] = "curl";
    argv[n++] = "-sS";
    argv[n++] = "-L";
    argv[n++] = !strcmp(method, "HEAD") ? "-I" : "-i";
    argv[n++] = "--max-redirs"; argv[n++] = "6";
    argv[n++] = "--connect-timeout"; argv[n++] = "8";
    argv[n++] = "--max-time"; argv[n++] = "24";
    argv[n++] = "-A"; argv[n++] = "DStudio/1.0";
    argv[n++] = "-w"; argv[n++] = "\n__DSTUDIO_CURL_META__%{http_code} %{url_effective}\n";
    argv[n++] = url;
    argv[n] = NULL;

    int st = 0;
    char *raw = web_curl_capture(argv, 30000, &st);
    if (!raw) {
        web_json_error(fd, "500 Internal Server Error", "curl failed to start");
        return;
    }
    int status = 0;
    char final_url[2048] = "";
    char *marker = strstr(raw, "\n__DSTUDIO_CURL_META__");
    if (marker) {
        *marker = '\0';
        const char *meta = marker + strlen("\n__DSTUDIO_CURL_META__");
        char *end = NULL;
        long code = strtol(meta, &end, 10);
        if (code >= 0 && code <= 999) status = (int)code;
        while (end && (*end == ' ' || *end == '\t')) end++;
        if (end) {
            size_t fl = strcspn(end, "\r\n");
            if (fl >= sizeof final_url) fl = sizeof final_url - 1;
            memcpy(final_url, end, fl); final_url[fl] = '\0';
        }
    }

    size_t raw_len = strlen(raw);
    const char *body_start = !strcmp(method, "GET") ? web_last_header_split(raw) : NULL;
    if (!body_start) body_start = raw + raw_len;
    size_t header_len = (size_t)(body_start - raw);
    char *headers = web_strndup_cap(raw, header_len, 160 * 1024);
    char *excerpt = web_strndup_cap(body_start, strlen(body_start), 24000);

    json_dyn_buf out = {0};
    int ok = json_dyn_puts(&out, "{\"ok\":true,\"method\":") &&
             json_dyn_put_escaped(&out, method) &&
             json_dyn_puts(&out, ",\"url\":") &&
             json_dyn_put_escaped(&out, url) &&
             json_dyn_puts(&out, ",\"finalUrl\":") &&
             json_dyn_put_escaped(&out, final_url[0] ? final_url : url) &&
             json_dyn_printf(&out, ",\"status\":%d,\"exitStatus\":%d,\"rawBytes\":%zu,\"headers\":", status, st, raw_len) &&
             json_dyn_put_escaped(&out, headers ? headers : "") &&
             json_dyn_puts(&out, ",\"bodyExcerpt\":") &&
             json_dyn_put_escaped(&out, excerpt ? excerpt : "") &&
             json_dyn_puts(&out, "}");
    free(headers);
    free(excerpt);
    free(raw);
    if (!ok) { free(out.ptr); web_json_error(fd, "500 Internal Server Error", "out of memory"); return; }
    send_json(fd, "200 OK", out.ptr);
    free(out.ptr);
#endif
}

static void api_http_probe(int fd, const char *body) {
#ifdef _WIN32
    api_http_probe_run(fd, body);
    return;
#else
    pid_t pid = fork();
    if (pid < 0) {
        api_http_probe_run(fd, body);
        return;
    }
    if (pid == 0) {
        if (fork() > 0) _exit(0);
        if (g_srv_fd >= 0) close(g_srv_fd);
        if (g_out_fd >= 0) close(g_out_fd);
        if (g_err_fd >= 0) close(g_err_fd);
        if (g_in_fd  >= 0) close(g_in_fd);
        struct timeval tv = { 45, 0 };
        (void)setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof tv);
        api_http_probe_run(fd, body);
        close(fd);
        _exit(0);
    }
    waitpid(pid, NULL, 0);
#endif
}

static void api_web_search_run(int fd, const char *body) {
    char query[2048];
    if (!json_get_string(body, "query", query, sizeof query) || !query[0]) {
        web_json_error(fd, "400 Bad Request", "query is required");
        return;
    }
#ifdef _WIN32
    web_json_error(fd, "501 Not Implemented", "web search helper is not available in the Windows build yet");
    return;
#else
    int st = 0;
    char *search_json = web_helper_capture("google_search", "--query", query, WEB_HELPER_SEARCH_TIMEOUT_MS, &st);
    if (!search_json || !search_json[0]) {
        free(search_json);
        web_json_error(fd, "500 Internal Server Error", "web search helper failed to start");
        return;
    }
    char *search_err = json_get_string_alloc(search_json, "error");
    char *search_md = json_get_string_alloc(search_json, "markdown");
    if (!search_md) {
        char msg[512];
        snprintf(msg, sizeof msg, "%s", search_err && search_err[0] ? search_err : "google_search returned no markdown");
        free(search_json); free(search_err);
        web_json_error(fd, st == 0 ? "502 Bad Gateway" : "500 Internal Server Error", msg);
        return;
    }
    web_source_list sources = {0};
    if (!web_sources_parse_links(search_md, &sources)) {
        free(search_json); free(search_err); free(search_md);
        web_json_error(fd, "500 Internal Server Error", "out of memory");
        return;
    }
    json_dyn_buf out = {0};
    int ok = json_dyn_puts(&out, "{\"ok\":true,\"query\":") &&
             json_dyn_put_escaped(&out, query) &&
             json_dyn_puts(&out, ",\"markdown\":") &&
             json_dyn_put_escaped(&out, search_md) &&
             json_dyn_puts(&out, ",\"sources\":[");
    for (int i = 0; ok && i < sources.len; i++) {
        ok = json_dyn_puts(&out, i ? ",{" : "{") &&
             json_dyn_puts(&out, "\"title\":") &&
             json_dyn_put_escaped(&out, sources.items[i].title) &&
             json_dyn_puts(&out, ",\"url\":") &&
             json_dyn_put_escaped(&out, sources.items[i].url) &&
             json_dyn_puts(&out, ",\"content\":") &&
             json_dyn_put_escaped(&out, sources.items[i].title);
        if (ok) ok = json_dyn_puts(&out, "}");
    }
    if (ok) ok = json_dyn_puts(&out, "]}");
    free(search_json); free(search_err); free(search_md); web_sources_free(&sources);
    if (!ok) { free(out.ptr); web_json_error(fd, "500 Internal Server Error", "out of memory"); return; }
    send_json(fd, "200 OK", out.ptr);
    free(out.ptr);
#endif
}

static void api_web_read_run(int fd, const char *body) {
    char url[2048];
    if (!json_get_string(body, "url", url, sizeof url) || !url[0]) {
        web_json_error(fd, "400 Bad Request", "url is required");
        return;
    }
    if (!web_url_ok(url)) {
        web_json_error(fd, "400 Bad Request", "url must be http or https");
        return;
    }
#ifdef _WIN32
    web_json_error(fd, "501 Not Implemented", "web read helper is not available in the Windows build yet");
    return;
#else
    int st = 0;
    int fallback_used = 0;
    char *visit_json = web_helper_capture("visit_page", "--url", url, WEB_HELPER_VISIT_TIMEOUT_MS, &st);
    char *visit_err = visit_json ? json_get_string_alloc(visit_json, "error") : NULL;
    char *visit_md = visit_json ? json_get_string_alloc(visit_json, "markdown") : NULL;
    if (!visit_md) {
        char curl_err[256] = "";
        visit_md = web_curl_visit_page(url, curl_err, sizeof curl_err);
        if (visit_md) {
            fallback_used = 1;
        } else {
            char msg[768];
            snprintf(msg, sizeof msg, "%s%s%s",
                     visit_err && visit_err[0] ? visit_err :
                     (visit_json && visit_json[0] ? "visit_page returned no markdown" : "web read helper failed to start"),
                     curl_err[0] ? "; curl fallback failed: " : "",
                     curl_err[0] ? curl_err : "");
            free(visit_json); free(visit_err);
            web_json_error(fd, st == 0 ? "502 Bad Gateway" : "500 Internal Server Error", msg);
            return;
        }
    }
    char *excerpt = web_markdown_excerpt(visit_md, 24000);
    char *title = web_markdown_title(visit_md);
    char *canonical = web_markdown_canonical_url(visit_md, url);
    const char *source_kind = web_guess_source_kind(canonical ? canonical : url, title ? title : "", excerpt ? excerpt : "");

    json_dyn_buf out = {0};
    int ok = json_dyn_puts(&out, "{\"ok\":true,\"url\":") &&
             json_dyn_put_escaped(&out, url) &&
             json_dyn_puts(&out, ",\"canonicalUrl\":") &&
             json_dyn_put_escaped(&out, canonical ? canonical : url) &&
             json_dyn_puts(&out, ",\"title\":") &&
             json_dyn_put_escaped(&out, title ? title : "Page") &&
             json_dyn_puts(&out, ",\"sourceKind\":") &&
             json_dyn_put_escaped(&out, source_kind) &&
             json_dyn_puts(&out, ",\"reader\":") &&
             json_dyn_put_escaped(&out, fallback_used ? "curl" : "browser") &&
             json_dyn_puts(&out, ",\"markdown\":") &&
             json_dyn_put_escaped(&out, visit_md) &&
             json_dyn_puts(&out, ",\"excerpt\":") &&
             json_dyn_put_escaped(&out, excerpt ? excerpt : "") &&
             json_dyn_puts(&out, ",\"metadata\":{") &&
             json_dyn_puts(&out, "\"markdownChars\":") &&
             json_dyn_printf(&out, "%zu", strlen(visit_md)) &&
             json_dyn_puts(&out, ",\"excerptChars\":") &&
             json_dyn_printf(&out, "%zu", excerpt ? strlen(excerpt) : 0) &&
             json_dyn_puts(&out, ",\"fallback\":") &&
             json_dyn_puts(&out, fallback_used ? "true" : "false") &&
             json_dyn_puts(&out, "},\"warnings\":[") &&
             (fallback_used
                ? (json_dyn_put_escaped(&out, "browser helper failed; used curl fallback"))
                : 1) &&
             json_dyn_puts(&out, "]") &&
             json_dyn_puts(&out, "}");
    free(visit_json); free(visit_err); free(visit_md); free(excerpt); free(title); free(canonical);
    if (!ok) { free(out.ptr); web_json_error(fd, "500 Internal Server Error", "out of memory"); return; }
    send_json(fd, "200 OK", out.ptr);
    free(out.ptr);
#endif
}

static void api_web_read(int fd, const char *body) {
#ifdef _WIN32
    api_web_read_run(fd, body);
    return;
#else
    pid_t pid = fork();
    if (pid < 0) {
        api_web_read_run(fd, body);
        return;
    }
    if (pid == 0) {
        if (fork() > 0) _exit(0);
        if (g_srv_fd >= 0) close(g_srv_fd);
        if (g_out_fd >= 0) close(g_out_fd);
        if (g_err_fd >= 0) close(g_err_fd);
        if (g_in_fd  >= 0) close(g_in_fd);
        struct timeval tv = { 120, 0 };
        (void)setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof tv);
        api_web_read_run(fd, body);
        close(fd);
        _exit(0);
    }
    waitpid(pid, NULL, 0);
#endif
}

/* POST /api/web-search {query} — zero-dependency web search for Chat. It reuses
 * ds4-agent's built-in Chrome/CDP web subsystem through a helper mode that does
 * not load the model. */
static void api_web_search(int fd, const char *body) {
#ifdef _WIN32
    api_web_search_run(fd, body);
    return;
#else
    pid_t pid = fork();
    if (pid < 0) {
        api_web_search_run(fd, body);
        return;
    }
    if (pid == 0) {
        if (fork() > 0) _exit(0);
        if (g_srv_fd >= 0) close(g_srv_fd);
        if (g_out_fd >= 0) close(g_out_fd);
        if (g_err_fd >= 0) close(g_err_fd);
        if (g_in_fd  >= 0) close(g_in_fd);
        struct timeval tv = { 300, 0 };
        (void)setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof tv);
        api_web_search_run(fd, body);
        close(fd);
        _exit(0);
    }
    waitpid(pid, NULL, 0);
#endif
}

/* Reverse-proxy for the engine's OpenAI API under /v1. The app normally talks to
 * serve same-origin; a LAN client app can also point baseUrl at another DStudio
 * host and use this proxy with CORS. The engine itself stays loopback-only. A
 * long chat completion would block serve's single-threaded loop, so the relay
 * runs in a double-forked (zombie-free) child that streams the response; it reads
 * the full request body itself, bypassing the small BODY_MAX used by /api. `req`
 * holds the request line + headers + the body bytes already buffered. */
static void api_v1_proxy(int client_fd, const char *method, const char *path,
                         const char *req, size_t got, size_t header_len, size_t clen) {
    int cors = !client_is_loopback(client_fd);
    int eport = (g_mode == ENGINE_SERVER) ? g_cfg.port : ENGINE_DEFAULTS.port;
    const char *eport_env = getenv("DS4UI_ENGINE_PORT");  /* override the engine port */
    if (eport_env && eport_env[0]) { int p = atoi(eport_env); if (p > 0 && p < 65536) eport = p; }
    int efd = socket(AF_INET, SOCK_STREAM, 0);
    if (efd >= 0) {
        struct sockaddr_in a;
        memset(&a, 0, sizeof a);
        a.sin_family = AF_INET;
        a.sin_port = htons((uint16_t)eport);
        a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
        if (connect(efd, (struct sockaddr *)&a, sizeof a) != 0) { close(efd); efd = -1; }
    }
    if (efd < 0) {
        const char *body = "{\"error\":{\"message\":\"the local ds4 engine is not running\"}}";
        if (cors) {
            static const char CORS_JSON_HEADERS[] =
                "Access-Control-Allow-Origin: *\r\n"
                "Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n"
                "Access-Control-Allow-Headers: Content-Type, Accept, X-Requested-With\r\n";
            send_response_hdrs(client_fd, "503 Service Unavailable", "application/json; charset=utf-8",
                               body, strlen(body), 0, CORS_JSON_HEADERS);
        } else {
            send_json(client_fd, "503 Service Unavailable", body);
        }
        return;
    }
#ifdef _WIN32
    char head[1024];
    int hn = (clen > 0)
        ? snprintf(head, sizeof head,
            "%s %s HTTP/1.1\r\nHost: 127.0.0.1:%d\r\nAccept: text/event-stream\r\n"
            "Content-Type: application/json\r\nContent-Length: %zu\r\nConnection: close\r\n\r\n",
            method, path, eport, clen)
        : snprintf(head, sizeof head,
            "%s %s HTTP/1.1\r\nHost: 127.0.0.1:%d\r\nAccept: application/json\r\nConnection: close\r\n\r\n",
            method, path, eport);
    char buf[16384];
    ssize_t n;
    int ok = (hn > 0 && send_all(efd, head, (size_t)hn) == 0);
    size_t have = got - header_len;
    if (ok && have > 0) ok = (send_all(efd, req + header_len, have) == 0);
    size_t left = clen > have ? clen - have : 0;
    while (ok && left > 0) {
        n = recv(client_fd, buf, left < sizeof buf ? left : sizeof buf, 0);
        if (n <= 0) { ok = 0; break; }
        if (send_all(efd, buf, (size_t)n) != 0) { ok = 0; break; }
        left -= (size_t)n;
    }
    if (ok) relay_engine_response(client_fd, efd, cors);
    close(efd);
    return;
#else
    pid_t pid = fork();
    if (pid < 0) { close(efd); send_json(client_fd, "500 Internal Server Error", "{\"error\":\"proxy fork\"}"); return; }
    if (pid == 0) {
        if (fork() > 0) _exit(0);   /* double-fork: the relay is reparented + auto-reaped */
        /* the relay only needs efd + client_fd; drop the inherited serve fds */
        if (g_srv_fd >= 0) close(g_srv_fd);
        if (g_out_fd >= 0) close(g_out_fd);
        if (g_err_fd >= 0) close(g_err_fd);
        if (g_in_fd  >= 0) close(g_in_fd);
        struct timeval tv = { 600, 0 };
        (void)setsockopt(efd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof tv);
        (void)setsockopt(client_fd, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof tv);
        /* request line + minimal headers (Connection: close → the engine ends the
         * stream with EOF), then the body (buffered part + the rest off the wire) */
        char head[1024];
        int hn = (clen > 0)
            ? snprintf(head, sizeof head,
                "%s %s HTTP/1.1\r\nHost: 127.0.0.1:%d\r\nAccept: text/event-stream\r\n"
                "Content-Type: application/json\r\nContent-Length: %zu\r\nConnection: close\r\n\r\n",
                method, path, eport, clen)
            : snprintf(head, sizeof head,
                "%s %s HTTP/1.1\r\nHost: 127.0.0.1:%d\r\nAccept: application/json\r\nConnection: close\r\n\r\n",
                method, path, eport);
        char buf[16384];
        ssize_t n;
        int ok = (hn > 0 && send_all(efd, head, (size_t)hn) == 0);
        size_t have = got - header_len;                 /* body bytes already read */
        if (ok && have > 0) ok = (send_all(efd, req + header_len, have) == 0);
        size_t left = clen > have ? clen - have : 0;     /* body bytes still on the wire */
        while (ok && left > 0) {
            n = recv(client_fd, buf, left < sizeof buf ? left : sizeof buf, 0);
            if (n <= 0) { ok = 0; break; }
            if (send_all(efd, buf, (size_t)n) != 0) { ok = 0; break; }
            left -= (size_t)n;
        }
        if (ok) relay_engine_response(client_fd, efd, cors);
        close(efd);
        close(client_fd);
        _exit(0);
    }
    waitpid(pid, NULL, 0);   /* reap the immediately-exiting first child */
    close(efd);              /* parent's copy; the relay grandchild has its own */
#endif
}

/* ==================== handling a connection ==================== */

static void handle_connection(int fd) {
    g_reply_cors = 0;
#ifdef _WIN32
    int tv = IO_TIMEOUT_S * 1000;
    (void)setsockopt((SOCKET)(intptr_t)fd, SOL_SOCKET, SO_RCVTIMEO, (const char *)&tv, sizeof tv);
    (void)setsockopt((SOCKET)(intptr_t)fd, SOL_SOCKET, SO_SNDTIMEO, (const char *)&tv, sizeof tv);
#else
    struct timeval tv = { IO_TIMEOUT_S, 0 };
    (void)setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof tv);
    (void)setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof tv);
#endif

    char req[REQ_BUF + 1];
    size_t got = 0;
    char *hdr_end = NULL;
    while (got < REQ_BUF) {
        ssize_t n = recv(fd, req + got, REQ_BUF - got, 0);
        if (n <= 0) break;
        got += (size_t)n;
        req[got] = '\0';
        if ((hdr_end = strstr(req, "\r\n\r\n")) != NULL) break;
    }
    if (!hdr_end) { close(fd); return; }
    size_t header_len = (size_t)(hdr_end - req) + 4;

    long clen = content_length(req, header_len);

    char method[8] = {0}, path[1024] = {0};
    if (sscanf(req, "%7s %1023s", method, path) != 2) { send_text(fd, "400 Bad Request", "bad request\n", 0); close(fd); return; }
    sanitize(method); sanitize(path);
    int head_only_req = !strcmp(method, "HEAD");
    int local_client = client_is_loopback(fd);
    g_reply_cors = !local_client && lan_public_path_allowed(method, path);

    if (!local_client && (!strcmp(method, "GET") || head_only_req) && loading_page_path(path)) {
        send_redirect(fd, "/", head_only_req);
        close(fd);
        return;
    }

    if (!strcmp(method, "OPTIONS") && lan_public_path_allowed(method, path)) {
        send_cors_options(fd);
        close(fd);
        return;
    }

    if (!local_client && !lan_public_path_allowed(method, path)) {
        send_json(fd, "403 Forbidden", "{\"ok\":false,\"error\":\"endpoint is host-local only\"}");
        close(fd);
        return;
    }

    if ((!strcmp(method, "GET") || head_only_req) && remote_page_path(path)) {
        serve_remote_page(fd, head_only_req);
        close(fd);
        return;
    }

    /* POST /api/remote/chat carries the exposed remote conversation and can be
     * larger than BODY_MAX, like the local store. It is separate from /api/store. */
    if (!strcmp(method, "POST") && path_eq_clean(path, "/api/remote/chat")) {
        if (!header_has(req, header_len, "x-requested-with: ds4web")) {
            send_json(fd, "403 Forbidden", "{\"ok\":false,\"error\":\"unauthorized\"}"); close(fd); return;
        }
        if (clen < 0 || clen > 8L * 1024 * 1024) { send_text(fd, "413 Payload Too Large", "remote chat too large\n", 0); close(fd); return; }
        char *buf = malloc((size_t)clen + 1);
        if (!buf) { send_json(fd, "500 Internal Server Error", "{\"ok\":false}"); close(fd); return; }
        size_t have = got - header_len; if (have > (size_t)clen) have = (size_t)clen;
        memcpy(buf, req + header_len, have);
        size_t off = have, left = (size_t)clen - have;
        while (left > 0) {
            ssize_t n = recv(fd, buf + off, left, 0);
            if (n <= 0) break;
            off += (size_t)n; left -= (size_t)n;
        }
        buf[off] = '\0';
        api_remote_chat_set(fd, buf, off, local_client);
        close(fd);
        return;
    }

    /* LAN clients keep their own local stores and publish snapshots here so the
     * host can inspect their chat/agent/design conversations. This endpoint is
     * intentionally separate from /api/store: non-loopback clients can POST
     * their snapshot, but only the host-local UI can GET the aggregate. */
    if (!strcmp(method, "POST") && path_eq_clean(path, "/api/lan-client/chats")) {
        if (clen < 0 || clen > 16L * 1024 * 1024) {
            send_text(fd, "413 Payload Too Large", "LAN client snapshot too large\n", 0);
            close(fd);
            return;
        }
        char *buf = malloc((size_t)clen + 1);
        if (!buf) { send_json_cors(fd, "500 Internal Server Error", "{\"ok\":false}"); close(fd); return; }
        size_t have = got - header_len; if (have > (size_t)clen) have = (size_t)clen;
        memcpy(buf, req + header_len, have);
        size_t off = have, left = (size_t)clen - have;
        while (left > 0) {
            ssize_t n = recv(fd, buf + off, left, 0);
            if (n <= 0) break;
            off += (size_t)n; left -= (size_t)n;
        }
        buf[off] = '\0';
        api_lan_client_chats_set(fd, buf, off);
        close(fd);
        return;
    }

    /* /v1 paths → reverse-proxy to the LOCAL engine (the page talks to serve
     * same-origin for the OpenAI API). The relay child streams the response and
     * reads the full request body itself, so it runs BEFORE the small BODY_MAX
     * cap used by /api (a long conversation would otherwise be rejected). The
     * parent closes its fd copy here; the forked relay keeps its own. */
    if (!strncmp(path, "/v1/", 4)) {
        api_v1_proxy(fd, method, path, req, got, header_len, (size_t)(clen < 0 ? 0 : clen));
        close(fd);
        return;
    }

    /* POST /api/store carries the whole chat history → can be large, so it also
     * runs before the small BODY_MAX cap, reading the full body into a buffer. */
    if (!strcmp(method, "POST") && !strcmp(path, "/api/store")) {
        if (!header_has(req, header_len, "x-requested-with: ds4web")) {
            send_json(fd, "403 Forbidden", "{\"ok\":false,\"error\":\"unauthorized\"}"); close(fd); return;
        }
        if (clen < 0 || clen > 64L * 1024 * 1024) { send_text(fd, "413 Payload Too Large", "store too large\n", 0); close(fd); return; }
        char *buf = malloc((size_t)clen + 1);
        if (!buf) { send_json(fd, "500 Internal Server Error", "{\"ok\":false}"); close(fd); return; }
        size_t have = got - header_len; if (have > (size_t)clen) have = (size_t)clen;
        memcpy(buf, req + header_len, have);
        size_t off = have, left = (size_t)clen - have;
        while (left > 0) {
            ssize_t n = recv(fd, buf + off, left, 0);
            if (n <= 0) break;
            off += (size_t)n; left -= (size_t)n;
        }
        buf[off] = '\0';
        api_store_set(fd, buf, off);   /* takes ownership of buf */
        close(fd);
        return;
    }

    if (clen < 0 || clen > BODY_MAX) { send_text(fd, "413 Payload Too Large", "body too large\n", 0); close(fd); return; }
    while (got < header_len + (size_t)clen && got < REQ_BUF) {
        ssize_t n = recv(fd, req + got, REQ_BUF - got, 0);
        if (n <= 0) break;
        got += (size_t)n;
    }
    req[got] = '\0';
    const char *body = req + header_len;

    int head_only = !strcmp(method, "HEAD");
    int status = 200;

    if (!strcmp(method, "POST") && !strncmp(path, "/api/", 5)) {
        if (!header_has(req, header_len, "x-requested-with: ds4web")) {
            send_json(fd, "403 Forbidden", "{\"ok\":false,\"error\":\"unauthorized\"}");
            status = 403;
        } else if (!strcmp(path, "/api/start"))       { api_start(fd, body); }
        else if (!strcmp(path, "/api/user-skills/delete")) { api_user_skill_delete(fd, body); }
        else if (!strcmp(path, "/api/user-skills"))   { api_user_skill_save(fd, body); }
        else if (!strcmp(path, "/api/stop"))          { api_stop(fd); }
        else if (!strcmp(path, "/api/agent/send"))    { api_agent_send(fd, body); }
        else if (!strcmp(path, "/api/agent/interrupt")) { api_agent_interrupt(fd); }
        else if (!strcmp(path, "/api/design/session")) { api_design_session(fd, body); }
        else if (!strcmp(path, "/api/design/clean")) { api_design_clean(fd); }
        else if (!strcmp(path, "/api/design/import")) { api_design_import(fd, body); }
        else if (!strcmp(path, "/api/build/write"))   { api_build_write(fd, body); }
        else if (!strcmp(path, "/api/model/download")) { api_model_download(fd, body); }
        else if (!strcmp(path, "/api/fs/list")) { api_fs_list(fd, body); }
        else if (!strcmp(path, "/api/fs/mkdir")) { api_fs_mkdir(fd, body); }
        else if (!strcmp(path, "/api/ds4dir"))       { api_set_ds4dir(fd, body); }
        else if (!strcmp(path, "/api/webdir"))       { api_set_webdir(fd, body); }
        else if (!strcmp(path, "/api/web-search"))   { api_web_search(fd, body); }
        else if (!strcmp(path, "/api/web-read"))     { api_web_read(fd, body); }
        else if (!strcmp(path, "/api/http-probe"))   { api_http_probe(fd, body); }
        else if (!strcmp(path, "/api/lan"))          { api_lan(fd, body); }
        else if (!strcmp(path, "/api/remote"))       { api_remote_control(fd, body); }
        else if (!strcmp(path, "/api/wipe"))         { api_wipe(fd); }
        else { send_json(fd, "404 Not Found", "{\"ok\":false,\"error\":\"unknown endpoint\"}"); status = 404; }
    } else if ((!strcmp(method, "GET") || head_only) && !strcmp(path, "/api/store")) {
        api_store_get(fd);
    } else if ((!strcmp(method, "GET") || head_only) && !strcmp(path, "/api/storerev")) {
        char out[48]; snprintf(out, sizeof out, "{\"rev\":%ld}", g_store_rev);  /* cheap poll */
        send_json(fd, "200 OK", out);
    } else if ((!strcmp(method, "GET") || head_only) && path_eq_clean(path, "/api/remote/status")) {
        api_remote_status(fd);
    } else if ((!strcmp(method, "GET") || head_only) && path_eq_clean(path, "/api/remote/chat")) {
        api_remote_chat_get(fd);
    } else if ((!strcmp(method, "GET") || head_only) && path_eq_clean(path, "/api/lan-client/chats")) {
        api_lan_client_chats_get(fd);
    } else if ((!strcmp(method, "GET") || head_only) && !strcmp(path, "/api/status")) {
        api_status(fd);
    } else if ((!strcmp(method, "GET") || head_only) && path_eq_clean(path, "/api/lan-health")) {
        api_lan_health(fd);
    } else if ((!strcmp(method, "GET") || head_only) && !strcmp(path, "/api/doctor")) {
        api_doctor(fd);
    } else if ((!strcmp(method, "GET") || head_only) && !strcmp(path, "/api/ggufs")) {
        api_ggufs(fd);
    } else if ((!strcmp(method, "GET") || head_only) && !strcmp(path, "/api/skills")) {
        api_skills(fd);
    } else if ((!strcmp(method, "GET") || head_only) && !strcmp(path, "/api/design-systems")) {
        api_design_systems(fd);
    } else if ((!strcmp(method, "GET") || head_only) && !strcmp(path, "/api/craft")) {
        api_craft(fd);
    } else if ((!strcmp(method, "GET") || head_only) && !strncmp(path, "/api/user-skills/get", 20)) {
        api_user_skill_get(fd, path);
    } else if ((!strcmp(method, "GET") || head_only) && !strcmp(path, "/api/user-skills")) {
        api_user_skills(fd);
    } else if ((!strcmp(method, "GET") || head_only) && !strncmp(path, "/api/agent/poll", 15)) {
        api_agent_poll(fd, path);
    } else if ((!strcmp(method, "GET") || head_only) && !strcmp(path, "/api/design/status")) {
        api_design_status(fd);
    } else if ((!strcmp(method, "GET") || head_only) && !strncmp(path, "/api/design/events", 18)) {
        api_design_events(fd, path);
    } else if ((!strcmp(method, "GET") || head_only) && !strcmp(path, "/api/design/state")) {
        api_design_state(fd);
    } else if ((!strcmp(method, "GET") || head_only) && !strcmp(path, "/api/design/artifacts")) {
        api_design_artifacts(fd);
    } else if ((!strcmp(method, "GET") || head_only) && !strcmp(path, "/api/design/files")) {
        /* before /file: it is a prefix of it */
        api_design_files(fd);
    } else if ((!strcmp(method, "GET") || head_only) && !strncmp(path, "/api/design/file?", 17)) {
        api_design_file(fd, path, head_only);
    } else if ((!strcmp(method, "GET") || head_only) && !strcmp(path, "/api/build/files")) {
        api_build_files(fd);   /* before /file: it is a prefix of it */
    } else if ((!strcmp(method, "GET") || head_only) && !strncmp(path, "/api/build/file?", 16)) {
        api_build_file(fd, path, head_only);
    } else if (!head_only && strcmp(method, "GET") != 0) {
        send_text(fd, "405 Method Not Allowed", "method not allowed\n", 0); status = 405;
    } else if (remote_page_path(path)) {
        serve_remote_page(fd, head_only);
    } else if (loading_page_path(path)) {
        size_t len = 0;
        char *page = read_loading_page(&len);
        if (!page) { send_text(fd, "500 Internal Server Error", "loading.html not readable\n", head_only); status = 500; }
        else { send_response(fd, "200 OK", "text/html; charset=utf-8", page, len, head_only); free(page); }
    } else if (lan_root_path(path)) {
        size_t len = 0;
        char *page = read_page(&len);
        if (!page) { send_text(fd, "500 Internal Server Error", "index.html not readable\n", head_only); status = 500; }
        else { send_response(fd, "200 OK", "text/html; charset=utf-8", page, len, head_only); free(page); }
    } else {
        send_text(fd, "404 Not Found", "not found\n", head_only); status = 404;
    }

    /* fd adopted by the SSE registry: the main loop owns it now */
    if (g_sse_adopt) { g_sse_adopt = 0; return; }

    /* compact log, I exclude polling so as not to flood the terminal */
    if (strncmp(path, "/api/agent/poll", 15) != 0 && strcmp(path, "/api/status") != 0 &&
        strcmp(path, "/api/design/status") != 0 && strcmp(path, "/api/design/files") != 0 &&
        strncmp(path, "/api/design/events", 18) != 0 &&
        strcmp(path, "/api/design/state") != 0 && strcmp(path, "/api/design/artifacts") != 0 &&
        strcmp(path, "/api/build/files") != 0 &&
        strcmp(path, "/api/store") != 0 && strcmp(path, "/api/storerev") != 0 &&
        strcmp(path, "/api/lan-client/chats") != 0 &&
        strcmp(path, "/api/lan-health") != 0 &&
        strcmp(path, "/api/doctor") != 0)
        printf("%d %s %s\n", status, method, path);
    close(fd);
}

/* ==================== main ==================== */

/* When the binary embeds the webview window (app.mm), main() lives there
 * and this function runs in the child process (HTTP server only). Compiling
 * dstudio.c on its own (without -DDS4_WITH_WEBVIEW) leaves a standalone main(). */
#ifdef DS4_WITH_WEBVIEW
int ds4_serve_main(int argc, char **argv)
#else
int main(int argc, char **argv)
#endif
{
#ifdef _WIN32
    setvbuf(stdout, NULL, _IONBF, 0);
#else
    setvbuf(stdout, NULL, _IOLBF, 0);   /* launcher log visible line by line */
#endif
    /* Batch mode: apply the jsonl patch and build ds4-agent-jsonl, then
     * exit. To test the patch without starting engine/HTTP: ./dstudio --build-jsonl [ds4-dir] */
    if (argc > 1 && strcmp(argv[1], "--build-jsonl") == 0) {
        if (argc > 2) snprintf(g_ds4_dir, sizeof g_ds4_dir, "%s", argv[2]);
        resolve_ds4_dir();
        resolve_web_dir();
        int ok = run_build_jsonl("build");
        printf("build-jsonl: %s\n", ok ? "ok" : "FAILED");
        return ok ? 0 : 1;
    }
    /* CI/dev: check the patch anchors against a ds4 checkout WITHOUT building
     * anything (no model, no .o). Exit 0 if the patch would apply, 1 otherwise. */
    if (argc > 1 && strcmp(argv[1], "--check-anchors") == 0) {
        if (argc > 2) snprintf(g_ds4_dir, sizeof g_ds4_dir, "%s", argv[2]);
        resolve_ds4_dir();
        resolve_web_dir();
        char src[2200], web_src[2200];
        snprintf(src, sizeof src, "%s/ds4_agent.c", g_ds4_dir);
        snprintf(web_src, sizeof web_src, "%s/ds4_web.c", g_ds4_dir);
        printf("check-anchors: ds4_agent.c = %s\n", src);
        int fails = jsonl_check_anchors(src);
        printf("check-anchors: ds4_web.c = %s\n", web_src);
        int web_fails = web_cdp_check_anchors(web_src);
        return fails == 0 && web_fails == 0 ? 0 : 1;
    }
    int port = DEFAULT_PORT;
    if (argc > 1) {
        char *end = NULL;
        long p = strtol(argv[1], &end, 10);
        if (end == argv[1] || *end != '\0' || p < 1 || p > 65535) {
            fprintf(stderr, "invalid port: %s\n", argv[1]); return 1;
        }
        port = (int)p;
    }
    if (argc > 2) snprintf(g_ds4_dir, sizeof g_ds4_dir, "%s", argv[2]);
    resolve_ds4_dir();   /* launch from Finder/bundle: cwd = "/", the relative one must be resolved */
    resolve_web_dir();   /* same for extension/ scripts (build-design.sh) */
    int test_mode = getenv("DS4UI_TEST_MODE") && getenv("DS4UI_TEST_MODE")[0];

    const char *bind_env = getenv("DS4UI_HOST");
    if (bind_env && bind_env[0]) snprintf(g_bind_host, sizeof g_bind_host, "%s", bind_env);
    if (ds4ui_forced_port > 0) port = ds4ui_forced_port;   /* parent pre-picked a free port */
    int requested_port = port;
    g_http_port = port;

#ifndef _WIN32
    signal(SIGPIPE, SIG_IGN);
#endif
    struct sigaction sa;
    memset(&sa, 0, sizeof sa);
    sa.sa_handler = on_term;
    sigaction(SIGINT, &sa, NULL);
    sigaction(SIGTERM, &sa, NULL);

    g_srv_fd = ds4ui_forced_port > 0 ? open_listener(g_bind_host, port) : open_first_listener(g_bind_host, &port);
    if (g_srv_fd < 0) {
        fprintf(stderr, "could not bind %s:%d (%s)\n", g_bind_host, port, strerror(errno));
        return 1;
    }
    if (port != requested_port)
        fprintf(stderr, "DStudio: port %d busy on %s — opening on %d instead\n", requested_port, g_bind_host, port);
    g_http_port = port;

    g_abuf = malloc(65536);
    g_acap = g_abuf ? 65536 : 0;

    store_load();   /* host-local browser history; LAN clients do not reach this store */

    /* Crash-clean: if a previous launch died with the ds4_agent.c source
     * still patched, restore it from the .bak before anything else. */
    if (!test_mode) run_build_jsonl("restore");

    int lan = strcmp(g_bind_host, "127.0.0.1") != 0;
    printf("DStudio: http://%s:%d  (page %s, ds4 %s)\n", g_bind_host, port, PAGE_PATH, g_ds4_dir);
    if (lan) {
        printf("\n  !  BOUND ON THE LAN (%s): non-local clients can open the app shell, /remote, /v1 and engine APIs.\n", g_bind_host);
        printf("     Host settings, store and model-download APIs stay loopback-only.\n");
        printf("     To go back to localhost only:  DS4UI_HOST=127.0.0.1 ./dstudio\n\n");
    }

    /* Automatic startup of the server with the defaults, if the port is free. */
    if (test_mode) {
        printf("engine: test mode - not starting ds4\n");
    } else if (port_listening(ENGINE_DEFAULTS.port)) {
        printf("engine: :%d already in use - I start nothing, manage it from the page\n", ENGINE_DEFAULTS.port);
    } else {
        engine_cfg boot = ENGINE_DEFAULTS;
        boot.uncensored = model_present(1) ? 1 : 0;
        char err[256];
        /* Gate on the model the server ACTUALLY loads — the selected variant
         * (variant_rel(g_variant), e.g. flash), the same check spawn_server makes
         * — NOT the standard/uncensored filename. Otherwise a setup with only the
         * flash GGUF present never auto-starts ("no model") even though it could. */
        if (!file_present(current_model_rel())) printf("engine: no model in %s - start it from the page\n", g_ds4_dir);
        else if (!spawn_server(&boot, err, sizeof err)) printf("engine: %s\n", err);
    }

    while (!g_stop) {
        reap_child();
        struct pollfd pfd[3];
        int nf = 0;
        pfd[nf].fd = g_srv_fd; pfd[nf].events = POLLIN; nf++;  /* rebindable: the LAN toggle swaps this */
        int oi = -1, ei = -1;
        if (g_out_fd >= 0) { oi = nf; pfd[nf].fd = g_out_fd; pfd[nf].events = POLLIN; nf++; }
        if (g_err_fd >= 0) { ei = nf; pfd[nf].fd = g_err_fd; pfd[nf].events = POLLIN; nf++; }

        int prc = poll(pfd, (nfds_t)nf, 200);
        if (prc < 0) { if (errno == EINTR) continue; perror("poll"); continue; }

        if ((oi >= 0 && (pfd[oi].revents & (POLLIN | POLLHUP))) ||
            (ei >= 0 && (pfd[ei].revents & (POLLIN | POLLHUP))))
            drain_child();

        /* server readiness via port even without traffic on the pipes */
        if (g_mode == ENGINE_SERVER && !g_ready && port_listening(g_cfg.port)) {
            set_stage("Ready", 100); g_ready = 1;
        }

        if (pfd[0].revents & POLLIN) {
            int fd = accept(g_srv_fd, NULL, NULL);
            if (fd >= 0) { drain_child(); handle_connection(fd); }
        }

        /* push to the SSE clients: new pipe data wakes poll() immediately,
         * so streamed agent output has chat-like latency. */
        sse_flush();
    }
    sse_close_all();
    stop_child();
    return 0;
}

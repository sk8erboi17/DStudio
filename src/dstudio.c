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
 * Run:      ./dstudio [web_port] [ds4_dir]      (default 5500, ./ds4)
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
 *  - bounded buffers (header REQ_BUF, normal API body BODY_MAX), logging with escaping of
 *    non-printable bytes, I/O timeout, SIGPIPE ignored, partial writes handled.
 *  - page CSP allows http/https fetches so LAN clients can call the host API.
 *  - SIGINT/SIGTERM also shut down the child engine.
 */
#ifndef _GNU_SOURCE
#define _GNU_SOURCE
#endif
#include <ctype.h>
#include <math.h>
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
#define IOGPU_WIRED_MIN_MB 86016LL
#define IOGPU_WIRED_MAX_MB 90112LL
#define IOGPU_WIRED_TARGET_MB IOGPU_WIRED_MIN_MB
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
#include <netdb.h>
#include <net/if.h>
#include <netinet/in.h>
#include <poll.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <sys/wait.h>
#include <pthread.h>
#include <unistd.h>
#endif
#ifdef __APPLE__
#include <mach-o/dyld.h>   /* _NSGetExecutablePath: resolve ds4 dir from bundle */
#include <sys/sysctl.h>
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
#define BODY_MAX     (2 * 1024 * 1024)   /* normal /api JSON body cap; large stores use dedicated paths */
#define IO_TIMEOUT_S 5
#define WEB_HELPER_SEARCH_TIMEOUT_MS 25000
#define WEB_HELPER_VISIT_TIMEOUT_MS 45000
#define AGENT_BUF_CAP (4 * 1024 * 1024)   /* cap of the agent transcript in RAM */
#define TASK_RING_CAP 128
#define TASK_EVENT_RING_CAP 512
#define LOG_RING_CAP 768
#define DIAG_SSE_MAX 8
#define DS4_REPO_URL "https://github.com/antirez/ds4"
#define DS4_UPSTREAM_COMMIT "d881f2a05e8ff6bec001315a36b794b4aa310173"
#define DS4_ARCHIVE_URL "https://codeload.github.com/antirez/ds4/tar.gz/" DS4_UPSTREAM_COMMIT

/* Optional second engine checkout: antirez/ds4 branch glm5.2 (GLM 5.2 support),
 * pinned like the main engine. /api/glm/setup installs it on demand into
 * ./ds4-glm52 (gitignored, like ./ds4), applies the local fixes from
 * patch/ds4-glm52/ on top of the pristine source, and builds. The UI then
 * offers it in the model menu's Engine-branch section. */
#define DS4_GLM_UPSTREAM_COMMIT "bd89932c4a0029a911b9f0f0a82688a4bbf69208"
#define DS4_GLM_ARCHIVE_URL "https://codeload.github.com/antirez/ds4/tar.gz/" DS4_GLM_UPSTREAM_COMMIT
#define DS4_GLM_DIR_NAME "ds4-glm52"
#define DS4_GLM_METAL_PATCH "patch/ds4-glm52/metal-model-views.patch"
#define DS4_GLM_PATCH_MARK "DS4UI_GLM_VIEWS"
#define CYBER_SKILLS_REL_DIR "extension/gsa/third_party/anthropic-cybersecurity-skills/skills"

/* Bundled content (skills, design systems, imported GSA cybersecurity skills) is
 * downloaded at first run instead of being committed to git. The doctor pulls
 * THIS repo's own tree at a pinned commit from codeload (no git needed, same as
 * the ds4 source) and extracts only the content dirs into extension/. */
#define DS4_CONTENT_REPO "sk8erboi17/DStudio"
#define DS4_CONTENT_COMMIT "66401282c5c5e3922a5f555a009de24cde149749"
#define DS4_CONTENT_ARCHIVE_URL "https://codeload.github.com/" DS4_CONTENT_REPO "/tar.gz/" DS4_CONTENT_COMMIT

#define MODEL_STD "ds4flash.gguf"
#define MODEL_UNC "gguf/cyberneurova-DeepSeek-V4-Flash-abliterated-IQ2XXS-w2Q2K-AProjQ8-SExpQ8-OutQ8-chat-v2-imatrix-aligned.gguf"
/* Model variants the UI can pick: flash = the abliterated Flash above, pro =
 * the official V4-Pro IQ2XXS (download_model.sh pro-q2-imatrix). */
#define MODEL_FLASH MODEL_UNC
#define MODEL_PRO   "gguf/DeepSeek-V4-Pro-IQ2XXS-w2Q2K-AProjQ8-SExpQ8-OutQ8-Instruct-imatrix.gguf"
#define MODEL_PRO_EXPECTED_BYTES 430000000000LL  /* ~430 GB (pro-q2-imatrix), for the % */

enum { ENGINE_NONE = 0, ENGINE_SERVER, ENGINE_AGENT, ENGINE_DESIGN };
enum { SSD_STREAMING_OFF = 0, SSD_STREAMING_ON = 1, SSD_STREAMING_AUTO = 2 };

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
    int ssd_streaming;/* 0 off, 1 force on, 2 auto. */
} engine_cfg;

static const engine_cfg ENGINE_DEFAULTS = { 1, 28000, 262144, 90, 24576, 128, 1, SSD_STREAMING_AUTO };

/* ---- global engine state ---- */
static int       g_mode = ENGINE_NONE;
static pid_t     g_child = -1;
static engine_cfg g_cfg;
static char      g_ds4_dir[1024] = "ds4";
static int       g_ds4_dir_explicit = 0;  /* CLI path: do not override with ./ds4 discovery */
static char      g_web_dir[1024] = "";       /* this DStudio checkout (holds extension/) */
static char      g_workdir[1024] = "";       /* agent: --chdir; design: --workspace */
static char      g_remote_base_url[1024] = ""; /* LAN client: local agent/design, remote model */
static char      g_remote_api_key[256] = "";   /* cloud backend (e.g. DeepSeek API): Bearer key, held launcher-side only */
static char      g_remote_model[128] = "";
static char      g_design_dir[1024] = "";    /* last design workspace: the preview
                                                stays servable even after stop */
static int       g_ssd_streaming_effective = 0;
static char      g_ssd_streaming_reason[192] = "not launched";

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
static int  g_interrupt_pending = 0; /* SIGINT sent; wait for WAITING or child exit */
static int  g_active_turn_compacting = 0;
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
 * longer just loopback). img-src also allows remote favicons for cited web
 * sources. default-src stays 'none'. */
static const char SEC_HEADERS[] =
    "Connection: close\r\n"
    "Cache-Control: no-store\r\n"
    "X-Content-Type-Options: nosniff\r\n"
    "Referrer-Policy: no-referrer\r\n"
    "Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; "
    "script-src 'unsafe-inline'; img-src data: http: https:; connect-src http: https:; "
    "frame-src 'self'\r\n";

/* Headers for design files served in preview iframes. The preview must behave
 * like the bundled template site, so relative assets and common HTTPS-hosted
 * fonts/CSS/script CDNs used by the original examples are allowed. */
static const char DESIGN_HEADERS[] =
    "Connection: close\r\n"
    "Cache-Control: no-store\r\n"
    "X-Content-Type-Options: nosniff\r\n"
    "Referrer-Policy: no-referrer\r\n"
    "Content-Security-Policy: default-src 'none'; style-src 'self' 'unsafe-inline' https:; "
    "script-src 'self' 'unsafe-inline' https:; img-src 'self' data: blob: https: http:; "
    "font-src 'self' data: https:; connect-src 'self' https: http:; media-src 'self' https: data: blob:\r\n";

/* Bind address of the HTTP listener. Default 127.0.0.1 (localhost only): LAN is
 * OFF by default. The user enables it from Settings (POST /api/lan {enable}),
 * which rebinds the listener to 0.0.0.0 live; DS4UI_HOST overrides the boot host. */
static char g_bind_host[64] = "127.0.0.1";
static int  g_srv_fd = -1;     /* HTTP listen socket (rebindable for the LAN toggle) */
static int  g_http_port = 5500;
static int  g_reply_cors = 0;
/* Set by the windowed launcher (app.cc) BEFORE forking the server: a pre-picked FREE port,
 * so if 5500 is squatted (e.g. a leftover dev server) DStudio opens on the next free
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

static const char CORS_HEADERS[] =
    "Access-Control-Allow-Origin: *\r\n"
    "Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n"
    "Access-Control-Allow-Headers: Content-Type, Accept, X-Requested-With\r\n";

static void send_response_hdrs(int fd, const char *status, const char *ctype,
                               const char *body, size_t blen, int head_only,
                               const char *extra_headers) {
    char hdr[1024];
    int add_cors = g_reply_cors && !(extra_headers && strstr(extra_headers, "Access-Control-Allow-Origin:"));
    int n = snprintf(hdr, sizeof hdr,
                     "HTTP/1.1 %s\r\nContent-Type: %s\r\nContent-Length: %zu\r\n%s%s\r\n",
                     status, ctype, blen, extra_headers ? extra_headers : "",
                     add_cors ? CORS_HEADERS : "");
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
    send_response_hdrs(fd, status, "application/json; charset=utf-8", body, strlen(body), 0,
                       CORS_HEADERS);
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

#if defined(HAVE_EMBEDDED_PAGE) || defined(HAVE_EMBEDDED_LOADING) || !defined(_WIN32)
/* Decodes base64 → malloc'd buffer. Ignores spaces/newlines. Returns
 * NULL on malformed input. Table: value+1 for valid characters, 0 = not
 * valid (so 'A'→1 is distinguished from the default zeroed entries).
 * Used for the embedded page and by /api/agent/attach-image (non-Windows). */
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

/* ==================== observability: tasks + logs ==================== */

static void cstr_copy(char *dst, size_t dstsz, const char *src);
static void reap_child(void);
static int lan_status(char *addr, size_t addrsz);

typedef struct {
    unsigned long long seq;
    unsigned long long task_id;
    long long ts_ms;
    char type[32];
    char message[512];
} dstudio_task_event;

typedef struct {
    unsigned long long id;
    unsigned long long seq;
    long long created_ms;
    long long updated_ms;
    long long completed_ms;
    char kind[32];
    char target[32];
    char status[20];
    char title[160];
    int mode;
    char workdir[1024];
    int pid;
    int cancelable;
    char error[512];
    char detail[1024];
} dstudio_task;

typedef struct {
    unsigned long long seq;
    long long ts_ms;
    unsigned long long task_id;
    char level[12];
    char component[48];
    char message[768];
} dstudio_log_entry;

static dstudio_task g_tasks[TASK_RING_CAP];
static int g_task_next_slot = 0;
static int g_task_count = 0;
static unsigned long long g_task_next_id = 1;
static unsigned long long g_task_seq = 0;
static dstudio_task_event g_task_events[TASK_EVENT_RING_CAP];
static int g_task_event_next_slot = 0;
static int g_task_event_count = 0;

static dstudio_log_entry g_logs[LOG_RING_CAP];
static int g_log_next_slot = 0;
static int g_log_count = 0;
static unsigned long long g_log_seq = 0;

static unsigned long long g_active_launch_task = 0;
static int g_active_launch_mode = ENGINE_NONE;
static unsigned long long g_active_turn_task = 0;
static unsigned long long g_active_download_task = 0;
static unsigned long long g_active_setup_task = 0;

static int g_log_sse_fd[DIAG_SSE_MAX];
static unsigned long long g_log_sse_since[DIAG_SSE_MAX];
static int g_log_sse_n = 0;
static int g_task_sse_fd[DIAG_SSE_MAX];
static unsigned long long g_task_sse_since[DIAG_SSE_MAX];
static int g_task_sse_n = 0;
static int g_diag_sse_tick = 0;
static int g_diag_sse_adopt = 0;

static long long dstudio_now_ms(void) {
#ifdef _WIN32
    FILETIME ft;
    ULARGE_INTEGER u;
    GetSystemTimeAsFileTime(&ft);
    u.LowPart = ft.dwLowDateTime;
    u.HighPart = ft.dwHighDateTime;
    return (long long)((u.QuadPart - 116444736000000000ULL) / 10000ULL);
#else
    struct timeval tv;
    gettimeofday(&tv, NULL);
    return (long long)tv.tv_sec * 1000LL + (long long)(tv.tv_usec / 1000);
#endif
}

static const char *task_mode_name(int m) {
    return m == ENGINE_SERVER ? "server" :
           m == ENGINE_AGENT ? "agent" :
           m == ENGINE_DESIGN ? "design" : "none";
}

static dstudio_task *task_find(unsigned long long id) {
    if (!id) return NULL;
    for (int i = 0; i < g_task_count; i++)
        if (g_tasks[i].id == id) return &g_tasks[i];
    return NULL;
}

static int task_status_terminal(const char *status) {
    return !strcmp(status, "completed") || !strcmp(status, "failed") ||
           !strcmp(status, "canceled") || !strcmp(status, "incomplete");
}

static void task_add_event(unsigned long long task_id, const char *type, const char *message) {
    if (!task_id) return;
    int slot = g_task_event_next_slot;
    g_task_event_next_slot = (g_task_event_next_slot + 1) % TASK_EVENT_RING_CAP;
    if (g_task_event_count < TASK_EVENT_RING_CAP) g_task_event_count++;
    dstudio_task_event *ev = &g_task_events[slot];
    memset(ev, 0, sizeof *ev);
    ev->seq = ++g_task_seq;
    ev->task_id = task_id;
    ev->ts_ms = dstudio_now_ms();
    cstr_copy(ev->type, sizeof ev->type, type ? type : "event");
    cstr_copy(ev->message, sizeof ev->message, message ? message : "");
    dstudio_task *t = task_find(task_id);
    if (t) {
        t->seq = ev->seq;
        t->updated_ms = ev->ts_ms;
    }
}

static void dstudio_log_event(const char *level, const char *component,
                              unsigned long long task_id, const char *fmt, ...) {
    int slot = g_log_next_slot;
    g_log_next_slot = (g_log_next_slot + 1) % LOG_RING_CAP;
    if (g_log_count < LOG_RING_CAP) g_log_count++;
    dstudio_log_entry *e = &g_logs[slot];
    memset(e, 0, sizeof *e);
    e->seq = ++g_log_seq;
    e->ts_ms = dstudio_now_ms();
    e->task_id = task_id;
    cstr_copy(e->level, sizeof e->level, level ? level : "info");
    cstr_copy(e->component, sizeof e->component, component ? component : "core");
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(e->message, sizeof e->message, fmt ? fmt : "", ap);
    va_end(ap);
}

static unsigned long long task_begin(const char *kind, const char *title, const char *target,
                                     int mode, const char *workdir, int pid, int cancelable) {
    int slot = g_task_next_slot;
    g_task_next_slot = (g_task_next_slot + 1) % TASK_RING_CAP;
    if (g_task_count < TASK_RING_CAP) g_task_count++;
    dstudio_task *t = &g_tasks[slot];
    memset(t, 0, sizeof *t);
    t->id = g_task_next_id++;
    t->seq = ++g_task_seq;
    t->created_ms = t->updated_ms = dstudio_now_ms();
    cstr_copy(t->kind, sizeof t->kind, kind ? kind : "task");
    cstr_copy(t->target, sizeof t->target, target ? target : "");
    cstr_copy(t->status, sizeof t->status, "submitted");
    cstr_copy(t->title, sizeof t->title, title ? title : t->kind);
    t->mode = mode;
    cstr_copy(t->workdir, sizeof t->workdir, workdir ? workdir : "");
    t->pid = pid;
    t->cancelable = cancelable;
    task_add_event(t->id, "submitted", t->title);
    dstudio_log_event("info", t->kind, t->id, "%s submitted", t->title);
    return t->id;
}

static void task_set_status(unsigned long long id, const char *status,
                            const char *message, const char *detail) {
    dstudio_task *t = task_find(id);
    if (!t) return;
    cstr_copy(t->status, sizeof t->status, status ? status : "working");
    if (message && *message) {
        if (!strcmp(t->status, "failed") || !strcmp(t->status, "incomplete"))
            cstr_copy(t->error, sizeof t->error, message);
        else
            cstr_copy(t->detail, sizeof t->detail, message);
    }
    if (detail && *detail) cstr_copy(t->detail, sizeof t->detail, detail);
    t->updated_ms = dstudio_now_ms();
    t->seq = ++g_task_seq;
    if (task_status_terminal(t->status) && !t->completed_ms) {
        t->completed_ms = t->updated_ms;
        t->cancelable = 0;
    }
    task_add_event(id, t->status, message ? message : t->status);
    dstudio_log_event((!strcmp(t->status, "failed") || !strcmp(t->status, "incomplete")) ? "error" :
                      (!strcmp(t->status, "canceled") ? "warn" : "info"),
                      t->kind, id, "%s: %s", t->status, message ? message : t->title);
}

static void task_mark_working(unsigned long long id, const char *message) {
    task_set_status(id, "working", message ? message : "working", NULL);
}

static void task_mark_completed(unsigned long long id, const char *message) {
    task_set_status(id, "completed", message ? message : "completed", NULL);
}

static void task_mark_failed(unsigned long long id, const char *message, const char *detail) {
    task_set_status(id, "failed", message ? message : "failed", detail);
}

static void task_mark_incomplete(unsigned long long id, const char *message, const char *detail) {
    task_set_status(id, "incomplete", message ? message : "incomplete", detail);
}

static void task_mark_canceled(unsigned long long id, const char *message) {
    task_set_status(id, "canceled", message ? message : "canceled", NULL);
}

static void maybe_complete_launch_task(int mode) {
    if (!g_active_launch_task) return;
    if (mode != ENGINE_NONE && g_active_launch_mode != mode) return;
    task_mark_completed(g_active_launch_task, "engine ready");
    g_active_launch_task = 0;
    g_active_launch_mode = ENGINE_NONE;
}

static const char *task_kind_for_mode(int mode) {
    return mode == ENGINE_DESIGN ? "design-turn" :
           mode == ENGINE_AGENT ? "agent-turn" : "turn";
}

static int json_add_task_summary(json_dyn_buf *b, const dstudio_task *t) {
    long long duration = t->completed_ms && t->created_ms ? t->completed_ms - t->created_ms : 0;
    int ok = json_dyn_puts(b, "{\"id\":") &&
             json_dyn_printf(b, "%llu", t->id) &&
             json_dyn_puts(b, ",\"seq\":") &&
             json_dyn_printf(b, "%llu", t->seq) &&
             json_dyn_puts(b, ",\"kind\":") &&
             json_dyn_put_escaped(b, t->kind) &&
             json_dyn_puts(b, ",\"target\":") &&
             json_dyn_put_escaped(b, t->target) &&
             json_dyn_puts(b, ",\"status\":") &&
             json_dyn_put_escaped(b, t->status) &&
             json_dyn_puts(b, ",\"title\":") &&
             json_dyn_put_escaped(b, t->title) &&
             json_dyn_puts(b, ",\"mode\":") &&
             json_dyn_put_escaped(b, task_mode_name(t->mode)) &&
             json_dyn_puts(b, ",\"workdir\":") &&
             json_dyn_put_escaped(b, t->workdir) &&
             json_dyn_printf(b, ",\"pid\":%d,\"cancelable\":%s,\"createdAt\":%lld,\"updatedAt\":%lld,\"completedAt\":%lld,\"durationMs\":%lld",
                             t->pid, t->cancelable ? "true" : "false",
                             t->created_ms, t->updated_ms, t->completed_ms, duration) &&
             json_dyn_puts(b, ",\"error\":") &&
             json_dyn_put_escaped(b, t->error) &&
             json_dyn_puts(b, ",\"detail\":") &&
             json_dyn_put_escaped(b, t->detail) &&
             json_dyn_puts(b, "}");
    return ok;
}

static int json_add_log_entry(json_dyn_buf *b, const dstudio_log_entry *e) {
    return json_dyn_puts(b, "{\"seq\":") &&
           json_dyn_printf(b, "%llu", e->seq) &&
           json_dyn_printf(b, ",\"ts\":%lld,\"taskId\":%llu", e->ts_ms, e->task_id) &&
           json_dyn_puts(b, ",\"level\":") &&
           json_dyn_put_escaped(b, e->level) &&
           json_dyn_puts(b, ",\"component\":") &&
           json_dyn_put_escaped(b, e->component) &&
           json_dyn_puts(b, ",\"message\":") &&
           json_dyn_put_escaped(b, e->message) &&
           json_dyn_puts(b, "}");
}

static int json_add_task_event(json_dyn_buf *b, const dstudio_task_event *ev) {
    return json_dyn_puts(b, "{\"seq\":") &&
           json_dyn_printf(b, "%llu", ev->seq) &&
           json_dyn_printf(b, ",\"ts\":%lld,\"taskId\":%llu", ev->ts_ms, ev->task_id) &&
           json_dyn_puts(b, ",\"type\":") &&
           json_dyn_put_escaped(b, ev->type) &&
           json_dyn_puts(b, ",\"message\":") &&
           json_dyn_put_escaped(b, ev->message) &&
           json_dyn_puts(b, "}");
}

static int query_ull(const char *path, const char *key, unsigned long long *out) {
    char pat[64];
    snprintf(pat, sizeof pat, "%s=", key);
    const char *q = strchr(path, '?');
    if (!q) return 0;
    const char *p = strstr(q + 1, pat);
    if (!p) return 0;
    p += strlen(pat);
    char *end = NULL;
    unsigned long long v = strtoull(p, &end, 10);
    if (end == p) return 0;
    *out = v;
    return 1;
}

static int query_int(const char *path, const char *key, int def, int lo, int hi) {
    unsigned long long v = 0;
    if (!query_ull(path, key, &v)) return def;
    if (v < (unsigned long long)lo) return lo;
    if (v > (unsigned long long)hi) return hi;
    return (int)v;
}

static void api_tasks(int fd, const char *path) {
    int limit = query_int(path, "limit", 50, 1, TASK_RING_CAP);
    json_dyn_buf b = {0};
    int ok = json_dyn_puts(&b, "{\"ok\":true,\"seq\":") &&
             json_dyn_printf(&b, "%llu", g_task_seq) &&
             json_dyn_puts(&b, ",\"tasks\":[");
    int emitted = 0;
    for (int n = 0; ok && n < g_task_count && emitted < limit; n++) {
        int idx = (g_task_next_slot - 1 - n + TASK_RING_CAP) % TASK_RING_CAP;
        if (!g_tasks[idx].id) continue;
        if (emitted++) ok = ok && json_dyn_puts(&b, ",");
        ok = ok && json_add_task_summary(&b, &g_tasks[idx]);
    }
    ok = ok && json_dyn_puts(&b, "]}");
    if (!ok) { free(b.ptr); send_json(fd, "500 Internal Server Error", "{\"ok\":false,\"error\":\"out of memory\"}"); return; }
    send_json(fd, "200 OK", b.ptr);
    free(b.ptr);
}

static void api_task(int fd, const char *path) {
    unsigned long long id = 0;
    if (!query_ull(path, "id", &id)) {
        send_json(fd, "400 Bad Request", "{\"ok\":false,\"error\":\"task id missing\"}");
        return;
    }
    dstudio_task *t = task_find(id);
    if (!t) {
        send_json(fd, "404 Not Found", "{\"ok\":false,\"error\":\"task not found\"}");
        return;
    }
    json_dyn_buf b = {0};
    int ok = json_dyn_puts(&b, "{\"ok\":true,\"task\":") &&
             json_add_task_summary(&b, t) &&
             json_dyn_puts(&b, ",\"events\":[");
    int emitted = 0;
    for (int n = g_task_event_count - 1; ok && n >= 0; n--) {
        int idx = (g_task_event_next_slot - 1 - n + TASK_EVENT_RING_CAP) % TASK_EVENT_RING_CAP;
        if (g_task_events[idx].task_id != id) continue;
        if (emitted++) ok = ok && json_dyn_puts(&b, ",");
        ok = ok && json_add_task_event(&b, &g_task_events[idx]);
    }
    ok = ok && json_dyn_puts(&b, "]}");
    if (!ok) { free(b.ptr); send_json(fd, "500 Internal Server Error", "{\"ok\":false,\"error\":\"out of memory\"}"); return; }
    send_json(fd, "200 OK", b.ptr);
    free(b.ptr);
}

static void api_logs(int fd, const char *path) {
    int limit = query_int(path, "limit", 200, 1, LOG_RING_CAP);
    json_dyn_buf b = {0};
    int ok = json_dyn_puts(&b, "{\"ok\":true,\"seq\":") &&
             json_dyn_printf(&b, "%llu", g_log_seq) &&
             json_dyn_puts(&b, ",\"logs\":[");
    int emitted = 0;
    for (int n = 0; ok && n < g_log_count && emitted < limit; n++) {
        int idx = (g_log_next_slot - 1 - n + LOG_RING_CAP) % LOG_RING_CAP;
        if (!g_logs[idx].seq) continue;
        if (emitted++) ok = ok && json_dyn_puts(&b, ",");
        ok = ok && json_add_log_entry(&b, &g_logs[idx]);
    }
    ok = ok && json_dyn_puts(&b, "]}");
    if (!ok) { free(b.ptr); send_json(fd, "500 Internal Server Error", "{\"ok\":false,\"error\":\"out of memory\"}"); return; }
    send_json(fd, "200 OK", b.ptr);
    free(b.ptr);
}

static int diag_send_task_sse_event(int fd, const dstudio_task *t) {
    json_dyn_buf b = {0};
    int ok = json_dyn_puts(&b, "event: task\ndata: ") &&
             json_add_task_summary(&b, t) &&
             json_dyn_puts(&b, "\n\n");
    if (!ok) { free(b.ptr); return -1; }
    int rc = write(fd, b.ptr, b.len) == (ssize_t)b.len ? 0 : -1;
    free(b.ptr);
    return rc;
}

static int diag_send_log_sse_event(int fd, const dstudio_log_entry *e) {
    json_dyn_buf b = {0};
    int ok = json_dyn_puts(&b, "event: log\ndata: ") &&
             json_add_log_entry(&b, e) &&
             json_dyn_puts(&b, "\n\n");
    if (!ok) { free(b.ptr); return -1; }
    int rc = write(fd, b.ptr, b.len) == (ssize_t)b.len ? 0 : -1;
    free(b.ptr);
    return rc;
}

static void diag_sse_drop_log(int i) {
    close(g_log_sse_fd[i]);
    if (i < g_log_sse_n - 1) {
        memmove(&g_log_sse_fd[i], &g_log_sse_fd[i + 1], (size_t)(g_log_sse_n - i - 1) * sizeof g_log_sse_fd[0]);
        memmove(&g_log_sse_since[i], &g_log_sse_since[i + 1], (size_t)(g_log_sse_n - i - 1) * sizeof g_log_sse_since[0]);
    }
    g_log_sse_n--;
}

static void diag_sse_drop_task(int i) {
    close(g_task_sse_fd[i]);
    if (i < g_task_sse_n - 1) {
        memmove(&g_task_sse_fd[i], &g_task_sse_fd[i + 1], (size_t)(g_task_sse_n - i - 1) * sizeof g_task_sse_fd[0]);
        memmove(&g_task_sse_since[i], &g_task_sse_since[i + 1], (size_t)(g_task_sse_n - i - 1) * sizeof g_task_sse_since[0]);
    }
    g_task_sse_n--;
}

static void diag_sse_flush(void) {
    int beat = (++g_diag_sse_tick % 75) == 0;
    for (int i = 0; i < g_log_sse_n; ) {
        int dropped = 0;
        for (int n = g_log_count - 1; n >= 0; n--) {
            int idx = (g_log_next_slot - 1 - n + LOG_RING_CAP) % LOG_RING_CAP;
            if (!g_logs[idx].seq || g_logs[idx].seq <= g_log_sse_since[i]) continue;
            if (diag_send_log_sse_event(g_log_sse_fd[i], &g_logs[idx]) != 0) { diag_sse_drop_log(i); dropped = 1; break; }
            g_log_sse_since[i] = g_logs[idx].seq;
        }
        if (dropped) continue;
        if (beat && write(g_log_sse_fd[i], ": ping\n\n", 8) != 8) { diag_sse_drop_log(i); continue; }
        i++;
    }
    for (int i = 0; i < g_task_sse_n; ) {
        int dropped = 0;
        for (int n = g_task_count - 1; n >= 0; n--) {
            int idx = (g_task_next_slot - 1 - n + TASK_RING_CAP) % TASK_RING_CAP;
            if (!g_tasks[idx].id || g_tasks[idx].seq <= g_task_sse_since[i]) continue;
            if (diag_send_task_sse_event(g_task_sse_fd[i], &g_tasks[idx]) != 0) { diag_sse_drop_task(i); dropped = 1; break; }
            if (g_tasks[idx].seq > g_task_sse_since[i]) g_task_sse_since[i] = g_tasks[idx].seq;
        }
        if (dropped) continue;
        if (beat && write(g_task_sse_fd[i], ": ping\n\n", 8) != 8) { diag_sse_drop_task(i); continue; }
        i++;
    }
}

static void diag_sse_close_all(void) {
    while (g_log_sse_n) diag_sse_drop_log(0);
    while (g_task_sse_n) diag_sse_drop_task(0);
}

static unsigned long long dstudio_physical_memory_bytes(void);
static long long current_model_file_size(void);
static long long sysctl_iogpu_wired_limit_mb(void);
static int setup_run_cmd_capture(const char *cwd, char *const argv[], char *out, size_t outsz);

static void api_stream_logs(int fd, const char *path) {
    if (g_log_sse_n >= DIAG_SSE_MAX) {
        send_json(fd, "503 Service Unavailable", "{\"ok\":false,\"error\":\"too many log streams\"}");
        return;
    }
    unsigned long long since = 0;
    query_ull(path, "since", &since);
    const char *hdr = "HTTP/1.1 200 OK\r\n"
                      "Content-Type: text/event-stream\r\n"
                      "Cache-Control: no-cache\r\n"
                      "Connection: keep-alive\r\n\r\n";
    if (write(fd, hdr, strlen(hdr)) != (ssize_t)strlen(hdr)) return;
    int fl = fcntl(fd, F_GETFL, 0);
    if (fl >= 0) fcntl(fd, F_SETFL, fl | O_NONBLOCK);
    g_log_sse_fd[g_log_sse_n] = fd;
    g_log_sse_since[g_log_sse_n] = since;
    g_log_sse_n++;
    diag_sse_flush();
    g_diag_sse_adopt = 1;
}

static void api_stream_tasks(int fd, const char *path) {
    if (g_task_sse_n >= DIAG_SSE_MAX) {
        send_json(fd, "503 Service Unavailable", "{\"ok\":false,\"error\":\"too many task streams\"}");
        return;
    }
    unsigned long long since = 0;
    query_ull(path, "since", &since);
    const char *hdr = "HTTP/1.1 200 OK\r\n"
                      "Content-Type: text/event-stream\r\n"
                      "Cache-Control: no-cache\r\n"
                      "Connection: keep-alive\r\n\r\n";
    if (write(fd, hdr, strlen(hdr)) != (ssize_t)strlen(hdr)) return;
    int fl = fcntl(fd, F_GETFL, 0);
    if (fl >= 0) fcntl(fd, F_SETFL, fl | O_NONBLOCK);
    g_task_sse_fd[g_task_sse_n] = fd;
    g_task_sse_since[g_task_sse_n] = since;
    g_task_sse_n++;
    diag_sse_flush();
    g_diag_sse_adopt = 1;
}

static void api_diagnostics(int fd) {
    reap_child();
    char lan_addr[80];
    int lan_on = lan_status(lan_addr, sizeof lan_addr);
    int recent_errors = 0, recent_incomplete = 0, active_tasks = 0;
    for (int n = 0; n < g_task_count; n++) {
        if (!g_tasks[n].id) continue;
        if (!task_status_terminal(g_tasks[n].status)) active_tasks++;
        if (!strcmp(g_tasks[n].status, "incomplete")) recent_incomplete++;
    }
    for (int n = 0; n < g_log_count; n++)
        if (!strcmp(g_logs[n].level, "error")) recent_errors++;
    unsigned long long phys_mem = dstudio_physical_memory_bytes();
    long long iogpu_wired_mb = sysctl_iogpu_wired_limit_mb();
    long long model_bytes = current_model_file_size();
    char ssd_reason_esc[420];
    json_escape_into(ssd_reason_esc, sizeof ssd_reason_esc,
                     g_ssd_streaming_reason, strlen(g_ssd_streaming_reason));
    json_dyn_buf b = {0};
    int ok = json_dyn_puts(&b, "{\"ok\":true,\"generatedAt\":") &&
             json_dyn_printf(&b, "%lld", dstudio_now_ms()) &&
             json_dyn_printf(&b, ",\"summary\":{\"activeTasks\":%d,\"recentErrors\":%d,\"recentIncomplete\":%d},",
                             active_tasks, recent_errors, recent_incomplete) &&
             json_dyn_puts(&b, "\"runtime\":{") &&
             json_dyn_puts(&b, "\"mode\":") &&
             json_dyn_put_escaped(&b, task_mode_name(g_mode)) &&
             json_dyn_printf(&b, ",\"running\":%s,\"ready\":%s,\"pid\":%d,\"agentWorking\":%s",
                             g_child > 0 ? "true" : "false", g_ready ? "true" : "false",
                             (int)g_child, g_agent_working ? "true" : "false") &&
             json_dyn_puts(&b, ",\"stage\":") &&
             json_dyn_put_escaped(&b, g_stage) &&
             json_dyn_puts(&b, ",\"engineError\":") &&
             json_dyn_put_escaped(&b, g_engine_err) &&
             json_dyn_puts(&b, ",\"engineLine\":") &&
             json_dyn_put_escaped(&b, g_last_engine_line) &&
             json_dyn_puts(&b, ",\"workdir\":") &&
             json_dyn_put_escaped(&b, g_workdir) &&
             json_dyn_puts(&b, "},\"lan\":{") &&
             json_dyn_printf(&b, "\"enabled\":%s,\"addr\":", lan_on ? "true" : "false") &&
             json_dyn_put_escaped(&b, lan_addr) &&
             json_dyn_puts(&b, "},\"memory\":{") &&
             json_dyn_printf(&b, "\"physicalBytes\":%llu,\"modelBytes\":%lld,\"iogpuWiredLimitMb\":%lld,\"iogpuWiredTargetMb\":%lld,\"iogpuWiredMinMb\":%lld,\"iogpuWiredMaxMb\":%lld",
                             phys_mem, model_bytes, iogpu_wired_mb, IOGPU_WIRED_TARGET_MB,
                             IOGPU_WIRED_MIN_MB, IOGPU_WIRED_MAX_MB) &&
             json_dyn_printf(&b, ",\"ctx\":%d,\"power\":%d", g_cfg.ctx, g_cfg.power) &&
             json_dyn_puts(&b, ",\"ssdStreaming\":\"") &&
             json_dyn_puts(&b, g_cfg.ssd_streaming == SSD_STREAMING_ON ? "on" : g_cfg.ssd_streaming == SSD_STREAMING_OFF ? "off" : "auto") &&
             json_dyn_puts(&b, "\",\"ssdStreamingEffective\":") &&
             json_dyn_puts(&b, g_ssd_streaming_effective ? "true" : "false") &&
             json_dyn_puts(&b, ",\"ssdStreamingReason\":\"") &&
             json_dyn_puts(&b, ssd_reason_esc) &&
             json_dyn_puts(&b, "\"},\"tasks\":{\"seq\":") &&
             json_dyn_printf(&b, "%llu", g_task_seq) &&
             json_dyn_puts(&b, ",\"recent\":[");
    int emitted = 0;
    for (int n = 0; ok && n < g_task_count && emitted < 12; n++) {
        int idx = (g_task_next_slot - 1 - n + TASK_RING_CAP) % TASK_RING_CAP;
        if (!g_tasks[idx].id) continue;
        if (emitted++) ok = ok && json_dyn_puts(&b, ",");
        ok = ok && json_add_task_summary(&b, &g_tasks[idx]);
    }
    ok = ok && json_dyn_puts(&b, "]},\"logs\":{\"seq\":") &&
         json_dyn_printf(&b, "%llu", g_log_seq) &&
         json_dyn_puts(&b, ",\"recentErrors\":[");
    emitted = 0;
    for (int n = 0; ok && n < g_log_count && emitted < 12; n++) {
        int idx = (g_log_next_slot - 1 - n + LOG_RING_CAP) % LOG_RING_CAP;
        if (!g_logs[idx].seq || strcmp(g_logs[idx].level, "error")) continue;
        if (emitted++) ok = ok && json_dyn_puts(&b, ",");
        ok = ok && json_add_log_entry(&b, &g_logs[idx]);
    }
    ok = ok && json_dyn_puts(&b, "]}}");
    if (!ok) { free(b.ptr); send_json(fd, "500 Internal Server Error", "{\"ok\":false,\"error\":\"out of memory\"}"); return; }
    send_json(fd, "200 OK", b.ptr);
    free(b.ptr);
}

static void api_iogpu_wired_limit(int fd, const char *body) {
#ifdef __APPLE__
    long target = IOGPU_WIRED_TARGET_MB;
    int parsed = json_get_int(body, "mb", IOGPU_WIRED_MIN_MB, IOGPU_WIRED_MAX_MB, &target);
    if (parsed < 0) {
        send_json(fd, "400 Bad Request", "{\"ok\":false,\"error\":\"unsupported iogpu.wired_limit_mb target\"}");
        return;
    }
    char tmp[] = "/tmp/dstudio-iogpu-wired-limit-XXXXXX";
    int tfd = mkstemp(tmp);
    if (tfd < 0) {
        send_json(fd, "500 Internal Server Error", "{\"ok\":false,\"error\":\"could not create iogpu installer script\"}");
        return;
    }
    FILE *tf = fdopen(tfd, "w");
    if (!tf) {
        close(tfd);
        unlink(tmp);
        send_json(fd, "500 Internal Server Error", "{\"ok\":false,\"error\":\"could not write iogpu installer script\"}");
        return;
    }
    fprintf(tf,
            "#!/bin/sh\n"
            "set -eu\n"
            "install_dir='/Library/Application Support/DStudio'\n"
            "plist='/Library/LaunchDaemons/com.dstudio.iogpu-wired-limit.plist'\n"
            "runner=\"$install_dir/iogpu-wired-limit.sh\"\n"
            "mkdir -p \"$install_dir\"\n"
            "cat > \"$runner\" <<'EOS'\n"
            "#!/bin/sh\n"
            "/usr/sbin/sysctl -w iogpu.wired_limit_mb=%ld\n"
            "EOS\n"
            "chown root:wheel \"$runner\"\n"
            "chmod 755 \"$runner\"\n"
            "cat > \"$plist\" <<'EOP'\n"
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n"
            "<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n"
            "<plist version=\"1.0\">\n"
            "<dict>\n"
            "  <key>Label</key>\n"
            "  <string>com.dstudio.iogpu-wired-limit</string>\n"
            "  <key>ProgramArguments</key>\n"
            "  <array>\n"
            "    <string>/Library/Application Support/DStudio/iogpu-wired-limit.sh</string>\n"
            "  </array>\n"
            "  <key>RunAtLoad</key>\n"
            "  <true/>\n"
            "  <key>StandardOutPath</key>\n"
            "  <string>/var/log/dstudio-iogpu-wired-limit.log</string>\n"
            "  <key>StandardErrorPath</key>\n"
            "  <string>/var/log/dstudio-iogpu-wired-limit.err</string>\n"
            "</dict>\n"
            "</plist>\n"
            "EOP\n"
            "chown root:wheel \"$plist\"\n"
            "chmod 644 \"$plist\"\n"
            "/bin/launchctl bootout system \"$plist\" >/dev/null 2>&1 || true\n"
            "/bin/launchctl bootstrap system \"$plist\"\n"
            "/bin/launchctl kickstart -k system/com.dstudio.iogpu-wired-limit\n"
            "/usr/sbin/sysctl -w iogpu.wired_limit_mb=%ld\n",
            target, target);
    int write_failed = ferror(tf);
    if (fclose(tf) != 0) write_failed = 1;
    if (write_failed) {
        unlink(tmp);
        send_json(fd, "500 Internal Server Error", "{\"ok\":false,\"error\":\"could not finish iogpu installer script\"}");
        return;
    }
    chmod(tmp, 0700);
    char script[640];
    snprintf(script, sizeof script, "do shell script \"/bin/sh %s\" with administrator privileges", tmp);
    char out[4096] = "";
    char *argv[] = { "osascript", "-e", script, NULL };
    int rc = setup_run_cmd_capture(NULL, argv, out, sizeof out);
    unlink(tmp);
    long long current = sysctl_iogpu_wired_limit_mb();
    if (rc != 0 || current != target) {
        json_dyn_buf b = {0};
        int ok = json_dyn_puts(&b, "{\"ok\":false,\"error\":") &&
                 json_dyn_put_escaped(&b, rc != 0 ? "admin prompt or sysctl failed" : "sysctl value did not match target") &&
                 json_dyn_printf(&b, ",\"currentMb\":%lld,\"targetMb\":%ld,\"output\":", current, target) &&
                 json_dyn_put_escaped(&b, out) &&
                 json_dyn_puts(&b, "}");
        if (!ok) {
            free(b.ptr);
            send_json(fd, "500 Internal Server Error", "{\"ok\":false,\"error\":\"iogpu response memory\"}");
            return;
        }
        send_json(fd, "500 Internal Server Error", b.ptr);
        free(b.ptr);
        return;
    }
    char res[160];
    snprintf(res, sizeof res, "{\"ok\":true,\"currentMb\":%lld,\"targetMb\":%ld,\"persistent\":true}", current, target);
    send_json(fd, "200 OK", res);
#else
    (void)body;
    send_json(fd, "400 Bad Request", "{\"ok\":false,\"error\":\"iogpu.wired_limit_mb is macOS-only\"}");
#endif
}

static json_dyn_buf g_child_event_line = {0};
static int g_child_event_active = 0;

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

static char *json_get_string_alloc_rpc(const char *body, const char *key) {
    char pat[96];
    snprintf(pat, sizeof pat, "\"%s\"", key);
    const char *p = strstr(body ? body : "", pat);
    if (!p) return NULL;
    p += strlen(pat);
    while (*p && isspace((unsigned char)*p)) p++;
    if (*p != ':') return NULL;
    p++;
    while (*p && isspace((unsigned char)*p)) p++;
    if (*p != '"') return NULL;
    p++;
    json_dyn_buf out = {0};
    while (*p) {
        unsigned char c = (unsigned char)*p++;
        if (c == '"') return out.ptr ? out.ptr : ds4_strdup_local("");
        if (c != '\\') {
            if (!json_dyn_putn(&out, (const char *)&c, 1)) { free(out.ptr); return NULL; }
            continue;
        }
        c = (unsigned char)*p++;
        switch (c) {
            case '"':  if (!json_dyn_puts(&out, "\"")) { free(out.ptr); return NULL; } break;
            case '\\': if (!json_dyn_puts(&out, "\\")) { free(out.ptr); return NULL; } break;
            case '/':  if (!json_dyn_puts(&out, "/")) { free(out.ptr); return NULL; } break;
            case 'b':  if (!json_dyn_putn(&out, "\b", 1)) { free(out.ptr); return NULL; } break;
            case 'f':  if (!json_dyn_putn(&out, "\f", 1)) { free(out.ptr); return NULL; } break;
            case 'n':  if (!json_dyn_putn(&out, "\n", 1)) { free(out.ptr); return NULL; } break;
            case 'r':  if (!json_dyn_putn(&out, "\r", 1)) { free(out.ptr); return NULL; } break;
            case 't':  if (!json_dyn_putn(&out, "\t", 1)) { free(out.ptr); return NULL; } break;
            case 'u': {
                if (p[0] && p[1] && p[2] && p[3]) {
                    char hx[5] = { p[0], p[1], p[2], p[3], 0 };
                    long v = strtol(hx, NULL, 16);
                    p += 4;
                    char tmp[4];
                    size_t n = 0;
                    if (v >= 0 && v <= 0x7f) tmp[n++] = (char)v;
                    else if (v < 0x800) {
                        tmp[n++] = (char)(0xc0 | (v >> 6));
                        tmp[n++] = (char)(0x80 | (v & 0x3f));
                    } else {
                        tmp[n++] = '?';
                    }
                    if (!json_dyn_putn(&out, tmp, n)) { free(out.ptr); return NULL; }
                }
                break;
            }
            default:
                if (!json_dyn_putn(&out, (const char *)&c, 1)) { free(out.ptr); return NULL; }
                break;
        }
    }
    free(out.ptr);
    return NULL;
}

typedef struct {
    int id;
    int in_fd;
    char base_url[1024];
    char *body;
    int done;
    char finish_reason[32];
} model_rpc_job;

static int model_rpc_parse_base(const char *base, char *host, size_t hostsz, int *port) {
    if (!base || strncmp(base, "http://", 7) != 0) return 0;
    const char *p = base + 7;
    const char *end = p;
    while (*end && *end != ':' && *end != '/') end++;
    if (end == p || (size_t)(end - p) >= hostsz) return 0;
    memcpy(host, p, (size_t)(end - p));
    host[end - p] = '\0';
    *port = 80;
    if (*end == ':') {
        char *pe = NULL;
        long v = strtol(end + 1, &pe, 10);
        if (pe == end + 1 || v <= 0 || v > 65535) return 0;
        *port = (int)v;
    }
    return 1;
}

static int model_rpc_connect(const char *base, char *err, size_t errsz) {
    char host[256];
    int port = 80;
    if (!model_rpc_parse_base(base, host, sizeof host, &port)) {
        snprintf(err, errsz, "invalid LAN model host");
        return -1;
    }
#ifdef _WIN32
    ds4_win_wsa_start();
#endif
    char port_s[16];
    snprintf(port_s, sizeof port_s, "%d", port);
    struct addrinfo hints;
    memset(&hints, 0, sizeof hints);
    hints.ai_socktype = SOCK_STREAM;
    hints.ai_family = AF_UNSPEC;
    struct addrinfo *res = NULL;
    int gai = getaddrinfo(host, port_s, &hints, &res);
    if (gai != 0 || !res) {
        snprintf(err, errsz, "could not resolve LAN model host");
        return -1;
    }
    int fd = -1;
    for (struct addrinfo *ai = res; ai; ai = ai->ai_next) {
        fd = socket(ai->ai_family, ai->ai_socktype, ai->ai_protocol);
        if (fd < 0) continue;
        if (connect(fd, ai->ai_addr, (socklen_t)ai->ai_addrlen) == 0) break;
        close(fd);
        fd = -1;
    }
    freeaddrinfo(res);
    if (fd < 0) snprintf(err, errsz, "could not connect to LAN model host");
    return fd;
}

static int fd_write_all(int fd, const char *p, size_t n) {
    while (n > 0) {
        ssize_t w = write(fd, p, n);
        if (w < 0 && errno == EINTR) continue;
        if (w <= 0) return 0;
        p += w;
        n -= (size_t)w;
    }
    return 1;
}

static int model_rpc_write_frame(model_rpc_job *job,
                                 const char *type,
                                 const char *kind,
                                 const char *text) {
    json_dyn_buf out = {0};
    int ok = json_dyn_puts(&out, "\x1e{\"type\":") &&
             json_dyn_put_escaped(&out, type) &&
             json_dyn_printf(&out, ",\"id\":%d", job->id);
    if (kind) ok = ok && json_dyn_puts(&out, ",\"kind\":") && json_dyn_put_escaped(&out, kind);
    if (text) {
        const char *key = !strcmp(type, "model_error") ? "error" : "text";
        ok = ok && json_dyn_printf(&out, ",\"%s\":", key) && json_dyn_put_escaped(&out, text);
    }
    ok = ok && json_dyn_puts(&out, "}\n");
    if (!ok) { free(out.ptr); return 0; }
    int rc = fd_write_all(job->in_fd, out.ptr, out.len);
    free(out.ptr);
    return rc;
}

static void model_rpc_sse_line(model_rpc_job *job, const char *line) {
    if (strncmp(line, "data:", 5) != 0) return;
    const char *p = line + 5;
    while (*p == ' ' || *p == '\t') p++;
    if (!strncmp(p, "[DONE]", 6)) {
        job->done = 1;
        return;
    }
    char *reasoning = json_get_string_alloc_rpc(p, "reasoning_content");
    if (reasoning && reasoning[0]) model_rpc_write_frame(job, "model_delta", "reasoning", reasoning);
    free(reasoning);
    char *content = json_get_string_alloc_rpc(p, "content");
    if (content && content[0]) model_rpc_write_frame(job, "model_delta", "content", content);
    free(content);
    char *finish = json_get_string_alloc_rpc(p, "finish_reason");
    if (finish && finish[0])
        snprintf(job->finish_reason, sizeof job->finish_reason, "%s", finish);
    free(finish);
}

static void model_rpc_sse_bytes(model_rpc_job *job, const char *buf, size_t len, json_dyn_buf *line) {
    for (size_t i = 0; i < len && !job->done; i++) {
        json_dyn_putn(line, buf + i, 1);
        if (buf[i] == '\n') {
            model_rpc_sse_line(job, line->ptr ? line->ptr : "");
            line->len = 0;
            if (line->ptr) line->ptr[0] = '\0';
        }
    }
}

typedef struct {
    json_dyn_buf size_line;
    size_t left;
    int skip_crlf;
    int finished;
} model_rpc_chunked;

static int model_rpc_chunked_bytes(model_rpc_job *job,
                                   model_rpc_chunked *st,
                                   const char *buf,
                                   size_t len,
                                   json_dyn_buf *sse_line) {
    for (size_t i = 0; i < len && !job->done && !st->finished; i++) {
        char c = buf[i];
        if (st->skip_crlf > 0) {
            if (c == '\r' || c == '\n') { st->skip_crlf--; continue; }
            st->skip_crlf = 0;
        }
        if (st->left == 0) {
            json_dyn_putn(&st->size_line, &c, 1);
            if (c != '\n') continue;
            char *end = NULL;
            unsigned long sz = strtoul(st->size_line.ptr ? st->size_line.ptr : "0", &end, 16);
            st->size_line.len = 0;
            if (st->size_line.ptr) st->size_line.ptr[0] = '\0';
            if (end == st->size_line.ptr) return 0;
            if (sz == 0) { st->finished = 1; break; }
            st->left = (size_t)sz;
            continue;
        }
        model_rpc_sse_bytes(job, &c, 1, sse_line);
        st->left--;
        if (st->left == 0) st->skip_crlf = 2;
    }
    return 1;
}

/* HTTPS remote endpoints (e.g. the DeepSeek API): the launcher's plain-socket
 * relay cannot do TLS, so stream through curl — the same dependency first-run
 * setup already requires. The Bearer key and the request body travel in 0600
 * temp files (never on the argv); curl de-chunks the response, so its stdout
 * is plain SSE bytes for the same parser as the LAN path. */
static int model_rpc_curl_stream(model_rpc_job *job, char *err, size_t errsz) {
#ifdef _WIN32
    snprintf(err, errsz, "https model endpoints are not supported on the Windows portable build yet");
    return 0;
#else
    const char *tmp = getenv("TMPDIR");
    if (!tmp || !tmp[0]) tmp = "/tmp";
    char hpath[600], bpath[600];
    snprintf(hpath, sizeof hpath, "%s/ds4ui-remote-h.XXXXXX", tmp);
    snprintf(bpath, sizeof bpath, "%s/ds4ui-remote-b.XXXXXX", tmp);
    int hfd = mkstemp(hpath);
    if (hfd < 0) { snprintf(err, errsz, "could not create remote header file"); return 0; }
    int bfd = mkstemp(bpath);
    if (bfd < 0) { close(hfd); unlink(hpath); snprintf(err, errsz, "could not create remote body file"); return 0; }

    json_dyn_buf hdrs = {0};
    int ok = json_dyn_puts(&hdrs, "Content-Type: application/json\nAccept: text/event-stream\n");
    if (g_remote_api_key[0])
        ok = ok && json_dyn_printf(&hdrs, "Authorization: Bearer %s\n", g_remote_api_key);
    const char *body = job->body ? job->body : "{}";
    ok = ok && fd_write_all(hfd, hdrs.ptr ? hdrs.ptr : "", hdrs.len) &&
         fd_write_all(bfd, body, strlen(body));
    free(hdrs.ptr);
    close(hfd);
    close(bfd);
    if (!ok) {
        unlink(hpath); unlink(bpath);
        snprintf(err, errsz, "could not stage the remote model request");
        return 0;
    }

    /* base_url passed remote_value_safe (no quotes/spaces/control bytes); the
     * temp paths come from mkstemp under TMPDIR. Single-quote everything. */
    size_t blen = strlen(job->base_url);
    while (blen > 0 && job->base_url[blen - 1] == '/') job->base_url[--blen] = '\0';
    /* --http1.1: SSE through CDN-fronted APIs (CloudFront et al) is prone to
     * mid-stream h2 RST; plain HTTP/1.1 chunked streaming is the boring,
     * reliable path. */
    /* No --fail: on a 4xx/5xx the provider's JSON error document reaches
     * stdout, and quoting it verbatim beats guessing what went wrong. */
    char cmd[2200];
    snprintf(cmd, sizeof cmd,
             "curl -sN --http1.1 --max-time 1800 -H @'%s' --data-binary @'%s' '%s/v1/chat/completions'",
             hpath, bpath, job->base_url);
    FILE *p = popen(cmd, "r");
    if (!p) {
        unlink(hpath); unlink(bpath);
        snprintf(err, errsz, "could not start curl for the remote model");
        return 0;
    }
    json_dyn_buf sse_line = {0};
    char preview[400];
    size_t pn = 0;
    char buf[8192];
    size_t n;
    while (!job->done && (n = fread(buf, 1, sizeof buf, p)) > 0) {
        if (pn < sizeof preview - 1) {
            size_t c = sizeof preview - 1 - pn;
            if (c > n) c = n;
            memcpy(preview + pn, buf, c);
            pn += c;
            preview[pn] = '\0';
        }
        model_rpc_sse_bytes(job, buf, n, &sse_line);
    }
    if (!job->done && sse_line.len) model_rpc_sse_line(job, sse_line.ptr);
    int rc = pclose(p);
    free(sse_line.ptr);
    unlink(hpath);
    unlink(bpath);
    if (!job->done) {
        /* No [DONE] sentinel — but if the stream already delivered a
         * finish_reason the completion is semantically finished: some
         * CDN-fronted providers reset the connection right after the final
         * chunk (curl exit 56) and retrying would only re-bill the turn. */
        if (job->finish_reason[0]) return 1;
        if (pn && strncmp(preview, "data:", 5) != 0) {
            for (size_t i = 0; i < pn; i++)
                if ((unsigned char)preview[i] < 0x20) preview[i] = ' ';
            snprintf(err, errsz, "remote API error: %.300s", preview);
            return 0;
        }
        int code = rc > 255 ? rc >> 8 : rc;
        snprintf(err, errsz, "remote model stream ended before completion (curl exit %d)", code);
        return 0;
    }
    return 1;
#endif
}

static int model_rpc_http_stream(model_rpc_job *job, char *err, size_t errsz) {
    if (!strncmp(job->base_url, "https://", 8))
        return model_rpc_curl_stream(job, err, errsz);
    int fd = model_rpc_connect(job->base_url, err, errsz);
    if (fd < 0) return 0;
#ifdef _WIN32
    int tv = 1800 * 1000;
    (void)setsockopt((SOCKET)(intptr_t)fd, SOL_SOCKET, SO_RCVTIMEO, (const char *)&tv, sizeof tv);
    (void)setsockopt((SOCKET)(intptr_t)fd, SOL_SOCKET, SO_SNDTIMEO, (const char *)&tv, sizeof tv);
#else
    struct timeval tv = { 1800, 0 };
    (void)setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof tv);
    (void)setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof tv);
#endif
    char host[256];
    int port = 80;
    model_rpc_parse_base(job->base_url, host, sizeof host, &port);
    size_t body_len = strlen(job->body ? job->body : "{}");
    json_dyn_buf req = {0};
    int ok = json_dyn_printf(&req,
        "POST /v1/chat/completions HTTP/1.1\r\n"
        "Host: %s:%d\r\n"
        "Accept: text/event-stream\r\n"
        "Content-Type: application/json\r\n"
        "Content-Length: %zu\r\n"
        "Connection: close\r\n\r\n",
        host, port, body_len) &&
        json_dyn_putn(&req, job->body ? job->body : "{}", body_len);
    if (!ok || send_all(fd, req.ptr ? req.ptr : "", req.len) != 0) {
        free(req.ptr);
        close(fd);
        snprintf(err, errsz, "failed to send LAN model request");
        return 0;
    }
    free(req.ptr);

    json_dyn_buf head = {0};
    json_dyn_buf sse_line = {0};
    model_rpc_chunked ch = {0};
    int have_head = 0;
    int chunked = 0;
    char buf[8192];
    for (;;) {
        ssize_t n = recv(fd, buf, sizeof buf, 0);
        if (n < 0 && errno == EINTR) continue;
        if (n <= 0) break;
        const char *body = buf;
        size_t body_n = (size_t)n;
        if (!have_head) {
            json_dyn_putn(&head, buf, (size_t)n);
            char *end = head.ptr ? strstr(head.ptr, "\r\n\r\n") : NULL;
            if (!end) {
                if (head.len > 65536) {
                    snprintf(err, errsz, "LAN model response headers too large");
                    goto fail;
                }
                continue;
            }
            have_head = 1;
            size_t hlen = (size_t)(end - head.ptr) + 4;
            int status = 0;
            sscanf(head.ptr, "HTTP/%*s %d", &status);
            if (status < 200 || status >= 300) {
                snprintf(err, errsz, "LAN model returned HTTP %d", status ? status : 0);
                goto fail;
            }
            chunked = mem_contains_ci(head.ptr, hlen, "\r\nTransfer-Encoding: chunked") ||
                      mem_contains_ci(head.ptr, hlen, "\nTransfer-Encoding: chunked");
            body = head.ptr + hlen;
            body_n = head.len - hlen;
        }
        if (body_n > 0) {
            if (chunked) {
                if (!model_rpc_chunked_bytes(job, &ch, body, body_n, &sse_line)) {
                    snprintf(err, errsz, "invalid chunked LAN model stream");
                    goto fail;
                }
            } else {
                model_rpc_sse_bytes(job, body, body_n, &sse_line);
            }
        }
        if (job->done) break;
    }
    if (!job->done && sse_line.len) model_rpc_sse_line(job, sse_line.ptr);
    if (!job->done) {
        snprintf(err, errsz, "LAN model stream ended before completion%s%s",
                 job->finish_reason[0] ? " (finish_reason=" : "",
                 job->finish_reason[0] ? job->finish_reason : "");
        if (job->finish_reason[0] && strlen(err) + 2 < errsz) strcat(err, ")");
        goto fail;
    }
    free(head.ptr);
    free(sse_line.ptr);
    free(ch.size_line.ptr);
    close(fd);
    return 1;

fail:
    free(head.ptr);
    free(sse_line.ptr);
    free(ch.size_line.ptr);
    close(fd);
    return 0;
}

#ifdef _WIN32
static DWORD WINAPI model_rpc_thread_main(LPVOID arg)
#else
static void *model_rpc_thread_main(void *arg)
#endif
{
    model_rpc_job *job = (model_rpc_job *)arg;
    char err[512] = "";
    if (model_rpc_http_stream(job, err, sizeof err))
        model_rpc_write_frame(job, "model_done", NULL, NULL);
    else
        model_rpc_write_frame(job, "model_error", NULL, err[0] ? err : "LAN model request failed");
    free(job->body);
    free(job);
#ifdef _WIN32
    return 0;
#else
    return NULL;
#endif
}

static int model_rpc_start(int id, char *body) {
    model_rpc_job *job = (model_rpc_job *)calloc(1, sizeof *job);
    if (!job) { free(body); return 0; }
    job->id = id;
    job->in_fd = g_in_fd;
    job->body = body;
    snprintf(job->base_url, sizeof job->base_url, "%s", g_remote_base_url);
#ifdef _WIN32
    HANDLE h = CreateThread(NULL, 0, model_rpc_thread_main, job, 0, NULL);
    if (!h) { free(job->body); free(job); return 0; }
    CloseHandle(h);
#else
    pthread_t th;
    if (pthread_create(&th, NULL, model_rpc_thread_main, job) != 0) {
        free(job->body);
        free(job);
        return 0;
    }
    pthread_detach(th);
#endif
    return 1;
}

/* ==================== model / kv / port ==================== */

/* Active model variant the UI picked ("flash" | "pro"). Flash is the default
 * (the abliterated Flash GGUF). When "pro", the engine launches with MODEL_PRO. */
static char g_variant[16] = "flash";
static pid_t g_dl_pid = -1;          /* background model download, if any */
static char  g_dl_variant[16] = "";  /* which variant is downloading */
static char  g_model_override[1024] = ""; /* explicit GGUF the user picked (rel to ds4 dir); "" = use the variant */
static char  g_skill[64] = "";            /* active skill id (extension/skills/<id>); "" = none */
static char  g_design_system[64] = "";    /* active design-system id (design only); "" = none */
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
static int file_present_in_dir(const char *dir, const char *rel) {
    char full[2048];
    snprintf(full, sizeof full, "%s/%s", dir ? dir : "", rel ? rel : "");
    struct stat st;
    return stat(full, &st) == 0 && S_ISREG(st.st_mode) && st.st_size > 0;
}

static int file_present(const char *rel) {
    return file_present_in_dir(g_ds4_dir, rel);
}

static unsigned long long dstudio_physical_memory_bytes(void) {
#ifdef _WIN32
    MEMORYSTATUSEX st;
    memset(&st, 0, sizeof st);
    st.dwLength = sizeof st;
    if (GlobalMemoryStatusEx(&st)) return (unsigned long long)st.ullTotalPhys;
    return 0;
#elif defined(__APPLE__)
    uint64_t mem = 0;
    size_t len = sizeof mem;
    if (sysctlbyname("hw.memsize", &mem, &len, NULL, 0) == 0) return (unsigned long long)mem;
    return 0;
#else
    long pages = sysconf(_SC_PHYS_PAGES);
    long page_size = sysconf(_SC_PAGESIZE);
    if (pages > 0 && page_size > 0) return (unsigned long long)pages * (unsigned long long)page_size;
    return 0;
#endif
}

static long long current_model_file_size(void) {
    char full[2048];
    snprintf(full, sizeof full, "%s/%s", g_ds4_dir, current_model_rel());
    struct stat st;
    if (stat(full, &st) != 0 || !S_ISREG(st.st_mode)) return -1;
    return (long long)st.st_size;
}

static long long sysctl_iogpu_wired_limit_mb(void) {
#ifdef __APPLE__
    int64_t v = 0;
    size_t len = sizeof v;
    if (sysctlbyname("iogpu.wired_limit_mb", &v, &len, NULL, 0) == 0) {
        if (len == sizeof(int)) {
            int vi = 0;
            memcpy(&vi, &v, sizeof vi);
            return (long long)vi;
        }
        return (long long)v;
    }
    int vi = 0;
    len = sizeof vi;
    if (sysctlbyname("iogpu.wired_limit_mb", &vi, &len, NULL, 0) == 0) return (long long)vi;
#endif
    return -1;
}

static int engine_effective_ssd_streaming(const engine_cfg *cfg, int remote_model,
                                          char *reason, size_t reasonsz,
                                          char *err, size_t errsz) {
    if (reason && reasonsz) reason[0] = '\0';
    if (err && errsz) err[0] = '\0';
    if (!cfg || cfg->ssd_streaming == SSD_STREAMING_OFF) {
        snprintf(reason, reasonsz, "disabled");
        return 0;
    }
    if (remote_model) {
        if (cfg->ssd_streaming == SSD_STREAMING_ON) {
            snprintf(err, errsz, "--ssd-streaming is local Metal-only and cannot be used with a remote model");
            return -1;
        }
        snprintf(reason, reasonsz, "auto disabled for remote model");
        return 0;
    }
#ifdef _WIN32
    if (cfg->ssd_streaming == SSD_STREAMING_ON) {
        snprintf(err, errsz, "--ssd-streaming is Metal-only; this Windows runtime launches CPU binaries");
        return -1;
    }
    snprintf(reason, reasonsz, "auto disabled on Windows CPU runtime");
    return 0;
#elif !defined(__APPLE__)
    if (cfg->ssd_streaming == SSD_STREAMING_ON) {
        snprintf(err, errsz, "--ssd-streaming is currently supported only by ds4 Metal builds");
        return -1;
    }
    snprintf(reason, reasonsz, "auto disabled outside macOS Metal");
    return 0;
#else
    if (cfg->ssd_streaming == SSD_STREAMING_ON) {
        snprintf(reason, reasonsz, "forced on");
        return 1;
    }
    long long model_bytes = current_model_file_size();
    unsigned long long mem_bytes = dstudio_physical_memory_bytes();
    const unsigned long long gib = 1024ull * 1024ull * 1024ull;
    if (!strcmp(g_variant, "pro") ||
        (model_bytes > 64ll * 1024ll * 1024ll * 1024ll) ||
        (mem_bytes > 0 && mem_bytes <= 192ull * gib)) {
        snprintf(reason, reasonsz, "auto enabled for large ds4 model / memory pressure");
        return 1;
    }
    snprintf(reason, reasonsz, "auto disabled: memory budget is sufficient");
    return 0;
#endif
}

static int cfg_ssd_streaming(const engine_cfg *cfg, int remote_model,
                             char *err, size_t errsz) {
    char reason[192] = "";
    int use = engine_effective_ssd_streaming(cfg, remote_model, reason, sizeof reason, err, errsz);
    if (use < 0) return 0;
    g_ssd_streaming_effective = use;
    snprintf(g_ssd_streaming_reason, sizeof g_ssd_streaming_reason, "%s", reason);
    return 1;
}

static int model_present(int uncensored) {
    char full[2048];
    snprintf(full, sizeof full, "%s/%s", g_ds4_dir, uncensored ? MODEL_UNC : MODEL_STD);
    return access(full, R_OK) == 0;
}

/* The ds4 dir is "valid" if it exists AND looks like a ds4 checkout/install:
 * one of the engine binaries, the Makefile, or the Metal sources is present.
 * When this is false the UI prompts the user for the correct path. */
static int ds4_dir_valid_path(const char *dir) {
    struct stat st;
    if (!dir || stat(dir, &st) != 0 || !S_ISDIR(st.st_mode)) return 0;
    return file_present_in_dir(dir, "ds4-server") || file_present_in_dir(dir, "ds4-agent") ||
           file_present_in_dir(dir, "ds4-server.exe") || file_present_in_dir(dir, "ds4-agent.exe") ||
           file_present_in_dir(dir, "Makefile")   || file_present_in_dir(dir, "metal/ds4.metal") ||
           file_present_in_dir(dir, "ds4.c");
}

static int ds4_dir_valid(void) {
    return ds4_dir_valid_path(g_ds4_dir);
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

/* Background download of the bundled content (skills/design systems/gsa skills),
 * forked so the single-threaded server stays responsive; reaped in reap_child. */
static pid_t g_content_dl_pid = -1;
static unsigned long long g_content_dl_task = 0;

/* True if a single bundled-content dir under extension/ exists and is non-empty. */
static int content_subdir_present(const char *sub) {
    if (!g_web_dir[0]) return 1;   /* base unknown: never trigger a bogus download */
    char p[DSTUDIO_PATH_MAX];
    int n = snprintf(p, sizeof p, "%s/extension/%s", g_web_dir, sub);
    if (n < 0 || (size_t)n >= sizeof p) return 1;
    DIR *d = opendir(p);
    if (!d) return 0;
    int has = 0;
    struct dirent *e;
    while ((e = readdir(d))) {
        if (strcmp(e->d_name, ".") && strcmp(e->d_name, "..")) { has = 1; break; }
    }
    closedir(d);
    return has;
}

/* True once the downloadable content (skills, design systems, imported GSA
 * cybersecurity skills) is installed under extension/. */
static int content_present(void) {
    return content_subdir_present("skills") &&
           content_subdir_present("design-systems") &&
           content_subdir_present("gsa/third_party");
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
        char *sep =
#ifdef _WIN32
            strchr(p, ';');
#else
            strchr(p, ':');
#endif
        if (sep) *sep = '\0';
        if (p[0]) {
            char full[PATH_MAX];
            if (!path_join(full, sizeof full, p, name)) {
                p = sep ? sep + 1 : NULL;
                continue;
            }
            if (access(full, X_OK) == 0) return 1;
#ifdef _WIN32
            const char *exts[] = { ".exe", ".cmd", ".bat", NULL };
            for (int i = 0; exts[i]; i++) {
                char extfull[PATH_MAX];
                snprintf(extfull, sizeof extfull, "%s%s", full, exts[i]);
                if (access(extfull, X_OK) == 0 || access(extfull, R_OK) == 0) return 1;
            }
#endif
        }
        p = sep ? sep + 1 : NULL;
    }
    return 0;
}

/* Resolve a program to an absolute path, searching $PATH first and then a set
 * of well-known install directories. GUI-launched apps (Finder/Dock on macOS,
 * launchd) start with a minimal PATH that omits Homebrew/MacPorts, so a bare
 * execvp("node", ...) fails with exit 127 even when node is installed. Returns
 * 1 and fills `out` on success, 0 if the program cannot be located. */
static int resolve_program_path(const char *name, const char *const extra_dirs[],
                                char *out, size_t outsz) {
    const char *path = getenv("PATH");
    if (path && path[0]) {
        char buf[4096];
        cstr_copy(buf, sizeof buf, path);
        for (char *p = buf; p && *p; ) {
#ifdef _WIN32
            char *sep = strchr(p, ';');
#else
            char *sep = strchr(p, ':');
#endif
            if (sep) *sep = '\0';
            if (p[0]) {
                char full[PATH_MAX];
                if (path_join(full, sizeof full, p, name) && access(full, X_OK) == 0) {
                    cstr_copy(out, outsz, full);
                    return 1;
                }
            }
            p = sep ? sep + 1 : NULL;
        }
    }
    for (int i = 0; extra_dirs && extra_dirs[i]; i++) {
        if (!extra_dirs[i][0]) continue;
        char full[PATH_MAX];
        if (path_join(full, sizeof full, extra_dirs[i], name) && access(full, X_OK) == 0) {
            cstr_copy(out, outsz, full);
            return 1;
        }
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
    else if (strstr(line, "context buffers") || strstr(line, "KV disk cache")) {
        if (MODE_IS_PIPED(g_mode)) {
            set_stage("Ready", 100);
            g_ready = 1;
            maybe_complete_launch_task(g_mode);
        } else {
            set_stage("Allocating the context…", 75);
        }
    }
    else if (strstr(line, "warming") || strstr(line, "expert"))
        set_stage("Warming up…", 85);
    else if (strstr(line, "listening on"))      /* server ready */
        { set_stage("Ready", 100); g_ready = 1; maybe_complete_launch_task(ENGINE_SERVER); }
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
                    maybe_complete_launch_task(g_mode);
                    if (g_active_turn_task) {
                        task_mark_completed(g_active_turn_task, "agent/design turn completed");
                        g_active_turn_task = 0;
                    }
                    g_active_turn_compacting = 0;
                    g_agent_working = 0;
                    g_interrupt_pending = 0;
                } else if (g_active_turn_task && strstr(acc, "COMPACTING")) {
                    if (!g_active_turn_compacting) {
                        g_active_turn_compacting = 1;
                        task_mark_working(g_active_turn_task,
                                          "agent/design context compaction in progress; waiting for final output");
                        dstudio_log_event("warn", "engine", g_active_turn_task,
                                          "context compaction during active turn");
                    }
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

static void drain_child_stdout_plain(const char *data, size_t n) {
    if (!n) return;
    if (MODE_IS_PIPED(g_mode)) agent_buf_append(data, n);
    scan_lines(data, n, g_line_out, &g_line_out_len, 0);
}

static void model_rpc_send_start_error(long id, const char *msg) {
    if (g_in_fd < 0) return;
    model_rpc_job job;
    memset(&job, 0, sizeof job);
    job.id = (int)id;
    job.in_fd = g_in_fd;
    model_rpc_write_frame(&job, "model_error", NULL, msg);
}

static int handle_child_event_line(const char *line) {
    if (!line) return 0;
    const char *p = line;
    if ((unsigned char)p[0] == 0x1e) p++;
    if (!strstr(p, "\"type\":\"model_request\"")) return 0;

    long id = 0;
    if (json_get_int(p, "id", 0, 2147483647L, &id) <= 0) return 1;
    char *body = json_get_string_alloc_rpc(p, "body");
    if (!body) {
        model_rpc_send_start_error(id, "invalid internal model request");
        return 1;
    }
    if (g_in_fd < 0 || !g_remote_base_url[0]) {
        free(body);
        model_rpc_send_start_error(id, "LAN model host is not configured");
        return 1;
    }
    if (!model_rpc_start((int)id, body))
        model_rpc_send_start_error(id, "failed to start internal LAN model request");
    return 1;
}

static void drain_child_event_finish(void) {
    if (!g_child_event_active) return;
    if (g_child_event_line.ptr && g_child_event_line.len) {
        if (!handle_child_event_line(g_child_event_line.ptr))
            drain_child_stdout_plain(g_child_event_line.ptr, g_child_event_line.len);
    }
    g_child_event_line.len = 0;
    if (g_child_event_line.ptr) g_child_event_line.ptr[0] = '\0';
    g_child_event_active = 0;
}

static void drain_child_stdout_data(const char *data, size_t n) {
    size_t plain_start = 0;
    for (size_t i = 0; i < n; i++) {
        unsigned char c = (unsigned char)data[i];
        if (g_child_event_active) {
            if (!json_dyn_putn(&g_child_event_line, data + i, 1)) {
                g_child_event_active = 0;
                g_child_event_line.len = 0;
                if (g_child_event_line.ptr) g_child_event_line.ptr[0] = '\0';
                plain_start = i + 1;
                continue;
            }
            if (c == '\n') {
                drain_child_event_finish();
                plain_start = i + 1;
            }
            continue;
        }
        if (c == 0x1e) {
            if (i > plain_start) drain_child_stdout_plain(data + plain_start, i - plain_start);
            g_child_event_active = 1;
            g_child_event_line.len = 0;
            if (g_child_event_line.ptr) g_child_event_line.ptr[0] = '\0';
            json_dyn_putn(&g_child_event_line, data + i, 1);
            plain_start = i + 1;
        }
    }
    if (!g_child_event_active && n > plain_start)
        drain_child_stdout_plain(data + plain_start, n - plain_start);
}

static void agent_buf_reset(void) {
    g_alen = g_abase = 0;
    g_interrupt_pending = 0;
    g_line_out_len = g_line_err_len = 0;
    g_child_event_active = 0;
    g_child_event_line.len = 0;
    if (g_child_event_line.ptr) g_child_event_line.ptr[0] = '\0';
}

static void sse_close_all(void);
static void close_pipes(void);

/* ==================== process management ==================== */

static void reap_child(void) {
    if (g_dl_pid > 0) {
        int dst;
        if (waitpid(g_dl_pid, &dst, WNOHANG) == g_dl_pid) {
            int code = WIFEXITED(dst) ? WEXITSTATUS(dst) : -1;
            printf("model: download of %s finished (exit %d)\n", g_dl_variant, code);
            if (g_active_download_task) {
                if (code == 0) task_mark_completed(g_active_download_task, "model download completed");
                else task_mark_failed(g_active_download_task, "model download failed", g_dl_variant);
                g_active_download_task = 0;
            }
            g_dl_pid = -1;   /* keep g_dl_variant so status can report 100 / completion once */
        }
    }
    if (g_content_dl_pid > 0) {
        int cst;
        if (waitpid(g_content_dl_pid, &cst, WNOHANG) == g_content_dl_pid) {
            int code = WIFEXITED(cst) ? WEXITSTATUS(cst) : -1;
            printf("content: download child (pid %d) finished (exit %d)\n", (int)g_content_dl_pid, code);
            if (g_content_dl_task) {
                if (code == 0) task_mark_completed(g_content_dl_task, "bundled content installed");
                else task_mark_failed(g_content_dl_task, "content download failed", "see /tmp/ds4-content-dl.log");
                g_content_dl_task = 0;
            }
            dstudio_log_event(code == 0 ? "info" : "error", "setup", 0,
                              "bundled content download %s", code == 0 ? "completed" : "failed");
            g_content_dl_pid = -1;
        }
    }
    if (g_child <= 0) return;
    int st;
    if (waitpid(g_child, &st, WNOHANG) == g_child) {
        int interrupted_exit = g_interrupt_pending &&
            g_last_engine_line[0] &&
            (strstr(g_last_engine_line, "ds4-agent: interrupted") ||
             !strcmp(g_last_engine_line, "interrupted"));
        /* The child died on its own (a clean stop goes through stop_child, which
         * reaps it there). Record WHY — exit code/signal + its last line — so the
         * UI can show the reason instead of just "Server unreachable". */
        if (interrupted_exit)
            snprintf(g_engine_err, sizeof g_engine_err, "agent/design turn interrupted");
        else if (WIFSIGNALED(st))
            snprintf(g_engine_err, sizeof g_engine_err, "engine stopped (signal %d)%s%.200s",
                     WTERMSIG(st), g_last_engine_line[0] ? " — " : "", g_last_engine_line);
        else
            snprintf(g_engine_err, sizeof g_engine_err, "engine exited (code %d)%s%.200s",
                     WIFEXITED(st) ? WEXITSTATUS(st) : -1,
                     g_last_engine_line[0] ? " — " : "", g_last_engine_line);
        printf("engine: pid %d terminated — %s\n", (int)g_child, g_engine_err);
        dstudio_log_event(interrupted_exit ? "info" : "error", "engine",
                          g_active_turn_task ? g_active_turn_task : g_active_launch_task,
                          "pid %d terminated: %s", (int)g_child, g_engine_err);
        if (g_active_turn_task) {
            if (interrupted_exit)
                task_mark_canceled(g_active_turn_task, "agent/design turn interrupted");
            else
                task_mark_incomplete(g_active_turn_task,
                                     "engine process stopped before completing the turn",
                                     g_engine_err[0] ? g_engine_err : "unknown process failure");
            g_active_turn_task = 0;
        }
        if (g_active_launch_task) {
            task_mark_failed(g_active_launch_task,
                             "engine process stopped before becoming ready",
                             g_engine_err[0] ? g_engine_err : "unknown process failure");
            g_active_launch_task = 0;
            g_active_launch_mode = ENGINE_NONE;
        }
        if (!interrupted_exit && MODE_IS_PIPED(g_mode) && g_agent_working) {
            char msg[640];
            int n = snprintf(msg, sizeof msg,
                "\nEngine process stopped before completing the turn: %s\n",
                g_engine_err[0] ? g_engine_err : "unknown process failure");
            if (n > 0) agent_buf_append(msg, (size_t)n);
        }
        g_agent_working = 0;
        g_interrupt_pending = 0;
        g_active_turn_compacting = 0;
        g_child = -1;
#ifdef _WIN32
        g_child_win_pid = 0;
#endif
        close_pipes();
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
    sse_close_all();
    if (g_child <= 0) { g_mode = ENGINE_NONE; return; }
    printf("engine: stopping pid %d…\n", (int)g_child);
    dstudio_log_event("info", "engine", g_active_turn_task ? g_active_turn_task : g_active_launch_task,
                      "stopping pid %d", (int)g_child);
    if (g_active_turn_task) {
        task_mark_canceled(g_active_turn_task, "engine stopped by DStudio");
        g_active_turn_task = 0;
    }
    if (g_active_launch_task) {
        task_mark_canceled(g_active_launch_task, "engine stopped by DStudio");
        g_active_launch_task = 0;
        g_active_launch_mode = ENGINE_NONE;
    }
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
    g_interrupt_pending = 0;
    g_active_turn_compacting = 0;
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
/* GLM GGUFs (ds4 glm5.2 branch) reject --power below 100 at engine init and
 * need the full-layer streaming prefill path; detect them by filename so the
 * spawns can adapt flags and env. */
static int model_is_glm(void) {
    const char *rel = current_model_rel();
    const char *base = strrchr(rel, '/');
    return strstr(base ? base + 1 : rel, "GLM") != NULL;
}

static void child_setenv_metal(void) {
    setenv("DS4_METAL_NO_RESIDENCY", "1", 1);
    setenv("DS4_METAL_NO_MODEL_WARMUP", "1", 1);
    setenv("DS4_METAL_PREFILL_CHUNK", "1024", 1);
    setenv("DS4_METAL_GRAPH_TOKEN_SPLIT_LAYERS", "0", 1);
    /* GLM streaming: the batch-selected-addr prefill path fails on partial
     * model maps (model >> RAM); the full-layer prefill path is the one that
     * works with the on-demand exact-view fallback. */
    if (model_is_glm())
        setenv("DS4_METAL_GLM_STREAMING_PREFILL_FULL_LAYER", "1", 1);
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

static int cyber_skills_dir(char *out, size_t outsz) {
    if (!g_web_dir[0]) return 0;
    snprintf(out, outsz, "%s/%s", g_web_dir, CYBER_SKILLS_REL_DIR);
    struct stat st;
    return stat(out, &st) == 0 && S_ISDIR(st.st_mode);
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
    /* The see_image agent tool posts images to this DStudio server's
     * /api/vision/describe (which runs the local vision model), so the agent
     * needs no vision code of its own. */
    char vurl[64];
    snprintf(vurl, sizeof vurl, "http://127.0.0.1:%d", g_http_port);
    setenv("DS4UI_DSTUDIO_URL", vurl, 1);
    char u[1100];
    user_skills_dir(u, sizeof u);
    setenv("DS4UI_USER_SKILLS_DIR", u, 1);
    char cyber[2300];
    if (cyber_skills_dir(cyber, sizeof cyber))
        setenv("DS4UI_CYBER_SKILLS_DIR", cyber, 1);
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

static int win_app_dir(char *out, size_t outsz) {
    DWORD n = GetModuleFileNameA(NULL, out, (DWORD)outsz);
    if (n == 0 || n >= outsz) return 0;
    char *s1 = strrchr(out, '\\');
    char *s2 = strrchr(out, '/');
    char *slash = s1 > s2 ? s1 : s2;
    if (!slash) return 0;
    *slash = '\0';
    return 1;
}

static void win_copy_packaged_file_to_ds4(const char *name) {
    char appdir[DSTUDIO_PATH_MAX];
    if (!win_app_dir(appdir, sizeof appdir)) return;
    char src[DSTUDIO_PATH_MAX + 128], dst[DSTUDIO_PATH_MAX + 128];
    win_join_path(src, sizeof src, appdir, name);
    win_join_path(dst, sizeof dst, g_ds4_dir, name);
    if (access(src, R_OK) != 0) return;
    if (!_stricmp(src, dst)) return;
    CopyFileA(src, dst, FALSE);
}

static void win_copy_packaged_engine_to_ds4(void) {
    static const char *files[] = {
        "ds4-server.exe",
        "ds4-agent.exe",
        "ds4-agent-jsonl.exe",
        "ds4-agent-jsonl.ver",
        "ds4-design.exe",
        NULL
    };
    for (int i = 0; files[i]; i++) win_copy_packaged_file_to_ds4(files[i]);
}

static void win_remove_copied_posix_runtime_from_ds4(void) {
    static const char *dlls[] = {
        "msys-2.0.dll", "msys-gcc_s-seh-1.dll",
        "msys-z-1.dll", "msys-zstd-1.dll",
        "msys-iconv-2.dll", "msys-intl-8.dll",
        "msys-curl-4.dll", "msys-nghttp2-14.dll",
        "msys-ssl-3.dll", "msys-crypto-3.dll",
        "msys-brotlidec-1.dll", "msys-brotlicommon-1.dll",
        "msys-idn2-0.dll", "msys-psl-5.dll",
        "msys-unistring-5.dll", "msys-ssh2-1.dll",
        "cygwin1.dll", "cyggcc_s-seh-1.dll",
        NULL
    };
    for (int i = 0; dlls[i]; i++) {
        char path[DSTUDIO_PATH_MAX + 128];
        win_join_path(path, sizeof path, g_ds4_dir, dlls[i]);
        DeleteFileA(path);
    }
}

static void win_prepare_engine_runtime(void) {
    SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX | SEM_NOOPENFILEERRORBOX);
    win_remove_copied_posix_runtime_from_ds4();
    win_copy_packaged_engine_to_ds4();

    static char prepared_for[DSTUDIO_PATH_MAX] = "";
    if (!strcmp(prepared_for, g_ds4_dir)) return;

    char appdir[DSTUDIO_PATH_MAX];
    if (!win_app_dir(appdir, sizeof appdir)) appdir[0] = '\0';
    const char *old = getenv("PATH");
    const char *prefix_fmt = "C:\\msys64\\usr\\bin;C:\\msys64\\ucrt64\\bin;C:\\msys64\\mingw64\\bin;C:\\msys64\\clang64\\bin;C:\\cygwin64\\bin;%s;%s";
    size_t need = strlen(g_ds4_dir) + strlen(appdir) + (old ? strlen(old) : 0) + 220;
    char *path = malloc(need);
    if (!path) return;
    snprintf(path, need, prefix_fmt, g_ds4_dir, appdir);
    if (old && old[0]) {
        size_t len = strlen(path);
        snprintf(path + len, need - len, ";%s", old);
    }
    _putenv_s("PATH", path);
    free(path);
    cstr_copy(prepared_for, sizeof prepared_for, g_ds4_dir);
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
    if (!cfg_ssd_streaming(cfg, 0, err, errsz)) return 0;

    char ports[16], ctxs[16], pows[16], kvs[16], mins[16];
    snprintf(ports, sizeof ports, "%d", cfg->port);
    snprintf(ctxs,  sizeof ctxs,  "%d", cfg->ctx);
    snprintf(pows,  sizeof pows,  "%d", cfg->power);
    snprintf(kvs,   sizeof kvs,   "%d", cfg->kv_space_mb);
    snprintf(mins,  sizeof mins,  "%d", cfg->kv_min_tok);

#ifdef _WIN32
    if (!file_present("ds4-server.exe")) {
        snprintf(err, errsz, "ds4-server.exe not found in %s — use the Windows CPU artifact", g_ds4_dir);
        return 0;
    }
    win_prepare_engine_runtime();
    int op[2], ep[2];
    (void)op; (void)ep;
    char exe[2200];
    win_join_path(exe, sizeof exe, g_ds4_dir, "ds4-server.exe");
    char *argv[24]; int n = 0;
    argv[n++] = exe; argv[n++] = "-m"; argv[n++] = (char *)current_model_rel(); argv[n++] = "--cpu";
    argv[n++] = "--host"; argv[n++] = g_bind_host; argv[n++] = "--port"; argv[n++] = ports;
    argv[n++] = "--ctx"; argv[n++] = ctxs;
    if (!model_is_glm()) { argv[n++] = "--power"; argv[n++] = pows; }
    argv[n++] = "--kv-disk-dir"; argv[n++] = kvdir; argv[n++] = "--kv-disk-space-mb"; argv[n++] = kvs;
    argv[n++] = "--kv-cache-min-tokens"; argv[n++] = mins; argv[n++] = "--cors";
    argv[n] = NULL;
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

    pid_t pid = fork();
    if (pid < 0) { snprintf(err, errsz, "fork: %s", strerror(errno)); return 0; }
    if (pid == 0) {
        if (chdir(g_ds4_dir) != 0) _exit(127);
        child_setenv_metal();
        dup2(op[1], STDOUT_FILENO);
        dup2(ep[1], STDERR_FILENO);
        close(op[0]); close(op[1]); close(ep[0]); close(ep[1]);
        if (g_srv_fd >= 0) close(g_srv_fd);
        char *argv[26]; int n = 0;
        argv[n++] = "./ds4-server"; argv[n++] = "-m"; argv[n++] = (char *)current_model_rel();
        argv[n++] = "--host"; argv[n++] = g_bind_host; argv[n++] = "--port"; argv[n++] = ports;
        argv[n++] = "--ctx"; argv[n++] = ctxs;
        if (!model_is_glm()) { argv[n++] = "--power"; argv[n++] = pows; }
        if (g_ssd_streaming_effective) argv[n++] = "--ssd-streaming";
        /* GLM: the auto expert-cache budget lands under the per-token working
         * set (heavy thrashing); a larger explicit budget decodes ~2x faster.
         * The engine still self-caps it after context/KV accounting. */
        if (g_ssd_streaming_effective && model_is_glm()) {
            argv[n++] = "--ssd-streaming-cache-experts"; argv[n++] = "32GB";
        }
        argv[n++] = "--kv-disk-dir"; argv[n++] = kvdir; argv[n++] = "--kv-disk-space-mb"; argv[n++] = kvs;
        argv[n++] = "--kv-cache-min-tokens"; argv[n++] = mins; argv[n++] = "--cors";
        argv[n] = NULL;
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
 * --jsonl extension patcher.
 * Reversible and additive patch of upstream ds4 sources. Patch bodies live under
 * patch/ as ordered anchor files so missing files and anchor drift fail loudly.
 * ============================================================================ */
#define JSONL_MARK "/*DS4UI_JSONL*/"
#define WEB_CDP_MARK "/*DS4UI_WEB_CDP*/"
#define WEB_DIRECT_NAV_MARK "/*DS4UI_WEB_DIRECT_NAV*/"
#define JSONL_PATCH_DIR "patch/ds4-agent-jsonl"
#define WEB_CDP_PATCH_DIR "patch/ds4-web-cdp"
#define WEB_DIRECT_NAV_PATCH_DIR "patch/ds4-web-direct-nav"

typedef struct {
    char id[32];
    char find_path[DSTUDIO_PATH_MAX + 512];
    char replace_path[DSTUDIO_PATH_MAX + 512];
    char *find;
    char *replace;
} ds4ui_patch_edit;

typedef struct {
    char rel_dir[160];
    char name[80];
    char dir_path[DSTUDIO_PATH_MAX + 512];
    char fragment_path[DSTUDIO_PATH_MAX + 512];
    char makefile_path[DSTUDIO_PATH_MAX + 512];
    int version;
    ds4ui_patch_edit *edits;
    int count;
} ds4ui_patch_set;

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

static int patch_fail(const char *fmt, ...) {
    char msg[640];
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(msg, sizeof msg, fmt, ap);
    va_end(ap);
    fprintf(stderr, "DStudio patch error: %s\n", msg);
    snprintf(g_engine_err, sizeof g_engine_err, "patch error: %.220s", msg);
    return 0;
}

static char *patch_trim(char *s) {
    while (s && isspace((unsigned char)*s)) s++;
    if (!s) return s;
    char *e = s + strlen(s);
    while (e > s && isspace((unsigned char)e[-1])) *--e = '\0';
    return s;
}

static int patch_leaf_ok(const char *leaf) {
    if (!leaf || !leaf[0]) return 0;
    for (const unsigned char *p = (const unsigned char *)leaf; *p; p++) {
        if (isalnum(*p) || *p == '-' || *p == '_' || *p == '.') continue;
        return 0;
    }
    return 1;
}

static int patch_resolve_dir(const char *rel_dir, char *out, size_t outsz) {
    char primary[DSTUDIO_PATH_MAX + 512];
    if (g_web_dir[0]) {
        snprintf(primary, sizeof primary, "%s/%s", g_web_dir, rel_dir);
        if (access(primary, R_OK) == 0) {
            cstr_copy(out, outsz, primary);
            return 1;
        }
    }
    snprintf(primary, sizeof primary, "%s", rel_dir);
    if (access(primary, R_OK) == 0) {
        cstr_copy(out, outsz, primary);
        return 1;
    }
    if (g_web_dir[0])
        return patch_fail("patch directory not found: %s/%s", g_web_dir, rel_dir);
    return patch_fail("patch directory not found: %s", rel_dir);
}

static int patch_dir_newer_than(const char *rel_dir, time_t cutoff) {
    char dir[DSTUDIO_PATH_MAX + 512];
    if (!patch_resolve_dir(rel_dir, dir, sizeof dir)) return 1;
    DIR *d = opendir(dir);
    if (!d) return 1;
    int newer = 0;
    struct dirent *de;
    while ((de = readdir(d)) != NULL) {
        const char *name = de->d_name;
        if (!strcmp(name, ".") || !strcmp(name, "..")) continue;
        char file[DSTUDIO_PATH_MAX + 1024];
        if ((size_t)snprintf(file, sizeof file, "%s/%s", dir, name) >= sizeof file) {
            newer = 1;
            break;
        }
        struct stat st;
        if (stat(file, &st) != 0) {
            newer = 1;
            break;
        }
        if (st.st_mtime > cutoff) {
            newer = 1;
            break;
        }
    }
    closedir(d);
    return newer;
}

static int patch_join_leaf(const ds4ui_patch_set *set, const char *leaf, char *out, size_t outsz) {
    if (!patch_leaf_ok(leaf))
        return patch_fail("invalid patch file name '%s' in %s", leaf ? leaf : "", set->rel_dir);
    int n = snprintf(out, outsz, "%s/%s", set->dir_path, leaf);
    if (n < 0 || (size_t)n >= outsz)
        return patch_fail("patch path too long: %s/%s", set->dir_path, leaf);
    return 1;
}

static void patch_free_set(ds4ui_patch_set *set) {
    if (!set) return;
    for (int i = 0; i < set->count; i++) {
        free(set->edits[i].find);
        free(set->edits[i].replace);
    }
    free(set->edits);
    memset(set, 0, sizeof *set);
}

static int patch_add_edit(ds4ui_patch_set *set, const char *id) {
    if (!patch_leaf_ok(id))
        return patch_fail("invalid edit id '%s' in %s", id ? id : "", set->rel_dir);
    if (set->count >= 512)
        return patch_fail("too many patch edits in %s", set->rel_dir);
    ds4ui_patch_edit *next = realloc(set->edits, (size_t)(set->count + 1) * sizeof *set->edits);
    if (!next) return patch_fail("out of memory loading patch manifest %s", set->rel_dir);
    set->edits = next;
    ds4ui_patch_edit *edit = &set->edits[set->count++];
    memset(edit, 0, sizeof *edit);
    cstr_copy(edit->id, sizeof edit->id, id);
    return 1;
}

static char *patch_read_text(const char *path, size_t *len) {
    size_t n = 0;
    char *body = jsonl_read_file(path, &n);
    if (!body) {
        patch_fail("cannot read patch file %s: %s", path, strerror(errno));
        return NULL;
    }
    jsonl_normalize_newlines(body, &n);
    if (len) *len = n;
    return body;
}

static int patch_load_set(const char *rel_dir, ds4ui_patch_set *set) {
    memset(set, 0, sizeof *set);
    cstr_copy(set->rel_dir, sizeof set->rel_dir, rel_dir);
    if (!patch_resolve_dir(rel_dir, set->dir_path, sizeof set->dir_path)) return 0;

    char manifest_path[DSTUDIO_PATH_MAX + 512];
    if (!patch_join_leaf(set, "manifest", manifest_path, sizeof manifest_path)) return 0;
    size_t manifest_len = 0;
    char *manifest = patch_read_text(manifest_path, &manifest_len);
    if (!manifest) return 0;

    for (char *line = manifest; line && *line; ) {
        char *next = strchr(line, '\n');
        if (next) *next++ = '\0';
        char *trimmed = patch_trim(line);
        if (!trimmed[0] || trimmed[0] == '#') { line = next; continue; }
        char *eq = strchr(trimmed, '=');
        if (!eq) {
            free(manifest);
            patch_free_set(set);
            return patch_fail("invalid manifest line in %s: %s", manifest_path, trimmed);
        }
        *eq = '\0';
        char *key = patch_trim(trimmed);
        char *val = patch_trim(eq + 1);
        if (!strcmp(key, "name")) {
            cstr_copy(set->name, sizeof set->name, val);
        } else if (!strcmp(key, "version")) {
            char *end = NULL;
            long v = strtol(val, &end, 10);
            if (end == val || *end != '\0' || v <= 0 || v > 1000000) {
                free(manifest);
                patch_free_set(set);
                return patch_fail("invalid patch version in %s: %s", manifest_path, val);
            }
            set->version = (int)v;
        } else if (!strcmp(key, "edit")) {
            if (!patch_add_edit(set, val)) { free(manifest); patch_free_set(set); return 0; }
        } else if (!strcmp(key, "fragment")) {
            if (!patch_join_leaf(set, val, set->fragment_path, sizeof set->fragment_path)) {
                free(manifest); patch_free_set(set); return 0;
            }
        } else if (!strcmp(key, "makefile")) {
            if (!patch_join_leaf(set, val, set->makefile_path, sizeof set->makefile_path)) {
                free(manifest); patch_free_set(set); return 0;
            }
        } else {
            free(manifest);
            patch_free_set(set);
            return patch_fail("unknown manifest key '%s' in %s", key, manifest_path);
        }
        line = next;
    }
    free(manifest);
    if (!set->name[0]) cstr_copy(set->name, sizeof set->name, rel_dir);
    if (set->count <= 0) {
        patch_free_set(set);
        return patch_fail("patch manifest has no edits: %s", manifest_path);
    }

    for (int i = 0; i < set->count; i++) {
        char leaf[80];
        int n = snprintf(leaf, sizeof leaf, "%s.find", set->edits[i].id);
        if (n < 0 || (size_t)n >= sizeof leaf ||
            !patch_join_leaf(set, leaf, set->edits[i].find_path, sizeof set->edits[i].find_path)) {
            patch_free_set(set);
            return 0;
        }
        n = snprintf(leaf, sizeof leaf, "%s.replace", set->edits[i].id);
        if (n < 0 || (size_t)n >= sizeof leaf ||
            !patch_join_leaf(set, leaf, set->edits[i].replace_path, sizeof set->edits[i].replace_path)) {
            patch_free_set(set);
            return 0;
        }
        set->edits[i].find = patch_read_text(set->edits[i].find_path, NULL);
        set->edits[i].replace = patch_read_text(set->edits[i].replace_path, NULL);
        if (!set->edits[i].find || !set->edits[i].replace) {
            patch_free_set(set);
            return 0;
        }
        if (!set->edits[i].find[0]) {
            patch_fail("empty patch anchor: %s", set->edits[i].find_path);
            patch_free_set(set);
            return 0;
        }
    }
    return 1;
}

static int jsonl_patch_version(void) {
    ds4ui_patch_set patch;
    if (!patch_load_set(JSONL_PATCH_DIR, &patch)) return -1;
    int version = patch.version;
    patch_free_set(&patch);
    if (version <= 0) {
        patch_fail("%s manifest is missing a positive version", JSONL_PATCH_DIR);
        return -1;
    }
    return version;
}

static char *jsonl_read_patch_makefile(size_t *len) {
    ds4ui_patch_set patch;
    if (!patch_load_set(JSONL_PATCH_DIR, &patch)) return NULL;
    if (!patch.makefile_path[0]) {
        patch_free_set(&patch);
        patch_fail("%s manifest is missing makefile=", JSONL_PATCH_DIR);
        return NULL;
    }
    char path[DSTUDIO_PATH_MAX + 512];
    cstr_copy(path, sizeof path, patch.makefile_path);
    patch_free_set(&patch);
    return patch_read_text(path, len);
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
static void url_decode_into(const char *src, size_t n, char *out, size_t outsz);  /* fwd */

static void query_param(const char *path, const char *key, char *out, size_t outsz) {
    out[0] = '\0';
    const char *q = strchr(path, '?');
    if (!q) return;
    q++;
    size_t klen = strlen(key);
    while (*q) {
        const char *amp = strchr(q, '&');
        size_t seglen = amp ? (size_t)(amp - q) : strlen(q);
        if (seglen > klen && !strncmp(q, key, klen) && q[klen] == '=') {
            url_decode_into(q + klen + 1, seglen - klen - 1, out, outsz);
            for (char *p = out; *p; p++) if (*p == '+') *p = ' ';
            return;
        }
        if (!amp) break;
        q = amp + 1;
    }
}

static int text_contains_ci(const char *hay, const char *needle) {
    if (!needle || !needle[0]) return 1;
    return hay && mem_contains_ci(hay, strlen(hay), needle);
}


/* Skill search is SEMANTIC (embedding cosine), not lexical — the corpus is
 * enumerated here and ranked by the embedding provider further below. */

/* One ranked search hit (owns its strings). */
typedef struct {
    char *id, *name, *desc, *source, *domain, *subdomain, *tags, *license;
    int has_assets, has_refs, has_scripts;
    int score, order;
} skill_hit;
typedef struct { skill_hit *v; int n, cap; } skill_hit_list;

static int skill_hits_push(skill_hit_list *L, skill_hit h) {
    if (L->n >= L->cap) {
        int nc = L->cap ? L->cap * 2 : 64;
        skill_hit *nv = realloc(L->v, (size_t)nc * sizeof *nv);
        if (!nv) return 0;
        L->v = nv; L->cap = nc;
    }
    L->v[L->n++] = h;
    return 1;
}
static void skill_hit_free_fields(skill_hit *h) {
    free(h->id); free(h->name); free(h->desc); free(h->source);
    free(h->domain); free(h->subdomain); free(h->tags); free(h->license);
}
static void skill_hits_free(skill_hit_list *L) {
    for (int i = 0; i < L->n; i++) skill_hit_free_fields(&L->v[i]);
    free(L->v);
}
static int skill_hit_cmp(const void *a, const void *b) {
    const skill_hit *x = a, *y = b;
    if (x->score != y->score) return y->score - x->score;   /* score desc */
    return x->order - y->order;                             /* else stable scan order */
}

/* Enumerate every skill under <dir> into L (no scoring — the embedding cosine
 * ranks them). `embed_text` per hit = name + description + tags, used to build
 * the embedding index; the display fields feed the JSON result. Order/score are
 * filled by the semantic ranker. */
static int skill_enum_dir(skill_hit_list *L, const char *dir, const char *file, const char *source) {
    DIR *d = opendir(dir);
    if (!d) return 1;
    struct dirent *de;
    while ((de = readdir(d)) != NULL) {
        const char *id = de->d_name;
        if (id[0] == '.' || !skill_id_ok(id)) continue;
        char md[PATH_MAX];
        if ((size_t)snprintf(md, sizeof md, "%s/%s/%s", dir, id, file) >= sizeof md)
            continue;
        size_t len = 0;
        char *content = jsonl_read_file(md, &len);
        if (!content) continue;
        char nm[300], desc[1000], domain[120], subdomain[160], tags[600], license[120];
        fm_field(content, "name", nm, sizeof nm);
        fm_field(content, "description", desc, sizeof desc);
        fm_field(content, "domain", domain, sizeof domain);
        fm_field(content, "subdomain", subdomain, sizeof subdomain);
        fm_field(content, "tags", tags, sizeof tags);
        fm_field(content, "license", license, sizeof license);
        free(content);
        if (!nm[0]) cstr_copy(nm, sizeof nm, id);
        char assets[PATH_MAX], refs[PATH_MAX], scripts[PATH_MAX];
        snprintf(assets, sizeof assets, "%s/%s/assets", dir, id);
        snprintf(refs, sizeof refs, "%s/%s/references", dir, id);
        snprintf(scripts, sizeof scripts, "%s/%s/scripts", dir, id);
        skill_hit h = {0};
        h.id = ds4_strdup_local(id);   h.name = ds4_strdup_local(nm);
        h.desc = ds4_strdup_local(desc); h.source = ds4_strdup_local(source);
        h.domain = ds4_strdup_local(domain); h.subdomain = ds4_strdup_local(subdomain);
        h.tags = ds4_strdup_local(tags); h.license = ds4_strdup_local(license);
        h.has_assets = access(assets, R_OK) == 0;
        h.has_refs = access(refs, R_OK) == 0;
        h.has_scripts = access(scripts, R_OK) == 0;
        h.score = 0; h.order = 0;
        if (!skill_hits_push(L, h)) { skill_hit_free_fields(&h); closedir(d); return 0; }
    }
    closedir(d);
    return 1;
}

/* embed_text for one skill (name + description + tags) → malloc'd. */
static char *skill_embed_text(const skill_hit *h) {
    size_t need = strlen(h->name) + strlen(h->desc) + strlen(h->tags) + 4;
    char *t = malloc(need);
    if (!t) return NULL;
    snprintf(t, need, "%s\n%s\n%s", h->name, h->desc, h->tags);
    return t;
}

/* Deterministic ordering (source, id) so the on-disk index rows line up with a
 * re-enumeration regardless of readdir() order. */
static int skill_hit_id_cmp(const void *a, const void *b) {
    const skill_hit *x = a, *y = b;
    int c = strcmp(x->source, y->source);
    return c ? c : strcmp(x->id, y->id);
}

/* Enumerate all skill sources (user + shipped + cyber) into L, sorted stably. */
static int skill_enum_all(skill_hit_list *L) {
    char dir[PATH_MAX], udir[1100];
    user_skills_dir(udir, sizeof udir);
    if (!skill_enum_dir(L, udir, "SKILL.md", "user")) return 0;
    if (g_web_dir[0]) {
        snprintf(dir, sizeof dir, "%s/extension/skills", g_web_dir);
        if (!skill_enum_dir(L, dir, "SKILL.md", "dstudio")) return 0;
    }
    if (cyber_skills_dir(dir, sizeof dir))
        if (!skill_enum_dir(L, dir, "SKILL.md", "anthropic-cybersecurity-skills")) return 0;
    if (L->n > 1) qsort(L->v, (size_t)L->n, sizeof *L->v, skill_hit_id_cmp);
    for (int i = 0; i < L->n; i++) L->v[i].order = i;
    return 1;
}

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
    c = jsonl_read_file(path, len);
    if (c) return c;
    char cyber[2300];
    if (cyber_skills_dir(cyber, sizeof cyber)) {
        snprintf(path, sizeof path, "%s/%s/SKILL.md", cyber, g_skill);
        c = jsonl_read_file(path, len);
        if (c) return c;
    }
    return NULL;
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

    /* On-demand pack tools. Do not dump the full shipped/cybersecurity catalog into
     * every Agent launch: local model startup pays that prefill cost even for a one-word prompt.
     * The UI and /api/skills/search expose the searchable catalog; the model can load
     * exact ids supplied by the user, by the selected-skill UI, or by GSA/RSA flows. */
    const size_t catcap = include_design_system ? 64 * 1024 : 8192;
    char *cat = malloc(catcap);
    if (cat) {
        size_t o = 0;
        char dir[2048], udir[1100];
        o += (size_t)snprintf(cat + o, catcap - o,
            "## On-demand packs\n\n"
            "Load any pack below at any time WITHOUT restarting, by calling these tools "
            "(DSML, exactly like your other tools). You may call multiple `skill` tools "
            "in one turn when each pack covers a different concern, but default to one "
            "and cap each user request at three `skill` calls total; never load the same "
            "skill twice:\n\n"
            "{\"type\":\"function\",\"function\":{\"name\":\"skill\",\"description\":\"Load a skill recipe (layout patterns + checklist) by id, then follow its checklist.\",\"parameters\":{\"type\":\"object\",\"properties\":{\"name\":{\"type\":\"string\"}},\"required\":[\"name\"]}}}\n"
            "{\"type\":\"function\",\"function\":{\"name\":\"design_system\",\"description\":\"Load a brand pack (color tokens, type, components, voice) by id, then bind its tokens.\",\"parameters\":{\"type\":\"object\",\"properties\":{\"name\":{\"type\":\"string\"}},\"required\":[\"name\"]}}}\n"
            "{\"type\":\"function\",\"function\":{\"name\":\"pack_file\",\"description\":\"Read an allowlisted pack file such as assets/template.html, references/checklist.md, references/layouts.md, or example.html after a pack lists available files.\",\"parameters\":{\"type\":\"object\",\"properties\":{\"type\":{\"type\":\"string\"},\"name\":{\"type\":\"string\"},\"path\":{\"type\":\"string\"}},\"required\":[\"type\",\"name\",\"path\"]}}}\n"
            "{\"type\":\"function\",\"function\":{\"name\":\"skills_search\",\"description\":\"Search the local skill catalog by topic (a few concise English keywords) and get matching skill ids with one-line descriptions, best first.\",\"parameters\":{\"type\":\"object\",\"properties\":{\"query\":{\"type\":\"string\"}},\"required\":[\"query\"]}}}\n");
        /* Vision: ds4 is text-only, but see_image runs a local vision model over
         * an image file in the workspace and returns a text description (with any
         * transcribed text). The dispatch exists only in the patched jsonl agent
         * and in the design agent — the STOCK agent (e.g. the GLM 5.2 checkout,
         * where the jsonl patch never applies) must not be told about a tool it
         * does not have, or every call ends in "unknown tool". */
        if (include_design_system || include_agent_question)
            o += (size_t)snprintf(cat + o, catcap - o,
                "\nVision: you cannot see pixels directly, but you can inspect an image file in the "
                "workspace by calling the `see_image` tool — a local vision model returns a text "
                "description plus any transcribed text. Use it before reasoning about a screenshot, "
                "photo, diagram, or scanned page; to zoom in, crop the region to a new file (e.g. via "
                "the bash tool) and call see_image on it.\n"
                "{\"type\":\"function\",\"function\":{\"name\":\"see_image\",\"description\":\"Look at a local image file (png/jpg/webp/gif) and get a text description plus any transcribed text.\",\"parameters\":{\"type\":\"object\",\"properties\":{\"path\":{\"type\":\"string\",\"description\":\"Path to the image file in the workspace.\"},\"question\":{\"type\":\"string\",\"description\":\"Optional: what to look for, or a question about the image.\"}},\"required\":[\"path\"]}}}\n");
        /* read_pdf dispatches only in the patched jsonl agent (edits 047/048):
         * neither the stock agent nor the design agent has it. */
        if (include_agent_question)
            o += (size_t)snprintf(cat + o, catcap - o,
                "\nPDF: to read a PDF file in the workspace call the `read_pdf` tool — pages with a "
                "text layer come back verbatim, scanned pages and large figures are read by the "
                "local vision model (slower). Results are cached, so re-reading the same file is "
                "instant.\n"
                "{\"type\":\"function\",\"function\":{\"name\":\"read_pdf\",\"description\":\"Read a local PDF file: verbatim text of digital pages plus a vision reading of scanned pages and large figures.\",\"parameters\":{\"type\":\"object\",\"properties\":{\"path\":{\"type\":\"string\",\"description\":\"Path to the PDF file in the workspace.\"}},\"required\":[\"path\"]}}}\n");
        if (!include_design_system && include_agent_question)
            o += (size_t)snprintf(cat + o, catcap - o,
                "{\"type\":\"function\",\"function\":{\"name\":\"question\",\"description\":\"Emit a structured question event for the UI. Use when you need the user to choose or clarify, then stop the turn.\",\"parameters\":{\"type\":\"object\",\"properties\":{\"id\":{\"type\":\"string\"},\"title\":{\"type\":\"string\"},\"questions\":{\"type\":\"string\",\"description\":\"JSON array of question objects, e.g. [{id,label,type,options}].\"}},\"required\":[\"id\",\"title\",\"questions\"]}}}\n");
        if (include_design_system)
            o += (size_t)snprintf(cat + o, catcap - o,
                "{\"type\":\"function\",\"function\":{\"name\":\"craft\",\"description\":\"Load a universal craft rules pack by id (accessibility before shipping; layout-responsive before any resize).\",\"parameters\":{\"type\":\"object\",\"properties\":{\"name\":{\"type\":\"string\"}},\"required\":[\"name\"]}}}\n");
        o += (size_t)snprintf(cat + o, catcap - o, "\n");
        if (include_design_system) {
            o += (size_t)snprintf(cat + o, catcap - o,
                "Use `skill(\"id\")`, `design_system(\"id\")` and `craft(\"id\")` when the user "
                "selects or names an exact id. The searchable skill and cybersecurity catalogs "
                "live in the DStudio UI, so they are not injected here.\n\n");
            snprintf(dir, sizeof dir, "%s/extension/design-systems", g_web_dir);
            catalog_append(cat, catcap, &o, dir, "DESIGN.md", "Available design systems");
            snprintf(dir, sizeof dir, "%s/extension/craft", g_web_dir);
            catalog_append(cat, catcap, &o, dir, "CRAFT.md", "Craft rules (universal)");
        } else {
            (void)udir;
            o += (size_t)snprintf(cat + o, catcap - o,
                "Use `skill(\"id\")` when the user selected/named an exact id or a "
                "DStudio workflow provides one. To DISCOVER ids by topic, call "
                "`skills_search(\"...\")` describing in your own words (any language is fine) "
                "what you need — the search is SEMANTIC, so a short natural description works "
                "better than bare keywords — then pick from its results. The full catalog is "
                "intentionally not injected into this prompt to keep Agent startup responsive. "
                "You may load multiple skills when they cover different concerns, but keep it "
                "bounded: default to one skill, cap each user request at three `skill` calls "
                "total, and never load the same skill twice. Never guess ids that neither the "
                "user nor skills_search gave you.\n\n");
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

static int patch_count_occurrences(const char *buf, const char *find) {
    if (!buf || !find || !find[0]) return 0;
    int cnt = 0;
    for (const char *q = strstr(buf, find); q; q = strstr(q + 1, find)) cnt++;
    return cnt;
}

static void patch_anchor_preview(const char *find, char *preview, size_t preview_len) {
    size_t k = 0;
    if (!preview || preview_len == 0) return;
    for (const char *s = find; s && *s && *s != '\n' && k + 1 < preview_len; s++)
        preview[k++] = *s;
    preview[k] = '\0';
}

static int patch_apply_edits(ds4ui_patch_set *patch, char **buf, size_t *n, const char *src_path) {
    for (int i = 0; i < patch->count; i++) {
        ds4ui_patch_edit *edit = &patch->edits[i];
        if (!jsonl_replace_once(buf, n, edit->find, edit->replace)) {
            int cnt = patch_count_occurrences(*buf, edit->find);
            return patch_fail("%s edit %s anchor %s in %s (%s)",
                              patch->name, edit->id,
                              cnt == 0 ? "missing" : (cnt > 1 ? "ambiguous" : "replace failed"),
                              src_path, edit->find_path);
        }
    }
    return 1;
}

/* Applies the anchored JSONL patch set; 0 on missing/ambiguous anchor. */
static int jsonl_apply(const char *src_path) {
    size_t n;
    char *buf = jsonl_read_file(src_path, &n);
    if (!buf) return patch_fail("cannot read source for patching: %s", src_path);
    jsonl_normalize_newlines(buf, &n);
    if (strstr(buf, JSONL_MARK)) {
        free(buf);
        return patch_fail("source already contains %s: %s", JSONL_MARK, src_path);
    }
    ds4ui_patch_set patch;
    if (!patch_load_set(JSONL_PATCH_DIR, &patch)) { free(buf); return 0; }
    int ok = patch_apply_edits(&patch, &buf, &n, src_path);
    patch_free_set(&patch);
    if (!ok) { free(buf); return 0; }
    if (!jsonl_insert_remote_agent_fragment(&buf, &n)) {
        free(buf);
        return 0;
    }
    ok = jsonl_write_file(src_path, buf, n);
    if (!ok) patch_fail("cannot write patched source: %s", src_path);
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
    ds4ui_patch_set patch;
    if (!patch_load_set(WEB_CDP_PATCH_DIR, &patch)) return 0;
    int ok = patch_apply_edits(&patch, buf, n, "ds4_web.c");
    patch_free_set(&patch);
    return ok;
}

static int web_direct_nav_apply(char **buf, size_t *n) {
    if (strstr(*buf, WEB_DIRECT_NAV_MARK) || web_direct_nav_source_has_fix(*buf))
        return 1;
    ds4ui_patch_set patch;
    if (!patch_load_set(WEB_DIRECT_NAV_PATCH_DIR, &patch)) return 0;
    int ok = patch_apply_edits(&patch, buf, n, "ds4_web.c");
    patch_free_set(&patch);
    return ok;
}

static int web_cdp_write_temp(const char *src_path, const char *tmp_path) {
    size_t n;
    char *buf = jsonl_read_file(src_path, &n);
    if (!buf) return patch_fail("cannot read source for web patching: %s", src_path);
    jsonl_normalize_newlines(buf, &n);
    int ok = web_cdp_apply(&buf, &n) &&
             web_direct_nav_apply(&buf, &n);
    if (ok && !jsonl_write_file(tmp_path, buf, n))
        ok = patch_fail("cannot write patched web helper: %s", tmp_path);
    free(buf);
    return ok;
}

static void jsonl_unlink_if_exists(const char *path) {
    if (path && path[0]) unlink(path);
}

static char *jsonl_read_remote_agent_fragment(size_t *len) {
    ds4ui_patch_set patch;
    if (!patch_load_set(JSONL_PATCH_DIR, &patch)) return NULL;
    if (!patch.fragment_path[0]) {
        patch_free_set(&patch);
        patch_fail("%s manifest is missing fragment=", JSONL_PATCH_DIR);
        return NULL;
    }
    char path[DSTUDIO_PATH_MAX + 512];
    cstr_copy(path, sizeof path, patch.fragment_path);
    patch_free_set(&patch);
    return patch_read_text(path, len);
}

static int jsonl_insert_remote_agent_fragment(char **buf, size_t *n) {
    static const char anchor[] =
        "static int run_agent_non_interactive(ds4_engine *engine, agent_config *cfg) {\n";
    if (strstr(*buf, "/*DS4UI_REMOTE_AGENT*/"))
        return patch_fail("remote agent fragment marker already present in source");
    size_t frag_len = 0;
    char *frag = jsonl_read_remote_agent_fragment(&frag_len);
    if (!frag) return 0;
    jsonl_normalize_newlines(frag, &frag_len);
    size_t repl_len = frag_len + strlen(anchor) + 2;
    char *repl = malloc(repl_len);
    if (!repl) { free(frag); return patch_fail("out of memory inserting remote agent fragment"); }
    int k = snprintf(repl, repl_len, "%s\n%s", frag, anchor);
    free(frag);
    if (k < 0 || (size_t)k >= repl_len) {
        free(repl);
        return patch_fail("remote agent fragment expansion overflow");
    }
    int ok = jsonl_replace_once(buf, n, anchor, repl);
    free(repl);
    if (!ok)
        return patch_fail("remote agent fragment anchor missing or ambiguous: run_agent_non_interactive");
    return ok;
}

static int patch_check_anchors(ds4ui_patch_set *patch, char **buf, size_t *n, const char *label) {
    int fails = 0;
    for (int i = 0; i < patch->count; i++) {
        ds4ui_patch_edit *edit = &patch->edits[i];
        int cnt = patch_count_occurrences(*buf, edit->find);
        const char *verdict = cnt == 1 ? "ok" : (cnt == 0 ? "MISSING" : "AMBIGUOUS");
        if (cnt != 1) fails++;
        char preview[56];
        patch_anchor_preview(edit->find, preview, sizeof preview);
        printf("  %s anchor %2d/%d  %-9s  %s%s  [%s]\n", label, i + 1, patch->count,
               verdict, preview, strlen(preview) < strlen(edit->find) ? " ..." : "", edit->id);
        if (cnt == 1 && !jsonl_replace_once(buf, n, edit->find, edit->replace)) fails++;
    }
    return fails;
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
        ds4ui_patch_set patch;
        if (!patch_load_set(WEB_CDP_PATCH_DIR, &patch)) { free(buf); return -1; }
        fails += patch_check_anchors(&patch, &buf, &n, "web");
        patch_free_set(&patch);
    }

    if (strstr(buf, WEB_DIRECT_NAV_MARK) || web_direct_nav_source_has_fix(buf)) {
        printf("check-anchors: web direct navigation already present\n");
    } else {
        ds4ui_patch_set patch;
        if (!patch_load_set(WEB_DIRECT_NAV_PATCH_DIR, &patch)) { free(buf); return -1; }
        fails += patch_check_anchors(&patch, &buf, &n, "web nav");
        patch_free_set(&patch);
    }
    free(buf);
    printf("check-anchors: web direct navigation %s\n", fails ? "would fail" : "ok");
    return fails;
}

/* Dry-run for CI: verify every JSONL anchor is present exactly once in src_path
 * WITHOUT modifying it. Prints a per-anchor report; returns the number of
 * anchors that would fail to apply (0 = the patch applies cleanly). */
static int jsonl_check_anchors(const char *src_path) {
    size_t n;
    char *buf = jsonl_read_file(src_path, &n);
    if (!buf) { printf("check-anchors: cannot read %s\n", src_path); return -1; }
    jsonl_normalize_newlines(buf, &n);
    if (strstr(buf, JSONL_MARK))
        printf("check-anchors: NOTE source already contains %s (already patched?)\n", JSONL_MARK);
    ds4ui_patch_set patch;
    if (!patch_load_set(JSONL_PATCH_DIR, &patch)) { free(buf); return -1; }
    int total = patch.count + 1;
    int fails = patch_check_anchors(&patch, &buf, &n, "jsonl");
    patch_free_set(&patch);
    if (jsonl_insert_remote_agent_fragment(&buf, &n)) {
        printf("  remote fragment     ok         %s/remote-agent.cfrag\n", JSONL_PATCH_DIR);
    } else {
        printf("  remote fragment     MISSING    %s/remote-agent.cfrag or run_agent_non_interactive anchor\n",
               JSONL_PATCH_DIR);
        fails++;
    }
    free(buf);
    printf("check-anchors: %d/%d ok, %d would fail\n",
           total - fails, total, fails);
    return fails;
}

/* `make -f - <target>` in the ds4 dir, with the external build.mk on stdin. */
static int jsonl_make(const char *ds4_abs, const char *target) {
#ifdef _WIN32
    (void)ds4_abs; (void)target;
    return 0;
#else
    size_t makefile_len = 0;
    char *makefile = jsonl_read_patch_makefile(&makefile_len);
    if (!makefile) return 0;
    int pp[2];
    if (pipe(pp) != 0) { free(makefile); return patch_fail("pipe failed for jsonl make: %s", strerror(errno)); }
    pid_t pid = fork();
    if (pid < 0) { close(pp[0]); close(pp[1]); free(makefile); return patch_fail("fork failed for jsonl make: %s", strerror(errno)); }
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
    size_t off = 0;
    while (off < makefile_len) {
        ssize_t w = write(pp[1], makefile + off, makefile_len - off);
        if (w <= 0) break;
        off += (size_t)w;
    }
    free(makefile);
    close(pp[1]);
    int st;
    if (waitpid(pid, &st, 0) != pid) return patch_fail("waitpid failed for jsonl make: %s", strerror(errno));
    if (!(WIFEXITED(st) && WEXITSTATUS(st) == 0))
        return patch_fail("jsonl make target failed: %s", target);
    return 1;
#endif
}

static int jsonl_sentinel_ok(const char *path, int want_version) {
    if (want_version <= 0) return 0;
    size_t n;
    char *b = jsonl_read_file(path, &n);
    if (!b) return 0;
    int v = atoi(b);
    free(b);
    return v == want_version;
}

static int default_ds4_dir(char *out, size_t outsz) {
    if (!outsz) return 0;
    if (g_web_dir[0]) {
        int n = snprintf(out, outsz, "%s/ds4", g_web_dir);
        return n >= 0 && (size_t)n < outsz;
    }
#ifdef _WIN32
    char appdir[DSTUDIO_PATH_MAX];
    if (win_app_dir(appdir, sizeof appdir)) {
        int n = snprintf(out, outsz, "%s\\ds4", appdir);
        return n >= 0 && (size_t)n < outsz;
    }
#endif
    char abs[DSTUDIO_PATH_MAX];
    if (realpath("ds4", abs)) {
        cstr_copy(out, outsz, abs);
        return 1;
    }
    cstr_copy(out, outsz, "ds4");
    return 1;
}

/* Resolves g_ds4_dir when it is RELATIVE and the cwd does not contain it (launch
 * from Finder/bundle: cwd = "/"). Default installs live in this DStudio checkout
 * as ./ds4, so a missing checkout still resolves to that concrete target path. */
static void resolve_ds4_dir(void) {
    char abs[DSTUDIO_PATH_MAX];
    if (realpath(g_ds4_dir, abs) && access(abs, R_OK) == 0) {
        cstr_copy(g_ds4_dir, sizeof g_ds4_dir, abs);
        return;
    }
    if (g_ds4_dir_explicit) {
        fprintf(stderr, "DStudio: explicit ds4 directory not found (%s)\n", g_ds4_dir);
        return;
    }
    if (!g_ds4_dir_explicit && g_web_dir[0]) {
        char cand[DSTUDIO_PATH_MAX];
        if (default_ds4_dir(cand, sizeof cand)) {
            if (realpath(cand, abs) && access(abs, R_OK) == 0) {
                cstr_copy(g_ds4_dir, sizeof g_ds4_dir, abs);
                return;
            }
            cstr_copy(g_ds4_dir, sizeof g_ds4_dir, cand);
            return;
        }
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

/* "build" | "restore". 1 = ok. Applies the external JSONL patch set (jsonl events
 * + slash command/autosave sessions of the non-interactive loop).
 * All in C: backup .bak, patch, make, restore.
 * Replaces the former extension/jsonl/build-jsonl.sh + inject.py script. */
static int run_build_jsonl(const char *action) {
#ifdef _WIN32
    (void)action;
    win_prepare_engine_runtime();
    char ver[DSTUDIO_PATH_MAX + 64];
    snprintf(ver, sizeof ver, "%s/ds4-agent-jsonl.ver", g_ds4_dir);
    int patch_version = jsonl_patch_version();
    return patch_version > 0 && file_present("ds4-agent-jsonl.exe") && jsonl_sentinel_ok(ver, patch_version);
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

    int patch_version = jsonl_patch_version();
    if (patch_version <= 0) return 0;

    /* idempotence: skip if the binary is newer than the source and the external patch
     * version matches. */
    struct stat sb, wb, bb;
    if (access(bin, X_OK) == 0 &&
        stat(src, &sb) == 0 && stat(web_src, &wb) == 0 && stat(bin, &bb) == 0 &&
        bb.st_mtime >= sb.st_mtime && bb.st_mtime >= wb.st_mtime &&
        !patch_dir_newer_than(JSONL_PATCH_DIR, bb.st_mtime) &&
        !patch_dir_newer_than(WEB_CDP_PATCH_DIR, bb.st_mtime) &&
        !patch_dir_newer_than(WEB_DIRECT_NAV_PATCH_DIR, bb.st_mtime) &&
        jsonl_sentinel_ok(ver, patch_version)) {
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
        int vn = snprintf(vs, sizeof vs, "%d\n", patch_version);
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
#ifdef _WIN32
        snprintf(err, errsz,
                 "remote agent requires the updated DStudio Windows runtime "
                 "(ds4-agent-jsonl.exe + ds4-agent-jsonl.ver)");
#else
        snprintf(err, errsz, "remote agent requires the structured ds4-agent-jsonl build%s%s",
                 g_engine_err[0] ? ": " : "", g_engine_err[0] ? g_engine_err : "");
#endif
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
    if (!cfg_ssd_streaming(cfg, remote_model, err, errsz)) return 0;
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
    if (use_jsonl) {
        /* Normal agent: keep Claude-like discovery for direction-sensitive
         * work without slowing down straightforward code edits.  This is injected via
         * -sys only; antirez's ds4_agent.c stays untouched. */
        static const char *normal_agent_discovery =
            "\n\n## NORMAL AGENT DISCOVERY\n"
            "Default to action, but ask before committing to a direction when the missing "
            "choice would materially change the result.\n"
            "Ask a compact clarification first, then stop, when the user asks for a NEW "
            "app/site/UI/product flow/brand-facing page and two or more of these are missing "
            "from the prompt and repository context: target user, primary workflow, required "
            "technical stack, page/screen list, visual direction/brand/reference, must-have "
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
        static const char *normal_agent_web_research =
            "\n\n## AGENT WEB RESEARCH\n"
            "You have read-only browser-backed web tools named `google_search` and `visit_page`; "
            "they use the same local DStudio Search/Deep Research browser helper.\n"
            "Use `google_search` when the user explicitly asks you to search, look up, verify, "
            "check the latest/current information, or when you are uncertain and the answer "
            "depends on current external facts, public docs, package/API behavior, prices, "
            "versions, advisories, news, or public web evidence.\n"
            "After searching, use `visit_page` on the most relevant primary sources before "
            "relying on them. Prefer official docs, upstream repositories, standards, release "
            "notes, advisories, and vendor pages over search snippets.\n"
            "Do not use web tools for facts already available in the workspace or for private "
            "local files. Keep searches bounded and cite URLs when web evidence materially "
            "supports or changes the answer.\n"
            "If web tools fail, say that clearly; do not invent current facts.\n";
        const char *normal_agent_rules[] = {
            normal_agent_discovery,
            normal_agent_web_research
        };
        for (size_t i = 0; i < sizeof normal_agent_rules / sizeof normal_agent_rules[0]; i++) {
            size_t cur = skill_sys ? strlen(skill_sys) : 0, dl = strlen(normal_agent_rules[i]);
            char *nb = realloc(skill_sys, cur + dl + 1);
            if (!nb) break;
            skill_sys = nb;
            memcpy(skill_sys + cur, normal_agent_rules[i], dl + 1);
        }
    }

#ifdef _WIN32
    char exe[2200];
    win_join_path(exe, sizeof exe, g_ds4_dir, agent_bin);
    win_prepare_engine_runtime();
    child_setenv_skills();
    char *think_flag = cfg->think == 0 ? "--nothink"
                     : cfg->think == 2 ? "--think-max"
                     : "--think";
    char *argv[30]; int n = 0;
    argv[n++] = exe;
    argv[n++] = "--non-interactive";
    if (use_jsonl) argv[n++] = "--jsonl";
    if (remote_model) {
        argv[n++] = "--remote-base-url"; argv[n++] = g_remote_base_url;
        argv[n++] = "--remote-model"; argv[n++] = g_remote_model[0] ? g_remote_model : "ds4";
    } else {
        argv[n++] = "--cpu";
        if (g_ssd_streaming_effective) argv[n++] = "--ssd-streaming";
        argv[n++] = "-m"; argv[n++] = model_abs;
    }
    argv[n++] = "-c"; argv[n++] = ctxs;
    if (!model_is_glm()) { argv[n++] = "--power"; argv[n++] = pows; }
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
        char *argv[30]; int n = 0;
        argv[n++] = binpath;
        argv[n++] = "--non-interactive";
        if (use_jsonl) argv[n++] = "--jsonl";
        if (remote_model) {
            argv[n++] = "--remote-base-url"; argv[n++] = g_remote_base_url;
            argv[n++] = "--remote-model"; argv[n++] = g_remote_model[0] ? g_remote_model : "ds4";
        } else {
            argv[n++] = "--metal";
            if (g_ssd_streaming_effective) argv[n++] = "--ssd-streaming";
            argv[n++] = "-m"; argv[n++] = model_abs;
        }
        argv[n++] = "-c"; argv[n++] = ctxs;
        if (!model_is_glm()) { argv[n++] = "--power"; argv[n++] = pows; }
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
    win_prepare_engine_runtime();
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
    if (!cfg_ssd_streaming(cfg, remote_model, err, errsz)) return 0;
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
    child_setenv_skills();
    char *think_flag = cfg->think == 0 ? "--nothink"
                     : cfg->think == 2 ? "--think-max"
                     : "--think";
    char *argv[28]; int n = 0;
    argv[n++] = exe;
    argv[n++] = "--jsonl";
    if (remote_model) {
        argv[n++] = "--remote-base-url"; argv[n++] = g_remote_base_url;
        argv[n++] = "--remote-model"; argv[n++] = g_remote_model[0] ? g_remote_model : "ds4";
    } else {
        argv[n++] = "--cpu";
        if (g_ssd_streaming_effective) argv[n++] = "--ssd-streaming";
        argv[n++] = "-m"; argv[n++] = (char *)current_model_rel();
    }
    argv[n++] = "-c"; argv[n++] = ctxs;
    if (!model_is_glm()) { argv[n++] = "--power"; argv[n++] = pows; }
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
        char *argv[28]; int n = 0;
        argv[n++] = "./ds4-design";
        argv[n++] = "--jsonl";
        if (remote_model) {
            argv[n++] = "--remote-base-url"; argv[n++] = g_remote_base_url;
            argv[n++] = "--remote-model"; argv[n++] = g_remote_model[0] ? g_remote_model : "ds4";
        } else {
            argv[n++] = "--metal";
            if (g_ssd_streaming_effective) argv[n++] = "--ssd-streaming";
            argv[n++] = "-m"; argv[n++] = (char *)current_model_rel();
        }
        argv[n++] = "-c"; argv[n++] = ctxs;
        if (!model_is_glm()) { argv[n++] = "--power"; argv[n++] = pows; }
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
                drain_child_stdout_data(buf, (size_t)n);
            } else if (n == 0) { drain_child_event_finish(); break; }
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
    unsigned long long task_id = task_begin("model-download", "Download model",
                                            abliterated ? "flash" : target, ENGINE_NONE,
                                            g_ds4_dir, 0, 0);
    if (g_dl_pid > 0) {
        task_mark_failed(task_id, "a download is already running", g_dl_variant);
        char out[128];
        snprintf(out, sizeof out, "{\"ok\":false,\"taskId\":%llu,\"error\":\"a download is already running\"}", task_id);
        send_json(fd, "409 Conflict", out);
        return;
    }
    char ds4_abs[DSTUDIO_PATH_MAX];
    if (!realpath(g_ds4_dir, ds4_abs)) {
        task_mark_failed(task_id, "ds4 dir not found", g_ds4_dir);
        char out[128];
        snprintf(out, sizeof out, "{\"ok\":false,\"taskId\":%llu,\"error\":\"ds4 dir not found\"}", task_id);
        send_json(fd, "500 Internal Server Error", out);
        return;
    }
    pid_t pid = fork();
    if (pid < 0) {
        task_mark_failed(task_id, "fork failed", strerror(errno));
        char out[160];
        snprintf(out, sizeof out, "{\"ok\":false,\"taskId\":%llu,\"error\":\"fork failed\"}", task_id);
        send_json(fd, "500 Internal Server Error", out);
        return;
    }
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
    g_active_download_task = task_id;
    dstudio_task *t = task_find(task_id);
    if (t) t->pid = (int)pid;
    task_mark_working(task_id, "model download started");
    cstr_copy(g_dl_variant, sizeof g_dl_variant, abliterated ? "flash" : target);
    printf("model: downloading %s (pid %d) — log /tmp/ds4-model-dl.log\n", abliterated ? "abliterated" : target, (int)pid);
    char out[128];
    snprintf(out, sizeof out, "{\"ok\":true,\"taskId\":%llu,\"target\":\"%s\"}", task_id, abliterated ? "flash" : target);
    send_json(fd, "200 OK", out);
#endif
}

static void api_status(int fd) {
    reap_child();
    char stage_esc[192];
    json_escape_into(stage_esc, sizeof stage_esc, g_stage, strlen(g_stage));
    char wd_esc[1100];
    json_escape_into(wd_esc, sizeof wd_esc, g_workdir, strlen(g_workdir));

    char ssd_reason_esc[420];
    json_escape_into(ssd_reason_esc, sizeof ssd_reason_esc,
                     g_ssd_streaming_reason, strlen(g_ssd_streaming_reason));
    char cfg[640];
    if (g_child > 0)
        snprintf(cfg, sizeof cfg,
                 "{\"model\":\"%s\",\"port\":%d,\"ctx\":%d,\"power\":%d,\"think\":\"%s\","
                 "\"ssdStreaming\":\"%s\",\"ssdStreamingEffective\":%s,\"ssdStreamingReason\":\"%s\"}",
                 g_cfg.uncensored ? "uncensored" : "standard", g_cfg.port, g_cfg.ctx, g_cfg.power,
                 g_cfg.think == 0 ? "off" : g_cfg.think == 2 ? "max" : "high",
                 g_cfg.ssd_streaming == SSD_STREAMING_ON ? "on" : g_cfg.ssd_streaming == SSD_STREAMING_OFF ? "off" : "auto",
                 g_ssd_streaming_effective ? "true" : "false", ssd_reason_esc);
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
        "\"engineError\":\"%s\",\"engineLine\":\"%s\",\"modelFile\":\"%s\",\"skill\":\"%s\",\"designSystem\":\"%s\","
        "\"contentOk\":%s,\"contentDownloading\":%s}",
        mode_name(g_mode), g_child > 0 ? "true" : "false", g_ready ? "true" : "false",
        g_load_pct, stage_esc, g_agent_working ? "true" : "false", wd_esc, cfg,
        g_jsonl_active ? "true" : "false",
        d4_esc, ds4_dir_valid() ? "true" : "false", web_esc, web_dir_valid() ? "true" : "false",
        lan_on ? "true" : "false", lan_addr, g_http_port,
        model_present(0) ? "true" : "false", model_present(1) ? "true" : "false",
        file_present(MODEL_FLASH) ? "true" : "false", file_present(MODEL_PRO) ? "true" : "false",
        g_variant, g_dl_variant[0] ? "true" : "false", g_dl_variant, dl_pct, err_esc, line_esc, mf_esc, g_skill, g_design_system,
        content_present() ? "true" : "false", g_content_dl_pid > 0 ? "true" : "false");
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

/* GLM checkout helpers (defined next to /api/glm/setup below). */
static int glm_dir_path(char *out, size_t outsz);
static int glm_checkout_ready(const char *dir);
/* Vision sidecar doctor row (defined next to the vision handlers below). */
static int vision_doctor_row(char *msg, size_t msgsz);
/* Generic sidecar helpers reused by the embedding sidecar (defined with the
 * vision provider below); safe to share — they take dir/pid arguments. */
static int  vision_pid_is_llama(pid_t pid);
static int  vision_scan_for_bin(const char *dir, int depth, char *out, size_t outsz);
static long long vision_tree_bytes(const char *dir, int depth);
static void vision_model_cache_path(char *out, size_t outsz);
static int pdf_find_tool(const char *name, char *out, size_t outsz);
static const char *pdf_poppler_hint(void);
static char *web_curl_capture(char *const argv[], int timeout_ms, int *exit_status);
static long long web_now_ms(void);
static void web_json_error(int fd, const char *status, const char *msg);
/* Embedding sidecar doctor row + setup (defined with the embedding provider). */
static int embed_doctor_row(char *msg, size_t msgsz);

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

/* GET /api/doctor — cheap first-run/preflight checks. It reports what is ready
 * and gives the UI action codes; the managed download/build happens only when the
 * user clicks the explicit setup action. */
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
    if (ds4_ok) snprintf(ds4_msg, sizeof ds4_msg, "Using %s", g_ds4_dir);
    else snprintf(ds4_msg, sizeof ds4_msg, "Install ds4 into %s.", g_ds4_dir);

    json_dyn_buf b = {0};
    int first = 1, fatal = 0, warn = 0, ok = 1;
    ok = ok && json_dyn_puts(&b, "{\"ok\":true,\"checks\":[");

    if (!ds4_ok) fatal++;
    ok = ok && doctor_add_check(&b, &first, "ds4", "Engine folder",
        ds4_ok ? "ok" : "error", ds4_msg, ds4_ok ? NULL : "setup-ds4");

    int content_ok = content_present();
    int content_dl = g_content_dl_pid > 0;
    if (!content_ok && !content_dl) warn++;
    ok = ok && doctor_add_check(&b, &first, "content", "Skills & design systems",
        content_ok ? "ok" : (content_dl ? "warn" : "warn"),
        content_ok ? "Skill packs and design systems are installed."
                   : (content_dl ? "Downloading skill packs and design systems…"
                                  : "Download the skill packs and design systems."),
        (content_ok || content_dl) ? NULL : "setup-content");

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

#ifndef _WIN32
    /* Optional GLM 5.2 engine (a second ds4 checkout on the glm5.2 branch).
     * Never fatal: when absent the row just offers an Install action for those
     * who want to run GLM GGUFs; present-but-broken is a warning. */
    char glm_dir[DSTUDIO_PATH_MAX];
    int glm_have_path = glm_dir_path(glm_dir, sizeof glm_dir);
    int glm_present = glm_have_path && ds4_dir_valid_path(glm_dir);
    int glm_ready = glm_present && glm_checkout_ready(glm_dir);
    if (glm_present && !glm_ready) warn++;
    ok = ok && doctor_add_check(&b, &first, "glm", "GLM engine (optional)",
        glm_present && !glm_ready ? "warn" : "ok",
        glm_ready ? "GLM 5.2 engine installed — pick the glm5.2 branch from the model menu." :
        glm_present ? "GLM checkout found but not patched/built — reinstall it." :
                      "Not installed. Optional: adds GLM 5.2 model support (ds4 glm5.2 branch).",
        glm_ready ? NULL : "setup-glm");

    /* Vision sidecar (optional): local image understanding for chat + agent. */
    {
        char vmsg[420];
        int vinst = vision_doctor_row(vmsg, sizeof vmsg);
        ok = ok && doctor_add_check(&b, &first, "vision", "Vision (optional)", "ok", vmsg,
                                    vinst ? NULL : "open-settings");
    }
    /* Embedding sidecar (optional): semantic skill routing for the Agent. */
    {
        char emsg[420];
        int einst = embed_doctor_row(emsg, sizeof emsg);
        ok = ok && doctor_add_check(&b, &first, "embed", "Semantic skill search (optional)", "ok", emsg,
                                    einst ? NULL : "open-settings");
    }
    /* PDF reading (optional): needs poppler for the text layer + page render. */
    {
        char ptool[256];
        int phave = pdf_find_tool("pdftoppm", ptool, sizeof ptool) &&
                    pdf_find_tool("pdftotext", ptool, sizeof ptool);
        ok = ok && doctor_add_check(&b, &first, "pdf", "PDF reading (optional)",
            phave ? "ok" : "warn",
            phave ? "poppler found — PDF attachments and the agent's read_pdf tool are available "
                    "(text pages are instant; scanned pages use the vision model)."
                  : pdf_poppler_hint(),
            NULL);
        if (!phave) warn++;
    }
#endif

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

/* ---- Engine checkout (ds4 git branch) picker ----
 * DStudio can sit next to several ds4 checkouts (e.g. ./ds4 on main and a
 * ./ds4-glm52 worktree on glm5.2). These endpoints let the UI list them and
 * swap the active one at runtime. The swap is process-local and deliberately
 * NOT persisted: the next DStudio launch resolves ./ds4 again. */

/* Best-effort current git branch of a checkout. Handles both a regular clone
 * (.git is a directory) and a linked worktree (.git is a "gitdir: ..." pointer
 * file). Leaves out empty when it cannot be determined. */
static void git_branch_of(const char *dir, char *out, size_t outsz) {
    if (!outsz) return;
    out[0] = '\0';
    char gitpath[DSTUDIO_PATH_MAX + 8];
    snprintf(gitpath, sizeof gitpath, "%s/.git", dir);
    struct stat st;
    if (stat(gitpath, &st) != 0) return;
    char headpath[DSTUDIO_PATH_MAX * 2 + 16];
    if (S_ISREG(st.st_mode)) {                 /* worktree: .git is a pointer file */
        size_t n = 0;
        char *ptr = jsonl_read_file(gitpath, &n);
        if (!ptr) return;
        char target[DSTUDIO_PATH_MAX] = "";
        if (!strncmp(ptr, "gitdir:", 7)) {
            const char *p = ptr + 7;
            while (*p == ' ') p++;
            size_t l = strcspn(p, "\r\n");
            if (l > 0 && l < sizeof target) { memcpy(target, p, l); target[l] = '\0'; }
        }
        free(ptr);
        if (!target[0]) return;
        if (target[0] == '/')
            snprintf(headpath, sizeof headpath, "%s/HEAD", target);
        else
            snprintf(headpath, sizeof headpath, "%s/%s/HEAD", dir, target);
    } else {
        snprintf(headpath, sizeof headpath, "%s/.git/HEAD", dir);
    }
    size_t n = 0;
    char *head = jsonl_read_file(headpath, &n);
    if (!head) return;
    const char *p = head;
    if (!strncmp(p, "ref: refs/heads/", 16)) p += 16;
    size_t l = strcspn(p, "\r\n");
    if (p == head && l > 12) l = 12;           /* detached HEAD: short hash */
    if (l >= outsz) l = outsz - 1;
    memcpy(out, p, l);
    out[l] = '\0';
    free(head);
}

/* GET /api/engine/checkouts — the active ds4 dir plus every ds4* sibling under
 * the DStudio dir and next to the active one, with git branch and whether the
 * server binary is built. */
static void api_engine_checkouts(int fd) {
    char active[DSTUDIO_PATH_MAX];
    if (!realpath(g_ds4_dir, active)) cstr_copy(active, sizeof active, g_ds4_dir);

    static char dirs[16][DSTUDIO_PATH_MAX];
    int ndirs = 0;

    char parent[DSTUDIO_PATH_MAX];
    cstr_copy(parent, sizeof parent, active);
    char *slash = strrchr(parent, '/');
    if (slash && slash != parent) *slash = '\0'; else cstr_copy(parent, sizeof parent, "/");
    const char *bases[2] = { g_web_dir[0] ? g_web_dir : NULL, parent };

    for (int bi = 0; bi < 2; bi++) {
        if (!bases[bi] || !bases[bi][0]) continue;
        DIR *d = opendir(bases[bi]);
        if (!d) continue;
        struct dirent *de;
        while ((de = readdir(d)) != NULL && ndirs < 16) {
            if (strncmp(de->d_name, "ds4", 3)) continue;
            char full[DSTUDIO_PATH_MAX + 300], abs[DSTUDIO_PATH_MAX];
            snprintf(full, sizeof full, "%s/%s", bases[bi], de->d_name);
            struct stat st;
            if (stat(full, &st) != 0 || !S_ISDIR(st.st_mode)) continue;
            if (!ds4_dir_valid_path(full)) continue;
            if (!realpath(full, abs)) continue;
            int dup = 0;
            for (int i = 0; i < ndirs && !dup; i++) dup = !strcmp(dirs[i], abs);
            if (!dup) cstr_copy(dirs[ndirs++], sizeof dirs[0], abs);
        }
        closedir(d);
    }
    int have_active = 0;
    for (int i = 0; i < ndirs && !have_active; i++) have_active = !strcmp(dirs[i], active);
    if (!have_active && ndirs < 16 && ds4_dir_valid_path(active))
        cstr_copy(dirs[ndirs++], sizeof dirs[0], active);

    json_dyn_buf b = {0};
    int ok = json_dyn_puts(&b, "{\"ok\":true,\"active\":") &&
             json_dyn_put_escaped(&b, active) &&
             json_dyn_puts(&b, ",\"checkouts\":[");
    for (int i = 0; i < ndirs && ok; i++) {
        const char *name = strrchr(dirs[i], '/');
        name = name ? name + 1 : dirs[i];
        char branch[128];
        git_branch_of(dirs[i], branch, sizeof branch);
        /* Archive-based checkouts have no .git; label the managed GLM one. */
        if (!branch[0] && !strcmp(name, DS4_GLM_DIR_NAME))
            cstr_copy(branch, sizeof branch, "glm5.2");
        int has_server = file_present_in_dir(dirs[i], "ds4-server") ||
                         file_present_in_dir(dirs[i], "ds4-server.exe");
        ok = ok && json_dyn_puts(&b, i ? ",{\"dir\":" : "{\"dir\":") &&
             json_dyn_put_escaped(&b, dirs[i]) &&
             json_dyn_puts(&b, ",\"name\":") && json_dyn_put_escaped(&b, name) &&
             json_dyn_puts(&b, ",\"branch\":") && json_dyn_put_escaped(&b, branch) &&
             json_dyn_printf(&b, ",\"hasServer\":%s,\"active\":%s}",
                             has_server ? "true" : "false",
                             !strcmp(dirs[i], active) ? "true" : "false");
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

/* POST /api/engine/checkout {dir} — swap the active ds4 checkout. The dir must
 * exist and look like a ds4 checkout; the engine (if running) keeps serving
 * from the old one until the UI restarts it via /api/start. */
static void api_engine_checkout_set(int fd, const char *body) {
    char dir[DSTUDIO_PATH_MAX];
    if (!json_get_string(body, "dir", dir, sizeof dir) || !dir[0]) {
        send_json(fd, "400 Bad Request", "{\"ok\":false,\"error\":\"missing dir\"}");
        return;
    }
    char abs[DSTUDIO_PATH_MAX];
    if (!realpath(dir, abs) || !ds4_dir_valid_path(abs)) {
        send_json(fd, "400 Bad Request", "{\"ok\":false,\"error\":\"not a ds4 checkout\"}");
        return;
    }
    char branch[128];
    git_branch_of(abs, branch, sizeof branch);
    int changed = strcmp(abs, g_ds4_dir) != 0;
    if (changed) {
        cstr_copy(g_ds4_dir, sizeof g_ds4_dir, abs);
        g_ds4_dir_explicit = 1;      /* survives resolve_ds4_dir() re-runs */
        g_model_override[0] = '\0';  /* the old checkout's explicit GGUF may not exist here */
        printf("engine: checkout switched to %s (branch %s)\n", abs, branch[0] ? branch : "?");
    }
    json_dyn_buf b = {0};
    int ok = json_dyn_puts(&b, "{\"ok\":true,\"dir\":") &&
             json_dyn_put_escaped(&b, abs) &&
             json_dyn_puts(&b, ",\"branch\":") && json_dyn_put_escaped(&b, branch) &&
             json_dyn_printf(&b, ",\"changed\":%s}", changed ? "true" : "false");
    if (!ok) {
        free(b.ptr);
        send_json(fd, "500 Internal Server Error", "{\"ok\":false,\"error\":\"out of memory\"}");
        return;
    }
    send_json(fd, "200 OK", b.ptr);
    free(b.ptr);
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
                char assets[2300], refs[2300], example[2300], components[2300];
                snprintf(assets, sizeof assets, "%s/%s/assets", dir, id);
                snprintf(refs, sizeof refs, "%s/%s/references", dir, id);
                snprintf(example, sizeof example, "%s/%s/example.html", dir, id);
                snprintf(components, sizeof components, "%s/%s/components.html", dir, id);
                int has_assets = access(assets, R_OK) == 0;
                int has_refs = access(refs, R_OK) == 0;
                int has_example = access(example, R_OK) == 0;
                int has_components = access(components, R_OK) == 0;

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
                                      ",\"hasAssets\":%s,\"hasReferences\":%s,\"hasExample\":%s,\"hasComponents\":%s}",
                                      has_assets ? "true" : "false",
                                      has_refs ? "true" : "false",
                                      has_example ? "true" : "false",
                                      has_components ? "true" : "false"))
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

/* ============================================================================
 * Embedding provider (local llama.cpp sidecar) + SEMANTIC skill search.
 *
 * A SECOND llama-server in embedding mode (EMBED_PORT) embeds skill texts and
 * each query; /api/skills/search ranks by cosine. Same install/spawn/idle
 * pattern as the vision sidecar (helpers below mirror the vision_* ones; a few
 * dir/pid-generic vision helpers are reused). Skill search is SEMANTIC ONLY —
 * no lexical fallback by design: if the sidecar/index is not ready the search
 * returns 503 and the agent proceeds without a skill.
 * ==========================================================================*/
#define EMBED_PORT 28101
#define EMBED_HF_DEFAULT "Qwen/Qwen3-Embedding-0.6B-GGUF:Q8_0"
#define EMBED_MAX_DIM 4096
/* Qwen3-Embedding retrieval works best with an instruction on the QUERY side;
 * documents (skill texts) are embedded verbatim. */
#define EMBED_QUERY_INSTRUCT \
    "Instruct: Given a user request, retrieve the skill that best helps.\nQuery: "

#ifndef _WIN32
static void embed_dir_path(char *out, size_t outsz) {
    const char *env = getenv("DSTUDIO_EMBED_DIR");
    if (env && env[0]) { cstr_copy(out, outsz, env); return; }
    const char *home = getenv("HOME");
    snprintf(out, outsz, "%s/.dstudio/llama-embed", home ? home : ".");
}
static void embed_touch_last_use(void) {
    char dir[DSTUDIO_PATH_MAX]; embed_dir_path(dir, sizeof dir);
    const char *home = getenv("HOME");
    char parent[DSTUDIO_PATH_MAX];
    snprintf(parent, sizeof parent, "%s/.dstudio", home ? home : ".");
    (void)mkdir(parent, 0755); (void)mkdir(dir, 0755);
    char stamp[DSTUDIO_PATH_MAX + 16];
    snprintf(stamp, sizeof stamp, "%s/.last-use", dir);
    int f = open(stamp, O_WRONLY | O_CREAT, 0644);
    if (f >= 0) close(f);
    (void)utimes(stamp, NULL);
}
static pid_t embed_lock_pid(void) {
    char p[DSTUDIO_PATH_MAX + 16]; embed_dir_path(p, sizeof p);
    size_t l = strlen(p); snprintf(p + l, sizeof p - l, "/.server.pid");
    size_t n = 0; char *b = jsonl_read_file(p, &n);
    if (!b) return 0;
    long pid = strtol(b, NULL, 10); free(b);
    return pid > 1 ? (pid_t)pid : 0;
}
static int embed_kill_server(void) {
    pid_t pid = embed_lock_pid();
    if (!vision_pid_is_llama(pid)) return 0;
    kill(pid, SIGTERM);
    for (int i = 0; i < 20; i++) { struct timespec ts = { 0, 100 * 1000000 }; nanosleep(&ts, NULL); if (kill(pid, 0) != 0) break; }
    if (kill(pid, 0) == 0) kill(pid, SIGKILL);
    char p[DSTUDIO_PATH_MAX + 16]; embed_dir_path(p, sizeof p);
    size_t l = strlen(p); snprintf(p + l, sizeof p - l, "/.server.pid"); unlink(p);
    return 1;
}
static int embed_port_open(void) {
    int s = socket(AF_INET, SOCK_STREAM, 0);
    if (s < 0) return 0;
    struct sockaddr_in a; memset(&a, 0, sizeof a);
    a.sin_family = AF_INET; a.sin_port = htons(EMBED_PORT); a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    struct timeval tv = { 1, 0 };
    (void)setsockopt(s, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof tv);
    (void)setsockopt(s, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof tv);
    int ok = connect(s, (struct sockaddr *)&a, sizeof a) == 0;
    close(s);
    return ok;
}
static int embed_server_ready(void) {
    int s = socket(AF_INET, SOCK_STREAM, 0);
    if (s < 0) return 0;
    struct sockaddr_in a; memset(&a, 0, sizeof a);
    a.sin_family = AF_INET; a.sin_port = htons(EMBED_PORT); a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    struct timeval tv = { 3, 0 };
    (void)setsockopt(s, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof tv);
    (void)setsockopt(s, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof tv);
    if (connect(s, (struct sockaddr *)&a, sizeof a) != 0) { close(s); return 0; }
    static const char *req = "GET /health HTTP/1.0\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n";
    if (write(s, req, strlen(req)) < 0) { close(s); return 0; }
    char buf[64]; ssize_t n = read(s, buf, sizeof buf - 1); close(s);
    if (n <= 0) return 0;
    buf[n] = '\0';
    return strstr(buf, " 200") != NULL;
}
static int embed_spawn_detached(void) {
    if (!g_web_dir[0]) return 0;
    char script[DSTUDIO_PATH_MAX + 64];
    snprintf(script, sizeof script, "%s/scripts/embed-server.sh", g_web_dir);
    struct stat stt;
    if (stat(script, &stt) != 0) return 0;
    pid_t pid = fork();
    if (pid < 0) return 0;
    if (pid == 0) {
        if (fork() > 0) _exit(0);
        setsid();
        if (chdir(g_web_dir) != 0) _exit(127);
        child_setenv_metal();
        for (int cfd = 3; cfd < 256; cfd++) close(cfd);
        int dn = open("/dev/null", O_RDWR);
        if (dn >= 0) { dup2(dn, STDIN_FILENO); if (dn != STDIN_FILENO) close(dn); }
        int lg = open("/tmp/dstudio-embed.log", O_WRONLY | O_CREAT | O_APPEND, 0644);
        if (lg >= 0) { dup2(lg, STDOUT_FILENO); dup2(lg, STDERR_FILENO); if (lg > STDERR_FILENO) close(lg); }
        char *argv[] = { "/bin/sh", script, NULL };
        execv("/bin/sh", argv);
        _exit(127);
    }
    waitpid(pid, NULL, 0);
    return 1;
}
static int embed_ensure_server(int timeout_ms) {
    if (embed_server_ready()) return 1;
    if (!embed_port_open()) embed_spawn_detached();
    long long deadline = web_now_ms() + (timeout_ms > 0 ? timeout_ms : 120000);
    while (web_now_ms() < deadline) {
        struct timespec ts = { 0, 500 * 1000000 };
        nanosleep(&ts, NULL);
        if (embed_server_ready()) return 1;
    }
    return 0;
}
static void embed_hf_pref(char *out, size_t outsz) {
    char p[DSTUDIO_PATH_MAX + 8]; embed_dir_path(p, sizeof p);
    size_t l = strlen(p); snprintf(p + l, sizeof p - l, "/.hf");
    size_t n = 0; char *b = jsonl_read_file(p, &n);
    if (b) {
        while (n > 0 && (b[n - 1] == '\n' || b[n - 1] == '\r' || b[n - 1] == ' ')) b[--n] = '\0';
        if (b[0]) { cstr_copy(out, outsz, b); free(b); return; }
        free(b);
    }
    cstr_copy(out, outsz, EMBED_HF_DEFAULT);
}

/* Parse the next "embedding":[...] float array at *pp; advances *pp past ']'.
 * Writes up to cap floats; returns the count read (0 on failure). */
static int embed_parse_vec(const char **pp, float *out, int cap) {
    const char *p = strstr(*pp, "\"embedding\"");
    if (!p) return 0;
    p = strchr(p, '[');
    if (!p) return 0;
    p++;
    int n = 0;
    while (*p && *p != ']') {
        while (*p == ' ' || *p == ',' || *p == '\n' || *p == '\r' || *p == '\t') p++;
        if (*p == ']' || !*p) break;
        char *end = NULL;
        double v = strtod(p, &end);
        if (end == p) break;
        if (n < cap) out[n] = (float)v;
        n++;
        p = end;
    }
    if (*p == ']') p++;
    *pp = p;
    return n;
}

/* Embed `count` texts (each optionally prefixed) via the sidecar's
 * /v1/embeddings. Writes count*(*dim) floats into out with stride `stride`
 * (>= the model dim), L2-normalized. Returns 1 on success. */
static int embed_call(char *const *texts, int count, const char *prefix,
                      float *out, int stride, int *dim) {
    json_dyn_buf b = {0};
    if (!json_dyn_puts(&b, "{\"input\":[")) { free(b.ptr); return 0; }
    for (int i = 0; i < count; i++) {
        if (i && !json_dyn_puts(&b, ",")) { free(b.ptr); return 0; }
        if (prefix && prefix[0]) {
            size_t need = strlen(prefix) + strlen(texts[i]) + 1;
            char *combo = malloc(need);
            if (!combo) { free(b.ptr); return 0; }
            snprintf(combo, need, "%s%s", prefix, texts[i]);
            int ok = json_dyn_put_escaped(&b, combo);
            free(combo);
            if (!ok) { free(b.ptr); return 0; }
        } else if (!json_dyn_put_escaped(&b, texts[i])) { free(b.ptr); return 0; }
    }
    if (!json_dyn_puts(&b, "],\"model\":\"x\"}")) { free(b.ptr); return 0; }

    char tmpl[] = "/tmp/dstudio-embed-req-XXXXXX";
    int tf = mkstemp(tmpl);
    if (tf < 0) { free(b.ptr); return 0; }
    size_t off = 0;
    while (off < b.len) { ssize_t w = write(tf, b.ptr + off, b.len - off); if (w <= 0) break; off += (size_t)w; }
    int wrote_ok = off == b.len;
    close(tf); free(b.ptr);
    if (!wrote_ok) { unlink(tmpl); return 0; }

    char url[80];  snprintf(url, sizeof url, "http://127.0.0.1:%d/v1/embeddings", EMBED_PORT);
    char dataarg[80]; snprintf(dataarg, sizeof dataarg, "@%s", tmpl);
    char *argv[16]; int n = 0;
    argv[n++] = "curl"; argv[n++] = "-sS"; argv[n++] = "-X"; argv[n++] = "POST";
    argv[n++] = "-H"; argv[n++] = "Content-Type: application/json";
    argv[n++] = "--data-binary"; argv[n++] = dataarg;
    argv[n++] = "--max-time"; argv[n++] = "120";
    argv[n++] = url; argv[n] = NULL;
    int st = 0;
    char *resp = web_curl_capture(argv, 125000, &st);
    unlink(tmpl);
    if (!resp || !resp[0]) { free(resp); return 0; }

    const char *p = resp;
    int d = 0;
    for (int i = 0; i < count; i++) {
        float *slot = out + (size_t)i * stride;
        int got = embed_parse_vec(&p, slot, stride);
        if (got == 0) { free(resp); return 0; }
        if (d == 0) d = got;
        else if (got != d) { free(resp); return 0; }
        double s = 0; for (int k = 0; k < got; k++) s += (double)slot[k] * slot[k];
        double nr = s > 0 ? 1.0 / sqrt(s) : 0;
        for (int k = 0; k < got; k++) slot[k] = (float)(slot[k] * nr);
    }
    free(resp);
    *dim = d;
    return d > 0;
}

/* FNV-1a over the model tag + every (id, embed_text) → cache invalidation key. */
static unsigned long long skill_corpus_sig(const skill_hit_list *L, char *const *texts, const char *model) {
    unsigned long long h = 1469598103934665603ULL;
    for (const char *s = model; s && *s; s++) { h ^= (unsigned char)*s; h *= 1099511628211ULL; }
    for (int i = 0; i < L->n; i++) {
        for (const char *s = L->v[i].id; *s; s++) { h ^= (unsigned char)*s; h *= 1099511628211ULL; }
        h ^= 0; h *= 1099511628211ULL;
        for (const char *s = texts[i]; *s; s++) { h ^= (unsigned char)*s; h *= 1099511628211ULL; }
        h ^= '\n'; h *= 1099511628211ULL;
    }
    return h;
}

/* On-disk index: header {magic,dim,count,sig,model} + count*dim normalized
 * floats in enum order. */
#define SKILL_INDEX_MAGIC 0x44534531u  /* "DSE1" */
typedef struct { unsigned magic; int dim, count; unsigned long long sig; char model[128]; } skill_index_hdr;

static void skill_index_path(char *out, size_t outsz) {
    char dir[DSTUDIO_PATH_MAX]; embed_dir_path(dir, sizeof dir);
    snprintf(out, outsz, "%s/skill-index.bin", dir);
}
static float *skill_index_load(const skill_index_hdr *want) {
    char path[DSTUDIO_PATH_MAX + 32]; skill_index_path(path, sizeof path);
    FILE *f = fopen(path, "rb");
    if (!f) return NULL;
    skill_index_hdr h;
    if (fread(&h, sizeof h, 1, f) != 1 || h.magic != SKILL_INDEX_MAGIC ||
        h.dim != want->dim || h.count != want->count || h.sig != want->sig ||
        strncmp(h.model, want->model, sizeof h.model) != 0) { fclose(f); return NULL; }
    size_t nf = (size_t)h.dim * h.count;
    float *v = malloc(nf * sizeof *v);
    if (!v) { fclose(f); return NULL; }
    if (fread(v, sizeof *v, nf, f) != nf) { free(v); fclose(f); return NULL; }
    fclose(f);
    return v;
}
static void skill_index_save(const skill_index_hdr *h, const float *v) {
    char path[DSTUDIO_PATH_MAX + 32]; skill_index_path(path, sizeof path);
    char tmp[DSTUDIO_PATH_MAX + 40]; snprintf(tmp, sizeof tmp, "%s.tmp", path);
    FILE *f = fopen(tmp, "wb");
    if (!f) return;
    size_t nf = (size_t)h->dim * h->count;
    if (fwrite(h, sizeof *h, 1, f) == 1 && fwrite(v, sizeof *v, nf, f) == nf) {
        fclose(f); rename(tmp, path);
    } else { fclose(f); unlink(tmp); }
}

/* Get (load or build) the embedding matrix for the enumerated skills. On a
 * cache miss embeds every skill via the sidecar and persists the index. Returns
 * malloc'd count*dim floats (caller frees) and sets *dim; NULL on failure. */
static float *skill_index_ensure(const skill_hit_list *L, char *const *texts, int *dim_out) {
    char model[128]; embed_hf_pref(model, sizeof model);
    int dim = 0;
    /* Probe the model dim with a tiny embed (also confirms the server answers). */
    static float probe[EMBED_MAX_DIM];
    char *ping[1]; ping[0] = (char *)"ping";
    if (!embed_call(ping, 1, NULL, probe, EMBED_MAX_DIM, &dim) || dim <= 0 || dim > EMBED_MAX_DIM)
        return NULL;

    skill_index_hdr want = { SKILL_INDEX_MAGIC, dim, L->n, 0, {0} };
    cstr_copy(want.model, sizeof want.model, model);
    want.sig = skill_corpus_sig(L, texts, model);

    float *cached = skill_index_load(&want);
    if (cached) { *dim_out = dim; return cached; }

    /* Build: embed every skill text in batches, directly into the matrix. */
    float *vecs = malloc((size_t)L->n * dim * sizeof *vecs);
    if (!vecs) return NULL;
    const int BATCH = 16;
    for (int start = 0; start < L->n; start += BATCH) {
        int cnt = L->n - start < BATCH ? L->n - start : BATCH;
        int gd = 0;
        if (!embed_call(texts + start, cnt, NULL, vecs + (size_t)start * dim, dim, &gd) || gd != dim) {
            free(vecs); return NULL;
        }
        embed_touch_last_use();
    }
    skill_index_save(&want, vecs);
    *dim_out = dim;
    return vecs;
}

/* The semantic search worker: enumerate skills, ensure the index, embed the
 * query, rank by cosine, emit the top `limit`. Runs in a detached child. */
static void api_skills_search_run(int fd, const char *path) {
    char q[512], domain[120], subdomain[160], source[80], limit_s[32], fmt[16] = "";
    query_param(path, "q", q, sizeof q);
    query_param(path, "domain", domain, sizeof domain);
    query_param(path, "subdomain", subdomain, sizeof subdomain);
    query_param(path, "source", source, sizeof source);
    query_param(path, "limit", limit_s, sizeof limit_s);
    query_param(path, "format", fmt, sizeof fmt);
    int want_text = !strcmp(fmt, "text");   /* plain "id: desc" lines, for the agent tool */
    int limit = limit_s[0] ? atoi(limit_s) : 20;
    if (limit < 1) limit = 1;
    if (limit > 200) limit = 200;

    if (!q[0]) {
        if (want_text) send_text(fd, "400 Bad Request", "skills_search error: query is required\n", 0);
        else web_json_error(fd, "400 Bad Request", "q is required");
        return;
    }
    embed_touch_last_use();
    /* Short wait: the heavy model download happens in /api/embed/setup. */
    if (!embed_ensure_server(60000)) {
        if (want_text) send_text(fd, "503 Service Unavailable",
                                 "skills_search: semantic search is not available; proceed without a skill.\n", 0);
        else web_json_error(fd, "503 Service Unavailable",
                       "semantic skill search is not ready; install it once via POST /api/embed/setup");
        return;
    }

    skill_hit_list L = {0};
    if (!skill_enum_all(&L) || L.n == 0) { skill_hits_free(&L); web_json_error(fd, "500 Internal Server Error", "no skills"); return; }
    char **texts = calloc((size_t)L.n, sizeof *texts);
    if (!texts) { skill_hits_free(&L); web_json_error(fd, "500 Internal Server Error", "oom"); return; }
    for (int i = 0; i < L.n; i++) texts[i] = skill_embed_text(&L.v[i]);

    int dim = 0;
    float *vecs = skill_index_ensure(&L, texts, &dim);
    if (!vecs) {
        for (int i = 0; i < L.n; i++) free(texts[i]);
        free(texts); skill_hits_free(&L);
        if (want_text) send_text(fd, "503 Service Unavailable", "skills_search: index unavailable; proceed without a skill.\n", 0);
        else web_json_error(fd, "503 Service Unavailable", "could not build the semantic skill index");
        return;
    }
    for (int i = 0; i < L.n; i++) free(texts[i]);
    free(texts);

    /* Embed the query (with the Qwen3 retrieval instruction) and rank by cosine. */
    static float qv[EMBED_MAX_DIM];
    char *qq[1]; qq[0] = q;
    int qd = 0;
    if (!embed_call(qq, 1, EMBED_QUERY_INSTRUCT, qv, EMBED_MAX_DIM, &qd) || qd != dim) {
        free(vecs); skill_hits_free(&L);
        if (want_text) send_text(fd, "503 Service Unavailable", "skills_search: query embedding failed; proceed without a skill.\n", 0);
        else web_json_error(fd, "503 Service Unavailable", "query embedding failed");
        return;
    }
    for (int i = 0; i < L.n; i++) {
        /* Optional hard filters (domain/subdomain/source) before ranking. */
        if (source[0] && !text_contains_ci(L.v[i].source, source)) { L.v[i].score = -1000000; continue; }
        if (domain[0] && !text_contains_ci(L.v[i].domain, domain)) { L.v[i].score = -1000000; continue; }
        if (subdomain[0] && !text_contains_ci(L.v[i].subdomain, subdomain)) { L.v[i].score = -1000000; continue; }
        const float *v = vecs + (size_t)i * dim;
        double dot = 0; for (int k = 0; k < dim; k++) dot += (double)qv[k] * v[k];
        L.v[i].score = (int)(dot * 1000000.0);   /* cosine → int for the sort */
    }
    free(vecs);
    if (L.n > 1) qsort(L.v, (size_t)L.n, sizeof *L.v, skill_hit_cmp);

    int total = 0;
    for (int i = 0; i < L.n; i++) if (L.v[i].score > -1000000) total++;
    int emit = total < limit ? total : limit;

    /* Plain-text form for the agent's skills_search tool: "id: description" lines
     * it can hand straight to the model (no JSON parsing in the agent). */
    if (want_text) {
        json_dyn_buf tb = {0};
        int okt = json_dyn_puts(&tb, emit ? "Matching skills (best first) — load one with skill(\"<id>\"):\n"
                                          : "No skills matched. Proceed without a skill.\n");
        for (int i = 0; okt && i < emit; i++) {
            skill_hit *h = &L.v[i];
            okt = json_dyn_puts(&tb, "- ") && json_dyn_puts(&tb, h->id);
            if (okt && h->desc[0]) okt = json_dyn_puts(&tb, ": ") && json_dyn_puts(&tb, h->desc);
            if (okt) okt = json_dyn_puts(&tb, "\n");
        }
        skill_hits_free(&L);
        if (!okt) { free(tb.ptr); send_text(fd, "500 Internal Server Error", "skills_search error: out of memory\n", 0); return; }
        send_text(fd, "200 OK", tb.ptr ? tb.ptr : "No skills.\n", 0);
        free(tb.ptr);
        return;
    }

    json_dyn_buf body = {0};
    int ok = json_dyn_puts(&body, "{\"ok\":true,\"semantic\":true,\"skills\":[");
    for (int i = 0; ok && i < emit; i++) {
        skill_hit *h = &L.v[i];
        ok = json_dyn_puts(&body, i ? ",{" : "{") &&
             json_dyn_puts(&body, "\"id\":")           && json_dyn_put_escaped(&body, h->id) &&
             json_dyn_puts(&body, ",\"name\":")        && json_dyn_put_escaped(&body, h->name) &&
             json_dyn_puts(&body, ",\"description\":") && json_dyn_put_escaped(&body, h->desc) &&
             json_dyn_puts(&body, ",\"source\":")      && json_dyn_put_escaped(&body, h->source) &&
             json_dyn_puts(&body, ",\"domain\":")      && json_dyn_put_escaped(&body, h->domain) &&
             json_dyn_puts(&body, ",\"subdomain\":")   && json_dyn_put_escaped(&body, h->subdomain) &&
             json_dyn_puts(&body, ",\"tags\":")        && json_dyn_put_escaped(&body, h->tags) &&
             json_dyn_puts(&body, ",\"license\":")     && json_dyn_put_escaped(&body, h->license) &&
             json_dyn_puts(&body, ",\"tools\":[]") &&
             json_dyn_printf(&body, ",\"score\":%d,\"hasAssets\":%s,\"hasReferences\":%s,\"hasScripts\":%s}",
                             h->score, h->has_assets ? "true" : "false",
                             h->has_refs ? "true" : "false", h->has_scripts ? "true" : "false");
    }
    ok = ok && json_dyn_printf(&body, "],\"count\":%d,\"truncated\":%s}", emit, total > emit ? "true" : "false");
    skill_hits_free(&L);
    if (!ok) { free(body.ptr); web_json_error(fd, "500 Internal Server Error", "skill search memory"); return; }
    send_json(fd, "200 OK", body.ptr);
    free(body.ptr);
}
#endif /* !_WIN32 */

/* GET /api/skills/search?q=&domain=&subdomain=&source=&limit=
 * Semantic (embedding cosine) search over user, shipped and cyber skills. Forks
 * a detached worker (embedding + first-run index build are slow) so the single-
 * threaded main loop never blocks — same pattern as the vision handlers. */
static void api_skills_search(int fd, const char *path) {
#ifdef _WIN32
    (void)path;
    web_json_error(fd, "501 Not Implemented", "semantic skill search is not available on the Windows build yet");
#else
    pid_t pid = fork();
    if (pid < 0) { api_skills_search_run(fd, path); return; }
    if (pid == 0) {
        if (fork() > 0) _exit(0);
        if (g_srv_fd >= 0) close(g_srv_fd);
        if (g_out_fd >= 0) close(g_out_fd);
        if (g_err_fd >= 0) close(g_err_fd);
        if (g_in_fd  >= 0) close(g_in_fd);
        struct timeval tv = { 620, 0 };
        (void)setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof tv);
        api_skills_search_run(fd, path);
        close(fd);
        _exit(0);
    }
    waitpid(pid, NULL, 0);
#endif
}

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

static const char *skill_doc_body_start(const char *content) {
    const char *b = content ? content : "";
    if (!strncmp(b, "---", 3)) {
        const char *e = strstr(b + 3, "\n---");
        if (e) {
            b = e + 4;
            while (*b == '\n' || *b == '\r') b++;
        }
    }
    return b;
}

static void send_skill_doc_json(int fd, const char *id, const char *source, const char *content) {
    char nm[300], desc[900], modes[220];
    fm_field(content, "name", nm, sizeof nm);
    fm_field(content, "description", desc, sizeof desc);
    fm_field(content, "modes", modes, sizeof modes);
    if (!nm[0]) cstr_copy(nm, sizeof nm, id);
    if (!modes[0]) cstr_copy(modes, sizeof modes, "[agent]");
    const char *b = skill_doc_body_start(content);

    json_dyn_buf out = {0};
    int ok = json_dyn_puts(&out, "{\"ok\":true,\"id\":") &&
             json_dyn_put_escaped(&out, id) &&
             json_dyn_puts(&out, ",\"source\":") &&
             json_dyn_put_escaped(&out, source ? source : "") &&
             json_dyn_puts(&out, ",\"name\":") &&
             json_dyn_put_escaped(&out, nm) &&
             json_dyn_puts(&out, ",\"description\":") &&
             json_dyn_put_escaped(&out, desc) &&
             json_dyn_puts(&out, ",\"modes\":") &&
             json_dyn_put_escaped(&out, modes) &&
             json_dyn_puts(&out, ",\"body\":") &&
             json_dyn_put_escaped(&out, b) &&
             json_dyn_puts(&out, "}");
    if (ok) send_json(fd, "200 OK", out.ptr);
    else send_json(fd, "500 Internal Server Error", "{\"ok\":false}");
    free(out.ptr);
}

static char *read_skill_doc_any(const char *id, char *source, size_t sourcesz) {
    char dir[PATH_MAX], md[PATH_MAX];
    size_t len = 0;

    user_skills_dir(dir, sizeof dir);
    snprintf(md, sizeof md, "%s/%s/SKILL.md", dir, id);
    char *content = jsonl_read_file(md, &len);
    if (content) {
        cstr_copy(source, sourcesz, "user");
        return content;
    }

    if (g_web_dir[0]) {
        snprintf(md, sizeof md, "%s/extension/skills/%s/SKILL.md", g_web_dir, id);
        content = jsonl_read_file(md, &len);
        if (content) {
            cstr_copy(source, sourcesz, "dstudio");
            return content;
        }
    }

    if (cyber_skills_dir(dir, sizeof dir)) {
        snprintf(md, sizeof md, "%s/%s/SKILL.md", dir, id);
        content = jsonl_read_file(md, &len);
        if (content) {
            cstr_copy(source, sourcesz, "anthropic-cybersecurity-skills");
            return content;
        }
    }
    return NULL;
}

/* GET /api/skills/get?id=<id> — read a skill body for the editor. User-authored
 * skills win over shipped packs, so saving creates a local override instead of
 * mutating the repository catalog. */
static void api_skill_get(int fd, const char *path) {
    char id[64] = {0};
    query_param(path, "id", id, sizeof id);
    if (!skill_id_ok(id)) { send_json(fd, "400 Bad Request", "{\"ok\":false,\"error\":\"bad id\"}"); return; }
    char source[80] = "";
    char *content = read_skill_doc_any(id, source, sizeof source);
    if (!content) { send_json(fd, "404 Not Found", "{\"ok\":false,\"error\":\"no such skill\"}"); return; }
    send_skill_doc_json(fd, id, source, content);
    free(content);
}

static const char *design_content_type(const char *name);   /* defined below */

static int preview_rel_path_ok(const char *rel) {
    if (!rel || !rel[0] || rel[0] == '/' || strchr(rel, '\\') || strstr(rel, "..")) return 0;
    if (rel[0] == '.' || strstr(rel, "/.")) return 0;
    return 1;
}

static int preview_rel_asset_ok(const char *rel, const char *entry_html) {
    if (!preview_rel_path_ok(rel)) return 0;
    if (entry_html && !strcmp(rel, entry_html)) return 1;
    const char *dot = strrchr(rel, '.');
    const char *ext = dot ? dot + 1 : "";
    static const char *allowed[] = {
        "html", "htm", "css", "js", "mjs", "json",
        "png", "jpg", "jpeg", "webp", "svg", "gif", "ico",
        "woff", "woff2", "ttf", "otf", "mp4", "webm",
        NULL
    };
    for (int i = 0; allowed[i]; i++) {
        const char *a = ext, *b = allowed[i];
        while (*a && *b && ascii_eq_ci(*a, *b)) { a++; b++; }
        if (!*a && !*b) return 1;
    }
    return 0;
}

static int skill_preview_rel_ok(const char *rel) {
    return preview_rel_asset_ok(rel, "example.html");
}

static int design_system_preview_rel_ok(const char *rel) {
    return preview_rel_asset_ok(rel, "components.html");
}

/* GET /api/skill-preview/<id>/<preview-asset> — serve only shipped Open Design
 * template preview files. Local CSS/JS/fonts/images are allowed so original
 * examples render faithfully; user skills and cybersecurity packs are excluded. */
static void api_skill_preview(int fd, const char *path, int head_only) {
    static const char prefix[] = "/api/skill-preview/";
    const char *raw = path + strlen(prefix);
    const char *slash = strchr(raw, '/');
    if (!slash) { send_text(fd, "400 Bad Request", "path missing\n", head_only); return; }
    char id[64] = {0};
    url_decode_into(raw, (size_t)(slash - raw), id, sizeof id);
    if (!skill_id_ok(id)) { send_text(fd, "400 Bad Request", "bad id\n", head_only); return; }
    char rel[1024] = {0};
    url_decode_into(slash + 1, strcspn(slash + 1, "?"), rel, sizeof rel);
    if (!skill_preview_rel_ok(rel)) { send_text(fd, "400 Bad Request", "bad preview path\n", head_only); return; }
    if (!g_web_dir[0]) { send_text(fd, "404 Not Found", "web directory not found\n", head_only); return; }

    char md[2048];
    snprintf(md, sizeof md, "%s/extension/skills/%s/SKILL.md", g_web_dir, id);
    size_t mdlen = 0;
    char *content = jsonl_read_file(md, &mdlen);
    if (!content) { send_text(fd, "404 Not Found", "skill not found\n", head_only); return; }
    char upstream[400];
    fm_field(content, "ds4_upstream", upstream, sizeof upstream);
    free(content);
    if (strncmp(upstream, "open-design/", 12) != 0) {
        send_text(fd, "404 Not Found", "not an Open Design template\n", head_only);
        return;
    }

    char file[3072];
    snprintf(file, sizeof file, "%s/extension/skills/%s/%s", g_web_dir, id, rel);
    size_t len = 0;
    char *buf = read_html_disk(file, &len);
    if (!buf) { send_text(fd, "404 Not Found", "preview file not found\n", head_only); return; }
    send_response_hdrs(fd, "200 OK", design_content_type(rel), buf, len, head_only, DESIGN_HEADERS);
    free(buf);
}

/* GET /api/design-system-preview/<id>/<components.html|tokens.css|preview/...>
 * serves bundled design-system preview assets directly from extension/design-systems.
 * No generated fallback is produced here: the gallery either shows upstream local
 * files or a text-only card from DESIGN.md metadata. */
static void api_design_system_preview(int fd, const char *path, int head_only) {
    static const char prefix[] = "/api/design-system-preview/";
    const char *raw = path + strlen(prefix);
    const char *slash = strchr(raw, '/');
    if (!slash) { send_text(fd, "400 Bad Request", "path missing\n", head_only); return; }
    char id[64] = {0};
    url_decode_into(raw, (size_t)(slash - raw), id, sizeof id);
    if (!skill_id_ok(id)) { send_text(fd, "400 Bad Request", "bad id\n", head_only); return; }
    char rel[1024] = {0};
    url_decode_into(slash + 1, strcspn(slash + 1, "?"), rel, sizeof rel);
    if (!design_system_preview_rel_ok(rel)) { send_text(fd, "400 Bad Request", "bad preview path\n", head_only); return; }
    if (!g_web_dir[0]) { send_text(fd, "404 Not Found", "web directory not found\n", head_only); return; }

    char md[2048];
    snprintf(md, sizeof md, "%s/extension/design-systems/%s/DESIGN.md", g_web_dir, id);
    if (access(md, R_OK) != 0) {
        send_text(fd, "404 Not Found", "design system not found\n", head_only);
        return;
    }

    char file[3072];
    snprintf(file, sizeof file, "%s/extension/design-systems/%s/%s", g_web_dir, id, rel);
    size_t len = 0;
    char *buf = read_html_disk(file, &len);
    if (!buf) { send_text(fd, "404 Not Found", "preview file not found\n", head_only); return; }
    send_response_hdrs(fd, "200 OK", design_content_type(rel), buf, len, head_only, DESIGN_HEADERS);
    free(buf);
}

/* GET /api/user-skills/get?id=<id> — one skill's name/description/body, for the editor. */
static void api_user_skill_get(int fd, const char *path) {
    char id[64] = {0};
    query_param(path, "id", id, sizeof id);
    if (!skill_id_ok(id)) { send_json(fd, "400 Bad Request", "{\"ok\":false,\"error\":\"bad id\"}"); return; }
    char dir[1100], md[1300];
    user_skills_dir(dir, sizeof dir);
    snprintf(md, sizeof md, "%s/%s/SKILL.md", dir, id);
    size_t len = 0;
    char *content = jsonl_read_file(md, &len);
    if (!content) { send_json(fd, "404 Not Found", "{\"ok\":false,\"error\":\"no such skill\"}"); return; }
    send_skill_doc_json(fd, id, "user", content);
    free(content);
}

/* POST /api/user-skills {id,name,description,body} — create or overwrite a user skill. */
static void api_user_skill_save(int fd, const char *reqbody) {
    char id[64] = {0}, name[256] = {0}, desc[600] = {0}, modes[220] = {0};
    static char skbody[32768];
    json_get_string(reqbody, "id", id, sizeof id);
    if (!skill_id_ok(id)) { send_json(fd, "400 Bad Request", "{\"ok\":false,\"error\":\"id must be a-z, 0-9, -\"}"); return; }
    json_get_string(reqbody, "name", name, sizeof name);
    json_get_string(reqbody, "description", desc, sizeof desc);
    json_get_string(reqbody, "modes", modes, sizeof modes);
    if (!json_get_string(reqbody, "body", skbody, sizeof skbody)) skbody[0] = '\0';
    if (!name[0]) snprintf(name, sizeof name, "%s", id);
    if (!modes[0]) snprintf(modes, sizeof modes, "[agent]");
    /* frontmatter is line-based: keep name/description single-line. */
    for (char *p = name; *p; p++) if (*p == '\n' || *p == '\r') *p = ' ';
    for (char *p = desc; *p; p++) if (*p == '\n' || *p == '\r') *p = ' ';
    for (char *p = modes; *p; p++) if (*p == '\n' || *p == '\r') *p = ' ';
    char dir[1100], sub[1200], md[1300];
    user_skills_dir(dir, sizeof dir);
    snprintf(sub, sizeof sub, "%s/%s", dir, id);
    mkpath(sub);
    snprintf(md, sizeof md, "%s/SKILL.md", sub);
    static char filebuf[40000];
    int fo = snprintf(filebuf, sizeof filebuf,
        "---\nname: %s\ndescription: %s\nmodes: %s\n---\n\n%s\n", name, desc, modes, skbody);
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

/* GSA implementation lives with the extension assets. It is included here so
 * DStudio still builds as one C translation unit while keeping GSA ownership
 * under extension/gsa/. */
#include "../extension/gsa/dstudio_gsa.cfrag"

/* RSA reuses the same optional tool pool as GSA but keeps separate run
 * artifacts and prompts under extension/rsa/. */
#include "../extension/rsa/dstudio_rsa.cfrag"

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
    char ssd[16];
    if (json_get_string(body, "ssdStreaming", ssd, sizeof ssd) && ssd[0]) {
        if (!strcmp(ssd, "off")) cfg->ssd_streaming = SSD_STREAMING_OFF;
        else if (!strcmp(ssd, "on")) cfg->ssd_streaming = SSD_STREAMING_ON;
        else if (!strcmp(ssd, "auto")) cfg->ssd_streaming = SSD_STREAMING_AUTO;
        else *bad = 1;
    }
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
        g_remote_api_key[0] = '\0';
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
    if ((strncmp(base, "http://", 7) != 0 && strncmp(base, "https://", 8) != 0) ||
        !remote_value_safe(base)) {
        snprintf(err, errsz, "remoteBaseUrl must be a safe http:// LAN URL or an https:// API endpoint");
        return 0;
    }
    if (!model[0]) snprintf(model, sizeof model, "ds4");
    if (!remote_value_safe(model) || strlen(model) >= sizeof g_remote_model) {
        snprintf(err, errsz, "remoteModel is invalid");
        return 0;
    }
    /* Optional Bearer key for https cloud endpoints: held by the launcher
     * only — the agent/design child never sees it. */
    char key[256] = "";
    json_get_string(body, "remoteApiKey", key, sizeof key);
    if (key[0] && !remote_value_safe(key)) {
        snprintf(err, errsz, "remoteApiKey contains invalid characters");
        return 0;
    }
    snprintf(g_remote_api_key, sizeof g_remote_api_key, "%s", key);
    snprintf(g_remote_base_url, sizeof g_remote_base_url, "%s", base);
    snprintf(g_remote_model, sizeof g_remote_model, "%s", model);
    return 1;
}

static int launch_workdir_missing(int requested_mode, const char *workdir) {
    if (requested_mode != ENGINE_AGENT && requested_mode != ENGINE_DESIGN) return 0;
    if (!workdir || !workdir[0]) return 0;
    struct stat st;
    return stat(workdir, &st) != 0 || !S_ISDIR(st.st_mode);
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
    int requested_mode = want_agent ? ENGINE_AGENT : want_design ? ENGINE_DESIGN : ENGINE_SERVER;
    if (launch_workdir_missing(requested_mode, workdir)) {
        char wd_esc[2200], mode_esc[32], out[2600];
        json_escape_into(wd_esc, sizeof wd_esc, workdir, strlen(workdir));
        json_escape_into(mode_esc, sizeof mode_esc, mode, strlen(mode));
        snprintf(out, sizeof out,
                 "{\"ok\":false,\"code\":\"workdir_missing\",\"mode\":\"%s\","
                 "\"workdir\":\"%s\",\"error\":\"workdir not found: %s\"}",
                 mode_esc, wd_esc, wd_esc);
        send_json(fd, "400 Bad Request", out);
        return;
    }
    char launch_title[96];
    snprintf(launch_title, sizeof launch_title, "Start %s", mode);
    unsigned long long task_id = task_begin("launch", launch_title, mode, requested_mode, workdir, 0, 1);
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

    if (g_child > 0) stop_child();

    /* After stopping our own child, anything still on the engine port is an
     * EXTERNAL ds4-server (started outside the launcher). The instance-lock
     * forbids two large processes, so we cannot start agent/design (and a
     * server start would collide too). Without `force` we report a structured
     * error so the UI can offer "kill it & restart"; with `force` we free the
     * port first. */
    if (port_listening(ENGINE_DEFAULTS.port)) {
        if (!force) {
            task_mark_failed(task_id, "external ds4-server is holding the engine port", "port busy");
            char out[384];
            snprintf(out, sizeof out,
                "{\"ok\":false,\"taskId\":%llu,\"code\":\"external_server\",\"port\":%d,"
                "\"error\":\"a ds4-server is running outside the launcher (port %d). "
                "Stop it to free the instance-lock, or let the launcher restart it.\"}",
                task_id, ENGINE_DEFAULTS.port, ENGINE_DEFAULTS.port);
            send_json(fd, "409 Conflict", out);
            return;
        }
        if (!kill_external_server(ENGINE_DEFAULTS.port)) {
            task_mark_failed(task_id, "could not free the engine port", "external ds4-server still listening");
            char out[180];
            snprintf(out, sizeof out,
                "{\"ok\":false,\"taskId\":%llu,\"error\":\"could not free the engine port — stop the external ds4-server manually\"}",
                task_id);
            send_json(fd, "409 Conflict", out);
            return;
        }
    }

    char err[256] = "";
    int ok = want_agent ? spawn_agent(&cfg, workdir, err, sizeof err)
           : want_design ? spawn_design(&cfg, workdir, err, sizeof err)
                         : spawn_server(&cfg, err, sizeof err);
    if (!ok) {
        task_mark_failed(task_id, err[0] ? err : "engine spawn failed", err);
        char out[640], esc[520];
        json_escape_into(esc, sizeof esc, err, strlen(err));
        snprintf(out, sizeof out, "{\"ok\":false,\"taskId\":%llu,\"error\":\"%s\"}", task_id, esc);
        send_json(fd, "409 Conflict", out);
        return;
    }
    dstudio_task *t = task_find(task_id);
    if (t) t->pid = (int)g_child;
    g_active_launch_task = task_id;
    g_active_launch_mode = g_mode;
    task_mark_working(task_id, "engine process started; waiting for ready");
    if (g_ready) maybe_complete_launch_task(g_mode);
    char out[160];
    snprintf(out, sizeof out, "{\"ok\":true,\"taskId\":%llu,\"mode\":\"%s\"}", task_id, mode_name(g_mode));
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

static void api_agent_send_state_error(int fd, const char *status, const char *msg,
                                       unsigned long long task_id) {
    char msg_esc[512], err_esc[512], line_esc[512], out[1600];
    json_escape_into(msg_esc, sizeof msg_esc, msg ? msg : "agent/design send failed", strlen(msg ? msg : "agent/design send failed"));
    json_escape_into(err_esc, sizeof err_esc, g_engine_err, strlen(g_engine_err));
    json_escape_into(line_esc, sizeof line_esc, g_last_engine_line, strlen(g_last_engine_line));
    snprintf(out, sizeof out,
        "{\"ok\":false,\"taskId\":%llu,\"error\":\"%s\",\"mode\":\"%s\",\"running\":%s,\"ready\":%s,"
        "\"agentWorking\":%s,\"engineError\":\"%s\",\"engineLine\":\"%s\"}",
        task_id, msg_esc, mode_name(g_mode), g_child > 0 ? "true" : "false", g_ready ? "true" : "false",
        g_agent_working ? "true" : "false", err_esc, line_esc);
    send_json(fd, status, out);
}

static int display_prompt_is_guided_analysis(const char *display) {
    const unsigned char *p = (const unsigned char *)(display ? display : "");
    while (*p && isspace(*p)) p++;
    if (p[0] != '/') return 0;
    if (tolower(p[1]) == 'g' && tolower(p[2]) == 's' && tolower(p[3]) == 'a')
        return p[4] == '\0' || isspace(p[4]);
    if (tolower(p[1]) == 'r' && tolower(p[2]) == 's' && tolower(p[3]) == 'a')
        return p[4] == '\0' || isspace(p[4]);
    return 0;
}

static void api_agent_send(int fd, const char *body) {
    reap_child();
    static char prompt[BODY_MAX];
    if (!json_get_string(body, "prompt", prompt, sizeof prompt) || !prompt[0]) {
        send_json(fd, "400 Bad Request", "{\"ok\":false,\"error\":\"prompt missing\"}");
        return;
    }
    static char display[BODY_MAX];
    if (!json_get_string(body, "displayPrompt", display, sizeof display) || !display[0]) {
        snprintf(display, sizeof display, "%s", prompt);
    }
    size_t len = strlen(prompt);
    size_t display_len = strlen(display);
    const char *kind = task_kind_for_mode(g_mode);
    const char *target = g_mode == ENGINE_DESIGN ? "design" : "agent";
    unsigned long long task_id = task_begin(kind, g_mode == ENGINE_DESIGN ? "Design turn" : "Agent turn",
                                            target, g_mode, g_workdir, (int)g_child, 1);
    if (!MODE_IS_PIPED(g_mode) || g_in_fd < 0 || g_child <= 0) {
        task_mark_failed(task_id, "agent/design runtime is not active", g_engine_err);
        api_agent_send_state_error(fd, "409 Conflict", "agent/design runtime is not active", task_id);
        return;
    }
    if (g_interrupt_pending) {
        task_mark_failed(task_id, "agent/design interrupt is still settling", g_engine_err);
        api_agent_send_state_error(fd, "409 Conflict", "agent/design interrupt is still settling", task_id);
        return;
    }
    if (!g_ready) {
        task_mark_failed(task_id, "agent/design runtime is still loading", g_stage);
        api_agent_send_state_error(fd, "409 Conflict", "agent/design runtime is still loading", task_id);
        return;
    }
    size_t from = g_alen;
    int force_gsa_think_max = g_mode == ENGINE_AGENT && display_prompt_is_guided_analysis(display);
    static const char gsa_think_max_frame[] =
        "\x1e" "{\"type\":\"control\",\"name\":\"think\",\"value\":\"max\"}\n";
    /* send on the agent's stdin + newline as turn terminator */
    if ((force_gsa_think_max && !fd_write_all(g_in_fd, gsa_think_max_frame, sizeof gsa_think_max_frame - 1)) ||
        !fd_write_all(g_in_fd, prompt, len) || !fd_write_all(g_in_fd, "\n", 1)) {
        snprintf(g_engine_err, sizeof g_engine_err, "write to agent/design failed: %s", strerror(errno));
        task_mark_failed(task_id, "write to agent/design failed", g_engine_err);
        api_agent_send_state_error(fd, "500 Internal Server Error", "write to agent/design failed", task_id);
        return;
    }
    if (force_gsa_think_max) g_cfg.think = 2;
    /* Echo of the prompt into the transcript, marked, so the UI shows it right
     * away. The literals are SPLIT because \x is greedy on hex: "\x01E" would be
     * read as 0x1E. "\x01" "USER" keeps 0x01 separate from 'U'/'E'. */
    agent_buf_append("\x01" "USER\x02", 6);
    agent_buf_append(display, display_len);
    agent_buf_append("\x01" "ENDUSER\x02\n", 10);
    g_active_turn_task = task_id;
    g_active_turn_compacting = 0;
    task_mark_working(task_id, "prompt written; waiting for agent/design completion marker");
    g_agent_working = 1;
    g_ready = 1;
    char out[128];
    snprintf(out, sizeof out, "{\"ok\":true,\"taskId\":%llu,\"from\":%zu,\"at\":%zu}", task_id, from, g_alen);
    send_json(fd, "200 OK", out);
}

/* POST /api/agent/interrupt — abort the current agent/design turn (the UI
 * deleted the conversation that owns the live generation). Sends SIGINT to the
 * piped child; the non-interactive loop catches it (jsonl patch) and returns the
 * worker to idle WITHOUT killing the engine, so the next prompt still works. */
static void api_agent_interrupt(int fd, const char *body) {
    if (!MODE_IS_PIPED(g_mode) || g_child <= 0) {
        send_json(fd, "409 Conflict", "{\"ok\":false,\"error\":\"agent not active\"}");
        return;
    }
    /* A SIGINT is only safe when a turn is actually running: during model
     * load the jsonl SIGINT handler is not installed yet, and ds4-design
     * never installs one while idle — the signal would kill the freshly
     * spawned engine outright ("engine stopped (signal 2)" right after a
     * mode switch). With no active turn there is nothing to interrupt:
     * acknowledge and clear any stale turn task without signaling. */
    if (!g_ready || !g_agent_working) {
        if (g_active_turn_task) {
            task_mark_canceled(g_active_turn_task, "turn already idle at interrupt");
            g_active_turn_task = 0;
        }
        send_json(fd, "200 OK", "{\"ok\":true,\"taskId\":0,\"status\":\"idle\"}");
        return;
    }
    char reason[256] = {0};
    char status[32] = {0};
    if (body && *body) {
        json_get_string(body, "reason", reason, sizeof reason);
        json_get_string(body, "status", status, sizeof status);
    }
    const char *msg = reason[0] ? reason : "agent/design turn interrupted by user";
#ifdef _WIN32
    if (g_child_win_pid) GenerateConsoleCtrlEvent(CTRL_BREAK_EVENT, g_child_win_pid);
#else
    kill(g_child, SIGINT);
#endif
    g_interrupt_pending = 1;
    unsigned long long task_id = g_active_turn_task;
    const char *applied_status = "canceled";
    if (g_active_turn_task) {
        if (!strcmp(status, "completed")) {
            applied_status = "completed";
            task_mark_completed(g_active_turn_task, msg);
        } else if (!strcmp(status, "incomplete")) {
            applied_status = "incomplete";
            task_mark_incomplete(g_active_turn_task, msg, msg);
        } else {
            task_mark_canceled(g_active_turn_task, msg);
        }
        g_active_turn_task = 0;
    }
    g_active_turn_compacting = 0;
    g_agent_working = 1; /* WAITING or child exit will clear this; do not accept another prompt mid-SIGINT */
    char status_esc[96];
    json_escape_into(status_esc, sizeof status_esc, applied_status, strlen(applied_status));
    char out[192];
    snprintf(out, sizeof out, "{\"ok\":true,\"taskId\":%llu,\"status\":\"%s\"}", task_id, status_esc);
    send_json(fd, "200 OK", out);
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

static void setup_capture_append(char *out, size_t *used, size_t outsz, const char *buf, size_t n) {
    if (!out || outsz <= 1 || !buf || !n) return;
    if (n >= outsz - 1) {
        memcpy(out, buf + n - (outsz - 1), outsz - 1);
        *used = outsz - 1;
        out[*used] = '\0';
        return;
    }
    if (*used + n >= outsz) {
        size_t drop = *used + n - (outsz - 1);
        if (drop < *used) {
            memmove(out, out + drop, *used - drop);
            *used -= drop;
        } else {
            *used = 0;
        }
    }
    memcpy(out + *used, buf, n);
    *used += n;
    out[*used] = '\0';
}

static int setup_run_cmd_capture(const char *cwd, char *const argv[], char *out, size_t outsz) {
    if (out && outsz) out[0] = '\0';
#ifdef _WIN32
    char cmd[32768] = "";
    for (int i = 0; argv && argv[i]; i++) win_arg_append(cmd, sizeof cmd, argv[i]);
    if (!cmd[0]) {
        snprintf(out, outsz, "empty command");
        return 127;
    }

    SECURITY_ATTRIBUTES sa = { sizeof(sa), NULL, TRUE };
    HANDLE rd = NULL, wr = NULL;
    if (!CreatePipe(&rd, &wr, &sa, 0)) {
        snprintf(out, outsz, "CreatePipe failed (error %lu)", GetLastError());
        return 126;
    }
    SetHandleInformation(rd, HANDLE_FLAG_INHERIT, 0);

    STARTUPINFOA si;
    PROCESS_INFORMATION pi;
    HANDLE nul = CreateFileA("NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE,
                             &sa, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
    memset(&si, 0, sizeof si);
    memset(&pi, 0, sizeof pi);
    si.cb = sizeof si;
    si.dwFlags = STARTF_USESTDHANDLES;
    si.hStdInput = (nul != INVALID_HANDLE_VALUE) ? nul : GetStdHandle(STD_INPUT_HANDLE);
    si.hStdOutput = wr;
    si.hStdError = wr;

    BOOL ok = CreateProcessA(NULL, cmd, NULL, NULL, TRUE,
                             CREATE_NO_WINDOW, NULL,
                             (cwd && cwd[0]) ? cwd : NULL, &si, &pi);
    CloseHandle(wr);
    if (!ok) {
        DWORD e = GetLastError();
        if (nul != INVALID_HANDLE_VALUE) CloseHandle(nul);
        CloseHandle(rd);
        snprintf(out, outsz, "CreateProcess failed for %s (error %lu)", argv && argv[0] ? argv[0] : "(null)", e);
        return 127;
    }
    if (nul != INVALID_HANDLE_VALUE) CloseHandle(nul);
    CloseHandle(pi.hThread);

    size_t used = 0;
    char buf[2048];
    for (;;) {
        DWORD avail = 0;
        if (PeekNamedPipe(rd, NULL, 0, NULL, &avail, NULL) && avail > 0) {
            DWORD got = 0;
            DWORD want = avail < sizeof buf ? avail : (DWORD)sizeof buf;
            if (ReadFile(rd, buf, want, &got, NULL) && got > 0) {
                setup_capture_append(out, &used, outsz, buf, (size_t)got);
                continue;
            }
        }
        DWORD wait = WaitForSingleObject(pi.hProcess, 30);
        if (wait == WAIT_OBJECT_0) {
            for (;;) {
                DWORD left = 0;
                if (!PeekNamedPipe(rd, NULL, 0, NULL, &left, NULL) || left == 0) break;
                DWORD got = 0;
                DWORD want = left < sizeof buf ? left : (DWORD)sizeof buf;
                if (!ReadFile(rd, buf, want, &got, NULL) || got == 0) break;
                setup_capture_append(out, &used, outsz, buf, (size_t)got);
            }
            break;
        }
        if (wait == WAIT_FAILED) break;
    }

    DWORD code = 126;
    GetExitCodeProcess(pi.hProcess, &code);
    CloseHandle(pi.hProcess);
    CloseHandle(rd);
    return (int)code;
#else
    int pp[2];
    if (pipe(pp) != 0) {
        snprintf(out, outsz, "pipe failed: %s", strerror(errno));
        return 126;
    }
    pid_t pid = fork();
    if (pid < 0) {
        close(pp[0]);
        close(pp[1]);
        snprintf(out, outsz, "fork failed: %s", strerror(errno));
        return 126;
    }
    if (pid == 0) {
        if (cwd && cwd[0] && chdir(cwd) != 0) _exit(127);
        int dn = open("/dev/null", O_RDONLY);
        if (dn >= 0) { dup2(dn, STDIN_FILENO); close(dn); }
        dup2(pp[1], STDOUT_FILENO);
        dup2(pp[1], STDERR_FILENO);
        close(pp[0]);
        close(pp[1]);
        execvp(argv[0], argv);
        _exit(127);
    }
    close(pp[1]);
    size_t used = 0;
    char buf[2048];
    for (;;) {
        ssize_t n = read(pp[0], buf, sizeof buf);
        if (n > 0) setup_capture_append(out, &used, outsz, buf, (size_t)n);
        else if (n == 0) break;
        else if (errno != EINTR) break;
    }
    close(pp[0]);
    int st = 0;
    if (waitpid(pid, &st, 0) != pid) {
        setup_capture_append(out, &used, outsz, "waitpid failed\n", 15);
        return 126;
    }
    if (WIFEXITED(st)) return WEXITSTATUS(st);
    if (WIFSIGNALED(st)) return 128 + WTERMSIG(st);
    return 126;
#endif
}

static int setup_dir_empty(const char *path, int *empty) {
    DIR *d = opendir(path);
    if (!d) return 0;
    *empty = 1;
    struct dirent *e;
    while ((e = readdir(d))) {
        if (!strcmp(e->d_name, ".") || !strcmp(e->d_name, "..")) continue;
        *empty = 0;
        break;
    }
    closedir(d);
    return 1;
}

static int setup_remove_tree(const char *path) {
    struct stat st;
    if (lstat(path, &st) != 0) return errno == ENOENT;
    if (!S_ISDIR(st.st_mode)) return unlink(path) == 0;

    DIR *d = opendir(path);
    if (!d) return 0;
    int ok = 1;
    struct dirent *e;
    while ((e = readdir(d))) {
        if (!strcmp(e->d_name, ".") || !strcmp(e->d_name, "..")) continue;
        char child[DSTUDIO_PATH_MAX];
        int n = snprintf(child, sizeof child, "%s/%s", path, e->d_name);
        if (n < 0 || (size_t)n >= sizeof child || !setup_remove_tree(child)) ok = 0;
    }
    closedir(d);
    if (rmdir(path) != 0) ok = 0;
    return ok;
}

static int setup_parent_dir(const char *path, char *out, size_t outsz) {
    if (!path || !path[0] || !out || !outsz) return 0;
    int n = snprintf(out, outsz, "%s", path);
    if (n < 0 || (size_t)n >= outsz) return 0;
    char *slash = strrchr(out, '/');
#ifdef _WIN32
    char *bslash = strrchr(out, '\\');
    if (!slash || bslash > slash) slash = bslash;
#endif
    if (!slash) return 0;
    if (slash == out) slash[1] = '\0';
    else *slash = '\0';
    return 1;
}

static int setup_first_extracted_dir(const char *dir, char *out, size_t outsz) {
    DIR *d = opendir(dir);
    if (!d) return 0;
    int found = 0;
    struct dirent *e;
    while ((e = readdir(d))) {
        if (!strcmp(e->d_name, ".") || !strcmp(e->d_name, "..")) continue;
        char child[DSTUDIO_PATH_MAX];
        int n = snprintf(child, sizeof child, "%s/%s", dir, e->d_name);
        if (n < 0 || (size_t)n >= sizeof child) continue;
        struct stat st;
        if (lstat(child, &st) != 0 || !S_ISDIR(st.st_mode)) continue;
        snprintf(out, outsz, "%s", child);
        found = 1;
        break;
    }
    closedir(d);
    return found;
}

static int setup_download_ds4_archive(const char *url, const char *tag, const char *target,
                                      char *log_tail, size_t logsz,
                                      char *err, size_t errsz) {
    char parent[DSTUDIO_PATH_MAX];
    if (!setup_parent_dir(target, parent, sizeof parent)) {
        snprintf(err, errsz, "could not resolve parent folder for %s", target ? target : "(null)");
        return 0;
    }

    char archive[DSTUDIO_PATH_MAX];
    char extract[DSTUDIO_PATH_MAX];
    int n = snprintf(archive, sizeof archive, "%s/.dstudio-ds4-%s.tar.gz", parent, tag);
    int m = snprintf(extract, sizeof extract, "%s/.dstudio-ds4-extract-%ld", parent, (long)getpid());
    if (n < 0 || (size_t)n >= sizeof archive || m < 0 || (size_t)m >= sizeof extract) {
        snprintf(err, errsz, "temporary ds4 archive path is too long");
        return 0;
    }

    unlink(archive);
    setup_remove_tree(extract);
    if (mkdir(extract, 0755) != 0) {
        snprintf(err, errsz, "could not create temporary extract folder %s: %s", extract, strerror(errno));
        return 0;
    }

    char *curl_argv[] = {
        "curl", "-L", "--fail", "--show-error", "--retry", "2",
        "--connect-timeout", "20", "--max-time", "300",
        "-o", archive, (char *)url, NULL
    };
    int rc = setup_run_cmd_capture(NULL, curl_argv, log_tail, logsz);
    if (rc != 0) {
        snprintf(err, errsz,
                 "ds4 archive download failed (exit %d). DStudio setup needs curl and tar, not git. URL: %s. Output: %.7000s",
                 rc, url, log_tail && log_tail[0] ? log_tail : "(no output)");
        unlink(archive);
        setup_remove_tree(extract);
        return 0;
    }

    char *tar_argv[] = { "tar", "-xzf", archive, "-C", extract, NULL };
    rc = setup_run_cmd_capture(NULL, tar_argv, log_tail, logsz);
    if (rc != 0) {
        snprintf(err, errsz,
                 "ds4 archive extraction failed (exit %d). DStudio setup needs tar. Output: %.7600s",
                 rc, log_tail && log_tail[0] ? log_tail : "(no output)");
        unlink(archive);
        setup_remove_tree(extract);
        return 0;
    }

    char extracted[DSTUDIO_PATH_MAX];
    if (!setup_first_extracted_dir(extract, extracted, sizeof extracted)) {
        snprintf(err, errsz, "ds4 archive did not contain a source folder");
        unlink(archive);
        setup_remove_tree(extract);
        return 0;
    }

    struct stat st;
    if (stat(target, &st) == 0) {
        int empty = 0;
        if (!S_ISDIR(st.st_mode) || !setup_dir_empty(target, &empty) || !empty) {
            snprintf(err, errsz, "DStudio/ds4 exists and is not an empty folder");
            unlink(archive);
            setup_remove_tree(extract);
            return 0;
        }
        if (rmdir(target) != 0) {
            snprintf(err, errsz, "could not replace empty DStudio/ds4 folder: %s", strerror(errno));
            unlink(archive);
            setup_remove_tree(extract);
            return 0;
        }
    }

    if (rename(extracted, target) != 0) {
        snprintf(err, errsz, "could not move extracted ds4 source into %s: %s", target, strerror(errno));
        unlink(archive);
        setup_remove_tree(extract);
        return 0;
    }

    unlink(archive);
    setup_remove_tree(extract);
    return 1;
}

/* Downloads this repo's tree at the pinned content commit and installs only the
 * bundled-content dirs (skills, design-systems, gsa/third_party) under
 * extension/. Mirrors setup_download_ds4_archive: curl the codeload tarball, tar
 * -xzf into a temp dir on the SAME filesystem (so the rename is atomic), then
 * move each content dir into place. Runs in a forked child (start_content_download)
 * or synchronously on Windows. Returns 1 on success. */
static int setup_download_content_archive(char *log_tail, size_t logsz, char *err, size_t errsz) {
    if (!g_web_dir[0]) { snprintf(err, errsz, "content target unknown (extension/ not found)"); return 0; }

    char ext[DSTUDIO_PATH_MAX];
    int e = snprintf(ext, sizeof ext, "%s/extension", g_web_dir);
    if (e < 0 || (size_t)e >= sizeof ext) { snprintf(err, errsz, "extension path too long"); return 0; }

    char archive[DSTUDIO_PATH_MAX], extract[DSTUDIO_PATH_MAX];
    int n = snprintf(archive, sizeof archive, "%s/.dstudio-content-%s.tar.gz", g_web_dir, DS4_CONTENT_COMMIT);
    int m = snprintf(extract, sizeof extract, "%s/.dstudio-content-extract-%ld", g_web_dir, (long)getpid());
    if (n < 0 || (size_t)n >= sizeof archive || m < 0 || (size_t)m >= sizeof extract) {
        snprintf(err, errsz, "temporary content archive path too long");
        return 0;
    }

    unlink(archive);
    setup_remove_tree(extract);
    if (mkdir(extract, 0755) != 0) {
        snprintf(err, errsz, "could not create temp extract folder %s: %s", extract, strerror(errno));
        return 0;
    }

    char *curl_argv[] = {
        "curl", "-L", "--fail", "--show-error", "--retry", "2",
        "--connect-timeout", "20", "--max-time", "600",
        "-o", archive, (char *)DS4_CONTENT_ARCHIVE_URL, NULL
    };
    int rc = setup_run_cmd_capture(NULL, curl_argv, log_tail, logsz);
    if (rc != 0) {
        snprintf(err, errsz,
                 "content archive download failed (exit %d). DStudio setup needs curl and tar. URL: %s. Output: %.5000s",
                 rc, DS4_CONTENT_ARCHIVE_URL, log_tail && log_tail[0] ? log_tail : "(no output)");
        unlink(archive); setup_remove_tree(extract); return 0;
    }

    char *tar_argv[] = { "tar", "-xzf", archive, "-C", extract, NULL };
    rc = setup_run_cmd_capture(NULL, tar_argv, log_tail, logsz);
    if (rc != 0) {
        snprintf(err, errsz, "content archive extraction failed (exit %d). DStudio setup needs tar. Output: %.5600s",
                 rc, log_tail && log_tail[0] ? log_tail : "(no output)");
        unlink(archive); setup_remove_tree(extract); return 0;
    }

    char top[DSTUDIO_PATH_MAX];
    if (!setup_first_extracted_dir(extract, top, sizeof top)) {
        snprintf(err, errsz, "content archive did not contain a source folder");
        unlink(archive); setup_remove_tree(extract); return 0;
    }

    /* gsa/third_party needs extension/gsa to exist (harmless if it already does). */
    char gsadir[DSTUDIO_PATH_MAX];
    snprintf(gsadir, sizeof gsadir, "%s/gsa", ext);
    mkdir(gsadir, 0755);

    static const char *subs[] = { "skills", "design-systems", "gsa/third_party" };
    for (int i = 0; i < 3; i++) {
        char src[DSTUDIO_PATH_MAX], dst[DSTUDIO_PATH_MAX];
        int a = snprintf(src, sizeof src, "%s/extension/%s", top, subs[i]);
        int b = snprintf(dst, sizeof dst, "%s/%s", ext, subs[i]);
        if (a < 0 || (size_t)a >= sizeof src || b < 0 || (size_t)b >= sizeof dst) {
            snprintf(err, errsz, "content path too long for %s", subs[i]);
            unlink(archive); setup_remove_tree(extract); return 0;
        }
        struct stat sst;
        if (stat(src, &sst) != 0 || !S_ISDIR(sst.st_mode)) {
            snprintf(err, errsz, "content archive missing extension/%s", subs[i]);
            unlink(archive); setup_remove_tree(extract); return 0;
        }
        setup_remove_tree(dst);   /* replace any partial/stale copy */
        if (rename(src, dst) != 0) {
            snprintf(err, errsz, "could not install extension/%s: %s", subs[i], strerror(errno));
            unlink(archive); setup_remove_tree(extract); return 0;
        }
    }

    unlink(archive);
    setup_remove_tree(extract);
    return 1;
}

/* Kicks off the bundled-content download. On POSIX it forks a child so the
 * single-threaded server keeps serving; reap_child() observes the exit and
 * closes the task. On Windows it runs synchronously. Returns the task id (0 if
 * it could not even start). */
static unsigned long long start_content_download(void) {
    if (g_content_dl_pid > 0) return g_content_dl_task;   /* already running */
    unsigned long long task_id = task_begin("setup", "Download bundled content", "content",
                                            ENGINE_NONE, g_web_dir, 0, 0);
#ifdef _WIN32
    task_mark_working(task_id, "downloading bundled content");
    char clog[4096] = "", cerr[1024] = "";
    if (setup_download_content_archive(clog, sizeof clog, cerr, sizeof cerr))
        task_mark_completed(task_id, "bundled content installed");
    else
        task_mark_failed(task_id, "content download failed", cerr);
    return task_id;
#else
    pid_t pid = fork();
    if (pid < 0) {
        task_mark_failed(task_id, "fork failed", strerror(errno));
        return 0;
    }
    if (pid == 0) {
        int log = open("/tmp/ds4-content-dl.log", O_WRONLY | O_CREAT | O_TRUNC, 0644);
        if (log >= 0) { dup2(log, STDOUT_FILENO); dup2(log, STDERR_FILENO); close(log); }
        int dn = open("/dev/null", O_RDONLY); if (dn >= 0) { dup2(dn, STDIN_FILENO); close(dn); }
        if (g_srv_fd >= 0) close(g_srv_fd);
        char clog[4096] = "", cerr[1024] = "";
        int ok = setup_download_content_archive(clog, sizeof clog, cerr, sizeof cerr);
        if (!ok) fprintf(stderr, "content download failed: %s\n", cerr);
        _exit(ok ? 0 : 1);
    }
    g_content_dl_pid = pid;
    g_content_dl_task = task_id;
    dstudio_task *t = task_find(task_id);
    if (t) t->pid = (int)pid;
    task_mark_working(task_id, "downloading bundled content");
    printf("content: downloading bundled content (pid %d) — log /tmp/ds4-content-dl.log\n", (int)pid);
    return task_id;
#endif
}

/* POST /api/setup/content — download/install the bundled content on demand. */
static void api_setup_content(int fd) {
    reap_child();
    if (content_present()) {
        send_json(fd, "200 OK", "{\"ok\":true,\"already\":true,\"contentOk\":true}");
        return;
    }
    if (g_content_dl_pid > 0) {
        char out[160];
        snprintf(out, sizeof out, "{\"ok\":true,\"taskId\":%llu,\"started\":true,\"running\":true}", g_content_dl_task);
        send_json(fd, "200 OK", out);
        return;
    }
    unsigned long long task_id = start_content_download();
    if (!task_id) {
        send_json(fd, "500 Internal Server Error", "{\"ok\":false,\"error\":\"could not start content download\"}");
        return;
    }
    char out[192];
    int done = content_present();   /* on Windows the download already finished synchronously */
    snprintf(out, sizeof out, "{\"ok\":true,\"taskId\":%llu,\"started\":true,\"contentOk\":%s}",
             task_id, done ? "true" : "false");
    send_json(fd, "200 OK", out);
}

static int setup_gguf_dir_path(const char *ds4dir, char *out, size_t outsz) {
    if (!ds4dir || !ds4dir[0] || !out || !outsz) return 0;
#ifdef _WIN32
    int n = snprintf(out, outsz, "%s\\gguf", ds4dir);
#else
    int n = snprintf(out, outsz, "%s/gguf", ds4dir);
#endif
    return n >= 0 && (size_t)n < outsz;
}

static int setup_gguf_dir_ok_path(const char *ds4dir) {
    char path[DSTUDIO_PATH_MAX + 16];
    if (!setup_gguf_dir_path(ds4dir, path, sizeof path)) return 0;
    struct stat st;
    return stat(path, &st) == 0 && S_ISDIR(st.st_mode);
}

static int setup_ensure_gguf_dir(char *err, size_t errsz) {
    char path[DSTUDIO_PATH_MAX + 16];
    if (!setup_gguf_dir_path(g_ds4_dir, path, sizeof path)) {
        snprintf(err, errsz, "gguf folder path is too long under %s", g_ds4_dir);
        return 0;
    }
    struct stat st;
    if (stat(path, &st) == 0) {
        if (S_ISDIR(st.st_mode)) return 1;
        snprintf(err, errsz, "%s exists but is not a folder", path);
        return 0;
    }
    if (mkdir(path, 0755) != 0 && errno != EEXIST) {
        snprintf(err, errsz, "could not create model folder %s: %s", path, strerror(errno));
        return 0;
    }
    if (stat(path, &st) != 0 || !S_ISDIR(st.st_mode)) {
        snprintf(err, errsz, "model folder %s was not created", path);
        return 0;
    }
    return 1;
}

#ifdef _WIN32
static void setup_trim_line(char *s) {
    if (!s) return;
    size_t n = strlen(s);
    while (n && (s[n - 1] == '\n' || s[n - 1] == '\r' || s[n - 1] == ' ' || s[n - 1] == '\t'))
        s[--n] = '\0';
}

static int setup_windows_engine_ready(void) {
    win_prepare_engine_runtime();
    char ver[DSTUDIO_PATH_MAX + 64];
    snprintf(ver, sizeof ver, "%s\\ds4-agent-jsonl.ver", g_ds4_dir);
    int patch_version = jsonl_patch_version();
    return file_present("ds4-server.exe") &&
           file_present("ds4-agent.exe") &&
           file_present("ds4-agent-jsonl.exe") &&
           file_present("ds4-design.exe") &&
           patch_version > 0 &&
           jsonl_sentinel_ok(ver, patch_version);
}

static int setup_find_windows_bash(char *out, size_t outsz) {
    win_prepare_engine_runtime();
    const char *candidates[] = {
        "C:\\msys64\\usr\\bin\\bash.exe",
        "C:\\cygwin64\\bin\\bash.exe",
        "bash.exe",
        "bash",
        NULL
    };
    for (int i = 0; candidates[i]; i++) {
        if (strchr(candidates[i], '\\') && access(candidates[i], X_OK) != 0) continue;
        snprintf(out, outsz, "%s", candidates[i]);
        return 1;
    }
    return 0;
}

static int setup_windows_posix_path(const char *bash, const char *win_path,
                                    char *out, size_t outsz, char *err, size_t errsz) {
    char log_tail[4096];
    char *argv[] = { (char *)bash, "-lc", "cygpath -u \"$1\"", "_", (char *)win_path, NULL };
    int rc = setup_run_cmd_capture(NULL, argv, log_tail, sizeof log_tail);
    if (rc != 0 || !log_tail[0]) {
        snprintf(err, errsz, "cygpath failed for %s (exit %d). Output: %.3000s",
                 win_path ? win_path : "(null)", rc, log_tail[0] ? log_tail : "(no output)");
        return 0;
    }
    setup_trim_line(log_tail);
    snprintf(out, outsz, "%s", log_tail);
    return 1;
}

static int setup_windows_build_ds4(char *log_tail, size_t logsz, char *err, size_t errsz) {
    if (!g_web_dir[0]) {
        snprintf(err, errsz,
                 "Windows ds4 build requires the DStudio source checkout with scripts/ and patch/. "
                 "The portable build can still use packaged engine binaries next to DStudio.exe.");
        return 0;
    }

    char script[DSTUDIO_PATH_MAX + 128];
    snprintf(script, sizeof script, "%s\\scripts\\build-ds4-windows-cygwin.sh", g_web_dir);
    if (access(script, R_OK) != 0) {
        snprintf(err, errsz, "Windows ds4 build script not found: %s", script);
        return 0;
    }

    char bash[DSTUDIO_PATH_MAX];
    if (!setup_find_windows_bash(bash, sizeof bash)) {
        snprintf(err, errsz,
                 "Windows ds4 setup downloaded the pinned source, but could not find MSYS2/Cygwin bash. "
                 "Install MSYS2 in C:\\msys64 or use the portable package with DS4 engine binaries.");
        return 0;
    }

    char root_unix[DSTUDIO_PATH_MAX], ds4_unix[DSTUDIO_PATH_MAX];
    if (!setup_windows_posix_path(bash, g_web_dir, root_unix, sizeof root_unix, err, errsz)) return 0;
    if (!setup_windows_posix_path(bash, g_ds4_dir, ds4_unix, sizeof ds4_unix, err, errsz)) return 0;

    char *argv[] = {
        bash,
        "-lc",
        "cd \"$1\" && ./scripts/build-ds4-windows-cygwin.sh \"$2\"",
        "_",
        root_unix,
        ds4_unix,
        NULL
    };
    int rc = setup_run_cmd_capture(NULL, argv, log_tail, logsz);
    if (rc != 0) {
        snprintf(err, errsz,
                 "Windows ds4 build failed (exit %d). Install MSYS2/Cygwin make+gcc+patch. Output: %.7600s",
                 rc, log_tail && log_tail[0] ? log_tail : "(no output)");
        return 0;
    }
    if (!setup_windows_engine_ready()) {
        snprintf(err, errsz, "Windows ds4 build finished but required engine binaries or JSONL marker are missing");
        return 0;
    }
    return 1;
}

static int setup_prepare_ds4_windows(char *log_tail, size_t logsz, char *err, size_t errsz) {
    if (setup_windows_engine_ready()) return 1;
    return setup_windows_build_ds4(log_tail, logsz, err, errsz);
}
#endif

static void setup_send_json(int fd, const char *status, int ok, const char *target,
                            int downloaded, int built, int jsonl_prepared, int design_prepared,
                            int was_running, int restarted, const char *mode,
                            const char *error) {
    json_dyn_buf b = {0};
    unsigned long long task_id = g_active_setup_task;
    if (task_id) {
        if (ok) task_mark_completed(task_id, "ds4 setup completed");
        else task_mark_failed(task_id, error && error[0] ? error : "ds4 setup failed", target ? target : g_ds4_dir);
        g_active_setup_task = 0;
    }
    int good = json_dyn_puts(&b, "{\"ok\":") &&
               json_dyn_puts(&b, ok ? "true" : "false") &&
               json_dyn_puts(&b, ",\"taskId\":") &&
               json_dyn_printf(&b, "%llu", task_id) &&
               json_dyn_puts(&b, ",\"repo\":") &&
               json_dyn_put_escaped(&b, DS4_REPO_URL) &&
               json_dyn_puts(&b, ",\"commit\":") &&
               json_dyn_put_escaped(&b, DS4_UPSTREAM_COMMIT) &&
               json_dyn_puts(&b, ",\"archiveUrl\":") &&
               json_dyn_put_escaped(&b, DS4_ARCHIVE_URL) &&
               json_dyn_puts(&b, ",\"ds4dir\":") &&
               json_dyn_put_escaped(&b, target ? target : g_ds4_dir) &&
               json_dyn_puts(&b, ",\"ds4dirOk\":") &&
               json_dyn_puts(&b, ds4_dir_valid() ? "true" : "false") &&
               json_dyn_puts(&b, ",\"ggufDirOk\":") &&
               json_dyn_puts(&b, setup_gguf_dir_ok_path(target ? target : g_ds4_dir) ? "true" : "false") &&
               json_dyn_puts(&b, ",\"downloaded\":") &&
               json_dyn_puts(&b, downloaded ? "true" : "false") &&
               json_dyn_puts(&b, ",\"built\":") &&
               json_dyn_puts(&b, built ? "true" : "false") &&
               json_dyn_puts(&b, ",\"jsonlPrepared\":") &&
               json_dyn_puts(&b, jsonl_prepared ? "true" : "false") &&
               json_dyn_puts(&b, ",\"designPrepared\":") &&
               json_dyn_puts(&b, design_prepared ? "true" : "false") &&
               json_dyn_puts(&b, ",\"wasRunning\":") &&
               json_dyn_puts(&b, was_running ? "true" : "false") &&
               json_dyn_puts(&b, ",\"restarted\":") &&
               json_dyn_puts(&b, restarted ? "true" : "false") &&
               json_dyn_puts(&b, ",\"mode\":") &&
               json_dyn_put_escaped(&b, mode ? mode : mode_name(g_mode)) &&
               json_dyn_puts(&b, ",\"error\":") &&
               json_dyn_put_escaped(&b, error ? error : "") &&
               json_dyn_puts(&b, "}");
    if (!good) {
        free(b.ptr);
        send_json(fd, "500 Internal Server Error", "{\"ok\":false,\"error\":\"out of memory\"}");
        return;
    }
    send_json(fd, status, b.ptr);
    free(b.ptr);
}

/* POST /api/ds4/setup — managed first-run path. Downloads antirez/ds4 at the
 * pinned commit into this DStudio checkout as ./ds4, builds upstream, then applies the external patch
 * sets from patch/. Every step returns a concrete error instead of leaving the
 * onboarding path field in a silent-fail state. */
static void api_setup_ds4(int fd) {
    resolve_web_dir();
    g_active_setup_task = task_begin("setup", "Install ds4", "ds4", g_mode, g_ds4_dir, 0, 0);
    task_mark_working(g_active_setup_task, "preparing ds4 setup");
#ifndef _WIN32
    if (!web_dir_valid()) {
        setup_send_json(fd, "409 Conflict", 0, g_ds4_dir, 0, 0, 0, 0, 0, 0, mode_name(g_mode),
                        "DStudio checkout not found; cannot locate patch/ and extension/ to prepare ds4");
        return;
    }
#endif

    char target[DSTUDIO_PATH_MAX];
    if (!default_ds4_dir(target, sizeof target)) {
        setup_send_json(fd, "500 Internal Server Error", 0, g_ds4_dir, 0, 0, 0, 0, 0, 0, mode_name(g_mode),
                        "default ds4 path is too long");
        return;
    }

    struct stat st;
    int exists = stat(target, &st) == 0;
    if (exists && !S_ISDIR(st.st_mode)) {
        setup_send_json(fd, "409 Conflict", 0, target, 0, 0, 0, 0, 0, 0, mode_name(g_mode),
                        "DStudio/ds4 exists but is not a folder");
        return;
    }

    int downloaded = 0;
    char log_tail[8192] = "";
    if (!exists || !ds4_dir_valid_path(target)) {
        int can_download = !exists;
        if (exists) {
            int empty = 0;
            if (!setup_dir_empty(target, &empty)) {
                setup_send_json(fd, "409 Conflict", 0, target, 0, 0, 0, 0, 0, 0, mode_name(g_mode),
                                "DStudio/ds4 exists but could not be inspected");
                return;
            }
            can_download = empty;
        }
        if (!can_download) {
            setup_send_json(fd, "409 Conflict", 0, target, 0, 0, 0, 0, 0, 0, mode_name(g_mode),
                            "DStudio/ds4 exists but is not a ds4 checkout; remove it and run setup again");
            return;
        }
        char err[8600];
        if (!setup_download_ds4_archive(DS4_ARCHIVE_URL, DS4_UPSTREAM_COMMIT, target,
                                        log_tail, sizeof log_tail, err, sizeof err)) {
            setup_send_json(fd, "500 Internal Server Error", 0, target, 0, 0, 0, 0, 0, 0, mode_name(g_mode), err);
            return;
        }
        downloaded = 1;
    }

    char abs[DSTUDIO_PATH_MAX];
    if (!realpath(target, abs)) {
        char err[1024];
        snprintf(err, sizeof err, "ds4 checkout path could not be resolved after download: %s", strerror(errno));
        setup_send_json(fd, "500 Internal Server Error", 0, target, downloaded, 0, 0, 0, 0, 0, mode_name(g_mode), err);
        return;
    }
    cstr_copy(g_ds4_dir, sizeof g_ds4_dir, abs);
    g_ds4_dir_explicit = 0;
    if (!ds4_dir_valid()) {
        setup_send_json(fd, "409 Conflict", 0, g_ds4_dir, downloaded, 0, 0, 0, 0, 0, mode_name(g_mode),
                        "downloaded folder does not look like a ds4 checkout");
        return;
    }
    char gguf_err[1024];
    if (!setup_ensure_gguf_dir(gguf_err, sizeof gguf_err)) {
        setup_send_json(fd, "500 Internal Server Error", 0, g_ds4_dir, downloaded, 0, 0, 0, 0, 0,
                        mode_name(g_mode), gguf_err);
        return;
    }

    reap_child();
    int        prev_mode = g_mode;
    engine_cfg prev_cfg  = g_cfg;
    char       prev_wd[1024];
    snprintf(prev_wd, sizeof prev_wd, "%s", g_workdir);
    int was_running = (g_child > 0) || (prev_mode != ENGINE_NONE);
    if (g_child > 0) stop_child();
    kill_external_server(ENGINE_DEFAULTS.port);

#ifdef _WIN32
    char build_err[8600];
    if (!setup_prepare_ds4_windows(log_tail, sizeof log_tail, build_err, sizeof build_err)) {
        setup_send_json(fd, "500 Internal Server Error", 0, g_ds4_dir, downloaded, 0, 0, 0,
                        was_running, 0, mode_name(prev_mode), build_err);
        return;
    }
#else
    char *make_argv[] = { "make", "-C", g_ds4_dir, NULL };
    int rc = setup_run_cmd_capture(NULL, make_argv, log_tail, sizeof log_tail);
    if (rc != 0) {
        char err[8600];
        snprintf(err, sizeof err, "ds4 make failed (exit %d). Output: %.7800s",
                 rc, log_tail[0] ? log_tail : "(no output)");
        setup_send_json(fd, "500 Internal Server Error", 0, g_ds4_dir, downloaded, 0, 0, 0,
                        was_running, 0, mode_name(prev_mode), err);
        return;
    }
#endif

    if (!run_build_jsonl("build")) {
        char err[1024];
        snprintf(err, sizeof err, "%s", g_engine_err[0] ? g_engine_err : "JSONL patch/build failed");
        setup_send_json(fd, "500 Internal Server Error", 0, g_ds4_dir, downloaded, 1, 0, 0,
                        was_running, 0, mode_name(prev_mode), err);
        return;
    }

    int design_prepared = run_ext_script("extension/design/build-design.sh", "build");
    if (!design_prepared) {
        setup_send_json(fd, "500 Internal Server Error", 0, g_ds4_dir, downloaded, 1, 1, 0,
                        was_running, 0, mode_name(prev_mode),
                        "ds4 was downloaded and the agent patch built, but the design runtime build failed");
        return;
    }

    int restarted = 0;
    char restart_err[256] = "";
    if (was_running) {
        int ok = prev_mode == ENGINE_AGENT  ? spawn_agent(&prev_cfg, prev_wd, restart_err, sizeof restart_err)
               : prev_mode == ENGINE_DESIGN ? spawn_design(&prev_cfg, prev_wd, restart_err, sizeof restart_err)
                                            : spawn_server(&prev_cfg, restart_err, sizeof restart_err);
        restarted = ok ? 1 : 0;
    }

    setup_send_json(fd, "200 OK", 1, g_ds4_dir, downloaded, 1, 1, design_prepared,
                    was_running, restarted, mode_name(g_mode), restart_err);
}

/* ---- Optional GLM 5.2 engine checkout (ds4 branch glm5.2) ---- */

static int glm_dir_path(char *out, size_t outsz) {
    if (!g_web_dir[0]) return 0;
    int n = snprintf(out, outsz, "%s/%s", g_web_dir, DS4_GLM_DIR_NAME);
    return n > 0 && (size_t)n < outsz;
}

/* True when the local Metal model-view fix from patch/ds4-glm52/ is present in
 * the checkout (the patch adds a DS4_GLM_PATCH_MARK marker comment). */
static int glm_patch_applied(const char *dir) {
    char src[DSTUDIO_PATH_MAX + 32];
    snprintf(src, sizeof src, "%s/ds4_metal.m", dir);
    size_t n = 0;
    char *body = jsonl_read_file(src, &n);
    if (!body) return 0;
    int found = strstr(body, DS4_GLM_PATCH_MARK) != NULL;
    free(body);
    return found;
}

/* Fully usable: looks like a ds4 checkout, server binary built, patch applied. */
static int glm_checkout_ready(const char *dir) {
    return ds4_dir_valid_path(dir) &&
           (file_present_in_dir(dir, "ds4-server") || file_present_in_dir(dir, "ds4-server.exe")) &&
           glm_patch_applied(dir);
}

static void glm_send_json(int fd, const char *status, int ok, unsigned long long task_id,
                          const char *dir, int downloaded, int patched, int built,
                          const char *error) {
    if (task_id) {
        if (ok) task_mark_completed(task_id, "GLM engine setup completed");
        else task_mark_failed(task_id, error && error[0] ? error : "GLM engine setup failed",
                              dir ? dir : "");
    }
    json_dyn_buf b = {0};
    int good = json_dyn_puts(&b, "{\"ok\":") &&
               json_dyn_puts(&b, ok ? "true" : "false") &&
               json_dyn_printf(&b, ",\"taskId\":%llu", task_id) &&
               json_dyn_puts(&b, ",\"commit\":") &&
               json_dyn_put_escaped(&b, DS4_GLM_UPSTREAM_COMMIT) &&
               json_dyn_puts(&b, ",\"dir\":") &&
               json_dyn_put_escaped(&b, dir ? dir : "") &&
               json_dyn_printf(&b, ",\"downloaded\":%s,\"patched\":%s,\"built\":%s",
                               downloaded ? "true" : "false",
                               patched ? "true" : "false",
                               built ? "true" : "false") &&
               json_dyn_puts(&b, ",\"error\":") &&
               json_dyn_put_escaped(&b, error ? error : "") &&
               json_dyn_puts(&b, "}");
    if (!good) {
        free(b.ptr);
        send_json(fd, "500 Internal Server Error", "{\"ok\":false,\"error\":\"out of memory\"}");
        return;
    }
    send_json(fd, status, b.ptr);
    free(b.ptr);
}

/* POST /api/glm/setup — optional second engine: downloads antirez/ds4 at the
 * pinned glm5.2 commit into ./ds4-glm52 (curl + tar, no git), applies the local
 * Metal model-view fix from patch/ds4-glm52/ (the fix is never vendored into
 * the checkout sources in git — it is re-applied on every fresh install), and
 * builds. The running engine is left alone: swapping to the GLM checkout
 * happens from the model menu's Engine-branch section. */
static void api_setup_glm(int fd) {
#ifdef _WIN32
    send_json(fd, "409 Conflict",
              "{\"ok\":false,\"error\":\"the GLM engine checkout is not supported on the Windows portable build yet\"}");
#else
    resolve_web_dir();
    if (!web_dir_valid()) {
        glm_send_json(fd, "409 Conflict", 0, 0, "", 0, 0, 0,
                      "DStudio checkout not found; cannot locate patch/ds4-glm52");
        return;
    }
    char target[DSTUDIO_PATH_MAX];
    if (!glm_dir_path(target, sizeof target)) {
        glm_send_json(fd, "500 Internal Server Error", 0, 0, "", 0, 0, 0,
                      "GLM checkout path is too long");
        return;
    }
    unsigned long long task_id = task_begin("setup", "Install GLM engine", "glm",
                                            g_mode, target, 0, 1);
    task_mark_working(task_id, "preparing the GLM engine checkout");

    char log_tail[8192] = "";
    int downloaded = 0;
    struct stat st;
    int exists = stat(target, &st) == 0;
    if (exists && !S_ISDIR(st.st_mode)) {
        glm_send_json(fd, "409 Conflict", 0, task_id, target, 0, 0, 0,
                      "DStudio/ds4-glm52 exists but is not a folder");
        return;
    }
    if (!exists || !ds4_dir_valid_path(target)) {
        int can_download = !exists;
        if (exists) {
            int empty = 0;
            if (!setup_dir_empty(target, &empty)) {
                glm_send_json(fd, "409 Conflict", 0, task_id, target, 0, 0, 0,
                              "DStudio/ds4-glm52 exists but could not be inspected");
                return;
            }
            can_download = empty;
        }
        if (!can_download) {
            glm_send_json(fd, "409 Conflict", 0, task_id, target, 0, 0, 0,
                          "DStudio/ds4-glm52 exists but is not a ds4 checkout; remove it and run setup again");
            return;
        }
        char err[8600];
        if (!setup_download_ds4_archive(DS4_GLM_ARCHIVE_URL, DS4_GLM_UPSTREAM_COMMIT, target,
                                        log_tail, sizeof log_tail, err, sizeof err)) {
            glm_send_json(fd, "500 Internal Server Error", 0, task_id, target, 0, 0, 0, err);
            return;
        }
        downloaded = 1;
    }

    int patched = glm_patch_applied(target);
    if (!patched) {
        char patch_file[DSTUDIO_PATH_MAX + 64];
        snprintf(patch_file, sizeof patch_file, "%s/%s", g_web_dir, DS4_GLM_METAL_PATCH);
        char *patch_argv[] = { "patch", "-p1", "-N", "-d", target, "-i", patch_file, NULL };
        int rc = setup_run_cmd_capture(NULL, patch_argv, log_tail, sizeof log_tail);
        if (rc != 0 || !glm_patch_applied(target)) {
            char err[8600];
            snprintf(err, sizeof err,
                     "GLM metal patch failed (exit %d). DStudio setup needs curl, tar and patch. Output: %.7700s",
                     rc, log_tail[0] ? log_tail : "(no output)");
            glm_send_json(fd, "500 Internal Server Error", 0, task_id, target, downloaded, 0, 0, err);
            return;
        }
        patched = 1;
    }

    task_mark_working(task_id, "building the GLM engine (make)");
    char *make_argv[] = { "make", "-C", target, NULL };
    int rc = setup_run_cmd_capture(NULL, make_argv, log_tail, sizeof log_tail);
    if (rc != 0) {
        char err[8600];
        snprintf(err, sizeof err, "GLM engine make failed (exit %d). Output: %.7800s",
                 rc, log_tail[0] ? log_tail : "(no output)");
        glm_send_json(fd, "500 Internal Server Error", 0, task_id, target, downloaded, patched, 0, err);
        return;
    }

    printf("glm: engine checkout ready at %s (commit %.12s)\n", target, DS4_GLM_UPSTREAM_COMMIT);
    glm_send_json(fd, "200 OK", 1, task_id, target, downloaded, patched, 1, "");
#endif
}

static int update_count_marker_dirs(const char *rel, const char *marker, const char *contains) {
    char base[DSTUDIO_PATH_MAX + 256];
    if (g_web_dir[0]) snprintf(base, sizeof base, "%s/%s", g_web_dir, rel);
    else snprintf(base, sizeof base, "%s", rel);
    DIR *d = opendir(base);
    if (!d) return -1;
    int count = 0;
    struct dirent *e;
    while ((e = readdir(d))) {
        if (!strcmp(e->d_name, ".") || !strcmp(e->d_name, "..")) continue;
        char path[DSTUDIO_PATH_MAX + 512];
        snprintf(path, sizeof path, "%s/%s/%s", base, e->d_name, marker);
        struct stat st;
        if (stat(path, &st) != 0 || !S_ISREG(st.st_mode)) continue;
        if (contains && contains[0]) {
            size_t n = 0;
            char *content = jsonl_read_file(path, &n);
            int hit = content && strstr(content, contains);
            free(content);
            if (!hit) continue;
        }
        count++;
    }
    closedir(d);
    return count;
}

static int update_patch_anchor_failures(void) {
    if (!ds4_dir_valid()) return 99;
    char src[2200], web_src[2200];
    snprintf(src, sizeof src, "%s/ds4_agent.c", g_ds4_dir);
    snprintf(web_src, sizeof web_src, "%s/ds4_web.c", g_ds4_dir);
    return jsonl_check_anchors(src) + web_cdp_check_anchors(web_src);
}

static int updates_add_section(json_dyn_buf *b, int *first, const char *id,
                               const char *label, const char *state,
                               const char *detail, const char *action) {
    int ok = json_dyn_puts(b, *first ? "" : ",") &&
             json_dyn_puts(b, "{\"id\":") &&
             json_dyn_put_escaped(b, id) &&
             json_dyn_puts(b, ",\"label\":") &&
             json_dyn_put_escaped(b, label) &&
             json_dyn_puts(b, ",\"state\":") &&
             json_dyn_put_escaped(b, state) &&
             json_dyn_puts(b, ",\"detail\":") &&
             json_dyn_put_escaped(b, detail ? detail : "") &&
             json_dyn_puts(b, ",\"action\":");
    ok = ok && (action ? json_dyn_put_escaped(b, action) : json_dyn_puts(b, "null"));
    ok = ok && json_dyn_puts(b, "}");
    if (ok) *first = 0;
    return ok;
}

static int updates_ds4_managed_dirty_path(const char *path) {
    if (!path || !path[0]) return 0;
    return !strcmp(path, "ds4-agent-jsonl") ||
           !strcmp(path, "ds4-agent-jsonl.ver") ||
           !strcmp(path, "ds4-design") ||
           !strcmp(path, "ds4-design.exe") ||
           !strcmp(path, "ds4_agent.c.ds4ui.bak");
}

static int updates_ds4_dirty_is_only_managed(const char *dirty, int *managed_count) {
    if (managed_count) *managed_count = 0;
    if (!dirty || !dirty[0]) return 0;
    char buf[4096];
    cstr_copy(buf, sizeof buf, dirty);
    int count = 0;
    for (char *line = strtok(buf, "\n"); line; line = strtok(NULL, "\n")) {
        while (*line == '\r' || *line == '\n') line++;
        if (!line[0]) continue;
        if (strncmp(line, "?? ", 3) != 0) return 0;
        char *path = line + 3;
        while (*path == ' ') path++;
        if (!updates_ds4_managed_dirty_path(path)) return 0;
        count++;
    }
    if (managed_count) *managed_count = count;
    return count > 0;
}

static void updates_trim_line(char *s) {
    if (!s) return;
    char *p = s;
    while (*p && isspace((unsigned char)*p)) p++;
    if (p != s) memmove(s, p, strlen(p) + 1);
    size_t n = strlen(s);
    while (n && isspace((unsigned char)s[n - 1])) s[--n] = '\0';
}

static int updates_git_capture_trim(char *const argv[], char *out, size_t outsz) {
    int rc = setup_run_cmd_capture(NULL, argv, out, outsz);
    updates_trim_line(out);
    return rc;
}

static void updates_append_detail(char *dst, size_t dstsz, const char *fmt, ...) {
    if (!dst || !dstsz) return;
    size_t used = strlen(dst);
    if (used >= dstsz - 1) return;
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(dst + used, dstsz - used, fmt, ap);
    va_end(ap);
}

typedef struct {
    int sources;
    int stale;
    int failed;
    char detail[900];
} update_skill_sources_status;

static int updates_commit_same(const char *a, const char *b) {
    if (!a || !b || !a[0] || !b[0]) return 0;
    size_t an = strlen(a), bn = strlen(b);
    size_t n = an < bn ? an : bn;
    if (n < 7) return 0;
    return !strncmp(a, b, n);
}

static int updates_skill_source_remote_head(const char *repo, const char *ref, char *out, size_t outsz) {
    char refspec[256];
    if (!ref || !ref[0] || !strcmp(ref, "HEAD")) snprintf(refspec, sizeof refspec, "HEAD");
    else if (!strncmp(ref, "refs/", 5)) snprintf(refspec, sizeof refspec, "%s", ref);
    else snprintf(refspec, sizeof refspec, "refs/heads/%s", ref);
    char raw[1024] = "";
    char *argv[] = { "git", "ls-remote", (char *)repo, refspec, NULL };
    int rc = updates_git_capture_trim(argv, raw, sizeof raw);
    if (rc != 0 || !raw[0]) {
        if (out && outsz) out[0] = '\0';
        return 0;
    }
    char *p = raw;
    while (*p && !isspace((unsigned char)*p)) p++;
    *p = '\0';
    cstr_copy(out, outsz, raw);
    return out && out[0];
}

static void updates_skill_sources_status(update_skill_sources_status *st) {
    memset(st, 0, sizeof *st);
    char manifest[DSTUDIO_PATH_MAX + 256];
    if (g_web_dir[0]) snprintf(manifest, sizeof manifest, "%s/extension/skills/sources.tsv", g_web_dir);
    else snprintf(manifest, sizeof manifest, "extension/skills/sources.tsv");
    FILE *f = fopen(manifest, "r");
    if (!f) {
        st->failed = 1;
        snprintf(st->detail, sizeof st->detail, "No imported skill source manifest found.");
        return;
    }
    char line[2048];
    while (fgets(line, sizeof line, f)) {
        updates_trim_line(line);
        if (!line[0] || line[0] == '#') continue;
        char *cols[8] = {0};
        int n = 0;
        for (char *tok = strtok(line, "\t"); tok && n < 8; tok = strtok(NULL, "\t")) cols[n++] = tok;
        if (n < 6) {
            st->failed++;
            updates_append_detail(st->detail, sizeof st->detail, "Bad source row. ");
            continue;
        }
        const char *id = cols[0], *repo = cols[1], *ref = cols[2], *imported = cols[3];
        const char *kind = n >= 7 && cols[6] ? cols[6] : "skills-dir";
        char remote[96] = "";
        st->sources++;
        if (!updates_skill_source_remote_head(repo, ref, remote, sizeof remote)) {
            st->failed++;
            updates_append_detail(st->detail, sizeof st->detail, "%s remote could not be checked. ", id);
            continue;
        }
        if (!updates_commit_same(imported, remote)) {
            st->stale++;
            if (!strcmp(kind, "verify-only"))
                updates_append_detail(st->detail, sizeof st->detail, "%s adapted source outdated %.*s -> %.*s; manual re-import required. ",
                                      id, 12, imported, 12, remote);
            else
                updates_append_detail(st->detail, sizeof st->detail, "%s outdated %.*s -> %.*s; run Update / verify selected. ",
                                      id, 12, imported, 12, remote);
        }
    }
    fclose(f);
}

static int updates_ds4_git_upstream(char *upstream, size_t upstreamsz) {
    if (upstream && upstreamsz) upstream[0] = '\0';
    char *up_argv[] = { "git", "-C", g_ds4_dir, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}", NULL };
    if (updates_git_capture_trim(up_argv, upstream, upstreamsz) == 0 && upstream && upstream[0]) return 1;
    char verify[256] = "";
    char *verify_argv[] = { "git", "-C", g_ds4_dir, "rev-parse", "--verify", "--quiet", "origin/main", NULL };
    if (updates_git_capture_trim(verify_argv, verify, sizeof verify) == 0 && verify[0]) {
        cstr_copy(upstream, upstreamsz, "origin/main");
        return 1;
    }
    return 0;
}

static int updates_sections_json(json_dyn_buf *b) {
    resolve_web_dir();
    int first = 1;
    if (!json_dyn_puts(b, "\"sections\":[")) return 0;

    int nuclei_ready = gsa_nuclei_templates_found();
    int gsa_tools_found = 0, gsa_tools_total = 0;
    char gsa_missing[512] = "";
    int gsa_catalog_ok = gsa_tool_catalog_status(&gsa_tools_found, &gsa_tools_total, gsa_missing, sizeof gsa_missing);
    char gsa_detail[512];
    if (!gsa_catalog_ok) {
        snprintf(gsa_detail, sizeof gsa_detail,
                 "GSA tool catalog could not be loaded; tool readiness is not verified.");
    } else if (gsa_tools_found != gsa_tools_total) {
        snprintf(gsa_detail, sizeof gsa_detail,
                 "GSA catalog %d/%d tools ready; missing: %s. Nuclei templates %s under NUCLEI_TEMPLATES_DIR.",
                 gsa_tools_found, gsa_tools_total, gsa_missing[0] ? gsa_missing : "unknown",
                 nuclei_ready ? "found" : "missing");
    } else {
        snprintf(gsa_detail, sizeof gsa_detail,
                 "GSA catalog %d/%d tools ready; nuclei templates %s under NUCLEI_TEMPLATES_DIR.",
                 gsa_tools_found, gsa_tools_total,
                 nuclei_ready ? "found" : "missing");
    }
    if (!updates_add_section(b, &first, "gsa-tools", "GSA tools/templates",
                             (gsa_catalog_ok && gsa_tools_found == gsa_tools_total && nuclei_ready) ? "ok" : "warn",
                             gsa_detail, "gsa-tools")) return 0;

    int ds4_git = ds4_dir_valid() && file_present_in_dir(g_ds4_dir, ".git/HEAD");
    char head[256] = "", dirty[4096] = "", fetch_log[4096] = "";
    char upstream[256] = "", remote_head[256] = "", counts[128] = "";
    char *rev_argv[] = { "git", "-C", g_ds4_dir, "rev-parse", "--short", "HEAD", NULL };
    char *dirty_argv[] = { "git", "-C", g_ds4_dir, "status", "--porcelain", NULL };
    if (ds4_git) updates_git_capture_trim(rev_argv, head, sizeof head);
    if (ds4_git) setup_run_cmd_capture(NULL, dirty_argv, dirty, sizeof dirty);
    int managed_dirty_count = 0;
    int managed_dirty = ds4_git && dirty[0] && updates_ds4_dirty_is_only_managed(dirty, &managed_dirty_count);
    int fetch_rc = -1;
    int upstream_ok = 0;
    int ahead = -1, behind = -1;
    if (ds4_git) {
        char *fetch_argv[] = { "git", "-C", g_ds4_dir, "fetch", "origin", "--prune", NULL };
        fetch_rc = setup_run_cmd_capture(NULL, fetch_argv, fetch_log, sizeof fetch_log);
        updates_trim_line(fetch_log);
        if (fetch_rc == 0) {
            upstream_ok = updates_ds4_git_upstream(upstream, sizeof upstream);
            if (upstream_ok) {
                char *remote_argv[] = { "git", "-C", g_ds4_dir, "rev-parse", "--short", upstream, NULL };
                updates_git_capture_trim(remote_argv, remote_head, sizeof remote_head);
                char range[320];
                snprintf(range, sizeof range, "HEAD...%s", upstream);
                char *count_argv[] = { "git", "-C", g_ds4_dir, "rev-list", "--left-right", "--count", range, NULL };
                if (updates_git_capture_trim(count_argv, counts, sizeof counts) == 0) {
                    sscanf(counts, "%d%*[ \t]%d", &ahead, &behind);
                }
            }
        }
    }
    char ds4_detail[900];
    const char *ds4_state = "ok";
    if (!ds4_git) {
        ds4_state = "warn";
        snprintf(ds4_detail, sizeof ds4_detail,
                 "ds4 is not a git checkout; latest update requires git-managed ds4.");
    } else if (fetch_rc != 0) {
        ds4_state = "warn";
        snprintf(ds4_detail, sizeof ds4_detail,
                 "Could not fetch origin, so latest status is not verified. Local HEAD %s. Output: %.520s",
                 head, fetch_log[0] ? fetch_log : "(no output)");
    } else if (!upstream_ok || ahead < 0 || behind < 0) {
        ds4_state = "warn";
        snprintf(ds4_detail, sizeof ds4_detail,
                 "Fetched origin, but could not determine upstream comparison for local HEAD %s. Set ds4 branch upstream to origin/main.",
                 head);
    } else if (behind > 0 && ahead > 0) {
        ds4_state = "warn";
        snprintf(ds4_detail, sizeof ds4_detail,
                 "Fetched origin; local %s and %s %s diverged (%d local commit(s), %d upstream commit(s)). Resolve before updating.",
                 head, upstream, remote_head[0] ? remote_head : "remote", ahead, behind);
    } else if (behind > 0) {
        ds4_state = "warn";
        snprintf(ds4_detail, sizeof ds4_detail,
                 "Fetched origin; local %s is %d commit(s) behind %s %s. Run Update selected to pull/build/verify patches.%s%s",
                 head, behind, upstream, remote_head[0] ? remote_head : "",
                 (dirty[0] && managed_dirty) ? " " : "",
                 (dirty[0] && managed_dirty) ? "DStudio generated artifacts are present and safe to regenerate." : "");
    } else if (ahead > 0) {
        ds4_state = "warn";
        snprintf(ds4_detail, sizeof ds4_detail,
                 "Fetched origin; local %s is %d commit(s) ahead of %s %s. Latest cannot be verified as a clean upstream checkout.",
                 head, ahead, upstream, remote_head[0] ? remote_head : "");
    } else if (dirty[0] && managed_dirty) {
        snprintf(ds4_detail, sizeof ds4_detail,
                 "Fetched origin; local %s matches %s %s; %d DStudio generated artifact(s) present and safe to regenerate.",
                 head, upstream, remote_head[0] ? remote_head : "", managed_dirty_count);
    } else {
        if (dirty[0]) ds4_state = "warn";
        snprintf(ds4_detail, sizeof ds4_detail, "Fetched origin; local %s matches %s %s%s",
                 head, upstream, remote_head[0] ? remote_head : "",
                 dirty[0] ? " (dirty worktree: pull may fail until local changes are resolved)" : "");
    }
    if (!updates_add_section(b, &first, "ds4-latest", "ds4 latest",
                             ds4_state,
                             ds4_detail, "ds4-latest")) return 0;

    int anchor_fails = update_patch_anchor_failures();
    char patch_detail[512];
    snprintf(patch_detail, sizeof patch_detail,
             anchor_fails == 0 ? "JSONL and web patch anchors match current ds4 source." :
             "Patch anchors have %d failure(s); structured agent/design gate must be repaired before relying on latest ds4.",
             anchor_fails);
    if (!updates_add_section(b, &first, "patch-verify", "Patch gate",
                             anchor_fails == 0 ? "ok" : "error",
                             patch_detail, "patch-verify")) return 0;

    int skills = update_count_marker_dirs("extension/skills", "SKILL.md", NULL);
    int cyber = update_count_marker_dirs("extension/gsa/third_party/anthropic-cybersecurity-skills/skills", "SKILL.md", NULL);
    update_skill_sources_status skill_sources;
    updates_skill_sources_status(&skill_sources);
    char skills_detail[1200];
    snprintf(skills_detail, sizeof skills_detail,
             "%d local skills and %d cybersecurity skills detected. Repo sources: %s",
             skills < 0 ? 0 : skills, cyber < 0 ? 0 : cyber,
             skill_sources.sources <= 0 ? "none configured." :
             (skill_sources.stale || skill_sources.failed ? skill_sources.detail : "all current."));
    if (!updates_add_section(b, &first, "skills", "Imported skills",
                             (skills > 0 && cyber > 0 && skill_sources.failed == 0 && skill_sources.stale == 0) ? "ok" : "warn",
                             skills_detail, "skills")) return 0;

    int open_skills = update_count_marker_dirs("extension/skills", "SKILL.md", "open-design/");
    int design_systems = update_count_marker_dirs("extension/design-systems", "DESIGN.md", "open-design/");
    char design_detail[512];
    snprintf(design_detail, sizeof design_detail,
             "%d Open Design skill templates and %d design systems detected.",
             open_skills < 0 ? 0 : open_skills, design_systems < 0 ? 0 : design_systems);
    if (!updates_add_section(b, &first, "open-design", "Open Design",
                             (open_skills > 0 && design_systems > 0) ? "ok" : "warn",
                             design_detail, "open-design")) return 0;

    return json_dyn_puts(b, "]");
}

static void api_updates_check(int fd) {
    json_dyn_buf b = {0};
    int ok = json_dyn_puts(&b, "{\"ok\":true,") &&
             updates_sections_json(&b) &&
             json_dyn_puts(&b, "}");
    if (!ok) {
        free(b.ptr);
        send_json(fd, "500 Internal Server Error", "{\"ok\":false,\"error\":\"updates check memory\"}");
        return;
    }
    send_json(fd, "200 OK", b.ptr);
    free(b.ptr);
}

static int update_body_has_task(const char *body, const char *task) {
    if (!body || !body[0]) return 0;
    return strstr(body, "\"all\"") || strstr(body, task);
}

static int update_run_cmd(unsigned long long task_id, const char *label,
                          const char *cwd, char *const argv[],
                          char *log_tail, size_t logsz, char *err, size_t errsz) {
    task_mark_working(task_id, label);
    int rc = setup_run_cmd_capture(cwd, argv, log_tail, logsz);
    if (rc != 0) {
        snprintf(err, errsz, "%s failed (exit %d). Output: %.7000s",
                 label, rc, log_tail && log_tail[0] ? log_tail : "(no output)");
        return 0;
    }
    return 1;
}

static int updates_run_gsa_tools(unsigned long long task_id, char *log_tail, size_t logsz,
                                 char *err, size_t errsz) {
    char bin[1200], sh_path[1400] = "", ps_path[1400] = "";
    gsa_tools_dir(bin, sizeof bin);
    mkpath(bin);
    if (!gsa_write_install_scripts(bin, sh_path, sizeof sh_path, ps_path, sizeof ps_path, err, errsz))
        return 0;
#ifdef _WIN32
    char *argv[] = { "powershell", "-ExecutionPolicy", "Bypass", "-File", ps_path, NULL };
    return update_run_cmd(task_id, "updating GSA managed tools/templates", NULL, argv, log_tail, logsz, err, errsz);
#else
    char *argv[] = { "sh", sh_path, NULL };
    return update_run_cmd(task_id, "updating GSA managed tools/templates", NULL, argv, log_tail, logsz, err, errsz);
#endif
}

static int updates_run_patch_verify(unsigned long long task_id, char *err, size_t errsz) {
    task_mark_working(task_id, "checking DStudio patch anchors");
    int anchor_fails = update_patch_anchor_failures();
    if (anchor_fails != 0) {
        snprintf(err, errsz, "DStudio patch anchors failed (%d failure(s)); latest ds4 is not accepted", anchor_fails);
        return 0;
    }
    task_mark_working(task_id, "building structured agent patch");
    if (!run_build_jsonl("build")) {
        snprintf(err, errsz, "%s", g_engine_err[0] ? g_engine_err : "JSONL patch/build failed");
        return 0;
    }
    task_mark_working(task_id, "building design runtime");
    if (!run_ext_script("extension/design/build-design.sh", "build")) {
        snprintf(err, errsz, "design runtime build failed after patch verification");
        return 0;
    }
    return 1;
}

static int updates_run_ds4_latest(unsigned long long task_id, char *log_tail, size_t logsz,
                                  char *err, size_t errsz) {
    if (!ds4_dir_valid()) {
        snprintf(err, errsz, "ds4 folder is not valid; install ds4 before updating latest");
        return 0;
    }
    if (!file_present_in_dir(g_ds4_dir, ".git/HEAD")) {
        snprintf(err, errsz, "ds4 is not a git checkout; latest mode requires a git-managed ds4 directory");
        return 0;
    }
    char dirty[4096] = "";
    char *dirty_argv[] = { "git", "-C", g_ds4_dir, "status", "--porcelain", NULL };
    setup_run_cmd_capture(NULL, dirty_argv, dirty, sizeof dirty);
    if (dirty[0] && !updates_ds4_dirty_is_only_managed(dirty, NULL)) {
        snprintf(err, errsz,
                 "ds4 worktree has non-DStudio local changes; stash or resolve them before pulling latest. Status: %.7000s",
                 dirty);
        return 0;
    }
    char *fetch_argv[] = { "git", "-C", g_ds4_dir, "fetch", "origin", NULL };
    if (!update_run_cmd(task_id, "fetching ds4 upstream", NULL, fetch_argv, log_tail, logsz, err, errsz)) return 0;
    char *pull_argv[] = { "git", "-C", g_ds4_dir, "pull", "--ff-only", NULL };
    if (!update_run_cmd(task_id, "pulling ds4 latest --ff-only", NULL, pull_argv, log_tail, logsz, err, errsz)) return 0;
    char *make_argv[] = { "make", "-C", g_ds4_dir, NULL };
    if (!update_run_cmd(task_id, "building ds4 latest", NULL, make_argv, log_tail, logsz, err, errsz)) return 0;
    return updates_run_patch_verify(task_id, err, errsz);
}

static int updates_verify_skills(unsigned long long task_id, char *err, size_t errsz) {
    task_mark_working(task_id, "verifying imported skills");
    int skills = update_count_marker_dirs("extension/skills", "SKILL.md", NULL);
    int cyber = update_count_marker_dirs("extension/gsa/third_party/anthropic-cybersecurity-skills/skills", "SKILL.md", NULL);
    if (skills <= 0 || cyber <= 0) {
        snprintf(err, errsz, "imported skills are incomplete: local=%d cyber=%d", skills, cyber);
        return 0;
    }
    return 1;
}

static int updates_run_imported_skills(unsigned long long task_id, char *log_tail, size_t logsz,
                                       char *err, size_t errsz) {
    char script[DSTUDIO_PATH_MAX + 256];
    if (g_web_dir[0]) snprintf(script, sizeof script, "%s/scripts/sync-skill-sources.mjs", g_web_dir);
    else snprintf(script, sizeof script, "scripts/sync-skill-sources.mjs");
    struct stat st;
    if (stat(script, &st) != 0 || !S_ISREG(st.st_mode)) {
        snprintf(err, errsz, "imported skill source updater is missing: %s", script);
        return 0;
    }
    /* Resolve node to an absolute path: when DStudio is launched from the GUI
     * the server inherits a minimal PATH that omits Homebrew, so a bare "node"
     * exec fails with exit 127. */
    char node_bin[PATH_MAX];
    static const char *node_dirs[] = {
        "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin",
        "/opt/local/bin", "/snap/bin", NULL
    };
    if (!resolve_program_path("node", node_dirs, node_bin, sizeof node_bin)) {
        snprintf(err, errsz,
                 "Node.js is required to update imported skills but 'node' could not be found "
                 "on PATH or in common install locations. Install Node.js (e.g. 'brew install node') and retry.");
        return 0;
    }
    char *argv[] = { node_bin, script, "--all", NULL };
    if (!update_run_cmd(task_id, "updating imported skills from source repos", g_web_dir[0] ? g_web_dir : NULL,
                        argv, log_tail, logsz, err, errsz)) return 0;
    return updates_verify_skills(task_id, err, errsz);
}

static int updates_verify_open_design(unsigned long long task_id, char *err, size_t errsz) {
    task_mark_working(task_id, "verifying Open Design imports");
    int open_skills = update_count_marker_dirs("extension/skills", "SKILL.md", "open-design/");
    int design_systems = update_count_marker_dirs("extension/design-systems", "DESIGN.md", "open-design/");
    if (open_skills <= 0 || design_systems <= 0) {
        snprintf(err, errsz, "Open Design imports are incomplete: templates=%d designSystems=%d",
                 open_skills, design_systems);
        return 0;
    }
    return 1;
}

static void api_updates_run(int fd, const char *body) {
    unsigned long long task_id = task_begin("updates", "Run update doctor", "updates", g_mode, g_ds4_dir, 0, 0);
    char log_tail[8192] = "";
    char err[8600] = "";
    int ran = 0;
    int ok = 1;
    if (update_body_has_task(body, "gsa-tools")) {
        ran++;
        ok = updates_run_gsa_tools(task_id, log_tail, sizeof log_tail, err, sizeof err);
    }
    if (ok && update_body_has_task(body, "ds4-latest")) {
        ran++;
        ok = updates_run_ds4_latest(task_id, log_tail, sizeof log_tail, err, sizeof err);
    }
    if (ok && update_body_has_task(body, "patch-verify")) {
        ran++;
        ok = updates_run_patch_verify(task_id, err, sizeof err);
    }
    if (ok && update_body_has_task(body, "skills")) {
        ran++;
        ok = updates_run_imported_skills(task_id, log_tail, sizeof log_tail, err, sizeof err);
    }
    if (ok && update_body_has_task(body, "open-design")) {
        ran++;
        ok = updates_verify_open_design(task_id, err, sizeof err);
    }
    if (ran == 0) {
        ok = 0;
        snprintf(err, sizeof err, "no update tasks selected");
    }
    if (ok) task_mark_completed(task_id, "update doctor completed");
    else task_mark_failed(task_id, err, log_tail);

    json_dyn_buf b = {0};
    int good = json_dyn_printf(&b, "{\"ok\":%s,\"taskId\":%llu,\"ran\":%d,\"error\":",
                               ok ? "true" : "false", task_id, ran) &&
               json_dyn_put_escaped(&b, ok ? "" : err) &&
               json_dyn_puts(&b, ",\"logTail\":") &&
               json_dyn_put_escaped(&b, log_tail) &&
               json_dyn_puts(&b, ",") &&
               updates_sections_json(&b) &&
               json_dyn_puts(&b, "}");
    if (!good) {
        free(b.ptr);
        send_json(fd, "500 Internal Server Error", "{\"ok\":false,\"error\":\"updates run memory\"}");
        return;
    }
    send_json(fd, ok ? "200 OK" : "500 Internal Server Error", b.ptr);
    free(b.ptr);
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

static void serve_design_project_file(int fd, const char *name, int head_only) {
    if (!g_design_dir[0]) {
        send_text(fd, "404 Not Found", "no design workspace\n", head_only);
        return;
    }
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

/* Serve a project file: /api/design/file?name=<relative-path>. The path
 * passes the SAME validation as the agent's tool-layer; the filesystem outside
 * the workspace stays unreachable. */
static void api_design_file(int fd, const char *path, int head_only) {
    const char *q = strstr(path, "name=");
    if (!q) { send_text(fd, "400 Bad Request", "name missing\n", head_only); return; }
    q += 5;
    size_t qlen = strcspn(q, "&");
    char name[1024];
    url_decode_into(q, qlen, name, sizeof name);
    serve_design_project_file(fd, name, head_only);
}

/* Preview route with a real path: /api/design/preview/<relative-path>.
 * Iframes loaded through /file?name=... cannot resolve relative assets like
 * css/blog.css; this route preserves the directory base while keeping the same
 * workspace sandbox. */
static void api_design_preview_file(int fd, const char *path, int head_only) {
    static const char prefix[] = "/api/design/preview/";
    const char *raw = path + strlen(prefix);
    size_t n = strcspn(raw, "?");
    char name[1024];
    url_decode_into(raw, n, name, sizeof name);
    serve_design_project_file(fd, name, head_only);
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
         path_eq_clean(path, "/api/lan-health") || (lan_on && lan_web_tool_path(path)) ||
         (lan_on && (path_eq_clean(path, "/api/vision/describe") ||
                     path_eq_clean(path, "/api/pdf/thumb") || path_eq_clean(path, "/api/pdf/describe"))))) return 1;
    if (get && (remote_page_path(path) || lan_root_path(path))) return 1;
    if (get && (path_eq_clean(path, "/api/remote/status") || path_eq_clean(path, "/api/remote/chat"))) return 1;
    if (get && path_eq_clean(path, "/api/lan-health")) return 1;
    if (!strcmp(method, "POST") && path_eq_clean(path, "/api/remote/chat")) return 1;
    if (!strcmp(method, "POST") && path_eq_clean(path, "/api/lan-client/chats")) return 1;
    if (lan_on && !strcmp(method, "POST") && lan_web_tool_path(path)) return 1;
    /* Image describe for LAN clients (inline data only: the handler rejects
     * `path` sources from non-loopback peers). Setup/stop/status stay host-local. */
    if (lan_on && !strcmp(method, "POST") && path_eq_clean(path, "/api/vision/describe")) return 1;
    /* PDF preview/read for LAN clients (inline data only, same guard). */
    if (lan_on && !strcmp(method, "POST") &&
        (path_eq_clean(path, "/api/pdf/thumb") || path_eq_clean(path, "/api/pdf/describe"))) return 1;
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
    dstudio_log_event("error", "web", 0, "%s: %s", status ? status : "web error",
                      msg ? msg : "web search failed");
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
        execvp(argv[0], argv);   /* argv[0] is the program (curl for most callers, pdftoppm/pdfinfo for PDFs) */
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

/* ============================================================================
 * Vision provider (local llama.cpp sidecar).
 *
 * ds4 is text-only at every layer (engine takes token IDs only; ds4-server
 * fail-closes 400 on image content blocks). Image understanding is therefore
 * delegated to a local vision model server (llama-server + Qwen2.5-VL,
 * OpenAI-compatible) that runs as a SEPARATE sidecar process on VISION_PORT —
 * a different runtime, so it never trips ds4's single-instance lock. The exact
 * incantation lives in scripts/vision-server.sh (launch + idle watchdog) and
 * scripts/vision-setup.sh (install) so it is easy to adjust without touching
 * this C.
 *
 *   POST /api/vision/setup    — install the llama.cpp runtime (on demand);
 *                               {hf} switches the vision model (3B <-> 7B)
 *   POST /api/vision/describe — proxy {images[]|data_uri|image_b64|path,
 *                               question?} to the sidecar, return the text
 *   POST /api/vision/stop     — stop the sidecar now (it restarts on demand)
 *   GET  /api/vision/status   — install/server state, disk usage, log tail
 *
 * Both the chat preprocess path (browser) and the agent see_image tool (C) hit
 * /api/vision/describe, so the sidecar wiring lives in one place. Every
 * describe/setup touches $VISION_DIR/.last-use; the launch script's watchdog
 * stops an idle sidecar so the multi-GB model does not stay resident forever.
 * ==========================================================================*/
#define VISION_PORT 28100
/* llama-server ignores the request's "model" field (it serves the loaded GGUF),
 * so any label works. The actual model is chosen in scripts/vision-server.sh. */
#define VISION_MODEL "qwen2.5-vl"
/* Keep in sync with the HFREPO default in scripts/vision-server.sh: a model
 * pref written to $VISION_DIR/.hf (via /api/vision/setup {hf}) overrides both. */
#define VISION_HF_DEFAULT "ggml-org/Qwen2.5-VL-7B-Instruct-GGUF"
/* Multi-image describe cap: 4 images at >=1024 image tokens each still fit the
 * sidecar's default context (DSTUDIO_VISION_CTX 12288) with room to answer. */
#define VISION_MAX_IMAGES 4

#ifndef _WIN32
/* Install dir of the vision sidecar (llama-server + lockfile + prefs). Must
 * match the DSTUDIO_VISION_DIR default in scripts/vision-*.sh. */
static void vision_dir_path(char *out, size_t outsz) {
    const char *env = getenv("DSTUDIO_VISION_DIR");
    if (env && env[0]) { cstr_copy(out, outsz, env); return; }
    const char *home = getenv("HOME");
    snprintf(out, outsz, "%s/.dstudio/llama-vision", home ? home : ".");
}

/* Idle-stop stamp: scripts/vision-server.sh's watchdog shuts the sidecar down
 * when this file has not been touched for DSTUDIO_VISION_IDLE_MIN minutes.
 * Touched on every vision request so active use keeps the server alive. */
static void vision_touch_last_use(void) {
    char dir[DSTUDIO_PATH_MAX];
    vision_dir_path(dir, sizeof dir);
    char parent[DSTUDIO_PATH_MAX];
    const char *home = getenv("HOME");
    snprintf(parent, sizeof parent, "%s/.dstudio", home ? home : ".");
    (void)mkdir(parent, 0755);
    (void)mkdir(dir, 0755);
    char stamp[DSTUDIO_PATH_MAX + 16];
    snprintf(stamp, sizeof stamp, "%s/.last-use", dir);
    int fd = open(stamp, O_WRONLY | O_CREAT, 0644);
    if (fd >= 0) close(fd);
    (void)utimes(stamp, NULL);
}

/* PID of the running llama-server from the launcher's lockfile (0 = none). */
static pid_t vision_lock_pid(void) {
    char p[DSTUDIO_PATH_MAX + 16];
    vision_dir_path(p, sizeof p);
    size_t l = strlen(p);
    snprintf(p + l, sizeof p - l, "/.server.pid");
    size_t n = 0;
    char *b = jsonl_read_file(p, &n);
    if (!b) return 0;
    long pid = strtol(b, NULL, 10);
    free(b);
    return pid > 1 ? (pid_t)pid : 0;
}

/* A reboot can hand a lockfile pid to an unrelated process: never signal it
 * without checking that the pid actually runs llama-server. */
static int vision_pid_is_llama(pid_t pid) {
    if (pid <= 1 || kill(pid, 0) != 0) return 0;
    char cmd[64];
    snprintf(cmd, sizeof cmd, "ps -p %d -o comm=", (int)pid);
    FILE *f = popen(cmd, "r");
    if (!f) return 0;
    char line[512] = "";
    if (!fgets(line, sizeof line, f)) line[0] = '\0';
    pclose(f);
    return strstr(line, "llama-server") != NULL;
}

/* SIGTERM (then SIGKILL) the sidecar named by the lockfile. Returns 1 when a
 * verified llama-server was stopped. The launcher's watchdog notices the child
 * exit and removes the lockfile; unlinking here too is harmless. */
static int vision_kill_server(void) {
    pid_t pid = vision_lock_pid();
    if (!vision_pid_is_llama(pid)) return 0;
    kill(pid, SIGTERM);
    for (int i = 0; i < 20; i++) {              /* up to ~2s of polite wait */
        struct timespec ts = { 0, 100 * 1000000 };
        nanosleep(&ts, NULL);
        if (kill(pid, 0) != 0) break;
    }
    if (kill(pid, 0) == 0) kill(pid, SIGKILL);
    char p[DSTUDIO_PATH_MAX + 16];
    vision_dir_path(p, sizeof p);
    size_t l = strlen(p);
    snprintf(p + l, sizeof p - l, "/.server.pid");
    unlink(p);
    return 1;
}

/* Locate the installed llama-server under the vision dir (the release tarball
 * layout varies across llama.cpp builds, so scan a few levels). */
static int vision_scan_for_bin(const char *dir, int depth, char *out, size_t outsz) {
    if (depth > 5) return 0;
    DIR *d = opendir(dir);
    if (!d) return 0;
    struct dirent *e;
    int found = 0;
    while (!found && (e = readdir(d)) != NULL) {
        if (!strcmp(e->d_name, ".") || !strcmp(e->d_name, "..")) continue;
        char p[DSTUDIO_PATH_MAX];
        if ((size_t)snprintf(p, sizeof p, "%s/%s", dir, e->d_name) >= sizeof p) continue;
        struct stat st;
        if (stat(p, &st) != 0) continue;
        if (S_ISDIR(st.st_mode)) found = vision_scan_for_bin(p, depth + 1, out, outsz);
        else if (S_ISREG(st.st_mode) && !strcmp(e->d_name, "llama-server")) {
            cstr_copy(out, outsz, p);
            found = 1;
        }
    }
    closedir(d);
    return found;
}

/* Recursive size of a directory tree (regular files only, bounded depth) —
 * surfaces how much disk the runtime + cached model take. */
static long long vision_tree_bytes(const char *dir, int depth) {
    if (depth > 6) return 0;
    DIR *d = opendir(dir);
    if (!d) return 0;
    struct dirent *e;
    long long sum = 0;
    while ((e = readdir(d)) != NULL) {
        if (!strcmp(e->d_name, ".") || !strcmp(e->d_name, "..")) continue;
        char p[DSTUDIO_PATH_MAX];
        if ((size_t)snprintf(p, sizeof p, "%s/%s", dir, e->d_name) >= sizeof p) continue;
        struct stat st;
        if (lstat(p, &st) != 0) continue;
        if (S_ISDIR(st.st_mode)) sum += vision_tree_bytes(p, depth + 1);
        else if (S_ISREG(st.st_mode)) sum += (long long)st.st_size;
    }
    closedir(d);
    return sum;
}

/* Where llama-server's -hf downloader caches the GGUFs (not inside the vision
 * dir): $LLAMA_CACHE, else the per-OS user cache. */
static void vision_model_cache_path(char *out, size_t outsz) {
    const char *env = getenv("LLAMA_CACHE");
    if (env && env[0]) { cstr_copy(out, outsz, env); return; }
    const char *home = getenv("HOME");
    if (!home) home = ".";
#ifdef __APPLE__
    snprintf(out, outsz, "%s/Library/Caches/llama.cpp", home);
#else
    const char *xdg = getenv("XDG_CACHE_HOME");
    if (xdg && xdg[0]) snprintf(out, outsz, "%s/llama.cpp", xdg);
    else snprintf(out, outsz, "%s/.cache/llama.cpp", home);
#endif
}

/* Recent llama.cpp builds download -hf models into the Hugging Face hub cache
 * (~/.cache/huggingface/hub/models--<owner>--<repo>), NOT into LLAMA_CACHE —
 * without counting it, Settings reports "0 bytes" with multiple GB on disk. */
static long long vision_hf_hub_bytes(const char *hf) {
    if (!hf || !hf[0]) return 0;
    char id[256];
    size_t o = 0;
    /* "owner/repo:QUANT" → "owner--repo" (the :quant suffix picks a file, it is
     * not part of the hub directory name). */
    for (const char *p = hf; *p && *p != ':' && o < sizeof id - 3; p++) {
        if (*p == '/') { id[o++] = '-'; id[o++] = '-'; }
        else id[o++] = *p;
    }
    id[o] = '\0';
    char root[DSTUDIO_PATH_MAX];
    const char *hub = getenv("HF_HUB_CACHE");
    const char *hfhome = getenv("HF_HOME");
    const char *home = getenv("HOME");
    if (hub && hub[0]) cstr_copy(root, sizeof root, hub);
    else if (hfhome && hfhome[0]) snprintf(root, sizeof root, "%s/hub", hfhome);
    else snprintf(root, sizeof root, "%s/.cache/huggingface/hub", home ? home : ".");
    char dir[DSTUDIO_PATH_MAX + 300];
    snprintf(dir, sizeof dir, "%s/models--%s", root, id);
    return vision_tree_bytes(dir, 0);
}

/* Non-blocking-ish TCP connect probe: is the sidecar listening on loopback? */
static int vision_port_open(void) {
    int s = socket(AF_INET, SOCK_STREAM, 0);
    if (s < 0) return 0;
    struct sockaddr_in a;
    memset(&a, 0, sizeof a);
    a.sin_family = AF_INET;
    a.sin_port = htons(VISION_PORT);
    a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    struct timeval tv = { 1, 0 };
    (void)setsockopt(s, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof tv);
    (void)setsockopt(s, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof tv);
    int ok = connect(s, (struct sockaddr *)&a, sizeof a) == 0;
    close(s);
    return ok;
}

/* True only when the sidecar is FULLY ready: llama-server binds the port before
 * the model finishes loading and answers 503 "Loading model" meanwhile, so a bare
 * TCP check isn't enough — GET /health and require 200. */
static int vision_server_ready(void) {
    int s = socket(AF_INET, SOCK_STREAM, 0);
    if (s < 0) return 0;
    struct sockaddr_in a;
    memset(&a, 0, sizeof a);
    a.sin_family = AF_INET;
    a.sin_port = htons(VISION_PORT);
    a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    struct timeval tv = { 3, 0 };
    (void)setsockopt(s, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof tv);
    (void)setsockopt(s, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof tv);
    if (connect(s, (struct sockaddr *)&a, sizeof a) != 0) { close(s); return 0; }
    static const char *req = "GET /health HTTP/1.0\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n";
    if (write(s, req, strlen(req)) < 0) { close(s); return 0; }
    char buf[64];
    ssize_t n = read(s, buf, sizeof buf - 1);
    close(s);
    if (n <= 0) return 0;
    buf[n] = '\0';
    return strstr(buf, " 200") != NULL;   /* "HTTP/1.1 200 OK" */
}

/* Launch scripts/vision-server.sh detached (double-fork → reparents to init).
 * Callers gate on vision_port_open() first. Output → /tmp/dstudio-vision.log. */
static int vision_spawn_detached(void) {
    if (!g_web_dir[0]) return 0;
    char script[DSTUDIO_PATH_MAX + 64];
    snprintf(script, sizeof script, "%s/scripts/vision-server.sh", g_web_dir);
    struct stat stt;
    if (stat(script, &stt) != 0) return 0;
    pid_t pid = fork();
    if (pid < 0) return 0;
    if (pid == 0) {
        if (fork() > 0) _exit(0);       /* grandchild survives us, reparents to init */
        setsid();
        if (chdir(g_web_dir) != 0) _exit(127);
        child_setenv_metal();           /* Metal/MPS env for the vision runtime */
        /* Close EVERY inherited fd (the DStudio instance-lock fd, the HTTP
         * listener, engine pipes, sockets). This sidecar is long-lived and
         * detached, so any fd it kept open would outlive DStudio — in particular
         * the instance-lock fd, which would then block the next app launch. */
        for (int cfd = 3; cfd < 256; cfd++) close(cfd);
        int dn = open("/dev/null", O_RDWR);
        if (dn >= 0) { dup2(dn, STDIN_FILENO); if (dn != STDIN_FILENO) close(dn); }
        int lg = open("/tmp/dstudio-vision.log", O_WRONLY | O_CREAT | O_APPEND, 0644);
        if (lg >= 0) { dup2(lg, STDOUT_FILENO); dup2(lg, STDERR_FILENO); if (lg > STDERR_FILENO) close(lg); }
        char *argv[] = { "/bin/sh", script, NULL };
        execv("/bin/sh", argv);
        _exit(127);
    }
    waitpid(pid, NULL, 0);              /* reap the immediate child */
    return 1;
}

/* Ensure the sidecar is reachable, spawning it if needed. Bounded wait in ms
 * (first run loads/downloads the model). Runs inside the forked describe/setup
 * handler, so blocking here never stalls the main server loop. */
static int vision_ensure_server(int timeout_ms) {
    if (vision_server_ready()) return 1;
    /* Spawn only if nothing is listening yet; if the port is up but still loading
     * the model (503), don't spawn a second one — just wait for /health. */
    if (!vision_port_open()) vision_spawn_detached();
    long long deadline = web_now_ms() + (timeout_ms > 0 ? timeout_ms : 120000);
    while (web_now_ms() < deadline) {
        struct timespec ts = { 0, 500 * 1000000 };  /* 500 ms */
        nanosleep(&ts, NULL);
        if (vision_server_ready()) return 1;
    }
    return 0;
}

/* POST /api/vision/describe — proxy an image to the local vision sidecar. */
/* Minimal base64 encoder (used for the path branch: read an image file
 * server-side and inline it as a data: URI). */
static char *base64_encode(const unsigned char *data, size_t len) {
    static const char T[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    size_t olen = 4 * ((len + 2) / 3);
    char *out = malloc(olen + 1);
    if (!out) return NULL;
    size_t o = 0;
    for (size_t i = 0; i < len; i += 3) {
        unsigned int v = (unsigned int)data[i] << 16;
        if (i + 1 < len) v |= (unsigned int)data[i + 1] << 8;
        if (i + 2 < len) v |= (unsigned int)data[i + 2];
        out[o++] = T[(v >> 18) & 63];
        out[o++] = T[(v >> 12) & 63];
        out[o++] = (i + 1 < len) ? T[(v >> 6) & 63] : '=';
        out[o++] = (i + 2 < len) ? T[v & 63] : '=';
    }
    out[o] = '\0';
    return out;
}

static const char *vision_mime_for(const char *path) {
    const char *dot = strrchr(path, '.');
    if (!dot) return "image/png";
    char ext[8] = {0};
    size_t j = 0;
    for (const char *p = dot + 1; *p && j < sizeof ext - 1; p++) ext[j++] = (char)tolower((unsigned char)*p);
    if (!strcmp(ext, "jpg") || !strcmp(ext, "jpeg")) return "image/jpeg";
    if (!strcmp(ext, "webp")) return "image/webp";
    if (!strcmp(ext, "gif"))  return "image/gif";
    if (!strcmp(ext, "bmp"))  return "image/bmp";
    return "image/png";
}

/* Normalize one image source (a data: URI or bare base64) into a malloc'd
 * data: URI. */
static char *vision_data_url_from(const char *image) {
    if (!image || !image[0]) return NULL;
    char *out = NULL;
    if (strncmp(image, "data:", 5) == 0) {
        size_t need = strlen(image) + 1;
        if ((out = malloc(need))) memcpy(out, image, need);
    } else {
        size_t need = strlen(image) + 40;
        if ((out = malloc(need))) snprintf(out, need, "data:image/png;base64,%s", image);
    }
    return out;
}

static void vision_free_urls(char **urls, int n) {
    for (int i = 0; i < n; i++) free(urls[i]);
}

/* Parse "images":["...", ...] from the request body — up to max entries,
 * malloc'd into out[]; returns the count (0 when the key is absent). Elements
 * are data: URIs / base64 straight from JSON.stringify, so only the basic
 * string escapes need handling. */
static int vision_parse_images(const char *body, char **out, int max) {
    const char *p = body ? strstr(body, "\"images\"") : NULL;
    while (p && p > body && p[-1] == '\\') p = strstr(p + 1, "\"images\"");
    if (!p) return 0;
    p += 8;
    while (*p == ' ' || *p == '\t' || *p == '\r' || *p == '\n') p++;
    if (*p != ':') return 0;
    p++;
    while (*p == ' ' || *p == '\t' || *p == '\r' || *p == '\n') p++;
    if (*p != '[') return 0;
    p++;
    int n = 0;
    while (n < max) {
        while (*p == ' ' || *p == '\t' || *p == '\r' || *p == '\n' || *p == ',') p++;
        if (*p != '"') break;
        p++;
        size_t cap = 4096, len = 0;
        char *s = malloc(cap);
        if (!s) break;
        int ok = 1;
        while (*p && *p != '"') {
            char c = *p++;
            if (c == '\\' && *p) {
                char e = *p++;
                switch (e) {
                    case 'n': c = '\n'; break;
                    case 't': c = '\t'; break;
                    case 'r': c = '\r'; break;
                    case 'u':
                        /* data URIs never carry \u escapes; skip the 4 hex
                         * digits and emit a placeholder to stay in sync. */
                        for (int k = 0; k < 4 && *p; k++) p++;
                        c = '?';
                        break;
                    default:  c = e; break;   /* \" \\ \/ */
                }
            }
            if (len + 2 > cap) {
                cap *= 2;
                char *ns = realloc(s, cap);
                if (!ns) { ok = 0; break; }
                s = ns;
            }
            s[len++] = c;
        }
        if (*p == '"') p++;
        if (!ok || !len) { free(s); break; }
        s[len] = '\0';
        out[n++] = s;
    }
    return n;
}

/* POST /api/vision/describe — image source is images[] (up to
 * VISION_MAX_IMAGES, one joint request so the model can compare them) |
 * data_uri | image_b64 | path. `path` is read + base64'd server-side (used by
 * the agent see_image tool, so the agent needs no base64/JSON code of its own)
 * and is HOST-LOCAL ONLY: for non-loopback clients (allow_path 0) it would be
 * arbitrary host-file disclosure, so only inline data is accepted from them.
 * format:"text" → respond text/plain with the description; otherwise JSON
 * {ok,text}. */
static void api_vision_describe_run(int fd, const char *body, int allow_path) {
    char fmt[16] = "";
    (void)json_get_string(body, "format", fmt, sizeof fmt);
    int want_text = !strcmp(fmt, "text");

    char *urls[VISION_MAX_IMAGES];   /* malloc'd data: URIs */
    int nimg = 0;
    char *raw[VISION_MAX_IMAGES];
    int nraw = vision_parse_images(body, raw, VISION_MAX_IMAGES);
    if (nraw > 0) {
        for (int i = 0; i < nraw; i++) {
            char *u = vision_data_url_from(raw[i]);
            free(raw[i]);
            if (u) urls[nimg++] = u;
        }
    } else {
        char *image = json_get_string_alloc_rpc(body, "data_uri");
        if (!image) image = json_get_string_alloc_rpc(body, "image_b64");
        if (image && image[0]) {
            char *u = vision_data_url_from(image);
            if (u) urls[nimg++] = u;
        } else {
            char *path = json_get_string_alloc_rpc(body, "path");
            if (path && path[0] && !allow_path) {
                free(image); free(path);
                if (want_text) send_text(fd, "403 Forbidden", "see_image error: path is host-local only\n", 0);
                else web_json_error(fd, "403 Forbidden", "path is host-local only; send data_uri instead");
                return;
            }
            if (path && path[0]) {
                size_t ilen = 0;
                char *bytes = jsonl_read_file(path, &ilen);
                if (!bytes) {
                    free(image); free(path);
                    if (want_text) send_text(fd, "400 Bad Request", "see_image error: cannot read image file\n", 0);
                    else web_json_error(fd, "400 Bad Request", "cannot read image path");
                    return;
                }
                char *b64 = base64_encode((const unsigned char *)bytes, ilen);
                free(bytes);
                if (b64) {
                    const char *mime = vision_mime_for(path);
                    size_t need = strlen(b64) + strlen(mime) + 24;
                    char *u = malloc(need);
                    if (u) { snprintf(u, need, "data:%s;base64,%s", mime, b64); urls[nimg++] = u; }
                }
                free(b64);
            }
            free(path);
        }
        free(image);
    }
    if (nimg == 0) {
        if (want_text) send_text(fd, "400 Bad Request", "see_image error: no image (path/data_uri) supplied\n", 0);
        else web_json_error(fd, "400 Bad Request", "images, data_uri, image_b64, or path is required");
        return;
    }

    /* Frame the vision prompt in ENGLISH. The small Qwen2.5-VL model refuses
     * non-English requests ("Mi dispiace, non posso…") even though it sees the
     * image fine; an English frame makes it comply, and it can still address a
     * request written in another language when embedded here. */
    char qbuf[4096];
    int has_q = json_get_string(body, "question", qbuf, sizeof qbuf) && qbuf[0];
    char question[5500];
    /* Anti-hallucination framing (measured on real images): told to "answer the
     * question", the small VL model over-commits — wrong connector types, invented
     * "connected/plugged" relationships, phantom counts. Grounding it in "describe
     * only clearly-visible facts, don't infer connections, admit uncertainty" is
     * far more accurate; the question only STEERS attention, it does not force a
     * committed answer. English on purpose (the model refuses non-English asks). */
    static const char *base =
        "You are a precise vision analyzer. Describe what is clearly visible in this image: state only "
        "facts, do NOT assume separate items are connected or plugged together unless clearly shown, "
        "name port/connector types precisely, and if a detail is too small or blurry to be sure, say "
        "you are not certain instead of guessing.";
    /* Joint multi-image request: number the images so the answer can compare
     * and cross-reference them ("what changed between these screenshots?"). */
    char multi[240] = "";
    if (nimg > 1)
        snprintf(multi, sizeof multi,
                 " You are given %d images, numbered in the order provided (Image 1 first). Briefly "
                 "describe each one, then note the differences or relations between them that matter, "
                 "referring to them as Image 1..Image %d.", nimg, nimg);
    if (has_q)
        snprintf(question, sizeof question,
                 "%s%s Pay particular attention to anything relevant to this request (do not guess — say "
                 "if you cannot tell): \"%s\"", base, multi, qbuf);
    else
        snprintf(question, sizeof question, "%s%s", base, multi);

    /* Short safety-net only: the heavy one-time model download happens in
     * /api/vision/setup, so by now the sidecar is normally already serving.
     * 60s covers a restart with the model already cached, not a fresh download. */
    if (!vision_ensure_server(60000)) {
        vision_free_urls(urls, nimg);
        if (want_text) send_text(fd, "503 Service Unavailable",
                                 "see_image error: vision server is not running; run vision setup once\n", 0);
        else web_json_error(fd, "503 Service Unavailable",
                       "vision model server is not running; call POST /api/vision/setup once to install it");
        return;
    }

    /* Build the upstream OpenAI chat body: one image_url content part per
     * image, then the text prompt. temperature 0: perception/OCR is a factual
     * task — greedy decoding is more precise and hallucinates fewer invented
     * details. max_tokens is higher for the agent's text format, where dense
     * OCR transcriptions were hitting the old 1024 cap; callers with denser
     * output (the PDF page reader) can raise it further via the request's
     * max_tokens — the sidecar ctx (12288) has room for a 4k answer. */
    long mt = want_text ? 1536 : 1024;
    (void)json_get_int(body, "max_tokens", 256, 4096, &mt);
    json_dyn_buf up = {0};
    int okb = json_dyn_puts(&up, "{\"model\":") &&
              json_dyn_put_escaped(&up, VISION_MODEL) &&
              json_dyn_printf(&up, ",\"max_tokens\":%d,\"temperature\":0,"
                                   "\"messages\":[{\"role\":\"user\",\"content\":[",
                              (int)mt);
    for (int i = 0; okb && i < nimg; i++) {
        okb = json_dyn_puts(&up, "{\"type\":\"image_url\",\"image_url\":{\"url\":") &&
              json_dyn_put_escaped(&up, urls[i]) &&
              json_dyn_puts(&up, "}},");
    }
    okb = okb &&
          json_dyn_puts(&up, "{\"type\":\"text\",\"text\":") &&
          json_dyn_put_escaped(&up, question) &&
          json_dyn_puts(&up, "}]}]}");
    vision_free_urls(urls, nimg);
    if (!okb) { free(up.ptr);
        if (want_text) send_text(fd, "500 Internal Server Error", "see_image error: out of memory\n", 0);
        else web_json_error(fd, "500 Internal Server Error", "out of memory");
        return; }

    /* curl cannot take a multi-MB body on argv → write it to a temp file. */
    char tmpl[] = "/tmp/dstudio-vision-req-XXXXXX";
    int tf = mkstemp(tmpl);
    if (tf < 0) { free(up.ptr);
        if (want_text) send_text(fd, "500 Internal Server Error", "see_image error: temp file\n", 0);
        else web_json_error(fd, "500 Internal Server Error", "cannot create temp file");
        return; }
    size_t total = up.len, off = 0;
    while (off < total) {
        ssize_t w = write(tf, up.ptr + off, total - off);
        if (w <= 0) break;
        off += (size_t)w;
    }
    close(tf);
    free(up.ptr);
    if (off < total) { unlink(tmpl);
        if (want_text) send_text(fd, "500 Internal Server Error", "see_image error: temp write\n", 0);
        else web_json_error(fd, "500 Internal Server Error", "cannot write temp file");
        return; }

    char url[80];  snprintf(url, sizeof url, "http://127.0.0.1:%d/v1/chat/completions", VISION_PORT);
    char dataarg[80]; snprintf(dataarg, sizeof dataarg, "@%s", tmpl);
    char *argv[16]; int n = 0;
    argv[n++] = "curl"; argv[n++] = "-sS"; argv[n++] = "-X"; argv[n++] = "POST";
    argv[n++] = "-H"; argv[n++] = "Content-Type: application/json";
    argv[n++] = "--data-binary"; argv[n++] = dataarg;
    argv[n++] = "--max-time"; argv[n++] = "300";
    argv[n++] = url; argv[n] = NULL;

    int st = 0;
    char *resp = web_curl_capture(argv, 310000, &st);
    unlink(tmpl);
    if (!resp || !resp[0]) { free(resp);
        if (want_text) send_text(fd, "502 Bad Gateway", "see_image error: vision server did not respond\n", 0);
        else web_json_error(fd, "502 Bad Gateway", "vision server did not respond");
        return; }

    char *text = json_get_string_alloc_rpc(resp, "content");
    if (!text || !text[0]) {
        free(text);
        char *cap = web_strndup_cap(resp, strlen(resp), want_text ? 1500 : 4000);
        if (want_text) {
            char msg[1800];
            snprintf(msg, sizeof msg, "see_image error: vision server returned no content. %s\n", cap ? cap : "");
            free(cap); free(resp);
            send_text(fd, "502 Bad Gateway", msg, 0);
            return;
        }
        json_dyn_buf e = {0};
        int oke = json_dyn_puts(&e, "{\"ok\":false,\"error\":\"vision server returned no content\",\"raw\":") &&
                  json_dyn_put_escaped(&e, cap ? cap : "") &&
                  json_dyn_puts(&e, "}");
        free(cap); free(resp);
        send_json(fd, "502 Bad Gateway", oke && e.ptr ? e.ptr : "{\"ok\":false,\"error\":\"no content\"}");
        free(e.ptr);
        return;
    }
    /* Silent truncation is worse than a longer answer: when generation stopped
     * at max_tokens (finish_reason "length"), say so, so the model downstream
     * knows the description (e.g. a dense OCR transcription) is incomplete. */
    char fr[24] = "";
    (void)json_get_string(resp, "finish_reason", fr, sizeof fr);
    free(resp);
    if (!strcmp(fr, "length")) {
        static const char *tnote =
            "\n\n[Note: description truncated at the token limit — details may be missing.]";
        size_t tl = strlen(text), nl = strlen(tnote);
        char *nt = realloc(text, tl + nl + 1);
        if (nt) { text = nt; memcpy(text + tl, tnote, nl + 1); }
    }

    if (want_text) { send_text(fd, "200 OK", text, 0); free(text); return; }

    json_dyn_buf out = {0};
    int oko = json_dyn_puts(&out, "{\"ok\":true,\"text\":") &&
              json_dyn_put_escaped(&out, text) &&
              json_dyn_puts(&out, "}");
    free(text);
    if (!oko) { free(out.ptr); web_json_error(fd, "500 Internal Server Error", "out of memory"); return; }
    send_json(fd, "200 OK", out.ptr);
    free(out.ptr);
}

/* Current vision model pref: $VISION_DIR/.hf when present (written below on a
 * {hf} switch and read by scripts/vision-server.sh), else the built-in default. */
static void vision_hf_pref(char *out, size_t outsz) {
    char p[DSTUDIO_PATH_MAX + 8];
    vision_dir_path(p, sizeof p);
    size_t l = strlen(p);
    snprintf(p + l, sizeof p - l, "/.hf");
    size_t n = 0;
    char *b = jsonl_read_file(p, &n);
    if (b) {
        while (n > 0 && (b[n - 1] == '\n' || b[n - 1] == '\r' || b[n - 1] == ' ')) b[--n] = '\0';
        if (b[0]) { cstr_copy(out, outsz, b); free(b); return; }
        free(b);
    }
    cstr_copy(out, outsz, VISION_HF_DEFAULT);
}

/* POST /api/vision/setup — install the llama.cpp runtime on demand
 * (scripts/vision-setup.sh), then warm the sidecar so the first describe is
 * fast. Optional body {hf:"owner/Repo-GGUF"} switches the vision model (e.g.
 * Qwen2.5-VL 3B <-> 7B): the pref is persisted to $VISION_DIR/.hf, a running
 * sidecar is stopped so the warm-up below reloads with the new model. */
static void api_vision_setup_run(int fd, const char *body) {
    resolve_web_dir();
    if (!web_dir_valid()) {
        send_json(fd, "409 Conflict",
                  "{\"ok\":false,\"error\":\"DStudio checkout not found; cannot locate scripts/vision-setup.sh\"}");
        return;
    }
    char script[DSTUDIO_PATH_MAX + 64];
    snprintf(script, sizeof script, "%s/scripts/vision-setup.sh", g_web_dir);
    struct stat stt;
    if (stat(script, &stt) != 0) {
        send_json(fd, "500 Internal Server Error", "{\"ok\":false,\"error\":\"scripts/vision-setup.sh missing\"}");
        return;
    }

    char hf[200] = "";
    if (body && json_get_string(body, "hf", hf, sizeof hf) && hf[0]) {
        int sane = strchr(hf, '/') != NULL && strlen(hf) > 3;
        for (const char *p = hf; sane && *p; p++)
            if (!isalnum((unsigned char)*p) && !strchr("._/-", *p)) sane = 0;
        if (!sane) {
            send_json(fd, "400 Bad Request", "{\"ok\":false,\"error\":\"invalid hf repo\"}");
            return;
        }
        char cur[200];
        vision_hf_pref(cur, sizeof cur);
        if (strcmp(cur, hf) != 0) {
            char dir[DSTUDIO_PATH_MAX];
            vision_dir_path(dir, sizeof dir);
            char parent[DSTUDIO_PATH_MAX];
            const char *home = getenv("HOME");
            snprintf(parent, sizeof parent, "%s/.dstudio", home ? home : ".");
            (void)mkdir(parent, 0755);
            (void)mkdir(dir, 0755);
            char pref[DSTUDIO_PATH_MAX + 8];
            snprintf(pref, sizeof pref, "%s/.hf", dir);
            if (!jsonl_write_file(pref, hf, strlen(hf))) {
                send_json(fd, "500 Internal Server Error", "{\"ok\":false,\"error\":\"cannot write model pref\"}");
                return;
            }
            /* The running sidecar still serves the old model: stop it so the
             * warm-up below loads the new one. */
            (void)vision_kill_server();
        }
    }

    char *argv[] = { "/bin/sh", script, NULL };
    char log_tail[8192] = "";
    int rc = setup_run_cmd_capture(g_web_dir, argv, log_tail, sizeof log_tail);
    /* Warm the sidecar AS PART OF SETUP: this triggers + completes the one-time
     * model download (multi-GB, llama.cpp -hf) and BLOCKS until the server is
     * actually serving, so every later /api/vision/describe is instant. Long cap
     * because a fresh download can take many minutes on a slow link. */
    vision_touch_last_use();
    int server_up = (rc == 0) ? vision_ensure_server(1000000) : 0;   /* ~16 min */
    if (server_up) vision_touch_last_use();   /* warm-up counts as use for the idle watchdog */
    int ok = rc == 0 && server_up;
    const char *err = rc != 0 ? "vision runtime install failed (see log)"
                    : !server_up ? "vision model did not come up in time (download too slow?); retry"
                    : "";

    char hf_now[200];
    vision_hf_pref(hf_now, sizeof hf_now);
    json_dyn_buf b = {0};
    char *cap = web_strndup_cap(log_tail, strlen(log_tail), 6000);
    int good = json_dyn_puts(&b, "{\"ok\":") &&
               json_dyn_puts(&b, ok ? "true" : "false") &&
               json_dyn_printf(&b, ",\"exit\":%d,\"serverUp\":%s,\"hf\":", rc, server_up ? "true" : "false") &&
               json_dyn_put_escaped(&b, hf_now) &&
               json_dyn_puts(&b, ",\"model\":") &&
               json_dyn_put_escaped(&b, VISION_MODEL) &&
               json_dyn_puts(&b, ",\"error\":") &&
               json_dyn_put_escaped(&b, err) &&
               json_dyn_puts(&b, ",\"log\":") &&
               json_dyn_put_escaped(&b, cap ? cap : "") &&
               json_dyn_puts(&b, "}");
    free(cap);
    if (!good) { free(b.ptr); send_json(fd, "500 Internal Server Error", "{\"ok\":false,\"error\":\"out of memory\"}"); return; }
    send_json(fd, ok ? "200 OK" : "500 Internal Server Error", b.ptr);
    free(b.ptr);
}

/* Both vision handlers fork a detached worker (vision inference + the one-time
 * runtime install are slow) so the single-threaded main loop is never blocked —
 * same pattern as api_http_probe. */
static void api_vision_fork(int fd, const char *body, int is_setup, int allow_path) {
    pid_t pid = fork();
    if (pid < 0) { if (is_setup) api_vision_setup_run(fd, body); else api_vision_describe_run(fd, body, allow_path); return; }
    if (pid == 0) {
        if (fork() > 0) _exit(0);
        if (g_srv_fd >= 0) close(g_srv_fd);
        if (g_out_fd >= 0) close(g_out_fd);
        if (g_err_fd >= 0) close(g_err_fd);
        if (g_in_fd  >= 0) close(g_in_fd);
        struct timeval tv = { 620, 0 };
        (void)setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof tv);
        if (is_setup) api_vision_setup_run(fd, body);
        else          api_vision_describe_run(fd, body, allow_path);
        close(fd);
        _exit(0);
    }
    waitpid(pid, NULL, 0);
}
#endif /* !_WIN32 */

static void api_vision_describe(int fd, const char *body) {
#ifdef _WIN32
    (void)body;
    web_json_error(fd, "501 Not Implemented", "vision is not available in the Windows build yet");
#else
    /* Every request keeps the idle-stop watchdog fed; `path` sources stay
     * host-local (arbitrary-file disclosure for a LAN peer otherwise). */
    vision_touch_last_use();
    api_vision_fork(fd, body, 0, client_is_loopback(fd));
#endif
}

static void api_vision_setup(int fd, const char *body) {
#ifdef _WIN32
    (void)body;
    send_json(fd, "409 Conflict", "{\"ok\":false,\"error\":\"vision setup is not supported on the Windows build yet\"}");
#else
    api_vision_fork(fd, body, 1, 1);
#endif
}

/* POST /api/vision/stop — stop the sidecar now (Settings action / doctor). It
 * restarts on demand at the next describe; with the model already cached that
 * is a matter of seconds. */
static void api_vision_stop(int fd) {
#ifdef _WIN32
    send_json(fd, "409 Conflict", "{\"ok\":false,\"error\":\"vision is not supported on the Windows build yet\"}");
#else
    int stopped = vision_kill_server();
    send_json(fd, "200 OK", stopped ? "{\"ok\":true,\"stopped\":true}"
                                    : "{\"ok\":true,\"stopped\":false,\"error\":\"not running\"}");
#endif
}

/* GET /api/vision/status — host-local status surface for Settings and the
 * doctor: install state, server state, model pref, disk usage, and the tail of
 * the sidecar log (turns the multi-GB first download from a blind toast into
 * visible progress). */
static void api_vision_status(int fd) {
#ifdef _WIN32
    send_json(fd, "200 OK",
              "{\"ok\":true,\"supported\":false,\"installed\":false,\"state\":\"unsupported\","
              "\"pid\":0,\"diskBytes\":0,\"cacheBytes\":0,\"lastUse\":0,\"hf\":\"\",\"logTail\":\"\"}");
#else
    char dir[DSTUDIO_PATH_MAX];
    vision_dir_path(dir, sizeof dir);
    char bin[DSTUDIO_PATH_MAX] = "";
    int installed = vision_scan_for_bin(dir, 0, bin, sizeof bin);
    pid_t pid = vision_lock_pid();
    int pid_live = vision_pid_is_llama(pid);
    const char *state = "stopped";
    if (vision_server_ready()) state = "ready";
    else if (vision_port_open() || pid_live) state = "starting";
    long long run_bytes = installed ? vision_tree_bytes(dir, 0) : 0;
    char cache[DSTUDIO_PATH_MAX];
    vision_model_cache_path(cache, sizeof cache);
    char hf[200];
    vision_hf_pref(hf, sizeof hf);
    long long cache_bytes = vision_tree_bytes(cache, 0) + vision_hf_hub_bytes(hf);
    char stamp[DSTUDIO_PATH_MAX + 16];
    snprintf(stamp, sizeof stamp, "%s/.last-use", dir);
    struct stat st;
    long long last_use = stat(stamp, &st) == 0 ? (long long)st.st_mtime : 0;

    char tail[1600] = "";
    FILE *lf = fopen("/tmp/dstudio-vision.log", "r");
    if (lf) {
        if (fseek(lf, 0, SEEK_END) == 0) {
            long sz = ftell(lf);
            long want = (long)sizeof tail - 1;
            long from = sz > want ? sz - want : 0;
            if (fseek(lf, from, SEEK_SET) == 0) {
                size_t got = fread(tail, 1, sizeof tail - 1, lf);
                tail[got] = '\0';
            }
        }
        fclose(lf);
    }

    json_dyn_buf b = {0};
    int okb = json_dyn_printf(&b, "{\"ok\":true,\"supported\":true,\"installed\":%s,\"state\":",
                              installed ? "true" : "false") &&
              json_dyn_put_escaped(&b, state) &&
              json_dyn_printf(&b, ",\"pid\":%d,\"port\":%d,\"diskBytes\":%lld,\"cacheBytes\":%lld,"
                                  "\"lastUse\":%lld,\"hf\":",
                              pid_live ? (int)pid : 0, VISION_PORT, run_bytes, cache_bytes, last_use) &&
              json_dyn_put_escaped(&b, hf) &&
              json_dyn_puts(&b, ",\"dir\":") && json_dyn_put_escaped(&b, dir) &&
              json_dyn_puts(&b, ",\"cacheDir\":") && json_dyn_put_escaped(&b, cache) &&
              json_dyn_puts(&b, ",\"logTail\":") && json_dyn_put_escaped(&b, tail) &&
              json_dyn_puts(&b, "}");
    if (!okb) { free(b.ptr); web_json_error(fd, "500 Internal Server Error", "out of memory"); return; }
    send_json(fd, "200 OK", b.ptr);
    free(b.ptr);
#endif
}

/* Doctor row: 1 = installed (message describes the live state). Kept cheap —
 * no health probe beyond the ones the vision section already provides. */
static int vision_doctor_row(char *msg, size_t msgsz) {
#ifdef _WIN32
    cstr_copy(msg, msgsz, "Not supported on the Windows build yet.");
    return 0;
#else
    char dir[DSTUDIO_PATH_MAX];
    vision_dir_path(dir, sizeof dir);
    char bin[DSTUDIO_PATH_MAX] = "";
    if (!vision_scan_for_bin(dir, 0, bin, sizeof bin)) {
        cstr_copy(msg, msgsz,
                  "Not installed. Optional: local image understanding for chat attachments and the "
                  "agent's see_image tool — attach an image in chat, or install it from Settings.");
        return 0;
    }
    char hf[200];
    vision_hf_pref(hf, sizeof hf);
    if (vision_server_ready())
        snprintf(msg, msgsz, "Serving %s — used by chat image attachments and the agent's see_image tool.", hf);
    else if (vision_port_open() || vision_pid_is_llama(vision_lock_pid()))
        snprintf(msg, msgsz, "Starting (%s) — loading or downloading the model.", hf);
    else
        snprintf(msg, msgsz, "Installed (%s). Starts on demand at the first image and stops itself when idle.", hf);
    return 1;
#endif
}

/* ---- Embedding sidecar endpoints (semantic skill search) ---- */
#ifndef _WIN32
/* Read the row count stored in the skill index header (0 if absent). */
static int embed_index_count(void) {
    char path[DSTUDIO_PATH_MAX + 32]; skill_index_path(path, sizeof path);
    FILE *f = fopen(path, "rb");
    if (!f) return 0;
    skill_index_hdr h;
    int n = (fread(&h, sizeof h, 1, f) == 1 && h.magic == SKILL_INDEX_MAGIC) ? h.count : 0;
    fclose(f);
    return n;
}

/* POST /api/embed/setup — install the llama.cpp runtime (shared with vision) on
 * demand, warm the embedding model, and BUILD the skill index so the first
 * search is instant. Optional body {hf} switches the embedding model. */
static void api_embed_setup_run(int fd, const char *body) {
    resolve_web_dir();
    if (!web_dir_valid()) {
        send_json(fd, "409 Conflict", "{\"ok\":false,\"error\":\"DStudio checkout not found\"}");
        return;
    }
    char setup_script[DSTUDIO_PATH_MAX + 64];
    snprintf(setup_script, sizeof setup_script, "%s/scripts/vision-setup.sh", g_web_dir);
    struct stat stt;
    if (stat(setup_script, &stt) != 0) {
        send_json(fd, "500 Internal Server Error", "{\"ok\":false,\"error\":\"scripts/vision-setup.sh missing\"}");
        return;
    }
    char embed_dir[DSTUDIO_PATH_MAX]; embed_dir_path(embed_dir, sizeof embed_dir);
    const char *home = getenv("HOME");
    char parent[DSTUDIO_PATH_MAX];
    snprintf(parent, sizeof parent, "%s/.dstudio", home ? home : ".");
    (void)mkdir(parent, 0755); (void)mkdir(embed_dir, 0755);

    char hf[200] = "";
    if (body && json_get_string(body, "hf", hf, sizeof hf) && hf[0]) {
        int sane = strchr(hf, '/') != NULL && strlen(hf) > 3;
        for (const char *p = hf; sane && *p; p++)
            if (!isalnum((unsigned char)*p) && !strchr("._/:-", *p)) sane = 0;
        if (!sane) { send_json(fd, "400 Bad Request", "{\"ok\":false,\"error\":\"invalid hf repo\"}"); return; }
        char cur[200]; embed_hf_pref(cur, sizeof cur);
        if (strcmp(cur, hf) != 0) {
            char pref[DSTUDIO_PATH_MAX + 8];
            snprintf(pref, sizeof pref, "%s/.hf", embed_dir);
            if (!jsonl_write_file(pref, hf, strlen(hf))) {
                send_json(fd, "500 Internal Server Error", "{\"ok\":false,\"error\":\"cannot write model pref\"}");
                return;
            }
            (void)embed_kill_server();   /* reload with the new model */
        }
    }

    /* Ensure a llama-server binary exists: reuse the vision runtime if present,
     * else install one INTO the embed dir (vision-setup.sh honors this env). */
    char probe[DSTUDIO_PATH_MAX] = "", vdir[DSTUDIO_PATH_MAX];
    vision_dir_path(vdir, sizeof vdir);
    int have_bin = vision_scan_for_bin(embed_dir, 0, probe, sizeof probe) ||
                   vision_scan_for_bin(vdir, 0, probe, sizeof probe);
    int rc = 0;
    char log_tail[8192] = "";
    if (!have_bin) {
        setenv("DSTUDIO_VISION_DIR", embed_dir, 1);
        char *argv[] = { "/bin/sh", setup_script, NULL };
        rc = setup_run_cmd_capture(g_web_dir, argv, log_tail, sizeof log_tail);
        unsetenv("DSTUDIO_VISION_DIR");
    }

    embed_touch_last_use();
    int server_up = (rc == 0) ? embed_ensure_server(1000000) : 0;
    int indexed = 0;
    if (server_up) {
        embed_touch_last_use();
        skill_hit_list L = {0};
        if (skill_enum_all(&L) && L.n > 0) {
            char **texts = calloc((size_t)L.n, sizeof *texts);
            if (texts) {
                for (int i = 0; i < L.n; i++) texts[i] = skill_embed_text(&L.v[i]);
                int dim = 0;
                float *v = skill_index_ensure(&L, texts, &dim);
                if (v) { indexed = L.n; free(v); }
                for (int i = 0; i < L.n; i++) free(texts[i]);
                free(texts);
            }
        }
        skill_hits_free(&L);
    }
    int ok = rc == 0 && server_up && indexed > 0;
    const char *err = rc != 0 ? "embedding runtime install failed (see log)"
                    : !server_up ? "embedding model did not come up in time; retry"
                    : indexed == 0 ? "index build failed"
                    : "";
    char hf_now[200]; embed_hf_pref(hf_now, sizeof hf_now);
    json_dyn_buf b = {0};
    char *cap = web_strndup_cap(log_tail, strlen(log_tail), 6000);
    int good = json_dyn_puts(&b, "{\"ok\":") && json_dyn_puts(&b, ok ? "true" : "false") &&
               json_dyn_printf(&b, ",\"serverUp\":%s,\"indexed\":%d,\"hf\":", server_up ? "true" : "false", indexed) &&
               json_dyn_put_escaped(&b, hf_now) &&
               json_dyn_puts(&b, ",\"error\":") && json_dyn_put_escaped(&b, err) &&
               json_dyn_puts(&b, ",\"log\":") && json_dyn_put_escaped(&b, cap ? cap : "") &&
               json_dyn_puts(&b, "}");
    free(cap);
    if (!good) { free(b.ptr); send_json(fd, "500 Internal Server Error", "{\"ok\":false,\"error\":\"out of memory\"}"); return; }
    send_json(fd, ok ? "200 OK" : "500 Internal Server Error", b.ptr);
    free(b.ptr);
}

/* Detached worker for the slow embed setup (download + index build). */
static void api_embed_fork(int fd, const char *body) {
    pid_t pid = fork();
    if (pid < 0) { api_embed_setup_run(fd, body); return; }
    if (pid == 0) {
        if (fork() > 0) _exit(0);
        if (g_srv_fd >= 0) close(g_srv_fd);
        if (g_out_fd >= 0) close(g_out_fd);
        if (g_err_fd >= 0) close(g_err_fd);
        if (g_in_fd  >= 0) close(g_in_fd);
        struct timeval tv = { 1220, 0 };
        (void)setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof tv);
        api_embed_setup_run(fd, body);
        close(fd);
        _exit(0);
    }
    waitpid(pid, NULL, 0);
}
#endif /* !_WIN32 */

static void api_embed_setup(int fd, const char *body) {
#ifdef _WIN32
    (void)body;
    send_json(fd, "409 Conflict", "{\"ok\":false,\"error\":\"semantic skill search is not supported on the Windows build yet\"}");
#else
    api_embed_fork(fd, body);
#endif
}

static void api_embed_stop(int fd) {
#ifdef _WIN32
    send_json(fd, "409 Conflict", "{\"ok\":false,\"error\":\"not supported on the Windows build yet\"}");
#else
    int stopped = embed_kill_server();
    send_json(fd, "200 OK", stopped ? "{\"ok\":true,\"stopped\":true}"
                                    : "{\"ok\":true,\"stopped\":false,\"error\":\"not running\"}");
#endif
}

/* GET /api/embed/status — install/server/index state for Settings + doctor. */
static void api_embed_status(int fd) {
#ifdef _WIN32
    send_json(fd, "200 OK",
              "{\"ok\":true,\"supported\":false,\"installed\":false,\"state\":\"unsupported\","
              "\"pid\":0,\"indexed\":0,\"diskBytes\":0,\"lastUse\":0,\"hf\":\"\",\"logTail\":\"\"}");
#else
    char dir[DSTUDIO_PATH_MAX]; embed_dir_path(dir, sizeof dir);
    char vdir[DSTUDIO_PATH_MAX]; vision_dir_path(vdir, sizeof vdir);
    char bin[DSTUDIO_PATH_MAX] = "";
    int installed = vision_scan_for_bin(dir, 0, bin, sizeof bin) || vision_scan_for_bin(vdir, 0, bin, sizeof bin);
    pid_t pid = embed_lock_pid();
    int pid_live = vision_pid_is_llama(pid);
    const char *state = "stopped";
    if (embed_server_ready()) state = "ready";
    else if (embed_port_open() || pid_live) state = "starting";
    long long run_bytes = vision_tree_bytes(dir, 0);
    char cache[DSTUDIO_PATH_MAX]; vision_model_cache_path(cache, sizeof cache);
    char hf[200]; embed_hf_pref(hf, sizeof hf);
    long long cache_bytes = vision_tree_bytes(cache, 0) + vision_hf_hub_bytes(hf);
    char stamp[DSTUDIO_PATH_MAX + 16]; snprintf(stamp, sizeof stamp, "%s/.last-use", dir);
    struct stat st;
    long long last_use = stat(stamp, &st) == 0 ? (long long)st.st_mtime : 0;
    int indexed = embed_index_count();
    char tail[1600] = "";
    FILE *lf = fopen("/tmp/dstudio-embed.log", "r");
    if (lf) {
        if (fseek(lf, 0, SEEK_END) == 0) {
            long sz = ftell(lf), want = (long)sizeof tail - 1, from = sz > want ? sz - want : 0;
            if (fseek(lf, from, SEEK_SET) == 0) { size_t got = fread(tail, 1, sizeof tail - 1, lf); tail[got] = '\0'; }
        }
        fclose(lf);
    }
    json_dyn_buf b = {0};
    int okb = json_dyn_printf(&b, "{\"ok\":true,\"supported\":true,\"installed\":%s,\"state\":", installed ? "true" : "false") &&
              json_dyn_put_escaped(&b, state) &&
              json_dyn_printf(&b, ",\"pid\":%d,\"port\":%d,\"indexed\":%d,\"diskBytes\":%lld,\"cacheBytes\":%lld,\"lastUse\":%lld,\"hf\":",
                              pid_live ? (int)pid : 0, EMBED_PORT, indexed, run_bytes, cache_bytes, last_use) &&
              json_dyn_put_escaped(&b, hf) &&
              json_dyn_puts(&b, ",\"logTail\":") && json_dyn_put_escaped(&b, tail) &&
              json_dyn_puts(&b, "}");
    if (!okb) { free(b.ptr); web_json_error(fd, "500 Internal Server Error", "out of memory"); return; }
    send_json(fd, "200 OK", b.ptr);
    free(b.ptr);
#endif
}

/* Doctor row: semantic skill search availability. */
static int embed_doctor_row(char *msg, size_t msgsz) {
#ifdef _WIN32
    cstr_copy(msg, msgsz, "Not supported on the Windows build yet.");
    return 0;
#else
    char dir[DSTUDIO_PATH_MAX]; embed_dir_path(dir, sizeof dir);
    char vdir[DSTUDIO_PATH_MAX]; vision_dir_path(vdir, sizeof vdir);
    char bin[DSTUDIO_PATH_MAX] = "";
    int installed = vision_scan_for_bin(dir, 0, bin, sizeof bin) || vision_scan_for_bin(vdir, 0, bin, sizeof bin);
    int indexed = embed_index_count();
    if (!installed || indexed == 0) {
        cstr_copy(msg, msgsz,
                  "Not installed. Semantic skill routing for the Agent (handles any language) — install it once from Settings.");
        return 0;
    }
    char hf[200]; embed_hf_pref(hf, sizeof hf);
    if (embed_server_ready())
        snprintf(msg, msgsz, "Serving %s — %d skills indexed for semantic Agent routing.", hf, indexed);
    else
        snprintf(msg, msgsz, "Installed (%s), %d skills indexed. Starts on demand and stops when idle.", hf, indexed);
    return 1;
#endif
}

/* POST /api/agent/attach-image {dir, name?, data_uri} — write a dropped/pasted
 * image into the agent workspace so the model can inspect it with see_image
 * (drop/paste used to be chat-only; in agent mode the pixels had no way in).
 * Host-local only (not in the LAN allowlist) + CSRF header; the UI sends its
 * selected agent workdir — the same trust boundary as /api/start's workdir. */
#ifndef _WIN32
static void agent_attach_image_name(const char *in, const char *mime, char *out, size_t outsz) {
    const char *base = in ? in : "";
    const char *s1 = strrchr(base, '/');
    const char *s2 = strrchr(base, '\\');
    if (s1) base = s1 + 1;
    if (s2 && s2 + 1 > base) base = s2 + 1;
    char clean[96];
    size_t o = 0;
    for (const char *p = base; *p && o < sizeof clean - 1; p++) {
        unsigned char c = (unsigned char)*p;
        if (isalnum(c) || c == '.' || c == '_' || c == '-') clean[o++] = (char)c;
        else if (c == ' ') clean[o++] = '-';
    }
    clean[o] = '\0';
    while (clean[0] == '.') memmove(clean, clean + 1, strlen(clean));   /* no hidden files */
    if (!clean[0]) cstr_copy(clean, sizeof clean, "image");
    /* Ensure an image extension consistent with the payload (see_image and the
     * describe path branch pick the mime from it). */
    const char *ext = ".png";
    if (mime) {
        if (strstr(mime, "jpeg") || strstr(mime, "jpg")) ext = ".jpg";
        else if (strstr(mime, "webp")) ext = ".webp";
        else if (strstr(mime, "gif")) ext = ".gif";
        else if (strstr(mime, "bmp")) ext = ".bmp";
    }
    char *dot = strrchr(clean, '.');
    int has_img_ext = 0;
    if (dot && dot != clean) {
        char e[8] = {0};
        size_t j = 0;
        for (const char *p = dot + 1; *p && j < sizeof e - 1; p++) e[j++] = (char)tolower((unsigned char)*p);
        has_img_ext = !strcmp(e, "png") || !strcmp(e, "jpg") || !strcmp(e, "jpeg") ||
                      !strcmp(e, "webp") || !strcmp(e, "gif") || !strcmp(e, "bmp");
    }
    if (has_img_ext) cstr_copy(out, outsz, clean);
    else snprintf(out, outsz, "%s%s", clean, ext);
}
#endif

/* ============================================================================
 * PDF attachments — hybrid reader: text layer first, vision for scanned pages.
 *
 * pdftotext (poppler) extracts each page's embedded text layer — instant and
 * verbatim, so a long digital PDF costs no vision time at all. Pages with no
 * usable text layer (scans, pure-image pages) are rasterized by pdftoppm and
 * READ by the local vision sidecar via a loopback POST to /api/vision/describe
 * (format=text) — no duplication of the vision wiring. ONE page per vision
 * call: a dense scan gets the whole answer-token budget and the per-page
 * attribution stays exact. The combined page-by-page text becomes the
 * attachment content that the ds4/DeepSeek chat model reads.
 *
 * Pages are rasterized as JPEG (not PNG) on purpose: a scanned page at 1400px
 * is ~2MB as PNG — one page alone overflows the 2MB /api body cap once
 * base64'd — but a few hundred KB as JPEG q85, which OCRs the same. A page
 * that still exceeds the per-request budget is re-rendered smaller before
 * being reported unreadable.
 *
 * Reads are question-INDEPENDENT (pure extraction/transcription; the chat or
 * agent model does the answering), so caching works across questions: the full
 * result is cached by content hash (pdf bytes + vision model + caps) and every
 * single page's vision transcription is also cached by its rendered image —
 * re-sending the same document, with any question, is instant, and a partial
 * failure retries only the failed pages. Text pages that also carry a
 * meaningful raster figure (>=5% of the page and >=3 in², via pdfimages
 * -list) get an extra figures-only vision pass so charts/diagrams are not
 * silently dropped; vector-drawn figures are a known blind spot.
 *
 *   POST /api/pdf/thumb    — render page 1 → {ok, thumb: data-URI} (attach-time preview)
 *   POST /api/pdf/describe — hybrid read → {ok, text, pages, total, textPages,
 *                            visionPages, truncated, cached}. format:"text" →
 *                            text/plain (the agent's read_pdf tool). Optional
 *                            job:"<id>" → progress readable at GET
 *                            /api/pdf/progress?job=<id> while the read runs.
 * ==========================================================================*/
#ifndef _WIN32
#define PDF_MAX_VISION_PAGES 10          /* vision-read pages cap (env DSTUDIO_PDF_MAX_PAGES) */
#define PDF_MAX_VISION_PAGES_HARD 200
#define PDF_MAX_TOTAL_PAGES 2000         /* sanity cap for the per-page bookkeeping */
#define PDF_TEXT_MIN_CHARS 24            /* page text layer below this → treat as scanned */
#define PDF_TEXT_TOTAL_CAP (160 * 1024)  /* total text-layer bytes shipped to the model */
#define PDF_PAGE_B64_BUDGET (1500 * 1024) /* per-page data-URI budget (loopback 2MB body cap) */

/* Absolute path of a poppler tool (pdftoppm/pdfinfo/pdftotext), or 0 if not
 * found. */
static int pdf_find_tool(const char *name, char *out, size_t outsz) {
    const char *dirs[] = { "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", NULL };
    for (int i = 0; dirs[i]; i++) {
        snprintf(out, outsz, "%s/%s", dirs[i], name);
        if (access(out, X_OK) == 0) return 1;
    }
    out[0] = '\0';
    return 0;
}

/* Platform-appropriate "install poppler" hint, appended to the 503 errors so
 * the toast tells the user the exact command instead of a bare "needs poppler". */
static const char *pdf_poppler_hint(void) {
#ifdef __APPLE__
    return "PDF reading needs poppler. Install it with: brew install poppler";
#else
    return "PDF reading needs poppler. Install it with: sudo apt install poppler-utils "
           "(or your distro's poppler package)";
#endif
}

/* Progress for long describe runs: the forked worker rewrites
 * /tmp/dstudio-pdfjob-<id>.json at each step; GET /api/pdf/progress?job=<id>
 * serves it. The id is client-generated and sanitized here to [A-Za-z0-9_-]. */
static int pdf_job_path(const char *job, char *out, size_t outsz) {
    if (!job || !job[0]) return 0;
    char clean[48];
    size_t o = 0;
    for (const char *p = job; *p && o < sizeof clean - 1; p++) {
        unsigned char c = (unsigned char)*p;
        if (isalnum(c) || c == '_' || c == '-') clean[o++] = (char)c;
    }
    clean[o] = '\0';
    if (!clean[0]) return 0;
    snprintf(out, outsz, "/tmp/dstudio-pdfjob-%s.json", clean);
    return 1;
}

static void pdf_job_write(const char *jobpath, const char *fmt, ...) {
    if (!jobpath || !jobpath[0]) return;
    char msg[512];
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(msg, sizeof msg, fmt, ap);
    va_end(ap);
    char tmp[DSTUDIO_PATH_MAX];
    snprintf(tmp, sizeof tmp, "%s.tmp", jobpath);
    int f = open(tmp, O_WRONLY | O_CREAT | O_TRUNC, 0644);
    if (f < 0) return;
    size_t len = strlen(msg), off = 0;
    while (off < len) { ssize_t w = write(f, msg + off, len - off); if (w <= 0) break; off += (size_t)w; }
    close(f);
    if (off == len) rename(tmp, jobpath);   /* atomic swap: the poller never sees a torn write */
    else unlink(tmp);
}

/* Decode the PDF from body {data_uri|pdf_b64|path} into a temp .pdf file.
 * Returns malloc'd path (caller unlink+free) or NULL; *forbidden set if a
 * non-loopback client passed a `path` source. *fnv (optional) receives an
 * FNV-1a of the decoded bytes — the content half of the describe cache key. */
static char *pdf_write_temp(const char *body, int allow_path, int *forbidden,
                            unsigned long long *fnv) {
    *forbidden = 0;
    char *bytes = NULL; size_t blen = 0;
    char *data = json_get_string_alloc_rpc(body, "data_uri");
    if (!data) data = json_get_string_alloc_rpc(body, "pdf_b64");
    if (data && data[0]) {
        const char *b64 = data;
        if (!strncmp(data, "data:", 5)) { const char *c = strchr(data, ','); if (c) b64 = c + 1; }
        size_t dl = 0; char *dec = base64_decode(b64, &dl);
        if (dec) { bytes = dec; blen = dl; }
        free(data);
    } else {
        free(data);
        char *path = json_get_string_alloc_rpc(body, "path");
        if (path && path[0] && !allow_path) { free(path); *forbidden = 1; return NULL; }
        if (path && path[0]) { size_t n = 0; char *b = jsonl_read_file(path, &n); if (b) { bytes = b; blen = n; } }
        free(path);
    }
    if (!bytes || blen == 0) { free(bytes); return NULL; }
    if (fnv) {
        unsigned long long h = 1469598103934665603ULL;
        for (size_t i = 0; i < blen; i++) { h ^= (unsigned char)bytes[i]; h *= 1099511628211ULL; }
        *fnv = h;
    }
    char tmpl[] = "/tmp/dstudio-pdfin-XXXXXX";
    int tf = mkstemp(tmpl);
    if (tf < 0) { free(bytes); return NULL; }
    size_t off = 0; while (off < blen) { ssize_t w = write(tf, bytes + off, blen - off); if (w <= 0) break; off += (size_t)w; }
    close(tf); free(bytes);
    if (off < blen) { unlink(tmpl); return NULL; }
    return ds4_strdup_local(tmpl);
}

/* Rasterize pages [first..last] of pdfpath to <prefix>[-N].{jpg,png} via
 * pdftoppm. JPEG for the vision pages (a 1400px scan is ~2MB as PNG — over the
 * loopback body cap on its own — but a few hundred KB as JPEG); quality only
 * applies to JPEG. */
static int pdf_render(const char *pdftoppm, const char *pdfpath, const char *prefix,
                      int first, int last, int scale_to, int singlefile,
                      int jpeg, int quality) {
    char f[12], l[12], s[12], q[32];
    snprintf(f, sizeof f, "%d", first);
    snprintf(l, sizeof l, "%d", last);
    snprintf(s, sizeof s, "%d", scale_to);
    snprintf(q, sizeof q, "quality=%d", quality > 0 ? quality : 85);
    char *argv[16]; int n = 0;
    argv[n++] = (char *)pdftoppm;
    if (jpeg) { argv[n++] = "-jpeg"; argv[n++] = "-jpegopt"; argv[n++] = q; }
    else argv[n++] = "-png";
    argv[n++] = "-f"; argv[n++] = f;
    argv[n++] = "-l"; argv[n++] = l;
    argv[n++] = "-scale-to"; argv[n++] = s;
    if (singlefile) argv[n++] = "-singlefile";
    argv[n++] = (char *)pdfpath;
    argv[n++] = (char *)prefix;
    argv[n] = NULL;
    int st = -1;
    char *o = web_curl_capture(argv, 120000, &st);
    free(o);
    return st == 0;
}

/* Read a rendered page image → "data:image/…;base64,…" (malloc'd) or NULL. */
static char *pdf_img_data_uri(const char *imgpath) {
    size_t n = 0;
    char *bytes = jsonl_read_file(imgpath, &n);
    if (!bytes || n == 0) { free(bytes); return NULL; }
    char *b64 = base64_encode((const unsigned char *)bytes, n);
    free(bytes);
    if (!b64) return NULL;
    size_t l = strlen(imgpath);
    const char *mime = (l > 4 && !strcmp(imgpath + l - 4, ".jpg")) ? "image/jpeg" : "image/png";
    size_t need = strlen(b64) + strlen(mime) + 24;
    char *uri = malloc(need);
    if (uri) snprintf(uri, need, "data:%s;base64,%s", mime, b64);
    free(b64);
    return uri;
}

/* POST /api/pdf/thumb — render page 1 to an image for the attachment preview. */
static void api_pdf_thumb_run(int fd, const char *body, int allow_path) {
    char tool[256];
    if (!pdf_find_tool("pdftoppm", tool, sizeof tool)) {
        web_json_error(fd, "503 Service Unavailable", pdf_poppler_hint());
        return;
    }
    int forbidden = 0;
    char *pdf = pdf_write_temp(body, allow_path, &forbidden, NULL);
    if (forbidden) { web_json_error(fd, "403 Forbidden", "path is host-local only; send data_uri"); return; }
    if (!pdf) { web_json_error(fd, "400 Bad Request", "a PDF (data_uri or host-local path) is required"); return; }
    char dir[] = "/tmp/dstudio-pdfr-XXXXXX";
    if (!mkdtemp(dir)) { unlink(pdf); free(pdf); web_json_error(fd, "500 Internal Server Error", "temp dir"); return; }
    char prefix[DSTUDIO_PATH_MAX];
    snprintf(prefix, sizeof prefix, "%s/p", dir);
    char *uri = NULL;
    if (pdf_render(tool, pdf, prefix, 1, 1, 1000, 1, 1, 88)) {
        char img[DSTUDIO_PATH_MAX];
        snprintf(img, sizeof img, "%s/p.jpg", dir);
        uri = pdf_img_data_uri(img);
        unlink(img);
    }
    rmdir(dir); unlink(pdf); free(pdf);
    if (!uri) { web_json_error(fd, "502 Bad Gateway", "could not render the PDF's first page"); return; }
    json_dyn_buf b = {0};
    int ok = json_dyn_puts(&b, "{\"ok\":true,\"thumb\":") && json_dyn_put_escaped(&b, uri) && json_dyn_puts(&b, "}");
    free(uri);
    if (!ok) { free(b.ptr); web_json_error(fd, "500 Internal Server Error", "oom"); return; }
    send_json(fd, "200 OK", b.ptr);
    free(b.ptr);
}

/* Per-page transcription cache path: pg-<fnv>.txt in the pdf-cache dir. Key =
 * rendered page image + vision model + prompt mode — question-INDEPENDENT by
 * design: the vision pass is pure perception, so a new question over the same
 * document reuses every already-read page instead of ~35s of OCR each. */
static void pdf_page_cache_path(unsigned long long key, char *out, size_t outsz) {
    const char *home = getenv("HOME");
    snprintf(out, outsz, "%s/.dstudio/pdf-cache/pg-%016llx.txt", home ? home : ".", key);
}
static void pdf_cache_write(const char *cpath, const char *data, const char *suffix, int cap);

/* POST ONE page image to the local /api/vision/describe (format=text) over
 * loopback; returns the vision text (malloc'd) or NULL. One page per call on
 * purpose: a dense scan needs the whole answer-token budget, and per-page
 * attribution ("--- Pagina N ---") stays exact. figures_only = the page's text
 * layer already ships verbatim, so the model describes only charts/photos. */
static char *pdf_vision_page(const char *data_uri, int figures_only) {
    static const char *scan_prompt =
        "Transcribe and describe this document page precisely and completely: all text "
        "(verbatim), tables, figures and layout. State only what is visible.";
    static const char *figs_prompt =
        "This document page's plain text is already extracted separately, so do NOT re-transcribe "
        "the body text. Describe the page's non-text content precisely: every figure, chart, "
        "graph, diagram or photo — type, axes, labels, series, values and visible trends. "
        "State only what is visible.";

    /* Per-page cache first. */
    char hf[256] = "";
    vision_hf_pref(hf, sizeof hf);
    unsigned long long key = 1469598103934665603ULL;
    for (const char *s = data_uri; *s; s++) { key ^= (unsigned char)*s; key *= 1099511628211ULL; }
    for (const char *s = hf; *s; s++)       { key ^= (unsigned char)*s; key *= 1099511628211ULL; }
    key ^= (unsigned long long)(figures_only ? 'f' : 's');
    key *= 1099511628211ULL;
    static const char *psalt = "|pg-v1|";
    for (const char *s = psalt; *s; s++)    { key ^= (unsigned char)*s; key *= 1099511628211ULL; }
    char ppath[DSTUDIO_PATH_MAX];
    pdf_page_cache_path(key, ppath, sizeof ppath);
    {
        size_t hn = 0;
        char *hit = jsonl_read_file(ppath, &hn);
        if (hit && hn > 0) { (void)utimes(ppath, NULL); return hit; }   /* LRU touch */
        free(hit);
    }

    /* max_tokens 3584: a dense scanned page transcribes to well past the 1536
     * default (measured: 52 invoice lines truncated at ~2/3); the sidecar ctx
     * (12288) minus image tokens (>=1024) and prompt leaves comfortable room. */
    json_dyn_buf up = {0};
    int okb = json_dyn_puts(&up, "{\"data_uri\":") &&
              json_dyn_put_escaped(&up, data_uri) &&
              json_dyn_puts(&up, ",\"format\":\"text\",\"max_tokens\":3584,\"question\":") &&
              json_dyn_put_escaped(&up, figures_only ? figs_prompt : scan_prompt) &&
              json_dyn_puts(&up, "}");
    if (!okb) { free(up.ptr); return NULL; }

    char tmpl[] = "/tmp/dstudio-pdfvis-XXXXXX";
    int tf = mkstemp(tmpl);
    if (tf < 0) { free(up.ptr); return NULL; }
    size_t off = 0, tot = up.len;
    while (off < tot) { ssize_t w = write(tf, up.ptr + off, tot - off); if (w <= 0) break; off += (size_t)w; }
    close(tf); free(up.ptr);
    if (off < tot) { unlink(tmpl); return NULL; }

    char url[80]; snprintf(url, sizeof url, "http://127.0.0.1:%d/api/vision/describe", g_http_port);
    char dataarg[80]; snprintf(dataarg, sizeof dataarg, "@%s", tmpl);
    char *argv[16]; int n = 0;
    argv[n++] = "curl"; argv[n++] = "-sS"; argv[n++] = "-X"; argv[n++] = "POST";
    argv[n++] = "-H"; argv[n++] = "Content-Type: application/json";
    argv[n++] = "-H"; argv[n++] = "X-Requested-With: ds4web";
    argv[n++] = "--data-binary"; argv[n++] = dataarg;
    argv[n++] = "--max-time"; argv[n++] = "320";
    argv[n++] = url; argv[n] = NULL;
    int st = 0;
    char *resp = web_curl_capture(argv, 330000, &st);
    unlink(tmpl);
    /* Cache only good reads: a "see_image error: …" body must never be frozen
     * into future hits. Page files are small (a few KB), cap 256. */
    if (resp && resp[0] && strncmp(resp, "see_image error", 15) != 0)
        pdf_cache_write(ppath, resp, ".txt", 256);
    return resp;
}

/* The page's extracted text layer via pdftotext (all pages, form-feed
 * separated), or NULL when pdftotext is missing/fails. -layout preserves
 * columns and table alignment, which the chat model reads far better. */
static char *pdf_text_layer(const char *pdfpath) {
    char tool[256];
    if (!pdf_find_tool("pdftotext", tool, sizeof tool)) return NULL;
    char *argv[] = { tool, "-layout", "-enc", "UTF-8", (char *)pdfpath, "-", NULL };
    int st = -1;
    char *o = web_curl_capture(argv, 60000, &st);
    if (st != 0) { free(o); return NULL; }
    return o;
}

/* Describe cache: ~/.dstudio/pdf-cache/<fnv16>.json holds the full response
 * JSON of a successful read, keyed by document bytes + vision model + caps
 * (NOT the question — reads are pure extraction/transcription, so any question
 * over the same document is the same read). pg-<fnv16>.txt holds single-page
 * vision transcriptions. Both pruned oldest-first per suffix. */
#define PDF_CACHE_MAX_FILES 32
static void pdf_cache_path(unsigned long long key, char *out, size_t outsz) {
    const char *home = getenv("HOME");
    snprintf(out, outsz, "%s/.dstudio/pdf-cache/%016llx.json", home ? home : ".", key);
}

static void pdf_cache_write(const char *cpath, const char *data, const char *suffix, int cap) {
    char dir[DSTUDIO_PATH_MAX];
    cstr_copy(dir, sizeof dir, cpath);
    char *slash = strrchr(dir, '/');
    if (!slash) return;
    *slash = '\0';
    char parent[DSTUDIO_PATH_MAX];
    cstr_copy(parent, sizeof parent, dir);
    char *pslash = strrchr(parent, '/');
    if (pslash) { *pslash = '\0'; (void)mkdir(parent, 0755); }
    (void)mkdir(dir, 0755);
    char tmp[DSTUDIO_PATH_MAX + 8];
    snprintf(tmp, sizeof tmp, "%s.tmp", cpath);
    int f = open(tmp, O_WRONLY | O_CREAT | O_TRUNC, 0644);
    if (f < 0) return;
    size_t len = strlen(data), off = 0;
    while (off < len) { ssize_t w = write(f, data + off, len - off); if (w <= 0) break; off += (size_t)w; }
    close(f);
    if (off != len) { unlink(tmp); return; }
    rename(tmp, cpath);
    /* Prune: drop the oldest same-suffix entries beyond the cap (tiny dir). */
    size_t sl = strlen(suffix);
    for (int guard = 0; guard < 16; guard++) {
        DIR *d = opendir(dir);
        if (!d) return;
        struct dirent *e;
        int count = 0;
        time_t oldest_t = 0;
        char oldest[DSTUDIO_PATH_MAX] = "";
        while ((e = readdir(d)) != NULL) {
            size_t l = strlen(e->d_name);
            if (l <= sl || strcmp(e->d_name + l - sl, suffix) != 0) continue;
            char p[DSTUDIO_PATH_MAX];
            if ((size_t)snprintf(p, sizeof p, "%s/%s", dir, e->d_name) >= sizeof p) continue;
            struct stat st;
            if (stat(p, &st) != 0) continue;
            count++;
            if (!oldest[0] || st.st_mtime < oldest_t) { oldest_t = st.st_mtime; cstr_copy(oldest, sizeof oldest, p); }
        }
        closedir(d);
        if (count <= cap || !oldest[0]) return;
        unlink(oldest);
    }
}

/* Error reply in the caller's format: JSON for the UI, plain text for the
 * agent's read_pdf tool (format:"text"). */
static void pdf_describe_fail(int fd, int want_text, const char *status, const char *msg) {
    if (want_text) {
        char m[640];
        snprintf(m, sizeof m, "read_pdf error: %s\n", msg);
        send_text(fd, status, m, 0);
    } else {
        web_json_error(fd, status, msg);
    }
}

/* POST /api/pdf/describe — hybrid read: text layer first, vision for scans. */
static void api_pdf_describe_run(int fd, const char *body, int allow_path) {
    char fmt[16] = "";
    (void)json_get_string(body, "format", fmt, sizeof fmt);
    int want_text = !strcmp(fmt, "text");

    char toppm[256];
    if (!pdf_find_tool("pdftoppm", toppm, sizeof toppm)) {
        pdf_describe_fail(fd, want_text, "503 Service Unavailable", pdf_poppler_hint());
        return;
    }
    /* NOTE: a body "question" is accepted but intentionally UNUSED: reads are
     * pure extraction/transcription (question-independent), so the cache works
     * across questions and the chat/agent model does the answering. */
    char jobid[64] = "", jobpath[DSTUDIO_PATH_MAX] = "";
    if (json_get_string(body, "job", jobid, sizeof jobid) && jobid[0])
        (void)pdf_job_path(jobid, jobpath, sizeof jobpath);

    int vcap = PDF_MAX_VISION_PAGES;
    const char *envc = getenv("DSTUDIO_PDF_MAX_PAGES");
    if (envc && envc[0]) { int v = atoi(envc); if (v > 0 && v <= PDF_MAX_VISION_PAGES_HARD) vcap = v; }

    int forbidden = 0;
    unsigned long long docfnv = 0;
    char *pdf = pdf_write_temp(body, allow_path, &forbidden, &docfnv);
    if (forbidden) { pdf_describe_fail(fd, want_text, "403 Forbidden", "path is host-local only; send data_uri"); return; }
    if (!pdf) { pdf_describe_fail(fd, want_text, "400 Bad Request", "a PDF (data_uri or host-local path) is required"); return; }
    pdf_job_write(jobpath, "{\"phase\":\"start\",\"done\":false}");

    /* Cache lookup — document bytes + vision model + caps (question-free: any
     * question over the same document is the same read). A hit skips rendering
     * AND the vision sidecar entirely. */
    unsigned long long key = docfnv;
    {
        char hf[256] = "";
        vision_hf_pref(hf, sizeof hf);
        /* Bump this salt on ANY pipeline-behavior change (thresholds, prompts,
         * classification): cached entries carry the OLD behavior and would
         * silently mask the fix for already-seen documents. */
        static const char *salt = "|hybrid-v3|";
        for (const char *s = salt; *s; s++)     { key ^= (unsigned char)*s; key *= 1099511628211ULL; }
        for (const char *s = hf; *s; s++)       { key ^= (unsigned char)*s; key *= 1099511628211ULL; }
        key ^= (unsigned long long)vcap;        key *= 1099511628211ULL;
    }
    char cpath[DSTUDIO_PATH_MAX];
    pdf_cache_path(key, cpath, sizeof cpath);
    {
        size_t cn = 0;
        char *cached = jsonl_read_file(cpath, &cn);
        if (cached && cn > 2 && cached[0] == '{') {
            (void)utimes(cpath, NULL);          /* LRU touch so pruning keeps hot docs */
            unlink(pdf); free(pdf);
            pdf_job_write(jobpath, "{\"phase\":\"done\",\"done\":true,\"cached\":true}");
            if (want_text) {
                char *t = json_get_string_alloc_rpc(cached, "text");
                send_text(fd, "200 OK", t && t[0] ? t : "(empty PDF)", 0);
                free(t);
            } else {
                json_dyn_buf hit = {0};
                if (json_dyn_puts(&hit, "{\"cached\":true,") && json_dyn_puts(&hit, cached + 1))
                    send_json(fd, "200 OK", hit.ptr);
                else
                    send_json(fd, "200 OK", cached);
                free(hit.ptr);
            }
            free(cached);
            return;
        }
        free(cached);
    }

    /* Total page count + page size via pdfinfo (drives the per-page walk, the
     * truncation note, and the figure-coverage math below). */
    int total = 0;
    double page_w_pts = 612, page_h_pts = 792;   /* Letter fallback */
    char pdfinfo[256];
    if (pdf_find_tool("pdfinfo", pdfinfo, sizeof pdfinfo)) {
        char *ia[] = { pdfinfo, pdf, NULL };
        int ist = 0; char *iout = web_curl_capture(ia, 20000, &ist);
        if (iout) {
            const char *p = strstr(iout, "Pages:");
            if (p) { int v = atoi(p + 6); if (v > 0) total = v; }
            const char *ps = strstr(iout, "Page size:");
            if (ps) {
                double w = 0, h = 0;
                if (sscanf(ps + 10, " %lf x %lf", &w, &h) == 2 && w > 1 && h > 1) {
                    page_w_pts = w; page_h_pts = h;
                }
            }
            free(iout);
        }
    }

    /* Text layer, split per page on pdftotext's form-feeds. pvis[] counts the
     * VISIBLE characters of each page: a page under PDF_TEXT_MIN_CHARS has no
     * usable text layer (scan / pure image) and goes to the vision model. */
    pdf_job_write(jobpath, "{\"phase\":\"text\",\"done\":false}");
    char *layer = pdf_text_layer(pdf);
    static const char *pstart[PDF_MAX_TOTAL_PAGES];
    static int plen[PDF_MAX_TOTAL_PAGES], pvis[PDF_MAX_TOTAL_PAGES];
    int tpages = 0;
    if (layer) {
        const char *p = layer;
        while (*p && tpages < PDF_MAX_TOTAL_PAGES) {
            const char *ff = strchr(p, '\f');
            size_t len = ff ? (size_t)(ff - p) : strlen(p);
            int vis = 0;
            for (size_t i = 0; i < len; i++)
                if (!isspace((unsigned char)p[i])) vis++;
            pstart[tpages] = p;
            plen[tpages] = (int)len;
            pvis[tpages] = vis;
            tpages++;
            if (!ff) break;
            p = ff + 1;                 /* a trailing form-feed ends the loop via *p */
        }
    }
    if (total < tpages) total = tpages;
    if (total <= 0) {
        free(layer); unlink(pdf); free(pdf);
        pdf_job_write(jobpath, "{\"phase\":\"error\",\"done\":true}");
        pdf_describe_fail(fd, want_text, "502 Bad Gateway", "could not read the PDF (no pages found)");
        return;
    }
    int npages = total > PDF_MAX_TOTAL_PAGES ? PDF_MAX_TOTAL_PAGES : total;

    /* Mixed pages: a TEXT page that also carries a meaningful raster image
     * (chart, diagram, photo) additionally gets a figures-only vision pass —
     * pdftotext alone would silently drop the visual content of such pages.
     * One pdfimages -list call per document; placed size = pixels / x-ppi,
     * page size from pdfinfo above. Threshold: >=5% of the page AND >=3 in²
     * (letterhead logos are ~1-2 in²; real inline charts measured at ~7-15 in²
     * — a 6.8x2.1in Gantt strip is only ~15% of an A4 page, so a bare
     * fraction-of-page rule missed it). Vector-drawn figures (no raster) are a
     * known blind spot: pdfimages cannot see them. */
    static unsigned char page_has_fig[PDF_MAX_TOTAL_PAGES];
    memset(page_has_fig, 0, sizeof page_has_fig);
    char pimg[256];
    if (pdf_find_tool("pdfimages", pimg, sizeof pimg)) {
        char *la[] = { pimg, "-list", pdf, NULL };
        int lst = 0; char *lout = web_curl_capture(la, 30000, &lst);
        if (lout) {
            double page_in2 = (page_w_pts / 72.0) * (page_h_pts / 72.0);
            for (char *line = lout; line && *line; ) {
                char *nl = strchr(line, '\n');
                if (nl) *nl = '\0';
                int pg = 0, num = 0, w = 0, h = 0, comp = 0, bpc = 0, obj = 0, oid = 0;
                char type[16] = "", color[16] = "", enc[16] = "", interp[8] = "";
                double xppi = 0, yppi = 0;
                if (sscanf(line, "%d %d %15s %d %d %15s %d %d %15s %7s %d %d %lf %lf",
                           &pg, &num, type, &w, &h, color, &comp, &bpc, enc, interp,
                           &obj, &oid, &xppi, &yppi) == 14 &&
                    !strcmp(type, "image") && pg >= 1 && pg <= npages &&
                    xppi > 1 && yppi > 1 && page_in2 > 0.1) {
                    double in2 = ((double)w / xppi) * ((double)h / yppi);
                    if (in2 / page_in2 >= 0.05 && in2 >= 3.0) page_has_fig[pg - 1] = 1;
                }
                line = nl ? nl + 1 : NULL;
            }
            free(lout);
        }
    }

    /* Count the vision passes up front so the work is announced (and the
     * sidecar started) only when actually needed: a plain digital PDF never
     * touches the multi-GB vision model. Scanned pages take one full-page
     * transcription pass; mixed text+figure pages take one figures-only pass. */
    int nvis_wanted = 0;
    for (int i = 0; i < npages; i++) {
        int is_text = (i < tpages && pvis[i] >= PDF_TEXT_MIN_CHARS);
        if (!is_text || page_has_fig[i]) nvis_wanted++;
    }
    int nvis = nvis_wanted > vcap ? vcap : nvis_wanted;

    char dir[] = "/tmp/dstudio-pdfr-XXXXXX";
    int have_dir = 0;
    if (nvis > 0) {
        pdf_job_write(jobpath, "{\"phase\":\"vision\",\"page\":0,\"pages\":%d,\"done\":false}", nvis);
        if (!vision_ensure_server(60000)) {
            free(layer); unlink(pdf); free(pdf);
            pdf_job_write(jobpath, "{\"phase\":\"error\",\"done\":true}");
            pdf_describe_fail(fd, want_text, "503 Service Unavailable",
                              "vision model is not running (needed for this PDF's scanned pages); "
                              "attach an image once or run vision setup");
            return;
        }
        if (!mkdtemp(dir)) {
            free(layer); unlink(pdf); free(pdf);
            pdf_job_write(jobpath, "{\"phase\":\"error\",\"done\":true}");
            pdf_describe_fail(fd, want_text, "500 Internal Server Error", "temp dir");
            return;
        }
        have_dir = 1;
    }

    json_dyn_buf text = {0};
    int ok = 1, text_used = 0, text_skipped = 0;
    int vdone = 0, vfail = 0, vskipped = 0, scan_pass = 0, fig_pass = 0, fig_skipped = 0;
    size_t text_bytes = 0;
    for (int i = 0; ok && i < npages; i++) {
        int is_text = (i < tpages && pvis[i] >= PDF_TEXT_MIN_CHARS);
        int wants_fig = is_text && page_has_fig[i];
        if (is_text) {
            if (text_bytes >= PDF_TEXT_TOTAL_CAP) { text_skipped++; continue; }
            size_t take = (size_t)plen[i];
            if (text_bytes + take > PDF_TEXT_TOTAL_CAP) take = PDF_TEXT_TOTAL_CAP - text_bytes;
            ok = json_dyn_printf(&text, "\n--- Pagina %d (testo) ---\n", i + 1) &&
                 json_dyn_putn(&text, pstart[i], take) &&
                 json_dyn_puts(&text, "\n");
            text_bytes += take;
            text_used++;
        }
        if (!ok || (is_text && !wants_fig)) continue;
        /* Vision pass: full transcription for scans, figures-only for mixed
         * text+figure pages (their body text already shipped above). */
        if (vdone >= vcap) {
            if (wants_fig) fig_skipped++; else vskipped++;
            continue;
        }
        vdone++;
        if (wants_fig) fig_pass++; else scan_pass++;
        pdf_job_write(jobpath, "{\"phase\":\"vision\",\"page\":%d,\"pages\":%d,\"done\":false}", vdone, nvis);
        char pfx[sizeof dir + 16], img[sizeof dir + 24];
        snprintf(pfx, sizeof pfx, "%s/pg%d", dir, i + 1);
        snprintf(img, sizeof img, "%s.jpg", pfx);
        /* Adaptive size: re-render smaller until the data URI fits the
         * loopback body budget (a photo-dense scan can exceed it at 1400px
         * even as JPEG). */
        static const int scales[]    = { 1400, 1000, 800 };
        static const int qualities[] = { 85,   78,   70  };
        char *uri = NULL;
        for (int a = 0; a < 3 && !uri; a++) {
            if (!pdf_render(toppm, pdf, pfx, i + 1, i + 1, scales[a], 1, 1, qualities[a])) break;
            char *u = pdf_img_data_uri(img);
            unlink(img);
            if (u && strlen(u) <= PDF_PAGE_B64_BUDGET) uri = u;
            else free(u);
        }
        char *vt = uri ? pdf_vision_page(uri, wants_fig) : NULL;
        free(uri);
        /* format=text errors come back as a "see_image error: …" body. */
        int good = vt && vt[0] && strncmp(vt, "see_image error", 15) != 0;
        if (!good) vfail++;
        ok = json_dyn_printf(&text, wants_fig
                                 ? "\n--- Pagina %d (figure/grafici, letti dal modello vision locale) ---\n"
                                 : "\n--- Pagina %d (scansione, letta dal modello vision locale) ---\n",
                             i + 1) &&
             json_dyn_puts(&text, good ? vt : (wants_fig ? "(figure non leggibili)" : "(pagina non leggibile)")) &&
             json_dyn_puts(&text, "\n");
        free(vt);
    }
    int pages_read = text_used + scan_pass;   /* distinct pages with content */
    int truncated = vskipped > 0 || fig_skipped > 0 || text_skipped > 0 || total > npages;
    if (ok && vskipped > 0)
        ok = json_dyn_printf(&text, "\n[PDF troncato: %d pagine scansionate oltre il limite di %d non lette.]\n",
                             vskipped, vcap);
    if (ok && fig_skipped > 0)
        ok = json_dyn_printf(&text, "\n[%d pagine con figure oltre il limite vision: incluso solo il loro testo.]\n",
                             fig_skipped);
    if (ok && text_skipped > 0)
        ok = json_dyn_printf(&text, "\n[Testo troncato: %d pagine di testo oltre il limite di %dKB omesse.]\n",
                             text_skipped, (int)(PDF_TEXT_TOTAL_CAP / 1024));
    if (ok && total > npages)
        ok = json_dyn_printf(&text, "\n[PDF troncato alle prime %d di %d pagine.]\n", npages, total);

    free(layer);
    if (have_dir) rmdir(dir);
    unlink(pdf); free(pdf);

    if (!ok) {
        free(text.ptr);
        pdf_job_write(jobpath, "{\"phase\":\"error\",\"done\":true}");
        pdf_describe_fail(fd, want_text, "500 Internal Server Error", "oom");
        return;
    }
    json_dyn_buf out = {0};
    int good = json_dyn_printf(&out, "{\"ok\":true,\"pages\":%d,\"total\":%d,\"textPages\":%d,"
                                     "\"visionPages\":%d,\"figPages\":%d,\"truncated\":%s,\"text\":",
                               pages_read, total, text_used, vdone, fig_pass,
                               truncated ? "true" : "false") &&
               json_dyn_put_escaped(&out, text.ptr ? text.ptr : "") &&
               json_dyn_puts(&out, "}");
    if (!good) {
        free(text.ptr); free(out.ptr);
        pdf_job_write(jobpath, "{\"phase\":\"error\",\"done\":true}");
        pdf_describe_fail(fd, want_text, "500 Internal Server Error", "oom");
        return;
    }
    /* Cache only clean, non-empty reads: a transient vision failure must not
     * freeze "(pagina non leggibile)" into every future hit. (Successful pages
     * are still cached individually by pdf_vision_page, so a retry after a
     * partial failure redoes only the failed pages.) */
    if (vfail == 0 && pages_read > 0) pdf_cache_write(cpath, out.ptr, ".json", PDF_CACHE_MAX_FILES);
    pdf_job_write(jobpath, "{\"phase\":\"done\",\"done\":true}");
    if (want_text) send_text(fd, "200 OK", text.ptr && text.ptr[0] ? text.ptr : "(empty PDF)", 0);
    else           send_json(fd, "200 OK", out.ptr);
    free(text.ptr);
    free(out.ptr);
}

/* Fork a detached worker (rendering + per-page vision are slow) — like vision. */
static void api_pdf_fork(int fd, const char *body, int is_describe, int allow_path) {
    pid_t pid = fork();
    if (pid < 0) { if (is_describe) api_pdf_describe_run(fd, body, allow_path); else api_pdf_thumb_run(fd, body, allow_path); return; }
    if (pid == 0) {
        if (fork() > 0) _exit(0);
        if (g_srv_fd >= 0) close(g_srv_fd);
        if (g_out_fd >= 0) close(g_out_fd);
        if (g_err_fd >= 0) close(g_err_fd);
        if (g_in_fd  >= 0) close(g_in_fd);
        struct timeval tv = { 620, 0 };
        (void)setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof tv);
        if (is_describe) api_pdf_describe_run(fd, body, allow_path);
        else             api_pdf_thumb_run(fd, body, allow_path);
        close(fd);
        _exit(0);
    }
    waitpid(pid, NULL, 0);
}
#endif /* !_WIN32 */

static void api_pdf_thumb(int fd, const char *body) {
#ifdef _WIN32
    (void)body;
    web_json_error(fd, "501 Not Implemented", "PDF is not available on the Windows build yet");
#else
    api_pdf_fork(fd, body, 0, client_is_loopback(fd));
#endif
}
static void api_pdf_describe(int fd, const char *body) {
#ifdef _WIN32
    (void)body;
    web_json_error(fd, "501 Not Implemented", "PDF is not available on the Windows build yet");
#else
    vision_touch_last_use();
    api_pdf_fork(fd, body, 1, client_is_loopback(fd));
#endif
}

/* GET /api/pdf/progress?job=<id> — the live state of a running describe (the
 * worker rewrites the job file at every step). Host-local surface for the UI's
 * per-page progress label. */
static void api_pdf_progress(int fd, const char *path) {
#ifdef _WIN32
    (void)path;
    web_json_error(fd, "501 Not Implemented", "PDF is not available on the Windows build yet");
#else
    const char *q = strchr(path, '?');
    char jobid[64] = "";
    if (q) {
        const char *j = strstr(q, "job=");
        if (j) {
            j += 4;
            size_t o = 0;
            while (*j && *j != '&' && o < sizeof jobid - 1) jobid[o++] = *j++;
            jobid[o] = '\0';
        }
    }
    char jobpath[DSTUDIO_PATH_MAX];
    if (!jobid[0] || !pdf_job_path(jobid, jobpath, sizeof jobpath)) {
        web_json_error(fd, "400 Bad Request", "job id is required");
        return;
    }
    size_t n = 0;
    char *b = jsonl_read_file(jobpath, &n);
    if (!b || n == 0 || b[0] != '{') {
        free(b);
        send_json(fd, "200 OK", "{\"phase\":\"unknown\",\"done\":false}");
        return;
    }
    send_json(fd, "200 OK", b);
    free(b);
#endif
}

static void api_agent_attach_image(int fd, const char *body) {
#ifdef _WIN32
    (void)body;
    web_json_error(fd, "501 Not Implemented", "not available in the Windows build yet");
#else
    char dir[DSTUDIO_PATH_MAX] = "";
    if (!json_get_string(body, "dir", dir, sizeof dir) || dir[0] != '/') {
        web_json_error(fd, "400 Bad Request", "dir (absolute workspace path) is required");
        return;
    }
    struct stat st;
    if (stat(dir, &st) != 0 || !S_ISDIR(st.st_mode)) {
        web_json_error(fd, "400 Bad Request", "workspace dir does not exist");
        return;
    }
    char *data = json_get_string_alloc_rpc(body, "data_uri");
    if (!data || !data[0]) {
        free(data);
        web_json_error(fd, "400 Bad Request", "data_uri is required");
        return;
    }
    const char *b64 = data;
    char mime[64] = "image/png";
    if (!strncmp(data, "data:", 5)) {
        const char *comma = strchr(data, ',');
        if (!comma) { free(data); web_json_error(fd, "400 Bad Request", "malformed data URI"); return; }
        const char *semi = strchr(data, ';');
        const char *mend = (semi && semi < comma) ? semi : comma;
        size_t ml = (size_t)(mend - (data + 5));
        if (ml > 0 && ml < sizeof mime) { memcpy(mime, data + 5, ml); mime[ml] = '\0'; }
        b64 = comma + 1;
    }
    if (strncmp(mime, "image/", 6) != 0) {
        free(data);
        web_json_error(fd, "415 Unsupported Media Type", "only images are accepted");
        return;
    }
    size_t blen = 0;
    char *bytes = base64_decode(b64, &blen);
    free(data);
    if (!bytes || blen == 0 || blen > 16u * 1024 * 1024) {
        free(bytes);
        web_json_error(fd, "400 Bad Request", "invalid or oversized image payload (16MB max)");
        return;
    }

    char reqname[300] = "";
    (void)json_get_string(body, "name", reqname, sizeof reqname);
    char name[128];
    agent_attach_image_name(reqname, mime, name, sizeof name);

    /* O_EXCL collision loop: never overwrite something already in the workspace. */
    char final[160], full[DSTUDIO_PATH_MAX + 176];
    int wfd = -1;
    for (int i = 0; i < 100; i++) {
        if (i == 0) cstr_copy(final, sizeof final, name);
        else {
            char stem[128];
            cstr_copy(stem, sizeof stem, name);
            char *dot = strrchr(stem, '.');
            const char *ext = "";
            if (dot) { *dot = '\0'; ext = dot + 1; }
            if (ext[0]) snprintf(final, sizeof final, "%s-%d.%s", stem, i + 1, ext);
            else snprintf(final, sizeof final, "%s-%d", stem, i + 1);
        }
        snprintf(full, sizeof full, "%s/%s", dir, final);
        wfd = open(full, O_WRONLY | O_CREAT | O_EXCL, 0644);
        if (wfd >= 0 || errno != EEXIST) break;
    }
    if (wfd < 0) {
        free(bytes);
        web_json_error(fd, "500 Internal Server Error", "cannot create the image file");
        return;
    }
    size_t off = 0;
    while (off < blen) {
        ssize_t w = write(wfd, bytes + off, blen - off);
        if (w <= 0) break;
        off += (size_t)w;
    }
    close(wfd);
    free(bytes);
    if (off < blen) {
        unlink(full);
        web_json_error(fd, "500 Internal Server Error", "short write");
        return;
    }

    json_dyn_buf b = {0};
    int okb = json_dyn_printf(&b, "{\"ok\":true,\"bytes\":%lld,\"name\":", (long long)blen) &&
              json_dyn_put_escaped(&b, final) &&
              json_dyn_puts(&b, ",\"rel\":") &&
              json_dyn_printf(&b, "\"./%s\"", final) &&   /* sanitized: no quotes/backslashes */
              json_dyn_puts(&b, ",\"path\":") &&
              json_dyn_put_escaped(&b, full) &&
              json_dyn_puts(&b, "}");
    if (!okb) { free(b.ptr); web_json_error(fd, "500 Internal Server Error", "out of memory"); return; }
    send_json(fd, "200 OK", b.ptr);
    free(b.ptr);
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
        dstudio_log_event("error", "proxy", 0, "/v1 proxy could not connect to local engine port %d", eport);
        const char *body = "{\"error\":{\"message\":\"the local ds4 engine is not running\"}}";
        if (cors) {
            send_response_hdrs(client_fd, "503 Service Unavailable", "application/json; charset=utf-8",
                               body, strlen(body), 0, CORS_HEADERS);
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

static int read_request_body_alloc(int fd, const char *req, size_t got, size_t header_len,
                                   long clen, long max_len, const char *too_large_msg,
                                   char **out, size_t *out_len) {
    if (out) *out = NULL;
    if (out_len) *out_len = 0;
    if (clen < 0 || clen > max_len) {
        send_text(fd, "413 Payload Too Large", too_large_msg, 0);
        return 0;
    }
    char *buf = malloc((size_t)clen + 1);
    if (!buf) {
        send_json(fd, "500 Internal Server Error", "{\"ok\":false}");
        return 0;
    }
    size_t have = got > header_len ? got - header_len : 0;
    if (have > (size_t)clen) have = (size_t)clen;
    if (have) memcpy(buf, req + header_len, have);
    size_t off = have, left = (size_t)clen - have;
    while (left > 0) {
        ssize_t n = recv(fd, buf + off, left, 0);
        if (n <= 0) break;
        off += (size_t)n;
        left -= (size_t)n;
    }
    if (left > 0) {
        free(buf);
        send_text(fd, "400 Bad Request", "body read incomplete\n", 0);
        return 0;
    }
    buf[off] = '\0';
    if (out) *out = buf;
    else free(buf);
    if (out_len) *out_len = off;
    return 1;
}

static int route_post_api(int fd, const char *path, const char *body) {
    if (!strcmp(path, "/api/start"))       { api_start(fd, body); return 200; }
    if (!strcmp(path, "/api/user-skills/delete")) { api_user_skill_delete(fd, body); return 200; }
    if (!strcmp(path, "/api/user-skills")) { api_user_skill_save(fd, body); return 200; }
    if (!strcmp(path, "/api/gsa/tools/install")) { api_gsa_tools_install(fd); return 200; }
    if (!strcmp(path, "/api/updates/run")) { api_updates_run(fd, body); return 200; }
    if (!strcmp(path, "/api/iogpu-wired-limit")) { api_iogpu_wired_limit(fd, body); return 200; }
    if (!strcmp(path, "/api/gsa/start"))   { api_gsa_start(fd, body); return 200; }
    if (!strcmp(path, "/api/gsa/phase"))   { api_gsa_phase(fd, body); return 200; }
    if (!strcmp(path, "/api/rsa/start"))   { api_rsa_start(fd, body); return 200; }
    if (!strcmp(path, "/api/rsa/phase"))   { api_rsa_phase(fd, body); return 200; }
    if (!strcmp(path, "/api/stop"))        { api_stop(fd); return 200; }
    if (!strcmp(path, "/api/agent/send"))  { api_agent_send(fd, body); return 200; }
    if (!strcmp(path, "/api/agent/interrupt")) { api_agent_interrupt(fd, body); return 200; }
    if (!strcmp(path, "/api/design/session")) { api_design_session(fd, body); return 200; }
    if (!strcmp(path, "/api/design/clean")) { api_design_clean(fd); return 200; }
    if (!strcmp(path, "/api/design/import")) { api_design_import(fd, body); return 200; }
    if (!strcmp(path, "/api/model/download")) { api_model_download(fd, body); return 200; }
    if (!strcmp(path, "/api/fs/list")) { api_fs_list(fd, body); return 200; }
    if (!strcmp(path, "/api/fs/mkdir")) { api_fs_mkdir(fd, body); return 200; }
    if (!strcmp(path, "/api/ds4/setup")) { api_setup_ds4(fd); return 200; }
    if (!strcmp(path, "/api/glm/setup")) { api_setup_glm(fd); return 200; }
    if (!strcmp(path, "/api/vision/setup")) { api_vision_setup(fd, body); return 200; }
    if (!strcmp(path, "/api/vision/describe")) { api_vision_describe(fd, body); return 200; }
    if (!strcmp(path, "/api/vision/stop")) { api_vision_stop(fd); return 200; }
    if (!strcmp(path, "/api/embed/setup")) { api_embed_setup(fd, body); return 200; }
    if (!strcmp(path, "/api/embed/stop")) { api_embed_stop(fd); return 200; }
    if (!strcmp(path, "/api/engine/checkout")) { api_engine_checkout_set(fd, body); return 200; }
    if (!strcmp(path, "/api/setup/content")) { api_setup_content(fd); return 200; }
    if (!strcmp(path, "/api/webdir")) { api_set_webdir(fd, body); return 200; }
    if (!strcmp(path, "/api/web-search")) { api_web_search(fd, body); return 200; }
    if (!strcmp(path, "/api/web-read")) { api_web_read(fd, body); return 200; }
    if (!strcmp(path, "/api/http-probe")) { api_http_probe(fd, body); return 200; }
    if (!strcmp(path, "/api/lan")) { api_lan(fd, body); return 200; }
    if (!strcmp(path, "/api/remote")) { api_remote_control(fd, body); return 200; }
    if (!strcmp(path, "/api/wipe")) { api_wipe(fd); return 200; }
    send_json(fd, "404 Not Found", "{\"ok\":false,\"error\":\"unknown endpoint\"}");
    return 404;
}

static int route_get_or_static(int fd, const char *method, const char *path, int head_only) {
    const int is_get = !strcmp(method, "GET") || head_only;
    if (is_get && !strcmp(path, "/api/store")) {
        api_store_get(fd);
        return 200;
    }
    if (is_get && !strcmp(path, "/api/storerev")) {
        char out[48]; snprintf(out, sizeof out, "{\"rev\":%ld}", g_store_rev);
        send_json(fd, "200 OK", out);
        return 200;
    }
    if (is_get && !strcmp(path, "/api/vision/status")) { api_vision_status(fd); return 200; }
    if (is_get && path_eq_clean(path, "/api/pdf/progress")) { api_pdf_progress(fd, path); return 200; }
    if (is_get && !strcmp(path, "/api/embed/status")) { api_embed_status(fd); return 200; }
    if (is_get && path_eq_clean(path, "/api/remote/status")) { api_remote_status(fd); return 200; }
    if (is_get && path_eq_clean(path, "/api/remote/chat")) { api_remote_chat_get(fd); return 200; }
    if (is_get && path_eq_clean(path, "/api/lan-client/chats")) { api_lan_client_chats_get(fd); return 200; }
    if (is_get && !strcmp(path, "/api/status")) { api_status(fd); return 200; }
    if (is_get && path_eq_clean(path, "/api/lan-health")) { api_lan_health(fd); return 200; }
    if (is_get && !strcmp(path, "/api/doctor")) { api_doctor(fd); return 200; }
    if (is_get && path_eq_clean(path, "/api/diagnostics")) { api_diagnostics(fd); return 200; }
    if (is_get && path_eq_clean(path, "/api/updates/check")) { api_updates_check(fd); return 200; }
    if (is_get && path_eq_clean(path, "/api/logs/stream")) { api_stream_logs(fd, path); return 200; }
    if (is_get && path_eq_clean(path, "/api/logs")) { api_logs(fd, path); return 200; }
    if (is_get && path_eq_clean(path, "/api/tasks/stream")) { api_stream_tasks(fd, path); return 200; }
    if (is_get && path_eq_clean(path, "/api/tasks")) { api_tasks(fd, path); return 200; }
    if (is_get && path_eq_clean(path, "/api/task")) { api_task(fd, path); return 200; }
    if (is_get && !strcmp(path, "/api/ggufs")) { api_ggufs(fd); return 200; }
    if (is_get && path_eq_clean(path, "/api/engine/checkouts")) { api_engine_checkouts(fd); return 200; }
    if (is_get && path_eq_clean(path, "/api/skills/search")) { api_skills_search(fd, path); return 200; }
    if (is_get && !strncmp(path, "/api/skill-preview/", 19)) { api_skill_preview(fd, path, head_only); return 200; }
    if (is_get && !strncmp(path, "/api/design-system-preview/", 27)) { api_design_system_preview(fd, path, head_only); return 200; }
    if (is_get && !strncmp(path, "/api/skills/get", 15)) { api_skill_get(fd, path); return 200; }
    if (is_get && path_eq_clean(path, "/api/gsa/tools")) { api_gsa_tools(fd); return 200; }
    if (is_get && path_eq_clean(path, "/api/rsa/tools")) { api_rsa_tools(fd); return 200; }
    if (is_get && !strcmp(path, "/api/skills")) { api_skills(fd); return 200; }
    if (is_get && !strcmp(path, "/api/design-systems")) { api_design_systems(fd); return 200; }
    if (is_get && !strcmp(path, "/api/craft")) { api_craft(fd); return 200; }
    if (is_get && !strncmp(path, "/api/user-skills/get", 20)) { api_user_skill_get(fd, path); return 200; }
    if (is_get && !strcmp(path, "/api/user-skills")) { api_user_skills(fd); return 200; }
    if (is_get && !strncmp(path, "/api/agent/poll", 15)) { api_agent_poll(fd, path); return 200; }
    if (is_get && !strcmp(path, "/api/design/status")) { api_design_status(fd); return 200; }
    if (is_get && !strncmp(path, "/api/design/events", 18)) { api_design_events(fd, path); return 200; }
    if (is_get && !strcmp(path, "/api/design/state")) { api_design_state(fd); return 200; }
    if (is_get && !strcmp(path, "/api/design/artifacts")) { api_design_artifacts(fd); return 200; }
    if (is_get && !strcmp(path, "/api/design/files")) { api_design_files(fd); return 200; }
    if (is_get && !strncmp(path, "/api/design/preview/", 20)) { api_design_preview_file(fd, path, head_only); return 200; }
    if (is_get && !strncmp(path, "/api/design/file?", 17)) { api_design_file(fd, path, head_only); return 200; }
    if (!head_only && strcmp(method, "GET") != 0) {
        send_text(fd, "405 Method Not Allowed", "method not allowed\n", 0);
        return 405;
    }
    if (remote_page_path(path)) {
        serve_remote_page(fd, head_only);
        return 200;
    }
    if (loading_page_path(path)) {
        size_t len = 0;
        char *page = read_loading_page(&len);
        if (!page) { send_text(fd, "500 Internal Server Error", "loading.html not readable\n", head_only); return 500; }
        send_response(fd, "200 OK", "text/html; charset=utf-8", page, len, head_only);
        free(page);
        return 200;
    }
    if (lan_root_path(path)) {
        size_t len = 0;
        char *page = read_page(&len);
        if (!page) { send_text(fd, "500 Internal Server Error", "index.html not readable\n", head_only); return 500; }
        send_response(fd, "200 OK", "text/html; charset=utf-8", page, len, head_only);
        free(page);
        return 200;
    }
    send_text(fd, "404 Not Found", "not found\n", head_only);
    return 404;
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
        send_response_hdrs(fd, "204 No Content", "text/plain; charset=utf-8", "", 0, 0,
                           "Access-Control-Allow-Origin: *\r\n"
                           "Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n"
                           "Access-Control-Allow-Headers: Content-Type, Accept, X-Requested-With\r\n"
                           "Access-Control-Max-Age: 600\r\n");
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
        char *buf = NULL;
        size_t off = 0;
        if (!read_request_body_alloc(fd, req, got, header_len, clen, 8L * 1024 * 1024,
                                     "remote chat too large\n", &buf, &off))
        {
            close(fd);
            return;
        }
        api_remote_chat_set(fd, buf, off, local_client);
        close(fd);
        return;
    }

    /* LAN clients keep their own local stores and publish snapshots here so the
     * host can inspect their chat/agent/design conversations. This endpoint is
     * intentionally separate from /api/store: non-loopback clients can POST
     * their snapshot, but only the host-local UI can GET the aggregate. */
    if (!strcmp(method, "POST") && path_eq_clean(path, "/api/lan-client/chats")) {
        char *buf = NULL;
        size_t off = 0;
        if (!read_request_body_alloc(fd, req, got, header_len, clen, 16L * 1024 * 1024,
                                     "LAN client snapshot too large\n", &buf, &off))
        {
            close(fd);
            return;
        }
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
        char *buf = NULL;
        size_t off = 0;
        if (!read_request_body_alloc(fd, req, got, header_len, clen, 64L * 1024 * 1024,
                                     "store too large\n", &buf, &off))
        {
            close(fd);
            return;
        }
        api_store_set(fd, buf, off);   /* takes ownership of buf */
        close(fd);
        return;
    }

    /* POST /api/agent/attach-image carries a full-resolution image (base64) —
     * larger than BODY_MAX, so it reads its own body like /api/store. It is not
     * in the LAN allowlist, so non-loopback clients were already rejected above. */
    if (!strcmp(method, "POST") && path_eq_clean(path, "/api/agent/attach-image")) {
        if (!header_has(req, header_len, "x-requested-with: ds4web")) {
            send_json(fd, "403 Forbidden", "{\"ok\":false,\"error\":\"unauthorized\"}"); close(fd); return;
        }
        char *buf = NULL;
        size_t off = 0;
        if (!read_request_body_alloc(fd, req, got, header_len, clen, 24L * 1024 * 1024,
                                     "image too large\n", &buf, &off))
        {
            close(fd);
            return;
        }
        api_agent_attach_image(fd, buf);
        free(buf);
        close(fd);
        return;
    }

    /* POST /api/pdf/{thumb,describe} carry a full PDF (base64) — larger than
     * BODY_MAX, so they read their own body like /api/store. Cap 1.5GB: the UI
     * allows PDFs up to 1GB binary, which is ~1.37GB once base64'd (x4/3) plus
     * JSON overhead. Local-first trade-off: the worker briefly holds body +
     * decoded copies in RAM, so a 1GB PDF peaks at a few GB in the forked
     * child. CSRF-guarded; LAN clients reach these only via the allowlist
     * (data_uri-only enforced inside). */
    if (!strcmp(method, "POST") &&
        (path_eq_clean(path, "/api/pdf/thumb") || path_eq_clean(path, "/api/pdf/describe"))) {
        if (!header_has(req, header_len, "x-requested-with: ds4web")) {
            send_json(fd, "403 Forbidden", "{\"ok\":false,\"error\":\"unauthorized\"}"); close(fd); return;
        }
        char *buf = NULL;
        size_t off = 0;
        if (!read_request_body_alloc(fd, req, got, header_len, clen, 1536L * 1024 * 1024,
                                     "pdf too large\n", &buf, &off))
        {
            close(fd);
            return;
        }
        if (path_eq_clean(path, "/api/pdf/thumb")) api_pdf_thumb(fd, buf);
        else                                       api_pdf_describe(fd, buf);
        free(buf);
        close(fd);
        return;
    }

    if (clen < 0 || clen > BODY_MAX) { send_text(fd, "413 Payload Too Large", "body too large\n", 0); close(fd); return; }
    char *body_buf = NULL;
    const char *body = "";
    if (clen > 0) {
        if (!read_request_body_alloc(fd, req, got, header_len, clen, BODY_MAX,
                                     "body too large\n", &body_buf, NULL))
        {
            close(fd);
            return;
        }
        body = body_buf;
    }

    int head_only = !strcmp(method, "HEAD");
    int status = 200;

    if (!strcmp(method, "POST") && !strncmp(path, "/api/", 5)) {
        if (!header_has(req, header_len, "x-requested-with: ds4web")) {
            send_json(fd, "403 Forbidden", "{\"ok\":false,\"error\":\"unauthorized\"}");
            status = 403;
        } else {
            status = route_post_api(fd, path, body);
        }
    } else {
        status = route_get_or_static(fd, method, path, head_only);
    }

    /* fd adopted by the SSE registry: the main loop owns it now */
    if (g_sse_adopt) { g_sse_adopt = 0; free(body_buf); return; }
    if (g_diag_sse_adopt) { g_diag_sse_adopt = 0; free(body_buf); return; }

    /* compact log, I exclude polling so as not to flood the terminal */
    if (strncmp(path, "/api/agent/poll", 15) != 0 && strcmp(path, "/api/status") != 0 &&
        strcmp(path, "/api/design/status") != 0 && strcmp(path, "/api/design/files") != 0 &&
        strncmp(path, "/api/design/preview/", 20) != 0 &&
        strncmp(path, "/api/design/events", 18) != 0 &&
        strcmp(path, "/api/design/state") != 0 && strcmp(path, "/api/design/artifacts") != 0 &&
        strcmp(path, "/api/store") != 0 && strcmp(path, "/api/storerev") != 0 &&
        strcmp(path, "/api/lan-client/chats") != 0 &&
        strcmp(path, "/api/lan-health") != 0 &&
        strcmp(path, "/api/doctor") != 0)
        printf("%d %s %s\n", status, method, path);
    free(body_buf);
    close(fd);
}

/* GUI-launched DStudio inherits a minimal launchd PATH without Homebrew, so
 * tools invoked via `#!/usr/bin/env node` (e.g. the GSA playwright validation
 * adapter) fail with exit 127 "node: No such file or directory". Resolve node
 * once at startup and prepend its directory to PATH, so both the GSA validation
 * executor (which runs in this process) and the spawned agent's bash tools
 * (which inherit this environment) can find it. */
static void ensure_node_on_path(void) {
    static const char *node_dirs[] = {
        "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin",
        "/opt/local/bin", "/snap/bin", NULL
    };
    char node_bin[PATH_MAX];
    if (!resolve_program_path("node", node_dirs, node_bin, sizeof node_bin)) return;
    char *slash = strrchr(node_bin, '/');
    if (!slash || slash == node_bin) return;
    *slash = '\0';                       /* node_bin is now node's directory */
    const char *cur = getenv("PATH");
    if (cur && cur[0]) {
        size_t dlen = strlen(node_bin);
        for (const char *p = cur; p; ) {
            const char *sep = strchr(p, ':');
            size_t seglen = sep ? (size_t)(sep - p) : strlen(p);
            if (seglen == dlen && strncmp(p, node_bin, dlen) == 0) return; /* already present */
            p = sep ? sep + 1 : NULL;
        }
    }
    char buf[PATH_MAX + 4096];
    snprintf(buf, sizeof buf, "%s%s%s", node_bin, (cur && cur[0]) ? ":" : "", cur ? cur : "");
    setenv("PATH", buf, 1);
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
        resolve_web_dir();
        if (argc > 2) { snprintf(g_ds4_dir, sizeof g_ds4_dir, "%s", argv[2]); g_ds4_dir_explicit = 1; }
        resolve_ds4_dir();
        int ok = run_build_jsonl("build");
        printf("build-jsonl: %s\n", ok ? "ok" : "FAILED");
        return ok ? 0 : 1;
    }
    /* CI/dev: check the patch anchors against a ds4 checkout WITHOUT building
     * anything (no model, no .o). Exit 0 if the patch would apply, 1 otherwise. */
    if (argc > 1 && strcmp(argv[1], "--check-anchors") == 0) {
        resolve_web_dir();
        if (argc > 2) { snprintf(g_ds4_dir, sizeof g_ds4_dir, "%s", argv[2]); g_ds4_dir_explicit = 1; }
        resolve_ds4_dir();
        char src[2200], web_src[2200];
        snprintf(src, sizeof src, "%s/ds4_agent.c", g_ds4_dir);
        snprintf(web_src, sizeof web_src, "%s/ds4_web.c", g_ds4_dir);
        printf("check-anchors: ds4_agent.c = %s\n", src);
        int fails = jsonl_check_anchors(src);
        printf("check-anchors: ds4_web.c = %s\n", web_src);
        int web_fails = web_cdp_check_anchors(web_src);
        return fails == 0 && web_fails == 0 ? 0 : 1;
    }
    ensure_node_on_path();   /* so GSA node-based tools (playwright) resolve under a GUI launch */
    int port = DEFAULT_PORT;
    if (argc > 1) {
        char *end = NULL;
        long p = strtol(argv[1], &end, 10);
        if (end == argv[1] || *end != '\0' || p < 1 || p > 65535) {
            fprintf(stderr, "invalid port: %s\n", argv[1]); return 1;
        }
        port = (int)p;
    }
    resolve_web_dir();   /* same for extension/ scripts (build-design.sh) */
    if (argc > 2) { snprintf(g_ds4_dir, sizeof g_ds4_dir, "%s", argv[2]); g_ds4_dir_explicit = 1; }
    resolve_ds4_dir();   /* launch from Finder/bundle: cwd = "/", the relative one must be resolved */
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

    /* First-run / fresh-clone: the skill packs, design systems and imported GSA
     * skills are NOT committed — download them now (in the background so the
     * server stays responsive). The doctor/onboarding also exposes a manual
     * retry via /api/setup/content. */
    if (!test_mode && !content_present()) {
        set_stage("Downloading skills & design systems…", 3);
        printf("content: bundled skills/design-systems/gsa not found — downloading in background\n");
        start_content_download();
    }

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
            set_stage("Ready", 100); g_ready = 1; maybe_complete_launch_task(ENGINE_SERVER);
        }

        if (pfd[0].revents & POLLIN) {
            int fd = accept(g_srv_fd, NULL, NULL);
            if (fd >= 0) { drain_child(); handle_connection(fd); }
        }

        /* push to the SSE clients: new pipe data wakes poll() immediately,
         * so streamed agent output has chat-like latency. */
        sse_flush();
        diag_sse_flush();
    }
    sse_close_all();
    diag_sse_close_all();
    stop_child();
    return 0;
}

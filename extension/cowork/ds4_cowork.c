#define _POSIX_C_SOURCE 200809L

#include "ds4_cowork.h"

#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

#ifndef PATH_MAX
#define PATH_MAX 4096
#endif

#define COWORK_OUTPUT_MAX (1024U * 1024U)

typedef struct {
    char *ptr;
    size_t len;
    size_t cap;
} cowork_buf;

static void *cowork_realloc(void *p, size_t n) {
    void *q = realloc(p, n ? n : 1);
    if (!q) {
        free(p);
        return NULL;
    }
    return q;
}

static bool cowork_buf_append(cowork_buf *b, const char *s, size_t n) {
    if (!n) return true;
    if (b->len + n + 1 > b->cap) {
        size_t cap = b->cap ? b->cap * 2 : 4096;
        while (cap < b->len + n + 1) {
            if (cap > COWORK_OUTPUT_MAX * 4U) return false;
            cap *= 2;
        }
        char *next = cowork_realloc(b->ptr, cap);
        if (!next) {
            b->ptr = NULL;
            b->len = b->cap = 0;
            return false;
        }
        b->ptr = next;
        b->cap = cap;
    }
    memcpy(b->ptr + b->len, s, n);
    b->len += n;
    b->ptr[b->len] = '\0';
    return true;
}

static bool cowork_buf_puts(cowork_buf *b, const char *s) {
    return cowork_buf_append(b, s ? s : "", s ? strlen(s) : 0);
}

static char *cowork_buf_take(cowork_buf *b) {
    if (!b->ptr) {
        char *empty = malloc(1);
        if (empty) empty[0] = '\0';
        return empty;
    }
    char *out = b->ptr;
    b->ptr = NULL;
    b->len = b->cap = 0;
    return out;
}

static char *cowork_message(const char *prefix, const char *detail) {
    cowork_buf b = {0};
    if (!cowork_buf_puts(&b, prefix ? prefix : "Cowork tool error")) return NULL;
    if (detail && detail[0]) {
        cowork_buf_puts(&b, ": ");
        cowork_buf_puts(&b, detail);
    }
    cowork_buf_puts(&b, "\n");
    return cowork_buf_take(&b);
}

static bool cowork_json_escape(cowork_buf *b, const char *s) {
    for (const unsigned char *p = (const unsigned char *)(s ? s : ""); *p; p++) {
        char esc[8];
        switch (*p) {
            case '"': if (!cowork_buf_puts(b, "\\\"")) return false; break;
            case '\\': if (!cowork_buf_puts(b, "\\\\")) return false; break;
            case '\b': if (!cowork_buf_puts(b, "\\b")) return false; break;
            case '\f': if (!cowork_buf_puts(b, "\\f")) return false; break;
            case '\n': if (!cowork_buf_puts(b, "\\n")) return false; break;
            case '\r': if (!cowork_buf_puts(b, "\\r")) return false; break;
            case '\t': if (!cowork_buf_puts(b, "\\t")) return false; break;
            default:
                if (*p < 0x20) {
                    snprintf(esc, sizeof esc, "\\u%04x", *p);
                    if (!cowork_buf_puts(b, esc)) return false;
                } else if (!cowork_buf_append(b, (const char *)p, 1)) {
                    return false;
                }
        }
    }
    return true;
}

static bool cowork_write_all(int fd, const char *p, size_t n) {
    while (n) {
        ssize_t wrote = write(fd, p, n);
        if (wrote < 0 && errno == EINTR) continue;
        if (wrote <= 0) return false;
        p += wrote;
        n -= (size_t)wrote;
    }
    return true;
}

int ds4_cowork_tool_known(const char *name) {
    return name && (!strcmp(name, "excel") ||
                    !strcmp(name, "spreadsheet") ||
                    !strcmp(name, "read_document") ||
                    !strcmp(name, "write_document") ||
                    !strcmp(name, "write_pdf") ||
                    !strcmp(name, "presentation"));
}

static char *cowork_build_request(const char *tool,
                                  const ds4_cowork_arg *args,
                                  size_t nargs) {
    cowork_buf b = {0};
    if (!cowork_buf_puts(&b, "{\"protocol\":\"ds4.cowork.tool.v1\",\"tool\":\""))
        return NULL;
    if (!cowork_json_escape(&b, tool) || !cowork_buf_puts(&b, "\",\"args\":{")) {
        free(b.ptr);
        return NULL;
    }
    bool first = true;
    for (size_t i = 0; i < nargs; i++) {
        if (!args[i].name || !args[i].name[0] || !args[i].value) continue;
        if (!first && !cowork_buf_puts(&b, ",")) goto oom;
        first = false;
        if (!cowork_buf_puts(&b, "\"") ||
            !cowork_json_escape(&b, args[i].name) ||
            !cowork_buf_puts(&b, "\":\"") ||
            !cowork_json_escape(&b, args[i].value) ||
            !cowork_buf_puts(&b, "\"")) goto oom;
    }
    if (!cowork_buf_puts(&b, "}}\n")) goto oom;
    return cowork_buf_take(&b);
oom:
    free(b.ptr);
    return NULL;
}

static int cowork_wait(pid_t pid, int *status) {
    pid_t got;
    do { got = waitpid(pid, status, 0); } while (got < 0 && errno == EINTR);
    return got == pid;
}

char *ds4_cowork_execute(const char *tool,
                         const ds4_cowork_arg *args,
                         size_t nargs,
                         const char *workspace) {
    if (!ds4_cowork_tool_known(tool))
        return cowork_message("Cowork tool error", "unknown Office tool");

    const char *helper = getenv("DS4UI_COWORK_HELPER");
    if (!helper || !helper[0])
        return cowork_message("Cowork tool error", "DS4UI_COWORK_HELPER is not configured");
    if (access(helper, R_OK) != 0)
        return cowork_message("Cowork tool error", "Office helper is not readable");

    char cwd[PATH_MAX];
    if (!workspace || !workspace[0]) {
        if (!getcwd(cwd, sizeof cwd))
            return cowork_message("Cowork tool error", "workspace cannot be resolved");
        workspace = cwd;
    }

    char *request = cowork_build_request(tool, args, nargs);
    if (!request) return cowork_message("Cowork tool error", "out of memory");

    const char *tmpdir = getenv("TMPDIR");
    if (!tmpdir || !tmpdir[0]) tmpdir = "/tmp";
    char request_path[PATH_MAX];
    int pn = snprintf(request_path, sizeof request_path,
                      "%s%sds4-cowork-request-XXXXXX",
                      tmpdir, tmpdir[strlen(tmpdir) - 1] == '/' ? "" : "/");
    if (pn < 0 || (size_t)pn >= sizeof request_path) {
        free(request);
        return cowork_message("Cowork tool error", "temporary path is too long");
    }
    int request_fd = mkstemp(request_path);
    if (request_fd < 0) {
        free(request);
        return cowork_message("Cowork tool error", "cannot create request file");
    }
    bool wrote = cowork_write_all(request_fd, request, strlen(request));
    free(request);
    if (close(request_fd) != 0) wrote = false;
    if (!wrote) {
        unlink(request_path);
        return cowork_message("Cowork tool error", "cannot write request file");
    }

    int output_pipe[2];
    if (pipe(output_pipe) != 0) {
        unlink(request_path);
        return cowork_message("Cowork tool error", "cannot create helper pipe");
    }
    pid_t pid = fork();
    if (pid < 0) {
        close(output_pipe[0]);
        close(output_pipe[1]);
        unlink(request_path);
        return cowork_message("Cowork tool error", "cannot start Office helper");
    }
    if (pid == 0) {
        dup2(output_pipe[1], STDOUT_FILENO);
        dup2(output_pipe[1], STDERR_FILENO);
        close(output_pipe[0]);
        close(output_pipe[1]);
        int nullfd = open("/dev/null", O_RDONLY);
        if (nullfd >= 0) {
            dup2(nullfd, STDIN_FILENO);
            close(nullfd);
        }
        const char *python = getenv("DS4UI_PYTHON");
        if (!python || !python[0]) python = "python3";
        execlp(python, python, helper, "--request-json", request_path,
               "--workspace", workspace, (char *)NULL);
        _exit(127);
    }

    close(output_pipe[1]);
    cowork_buf output = {0};
    bool truncated = false;
    char chunk[8192];
    for (;;) {
        ssize_t n = read(output_pipe[0], chunk, sizeof chunk);
        if (n < 0 && errno == EINTR) continue;
        if (n <= 0) break;
        size_t keep = (size_t)n;
        if (output.len + keep > COWORK_OUTPUT_MAX) {
            keep = COWORK_OUTPUT_MAX - output.len;
            truncated = true;
        }
        if (keep && !cowork_buf_append(&output, chunk, keep)) {
            close(output_pipe[0]);
            kill(pid, SIGTERM);
            int ignored = 0;
            cowork_wait(pid, &ignored);
            unlink(request_path);
            return cowork_message("Cowork tool error", "out of memory reading helper output");
        }
        if (truncated) break;
    }
    close(output_pipe[0]);
    int status = 0;
    bool waited = cowork_wait(pid, &status);
    unlink(request_path);

    if (truncated)
        cowork_buf_puts(&output, "\n[Cowork tool output truncated at 1 MiB.]\n");
    if (!waited || !WIFEXITED(status) || WEXITSTATUS(status) != 0) {
        cowork_buf framed = {0};
        cowork_buf_puts(&framed, "Cowork tool error");
        if (output.len) {
            cowork_buf_puts(&framed, ": ");
            cowork_buf_append(&framed, output.ptr, output.len);
        } else {
            cowork_buf_puts(&framed, ": Office helper failed without output\n");
        }
        free(output.ptr);
        return cowork_buf_take(&framed);
    }
    if (!output.len) {
        free(output.ptr);
        return cowork_message("Cowork tool error", "Office helper returned no output");
    }
    return cowork_buf_take(&output);
}

void ds4_cowork_free(char *result) {
    free(result);
}

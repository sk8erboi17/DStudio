#define _POSIX_C_SOURCE 200809L

#include "dstudio_remote_llm.h"
#include "dstudio_wire_string.h"

#include <ctype.h>
#include <errno.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <poll.h>
#include <unistd.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <netinet/in.h>
#include <fcntl.h>
#include <limits.h>

/* Private loopback protocol, independently bounded from inference traffic.
 * The host serializes admission and closing: a finishing pull either receives
 * admitted context or seals the turn BEFORE replying. No late message can
 * silently become the next turn. CLI runs without these env vars are unchanged.
 * A missing reply is never retried: delivery may already have happened. */
static char *steer_exchange(unsigned long long turn, unsigned ack, int finishing) {
    const char *port = getenv("DSTUDIO_STEER_PORT"), *key = getenv("DSTUDIO_STEER_KEY");
    if (!port || !key || strlen(key) != 64) return NULL;
    int fd = socket(AF_INET, SOCK_STREAM, 0);
    if (fd < 0) return NULL;
    fcntl(fd, F_SETFD, FD_CLOEXEC);
#ifdef SO_NOSIGPIPE
    int yes = 1; setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &yes, sizeof yes);
#endif
    struct timeval timeout = {2, 0};
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof timeout);
    setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &timeout, sizeof timeout);
    struct sockaddr_in addr = {0};
    addr.sin_family = AF_INET; addr.sin_port = htons((unsigned short)atoi(port));
    addr.sin_addr.s_addr = htonl(0x7f000001U);
    char body[180], request[512];
    int n = snprintf(body, sizeof body, "%s\n%llu\n%u\n%d", key, turn, ack, finishing);
    int len = snprintf(request, sizeof request,
        "POST /api/agent/steer/pull HTTP/1.1\r\nHost: 127.0.0.1\r\n"
        "X-Requested-With: ds4web\r\nContent-Length: %d\r\nConnection: close\r\n\r\n%s", n, body);
    if (connect(fd, (struct sockaddr *)&addr, sizeof addr)) { close(fd); return NULL; }
    for (int sent = 0; sent < len;) {
#ifdef MSG_NOSIGNAL
        ssize_t wrote = send(fd, request + sent, (size_t)(len - sent), MSG_NOSIGNAL);
#else
        ssize_t wrote = send(fd, request + sent, (size_t)(len - sent), 0);
#endif
        if (wrote < 0 && errno == EINTR) continue;
        if (wrote <= 0) { close(fd); return NULL; }
        sent += (int)wrote;
    }
    char response[18432]; size_t used = 0;
    for (;;) {
        ssize_t got = recv(fd, response + used, sizeof response - used - 1, 0);
        if (got < 0 && errno == EINTR) continue;
        if (got < 0 || used == sizeof response - 1) { close(fd); return NULL; }
        if (!got) break;
        used += (size_t)got;
    }
    close(fd); response[used] = 0;
    char *payload = strstr(response, "\r\n\r\n");
    if (strncmp(response, "HTTP/1.1 200 ", 13) || !payload) return NULL;
    /* Exact payload byte count detects truncated successful responses. */
    char *length = strstr(response, "Content-Length:");
    if (!length || strtoul(length + 15, NULL, 10) != used - (size_t)(payload + 4 - response)) return NULL;
    return strdup(payload + 4);
}

dstudio_steer dstudio_steer_begin(void) {
    dstudio_steer s = {0};
    char *reply = steer_exchange(0, 0, 0);
    if (reply) { s.turn = strtoull(reply, NULL, 10); s.enabled = s.turn != 0; free(reply); }
    return s;
}

int dstudio_steer_drain(dstudio_steer *s, int finishing,
                       dstudio_steer_append append, void *owner) {
    int added = 0;
    if (!s->enabled) return 0;
    for (;;) {
        char *reply = steer_exchange(s->turn, s->ack, finishing && !added);
        if (!reply) {
            s->enabled = 0;
            fprintf(stderr, "DStudio: steering delivery unavailable; unconfirmed context is not replayed.\n");
            return added;
        }
        char *text = strchr(reply, '\n');
        unsigned seq = (unsigned)strtoul(reply, NULL, 10);
        if (!seq) { free(reply); return added; }
        if (!text || !text[1] || seq <= s->ack) { free(reply); s->enabled = 0; return added; }
        append(owner, text + 1);
        s->ack = seq; /* ACK only after the owner appended the actual user input. */
        added++;
        free(reply);
    }
}

static void remote_err(char *err, size_t err_len, const char *fmt, ...) {
    if (!err || !err_len) return;
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(err, err_len, fmt, ap);
    va_end(ap);
}

void dstudio_remote_buf_free(dstudio_remote_buf *b) {
    if (!b) return;
    free(b->ptr);
    memset(b, 0, sizeof(*b));
}

void dstudio_remote_buf_append(dstudio_remote_buf *b, const char *s, size_t n) {
    if (!b || !s || !n) return;
    if (b->len + n + 1 > b->cap) {
        size_t cap = b->cap ? b->cap * 2 : 4096;
        while (cap < b->len + n + 1) cap *= 2;
        char *p = (char *)realloc(b->ptr, cap);
        if (!p) return;
        b->ptr = p;
        b->cap = cap;
    }
    memcpy(b->ptr + b->len, s, n);
    b->len += n;
    b->ptr[b->len] = '\0';
}

void dstudio_remote_buf_puts(dstudio_remote_buf *b, const char *s) {
    if (s) dstudio_remote_buf_append(b, s, strlen(s));
}

char *dstudio_remote_buf_take(dstudio_remote_buf *b) {
    if (!b || !b->ptr) return strdup("");
    char *p = b->ptr;
    memset(b, 0, sizeof(*b));
    return p;
}

static void remote_utf8_append(dstudio_remote_buf *b, unsigned cp) {
    char out[4];
    size_t n = 0;
    /* UTF-16 surrogate halves are not Unicode scalar values. Emitting their
     * UTF-8 byte form creates JSON that strict APIs (including DeepSeek)
     * reject as an invalid code point. */
    if ((cp >= 0xd800 && cp <= 0xdfff) || cp > 0x10ffff) cp = 0xfffd;
    if (cp <= 0x7f) {
        out[n++] = (char)cp;
    } else if (cp <= 0x7ff) {
        out[n++] = (char)(0xc0 | (cp >> 6));
        out[n++] = (char)(0x80 | (cp & 0x3f));
    } else if (cp <= 0xffff) {
        out[n++] = (char)(0xe0 | (cp >> 12));
        out[n++] = (char)(0x80 | ((cp >> 6) & 0x3f));
        out[n++] = (char)(0x80 | (cp & 0x3f));
    } else if (cp <= 0x10ffff) {
        out[n++] = (char)(0xf0 | (cp >> 18));
        out[n++] = (char)(0x80 | ((cp >> 12) & 0x3f));
        out[n++] = (char)(0x80 | ((cp >> 6) & 0x3f));
        out[n++] = (char)(0x80 | (cp & 0x3f));
    }
    if (n) dstudio_remote_buf_append(b, out, n);
}

/* Returns the byte length of the valid UTF-8 scalar at s, or zero for an
 * invalid/truncated/overlong sequence. JSON requires Unicode text, but tool
 * output can contain arbitrary bytes, so every remote request must validate
 * content at the final serialization boundary. */
static size_t remote_utf8_scalar_len(const unsigned char *s) {
    unsigned char c = s ? s[0] : 0;
    if (c < 0x80) return c ? 1 : 0;
    if (c >= 0xc2 && c <= 0xdf)
        return s[1] >= 0x80 && s[1] <= 0xbf ? 2 : 0;
    if (c == 0xe0)
        return s[1] >= 0xa0 && s[1] <= 0xbf &&
               s[2] >= 0x80 && s[2] <= 0xbf ? 3 : 0;
    if ((c >= 0xe1 && c <= 0xec) || (c >= 0xee && c <= 0xef))
        return s[1] >= 0x80 && s[1] <= 0xbf &&
               s[2] >= 0x80 && s[2] <= 0xbf ? 3 : 0;
    if (c == 0xed) /* excludes UTF-16 surrogate halves */
        return s[1] >= 0x80 && s[1] <= 0x9f &&
               s[2] >= 0x80 && s[2] <= 0xbf ? 3 : 0;
    if (c == 0xf0)
        return s[1] >= 0x90 && s[1] <= 0xbf &&
               s[2] >= 0x80 && s[2] <= 0xbf &&
               s[3] >= 0x80 && s[3] <= 0xbf ? 4 : 0;
    if (c >= 0xf1 && c <= 0xf3)
        return s[1] >= 0x80 && s[1] <= 0xbf &&
               s[2] >= 0x80 && s[2] <= 0xbf &&
               s[3] >= 0x80 && s[3] <= 0xbf ? 4 : 0;
    if (c == 0xf4)
        return s[1] >= 0x80 && s[1] <= 0x8f &&
               s[2] >= 0x80 && s[2] <= 0xbf &&
               s[3] >= 0x80 && s[3] <= 0xbf ? 4 : 0;
    return 0;
}

void dstudio_remote_json_string(dstudio_remote_buf *b, const char *s) {
    dstudio_remote_buf_puts(b, "\"");
    const unsigned char *p = (const unsigned char *)s;
    while (p && *p) {
        unsigned char c = *p;
        char tmp[8];
        if (c == '"' || c == '\\') {
            tmp[0] = '\\';
            tmp[1] = (char)c;
            dstudio_remote_buf_append(b, tmp, 2);
            p++;
        } else if (c == '\n') {
            dstudio_remote_buf_puts(b, "\\n");
            p++;
        } else if (c == '\r') {
            dstudio_remote_buf_puts(b, "\\r");
            p++;
        } else if (c == '\t') {
            dstudio_remote_buf_puts(b, "\\t");
            p++;
        } else if (c < 0x20) {
            snprintf(tmp, sizeof(tmp), "\\u%04x", c);
            dstudio_remote_buf_puts(b, tmp);
            p++;
        } else if (c < 0x80) {
            dstudio_remote_buf_append(b, (const char *)p, 1);
            p++;
        } else {
            size_t n = remote_utf8_scalar_len(p);
            if (n) {
                dstudio_remote_buf_append(b, (const char *)p, n);
                p += n;
            } else {
                remote_utf8_append(b, 0xfffd);
                p++;
            }
        }
    }
    dstudio_remote_buf_puts(b, "\"");
}

void dstudio_remote_messages_append(dstudio_remote_buf *b,
                                    int *count,
                                    const char *role,
                                    const char *content) {
    if (!b || !count) return;
    if (b->len == 0) dstudio_remote_buf_puts(b, "[");
    if (*count > 0) dstudio_remote_buf_puts(b, ",");
    dstudio_remote_buf_puts(b, "{\"role\":");
    dstudio_remote_json_string(b, role && role[0] ? role : "user");
    dstudio_remote_buf_puts(b, ",\"content\":");
    dstudio_remote_json_string(b, content ? content : "");
    dstudio_remote_buf_puts(b, "}");
    (*count)++;
}

char *dstudio_remote_messages_snapshot(const dstudio_remote_buf *b) {
    dstudio_remote_buf out = {0};
    if (b && b->ptr && b->len) dstudio_remote_buf_append(&out, b->ptr, b->len);
    else dstudio_remote_buf_puts(&out, "[");
    dstudio_remote_buf_puts(&out, "]");
    return dstudio_remote_buf_take(&out);
}

static int write_all_fd(int fd, const char *p, size_t n) {
    while (n) {
        ssize_t w = write(fd, p, n);
        if (w < 0 && errno == EINTR) continue;
        if (w <= 0) return -1;
        p += w;
        n -= (size_t)w;
    }
    return 0;
}

static int read_line_fd(int fd, dstudio_remote_buf *line,
                        dstudio_remote_cancel_cb cancelled, void *ud) {
    line->len = 0;
    if (line->ptr) line->ptr[0] = '\0';
    int idle_ms = 0;
    for (;;) {
        /* Check partial frames too, without adding a callback for every byte.
         * The caller temporarily makes its exclusively-owned stdin nonblocking. */
        if (!(line->len % 4096) && cancelled && cancelled(ud)) return -2;
        char c;
        ssize_t n = read(fd, &c, 1);
        if (n < 0 && errno == EINTR) {
            if (cancelled && cancelled(ud)) return -2;
            continue;
        }
        if (n < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
            /* The runtime's pipe loop runs stdin in non-blocking mode: a gap
             * between streamed model frames is NOT end-of-stream. Wait for
             * more bytes (generous cap: remote models can stall on long
             * prefills) instead of misreading EAGAIN as EOF. */
            struct pollfd p = { .fd = fd, .events = POLLIN };
            if (cancelled && cancelled(ud)) return -2;
            int slice_ms = cancelled ? 100 : 1800000;
            int prc = poll(&p, 1, slice_ms);
            if (prc < 0 && errno == EINTR) continue;
            if (prc < 0) return -1;
            if (!prc) {
                idle_ms += slice_ms;
                if (idle_ms >= 1800000) return line->len ? -1 : 0;
            }
            continue;
        }
        if (n <= 0) return line->len ? -1 : 0;
        idle_ms = 0;
        /* Two JSON envelopes surround an at-most-2-MiB tool batch. The bound
         * includes escaping, and applies independently to ordinary text. */
        if (!c || line->len >= 16u * 1024u * 1024u) return -1;
        size_t before = line->len;
        dstudio_remote_buf_append(line, &c, 1);
        if (line->len != before + 1) return -1;
        if (c == '\n') return 1;
    }
}

static int discard_cancelled_input(int fd) {
    /* The host admits no new prompt before this turn announces WAITING.
     * Drop bytes already queued for the cancelled completion while stdin is
     * still nonblocking; otherwise the outer prompt loop can ingest them.
     * Never wait for the model or an EOF. A continuously flooding peer cannot
     * hold this owner indefinitely. Late host-worker delivery still requires
     * request-generation fencing at the host, not an unbounded drain here. */
    char bytes[4096];
    for (unsigned reads = 0; reads < 4096; reads++) {
        ssize_t n = read(fd, bytes, sizeof bytes);
        if (!n || (n < 0 && (errno == EAGAIN || errno == EWOULDBLOCK))) return 1;
        if (n < 0 && errno != EINTR) return 0;
    }
    return 0;
}

static char *json_string_value(const char *json, const char *key) {
    char pat[96];
    snprintf(pat, sizeof(pat), "\"%s\"", key);
    const char *p = strstr(json, pat);
    if (!p) return NULL;
    p += strlen(pat);
    while (*p && isspace((unsigned char)*p)) p++;
    if (*p != ':') return NULL;
    p++;
    while (*p && isspace((unsigned char)*p)) p++;
    if (*p != '"') return NULL;
    const char *start = p++;
    while (*p) {
        if (*p == '"') return dstudio_wire_string(start, p + 1);
        if (*p++ == '\\') { if (!*p) return NULL; p++; }
    }
    return NULL;
}

static int json_int_value(const char *json, const char *key, int *out) {
    char pat[96];
    snprintf(pat, sizeof(pat), "\"%s\"", key);
    const char *p = strstr(json, pat);
    if (!p) return 0;
    p += strlen(pat);
    while (*p && isspace((unsigned char)*p)) p++;
    if (*p != ':') return 0;
    p++;
    while (*p && isspace((unsigned char)*p)) p++;
    char *end = NULL;
    long v = strtol(p, &end, 10);
    if (end == p || v < 0 || v > 2147483647L) return 0;
    *out = (int)v;
    return 1;
}

static int rpc_send_request(int id, const char *body, char *err, size_t err_len) {
    dstudio_remote_buf event = {0};
    char num[64];
    dstudio_remote_buf_puts(&event, "\x1e{\"type\":\"model_request\",\"id\":");
    snprintf(num, sizeof num, "%d", id);
    dstudio_remote_buf_puts(&event, num);
    dstudio_remote_buf_puts(&event, ",\"body\":");
    dstudio_remote_json_string(&event, body ? body : "{}");
    dstudio_remote_buf_puts(&event, "}\n");
    int rc = write_all_fd(STDOUT_FILENO, event.ptr ? event.ptr : "", event.len);
    dstudio_remote_buf_free(&event);
    if (rc != 0) {
        remote_err(err, err_len, "failed to send internal model request to DStudio");
        return 1;
    }
    return 0;
}

static int remote_chat_stream(const char *base_url,
                               const char *model,
                               const char *messages_json,
                               int think_level,
                               float temperature,
                               float top_p,
                               float min_p,
                               int max_tokens,
                               dstudio_remote_chunk_cb cb,
                               void *ud,
                               dstudio_remote_cancel_cb cancelled,
                               char *err,
                               size_t err_len,
                               const char *tools_json,
                               char **tool_calls_json) {
    if (tool_calls_json) *tool_calls_json = NULL;
    if (cancelled && cancelled(ud)) return 2;
    if (!base_url || !base_url[0]) {
        remote_err(err, err_len, "remote model host is missing");
        return 1;
    }
    if (strncmp(base_url, "http://", 7) != 0 && strncmp(base_url, "https://", 8) != 0) {
        remote_err(err, err_len, "remote model host must be http:// (LAN) or https:// (cloud API)");
        return 1;
    }

    /* Cloud endpoints (https) speak plain OpenAI-compatible JSON: the ds4-only
     * knobs (think, reasoning_effort, min_p) get requests rejected outright.
     * A non-positive max_tokens is the quality-first "until EOS" sentinel and
     * is omitted, allowing the provider/model to use its native boundary. */
    int cloud = strncmp(base_url, "https://", 8) == 0;
    dstudio_remote_buf body = {0};
    dstudio_remote_buf_puts(&body, "{\"model\":");
    dstudio_remote_json_string(&body, model && model[0] ? model : "ds4");
    dstudio_remote_buf_puts(&body, ",\"stream\":true,\"messages\":");
    dstudio_remote_buf_puts(&body, messages_json && messages_json[0] ? messages_json : "[]");
    if (tools_json) {
        dstudio_remote_buf_puts(&body, ",\"tools\":");
        dstudio_remote_buf_puts(&body, tools_json);
    }
    if (!cloud) {
        dstudio_remote_buf_puts(&body, ",\"think\":");
        dstudio_remote_buf_puts(&body, think_level > 0 ? "true" : "false");
        if (think_level > 0) {
            dstudio_remote_buf_puts(&body, ",\"reasoning_effort\":");
            dstudio_remote_json_string(&body, think_level >= 2 ? "max" : "high");
        }
    }
    char num[160];
    if (cloud) {
        snprintf(num, sizeof(num), ",\"temperature\":%.4g,\"top_p\":%.4g",
                 (double)temperature, (double)top_p);
    } else {
        snprintf(num, sizeof(num), ",\"temperature\":%.4g,\"top_p\":%.4g,\"min_p\":%.4g",
                 (double)temperature, (double)top_p, (double)min_p);
    }
    dstudio_remote_buf_puts(&body, num);
    int mt = max_tokens;
    if (cloud && mt > 8192) mt = 8192;
    if (mt > 0) {
        snprintf(num, sizeof(num), ",\"max_tokens\":%d", mt);
        dstudio_remote_buf_puts(&body, num);
    }
    dstudio_remote_buf_puts(&body, "}");

    static int next_id = 1;
    int id = next_id;
    next_id = next_id == INT_MAX ? 1 : next_id + 1;
    if (rpc_send_request(id, body.ptr ? body.ptr : "{}", err, err_len) != 0) {
        dstudio_remote_buf_free(&body);
        return 1;
    }
    dstudio_remote_buf_free(&body);

    /* A signal may arrive between checking its latch and blocking in read.
     * A short poll on nonblocking stdin closes that lost-wakeup window, even
     * with SA_RESTART. Restore the original flags on every terminal path. */
    int old_flags = fcntl(STDIN_FILENO, F_GETFL);
    if (old_flags < 0 || (!(old_flags & O_NONBLOCK) &&
                         fcntl(STDIN_FILENO, F_SETFL, old_flags | O_NONBLOCK) < 0)) {
        remote_err(err, err_len, "could not prepare interruptible model input");
        return 1;
    }
    dstudio_remote_buf line = {0};
    char *candidate_calls = NULL;
    int read_status, result = 1;
    while ((read_status = read_line_fd(STDIN_FILENO, &line, cancelled, ud)) > 0) {
        if (cancelled && cancelled(ud)) { result = 2; goto finished; }
        const char *p = line.ptr ? line.ptr : "";
        if ((unsigned char)p[0] != 0x1e) continue;
        p++;
        /* DS4UI: the launcher can interrupt the current turn by writing this
         * control frame; it must be honored even while a model stream is open
         * (the frame shares the same stdin as the model deltas). */
        if (strstr(p, "\"type\":\"control\"") &&
            strstr(p, "\"name\":\"interrupt\"")) {
            result = 2;
            goto finished;
        }
        if (!strstr(p, "\"type\":\"model_")) continue;
        int got_id = -1;
        if (!json_int_value(p, "id", &got_id) || got_id != id) continue;

        char *type = json_string_value(p, "type");
        if (type && !strcmp(type, "model_delta")) {
            char *kind = json_string_value(p, "kind");
            char *text = json_string_value(p, "text");
            int valid = !candidate_calls && kind && text &&
                (!strcmp(kind, "reasoning") || !strcmp(kind, "content"));
            if (valid && text[0] && cb) cb(ud, kind, text, strlen(text));
            free(kind);
            free(text);
            if (!valid) {
                free(type);
                remote_err(err, err_len, "invalid internal model delta");
                goto failed;
            }
        } else if (type && !strcmp(type, "model_tool_calls")) {
            if (!tool_calls_json || candidate_calls ||
                !(candidate_calls = json_string_value(p, "text")) || candidate_calls[0] != '[') {
                free(type);
                remote_err(err, err_len, "unexpected or duplicate structured model tools");
                goto failed;
            }
        } else if (type && !strcmp(type, "model_done")) {
            if (tool_calls_json) {
                char *finish = json_string_value(p, "text");
                int valid = finish && !strcmp(finish, candidate_calls ? "tool_calls" : "stop");
                free(finish);
                if (!valid) {
                    free(type);
                    remote_err(err, err_len, "structured model completion is incomplete");
                    goto failed;
                }
                *tool_calls_json = candidate_calls;
                candidate_calls = NULL;
            }
            free(type);
            result = 0;
            goto finished;
        } else if (type && !strcmp(type, "model_error")) {
            char *msg = json_string_value(p, "error");
            remote_err(err, err_len, "%s", msg && msg[0] ? msg : "remote model request failed");
            free(msg);
            free(type);
            goto failed;
        }
        free(type);
    }

    if (read_status == -2) { result = 2; goto finished; }
    remote_err(err, err_len, read_status < 0 ? "invalid, truncated or oversized internal model frame" :
               "internal model stream ended before completion");
failed:
    result = 1;
finished:
    free(candidate_calls);
    dstudio_remote_buf_free(&line);
    if (result == 2 && !discard_cancelled_input(STDIN_FILENO)) {
        remote_err(err, err_len, "cancelled model input did not drain within its bound");
        result = 1;
    }
    if (!(old_flags & O_NONBLOCK) && fcntl(STDIN_FILENO, F_SETFL, old_flags) < 0) {
        if (tool_calls_json) { free(*tool_calls_json); *tool_calls_json = NULL; }
        remote_err(err, err_len, "could not restore model input flags");
        return 1;
    }
    return result;
}

int dstudio_remote_chat_stream(const char *base_url, const char *model,
                               const char *messages_json, int think_level,
                               float temperature, float top_p, float min_p,
                               int max_tokens, dstudio_remote_chunk_cb cb, void *ud,
                               dstudio_remote_cancel_cb cancelled,
                               char *err, size_t err_len) {
    return remote_chat_stream(base_url, model, messages_json, think_level, temperature,
        top_p, min_p, max_tokens, cb, ud, cancelled, err, err_len, NULL, NULL);
}

int dstudio_remote_chat_stream_tools(const char *base_url, const char *model,
                                     const char *messages_json, const char *tools_json,
                                     int think_level, float temperature, float top_p, float min_p,
                                     int max_tokens, dstudio_remote_chunk_cb cb, void *ud,
                                     dstudio_remote_cancel_cb cancelled,
                                     char **tool_calls_json, char *err, size_t err_len) {
    if (!tool_calls_json || !tools_json || tools_json[0] != '[' || strlen(tools_json) > 1024u * 1024u) {
        if (tool_calls_json) *tool_calls_json = NULL;
        remote_err(err, err_len, "structured model request requires bounded tool schemas and a result owner");
        return 1;
    }
    return remote_chat_stream(base_url, model, messages_json, think_level, temperature,
        top_p, min_p, max_tokens, cb, ud, cancelled, err, err_len, tools_json, tool_calls_json);
}

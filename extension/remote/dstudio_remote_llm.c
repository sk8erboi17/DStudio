#define _POSIX_C_SOURCE 200809L

#include "dstudio_remote_llm.h"

#include <ctype.h>
#include <errno.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <poll.h>
#include <unistd.h>

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

static int read_line_fd(int fd, dstudio_remote_buf *line) {
    line->len = 0;
    if (line->ptr) line->ptr[0] = '\0';
    for (;;) {
        char c;
        ssize_t n = read(fd, &c, 1);
        if (n < 0 && errno == EINTR) continue;
        if (n < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
            /* The runtime's pipe loop runs stdin in non-blocking mode: a gap
             * between streamed model frames is NOT end-of-stream. Wait for
             * more bytes (generous cap: remote models can stall on long
             * prefills) instead of misreading EAGAIN as EOF. */
            struct pollfd p = { .fd = fd, .events = POLLIN };
            int prc = poll(&p, 1, 1800000);
            if (prc < 0 && errno == EINTR) continue;
            if (prc <= 0) return line->len ? 1 : 0;
            continue;
        }
        if (n <= 0) return line->len ? 1 : 0;
        dstudio_remote_buf_append(line, &c, 1);
        if (c == '\n') return 1;
    }
}

static int hex4(const char *p, unsigned *out) {
    unsigned v = 0;
    for (int i = 0; i < 4; i++) {
        unsigned char c = (unsigned char)p[i];
        v <<= 4;
        if (c >= '0' && c <= '9') v |= (unsigned)(c - '0');
        else if (c >= 'a' && c <= 'f') v |= (unsigned)(c - 'a' + 10);
        else if (c >= 'A' && c <= 'F') v |= (unsigned)(c - 'A' + 10);
        else return 0;
    }
    *out = v;
    return 1;
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
    p++;

    dstudio_remote_buf out = {0};
    while (*p) {
        unsigned char c = (unsigned char)*p++;
        if (c == '"') return dstudio_remote_buf_take(&out);
        if (c != '\\') {
            dstudio_remote_buf_append(&out, (const char *)&c, 1);
            continue;
        }
        c = (unsigned char)*p++;
        switch (c) {
        case '"': dstudio_remote_buf_puts(&out, "\""); break;
        case '\\': dstudio_remote_buf_puts(&out, "\\"); break;
        case '/': dstudio_remote_buf_puts(&out, "/"); break;
        case 'b': dstudio_remote_buf_append(&out, "\b", 1); break;
        case 'f': dstudio_remote_buf_append(&out, "\f", 1); break;
        case 'n': dstudio_remote_buf_append(&out, "\n", 1); break;
        case 'r': dstudio_remote_buf_append(&out, "\r", 1); break;
        case 't': dstudio_remote_buf_append(&out, "\t", 1); break;
        case 'u': {
            unsigned cp = 0;
            if (hex4(p, &cp)) {
                p += 4;
                if (cp >= 0xd800 && cp <= 0xdbff && p[0] == '\\' && p[1] == 'u') {
                    unsigned lo = 0;
                    if (hex4(p + 2, &lo) && lo >= 0xdc00 && lo <= 0xdfff) {
                        cp = 0x10000 + ((cp - 0xd800) << 10) + (lo - 0xdc00);
                        p += 6;
                    }
                }
                remote_utf8_append(&out, cp);
            }
            break;
        }
        default:
            dstudio_remote_buf_append(&out, (const char *)&c, 1);
            break;
        }
    }
    dstudio_remote_buf_free(&out);
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

int dstudio_remote_chat_stream(const char *base_url,
                               const char *model,
                               const char *messages_json,
                               int think_level,
                               float temperature,
                               float top_p,
                               float min_p,
                               int max_tokens,
                               dstudio_remote_chunk_cb cb,
                               void *ud,
                               char *err,
                               size_t err_len) {
    if (!base_url || !base_url[0]) {
        remote_err(err, err_len, "remote model host is missing");
        return 1;
    }
    if (strncmp(base_url, "http://", 7) != 0 && strncmp(base_url, "https://", 8) != 0) {
        remote_err(err, err_len, "remote model host must be http:// (LAN) or https:// (cloud API)");
        return 1;
    }

    /* Cloud endpoints (https) speak plain OpenAI-compatible JSON: the ds4-only
     * knobs (think, reasoning_effort, min_p) get requests rejected outright,
     * and DeepSeek caps max_tokens at 8192. LAN ds4 hosts keep the full set. */
    int cloud = strncmp(base_url, "https://", 8) == 0;
    dstudio_remote_buf body = {0};
    dstudio_remote_buf_puts(&body, "{\"model\":");
    dstudio_remote_json_string(&body, model && model[0] ? model : "ds4");
    dstudio_remote_buf_puts(&body, ",\"stream\":true,\"messages\":");
    dstudio_remote_buf_puts(&body, messages_json && messages_json[0] ? messages_json : "[]");
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
    if (cloud && (mt <= 0 || mt > 8192)) mt = 8192;
    if (mt > 0) {
        snprintf(num, sizeof(num), ",\"max_tokens\":%d", mt);
        dstudio_remote_buf_puts(&body, num);
    }
    dstudio_remote_buf_puts(&body, "}");

    static int next_id = 1;
    int id = next_id++;
    if (next_id <= 0) next_id = 1;
    if (rpc_send_request(id, body.ptr ? body.ptr : "{}", err, err_len) != 0) {
        dstudio_remote_buf_free(&body);
        return 1;
    }
    dstudio_remote_buf_free(&body);

    dstudio_remote_buf line = {0};
    while (read_line_fd(STDIN_FILENO, &line)) {
        const char *p = line.ptr ? line.ptr : "";
        if ((unsigned char)p[0] != 0x1e) continue;
        p++;
        if (!strstr(p, "\"type\":\"model_")) continue;
        int got_id = -1;
        if (!json_int_value(p, "id", &got_id) || got_id != id) continue;

        char *type = json_string_value(p, "type");
        if (type && !strcmp(type, "model_delta")) {
            char *kind = json_string_value(p, "kind");
            char *text = json_string_value(p, "text");
            if (kind && text && text[0] && cb) cb(ud, kind, text, strlen(text));
            free(kind);
            free(text);
        } else if (type && !strcmp(type, "model_done")) {
            free(type);
            dstudio_remote_buf_free(&line);
            return 0;
        } else if (type && !strcmp(type, "model_error")) {
            char *msg = json_string_value(p, "error");
            remote_err(err, err_len, "%s", msg && msg[0] ? msg : "remote model request failed");
            free(msg);
            free(type);
            dstudio_remote_buf_free(&line);
            return 1;
        }
        free(type);
    }

    dstudio_remote_buf_free(&line);
    remote_err(err, err_len, "internal model stream ended before completion");
    return 1;
}

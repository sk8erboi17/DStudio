#define _POSIX_C_SOURCE 200809L

#include "dstudio_remote_llm.h"

#include <ctype.h>
#include <errno.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
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

void dstudio_remote_json_string(dstudio_remote_buf *b, const char *s) {
    dstudio_remote_buf_puts(b, "\"");
    for (; s && *s; s++) {
        unsigned char c = (unsigned char)*s;
        char tmp[8];
        if (c == '"' || c == '\\') {
            tmp[0] = '\\';
            tmp[1] = (char)c;
            dstudio_remote_buf_append(b, tmp, 2);
        } else if (c == '\n') {
            dstudio_remote_buf_puts(b, "\\n");
        } else if (c == '\r') {
            dstudio_remote_buf_puts(b, "\\r");
        } else if (c == '\t') {
            dstudio_remote_buf_puts(b, "\\t");
        } else if (c < 0x20) {
            snprintf(tmp, sizeof(tmp), "\\u%04x", c);
            dstudio_remote_buf_puts(b, tmp);
        } else {
            dstudio_remote_buf_append(b, (const char *)&c, 1);
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

static void shell_quote(dstudio_remote_buf *b, const char *s) {
    dstudio_remote_buf_puts(b, "'");
    for (; s && *s; s++) {
        if (*s == '\'') dstudio_remote_buf_puts(b, "'\\''");
        else dstudio_remote_buf_append(b, s, 1);
    }
    dstudio_remote_buf_puts(b, "'");
}

static char *remote_url(const char *base_url) {
    dstudio_remote_buf b = {0};
    const char *base = base_url ? base_url : "";
    size_t n = strlen(base);
    while (n && base[n - 1] == '/') n--;
    dstudio_remote_buf_append(&b, base, n);
    dstudio_remote_buf_puts(&b, "/v1/chat/completions");
    return dstudio_remote_buf_take(&b);
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

static void stream_sse_line(const char *line,
                            dstudio_remote_chunk_cb cb,
                            void *ud,
                            int *done) {
    if (strncmp(line, "data:", 5) != 0) return;
    const char *p = line + 5;
    while (*p == ' ' || *p == '\t') p++;
    if (!strncmp(p, "[DONE]", 6)) {
        *done = 1;
        return;
    }
    char *reasoning = json_string_value(p, "reasoning_content");
    if (reasoning && reasoning[0] && cb) cb(ud, "reasoning", reasoning, strlen(reasoning));
    free(reasoning);
    char *content = json_string_value(p, "content");
    if (content && content[0] && cb) cb(ud, "content", content, strlen(content));
    free(content);
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
    if (strncmp(base_url, "http://", 7) != 0) {
        remote_err(err, err_len, "remote model host must be http:// on LAN");
        return 1;
    }

    dstudio_remote_buf body = {0};
    dstudio_remote_buf_puts(&body, "{\"model\":");
    dstudio_remote_json_string(&body, model && model[0] ? model : "ds4");
    dstudio_remote_buf_puts(&body, ",\"stream\":true,\"messages\":");
    dstudio_remote_buf_puts(&body, messages_json && messages_json[0] ? messages_json : "[]");
    dstudio_remote_buf_puts(&body, ",\"think\":");
    dstudio_remote_buf_puts(&body, think_level > 0 ? "true" : "false");
    if (think_level > 0) {
        dstudio_remote_buf_puts(&body, ",\"reasoning_effort\":");
        dstudio_remote_json_string(&body, think_level >= 2 ? "max" : "high");
    }
    char num[160];
    snprintf(num, sizeof(num), ",\"temperature\":%.4g,\"top_p\":%.4g,\"min_p\":%.4g",
             (double)temperature, (double)top_p, (double)min_p);
    dstudio_remote_buf_puts(&body, num);
    if (max_tokens > 0) {
        snprintf(num, sizeof(num), ",\"max_tokens\":%d", max_tokens);
        dstudio_remote_buf_puts(&body, num);
    }
    dstudio_remote_buf_puts(&body, "}");

    char tmp[] = "/tmp/dstudio-remote-XXXXXX";
    int fd = mkstemp(tmp);
    if (fd < 0) {
        remote_err(err, err_len, "mkstemp failed: %s", strerror(errno));
        dstudio_remote_buf_free(&body);
        return 1;
    }
    int write_ok = write_all_fd(fd, body.ptr ? body.ptr : "", body.len) == 0;
    close(fd);
    dstudio_remote_buf_free(&body);
    if (!write_ok) {
        unlink(tmp);
        remote_err(err, err_len, "failed to write remote request body");
        return 1;
    }

    char *url = remote_url(base_url);
    dstudio_remote_buf cmd = {0};
    dstudio_remote_buf_puts(&cmd,
        "curl -fsS -N --max-time 1800 "
        "-H 'Accept: text/event-stream' "
        "-H 'Content-Type: application/json' "
        "--data-binary @");
    shell_quote(&cmd, tmp);
    dstudio_remote_buf_puts(&cmd, " ");
    shell_quote(&cmd, url);
    free(url);

    FILE *fp = popen(cmd.ptr, "r");
    dstudio_remote_buf_free(&cmd);
    if (!fp) {
        unlink(tmp);
        remote_err(err, err_len, "failed to start curl");
        return 1;
    }

    char *line = NULL;
    size_t cap = 0;
    int done = 0;
    while (getline(&line, &cap, fp) >= 0) {
        stream_sse_line(line, cb, ud, &done);
        if (done) break;
    }
    free(line);
    int st = pclose(fp);
    unlink(tmp);
    if (st == -1) {
        remote_err(err, err_len, "curl wait failed");
        return 1;
    }
    if (!done && (!WIFEXITED(st) || WEXITSTATUS(st) != 0)) {
        remote_err(err, err_len, "remote model request failed");
        return 1;
    }
    if (!done) {
        remote_err(err, err_len, "remote model stream ended before [DONE]");
        return 1;
    }
    return 0;
}

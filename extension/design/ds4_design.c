/* ds4-design: DStudio's headless design agent on the DS4 engine, headless, in C.
 *
 * This is a headless design agent driven by
 * the DS4 in-process engine as the brain instead of an external agent CLI:
 *
 * - The agent works in a PROJECT DIRECTORY of free-form files (kebab-case,
 *   descriptive: landing-page.html, screens/01-onboarding.html, css/, js/),
 *   File tools are
 *   sandboxed to that directory: relative paths only, no "..".
 * - The conversation follows a fixed staged flow: turn 1 emits a
 *   <question-form> discovery block (no tools), the direction/brand is locked
 *   next, then every build starts with a todo_write plan whose live updates
 *   the UI renders as a Todos card, and a turn that shipped a new canonical
 *   HTML file ends with an artifact handoff.
 * - The system prompt is a purpose-built design prompt stack
 *   (discovery + philosophy rules, designer identity, the five built-in
 *   design directions with OKLch palettes, the anti-AI-slop checklist, the
 *   artifact rules), trimmed of what a local engine cannot do (no web access,
 *   no Bash) and taught DSML tool syntax and anchored edits, because local
 *   decoding runs at tens of tokens/s and retyping a document is waste.
 *
 * Differences from ds4_agent.c (same engine API, same DSML grammar):
 * single-threaded and headless only; narrow sandboxed tool surface; no
 * session persistence (a design session is bounded by the context).
 *
 * Headless protocol (what DStudio's serve.c speaks):
 * - prompts on stdin, accumulated until a 200ms quiet gap;
 * - assistant text streamed to stdout;
 * - "+DWARFSTAR_WAITING" on stderr when idle;
 * - with --jsonl, structured events on stdout, one JSON object per line
 *   prefixed by \x1e: protocol / tool_call / tool_result / reasoning_start /
 *   reasoning_end / todos / artifact_check / artifact / question.  Legacy
 *   <question-form> blocks still stream as plain text; the UI recognizes and
 *   renders them.
 *
 * Build:  extension/design/build-design.sh  (from DStudio; output untracked
 *         in the ds4 repo).  Run: ./ds4-design --metal -m model.gguf
 *         --workspace ~/designs --jsonl
 */

#include <ctype.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <fnmatch.h>
#include <limits.h>
#include <poll.h>
#include <regex.h>
#include <signal.h>
#include <stdbool.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#include "ds4.h"
#include "ds4_web.h"
#include "ds4_kvstore.h"
#include "dstudio_remote_llm.h"

#ifndef O_BINARY
#define O_BINARY 0
#endif

/* Tokens kept free for the next assistant round + tool result before a user
 * turn is accepted.  Past that, the session is declared full. */
#define DESIGN_CTX_RESERVE 4096
#define DESIGN_READ_DEFAULT_LINES 200
#define DESIGN_FILE_MAX (8 * 1024 * 1024)
#define DESIGN_MEMORY_MAX_BYTES (32 * 1024)
#define DESIGN_TOOL_RESULT_RESERVE_TOKENS 1024
#define DESIGN_COMPACT_SOFT_PERCENT 85
#define DESIGN_COMPACT_MIN_FREE_TOKENS 8192
#define DESIGN_COMPACT_TAIL_DIVISOR 10
#define DESIGN_COMPACT_TAIL_CAP_TOKENS 50000
#define DESIGN_COMPACT_SUMMARY_MAX_TOKENS 4096
#define DESIGN_QUALITY_RUBRIC_ID "ds4-design-quality-v1"
#define DESIGN_QUALITY_THRESHOLD 8.0

typedef struct {
    double critic;
    double brand;
    double a11y;
    double copy;
    double composite;
} design_critique_scores;

/* ==================== small utilities ==================== */

static void *xmalloc(size_t n) {
    void *p = malloc(n ? n : 1);
    if (!p) { fprintf(stderr, "ds4-design: out of memory\n"); exit(1); }
    return p;
}

static void *xrealloc(void *p, size_t n) {
    void *q = realloc(p, n ? n : 1);
    if (!q) { fprintf(stderr, "ds4-design: out of memory\n"); exit(1); }
    return q;
}

static char *xstrndup(const char *s, size_t n) {
    char *p = xmalloc(n + 1);
    memcpy(p, s, n);
    p[n] = '\0';
    return p;
}

static char *xstrdup(const char *s) { return xstrndup(s, strlen(s)); }

typedef struct {
    char *ptr;
    size_t len;
    size_t cap;
} design_buf;

static void buf_append(design_buf *b, const char *s, size_t n) {
    if (!n) return;
    if (b->len + n + 1 > b->cap) {
        size_t cap = b->cap ? b->cap * 2 : 4096;
        while (cap < b->len + n + 1) cap *= 2;
        b->ptr = xrealloc(b->ptr, cap);
        b->cap = cap;
    }
    memcpy(b->ptr + b->len, s, n);
    b->len += n;
    b->ptr[b->len] = '\0';
}

static void buf_puts(design_buf *b, const char *s) { buf_append(b, s, strlen(s)); }

static char *buf_take(design_buf *b) {
    if (!b->ptr) return xstrdup("");
    char *p = b->ptr;
    memset(b, 0, sizeof(*b));
    return p;
}

static void write_all_fd(int fd, const char *p, size_t n) {
    while (n > 0) {
        ssize_t w = write(fd, p, n);
        if (w < 0) {
            if (errno == EINTR) continue;
            return; /* stdout/stderr gone: the launcher died, nothing to save */
        }
        p += w;
        n -= (size_t)w;
    }
}

static const char *design_tmp_dir(void) {
    const char *keys[] = { "TMPDIR", "TMP", "TEMP", "USERPROFILE", NULL };
    for (int i = 0; keys[i]; i++) {
        const char *v = getenv(keys[i]);
        if (v && v[0]) return v;
    }
    return ".";
}

static int design_tempfile_in_dir(char *path, size_t path_len,
                                  const char *dir, const char *prefix,
                                  const char *suffix) {
    if (!dir || !dir[0]) dir = ".";
    if (!prefix || !prefix[0]) prefix = "ds4_design";
    if (!suffix) suffix = "";
    size_t dl = strlen(dir);
    char sep = (dl && (dir[dl - 1] == '/' || dir[dl - 1] == '\\')) ? '\0' : '/';
    unsigned seed = (unsigned)time(NULL) ^ (unsigned)getpid();
    for (int i = 0; i < 128; i++) {
        seed = seed * 1103515245u + 12345u;
        if (sep) snprintf(path, path_len, "%s%c%s-%ld-%08x%s",
                          dir, sep, prefix, (long)getpid(), seed, suffix);
        else     snprintf(path, path_len, "%s%s-%ld-%08x%s",
                          dir, prefix, (long)getpid(), seed, suffix);
        int fd = open(path, O_CREAT | O_EXCL | O_WRONLY | O_BINARY, 0600);
        if (fd >= 0) return fd;
        if (errno != EEXIST) break;
    }
    path[0] = '\0';
    return -1;
}

static int design_tempfile_near(const char *target_path, char **tmp_out) {
    if (!target_path || !tmp_out) {
        errno = EINVAL;
        return -1;
    }
    size_t n = strlen(target_path);
    char *tmp = xmalloc(n + 64);
    unsigned seed = (unsigned)time(NULL) ^ (unsigned)getpid();
    for (int i = 0; i < 128; i++) {
        seed = seed * 1103515245u + 12345u;
        snprintf(tmp, n + 64, "%s.tmp.%ld.%08x", target_path, (long)getpid(), seed);
        int fd = open(tmp, O_CREAT | O_EXCL | O_WRONLY | O_BINARY, 0600);
        if (fd >= 0) {
            *tmp_out = tmp;
            return fd;
        }
        if (errno != EEXIST) break;
    }
    free(tmp);
    *tmp_out = NULL;
    return -1;
}

/* The UI splits the transcript on newlines and treats a leading \x1e as a
 * structured event: an event emitted mid-line would be read as prose.  Track
 * the last stdout byte so emitters can force a line boundary first. */
static char g_out_last = '\n';

static void out_text(const char *s, size_t n) {
    if (!n) return;
    write_all_fd(STDOUT_FILENO, s, n);
    g_out_last = s[n - 1];
}

/* Control markers go to stderr so they never interleave with design prose. */
static void marker(const char *line) {
    write_all_fd(STDERR_FILENO, line, strlen(line));
    write_all_fd(STDERR_FILENO, "\n", 1);
}

static double now_sec(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (double)ts.tv_sec + (double)ts.tv_nsec / 1e9;
}

static int set_nonblock(int fd, bool on, int *old_flags) {
    int flags = fcntl(fd, F_GETFL, 0);
    if (flags < 0) return -1;
    if (old_flags) *old_flags = flags;
    int next = on ? (flags | O_NONBLOCK) : (flags & ~O_NONBLOCK);
    return fcntl(fd, F_SETFL, next);
}

static const char *memmem_simple(const char *hay, size_t hay_len,
                                 const char *needle, size_t needle_len) {
    if (!needle_len || needle_len > hay_len) return NULL;
    for (size_t i = 0; i + needle_len <= hay_len; i++) {
        if (hay[i] == needle[0] && memcmp(hay + i, needle, needle_len) == 0)
            return hay + i;
    }
    return NULL;
}

static bool bytes_is_partial_prefix(const char *p, size_t n, const char *prefix) {
    size_t plen = strlen(prefix);
    return n < plen && memcmp(prefix, p, n) == 0;
}

/* ==================== structured UI events (--jsonl) ==================== */
/* Same wire format the DStudio UI consumes from ds4-agent-jsonl: one JSON
 * object per line, prefixed by \x1e so the consumer needs no heuristics. */

static bool g_jsonl = false;

static void json_escape_buf(design_buf *b, const char *s, size_t n) {
    for (size_t i = 0; i < n; i++) {
        unsigned char c = (unsigned char)s[i];
        char esc[8];
        switch (c) {
            case '"':  buf_puts(b, "\\\""); break;
            case '\\': buf_puts(b, "\\\\"); break;
            case '\n': buf_puts(b, "\\n");  break;
            case '\r': buf_puts(b, "\\r");  break;
            case '\t': buf_puts(b, "\\t");  break;
            default:
                if (c < 0x20) {
                    snprintf(esc, sizeof(esc), "\\u%04x", c);
                    buf_puts(b, esc);
                } else {
                    buf_append(b, (const char *)&s[i], 1);
                }
        }
    }
}

static void emit_event_line(design_buf *b) {
    if (g_out_last != '\n') out_text("\n", 1);
    out_text(b->ptr ? b->ptr : "", b->len);
    free(b->ptr);
    memset(b, 0, sizeof(*b));
}

static void emit_event(const char *type) {
    if (!g_jsonl) return;
    design_buf b = {0};
    buf_puts(&b, "\x1e{\"type\":\"");
    buf_puts(&b, type);
    buf_puts(&b, "\"}\n");
    emit_event_line(&b);
}

/* Todos card: the todos parameter is already JSON authored by the model.
 * Embed it verbatim (newlines and the \x1e prefix would break the line
 * protocol, so they are flattened); the UI try/catches the parse. */
static void emit_todos_event(const char *todos_json) {
    if (!g_jsonl) return;
    design_buf b = {0};
    buf_puts(&b, "\x1e{\"type\":\"todos\",\"todos\":");
    for (const char *p = todos_json; *p; p++) {
        char c = *p;
        if (c == '\n' || c == '\r' || c == '\x1e') c = ' ';
        buf_append(&b, &c, 1);
    }
    buf_puts(&b, "}\n");
    emit_event_line(&b);
}

static void emit_artifact_event(const char *entry, const char *title,
                                const char *manifest_json) {
    if (!g_jsonl) return;
    design_buf b = {0};
    buf_puts(&b, "\x1e{\"type\":\"artifact\",\"entry\":\"");
    json_escape_buf(&b, entry, strlen(entry));
    buf_puts(&b, "\",\"title\":\"");
    json_escape_buf(&b, title ? title : "", title ? strlen(title) : 0);
    if (manifest_json && manifest_json[0]) {
        buf_puts(&b, "\",\"manifest\":");
        for (const char *p = manifest_json; *p; p++) {
            char c = *p;
            if (c == '\n' || c == '\r' || c == '\x1e') c = ' ';
            buf_append(&b, &c, 1);
        }
        buf_puts(&b, "}\n");
    } else {
        buf_puts(&b, "\"}\n");
    }
    emit_event_line(&b);
}

/* Multi-direction proposal: the model wrote N self-contained HTML files and is
 * proposing them as PARALLEL alternatives (not a version lineage). The UI shows
 * a compare grid; picking one starts the version history on that file. The raw
 * directions JSON is passed through (control chars flattened, like todos). */
static void emit_proposal_event(const char *directions_json) {
    if (!g_jsonl) return;
    design_buf b = {0};
    buf_puts(&b, "\x1e{\"type\":\"proposal\",\"directions\":");
    for (const char *p = directions_json; *p; p++) {
        char c = *p;
        if (c == '\n' || c == '\r' || c == '\x1e') c = ' ';
        buf_append(&b, &c, 1);
    }
    buf_puts(&b, "}\n");
    emit_event_line(&b);
}

/* Session-command outcomes: a short status line for the UI.  In jsonl mode it
 * is a {"type":"session_status",...} event; otherwise it goes to stderr (the
 * launcher terminal) so it never pollutes the design transcript on stdout. */
static void emit_session_status(const char *level, const char *msg) {
    if (g_jsonl) {
        design_buf b = {0};
        buf_puts(&b, "\x1e{\"type\":\"session_status\",\"level\":\"");
        json_escape_buf(&b, level, strlen(level));
        buf_puts(&b, "\",\"message\":\"");
        json_escape_buf(&b, msg ? msg : "", msg ? strlen(msg) : 0);
        buf_puts(&b, "\"}\n");
        emit_event_line(&b);
    } else {
        fprintf(stderr, "ds4-design: %s\n", msg ? msg : "");
    }
}

static void emit_protocol_event(void) {
    if (!g_jsonl) return;
    design_buf b = {0};
    buf_puts(&b, "\x1e{\"type\":\"protocol\",\"name\":\"ds4-design\","
                 "\"version\":2,\"capabilities\":["
                 "\"todos_v2\","
                 "\"artifact_manifest_v1\","
                 "\"artifact_check_v1\","
                 "\"critique_event_v1\","
                 "\"quality_gate_v1\","
                 "\"question_event_v1\","
                 "\"compact_v1\","
                 "\"memory_md_v1\","
                 "\"design_skill_metadata_v1\"]}\n");
    emit_event_line(&b);
}

static void emit_question_event(const char *id, const char *title,
                                const char *questions_json) {
    if (!g_jsonl) return;
    design_buf b = {0};
    buf_puts(&b, "\x1e{\"type\":\"question\",\"id\":\"");
    json_escape_buf(&b, id ? id : "", id ? strlen(id) : 0);
    buf_puts(&b, "\",\"title\":\"");
    json_escape_buf(&b, title ? title : "", title ? strlen(title) : 0);
    buf_puts(&b, "\",\"questions\":");
    for (const char *p = questions_json ? questions_json : "[]"; *p; p++) {
        char c = *p;
        if (c == '\n' || c == '\r' || c == '\x1e') c = ' ';
        buf_append(&b, &c, 1);
    }
    buf_puts(&b, "}\n");
    emit_event_line(&b);
}

/* ---- small JSON scanner -------------------------------------------------------
 * Not a DOM: just enough to validate the model-authored tool parameters and to
 * extract string fields from arrays of objects.  It rejects malformed JSON so
 * UI state is driven by runtime guarantees, not prompt compliance. */

static const char *json_ws(const char *p, const char *end) {
    while (p < end && (*p == ' ' || *p == '\t' || *p == '\n' || *p == '\r')) p++;
    return p;
}

static int json_hexval(int c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return 10 + c - 'a';
    if (c >= 'A' && c <= 'F') return 10 + c - 'A';
    return -1;
}

static bool json_hex4(const char *p, const char *end, uint32_t *cp) {
    if (end - p < 4) return false;
    uint32_t v = 0;
    for (int i = 0; i < 4; i++) {
        int h = json_hexval((unsigned char)p[i]);
        if (h < 0) return false;
        v = (v << 4) | (uint32_t)h;
    }
    *cp = v;
    return true;
}

static void json_put_utf8(design_buf *b, uint32_t cp) {
    char out[4];
    if (cp <= 0x7F) {
        out[0] = (char)cp;
        buf_append(b, out, 1);
    } else if (cp <= 0x7FF) {
        out[0] = (char)(0xC0 | (cp >> 6));
        out[1] = (char)(0x80 | (cp & 0x3F));
        buf_append(b, out, 2);
    } else if (cp <= 0xFFFF) {
        out[0] = (char)(0xE0 | (cp >> 12));
        out[1] = (char)(0x80 | ((cp >> 6) & 0x3F));
        out[2] = (char)(0x80 | (cp & 0x3F));
        buf_append(b, out, 3);
    } else if (cp <= 0x10FFFF) {
        out[0] = (char)(0xF0 | (cp >> 18));
        out[1] = (char)(0x80 | ((cp >> 12) & 0x3F));
        out[2] = (char)(0x80 | ((cp >> 6) & 0x3F));
        out[3] = (char)(0x80 | (cp & 0x3F));
        buf_append(b, out, 4);
    }
}

static bool json_parse_string_to_buf(const char **pp, const char *end,
                                     design_buf *out, char *err, size_t errsz) {
    const char *p = *pp;
    if (p >= end || *p != '"') {
        snprintf(err, errsz, "expected JSON string");
        return false;
    }
    p++;
    while (p < end) {
        unsigned char c = (unsigned char)*p++;
        if (c == '"') {
            *pp = p;
            return true;
        }
        if (c < 0x20) {
            snprintf(err, errsz, "control character in JSON string");
            return false;
        }
        if (c != '\\') {
            buf_append(out, (const char *)&c, 1);
            continue;
        }
        if (p >= end) {
            snprintf(err, errsz, "unterminated JSON escape");
            return false;
        }
        char e = *p++;
        switch (e) {
            case '"': buf_puts(out, "\""); break;
            case '\\': buf_puts(out, "\\"); break;
            case '/': buf_puts(out, "/"); break;
            case 'b': buf_append(out, "\b", 1); break;
            case 'f': buf_append(out, "\f", 1); break;
            case 'n': buf_puts(out, "\n"); break;
            case 'r': buf_puts(out, "\r"); break;
            case 't': buf_puts(out, "\t"); break;
            case 'u': {
                uint32_t cp = 0;
                if (!json_hex4(p, end, &cp)) {
                    snprintf(err, errsz, "bad JSON unicode escape");
                    return false;
                }
                p += 4;
                if (cp >= 0xD800 && cp <= 0xDBFF &&
                    end - p >= 6 && p[0] == '\\' && p[1] == 'u')
                {
                    uint32_t lo = 0;
                    if (json_hex4(p + 2, end, &lo) && lo >= 0xDC00 && lo <= 0xDFFF) {
                        cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
                        p += 6;
                    }
                }
                if (cp >= 0xD800 && cp <= 0xDFFF) cp = 0xFFFD;
                json_put_utf8(out, cp);
                break;
            }
            default:
                snprintf(err, errsz, "bad JSON escape");
                return false;
        }
    }
    snprintf(err, errsz, "unterminated JSON string");
    return false;
}

static char *json_parse_string_alloc(const char **pp, const char *end,
                                     char *err, size_t errsz) {
    design_buf b = {0};
    if (!json_parse_string_to_buf(pp, end, &b, err, errsz)) {
        free(b.ptr);
        return NULL;
    }
    return buf_take(&b);
}

static const char *json_skip_value(const char *p, const char *end,
                                   int depth, char *err, size_t errsz);

static const char *json_skip_string(const char *p, const char *end,
                                    char *err, size_t errsz) {
    design_buf tmp = {0};
    const char *q = p;
    bool ok = json_parse_string_to_buf(&q, end, &tmp, err, errsz);
    free(tmp.ptr);
    return ok ? q : NULL;
}

static const char *json_skip_number(const char *p, const char *end,
                                    char *err, size_t errsz) {
    if (p < end && *p == '-') p++;
    if (p >= end) { snprintf(err, errsz, "bad JSON number"); return NULL; }
    if (*p == '0') {
        p++;
    } else if (*p >= '1' && *p <= '9') {
        while (p < end && isdigit((unsigned char)*p)) p++;
    } else {
        snprintf(err, errsz, "bad JSON number");
        return NULL;
    }
    if (p < end && *p == '.') {
        p++;
        if (p >= end || !isdigit((unsigned char)*p)) {
            snprintf(err, errsz, "bad JSON number");
            return NULL;
        }
        while (p < end && isdigit((unsigned char)*p)) p++;
    }
    if (p < end && (*p == 'e' || *p == 'E')) {
        p++;
        if (p < end && (*p == '+' || *p == '-')) p++;
        if (p >= end || !isdigit((unsigned char)*p)) {
            snprintf(err, errsz, "bad JSON number");
            return NULL;
        }
        while (p < end && isdigit((unsigned char)*p)) p++;
    }
    return p;
}

static const char *json_skip_array(const char *p, const char *end,
                                   int depth, char *err, size_t errsz) {
    p++;
    p = json_ws(p, end);
    if (p < end && *p == ']') return p + 1;
    for (;;) {
        p = json_skip_value(p, end, depth + 1, err, errsz);
        if (!p) return NULL;
        p = json_ws(p, end);
        if (p < end && *p == ',') { p++; continue; }
        if (p < end && *p == ']') return p + 1;
        snprintf(err, errsz, "expected ',' or ']' in JSON array");
        return NULL;
    }
}

static const char *json_skip_object(const char *p, const char *end,
                                    int depth, char *err, size_t errsz) {
    p++;
    p = json_ws(p, end);
    if (p < end && *p == '}') return p + 1;
    for (;;) {
        p = json_ws(p, end);
        if (p >= end || *p != '"') {
            snprintf(err, errsz, "expected JSON object key");
            return NULL;
        }
        p = json_skip_string(p, end, err, errsz);
        if (!p) return NULL;
        p = json_ws(p, end);
        if (p >= end || *p != ':') {
            snprintf(err, errsz, "expected ':' after JSON object key");
            return NULL;
        }
        p++;
        p = json_skip_value(p, end, depth + 1, err, errsz);
        if (!p) return NULL;
        p = json_ws(p, end);
        if (p < end && *p == ',') { p++; continue; }
        if (p < end && *p == '}') return p + 1;
        snprintf(err, errsz, "expected ',' or '}' in JSON object");
        return NULL;
    }
}

static const char *json_skip_value(const char *p, const char *end,
                                   int depth, char *err, size_t errsz) {
    if (depth > 64) {
        snprintf(err, errsz, "JSON nesting too deep");
        return NULL;
    }
    p = json_ws(p, end);
    if (p >= end) {
        snprintf(err, errsz, "expected JSON value");
        return NULL;
    }
    if (*p == '"') return json_skip_string(p, end, err, errsz);
    if (*p == '{') return json_skip_object(p, end, depth, err, errsz);
    if (*p == '[') return json_skip_array(p, end, depth, err, errsz);
    if (*p == '-' || isdigit((unsigned char)*p)) return json_skip_number(p, end, err, errsz);
    if (end - p >= 4 && !memcmp(p, "true", 4)) return p + 4;
    if (end - p >= 5 && !memcmp(p, "false", 5)) return p + 5;
    if (end - p >= 4 && !memcmp(p, "null", 4)) return p + 4;
    snprintf(err, errsz, "bad JSON value");
    return NULL;
}

static bool json_validate_complete(const char *json, char required_first,
                                   char *err, size_t errsz) {
    if (!json) {
        snprintf(err, errsz, "missing JSON");
        return false;
    }
    const char *end = json + strlen(json);
    const char *p = json_ws(json, end);
    if (required_first && (p >= end || *p != required_first)) {
        snprintf(err, errsz, "JSON must start with '%c'", required_first);
        return false;
    }
    p = json_skip_value(p, end, 0, err, errsz);
    if (!p) return false;
    p = json_ws(p, end);
    if (p != end) {
        snprintf(err, errsz, "trailing data after JSON value");
        return false;
    }
    return true;
}

typedef struct {
    char **v;
    int len;
    int cap;
} design_string_list;

static void design_string_list_push(design_string_list *l, char *s) {
    if (l->len == l->cap) {
        l->cap = l->cap ? l->cap * 2 : 8;
        l->v = xrealloc(l->v, (size_t)l->cap * sizeof(l->v[0]));
    }
    l->v[l->len++] = s;
}

static void design_string_list_free(design_string_list *l) {
    for (int i = 0; i < l->len; i++) free(l->v[i]);
    free(l->v);
    memset(l, 0, sizeof(*l));
}

static bool json_parse_string_array(const char *json, design_string_list *out,
                                    char *err, size_t errsz) {
    memset(out, 0, sizeof(*out));
    const char *end = json + strlen(json);
    const char *p = json_ws(json, end);
    if (p >= end || *p != '[') {
        snprintf(err, errsz, "expected JSON array of strings");
        return false;
    }
    p++;
    p = json_ws(p, end);
    if (p < end && *p == ']') return true;
    for (;;) {
        p = json_ws(p, end);
        char *s = json_parse_string_alloc(&p, end, err, errsz);
        if (!s) { design_string_list_free(out); return false; }
        design_string_list_push(out, s);
        p = json_ws(p, end);
        if (p < end && *p == ',') { p++; continue; }
        if (p < end && *p == ']') {
            p++;
            p = json_ws(p, end);
            if (p != end) {
                snprintf(err, errsz, "trailing data after JSON string array");
                design_string_list_free(out);
                return false;
            }
            return true;
        }
        snprintf(err, errsz, "expected ',' or ']' in JSON string array");
        design_string_list_free(out);
        return false;
    }
}

/* ============================================================================
 * DSML Tool-Call Parser
 * ============================================================================
 *
 * Direct port of the parser in ds4_agent.c: strict after the opening marker,
 * tolerant only about closing-tag whitespace/bar variants the model has been
 * observed to emit.  Keeping the grammar byte-identical means both agents
 * accept exactly the same stanzas.
 */

typedef struct {
    char *name;
    char *value;
    bool is_string;
} design_tool_arg;

typedef struct {
    char *name;
    design_tool_arg *args;
    int argc;
    int argcap;
} design_tool_call;

typedef struct {
    design_tool_call *v;
    int len;
    int cap;
} design_tool_calls;

typedef enum {
    DSML_SEARCH,
    DSML_STRUCTURAL,
    DSML_PARAM_VALUE,
    DSML_DONE,
    DSML_ERROR,
} dsml_state;

typedef struct {
    dsml_state state;
    char search_tail[64];
    size_t search_len;
    char *raw;
    size_t raw_len;
    size_t raw_cap;
    size_t parse_pos;
    design_tool_call current;
    char *param_name;
    bool param_is_string;
    size_t param_value_start;
    bool param_close_prefix;
    design_tool_calls calls;
    char error[160];
} dsml_parser;

static void tool_call_free(design_tool_call *c) {
    if (!c) return;
    free(c->name);
    for (int i = 0; i < c->argc; i++) {
        free(c->args[i].name);
        free(c->args[i].value);
    }
    free(c->args);
    memset(c, 0, sizeof(*c));
}

static void tool_calls_free(design_tool_calls *calls) {
    if (!calls) return;
    for (int i = 0; i < calls->len; i++) tool_call_free(&calls->v[i]);
    free(calls->v);
    memset(calls, 0, sizeof(*calls));
}

static void tool_call_add_arg(design_tool_call *c, const char *name,
                              const char *value, size_t value_len,
                              bool is_string) {
    if (c->argc == c->argcap) {
        c->argcap = c->argcap ? c->argcap * 2 : 4;
        c->args = xrealloc(c->args, (size_t)c->argcap * sizeof(c->args[0]));
    }
    c->args[c->argc].name = xstrdup(name);
    c->args[c->argc].value = xstrndup(value, value_len);
    c->args[c->argc].is_string = is_string;
    c->argc++;
}

static void tool_calls_push(design_tool_calls *calls, design_tool_call *call) {
    if (!call->name) return;
    if (calls->len == calls->cap) {
        calls->cap = calls->cap ? calls->cap * 2 : 2;
        calls->v = xrealloc(calls->v, (size_t)calls->cap * sizeof(calls->v[0]));
    }
    calls->v[calls->len++] = *call;
    memset(call, 0, sizeof(*call));
}

static const char *tool_arg_value(const design_tool_call *call, const char *name) {
    for (int i = 0; i < call->argc; i++) {
        if (call->args[i].name && !strcmp(call->args[i].name, name))
            return call->args[i].value ? call->args[i].value : "";
    }
    return NULL;
}

static void dsml_parser_free(dsml_parser *p) {
    if (!p) return;
    free(p->raw);
    tool_call_free(&p->current);
    free(p->param_name);
    tool_calls_free(&p->calls);
    memset(p, 0, sizeof(*p));
}

static void dsml_raw_append(dsml_parser *p, const char *s, size_t n) {
    if (!n) return;
    if (p->raw_len + n + 1 > p->raw_cap) {
        size_t cap = p->raw_cap ? p->raw_cap * 2 : 512;
        while (cap < p->raw_len + n + 1) cap *= 2;
        p->raw = xrealloc(p->raw, cap);
        p->raw_cap = cap;
    }
    memcpy(p->raw + p->raw_len, s, n);
    p->raw_len += n;
    p->raw[p->raw_len] = '\0';
}

static char *dsml_parse_attr(const char *tag, const char *name) {
    char pat[64];
    snprintf(pat, sizeof(pat), "%s=\"", name);
    const char *p = strstr(tag, pat);
    if (!p) return NULL;
    p += strlen(pat);
    const char *end = strchr(p, '"');
    if (!end) return NULL;
    return xstrndup(p, (size_t)(end - p));
}

static void dsml_set_error(dsml_parser *p, const char *msg) {
    p->state = DSML_ERROR;
    snprintf(p->error, sizeof(p->error), "%s", msg);
}

static bool dsml_open_tag_is(const char *tag, const char *name) {
    char prefix[64];
    snprintf(prefix, sizeof(prefix), "<｜DSML｜%s", name);
    size_t prefix_len = strlen(prefix);
    if (strncmp(tag, prefix, prefix_len) != 0) return false;
    char c = tag[prefix_len];
    return c == '>' || c == ' ' || c == '\t' || c == '\r' || c == '\n';
}

static bool dsml_close_tag_at(const char *s, const char *name, size_t *tag_len) {
    char prefix[64];
    static const char dsml_bar[] = "｜";
    snprintf(prefix, sizeof(prefix), "</｜DSML｜%s", name);
    size_t prefix_len = strlen(prefix);
    if (strncmp(s, prefix, prefix_len) != 0) return false;
    const char *p = s + prefix_len;
    while (*p == ' ' || *p == '\t' || *p == '\r' || *p == '\n') p++;
    if (strncmp(p, dsml_bar, strlen(dsml_bar)) == 0) p += strlen(dsml_bar);
    while (*p == ' ' || *p == '\t' || *p == '\r' || *p == '\n') p++;
    if (*p != '>') return false;
    if (tag_len) *tag_len = (size_t)(p - s) + 1;
    return true;
}

/* Recognize a streamed parameter close-tag prefix.  Needed online: while a
 * parameter value is open we must know whether the value's tail could be DSML
 * syntax (forcing greedy decoding) or is ordinary text containing "</". */
static bool dsml_parameter_close_tail(const char *tail, size_t len, bool *complete) {
    static const char prefix[] = "</｜DSML｜parameter";
    static const char dsml_bar[] = "｜";
    const size_t prefix_len = sizeof(prefix) - 1;
    const size_t bar_len = sizeof(dsml_bar) - 1;
    *complete = false;
    if (len <= prefix_len) return memcmp(prefix, tail, len) == 0;
    if (memcmp(prefix, tail, prefix_len) != 0) return false;
    size_t i = prefix_len;
    while (i < len && (tail[i] == ' ' || tail[i] == '\t' ||
                       tail[i] == '\r' || tail[i] == '\n')) i++;
    if (i < len && len - i <= bar_len) {
        if (memcmp(dsml_bar, tail + i, len - i) == 0) return true;
    }
    if (i + bar_len <= len && memcmp(tail + i, dsml_bar, bar_len) == 0)
        i += bar_len;
    for (; i < len; i++) {
        if (tail[i] == '>') {
            *complete = i == len - 1;
            return *complete;
        }
        if (tail[i] != ' ' && tail[i] != '\t' && tail[i] != '\r' && tail[i] != '\n')
            return false;
    }
    return true;
}

static void dsml_update_param_close_prefix(dsml_parser *p) {
    p->param_close_prefix = false;
    if (p->state != DSML_PARAM_VALUE || p->raw_len <= p->param_value_start)
        return;
    const char *value = p->raw + p->param_value_start;
    const char *end = p->raw + p->raw_len;
    const char *lt = end;
    while (lt > value) {
        lt--;
        if (*lt == '<') break;
    }
    if (lt < value || *lt != '<') return;
    size_t tail_len = (size_t)(end - lt);
    if (tail_len > 64) return;
    bool complete = false;
    static const char dsml_marker[] = "</｜DSML｜";
    p->param_close_prefix =
        tail_len >= sizeof(dsml_marker) - 1 &&
        memcmp(lt, dsml_marker, sizeof(dsml_marker) - 1) == 0 &&
        dsml_parameter_close_tail(lt, tail_len, &complete) &&
        !complete;
}

static char *dsml_find_close_tag(const char *s, const char *name, size_t *tag_len) {
    const char *p = s;
    while ((p = strstr(p, "</｜DSML｜")) != NULL) {
        if (dsml_close_tag_at(p, name, tag_len)) return (char *)p;
        p++;
    }
    return NULL;
}

static void dsml_parse(dsml_parser *p) {
    while (p->state == DSML_STRUCTURAL || p->state == DSML_PARAM_VALUE) {
        if (p->state == DSML_PARAM_VALUE) {
            size_t end_tag_len = 0;
            char *end = dsml_find_close_tag(p->raw + p->param_value_start,
                                            "parameter", &end_tag_len);
            if (!end) return;
            tool_call_add_arg(&p->current, p->param_name ? p->param_name : "",
                              p->raw + p->param_value_start,
                              (size_t)(end - (p->raw + p->param_value_start)),
                              p->param_is_string);
            p->param_close_prefix = false;
            free(p->param_name);
            p->param_name = NULL;
            p->parse_pos = (size_t)(end - p->raw) + end_tag_len;
            p->state = DSML_STRUCTURAL;
            continue;
        }

        while (p->parse_pos < p->raw_len &&
               (p->raw[p->parse_pos] == ' ' || p->raw[p->parse_pos] == '\t' ||
                p->raw[p->parse_pos] == '\r' || p->raw[p->parse_pos] == '\n'))
            p->parse_pos++;
        if (p->parse_pos >= p->raw_len) return;

        size_t close_len = 0;
        if (dsml_close_tag_at(p->raw + p->parse_pos, "tool_calls", &close_len)) {
            tool_calls_push(&p->calls, &p->current);
            p->parse_pos += close_len;
            p->state = DSML_DONE;
            return;
        }
        if (dsml_close_tag_at(p->raw + p->parse_pos, "invoke", &close_len)) {
            tool_calls_push(&p->calls, &p->current);
            p->parse_pos += close_len;
            continue;
        }

        char *tag_end = strchr(p->raw + p->parse_pos, '>');
        if (!tag_end) return;
        size_t tag_len = (size_t)(tag_end - (p->raw + p->parse_pos)) + 1;
        char *tag = xstrndup(p->raw + p->parse_pos, tag_len);

        if (dsml_open_tag_is(tag, "invoke")) {
            tool_call_free(&p->current);
            p->current.name = dsml_parse_attr(tag, "name");
            if (!p->current.name) {
                free(tag);
                dsml_set_error(p, "tool invoke without name");
                return;
            }
            p->parse_pos += tag_len;
        } else if (dsml_open_tag_is(tag, "parameter")) {
            free(p->param_name);
            p->param_name = dsml_parse_attr(tag, "name");
            char *is_string = dsml_parse_attr(tag, "string");
            p->param_is_string = is_string && !strcmp(is_string, "true");
            free(is_string);
            if (!p->param_name) {
                free(tag);
                dsml_set_error(p, "tool parameter without name");
                return;
            }
            p->parse_pos += tag_len;
            p->param_value_start = p->parse_pos;
            p->param_close_prefix = false;
            p->state = DSML_PARAM_VALUE;
        } else {
            snprintf(p->error, sizeof(p->error), "unexpected DSML tag: %.*s",
                     (int)(tag_len > 80 ? 80 : tag_len), tag);
            free(tag);
            p->state = DSML_ERROR;
            return;
        }
        free(tag);
    }
}

static const char DSML_START[] = "<｜DSML｜tool_calls>";

static void dsml_feed(dsml_parser *p, const char *s, size_t n) {
    const size_t start_len = sizeof(DSML_START) - 1;
    if (p->state == DSML_DONE || p->state == DSML_ERROR) return;

    for (size_t i = 0; i < n; i++) {
        char c = s[i];
        if (p->state == DSML_SEARCH) {
            if (p->search_len == sizeof(p->search_tail)) {
                memmove(p->search_tail, p->search_tail + 1, --p->search_len);
            }
            p->search_tail[p->search_len++] = c;
            if (p->search_len >= start_len &&
                memcmp(p->search_tail + p->search_len - start_len,
                       DSML_START, start_len) == 0)
            {
                p->state = DSML_STRUCTURAL;
                p->search_len = 0;
                dsml_raw_append(p, DSML_START, start_len);
                p->parse_pos = start_len;
            }
            continue;
        }
        dsml_raw_append(p, &c, 1);
        dsml_parse(p);
        if (p->state == DSML_PARAM_VALUE)
            dsml_update_param_close_prefix(p);
        else
            p->param_close_prefix = false;
    }
}

/* ============================================================================
 * Streamed Output With DSML Holdback
 * ============================================================================
 *
 * Assistant prose streams to stdout as it is sampled, but raw DSML must never
 * reach the transcript the UI shows.  While the parser is still searching we
 * hold back any suffix that is a partial prefix of the opening marker; once
 * the stanza starts, everything is swallowed until the round ends.
 */

typedef struct {
    dsml_parser *parser;
    char hold[64];
    size_t hold_len;
    bool suppressed; /* DSML started this round: drop the rest of the stream */
} design_stream;

static void stream_text(design_stream *st, const char *s, size_t n) {
    for (size_t i = 0; i < n; i++) {
        char c = s[i];
        if (st->suppressed) {
            dsml_feed(st->parser, &c, 1);
            continue;
        }
        if (st->hold_len == sizeof(st->hold)) { /* cannot happen: marker < 64 */
            out_text(st->hold, 1);
            memmove(st->hold, st->hold + 1, --st->hold_len);
        }
        st->hold[st->hold_len++] = c;
        dsml_feed(st->parser, &c, 1);
        if (st->parser->state != DSML_SEARCH) {
            /* The held bytes were the opening marker tail: swallow them. */
            st->hold_len = 0;
            st->suppressed = true;
            continue;
        }
        while (st->hold_len &&
               !bytes_is_partial_prefix(st->hold, st->hold_len, DSML_START)) {
            out_text(st->hold, 1);
            memmove(st->hold, st->hold + 1, --st->hold_len);
        }
    }
}

static void stream_finish(design_stream *st) {
    if (!st->suppressed && st->hold_len) out_text(st->hold, st->hold_len);
    st->hold_len = 0;
}

/* Same rule as ds4-agent: decode DSML structure greedily because it is a
 * machine grammar, but keep configured sampling inside parameter values
 * (design content), except when the value's tail is clearly a closing tag. */
static bool stream_wants_greedy(const design_stream *st) {
    if (st->parser->state == DSML_ERROR || st->parser->state == DSML_DONE)
        return false;
    if (st->hold_len > 1) return true; /* partial opening marker held back */
    if (st->parser->state == DSML_STRUCTURAL) return true;
    if (st->parser->state != DSML_PARAM_VALUE) return false;
    return st->parser->param_close_prefix;
}

/* ============================================================================
 * Project Directory And Sandboxed Path Resolution
 * ============================================================================
 *
 * The workspace is the project directory: the agent reads and
 * writes free-form files in it and nothing outside it.  The sandbox is the
 * path validator: relative paths only, no "..", no absolute, no control
 * bytes.  Subdirectories (screens/, css/, js/) are allowed and created on
 * write, exactly like an agent CLI working with cwd = project dir.
 */

struct design_bash_job; /* forward: bash jobs are owned by the project */

typedef struct {
    char dir[PATH_MAX];
    /* "more" continuation state, populated by tool_read on a truncated read and
     * consumed by tool_more. The path is project-relative and re-resolved
     * through project_resolve() on every use, so stale/corrupted state cannot
     * escape the sandbox. */
    char more_path[PATH_MAX];
    int  more_next_line;
    bool more_valid;
    /* bash job list (single-thread: each turn drains jobs opportunistically,
     * exactly like ds4-agent but without a reaper thread). */
    struct design_bash_job *bash_jobs;
    int next_bash_job_id;
    /* web tooling (Chrome via CDP). Owned by main(); the dispatch reaches it
     * through &a->project, like the bash jobs. NULL if creation failed. */
    ds4_web *web;
    /* Canonical normalized TodoWrite state. The UI gets the same snapshot on
     * every update, independent of whatever field names the model used. */
    char *todos_json;
    bool todos_have_in_progress;
    /* Application/runtime state. KV cache remains the model-side memory; these
     * fields back the project-local event log/state files the UI can replay. */
    uint64_t event_seq;
    char run_id[64];
    char phase[32];
    char current_artifact_id[17];
    char current_artifact_entry[PATH_MAX];
    bool stop_after_tools;
    bool discovery_satisfied;
    char *memory_summary;
    char memory_updated_at[32];
    char critique_entry[PATH_MAX];
    char critique_updated_at[32];
    design_critique_scores critique_scores;
    int critique_must_fixes;
    bool critique_passed;
} design_project;

static bool design_mkdir_p(const char *path) {
    char tmp[PATH_MAX];
    snprintf(tmp, sizeof(tmp), "%s", path);
    for (char *p = tmp + 1; *p; p++) {
        if (*p != '/') continue;
        *p = '\0';
        if (mkdir(tmp, 0755) != 0 && errno != EEXIST) return false;
        *p = '/';
    }
    return mkdir(tmp, 0755) == 0 || errno == EEXIST;
}

/* Validate a project-relative path and resolve it under the workspace.
 * Returns false with err set when the path tries to escape. */
static bool project_resolve(const design_project *pr, const char *rel,
                            char *out, size_t outsz, char *err, size_t errsz) {
    if (!rel || !rel[0]) { snprintf(err, errsz, "path is required"); return false; }
    if (rel[0] == '/' || rel[0] == '~') {
        snprintf(err, errsz, "path must be relative to the project directory");
        return false;
    }
    size_t len = strlen(rel);
    if (len > 512) { snprintf(err, errsz, "path too long"); return false; }
    for (size_t i = 0; i < len; i++) {
        unsigned char c = (unsigned char)rel[i];
        if (c < 0x20 || c == '\\') {
            snprintf(err, errsz, "path contains invalid characters");
            return false;
        }
    }
    /* Reject any ".." component (escape) and "." noise. */
    const char *p = rel;
    while (*p) {
        const char *seg = p;
        while (*p && *p != '/') p++;
        size_t seglen = (size_t)(p - seg);
        if (seglen == 0 || (seglen == 1 && seg[0] == '.') ||
            (seglen == 2 && seg[0] == '.' && seg[1] == '.'))
        {
            snprintf(err, errsz, "path must be a plain relative path (no .. or //)");
            return false;
        }
        if (*p == '/') p++;
    }
    char joined[PATH_MAX];
    if ((size_t)snprintf(joined, sizeof(joined), "%s/%s", pr->dir, rel) >= sizeof(joined)) {
        snprintf(err, errsz, "path too long");
        return false;
    }
    /* The string checks above block "..", absolute paths and backslashes, but
     * NOT symlinks: a symlinked directory component (e.g. "link/x" with
     * link->/etc) escapes because the kernel follows intermediate symlinks. So
     * we canonicalize the deepest EXISTING ancestor with realpath() (which
     * resolves ALL symlinks) and check it stays under the canonicalized root;
     * the trailing components that do not exist yet (write/mkdir of new
     * files/subfolders) are already guaranteed ".."-free, hence safe to
     * append. Single gate for every filesystem access. */
    char real_root[PATH_MAX];
    if (!realpath(pr->dir, real_root)) {
        snprintf(err, errsz, "project dir unavailable");
        return false;
    }
    char probe[PATH_MAX], tail[PATH_MAX] = "";
    snprintf(probe, sizeof(probe), "%s", joined);
    for (;;) {
        char canon[PATH_MAX];
        if (realpath(probe, canon)) {
            size_t rl = strlen(real_root);
            if (strncmp(canon, real_root, rl) != 0 ||
                (canon[rl] != '\0' && canon[rl] != '/')) {
                snprintf(err, errsz, "the path escapes the project folder");
                return false;
            }
            int n = tail[0] ? snprintf(out, outsz, "%s/%s", canon, tail)
                            : snprintf(out, outsz, "%s", canon);
            if (n < 0 || (size_t)n >= outsz) {
                snprintf(err, errsz, "path too long");
                return false;
            }
            return true;
        }
        if (errno != ENOENT && errno != ENOTDIR) {
            snprintf(err, errsz, "path unavailable: %s", strerror(errno));
            return false;
        }
        /* realpath failed: if this component EXISTS as a symlink (dangling /
         * unresolvable target), refuse — we cannot append it raw to the tail
         * because open()/opendir would follow it (escape). Only the components
         * that are truly absent (ENOENT on lstat) are new and safe. */
        struct stat lst;
        if (lstat(probe, &lst) == 0 && S_ISLNK(lst.st_mode)) {
            snprintf(err, errsz, "the path crosses a symlink");
            return false;
        }
        char *sl = strrchr(probe, '/');
        if (!sl || sl == probe) {           /* should not happen: pr->dir exists */
            snprintf(err, errsz, "invalid path");
            return false;
        }
        char comp[PATH_MAX], merged[PATH_MAX];
        snprintf(comp, sizeof(comp), "%s", sl + 1);   /* move the last component to the head of tail */
        *sl = '\0';
        if (tail[0]) {
            if ((size_t)snprintf(merged, sizeof(merged), "%s/%s", comp, tail) >= sizeof(merged)) {
                snprintf(err, errsz, "path too long");
                return false;
            }
            snprintf(tail, sizeof(tail), "%s", merged);
        } else {
            snprintf(tail, sizeof(tail), "%s", comp);
        }
    }
}

static int read_file_bytes(const char *path, char **out, size_t *out_len,
                           char *err, size_t errsz) {
    FILE *fp = fopen(path, "rb");
    if (!fp) { snprintf(err, errsz, "open failed: %s", strerror(errno)); return -1; }
    if (fseek(fp, 0, SEEK_END) != 0) { fclose(fp); snprintf(err, errsz, "seek failed"); return -1; }
    long sz = ftell(fp);
    if (sz < 0 || sz > DESIGN_FILE_MAX) {
        fclose(fp);
        snprintf(err, errsz, "file too large");
        return -1;
    }
    rewind(fp);
    char *buf = xmalloc((size_t)sz + 1);
    if (fread(buf, 1, (size_t)sz, fp) != (size_t)sz) {
        free(buf);
        fclose(fp);
        snprintf(err, errsz, "read failed");
        return -1;
    }
    fclose(fp);
    buf[sz] = '\0';
    *out = buf;
    *out_len = (size_t)sz;
    return 0;
}

static bool write_file_bytes(const char *path, const char *data, size_t len,
                             char *err, size_t errsz) {
    /* Create parent directories: screens/01-foo.html on a fresh project. */
    char dir[PATH_MAX];
    snprintf(dir, sizeof(dir), "%s", path);
    char *slash = strrchr(dir, '/');
    if (slash) {
        *slash = '\0';
        if (!design_mkdir_p(dir)) {
            snprintf(err, errsz, "mkdir failed: %s", strerror(errno));
            return false;
        }
    }
    /* Atomic write: write to a temp in the same dir + rename(). A crash/kill
     * or a disk filling up midway NEVER leaves the canonical file truncated
     * (either the old one or the new one exists). The rename also replaces a
     * symlink at the destination with a regular file; O_NOFOLLOW avoids
     * following a symlink at the temporary path. */
    char tmp[PATH_MAX];
    int tn = snprintf(tmp, sizeof(tmp), "%s.ds4tmp.%ld", path, (long)getpid());
    if (tn < 0 || (size_t)tn >= sizeof(tmp)) {
        snprintf(err, errsz, "path too long");
        return false;
    }
    int fd = open(tmp, O_WRONLY | O_CREAT | O_TRUNC | O_NOFOLLOW | O_CLOEXEC, 0644);
    if (fd < 0) {
        snprintf(err, errsz, "open for write failed: %s", strerror(errno));
        return false;
    }
    size_t off = 0;
    while (off < len) {
        ssize_t w = write(fd, data + off, len - off);
        if (w < 0) {
            if (errno == EINTR) continue;
            snprintf(err, errsz, "write failed: %s", strerror(errno));
            close(fd);
            unlink(tmp);
            return false;
        }
        off += (size_t)w;
    }
    (void)fsync(fd);   /* best effort: the data hits the disk before the rename */
    if (close(fd) != 0) {
        snprintf(err, errsz, "write failed: %s", strerror(errno));
        unlink(tmp);
        return false;
    }
    if (rename(tmp, path) != 0) {
        snprintf(err, errsz, "rename failed: %s", strerror(errno));
        unlink(tmp);
        return false;
    }
    return true;
}

/* ---- project-local runtime memory -------------------------------------------
 * KV cache keeps DS4's inference state fast; these files are the readable app
 * memory: replayable events, current UI/runtime state, and a compact project
 * memory note for future context rebuilds. */

static void design_utc_timestamp(char out[32]) {
    time_t t = time(NULL);
    struct tm tmv;
    gmtime_r(&t, &tmv);
    strftime(out, 32, "%Y-%m-%dT%H:%M:%SZ", &tmv);
}

static void design_json_kv_string(design_buf *b, const char *key, const char *val) {
    buf_puts(b, "\"");
    json_escape_buf(b, key, strlen(key));
    buf_puts(b, "\":\"");
    json_escape_buf(b, val ? val : "", val ? strlen(val) : 0);
    buf_puts(b, "\"");
}

static void design_put_json_flat(design_buf *b, const char *json) {
    for (const char *p = json ? json : ""; *p; p++) {
        char c = *p;
        if (c == '\n' || c == '\r' || c == '\x1e') c = ' ';
        buf_append(b, &c, 1);
    }
}

static void emit_critique_event(const char *entry,
                                const design_critique_scores *scores,
                                int must_fixes, bool passed,
                                const char *decision,
                                const char *scores_json,
                                const char *must_fixes_json,
                                const char *notes) {
    if (!g_jsonl) return;
    design_buf b = {0};
    char n[64];
    buf_puts(&b, "\x1e{\"type\":\"critique\",\"entry\":\"");
    json_escape_buf(&b, entry ? entry : "", entry ? strlen(entry) : 0);
    buf_puts(&b, "\",\"rubric\":\"" DESIGN_QUALITY_RUBRIC_ID
                "\",\"composite\":");
    snprintf(n, sizeof(n), "%.2f", scores ? scores->composite : 0.0);
    buf_puts(&b, n);
    buf_puts(&b, ",\"threshold\":");
    snprintf(n, sizeof(n), "%.2f", DESIGN_QUALITY_THRESHOLD);
    buf_puts(&b, n);
    buf_puts(&b, ",\"pass\":");
    buf_puts(&b, passed ? "true" : "false");
    buf_puts(&b, ",\"mustFixes\":");
    snprintf(n, sizeof(n), "%d", must_fixes);
    buf_puts(&b, n);
    buf_puts(&b, ",\"decision\":\"");
    json_escape_buf(&b, decision ? decision : "", decision ? strlen(decision) : 0);
    buf_puts(&b, "\",\"scores\":");
    design_put_json_flat(&b, scores_json && scores_json[0] ? scores_json : "{}");
    buf_puts(&b, ",\"mustFixItems\":");
    design_put_json_flat(&b, must_fixes_json && must_fixes_json[0] ? must_fixes_json : "[]");
    buf_puts(&b, ",\"notes\":\"");
    json_escape_buf(&b, notes ? notes : "", notes ? strlen(notes) : 0);
    buf_puts(&b, "\"}\n");
    emit_event_line(&b);
}

static void design_project_clear_critique(design_project *pr) {
    if (!pr) return;
    pr->critique_entry[0] = '\0';
    pr->critique_updated_at[0] = '\0';
    memset(&pr->critique_scores, 0, sizeof(pr->critique_scores));
    pr->critique_must_fixes = 0;
    pr->critique_passed = false;
}

static bool design_project_same_entry(design_project *pr, const char *a, const char *b) {
    if (!a || !b || !a[0] || !b[0]) return false;
    char afull[PATH_MAX], bfull[PATH_MAX], err[256];
    if (!project_resolve(pr, a, afull, sizeof(afull), err, sizeof(err))) return false;
    if (!project_resolve(pr, b, bfull, sizeof(bfull), err, sizeof(err))) return false;
    return strcmp(afull, bfull) == 0;
}

static bool design_project_invalidate_critique(design_project *pr, const char *entry) {
    if (!pr || !entry || !entry[0] || !pr->critique_entry[0]) return false;
    if (design_project_same_entry(pr, pr->critique_entry, entry)) {
        design_project_clear_critique(pr);
        return true;
    }
    return false;
}

static bool design_project_critique_passes(design_project *pr, const char *entry,
                                           char *err, size_t errsz) {
    if (!pr->critique_entry[0]) {
        snprintf(err, errsz, "artifact blocked: call critique_write for %s before artifact", entry);
        return false;
    }
    if (!design_project_same_entry(pr, pr->critique_entry, entry)) {
        snprintf(err, errsz,
                 "artifact blocked: latest critique is for %s, not %s",
                 pr->critique_entry, entry);
        return false;
    }
    if (!pr->critique_passed) {
        snprintf(err, errsz,
                 "artifact blocked: latest critique did not pass (%.1f/10, %d must-fix)",
                 pr->critique_scores.composite, pr->critique_must_fixes);
        return false;
    }
    return true;
}

static bool design_project_file_path(design_project *pr, const char *rel,
                                     char *full, size_t fullsz) {
    char err[256];
    return project_resolve(pr, rel, full, fullsz, err, sizeof(err));
}

static bool design_append_file_bytes(const char *path, const char *data, size_t len) {
    char dir[PATH_MAX];
    snprintf(dir, sizeof(dir), "%s", path);
    char *slash = strrchr(dir, '/');
    if (slash) {
        *slash = '\0';
        if (!design_mkdir_p(dir)) return false;
    }
    FILE *fp = fopen(path, "ab");
    if (!fp) return false;
    bool ok = fwrite(data, 1, len, fp) == len && fflush(fp) == 0;
    fclose(fp);
    return ok;
}

static uint64_t design_history_last_seq(design_project *pr) {
    char full[PATH_MAX];
    if (!design_project_file_path(pr, ".ds4-design/history.jsonl", full, sizeof(full)))
        return 0;
    char *data = NULL;
    size_t len = 0;
    char err[256];
    if (read_file_bytes(full, &data, &len, err, sizeof(err)) != 0) return 0;
    uint64_t last = 0;
    const char *p = data;
    while ((p = strstr(p, "\"seq\"")) != NULL) {
        p += 5;
        while (*p && (*p == ' ' || *p == '\t' || *p == ':')) p++;
        if (isdigit((unsigned char)*p)) {
            unsigned long long v = strtoull(p, NULL, 10);
            if (v > last) last = v;
        }
    }
    free(data);
    return last;
}

static bool design_memory_path(design_project *pr, char *full, size_t fullsz) {
    return design_project_file_path(pr, "MEMORY.MD", full, fullsz);
}

static char *design_trimmed_dup(const char *s, size_t len) {
    while (len && isspace((unsigned char)*s)) {
        s++;
        len--;
    }
    while (len && isspace((unsigned char)s[len - 1])) len--;
    return len ? xstrndup(s, len) : xstrdup("");
}

static char *design_memory_extract_durable_summary(const char *body) {
    if (!body || !body[0]) return xstrdup("");

    const char heading[] = "## Durable Summary";
    const char *start = strstr(body, heading);
    if (!start) return design_trimmed_dup(body, strlen(body));
    start = strchr(start, '\n');
    if (!start) return xstrdup("");
    while (*start == '\n' || *start == '\r') start++;

    const char *end = strstr(start, "\n## ");
    if (!end) end = body + strlen(body);
    return design_trimmed_dup(start, (size_t)(end - start));
}

static void design_load_project_memory(design_project *pr) {
    if (pr->memory_summary) return;

    char full[PATH_MAX], err[256];
    char *body = NULL;
    size_t len = 0;
    if (design_memory_path(pr, full, sizeof(full)) &&
        read_file_bytes(full, &body, &len, err, sizeof(err)) == 0)
    {
        if (len > DESIGN_MEMORY_MAX_BYTES) body[DESIGN_MEMORY_MAX_BYTES] = '\0';
        pr->memory_summary = design_memory_extract_durable_summary(body);
        free(body);
        return;
    }

    if (design_project_file_path(pr, ".ds4-design/project.md", full, sizeof(full)) &&
        read_file_bytes(full, &body, &len, err, sizeof(err)) == 0)
    {
        if (len > DESIGN_MEMORY_MAX_BYTES) body[DESIGN_MEMORY_MAX_BYTES] = '\0';
        pr->memory_summary = design_memory_extract_durable_summary(body);
        free(body);
        return;
    }

    pr->memory_summary = xstrdup("");
}

static void design_set_compact_memory(design_project *pr, const char *summary) {
    free(pr->memory_summary);
    pr->memory_summary = design_trimmed_dup(summary ? summary : "",
                                           summary ? strlen(summary) : 0);
    design_utc_timestamp(pr->memory_updated_at);
}

static void design_write_project_memory(design_project *pr) {
    design_load_project_memory(pr);

    design_buf b = {0};
    char ts[32];
    design_utc_timestamp(ts);
    buf_puts(&b, "# MEMORY.MD\n\n");
    buf_puts(&b, "Shared durable memory for DS4 agents working in this workspace.\n\n");
    buf_puts(&b, "## Durable Summary\n\n");
    if (pr->memory_summary && pr->memory_summary[0]) {
        buf_puts(&b, pr->memory_summary);
        if (b.len && b.ptr[b.len - 1] != '\n') buf_puts(&b, "\n");
    } else {
        buf_puts(&b, "(No compact summary yet.)\n");
    }
    buf_puts(&b, "\n## Runtime State\n\n");
    buf_puts(&b, "- Updated: ");
    buf_puts(&b, ts);
    if (pr->memory_updated_at[0]) {
        buf_puts(&b, "\n- Last compact: ");
        buf_puts(&b, pr->memory_updated_at);
    }
    buf_puts(&b, "\n- Phase: ");
    buf_puts(&b, pr->phase[0] ? pr->phase : "idle");
    buf_puts(&b, "\n- Current run: ");
    buf_puts(&b, pr->run_id[0] ? pr->run_id : "(none)");
    buf_puts(&b, "\n- Current artifact: ");
    if (pr->current_artifact_entry[0]) {
        buf_puts(&b, pr->current_artifact_entry);
        if (pr->current_artifact_id[0]) {
            buf_puts(&b, " (");
            buf_puts(&b, pr->current_artifact_id);
            buf_puts(&b, ")");
        }
    } else {
        buf_puts(&b, "(none)");
    }
    buf_puts(&b, "\n- Open todos: ");
    buf_puts(&b, pr->todos_have_in_progress ? "yes" : "no");
    buf_puts(&b, "\n- Latest quality gate: ");
    if (pr->critique_entry[0]) {
        char q[160];
        snprintf(q, sizeof(q), "%s composite %.1f/10, %s",
                 pr->critique_entry, pr->critique_scores.composite,
                 pr->critique_passed ? "pass" : "blocked");
        buf_puts(&b, q);
        if (pr->critique_must_fixes > 0) {
            snprintf(q, sizeof(q), " (%d must-fix)", pr->critique_must_fixes);
            buf_puts(&b, q);
        }
    } else {
        buf_puts(&b, "(none)");
    }
    buf_puts(&b, "\n\n## Latest Todos\n\n```json\n");
    buf_puts(&b, pr->todos_json ? pr->todos_json : "[]");
    buf_puts(&b, "\n```\n");

    char full[PATH_MAX], err[256];
    if (design_memory_path(pr, full, sizeof(full)))
        (void)write_file_bytes(full, b.ptr ? b.ptr : "", b.len, err, sizeof(err));
    if (design_project_file_path(pr, ".ds4-design/project.md", full, sizeof(full)))
        (void)write_file_bytes(full, b.ptr ? b.ptr : "", b.len, err, sizeof(err));
    free(b.ptr);
}

static char *design_read_project_memory(design_project *pr) {
    char full[PATH_MAX], err[256];
    char *body = NULL;
    size_t len = 0;
    if (design_memory_path(pr, full, sizeof(full)) &&
        read_file_bytes(full, &body, &len, err, sizeof(err)) == 0)
    {
        if (len > DESIGN_MEMORY_MAX_BYTES) body[DESIGN_MEMORY_MAX_BYTES] = '\0';
        return body;
    }
    if (!design_project_file_path(pr, ".ds4-design/project.md", full, sizeof(full)))
        return NULL;
    if (read_file_bytes(full, &body, &len, err, sizeof(err)) != 0)
        return NULL;
    if (len > DESIGN_MEMORY_MAX_BYTES) body[DESIGN_MEMORY_MAX_BYTES] = '\0';
    return body;
}

static void design_write_state(design_project *pr) {
    design_buf b = {0};
    char num[32];
    buf_puts(&b, "{\n  \"schema\":\"ds4.design.state.v1\",\n  \"seq\":");
    snprintf(num, sizeof(num), "%llu", (unsigned long long)pr->event_seq);
    buf_puts(&b, num);
    buf_puts(&b, ",\n  ");
    design_json_kv_string(&b, "phase", pr->phase[0] ? pr->phase : "idle");
    buf_puts(&b, ",\n  ");
    design_json_kv_string(&b, "runId", pr->run_id);
    buf_puts(&b, ",\n  ");
    design_json_kv_string(&b, "currentArtifactId", pr->current_artifact_id);
    buf_puts(&b, ",\n  ");
    design_json_kv_string(&b, "currentArtifactEntry", pr->current_artifact_entry);
    buf_puts(&b, ",\n  \"todos\":");
    buf_puts(&b, pr->todos_json ? pr->todos_json : "[]");
    buf_puts(&b, ",\n  \"todosHaveInProgress\":");
    buf_puts(&b, pr->todos_have_in_progress ? "true" : "false");
    buf_puts(&b, ",\n  \"discoverySatisfied\":");
    buf_puts(&b, pr->discovery_satisfied ? "true" : "false");
    buf_puts(&b, ",\n  \"latestCritique\":");
    if (pr->critique_entry[0]) {
        buf_puts(&b, "{\"entry\":\"");
        json_escape_buf(&b, pr->critique_entry, strlen(pr->critique_entry));
        buf_puts(&b, "\",\"rubric\":\"" DESIGN_QUALITY_RUBRIC_ID
                    "\",\"composite\":");
        char q[64];
        snprintf(q, sizeof(q), "%.2f", pr->critique_scores.composite);
        buf_puts(&b, q);
        buf_puts(&b, ",\"threshold\":");
        snprintf(q, sizeof(q), "%.2f", DESIGN_QUALITY_THRESHOLD);
        buf_puts(&b, q);
        buf_puts(&b, ",\"pass\":");
        buf_puts(&b, pr->critique_passed ? "true" : "false");
        buf_puts(&b, ",\"mustFixes\":");
        snprintf(q, sizeof(q), "%d", pr->critique_must_fixes);
        buf_puts(&b, q);
        buf_puts(&b, ",\"updatedAt\":\"");
        json_escape_buf(&b, pr->critique_updated_at, strlen(pr->critique_updated_at));
        buf_puts(&b, "\"}");
    } else {
        buf_puts(&b, "null");
    }
    buf_puts(&b, "\n}\n");

    char full[PATH_MAX], err[256];
    if (design_project_file_path(pr, ".ds4-design/state.json", full, sizeof(full)))
        (void)write_file_bytes(full, b.ptr ? b.ptr : "", b.len, err, sizeof(err));
    free(b.ptr);
    design_write_project_memory(pr);
}

static void design_project_set_phase(design_project *pr, const char *phase) {
    snprintf(pr->phase, sizeof(pr->phase), "%s", phase && phase[0] ? phase : "idle");
}

static void design_event_log(design_project *pr, const char *type,
                             const char *payload_json) {
    if (!pr || !pr->dir[0] || !type || !type[0]) return;
    char ts[32];
    design_utc_timestamp(ts);
    pr->event_seq++;
    design_buf b = {0};
    char num[32];
    buf_puts(&b, "{\"seq\":");
    snprintf(num, sizeof(num), "%llu", (unsigned long long)pr->event_seq);
    buf_puts(&b, num);
    buf_puts(&b, ",\"run_id\":\"");
    json_escape_buf(&b, pr->run_id, strlen(pr->run_id));
    buf_puts(&b, "\",\"ts\":\"");
    buf_puts(&b, ts);
    buf_puts(&b, "\",\"type\":\"");
    json_escape_buf(&b, type, strlen(type));
    buf_puts(&b, "\",\"payload\":");
    buf_puts(&b, payload_json && payload_json[0] ? payload_json : "{}");
    buf_puts(&b, "}\n");

    char full[PATH_MAX];
    if (design_project_file_path(pr, ".ds4-design/history.jsonl", full, sizeof(full)))
        (void)design_append_file_bytes(full, b.ptr ? b.ptr : "", b.len);
    free(b.ptr);
    design_write_state(pr);
}

static void design_project_bootstrap(design_project *pr) {
    pr->event_seq = design_history_last_seq(pr);
    design_project_set_phase(pr, "idle");
    design_write_state(pr);
}

static bool design_ascii_ci_contains(const char *hay, const char *needle) {
    if (!hay || !needle || !needle[0]) return false;
    size_t nl = strlen(needle);
    for (const char *p = hay; *p; p++) {
        size_t k = 0;
        while (k < nl && p[k] &&
               tolower((unsigned char)p[k]) == tolower((unsigned char)needle[k]))
            k++;
        if (k == nl) return true;
    }
    return false;
}

static bool design_user_text_is_question_answer(const char *s) {
    return s && strstr(s, "§QUESTION_ANSWER") != NULL;
}

static bool design_user_text_skips_discovery(const char *s) {
    if (!s || !s[0]) return false;
    return design_ascii_ci_contains(s, "do not ask a discovery question") ||
           design_ascii_ci_contains(s, "don't ask a discovery question") ||
           design_ascii_ci_contains(s, "do not ask questions") ||
           design_ascii_ci_contains(s, "don't ask questions") ||
           design_ascii_ci_contains(s, "no questions") ||
           design_ascii_ci_contains(s, "build it directly") ||
           design_ascii_ci_contains(s, "BUILD MODE (planned)");
}

static void design_project_clear_run_progress(design_project *pr) {
    free(pr->todos_json);
    pr->todos_json = NULL;
    pr->todos_have_in_progress = false;
}

static void design_project_start_run(design_project *pr, const char *user_text) {
    char ts[32];
    design_utc_timestamp(ts);
    snprintf(pr->run_id, sizeof(pr->run_id), "%s-%04llu", ts,
             (unsigned long long)((pr->event_seq + 1) % 10000));
    for (char *p = pr->run_id; *p; p++) {
        if (*p == ':' || *p == 'T' || *p == 'Z') *p = '-';
    }
    bool answered_waiting_question = strcmp(pr->phase, "waiting_user") == 0;
    if (pr->current_artifact_entry[0] ||
        answered_waiting_question ||
        design_user_text_is_question_answer(user_text) ||
        design_user_text_skips_discovery(user_text))
        pr->discovery_satisfied = true;
    pr->stop_after_tools = false;
    design_project_clear_run_progress(pr);
    design_project_set_phase(pr, "building");
    design_buf p = {0};
    buf_puts(&p, "{\"promptBytes\":");
    char n[32];
    snprintf(n, sizeof(n), "%zu", user_text ? strlen(user_text) : 0);
    buf_puts(&p, n);
    buf_puts(&p, ",\"discoverySatisfied\":");
    buf_puts(&p, pr->discovery_satisfied ? "true" : "false");
    buf_puts(&p, "}");
    design_event_log(pr, "run_started", p.ptr);
    free(p.ptr);
}

static void design_project_finish_run(design_project *pr, const char *status) {
    design_buf p = {0};
    buf_puts(&p, "{\"status\":\"");
    json_escape_buf(&p, status ? status : "ok", status ? strlen(status) : 2);
    buf_puts(&p, "\",\"phase\":\"");
    json_escape_buf(&p, pr->phase, strlen(pr->phase));
    buf_puts(&p, "\"}");
    design_event_log(pr, "run_done", p.ptr);
    free(p.ptr);
    if (strcmp(pr->phase, "waiting_user") != 0)
        design_project_set_phase(pr, "idle");
    design_write_state(pr);
}

/* ---- anchored old/new matching, same contract as ds4-agent ---- */

static bool find_unique(const char *data, size_t len,
                        const char *needle, size_t needle_len,
                        const char **match, const char *label,
                        char *err, size_t err_len) {
    if (!needle || needle_len == 0) {
        snprintf(err, err_len, "%s anchor is empty", label);
        return false;
    }
    const char *first = memmem_simple(data, len, needle, needle_len);
    if (!first) {
        snprintf(err, err_len, "%s anchor not found", label);
        return false;
    }
    size_t after_first = (size_t)(first - data) + 1;
    const char *second = after_first <= len ?
        memmem_simple(data + after_first, len - after_first,
                      needle, needle_len) : NULL;
    if (second) {
        snprintf(err, err_len, "%s anchor is not unique", label);
        return false;
    }
    *match = first;
    return true;
}

static bool find_unique_after(const char *data, size_t len, const char *start,
                              const char *needle, size_t needle_len,
                              const char **match, const char *label,
                              char *err, size_t err_len) {
    if (!needle || needle_len == 0) {
        snprintf(err, err_len, "%s anchor is empty", label);
        return false;
    }
    size_t off = (size_t)(start - data);
    const char *first = memmem_simple(data + off, len - off, needle, needle_len);
    if (!first) {
        snprintf(err, err_len, "%s anchor not found after old head", label);
        return false;
    }
    size_t after_first = (size_t)(first - data) + 1;
    const char *second = after_first <= len ?
        memmem_simple(data + after_first, len - after_first,
                      needle, needle_len) : NULL;
    if (second) {
        snprintf(err, err_len, "%s anchor is not unique after old head", label);
        return false;
    }
    *match = first;
    return true;
}

static bool span_has_nonspace(const char *s, size_t len) {
    for (size_t i = 0; i < len; i++) {
        if (!isspace((unsigned char)s[i])) return true;
    }
    return false;
}

static bool edit_find_old_span(const char *data, size_t len, const char *old,
                               const char **match, size_t *match_len,
                               char *err, size_t err_len) {
    static const char upto_marker[] = "[upto]";
    size_t old_len = strlen(old);
    const char *upto = strstr(old, upto_marker);
    if (!upto) {
        if (!find_unique(data, len, old, old_len, match, "old text", err, err_len))
            return false;
        *match_len = old_len;
        return true;
    }
    if (strstr(upto + strlen(upto_marker), upto_marker)) {
        snprintf(err, err_len, "old text contains more than one [upto] marker");
        return false;
    }
    size_t head_len = (size_t)(upto - old);
    const char *tail = upto + strlen(upto_marker);
    size_t tail_len = old_len - head_len - strlen(upto_marker);
    if (!span_has_nonspace(tail, tail_len)) {
        snprintf(err, err_len,
                 "old text after [upto] must include a unique tail anchor");
        return false;
    }
    const char *head_pos = NULL;
    const char *tail_pos = NULL;
    if (!find_unique(data, len, old, head_len, &head_pos, "old head", err, err_len))
        return false;
    if (!find_unique_after(data, len, head_pos + head_len, tail, tail_len,
                           &tail_pos, "old tail", err, err_len))
        return false;
    *match = head_pos;
    *match_len = (size_t)(tail_pos - head_pos) + tail_len;
    return true;
}

/* Append numbered post-edit context lines so the model can verify the change
 * and pick fresh anchors without a read round-trip. */
static void append_numbered_lines(design_buf *b, const char *data, size_t len,
                                  int from_line, int to_line) {
    int line = 1;
    size_t i = 0;
    if (from_line < 1) from_line = 1;
    while (i < len && line <= to_line) {
        size_t start = i;
        while (i < len && data[i] != '\n') i++;
        if (line >= from_line) {
            char prefix[32];
            snprintf(prefix, sizeof(prefix), "%d ", line);
            buf_puts(b, prefix);
            buf_append(b, data + start, i - start);
            buf_puts(b, "\n");
        }
        if (i < len) i++;
        line++;
    }
}

static int count_lines_before(const char *data, size_t upto) {
    int n = 1;
    for (size_t i = 0; i < upto; i++) {
        if (data[i] == '\n') n++;
    }
    return n;
}

static int count_newlines(const char *s, size_t len) {
    int n = 0;
    for (size_t i = 0; i < len; i++) {
        if (s[i] == '\n') n++;
    }
    return n;
}

/* ============================================================================
 * The Design Tools
 * ============================================================================
 *
 * the agent gets generic file tools plus TodoWrite plus the
 * artifact handoff.  Same here, except every path goes through the sandbox
 * and `artifact` is a tool (the files are already on disk; re-emitting a
 * whole HTML document inline at tens of tokens/s would be pure waste).
 */

static char *tool_error(const char *msg) {
    design_buf b = {0};
    buf_puts(&b, "Tool error: ");
    buf_puts(&b, msg);
    buf_puts(&b, "\n");
    return buf_take(&b);
}

static char *tool_write(design_project *pr, const design_tool_call *call) {
    const char *path = tool_arg_value(call, "path");
    const char *content = tool_arg_value(call, "content");
    if (!content) return tool_error("write requires content");
    char full[PATH_MAX], err[256];
    if (!project_resolve(pr, path, full, sizeof(full), err, sizeof(err)))
        return tool_error(err);
    size_t len = strlen(content);
    if (!write_file_bytes(full, content, len, err, sizeof(err)))
        return tool_error(err);
    char sha[41];
    ds4_kvstore_sha1_bytes_hex(content, len, sha);
    design_buf ev = {0};
    char num[64];
    buf_puts(&ev, "{\"path\":\"");
    json_escape_buf(&ev, path, strlen(path));
    buf_puts(&ev, "\",\"op\":\"write\",\"bytes\":");
    snprintf(num, sizeof(num), "%zu", len);
    buf_puts(&ev, num);
    buf_puts(&ev, ",\"lines\":");
    snprintf(num, sizeof(num), "%d", count_lines_before(content, len));
    buf_puts(&ev, num);
    buf_puts(&ev, ",\"sha1\":\"");
    buf_puts(&ev, sha);
    buf_puts(&ev, "\"}");
    design_event_log(pr, "file_written", ev.ptr);
    free(ev.ptr);
    char msg[640];
    snprintf(msg, sizeof(msg), "Wrote %zu bytes to %s (%d lines). "
             "The file panel and preview refresh automatically.\n",
             len, path, count_lines_before(content, len));
    return xstrdup(msg);
}

static char *tool_edit(design_project *pr, const design_tool_call *call) {
    const char *path = tool_arg_value(call, "path");
    const char *old = tool_arg_value(call, "old");
    const char *new_text = tool_arg_value(call, "new");
    if (!old || !old[0]) return tool_error("edit requires non-empty old text");
    if (!new_text) return tool_error("edit requires new text");
    char full[PATH_MAX], err[256];
    if (!project_resolve(pr, path, full, sizeof(full), err, sizeof(err)))
        return tool_error(err);

    char *data = NULL;
    size_t len = 0;
    if (read_file_bytes(full, &data, &len, err, sizeof(err)) != 0)
        return tool_error(err);

    const char *match = NULL;
    size_t match_len = 0;
    if (!edit_find_old_span(data, len, old, &match, &match_len, err, sizeof(err))) {
        free(data);
        return tool_error(err);
    }

    size_t offset = (size_t)(match - data);
    size_t insert_len = strlen(new_text);
    size_t out_len = len - match_len + insert_len;
    char *out = xmalloc(out_len + 1);
    memcpy(out, data, offset);
    memcpy(out + offset, new_text, insert_len);
    memcpy(out + offset + insert_len, data + offset + match_len,
           len - offset - match_len);
    out[out_len] = '\0';

    int start_line = count_lines_before(data, offset);
    int old_end_line = start_line + count_newlines(data + offset, match_len);
    int new_end_line = start_line + count_newlines(new_text, insert_len);
    free(data);

    if (!write_file_bytes(full, out, out_len, err, sizeof(err))) {
        free(out);
        return tool_error(err);
    }
    char sha[41];
    ds4_kvstore_sha1_bytes_hex(out, out_len, sha);
    design_buf ev = {0};
    char num[64];
    buf_puts(&ev, "{\"path\":\"");
    json_escape_buf(&ev, path, strlen(path));
    buf_puts(&ev, "\",\"op\":\"edit\",\"bytes\":");
    snprintf(num, sizeof(num), "%zu", out_len);
    buf_puts(&ev, num);
    buf_puts(&ev, ",\"lines\":");
    snprintf(num, sizeof(num), "%d", count_lines_before(out, out_len));
    buf_puts(&ev, num);
    buf_puts(&ev, ",\"sha1\":\"");
    buf_puts(&ev, sha);
    buf_puts(&ev, "\",\"lineDelta\":");
    snprintf(num, sizeof(num), "%d", new_end_line - old_end_line);
    buf_puts(&ev, num);
    buf_puts(&ev, "}");
    design_event_log(pr, "file_written", ev.ptr);
    free(ev.ptr);

    design_buf b = {0};
    char hdr[512];
    snprintf(hdr, sizeof(hdr),
             "Edited %s: replaced lines %d-%d (line delta %+d). "
             "Post-edit context:\n",
             path, start_line, old_end_line, new_end_line - old_end_line);
    buf_puts(&b, hdr);
    append_numbered_lines(&b, out, out_len, start_line - 3, new_end_line + 3);
    free(out);
    return buf_take(&b);
}

static char *tool_read(design_project *pr, const design_tool_call *call) {
    const char *path = tool_arg_value(call, "path");
    const char *s_start = tool_arg_value(call, "start_line");
    const char *s_max = tool_arg_value(call, "max_lines");
    int start = s_start ? atoi(s_start) : 1;
    int max_lines = s_max ? atoi(s_max) : DESIGN_READ_DEFAULT_LINES;
    if (start < 1) start = 1;
    if (max_lines < 1) max_lines = DESIGN_READ_DEFAULT_LINES;

    char full[PATH_MAX], err[256];
    if (!project_resolve(pr, path, full, sizeof(full), err, sizeof(err)))
        return tool_error(err);
    char *data = NULL;
    size_t len = 0;
    if (read_file_bytes(full, &data, &len, err, sizeof(err)) != 0)
        return tool_error(err);

    int total = count_lines_before(data, len);
    int end = start + max_lines - 1;
    if (end > total) end = total;

    design_buf b = {0};
    char hdr[640];
    snprintf(hdr, sizeof(hdr), "%s: lines %d-%d of %d\n",
             path, start > total ? total : start, end, total);
    buf_puts(&b, hdr);
    append_numbered_lines(&b, data, len, start, end);
    if (end < total) {
        snprintf(hdr, sizeof(hdr),
                 "[Truncated. Call read with start_line=%d, or more to continue.]\n",
                 end + 1);
        buf_puts(&b, hdr);
        snprintf(pr->more_path, sizeof(pr->more_path), "%s", path);
        pr->more_next_line = end + 1;
        pr->more_valid = true;
    } else {
        pr->more_valid = false; /* whole file read: nothing left for more */
    }
    free(data);
    return buf_take(&b);
}

/* Compact recursive listing (depth-bounded, dotfiles skipped). */
static void list_dir_into(design_buf *b, const char *base, const char *rel, int depth) {
    if (depth > 3) return;
    char full[PATH_MAX];
    snprintf(full, sizeof(full), "%s%s%s", base, rel[0] ? "/" : "", rel);
    DIR *d = opendir(full);
    if (!d) return;
    struct dirent *de;
    while ((de = readdir(d)) != NULL) {
        if (de->d_name[0] == '.') continue;
        char child_rel[PATH_MAX];
        snprintf(child_rel, sizeof(child_rel), "%s%s%s",
                 rel, rel[0] ? "/" : "", de->d_name);
        char child_full[PATH_MAX];
        snprintf(child_full, sizeof(child_full), "%s/%s", base, child_rel);
        struct stat st;
        if (lstat(child_full, &st) != 0) continue;
        if (S_ISDIR(st.st_mode)) {
            list_dir_into(b, base, child_rel, depth + 1);
        } else if (S_ISREG(st.st_mode)) {
            char line[PATH_MAX + 64];
            snprintf(line, sizeof(line), "%s (%lld bytes)\n",
                     child_rel, (long long)st.st_size);
            buf_puts(b, line);
        }
    }
    closedir(d);
}

static char *tool_list(design_project *pr, const design_tool_call *call) {
    (void)call;
    design_buf b = {0};
    buf_puts(&b, "Project files:\n");
    size_t before = b.len;
    list_dir_into(&b, pr->dir, "", 0);
    if (b.len == before) buf_puts(&b, "(empty project)\n");
    return buf_take(&b);
}

static const char *todo_normalize_status(const char *s) {
    if (!s) return NULL;
    if (!strcmp(s, "pending")) return "pending";
    if (!strcmp(s, "in_progress")) return "in_progress";
    if (!strcmp(s, "completed")) return "completed";
    if (!strcmp(s, "stopped")) return "stopped";
    if (!strcmp(s, "canceled") || !strcmp(s, "cancelled") || !strcmp(s, "failed"))
        return "stopped";
    return NULL;
}

static bool todo_text_nonempty(const char *s) {
    if (!s) return false;
    for (const char *p = s; *p; p++) {
        if (!isspace((unsigned char)*p)) return true;
    }
    return false;
}

static bool todo_parse_and_normalize(const char *todos, char **normalized_out,
                                     int *items_out, bool *has_ip_out,
                                     char *err, size_t errsz) {
    const char *end = todos ? todos + strlen(todos) : "";
    const char *p = json_ws(todos ? todos : "", end);
    if (p >= end || *p != '[') {
        snprintf(err, errsz, "todos must be a JSON array of objects");
        return false;
    }
    p++;
    design_buf out = {0};
    buf_puts(&out, "[");
    int items = 0;
    bool has_ip = false;
    p = json_ws(p, end);
    if (p < end && *p == ']') {
        p++;
        p = json_ws(p, end);
        if (p != end) {
            snprintf(err, errsz, "trailing data after todos array");
            free(out.ptr);
            return false;
        }
        buf_puts(&out, "]");
        *normalized_out = buf_take(&out);
        *items_out = 0;
        *has_ip_out = false;
        return true;
    }

    for (;;) {
        p = json_ws(p, end);
        if (p >= end || *p != '{') {
            snprintf(err, errsz, "each todo must be a JSON object");
            free(out.ptr);
            return false;
        }
        p++;
        char *text = NULL;
        char *status_raw = NULL;
        p = json_ws(p, end);
        if (p < end && *p == '}') {
            snprintf(err, errsz, "todo item cannot be empty");
            free(out.ptr);
            return false;
        }
        for (;;) {
            p = json_ws(p, end);
            char *key = json_parse_string_alloc(&p, end, err, errsz);
            if (!key) { free(text); free(status_raw); free(out.ptr); return false; }
            p = json_ws(p, end);
            if (p >= end || *p != ':') {
                snprintf(err, errsz, "expected ':' after todo key");
                free(key); free(text); free(status_raw); free(out.ptr);
                return false;
            }
            p++;
            p = json_ws(p, end);
            if (!strcmp(key, "text") || !strcmp(key, "content") || !strcmp(key, "step")) {
                if (p >= end || *p != '"') {
                    snprintf(err, errsz, "todo text/content/step must be a string");
                    free(key); free(text); free(status_raw); free(out.ptr);
                    return false;
                }
                char *v = json_parse_string_alloc(&p, end, err, errsz);
                if (!v) { free(key); free(text); free(status_raw); free(out.ptr); return false; }
                if (!text) text = v;
                else free(v);
            } else if (!strcmp(key, "status")) {
                if (p >= end || *p != '"') {
                    snprintf(err, errsz, "todo status must be a string");
                    free(key); free(text); free(status_raw); free(out.ptr);
                    return false;
                }
                free(status_raw);
                status_raw = json_parse_string_alloc(&p, end, err, errsz);
                if (!status_raw) { free(key); free(text); free(out.ptr); return false; }
            } else {
                p = json_skip_value(p, end, 0, err, errsz);
                if (!p) { free(key); free(text); free(status_raw); free(out.ptr); return false; }
            }
            free(key);
            p = json_ws(p, end);
            if (p < end && *p == ',') { p++; continue; }
            if (p < end && *p == '}') { p++; break; }
            snprintf(err, errsz, "expected ',' or '}' in todo object");
            free(text); free(status_raw); free(out.ptr);
            return false;
        }
        const char *status = todo_normalize_status(status_raw);
        if (!todo_text_nonempty(text)) {
            snprintf(err, errsz, "todo item needs non-empty text/content/step");
            free(text); free(status_raw); free(out.ptr);
            return false;
        }
        if (!status) {
            snprintf(err, errsz,
                     "todo status must be pending, in_progress, completed, or stopped");
            free(text); free(status_raw); free(out.ptr);
            return false;
        }
        if (items) buf_puts(&out, ",");
        buf_puts(&out, "{\"text\":\"");
        json_escape_buf(&out, text, strlen(text));
        buf_puts(&out, "\",\"status\":\"");
        buf_puts(&out, status);
        buf_puts(&out, "\"}");
        if (!strcmp(status, "in_progress")) has_ip = true;
        items++;
        free(text);
        free(status_raw);

        p = json_ws(p, end);
        if (p < end && *p == ',') { p++; continue; }
        if (p < end && *p == ']') {
            p++;
            p = json_ws(p, end);
            if (p != end) {
                snprintf(err, errsz, "trailing data after todos array");
                free(out.ptr);
                return false;
            }
            break;
        }
        snprintf(err, errsz, "expected ',' or ']' after todo item");
        free(out.ptr);
        return false;
    }
    buf_puts(&out, "]");
    *normalized_out = buf_take(&out);
    *items_out = items;
    *has_ip_out = has_ip;
    return true;
}

static char *tool_todo_write(design_project *pr, const design_tool_call *call) {
    const char *todos = tool_arg_value(call, "todos");
    if (!todos) return tool_error("todo_write requires todos");
    char err[256];
    char *normalized = NULL;
    int items = 0;
    bool has_ip = false;
    if (!todo_parse_and_normalize(todos, &normalized, &items, &has_ip, err, sizeof(err)))
        return tool_error(err);
    free(pr->todos_json);
    pr->todos_json = normalized;
    pr->todos_have_in_progress = has_ip;
    design_project_set_phase(pr, has_ip ? "building" : pr->phase);
    emit_todos_event(pr->todos_json);
    design_buf ev = {0};
    char n[32];
    buf_puts(&ev, "{\"todos\":");
    buf_puts(&ev, pr->todos_json);
    buf_puts(&ev, ",\"count\":");
    snprintf(n, sizeof(n), "%d", items);
    buf_puts(&ev, n);
    buf_puts(&ev, ",\"hasInProgress\":");
    buf_puts(&ev, has_ip ? "true" : "false");
    buf_puts(&ev, "}");
    design_event_log(pr, "todos_updated", ev.ptr);
    free(ev.ptr);
    char msg[128];
    snprintf(msg, sizeof(msg), "Todo list updated (%d item%s). It renders live in the chat.\n",
             items, items == 1 ? "" : "s");
    return xstrdup(msg);
}

typedef struct {
    char *severity;
    char *message;
} design_check_finding;

typedef struct {
    design_check_finding *v;
    int len;
    int cap;
    int errors;
    int warnings;
    int p0;
    int p1;
    int p2;
} design_check_report;

static void design_check_report_free(design_check_report *r) {
    for (int i = 0; i < r->len; i++) {
        free(r->v[i].severity);
        free(r->v[i].message);
    }
    free(r->v);
    memset(r, 0, sizeof(*r));
}

static void design_check_add(design_check_report *r, const char *severity,
                             const char *fmt, ...) {
    if (r->len == r->cap) {
        r->cap = r->cap ? r->cap * 2 : 8;
        r->v = xrealloc(r->v, (size_t)r->cap * sizeof(r->v[0]));
    }
    char stack[512];
    va_list ap;
    va_start(ap, fmt);
    int n = vsnprintf(stack, sizeof(stack), fmt, ap);
    va_end(ap);
    char *msg;
    if (n < 0) {
        msg = xstrdup("check failed");
    } else if ((size_t)n < sizeof(stack)) {
        msg = xstrdup(stack);
    } else {
        msg = xmalloc((size_t)n + 1);
        va_start(ap, fmt);
        vsnprintf(msg, (size_t)n + 1, fmt, ap);
        va_end(ap);
    }
    r->v[r->len++] = (design_check_finding){
        .severity = xstrdup(severity),
        .message = msg,
    };
    if (!strcmp(severity, "P0") || !strcmp(severity, "error")) {
        r->errors++;
        r->p0++;
    } else {
        r->warnings++;
        if (!strcmp(severity, "P2")) r->p2++;
        else r->p1++;
    }
}

static const char *design_check_status(const design_check_report *r) {
    if (r->errors) return "fail";
    if (r->warnings) return "warning";
    return "pass";
}

static void emit_artifact_check_event(const char *entry,
                                      const design_check_report *report) {
    if (!g_jsonl) return;
    design_buf b = {0};
    buf_puts(&b, "\x1e{\"type\":\"artifact_check\",\"entry\":\"");
    json_escape_buf(&b, entry ? entry : "", entry ? strlen(entry) : 0);
    buf_puts(&b, "\",\"status\":\"");
    buf_puts(&b, design_check_status(report));
    buf_puts(&b, "\",\"p0\":");
    char n[32];
    snprintf(n, sizeof(n), "%d", report ? report->p0 : 0);
    buf_puts(&b, n);
    buf_puts(&b, ",\"p1\":");
    snprintf(n, sizeof(n), "%d", report ? report->p1 : 0);
    buf_puts(&b, n);
    buf_puts(&b, ",\"p2\":");
    snprintf(n, sizeof(n), "%d", report ? report->p2 : 0);
    buf_puts(&b, n);
    buf_puts(&b, ",\"findings\":[");
    for (int i = 0; i < report->len; i++) {
        if (i) buf_puts(&b, ",");
        buf_puts(&b, "{\"severity\":\"");
        json_escape_buf(&b, report->v[i].severity, strlen(report->v[i].severity));
        buf_puts(&b, "\",\"message\":\"");
        json_escape_buf(&b, report->v[i].message, strlen(report->v[i].message));
        buf_puts(&b, "\"}");
    }
    buf_puts(&b, "]}\n");
    emit_event_line(&b);
}

static void design_check_report_text(design_buf *b,
                                     const design_check_report *report) {
    char hdr[96];
    snprintf(hdr, sizeof(hdr), "Artifact check: %s (%d P0, %d P1, %d P2)\n",
             design_check_status(report),
             report->p0, report->p1, report->p2);
    buf_puts(b, hdr);
    for (int i = 0; i < report->len; i++) {
        buf_puts(b, "- ");
        buf_puts(b, report->v[i].severity);
        buf_puts(b, ": ");
        buf_puts(b, report->v[i].message);
        buf_puts(b, "\n");
    }
}

static bool design_artifact_check(design_project *pr, const char *entry,
                                  design_check_report *report);

static char *tool_verify_artifact(design_project *pr, const design_tool_call *call) {
    const char *entry = tool_arg_value(call, "entry");
    if (!entry || !entry[0]) return tool_error("verify_artifact requires entry");
    design_check_report report = {0};
    (void)design_artifact_check(pr, entry, &report);
    emit_artifact_check_event(entry, &report);
    design_buf ev = {0};
    char n[32];
    buf_puts(&ev, "{\"entry\":\"");
    json_escape_buf(&ev, entry, strlen(entry));
    buf_puts(&ev, "\",\"status\":\"");
    buf_puts(&ev, design_check_status(&report));
    buf_puts(&ev, "\",\"errors\":");
    snprintf(n, sizeof(n), "%d", report.errors);
    buf_puts(&ev, n);
    buf_puts(&ev, ",\"warnings\":");
    snprintf(n, sizeof(n), "%d", report.warnings);
    buf_puts(&ev, n);
    buf_puts(&ev, ",\"p0\":");
    snprintf(n, sizeof(n), "%d", report.p0);
    buf_puts(&ev, n);
    buf_puts(&ev, ",\"p1\":");
    snprintf(n, sizeof(n), "%d", report.p1);
    buf_puts(&ev, n);
    buf_puts(&ev, ",\"p2\":");
    snprintf(n, sizeof(n), "%d", report.p2);
    buf_puts(&ev, n);
    buf_puts(&ev, "}");
    design_event_log(pr, "artifact_checked", ev.ptr);
    free(ev.ptr);
    design_buf b = {0};
    design_check_report_text(&b, &report);
    design_check_report_free(&report);
    return buf_take(&b);
}

static char *tool_question(design_project *pr, const design_tool_call *call) {
    const char *id = tool_arg_value(call, "id");
    const char *title = tool_arg_value(call, "title");
    const char *questions = tool_arg_value(call, "questions");
    if (!id || !id[0]) return tool_error("question requires id");
    if (!title || !title[0]) return tool_error("question requires title");
    if (!questions || !questions[0]) return tool_error("question requires questions");
    char err[256];
    if (!json_validate_complete(questions, '[', err, sizeof(err)))
        return tool_error(err);
    design_project_set_phase(pr, "waiting_user");
    emit_question_event(id, title, questions);
    design_buf ev = {0};
    buf_puts(&ev, "{\"id\":\"");
    json_escape_buf(&ev, id, strlen(id));
    buf_puts(&ev, "\",\"title\":\"");
    json_escape_buf(&ev, title, strlen(title));
    buf_puts(&ev, "\",\"questions\":");
    design_put_json_flat(&ev, questions);
    buf_puts(&ev, "}");
    design_event_log(pr, "question_asked", ev.ptr);
    free(ev.ptr);
    pr->stop_after_tools = true;
    return xstrdup("Question event emitted. Stop this turn and wait for the user's answer.\n");
}

static void design_json_string_array_put(design_buf *b, const design_string_list *l) {
    buf_puts(b, "[");
    for (int i = 0; i < l->len; i++) {
        if (i) buf_puts(b, ",");
        buf_puts(b, "\"");
        json_escape_buf(b, l->v[i], strlen(l->v[i]));
        buf_puts(b, "\"");
    }
    buf_puts(b, "]");
}

static const char *design_ext(const char *path) {
    const char *slash = strrchr(path, '/');
    const char *dot = strrchr(path, '.');
    return (dot && (!slash || dot > slash)) ? dot : "";
}

static bool json_number_field(const char *json, const char *key,
                              double *out, char *err, size_t errsz) {
    char pat[96];
    snprintf(pat, sizeof(pat), "\"%s\"", key);
    const char *end = json + strlen(json);
    const char *p = json;
    while ((p = strstr(p, pat)) != NULL) {
        const char *q = p + strlen(pat);
        q = json_ws(q, end);
        if (q >= end || *q != ':') { p = q; continue; }
        q++;
        q = json_ws(q, end);
        char *ep = NULL;
        errno = 0;
        double v = strtod(q, &ep);
        if (ep == q || errno == ERANGE) {
            snprintf(err, errsz, "score %s must be a JSON number", key);
            return false;
        }
        const char *r = json_ws(ep, end);
        if (r < end && *r != ',' && *r != '}') {
            snprintf(err, errsz, "score %s has trailing non-number text", key);
            return false;
        }
        if (v < 0.0 || v > 10.0) {
            snprintf(err, errsz, "score %s must be between 0 and 10", key);
            return false;
        }
        *out = v;
        return true;
    }
    snprintf(err, errsz, "scores_json missing required role: %s", key);
    return false;
}

static bool design_critique_parse_scores(const char *scores_json,
                                         design_critique_scores *scores,
                                         char *err, size_t errsz) {
    if (!scores_json || !scores_json[0]) {
        snprintf(err, errsz, "critique_write requires scores_json");
        return false;
    }
    if (!json_validate_complete(scores_json, '{', err, errsz))
        return false;
    memset(scores, 0, sizeof(*scores));
    if (!json_number_field(scores_json, "critic", &scores->critic, err, errsz) ||
        !json_number_field(scores_json, "brand", &scores->brand, err, errsz) ||
        !json_number_field(scores_json, "a11y", &scores->a11y, err, errsz) ||
        !json_number_field(scores_json, "copy", &scores->copy, err, errsz))
        return false;
    scores->composite = scores->critic * 0.4 +
                        scores->brand * 0.2 +
                        scores->a11y * 0.2 +
                        scores->copy * 0.2;
    return true;
}

static char *tool_critique_write(design_project *pr, const design_tool_call *call) {
    const char *entry = tool_arg_value(call, "entry");
    const char *scores_json = tool_arg_value(call, "scores_json");
    const char *must_fixes_json = tool_arg_value(call, "must_fixes_json");
    const char *decision = tool_arg_value(call, "decision");
    const char *notes = tool_arg_value(call, "notes");
    if (!entry || !entry[0]) return tool_error("critique_write requires entry");
    if (!decision || !decision[0]) return tool_error("critique_write requires decision");
    if (strcasecmp(decision, "ship") && strcasecmp(decision, "continue"))
        return tool_error("critique_write decision must be ship or continue");

    const char *ext = design_ext(entry);
    if (strcasecmp(ext, ".html") && strcasecmp(ext, ".htm"))
        return tool_error("critique_write is only required for HTML artifact entries");

    char full[PATH_MAX], err[256];
    if (!project_resolve(pr, entry, full, sizeof(full), err, sizeof(err)))
        return tool_error(err);
    if (access(full, R_OK) != 0)
        return tool_error("critique_write entry file does not exist; write it first");

    design_critique_scores scores;
    if (!design_critique_parse_scores(scores_json, &scores, err, sizeof(err)))
        return tool_error(err);

    design_string_list must_fixes = {0};
    if (!must_fixes_json || !must_fixes_json[0])
        must_fixes_json = "[]";
    if (!json_parse_string_array(must_fixes_json, &must_fixes, err, sizeof(err)))
        return tool_error(err);

    bool passed = !strcasecmp(decision, "ship") &&
                  scores.composite >= DESIGN_QUALITY_THRESHOLD &&
                  must_fixes.len == 0;
    snprintf(pr->critique_entry, sizeof(pr->critique_entry), "%s", entry);
    pr->critique_scores = scores;
    pr->critique_must_fixes = must_fixes.len;
    pr->critique_passed = passed;
    design_utc_timestamp(pr->critique_updated_at);

    emit_critique_event(entry, &scores, must_fixes.len, passed, decision,
                        scores_json, must_fixes_json, notes ? notes : "");

    design_buf ev = {0};
    char n[64];
    buf_puts(&ev, "{\"entry\":\"");
    json_escape_buf(&ev, entry, strlen(entry));
    buf_puts(&ev, "\",\"rubric\":\"" DESIGN_QUALITY_RUBRIC_ID
                  "\",\"composite\":");
    snprintf(n, sizeof(n), "%.2f", scores.composite);
    buf_puts(&ev, n);
    buf_puts(&ev, ",\"threshold\":");
    snprintf(n, sizeof(n), "%.2f", DESIGN_QUALITY_THRESHOLD);
    buf_puts(&ev, n);
    buf_puts(&ev, ",\"pass\":");
    buf_puts(&ev, passed ? "true" : "false");
    buf_puts(&ev, ",\"mustFixes\":");
    snprintf(n, sizeof(n), "%d", must_fixes.len);
    buf_puts(&ev, n);
    buf_puts(&ev, ",\"scores\":");
    design_put_json_flat(&ev, scores_json);
    buf_puts(&ev, ",\"mustFixItems\":");
    design_put_json_flat(&ev, must_fixes_json);
    buf_puts(&ev, "}");
    design_event_log(pr, "critique_recorded", ev.ptr);
    free(ev.ptr);

    design_buf out = {0};
    snprintf(n, sizeof(n), "%.1f", scores.composite);
    if (passed) {
        buf_puts(&out, "Critique passed: composite ");
        buf_puts(&out, n);
        buf_puts(&out, "/10. artifact() is now allowed for this entry if verification still passes.\n");
    } else {
        buf_puts(&out, "Critique blocked: composite ");
        buf_puts(&out, n);
        buf_puts(&out, "/10");
        if (must_fixes.len) {
            char mf[64];
            snprintf(mf, sizeof(mf), ", %d must-fix item%s",
                     must_fixes.len, must_fixes.len == 1 ? "" : "s");
            buf_puts(&out, mf);
        }
        buf_puts(&out, ". Fix the file and call critique_write again before artifact().\n");
    }
    design_string_list_free(&must_fixes);
    return buf_take(&out);
}

static void artifact_defaults_for_entry(const char *entry, const char **kind,
                                        const char **renderer,
                                        design_string_list *exports) {
    const char *ext = design_ext(entry);
    if (!strcasecmp(ext, ".md")) {
        *kind = "markdown-document";
        *renderer = "markdown";
        design_string_list_push(exports, xstrdup("md"));
        design_string_list_push(exports, xstrdup("pdf"));
        design_string_list_push(exports, xstrdup("zip"));
    } else if (!strcasecmp(ext, ".svg")) {
        *kind = "svg";
        *renderer = "svg";
        design_string_list_push(exports, xstrdup("svg"));
        design_string_list_push(exports, xstrdup("zip"));
    } else {
        *kind = "html";
        *renderer = "html";
        design_string_list_push(exports, xstrdup("html"));
        design_string_list_push(exports, xstrdup("pdf"));
        design_string_list_push(exports, xstrdup("zip"));
    }
}

static bool artifact_kind_ok(const char *s) {
    static const char *ok[] = {
        "html", "deck", "react-component", "markdown-document", "svg",
        "diagram", "code-snippet", "mini-app", "design-system",
        "poster", "social-card", "image-brief", "video-storyboard",
        "audio-script", "prompt-pack", "pdf-brief", "docx-brief",
        "figma-brief", "hyperframes", NULL
    };
    for (int i = 0; ok[i]; i++) if (!strcmp(s, ok[i])) return true;
    return false;
}

static bool artifact_renderer_ok(const char *s) {
    static const char *ok[] = {
        "html", "deck-html", "react-component", "markdown", "svg",
        "diagram", "code", "mini-app", "design-system",
        "poster-html", "social-html", "brief", "storyboard",
        "prompt-pack", "hyperframes", NULL
    };
    for (int i = 0; ok[i]; i++) if (!strcmp(s, ok[i])) return true;
    return false;
}

static bool artifact_export_ok(const char *s) {
    static const char *ok[] = {
        "html", "pdf", "zip", "pptx", "jsx", "md", "svg", "txt",
        "json", "png", "mp4", "wav", "docx", "figma", "prompt", NULL
    };
    for (int i = 0; ok[i]; i++) if (!strcmp(s, ok[i])) return true;
    return false;
}

static char *artifact_slug_for_entry(const char *entry) {
    design_buf b = {0};
    for (const char *p = entry; *p; p++) {
        unsigned char c = (unsigned char)*p;
        char out = (isalnum(c) || c == '-' || c == '_' || c == '.') ? (char)c : '_';
        buf_append(&b, &out, 1);
    }
    if (!b.len) buf_puts(&b, "artifact");
    buf_puts(&b, ".json");
    return buf_take(&b);
}

static void artifact_timestamp(char out[32]) {
    time_t t = time(NULL);
    struct tm tmv;
    gmtime_r(&t, &tmv);
    strftime(out, 32, "%Y-%m-%dT%H:%M:%SZ", &tmv);
}

static char *artifact_build_manifest_json(const char *artifact_id,
                                          const char *parent_artifact_id,
                                          const char *content_hash,
                                          const char *entry, const char *title,
                                          const char *kind,
                                          const char *renderer,
                                          const design_string_list *exports,
                                          const design_string_list *supporting,
                                          const design_check_report *report,
                                          const design_project *pr,
                                          const char *created_at,
                                          const char *metadata_json) {
    design_buf b = {0};
    buf_puts(&b, "{\n");
    buf_puts(&b, "  \"schema\":\"ds4.design.artifact.v2\",\n");
    buf_puts(&b, "  \"version\":2,\n");
    buf_puts(&b, "  \"artifactId\":\"");
    json_escape_buf(&b, artifact_id, strlen(artifact_id));
    buf_puts(&b, "\",\n  \"parentArtifactId\":");
    if (parent_artifact_id && parent_artifact_id[0]) {
        buf_puts(&b, "\"");
        json_escape_buf(&b, parent_artifact_id, strlen(parent_artifact_id));
        buf_puts(&b, "\"");
    } else {
        buf_puts(&b, "null");
    }
    buf_puts(&b, ",\n  \"entry\":\"");
    json_escape_buf(&b, entry, strlen(entry));
    buf_puts(&b, "\",\n  \"title\":\"");
    json_escape_buf(&b, title ? title : "", title ? strlen(title) : 0);
    buf_puts(&b, "\",\n  \"kind\":\"");
    json_escape_buf(&b, kind, strlen(kind));
    buf_puts(&b, "\",\n  \"renderer\":\"");
    json_escape_buf(&b, renderer, strlen(renderer));
    buf_puts(&b, "\",\n  \"exports\":");
    design_json_string_array_put(&b, exports);
    buf_puts(&b, ",\n  \"supportingFiles\":");
    design_json_string_array_put(&b, supporting);
    buf_puts(&b, ",\n  \"contentHash\":\"");
    json_escape_buf(&b, content_hash, strlen(content_hash));
    buf_puts(&b, "\",\n  \"checkReport\":{\"status\":\"");
    buf_puts(&b, report ? design_check_status(report) : "pass");
    buf_puts(&b, "\",\"errors\":");
    char num[32];
    snprintf(num, sizeof(num), "%d", report ? report->errors : 0);
    buf_puts(&b, num);
    buf_puts(&b, ",\"warnings\":");
    snprintf(num, sizeof(num), "%d", report ? report->warnings : 0);
    buf_puts(&b, num);
    buf_puts(&b, ",\"p0\":");
    snprintf(num, sizeof(num), "%d", report ? report->p0 : 0);
    buf_puts(&b, num);
    buf_puts(&b, ",\"p1\":");
    snprintf(num, sizeof(num), "%d", report ? report->p1 : 0);
    buf_puts(&b, num);
    buf_puts(&b, ",\"p2\":");
    snprintf(num, sizeof(num), "%d", report ? report->p2 : 0);
    buf_puts(&b, num);
    buf_puts(&b, "},\n  \"quality\":{\"rubric\":\"" DESIGN_QUALITY_RUBRIC_ID
                "\",\"composite\":");
    if (pr && pr->critique_entry[0]) {
        snprintf(num, sizeof(num), "%.2f", pr->critique_scores.composite);
        buf_puts(&b, num);
    } else {
        buf_puts(&b, "null");
    }
    buf_puts(&b, ",\"threshold\":");
    snprintf(num, sizeof(num), "%.2f", DESIGN_QUALITY_THRESHOLD);
    buf_puts(&b, num);
    buf_puts(&b, ",\"pass\":");
    buf_puts(&b, pr && pr->critique_passed ? "true" : "false");
    buf_puts(&b, ",\"p0\":");
    snprintf(num, sizeof(num), "%d", report ? report->p0 : 0);
    buf_puts(&b, num);
    buf_puts(&b, ",\"p1\":");
    snprintf(num, sizeof(num), "%d", report ? report->p1 : 0);
    buf_puts(&b, num);
    buf_puts(&b, ",\"p2\":");
    snprintf(num, sizeof(num), "%d", report ? report->p2 : 0);
    buf_puts(&b, num);
    buf_puts(&b, ",\"critiqueEntry\":");
    if (pr && pr->critique_entry[0]) {
        buf_puts(&b, "\"");
        json_escape_buf(&b, pr->critique_entry, strlen(pr->critique_entry));
        buf_puts(&b, "\"");
    } else {
        buf_puts(&b, "null");
    }
    buf_puts(&b, ",\"critiqueAt\":");
    if (pr && pr->critique_updated_at[0]) {
        buf_puts(&b, "\"");
        json_escape_buf(&b, pr->critique_updated_at, strlen(pr->critique_updated_at));
        buf_puts(&b, "\"");
    } else {
        buf_puts(&b, "null");
    }
    buf_puts(&b, "},\n  \"createdAt\":\"");
    buf_puts(&b, created_at);
    buf_puts(&b, "\",\n  \"updatedAt\":\"");
    buf_puts(&b, created_at);
    buf_puts(&b, "\",\n  \"metadata\":");
    buf_puts(&b, metadata_json && metadata_json[0] ? metadata_json : "{}");
    buf_puts(&b, "\n}\n");
    return buf_take(&b);
}

static bool artifact_write_manifest(design_project *pr, const char *entry,
                                    const char *manifest, char *err, size_t errsz) {
    char *slug = artifact_slug_for_entry(entry);
    char rel[PATH_MAX];
    int n = snprintf(rel, sizeof(rel), ".ds4-design/artifacts/%s", slug);
    free(slug);
    if (n < 0 || (size_t)n >= sizeof(rel)) {
        snprintf(err, errsz, "artifact manifest path too long");
        return false;
    }
    char full[PATH_MAX];
    if (!project_resolve(pr, rel, full, sizeof(full), err, errsz))
        return false;
    return write_file_bytes(full, manifest, strlen(manifest), err, errsz);
}

static char *tool_artifact(design_project *pr, const design_tool_call *call) {
    const char *entry = tool_arg_value(call, "entry");
    const char *title = tool_arg_value(call, "title");
    const char *kind_arg = tool_arg_value(call, "kind");
    const char *renderer_arg = tool_arg_value(call, "renderer");
    const char *exports_arg = tool_arg_value(call, "exports");
    const char *supporting_arg = tool_arg_value(call, "supporting_files");
    const char *metadata_arg = tool_arg_value(call, "metadata");
    if (!entry || !entry[0]) return tool_error("artifact requires entry");
    if (!title || !title[0]) return tool_error("artifact requires title");
    char full[PATH_MAX], err[256];
    if (!project_resolve(pr, entry, full, sizeof(full), err, sizeof(err)))
        return tool_error(err);
    if (access(full, R_OK) != 0)
        return tool_error("artifact entry file does not exist; write it first");

    if (pr->todos_have_in_progress)
        return tool_error("todo_write still has an in_progress step; update the plan before artifact");

    design_check_report report = {0};
    (void)design_artifact_check(pr, entry, &report);
    emit_artifact_check_event(entry, &report);
    {
        design_buf cev = {0};
        char n[32];
        buf_puts(&cev, "{\"entry\":\"");
        json_escape_buf(&cev, entry, strlen(entry));
        buf_puts(&cev, "\",\"status\":\"");
        buf_puts(&cev, design_check_status(&report));
        buf_puts(&cev, "\",\"errors\":");
        snprintf(n, sizeof(n), "%d", report.errors);
        buf_puts(&cev, n);
        buf_puts(&cev, ",\"warnings\":");
        snprintf(n, sizeof(n), "%d", report.warnings);
        buf_puts(&cev, n);
        buf_puts(&cev, ",\"p0\":");
        snprintf(n, sizeof(n), "%d", report.p0);
        buf_puts(&cev, n);
        buf_puts(&cev, ",\"p1\":");
        snprintf(n, sizeof(n), "%d", report.p1);
        buf_puts(&cev, n);
        buf_puts(&cev, ",\"p2\":");
        snprintf(n, sizeof(n), "%d", report.p2);
        buf_puts(&cev, n);
        buf_puts(&cev, "}");
        design_event_log(pr, "artifact_checked", cev.ptr);
        free(cev.ptr);
    }
    if (report.errors) {
        design_buf b = {0};
        buf_puts(&b, "artifact blocked by verification failures:\n");
        design_check_report_text(&b, &report);
        design_check_report_free(&report);
        char *msg = buf_take(&b);
        char *res = tool_error(msg);
        free(msg);
        return res;
    }

    const char *entry_ext = design_ext(entry);
    bool entry_is_html = !strcasecmp(entry_ext, ".html") || !strcasecmp(entry_ext, ".htm");
    if (entry_is_html) {
        char qerr[256];
        if (!design_project_critique_passes(pr, entry, qerr, sizeof(qerr))) {
            design_check_report_free(&report);
            return tool_error(qerr);
        }
    }

    const char *kind = NULL, *renderer = NULL;
    design_string_list exports = {0}, supporting = {0};
    artifact_defaults_for_entry(entry, &kind, &renderer, &exports);
    if (kind_arg && kind_arg[0]) kind = kind_arg;
    if (renderer_arg && renderer_arg[0]) renderer = renderer_arg;
    if (!artifact_kind_ok(kind)) {
        design_check_report_free(&report);
        design_string_list_free(&exports);
        return tool_error("artifact kind is not supported");
    }
    if (!artifact_renderer_ok(renderer)) {
        design_check_report_free(&report);
        design_string_list_free(&exports);
        return tool_error("artifact renderer is not supported");
    }
    if (exports_arg && exports_arg[0]) {
        design_string_list_free(&exports);
        if (!json_parse_string_array(exports_arg, &exports, err, sizeof(err))) {
            design_check_report_free(&report);
            return tool_error(err);
        }
    }
    for (int i = 0; i < exports.len; i++) {
        if (!artifact_export_ok(exports.v[i])) {
            design_check_report_free(&report);
            design_string_list_free(&exports);
            design_string_list_free(&supporting);
            return tool_error("artifact export is not supported");
        }
    }
    if (supporting_arg && supporting_arg[0]) {
        if (!json_parse_string_array(supporting_arg, &supporting, err, sizeof(err))) {
            design_check_report_free(&report);
            design_string_list_free(&exports);
            return tool_error(err);
        }
    }
    for (int i = 0; i < supporting.len; i++) {
        char sfull[PATH_MAX];
        if (!project_resolve(pr, supporting.v[i], sfull, sizeof(sfull), err, sizeof(err)) ||
            access(sfull, R_OK) != 0)
        {
            design_buf e = {0};
            buf_puts(&e, "supporting file does not exist or escapes workspace: ");
            buf_puts(&e, supporting.v[i]);
            char *msg = buf_take(&e);
            design_check_report_free(&report);
            design_string_list_free(&exports);
            design_string_list_free(&supporting);
            char *res = tool_error(msg);
            free(msg);
            return res;
        }
    }
    if (metadata_arg && metadata_arg[0] &&
        !json_validate_complete(metadata_arg, '{', err, sizeof(err)))
    {
        design_check_report_free(&report);
        design_string_list_free(&exports);
        design_string_list_free(&supporting);
        return tool_error(err);
    }
    char *entry_body = NULL;
    size_t entry_len = 0;
    if (read_file_bytes(full, &entry_body, &entry_len, err, sizeof(err)) != 0) {
        design_check_report_free(&report);
        design_string_list_free(&exports);
        design_string_list_free(&supporting);
        return tool_error(err);
    }
    char content_hash[41];
    ds4_kvstore_sha1_bytes_hex(entry_body, entry_len, content_hash);
    free(entry_body);
    char created_at[32];
    artifact_timestamp(created_at);
    design_buf idsrc = {0};
    buf_puts(&idsrc, entry);
    buf_puts(&idsrc, "|");
    buf_puts(&idsrc, content_hash);
    buf_puts(&idsrc, "|");
    buf_puts(&idsrc, created_at);
    char artifact_sha[41];
    ds4_kvstore_sha1_bytes_hex(idsrc.ptr ? idsrc.ptr : "", idsrc.len, artifact_sha);
    free(idsrc.ptr);
    char artifact_id[17];
    memcpy(artifact_id, artifact_sha, 16);
    artifact_id[16] = '\0';

    char *manifest = artifact_build_manifest_json(artifact_id,
                                                  pr->current_artifact_id,
                                                  content_hash,
                                                  entry, title, kind, renderer,
                                                  &exports, &supporting, &report,
                                                  pr,
                                                  created_at,
                                                  metadata_arg && metadata_arg[0] ? metadata_arg : "{}");
    if (!artifact_write_manifest(pr, entry, manifest, err, sizeof(err))) {
        design_check_report_free(&report);
        design_string_list_free(&exports);
        design_string_list_free(&supporting);
        free(manifest);
        return tool_error(err);
    }

    snprintf(pr->current_artifact_id, sizeof(pr->current_artifact_id), "%s", artifact_id);
    snprintf(pr->current_artifact_entry, sizeof(pr->current_artifact_entry), "%s", entry);
    design_project_set_phase(pr, "artifact_ready");
    emit_artifact_event(entry, title, manifest);
    design_buf aev = {0};
    buf_puts(&aev, "{\"artifactId\":\"");
    json_escape_buf(&aev, artifact_id, strlen(artifact_id));
    buf_puts(&aev, "\",\"entry\":\"");
    json_escape_buf(&aev, entry, strlen(entry));
    buf_puts(&aev, "\",\"title\":\"");
    json_escape_buf(&aev, title, strlen(title));
    buf_puts(&aev, "\",\"contentHash\":\"");
    buf_puts(&aev, content_hash);
    buf_puts(&aev, "\"}");
    design_event_log(pr, "artifact_registered", aev.ptr);
    free(aev.ptr);
    pr->stop_after_tools = true;
    char msg[640];
    snprintf(msg, sizeof(msg),
             "Artifact registered: %s. Manifest v2 written and the workspace preview switched to it.\n",
             entry);
    design_buf out = {0};
    buf_puts(&out, msg);
    if (report.warnings) design_check_report_text(&out, &report);
    design_check_report_free(&report);
    design_string_list_free(&exports);
    design_string_list_free(&supporting);
    free(manifest);
    return buf_take(&out);
}

/* Register a SET of parallel design directions (compare grid in the UI). Each
 * "entry" must already exist under the project sandbox (validate, like
 * artifact, but for every direction). The directions arg is a JSON array of
 * {"entry","tag","name","desc"}. */
static char *tool_propose(design_project *pr, const design_tool_call *call) {
    const char *dirs = tool_arg_value(call, "directions");
    if (!dirs) return tool_error("propose requires directions (JSON array)");
    const char *s = dirs;
    while (*s == ' ' || *s == '\t' || *s == '\n' || *s == '\r') s++;
    if (*s != '[')
        return tool_error("directions must be a JSON array of "
                          "{\"entry\":...,\"tag\":...,\"name\":...,\"desc\":...}");
    /* Validate every "entry": each proposed file must exist under the sandbox
     * (the UI loads them as iframes via the sandboxed /api/design/file). */
    int count = 0;
    const char *q = dirs;
    while ((q = strstr(q, "\"entry\"")) != NULL) {
        q += 7;
        while (*q == ' ' || *q == '\t' || *q == ':') q++;
        if (*q != '"') break;
        q++;
        char entry[PATH_MAX];
        size_t n = 0;
        while (*q && *q != '"' && n + 1 < sizeof(entry)) {
            if (*q == '\\' && q[1]) q++;   /* de-escape \" \/ etc. for the check */
            entry[n++] = *q++;
        }
        entry[n] = '\0';
        char full[PATH_MAX], err[256];
        if (!project_resolve(pr, entry, full, sizeof(full), err, sizeof(err)))
            return tool_error(err);
        if (access(full, R_OK) != 0) {
            char m[PATH_MAX + 64];
            snprintf(m, sizeof(m),
                     "proposed direction file does not exist: %s (write it first)", entry);
            return tool_error(m);
        }
        count++;
        if (*q == '"') q++;
    }
    if (count == 0)
        return tool_error("propose needs at least one direction with an existing \"entry\" file");
    design_project_set_phase(pr, "waiting_user");
    emit_proposal_event(dirs);
    design_buf ev = {0};
    char n[32];
    buf_puts(&ev, "{\"directions\":");
    design_put_json_flat(&ev, dirs);
    buf_puts(&ev, ",\"count\":");
    snprintf(n, sizeof(n), "%d", count);
    buf_puts(&ev, n);
    buf_puts(&ev, "}");
    design_event_log(pr, "proposal_created", ev.ptr);
    free(ev.ptr);
    pr->stop_after_tools = true;
    char msg[128];
    snprintf(msg, sizeof(msg),
             "Proposed %d direction%s. The user can compare them and pick one to refine.\n",
             count, count == 1 ? "" : "s");
    return xstrdup(msg);
}

/* ============================================================================
 * Parse helpers (needed by search/more). Mirror ds4-agent's bounds-checked
 * argument parsing.
 * ============================================================================
 */
static int design_parse_int_default(const char *s, int def, int min, int max) {
    if (!s || !s[0]) return def;
    char *end = NULL;
    long v = strtol(s, &end, 10);
    if (end == s) return def;
    while (*end == ' ' || *end == '\t' || *end == '\r' || *end == '\n') end++;
    if (*end) return def;
    if (v < min) v = min;
    if (v > max) v = max;
    return (int)v;
}

static bool design_parse_bool_default(const char *s, bool def) {
    if (!s || !s[0]) return def;
    if (!strcasecmp(s, "true") || !strcasecmp(s, "yes") || !strcmp(s, "1"))
        return true;
    if (!strcasecmp(s, "false") || !strcasecmp(s, "no") || !strcmp(s, "0"))
        return false;
    return def;
}

/* ============================================================================
 * search: grep (literal or POSIX regex) + glob, fully sandboxed.
 *
 * Every filesystem path is produced by project_resolve(): the model supplies
 * a project-RELATIVE base ("." means the project root), and each directory we
 * descend into is re-resolved through project_resolve(), so a "..", an
 * absolute path, or a backslash anywhere is rejected before any opendir/fopen.
 * Glob matching and all emitted paths use the project-relative path only; the
 * absolute path under pr->dir is never shown and never globbed.
 * ============================================================================
 */

#define DESIGN_SEARCH_MAX_DEPTH 24

typedef struct {
    const design_project *pr; /* sandbox root for re-resolution */
    const char *query;
    const char *glob;
    regex_t regex;
    bool use_regex;
    bool regex_ready;
    bool case_sensitive;
    int context;
    int max_results;
    int results;
    design_buf out;
} design_search_ctx;

/* Case-aware literal substring test over a line (no NUL inside). */
static bool design_literal_match(const char *s, size_t n, const char *q,
                                 bool case_sensitive) {
    size_t qn = strlen(q);
    if (!qn) return true;
    if (qn > n) return false;
    for (size_t i = 0; i + qn <= n; i++) {
        bool ok = true;
        for (size_t j = 0; j < qn; j++) {
            unsigned char a = (unsigned char)s[i + j];
            unsigned char b = (unsigned char)q[j];
            if (!case_sensitive) {
                a = (unsigned char)tolower(a);
                b = (unsigned char)tolower(b);
            }
            if (a != b) { ok = false; break; }
        }
        if (ok) return true;
    }
    return false;
}

static bool design_search_line_matches(design_search_ctx *ctx,
                                        const char *s, size_t n) {
    if (ctx->use_regex) {
        char *line = xstrndup(s, n);
        int rc = regexec(&ctx->regex, line, 0, NULL, 0);
        free(line);
        return rc == 0;
    }
    return design_literal_match(s, n, ctx->query, ctx->case_sensitive);
}

/* Search one already-resolved regular file. `rel` is the project-relative
 * path used for glob matching and for the emitted header (never the absolute
 * `full`). Walks the flat buffer line by line, design-style (no line_spans). */
static void design_search_file(design_search_ctx *ctx, const char *full,
                               const char *rel) {
    if (ctx->results >= ctx->max_results) return;
    if (ctx->glob && ctx->glob[0]) {
        const char *base = strrchr(rel, '/');
        base = base ? base + 1 : rel;
        if (fnmatch(ctx->glob, base, 0) != 0 && fnmatch(ctx->glob, rel, 0) != 0)
            return;
    }
    char err[256];
    char *data = NULL;
    size_t len = 0;
    if (read_file_bytes(full, &data, &len, err, sizeof(err)) != 0) return;
    if (memchr(data, '\0', len)) { free(data); return; } /* skip binary */

    /* Index line starts so we can emit context windows. */
    size_t *starts = NULL;
    int line_count = 0, line_cap = 0;
    for (size_t i = 0; i <= len; i++) {
        if (i == 0 || (i < len && data[i - 1] == '\n')) {
            if (line_count == line_cap) {
                line_cap = line_cap ? line_cap * 2 : 64;
                starts = xrealloc(starts, (size_t)line_cap * sizeof(*starts));
            }
            starts[line_count++] = i;
        }
    }
    bool printed_file = false;
    int last_emitted = -1;
    for (int i = 0; i < line_count && ctx->results < ctx->max_results; i++) {
        size_t s = starts[i];
        size_t e = (i + 1 < line_count) ? starts[i + 1] : len;
        if (e > s && data[e - 1] == '\n') e--;            /* strip newline */
        if (e > s && data[e - 1] == '\r') e--;            /* strip CR */
        if (!design_search_line_matches(ctx, data + s, e - s)) continue;
        if (!printed_file) {
            buf_puts(&ctx->out, rel);
            buf_puts(&ctx->out, "\n");
            printed_file = true;
        }
        int from = i - ctx->context;
        int to = i + ctx->context;
        if (from < 0) from = 0;
        if (to >= line_count) to = line_count - 1;
        if (from <= last_emitted) from = last_emitted + 1;
        for (int j = from; j <= to; j++) {
            size_t js = starts[j];
            size_t je = (j + 1 < line_count) ? starts[j + 1] : len;
            if (je > js && data[je - 1] == '\n') je--;
            if (je > js && data[je - 1] == '\r') je--;
            char prefix[64];
            snprintf(prefix, sizeof(prefix), "  %d ", j + 1);
            buf_puts(&ctx->out, prefix);
            buf_append(&ctx->out, data + js, je - js);
            buf_puts(&ctx->out, "\n");
            last_emitted = j;
        }
        ctx->results++;
    }
    if (printed_file) buf_puts(&ctx->out, "\n");
    free(starts);
    free(data);
}

/* Recursively search a project-relative path. `rel` is "" for the project
 * root or a sandbox-validated relative path otherwise. Every child path is
 * re-validated through project_resolve(), so no escape is possible. */
static void design_search_rel(design_search_ctx *ctx, const char *rel, int depth) {
    if (ctx->results >= ctx->max_results || depth > DESIGN_SEARCH_MAX_DEPTH) return;

    char full[PATH_MAX], err[256];
    if (rel[0]) {
        if (!project_resolve(ctx->pr, rel, full, sizeof(full), err, sizeof(err)))
            return; /* refuses .., absolute, backslash, control chars */
    } else {
        snprintf(full, sizeof(full), "%s", ctx->pr->dir); /* project root */
    }

    struct stat st;
    if (lstat(full, &st) != 0) return;
    if (S_ISREG(st.st_mode)) { design_search_file(ctx, full, rel); return; }
    if (!S_ISDIR(st.st_mode)) return; /* symlinks/devices: ignored, never followed */

    DIR *dir = opendir(full);
    if (!dir) return;
    struct dirent *de;
    while ((de = readdir(dir)) != NULL && ctx->results < ctx->max_results) {
        if (de->d_name[0] == '.') continue; /* skip ., .., dotfiles, .git */
        char child[PATH_MAX];
        snprintf(child, sizeof(child), "%s%s%s", rel, rel[0] ? "/" : "", de->d_name);
        design_search_rel(ctx, child, depth + 1);
    }
    closedir(dir);
}

static char *design_tool_search(design_project *pr, const design_tool_call *call) {
    const char *query = tool_arg_value(call, "query");
    if (!query || !query[0]) return tool_error("search requires query");
    const char *path = tool_arg_value(call, "path");
    if (!path || !path[0] || !strcmp(path, ".")) path = ""; /* "" == project root */
    const char *mode = tool_arg_value(call, "mode");

    design_search_ctx ctx = {
        .pr = pr,
        .query = query,
        .glob = tool_arg_value(call, "glob"),
        .use_regex = mode && !strcmp(mode, "regex"),
        .case_sensitive =
            design_parse_bool_default(tool_arg_value(call, "case_sensitive"), true),
        .context = design_parse_int_default(tool_arg_value(call, "context"), 0, 0, 5),
        .max_results =
            design_parse_int_default(tool_arg_value(call, "max_results"), 50, 1, 500),
    };

    /* A non-root base path must itself pass the sandbox check up front, so a
     * bad base reports a clear error instead of silently matching nothing. */
    if (path[0]) {
        char full[PATH_MAX], err[256];
        if (!project_resolve(pr, path, full, sizeof(full), err, sizeof(err)))
            return tool_error(err);
    }

    if (ctx.use_regex) {
        int flags = REG_EXTENDED | REG_NOSUB;
        if (!ctx.case_sensitive) flags |= REG_ICASE;
        int rc = regcomp(&ctx.regex, query, flags);
        if (rc != 0) {
            char msg[256];
            regerror(rc, &ctx.regex, msg, sizeof(msg));
            design_buf b = {0};
            buf_puts(&b, "Tool error: invalid regex: ");
            buf_puts(&b, msg);
            buf_puts(&b, "\n");
            return buf_take(&b);
        }
        ctx.regex_ready = true;
    }

    design_search_rel(&ctx, path, 0);
    if (ctx.regex_ready) regfree(&ctx.regex);

    if (!ctx.out.ptr) buf_puts(&ctx.out, "No matches\n");
    else {
        char hdr[96];
        snprintf(hdr, sizeof(hdr), "%d match%s shown\n\n",
                 ctx.results, ctx.results == 1 ? "" : "es");
        design_buf prefixed = {0};
        buf_puts(&prefixed, hdr);
        buf_append(&prefixed, ctx.out.ptr, ctx.out.len);
        free(buf_take(&ctx.out));
        return buf_take(&prefixed);
    }
    return buf_take(&ctx.out);
}

/* ============================================================================
 * more: continue the previous read. State lives in design_project (populated
 * by tool_read), so the dispatch keeps passing &a->project unchanged. The
 * stored relative path is RE-RESOLVED through project_resolve() here, so even
 * a corrupted state cannot escape the sandbox.
 * ============================================================================
 */
static char *design_tool_more(design_project *pr, const design_tool_call *call) {
    if (!pr->more_valid || !pr->more_path[0])
        return tool_error("no previous read to continue");
    int count = design_parse_int_default(tool_arg_value(call, "count"),
                                         DESIGN_READ_DEFAULT_LINES, 1, INT_MAX);

    char full[PATH_MAX], err[256];
    if (!project_resolve(pr, pr->more_path, full, sizeof(full), err, sizeof(err))) {
        pr->more_valid = false;
        return tool_error(err);
    }
    char *data = NULL;
    size_t len = 0;
    if (read_file_bytes(full, &data, &len, err, sizeof(err)) != 0) {
        pr->more_valid = false;
        return tool_error(err);
    }

    int start = pr->more_next_line;
    if (start < 1) start = 1;
    int total = count_lines_before(data, len);
    int end = start + count - 1;
    if (end > total) end = total;

    design_buf b = {0};
    char hdr[640];
    snprintf(hdr, sizeof(hdr), "%s: lines %d-%d of %d\n",
             pr->more_path, start > total ? total : start, end, total);
    buf_puts(&b, hdr);
    append_numbered_lines(&b, data, len, start, end);
    if (end < total) {
        snprintf(hdr, sizeof(hdr),
                 "[Truncated. Call more with count=%d to continue.]\n", count);
        buf_puts(&b, hdr);
        pr->more_next_line = end + 1;
        pr->more_valid = true;
    } else {
        pr->more_valid = false; /* reached EOF: nothing left to continue */
    }
    free(data);
    return buf_take(&b);
}

/* ============================================================================
 * bash: async shell jobs, copied from ds4-agent and adapted to headless
 * single-thread. The agent runs a reaper thread; here each turn drains the job
 * opportunistically (poll/status/stop) and blocks in the tool up to refresh_sec
 * or timeout — exactly the agent's _refresh_for loop, minus the interrupt flag.
 *
 * !! SECURITY: this is unsandboxed RCE. The shell child runs as the user with
 *    cwd = project dir; serve.c exposes it on the LAN by default. The only
 *    network mitigation today is DS4UI_HOST=127.0.0.1 (see serve.c banner) and,
 *    eventually, an access token. Nothing here restricts what the command does.
 * ============================================================================
 */

#define DESIGN_BASH_HEAD_BYTES (8*1024)
#define DESIGN_BASH_HEAD_LINES 100
#define DESIGN_BASH_TAIL_BYTES (32*1024)
#define DESIGN_BASH_PROGRESS_TAIL_LINES 4
#define DESIGN_BASH_FINAL_TAIL_LINES 20

typedef struct design_bash_job {
    int id;
    pid_t pid;
    int pipe_fd;
    int tmp_fd;
    char path[PATH_MAX];
    char *cmd;
    double start_time;
    double timeout_sec;
    size_t bytes;
    int newline_count;
    char last_byte;
    size_t observed_bytes;
    int observed_display_lines;
    bool observed_once;
    int exit_status;
    bool running;
    bool timed_out;
    struct design_bash_job *next;
} design_bash_job;

/* Default 120s / cap 600s (the agent default is 3600). */
static int design_parse_timeout(const char *s) {
    if (!s || !s[0]) return 120;
    char *end = NULL;
    double v = strtod(s, &end);
    if (end == s || !(v > 0.0)) return 120; /* rejects NaN, <=0, empty */
    if (v > 600.0) v = 600.0;               /* also caps +inf */
    if (v < 1.0) v = 1.0;
    return (int)v;
}

static int design_bash_display_lines(const design_bash_job *job) {
    if (!job || job->bytes == 0) return 0;
    return job->newline_count + (job->last_byte != '\n');
}

static void design_bash_note_output(design_bash_job *job, const char *s, size_t n) {
    for (size_t i = 0; i < n; i++) {
        if (s[i] == '\n') job->newline_count++;
    }
    if (n) job->last_byte = s[n - 1];
    job->bytes += n;
}

/* Free one job: SIGKILL it if still running, close fds, drop the temp file.
 * Called only from the shutdown sweep — during a session jobs are kept so
 * output_path stays cattable (read/more/search are sandboxed and can't reach
 * /tmp, so only `bash cat` can read it). */
static void design_bash_job_free(design_bash_job *job) {
    if (!job) return;
    if (job->running && job->pid > 0) {
        kill(-job->pid, SIGKILL);
        kill(job->pid, SIGKILL);
        waitpid(job->pid, NULL, 0);
    }
    if (job->pipe_fd >= 0) close(job->pipe_fd);
    if (job->tmp_fd >= 0) close(job->tmp_fd);
    if (job->path[0]) unlink(job->path);
    free(job->cmd);
    free(job);
}

static void design_bash_jobs_free(design_project *pr) {
    design_bash_job *job = pr->bash_jobs;
    while (job) {
        design_bash_job *next = job->next;
        design_bash_job_free(job);
        job = next;
    }
    pr->bash_jobs = NULL;
}

static design_bash_job *design_bash_find_job(design_project *pr, int id, pid_t pid) {
    for (design_bash_job *job = pr->bash_jobs; job; job = job->next) {
        if ((id > 0 && job->id == id) || (id <= 0 && pid > 0 && job->pid == pid))
            return job;
    }
    return NULL;
}

static void design_bash_drain(design_bash_job *job) {
    if (!job || job->pipe_fd < 0) return;
    char tmp[4096];
    for (;;) {
        ssize_t n = read(job->pipe_fd, tmp, sizeof(tmp));
        if (n > 0) {
            design_bash_note_output(job, tmp, (size_t)n);
            if (job->tmp_fd >= 0) write_all_fd(job->tmp_fd, tmp, (size_t)n);
            continue;
        }
        if (n < 0 && errno == EINTR) continue;
        break;
    }
}

static void design_bash_finalize(design_bash_job *job, int status) {
    design_bash_drain(job);
    if (job->pipe_fd >= 0) { close(job->pipe_fd); job->pipe_fd = -1; }
    if (job->tmp_fd >= 0) { close(job->tmp_fd); job->tmp_fd = -1; }
    if (WIFEXITED(status)) job->exit_status = WEXITSTATUS(status);
    else if (WIFSIGNALED(status)) job->exit_status = 128 + WTERMSIG(status);
    else job->exit_status = -1;
    job->running = false;
}

/* Drain output, notice exit, enforce timeout. Called from status/wait paths. */
static void design_bash_poll(design_bash_job *job) {
    if (!job || !job->running) return;
    design_bash_drain(job);

    int status = 0;
    pid_t rc = waitpid(job->pid, &status, WNOHANG);
    if (rc == job->pid) { design_bash_finalize(job, status); return; }
    if (rc < 0 && errno != EINTR) {
        job->exit_status = -1;
        job->running = false;
        if (job->pipe_fd >= 0) { close(job->pipe_fd); job->pipe_fd = -1; }
        if (job->tmp_fd >= 0) { close(job->tmp_fd); job->tmp_fd = -1; }
        return;
    }
    if (now_sec() - job->start_time >= job->timeout_sec) {
        job->timed_out = true;
        kill(-job->pid, SIGKILL);
        kill(job->pid, SIGKILL);
        while (waitpid(job->pid, &status, 0) < 0 && errno == EINTR) {}
        design_bash_finalize(job, status);
    }
}

/* Spawn a shell command into its own process group (so bash_stop/timeout kills
 * grandchildren) with cwd = project dir. */
static design_bash_job *design_bash_start(design_project *pr, const char *cmd,
                                          int timeout_sec, char *err, size_t err_len) {
    char tmp_path[PATH_MAX];
    int tmpfd = design_tempfile_in_dir(tmp_path, sizeof tmp_path,
                                       design_tmp_dir(), "ds4_design_output", ".log");
    if (tmpfd < 0) {
        snprintf(err, err_len, "failed to create temporary output file: %s", strerror(errno));
        return NULL;
    }
    int pipefd[2];
    if (pipe(pipefd) != 0) {
        snprintf(err, err_len, "failed to create pipe: %s", strerror(errno));
        close(tmpfd); unlink(tmp_path);
        return NULL;
    }
    /* Block SIGTERM across fork + link so the SIGTERM handler can't fire while
     * a child exists but is not yet in bash_jobs (it would orphan that child).
     * The child restores the default disposition and mask before exec so the
     * shell stays killable by bash_stop's SIGTERM. */
    sigset_t block, prev;
    sigemptyset(&block);
    sigaddset(&block, SIGTERM);
    sigprocmask(SIG_BLOCK, &block, &prev);

    pid_t pid = fork();
    if (pid < 0) {
        snprintf(err, err_len, "failed to fork: %s", strerror(errno));
        close(pipefd[0]); close(pipefd[1]); close(tmpfd); unlink(tmp_path);
        sigprocmask(SIG_SETMASK, &prev, NULL);
        return NULL;
    }
    if (pid == 0) {
        signal(SIGTERM, SIG_DFL);              /* don't run design's handler in the child */
        sigprocmask(SIG_SETMASK, &prev, NULL); /* and don't leave SIGTERM blocked for the shell */
        setpgid(0, 0);
        close(tmpfd);
        close(pipefd[0]);
        dup2(pipefd[1], STDOUT_FILENO);
        dup2(pipefd[1], STDERR_FILENO);
        close(pipefd[1]);
        /* Run in the workspace; design's main process keeps cwd at the ds4 dir
         * (where the Metal sources live), so this chdir is per-child only. Done
         * AFTER the dup2s so a failure (e.g. the workspace was deleted) is
         * captured in the job output instead of a bare exit 127. */
        if (pr->dir[0] && chdir(pr->dir) != 0) {
            dprintf(STDERR_FILENO, "chdir(%s) failed: %s\n", pr->dir, strerror(errno));
            _exit(127);
        }
        execl("/bin/sh", "sh", "-c", cmd ? cmd : "", (char *)NULL);
        _exit(127);
    }

    close(pipefd[1]);
    setpgid(pid, pid);
    int old_flags;
    set_nonblock(pipefd[0], true, &old_flags);

    design_bash_job *job = xmalloc(sizeof(*job));
    memset(job, 0, sizeof(*job));
    if (pr->next_bash_job_id <= 0) pr->next_bash_job_id = 1;
    job->id = pr->next_bash_job_id++;
    job->pid = pid;
    job->pipe_fd = pipefd[0];
    job->tmp_fd = tmpfd;
    snprintf(job->path, sizeof(job->path), "%s", tmp_path);
    job->cmd = xstrdup(cmd ? cmd : "");
    job->start_time = now_sec();
    job->timeout_sec = timeout_sec;
    job->exit_status = -1;
    job->running = true;
    job->next = pr->bash_jobs;
    pr->bash_jobs = job;
    sigprocmask(SIG_SETMASK, &prev, NULL); /* job linked: handler may run again */
    return job;
}

static void design_tail_append(design_buf *b, const char *s, size_t n, size_t max) {
    if (!n) return;
    buf_append(b, s, n);
    if (b->len > max) {
        size_t drop = b->len - max;
        memmove(b->ptr, b->ptr + drop, b->len - drop + 1);
        b->len -= drop;
    }
}

/* First max_lines of output, byte-capped so one pathological long line can't
 * flood the next model turn. */
static char *design_bash_read_head(const design_bash_job *job, int max_lines,
                                   size_t max_bytes, int *lines_read,
                                   bool *byte_limited) {
    if (lines_read) *lines_read = 0;
    if (byte_limited) *byte_limited = false;
    if (!job || !job->path[0] || job->bytes == 0) return xstrdup("");
    FILE *fp = fopen(job->path, "rb");
    if (!fp) return xstrdup("<failed to reopen output file>\n");

    design_buf out = {0};
    int lines = 0;
    while (lines < max_lines && out.len < max_bytes) {
        int c = fgetc(fp);
        if (c == EOF) {
            if (ferror(fp) && errno == EINTR) { clearerr(fp); continue; }
            break;
        }
        char ch = (char)c;
        buf_append(&out, &ch, 1);
        if (ch == '\n') lines++;
    }
    if (out.len >= max_bytes && !feof(fp) && byte_limited) *byte_limited = true;
    fclose(fp);
    if (lines_read) *lines_read = lines + (out.len && out.ptr[out.len - 1] != '\n');
    if (!out.ptr) return xstrdup("");
    return buf_take(&out);
}

/* Last max_lines of the full output file (labelled "tail -N" for the model). */
static char *design_bash_read_tail_lines(const design_bash_job *job, int max_lines) {
    if (!job || !job->path[0] || job->bytes == 0) return xstrdup("");
    FILE *fp = fopen(job->path, "rb");
    if (!fp) return xstrdup("<failed to reopen output file>\n");

    design_buf tail = {0};
    char tmp[2048];
    for (;;) {
        size_t n = fread(tmp, 1, sizeof(tmp), fp);
        if (n) design_tail_append(&tail, tmp, n, DESIGN_BASH_TAIL_BYTES);
        if (n < sizeof(tmp)) {
            if (ferror(fp) && errno == EINTR) { clearerr(fp); continue; }
            break;
        }
    }
    fclose(fp);
    if (!tail.ptr) return xstrdup("");

    char *start = tail.ptr;
    int newlines = 0;
    for (char *p = tail.ptr + tail.len; p > tail.ptr; p--) {
        if (p[-1] == '\n' && ++newlines > max_lines) { start = p; break; }
    }
    char *out = xstrdup(start);
    free(tail.ptr);
    return out;
}

/* Build the tool result for a bash job. mark_observed advances the per-job
 * cursor so the next status reports only fresh output. */
static char *design_bash_observation(design_bash_job *job, bool mark_observed) {
    design_bash_poll(job);
    bool first_observation = !job->observed_once;
    int display_lines = design_bash_display_lines(job);
    double elapsed = now_sec() - job->start_time;

    design_buf out = {0};
    char line[PATH_MAX + 256];
    if (job->running) {
        snprintf(line, sizeof(line),
            "bash job=%d pid=%ld status=running elapsed_sec=%.1f timeout_sec=%.0f\n",
            job->id, (long)job->pid, elapsed, job->timeout_sec);
    } else {
        snprintf(line, sizeof(line),
            "bash job=%d pid=%ld status=done elapsed_sec=%.1f timed_out=%d\n",
            job->id, (long)job->pid, elapsed, job->timed_out ? 1 : 0);
    }
    buf_puts(&out, line);
    if (!job->running) {
        snprintf(line, sizeof(line), "exit_status=%d\n", job->exit_status);
        buf_puts(&out, line);
    }

    if (job->bytes == 0) {
        buf_puts(&out, "<output>\n</output>\n");
    } else if (first_observation) {
        int shown_lines = 0;
        bool byte_limited = false;
        char *head = design_bash_read_head(job, DESIGN_BASH_HEAD_LINES,
                                           DESIGN_BASH_HEAD_BYTES,
                                           &shown_lines, &byte_limited);
        bool truncated = byte_limited || display_lines > shown_lines;
        if (!job->running && !truncated) {
            buf_puts(&out, "<output>\n");
            buf_puts(&out, head);
            if (head[0] && head[strlen(head) - 1] != '\n') buf_puts(&out, "\n");
            buf_puts(&out, "</output>\n");
        } else {
            snprintf(line, sizeof(line),
                     "output_path=%s (%zu bytes, %d lines)\n",
                     job->path[0] ? job->path : "<unavailable>",
                     job->bytes, display_lines);
            buf_puts(&out, line);
            snprintf(line, sizeof(line), "<head -%d %s>\n",
                     DESIGN_BASH_HEAD_LINES, job->path);
            buf_puts(&out, line);
            buf_puts(&out, head);
            if (head[0] && head[strlen(head) - 1] != '\n') buf_puts(&out, "\n");
            buf_puts(&out, "</head>\n");
        }
        free(head);
    } else {
        int tail_lines = job->running ? DESIGN_BASH_PROGRESS_TAIL_LINES :
                                        DESIGN_BASH_FINAL_TAIL_LINES;
        char *tail = design_bash_read_tail_lines(job, tail_lines);
        snprintf(line, sizeof(line),
                 "output_path=%s (%zu bytes, %d lines)\n",
                 job->path[0] ? job->path : "<unavailable>",
                 job->bytes, display_lines);
        buf_puts(&out, line);
        snprintf(line, sizeof(line), "<tail -%d %s>\n", tail_lines, job->path);
        buf_puts(&out, line);
        buf_puts(&out, tail);
        if (tail[0] && tail[strlen(tail) - 1] != '\n') buf_puts(&out, "\n");
        buf_puts(&out, "</tail>\n");
        free(tail);
    }
    if (job->running) {
        snprintf(line, sizeof(line),
            "\nUse bash_status job=%d to get info before refresh time; use bash_stop job=%d to stop execution\n",
            job->id, job->id);
        buf_puts(&out, line);
    }

    if (mark_observed) {
        job->observed_bytes = job->bytes;
        job->observed_display_lines = display_lines;
        job->observed_once = true;
    }
    return buf_take(&out);
}

/* Block up to refresh_sec for the job to finish (headless: no interrupt flag). */
static void design_bash_refresh_for(design_bash_job *job, int refresh_sec) {
    double start = now_sec();
    while (job->running && now_sec() - start < refresh_sec) {
        design_bash_poll(job);
        if (!job->running) break;
        struct pollfd pfd = {.fd = job->pipe_fd, .events = POLLIN};
        poll(&pfd, 1, 100);
    }
    design_bash_poll(job);
}

/* Common implementation for bash, bash_status, and bash_stop. Completed jobs
 * are NOT removed: they stay in the project's job list so output_path remains
 * cattable and so jobs_free / the SIGTERM handler can clean every temp file and
 * process group. The list is bounded by the number of bash calls in a turn. */
static char *design_bash_job_tool_result(design_bash_job *job,
                                         bool wait, int refresh_sec, bool stop) {
    if (stop && job->running) {
        kill(-job->pid, SIGTERM);
        kill(job->pid, SIGTERM);
        double start = now_sec();
        while (job->running && now_sec() - start < 1.0) {
            design_bash_poll(job);
            if (!job->running) break;
            usleep(20000);
        }
        if (job->running) {
            kill(-job->pid, SIGKILL);
            kill(job->pid, SIGKILL);
        }
    }
    if (wait || stop) design_bash_refresh_for(job, refresh_sec);
    else design_bash_poll(job);

    return design_bash_observation(job, true);
}

/* SIGTERM cleanup: serve.c stops the design child with SIGTERM (3s grace) then
 * SIGKILL. Without a handler, design dies on SIGTERM before main() returns, so
 * bash children — each in its own process group — survive as orphans and the
 * temp files leak. This handler SIGKILLs every bash process group and unlinks
 * its temp file, then _exit(0). It only uses async-signal-safe calls (kill,
 * unlink, _exit) and reads inline fields (pid, path) — never free() and never
 * the cmd pointer — so it is safe to run from the signal context. */
static design_project *g_term_project = NULL;
static void design_on_term(int sig) {
    (void)sig;
    if (g_term_project) {
        for (design_bash_job *j = g_term_project->bash_jobs; j; j = j->next) {
            /* Only signal jobs still running: a completed job's pid was already
             * reaped and may have been recycled, so kill(-pid) could hit an
             * unrelated process group. Unlinking the temp file is always safe. */
            if (j->running && j->pid > 0) { kill(-j->pid, SIGKILL); kill(j->pid, SIGKILL); }
            if (j->path[0]) unlink(j->path);
        }
    }
    _exit(0);
}

/* ============================================================================
 * web: google_search + visit_page via ds4_web (raw CDP over a Chrome the lib
 * launches). Headless design has no interactive prompt, so the confirm callback
 * AUTO-APPROVES Chrome startup (ds4-agent's confirm would refuse in
 * non-interactive mode). Progress lines go to stderr (serve.c's terminal).
 *
 * !! SECURITY: like bash, this is reachable by anyone who can hit serve on the
 *    LAN; it drives a real browser as the user. Mitigation is the same:
 *    DS4UI_HOST=127.0.0.1 (see serve.c banner).
 * ============================================================================
 */

#define DESIGN_WEB_HEAD_LINES 400
#define DESIGN_WEB_HEAD_BYTES (24 * 1024)

static int design_web_confirm(void *privdata, const char *message,
                              char *err, size_t err_len) {
    (void)privdata; (void)message; (void)err; (void)err_len;
    return 1; /* headless: no UI prompt, so approve Chrome startup */
}

static void design_web_log(void *privdata, const char *message) {
    (void)privdata;
    if (message && message[0]) fprintf(stderr, "ds4-design web: %s\n", message);
}

static bool design_web_cancel(void *privdata) {
    (void)privdata;
    return false; /* headless: no interrupt source mid-operation */
}

static char *design_tool_google_search(design_project *pr, const design_tool_call *call) {
    const char *query = tool_arg_value(call, "query");
    if (!query || !query[0]) return tool_error("google_search requires query");
    if (!pr->web) return tool_error("web tools are unavailable");
    char err[256] = {0};
    char *md = ds4_web_google_search(pr->web, query, err, sizeof(err));
    if (!md) {
        design_buf b = {0};
        buf_puts(&b, "Tool error: google_search failed: ");
        buf_puts(&b, err[0] ? err : "unknown error");
        buf_puts(&b, "\n");
        return buf_take(&b);
    }
    return md; /* compact Markdown links, already small */
}

static char *design_tool_visit_page(design_project *pr, const design_tool_call *call) {
    const char *url = tool_arg_value(call, "url");
    if (!url || !url[0]) return tool_error("visit_page requires url");
    if (!pr->web) return tool_error("web tools are unavailable");
    char err[256] = {0};
    char *md = ds4_web_visit_page(pr->web, url, err, sizeof(err));
    if (!md) {
        design_buf b = {0};
        buf_puts(&b, "Tool error: visit_page failed: ");
        buf_puts(&b, err[0] ? err : "unknown error");
        buf_puts(&b, "\n");
        return buf_take(&b);
    }
    /* Inline a capped head of the rendered Markdown. ds4-agent stashes the full
     * page in /tmp and hands back output_path for `read raw=true`, but design's
     * read/more are sandboxed to the project dir and can't reach /tmp, so a path
     * would be useless here — return the head directly. */
    size_t mdlen = strlen(md);
    int total = count_lines_before(md, mdlen);
    size_t i = 0;
    int lines = 0;
    while (i < mdlen && lines < DESIGN_WEB_HEAD_LINES && i < DESIGN_WEB_HEAD_BYTES) {
        if (md[i] == '\n') lines++;
        i++;
    }
    bool truncated = i < mdlen;

    design_buf out = {0};
    char line[640];
    snprintf(line, sizeof(line), "visit_page url=%s (%zu bytes, %d lines)\n",
             url, mdlen, total);
    buf_puts(&out, line);
    buf_puts(&out, truncated ? "<head>\n" : "<markdown>\n");
    buf_append(&out, md, i);
    if (i > 0 && md[i - 1] != '\n') buf_puts(&out, "\n");
    if (truncated)
        buf_puts(&out, "</head>\n[Truncated to the first part of the page. "
                       "Visit a more specific URL or search for the rest.]\n");
    else
        buf_puts(&out, "</markdown>\n");
    free(md);
    return buf_take(&out);
}

/* ---- dispatch + UI events around execution ---- */

/* write carries whole documents: cap each input value shown to the UI so the
 * transcript stays light (the full value still reaches the tool). */
#define EVENT_INPUT_MAX 300

static void emit_tool_call_event(const design_tool_call *call) {
    if (!g_jsonl) return;
    design_buf b = {0};
    buf_puts(&b, "\x1e{\"type\":\"tool_call\",\"name\":\"");
    json_escape_buf(&b, call->name ? call->name : "",
                    call->name ? strlen(call->name) : 0);
    buf_puts(&b, "\",\"input\":{");
    for (int i = 0; i < call->argc; i++) {
        const char *an = call->args[i].name ? call->args[i].name : "";
        const char *av = call->args[i].value ? call->args[i].value : "";
        if (i) buf_puts(&b, ",");
        buf_puts(&b, "\"");
        json_escape_buf(&b, an, strlen(an));
        buf_puts(&b, "\":\"");
        size_t vlen = strlen(av);
        if (vlen > EVENT_INPUT_MAX) {
            json_escape_buf(&b, av, EVENT_INPUT_MAX);
            buf_puts(&b, "…");
        } else {
            json_escape_buf(&b, av, vlen);
        }
        buf_puts(&b, "\"");
    }
    buf_puts(&b, "}}\n");
    emit_event_line(&b);
}

static void emit_tool_result_event(const char *name, const char *result) {
    if (!g_jsonl) return;
    design_buf b = {0};
    buf_puts(&b, "\x1e{\"type\":\"tool_result\",\"name\":\"");
    json_escape_buf(&b, name ? name : "", name ? strlen(name) : 0);
    buf_puts(&b, "\",\"output\":\"");
    json_escape_buf(&b, result, strlen(result));
    buf_puts(&b, "\"}\n");
    emit_event_line(&b);
}

/* On-demand pack loader: returns a skill or design-system Markdown body so the model
 * can pull a focused recipe / brand mid-conversation, no restart. The packs live in the
 * DStudio checkout, passed by the launcher as DS4UI_SKILLS_DIR; name is sanitised to
 * [a-z0-9-] so it can never escape that directory (the model controls it). */
static int design_pack_name_ok(const char *s) {
    if (!s || !s[0]) return 0;
    for (const char *p = s; *p; p++)
        if (!((*p >= 'a' && *p <= 'z') || (*p >= '0' && *p <= '9') || *p == '-')) return 0;
    return 1;
}
static char *design_read_file_buf(const char *path) {  /* file body, or NULL */
    FILE *f = fopen(path, "rb");
    if (!f) return NULL;
    design_buf b = {0};
    char chunk[4096];
    size_t n;
    while ((n = fread(chunk, 1, sizeof chunk, f)) > 0) buf_append(&b, chunk, n);
    fclose(f);
    return buf_take(&b);
}

static char *design_read_file_buf_limit(const char *path, size_t max_bytes,
                                        bool *truncated) {
    FILE *f = fopen(path, "rb");
    if (!f) return NULL;
    design_buf b = {0};
    char chunk[4096];
    size_t n;
    if (truncated) *truncated = false;
    while ((n = fread(chunk, 1, sizeof chunk, f)) > 0) {
        if (b.len + n > max_bytes) {
            size_t keep = max_bytes > b.len ? max_bytes - b.len : 0;
            if (keep) buf_append(&b, chunk, keep);
            if (truncated) *truncated = true;
            break;
        }
        buf_append(&b, chunk, n);
    }
    fclose(f);
    return buf_take(&b);
}

static bool design_string_list_contains(const design_string_list *l, const char *s) {
    for (int i = 0; i < l->len; i++) {
        if (!strcmp(l->v[i], s)) return true;
    }
    return false;
}

static void design_pack_collect_dash_id(const char *line, design_string_list *ids) {
    const char *p = line;
    while (*p == ' ' || *p == '\t') p++;
    if (*p != '-') return;
    p++;
    while (*p == ' ' || *p == '\t') p++;
    char id[96];
    size_t n = 0;
    while ((*p == '-' || (*p >= 'a' && *p <= 'z') || (*p >= '0' && *p <= '9')) &&
           n + 1 < sizeof(id)) {
        id[n++] = *p++;
    }
    id[n] = '\0';
    if (design_pack_name_ok(id) && !design_string_list_contains(ids, id))
        design_string_list_push(ids, xstrdup(id));
}

static void design_pack_collect_inline_ids(const char *line, design_string_list *ids) {
    const char *lb = strchr(line, '[');
    const char *rb = lb ? strchr(lb, ']') : NULL;
    if (!lb || !rb || rb <= lb) return;
    const char *p = lb + 1;
    while (p < rb) {
        while (p < rb && (*p == ' ' || *p == '\t' || *p == ',' || *p == '"' || *p == '\'')) p++;
        char id[96];
        size_t n = 0;
        while (p < rb &&
               (*p == '-' || (*p >= 'a' && *p <= 'z') || (*p >= '0' && *p <= '9')) &&
               n + 1 < sizeof(id)) {
            id[n++] = *p++;
        }
        id[n] = '\0';
        if (design_pack_name_ok(id) && !design_string_list_contains(ids, id))
            design_string_list_push(ids, xstrdup(id));
        while (p < rb && *p != ',') p++;
    }
}

static void design_pack_collect_craft_requires(const char *body,
                                               design_string_list *ids) {
    const char *p = body;
    bool in_frontmatter = false;
    bool started = false;
    bool in_meta = false;
    bool in_craft = false;
    bool in_requires = false;
    while (*p) {
        const char *line = p;
        const char *nl = strchr(p, '\n');
        size_t len = nl ? (size_t)(nl - line) : strlen(line);
        char tmp[512];
        size_t keep = len < sizeof(tmp) - 1 ? len : sizeof(tmp) - 1;
        memcpy(tmp, line, keep);
        tmp[keep] = '\0';
        char *t = tmp;
        while (*t == ' ' || *t == '\t') t++;
        if (!started) {
            started = true;
            if (!strcmp(t, "---")) { in_frontmatter = true; p = nl ? nl + 1 : line + len; continue; }
            break;
        }
        if (in_frontmatter && !strcmp(t, "---")) break;
        if (!in_frontmatter) break;
        if (!strncmp(t, "ds4:", 4) || !strncmp(t, "quality:", 8)) {
            in_meta = true; in_craft = false; in_requires = false;
        }
        else if (in_meta && !strncmp(t, "craft:", 6)) { in_craft = true; in_requires = false; }
        else if (in_meta && in_craft && !strncmp(t, "requires:", 9)) {
            in_requires = true;
            design_pack_collect_inline_ids(t, ids);
        } else if (in_meta && in_craft && in_requires && t[0] == '-') {
            design_pack_collect_dash_id(t, ids);
        } else if (in_requires && t[0] && t[0] != '-' && !isspace((unsigned char)tmp[0])) {
            in_requires = false;
        }
        if (strstr(t, "craft.requires") || strstr(t, "craft_requires"))
            design_pack_collect_inline_ids(t, ids);
        p = nl ? nl + 1 : line + len;
    }
}

static void design_pack_append_truncation_note(design_buf *b, const char *label,
                                               bool truncated, size_t max_bytes) {
    if (!truncated) return;
    char note[160];
    snprintf(note, sizeof(note),
             "\n\n[ds4-design: %s truncated at %zu bytes to protect context]\n",
             label, max_bytes);
    buf_puts(b, note);
}

static bool design_pack_file_ext_ok(const char *rel) {
    const char *ext = strrchr(rel, '.');
    if (!ext) return false;
    static const char *ok[] = {
        ".md", ".html", ".css", ".js", ".json", ".svg", ".txt", ".csv",
        ".py", ".sh", ".yaml", ".yml", ".toml", NULL
    };
    for (int i = 0; ok[i]; i++) {
        if (!strcasecmp(ext, ok[i])) return true;
    }
    return false;
}

static bool design_pack_file_rel_ok(const char *rel, char *err, size_t errsz) {
    if (!rel || !rel[0]) {
        snprintf(err, errsz, "path is required");
        return false;
    }
    if (rel[0] == '/' || rel[0] == '~') {
        snprintf(err, errsz, "pack_file path must be relative");
        return false;
    }
    size_t len = strlen(rel);
    if (len > 512) {
        snprintf(err, errsz, "pack_file path too long");
        return false;
    }
    if (strcmp(rel, "example.html") &&
        strncmp(rel, "assets/", 7) &&
        strncmp(rel, "references/", 11) &&
        strncmp(rel, "scripts/", 8))
    {
        snprintf(err, errsz, "pack_file path must be example.html, assets/*, references/*, or scripts/*");
        return false;
    }
    if (!design_pack_file_ext_ok(rel)) {
        snprintf(err, errsz, "pack_file extension is not allowed");
        return false;
    }
    const char *p = rel;
    while (*p) {
        const char *seg = p;
        while (*p && *p != '/') {
            unsigned char c = (unsigned char)*p;
            if (!(isalnum(c) || c == '-' || c == '_' || c == '.')) {
                snprintf(err, errsz, "pack_file path contains invalid characters");
                return false;
            }
            p++;
        }
        size_t seglen = (size_t)(p - seg);
        if (seglen == 0 || (seglen == 1 && seg[0] == '.') ||
            (seglen == 2 && seg[0] == '.' && seg[1] == '.'))
        {
            snprintf(err, errsz, "pack_file path must not contain . or .. segments");
            return false;
        }
        if (*p == '/') p++;
    }
    return true;
}

static size_t design_pack_file_cap(const char *rel) {
    if (!strcmp(rel, "example.html") || !strncmp(rel, "assets/", 7) || !strncmp(rel, "scripts/", 8))
        return 96 * 1024;
    return 32 * 1024;
}

static bool design_pack_resolve_existing_file(const char *pack_root,
                                              const char *rel,
                                              char *out, size_t outsz,
                                              char *err, size_t errsz) {
    char real_root[PATH_MAX];
    if (!realpath(pack_root, real_root)) {
        snprintf(err, errsz, "pack root unavailable");
        return false;
    }
    char joined[PATH_MAX];
    if ((size_t)snprintf(joined, sizeof(joined), "%s/%s", pack_root, rel) >= sizeof(joined)) {
        snprintf(err, errsz, "pack_file path too long");
        return false;
    }
    char real_file[PATH_MAX];
    if (!realpath(joined, real_file)) {
        snprintf(err, errsz, "pack_file not found");
        return false;
    }
    size_t rl = strlen(real_root);
    if (strncmp(real_file, real_root, rl) != 0 ||
        (real_file[rl] != '\0' && real_file[rl] != '/'))
    {
        snprintf(err, errsz, "pack_file escapes the pack directory");
        return false;
    }
    struct stat st;
    if (stat(real_file, &st) != 0 || !S_ISREG(st.st_mode)) {
        snprintf(err, errsz, "pack_file is not a regular file");
        return false;
    }
    if ((size_t)snprintf(out, outsz, "%s", real_file) >= outsz) {
        snprintf(err, errsz, "pack_file path too long");
        return false;
    }
    return true;
}

static void design_pack_inventory_append_file(design_buf *out, const char *rel,
                                              int *count) {
    if (*count >= 80) return;
    char err[160];
    if (!design_pack_file_rel_ok(rel, err, sizeof(err))) return;
    buf_puts(out, *count ? ", " : "");
    buf_puts(out, rel);
    (*count)++;
}

static void design_pack_inventory_append_dir(const char *pack_root,
                                             const char *prefix,
                                             design_buf *out,
                                             int *count) {
    char dir[PATH_MAX];
    if ((size_t)snprintf(dir, sizeof(dir), "%s/%s", pack_root, prefix) >= sizeof(dir))
        return;
    DIR *d = opendir(dir);
    if (!d) return;
    struct dirent *de;
    while ((de = readdir(d)) != NULL && *count < 80) {
        const char *name = de->d_name;
        if (!strcmp(name, ".") || !strcmp(name, "..") || name[0] == '.') continue;
        char rel[PATH_MAX], full[PATH_MAX];
        if ((size_t)snprintf(rel, sizeof(rel), "%s/%s", prefix, name) >= sizeof(rel))
            continue;
        if ((size_t)snprintf(full, sizeof(full), "%s/%s", pack_root, rel) >= sizeof(full))
            continue;
        struct stat st;
        if (lstat(full, &st) != 0) continue;
        if (S_ISDIR(st.st_mode)) {
            design_pack_inventory_append_dir(pack_root, rel, out, count);
        } else if (S_ISREG(st.st_mode) || S_ISLNK(st.st_mode)) {
            design_pack_inventory_append_file(out, rel, count);
        }
    }
    closedir(d);
}

static void design_pack_append_inventory(design_buf *out, const char *pack_root) {
    if (!pack_root || !pack_root[0]) return;
    design_buf inv = {0};
    int count = 0;
    char example[PATH_MAX];
    if ((size_t)snprintf(example, sizeof(example), "%s/example.html", pack_root) < sizeof(example) &&
        access(example, R_OK) == 0)
        design_pack_inventory_append_file(&inv, "example.html", &count);
    design_pack_inventory_append_dir(pack_root, "assets", &inv, &count);
    design_pack_inventory_append_dir(pack_root, "references", &inv, &count);
    design_pack_inventory_append_dir(pack_root, "scripts", &inv, &count);
    if (!count) {
        free(inv.ptr);
        return;
    }
    buf_puts(out, "\n\n---\n[ds4-design pack files]\n");
    buf_puts(out, "Use pack_file(type,name,path) to load these on demand: ");
    buf_puts(out, inv.ptr);
    if (count >= 80) buf_puts(out, " ...");
    buf_puts(out, "\n");
    free(inv.ptr);
}

static char *design_tool_pack(const design_tool_call *call, const char *subdir,
                              const char *file, int allow_user) {
    const char *name = tool_arg_value(call, "name");
    if (!design_pack_name_ok(name)) return tool_error("name must be a simple id (a-z, 0-9, -)");
    char path[2300];
    char pack_root[2300] = "";
    char *body = NULL;
    bool body_truncated = false;
    const size_t skill_cap = 24 * 1024;
    const size_t pack_cap = 24 * 1024;
    const size_t craft_cap = 12 * 1024;
    if (allow_user) {  /* a user-authored skill overrides / extends the shipped library */
        const char *u = getenv("DS4UI_USER_SKILLS_DIR");
        if (u && u[0]) {
            snprintf(path, sizeof path, "%s/%s/SKILL.md", u, name);
            body = design_read_file_buf_limit(path, skill_cap, &body_truncated);
            if (body) snprintf(pack_root, sizeof(pack_root), "%s/%s", u, name);
        }
    }
    if (!body) {
        const char *root = getenv("DS4UI_SKILLS_DIR");
        if (root && root[0]) {
            snprintf(path, sizeof path, "%s/%s/%s/%s", root, subdir, name, file);
            body = design_read_file_buf_limit(path,
                                              !strcmp(subdir, "skills") ? skill_cap : pack_cap,
                                              &body_truncated);
            if (body) snprintf(pack_root, sizeof(pack_root), "%s/%s/%s", root, subdir, name);
        }
    }
    if (!body && !strcmp(subdir, "skills")) {
        const char *root = getenv("DS4UI_CYBER_SKILLS_DIR");
        if (root && root[0]) {
            snprintf(path, sizeof path, "%s/%s/%s", root, name, file);
            body = design_read_file_buf_limit(path, skill_cap, &body_truncated);
            if (body) snprintf(pack_root, sizeof(pack_root), "%s/%s", root, name);
        }
    }
    if (!body) {
        design_buf e = {0};
        buf_puts(&e, "Tool error: no such pack: ");
        buf_puts(&e, name);
        buf_puts(&e, "\n");
        return buf_take(&e);
    }
    design_buf out = {0};
    buf_puts(&out, body);
    design_pack_append_truncation_note(&out, name, body_truncated,
                                       !strcmp(subdir, "skills") ? skill_cap : pack_cap);
    design_pack_append_inventory(&out, pack_root);

    if (!strcmp(subdir, "skills")) {
        design_string_list crafts = {0};
        design_pack_collect_craft_requires(body, &crafts);
        if (crafts.len) {
            buf_puts(&out, "\n\n---\n[ds4-design skill metadata]\n");
            buf_puts(&out, "Auto-loaded craft.requires:");
            for (int i = 0; i < crafts.len; i++) {
                buf_puts(&out, i ? ", " : " ");
                buf_puts(&out, crafts.v[i]);
            }
            buf_puts(&out, "\n");
            const char *root = getenv("DS4UI_SKILLS_DIR");
            for (int i = 0; root && root[0] && i < crafts.len; i++) {
                char cpath[2300];
                bool trunc = false;
                snprintf(cpath, sizeof(cpath), "%s/craft/%s/CRAFT.md", root, crafts.v[i]);
                char *craft = design_read_file_buf_limit(cpath, craft_cap, &trunc);
                if (!craft) {
                    buf_puts(&out, "\n[missing craft: ");
                    buf_puts(&out, crafts.v[i]);
                    buf_puts(&out, "]\n");
                    continue;
                }
                buf_puts(&out, "\n---\n[auto-loaded craft: ");
                buf_puts(&out, crafts.v[i]);
                buf_puts(&out, "]\n");
                buf_puts(&out, craft);
                design_pack_append_truncation_note(&out, crafts.v[i], trunc, craft_cap);
                free(craft);
            }
        }
        design_string_list_free(&crafts);
    }

    free(body);
    return buf_take(&out);
}

static const char *design_pack_type_subdir(const char *type,
                                           const char **main_file,
                                           int *allow_user) {
    if (!type) return NULL;
    if (!strcmp(type, "skill")) {
        if (main_file) *main_file = "SKILL.md";
        if (allow_user) *allow_user = 1;
        return "skills";
    }
    if (!strcmp(type, "design_system")) {
        if (main_file) *main_file = "DESIGN.md";
        if (allow_user) *allow_user = 0;
        return "design-systems";
    }
    if (!strcmp(type, "craft")) {
        if (main_file) *main_file = "CRAFT.md";
        if (allow_user) *allow_user = 0;
        return "craft";
    }
    return NULL;
}

static char *design_tool_pack_file(const design_tool_call *call) {
    const char *type = tool_arg_value(call, "type");
    const char *name = tool_arg_value(call, "name");
    const char *rel = tool_arg_value(call, "path");
    const char *main_file = NULL;
    int allow_user = 0;
    const char *subdir = design_pack_type_subdir(type, &main_file, &allow_user);
    (void)main_file;
    if (!subdir) return tool_error("type must be skill, design_system, or craft");
    if (!design_pack_name_ok(name)) return tool_error("name must be a simple id (a-z, 0-9, -)");
    char err[256] = {0};
    if (!design_pack_file_rel_ok(rel, err, sizeof(err))) return tool_error(err);

    char pack_root[2300], full[PATH_MAX];
    bool found = false;
    if (allow_user) {
        const char *u = getenv("DS4UI_USER_SKILLS_DIR");
        if (u && u[0]) {
            snprintf(pack_root, sizeof(pack_root), "%s/%s", u, name);
            found = design_pack_resolve_existing_file(pack_root, rel, full, sizeof(full),
                                                      err, sizeof(err));
        }
    }
    if (!found) {
        const char *root = getenv("DS4UI_SKILLS_DIR");
        if (root && root[0]) {
            snprintf(pack_root, sizeof(pack_root), "%s/%s/%s", root, subdir, name);
            found = design_pack_resolve_existing_file(pack_root, rel, full, sizeof(full),
                                                      err, sizeof(err));
        }
    }
    if (!found && !strcmp(subdir, "skills")) {
        const char *root = getenv("DS4UI_CYBER_SKILLS_DIR");
        if (root && root[0]) {
            snprintf(pack_root, sizeof(pack_root), "%s/%s", root, name);
            found = design_pack_resolve_existing_file(pack_root, rel, full, sizeof(full),
                                                      err, sizeof(err));
        }
    }
    if (!found) return tool_error(err[0] ? err : "pack_file not found");

    bool truncated = false;
    size_t cap = design_pack_file_cap(rel);
    char *body = design_read_file_buf_limit(full, cap, &truncated);
    if (!body) return tool_error("pack_file could not be read");
    design_buf out = {0};
    buf_puts(&out, "[ds4-design pack_file: ");
    buf_puts(&out, type);
    buf_puts(&out, "/");
    buf_puts(&out, name);
    buf_puts(&out, "/");
    buf_puts(&out, rel);
    buf_puts(&out, "]\n");
    buf_puts(&out, body);
    design_pack_append_truncation_note(&out, rel, truncated, cap);
    free(body);
    return buf_take(&out);
}

/* ---- post-write design check ----------------------------------------------------
 * After a write/edit of an HTML file, scan it for the P0 anti-slop / accessibility
 * gates from the skill checklist and append any findings to the tool result, so the
 * model fixes them in the SAME turn instead of shipping them to artifact. Cheap,
 * heuristic, and conservative (no false-positive on good typography). */
static void dv_utf8_next(const char *s, size_t n, size_t *i, unsigned *cp) {
    unsigned char c = (unsigned char)s[*i];
    if (c < 0x80) { *cp = c; *i += 1; }
    else if ((c >> 5) == 0x6 && *i + 1 < n) { *cp = ((c & 0x1Fu) << 6) | (s[*i+1] & 0x3F); *i += 2; }
    else if ((c >> 4) == 0xE && *i + 2 < n) { *cp = ((c & 0x0Fu) << 12) | ((s[*i+1] & 0x3F) << 6) | (s[*i+2] & 0x3F); *i += 3; }
    else if ((c >> 3) == 0x1E && *i + 3 < n) { *cp = ((c & 0x07u) << 18) | ((s[*i+1] & 0x3F) << 12) | ((s[*i+2] & 0x3F) << 6) | (s[*i+3] & 0x3F); *i += 4; }
    else { *cp = c; *i += 1; }
}
/* Pictographic emoji ranges only — excludes typographic punctuation, basic arrows
 * (U+2190..21FF) and dashes, so good design isn't flagged. */
static int dv_is_emoji(unsigned cp) {
    return (cp >= 0x1F000 && cp <= 0x1FFFF) || (cp >= 0x2600 && cp <= 0x26FF) ||
           (cp >= 0x2B00 && cp <= 0x2BFF) || cp == 0xFE0F;
}
static int dv_ci_contains(const char *hay, const char *needle) {
    size_t nl = strlen(needle);
    for (const char *p = hay; *p; p++) {
        size_t k = 0;
        while (k < nl && p[k] && tolower((unsigned char)p[k]) == tolower((unsigned char)needle[k])) k++;
        if (k == nl) return 1;
    }
    return 0;
}

static const char *dv_ci_find(const char *hay, const char *needle) {
    size_t nl = strlen(needle);
    if (!nl) return hay;
    for (const char *p = hay; *p; p++) {
        size_t k = 0;
        while (k < nl && p[k] &&
               tolower((unsigned char)p[k]) == tolower((unsigned char)needle[k])) k++;
        if (k == nl) return p;
    }
    return NULL;
}

static bool html_title_nonempty(const char *body) {
    const char *p = dv_ci_find(body, "<title");
    if (!p) return false;
    p = strchr(p, '>');
    if (!p) return false;
    p++;
    const char *end = dv_ci_find(p, "</title>");
    if (!end) return false;
    while (p < end) {
        if (!isspace((unsigned char)*p)) return true;
        p++;
    }
    return false;
}

static bool html_ref_ignored(const char *ref) {
    if (!ref || !ref[0]) return true;
    if (ref[0] == '#') return true;
    if (!strncasecmp(ref, "http:", 5) || !strncasecmp(ref, "https:", 6) ||
        !strncasecmp(ref, "data:", 5) || !strncasecmp(ref, "mailto:", 7) ||
        !strncasecmp(ref, "tel:", 4) || !strncasecmp(ref, "blob:", 5) ||
        !strncasecmp(ref, "javascript:", 11) || !strncmp(ref, "//", 2))
        return true;
    return false;
}

static char *html_ref_path_part(const char *ref) {
    size_t n = 0;
    while (ref[n] && ref[n] != '#' && ref[n] != '?') n++;
    return xstrndup(ref, n);
}

static bool entry_relative_path(const char *entry, const char *ref,
                                char *out, size_t outsz) {
    const char *slash = strrchr(entry, '/');
    int n;
    if (slash) {
        size_t dir_len = (size_t)(slash - entry);
        n = snprintf(out, outsz, "%.*s/%s", (int)dir_len, entry, ref);
    } else {
        n = snprintf(out, outsz, "%s", ref);
    }
    return n >= 0 && (size_t)n < outsz;
}

static void artifact_check_attr_refs(design_project *pr, const char *entry,
                                     const char *body, const char *attr,
                                     design_check_report *report) {
    const char *p = body;
    char needle[16];
    snprintf(needle, sizeof(needle), "%s=", attr);
    while ((p = dv_ci_find(p, needle)) != NULL) {
        p += strlen(needle);
        while (*p == ' ' || *p == '\t' || *p == '\n' || *p == '\r') p++;
        char quote = 0;
        if (*p == '"' || *p == '\'') quote = *p++;
        const char *start = p;
        if (quote) {
            while (*p && *p != quote) p++;
        } else {
            while (*p && !isspace((unsigned char)*p) && *p != '>') p++;
        }
        if (p == start) continue;
        char *ref = xstrndup(start, (size_t)(p - start));
        if (!html_ref_ignored(ref)) {
            if (ref[0] == '/') {
                design_check_add(report, "P0",
                                 "%s uses root-relative asset %s; use project-relative paths",
                                 attr, ref);
            } else {
                char *part = html_ref_path_part(ref);
                if (part[0]) {
                    char rel[PATH_MAX], full[PATH_MAX], err[256];
                    if (!entry_relative_path(entry, part, rel, sizeof(rel)) ||
                        !project_resolve(pr, rel, full, sizeof(full), err, sizeof(err)) ||
                        access(full, R_OK) != 0)
                    {
                        design_check_add(report, "P0",
                                         "%s references missing local asset %s", attr, ref);
                    }
                }
                free(part);
            }
        }
        free(ref);
        if (quote && *p == quote) p++;
    }
}

static size_t design_count_ci_substr(const char *hay, const char *needle) {
    size_t count = 0;
    const char *p = hay;
    size_t nl = strlen(needle);
    if (!nl) return 0;
    while ((p = dv_ci_find(p, needle)) != NULL) {
        count++;
        p += nl;
    }
    return count;
}

static size_t design_count_css_hex_colors(const char *body) {
    size_t count = 0;
    for (const char *p = body; *p; p++) {
        if (*p != '#') continue;
        int n = 0;
        const char *q = p + 1;
        while (isxdigit((unsigned char)*q) && n < 8) {
            q++;
            n++;
        }
        if (n == 3 || n == 4 || n == 6 || n == 8) {
            count++;
            p = q - 1;
        }
    }
    return count;
}

static bool design_has_pictographic_emoji(const char *body, size_t *count) {
    size_t n = strlen(body);
    size_t i = 0, c = 0;
    while (i < n) {
        unsigned cp = 0;
        dv_utf8_next(body, n, &i, &cp);
        if (dv_is_emoji(cp)) c++;
    }
    if (count) *count = c;
    return c > 0;
}

static bool design_has_any_ci(const char *body, const char **needles) {
    for (int i = 0; needles[i]; i++) {
        if (dv_ci_contains(body, needles[i])) return true;
    }
    return false;
}

static bool design_span_ci_contains(const char *start, const char *end,
                                    const char *needle) {
    size_t nl = strlen(needle);
    if (!nl || end <= start) return false;
    for (const char *p = start; p + nl <= end; p++) {
        size_t k = 0;
        while (k < nl &&
               tolower((unsigned char)p[k]) == tolower((unsigned char)needle[k]))
            k++;
        if (k == nl) return true;
    }
    return false;
}

static bool design_has_any_ci_in_gradient(const char *body, const char **needles) {
    const char *p = body;
    while ((p = dv_ci_find(p, "linear-gradient(")) != NULL) {
        const char *end = strchr(p, ')');
        if (!end) end = p + strlen(p);
        for (int i = 0; needles[i]; i++) {
            if (design_span_ci_contains(p, end, needles[i])) return true;
        }
        p = end;
    }
    return false;
}

static bool design_has_trust_gradient(const char *body) {
    static const char *blue[] = {
        "#3b82f6", "#2563eb", "#1d4ed8", "#1e40af", "#1e3a8a",
        "#60a5fa", "#93c5fd", "#bfdbfe", "#0ea5e9", "#0284c7",
        "#0369a1", "#38bdf8", "#7dd3fc", "blue", "sky", NULL
    };
    static const char *cyan[] = {
        "#06b6d4", "#0891b2", "#0e7490", "#155e75", "#164e63",
        "#22d3ee", "#67e8f9", "#a5f3fc", "cyan", NULL
    };
    const char *p = body;
    while ((p = dv_ci_find(p, "linear-gradient(")) != NULL) {
        const char *end = strchr(p, ')');
        if (!end) end = p + strlen(p);
        bool has_blue = false, has_cyan = false;
        for (int i = 0; blue[i]; i++)
            if (design_span_ci_contains(p, end, blue[i])) has_blue = true;
        for (int i = 0; cyan[i]; i++)
            if (design_span_ci_contains(p, end, cyan[i])) has_cyan = true;
        if (has_blue && has_cyan) return true;
        p = end;
    }
    return false;
}

static bool design_hex_outside_global_token_scope(const char *body, const char *hex) {
    const char *p = body;
    while ((p = dv_ci_find(p, hex)) != NULL) {
        const char *brace = p;
        while (brace > body && *brace != '{' && *brace != '}') brace--;
        if (*brace != '{') return true;
        const char *sel = brace;
        while (sel > body && sel[-1] != '}') sel--;
        bool global = design_span_ci_contains(sel, brace, ":root") ||
                      design_span_ci_contains(sel, brace, "[data-theme") ||
                      design_span_ci_contains(sel, brace, "html");
        if (!global) return true;
        p += strlen(hex);
    }
    return false;
}

static bool design_has_sans_display_rule(const char *body) {
    static const char *selectors[] = { "h1", "h2", "h3", ".hero", ".headline", ".display", NULL };
    static const char *faces[] = { "Inter", "Roboto", "Arial", "-apple-system", "system-ui", "SF Pro", NULL };
    const char *p = body;
    while ((p = strchr(p, '{')) != NULL) {
        const char *sel = p;
        while (sel > body && sel[-1] != '}') sel--;
        const char *end = strchr(p, '}');
        if (!end) return false;
        bool display_selector = false;
        for (int i = 0; selectors[i]; i++) {
            if (design_span_ci_contains(sel, p, selectors[i])) display_selector = true;
        }
        if (display_selector && design_span_ci_contains(p, end, "font-family")) {
            for (int i = 0; faces[i]; i++) {
                if (design_span_ci_contains(p, end, faces[i])) return true;
            }
        }
        p = end + 1;
    }
    return false;
}

static void design_artifact_quality_lint(const char *body,
                                         design_check_report *report) {
    size_t emoji_count = 0;
    if (design_has_pictographic_emoji(body, &emoji_count))
        design_check_add(report, "P0",
                         "pictographic emoji used as product icons/content (%zu found); use text or inline SVG",
                         emoji_count);

    static const char *purple_defaults[] = {
        "#6366f1", "#8b5cf6", "#a855f7", "#7c3aed", "indigo", "violet", "purple", NULL
    };
    if (design_has_any_ci_in_gradient(body, purple_defaults))
        design_check_add(report, "P0",
                         "generic purple/indigo gradient treatment detected; bind a brief-specific palette instead");

    if (design_has_trust_gradient(body))
        design_check_add(report, "P0",
                         "blue-to-cyan trust gradient detected; use a brief-specific single accent or flat surface");

    static const char *ai_indigo[] = {
        "#6366f1", "#4f46e5", "#4338ca", "#3730a3",
        "#8b5cf6", "#7c3aed", "#a855f7", NULL
    };
    for (int i = 0; ai_indigo[i]; i++) {
        if (design_hex_outside_global_token_scope(body, ai_indigo[i])) {
            design_check_add(report, "P0",
                             "default Tailwind indigo/purple accent detected outside global tokens");
            break;
        }
    }

    if (dv_ci_contains(body, "border-left") &&
        dv_ci_contains(body, "border-radius") &&
        (dv_ci_contains(body, "card") || dv_ci_contains(body, "panel")))
        design_check_add(report, "P0",
                         "rounded card/panel with a left accent border detected; replace the template-card pattern");

    static const char *invented_metrics[] = {
        "10x faster", "10× faster", "99.9%", "zero downtime",
        "100x faster", "100× faster", "3x more", "3× more",
        "millions of users", "trusted by thousands", NULL
    };
    if (design_has_any_ci(body, invented_metrics))
        design_check_add(report, "P0",
                         "unsupported marketing metric/claim detected; remove it or source it from the brief");

    if (design_has_sans_display_rule(body))
        design_check_add(report, "P0",
                         "display heading rule uses a generic sans face; use the pack/design-system display face");

    static const char *deck_placeholders[] = {
        "Name to confirm", "$X.XM", "Replace this panel with",
        "Replace role placeholders", "Your form answer only said", NULL
    };
    if (design_has_any_ci(body, deck_placeholders))
        design_check_add(report, "P0",
                         "unresolved deck/template placeholder remains");

    if (dv_ci_contains(body, "@keyframes") || dv_ci_contains(body, "animation:")) {
        if (!dv_ci_contains(body, "prefers-reduced-motion"))
            design_check_add(report, "P1",
                             "motion is present without a prefers-reduced-motion override");
    }

    if ((dv_ci_contains(body, "<button") || dv_ci_contains(body, "<input") ||
         dv_ci_contains(body, "<select") || dv_ci_contains(body, "<textarea")) &&
        !dv_ci_contains(body, ":focus-visible"))
        design_check_add(report, "P1",
                         "interactive controls should define a visible :focus-visible state");

    if ((dv_ci_contains(body, "<form") || dv_ci_contains(body, "<table") ||
         dv_ci_contains(body, "dashboard") || dv_ci_contains(body, "data-")) &&
        (!dv_ci_contains(body, "loading") || !dv_ci_contains(body, "empty") ||
         !dv_ci_contains(body, "error")))
        design_check_add(report, "P1",
                         "data/input surface should cover loading, empty, error, populated, and edge states");

    size_t accent_refs = design_count_ci_substr(body, "var(--accent");
    if (accent_refs > 8)
        design_check_add(report, "P1",
                         "accent token appears %zu times; accent usage should be intentionally scarce",
                         accent_refs);

    size_t raw_hex = design_count_css_hex_colors(body);
    if (raw_hex > 16)
        design_check_add(report, "P2",
                         "%zu raw hex colors found; prefer a small :root token set",
                         raw_hex);

    if (dv_ci_contains(body, "blob") || dv_ci_contains(body, "bokeh") ||
        dv_ci_contains(body, "gradient-orb") || dv_ci_contains(body, "orb-"))
        design_check_add(report, "P2",
                         "decorative blob/orb/bokeh naming detected; remove generic decorative effects");
}

static bool design_artifact_check(design_project *pr, const char *entry,
                                  design_check_report *report) {
    char full[PATH_MAX], err[256];
    if (!project_resolve(pr, entry, full, sizeof(full), err, sizeof(err))) {
        design_check_add(report, "P0", "%s", err);
        return false;
    }
    char *body = NULL;
    size_t len = 0;
    if (read_file_bytes(full, &body, &len, err, sizeof(err)) != 0) {
        design_check_add(report, "P0", "cannot read entry: %s", err);
        return false;
    }
    (void)len;
    const char *ext = design_ext(entry);
    bool is_html = !strcasecmp(ext, ".html") || !strcasecmp(ext, ".htm");
    if (!is_html) {
        free(body);
        return report->errors == 0;
    }

    if (!dv_ci_contains(body, "<!doctype") && !dv_ci_contains(body, "<html"))
        design_check_add(report, "P0", "HTML entry needs <!doctype> or <html>");
    if (!dv_ci_contains(body, "name=\"viewport\"") &&
        !dv_ci_contains(body, "name='viewport'") &&
        !dv_ci_contains(body, "name=viewport"))
        design_check_add(report, "P0", "HTML entry needs a viewport meta tag");
    if (!html_title_nonempty(body))
        design_check_add(report, "P0", "HTML entry needs a non-empty <title>");

    static const char *placeholders[] = {
        "lorem ipsum", "[replace]", "placeholder", "placeholder text",
        "your text here", "sample content", "tbd", "your company",
        "feature one", "feature two", "feature three", "item one",
        "john doe", "jane doe", "acme", NULL
    };
    for (int i = 0; placeholders[i]; i++) {
        if (dv_ci_contains(body, placeholders[i])) {
            design_check_add(report, "P0",
                             "placeholder copy remains: \"%s\"", placeholders[i]);
            break;
        }
    }
    if (strstr(body, "TODO") || strstr(body, "FIXME"))
        design_check_add(report, "P0", "developer placeholder marker remains (TODO/FIXME)");

    artifact_check_attr_refs(pr, entry, body, "src", report);
    artifact_check_attr_refs(pr, entry, body, "href", report);
    design_artifact_quality_lint(body, report);

    if (!dv_ci_contains(body, ":root"))
        design_check_add(report, "P1", "no :root design tokens found");
    if (!dv_ci_contains(body, "@media") && !dv_ci_contains(body, "@container") &&
        !dv_ci_contains(body, "clamp(") && !dv_ci_contains(body, "container-type"))
        design_check_add(report, "P1",
                         "no obvious responsive rule found (@media/@container/clamp)");
    if (strstr(body, "100vh"))
        design_check_add(report, "P1", "100vh found; prefer 100dvh in embedded previews");

    free(body);
    return report->errors == 0;
}
/* The integer oklch lightness (%) of a CSS custom property's definition, or -1. */
static int dv_oklch_l(const char *content, const char *var) {
    char key[48];
    snprintf(key, sizeof key, "%s:", var);
    const char *p = strstr(content, key);
    if (!p) return -1;
    p += strlen(key);
    const char *semi = strchr(p, ';');
    const char *q = strstr(p, "oklch(");
    if (!q || (semi && q > semi)) return -1;
    q += 6;
    while (*q == ' ') q++;
    if (*q < '0' || *q > '9') return -1;
    return atoi(q);
}
static char *design_verify_after(design_project *pr, const design_tool_call *call, char *result) {
    if (!result || !strncmp(result, "Tool error", 10)) return result;
    const char *path = tool_arg_value(call, "path");
    if (!path) return result;
    size_t pl = strlen(path);
    int is_html = (pl >= 5 && !strcmp(path + pl - 5, ".html")) || (pl >= 4 && !strcmp(path + pl - 4, ".htm"));
    if (!is_html) return result;
    if (design_project_invalidate_critique(pr, path))
        design_write_state(pr);
    char full[PATH_MAX], err[256];
    if (!project_resolve(pr, path, full, sizeof(full), err, sizeof(err))) return result;
    char *body = design_read_file_buf(full);
    if (!body) return result;
    size_t n = strlen(body);

    design_buf issues = {0};

    /* 1. emoji used as icons / content */
    size_t i = 0, emo = 0, exo = 0; char ex[48]; ex[0] = '\0';
    while (i < n) {
        size_t start = i; unsigned cp; dv_utf8_next(body, n, &i, &cp);
        if (dv_is_emoji(cp)) {
            emo++;
            size_t blen = i - start;
            if (emo <= 4 && exo + blen + 2 < sizeof ex) { memcpy(ex + exo, body + start, blen); exo += blen; ex[exo++] = ' '; ex[exo] = '\0'; }
        }
    }
    if (emo) {
        char line[160];
        snprintf(line, sizeof line, "- emoji used as icons/content (%zu found: %s...). The brief forbids emoji as icons \xe2\x80\x94 use inline SVG or text.\n", emo, ex);
        buf_puts(&issues, line);
    }

    /* 2. placeholder copy */
    static const char *ph[] = { "lorem ipsum", "lorem", "[replace]", "feature one", "feature two", "your text here", "placeholder text", "tbd", NULL };
    for (int k = 0; ph[k]; k++) {
        if (dv_ci_contains(body, ph[k])) {
            char line[160];
            snprintf(line, sizeof line, "- placeholder text found (\"%s\") \xe2\x80\x94 replace with real, specific copy.\n", ph[k]);
            buf_puts(&issues, line);
            break;
        }
    }

    /* 3. 100vh (use 100dvh) */
    if (strstr(body, "100vh"))
        buf_puts(&issues, "- 100vh used \xe2\x80\x94 use 100dvh (100vh jumps with the mobile address bar).\n");

    /* 4. muted body/secondary text likely below WCAG 4.5:1 on a light theme */
    int bgL = dv_oklch_l(body, "--bg"); if (bgL < 0) bgL = dv_oklch_l(body, "--background");
    int light = (bgL >= 85) || strstr(body, "#fff") || strstr(body, "#fafafa");
    static const char *mvars[] = { "--muted", "--text-muted", "--muted-fg", "--fg-muted", "--secondary", "--text-2", "--text-secondary", NULL };
    for (int k = 0; light && mvars[k]; k++) {
        int L = dv_oklch_l(body, mvars[k]);
        if (L < 50 || L > 74) continue;
        char p1[56], p2[56];
        snprintf(p1, sizeof p1, "color:var(%s)", mvars[k]);
        snprintf(p2, sizeof p2, "color: var(%s)", mvars[k]);
        if (strstr(body, p1) || strstr(body, p2)) {
            char line[200];
            snprintf(line, sizeof line, "- %s is oklch ~%d%% used for text on a light background \xe2\x80\x94 likely below WCAG 4.5:1; darken it (aim L<=50%%).\n", mvars[k], L);
            buf_puts(&issues, line);
            break;
        }
    }

    free(body);
    if (!issues.len) { if (issues.ptr) free(issues.ptr); return result; }
    char *iss = buf_take(&issues);
    design_buf out = {0};
    buf_puts(&out, result);
    if (result[0] && result[strlen(result) - 1] != '\n') buf_puts(&out, "\n");
    buf_puts(&out, "[design check] Before you call artifact, fix these P0 gate issues in ");
    buf_puts(&out, path);
    buf_puts(&out, ":\n");
    buf_puts(&out, iss);
    free(iss); free(result);
    return buf_take(&out);
}

static char *execute_tool_call(design_project *pr, const design_tool_call *call) {
    const char *name = call->name ? call->name : "";
    if (!strcmp(name, "skill")) return design_tool_pack(call, "skills", "SKILL.md", 1);
    if (!strcmp(name, "design_system")) return design_tool_pack(call, "design-systems", "DESIGN.md", 0);
    if (!strcmp(name, "craft")) return design_tool_pack(call, "craft", "CRAFT.md", 0);
    if (!strcmp(name, "pack_file")) return design_tool_pack_file(call);
    if (!strcmp(name, "write")) return design_verify_after(pr, call, tool_write(pr, call));
    if (!strcmp(name, "edit")) return design_verify_after(pr, call, tool_edit(pr, call));
    if (!strcmp(name, "read")) return tool_read(pr, call);
    if (!strcmp(name, "more")) return design_tool_more(pr, call);
    if (!strcmp(name, "search")) return design_tool_search(pr, call);
    if (!strcmp(name, "list")) return tool_list(pr, call);
    if (!strcmp(name, "todo_write")) return tool_todo_write(pr, call);
    if (!strcmp(name, "question")) return tool_question(pr, call);
    if (!strcmp(name, "verify_artifact")) return tool_verify_artifact(pr, call);
    if (!strcmp(name, "critique_write")) return tool_critique_write(pr, call);
    if (!strcmp(name, "artifact")) return tool_artifact(pr, call);
    if (!strcmp(name, "propose")) return tool_propose(pr, call);
    if (!strcmp(name, "google_search")) return design_tool_google_search(pr, call);
    if (!strcmp(name, "visit_page")) return design_tool_visit_page(pr, call);

    if (!strcmp(name, "bash")) {
        const char *cmd = tool_arg_value(call, "command");
        if (!cmd || !cmd[0]) return tool_error("bash requires command");
        int timeout = design_parse_timeout(tool_arg_value(call, "timeout_sec"));
        int refresh = design_parse_int_default(tool_arg_value(call, "refresh_sec"),
                                               60, 1, 600);
        char err[160] = {0};
        design_bash_job *job = design_bash_start(pr, cmd, timeout, err, sizeof(err));
        if (!job) {
            design_buf b = {0};
            buf_puts(&b, "Tool error: bash failed to start: ");
            buf_puts(&b, err[0] ? err : "unknown error");
            buf_puts(&b, "\n");
            return buf_take(&b);
        }
        return design_bash_job_tool_result(job, true, refresh, false);
    }
    if (!strcmp(name, "bash_status") || !strcmp(name, "bash_stop")) {
        int job_id = design_parse_int_default(tool_arg_value(call, "job"), 0, 0, INT_MAX);
        pid_t pid = (pid_t)design_parse_int_default(tool_arg_value(call, "pid"), 0, 0, INT_MAX);
        design_bash_job *job = design_bash_find_job(pr, job_id, pid);
        if (!job) {
            char msg[128];
            snprintf(msg, sizeof(msg), "bash job not found: job=%d pid=%ld",
                     job_id, (long)pid);
            return tool_error(msg);
        }
        int refresh = design_parse_int_default(tool_arg_value(call, "refresh_sec"),
                                               60, 1, 600);
        bool stop = !strcmp(name, "bash_stop");
        return design_bash_job_tool_result(job, stop, refresh, stop);
    }

    design_buf b = {0};
    buf_puts(&b, "Tool error: unknown tool: ");
    buf_puts(&b, name);
    buf_puts(&b, ". Available tools: todo_write, question, write, edit, read, more, search, "
                 "list, verify_artifact, critique_write, artifact, propose, skill, design_system, craft, "
                 "pack_file, google_search, visit_page, bash, "
                 "bash_status, bash_stop.\n");
    return buf_take(&b);
}

static bool design_tool_allowed_before_discovery(const char *name) {
    if (!name) return false;
    return !strcmp(name, "skill") ||
           !strcmp(name, "design_system") ||
           !strcmp(name, "craft") ||
           !strcmp(name, "pack_file") ||
           !strcmp(name, "question");
}

static bool design_discovery_gate_active(const design_project *pr) {
    return pr && !pr->discovery_satisfied && !pr->current_artifact_entry[0];
}

static char *design_discovery_gate_result(const char *name) {
    design_buf b = {0};
    buf_puts(&b, "Tool error: discovery question required before building. Blocked tool: ");
    buf_puts(&b, name && name[0] ? name : "unknown");
    buf_puts(&b, ". Emit one short line plus a <question-form> block, or call question(), then stop and wait for the user's answer. ");
    buf_puts(&b, "Allowed before discovery: skill, design_system, craft, pack_file, question.\n");
    return buf_take(&b);
}

static void design_log_tool_result(design_project *pr, const char *name,
                                   const char *res) {
    design_buf ev = {0};
    buf_puts(&ev, "{\"name\":\"");
    json_escape_buf(&ev, name ? name : "", name ? strlen(name) : 0);
    buf_puts(&ev, "\",\"ok\":");
    buf_puts(&ev, res && strncmp(res, "Tool error", 10) ? "true" : "false");
    buf_puts(&ev, ",\"bytes\":");
    char n[32];
    snprintf(n, sizeof(n), "%zu", res ? strlen(res) : 0);
    buf_puts(&ev, n);
    buf_puts(&ev, "}");
    design_event_log(pr, "tool_result", ev.ptr);
    free(ev.ptr);
}

static char *execute_tool_calls(design_project *pr, const design_tool_calls *calls) {
    design_buf all = {0};
    for (int i = 0; i < calls->len; i++) {
        emit_tool_call_event(&calls->v[i]);
        {
            design_buf ev = {0};
            buf_puts(&ev, "{\"name\":\"");
            json_escape_buf(&ev, calls->v[i].name ? calls->v[i].name : "",
                            calls->v[i].name ? strlen(calls->v[i].name) : 0);
            buf_puts(&ev, "\",\"argc\":");
            char n[32];
            snprintf(n, sizeof(n), "%d", calls->v[i].argc);
            buf_puts(&ev, n);
            buf_puts(&ev, "}");
            design_event_log(pr, "tool_call", ev.ptr);
            free(ev.ptr);
        }
        char *res;
        if (design_discovery_gate_active(pr) &&
            !design_tool_allowed_before_discovery(calls->v[i].name))
        {
            res = design_discovery_gate_result(calls->v[i].name);
            design_buf ev = {0};
            buf_puts(&ev, "{\"name\":\"");
            json_escape_buf(&ev, calls->v[i].name ? calls->v[i].name : "",
                            calls->v[i].name ? strlen(calls->v[i].name) : 0);
            buf_puts(&ev, "\",\"reason\":\"discovery_required\"}");
            design_event_log(pr, "discovery_blocked", ev.ptr);
            free(ev.ptr);
        } else {
            res = execute_tool_call(pr, &calls->v[i]);
        }
        emit_tool_result_event(calls->v[i].name, res);
        design_log_tool_result(pr, calls->v[i].name, res);
        char hdr[128];
        snprintf(hdr, sizeof(hdr), "Tool result %d (%s):\n", i + 1,
                 calls->v[i].name ? calls->v[i].name : "unknown");
        buf_puts(&all, hdr);
        buf_puts(&all, res);
        if (res[0] && res[strlen(res) - 1] != '\n') buf_puts(&all, "\n");
        free(res);
    }
    if (calls->len == 0) buf_puts(&all, "Tool error: empty tool call block\n");
    return buf_take(&all);
}

/* ============================================================================
 * System Prompt — DStudio's design prompt stack
 * ============================================================================
 *
 * The composed system prompt (discovery and
 * philosophy hard rules, official designer identity, built-in design
 * directions, anti-AI-slop checklist, artifact rules), with three local
 * deltas: DSML is the tool syntax, there is no web/Bash access, and edits
 * must be anchored because decoding is tens of tokens per second.
 *
 * Trusted DS4 control text: tokenized as rendered chat so the literal
 * ｜DSML｜ markers in the examples become the model's dedicated DSML token
 * (same rule as ds4-agent; never tokenize user -sys text this way).
 */

static const char design_system_prompt[] =
    "You are an expert designer working for the user, who acts as your design "
    "manager. You work in HTML in a project directory: the files you write ARE "
    "the deliverable, and the user sees them rendered live on a full-screen "
    "canvas next to this chat. You design landing pages, dashboards, mobile "
    "app prototypes, slide decks, tools.\n\n"
    "LANGUAGE: write EVERY user-facing output — prose, question-form labels "
    "and options, todo items, proposal names and descriptions, artifact "
    "titles — in the language of the user's LAST message. Their latest "
    "message wins over the earlier conversation: if they switch language, "
    "switch with them. Code, file names and CSS stay in English.\n\n"
    "## Tools\n\n"
    "You have access to native DSML tools. Invoke tools by writing exactly this shape:\n\n"
    "<｜DSML｜tool_calls>\n"
    "<｜DSML｜invoke name=\"$TOOL_NAME\">\n"
    "<｜DSML｜parameter name=\"$PARAMETER_NAME\" string=\"true|false\">$PARAMETER_VALUE</｜DSML｜parameter>\n"
    "</｜DSML｜invoke>\n"
    "</｜DSML｜tool_calls>\n\n"
    "Tool calls are not allowed inside <think></think>; finish thinking before emitting DSML.\n"
    "String parameters use raw text and string=\"true\". Numbers use JSON text and string=\"false\".\n\n"
    "### Available Tool Schemas\n\n"
    "{\"type\":\"function\",\"function\":{\"name\":\"todo_write\","
    "\"description\":\"Replace the plan shown to the user as a live Todos card.\","
    "\"parameters\":{\"type\":\"object\",\"properties\":{"
    "\"todos\":{\"type\":\"string\",\"description\":\"JSON array of todo objects. Use text, content, or step for the label; status must be pending, in_progress, completed, or stopped. The runtime normalizes to {text,status}.\"}},"
    "\"required\":[\"todos\"]}}}\n\n"
    "{\"type\":\"function\",\"function\":{\"name\":\"question\","
    "\"description\":\"Emit a structured question event for the UI. Use when you need the user to choose or clarify, then stop the turn.\","
    "\"parameters\":{\"type\":\"object\",\"properties\":{"
    "\"id\":{\"type\":\"string\"},\"title\":{\"type\":\"string\"},"
    "\"questions\":{\"type\":\"string\",\"description\":\"JSON array of question objects, e.g. {id,label,prompt,type,options}.\"}},"
    "\"required\":[\"id\",\"title\",\"questions\"]}}}\n\n"
    "{\"type\":\"function\",\"function\":{\"name\":\"write\","
    "\"description\":\"Create or overwrite a project file. Paths are relative to the project directory; subdirectories are created as needed.\","
    "\"parameters\":{\"type\":\"object\",\"properties\":{"
    "\"path\":{\"type\":\"string\"},\"content\":{\"type\":\"string\"}},"
    "\"required\":[\"path\",\"content\"]}}}\n\n"
    "{\"type\":\"function\",\"function\":{\"name\":\"edit\","
    "\"description\":\"Replace exactly one old text match in a project file; old may contain one [upto] between a unique head and a unique tail anchor.\","
    "\"parameters\":{\"type\":\"object\",\"properties\":{"
    "\"path\":{\"type\":\"string\"},\"old\":{\"type\":\"string\"},\"new\":{\"type\":\"string\"}},"
    "\"required\":[\"path\",\"old\",\"new\"]}}}\n\n"
    "{\"type\":\"function\",\"function\":{\"name\":\"read\","
    "\"description\":\"Read a project file with line numbers.\","
    "\"parameters\":{\"type\":\"object\",\"properties\":{"
    "\"path\":{\"type\":\"string\"},\"start_line\":{\"type\":\"number\"},\"max_lines\":{\"type\":\"number\"}},"
    "\"required\":[\"path\"]}}}\n\n"
    "{\"type\":\"function\",\"function\":{\"name\":\"more\","
    "\"description\":\"Continue the previous read where it stopped. Use after a read reports it was truncated; no path needed.\","
    "\"parameters\":{\"type\":\"object\",\"properties\":{"
    "\"count\":{\"type\":\"number\",\"description\":\"How many more lines to read (default 200).\"}},"
    "\"required\":[]}}}\n\n"
    "{\"type\":\"function\",\"function\":{\"name\":\"search\","
    "\"description\":\"Search project files for text and return compact matches with line numbers. Paths are relative to the project directory.\","
    "\"parameters\":{\"type\":\"object\",\"properties\":{"
    "\"query\":{\"type\":\"string\",\"description\":\"Text or regex to find.\"},"
    "\"path\":{\"type\":\"string\",\"description\":\"Project-relative file or directory to search (default: whole project).\"},"
    "\"mode\":{\"type\":\"string\",\"description\":\"\\\"regex\\\" for POSIX extended regex; otherwise literal substring.\"},"
    "\"glob\":{\"type\":\"string\",\"description\":\"Only search files whose name or project-relative path matches this glob (e.g. *.css).\"},"
    "\"context\":{\"type\":\"number\",\"description\":\"Lines of context around each match (0-5, default 0).\"},"
    "\"max_results\":{\"type\":\"number\",\"description\":\"Cap on matches returned (1-500, default 50).\"},"
    "\"case_sensitive\":{\"type\":\"boolean\",\"description\":\"Match case (default true).\"}},"
    "\"required\":[\"query\"]}}}\n\n"
    "{\"type\":\"function\",\"function\":{\"name\":\"list\","
    "\"description\":\"List all project files.\","
    "\"parameters\":{\"type\":\"object\",\"properties\":{}}}}\n\n"
    "{\"type\":\"function\",\"function\":{\"name\":\"artifact\","
    "\"description\":\"Register the canonical entry file of this turn's deliverable; the runtime verifies it, requires a passing critique_write for HTML, writes an artifact manifest, and the workspace preview switches to it.\","
    "\"parameters\":{\"type\":\"object\",\"properties\":{"
    "\"entry\":{\"type\":\"string\"},\"title\":{\"type\":\"string\"},"
    "\"kind\":{\"type\":\"string\",\"description\":\"Optional artifact kind: html, markdown-document, svg, deck, mini-app, etc. Inferred from extension if omitted.\"},"
    "\"renderer\":{\"type\":\"string\",\"description\":\"Optional renderer: html, markdown, svg, deck-html, mini-app, etc. Inferred from extension if omitted.\"},"
    "\"exports\":{\"type\":\"string\",\"description\":\"Optional JSON array of export ids: html, pdf, zip, md, svg, txt, jsx, pptx.\"},"
    "\"supporting_files\":{\"type\":\"string\",\"description\":\"Optional JSON array of project-relative supporting files that must already exist.\"},"
    "\"metadata\":{\"type\":\"string\",\"description\":\"Optional JSON object with extra artifact metadata.\"}},"
    "\"required\":[\"entry\",\"title\"]}}}\n\n"
    "{\"type\":\"function\",\"function\":{\"name\":\"verify_artifact\","
    "\"description\":\"Run the deterministic artifact gate without registering the artifact. Use before artifact when you want to inspect failures/warnings explicitly.\","
    "\"parameters\":{\"type\":\"object\",\"properties\":{"
    "\"entry\":{\"type\":\"string\"}},"
    "\"required\":[\"entry\"]}}}\n\n"
    "{\"type\":\"function\",\"function\":{\"name\":\"critique_write\","
    "\"description\":\"Record the mandatory quality critique for a new HTML artifact. artifact() is blocked until the latest critique for the same entry passes.\","
    "\"parameters\":{\"type\":\"object\",\"properties\":{"
    "\"entry\":{\"type\":\"string\"},"
    "\"scores_json\":{\"type\":\"string\",\"description\":\"Flat JSON object with numeric 0-10 role scores: {\\\"critic\\\":8.5,\\\"brand\\\":8,\\\"a11y\\\":8,\\\"copy\\\":8}. Composite weights are critic .4, brand .2, a11y .2, copy .2.\"},"
    "\"must_fixes_json\":{\"type\":\"string\",\"description\":\"JSON array of must-fix strings. Must be [] to pass.\"},"
    "\"decision\":{\"type\":\"string\",\"description\":\"ship only when composite >= 8.0 and no must-fix items; otherwise continue.\"},"
    "\"notes\":{\"type\":\"string\",\"description\":\"Concise private critique notes naming the exact elements behind weak scores.\"}},"
    "\"required\":[\"entry\",\"scores_json\",\"must_fixes_json\",\"decision\"]}}}\n\n"
    "{\"type\":\"function\",\"function\":{\"name\":\"propose\","
    "\"description\":\"Propose 2-3 PARALLEL design directions to compare (each a separate self-contained HTML file you already wrote). The UI shows them side by side; the user picks one to refine. Use ONLY when the user asked you to pick a direction (see RULE 2); otherwise build one design and use artifact.\","
    "\"parameters\":{\"type\":\"object\",\"properties\":{"
    "\"directions\":{\"type\":\"string\",\"description\":\"JSON array of {\\\"entry\\\":\\\"direction-a.html\\\",\\\"tag\\\":\\\"A\\\",\\\"name\\\":\\\"Editorial\\\",\\\"desc\\\":\\\"one-line description\\\"} — each entry file must already exist.\"}},"
    "\"required\":[\"directions\"]}}}\n\n"
    "{\"type\":\"function\",\"function\":{\"name\":\"bash\","
    "\"description\":\"Run a shell command in the project directory. Output is captured; long jobs keep running and are polled with bash_status/bash_stop.\","
    "\"parameters\":{\"type\":\"object\",\"properties\":{"
    "\"command\":{\"type\":\"string\"},"
    "\"timeout_sec\":{\"type\":\"number\",\"description\":\"Kill the job after this many seconds (default 120, max 600).\"},"
    "\"refresh_sec\":{\"type\":\"number\",\"description\":\"Block up to this many seconds waiting for the job before returning a progress observation (default 60).\"}},"
    "\"required\":[\"command\"]}}}\n\n"
    "{\"type\":\"function\",\"function\":{\"name\":\"bash_status\","
    "\"description\":\"Report current status and new output for a running bash job.\","
    "\"parameters\":{\"type\":\"object\",\"properties\":{"
    "\"job\":{\"type\":\"number\"},\"pid\":{\"type\":\"number\"},\"refresh_sec\":{\"type\":\"number\"}},"
    "\"required\":[\"job\"]}}}\n\n"
    "{\"type\":\"function\",\"function\":{\"name\":\"bash_stop\","
    "\"description\":\"Terminate a running bash job and report its final output.\","
    "\"parameters\":{\"type\":\"object\",\"properties\":{"
    "\"job\":{\"type\":\"number\"},\"pid\":{\"type\":\"number\"},\"refresh_sec\":{\"type\":\"number\"}},"
    "\"required\":[\"job\"]}}}\n\n"
    "{\"type\":\"function\",\"function\":{\"name\":\"google_search\","
    "\"description\":\"Search Google in a real browser and return compact Markdown result links. Use it to find references, docs, or inspiration.\","
    "\"parameters\":{\"type\":\"object\",\"properties\":{"
    "\"query\":{\"type\":\"string\"}},"
    "\"required\":[\"query\"]}}}\n\n"
    "{\"type\":\"function\",\"function\":{\"name\":\"visit_page\","
    "\"description\":\"Open a URL in a real browser and return the rendered page as Markdown (head only if long).\","
    "\"parameters\":{\"type\":\"object\",\"properties\":{"
    "\"url\":{\"type\":\"string\"}},"
    "\"required\":[\"url\"]}}}\n\n"
    "{\"type\":\"function\",\"function\":{\"name\":\"skill\","
    "\"description\":\"Load a SKILL pack — a focused recipe (layout patterns + a checklist) for one kind of output. Call it BEFORE building when a skill fits the brief, then treat its checklist as gates. The available skill ids are listed in the system context.\","
    "\"parameters\":{\"type\":\"object\",\"properties\":{"
    "\"name\":{\"type\":\"string\",\"description\":\"The skill id, e.g. landing-page.\"}},"
    "\"required\":[\"name\"]}}}\n\n"
    "{\"type\":\"function\",\"function\":{\"name\":\"design_system\","
    "\"description\":\"Load a DESIGN-SYSTEM (brand) pack — color tokens, typography, components, motion, voice, anti-patterns. Call it BEFORE building to lock the look, then bind its tokens. The available design-system ids are listed in the system context.\","
    "\"parameters\":{\"type\":\"object\",\"properties\":{"
    "\"name\":{\"type\":\"string\",\"description\":\"The design-system id, e.g. linear.\"}},"
    "\"required\":[\"name\"]}}}\n\n"
    "{\"type\":\"function\",\"function\":{\"name\":\"craft\","
    "\"description\":\"Load a CRAFT rules pack — universal, brand-agnostic standards (accessibility, anti-slop, color, typography, state-coverage, motion, and layout-responsive). Load the relevant ones for the task; ALWAYS load layout-responsive before resizing/restructuring and accessibility before shipping. The available craft ids are in the system context.\","
    "\"parameters\":{\"type\":\"object\",\"properties\":{"
    "\"name\":{\"type\":\"string\",\"description\":\"The craft id, e.g. layout-responsive.\"}},"
    "\"required\":[\"name\"]}}}\n\n"
    "{\"type\":\"function\",\"function\":{\"name\":\"pack_file\","
    "\"description\":\"Read an allowlisted file exposed by a loaded pack, such as assets/template.html, references/checklist.md, references/layouts.md, or example.html. Use after skill()/design_system()/craft() lists pack files.\","
    "\"parameters\":{\"type\":\"object\",\"properties\":{"
    "\"type\":{\"type\":\"string\",\"description\":\"skill, design_system, or craft\"},"
    "\"name\":{\"type\":\"string\",\"description\":\"The pack id, e.g. landing-page.\"},"
    "\"path\":{\"type\":\"string\",\"description\":\"Pack-relative allowlisted path: example.html, assets/*, or references/*.\"}},"
    "\"required\":[\"type\",\"name\",\"path\"]}}}\n\n"
    "When a skill or design-system fits the brief — or the user selected one (see the "
    "system context) — load it FIRST with skill()/design_system(), then build to it. Load "
    "the relevant craft() rules too (accessibility before shipping; layout-responsive before "
    "any resize/restructure). If the loaded pack lists pack files, use pack_file() to load "
    "assets/template.html before writing from scratch, references/layouts.md before choosing "
    "structure, and references/checklist.md before verify_artifact. You can load more at any "
    "point without restarting.\n\n"
    "You have a real shell via bash (runs in the project dir) and web access via "
    "google_search / visit_page: use bash for builds, format/lint, quick scripts, "
    "and inspecting files; use the web to pull references, palettes, copy, or docs "
    "when the brief needs them. The deliverable is still the HTML you write.\n\n"
    "## RULE 1 — turn 1 must emit a question-form (no tools, no code)\n\n"
    "When the user opens a new project or sends a fresh design brief, your very "
    "first output is one short prose line + a <question-form> block. Nothing "
    "else. No file reads. No todo_write. The form is your time-to-first-byte.\n"
    "Match the user's chat language: every label and option must be in their "
    "language.\n\n"
    "<question-form id=\"discovery\" title=\"Quick brief\">\n"
    "{\"questions\":[\n"
    " {\"id\":\"output\",\"label\":\"What are we making?\",\"type\":\"radio\","
    "\"options\":[\"Prototype\",\"Live artifact\",\"Slide deck\",\"Image / poster\",\"Video storyboard\",\"HyperFrames\",\"Audio / script\",\"Other\"]},\n"
    " {\"id\":\"platform\",\"label\":\"Target platform\",\"type\":\"radio\","
    "\"options\":[\"Responsive web\",\"Desktop\",\"iOS\",\"Android\",\"Fixed canvas 1920x1080\"]},\n"
    " {\"id\":\"audience\",\"label\":\"Who is it for?\",\"type\":\"text\",\"placeholder\":\"audience / context\"},\n"
    " {\"id\":\"tone\",\"label\":\"Tone\",\"type\":\"radio\","
    "\"options\":[\"Editorial\",\"Minimal\",\"Playful\",\"Tech\",\"Luxury\",\"Brutalist\",\"Human\"]},\n"
    " {\"id\":\"brand\",\"label\":\"Brand direction\",\"type\":\"radio\","
    "\"options\":[\"Pick a direction for me\",\"I will describe colors/fonts\",\"Match a reference I will paste\"]},\n"
    " {\"id\":\"scale\",\"label\":\"Scale\",\"type\":\"radio\","
    "\"options\":[\"One screen\",\"3-6 sections\",\"Multiple screens\"]},\n"
    " {\"id\":\"constraints\",\"label\":\"Constraints / must-haves\",\"type\":\"textarea\",\"placeholder\":\"optional\"}\n"
    "]}\n"
    "</question-form>\n\n"
    "Form rules: body must be valid JSON (no comments, no trailing commas); "
    "type is radio, checkbox, select, text, or textarea; at most ~7 questions; "
    "tailor the questions to the brief when it already answers some. Lead with "
    "one short prose line, then the form. After </question-form>, STOP your "
    "turn. Do not write code. Do not start tools. Do not narrate that you are "
    "waiting.\n"
    "Skip the form entirely when the user is asking for a change to an "
    "existing design (\"make the headline bigger\"): that is iteration, see "
    "RULE 4.\n"
    "ALWAYS ask in a <question-form> — at ANY turn, not just the first. Whenever "
    "you need the user to choose or clarify something, emit a <question-form> "
    "(same shape and rules as above) and stop; never ask questions as plain "
    "prose with a question mark. The styled form is the only way you ask. If "
    "you are already in a tool-calling round and need a structured UI question, "
    "you may instead call question(id,title,questions) with the same JSON shape; "
    "after question() stop and wait for the user's answer.\n\n"
    "## RULE 2 — lock the visual direction (or propose a few) before building\n\n"
    "If the user described brand colors/fonts or pasted a reference, EXTRACT "
    "real values, never guess from memory: if they gave a URL, fetch its CSS "
    "with visit_page/bash and grep the hex (grep -Eo '#[0-9a-fA-F]{3,8}'); if "
    "they pasted colors/fonts, read them verbatim. Then write brand-spec.md in "
    "the project with the six tokens in OKLch (--bg --surface --fg --muted "
    "--border --accent), a display+body+mono font stack, and two or three "
    "layout rules you actually observed. Restate it in one sentence (\"deep "
    "navy canvas, single electric-cyan accent at oklch(68% 0.16 220), "
    "geometric display + system body\"), build ONE design binding those tokens "
    "to :root, and register it with artifact.\n"
    "If instead the user chose \"pick a direction for me\", pick the strongest "
    "matching direction yourself and build ONE design. Use propose only when the "
    "user explicitly asks for alternatives, variants, or a comparison. When you "
    "do propose, write 2-3 separate self-contained files and call propose with "
    "{entry,tag,name,desc}; otherwise keep momentum on one canonical artifact.\n"
    "The five built-in directions (each a palette source; bind to :root in CSS):\n"
    "- editorial-monocle: bg oklch(98% 0.004 95), fg oklch(20% 0.018 70), "
    "accent oklch(52% 0.10 28); serif display + sans body + mono metadata; no "
    "shadows, no rounded cards — borders and whitespace.\n"
    "- modern-minimal: bg oklch(99% 0.002 240), fg oklch(18% 0.012 250), "
    "accent oklch(58% 0.18 255) cobalt; tight letter-spacing, hairline "
    "borders, sticky frosted nav, monospace numerics.\n"
    "- human-approachable: bg oklch(98% 0.004 240), fg oklch(20% 0.02 240), "
    "accent oklch(56% 0.12 170) teal; generous 12-18px radii, strong weight "
    "contrast, subtle card elevation, no generic pastels.\n"
    "- tech-utility: bg oklch(98% 0.005 250), fg oklch(22% 0.02 240), accent "
    "oklch(58% 0.16 145) signal green; data-dense, tabular nums, grid, no "
    "decoration.\n"
    "- luxury-dramatic: deep OLED black bg, radial mesh gradients, wide "
    "grotesk display, vantablack cards, one dramatic accent.\n"
    "Never ask the same brand question twice.\n\n"
    "## RULE 2.5 — a reference (folder, repo, or URL): study it, keep the DNA, never clone\n\n"
    "When the user attaches a folder, links a code repo, or pastes a site "
    "URL, treat it as a quality bar to STUDY FIRST, before you design:\n"
    "- Pull it in: attached files are already in the project. For a repo URL, "
    "run git clone --depth 1 <url> _reference with bash; for a live site, use "
    "visit_page. Then list and read SELECTIVELY — the stylesheets / design "
    "tokens and one or two representative pages or components. Skip "
    "node_modules, dist, build, vendored assets.\n"
    "- Extract the design DNA into brand-spec.md from the REAL files, never "
    "from memory: grep the colors (grep -Eo '#[0-9a-fA-F]{3,8}' plus oklch / "
    "hsl), the font stacks, type sizes / scale, spacing rhythm, radii, "
    "shadows, the accent logic and the visual density. Restate it in one "
    "sentence.\n"
    "- KEEP from the reference: type scale, spacing rhythm, color temperature "
    "and palette logic, radius / shadow system, density, accent usage, motion "
    "attitude.\n"
    "- CHANGE: subject matter, copy, exact section layout, anything "
    "brief-specific.\n"
    "- DO NOT COPY: logos, literal copy, pricing, claims, screenshots, or the "
    "exact layout. The reference sets the bar; it is NOT a template — never "
    "ship a clone.\n"
    "Reading the reference can answer some discovery questions for you — do "
    "not ask what the files already tell you. Then build binding the extracted "
    "tokens to :root per RULE 2.\n\n"
    "## RULE 3 — todo_write the plan, then build with live updates\n\n"
    "Open the build with a one-line DESIGN READ as an HTML comment in the "
    "file: Reading as <page kind> for <audience>, <vibe> language, leaning "
    "<aesthetic family>; explicitly NOT <the lazy default this brief would "
    "otherwise become>. Commit to that read as your anti-default anchor.\n\n"
    "Once the direction is locked, your FIRST tool call of the build is "
    "todo_write with short imperative steps in the order you will do them — "
    "the chat renders it as a live Todos card, the user's main window into "
    "your plan. The standard plan shape:\n"
    "1. Load the active skill/design-system and any listed template/checklist pack files\n"
    "2. Bind direction/brand tokens to :root\n"
    "3. Plan the section/screen/slide list (state it aloud before writing)\n"
    "4. Copy the seed template when one exists; otherwise write the file(s)\n"
    "5. Replace placeholders with real, specific copy from the brief\n"
    "6. Run the pack checklist, verify_artifact, critique_write, then fix blockers\n"
    "7. Register the artifact only after critique_write passes\n"
    "Update the card as you go: mark a step in_progress when you start it and "
    "completed when it is done (call todo_write again with the full updated "
    "list). Keep the plan under ~8 items.\n\n"
    "## RULE 3.5 — critique before you ship (do not skip)\n\n"
    "After writing and before artifact, run verify_artifact(entry). Fix every "
    "P0; P1/P2 warnings should be fixed unless the brief makes them intentional. "
    "Then call critique_write(entry, scores_json, must_fixes_json, decision, notes). "
    "Use role scores on a 0-10 scale:\n"
    "- critic (weight .4): composition, hierarchy, execution quality, responsive "
    "fit, whether it avoids the lazy default.\n"
    "- brand (weight .2): palette discipline, type personality, reference DNA "
    "when a reference exists, and restraint.\n"
    "- a11y (weight .2): contrast, focus, hit targets, reduced motion, keyboard "
    "and state coverage.\n"
    "- copy (weight .2): specificity, truthful claims, clear labels, no filler.\n"
    "The runtime computes the composite. Passing means composite >= 8.0, "
    "must_fixes_json is [], and decision is ship. Any must-fix or score below "
    "the bar means edit the file and call critique_write again. Scores are a "
    "tool event only; do not narrate them in chat. Name the exact weak elements "
    "inside notes so the next edit is targeted.\n"
    "P0 gates include: valid standalone HTML, viewport/title, no missing local "
    "assets, no placeholders, no generic emoji-icon slop, no default purple "
    "gradient, no rounded card with left accent stripe, no unsupported metrics, "
    "body text >= 16px, tap targets >= 44px, body contrast >= 4.5:1, and no "
    "horizontal scroll at 390 / 768 / 1280px.\n\n"
    "The runtime enforces this: verify_artifact(entry) reports P0/P1/P2, "
    "critique_write records the quality decision, and artifact(entry,title) "
    "blocks HTML until the latest critique for that exact entry passes.\n\n"
    "## Hard rules — count-checkable, fix before the artifact\n\n"
    "Typography: 3 weights only (400 body, 510-550 labels/UI, 590-600 "
    "headings); weight should JUMP between levels, not climb one step each; "
    "no 700+ unless the brand needs it. ALL-CAPS needs letter-spacing "
    "0.06-0.1em (required); display >=48px needs -0.02 to -0.03em; body 0. "
    "Never justify; body measure 60-75 characters (max-width: 65ch). Type "
    "scale x1.2 or x1.25, <=6 sizes per file, <=3 above the fold.\n"
    "Palette (budget the pixels before any CSS): neutrals 70-90%, ONE accent "
    "5-10%, semantic 0-5%, effects <1%. The accent appears at most TWICE per "
    "screen (an eyebrow/chip and one CTA); links count as accent. Dark "
    "backgrounds are near-black (oklch ~12-15% L), never #000; light text is "
    "never #fff.\n"
    "Layout: the hero fits the first viewport — headline <=2 lines, subtext "
    "<=20 words, CTA visible without scrolling (a 4-line headline is a "
    "font-size bug, not a copy bug). 8 sections use >=4 different layout "
    "families; never 3 equal feature cards; at most 2 consecutive image+text "
    "split sections. Bento/grid: N items make N cells, no empty trailing cell.\n"
    "States — any surface that loads or accepts data (dashboards, tools, "
    "forms) renders all five: loading (skeleton + a 15s taking-longer "
    "fallback), empty (headline + one-line why + a primary CTA, never blank), "
    "error (what happened + why + what to do, never a bare Something went "
    "wrong, and keep the user input), populated, and edge (200-char strings, "
    "missing fields, huge counts must not break the layout). Forms validate "
    "on the first blur after editing then live; style :user-invalid, never "
    ":invalid (no red borders on load).\n\n"
    "## RULE 4 — iteration edits in place\n\n"
    "When the user asks for a change to an existing design: no form, no plan "
    "ceremony. read the relevant lines, edit them, summarize what changed in "
    "one or two sentences. If instead the user asks you to critique or review "
    "a design, answer as Keep (what works) / Fix (ordered by visual cost "
    "saved per minute) / Quick-wins (5-15 min tweaks with outsized impact), "
    "naming the specific element for each point. Do NOT call artifact for in-place edits — the "
    "preview already refreshed. For a major revision, copy to a new versioned "
    "file (landing-page-v2.html) and register that as a new artifact.\n"
    "Decoding here runs at tens of tokens per second: never rewrite a file "
    "for a local change. Use edit with a unique old anchor; for large spans "
    "write the first lines, then [upto], then unique final lines — the span "
    "from head through tail is replaced. Never close old right after [upto]; "
    "never use a generic tail like a lone </div>.\n\n"
    "## Files and code conventions\n\n"
    "- Every HTML file is complete and standalone: one <style>, optional one "
    "<script>, no external requests of any kind (system font stacks, inline "
    "SVG, CSS gradients instead of images).\n"
    "- Provider-backed Open Design skills are local-first here: do not call "
    "external APIs for Figma, Fal, Venice, Sora, Replicate, Minimax or similar. "
    "Instead produce a local blueprint, storyboard, prompt pack, or static HTML "
    "mockup with clear export metadata.\n"
    "- Descriptive kebab-case names: landing-page.html, pricing.html — never "
    "page.html. Multi-screen work: screens/01-onboarding.html, "
    "screens/02-paywall.html, with index.html only as an overview/launcher "
    "that links the screens.\n"
    "- Keep a file under ~1000 lines; split shared CSS/JS into css/ and js/ "
    "only when really shared.\n"
    "- min-height: 100dvh, never height: 100vh. Fluid type with clamp(). "
    "text-wrap: pretty on prose. Never use scrollIntoView (it breaks the "
    "embedded preview).\n"
    "- Responsive: design mobile 390px, tablet 768px, desktop 1280+ as real "
    "layouts, not shrunken desktop. Mobile app prototypes get a real iPhone "
    "frame (390x844, Dynamic Island, home indicator) and 44px hit targets.\n"
    "- Slide decks: fixed 1920x1080 canvas scaled to fit, one idea per "
    "slide, headlines >= 36px, body >= 22px, visible slide counter, arrow-key "
    "navigation.\n\n"
    "## Embody the specialist\n\n"
    "Pick the persona before writing CSS: landing/marketing -> brand designer "
    "(one hero, 3-6 sections, real copy, ONE decisive flourish); dashboard -> "
    "systems designer (information density IS the feature, monospace "
    "numerics, no decoration); mobile app -> interaction designer (real "
    "screens, not \"feature one\" placeholders); deck -> slide designer; "
    "responsive product -> product systems designer (shared information "
    "architecture first, then per-breakpoint layouts).\n\n"
    "## Anti-AI-slop checklist (audit before shipping)\n\n"
    "- No aggressive purple/violet gradient backgrounds\n"
    "- No generic emoji feature icons\n"
    "- No rounded card with a left colored border accent\n"
    "- No Inter/Roboto/Arial as a display face (body is fine)\n"
    "- No invented metrics (\"10x faster\", \"99.9% uptime\") without a source\n"
    "- No filler copy — \"Feature One\", lorem ipsum\n"
    "- No icon next to every heading, no gradient on every background\n"
    "- No warm beige/cream/peach page backgrounds unless the brand requires them\n"
    "- No designer settings, viewport toggles, or generated-design metadata "
    "exposed inside the product UI itself\n"
    "- No em-dash in visible text (the — or – character): use a period, comma, or hyphen\n"
    "- At most one uppercase tracked eyebrow per three sections; no numbered "
    "section eyebrows (00 / INDEX, 001 - Capabilities)\n"
    "- No fake product UI faked from styled <div>s as decoration (fake "
    "terminals, fake dashboards, fake task lists inside a hero)\n"
    "- No placeholder identities: not Acme / Nexus / John or Jane Doe, not "
    "perfect fake numbers (99.9%); use specific, plausible names and figures\n"
    "- No decorative strips: locale/time/weather (Lisbon 14:23), scroll cues, "
    "version or build stamps (v0.6)\n"
    "- At most one middle-dot (·) per metadata line; no decorative status dots\n\n"
    "## Artifact handoff\n\n"
    "When a turn shipped a NEW canonical HTML file, end the turn by calling "
    "artifact with its entry path and a human title, after verify_artifact and "
    "a passing critique_write for the same entry. One artifact per turn at "
    "most; for multi-file work register the entry point (the launcher or the "
    "main page). Never register an unchanged file again; never register "
    "non-HTML. After the artifact tool result, close with one or two short "
    "sentences in the user's language — what shipped and what could come "
    "next. Do not paste design code into the chat.\n";

static const char dsml_syntax_reminder[] =
    "DSML syntax reminder:\n"
    "<｜DSML｜tool_calls>\n"
    "<｜DSML｜invoke name=\"$TOOL_NAME\">\n"
    "<｜DSML｜parameter name=\"$PARAMETER_NAME\" string=\"true|false\">$PARAMETER_VALUE</｜DSML｜parameter>\n"
    "</｜DSML｜invoke>\n"
    "</｜DSML｜tool_calls>\n";

/* ============================================================================
 * Configuration
 * ============================================================================
 */

typedef struct {
    ds4_engine_options engine;
    const char *workspace;
    const char *extra_system;
    int ctx_size;
    int n_predict;
    float temperature;
    float top_p;
    float min_p;
    uint64_t seed;
    ds4_think_mode think_mode;
    const char *remote_base_url;
    const char *remote_model;
    bool jsonl;
    bool self_test;
} design_config;

static void usage(FILE *fp) {
    fprintf(fp,
        "Usage: ds4-design [options]\n"
        "  -m, --model <gguf>      model path (default ds4flash.gguf)\n"
        "  -c, --ctx <n>           context size (default 100000)\n"
        "  -n, --tokens <n>        max tokens per assistant round (default 50000)\n"
        "  --workspace <dir>       project directory for the design files\n"
        "                          (default ~/Documents/ds4-designs)\n"
        "  -sys, --system <text>   extra system instructions\n"
        "  --temp/--top-p/--min-p  sampling (defaults %.1f/%.1f/%.2f)\n"
        "  --seed <n>              sampling seed\n"
        "  --think|--think-max|--nothink   reasoning effort (default nothink)\n"
        "  --metal|--cuda|--cpu    backend\n"
        "  --power <1-100>         power limit\n"
        "  --remote-base-url <url> use a DStudio LAN host for model inference\n"
        "  --remote-model <id>     remote model id (default ds4)\n"
        "  --jsonl                 emit structured \\x1e-prefixed UI events\n"
        "  --self-test             run ds4-design runtime contract tests and exit\n"
        "  --non-interactive       accepted for launcher symmetry (always on)\n",
        (double)DS4_DEFAULT_TEMPERATURE, (double)DS4_DEFAULT_TOP_P,
        (double)DS4_DEFAULT_MIN_P);
}

static int parse_int_arg(const char *s, const char *opt) {
    char *end = NULL;
    long v = strtol(s, &end, 10);
    if (end == s || *end != '\0' || v < INT_MIN || v > INT_MAX) {
        fprintf(stderr, "ds4-design: invalid value for %s: %s\n", opt, s);
        exit(2);
    }
    return (int)v;
}

static const char *need_arg(int *i, int argc, char **argv, const char *opt) {
    if (*i + 1 >= argc) {
        fprintf(stderr, "ds4-design: %s requires an argument\n", opt);
        exit(2);
    }
    return argv[++(*i)];
}

static design_config parse_options(int argc, char **argv) {
    design_config c;
    memset(&c, 0, sizeof(c));
    c.engine.model_path = "ds4flash.gguf";
    c.engine.backend = DS4_BACKEND_METAL;
    c.engine.mtp_draft_tokens = 1;
    c.engine.mtp_margin = 3.0f;
    c.ctx_size = 100000;
    c.n_predict = 50000;
    c.temperature = DS4_DEFAULT_TEMPERATURE;
    c.top_p = DS4_DEFAULT_TOP_P;
    c.min_p = DS4_DEFAULT_MIN_P;
    c.think_mode = DS4_THINK_NONE; /* design iterations favor latency */

    for (int i = 1; i < argc; i++) {
        const char *arg = argv[i];
        if (!strcmp(arg, "-h") || !strcmp(arg, "--help")) {
            usage(stdout);
            exit(0);
        } else if (!strcmp(arg, "-m") || !strcmp(arg, "--model")) {
            c.engine.model_path = need_arg(&i, argc, argv, arg);
        } else if (!strcmp(arg, "-c") || !strcmp(arg, "--ctx")) {
            c.ctx_size = parse_int_arg(need_arg(&i, argc, argv, arg), arg);
        } else if (!strcmp(arg, "-n") || !strcmp(arg, "--tokens")) {
            c.n_predict = parse_int_arg(need_arg(&i, argc, argv, arg), arg);
        } else if (!strcmp(arg, "--workspace")) {
            c.workspace = need_arg(&i, argc, argv, arg);
        } else if (!strcmp(arg, "-sys") || !strcmp(arg, "--system")) {
            c.extra_system = need_arg(&i, argc, argv, arg);
        } else if (!strcmp(arg, "--temp")) {
            c.temperature = (float)atof(need_arg(&i, argc, argv, arg));
        } else if (!strcmp(arg, "--top-p")) {
            c.top_p = (float)atof(need_arg(&i, argc, argv, arg));
        } else if (!strcmp(arg, "--min-p")) {
            c.min_p = (float)atof(need_arg(&i, argc, argv, arg));
        } else if (!strcmp(arg, "--seed")) {
            c.seed = strtoull(need_arg(&i, argc, argv, arg), NULL, 10);
        } else if (!strcmp(arg, "--think")) {
            c.think_mode = DS4_THINK_HIGH;
        } else if (!strcmp(arg, "--think-max")) {
            c.think_mode = DS4_THINK_MAX;
        } else if (!strcmp(arg, "--nothink")) {
            c.think_mode = DS4_THINK_NONE;
        } else if (!strcmp(arg, "--metal")) {
            c.engine.backend = DS4_BACKEND_METAL;
        } else if (!strcmp(arg, "--cuda")) {
            c.engine.backend = DS4_BACKEND_CUDA;
        } else if (!strcmp(arg, "--cpu")) {
            c.engine.backend = DS4_BACKEND_CPU;
        } else if (!strcmp(arg, "--power")) {
            c.engine.power_percent = parse_int_arg(need_arg(&i, argc, argv, arg), arg);
            if (c.engine.power_percent < 1 || c.engine.power_percent > 100) {
                fprintf(stderr, "ds4-design: --power must be between 1 and 100\n");
                exit(2);
            }
        } else if (!strcmp(arg, "--remote-base-url")) {
            c.remote_base_url = need_arg(&i, argc, argv, arg);
        } else if (!strcmp(arg, "--remote-model")) {
            c.remote_model = need_arg(&i, argc, argv, arg);
        } else if (!strcmp(arg, "--jsonl")) {
            c.jsonl = true;
        } else if (!strcmp(arg, "--self-test")) {
            c.self_test = true;
        } else if (!strcmp(arg, "--non-interactive")) {
            /* the only mode there is */
        } else {
            fprintf(stderr, "ds4-design: unknown option: %s\n", arg);
            usage(stderr);
            exit(2);
        }
    }

    if (!c.workspace) {
        static char def[PATH_MAX];
        const char *home = getenv("HOME");
        snprintf(def, sizeof(def), "%s/Documents/ds4-designs", home ? home : ".");
        c.workspace = def;
    }
    return c;
}

static bool design_think_control_value(const char *value, ds4_think_mode *out) {
    if (!value || !out) return false;
    if (!strcmp(value, "off") || !strcmp(value, "none") || !strcmp(value, "nothink")) {
        *out = DS4_THINK_NONE;
        return true;
    }
    if (!strcmp(value, "max") || !strcmp(value, "think-max")) {
        *out = DS4_THINK_MAX;
        return true;
    }
    if (!strcmp(value, "high") || !strcmp(value, "normal") ||
        !strcmp(value, "think") || !strcmp(value, "on")) {
        *out = DS4_THINK_HIGH;
        return true;
    }
    return false;
}

static bool design_apply_control_frames(design_config *cfg, char *line) {
    bool changed = false;
    if (!cfg || !line) return false;
    for (;;) {
        if ((unsigned char)line[0] != 0x1e) break;
        char *nl = strchr(line, '\n');
        if (!nl) break;
        size_t frame_len = (size_t)(nl - line - 1);
        char *frame = line + 1;
        if (frame_len > 1024 ||
            !strstr(frame, "\"type\":\"control\"") ||
            !strstr(frame, "\"name\":\"think\"")) {
            break;
        }
        char *v = strstr(frame, "\"value\":\"");
        if (v) {
            v += 9;
            char value[32];
            size_t n = 0;
            while (v[n] && v[n] != '"' && n + 1 < sizeof(value)) {
                value[n] = v[n];
                n++;
            }
            value[n] = '\0';
            ds4_think_mode m;
            if (design_think_control_value(value, &m)) {
                cfg->think_mode = m;
                changed = true;
            }
        }
        memmove(line, nl + 1, strlen(nl + 1) + 1);
    }
    return changed;
}

/* ============================================================================
 * Turn Runner
 * ============================================================================
 */

typedef struct {
    design_config *cfg;
    ds4_engine *engine;
    ds4_session *session;
    ds4_tokens transcript;
    design_project project;
    /* Persistent named sessions (ported from ds4-agent): the live transcript
     * and KV payload are saved under ~/.ds4/design-sessions/<sha>.kv, where sha
     * = SHA1(title || created_at_le64).  A session is "started" once it has a
     * title (set from the first prompt of the turn). */
    char *cache_dir;
    char session_sha[41];
    char *session_title;
    uint64_t session_created_at;
    dstudio_remote_buf remote_messages;
    int remote_message_count;
} design_agent;

static ds4_think_mode agent_think_mode(const design_agent *a) {
    return ds4_think_mode_for_context(a->cfg->think_mode, a->cfg->ctx_size);
}

/* ============================================================================
 * Session / KV Persistence — ported VERBATIM from ds4_agent.c
 * ============================================================================
 *
 * Byte-identical KV file format and SHA identity scheme to ds4-agent: a saved
 * file stays valid across both agents.  Only the threading/TUI scaffolding of
 * the source was removed (no pthread/mutex, no renderer_*, no isatty/color);
 * the worker param `agent_worker *w` became `design_agent *a`.
 */

static char *design_default_cache_dir(void) {
    const char *home = getenv("HOME");
    if (!home || !home[0]) home = ".";
    design_buf b = {0};
    buf_puts(&b, home);
    if (b.len == 0 || b.ptr[b.len - 1] != '/') buf_puts(&b, "/");
    buf_puts(&b, ".ds4/design-sessions");
    return buf_take(&b);
}

static char *design_kv_path_for_sha(const char *dir, const char sha[41]) {
    char name[44];
    memcpy(name, sha, 40);
    memcpy(name + 40, ".kv", 4);
    return ds4_kvstore_path_join(dir, name);
}

static void design_le_put64(uint8_t *p, uint64_t v) {
    for (int i = 0; i < 8; i++) p[i] = (uint8_t)(v >> (8 * i));
}

/* Session IDs are intentionally independent from the rendered transcript:
 * once a session has a title and creation time, resaving it keeps the same file
 * name while the transcript and KV payload evolve. */
static void design_session_identity_sha(const char *title, uint64_t created_at,
                                        char sha_out[41]) {
    size_t title_len = title ? strlen(title) : 0;
    design_buf b = {0};
    buf_append(&b, title ? title : "", title_len);
    uint8_t ts[8];
    design_le_put64(ts, created_at);
    buf_append(&b, (const char *)ts, sizeof(ts));
    ds4_kvstore_sha1_bytes_hex(b.ptr ? b.ptr : "", b.len, sha_out);
    free(b.ptr);
}

typedef struct {
    bool has_title_trailer;
    bool legacy_identity;
    char *title;
    uint64_t created_at;
    char sha[41];
} design_kv_session_meta;

static void design_kv_session_meta_free(design_kv_session_meta *m) {
    free(m->title);
    memset(m, 0, sizeof(*m));
}

static char *design_session_title_from_text(const char *text, size_t text_len,
                                            size_t max_bytes);

static bool design_tokens_equal(const ds4_tokens *a, const ds4_tokens *b) {
    if (!a || !b || a->len != b->len) return false;
    for (int i = 0; i < a->len; i++) {
        if (a->v[i] != b->v[i]) return false;
    }
    return true;
}

/* Token-sync helper: wraps ds4_session_sync.  The agent's version published
 * prefill progress through a mutex-guarded status block and progress callbacks;
 * headless design has neither, so this is just the bare incremental sync. */
static int design_sync_tokens(design_agent *a, const ds4_tokens *tokens,
                              char *err, size_t err_len) {
    return ds4_session_sync(a->session, tokens, err, err_len);
}

static bool design_kv_read_text(FILE *fp, uint32_t text_bytes,
                                char **text_out, char *err, size_t err_len) {
    char *text = xmalloc((size_t)text_bytes + 1);
    if (fread(text, 1, text_bytes, fp) != text_bytes) {
        if (err && err_len) snprintf(err, err_len, "truncated cached text");
        free(text);
        return false;
    }
    text[text_bytes] = '\0';
    *text_out = text;
    return true;
}

static bool design_kv_write_title_trailer(FILE *fp, const char *title,
                                          char *err, size_t err_len) {
    size_t title_len = title ? strlen(title) : 0;
    if (title_len > UINT32_MAX) {
        snprintf(err, err_len, "session title is too large");
        return false;
    }
    uint8_t tb[4];
    ds4_kvstore_le_put32(tb, (uint32_t)title_len);
    return fwrite(tb, 1, sizeof(tb), fp) == sizeof(tb) &&
           fwrite(title ? title : "", 1, title_len, fp) == title_len;
}

/* Read the optional title trailer without disturbing the payload cursor.  The
 * caller is positioned just after rendered text, which is also the payload
 * start expected by ds4_session_load_payload(). */
static bool design_kv_read_title_trailer(FILE *fp, const ds4_kvstore_entry *hdr,
                                         char **title_out,
                                         char *err, size_t err_len) {
    off_t payload_pos = ftello(fp);
    if (payload_pos < 0) {
        if (err && err_len) snprintf(err, err_len, "%s", strerror(errno));
        return false;
    }
    if (hdr->payload_bytes > (uint64_t)LLONG_MAX ||
        fseeko(fp, (off_t)hdr->payload_bytes, SEEK_CUR) != 0)
    {
        if (err && err_len) snprintf(err, err_len, "%s", strerror(errno));
        return false;
    }

    uint8_t tb[4];
    if (fread(tb, 1, sizeof(tb), fp) != sizeof(tb)) {
        if (err && err_len) snprintf(err, err_len, "missing session title trailer");
        fseeko(fp, payload_pos, SEEK_SET);
        return false;
    }
    uint32_t title_bytes = ds4_kvstore_le_get32(tb);
    char *title = xmalloc((size_t)title_bytes + 1);
    if (fread(title, 1, title_bytes, fp) != title_bytes) {
        if (err && err_len) snprintf(err, err_len, "truncated session title trailer");
        free(title);
        fseeko(fp, payload_pos, SEEK_SET);
        return false;
    }
    title[title_bytes] = '\0';
    if (fseeko(fp, payload_pos, SEEK_SET) != 0) {
        if (err && err_len) snprintf(err, err_len, "%s", strerror(errno));
        free(title);
        return false;
    }
    *title_out = title;
    return true;
}

static void design_kv_identity_sha(const ds4_kvstore_entry *hdr,
                                   const char *text, uint32_t text_bytes,
                                   const char *title,
                                   char sha_out[41]) {
    if (hdr->ext_flags & DS4_KVSTORE_EXT_SESSION_TITLE) {
        design_session_identity_sha(title ? title : "", hdr->created_at, sha_out);
    } else {
        ds4_kvstore_sha1_bytes_hex(text, text_bytes, sha_out);
    }
}

/* Load a KV file and optionally verify either its session identity or exact
 * rendered text.  Saved sessions use their filename SHA: modern sessions hash
 * the title trailer plus created_at, while legacy sessions still hash rendered
 * text. */
static bool design_kv_load_path(design_agent *a, const char *path,
                                const char *expected_sha,
                                const char *expected_text,
                                size_t expected_text_len,
                                ds4_tokens *loaded_tokens,
                                design_kv_session_meta *meta_out,
                                char *err, size_t err_len) {
    FILE *fp = fopen(path, "rb");
    if (!fp) {
        snprintf(err, err_len, "%s", strerror(errno));
        return false;
    }

    ds4_kvstore_entry hdr = {0};
    uint32_t text_bytes = 0;
    bool ok = ds4_kvstore_read_header(fp, &hdr, &text_bytes);
    if (!ok) snprintf(err, err_len, "invalid KV header");

    char *text = NULL;
    if (ok) ok = design_kv_read_text(fp, text_bytes, &text, err, err_len);
    char *title = NULL;
    bool has_title = ok && (hdr.ext_flags & DS4_KVSTORE_EXT_SESSION_TITLE);
    if (has_title)
        ok = design_kv_read_title_trailer(fp, &hdr, &title, err, err_len);
    uint32_t expected_tokens = hdr.tokens;
    if (ok && hdr.payload_bytes != 0 &&
        hdr.model_id != (uint8_t)ds4_engine_model_id(a->engine))
    {
        snprintf(err, err_len, "KV checkpoint was written for a different model");
        ok = false;
    }
    if (ok && hdr.payload_bytes != 0 &&
        hdr.quant_bits != (uint8_t)ds4_engine_routed_quant_bits(a->engine))
    {
        snprintf(err, err_len, "KV checkpoint was written for a different quantization");
        ok = false;
    }
    if (ok && expected_text) {
        if ((size_t)text_bytes != expected_text_len ||
            memcmp(text, expected_text, expected_text_len) != 0)
        {
            snprintf(err, err_len, "cached text does not match current system prompt");
            ok = false;
        }
    }
    if (ok && expected_sha) {
        char actual_sha[41];
        design_kv_identity_sha(&hdr, text, text_bytes, title, actual_sha);
        if (strcmp(actual_sha, expected_sha)) {
            snprintf(err, err_len, "cached session identity does not match file name");
            ok = false;
        }
    }

    char load_err[160] = {0};
    if (ok && hdr.payload_bytes == 0) {
        ds4_tokens rebuilt = {0};
        ds4_tokenize_rendered_chat(a->engine, text, &rebuilt);
        expected_tokens = (uint32_t)rebuilt.len;
        if (design_sync_tokens(a, &rebuilt, err, err_len) != 0) {
            ds4_session_invalidate(a->session);
            ok = false;
        }
        ds4_tokens_free(&rebuilt);
    } else if (ok &&
               ds4_session_load_payload(a->session, fp, hdr.payload_bytes,
                                        load_err, sizeof(load_err)) != 0)
    {
        snprintf(err, err_len, "%s", load_err[0] ? load_err : "failed to load KV payload");
        ds4_session_invalidate(a->session);
        ok = false;
    }
    fclose(fp);

    if (ok) {
        const ds4_tokens *live = ds4_session_tokens(a->session);
        if (!live || live->len != (int)expected_tokens) {
            snprintf(err, err_len, "KV payload token count mismatch");
            ds4_session_invalidate(a->session);
            ok = false;
        } else if (loaded_tokens) {
            ds4_tokens_free(loaded_tokens);
            ds4_tokens_copy(loaded_tokens, live);
        }
        if (meta_out) {
            design_kv_session_meta_free(meta_out);
            meta_out->has_title_trailer = has_title;
            meta_out->legacy_identity = !has_title;
            meta_out->created_at = hdr.created_at;
            design_kv_identity_sha(&hdr, text, text_bytes, title, meta_out->sha);
            meta_out->title = has_title ?
                xstrdup(title) :
                design_session_title_from_text(text, text_bytes, 0);
        }
    }
    free(title);
    free(text);
    return ok;
}

/* Save the current live KV under the rendered transcript identity. */
static bool design_kv_save_path(design_agent *a, const char *path,
                                const ds4_tokens *tokens,
                                const char *reason,
                                char sha_out[41],
                                const char *session_title,
                                uint64_t session_created_at,
                                char *err, size_t err_len) {
    const ds4_tokens *live = ds4_session_tokens(a->session);
    if (!design_tokens_equal(live, tokens)) {
        snprintf(err, err_len, "live KV state does not match session transcript");
        return false;
    }
    const int quant_bits = ds4_engine_routed_quant_bits(a->engine);
    if (quant_bits != 2 && quant_bits != 4) {
        snprintf(err, err_len, "unsupported routed quantization for KV save");
        return false;
    }
    const int model_id = ds4_engine_model_id(a->engine);

    size_t text_len = 0;
    char *text = ds4_kvstore_render_tokens_text(a->engine, tokens, &text_len);
    if (!text) {
        snprintf(err, err_len, "failed to render KV text key");
        return false;
    }
    if (text_len > UINT32_MAX) {
        snprintf(err, err_len, "rendered KV text key is too large");
        free(text);
        return false;
    }
    const bool session_identity = session_title != NULL;
    uint64_t now = (uint64_t)time(NULL);
    uint64_t created_at = session_identity && session_created_at ?
        session_created_at : now;
    char sha[41];
    if (session_identity)
        design_session_identity_sha(session_title, created_at, sha);
    else
        ds4_kvstore_sha1_bytes_hex(text, text_len, sha);
    if (sha_out) memcpy(sha_out, sha, sizeof(sha));

    ds4_session_payload_file staged = {0};
    char save_err[160] = {0};
    if (ds4_session_stage_payload(a->session, &staged,
                                  save_err, sizeof(save_err)) != 0) {
        snprintf(err, err_len, "%s",
                 save_err[0] ? save_err : "session has no valid KV payload");
        free(text);
        return false;
    }
    uint64_t payload_bytes = staged.bytes;

    char *tmp = NULL;
    int fd = design_tempfile_near(path, &tmp);
    if (fd < 0) {
        snprintf(err, err_len, "%s", strerror(errno));
        ds4_session_payload_file_free(&staged);
        free(tmp);
        free(text);
        return false;
    }

    FILE *fp = fdopen(fd, "wb");
    if (!fp) {
        snprintf(err, err_len, "%s", strerror(errno));
        close(fd);
        unlink(tmp);
        ds4_session_payload_file_free(&staged);
        free(tmp);
        free(text);
        return false;
    }

    uint8_t h[DS4_KVSTORE_FIXED_HEADER];
    ds4_kvstore_fill_header(h, (uint8_t)model_id, (uint8_t)quant_bits,
                            ds4_kvstore_reason_code(reason),
                            session_identity ? DS4_KVSTORE_EXT_SESSION_TITLE : 0,
                            (uint32_t)tokens->len, 0,
                            (uint32_t)ds4_session_ctx(a->session),
                            created_at, now, payload_bytes);
    uint8_t tb[4];
    ds4_kvstore_le_put32(tb, (uint32_t)text_len);

    errno = 0;
    bool ok = fwrite(h, 1, sizeof(h), fp) == sizeof(h) &&
              fwrite(tb, 1, sizeof(tb), fp) == sizeof(tb) &&
              fwrite(text, 1, text_len, fp) == text_len &&
              ds4_session_write_staged_payload(&staged, fp,
                                               save_err, sizeof(save_err)) == 0 &&
              (!session_identity ||
               design_kv_write_title_trailer(fp, session_title,
                                             save_err, sizeof(save_err))) &&
              fflush(fp) == 0;
    int saved_errno = errno;
    if (fclose(fp) != 0) {
        if (!saved_errno) saved_errno = errno;
        ok = false;
    }
    if (ok && rename(tmp, path) != 0) {
        saved_errno = errno;
        ok = false;
    }
    if (!ok) {
        snprintf(err, err_len, "%s",
                 saved_errno ? strerror(saved_errno) :
                 (save_err[0] ? save_err : "failed to write KV file"));
        unlink(tmp);
    }

    ds4_session_payload_file_free(&staged);
    free(tmp);
    free(text);
    return ok;
}

/* ---- title and age formatting (verbatim from ds4-agent) ---- */

static void design_format_age(uint64_t when, char *buf, size_t len) {
    uint64_t now = (uint64_t)time(NULL);
    uint64_t age = when && now > when ? now - when : 0;
    if (age < 60) snprintf(buf, len, "%llus ago", (unsigned long long)age);
    else if (age < 3600) snprintf(buf, len, "%llum ago", (unsigned long long)(age / 60));
    else if (age < 86400) snprintf(buf, len, "%lluh ago", (unsigned long long)(age / 3600));
    else snprintf(buf, len, "%llud ago", (unsigned long long)(age / 86400));
}

static char *design_session_title_from_span(const char *p, const char *end,
                                            size_t max_bytes,
                                            const char *empty_title) {
    bool limited = max_bytes != 0;
    if (limited && max_bytes < 4) max_bytes = 4;
    while (p < end && isspace((unsigned char)*p)) p++;
    while (end > p && isspace((unsigned char)end[-1])) end--;

    design_buf b = {0};
    bool space = false;
    bool truncated = false;
    for (const char *s = p; s < end; s++) {
        unsigned char c = (unsigned char)*s;
        if (isspace(c)) {
            space = b.len != 0;
            continue;
        }
        if (space && (!limited || b.len + 4 < max_bytes)) {
            buf_puts(&b, " ");
            space = false;
        }
        if (limited && b.len + 4 > max_bytes) {
            truncated = true;
            break;
        }
        buf_append(&b, s, 1);
    }
    if (truncated) buf_puts(&b, "...");
    if (!b.ptr || !b.len) {
        free(b.ptr);
        return xstrdup(empty_title);
    }
    return buf_take(&b);
}

static char *design_session_title_from_prompt(const char *prompt,
                                              size_t max_bytes) {
    const char *p = prompt ? prompt : "";
    return design_session_title_from_span(p, p + strlen(p), max_bytes,
                                          "(empty user prompt)");
}

/* Extract a human-readable title from the first user turn stored in the
 * rendered transcript.  max_bytes==0 means "full normalized title". */
static char *design_session_title_from_text(const char *text, size_t text_len,
                                            size_t max_bytes) {
    static const char user_mark[] = "<｜User｜>";
    static const char assistant_mark[] = "<｜Assistant｜>";
    const char *p = text ? strstr(text, user_mark) : NULL;
    if (!p) return xstrdup("(no user prompt)");
    p += strlen(user_mark);
    const char *end = text + text_len;
    const char *assistant = strstr(p, assistant_mark);
    const char *next_user = strstr(p, user_mark);
    if (assistant && assistant < end) end = assistant;
    if (next_user && next_user < end) end = next_user;
    return design_session_title_from_span(p, end, max_bytes,
                                          "(empty user prompt)");
}

static char *design_session_title_clip(const char *title, size_t max_bytes) {
    if (!title) return xstrdup("(no user prompt)");
    size_t len = strlen(title);
    if (max_bytes == 0 || len <= max_bytes) return xstrdup(title);
    if (max_bytes < 4) max_bytes = 4;
    design_buf b = {0};
    buf_append(&b, title, max_bytes - 3);
    buf_puts(&b, "...");
    return buf_take(&b);
}

static char *design_session_title_from_file(const char *path, size_t max_bytes) {
    FILE *fp = fopen(path, "rb");
    if (!fp) return xstrdup("(unreadable session)");
    ds4_kvstore_entry hdr = {0};
    uint32_t text_bytes = 0;
    char *text = NULL;
    char *trailer_title = NULL;
    bool ok = ds4_kvstore_read_header(fp, &hdr, &text_bytes) &&
              design_kv_read_text(fp, text_bytes, &text, NULL, 0);
    if (ok && (hdr.ext_flags & DS4_KVSTORE_EXT_SESSION_TITLE))
        ok = design_kv_read_title_trailer(fp, &hdr, &trailer_title, NULL, 0);
    fclose(fp);
    char *title = ok ?
        (trailer_title ?
            design_session_title_clip(trailer_title, max_bytes) :
            design_session_title_from_text(text, text_bytes, max_bytes)) :
        xstrdup("(unreadable session)");
    free(trailer_title);
    free(text);
    return title;
}

/* ---- session listing: scan ~/.ds4/design-sessions, emit one JSON event ---- */

typedef struct {
    ds4_kvstore_entry entry;
    char *title;
} design_session_list_item;

static int design_session_list_cmp_recent(const void *a, const void *b) {
    const design_session_list_item *sa = a, *sb = b;
    uint64_t ta = sa->entry.last_used ? sa->entry.last_used : sa->entry.created_at;
    uint64_t tb = sb->entry.last_used ? sb->entry.last_used : sb->entry.created_at;
    if (ta < tb) return 1;
    if (ta > tb) return -1;
    return strcmp(sa->entry.sha, sb->entry.sha);
}

static void design_session_list_free(design_session_list_item *v, int n) {
    for (int i = 0; i < n; i++) {
        ds4_kvstore_entry_free(&v[i].entry);
        free(v[i].title);
    }
    free(v);
}

static void design_session_list_push(design_session_list_item **v, int *len,
                                     int *cap, ds4_kvstore_entry entry,
                                     char *title) {
    if (*len == *cap) {
        *cap = *cap ? *cap * 2 : 16;
        *v = xrealloc(*v, (size_t)*cap * sizeof((*v)[0]));
    }
    (*v)[(*len)++] = (design_session_list_item){
        .entry = entry,
        .title = title,
    };
}

/* Scan resumable sessions and emit one {"type":"sessions",...} event.  The
 * SCANNING logic (opendir, sha_hex_name, read_entry_file, model_id filter,
 * qsort) is copied verbatim from agent_worker_list_sessions; only the printf
 * rendering is replaced by the JSON event.  Emitted even when empty. */
static void design_list_sessions(design_agent *a) {
    size_t title_budget = 160;
    design_session_list_item *sessions = NULL;
    int sessions_len = 0, sessions_cap = 0;
    const uint8_t model_id = (uint8_t)ds4_engine_model_id(a->engine);

    DIR *d = opendir(a->cache_dir);
    if (d) {
        struct dirent *de;
        while ((de = readdir(d)) != NULL) {
            char sha[41];
            if (!ds4_kvstore_sha_hex_name(de->d_name, sha)) continue;
            char *path = ds4_kvstore_path_join(a->cache_dir, de->d_name);
            ds4_kvstore_entry e = {0};
            if (ds4_kvstore_read_entry_file(path, sha, &e)) {
                if (e.model_id == model_id) {
                    char *title = design_session_title_from_file(path, title_budget);
                    design_session_list_push(&sessions, &sessions_len,
                                             &sessions_cap, e, title);
                } else {
                    ds4_kvstore_entry_free(&e);
                }
            }
            free(path);
        }
        closedir(d);
    }

    if (sessions_len)
        qsort(sessions, (size_t)sessions_len, sizeof(sessions[0]),
              design_session_list_cmp_recent);

    if (g_jsonl) {
        design_buf b = {0};
        buf_puts(&b, "\x1e{\"type\":\"sessions\",\"sessions\":[");
        for (int i = 0; i < sessions_len; i++) {
            ds4_kvstore_entry *e = &sessions[i].entry;
            char age[32];
            design_format_age(e->last_used ? e->last_used : e->created_at,
                              age, sizeof(age));
            char mb[32];
            snprintf(mb, sizeof(mb), "%.2f",
                     (double)e->file_size / (1024.0 * 1024.0));
            bool current = a->session_sha[0] &&
                           strncmp(e->sha, a->session_sha, 8) == 0;
            if (i) buf_puts(&b, ",");
            buf_puts(&b, "{\"sha\":\"");
            json_escape_buf(&b, e->sha, 8);
            buf_puts(&b, "\",\"title\":\"");
            json_escape_buf(&b, sessions[i].title ? sessions[i].title : "",
                            sessions[i].title ? strlen(sessions[i].title) : 0);
            buf_puts(&b, "\",\"age\":\"");
            json_escape_buf(&b, age, strlen(age));
            buf_puts(&b, "\",\"tokens\":");
            char num[32];
            snprintf(num, sizeof(num), "%u", e->tokens);
            buf_puts(&b, num);
            buf_puts(&b, ",\"mb\":");
            buf_puts(&b, mb);
            buf_puts(&b, ",\"current\":");
            buf_puts(&b, current ? "true" : "false");
            buf_puts(&b, "}");
        }
        buf_puts(&b, "]}\n");
        emit_event_line(&b);
    }

    design_session_list_free(sessions, sessions_len);
}

/* ---- save / switch / delete / new ---- */

/* Save the live transcript + KV under the session identity.  The title (and
 * created_at) are set by the caller on the first turn; if still unset here we
 * derive a title from the rendered transcript so an explicit /save before any
 * turn-driven titling still works. */
static bool design_session_save_now(design_agent *a, char sha_out[41],
                                    int *tokens_out, char *err, size_t err_len) {
    if (a->transcript.len == 0) {
        snprintf(err, err_len, "nothing to save");
        return false;
    }
    if (design_sync_tokens(a, &a->transcript, err, err_len) != 0)
        return false;
    if (!design_mkdir_p(a->cache_dir)) {
        snprintf(err, err_len, "failed to create %s", a->cache_dir);
        return false;
    }

    size_t text_len = 0;
    char *text = ds4_kvstore_render_tokens_text(a->engine, &a->transcript,
                                                &text_len);
    if (!text) {
        snprintf(err, err_len, "failed to render session text");
        return false;
    }
    if (!a->session_title)
        a->session_title = design_session_title_from_text(text, text_len, 0);
    if (a->session_created_at == 0)
        a->session_created_at = (uint64_t)time(NULL);

    char sha[41];
    design_session_identity_sha(a->session_title, a->session_created_at, sha);
    char *path = design_kv_path_for_sha(a->cache_dir, sha);

    bool ok = design_kv_save_path(a, path, &a->transcript,
                                  "agent-session", sha_out,
                                  a->session_title, a->session_created_at,
                                  err, err_len);
    if (ok) {
        memcpy(a->session_sha, sha, sizeof(a->session_sha));
        if (tokens_out) *tokens_out = a->transcript.len;
        design_buf ev = {0};
        char n[32];
        buf_puts(&ev, "{\"sha\":\"");
        json_escape_buf(&ev, sha, 8);
        buf_puts(&ev, "\",\"tokens\":");
        snprintf(n, sizeof(n), "%d", a->transcript.len);
        buf_puts(&ev, n);
        buf_puts(&ev, "}");
        design_event_log(&a->project, "session_saved", ev.ptr);
        free(ev.ptr);
    }
    free(path);
    free(text);
    return ok;
}

static bool design_session_save(design_agent *a, char *err, size_t err_len) {
    char sha[41];
    int tokens = 0;
    bool ok = design_session_save_now(a, sha, &tokens, err, err_len);
    if (ok) fprintf(stderr, "ds4-design: saved session %.8s (%d tokens)\n",
                    sha, tokens);
    return ok;
}

/* Resolve a user-provided SHA prefix to exactly one saved session file. */
static bool design_find_session(design_agent *a, const char *prefix,
                                char sha_out[41], char **path_out,
                                char *err, size_t err_len) {
    size_t plen = strlen(prefix);
    if (plen == 0 || plen > 40) {
        snprintf(err, err_len, "invalid session SHA prefix");
        return false;
    }
    for (size_t i = 0; i < plen; i++) {
        if (!isxdigit((unsigned char)prefix[i])) {
            snprintf(err, err_len, "invalid session SHA prefix");
            return false;
        }
    }

    DIR *d = opendir(a->cache_dir);
    if (!d) {
        snprintf(err, err_len, "%s", strerror(errno));
        return false;
    }
    int matches = 0;
    char match_sha[41] = {0};
    char *match_path = NULL;
    const uint8_t model_id = (uint8_t)ds4_engine_model_id(a->engine);
    struct dirent *de;
    while ((de = readdir(d)) != NULL) {
        char sha[41];
        if (!ds4_kvstore_sha_hex_name(de->d_name, sha)) continue;
        if (strncasecmp(sha, prefix, plen) != 0) continue;
        char *path = ds4_kvstore_path_join(a->cache_dir, de->d_name);
        ds4_kvstore_entry e = {0};
        bool same_model = ds4_kvstore_read_entry_file(path, sha, &e) &&
                          e.model_id == model_id;
        ds4_kvstore_entry_free(&e);
        if (!same_model) {
            free(path);
            continue;
        }
        matches++;
        if (matches == 1) {
            memcpy(match_sha, sha, sizeof(match_sha));
            match_path = path;
        } else {
            free(path);
        }
    }
    closedir(d);
    if (matches == 0) {
        snprintf(err, err_len, "no saved session matches %.40s", prefix);
        return false;
    }
    if (matches > 1) {
        snprintf(err, err_len, "session prefix %.40s is ambiguous", prefix);
        free(match_path);
        return false;
    }
    memcpy(sha_out, match_sha, 41);
    *path_out = match_path;
    return true;
}

static bool design_session_delete(design_agent *a, const char *prefix,
                                  char sha_out[41],
                                  char *err, size_t err_len) {
    char sha[41];
    char *path = NULL;
    if (!design_find_session(a, prefix, sha, &path, err, err_len))
        return false;
    if (unlink(path) != 0) {
        snprintf(err, err_len, "%s", strerror(errno));
        free(path);
        return false;
    }
    if (sha_out) memcpy(sha_out, sha, 41);
    free(path);
    return true;
}

/* Load a saved session KV into the live transcript. */
static bool design_session_switch(design_agent *a, const char *prefix,
                                  char *err, size_t err_len) {
    char sha[41];
    char *path = NULL;
    if (!design_find_session(a, prefix, sha, &path, err, err_len))
        return false;

    bool stripped = false;
    ds4_kvstore_entry entry = {0};
    if (ds4_kvstore_read_entry_file(path, sha, &entry)) {
        stripped = entry.payload_bytes == 0;
        ds4_kvstore_entry_free(&entry);
    }
    if (stripped)
        fprintf(stderr, "ds4-design: rebuilding stripped session %.8s "
                "from rendered text...\n", sha);

    ds4_tokens loaded = {0};
    design_kv_session_meta meta = {0};
    bool ok = design_kv_load_path(a, path, sha, NULL, 0, &loaded, &meta,
                                  err, err_len);
    if (ok) {
        ds4_tokens_free(&a->transcript);
        a->transcript = loaded;
        free(a->session_title);
        a->session_title = meta.title ? xstrdup(meta.title) : xstrdup("(no user prompt)");
        a->session_created_at = meta.created_at ? meta.created_at : (uint64_t)time(NULL);
        memcpy(a->session_sha, sha, sizeof(a->session_sha));
        fprintf(stderr, "ds4-design: switched to session %.8s (%d tokens%s)\n",
                sha, a->transcript.len, stripped ? ", rebuilt from text" : "");
    } else {
        ds4_tokens_free(&loaded);
    }
    design_kv_session_meta_free(&meta);
    free(path);
    return ok;
}

/* Forward-declared: design_session_new rebuilds the system-prompt transcript,
 * which is the same bootstrap main() does.  Defined after run_turn alongside
 * the bootstrap helper. */
static int design_build_system_transcript(design_agent *a, char *err, size_t err_len);
static void design_build_system_tokens(design_agent *a, ds4_tokens *out);

static bool design_session_new(design_agent *a, char *err, size_t err_len) {
    if (design_build_system_transcript(a, err, err_len) != 0)
        return false;
    a->session_sha[0] = '\0';
    free(a->session_title);
    a->session_title = NULL;
    a->session_created_at = 0;
    a->project.discovery_satisfied = false;
    design_project_clear_run_progress(&a->project);
    return true;
}

/* ============================================================================
 * Context Compaction — ported from ds4_agent.c
 * ============================================================================
 *
 * Compaction asks DS4 for durable task state, then rebuilds the transcript as:
 * system prompt + compact summary + recent verbatim tail.  This is intentionally
 * the same mechanism as antirez's agent, without worker threads/status mutexes.
 */

static bool design_should_compact(design_agent *a) {
    int ctx = a->cfg->ctx_size;
    int used = a->transcript.len;
    if (ctx <= 0 || used <= 0) return false;
    if (used >= (ctx * DESIGN_COMPACT_SOFT_PERCENT) / 100) return true;
    int free_threshold = DESIGN_COMPACT_MIN_FREE_TOKENS;
    int proportional = ctx / 4;
    if (free_threshold > proportional) free_threshold = proportional;
    return ctx - used <= free_threshold;
}

static int design_special_token_id(ds4_engine *engine, const char *rendered) {
    ds4_tokens t = {0};
    ds4_tokenize_rendered_chat(engine, rendered, &t);
    int id = t.len == 1 ? t.v[0] : -1;
    ds4_tokens_free(&t);
    return id;
}

static int design_compact_tail_start(design_agent *a, int bottom, int sys_len) {
    int tail_budget = a->cfg->ctx_size / DESIGN_COMPACT_TAIL_DIVISOR;
    if (tail_budget > DESIGN_COMPACT_TAIL_CAP_TOKENS)
        tail_budget = DESIGN_COMPACT_TAIL_CAP_TOKENS;
    if (tail_budget < 1) tail_budget = 1;

    int target = bottom - tail_budget;
    if (target < sys_len) target = sys_len;

    int user_id = design_special_token_id(a->engine, "<｜User｜>");
    if (user_id < 0) return target;

    for (int i = target; i < bottom; i++) {
        if (a->transcript.v[i] == user_id) return i;
    }
    return target;
}

static void design_tokens_append_range(ds4_tokens *dst, const ds4_tokens *src,
                                       int start, int end) {
    if (start < 0) start = 0;
    if (end > src->len) end = src->len;
    for (int i = start; i < end; i++) ds4_tokens_push(dst, src->v[i]);
}

static char *design_compact_make_prompt(const char *reason) {
    design_buf b = {0};
    buf_puts(&b,
        "Internal ds4-design context compaction request. This is not a user request.\n"
        "Write a durable task-state summary of the conversation so far. Preserve only facts that matter for continuing the work:\n"
        "- user goals, constraints, and preferences\n"
        "- files inspected or edited\n"
        "- commands run and important results\n"
        "- decisions, rejected approaches, known bugs, and pending next steps\n"
        "- reloadable bulky data with exact paths/ranges/commands when available\n\n"
        "Do not invent facts. Do not include generic narration. Do not include raw file contents unless they were essential to a conclusion.\n"
        "After the summary, stop. Do not continue the user task, do not call tools, and do not output thinking tags or DSML markup.\n"
        "Output only the compact summary.\n");
    if (reason && reason[0]) {
        buf_puts(&b, "\nCompaction reason: ");
        buf_puts(&b, reason);
        buf_puts(&b, "\n");
    }
    return buf_take(&b);
}

static char *design_bash_jobs_compaction_observation(design_project *pr) {
    if (!pr->bash_jobs) return NULL;
    design_buf out = {0};
    buf_puts(&out,
        "Bash job update after context compaction. Running jobs still need explicit bash_status or bash_stop if relevant.\n");
    for (design_bash_job *job = pr->bash_jobs; job; job = job->next) {
        char *obs = design_bash_observation(job, true);
        char hdr[64];
        snprintf(hdr, sizeof(hdr), "\nJob %d:\n", job->id);
        buf_puts(&out, hdr);
        buf_puts(&out, obs);
        free(obs);
    }
    return buf_take(&out);
}

static bool design_tool_result_fits_context(design_agent *a, const char *result,
                                            int reserve_tokens,
                                            int *tokens_out) {
    ds4_tokens tmp = {0};
    ds4_tokens_copy(&tmp, &a->transcript);
    ds4_chat_append_message(a->engine, &tmp, "tool", result ? result : "");
    int tokens = tmp.len;
    ds4_tokens_free(&tmp);
    if (tokens_out) *tokens_out = tokens;
    return tokens + reserve_tokens < a->cfg->ctx_size;
}

static void design_log_compact_event(design_project *pr, const char *type,
                                     const char *reason, int old_tokens,
                                     int new_tokens, int tail_tokens,
                                     const char *error) {
    design_buf ev = {0};
    char n[32];
    buf_puts(&ev, "{\"reason\":\"");
    json_escape_buf(&ev, reason ? reason : "", reason ? strlen(reason) : 0);
    buf_puts(&ev, "\",\"old_tokens\":");
    snprintf(n, sizeof(n), "%d", old_tokens);
    buf_puts(&ev, n);
    buf_puts(&ev, ",\"new_tokens\":");
    snprintf(n, sizeof(n), "%d", new_tokens);
    buf_puts(&ev, n);
    buf_puts(&ev, ",\"tail_tokens\":");
    snprintf(n, sizeof(n), "%d", tail_tokens);
    buf_puts(&ev, n);
    if (error && error[0]) {
        buf_puts(&ev, ",\"error\":\"");
        json_escape_buf(&ev, error, strlen(error));
        buf_puts(&ev, "\"");
    }
    buf_puts(&ev, "}");
    design_event_log(pr, type, ev.ptr);
    free(ev.ptr);
}

static bool design_agent_compact(design_agent *a, const char *reason,
                                 char *err, size_t err_len) {
    const int bottom = a->transcript.len;
    if (bottom <= 0) return true;

    ds4_tokens sys = {0};
    design_build_system_tokens(a, &sys);
    if (bottom <= sys.len) {
        ds4_tokens_free(&sys);
        return true;
    }

    design_log_compact_event(&a->project, "compact_started",
                             reason ? reason : "context", bottom, 0, 0, NULL);

    char line[512];
    snprintf(line, sizeof(line),
             "\n\x1b[1;95mCOMPACTING\x1b[0m %s: summarizing durable task state\n\x1b[38;5;245m",
             reason && reason[0] ? reason : "context");
    out_text(line, strlen(line));

    char *prompt_text = design_compact_make_prompt(reason);
    ds4_tokens prompt = {0};
    ds4_tokens_copy(&prompt, &a->transcript);
    ds4_chat_append_message(a->engine, &prompt, "user", prompt_text);
    free(prompt_text);
    ds4_chat_append_assistant_prefix(a->engine, &prompt, DS4_THINK_NONE);

    int summary_room = a->cfg->ctx_size - prompt.len - 1;
    if (summary_room < 256) {
        snprintf(err, err_len, "not enough context left to request compaction summary");
        ds4_tokens_free(&prompt);
        ds4_tokens_free(&sys);
        out_text("\x1b[0m\n", 5);
        design_log_compact_event(&a->project, "compact_failed",
                                 reason, bottom, 0, 0, err);
        return false;
    }
    int summary_max = summary_room < DESIGN_COMPACT_SUMMARY_MAX_TOKENS ?
                      summary_room : DESIGN_COMPACT_SUMMARY_MAX_TOKENS;

    int sync_rc = design_sync_tokens(a, &prompt, err, err_len);
    if (sync_rc != 0) {
        ds4_session_invalidate(a->session);
        ds4_tokens_free(&prompt);
        ds4_tokens_free(&sys);
        out_text("\x1b[0m\n", 5);
        design_log_compact_event(&a->project, "compact_failed",
                                 reason, bottom, 0, 0, err);
        return false;
    }

    design_buf summary = {0};
    char eval_err[160] = {0};
    int think_end_id = design_special_token_id(a->engine, "</think>");
    int dsml_id = design_special_token_id(a->engine, "｜DSML｜");
    for (int i = 0; i < summary_max; i++) {
        int token = ds4_session_argmax(a->session);
        if (token == ds4_token_eos(a->engine)) break;
        if (token == think_end_id || token == dsml_id) {
            if (token == dsml_id && summary.len && summary.ptr[summary.len - 1] == '<')
                summary.ptr[--summary.len] = '\0';
            break;
        }
        if (ds4_session_eval(a->session, token, eval_err, sizeof(eval_err)) != 0) {
            snprintf(err, err_len, "%s", eval_err);
            ds4_session_invalidate(a->session);
            ds4_tokens_free(&prompt);
            ds4_tokens_free(&sys);
            free(summary.ptr);
            out_text("\x1b[0m\n", 5);
            design_log_compact_event(&a->project, "compact_failed",
                                     reason, bottom, 0, 0, err);
            return false;
        }

        size_t text_len = 0;
        char *text = ds4_token_text(a->engine, token, &text_len);
        buf_append(&summary, text, text_len);
        out_text(text, text_len);
        free(text);
    }
    out_text("\x1b[0m\n", 5);
    ds4_tokens_free(&prompt);

    if (!summary.ptr || !summary.ptr[0]) {
        snprintf(err, err_len, "compaction summary was empty");
        ds4_session_invalidate(a->session);
        ds4_tokens_free(&sys);
        free(summary.ptr);
        design_log_compact_event(&a->project, "compact_failed",
                                 reason, bottom, 0, 0, err);
        return false;
    }

    int tail_start = design_compact_tail_start(a, bottom, sys.len);
    ds4_tokens compacted = {0};
    ds4_tokens_copy(&compacted, &sys);

    design_buf summary_msg = {0};
    buf_puts(&summary_msg,
        "\n\n[ds4-design compacted earlier conversation. Durable task-state summary follows.]\n");
    buf_puts(&summary_msg, summary.ptr);
    if (summary_msg.len && summary_msg.ptr[summary_msg.len - 1] != '\n')
        buf_puts(&summary_msg, "\n");
    buf_puts(&summary_msg,
        "[End compacted summary. Recent conversation continues verbatim below.]\n\n");
    ds4_chat_append_message(a->engine, &compacted, "system", summary_msg.ptr);
    free(summary_msg.ptr);

    design_tokens_append_range(&compacted, &a->transcript, tail_start, bottom);

    snprintf(line, sizeof(line),
             "\x1b[1;95mCOMPACTING\x1b[0m rebuilding context: old=%d summary+tail=%d tail=%d\n",
             bottom, compacted.len, bottom - tail_start);
    out_text(line, strlen(line));

    ds4_tokens old_transcript = {0};
    ds4_tokens_copy(&old_transcript, &a->transcript);
    ds4_tokens_free(&a->transcript);
    a->transcript = compacted;
    if (design_sync_tokens(a, &a->transcript, err, err_len) != 0) {
        ds4_session_invalidate(a->session);
        ds4_tokens_free(&a->transcript);
        a->transcript = old_transcript;
        ds4_tokens_free(&sys);
        free(summary.ptr);
        design_log_compact_event(&a->project, "compact_failed",
                                 reason, bottom, 0, 0, err);
        return false;
    }
    ds4_tokens_free(&old_transcript);
    ds4_tokens_free(&sys);

    design_set_compact_memory(&a->project, summary.ptr);
    int new_tokens = a->transcript.len;
    int tail_tokens = bottom - tail_start;
    free(summary.ptr);

    char *bash_update = design_bash_jobs_compaction_observation(&a->project);
    if (bash_update) {
        ds4_chat_append_message(a->engine, &a->transcript, "tool", bash_update);
        out_text("\x1b[90mCOMPACTING added bash job update after rebuild\x1b[0m\n",
                 strlen("\x1b[90mCOMPACTING added bash job update after rebuild\x1b[0m\n"));
        free(bash_update);
    }

    design_log_compact_event(&a->project, "compact_completed",
                             reason, bottom, new_tokens, tail_tokens, NULL);
    return true;
}

static bool design_compact_if_needed(design_agent *a, const char *reason,
                                     char *err, size_t err_len) {
    if (!design_should_compact(a)) return true;
    return design_agent_compact(a, reason, err, err_len);
}

/* One user turn: any number of assistant/tool rounds until the model answers
 * without a tool call.  The transcript is the single source of truth, exactly
 * like ds4-agent's worker_run_turn, minus the worker thread. */
static int run_turn(design_agent *a, const char *user_text) {
    ds4_think_mode think_mode = agent_think_mode(a);
    char compact_err[160] = {0};
    if (!design_compact_if_needed(a, "soft limit before user turn",
                                  compact_err, sizeof(compact_err)))
    {
        fprintf(stderr, "ds4-design: context compaction failed: %s\n",
                compact_err[0] ? compact_err : "unknown error");
        return 1;
    }
    /* First user turn of a session: derive its stable identity (title +
     * created_at + sha) from the opening prompt, exactly like ds4-agent.  This
     * is what the post-turn save keys the on-disk file on. */
    if (!a->session_title) {
        a->session_title = design_session_title_from_prompt(user_text, 0);
        a->session_created_at = (uint64_t)time(NULL);
        design_session_identity_sha(a->session_title, a->session_created_at,
                                    a->session_sha);
    }
    design_project_start_run(&a->project, user_text);
    ds4_chat_append_message(a->engine, &a->transcript, "user", user_text);

    uint64_t rng = a->cfg->seed ? a->cfg->seed :
        ((uint64_t)time(NULL) ^ ((uint64_t)getpid() << 32));

    for (int tool_round = 0; ; tool_round++) {
        if (tool_round > 0 &&
            !design_compact_if_needed(a, "soft limit before tool continuation",
                                      compact_err, sizeof(compact_err)))
        {
            fprintf(stderr, "ds4-design: context compaction failed: %s\n",
                    compact_err[0] ? compact_err : "unknown error");
            return 1;
        }
        ds4_chat_append_assistant_prefix(a->engine, &a->transcript, think_mode);
        /* With thinking on, the assistant prefix opens <think>: the round
         * starts inside reasoning and leaves it at the </think> token. */
        bool in_think = ds4_think_mode_enabled(think_mode);
        if (in_think) emit_event("reasoning_start");

        char err[160];
        int sync_rc = ds4_session_sync(a->session, &a->transcript, err, sizeof(err));
        if (sync_rc != 0) {
            fprintf(stderr, "ds4-design: prefill failed: %s\n", err);
            return 1;
        }

        int max_tokens = a->cfg->n_predict;
        int room = ds4_session_ctx(a->session) - ds4_session_pos(a->session);
        if (room <= 1) max_tokens = 0;
        else if (max_tokens > room - 1) max_tokens = room - 1;

        dsml_parser dsml;
        memset(&dsml, 0, sizeof(dsml));
        dsml.state = DSML_SEARCH;
        design_stream stream = { .parser = &dsml, .hold_len = 0, .suppressed = false };
        bool got_tool = false;
        bool malformed_tool = false;
        int generated = 0;

        while (generated < max_tokens) {
            bool greedy = stream_wants_greedy(&stream);
            int token = ds4_session_sample(a->session,
                                           greedy ? 0.0f : a->cfg->temperature,
                                           0,
                                           greedy ? 1.0f : a->cfg->top_p,
                                           greedy ? 0.0f : a->cfg->min_p,
                                           &rng);
            if (token == ds4_token_eos(a->engine)) break;
            if (ds4_session_eval(a->session, token, err, sizeof(err)) != 0) {
                dsml_parser_free(&dsml);
                fprintf(stderr, "ds4-design: eval failed: %s\n", err);
                return 1;
            }
            ds4_tokens_push(&a->transcript, token);
            size_t text_len = 0;
            char *text = ds4_token_text(a->engine, token, &text_len);
            /* The think delimiters are single tokens: turn them into UI
             * events instead of streaming the raw tags (jsonl mode only). */
            if (g_jsonl && text_len == 7 && !memcmp(text, "<think>", 7)) {
                if (!in_think) { in_think = true; emit_event("reasoning_start"); }
            } else if (g_jsonl && text_len == 8 && !memcmp(text, "</think>", 8)) {
                if (in_think) { in_think = false; emit_event("reasoning_end"); }
            } else {
                stream_text(&stream, text, text_len);
            }
            free(text);
            generated++;

            if (dsml.state == DSML_DONE) { got_tool = true; break; }
            if (dsml.state == DSML_ERROR) { malformed_tool = true; break; }
        }

        stream_finish(&stream);
        if (in_think) emit_event("reasoning_end"); /* EOS while still thinking */
        /* Incomplete stanza at EOS or token budget: retryable tool error. */
        if (!got_tool && !malformed_tool &&
            (dsml.state == DSML_STRUCTURAL || dsml.state == DSML_PARAM_VALUE))
        {
            malformed_tool = true;
            snprintf(dsml.error, sizeof(dsml.error), "incomplete DSML tool call");
        }

        ds4_tokens_push(&a->transcript, ds4_token_eos(a->engine));

        if (!got_tool && !malformed_tool) {
            out_text("\n", 1);
            dsml_parser_free(&dsml);
            design_project_finish_run(&a->project, "ok");
            return 0;
        }

        char *tool_result;
        if (malformed_tool) {
            design_buf b = {0};
            buf_puts(&b, "Tool error: invalid DSML tool call: ");
            buf_puts(&b, dsml.error[0] ? dsml.error : "parse error");
            buf_puts(&b, "\n");
            buf_puts(&b, dsml_syntax_reminder);
            tool_result = buf_take(&b);
        } else {
            tool_result = execute_tool_calls(&a->project, &dsml.calls);
        }
        int projected_tokens = 0;
        if (!design_tool_result_fits_context(a, tool_result,
                                             DESIGN_TOOL_RESULT_RESERVE_TOKENS,
                                             &projected_tokens))
        {
            if (!design_agent_compact(a, "tool result would exceed context",
                                      compact_err, sizeof(compact_err)))
            {
                free(tool_result);
                dsml_parser_free(&dsml);
                fprintf(stderr, "ds4-design: context compaction failed: %s\n",
                        compact_err[0] ? compact_err : "unknown error");
                return 1;
            }
            if (!design_tool_result_fits_context(a, tool_result,
                                                 DESIGN_TOOL_RESULT_RESERVE_TOKENS,
                                                 &projected_tokens))
            {
                free(tool_result);
                design_buf b = {0};
                char msg[256];
                snprintf(msg, sizeof(msg),
                         "Tool error: tool result still does not fit after context compaction "
                         "(projected_prompt=%d tokens, ctx=%d, reserve=%d). "
                         "Retry with a smaller read/search/bash output.\n",
                         projected_tokens, a->cfg->ctx_size,
                         DESIGN_TOOL_RESULT_RESERVE_TOKENS);
                buf_puts(&b, msg);
                tool_result = buf_take(&b);
                if (!design_tool_result_fits_context(a, tool_result, 16, NULL)) {
                    free(tool_result);
                    dsml_parser_free(&dsml);
                    fprintf(stderr, "ds4-design: context full after compaction\n");
                    return 1;
                }
            }
        }
        ds4_chat_append_message(a->engine, &a->transcript, "tool", tool_result);
        free(tool_result);
        dsml_parser_free(&dsml);
        if (a->project.stop_after_tools) {
            a->project.stop_after_tools = false;
            out_text("\n", 1);
            design_project_finish_run(&a->project, "stopped_after_tool");
            return 0;
        }
    }
}

/* Rebuild the transcript at the system/tool prompt and prefill it into the
 * live session.  This is the exact bootstrap main() runs on startup; /new
 * reuses it to drop the current conversation back to a fresh session without
 * restarting the process.  Returns 0 on success. */
static void design_build_system_tokens(design_agent *a, ds4_tokens *out) {
    design_config *cfg = a->cfg;
    ds4_chat_begin(a->engine, out);
    if (cfg->think_mode == DS4_THINK_MAX && agent_think_mode(a) == DS4_THINK_MAX)
        ds4_chat_append_max_effort_prefix(a->engine, out);
    ds4_tokenize_rendered_chat(a->engine, design_system_prompt, out);
    char *pm = design_read_project_memory(&a->project);
    if (pm && pm[0]) {
        design_buf mem = {0};
        buf_puts(&mem, "PROJECT MEMORY (runtime summary from MEMORY.MD):\n\n");
        buf_puts(&mem, pm);
        ds4_chat_append_message(a->engine, out, "system", mem.ptr ? mem.ptr : "");
        free(mem.ptr);
    }
    free(pm);
    if (cfg->extra_system && cfg->extra_system[0]) {
        /* User text must stay plain content, never DSML control tokens. */
        ds4_chat_append_message(a->engine, out, "system", cfg->extra_system);
    }
}

static int design_build_system_transcript(design_agent *a, char *err, size_t err_len) {
    ds4_tokens sys = {0};
    design_build_system_tokens(a, &sys);
    ds4_tokens_free(&a->transcript);
    a->transcript = sys;
    if (ds4_session_sync(a->session, &a->transcript, err, err_len) != 0)
        return 1;
    return 0;
}

/* ============================================================================
 * Headless Stdin Loop
 * ============================================================================
 *
 * Same contract as ds4-agent --non-interactive: bytes are accumulated until a
 * 200ms quiet gap, then handed to the model as one prompt, so multi-line
 * prompts written by a launcher pipe arrive whole.  "+DWARFSTAR_WAITING" on
 * stderr announces idleness before blocking on stdin.
 */

static bool read_prompt(design_buf *input) {
    bool announced = false;
    double quiet_deadline = 0.0;

    for (;;) {
        if (input->len == 0 && !announced) {
            marker("+DWARFSTAR_WAITING");
            announced = true;
        }
        int timeout_ms = -1;
        if (input->len > 0) {
            double rem = quiet_deadline - now_sec();
            if (rem <= 0.0) return true;
            timeout_ms = (int)(rem * 1000.0) + 1;
        }
        struct pollfd pfd = { .fd = STDIN_FILENO, .events = POLLIN };
        int prc = poll(&pfd, 1, timeout_ms);
        if (prc < 0) {
            if (errno == EINTR) continue;
            return input->len > 0;
        }
        if (prc == 0) return input->len > 0; /* quiet gap elapsed */
        char chunk[4096];
        ssize_t n = read(STDIN_FILENO, chunk, sizeof(chunk));
        if (n <= 0) return input->len > 0; /* EOF: flush or stop */
        buf_append(input, chunk, (size_t)n);
        quiet_deadline = now_sec() + 0.2;
    }
}

/* ============================================================================
 * Self-test
 * ============================================================================
 *
 * Runtime contract tests that do not open a model. They cover the pieces the
 * UI relies on: normalized todos, JSON validation, artifact gates, and manifest
 * sidecars.
 */

static int selftest_expect(bool cond, const char *msg) {
    if (cond) return 0;
    fprintf(stderr, "ds4-design self-test failed: %s\n", msg);
    return 1;
}

static int design_run_self_test(void) {
    int fails = 0;
    char err[256];

    char *norm = NULL;
    int items = 0;
    bool has_ip = false;
    fails += selftest_expect(
        todo_parse_and_normalize("[{\"content\":\"Build page\",\"status\":\"in_progress\"},"
                                 "{\"step\":\"Ship\",\"status\":\"completed\"}]",
                                 &norm, &items, &has_ip, err, sizeof(err)) &&
        items == 2 && has_ip && strstr(norm, "\"text\":\"Build page\"") &&
        strstr(norm, "\"status\":\"in_progress\""),
        "todo_write normalizes content/step/status");
    free(norm);
    norm = NULL;
    fails += selftest_expect(
        !todo_parse_and_normalize("[{\"text\":\"Bad\",\"status\":\"running\"}]",
                                  &norm, &items, &has_ip, err, sizeof(err)),
        "todo_write rejects invalid status");
    free(norm);

    fails += selftest_expect(
        json_validate_complete("[{\"id\":\"tone\",\"label\":\"Tone\"}]", '[', err, sizeof(err)),
        "question JSON array validates");

    design_string_list exports = {0};
    fails += selftest_expect(
        json_parse_string_array("[\"html\",\"pdf\",\"zip\"]", &exports, err, sizeof(err)) &&
        exports.len == 3 && !strcmp(exports.v[1], "pdf"),
        "JSON string array parser");
    design_string_list_free(&exports);

    char dir[PATH_MAX];
    snprintf(dir, sizeof(dir), "/tmp/ds4-design-self-test-%ld", (long)getpid());
    unlink(dir);
    if (mkdir(dir, 0700) != 0 && errno != EEXIST) {
        fprintf(stderr, "ds4-design self-test failed: mkdir %s: %s\n", dir, strerror(errno));
        return 1;
    }
    design_project pr;
    memset(&pr, 0, sizeof(pr));
    snprintf(pr.dir, sizeof(pr.dir), "%s", dir);
    design_project_bootstrap(&pr);
    design_event_log(&pr, "self_test", "{\"ok\":true}");
    fails += selftest_expect(pr.event_seq >= 1, "event log increments sequence");
    char root_mem_path[PATH_MAX];
    snprintf(root_mem_path, sizeof(root_mem_path), "%s/MEMORY.MD", dir);
    char *mem_body = NULL;
    size_t mem_len = 0;
    fails += selftest_expect(
        read_file_bytes(root_mem_path, &mem_body, &mem_len, err, sizeof(err)) == 0 &&
        strstr(mem_body, "# MEMORY.MD") != NULL,
        "MEMORY.MD is written at project root");
    free(mem_body);
    mem_body = NULL;
    design_set_compact_memory(&pr, "Remember the user's design constraints.");
    design_write_project_memory(&pr);
    fails += selftest_expect(
        read_file_bytes(root_mem_path, &mem_body, &mem_len, err, sizeof(err)) == 0 &&
        strstr(mem_body, "Remember the user's design constraints.") != NULL,
        "MEMORY.MD preserves compact summary");
    char *durable = design_memory_extract_durable_summary(mem_body ? mem_body : "");
    fails += selftest_expect(
        strstr(durable, "Remember the user's design constraints.") != NULL,
        "MEMORY.MD durable summary parser");
    free(durable);
    free(mem_body);

    char pack_dir[PATH_MAX], pack_skill_root[PATH_MAX], pack_err[256];
    snprintf(pack_dir, sizeof(pack_dir), "%s/packs", dir);
    snprintf(pack_skill_root, sizeof(pack_skill_root), "%s/skills/demo", pack_dir);
    fails += selftest_expect(design_mkdir_p(pack_skill_root),
                             "pack test root mkdir");
    char pack_skill_md[PATH_MAX], pack_template[PATH_MAX], pack_checklist[PATH_MAX];
    snprintf(pack_skill_md, sizeof(pack_skill_md), "%s/SKILL.md", pack_skill_root);
    snprintf(pack_template, sizeof(pack_template), "%s/assets/template.html", pack_skill_root);
    snprintf(pack_checklist, sizeof(pack_checklist), "%s/references/checklist.md", pack_skill_root);
    const char demo_skill[] = "---\nname: demo\n---\n# Demo skill\n";
    const char demo_template[] = "<!doctype html><title>Seed</title>";
    const char demo_checklist[] = "# Checklist\n- P0 pass\n";
    fails += selftest_expect(write_file_bytes(pack_skill_md, demo_skill, strlen(demo_skill),
                                              pack_err, sizeof(pack_err)),
                             "pack SKILL.md fixture writes");
    fails += selftest_expect(write_file_bytes(pack_template, demo_template, strlen(demo_template),
                                              pack_err, sizeof(pack_err)),
                             "pack assets/template.html fixture writes");
    fails += selftest_expect(write_file_bytes(pack_checklist, demo_checklist, strlen(demo_checklist),
                                              pack_err, sizeof(pack_err)),
                             "pack references/checklist.md fixture writes");
    setenv("DS4UI_SKILLS_DIR", pack_dir, 1);

    design_tool_call skill_call = {0};
    skill_call.name = xstrdup("skill");
    tool_call_add_arg(&skill_call, "name", "demo", strlen("demo"), true);
    char *skill_res = execute_tool_call(&pr, &skill_call);
    fails += selftest_expect(strstr(skill_res, "assets/template.html") != NULL &&
                             strstr(skill_res, "references/checklist.md") != NULL,
                             "skill() lists pack_file inventory");
    free(skill_res);
    tool_call_free(&skill_call);

    design_tool_call pf_call = {0};
    pf_call.name = xstrdup("pack_file");
    tool_call_add_arg(&pf_call, "type", "skill", strlen("skill"), true);
    tool_call_add_arg(&pf_call, "name", "demo", strlen("demo"), true);
    tool_call_add_arg(&pf_call, "path", "assets/template.html", strlen("assets/template.html"), true);
    char *pf_res = execute_tool_call(&pr, &pf_call);
    fails += selftest_expect(strstr(pf_res, "Seed") != NULL,
                             "pack_file reads allowlisted template");
    free(pf_res);
    tool_call_free(&pf_call);

    memset(&pf_call, 0, sizeof(pf_call));
    pf_call.name = xstrdup("pack_file");
    tool_call_add_arg(&pf_call, "type", "skill", strlen("skill"), true);
    tool_call_add_arg(&pf_call, "name", "demo", strlen("demo"), true);
    tool_call_add_arg(&pf_call, "path", "../SKILL.md", strlen("../SKILL.md"), true);
    pf_res = execute_tool_call(&pr, &pf_call);
    fails += selftest_expect(strstr(pf_res, "Tool error") != NULL,
                             "pack_file blocks traversal paths");
    free(pf_res);
    tool_call_free(&pf_call);

    char pack_link[PATH_MAX];
    snprintf(pack_link, sizeof(pack_link), "%s/assets/escape.md", pack_skill_root);
    if (symlink("/etc/passwd", pack_link) == 0) {
        memset(&pf_call, 0, sizeof(pf_call));
        pf_call.name = xstrdup("pack_file");
        tool_call_add_arg(&pf_call, "type", "skill", strlen("skill"), true);
        tool_call_add_arg(&pf_call, "name", "demo", strlen("demo"), true);
        tool_call_add_arg(&pf_call, "path", "assets/escape.md", strlen("assets/escape.md"), true);
        pf_res = execute_tool_call(&pr, &pf_call);
        fails += selftest_expect(strstr(pf_res, "escapes the pack directory") != NULL,
                                 "pack_file blocks symlink escape");
        free(pf_res);
        tool_call_free(&pf_call);
    }

    char html_path[PATH_MAX], html_err[256];
    snprintf(html_path, sizeof(html_path), "%s/index.html", dir);
    const char good_html[] =
        "<!doctype html><html><head><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">"
        "<title>Demo</title><style>:root{--bg:#fafafa;--fg:#202020;}@media(max-width:600px){body{padding:16px}}</style>"
        "</head><body><main>Specific launch copy.</main></body></html>";
    fails += selftest_expect(
        write_file_bytes(html_path, good_html, sizeof(good_html) - 1, html_err, sizeof(html_err)),
        "write good html fixture");
    design_check_report report = {0};
    bool ok = design_artifact_check(&pr, "index.html", &report);
    fails += selftest_expect(ok && report.errors == 0, "artifact check passes valid HTML");
    design_check_report_free(&report);

    const char bad_html[] = "<html><head></head><body>Lorem ipsum</body></html>";
    fails += selftest_expect(
        write_file_bytes(html_path, bad_html, sizeof(bad_html) - 1, html_err, sizeof(html_err)),
        "write bad html fixture");
    memset(&report, 0, sizeof(report));
    ok = design_artifact_check(&pr, "index.html", &report);
    fails += selftest_expect(!ok && report.errors >= 2, "artifact check blocks invalid HTML");
    design_check_report_free(&report);

    const char slop_html[] =
        "<!doctype html><html><head><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">"
        "<title>Demo</title><style>:root{--bg:#fafafa;--fg:#202020;--accent:#6366f1;}"
        "@media(max-width:600px){body{padding:16px}}"
        ".card{border-left:4px solid #6366f1;border-radius:12px;background:linear-gradient(135deg,#6366f1,#8b5cf6);}"
        "</style></head><body><main><div class=\"card\">🚀 10x faster delivery.</div></main></body></html>";
    fails += selftest_expect(
        write_file_bytes(html_path, slop_html, sizeof(slop_html) - 1, html_err, sizeof(html_err)),
        "write slop html fixture");
    memset(&report, 0, sizeof(report));
    ok = design_artifact_check(&pr, "index.html", &report);
    fails += selftest_expect(!ok && report.p0 >= 3,
                             "artifact check blocks P0 quality regressions");
    design_check_report_free(&report);

    const char od_slop_html[] =
        "<!doctype html><html><head><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">"
        "<title>Demo</title><style>:root{--bg:#fafafa;--fg:#202020;}"
        "@media(max-width:600px){body{padding:16px}}"
        "h1{font-family:Inter,system-ui,sans-serif}"
        ".hero{background:linear-gradient(90deg,#3b82f6,#06b6d4);}</style>"
        "</head><body><main class=\"hero\"><h1>Name to confirm</h1></main></body></html>";
    fails += selftest_expect(
        write_file_bytes(html_path, od_slop_html, sizeof(od_slop_html) - 1, html_err, sizeof(html_err)),
        "write Open Design slop fixture");
    memset(&report, 0, sizeof(report));
    ok = design_artifact_check(&pr, "index.html", &report);
    fails += selftest_expect(!ok && report.p0 >= 3,
                             "artifact check blocks OD lint regressions");
    design_check_report_free(&report);

    fails += selftest_expect(
        write_file_bytes(html_path, good_html, sizeof(good_html) - 1, html_err, sizeof(html_err)),
        "rewrite good html fixture");

    design_tool_call art_call = {0};
    art_call.name = xstrdup("artifact");
    tool_call_add_arg(&art_call, "entry", "index.html", strlen("index.html"), true);
    tool_call_add_arg(&art_call, "title", "Demo", strlen("Demo"), true);
    char *art_res = tool_artifact(&pr, &art_call);
    fails += selftest_expect(strstr(art_res, "Tool error: artifact blocked: call critique_write") != NULL,
                             "artifact blocks without critique");
    free(art_res);
    tool_call_free(&art_call);

    design_tool_call crit_call = {0};
    crit_call.name = xstrdup("critique_write");
    tool_call_add_arg(&crit_call, "entry", "index.html", strlen("index.html"), true);
    const char fail_scores[] = "{\"critic\":8,\"brand\":8,\"a11y\":8,\"copy\":8}";
    const char must_fixes_json[] = "[\"Strengthen hero hierarchy\"]";
    tool_call_add_arg(&crit_call, "scores_json", fail_scores, strlen(fail_scores), true);
    tool_call_add_arg(&crit_call, "must_fixes_json", must_fixes_json, strlen(must_fixes_json), true);
    tool_call_add_arg(&crit_call, "decision", "continue", strlen("continue"), true);
    char *crit_res = tool_critique_write(&pr, &crit_call);
    fails += selftest_expect(!pr.critique_passed && pr.critique_must_fixes == 1 &&
                             strstr(crit_res, "Critique blocked") != NULL,
                             "critique_write blocks must-fix items");
    free(crit_res);
    tool_call_free(&crit_call);

    memset(&crit_call, 0, sizeof(crit_call));
    crit_call.name = xstrdup("critique_write");
    tool_call_add_arg(&crit_call, "entry", "index.html", strlen("index.html"), true);
    const char pass_scores[] = "{\"critic\":8.5,\"brand\":8,\"a11y\":8,\"copy\":8.5}";
    tool_call_add_arg(&crit_call, "scores_json", pass_scores, strlen(pass_scores), true);
    tool_call_add_arg(&crit_call, "must_fixes_json", "[]", strlen("[]"), true);
    tool_call_add_arg(&crit_call, "decision", "ship", strlen("ship"), true);
    tool_call_add_arg(&crit_call, "notes", "Specific enough to ship.", strlen("Specific enough to ship."), true);
    crit_res = tool_critique_write(&pr, &crit_call);
    fails += selftest_expect(pr.critique_passed &&
                             pr.critique_scores.composite >= DESIGN_QUALITY_THRESHOLD &&
                             strstr(crit_res, "Critique passed") != NULL,
                             "critique_write accepts passing composite");
    free(crit_res);
    tool_call_free(&crit_call);

    memset(&art_call, 0, sizeof(art_call));
    art_call.name = xstrdup("artifact");
    tool_call_add_arg(&art_call, "entry", "index.html", strlen("index.html"), true);
    tool_call_add_arg(&art_call, "title", "Demo", strlen("Demo"), true);
    art_res = tool_artifact(&pr, &art_call);
    fails += selftest_expect(strstr(art_res, "Artifact registered: index.html") != NULL,
                             "artifact accepts passing critique");
    free(art_res);
    tool_call_free(&art_call);

    design_string_list def_exports = {0}, supporting = {0};
    const char *kind = NULL, *renderer = NULL;
    artifact_defaults_for_entry("index.html", &kind, &renderer, &def_exports);
    fails += selftest_expect(artifact_kind_ok("video-storyboard") &&
                             artifact_kind_ok("prompt-pack") &&
                             artifact_renderer_ok("storyboard") &&
                             artifact_export_ok("mp4") &&
                             artifact_export_ok("docx"),
                             "Open Design local-first artifact kinds are accepted");
    design_check_report empty_report = {0};
    char *manifest = artifact_build_manifest_json("abcd1234abcd1234", NULL,
                                                  "0123456789012345678901234567890123456789",
                                                  "index.html", "Demo", kind, renderer,
                                                  &def_exports, &supporting, &empty_report,
                                                  &pr,
                                                  "2026-06-09T00:00:00Z", "{}");
    fails += selftest_expect(strstr(manifest, "\"schema\":\"ds4.design.artifact.v2\"") != NULL,
                             "artifact manifest v2 schema");
    fails += selftest_expect(strstr(manifest, "\"quality\"") != NULL &&
                             strstr(manifest, DESIGN_QUALITY_RUBRIC_ID) != NULL,
                             "artifact manifest includes quality section");
    fails += selftest_expect(
        artifact_write_manifest(&pr, "index.html", manifest, html_err, sizeof(html_err)),
        "artifact manifest sidecar writes");
    free(manifest);
    design_string_list_free(&def_exports);

    char manifest_path[PATH_MAX];
    snprintf(manifest_path, sizeof(manifest_path),
             "%s/.ds4-design/artifacts/index.html.json", dir);
    unlink(manifest_path);
    char artifacts_dir[PATH_MAX], ds4_dir[PATH_MAX];
    snprintf(artifacts_dir, sizeof(artifacts_dir), "%s/.ds4-design/artifacts", dir);
    snprintf(ds4_dir, sizeof(ds4_dir), "%s/.ds4-design", dir);
    char state_path[PATH_MAX], hist_path[PATH_MAX], mem_path[PATH_MAX];
    snprintf(state_path, sizeof(state_path), "%s/.ds4-design/state.json", dir);
    snprintf(hist_path, sizeof(hist_path), "%s/.ds4-design/history.jsonl", dir);
    snprintf(mem_path, sizeof(mem_path), "%s/.ds4-design/project.md", dir);
    unlink(root_mem_path);
    unlink(state_path);
    unlink(hist_path);
    unlink(mem_path);
    unlink(html_path);
    unlink(pack_link);
    unlink(pack_checklist);
    unlink(pack_template);
    unlink(pack_skill_md);
    char pack_assets_dir[PATH_MAX], pack_refs_dir[PATH_MAX], pack_skills_dir[PATH_MAX];
    snprintf(pack_assets_dir, sizeof(pack_assets_dir), "%s/assets", pack_skill_root);
    snprintf(pack_refs_dir, sizeof(pack_refs_dir), "%s/references", pack_skill_root);
    snprintf(pack_skills_dir, sizeof(pack_skills_dir), "%s/skills", pack_dir);
    rmdir(pack_assets_dir);
    rmdir(pack_refs_dir);
    rmdir(pack_skill_root);
    rmdir(pack_skills_dir);
    rmdir(pack_dir);
    rmdir(artifacts_dir);
    rmdir(ds4_dir);
    rmdir(dir);
    free(pr.memory_summary);

    if (fails == 0) {
        fprintf(stdout, "ds4-design: self-test ok\n");
        return 0;
    }
    return 1;
}

/* ============================================================================
 * Remote Model Mode
 * ============================================================================
 *
 * LAN clients still run ds4-design locally for workspace and tool execution.
 * Only the model turn is delegated to the DStudio host's /v1 endpoint.
 */

typedef struct {
    design_agent *agent;
    design_stream *stream;
    design_buf assistant_raw;
    bool reasoning_open;
} design_remote_stream_ctx;

#define DESIGN_REMOTE_AUTO_CONTINUES 3

static bool design_remote_retryable_model_error(const char *err) {
    if (!err || !err[0]) return false;
    return strstr(err, "stream ended before completion") ||
           strstr(err, "ended before data: [DONE]") ||
           strstr(err, "internal model stream ended before completion") ||
           strstr(err, "Connection interrupted") ||
           strstr(err, "connection interrupted");
}

static char *design_remote_continue_prompt(const dsml_parser *dsml,
                                           const char *err,
                                           int attempt,
                                           int max_attempts) {
    design_buf b = {0};
    buf_puts(&b,
        "DStudio transport recovery: the previous design response was interrupted before the model stream completed.\n");
    if (err && err[0]) {
        buf_puts(&b, "Technical reason: ");
        buf_puts(&b, err);
        buf_puts(&b, "\n");
    }
    char nbuf[96];
    snprintf(nbuf, sizeof(nbuf), "Automatic continuation attempt %d of %d.\n", attempt, max_attempts);
    buf_puts(&b, nbuf);
    if (dsml && (dsml->state == DSML_STRUCTURAL ||
                 dsml->state == DSML_PARAM_VALUE ||
                 dsml->state == DSML_ERROR)) {
        buf_puts(&b,
            "Your prior output was cut off while forming a DSML tool call. "
            "Do not continue the broken fragment. Re-emit the full intended DSML tool call from the beginning, "
            "with complete parameters and no extra prose before it.\n");
    } else {
        buf_puts(&b,
            "Continue exactly where the previous design response stopped. "
            "Do not repeat completed text. Finish the current artifact/tool action before stopping.\n");
    }
    return buf_take(&b);
}

static int design_remote_think_level(ds4_think_mode m) {
    if (m == DS4_THINK_MAX) return 2;
    if (m == DS4_THINK_HIGH) return 1;
    return 0;
}

static void design_remote_cb(void *ud, const char *kind, const char *text, size_t len) {
    design_remote_stream_ctx *ctx = ud;
    if (!ctx || !kind || !text || !len) return;
    if (!strcmp(kind, "reasoning")) {
        if (!ctx->reasoning_open) {
            emit_event("reasoning_start");
            ctx->reasoning_open = true;
        }
        out_text(text, len);
        return;
    }
    if (!strcmp(kind, "content")) {
        if (ctx->reasoning_open) {
            emit_event("reasoning_end");
            ctx->reasoning_open = false;
        }
        buf_append(&ctx->assistant_raw, text, len);
        stream_text(ctx->stream, text, len);
    }
}

static char *design_remote_system_prompt(design_agent *a) {
    design_buf sys = {0};
    buf_puts(&sys, design_system_prompt);
    char *pm = design_read_project_memory(&a->project);
    if (pm && pm[0]) {
        buf_puts(&sys, "\n\nPROJECT MEMORY (runtime summary from MEMORY.MD):\n\n");
        buf_puts(&sys, pm);
    }
    free(pm);
    if (a->cfg->extra_system && a->cfg->extra_system[0]) {
        buf_puts(&sys, "\n\nAdditional system instructions:\n");
        buf_puts(&sys, a->cfg->extra_system);
    }
    buf_puts(&sys,
        "\n\nRuntime note: you are using a remote DS4 model, but all tools, "
        "filesystem writes, bash commands, browser reads, artifact registration "
        "and project state run on this local client workspace. Never assume the "
        "remote host filesystem is available.\n");
    return buf_take(&sys);
}

static void design_remote_reset_messages(design_agent *a) {
    dstudio_remote_buf_free(&a->remote_messages);
    a->remote_message_count = 0;
    char *sys = design_remote_system_prompt(a);
    dstudio_remote_messages_append(&a->remote_messages, &a->remote_message_count,
                                   "system", sys);
    free(sys);
}

static int design_remote_run_turn(design_agent *a, const char *user_text) {
    if (!a->session_title) {
        a->session_title = design_session_title_from_prompt(user_text, 0);
        a->session_created_at = (uint64_t)time(NULL);
        design_session_identity_sha(a->session_title, a->session_created_at,
                                    a->session_sha);
    }
    design_project_start_run(&a->project, user_text);
    dstudio_remote_messages_append(&a->remote_messages, &a->remote_message_count,
                                   "user", user_text ? user_text : "");

    int auto_continues = 0;
    for (int tool_round = 0; ; tool_round++) {
        (void)tool_round;
        dsml_parser dsml;
        memset(&dsml, 0, sizeof(dsml));
        dsml.state = DSML_SEARCH;
        design_stream stream = { .parser = &dsml, .hold_len = 0, .suppressed = false };
        design_remote_stream_ctx ctx = {
            .agent = a,
            .stream = &stream,
        };
        char *messages = dstudio_remote_messages_snapshot(&a->remote_messages);
        char err[256] = {0};
        int rc = dstudio_remote_chat_stream(
            a->cfg->remote_base_url,
            a->cfg->remote_model && a->cfg->remote_model[0] ? a->cfg->remote_model : "ds4",
            messages,
            design_remote_think_level(agent_think_mode(a)),
            a->cfg->temperature,
            a->cfg->top_p,
            a->cfg->min_p,
            a->cfg->n_predict,
            design_remote_cb,
            &ctx,
            err,
            sizeof(err));
        free(messages);
        stream_finish(&stream);
        if (ctx.reasoning_open) emit_event("reasoning_end");
        char *assistant = buf_take(&ctx.assistant_raw);
        if (assistant && assistant[0]) {
            dstudio_remote_messages_append(&a->remote_messages,
                                           &a->remote_message_count,
                                           "assistant",
                                           assistant);
        }

        if (rc != 0) {
            if (design_remote_retryable_model_error(err) &&
                auto_continues < DESIGN_REMOTE_AUTO_CONTINUES) {
                auto_continues++;
                char *cont = design_remote_continue_prompt(&dsml, err,
                    auto_continues, DESIGN_REMOTE_AUTO_CONTINUES);
                dstudio_remote_messages_append(&a->remote_messages,
                                               &a->remote_message_count,
                                               "user",
                                               cont);
                free(cont);
                printf("\x1e{\"type\":\"model_retry\",\"attempt\":%d,\"max\":%d}\n",
                       auto_continues, DESIGN_REMOTE_AUTO_CONTINUES);
                fflush(stdout);
                free(assistant);
                dsml_parser_free(&dsml);
                continue;
            }
            dsml_parser_free(&dsml);
            char msg[512];
            snprintf(msg, sizeof(msg), "\nRemote model failed after automatic recovery: %s\n",
                     err[0] ? err : "unknown error");
            out_text(msg, strlen(msg));
            design_project_finish_run(&a->project, "error");
            free(assistant);
            return 0;
        }

        bool got_tool = dsml.state == DSML_DONE;
        bool malformed_tool = dsml.state == DSML_ERROR ||
            dsml.state == DSML_STRUCTURAL || dsml.state == DSML_PARAM_VALUE;
        char *tool_result = NULL;
        if (!got_tool && !malformed_tool) {
            out_text("\n", 1);
            free(assistant);
            dsml_parser_free(&dsml);
            design_project_finish_run(&a->project, "ok");
            return 0;
        }
        if (malformed_tool) {
            design_buf b = {0};
            buf_puts(&b, "Tool error: invalid DSML tool call: ");
            buf_puts(&b, dsml.error[0] ? dsml.error : "parse error");
            buf_puts(&b, "\n");
            tool_result = buf_take(&b);
        } else {
            tool_result = execute_tool_calls(&a->project, &dsml.calls);
        }
        dstudio_remote_messages_append(&a->remote_messages,
                                       &a->remote_message_count,
                                       "tool",
                                       tool_result);
        free(tool_result);
        free(assistant);
        dsml_parser_free(&dsml);
    }
}

static bool design_remote_slash_is(const char *p, const char *cmd) {
    size_t n = strlen(cmd);
    return !strncmp(p, cmd, n) &&
           (p[n] == '\0' || p[n] == ' ' || p[n] == '\t');
}

static void design_remote_emit_empty_sessions(void) {
    if (!g_jsonl) return;
    design_buf b = {0};
    buf_puts(&b, "\x1e{\"type\":\"sessions\",\"sessions\":[]}\n");
    emit_event_line(&b);
}

static void design_remote_handle_slash(design_agent *a, const char *input) {
    const char *p = input;
    while (*p == ' ' || *p == '\t') p++;
    if (design_remote_slash_is(p, "/new")) {
        design_remote_reset_messages(a);
        free(a->session_title);
        a->session_title = NULL;
        a->session_sha[0] = '\0';
        a->project.discovery_satisfied = false;
        design_project_clear_run_progress(&a->project);
    } else if (design_remote_slash_is(p, "/list") ||
               design_remote_slash_is(p, "/sessions")) {
        design_remote_emit_empty_sessions();
    } else if (design_remote_slash_is(p, "/save") ||
               design_remote_slash_is(p, "/switch") ||
               design_remote_slash_is(p, "/del") ||
               design_remote_slash_is(p, "/compact")) {
        /* Remote Design keeps the workspace local but does not own local KV
         * sessions. The UI may still send session commands while syncing; keep
         * them successful and silent instead of surfacing repeated status
         * events to the user. */
    } else {
        char m[96];
        snprintf(m, sizeof(m), "unknown command: %.40s", p);
        emit_session_status("error", m);
    }
}

static int design_run_remote(design_agent *a) {
    design_remote_reset_messages(a);
    fprintf(stderr, "ds4-design: remote model %s (%s)\n",
            a->cfg->remote_model && a->cfg->remote_model[0] ? a->cfg->remote_model : "ds4",
            a->cfg->remote_base_url);

    design_buf input = {0};
    for (;;) {
        if (!read_prompt(&input)) break;
        while (input.len && (input.ptr[input.len - 1] == '\n' ||
                             input.ptr[input.len - 1] == '\r'))
            input.ptr[--input.len] = '\0';
        if (input.len == 0) continue;
        design_apply_control_frames(a->cfg, input.ptr);
        input.len = strlen(input.ptr);
        if (input.len == 0) continue;
        const char *p = input.ptr;
        while (*p == ' ' || *p == '\t') p++;
        if (*p == '/') {
            design_remote_handle_slash(a, input.ptr);
            input.len = 0;
            if (input.ptr) input.ptr[0] = '\0';
            continue;
        }
        char *prompt = buf_take(&input);
        int rc = design_remote_run_turn(a, prompt);
        free(prompt);
        if (rc != 0) break;
    }
    free(input.ptr);
    return 0;
}

/* ============================================================================
 * Main
 * ============================================================================
 */

int main(int argc, char **argv) {
    /* Ignore SIGPIPE: stdout/stderr go to the launcher pipe (serve.c). If the
     * launcher disconnects mid-write, write() must return EPIPE — which
     * write_all_fd swallows — rather than killing us before the clean-exit path
     * runs design_bash_jobs_free (which SIGKILLs orphaned shell children). */
    signal(SIGPIPE, SIG_IGN);

    design_config cfg = parse_options(argc, argv);
    if (cfg.self_test) return design_run_self_test();
    g_jsonl = cfg.jsonl;
    emit_protocol_event();

    design_agent a;
    memset(&a, 0, sizeof(a));
    a.cfg = &cfg;

    snprintf(a.project.dir, sizeof(a.project.dir), "%s", cfg.workspace);
    if (!design_mkdir_p(a.project.dir)) {
        fprintf(stderr, "ds4-design: cannot create workspace %s: %s\n",
                cfg.workspace, strerror(errno));
        return 1;
    }
    /* Canonicalize to an absolute path: project_resolve's sandbox root and the
     * bash child's chdir both rely on it being absolute (the main process keeps
     * cwd at the ds4 dir for Metal source loading). */
    {
        char abs_dir[PATH_MAX];
        if (realpath(a.project.dir, abs_dir))
            snprintf(a.project.dir, sizeof(a.project.dir), "%s", abs_dir);
    }
    design_project_bootstrap(&a.project);
    fprintf(stderr, "ds4-design: project %s\n", a.project.dir);

    /* Persistent named sessions live under ~/.ds4/design-sessions, created
     * eagerly so the first /save and /list see a real directory. */
    a.cache_dir = design_default_cache_dir();
    if (!design_mkdir_p(a.cache_dir))
        fprintf(stderr, "ds4-design: cannot create session dir %s: %s\n",
                a.cache_dir, strerror(errno));
    else
        fprintf(stderr, "ds4-design: sessions %s\n", a.cache_dir);

    /* Reap bash process groups on SIGTERM (serve.c's stop signal) so no shell
     * child outlives the design agent. The handler reads a->project.bash_jobs. */
    g_term_project = &a.project;
    signal(SIGTERM, design_on_term);

    /* Web tooling: Chrome is a RUNTIME dependency, launched lazily on the first
     * google_search/visit_page. Headless design auto-approves startup. */
    ds4_web_config web_cfg = {
        .home_dir = getenv("HOME"),
        .port = 9333,
        .confirm = design_web_confirm,
        .log = design_web_log,
        .cancel = design_web_cancel,
    };
    a.project.web = ds4_web_create(&web_cfg);
    if (!a.project.web)
        fprintf(stderr, "ds4-design: web tools unavailable (ds4_web_create failed)\n");

    if (cfg.remote_base_url && cfg.remote_base_url[0]) {
        int rc = design_run_remote(&a);
        design_bash_jobs_free(&a.project);
        ds4_web_free(a.project.web);
        free(a.project.todos_json);
        free(a.project.memory_summary);
        free(a.cache_dir);
        free(a.session_title);
        dstudio_remote_buf_free(&a.remote_messages);
        return rc;
    }

    if (ds4_engine_open(&a.engine, &cfg.engine) != 0) return 1;

    ds4_context_memory mem = ds4_context_memory_estimate_with_prefill(
        cfg.engine.backend, cfg.ctx_size, cfg.engine.prefill_chunk);
    fprintf(stderr, "ds4-design: context buffers %.2f MiB (ctx=%d, backend=%s)\n",
            (double)mem.total_bytes / (1024.0 * 1024.0), cfg.ctx_size,
            ds4_backend_name(cfg.engine.backend));

    if (ds4_session_create(&a.session, a.engine, cfg.ctx_size) != 0) {
        fprintf(stderr, "ds4-design: session backend is required\n");
        return 1;
    }

    /* Bootstrap the transcript and prefill the system prompt now, so the
     * first WAITING marker means truly ready and the first turn is fast. */
    char err[160];
    if (design_build_system_transcript(&a, err, sizeof(err)) != 0) {
        fprintf(stderr, "ds4-design: system prompt prefill failed: %s\n", err);
        return 1;
    }
    fprintf(stderr, "ds4-design: ready (system prompt %d tokens)\n",
            a.transcript.len);

    design_buf input = {0};
    for (;;) {
        if (!read_prompt(&input)) break; /* stdin EOF with nothing pending */

        /* Strip the trailing newline the launcher uses as a send terminator. */
        while (input.len && (input.ptr[input.len - 1] == '\n' ||
                             input.ptr[input.len - 1] == '\r'))
            input.ptr[--input.len] = '\0';
        if (input.len == 0) continue;
        design_apply_control_frames(&cfg, input.ptr);
        input.len = strlen(input.ptr);
        if (input.len == 0) continue;

        if (a.transcript.len + DESIGN_CTX_RESERVE >= cfg.ctx_size) {
            char rerr[160] = {0};
            if (!design_agent_compact(&a, "context full before prompt",
                                      rerr, sizeof(rerr))) {
                const char full[] =
                    "\nContext is full and compaction failed. "
                    "Restart the design agent to keep iterating on the project files.\n";
                out_text(full, sizeof(full) - 1);
                input.len = 0;
                if (input.ptr) input.ptr[0] = '\0';
                continue;
            }
            design_project_set_phase(&a.project, "idle");
            emit_session_status("info", "context compacted");
        }

        /* Slash-command router: a leading '/' (after optional spaces) is a
         * session command, not a design prompt.  Handle it and continue; never
         * fall through to run_turn.  Anything else is a normal prompt and
         * reaches run_turn unchanged. */
        {
            const char *p = input.ptr;
            while (*p == ' ' || *p == '\t') p++;
            if (*p == '/') {
                /* Copy the word after '/' up to whitespace; the remainder
                 * (after spaces) is the argument. */
                const char *word = p;
                const char *we = word;
                while (*we && *we != ' ' && *we != '\t') we++;
                size_t wlen = (size_t)(we - word);
                const char *arg = we;
                while (*arg == ' ' || *arg == '\t') arg++;
                /* Argument is a single token (sha prefix): cut at whitespace. */
                char argbuf[64] = {0};
                {
                    size_t i = 0;
                    while (arg[i] && arg[i] != ' ' && arg[i] != '\t' &&
                           i + 1 < sizeof(argbuf)) {
                        argbuf[i] = arg[i];
                        i++;
                    }
                    argbuf[i] = '\0';
                }
                char serr[160] = {0};

                if (wlen == 5 && !strncmp(word, "/save", 5)) {
                    if (design_session_save(&a, serr, sizeof(serr)))
                        emit_session_status("info", "session saved");
                    else
                        emit_session_status("error", serr[0] ? serr : "save failed");
                } else if ((wlen == 5 && !strncmp(word, "/list", 5)) ||
                           (wlen == 9 && !strncmp(word, "/sessions", 9))) {
                    design_list_sessions(&a);
                } else if (wlen == 7 && !strncmp(word, "/switch", 7)) {
                    if (!argbuf[0])
                        emit_session_status("error", "usage: /switch <sha>");
                    else if (design_session_switch(&a, argbuf, serr, sizeof(serr))) {
                        char m[96];
                        snprintf(m, sizeof(m), "switched to %.8s", a.session_sha);
                        emit_session_status("info", m);
                    } else
                        emit_session_status("error", serr[0] ? serr : "switch failed");
                } else if (wlen == 4 && !strncmp(word, "/del", 4)) {
                    char sha[41] = {0};
                    if (!argbuf[0])
                        emit_session_status("error", "usage: /del <sha>");
                    else if (design_session_delete(&a, argbuf, sha, serr, sizeof(serr))) {
                        char m[96];
                        snprintf(m, sizeof(m), "deleted %.8s", sha);
                        emit_session_status("info", m);
                    } else
                        emit_session_status("error", serr[0] ? serr : "delete failed");
                } else if (wlen == 4 && !strncmp(word, "/new", 4)) {
                    if (design_session_new(&a, serr, sizeof(serr)))
                        emit_session_status("info", "started a new session");
                    else
                        emit_session_status("error", serr[0] ? serr : "new failed");
                } else if (wlen == 8 && !strncmp(word, "/compact", 8)) {
                    if (design_agent_compact(&a, "user requested compaction",
                                             serr, sizeof(serr)))
                        emit_session_status("info", "context compacted");
                    else
                        emit_session_status("error",
                                            serr[0] ? serr : "compact failed");
                } else {
                    char m[96];
                    snprintf(m, sizeof(m), "unknown command: %.*s",
                             (int)(wlen > 40 ? 40 : wlen), word);
                    emit_session_status("error", m);
                }
                input.len = 0;
                if (input.ptr) input.ptr[0] = '\0';
                continue;
            }
        }

        char *prompt = buf_take(&input);
        int rc = run_turn(&a, prompt);
        free(prompt);
        if (rc != 0) break;

        /* Save-on-turn: ds4-agent re-saves after each turn so the on-disk
         * session stays current.  Best-effort: a session always has a title by
         * now (set at the top of run_turn), so this keeps the file fresh. */
        if (a.session_title) {
            char serr[160] = {0};
            if (!design_session_save(&a, serr, sizeof(serr)))
                fprintf(stderr, "ds4-design: post-turn save failed: %s\n",
                        serr[0] ? serr : "unknown error");
        }
    }

    design_bash_jobs_free(&a.project); /* SIGKILL any still-running shell jobs */
    ds4_web_free(a.project.web);        /* tears down the Chrome it launched */
    free(a.project.todos_json);
    free(a.project.memory_summary);
    free(a.cache_dir);
    free(a.session_title);
    dstudio_remote_buf_free(&a.remote_messages);
    ds4_session_free(a.session);
    ds4_engine_close(a.engine);
    return 0;
}

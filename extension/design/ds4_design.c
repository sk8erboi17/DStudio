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
 *   prefixed by \x1e: tool_call / tool_result / reasoning_start /
 *   reasoning_end / todos / artifact.  <question-form> blocks stream as
 *   plain text; the UI recognizes and renders them.
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
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#include "ds4.h"
#include "ds4_web.h"
#include "ds4_kvstore.h"

/* Tokens kept free for the next assistant round + tool result before a user
 * turn is accepted.  Past that, the session is declared full. */
#define DESIGN_CTX_RESERVE 4096
#define DESIGN_READ_DEFAULT_LINES 200
#define DESIGN_FILE_MAX (8 * 1024 * 1024)

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

static void emit_artifact_event(const char *entry, const char *title) {
    if (!g_jsonl) return;
    design_buf b = {0};
    buf_puts(&b, "\x1e{\"type\":\"artifact\",\"entry\":\"");
    json_escape_buf(&b, entry, strlen(entry));
    buf_puts(&b, "\",\"title\":\"");
    json_escape_buf(&b, title ? title : "", title ? strlen(title) : 0);
    buf_puts(&b, "\"}\n");
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

static char *tool_todo_write(const design_tool_call *call) {
    const char *todos = tool_arg_value(call, "todos");
    if (!todos) return tool_error("todo_write requires todos");
    const char *p = todos;
    while (*p == ' ' || *p == '\t' || *p == '\n' || *p == '\r') p++;
    if (*p != '[')
        return tool_error("todos must be a JSON array of "
                          "{\"text\":...,\"status\":\"pending|in_progress|completed\"}");
    emit_todos_event(todos);
    int items = 0;
    for (const char *q = todos; *q; q++) {
        if (*q == '{') items++;
    }
    char msg[96];
    snprintf(msg, sizeof(msg), "Todo list updated (%d items). It renders live in the chat.\n", items);
    return xstrdup(msg);
}

static char *tool_artifact(design_project *pr, const design_tool_call *call) {
    const char *entry = tool_arg_value(call, "entry");
    const char *title = tool_arg_value(call, "title");
    char full[PATH_MAX], err[256];
    if (!project_resolve(pr, entry, full, sizeof(full), err, sizeof(err)))
        return tool_error(err);
    if (access(full, R_OK) != 0)
        return tool_error("artifact entry file does not exist; write it first");
    emit_artifact_event(entry, title);
    char msg[640];
    snprintf(msg, sizeof(msg),
             "Artifact registered: %s. The workspace preview switched to it.\n", entry);
    return xstrdup(msg);
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
    emit_proposal_event(dirs);
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
    char tmp_path[] = "/tmp/ds4_design_output_XXXXXX";
    int tmpfd = mkstemp(tmp_path);
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
static char *design_tool_pack(const design_tool_call *call, const char *subdir,
                              const char *file, int allow_user) {
    const char *name = tool_arg_value(call, "name");
    if (!design_pack_name_ok(name)) return tool_error("name must be a simple id (a-z, 0-9, -)");
    char path[2300];
    char *body = NULL;
    if (allow_user) {  /* a user-authored skill overrides / extends the shipped library */
        const char *u = getenv("DS4UI_USER_SKILLS_DIR");
        if (u && u[0]) { snprintf(path, sizeof path, "%s/%s/SKILL.md", u, name); body = design_read_file_buf(path); }
    }
    if (!body) {
        const char *root = getenv("DS4UI_SKILLS_DIR");
        if (root && root[0]) { snprintf(path, sizeof path, "%s/%s/%s/%s", root, subdir, name, file); body = design_read_file_buf(path); }
    }
    if (!body) {
        design_buf e = {0};
        buf_puts(&e, "Tool error: no such pack: ");
        buf_puts(&e, name);
        buf_puts(&e, "\n");
        return buf_take(&e);
    }
    return body;
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
    if (!strcmp(name, "write")) return design_verify_after(pr, call, tool_write(pr, call));
    if (!strcmp(name, "edit")) return design_verify_after(pr, call, tool_edit(pr, call));
    if (!strcmp(name, "read")) return tool_read(pr, call);
    if (!strcmp(name, "more")) return design_tool_more(pr, call);
    if (!strcmp(name, "search")) return design_tool_search(pr, call);
    if (!strcmp(name, "list")) return tool_list(pr, call);
    if (!strcmp(name, "todo_write")) return tool_todo_write(call);
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
    buf_puts(&b, ". Available tools: todo_write, write, edit, read, more, search, "
                 "list, artifact, propose, google_search, visit_page, bash, "
                 "bash_status, bash_stop.\n");
    return buf_take(&b);
}

static char *execute_tool_calls(design_project *pr, const design_tool_calls *calls) {
    design_buf all = {0};
    for (int i = 0; i < calls->len; i++) {
        emit_tool_call_event(&calls->v[i]);
        char *res = execute_tool_call(pr, &calls->v[i]);
        emit_tool_result_event(calls->v[i].name, res);
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
    "\"todos\":{\"type\":\"string\",\"description\":\"JSON array of {\\\"text\\\":string,\\\"status\\\":\\\"pending\\\"|\\\"in_progress\\\"|\\\"completed\\\"}\"}},"
    "\"required\":[\"todos\"]}}}\n\n"
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
    "\"description\":\"Register the canonical entry file of this turn's deliverable; the workspace preview switches to it.\","
    "\"parameters\":{\"type\":\"object\",\"properties\":{"
    "\"entry\":{\"type\":\"string\"},\"title\":{\"type\":\"string\"}},"
    "\"required\":[\"entry\",\"title\"]}}}\n\n"
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
    "When a skill or design-system fits the brief — or the user selected one (see the "
    "system context) — load it FIRST with skill()/design_system(), then build to it. Load "
    "the relevant craft() rules too (accessibility before shipping; layout-responsive before "
    "any resize/restructure). You can load more at any point without restarting.\n\n"
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
    "\"options\":[\"Landing page\",\"Dashboard / tool UI\",\"Mobile app prototype\",\"Slide deck\",\"Other\"]},\n"
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
    "prose with a question mark. The styled form is the only way you ask.\n\n"
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
    "If instead the user chose \"pick a direction for me\", do NOT silently pick "
    "one: WRITE 2-3 of the five built-in directions below as SEPARATE "
    "self-contained files (direction-a.html, direction-b.html, direction-c.html), "
    "each binding a DIFFERENT direction's palette to :root and each a real take "
    "on the brief (not a placeholder), then call propose with a JSON array of "
    "{entry,tag,name,desc} so the user can compare and choose. Do NOT todo_write "
    "before proposing — the proposal IS the fast fork. Make the directions "
    "genuinely distinct (different palette AND layout personality), never three "
    "tweaks of one. After the user says \"Use direction X\", continue refining "
    "THAT one file per RULE 4 and drop the others.\n"
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
    "1. Bind direction/brand tokens to :root\n"
    "2. Plan the section/screen list (state it aloud before writing)\n"
    "3. Write the file(s)\n"
    "4. Replace placeholder copy with real, specific copy from the brief\n"
    "5. Critique and fix (5-dimension self-check below)\n"
    "6. Register the artifact\n"
    "Update the card as you go: mark a step in_progress when you start it and "
    "completed when it is done (call todo_write again with the full updated "
    "list). Keep the plan under ~8 items.\n\n"
    "## RULE 3.5 — critique before you ship (do not skip)\n\n"
    "After writing and before the artifact, score yourself silently 1-5 on "
    "five dimensions, then fix the weakest before emitting:\n"
    "- Philosophy: does the visual posture match what was asked (editorial vs "
    "minimal vs brutalist), or did you drift back to a default?\n"
    "- Hierarchy: does the eye land in ONE obvious place per screen, or is "
    "everything competing?\n"
    "- Execution: typography, spacing, alignment, contrast — right, or just "
    "close?\n"
    "- Specificity: is every word, number and image specific to THIS brief, or "
    "did filler / generic stat-slop creep in?\n"
    "- Restraint: one accent used at most twice, one decisive flourish — or "
    "three competing ones?\n"
    "Any dimension under 3/5 is a regression: go back, fix the weakest, "
    "re-score. Score the WORST sustained band, never average up; name the "
    "element behind each weak score; if no dimension is under 3 you are "
    "grade-inflating, so look again. Two passes is normal. Do this silently (no scores in the chat). "
    "Then run the anti-slop checklist below and the P0 gates — every P0 must "
    "pass before you call artifact:\n"
    "- P0: body text >= 16px, tap targets >= 44px, body contrast >= 4.5:1, no "
    "horizontal scroll at 390 / 768 / 1280px, no [REPLACE]/lorem/\"Feature "
    "One\" placeholder left in the file.\n"
    "If a P0 fails, fix it first — never ship an artifact with a failing P0.\n\n"
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
    "artifact with its entry path and a human title. One artifact per turn at "
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
    bool jsonl;
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
        "  --jsonl                 emit structured \\x1e-prefixed UI events\n"
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
        } else if (!strcmp(arg, "--jsonl")) {
            c.jsonl = true;
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

    design_buf tmpl = {0};
    buf_puts(&tmpl, path);
    buf_puts(&tmpl, ".tmp.XXXXXX");
    char *tmp = buf_take(&tmpl);
    int fd = mkstemp(tmp);
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

static bool design_session_new(design_agent *a, char *err, size_t err_len) {
    if (design_build_system_transcript(a, err, err_len) != 0)
        return false;
    a->session_sha[0] = '\0';
    free(a->session_title);
    a->session_title = NULL;
    a->session_created_at = 0;
    return true;
}

/* One user turn: any number of assistant/tool rounds until the model answers
 * without a tool call.  The transcript is the single source of truth, exactly
 * like ds4-agent's worker_run_turn, minus threading and compaction. */
static int run_turn(design_agent *a, const char *user_text) {
    ds4_think_mode think_mode = agent_think_mode(a);
    /* First user turn of a session: derive its stable identity (title +
     * created_at + sha) from the opening prompt, exactly like ds4-agent.  This
     * is what the post-turn save keys the on-disk file on. */
    if (!a->session_title) {
        a->session_title = design_session_title_from_prompt(user_text, 0);
        a->session_created_at = (uint64_t)time(NULL);
        design_session_identity_sha(a->session_title, a->session_created_at,
                                    a->session_sha);
    }
    ds4_chat_append_message(a->engine, &a->transcript, "user", user_text);

    uint64_t rng = a->cfg->seed ? a->cfg->seed :
        ((uint64_t)time(NULL) ^ ((uint64_t)getpid() << 32));

    for (;;) {
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
        ds4_chat_append_message(a->engine, &a->transcript, "tool", tool_result);
        free(tool_result);
        dsml_parser_free(&dsml);
    }
}

/* Rebuild the transcript at the system/tool prompt and prefill it into the
 * live session.  This is the exact bootstrap main() runs on startup; /new
 * reuses it to drop the current conversation back to a fresh session without
 * restarting the process.  Returns 0 on success. */
static int design_build_system_transcript(design_agent *a, char *err, size_t err_len) {
    design_config *cfg = a->cfg;
    ds4_tokens_free(&a->transcript);
    memset(&a->transcript, 0, sizeof(a->transcript));
    ds4_chat_begin(a->engine, &a->transcript);
    if (cfg->think_mode == DS4_THINK_MAX && agent_think_mode(a) == DS4_THINK_MAX)
        ds4_chat_append_max_effort_prefix(a->engine, &a->transcript);
    ds4_tokenize_rendered_chat(a->engine, design_system_prompt, &a->transcript);
    if (cfg->extra_system && cfg->extra_system[0]) {
        /* User text must stay plain content, never DSML control tokens. */
        ds4_chat_append_message(a->engine, &a->transcript, "system", cfg->extra_system);
    }
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
    g_jsonl = cfg.jsonl;

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

        if (a.transcript.len + DESIGN_CTX_RESERVE >= cfg.ctx_size) {
            const char full[] =
                "\nContext is full: this design session cannot continue. "
                "Restart the design agent to keep iterating on the project files.\n";
            out_text(full, sizeof(full) - 1);
            input.len = 0;
            if (input.ptr) input.ptr[0] = '\0';
            continue;
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
    free(a.cache_dir);
    free(a.session_title);
    ds4_session_free(a.session);
    ds4_engine_close(a.engine);
    return 0;
}

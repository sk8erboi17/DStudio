#ifndef DSTUDIO_JSON_TOKENS_H
#define DSTUDIO_JSON_TOKENS_H

/* First-party grammar/token helpers shared by the host and its native runtime.
 * Keep transport and tool arguments on one grammar; this owns no host state.
 * Callers bound input bytes and token storage before parsing. */
#include <ctype.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* ---------- Small complete JSON tokenizer (jsmn-style, no dependency). ---------- */

typedef enum {
    DTG_JSON_UNDEFINED = 0,
    DTG_JSON_OBJECT,
    DTG_JSON_ARRAY,
    DTG_JSON_STRING,
    DTG_JSON_PRIMITIVE
} dtg_json_type;

typedef struct {
    dtg_json_type type;
    int start;
    int end;
    int size;
    int parent;
} dtg_json_token;

typedef struct {
    unsigned pos;
    unsigned next;
    int super;
} dtg_json_parser;

/* The tokenizer below indexes an already-valid document.  Keep grammar
 * validation separate so missing commas/colons and invalid primitives cannot
 * be normalized into an apparently valid graph. */
static const char *dtg_json_syntax_value(const char *p, const char *end,
                                         int depth, char *err, size_t errsz);

static const char *dtg_json_syntax_ws(const char *p, const char *end) {
    while (p < end && isspace((unsigned char)*p)) p++;
    return p;
}

static const char *dtg_json_syntax_string(const char *p, const char *end,
                                          char *err, size_t errsz) {
    if (p >= end || *p++ != '"') return NULL;
    while (p < end) {
        unsigned char c = (unsigned char)*p++;
        if (c == '"') return p;
        if (c < 0x20) { snprintf(err, errsz, "control character in JSON string"); return NULL; }
        if (c != '\\') continue;
        if (p >= end) { snprintf(err, errsz, "unterminated JSON escape"); return NULL; }
        c = (unsigned char)*p++;
        if (c == 'u') {
            for (int i = 0; i < 4; i++) {
                if (p >= end || !isxdigit((unsigned char)*p++)) {
                    snprintf(err, errsz, "bad JSON unicode escape"); return NULL;
                }
            }
        } else if (!strchr("\"/\\bfnrt", c)) {
            snprintf(err, errsz, "bad JSON escape"); return NULL;
        }
    }
    snprintf(err, errsz, "unterminated JSON string");
    return NULL;
}

static const char *dtg_json_syntax_number(const char *p, const char *end,
                                          char *err, size_t errsz) {
    if (p < end && *p == '-') p++;
    if (p >= end) goto bad;
    if (*p == '0') p++;
    else if (*p >= '1' && *p <= '9') while (p < end && isdigit((unsigned char)*p)) p++;
    else goto bad;
    if (p < end && *p == '.') {
        p++;
        if (p >= end || !isdigit((unsigned char)*p)) goto bad;
        while (p < end && isdigit((unsigned char)*p)) p++;
    }
    if (p < end && (*p == 'e' || *p == 'E')) {
        p++;
        if (p < end && (*p == '+' || *p == '-')) p++;
        if (p >= end || !isdigit((unsigned char)*p)) goto bad;
        while (p < end && isdigit((unsigned char)*p)) p++;
    }
    return p;
bad:
    snprintf(err, errsz, "bad JSON number");
    return NULL;
}

static const char *dtg_json_syntax_array(const char *p, const char *end,
                                         int depth, char *err, size_t errsz) {
    p = dtg_json_syntax_ws(p + 1, end);
    if (p < end && *p == ']') return p + 1;
    for (;;) {
        p = dtg_json_syntax_value(p, end, depth + 1, err, errsz);
        if (!p) return NULL;
        p = dtg_json_syntax_ws(p, end);
        if (p < end && *p == ',') { p = dtg_json_syntax_ws(p + 1, end); continue; }
        if (p < end && *p == ']') return p + 1;
        snprintf(err, errsz, "expected ',' or ']' in JSON array");
        return NULL;
    }
}

static const char *dtg_json_syntax_object(const char *p, const char *end,
                                          int depth, char *err, size_t errsz) {
    p = dtg_json_syntax_ws(p + 1, end);
    if (p < end && *p == '}') return p + 1;
    for (;;) {
        if (p >= end || *p != '"') { snprintf(err, errsz, "expected JSON object key"); return NULL; }
        p = dtg_json_syntax_string(p, end, err, errsz);
        if (!p) return NULL;
        p = dtg_json_syntax_ws(p, end);
        if (p >= end || *p != ':') { snprintf(err, errsz, "expected ':' after JSON object key"); return NULL; }
        p = dtg_json_syntax_value(p + 1, end, depth + 1, err, errsz);
        if (!p) return NULL;
        p = dtg_json_syntax_ws(p, end);
        if (p < end && *p == ',') { p = dtg_json_syntax_ws(p + 1, end); continue; }
        if (p < end && *p == '}') return p + 1;
        snprintf(err, errsz, "expected ',' or '}' in JSON object");
        return NULL;
    }
}

static const char *dtg_json_syntax_value(const char *p, const char *end,
                                         int depth, char *err, size_t errsz) {
    if (depth > 64) { snprintf(err, errsz, "JSON nesting too deep"); return NULL; }
    p = dtg_json_syntax_ws(p, end);
    if (p >= end) { snprintf(err, errsz, "expected JSON value"); return NULL; }
    if (*p == '"') return dtg_json_syntax_string(p, end, err, errsz);
    if (*p == '{') return dtg_json_syntax_object(p, end, depth, err, errsz);
    if (*p == '[') return dtg_json_syntax_array(p, end, depth, err, errsz);
    if (*p == '-' || isdigit((unsigned char)*p)) return dtg_json_syntax_number(p, end, err, errsz);
    if (end - p >= 4 && !memcmp(p, "true", 4)) return p + 4;
    if (end - p >= 5 && !memcmp(p, "false", 5)) return p + 5;
    if (end - p >= 4 && !memcmp(p, "null", 4)) return p + 4;
    snprintf(err, errsz, "bad JSON value");
    return NULL;
}

static int dtg_json_validate_complete(const char *json, char required_first,
                                      char *err, size_t errsz) {
    if (!json) { snprintf(err, errsz, "missing JSON"); return 0; }
    const char *end = json + strlen(json);
    const char *p = dtg_json_syntax_ws(json, end);
    if (required_first && (p >= end || *p != required_first)) {
        snprintf(err, errsz, "JSON must start with '%c'", required_first); return 0;
    }
    p = dtg_json_syntax_value(p, end, 0, err, errsz);
    if (!p) return 0;
    p = dtg_json_syntax_ws(p, end);
    if (p != end) { snprintf(err, errsz, "trailing data after JSON value"); return 0; }
    return 1;
}

static dtg_json_token *dtg_json_alloc_token(dtg_json_parser *p,
                                             dtg_json_token *tokens,
                                             size_t count) {
    if (p->next >= count) return NULL;
    dtg_json_token *t = &tokens[p->next++];
    t->type = DTG_JSON_UNDEFINED;
    t->start = t->end = -1;
    t->size = 0;
    t->parent = -1;
    return t;
}

static int dtg_json_parse_string_token(dtg_json_parser *p, const char *json,
                                        size_t len, dtg_json_token *tokens,
                                        size_t count) {
    unsigned start = p->pos + 1;
    for (p->pos++; p->pos < len; p->pos++) {
        unsigned char c = (unsigned char)json[p->pos];
        if (c == '"') {
            dtg_json_token *t = dtg_json_alloc_token(p, tokens, count);
            if (!t) return -2;
            t->type = DTG_JSON_STRING;
            t->start = (int)start;
            t->end = (int)p->pos;
            t->parent = p->super;
            if (p->super >= 0) tokens[p->super].size++;
            return 0;
        }
        if (c < 0x20) return -1;
        if (c == '\\') {
            if (++p->pos >= len) return -1;
            c = (unsigned char)json[p->pos];
            if (c == 'u') {
                for (int n = 0; n < 4; n++) {
                    if (++p->pos >= len || !isxdigit((unsigned char)json[p->pos])) return -1;
                }
            } else if (!strchr("\"/\\bfnrt", c)) {
                return -1;
            }
        }
    }
    return -1;
}

static int dtg_json_parse_primitive_token(dtg_json_parser *p, const char *json,
                                           size_t len, dtg_json_token *tokens,
                                           size_t count) {
    unsigned start = p->pos;
    for (; p->pos < len; p->pos++) {
        unsigned char c = (unsigned char)json[p->pos];
        if (isspace(c) || c == ',' || c == ']' || c == '}') break;
        if (c < 0x20 || c >= 0x7f || c == ':' || c == '[' || c == '{' || c == '"') return -1;
    }
    if (p->pos == start) return -1;
    dtg_json_token *t = dtg_json_alloc_token(p, tokens, count);
    if (!t) return -2;
    t->type = DTG_JSON_PRIMITIVE;
    t->start = (int)start;
    t->end = (int)p->pos;
    t->parent = p->super;
    if (p->super >= 0) tokens[p->super].size++;
    p->pos--;
    return 0;
}

static int dtg_json_tokenize(const char *json, size_t len,
                             dtg_json_token *tokens, size_t count) {
    dtg_json_parser p = {0, 0, -1};
    for (; p.pos < len; p.pos++) {
        unsigned char c = (unsigned char)json[p.pos];
        if (isspace(c) || c == ':' || c == ',') continue;
        if (c == '{' || c == '[') {
            dtg_json_token *t = dtg_json_alloc_token(&p, tokens, count);
            if (!t) return -2;
            t->type = c == '{' ? DTG_JSON_OBJECT : DTG_JSON_ARRAY;
            t->start = (int)p.pos;
            t->parent = p.super;
            if (p.super >= 0) tokens[p.super].size++;
            p.super = (int)p.next - 1;
            continue;
        }
        if (c == '}' || c == ']') {
            dtg_json_type want = c == '}' ? DTG_JSON_OBJECT : DTG_JSON_ARRAY;
            int found = -1;
            for (int i = (int)p.next - 1; i >= 0; i--) {
                if (tokens[i].start >= 0 && tokens[i].end < 0) { found = i; break; }
            }
            if (found < 0 || tokens[found].type != want) return -1;
            tokens[found].end = (int)p.pos + 1;
            p.super = tokens[found].parent;
            continue;
        }
        if (c == '"') {
            int rc = dtg_json_parse_string_token(&p, json, len, tokens, count);
            if (rc) return rc;
            continue;
        }
        int rc = dtg_json_parse_primitive_token(&p, json, len, tokens, count);
        if (rc) return rc;
    }
    for (unsigned i = 0; i < p.next; i++) if (tokens[i].end < 0) return -1;
    if (!p.next) return -1;
    return (int)p.next;
}

static int dtg_hex_value(int c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

static int dtg_json_token_string(const char *json, const dtg_json_token *t,
                                 char *out, size_t outsz) {
    if (!t || t->type != DTG_JSON_STRING || !out || !outsz) return 0;
    size_t o = 0;
    for (int i = t->start; i < t->end; i++) {
        unsigned char c = (unsigned char)json[i];
        if (c == '\\') {
            if (++i >= t->end) return 0;
            c = (unsigned char)json[i];
            if (c == 'u') {
                if (i + 4 >= t->end) return 0;
                unsigned cp = 0;
                for (int n = 0; n < 4; n++) {
                    int h = dtg_hex_value((unsigned char)json[++i]);
                    if (h < 0) return 0;
                    cp = (cp << 4) | (unsigned)h;
                }
                /* This API returns a C string, not a length-bearing byte
                 * buffer. An embedded NUL would erase a suffix from identity,
                 * duplicate-key and authorization comparisons. */
                if (cp == 0) return 0;
                if (cp < 0x80) c = (unsigned char)cp;
                else if (cp < 0x800) {
                    if (o + 2 >= outsz) return 0;
                    out[o++] = (char)(0xc0 | (cp >> 6));
                    c = (unsigned char)(0x80 | (cp & 0x3f));
                } else {
                    if (o + 3 >= outsz) return 0;
                    out[o++] = (char)(0xe0 | (cp >> 12));
                    out[o++] = (char)(0x80 | ((cp >> 6) & 0x3f));
                    c = (unsigned char)(0x80 | (cp & 0x3f));
                }
            } else {
                c = c == 'n' ? '\n' : c == 'r' ? '\r' : c == 't' ? '\t' :
                    c == 'b' ? '\b' : c == 'f' ? '\f' : c;
            }
        }
        if (o + 1 >= outsz) return 0;
        out[o++] = (char)c;
    }
    out[o] = '\0';
    return 1;
}

static int dtg_json_token_eq(const char *json, const dtg_json_token *t,
                             const char *value) {
    size_t n = strlen(value);
    return t && t->type == DTG_JSON_STRING && t->end - t->start == (int)n &&
           !memcmp(json + t->start, value, n);
}

static int dtg_json_object_field(const char *json, const dtg_json_token *tokens,
                                 int count, int object, const char *key) {
    if (object < 0 || object >= count || tokens[object].type != DTG_JSON_OBJECT) return -1;
    int direct_child = 0;
    for (int i = object + 1; i + 1 < count && tokens[i].start < tokens[object].end; i++) {
        if (tokens[i].parent != object) continue;
        int is_key = (direct_child++ & 1) == 0;
        if (!is_key || !dtg_json_token_eq(json, &tokens[i], key)) continue;
        if (tokens[i + 1].parent != object) return -1; /* tokenizer invariant */
        return i + 1;
    }
    return -1;
}

static int dtg_json_array_nth(const dtg_json_token *tokens, int count,
                              int array, int nth) {
    if (array < 0 || array >= count || tokens[array].type != DTG_JSON_ARRAY) return -1;
    int seen = 0;
    for (int i = array + 1; i < count && tokens[i].start < tokens[array].end; i++) {
        if (tokens[i].parent == array && seen++ == nth) return i;
    }
    return -1;
}

/* Reject duplicate object keys before schema lookup.  Accepting the first
 * occurrence while another parser accepts the last is a classic structured
 * control-data ambiguity, so Task Graph and GSA use one unambiguous document. */
static int dtg_json_unique_object_keys(const char *json, const dtg_json_token *tokens,
                                       int count, char *err, size_t errsz) {
    for (int object = 0; object < count; object++) {
        if (tokens[object].type != DTG_JSON_OBJECT) continue;
        int child_count = 0;
        for (int i = object + 1; i < count && tokens[i].start < tokens[object].end; i++)
            if (tokens[i].parent == object) child_count++;
        if (child_count % 2) { snprintf(err, errsz, "JSON object has an incomplete key/value pair"); return 0; }
        char **keys = child_count ? calloc((size_t)child_count / 2, sizeof *keys) : NULL;
        if (child_count && !keys) { snprintf(err, errsz, "out of memory checking JSON keys"); return 0; }
        int child = 0, key_count = 0, ok = 1;
        for (int i = object + 1; i < count && tokens[i].start < tokens[object].end; i++) {
            if (tokens[i].parent != object) continue;
            if ((child++ & 1) != 0) continue; /* value */
            if (tokens[i].type != DTG_JSON_STRING || tokens[i].end - tokens[i].start > 255) {
                snprintf(err, errsz, "JSON object key is invalid or too long"); ok = 0; break;
            }
            keys[key_count] = calloc(256, 1);
            if (!keys[key_count] || !dtg_json_token_string(json, &tokens[i], keys[key_count], 256)) {
                snprintf(err, errsz, "JSON object key cannot be decoded"); ok = 0; break;
            }
            for (int k = 0; k < key_count; k++) {
                if (!strcmp(keys[k], keys[key_count])) {
                    snprintf(err, errsz, "duplicate JSON object key '%s'", keys[key_count]); ok = 0; break;
                }
            }
            if (!ok) break;
            key_count++;
        }
        for (int k = 0; k < key_count + (!ok && key_count < child_count / 2 ? 1 : 0); k++) free(keys[k]);
        free(keys);
        if (!ok) return 0;
    }
    return 1;
}

static int dtg_json_primitive_eq(const char *json, const dtg_json_token *t,
                                 const char *value) {
    size_t n = strlen(value);
    return t && t->type == DTG_JSON_PRIMITIVE && t->end - t->start == (int)n &&
           !memcmp(json + t->start, value, n);
}

static int dtg_json_token_int(const char *json, const dtg_json_token *t,
                              long long lo, long long hi, long long *out) {
    if (!t || t->type != DTG_JSON_PRIMITIVE || t->end <= t->start || t->end - t->start >= 48) return 0;
    char tmp[48];
    memcpy(tmp, json + t->start, (size_t)(t->end - t->start));
    tmp[t->end - t->start] = '\0';
    char *end = NULL;
    errno = 0;
    long long v = strtoll(tmp, &end, 10);
    if (errno || !end || *end || v < lo || v > hi) return 0;
    *out = v;
    return 1;
}

#endif

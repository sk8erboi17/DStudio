/* The structured tool-call preview in extension/remote/dstudio_remote_llm.c:
 * argument fragments become tool_call_begin / tool_call_param /
 * tool_body_delta lines whatever the fragmentation. Production functions,
 * no process, network or model.
 *   cc -std=c11 -Iextension/remote tests/unit/remote_tool_preview_unit.c -o /tmp/t && /tmp/t */
#include "../../extension/remote/dstudio_remote_llm.c" /* first: it selects the POSIX feature level */
#include <assert.h>

typedef struct { dstudio_remote_buf lines; int count; } sink;
static void collect(void *ud, const char *line, size_t len) {
    sink *s = ud;
    assert(len > 2 && line[0] == 0x1e && line[len - 1] == '\n' && !memchr(line + 1, '\n', len - 2));
    dstudio_remote_buf_append(&s->lines, line, len);
    s->count++;
}

static char *field(const char *json, const char *key) {
    char *v = json_string_value(json, key);
    return v ? v : strdup("");
}

/* Rebuild: the event kinds in order (bodies merged) and the decoded body. */
static void summarize(const char *lines, char *kinds, size_t kcap, char *body, size_t bcap, char *last_path, size_t pcap) {
    kinds[0] = body[0] = last_path[0] = '\0';
    const char *p = lines;
    while (p && *p) {
        const char *end = strchr(p, '\n');
        assert(end);
        char *type = field(p + 1, "type");
        if (!strcmp(type, "tool_body_delta")) {
            char *text = field(p + 1, "text");
            strncat(body, text, bcap - strlen(body) - 1);
            size_t k = strlen(kinds);
            if (k < 2 || strcmp(kinds + k - 2, "B,")) strncat(kinds, "B,", kcap - strlen(kinds) - 1);
            free(text);
        } else if (!strcmp(type, "tool_call_begin")) {
            char *name = field(p + 1, "name");
            strncat(kinds, "begin:", kcap - strlen(kinds) - 1); strncat(kinds, name, kcap - strlen(kinds) - 1); strncat(kinds, ",", kcap - strlen(kinds) - 1);
            free(name);
        } else {
            char *param = field(p + 1, "param"), *path = field(p + 1, "path");
            strncat(kinds, param, kcap - strlen(kinds) - 1); strncat(kinds, "@", kcap - strlen(kinds) - 1);
            strncat(kinds, path, kcap - strlen(kinds) - 1); strncat(kinds, ",", kcap - strlen(kinds) - 1);
            snprintf(last_path, pcap, "%s", path);
            free(param); free(path);
        }
        free(type);
        p = end + 1;
    }
}

static void run(const char *name, const char *args, size_t split_a, size_t split_b, sink *out) {
    preview_state ps = { .emit = collect, .ud = out };
    size_t n = strlen(args);
    char frag[8192];
    preview_feed(&ps, 0, name, NULL);
    size_t cuts[4] = {0, split_a < n ? split_a : n, split_b < n ? split_b : n, n};
    for (int i = 0; i < 3; i++) {
        if (cuts[i + 1] <= cuts[i]) continue;
        memcpy(frag, args + cuts[i], cuts[i + 1] - cuts[i]); frag[cuts[i + 1] - cuts[i]] = '\0';
        preview_feed(&ps, 0, NULL, frag);
    }
    preview_free(&ps);
}

static void every_split(const char *name, const char *args, const char *want_kinds, const char *want_body) {
    size_t n = strlen(args);
    for (size_t a = 0; a <= n; a++) for (size_t b = a; b <= n; b += (n / 7) + 1) {
        sink out = {0};
        run(name, args, a, b, &out);
        char kinds[1024], body[4096], path[1100];
        summarize(out.lines.ptr ? out.lines.ptr : "", kinds, sizeof kinds, body, sizeof body, path, sizeof path);
        if (strcmp(kinds, want_kinds) || strcmp(body, want_body)) {
            fprintf(stderr, "split %zu/%zu\n kinds %s\n want  %s\n body  %s\n want  %s\n", a, b, kinds, want_kinds, body, want_body);
            assert(0);
        }
        dstudio_remote_buf_free(&out.lines);
    }
}

int main(void) {
    /* write: path then content with escapes, a 2-byte \u, a surrogate pair and raw UTF-8. */
    every_split("write", "{\"path\":\"site/index.html\",\"content\":\"<h1>Ciao \\u00e8 \\ud83d\\ude00 \xc3\xa0</h1>\\n\\\"q\\\" \\\\ end\"}",
                "begin:write,path@,content@site/index.html,B,",
                "<h1>Ciao \xc3\xa8 \xf0\x9f\x98\x80 \xc3\xa0</h1>\n\"q\" \\ end");
    /* The path closes after the body: the body param learns it afterwards. */
    every_split("write", "{ \"content\" : \"abc\" , \"path\" : \"x.md\" }",
                "begin:write,content@,B,path@,content@x.md,", "abc");
    /* edit old/new are bodies; a number and a nested array with quotes and braces are skipped. */
    every_split("edit", "{\"path\":\"a.c\",\"n\":12,\"meta\":[{\"k\":\"}\\\"]\"}],\"old\":\"x\",\"new\":\"y\"}",
                "begin:edit,path@,n@a.c,meta@a.c,old@a.c,B,new@a.c,B,", "xy");
    /* A non-body string (read's path only; todos JSON) previews no body. */
    every_split("read", "{\"path\":\"README.md\"}", "begin:read,path@,", "");
    every_split("todo_write", "{\"todos\":\"[{\\\"text\\\":\\\"a\\\"}]\"}", "begin:todo_write,todos@,", "");
    /* bash command is a body. */
    every_split("bash", "{\"command\":\"ls -la\"}", "begin:bash,command@,B,", "ls -la");

    /* Arguments before the name are held, then replayed once the name is known. */
    {
        sink out = {0};
        preview_state ps = { .emit = collect, .ud = &out };
        preview_feed(&ps, 1, NULL, "{\"path\":\"p\",\"content\":\"he");
        assert(out.count == 0);
        preview_feed(&ps, 1, "write", "llo\"}");
        char kinds[256], body[256], path[64];
        summarize(out.lines.ptr, kinds, sizeof kinds, body, sizeof body, path, sizeof path);
        assert(!strcmp(kinds, "begin:write,path@,content@p,B,") && !strcmp(body, "hello"));
        preview_free(&ps); dstudio_remote_buf_free(&out.lines);
    }
    /* Malformed JSON ends that call's preview without output past the error. */
    {
        sink out = {0};
        preview_state ps = { .emit = collect, .ud = &out };
        preview_feed(&ps, 0, "write", "{\"path\" x \"content\":\"never\"}");
        char kinds[256], body[256], path[64];
        summarize(out.lines.ptr, kinds, sizeof kinds, body, sizeof body, path, sizeof path);
        assert(!strcmp(kinds, "begin:write,") && !body[0]);
        assert(ps.calls[0].state == PV_INVALID);
        preview_free(&ps); dstudio_remote_buf_free(&out.lines);
    }
    /* Out-of-range indexes and a missing emitter are ignored. */
    {
        preview_state none = {0};
        preview_feed(&none, 0, "write", "{\"content\":\"x\"}");
        sink out = {0};
        preview_state ps = { .emit = collect, .ud = &out };
        preview_feed(&ps, PREVIEW_CALLS, "write", "{}");
        preview_feed(&ps, -1, "write", "{}");
        assert(out.count == 0);
        preview_free(&ps);
    }
    /* A long body arrives in several bounded deltas, never one block. */
    {
        sink out = {0};
        preview_state ps = { .emit = collect, .ud = &out };
        preview_feed(&ps, 0, "write", "{\"path\":\"big.txt\",\"content\":\"");
        for (int i = 0; i < 400; i++) preview_feed(&ps, 0, NULL, "0123456789");
        preview_feed(&ps, 0, NULL, "\"}");
        char kinds[256], body[8192], path[64];
        summarize(out.lines.ptr, kinds, sizeof kinds, body, sizeof body, path, sizeof path);
        assert(strlen(body) == 4000);
        int deltas = 0;
        for (const char *q = out.lines.ptr; (q = strstr(q, "tool_body_delta")); q++) deltas++;
        assert(deltas >= 4000 / (PREVIEW_BATCH * 4));
        preview_free(&ps); dstudio_remote_buf_free(&out.lines);
    }
    puts("remote_tool_preview_unit: ok (production preview scanner; every 2-cut split of each argument object, no model)");
    return 0;
}

/* Executes the real Agent IDE workspace handlers (src/dstudio_agent_workspace.c)
 * and the real connection dispatcher against a task-owned temporary workspace.
 * A task-owned sleeping child stands in for the running Agent process; no
 * engine, model or network service is touched. Asserts observable HTTP
 * results and the bytes, modes and directory entries left on disk. */
#define _GNU_SOURCE
#include <assert.h>
#define main dstudio_embedded_main_for_tests
#include "../../src/dstudio.c"
#undef main

#ifndef _WIN32
typedef struct { int fd; char *buf; size_t len; } reader_t;

static void *read_all(void *arg) {
    reader_t *r = arg;
    size_t cap = 1 << 16;
    r->buf = malloc(cap);
    assert(r->buf);
    for (;;) {
        if (r->len + 4096 > cap) { cap *= 2; r->buf = realloc(r->buf, cap); assert(r->buf); }
        ssize_t n = read(r->fd, r->buf + r->len, cap - r->len - 1);
        if (n <= 0) break;
        r->len += (size_t)n;
    }
    r->buf[r->len] = '\0';
    return NULL;
}

typedef struct { int code; char *raw; const char *body; } reply_t;

static reply_t parse_reply(char *raw) {
    reply_t r = { 0, raw, "" };
    assert(sscanf(raw, "HTTP/1.1 %d", &r.code) == 1);
    char *b = strstr(raw, "\r\n\r\n");
    if (b) r.body = b + 4;
    return r;
}

/* Calls the production POST router directly: the reply is drained by a
 * reader thread so multi-megabyte responses cannot block the handler. */
static reply_t post(const char *path, const char *body) {
    int sv[2];
    assert(socketpair(AF_UNIX, SOCK_STREAM, 0, sv) == 0);
    reader_t rd = { sv[1], NULL, 0 };
    pthread_t t;
    assert(pthread_create(&t, NULL, read_all, &rd) == 0);
    route_post_api(sv[0], path, body);
    shutdown(sv[0], SHUT_WR);
    close(sv[0]);
    pthread_join(t, NULL);
    close(sv[1]);
    return parse_reply(rd.buf);
}

typedef struct { int fd; const char *data; size_t len; } writer_t;

static void *write_all(void *arg) {
    writer_t *w = arg;
    size_t off = 0;
    while (off < w->len) {
        ssize_t n = write(w->fd, w->data + off, w->len - off);
        if (n <= 0) break;
        off += (size_t)n;
    }
    return NULL;
}

/* Full HTTP request over a real 127.0.0.1 TCP connection through
 * handle_connection(): loopback gating, CSRF and the dedicated save body path. */
static reply_t http(const char *method, const char *path, const char *body, int csrf) {
    int ls = socket(AF_INET, SOCK_STREAM, 0);
    assert(ls >= 0);
    struct sockaddr_in a = { 0 };
    a.sin_family = AF_INET;
    a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    assert(bind(ls, (struct sockaddr *)&a, sizeof a) == 0 && listen(ls, 1) == 0);
    socklen_t al = sizeof a;
    assert(getsockname(ls, (struct sockaddr *)&a, &al) == 0);
    int c = socket(AF_INET, SOCK_STREAM, 0);
    assert(c >= 0 && connect(c, (struct sockaddr *)&a, sizeof a) == 0);
    int s = accept(ls, NULL, NULL);
    assert(s >= 0);
    close(ls);
    size_t blen = body ? strlen(body) : 0;
    char *req = malloc(blen + 512);
    assert(req);
    int hn = snprintf(req, 512, "%s %s HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\n"
                      "%sContent-Length: %zu\r\n\r\n", method, path,
                      csrf ? "X-Requested-With: ds4web\r\n" : "", blen);
    if (blen) memcpy(req + hn, body, blen);
    writer_t w = { c, req, (size_t)hn + blen };
    pthread_t t;
    assert(pthread_create(&t, NULL, write_all, &w) == 0);
    handle_connection(s);
    pthread_join(t, NULL);
    reader_t rd = { c, NULL, 0 };
    read_all(&rd);
    close(c);
    free(req);
    return parse_reply(rd.buf);
}

static void put_file(const char *path, const char *data, size_t len, mode_t mode) {
    int f = open(path, O_WRONLY | O_CREAT | O_TRUNC, mode);
    assert(f >= 0);
    assert(write(f, data, len) == (ssize_t)len);
    assert(fchmod(f, mode) == 0);
    close(f);
}

static char *slurp(const char *path, size_t *len) {
    int too_large = 0;
    char *p = agent_ide_read_bytes(path, 64 * 1024 * 1024, len, &too_large);
    assert(p);
    return p;
}

static void digest_of(const char *path, char *out) {
    size_t n; char *p = slurp(path, &n);
    agent_ide_digest(p, n, out, 64);
    free(p);
}

static int leftover_temp_files(const char *dir) {
    DIR *d = opendir(dir);
    assert(d);
    int n = 0;
    struct dirent *de;
    while ((de = readdir(d)) != NULL) if (strstr(de->d_name, ".dstudio-save-")) n++;
    closedir(d);
    return n;
}

static int passed = 0;
#define CHECK(name) do { passed++; printf("PASS %s\n", name); } while (0)

int main(void) {
    char base[] = "/tmp/dstudio-agent-ide-XXXXXX";
    assert(mkdtemp(base));
    char ws[512], outside[512], p[1024], q[1024];
    snprintf(ws, sizeof ws, "%s/workspace è", base);
    snprintf(outside, sizeof outside, "%s/outside", base);
    assert(mkdir(ws, 0755) == 0 && mkdir(outside, 0755) == 0);
    snprintf(p, sizeof p, "%s/sub", ws); assert(mkdir(p, 0755) == 0);
    const char hello[] = "h\xc3\xa9llo \"quoted\" \\ tab\tend\n";
    snprintf(p, sizeof p, "%s/a.txt", ws); put_file(p, hello, strlen(hello), 0640);
    snprintf(p, sizeof p, "%s/sub/b.rs", ws); put_file(p, "fn main() {}\n", 13, 0644);
    snprintf(p, sizeof p, "%s/bin.dat", ws); put_file(p, "ab\0cd", 5, 0644);
    snprintf(p, sizeof p, "%s/latin1.txt", ws); put_file(p, "caf\xe9\n", 5, 0644);
    snprintf(p, sizeof p, "%s/secret.txt", outside); put_file(p, "OUTSIDE_SECRET\n", 15, 0644);
    snprintf(p, sizeof p, "%s/link-in", ws); assert(symlink("a.txt", p) == 0);
    snprintf(p, sizeof p, "%s/link-out", ws); snprintf(q, sizeof q, "%s/secret.txt", outside);
    assert(symlink(q, p) == 0);
    snprintf(p, sizeof p, "%s/dir-out", ws); assert(symlink(outside, p) == 0);
    snprintf(p, sizeof p, "%s/linked.txt", ws); put_file(p, "two names\n", 10, 0644);
    snprintf(q, sizeof q, "%s/linked-again.txt", ws); assert(link(p, q) == 0);
    {
        size_t big = (size_t)AGENT_IDE_FILE_MAX + 10;
        char *data = malloc(big); assert(data); memset(data, 'x', big);
        snprintf(p, sizeof p, "%s/big.log", ws); put_file(p, data, big, 0644);
        free(data);
    }

    /* Not the Agent runtime: refused before touching the filesystem. */
    /* The stand-in exits on its own when this test dies (lifeline EOF), so a
     * failed assertion cannot leave it holding the caller's output pipe. */
    int lifeline[2];
    assert(pipe(lifeline) == 0);
    pid_t agent = fork();
    assert(agent >= 0);
    if (!agent) {
        close(lifeline[1]);
        int devnull = open("/dev/null", O_WRONLY);
        if (devnull >= 0) { dup2(devnull, 1); dup2(devnull, 2); close(devnull); }
        char byte;
        while (read(lifeline[0], &byte, 1) > 0) {}
        _exit(0);
    }
    close(lifeline[0]);
    cstr_copy(g_workdir, sizeof g_workdir, ws);
    g_child = agent;
    g_mode = ENGINE_COWORK;
    reply_t r = post("/api/agent/fs/list", "{\"path\":\"\"}");
    assert(r.code == 409 && strstr(r.body, "agent_not_running"));
    g_mode = ENGINE_AGENT; g_child = 0;
    r = post("/api/agent/fs/list", "{\"path\":\"\"}");
    assert(r.code == 409 && strstr(r.body, "agent_not_running"));
    g_child = agent;
    g_mode = ENGINE_DESIGN;
    r = post("/api/agent/fs/list", "{\"path\":\"\"}");
    assert(r.code == 200 && strstr(r.body, "\"name\":\"a.txt\""));
    free(r.raw);
    g_mode = ENGINE_AGENT;
    CHECK("only a running Agent or Design runtime exposes its workspace");

    char root[DSTUDIO_PATH_MAX];
    assert(realpath(ws, root));
    r = post("/api/agent/fs/list", "{\"path\":\"\"}");
    assert(r.code == 200);
    assert(strstr(r.body, "\"agentWorking\":false"));
    assert(strstr(r.body, "\"name\":\"a.txt\",\"type\":\"file\",\"size\":"));
    assert(strstr(r.body, "\"name\":\"sub\",\"type\":\"dir\""));
    assert(strstr(r.body, "\"name\":\"link-in\",\"type\":\"file\"") && strstr(r.body, "\"link\":\"inside\""));
    assert(strstr(r.body, "\"name\":\"link-out\",\"type\":\"other\"") && strstr(r.body, "\"link\":\"outside\""));
    assert(strstr(r.body, "\"name\":\"dir-out\",\"type\":\"other\""));
    assert(strstr(r.body, "\"truncated\":false"));
    {
        char want[DSTUDIO_PATH_MAX + 32];
        snprintf(want, sizeof want, "\"root\":\"%s\"", root);
        assert(strstr(r.body, want));
    }
    free(r.raw);
    r = post("/api/agent/fs/list", "{\"path\":\"sub\"}");
    assert(r.code == 200 && strstr(r.body, "\"name\":\"b.rs\""));
    free(r.raw);
    CHECK("lists one directory with symlink confinement metadata");

    const char *escapes[] = { "{\"path\":\"../outside\"}", "{\"path\":\"/etc\"}", "{\"path\":\"sub/../..\"}", "{\"path\":\"./sub\"}" };
    for (size_t i = 0; i < sizeof escapes / sizeof *escapes; i++) {
        r = post("/api/agent/fs/list", escapes[i]);
        assert(r.code == 400 && strstr(r.body, "invalid_path"));
        free(r.raw);
    }
    r = post("/api/agent/fs/list", "{\"path\":\"dir-out\"}");
    assert(r.code == 403 && strstr(r.body, "outside_workspace"));
    free(r.raw);
    r = post("/api/agent/fs/read", "{\"path\":\"link-out\"}");
    assert(r.code == 403 && strstr(r.body, "outside_workspace") && !strstr(r.body, "OUTSIDE_SECRET"));
    free(r.raw);
    r = post("/api/agent/fs/read", "{\"path\":\"dir-out/secret.txt\"}");
    assert(r.code == 403 && !strstr(r.body, "OUTSIDE_SECRET"));
    free(r.raw);
    CHECK("relative-path syntax and symlink escapes are refused");

    char dg[64];
    snprintf(p, sizeof p, "%s/a.txt", ws);
    digest_of(p, dg);
    r = post("/api/agent/fs/read", "{\"path\":\"a.txt\"}");
    assert(r.code == 200);
    assert(strstr(r.body, "\"content\":\"h\xc3\xa9llo \\\"quoted\\\" \\\\ tab\\tend\\n\""));
    {
        char want[96]; snprintf(want, sizeof want, "\"digest\":\"%s\"", dg);
        assert(strstr(r.body, want));
    }
    assert(strstr(r.body, "\"writable\":true") && strstr(r.body, "\"symlink\":false"));
    free(r.raw);
    r = post("/api/agent/fs/read", "{\"path\":\"bin.dat\"}");
    assert(r.code == 200 && strstr(r.body, "\"binary\":true") && !strstr(r.body, "\"content\""));
    assert(strstr(r.body, "\"writable\":false"));
    free(r.raw);
    r = post("/api/agent/fs/read", "{\"path\":\"latin1.txt\"}");
    assert(r.code == 200 && strstr(r.body, "\"utf8\":false") && !strstr(r.body, "\"content\""));
    free(r.raw);
    r = post("/api/agent/fs/read", "{\"path\":\"big.log\"}");
    assert(r.code == 200 && strstr(r.body, "\"tooLarge\":true") && !strstr(r.body, "\"content\""));
    free(r.raw);
    r = post("/api/agent/fs/read", "{\"path\":\"link-in\"}");
    assert(r.code == 200 && strstr(r.body, "\"symlink\":true") && strstr(r.body, "\"writable\":false"));
    free(r.raw);
    r = post("/api/agent/fs/read", "{\"path\":\"linked.txt\"}");
    assert(r.code == 200 && strstr(r.body, "\"writable\":false"));
    free(r.raw);
    r = post("/api/agent/fs/read", "{\"path\":\"missing.txt\"}");
    assert(r.code == 404);
    free(r.raw);
    CHECK("reads publish content only when it round-trips as UTF-8 text");

    /* Saves: every refusal leaves the original bytes in place. */
    char body[4096];
    size_t before_len; char *before = slurp(p, &before_len);
    g_agent_working = 1;
    snprintf(body, sizeof body, "{\"path\":\"a.txt\",\"expectedDigest\":\"%s\",\"content\":\"agent busy\"}", dg);
    r = post("/api/agent/fs/write", body);
    assert(r.code == 409 && strstr(r.body, "agent_working"));
    free(r.raw);
    g_agent_working = 0; g_agent_session_working = 1;
    r = post("/api/agent/fs/write", body);
    assert(r.code == 409 && strstr(r.body, "agent_working"));
    free(r.raw);
    g_agent_session_working = 0; g_child_stop_requested = 1;
    r = post("/api/agent/fs/write", body);
    assert(r.code == 409 && strstr(r.body, "agent_working"));
    free(r.raw);
    g_child_stop_requested = 0;
    CHECK("saves are refused while the agent owns the workspace");

    r = post("/api/agent/fs/write", "{\"path\":\"a.txt\",\"expectedDigest\":\"fnv1a64:0000000000000000:3\",\"content\":\"stale\"}");
    assert(r.code == 409 && strstr(r.body, "digest_mismatch"));
    {
        char want[96]; snprintf(want, sizeof want, "\"currentDigest\":\"%s\"", dg);
        assert(strstr(r.body, want));
    }
    free(r.raw);
    snprintf(body, sizeof body, "{\"path\":\"a.txt\",\"expectedDigest\":\"%s\",\"content\":\"lone \\udc00 surrogate\"}", dg);
    r = post("/api/agent/fs/write", body);
    assert(r.code == 400 && strstr(r.body, "invalid_content"));
    free(r.raw);
    snprintf(body, sizeof body, "{\"path\":\"a.txt\",\"expectedDigest\":\"%s\",\"content\":\"nul \\u0000 byte\"}", dg);
    r = post("/api/agent/fs/write", body);
    assert(r.code == 400 && strstr(r.body, "invalid_content"));
    free(r.raw);
    snprintf(body, sizeof body, "{\"path\":\"a.txt\",\"content\":\"no digest\"}");
    r = post("/api/agent/fs/write", body);
    assert(r.code == 400 && strstr(r.body, "missing_digest"));
    free(r.raw);
    {
        char ldg[64]; snprintf(q, sizeof q, "%s/link-in", ws); digest_of(q, ldg);
        snprintf(body, sizeof body, "{\"path\":\"link-in\",\"expectedDigest\":\"%s\",\"content\":\"via link\"}", ldg);
        r = post("/api/agent/fs/write", body);
        assert(r.code == 409 && strstr(r.body, "not_editable"));
        free(r.raw);
        snprintf(q, sizeof q, "%s/linked.txt", ws); digest_of(q, ldg);
        snprintf(body, sizeof body, "{\"path\":\"linked.txt\",\"expectedDigest\":\"%s\",\"content\":\"split\"}", ldg);
        r = post("/api/agent/fs/write", body);
        assert(r.code == 409 && strstr(r.body, "hard_linked"));
        free(r.raw);
        r = post("/api/agent/fs/write", "{\"path\":\"../outside/secret.txt\",\"expectedDigest\":\"x\",\"content\":\"x\"}");
        assert(r.code == 400);
        free(r.raw);
        r = post("/api/agent/fs/write", "{\"path\":\"dir-out/secret.txt\",\"expectedDigest\":\"x\",\"content\":\"x\"}");
        assert(r.code == 403);
        free(r.raw);
        r = post("/api/agent/fs/write", "{\"path\":\"new-file.txt\",\"expectedDigest\":\"x\",\"content\":\"x\"}");
        assert(r.code == 404);
        free(r.raw);
    }
    size_t after_len; char *after = slurp(p, &after_len);
    assert(after_len == before_len && !memcmp(before, after, before_len));
    free(after);
    snprintf(q, sizeof q, "%s/secret.txt", outside);
    after = slurp(q, &after_len);
    assert(after_len == 15 && !memcmp(after, "OUTSIDE_SECRET\n", 15));
    free(after);
    snprintf(q, sizeof q, "%s/new-file.txt", ws);
    assert(access(q, F_OK) != 0);
    assert(leftover_temp_files(ws) == 0);
    CHECK("stale, malformed, linked and escaping saves change nothing");

    /* Admitted save: exact bytes (all JSON escapes, a surrogate pair),
     * permission bits kept, no temp files left, digest of the new bytes. */
    snprintf(body, sizeof body,
             "{\"path\":\"a.txt\",\"expectedDigest\":\"%s\",\"content\":\"line1\\nT\\u00e9st \\ud83e\\uddea \\\"q\\\" \\\\ \\/ \\t\\r\\b\\f end\"}", dg);
    r = post("/api/agent/fs/write", body);
    assert(r.code == 200 && strstr(r.body, "\"ok\":true"));
    const char expect[] = "line1\nT\xc3\xa9st \xf0\x9f\xa7\xaa \"q\" \\ / \t\r\b\f end";
    after = slurp(p, &after_len);
    assert(after_len == sizeof expect - 1 && !memcmp(after, expect, after_len));
    free(after);
    struct stat st; assert(stat(p, &st) == 0 && (st.st_mode & 07777) == 0640);
    char ndg[64]; digest_of(p, ndg);
    {
        char want[96]; snprintf(want, sizeof want, "\"digest\":\"%s\"", ndg);
        assert(strstr(r.body, want));
    }
    free(r.raw);
    assert(leftover_temp_files(ws) == 0);
    snprintf(body, sizeof body, "{\"path\":\"a.txt\",\"expectedDigest\":\"%s\",\"content\":\"second\"}", dg);
    r = post("/api/agent/fs/write", body);
    assert(r.code == 409 && strstr(r.body, "digest_mismatch"));
    free(r.raw);
    CHECK("an admitted save replaces the exact bytes atomically");

    /* Dispatcher: CSRF, loopback, the GET surface and the large save body. */
    r = http("POST", "/api/agent/fs/read", "{\"path\":\"a.txt\"}", 0);
    assert(r.code == 403 && !strstr(r.body, "line1"));
    free(r.raw);
    r = http("POST", "/api/agent/fs/write", "{\"path\":\"a.txt\",\"expectedDigest\":\"x\",\"content\":\"x\"}", 0);
    assert(r.code == 403);
    free(r.raw);
    r = http("GET", "/api/agent/fs/read?path=a.txt", NULL, 1);
    assert(r.code != 200 && !strstr(r.body, "line1"));
    free(r.raw);
    r = http("POST", "/api/agent/fs/read", "{\"path\":\"a.txt\"}", 1);
    assert(r.code == 200 && strstr(r.body, "line1"));
    free(r.raw);
    {
        /* 1.5 MiB of quotes: the JSON body (~3 MiB) exceeds the generic
         * BODY_MAX and must still reach the save handler intact. */
        size_t n = 1536 * 1024;
        char *big = malloc(n * 2 + 256);
        assert(big);
        int k = snprintf(big, 256, "{\"path\":\"a.txt\",\"expectedDigest\":\"%s\",\"content\":\"", ndg);
        for (size_t i = 0; i < n; i++) { big[k++] = '\\'; big[k++] = '"'; }
        big[k++] = '"'; big[k++] = '}'; big[k] = '\0';
        assert((size_t)k > BODY_MAX);
        r = http("POST", "/api/agent/fs/write", big, 1);
        assert(r.code == 200);
        free(r.raw);
        after = slurp(p, &after_len);
        assert(after_len == n);
        for (size_t i = 0; i < n; i++) assert(after[i] == '"');
        free(after);
        free(big);
    }
    CHECK("dispatcher enforces CSRF and carries large saves intact");

    /* Design no longer requires an empty folder: the cleanup that follows
     * deleting the last design conversation removes only files the design run
     * created, never the user's files that were there when it started. */
    {
        char dd[700], f[900];
        snprintf(dd, sizeof dd, "%s/design project", base);
        assert(mkdir(dd, 0755) == 0);
        const char *mine[] = { "mine.html", "notes.txt", ".hidden" };
        for (size_t i = 0; i < 3; i++) { snprintf(f, sizeof f, "%s/%s", dd, mine[i]); put_file(f, "user", 4, 0644); }
        design_snapshot_preexisting(dd);
        cstr_copy(g_design_dir, sizeof g_design_dir, dd);
        snprintf(f, sizeof f, "%s/index.html", dd); put_file(f, "<p>design</p>", 13, 0644);
        snprintf(f, sizeof f, "%s/styles.css", dd); put_file(f, "p{}", 3, 0644);
        g_design_preexisting_overflow = 1;
        r = post("/api/design/clean", "{}");
        assert(r.code == 409 && strstr(r.body, "preexisting_untracked"));
        free(r.raw);
        snprintf(f, sizeof f, "%s/index.html", dd); assert(access(f, F_OK) == 0);
        g_design_preexisting_overflow = 0;
        r = post("/api/design/clean", "{}");
        assert(r.code == 200 && strstr(r.body, "\"removed\":2"));
        free(r.raw);
        for (size_t i = 0; i < 3; i++) { snprintf(f, sizeof f, "%s/%s", dd, mine[i]); assert(access(f, F_OK) == 0); }
        snprintf(f, sizeof f, "%s/index.html", dd); assert(access(f, F_OK) != 0);
        snprintf(f, sizeof f, "%s/styles.css", dd); assert(access(f, F_OK) != 0);
        g_design_dir[0] = '\0';
        CHECK("design cleanup keeps the user's files that predate the run");
    }

    /* The Open IDE live design frame: the only script it allows is its own
     * bootstrap, by a nonce that is fresh for every response. */
    {
        char first_nonce[40] = "";
        for (int i = 0; i < 2; i++) {
            r = http("GET", "/api/design/live-frame?t=abc", NULL, 0);
            assert(r.code == 200);
            const char *csp = strstr(r.raw, "Content-Security-Policy: default-src 'none'; script-src 'nonce-");
            assert(csp && strstr(r.raw, "Cache-Control: no-store"));
            char nonce[40] = "";
            assert(sscanf(csp, "Content-Security-Policy: default-src 'none'; script-src 'nonce-%32[0-9a-f]'", nonce) == 1);
            assert(strlen(nonce) == 32);
            char tag[80];
            snprintf(tag, sizeof tag, "<script nonce=\"%s\">", nonce);
            assert(strstr(r.body, tag) && !strncmp(r.body, "<!doctype html>", 15));
            const char *ss = strstr(csp, "script-src");
            char directive[160];
            snprintf(directive, sizeof directive, "%.*s", (int)strcspn(ss, ";\r"), ss);
            snprintf(tag, sizeof tag, "script-src 'nonce-%s'", nonce);
            assert(!strcmp(directive, tag)); /* nothing else may run */
            if (i == 0) cstr_copy(first_nonce, sizeof first_nonce, nonce);
            else assert(strcmp(first_nonce, nonce) != 0);
            free(r.raw);
        }
        r = http("GET", "/api/design/live-frame?t=abc&mode=quirks", NULL, 0);
        assert(r.code == 200 && !strncmp(r.body, "<html>", 6));
        free(r.raw);
        r = http("GET", "/api/design/live-framework", NULL, 0);
        assert(r.code != 200 || !strstr(r.raw, "script-src 'nonce-"));
        free(r.raw);
        g_bind_host[0] = '\0';
        cstr_copy(g_bind_host, sizeof g_bind_host, "0.0.0.0");
        assert(!lan_public_path_allowed("GET", "/api/design/live-frame"));
        cstr_copy(g_bind_host, sizeof g_bind_host, "127.0.0.1");
        CHECK("the live design frame allows only its bootstrap, by a fresh nonce");
    }

    g_bind_host[0] = '\0';
    cstr_copy(g_bind_host, sizeof g_bind_host, "0.0.0.0");
    assert(!lan_public_path_allowed("POST", "/api/agent/fs/list"));
    assert(!lan_public_path_allowed("POST", "/api/agent/fs/read"));
    assert(!lan_public_path_allowed("POST", "/api/agent/fs/write"));
    assert(!lan_public_path_allowed("OPTIONS", "/api/agent/fs/read"));
    cstr_copy(g_bind_host, sizeof g_bind_host, "127.0.0.1");
    CHECK("workspace endpoints stay host-local with LAN enabled");

    g_child = 0; g_mode = ENGINE_NONE;
    kill(agent, SIGKILL);
    waitpid(agent, NULL, 0);
    char cmd[700];
    snprintf(cmd, sizeof cmd, "rm -rf '%s'", base);
    assert(system(cmd) == 0);
    printf("agent_workspace_unit: %d/%d passed\n", passed, passed);
    return 0;
}
#else
int main(void) {
    puts("agent_workspace_unit: NOT RUN on Windows (endpoints answer 501 there)");
    return 1;
}
#endif

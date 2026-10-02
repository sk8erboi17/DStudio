/* ============================================================================
 * Agent IDE: workspace files for the "Open IDE" view.
 *
 *   POST /api/agent/fs/list  {path}                          one directory
 *   POST /api/agent/fs/read  {path}                          one text file
 *   POST /api/agent/fs/write {path, expectedDigest, content} user save
 *
 * Owner: the running Agent or Design process owns its workspace (g_workdir:
 * the Agent's --chdir, the Design project folder). The host never edits it
 * on the runtime's behalf. These endpoints expose that same directory to the
 * IDE view, and admit a USER save only while no turn or session command is
 * active. Cowork is not exposed: its folder holds the user's documents.
 *
 * Revalidation for a save, all on the single-threaded HTTP loop so no agent
 * send can be admitted in between:
 *   1. the Agent runtime is the running engine and its workspace resolves;
 *   2. g_agent_working / g_agent_session_working / g_child_stop_requested
 *      are clear (they are set synchronously when a send is admitted);
 *   3. the target is a regular, singly linked, non-symlink file whose
 *      resolved path stays inside realpath(workspace);
 *   4. the bytes on disk still have the digest the editor loaded. The digest
 *      is FNV-1a 64 over the content: a change detector for optimistic
 *      concurrency, not a security hash.
 * Commit: temp file in the same directory, fsync, rename over the target,
 * fsync of the directory. A crash leaves either the old or the new bytes.
 * The temp file keeps the original permission bits. Rename gives the file a
 * new inode, which is why hard-linked files are refused instead of split.
 *
 * Confinement: requests carry paths RELATIVE to the workspace (same syntax
 * rules as design paths: no "..", ".", absolute or control bytes). Every
 * resolved path, symlinks included, must stay inside the workspace root.
 *
 * Bounds: one directory per request with at most AGENT_IDE_LIST_MAX entries,
 * files up to AGENT_IDE_FILE_MAX bytes, save bodies up to
 * AGENT_IDE_WRITE_BODY_MAX. They run on the HTTP loop, so each request is a
 * single bounded directory scan or file read/write.
 *
 * Windows: _fullpath does not resolve symlinks/junctions and rename does not
 * replace, so confinement and atomic save are not established there. The
 * endpoints answer 501 instead of serving an unverified path policy.
 * ==========================================================================*/

#define AGENT_IDE_LIST_MAX        2000
#define AGENT_IDE_FILE_MAX        (2L * 1024 * 1024)
#define AGENT_IDE_WRITE_BODY_MAX  (16L * 1024 * 1024)

static void agent_ide_error(int fd, const char *status, const char *code, const char *msg) {
    char esc[512], out[700];
    json_escape_into(esc, sizeof esc, msg, strlen(msg));
    snprintf(out, sizeof out, "{\"ok\":false,\"code\":\"%s\",\"error\":\"%s\"}", code, esc);
    send_json(fd, status, out);
}

#ifdef _WIN32
static void api_agent_fs_list(int fd, const char *body) {
    (void)body;
    agent_ide_error(fd, "501 Not Implemented", "unsupported_platform",
                    "The IDE workspace view is not available on Windows yet");
}
static void api_agent_fs_read(int fd, const char *body) { api_agent_fs_list(fd, body); }
static void api_agent_fs_write(int fd, const char *body) { api_agent_fs_list(fd, body); }
#else

/* Workspace root of the RUNNING Agent or Design runtime, resolved. */
static int agent_ide_root(int fd, char *root, size_t rootsz) {
    if ((g_mode != ENGINE_AGENT && g_mode != ENGINE_DESIGN) || g_child <= 0 || !g_workdir[0]) {
        agent_ide_error(fd, "409 Conflict", "agent_not_running",
                        "Start the Agent or Design with a workspace to open the IDE");
        return 0;
    }
    char abs[DSTUDIO_PATH_MAX];
    struct stat st;
    if (!realpath(g_workdir, abs) || stat(abs, &st) != 0 || !S_ISDIR(st.st_mode)) {
        agent_ide_error(fd, "409 Conflict", "workspace_missing", "The Agent workspace folder is not available");
        return 0;
    }
    if (strlen(abs) + 1 > rootsz) {
        agent_ide_error(fd, "500 Internal Server Error", "path_too_long", "Workspace path is too long");
        return 0;
    }
    memcpy(root, abs, strlen(abs) + 1);
    return 1;
}

static int agent_ide_inside(const char *root, const char *real) {
    size_t rl = strlen(root);
    if (rl == 1 && root[0] == '/') return real[0] == '/';
    return !strncmp(real, root, rl) && (real[rl] == '\0' || real[rl] == '/');
}

/* rel "" is the workspace root (listing only). Fills full (lexical) and real
 * (resolved). 0 + response sent on failure. */
static int agent_ide_resolve(int fd, const char *root, const char *rel, int allow_root,
                             char *full, size_t fullsz, char *real) {
    if (!(allow_root && !rel[0]) && !design_rel_path_ok(rel)) {
        agent_ide_error(fd, "400 Bad Request", "invalid_path", "Use a path relative to the workspace");
        return 0;
    }
    int n = rel[0] ? snprintf(full, fullsz, "%s/%s", root, rel) : snprintf(full, fullsz, "%s", root);
    if (n < 0 || (size_t)n >= fullsz) {
        agent_ide_error(fd, "400 Bad Request", "path_too_long", "Path is too long");
        return 0;
    }
    if (!realpath(full, real)) {
        agent_ide_error(fd, "404 Not Found", "not_found", "File or folder not found");
        return 0;
    }
    if (!agent_ide_inside(root, real)) {
        agent_ide_error(fd, "403 Forbidden", "outside_workspace", "The path resolves outside the workspace");
        return 0;
    }
    return 1;
}

static unsigned long long agent_ide_fnv1a(const char *p, size_t n) {
    unsigned long long h = 1469598103934665603ULL;
    for (size_t i = 0; i < n; i++) {
        h ^= (unsigned char)p[i];
        h *= 1099511628211ULL;
    }
    return h;
}

static void agent_ide_digest(const char *p, size_t n, char *out, size_t outsz) {
    snprintf(out, outsz, "fnv1a64:%016llx:%zu", agent_ide_fnv1a(p, n), n);
}

/* Strict UTF-8 (no overlongs, no surrogates, max U+10FFFF). */
static int agent_ide_utf8_ok(const unsigned char *s, size_t n) {
    size_t i = 0;
    while (i < n) {
        unsigned char c = s[i];
        if (c < 0x80) { i++; continue; }
        size_t len; unsigned int cp;
        if (c >= 0xC2 && c <= 0xDF) { len = 2; cp = c & 0x1F; }
        else if (c >= 0xE0 && c <= 0xEF) { len = 3; cp = c & 0x0F; }
        else if (c >= 0xF0 && c <= 0xF4) { len = 4; cp = c & 0x07; }
        else return 0;
        if (i + len > n) return 0;
        for (size_t k = 1; k < len; k++) {
            if ((s[i + k] & 0xC0) != 0x80) return 0;
            cp = (cp << 6) | (s[i + k] & 0x3F);
        }
        if ((len == 3 && (cp < 0x800 || (cp >= 0xD800 && cp <= 0xDFFF))) ||
            (len == 4 && (cp < 0x10000 || cp > 0x10FFFF))) return 0;
        i += len;
    }
    return 1;
}

/* JSON-escapes text in runs (one copy per safe run instead of per byte). */
static int agent_ide_put_escaped(json_dyn_buf *b, const char *s, size_t n) {
    if (!json_dyn_puts(b, "\"")) return 0;
    size_t run = 0;
    for (size_t i = 0; i < n; i++) {
        unsigned char c = (unsigned char)s[i];
        if (c >= 0x20 && c != '"' && c != '\\') continue;
        if (i > run && !json_dyn_putn(b, s + run, i - run)) return 0;
        char tmp[8];
        const char *rep = c == '"' ? "\\\"" : c == '\\' ? "\\\\" : c == '\n' ? "\\n" :
                          c == '\r' ? "\\r" : c == '\t' ? "\\t" : NULL;
        if (!rep) { snprintf(tmp, sizeof tmp, "\\u%04x", c); rep = tmp; }
        if (!json_dyn_puts(b, rep)) return 0;
        run = i + 1;
    }
    if (n > run && !json_dyn_putn(b, s + run, n - run)) return 0;
    return json_dyn_puts(b, "\"");
}

/* Exact decoder for one top-level JSON string member. Handles every escape,
 * including surrogate pairs, and rejects malformed input instead of
 * substituting bytes: a save must write exactly what the editor holds.
 * Returns 1 found, 0 absent, -1 malformed, -2 larger than max. */
static int agent_ide_json_string(const char *body, const char *key, size_t max,
                                 char **out, size_t *out_len) {
    *out = NULL; *out_len = 0;
    char pat[64];
    snprintf(pat, sizeof pat, "\"%s\"", key);
    const char *p = strstr(body, pat);
    if (!p) return 0;
    p += strlen(pat);
    p += strspn(p, " \t\r\n");
    if (*p != ':') return -1;
    p++;
    p += strspn(p, " \t\r\n");
    if (*p != '"') return -1;
    p++;
    json_dyn_buf b = {0};
    for (;;) {
        unsigned char c = (unsigned char)*p++;
        if (c == '"') break;
        if (c == 0 || c < 0x20) { free(b.ptr); return -1; }
        char enc[4]; size_t en = 1;
        if (c != '\\') enc[0] = (char)c;
        else {
            char e = *p++;
            unsigned int cp;
            switch (e) {
                case '"': enc[0] = '"'; break;
                case '\\': enc[0] = '\\'; break;
                case '/': enc[0] = '/'; break;
                case 'b': enc[0] = '\b'; break;
                case 'f': enc[0] = '\f'; break;
                case 'n': enc[0] = '\n'; break;
                case 'r': enc[0] = '\r'; break;
                case 't': enc[0] = '\t'; break;
                case 'u': {
                    unsigned int v = 0;
                    for (int k = 0; k < 4; k++) {
                        char h = *p++;
                        if (!isxdigit((unsigned char)h)) { free(b.ptr); return -1; }
                        v = v * 16 + (unsigned int)(isdigit((unsigned char)h) ? h - '0' : (tolower((unsigned char)h) - 'a' + 10));
                    }
                    cp = v;
                    if (v >= 0xDC00 && v <= 0xDFFF) { free(b.ptr); return -1; }
                    if (v >= 0xD800 && v <= 0xDBFF) {
                        if (p[0] != '\\' || p[1] != 'u') { free(b.ptr); return -1; }
                        p += 2;
                        unsigned int lo = 0;
                        for (int k = 0; k < 4; k++) {
                            char h = *p++;
                            if (!isxdigit((unsigned char)h)) { free(b.ptr); return -1; }
                            lo = lo * 16 + (unsigned int)(isdigit((unsigned char)h) ? h - '0' : (tolower((unsigned char)h) - 'a' + 10));
                        }
                        if (lo < 0xDC00 || lo > 0xDFFF) { free(b.ptr); return -1; }
                        cp = 0x10000 + ((v - 0xD800) << 10) + (lo - 0xDC00);
                    }
                    if (cp < 0x80) { enc[0] = (char)cp; en = 1; }
                    else if (cp < 0x800) { enc[0] = (char)(0xC0 | (cp >> 6)); enc[1] = (char)(0x80 | (cp & 0x3F)); en = 2; }
                    else if (cp < 0x10000) {
                        enc[0] = (char)(0xE0 | (cp >> 12)); enc[1] = (char)(0x80 | ((cp >> 6) & 0x3F));
                        enc[2] = (char)(0x80 | (cp & 0x3F)); en = 3;
                    } else {
                        enc[0] = (char)(0xF0 | (cp >> 18)); enc[1] = (char)(0x80 | ((cp >> 12) & 0x3F));
                        enc[2] = (char)(0x80 | ((cp >> 6) & 0x3F)); enc[3] = (char)(0x80 | (cp & 0x3F)); en = 4;
                    }
                    break;
                }
                default: free(b.ptr); return -1;
            }
        }
        if (b.len + en > max) { free(b.ptr); return -2; }
        if (!json_dyn_putn(&b, enc, en)) { free(b.ptr); return -1; }
    }
    if (!b.ptr && !json_dyn_reserve(&b, 1)) return -1;
    if (b.ptr) b.ptr[b.len] = '\0';
    *out = b.ptr;
    *out_len = b.len;
    return 1;
}

/* Reads at most max+1 bytes so growth past the limit is detected. */
static char *agent_ide_read_bytes(const char *path, size_t max, size_t *len, int *too_large) {
    *len = 0; *too_large = 0;
    int f = open(path, O_RDONLY);
    if (f < 0) return NULL;
    /* Sized from fstat, grown up to max+1 if the file grows while it is read. */
    struct stat st;
    size_t cap = fstat(f, &st) == 0 && st.st_size >= 0 && (size_t)st.st_size < max
               ? (size_t)st.st_size + 1 : max + 1;
    char *buf = malloc(cap + 1);
    if (!buf) { close(f); return NULL; }
    size_t got = 0;
    while (got < max + 1) {
        if (got == cap) {
            size_t ncap = cap * 2 < max + 1 ? cap * 2 : max + 1;
            char *nb = realloc(buf, ncap + 1);
            if (!nb) { free(buf); close(f); return NULL; }
            buf = nb; cap = ncap;
        }
        ssize_t r = read(f, buf + got, cap - got);
        if (r < 0) { if (errno == EINTR) continue; free(buf); close(f); return NULL; }
        if (r == 0) break;
        got += (size_t)r;
    }
    close(f);
    if (got > max) { *too_large = 1; free(buf); return NULL; }
    buf[got] = '\0';
    *len = got;
    return buf;
}

static long long agent_ide_mtime_ms(const struct stat *st) {
#ifdef __APPLE__
    return (long long)st->st_mtimespec.tv_sec * 1000LL + st->st_mtimespec.tv_nsec / 1000000;
#else
    return (long long)st->st_mtim.tv_sec * 1000LL + st->st_mtim.tv_nsec / 1000000;
#endif
}

static int agent_ide_busy(void) {
    return g_agent_working || g_agent_session_working || g_child_stop_requested;
}

static int agent_ide_put_root(json_dyn_buf *b, const char *root, const char *rel) {
    return json_dyn_puts(b, "{\"ok\":true,\"root\":") &&
           agent_ide_put_escaped(b, root, strlen(root)) &&
           json_dyn_puts(b, ",\"path\":") &&
           agent_ide_put_escaped(b, rel, strlen(rel)) &&
           json_dyn_puts(b, agent_ide_busy() ? ",\"agentWorking\":true" : ",\"agentWorking\":false");
}

static void api_agent_fs_list(int fd, const char *body) {
    char root[DSTUDIO_PATH_MAX], rel[1024] = "", full[DSTUDIO_PATH_MAX + 1100], real[DSTUDIO_PATH_MAX];
    if (!agent_ide_root(fd, root, sizeof root)) return;
    json_get_string(body, "path", rel, sizeof rel);
    if (!agent_ide_resolve(fd, root, rel, 1, full, sizeof full, real)) return;
    struct stat st;
    if (stat(real, &st) != 0 || !S_ISDIR(st.st_mode)) {
        agent_ide_error(fd, "400 Bad Request", "not_a_directory", "Not a folder");
        return;
    }
    DIR *d = opendir(real);
    if (!d) { agent_ide_error(fd, "403 Forbidden", "unreadable", "The folder cannot be read"); return; }
    json_dyn_buf b = {0};
    int ok = agent_ide_put_root(&b, root, rel) && json_dyn_puts(&b, ",\"entries\":[");
    int count = 0, truncated = 0;
    struct dirent *de;
    while (ok && (de = readdir(d)) != NULL) {
        if (!strcmp(de->d_name, ".") || !strcmp(de->d_name, "..")) continue;
        if (count >= AGENT_IDE_LIST_MAX) { truncated = 1; break; }
        char child[DSTUDIO_PATH_MAX * 2 + 2];
        int cn = snprintf(child, sizeof child, "%s/%s", real, de->d_name);
        if (cn < 0 || (size_t)cn >= sizeof child) continue;
        struct stat ls;
        if (lstat(child, &ls) != 0) continue;
        const char *type = S_ISDIR(ls.st_mode) ? "dir" : S_ISREG(ls.st_mode) ? "file" : "other";
        const char *link = NULL;
        struct stat ts = ls;
        if (S_ISLNK(ls.st_mode)) {
            char target[DSTUDIO_PATH_MAX];
            if (!realpath(child, target) || stat(target, &ts) != 0) { link = "broken"; type = "other"; }
            else if (!agent_ide_inside(root, target)) { link = "outside"; type = "other"; }
            else {
                link = "inside";
                type = S_ISDIR(ts.st_mode) ? "dir" : S_ISREG(ts.st_mode) ? "file" : "other";
            }
        }
        char meta[160];
        snprintf(meta, sizeof meta, ",\"type\":\"%s\",\"size\":%lld,\"mtimeMs\":%lld%s%s%s}",
                 type, (long long)ts.st_size, agent_ide_mtime_ms(&ts),
                 link ? ",\"link\":\"" : "", link ? link : "", link ? "\"" : "");
        ok = json_dyn_puts(&b, count ? ",{\"name\":" : "{\"name\":") &&
             agent_ide_put_escaped(&b, de->d_name, strlen(de->d_name)) &&
             json_dyn_puts(&b, meta);
        count++;
    }
    closedir(d);
    ok = ok && json_dyn_puts(&b, truncated ? "],\"truncated\":true}" : "],\"truncated\":false}");
    if (!ok) { free(b.ptr); agent_ide_error(fd, "500 Internal Server Error", "oom", "Out of memory"); return; }
    send_response(fd, "200 OK", "application/json; charset=utf-8", b.ptr, b.len, 0);
    free(b.ptr);
}

static void api_agent_fs_read(int fd, const char *body) {
    char root[DSTUDIO_PATH_MAX], rel[1024] = "", full[DSTUDIO_PATH_MAX + 1100], real[DSTUDIO_PATH_MAX];
    if (!agent_ide_root(fd, root, sizeof root)) return;
    json_get_string(body, "path", rel, sizeof rel);
    if (!agent_ide_resolve(fd, root, rel, 0, full, sizeof full, real)) return;
    struct stat ls, st;
    if (lstat(full, &ls) != 0 || stat(real, &st) != 0 || !S_ISREG(st.st_mode)) {
        agent_ide_error(fd, "400 Bad Request", "not_a_file", "Not a regular file");
        return;
    }
    size_t len = 0;
    int too_large = 0;
    char *data = agent_ide_read_bytes(real, (size_t)AGENT_IDE_FILE_MAX, &len, &too_large);
    if (!data && !too_large) { agent_ide_error(fd, "403 Forbidden", "unreadable", "The file cannot be read"); return; }
    const int binary = data && memchr(data, '\0', len) != NULL;
    const int utf8 = data && !binary && agent_ide_utf8_ok((const unsigned char *)data, len);
    const int writable = data && utf8 && !S_ISLNK(ls.st_mode) && S_ISREG(ls.st_mode) &&
                         ls.st_nlink == 1 && access(real, W_OK) == 0;
    char digest[64] = "";
    if (data) agent_ide_digest(data, len, digest, sizeof digest);
    char meta[320];
    snprintf(meta, sizeof meta,
             ",\"size\":%lld,\"mtimeMs\":%lld,\"digest\":\"%s\",\"tooLarge\":%s,\"binary\":%s,"
             "\"utf8\":%s,\"symlink\":%s,\"writable\":%s",
             (long long)st.st_size, agent_ide_mtime_ms(&st), digest,
             too_large ? "true" : "false", binary ? "true" : "false", utf8 ? "true" : "false",
             S_ISLNK(ls.st_mode) ? "true" : "false", writable ? "true" : "false");
    json_dyn_buf b = {0};
    int ok = agent_ide_put_root(&b, root, rel) && json_dyn_puts(&b, meta);
    /* Content is published only when it can round-trip losslessly. */
    if (ok && utf8) ok = json_dyn_puts(&b, ",\"content\":") && agent_ide_put_escaped(&b, data, len);
    ok = ok && json_dyn_puts(&b, "}");
    free(data);
    if (!ok) { free(b.ptr); agent_ide_error(fd, "500 Internal Server Error", "oom", "Out of memory"); return; }
    send_response(fd, "200 OK", "application/json; charset=utf-8", b.ptr, b.len, 0);
    free(b.ptr);
}

static void api_agent_fs_write(int fd, const char *body) {
    char root[DSTUDIO_PATH_MAX], rel[1024] = "", expected[96] = "";
    char full[DSTUDIO_PATH_MAX + 1100], real[DSTUDIO_PATH_MAX];
    if (!agent_ide_root(fd, root, sizeof root)) return;
    if (agent_ide_busy()) {
        agent_ide_error(fd, "409 Conflict", "agent_working",
                        "The agent is working. Save after it finishes");
        return;
    }
    json_get_string(body, "path", rel, sizeof rel);
    json_get_string(body, "expectedDigest", expected, sizeof expected);
    if (!expected[0]) {
        agent_ide_error(fd, "400 Bad Request", "missing_digest", "expectedDigest is required");
        return;
    }
    if (!agent_ide_resolve(fd, root, rel, 0, full, sizeof full, real)) return;
    char *content = NULL;
    size_t clen = 0;
    int got = agent_ide_json_string(body, "content", (size_t)AGENT_IDE_FILE_MAX, &content, &clen);
    if (got == -2) { agent_ide_error(fd, "413 Payload Too Large", "too_large", "The file is larger than the IDE can save"); return; }
    if (got != 1) { agent_ide_error(fd, "400 Bad Request", "invalid_content", "content must be a JSON string"); return; }
    if (memchr(content, '\0', clen) || !agent_ide_utf8_ok((const unsigned char *)content, clen)) {
        free(content);
        agent_ide_error(fd, "400 Bad Request", "invalid_content", "content must be UTF-8 text");
        return;
    }
    struct stat ls;
    if (lstat(full, &ls) != 0 || S_ISLNK(ls.st_mode) || !S_ISREG(ls.st_mode)) {
        free(content);
        agent_ide_error(fd, "409 Conflict", "not_editable", "Only regular files (not symlinks) can be saved");
        return;
    }
    if (ls.st_nlink != 1) {
        free(content);
        agent_ide_error(fd, "409 Conflict", "hard_linked", "The file has several hard links; saving would split them");
        return;
    }
    size_t cur_len = 0;
    int too_large = 0;
    char *cur = agent_ide_read_bytes(real, (size_t)AGENT_IDE_FILE_MAX, &cur_len, &too_large);
    if (!cur) {
        free(content);
        agent_ide_error(fd, too_large ? "409 Conflict" : "403 Forbidden", too_large ? "digest_mismatch" : "unreadable",
                        too_large ? "The file changed on disk" : "The file cannot be read");
        return;
    }
    char current[64];
    agent_ide_digest(cur, cur_len, current, sizeof current);
    free(cur);
    if (strcmp(current, expected) != 0) {
        free(content);
        char out[256];
        snprintf(out, sizeof out,
                 "{\"ok\":false,\"code\":\"digest_mismatch\",\"error\":\"The file changed on disk\",\"currentDigest\":\"%s\"}",
                 current);
        send_json(fd, "409 Conflict", out);
        return;
    }

    /* Temp file next to the target (same filesystem, so rename is atomic). */
    const char *slash = strrchr(real, '/');
    char dir[DSTUDIO_PATH_MAX], tmp[DSTUDIO_PATH_MAX + 64];
    size_t dl = slash ? (size_t)(slash - real) : 0;
    if (!slash || dl >= sizeof dir) {
        free(content);
        agent_ide_error(fd, "500 Internal Server Error", "bad_path", "Unexpected path");
        return;
    }
    if (dl == 0) snprintf(dir, sizeof dir, "/");
    else { memcpy(dir, real, dl); dir[dl] = '\0'; }
    int tn = snprintf(tmp, sizeof tmp, "%s/.%s.dstudio-save-XXXXXX", dl ? dir : "", slash + 1);
    if (tn < 0 || (size_t)tn >= sizeof tmp) {
        free(content);
        agent_ide_error(fd, "400 Bad Request", "path_too_long", "Path is too long");
        return;
    }
    int tf = mkstemp(tmp);
    if (tf < 0) {
        int e = errno;
        free(content);
        agent_ide_error(fd, "500 Internal Server Error", "write_failed", strerror(e));
        return;
    }
    size_t off = 0;
    int failed = 0;
    while (off < clen) {
        ssize_t w = write(tf, content + off, clen - off);
        if (w < 0) { if (errno == EINTR) continue; failed = errno; break; }
        off += (size_t)w;
    }
    if (!failed && fchmod(tf, ls.st_mode & 07777) != 0) failed = errno;
    if (!failed && fsync(tf) != 0) failed = errno;
    if (close(tf) != 0 && !failed) failed = errno;
    if (!failed && rename(tmp, real) != 0) failed = errno;
    char digest[64];
    agent_ide_digest(content, clen, digest, sizeof digest);
    free(content);
    if (failed) {
        unlink(tmp);
        agent_ide_error(fd, "500 Internal Server Error", "write_failed", strerror(failed));
        return;
    }
    int df = open(dir, O_RDONLY);
    if (df >= 0) { (void)fsync(df); close(df); }
    struct stat st;
    if (stat(real, &st) != 0) memset(&st, 0, sizeof st);
    char out[320];
    snprintf(out, sizeof out, "{\"ok\":true,\"digest\":\"%s\",\"size\":%lld,\"mtimeMs\":%lld}",
             digest, (long long)st.st_size, agent_ide_mtime_ms(&st));
    send_json(fd, "200 OK", out);
}
#endif

/* ============================================================================
 * GET /api/design/live-frame?t=<token>[&mode=quirks]
 *
 * The Open IDE Design pane previews bytes that are still being written (or a
 * user's unsaved edit). It loads this host-served frame ONCE per file and
 * then posts it each new version of the bytes; the frame parses them with
 * DOMParser and patches its own document in place. Reloading a srcdoc for
 * every streamed batch reset the reader's scroll position to the top, and a
 * srcdoc frame inherits the shell's CSP, which blocked the page's linked
 * stylesheets and fonts.
 *
 * Isolation: the parent loads it with sandbox="allow-scripts" (opaque origin,
 * no access to the shell). The only script allowed is this bootstrap, by a
 * per-response nonce; the author's <script> elements and inline handlers in
 * the previewed bytes stay off (and DOMParser-created scripts never run).
 * Styles, images, fonts and media may load over http(s), as in the saved
 * preview; scheme sources are used because WebKit does not match 'self' for
 * an opaque-origin document. Links are not followed and meta refresh is
 * dropped, so the frame never leaves this document. The token only lets the
 * parent tell this frame's messages from a stale one's; it is not a secret.
 * Host-local like every /api/design route (not on the LAN allowlist).
 * ==========================================================================*/
static const char DESIGN_LIVE_FRAME_SCRIPT[] =
"(function () {\n"
"  var token = new URLSearchParams(location.search).get('t') || '';\n"
"  var first = true, want = null, pending = false;\n"
"  function post(m) { m.dstudioLive = token; parent.postMessage(m, '*'); }\n"
"  function same(a, b) {\n"
"    return a.nodeType === b.nodeType && a.nodeName === b.nodeName &&\n"
"      a.namespaceURI === b.namespaceURI && a.nodeName !== 'TEMPLATE';\n"
"  }\n"
"  function swap(cur, next) { cur.parentNode.replaceChild(document.importNode(next, true), cur); }\n"
"  /* Unchanged nodes stay in place (no stylesheet or image reloads, no\n"
"     layout jump); changed ones are patched or replaced. */\n"
"  function morph(cur, next) {\n"
"    if (cur.nodeType !== 1) { if (cur.nodeValue !== next.nodeValue) cur.nodeValue = next.nodeValue; return; }\n"
"    try {\n"
"      Array.from(cur.attributes).forEach(function (a) {\n"
"        if (!next.hasAttributeNS(a.namespaceURI, a.localName)) cur.removeAttributeNS(a.namespaceURI, a.localName);\n"
"      });\n"
"      Array.from(next.attributes).forEach(function (a) {\n"
"        if (cur.getAttributeNS(a.namespaceURI, a.localName) !== a.value) cur.setAttributeNS(a.namespaceURI, a.name, a.value);\n"
"      });\n"
"    } catch (e) { swap(cur, next); return; } /* a name the parser accepts but setAttribute rejects */\n"
"    var kids = next.childNodes;\n"
"    for (var i = 0; i < kids.length; i++) {\n"
"      var c = cur.childNodes[i], n = kids[i];\n"
"      if (!c) cur.appendChild(document.importNode(n, true));\n"
"      else if (!same(c, n)) swap(c, n);\n"
"      else if (!c.isEqualNode(n)) morph(c, n);\n"
"    }\n"
"    while (cur.childNodes.length > kids.length) cur.removeChild(cur.lastChild);\n"
"  }\n"
"  /* A file reopened in a new frame returns to where the reader was. Until\n"
"     the page is tall enough (or the reader scrolls), positions are not\n"
"     reported, so a clamped intermediate value never replaces theirs. */\n"
"  function restore() {\n"
"    if (!want) return;\n"
"    scrollTo(want.x, want.y);\n"
"    if (Math.abs(scrollX - want.x) < 2 && Math.abs(scrollY - want.y) < 2) want = null;\n"
"  }\n"
"  ['wheel', 'touchstart', 'keydown', 'pointerdown'].forEach(function (t) {\n"
"    addEventListener(t, function () { want = null; }, { capture: true, passive: true });\n"
"  });\n"
"  document.addEventListener('load', restore, true);\n"
"  addEventListener('scroll', function () {\n"
"    if (want || pending) return;\n"
"    pending = true;\n"
"    requestAnimationFrame(function () { pending = false; post({ scroll: { x: scrollX, y: scrollY } }); });\n"
"  }, { passive: true });\n"
"  addEventListener('click', function (e) {\n"
"    var a = e.target && e.target.closest ? e.target.closest('a[href], area[href]') : null;\n"
"    if (a && a.getAttribute('href').charAt(0) !== '#') e.preventDefault();\n"
"  }, true);\n"
"  addEventListener('message', function (e) {\n"
"    var d = e.data;\n"
"    if (e.source !== parent || !d || d.dstudioLive !== token || typeof d.html !== 'string') return;\n"
"    var next = new DOMParser().parseFromString(d.html, 'text/html');\n"
"    next.querySelectorAll('meta[http-equiv]').forEach(function (m) {\n"
"      if ((m.getAttribute('http-equiv') || '').trim().toLowerCase() === 'refresh') m.remove();\n"
"    });\n"
"    morph(document.documentElement, next.documentElement);\n"
"    if (first && d.scroll) want = { x: Number(d.scroll.x) || 0, y: Number(d.scroll.y) || 0 };\n"
"    first = false;\n"
"    restore();\n"
"    post({ shown: d.seq });\n"
"  });\n"
"  post({ ready: true });\n"
"})();\n";

static void api_design_live_frame(int fd, const char *path, int head_only) {
#ifdef _WIN32
    (void)path; (void)head_only;
    agent_ide_error(fd, "501 Not Implemented", "unsupported_platform",
                    "The IDE workspace view is not available on Windows yet");
#else
    /* Fail closed: without a fresh nonce the bootstrap is not served. */
    unsigned char bytes[16];
    char nonce[33];
    FILE *rf = fopen("/dev/urandom", "rb");
    size_t got = rf ? fread(bytes, 1, sizeof bytes, rf) : 0;
    if (rf) fclose(rf);
    if (got != sizeof bytes) {
        send_text(fd, "503 Service Unavailable", "no randomness for the preview frame\n", head_only);
        return;
    }
    for (size_t i = 0; i < sizeof bytes; i++) snprintf(nonce + 2 * i, 3, "%02x", bytes[i]);
    const char *q = strchr(path, '?');
    int quirks = q && (strstr(q, "?mode=quirks") == q || strstr(q, "&mode=quirks"));
    /* Same document mode as the previewed bytes: no doctype means quirks. */
    json_dyn_buf b = {0};
    if (!json_dyn_printf(&b, "%s<html><head><meta charset=\"utf-8\"><script nonce=\"%s\">%s</script></head><body></body></html>\n",
                         quirks ? "" : "<!doctype html>\n", nonce, DESIGN_LIVE_FRAME_SCRIPT)) {
        free(b.ptr);
        send_text(fd, "500 Internal Server Error", "memory\n", head_only);
        return;
    }
    char headers[640];
    snprintf(headers, sizeof headers,
             "Connection: close\r\n"
             "Cache-Control: no-store\r\n"
             "X-Content-Type-Options: nosniff\r\n"
             "Referrer-Policy: no-referrer\r\n"
             "Content-Security-Policy: default-src 'none'; script-src 'nonce-%s'; "
             "style-src 'unsafe-inline' http: https:; img-src data: blob: http: https:; "
             "font-src data: http: https:; media-src data: blob: http: https:; form-action 'none'\r\n",
             nonce);
    send_response_hdrs(fd, "200 OK", "text/html; charset=utf-8", b.ptr, b.len, head_only, headers);
    free(b.ptr);
#endif
}

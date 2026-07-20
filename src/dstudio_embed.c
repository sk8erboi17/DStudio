/* ============================================================================
 * Embedding provider (local llama.cpp sidecar) + SEMANTIC skill search.
 *
 * A SECOND llama-server in embedding mode (EMBED_PORT) embeds skill texts and
 * each query; /api/skills/search ranks by cosine. Same install/spawn/idle
 * pattern as the vision sidecar (helpers below mirror the vision_* ones; a few
 * dir/pid-generic vision helpers are reused). Skill search is SEMANTIC ONLY —
 * no lexical fallback by design: if the sidecar/index is not ready the search
 * returns 503 and the agent proceeds without a skill.
 * ==========================================================================*/
#define EMBED_PORT 28101
#define EMBED_HF_DEFAULT "Qwen/Qwen3-Embedding-0.6B-GGUF:Q8_0"
#define EMBED_MAX_DIM 4096
/* Qwen3-Embedding retrieval works best with an instruction on the QUERY side;
 * documents (skill texts) are embedded verbatim. */
#define EMBED_QUERY_INSTRUCT \
    "Instruct: Given a user request, retrieve the skill that best helps.\nQuery: "

#ifndef _WIN32
static void embed_dir_path(char *out, size_t outsz) {
    const char *env = getenv("DSTUDIO_EMBED_DIR");
    if (env && env[0]) { cstr_copy(out, outsz, env); return; }
    const char *home = getenv("HOME");
    snprintf(out, outsz, "%s/.dstudio/llama-embed", home ? home : ".");
}
static void embed_touch_last_use(void) {
    char dir[DSTUDIO_PATH_MAX]; embed_dir_path(dir, sizeof dir);
    const char *home = getenv("HOME");
    char parent[DSTUDIO_PATH_MAX];
    snprintf(parent, sizeof parent, "%s/.dstudio", home ? home : ".");
    (void)mkdir(parent, 0755); (void)mkdir(dir, 0755);
    char stamp[DSTUDIO_PATH_MAX + 16];
    snprintf(stamp, sizeof stamp, "%s/.last-use", dir);
    int f = open(stamp, O_WRONLY | O_CREAT, 0644);
    if (f >= 0) close(f);
    (void)utimes(stamp, NULL);
}
static pid_t embed_lock_pid(void) {
    char p[DSTUDIO_PATH_MAX + 16]; embed_dir_path(p, sizeof p);
    size_t l = strlen(p); snprintf(p + l, sizeof p - l, "/.server.pid");
    size_t n = 0; char *b = jsonl_read_file(p, &n);
    if (!b) return 0;
    long pid = strtol(b, NULL, 10); free(b);
    return pid > 1 ? (pid_t)pid : 0;
}
static int embed_kill_server(void) {
    pid_t pid = embed_lock_pid();
    if (!vision_pid_is_llama(pid)) return 0;
    kill(pid, SIGTERM);
    for (int i = 0; i < 20; i++) { struct timespec ts = { 0, 100 * 1000000 }; nanosleep(&ts, NULL); if (kill(pid, 0) != 0) break; }
    if (kill(pid, 0) == 0) kill(pid, SIGKILL);
    char p[DSTUDIO_PATH_MAX + 16]; embed_dir_path(p, sizeof p);
    size_t l = strlen(p); snprintf(p + l, sizeof p - l, "/.server.pid"); unlink(p);
    return 1;
}
static int embed_port_open(void) {
    int s = socket(AF_INET, SOCK_STREAM, 0);
    if (s < 0) return 0;
    struct sockaddr_in a; memset(&a, 0, sizeof a);
    a.sin_family = AF_INET; a.sin_port = htons(EMBED_PORT); a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    struct timeval tv = { 1, 0 };
    (void)setsockopt(s, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof tv);
    (void)setsockopt(s, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof tv);
    int ok = connect(s, (struct sockaddr *)&a, sizeof a) == 0;
    close(s);
    return ok;
}
static int embed_server_ready(void) {
    int s = socket(AF_INET, SOCK_STREAM, 0);
    if (s < 0) return 0;
    struct sockaddr_in a; memset(&a, 0, sizeof a);
    a.sin_family = AF_INET; a.sin_port = htons(EMBED_PORT); a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    struct timeval tv = { 3, 0 };
    (void)setsockopt(s, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof tv);
    (void)setsockopt(s, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof tv);
    if (connect(s, (struct sockaddr *)&a, sizeof a) != 0) { close(s); return 0; }
    static const char *req = "GET /health HTTP/1.0\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n";
    if (write(s, req, strlen(req)) < 0) { close(s); return 0; }
    char buf[64]; ssize_t n = read(s, buf, sizeof buf - 1); close(s);
    if (n <= 0) return 0;
    buf[n] = '\0';
    return strstr(buf, " 200") != NULL;
}
static int embed_spawn_detached(void) {
    if (!g_web_dir[0]) return 0;
    char script[DSTUDIO_PATH_MAX + 64];
    snprintf(script, sizeof script, "%s/scripts/embed-server.sh", g_web_dir);
    struct stat stt;
    if (stat(script, &stt) != 0) return 0;
    pid_t pid = fork();
    if (pid < 0) return 0;
    if (pid == 0) {
        if (fork() > 0) _exit(0);
        setsid();
        if (chdir(g_web_dir) != 0) _exit(127);
        child_setenv_metal();
        for (int cfd = 3; cfd < 256; cfd++) close(cfd);
        int dn = open("/dev/null", O_RDWR);
        if (dn >= 0) { dup2(dn, STDIN_FILENO); if (dn != STDIN_FILENO) close(dn); }
        int lg = open("/tmp/dstudio-embed.log", O_WRONLY | O_CREAT | O_APPEND, 0644);
        if (lg >= 0) { dup2(lg, STDOUT_FILENO); dup2(lg, STDERR_FILENO); if (lg > STDERR_FILENO) close(lg); }
        char *argv[] = { "/bin/sh", script, NULL };
        execv("/bin/sh", argv);
        _exit(127);
    }
    waitpid(pid, NULL, 0);
    return 1;
}
static int embed_ensure_server(int timeout_ms) {
    if (embed_server_ready()) return 1;
    if (!embed_port_open()) embed_spawn_detached();
    long long deadline = web_now_ms() + (timeout_ms > 0 ? timeout_ms : 120000);
    while (web_now_ms() < deadline) {
        struct timespec ts = { 0, 500 * 1000000 };
        nanosleep(&ts, NULL);
        if (embed_server_ready()) return 1;
    }
    return 0;
}
static void embed_hf_pref(char *out, size_t outsz) {
    char p[DSTUDIO_PATH_MAX + 8]; embed_dir_path(p, sizeof p);
    size_t l = strlen(p); snprintf(p + l, sizeof p - l, "/.hf");
    size_t n = 0; char *b = jsonl_read_file(p, &n);
    if (b) {
        while (n > 0 && (b[n - 1] == '\n' || b[n - 1] == '\r' || b[n - 1] == ' ')) b[--n] = '\0';
        if (b[0]) { cstr_copy(out, outsz, b); free(b); return; }
        free(b);
    }
    cstr_copy(out, outsz, EMBED_HF_DEFAULT);
}

/* Parse the next "embedding":[...] float array at *pp; advances *pp past ']'.
 * Writes up to cap floats; returns the count read (0 on failure). */
static int embed_parse_vec(const char **pp, float *out, int cap) {
    const char *p = strstr(*pp, "\"embedding\"");
    if (!p) return 0;
    p = strchr(p, '[');
    if (!p) return 0;
    p++;
    int n = 0;
    while (*p && *p != ']') {
        while (*p == ' ' || *p == ',' || *p == '\n' || *p == '\r' || *p == '\t') p++;
        if (*p == ']' || !*p) break;
        char *end = NULL;
        double v = strtod(p, &end);
        if (end == p) break;
        if (n < cap) out[n] = (float)v;
        n++;
        p = end;
    }
    if (*p == ']') p++;
    *pp = p;
    return n;
}

/* Embed `count` texts (each optionally prefixed) via the sidecar's
 * /v1/embeddings. Writes count*(*dim) floats into out with stride `stride`
 * (>= the model dim), L2-normalized. Returns 1 on success. */
static int embed_call(char *const *texts, int count, const char *prefix,
                      float *out, int stride, int *dim) {
    json_dyn_buf b = {0};
    if (!json_dyn_puts(&b, "{\"input\":[")) { free(b.ptr); return 0; }
    for (int i = 0; i < count; i++) {
        if (i && !json_dyn_puts(&b, ",")) { free(b.ptr); return 0; }
        if (prefix && prefix[0]) {
            size_t need = strlen(prefix) + strlen(texts[i]) + 1;
            char *combo = malloc(need);
            if (!combo) { free(b.ptr); return 0; }
            snprintf(combo, need, "%s%s", prefix, texts[i]);
            int ok = json_dyn_put_escaped(&b, combo);
            free(combo);
            if (!ok) { free(b.ptr); return 0; }
        } else if (!json_dyn_put_escaped(&b, texts[i])) { free(b.ptr); return 0; }
    }
    if (!json_dyn_puts(&b, "],\"model\":\"x\"}")) { free(b.ptr); return 0; }

    char tmpl[] = "/tmp/dstudio-embed-req-XXXXXX";
    int tf = mkstemp(tmpl);
    if (tf < 0) { free(b.ptr); return 0; }
    size_t off = 0;
    while (off < b.len) { ssize_t w = write(tf, b.ptr + off, b.len - off); if (w <= 0) break; off += (size_t)w; }
    int wrote_ok = off == b.len;
    close(tf); free(b.ptr);
    if (!wrote_ok) { unlink(tmpl); return 0; }

    char url[80];  snprintf(url, sizeof url, "http://127.0.0.1:%d/v1/embeddings", EMBED_PORT);
    char dataarg[80]; snprintf(dataarg, sizeof dataarg, "@%s", tmpl);
    char *argv[16]; int n = 0;
    argv[n++] = "curl"; argv[n++] = "-sS"; argv[n++] = "-X"; argv[n++] = "POST";
    argv[n++] = "-H"; argv[n++] = "Content-Type: application/json";
    argv[n++] = "--data-binary"; argv[n++] = dataarg;
    argv[n++] = "--max-time"; argv[n++] = "120";
    argv[n++] = url; argv[n] = NULL;
    int st = 0;
    char *resp = web_curl_capture(argv, 125000, &st);
    unlink(tmpl);
    if (!resp || !resp[0]) { free(resp); return 0; }

    const char *p = resp;
    int d = 0;
    for (int i = 0; i < count; i++) {
        float *slot = out + (size_t)i * stride;
        int got = embed_parse_vec(&p, slot, stride);
        if (got == 0) { free(resp); return 0; }
        if (d == 0) d = got;
        else if (got != d) { free(resp); return 0; }
        double s = 0; for (int k = 0; k < got; k++) s += (double)slot[k] * slot[k];
        double nr = s > 0 ? 1.0 / sqrt(s) : 0;
        for (int k = 0; k < got; k++) slot[k] = (float)(slot[k] * nr);
    }
    free(resp);
    *dim = d;
    return d > 0;
}

/* FNV-1a over the model tag + every (id, embed_text) → cache invalidation key. */
static unsigned long long skill_corpus_sig(const skill_hit_list *L, char *const *texts, const char *model) {
    unsigned long long h = 1469598103934665603ULL;
    for (const char *s = model; s && *s; s++) { h ^= (unsigned char)*s; h *= 1099511628211ULL; }
    for (int i = 0; i < L->n; i++) {
        for (const char *s = L->v[i].id; *s; s++) { h ^= (unsigned char)*s; h *= 1099511628211ULL; }
        h ^= 0; h *= 1099511628211ULL;
        for (const char *s = texts[i]; *s; s++) { h ^= (unsigned char)*s; h *= 1099511628211ULL; }
        h ^= '\n'; h *= 1099511628211ULL;
    }
    return h;
}

/* On-disk index: header {magic,dim,count,sig,model} + count*dim normalized
 * floats in enum order. */
#define SKILL_INDEX_MAGIC 0x44534531u  /* "DSE1" */
typedef struct { unsigned magic; int dim, count; unsigned long long sig; char model[128]; } skill_index_hdr;

static void skill_index_path(char *out, size_t outsz) {
    char dir[DSTUDIO_PATH_MAX]; embed_dir_path(dir, sizeof dir);
    snprintf(out, outsz, "%s/skill-index.bin", dir);
}
static float *skill_index_load(const skill_index_hdr *want) {
    char path[DSTUDIO_PATH_MAX + 32]; skill_index_path(path, sizeof path);
    FILE *f = fopen(path, "rb");
    if (!f) return NULL;
    skill_index_hdr h;
    if (fread(&h, sizeof h, 1, f) != 1 || h.magic != SKILL_INDEX_MAGIC ||
        h.dim != want->dim || h.count != want->count || h.sig != want->sig ||
        strncmp(h.model, want->model, sizeof h.model) != 0) { fclose(f); return NULL; }
    size_t nf = (size_t)h.dim * h.count;
    float *v = malloc(nf * sizeof *v);
    if (!v) { fclose(f); return NULL; }
    if (fread(v, sizeof *v, nf, f) != nf) { free(v); fclose(f); return NULL; }
    fclose(f);
    return v;
}
static void skill_index_save(const skill_index_hdr *h, const float *v) {
    char path[DSTUDIO_PATH_MAX + 32]; skill_index_path(path, sizeof path);
    char tmp[DSTUDIO_PATH_MAX + 40]; snprintf(tmp, sizeof tmp, "%s.tmp", path);
    FILE *f = fopen(tmp, "wb");
    if (!f) return;
    size_t nf = (size_t)h->dim * h->count;
    if (fwrite(h, sizeof *h, 1, f) == 1 && fwrite(v, sizeof *v, nf, f) == nf) {
        fclose(f); rename(tmp, path);
    } else { fclose(f); unlink(tmp); }
}

/* Get (load or build) the embedding matrix for the enumerated skills. On a
 * cache miss embeds every skill via the sidecar and persists the index. Returns
 * malloc'd count*dim floats (caller frees) and sets *dim; NULL on failure. */
static float *skill_index_ensure(const skill_hit_list *L, char *const *texts, int *dim_out) {
    char model[128]; embed_hf_pref(model, sizeof model);
    int dim = 0;
    /* Probe the model dim with a tiny embed (also confirms the server answers). */
    static float probe[EMBED_MAX_DIM];
    char *ping[1]; ping[0] = (char *)"ping";
    if (!embed_call(ping, 1, NULL, probe, EMBED_MAX_DIM, &dim) || dim <= 0 || dim > EMBED_MAX_DIM)
        return NULL;

    skill_index_hdr want = { SKILL_INDEX_MAGIC, dim, L->n, 0, {0} };
    cstr_copy(want.model, sizeof want.model, model);
    want.sig = skill_corpus_sig(L, texts, model);

    float *cached = skill_index_load(&want);
    if (cached) { *dim_out = dim; return cached; }

    /* Build: embed every skill text in batches, directly into the matrix. */
    float *vecs = malloc((size_t)L->n * dim * sizeof *vecs);
    if (!vecs) return NULL;
    const int BATCH = 16;
    for (int start = 0; start < L->n; start += BATCH) {
        int cnt = L->n - start < BATCH ? L->n - start : BATCH;
        int gd = 0;
        if (!embed_call(texts + start, cnt, NULL, vecs + (size_t)start * dim, dim, &gd) || gd != dim) {
            free(vecs); return NULL;
        }
        embed_touch_last_use();
    }
    skill_index_save(&want, vecs);
    *dim_out = dim;
    return vecs;
}

/* The semantic search worker: enumerate skills, ensure the index, embed the
 * query, rank by cosine, emit the top `limit`. Runs in a detached child. */
static void api_skills_search_run(int fd, const char *path) {
    char q[512], domain[120], subdomain[160], source[80], limit_s[32], fmt[16] = "";
    query_param(path, "q", q, sizeof q);
    query_param(path, "domain", domain, sizeof domain);
    query_param(path, "subdomain", subdomain, sizeof subdomain);
    query_param(path, "source", source, sizeof source);
    query_param(path, "limit", limit_s, sizeof limit_s);
    query_param(path, "format", fmt, sizeof fmt);
    int want_text = !strcmp(fmt, "text");   /* plain "id: desc" lines, for the agent tool */
    int limit = limit_s[0] ? atoi(limit_s) : 20;
    if (limit < 1) limit = 1;
    if (limit > 200) limit = 200;

    if (!q[0]) {
        if (want_text) send_text(fd, "400 Bad Request", "skills_search error: query is required\n", 0);
        else web_json_error(fd, "400 Bad Request", "q is required");
        return;
    }
    embed_touch_last_use();
    /* Short wait: the heavy model download happens in /api/embed/setup. */
    if (!embed_ensure_server(60000)) {
        if (want_text) send_text(fd, "503 Service Unavailable",
                                 "skills_search: semantic search is not available; proceed without a skill.\n", 0);
        else web_json_error(fd, "503 Service Unavailable",
                       "semantic skill search is not ready; install it once via POST /api/embed/setup");
        return;
    }

    skill_hit_list L = {0};
    if (!skill_enum_all(&L) || L.n == 0) { skill_hits_free(&L); web_json_error(fd, "500 Internal Server Error", "no skills"); return; }
    char **texts = calloc((size_t)L.n, sizeof *texts);
    if (!texts) { skill_hits_free(&L); web_json_error(fd, "500 Internal Server Error", "oom"); return; }
    for (int i = 0; i < L.n; i++) texts[i] = skill_embed_text(&L.v[i]);

    int dim = 0;
    float *vecs = skill_index_ensure(&L, texts, &dim);
    if (!vecs) {
        for (int i = 0; i < L.n; i++) free(texts[i]);
        free(texts); skill_hits_free(&L);
        if (want_text) send_text(fd, "503 Service Unavailable", "skills_search: index unavailable; proceed without a skill.\n", 0);
        else web_json_error(fd, "503 Service Unavailable", "could not build the semantic skill index");
        return;
    }
    for (int i = 0; i < L.n; i++) free(texts[i]);
    free(texts);

    /* Embed the query (with the Qwen3 retrieval instruction) and rank by cosine. */
    static float qv[EMBED_MAX_DIM];
    char *qq[1]; qq[0] = q;
    int qd = 0;
    if (!embed_call(qq, 1, EMBED_QUERY_INSTRUCT, qv, EMBED_MAX_DIM, &qd) || qd != dim) {
        free(vecs); skill_hits_free(&L);
        if (want_text) send_text(fd, "503 Service Unavailable", "skills_search: query embedding failed; proceed without a skill.\n", 0);
        else web_json_error(fd, "503 Service Unavailable", "query embedding failed");
        return;
    }
    for (int i = 0; i < L.n; i++) {
        /* Optional hard filters (domain/subdomain/source) before ranking. */
        if (source[0] && !text_contains_ci(L.v[i].source, source)) { L.v[i].score = -1000000; continue; }
        if (domain[0] && !text_contains_ci(L.v[i].domain, domain)) { L.v[i].score = -1000000; continue; }
        if (subdomain[0] && !text_contains_ci(L.v[i].subdomain, subdomain)) { L.v[i].score = -1000000; continue; }
        const float *v = vecs + (size_t)i * dim;
        double dot = 0; for (int k = 0; k < dim; k++) dot += (double)qv[k] * v[k];
        L.v[i].score = (int)(dot * 1000000.0);   /* cosine → int for the sort */
    }
    free(vecs);
    if (L.n > 1) qsort(L.v, (size_t)L.n, sizeof *L.v, skill_hit_cmp);

    int total = 0;
    for (int i = 0; i < L.n; i++) if (L.v[i].score > -1000000) total++;
    int emit = total < limit ? total : limit;

    /* Plain-text form for the agent's skills_search tool: "id: description" lines
     * it can hand straight to the model (no JSON parsing in the agent). */
    if (want_text) {
        json_dyn_buf tb = {0};
        int okt = json_dyn_puts(&tb, emit ? "Matching skills (best first) — load one with skill(\"<id>\"):\n"
                                          : "No skills matched. Proceed without a skill.\n");
        for (int i = 0; okt && i < emit; i++) {
            skill_hit *h = &L.v[i];
            okt = json_dyn_puts(&tb, "- ") && json_dyn_puts(&tb, h->id);
            if (okt && h->desc[0]) okt = json_dyn_puts(&tb, ": ") && json_dyn_puts(&tb, h->desc);
            if (okt) okt = json_dyn_puts(&tb, "\n");
        }
        skill_hits_free(&L);
        if (!okt) { free(tb.ptr); send_text(fd, "500 Internal Server Error", "skills_search error: out of memory\n", 0); return; }
        send_text(fd, "200 OK", tb.ptr ? tb.ptr : "No skills.\n", 0);
        free(tb.ptr);
        return;
    }

    json_dyn_buf body = {0};
    int ok = json_dyn_puts(&body, "{\"ok\":true,\"semantic\":true,\"skills\":[");
    for (int i = 0; ok && i < emit; i++) {
        skill_hit *h = &L.v[i];
        ok = json_dyn_puts(&body, i ? ",{" : "{") &&
             json_dyn_puts(&body, "\"id\":")           && json_dyn_put_escaped(&body, h->id) &&
             json_dyn_puts(&body, ",\"name\":")        && json_dyn_put_escaped(&body, h->name) &&
             json_dyn_puts(&body, ",\"description\":") && json_dyn_put_escaped(&body, h->desc) &&
             json_dyn_puts(&body, ",\"source\":")      && json_dyn_put_escaped(&body, h->source) &&
             json_dyn_puts(&body, ",\"domain\":")      && json_dyn_put_escaped(&body, h->domain) &&
             json_dyn_puts(&body, ",\"subdomain\":")   && json_dyn_put_escaped(&body, h->subdomain) &&
             json_dyn_puts(&body, ",\"tags\":")        && json_dyn_put_escaped(&body, h->tags) &&
             json_dyn_puts(&body, ",\"license\":")     && json_dyn_put_escaped(&body, h->license) &&
             json_dyn_puts(&body, ",\"tools\":[]") &&
             json_dyn_printf(&body, ",\"score\":%d,\"hasAssets\":%s,\"hasReferences\":%s,\"hasScripts\":%s}",
                             h->score, h->has_assets ? "true" : "false",
                             h->has_refs ? "true" : "false", h->has_scripts ? "true" : "false");
    }
    ok = ok && json_dyn_printf(&body, "],\"count\":%d,\"truncated\":%s}", emit, total > emit ? "true" : "false");
    skill_hits_free(&L);
    if (!ok) { free(body.ptr); web_json_error(fd, "500 Internal Server Error", "skill search memory"); return; }
    send_json(fd, "200 OK", body.ptr);
    free(body.ptr);
}
#endif /* !_WIN32 */

/* GET /api/skills/search?q=&domain=&subdomain=&source=&limit=
 * Semantic (embedding cosine) search over user, shipped and cyber skills. Forks
 * a detached worker (embedding + first-run index build are slow) so the single-
 * threaded main loop never blocks — same pattern as the vision handlers. */
static void api_skills_search(int fd, const char *path) {
#ifdef _WIN32
    (void)path;
    web_json_error(fd, "501 Not Implemented", "semantic skill search is not available on the Windows build yet");
#else
    pid_t pid = fork();
    if (pid < 0) { api_skills_search_run(fd, path); return; }
    if (pid == 0) {
        if (fork() > 0) _exit(0);
        if (g_srv_fd >= 0) close(g_srv_fd);
        if (g_out_fd >= 0) close(g_out_fd);
        if (g_err_fd >= 0) close(g_err_fd);
        if (g_in_fd  >= 0) close(g_in_fd);
        struct timeval tv = { 620, 0 };
        (void)setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof tv);
        api_skills_search_run(fd, path);
        close(fd);
        _exit(0);
    }
    waitpid(pid, NULL, 0);
#endif
}

/* GET /api/design-systems — brand systems (extension/design-systems/<id>/DESIGN.md). */
static void api_design_systems(int fd) { md_catalog(fd, "design-systems", "DESIGN.md", "designSystems"); }

/* GET /api/craft — universal craft rule packs (extension/craft/<id>/CRAFT.md). */
static void api_craft(int fd) { md_catalog(fd, "craft", "CRAFT.md", "craft"); }

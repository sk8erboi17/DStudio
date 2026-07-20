/* ============================================================================
 * PDF attachments — hybrid reader: text layer first, vision for scanned pages.
 *
 * pdftotext (poppler) extracts each page's embedded text layer — instant and
 * verbatim, so a long digital PDF costs no vision time at all. Pages with no
 * usable text layer (scans, pure-image pages) are rasterized by pdftoppm and
 * READ by the local vision sidecar via a loopback POST to /api/vision/describe
 * (format=text) — no duplication of the vision wiring. ONE page per vision
 * call: a dense scan gets the whole answer-token budget and the per-page
 * attribution stays exact. The combined page-by-page text becomes the
 * attachment content that the ds4/DeepSeek chat model reads.
 *
 * Pages are rasterized as JPEG (not PNG) on purpose: a scanned page at 1400px
 * is ~2MB as PNG — one page alone overflows the 2MB /api body cap once
 * base64'd — but a few hundred KB as JPEG q85, which OCRs the same. A page
 * that still exceeds the per-request budget is re-rendered smaller before
 * being reported unreadable.
 *
 * Reads are question-INDEPENDENT (pure extraction/transcription; the chat or
 * agent model does the answering), so caching works across questions: the full
 * result is cached by content hash (pdf bytes + vision model + caps) and every
 * single page's vision transcription is also cached by its rendered image —
 * re-sending the same document, with any question, is instant, and a partial
 * failure retries only the failed pages. Text pages that also carry a
 * meaningful raster figure (>=5% of the page and >=3 in², via pdfimages
 * -list) get an extra figures-only vision pass so charts/diagrams are not
 * silently dropped; vector-drawn figures are a known blind spot.
 *
 *   POST /api/pdf/thumb    — render page 1 → {ok, thumb: data-URI} (attach-time preview)
 *   POST /api/pdf/describe — hybrid read → {ok, text, pages, total, first,
 *                            last, textPages, visionPages, truncated, cached}.
 *                            format:"text" → text/plain (the agent's read_pdf
 *                            tool). pages:"N"|"N-M"|"N-" reads only that page
 *                            range — how a caller reaches pages past the caps
 *                            of a long document. Optional job:"<id>" → progress
 *                            readable at GET /api/pdf/progress?job=<id>.
 * ==========================================================================*/
#ifndef _WIN32
#define PDF_MAX_VISION_PAGES 10          /* vision-read pages cap (env DSTUDIO_PDF_MAX_PAGES) */
#define PDF_MAX_VISION_PAGES_HARD 200
#define PDF_MAX_TOTAL_PAGES 2000         /* sanity cap for the per-page bookkeeping */
#define PDF_TEXT_MIN_CHARS 24            /* page text layer below this → treat as scanned */
#define PDF_TEXT_TOTAL_CAP (160 * 1024)  /* total text-layer bytes shipped to the model */
#define PDF_PAGE_B64_BUDGET (1500 * 1024) /* per-page data-URI budget (loopback 2MB body cap) */

/* Absolute path of a poppler tool (pdftoppm/pdfinfo/pdftotext), or 0 if not
 * found. */
static int pdf_find_tool(const char *name, char *out, size_t outsz) {
    const char *dirs[] = { "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", NULL };
    for (int i = 0; dirs[i]; i++) {
        snprintf(out, outsz, "%s/%s", dirs[i], name);
        if (access(out, X_OK) == 0) return 1;
    }
    out[0] = '\0';
    return 0;
}

/* Platform-appropriate "install poppler" hint, appended to the 503 errors so
 * the toast tells the user the exact command instead of a bare "needs poppler". */
static const char *pdf_poppler_hint(void) {
#ifdef __APPLE__
    return "PDF reading needs poppler. Install it with: brew install poppler";
#else
    return "PDF reading needs poppler. Install it with: sudo apt install poppler-utils "
           "(or your distro's poppler package)";
#endif
}

/* Progress for long describe runs: the forked worker rewrites
 * /tmp/dstudio-pdfjob-<id>.json at each step; GET /api/pdf/progress?job=<id>
 * serves it. The id is client-generated and sanitized here to [A-Za-z0-9_-]. */
static int pdf_job_path(const char *job, char *out, size_t outsz) {
    if (!job || !job[0]) return 0;
    char clean[48];
    size_t o = 0;
    for (const char *p = job; *p && o < sizeof clean - 1; p++) {
        unsigned char c = (unsigned char)*p;
        if (isalnum(c) || c == '_' || c == '-') clean[o++] = (char)c;
    }
    clean[o] = '\0';
    if (!clean[0]) return 0;
    snprintf(out, outsz, "/tmp/dstudio-pdfjob-%s.json", clean);
    return 1;
}

static void pdf_job_write(const char *jobpath, const char *fmt, ...) {
    if (!jobpath || !jobpath[0]) return;
    char msg[512];
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(msg, sizeof msg, fmt, ap);
    va_end(ap);
    char tmp[DSTUDIO_PATH_MAX];
    snprintf(tmp, sizeof tmp, "%s.tmp", jobpath);
    int f = open(tmp, O_WRONLY | O_CREAT | O_TRUNC, 0644);
    if (f < 0) return;
    size_t len = strlen(msg), off = 0;
    while (off < len) { ssize_t w = write(f, msg + off, len - off); if (w <= 0) break; off += (size_t)w; }
    close(f);
    if (off == len) rename(tmp, jobpath);   /* atomic swap: the poller never sees a torn write */
    else unlink(tmp);
}

/* Decode the PDF from body {data_uri|pdf_b64|path} into a temp .pdf file.
 * Returns malloc'd path (caller unlink+free) or NULL; *forbidden set if a
 * non-loopback client passed a `path` source. *fnv (optional) receives an
 * FNV-1a of the decoded bytes — the content half of the describe cache key. */
static char *pdf_write_temp(const char *body, int allow_path, int *forbidden,
                            unsigned long long *fnv) {
    *forbidden = 0;
    char *bytes = NULL; size_t blen = 0;
    char *data = json_get_string_alloc_rpc(body, "data_uri");
    if (!data) data = json_get_string_alloc_rpc(body, "pdf_b64");
    if (data && data[0]) {
        const char *b64 = data;
        if (!strncmp(data, "data:", 5)) { const char *c = strchr(data, ','); if (c) b64 = c + 1; }
        size_t dl = 0; char *dec = base64_decode(b64, &dl);
        if (dec) { bytes = dec; blen = dl; }
        free(data);
    } else {
        free(data);
        char *path = json_get_string_alloc_rpc(body, "path");
        if (path && path[0] && !allow_path) { free(path); *forbidden = 1; return NULL; }
        if (path && path[0]) { size_t n = 0; char *b = jsonl_read_file(path, &n); if (b) { bytes = b; blen = n; } }
        free(path);
    }
    if (!bytes || blen == 0) { free(bytes); return NULL; }
    if (fnv) {
        unsigned long long h = 1469598103934665603ULL;
        for (size_t i = 0; i < blen; i++) { h ^= (unsigned char)bytes[i]; h *= 1099511628211ULL; }
        *fnv = h;
    }
    char tmpl[] = "/tmp/dstudio-pdfin-XXXXXX";
    int tf = mkstemp(tmpl);
    if (tf < 0) { free(bytes); return NULL; }
    size_t off = 0; while (off < blen) { ssize_t w = write(tf, bytes + off, blen - off); if (w <= 0) break; off += (size_t)w; }
    close(tf); free(bytes);
    if (off < blen) { unlink(tmpl); return NULL; }
    return ds4_strdup_local(tmpl);
}

/* Rasterize pages [first..last] of pdfpath to <prefix>[-N].{jpg,png} via
 * pdftoppm. JPEG for the vision pages (a 1400px scan is ~2MB as PNG — over the
 * loopback body cap on its own — but a few hundred KB as JPEG); quality only
 * applies to JPEG. */
static int pdf_render(const char *pdftoppm, const char *pdfpath, const char *prefix,
                      int first, int last, int scale_to, int singlefile,
                      int jpeg, int quality) {
    char f[12], l[12], s[12], q[32];
    snprintf(f, sizeof f, "%d", first);
    snprintf(l, sizeof l, "%d", last);
    snprintf(s, sizeof s, "%d", scale_to);
    snprintf(q, sizeof q, "quality=%d", quality > 0 ? quality : 85);
    char *argv[16]; int n = 0;
    argv[n++] = (char *)pdftoppm;
    if (jpeg) { argv[n++] = "-jpeg"; argv[n++] = "-jpegopt"; argv[n++] = q; }
    else argv[n++] = "-png";
    argv[n++] = "-f"; argv[n++] = f;
    argv[n++] = "-l"; argv[n++] = l;
    argv[n++] = "-scale-to"; argv[n++] = s;
    if (singlefile) argv[n++] = "-singlefile";
    argv[n++] = (char *)pdfpath;
    argv[n++] = (char *)prefix;
    argv[n] = NULL;
    int st = -1;
    char *o = web_curl_capture(argv, 120000, &st);
    free(o);
    return st == 0;
}

/* Read a rendered page image → "data:image/…;base64,…" (malloc'd) or NULL. */
static char *pdf_img_data_uri(const char *imgpath) {
    size_t n = 0;
    char *bytes = jsonl_read_file(imgpath, &n);
    if (!bytes || n == 0) { free(bytes); return NULL; }
    char *b64 = base64_encode((const unsigned char *)bytes, n);
    free(bytes);
    if (!b64) return NULL;
    size_t l = strlen(imgpath);
    const char *mime = (l > 4 && !strcmp(imgpath + l - 4, ".jpg")) ? "image/jpeg" : "image/png";
    size_t need = strlen(b64) + strlen(mime) + 24;
    char *uri = malloc(need);
    if (uri) snprintf(uri, need, "data:%s;base64,%s", mime, b64);
    free(b64);
    return uri;
}

/* POST /api/pdf/thumb — render page 1 to an image for the attachment preview. */
static void api_pdf_thumb_run(int fd, const char *body, int allow_path) {
    char tool[256];
    if (!pdf_find_tool("pdftoppm", tool, sizeof tool)) {
        web_json_error(fd, "503 Service Unavailable", pdf_poppler_hint());
        return;
    }
    int forbidden = 0;
    char *pdf = pdf_write_temp(body, allow_path, &forbidden, NULL);
    if (forbidden) { web_json_error(fd, "403 Forbidden", "path is host-local only; send data_uri"); return; }
    if (!pdf) { web_json_error(fd, "400 Bad Request", "a PDF (data_uri or host-local path) is required"); return; }
    char dir[] = "/tmp/dstudio-pdfr-XXXXXX";
    if (!mkdtemp(dir)) { unlink(pdf); free(pdf); web_json_error(fd, "500 Internal Server Error", "temp dir"); return; }
    char prefix[DSTUDIO_PATH_MAX];
    snprintf(prefix, sizeof prefix, "%s/p", dir);
    char *uri = NULL;
    if (pdf_render(tool, pdf, prefix, 1, 1, 1000, 1, 1, 88)) {
        char img[DSTUDIO_PATH_MAX];
        snprintf(img, sizeof img, "%s/p.jpg", dir);
        uri = pdf_img_data_uri(img);
        unlink(img);
    }
    rmdir(dir); unlink(pdf); free(pdf);
    if (!uri) { web_json_error(fd, "502 Bad Gateway", "could not render the PDF's first page"); return; }
    json_dyn_buf b = {0};
    int ok = json_dyn_puts(&b, "{\"ok\":true,\"thumb\":") && json_dyn_put_escaped(&b, uri) && json_dyn_puts(&b, "}");
    free(uri);
    if (!ok) { free(b.ptr); web_json_error(fd, "500 Internal Server Error", "oom"); return; }
    send_json(fd, "200 OK", b.ptr);
    free(b.ptr);
}

/* Per-page transcription cache path: pg-<fnv>.txt in the pdf-cache dir. Key =
 * rendered page image + vision model + prompt mode — question-INDEPENDENT by
 * design: the vision pass is pure perception, so a new question over the same
 * document reuses every already-read page instead of ~35s of OCR each. */
static void pdf_page_cache_path(unsigned long long key, char *out, size_t outsz) {
    const char *home = getenv("HOME");
    snprintf(out, outsz, "%s/.dstudio/pdf-cache/pg-%016llx.txt", home ? home : ".", key);
}
static void pdf_cache_write(const char *cpath, const char *data, const char *suffix, int cap);

/* POST ONE page image to the local /api/vision/describe (format=text) over
 * loopback; returns the vision text (malloc'd) or NULL. One page per call on
 * purpose: a dense scan needs the whole answer-token budget, and per-page
 * attribution ("--- Pagina N ---") stays exact. figures_only = the page's text
 * layer already ships verbatim, so the model describes only charts/photos. */
static char *pdf_vision_page(const char *data_uri, int figures_only) {
    static const char *scan_prompt =
        "Transcribe and describe this document page precisely and completely: all text "
        "(verbatim), tables, figures and layout. State only what is visible.";
    static const char *figs_prompt =
        "This document page's plain text is already extracted separately, so do NOT re-transcribe "
        "the body text. Describe the page's non-text content precisely: every figure, chart, "
        "graph, diagram or photo — type, axes, labels, series, values and visible trends. "
        "State only what is visible.";

    /* Per-page cache first. */
    char hf[256] = "";
    vision_hf_pref(hf, sizeof hf);
    unsigned long long key = 1469598103934665603ULL;
    for (const char *s = data_uri; *s; s++) { key ^= (unsigned char)*s; key *= 1099511628211ULL; }
    for (const char *s = hf; *s; s++)       { key ^= (unsigned char)*s; key *= 1099511628211ULL; }
    key ^= (unsigned long long)(figures_only ? 'f' : 's');
    key *= 1099511628211ULL;
    static const char *psalt = "|pg-v1|";
    for (const char *s = psalt; *s; s++)    { key ^= (unsigned char)*s; key *= 1099511628211ULL; }
    char ppath[DSTUDIO_PATH_MAX];
    pdf_page_cache_path(key, ppath, sizeof ppath);
    {
        size_t hn = 0;
        char *hit = jsonl_read_file(ppath, &hn);
        if (hit && hn > 0) { (void)utimes(ppath, NULL); return hit; }   /* LRU touch */
        free(hit);
    }

    /* max_tokens 3584: a dense scanned page transcribes to well past the 1536
     * default (measured: 52 invoice lines truncated at ~2/3); the sidecar ctx
     * (12288) minus image tokens (>=1024) and prompt leaves comfortable room. */
    json_dyn_buf up = {0};
    int okb = json_dyn_puts(&up, "{\"data_uri\":") &&
              json_dyn_put_escaped(&up, data_uri) &&
              json_dyn_puts(&up, ",\"format\":\"text\",\"max_tokens\":3584,\"question\":") &&
              json_dyn_put_escaped(&up, figures_only ? figs_prompt : scan_prompt) &&
              json_dyn_puts(&up, "}");
    if (!okb) { free(up.ptr); return NULL; }

    char tmpl[] = "/tmp/dstudio-pdfvis-XXXXXX";
    int tf = mkstemp(tmpl);
    if (tf < 0) { free(up.ptr); return NULL; }
    size_t off = 0, tot = up.len;
    while (off < tot) { ssize_t w = write(tf, up.ptr + off, tot - off); if (w <= 0) break; off += (size_t)w; }
    close(tf); free(up.ptr);
    if (off < tot) { unlink(tmpl); return NULL; }

    char url[80]; snprintf(url, sizeof url, "http://127.0.0.1:%d/api/vision/describe", g_http_port);
    char dataarg[80]; snprintf(dataarg, sizeof dataarg, "@%s", tmpl);
    char *argv[16]; int n = 0;
    argv[n++] = "curl"; argv[n++] = "-sS"; argv[n++] = "-X"; argv[n++] = "POST";
    argv[n++] = "-H"; argv[n++] = "Content-Type: application/json";
    argv[n++] = "-H"; argv[n++] = "X-Requested-With: ds4web";
    argv[n++] = "--data-binary"; argv[n++] = dataarg;
    argv[n++] = "--max-time"; argv[n++] = "320";
    argv[n++] = url; argv[n] = NULL;
    int st = 0;
    char *resp = web_curl_capture(argv, 330000, &st);
    unlink(tmpl);
    /* Cache only good reads: a "see_image error: …" body must never be frozen
     * into future hits. Page files are small (a few KB), cap 256. */
    if (resp && resp[0] && strncmp(resp, "see_image error", 15) != 0)
        pdf_cache_write(ppath, resp, ".txt", 256);
    return resp;
}

/* The page's extracted text layer via pdftotext (all pages, form-feed
 * separated), or NULL when pdftotext is missing/fails. -layout preserves
 * columns and table alignment, which the chat model reads far better. */
static char *pdf_text_layer(const char *pdfpath) {
    char tool[256];
    if (!pdf_find_tool("pdftotext", tool, sizeof tool)) return NULL;
    char *argv[] = { tool, "-layout", "-enc", "UTF-8", (char *)pdfpath, "-", NULL };
    int st = -1;
    char *o = web_curl_capture(argv, 60000, &st);
    if (st != 0) { free(o); return NULL; }
    return o;
}

/* Describe cache: ~/.dstudio/pdf-cache/<fnv16>.json holds the full response
 * JSON of a successful read, keyed by document bytes + vision model + caps
 * (NOT the question — reads are pure extraction/transcription, so any question
 * over the same document is the same read). pg-<fnv16>.txt holds single-page
 * vision transcriptions. Both pruned oldest-first per suffix. */
#define PDF_CACHE_MAX_FILES 32
static void pdf_cache_path(unsigned long long key, char *out, size_t outsz) {
    const char *home = getenv("HOME");
    snprintf(out, outsz, "%s/.dstudio/pdf-cache/%016llx.json", home ? home : ".", key);
}

static void pdf_cache_write(const char *cpath, const char *data, const char *suffix, int cap) {
    char dir[DSTUDIO_PATH_MAX];
    cstr_copy(dir, sizeof dir, cpath);
    char *slash = strrchr(dir, '/');
    if (!slash) return;
    *slash = '\0';
    char parent[DSTUDIO_PATH_MAX];
    cstr_copy(parent, sizeof parent, dir);
    char *pslash = strrchr(parent, '/');
    if (pslash) { *pslash = '\0'; (void)mkdir(parent, 0755); }
    (void)mkdir(dir, 0755);
    char tmp[DSTUDIO_PATH_MAX + 8];
    snprintf(tmp, sizeof tmp, "%s.tmp", cpath);
    int f = open(tmp, O_WRONLY | O_CREAT | O_TRUNC, 0644);
    if (f < 0) return;
    size_t len = strlen(data), off = 0;
    while (off < len) { ssize_t w = write(f, data + off, len - off); if (w <= 0) break; off += (size_t)w; }
    close(f);
    if (off != len) { unlink(tmp); return; }
    rename(tmp, cpath);
    /* Prune: drop the oldest same-suffix entries beyond the cap (tiny dir). */
    size_t sl = strlen(suffix);
    for (int guard = 0; guard < 16; guard++) {
        DIR *d = opendir(dir);
        if (!d) return;
        struct dirent *e;
        int count = 0;
        time_t oldest_t = 0;
        char oldest[DSTUDIO_PATH_MAX] = "";
        while ((e = readdir(d)) != NULL) {
            size_t l = strlen(e->d_name);
            if (l <= sl || strcmp(e->d_name + l - sl, suffix) != 0) continue;
            char p[DSTUDIO_PATH_MAX];
            if ((size_t)snprintf(p, sizeof p, "%s/%s", dir, e->d_name) >= sizeof p) continue;
            struct stat st;
            if (stat(p, &st) != 0) continue;
            count++;
            if (!oldest[0] || st.st_mtime < oldest_t) { oldest_t = st.st_mtime; cstr_copy(oldest, sizeof oldest, p); }
        }
        closedir(d);
        if (count <= cap || !oldest[0]) return;
        unlink(oldest);
    }
}

/* Error reply in the caller's format: JSON for the UI, plain text for the
 * agent's read_pdf tool (format:"text"). */
static void pdf_describe_fail(int fd, int want_text, const char *status, const char *msg) {
    if (want_text) {
        char m[640];
        snprintf(m, sizeof m, "read_pdf error: %s\n", msg);
        send_text(fd, status, m, 0);
    } else {
        web_json_error(fd, status, msg);
    }
}

/* POST /api/pdf/describe — hybrid read: text layer first, vision for scans. */
static void api_pdf_describe_run(int fd, const char *body, int allow_path) {
    char fmt[16] = "";
    (void)json_get_string(body, "format", fmt, sizeof fmt);
    int want_text = !strcmp(fmt, "text");

    /* Optional pages:"N" | "N-M" | "N-" — read only that page range. This is
     * how a caller reaches pages past the text/vision caps of a long document
     * (the caps then apply within the range). rq_last 0 = to the end. */
    int rq_first = 0, rq_last = 0, has_range = 0;
    {
        char spec[48] = "";
        if (json_get_string(body, "pages", spec, sizeof spec) && spec[0]) {
            const char *p = spec;
            char *end = NULL;
            while (*p == ' ') p++;
            long a = strtol(p, &end, 10), b = 0;
            int good = end != p && a >= 1 && a <= PDF_MAX_TOTAL_PAGES;
            if (good) {
                p = end;
                while (*p == ' ') p++;
                if (*p == '-') {
                    p++;
                    while (*p == ' ') p++;
                    if (*p) {
                        b = strtol(p, &end, 10);
                        good = end != p && b >= a;
                        p = end;
                    }
                } else {
                    b = a;                          /* "N" = that single page */
                }
                while (*p == ' ') p++;
                if (*p) good = 0;
            }
            if (!good) {
                pdf_describe_fail(fd, want_text, "400 Bad Request",
                                  "invalid pages range (use \"N\", \"N-M\" or \"N-\")");
                return;
            }
            rq_first = (int)a;
            rq_last = (int)(b > PDF_MAX_TOTAL_PAGES ? PDF_MAX_TOTAL_PAGES : b);
            has_range = 1;
        }
    }

    char toppm[256];
    if (!pdf_find_tool("pdftoppm", toppm, sizeof toppm)) {
        pdf_describe_fail(fd, want_text, "503 Service Unavailable", pdf_poppler_hint());
        return;
    }
    /* NOTE: a body "question" is accepted but intentionally UNUSED: reads are
     * pure extraction/transcription (question-independent), so the cache works
     * across questions and the chat/agent model does the answering. */
    char jobid[64] = "", jobpath[DSTUDIO_PATH_MAX] = "";
    if (json_get_string(body, "job", jobid, sizeof jobid) && jobid[0])
        (void)pdf_job_path(jobid, jobpath, sizeof jobpath);

    int vcap = PDF_MAX_VISION_PAGES;
    const char *envc = getenv("DSTUDIO_PDF_MAX_PAGES");
    if (envc && envc[0]) { int v = atoi(envc); if (v > 0 && v <= PDF_MAX_VISION_PAGES_HARD) vcap = v; }

    int forbidden = 0;
    unsigned long long docfnv = 0;
    char *pdf = pdf_write_temp(body, allow_path, &forbidden, &docfnv);
    if (forbidden) { pdf_describe_fail(fd, want_text, "403 Forbidden", "path is host-local only; send data_uri"); return; }
    if (!pdf) { pdf_describe_fail(fd, want_text, "400 Bad Request", "a PDF (data_uri or host-local path) is required"); return; }
    pdf_job_write(jobpath, "{\"phase\":\"start\",\"done\":false}");

    /* Cache lookup — document bytes + vision model + caps (question-free: any
     * question over the same document is the same read). A hit skips rendering
     * AND the vision sidecar entirely. */
    unsigned long long key = docfnv;
    {
        char hf[256] = "";
        vision_hf_pref(hf, sizeof hf);
        /* Bump this salt on ANY pipeline-behavior change (thresholds, prompts,
         * classification): cached entries carry the OLD behavior and would
         * silently mask the fix for already-seen documents. */
        static const char *salt = "|hybrid-v3|";
        for (const char *s = salt; *s; s++)     { key ^= (unsigned char)*s; key *= 1099511628211ULL; }
        for (const char *s = hf; *s; s++)       { key ^= (unsigned char)*s; key *= 1099511628211ULL; }
        key ^= (unsigned long long)vcap;        key *= 1099511628211ULL;
        /* Range requests get their own cache slot; the no-range key stays as
         * before, so existing full-read entries remain valid. Keyed on the
         * REQUESTED range (the real page count is not known yet here): "5-999"
         * and "5-" may duplicate an entry, but never alias a different read. */
        if (has_range) {
            char rk[32];
            snprintf(rk, sizeof rk, "|r%d-%d|", rq_first, rq_last);
            for (const char *s = rk; *s; s++)   { key ^= (unsigned char)*s; key *= 1099511628211ULL; }
        }
    }
    char cpath[DSTUDIO_PATH_MAX];
    pdf_cache_path(key, cpath, sizeof cpath);
    {
        size_t cn = 0;
        char *cached = jsonl_read_file(cpath, &cn);
        if (cached && cn > 2 && cached[0] == '{') {
            (void)utimes(cpath, NULL);          /* LRU touch so pruning keeps hot docs */
            unlink(pdf); free(pdf);
            pdf_job_write(jobpath, "{\"phase\":\"done\",\"done\":true,\"cached\":true}");
            if (want_text) {
                char *t = json_get_string_alloc_rpc(cached, "text");
                send_text(fd, "200 OK", t && t[0] ? t : "(empty PDF)", 0);
                free(t);
            } else {
                json_dyn_buf hit = {0};
                if (json_dyn_puts(&hit, "{\"cached\":true,") && json_dyn_puts(&hit, cached + 1))
                    send_json(fd, "200 OK", hit.ptr);
                else
                    send_json(fd, "200 OK", cached);
                free(hit.ptr);
            }
            free(cached);
            return;
        }
        free(cached);
    }

    /* Total page count + page size via pdfinfo (drives the per-page walk, the
     * truncation note, and the figure-coverage math below). */
    int total = 0;
    double page_w_pts = 612, page_h_pts = 792;   /* Letter fallback */
    char pdfinfo[256];
    if (pdf_find_tool("pdfinfo", pdfinfo, sizeof pdfinfo)) {
        char *ia[] = { pdfinfo, pdf, NULL };
        int ist = 0; char *iout = web_curl_capture(ia, 20000, &ist);
        if (iout) {
            const char *p = strstr(iout, "Pages:");
            if (p) { int v = atoi(p + 6); if (v > 0) total = v; }
            const char *ps = strstr(iout, "Page size:");
            if (ps) {
                double w = 0, h = 0;
                if (sscanf(ps + 10, " %lf x %lf", &w, &h) == 2 && w > 1 && h > 1) {
                    page_w_pts = w; page_h_pts = h;
                }
            }
            free(iout);
        }
    }

    /* Text layer, split per page on pdftotext's form-feeds. pvis[] counts the
     * VISIBLE characters of each page: a page under PDF_TEXT_MIN_CHARS has no
     * usable text layer (scan / pure image) and goes to the vision model. */
    pdf_job_write(jobpath, "{\"phase\":\"text\",\"done\":false}");
    char *layer = pdf_text_layer(pdf);
    static const char *pstart[PDF_MAX_TOTAL_PAGES];
    static int plen[PDF_MAX_TOTAL_PAGES], pvis[PDF_MAX_TOTAL_PAGES];
    int tpages = 0;
    if (layer) {
        const char *p = layer;
        while (*p && tpages < PDF_MAX_TOTAL_PAGES) {
            const char *ff = strchr(p, '\f');
            size_t len = ff ? (size_t)(ff - p) : strlen(p);
            int vis = 0;
            for (size_t i = 0; i < len; i++)
                if (!isspace((unsigned char)p[i])) vis++;
            pstart[tpages] = p;
            plen[tpages] = (int)len;
            pvis[tpages] = vis;
            tpages++;
            if (!ff) break;
            p = ff + 1;                 /* a trailing form-feed ends the loop via *p */
        }
    }
    if (total < tpages) total = tpages;
    if (total <= 0) {
        free(layer); unlink(pdf); free(pdf);
        pdf_job_write(jobpath, "{\"phase\":\"error\",\"done\":true}");
        pdf_describe_fail(fd, want_text, "502 Bad Gateway", "could not read the PDF (no pages found)");
        return;
    }
    int npages = total > PDF_MAX_TOTAL_PAGES ? PDF_MAX_TOTAL_PAGES : total;

    /* Resolve the requested range against the real page count. A start past
     * the end is an error that TELLS the caller the document's size, so the
     * model can immediately retry with a valid range. */
    int pfirst = 1, plast = npages;
    if (has_range) {
        if (rq_first > npages) {
            free(layer); unlink(pdf); free(pdf);
            pdf_job_write(jobpath, "{\"phase\":\"error\",\"done\":true}");
            char em[112];
            if (rq_first > total)
                snprintf(em, sizeof em, "pages start past the end (the document has %d pages)", total);
            else
                snprintf(em, sizeof em, "only the first %d pages of this %d-page document are readable",
                         npages, total);
            pdf_describe_fail(fd, want_text, "400 Bad Request", em);
            return;
        }
        pfirst = rq_first;
        if (rq_last > 0 && rq_last < plast) plast = rq_last;
    }

    /* Mixed pages: a TEXT page that also carries a meaningful raster image
     * (chart, diagram, photo) additionally gets a figures-only vision pass —
     * pdftotext alone would silently drop the visual content of such pages.
     * One pdfimages -list call per document; placed size = pixels / x-ppi,
     * page size from pdfinfo above. Threshold: >=5% of the page AND >=3 in²
     * (letterhead logos are ~1-2 in²; real inline charts measured at ~7-15 in²
     * — a 6.8x2.1in Gantt strip is only ~15% of an A4 page, so a bare
     * fraction-of-page rule missed it). Vector-drawn figures (no raster) are a
     * known blind spot: pdfimages cannot see them. */
    static unsigned char page_has_fig[PDF_MAX_TOTAL_PAGES];
    memset(page_has_fig, 0, sizeof page_has_fig);
    char pimg[256];
    if (pdf_find_tool("pdfimages", pimg, sizeof pimg)) {
        char *la[] = { pimg, "-list", pdf, NULL };
        int lst = 0; char *lout = web_curl_capture(la, 30000, &lst);
        if (lout) {
            double page_in2 = (page_w_pts / 72.0) * (page_h_pts / 72.0);
            for (char *line = lout; line && *line; ) {
                char *nl = strchr(line, '\n');
                if (nl) *nl = '\0';
                int pg = 0, num = 0, w = 0, h = 0, comp = 0, bpc = 0, obj = 0, oid = 0;
                char type[16] = "", color[16] = "", enc[16] = "", interp[8] = "";
                double xppi = 0, yppi = 0;
                if (sscanf(line, "%d %d %15s %d %d %15s %d %d %15s %7s %d %d %lf %lf",
                           &pg, &num, type, &w, &h, color, &comp, &bpc, enc, interp,
                           &obj, &oid, &xppi, &yppi) == 14 &&
                    !strcmp(type, "image") && pg >= 1 && pg <= npages &&
                    xppi > 1 && yppi > 1 && page_in2 > 0.1) {
                    double in2 = ((double)w / xppi) * ((double)h / yppi);
                    if (in2 / page_in2 >= 0.05 && in2 >= 3.0) page_has_fig[pg - 1] = 1;
                }
                line = nl ? nl + 1 : NULL;
            }
            free(lout);
        }
    }

    /* Count the vision passes up front so the work is announced (and the
     * sidecar started) only when actually needed: a plain digital PDF never
     * touches the multi-GB vision model. Scanned pages take one full-page
     * transcription pass; mixed text+figure pages take one figures-only pass. */
    int nvis_wanted = 0;
    for (int i = pfirst - 1; i < plast; i++) {
        int is_text = (i < tpages && pvis[i] >= PDF_TEXT_MIN_CHARS);
        if (!is_text || page_has_fig[i]) nvis_wanted++;
    }
    int nvis = nvis_wanted > vcap ? vcap : nvis_wanted;

    char dir[] = "/tmp/dstudio-pdfr-XXXXXX";
    int have_dir = 0;
    if (nvis > 0) {
        pdf_job_write(jobpath, "{\"phase\":\"vision\",\"page\":0,\"pages\":%d,\"done\":false}", nvis);
        if (!vision_ensure_server(60000)) {
            free(layer); unlink(pdf); free(pdf);
            pdf_job_write(jobpath, "{\"phase\":\"error\",\"done\":true}");
            pdf_describe_fail(fd, want_text, "503 Service Unavailable",
                              "vision model is not running (needed for this PDF's scanned pages); "
                              "attach an image once or run vision setup");
            return;
        }
        if (!mkdtemp(dir)) {
            free(layer); unlink(pdf); free(pdf);
            pdf_job_write(jobpath, "{\"phase\":\"error\",\"done\":true}");
            pdf_describe_fail(fd, want_text, "500 Internal Server Error", "temp dir");
            return;
        }
        have_dir = 1;
    }

    json_dyn_buf text = {0};
    int ok = 1, text_used = 0, text_skipped = 0;
    int vdone = 0, vfail = 0, vskipped = 0, scan_pass = 0, fig_pass = 0, fig_skipped = 0;
    size_t text_bytes = 0;
    for (int i = pfirst - 1; ok && i < plast; i++) {
        int is_text = (i < tpages && pvis[i] >= PDF_TEXT_MIN_CHARS);
        int wants_fig = is_text && page_has_fig[i];
        if (is_text) {
            if (text_bytes >= PDF_TEXT_TOTAL_CAP) { text_skipped++; continue; }
            size_t take = (size_t)plen[i];
            if (text_bytes + take > PDF_TEXT_TOTAL_CAP) take = PDF_TEXT_TOTAL_CAP - text_bytes;
            ok = json_dyn_printf(&text, "\n--- Pagina %d (testo) ---\n", i + 1) &&
                 json_dyn_putn(&text, pstart[i], take) &&
                 json_dyn_puts(&text, "\n");
            text_bytes += take;
            text_used++;
        }
        if (!ok || (is_text && !wants_fig)) continue;
        /* Vision pass: full transcription for scans, figures-only for mixed
         * text+figure pages (their body text already shipped above). */
        if (vdone >= vcap) {
            if (wants_fig) fig_skipped++; else vskipped++;
            continue;
        }
        vdone++;
        if (wants_fig) fig_pass++; else scan_pass++;
        pdf_job_write(jobpath, "{\"phase\":\"vision\",\"page\":%d,\"pages\":%d,\"done\":false}", vdone, nvis);
        char pfx[sizeof dir + 16], img[sizeof dir + 24];
        snprintf(pfx, sizeof pfx, "%s/pg%d", dir, i + 1);
        snprintf(img, sizeof img, "%s.jpg", pfx);
        /* Adaptive size: re-render smaller until the data URI fits the
         * loopback body budget (a photo-dense scan can exceed it at 1400px
         * even as JPEG). */
        static const int scales[]    = { 1400, 1000, 800 };
        static const int qualities[] = { 85,   78,   70  };
        char *uri = NULL;
        for (int a = 0; a < 3 && !uri; a++) {
            if (!pdf_render(toppm, pdf, pfx, i + 1, i + 1, scales[a], 1, 1, qualities[a])) break;
            char *u = pdf_img_data_uri(img);
            unlink(img);
            if (u && strlen(u) <= PDF_PAGE_B64_BUDGET) uri = u;
            else free(u);
        }
        char *vt = uri ? pdf_vision_page(uri, wants_fig) : NULL;
        free(uri);
        /* format=text errors come back as a "see_image error: …" body. */
        int good = vt && vt[0] && strncmp(vt, "see_image error", 15) != 0;
        if (!good) vfail++;
        ok = json_dyn_printf(&text, wants_fig
                                 ? "\n--- Pagina %d (figure/grafici, letti dal modello vision locale) ---\n"
                                 : "\n--- Pagina %d (scansione, letta dal modello vision locale) ---\n",
                             i + 1) &&
             json_dyn_puts(&text, good ? vt : (wants_fig ? "(figure non leggibili)" : "(pagina non leggibile)")) &&
             json_dyn_puts(&text, "\n");
        free(vt);
    }
    int pages_read = text_used + scan_pass;   /* distinct pages with content */
    int range_partial = has_range ? (pfirst > 1 || plast < total) : (total > npages);
    int truncated = vskipped > 0 || fig_skipped > 0 || text_skipped > 0 || range_partial;
    if (ok && vskipped > 0)
        ok = json_dyn_printf(&text, "\n[PDF troncato: %d pagine scansionate oltre il limite di %d non lette.]\n",
                             vskipped, vcap);
    if (ok && fig_skipped > 0)
        ok = json_dyn_printf(&text, "\n[%d pagine con figure oltre il limite vision: incluso solo il loro testo.]\n",
                             fig_skipped);
    if (ok && text_skipped > 0)
        ok = json_dyn_printf(&text, "\n[Testo troncato: %d pagine di testo oltre il limite di %dKB omesse.]\n",
                             text_skipped, (int)(PDF_TEXT_TOTAL_CAP / 1024));
    if (ok && has_range)
        ok = json_dyn_printf(&text, "\n[Intervallo letto: pagine %d-%d di %d totali.]\n", pfirst, plast, total);
    else if (ok && total > npages)
        ok = json_dyn_printf(&text, "\n[PDF troncato alle prime %d di %d pagine.]\n", npages, total);

    free(layer);
    if (have_dir) rmdir(dir);
    unlink(pdf); free(pdf);

    if (!ok) {
        free(text.ptr);
        pdf_job_write(jobpath, "{\"phase\":\"error\",\"done\":true}");
        pdf_describe_fail(fd, want_text, "500 Internal Server Error", "oom");
        return;
    }
    json_dyn_buf out = {0};
    int good = json_dyn_printf(&out, "{\"ok\":true,\"pages\":%d,\"total\":%d,\"first\":%d,\"last\":%d,"
                                     "\"textPages\":%d,\"visionPages\":%d,\"figPages\":%d,\"truncated\":%s,\"text\":",
                               pages_read, total, pfirst, plast, text_used, vdone, fig_pass,
                               truncated ? "true" : "false") &&
               json_dyn_put_escaped(&out, text.ptr ? text.ptr : "") &&
               json_dyn_puts(&out, "}");
    if (!good) {
        free(text.ptr); free(out.ptr);
        pdf_job_write(jobpath, "{\"phase\":\"error\",\"done\":true}");
        pdf_describe_fail(fd, want_text, "500 Internal Server Error", "oom");
        return;
    }
    /* Cache only clean, non-empty reads: a transient vision failure must not
     * freeze "(pagina non leggibile)" into every future hit. (Successful pages
     * are still cached individually by pdf_vision_page, so a retry after a
     * partial failure redoes only the failed pages.) */
    if (vfail == 0 && pages_read > 0) pdf_cache_write(cpath, out.ptr, ".json", PDF_CACHE_MAX_FILES);
    pdf_job_write(jobpath, "{\"phase\":\"done\",\"done\":true}");
    if (want_text) send_text(fd, "200 OK", text.ptr && text.ptr[0] ? text.ptr : "(empty PDF)", 0);
    else           send_json(fd, "200 OK", out.ptr);
    free(text.ptr);
    free(out.ptr);
}

/* Fork a detached worker (rendering + per-page vision are slow) — like vision. */
static void api_pdf_fork(int fd, const char *body, int is_describe, int allow_path) {
    pid_t pid = fork();
    if (pid < 0) { if (is_describe) api_pdf_describe_run(fd, body, allow_path); else api_pdf_thumb_run(fd, body, allow_path); return; }
    if (pid == 0) {
        if (fork() > 0) _exit(0);
        if (g_srv_fd >= 0) close(g_srv_fd);
        if (g_out_fd >= 0) close(g_out_fd);
        if (g_err_fd >= 0) close(g_err_fd);
        if (g_in_fd  >= 0) close(g_in_fd);
        struct timeval tv = { 620, 0 };
        (void)setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof tv);
        qwen_memory_lease lease = {0};
        if (is_describe) lease = qwen_memory_begin("pdf");
        if (is_describe) api_pdf_describe_run(fd, body, allow_path);
        else             api_pdf_thumb_run(fd, body, allow_path);
        qwen_memory_end(&lease);
        close(fd);
        _exit(0);
    }
    waitpid(pid, NULL, 0);
}
#endif /* !_WIN32 */

static void api_pdf_thumb(int fd, const char *body) {
#ifdef _WIN32
    (void)body;
    web_json_error(fd, "501 Not Implemented", "PDF is not available on the Windows build yet");
#else
    api_pdf_fork(fd, body, 0, client_is_loopback(fd));
#endif
}
static void api_pdf_describe(int fd, const char *body) {
#ifdef _WIN32
    (void)body;
    web_json_error(fd, "501 Not Implemented", "PDF is not available on the Windows build yet");
#else
    vision_touch_last_use();
    api_pdf_fork(fd, body, 1, client_is_loopback(fd));
#endif
}

/* GET /api/pdf/progress?job=<id> — the live state of a running describe (the
 * worker rewrites the job file at every step). Host-local surface for the UI's
 * per-page progress label. */
static void api_pdf_progress(int fd, const char *path) {
#ifdef _WIN32
    (void)path;
    web_json_error(fd, "501 Not Implemented", "PDF is not available on the Windows build yet");
#else
    const char *q = strchr(path, '?');
    char jobid[64] = "";
    if (q) {
        const char *j = strstr(q, "job=");
        if (j) {
            j += 4;
            size_t o = 0;
            while (*j && *j != '&' && o < sizeof jobid - 1) jobid[o++] = *j++;
            jobid[o] = '\0';
        }
    }
    char jobpath[DSTUDIO_PATH_MAX];
    if (!jobid[0] || !pdf_job_path(jobid, jobpath, sizeof jobpath)) {
        web_json_error(fd, "400 Bad Request", "job id is required");
        return;
    }
    size_t n = 0;
    char *b = jsonl_read_file(jobpath, &n);
    if (!b || n == 0 || b[0] != '{') {
        free(b);
        send_json(fd, "200 OK", "{\"phase\":\"unknown\",\"done\":false}");
        return;
    }
    send_json(fd, "200 OK", b);
    free(b);
#endif
}

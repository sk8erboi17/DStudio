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
 * Full/Agent reads are question-independent and page-addressable. Interactive
 * chat uses one of three LLM-selected read plans: exact physical pages, a
 * bounded whole-book overview, or semantic retrieval across every page. This
 * keeps a 1000-page book bounded without losing the ability to find evidence
 * outside the prompt sample. Results are cached by document + profile/query;
 * every single page's
 * vision transcription is cached by its rendered image, so a partial failure
 * retries only failed pages. Text pages that also carry a
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
#define PDF_INTERACTIVE_TEXT_CAP (24 * 1024) /* bounded chat prompt: ~6k tokens, independent of page count */
#define PDF_INTERACTIVE_TEXT_CAP_MIN (8 * 1024)
#define PDF_INTERACTIVE_TEXT_CAP_MAX (64 * 1024)
#define PDF_INTERACTIVE_MAX_TEXT_PAGES 48 /* enough context per selected page even for 1000-page books */
#define PDF_INTERACTIVE_SCAN_PASSES 8    /* representative OCR for a fully scanned long document */
#define PDF_INTERACTIVE_FIG_PASSES 2     /* figures supplement text; do not make chat wait for every chart */
#define PDF_SEMANTIC_MAX_PAGES 6         /* targeted RAG: enough budget to read each hit deeply */
#define PDF_EMBED_PAGE_CHARS 6000        /* one multilingual embedding per page, cached on disk */
#define PDF_PAGE_B64_BUDGET (1500 * 1024) /* per-page data-URI budget (loopback 2MB body cap) */
#define PDF_EMBED_INDEX_MAGIC 0x44504531u /* "DPE1" */
typedef struct {
    unsigned magic;
    int dim, count;
    unsigned long long docfnv;
    char model[128];
} pdf_embed_index_hdr;

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

static int pdf_selected_count(const unsigned char *selected, int first, int last) {
    int n = 0;
    for (int i = first; i <= last; i++) if (selected[i]) n++;
    return n;
}

/* A broad overview never grows its prompt with the document. Small PDFs keep
 * every page; long books keep front/back anchors and maximum-distance coverage
 * across the whole book. Targeted questions use the separate semantic path. */
static int pdf_select_interactive_pages(unsigned char *selected,
                                        int first, int last,
                                        int limit) {
    memset(selected, 0, PDF_MAX_TOTAL_PAGES);
    int count = last - first + 1;
    if (count <= 0) return 0;
    if (limit > count) limit = count;
    if (limit < 1) limit = 1;
    if (count <= limit) {
        for (int i = first; i <= last; i++) selected[i] = 1;
        return count;
    }

    /* Front/back matter anchors: title/abstract/TOC plus conclusion/index. */
    for (int k = 0; k < 3 && k < count; k++) selected[first + k] = 1;
    for (int k = 0; k < 3 && k < count; k++) selected[last - k] = 1;

    /* Farthest-point fill produces even coverage without assuming chapters or
     * a particular language/layout. At 2000x48 this is still tiny. */
    while (pdf_selected_count(selected, first, last) < limit) {
        int best = -1, best_dist = -1;
        for (int i = first; i <= last; i++) {
            if (selected[i]) continue;
            int nearest = last - first + 1;
            for (int j = first; j <= last; j++) {
                if (!selected[j]) continue;
                int d = i > j ? i - j : j - i;
                if (d < nearest) nearest = d;
            }
            if (nearest > best_dist) { best = i; best_dist = nearest; }
        }
        if (best < 0) break;
        selected[best] = 1;
    }
    return pdf_selected_count(selected, first, last);
}

static size_t pdf_utf8_safe_start(const char *s, size_t pos, size_t len) {
    while (pos < len && (((unsigned char)s[pos] & 0xc0) == 0x80)) pos++;
    return pos;
}

static size_t pdf_utf8_safe_end(const char *s, size_t pos) {
    while (pos > 0 && (((unsigned char)s[pos] & 0xc0) == 0x80)) pos--;
    return pos;
}

/* Append a bounded page excerpt. Relevant pages center the window around the
 * first query hit. Generic pages retain both their beginning and end, which
 * captures headings plus page-ending conclusions/captions. */
static int pdf_append_page_excerpt(json_dyn_buf *out, const char *page, size_t len,
                                   size_t quota, int match_at) {
    if (quota >= len) return json_dyn_putn(out, page, len);
    if (quota < 32) quota = 32;
    if (match_at >= 0) {
        size_t before = quota / 3;
        size_t start = (size_t)match_at > before ? (size_t)match_at - before : 0;
        if (start + quota > len) start = len - quota;
        start = pdf_utf8_safe_start(page, start, len);
        size_t end = start + quota < len ? start + quota : len;
        end = pdf_utf8_safe_end(page, end);
        return (start == 0 || json_dyn_puts(out, "[...]") ) &&
               json_dyn_putn(out, page + start, end - start) &&
               (end == len || json_dyn_puts(out, "[...]"));
    }
    size_t head = quota * 2 / 3;
    size_t tail = quota - head;
    head = pdf_utf8_safe_end(page, head);
    size_t tail_start = pdf_utf8_safe_start(page, len - tail, len);
    return json_dyn_putn(out, page, head) &&
           json_dyn_puts(out, "\n[... excerpt ...]\n") &&
           json_dyn_putn(out, page + tail_start, len - tail_start);
}

static void pdf_embed_index_path(unsigned long long docfnv, char *out, size_t outsz) {
    const char *home = getenv("HOME");
    snprintf(out, outsz, "%s/.dstudio/pdf-cache/emb-%016llx.bin",
             home ? home : ".", docfnv);
}

static float *pdf_embed_index_load(const pdf_embed_index_hdr *want) {
    char path[DSTUDIO_PATH_MAX];
    pdf_embed_index_path(want->docfnv, path, sizeof path);
    FILE *f = fopen(path, "rb");
    if (!f) return NULL;
    pdf_embed_index_hdr got;
    if (fread(&got, sizeof got, 1, f) != 1 || got.magic != want->magic ||
        got.dim != want->dim || got.count != want->count || got.docfnv != want->docfnv ||
        strncmp(got.model, want->model, sizeof got.model) != 0) {
        fclose(f);
        return NULL;
    }
    size_t nf = (size_t)got.dim * (size_t)got.count;
    float *vecs = malloc(nf * sizeof *vecs);
    if (!vecs || fread(vecs, sizeof *vecs, nf, f) != nf) {
        free(vecs);
        fclose(f);
        return NULL;
    }
    fclose(f);
    (void)utimes(path, NULL);
    return vecs;
}

static void pdf_embed_index_save(const pdf_embed_index_hdr *h, const float *vecs) {
    char path[DSTUDIO_PATH_MAX], dir[DSTUDIO_PATH_MAX];
    pdf_embed_index_path(h->docfnv, path, sizeof path);
    cstr_copy(dir, sizeof dir, path);
    char *slash = strrchr(dir, '/');
    if (!slash) return;
    *slash = '\0';
    char parent[DSTUDIO_PATH_MAX];
    cstr_copy(parent, sizeof parent, dir);
    char *pslash = strrchr(parent, '/');
    if (pslash) { *pslash = '\0'; (void)mkdir(parent, 0755); }
    (void)mkdir(dir, 0755);
    char tmp[DSTUDIO_PATH_MAX + 8];
    snprintf(tmp, sizeof tmp, "%s.tmp", path);
    FILE *f = fopen(tmp, "wb");
    if (!f) return;
    size_t nf = (size_t)h->dim * (size_t)h->count;
    int ok = fwrite(h, sizeof *h, 1, f) == 1 && fwrite(vecs, sizeof *vecs, nf, f) == nf;
    fclose(f);
    if (ok) rename(tmp, path);
    else unlink(tmp);
}

/* Build/load one multilingual embedding per physical page, then score all
 * pages against the semantic query produced by the LLM router. No keywords,
 * language lists or regex participate in retrieval. */
static int pdf_semantic_page_scores(unsigned long long docfnv,
                                    const char *const *pstart, const int *plen,
                                    int tpages, int npages,
                                    const char *query, int *scores) {
    if (!query || !query[0] || npages <= 0) return 0;
    embed_touch_last_use();
    if (!embed_ensure_server(60000)) return 0;

    char model[128];
    embed_hf_pref(model, sizeof model);
    int dim = 0;
    float probe[EMBED_MAX_DIM];
    char *ping[1] = { (char *)"document page" };
    if (!embed_call(ping, 1, NULL, probe, EMBED_MAX_DIM, &dim) ||
        dim <= 0 || dim > EMBED_MAX_DIM) return 0;

    pdf_embed_index_hdr want = { PDF_EMBED_INDEX_MAGIC, dim, npages, docfnv, {0} };
    cstr_copy(want.model, sizeof want.model, model);
    float *vecs = pdf_embed_index_load(&want);
    if (!vecs) {
        vecs = malloc((size_t)npages * (size_t)dim * sizeof *vecs);
        if (!vecs) return 0;
        /* One full page per call keeps every sequence below the server context
         * and avoids llama.cpp treating a multi-page array as one oversized
         * Metal embedding batch. The resulting index is persisted, so this
         * cost is paid only once per PDF/model version. */
        const int batch = 1;
        for (int start = 0; start < npages; start += batch) {
            int count = npages - start < batch ? npages - start : batch;
            char *texts[16] = {0};
            int alloc_ok = 1;
            for (int j = 0; j < count; j++) {
                int pg = start + j;
                size_t take = pg < tpages && plen[pg] > 0 ? (size_t)plen[pg] : 0;
                if (take > PDF_EMBED_PAGE_CHARS) take = PDF_EMBED_PAGE_CHARS;
                size_t need = take + 48;
                texts[j] = malloc(need);
                if (!texts[j]) { alloc_ok = 0; break; }
                int head = snprintf(texts[j], need, "Physical PDF page %d.\n", pg + 1);
                if (head < 0 || (size_t)head >= need) { alloc_ok = 0; break; }
                if (take) memcpy(texts[j] + head, pstart[pg], take);
                texts[j][head + take] = '\0';
            }
            int got_dim = 0;
            int embedded = alloc_ok && embed_call(texts, count, NULL,
                                                  vecs + (size_t)start * (size_t)dim,
                                                  dim, &got_dim) && got_dim == dim;
            for (int j = 0; j < count; j++) free(texts[j]);
            if (!embedded) { free(vecs); return 0; }
            embed_touch_last_use();
        }
        pdf_embed_index_save(&want, vecs);
    }

    static const char *prefix =
        "Instruct: Given a user question, retrieve the document pages that contain the answer.\nQuery: ";
    float qv[EMBED_MAX_DIM];
    char *queries[1] = { (char *)query };
    int qdim = 0;
    if (!embed_call(queries, 1, prefix, qv, EMBED_MAX_DIM, &qdim) || qdim != dim) {
        free(vecs);
        return 0;
    }
    for (int i = 0; i < npages; i++) {
        const float *v = vecs + (size_t)i * (size_t)dim;
        double dot = 0;
        for (int k = 0; k < dim; k++) dot += (double)qv[k] * v[k];
        scores[i] = (int)(dot * 1000000.0);
    }
    free(vecs);
    embed_touch_last_use();
    return 1;
}

/* Targeted semantic reads keep only the strongest pages, plus immediate
 * neighbors while room remains. This spends the fixed character budget on
 * complete evidence instead of thin excerpts from dozens of unrelated pages. */
static int pdf_select_semantic_pages(unsigned char *selected, const int *scores,
                                     int first, int last, int limit) {
    memset(selected, 0, PDF_MAX_TOTAL_PAGES);
    int count = last - first + 1;
    if (limit > count) limit = count;
    if (limit < 1) return 0;
    int primary[PDF_SEMANTIC_MAX_PAGES];
    int nprimary = 0;
    int primary_cap = limit < 4 ? limit : 4;
    while (nprimary < primary_cap) {
        int best = -1, best_score = INT_MIN;
        for (int i = first; i <= last; i++) {
            if (!selected[i] && scores[i] > best_score) {
                best = i;
                best_score = scores[i];
            }
        }
        if (best < 0) break;
        selected[best] = 1;
        primary[nprimary++] = best;
    }
    int selected_count = nprimary;
    for (int distance = 1; selected_count < limit && distance <= 2; distance++) {
        for (int p = 0; p < nprimary && selected_count < limit; p++) {
            int around[2] = { primary[p] - distance, primary[p] + distance };
            for (int a = 0; a < 2 && selected_count < limit; a++) {
                int pg = around[a];
                if (pg >= first && pg <= last && !selected[pg]) {
                    selected[pg] = 1;
                    selected_count++;
                }
            }
        }
    }
    return selected_count;
}

/* Describe cache: ~/.dstudio/pdf-cache/<fnv16>.json holds the full response
 * JSON of a successful read. Full reads use document + vision model + caps;
 * overview reads include their content budget; semantic reads also include
 * the retrieval query. pg-<fnv16>.txt
 * holds query-independent single-page vision transcriptions. Both stores are
 * pruned oldest-first per suffix. */
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

static void pdf_describe_need_embedding(int fd, int want_text) {
    if (want_text) {
        send_text(fd, "503 Service Unavailable",
                  "read_pdf error: semantic PDF search needs the local embedding model\n", 0);
    } else {
        send_json(fd, "503 Service Unavailable",
                  "{\"ok\":false,\"needs\":\"embedding\",\"error\":\"semantic PDF search needs the local embedding model\"}");
    }
}

/* POST /api/pdf/describe — hybrid read: text layer first, vision for scans. */
static void api_pdf_describe_run(int fd, const char *body, int allow_path) {
    char fmt[16] = "";
    (void)json_get_string(body, "format", fmt, sizeof fmt);
    int want_text = !strcmp(fmt, "text");

    char profile[24] = "", semantic_query[1024] = "";
    (void)json_get_string(body, "profile", profile, sizeof profile);
    (void)json_get_string(body, "semantic_query", semantic_query, sizeof semantic_query);
    int semantic = !strcmp(profile, "semantic");
    int interactive = semantic || !strcmp(profile, "interactive");
    if (semantic && !semantic_query[0]) {
        pdf_describe_fail(fd, want_text, "400 Bad Request", "semantic_query is required");
        return;
    }
    long interactive_cap_long = PDF_INTERACTIVE_TEXT_CAP;
    if (interactive) {
        int cr = json_get_int(body, "max_chars", PDF_INTERACTIVE_TEXT_CAP_MIN,
                              PDF_INTERACTIVE_TEXT_CAP_MAX, &interactive_cap_long);
        if (cr < 0) {
            pdf_describe_fail(fd, want_text, "400 Bad Request",
                              "max_chars must be between 8192 and 65536");
            return;
        }
    }
    size_t interactive_cap = (size_t)interactive_cap_long;

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

    /* Cache lookup — overview/full reads are question-independent. Semantic
     * reads include the LLM-produced retrieval query. Per-page embeddings and
     * vision remain reusable across questions. */
    unsigned long long key = docfnv;
    {
        char hf[256] = "";
        vision_hf_pref(hf, sizeof hf);
        /* Bump this salt on ANY pipeline-behavior change (thresholds, prompts,
         * classification): cached entries carry the OLD behavior and would
         * silently mask the fix for already-seen documents. */
        static const char *salt = "|hybrid-v6-semantic|";
        for (const char *s = salt; *s; s++)     { key ^= (unsigned char)*s; key *= 1099511628211ULL; }
        for (const char *s = hf; *s; s++)       { key ^= (unsigned char)*s; key *= 1099511628211ULL; }
        key ^= (unsigned long long)vcap;        key *= 1099511628211ULL;
        if (interactive) {
            static const char *ip = "|interactive-adaptive|";
            for (const char *s = ip; *s; s++)       { key ^= (unsigned char)*s; key *= 1099511628211ULL; }
            key ^= (unsigned long long)interactive_cap; key *= 1099511628211ULL;
        }
        if (semantic) {
            static const char *sp = "|semantic-rag|";
            for (const char *s = sp; *s; s++)             { key ^= (unsigned char)*s; key *= 1099511628211ULL; }
            for (const char *s = semantic_query; *s; s++) { key ^= (unsigned char)*s; key *= 1099511628211ULL; }
        }
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

    /* The LLM router chooses overview, an explicit physical page range, or a
     * semantic search. Overview uses deterministic whole-book coverage;
     * semantic mode ranks every page with multilingual embeddings. Explicit
     * Agent read_pdf ranges keep the full/read-verbatim behavior. */
    static int pscore[PDF_MAX_TOTAL_PAGES], pmatch[PDF_MAX_TOTAL_PAGES];
    static unsigned char page_selected[PDF_MAX_TOTAL_PAGES];
    memset(pscore, 0, sizeof pscore);
    for (int i = 0; i < PDF_MAX_TOTAL_PAGES; i++) pmatch[i] = -1;
    memset(page_selected, interactive ? 0 : 1, sizeof page_selected);
    int selected_pages = plast - pfirst + 1;
    if (semantic) {
        pdf_job_write(jobpath, "{\"phase\":\"semantic\",\"done\":false}");
        if (!pdf_semantic_page_scores(docfnv, pstart, plen, tpages, npages,
                                      semantic_query, pscore)) {
            free(layer); unlink(pdf); free(pdf);
            pdf_job_write(jobpath, "{\"phase\":\"error\",\"done\":true}");
            pdf_describe_need_embedding(fd, want_text);
            return;
        }
        selected_pages = pdf_select_semantic_pages(page_selected, pscore,
                                                    pfirst - 1, plast - 1,
                                                    PDF_SEMANTIC_MAX_PAGES);
    } else if (interactive) {
        int page_limit = (int)(interactive_cap / 512);
        if (page_limit > PDF_INTERACTIVE_MAX_TEXT_PAGES) page_limit = PDF_INTERACTIVE_MAX_TEXT_PAGES;
        selected_pages = pdf_select_interactive_pages(page_selected,
                                                       pfirst - 1, plast - 1,
                                                       page_limit);
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
                    page_selected[pg - 1] &&
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
    int nvis_wanted = 0, scans_wanted = 0, figs_wanted = 0;
    for (int i = pfirst - 1; i < plast; i++) {
        if (!page_selected[i]) continue;
        int is_text = (i < tpages && pvis[i] >= PDF_TEXT_MIN_CHARS);
        if (!is_text) scans_wanted++;
        else if (page_has_fig[i]) figs_wanted++;
    }
    if (interactive) {
        int ns = scans_wanted > PDF_INTERACTIVE_SCAN_PASSES ? PDF_INTERACTIVE_SCAN_PASSES : scans_wanted;
        int nf = figs_wanted > PDF_INTERACTIVE_FIG_PASSES ? PDF_INTERACTIVE_FIG_PASSES : figs_wanted;
        nvis_wanted = ns + nf;
    } else {
        nvis_wanted = scans_wanted + figs_wanted;
    }
    int nvis = nvis_wanted > vcap ? vcap : nvis_wanted;

    char dir[] = "/tmp/dstudio-pdfr-XXXXXX";
    int have_dir = 0;
    qwen_memory_lease vision_lease = {0};
    if (nvis > 0) {
        pdf_job_write(jobpath, "{\"phase\":\"vision\",\"page\":0,\"pages\":%d,\"done\":false}", nvis);
        vision_lease = qwen_memory_begin("pdf");
        if (!vision_ensure_server(60000)) {
            qwen_memory_end(&vision_lease);
            free(layer); unlink(pdf); free(pdf);
            pdf_job_write(jobpath, "{\"phase\":\"error\",\"done\":true}");
            pdf_describe_fail(fd, want_text, "503 Service Unavailable",
                              "vision model is not running (needed for this PDF's scanned pages); "
                              "attach an image once or run vision setup");
            return;
        }
        if (!mkdtemp(dir)) {
            qwen_memory_end(&vision_lease);
            free(layer); unlink(pdf); free(pdf);
            pdf_job_write(jobpath, "{\"phase\":\"error\",\"done\":true}");
            pdf_describe_fail(fd, want_text, "500 Internal Server Error", "temp dir");
            return;
        }
        have_dir = 1;
    }

    json_dyn_buf text = {0};
    int ok = 1, text_used = 0, text_skipped = 0, text_partial = 0;
    int vdone = 0, vfail = 0, vskipped = 0, scan_pass = 0, fig_pass = 0, fig_skipped = 0;
    int pages_omitted = (plast - pfirst + 1) - selected_pages;
    size_t text_bytes = 0, vision_bytes = 0;
    size_t content_cap = interactive ? interactive_cap : PDF_TEXT_TOTAL_CAP;
    size_t text_cap = content_cap;
    int total_weight = 0;
    for (int i = pfirst - 1; i < plast; i++) {
        if (!page_selected[i] || i >= tpages || pvis[i] < PDF_TEXT_MIN_CHARS) continue;
        int weight = 1;
        if (i == pfirst - 1) weight += 5;
        else if (i == pfirst || i == plast - 1) weight += 1;
        if (pscore[i] > 0) weight += pscore[i] > 3 ? 3 : pscore[i];
        total_weight += weight;
    }
    /* The advertised interactive limit covers perception text too. A mixed
     * digital document reserves 25% for charts; a scan-only document gives the
     * whole budget to OCR. This prevents eight dense Qwen transcriptions from
     * quietly turning a 20KB book context back into an 80KB prompt. */
    if (interactive && nvis > 0)
        text_cap = total_weight > 0 ? content_cap * 3 / 4 : 0;
    size_t vision_cap = interactive ? content_cap - text_cap : (size_t)-1;
    for (int i = pfirst - 1; ok && i < plast; i++) {
        if (!page_selected[i]) continue;
        int is_text = (i < tpages && pvis[i] >= PDF_TEXT_MIN_CHARS);
        int wants_fig = is_text && page_has_fig[i];
        if (is_text) {
            size_t take = (size_t)plen[i];
            if (interactive && total_weight > 0) {
                int weight = 1;
                if (i == pfirst - 1) weight += 5;
                else if (i == pfirst || i == plast - 1) weight += 1;
                if (pscore[i] > 0) weight += pscore[i] > 3 ? 3 : pscore[i];
                take = text_cap * (size_t)weight / (size_t)total_weight;
                if (take < 32) take = 32;
                if (take > (size_t)plen[i]) take = (size_t)plen[i];
            } else {
                if (text_bytes >= text_cap) { text_skipped++; continue; }
                if (text_bytes + take > text_cap) take = text_cap - text_bytes;
            }
            int excerpt_match = pmatch[i];
            if (i == pfirst - 1 && excerpt_match < 0) excerpt_match = 0;
            ok = json_dyn_printf(&text, "\n--- Pagina %d (testo) ---\n", i + 1) &&
                 pdf_append_page_excerpt(&text, pstart[i], (size_t)plen[i], take, excerpt_match) &&
                 json_dyn_puts(&text, "\n");
            text_bytes += take;
            text_used++;
            if (take < (size_t)plen[i]) text_partial++;
        }
        if (!ok || (is_text && !wants_fig)) continue;
        /* Vision pass: full transcription for scans, figures-only for mixed
         * text+figure pages (their body text already shipped above). */
        int pass_cap_hit = vdone >= vcap ||
            (interactive && wants_fig && fig_pass >= PDF_INTERACTIVE_FIG_PASSES) ||
            (interactive && !wants_fig && scan_pass >= PDF_INTERACTIVE_SCAN_PASSES);
        if (pass_cap_hit) {
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
                             i + 1);
        if (ok && good && interactive) {
            size_t remain = vision_bytes < vision_cap ? vision_cap - vision_bytes : 0;
            int passes_left = nvis - vdone + 1;
            size_t take = passes_left > 0 ? remain / (size_t)passes_left : remain;
            size_t vlen = strlen(vt);
            if (take > vlen) take = vlen;
            ok = take > 0 && pdf_append_page_excerpt(&text, vt, vlen, take, -1);
            vision_bytes += take;
        } else if (ok) {
            const char *shown = good ? vt : (wants_fig ? "(figure non leggibili)" : "(pagina non leggibile)");
            ok = json_dyn_puts(&text, shown);
            if (good) vision_bytes += strlen(vt);
        }
        if (ok) ok = json_dyn_puts(&text, "\n");
        free(vt);
    }
    qwen_memory_end(&vision_lease);
    int pages_read = text_used + scan_pass;   /* distinct pages with content */
    int range_partial = has_range ? (pfirst > 1 || plast < total) : (total > npages);
    int sampled = interactive && (pages_omitted > 0 || text_partial > 0);
    int truncated = vskipped > 0 || fig_skipped > 0 || text_skipped > 0 || range_partial || sampled;
    if (ok && vskipped > 0)
        ok = json_dyn_printf(&text, "\n[PDF troncato: %d pagine scansionate oltre il limite di %d non lette.]\n",
                             vskipped, vcap);
    if (ok && fig_skipped > 0)
        ok = json_dyn_printf(&text, "\n[%d pagine con figure oltre il limite vision: incluso solo il loro testo.]\n",
                             fig_skipped);
    if (ok && text_skipped > 0)
        ok = json_dyn_printf(&text, "\n[Testo troncato: %d pagine di testo oltre il limite di %dKB omesse.]\n",
                             text_skipped, (int)(text_cap / 1024));
    if (ok && sampled && semantic)
        ok = json_dyn_printf(&text,
            "\n[Ricerca semantica PDF: lette %d pagine candidate su %d, %zu caratteri di contenuto.]\n",
            selected_pages, plast - pfirst + 1, text_bytes + vision_bytes);
    else if (ok && sampled)
        ok = json_dyn_printf(&text,
            "\n[Contesto PDF adattivo: %d pagine rappresentative su %d, %zu caratteri di contenuto; "
            "estratti distribuiti tra inizio e fine del documento.]\n",
            selected_pages, plast - pfirst + 1, text_bytes + vision_bytes);
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
                                     "\"textPages\":%d,\"visionPages\":%d,\"figPages\":%d,"
                                     "\"selectedPages\":%d,\"textChars\":%zu,\"visionChars\":%zu,"
                                     "\"contentChars\":%zu,\"semantic\":%s,\"sampled\":%s,\"truncated\":%s,\"text\":",
                               pages_read, total, pfirst, plast, text_used, vdone, fig_pass,
                               selected_pages, text_bytes, vision_bytes, text_bytes + vision_bytes,
                               semantic ? "true" : "false", sampled ? "true" : "false",
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
        if (is_describe) api_pdf_describe_run(fd, body, allow_path);
        else             api_pdf_thumb_run(fd, body, allow_path);
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

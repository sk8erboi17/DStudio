/* ============================================================================
 * PDF attachments — local text extraction and semantic retrieval.
 *
 * pdftotext (Poppler) extracts every embedded text layer verbatim. Interactive
 * chat then uses one of three model-selected read plans: exact physical pages,
 * a bounded whole-book overview, or hybrid retrieval across overlapping text
 * passages. Dense embeddings provide semantic recall, BM25 recovers exact
 * names/formulas, and every hit retains its physical page and byte offset.
 * Scanned/image-only pages are counted and reported but are never sent to a
 * secondary visual model. Native DeepSeek Vision-Exp and GLM 5.3 can inspect
 * explicitly attached rendered pages through their own encoders.
 *
 *   POST /api/pdf/thumb    — render page 1 → {ok, thumb: data-URI} (attach-time preview)
 *   POST /api/pdf/describe — text read → {ok, text, pages, total, first,
 *                            last, textPages, scannedPages, truncated, cached}.
 *                            format:"text" → text/plain (the agent's read_pdf
 *                            tool). pages:"N"|"N-M"|"N-" reads only that page
 *                            range — how a caller reaches pages past the caps
 *                            of a long document. Optional job:"<id>" → progress
 *                            readable at GET /api/pdf/progress?job=<id>.
 * ==========================================================================*/
#ifndef _WIN32
#define PDF_MAX_TOTAL_PAGES 2000         /* sanity cap for the per-page bookkeeping */
#define PDF_TEXT_MIN_CHARS 24            /* page text layer below this → treat as scanned */
#define PDF_TEXT_TOTAL_CAP (160 * 1024)  /* total text-layer bytes shipped to the model */
#define PDF_INTERACTIVE_TEXT_CAP (24 * 1024) /* bounded chat prompt: ~6k tokens, independent of page count */
#define PDF_INTERACTIVE_TEXT_CAP_MIN (8 * 1024)
#define PDF_INTERACTIVE_TEXT_CAP_MAX (64 * 1024)
#define PDF_INTERACTIVE_MAX_TEXT_PAGES 48 /* enough context per selected page even for 1000-page books */
#define PDF_SEMANTIC_MAX_PAGES 6         /* three evidence anchors plus nearby continuity pages */
#define PDF_NATIVE_VISION_MAX_PAGES 4    /* bounded native-encoder PDF page handoff */
#define PDF_RAG_CHUNK_CHARS 3200          /* bounded semantic windows, not arbitrary full pages */
#define PDF_RAG_CHUNK_OVERLAP 500         /* preserves passages spanning adjacent windows */
#define PDF_RAG_CROSS_PAGE_CHARS 320      /* preserves sentences split by physical page breaks */
#define PDF_RAG_EMBED_BATCH 4             /* best end-to-end latency; oversized inputs split recursively */
#define PDF_RAG_MAX_QUERY_TERMS 16
#define PDF_TEXT_CACHE_MAX_FILES 32
#define PDF_EMBED_CACHE_MAX_FILES 32
#define PDF_EMBED_INDEX_MAGIC 0x44504532u /* "DPE2": overlapping chunk vectors */
typedef struct {
    unsigned magic;
    int dim, count;
    unsigned long long docfnv;
    char model[128];
} pdf_embed_index_hdr;
typedef struct {
    int page;       /* zero-based physical page owning the window */
    int start;      /* byte offset inside that page */
    int len;
} pdf_rag_chunk;
typedef struct {
    char text[64];
    int len;
    int df;
} pdf_rag_term;

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

/* Rasterize pages [first..last] for the PDF attachment thumbnail. */
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

static char *pdf_base64_encode(const unsigned char *data, size_t len) {
    static const char table[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    size_t out_len = 4 * ((len + 2) / 3);
    char *out = malloc(out_len + 1);
    if (!out) return NULL;
    size_t o = 0;
    for (size_t i = 0; i < len; i += 3) {
        unsigned int value = (unsigned int)data[i] << 16;
        if (i + 1 < len) value |= (unsigned int)data[i + 1] << 8;
        if (i + 2 < len) value |= (unsigned int)data[i + 2];
        out[o++] = table[(value >> 18) & 63];
        out[o++] = table[(value >> 12) & 63];
        out[o++] = i + 1 < len ? table[(value >> 6) & 63] : '=';
        out[o++] = i + 2 < len ? table[value & 63] : '=';
    }
    out[o] = '\0';
    return out;
}

/* Read a rendered page image → "data:image/…;base64,…" (malloc'd) or NULL. */
static char *pdf_img_data_uri(const char *imgpath) {
    size_t n = 0;
    char *bytes = jsonl_read_file(imgpath, &n);
    if (!bytes || n == 0) { free(bytes); return NULL; }
    char *b64 = pdf_base64_encode((const unsigned char *)bytes, n);
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

/* Render a bounded set of already-selected PDF pages for the CURRENT model's
 * native image encoder.  Scanned/image-only pages come first, then selected
 * text pages so charts and layout can still be inspected.  This function does
 * no inference and never routes to a secondary model. */
static int pdf_render_native_pages(const char *pdfpath,
                                   const unsigned char *selected,
                                   const int *pvis, int tpages,
                                   int first, int last,
                                   int *page_numbers, char **uris,
                                   int *scanned_out) {
    if (scanned_out) *scanned_out = 0;
    char tool[256];
    if (!pdf_find_tool("pdftoppm", tool, sizeof tool)) return 0;
    char dir[] = "/tmp/dstudio-pdfvision-XXXXXX";
    if (!mkdtemp(dir)) return 0;
    int count = 0, scanned = 0;
    for (int pass = 0; pass < 2 && count < PDF_NATIVE_VISION_MAX_PAGES; pass++) {
        for (int i = first; i <= last && count < PDF_NATIVE_VISION_MAX_PAGES; i++) {
            if (!selected[i]) continue;
            int is_scanned = i >= tpages || pvis[i] < PDF_TEXT_MIN_CHARS;
            if ((pass == 0) != is_scanned) continue;
            char prefix[DSTUDIO_PATH_MAX], image[DSTUDIO_PATH_MAX];
            snprintf(prefix, sizeof prefix, "%s/page-%d", dir, i + 1);
            snprintf(image, sizeof image, "%s.jpg", prefix);
            if (!pdf_render(tool, pdfpath, prefix, i + 1, i + 1,
                            1100, 1, 1, 80)) {
                unlink(image);
                continue;
            }
            char *uri = pdf_img_data_uri(image);
            unlink(image);
            if (!uri) continue;
            page_numbers[count] = i + 1;
            uris[count++] = uri;
            if (is_scanned) scanned++;
        }
    }
    rmdir(dir);
    if (scanned_out) *scanned_out = scanned;
    return count;
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

static void pdf_cache_dir_path(char *out, size_t outsz) {
    const char *env = getenv("DSTUDIO_PDF_CACHE_DIR");
    if (env && env[0]) { cstr_copy(out, outsz, env); return; }
    const char *home = getenv("HOME");
    snprintf(out, outsz, "%s/.dstudio/pdf-cache", home ? home : ".");
}

static void pdf_cache_write(const char *cpath, const char *data, const char *suffix, int cap);
static void pdf_cache_prune_suffix(const char *dir, const char *suffix, int cap);
static void pdf_text_cache_path(unsigned long long docfnv, char *out, size_t outsz) {
    char dir[DSTUDIO_PATH_MAX];
    pdf_cache_dir_path(dir, sizeof dir);
    snprintf(out, outsz, "%s/text-v2-%016llx.pdftxt", dir, docfnv);
}

/* The page's extracted text layer via pdftotext (all pages, form-feed
 * separated), or NULL when pdftotext is missing/fails. -layout preserves
 * columns and table alignment, which the chat model reads far better. The
 * full layer is keyed only by document bytes, so a second question over the
 * same 1,000-page book does not rerun Poppler or reread megabytes from PDF.
 *
 * Write to a temporary file instead of capturing stdout: web_curl_capture is
 * intentionally capped at 768 KiB for web/API responses, while a 1,000-page
 * book commonly has several MiB of text. Treating that cap as extraction
 * failure made large, perfectly searchable PDFs look like an embedding-model
 * failure. */
static char *pdf_text_layer(const char *pdfpath, unsigned long long docfnv,
                            int *cache_hit) {
    if (cache_hit) *cache_hit = 0;
    char cpath[DSTUDIO_PATH_MAX];
    pdf_text_cache_path(docfnv, cpath, sizeof cpath);
    size_t cached_n = 0;
    char *cached = jsonl_read_file(cpath, &cached_n);
    if (cached && cached_n > 0) {
        (void)utimes(cpath, NULL);
        if (cache_hit) *cache_hit = 1;
        return cached;
    }
    free(cached);

    char tool[256];
    if (!pdf_find_tool("pdftotext", tool, sizeof tool)) return NULL;
    char tmpl[] = "/tmp/dstudio-pdftext-XXXXXX";
    int tf = mkstemp(tmpl);
    if (tf < 0) return NULL;
    close(tf);
    char *argv[] = { tool, "-layout", "-enc", "UTF-8", (char *)pdfpath, tmpl, NULL };
    int st = -1;
    char *diagnostic = web_curl_capture(argv, 180000, &st);
    free(diagnostic);
    size_t n = 0;
    char *text = st == 0 ? jsonl_read_file(tmpl, &n) : NULL;
    unlink(tmpl);
    if (!text || n == 0) { free(text); return NULL; }
    pdf_cache_write(cpath, text, ".pdftxt", PDF_TEXT_CACHE_MAX_FILES);
    return text;
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
    char dir[DSTUDIO_PATH_MAX];
    pdf_cache_dir_path(dir, sizeof dir);
    snprintf(out, outsz, "%s/emb-%016llx.ragbin", dir, docfnv);
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
    if (ok && rename(tmp, path) == 0)
        pdf_cache_prune_suffix(dir, ".ragbin", PDF_EMBED_CACHE_MAX_FILES);
    else
        unlink(tmp);
}


static int pdf_build_rag_chunks(const int *plen, int tpages, int npages,
                                pdf_rag_chunk **out) {
    *out = NULL;
    int n = 0, cap = npages > 0 ? npages * 2 : 8;
    pdf_rag_chunk *chunks = malloc((size_t)cap * sizeof *chunks);
    if (!chunks) return 0;
    const int stride = PDF_RAG_CHUNK_CHARS - PDF_RAG_CHUNK_OVERLAP;
    for (int page = 0; page < npages && page < tpages; page++) {
        int page_len = plen[page] > 0 ? plen[page] : 0;
        for (int start = 0; start < page_len; ) {
            int remain = page_len - start;
            int take = remain < PDF_RAG_CHUNK_CHARS ? remain : PDF_RAG_CHUNK_CHARS;
            /* Absorb a tiny tail instead of creating a nearly empty final
             * vector. The maximum window is CHUNK+OVERLAP. */
            if (remain > PDF_RAG_CHUNK_CHARS &&
                remain - PDF_RAG_CHUNK_CHARS <= PDF_RAG_CHUNK_OVERLAP)
                take = remain;
            if (n == cap) {
                int next = cap < 1024 ? cap * 2 : cap + cap / 2;
                pdf_rag_chunk *grown = realloc(chunks, (size_t)next * sizeof *grown);
                if (!grown) { free(chunks); return 0; }
                chunks = grown;
                cap = next;
            }
            chunks[n++] = (pdf_rag_chunk){ page, start, take };
            if (start + take >= page_len) break;
            start += stride;
        }
    }
    if (!n) { free(chunks); return 0; }
    *out = chunks;
    return n;
}

static char *pdf_rag_chunk_text(const char *const *pstart, const int *plen,
                                int tpages, const pdf_rag_chunk *chunk) {
    int page = chunk->page;
    int prev_start = 0, prev_take = 0;
    if (page > 0 && page - 1 < tpages && plen[page - 1] > 0) {
        int raw_take = plen[page - 1] < PDF_RAG_CROSS_PAGE_CHARS
            ? plen[page - 1] : PDF_RAG_CROSS_PAGE_CHARS;
        prev_start = plen[page - 1] - raw_take;
        prev_start = (int)pdf_utf8_safe_start(pstart[page - 1],
                                               (size_t)prev_start,
                                               (size_t)plen[page - 1]);
        prev_take = plen[page - 1] - prev_start;
    }
    int next_take = page + 1 < tpages && plen[page + 1] > 0 ? plen[page + 1] : 0;
    if (next_take > PDF_RAG_CROSS_PAGE_CHARS) {
        next_take = (int)pdf_utf8_safe_end(pstart[page + 1],
                                           PDF_RAG_CROSS_PAGE_CHARS);
    }
    int body_start = chunk->start < plen[page] ? chunk->start : plen[page];
    body_start = (int)pdf_utf8_safe_start(pstart[page], (size_t)body_start,
                                          (size_t)plen[page]);
    int raw_end = chunk->start + chunk->len;
    if (raw_end > plen[page]) raw_end = plen[page];
    int body_end = (int)pdf_utf8_safe_end(pstart[page], (size_t)raw_end);
    if (body_end < body_start) body_end = body_start;
    int body_take = body_end - body_start;
    size_t need = (size_t)prev_take + (size_t)body_take + (size_t)next_take + 160;
    char *text = malloc(need);
    if (!text) return NULL;
    size_t off = 0;
    if (prev_take) {
        int h = snprintf(text + off, need - off, "Previous page tail:\n");
        if (h < 0) { free(text); return NULL; }
        off += (size_t)h;
        memcpy(text + off, pstart[page - 1] + prev_start, (size_t)prev_take);
        off += (size_t)prev_take;
    }
    int h = snprintf(text + off, need - off, "\nPhysical PDF page %d passage:\n", page + 1);
    if (h < 0 || (size_t)h >= need - off) { free(text); return NULL; }
    off += (size_t)h;
    memcpy(text + off, pstart[page] + body_start, (size_t)body_take);
    off += (size_t)body_take;
    if (next_take) {
        h = snprintf(text + off, need - off, "\nNext page head:\n");
        if (h < 0 || (size_t)h >= need - off) { free(text); return NULL; }
        off += (size_t)h;
        memcpy(text + off, pstart[page + 1], (size_t)next_take);
        off += (size_t)next_take;
    }
    text[off] = '\0';
    return text;
}

static int pdf_rag_token_byte(unsigned char c) {
    return c >= 0x80 || isalnum(c) || c == '_';
}

static int pdf_rag_terms(const char *query, pdf_rag_term *terms, int cap) {
    int n = 0;
    const unsigned char *p = (const unsigned char *)query;
    while (*p && n < cap) {
        while (*p && !pdf_rag_token_byte(*p)) p++;
        const unsigned char *start = p;
        while (*p && pdf_rag_token_byte(*p)) p++;
        int raw_len = (int)(p - start);
        if (raw_len < 2) continue;
        int len = raw_len < (int)sizeof terms[0].text - 1
            ? raw_len : (int)sizeof terms[0].text - 1;
        char word[sizeof terms[0].text];
        for (int i = 0; i < len; i++) {
            unsigned char c = start[i];
            word[i] = c < 0x80 ? (char)tolower(c) : (char)c;
        }
        word[len] = '\0';
        int duplicate = 0;
        for (int i = 0; i < n; i++)
            if (terms[i].len == len && !memcmp(terms[i].text, word, (size_t)len)) duplicate = 1;
        if (!duplicate) {
            memcpy(terms[n].text, word, (size_t)len + 1);
            terms[n].len = len;
            terms[n].df = 0;
            n++;
        }
    }
    return n;
}

/* Count every query term in one tokenization pass. The previous implementation
 * rescanned each chunk once per term for document frequency and then again for
 * BM25 (up to 32 full scans). This preserves the same whole-token matching and
 * ASCII case folding, but records all term frequencies and first offsets at
 * once. */
static void pdf_rag_term_counts(const char *text, int len,
                                const pdf_rag_term *terms, int nterms,
                                int *counts, int *firsts) {
    for (int t = 0; t < nterms; t++) { counts[t] = 0; firsts[t] = -1; }
    for (int i = 0; i < len; ) {
        while (i < len && !pdf_rag_token_byte((unsigned char)text[i])) i++;
        int start = i;
        while (i < len && pdf_rag_token_byte((unsigned char)text[i])) i++;
        int token_len = i - start;
        if (!token_len) continue;
        for (int t = 0; t < nterms; t++) {
            if (token_len != terms[t].len) continue;
            int same = 1;
            for (int k = 0; k < token_len; k++) {
                unsigned char c = (unsigned char)text[start + k];
                char folded = c < 0x80 ? (char)tolower(c) : (char)c;
                if (folded != terms[t].text[k]) { same = 0; break; }
            }
            if (!same) continue;
            if (firsts[t] < 0) firsts[t] = start;
            counts[t]++;
        }
    }
}

/* Try the largest measured Metal batch first. If unusually token-dense text
 * exceeds llama-server's 8K physical batch, bisect it until it fits. This
 * preserves the exact vector order and quality while avoiding the old
 * all-the-way-to-singletons fallback for one oversized work item. */
static int pdf_embed_rag_batch(char *const *texts, int count, float *out, int dim) {
    int got_dim = 0;
    if (embed_call(texts, count, NULL, out, dim, &got_dim) && got_dim == dim)
        return 1;
    if (count <= 1) return 0;
    int left = count / 2;
    return pdf_embed_rag_batch(texts, left, out, dim) &&
           pdf_embed_rag_batch(texts + left, count - left,
                               out + (size_t)left * (size_t)dim, dim);
}

/* Hybrid retrieval: dense chunk cosine supplies semantic recall; a compact
 * BM25 signal recovers exact names, formulas and identifiers. Page scores are
 * the strongest owning chunk and matches[] points at that chunk's relevant
 * region, so prompt excerpts center on evidence rather than page headers. */
static int pdf_hybrid_page_scores(unsigned long long docfnv,
                                  const char *const *pstart, const int *plen,
                                  int tpages, int npages, const char *query,
                                  int *scores, int *matches, int *chunks_out,
                                  int *index_cache_hit) {
    if (chunks_out) *chunks_out = 0;
    if (index_cache_hit) *index_cache_hit = 0;
    if (!query || !query[0] || npages <= 0) return 0;
    pdf_rag_chunk *chunks = NULL;
    int nchunks = pdf_build_rag_chunks(plen, tpages, npages, &chunks);
    if (!nchunks) return 0;
    if (chunks_out) *chunks_out = nchunks;
    embed_touch_last_use();
    if (!embed_ensure_server(60000)) { free(chunks); return 0; }

    static const char *prefix =
        "Instruct: Given a user question, retrieve the document passages that contain the answer.\nQuery: ";
    float qv[EMBED_MAX_DIM];
    char *queries[1] = { (char *)query };
    int dim = 0;
    /* The real query already reveals the model dimension. The old separate
     * "document passage" probe spent an extra GPU request on every search. */
    if (!embed_call(queries, 1, prefix, qv, EMBED_MAX_DIM, &dim) ||
        dim <= 0 || dim > EMBED_MAX_DIM) { free(chunks); return 0; }

    char model[128];
    embed_hf_pref(model, sizeof model);
    pdf_embed_index_hdr want = { PDF_EMBED_INDEX_MAGIC, dim, nchunks, docfnv, {0} };
    cstr_copy(want.model, sizeof want.model, model);
    float *vecs = pdf_embed_index_load(&want);
    if (vecs && index_cache_hit) *index_cache_hit = 1;
    if (!vecs) {
        vecs = malloc((size_t)nchunks * (size_t)dim * sizeof *vecs);
        if (!vecs) { free(chunks); return 0; }
        for (int start = 0; start < nchunks; start += PDF_RAG_EMBED_BATCH) {
            int count = nchunks - start < PDF_RAG_EMBED_BATCH
                ? nchunks - start : PDF_RAG_EMBED_BATCH;
            char *texts[PDF_RAG_EMBED_BATCH] = {0};
            int alloc_ok = 1;
            for (int j = 0; j < count; j++) {
                texts[j] = pdf_rag_chunk_text(pstart, plen, tpages, &chunks[start + j]);
                if (!texts[j]) { alloc_ok = 0; break; }
            }
            int embedded = alloc_ok && pdf_embed_rag_batch(
                texts, count, vecs + (size_t)start * (size_t)dim, dim);
            for (int j = 0; j < count; j++) free(texts[j]);
            if (!embedded) { free(vecs); free(chunks); return 0; }
            embed_touch_last_use();
        }
        pdf_embed_index_save(&want, vecs);
    }

    pdf_rag_term terms[PDF_RAG_MAX_QUERY_TERMS] = {0};
    int nterms = pdf_rag_terms(query, terms, PDF_RAG_MAX_QUERY_TERMS);
    size_t term_cells = (size_t)nchunks * (size_t)(nterms > 0 ? nterms : 1);
    int *term_tf = calloc(term_cells, sizeof *term_tf);
    int *term_first = malloc(term_cells * sizeof *term_first);
    if (!term_tf || !term_first) {
        free(term_tf); free(term_first); free(vecs); free(chunks); return 0;
    }
    for (int c = 0; c < nchunks; c++) {
        const pdf_rag_chunk *chunk = &chunks[c];
        const char *body = pstart[chunk->page] + chunk->start;
        int *tf = term_tf + (size_t)c * (size_t)(nterms > 0 ? nterms : 1);
        int *first = term_first + (size_t)c * (size_t)(nterms > 0 ? nterms : 1);
        pdf_rag_term_counts(body, chunk->len, terms, nterms, tf, first);
        for (int t = 0; t < nterms; t++) if (tf[t] > 0) terms[t].df++;
    }
    double avg_len = 0;
    for (int c = 0; c < nchunks; c++) avg_len += chunks[c].len;
    avg_len = nchunks ? avg_len / nchunks : PDF_RAG_CHUNK_CHARS;
    double *lexical = calloc((size_t)nchunks, sizeof *lexical);
    int *lex_match = malloc((size_t)nchunks * sizeof *lex_match);
    if (!lexical || !lex_match) {
        free(lexical); free(lex_match); free(term_tf); free(term_first);
        free(vecs); free(chunks); return 0;
    }
    double max_lexical = 0;
    for (int c = 0; c < nchunks; c++) {
        const pdf_rag_chunk *chunk = &chunks[c];
        int *tf = term_tf + (size_t)c * (size_t)(nterms > 0 ? nterms : 1);
        int *first = term_first + (size_t)c * (size_t)(nterms > 0 ? nterms : 1);
        lex_match[c] = -1;
        for (int t = 0; t < nterms; t++) {
            if (!tf[t]) continue;
            if (lex_match[c] < 0 || first[t] < lex_match[c]) lex_match[c] = first[t];
            double idf = log(1.0 + ((double)nchunks - terms[t].df + 0.5) /
                                   (terms[t].df + 0.5));
            double norm = 1.2 * (0.25 + 0.75 * chunk->len / (avg_len > 1 ? avg_len : 1));
            lexical[c] += idf * (tf[t] * 2.2) / (tf[t] + norm);
        }
        if (lexical[c] > max_lexical) max_lexical = lexical[c];
    }

    for (int i = 0; i < npages; i++) { scores[i] = INT_MIN; matches[i] = -1; }
    for (int c = 0; c < nchunks; c++) {
        const float *v = vecs + (size_t)c * (size_t)dim;
        double dot = 0;
        for (int k = 0; k < dim; k++) dot += (double)qv[k] * v[k];
        int semantic = (int)(dot * 1000000.0);
        int lexical_bonus = max_lexical > 0
            ? (int)(220000.0 * lexical[c] / max_lexical) : 0;
        int combined = semantic + lexical_bonus;
        int page = chunks[c].page;
        if (combined > scores[page]) {
            scores[page] = combined;
            int at = lex_match[c] >= 0 ? lex_match[c] : chunks[c].len / 2;
            matches[page] = chunks[c].start + at;
        }
    }
    free(lexical);
    free(lex_match);
    free(term_tf);
    free(term_first);
    free(vecs);
    free(chunks);
    embed_touch_last_use();
    return 1;
}

/* Targeted hybrid reads choose three non-adjacent evidence anchors when
 * possible, then spend remaining slots on their immediate neighbors. This
 * avoids wasting every primary hit on consecutive pages while retaining the
 * local continuity needed for a paragraph or proof spanning a page break. */
static int pdf_select_semantic_pages(unsigned char *selected, const int *scores,
                                     int first, int last, int limit) {
    memset(selected, 0, PDF_MAX_TOTAL_PAGES);
    int count = last - first + 1;
    if (limit > count) limit = count;
    if (limit < 1) return 0;
    int primary[PDF_SEMANTIC_MAX_PAGES];
    int nprimary = 0;
    int primary_cap = limit < 3 ? limit : 3;
    while (nprimary < primary_cap) {
        int best = -1, best_score = INT_MIN;
        /* First pass prefers a distinct evidence cluster. */
        for (int pass = 0; pass < 2 && best < 0; pass++) {
            for (int i = first; i <= last; i++) {
                if (selected[i] || scores[i] == INT_MIN) continue;
                int adjacent = 0;
                for (int p = 0; p < nprimary; p++)
                    if (abs(i - primary[p]) <= 1) adjacent = 1;
                if (pass == 0 && adjacent) continue;
                if (scores[i] > best_score) {
                    best = i;
                    best_score = scores[i];
                }
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
    /* Very short documents or edge anchors may leave spare slots. Fill them
     * by global hybrid score instead of returning fewer useful pages. */
    while (selected_count < limit) {
        int best = -1, best_score = INT_MIN;
        for (int i = first; i <= last; i++) {
            if (!selected[i] && scores[i] != INT_MIN && scores[i] > best_score) {
                best = i;
                best_score = scores[i];
            }
        }
        if (best < 0) break;
        selected[best] = 1;
        selected_count++;
    }
    return selected_count;
}

/* Describe cache: ~/.dstudio/pdf-cache/<fnv16>.json holds a successful text
 * read. Overview reads include their content budget; semantic reads also
 * include the retrieval query. Stores are pruned oldest-first per suffix. */
#define PDF_CACHE_MAX_FILES 32
static void pdf_cache_path(unsigned long long key, char *out, size_t outsz) {
    char dir[DSTUDIO_PATH_MAX];
    pdf_cache_dir_path(dir, sizeof dir);
    snprintf(out, outsz, "%s/%016llx.json", dir, key);
}

static void pdf_cache_prune_suffix(const char *dir, const char *suffix, int cap) {
    /* Tiny per-user cache directory: a direct oldest-first scan is simpler
     * and more robust than maintaining a separate mutable catalog. */
    size_t sl = strlen(suffix);
    for (int guard = 0; guard < 64; guard++) {
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
            if (!oldest[0] || st.st_mtime < oldest_t) {
                oldest_t = st.st_mtime;
                cstr_copy(oldest, sizeof oldest, p);
            }
        }
        closedir(d);
        if (count <= cap || !oldest[0]) return;
        unlink(oldest);
    }
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
    if (rename(tmp, cpath) == 0) pdf_cache_prune_suffix(dir, suffix, cap);
    else unlink(tmp);
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

#include "dstudio_pdf_evidence.c"

/* POST /api/pdf/describe — text layer plus optional semantic retrieval. */
static void api_pdf_describe_run(int fd, const char *body, int allow_path) {
    char fmt[16] = "";
    (void)json_get_string(body, "format", fmt, sizeof fmt);
    int want_text = !strcmp(fmt, "text");
    /* UI-only request: return rendered selected pages to the model already in
     * use.  The folder-scoped read_pdf tool remains text-only. */
    int native_vision = !want_text && json_get_bool(body, "native_vision");

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
     * how a caller reaches pages past the context caps of a long document.
     * rq_last 0 = to the end. */
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

    char texttool[256];
    if (!pdf_find_tool("pdftotext", texttool, sizeof texttool)) {
        pdf_describe_fail(fd, want_text, "503 Service Unavailable", pdf_poppler_hint());
        return;
    }
    char jobid[64] = "", jobpath[DSTUDIO_PATH_MAX] = "";
    if (json_get_string(body, "job", jobid, sizeof jobid) && jobid[0])
        (void)pdf_job_path(jobid, jobpath, sizeof jobpath);

    int forbidden = 0;
    unsigned long long docfnv = 0;
    char *pdf = pdf_write_temp(body, allow_path, &forbidden, &docfnv);
    if (forbidden) { pdf_describe_fail(fd, want_text, "403 Forbidden", "path is host-local only; send data_uri"); return; }
    if (!pdf) { pdf_describe_fail(fd, want_text, "400 Bad Request", "a PDF (data_uri or host-local path) is required"); return; }
    /* Retained originals are host-local, like chat history. LAN uploads keep
     * their existing inline-only behavior and cannot inspect this cache. */
    int evidence = !want_text && allow_path && json_get_bool(body, "evidence");
    char document_id[65] = "";
    if (evidence && !pdf_document_id(pdf, document_id)) evidence = 0;
    pdf_job_write(jobpath, "{\"phase\":\"start\",\"done\":false}");

    /* Cache lookup — overview/full reads are question-independent. Semantic
     * reads include the model-produced retrieval query; embedding indexes stay
     * reusable across questions. */
    unsigned long long key = docfnv;
    {
        /* Bump this salt on ANY pipeline-behavior change (thresholds, prompts,
         * classification): cached entries carry the OLD behavior and would
         * silently mask the fix for already-seen documents. */
        static const char *salt = "|text-native-v3-pdf-evidence-structure|";
        for (const char *s = salt; *s; s++)     { key ^= (unsigned char)*s; key *= 1099511628211ULL; }
        for (const char *s = document_id; *s; s++) { key ^= (unsigned char)*s; key *= 1099511628211ULL; }
        if (interactive) {
            static const char *ip = "|interactive-adaptive|";
            for (const char *s = ip; *s; s++)       { key ^= (unsigned char)*s; key *= 1099511628211ULL; }
            key ^= (unsigned long long)interactive_cap; key *= 1099511628211ULL;
        }
        if (semantic) {
            static const char *sp = "|hybrid-rag|";
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
    if (!native_vision) {
        size_t cn = 0;
        char *cached = jsonl_read_file(cpath, &cn);
        char cached_id[80] = "";
        if (cached) (void)json_get_string(cached, "documentId", cached_id, sizeof cached_id);
        if (cached && cn > 2 && cached[0] == '{' &&
            (!evidence || (!strcmp(cached_id, document_id) && pdf_source_store(pdf, document_id)))) {
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
    char pdfinfo[256];
    if (pdf_find_tool("pdfinfo", pdfinfo, sizeof pdfinfo)) {
        char *ia[] = { pdfinfo, pdf, NULL };
        int ist = 0; char *iout = web_curl_capture(ia, 20000, &ist);
        if (iout) {
            const char *p = strstr(iout, "Pages:");
            if (p) { int v = atoi(p + 6); if (v > 0) total = v; }
            free(iout);
        }
    }

    /* Text layer, split per page on pdftotext's form-feeds. pvis[] counts the
     * VISIBLE characters of each page: a page under PDF_TEXT_MIN_CHARS has no
     * usable text layer and is reported as a scanned/image-only page. */
    pdf_job_write(jobpath, "{\"phase\":\"text\",\"done\":false}");
    int text_layer_cached = 0;
    char *layer = pdf_text_layer(pdf, docfnv, &text_layer_cached);
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
     * hybrid search. Overview uses deterministic whole-book coverage; targeted
     * mode ranks overlapping passages with embeddings + BM25. Explicit Agent
     * read_pdf ranges keep the full/read-verbatim behavior. */
    static int pscore[PDF_MAX_TOTAL_PAGES], pmatch[PDF_MAX_TOTAL_PAGES];
    static unsigned char page_selected[PDF_MAX_TOTAL_PAGES];
    memset(pscore, 0, sizeof pscore);
    for (int i = 0; i < PDF_MAX_TOTAL_PAGES; i++) pmatch[i] = -1;
    memset(page_selected, interactive ? 0 : 1, sizeof page_selected);
    int selected_pages = plast - pfirst + 1, rag_chunks = 0;
    int embedding_index_cached = 0;
    if (semantic) {
        pdf_job_write(jobpath, "{\"phase\":\"semantic\",\"done\":false}");
        if (!pdf_hybrid_page_scores(docfnv, pstart, plen, tpages, npages,
                                    semantic_query, pscore, pmatch, &rag_chunks,
                                    &embedding_index_cached)) {
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

    /* No secondary vision model is used. Count selected pages that have no
     * usable text layer so callers can tell a scanned document from an empty
     * or failed extraction. Native multimodal models may inspect explicitly
     * attached rendered pages through their own encoder, outside this reader. */
    int scanned_pages = 0;
    for (int i = pfirst - 1; i < plast; i++) {
        if (!page_selected[i]) continue;
        if (i >= tpages || pvis[i] < PDF_TEXT_MIN_CHARS) scanned_pages++;
    }
    char *vision_uris[PDF_NATIVE_VISION_MAX_PAGES] = {0};
    int vision_page_numbers[PDF_NATIVE_VISION_MAX_PAGES] = {0};
    int vision_scanned_pages = 0;
    int vision_pages = native_vision
        ? pdf_render_native_pages(pdf, page_selected, pvis, tpages,
                                  pfirst - 1, plast - 1,
                                  vision_page_numbers, vision_uris,
                                  &vision_scanned_pages)
        : 0;
    json_dyn_buf text = {0};
    int ok = 1, text_used = 0, text_skipped = 0, text_partial = 0;
    int pages_omitted = (plast - pfirst + 1) - selected_pages;
    size_t text_bytes = 0;
    size_t content_cap = interactive ? interactive_cap : PDF_TEXT_TOTAL_CAP;
    size_t text_cap = content_cap;
    int total_weight = 0, semantic_min = INT_MAX, semantic_max = INT_MIN;
    if (semantic) {
        for (int i = pfirst - 1; i < plast; i++) {
            if (!page_selected[i] || pscore[i] == INT_MIN) continue;
            if (pscore[i] < semantic_min) semantic_min = pscore[i];
            if (pscore[i] > semantic_max) semantic_max = pscore[i];
        }
    }
    for (int i = pfirst - 1; i < plast; i++) {
        if (!page_selected[i] || i >= tpages || pvis[i] < PDF_TEXT_MIN_CHARS) continue;
        int weight = 1;
        if (semantic && pscore[i] != INT_MIN) {
            weight += 2;
            if (semantic_max > semantic_min)
                weight += (int)(3LL * (pscore[i] - semantic_min) /
                                (semantic_max - semantic_min));
        } else if (!semantic) {
            if (i == pfirst - 1) weight += 5;
            else if (i == pfirst || i == plast - 1) weight += 1;
        }
        total_weight += weight;
    }
    for (int i = pfirst - 1; ok && i < plast; i++) {
        if (!page_selected[i]) continue;
        int is_text = (i < tpages && pvis[i] >= PDF_TEXT_MIN_CHARS);
        if (!is_text) continue;
        size_t take = (size_t)plen[i];
        if (interactive && total_weight > 0) {
            int weight = 1;
            if (semantic && pscore[i] != INT_MIN) {
                weight += 2;
                if (semantic_max > semantic_min)
                    weight += (int)(3LL * (pscore[i] - semantic_min) /
                                    (semantic_max - semantic_min));
            } else if (!semantic) {
                if (i == pfirst - 1) weight += 5;
                else if (i == pfirst || i == plast - 1) weight += 1;
            }
            take = text_cap * (size_t)weight / (size_t)total_weight;
            if (take < 32) take = 32;
            if (take > (size_t)plen[i]) take = (size_t)plen[i];
        } else {
            if (text_bytes >= text_cap) { text_skipped++; continue; }
            if (text_bytes + take > text_cap) take = text_cap - text_bytes;
        }
        int excerpt_match = pmatch[i];
        if (!semantic && i == pfirst - 1 && excerpt_match < 0) excerpt_match = 0;
        ok = json_dyn_printf(&text, "\n--- Pagina %d (testo) ---\n", i + 1) &&
             pdf_append_page_excerpt(&text, pstart[i], (size_t)plen[i], take, excerpt_match) &&
             json_dyn_puts(&text, "\n");
        text_bytes += take;
        text_used++;
        if (take < (size_t)plen[i]) text_partial++;
    }
    int pages_read = text_used;
    int range_partial = has_range ? (pfirst > 1 || plast < total) : (total > npages);
    int sampled = interactive && (pages_omitted > 0 || text_partial > 0);
    int truncated = scanned_pages > 0 || text_skipped > 0 || range_partial || sampled;
    if (ok && scanned_pages > 0) {
        if (vision_scanned_pages > 0)
            ok = json_dyn_printf(&text,
                "\n[%d pagine scansionate o solo-immagine senza livello testuale; "
                "%d selezionate e renderizzate per la visione nativa del modello.]\n",
                scanned_pages, vision_scanned_pages);
        else
            ok = json_dyn_printf(&text,
                "\n[%d pagine scansionate o solo-immagine omesse: nessun livello testuale disponibile.]\n",
                scanned_pages);
    }
    if (ok && text_skipped > 0)
        ok = json_dyn_printf(&text, "\n[Testo troncato: %d pagine di testo oltre il limite di %dKB omesse.]\n",
                             text_skipped, (int)(text_cap / 1024));
    if (ok && sampled && semantic)
        ok = json_dyn_printf(&text,
            "\n[Ricerca ibrida PDF: valutati %d passaggi sovrapposti; lette %d pagine candidate "
            "su %d, %zu caratteri di contenuto.]\n",
            rag_chunks, selected_pages, plast - pfirst + 1, text_bytes);
    else if (ok && sampled)
        ok = json_dyn_printf(&text,
            "\n[Contesto PDF adattivo: %d pagine rappresentative su %d, %zu caratteri di contenuto; "
            "estratti distribuiti tra inizio e fine del documento.]\n",
            selected_pages, plast - pfirst + 1, text_bytes);
    if (ok && has_range)
        ok = json_dyn_printf(&text, "\n[Intervallo letto: pagine %d-%d di %d totali.]\n", pfirst, plast, total);
    else if (ok && total > npages)
        ok = json_dyn_printf(&text, "\n[PDF troncato alle prime %d di %d pagine.]\n", npages, total);

    json_dyn_buf sections = {0}, section_links = {0};
    if (evidence) {
        evidence = pdf_source_store(pdf, document_id);
        if (evidence) ok = ok && pdf_section_hints(&sections, &section_links, pstart, plen, tpages);
    }
    free(layer);
    unlink(pdf); free(pdf);

    if (!ok) {
        for (int i = 0; i < vision_pages; i++) free(vision_uris[i]);
        free(text.ptr); free(sections.ptr); free(section_links.ptr);
        pdf_job_write(jobpath, "{\"phase\":\"error\",\"done\":true}");
        pdf_describe_fail(fd, want_text, "500 Internal Server Error", "oom");
        return;
    }
    json_dyn_buf out = {0};
    size_t vision_chars = 0;
    for (int i = 0; i < vision_pages; i++) vision_chars += strlen(vision_uris[i]);
    int good = json_dyn_printf(&out, "{\"ok\":true,\"pages\":%d,\"total\":%d,\"first\":%d,\"last\":%d,"
                                     "\"textPages\":%d,\"scannedPages\":%d,\"visionPages\":%d,\"visionScannedPages\":%d,\"figPages\":0,"
                                     "\"selectedPages\":%d,\"retrievalChunks\":%d,"
                                     "\"textLayerCached\":%s,\"embeddingIndexCached\":%s,"
                                     "\"textChars\":%zu,\"visionChars\":%zu,\"contentChars\":%zu,"
                                     "\"semantic\":%s,\"hybrid\":%s,\"sampled\":%s,\"truncated\":%s,\"text\":",
                               pages_read, total, pfirst, plast, text_used, scanned_pages,
                               vision_pages, vision_scanned_pages,
                               selected_pages, rag_chunks,
                               text_layer_cached ? "true" : "false",
                               embedding_index_cached ? "true" : "false",
                               text_bytes, vision_chars, text_bytes + vision_chars,
                               semantic ? "true" : "false", semantic ? "true" : "false", sampled ? "true" : "false",
                               truncated ? "true" : "false") &&
               json_dyn_put_escaped(&out, text.ptr ? text.ptr : "") &&
               json_dyn_puts(&out, ",\"vision\":[");
    for (int i = 0; good && i < vision_pages; i++) {
        if (i) good = json_dyn_puts(&out, ",");
        if (good) good = json_dyn_printf(&out, "{\"page\":%d,\"image\":", vision_page_numbers[i]) &&
                         json_dyn_put_escaped(&out, vision_uris[i]) &&
                         json_dyn_puts(&out, "}");
    }
    if (good) good = json_dyn_puts(&out, "],\"documentId\":") &&
                     (evidence ? json_dyn_put_escaped(&out, document_id) : json_dyn_puts(&out, "null")) &&
                     json_dyn_puts(&out, ",\"sections\":") && json_dyn_puts(&out, sections.ptr ? sections.ptr : "[]") &&
                     json_dyn_puts(&out, ",\"sectionLinks\":") && json_dyn_puts(&out, section_links.ptr ? section_links.ptr : "[]") &&
                     json_dyn_puts(&out, "}");
    free(sections.ptr); free(section_links.ptr);
    if (!good) {
        for (int i = 0; i < vision_pages; i++) free(vision_uris[i]);
        free(text.ptr); free(out.ptr);
        pdf_job_write(jobpath, "{\"phase\":\"error\",\"done\":true}");
        pdf_describe_fail(fd, want_text, "500 Internal Server Error", "oom");
        return;
    }
    if (!native_vision && pages_read > 0)
        pdf_cache_write(cpath, out.ptr, ".json", PDF_CACHE_MAX_FILES);
    pdf_job_write(jobpath, "{\"phase\":\"done\",\"done\":true}");
    if (want_text) send_text(fd, "200 OK", text.ptr && text.ptr[0] ? text.ptr : "(empty PDF)", 0);
    else           send_json(fd, "200 OK", out.ptr);
    free(text.ptr);
    free(out.ptr);
    for (int i = 0; i < vision_pages; i++) free(vision_uris[i]);
}

/* Fork a detached worker because Poppler extraction and embedding can be slow. */
static void api_pdf_fork(int fd, const char *body, int is_describe, int allow_path) {
    pid_t pid = fork();
    if (pid < 0) {
        if (is_describe == 2) api_pdf_evidence_run(fd, body);
        else if (is_describe) api_pdf_describe_run(fd, body, allow_path);
        else api_pdf_thumb_run(fd, body, allow_path);
        return;
    }
    if (pid == 0) {
        if (fork() > 0) _exit(0);
        if (g_srv_fd >= 0) close(g_srv_fd);
        if (g_out_fd >= 0) close(g_out_fd);
        if (g_err_fd >= 0) close(g_err_fd);
        if (g_in_fd  >= 0) close(g_in_fd);
        struct timeval tv = { 620, 0 };
        (void)setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof tv);
        if (is_describe == 2) api_pdf_evidence_run(fd, body);
        else if (is_describe) api_pdf_describe_run(fd, body, allow_path);
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
    api_pdf_fork(fd, body, 1, client_is_loopback(fd));
#endif
}

static void api_pdf_evidence(int fd, const char *body) {
#ifdef _WIN32
    (void)body;
    web_json_error(fd, "501 Not Implemented", "PDF is not available on the Windows build yet");
#else
    if (!client_is_loopback(fd)) { web_json_error(fd, "403 Forbidden", "PDF evidence is host-local only"); return; }
    api_pdf_fork(fd, body, 2, 0);
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

/* NanoIndex-inspired evidence, without a second model or a hosted OCR service.
 * Included by dstudio_pdf.c. Coordinates and quotations come from Poppler,
 * never from the answer. A unique exact whitespace-normalized match is the
 * only status that permits highlighting. This does NOT verify an assertion.
 */
#define PDF_EVIDENCE_WORDS 20000
#define PDF_SOURCE_CACHE_BYTES (2LL * 1024 * 1024 * 1024)

static int pdf_document_id(const char *pdf, char id[65]) {
    char tool[256];
    int sha = pdf_find_tool("sha256sum", tool, sizeof tool);
    if (!sha && !pdf_find_tool("shasum", tool, sizeof tool)) return 0;
    char *a[] = {tool, (char *)pdf, NULL};
    char *b[] = {tool, "-a", "256", (char *)pdf, NULL};
    int st = -1;
    char *out = web_curl_capture(sha ? a : b, 120000, &st);
    int ok = out && st == 0 && strlen(out) > 64 && out[64] == ' ';
    for (int i = 0; ok && i < 64; i++)
        if (!((out[i] >= '0' && out[i] <= '9') || (out[i] >= 'a' && out[i] <= 'f'))) ok = 0;
    if (ok) { memcpy(id, out, 64); id[64] = 0; }
    free(out);
    return ok;
}

static int pdf_source_path(const char *id, char *out, size_t cap) {
    if (!id || strlen(id) != 64) return 0;
    for (int i = 0; i < 64; i++)
        if (!((id[i] >= '0' && id[i] <= '9') || (id[i] >= 'a' && id[i] <= 'f'))) return 0;
    char dir[DSTUDIO_PATH_MAX];
    pdf_cache_dir_path(dir, sizeof dir);
    return (size_t)snprintf(out, cap, "%s/%s.source.pdf", dir, id) < cap;
}

/* Bound retained originals by both count and bytes. Only our exact suffix is
 * pruned; text/embedding caches and the user's source files are untouched. */
static void pdf_source_prune(const char *keep) {
    char dir[DSTUDIO_PATH_MAX];
    pdf_cache_dir_path(dir, sizeof dir);
    for (int pass = 0; pass < 64; pass++) {
        DIR *d = opendir(dir);
        if (!d) return;
        long long bytes = 0;
        int count = 0;
        time_t oldest_t = 0;
        char oldest[DSTUDIO_PATH_MAX] = "";
        struct dirent *e;
        while ((e = readdir(d))) {
            if (strlen(e->d_name) != 75 || strcmp(e->d_name + 64, ".source.pdf")) continue;
            char p[DSTUDIO_PATH_MAX];
            if ((size_t)snprintf(p, sizeof p, "%s/%s", dir, e->d_name) >= sizeof p) continue;
            struct stat st;
            if (lstat(p, &st) || !S_ISREG(st.st_mode)) continue;
            bytes += st.st_size; count++;
            if (strcmp(p, keep) && (!oldest[0] || st.st_mtime < oldest_t)) {
                oldest_t = st.st_mtime; cstr_copy(oldest, sizeof oldest, p);
            }
        }
        closedir(d);
        if ((count <= 32 && bytes <= PDF_SOURCE_CACHE_BYTES) || !oldest[0]) return;
        unlink(oldest);
    }
}

static int pdf_source_store(const char *pdf, const char *id) {
    char dest[DSTUDIO_PATH_MAX], dir[DSTUDIO_PATH_MAX];
    if (!pdf_source_path(id, dest, sizeof dest)) return 0;
    cstr_copy(dir, sizeof dir, dest);
    *strrchr(dir, '/') = 0;
    char parent[DSTUDIO_PATH_MAX]; cstr_copy(parent, sizeof parent, dir);
    char *slash = strrchr(parent, '/');
    if (slash) { *slash = 0; (void)mkdir(parent, 0700); }
    (void)mkdir(dir, 0700);
    struct stat st;
    char existing_id[65] = "";
    if (!lstat(dest, &st) && S_ISREG(st.st_mode) && pdf_document_id(dest, existing_id) && !strcmp(existing_id, id)) {
        (void)utimes(dest, NULL); pdf_source_prune(dest); return 1;
    }
    char tmp[DSTUDIO_PATH_MAX + 16];
    snprintf(tmp, sizeof tmp, "%s.XXXXXX", dest);
    int out = mkstemp(tmp), in = open(pdf, O_RDONLY);
    int ok = out >= 0 && in >= 0;
    char buf[65536]; ssize_t n;
    while (ok && (n = read(in, buf, sizeof buf)) != 0) {
        if (n < 0) { if (errno == EINTR) continue; ok = 0; break; }
        ssize_t off = 0;
        while (off < n) {
            ssize_t w = write(out, buf + off, (size_t)(n - off));
            if (w < 0 && errno == EINTR) continue;
            if (w <= 0) { ok = 0; break; }
            off += w;
        }
    }
    if (in >= 0) close(in);
    if (out >= 0 && close(out)) ok = 0;
    if (ok) ok = rename(tmp, dest) == 0;
    if (!ok) unlink(tmp);
    else pdf_source_prune(dest);
    return ok;
}

typedef struct { char title[161], number[32]; int page, kind, level; } pdf_section_hint;

static int pdf_section_number(const char *p, const char *end, char number[32], int *level) {
    const char *start = p;
    *level = 1;
    if (p >= end || !isdigit((unsigned char)*p)) return 0;
    while (p < end && isdigit((unsigned char)*p)) p++;
    while (end - p > 1 && *p == '.' && isdigit((unsigned char)p[1])) {
        p++; (*level)++;
        while (p < end && isdigit((unsigned char)*p)) p++;
    }
    if (p - start >= 32 || (p < end && isalnum((unsigned char)*p))) return 0;
    memcpy(number, start, (size_t)(p - start)); number[p - start] = 0;
    return (int)(p - start);
}

/* Deterministic, explicitly labelled heading hints and explicit "see section"
 * edges, not an invented semantic graph. Ambiguous targets produce no edge. */
static int pdf_section_hints(json_dyn_buf *out, json_dyn_buf *links,
                              const char **starts, const int *lens, int pages) {
    const char *labels[] = {"chapter ", "section ", "capitolo ", "sezione "};
    pdf_section_hint headings[128];
    int count = 0;
    for (int page = 0; page < pages && count < 128; page++) {
        const char *p = starts[page], *end = p + lens[page];
        while (p < end && count < 128) {
            const char *nl = memchr(p, '\n', (size_t)(end - p));
            if (!nl) nl = end;
            while (p < nl && (*p == ' ' || *p == '\t')) p++;
            size_t n = (size_t)(nl - p);
            while (n && isspace((unsigned char)p[n - 1])) n--;
            for (int k = 0; k < 4; k++) {
                size_t l = strlen(labels[k]);
                if (n <= l || n > 160 || strncasecmp(p, labels[k], l)) continue;
                pdf_section_hint *h = &headings[count];
                if (!pdf_section_number(p + l, p + n, h->number, &h->level)) continue;
                memcpy(h->title, p, n); h->title[n] = 0;
                h->page = page + 1; h->kind = k;
                count++; break;
            }
            p = nl < end ? nl + 1 : end;
        }
    }
    int ok = json_dyn_puts(out, "[") && json_dyn_puts(links, "[");
    for (int i = 0; ok && i < count; i++) {
        pdf_section_hint *h = &headings[i];
        int parent = 0, matches = 0;
        char prefix[32]; cstr_copy(prefix, sizeof prefix, h->number);
        char *dot = strrchr(prefix, '.');
        if (dot && count < 128) {
            *dot = 0;
            for (int j = 0; j < count; j++) if (headings[j].kind == h->kind && !strcmp(headings[j].number, prefix)) { parent = headings[j].page; matches++; }
        }
        ok = (!i || json_dyn_puts(out, ",")) && json_dyn_printf(out,
            "{\"page\":%d,\"kind\":\"heading_hint\",\"level\":%d,\"parentPage\":%d,\"title\":", h->page, h->level, matches == 1 ? parent : 0) &&
            json_dyn_put_escaped(out, h->title) && json_dyn_puts(out, "}");
    }
    const char *refs[] = {"see chapter ", "see section ", "vedi capitolo ", "vedi sezione "};
    int edges = 0;
    for (int page = 0; ok && count < 128 && page < pages && edges < 128; page++) {
        const char *end = starts[page] + lens[page];
        for (const char *p = starts[page]; ok && p < end && edges < 128; p++) {
            if (p > starts[page] && isalnum((unsigned char)p[-1])) continue;
            if (*p != 's' && *p != 'S' && *p != 'v' && *p != 'V') continue;
            for (int k = 0; k < 4; k++) {
                size_t l = strlen(refs[k]);
                if ((size_t)(end - p) <= l || strncasecmp(p, refs[k], l)) continue;
                char number[32]; int level;
                int len = pdf_section_number(p + l, end, number, &level);
                if (!len) continue;
                int target = -1, matches = 0;
                for (int j = 0; j < count; j++) if (headings[j].kind == k && !strcmp(headings[j].number, number)) { target = j; matches++; }
                if (matches != 1 || headings[target].page == page + 1) continue;
                char quote[64]; size_t n = l + (size_t)len;
                memcpy(quote, p, n); quote[n] = 0;
                ok = (!edges || json_dyn_puts(links, ",")) && json_dyn_printf(links,
                    "{\"page\":%d,\"targetPage\":%d,\"kind\":\"explicit_reference\",\"quote\":", page + 1, headings[target].page) &&
                    json_dyn_put_escaped(links, quote) && json_dyn_puts(links, ",\"targetTitle\":") &&
                    json_dyn_put_escaped(links, headings[target].title) && json_dyn_puts(links, "}");
                edges++;
            }
        }
    }
    return ok && json_dyn_puts(out, "]") && json_dyn_puts(links, "]");
}

typedef struct { double x1, y1, x2, y2; size_t start, end; } pdf_evidence_word;

/* Poppler emits a small known XHTML vocabulary. No DTD/entity expansion. */
static int pdf_xml_text(json_dyn_buf *out, const char *p, const char *end) {
    while (p < end) {
        if (*p != '&') { if (!json_dyn_putn(out, p++, 1)) return 0; continue; }
        const char *semi = memchr(p, ';', (size_t)(end - p));
        if (!semi || semi - p > 12) return 0;
        unsigned long cp = 0;
        if (semi - p == 4 && !memcmp(p, "&amp;", 5)) cp = '&';
        else if (semi - p == 3 && !memcmp(p, "&lt;", 4)) cp = '<';
        else if (semi - p == 3 && !memcmp(p, "&gt;", 4)) cp = '>';
        else if (semi - p == 5 && !memcmp(p, "&quot;", 6)) cp = '"';
        else if (semi - p == 5 && !memcmp(p, "&apos;", 6)) cp = '\'';
        else if (p[1] == '#') {
            char *stop; int hex = p[2] == 'x' || p[2] == 'X';
            cp = strtoul(p + (hex ? 3 : 2), &stop, hex ? 16 : 10);
            if (stop != semi) return 0;
        } else return 0;
        if (!cp || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return 0;
        char u[4]; size_t n;
        if (cp < 128) { u[0] = (char)cp; n = 1; }
        else if (cp < 2048) { u[0] = 0xc0 | (cp >> 6); u[1] = 0x80 | (cp & 63); n = 2; }
        else if (cp < 65536) { u[0] = 0xe0 | (cp >> 12); u[1] = 0x80 | ((cp >> 6) & 63); u[2] = 0x80 | (cp & 63); n = 3; }
        else { u[0] = 0xf0 | (cp >> 18); u[1] = 0x80 | ((cp >> 12) & 63); u[2] = 0x80 | ((cp >> 6) & 63); u[3] = 0x80 | (cp & 63); n = 4; }
        if (!json_dyn_putn(out, u, n)) return 0;
        p = semi + 1;
    }
    return 1;
}

static char *pdf_quote_normalize(const char *s) {
    char *out = malloc(strlen(s) + 1);
    if (!out) return NULL;
    size_t n = 0; int space = 0;
    for (size_t i = 0; s[i]; i++) {
        unsigned char c = (unsigned char)s[i];
        if (c == 0xc2 && (unsigned char)s[i + 1] == 0xa0) { space = 1; i++; }
        else if (c < 128 && isspace(c)) space = 1;
        else { if (space && n) out[n++] = ' '; out[n++] = (char)c; space = 0; }
    }
    out[n] = 0; return out;
}

static int pdf_xml_number(const char *tag, const char *end, const char *name, double *value) {
    char key[32]; snprintf(key, sizeof key, " %s=\"", name);
    const char *p = strstr(tag, key);
    if (!p || p >= end) return 0;
    p += strlen(key); char *stop;
    *value = strtod(p, &stop);
    return stop > p && stop < end && *stop == '"' && isfinite(*value);
}

static void api_pdf_evidence_run(int fd, const char *body) {
    char id[80] = "", source[DSTUDIO_PATH_MAX], quote[2001], err[160] = "";
    long long page_value = 0; int render = 0;
    dtg_json_token tokens[32];
    int nt = dtg_json_validate_complete(body, '{', err, sizeof err)
        ? dtg_json_tokenize(body, strlen(body), tokens, 32) : -1;
    if (nt < 1 || tokens[0].type != DTG_JSON_OBJECT ||
        !dtg_json_unique_object_keys(body, tokens, nt, err, sizeof err) ||
        !dtg_json_object_string(body, tokens, nt, 0, "documentId", id, sizeof id, 1, err, sizeof err) ||
        !pdf_source_path(id, source, sizeof source) ||
        !dtg_json_object_int(body, tokens, nt, 0, "page", 0, 1, PDF_MAX_TOTAL_PAGES, &page_value, err, sizeof err) || !page_value ||
        !dtg_json_object_string(body, tokens, nt, 0, "quote", quote, sizeof quote, 1, err, sizeof err) ||
        !dtg_json_object_bool(body, tokens, nt, 0, "render", 0, &render, err, sizeof err)) {
        web_json_error(fd, "400 Bad Request", "documentId, integer physical page and quote (up to 2000 bytes) are required"); return;
    }
    /* The shared bounded decoder supports BMP escapes. Reject NUL and
     * surrogate escapes instead of silently truncating or corrupting a quote.
     * Literal UTF-8 (including non-BMP text) is preserved unchanged. */
    for (int qt = 0; qt < nt; qt++) {
        if (tokens[qt].type != DTG_JSON_STRING) continue;
        for (int i = tokens[qt].start; i < tokens[qt].end; i++) {
            if (body[i] != '\\') continue;
            if (body[++i] != 'u') continue;
            unsigned cp = 0;
            for (int j = 0; j < 4; j++) cp = (cp << 4) | (unsigned)dtg_hex_value(body[++i]);
            if (!cp || (cp >= 0xd800 && cp <= 0xdfff)) { web_json_error(fd, "400 Bad Request", "fields must contain non-NUL UTF-8 text"); return; }
        }
    }
    long page = (long)page_value;
    char *needle = pdf_quote_normalize(quote);
    if (!needle) { web_json_error(fd, "500 Internal Server Error", "oom"); return; }
    char dir[] = "/tmp/dstudio-pdfevidence-XXXXXX";
    if (!mkdtemp(dir)) { free(needle); web_json_error(fd, "500 Internal Server Error", "temporary directory unavailable"); return; }
    char pdf[DSTUDIO_PATH_MAX], xml[DSTUDIO_PATH_MAX], prefix[DSTUDIO_PATH_MAX], img[DSTUDIO_PATH_MAX];
    snprintf(pdf, sizeof pdf, "%s/source.pdf", dir);
    snprintf(xml, sizeof xml, "%s/words.html", dir);
    snprintf(prefix, sizeof prefix, "%s/page", dir);
    snprintf(img, sizeof img, "%s/page.jpg", dir);
    /* Pin the exact cached inode while a concurrent upload prunes the cache.
     * mkdtemp normally shares the source filesystem; otherwise copy locally. */
    int pinned = link(source, pdf) == 0;
    if (!pinned && errno == EXDEV) {
        int in = open(source, O_RDONLY), out = open(pdf, O_WRONLY | O_CREAT | O_EXCL, 0600);
        pinned = in >= 0 && out >= 0;
        char b[65536]; ssize_t n;
        while (pinned && (n = read(in, b, sizeof b)) != 0) {
            if (n < 0) { if (errno == EINTR) continue; pinned = 0; break; }
            ssize_t off = 0;
            while (off < n) { ssize_t w = write(out, b + off, (size_t)(n - off)); if (w < 0 && errno == EINTR) continue; if (w <= 0) { pinned = 0; break; } off += w; }
        }
        if (in >= 0) close(in);
        if (out >= 0 && close(out)) pinned = 0;
    }
    char *raw = NULL, *uri = NULL;
    pdf_evidence_word *words = NULL;
    json_dyn_buf joined = {0}, result = {0};
    const char *error = NULL, *http = "422 Unprocessable Entity";
    if (!pinned) { error = "Original PDF is no longer cached. Attach it again to open this source."; http = "410 Gone"; goto done; }
    char actual_id[65] = "";
    if (!pdf_document_id(pdf, actual_id) || strcmp(actual_id, id)) { error = "Cached PDF has changed or is unreadable. Attach the original again."; http = "410 Gone"; goto done; }
    (void)utimes(source, NULL);
    char tool[256], pg[16]; snprintf(pg, sizeof pg, "%ld", page);
    if (!pdf_find_tool("pdftotext", tool, sizeof tool)) { error = pdf_poppler_hint(); http = "503 Service Unavailable"; goto done; }
    char *argv[] = {tool, "-f", pg, "-l", pg, "-bbox-layout", "-enc", "UTF-8", pdf, xml, NULL};
    int st = -1; char *log = web_curl_capture(argv, 120000, &st); free(log);
    struct stat xs;
    if (st || stat(xml, &xs) || xs.st_size > 16 * 1024 * 1024) { error = "Cannot extract this physical PDF page."; goto done; }
    size_t size = 0; raw = jsonl_read_file(xml, &size);
    const char *p = raw ? strstr(raw, "<page ") : NULL, *end = p ? strchr(p, '>') : NULL;
    double width = 0, height = 0;
    if (!end || !pdf_xml_number(p, end, "width", &width) || !pdf_xml_number(p, end, "height", &height) || width <= 0 || height <= 0) { error = "PDF page dimensions unavailable."; goto done; }
    /* Poppler's word coordinates include page rotation, but its XHTML page
     * width/height describe the unrotated MediaBox. Read the actual rotation
     * instead of guessing it from whether a word happens to fit. */
    if (!pdf_find_tool("pdfinfo", tool, sizeof tool)) { error = pdf_poppler_hint(); http = "503 Service Unavailable"; goto done; }
    char *info_argv[] = {tool, "-f", pg, "-l", pg, pdf, NULL};
    log = web_curl_capture(info_argv, 20000, &st);
    const char *rot = log ? strstr(log, " rot:") : NULL;
    int rotation = -1;
    if (st == 0 && rot) { char *stop; long value = strtol(rot + 5, &stop, 10); if (stop > rot + 5) rotation = (int)((value % 360 + 360) % 360); }
    free(log);
    if (rotation != 0 && rotation != 90 && rotation != 180 && rotation != 270) { error = "PDF page rotation unavailable."; goto done; }
    if (rotation == 90 || rotation == 270) { double swap = width; width = height; height = swap; }
    words = calloc(PDF_EVIDENCE_WORDS, sizeof *words);
    if (!words) { error = "oom"; http = "500 Internal Server Error"; goto done; }
    int count = 0;
    while ((p = strstr(end, "<word "))) {
        end = strchr(p, '>'); const char *close = end ? strstr(end, "</word>") : NULL;
        if (!end || !close || count >= PDF_EVIDENCE_WORDS) { error = "PDF page exceeds the word extraction limit."; goto done; }
        pdf_evidence_word *w = &words[count];
        if (!pdf_xml_number(p, end, "xMin", &w->x1) || !pdf_xml_number(p, end, "yMin", &w->y1) ||
            !pdf_xml_number(p, end, "xMax", &w->x2) || !pdf_xml_number(p, end, "yMax", &w->y2)) { error = "Invalid word coordinates."; goto done; }
        json_dyn_buf decoded = {0};
        int good = pdf_xml_text(&decoded, end + 1, close);
        char *norm = good ? pdf_quote_normalize(decoded.ptr ? decoded.ptr : "") : NULL;
        free(decoded.ptr);
        if (!norm) { error = "Cannot decode PDF word text."; goto done; }
        if (*norm) {
            good = (!count || json_dyn_puts(&joined, " "));
            w->start = joined.len;
            good = good && json_dyn_puts(&joined, norm);
            w->end = joined.len; count++;
        }
        free(norm); end = close + 7;
        if (!good) { error = "oom"; http = "500 Internal Server Error"; goto done; }
    }
    int matches = 0, first = -1, last = -1;
    size_t qlen = strlen(needle);
    for (int i = 0; qlen && i < count; i++) {
        size_t stop = words[i].start + qlen;
        if (stop > joined.len || memcmp(joined.ptr + words[i].start, needle, qlen)) continue;
        for (int j = i; j < count && words[j].end <= stop; j++) {
            if (words[j].end == stop) { matches++; first = i; last = j; break; }
        }
    }
    int coords = 1;
    for (int i = first; matches == 1 && i <= last; i++) {
        pdf_evidence_word w = words[i];
        if (w.x1 < 0 || w.y1 < 0 || w.x2 <= w.x1 || w.y2 <= w.y1 || w.x2 > width || w.y2 > height) coords = 0;
    }
    const char *status = !qlen ? "page_only" : !count ? "no_text_layer" : !matches ? "not_found" : matches > 1 ? "ambiguous" : !coords ? "unsupported_coordinates" : "matched";
    if (render) {
        if (!pdf_find_tool("pdftoppm", tool, sizeof tool) || !pdf_render(tool, pdf, prefix, (int)page, (int)page, 1600, 1, 1, 90) || !(uri = pdf_img_data_uri(img))) {
            error = "Cannot render this PDF page."; goto done;
        }
    }
    int ok = json_dyn_printf(&result, "{\"ok\":true,\"documentId\":\"%s\",\"page\":%ld,\"width\":%.6f,\"height\":%.6f,\"status\":\"%s\",\"matches\":%d,\"quote\":", id, page, width, height, status, matches) && json_dyn_put_escaped(&result, needle) && json_dyn_puts(&result, ",\"boxes\":[");
    for (int i = first; ok && matches == 1 && coords && i <= last; i++) {
        pdf_evidence_word w = words[i];
        ok = (! (i > first) || json_dyn_puts(&result, ",")) && json_dyn_printf(&result,
            "{\"x\":%.8f,\"y\":%.8f,\"width\":%.8f,\"height\":%.8f}", w.x1 / width, w.y1 / height, (w.x2 - w.x1) / width, (w.y2 - w.y1) / height);
    }
    ok = ok && json_dyn_puts(&result, "],\"image\":") && (uri ? json_dyn_put_escaped(&result, uri) : json_dyn_puts(&result, "null")) && json_dyn_puts(&result, "}");
    if (!ok) { error = "oom"; http = "500 Internal Server Error"; }
done:
    if (error) web_json_error(fd, http, error);
    else send_json(fd, "200 OK", result.ptr);
    free(raw); free(uri); free(words); free(needle); free(joined.ptr); free(result.ptr);
    unlink(pdf); unlink(xml); unlink(img); rmdir(dir);
}

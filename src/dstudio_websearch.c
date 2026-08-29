/* ============================================================================
 * Web search / fetch tool domain + shared curl helpers.
 *
 * The browser-backed web search and page-fetch tools (used by chat Deep
 * Research and the agent's web tools). This file also owns three utilities
 * that behave as shared core helpers but happen to live here — web_curl_capture,
 * web_now_ms and web_json_error — forward-declared earlier in dstudio.c so
 * earlier domains (embed, vision, pdf) can call them.
 *
 * Extracted from dstudio.c into a per-domain file (one translation unit, all
 * static; same pattern as the GSA/RSA .cfrag includes).
 * ==========================================================================*/

static int web_url_ok(const char *url) {
    return url && (!strncmp(url, "http://", 7) || !strncmp(url, "https://", 8));
}

static int web_sources_push(web_source_list *list, const char *title, size_t tl, const char *url, size_t ul) {
    if (list->len >= list->cap) {
        int nc = list->cap ? list->cap * 2 : 16;
        web_source *np = realloc(list->items, (size_t)nc * sizeof *np);
        if (!np) return 0;
        list->items = np;
        list->cap = nc;
    }
    web_source *s = &list->items[list->len];
    memset(s, 0, sizeof *s);
    if (tl >= sizeof s->title) tl = sizeof s->title - 1;
    if (ul >= sizeof s->url) ul = sizeof s->url - 1;
    memcpy(s->title, title, tl); s->title[tl] = '\0';
    memcpy(s->url, url, ul); s->url[ul] = '\0';
    list->len++;
    return 1;
}

static int web_sources_parse_links(const char *md, web_source_list *sources) {
    const char *p = md ? md : "";
    while ((p = strstr(p, "- [")) != NULL) {
        const char *ts = p + 3;
        const char *mid = strstr(ts, "](");
        if (!mid) { p += 3; continue; }
        const char *us = mid + 2;
        const char *ue = strchr(us, ')');
        if (!ue) { p = us; continue; }
        size_t tl = (size_t)(mid - ts);
        size_t ul = (size_t)(ue - us);
        if (tl > 0 && ul > 0 && tl < sizeof(((web_source *)0)->title) && ul < sizeof(((web_source *)0)->url)) {
            char url[1024];
            memcpy(url, us, ul); url[ul] = '\0';
            if (web_url_ok(url)) {
                int dup = 0;
                for (int i = 0; i < sources->len; i++) if (!strcmp(sources->items[i].url, url)) dup = 1;
                if (!dup) {
                    if (!web_sources_push(sources, ts, tl, us, ul)) return 0;
                }
            }
        }
        p = ue + 1;
    }
    return 1;
}

static char *web_markdown_excerpt(const char *md, size_t cap) {
    const char *p = md ? strstr(md, "## Content") : NULL;
    p = p ? p + strlen("## Content") : (md ? md : "");
    while (*p == '\n' || *p == '\r' || *p == ' ' || *p == '\t') p++;
    size_t n = strlen(p);
    if (n > cap) n = cap;
    while (n && (p[n - 1] == '\n' || p[n - 1] == '\r' || p[n - 1] == ' ' || p[n - 1] == '\t')) n--;
    return ds4_strndup_local(p, n);
}

static char *web_strndup_cap(const char *s, size_t n, size_t cap);
static int web_starts_ci(const char *s, const char *prefix);

static char *web_markdown_title(const char *md) {
    const char *p = md ? md : "";
    while (*p) {
        const char *line = p;
        const char *end = strpbrk(line, "\r\n");
        size_t n = end ? (size_t)(end - line) : strlen(line);
        if (n > 2 && line[0] == '#' && line[1] == ' ') {
            line += 2;
            n -= 2;
            while (n && isspace((unsigned char)*line)) { line++; n--; }
            while (n && isspace((unsigned char)line[n - 1])) n--;
            if (n) return web_strndup_cap(line, n, 240);
        }
        p = end ? end + ((*end == '\r' && end[1] == '\n') ? 2 : 1) : line + n;
    }
    return strdup("Page");
}

static char *web_markdown_canonical_url(const char *md, const char *fallback) {
    const char *p = md ? md : "";
    while (*p) {
        const char *line = p;
        const char *end = strpbrk(line, "\r\n");
        size_t n = end ? (size_t)(end - line) : strlen(line);
        if (n > 4 && web_starts_ci(line, "URL:")) {
            line += 4;
            n -= 4;
            while (n && isspace((unsigned char)*line)) { line++; n--; }
            while (n && isspace((unsigned char)line[n - 1])) n--;
            if (n) return web_strndup_cap(line, n, 2048);
        }
        p = end ? end + ((*end == '\r' && end[1] == '\n') ? 2 : 1) : line + n;
    }
    return strdup(fallback ? fallback : "");
}

static const char *web_last_header_split(const char *s);

static int web_starts_ci(const char *s, const char *prefix) {
    while (*prefix) {
        if (tolower((unsigned char)*s++) != tolower((unsigned char)*prefix++)) return 0;
    }
    return 1;
}

static const char *web_find_ci(const char *s, const char *needle) {
    if (!s || !needle || !needle[0]) return NULL;
    for (const char *p = s; *p; p++) {
        if (tolower((unsigned char)*p) == tolower((unsigned char)needle[0]) &&
            web_starts_ci(p, needle)) return p;
    }
    return NULL;
}

static int web_hex_value(unsigned char c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

/* Decode the small HTML subset used in search-result titles. Tags are removed,
 * entities are decoded, and whitespace is normalized so the text is safe to
 * expose as a source title. */
static size_t web_html_fragment_text(const char *src, size_t len, char *out, size_t cap) {
    size_t i = 0, o = 0;
    int space = 1;
    if (!cap) return 0;
    while (i < len && o + 1 < cap) {
        unsigned char c = (unsigned char)src[i++];
        if (c == '<') {
            while (i < len && src[i] != '>') i++;
            if (i < len) i++;
            continue;
        }
        if (c == '&') {
            const char *entity = src + i;
            size_t left = len - i;
            if (left >= 4 && !strncmp(entity, "amp;", 4)) { c = '&'; i += 4; }
            else if (left >= 3 && !strncmp(entity, "lt;", 3)) { c = '<'; i += 3; }
            else if (left >= 3 && !strncmp(entity, "gt;", 3)) { c = '>'; i += 3; }
            else if (left >= 5 && !strncmp(entity, "quot;", 5)) { c = '"'; i += 5; }
            else if (left >= 5 && !strncmp(entity, "apos;", 5)) { c = '\''; i += 5; }
            else if (left >= 5 && !strncmp(entity, "nbsp;", 5)) { c = ' '; i += 5; }
            else if (left >= 3 && entity[0] == '#') {
                size_t j = 1;
                int base = 10;
                if (j < left && (entity[j] == 'x' || entity[j] == 'X')) { base = 16; j++; }
                unsigned long value = 0;
                size_t digits = 0;
                while (j < left && entity[j] != ';') {
                    int d = base == 16 ? web_hex_value((unsigned char)entity[j])
                                       : (isdigit((unsigned char)entity[j]) ? entity[j] - '0' : -1);
                    if (d < 0 || d >= base || value > 0x10ffffUL / (unsigned long)base) break;
                    value = value * (unsigned long)base + (unsigned long)d;
                    j++; digits++;
                }
                if (digits && j < left && entity[j] == ';' && value > 0 && value < 128) {
                    c = (unsigned char)value;
                    i += j + 1;
                } else c = ' ';
            } else c = ' ';
        }
        if (isspace(c) || c < 0x20 || c == 0x7f) {
            if (!space && o + 1 < cap) out[o++] = ' ';
            space = 1;
        } else {
            out[o++] = (char)c;
            space = 0;
        }
    }
    while (o && out[o - 1] == ' ') o--;
    out[o] = '\0';
    return o;
}

static size_t web_percent_decode(const char *src, size_t len, char *out, size_t cap) {
    size_t o = 0;
    if (!cap) return 0;
    for (size_t i = 0; i < len && o + 1 < cap; i++) {
        if (src[i] == '%' && i + 2 < len) {
            int hi = web_hex_value((unsigned char)src[i + 1]);
            int lo = web_hex_value((unsigned char)src[i + 2]);
            if (hi >= 0 && lo >= 0) {
                out[o++] = (char)((hi << 4) | lo);
                i += 2;
                continue;
            }
        }
        out[o++] = src[i];
    }
    out[o] = '\0';
    return o;
}

static char *web_url_encode_query(const char *text) {
    const unsigned char *src = (const unsigned char *)(text ? text : "");
    size_t len = strlen((const char *)src);
    if (len > (SIZE_MAX - 1) / 3) return NULL;
    char *out = malloc(len * 3 + 1);
    if (!out) return NULL;
    static const char hex[] = "0123456789ABCDEF";
    size_t o = 0;
    for (size_t i = 0; i < len; i++) {
        unsigned char c = src[i];
        if (isalnum(c) || c == '-' || c == '_' || c == '.' || c == '~') out[o++] = (char)c;
        else if (c == ' ') out[o++] = '+';
        else {
            out[o++] = '%';
            out[o++] = hex[c >> 4];
            out[o++] = hex[c & 15];
        }
    }
    out[o] = '\0';
    return out;
}

static void web_sources_keep_external_search_results(web_source_list *sources) {
    if (!sources) return;
    int keep = 0;
    for (int i = 0; i < sources->len; i++) {
        web_source *source = &sources->items[i];
        int navigation = web_find_ci(source->url, "://search.brave.com/") ||
                         web_find_ci(source->url, "://www.google.") ||
                         web_find_ci(source->url, "://google.") ||
                         web_find_ci(source->url, "://www.bing.com/") ||
                         web_find_ci(source->url, "://bing.com/") ||
                         web_find_ci(source->url, "://duckduckgo.com/") ||
                         web_find_ci(source->url, "://start.duckduckgo.com/");
        if (navigation) {
            free(source->content);
            source->content = NULL;
            continue;
        }
        if (keep != i) sources->items[keep] = sources->items[i];
        keep++;
    }
    sources->len = keep;
}

static int web_sources_append_unique(web_source_list *dest, const web_source *source) {
    if (!dest || !source || !source->url[0]) return 1;
    for (int i = 0; i < dest->len; i++) {
        if (!strcmp(dest->items[i].url, source->url)) return 1;
    }
    return web_sources_push(dest, source->title, strlen(source->title),
                            source->url, strlen(source->url));
}

static int web_bing_redirect_target(const char *url, char *out, size_t cap) {
    if (!url || !out || cap < 2 || !web_find_ci(url, "://www.bing.com/ck/a")) return 0;
    const char *param = strstr(url, "&u=");
    if (!param) param = strstr(url, "?u=");
    if (!param) return 0;
    param += 3;
    const char *end = strchr(param, '&');
    size_t n = end ? (size_t)(end - param) : strlen(param);
    if (!n || n >= 4096) return 0;
    char encoded[4096];
    web_percent_decode(param, n, encoded, sizeof encoded);
    const char *payload = !strncmp(encoded, "a1", 2) ? encoded + 2 : encoded;
    size_t decoded_len = 0;
    char *decoded = base64_decode(payload, &decoded_len);
    if (!decoded) return 0;
    decoded[decoded_len] = '\0';
    int ok = web_url_ok(decoded) && decoded_len + 1 <= cap;
    if (ok) memcpy(out, decoded, decoded_len + 1);
    free(decoded);
    return ok;
}

static void web_sources_normalize_bing_redirects(web_source_list *sources) {
    if (!sources) return;
    for (int i = 0; i < sources->len; i++) {
        char target[1024];
        if (web_bing_redirect_target(sources->items[i].url, target, sizeof target)) {
            snprintf(sources->items[i].url, sizeof sources->items[i].url, "%s", target);
        }
    }
    web_sources_keep_external_search_results(sources);
    for (int i = 0; i < sources->len; i++) {
        for (int j = i + 1; j < sources->len; ) {
            if (!strcmp(sources->items[i].url, sources->items[j].url)) {
                free(sources->items[j].content);
                memmove(&sources->items[j], &sources->items[j + 1],
                        (size_t)(sources->len - j - 1) * sizeof sources->items[0]);
                sources->len--;
            } else j++;
        }
    }
}

/* DuckDuckGo's HTML endpoint remains usable when browser-backed Google search
 * returns an anti-bot page. Its result links use a redirect with the actual URL
 * in the percent-encoded `uddg` parameter. */
static int web_sources_parse_duckduckgo(const char *html, web_source_list *sources) {
    const char *p = html ? html : "";
    while ((p = web_find_ci(p, "class=\"result__a\"")) != NULL) {
        const char *tag = p;
        while (tag > html && *tag != '<') tag--;
        const char *gt = strchr(p, '>');
        if (!gt) break;
        const char *close = web_find_ci(gt + 1, "</a>");
        if (!close) break;
        const char *href = web_find_ci(tag, "href=\"");
        if (!href || href >= gt) { p = close + 4; continue; }
        href += 6;
        const char *href_end = strchr(href, '"');
        if (!href_end || href_end > gt) { p = close + 4; continue; }

        const char *encoded = NULL;
        size_t encoded_len = 0;
        const char *uddg = strstr(href, "uddg=");
        if (uddg && uddg < href_end) {
            encoded = uddg + 5;
            const char *amp = memchr(encoded, '&', (size_t)(href_end - encoded));
            encoded_len = (size_t)((amp ? amp : href_end) - encoded);
        } else if ((size_t)(href_end - href) >= 7 &&
                   (!strncmp(href, "http://", 7) || !strncmp(href, "https://", 8))) {
            encoded = href;
            encoded_len = (size_t)(href_end - href);
        }
        if (!encoded || !encoded_len) { p = close + 4; continue; }

        char url[1024], title[256];
        web_percent_decode(encoded, encoded_len, url, sizeof url);
        web_html_fragment_text(gt + 1, (size_t)(close - (gt + 1)), title, sizeof title);
        if (!title[0]) cstr_copy(title, sizeof title, url);
        if (web_url_ok(url)) {
            int dup = 0;
            for (int i = 0; i < sources->len; i++) {
                if (!strcmp(sources->items[i].url, url)) { dup = 1; break; }
            }
            if (!dup && !web_sources_push(sources, title, strlen(title), url, strlen(url))) return 0;
        }
        p = close + 4;
    }
    return 1;
}

static const char *web_skip_block_tag(const char *p, const char *tag) {
    char open[48], close[48];
    snprintf(open, sizeof open, "<%s", tag);
    snprintf(close, sizeof close, "</%s>", tag);
    if (!web_starts_ci(p, open)) return NULL;
    const char *end = web_find_ci(p, close);
    return end ? end + strlen(close) : p + 1;
}

static char *web_html_text_excerpt(const char *raw, size_t cap) {
    const char *p = web_last_header_split(raw ? raw : "");
    if (!p) p = raw ? raw : "";
    char *out = malloc(cap + 1);
    if (!out) return NULL;
    size_t o = 0;
    int space = 1;
    while (*p && o + 1 < cap) {
        if (*p == '<') {
            const char *skip = NULL;
            const char *skip_tags[] = { "script", "style", "nav", "footer", "aside", "svg", "noscript", "form" };
            for (size_t i = 0; i < sizeof skip_tags / sizeof skip_tags[0]; i++) {
                skip = web_skip_block_tag(p, skip_tags[i]);
                if (skip) break;
            }
            if (skip) {
                p = skip;
                if (!space && o + 1 < cap) { out[o++] = ' '; space = 1; }
                continue;
            }
            const char *gt = strchr(p, '>');
            p = gt ? gt + 1 : p + 1;
            if (!space && o + 1 < cap) { out[o++] = ' '; space = 1; }
            continue;
        }
        unsigned char c = (unsigned char)*p++;
        if (c == '&') {
            if (!strncmp(p, "amp;", 4)) { c = '&'; p += 4; }
            else if (!strncmp(p, "lt;", 3)) { c = '<'; p += 3; }
            else if (!strncmp(p, "gt;", 3)) { c = '>'; p += 3; }
            else if (!strncmp(p, "quot;", 5)) { c = '"'; p += 5; }
            else if (!strncmp(p, "apos;", 5)) { c = '\''; p += 5; }
            else if (!strncmp(p, "nbsp;", 5)) { c = ' '; p += 5; }
            else c = ' ';
        }
        if (c < 0x20 || c == 0x7f || c == ' ' || c == '\n' || c == '\r' || c == '\t') {
            if (!space && o + 1 < cap) out[o++] = ' ';
            space = 1;
            continue;
        }
        out[o++] = (char)c;
        space = 0;
    }
    while (o && out[o - 1] == ' ') o--;
    out[o] = '\0';
    return out;
}

static const char *web_guess_source_kind(const char *url, const char *title, const char *text) {
    char blob[4096];
    const char *page_url = url ? url : "";
    snprintf(blob, sizeof blob, "%s %s %s", url ? url : "", title ? title : "", text ? text : "");
    if (web_find_ci(blob, "package.json") ||
        web_find_ci(blob, "makefile") || web_find_ci(blob, "pyproject.toml") ||
        web_find_ci(blob, "cargo.toml") || web_find_ci(blob, "go.mod") ||
        web_find_ci(page_url, "github.") || web_find_ci(page_url, "gitlab.") ||
        web_find_ci(page_url, "bitbucket.") || web_find_ci(page_url, "codeberg.org") ||
        (web_find_ci(blob, "readme") &&
         (web_find_ci(blob, "repository") || web_find_ci(blob, " repo ")))) return "repo";
    if (web_find_ci(page_url, "arxiv.org/") || web_find_ci(page_url, "doi.org/") ||
        web_find_ci(page_url, "pubmed") || web_find_ci(page_url, "ncbi.nlm.nih.gov/") ||
        web_find_ci(page_url, "semanticscholar.org/") || web_find_ci(page_url, "ieee.org/") ||
        web_find_ci(page_url, "acm.org/") || web_find_ci(blob, "arxiv:") ||
        web_find_ci(blob, "pubmed:") || web_find_ci(blob, "doi: 10.") ||
        ((web_find_ci(blob, "abstract") || web_find_ci(blob, "authors")) &&
         (web_find_ci(blob, "journal") || web_find_ci(blob, "conference") ||
          web_find_ci(blob, "research paper")))) return "academic";
    if (web_find_ci(page_url, "reddit.com/") || web_find_ci(page_url, "news.ycombinator.com/") ||
        web_find_ci(page_url, "stackoverflow.com/") || web_find_ci(page_url, "stackexchange.com/") ||
        web_find_ci(page_url, "twitter.com/") || web_find_ci(page_url, "x.com/") ||
        web_find_ci(page_url, "youtube.com/") || web_find_ci(page_url, "youtu.be/") ||
        web_find_ci(blob, "upvotes") || web_find_ci(blob, "subreddit") ||
        web_find_ci(blob, "hacker news") || web_find_ci(blob, "tweet") ||
        (web_find_ci(blob, "thread") && web_find_ci(blob, "comments"))) return "social";
    if (web_find_ci(blob, "/docs") || web_find_ci(blob, "documentation") ||
        web_find_ci(blob, "api reference") || web_find_ci(blob, "quickstart") ||
        web_find_ci(blob, "manual")) return "docs";
    if (web_find_ci(blob, "/pricing") || web_find_ci(blob, "/features") ||
        web_find_ci(blob, "/product") || web_find_ci(blob, "plans") ||
        web_find_ci(blob, "customers") || web_find_ci(blob, "enterprise")) return "product";
    if (web_find_ci(page_url, "dev.to/") || web_find_ci(page_url, "medium.com/") ||
        web_find_ci(page_url, "hashnode.com/") || web_find_ci(page_url, "substack.com/") ||
        web_find_ci(blob, "/blog/") || web_find_ci(blob, "/news/") ||
        web_find_ci(blob, "published") || web_find_ci(blob, "press release")) return "article";
    return "generic";
}

static void web_sources_free(web_source_list *sources) {
    if (!sources) return;
    for (int i = 0; i < sources->len; i++) free(sources->items[i].content);
    free(sources->items);
    sources->items = NULL;
    sources->len = 0;
    sources->cap = 0;
}

static void web_json_error(int fd, const char *status, const char *msg) {
    dstudio_log_event("error", "web", 0, "%s: %s", status ? status : "web error",
                      msg ? msg : "web search failed");
    json_dyn_buf b = {0};
    if (!json_dyn_puts(&b, "{\"ok\":false,\"error\":") ||
        !json_dyn_put_escaped(&b, msg ? msg : "web search failed") ||
        !json_dyn_puts(&b, "}")) {
        free(b.ptr);
        send_json(fd, "500 Internal Server Error", "{\"ok\":false,\"error\":\"out of memory\"}");
        return;
    }
    send_json(fd, status, b.ptr);
    free(b.ptr);
}

static long long web_now_ms(void);

static char *web_curl_capture(char *const argv[], int timeout_ms, int *exit_status) {
#ifdef _WIN32
    (void)argv; (void)timeout_ms; (void)exit_status;
    return NULL;
#else
    int pfd[2];
    if (pipe(pfd) != 0) return NULL;
    pid_t pid = fork();
    if (pid < 0) { close(pfd[0]); close(pfd[1]); return NULL; }
    if (pid == 0) {
        dup2(pfd[1], STDOUT_FILENO);
        dup2(pfd[1], STDERR_FILENO);
        close(pfd[0]); close(pfd[1]);
        int dn = open("/dev/null", O_RDONLY);
        if (dn >= 0) { dup2(dn, STDIN_FILENO); close(dn); }
        execvp(argv[0], argv);   /* argv[0] is the program (curl for most callers, pdftoppm/pdfinfo for PDFs) */
        _exit(127);
    }
    close(pfd[1]);
    int flags = fcntl(pfd[0], F_GETFL, 0);
    if (flags >= 0) (void)fcntl(pfd[0], F_SETFL, flags | O_NONBLOCK);
    json_dyn_buf out = {0};
    char buf[8192];
    int st = 0, done = 0, killed = 0, reaped = 0;
    const int no_deadline = timeout_ms < 0;
    long long deadline = no_deadline ? 0 : web_now_ms() + (timeout_ms > 0 ? timeout_ms : 20000);
    while (!done) {
        ssize_t r;
        while ((r = read(pfd[0], buf, sizeof buf)) > 0) {
            if (out.len + (size_t)r > 8 * 1024 * 1024) {
                killed = 1;
                kill(pid, SIGKILL);
                break;
            }
            if (!json_dyn_putn(&out, buf, (size_t)r)) {
                free(out.ptr);
                out.ptr = NULL;
                killed = 1;
                kill(pid, SIGKILL);
                break;
            }
        }
        if (killed) break;
        if (r == 0) { done = 1; break; }
        if (r < 0 && errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR) break;
        pid_t wp = waitpid(pid, &st, WNOHANG);
        if (wp == pid) {
            reaped = 1;
            done = 1;
            while ((r = read(pfd[0], buf, sizeof buf)) > 0) {
                if (out.len + (size_t)r > 8 * 1024 * 1024) break;
                if (!json_dyn_putn(&out, buf, (size_t)r)) { free(out.ptr); out.ptr = NULL; break; }
            }
            break;
        }
        if (wp < 0 && errno != EINTR) break;
        long long left = no_deadline ? 250 : deadline - web_now_ms();
        if (!no_deadline && left <= 0) {
            killed = 1;
            kill(pid, SIGKILL);
            break;
        }
        struct pollfd pf = { pfd[0], POLLIN | POLLHUP, 0 };
        int wait_ms = no_deadline || left > 250 ? 250 : (int)left;
        (void)poll(&pf, 1, wait_ms);
    }
    close(pfd[0]);
    if (killed) kill(pid, SIGKILL);
    if (!reaped) waitpid(pid, &st, 0);
    if (killed) {
        free(out.ptr);
        if (exit_status) *exit_status = 124;
        return strdup("");
    }
    if (exit_status) *exit_status = WIFEXITED(st) ? WEXITSTATUS(st) : 127;
    return out.ptr ? out.ptr : strdup("");
#endif
}

static int web_duckduckgo_search(const char *query, web_source_list *sources,
                                 char *err, size_t err_len) {
#ifdef _WIN32
    (void)query; (void)sources;
    snprintf(err, err_len, "DuckDuckGo fallback is not available in the Windows build yet");
    return 0;
#else
    size_t qlen = strlen(query ? query : "");
    char *qarg = malloc(qlen + 3);
    if (!qarg) { snprintf(err, err_len, "out of memory"); return 0; }
    snprintf(qarg, qlen + 3, "q=%s", query ? query : "");
    char *argv[] = {
        "curl", "-sS", "-L", "--compressed", "--get",
        "--data-urlencode", qarg,
        "--connect-timeout", "12", "--max-time", "45",
        "-A", "Mozilla/5.0 (Macintosh; Intel Mac OS X) DStudio/1.0",
        "https://html.duckduckgo.com/html/", NULL,
    };
    int st = 0;
    char *html = web_curl_capture(argv, 60000, &st);
    free(qarg);
    if (!html || !html[0]) {
        snprintf(err, err_len, "%s", st == 124 ? "DuckDuckGo fallback timed out" : "DuckDuckGo fallback returned no data");
        free(html);
        return 0;
    }
    int before = sources->len;
    int ok = web_sources_parse_duckduckgo(html, sources);
    free(html);
    if (!ok) { snprintf(err, err_len, "out of memory"); return 0; }
    if (sources->len == before) {
        snprintf(err, err_len, "DuckDuckGo fallback returned no result links");
        return 0;
    }
    return 1;
#endif
}

static int web_sources_parse_brave(const char *html, web_source_list *sources) {
    const char *p = html ? html : "";
    int added = 0;
    while ((p = web_find_ci(p, "data-type=\"web\"")) != NULL && added < 12) {
        const char *next = web_find_ci(p + 15, "data-type=\"web\"");
        const char *anchor = web_find_ci(p, "<a href=\"");
        if (!anchor || (next && anchor >= next)) { p += 15; continue; }
        const char *href = anchor + 9;
        const char *href_end = strchr(href, '"');
        if (!href_end || (next && href_end >= next)) { p = anchor + 3; continue; }

        char url[1024], title[256], description[640];
        web_html_fragment_text(href, (size_t)(href_end - href), url, sizeof url);
        if (!web_url_ok(url) || web_find_ci(url, "://search.brave.com") ||
            web_find_ci(url, "://cdn.search.brave.com") ||
            web_find_ci(url, "://imgs.search.brave.com") ||
            web_find_ci(url, "://tiles.search.brave.com")) {
            p = href_end + 1;
            continue;
        }

        title[0] = '\0';
        description[0] = '\0';
        const char *title_class = web_find_ci(href_end, "search-snippet-title");
        if (title_class && (!next || title_class < next)) {
            const char *title_gt = strchr(title_class, '>');
            const char *title_end = title_gt ? web_find_ci(title_gt + 1, "</div>") : NULL;
            if (title_gt && title_end && (!next || title_end < next)) {
                web_html_fragment_text(title_gt + 1, (size_t)(title_end - (title_gt + 1)), title, sizeof title);
            }
        }
        const char *content_class = title_class ? web_find_ci(title_class, "generic-snippet") : NULL;
        if (content_class && (!next || content_class < next)) {
            const char *content_text = web_find_ci(content_class, "class=\"content");
            const char *content_gt = content_text ? strchr(content_text, '>') : NULL;
            const char *content_end = content_gt ? web_find_ci(content_gt + 1, "</div>") : NULL;
            if (content_gt && content_end && (!next || content_end < next)) {
                web_html_fragment_text(content_gt + 1, (size_t)(content_end - (content_gt + 1)),
                                       description, sizeof description);
            }
        }
        if (!title[0]) cstr_copy(title, sizeof title, url);

        int dup = 0;
        for (int i = 0; i < sources->len; i++) {
            if (!strcmp(sources->items[i].url, url)) { dup = 1; break; }
        }
        if (!dup) {
            if (!web_sources_push(sources, title, strlen(title), url, strlen(url))) return 0;
            sources->items[sources->len - 1].content = strdup(description[0] ? description : title);
            if (!sources->items[sources->len - 1].content) return 0;
            added++;
        }
        p = next ? next : href_end + 1;
    }
    return 1;
}

static int web_brave_search(const char *query, web_source_list *sources,
                            char *err, size_t err_len) {
#ifdef _WIN32
    (void)query; (void)sources;
    snprintf(err, err_len, "Brave fallback is not available in the Windows build yet");
    return 0;
#else
    size_t qlen = strlen(query ? query : "");
    char *qarg = malloc(qlen + 3);
    if (!qarg) { snprintf(err, err_len, "out of memory"); return 0; }
    snprintf(qarg, qlen + 3, "q=%s", query ? query : "");
    char *argv[] = {
        "curl", "-sS", "-L", "--compressed", "--get",
        "--data-urlencode", qarg,
        "--connect-timeout", "12", "--max-time", "45",
        "-A", "Mozilla/5.0 (Macintosh; Intel Mac OS X) DStudio/1.0",
        "https://search.brave.com/search?source=web", NULL,
    };
    int st = 0;
    char *html = web_curl_capture(argv, 60000, &st);
    free(qarg);
    if (!html || !html[0]) {
        snprintf(err, err_len, "%s", st == 124 ? "Brave fallback timed out" : "Brave fallback returned no data");
        free(html);
        return 0;
    }
    int before = sources->len;
    int ok = web_sources_parse_brave(html, sources);
    free(html);
    if (!ok) { snprintf(err, err_len, "out of memory"); return 0; }
    if (sources->len == before) {
        snprintf(err, err_len, "Brave fallback returned no new result links");
        return 0;
    }
    return 1;
#endif
}

static int web_sources_parse_bing_rss(const char *xml, web_source_list *sources) {
    const char *p = xml ? xml : "";
    while ((p = web_find_ci(p, "<item>")) != NULL) {
        const char *end = web_find_ci(p + 6, "</item>");
        if (!end) break;
        const char *title_start = web_find_ci(p, "<title>");
        const char *title_end = title_start ? web_find_ci(title_start + 7, "</title>") : NULL;
        const char *url_start = web_find_ci(p, "<link>");
        const char *url_end = url_start ? web_find_ci(url_start + 6, "</link>") : NULL;
        const char *desc_start = web_find_ci(p, "<description>");
        const char *desc_end = desc_start ? web_find_ci(desc_start + 13, "</description>") : NULL;
        if (!title_start || !title_end || title_end > end ||
            !url_start || !url_end || url_end > end) { p = end + 7; continue; }

        char title[256], url[1024], description[640];
        web_html_fragment_text(title_start + 7, (size_t)(title_end - (title_start + 7)), title, sizeof title);
        web_html_fragment_text(url_start + 6, (size_t)(url_end - (url_start + 6)), url, sizeof url);
        description[0] = '\0';
        if (desc_start && desc_end && desc_end <= end) {
            web_html_fragment_text(desc_start + 13, (size_t)(desc_end - (desc_start + 13)),
                                   description, sizeof description);
        }
        if (!title[0]) cstr_copy(title, sizeof title, url);
        if (web_url_ok(url)) {
            int dup = 0;
            for (int i = 0; i < sources->len; i++) {
                if (!strcmp(sources->items[i].url, url)) { dup = 1; break; }
            }
            if (!dup) {
                if (!web_sources_push(sources, title, strlen(title), url, strlen(url))) return 0;
                sources->items[sources->len - 1].content = strdup(description[0] ? description : title);
                if (!sources->items[sources->len - 1].content) return 0;
            }
        }
        p = end + 7;
    }
    return 1;
}

static int web_bing_rss_search(const char *query, web_source_list *sources,
                               char *err, size_t err_len) {
#ifdef _WIN32
    (void)query; (void)sources;
    snprintf(err, err_len, "Bing RSS fallback is not available in the Windows build yet");
    return 0;
#else
    size_t qlen = strlen(query ? query : "");
    char *qarg = malloc(qlen + 3);
    if (!qarg) { snprintf(err, err_len, "out of memory"); return 0; }
    snprintf(qarg, qlen + 3, "q=%s", query ? query : "");
    char *argv[] = {
        "curl", "-sS", "-L", "--compressed", "--get",
        "--data-urlencode", qarg,
        "--connect-timeout", "12", "--max-time", "45",
        "-A", "Mozilla/5.0 (Macintosh; Intel Mac OS X) DStudio/1.0",
        "https://www.bing.com/search?format=rss", NULL,
    };
    int st = 0;
    char *xml = web_curl_capture(argv, 60000, &st);
    free(qarg);
    if (!xml || !xml[0]) {
        snprintf(err, err_len, "%s", st == 124 ? "Bing RSS fallback timed out" : "Bing RSS fallback returned no data");
        free(xml);
        return 0;
    }
    int before = sources->len;
    int ok = web_sources_parse_bing_rss(xml, sources);
    free(xml);
    if (!ok) { snprintf(err, err_len, "out of memory"); return 0; }
    if (sources->len == before) {
        snprintf(err, err_len, "Bing RSS fallback returned no new result links");
        return 0;
    }
    return 1;
#endif
}

static char *web_sources_markdown(const char *query, const web_source_list *sources,
                                  const char *provider) {
    json_dyn_buf md = {0};
    int ok = json_dyn_puts(&md, "# Web search results\n\nQuery: ") &&
             json_dyn_puts(&md, query ? query : "") &&
             json_dyn_puts(&md, "\n\nProvider: ") &&
             json_dyn_puts(&md, provider ? provider : "browser") &&
             json_dyn_puts(&md, "\n\n");
    for (int i = 0; ok && sources && i < sources->len; i++) {
        ok = json_dyn_puts(&md, "- [") &&
             json_dyn_puts(&md, sources->items[i].title) &&
             json_dyn_puts(&md, "](") &&
             json_dyn_puts(&md, sources->items[i].url) &&
             json_dyn_puts(&md, ")\n");
    }
    if (!ok) { free(md.ptr); return NULL; }
    return md.ptr ? md.ptr : strdup("");
}

static char *web_curl_visit_page(const char *url, char *err, size_t err_len) {
#ifdef _WIN32
    (void)url; (void)err; (void)err_len;
    return NULL;
#else
    char *argv[20];
    int n = 0;
    argv[n++] = "curl";
    argv[n++] = "-sS";
    argv[n++] = "-L";
    argv[n++] = "--compressed";
    argv[n++] = "-i";
    argv[n++] = "--max-redirs"; argv[n++] = "8";
    argv[n++] = "--connect-timeout"; argv[n++] = "12";
    argv[n++] = "--max-time"; argv[n++] = "45";
    argv[n++] = "-A"; argv[n++] = "Mozilla/5.0 DStudio/1.0";
    argv[n++] = "-w"; argv[n++] = "\n__DSTUDIO_CURL_META__%{http_code} %{url_effective}\n";
    argv[n++] = (char *)url;
    argv[n] = NULL;

    int st = 0;
    char *raw = web_curl_capture(argv, 60000, &st);
    if (!raw) {
        snprintf(err, err_len, "curl failed to start");
        return NULL;
    }
    int status = 0;
    char final_url[2048] = "";
    char *marker = strstr(raw, "\n__DSTUDIO_CURL_META__");
    if (marker) {
        *marker = '\0';
        const char *meta = marker + strlen("\n__DSTUDIO_CURL_META__");
        char *end = NULL;
        long code = strtol(meta, &end, 10);
        if (code >= 0 && code <= 999) status = (int)code;
        while (end && (*end == ' ' || *end == '\t')) end++;
        if (end) {
            size_t fl = strcspn(end, "\r\n");
            if (fl >= sizeof final_url) fl = sizeof final_url - 1;
            memcpy(final_url, end, fl); final_url[fl] = '\0';
        }
    }
    char *text = web_html_text_excerpt(raw, 24000);
    free(raw);
    if (!text || strlen(text) < 24) {
        snprintf(err, err_len, "%s", st == 124 ? "curl timed out" :
                 st != 0 ? "curl returned no readable text" : "page returned no readable text");
        free(text);
        return NULL;
    }
    json_dyn_buf md = {0};
    int ok = json_dyn_puts(&md, "# Page\n\nURL: ") &&
             json_dyn_puts(&md, final_url[0] ? final_url : url) &&
             json_dyn_puts(&md, "\n") &&
             (status ? json_dyn_printf(&md, "\nHTTP status: %d\n", status) : 1) &&
             json_dyn_puts(&md, "\n## Content\n\n") &&
             json_dyn_puts(&md, text);
    free(text);
    if (!ok) {
        free(md.ptr);
        snprintf(err, err_len, "out of memory");
        return NULL;
    }
    return md.ptr;
#endif
}

static const char *web_last_header_split(const char *s) {
    const char *last = NULL;
    for (const char *p = s; p && *p; ) {
        const char *a = strstr(p, "\r\n\r\n");
        const char *b = strstr(p, "\n\n");
        const char *hit = NULL;
        if (a && b) hit = a < b ? a : b;
        else hit = a ? a : b;
        if (!hit) break;
        last = hit + (hit[0] == '\r' ? 4 : 2);
        p = last;
    }
    return last;
}

static char *web_strndup_cap(const char *s, size_t n, size_t cap) {
    if (!s) s = "";
    if (n > cap) n = cap;
    return ds4_strndup_local(s, n);
}

static long long web_now_ms(void) {
#ifdef _WIN32
    return (long long)GetTickCount64();
#else
    struct timeval tv;
    gettimeofday(&tv, NULL);
    return (long long)tv.tv_sec * 1000LL + (long long)(tv.tv_usec / 1000);
#endif
}

static char *web_helper_capture(const char *tool, const char *arg_kind, const char *arg_value,
                                int timeout_ms, int *exit_status) {
#ifdef _WIN32
    (void)tool; (void)arg_kind; (void)arg_value; (void)timeout_ms; (void)exit_status;
    return NULL;
#else
    static int web_helper_ready = 0;
    if (!web_helper_ready) {
        if (!run_build_jsonl("build")) return NULL;
        web_helper_ready = 1;
    }
    int pfd[2];
    if (pipe(pfd) != 0) return NULL;
    pid_t pid = fork();
    if (pid < 0) { close(pfd[0]); close(pfd[1]); return NULL; }
    if (pid == 0) {
        if (chdir(g_ds4_dir) != 0) _exit(127);
        dup2(pfd[1], STDOUT_FILENO);
        close(pfd[0]); close(pfd[1]);
        int dn = open("/dev/null", O_RDONLY);
        if (dn >= 0) { dup2(dn, STDIN_FILENO); close(dn); }
        char *argv[8]; int n = 0;
        argv[n++] = "./ds4-agent-jsonl";
        argv[n++] = "--web-tool"; argv[n++] = (char *)tool;
        argv[n++] = (char *)arg_kind; argv[n++] = (char *)arg_value;
        argv[n] = NULL;
        execv("./ds4-agent-jsonl", argv);
        _exit(127);
    }
    close(pfd[1]);
    int flags = fcntl(pfd[0], F_GETFL, 0);
    if (flags >= 0) (void)fcntl(pfd[0], F_SETFL, flags | O_NONBLOCK);
    json_dyn_buf out = {0};
    char buf[8192];
    int st = 0, done = 0, killed = 0, reaped = 0;
    long long deadline = web_now_ms() + (timeout_ms > 0 ? timeout_ms : WEB_HELPER_SEARCH_TIMEOUT_MS);
    while (!done) {
        ssize_t r;
        while ((r = read(pfd[0], buf, sizeof buf)) > 0) {
            if (out.len + (size_t)r > 2 * 1024 * 1024) {
                killed = 1;
                kill(pid, SIGKILL);
                break;
            }
            if (!json_dyn_putn(&out, buf, (size_t)r)) {
                free(out.ptr);
                out.ptr = NULL;
                killed = 1;
                kill(pid, SIGKILL);
                break;
            }
        }
        if (killed) break;
        if (r == 0) { done = 1; break; }
        if (r < 0 && errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR) break;

        pid_t wp = waitpid(pid, &st, WNOHANG);
        if (wp == pid) {
            reaped = 1;
            done = 1;
            while ((r = read(pfd[0], buf, sizeof buf)) > 0) {
                if (out.len + (size_t)r > 2 * 1024 * 1024) break;
                if (!json_dyn_putn(&out, buf, (size_t)r)) { free(out.ptr); out.ptr = NULL; break; }
            }
            break;
        }
        if (wp < 0 && errno != EINTR) break;

        long long left = deadline - web_now_ms();
        if (left <= 0) {
            killed = 1;
            kill(pid, SIGKILL);
            break;
        }
        struct pollfd pf = { pfd[0], POLLIN | POLLHUP, 0 };
        int wait_ms = left > 250 ? 250 : (int)left;
        (void)poll(&pf, 1, wait_ms);
    }
    close(pfd[0]);
    if (killed) kill(pid, SIGKILL);
    if (!reaped) waitpid(pid, &st, 0);
    if (killed) {
        free(out.ptr);
        if (exit_status) *exit_status = 124;
        return strdup("{\"error\":\"web helper timed out\"}");
    }
    if (exit_status) *exit_status = WIFEXITED(st) ? WEXITSTATUS(st) : 127;
    return out.ptr ? out.ptr : ds4_strdup_local("");
#endif
}

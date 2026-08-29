/* ============================================================================
 * Vision provider (one-shot Qwen3.8-27B Q8 on MLX).
 *
 * ds4 is text-only at every layer (engine takes token IDs only; ds4-server
 * fail-closes 400 on image content blocks). Image understanding is therefore
 * delegated to a local Qwen3.8 multimodal worker.  It is deliberately one-shot:
 * the caller releases DS4 residency, the worker loads the pinned MLX Q8 model,
 * handles the complete multi-image request, and exits before DS4 is restored.
 * Qwen3.8, Ideogram 4, HunyuanImage and H3 share one heavyweight-model lock.
 *
 *   POST /api/vision/setup    — install mlx-vlm and the pinned Q8 snapshot
 *   POST /api/vision/describe — run {images[]|data_uri|image_b64|path,
 *                               question?} through one isolated worker
 *   POST /api/vision/stop     — stop an active one-shot worker
 *   GET  /api/vision/status   — install/worker state and disk usage
 *
 * Both chat preprocessing and the agent/design see_image tools hit the same
 * endpoint. There is no smaller-model fallback and no persistent vision server.
 * ==========================================================================*/
#define VISION_PORT 0
#define VISION_MODEL "mlx-community/Qwen3.8-27B-8bit"
#define VISION_MODEL_REVISION "815b83c0df8ffd1d1b5244cf75fd6ef14fca9ef9"
#define VISION_HF_DEFAULT VISION_MODEL
/* Multi-image describe cap: 4 images at >=1024 image tokens each still fit the
 * sidecar's default context (DSTUDIO_VISION_CTX 12288) with room to answer. */
#define VISION_MAX_IMAGES 4

#ifndef _WIN32
/* Install dir of the MLX runtime and one-shot pid marker. */
static void vision_dir_path(char *out, size_t outsz) {
    const char *env = getenv("DSTUDIO_QWEN38_VISION_HOME");
    if (env && env[0]) { cstr_copy(out, outsz, env); return; }
    const char *home = getenv("HOME");
    snprintf(out, outsz, "%s/.dstudio/qwen38-vision", home ? home : ".");
}

/* Idle-stop stamp: scripts/vision-server.sh's watchdog shuts the sidecar down
 * when this file has not been touched for DSTUDIO_VISION_IDLE_MIN minutes.
 * Touched on every vision request so active use keeps the server alive. */
static void vision_touch_last_use(void) {
    char dir[DSTUDIO_PATH_MAX];
    vision_dir_path(dir, sizeof dir);
    char parent[DSTUDIO_PATH_MAX];
    const char *home = getenv("HOME");
    snprintf(parent, sizeof parent, "%s/.dstudio", home ? home : ".");
    (void)mkdir(parent, 0755);
    (void)mkdir(dir, 0755);
    char stamp[DSTUDIO_PATH_MAX + 16];
    snprintf(stamp, sizeof stamp, "%s/.last-use", dir);
    int fd = open(stamp, O_WRONLY | O_CREAT, 0644);
    if (fd >= 0) close(fd);
    (void)utimes(stamp, NULL);
}

/* PID of the active one-shot worker (0 = none). */
static pid_t vision_lock_pid(void) {
    char p[DSTUDIO_PATH_MAX + 16];
    vision_dir_path(p, sizeof p);
    size_t l = strlen(p);
    snprintf(p + l, sizeof p - l, "/.runner.pid");
    size_t n = 0;
    char *b = jsonl_read_file(p, &n);
    if (!b) return 0;
    long pid = strtol(b, NULL, 10);
    free(b);
    return pid > 1 ? (pid_t)pid : 0;
}

/* A stale pid file may name an unrelated process: verify its full command. */
static int vision_pid_is_llama(pid_t pid) {
    if (pid <= 1 || kill(pid, 0) != 0) return 0;
    char cmd[64];
    snprintf(cmd, sizeof cmd, "ps -p %d -o command=", (int)pid);
    FILE *f = popen(cmd, "r");
    if (!f) return 0;
    char line[512] = "";
    if (!fgets(line, sizeof line, f)) line[0] = '\0';
    pclose(f);
    return strstr(line, "vision-qwen38-run.py") != NULL;
}

/* Stop the verified one-shot worker, if one is currently loading/inferencing. */
static int vision_kill_server(void) {
    pid_t pid = vision_lock_pid();
    if (!vision_pid_is_llama(pid)) return 0;
    kill(pid, SIGTERM);
    for (int i = 0; i < 20; i++) {              /* up to ~2s of polite wait */
        struct timespec ts = { 0, 100 * 1000000 };
        nanosleep(&ts, NULL);
        if (kill(pid, 0) != 0) break;
    }
    if (kill(pid, 0) == 0) kill(pid, SIGKILL);
    char p[DSTUDIO_PATH_MAX + 16];
    vision_dir_path(p, sizeof p);
    size_t l = strlen(p);
    snprintf(p + l, sizeof p - l, "/.runner.pid");
    unlink(p);
    return 1;
}

/* Compatibility name used by PDF/status callers: verify the exact Qwen3.8
 * runtime marker and return its Python executable. */
static int vision_scan_for_bin(const char *dir, int depth, char *out, size_t outsz) {
    (void)depth;
    char python[DSTUDIO_PATH_MAX], marker[DSTUDIO_PATH_MAX];
    snprintf(python, sizeof python, "%s/venv/bin/python", dir);
    snprintf(marker, sizeof marker, "%s/.model-revision", dir);
    struct stat st;
    if (stat(python, &st) != 0 || !S_ISREG(st.st_mode) || access(python, X_OK) != 0) return 0;
    size_t n = 0;
    char *revision = jsonl_read_file(marker, &n);
    int ok = revision && !strncmp(revision, VISION_MODEL_REVISION, strlen(VISION_MODEL_REVISION));
    free(revision);
    if (ok) cstr_copy(out, outsz, python);
    return ok;
}

/* Recursive size of a directory tree (regular files only, bounded depth) —
 * surfaces how much disk the runtime + cached model take. */
static long long vision_tree_bytes(const char *dir, int depth) {
    if (depth > 6) return 0;
    DIR *d = opendir(dir);
    if (!d) return 0;
    struct dirent *e;
    long long sum = 0;
    while ((e = readdir(d)) != NULL) {
        if (!strcmp(e->d_name, ".") || !strcmp(e->d_name, "..")) continue;
        char p[DSTUDIO_PATH_MAX];
        if ((size_t)snprintf(p, sizeof p, "%s/%s", dir, e->d_name) >= sizeof p) continue;
        struct stat st;
        if (lstat(p, &st) != 0) continue;
        if (S_ISDIR(st.st_mode)) sum += vision_tree_bytes(p, depth + 1);
        else if (S_ISREG(st.st_mode)) sum += (long long)st.st_size;
    }
    closedir(d);
    return sum;
}

/* Hugging Face hub root used by the pinned MLX snapshot. */
static void vision_model_cache_path(char *out, size_t outsz) {
    const char *hub = getenv("HF_HUB_CACHE");
    if (hub && hub[0]) { cstr_copy(out, outsz, hub); return; }
    const char *hfhome = getenv("HF_HOME");
    if (hfhome && hfhome[0]) { snprintf(out, outsz, "%s/hub", hfhome); return; }
    const char *home = getenv("HOME");
    snprintf(out, outsz, "%s/.cache/huggingface/hub", home ? home : ".");
}

/* Recent llama.cpp builds download -hf models into the Hugging Face hub cache
 * (~/.cache/huggingface/hub/models--<owner>--<repo>), NOT into LLAMA_CACHE —
 * without counting it, Settings reports "0 bytes" with multiple GB on disk. */
static long long vision_hf_hub_bytes(const char *hf) {
    if (!hf || !hf[0]) return 0;
    char id[256];
    size_t o = 0;
    /* "owner/repo:QUANT" → "owner--repo" (the :quant suffix picks a file, it is
     * not part of the hub directory name). */
    for (const char *p = hf; *p && *p != ':' && o < sizeof id - 3; p++) {
        if (*p == '/') { id[o++] = '-'; id[o++] = '-'; }
        else id[o++] = *p;
    }
    id[o] = '\0';
    char root[DSTUDIO_PATH_MAX];
    const char *hub = getenv("HF_HUB_CACHE");
    const char *hfhome = getenv("HF_HOME");
    const char *home = getenv("HOME");
    if (hub && hub[0]) cstr_copy(root, sizeof root, hub);
    else if (hfhome && hfhome[0]) snprintf(root, sizeof root, "%s/hub", hfhome);
    else snprintf(root, sizeof root, "%s/.cache/huggingface/hub", home ? home : ".");
    char dir[DSTUDIO_PATH_MAX + 300];
    snprintf(dir, sizeof dir, "%s/models--%s", root, id);
    return vision_tree_bytes(dir, 0);
}

/* There is no TCP sidecar. "Open" means the one-shot worker is alive. */
static int vision_port_open(void) {
    return vision_pid_is_llama(vision_lock_pid());
}

/* Ready means the exact pinned runtime is installed. Loading is intentionally
 * deferred until a request has acquired the heavyweight-model lock. */
static int vision_server_ready(void) {
    char dir[DSTUDIO_PATH_MAX], bin[DSTUDIO_PATH_MAX];
    vision_dir_path(dir, sizeof dir);
    return vision_scan_for_bin(dir, 0, bin, sizeof bin);
}

/* Compatibility helper for PDF callers: verify that the pinned one-shot
 * runtime is installed. It never starts or downloads a fallback model. */
static int vision_ensure_server(int timeout_ms) {
    (void)timeout_ms;
    return vision_server_ready();
}

/* POST /api/vision/describe — proxy an image to the local vision sidecar. */
/* Minimal base64 encoder (used for the path branch: read an image file
 * server-side and inline it as a data: URI). */
static char *base64_encode(const unsigned char *data, size_t len) {
    static const char T[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    size_t olen = 4 * ((len + 2) / 3);
    char *out = malloc(olen + 1);
    if (!out) return NULL;
    size_t o = 0;
    for (size_t i = 0; i < len; i += 3) {
        unsigned int v = (unsigned int)data[i] << 16;
        if (i + 1 < len) v |= (unsigned int)data[i + 1] << 8;
        if (i + 2 < len) v |= (unsigned int)data[i + 2];
        out[o++] = T[(v >> 18) & 63];
        out[o++] = T[(v >> 12) & 63];
        out[o++] = (i + 1 < len) ? T[(v >> 6) & 63] : '=';
        out[o++] = (i + 2 < len) ? T[v & 63] : '=';
    }
    out[o] = '\0';
    return out;
}

static const char *vision_mime_for(const char *path) {
    const char *dot = strrchr(path, '.');
    if (!dot) return "image/png";
    char ext[8] = {0};
    size_t j = 0;
    for (const char *p = dot + 1; *p && j < sizeof ext - 1; p++) ext[j++] = (char)tolower((unsigned char)*p);
    if (!strcmp(ext, "jpg") || !strcmp(ext, "jpeg")) return "image/jpeg";
    if (!strcmp(ext, "webp")) return "image/webp";
    if (!strcmp(ext, "gif"))  return "image/gif";
    if (!strcmp(ext, "bmp"))  return "image/bmp";
    return "image/png";
}

/* Normalize one image source (a data: URI or bare base64) into a malloc'd
 * data: URI. */
static char *vision_data_url_from(const char *image) {
    if (!image || !image[0]) return NULL;
    char *out = NULL;
    if (strncmp(image, "data:", 5) == 0) {
        size_t need = strlen(image) + 1;
        if ((out = malloc(need))) memcpy(out, image, need);
    } else {
        size_t need = strlen(image) + 40;
        if ((out = malloc(need))) snprintf(out, need, "data:image/png;base64,%s", image);
    }
    return out;
}

static void vision_free_urls(char **urls, int n) {
    for (int i = 0; i < n; i++) free(urls[i]);
}

/* Read an image FILE server-side into a malloc'd "data:<mime>;base64,…" URI
 * (NULL on read/oom failure). Callers gate on allow_path — a file read on
 * behalf of a non-loopback client would be arbitrary host-file disclosure. */
static char *vision_data_url_from_file(const char *path) {
    size_t ilen = 0;
    char *bytes = jsonl_read_file(path, &ilen);
    if (!bytes || ilen == 0) { free(bytes); return NULL; }
    char *b64 = base64_encode((const unsigned char *)bytes, ilen);
    free(bytes);
    if (!b64) return NULL;
    const char *mime = vision_mime_for(path);
    size_t need = strlen(b64) + strlen(mime) + 24;
    char *u = malloc(need);
    if (u) snprintf(u, need, "data:%s;base64,%s", mime, b64);
    free(b64);
    return u;
}

/* Parse `"<key>":["...", ...]` from the request body — up to max entries,
 * malloc'd into out[]; returns the count (0 when the key is absent). Elements
 * are data: URIs / base64 / file paths straight from JSON.stringify, so only
 * the basic string escapes need handling. */
static int vision_parse_str_array(const char *body, const char *key, char **out, int max) {
    char pat[32];
    int patlen = snprintf(pat, sizeof pat, "\"%s\"", key);
    if (patlen <= 0 || (size_t)patlen >= sizeof pat) return 0;
    const char *p = body ? strstr(body, pat) : NULL;
    while (p && p > body && p[-1] == '\\') p = strstr(p + 1, pat);
    if (!p) return 0;
    p += patlen;
    while (*p == ' ' || *p == '\t' || *p == '\r' || *p == '\n') p++;
    if (*p != ':') return 0;
    p++;
    while (*p == ' ' || *p == '\t' || *p == '\r' || *p == '\n') p++;
    if (*p != '[') return 0;
    p++;
    int n = 0;
    while (n < max) {
        while (*p == ' ' || *p == '\t' || *p == '\r' || *p == '\n' || *p == ',') p++;
        if (*p != '"') break;
        p++;
        size_t cap = 4096, len = 0;
        char *s = malloc(cap);
        if (!s) break;
        int ok = 1;
        while (*p && *p != '"') {
            char c = *p++;
            if (c == '\\' && *p) {
                char e = *p++;
                switch (e) {
                    case 'n': c = '\n'; break;
                    case 't': c = '\t'; break;
                    case 'r': c = '\r'; break;
                    case 'u':
                        /* data URIs never carry \u escapes; skip the 4 hex
                         * digits and emit a placeholder to stay in sync. */
                        for (int k = 0; k < 4 && *p; k++) p++;
                        c = '?';
                        break;
                    default:  c = e; break;   /* \" \\ \/ */
                }
            }
            if (len + 2 > cap) {
                cap *= 2;
                char *ns = realloc(s, cap);
                if (!ns) { ok = 0; break; }
                s = ns;
            }
            s[len++] = c;
        }
        if (*p == '"') p++;
        if (!ok || !len) { free(s); break; }
        s[len] = '\0';
        out[n++] = s;
    }
    return n;
}

/* POST /api/vision/describe — image source is images[] (up to
 * VISION_MAX_IMAGES, one joint request so the model can compare them) |
 * data_uri | image_b64 | path. `path` is read + base64'd server-side (used by
 * the agent see_image tool, so the agent needs no base64/JSON code of its own)
 * and is HOST-LOCAL ONLY: for non-loopback clients (allow_path 0) it would be
 * arbitrary host-file disclosure, so only inline data is accepted from them.
 * format:"text" → respond text/plain with the description; otherwise JSON
 * {ok,text}. */
static void api_vision_describe_run(int fd, const char *body, int allow_path) {
    char fmt[16] = "";
    (void)json_get_string(body, "format", fmt, sizeof fmt);
    int want_text = !strcmp(fmt, "text");

    char *urls[VISION_MAX_IMAGES];   /* malloc'd data: URIs */
    int nimg = 0;
    char *raw[VISION_MAX_IMAGES];
    int nraw = vision_parse_str_array(body, "images", raw, VISION_MAX_IMAGES);
    if (nraw > 0) {
        for (int i = 0; i < nraw; i++) {
            char *u = vision_data_url_from(raw[i]);
            free(raw[i]);
            if (u) urls[nimg++] = u;
        }
    } else {
        char *image = json_get_string_alloc_rpc(body, "data_uri");
        if (!image) image = json_get_string_alloc_rpc(body, "image_b64");
        /* "paths":[...] — several host-local files in ONE joint describe (the
         * design visual check sends desktop+mobile renders together). Same
         * trust boundary as the single `path`: loopback only. */
        char *rpaths[VISION_MAX_IMAGES];
        int npaths = (image && image[0]) ? 0
                     : vision_parse_str_array(body, "paths", rpaths, VISION_MAX_IMAGES);
        if (image && image[0]) {
            char *u = vision_data_url_from(image);
            if (u) urls[nimg++] = u;
        } else if (npaths > 0) {
            if (!allow_path) {
                for (int i = 0; i < npaths; i++) free(rpaths[i]);
                free(image);
                if (want_text) send_text(fd, "403 Forbidden", "see_image error: paths are host-local only\n", 0);
                else web_json_error(fd, "403 Forbidden", "paths are host-local only; send data URIs instead");
                return;
            }
            for (int i = 0; i < npaths; i++) {
                char *u = vision_data_url_from_file(rpaths[i]);
                free(rpaths[i]);
                if (u) urls[nimg++] = u;
            }
        } else {
            char *path = json_get_string_alloc_rpc(body, "path");
            if (path && path[0] && !allow_path) {
                free(image); free(path);
                if (want_text) send_text(fd, "403 Forbidden", "see_image error: path is host-local only\n", 0);
                else web_json_error(fd, "403 Forbidden", "path is host-local only; send data_uri instead");
                return;
            }
            if (path && path[0]) {
                char *u = vision_data_url_from_file(path);
                if (!u) {
                    free(image); free(path);
                    if (want_text) send_text(fd, "400 Bad Request", "see_image error: cannot read image file\n", 0);
                    else web_json_error(fd, "400 Bad Request", "cannot read image path");
                    return;
                }
                urls[nimg++] = u;
            }
            free(path);
        }
        free(image);
    }
    if (nimg == 0) {
        if (want_text) send_text(fd, "400 Bad Request", "see_image error: no image (path/data_uri) supplied\n", 0);
        else web_json_error(fd, "400 Bad Request", "images, data_uri, image_b64, or path is required");
        return;
    }

    /* Frame the visual task in English for stable cross-language grading while
     * preserving the caller's original request inside the frame. */
    char qbuf[4096];
    int has_q = json_get_string(body, "question", qbuf, sizeof qbuf) && qbuf[0];
    /* frame:"raw" — send the caller's question VERBATIM, without the
     * describe-only anti-hallucination wrapper. QA-style callers (the design
     * visual check) need grading semantics; the cautious "state only what is
     * clearly visible, admit uncertainty" frame makes the model acquit obvious
     * defects ("not ideal but not impossible to read"). */
    char framebuf[16] = "";
    (void)json_get_string(body, "frame", framebuf, sizeof framebuf);
    int raw_frame = has_q && !strcmp(framebuf, "raw");
    char question[5500];
    /* Anti-hallucination framing (measured on real images): told to "answer the
     * question", the small VL model over-commits — wrong connector types, invented
     * "connected/plugged" relationships, phantom counts. Grounding it in "describe
     * only clearly-visible facts, don't infer connections, admit uncertainty" is
     * far more accurate; the question only STEERS attention, it does not force a
     * committed answer. English on purpose (the model refuses non-English asks). */
    static const char *base =
        "You are a precise vision analyzer. Describe what is clearly visible in this image: state only "
        "facts, do NOT assume separate items are connected or plugged together unless clearly shown, "
        "name port/connector types precisely, and if a detail is too small or blurry to be sure, say "
        "you are not certain instead of guessing.";
    /* Joint multi-image request: number the images so the answer can compare
     * and cross-reference them ("what changed between these screenshots?"). */
    char multi[240] = "";
    if (nimg > 1)
        snprintf(multi, sizeof multi,
                 " You are given %d images, numbered in the order provided (Image 1 first). Briefly "
                 "describe each one, then note the differences or relations between them that matter, "
                 "referring to them as Image 1..Image %d.", nimg, nimg);
    if (raw_frame)
        snprintf(question, sizeof question, "%s", qbuf);
    else if (has_q)
        snprintf(question, sizeof question,
                 "%s%s Pay particular attention to anything relevant to this request (do not guess — say "
                 "if you cannot tell): \"%s\"", base, multi, qbuf);
    else
        snprintf(question, sizeof question, "%s%s", base, multi);

    /* The setup path installs the exact pinned snapshot. Describe never falls
     * back to another model or downloads implicitly. */
    if (!vision_ensure_server(60000)) {
        vision_free_urls(urls, nimg);
        if (want_text) send_text(fd, "503 Service Unavailable",
                                 "see_image error: Qwen3.8 vision is not installed; run vision setup once\n", 0);
        else web_json_error(fd, "503 Service Unavailable",
                       "Qwen3.8-27B Q8 is not installed; call POST /api/vision/setup once");
        return;
    }

    /* Build the one-shot worker body: one image_url content part per image,
     * then the text prompt. Max is the default and has no DStudio token or
     * thinking budget; the worker stops at EOS (with only the model's native
     * context as a hard architectural boundary). High and Off remain explicit
     * user-selectable options. */
    char reasoning[16] = "max";
    (void)json_get_string(body, "reasoning_effort", reasoning, sizeof reasoning);
    if (strcmp(reasoning, "off") && strcmp(reasoning, "high") && strcmp(reasoning, "max"))
        snprintf(reasoning, sizeof reasoning, "max");
    json_dyn_buf up = {0};
    int okb = json_dyn_puts(&up, "{\"model\":") &&
              json_dyn_put_escaped(&up, VISION_MODEL) &&
              json_dyn_puts(&up, ",\"reasoning_effort\":") &&
              json_dyn_put_escaped(&up, reasoning) &&
              json_dyn_puts(&up, ",\"messages\":[{\"role\":\"user\",\"content\":[");
    for (int i = 0; okb && i < nimg; i++) {
        okb = json_dyn_puts(&up, "{\"type\":\"image_url\",\"image_url\":{\"url\":") &&
              json_dyn_put_escaped(&up, urls[i]) &&
              json_dyn_puts(&up, "}},");
    }
    okb = okb &&
          json_dyn_puts(&up, "{\"type\":\"text\",\"text\":") &&
          json_dyn_put_escaped(&up, question) &&
          json_dyn_puts(&up, "}]}]}");
    vision_free_urls(urls, nimg);
    if (!okb) { free(up.ptr);
        if (want_text) send_text(fd, "500 Internal Server Error", "see_image error: out of memory\n", 0);
        else web_json_error(fd, "500 Internal Server Error", "out of memory");
        return; }

    /* curl cannot take a multi-MB body on argv → write it to a temp file. */
    char tmpl[] = "/tmp/dstudio-vision-req-XXXXXX";
    int tf = mkstemp(tmpl);
    if (tf < 0) { free(up.ptr);
        if (want_text) send_text(fd, "500 Internal Server Error", "see_image error: temp file\n", 0);
        else web_json_error(fd, "500 Internal Server Error", "cannot create temp file");
        return; }
    size_t total = up.len, off = 0;
    while (off < total) {
        ssize_t w = write(tf, up.ptr + off, total - off);
        if (w <= 0) break;
        off += (size_t)w;
    }
    close(tf);
    free(up.ptr);
    if (off < total) { unlink(tmpl);
        if (want_text) send_text(fd, "500 Internal Server Error", "see_image error: temp write\n", 0);
        else web_json_error(fd, "500 Internal Server Error", "cannot write temp file");
        return; }

    resolve_web_dir();
    char runner[DSTUDIO_PATH_MAX + 64];
    snprintf(runner, sizeof runner, "%s/scripts/vision-qwen38-run.sh", g_web_dir);
    char *argv[] = { "/bin/sh", runner, "--request", tmpl, NULL };

    int st = 0;
    char *resp = web_curl_capture(argv, -1, &st); /* user-controlled Stop; no wall-clock downgrade */
    unlink(tmpl);
    if (st != 0 || !resp || !resp[0]) { free(resp);
        if (want_text) send_text(fd, "502 Bad Gateway", "see_image error: Qwen3.8 worker failed\n", 0);
        else web_json_error(fd, "502 Bad Gateway", "Qwen3.8 vision worker failed");
        return; }

    char *text = json_get_string_alloc_rpc(resp, "content");
    if (!text || !text[0]) {
        free(text);
        char *cap = web_strndup_cap(resp, strlen(resp), want_text ? 1500 : 4000);
        if (want_text) {
            char msg[1800];
            snprintf(msg, sizeof msg, "see_image error: Qwen3.8 returned no content. %s\n", cap ? cap : "");
            free(cap); free(resp);
            send_text(fd, "502 Bad Gateway", msg, 0);
            return;
        }
        json_dyn_buf e = {0};
        int oke = json_dyn_puts(&e, "{\"ok\":false,\"error\":\"Qwen3.8 returned no content\",\"raw\":") &&
                  json_dyn_put_escaped(&e, cap ? cap : "") &&
                  json_dyn_puts(&e, "}");
        free(cap); free(resp);
        send_json(fd, "502 Bad Gateway", oke && e.ptr ? e.ptr : "{\"ok\":false,\"error\":\"no content\"}");
        free(e.ptr);
        return;
    }
    /* "length" can now mean only the model-native context boundary. Surface
     * that rare case so downstream code never mistakes a partial OCR for a
     * complete one. */
    char fr[24] = "";
    (void)json_get_string(resp, "finish_reason", fr, sizeof fr);
    free(resp);
    if (!strcmp(fr, "length")) {
        static const char *tnote =
            "\n\n[Note: description reached the model's native context boundary — details may be missing.]";
        size_t tl = strlen(text), nl = strlen(tnote);
        char *nt = realloc(text, tl + nl + 1);
        if (nt) { text = nt; memcpy(text + tl, tnote, nl + 1); }
    }

    if (want_text) { send_text(fd, "200 OK", text, 0); free(text); return; }

    json_dyn_buf out = {0};
    int oko = json_dyn_puts(&out, "{\"ok\":true,\"text\":") &&
              json_dyn_put_escaped(&out, text) &&
              json_dyn_puts(&out, "}");
    free(text);
    if (!oko) { free(out.ptr); web_json_error(fd, "500 Internal Server Error", "out of memory"); return; }
    send_json(fd, "200 OK", out.ptr);
    free(out.ptr);
}

/* One model only: callers cannot switch to a smaller fallback. */
static void vision_hf_pref(char *out, size_t outsz) {
    cstr_copy(out, outsz, VISION_HF_DEFAULT);
}

/* POST /api/vision/setup — install mlx-vlm and the pinned Qwen3.8 Q8 snapshot.
 * A supplied {hf} must name that exact model; alternate/fallback readers are
 * rejected so configuration cannot silently regress visual quality. */
static void api_vision_setup_run(int fd, const char *body) {
    resolve_web_dir();
    if (!web_dir_valid()) {
        send_json(fd, "409 Conflict",
                  "{\"ok\":false,\"error\":\"DStudio checkout not found; cannot locate scripts/vision-setup.sh\"}");
        return;
    }
    char script[DSTUDIO_PATH_MAX + 64];
    snprintf(script, sizeof script, "%s/scripts/vision-setup.sh", g_web_dir);
    struct stat stt;
    if (stat(script, &stt) != 0) {
        send_json(fd, "500 Internal Server Error", "{\"ok\":false,\"error\":\"scripts/vision-setup.sh missing\"}");
        return;
    }

    char hf[200] = "";
    if (body && json_get_string(body, "hf", hf, sizeof hf) && hf[0]) {
        if (strcmp(hf, VISION_MODEL) != 0) {
            send_json(fd, "400 Bad Request",
                      "{\"ok\":false,\"error\":\"only mlx-community/Qwen3.8-27B-8bit is supported\"}");
            return;
        }
    }

    char *argv[] = { "/bin/sh", script, NULL };
    char log_tail[8192] = "";
    int rc = setup_run_cmd_capture(g_web_dir, argv, log_tail, sizeof log_tail);
    vision_touch_last_use();
    int installed = rc == 0 && vision_server_ready();
    int ok = rc == 0 && installed;
    const char *err = rc != 0 ? "vision runtime install failed (see log)"
                    : !installed ? "pinned Qwen3.8 Q8 snapshot is incomplete"
                    : "";

    char hf_now[200];
    vision_hf_pref(hf_now, sizeof hf_now);
    json_dyn_buf b = {0};
    char *cap = web_strndup_cap(log_tail, strlen(log_tail), 6000);
    int good = json_dyn_puts(&b, "{\"ok\":") &&
               json_dyn_puts(&b, ok ? "true" : "false") &&
               json_dyn_printf(&b, ",\"exit\":%d,\"serverUp\":false,\"oneShot\":true,\"installed\":%s,\"hf\":",
                               rc, installed ? "true" : "false") &&
               json_dyn_put_escaped(&b, hf_now) &&
               json_dyn_puts(&b, ",\"model\":") &&
               json_dyn_put_escaped(&b, VISION_MODEL) &&
               json_dyn_puts(&b, ",\"error\":") &&
               json_dyn_put_escaped(&b, err) &&
               json_dyn_puts(&b, ",\"log\":") &&
               json_dyn_put_escaped(&b, cap ? cap : "") &&
               json_dyn_puts(&b, "}");
    free(cap);
    if (!good) { free(b.ptr); send_json(fd, "500 Internal Server Error", "{\"ok\":false,\"error\":\"out of memory\"}"); return; }
    send_json(fd, ok ? "200 OK" : "500 Internal Server Error", b.ptr);
    free(b.ptr);
}

/* Both vision handlers fork a detached worker (vision inference + the one-time
 * runtime install are slow) so the single-threaded main loop is never blocked —
 * same pattern as api_http_probe. */
static void api_vision_fork(int fd, const char *body, int is_setup, int allow_path) {
    pid_t pid = fork();
    if (pid < 0) { if (is_setup) api_vision_setup_run(fd, body); else api_vision_describe_run(fd, body, allow_path); return; }
    if (pid == 0) {
        if (fork() > 0) _exit(0);
        if (g_srv_fd >= 0) close(g_srv_fd);
        if (g_out_fd >= 0) close(g_out_fd);
        if (g_err_fd >= 0) close(g_err_fd);
        if (g_in_fd  >= 0) close(g_in_fd);
        struct timeval tv = { 30 * 60, 0 };
        (void)setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof tv);
        qwen_memory_lease lease = {0};
        if (!is_setup) lease = qwen_memory_begin("vision");
        if (!is_setup && !qwen_memory_ready(&lease)) {
            char fmt[16] = "";
            (void)json_get_string(body, "format", fmt, sizeof fmt);
            if (!strcmp(fmt, "text"))
                send_text(fd, "503 Service Unavailable",
                          "see_image error: DS4 memory could not be released; Qwen3.8 was not started\n", 0);
            else
                web_json_error(fd, "503 Service Unavailable",
                               "DS4 memory could not be released; Qwen3.8 was not started");
        } else if (is_setup) api_vision_setup_run(fd, body);
        else               api_vision_describe_run(fd, body, allow_path);
        qwen_memory_end(&lease);
        close(fd);
        _exit(0);
    }
    waitpid(pid, NULL, 0);
}
#endif /* !_WIN32 */

static void api_vision_describe(int fd, const char *body) {
#ifdef _WIN32
    (void)body;
    web_json_error(fd, "501 Not Implemented", "vision is not available in the Windows build yet");
#else
    /* Every request keeps the idle-stop watchdog fed; `path` sources stay
     * host-local (arbitrary-file disclosure for a LAN peer otherwise). */
    vision_touch_last_use();
    api_vision_fork(fd, body, 0, client_is_loopback(fd));
#endif
}

static void api_vision_setup(int fd, const char *body) {
#ifdef _WIN32
    (void)body;
    send_json(fd, "409 Conflict", "{\"ok\":false,\"error\":\"vision setup is not supported on the Windows build yet\"}");
#else
    api_vision_fork(fd, body, 1, 1);
#endif
}

/* POST /api/vision/stop — stop the sidecar now (Settings action / doctor). It
 * restarts on demand at the next describe; with the model already cached that
 * is a matter of seconds. */
static void api_vision_stop(int fd) {
#ifdef _WIN32
    send_json(fd, "409 Conflict", "{\"ok\":false,\"error\":\"vision is not supported on the Windows build yet\"}");
#else
    int stopped = vision_kill_server();
    send_json(fd, "200 OK", stopped ? "{\"ok\":true,\"stopped\":true}"
                                    : "{\"ok\":true,\"stopped\":false,\"error\":\"not running\"}");
#endif
}

/* GET /api/vision/status — host-local status surface for Settings and the
 * doctor: install state, server state, model pref, disk usage, and the tail of
 * the sidecar log (turns the multi-GB first download from a blind toast into
 * visible progress). */
static void api_vision_status(int fd) {
#ifdef _WIN32
    send_json(fd, "200 OK",
              "{\"ok\":true,\"supported\":false,\"installed\":false,\"state\":\"unsupported\","
              "\"pid\":0,\"diskBytes\":0,\"cacheBytes\":0,\"lastUse\":0,\"hf\":\"\",\"logTail\":\"\"}");
#else
    char dir[DSTUDIO_PATH_MAX];
    vision_dir_path(dir, sizeof dir);
    char bin[DSTUDIO_PATH_MAX] = "";
    int installed = vision_scan_for_bin(dir, 0, bin, sizeof bin);
    pid_t pid = vision_lock_pid();
    int pid_live = vision_pid_is_llama(pid);
    const char *state = pid_live ? "running" : installed ? "ready" : "missing";
    long long run_bytes = installed ? vision_tree_bytes(dir, 0) : 0;
    char cache[DSTUDIO_PATH_MAX];
    vision_model_cache_path(cache, sizeof cache);
    char hf[200];
    vision_hf_pref(hf, sizeof hf);
    long long cache_bytes = vision_hf_hub_bytes(hf);
    char stamp[DSTUDIO_PATH_MAX + 16];
    snprintf(stamp, sizeof stamp, "%s/.last-use", dir);
    struct stat st;
    long long last_use = stat(stamp, &st) == 0 ? (long long)st.st_mtime : 0;

    char tail[1600] = "";
    FILE *lf = fopen("/tmp/dstudio-vision.log", "r");
    if (lf) {
        if (fseek(lf, 0, SEEK_END) == 0) {
            long sz = ftell(lf);
            long want = (long)sizeof tail - 1;
            long from = sz > want ? sz - want : 0;
            if (fseek(lf, from, SEEK_SET) == 0) {
                size_t got = fread(tail, 1, sizeof tail - 1, lf);
                tail[got] = '\0';
            }
        }
        fclose(lf);
    }

    json_dyn_buf b = {0};
    int okb = json_dyn_printf(&b, "{\"ok\":true,\"supported\":true,\"oneShot\":true,\"installed\":%s,\"state\":",
                              installed ? "true" : "false") &&
              json_dyn_put_escaped(&b, state) &&
              json_dyn_printf(&b, ",\"pid\":%d,\"port\":0,\"diskBytes\":%lld,\"cacheBytes\":%lld,"
                                  "\"lastUse\":%lld,\"hf\":",
                              pid_live ? (int)pid : 0, run_bytes, cache_bytes, last_use) &&
              json_dyn_put_escaped(&b, hf) &&
              json_dyn_puts(&b, ",\"revision\":") && json_dyn_put_escaped(&b, VISION_MODEL_REVISION) &&
              json_dyn_puts(&b, ",\"dir\":") && json_dyn_put_escaped(&b, dir) &&
              json_dyn_puts(&b, ",\"cacheDir\":") && json_dyn_put_escaped(&b, cache) &&
              json_dyn_puts(&b, ",\"logTail\":") && json_dyn_put_escaped(&b, tail) &&
              json_dyn_puts(&b, "}");
    if (!okb) { free(b.ptr); web_json_error(fd, "500 Internal Server Error", "out of memory"); return; }
    send_json(fd, "200 OK", b.ptr);
    free(b.ptr);
#endif
}

/* Doctor row: 1 = installed (message describes the live state). Kept cheap —
 * no health probe beyond the ones the vision section already provides. */
static int vision_doctor_row(char *msg, size_t msgsz) {
#ifdef _WIN32
    cstr_copy(msg, msgsz, "Not supported on the Windows build yet.");
    return 0;
#else
    char dir[DSTUDIO_PATH_MAX];
    vision_dir_path(dir, sizeof dir);
    char bin[DSTUDIO_PATH_MAX] = "";
    if (!vision_scan_for_bin(dir, 0, bin, sizeof bin)) {
        cstr_copy(msg, msgsz,
                  "Not installed. Optional: local image understanding for chat attachments and the "
                  "agent's see_image tool — attach an image in chat, or install it from Settings.");
        return 0;
    }
    char hf[200];
    vision_hf_pref(hf, sizeof hf);
    if (vision_port_open())
        snprintf(msg, msgsz, "Running %s in an isolated one-shot worker; DS4 residency is suspended.", hf);
    else
        snprintf(msg, msgsz, "Installed (%s). Loads on demand and exits completely after each visual batch.", hf);
    return 1;
#endif
}

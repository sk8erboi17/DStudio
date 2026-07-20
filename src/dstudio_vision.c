/* ============================================================================
 * Vision provider (local llama.cpp sidecar).
 *
 * ds4 is text-only at every layer (engine takes token IDs only; ds4-server
 * fail-closes 400 on image content blocks). Image understanding is therefore
 * delegated to a local vision model server (llama-server + Qwen2.5-VL,
 * OpenAI-compatible) that runs as a SEPARATE sidecar process on VISION_PORT —
 * a different runtime, so it never trips ds4's single-instance lock. The exact
 * incantation lives in scripts/vision-server.sh (launch + idle watchdog) and
 * scripts/vision-setup.sh (install) so it is easy to adjust without touching
 * this C.
 *
 *   POST /api/vision/setup    — install the llama.cpp runtime (on demand);
 *                               {hf} switches the vision model (3B <-> 7B)
 *   POST /api/vision/describe — proxy {images[]|data_uri|image_b64|path,
 *                               question?} to the sidecar, return the text
 *   POST /api/vision/stop     — stop the sidecar now (it restarts on demand)
 *   GET  /api/vision/status   — install/server state, disk usage, log tail
 *
 * Both the chat preprocess path (browser) and the agent see_image tool (C) hit
 * /api/vision/describe, so the sidecar wiring lives in one place. Every
 * describe/setup touches $VISION_DIR/.last-use; the launch script's watchdog
 * stops an idle sidecar so the multi-GB model does not stay resident forever.
 * ==========================================================================*/
#define VISION_PORT 28100
/* llama-server ignores the request's "model" field (it serves the loaded GGUF),
 * so any label works. The actual model is chosen in scripts/vision-server.sh. */
#define VISION_MODEL "qwen2.5-vl"
/* Keep in sync with the HFREPO default in scripts/vision-server.sh: a model
 * pref written to $VISION_DIR/.hf (via /api/vision/setup {hf}) overrides both. */
#define VISION_HF_DEFAULT "ggml-org/Qwen2.5-VL-7B-Instruct-GGUF"
/* Multi-image describe cap: 4 images at >=1024 image tokens each still fit the
 * sidecar's default context (DSTUDIO_VISION_CTX 12288) with room to answer. */
#define VISION_MAX_IMAGES 4

#ifndef _WIN32
/* Install dir of the vision sidecar (llama-server + lockfile + prefs). Must
 * match the DSTUDIO_VISION_DIR default in scripts/vision-*.sh. */
static void vision_dir_path(char *out, size_t outsz) {
    const char *env = getenv("DSTUDIO_VISION_DIR");
    if (env && env[0]) { cstr_copy(out, outsz, env); return; }
    const char *home = getenv("HOME");
    snprintf(out, outsz, "%s/.dstudio/llama-vision", home ? home : ".");
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

/* PID of the running llama-server from the launcher's lockfile (0 = none). */
static pid_t vision_lock_pid(void) {
    char p[DSTUDIO_PATH_MAX + 16];
    vision_dir_path(p, sizeof p);
    size_t l = strlen(p);
    snprintf(p + l, sizeof p - l, "/.server.pid");
    size_t n = 0;
    char *b = jsonl_read_file(p, &n);
    if (!b) return 0;
    long pid = strtol(b, NULL, 10);
    free(b);
    return pid > 1 ? (pid_t)pid : 0;
}

/* A reboot can hand a lockfile pid to an unrelated process: never signal it
 * without checking that the pid actually runs llama-server. */
static int vision_pid_is_llama(pid_t pid) {
    if (pid <= 1 || kill(pid, 0) != 0) return 0;
    char cmd[64];
    snprintf(cmd, sizeof cmd, "ps -p %d -o comm=", (int)pid);
    FILE *f = popen(cmd, "r");
    if (!f) return 0;
    char line[512] = "";
    if (!fgets(line, sizeof line, f)) line[0] = '\0';
    pclose(f);
    return strstr(line, "llama-server") != NULL;
}

/* SIGTERM (then SIGKILL) the sidecar named by the lockfile. Returns 1 when a
 * verified llama-server was stopped. The launcher's watchdog notices the child
 * exit and removes the lockfile; unlinking here too is harmless. */
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
    snprintf(p + l, sizeof p - l, "/.server.pid");
    unlink(p);
    return 1;
}

/* Locate the installed llama-server under the vision dir (the release tarball
 * layout varies across llama.cpp builds, so scan a few levels). */
static int vision_scan_for_bin(const char *dir, int depth, char *out, size_t outsz) {
    if (depth > 5) return 0;
    DIR *d = opendir(dir);
    if (!d) return 0;
    struct dirent *e;
    int found = 0;
    while (!found && (e = readdir(d)) != NULL) {
        if (!strcmp(e->d_name, ".") || !strcmp(e->d_name, "..")) continue;
        char p[DSTUDIO_PATH_MAX];
        if ((size_t)snprintf(p, sizeof p, "%s/%s", dir, e->d_name) >= sizeof p) continue;
        struct stat st;
        if (stat(p, &st) != 0) continue;
        if (S_ISDIR(st.st_mode)) found = vision_scan_for_bin(p, depth + 1, out, outsz);
        else if (S_ISREG(st.st_mode) && !strcmp(e->d_name, "llama-server")) {
            cstr_copy(out, outsz, p);
            found = 1;
        }
    }
    closedir(d);
    return found;
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

/* Where llama-server's -hf downloader caches the GGUFs (not inside the vision
 * dir): $LLAMA_CACHE, else the per-OS user cache. */
static void vision_model_cache_path(char *out, size_t outsz) {
    const char *env = getenv("LLAMA_CACHE");
    if (env && env[0]) { cstr_copy(out, outsz, env); return; }
    const char *home = getenv("HOME");
    if (!home) home = ".";
#ifdef __APPLE__
    snprintf(out, outsz, "%s/Library/Caches/llama.cpp", home);
#else
    const char *xdg = getenv("XDG_CACHE_HOME");
    if (xdg && xdg[0]) snprintf(out, outsz, "%s/llama.cpp", xdg);
    else snprintf(out, outsz, "%s/.cache/llama.cpp", home);
#endif
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

/* Non-blocking-ish TCP connect probe: is the sidecar listening on loopback? */
static int vision_port_open(void) {
    int s = socket(AF_INET, SOCK_STREAM, 0);
    if (s < 0) return 0;
    struct sockaddr_in a;
    memset(&a, 0, sizeof a);
    a.sin_family = AF_INET;
    a.sin_port = htons(VISION_PORT);
    a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    struct timeval tv = { 1, 0 };
    (void)setsockopt(s, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof tv);
    (void)setsockopt(s, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof tv);
    int ok = connect(s, (struct sockaddr *)&a, sizeof a) == 0;
    close(s);
    return ok;
}

/* True only when the sidecar is FULLY ready: llama-server binds the port before
 * the model finishes loading and answers 503 "Loading model" meanwhile, so a bare
 * TCP check isn't enough — GET /health and require 200. */
static int vision_server_ready(void) {
    int s = socket(AF_INET, SOCK_STREAM, 0);
    if (s < 0) return 0;
    struct sockaddr_in a;
    memset(&a, 0, sizeof a);
    a.sin_family = AF_INET;
    a.sin_port = htons(VISION_PORT);
    a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    struct timeval tv = { 3, 0 };
    (void)setsockopt(s, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof tv);
    (void)setsockopt(s, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof tv);
    if (connect(s, (struct sockaddr *)&a, sizeof a) != 0) { close(s); return 0; }
    static const char *req = "GET /health HTTP/1.0\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n";
    if (write(s, req, strlen(req)) < 0) { close(s); return 0; }
    char buf[64];
    ssize_t n = read(s, buf, sizeof buf - 1);
    close(s);
    if (n <= 0) return 0;
    buf[n] = '\0';
    return strstr(buf, " 200") != NULL;   /* "HTTP/1.1 200 OK" */
}

/* Launch scripts/vision-server.sh detached (double-fork → reparents to init).
 * Callers gate on vision_port_open() first. Output → /tmp/dstudio-vision.log. */
static int vision_spawn_detached(void) {
    if (!g_web_dir[0]) return 0;
    char script[DSTUDIO_PATH_MAX + 64];
    snprintf(script, sizeof script, "%s/scripts/vision-server.sh", g_web_dir);
    struct stat stt;
    if (stat(script, &stt) != 0) return 0;
    pid_t pid = fork();
    if (pid < 0) return 0;
    if (pid == 0) {
        if (fork() > 0) _exit(0);       /* grandchild survives us, reparents to init */
        setsid();
        if (chdir(g_web_dir) != 0) _exit(127);
        child_setenv_metal();           /* Metal/MPS env for the vision runtime */
        /* Close EVERY inherited fd (the DStudio instance-lock fd, the HTTP
         * listener, engine pipes, sockets). This sidecar is long-lived and
         * detached, so any fd it kept open would outlive DStudio — in particular
         * the instance-lock fd, which would then block the next app launch. */
        for (int cfd = 3; cfd < 256; cfd++) close(cfd);
        int dn = open("/dev/null", O_RDWR);
        if (dn >= 0) { dup2(dn, STDIN_FILENO); if (dn != STDIN_FILENO) close(dn); }
        int lg = open("/tmp/dstudio-vision.log", O_WRONLY | O_CREAT | O_APPEND, 0644);
        if (lg >= 0) { dup2(lg, STDOUT_FILENO); dup2(lg, STDERR_FILENO); if (lg > STDERR_FILENO) close(lg); }
        char *argv[] = { "/bin/sh", script, NULL };
        execv("/bin/sh", argv);
        _exit(127);
    }
    waitpid(pid, NULL, 0);              /* reap the immediate child */
    return 1;
}

/* Ensure the sidecar is reachable, spawning it if needed. Bounded wait in ms
 * (first run loads/downloads the model). Runs inside the forked describe/setup
 * handler, so blocking here never stalls the main server loop. */
static int vision_ensure_server(int timeout_ms) {
    if (vision_server_ready()) return 1;
    /* Spawn only if nothing is listening yet; if the port is up but still loading
     * the model (503), don't spawn a second one — just wait for /health. */
    if (!vision_port_open()) vision_spawn_detached();
    long long deadline = web_now_ms() + (timeout_ms > 0 ? timeout_ms : 120000);
    while (web_now_ms() < deadline) {
        struct timespec ts = { 0, 500 * 1000000 };  /* 500 ms */
        nanosleep(&ts, NULL);
        if (vision_server_ready()) return 1;
    }
    return 0;
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

    /* Frame the vision prompt in ENGLISH. The small Qwen2.5-VL model refuses
     * non-English requests ("Mi dispiace, non posso…") even though it sees the
     * image fine; an English frame makes it comply, and it can still address a
     * request written in another language when embedded here. */
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

    /* Short safety-net only: the heavy one-time model download happens in
     * /api/vision/setup, so by now the sidecar is normally already serving.
     * 60s covers a restart with the model already cached, not a fresh download. */
    if (!vision_ensure_server(60000)) {
        vision_free_urls(urls, nimg);
        if (want_text) send_text(fd, "503 Service Unavailable",
                                 "see_image error: vision server is not running; run vision setup once\n", 0);
        else web_json_error(fd, "503 Service Unavailable",
                       "vision model server is not running; call POST /api/vision/setup once to install it");
        return;
    }

    /* Build the upstream OpenAI chat body: one image_url content part per
     * image, then the text prompt. temperature 0: perception/OCR is a factual
     * task — greedy decoding is more precise and hallucinates fewer invented
     * details. max_tokens is higher for the agent's text format, where dense
     * OCR transcriptions were hitting the old 1024 cap; callers with denser
     * output (the PDF page reader) can raise it further via the request's
     * max_tokens — the sidecar ctx (12288) has room for a 4k answer. */
    long mt = want_text ? 1536 : 1024;
    (void)json_get_int(body, "max_tokens", 256, 4096, &mt);
    json_dyn_buf up = {0};
    int okb = json_dyn_puts(&up, "{\"model\":") &&
              json_dyn_put_escaped(&up, VISION_MODEL) &&
              json_dyn_printf(&up, ",\"max_tokens\":%d,\"temperature\":0,"
                                   "\"messages\":[{\"role\":\"user\",\"content\":[",
                              (int)mt);
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

    char url[80];  snprintf(url, sizeof url, "http://127.0.0.1:%d/v1/chat/completions", VISION_PORT);
    char dataarg[80]; snprintf(dataarg, sizeof dataarg, "@%s", tmpl);
    char *argv[16]; int n = 0;
    argv[n++] = "curl"; argv[n++] = "-sS"; argv[n++] = "-X"; argv[n++] = "POST";
    argv[n++] = "-H"; argv[n++] = "Content-Type: application/json";
    argv[n++] = "--data-binary"; argv[n++] = dataarg;
    argv[n++] = "--max-time"; argv[n++] = "300";
    argv[n++] = url; argv[n] = NULL;

    int st = 0;
    char *resp = web_curl_capture(argv, 310000, &st);
    unlink(tmpl);
    if (!resp || !resp[0]) { free(resp);
        if (want_text) send_text(fd, "502 Bad Gateway", "see_image error: vision server did not respond\n", 0);
        else web_json_error(fd, "502 Bad Gateway", "vision server did not respond");
        return; }

    char *text = json_get_string_alloc_rpc(resp, "content");
    if (!text || !text[0]) {
        free(text);
        char *cap = web_strndup_cap(resp, strlen(resp), want_text ? 1500 : 4000);
        if (want_text) {
            char msg[1800];
            snprintf(msg, sizeof msg, "see_image error: vision server returned no content. %s\n", cap ? cap : "");
            free(cap); free(resp);
            send_text(fd, "502 Bad Gateway", msg, 0);
            return;
        }
        json_dyn_buf e = {0};
        int oke = json_dyn_puts(&e, "{\"ok\":false,\"error\":\"vision server returned no content\",\"raw\":") &&
                  json_dyn_put_escaped(&e, cap ? cap : "") &&
                  json_dyn_puts(&e, "}");
        free(cap); free(resp);
        send_json(fd, "502 Bad Gateway", oke && e.ptr ? e.ptr : "{\"ok\":false,\"error\":\"no content\"}");
        free(e.ptr);
        return;
    }
    /* Silent truncation is worse than a longer answer: when generation stopped
     * at max_tokens (finish_reason "length"), say so, so the model downstream
     * knows the description (e.g. a dense OCR transcription) is incomplete. */
    char fr[24] = "";
    (void)json_get_string(resp, "finish_reason", fr, sizeof fr);
    free(resp);
    if (!strcmp(fr, "length")) {
        static const char *tnote =
            "\n\n[Note: description truncated at the token limit — details may be missing.]";
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

/* Current vision model pref: $VISION_DIR/.hf when present (written below on a
 * {hf} switch and read by scripts/vision-server.sh), else the built-in default. */
static void vision_hf_pref(char *out, size_t outsz) {
    char p[DSTUDIO_PATH_MAX + 8];
    vision_dir_path(p, sizeof p);
    size_t l = strlen(p);
    snprintf(p + l, sizeof p - l, "/.hf");
    size_t n = 0;
    char *b = jsonl_read_file(p, &n);
    if (b) {
        while (n > 0 && (b[n - 1] == '\n' || b[n - 1] == '\r' || b[n - 1] == ' ')) b[--n] = '\0';
        if (b[0]) { cstr_copy(out, outsz, b); free(b); return; }
        free(b);
    }
    cstr_copy(out, outsz, VISION_HF_DEFAULT);
}

/* POST /api/vision/setup — install the llama.cpp runtime on demand
 * (scripts/vision-setup.sh), then warm the sidecar so the first describe is
 * fast. Optional body {hf:"owner/Repo-GGUF"} switches the vision model (e.g.
 * Qwen2.5-VL 3B <-> 7B): the pref is persisted to $VISION_DIR/.hf, a running
 * sidecar is stopped so the warm-up below reloads with the new model. */
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
        int sane = strchr(hf, '/') != NULL && strlen(hf) > 3;
        for (const char *p = hf; sane && *p; p++)
            if (!isalnum((unsigned char)*p) && !strchr("._/-", *p)) sane = 0;
        if (!sane) {
            send_json(fd, "400 Bad Request", "{\"ok\":false,\"error\":\"invalid hf repo\"}");
            return;
        }
        char cur[200];
        vision_hf_pref(cur, sizeof cur);
        if (strcmp(cur, hf) != 0) {
            char dir[DSTUDIO_PATH_MAX];
            vision_dir_path(dir, sizeof dir);
            char parent[DSTUDIO_PATH_MAX];
            const char *home = getenv("HOME");
            snprintf(parent, sizeof parent, "%s/.dstudio", home ? home : ".");
            (void)mkdir(parent, 0755);
            (void)mkdir(dir, 0755);
            char pref[DSTUDIO_PATH_MAX + 8];
            snprintf(pref, sizeof pref, "%s/.hf", dir);
            if (!jsonl_write_file(pref, hf, strlen(hf))) {
                send_json(fd, "500 Internal Server Error", "{\"ok\":false,\"error\":\"cannot write model pref\"}");
                return;
            }
            /* The running sidecar still serves the old model: stop it so the
             * warm-up below loads the new one. */
            (void)vision_kill_server();
        }
    }

    char *argv[] = { "/bin/sh", script, NULL };
    char log_tail[8192] = "";
    int rc = setup_run_cmd_capture(g_web_dir, argv, log_tail, sizeof log_tail);
    /* Warm the sidecar AS PART OF SETUP: this triggers + completes the one-time
     * model download (multi-GB, llama.cpp -hf) and BLOCKS until the server is
     * actually serving, so every later /api/vision/describe is instant. Long cap
     * because a fresh download can take many minutes on a slow link. */
    vision_touch_last_use();
    int server_up = (rc == 0) ? vision_ensure_server(1000000) : 0;   /* ~16 min */
    if (server_up) vision_touch_last_use();   /* warm-up counts as use for the idle watchdog */
    int ok = rc == 0 && server_up;
    const char *err = rc != 0 ? "vision runtime install failed (see log)"
                    : !server_up ? "vision model did not come up in time (download too slow?); retry"
                    : "";

    char hf_now[200];
    vision_hf_pref(hf_now, sizeof hf_now);
    json_dyn_buf b = {0};
    char *cap = web_strndup_cap(log_tail, strlen(log_tail), 6000);
    int good = json_dyn_puts(&b, "{\"ok\":") &&
               json_dyn_puts(&b, ok ? "true" : "false") &&
               json_dyn_printf(&b, ",\"exit\":%d,\"serverUp\":%s,\"hf\":", rc, server_up ? "true" : "false") &&
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
        struct timeval tv = { 620, 0 };
        (void)setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof tv);
        if (is_setup) api_vision_setup_run(fd, body);
        else          api_vision_describe_run(fd, body, allow_path);
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
    const char *state = "stopped";
    if (vision_server_ready()) state = "ready";
    else if (vision_port_open() || pid_live) state = "starting";
    long long run_bytes = installed ? vision_tree_bytes(dir, 0) : 0;
    char cache[DSTUDIO_PATH_MAX];
    vision_model_cache_path(cache, sizeof cache);
    char hf[200];
    vision_hf_pref(hf, sizeof hf);
    long long cache_bytes = vision_tree_bytes(cache, 0) + vision_hf_hub_bytes(hf);
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
    int okb = json_dyn_printf(&b, "{\"ok\":true,\"supported\":true,\"installed\":%s,\"state\":",
                              installed ? "true" : "false") &&
              json_dyn_put_escaped(&b, state) &&
              json_dyn_printf(&b, ",\"pid\":%d,\"port\":%d,\"diskBytes\":%lld,\"cacheBytes\":%lld,"
                                  "\"lastUse\":%lld,\"hf\":",
                              pid_live ? (int)pid : 0, VISION_PORT, run_bytes, cache_bytes, last_use) &&
              json_dyn_put_escaped(&b, hf) &&
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
    if (vision_server_ready())
        snprintf(msg, msgsz, "Serving %s — used by chat image attachments and the agent's see_image tool.", hf);
    else if (vision_port_open() || vision_pid_is_llama(vision_lock_pid()))
        snprintf(msg, msgsz, "Starting (%s) — loading or downloading the model.", hf);
    else
        snprintf(msg, msgsz, "Installed (%s). Starts on demand at the first image and stops itself when idle.", hf);
    return 1;
#endif
}

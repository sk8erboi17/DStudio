/* ============================================================================
 * Cowork over the LAN.
 *
 * Off by default, and off again at every start. With LAN access on and Cowork
 * running, the host user shares that running Cowork session (its folder) from
 * the host UI. A browser on another device pairs once with a one-time code
 * shown on the host and then sends a bearer token. A paired device may only:
 * read the sharing status, send prompts, read the transcript, stop the turn and
 * upload attachments into the shared folder, and only while the host runs
 * Cowork in that same folder. Agent, Design, shell, settings, models, other
 * folders and the session store stay host-local.
 *
 * Secrets: a pairing code is 8 digits, single use, valid 10 minutes and voided
 * after 5 wrong attempts; only its SHA-256 is kept. A device token is 32
 * random bytes; only its SHA-256 is stored (data dir, lan-cowork-devices.json,
 * mode 0600) and compared in constant time. Revoking a device deletes its hash.
 * Included by dstudio.c after dstudio_remote.c (one translation unit).
 * ==========================================================================*/

#define LAN_COWORK_DEVICES_MAX 16
#define LAN_COWORK_CODE_SECONDS 600
#define LAN_COWORK_CODE_ATTEMPTS 5

typedef struct {
    char id[17];
    char name[64];
    char hash[65];          /* SHA-256 of the token, lowercase hex */
    long long created, last_used;
} lan_cowork_device;

static struct {
    int enabled;
    char workdir[1024];
    char code_hash[65];
    long long code_expires;
    int code_attempts;
    lan_cowork_device devices[LAN_COWORK_DEVICES_MAX];
    int ndevices;
    int loaded;
} g_lan_cowork;


/* ---- SHA-256 (FIPS 180-4) ---- */
typedef struct { uint32_t h[8]; uint64_t len; unsigned char buf[64]; size_t fill; } lan_sha256;

static uint32_t lan_ror(uint32_t x, int n) { return (x >> n) | (x << (32 - n)); }

static void lan_sha256_block(lan_sha256 *s, const unsigned char *p) {
    static const uint32_t k[64] = {
        0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
        0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
        0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
        0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
        0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
        0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
        0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
        0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2};
    uint32_t w[64];
    for (int i = 0; i < 16; i++)
        w[i] = (uint32_t)p[4*i] << 24 | (uint32_t)p[4*i+1] << 16 | (uint32_t)p[4*i+2] << 8 | p[4*i+3];
    for (int i = 16; i < 64; i++) {
        uint32_t s0 = lan_ror(w[i-15], 7) ^ lan_ror(w[i-15], 18) ^ (w[i-15] >> 3);
        uint32_t s1 = lan_ror(w[i-2], 17) ^ lan_ror(w[i-2], 19) ^ (w[i-2] >> 10);
        w[i] = w[i-16] + s0 + w[i-7] + s1;
    }
    uint32_t a = s->h[0], b = s->h[1], c = s->h[2], d = s->h[3], e = s->h[4], f = s->h[5], g = s->h[6], h = s->h[7];
    for (int i = 0; i < 64; i++) {
        uint32_t t1 = h + (lan_ror(e, 6) ^ lan_ror(e, 11) ^ lan_ror(e, 25)) + ((e & f) ^ (~e & g)) + k[i] + w[i];
        uint32_t t2 = (lan_ror(a, 2) ^ lan_ror(a, 13) ^ lan_ror(a, 22)) + ((a & b) ^ (a & c) ^ (b & c));
        h = g; g = f; f = e; e = d + t1; d = c; c = b; b = a; a = t1 + t2;
    }
    s->h[0] += a; s->h[1] += b; s->h[2] += c; s->h[3] += d; s->h[4] += e; s->h[5] += f; s->h[6] += g; s->h[7] += h;
}

static void lan_sha256_hex(const void *data, size_t n, char out[65]) {
    lan_sha256 s = {{0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19}, 0, {0}, 0};
    const unsigned char *p = data;
    s.len = (uint64_t)n * 8;
    for (; n >= 64; p += 64, n -= 64) lan_sha256_block(&s, p);
    unsigned char tail[128] = {0};
    memcpy(tail, p, n);
    tail[n] = 0x80;
    size_t blocks = n + 9 <= 64 ? 1 : 2;
    for (int i = 0; i < 8; i++) tail[blocks * 64 - 1 - i] = (unsigned char)(s.len >> (8 * i));
    for (size_t i = 0; i < blocks; i++) lan_sha256_block(&s, tail + 64 * i);
    for (int i = 0; i < 8; i++) snprintf(out + 8 * i, 9, "%08x", s.h[i]);
}

/* Constant-time equality of two 64-character hex digests. */
static int lan_digest_equal(const char *a, const char *b) {
    unsigned char diff = 0;
    for (int i = 0; i < 64; i++) diff |= (unsigned char)(a[i] ^ b[i]);
    return diff == 0 && a[64] == '\0' && b[64] == '\0';
}

static int lan_random_bytes(unsigned char *out, size_t n) {
#ifdef _WIN32
    (void)out; (void)n;
    return 0;
#else
    FILE *f = fopen("/dev/urandom", "rb");
    if (!f) return 0;
    size_t got = fread(out, 1, n, f);
    fclose(f);
    return got == n;
#endif
}

/* ---- paired devices (explicit JSON, never a struct dump) ---- */
static int lan_cowork_devices_path(char *out, size_t outsz) {
    char dir[DSTUDIO_PATH_MAX];
    if (!dstudio_data_dir_path(dir, sizeof dir)) return 0;
    return snprintf(out, outsz, "%s/lan-cowork-devices.json", dir) < (int)outsz;
}

static void lan_cowork_load(void) {
    if (g_lan_cowork.loaded) return;
    g_lan_cowork.loaded = 1;
    char path[DSTUDIO_PATH_MAX];
    if (!lan_cowork_devices_path(path, sizeof path)) return;
    size_t n = 0;
    char *text = jsonl_read_file(path, &n);
    if (!text) return;
    if (!strstr(text, "\"format\":\"dstudio.lan-cowork-devices.v1\"")) { free(text); return; }
    for (const char *p = strstr(text, "{\"id\":"); p && g_lan_cowork.ndevices < LAN_COWORK_DEVICES_MAX;
         p = strstr(p + 1, "{\"id\":")) {
        lan_cowork_device d = {0};
        const char *end = strchr(p, '}');
        if (!end) break;
        size_t len = (size_t)(end - p) + 1;
        char *obj = malloc(len + 1);
        if (!obj) break;
        memcpy(obj, p, len); obj[len] = '\0';
        json_get_string(obj, "id", d.id, sizeof d.id);
        json_get_string(obj, "name", d.name, sizeof d.name);
        json_get_string(obj, "tokenSha256", d.hash, sizeof d.hash);
        const char *c = strstr(obj, "\"created\":"), *u = strstr(obj, "\"lastUsed\":");
        d.created = c ? atoll(c + 10) : 0;
        d.last_used = u ? atoll(u + 11) : 0;
        free(obj);
        int ok = strlen(d.id) == 16 && strlen(d.hash) == 64;
        for (int i = 0; ok && i < 64; i++) ok = isxdigit((unsigned char)d.hash[i]) && !isupper((unsigned char)d.hash[i]);
        if (ok) g_lan_cowork.devices[g_lan_cowork.ndevices++] = d;
    }
    free(text);
}

static int lan_cowork_save(void) {
#ifdef _WIN32
    return 0;
#else
    char path[DSTUDIO_PATH_MAX], tmp[DSTUDIO_PATH_MAX + 16], dir[DSTUDIO_PATH_MAX];
    if (!lan_cowork_devices_path(path, sizeof path) || !dstudio_data_dir_path(dir, sizeof dir)) return 0;
    mkpath(dir);
    json_dyn_buf b = {0};
    int ok = json_dyn_puts(&b, "{\"format\":\"dstudio.lan-cowork-devices.v1\",\"devices\":[");
    for (int i = 0; ok && i < g_lan_cowork.ndevices; i++) {
        const lan_cowork_device *d = &g_lan_cowork.devices[i];
        ok = json_dyn_printf(&b, "%s{\"id\":\"%s\",\"name\":", i ? "," : "", d->id) &&
             json_dyn_put_escaped(&b, d->name) &&
             json_dyn_printf(&b, ",\"tokenSha256\":\"%s\",\"created\":%lld,\"lastUsed\":%lld}", d->hash, d->created, d->last_used);
    }
    ok = ok && json_dyn_puts(&b, "]}\n");
    snprintf(tmp, sizeof tmp, "%s.tmp", path);
    if (ok) unlink(tmp);   /* a leftover from an interrupted save */
    int f = ok ? open(tmp, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0600) : -1;
    size_t len = ok ? strlen(b.ptr) : 0, off = 0;
    while (f >= 0 && off < len) { ssize_t w = write(f, b.ptr + off, len - off); if (w <= 0) break; off += (size_t)w; }
    if (f >= 0 && (fsync(f) != 0 || off != len)) off = (size_t)-1;
    if (f >= 0) close(f);
    ok = f >= 0 && off == len && rename(tmp, path) == 0;
    if (!ok) unlink(tmp);
    free(b.ptr);
    return ok;
#endif
}

/* Sharing is live only while the host runs Cowork in the shared folder. */
static int lan_cowork_sharing(void) {
    return g_lan_cowork.enabled && g_mode == ENGINE_COWORK && g_workdir[0] &&
           !strcmp(g_workdir, g_lan_cowork.workdir) && strcmp(g_bind_host, "127.0.0.1") != 0;
}

/* The paths a paired device may use (methods checked by the routes). */
static int lan_cowork_device_path(const char *path) {
    return path_eq_clean(path, "/api/lan/cowork/status") || path_eq_clean(path, "/api/agent/send") ||
           !strncmp(path, "/api/agent/poll", 15) || path_eq_clean(path, "/api/agent/interrupt") ||
           path_eq_clean(path, "/api/cowork/attach-file");
}

/* The device a valid bearer token belongs to, or -1. */
static int lan_cowork_device_for(const char *req, size_t hlen) {
    char auth[200];
    if (request_header_value(req, hlen, "authorization", auth, sizeof auth) != 1 ||
        strncmp(auth, "Bearer ", 7) || strlen(auth + 7) != 64) return -1;
    char hash[65];
    lan_sha256_hex(auth + 7, 64, hash);
    lan_cowork_load();
    int found = -1;
    for (int i = 0; i < g_lan_cowork.ndevices; i++)
        if (lan_digest_equal(hash, g_lan_cowork.devices[i].hash)) found = i;
    return found;
}

static void lan_cowork_new_code(char code[9]) {
    unsigned char r[8];
    if (!lan_random_bytes(r, sizeof r)) { code[0] = '\0'; return; }
    uint64_t v = 0;
    for (int i = 0; i < 8; i++) v = v << 8 | r[i];
    snprintf(code, 9, "%08llu", (unsigned long long)(v % 100000000ULL));
    lan_sha256_hex(code, 8, g_lan_cowork.code_hash);
    g_lan_cowork.code_expires = (long long)time(NULL) + LAN_COWORK_CODE_SECONDS;
    g_lan_cowork.code_attempts = 0;
}

static void lan_cowork_reply_state(int fd, const char *code) {
    lan_cowork_load();
    json_dyn_buf b = {0};
    long long left = g_lan_cowork.code_hash[0] ? g_lan_cowork.code_expires - (long long)time(NULL) : 0;
    int ok = json_dyn_printf(&b, "{\"ok\":true,\"enabled\":%s,\"sharing\":%s,\"lan\":%s,\"workdir\":",
                             g_lan_cowork.enabled ? "true" : "false", lan_cowork_sharing() ? "true" : "false",
                             strcmp(g_bind_host, "127.0.0.1") ? "true" : "false") &&
             json_dyn_put_escaped(&b, g_lan_cowork.workdir) &&
             json_dyn_printf(&b, ",\"pairingExpiresIn\":%lld,\"pairingCode\":", left > 0 ? left : 0) &&
             (code && code[0] ? json_dyn_put_escaped(&b, code) : json_dyn_puts(&b, "null")) &&
             json_dyn_puts(&b, ",\"devices\":[");
    for (int i = 0; ok && i < g_lan_cowork.ndevices; i++) {
        const lan_cowork_device *d = &g_lan_cowork.devices[i];
        ok = json_dyn_printf(&b, "%s{\"id\":\"%s\",\"name\":", i ? "," : "", d->id) && json_dyn_put_escaped(&b, d->name) &&
             json_dyn_printf(&b, ",\"created\":%lld,\"lastUsed\":%lld}", d->created, d->last_used);
    }
    ok = ok && json_dyn_puts(&b, "]}");
    if (ok) send_json(fd, "200 OK", b.ptr);
    else send_json(fd, "500 Internal Server Error", "{\"ok\":false,\"error\":\"out of memory\"}");
    free(b.ptr);
}

/* Host-local: GET state; POST {enable} shares the running Cowork folder and
 * shows a new pairing code; {pair:true} only renews the code. */
static void api_lan_cowork(int fd, const char *method, const char *body) {
#ifdef _WIN32
    /* Durable device-list replacement and attachments are POSIX-only here. */
    (void)method; (void)body;
    send_json(fd, "501 Not Implemented", "{\"ok\":false,\"error\":\"Cowork over the LAN is not available in the Windows build yet\"}");
    return;
#endif
    lan_cowork_load();
    if (!strcmp(method, "GET")) { lan_cowork_reply_state(fd, NULL); return; }
    char code[9] = "";
    int has_enable = body && strstr(body, "\"enable\"");
    if (has_enable && !json_get_bool(body, "enable")) {
        g_lan_cowork.enabled = 0;
        g_lan_cowork.code_hash[0] = '\0';
        lan_cowork_reply_state(fd, NULL);
        return;
    }
    if (has_enable) {
        if (!strcmp(g_bind_host, "127.0.0.1")) {
            send_json(fd, "409 Conflict", "{\"ok\":false,\"code\":\"lan_off\",\"error\":\"Turn on LAN access first.\"}");
            return;
        }
        if (g_mode != ENGINE_COWORK || !g_workdir[0]) {
            send_json(fd, "409 Conflict", "{\"ok\":false,\"code\":\"cowork_not_running\",\"error\":\"Start Cowork in the folder to share first.\"}");
            return;
        }
        cstr_copy(g_lan_cowork.workdir, sizeof g_lan_cowork.workdir, g_workdir);
        g_lan_cowork.enabled = 1;
    }
    if (!g_lan_cowork.enabled) {
        send_json(fd, "409 Conflict", "{\"ok\":false,\"code\":\"not_shared\",\"error\":\"Cowork is not shared on the LAN.\"}");
        return;
    }
    lan_cowork_new_code(code);
    if (!code[0]) { send_json(fd, "500 Internal Server Error", "{\"ok\":false,\"error\":\"no random source\"}"); return; }
    lan_cowork_reply_state(fd, code);
}

/* Host-local: forget one paired device. */
static void api_lan_cowork_revoke(int fd, const char *body) {
    lan_cowork_load();
    char id[32] = "";
    json_get_string(body, "id", id, sizeof id);
    int at = -1;
    for (int i = 0; i < g_lan_cowork.ndevices; i++) if (!strcmp(g_lan_cowork.devices[i].id, id)) at = i;
    if (at < 0) { send_json(fd, "404 Not Found", "{\"ok\":false,\"error\":\"unknown device\"}"); return; }
    memmove(&g_lan_cowork.devices[at], &g_lan_cowork.devices[at + 1],
            (size_t)(g_lan_cowork.ndevices - at - 1) * sizeof g_lan_cowork.devices[0]);
    g_lan_cowork.ndevices--;
    if (!lan_cowork_save()) { send_json(fd, "500 Internal Server Error", "{\"ok\":false,\"error\":\"could not save the device list\"}"); return; }
    lan_cowork_reply_state(fd, NULL);
}

/* LAN: exchange the one-time code shown on the host for a device token. */
static void api_lan_cowork_pair(int fd, const char *body) {
    lan_cowork_load();
    char code[16] = "", name[64] = "";
    json_get_string(body, "code", code, sizeof code);
    json_get_string(body, "name", name, sizeof name);
    /* A plain label: the stored list is read back without a full JSON parser. */
    for (char *c = name; *c; c++)
        if (!isalnum((unsigned char)*c) && !strchr(" ._-()", *c)) *c = ' ';
    if (!name[0]) cstr_copy(name, sizeof name, "LAN device");
    long long now = (long long)time(NULL);
    if (!g_lan_cowork.enabled || !g_lan_cowork.code_hash[0] || now > g_lan_cowork.code_expires) {
        send_json(fd, "403 Forbidden", "{\"ok\":false,\"code\":\"no_pairing\",\"error\":\"No pairing code is active. Ask the host for a new code.\"}");
        return;
    }
    char hash[65];
    lan_sha256_hex(code, strlen(code), hash);
    if (!lan_digest_equal(hash, g_lan_cowork.code_hash)) {
        if (++g_lan_cowork.code_attempts >= LAN_COWORK_CODE_ATTEMPTS) g_lan_cowork.code_hash[0] = '\0';
        send_json(fd, "403 Forbidden", "{\"ok\":false,\"code\":\"bad_code\",\"error\":\"Wrong code.\"}");
        return;
    }
    g_lan_cowork.code_hash[0] = '\0';   /* single use */
    if (g_lan_cowork.ndevices >= LAN_COWORK_DEVICES_MAX) {
        send_json(fd, "409 Conflict", "{\"ok\":false,\"error\":\"Too many paired devices; revoke one on the host.\"}");
        return;
    }
    unsigned char raw[40];
    if (!lan_random_bytes(raw, sizeof raw)) { send_json(fd, "500 Internal Server Error", "{\"ok\":false,\"error\":\"no random source\"}"); return; }
    char token[65], id[17];
    for (int i = 0; i < 32; i++) snprintf(token + 2 * i, 3, "%02x", raw[i]);
    for (int i = 0; i < 8; i++) snprintf(id + 2 * i, 3, "%02x", raw[32 + i]);
    lan_cowork_device d = {0};
    cstr_copy(d.id, sizeof d.id, id);
    cstr_copy(d.name, sizeof d.name, name);
    lan_sha256_hex(token, 64, d.hash);
    d.created = d.last_used = now;
    g_lan_cowork.devices[g_lan_cowork.ndevices++] = d;
    if (!lan_cowork_save()) {
        g_lan_cowork.ndevices--;
        send_json(fd, "500 Internal Server Error", "{\"ok\":false,\"error\":\"could not save the device list\"}");
        return;
    }
    char out[200];
    snprintf(out, sizeof out, "{\"ok\":true,\"id\":\"%s\",\"token\":\"%s\"}", id, token);
    send_json(fd, "200 OK", out);
}

/* LAN (paired): what the device needs to drive the shared session. */
static void api_lan_cowork_status(int fd) {
    const char *base = strrchr(g_lan_cowork.workdir, '/');
    json_dyn_buf b = {0};
    int ok = json_dyn_printf(&b, "{\"ok\":true,\"sharing\":%s,\"ready\":%s,\"working\":%s,\"folder\":",
                             lan_cowork_sharing() ? "true" : "false", lan_cowork_sharing() && g_ready ? "true" : "false",
                             g_agent_working ? "true" : "false") &&
             json_dyn_put_escaped(&b, base ? base + 1 : g_lan_cowork.workdir) &&
             json_dyn_puts(&b, "}");   /* the folder name only: never the host's full path */
    if (ok) send_json(fd, "200 OK", b.ptr);
    else send_json(fd, "500 Internal Server Error", "{\"ok\":false}");
    free(b.ptr);
}

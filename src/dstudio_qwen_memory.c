/* Temporary DS4 memory lease for local Qwen pipelines. The persistent
 * Off/Auto/On preference is never mutated; the patched engine only suspends
 * residency and page-cache while the lease is active. */

typedef struct {
    int acquired;
    const char *purpose;
} qwen_memory_lease;

static int qwen_memory_should_yield(const char *purpose, char *reason, size_t reasonsz) {
    const unsigned long long gib = 1024ull * 1024ull * 1024ull;
    unsigned long long ram = dstudio_physical_memory_bytes();
    long long model = current_model_file_size();
    unsigned long long reserve = 16ull * gib;
    if (purpose && !strcmp(purpose, "image-generation")) reserve = 48ull * gib;
    else if (purpose && !strcmp(purpose, "vision")) reserve = 12ull * gib;

    if (g_remote_base_url[0] || g_mode != ENGINE_SERVER || g_child <= 0) {
        snprintf(reason, reasonsz, "no local ds4-server lease target");
        return 0;
    }
#if defined(__APPLE__)
    const char *backend = "metal";
#elif defined(_WIN32)
    const char *backend = "cpu/cuda";
#else
    const char *backend = "cuda/rocm/cpu";
#endif
    int pressure = ram == 0 || model < 0 ||
                   (unsigned long long)model + reserve + 8ull * gib > ram * 82ull / 100ull ||
                   (unsigned long long)model > ram * 60ull / 100ull;
    snprintf(reason, reasonsz,
             "%s ram=%.1fGiB model=%.1fGiB reserve=%.1fGiB decision=%s",
             backend, (double)ram / (double)gib, (double)model / (double)gib,
             (double)reserve / (double)gib, pressure ? "yield" : "keep-resident");
    return pressure;
}

static int qwen_memory_post(int begin) {
    int port = g_cfg.port > 0 ? g_cfg.port : ENGINE_DEFAULTS.port;
    int s = socket(AF_INET, SOCK_STREAM, 0);
    if (s < 0) return 0;
    struct sockaddr_in a;
    memset(&a, 0, sizeof a);
    a.sin_family = AF_INET;
    a.sin_port = htons((uint16_t)port);
    a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    struct timeval tv = { 60, 0 };
    (void)setsockopt(s, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof tv);
    (void)setsockopt(s, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof tv);
    if (connect(s, (struct sockaddr *)&a, sizeof a) != 0) { close(s); return 0; }
    char req[512];
    int n = snprintf(req, sizeof req,
                     "POST /v1/dstudio/memory-pressure/%s HTTP/1.0\r\n"
                     "Host: 127.0.0.1:%d\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                     begin ? "begin" : "end", port);
    int ok = n > 0 && (size_t)n < sizeof req && write(s, req, (size_t)n) == n;
    char response[256] = "";
    ssize_t got = ok ? read(s, response, sizeof response - 1) : -1;
    close(s);
    if (got <= 0) return 0;
    response[got] = '\0';
    return strstr(response, " 200 ") != NULL;
}

static qwen_memory_lease qwen_memory_begin(const char *purpose) {
    qwen_memory_lease lease = {0, purpose};
    char reason[256];
    if (!qwen_memory_should_yield(purpose, reason, sizeof reason)) {
        dstudio_log_event("info", "qwen-memory", 0, "Qwen %s: %s",
                          purpose ? purpose : "pipeline", reason);
        return lease;
    }
    lease.acquired = qwen_memory_post(1);
    dstudio_log_event(lease.acquired ? "info" : "warn", "qwen-memory", 0,
                      "Qwen %s: temporary SSD streaming %s (%s; saved setting=%s)",
                      purpose ? purpose : "pipeline",
                      lease.acquired ? "active" : "unavailable", reason,
                      g_cfg.ssd_streaming == SSD_STREAMING_ON ? "on" :
                      g_cfg.ssd_streaming == SSD_STREAMING_OFF ? "off" : "auto");
    return lease;
}

static void qwen_memory_end(qwen_memory_lease *lease) {
    if (!lease || !lease->acquired) return;
    int ok = qwen_memory_post(0);
    dstudio_log_event(ok ? "info" : "warn", "qwen-memory", 0,
                      "Qwen %s: temporary SSD streaming %s; persistent setting unchanged",
                      lease->purpose ? lease->purpose : "pipeline",
                      ok ? "released" : "release failed");
    lease->acquired = 0;
}

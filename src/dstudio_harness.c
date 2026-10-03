/* Third-party coding-agent harnesses (pi, opencode) run as the Agent runtime
 * through DStudio's bridge (src/harness/bridge). Ownership:
 *   - installation: scripts/install-harness.py, an explicit background child
 *     started here (its dependency download is the only networked step);
 *   - verification: the launch preparation worker, never the HTTP loop;
 *   - the running bridge: g_child, leader of its own process group.
 * The HTTP loop only reads receipts (bounded, a few KiB) and polls one
 * installer child. Nothing here holds model weights. */

#define HARNESS_DIR "harness"
#define HARNESS_BRIDGE "bridge/dstudio-harness.mjs"
#define HARNESS_RECEIPT_MAX (64 * 1024)

static int harness_name_valid(const char *name) {
    return name && (!strcmp(name, "pi") || !strcmp(name, "opencode"));
}

/* <parent of the engine installation>/harness, beside ds4/ and llama.cpp/. */
static int harness_root_dir(const char *engine_dir, char *out, size_t cap) {
    const char *slash = resident_last_separator(engine_dir);
    if (!resident_path_absolute(engine_dir) || !slash || slash == engine_dir) return 0;
    int n = snprintf(out, cap, "%.*s/%s", (int)(slash - engine_dir), engine_dir, HARNESS_DIR);
    return n > 0 && (size_t)n < cap;
}

static int harness_bridge_path(const char *engine_dir, char *out, size_t cap) {
    char root[1024];
    if (!harness_root_dir(engine_dir, root, sizeof root)) return 0;
    int n = snprintf(out, cap, "%s/%s", root, HARNESS_BRIDGE);
    return n > 0 && (size_t)n < cap;
}

/* The pinned snapshots: a source checkout holds them under src/harness; a
 * release bundle keeps them in Resources/HarnessSources, outside the support
 * payload that is copied at every launch. */
static int harness_sources_root(char *out, size_t cap) {
    char probe[DSTUDIO_PATH_MAX + 64];
    snprintf(probe, sizeof probe, "%s/src/harness/manifest.json", g_web_dir);
    if (g_web_dir[0] && access(probe, R_OK) == 0) { cstr_copy(out, cap, g_web_dir); return 1; }
#ifdef __APPLE__
    char exe[DSTUDIO_PATH_MAX]; cstr_copy(exe, sizeof exe, g_launch_executable);
    char *slash = strrchr(exe, '/');
    if (slash) {
        *slash = '\0';
        int n = snprintf(out, cap, "%s/../Resources/HarnessSources", exe);
        snprintf(probe, sizeof probe, "%s/src/harness/manifest.json", out);
        if (n > 0 && (size_t)n < cap && access(probe, R_OK) == 0) return 1;
    }
#endif
    return 0;
}

/* Bounded read of one receipt field; "" when absent or invalid. */
static void harness_receipt_field(const char *root, const char *name, const char *field, char *out, size_t cap) {
    out[0] = '\0';
    char path[DSTUDIO_PATH_MAX + 128];
    snprintf(path, sizeof path, "%s/%s/.dstudio-harness.json", root, name);
    FILE *f = fopen(path, "rb");
    if (!f) return;
    char *buf = malloc(HARNESS_RECEIPT_MAX + 1);
    size_t n = buf ? fread(buf, 1, HARNESS_RECEIPT_MAX, f) : 0;
    fclose(f);
    if (!buf) return;
    buf[n] = '\0';
    if (n < HARNESS_RECEIPT_MAX) json_get_string(buf, field, out, cap);
    free(buf);
}

/* Preparation worker only: the installer's own verification (pin, patches,
 * entry-point SHA-256 and the bridge files). */
static int harness_verify(const char *engine_dir, const char *name, char *err, size_t cap) {
    char root[1024], parent[1024], sources[DSTUDIO_PATH_MAX], script[DSTUDIO_PATH_MAX + 64], output[16384];
    if (!harness_name_valid(name) || !harness_root_dir(engine_dir, root, sizeof root)) {
        snprintf(err, cap, "Unknown harness or engine location"); return 0;
    }
    cstr_copy(parent, sizeof parent, root);
    *strrchr(parent, '/') = '\0';
    if (!harness_sources_root(sources, sizeof sources)) { snprintf(err, cap, "DStudio's bundled harness sources are missing"); return 0; }
    snprintf(script, sizeof script, "%s/scripts/install-harness.py", g_web_dir);
    /* The bridge is DStudio's own code: after an update it is copied again
     * (offline, bounded) so a built pi/opencode stays usable without a rebuild.
     * A failure here shows up in the status check below. */
    char *refresh[] = {"python3", script, "--refresh-bridge", "--root", parent, NULL};
    (void)setup_run_cmd_capture(NULL, refresh, output, sizeof output);
    char *args[] = {"python3", script, "--status", "--root", parent, "--assets", sources, NULL};
    int rc = setup_run_cmd_capture(NULL, args, output, sizeof output);
    char want[64];
    snprintf(want, sizeof want, "\"%s\": {\"installed\": true", name);
    int ok = rc == 0 && strstr(output, want) && strstr(output, "\"bridge\": {\"installed\": true") &&
        (strcmp(name, "pi") || strstr(output, "\"pi-ds4\": {\"installed\": true"));
    if (!ok) snprintf(err, cap, "The %s harness is not installed or no longer matches DStudio; install it in Settings > Harnesses", name);
    return ok;
}

/* ------------------------------------------------------------- installer */
static pid_t g_harness_install_pid = -1;
static char g_harness_installing[16] = "", g_harness_install_error[512] = "";
static char g_harness_install_log[DSTUDIO_PATH_MAX + 64] = "";

static void harness_install_tick(void) {
    if (g_harness_install_pid <= 0) return;
    int st;
    if (waitpid(g_harness_install_pid, &st, WNOHANG) != g_harness_install_pid) return;
#ifndef _WIN32
    kill(-g_harness_install_pid, SIGKILL); /* npm/bun children never outlive it */
#endif
    g_harness_install_pid = -1;
    int code = WIFEXITED(st) ? WEXITSTATUS(st) : -1;
    if (code == 0) g_harness_install_error[0] = '\0';
    else {
        /* The installer prints its reason as the last stderr line. */
        char tail[512] = "";
        FILE *f = fopen(g_harness_install_log, "rb");
        if (f) {
            fseek(f, 0, SEEK_END); long size = ftell(f);
            fseek(f, size > (long)sizeof tail - 1 ? size - (long)sizeof tail + 1 : 0, SEEK_SET);
            size_t n = fread(tail, 1, sizeof tail - 1, f); tail[n] = '\0'; fclose(f);
        }
        char *line = strstr(tail, "harness installation failed:");
        snprintf(g_harness_install_error, sizeof g_harness_install_error, "%s",
                 line ? line : code == 130 ? "Installation canceled" : "Installation failed; see the harness log");
        char *nl = strchr(g_harness_install_error, '\n'); if (nl) *nl = '\0';
    }
    printf("harness: %s installation finished (exit %d)\n", g_harness_installing, code);
    g_harness_installing[0] = '\0';
}

static void api_harness_status(int fd) {
    char root[1024], ver[64] = "", commit[64] = "";
    json_dyn_buf out = {0};
    int have_root = harness_root_dir(g_ds4_dir, root, sizeof root);
    char sources[DSTUDIO_PATH_MAX];
    json_dyn_printf(&out, "{\"ok\":true,\"bundled\":%s,\"installing\":", harness_sources_root(sources, sizeof sources) ? "true" : "false");
    json_dyn_put_escaped(&out, g_harness_installing);
    json_dyn_puts(&out, ",\"error\":"); json_dyn_put_escaped(&out, g_harness_install_error);
    json_dyn_puts(&out, ",\"active\":"); json_dyn_put_escaped(&out, g_child > 0 ? g_harness : "");
    json_dyn_puts(&out, ",\"harnesses\":{");
    const char *names[] = {"pi", "opencode"};
    for (int i = 0; i < 2; i++) {
        if (have_root) {
            harness_receipt_field(root, names[i], "version", ver, sizeof ver);
            harness_receipt_field(root, names[i], "commit", commit, sizeof commit);
        }
        json_dyn_printf(&out, "%s\"%s\":{\"installed\":%s,\"version\":", i ? "," : "", names[i], commit[0] ? "true" : "false");
        json_dyn_put_escaped(&out, ver);
        json_dyn_puts(&out, ",\"commit\":"); json_dyn_put_escaped(&out, commit);
        json_dyn_puts(&out, "}");
        ver[0] = commit[0] = '\0';
    }
    json_dyn_puts(&out, "}}");
    send_json(fd, "200 OK", out.ptr ? out.ptr : "{\"ok\":false}");
    free(out.ptr);
}

static void api_harness_install(int fd, const char *body) {
    char name[16] = "", root[1024], parent[1024], sources[DSTUDIO_PATH_MAX], script[DSTUDIO_PATH_MAX + 64];
    json_get_string(body, "harness", name, sizeof name);
    if (!harness_name_valid(name)) { send_json(fd, "400 Bad Request", "{\"ok\":false,\"error\":\"harness must be pi or opencode\"}"); return; }
    if (g_harness_install_pid > 0) { send_json(fd, "409 Conflict", "{\"ok\":false,\"error\":\"A harness installation is already running\"}"); return; }
    if (g_child > 0 && g_harness[0]) { send_json(fd, "409 Conflict", "{\"ok\":false,\"error\":\"Stop the running harness before installing or updating one\"}"); return; }
    if (!harness_root_dir(g_ds4_dir, root, sizeof root) || !harness_sources_root(sources, sizeof sources)) {
        send_json(fd, "409 Conflict", "{\"ok\":false,\"error\":\"The managed installation or DStudio's bundled harness sources are unavailable\"}"); return;
    }
    cstr_copy(parent, sizeof parent, root); *strrchr(parent, '/') = '\0';
    snprintf(script, sizeof script, "%s/scripts/install-harness.py", g_web_dir);
    mkpath(root);
    snprintf(g_harness_install_log, sizeof g_harness_install_log, "%s/install.log", root);
#ifdef _WIN32
    (void)parent; (void)script;
    send_json(fd, "501 Not Implemented", "{\"ok\":false,\"error\":\"Harness installation is not available on Windows yet\"}");
    return;
#else
    int log = open(g_harness_install_log, O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0600);
    if (log < 0) { send_json(fd, "500 Internal Server Error", "{\"ok\":false,\"error\":\"Cannot create the harness log\"}"); return; }
    pid_t pid = fork();
    if (pid < 0) { close(log); send_json(fd, "500 Internal Server Error", "{\"ok\":false,\"error\":\"Cannot start the installer\"}"); return; }
    if (!pid) {
        setpgid(0, 0);
        dup2(log, 1); dup2(log, 2);
        int null = open("/dev/null", O_RDONLY); if (null >= 0) { dup2(null, 0); close(null); }
        long maxfd = sysconf(_SC_OPEN_MAX); if (maxfd < 0) maxfd = 1024;
        for (int i = 3; i < maxfd; i++) close(i);
        execlp("python3", "python3", script, "--root", parent, "--assets", sources, "--harness", name, (char *)NULL);
        _exit(127);
    }
    setpgid(pid, pid);
    close(log);
    g_harness_install_pid = pid;
    cstr_copy(g_harness_installing, sizeof g_harness_installing, name);
    g_harness_install_error[0] = '\0';
    send_json(fd, "202 Accepted", "{\"ok\":true,\"started\":true}");
#endif
}

static void api_harness_install_cancel(int fd) {
#ifndef _WIN32
    if (g_harness_install_pid > 0) kill(-g_harness_install_pid, SIGTERM);
#endif
    send_json(fd, "200 OK", "{\"ok\":true}");
}

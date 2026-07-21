/* ============================================================================
 * On-demand installer (ds4 engine, content archives, GGUFs).
 *
 * First-run/setup flows: download and unpack the ds4 engine source and the
 * shipped content archives, resolve the GGUF cache dir, and (on Windows)
 * build the engine. Long-running steps report progress through the task/log
 * observability API so the UI can show a live installer.
 *
 * Extracted from dstudio.c into a per-domain file (one translation unit, all
 * static; same pattern as the GSA/RSA .cfrag includes).
 * ==========================================================================*/

static void setup_capture_append(char *out, size_t *used, size_t outsz, const char *buf, size_t n) {
    if (!out || outsz <= 1 || !buf || !n) return;
    if (n >= outsz - 1) {
        memcpy(out, buf + n - (outsz - 1), outsz - 1);
        *used = outsz - 1;
        out[*used] = '\0';
        return;
    }
    if (*used + n >= outsz) {
        size_t drop = *used + n - (outsz - 1);
        if (drop < *used) {
            memmove(out, out + drop, *used - drop);
            *used -= drop;
        } else {
            *used = 0;
        }
    }
    memcpy(out + *used, buf, n);
    *used += n;
    out[*used] = '\0';
}

static int setup_run_cmd_capture(const char *cwd, char *const argv[], char *out, size_t outsz) {
    if (out && outsz) out[0] = '\0';
#ifdef _WIN32
    char cmd[32768] = "";
    for (int i = 0; argv && argv[i]; i++) win_arg_append(cmd, sizeof cmd, argv[i]);
    if (!cmd[0]) {
        snprintf(out, outsz, "empty command");
        return 127;
    }

    SECURITY_ATTRIBUTES sa = { sizeof(sa), NULL, TRUE };
    HANDLE rd = NULL, wr = NULL;
    if (!CreatePipe(&rd, &wr, &sa, 0)) {
        snprintf(out, outsz, "CreatePipe failed (error %lu)", GetLastError());
        return 126;
    }
    SetHandleInformation(rd, HANDLE_FLAG_INHERIT, 0);

    STARTUPINFOA si;
    PROCESS_INFORMATION pi;
    HANDLE nul = CreateFileA("NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE,
                             &sa, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
    memset(&si, 0, sizeof si);
    memset(&pi, 0, sizeof pi);
    si.cb = sizeof si;
    si.dwFlags = STARTF_USESTDHANDLES;
    si.hStdInput = (nul != INVALID_HANDLE_VALUE) ? nul : GetStdHandle(STD_INPUT_HANDLE);
    si.hStdOutput = wr;
    si.hStdError = wr;

    BOOL ok = CreateProcessA(NULL, cmd, NULL, NULL, TRUE,
                             CREATE_NO_WINDOW, NULL,
                             (cwd && cwd[0]) ? cwd : NULL, &si, &pi);
    CloseHandle(wr);
    if (!ok) {
        DWORD e = GetLastError();
        if (nul != INVALID_HANDLE_VALUE) CloseHandle(nul);
        CloseHandle(rd);
        snprintf(out, outsz, "CreateProcess failed for %s (error %lu)", argv && argv[0] ? argv[0] : "(null)", e);
        return 127;
    }
    if (nul != INVALID_HANDLE_VALUE) CloseHandle(nul);
    CloseHandle(pi.hThread);

    size_t used = 0;
    char buf[2048];
    for (;;) {
        DWORD avail = 0;
        if (PeekNamedPipe(rd, NULL, 0, NULL, &avail, NULL) && avail > 0) {
            DWORD got = 0;
            DWORD want = avail < sizeof buf ? avail : (DWORD)sizeof buf;
            if (ReadFile(rd, buf, want, &got, NULL) && got > 0) {
                setup_capture_append(out, &used, outsz, buf, (size_t)got);
                continue;
            }
        }
        DWORD wait = WaitForSingleObject(pi.hProcess, 30);
        if (wait == WAIT_OBJECT_0) {
            for (;;) {
                DWORD left = 0;
                if (!PeekNamedPipe(rd, NULL, 0, NULL, &left, NULL) || left == 0) break;
                DWORD got = 0;
                DWORD want = left < sizeof buf ? left : (DWORD)sizeof buf;
                if (!ReadFile(rd, buf, want, &got, NULL) || got == 0) break;
                setup_capture_append(out, &used, outsz, buf, (size_t)got);
            }
            break;
        }
        if (wait == WAIT_FAILED) break;
    }

    DWORD code = 126;
    GetExitCodeProcess(pi.hProcess, &code);
    CloseHandle(pi.hProcess);
    CloseHandle(rd);
    return (int)code;
#else
    int pp[2];
    if (pipe(pp) != 0) {
        snprintf(out, outsz, "pipe failed: %s", strerror(errno));
        return 126;
    }
    pid_t pid = fork();
    if (pid < 0) {
        close(pp[0]);
        close(pp[1]);
        snprintf(out, outsz, "fork failed: %s", strerror(errno));
        return 126;
    }
    if (pid == 0) {
        if (cwd && cwd[0] && chdir(cwd) != 0) _exit(127);
        int dn = open("/dev/null", O_RDONLY);
        if (dn >= 0) { dup2(dn, STDIN_FILENO); close(dn); }
        dup2(pp[1], STDOUT_FILENO);
        dup2(pp[1], STDERR_FILENO);
        close(pp[0]);
        close(pp[1]);
        execvp(argv[0], argv);
        _exit(127);
    }
    close(pp[1]);
    size_t used = 0;
    char buf[2048];
    for (;;) {
        ssize_t n = read(pp[0], buf, sizeof buf);
        if (n > 0) setup_capture_append(out, &used, outsz, buf, (size_t)n);
        else if (n == 0) break;
        else if (errno != EINTR) break;
    }
    close(pp[0]);
    int st = 0;
    if (waitpid(pid, &st, 0) != pid) {
        setup_capture_append(out, &used, outsz, "waitpid failed\n", 15);
        return 126;
    }
    if (WIFEXITED(st)) return WEXITSTATUS(st);
    if (WIFSIGNALED(st)) return 128 + WTERMSIG(st);
    return 126;
#endif
}

static int setup_dir_empty(const char *path, int *empty) {
    DIR *d = opendir(path);
    if (!d) return 0;
    *empty = 1;
    struct dirent *e;
    while ((e = readdir(d))) {
        if (!strcmp(e->d_name, ".") || !strcmp(e->d_name, "..")) continue;
        *empty = 0;
        break;
    }
    closedir(d);
    return 1;
}

static int setup_remove_tree(const char *path) {
    struct stat st;
    if (lstat(path, &st) != 0) return errno == ENOENT;
    if (!S_ISDIR(st.st_mode)) return unlink(path) == 0;

    DIR *d = opendir(path);
    if (!d) return 0;
    int ok = 1;
    struct dirent *e;
    while ((e = readdir(d))) {
        if (!strcmp(e->d_name, ".") || !strcmp(e->d_name, "..")) continue;
        char child[DSTUDIO_PATH_MAX];
        int n = snprintf(child, sizeof child, "%s/%s", path, e->d_name);
        if (n < 0 || (size_t)n >= sizeof child || !setup_remove_tree(child)) ok = 0;
    }
    closedir(d);
    if (rmdir(path) != 0) ok = 0;
    return ok;
}

static int setup_parent_dir(const char *path, char *out, size_t outsz) {
    if (!path || !path[0] || !out || !outsz) return 0;
    int n = snprintf(out, outsz, "%s", path);
    if (n < 0 || (size_t)n >= outsz) return 0;
    char *slash = strrchr(out, '/');
#ifdef _WIN32
    char *bslash = strrchr(out, '\\');
    if (!slash || bslash > slash) slash = bslash;
#endif
    if (!slash) return 0;
    if (slash == out) slash[1] = '\0';
    else *slash = '\0';
    return 1;
}

static int setup_first_extracted_dir(const char *dir, char *out, size_t outsz) {
    DIR *d = opendir(dir);
    if (!d) return 0;
    int found = 0;
    struct dirent *e;
    while ((e = readdir(d))) {
        if (!strcmp(e->d_name, ".") || !strcmp(e->d_name, "..")) continue;
        char child[DSTUDIO_PATH_MAX];
        int n = snprintf(child, sizeof child, "%s/%s", dir, e->d_name);
        if (n < 0 || (size_t)n >= sizeof child) continue;
        struct stat st;
        if (lstat(child, &st) != 0 || !S_ISDIR(st.st_mode)) continue;
        snprintf(out, outsz, "%s", child);
        found = 1;
        break;
    }
    closedir(d);
    return found;
}

static int setup_download_ds4_archive(const char *url, const char *tag, const char *target,
                                      char *log_tail, size_t logsz,
                                      char *err, size_t errsz) {
    char parent[DSTUDIO_PATH_MAX];
    if (!setup_parent_dir(target, parent, sizeof parent)) {
        snprintf(err, errsz, "could not resolve parent folder for %s", target ? target : "(null)");
        return 0;
    }

    char archive[DSTUDIO_PATH_MAX];
    char extract[DSTUDIO_PATH_MAX];
    int n = snprintf(archive, sizeof archive, "%s/.dstudio-ds4-%s.tar.gz", parent, tag);
    int m = snprintf(extract, sizeof extract, "%s/.dstudio-ds4-extract-%ld", parent, (long)getpid());
    if (n < 0 || (size_t)n >= sizeof archive || m < 0 || (size_t)m >= sizeof extract) {
        snprintf(err, errsz, "temporary ds4 archive path is too long");
        return 0;
    }

    unlink(archive);
    setup_remove_tree(extract);
    if (mkdir(extract, 0755) != 0) {
        snprintf(err, errsz, "could not create temporary extract folder %s: %s", extract, strerror(errno));
        return 0;
    }

    char *curl_argv[] = {
        "curl", "-L", "--fail", "--show-error", "--retry", "2",
        "--connect-timeout", "20", "--max-time", "300",
        "-o", archive, (char *)url, NULL
    };
    int rc = setup_run_cmd_capture(NULL, curl_argv, log_tail, logsz);
    if (rc != 0) {
        snprintf(err, errsz,
                 "ds4 archive download failed (exit %d). DStudio setup needs curl and tar, not git. URL: %s. Output: %.7000s",
                 rc, url, log_tail && log_tail[0] ? log_tail : "(no output)");
        unlink(archive);
        setup_remove_tree(extract);
        return 0;
    }

    char *tar_argv[] = { "tar", "-xzf", archive, "-C", extract, NULL };
    rc = setup_run_cmd_capture(NULL, tar_argv, log_tail, logsz);
    if (rc != 0) {
        snprintf(err, errsz,
                 "ds4 archive extraction failed (exit %d). DStudio setup needs tar. Output: %.7600s",
                 rc, log_tail && log_tail[0] ? log_tail : "(no output)");
        unlink(archive);
        setup_remove_tree(extract);
        return 0;
    }

    char extracted[DSTUDIO_PATH_MAX];
    if (!setup_first_extracted_dir(extract, extracted, sizeof extracted)) {
        snprintf(err, errsz, "ds4 archive did not contain a source folder");
        unlink(archive);
        setup_remove_tree(extract);
        return 0;
    }

    struct stat st;
    if (stat(target, &st) == 0) {
        int empty = 0;
        if (!S_ISDIR(st.st_mode) || !setup_dir_empty(target, &empty) || !empty) {
            snprintf(err, errsz, "DStudio/ds4 exists and is not an empty folder");
            unlink(archive);
            setup_remove_tree(extract);
            return 0;
        }
        if (rmdir(target) != 0) {
            snprintf(err, errsz, "could not replace empty DStudio/ds4 folder: %s", strerror(errno));
            unlink(archive);
            setup_remove_tree(extract);
            return 0;
        }
    }

    if (rename(extracted, target) != 0) {
        snprintf(err, errsz, "could not move extracted ds4 source into %s: %s", target, strerror(errno));
        unlink(archive);
        setup_remove_tree(extract);
        return 0;
    }

    unlink(archive);
    setup_remove_tree(extract);
    return 1;
}

/* Downloads this repo's tree at the pinned content commit and installs only the
 * bundled-content dirs (skills, design-systems, gsa/third_party) under
 * extension/. Mirrors setup_download_ds4_archive: curl the codeload tarball, tar
 * -xzf into a temp dir on the SAME filesystem (so the rename is atomic), then
 * move each content dir into place. Runs in a forked child (start_content_download)
 * or synchronously on Windows. Returns 1 on success. */
static int setup_download_content_archive(char *log_tail, size_t logsz, char *err, size_t errsz) {
    if (!g_web_dir[0]) { snprintf(err, errsz, "content target unknown (extension/ not found)"); return 0; }

    char ext[DSTUDIO_PATH_MAX];
    int e = snprintf(ext, sizeof ext, "%s/extension", g_web_dir);
    if (e < 0 || (size_t)e >= sizeof ext) { snprintf(err, errsz, "extension path too long"); return 0; }

    char archive[DSTUDIO_PATH_MAX], extract[DSTUDIO_PATH_MAX];
    int n = snprintf(archive, sizeof archive, "%s/.dstudio-content-%s.tar.gz", g_web_dir, DS4_CONTENT_COMMIT);
    int m = snprintf(extract, sizeof extract, "%s/.dstudio-content-extract-%ld", g_web_dir, (long)getpid());
    if (n < 0 || (size_t)n >= sizeof archive || m < 0 || (size_t)m >= sizeof extract) {
        snprintf(err, errsz, "temporary content archive path too long");
        return 0;
    }

    unlink(archive);
    setup_remove_tree(extract);
    if (mkdir(extract, 0755) != 0) {
        snprintf(err, errsz, "could not create temp extract folder %s: %s", extract, strerror(errno));
        return 0;
    }

    char *curl_argv[] = {
        "curl", "-L", "--fail", "--show-error", "--retry", "2",
        "--connect-timeout", "20", "--max-time", "600",
        "-o", archive, (char *)DS4_CONTENT_ARCHIVE_URL, NULL
    };
    int rc = setup_run_cmd_capture(NULL, curl_argv, log_tail, logsz);
    if (rc != 0) {
        snprintf(err, errsz,
                 "content archive download failed (exit %d). DStudio setup needs curl and tar. URL: %s. Output: %.5000s",
                 rc, DS4_CONTENT_ARCHIVE_URL, log_tail && log_tail[0] ? log_tail : "(no output)");
        unlink(archive); setup_remove_tree(extract); return 0;
    }

    char *tar_argv[] = { "tar", "-xzf", archive, "-C", extract, NULL };
    rc = setup_run_cmd_capture(NULL, tar_argv, log_tail, logsz);
    if (rc != 0) {
        snprintf(err, errsz, "content archive extraction failed (exit %d). DStudio setup needs tar. Output: %.5600s",
                 rc, log_tail && log_tail[0] ? log_tail : "(no output)");
        unlink(archive); setup_remove_tree(extract); return 0;
    }

    char top[DSTUDIO_PATH_MAX];
    if (!setup_first_extracted_dir(extract, top, sizeof top)) {
        snprintf(err, errsz, "content archive did not contain a source folder");
        unlink(archive); setup_remove_tree(extract); return 0;
    }

    /* gsa/third_party needs extension/gsa to exist (harmless if it already does). */
    char gsadir[DSTUDIO_PATH_MAX];
    snprintf(gsadir, sizeof gsadir, "%s/gsa", ext);
    mkdir(gsadir, 0755);

    static const char *subs[] = { "skills", "design-systems", "gsa/third_party" };
    for (int i = 0; i < 3; i++) {
        char src[DSTUDIO_PATH_MAX], dst[DSTUDIO_PATH_MAX];
        int a = snprintf(src, sizeof src, "%s/extension/%s", top, subs[i]);
        int b = snprintf(dst, sizeof dst, "%s/%s", ext, subs[i]);
        if (a < 0 || (size_t)a >= sizeof src || b < 0 || (size_t)b >= sizeof dst) {
            snprintf(err, errsz, "content path too long for %s", subs[i]);
            unlink(archive); setup_remove_tree(extract); return 0;
        }
        struct stat sst;
        if (stat(src, &sst) != 0 || !S_ISDIR(sst.st_mode)) {
            snprintf(err, errsz, "content archive missing extension/%s", subs[i]);
            unlink(archive); setup_remove_tree(extract); return 0;
        }
        setup_remove_tree(dst);   /* replace any partial/stale copy */
        if (rename(src, dst) != 0) {
            snprintf(err, errsz, "could not install extension/%s: %s", subs[i], strerror(errno));
            unlink(archive); setup_remove_tree(extract); return 0;
        }
    }

    unlink(archive);
    setup_remove_tree(extract);
    return 1;
}

/* Kicks off the bundled-content download. On POSIX it forks a child so the
 * single-threaded server keeps serving; reap_child() observes the exit and
 * closes the task. On Windows it runs synchronously. Returns the task id (0 if
 * it could not even start). */
static unsigned long long start_content_download(void) {
    if (g_content_dl_pid > 0) return g_content_dl_task;   /* already running */
    unsigned long long task_id = task_begin("setup", "Download bundled content", "content",
                                            ENGINE_NONE, g_web_dir, 0, 0);
#ifdef _WIN32
    task_mark_working(task_id, "downloading bundled content");
    char clog[4096] = "", cerr[1024] = "";
    if (setup_download_content_archive(clog, sizeof clog, cerr, sizeof cerr))
        task_mark_completed(task_id, "bundled content installed");
    else
        task_mark_failed(task_id, "content download failed", cerr);
    return task_id;
#else
    pid_t pid = fork();
    if (pid < 0) {
        task_mark_failed(task_id, "fork failed", strerror(errno));
        return 0;
    }
    if (pid == 0) {
        int log = open("/tmp/ds4-content-dl.log", O_WRONLY | O_CREAT | O_TRUNC, 0644);
        if (log >= 0) { dup2(log, STDOUT_FILENO); dup2(log, STDERR_FILENO); close(log); }
        int dn = open("/dev/null", O_RDONLY); if (dn >= 0) { dup2(dn, STDIN_FILENO); close(dn); }
        if (g_srv_fd >= 0) close(g_srv_fd);
        char clog[4096] = "", cerr[1024] = "";
        int ok = setup_download_content_archive(clog, sizeof clog, cerr, sizeof cerr);
        if (!ok) fprintf(stderr, "content download failed: %s\n", cerr);
        _exit(ok ? 0 : 1);
    }
    g_content_dl_pid = pid;
    g_content_dl_task = task_id;
    dstudio_task *t = task_find(task_id);
    if (t) t->pid = (int)pid;
    task_mark_working(task_id, "downloading bundled content");
    printf("content: downloading bundled content (pid %d) — log /tmp/ds4-content-dl.log\n", (int)pid);
    return task_id;
#endif
}

/* POST /api/setup/content — download/install the bundled content on demand. */
static void api_setup_content(int fd) {
    reap_child();
    if (content_present()) {
        send_json(fd, "200 OK", "{\"ok\":true,\"already\":true,\"contentOk\":true}");
        return;
    }
    if (g_content_dl_pid > 0) {
        char out[160];
        snprintf(out, sizeof out, "{\"ok\":true,\"taskId\":%llu,\"started\":true,\"running\":true}", g_content_dl_task);
        send_json(fd, "200 OK", out);
        return;
    }
    unsigned long long task_id = start_content_download();
    if (!task_id) {
        send_json(fd, "500 Internal Server Error", "{\"ok\":false,\"error\":\"could not start content download\"}");
        return;
    }
    char out[192];
    int done = content_present();   /* on Windows the download already finished synchronously */
    snprintf(out, sizeof out, "{\"ok\":true,\"taskId\":%llu,\"started\":true,\"contentOk\":%s}",
             task_id, done ? "true" : "false");
    send_json(fd, "200 OK", out);
}

static int setup_gguf_dir_path(const char *ds4dir, char *out, size_t outsz) {
    if (!ds4dir || !ds4dir[0] || !out || !outsz) return 0;
#ifdef _WIN32
    int n = snprintf(out, outsz, "%s\\gguf", ds4dir);
#else
    int n = snprintf(out, outsz, "%s/gguf", ds4dir);
#endif
    return n >= 0 && (size_t)n < outsz;
}

static int setup_gguf_dir_ok_path(const char *ds4dir) {
    char path[DSTUDIO_PATH_MAX + 16];
    if (!setup_gguf_dir_path(ds4dir, path, sizeof path)) return 0;
    struct stat st;
    return stat(path, &st) == 0 && S_ISDIR(st.st_mode);
}

static int setup_ensure_gguf_dir(char *err, size_t errsz) {
    char path[DSTUDIO_PATH_MAX + 16];
    if (!setup_gguf_dir_path(g_ds4_dir, path, sizeof path)) {
        snprintf(err, errsz, "gguf folder path is too long under %s", g_ds4_dir);
        return 0;
    }
    struct stat st;
    if (stat(path, &st) == 0) {
        if (S_ISDIR(st.st_mode)) return 1;
        snprintf(err, errsz, "%s exists but is not a folder", path);
        return 0;
    }
    if (mkdir(path, 0755) != 0 && errno != EEXIST) {
        snprintf(err, errsz, "could not create model folder %s: %s", path, strerror(errno));
        return 0;
    }
    if (stat(path, &st) != 0 || !S_ISDIR(st.st_mode)) {
        snprintf(err, errsz, "model folder %s was not created", path);
        return 0;
    }
    return 1;
}

#ifdef _WIN32
static void setup_trim_line(char *s) {
    if (!s) return;
    size_t n = strlen(s);
    while (n && (s[n - 1] == '\n' || s[n - 1] == '\r' || s[n - 1] == ' ' || s[n - 1] == '\t'))
        s[--n] = '\0';
}

static int setup_windows_engine_ready(void) {
    win_prepare_engine_runtime();
    char ver[DSTUDIO_PATH_MAX + 64];
    snprintf(ver, sizeof ver, "%s\\ds4-agent-jsonl.ver", g_ds4_dir);
    int patch_version = jsonl_patch_version();
    return file_present("ds4-server.exe") &&
           file_present("ds4-agent-jsonl.exe") &&
           file_present("ds4-design.exe") &&
           patch_version > 0 &&
           jsonl_sentinel_ok(ver, patch_version);
}

static int setup_find_windows_bash(char *out, size_t outsz) {
    win_prepare_engine_runtime();
    const char *candidates[] = {
        "C:\\msys64\\usr\\bin\\bash.exe",
        "C:\\cygwin64\\bin\\bash.exe",
        "bash.exe",
        "bash",
        NULL
    };
    for (int i = 0; candidates[i]; i++) {
        if (strchr(candidates[i], '\\') && access(candidates[i], X_OK) != 0) continue;
        snprintf(out, outsz, "%s", candidates[i]);
        return 1;
    }
    return 0;
}

static int setup_windows_posix_path(const char *bash, const char *win_path,
                                    char *out, size_t outsz, char *err, size_t errsz) {
    char log_tail[4096];
    char *argv[] = { (char *)bash, "-lc", "cygpath -u \"$1\"", "_", (char *)win_path, NULL };
    int rc = setup_run_cmd_capture(NULL, argv, log_tail, sizeof log_tail);
    if (rc != 0 || !log_tail[0]) {
        snprintf(err, errsz, "cygpath failed for %s (exit %d). Output: %.3000s",
                 win_path ? win_path : "(null)", rc, log_tail[0] ? log_tail : "(no output)");
        return 0;
    }
    setup_trim_line(log_tail);
    snprintf(out, outsz, "%s", log_tail);
    return 1;
}

static int setup_windows_build_ds4(char *log_tail, size_t logsz, char *err, size_t errsz) {
    if (!g_web_dir[0]) {
        snprintf(err, errsz,
                 "Windows ds4 build requires the DStudio source checkout with scripts/ and patch/. "
                 "The portable build can still use packaged engine binaries next to DStudio.exe.");
        return 0;
    }

    char script[DSTUDIO_PATH_MAX + 128];
    snprintf(script, sizeof script, "%s\\scripts\\build-ds4-windows-cygwin.sh", g_web_dir);
    if (access(script, R_OK) != 0) {
        snprintf(err, errsz, "Windows ds4 build script not found: %s", script);
        return 0;
    }

    char bash[DSTUDIO_PATH_MAX];
    if (!setup_find_windows_bash(bash, sizeof bash)) {
        snprintf(err, errsz,
                 "Windows ds4 setup downloaded the pinned source, but could not find MSYS2/Cygwin bash. "
                 "Install MSYS2 in C:\\msys64 or use the portable package with DS4 engine binaries.");
        return 0;
    }

    char root_unix[DSTUDIO_PATH_MAX], ds4_unix[DSTUDIO_PATH_MAX];
    if (!setup_windows_posix_path(bash, g_web_dir, root_unix, sizeof root_unix, err, errsz)) return 0;
    if (!setup_windows_posix_path(bash, g_ds4_dir, ds4_unix, sizeof ds4_unix, err, errsz)) return 0;

    char *argv[] = {
        bash,
        "-lc",
        "cd \"$1\" && ./scripts/build-ds4-windows-cygwin.sh \"$2\"",
        "_",
        root_unix,
        ds4_unix,
        NULL
    };
    int rc = setup_run_cmd_capture(NULL, argv, log_tail, logsz);
    if (rc != 0) {
        snprintf(err, errsz,
                 "Windows ds4 build failed (exit %d). Install MSYS2/Cygwin make+gcc+patch. Output: %.7600s",
                 rc, log_tail && log_tail[0] ? log_tail : "(no output)");
        return 0;
    }
    if (!setup_windows_engine_ready()) {
        snprintf(err, errsz, "Windows ds4 build finished but required engine binaries or JSONL marker are missing");
        return 0;
    }
    return 1;
}

static int setup_prepare_ds4_windows(char *log_tail, size_t logsz, char *err, size_t errsz) {
    if (setup_windows_engine_ready()) return 1;
    return setup_windows_build_ds4(log_tail, logsz, err, errsz);
}
#endif

static void setup_send_json(int fd, const char *status, int ok, const char *target,
                            int downloaded, int built, int jsonl_prepared, int design_prepared,
                            int was_running, int restarted, const char *mode,
                            const char *error) {
    json_dyn_buf b = {0};
    unsigned long long task_id = g_active_setup_task;
    if (task_id) {
        if (ok) task_mark_completed(task_id, "ds4 setup completed");
        else task_mark_failed(task_id, error && error[0] ? error : "ds4 setup failed", target ? target : g_ds4_dir);
        g_active_setup_task = 0;
    }
    int good = json_dyn_puts(&b, "{\"ok\":") &&
               json_dyn_puts(&b, ok ? "true" : "false") &&
               json_dyn_puts(&b, ",\"taskId\":") &&
               json_dyn_printf(&b, "%llu", task_id) &&
               json_dyn_puts(&b, ",\"repo\":") &&
               json_dyn_put_escaped(&b, DS4_REPO_URL) &&
               json_dyn_puts(&b, ",\"commit\":") &&
               json_dyn_put_escaped(&b, DS4_UPSTREAM_COMMIT) &&
               json_dyn_puts(&b, ",\"archiveUrl\":") &&
               json_dyn_put_escaped(&b, DS4_ARCHIVE_URL) &&
               json_dyn_puts(&b, ",\"ds4dir\":") &&
               json_dyn_put_escaped(&b, target ? target : g_ds4_dir) &&
               json_dyn_puts(&b, ",\"ds4dirOk\":") &&
               json_dyn_puts(&b, ds4_dir_valid() ? "true" : "false") &&
               json_dyn_puts(&b, ",\"ggufDirOk\":") &&
               json_dyn_puts(&b, setup_gguf_dir_ok_path(target ? target : g_ds4_dir) ? "true" : "false") &&
               json_dyn_puts(&b, ",\"downloaded\":") &&
               json_dyn_puts(&b, downloaded ? "true" : "false") &&
               json_dyn_puts(&b, ",\"built\":") &&
               json_dyn_puts(&b, built ? "true" : "false") &&
               json_dyn_puts(&b, ",\"jsonlPrepared\":") &&
               json_dyn_puts(&b, jsonl_prepared ? "true" : "false") &&
               json_dyn_puts(&b, ",\"designPrepared\":") &&
               json_dyn_puts(&b, design_prepared ? "true" : "false") &&
               json_dyn_puts(&b, ",\"wasRunning\":") &&
               json_dyn_puts(&b, was_running ? "true" : "false") &&
               json_dyn_puts(&b, ",\"restarted\":") &&
               json_dyn_puts(&b, restarted ? "true" : "false") &&
               json_dyn_puts(&b, ",\"mode\":") &&
               json_dyn_put_escaped(&b, mode ? mode : mode_name(g_mode)) &&
               json_dyn_puts(&b, ",\"error\":") &&
               json_dyn_put_escaped(&b, error ? error : "") &&
               json_dyn_puts(&b, "}");
    if (!good) {
        free(b.ptr);
        send_json(fd, "500 Internal Server Error", "{\"ok\":false,\"error\":\"out of memory\"}");
        return;
    }
    send_json(fd, status, b.ptr);
    free(b.ptr);
}

/* POST /api/ds4/setup — managed first-run path. Downloads antirez/ds4 at the
 * pinned commit into this DStudio checkout as ./ds4, builds upstream, then applies the external patch
 * sets from patch/. Every step returns a concrete error instead of leaving the
 * onboarding path field in a silent-fail state. */
static void api_setup_ds4(int fd) {
    resolve_web_dir();
    g_active_setup_task = task_begin("setup", "Install ds4", "ds4", g_mode, g_ds4_dir, 0, 0);
    task_mark_working(g_active_setup_task, "preparing ds4 setup");
#ifndef _WIN32
    if (!web_dir_valid()) {
        setup_send_json(fd, "409 Conflict", 0, g_ds4_dir, 0, 0, 0, 0, 0, 0, mode_name(g_mode),
                        "DStudio checkout not found; cannot locate patch/ and extension/ to prepare ds4");
        return;
    }
#endif

    char target[DSTUDIO_PATH_MAX];
    if (!default_ds4_dir(target, sizeof target)) {
        setup_send_json(fd, "500 Internal Server Error", 0, g_ds4_dir, 0, 0, 0, 0, 0, 0, mode_name(g_mode),
                        "default ds4 path is too long");
        return;
    }

    struct stat st;
    int exists = stat(target, &st) == 0;
    if (exists && !S_ISDIR(st.st_mode)) {
        setup_send_json(fd, "409 Conflict", 0, target, 0, 0, 0, 0, 0, 0, mode_name(g_mode),
                        "DStudio/ds4 exists but is not a folder");
        return;
    }

    int downloaded = 0;
    char log_tail[8192] = "";
    if (!exists || !ds4_dir_valid_path(target)) {
        int can_download = !exists;
        if (exists) {
            int empty = 0;
            if (!setup_dir_empty(target, &empty)) {
                setup_send_json(fd, "409 Conflict", 0, target, 0, 0, 0, 0, 0, 0, mode_name(g_mode),
                                "DStudio/ds4 exists but could not be inspected");
                return;
            }
            can_download = empty;
        }
        if (!can_download) {
            setup_send_json(fd, "409 Conflict", 0, target, 0, 0, 0, 0, 0, 0, mode_name(g_mode),
                            "DStudio/ds4 exists but is not a ds4 checkout; remove it and run setup again");
            return;
        }
        char err[8600];
        if (!setup_download_ds4_archive(DS4_ARCHIVE_URL, DS4_UPSTREAM_COMMIT, target,
                                        log_tail, sizeof log_tail, err, sizeof err)) {
            setup_send_json(fd, "500 Internal Server Error", 0, target, 0, 0, 0, 0, 0, 0, mode_name(g_mode), err);
            return;
        }
        downloaded = 1;
    }

    char abs[DSTUDIO_PATH_MAX];
    if (!realpath(target, abs)) {
        char err[1024];
        snprintf(err, sizeof err, "ds4 checkout path could not be resolved after download: %s", strerror(errno));
        setup_send_json(fd, "500 Internal Server Error", 0, target, downloaded, 0, 0, 0, 0, 0, mode_name(g_mode), err);
        return;
    }
    cstr_copy(g_ds4_dir, sizeof g_ds4_dir, abs);
    g_ds4_dir_explicit = 0;
    if (!ds4_dir_valid()) {
        setup_send_json(fd, "409 Conflict", 0, g_ds4_dir, downloaded, 0, 0, 0, 0, 0, mode_name(g_mode),
                        "downloaded folder does not look like a ds4 checkout");
        return;
    }
    char gguf_err[1024];
    if (!setup_ensure_gguf_dir(gguf_err, sizeof gguf_err)) {
        setup_send_json(fd, "500 Internal Server Error", 0, g_ds4_dir, downloaded, 0, 0, 0, 0, 0,
                        mode_name(g_mode), gguf_err);
        return;
    }

    reap_child();
    int        prev_mode = g_mode;
    engine_cfg prev_cfg  = g_cfg;
    char       prev_wd[1024];
    snprintf(prev_wd, sizeof prev_wd, "%s", g_workdir);
    int was_running = (g_child > 0) || (prev_mode != ENGINE_NONE);
    if (g_child > 0) stop_child();
    kill_external_server(ENGINE_DEFAULTS.port);

#ifdef _WIN32
    char build_err[8600];
    if (!setup_prepare_ds4_windows(log_tail, sizeof log_tail, build_err, sizeof build_err)) {
        setup_send_json(fd, "500 Internal Server Error", 0, g_ds4_dir, downloaded, 0, 0, 0,
                        was_running, 0, mode_name(prev_mode), build_err);
        return;
    }
#else
    if (!run_ext_script("scripts/apply-ds4-qwen-hot-memory.sh", "apply")) {
        setup_send_json(fd, "500 Internal Server Error", 0, g_ds4_dir, downloaded, 0, 0, 0,
                        was_running, 0, mode_name(prev_mode),
                        "ds4 Qwen hot-memory patch failed; upstream anchors may have changed");
        return;
    }
    char *make_argv[] = { "make", "-C", g_ds4_dir, NULL };
    int rc = setup_run_cmd_capture(NULL, make_argv, log_tail, sizeof log_tail);
    if (rc != 0) {
        char err[8600];
        snprintf(err, sizeof err, "ds4 make failed (exit %d). Output: %.7800s",
                 rc, log_tail[0] ? log_tail : "(no output)");
        setup_send_json(fd, "500 Internal Server Error", 0, g_ds4_dir, downloaded, 0, 0, 0,
                        was_running, 0, mode_name(prev_mode), err);
        return;
    }
#endif

    if (!run_build_jsonl("build")) {
        char err[1024];
        snprintf(err, sizeof err, "%s", g_engine_err[0] ? g_engine_err : "JSONL patch/build failed");
        setup_send_json(fd, "500 Internal Server Error", 0, g_ds4_dir, downloaded, 1, 0, 0,
                        was_running, 0, mode_name(prev_mode), err);
        return;
    }

    int design_prepared = run_ext_script("extension/design/build-design.sh", "build");
    if (!design_prepared) {
        setup_send_json(fd, "500 Internal Server Error", 0, g_ds4_dir, downloaded, 1, 1, 0,
                        was_running, 0, mode_name(prev_mode),
                        "ds4 was downloaded and the agent patch built, but the design runtime build failed");
        return;
    }

    int restarted = 0;
    char restart_err[256] = "";
    if (was_running) {
        int ok = prev_mode == ENGINE_AGENT  ? spawn_agent(&prev_cfg, prev_wd, restart_err, sizeof restart_err)
               : prev_mode == ENGINE_DESIGN ? spawn_design(&prev_cfg, prev_wd, restart_err, sizeof restart_err)
                                            : spawn_server(&prev_cfg, restart_err, sizeof restart_err);
        restarted = ok ? 1 : 0;
    }

    setup_send_json(fd, "200 OK", 1, g_ds4_dir, downloaded, 1, 1, design_prepared,
                    was_running, restarted, mode_name(g_mode), restart_err);
}

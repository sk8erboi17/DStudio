/* ============================================================================
 * Self-update subsystem.
 *
 * Checks and applies updates to this DStudio checkout: git status of the
 * engine/skill sources and the staged update run steps. Purely operational;
 * every step goes through the task/log API for UI progress.
 *
 * Extracted from dstudio.c into a per-domain file (one translation unit, all
 * static; same pattern as the GSA/RSA .cfrag includes).
 * ==========================================================================*/

static int update_count_marker_dirs(const char *rel, const char *marker, const char *contains) {
    char base[DSTUDIO_PATH_MAX + 256];
    if (g_web_dir[0]) snprintf(base, sizeof base, "%s/%s", g_web_dir, rel);
    else snprintf(base, sizeof base, "%s", rel);
    DIR *d = opendir(base);
    if (!d) return -1;
    int count = 0;
    struct dirent *e;
    while ((e = readdir(d))) {
        if (!strcmp(e->d_name, ".") || !strcmp(e->d_name, "..")) continue;
        char path[DSTUDIO_PATH_MAX + 512];
        snprintf(path, sizeof path, "%s/%s/%s", base, e->d_name, marker);
        struct stat st;
        if (stat(path, &st) != 0 || !S_ISREG(st.st_mode)) continue;
        if (contains && contains[0]) {
            size_t n = 0;
            char *content = jsonl_read_file(path, &n);
            int hit = content && strstr(content, contains);
            free(content);
            if (!hit) continue;
        }
        count++;
    }
    closedir(d);
    return count;
}

static int update_patch_anchor_failures(void) {
    if (!ds4_dir_valid()) return 99;
    char src[2200], web_src[2200];
    snprintf(src, sizeof src, "%s/ds4_agent.c", g_ds4_dir);
    snprintf(web_src, sizeof web_src, "%s/ds4_web.c", g_ds4_dir);
    return jsonl_check_anchors(src) + web_cdp_check_anchors(web_src);
}

static int updates_add_section(json_dyn_buf *b, int *first, const char *id,
                               const char *label, const char *state,
                               const char *detail, const char *action) {
    int ok = json_dyn_puts(b, *first ? "" : ",") &&
             json_dyn_puts(b, "{\"id\":") &&
             json_dyn_put_escaped(b, id) &&
             json_dyn_puts(b, ",\"label\":") &&
             json_dyn_put_escaped(b, label) &&
             json_dyn_puts(b, ",\"state\":") &&
             json_dyn_put_escaped(b, state) &&
             json_dyn_puts(b, ",\"detail\":") &&
             json_dyn_put_escaped(b, detail ? detail : "") &&
             json_dyn_puts(b, ",\"action\":");
    ok = ok && (action ? json_dyn_put_escaped(b, action) : json_dyn_puts(b, "null"));
    ok = ok && json_dyn_puts(b, "}");
    if (ok) *first = 0;
    return ok;
}

static int updates_ds4_managed_dirty_path(const char *path) {
    if (!path || !path[0]) return 0;
    return !strcmp(path, "ds4-agent-jsonl") ||
           !strcmp(path, "ds4-agent-jsonl.ver") ||
           !strcmp(path, "ds4-design") ||
           !strcmp(path, "ds4-design.exe") ||
           !strcmp(path, "ds4_agent.c.ds4ui.bak") ||
           !strcmp(path, "ds4.c") ||
           !strcmp(path, "ds4.h") ||
           !strcmp(path, "ds4_gpu.h") ||
           !strcmp(path, "ds4_metal.m") ||
           !strcmp(path, "ds4_cuda.cu") ||
           !strcmp(path, "ds4_server.c");
}

static int updates_ds4_dirty_is_only_managed(const char *dirty, int *managed_count) {
    if (managed_count) *managed_count = 0;
    if (!dirty || !dirty[0]) return 0;
    char buf[4096];
    cstr_copy(buf, sizeof buf, dirty);
    int count = 0;
    for (char *line = strtok(buf, "\n"); line; line = strtok(NULL, "\n")) {
        while (*line == '\r' || *line == '\n') line++;
        if (!line[0]) continue;
        if (strlen(line) < 4 || line[2] != ' ') return 0;
        char *path = line + 3;
        while (*path == ' ') path++;
        if (!updates_ds4_managed_dirty_path(path)) return 0;
        count++;
    }
    if (managed_count) *managed_count = count;
    return count > 0;
}

static void updates_trim_line(char *s) {
    if (!s) return;
    char *p = s;
    while (*p && isspace((unsigned char)*p)) p++;
    if (p != s) memmove(s, p, strlen(p) + 1);
    size_t n = strlen(s);
    while (n && isspace((unsigned char)s[n - 1])) s[--n] = '\0';
}

static int updates_git_capture_trim(char *const argv[], char *out, size_t outsz) {
    int rc = setup_run_cmd_capture(NULL, argv, out, outsz);
    updates_trim_line(out);
    return rc;
}

static void updates_append_detail(char *dst, size_t dstsz, const char *fmt, ...) {
    if (!dst || !dstsz) return;
    size_t used = strlen(dst);
    if (used >= dstsz - 1) return;
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(dst + used, dstsz - used, fmt, ap);
    va_end(ap);
}

typedef struct {
    int sources;
    int stale;
    int failed;
    char detail[900];
} update_skill_sources_status;

static int updates_commit_same(const char *a, const char *b) {
    if (!a || !b || !a[0] || !b[0]) return 0;
    size_t an = strlen(a), bn = strlen(b);
    size_t n = an < bn ? an : bn;
    if (n < 7) return 0;
    return !strncmp(a, b, n);
}

static int updates_skill_source_remote_head(const char *repo, const char *ref, char *out, size_t outsz) {
    char refspec[256];
    if (!ref || !ref[0] || !strcmp(ref, "HEAD")) snprintf(refspec, sizeof refspec, "HEAD");
    else if (!strncmp(ref, "refs/", 5)) snprintf(refspec, sizeof refspec, "%s", ref);
    else snprintf(refspec, sizeof refspec, "refs/heads/%s", ref);
    char raw[1024] = "";
    char *argv[] = { "git", "ls-remote", (char *)repo, refspec, NULL };
    int rc = updates_git_capture_trim(argv, raw, sizeof raw);
    if (rc != 0 || !raw[0]) {
        if (out && outsz) out[0] = '\0';
        return 0;
    }
    char *p = raw;
    while (*p && !isspace((unsigned char)*p)) p++;
    *p = '\0';
    cstr_copy(out, outsz, raw);
    return out && out[0];
}

static void updates_skill_sources_status(update_skill_sources_status *st) {
    memset(st, 0, sizeof *st);
    char manifest[DSTUDIO_PATH_MAX + 256];
    if (g_web_dir[0]) snprintf(manifest, sizeof manifest, "%s/extension/skills/sources.tsv", g_web_dir);
    else snprintf(manifest, sizeof manifest, "extension/skills/sources.tsv");
    FILE *f = fopen(manifest, "r");
    if (!f) {
        st->failed = 1;
        snprintf(st->detail, sizeof st->detail, "No imported skill source manifest found.");
        return;
    }
    char line[2048];
    while (fgets(line, sizeof line, f)) {
        updates_trim_line(line);
        if (!line[0] || line[0] == '#') continue;
        char *cols[8] = {0};
        int n = 0;
        for (char *tok = strtok(line, "\t"); tok && n < 8; tok = strtok(NULL, "\t")) cols[n++] = tok;
        if (n < 6) {
            st->failed++;
            updates_append_detail(st->detail, sizeof st->detail, "Bad source row. ");
            continue;
        }
        const char *id = cols[0], *repo = cols[1], *ref = cols[2], *imported = cols[3];
        const char *kind = n >= 7 && cols[6] ? cols[6] : "skills-dir";
        char remote[96] = "";
        st->sources++;
        if (!updates_skill_source_remote_head(repo, ref, remote, sizeof remote)) {
            st->failed++;
            updates_append_detail(st->detail, sizeof st->detail, "%s remote could not be checked. ", id);
            continue;
        }
        if (!updates_commit_same(imported, remote)) {
            st->stale++;
            if (!strcmp(kind, "verify-only"))
                updates_append_detail(st->detail, sizeof st->detail, "%s adapted source outdated %.*s -> %.*s; manual re-import required. ",
                                      id, 12, imported, 12, remote);
            else
                updates_append_detail(st->detail, sizeof st->detail, "%s outdated %.*s -> %.*s; run Update / verify selected. ",
                                      id, 12, imported, 12, remote);
        }
    }
    fclose(f);
}

static int updates_ds4_git_upstream(char *upstream, size_t upstreamsz) {
    if (upstream && upstreamsz) upstream[0] = '\0';
    char *up_argv[] = { "git", "-C", g_ds4_dir, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}", NULL };
    if (updates_git_capture_trim(up_argv, upstream, upstreamsz) == 0 && upstream && upstream[0]) return 1;
    char verify[256] = "";
    char *verify_argv[] = { "git", "-C", g_ds4_dir, "rev-parse", "--verify", "--quiet", "origin/main", NULL };
    if (updates_git_capture_trim(verify_argv, verify, sizeof verify) == 0 && verify[0]) {
        cstr_copy(upstream, upstreamsz, "origin/main");
        return 1;
    }
    return 0;
}

static int updates_sections_json(json_dyn_buf *b) {
    resolve_web_dir();
    int first = 1;
    if (!json_dyn_puts(b, "\"sections\":[")) return 0;

    int nuclei_ready = gsa_nuclei_templates_found();
    int gsa_tools_found = 0, gsa_tools_total = 0;
    char gsa_missing[512] = "";
    int gsa_catalog_ok = gsa_tool_catalog_status(&gsa_tools_found, &gsa_tools_total, gsa_missing, sizeof gsa_missing);
    char gsa_detail[512];
    if (!gsa_catalog_ok) {
        snprintf(gsa_detail, sizeof gsa_detail,
                 "GSA tool catalog could not be loaded; tool readiness is not verified.");
    } else if (gsa_tools_found != gsa_tools_total) {
        snprintf(gsa_detail, sizeof gsa_detail,
                 "GSA catalog %d/%d tools ready; missing: %s. Nuclei templates %s under NUCLEI_TEMPLATES_DIR.",
                 gsa_tools_found, gsa_tools_total, gsa_missing[0] ? gsa_missing : "unknown",
                 nuclei_ready ? "found" : "missing");
    } else {
        snprintf(gsa_detail, sizeof gsa_detail,
                 "GSA catalog %d/%d tools ready; nuclei templates %s under NUCLEI_TEMPLATES_DIR.",
                 gsa_tools_found, gsa_tools_total,
                 nuclei_ready ? "found" : "missing");
    }
    if (!updates_add_section(b, &first, "gsa-tools", "GSA tools/templates",
                             (gsa_catalog_ok && gsa_tools_found == gsa_tools_total && nuclei_ready) ? "ok" : "warn",
                             gsa_detail, "gsa-tools")) return 0;

    int ds4_git = ds4_dir_valid() && file_present_in_dir(g_ds4_dir, ".git/HEAD");
    char head[256] = "", dirty[4096] = "", fetch_log[4096] = "";
    char upstream[256] = "", remote_head[256] = "", counts[128] = "";
    char *rev_argv[] = { "git", "-C", g_ds4_dir, "rev-parse", "--short", "HEAD", NULL };
    char *dirty_argv[] = { "git", "-C", g_ds4_dir, "status", "--porcelain", NULL };
    if (ds4_git) updates_git_capture_trim(rev_argv, head, sizeof head);
    if (ds4_git) setup_run_cmd_capture(NULL, dirty_argv, dirty, sizeof dirty);
    int managed_dirty_count = 0;
    int managed_dirty = ds4_git && dirty[0] && updates_ds4_dirty_is_only_managed(dirty, &managed_dirty_count);
    int fetch_rc = -1;
    int upstream_ok = 0;
    int ahead = -1, behind = -1;
    if (ds4_git) {
        char *fetch_argv[] = { "git", "-C", g_ds4_dir, "fetch", "origin", "--prune", NULL };
        fetch_rc = setup_run_cmd_capture(NULL, fetch_argv, fetch_log, sizeof fetch_log);
        updates_trim_line(fetch_log);
        if (fetch_rc == 0) {
            upstream_ok = updates_ds4_git_upstream(upstream, sizeof upstream);
            if (upstream_ok) {
                char *remote_argv[] = { "git", "-C", g_ds4_dir, "rev-parse", "--short", upstream, NULL };
                updates_git_capture_trim(remote_argv, remote_head, sizeof remote_head);
                char range[320];
                snprintf(range, sizeof range, "HEAD...%s", upstream);
                char *count_argv[] = { "git", "-C", g_ds4_dir, "rev-list", "--left-right", "--count", range, NULL };
                if (updates_git_capture_trim(count_argv, counts, sizeof counts) == 0) {
                    sscanf(counts, "%d%*[ \t]%d", &ahead, &behind);
                }
            }
        }
    }
    char ds4_detail[900];
    const char *ds4_state = "ok";
    if (!ds4_git) {
        ds4_state = "warn";
        snprintf(ds4_detail, sizeof ds4_detail,
                 "ds4 is not a git checkout; latest update requires git-managed ds4.");
    } else if (fetch_rc != 0) {
        ds4_state = "warn";
        snprintf(ds4_detail, sizeof ds4_detail,
                 "Could not fetch origin, so latest status is not verified. Local HEAD %s. Output: %.520s",
                 head, fetch_log[0] ? fetch_log : "(no output)");
    } else if (!upstream_ok || ahead < 0 || behind < 0) {
        ds4_state = "warn";
        snprintf(ds4_detail, sizeof ds4_detail,
                 "Fetched origin, but could not determine upstream comparison for local HEAD %s. Set ds4 branch upstream to origin/main.",
                 head);
    } else if (behind > 0 && ahead > 0) {
        ds4_state = "warn";
        snprintf(ds4_detail, sizeof ds4_detail,
                 "Fetched origin; local %s and %s %s diverged (%d local commit(s), %d upstream commit(s)). Resolve before updating.",
                 head, upstream, remote_head[0] ? remote_head : "remote", ahead, behind);
    } else if (behind > 0) {
        ds4_state = "warn";
        snprintf(ds4_detail, sizeof ds4_detail,
                 "Fetched origin; local %s is %d commit(s) behind %s %s. Run Update selected to pull/build/verify patches.%s%s",
                 head, behind, upstream, remote_head[0] ? remote_head : "",
                 (dirty[0] && managed_dirty) ? " " : "",
                 (dirty[0] && managed_dirty) ? "DStudio generated artifacts are present and safe to regenerate." : "");
    } else if (ahead > 0) {
        ds4_state = "warn";
        snprintf(ds4_detail, sizeof ds4_detail,
                 "Fetched origin; local %s is %d commit(s) ahead of %s %s. Latest cannot be verified as a clean upstream checkout.",
                 head, ahead, upstream, remote_head[0] ? remote_head : "");
    } else if (dirty[0] && managed_dirty) {
        snprintf(ds4_detail, sizeof ds4_detail,
                 "Fetched origin; local %s matches %s %s; %d DStudio generated artifact(s) present and safe to regenerate.",
                 head, upstream, remote_head[0] ? remote_head : "", managed_dirty_count);
    } else {
        if (dirty[0]) ds4_state = "warn";
        snprintf(ds4_detail, sizeof ds4_detail, "Fetched origin; local %s matches %s %s%s",
                 head, upstream, remote_head[0] ? remote_head : "",
                 dirty[0] ? " (dirty worktree: pull may fail until local changes are resolved)" : "");
    }
    if (!updates_add_section(b, &first, "ds4-latest", "ds4 latest",
                             ds4_state,
                             ds4_detail, "ds4-latest")) return 0;

    int anchor_fails = update_patch_anchor_failures();
    char patch_detail[512];
    snprintf(patch_detail, sizeof patch_detail,
             anchor_fails == 0 ? "JSONL and web patch anchors match current ds4 source." :
             "Patch anchors have %d failure(s); structured agent/design gate must be repaired before relying on latest ds4.",
             anchor_fails);
    if (!updates_add_section(b, &first, "patch-verify", "Patch gate",
                             anchor_fails == 0 ? "ok" : "error",
                             patch_detail, "patch-verify")) return 0;

    int skills = update_count_marker_dirs("extension/skills", "SKILL.md", NULL);
    int cyber = update_count_marker_dirs("extension/gsa/third_party/anthropic-cybersecurity-skills/skills", "SKILL.md", NULL);
    update_skill_sources_status skill_sources;
    updates_skill_sources_status(&skill_sources);
    char skills_detail[1200];
    snprintf(skills_detail, sizeof skills_detail,
             "%d local skills and %d cybersecurity skills detected. Repo sources: %s",
             skills < 0 ? 0 : skills, cyber < 0 ? 0 : cyber,
             skill_sources.sources <= 0 ? "none configured." :
             (skill_sources.stale || skill_sources.failed ? skill_sources.detail : "all current."));
    if (!updates_add_section(b, &first, "skills", "Imported skills",
                             (skills > 0 && cyber > 0 && skill_sources.failed == 0 && skill_sources.stale == 0) ? "ok" : "warn",
                             skills_detail, "skills")) return 0;

    int open_skills = update_count_marker_dirs("extension/skills", "SKILL.md", "open-design/");
    int design_systems = update_count_marker_dirs("extension/design-systems", "DESIGN.md", "open-design/");
    char design_detail[512];
    snprintf(design_detail, sizeof design_detail,
             "%d Open Design skill templates and %d design systems detected.",
             open_skills < 0 ? 0 : open_skills, design_systems < 0 ? 0 : design_systems);
    if (!updates_add_section(b, &first, "open-design", "Open Design",
                             (open_skills > 0 && design_systems > 0) ? "ok" : "warn",
                             design_detail, "open-design")) return 0;

    return json_dyn_puts(b, "]");
}

static void api_updates_check(int fd) {
    json_dyn_buf b = {0};
    int ok = json_dyn_puts(&b, "{\"ok\":true,") &&
             updates_sections_json(&b) &&
             json_dyn_puts(&b, "}");
    if (!ok) {
        free(b.ptr);
        send_json(fd, "500 Internal Server Error", "{\"ok\":false,\"error\":\"updates check memory\"}");
        return;
    }
    send_json(fd, "200 OK", b.ptr);
    free(b.ptr);
}

static int update_body_has_task(const char *body, const char *task) {
    if (!body || !body[0]) return 0;
    return strstr(body, "\"all\"") || strstr(body, task);
}

static int update_run_cmd(unsigned long long task_id, const char *label,
                          const char *cwd, char *const argv[],
                          char *log_tail, size_t logsz, char *err, size_t errsz) {
    task_mark_working(task_id, label);
    int rc = setup_run_cmd_capture(cwd, argv, log_tail, logsz);
    if (rc != 0) {
        snprintf(err, errsz, "%s failed (exit %d). Output: %.7000s",
                 label, rc, log_tail && log_tail[0] ? log_tail : "(no output)");
        return 0;
    }
    return 1;
}

static int updates_run_gsa_tools(unsigned long long task_id, char *log_tail, size_t logsz,
                                 char *err, size_t errsz) {
    char bin[1200], sh_path[1400] = "", ps_path[1400] = "";
    gsa_tools_dir(bin, sizeof bin);
    mkpath(bin);
    if (!gsa_write_install_scripts(bin, sh_path, sizeof sh_path, ps_path, sizeof ps_path, err, errsz))
        return 0;
#ifdef _WIN32
    char *argv[] = { "powershell", "-ExecutionPolicy", "Bypass", "-File", ps_path, NULL };
    return update_run_cmd(task_id, "updating GSA managed tools/templates", NULL, argv, log_tail, logsz, err, errsz);
#else
    char *argv[] = { "sh", sh_path, NULL };
    return update_run_cmd(task_id, "updating GSA managed tools/templates", NULL, argv, log_tail, logsz, err, errsz);
#endif
}

static int updates_run_patch_verify(unsigned long long task_id, char *err, size_t errsz) {
    task_mark_working(task_id, "applying Qwen hot-memory patch");
    if (!run_ext_script("scripts/apply-ds4-qwen-hot-memory.sh", "apply")) {
        snprintf(err, errsz, "Qwen hot-memory patch failed; latest ds4 is not accepted");
        return 0;
    }
    task_mark_working(task_id, "checking DStudio patch anchors");
    int anchor_fails = update_patch_anchor_failures();
    if (anchor_fails != 0) {
        snprintf(err, errsz, "DStudio patch anchors failed (%d failure(s)); latest ds4 is not accepted", anchor_fails);
        return 0;
    }
    task_mark_working(task_id, "building structured agent patch");
    if (!run_build_jsonl("build")) {
        snprintf(err, errsz, "%s", g_engine_err[0] ? g_engine_err : "JSONL patch/build failed");
        return 0;
    }
    task_mark_working(task_id, "building design runtime");
    if (!run_ext_script("extension/design/build-design.sh", "build")) {
        snprintf(err, errsz, "design runtime build failed after patch verification");
        return 0;
    }
    return 1;
}

static int updates_run_ds4_latest(unsigned long long task_id, char *log_tail, size_t logsz,
                                  char *err, size_t errsz) {
    if (!ds4_dir_valid()) {
        snprintf(err, errsz, "ds4 folder is not valid; install ds4 before updating latest");
        return 0;
    }
    if (!file_present_in_dir(g_ds4_dir, ".git/HEAD")) {
        snprintf(err, errsz, "ds4 is not a git checkout; latest mode requires a git-managed ds4 directory");
        return 0;
    }
    char dirty[4096] = "";
    char *dirty_argv[] = { "git", "-C", g_ds4_dir, "status", "--porcelain", NULL };
    setup_run_cmd_capture(NULL, dirty_argv, dirty, sizeof dirty);
    if (dirty[0] && !updates_ds4_dirty_is_only_managed(dirty, NULL)) {
        snprintf(err, errsz,
                 "ds4 worktree has non-DStudio local changes; stash or resolve them before pulling latest. Status: %.7000s",
                 dirty);
        return 0;
    }
    if (!run_ext_script("scripts/apply-ds4-qwen-hot-memory.sh", "restore")) {
        snprintf(err, errsz, "could not restore the managed Qwen patch before pulling ds4");
        return 0;
    }
    char *fetch_argv[] = { "git", "-C", g_ds4_dir, "fetch", "origin", NULL };
    if (!update_run_cmd(task_id, "fetching ds4 upstream", NULL, fetch_argv, log_tail, logsz, err, errsz)) return 0;
    char *pull_argv[] = { "git", "-C", g_ds4_dir, "pull", "--ff-only", NULL };
    if (!update_run_cmd(task_id, "pulling ds4 latest --ff-only", NULL, pull_argv, log_tail, logsz, err, errsz)) return 0;
    if (!run_ext_script("scripts/apply-ds4-qwen-hot-memory.sh", "apply")) {
        snprintf(err, errsz, "latest ds4 no longer accepts the Qwen hot-memory patch");
        return 0;
    }
    char *make_argv[] = { "make", "-C", g_ds4_dir, NULL };
    if (!update_run_cmd(task_id, "building ds4 latest", NULL, make_argv, log_tail, logsz, err, errsz)) return 0;
    return updates_run_patch_verify(task_id, err, errsz);
}

static int updates_verify_skills(unsigned long long task_id, char *err, size_t errsz) {
    task_mark_working(task_id, "verifying imported skills");
    int skills = update_count_marker_dirs("extension/skills", "SKILL.md", NULL);
    int cyber = update_count_marker_dirs("extension/gsa/third_party/anthropic-cybersecurity-skills/skills", "SKILL.md", NULL);
    if (skills <= 0 || cyber <= 0) {
        snprintf(err, errsz, "imported skills are incomplete: local=%d cyber=%d", skills, cyber);
        return 0;
    }
    return 1;
}

static int updates_run_imported_skills(unsigned long long task_id, char *log_tail, size_t logsz,
                                       char *err, size_t errsz) {
    char script[DSTUDIO_PATH_MAX + 256];
    if (g_web_dir[0]) snprintf(script, sizeof script, "%s/scripts/sync-skill-sources.mjs", g_web_dir);
    else snprintf(script, sizeof script, "scripts/sync-skill-sources.mjs");
    struct stat st;
    if (stat(script, &st) != 0 || !S_ISREG(st.st_mode)) {
        snprintf(err, errsz, "imported skill source updater is missing: %s", script);
        return 0;
    }
    /* Resolve node to an absolute path: when DStudio is launched from the GUI
     * the server inherits a minimal PATH that omits Homebrew, so a bare "node"
     * exec fails with exit 127. */
    char node_bin[PATH_MAX];
    static const char *node_dirs[] = {
        "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin",
        "/opt/local/bin", "/snap/bin", NULL
    };
    if (!resolve_program_path("node", node_dirs, node_bin, sizeof node_bin)) {
        snprintf(err, errsz,
                 "Node.js is required to update imported skills but 'node' could not be found "
                 "on PATH or in common install locations. Install Node.js (e.g. 'brew install node') and retry.");
        return 0;
    }
    char *argv[] = { node_bin, script, "--all", NULL };
    if (!update_run_cmd(task_id, "updating imported skills from source repos", g_web_dir[0] ? g_web_dir : NULL,
                        argv, log_tail, logsz, err, errsz)) return 0;
    return updates_verify_skills(task_id, err, errsz);
}

static int updates_verify_open_design(unsigned long long task_id, char *err, size_t errsz) {
    task_mark_working(task_id, "verifying Open Design imports");
    int open_skills = update_count_marker_dirs("extension/skills", "SKILL.md", "open-design/");
    int design_systems = update_count_marker_dirs("extension/design-systems", "DESIGN.md", "open-design/");
    if (open_skills <= 0 || design_systems <= 0) {
        snprintf(err, errsz, "Open Design imports are incomplete: templates=%d designSystems=%d",
                 open_skills, design_systems);
        return 0;
    }
    return 1;
}

static void api_updates_run(int fd, const char *body) {
    unsigned long long task_id = task_begin("updates", "Run update doctor", "updates", g_mode, g_ds4_dir, 0, 0);
    char log_tail[8192] = "";
    char err[8600] = "";
    int ran = 0;
    int ok = 1;
    if (update_body_has_task(body, "gsa-tools")) {
        ran++;
        ok = updates_run_gsa_tools(task_id, log_tail, sizeof log_tail, err, sizeof err);
    }
    if (ok && update_body_has_task(body, "ds4-latest")) {
        ran++;
        ok = updates_run_ds4_latest(task_id, log_tail, sizeof log_tail, err, sizeof err);
    }
    if (ok && update_body_has_task(body, "patch-verify")) {
        ran++;
        ok = updates_run_patch_verify(task_id, err, sizeof err);
    }
    if (ok && update_body_has_task(body, "skills")) {
        ran++;
        ok = updates_run_imported_skills(task_id, log_tail, sizeof log_tail, err, sizeof err);
    }
    if (ok && update_body_has_task(body, "open-design")) {
        ran++;
        ok = updates_verify_open_design(task_id, err, sizeof err);
    }
    if (ran == 0) {
        ok = 0;
        snprintf(err, sizeof err, "no update tasks selected");
    }
    if (ok) task_mark_completed(task_id, "update doctor completed");
    else task_mark_failed(task_id, err, log_tail);

    json_dyn_buf b = {0};
    int good = json_dyn_printf(&b, "{\"ok\":%s,\"taskId\":%llu,\"ran\":%d,\"error\":",
                               ok ? "true" : "false", task_id, ran) &&
               json_dyn_put_escaped(&b, ok ? "" : err) &&
               json_dyn_puts(&b, ",\"logTail\":") &&
               json_dyn_put_escaped(&b, log_tail) &&
               json_dyn_puts(&b, ",") &&
               updates_sections_json(&b) &&
               json_dyn_puts(&b, "}");
    if (!good) {
        free(b.ptr);
        send_json(fd, "500 Internal Server Error", "{\"ok\":false,\"error\":\"updates run memory\"}");
        return;
    }
    send_json(fd, ok ? "200 OK" : "500 Internal Server Error", b.ptr);
    free(b.ptr);
}

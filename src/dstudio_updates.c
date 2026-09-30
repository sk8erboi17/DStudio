/* ============================================================================
 * Self-update subsystem.
 *
 * Checks bundled engine/design-system readiness and runs explicit tool or
 * patch maintenance. Engine revisions are distributed with DStudio;
 * every step goes through the task/log API for UI progress.
 *
 * Extracted from dstudio.c into a per-domain file (one translation unit, all
 * static; same pattern as the GSA/RSA .cfrag includes).
 * ==========================================================================*/


static int update_count_user_skills(void) {
    char base[DSTUDIO_PATH_MAX];
    user_skills_dir(base, sizeof base);
    DIR *d = opendir(base);
    if (!d) return 0;
    int count = 0;
    struct dirent *e;
    while ((e = readdir(d))) {
        if (!strcmp(e->d_name, ".") || !strcmp(e->d_name, "..")) continue;
        char path[DSTUDIO_PATH_MAX + 256];
        snprintf(path, sizeof path, "%s/%s/SKILL.md", base, e->d_name);
        struct stat st;
        if (stat(path, &st) == 0 && S_ISREG(st.st_mode)) count++;
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

    if (!updates_add_section(b, &first, "ds4-latest", "Bundled inference engines",
                             ds4_dir_valid() ? "ok" : "warn",
                             "Engine sources are included in DStudio. Update DStudio for new pinned engine revisions; upstream engine fetching is disabled.",
                             NULL)) return 0;

    int anchor_fails = update_patch_anchor_failures();
    char patch_detail[512];
    snprintf(patch_detail, sizeof patch_detail,
             anchor_fails == 0 ? "JSONL and web patch anchors match current ds4 source." :
             "Patch anchors have %d failure(s); structured agent/design gate must be repaired before relying on latest ds4.",
             anchor_fails);
    if (!updates_add_section(b, &first, "patch-verify", "Patch gate",
                             anchor_fails == 0 ? "ok" : "error",
                             patch_detail, "patch-verify")) return 0;

    int skills = update_count_user_skills();
    char skills_detail[512];
    snprintf(skills_detail, sizeof skills_detail,
             "%d user-created skill%s. DStudio does not download or update a skill catalog.",
             skills, skills == 1 ? "" : "s");
    if (!updates_add_section(b, &first, "user-skills", "User skills",
                             "ok", skills_detail, NULL)) return 0;

    int design_systems = design_systems_installed_count();
    char design_detail[512];
    snprintf(design_detail, sizeof design_detail,
             "%d original DStudio design system%s included offline.",
             design_systems < 0 ? 0 : design_systems, design_systems == 1 ? "" : "s");
    if (!updates_add_section(b, &first, "design-systems", "Design systems",
                             content_present() ? "ok" : "warn",
                             design_detail, "design-systems")) return 0;

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
    task_mark_working(task_id, "applying DStudio runtime patches");
    if (!setup_apply_ds4_runtime_patches()) {
        snprintf(err, errsz, "DStudio runtime patches failed; latest ds4 is not accepted");
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

static int updates_verify_design_systems(unsigned long long task_id, char *err, size_t errsz) {
    task_mark_working(task_id, "verifying design systems");
    if (!content_present()) {
        snprintf(err, errsz, "Bundled original design systems are incomplete; rebuild or reinstall DStudio.");
        return 0;
    }
    return 1;
}

static void api_updates_run(int fd, const char *body) {
    /* Stale clients cannot restore patches or pull a different engine revision.
     * The pinned source inventory and all adaptations ship with DStudio. */
    if (body && strstr(body, "\"ds4-latest\"")) {
        send_json(fd, "409 Conflict", "{\"ok\":false,\"error\":\"Upstream engine updates are disabled. Update DStudio for new bundled engine revisions. Existing source and model data were preserved.\"}");
        return;
    }
    unsigned long long task_id = task_begin("updates", "Run update doctor", "updates", g_mode, g_ds4_dir, 0, 0);
    char log_tail[8192] = "";
    char err[8600] = "";
    int ran = 0;
    int ok = 1;
    if (update_body_has_task(body, "gsa-tools")) {
        ran++;
        ok = updates_run_gsa_tools(task_id, log_tail, sizeof log_tail, err, sizeof err);
    }
    if (ok && update_body_has_task(body, "patch-verify")) {
        ran++;
        ok = updates_run_patch_verify(task_id, err, sizeof err);
    }
    if (ok && update_body_has_task(body, "design-systems")) {
        ran++;
        ok = updates_verify_design_systems(task_id, err, sizeof err);
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

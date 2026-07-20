/* ---- user-authored skills (created/edited from the web UI gear; the agent has NO
 * preset skills — these are the user's own) ----------------------------------------
 * Stored writable as <user_skills_dir>/<id>/SKILL.md. The on-demand skill() tool and the
 * catalog read them like shipped packs (user dir takes precedence). */

/* GET /api/user-skills — list the user's skills (id, name, description; no body). */
static void api_user_skills(int fd) {
    char body[16384];
    int o = snprintf(body, sizeof body, "{\"ok\":true,\"skills\":[");
    int n = 0;
    char dir[1100];
    user_skills_dir(dir, sizeof dir);
    DIR *d = opendir(dir);
    if (d) {
        struct dirent *de;
        while ((de = readdir(d)) != NULL && o < (int)sizeof body - 1400) {
            const char *id = de->d_name;
            if (id[0] == '.' || !skill_id_ok(id)) continue;
            char md[1600];
            snprintf(md, sizeof md, "%s/%s/SKILL.md", dir, id);
            size_t len = 0;
            char *content = jsonl_read_file(md, &len);
            if (!content) continue;
            char nm[300], desc[600];
            fm_field(content, "name", nm, sizeof nm);
            fm_field(content, "description", desc, sizeof desc);
            free(content);
            if (!nm[0]) cstr_copy(nm, sizeof nm, id);
            char ide[200], nme[400], dse[1200];
            json_escape_into(ide, sizeof ide, id, strlen(id));
            json_escape_into(nme, sizeof nme, nm, strlen(nm));
            json_escape_into(dse, sizeof dse, desc, strlen(desc));
            o += snprintf(body + o, sizeof body - o,
                "%s{\"id\":\"%s\",\"name\":\"%s\",\"description\":\"%s\"}", n++ ? "," : "", ide, nme, dse);
        }
        closedir(d);
    }
    snprintf(body + o, sizeof body - o, "]}");
    send_json(fd, "200 OK", body);
}

static const char *skill_doc_body_start(const char *content) {
    const char *b = content ? content : "";
    if (!strncmp(b, "---", 3)) {
        const char *e = strstr(b + 3, "\n---");
        if (e) {
            b = e + 4;
            while (*b == '\n' || *b == '\r') b++;
        }
    }
    return b;
}

static void send_skill_doc_json(int fd, const char *id, const char *source, const char *content) {
    char nm[300], desc[900], modes[220];
    fm_field(content, "name", nm, sizeof nm);
    fm_field(content, "description", desc, sizeof desc);
    fm_field(content, "modes", modes, sizeof modes);
    if (!nm[0]) cstr_copy(nm, sizeof nm, id);
    if (!modes[0]) cstr_copy(modes, sizeof modes, "[agent]");
    const char *b = skill_doc_body_start(content);

    json_dyn_buf out = {0};
    int ok = json_dyn_puts(&out, "{\"ok\":true,\"id\":") &&
             json_dyn_put_escaped(&out, id) &&
             json_dyn_puts(&out, ",\"source\":") &&
             json_dyn_put_escaped(&out, source ? source : "") &&
             json_dyn_puts(&out, ",\"name\":") &&
             json_dyn_put_escaped(&out, nm) &&
             json_dyn_puts(&out, ",\"description\":") &&
             json_dyn_put_escaped(&out, desc) &&
             json_dyn_puts(&out, ",\"modes\":") &&
             json_dyn_put_escaped(&out, modes) &&
             json_dyn_puts(&out, ",\"body\":") &&
             json_dyn_put_escaped(&out, b) &&
             json_dyn_puts(&out, "}");
    if (ok) send_json(fd, "200 OK", out.ptr);
    else send_json(fd, "500 Internal Server Error", "{\"ok\":false}");
    free(out.ptr);
}

static char *read_skill_doc_any(const char *id, char *source, size_t sourcesz) {
    char dir[PATH_MAX], md[PATH_MAX];
    size_t len = 0;

    user_skills_dir(dir, sizeof dir);
    snprintf(md, sizeof md, "%s/%s/SKILL.md", dir, id);
    char *content = jsonl_read_file(md, &len);
    if (content) {
        cstr_copy(source, sourcesz, "user");
        return content;
    }

    if (g_web_dir[0]) {
        snprintf(md, sizeof md, "%s/extension/skills/%s/SKILL.md", g_web_dir, id);
        content = jsonl_read_file(md, &len);
        if (content) {
            cstr_copy(source, sourcesz, "dstudio");
            return content;
        }
    }

    if (cyber_skills_dir(dir, sizeof dir)) {
        snprintf(md, sizeof md, "%s/%s/SKILL.md", dir, id);
        content = jsonl_read_file(md, &len);
        if (content) {
            cstr_copy(source, sourcesz, "anthropic-cybersecurity-skills");
            return content;
        }
    }
    return NULL;
}

/* GET /api/skills/get?id=<id> — read a skill body for the editor. User-authored
 * skills win over shipped packs, so saving creates a local override instead of
 * mutating the repository catalog. */
static void api_skill_get(int fd, const char *path) {
    char id[64] = {0};
    query_param(path, "id", id, sizeof id);
    if (!skill_id_ok(id)) { send_json(fd, "400 Bad Request", "{\"ok\":false,\"error\":\"bad id\"}"); return; }
    char source[80] = "";
    char *content = read_skill_doc_any(id, source, sizeof source);
    if (!content) { send_json(fd, "404 Not Found", "{\"ok\":false,\"error\":\"no such skill\"}"); return; }
    send_skill_doc_json(fd, id, source, content);
    free(content);
}

static const char *design_content_type(const char *name);   /* defined below */

static int preview_rel_path_ok(const char *rel) {
    if (!rel || !rel[0] || rel[0] == '/' || strchr(rel, '\\') || strstr(rel, "..")) return 0;
    if (rel[0] == '.' || strstr(rel, "/.")) return 0;
    return 1;
}

static int preview_rel_asset_ok(const char *rel, const char *entry_html) {
    if (!preview_rel_path_ok(rel)) return 0;
    if (entry_html && !strcmp(rel, entry_html)) return 1;
    const char *dot = strrchr(rel, '.');
    const char *ext = dot ? dot + 1 : "";
    static const char *allowed[] = {
        "html", "htm", "css", "js", "mjs", "json",
        "png", "jpg", "jpeg", "webp", "svg", "gif", "ico",
        "woff", "woff2", "ttf", "otf", "mp4", "webm",
        NULL
    };
    for (int i = 0; allowed[i]; i++) {
        const char *a = ext, *b = allowed[i];
        while (*a && *b && ascii_eq_ci(*a, *b)) { a++; b++; }
        if (!*a && !*b) return 1;
    }
    return 0;
}

static int skill_preview_rel_ok(const char *rel) {
    return preview_rel_asset_ok(rel, "example.html");
}

static int design_system_preview_rel_ok(const char *rel) {
    return preview_rel_asset_ok(rel, "components.html");
}

/* GET /api/skill-preview/<id>/<preview-asset> — serve only shipped Open Design
 * template preview files. Local CSS/JS/fonts/images are allowed so original
 * examples render faithfully; user skills and cybersecurity packs are excluded. */
static void api_skill_preview(int fd, const char *path, int head_only) {
    static const char prefix[] = "/api/skill-preview/";
    const char *raw = path + strlen(prefix);
    const char *slash = strchr(raw, '/');
    if (!slash) { send_text(fd, "400 Bad Request", "path missing\n", head_only); return; }
    char id[64] = {0};
    url_decode_into(raw, (size_t)(slash - raw), id, sizeof id);
    if (!skill_id_ok(id)) { send_text(fd, "400 Bad Request", "bad id\n", head_only); return; }
    char rel[1024] = {0};
    url_decode_into(slash + 1, strcspn(slash + 1, "?"), rel, sizeof rel);
    if (!skill_preview_rel_ok(rel)) { send_text(fd, "400 Bad Request", "bad preview path\n", head_only); return; }
    if (!g_web_dir[0]) { send_text(fd, "404 Not Found", "web directory not found\n", head_only); return; }

    char md[2048];
    snprintf(md, sizeof md, "%s/extension/skills/%s/SKILL.md", g_web_dir, id);
    size_t mdlen = 0;
    char *content = jsonl_read_file(md, &mdlen);
    if (!content) { send_text(fd, "404 Not Found", "skill not found\n", head_only); return; }
    char upstream[400];
    fm_field(content, "ds4_upstream", upstream, sizeof upstream);
    free(content);
    if (strncmp(upstream, "open-design/", 12) != 0) {
        send_text(fd, "404 Not Found", "not an Open Design template\n", head_only);
        return;
    }

    char file[3072];
    snprintf(file, sizeof file, "%s/extension/skills/%s/%s", g_web_dir, id, rel);
    size_t len = 0;
    char *buf = read_html_disk(file, &len);
    if (!buf) { send_text(fd, "404 Not Found", "preview file not found\n", head_only); return; }
    send_response_hdrs(fd, "200 OK", design_content_type(rel), buf, len, head_only, DESIGN_HEADERS);
    free(buf);
}

/* GET /api/design-system-preview/<id>/<components.html|tokens.css|preview/...>
 * serves bundled design-system preview assets directly from extension/design-systems.
 * No generated fallback is produced here: the gallery either shows upstream local
 * files or a text-only card from DESIGN.md metadata. */
static void api_design_system_preview(int fd, const char *path, int head_only) {
    static const char prefix[] = "/api/design-system-preview/";
    const char *raw = path + strlen(prefix);
    const char *slash = strchr(raw, '/');
    if (!slash) { send_text(fd, "400 Bad Request", "path missing\n", head_only); return; }
    char id[64] = {0};
    url_decode_into(raw, (size_t)(slash - raw), id, sizeof id);
    if (!skill_id_ok(id)) { send_text(fd, "400 Bad Request", "bad id\n", head_only); return; }
    char rel[1024] = {0};
    url_decode_into(slash + 1, strcspn(slash + 1, "?"), rel, sizeof rel);
    if (!design_system_preview_rel_ok(rel)) { send_text(fd, "400 Bad Request", "bad preview path\n", head_only); return; }
    if (!g_web_dir[0]) { send_text(fd, "404 Not Found", "web directory not found\n", head_only); return; }

    char md[2048];
    snprintf(md, sizeof md, "%s/extension/design-systems/%s/DESIGN.md", g_web_dir, id);
    if (access(md, R_OK) != 0) {
        send_text(fd, "404 Not Found", "design system not found\n", head_only);
        return;
    }

    char file[3072];
    snprintf(file, sizeof file, "%s/extension/design-systems/%s/%s", g_web_dir, id, rel);
    size_t len = 0;
    char *buf = read_html_disk(file, &len);
    if (!buf) { send_text(fd, "404 Not Found", "preview file not found\n", head_only); return; }
    send_response_hdrs(fd, "200 OK", design_content_type(rel), buf, len, head_only, DESIGN_HEADERS);
    free(buf);
}

/* GET /api/user-skills/get?id=<id> — one skill's name/description/body, for the editor. */
static void api_user_skill_get(int fd, const char *path) {
    char id[64] = {0};
    query_param(path, "id", id, sizeof id);
    if (!skill_id_ok(id)) { send_json(fd, "400 Bad Request", "{\"ok\":false,\"error\":\"bad id\"}"); return; }
    char dir[1100], md[1300];
    user_skills_dir(dir, sizeof dir);
    snprintf(md, sizeof md, "%s/%s/SKILL.md", dir, id);
    size_t len = 0;
    char *content = jsonl_read_file(md, &len);
    if (!content) { send_json(fd, "404 Not Found", "{\"ok\":false,\"error\":\"no such skill\"}"); return; }
    send_skill_doc_json(fd, id, "user", content);
    free(content);
}

/* POST /api/user-skills {id,name,description,body} — create or overwrite a user skill. */
static void api_user_skill_save(int fd, const char *reqbody) {
    char id[64] = {0}, name[256] = {0}, desc[600] = {0}, modes[220] = {0};
    static char skbody[32768];
    json_get_string(reqbody, "id", id, sizeof id);
    if (!skill_id_ok(id)) { send_json(fd, "400 Bad Request", "{\"ok\":false,\"error\":\"id must be a-z, 0-9, -\"}"); return; }
    json_get_string(reqbody, "name", name, sizeof name);
    json_get_string(reqbody, "description", desc, sizeof desc);
    json_get_string(reqbody, "modes", modes, sizeof modes);
    if (!json_get_string(reqbody, "body", skbody, sizeof skbody)) skbody[0] = '\0';
    if (!name[0]) snprintf(name, sizeof name, "%s", id);
    if (!modes[0]) snprintf(modes, sizeof modes, "[agent]");
    /* frontmatter is line-based: keep name/description single-line. */
    for (char *p = name; *p; p++) if (*p == '\n' || *p == '\r') *p = ' ';
    for (char *p = desc; *p; p++) if (*p == '\n' || *p == '\r') *p = ' ';
    for (char *p = modes; *p; p++) if (*p == '\n' || *p == '\r') *p = ' ';
    char dir[1100], sub[1200], md[1300];
    user_skills_dir(dir, sizeof dir);
    snprintf(sub, sizeof sub, "%s/%s", dir, id);
    mkpath(sub);
    snprintf(md, sizeof md, "%s/SKILL.md", sub);
    static char filebuf[40000];
    int fo = snprintf(filebuf, sizeof filebuf,
        "---\nname: %s\ndescription: %s\nmodes: %s\n---\n\n%s\n", name, desc, modes, skbody);
    if (fo < 0 || !jsonl_write_file(md, filebuf, (size_t)fo)) {
        send_json(fd, "500 Internal Server Error", "{\"ok\":false,\"error\":\"could not write the skill\"}");
        return;
    }
    char out[260];
    char ide[200];
    json_escape_into(ide, sizeof ide, id, strlen(id));
    snprintf(out, sizeof out, "{\"ok\":true,\"id\":\"%s\"}", ide);
    send_json(fd, "200 OK", out);
}

/* POST /api/user-skills/delete {id} — remove a user skill. */
static void api_user_skill_delete(int fd, const char *reqbody) {
    char id[64] = {0};
    json_get_string(reqbody, "id", id, sizeof id);
    if (!skill_id_ok(id)) { send_json(fd, "400 Bad Request", "{\"ok\":false,\"error\":\"bad id\"}"); return; }
    char dir[1100], md[1300], sub[1200];
    user_skills_dir(dir, sizeof dir);
    snprintf(md, sizeof md, "%s/%s/SKILL.md", dir, id);
    snprintf(sub, sizeof sub, "%s/%s", dir, id);
    unlink(md);
    rmdir(sub);
    if (!strcmp(g_skill, id)) g_skill[0] = '\0';   /* deselect if it was active */
    send_json(fd, "200 OK", "{\"ok\":true}");
}

/* Explicit, complete upstream adaptations under patch/. The native reader
 * rejects missing, ambiguous or drifted deltas before publishing a candidate. */
#define JSONL_MARK "/*DS4UI_JSONL*/"
#define JSONL_PATCH_DIR "patch/ds4-agent-jsonl"
#define WEB_RUNTIME_PATCH_DIR "patch/ds4-web-runtime"

typedef struct {
    char rel_dir[160];
    char name[80];
    char dir_path[DSTUDIO_PATH_MAX + 512];
    char makefile_path[DSTUDIO_PATH_MAX + 512];
    int version;
    char **unified_paths;
    int unified_count;
} ds4ui_patch_set;

static char *jsonl_read_file(const char *path, size_t *len) {
    FILE *f = fopen(path, "rb");
    if (!f) return NULL;
    if (fseek(f, 0, SEEK_END) != 0) { fclose(f); return NULL; }
    long sz = ftell(f);
    if (sz < 0) { fclose(f); return NULL; }
    rewind(f);
    char *b = malloc((size_t)sz + 1);
    if (!b) { fclose(f); return NULL; }
    if (fread(b, 1, (size_t)sz, f) != (size_t)sz) { free(b); fclose(f); return NULL; }
    fclose(f);
    b[sz] = '\0';
    if (len) *len = (size_t)sz;
    return b;
}

static int jsonl_write_file(const char *path, const char *data, size_t len) {
    FILE *f = fopen(path, "wb");
    if (!f) return 0;
    int ok = fwrite(data, 1, len, f) == len;
    if (fclose(f)) ok = 0;
    return ok;
}

static void jsonl_normalize_newlines(char *b, size_t *len) {
    size_t r = 0, w = 0, n = len ? *len : strlen(b);
    while (r < n) {
        if (b[r] == '\r') {
            if (r + 1 < n && b[r + 1] == '\n') r++;
            b[w++] = '\n';
            r++;
        } else {
            b[w++] = b[r++];
        }
    }
    b[w] = '\0';
    if (len) *len = w;
}

static int patch_fail(const char *fmt, ...) {
    char msg[640];
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(msg, sizeof msg, fmt, ap);
    va_end(ap);
    fprintf(stderr, "DStudio patch error: %s\n", msg);
    snprintf(g_engine_err, sizeof g_engine_err, "patch error: %.220s", msg);
    return 0;
}

static char *patch_trim(char *s) {
    while (s && isspace((unsigned char)*s)) s++;
    if (!s) return s;
    char *e = s + strlen(s);
    while (e > s && isspace((unsigned char)e[-1])) *--e = '\0';
    return s;
}

static int patch_leaf_ok(const char *leaf) {
    if (!leaf || !leaf[0]) return 0;
    for (const unsigned char *p = (const unsigned char *)leaf; *p; p++) {
        if (isalnum(*p) || *p == '-' || *p == '_' || *p == '.') continue;
        return 0;
    }
    return 1;
}

static int patch_resolve_dir(const char *rel_dir, char *out, size_t outsz) {
    char primary[DSTUDIO_PATH_MAX + 512];
    if (g_web_dir[0]) {
        snprintf(primary, sizeof primary, "%s/%s", g_web_dir, rel_dir);
        if (access(primary, R_OK) == 0) {
            cstr_copy(out, outsz, primary);
            return 1;
        }
    }
    snprintf(primary, sizeof primary, "%s", rel_dir);
    if (access(primary, R_OK) == 0) {
        cstr_copy(out, outsz, primary);
        return 1;
    }
    if (g_web_dir[0])
        return patch_fail("patch directory not found: %s/%s", g_web_dir, rel_dir);
    return patch_fail("patch directory not found: %s", rel_dir);
}

static int patch_dir_newer_than(const char *rel_dir, time_t cutoff) {
    char dir[DSTUDIO_PATH_MAX + 512];
    if (!patch_resolve_dir(rel_dir, dir, sizeof dir)) return 1;
    DIR *d = opendir(dir);
    if (!d) return 1;
    int newer = 0;
    struct dirent *de;
    while ((de = readdir(d)) != NULL) {
        const char *name = de->d_name;
        if (!strcmp(name, ".") || !strcmp(name, "..")) continue;
        char file[DSTUDIO_PATH_MAX + 1024];
        if ((size_t)snprintf(file, sizeof file, "%s/%s", dir, name) >= sizeof file) {
            newer = 1;
            break;
        }
        struct stat st;
        if (stat(file, &st) != 0) {
            newer = 1;
            break;
        }
        if (st.st_mtime > cutoff) {
            newer = 1;
            break;
        }
    }
    closedir(d);
    return newer;
}

static int patch_join_leaf(const ds4ui_patch_set *set, const char *leaf, char *out, size_t outsz) {
    if (!patch_leaf_ok(leaf))
        return patch_fail("invalid patch file name '%s' in %s", leaf ? leaf : "", set->rel_dir);
    int n = snprintf(out, outsz, "%s/%s", set->dir_path, leaf);
    if (n < 0 || (size_t)n >= outsz)
        return patch_fail("patch path too long: %s/%s", set->dir_path, leaf);
    return 1;
}

static void patch_free_set(ds4ui_patch_set *set) {
    if (!set) return;
    for (int i = 0; i < set->unified_count; i++) free(set->unified_paths[i]);
    free(set->unified_paths);
    memset(set, 0, sizeof *set);
}

static char *unified_read(const char *path, size_t *size);

static char *patch_read_text(const char *path, size_t *len) {
    size_t n = 0;
    char *body = unified_read(path, &n);
    if (!body) return NULL;
    if (len) *len = n;
    return body;
}

static int patch_load_set(const char *rel_dir, ds4ui_patch_set *set) {
    memset(set, 0, sizeof *set);
    cstr_copy(set->rel_dir, sizeof set->rel_dir, rel_dir);
    if (!patch_resolve_dir(rel_dir, set->dir_path, sizeof set->dir_path)) return 0;

    char manifest_path[DSTUDIO_PATH_MAX + 512];
    if (!patch_join_leaf(set, "manifest", manifest_path, sizeof manifest_path)) return 0;
    size_t manifest_len = 0;
    char *manifest = patch_read_text(manifest_path, &manifest_len);
    if (!manifest) return 0;

    for (char *line = manifest; line && *line; ) {
        char *next = strchr(line, '\n');
        if (next) *next++ = '\0';
        char *trimmed = patch_trim(line);
        if (!trimmed[0] || trimmed[0] == '#') { line = next; continue; }
        char *eq = strchr(trimmed, '=');
        if (!eq) {
            patch_fail("invalid manifest line in %s: %s", manifest_path, trimmed);
            free(manifest);
            patch_free_set(set);
            return 0;
        }
        *eq = '\0';
        char *key = patch_trim(trimmed);
        char *val = patch_trim(eq + 1);
        if (!strcmp(key, "name")) {
            cstr_copy(set->name, sizeof set->name, val);
        } else if (!strcmp(key, "version")) {
            char *end = NULL;
            long v = strtol(val, &end, 10);
            if (end == val || *end != '\0' || v <= 0 || v > 1000000) {
                patch_fail("invalid patch version in %s: %s", manifest_path, val);
                free(manifest);
                patch_free_set(set);
                return 0;
            }
            set->version = (int)v;
        } else if (!strcmp(key, "patch")) {
            char full[DSTUDIO_PATH_MAX + 512];
            size_t len = strlen(val);
            if (set->unified_count >= 8 || len < 7 || strcmp(val + len - 6, ".patch") ||
                !patch_join_leaf(set, val, full, sizeof full)) {
                free(manifest); patch_free_set(set);
                return patch_fail("invalid unified patch entry in %s", manifest_path);
            }
            char **paths = realloc(set->unified_paths,
                                   (size_t)(set->unified_count + 1) * sizeof *paths);
            if (!paths) { free(manifest); patch_free_set(set); return 0; }
            set->unified_paths = paths;
            char *copy = ds4_strdup_local(full);
            if (!copy) { free(manifest); patch_free_set(set); return 0; }
            set->unified_paths[set->unified_count++] = copy;
        } else if (!strcmp(key, "makefile")) {
            if (!patch_join_leaf(set, val, set->makefile_path, sizeof set->makefile_path)) {
                free(manifest); patch_free_set(set); return 0;
            }
        } else {
            patch_fail("unknown manifest key '%s' in %s", key, manifest_path);
            free(manifest);
            patch_free_set(set);
            return 0;
        }
        line = next;
    }
    free(manifest);
    if (!set->name[0]) cstr_copy(set->name, sizeof set->name, rel_dir);
    if (!set->unified_count) {
        patch_free_set(set);
        return patch_fail("manifest requires complete unified patches: %s", manifest_path);
    }
    return 1;
}

static int jsonl_patch_version(void) {
    ds4ui_patch_set patch;
    if (!patch_load_set(JSONL_PATCH_DIR, &patch)) return -1;
    int version = patch.version;
    patch_free_set(&patch);
    if (version <= 0) {
        patch_fail("%s manifest is missing a positive version", JSONL_PATCH_DIR);
        return -1;
    }
    return version;
}

static char *jsonl_read_patch_makefile(size_t *len) {
    ds4ui_patch_set patch;
    if (!patch_load_set(JSONL_PATCH_DIR, &patch)) return NULL;
    if (!patch.makefile_path[0]) {
        patch_free_set(&patch);
        patch_fail("%s manifest is missing makefile=", JSONL_PATCH_DIR);
        return NULL;
    }
    char path[DSTUDIO_PATH_MAX + 512];
    cstr_copy(path, sizeof path, patch.makefile_path);
    patch_free_set(&patch);
    return patch_read_text(path, len);
}

/* Skill id sanitiser: only [a-z0-9-], so it can never escape the user skill directory. */
static int skill_id_ok(const char *s) {
    if (!s || !s[0]) return 0;
    for (const char *p = s; *p; p++) {
        char c = *p;
        if (!((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-')) return 0;
    }
    return 1;
}

static void fm_field(const char *content, const char *key, char *out, size_t outsz);  /* fwd */
static void url_decode_into(const char *src, size_t n, char *out, size_t outsz);  /* fwd */

static void query_param(const char *path, const char *key, char *out, size_t outsz) {
    out[0] = '\0';
    const char *q = strchr(path, '?');
    if (!q) return;
    q++;
    size_t klen = strlen(key);
    while (*q) {
        const char *amp = strchr(q, '&');
        size_t seglen = amp ? (size_t)(amp - q) : strlen(q);
        if (seglen > klen && !strncmp(q, key, klen) && q[klen] == '=') {
            url_decode_into(q + klen + 1, seglen - klen - 1, out, outsz);
            for (char *p = out; *p; p++) if (*p == '+') *p = ' ';
            return;
        }
        if (!amp) break;
        q = amp + 1;
    }
}

static int text_contains_ci(const char *hay, const char *needle) {
    if (!needle || !needle[0]) return 1;
    return hay && mem_contains_ci(hay, strlen(hay), needle);
}


/* Skill search is SEMANTIC (embedding cosine), not lexical — the corpus is
 * enumerated here and ranked by the embedding provider further below. */

/* One ranked search hit (owns its strings). */
typedef struct {
    char *id, *name, *desc, *source, *domain, *subdomain, *tags, *license;
    int has_assets, has_refs, has_scripts;
    int score, order;
} skill_hit;
typedef struct { skill_hit *v; int n, cap; } skill_hit_list;

static int skill_hits_push(skill_hit_list *L, skill_hit h) {
    if (L->n >= L->cap) {
        int nc = L->cap ? L->cap * 2 : 64;
        skill_hit *nv = realloc(L->v, (size_t)nc * sizeof *nv);
        if (!nv) return 0;
        L->v = nv; L->cap = nc;
    }
    L->v[L->n++] = h;
    return 1;
}
static void skill_hit_free_fields(skill_hit *h) {
    free(h->id); free(h->name); free(h->desc); free(h->source);
    free(h->domain); free(h->subdomain); free(h->tags); free(h->license);
}
static void skill_hits_free(skill_hit_list *L) {
    for (int i = 0; i < L->n; i++) skill_hit_free_fields(&L->v[i]);
    free(L->v);
}
static int skill_hit_cmp(const void *a, const void *b) {
    const skill_hit *x = a, *y = b;
    if (x->score != y->score) return y->score - x->score;   /* score desc */
    return x->order - y->order;                             /* else stable scan order */
}

/* Enumerate every skill under <dir> into L (no scoring — the embedding cosine
 * ranks them). `embed_text` per hit = name + description + tags, used to build
 * the embedding index; the display fields feed the JSON result. Order/score are
 * filled by the semantic ranker. */
static int skill_enum_dir(skill_hit_list *L, const char *dir, const char *file, const char *source) {
    DIR *d = opendir(dir);
    if (!d) return 1;
    struct dirent *de;
    while ((de = readdir(d)) != NULL) {
        const char *id = de->d_name;
        if (id[0] == '.' || !skill_id_ok(id)) continue;
        char md[PATH_MAX];
        if ((size_t)snprintf(md, sizeof md, "%s/%s/%s", dir, id, file) >= sizeof md)
            continue;
        size_t len = 0;
        char *content = jsonl_read_file(md, &len);
        if (!content) continue;
        char nm[300], desc[1000], domain[120], subdomain[160], tags[600], license[120];
        fm_field(content, "name", nm, sizeof nm);
        fm_field(content, "description", desc, sizeof desc);
        fm_field(content, "domain", domain, sizeof domain);
        fm_field(content, "subdomain", subdomain, sizeof subdomain);
        fm_field(content, "tags", tags, sizeof tags);
        fm_field(content, "license", license, sizeof license);
        free(content);
        if (!nm[0]) cstr_copy(nm, sizeof nm, id);
        char assets[PATH_MAX], refs[PATH_MAX], scripts[PATH_MAX];
        snprintf(assets, sizeof assets, "%s/%s/assets", dir, id);
        snprintf(refs, sizeof refs, "%s/%s/references", dir, id);
        snprintf(scripts, sizeof scripts, "%s/%s/scripts", dir, id);
        skill_hit h = {0};
        h.id = ds4_strdup_local(id);   h.name = ds4_strdup_local(nm);
        h.desc = ds4_strdup_local(desc); h.source = ds4_strdup_local(source);
        h.domain = ds4_strdup_local(domain); h.subdomain = ds4_strdup_local(subdomain);
        h.tags = ds4_strdup_local(tags); h.license = ds4_strdup_local(license);
        h.has_assets = access(assets, R_OK) == 0;
        h.has_refs = access(refs, R_OK) == 0;
        h.has_scripts = access(scripts, R_OK) == 0;
        h.score = 0; h.order = 0;
        if (!skill_hits_push(L, h)) { skill_hit_free_fields(&h); closedir(d); return 0; }
    }
    closedir(d);
    return 1;
}

/* embed_text for one skill (name + description + tags) → malloc'd. */
static char *skill_embed_text(const skill_hit *h) {
    size_t need = strlen(h->name) + strlen(h->desc) + strlen(h->tags) + 4;
    char *t = malloc(need);
    if (!t) return NULL;
    snprintf(t, need, "%s\n%s\n%s", h->name, h->desc, h->tags);
    return t;
}

/* Deterministic ordering (source, id) so the on-disk index rows line up with a
 * re-enumeration regardless of readdir() order. */
static int skill_hit_id_cmp(const void *a, const void *b) {
    const skill_hit *x = a, *y = b;
    int c = strcmp(x->source, y->source);
    return c ? c : strcmp(x->id, y->id);
}

/* Enumerate user-authored skills only, sorted stably. Downloaded/shipped skill
 * catalogs are deliberately unsupported. */
static int skill_enum_all(skill_hit_list *L) {
    char udir[1100];
    user_skills_dir(udir, sizeof udir);
    if (!skill_enum_dir(L, udir, "SKILL.md", "user")) return 0;
    if (L->n > 1) qsort(L->v, (size_t)L->n, sizeof *L->v, skill_hit_id_cmp);
    for (int i = 0; i < L->n; i++) L->v[i].order = i;
    return 1;
}

/* Append "label:\n- id: description\n…" for every pack directly under <dir> (each a
 * <dir>/<id>/<file>) to a bounded buffer, for the on-demand catalog. */
static void catalog_append(char *out, size_t cap, size_t *o, const char *dir,
                           const char *file, const char *label) {
    DIR *d = opendir(dir);
    if (!d) return;
    int any = 0;
    struct dirent *de;
    while ((de = readdir(d)) != NULL && *o < cap - 256) {
        const char *id = de->d_name;
        if (id[0] == '.' || !skill_id_ok(id)) continue;
        if (!strcmp(file, "DESIGN.md") && !dstudio_design_system_supported(id)) continue;
        char md[2300];
        snprintf(md, sizeof md, "%s/%s/%s", dir, id, file);
        size_t len = 0;
        char *content = jsonl_read_file(md, &len);
        if (!content) continue;
        char desc[320], cat[120], local_mode[80], output[160], provider[120];
        fm_field(content, "description", desc, sizeof desc);
        fm_field(content, "ds4_category", cat, sizeof cat);
        fm_field(content, "ds4_local_mode", local_mode, sizeof local_mode);
        fm_field(content, "ds4_output_kinds", output, sizeof output);
        fm_field(content, "ds4_provider", provider, sizeof provider);
        free(content);
        char assets[2300], refs[2300], example[2300];
        snprintf(assets, sizeof assets, "%s/%s/assets", dir, id);
        snprintf(refs, sizeof refs, "%s/%s/references", dir, id);
        snprintf(example, sizeof example, "%s/%s/example.html", dir, id);
        int has_assets = access(assets, R_OK) == 0;
        int has_refs = access(refs, R_OK) == 0;
        int has_example = access(example, R_OK) == 0;
        if (!any) { *o += (size_t)snprintf(out + *o, cap - *o, "%s:\n", label); any = 1; }
        *o += (size_t)snprintf(out + *o, cap - *o, "- %s: %s", id, desc);
        if (cat[0] || local_mode[0] || output[0] || provider[0] ||
            has_assets || has_refs || has_example)
        {
            *o += (size_t)snprintf(out + *o, cap - *o, " [");
            int first = 1;
            if (cat[0]) { *o += (size_t)snprintf(out + *o, cap - *o, "cat=%s", cat); first = 0; }
            if (local_mode[0]) { *o += (size_t)snprintf(out + *o, cap - *o, "%smode=%s", first ? "" : "; ", local_mode); first = 0; }
            if (output[0]) { *o += (size_t)snprintf(out + *o, cap - *o, "%sout=%s", first ? "" : "; ", output); first = 0; }
            if (provider[0]) { *o += (size_t)snprintf(out + *o, cap - *o, "%sprovider=%s", first ? "" : "; ", provider); first = 0; }
            if (has_assets || has_refs || has_example) {
                *o += (size_t)snprintf(out + *o, cap - *o, "%sfiles=", first ? "" : "; ");
                if (has_assets) *o += (size_t)snprintf(out + *o, cap - *o, "assets");
                if (has_refs) *o += (size_t)snprintf(out + *o, cap - *o, "%sreferences", has_assets ? "," : "");
                if (has_example) *o += (size_t)snprintf(out + *o, cap - *o, "%sexample", (has_assets || has_refs) ? "," : "");
            }
            *o += (size_t)snprintf(out + *o, cap - *o, "]");
        }
        *o += (size_t)snprintf(out + *o, cap - *o, "\n");
    }
    closedir(d);
    if (any) *o += (size_t)snprintf(out + *o, cap - *o, "\n");
}

/* Read the body of an active user-authored skill. Caller frees. */
static char *read_selected_skill(size_t *len) {
    char path[2300], udir[1100];
    user_skills_dir(udir, sizeof udir);
    snprintf(path, sizeof path, "%s/%s/SKILL.md", udir, g_skill);
    return jsonl_read_file(path, len);
}

/* Append a file's bytes to a growing buffer with a blank-line separator. Frees src. */
static void sys_append(char **buf, size_t *len, size_t *cap, char *src, size_t slen) {
    if (!src) return;
    size_t need = *len + slen + 4;
    if (need > *cap) {
        size_t nc = need + 1024;
        char *nb = realloc(*buf, nc);
        if (!nb) { free(src); return; }
        *buf = nb; *cap = nc;
    }
    if (*len) { (*buf)[(*len)++] = '\n'; (*buf)[(*len)++] = '\n'; }
    memcpy(*buf + *len, src, slen); *len += slen;
    (*buf)[*len] = '\0';
    free(src);
}

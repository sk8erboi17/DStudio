/* Pinned Qwen3.6-35B-A3B and Qwen3.8-27B variants (scripts/qwen-variants.json).
 *
 * Owner: the HTTP owner. qwen_catalog_reload() parses and validates the whole
 * document into a private candidate and publishes it in one pointer swap;
 * readers never see a partial catalog and never keep a variant pointer across
 * requests (a download copies the variant it admitted).
 * Identity/lifetime: the file in the support directory, read when that
 * directory is resolved or changed (startup, POST /api/webdir, which waits for
 * launch preparation) and by the --prepare-launch worker. Launches capture the
 * file as a dependency, so a change during preparation rejects the candidate.
 * Limits: 512 KiB, 32768 JSON tokens, 96 variants, 8 components, 3 GGUF parts,
 * 64 files per MLX folder. Validation mirrors scripts/download-qwen-variant.py.
 * Failure: a missing or invalid catalog leaves the compiled original pins
 * (qwen36-q6, qwen27-q6, qwen36-mlx) and keeps the reason for diagnostics.
 * The catalog names files; it never proves them: launches still check that the
 * files exist and engines validate their contents, and every download verifies
 * size and SHA-256 before publication. Runtime code never fetches it. */
#include "../extension/remote/dstudio_json_tokens.h"

enum { QWEN_FAMILY_36 = 1, QWEN_FAMILY_27 = 2 };
enum { QWEN_ENGINE_LLAMA = 1, QWEN_ENGINE_MLX = 2 };
#define QWEN_CATALOG_REL "scripts/qwen-variants.json"
#define QWEN_CATALOG_SCHEMA "dstudio.qwen-variants"
#define QWEN_CATALOG_MAX_BYTES (512 * 1024)
#define QWEN_CATALOG_MAX_TOKENS 32768
#define QWEN_VARIANTS_MAX 96
#define QWEN_COMPONENTS_MAX 8
#define QWEN_GGUF_PARTS_MAX 3
#define QWEN_MLX_FILES_MAX 64
#define QWEN_FILE_BYTES_MAX (1024LL * 1024 * 1024 * 1024)
/* The private per-file stage of scripts/download-qwen-variant.py, shared by
 * every Qwen download (gguf/ and each MLX folder have their own). */
#define QWEN_STAGE_DIR ".dstudio-qwen27-downloads"

typedef struct { char name[104]; long long bytes; } qwen_file;
typedef struct {
    char id[40], quant[24], path[112]; /* path: gguf/<first part> or mlx/<folder> */
    int family, engine;
    int parts;      /* llama: GGUF parts; files[0] is the one llama.cpp opens */
    int projector;  /* llama: 1 when files[parts] is the required projector */
    qwen_file files[QWEN_GGUF_PARTS_MAX + 1];
    long long bytes; /* own files plus required components */
} qwen_variant;
typedef struct {
    int count;
    qwen_variant variants[QWEN_VARIANTS_MAX];
    char *document;  /* the validated bytes, served verbatim; NULL for the compiled pins */
    size_t document_len;
} qwen_catalog;

static qwen_catalog *g_qwen_catalog = NULL;
static char g_qwen_catalog_error[256] = "not loaded";
static int model_file_is_modified_weights(const char *name);

static const char *qwen_family_prefix(int family) {
    return family == QWEN_FAMILY_27 ? "Qwen3.8-27B-" : "Qwen3.6-35B-A3B-";
}
static const char *qwen_family_label(int family) {
    return family == QWEN_FAMILY_27 ? "Qwen3.8-27B" : "Qwen3.6-35B-A3B";
}

/* The original pins, compiled in. A catalog must reproduce them exactly. */
static const qwen_catalog *qwen_compiled_catalog(void) {
    static qwen_catalog compiled;
    if (compiled.count) return &compiled;
    qwen_variant *v = &compiled.variants[0];
    cstr_copy(v->id, sizeof v->id, "qwen36-q6"); cstr_copy(v->quant, sizeof v->quant, "UD-Q6_K_XL");
    cstr_copy(v->path, sizeof v->path, MODEL_QWEN35);
    v->family = QWEN_FAMILY_36; v->engine = QWEN_ENGINE_LLAMA; v->parts = 1;
    cstr_copy(v->files[0].name, sizeof v->files[0].name, &MODEL_QWEN35[5]);
    v->files[0].bytes = v->bytes = MODEL_QWEN35_BYTES;
    v = &compiled.variants[1];
    cstr_copy(v->id, sizeof v->id, "qwen27-q6"); cstr_copy(v->quant, sizeof v->quant, "UD-Q6_K_XL");
    cstr_copy(v->path, sizeof v->path, MODEL_QWEN27);
    v->family = QWEN_FAMILY_27; v->engine = QWEN_ENGINE_LLAMA; v->parts = 1; v->projector = 1;
    cstr_copy(v->files[0].name, sizeof v->files[0].name, &MODEL_QWEN27[5]);
    v->files[0].bytes = MODEL_QWEN27_BYTES;
    cstr_copy(v->files[1].name, sizeof v->files[1].name, &MODEL_QWEN27_VISION[5]);
    v->files[1].bytes = MODEL_QWEN27_VISION_BYTES;
    v->bytes = MODEL_QWEN27_BYTES + MODEL_QWEN27_VISION_BYTES;
    v = &compiled.variants[2];
    cstr_copy(v->id, sizeof v->id, "qwen36-mlx"); cstr_copy(v->quant, sizeof v->quant, "mxfp8");
    cstr_copy(v->path, sizeof v->path, MODEL_QWEN36_MLX);
    v->family = QWEN_FAMILY_36; v->engine = QWEN_ENGINE_MLX;
    v->bytes = MODEL_QWEN36_MLX_BYTES;
    compiled.count = 3;
    return &compiled;
}

static const qwen_catalog *qwen_catalog_current(void) {
    return g_qwen_catalog ? g_qwen_catalog : qwen_compiled_catalog();
}

static const qwen_variant *qwen_variant_by_id(const char *id) {
    const qwen_catalog *c = qwen_catalog_current();
    for (int i = 0; id && i < c->count; i++)
        if (!strcmp(c->variants[i].id, id)) return &c->variants[i];
    return NULL;
}

/* A selectable model: mlx/<folder> (case-insensitive, like the folder lookup
 * on macOS) or a GGUF whose base name is a variant's first part. */
static const qwen_variant *qwen_variant_for_rel(const char *rel) {
    if (!rel) return NULL;
    const qwen_catalog *c = qwen_catalog_current();
    if (!strncmp(rel, "mlx/", 4)) {
        for (int i = 0; i < c->count; i++)
            if (c->variants[i].engine == QWEN_ENGINE_MLX && ascii_str_eq_ci(rel, c->variants[i].path))
                return &c->variants[i];
        return NULL;
    }
    const char *base = strrchr(rel, '/');
    base = base ? base + 1 : rel;
    for (int i = 0; i < c->count; i++)
        if (c->variants[i].engine == QWEN_ENGINE_LLAMA && !strcmp(base, c->variants[i].files[0].name))
            return &c->variants[i];
    return NULL;
}

/* Another part of a split GGUF, or a projector: listed so the UI can see that
 * it is present, never selectable on its own. */
static int qwen_gguf_component_name(const char *name) {
    if (!name) return 0;
    const char *base = strrchr(name, '/');
    base = base ? base + 1 : name;
    const qwen_catalog *c = qwen_catalog_current();
    for (int i = 0; i < c->count; i++) {
        const qwen_variant *v = &c->variants[i];
        if (v->engine != QWEN_ENGINE_LLAMA) continue;
        for (int f = 1; f < v->parts + v->projector; f++)
            if (!strcmp(base, v->files[f].name)) return 1;
    }
    return 0;
}

/* The display name of a quantization: MLX folder modes read as 4-bit/MXFP8. */
static void qwen_quant_display(const qwen_variant *v, char *out, size_t cap) {
    if (v->engine != QWEN_ENGINE_MLX) { cstr_copy(out, cap, v->quant); return; }
    size_t n = strlen(v->quant);
    if (n >= 4 && !strcmp(v->quant + n - 3, "bit")) { snprintf(out, cap, "%.*s-bit", (int)(n - 3), v->quant); return; }
    size_t i = 0;
    for (; v->quant[i] && i + 1 < cap; i++) out[i] = (char)toupper((unsigned char)v->quant[i]);
    out[i] = '\0';
}

/* "Qwen3.6-35B-A3B UD-Q4_K_M" or "Qwen3.8-27B 4-bit (MLX)". Rotating static
 * buffers: one message may name two models. */
static const char *qwen_variant_label(const qwen_variant *v) {
    static char labels[4][96];
    static int next;
    char *out = labels[next++ & 3], quant[32];
    qwen_quant_display(v, quant, sizeof quant);
    snprintf(out, sizeof labels[0], "%s %s%s", qwen_family_label(v->family), quant,
             v->engine == QWEN_ENGINE_MLX ? " (MLX)" : "");
    return out;
}

/* ---------- loading and validation ---------- */

typedef struct { const char *json; dtg_json_token *t; int n; char *err; size_t errsz; } qwen_doc;

static int qwen_fail(qwen_doc *d, const char *fmt, const char *what) {
    snprintf(d->err, d->errsz, fmt, what ? what : "");
    return 0;
}

/* [A-Za-z0-9][A-Za-z0-9_.-]{0,max-1}; lower restricts letters to a-z. */
static int qwen_name_ok(const char *s, size_t max, int lower) {
    size_t n = s ? strlen(s) : 0;
    if (!n || n > max || !isalnum((unsigned char)s[0])) return 0;
    for (size_t i = 0; i < n; i++) {
        unsigned char c = (unsigned char)s[i];
        if (!(isalnum(c) || c == '_' || c == '.' || c == '-') || c > 127 || (lower && isupper(c))) return 0;
    }
    return 1;
}
static int qwen_hex_ok(const char *s, size_t n) {
    if (!s || strlen(s) != n) return 0;
    for (size_t i = 0; i < n; i++) if (!isdigit((unsigned char)s[i]) && (s[i] < 'a' || s[i] > 'f')) return 0;
    return 1;
}
/* <segment>[/<segment>]: one optional directory (unsloth's BF16/), no "..". */
static int qwen_pair_ok(const char *s, size_t first_max, size_t second_max, int optional_second) {
    const char *slash = s ? strchr(s, '/') : NULL;
    char head[112];
    if (!slash) return optional_second && qwen_name_ok(s, first_max, 0);
    if ((size_t)(slash - s) >= sizeof head) return 0;
    memcpy(head, s, (size_t)(slash - s)); head[slash - s] = '\0';
    return qwen_name_ok(head, first_max, 0) && qwen_name_ok(slash + 1, second_max, 0);
}

static int qwen_children(const qwen_doc *d, int parent, int *out, int cap) {
    int count = 0;
    for (int i = parent + 1; i < d->n && d->t[i].start < d->t[parent].end; i++) {
        if (d->t[i].parent != parent) continue;
        if (count >= cap) return -1;
        out[count++] = i;
    }
    return count;
}

/* The object has exactly the required keys plus any of the optional ones. */
static int qwen_keys(qwen_doc *d, int object, const char *const *required, const char *const *optional, const char *where) {
    if (object < 0 || d->t[object].type != DTG_JSON_OBJECT) return qwen_fail(d, "%s must be an object", where);
    int children[64], n = qwen_children(d, object, children, 64), seen = 0;
    if (n < 0) return qwen_fail(d, "%s has too many fields", where);
    for (int i = 0; i < n; i += 2) {
        int known = 0;
        for (int k = 0; required[k] && !known; k++) if (dtg_json_token_eq(d->json, &d->t[children[i]], required[k])) { known = 1; seen++; }
        for (int k = 0; optional && optional[k] && !known; k++) if (dtg_json_token_eq(d->json, &d->t[children[i]], optional[k])) known = 1;
        if (!known) return qwen_fail(d, "%s has an unexpected field", where);
    }
    int expected = 0;
    while (required[expected]) expected++;
    return seen == expected ? 1 : qwen_fail(d, "%s is missing a required field", where);
}

static int qwen_string(qwen_doc *d, int object, const char *key, char *out, size_t cap) {
    int at = dtg_json_object_field(d->json, d->t, d->n, object, key);
    if (at < 0 || d->t[at].type != DTG_JSON_STRING || !dtg_json_token_string(d->json, &d->t[at], out, cap))
        return qwen_fail(d, "invalid or too long string field '%s'", key);
    return 1;
}

static int qwen_bytes(qwen_doc *d, int object, long long *out) {
    int at = dtg_json_object_field(d->json, d->t, d->n, object, "bytes");
    if (at < 0 || !dtg_json_token_int(d->json, &d->t[at], 1, QWEN_FILE_BYTES_MAX * QWEN_MLX_FILES_MAX, out))
        return qwen_fail(d, "invalid byte count%s", "");
    return 1;
}

/* One {remote, file, bytes, sha256}. */
static int qwen_parse_file(qwen_doc *d, int object, qwen_file *out, const char *where) {
    static const char *const keys[] = {"remote", "file", "bytes", "sha256", NULL};
    char remote[208], sha[72];
    if (!qwen_keys(d, object, keys, NULL, where) || !qwen_string(d, object, "remote", remote, sizeof remote) ||
        !qwen_string(d, object, "file", out->name, sizeof out->name) ||
        !qwen_string(d, object, "sha256", sha, sizeof sha) || !qwen_bytes(d, object, &out->bytes)) return 0;
    if (!qwen_pair_ok(remote, 96, 96, 1) || !qwen_name_ok(out->name, 96, 0))
        return qwen_fail(d, "%s has an unsafe file path", where);
    if (out->bytes > QWEN_FILE_BYTES_MAX) return qwen_fail(d, "%s has a file above 1 TiB", where);
    if (!qwen_hex_ok(sha, 64)) return qwen_fail(d, "%s has an invalid SHA-256", where);
    if (model_file_is_modified_weights(out->name) || model_file_is_modified_weights(remote))
        return qwen_fail(d, "%s names modified weights", where);
    return 1;
}

static int qwen_family(qwen_doc *d, int object, int *family) {
    char text[16];
    if (!qwen_string(d, object, "family", text, sizeof text)) return 0;
    *family = !strcmp(text, "qwen36") ? QWEN_FAMILY_36 : !strcmp(text, "qwen27") ? QWEN_FAMILY_27 : 0;
    return *family ? 1 : qwen_fail(d, "unknown family '%s'", text);
}

static int qwen_pin(qwen_doc *d, int object, char *repository, size_t cap) {
    char revision[48];
    if (!qwen_string(d, object, "repository", repository, cap) || !qwen_string(d, object, "revision", revision, sizeof revision))
        return 0;
    if (!qwen_pair_ok(repository, 48, 64, 0) || model_file_is_modified_weights(repository))
        return qwen_fail(d, "invalid repository '%s'", repository);
    return qwen_hex_ok(revision, 40) ? 1 : qwen_fail(d, "revision is not a 40-hex commit%s", "");
}

static int qwen_split_name(const char *name, int *index, int *count, size_t *prefix) {
    size_t n = strlen(name);
    if (n < 21 || strcmp(name + n - 5, ".gguf")) return 0;
    const char *tail = name + n - 20; /* -NNNNN-of-NNNNN.gguf, llama.cpp's split naming */
    if (tail[0] != '-' || strncmp(tail + 6, "-of-", 4)) return 0;
    for (int i = 1; i < 6; i++) if (!isdigit((unsigned char)tail[i]) || !isdigit((unsigned char)tail[i + 9])) return 0;
    *index = atoi(tail + 1); *count = atoi(tail + 10); *prefix = n - 20;
    return 1;
}

typedef struct { char id[40], name[104]; int family; qwen_file file; } qwen_component;

static int qwen_parse_variant(qwen_doc *d, int object, const qwen_component *components, int ncomponents, qwen_variant *v) {
    static const char *const keys[] = {"id", "family", "engine", "quant", "repository", "revision", "path",
                                       "requires", "bytes", "files", NULL};
    char engine[16], repository[120], where[64] = "variant";
    if (!qwen_keys(d, object, keys, NULL, "variant") || !qwen_string(d, object, "id", v->id, sizeof v->id)) return 0;
    snprintf(where, sizeof where, "variant %s", v->id);
    if (strncmp(v->id, "qwen36-", 7) && strncmp(v->id, "qwen27-", 7)) return qwen_fail(d, "%s: invalid id", where);
    if (!qwen_name_ok(v->id + 7, 32, 1) || model_file_is_modified_weights(v->id)) return qwen_fail(d, "%s: invalid id", where);
    if (!qwen_family(d, object, &v->family) || !qwen_string(d, object, "engine", engine, sizeof engine) ||
        !qwen_string(d, object, "quant", v->quant, sizeof v->quant) || !qwen_pin(d, object, repository, sizeof repository) ||
        !qwen_string(d, object, "path", v->path, sizeof v->path) || !qwen_bytes(d, object, &v->bytes)) return 0;
    if (strncmp(v->id, v->family == QWEN_FAMILY_27 ? "qwen27-" : "qwen36-", 7)) return qwen_fail(d, "%s: id and family differ", where);
    v->engine = !strcmp(engine, "llama") ? QWEN_ENGINE_LLAMA : !strcmp(engine, "mlx") ? QWEN_ENGINE_MLX : 0;
    if (!v->engine) return qwen_fail(d, "%s: unknown engine", where);
    if (!qwen_name_ok(v->quant, 23, 0)) return qwen_fail(d, "%s: invalid quantization label", where);
    const char *prefix = qwen_family_prefix(v->family);
    int requires = dtg_json_object_field(d->json, d->t, d->n, object, "requires");
    int files = dtg_json_object_field(d->json, d->t, d->n, object, "files");
    int req[4], items[QWEN_MLX_FILES_MAX + 1];
    int nreq = requires >= 0 && d->t[requires].type == DTG_JSON_ARRAY ? qwen_children(d, requires, req, 4) : -1;
    int nfiles = files >= 0 && d->t[files].type == DTG_JSON_ARRAY ? qwen_children(d, files, items, QWEN_MLX_FILES_MAX + 1) : -1;
    if (nreq < 0 || nfiles < 1) return qwen_fail(d, "%s: invalid requires or files", where);
    long long total = 0;
    if (v->engine == QWEN_ENGINE_LLAMA) {
        if (nfiles > QWEN_GGUF_PARTS_MAX) return qwen_fail(d, "%s: too many GGUF parts", where);
        size_t first_prefix = 0;
        for (int i = 0; i < nfiles; i++) {
            qwen_file *f = &v->files[i];
            if (!qwen_parse_file(d, items[i], f, where)) return 0;
            size_t n = strlen(f->name);
            if (strncmp(f->name, prefix, strlen(prefix)) || n < 6 || strcmp(f->name + n - 5, ".gguf") ||
                strstr(f->name, "-mmproj-")) return qwen_fail(d, "%s: invalid GGUF name", where);
            if (nfiles > 1) {
                int index = 0, count = 0; size_t p = 0;
                if (!qwen_split_name(f->name, &index, &count, &p) || index != i + 1 || count != nfiles ||
                    (i && (p != first_prefix || strncmp(f->name, v->files[0].name, p))))
                    return qwen_fail(d, "%s: split parts must be <name>-%%05d-of-%%05d.gguf in order", where);
                if (!i) first_prefix = p;
            }
            total += f->bytes;
        }
        v->parts = nfiles;
        char expected[112];
        snprintf(expected, sizeof expected, "gguf/%s", v->files[0].name);
        if (strcmp(v->path, expected)) return qwen_fail(d, "%s: path must be gguf/<first file>", where);
        /* llama.cpp serves 27B with its F16 projector (readiness requires vision);
         * Qwen3.6 is text only. */
        if (nreq != (v->family == QWEN_FAMILY_27)) return qwen_fail(d, "%s: wrong component requirement", where);
        if (nreq) {
            char id[48]; const qwen_component *found = NULL;
            if (d->t[req[0]].type != DTG_JSON_STRING || !dtg_json_token_string(d->json, &d->t[req[0]], id, sizeof id))
                return qwen_fail(d, "%s: invalid requirement", where);
            for (int c = 0; c < ncomponents; c++) if (!strcmp(components[c].id, id)) found = &components[c];
            if (!found || found->family != v->family) return qwen_fail(d, "%s: unknown projector", where);
            v->files[v->parts] = found->file;
            v->projector = 1;
            total += found->file.bytes;
        }
    } else {
        if (nfiles > QWEN_MLX_FILES_MAX) return qwen_fail(d, "%s: too many files", where);
        if (nreq) return qwen_fail(d, "%s: MLX variants have no components", where);
        const char *folder = strchr(repository, '/') + 1;
        char expected[112];
        snprintf(expected, sizeof expected, "mlx/%s", folder);
        if (strcmp(v->path, expected) || strncmp(folder, prefix, strlen(prefix)))
            return qwen_fail(d, "%s: path must be mlx/<repository name>", where);
        int config = 0, index = 0, weights = 0;
        qwen_file names[QWEN_MLX_FILES_MAX];
        for (int i = 0; i < nfiles; i++) {
            if (!qwen_parse_file(d, items[i], &names[i], where)) return 0;
            for (int j = 0; j < i; j++) if (ascii_str_eq_ci(names[j].name, names[i].name)) return qwen_fail(d, "%s: duplicate file", where);
            config |= !strcmp(names[i].name, "config.json");
            index |= !strcmp(names[i].name, "model.safetensors.index.json");
            size_t n = strlen(names[i].name);
            weights |= n > 12 && !strcmp(names[i].name + n - 12, ".safetensors");
            total += names[i].bytes;
        }
        if (!config || !index || !weights) return qwen_fail(d, "%s: incomplete MLX folder", where);
    }
    return total == v->bytes ? 1 : qwen_fail(d, "%s: total bytes differ from its files", where);
}

/* Duplicate names across the catalog would make two variants share or race
 * for one file. Names compare case-insensitively: macOS volumes usually do. */
static int qwen_catalog_unique(qwen_doc *d, const qwen_catalog *c) {
    for (int i = 0; i < c->count; i++) {
        const qwen_variant *a = &c->variants[i];
        for (int j = 0; j < i; j++) {
            const qwen_variant *b = &c->variants[j];
            if (!strcmp(a->id, b->id)) return qwen_fail(d, "duplicate variant id %s", a->id);
            if (a->engine != b->engine) continue;
            if (a->engine == QWEN_ENGINE_MLX && ascii_str_eq_ci(a->path, b->path))
                return qwen_fail(d, "duplicate MLX folder %s", a->path);
            for (int x = 0; a->engine == QWEN_ENGINE_LLAMA && x < a->parts; x++)
                for (int y = 0; y < b->parts + b->projector; y++)
                    if (ascii_str_eq_ci(a->files[x].name, b->files[y].name)) return qwen_fail(d, "file %s belongs to two variants", a->files[x].name);
            for (int y = 0; a->engine == QWEN_ENGINE_LLAMA && y < b->parts; y++)
                if (a->projector && ascii_str_eq_ci(a->files[a->parts].name, b->files[y].name))
                    return qwen_fail(d, "file %s is both a model and a projector", b->files[y].name);
        }
    }
    return 1;
}

/* The original ids keep their exact files and sizes: existing installs,
 * settings and partial downloads depend on them. */
static int qwen_catalog_keeps_original_pins(qwen_doc *d, const qwen_catalog *c) {
    const qwen_catalog *compiled = qwen_compiled_catalog();
    for (int i = 0; i < compiled->count; i++) {
        const qwen_variant *want = &compiled->variants[i], *got = NULL;
        for (int j = 0; j < c->count; j++) if (!strcmp(c->variants[j].id, want->id)) got = &c->variants[j];
        int same = got && got->family == want->family && got->engine == want->engine && got->bytes == want->bytes &&
            !strcmp(got->path, want->path) && got->parts == want->parts && got->projector == want->projector;
        for (int f = 0; same && f < want->parts + want->projector; f++)
            same = !strcmp(got->files[f].name, want->files[f].name) && got->files[f].bytes == want->files[f].bytes;
        if (!same) return qwen_fail(d, "the original pin %s is missing or changed", want->id);
    }
    return 1;
}

static int qwen_catalog_parse(char *json, size_t len, qwen_catalog *c, char *err, size_t errsz) {
    dtg_json_token *tokens = malloc(QWEN_CATALOG_MAX_TOKENS * sizeof *tokens);
    qwen_doc d = {json, tokens, 0, err, errsz};
    qwen_component components[QWEN_COMPONENTS_MAX];
    int ok = 0, ncomponents = 0;
    if (!tokens) return qwen_fail(&d, "out of memory%s", "");
    if (!dtg_json_validate_complete(json, '{', err, errsz)) goto done;
    d.n = dtg_json_tokenize(json, len, tokens, QWEN_CATALOG_MAX_TOKENS);
    if (d.n <= 0) { qwen_fail(&d, "catalog is not a bounded JSON object%s", ""); goto done; }
    if (!dtg_json_unique_object_keys(json, tokens, d.n, err, errsz)) goto done;
    static const char *const top[] = {"schema", "version", "components", "variants", NULL};
    static const char *const extra[] = {"generator", "source", NULL};
    if (!qwen_keys(&d, 0, top, extra, "catalog")) goto done;
    char schema[48]; long long version = 0;
    int at = dtg_json_object_field(json, tokens, d.n, 0, "version");
    if (!qwen_string(&d, 0, "schema", schema, sizeof schema) || strcmp(schema, QWEN_CATALOG_SCHEMA) ||
        at < 0 || !dtg_json_token_int(json, &tokens[at], 1, 1, &version)) {
        qwen_fail(&d, "unsupported catalog schema or version%s", ""); goto done;
    }
    int list[QWEN_VARIANTS_MAX + 1];
    int section = dtg_json_object_field(json, tokens, d.n, 0, "components");
    int n = section >= 0 && tokens[section].type == DTG_JSON_ARRAY ? qwen_children(&d, section, list, QWEN_COMPONENTS_MAX) : -1;
    if (n < 0) { qwen_fail(&d, "invalid components%s", ""); goto done; }
    for (int i = 0; i < n; i++, ncomponents++) {
        static const char *const keys[] = {"id", "role", "family", "repository", "revision", "files", NULL};
        qwen_component *component = &components[i];
        char role[16], repository[120]; int files[2];
        if (!qwen_keys(&d, list[i], keys, NULL, "component") || !qwen_string(&d, list[i], "id", component->id, sizeof component->id) ||
            !qwen_string(&d, list[i], "role", role, sizeof role) || !qwen_family(&d, list[i], &component->family) ||
            !qwen_pin(&d, list[i], repository, sizeof repository)) goto done;
        int array = dtg_json_object_field(json, tokens, d.n, list[i], "files");
        if (!qwen_name_ok(component->id, 40, 1) || strcmp(role, "projector") || array < 0 ||
            tokens[array].type != DTG_JSON_ARRAY || qwen_children(&d, array, files, 2) != 1 ||
            !qwen_parse_file(&d, files[0], &component->file, component->id)) {
            if (!err[0]) qwen_fail(&d, "invalid component %s", component->id);
            goto done;
        }
        char prefix[48]; snprintf(prefix, sizeof prefix, "%smmproj-", qwen_family_prefix(component->family));
        size_t len_name = strlen(component->file.name);
        if (strncmp(component->file.name, prefix, strlen(prefix)) || len_name < 6 ||
            strcmp(component->file.name + len_name - 5, ".gguf")) { qwen_fail(&d, "invalid projector name in %s", component->id); goto done; }
        for (int j = 0; j < i; j++) if (!strcmp(components[j].id, component->id)) { qwen_fail(&d, "duplicate component %s", component->id); goto done; }
    }
    section = dtg_json_object_field(json, tokens, d.n, 0, "variants");
    n = section >= 0 && tokens[section].type == DTG_JSON_ARRAY ? qwen_children(&d, section, list, QWEN_VARIANTS_MAX) : -1;
    if (n < 1) { qwen_fail(&d, "variants must be a list of 1..96 entries%s", ""); goto done; }
    for (int i = 0; i < n; i++) {
        memset(&c->variants[i], 0, sizeof c->variants[i]);
        if (!qwen_parse_variant(&d, list[i], components, ncomponents, &c->variants[i])) goto done;
        c->count = i + 1;
    }
    ok = qwen_catalog_unique(&d, c) && qwen_catalog_keeps_original_pins(&d, c);
done:
    free(tokens);
    return ok;
}

/* Parse a candidate completely, then publish it; on failure publish the
 * compiled pins. Bounded: one read of at most 512 KiB. */
static int qwen_catalog_load_file(const char *path) {
    char err[256] = "";
    qwen_catalog *candidate = calloc(1, sizeof *candidate);
    char *json = NULL;
    size_t len = 0;
    FILE *f = path && candidate ? fopen(path, "rb") : NULL;
    struct stat st;
    if (!candidate) snprintf(err, sizeof err, "out of memory");
    else if (!f) snprintf(err, sizeof err, "%s: %s", path ? path : "(no path)", strerror(errno));
    else if (fstat(fileno(f), &st) != 0 || !S_ISREG(st.st_mode) || st.st_size <= 0 || st.st_size > QWEN_CATALOG_MAX_BYTES)
        snprintf(err, sizeof err, "%s is not a regular file of at most 512 KiB", path);
    else if (!(json = malloc((size_t)st.st_size + 1)) || (len = fread(json, 1, (size_t)st.st_size + 1, f)) != (size_t)st.st_size)
        snprintf(err, sizeof err, "could not read %s", path);
    else {
        json[len] = '\0';
        if (memchr(json, '\0', len)) snprintf(err, sizeof err, "the catalog contains a NUL byte");
        else if (qwen_catalog_parse(json, len, candidate, err, sizeof err)) {
            candidate->document = json; candidate->document_len = len; json = NULL;
        } else if (!err[0]) snprintf(err, sizeof err, "invalid catalog");
    }
    if (f) fclose(f);
    free(json);
    if (candidate && candidate->document) {
        if (g_qwen_catalog) free(g_qwen_catalog->document);
        free(g_qwen_catalog);
        g_qwen_catalog = candidate;
        g_qwen_catalog_error[0] = '\0';
        return 1;
    }
    free(candidate);
    if (g_qwen_catalog) free(g_qwen_catalog->document);
    free(g_qwen_catalog);
    g_qwen_catalog = NULL;
    snprintf(g_qwen_catalog_error, sizeof g_qwen_catalog_error, "%s", err);
    fprintf(stderr, "qwen variants: %s; only the original pins are available\n", err);
    return 0;
}

static void qwen_catalog_path(char *out, size_t cap) {
    snprintf(out, cap, "%s%s%s", g_web_dir, g_web_dir[0] ? "/" : "", QWEN_CATALOG_REL);
}

static int qwen_catalog_reload(void) {
    char path[DSTUDIO_PATH_MAX + 64];
    qwen_catalog_path(path, sizeof path);
    return qwen_catalog_load_file(path);
}

/* GET /api/model/qwen-variants: the validated document exactly as shipped,
 * or the original pins in the same schema when it could not be loaded. */
static void api_qwen_variants(int fd) {
    const qwen_catalog *c = qwen_catalog_current();
    if (c->document) { send_json(fd, "200 OK", c->document); return; }
    json_dyn_buf b = {0};
    int ok = json_dyn_puts(&b, "{\"schema\":\"" QWEN_CATALOG_SCHEMA "\",\"version\":1,\"fallback\":true,\"error\":") &&
             json_dyn_put_escaped(&b, g_qwen_catalog_error) && json_dyn_puts(&b, ",\"components\":[");
    const qwen_variant *q27 = qwen_variant_by_id("qwen27-q6");
    ok = ok && json_dyn_puts(&b, "{\"id\":\"qwen27-mmproj-f16\",\"role\":\"projector\",\"family\":\"qwen27\",\"files\":[{\"file\":") &&
         json_dyn_put_escaped(&b, q27->files[1].name) && json_dyn_printf(&b, ",\"bytes\":%lld}]}],\"variants\":[", q27->files[1].bytes);
    for (int i = 0; ok && i < c->count; i++) {
        const qwen_variant *v = &c->variants[i];
        ok = json_dyn_puts(&b, i ? ",{\"id\":" : "{\"id\":") && json_dyn_put_escaped(&b, v->id) &&
             json_dyn_printf(&b, ",\"family\":\"%s\",\"engine\":\"%s\",\"quant\":", v->family == QWEN_FAMILY_27 ? "qwen27" : "qwen36",
                             v->engine == QWEN_ENGINE_MLX ? "mlx" : "llama") &&
             json_dyn_put_escaped(&b, v->quant) && json_dyn_puts(&b, ",\"path\":") && json_dyn_put_escaped(&b, v->path) &&
             json_dyn_printf(&b, ",\"bytes\":%lld,\"requires\":[%s],\"files\":[", v->bytes, v->projector ? "\"qwen27-mmproj-f16\"" : "");
        for (int f = 0; ok && f < v->parts; f++)
            ok = json_dyn_puts(&b, f ? ",{\"file\":" : "{\"file\":") && json_dyn_put_escaped(&b, v->files[f].name) &&
                 json_dyn_printf(&b, ",\"bytes\":%lld}", v->files[f].bytes);
        ok = ok && json_dyn_puts(&b, "]}");
    }
    ok = ok && json_dyn_puts(&b, "]}");
    if (ok) send_json(fd, "200 OK", b.ptr);
    else send_json(fd, "500 Internal Server Error", "{\"ok\":false,\"error\":\"could not describe the Qwen variants\"}");
    free(b.ptr);
}

/* ---------- download progress (byte counts only, never verification) ---------- */

static long long qwen_regular_size(const char *path) {
    struct stat st;
    return lstat(path, &st) == 0 && S_ISREG(st.st_mode) ? (long long)st.st_size : 0;
}

/* Byte progress for an MLX folder: at most 64 published names plus at most
 * 64 private per-file stages, never file contents. */
static long long qwen_mlx_download_bytes(const char *checkout, const qwen_variant *v, int *has_partial) {
    char folder[DSTUDIO_PATH_MAX + 128], stages[DSTUDIO_PATH_MAX + 160];
    long long total = 0;
    if (has_partial) *has_partial = 0;
    snprintf(folder, sizeof folder, "%s/%s", checkout, v->path);
    snprintf(stages, sizeof stages, "%s/" QWEN_STAGE_DIR, folder);
    const char *dirs[] = {folder, stages};
    for (int pass = 0; pass < 2; pass++) {
        DIR *dir = opendir(dirs[pass]);
        if (!dir) continue;
        struct dirent *de; int seen = 0;
        while ((de = readdir(dir)) && seen++ < 64) {
            if (de->d_name[0] == '.') continue;
            char path[DSTUDIO_PATH_MAX + 512];
            snprintf(path, sizeof path, pass ? "%s/%s/data.part" : "%s/%s", dirs[pass], de->d_name);
            long long size = qwen_regular_size(path);
            total += size;
            if (pass && size > 0 && has_partial) *has_partial = 1;
        }
        closedir(dir);
    }
    return total < v->bytes ? total : v->bytes;
}

/* GGUF parts and projector: the larger of the published file and its stage,
 * capped at the pinned size. A full stage is not a verified file. */
static long long qwen_download_bytes(const char *checkout, const qwen_variant *v, int *has_partial) {
    if (v->engine == QWEN_ENGINE_MLX) return qwen_mlx_download_bytes(checkout, v, has_partial);
    long long total = 0;
    if (has_partial) *has_partial = 0;
    for (int i = 0; i < v->parts + v->projector; i++) {
        char path[DSTUDIO_PATH_MAX + 256];
        snprintf(path, sizeof path, "%s/gguf/%s", checkout, v->files[i].name);
        long long complete = qwen_regular_size(path);
        snprintf(path, sizeof path, "%s/gguf/" QWEN_STAGE_DIR "/%s/data.part", checkout, v->files[i].name);
        long long part = qwen_regular_size(path);
        if (part > 0 && has_partial) *has_partial = 1;
        long long have = complete > part ? complete : part;
        total += have < v->files[i].bytes ? have : v->files[i].bytes;
    }
    return total;
}

static int qwen_parts_published(const char *checkout, const qwen_variant *v) {
    for (int i = 0; i < v->parts; i++) {
        char path[DSTUDIO_PATH_MAX + 256];
        snprintf(path, sizeof path, "%s/gguf/%s", checkout, v->files[i].name);
        if (qwen_regular_size(path) != v->files[i].bytes) return 0;
    }
    return 1;
}

/* A paused staged download after Stop, a failure or an app restart. Work is
 * bounded by what is on disk (one gguf stage listing, one mlx/ listing, 64
 * names each), not by the catalog size. The variant of the last download in
 * this session is preferred; a projector-only stage belongs to a 27B variant
 * whose model parts are already published, else to qwen27-q6 as before. */
static const qwen_variant *qwen_paused_download(const char *checkout, const char *last, long long *bytes) {
    const qwen_catalog *c = qwen_catalog_current();
    const qwen_variant *v = qwen_variant_by_id(last);
    int partial = 0;
    if (v) {
        long long have = qwen_download_bytes(checkout, v, &partial);
        if (partial) { *bytes = have; return v; }
    }
    char dir_path[DSTUDIO_PATH_MAX + 64];
    snprintf(dir_path, sizeof dir_path, "%s/gguf/" QWEN_STAGE_DIR, checkout);
    DIR *dir = opendir(dir_path);
    const qwen_variant *found = NULL;
    int projector_only = 0, seen = 0;
    struct dirent *de;
    while (dir && !found && (de = readdir(dir)) && seen++ < 64) {
        if (de->d_name[0] == '.') continue;
        char part[DSTUDIO_PATH_MAX + 400];
        snprintf(part, sizeof part, "%s/%s/data.part", dir_path, de->d_name);
        if (qwen_regular_size(part) <= 0) continue;
        for (int i = 0; i < c->count && !found; i++) {
            const qwen_variant *candidate = &c->variants[i];
            if (candidate->engine != QWEN_ENGINE_LLAMA) continue;
            for (int f = 0; f < candidate->parts && !found; f++)
                if (!strcmp(candidate->files[f].name, de->d_name)) found = candidate;
            if (candidate->projector && !strcmp(candidate->files[candidate->parts].name, de->d_name)) projector_only = 1;
        }
    }
    if (dir) closedir(dir);
    if (!found && projector_only) {
        for (int i = 0; i < c->count && !found; i++)
            if (c->variants[i].projector && qwen_parts_published(checkout, &c->variants[i])) found = &c->variants[i];
        if (!found) found = qwen_variant_by_id("qwen27-q6");
    }
    snprintf(dir_path, sizeof dir_path, "%s/mlx", checkout);
    dir = found ? NULL : opendir(dir_path);
    seen = 0;
    while (dir && !found && (de = readdir(dir)) && seen++ < 64) {
        char rel[DSTUDIO_PATH_MAX];
        snprintf(rel, sizeof rel, "mlx/%s", de->d_name);
        const qwen_variant *candidate = de->d_name[0] == '.' ? NULL : qwen_variant_for_rel(rel);
        if (!candidate) continue;
        (void)qwen_mlx_download_bytes(checkout, candidate, &partial);
        if (partial) found = candidate;
    }
    if (dir) closedir(dir);
    if (found) *bytes = qwen_download_bytes(checkout, found, &partial);
    return found;
}

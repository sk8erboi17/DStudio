/* Disk snapshots of the owned llama-server slot: one per saved Agent, Cowork
 * or Design session, so that a session restored after an engine restart can
 * reuse its KV state instead of having its transcript prefilled again. Only
 * the server's existing options and endpoints are used (--slot-save-path,
 * POST /slots/0?action=save|restore). llama.cpp only: MLX and the ds4 engines
 * never reach this code, and Chat through /v1 has no session identity here.
 * NOT VERIFIED ON REAL WEIGHTS, and therefore OFF by default: unless
 * DSTUDIO_LLAMA_KV_SNAPSHOTS=1, llama-server gets no slot directory and
 * nothing is saved or restored (a conversation deletion or history wipe still
 * removes snapshots an earlier opt-in left). NOT TESTED on Linux; disabled on
 * Windows.
 *
 * Cache contract
 *   Owner      The HTTP owner loop owns every decision and publication. One
 *              worker thread at a time runs one filesystem operation on a
 *              private candidate; it reads no host global and writes to no
 *              client. The model server owns the snapshot bytes it writes.
 *   Location   <KV root>/llama-slots (kv_root(): DSTUDIO_KV_DIR or the
 *              profile default), mode 0700, a flat directory: the server
 *              accepts plain file names only. Every access is by a validated
 *              name relative to that directory's descriptor.
 *   Identity   <m>-<session8>-<key16>.slot plus a .json sidecar. m is the
 *              runtime (a|c|d), session8 the id the runtime announces, key16
 *              the first 16 hex digits of the SHA-256 of: the installer
 *              receipt's buildId, commit and binarySHA256, the build_info
 *              /props reported, the model file identity (device, inode, size,
 *              mtime, ctime), the projector identity when present, the
 *              context size, the served alias, the SHA-256 of the actual
 *              server arguments (port and slot directory excluded), runtime
 *              and session. The sidecar repeats the full digest, the size of
 *              the slot file and the number of transcript messages.
 *   Admission  A restore needs: this exact digest, a slot file whose size is
 *              the sidecar's, and the message count the runtime restored.
 *              Anything else is a miss.
 *   Miss path  No restore request: the server prefills the transcript, as
 *              before this cache existed. A hit only loads state the server
 *              itself validates against the prompt (common token prefix), so
 *              generated results do not depend on the cache.
 *   Lifetime   Written after a completed turn whose transcript the runtime
 *              announced as saved; replaced by the next one of that session.
 *   Invalidation  Another key for the same session, a damaged or mismatched
 *              sidecar, a size or message-count mismatch, or a restore the
 *              server refuses: the files are removed. Deleting the session
 *              removes its snapshot; wiping the history removes all of them.
 *   Limits     DSTUDIO_LLAMA_KV_SNAPSHOTS=1 enables the cache (default off);
 *              DSTUDIO_LLAMA_KV_MAX_BYTES (default 32 GiB; 0 disables it), DSTUDIO_LLAMA_KV_MAX_ENTRIES (default 64),
 *              DSTUDIO_LLAMA_KV_MIN_FREE_BYTES (default 8 GiB, plus the size
 *              of the snapshot being replaced): no write below that margin.
 *              Sizes are those of the files actually written. One exchange
 *              with the server at a time, one queued save and one queued
 *              restore (the newest wins), 32 queued deletions, 4096 directory
 *              entries per scan, 64 KiB per reply.
 *   Eviction   Least recently saved or restored first (a counter kept in the
 *              sidecar), by the worker, after a successful write; a snapshot
 *              larger than the whole cap is not kept.
 *   Cancellation  A save is not sent while a turn runs, and one overtaken by
 *              a new turn, a deletion, a wipe or an engine change is discarded,
 *              never published. Stop and engine death end an exchange; no
 *              elapsed-time cutoff applies once a request was sent.
 *   Failure    Every failure is a reported miss; the turn is never failed,
 *              and a turn only waits for the restore of its own session.
 *   Not authoritative  The runtime's saved transcript is the session. Status
 *              numbers are a view from the last worker pass. */

#define KVS_DIR_NAME "llama-slots"
#define KVS_FORMAT "dstudio.llama-slot.v1"
#define KVS_KEY_FORMAT "dstudio.llama-slot-key.v1"
#define KVS_RECEIPT ".dstudio-llama.json" /* scripts/install-llama.py RECEIPT */
#define KVS_RECEIPT_SCHEMA "dstudio.llama-install.v1"
#define KVS_DEFAULT_MAX_BYTES (32LL * 1024 * 1024 * 1024)
#define KVS_DEFAULT_MAX_ENTRIES 64
#define KVS_DEFAULT_MIN_FREE (8LL * 1024 * 1024 * 1024)
#define KVS_SCAN_MAX 4096
#define KVS_SIDECAR_MAX 4096
#define KVS_RECEIPT_MAX (64 * 1024)
#define KVS_RESPONSE_MAX (64 * 1024)
#define KVS_DELETE_MAX 32
#define KVS_CONNECT_MS 5000
#define KVS_NAME_MAX 40

static void lan_sha256_hex(const void *data, size_t n, char out[65]); /* dstudio_lan_cowork.c */

/* ==================== pure logic (no host state, no I/O) ==================== */

static int kvs_hex_ok(const char *text, size_t count) {
    for (size_t i = 0; i < count; i++)
        if (!((text[i] >= '0' && text[i] <= '9') || (text[i] >= 'a' && text[i] <= 'f'))) return 0;
    return 1;
}

/* The id every runtime announces: eight lowercase hex digits. A longer id
 * (the UI may hold all forty) is the same session; anything else is refused. */
static int kvs_session_canonical(const char *in, char out[9]) {
    size_t n = in ? strlen(in) : 0;
    if (n < 8 || n > 40) return 0;
    char lower[41];
    for (size_t i = 0; i < n; i++) lower[i] = (in[i] >= 'A' && in[i] <= 'F') ? (char)(in[i] - 'A' + 'a') : in[i];
    if (!kvs_hex_ok(lower, n)) return 0;
    memcpy(out, lower, 8); out[8] = '\0';
    return 1;
}

static char kvs_mode_letter(int mode) {
    return mode == ENGINE_AGENT ? 'a' : mode == ENGINE_COWORK ? 'c' : mode == ENGINE_DESIGN ? 'd' : '\0';
}
static const char *kvs_mode_name(char letter) {
    return letter == 'a' ? "agent" : letter == 'c' ? "cowork" : letter == 'd' ? "design" : "";
}

/* suffix: ".slot" (snapshot), ".json" (sidecar), ".part" (being written by the
 * server), ".jtmp" (sidecar being written). digest: at least 16 hex digits. */
static int kvs_suffix_ok(const char *suffix) {
    return !strcmp(suffix, ".slot") || !strcmp(suffix, ".json") || !strcmp(suffix, ".part") || !strcmp(suffix, ".jtmp");
}
static int kvs_name_build(char *out, size_t cap, char mode, const char *session, const char *digest, const char *suffix) {
    if (!kvs_mode_name(mode)[0] || !session || strlen(session) != 8 || !kvs_hex_ok(session, 8) ||
        !digest || strlen(digest) < 16 || !kvs_hex_ok(digest, 16) || !suffix || !kvs_suffix_ok(suffix)) return 0;
    int n = snprintf(out, cap, "%c-%s-%.16s%s", mode, session, digest, suffix);
    return n > 0 && (size_t)n < cap;
}
/* Only names this module wrote are ever opened, counted or removed. */
static int kvs_name_parse(const char *name, char *mode, char session[9], char digest[17], const char **suffix) {
    if (!name || strlen(name) != 32 || !kvs_mode_name(name[0])[0] || name[1] != '-' || !kvs_hex_ok(name + 2, 8) ||
        name[10] != '-' || !kvs_hex_ok(name + 11, 16) || !kvs_suffix_ok(name + 27)) return 0;
    *mode = name[0];
    memcpy(session, name + 2, 8); session[8] = '\0';
    memcpy(digest, name + 11, 16); digest[16] = '\0';
    *suffix = name + 27;
    return 1;
}

/* What a runtime prints once its own durable step is done. Exact forms only.
 * Design (src/harness/design/ds4_design.c): control markers on stderr, the
 * stream of +DWARFSTAR_WAITING, which model text never reaches.
 * Agent/Cowork (patch/ds4-agent-jsonl/remote-agent.cfrag): status lines on
 * stdout, the stream model text is printed on. A model that prints such a line
 * exactly, at the start of a line, is read like the runtime; the runtime's own
 * line follows it and replaces it, and whatever a wrong id costs is a cache
 * entry (admission and the server's own token comparison still apply). */
enum { KVS_LINE_NONE = 0, KVS_LINE_SAVED, KVS_LINE_RESTORED, KVS_LINE_DELETED };

static int kvs_take_session(const char **p, char session[9]) {
    if (strlen(*p) < 8 || !kvs_hex_ok(*p, 8)) return 0;
    memcpy(session, *p, 8); session[8] = '\0'; *p += 8;
    return 1;
}
static int kvs_take_count(const char **p, long long *out) {
    const char *start = *p; long long value = 0;
    while (**p >= '0' && **p <= '9' && *p - start < 9) value = value * 10 + (*(*p)++ - '0');
    if (*p == start || (**p >= '0' && **p <= '9')) return 0;
    *out = value;
    return 1;
}
static int kvs_take_text(const char **p, const char *text) {
    size_t n = strlen(text);
    if (strncmp(*p, text, n)) return 0;
    *p += n;
    return 1;
}

static int kvs_parse_line(const char *line, int design, char session[9], long long *messages) {
    const char *p = line;
    *messages = -1; session[0] = '\0';
    if (design) {
        if (kvs_take_text(&p, "+DSTUDIO_SESSION_SAVED "))
            return kvs_take_session(&p, session) && kvs_take_text(&p, " ") && kvs_take_count(&p, messages) && !*p ? KVS_LINE_SAVED : KVS_LINE_NONE;
        if (kvs_take_text(&p, "+DSTUDIO_SESSION_RESTORED "))
            return kvs_take_session(&p, session) && kvs_take_text(&p, " ") && kvs_take_count(&p, messages) && !*p ? KVS_LINE_RESTORED : KVS_LINE_NONE;
        if (kvs_take_text(&p, "+DSTUDIO_SESSION_DELETED "))
            return kvs_take_session(&p, session) && !*p ? KVS_LINE_DELETED : KVS_LINE_NONE;
        return KVS_LINE_NONE;
    }
    if (kvs_take_text(&p, "saved session "))
        return kvs_take_session(&p, session) && kvs_take_text(&p, " (") && kvs_take_count(&p, messages) &&
               !strcmp(p, " messages)") ? KVS_LINE_SAVED : KVS_LINE_NONE;
    if (kvs_take_text(&p, "switched to session "))
        return kvs_take_session(&p, session) && kvs_take_text(&p, " (") && kvs_take_count(&p, messages) &&
               kvs_take_text(&p, " messages restored") && (*p == ';' || *p == ')') ? KVS_LINE_RESTORED : KVS_LINE_NONE;
    if (kvs_take_text(&p, "deleted session "))
        return kvs_take_session(&p, session) && !*p ? KVS_LINE_DELETED : KVS_LINE_NONE;
    return KVS_LINE_NONE;
}

/* Everything a snapshot's validity depends on, copied from the launch that
 * the server confirmed and from the installer's receipt. */
typedef struct {
    char build_info[32], build_id[65], commit[41], binary_sha256[65];
    char model_identity[192], vision_identity[192], args_identity[65], model_id[48];
    int ctx;
} kvs_key_inputs;

static int kvs_key_field_ok(const char *text) {
    if (!text[0]) return 0;
    for (const char *p = text; *p; p++) if ((unsigned char)*p < 0x20) return 0;
    return 1;
}

static int kvs_key_digest(const kvs_key_inputs *k, char mode, const char *session, char out[65]) {
    char text[1536];
    if (!kvs_mode_name(mode)[0] || !session || strlen(session) != 8 || !kvs_hex_ok(session, 8) || k->ctx <= 0 ||
        !kvs_key_field_ok(k->build_info) || strlen(k->build_id) != 64 || !kvs_hex_ok(k->build_id, 64) ||
        strlen(k->commit) != 40 || !kvs_hex_ok(k->commit, 40) ||
        strlen(k->binary_sha256) != 64 || !kvs_hex_ok(k->binary_sha256, 64) ||
        !kvs_key_field_ok(k->model_identity) || !strcmp(k->model_identity, "missing") ||
        (k->vision_identity[0] && (!kvs_key_field_ok(k->vision_identity) || !strcmp(k->vision_identity, "missing"))) ||
        strlen(k->args_identity) != 64 || !kvs_hex_ok(k->args_identity, 64) || !kvs_key_field_ok(k->model_id)) return 0;
    int n = snprintf(text, sizeof text,
        KVS_KEY_FORMAT "\nengine=llama.cpp\nbuildInfo=%s\nbuildId=%s\ncommit=%s\nbinarySHA256=%s\n"
        "model=%s\nprojector=%s\nctx=%d\nalias=%s\nargs=%s\nmode=%c\nsession=%s\n",
        k->build_info, k->build_id, k->commit, k->binary_sha256, k->model_identity,
        k->vision_identity[0] ? k->vision_identity : "-", k->ctx, k->model_id, k->args_identity, mode, session);
    if (n <= 0 || (size_t)n >= sizeof text) return 0;
    lan_sha256_hex(text, (size_t)n, out);
    return 1;
}

/* The server arguments that shape the state or the prompt: all of them except
 * where it listens and where it writes snapshots. args ends with NULL. */
static void kvs_args_identity(char **args, char out[65]) {
    json_dyn_buf joined = {0};
    for (int i = 0; args[i]; i++) {
        if ((!strcmp(args[i], "--port") || !strcmp(args[i], "--slot-save-path") || !strcmp(args[i], "--host")) && args[i + 1]) { i++; continue; }
        json_dyn_puts(&joined, args[i]);
        json_dyn_putn(&joined, "\x1f", 1);
    }
    lan_sha256_hex(joined.ptr ? joined.ptr : "", joined.len, out);
    free(joined.ptr);
}

/* Explicit fields, never a struct image. seq orders use: larger is newer. */
typedef struct {
    char mode, session[9], digest[65];
    long long tokens, bytes, messages, seq, saved_ms;
} kvs_sidecar;

static int kvs_sidecar_encode(const kvs_sidecar *s, char *out, size_t cap) {
    if (!kvs_mode_name(s->mode)[0] || strlen(s->session) != 8 || !kvs_hex_ok(s->session, 8) ||
        strlen(s->digest) != 64 || !kvs_hex_ok(s->digest, 64) ||
        s->tokens < 0 || s->bytes <= 0 || s->messages < 0 || s->seq < 0) return 0;
    int n = snprintf(out, cap,
        "{\"format\":\"" KVS_FORMAT "\",\"mode\":\"%s\",\"session\":\"%s\",\"keyDigest\":\"%s\","
        "\"tokens\":%lld,\"bytes\":%lld,\"messages\":%lld,\"seq\":%lld,\"savedAtMs\":%lld}\n",
        kvs_mode_name(s->mode), s->session, s->digest, s->tokens, s->bytes, s->messages, s->seq, s->saved_ms);
    return n > 0 && (size_t)n < cap;
}

static int kvs_sidecar_parse(const char *json, size_t len, kvs_sidecar *out) {
    char error[96], text[80];
    dtg_json_token tokens[40];
    memset(out, 0, sizeof *out);
    if (len > KVS_SIDECAR_MAX || strlen(json) != len || !dtg_json_validate_complete(json, '{', error, sizeof error)) return 0;
    int count = dtg_json_tokenize(json, len, tokens, 40);
    if (count <= 0 || tokens[0].type != DTG_JSON_OBJECT ||
        !dtg_json_unique_object_keys(json, tokens, count, error, sizeof error)) return 0;
    int at = dtg_json_object_field(json, tokens, count, 0, "format");
    if (at < 0 || !dtg_json_token_eq(json, &tokens[at], KVS_FORMAT)) return 0;
    at = dtg_json_object_field(json, tokens, count, 0, "mode");
    if (at < 0 || !dtg_json_token_string(json, &tokens[at], text, sizeof text)) return 0;
    out->mode = !strcmp(text, "agent") ? 'a' : !strcmp(text, "cowork") ? 'c' : !strcmp(text, "design") ? 'd' : '\0';
    if (!out->mode) return 0;
    at = dtg_json_object_field(json, tokens, count, 0, "session");
    if (at < 0 || !dtg_json_token_string(json, &tokens[at], text, sizeof text) || strlen(text) != 8 || !kvs_hex_ok(text, 8)) return 0;
    memcpy(out->session, text, 9);
    at = dtg_json_object_field(json, tokens, count, 0, "keyDigest");
    if (at < 0 || !dtg_json_token_string(json, &tokens[at], text, sizeof text) || strlen(text) != 64 || !kvs_hex_ok(text, 64)) return 0;
    memcpy(out->digest, text, 65);
    struct { const char *name; long long lo; long long *value; } numbers[] = {
        {"tokens", 0, &out->tokens}, {"bytes", 1, &out->bytes}, {"messages", 0, &out->messages},
        {"seq", 0, &out->seq}, {"savedAtMs", 0, &out->saved_ms}};
    for (size_t i = 0; i < sizeof numbers / sizeof numbers[0]; i++) {
        at = dtg_json_object_field(json, tokens, count, 0, numbers[i].name);
        if (at < 0 || !dtg_json_token_int(json, &tokens[at], numbers[i].lo, LLONG_MAX, numbers[i].value)) return 0;
    }
    return 1;
}

enum { KVS_ADMIT_OK = 0, KVS_ADMIT_DAMAGED, KVS_ADMIT_KEY, KVS_ADMIT_SIZE, KVS_ADMIT_MESSAGES };

/* sidecar NULL: missing or unreadable. messages < 0: the runtime gave none. */
static int kvs_admit(const kvs_sidecar *sidecar, char mode, const char *session, const char *digest,
                     long long file_bytes, long long messages) {
    if (!sidecar || sidecar->mode != mode || strcmp(sidecar->session, session)) return KVS_ADMIT_DAMAGED;
    if (strcmp(sidecar->digest, digest)) return KVS_ADMIT_KEY;
    if (sidecar->bytes != file_bytes) return KVS_ADMIT_SIZE;
    if (messages >= 0 && sidecar->messages != messages) return KVS_ADMIT_MESSAGES;
    return KVS_ADMIT_OK;
}

static const char *kvs_admit_reason(int verdict) {
    return verdict == KVS_ADMIT_KEY ? "the model, engine build, context or launch arguments changed since it was saved"
         : verdict == KVS_ADMIT_SIZE ? "its file does not have the recorded size"
         : verdict == KVS_ADMIT_MESSAGES ? "it was saved for another state of this conversation"
         : "its record is missing or damaged";
}

typedef struct {
    char name[KVS_NAME_MAX]; /* the .slot file */
    long long bytes, seq;
    int keep, evict;
} kvs_entry;

/* Marks the least recently used entries until both limits hold. keep entries
 * are never chosen. 0: the kept entries alone exceed a limit. */
static int kvs_plan_eviction(kvs_entry *entries, int count, long long max_bytes, int max_entries) {
    long long bytes = 0; int live = 0;
    for (int i = 0; i < count; i++) { entries[i].evict = 0; bytes += entries[i].bytes; live++; }
    while (bytes > max_bytes || live > max_entries) {
        int oldest = -1;
        for (int i = 0; i < count; i++) {
            if (entries[i].keep || entries[i].evict) continue;
            if (oldest < 0 || entries[i].seq < entries[oldest].seq ||
                (entries[i].seq == entries[oldest].seq && strcmp(entries[i].name, entries[oldest].name) < 0)) oldest = i;
        }
        if (oldest < 0) return 0;
        entries[oldest].evict = 1; bytes -= entries[oldest].bytes; live--;
    }
    return 1;
}

/* A write needs the margin plus room for the snapshot it replaces: both
 * copies exist until the new one is published. */
static int kvs_space_ok(long long free_bytes, long long min_free, long long replaced_bytes) {
    if (free_bytes < 0 || min_free < 0 || replaced_bytes < 0) return 0;
    return free_bytes >= min_free && free_bytes - min_free >= replaced_bytes;
}

static long long kvs_env_bytes(const char *name, long long fallback) {
    const char *text = getenv(name);
    if (!text || !text[0]) return fallback;
    char *end = NULL; errno = 0;
    long long value = strtoll(text, &end, 10);
    return errno || !end || *end || value < 0 ? fallback : value;
}

typedef struct { long long max_bytes, min_free; int max_entries, enabled; } kvs_limits;

/* Off unless DSTUDIO_LLAMA_KV_SNAPSHOTS is exactly "1": restoring a real
 * model's slot (Qwen's hybrid recurrent layers in particular) is not yet
 * verified, so no user gets it by default. */
static kvs_limits kvs_limits_now(void) {
    kvs_limits limits;
    const char *opt_in = getenv("DSTUDIO_LLAMA_KV_SNAPSHOTS");
    limits.enabled = opt_in && !strcmp(opt_in, "1");
    limits.max_bytes = kvs_env_bytes("DSTUDIO_LLAMA_KV_MAX_BYTES", KVS_DEFAULT_MAX_BYTES);
    limits.min_free = kvs_env_bytes("DSTUDIO_LLAMA_KV_MIN_FREE_BYTES", KVS_DEFAULT_MIN_FREE);
    long long entries = kvs_env_bytes("DSTUDIO_LLAMA_KV_MAX_ENTRIES", KVS_DEFAULT_MAX_ENTRIES);
    limits.max_entries = entries < 1 ? 1 : entries > 1024 ? 1024 : (int)entries;
    return limits;
}

/* The reply of POST /slots/0?action=save|restore: a complete HTTP response.
 * 1: accepted, with the server's token and byte counts; 0: the server refused
 * (its message in error); -1: not a reply this host can read. */
static int kvs_reply_parse(char *response, int save, const char *filename,
                           long long *tokens, long long *bytes, char *error, size_t cap) {
    char *body = strstr(response, "\r\n\r\n");
    int status = 0;
    if (!body || sscanf(response, "HTTP/1.%*1[01] %d", &status) != 1 ||
        mem_contains_ci(response, (size_t)(body - response), "transfer-encoding:")) {
        cstr_copy(error, cap, "the model server's reply could not be read"); return -1;
    }
    body += 4;
    char problem[96], text[300];
    dtg_json_token tokens_json[96];
    int count = dtg_json_validate_complete(body, '{', problem, sizeof problem)
        ? dtg_json_tokenize(body, strlen(body), tokens_json, 96) : 0;
    if (status != 200) {
        int failure = count > 0 ? dtg_json_object_field(body, tokens_json, count, 0, "error") : -1;
        int message = failure >= 0 ? dtg_json_object_field(body, tokens_json, count, failure, "message") : -1;
        if (message >= 0 && dtg_json_token_string(body, &tokens_json[message], text, sizeof text))
            snprintf(error, cap, "the model server refused (HTTP %d): %.200s", status, text);
        else snprintf(error, cap, "the model server refused (HTTP %d)", status);
        return status >= 400 && status < 600 ? 0 : -1;
    }
    int name = count > 0 ? dtg_json_object_field(body, tokens_json, count, 0, "filename") : -1;
    int n_tokens = count > 0 ? dtg_json_object_field(body, tokens_json, count, 0, save ? "n_saved" : "n_restored") : -1;
    int n_bytes = count > 0 ? dtg_json_object_field(body, tokens_json, count, 0, save ? "n_written" : "n_read") : -1;
    if (name < 0 || !dtg_json_token_eq(body, &tokens_json[name], filename) ||
        n_tokens < 0 || !dtg_json_token_int(body, &tokens_json[n_tokens], 0, INT_MAX, tokens) ||
        n_bytes < 0 || !dtg_json_token_int(body, &tokens_json[n_bytes], 1, LLONG_MAX, bytes)) {
        cstr_copy(error, cap, "the model server's reply does not describe this snapshot"); return -1;
    }
    return 1;
}

/* What the turn after a restore decision is told, and what status reports. */
enum { KVS_RESTORE_NONE = 0, KVS_RESTORE_RESTORED, KVS_RESTORE_PREFILL, KVS_RESTORE_LIVE, KVS_RESTORE_UNKNOWN };

static const char *kvs_restore_name(int outcome, int evidence, long long cache_tokens) {
    if (outcome == KVS_RESTORE_RESTORED) return evidence && cache_tokens == 0 ? "restored-not-reused" : "restored";
    return outcome == KVS_RESTORE_PREFILL ? "prefill" : outcome == KVS_RESTORE_LIVE ? "live"
         : outcome == KVS_RESTORE_UNKNOWN ? "unknown" : "none";
}

/* A restore the server confirmed is still not reported as one when its first
 * completion reused nothing: that turn was prefilled again. */
static void kvs_restore_text(int outcome, long long tokens, int evidence, long long cache_tokens, char *out, size_t cap) {
    if (outcome == KVS_RESTORE_RESTORED && evidence && cache_tokens == 0)
        snprintf(out, cap, "prefilled again (the restored disk snapshot of %lld tokens was not reused)", tokens);
    else if (outcome == KVS_RESTORE_RESTORED) snprintf(out, cap, "restored from disk snapshot (%lld tokens)", tokens);
    else if (outcome == KVS_RESTORE_PREFILL) cstr_copy(out, cap, "prefilled again");
    else if (outcome == KVS_RESTORE_LIVE) cstr_copy(out, cap, "context still in memory");
    else if (outcome == KVS_RESTORE_UNKNOWN) cstr_copy(out, cap, "disk snapshot restore not confirmed");
    else cstr_copy(out, cap, "");
}

#ifdef _WIN32
/* The host's Windows build has no snapshot store: no slot directory is ever
 * passed to llama-server, so every hook below is inert. NOT TESTED there. */
static int kvs_slot_dir_prepare(char *out, size_t cap) { if (cap) out[0] = '\0'; return 0; }
static void kvs_runtime_line(const char *line, int is_err) { (void)line; (void)is_err; }
static void kvs_turn_end(int interrupted) { (void)interrupted; }
static void kvs_turn_failed(void) {}
static int kvs_hold_model_request(void) { return 0; }
static void kvs_completion_admitted(int relayed) { (void)relayed; }
static void kvs_completion_final(const char *frame) { (void)frame; }
static void kvs_tick(void) {}
static int kvs_pollfds(struct pollfd *fds) { (void)fds; return 0; }
static int kvs_fast_tick(void) { return 0; }
static void kvs_delete_session(int mode, const char *session) { (void)mode; (void)session; }
static void kvs_wipe(void) {}
static void kvs_status_json(json_dyn_buf *out) { json_dyn_puts(out, "{\"enabled\":false,\"reason\":\"not available on Windows\"}"); }
static void kvs_shutdown(void) {}
#else
#include <sys/statvfs.h>

/* ==================== store operations (worker thread only) ==================== */

enum { KVS_OP_SAVE_PREPARE = 1, KVS_OP_SAVE_COMMIT, KVS_OP_DISCARD, KVS_OP_RESTORE_PREPARE,
       KVS_OP_RESTORE_TOUCH, KVS_OP_REMOVE, KVS_OP_DELETE, KVS_OP_WIPE };

/* One private candidate: inputs copied by the owner before the thread starts,
 * results read by the owner only after done. */
typedef struct {
    int op;
    char dir[DSTUDIO_PATH_MAX], install[1024];
    kvs_key_inputs key;
    kvs_limits limits;
    char mode, session[9];
    long long messages, tokens, bytes;      /* inputs of commit; outputs of restore-prepare */
    char digest[65], file[KVS_NAME_MAX], temp[KVS_NAME_MAX];
    int ok, refused;                        /* refused: a limit said no; nothing is wrong */
    char reason[200];
    int store_known, store_entries, evicted, stale_removed;
    long long store_bytes;
    pthread_t thread;
    int done;
} kvs_op;

static pthread_mutex_t g_kvs_lock = PTHREAD_MUTEX_INITIALIZER;

static int kvs_dir_open(const char *dir) {
    int fd = open(dir, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    struct stat st;
    if (fd >= 0 && (fstat(fd, &st) || !S_ISDIR(st.st_mode) || st.st_uid != geteuid() || (st.st_mode & 077))) { close(fd); fd = -1; }
    return fd;
}

/* The installer's receipt names the build this server binary came from. */
static int kvs_receipt_read(const char *install, kvs_key_inputs *key) {
    char path[1100];
    int n = snprintf(path, sizeof path, "%s/%s", install, KVS_RECEIPT);
    if (n <= 0 || (size_t)n >= sizeof path) return 0;
    int fd = open(path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
    struct stat st;
    if (fd < 0 || fstat(fd, &st) || !S_ISREG(st.st_mode) || st.st_size <= 0 || st.st_size > KVS_RECEIPT_MAX) { if (fd >= 0) close(fd); return 0; }
    char *json = malloc((size_t)st.st_size + 1);
    dtg_json_token *tokens = calloc(4096, sizeof *tokens);
    ssize_t got = json ? read(fd, json, (size_t)st.st_size) : -1;
    close(fd);
    int ok = 0;
    char error[96], text[80];
    if (tokens && got == st.st_size) {
        json[got] = '\0';
        int count = strlen(json) == (size_t)got && dtg_json_validate_complete(json, '{', error, sizeof error)
            ? dtg_json_tokenize(json, (size_t)got, tokens, 4096) : 0;
        int at = count > 0 ? dtg_json_object_field(json, tokens, count, 0, "schema") : -1;
        ok = at >= 0 && dtg_json_token_eq(json, &tokens[at], KVS_RECEIPT_SCHEMA);
        struct { const char *name; char *out; size_t length; } fields[] = {
            {"buildId", key->build_id, 64}, {"commit", key->commit, 40}, {"binarySHA256", key->binary_sha256, 64}};
        for (size_t i = 0; ok && i < sizeof fields / sizeof fields[0]; i++) {
            at = dtg_json_object_field(json, tokens, count, 0, fields[i].name);
            ok = at >= 0 && dtg_json_token_string(json, &tokens[at], text, sizeof text) &&
                 strlen(text) == fields[i].length && kvs_hex_ok(text, fields[i].length);
            if (ok) memcpy(fields[i].out, text, fields[i].length + 1);
        }
    }
    free(json); free(tokens);
    return ok;
}

static int kvs_file_size(int dir, const char *name, long long *bytes) {
    struct stat st;
    if (fstatat(dir, name, &st, AT_SYMLINK_NOFOLLOW) || !S_ISREG(st.st_mode) || st.st_nlink != 1) return 0;
    *bytes = (long long)st.st_size;
    return 1;
}

static int kvs_sidecar_read(int dir, const char *name, kvs_sidecar *out) {
    char text[KVS_SIDECAR_MAX + 1];
    int fd = openat(dir, name, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
    struct stat st;
    if (fd < 0 || fstat(fd, &st) || !S_ISREG(st.st_mode) || st.st_size <= 0 || st.st_size > KVS_SIDECAR_MAX) { if (fd >= 0) close(fd); return 0; }
    ssize_t got = read(fd, text, (size_t)st.st_size);
    close(fd);
    if (got != st.st_size) return 0;
    text[got] = '\0';
    return kvs_sidecar_parse(text, (size_t)got, out);
}

/* temp + fsync + rename; the directory is synced by the caller. */
static int kvs_sidecar_write(int dir, const char *name, const kvs_sidecar *sidecar) {
    char text[KVS_SIDECAR_MAX], temp[KVS_NAME_MAX];
    if (!kvs_sidecar_encode(sidecar, text, sizeof text) ||
        !kvs_name_build(temp, sizeof temp, sidecar->mode, sidecar->session, sidecar->digest, ".jtmp")) return 0;
    (void)unlinkat(dir, temp, 0);
    int fd = openat(dir, temp, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
    size_t length = strlen(text);
    int ok = fd >= 0 && write(fd, text, length) == (ssize_t)length && !fsync(fd);
    if (fd >= 0 && close(fd)) ok = 0;
    if (ok && renameat(dir, temp, dir, name)) ok = 0;
    if (!ok) (void)unlinkat(dir, temp, 0);
    return ok;
}

typedef struct {
    char mode, session[9], digest[17];
    long long bytes;
    int valid;          /* a matching sidecar with this size */
    kvs_sidecar meta;
} kvs_found;

/* Every snapshot in the store, and removal of what no snapshot owns: partial
 * files, sidecars without a slot, slots without a readable sidecar. keep is
 * the file of the exchange in flight, if any. 0: the directory is unreadable
 * or holds more names than a scan visits (nothing is removed then). */
static int kvs_store_scan(int dir, const char *keep, kvs_found **out, int *count) {
    *out = NULL; *count = 0;
    int copy = dup(dir);
    DIR *stream = copy >= 0 ? fdopendir(copy) : NULL;
    if (!stream) { if (copy >= 0) close(copy); return 0; }
    rewinddir(stream);
    char (*names)[KVS_NAME_MAX] = calloc(KVS_SCAN_MAX, sizeof *names);
    int total = 0, visited = 0, complete = names != NULL;
    for (struct dirent *e; complete && (e = readdir(stream)); ) {
        char mode, session[9], digest[17]; const char *suffix;
        if (++visited > KVS_SCAN_MAX) { complete = 0; break; }
        if (!kvs_name_parse(e->d_name, &mode, session, digest, &suffix)) continue;
        memcpy(names[total++], e->d_name, 33);
    }
    closedir(stream);
    kvs_found *found = complete ? calloc((size_t)total + 1, sizeof *found) : NULL;
    if (!found) { free(names); return 0; }
    int slots = 0;
    for (int i = 0; i < total; i++) {
        char mode, session[9], digest[17], sidecar[KVS_NAME_MAX]; const char *suffix;
        kvs_name_parse(names[i], &mode, session, digest, &suffix);
        if (keep && !strcmp(names[i], keep)) continue;
        if (!strcmp(suffix, ".part") || !strcmp(suffix, ".jtmp")) { (void)unlinkat(dir, names[i], 0); continue; }
        if (!strcmp(suffix, ".json")) {
            char slot[KVS_NAME_MAX]; long long bytes;
            kvs_name_build(slot, sizeof slot, mode, session, digest, ".slot");
            if (!kvs_file_size(dir, slot, &bytes)) (void)unlinkat(dir, names[i], 0);
            continue;
        }
        kvs_found *f = &found[slots];
        f->mode = mode; memcpy(f->session, session, 9); memcpy(f->digest, digest, 17);
        kvs_name_build(sidecar, sizeof sidecar, mode, session, digest, ".json");
        f->valid = kvs_file_size(dir, names[i], &f->bytes) && kvs_sidecar_read(dir, sidecar, &f->meta) &&
                   f->meta.mode == mode && !strcmp(f->meta.session, session) && !strncmp(f->meta.digest, digest, 16) &&
                   f->meta.bytes == f->bytes;
        if (!f->valid) { (void)unlinkat(dir, names[i], 0); (void)unlinkat(dir, sidecar, 0); continue; }
        slots++;
    }
    free(names);
    *out = found; *count = slots;
    return 1;
}

static void kvs_found_remove(int dir, const kvs_found *f) {
    char name[KVS_NAME_MAX];
    if (kvs_name_build(name, sizeof name, f->mode, f->session, f->digest, ".slot")) (void)unlinkat(dir, name, 0);
    if (kvs_name_build(name, sizeof name, f->mode, f->session, f->digest, ".json")) (void)unlinkat(dir, name, 0);
}

static void kvs_store_totals(kvs_op *op, const kvs_found *found, int count, const kvs_found *except) {
    op->store_known = 1; op->store_entries = 0; op->store_bytes = 0;
    for (int i = 0; i < count; i++) {
        if (&found[i] == except || !found[i].valid) continue;
        op->store_entries++; op->store_bytes += found[i].bytes;
    }
}

static void kvs_op_fail(kvs_op *op, const char *reason) { op->ok = 0; cstr_copy(op->reason, sizeof op->reason, reason); }

static int kvs_op_key(kvs_op *op) {
    if (!kvs_receipt_read(op->install, &op->key)) {
        kvs_op_fail(op, "the llama.cpp installation receipt is missing or unreadable"); return 0;
    }
    if (!kvs_key_digest(&op->key, op->mode, op->session, op->digest)) {
        kvs_op_fail(op, "the running engine has no complete snapshot identity"); return 0;
    }
    return 1;
}

static void kvs_op_save_prepare(kvs_op *op, int dir) {
    kvs_found *found; int count;
    if (!kvs_op_key(op)) return;
    if (!kvs_name_build(op->temp, sizeof op->temp, op->mode, op->session, op->digest, ".part") ||
        !kvs_name_build(op->file, sizeof op->file, op->mode, op->session, op->digest, ".slot")) { kvs_op_fail(op, "invalid snapshot name"); return; }
    if (!kvs_store_scan(dir, NULL, &found, &count)) { kvs_op_fail(op, "the snapshot directory could not be scanned"); return; }
    long long replaced = 0;
    for (int i = 0; i < count; i++)
        if (found[i].mode == op->mode && !strcmp(found[i].session, op->session) && !strncmp(found[i].digest, op->digest, 16)) replaced = found[i].bytes;
    kvs_store_totals(op, found, count, NULL);
    free(found);
    struct statvfs space;
    if (fstatvfs(dir, &space)) { kvs_op_fail(op, "free disk space could not be read"); return; }
    unsigned long long available = (unsigned long long)space.f_bavail * (unsigned long long)space.f_frsize;
    long long free_bytes = available > (unsigned long long)LLONG_MAX ? LLONG_MAX : (long long)available;
    if (!kvs_space_ok(free_bytes, op->limits.min_free, replaced)) {
        op->refused = 1; kvs_op_fail(op, "free disk space is below the snapshot margin"); return;
    }
    op->ok = 1;
}

/* The server wrote op->temp and reported op->bytes and op->tokens. */
static void kvs_op_save_commit(kvs_op *op, int dir) {
    kvs_found *found = NULL; int count = 0;
    char sidecar[KVS_NAME_MAX];
    struct stat st;
    int fd = openat(dir, op->temp, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
    int written = fd >= 0 && !fstat(fd, &st) && S_ISREG(st.st_mode) && st.st_nlink == 1 && st.st_size > 0;
    if (written && (long long)st.st_size != op->bytes) { written = 0; kvs_op_fail(op, "the written file does not have the size the model server reported"); }
    else if (!written) kvs_op_fail(op, "the model server did not leave a snapshot file");
    /* Durable before it can be offered for a restore. */
    if (written && fsync(fd)) { written = 0; kvs_op_fail(op, "the snapshot could not be made durable"); }
    if (fd >= 0) close(fd);
    if (written && op->bytes > op->limits.max_bytes) {
        written = 0; op->refused = 1; kvs_op_fail(op, "the snapshot is larger than the whole store limit");
    }
    if (written && !kvs_store_scan(dir, op->temp, &found, &count)) { written = 0; kvs_op_fail(op, "the snapshot directory could not be scanned"); }
    if (!written || !kvs_name_build(sidecar, sizeof sidecar, op->mode, op->session, op->digest, ".json")) {
        (void)unlinkat(dir, op->temp, 0); free(found);
        if (op->ok || !op->reason[0]) kvs_op_fail(op, "invalid snapshot name");
        return;
    }
    kvs_sidecar meta = {0};
    meta.mode = op->mode; memcpy(meta.session, op->session, 9); memcpy(meta.digest, op->digest, 65);
    meta.tokens = op->tokens; meta.bytes = op->bytes; meta.messages = op->messages; meta.saved_ms = dstudio_now_ms();
    kvs_entry *entries = calloc((size_t)count + 1, sizeof *entries);
    int used = 0;
    for (int i = 0; entries && i < count; i++) {
        if (found[i].meta.seq >= meta.seq) meta.seq = found[i].meta.seq + 1;
        /* Earlier snapshots of this session, under this key or a stale one. */
        if (found[i].mode == op->mode && !strcmp(found[i].session, op->session)) {
            if (strncmp(found[i].digest, op->digest, 16)) { kvs_found_remove(dir, &found[i]); op->stale_removed++; }
            found[i].valid = 0;
            continue;
        }
        kvs_name_build(entries[used].name, sizeof entries[used].name, found[i].mode, found[i].session, found[i].digest, ".slot");
        entries[used].bytes = found[i].bytes; entries[used].seq = found[i].meta.seq;
        used++;
    }
    /* A slot is valid only with its sidecar: remove the old record first, so
     * no interruption leaves the new bytes under the old description. */
    int ok = entries != NULL;
    if (ok) {
        (void)unlinkat(dir, sidecar, 0);
        ok = !renameat(dir, op->temp, dir, op->file) && kvs_sidecar_write(dir, sidecar, &meta) && !fsync(dir);
    }
    if (!ok) {
        (void)unlinkat(dir, op->temp, 0); (void)unlinkat(dir, op->file, 0); (void)unlinkat(dir, sidecar, 0);
        kvs_op_fail(op, "the snapshot could not be published");
        free(entries); free(found);
        return;
    }
    cstr_copy(entries[used].name, sizeof entries[used].name, op->file);
    entries[used].bytes = op->bytes; entries[used].seq = meta.seq; entries[used].keep = 1;
    (void)kvs_plan_eviction(entries, used + 1, op->limits.max_bytes, op->limits.max_entries);
    op->store_known = 1; op->store_entries = 1; op->store_bytes = op->bytes;
    for (int i = 0; i < used; i++) {
        if (!entries[i].evict) { op->store_entries++; op->store_bytes += entries[i].bytes; continue; }
        char record[KVS_NAME_MAX];
        memcpy(record, entries[i].name, sizeof record); memcpy(record + 27, ".json", 6);
        (void)unlinkat(dir, entries[i].name, 0); (void)unlinkat(dir, record, 0);
        op->evicted++;
    }
    (void)fsync(dir);
    free(entries); free(found);
    op->ok = 1;
}

static void kvs_op_restore_prepare(kvs_op *op, int dir) {
    kvs_found *found; int count, seen = 0, verdict = KVS_ADMIT_DAMAGED, chosen = -1;
    if (!kvs_op_key(op)) return;
    if (!kvs_store_scan(dir, NULL, &found, &count)) { kvs_op_fail(op, "the snapshot directory could not be scanned"); return; }
    for (int i = 0; i < count; i++) {
        if (found[i].mode != op->mode || strcmp(found[i].session, op->session)) continue;
        seen++;
        int this_verdict = strncmp(found[i].digest, op->digest, 16) ? KVS_ADMIT_KEY
            : kvs_admit(&found[i].meta, op->mode, op->session, op->digest, found[i].bytes, op->messages);
        if (this_verdict == KVS_ADMIT_OK) { chosen = i; continue; }
        /* Stale for good: nothing can make this file match again. */
        kvs_found_remove(dir, &found[i]); found[i].valid = 0; op->stale_removed++;
        verdict = this_verdict;
    }
    if (op->stale_removed) (void)fsync(dir);
    kvs_store_totals(op, found, count, NULL);
    if (chosen >= 0) {
        kvs_name_build(op->file, sizeof op->file, op->mode, op->session, op->digest, ".slot");
        op->tokens = found[chosen].meta.tokens; op->bytes = found[chosen].bytes;
        op->ok = 1;
    } else if (!seen) {
        kvs_op_fail(op, "no disk snapshot of this session");
    } else {
        char reason[200];
        snprintf(reason, sizeof reason, "its disk snapshot was removed: %s", kvs_admit_reason(verdict));
        kvs_op_fail(op, reason);
    }
    free(found);
}

/* A restored snapshot is the most recently used one. */
static void kvs_op_restore_touch(kvs_op *op, int dir) {
    kvs_found *found; int count;
    if (!kvs_store_scan(dir, NULL, &found, &count)) { kvs_op_fail(op, "the snapshot directory could not be scanned"); return; }
    long long newest = 0; int mine = -1;
    for (int i = 0; i < count; i++) {
        if (found[i].meta.seq > newest) newest = found[i].meta.seq;
        if (found[i].mode == op->mode && !strcmp(found[i].session, op->session) && !strncmp(found[i].digest, op->digest, 16)) mine = i;
    }
    if (mine >= 0 && found[mine].meta.seq < newest) {
        char sidecar[KVS_NAME_MAX];
        kvs_sidecar meta = found[mine].meta;
        meta.seq = newest + 1;
        if (kvs_name_build(sidecar, sizeof sidecar, op->mode, op->session, op->digest, ".json") &&
            kvs_sidecar_write(dir, sidecar, &meta)) (void)fsync(dir);
    }
    kvs_store_totals(op, found, count, NULL);
    free(found);
    op->ok = 1;
}

/* DISCARD: op->temp. REMOVE: this session's snapshot under op->digest.
 * DELETE: every file of this session. WIPE: every file of the store. */
static void kvs_op_remove(kvs_op *op, int dir) {
    kvs_found *found; int count;
    if (op->op == KVS_OP_DISCARD) (void)unlinkat(dir, op->temp, 0);
    if (op->op == KVS_OP_DELETE || op->op == KVS_OP_WIPE || op->op == KVS_OP_REMOVE) {
        int copy = dup(dir);
        DIR *stream = copy >= 0 ? fdopendir(copy) : NULL;
        char (*names)[KVS_NAME_MAX] = calloc(KVS_SCAN_MAX, sizeof *names);
        int total = 0;
        if (stream) rewinddir(stream);
        for (struct dirent *e; stream && names && total < KVS_SCAN_MAX && (e = readdir(stream)); ) {
            char mode, session[9], digest[17]; const char *suffix;
            if (!kvs_name_parse(e->d_name, &mode, session, digest, &suffix)) continue;
            if (op->op != KVS_OP_WIPE && (mode != op->mode || strcmp(session, op->session))) continue;
            if (op->op == KVS_OP_REMOVE && strncmp(digest, op->digest, 16)) continue;
            memcpy(names[total++], e->d_name, 33);
        }
        if (stream) closedir(stream); else if (copy >= 0) close(copy);
        for (int i = 0; i < total; i++) (void)unlinkat(dir, names[i], 0);
        free(names);
    }
    (void)fsync(dir);
    if (kvs_store_scan(dir, NULL, &found, &count)) { kvs_store_totals(op, found, count, NULL); free(found); }
    op->ok = 1;
}

static void *kvs_worker(void *context) {
    kvs_op *op = context;
    int dir = kvs_dir_open(op->dir);
    if (dir < 0) kvs_op_fail(op, "the snapshot directory is missing or not private to this user");
    else if (op->op == KVS_OP_SAVE_PREPARE) kvs_op_save_prepare(op, dir);
    else if (op->op == KVS_OP_SAVE_COMMIT) kvs_op_save_commit(op, dir);
    else if (op->op == KVS_OP_RESTORE_PREPARE) kvs_op_restore_prepare(op, dir);
    else if (op->op == KVS_OP_RESTORE_TOUCH) kvs_op_restore_touch(op, dir);
    else kvs_op_remove(op, dir);
    if (dir >= 0) close(dir);
    pthread_mutex_lock(&g_kvs_lock);
    op->done = 1;
    pthread_mutex_unlock(&g_kvs_lock);
    return NULL;
}

/* ==================== owner ==================== */

typedef struct { char mode, session[9]; } kvs_id;

static int kvs_id_same(const kvs_id *a, const kvs_id *b) { return a->mode && a->mode == b->mode && !strcmp(a->session, b->session); }

typedef struct {
    int valid;
    kvs_id id;
    long long messages;
    unsigned long long uses, token;
    pid_t frontend;
} kvs_request;

enum { KVS_SAVE = 1, KVS_RESTORE };
enum { KVS_PHASE_PREPARE = 1, KVS_PHASE_CONNECT, KVS_PHASE_SEND, KVS_PHASE_READ, KVS_PHASE_FINISH };

typedef struct {
    int kind, phase, fd, sent, dead, published;
    kvs_request request;
    pid_t resident; unsigned long long generation;
    kvs_key_inputs key;
    kvs_limits limits;
    char dir[DSTUDIO_PATH_MAX], install[1024];
    char digest[65], file[KVS_NAME_MAX], temp[KVS_NAME_MAX], name[KVS_NAME_MAX];
    char http[512]; size_t http_len, http_sent;
    char *response; size_t response_len;
    long long connect_deadline, started_ms, tokens, bytes;
    int outcome;                            /* restore */
    char reason[200];
    int finish_op;
} kvs_job;

typedef struct {
    unsigned long long seq;
    kvs_id id;
    char outcome[16], reason[200];
    long long tokens, bytes, ms;
} kvs_save_report;

typedef struct {
    unsigned long long seq;
    kvs_id id;
    int outcome, announced, first_pending, evidence;
    char reason[200];
    long long tokens, bytes, ms, cache_tokens, prompt_tokens;
    pid_t frontend;
} kvs_restore_report;

static struct {
    /* The engine process the counters below describe. */
    pid_t resident; unsigned long long generation;
    pid_t frontend;
    unsigned long long uses;        /* completions admitted to this engine process */
    int last_use_ok;                /* the newest one ended with model_done through the host relay */
    int turn_ok;                    /* such completions since the last WAITING */
    /* Agent/Cowork: the announcement (stdout) and the end of the turn
     * (stderr) arrive on two pipes, in either order. */
    int announced; kvs_id announced_id; long long announced_messages;
    int ended, ended_interrupted, ended_failed, ended_ok; unsigned long long ended_uses;
    int turn_failed;
    kvs_id live; unsigned long long live_uses; int live_valid;     /* whose state the slot holds */
    kvs_id saved; unsigned long long saved_uses; int saved_valid;  /* which state the disk holds */
    kvs_job *job;
    kvs_op *op;
    kvs_request next_save, next_restore;
    unsigned long long restore_token;
    kvs_id deletes[KVS_DELETE_MAX]; int delete_count, wipe_pending, deletes_dropped;
    unsigned long long wipe_epoch;
    kvs_save_report save;
    kvs_restore_report restore;
    int store_known, store_entries; long long store_bytes;
    unsigned long long save_requests, saves, restore_requests, restores, superseded, evicted, stale_removed;
} g_kvs;

static int kvs_slot_dir_path(char *out, size_t cap) {
    char root[1600];
    kv_root(root, sizeof root);
    int n = snprintf(out, cap, "%s/%s", root, KVS_DIR_NAME);
    if (n <= 0 || (size_t)n >= cap || out[0] != '/') { if (cap) out[0] = '\0'; return 0; }
    return 1;
}

/* Created with the server's launch; never a reason to refuse the launch. */
static int kvs_slot_dir_prepare(char *out, size_t cap) {
    kvs_limits limits = kvs_limits_now();
    if (!limits.enabled || limits.max_bytes <= 0 || !kvs_slot_dir_path(out, cap)) { if (cap) out[0] = '\0'; return 0; }
    mkpath(out);
    struct stat st;
    if ((mkdir(out, 0700) && errno != EEXIST) || lstat(out, &st) || !S_ISDIR(st.st_mode) || st.st_uid != geteuid() ||
        ((st.st_mode & 077) && chmod(out, 0700))) { out[0] = '\0'; return 0; }
    return 1;
}

/* The owned llama.cpp server is ready, has a slot directory and serves the
 * runtime that is running now through the host relay. A pi/OpenCode harness
 * talks to the server directly, so the host cannot know what its slot holds. */
static int kvs_engine_current(void) {
    return g_resident.spec.kind == RESIDENT_LLAMA && g_resident.slot_dir[0] && !g_harness[0] &&
           resident_rpc_current(g_resident.pid, g_resident.launch_task);
}

static int kvs_job_engine_current(const kvs_job *job) {
    return resident_ready() && g_resident.pid == job->resident && g_resident.launch_task == job->generation &&
           g_resident.spec.kind == RESIDENT_LLAMA && g_resident.slot_dir[0];
}

static void kvs_report_save(const kvs_id *id, const char *outcome, const char *reason, long long tokens, long long bytes, long long ms) {
    g_kvs.save.seq++;
    g_kvs.save.id = *id;
    cstr_copy(g_kvs.save.outcome, sizeof g_kvs.save.outcome, outcome);
    cstr_copy(g_kvs.save.reason, sizeof g_kvs.save.reason, reason ? reason : "");
    g_kvs.save.tokens = tokens; g_kvs.save.bytes = bytes; g_kvs.save.ms = ms;
    dstudio_log_event(!strcmp(outcome, "failed") ? "warn" : "info", "kv-snapshot", 0, "save %s %s: %s%s%s",
                      kvs_mode_name(id->mode), id->session, outcome, reason && reason[0] ? ": " : "", reason ? reason : "");
}

static void kvs_report_restore(const kvs_request *request, int outcome, const char *reason, long long tokens, long long bytes, long long ms) {
    char text[160];
    memset(&g_kvs.restore, 0, sizeof g_kvs.restore);
    g_kvs.restore.seq = ++g_kvs.restores;
    g_kvs.restore.id = request->id; g_kvs.restore.outcome = outcome; g_kvs.restore.frontend = request->frontend;
    cstr_copy(g_kvs.restore.reason, sizeof g_kvs.restore.reason, reason ? reason : "");
    g_kvs.restore.tokens = tokens; g_kvs.restore.bytes = bytes; g_kvs.restore.ms = ms;
    kvs_restore_text(outcome, tokens, 0, 0, text, sizeof text);
    dstudio_log_event("info", "kv-snapshot", 0, "restore %s %s: %s%s%s", kvs_mode_name(request->id.mode), request->id.session,
                      text, reason && reason[0] ? ": " : "", reason ? reason : "");
}

static int kvs_op_start(kvs_op *op) {
    if (pthread_create(&op->thread, NULL, kvs_worker, op)) { free(op); return 0; }
    g_kvs.op = op;
    return 1;
}

static kvs_op *kvs_op_new(int kind, const char *dir) {
    kvs_op *op = calloc(1, sizeof *op);
    if (!op) return NULL;
    op->op = kind; op->limits = kvs_limits_now();
    cstr_copy(op->dir, sizeof op->dir, dir);
    return op;
}

static kvs_op *kvs_op_for_job(const kvs_job *job, int kind) {
    kvs_op *op = kvs_op_new(kind, job->dir);
    if (!op) return NULL;
    op->limits = job->limits; op->key = job->key;
    cstr_copy(op->install, sizeof op->install, job->install);
    op->mode = job->request.id.mode; memcpy(op->session, job->request.id.session, 9);
    op->messages = job->request.messages; op->tokens = job->tokens; op->bytes = job->bytes;
    memcpy(op->digest, job->digest, sizeof op->digest);
    memcpy(op->file, job->file, sizeof op->file); memcpy(op->temp, job->temp, sizeof op->temp);
    return op;
}

static void kvs_job_free(void) {
    kvs_job *job = g_kvs.job;
    if (!job) return;
    if (job->fd >= 0) close(job->fd);
    free(job->response); free(job);
    g_kvs.job = NULL;
}

/* A restore decision is published in the same owner step that stops holding
 * the session's first completion: the turn must find its report. */
static void kvs_restore_resolved(const kvs_job *job) {
    const kvs_id *id = &job->request.id;
    /* Token and byte counts describe a restore the server confirmed, nothing else. */
    const int restored = job->outcome == KVS_RESTORE_RESTORED;
    /* A newer /switch or another runtime owns the next turn's report. */
    if (job->request.token == g_kvs.restore_token && job->request.frontend == g_child)
        kvs_report_restore(&job->request, job->outcome, job->reason, restored ? job->tokens : 0, restored ? job->bytes : 0,
                           dstudio_now_ms() - job->started_ms);
    if (job->outcome == KVS_RESTORE_RESTORED && kvs_job_engine_current(job) && g_kvs.uses == job->request.uses) {
        g_kvs.live = *id; g_kvs.live_uses = g_kvs.uses; g_kvs.live_valid = 1;
        g_kvs.saved = *id; g_kvs.saved_uses = g_kvs.uses; g_kvs.saved_valid = !job->dead;
    } else if (job->sent) g_kvs.live_valid = 0; /* the server may have replaced the slot */
}

/* The exchange is over; what remains is one filesystem step, or nothing. */
static void kvs_job_finish(int finish_op) {
    kvs_job *job = g_kvs.job;
    if (job->fd >= 0) { close(job->fd); job->fd = -1; }
    job->finish_op = finish_op;
    job->phase = KVS_PHASE_FINISH;
    if (job->kind == KVS_RESTORE) kvs_restore_resolved(job);
}

static void kvs_job_start(int kind, const kvs_request *request) {
    kvs_job *job = calloc(1, sizeof *job);
    kvs_op *op = NULL;
    if (job) {
        job->kind = kind; job->phase = KVS_PHASE_PREPARE; job->fd = -1; job->request = *request;
        job->resident = g_resident.pid; job->generation = g_resident.launch_task;
        job->limits = kvs_limits_now(); job->started_ms = dstudio_now_ms();
        cstr_copy(job->dir, sizeof job->dir, g_resident.slot_dir);
        cstr_copy(job->install, sizeof job->install, g_resident.spec.install);
        cstr_copy(job->key.build_info, sizeof job->key.build_info, RESIDENT_BUILD_INFO);
        cstr_copy(job->key.model_identity, sizeof job->key.model_identity, g_resident.spec.model_identity);
        cstr_copy(job->key.vision_identity, sizeof job->key.vision_identity, g_resident.spec.vision_identity);
        cstr_copy(job->key.args_identity, sizeof job->key.args_identity, g_resident.args_identity);
        cstr_copy(job->key.model_id, sizeof job->key.model_id, g_resident.spec.model_id);
        job->key.ctx = g_resident.spec.cfg.ctx;
        op = kvs_op_for_job(job, kind == KVS_SAVE ? KVS_OP_SAVE_PREPARE : KVS_OP_RESTORE_PREPARE);
    }
    if (!job || !op || !kvs_op_start(op)) {
        free(job);
        if (kind == KVS_SAVE) kvs_report_save(&request->id, "failed", "the snapshot worker could not start", 0, 0, 0);
        else kvs_report_restore(request, KVS_RESTORE_PREFILL, "the snapshot worker could not start", 0, 0, 0);
        return;
    }
    g_kvs.job = job;
}

static int kvs_job_connect(kvs_job *job) {
    int body = snprintf(job->http, sizeof job->http, "{\"filename\":\"%s\"}", job->name);
    char payload[96];
    memcpy(payload, job->http, (size_t)body + 1);
    int n = snprintf(job->http, sizeof job->http,
        "POST /slots/0?action=%s HTTP/1.1\r\nHost: 127.0.0.1:%d\r\nContent-Type: application/json\r\n"
        "Content-Length: %d\r\nConnection: close\r\n\r\n%s",
        job->kind == KVS_SAVE ? "save" : "restore", g_resident.spec.cfg.port, body, payload);
    job->http_len = (size_t)n; job->http_sent = 0;
    job->fd = resident_socket_connect(g_resident.spec.cfg.port);
    if (job->fd < 0) return 0;
    job->phase = KVS_PHASE_CONNECT;
    job->connect_deadline = dstudio_now_ms() + KVS_CONNECT_MS;
    return 1;
}

/* The worker's PREPARE result and every assumption made at admission. */
static void kvs_job_prepared(kvs_job *job, kvs_op *op) {
    const kvs_id *id = &job->request.id;
    memcpy(job->digest, op->digest, sizeof job->digest);
    memcpy(job->file, op->file, sizeof job->file); memcpy(job->temp, op->temp, sizeof job->temp);
    if (job->kind == KVS_SAVE) {
        const char *skip = !op->ok ? op->reason
            : job->dead ? job->reason
            : !kvs_job_engine_current(job) ? "the engine was stopped or replaced"
            : g_kvs.uses != job->request.uses || g_agent_working ? "the engine is busy with another turn"
            : NULL;
        if (skip) { kvs_report_save(id, op->ok ? "skipped" : op->refused ? "refused" : "failed", skip, 0, 0, 0); kvs_job_finish(0); return; }
        memcpy(job->name, job->temp, sizeof job->name);
        if (!kvs_job_connect(job)) { kvs_report_save(id, "failed", "the model server could not be reached", 0, 0, 0); kvs_job_finish(0); }
        return;
    }
    const char *miss = !op->ok ? op->reason
        : !kvs_job_engine_current(job) ? "the engine was stopped or replaced"
        : g_kvs.uses != job->request.uses ? "the engine was used before the snapshot could be restored"
        : NULL;
    if (miss) { job->outcome = KVS_RESTORE_PREFILL; cstr_copy(job->reason, sizeof job->reason, miss); kvs_job_finish(0); return; }
    job->tokens = op->tokens; job->bytes = op->bytes;
    memcpy(job->name, job->file, sizeof job->name);
    if (!kvs_job_connect(job)) {
        job->outcome = KVS_RESTORE_PREFILL; cstr_copy(job->reason, sizeof job->reason, "the model server could not be reached");
        kvs_job_finish(0);
    }
}

/* The complete reply, or the end of the connection. */
static void kvs_job_reply(kvs_job *job, int complete) {
    const kvs_id *id = &job->request.id;
    long long tokens = 0, bytes = 0, ms = dstudio_now_ms() - job->started_ms;
    char error[240] = "";
    int verdict = complete ? kvs_reply_parse(job->response, job->kind == KVS_SAVE, job->name, &tokens, &bytes, error, sizeof error) : -1;
    if (!complete) cstr_copy(error, sizeof error, job->sent ? "the model server closed the connection before answering" : "the model server could not be reached");
    if (job->kind == KVS_SAVE) {
        const char *stale = job->dead ? job->reason : !kvs_job_engine_current(job) ? "the engine was stopped or replaced" : NULL;
        if (verdict != 1 || stale) {
            kvs_report_save(id, verdict == 1 || job->dead ? "discarded" : "failed", stale ? stale : error, 0, 0, ms);
            kvs_job_finish(job->sent ? KVS_OP_DISCARD : 0);
            return;
        }
        job->tokens = tokens; job->bytes = bytes;
        kvs_job_finish(KVS_OP_SAVE_COMMIT);
        return;
    }
    if (verdict == 1) {
        job->outcome = KVS_RESTORE_RESTORED; job->tokens = tokens; job->bytes = bytes;
        kvs_job_finish(KVS_OP_RESTORE_TOUCH);
    } else if (verdict == 0 || !job->sent) {
        /* Refused by the server: this file will never restore. Not sent: the file stays. */
        job->outcome = KVS_RESTORE_PREFILL; cstr_copy(job->reason, sizeof job->reason, error);
        kvs_job_finish(verdict == 0 ? KVS_OP_REMOVE : 0);
    } else {
        job->outcome = KVS_RESTORE_UNKNOWN; cstr_copy(job->reason, sizeof job->reason, error);
        kvs_job_finish(0);
    }
}

/* The declared body length of a complete header block, or -1. */
static long kvs_content_length(const char *head, const char *end) {
    static const char name[] = "content-length:";
    for (const char *line = head; line < end; ) {
        size_t i = 0;
        while (i < sizeof name - 1 && line + i < end && tolower((unsigned char)line[i]) == name[i]) i++;
        if (i == sizeof name - 1) {
            char *stop = NULL;
            long value = strtol(line + i, &stop, 10);
            return stop != line + i && value >= 0 ? value : -1;
        }
        const char *next = strstr(line, "\r\n");
        if (!next || next >= end) break;
        line = next + 2;
    }
    return -1;
}

/* One nonblocking exchange; never waits in the owner loop. */
static void kvs_job_http(kvs_job *job) {
    if (job->phase == KVS_PHASE_CONNECT) {
        int writable = resident_socket_wait(job->fd, 1);
        if (!writable && dstudio_now_ms() >= job->connect_deadline) writable = -1;
        if (writable < 0) { kvs_job_reply(job, 0); return; }
        if (!writable) return;
        job->phase = KVS_PHASE_SEND;
    }
    if (job->phase == KVS_PHASE_SEND) {
#ifdef MSG_NOSIGNAL
        int flags = MSG_NOSIGNAL;
#else
        int flags = 0;
#endif
        ssize_t n = send(job->fd, job->http + job->http_sent, job->http_len - job->http_sent, flags);
        if (n < 0 && (errno == EINTR || errno == EAGAIN || errno == EWOULDBLOCK)) return;
        if (n <= 0) { kvs_job_reply(job, 0); return; }
        job->http_sent += (size_t)n;
        if (job->http_sent < job->http_len) return;
        job->sent = 1; job->phase = KVS_PHASE_READ;
    }
    if (!job->response && !(job->response = malloc(KVS_RESPONSE_MAX + 1))) { kvs_job_reply(job, 0); return; }
    for (;;) {
        int readable = resident_socket_wait(job->fd, 0);
        if (readable < 0) { kvs_job_reply(job, 0); return; }
        if (!readable) return;
        ssize_t n = recv(job->fd, job->response + job->response_len, KVS_RESPONSE_MAX - job->response_len, 0);
        if (n < 0 && errno == EINTR) continue;
        if (n < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) return;
        if (n < 0) { kvs_job_reply(job, 0); return; }
        job->response_len += (size_t)n;
        job->response[job->response_len] = '\0';
        if (n > 0 && job->response_len >= KVS_RESPONSE_MAX) { kvs_job_reply(job, 0); return; }
        /* Connection: close; a declared length ends the reply without waiting for it. */
        char *body = strstr(job->response, "\r\n\r\n");
        long declared = body ? kvs_content_length(job->response, body + 2) : -1;
        if (n == 0 || (body && declared >= 0 && job->response_len - (size_t)(body + 4 - job->response) >= (size_t)declared)) {
            kvs_job_reply(job, body != NULL && strlen(job->response) == job->response_len);
            return;
        }
    }
}

static void kvs_store_view(const kvs_op *op) {
    if (op->store_known) { g_kvs.store_known = 1; g_kvs.store_entries = op->store_entries; g_kvs.store_bytes = op->store_bytes; }
    g_kvs.evicted += (unsigned long long)op->evicted; g_kvs.stale_removed += (unsigned long long)op->stale_removed;
}

/* The commit ran; the owner publishes what it means for this engine. */
static void kvs_job_committed(kvs_job *job, const kvs_op *op) {
    const kvs_id *id = &job->request.id;
    long long ms = dstudio_now_ms() - job->started_ms;
    if (!op->ok) { kvs_report_save(id, op->refused ? "refused" : "failed", op->reason, 0, 0, ms); return; }
    g_kvs.saves++;
    kvs_report_save(id, "saved", "", job->tokens, job->bytes, ms);
    if (kvs_job_engine_current(job)) { g_kvs.saved = *id; g_kvs.saved_uses = job->request.uses; g_kvs.saved_valid = 1; }
}


static void kvs_generation_check(void) {
    pid_t resident = resident_ready() && g_resident.spec.kind == RESIDENT_LLAMA ? g_resident.pid : 0;
    unsigned long long generation = resident ? g_resident.launch_task : 0;
    if (resident != g_kvs.resident || generation != g_kvs.generation) {
        g_kvs.resident = resident; g_kvs.generation = generation;
        g_kvs.uses = 0; g_kvs.last_use_ok = 0; g_kvs.turn_ok = 0;
        g_kvs.live_valid = g_kvs.saved_valid = g_kvs.ended = g_kvs.announced = 0;
        if (g_kvs.next_save.valid) kvs_report_save(&g_kvs.next_save.id, "skipped", "the engine was stopped or replaced", 0, 0, 0);
        g_kvs.next_save.valid = g_kvs.next_restore.valid = 0;
    }
    if (g_child != g_kvs.frontend) {
        /* Between two runtimes (a harness among them) the slot may have been
         * used unseen: nothing is assumed about what it or the disk holds. */
        g_kvs.frontend = g_child;
        g_kvs.live_valid = g_kvs.saved_valid = 0;
        g_kvs.ended = g_kvs.announced = g_kvs.turn_ok = g_kvs.turn_failed = 0;
        g_kvs.next_restore.valid = 0;
        g_kvs.restore.first_pending = 0; g_kvs.restore.announced = 1;
    }
}

static void kvs_tick(void) {
    kvs_generation_check();
    kvs_op *op = g_kvs.op;
    if (op) {
        pthread_mutex_lock(&g_kvs_lock);
        int done = op->done;
        pthread_mutex_unlock(&g_kvs_lock);
        if (!done) return;
        pthread_join(op->thread, NULL);
        g_kvs.op = NULL;
        kvs_store_view(op);
        kvs_job *job = g_kvs.job;
        if (job && job->phase == KVS_PHASE_PREPARE && (op->op == KVS_OP_SAVE_PREPARE || op->op == KVS_OP_RESTORE_PREPARE)) kvs_job_prepared(job, op);
        else if (job && job->phase == KVS_PHASE_FINISH && job->finish_op == -1) {
            if (op->op == KVS_OP_SAVE_COMMIT) kvs_job_committed(job, op);
            kvs_job_free();
        }
        free(op);
    }
    kvs_job *job = g_kvs.job;
    if (job && job->phase > KVS_PHASE_PREPARE && job->phase < KVS_PHASE_FINISH) {
        /* Nothing was sent yet: a save overtaken by a turn or a deletion is simply not asked for. */
        if (job->kind == KVS_SAVE && job->dead && !job->sent && job->phase == KVS_PHASE_CONNECT) {
            kvs_report_save(&job->request.id, "skipped", job->reason, 0, 0, 0);
            kvs_job_finish(0);
        } else kvs_job_http(job);
    }
    job = g_kvs.job;
    if (job && job->phase == KVS_PHASE_FINISH && job->finish_op != -1 && !g_kvs.op) {
        int finish = job->finish_op;
        /* Revalidated at the last moment before publication. */
        if (finish == KVS_OP_SAVE_COMMIT && (job->dead || !kvs_job_engine_current(job))) {
            kvs_report_save(&job->request.id, "discarded", job->dead ? job->reason : "the engine was stopped or replaced", 0, 0,
                            dstudio_now_ms() - job->started_ms);
            finish = KVS_OP_DISCARD;
        }
        if (!finish) kvs_job_free();
        else {
            kvs_op *next = kvs_op_for_job(job, finish);
            if (next && kvs_op_start(next)) job->finish_op = -1;
            else {
                if (finish == KVS_OP_SAVE_COMMIT) kvs_report_save(&job->request.id, "failed", "the snapshot worker could not start", 0, 0, 0);
                kvs_job_free();
            }
        }
    }
    if (g_kvs.op || g_kvs.job) return;
    /* Removals first: nothing published earlier may outlive its deletion. */
    if (g_kvs.wipe_pending || g_kvs.delete_count) {
        char dir[DSTUDIO_PATH_MAX];
        if (!kvs_slot_dir_path(dir, sizeof dir)) { g_kvs.wipe_pending = g_kvs.delete_count = 0; return; }
        kvs_op *removal = kvs_op_new(g_kvs.wipe_pending ? KVS_OP_WIPE : KVS_OP_DELETE, dir);
        if (!removal) return;
        if (g_kvs.wipe_pending) { g_kvs.wipe_pending = 0; g_kvs.delete_count = 0; }
        else {
            removal->mode = g_kvs.deletes[0].mode; memcpy(removal->session, g_kvs.deletes[0].session, 9);
            memmove(g_kvs.deletes, g_kvs.deletes + 1, (size_t)--g_kvs.delete_count * sizeof g_kvs.deletes[0]);
        }
        (void)kvs_op_start(removal);
        return;
    }
    if (g_kvs.next_save.valid) {
        kvs_request request = g_kvs.next_save;
        g_kvs.next_save.valid = 0;
        if (!kvs_engine_current() || g_kvs.uses != request.uses || g_agent_working)
            kvs_report_save(&request.id, "skipped", "the engine is busy with another turn", 0, 0, 0);
        else kvs_job_start(KVS_SAVE, &request);
        return;
    }
    if (g_kvs.next_restore.valid) {
        kvs_request request = g_kvs.next_restore;
        g_kvs.next_restore.valid = 0;
        if (!kvs_engine_current() || request.frontend != g_child || g_kvs.uses != request.uses)
            kvs_report_restore(&request, KVS_RESTORE_PREFILL, "the engine or the runtime changed before the snapshot could be restored", 0, 0, 0);
        else kvs_job_start(KVS_RESTORE, &request);
    }
}

static int kvs_pollfds(struct pollfd *fds) {
    kvs_job *job = g_kvs.job;
    if (!job || job->fd < 0 || job->phase < KVS_PHASE_CONNECT || job->phase > KVS_PHASE_READ) return 0;
    fds[0] = (struct pollfd){.fd = job->fd, .events = job->phase == KVS_PHASE_READ ? POLLIN : POLLOUT};
    return 1;
}

/* A worker pass or a held request ends without a descriptor event. */
static int kvs_hold_model_request(void);
static int kvs_fast_tick(void) {
    return g_kvs.op != NULL || (g_kvs.job && g_kvs.job->phase == KVS_PHASE_FINISH) ||
           g_kvs.wipe_pending || g_kvs.delete_count || g_kvs.next_save.valid || g_kvs.next_restore.valid;
}

/* The first completion of a restored session waits for that session's
 * restore, and for nothing else: a save never holds a turn. */
static int kvs_hold_model_request(void) {
    kvs_job *job = g_kvs.job;
    return g_kvs.next_restore.valid || (job && job->kind == KVS_RESTORE && job->phase < KVS_PHASE_FINISH);
}

static void kvs_request_save(const kvs_id *id, long long messages) {
    kvs_request request = {.valid = 1, .id = *id, .messages = messages, .uses = g_kvs.uses, .frontend = g_child};
    g_kvs.save_requests++;
    if (g_kvs.job || g_kvs.op || g_kvs.wipe_pending || g_kvs.delete_count) {
        /* One exchange per engine; the newest queued request is the only one worth sending. */
        if (g_kvs.next_save.valid) {
            g_kvs.superseded++;
            kvs_report_save(&g_kvs.next_save.id, "skipped", "superseded by a newer snapshot request", 0, 0, 0);
        }
        g_kvs.next_save = request;
        return;
    }
    kvs_job_start(KVS_SAVE, &request);
}

/* Both the announcement and the end of the turn are in, in either order. */
static void kvs_consider_save(void) {
    if (!g_kvs.announced || !g_kvs.ended || g_agent_working) return;
    kvs_id id = g_kvs.announced_id;
    long long messages = g_kvs.announced_messages;
    g_kvs.announced = 0;
    if (!kvs_engine_current() || g_kvs.ended_uses != g_kvs.uses) return;
    if (g_kvs.ended_interrupted) { kvs_report_save(&id, "skipped", "the turn was interrupted", 0, 0, 0); return; }
    if (g_kvs.ended_failed) { kvs_report_save(&id, "skipped", "the turn failed", 0, 0, 0); return; }
    if (g_kvs.ended_ok > 0 && g_kvs.last_use_ok) { g_kvs.live = id; g_kvs.live_uses = g_kvs.uses; g_kvs.live_valid = 1; }
    if (!g_kvs.live_valid || g_kvs.live_uses != g_kvs.uses || !kvs_id_same(&g_kvs.live, &id)) {
        kvs_report_save(&id, "skipped", "the slot does not hold this session's last completed turn", 0, 0, 0); return;
    }
    if (g_kvs.saved_valid && g_kvs.saved_uses == g_kvs.uses && kvs_id_same(&g_kvs.saved, &id)) {
        kvs_report_save(&id, "skipped", "unchanged since the last snapshot", 0, 0, 0); return;
    }
    kvs_job *job = g_kvs.job;
    if (job && job->kind == KVS_SAVE && !job->dead && job->request.uses == g_kvs.uses && kvs_id_same(&job->request.id, &id)) {
        kvs_report_save(&id, "skipped", "this state is already being saved", 0, 0, 0); return;
    }
    kvs_request_save(&id, messages);
}

static void kvs_request_restore(const kvs_id *id, long long messages) {
    kvs_request request = {.valid = 1, .id = *id, .messages = messages, .uses = g_kvs.uses, .frontend = g_child,
                           .token = ++g_kvs.restore_token};
    g_kvs.restore_requests++;
    if (g_kvs.next_restore.valid) { g_kvs.superseded++; g_kvs.next_restore.valid = 0; }
    if (g_kvs.live_valid && g_kvs.live_uses == g_kvs.uses && kvs_id_same(&g_kvs.live, id)) {
        kvs_report_restore(&request, KVS_RESTORE_LIVE, "", 0, 0, 0); return;
    }
    if (g_kvs.job || g_kvs.op || g_kvs.wipe_pending || g_kvs.delete_count || g_kvs.next_save.valid) { g_kvs.next_restore = request; return; }
    kvs_job_start(KVS_RESTORE, &request);
}

static void kvs_delete_id(const kvs_id *id) {
    kvs_job *job = g_kvs.job;
    if (job && kvs_id_same(&job->request.id, id)) { job->dead = 1; cstr_copy(job->reason, sizeof job->reason, "the session was deleted"); }
    if (g_kvs.next_save.valid && kvs_id_same(&g_kvs.next_save.id, id)) g_kvs.next_save.valid = 0;
    if (g_kvs.saved_valid && kvs_id_same(&g_kvs.saved, id)) g_kvs.saved_valid = 0;
    for (int i = 0; i < g_kvs.delete_count; i++) if (kvs_id_same(&g_kvs.deletes[i], id)) return;
    if (g_kvs.delete_count == KVS_DELETE_MAX) {
        /* Overload: the orphan stays bounded by the store limits and eviction. */
        g_kvs.deletes_dropped++;
        dstudio_log_event("warn", "kv-snapshot", 0, "deletion queue full; snapshot of %s %s left to eviction", kvs_mode_name(id->mode), id->session);
        return;
    }
    g_kvs.deletes[g_kvs.delete_count++] = *id;
}

/* The conversation was deleted (the UI's request, or the runtime's receipt). */
static void kvs_delete_session(int mode, const char *session) {
    kvs_id id = {.mode = kvs_mode_letter(mode)};
    if (!id.mode || !kvs_session_canonical(session, id.session)) return;
    kvs_delete_id(&id);
}

/* History was wiped: no snapshot of any session survives, whatever engine runs. */
static void kvs_wipe(void) {
    kvs_job *job = g_kvs.job;
    if (job) { job->dead = 1; cstr_copy(job->reason, sizeof job->reason, "the history was wiped"); }
    g_kvs.next_save.valid = 0; g_kvs.saved_valid = 0; g_kvs.delete_count = 0;
    g_kvs.wipe_pending = 1; g_kvs.wipe_epoch++;
}

/* A complete line of the running runtime: Design announces on stderr,
 * Agent and Cowork on stdout, and neither is read on the other stream. */
static void kvs_runtime_line(const char *line, int is_err) {
    kvs_id id;
    long long messages;
    const int design = g_mode == ENGINE_DESIGN;
    if (design != (is_err != 0) || !(id.mode = kvs_mode_letter(g_mode))) return;
    int kind = kvs_parse_line(line, design, id.session, &messages);
    if (!kind) return;
    if (kind == KVS_LINE_DELETED) { kvs_delete_id(&id); return; }
    if (!kvs_engine_current()) return;
    if (kind == KVS_LINE_RESTORED) { kvs_request_restore(&id, messages); return; }
    g_kvs.announced = 1; g_kvs.announced_id = id; g_kvs.announced_messages = messages;
    kvs_consider_save();
}

static void kvs_turn_failed(void) { g_kvs.turn_failed = 1; }

/* +DWARFSTAR_WAITING: the runtime is idle again. */
static void kvs_turn_end(int interrupted) {
    g_kvs.ended = 1; g_kvs.ended_interrupted = interrupted; g_kvs.ended_failed = g_kvs.turn_failed;
    g_kvs.ended_ok = g_kvs.turn_ok; g_kvs.ended_uses = g_kvs.uses;
    g_kvs.turn_ok = 0; g_kvs.turn_failed = 0;
    kvs_consider_save();
}

/* A completion is about to reach the owned server: through the host relay
 * (relayed) or the /v1 proxy. From here the slot is being rewritten. */
static void kvs_completion_admitted(int relayed) {
    kvs_job *job = g_kvs.job;
    g_kvs.uses++; g_kvs.last_use_ok = 0; g_kvs.ended = 0;
    if (job && job->kind == KVS_SAVE && !job->dead && job->phase < KVS_PHASE_FINISH) {
        job->dead = 1; cstr_copy(job->reason, sizeof job->reason, "the engine is busy with another turn");
    }
    if (g_kvs.next_save.valid) {
        kvs_report_save(&g_kvs.next_save.id, "skipped", "the engine is busy with another turn", 0, 0, 0);
        g_kvs.next_save.valid = 0;
    }
    g_kvs.announced = 0; /* an announcement of an earlier turn describes another state */
    kvs_restore_report *report = &g_kvs.restore;
    if (!report->outcome || report->announced || report->frontend != g_child) return;
    if (!relayed) {
        /* Another client reached the slot first: what this session's turn finds is not known. */
        report->outcome = KVS_RESTORE_UNKNOWN;
        cstr_copy(report->reason, sizeof report->reason, "another client used the model before this session's first turn");
        return;
    }
    /* Turn metadata: once, with the first completion this decision applies to. */
    char text[160], line[256];
    report->announced = 1; report->first_pending = 1;
    kvs_restore_text(report->outcome, report->tokens, 0, 0, text, sizeof text);
    if (g_active_turn_task) task_add_event(g_active_turn_task, "kv-snapshot", text);
    int n = snprintf(line, sizeof line, "\x1e{\"type\":\"status\",\"state\":\"kv_snapshot\",\"outcome\":\"%s\",\"tokens\":%lld}\n",
                     kvs_restore_name(report->outcome, 0, 0), report->tokens);
    /* Only on a line boundary: never inside text the runtime is still printing. */
    if (n > 0 && (size_t)n < sizeof line && g_abuf && (g_alen == g_abase || g_abuf[g_alen - g_abase - 1] == '\n')) agent_buf_append(line, (size_t)n);
}

/* The relay's terminal receipt for a completion of the owned server. */
static void kvs_completion_final(const char *frame) {
    long cache = -1, prompt = -1;
    int ok = strstr(frame, "\"type\":\"model_done\"") != NULL;
    g_kvs.last_use_ok = ok;
    if (ok) g_kvs.turn_ok++;
    kvs_restore_report *report = &g_kvs.restore;
    if (!report->first_pending) return;
    report->first_pending = 0;
    if (ok && json_get_int(frame, "cacheTokens", 0, INT_MAX, &cache) > 0 && json_get_int(frame, "promptTokens", 0, INT_MAX, &prompt) > 0) {
        char text[160];
        report->evidence = 1; report->cache_tokens = cache; report->prompt_tokens = prompt;
        kvs_restore_text(report->outcome, report->tokens, 1, cache, text, sizeof text);
        if (g_active_turn_task && report->outcome == KVS_RESTORE_RESTORED && cache == 0) task_add_event(g_active_turn_task, "kv-snapshot", text);
    }
}

static void kvs_status_id(json_dyn_buf *out, const kvs_id *id) {
    json_dyn_printf(out, "\"mode\":\"%s\",\"session\":\"%s\"", kvs_mode_name(id->mode), id->session);
}

static void kvs_status_json(json_dyn_buf *out) {
    kvs_limits limits = kvs_limits_now();
    kvs_job *job = g_kvs.job;
    const int engine = resident_ready() && g_resident.spec.kind == RESIDENT_LLAMA;
    const char *reason = !limits.enabled ? "off by default (not yet verified on real weights): set DSTUDIO_LLAMA_KV_SNAPSHOTS=1"
        : limits.max_bytes <= 0 ? "disabled: DSTUDIO_LLAMA_KV_MAX_BYTES is 0"
        : !engine ? "no llama.cpp model is running"
        : !g_resident.slot_dir[0] ? "the snapshot directory could not be prepared when the engine started" : "";
    json_dyn_printf(out, "{\"enabled\":%s,\"reason\":", reason[0] ? "false" : "true");
    json_dyn_put_escaped(out, reason);
    json_dyn_printf(out, ",\"activity\":\"%s\",\"holdingModelRequest\":%s",
                    !job ? "idle" : job->kind == KVS_SAVE ? "saving" : "restoring",
                    g_model_rpc && g_model_rpc->held ? "true" : "false");
    json_dyn_puts(out, ",\"lastSave\":");
    if (!g_kvs.save.seq) json_dyn_puts(out, "null");
    else {
        json_dyn_printf(out, "{\"seq\":%llu,", g_kvs.save.seq);
        kvs_status_id(out, &g_kvs.save.id);
        json_dyn_printf(out, ",\"outcome\":\"%s\",\"reason\":", g_kvs.save.outcome);
        json_dyn_put_escaped(out, g_kvs.save.reason);
        json_dyn_printf(out, ",\"tokens\":%lld,\"bytes\":%lld,\"ms\":%lld}", g_kvs.save.tokens, g_kvs.save.bytes, g_kvs.save.ms);
    }
    json_dyn_puts(out, ",\"lastRestore\":");
    const kvs_restore_report *r = &g_kvs.restore;
    if (!r->outcome) json_dyn_puts(out, "null");
    else {
        char text[160];
        kvs_restore_text(r->outcome, r->tokens, r->evidence, r->cache_tokens, text, sizeof text);
        json_dyn_printf(out, "{\"seq\":%llu,", r->seq);
        kvs_status_id(out, &r->id);
        json_dyn_printf(out, ",\"outcome\":\"%s\",\"text\":", kvs_restore_name(r->outcome, r->evidence, r->cache_tokens));
        json_dyn_put_escaped(out, text);
        json_dyn_puts(out, ",\"reason\":");
        json_dyn_put_escaped(out, r->reason);
        json_dyn_printf(out, ",\"tokens\":%lld,\"bytes\":%lld,\"ms\":%lld,\"reportedToTurn\":%s,\"firstCompletion\":",
                        r->tokens, r->bytes, r->ms, r->announced && r->outcome ? "true" : "false");
        if (r->evidence) json_dyn_printf(out, "{\"cacheTokens\":%lld,\"promptTokens\":%lld}}", r->cache_tokens, r->prompt_tokens);
        else json_dyn_puts(out, "null}");
    }
    json_dyn_printf(out, ",\"store\":{\"known\":%s,\"entries\":%d,\"bytes\":%lld,\"maxBytes\":%lld,\"maxEntries\":%d,\"minFreeBytes\":%lld}",
                    g_kvs.store_known ? "true" : "false", g_kvs.store_entries, g_kvs.store_bytes,
                    limits.max_bytes, limits.max_entries, limits.min_free);
    json_dyn_printf(out, ",\"counters\":{\"saveRequests\":%llu,\"saved\":%llu,\"restoreRequests\":%llu,\"restoreOutcomes\":%llu,"
                    "\"superseded\":%llu,\"evicted\":%llu,\"staleRemoved\":%llu,\"deletionsDropped\":%d}}",
                    g_kvs.save_requests, g_kvs.saves, g_kvs.restore_requests, g_kvs.restores,
                    g_kvs.superseded, g_kvs.evicted, g_kvs.stale_removed, g_kvs.deletes_dropped);
}

/* A worker pass still running at exit dies with the process: whatever it
 * left is a partial file or a slot without its record, removed by the next scan. */
static void kvs_shutdown(void) {
    if (g_kvs.job && g_kvs.job->fd >= 0) { close(g_kvs.job->fd); g_kvs.job->fd = -1; }
}
#endif

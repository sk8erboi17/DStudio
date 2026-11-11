/* Production decisions of the llama-server slot snapshot store
 * (src/dstudio_kv_snapshot.c): session and file names, the runtime lines that
 * announce a durable transcript, the key, the sidecar record, admission,
 * eviction order, the disk margin, the server's replies and what a restore is
 * reported as. No process, file, network or model.
 *
 *   llama_kv_snapshot_unit                 run the checks
 *   llama_kv_snapshot_unit --parse-lines agent|design
 *                                          classify each stdin line with the
 *                                          production parser (one JSON object
 *                                          per line), for output captured from
 *                                          the real runtimes: an Agent/Cowork
 *                                          stdout, or a Design stderr */
#define _GNU_SOURCE
#include <assert.h>
#define main dstudio_embedded_main_for_tests
#include "../../src/dstudio.c"
#undef main

static kvs_key_inputs key_inputs(void) {
    kvs_key_inputs k = {0};
    cstr_copy(k.build_info, sizeof k.build_info, RESIDENT_BUILD_INFO);
    memset(k.build_id, 'a', 64); memset(k.commit, 'b', 40); memset(k.binary_sha256, 'c', 64); memset(k.args_identity, 'd', 64);
    cstr_copy(k.model_identity, sizeof k.model_identity, "16777233:4242:1234567890:1790000000:5:1790000001:6");
    cstr_copy(k.model_id, sizeof k.model_id, "qwen3.6-35b-a3b");
    k.ctx = 65536;
    return k;
}

static int digest_differs(const kvs_key_inputs *changed, char mode, const char *session, const char *reference) {
    char digest[65];
    return kvs_key_digest(changed, mode, session, digest) && strcmp(digest, reference);
}

static int line_kind(const char *line, int design, const char *session, long long messages) {
    char got[9]; long long count;
    int kind = kvs_parse_line(line, design, got, &count);
    if (kind && session) assert(!strcmp(got, session) && count == messages);
    return kind;
}

static int parse_lines(int design) {
    char line[1024];
    while (fgets(line, sizeof line, stdin)) {
        char session[9]; long long messages;
        line[strcspn(line, "\n")] = '\0';
        int kind = kvs_parse_line(line, design, session, &messages);
        printf("{\"kind\":\"%s\",\"session\":\"%s\",\"messages\":%lld}\n",
               kind == KVS_LINE_SAVED ? "saved" : kind == KVS_LINE_RESTORED ? "restored" : kind == KVS_LINE_DELETED ? "deleted" : "none",
               session, messages);
    }
    return 0;
}

int main(int argc, char **argv) {
    if (argc == 3 && !strcmp(argv[1], "--parse-lines") && (!strcmp(argv[2], "agent") || !strcmp(argv[2], "design")))
        return parse_lines(!strcmp(argv[2], "design"));
    char text[KVS_SIDECAR_MAX], name[KVS_NAME_MAX], session[9], digest16[17], mode;
    const char *suffix;

    /* Session ids: the eight hex digits the runtimes announce; a full id is
     * the same session; nothing else becomes part of a file name. */
    assert(kvs_session_canonical("1a2b3c4d", session) && !strcmp(session, "1a2b3c4d"));
    assert(kvs_session_canonical("1A2B3C4D5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b", session) && !strcmp(session, "1a2b3c4d"));
    assert(!kvs_session_canonical("1a2b3c4", session) && !kvs_session_canonical("", session) && !kvs_session_canonical(NULL, session));
    assert(!kvs_session_canonical("../../ab", session) && !kvs_session_canonical("1a2b3c4g", session));
    assert(!kvs_session_canonical("1a2b3c4d/", session) && !kvs_session_canonical("1a2b3c4d.slot", session));
    assert(!kvs_session_canonical("1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b0", session)); /* 41 digits */

    /* File names: built from validated parts, and only such names are parsed. */
    const char *digest = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    assert(kvs_name_build(name, sizeof name, 'a', "1a2b3c4d", digest, ".slot") && !strcmp(name, "a-1a2b3c4d-0123456789abcdef.slot"));
    assert(kvs_name_parse(name, &mode, session, digest16, &suffix) && mode == 'a' && !strcmp(session, "1a2b3c4d") &&
           !strcmp(digest16, "0123456789abcdef") && !strcmp(suffix, ".slot"));
    assert(kvs_name_build(name, sizeof name, 'd', "1a2b3c4d", digest, ".part") && kvs_name_parse(name, &mode, session, digest16, &suffix));
    assert(!kvs_name_build(name, sizeof name, 'x', "1a2b3c4d", digest, ".slot"));      /* unknown runtime */
    assert(!kvs_name_build(name, sizeof name, 'a', "../../..", digest, ".slot"));      /* traversal */
    assert(!kvs_name_build(name, sizeof name, 'a', "1a2b3c4", digest, ".slot"));
    assert(!kvs_name_build(name, sizeof name, 'a', "1A2B3C4D", digest, ".slot"));
    assert(!kvs_name_build(name, sizeof name, 'a', "1a2b3c4d", "0123/56789abcdef", ".slot"));
    assert(!kvs_name_build(name, sizeof name, 'a', "1a2b3c4d", digest, ".gguf"));
    assert(!kvs_name_build(name, sizeof name, 'a', "1a2b3c4d", digest, "/../x"));
    assert(!kvs_name_build(name, 10, 'a', "1a2b3c4d", digest, ".slot"));               /* no truncated name */
    const char *foreign[] = {"", ".", "..", "a-1a2b3c4d-0123456789abcdef.slot.bak", "a-1a2b3c4d-0123456789abcdeg.slot",
        "x-1a2b3c4d-0123456789abcdef.slot", "a_1a2b3c4d-0123456789abcdef.slot", "A-1a2b3c4d-0123456789abcdef.slot",
        "a-1a2b3c4d-0123456789abcdef.SLOT", "a-1a2b3c4d-0123456789abcde/.slot", "victim.slot", "ds4-kv", NULL};
    for (int i = 0; foreign[i]; i++) assert(!kvs_name_parse(foreign[i], &mode, session, digest16, &suffix));
    assert(!kvs_name_parse(NULL, &mode, session, digest16, &suffix));

    /* The exact stdout lines of the native Agent/Cowork runtime. */
    assert(line_kind("saved session 1a2b3c4d (7 messages)", 0, "1a2b3c4d", 7) == KVS_LINE_SAVED);
    assert(line_kind("switched to session 1a2b3c4d (7 messages restored; the model server reads them again on the next turn)", 0, "1a2b3c4d", 7) == KVS_LINE_RESTORED);
    assert(line_kind("deleted session 1a2b3c4d", 0, "1a2b3c4d", -1) == KVS_LINE_DELETED);
    /* The exact stderr markers of the Design runtime. */
    assert(line_kind("+DSTUDIO_SESSION_SAVED 1a2b3c4d 4", 1, "1a2b3c4d", 4) == KVS_LINE_SAVED);
    assert(line_kind("+DSTUDIO_SESSION_RESTORED 1a2b3c4d 4", 1, "1a2b3c4d", 4) == KVS_LINE_RESTORED);
    assert(line_kind("+DSTUDIO_SESSION_DELETED 1a2b3c4d", 1, "1a2b3c4d", -1) == KVS_LINE_DELETED);
    /* Each runtime has one form: a Design stream never yields an Agent line
     * (its prose is on stdout and may say anything), nor the reverse. */
    assert(line_kind("saved session 1a2b3c4d (7 messages)", 1, NULL, 0) == KVS_LINE_NONE);
    assert(line_kind("switched to session 1a2b3c4d (7 messages restored; x)", 1, NULL, 0) == KVS_LINE_NONE);
    assert(line_kind("deleted session 1a2b3c4d", 1, NULL, 0) == KVS_LINE_NONE);
    assert(line_kind("+DSTUDIO_SESSION_SAVED 1a2b3c4d 4", 0, NULL, 0) == KVS_LINE_NONE);
    assert(line_kind("+DSTUDIO_SESSION_DELETED 1a2b3c4d", 0, NULL, 0) == KVS_LINE_NONE);
    const char *not_markers[] = {"+DSTUDIO_SESSION_SAVED 1a2b3c4d", "+DSTUDIO_SESSION_SAVED 1a2b3c4d 4 5", "+DSTUDIO_SESSION_SAVED 1A2B3C4D 4",
        "+DSTUDIO_SESSION_SAVED ../../ab 4", " +DSTUDIO_SESSION_SAVED 1a2b3c4d 4", "x +DSTUDIO_SESSION_SAVED 1a2b3c4d 4",
        "+DSTUDIO_SESSION_SAVED 1a2b3c4d -4", "+DSTUDIO_SESSION_SAVED 1a2b3c4d5 4", "+DSTUDIO_SESSION_RESTORED 1a2b3c4d",
        "+DSTUDIO_SESSION_DELETED 1a2b3c4d 4", "+DSTUDIO_SESSION_DELETED", "+DSTUDIO_SESSION_WIPED 1a2b3c4d", "+DWARFSTAR_WAITING", "+DSTUDIO_TURN_ERROR", "", NULL};
    for (int i = 0; not_markers[i]; i++) assert(line_kind(not_markers[i], 1, NULL, 0) == KVS_LINE_NONE);
    /* Not Agent announcements: other units, prose around the words, other ids, failures. */
    const char *not_lines[] = {
        "saved session 1a2b3c4d (7 tokens)",                          /* a native ds4 KV checkpoint, another mechanism */
        "The agent saved session 1a2b3c4d (7 messages)", "saved session 1a2b3c4d (7 messages) and more",
        " saved session 1a2b3c4d (7 messages)", "saved session 1A2B3C4D (7 messages)", "saved session 1a2b3c4 (7 messages)",
        "saved session ../../../x (7 messages)", "saved session 1a2b3c4d5 (7 messages)", "saved session 1a2b3c4d (-7 messages)",
        "saved session 1a2b3c4d ( messages)", "saved session 1a2b3c4d (7777777777 messages)",
        "switched to session 1a2b3c4d (7 messages restored", "switched to session 1a2b3c4d", "switch failed: session 1a2b3c4d is damaged",
        "deleted session 1a2b3c4d now", "delete failed: no saved session matches 1a2b3c4d", "save failed: could not write the remote session transcript",
        "\x1e{\"type\":\"session_status\",\"level\":\"info\",\"message\":\"switched to 1a2b3c4d (4 messages restored)\"}",  /* a UI event, not a line */
        "\x1e{\"type\":\"text\",\"text\":\"saved session 1a2b3c4d (7 messages)\"}", "", NULL};
    for (int i = 0; not_lines[i]; i++) assert(line_kind(not_lines[i], 0, NULL, 0) == KVS_LINE_NONE);

    /* The key: every input changes it; an incomplete identity has none. */
    kvs_key_inputs base = key_inputs(), k;
    char reference[65], again[65];
    assert(kvs_key_digest(&base, 'a', "1a2b3c4d", reference) && strlen(reference) == 64 && kvs_hex_ok(reference, 64));
    assert(kvs_key_digest(&base, 'a', "1a2b3c4d", again) && !strcmp(reference, again));
    k = base; k.model_identity[0] = '2'; assert(digest_differs(&k, 'a', "1a2b3c4d", reference));       /* another device/inode/size/time */
    k = base; cstr_copy(k.vision_identity, sizeof k.vision_identity, "1:2:3:4:5:6:7"); assert(digest_differs(&k, 'a', "1a2b3c4d", reference));
    k = base; k.build_id[0] = 'f'; assert(digest_differs(&k, 'a', "1a2b3c4d", reference));
    k = base; k.commit[0] = 'f'; assert(digest_differs(&k, 'a', "1a2b3c4d", reference));
    k = base; k.binary_sha256[0] = 'f'; assert(digest_differs(&k, 'a', "1a2b3c4d", reference));
    k = base; cstr_copy(k.build_info, sizeof k.build_info, "b11999-0000000"); assert(digest_differs(&k, 'a', "1a2b3c4d", reference));
    k = base; k.ctx = 32768; assert(digest_differs(&k, 'a', "1a2b3c4d", reference));
    k = base; cstr_copy(k.model_id, sizeof k.model_id, "qwen3.8-27b"); assert(digest_differs(&k, 'a', "1a2b3c4d", reference));
    k = base; k.args_identity[0] = 'f'; assert(digest_differs(&k, 'a', "1a2b3c4d", reference));
    assert(digest_differs(&base, 'c', "1a2b3c4d", reference));                                         /* another runtime's session */
    assert(digest_differs(&base, 'a', "1a2b3c4e", reference));
    k = base; k.model_identity[0] = '\0'; assert(!kvs_key_digest(&k, 'a', "1a2b3c4d", again));
    k = base; cstr_copy(k.model_identity, sizeof k.model_identity, "missing"); assert(!kvs_key_digest(&k, 'a', "1a2b3c4d", again));
    k = base; cstr_copy(k.vision_identity, sizeof k.vision_identity, "missing"); assert(!kvs_key_digest(&k, 'a', "1a2b3c4d", again));
    k = base; k.build_id[10] = '\0'; assert(!kvs_key_digest(&k, 'a', "1a2b3c4d", again));                /* no receipt build */
    k = base; k.build_id[3] = 'Z'; assert(!kvs_key_digest(&k, 'a', "1a2b3c4d", again));
    k = base; k.ctx = 0; assert(!kvs_key_digest(&k, 'a', "1a2b3c4d", again));
    k = base; cstr_copy(k.model_id, sizeof k.model_id, "alias\nmodel=other"); assert(!kvs_key_digest(&k, 'a', "1a2b3c4d", again)); /* no field forges another */
    assert(!kvs_key_digest(&base, 'x', "1a2b3c4d", again) && !kvs_key_digest(&base, 'a', "../../..", again));

    /* The arguments identity ignores where the server listens and writes
     * snapshots, and nothing else. */
    char *args_a[] = {"--model", "/m/a.gguf", "--alias", "q", "--ctx-size", "65536", "--jinja", "--host", "127.0.0.1", "--port", "28000", "--slot-save-path", "/kv/a", NULL};
    char *args_b[] = {"--model", "/m/a.gguf", "--alias", "q", "--ctx-size", "65536", "--jinja", "--host", "127.0.0.1", "--port", "29999", "--slot-save-path", "/kv/b", NULL};
    char *args_c[] = {"--model", "/m/a.gguf", "--alias", "q", "--ctx-size", "65536", "--host", "127.0.0.1", "--port", "28000", "--slot-save-path", "/kv/a", NULL};
    char *args_d[] = {"--model", "/m/a.gguf", "--alias", "q", "--ctx-size", "65536", "--jinja", "--mmproj", "/m/p.gguf", "--port", "28000", NULL};
    char *args_e[] = {"--model", "/m/a.ggufx", "--alias", "q", "--ctx-size", "65536", "--jinja", "--port", "28000", NULL};
    char ia[65], ib[65], ic[65], id[65], ie[65];
    kvs_args_identity(args_a, ia); kvs_args_identity(args_b, ib); kvs_args_identity(args_c, ic); kvs_args_identity(args_d, id); kvs_args_identity(args_e, ie);
    assert(!strcmp(ia, ib) && strcmp(ia, ic) && strcmp(ia, id) && strcmp(ia, ie) && strcmp(id, ie));

    /* The production launch offers the slot directory to llama-server only,
     * and only when one was prepared. */
    {
        resident_launch_spec spec = {0}; resident_paths rp = {0}; char *argv_llama[40];
        spec.kind = RESIDENT_LLAMA; cstr_copy(spec.model_id, sizeof spec.model_id, "qwen3.6-35b-a3b");
        cstr_copy(rp.model, sizeof rp.model, "/m/ds4/gguf/model.gguf"); cstr_copy(rp.context, sizeof rp.context, "65536"); cstr_copy(rp.port, sizeof rp.port, "28000");
        int n = resident_server_args(&spec, &rp, argv_llama, 0), slots = 0, parallel = 0;
        for (int i = 0; i < n; i++) { slots += !strcmp(argv_llama[i], "--slot-save-path"); parallel += !strcmp(argv_llama[i], "--parallel") && !strcmp(argv_llama[i + 1], "1"); }
        assert(n > 0 && !argv_llama[n] && !slots && parallel == 1);
        cstr_copy(rp.slots, sizeof rp.slots, "/kv/llama-slots");
        int m = resident_server_args(&spec, &rp, argv_llama, 0);
        assert(m == n + 2 && !argv_llama[m] && !strcmp(argv_llama[m - 2], "--slot-save-path") && !strcmp(argv_llama[m - 1], "/kv/llama-slots"));
        char with[65], without[65];
        kvs_args_identity(argv_llama, with);
        rp.slots[0] = '\0'; resident_server_args(&spec, &rp, argv_llama, 0); kvs_args_identity(argv_llama, without);
        assert(!strcmp(with, without));                               /* moving the store does not invalidate it */
        spec.kind = RESIDENT_MLX; cstr_copy(rp.slots, sizeof rp.slots, "/kv/llama-slots");
        n = resident_server_args(&spec, &rp, argv_llama, 0);
        for (int i = 0; i < n; i++) assert(strcmp(argv_llama[i], "--slot-save-path"));   /* MLX is unchanged */
    }

    /* The record: explicit fields, complete or refused. */
    kvs_sidecar record = {0}, parsed;
    record.mode = 'c'; cstr_copy(record.session, sizeof record.session, "1a2b3c4d"); memcpy(record.digest, reference, 65);
    record.tokens = 51234; record.bytes = 6442450944LL; record.messages = 12; record.seq = 9; record.saved_ms = 1794000000000LL;
    assert(kvs_sidecar_encode(&record, text, sizeof text));
    assert(kvs_sidecar_parse(text, strlen(text), &parsed) && parsed.mode == 'c' && !strcmp(parsed.session, "1a2b3c4d") &&
           !strcmp(parsed.digest, reference) && parsed.tokens == 51234 && parsed.bytes == 6442450944LL && parsed.messages == 12 &&
           parsed.seq == 9 && parsed.saved_ms == 1794000000000LL);
    assert(!kvs_sidecar_encode(&record, text, 40));
    record.bytes = 0; assert(!kvs_sidecar_encode(&record, text, sizeof text)); record.bytes = 6442450944LL;
    record.session[0] = '.'; assert(!kvs_sidecar_encode(&record, text, sizeof text)); record.session[0] = '1';
    const char *damaged[] = {
        "", "{}", "[]", "{\"format\":\"dstudio.llama-slot.v1\"}",
        "{\"format\":\"dstudio.llama-slot.v0\",\"mode\":\"cowork\",\"session\":\"1a2b3c4d\",\"keyDigest\":\"%s\",\"tokens\":1,\"bytes\":1,\"messages\":1,\"seq\":1,\"savedAtMs\":1}",
        "{\"format\":\"dstudio.llama-slot.v1\",\"mode\":\"chat\",\"session\":\"1a2b3c4d\",\"keyDigest\":\"%s\",\"tokens\":1,\"bytes\":1,\"messages\":1,\"seq\":1,\"savedAtMs\":1}",
        "{\"format\":\"dstudio.llama-slot.v1\",\"mode\":\"cowork\",\"session\":\"../../ab\",\"keyDigest\":\"%s\",\"tokens\":1,\"bytes\":1,\"messages\":1,\"seq\":1,\"savedAtMs\":1}",
        "{\"format\":\"dstudio.llama-slot.v1\",\"mode\":\"cowork\",\"session\":\"1a2b3c4d\",\"keyDigest\":\"%s\",\"tokens\":-1,\"bytes\":1,\"messages\":1,\"seq\":1,\"savedAtMs\":1}",
        "{\"format\":\"dstudio.llama-slot.v1\",\"mode\":\"cowork\",\"session\":\"1a2b3c4d\",\"keyDigest\":\"%s\",\"tokens\":1,\"bytes\":0,\"messages\":1,\"seq\":1,\"savedAtMs\":1}",
        "{\"format\":\"dstudio.llama-slot.v1\",\"mode\":\"cowork\",\"session\":\"1a2b3c4d\",\"keyDigest\":\"%s\",\"tokens\":1,\"bytes\":\"1\",\"messages\":1,\"seq\":1,\"savedAtMs\":1}",
        "{\"format\":\"dstudio.llama-slot.v1\",\"mode\":\"cowork\",\"session\":\"1a2b3c4d\",\"keyDigest\":\"%s\",\"tokens\":1,\"bytes\":1,\"messages\":1,\"seq\":1}",
        "{\"format\":\"dstudio.llama-slot.v1\",\"mode\":\"cowork\",\"session\":\"1a2b3c4d\",\"keyDigest\":\"%s\",\"tokens\":1,\"bytes\":1,\"bytes\":2,\"messages\":1,\"seq\":1,\"savedAtMs\":1}",
        "{\"format\":\"dstudio.llama-slot.v1\",\"mode\":\"cowork\",\"session\":\"1a2b3c4d\",\"keyDigest\":\"%s\",\"tokens\":1,\"bytes\":1,\"messages\":1,\"seq\":1,\"savedAtMs\":1} trailing",
        "{\"format\":\"dstudio.llama-slot.v1\",\"mode\":\"cowork\",\"session\":\"1a2b3c4d\",\"keyDigest\":\"0123\",\"tokens\":1,\"bytes\":1,\"messages\":1,\"seq\":1,\"savedAtMs\":1}",
        NULL};
    for (int i = 0; damaged[i]; i++) {
        char json[KVS_SIDECAR_MAX];
        snprintf(json, sizeof json, damaged[i], reference);
        assert(!kvs_sidecar_parse(json, strlen(json), &parsed));
    }
    assert(kvs_sidecar_encode(&record, text, sizeof text));
    assert(!kvs_sidecar_parse(text, strlen(text) - 3, &parsed));        /* a length that is not the text's */

    /* Admission: everything matches, or it is a miss with its reason. */
    assert(kvs_admit(&record, 'c', "1a2b3c4d", reference, 6442450944LL, 12) == KVS_ADMIT_OK);
    assert(kvs_admit(&record, 'c', "1a2b3c4d", reference, 6442450944LL, -1) == KVS_ADMIT_OK);       /* a runtime that gives no count */
    char other[65];
    k = base; k.ctx = 32768;
    assert(kvs_key_digest(&k, 'c', "1a2b3c4d", other) && strcmp(other, reference));
    assert(kvs_admit(&record, 'c', "1a2b3c4d", other, 6442450944LL, 12) == KVS_ADMIT_KEY);
    assert(kvs_admit(&record, 'c', "1a2b3c4d", reference, 6442450943LL, 12) == KVS_ADMIT_SIZE);    /* truncated */
    assert(kvs_admit(&record, 'c', "1a2b3c4d", reference, 6442450944LL, 14) == KVS_ADMIT_MESSAGES); /* the transcript moved on */
    assert(kvs_admit(&record, 'a', "1a2b3c4d", reference, 6442450944LL, 12) == KVS_ADMIT_DAMAGED);
    assert(kvs_admit(&record, 'c', "1a2b3c4e", reference, 6442450944LL, 12) == KVS_ADMIT_DAMAGED);
    assert(kvs_admit(NULL, 'c', "1a2b3c4d", reference, 6442450944LL, 12) == KVS_ADMIT_DAMAGED);
    for (int verdict = KVS_ADMIT_DAMAGED; verdict <= KVS_ADMIT_MESSAGES; verdict++) assert(kvs_admit_reason(verdict)[0]);

    /* Eviction: least recently used first, until both limits hold; the entry
     * just written is never the victim. */
    kvs_entry e[5] = {{"a", 100, 5, 0, 0}, {"b", 100, 2, 0, 0}, {"c", 100, 9, 0, 0}, {"d", 100, 1, 0, 0}, {"new", 100, 10, 1, 0}};
    assert(kvs_plan_eviction(e, 5, 500, 64) && !e[0].evict && !e[1].evict && !e[2].evict && !e[3].evict && !e[4].evict);
    assert(kvs_plan_eviction(e, 5, 499, 64) && e[3].evict && !e[0].evict && !e[1].evict && !e[2].evict && !e[4].evict);
    assert(kvs_plan_eviction(e, 5, 300, 64) && e[3].evict && e[1].evict && !e[0].evict && !e[2].evict && !e[4].evict);
    assert(kvs_plan_eviction(e, 5, 100000, 2) && e[3].evict && e[1].evict && e[0].evict && !e[2].evict && !e[4].evict);
    assert(kvs_plan_eviction(e, 5, 100, 64) && e[0].evict && e[1].evict && e[2].evict && e[3].evict && !e[4].evict);
    assert(!kvs_plan_eviction(e, 5, 99, 64) && !e[4].evict);            /* the new entry alone does not fit */
    assert(!kvs_plan_eviction(e, 5, 100000, 0));
    kvs_entry tie[3] = {{"b", 10, 4, 0, 0}, {"a", 10, 4, 0, 0}, {"c", 10, 4, 0, 0}};
    assert(kvs_plan_eviction(tie, 3, 20, 64) && tie[1].evict && !tie[0].evict && !tie[2].evict);   /* equal age: by name */
    assert(kvs_plan_eviction(tie, 0, 0, 1));

    /* The disk margin, plus room for the copy being replaced. */
    assert(kvs_space_ok(100, 50, 50) && kvs_space_ok(100, 50, 0) && kvs_space_ok(LLONG_MAX, 8LL << 30, 30LL << 30));
    assert(!kvs_space_ok(100, 50, 51) && !kvs_space_ok(49, 50, 0) && !kvs_space_ok(-1, 0, 0) && !kvs_space_ok(100, -1, 0));
    assert(!kvs_space_ok(100, LLONG_MAX, 0) && !kvs_space_ok(LLONG_MAX, 1, LLONG_MAX));

    /* The server's replies, in the form the pinned server writes them. */
    long long tokens = -1, bytes = -1; char error[240];
    char saved[] = "HTTP/1.1 200 OK\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: 111\r\n\r\n"
        "{\"id_slot\":0,\"filename\":\"a-1a2b3c4d-0123456789abcdef.part\",\"n_saved\":1745,\"n_written\":14309796,\"timings\":{\"save_ms\":49.865}}";
    assert(kvs_reply_parse(saved, 1, "a-1a2b3c4d-0123456789abcdef.part", &tokens, &bytes, error, sizeof error) == 1 && tokens == 1745 && bytes == 14309796);
    assert(kvs_reply_parse(saved, 1, "a-1a2b3c4d-0123456789abcdee.part", &tokens, &bytes, error, sizeof error) == -1); /* another file's reply */
    assert(kvs_reply_parse(saved, 0, "a-1a2b3c4d-0123456789abcdef.part", &tokens, &bytes, error, sizeof error) == -1); /* not a restore reply */
    char restored[] = "HTTP/1.1 200 OK\r\nContent-Length: 115\r\n\r\n"
        "{\"id_slot\":0,\"filename\":\"a-1a2b3c4d-0123456789abcdef.slot\",\"n_restored\":1745,\"n_read\":6442450944,\"timings\":{\"restore_ms\":42.9}}";
    assert(kvs_reply_parse(restored, 0, "a-1a2b3c4d-0123456789abcdef.slot", &tokens, &bytes, error, sizeof error) == 1 && tokens == 1745 && bytes == 6442450944LL);
    char refused[] = "HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\n\r\n"
        "{\"error\":{\"code\":400,\"message\":\"Unable to restore slot: No available space in KV cache or invalid slot save file\",\"type\":\"invalid_request_error\"}}";
    assert(kvs_reply_parse(refused, 0, "a-1a2b3c4d-0123456789abcdef.slot", &tokens, &bytes, error, sizeof error) == 0);
    assert(strstr(error, "HTTP 400") && strstr(error, "Unable to restore slot"));
    char unsupported[] = "HTTP/1.1 501 Not Implemented\r\n\r\n{\"error\":{\"code\":501,\"message\":\"This server does not support slots action. Start it with `--slot-save-path`\",\"type\":\"not_supported_error\"}}";
    assert(kvs_reply_parse(unsupported, 1, "x", &tokens, &bytes, error, sizeof error) == 0 && strstr(error, "HTTP 501"));
    char chunked[] = "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n6f\r\n{}";
    assert(kvs_reply_parse(chunked, 1, "x", &tokens, &bytes, error, sizeof error) == -1);
    char partial[] = "HTTP/1.1 200 OK\r\nContent-Length: 111\r\n\r\n{\"id_slot\":0,\"filename\":\"a-1a2b";
    assert(kvs_reply_parse(partial, 1, "a-1a2b3c4d-0123456789abcdef.part", &tokens, &bytes, error, sizeof error) == -1);
    char empty_file[] = "HTTP/1.1 200 OK\r\n\r\n{\"id_slot\":0,\"filename\":\"f.part\",\"n_saved\":10,\"n_written\":0}";
    assert(kvs_reply_parse(empty_file, 1, "f.part", &tokens, &bytes, error, sizeof error) == -1);                       /* nothing written */
    char garbage[] = "not http at all";
    assert(kvs_reply_parse(garbage, 1, "x", &tokens, &bytes, error, sizeof error) == -1);
    char head[] = "Host: x\r\ncontent-LENGTH:  42\r\nX: y\r\n\r\n";
    assert(kvs_content_length(head, head + strlen(head) - 2) == 42);
    char no_length[] = "Host: x\r\nX-Content-Length: 7\r\n\r\n";
    assert(kvs_content_length(no_length, no_length + strlen(no_length) - 2) == -1);

    /* What a turn is told. A restored snapshot whose first completion reused
     * nothing was a fresh prefill and is named one. */
    kvs_restore_text(KVS_RESTORE_RESTORED, 51234, 0, 0, text, sizeof text); assert(!strcmp(text, "restored from disk snapshot (51234 tokens)"));
    kvs_restore_text(KVS_RESTORE_RESTORED, 51234, 1, 51200, text, sizeof text); assert(!strcmp(text, "restored from disk snapshot (51234 tokens)"));
    kvs_restore_text(KVS_RESTORE_RESTORED, 51234, 1, 0, text, sizeof text);
    assert(!strncmp(text, "prefilled again", 15) && strstr(text, "not reused") && !strstr(text, "restored from disk snapshot ("));
    kvs_restore_text(KVS_RESTORE_PREFILL, 0, 0, 0, text, sizeof text); assert(!strcmp(text, "prefilled again"));
    kvs_restore_text(KVS_RESTORE_PREFILL, 0, 1, 900, text, sizeof text); assert(!strcmp(text, "prefilled again"));
    kvs_restore_text(KVS_RESTORE_LIVE, 0, 0, 0, text, sizeof text); assert(!strstr(text, "restored") && !strstr(text, "prefilled"));
    kvs_restore_text(KVS_RESTORE_UNKNOWN, 0, 0, 0, text, sizeof text); assert(!strstr(text, "restored from") && !strstr(text, "prefilled"));
    assert(!strcmp(kvs_restore_name(KVS_RESTORE_RESTORED, 0, 0), "restored") && !strcmp(kvs_restore_name(KVS_RESTORE_RESTORED, 1, 7), "restored") &&
           !strcmp(kvs_restore_name(KVS_RESTORE_RESTORED, 1, 0), "restored-not-reused") && !strcmp(kvs_restore_name(KVS_RESTORE_PREFILL, 1, 0), "prefill") &&
           !strcmp(kvs_restore_name(KVS_RESTORE_LIVE, 0, 0), "live") && !strcmp(kvs_restore_name(KVS_RESTORE_UNKNOWN, 0, 0), "unknown"));

    /* Limits from the environment: bounded, and never negative. */
    setenv("DSTUDIO_LLAMA_KV_MAX_BYTES", "1048576", 1); setenv("DSTUDIO_LLAMA_KV_MAX_ENTRIES", "3", 1); setenv("DSTUDIO_LLAMA_KV_MIN_FREE_BYTES", "7", 1);
    kvs_limits limits = kvs_limits_now();
    assert(limits.max_bytes == 1048576 && limits.max_entries == 3 && limits.min_free == 7);
    setenv("DSTUDIO_LLAMA_KV_MAX_BYTES", "-5", 1); setenv("DSTUDIO_LLAMA_KV_MAX_ENTRIES", "0", 1); setenv("DSTUDIO_LLAMA_KV_MIN_FREE_BYTES", "12GB", 1);
    limits = kvs_limits_now();
    assert(limits.max_bytes == KVS_DEFAULT_MAX_BYTES && limits.max_entries == 1 && limits.min_free == KVS_DEFAULT_MIN_FREE);
    setenv("DSTUDIO_LLAMA_KV_MAX_ENTRIES", "999999", 1); assert(kvs_limits_now().max_entries == 1024);
    unsetenv("DSTUDIO_LLAMA_KV_MAX_BYTES"); unsetenv("DSTUDIO_LLAMA_KV_MAX_ENTRIES"); unsetenv("DSTUDIO_LLAMA_KV_MIN_FREE_BYTES");
    limits = kvs_limits_now();
    assert(limits.max_bytes == 32LL * 1024 * 1024 * 1024 && limits.max_entries == 64 && limits.min_free == 8LL * 1024 * 1024 * 1024);
    /* Off unless the opt-in is exactly "1" (not yet verified on real weights);
     * without it no slot directory is prepared for the server. */
    char slots[DSTUDIO_PATH_MAX];
    unsetenv("DSTUDIO_LLAMA_KV_SNAPSHOTS"); assert(!kvs_limits_now().enabled);
    assert(!kvs_slot_dir_prepare(slots, sizeof slots) && !slots[0]);
    const char *not_opt_in[] = {"", "0", "true", "yes", "1 ", " 1", "01", NULL};
    for (int i = 0; not_opt_in[i]; i++) { setenv("DSTUDIO_LLAMA_KV_SNAPSHOTS", not_opt_in[i], 1); assert(!kvs_limits_now().enabled); }
    setenv("DSTUDIO_LLAMA_KV_SNAPSHOTS", "1", 1); assert(kvs_limits_now().enabled);
    unsetenv("DSTUDIO_LLAMA_KV_SNAPSHOTS");

    puts("llama_kv_snapshot_unit: ok (production names, announcements, key, record, admission, eviction, margin, replies, reporting, default off; no process, file or model)");
    return 0;
}

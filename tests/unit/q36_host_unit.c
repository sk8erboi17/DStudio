/* Execute the host's private readiness parser. These are protocol/ownership
 * checks, not source inspection and not model-quality questions. */
#define _GNU_SOURCE
#include <assert.h>
#define main dstudio_embedded_main_for_tests
#include "../../src/dstudio.c"
#undef main

static int checks;
static char *receipt(const char *key, const char *replacement, int omit, const char *tail) {
    const char *keys[] = {"version", "event", "pid", "host", "port", "context", "model", "backend",
        "cache_k", "cache_v", "ssd_streaming", "model_file", "vision_file", "mtp_file"};
    const char *values[] = {"1", "\"ready\"", "4242", "\"127.0.0.1\"", "42001", "8192",
        "\"qwen3.8-27b\"", "\"metal\"", "\"f16\"", "\"f16\"", "false", "\"opened-model\"", "\"opened-projector\"", "\"\""};
    json_dyn_buf b = {0}; assert(json_dyn_puts(&b, "{")); int emitted = 0;
    for (size_t i = 0; i < sizeof keys / sizeof keys[0]; i++) {
        int match = key && !strcmp(key, keys[i]);
        if (match && omit) continue;
        assert(json_dyn_printf(&b, "%s\"%s\":%s", emitted++ ? "," : "", keys[i], match ? replacement : values[i]));
    }
    assert(json_dyn_puts(&b, tail ? tail : "}\n")); return b.ptr;
}
static void check(const char *key, const char *raw, int omit, const char *tail, int expected) {
    char *json = receipt(key, raw, omit, tail);
    int actual = q36_receipt_matches(json);
    if (actual != expected) fprintf(stderr, "case %d: expected %d, got %d: %s\n", checks + 1, expected, actual, json);
    assert(actual == expected); checks++; free(json);
}
int main(void) {
#ifndef _WIN32
    q36_exec_identity identity;
    struct stat synthetic = {.st_mode = S_IFREG | 0755, .st_dev = 5, .st_ino = 6,
        .st_size = 2048, .st_mtime = 100, .st_ctime = 101};
    assert(q36_exec_identity_parse("5:6:2048:100:0:101:0", &identity)); checks++;
    assert(q36_exec_identity_matches(&identity, &synthetic)); checks++;
    synthetic.st_size++;
    assert(!q36_exec_identity_matches(&identity, &synthetic)); checks++;
    synthetic.st_size--; synthetic.st_ino++;
    assert(!q36_exec_identity_matches(&identity, &synthetic)); checks++;
    synthetic.st_ino--; synthetic.st_ctime++;
    assert(!q36_exec_identity_matches(&identity, &synthetic)); checks++;
    synthetic.st_ctime--; synthetic.st_mode = S_IFLNK | 0755;
    assert(!q36_exec_identity_matches(&identity, &synthetic)); checks++;
    const char *invalid_identities[] = {"missing", "5:6:-1:100:0:101:0", "5:6:1:100:-1:101:0",
        "5:6:1:100:0:101:1000000000", "5:6:1:100:0:101:0:extra", "5:6:1:100:0:101"};
    for (size_t i = 0; i < sizeof invalid_identities / sizeof *invalid_identities; i++) {
        assert(!q36_exec_identity_parse(invalid_identities[i], &identity)); checks++;
    }
#endif
    g_q36.pid = 4242; g_q36.spec.cfg.ctx = 8192; g_q36.spec.cfg.port = 42001;
    cstr_copy(g_q36.spec.model_identity, sizeof g_q36.spec.model_identity, "opened-model");
    cstr_copy(g_q36.spec.vision_identity, sizeof g_q36.spec.vision_identity, "opened-projector");
    check(NULL, NULL, 0, NULL, 1);
    const char *fields[] = {"version", "event", "pid", "host", "port", "context", "model", "backend",
        "cache_k", "cache_v", "ssd_streaming", "model_file", "vision_file", "mtp_file"};
    for (size_t i = 0; i < sizeof fields / sizeof fields[0]; i++) {
        check(fields[i], "null", 0, NULL, 0);
        check(fields[i], "[]", 0, NULL, 0);
        check(fields[i], NULL, 1, NULL, 0);
    }
    check("version", "\"1\"", 0, NULL, 0);
    check("version", "1.0", 0, NULL, 0);
    check("version", "1e0", 0, NULL, 0);
    check("pid", "4242.5", 0, NULL, 0);
    check("pid", "4243", 0, NULL, 0);
    check("context", "81920", 0, NULL, 0);
    check("port", "42002", 0, NULL, 0);
    check("backend", "\"vulkan\"", 0, NULL, 0);
    check("ssd_streaming", "\"false\"", 0, NULL, 0);
    check("model_file", "\"replaced-model\"", 0, NULL, 0);
    check("vision_file", "\"\"", 0, NULL, 0);
    check("model", "\"qwen3.8-flash-next\"", 0, NULL, 0);
    check(NULL, NULL, 0, ",\"pid\":4242}\n", 0);
    check(NULL, NULL, 0, ",\"p\\u0069d\":4242}\n", 0);
    check(NULL, NULL, 0, ",\"future_field\":1}\n", 0);
    check(NULL, NULL, 0, "}\n{}\n", 0);
    check(NULL, NULL, 0, "", 0);
    check("model_file", "\"opened-model\\u0000other\"", 0, NULL, 0);
    assert(!q36_receipt_matches("{}")); checks++;
    assert(!q36_receipt_matches("[]")); checks++;
    char url[96]; pid_t resident = 0;
    g_q36.launch_task = 71; g_q36.frontend = g_child = 101;
    g_mode = ENGINE_AGENT;
    assert(!q36_rpc_owner(&resident, url, sizeof url)); checks++;
    g_q36.ready = 1;
    assert(q36_rpc_owner(&resident, url, sizeof url) == 71 && resident == 4242 &&
        !strcmp(url, "http://127.0.0.1:42001")); checks++;
    assert(!q36_rpc_current(4243, 71)); checks++;
    assert(!q36_rpc_current(4242, 70)); checks++;
    g_q36.frontend = 102;
    assert(!q36_rpc_current(4242, 71)); checks++;
    g_q36.frontend = 101; g_mode = ENGINE_SERVER;
    assert(!q36_rpc_current(4242, 71)); checks++;
    g_mode = ENGINE_COWORK;
    assert(q36_rpc_current(4242, 71)); checks++;
    g_child_stop_requested = 1;
    assert(!q36_rpc_current(4242, 71)); checks++;
    g_child_stop_requested = 0; g_q36.stopping = 1;
    assert(!q36_rpc_current(4242, 71)); checks++;
    assert(q36_agent_directory("/installation with spaces/q36", url, sizeof url) &&
        !strcmp(url, "/installation with spaces/ds4")); checks++;
    assert(!q36_agent_directory("/another/model", url, sizeof url)); checks++;
    const char *bodies[] = {
        "{\"model\":\"qwen3.8-27b\",\"messages\":[{\"model\":\"other\"}]}",
        "{\"mo\\u0064el\":\"qwen3.8-27b\"}",
        "{\"model\":\"other\"}", "{\"messages\":[{\"model\":\"qwen3.8-27b\"}]}",
        "{\"model\":\"qwen3.8-27b\",\"mo\\u0064el\":\"qwen3.8-27b\"}",
        "{\"model\":\"qwen3.8-27b\\u0000other\"}",
        "{\"model\":{\"model\":\"qwen3.8-27b\"}}", "{\"model\":\"qwen3.8-27b\"}{}"
    };
    for (size_t i = 0; i < sizeof bodies / sizeof *bodies; i++) {
        assert(model_rpc_bound_model(bodies[i], "qwen3.8-27b") == (i < 2)); checks++;
    }
    g_child = -1;
    g_q36.pid = -1;
    printf("q36 host receipt: %d/%d PASS; launch spec %zu bytes, owned runtime %zu bytes (one cold record)\n",
        checks, checks, sizeof(q36_launch_spec), sizeof(q36_owned_runtime));
    return 0;
}

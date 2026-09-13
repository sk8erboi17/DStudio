/* Executes the real HTTP handler with a task-owned pipe-echo process standing
 * in for the current engine. No real weights, model process or network service
 * is touched. Rejected launches must preserve both owner state and liveness. */
#define _GNU_SOURCE
#include <assert.h>
#define main dstudio_embedded_main_for_tests
#include "../../src/dstudio.c"
#undef main

#ifndef _WIN32
static pid_t probe_start(int *input, int *output) {
    int in[2], out[2];
    assert(pipe(in) == 0 && pipe(out) == 0);
    pid_t pid = fork(); assert(pid >= 0);
    if (!pid) {
        close(in[1]); close(out[0]);
        char byte;
        while (read(in[0], &byte, 1) == 1)
            if (write(out[1], &byte, 1) != 1) _exit(1);
        _exit(0);
    }
    close(in[0]); close(out[1]); *input = in[1]; *output = out[0];
    return pid;
}

static int probe_responds(int input, int output) {
    if (write(input, "p", 1) != 1) return 0;
    struct pollfd ready = { .fd = output, .events = POLLIN };
    char response = 0;
    return poll(&ready, 1, 1000) == 1 && read(output, &response, 1) == 1 && response == 'p';
}

static int reject_without_effects(const char *body, const char *label, const char *model,
                                  const char *code, const char *http_status) {
    cstr_copy(g_model_override, sizeof g_model_override, model);
    cstr_copy(g_skill, sizeof g_skill, "existing-skill");
    cstr_copy(g_design_system, sizeof g_design_system, "");
    cstr_copy(g_variant, sizeof g_variant, "flash");
    cstr_copy(g_remote_base_url, sizeof g_remote_base_url, "");
    cstr_copy(g_remote_model, sizeof g_remote_model, "prior-remote-model");
    cstr_copy(g_remote_api_key, sizeof g_remote_api_key, "fixture-not-a-secret");
    cstr_copy(g_stage, sizeof g_stage, "Ready");
    g_cfg = ENGINE_DEFAULTS; g_cfg.ctx = 32768;
    g_mode = ENGINE_SERVER; g_ready = 1;
    g_dspark_enabled = 0; g_metal_hotlist_seed = 0;
    g_ssd_streaming_effective = 1;
    cstr_copy(g_ssd_streaming_reason, sizeof g_ssd_streaming_reason, "existing runtime setting");
    g_steer.count = 1; g_steer.inputs[0].text = strdup("unconfirmed input");
    assert(g_steer.inputs[0].text);
    char *pending = g_steer.inputs[0].text;
    int input, output;
    pid_t pid = probe_start(&input, &output);
    assert(probe_responds(input, output));
    g_child = pid;
    unsigned long long seq = g_task_seq, next_id = g_task_next_id;
    int count = g_task_count;
    engine_cfg original_cfg = g_cfg;
    int sockets[2]; assert(socketpair(AF_UNIX, SOCK_STREAM, 0, sockets) == 0);
    api_start(sockets[0], body);
    shutdown(sockets[0], SHUT_WR); close(sockets[0]);
    char response[8192] = ""; size_t used = 0; ssize_t n;
    while ((n = read(sockets[1], response + used, sizeof response - used - 1)) > 0) {
        used += (size_t)n; assert(used < sizeof response - 1);
    }
    close(sockets[1]);
    int alive = g_child == pid && probe_responds(input, output);
    char expected_code[128]; snprintf(expected_code, sizeof expected_code, "\"code\":\"%s\"", code);
    int rejected = strstr(response, http_status) && strstr(response, "\"ok\":false") &&
        strstr(response, expected_code) && !strstr(response, "\"taskId\"");
    int unchanged = g_mode == ENGINE_SERVER && g_ready == 1 &&
        !strcmp(g_model_override, model) && !strcmp(g_skill, "existing-skill") &&
        !strcmp(g_variant, "flash") && !g_design_system[0] &&
        !strcmp(g_stage, "Ready") && !g_remote_base_url[0] &&
        !strcmp(g_remote_model, "prior-remote-model") &&
        !strcmp(g_remote_api_key, "fixture-not-a-secret") &&
        !memcmp(&g_cfg, &original_cfg, sizeof g_cfg) &&
        !g_dspark_enabled && !g_metal_hotlist_seed &&
        g_ssd_streaming_effective == 1 && !strcmp(g_ssd_streaming_reason, "existing runtime setting") &&
        g_task_count == count && g_task_seq == seq && g_task_next_id == next_id &&
        g_steer.count == 1 && g_steer.inputs[0].text == pending;
    /* The original handler may already have reaped this test child. Never use
     * a stale PID to signal a replacement process: reap/identify first. */
    int status; pid_t reaped = waitpid(pid, &status, WNOHANG);
    if (!reaped) { assert(kill(pid, SIGTERM) == 0); assert(waitpid(pid, &status, 0) == pid); }
    else assert(reaped == pid || (reaped == -1 && errno == ECHILD));
    close(input); close(output); g_child = -1;
    for (int i = 0; i < g_steer.count; i++) free(g_steer.inputs[i].text);
    memset(&g_steer, 0, sizeof g_steer);
    int ok = alive && rejected && unchanged;
    printf("%s: %s (alive=%d rejected=%d unchanged=%d)\n", label, ok ? "PASS" : "FAIL", alive, rejected, unchanged);
    if (!ok) printf("HTTP receipt: %s\n", response);
    return ok;
}

static void fixture_file(const char *engine, const char *rel, int present) {
    char file[2048]; snprintf(file, sizeof file, "%s/%s", engine, rel);
    if (present) assert(jsonl_write_file(file, "fixture-not-weights", 19));
    else assert(unlink(file) == 0);
}
#endif

int main(void) {
#ifndef _WIN32
    signal(SIGPIPE, SIG_IGN);
    char temp[] = "/tmp/dstudio-launch-preflight.XXXXXX";
    assert(mkdtemp(temp));
    char engine[1024], gguf[1100];
    snprintf(engine, sizeof engine, "%s/ds4-qwen35", temp);
    snprintf(gguf, sizeof gguf, "%s/gguf", engine);
    assert(mkdir(engine, 0755) == 0 && mkdir(gguf, 0755) == 0);
    fixture_file(engine, MODEL_QWEN35, 1); fixture_file(engine, MODEL_QWEN, 1);
    cstr_copy(g_ds4_dir, sizeof g_ds4_dir, engine);
    cstr_copy(g_web_dir, sizeof g_web_dir, temp);
    assert(setenv("DS4UI_DATA_DIR", temp, 1) == 0);
    const char *modes[] = {"agent", "cowork", "design"};
    const char *models[] = {MODEL_QWEN35, MODEL_QWEN};
    int failures = 0, total = 0;
    for (int m = 0; m < 2; m++) for (int i = 0; i < 3; i++) {
        char body[2300], label[128];
        snprintf(body, sizeof body,
            "{\"mode\":\"%s\",\"gguf\":\"%s\",\"workdir\":\"%s\",\"skill\":\"new-skill\",\"ctx\":65536,\"metalHotlistSeed\":true,\"ssdStreaming\":\"on\"}",
            modes[i], models[m], temp);
        snprintf(label, sizeof label, "Incompatible Qwen%s -> %s config rejected before stop/admission", m ? "3.8" : "3.6", modes[i]);
        total++;
        const char *code = i == 2 ? "unsupported_model_mode"
            : m ? "engine_model_mismatch" : "unsupported_memory_mode";
#ifndef __APPLE__
        if (i < 2) code = "unsupported_backend";
#endif
        failures += !reject_without_effects(body, label, models[m], code, "409 Conflict");
    }
    fixture_file(engine, MODEL_QWEN35, 0); fixture_file(engine, MODEL_QWEN, 0);
    assert(rmdir(gguf) == 0 && rmdir(engine) == 0);

    const struct {
        const char *label, *checkout, *model, *options, *code, *missing;
    } cases[] = {
        {"Qwen3.6 in main", "ds4", MODEL_QWEN35, "", "engine_model_mismatch", NULL},
        {"Qwen3.6 Agent in main", "ds4", MODEL_QWEN35, ",\"mode\":\"agent\"", "engine_model_mismatch", NULL},
        {"Qwen3.6 Cowork in main", "ds4", MODEL_QWEN35, ",\"mode\":\"cowork\"", "engine_model_mismatch", NULL},
        {"Qwen3.6 Agent missing model", DS4_QWEN35_DIR_NAME, MODEL_QWEN35, ",\"mode\":\"agent\"", "model_unavailable", MODEL_QWEN35},
        {"Qwen3.6 Cowork missing model", DS4_QWEN35_DIR_NAME, MODEL_QWEN35, ",\"mode\":\"cowork\"", "model_unavailable", MODEL_QWEN35},
        {"Qwen3.8 in Qwen3.6 checkout", DS4_QWEN35_DIR_NAME, MODEL_QWEN, "", "engine_model_mismatch", NULL},
        {"Qwen3.6 in Qwen3.8 checkout", DS4_QWEN_DIR_NAME, MODEL_QWEN35, "", "engine_model_mismatch", NULL},
        {"Flash in Qwen checkout", DS4_QWEN_DIR_NAME, MODEL_FLASH, "", "engine_model_mismatch", NULL},
        {"Qwen3.8 missing PLE", DS4_QWEN_DIR_NAME, MODEL_QWEN, "", "model_component_missing", MODEL_QWEN_PLE},
        {"Qwen3.8 Agent missing PLE", DS4_QWEN_DIR_NAME, MODEL_QWEN, ",\"mode\":\"agent\"", "model_component_missing", MODEL_QWEN_PLE},
        {"Qwen3.8 Cowork missing PLE", DS4_QWEN_DIR_NAME, MODEL_QWEN, ",\"mode\":\"cowork\"", "model_component_missing", MODEL_QWEN_PLE},
        {"Qwen3.6 forced SSD", DS4_QWEN35_DIR_NAME, MODEL_QWEN35, ",\"ssdStreaming\":\"on\"", "unsupported_memory_mode", NULL},
        {"Qwen3.8 forced SSD", DS4_QWEN_DIR_NAME, MODEL_QWEN, ",\"ssdStreaming\":\"on\"", "unsupported_memory_mode", NULL},
        {"Qwen3.8 Agent forced SSD", DS4_QWEN_DIR_NAME, MODEL_QWEN, ",\"mode\":\"agent\",\"ssdStreaming\":\"on\"", "unsupported_memory_mode", NULL},
        {"Qwen3.8 Cowork forced SSD", DS4_QWEN_DIR_NAME, MODEL_QWEN, ",\"mode\":\"cowork\",\"ssdStreaming\":\"on\"", "unsupported_memory_mode", NULL},
        {"Laguna forced SSD", DS4_LAGUNA_DIR_NAME, MODEL_LAGUNA, ",\"ssdStreaming\":\"on\"", "unsupported_memory_mode", NULL},
        {"Missing implicit Flash", "ds4", NULL, "", "model_unavailable", MODEL_FLASH},
        {"Flash missing DSpark", "ds4", MODEL_FLASH, ",\"dspark\":true", "model_component_missing", MODEL_DSPARK_UPSTREAM},
        {"Flash DSpark plus forced SSD", "ds4", MODEL_FLASH, ",\"dspark\":true,\"ssdStreaming\":\"on\"", "unsupported_memory_mode", NULL},
        {"Remote Agent forced SSD", "ds4", NULL, ",\"mode\":\"agent\",\"modelBackend\":\"remote\",\"remoteBaseUrl\":\"http://127.0.0.1:1\",\"ssdStreaming\":\"on\"", "unsupported_memory_mode", NULL},
        {"Remote Cowork forced SSD", "ds4", NULL, ",\"mode\":\"cowork\",\"modelBackend\":\"remote\",\"remoteBaseUrl\":\"http://127.0.0.1:1\",\"ssdStreaming\":\"on\"", "unsupported_memory_mode", NULL},
        {"Remote Design forced SSD", "ds4", NULL, ",\"mode\":\"design\",\"modelBackend\":\"remote\",\"remoteBaseUrl\":\"http://127.0.0.1:1\",\"ssdStreaming\":\"on\"", "unsupported_memory_mode", NULL},
    };
    const char *files[] = { MODEL_FLASH, MODEL_LAGUNA, MODEL_QWEN35, MODEL_QWEN, MODEL_QWEN_PLE, MODEL_DSPARK_UPSTREAM };
    for (size_t i = 0; i < sizeof cases / sizeof cases[0]; i++) {
        snprintf(engine, sizeof engine, "%s/%s", temp, cases[i].checkout);
        snprintf(gguf, sizeof gguf, "%s/gguf", engine);
        assert(mkdir(engine, 0755) == 0 && mkdir(gguf, 0755) == 0);
        cstr_copy(g_ds4_dir, sizeof g_ds4_dir, engine);
        for (size_t j = 0; j < sizeof files / sizeof files[0]; j++)
            if (!cases[i].missing || strcmp(files[j], cases[i].missing)) fixture_file(engine, files[j], 1);
        char body[4096];
        /* Omit mode to exercise the real server default, not duplicate JSON keys. */
        snprintf(body, sizeof body, "{\"ctx\":65536,\"skill\":\"new-skill\"%s%s%s%s}",
                 cases[i].model ? ",\"gguf\":\"" : "", cases[i].model ? cases[i].model : "",
                 cases[i].model ? "\"" : "", cases[i].options);
        total++;
        /* The incoming selection differs from this saved state: validation
         * must use the candidate, not accidentally consult the active model. */
        const char *expected_code = cases[i].code;
        const int explicit_missing = cases[i].missing && cases[i].model &&
            !strcmp(cases[i].missing, cases[i].model);
#ifndef __APPLE__
        if (!explicit_missing && (model_file_is_qwen35(cases[i].model) ||
                                  model_file_is_qwen38(cases[i].model)))
            expected_code = "unsupported_backend";
#endif
        /* Explicit missing filenames are rejected by the request parser (400)
         * before native admission (409). Keep the exact status on both paths. */
        const char *status = explicit_missing ? "400 Bad Request" : "409 Conflict";
        failures += !reject_without_effects(body, cases[i].label, "", expected_code, status);
        for (size_t j = 0; j < sizeof files / sizeof files[0]; j++)
            if (!cases[i].missing || strcmp(files[j], cases[i].missing)) fixture_file(engine, files[j], 0);
        assert(rmdir(gguf) == 0 && rmdir(engine) == 0);
    }
    assert(rmdir(temp) == 0);
    printf("launch_preflight_unit: %d/%d passed; no inference\n", total - failures, total);
    return failures ? 1 : 0;
#else
    puts("launch_preflight_unit: BLOCKED (POSIX process probe unavailable)");
    return 77;
#endif
}

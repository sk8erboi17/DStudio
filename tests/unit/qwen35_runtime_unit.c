/* Executes launcher guards, catalog generation and an actual child argv probe.
 * Tiny controlled files replace weights: this does not validate inference. */
#define _GNU_SOURCE
#include <assert.h>
#define main dstudio_embedded_main_for_tests
#include "../../src/dstudio.c"
#undef main

#ifdef __APPLE__
static void qwen35_session_commands(void) {
    const char *actions[] = {"save", "list", "switch", "del", "new"};
    for (int cowork = 0; cowork <= 1; cowork++) {
        g_mode = cowork ? ENGINE_COWORK : ENGINE_AGENT;
        g_ready = 1; g_agent_working = g_agent_session_working = 0;
        assert(!agent_disk_checkpoints_supported());
        for (size_t i = 0; i < sizeof actions / sizeof actions[0]; i++) {
            int input[2], reply[2];
            assert(!pipe(input) && !socketpair(AF_UNIX, SOCK_STREAM, 0, reply));
            g_in_fd = input[1];
            char body[128], response[2048] = "", command[32] = "";
            snprintf(body, sizeof body, "{\"action\":\"%s\",\"sha\":\"1234abcd\"}", actions[i]);
            api_design_session(reply[0], body);
            close(reply[0]);
            size_t used = 0; ssize_t n;
            while ((n = read(reply[1], response + used, sizeof response - used - 1)) > 0) used += (size_t)n;
            assert(!fcntl(input[0], F_SETFL, O_NONBLOCK));
            n = read(input[0], command, sizeof command - 1);
            if (strcmp(actions[i], "new")) {
                assert(strstr(response, "409 Conflict") && strstr(response, "unsupported_session_checkpoint"));
                assert(n < 0 && errno == EAGAIN && !g_agent_working && !g_agent_session_working);
            } else {
                assert(strstr(response, "200 OK") && !strcmp(command, "/new\n"));
                assert(g_agent_working && g_agent_session_working);
            }
            close(reply[1]); close(input[0]); close(input[1]); g_in_fd = -1;
            g_agent_working = g_agent_session_working = 0;
        }
    }
    /* The restriction belongs to this native model, not to remote runtimes or
     * all Qwen engines merely because they share a name. */
    cstr_copy(g_remote_base_url, sizeof g_remote_base_url, "http://127.0.0.1:1");
    assert(agent_disk_checkpoints_supported()); g_remote_base_url[0] = '\0';
    cstr_copy(g_model_override, sizeof g_model_override, MODEL_QWEN);
    assert(agent_disk_checkpoints_supported());
    cstr_copy(g_model_override, sizeof g_model_override, MODEL_QWEN35);
}

static void qwen35_agent_spawn_probe(const engine_cfg *cfg, const char *engine,
                                     const char *workspace) {
    for (int cowork = 0; cowork <= 1; cowork++) {
        char binary[1024], err[1024] = "", output[8192] = "";
        snprintf(binary, sizeof binary, "%s/%s", engine, cowork ? "ds4-cowork" : "ds4-agent-jsonl");
        size_t len;
        char *script = jsonl_read_file("tests/fixtures/qwen35-runtime-probe.sh", &len);
        assert(script && jsonl_write_file(binary, script, len)); free(script);
        assert(!chmod(binary, 0755));
        launch_prepared prepared = {.skill_sys = strdup("fixture charter")};
        assert(prepared.skill_sys);
        assert(spawn_agent_prepared(cfg, workspace, cowork, err, sizeof err, &prepared));
        assert(!prepared.skill_sys && g_cfg.power == 100 && !g_ssd_streaming_effective);
        assert(!fcntl(g_out_fd, F_SETFL, 0));
        size_t used = 0; ssize_t n;
        while ((n = read(g_out_fd, output + used, sizeof output - used - 1)) > 0) used += (size_t)n;
        int status;
        assert(waitpid(g_child, &status, 0) == g_child && WIFEXITED(status) && !WEXITSTATUS(status));
        close_pipes(); g_child = -1;
        char model[1024], expected[1100];
        snprintf(expected, sizeof expected, "%s/%s", engine, MODEL_QWEN35);
        assert(realpath(expected, model));
        snprintf(expected, sizeof expected, "ARG:-m\nARG:%s\n", model);
        assert(strstr(output, expected));
        snprintf(expected, sizeof expected, "ARG:--chdir\nARG:%s\n", workspace);
        assert(strstr(output, expected));
        assert(strstr(output, "ARG:--jsonl\n") && strstr(output, "ARG:--metal\n"));
        assert(strstr(output, "ARG:-c\nARG:8192\n") && strstr(output, "ARG:-sys\nARG:fixture charter\n"));
        assert(strstr(output, "RESIDENCY:unset\nSKIP:unset\nPREFILL:unset\n"));
        assert(!strstr(output, "--power") && !strstr(output, "--ple") && !strstr(output, "--ssd-streaming"));
        assert(!strstr(output, "--dspark") && !strstr(output, "--q35-experts") && !strstr(output, "--kv-disk-dir"));
        assert(!unlink(binary));
    }
}
#endif

/* Count produced catalog fields; do not retain an unused production patch
 * helper solely because this behavioral test used its string utility. */
static int catalog_occurrences(const char *json, const char *value) {
    int count = 0;
    for (const char *p = strstr(json, value); p; p = strstr(p + 1, value)) count++;
    return count;
}

int main(void) {
    assert(model_file_is_supported(MODEL_QWEN35));
    assert(!model_file_is_supported("Qwen3.6-35B-A3B-Q4_K_M.gguf"));
    assert(!model_file_is_supported("Qwen3.5-35B-A3B-UD-Q6_K_XL.gguf"));
    cstr_copy(g_model_override, sizeof g_model_override, MODEL_QWEN35);
    assert(model_is_qwen35() && model_is_qwen() && !model_is_qwen38());
    assert(!model_is_glm() && !model_is_flash() && !model_is_laguna());
    engine_cfg cfg = ENGINE_DEFAULTS;
    char err[8600] = "", reason[256], rel[1024]; long long bytes;
    model_download_details("qwen36-q6", rel, sizeof rel, &bytes);
    assert(!strcmp(rel, MODEL_QWEN35) && bytes == MODEL_QWEN35_BYTES);
    cfg.ssd_streaming = SSD_STREAMING_ON;
    assert(engine_effective_ssd_streaming(&cfg, 0, reason, sizeof reason, err, sizeof err) == -1);
    cfg.ssd_streaming = SSD_STREAMING_AUTO;
    assert(engine_effective_ssd_streaming(&cfg, 0, reason, sizeof reason, err, sizeof err) == 0);
    cfg.ssd_streaming = SSD_STREAMING_OFF;
    g_dspark_enabled = 1;
    int requested_dspark = 1;
    assert(normalize_flash_memory_request(&cfg, 0, MODEL_QWEN35, &requested_dspark, 0, reason, sizeof reason, NULL, NULL));
    assert(!requested_dspark && g_dspark_enabled == 1 && !native_selected_vision_encoder());
    g_dspark_enabled = 0;
    assert(ds4_catalog_matches_selected_model("HTTP/1.1 200 OK\r\n\r\n{\"owned_by\":\"ds4.c\",\"id\":\"qwen3.6-35b-a3b\"}"));
    assert(!ds4_catalog_matches_selected_model("HTTP/1.1 200 OK\r\n\r\n{\"owned_by\":\"ds4.c\",\"id\":\"qwen3.8-flash-next\"}"));
#ifndef _WIN32
    char temp[] = "/tmp/dstudio-qwen35-unit.XXXXXX";
    assert(mkdtemp(temp));
    char main_dir[512], q35[512], q38[512], main_mark[560], q38_mark[560];
    char models[560], shared35[560], shared38[560], model[700], probe[560];
    snprintf(main_dir, sizeof main_dir, "%s/ds4", temp);
    snprintf(q35, sizeof q35, "%s/ds4-qwen35", temp);
    snprintf(q38, sizeof q38, "%s/ds4-qwen38", temp);
    snprintf(main_mark, sizeof main_mark, "%s/ds4.c", main_dir);
    snprintf(q38_mark, sizeof q38_mark, "%s/ds4.c", q38);
    snprintf(models, sizeof models, "%s/gguf", main_dir);
    snprintf(shared35, sizeof shared35, "%s/gguf", q35);
    snprintf(shared38, sizeof shared38, "%s/gguf", q38);
    snprintf(model, sizeof model, "%s/%s", main_dir, MODEL_QWEN35);
    snprintf(probe, sizeof probe, "%s/ds4-server", q35);
    assert(mkdir(main_dir, 0755) == 0 && mkdir(q35, 0755) == 0 && mkdir(q38, 0755) == 0);
    assert(mkdir(models, 0755) == 0);
    assert(jsonl_write_file(main_mark, "fixture", 7) && jsonl_write_file(q38_mark, "fixture", 7));
    assert(jsonl_write_file(model, "not real weights", 16));
    size_t len; char *script = jsonl_read_file("tests/fixtures/qwen35-runtime-probe.sh", &len);
    assert(script && jsonl_write_file(probe, script, len)); free(script);
    assert(chmod(probe, 0755) == 0);
    cstr_copy(g_web_dir, sizeof g_web_dir, temp);
    assert(setup_link_shared_gguf(q35, err, sizeof err));
    assert(setup_link_shared_gguf(q38, err, sizeof err));
    cstr_copy(g_ds4_dir, sizeof g_ds4_dir, main_dir);
    char *catalog = gguf_catalog_build();
    char *fallback = gguf_catalog_build_known();
    /* Check produced catalog JSON, not application source. The shared weight
     * must occur only in its matching checkout, including fallback scans. */
    assert(catalog && fallback);
    assert(catalog_occurrences(catalog, "Qwen3.6-35B-A3B-UD-Q6_K_XL.gguf") == 2);
    assert(catalog_occurrences(fallback, "Qwen3.6-35B-A3B-UD-Q6_K_XL.gguf") == 2);
    assert(strstr(catalog, "qwen35moe-support") && strstr(fallback, "qwen35moe-support"));
    free(catalog); free(fallback);
    assert(!spawn_server(&cfg, err, sizeof err)); /* Reject main -> Qwen. */
    cstr_copy(g_ds4_dir, sizeof g_ds4_dir, q38);
    assert(!spawn_server(&cfg, err, sizeof err)); /* Reject Qwen3.8 -> Qwen3.6. */
    cstr_copy(g_ds4_dir, sizeof g_ds4_dir, q35);
    assert(selected_checkout_is_qwen35() && selected_checkout_is_qwen());
    /* A structured adapter must be admitted for the correct native checkout;
     * actual argv/process wiring is exercised below without invoking a build. */
#ifdef __APPLE__
    assert(!native_launch_preflight(&cfg, ENGINE_AGENT, MODEL_QWEN35, 0, 0, err, sizeof err));
    assert(!native_launch_preflight(&cfg, ENGINE_COWORK, MODEL_QWEN35, 0, 0, err, sizeof err));
#endif
    assert(!spawn_design(&cfg, temp, err, sizeof err));
    cstr_copy(g_model_override, sizeof g_model_override, MODEL_QWEN);
    assert(!spawn_server(&cfg, err, sizeof err)); /* Reject the reverse mismatch. */
    cstr_copy(g_model_override, sizeof g_model_override, MODEL_QWEN35);
    assert(run_build_server_pld() == -1);
    char build_lock[700];
    snprintf(build_lock, sizeof build_lock, "%s/.ds4ui-native-build.lock", q35);
    assert(access(build_lock, F_OK) != 0 && errno == ENOENT); /* Unsupported means no checkout mutation. */
#ifdef __APPLE__
    int sock = socket(AF_INET, SOCK_STREAM, 0); assert(sock >= 0);
    struct sockaddr_in addr = {0}; addr.sin_family = AF_INET; addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    assert(bind(sock, (struct sockaddr *)&addr, sizeof addr) == 0);
    socklen_t addrlen = sizeof addr; assert(getsockname(sock, (struct sockaddr *)&addr, &addrlen) == 0);
    cfg.port = ntohs(addr.sin_port); close(sock);
    cfg.ctx = 8192;
    assert(setenv("DSTUDIO_KV_DIR", temp, 1) == 0);
    assert(setenv("DS4_Q35_SKIP", "m", 1) == 0);
    assert(setenv("DS4_METAL_NO_RESIDENCY", "1", 1) == 0);
    assert(setenv("DS4_METAL_PREFILL_CHUNK", "1024", 1) == 0);
    assert(spawn_server(&cfg, err, sizeof err));
    assert(g_cfg.power == 100);
    assert(fcntl(g_out_fd, F_SETFL, 0) == 0);
    char output[4096] = ""; size_t used = 0; ssize_t got;
    while ((got = read(g_out_fd, output + used, sizeof output - used - 1)) > 0) used += (size_t)got;
    int status; assert(waitpid(g_child, &status, 0) == g_child && WIFEXITED(status) && WEXITSTATUS(status) == 0);
    close(g_out_fd); close(g_err_fd); g_child = -1;
    assert(strstr(output, "ARG:-m\nARG:" MODEL_QWEN35 "\n"));
    assert(strstr(output, "ARG:--ctx\nARG:8192\n"));
    assert(strstr(output, "RESIDENCY:unset\nSKIP:unset\nPREFILL:unset\n"));
    assert(!strstr(output, "--ple") && !strstr(output, "--ssd-streaming"));
    assert(!strstr(output, "--dspark") && !strstr(output, "--q35-experts") && !strstr(output, "--q35-expert-threshold"));
    assert(!strstr(output, "--kv-disk-dir") && !strstr(output, "--power"));
    qwen35_agent_spawn_probe(&cfg, q35, temp);
    qwen35_session_commands();
    unsetenv("DSTUDIO_KV_DIR"); unsetenv("DS4_Q35_SKIP"); unsetenv("DS4_METAL_NO_RESIDENCY"); unsetenv("DS4_METAL_PREFILL_CHUNK");
#endif
    char partial[710], paused_target[64]; long long paused_bytes = 0, paused_expected = 0;
    snprintf(partial, sizeof partial, "%s.part", model);
    assert(rename(model, partial) == 0);
    assert(paused_model_download(paused_target, sizeof paused_target, &paused_bytes, &paused_expected));
    assert(!strcmp(paused_target, "qwen36-q6") && paused_bytes == 16 && paused_expected == MODEL_QWEN35_BYTES);
    assert(rename(partial, model) == 0);
    /* Every deletion is an exact path owned by this test. */
    assert(unlink(model) == 0 && unlink(probe) == 0 && unlink(main_mark) == 0 && unlink(q38_mark) == 0);
    assert(unlink(shared35) == 0 && unlink(shared38) == 0);
    assert(rmdir(models) == 0 && rmdir(main_dir) == 0 && rmdir(q35) == 0 && rmdir(q38) == 0);
    assert(rmdir(temp) == 0);
#endif
    puts("qwen35_runtime_unit: residency, checkout isolation, catalog and launch wiring passed (no inference)");
    return 0;
}

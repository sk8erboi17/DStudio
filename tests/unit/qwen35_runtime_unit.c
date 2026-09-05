/* Executes launcher guards, catalog generation and an actual child argv probe.
 * Tiny controlled files replace weights: this does not validate inference. */
#define _GNU_SOURCE
#include <assert.h>
#define main dstudio_embedded_main_for_tests
#include "../../src/dstudio.c"
#undef main

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
    assert(normalize_flash_memory_config(&cfg, 0, 0, reason, sizeof reason, NULL, NULL));
    assert(!g_dspark_enabled && !native_selected_vision_encoder());
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
    assert(patch_count_occurrences(catalog, "Qwen3.6-35B-A3B-UD-Q6_K_XL.gguf") == 2);
    assert(patch_count_occurrences(fallback, "Qwen3.6-35B-A3B-UD-Q6_K_XL.gguf") == 2);
    assert(strstr(catalog, "qwen35moe-support") && strstr(fallback, "qwen35moe-support"));
    free(catalog); free(fallback);
    assert(!spawn_server(&cfg, err, sizeof err)); /* Reject main -> Qwen. */
    cstr_copy(g_ds4_dir, sizeof g_ds4_dir, q38);
    assert(!spawn_server(&cfg, err, sizeof err)); /* Reject Qwen3.8 -> Qwen3.6. */
    cstr_copy(g_ds4_dir, sizeof g_ds4_dir, q35);
    assert(selected_checkout_is_qwen35() && selected_checkout_is_qwen());
    assert(!spawn_agent(&cfg, temp, 0, err, sizeof err));
    assert(!spawn_agent(&cfg, temp, 1, err, sizeof err));
    assert(!spawn_design(&cfg, temp, err, sizeof err));
    cstr_copy(g_model_override, sizeof g_model_override, MODEL_QWEN);
    assert(!spawn_server(&cfg, err, sizeof err)); /* Reject the reverse mismatch. */
    cstr_copy(g_model_override, sizeof g_model_override, MODEL_QWEN35);
    assert(run_build_server_pld() == -1);
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

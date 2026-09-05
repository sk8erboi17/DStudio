/* Production installer/model guards with real temporary files. No network,
 * compilation or model inference is claimed by this local regression suite. */
#define _GNU_SOURCE
#include <assert.h>
#define main dstudio_embedded_main_for_tests
#include "../../src/dstudio.c"
#undef main

int main(void) {
    assert(model_file_is_auxiliary("Qwen3.8-Flash-Next-PLE-Q4_1.gguf"));
    assert(model_file_is_auxiliary("Qwen3.8-Flash-Next-Q4KImatrix-MTP.gguf"));
    assert(!model_file_is_supported(MODEL_QWEN_PLE));
    assert(model_file_is_supported(MODEL_QWEN));
    cstr_copy(g_model_override, sizeof g_model_override, MODEL_QWEN);
    assert(model_is_qwen() && !model_is_flash() && !model_is_laguna());
    engine_cfg cfg = ENGINE_DEFAULTS;
    char err[8600] = "", reason[256] = "";
    cfg.ssd_streaming = SSD_STREAMING_ON;
    assert(engine_effective_ssd_streaming(&cfg, 0, reason, sizeof reason, err, sizeof err) == -1);
    cfg.ssd_streaming = SSD_STREAMING_AUTO;
    assert(engine_effective_ssd_streaming(&cfg, 0, reason, sizeof reason, err, sizeof err) == 0);
    assert(!err[0]);
    cfg.ssd_streaming = SSD_STREAMING_OFF;
    assert(cfg_ssd_streaming(&cfg, 0, err, sizeof err));
    assert(!g_ssd_streaming_effective && !err[0]);
    assert(strstr(g_ssd_streaming_reason, "PLE stays SSD-backed"));
    g_dspark_enabled = 1;
    assert(normalize_flash_memory_config(&cfg, 0, 0, reason, sizeof reason, NULL, NULL));
    assert(!g_dspark_enabled);
#ifndef _WIN32
    char temp[] = "/tmp/dstudio-engine-setup-unit.XXXXXX";
    assert(mkdtemp(temp));
    char primary[512], shared[512], side[512], link[512], other[512], marker[512];
    snprintf(primary, sizeof primary, "%s/ds4", temp);
    snprintf(shared, sizeof shared, "%s/ds4/gguf", temp);
    snprintf(side, sizeof side, "%s/ds4-qwen38", temp);
    snprintf(link, sizeof link, "%s/ds4-qwen38/gguf", temp);
    snprintf(other, sizeof other, "%s/other-model-store", temp);
    snprintf(marker, sizeof marker, "%s/ds4/user-data.txt", temp);
    assert(mkdir(primary, 0755) == 0);
    assert(mkdir(side, 0755) == 0);
    assert(mkdir(other, 0755) == 0);
    cstr_copy(g_ds4_dir, sizeof g_ds4_dir, side);
    assert(selected_checkout_is_qwen());
    assert(!spawn_server(&cfg, err, sizeof err)); /* Required PLE is absent. */
    assert(!spawn_agent(&cfg, temp, 0, err, sizeof err));
    assert(!spawn_agent(&cfg, temp, 1, err, sizeof err));
    assert(!spawn_design(&cfg, temp, err, sizeof err));
    cstr_copy(g_model_override, sizeof g_model_override, MODEL_FLASH);
    assert(!spawn_server(&cfg, err, sizeof err)); /* Never patch Qwen as DeepSeek at boot. */
    assert(g_child <= 0);
    assert(setenv("DSTUDIO_KV_DIR", temp, 1) == 0);
    char kv[512]; kv_root(kv, sizeof kv); assert(!strcmp(kv, temp));
    unsetenv("DSTUDIO_KV_DIR");
    assert(jsonl_write_file(marker, "user data", 9));
    char target[DSTUDIO_PATH_MAX]; int downloaded = 0;
    assert(!setup_install_engine("main", temp, target, sizeof target, &downloaded, err, sizeof err));
    assert(!downloaded);
    FILE *f = fopen(marker, "rb"); char content[10] = "";
    assert(f && fread(content, 1, 9, f) == 9 && !strcmp(content, "user data"));
    fclose(f);
    assert(!setup_install_engine("unknown", temp, target, sizeof target, &downloaded, err, sizeof err));
    assert(!setup_install_engine("main", marker, target, sizeof target, &downloaded, err, sizeof err));

    cstr_copy(g_web_dir, sizeof g_web_dir, temp);
    assert(jsonl_write_file(shared, "not a directory", 15));
    assert(!setup_link_shared_gguf(side, err, sizeof err));
    assert(access(link, F_OK) != 0);
    assert(unlink(shared) == 0);
    assert(mkdir(shared, 0755) == 0);
    assert(mkdir(link, 0755) == 0); /* Empty optional folder is replaced. */
    assert(setup_link_shared_gguf(side, err, sizeof err));
    assert(setup_link_shared_gguf(side, err, sizeof err)); /* Idempotence. */
    struct stat a, b;
    assert(stat(shared, &a) == 0 && stat(link, &b) == 0);
    assert(a.st_dev == b.st_dev && a.st_ino == b.st_ino);
    assert(unlink(link) == 0);
    assert(symlink(other, link) == 0);
    assert(!setup_link_shared_gguf(side, err, sizeof err));
    assert(stat(other, &a) == 0 && stat(link, &b) == 0 && a.st_ino == b.st_ino);
    assert(unlink(link) == 0);
    assert(symlink("../missing-model-store", link) == 0);
    assert(!setup_link_shared_gguf(side, err, sizeof err));
    assert(lstat(link, &a) == 0 && S_ISLNK(a.st_mode));
    assert(unlink(link) == 0);
    assert(unlink(marker) == 0);
    assert(rmdir(shared) == 0 && rmdir(primary) == 0 && rmdir(side) == 0 && rmdir(other) == 0);
    assert(rmdir(temp) == 0);
#endif
    puts("engine_setup_unit: model/component selection, residency, existing-data preservation and shared-store identity passed (no model)");
    return 0;
}

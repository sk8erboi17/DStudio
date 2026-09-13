#include <assert.h>
#define main dstudio_test_main
#include "../../src/dstudio.c"
#undef main

/* Execute the production builder or child environment with explicit paths.
 * No HTTP service, synthetic success branch or source rewrite. The caller
 * owns the command and any explicit model run; the builder loads no weights. */
int main(int argc, char **argv) {
    assert(argc >= 4);
    assert(realpath(argv[1], g_web_dir));
    assert(realpath(argv[2], g_ds4_dir));
    if (!strcmp(argv[3], "metal-env-qwen38") || !strcmp(argv[3], "metal-sources")) {
        assert(argc >= 5);
        if (!strcmp(argv[3], "metal-env-qwen38")) {
            cstr_copy(g_model_override, sizeof g_model_override, MODEL_QWEN);
            g_cfg = ENGINE_DEFAULTS;
            child_setenv_metal(&g_cfg);
        }
        child_setenv_metal_sources(g_ds4_dir);
        execv(argv[4], argv + 4);
        perror("exec native test with production Metal source environment");
        return 127;
    }
    assert(argc == 4);
    if (!strcmp(argv[3], "design") || !strcmp(argv[3], "design-status"))
        return run_ext_script("extension/design/build-design.sh",
            !strcmp(argv[3], "design") ? "build" : "status") ? 0 : 1;
    if (!strcmp(argv[3], "server-qwen38"))
        cstr_copy(g_model_override, sizeof g_model_override, MODEL_QWEN);
    if (!strcmp(argv[3], "server-qwen35"))
        cstr_copy(g_model_override, sizeof g_model_override, MODEL_QWEN35);
    if (!strcmp(argv[3], "server") || !strcmp(argv[3], "server-qwen38") || !strcmp(argv[3], "server-qwen35")) {
        int result = run_build_server_pld();
        if (result < 0) puts("unsupported ABI; native server retained");
        return result ? 0 : 1;
    }
    return run_build_jsonl(argv[3]) ? 0 : 1;
}

/* Production llama.cpp ownership decisions: which models it serves, which
 * modes and settings it admits, where it is installed, and the /props check
 * that alone makes a loading server ready. No process, network or model. */
#define _GNU_SOURCE
#include <assert.h>
#define main dstudio_embedded_main_for_tests
#include "../../src/dstudio.c"
#undef main

static const char *PROPS_TEMPLATE =
    "{\"default_generation_settings\":{\"n_ctx\":%d,\"params\":{\"temperature\":0.8}},"
    "\"total_slots\":%d,\"model_alias\":\"%s\",\"model_path\":\"%s\","
    "\"modalities\":{\"vision\":%s,\"audio\":false},\"build_info\":\"%s\","
    "\"chat_template\":\"{%%- if tools %%}<tool_call>{%%- endif %%}\"}";

static int props(int ctx, int slots, const char *alias, const char *path, const char *vision, const char *build) {
    char json[4096];
    snprintf(json, sizeof json, PROPS_TEMPLATE, ctx, slots, alias, path, vision, build);
    return resident_props_match(json, strlen(json));
}

int main(void) {
    /* Routing: only the pinned Qwen checkpoints go to llama.cpp. */
    assert(model_file_is_resident("gguf/Qwen3.6-35B-A3B-UD-Q6_K_XL.gguf"));
    assert(model_file_is_resident("gguf/Qwen3.8-27B-UD-Q6_K_XL.gguf"));
    assert(!model_file_is_resident("gguf/Qwen3.6-35B-A3B-Q8_0.gguf"));
    assert(!model_file_is_resident("gguf/Qwen3.8-27B-mmproj-F16.gguf"));
    assert(!model_file_is_resident("gguf/Qwen3.8-Flash-Next-Q4.gguf"));
    assert(!model_file_is_resident(MODEL_STD));
    assert(!strcmp(resident_model_id(MODEL_QWEN27), "qwen3.8-27b"));
    assert(!strcmp(resident_model_id(MODEL_QWEN35), "qwen3.6-35b-a3b"));

    /* Every mode: Agent/Cowork with structured tools, Design with its
     * structured remote adapter (real coverage: test-llama-resident-live). */
    char err[256] = "";
    assert(native_launch_mode_supported(ENGINE_SERVER, MODEL_QWEN35, 0, err, sizeof err));
    assert(native_launch_mode_supported(ENGINE_AGENT, MODEL_QWEN27, 0, err, sizeof err));
    assert(native_launch_mode_supported(ENGINE_COWORK, MODEL_QWEN35, 0, err, sizeof err));
    assert(native_launch_mode_supported(ENGINE_DESIGN, MODEL_QWEN27, 0, err, sizeof err));
    assert(native_launch_mode_supported(ENGINE_DESIGN, MODEL_QWEN35, 0, err, sizeof err));

    /* Harness locations: beside ds4/ and llama.cpp/, never inside a checkout. */
    char hroot[1024], bridge[1200];
    assert(harness_name_valid("pi") && harness_name_valid("opencode"));
    assert(!harness_name_valid("native") && !harness_name_valid("") && !harness_name_valid("../pi"));
    assert(harness_root_dir("/opt/studio/ds4", hroot, sizeof hroot) && !strcmp(hroot, "/opt/studio/harness"));
    assert(harness_bridge_path("/opt/studio/ds4", bridge, sizeof bridge) &&
           !strcmp(bridge, "/opt/studio/harness/bridge/dstudio-harness.mjs"));
    assert(!harness_root_dir("ds4", hroot, sizeof hroot));      /* relative: rejected */
    assert(!harness_root_dir("/ds4", hroot, sizeof hroot));     /* no parent directory */

    /* Settings that llama.cpp would silently ignore are refused. */
    engine_cfg cfg = ENGINE_DEFAULTS;
    cfg.power = 90;
    char cwd[DSTUDIO_PATH_MAX]; assert(getcwd(cwd, sizeof cwd));
    snprintf(g_ds4_dir, sizeof g_ds4_dir, "%s/ds4", cwd);
    const char *code = native_launch_preflight(&cfg, ENGINE_AGENT, MODEL_QWEN35, 0, 0, err, sizeof err);
    assert(code && !strcmp(code, "unsupported_power"));
    cfg.power = 100;
    code = native_launch_preflight(&cfg, ENGINE_AGENT, MODEL_QWEN35, 0, 1, err, sizeof err);
    assert(code && !strcmp(code, "unsupported_speculation"));
    cfg.ctx = 262145;
    code = native_launch_preflight(&cfg, ENGINE_AGENT, MODEL_QWEN35, 0, 0, err, sizeof err);
    assert(code && !strcmp(code, "unsupported_context"));
    cfg.ctx = 65536; cfg.ssd_streaming = SSD_STREAMING_ON;
    char reason[256] = "";
    assert(model_ssd_streaming(&cfg, 0, MODEL_QWEN27, 0, reason, sizeof reason, err, sizeof err) < 0);
    assert(strstr(err, "no expert SSD streaming"));
    cfg.ssd_streaming = SSD_STREAMING_OFF;
    assert(model_ssd_streaming(&cfg, 0, MODEL_QWEN27, 0, reason, sizeof reason, err, sizeof err) == 0);
    assert(!strcmp(reason, RESIDENT_MEMORY_NOTE));

    /* Install target: the sibling of the main installation, absolute only. */
    char install[1024];
    assert(resident_install_dir_kind(RESIDENT_LLAMA, "/Users/a/DStudio/ds4", install, sizeof install));
    assert(!strcmp(install, "/Users/a/DStudio/llama.cpp"));
    assert(resident_install_dir_kind(RESIDENT_MLX, "/Users/a/DStudio/ds4", install, sizeof install));
    assert(!strcmp(install, "/Users/a/DStudio/mlx"));
    assert(!resident_install_dir_kind(RESIDENT_LLAMA, "ds4", install, sizeof install));
    assert(!resident_install_dir_kind(RESIDENT_MLX, "/ds4", install, sizeof install));

    /* MLX: one pinned model directory, routed to the same owner. */
    assert(model_file_is_mlx(MODEL_QWEN36_MLX) && model_file_is_mlx("mlx/Qwen3.6-35B-A3B-MXFP8"));
    assert(!model_file_is_mlx("mlx/Qwen3.6-35B-A3B-4bit") && !model_file_is_mlx("gguf/Qwen3.6-35B-A3B-mxfp8"));
    assert(model_file_is_supported(MODEL_QWEN36_MLX) && !model_file_is_supported("mlx/Other-model"));
    assert(model_file_is_resident(MODEL_QWEN36_MLX));
    assert(!strcmp(resident_model_id(MODEL_QWEN36_MLX), "qwen3.6-35b-a3b-mlx"));

    /* An MLX model is a folder: present only as a directory (or a link to one)
     * holding config.json; the start path and preflight use that rule. The
     * first real run was rejected as "missing" before this (run-dI6doj). */
    char tmp[] = "/tmp/resident-mlx-XXXXXX", folder[2048], saved[sizeof g_ds4_dir];
    assert(mkdtemp(tmp));
    cstr_copy(saved, sizeof saved, g_ds4_dir);
    snprintf(g_ds4_dir, sizeof g_ds4_dir, "%s/ds4", tmp);
    snprintf(folder, sizeof folder, "%s/ds4/mlx", tmp); assert(!mkdir(g_ds4_dir, 0700) && !mkdir(folder, 0700));
    snprintf(folder, sizeof folder, "%s/ds4/%s", tmp, MODEL_QWEN36_MLX);
    assert(!model_rel_present(MODEL_QWEN36_MLX));
    FILE *f = fopen(folder, "w"); assert(f); fputs("{}", f); fclose(f);
    assert(!model_rel_present(MODEL_QWEN36_MLX));               /* a file is not the folder */
    assert(!unlink(folder) && !mkdir(folder, 0700));
    assert(!model_rel_present(MODEL_QWEN36_MLX));               /* no config.json yet */
    char config[2100]; snprintf(config, sizeof config, "%s/config.json", folder);
    f = fopen(config, "w"); assert(f); fputs("{\"model_type\":\"qwen3_5_moe\"}", f); fclose(f);
    assert(model_rel_present(MODEL_QWEN36_MLX));
    char elsewhere[2100]; snprintf(elsewhere, sizeof elsewhere, "%s/copy", tmp);
    assert(!rename(folder, elsewhere) && !symlink(elsewhere, folder));
    assert(model_rel_present(MODEL_QWEN36_MLX));                /* a link to an existing copy */
    engine_cfg mlx_cfg = ENGINE_DEFAULTS; mlx_cfg.ssd_streaming = SSD_STREAMING_OFF; mlx_cfg.power = 90;
    const char *throttled = native_launch_preflight(&mlx_cfg, ENGINE_AGENT, MODEL_QWEN36_MLX, 0, 0, err, sizeof err);
#if defined(__APPLE__) && defined(__aarch64__)
    assert(throttled && !strcmp(throttled, "unsupported_power") && strstr(err, "MLX does not"));
    mlx_cfg.power = 100;
    assert(!native_launch_preflight(&mlx_cfg, ENGINE_AGENT, MODEL_QWEN36_MLX, 0, 0, err, sizeof err));
#else
    assert(throttled && !strcmp(throttled, "unsupported_backend"));
#endif
    snprintf(config, sizeof config, "%s/copy/config.json", tmp); assert(!unlink(config));
    const char *missing = native_launch_preflight(&mlx_cfg, ENGINE_AGENT, MODEL_QWEN36_MLX, 0, 0, err, sizeof err);
    assert(missing);
    unlink(folder); snprintf(folder, sizeof folder, "%s/ds4/mlx", tmp); rmdir(elsewhere); rmdir(folder);
    rmdir(g_ds4_dir); rmdir(tmp);
    cstr_copy(g_ds4_dir, sizeof g_ds4_dir, saved);
    assert(!strcmp(resident_model_id(MODEL_QWEN35), "qwen3.6-35b-a3b")); /* the GGUF keeps its own id */

    /* Readiness: the server must report exactly the admitted launch. */
    memset(&g_resident, 0, sizeof g_resident);
    g_resident.spec.cfg.ctx = 65536;
    cstr_copy(g_resident.spec.directory, sizeof g_resident.spec.directory, "/m/ds4");
    cstr_copy(g_resident.spec.model, sizeof g_resident.spec.model, MODEL_QWEN27);
    cstr_copy(g_resident.spec.model_id, sizeof g_resident.spec.model_id, "qwen3.8-27b");
    cstr_copy(g_resident.spec.vision, sizeof g_resident.spec.vision, MODEL_QWEN27_VISION);
    const char *path = "/m/ds4/gguf/Qwen3.8-27B-UD-Q6_K_XL.gguf";
    assert(props(65536, 1, "qwen3.8-27b", path, "true", RESIDENT_BUILD_INFO) == 1);
    assert(props(32768, 1, "qwen3.8-27b", path, "true", RESIDENT_BUILD_INFO) == 0);      /* context */
    assert(props(65536, 2, "qwen3.8-27b", path, "true", RESIDENT_BUILD_INFO) == 0);      /* split slots */
    assert(props(65536, 1, "qwen3.6-35b-a3b", path, "true", RESIDENT_BUILD_INFO) == 0);  /* alias */
    assert(props(65536, 1, "qwen3.8-27b", "/m/ds4/gguf/other.gguf", "true", RESIDENT_BUILD_INFO) == 0);
    assert(props(65536, 1, "qwen3.8-27b", path, "false", RESIDENT_BUILD_INFO) == 0);     /* projector not loaded */
    assert(props(65536, 1, "qwen3.8-27b", path, "true", "b10034-0000000") == 0);         /* another build */
    g_resident.spec.vision[0] = '\0';
    assert(props(65536, 1, "qwen3.8-27b", path, "false", RESIDENT_BUILD_INFO) == 1);
    assert(props(65536, 1, "qwen3.8-27b", path, "true", RESIDENT_BUILD_INFO) == 0);      /* unexpected vision */
    assert(resident_props_match("{\"model_path\":", 14) == -1);                          /* partial: retry */
    assert(resident_props_match("[]", 2) == -1);

    /* MLX server arguments: one request at a time, and a request without
     * max_tokens may use the configured context (upstream default: 512). */
    {
        resident_launch_spec spec = {0}; resident_paths rp = {0}; char *argv_mlx[40];
        spec.kind = RESIDENT_MLX;
        cstr_copy(rp.model, sizeof rp.model, "/m/ds4/mlx/Qwen3.6-35B-A3B-mxfp8");
        cstr_copy(rp.context, sizeof rp.context, "65536"); cstr_copy(rp.port, sizeof rp.port, "28000");
        int n = resident_server_args(&spec, &rp, argv_mlx, 0), max_tokens = 0, concurrency = 0;
        assert(n > 0 && !argv_mlx[n]);
        for (int i = 0; i + 1 < n; i++) {
            if (!strcmp(argv_mlx[i], "--max-tokens")) max_tokens = !strcmp(argv_mlx[i + 1], "65536");
            if (!strcmp(argv_mlx[i], "--prompt-concurrency") || !strcmp(argv_mlx[i], "--decode-concurrency"))
                concurrency += !strcmp(argv_mlx[i + 1], "1");
            assert(strcmp(argv_mlx[i], "--alias") && strcmp(argv_mlx[i], "--ctx-size"));
        }
        assert(max_tokens && concurrency == 2);
    }

    /* MLX readiness: /v1/models lists exactly the admitted directory (resolved). */
    memset(&g_resident, 0, sizeof g_resident);
    g_resident.spec.kind = RESIDENT_MLX;
    cstr_copy(g_resident.model_real, sizeof g_resident.model_real, "/Users/a/models/Qwen3.6-35B-A3B-mxfp8");
    const char *one = "{\"object\":\"list\",\"data\":[{\"id\":\"/Users/a/models/Qwen3.6-35B-A3B-mxfp8\",\"object\":\"model\"}]}";
    const char *other = "{\"object\":\"list\",\"data\":[{\"id\":\"mlx-community/Other\"}]}";
    const char *two = "{\"object\":\"list\",\"data\":[{\"id\":\"/Users/a/models/Qwen3.6-35B-A3B-mxfp8\"},{\"id\":\"x\"}]}";
    assert(resident_props_match(one, strlen(one)) == 1);
    assert(resident_props_match(other, strlen(other)) == 0);   /* another model: fatal */
    assert(resident_props_match(two, strlen(two)) == 0);       /* not the single-model server */
    assert(resident_props_match("{\"data\":", 8) == -1);       /* partial: retry */
    /* The exact reply of the real mlx_lm server (Python BaseHTTP: HTTP/1.0,
     * no Content-Length, spaced JSON). The first live run waited on it
     * forever because only HTTP/1.1 was accepted (run-GDiTZ0, retained). */
    char real_reply[] = "HTTP/1.0 200 OK\r\nServer: BaseHTTP/0.6 Python/3.14.8\r\n"
        "Date: Sat, 03 Oct 2026 15:54:32 GMT\r\nContent-type: application/json\r\n"
        "Access-Control-Allow-Origin: *\r\n\r\n"
        "{\"object\": \"list\", \"data\": [{\"id\": \"/Users/a/models/Qwen3.6-35B-A3B-mxfp8\", \"object\": \"model\", \"created\": 1791042872}]}";
    assert(resident_probe_verdict(real_reply) == 1);
    char loading[] = "HTTP/1.0 503 Service Unavailable\r\nContent-type: application/json\r\n\r\n{\"error\": \"loading\"}";
    assert(resident_probe_verdict(loading) == -1);              /* 503 while loading: retry */
    char chunked[] = "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5b\r\n{}";
    assert(resident_probe_verdict(chunked) == -1);              /* never decoded, never accepted */
    char other_reply[] = "HTTP/1.0 200 OK\r\n\r\n{\"data\": [{\"id\": \"mlx-community/Other\"}]}";
    assert(resident_probe_verdict(other_reply) == 0);
    g_resident.model_real[0] = '\0';
    assert(resident_props_match(one, strlen(one)) == 0);       /* nothing admitted */
    puts("resident_runtime_unit: ok (production routing, preflight, llama.cpp /props and MLX /v1/models readiness; no process or model)");
    return 0;
}

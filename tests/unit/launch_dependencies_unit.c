/* Executes the production launch-dependency capture on real fixture trees.
 * The worst supported launch (dense Qwen Agent with projector, workspace and
 * user skill) must fit the bounded dependency table, and each engine family
 * must capture exactly the patch inputs its preparation worker uses. */
#define _GNU_SOURCE
#include <assert.h>
#define main dstudio_embedded_main_for_tests
#include "../../src/dstudio.c"
#undef main

static void touch(const char *root, const char *rel) {
    char path[4096];
    mkpath(root);
    snprintf(path, sizeof path, "%s/%s", root, rel);
    for (char *p = path + strlen(root) + 1; *p; p++) {
        if (*p != '/') continue;
        *p = '\0'; (void)mkdir(path, 0755); *p = '/';
    }
    FILE *f = fopen(path, "wb");
    assert(f && fputs("fixture\n", f) >= 0 && fclose(f) == 0);
}

static int captured(const launch_job *j, const char *suffix) {
    for (int i = 0; i < j->dependency_count; i++) {
        size_t n = strlen(j->dependencies[i].path), m = strlen(suffix);
        if (n >= m && !strcmp(j->dependencies[i].path + n - m, suffix)) return 1;
    }
    return 0;
}

static launch_job *job(const char *engine, const char *model, int mode, const char *workdir, const char *skill) {
    launch_job *j = calloc(1, sizeof *j);
    assert(j);
    j->request.mode = mode;
    cstr_copy(j->request.engine_dir, sizeof j->request.engine_dir, engine);
    cstr_copy(j->request.assets_dir, sizeof j->request.assets_dir, g_web_dir);
    cstr_copy(j->request.model, sizeof j->request.model, model);
    if (workdir) cstr_copy(j->request.workdir, sizeof j->request.workdir, workdir);
    if (skill) cstr_copy(j->request.skill, sizeof j->request.skill, skill);
    return j;
}

int main(int argc, char **argv) {
    (void)argc;
    char temp[] = "/tmp/dstudio-launch-deps.XXXXXX";
    assert(mkdtemp(temp));
    /* User skills resolve under HOME; never touch the real profile. */
    assert(setenv("HOME", temp, 1) == 0);
    assert(getcwd(g_web_dir, sizeof g_web_dir));
    assert(realpath(argv[0], g_launch_executable));
    char q36[1200], ds4[1200], qwen35[1200], workspace[1200], skills[1200];
    snprintf(q36, sizeof q36, "%s/q36", temp);
    snprintf(ds4, sizeof ds4, "%s/ds4", temp);
    snprintf(qwen35, sizeof qwen35, "%s/ds4-qwen35", temp);
    snprintf(workspace, sizeof workspace, "%s/workspace", temp);
    touch(q36, MODEL_QWEN27); touch(q36, MODEL_QWEN27_VISION); touch(q36, ".dstudio-source.json");
    touch(ds4, "ds4.c"); touch(ds4, MODEL_FLASH);
    touch(qwen35, "ds4.c"); touch(qwen35, MODEL_QWEN35);
    assert(mkdir(workspace, 0755) == 0);
    user_skills_dir(skills, sizeof skills);
    touch(skills, "fixture-skill/SKILL.md");

    launch_job *dense = job(q36, MODEL_QWEN27, ENGINE_AGENT, workspace, "fixture-skill");
    dense->q36 = calloc(1, sizeof *dense->q36);
    assert(dense->q36);
    assert(launch_capture_dependencies(dense));
    assert(dense->dependency_count <= LAUNCH_DEP_MAX);
    assert(captured(dense, "patch/q36-metal-runtime/runtime-1305843.patch"));
    assert(captured(dense, "patch/q36-f16-attention/online-1305843.patch"));
    assert(captured(dense, "/ds4") && captured(dense, "Qwen3.8-27B-mmproj-F16.gguf"));
    assert(!captured(dense, "patch/ds4-qwen35-q6k-moe/moe-q6k-nibble.patch"));

    launch_job *moe = job(qwen35, MODEL_QWEN35, ENGINE_COWORK, workspace, "fixture-skill");
    assert(launch_capture_dependencies(moe));
    assert(captured(moe, "patch/ds4-qwen35-q6k-moe/moe-q6k-nibble.patch"));
    assert(captured(moe, "patch/ds4-qwen35-catalog/native-model-id.patch"));
    assert(captured(moe, "patch/ds4-qwen35-prefill/prefill-73434c4.patch"));
    assert(!captured(moe, "patch/q36-metal-runtime/runtime-1305843.patch"));

    launch_job *main_engine = job(ds4, MODEL_FLASH, ENGINE_SERVER, NULL, NULL);
    assert(launch_capture_dependencies(main_engine));
    assert(!captured(main_engine, "patch/ds4-qwen35-q6k-moe/moe-q6k-nibble.patch"));
    assert(!captured(main_engine, "patch/ds4-qwen35-catalog/native-model-id.patch"));

    printf("launch_dependencies_unit: dense Agent %d/%d, Qwen3.6 %d, main %d dependencies; family-specific patch inputs captured\n",
           dense->dependency_count, LAUNCH_DEP_MAX, moe->dependency_count, main_engine->dependency_count);
    free(dense->q36); free(dense); free(moe); free(main_engine);
    return 0;
}

/* Executes the production launch-dependency capture on real fixture trees.
 * The worst supported launch (llama.cpp 27B Agent with projector, workspace and
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
    char ds4[1200], workspace[1200], skills[1200];
    snprintf(ds4, sizeof ds4, "%s/ds4", temp);
    snprintf(workspace, sizeof workspace, "%s/workspace", temp);
    /* The Qwen checkpoints live in the main installation's gguf/ store. */
    touch(ds4, "ds4.c"); touch(ds4, MODEL_FLASH);
    touch(ds4, MODEL_QWEN27); touch(ds4, MODEL_QWEN27_VISION); touch(ds4, MODEL_QWEN35);
    assert(mkdir(workspace, 0755) == 0);
    user_skills_dir(skills, sizeof skills);
    touch(skills, "fixture-skill/SKILL.md");

    /* llama.cpp-served 27B: the weights, its projector and the installer bind
     * the candidate; the tools frontend runs from the main installation. */
    launch_job *dense = job(ds4, MODEL_QWEN27, ENGINE_AGENT, workspace, "fixture-skill");
    dense->resident = calloc(1, sizeof *dense->resident);
    assert(dense->resident);
    cstr_copy(dense->resident->vision, sizeof dense->resident->vision, MODEL_QWEN27_VISION);
    assert(launch_capture_dependencies(dense));
    assert(dense->dependency_count <= LAUNCH_DEP_MAX);
    assert(captured(dense, "scripts/install-llama.py"));
    assert(captured(dense, "Qwen3.8-27B-UD-Q6_K_XL.gguf") && captured(dense, "Qwen3.8-27B-mmproj-F16.gguf"));
    assert(dense->resident->model_identity[0] && strcmp(dense->resident->model_identity, "missing"));
    assert(dense->resident->vision_identity[0] && strcmp(dense->resident->vision_identity, "missing"));
    assert(!strcmp(dense->resident->agent_dir, ds4) && dense->prepared.runtime_dir == dense->resident->agent_dir);

    launch_job *moe = job(ds4, MODEL_QWEN35, ENGINE_COWORK, workspace, "fixture-skill");
    moe->resident = calloc(1, sizeof *moe->resident);
    assert(moe->resident);
    assert(launch_capture_dependencies(moe));
    assert(captured(moe, "scripts/install-llama.py") && captured(moe, "Qwen3.6-35B-A3B-UD-Q6_K_XL.gguf"));
    assert(!moe->resident->vision_identity[0]); /* no projector is admitted for Qwen3.6 */

    launch_job *main_engine = job(ds4, MODEL_FLASH, ENGINE_SERVER, NULL, NULL);
    assert(launch_capture_dependencies(main_engine));
    assert(!captured(main_engine, "scripts/install-llama.py"));

    printf("launch_dependencies_unit: llama.cpp 27B Agent %d/%d, Qwen3.6 Cowork %d, main %d dependencies; engine-specific inputs captured\n",
           dense->dependency_count, LAUNCH_DEP_MAX, moe->dependency_count, main_engine->dependency_count);
    free(dense->resident); free(dense); free(moe->resident); free(moe); free(main_engine);
    return 0;
}

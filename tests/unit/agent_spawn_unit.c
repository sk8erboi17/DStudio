/* Deterministic OS-admission failures in the real spawn path. Prepared runtime
 * and GGUF bytes are fixtures; no weights are loaded or processes terminated. */
#define _GNU_SOURCE
#include <assert.h>
#include <errno.h>
#include <unistd.h>
static int fail_pipe_at, pipe_calls, fail_fork;
static int spawn_test_pipe(int fds[2]) {
    if (++pipe_calls == fail_pipe_at) { errno = EMFILE; return -1; }
    return pipe(fds);
}
static pid_t spawn_test_fork(void) {
    if (fail_fork) { errno = EAGAIN; return -1; }
    return fork();
}
#define pipe spawn_test_pipe
#define fork spawn_test_fork
#define main dstudio_embedded_main_for_tests
#include "../../src/dstudio.c"
#undef main
#undef fork
#undef pipe

static int open_descriptors(void) {
    int count = 0;
    for (int fd = 0; fd < 1024; fd++) if (fcntl(fd, F_GETFD) >= 0) count++;
    return count;
}
int main(void) {
#if defined(__APPLE__)
    char temp[] = "/tmp/dstudio-agent-spawn.XXXXXX", engine[1024], gguf[1100], file[2048];
    assert(mkdtemp(temp));
    for (int qwen35 = 0; qwen35 <= 1; qwen35++) {
    snprintf(engine, sizeof engine, "%s/%s", temp, qwen35 ? DS4_QWEN35_DIR_NAME : DS4_QWEN_DIR_NAME);
    snprintf(gguf, sizeof gguf, "%s/gguf", engine);
    assert(!mkdir(engine, 0755) && !mkdir(gguf, 0755));
    cstr_copy(g_ds4_dir, sizeof g_ds4_dir, engine);
    cstr_copy(g_web_dir, sizeof g_web_dir, temp);
    cstr_copy(g_model_override, sizeof g_model_override, qwen35 ? MODEL_QWEN35 : MODEL_QWEN);
    g_cfg = ENGINE_DEFAULTS; g_cfg.ssd_streaming = SSD_STREAMING_OFF;
    const char *files[] = {qwen35 ? MODEL_QWEN35 : MODEL_QWEN, qwen35 ? NULL : MODEL_QWEN_PLE, "ds4-agent-jsonl", "ds4-cowork"};
    for (size_t i = 0; i < sizeof files / sizeof files[0]; i++) {
        if (!files[i]) continue;
        snprintf(file, sizeof file, "%s/%s", engine, files[i]);
        assert(jsonl_write_file(file, "fixture", 7));
    }
    for (int cowork = 0; cowork <= 1; cowork++) for (int failure = 1; failure <= 4; failure++) {
        pipe_calls = 0; fail_pipe_at = failure <= 3 ? failure : 0; fail_fork = failure == 4;
        launch_prepared prepared = {.skill_sys = strdup("prepared fixture charter")};
        assert(prepared.skill_sys);
        int before = open_descriptors();
        char error[512] = "";
        assert(!spawn_agent_prepared(&g_cfg, temp, cowork, error, sizeof error, &prepared));
        assert(pipe_calls == (failure <= 3 ? failure : 3));
        assert(strstr(error, failure <= 3 ? "pipe:" : "fork:"));
        assert(!prepared.skill_sys && g_child <= 0);
        assert(open_descriptors() == before);
    }
    for (size_t i = 0; i < sizeof files / sizeof files[0]; i++) {
        if (!files[i]) continue;
        snprintf(file, sizeof file, "%s/%s", engine, files[i]); assert(!unlink(file));
    }
    assert(!rmdir(gguf) && !rmdir(engine));
    }
    assert(!rmdir(temp));
    puts("agent_spawn_unit: 16/16 Qwen3.6/3.8 pipe/fork failures preserve descriptors; no inference");
    return 0;
#else
    puts("agent_spawn_unit: NOT RUN (Qwen Metal launch prerequisites unavailable)");
    return 77;
#endif
}

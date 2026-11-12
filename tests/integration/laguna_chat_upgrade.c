/* Chat launch upgrade of an installed Laguna checkout to the prefill batch
 * patch (patch/ds4-laguna-prefill-chunk). Runs the production
 * setup_ensure_server_metrics_runtime() -- the step every Chat launch takes --
 * on a task-owned copy of the bundled Laguna engine, with the real patch
 * scripts and a real `make ds4-server` (Metal on macOS). No model is loaded
 * and no GPU work is done; src/engines/ds4-laguna-s21 is only read.
 *
 * Usage: laguna_chat_upgrade RUN_DIR   (from the repository root; RUN_DIR is
 * a new, empty, task-owned directory whose build logs are kept). */
#define _GNU_SOURCE
#include <assert.h>
#define main dstudio_embedded_main_for_tests
#include "../../src/dstudio.c"
#undef main

static char g_out[65536];

static int sh(const char *cwd, char *const argv[]) {
    g_out[0] = '\0';
    return setup_run_cmd_capture(cwd, argv, g_out, sizeof g_out);
}

static void server_help(const char *engine, char *out, size_t outsz) {
    char server[DSTUDIO_PATH_MAX + 32];
    snprintf(server, sizeof server, "%s/ds4-server", engine);
    char *argv[] = { server, "--help", NULL };
    sh(NULL, argv);
    cstr_copy(out, outsz, g_out);
}

static int same_file(const struct stat *a, const struct stat *b) {
    return a->st_ino == b->st_ino && a->st_mtimespec.tv_sec == b->st_mtimespec.tv_sec &&
           a->st_mtimespec.tv_nsec == b->st_mtimespec.tv_nsec;
}

#define LAGUNA_HELP "Laguna 4096 on Metal"

int main(int argc, char **argv) {
    if (argc != 2) { fprintf(stderr, "usage: laguna_chat_upgrade RUN_DIR\n"); return 2; }
    const char *run = argv[1];
    assert(getcwd(g_web_dir, sizeof g_web_dir));
    char engine[DSTUDIO_PATH_MAX], server[DSTUDIO_PATH_MAX + 32], saved[DSTUDIO_PATH_MAX + 32];
    char help[sizeof g_out], err[8192];
    snprintf(engine, sizeof engine, "%s/" DS4_LAGUNA_DIR_NAME, run);
    snprintf(server, sizeof server, "%s/ds4-server", engine);
    snprintf(saved, sizeof saved, "%s/ds4-server.before-patch", run);

    /* An installed Laguna checkout as DStudio left it before this patch: the
     * bundled sources with the managed runtime stack, and a server built from
     * them. The Laguna batch patch is deliberately not applied yet. */
    char source[DSTUDIO_PATH_MAX];
    snprintf(source, sizeof source, "%s/src/engines/" DS4_LAGUNA_DIR_NAME, g_web_dir);
    char *copy[] = { "cp", "-R", source, engine, NULL };
    assert(sh(NULL, copy) == 0);
    const char *stack[] = { "scripts/apply-ds4-visible-downloads.sh", "scripts/apply-ds4-media-memory.sh",
                            "scripts/apply-ds4-server-metrics.sh", "scripts/apply-ds4-glm53-runtime.sh",
                            "scripts/apply-ds4-glm53-m2max.sh", "scripts/apply-ds4-vision-streaming.sh",
                            "scripts/apply-ds4-v41-vision-pairing.sh", NULL };
    for (int i = 0; stack[i]; i++) assert(run_ext_script_for_dir(stack[i], "apply", engine));
    char *make_old[] = { "make", "-C", engine, "ds4-server", NULL };
    if (sh(NULL, make_old) != 0) { fprintf(stderr, "%s\n", g_out); return 1; }
    server_help(engine, help, sizeof help);
    assert(strstr(help, "--prefill-chunk") && !strstr(help, LAGUNA_HELP));
    char *keep[] = { "cp", "-p", server, saved, NULL };
    assert(sh(NULL, keep) == 0);
    printf("PASS: a Laguna server built before the patch keeps the fixed batch\n");

    cstr_copy(g_ds4_dir, sizeof g_ds4_dir, engine);

    /* 1. The next Chat launch applies the patch and rebuilds the server. */
    struct stat before, after;
    assert(stat(server, &before) == 0);
    err[0] = '\0';
    if (!setup_ensure_server_metrics_runtime(err, sizeof err)) { fprintf(stderr, "%s\n", err); return 1; }
    char *check[] = { "sh", "scripts/apply-ds4-laguna-prefill-chunk.sh", "check", NULL };
    setenv("DS4_DIR", engine, 1);
    assert(sh(NULL, check) == 0 && strstr(g_out, "already applied"));
    assert(stat(server, &after) == 0 && !same_file(&before, &after));
    server_help(engine, help, sizeof help);
    assert(strstr(help, LAGUNA_HELP));
    printf("PASS: the Chat launch applies the Laguna batch patch and rebuilds the server\n");

    /* The rebuild leaves a build receipt naming the server it built. */
    char receipt_path[DSTUDIO_PATH_MAX + 32];
    snprintf(receipt_path, sizeof receipt_path, "%s/.dstudio-build.json", engine);
    size_t receipt_len = 0;
    char *receipt = unified_read(receipt_path, &receipt_len);
    assert(receipt && strstr(receipt, "\"schema\": \"dstudio.engine-build.v1\""));
    assert(strstr(receipt, "\"CFLAGS\": \"") && strstr(receipt, "-O3"));
    char *shasum[] = { "shasum", "-a", "256", server, NULL };
    assert(sh(NULL, shasum) == 0);
    char digest[65] = ""; memcpy(digest, g_out, 64);
    char expect[128]; snprintf(expect, sizeof expect, "\"sha256\": \"%s\"", digest);
    assert(strstr(receipt, expect));
    free(receipt);
    printf("PASS: the rebuild records its compiler, flags and server SHA-256 in .dstudio-build.json\n");

    /* 2. A ready server is not rebuilt on the following launch. */
    assert(stat(server, &before) == 0);
    assert(setup_ensure_server_metrics_runtime(err, sizeof err));
    assert(stat(server, &after) == 0 && same_file(&before, &after));
    printf("PASS: a server that already has the patch is not rebuilt\n");

    /* 3. A pre-patch server that is newer than every source (copied back or
     * rebuilt from an older tree) is still detected from its contents. */
    char *restore_old[] = { "cp", saved, server, NULL };
    assert(sh(NULL, restore_old) == 0);
    char *touch_new[] = { "touch", server, NULL };
    assert(sh(NULL, touch_new) == 0);
    assert(stat(server, &before) == 0);
    assert(setup_ensure_server_metrics_runtime(err, sizeof err));
    assert(stat(server, &after) == 0 && !same_file(&before, &after));
    server_help(engine, help, sizeof help);
    assert(strstr(help, LAGUNA_HELP));
    printf("PASS: a pre-patch server newer than the sources is still rebuilt\n");

    printf("laguna_chat_upgrade: 5/5 passed (production setup path, real build, no model); %s\n", run);
    return 0;
}

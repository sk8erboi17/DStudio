/* Real production download admission/Stop and OS process ownership. The engine
 * is an idle owned process; the installer is blocked plumbing, never a model. */
#define _GNU_SOURCE
#include <assert.h>
#define main dstudio_test_main
#include "../../src/dstudio.c"
#undef main

static void response(int pair[2], char *out, size_t cap) {
    shutdown(pair[0], SHUT_WR);
    ssize_t n = read(pair[1], out, cap - 1);
    assert(n > 0); out[n] = '\0'; close(pair[0]); close(pair[1]);
}

static void ds41_progress_test(const char *root) {
    char cache[2048], hf[2048], download[2048], paths[8][2300];
    snprintf(cache, sizeof cache, "%s/ds4/gguf/.cache", root); assert(mkdir(cache, 0700) == 0);
    snprintf(hf, sizeof hf, "%s/huggingface", cache); assert(mkdir(hf, 0700) == 0);
    snprintf(download, sizeof download, "%s/download", hf); assert(mkdir(download, 0700) == 0);
    const char *names[] = {
        "unrelated.incomplete",
        "opaque.1ce6a8f8806205c13330d7ca287bd198331dc5ca35ccc5d8a9a92a188a6f6f42.incomplete",
        "opaque.1ce6a8f8806205c13330d7ca287bd198331dc5ca35ccc5d8a9a92a188a6f6f42.retry.incomplete",
        "opaque.6442b1f9224079662c02003c0ef9ef6be6e2aff509510f681dab9e6cc41df246.x.incomplete",
        "opaque.7c3e10646c918eeaffbc39305a75ec96117450262c61454ff194cef00d7617f0.x.incomplete",
        "opaque.cc283f032b3e8b8d78aeb5fccaa14e97b859b0c53aae3cd6bffa690ddf0e9e15.x.incomplete",
        "linked.1ce6a8f8806205c13330d7ca287bd198331dc5ca35ccc5d8a9a92a188a6f6f42.incomplete",
    };
    const int sizes[] = {999, 17, 11, 101, 23, 7};
    for (int i = 0; i < 7; i++) {
        snprintf(paths[i], sizeof paths[i], "%s/%s", download, names[i]);
        if (i == 6) {assert(symlink(paths[0], paths[i]) == 0); continue;}
        int fd = open(paths[i], O_CREAT | O_EXCL | O_WRONLY, 0600); assert(fd >= 0);
        assert(ftruncate(fd, sizes[i]) == 0); assert(close(fd) == 0);
    }
    int partial = 0;
    assert(ds41_download_bytes(g_ds4_dir, "ds41f-q2", &partial) == 17 && partial);
    assert(ds41_download_bytes(g_ds4_dir, "ds41f-q4", &partial) == 124 && partial);
    assert(ds41_download_bytes(g_ds4_dir, "ds41f-vision", &partial) == 7 && partial);
    assert(ds41_download_bytes(g_ds4_dir, "unrecognized", &partial) == 0 && !partial);
    snprintf(paths[7], sizeof paths[7], "%s/%s.assembling", g_ds4_dir, MODEL_DS41_Q4);
    int fd = open(paths[7], O_CREAT | O_EXCL | O_WRONLY, 0600); assert(fd >= 0);
    assert(ftruncate(fd, 114) == 0); assert(close(fd) == 0);
    assert(ds41_download_bytes(g_ds4_dir, "ds41f-q4", NULL) == 124);
    cstr_copy(g_dl_directory, sizeof g_dl_directory, g_ds4_dir);
    cstr_copy(g_dl_variant, sizeof g_dl_variant, "ds41f-q2");
    model_download_details(g_dl_variant, g_dl_rel, sizeof g_dl_rel, &g_dl_expected_bytes);
    assert(model_download_bytes_present() == 17);
    assert(g_dl_result == 0 && strcmp(model_download_phase(), "complete"));
    char target[48]; long long have, expected;
    assert(paused_model_download(target, sizeof target, &have, &expected));
    assert(!strcmp(target, "ds41f-q2") && have == 17 && expected == MODEL_DS41_Q2_BYTES);
    char saved[sizeof g_ds4_dir]; cstr_copy(saved, sizeof saved, g_ds4_dir);
    cstr_copy(g_ds4_dir, sizeof g_ds4_dir, "/does-not-exist/new-selection");
    assert(model_download_bytes_present() == 17);
    assert(paused_model_download(target, sizeof target, &have, &expected) && have == 17);
    cstr_copy(g_ds4_dir, sizeof g_ds4_dir, saved);
    int pair[2]; char out[1024];
    assert(socketpair(AF_UNIX, SOCK_STREAM, 0, pair) == 0);
    api_model_partials_delete(pair[0], "{\"target\":\"ds41f-q2\",\"confirm\":true}");
    response(pair, out, sizeof out); assert(strstr(out, "409 Conflict"));
    assert(model_download_bytes_present() == 17);
    for (int i = 0; i < 8; i++) assert(unlink(paths[i]) == 0);
    assert(rmdir(download) == 0); assert(rmdir(hf) == 0); assert(rmdir(cache) == 0);
    g_dl_variant[0] = g_dl_rel[0] = g_dl_directory[0] = 0; g_dl_expected_bytes = 0;
    puts("V4.1 download: identity-bound progress, duplicate retries, Q4 assembly, selection isolation and no false completion PASS");
}

int main(void) {
#ifndef _WIN32
    char root[] = "/tmp/dstudio-model-download-unit.XXXXXX";
    assert(mkdtemp(root));
    char main_dir[1024], scripts[1024], marker[1024], installer[1024], path[1024];
    snprintf(main_dir, sizeof main_dir, "%s/ds4", root); assert(mkdir(main_dir, 0700) == 0);
    snprintf(scripts, sizeof scripts, "%s/scripts", root); assert(mkdir(scripts, 0700) == 0);
    snprintf(path, sizeof path, "%s/ds4/Makefile", root); assert(jsonl_write_file(path, "all:\n", 5));
    char store[1024]; snprintf(store, sizeof store, "%s/gguf", main_dir); assert(mkdir(store, 0700) == 0);
    snprintf(marker, sizeof marker, "%s/entered", root);
    snprintf(installer, sizeof installer, "%s/scripts/install-q36.py", root);
    const char *program = "import sys,time\nfrom pathlib import Path\nr=Path(sys.argv[sys.argv.index('--root')+1])\n(r/'entered').write_text('blocked')\nwhile True: time.sleep(.02)\n";
    assert(jsonl_write_file(installer, program, strlen(program)));
    cstr_copy(g_ds4_dir, sizeof g_ds4_dir, main_dir); cstr_copy(g_web_dir, sizeof g_web_dir, root);
    setenv("DS4UI_DATA_DIR", root, 1);
    ds41_progress_test(root);
    /* Reproduce the host signal environment, including the handler whose
     * inheritance previously prevented an installer worker from stopping. */
    signal(SIGPIPE, SIG_IGN); signal(SIGTERM, on_term); signal(SIGINT, on_term);
    pid_t selected = fork(); assert(selected >= 0);
    if (selected == 0) {signal(SIGTERM, SIG_DFL); for (;;) pause();}
    g_child = selected; g_external_server = 0;
    int pair[2]; char out[4096];
    assert(socketpair(AF_UNIX, SOCK_STREAM, 0, pair) == 0);
    api_model_download(pair[0], "{\"target\":\"qwen27-q6\"}"); response(pair, out, sizeof out);
    assert(strstr(out, "200 OK")); pid_t download_pid = g_dl_pid; assert(download_pid > 0);
    long long deadline = dstudio_now_ms() + 5000;
    while (access(marker, F_OK) != 0 && dstudio_now_ms() < deadline) {reap_child(); usleep(10000);}
    assert(access(marker, F_OK) == 0); assert(kill(selected, 0) == 0);
    assert(socketpair(AF_UNIX, SOCK_STREAM, 0, pair) == 0);
    api_model_download_stop(pair[0]); response(pair, out, sizeof out); assert(strstr(out, "200 OK"));
    deadline = dstudio_now_ms() + 5000;
    while (g_dl_pid > 0 && dstudio_now_ms() < deadline) {reap_child(); usleep(10000);}
    assert(g_dl_pid == -1 && g_dl_progress_fd == -1);
    assert(!strcmp(model_download_phase(), "stopped"));
    assert(kill(download_pid, 0) == -1 && errno == ESRCH);
    assert(g_child == selected && kill(selected, 0) == 0 && g_stop == 0);
    kill(selected, SIGTERM); assert(waitpid(selected, NULL, 0) == selected); g_child = -1;
    /* Explicit fixture-only cleanup: no broad directory deletion. */
    assert(unlink(marker) == 0); assert(unlink(installer) == 0); assert(unlink(path) == 0);
    assert(rmdir(scripts) == 0); assert(rmdir(store) == 0); assert(rmdir(main_dir) == 0);
    printf("model-download: PASS; Stop preserves the live model process; cold added owner state %zu bytes\n",
           sizeof g_dl_directory + sizeof g_dl_progress_fd + sizeof g_dl_phase + sizeof g_dl_stop_requested);
#endif
    return 0;
}

#include <assert.h>
#define main dstudio_test_main
#include "../../src/dstudio.c"
#undef main

/* Test plumbing: materialize the production patch in a new, caller-owned file.
 * Never change the upstream checkout or overwrite an existing artifact. */
int main(int argc, char **argv) {
    assert((argc == 3 || (argc == 4 &&
        (!strcmp(argv[3], "--web") || !strcmp(argv[3], "--server")))) && access(argv[2], F_OK) != 0);
    resolve_web_dir();
    size_t size;
    char *source = unified_read(argv[1], &size);
    assert(source && jsonl_write_file(argv[2], source, size));
    if (argc == 4 && !strcmp(argv[3], "--server")) {
        jsonl_normalize_newlines(source, &size);
        ds4ui_patch_set patch;
        int ok = patch_load_set("patch/ds4-server-pld", &patch);
        if (ok) {
            ok = patch_apply_unified(&patch, &source, &size, "ds4_server.c");
            patch_free_set(&patch);
        }
        if (ok) ok = jsonl_write_file(argv[2], source, size);
        free(source);
        return ok ? 0 : 1;
    }
    free(source);
    return (argc == 4 ? web_cdp_write_temp(argv[2], argv[2]) : jsonl_apply(argv[2])) ? 0 : 1;
}

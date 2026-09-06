/* Compiled against the actual patched source in a task-owned directory. */
#include "ds4_web.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
char *dstudio_web_visit_visual(ds4_web *, const char *, char *, size_t);

int main(int argc, char **argv) {
    if (argc != 5) return 2;
    ds4_web_config config = { .home_dir = argv[1], .port = atoi(argv[2]) };
    ds4_web *web = ds4_web_create(&config);
    char err[256] = {0};
    char *out = !strcmp(argv[4], "visual")
        ? dstudio_web_visit_visual(web, argv[3], err, sizeof err)
        : ds4_web_visit_page(web, argv[3], err, sizeof err);
    ds4_web_free(web);
    if (!out) { fprintf(stderr, "%s\n", err); return 1; }
    puts(out);
    free(out);
    return 0;
}

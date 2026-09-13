/* Diagnostic-only host. Execute the unmodified production launcher, appending
 * the pinned q36 server's existing --trace option to its actual execve only.
 * This records prompts/cache decisions/phase timings, not a second transport or
 * inference implementation. Normal acceptance must also use the ordinary host.
 * The live harness supplies a fresh ignored path and bounds size and duration. */
#include <unistd.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static int diagnostic_execve(const char *, char *const [], char *const []);
#define execve diagnostic_execve
#define main dstudio_embedded_main
#include "../../src/dstudio.c"
#undef main
#undef execve

static int diagnostic_execve(const char *file, char *const argv[], char *const env[]) {
    const char *name = strrchr(file, '/');
    const char *trace = getenv("DSTUDIO_TEST_Q36_TRACE");
    if (!name || strcmp(name + 1, "q36-server") || !trace || !trace[0])
        return execve(file, argv, env);
    if (trace[0] != '/' || access(trace, F_OK) == 0) { errno = EINVAL; return -1; }
    char *args[64]; size_t n = 0;
    while (argv[n] && n < 60) { args[n] = argv[n]; n++; }
    if (argv[n]) { errno = E2BIG; return -1; }
    args[n++] = "--trace"; args[n++] = (char *)trace; args[n] = NULL;
    return execve(file, args, env);
}

int main(int argc, char **argv) {
    return dstudio_embedded_main(argc, argv);
}

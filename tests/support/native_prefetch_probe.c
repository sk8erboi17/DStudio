/* macOS-only test interposer. Observe actual native mapping hints without
 * issuing a multi-gigabyte prefetch. Never loaded by production DStudio.
 * STOP aborts at the first hint to probe normal startup without inference. */
#include <stdio.h>
#include <stdlib.h>
#include <sys/mman.h>
#include <unistd.h>

static int observe_prefetch(void *address, size_t length, int advice) {
    (void)address;
    fprintf(stderr, "DSTUDIO_TEST_PREFETCH bytes=%zu advice=%d\n", length, advice);
    fflush(stderr);
    const char *stop = getenv("DSTUDIO_TEST_PREFETCH_STOP");
    if (stop && stop[0]) _exit(83);
    return 0;
}

__attribute__((used)) static struct { const void *replacement; const void *original; }
prefetch_interposer __attribute__((section("__DATA,__interpose"))) = {
    (const void *)&observe_prefetch, (const void *)&posix_madvise
};

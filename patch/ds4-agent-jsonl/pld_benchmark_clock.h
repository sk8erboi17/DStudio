#ifndef DSTUDIO_PLD_BENCHMARK_CLOCK_H
#define DSTUDIO_PLD_BENCHMARK_CLOCK_H
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <time.h>

/* Freeze ONLY the model-visible session datetime for explicit real-engine
 * benchmarks. Generation timers, traces, file mtimes and the OS clock remain
 * real. Normal DStudio always uses the normal clock unless both opt-ins exist. */
static inline time_t ds4ui_benchmark_now(void) {
    const char *enabled = getenv("RUN_HEAVY");
    const char *epoch = getenv("DS4UI_BENCHMARK_EPOCH");
    if (enabled && !strcmp(enabled, "1") && epoch && epoch[0] >= '0' && epoch[0] <= '9') {
        char *end = NULL;
        errno = 0;
        long long value = strtoll(epoch, &end, 10);
        if (!errno && end && !*end && value > 0 && value <= 4102444800LL &&
            (long long)(time_t)value == value) return (time_t)value;
    }
    return time(NULL);
}
#endif

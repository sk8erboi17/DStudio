/* Diagnostic-only translation unit. Compile the installed Metal implementation
 * unchanged, then time its actual public readback calls. Never link this file
 * into DStudio or a managed engine. One GPU owner owns these fixed counters;
 * there are no callbacks, workers, allocations or per-call log messages. */
#ifndef DSTUDIO_Q36_METAL_SOURCE
#error "Supply the exact installed q36_metal.m path"
#endif
#define q36_gpu_tensor_contents dstudio_reference_contents
#define q36_gpu_tensor_contents_named dstudio_reference_contents_named
#define q36_gpu_tensor_read dstudio_reference_read
#define q36_gpu_tensor_write dstudio_reference_write
#define q36_gpu_flush_commands dstudio_reference_flush
#define q36_gpu_end_commands dstudio_reference_end
#define q36_gpu_synchronize dstudio_reference_synchronize
#include DSTUDIO_Q36_METAL_SOURCE
#undef q36_gpu_tensor_contents
#undef q36_gpu_tensor_contents_named
#undef q36_gpu_tensor_read
#undef q36_gpu_tensor_write
#undef q36_gpu_flush_commands
#undef q36_gpu_end_commands
#undef q36_gpu_synchronize
#include <time.h>

enum {
    SYNC_FINITE, SYNC_ROPE, SYNC_EMBED, SYNC_SCALE, SYNC_OTHER_NAMED,
    SYNC_CONTENTS, SYNC_READ, SYNC_WRITE, SYNC_FLUSH, SYNC_END,
    SYNC_SYNCHRONIZE, SYNC_COUNT
};
static const char *const sync_names[SYNC_COUNT] = {
    "finite_check", "rope", "embedding", "scale", "other_named",
    "contents", "read", "write", "flush", "end", "synchronize"
};
typedef struct {
    uint64_t calls, submitted, failed;
    double wall, gpu;
} sync_counter;
static sync_counter sync_counts[SYNC_COUNT];
static bool sync_enabled;
static double sync_started;

static double sync_now(void) {
    struct timespec ts;
    if (clock_gettime(CLOCK_MONOTONIC, &ts)) abort();
    return (double)ts.tv_sec + (double)ts.tv_nsec / 1e9;
}

/* Each wrapped API invokes precisely one native wait. A no-command read must
 * not inherit the previous command's GPU duration. Nested calls inside the
 * upstream implementation resolve to its reference symbols, not these wrappers. */
static void sync_record(unsigned category, double start, bool pending, bool ok) {
    sync_counter *c = &sync_counts[category];
    c->calls++;
    c->failed += !ok;
    c->wall += sync_now() - start;
    if (pending) {
        c->submitted++;
        if (ok) c->gpu += q36_last_gpu_seconds;
    }
}

void dstudio_q36_sync_begin(void) {
    memset(sync_counts, 0, sizeof(sync_counts));
    q36_gpu_prof_reset();
    sync_started = sync_now();
    sync_enabled = true;
}

void dstudio_q36_sync_end(const char *phase) {
    sync_enabled = false;
    q36_prof_active = false;
    /* Only fixed probe labels enter the report, never an arbitrary reason or
     * document/model text. At most 11 rows, emitted once per bounded phase. */
    const char *label = phase && !strcmp(phase, "prefill") ? "prefill" :
                        phase && !strcmp(phase, "decode") ? "decode" : "probe";
    printf("{\"kind\":\"sync_profile\",\"phase\":\"%s\",\"wallMs\":%.6f,"
           "\"commandBuffers\":%" PRIu64 ",\"gpuBusyMs\":%.6f,"
           "\"counterBytes\":%zu,\"calls\":[", label,
           (sync_now() - sync_started) * 1000, q36_prof_command_buffers,
           q36_prof_gpu_seconds * 1000, sizeof(sync_counts));
    for (unsigned i = 0; i < SYNC_COUNT; i++) {
        const sync_counter *c = &sync_counts[i];
        printf("%s{\"reason\":\"%s\",\"calls\":%" PRIu64
               ",\"submitted\":%" PRIu64 ",\"failed\":%" PRIu64
               ",\"callWallMs\":%.6f,\"gpuBusyMs\":%.6f}",
               i ? "," : "", sync_names[i], c->calls, c->submitted, c->failed,
               c->wall * 1000, c->gpu * 1000);
    }
    puts("]}");
    fflush(stdout);
}

void *q36_gpu_tensor_contents_named(q36_gpu_tensor *t, const char *reason) {
    if (!sync_enabled) return dstudio_reference_contents_named(t, reason);
    unsigned category = SYNC_OTHER_NAMED;
    if (reason && !strcmp(reason, "submit_wait_all_finite")) category = SYNC_FINITE;
    else if (reason && strstr(reason, "rope")) category = SYNC_ROPE;
    else if (reason && !strcmp(reason, "submit_wait_embed_tokens")) category = SYNC_EMBED;
    else if (reason && !strcmp(reason, "submit_wait_scale_host")) category = SYNC_SCALE;
    const double started = sync_now();
    const bool pending = t && q36_batch != nil;
    void *result = dstudio_reference_contents_named(t, reason);
    sync_record(category, started, pending, result != NULL);
    return result;
}

void *q36_gpu_tensor_contents(q36_gpu_tensor *t) {
    if (!sync_enabled) return dstudio_reference_contents(t);
    const double started = sync_now();
    const bool pending = t && q36_batch != nil;
    void *result = dstudio_reference_contents(t);
    sync_record(SYNC_CONTENTS, started, pending, result != NULL);
    return result;
}

int q36_gpu_tensor_read(const q36_gpu_tensor *t, uint64_t offset, void *data, uint64_t bytes) {
    if (!sync_enabled) return dstudio_reference_read(t, offset, data, bytes);
    const double started = sync_now();
    const bool pending = t && (data || !bytes) && offset <= t->bytes &&
                         bytes <= t->bytes - offset && q36_batch != nil;
    int result = dstudio_reference_read(t, offset, data, bytes);
    sync_record(SYNC_READ, started, pending, result != 0);
    return result;
}

int q36_gpu_tensor_write(q36_gpu_tensor *t, uint64_t offset, const void *data, uint64_t bytes) {
    if (!sync_enabled) return dstudio_reference_write(t, offset, data, bytes);
    const double started = sync_now();
    const bool pending = t && (data || !bytes) && offset <= t->bytes &&
                         bytes <= t->bytes - offset && q36_batch != nil;
    int result = dstudio_reference_write(t, offset, data, bytes);
    sync_record(SYNC_WRITE, started, pending, result != 0);
    return result;
}

#define SYNC_BARRIER(name, original, category) \
int name(void) { \
    if (!sync_enabled) return original(); \
    const double started = sync_now(); \
    const bool pending = q36_batch != nil; \
    int result = original(); \
    sync_record(category, started, pending, result != 0); \
    return result; \
}
SYNC_BARRIER(q36_gpu_flush_commands, dstudio_reference_flush, SYNC_FLUSH)
SYNC_BARRIER(q36_gpu_end_commands, dstudio_reference_end, SYNC_END)
SYNC_BARRIER(q36_gpu_synchronize, dstudio_reference_synchronize, SYNC_SYNCHRONIZE)
#undef SYNC_BARRIER

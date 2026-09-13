/* Execute real Metal operations through the diagnostic wrappers. These are
 * instrumentation/integrity checks, not model-quality or latency thresholds. */
#include "q36_metal_sync_profile.m"
#include <assert.h>
#include <math.h>

int main(void) {
    assert(q36_gpu_init());
    float values[4] = {1.25f, -2.5f, 0.0f, NAN}, result[4] = {0};
    q36_gpu_tensor *a = q36_gpu_tensor_alloc(sizeof(values));
    q36_gpu_tensor *b = q36_gpu_tensor_alloc(sizeof(values));
    assert(a && b && q36_gpu_tensor_write(a, 0, values, sizeof(values)));
    assert(sync_counts[SYNC_WRITE].calls == 0);
    dstudio_q36_sync_begin();
    assert(q36_gpu_tensor_copy(b, 0, a, 0, sizeof(values)));
    const float *p = q36_gpu_tensor_contents_named(b, "submit_wait_all_finite");
    assert(p && p[0] == values[0] && p[1] == values[1] && p[2] == 0 && isnan(p[3]));
    assert(sync_counts[SYNC_FINITE].calls == 1 && sync_counts[SYNC_FINITE].submitted == 1);
    const double gpu = sync_counts[SYNC_FINITE].gpu;
    assert(q36_gpu_tensor_contents_named(b, "submit_wait_all_finite") == p);
    assert(sync_counts[SYNC_FINITE].calls == 2 && sync_counts[SYNC_FINITE].submitted == 1);
    assert(sync_counts[SYNC_FINITE].gpu == gpu);
    assert(!q36_gpu_tensor_read(b, sizeof(values), result, 1));
    assert(sync_counts[SYNC_READ].failed == 1 && !sync_counts[SYNC_READ].submitted);
    assert(q36_gpu_tensor_read(b, 0, result, sizeof(result)));
    assert(!memcmp(values, result, sizeof(result)));
    assert(q36_gpu_tensor_contents_named(b, "a private unrecognized label") == p);
    assert(sync_counts[SYNC_OTHER_NAMED].calls == 1);
    assert(!q36_gpu_tensor_contents_named(NULL, "submit_wait_all_finite"));
    assert(sync_counts[SYNC_FINITE].failed == 1 && sync_counts[SYNC_FINITE].submitted == 1);
    dstudio_q36_sync_end("probe");
    assert(q36_gpu_tensor_contents(b) == p && sync_counts[SYNC_CONTENTS].calls == 0);
    dstudio_q36_sync_begin();
    for (unsigned i = 0; i < SYNC_COUNT; i++) assert(sync_counts[i].calls == 0);
    assert(q36_gpu_tensor_copy(b, 0, a, 0, sizeof(values)));
    assert(q36_gpu_flush_commands());
    assert(sync_counts[SYNC_FLUSH].submitted == 1);
    assert(q36_gpu_synchronize() && q36_gpu_end_commands());
    assert(!sync_counts[SYNC_SYNCHRONIZE].submitted && !sync_counts[SYNC_END].submitted);
    dstudio_q36_sync_end("probe");
    q36_gpu_tensor_free(a);
    q36_gpu_tensor_free(b);
    q36_gpu_cleanup();
    puts("Metal synchronization profile integrity: PASS");
    return 0;
}

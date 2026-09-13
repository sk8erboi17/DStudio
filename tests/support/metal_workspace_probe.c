/* The same public GPU operations are available in the supported Metal forks.
 * Compile against each fork's own header/objects. No weights or tokenization. */
#include "ds4_gpu.h"
#include <assert.h>
#include <stdbool.h>
#include <stdio.h>

bool ds4_log_is_tty(FILE *fp) { (void)fp; return false; }

int main(void) {
    enum { N = 257 };
    float a[N], b[N], actual[N];
    for (int i = 0; i < N; ++i) {
        a[i] = (float)(i - 100) / 4.0f;
        b[i] = (float)(i % 11) / 2.0f;
    }
    if (!ds4_gpu_init()) {
        fputs("Native Metal initialization failed from this working directory\n", stderr);
        return 1;
    }
    ds4_gpu_tensor *ta = ds4_gpu_tensor_alloc(sizeof a);
    ds4_gpu_tensor *tb = ds4_gpu_tensor_alloc(sizeof b);
    ds4_gpu_tensor *out = ds4_gpu_tensor_alloc(sizeof actual);
    assert(ta && tb && out);
    assert(ds4_gpu_tensor_write(ta, 0, a, sizeof a));
    assert(ds4_gpu_tensor_write(tb, 0, b, sizeof b));
    assert(ds4_gpu_add_tensor(out, ta, tb, N));
    assert(ds4_gpu_tensor_read(out, 0, actual, sizeof actual));
    for (int i = 0; i < N; ++i) assert(actual[i] == a[i] + b[i]);
    ds4_gpu_tensor_free(ta);
    ds4_gpu_tensor_free(tb);
    ds4_gpu_tensor_free(out);
    ds4_gpu_cleanup();
    puts("{\"initialized\":true,\"gpuAddChecks\":257}");
    return 0;
}

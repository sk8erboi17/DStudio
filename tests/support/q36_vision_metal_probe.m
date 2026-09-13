// Execute the pinned native Metal vision operations against independent scalar
// oracles. Only synthetic tensor files are created; no model is opened.
#include DSTUDIO_Q36_METAL_SOURCE
#include <math.h>
#include <fcntl.h>

static unsigned checks, failures;
static double mm_error, attention_error;
#define CHECK(expr) do { checks++; if (!(expr)) { failures++; \
    fprintf(stderr, "FAIL line %d: %s\n", __LINE__, #expr); } } while (0)

static bool write_all(int fd, const void *data, size_t bytes) {
    const unsigned char *p = data;
    while (bytes) {
        ssize_t n = write(fd, p, bytes);
        if (n < 0 && errno == EINTR) continue;
        if (n <= 0) return false;
        p += n; bytes -= (size_t)n;
    }
    return true;
}

static void matmul_case(uint32_t width, uint32_t output, uint32_t rows) {
    size_t nw = (size_t)width * output, nx = (size_t)width * rows, ny = (size_t)output * rows;
    const size_t pad = 16;
    _Float16 *weights = malloc(nw * sizeof(*weights));
    float *input = malloc((nx + 2 * pad) * sizeof(float));
    float *actual = malloc((ny + 2 * pad) * sizeof(float));
    float *expected = malloc(ny * sizeof(float));
    q36_gpu_tensor *gx = NULL, *gy = NULL, *x = NULL, *y = NULL, *second = NULL;
    char temporary[] = "/tmp/dstudio-q36-vision-XXXXXX";
    int fd = mkstemp(temporary);
    CHECK(fd >= 0 && weights && input && actual && expected);
    if (fd >= 0) CHECK(unlink(temporary) == 0);
    if (fd < 0 || !weights || !input || !actual || !expected) goto done;
    for (size_t i = 0; i < nw; i++) weights[i] = (_Float16)((int)(i * 17u % 509u) - 254) / (_Float16)317.0f;
    for (size_t i = 0; i < nx + 2 * pad; i++) input[i] = (float)sin((double)(i * 31u % 1009u) / 79.0);
    for (size_t i = 0; i < ny + 2 * pad; i++) actual[i] = -123.75f;
    // Double-accumulation oracle, not the upstream dot product or GPU tiling.
    for (uint32_t r = 0; r < rows; r++) for (uint32_t o = 0; o < output; o++) {
        double sum = 0;
        for (uint32_t i = 0; i < width; i++) sum += (double)weights[(size_t)o * width + i] * input[pad + (size_t)r * width + i];
        expected[(size_t)r * output + o] = (float)sum;
    }
    unsigned char prefix[73] = {0};
    CHECK(write_all(fd, prefix, sizeof(prefix)));
    CHECK(write_all(fd, weights, nw * sizeof(*weights)));
    for (size_t i = 0; i < nw; i++) weights[i] = -weights[i];
    CHECK(write_all(fd, weights, nw * sizeof(*weights)));
    gx = q36_gpu_tensor_alloc((nx + 2 * pad) * sizeof(float));
    gy = q36_gpu_tensor_alloc((ny + 2 * pad) * sizeof(float));
    x = q36_gpu_tensor_view(gx, pad * sizeof(float), nx * sizeof(float));
    y = q36_gpu_tensor_view(gy, pad * sizeof(float), ny * sizeof(float));
    second = q36_gpu_tensor_alloc(ny * sizeof(float));
    CHECK(gx && gy && x && y && second);
    if (!gx || !gy || !x || !y || !second) goto done;
    CHECK(q36_gpu_tensor_write(gx, 0, input, (nx + 2 * pad) * sizeof(float)));
    CHECK(q36_gpu_tensor_write(gy, 0, actual, (ny + 2 * pad) * sizeof(float)));
    CHECK(q36_gpu_vision_stream_init(nw * sizeof(*weights)));
    q36_gpu_tensor *identity = q36_vision_weight;
    CHECK(q36_gpu_vision_stream_init(nw * sizeof(*weights)) && q36_vision_weight == identity);
    CHECK(!q36_gpu_vision_stream_init(0) && q36_vision_weight == identity);
    CHECK(!q36_gpu_vision_stream_init(64u * 1024u * 1024u + 1u) && q36_vision_weight == identity);
    CHECK(q36_gpu_vision_matmul_f16_disk(y, fd, sizeof(prefix), width, output, x, rows));
    // Changing the exact source offset must drain the first dispatch before
    // reusing its one weight buffer, without changing the previous output.
    CHECK(q36_gpu_vision_matmul_f16_disk(second, fd, sizeof(prefix) + nw * sizeof(*weights), width, output, x, rows));
    CHECK(q36_gpu_tensor_read(gy, 0, actual, (ny + 2 * pad) * sizeof(float)));
    for (size_t i = 0; i < pad; i++) CHECK(actual[i] == -123.75f && actual[ny + pad + i] == -123.75f);
    for (size_t i = 0; i < ny; i++) {
        double d = fabs((double)actual[pad + i] - expected[i]);
        if (d > mm_error) mm_error = d;
        CHECK(isfinite(actual[pad + i]) && d <= 1e-4 + 3e-5 * fabs(expected[i]));
    }
    CHECK(q36_gpu_tensor_read(second, 0, actual, ny * sizeof(float)));
    for (size_t i = 0; i < ny; i++) CHECK(isfinite(actual[i]) && fabs((double)actual[i] + expected[i]) <= 1e-4 + 3e-5 * fabs(expected[i]));
    CHECK(q36_gpu_tensor_read(gx, 0, input, (nx + 2 * pad) * sizeof(float)));
    for (size_t i = 0; i < nx + 2 * pad; i++) CHECK(input[i] == (float)sin((double)(i * 31u % 1009u) / 79.0));
    CHECK(!q36_gpu_vision_matmul_f16_disk(y, -1, 0, width, output, x, rows));
    CHECK(!q36_gpu_vision_matmul_f16_disk(y, fd, UINT64_MAX, width, output, x, rows));
    CHECK(!q36_gpu_vision_matmul_f16_disk(y, fd, 0, UINT64_MAX, output, x, rows));
    CHECK(!q36_gpu_vision_matmul_f16_disk(y, fd, 0, width, output, x, 1025));
    CHECK(!q36_gpu_vision_matmul_f16_disk(y, fd, 0, width, output, x, 0));
    CHECK(!q36_gpu_vision_matmul_f16_disk(NULL, fd, 0, width, output, x, rows));
    CHECK(!q36_gpu_vision_matmul_f16_disk(y, fd, 0, width, output, NULL, rows));
    CHECK(!q36_gpu_vision_matmul_f16_disk(x, fd, 0, width, width, x, rows));
    q36_gpu_tensor *short_y = q36_gpu_tensor_view(y, 0, ny * sizeof(float) - 1u);
    q36_gpu_tensor *short_x = q36_gpu_tensor_view(x, 0, nx * sizeof(float) - 1u);
    CHECK(!q36_gpu_vision_matmul_f16_disk(short_y, fd, sizeof(prefix), width, output, x, rows));
    CHECK(!q36_gpu_vision_matmul_f16_disk(y, fd, sizeof(prefix), width, output, short_x, rows));
    q36_gpu_tensor_free(short_y); q36_gpu_tensor_free(short_x);
    // Partial disk reads may change private scratch, never the saved output.
    CHECK(ftruncate(fd, (off_t)(sizeof(prefix) + nw * sizeof(*weights) - 1u)) == 0);
    CHECK(!q36_gpu_vision_matmul_f16_disk(second, fd, sizeof(prefix), width, output, x, rows));
    float *after = malloc(ny * sizeof(float));
    CHECK(after != NULL);
    if (after) { CHECK(q36_gpu_tensor_read(second, 0, after, ny * sizeof(float))); CHECK(memcmp(after, actual, ny * sizeof(float)) == 0); free(after); }
done:
    if (fd >= 0) close(fd);
    q36_gpu_tensor_free(x); q36_gpu_tensor_free(y); q36_gpu_tensor_free(gx); q36_gpu_tensor_free(gy); q36_gpu_tensor_free(second);
    free(weights); free(input); free(actual); free(expected);
}

static void attention_case(uint32_t rows, bool uniform) {
    const size_t nx = (size_t)rows * 3456u, ny = (size_t)rows * 1152u, pad = 16;
    float *input = calloc(nx + 2 * pad, sizeof(float)), *expected = malloc(ny * sizeof(float));
    float *actual = malloc((ny + 2 * pad) * sizeof(float));
    double *scores = malloc(rows * sizeof(double));
    q36_gpu_tensor *gx = NULL, *gy = NULL, *x = NULL, *y = NULL;
    CHECK(input && expected && actual && scores);
    if (!input || !expected || !actual || !scores) goto done;
    for (size_t i = 0; i < ny + 2 * pad; i++) actual[i] = -123.75f;
    for (uint32_t r = 0; r < rows; r++) for (uint32_t h = 0; h < 16; h++) for (uint32_t d = 0; d < 72; d++) {
        size_t i = pad + (size_t)r * 3456u + h * 72u + d;
        input[i] = uniform ? 0 : (float)sin((r + h * 17 + d * 7) / 11.0) * (r == 0 ? 20 : 1);
        input[i + 1152] = uniform ? 0 : (float)cos((r * 7 + h * 31 + d * 5) / 13.0) * (r == rows - 1 ? 10 : 1);
        input[i + 2304] = uniform ? (float)(h * 72 + d) / 1237.0f : (float)sin((r * 3 + h * 47 + d * 2) / 17.0);
    }
    // Independent two-pass double softmax, not the online tree reduction.
    for (uint32_t r = 0; r < rows; r++) for (uint32_t h = 0; h < 16; h++) {
        double highest = -INFINITY, denominator = 0;
        if (!uniform) {
            for (uint32_t k = 0; k < rows; k++) {
                double sum = 0;
                for (uint32_t d = 0; d < 72; d++) sum += (double)input[pad + (size_t)r * 3456u + h * 72u + d] * input[pad + (size_t)k * 3456u + 1152u + h * 72u + d];
                scores[k] = sum / sqrt(72.0); if (scores[k] > highest) highest = scores[k];
            }
            for (uint32_t k = 0; k < rows; k++) { scores[k] = exp(scores[k] - highest); denominator += scores[k]; }
        }
        for (uint32_t d = 0; d < 72; d++) {
            double sum = 0;
            if (uniform) sum = input[pad + 2304u + h * 72u + d];
            else { for (uint32_t k = 0; k < rows; k++) sum += scores[k] * input[pad + (size_t)k * 3456u + 2304u + h * 72u + d]; sum /= denominator; }
            expected[(size_t)r * 1152u + h * 72u + d] = (float)sum;
        }
    }
    gx = q36_gpu_tensor_alloc((nx + 2 * pad) * sizeof(float)); gy = q36_gpu_tensor_alloc((ny + 2 * pad) * sizeof(float));
    x = q36_gpu_tensor_view(gx, pad * sizeof(float), nx * sizeof(float)); y = q36_gpu_tensor_view(gy, pad * sizeof(float), ny * sizeof(float));
    CHECK(gx && gy && x && y); if (!gx || !gy || !x || !y) goto done;
    CHECK(q36_gpu_tensor_write(gx, 0, input, (nx + 2 * pad) * sizeof(float)));
    CHECK(q36_gpu_tensor_write(gy, 0, actual, (ny + 2 * pad) * sizeof(float)));
    CHECK(q36_gpu_vision_attention(y, x, rows));
    CHECK(q36_gpu_tensor_read(gy, 0, actual, (ny + 2 * pad) * sizeof(float)));
    for (size_t i = 0; i < pad; i++) CHECK(actual[i] == -123.75f && actual[ny + pad + i] == -123.75f);
    for (size_t i = 0; i < ny; i++) {
        double delta = fabs((double)actual[pad + i] - expected[i]);
        if (delta > attention_error) attention_error = delta;
        CHECK(isfinite(actual[pad + i]) && delta <= 5e-5 + 5e-5 * fabs(expected[i]));
    }
    CHECK(!q36_gpu_vision_attention(NULL, x, rows)); CHECK(!q36_gpu_vision_attention(y, NULL, rows));
    CHECK(!q36_gpu_vision_attention(y, x, 0)); CHECK(!q36_gpu_vision_attention(y, x, 1025));
    CHECK(!q36_gpu_vision_attention(x, x, rows));
    q36_gpu_tensor *short_x = q36_gpu_tensor_view(x, 0, nx * sizeof(float) - 1u);
    q36_gpu_tensor *short_y = q36_gpu_tensor_view(y, 0, ny * sizeof(float) - 1u);
    CHECK(!q36_gpu_vision_attention(y, short_x, rows)); CHECK(!q36_gpu_vision_attention(short_y, x, rows));
    q36_gpu_tensor_free(short_x); q36_gpu_tensor_free(short_y);
    float *after = malloc((nx + 2 * pad) * sizeof(float)); CHECK(after != NULL);
    if (after) { CHECK(q36_gpu_tensor_read(gx, 0, after, (nx + 2 * pad) * sizeof(float))); CHECK(memcmp(after, input, (nx + 2 * pad) * sizeof(float)) == 0); free(after); }
done:
    q36_gpu_tensor_free(x); q36_gpu_tensor_free(y); q36_gpu_tensor_free(gx); q36_gpu_tensor_free(gy);
    free(input); free(expected); free(actual); free(scores);
}

int main(void) {
    @autoreleasepool {
        if (!q36_gpu_init()) { fprintf(stderr, "Metal unavailable: NOT RUN\n"); return 2; }
        matmul_case(1, 1, 1); matmul_case(17, 31, 19); matmul_case(768, 1152, 4);
        matmul_case(4608, 5120, 1); matmul_case(17, 31, 1024);
        attention_case(1, false); attention_case(3, false); attention_case(17, false);
        attention_case(129, false); attention_case(1024, true);
        q36_gpu_cleanup();
        CHECK(q36_vision_weight == NULL && q36_live_bytes == 0);
        printf("{\"checks\":%u,\"failures\":%u,\"matmulMaxAbsoluteError\":%.9g,\"attentionMaxAbsoluteError\":%.9g,\"passed\":%s}\n",
               checks, failures, mm_error, attention_error, failures ? "false" : "true");
        return failures ? 1 : 0;
    }
}

// Real projector weights and RGB inputs through the native encoder. No LLM is
// opened. The comparison uses q36's scalar encoder, not a vision-quality oracle.
#include DSTUDIO_Q36_CORE_SOURCE

static unsigned checks, failures;
#define CHECK(expr) do { checks++; if (!(expr)) { failures++; \
    fprintf(stderr, "FAIL line %d: %s\n", __LINE__, #expr); } } while (0)

static double max_absolute, max_relative_l2;

static void encoder_case(q36_engine *e, uint32_t width, uint32_t height, unsigned variant) {
    q36_image image = {.width = width, .height = height};
    image.rgb = malloc((size_t)width * height * 3u);
    CHECK(image.rgb != NULL); if (!image.rgb) return;
    for (uint32_t y = 0; y < height; y++) for (uint32_t x = 0; x < width; x++) {
        size_t at = ((size_t)y * width + x) * 3u;
        image.rgb[at] = (uint8_t)((x * 19u + variant * 13u) % 256u);
        image.rgb[at + 1] = (uint8_t)((y * 23u + variant * 29u) % 256u);
        image.rgb[at + 2] = (uint8_t)(((x / 4u + y / 4u + variant) % 2u) * 255u);
    }
    memset(image.fingerprint, (int)(variant + 1), sizeof(image.fingerprint));
    q36_vision_embedding gpu = {0}, scalar = {0}, rejected = {0};
    char error[256] = {0};
    e->backend = Q36_BACKEND_METAL;
    int fd = e->vision_model.fd;
    // A disconnected fd must fail the actual Metal route, not fall back to a
    // mapped CPU weight tensor. No prior embedding is replaced on failure.
    e->vision_model.fd = -1;
    CHECK(!q36_engine_vision_encode(e, &image, &rejected, error, sizeof(error)));
    CHECK(!rejected.data && !rejected.token_count);
    e->vision_model.fd = fd;
    error[0] = 0;
    int ok = q36_engine_vision_encode(e, &image, &gpu, error, sizeof(error));
    CHECK(ok); if (!ok) { fprintf(stderr, "Metal encoder: %s\n", error); goto done; }
    CHECK(gpu.data && gpu.token_count && gpu.grid_width * gpu.grid_height == gpu.token_count);
    CHECK(gpu.width == width && gpu.height == height);
    CHECK(memcmp(gpu.fingerprint, image.fingerprint, sizeof(image.fingerprint)) == 0);
    e->backend = Q36_BACKEND_CPU;
    error[0] = 0;
    // Direct native scalar reference: the public CPU vision-session capability
    // is not changed or claimed by this test.
    ok = q36_vision_encode_image(e, &image, &scalar, error, sizeof(error));
    CHECK(ok); if (!ok) { fprintf(stderr, "Scalar encoder: %s\n", error); goto done; }
    CHECK(scalar.token_count == gpu.token_count && scalar.grid_width == gpu.grid_width && scalar.grid_height == gpu.grid_height);
    if (scalar.token_count != gpu.token_count) goto done;
    double square_error = 0, square_reference = 0, square_gpu = 0, dot = 0, local_max = 0;
    size_t count = (size_t)gpu.token_count * Q36_N_EMBD;
    for (size_t i = 0; i < count; i++) {
        CHECK(isfinite(gpu.data[i]) && isfinite(scalar.data[i]));
        double difference = (double)gpu.data[i] - scalar.data[i];
        if (fabs(difference) > local_max) local_max = fabs(difference);
        square_error += difference * difference;
        square_reference += (double)scalar.data[i] * scalar.data[i];
        square_gpu += (double)gpu.data[i] * gpu.data[i];
        dot += (double)gpu.data[i] * scalar.data[i];
    }
    double relative_l2 = sqrt(square_error / fmax(square_reference, 1e-30));
    double cosine = dot / sqrt(fmax(square_reference * square_gpu, 1e-30));
    CHECK(local_max <= 1e-2);
    CHECK(sqrt(square_error / count) <= 1e-3);
    CHECK(relative_l2 <= 5e-4 && cosine >= 0.99999);
    if (local_max > max_absolute) max_absolute = local_max;
    if (relative_l2 > max_relative_l2) max_relative_l2 = relative_l2;
    fprintf(stderr, "encoder %ux%u: %u image tokens, max_abs=%.9g rmse=%.9g relative_l2=%.9g cosine=%.12g\n",
            width, height, gpu.token_count, local_max, sqrt(square_error / count), relative_l2, cosine);
done:
    q36_vision_embedding_free(&gpu); q36_vision_embedding_free(&scalar);
    q36_vision_embedding_free(&rejected); q36_image_free(&image);
}

int main(int argc, char **argv) {
    if (argc != 2) { fprintf(stderr, "Expected the verified pinned F16 Qwen27B projector\n"); return 2; }
    g_q36_shape = Q36_SHAPE_27B;
    q36_engine e = {0}; e.model.fd = -1; e.vision_model.fd = -1;
    e.n_threads = 1; e.backend = Q36_BACKEND_METAL;
    model_open(&e.vision_model, argv[1], false);
    q36_tensor *projection = model_find_tensor(&e.vision_model, "mm.2.weight");
    CHECK(projection && projection->type == Q36_TENSOR_F16 && projection->dim[0] == 4608u && projection->dim[1] == Q36_N_EMBD);
    if (failures) { model_close(&e.vision_model); return 1; }
    if (!q36_gpu_init() || !q36_gpu_vision_stream_init(e.vision_model.max_tensor_bytes)) {
        fprintf(stderr, "Metal vision setup failed\n"); model_close(&e.vision_model); return 2;
    }
    e.vision_ready = true;
    encoder_case(&e, 32, 32, 0);
    encoder_case(&e, 64, 32, 1);
    model_close(&e.vision_model); q36_gpu_cleanup();
    printf("{\"checks\":%u,\"failures\":%u,\"maxAbsoluteError\":%.9g,\"maxRelativeL2\":%.9g,\"passed\":%s}\n",
           checks, failures, max_absolute, max_relative_l2, failures ? "false" : "true");
    return failures ? 1 : 0;
}

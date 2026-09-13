// Real, model-free Metal attention scheduling and numerical regression. The
// unchanged single-query kernel is a differential oracle, not LLM validation.
#include DSTUDIO_Q36_METAL_SOURCE
#include <float.h>
#include <math.h>
#include <time.h>

static unsigned checks, failures, command_count, locked_waits;
static double command_gpu_ms, max_command_gpu_ms;
static double command_wait_ms, phase_gpu_ms[32];
static unsigned phase_commands[32];
static bool segmented_check;
static bool isolated_encoders;
static unsigned bounded_encoders, max_key_span, max_query_heads;
static unsigned allocation_lock_violations;
static unsigned encoder_calls, encoder_fail_at;
static NSUInteger max_static_threadgroup_bytes;
#define CHECK(expr) do { checks++; if (!(expr)) { failures++; \
    fprintf(stderr, "FAIL line %d: %s\n", __LINE__, #expr); } } while (0)

@interface AttentionBufferProbe : NSObject
@property(strong) id<MTLCommandBuffer> real;
@property unsigned kernelMask;
@end

@interface AttentionEncoderProbe : NSObject
@property(strong) id<MTLComputeCommandEncoder> real;
@property unsigned span;
@property(weak) AttentionBufferProbe *owner;
@end

@interface AttentionDeviceProbe : NSObject
@property(strong) id<MTLDevice> real;
@property bool failAllocation;
@end
@implementation AttentionDeviceProbe
- (id)forwardingTargetForSelector:(SEL)selector { return _real; }
- (id<MTLBuffer>)newBufferWithLength:(NSUInteger)length options:(MTLResourceOptions)options {
    if (pthread_mutex_trylock(&q36_mu) != 0) allocation_lock_violations++;
    else pthread_mutex_unlock(&q36_mu);
    return _failAllocation ? nil : [_real newBufferWithLength:length options:options];
}
@end
@implementation AttentionEncoderProbe
- (id)forwardingTargetForSelector:(SEL)selector { return _real; }
- (void)setLabel:(NSString *)label {
    // Observe submitted kernel identity, not the source or encoder ordinal.
    // A command containing both kernels belongs to a phase, not either kernel.
    unsigned bit = [label isEqualToString:@"q36_attention_f16_scores_segment"] ? 1u :
                   [label isEqualToString:@"q36_attention_f16_max_segment"] ? 2u :
                   [label isEqualToString:@"q36_attention_f16_weights_segment"] ? 4u :
                   [label isEqualToString:@"q36_attention_f16_values_segment"] ? 8u : 16u;
    _owner.kernelMask |= bit;
    _real.label = label;
}
- (void)setBytes:(const void *)bytes length:(NSUInteger)length atIndex:(NSUInteger)index {
    if (index == 8 && length == 9 * sizeof(uint32_t)) _span = ((const uint32_t *)bytes)[8];
    [_real setBytes:bytes length:length atIndex:index];
}
- (void)setComputePipelineState:(id<MTLComputePipelineState>)pipeline {
    if (pipeline.staticThreadgroupMemoryLength > max_static_threadgroup_bytes)
        max_static_threadgroup_bytes = pipeline.staticThreadgroupMemoryLength;
    [_real setComputePipelineState:pipeline];
}
- (void)dispatchThreadgroups:(MTLSize)groups threadsPerThreadgroup:(MTLSize)threads {
    if (_span) {
        bounded_encoders++;
        if (_span > max_key_span) max_key_span = _span;
        if (groups.width * groups.height > max_query_heads) max_query_heads = (unsigned)(groups.width * groups.height);
    }
    [_real dispatchThreadgroups:groups threadsPerThreadgroup:threads];
}
- (void)endEncoding {
    [_real endEncoding];
    // Explicit diagnostic only: isolate each stage in a command buffer so the
    // driver's GPU timestamps identify its cost. This perturbs scheduling and
    // must not be presented as production latency or compared to a normal run.
    if (isolated_encoders) CHECK(q36_metal_wait());
}
@end

// Test-only transparent wrappers observe actual submitted command buffers.
// No timers, wrappers or new profiling cost enter the production engine.
static double now_ms(void);
@implementation AttentionBufferProbe
- (id)forwardingTargetForSelector:(SEL)selector { return _real; }
- (id<MTLComputeCommandEncoder>)computeCommandEncoder {
    if (++encoder_calls == encoder_fail_at) return nil;
    AttentionEncoderProbe *encoder = [AttentionEncoderProbe new]; encoder.real = [_real computeCommandEncoder];
    encoder.owner = self;
    return encoder.real ? (id<MTLComputeCommandEncoder>)encoder : nil;
}
- (void)waitUntilCompleted {
    if (pthread_mutex_trylock(&q36_mu) != 0) locked_waits++;
    else pthread_mutex_unlock(&q36_mu);
    const double started = now_ms();
    [_real waitUntilCompleted];
    command_wait_ms += now_ms() - started;
    command_count++;
    phase_commands[_kernelMask]++;
    const double ms = 1000.0 * (_real.GPUEndTime - _real.GPUStartTime);
    if (ms > 0 && isfinite(ms)) {
        command_gpu_ms += ms;
        phase_gpu_ms[_kernelMask] += ms;
        if (ms > max_command_gpu_ms) max_command_gpu_ms = ms;
    }
}
@end
@interface AttentionQueueProbe : NSObject
@property(strong) id<MTLCommandQueue> real;
@property unsigned calls;
@property unsigned failAt;
@end
@implementation AttentionQueueProbe
- (id)forwardingTargetForSelector:(SEL)selector { return _real; }
- (id<MTLCommandBuffer>)commandBuffer {
    if (++_calls == _failAt) return nil;
    AttentionBufferProbe *buffer = [AttentionBufferProbe new];
    buffer.real = [_real commandBuffer];
    return buffer.real ? (id<MTLCommandBuffer>)buffer : nil;
}
@end

static double now_ms(void) {
    struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t);
    return t.tv_sec * 1000.0 + t.tv_nsec / 1000000.0;
}

// Dispatch the unchanged original shader directly, not the newly segmented
// production wrapper. Otherwise a one-query comparison could compare the new
// path with itself and silently lose its independent scheduling oracle.
static int reference_query(q36_gpu_tensor *out, const q36_gpu_tensor *q,
                            const q36_gpu_tensor *gate, const q36_gpu_tensor *k,
                            const q36_gpu_tensor *v, q36_gpu_tensor *scores,
                            uint32_t position, uint32_t heads, uint32_t kv_heads,
                            uint32_t dim, const void *sink_map, uint64_t sink_size) {
    struct { uint32_t pos0, heads, kv_heads, dim, qg_stride, has_sinks, score_stride; }
        args = {position, heads, kv_heads, dim, heads * dim * 2u, sink_map != NULL, heads * (position + 1u)};
    uint64_t inner = 0;
    id<MTLBuffer> sinks = sink_map ? q36_model_view(sink_map, sink_size, 64, heads * sizeof(float), &inner) : gate->buffer;
    if (!sinks) return 0;
    id<MTLComputeCommandEncoder> enc = q36_encoder(@"q36_attention_f16_parallel");
    if (!enc) return 0;
    [enc setBuffer:out->buffer offset:out->offset atIndex:0];
    [enc setBuffer:scores->buffer offset:scores->offset atIndex:1];
    [enc setBuffer:q->buffer offset:q->offset atIndex:2];
    [enc setBuffer:gate->buffer offset:gate->offset atIndex:3];
    [enc setBuffer:k->buffer offset:k->offset atIndex:4];
    [enc setBuffer:v->buffer offset:v->offset atIndex:5];
    [enc setBuffer:sinks offset:sink_map ? inner : gate->offset atIndex:6];
    [enc setBytes:&args length:sizeof(args) atIndex:7];
    [enc setThreadgroupMemoryLength:8u * sizeof(float) atIndex:0];
    [enc dispatchThreadgroups:MTLSizeMake(heads,1,1) threadsPerThreadgroup:MTLSizeMake(256,1,1)];
    [enc endEncoding];
    return q36_gpu_synchronize();
}

static void attention_case_dim(uint32_t heads, uint32_t kv_heads,
                               uint32_t pos0, uint32_t tokens, unsigned pattern,
                               uint32_t dim) {
    const bool uniform = pattern == 1 || pattern == 4, extreme = pattern == 2 || pattern == 5;
    const bool with_sinks = pattern >= 3;
    const uint32_t end = pos0 + tokens;
    const size_t row = (size_t)heads * dim, kvrow = (size_t)kv_heads * dim;
    const size_t count = row * tokens, kvcount = kvrow * end, guard = 16;
    const size_t scores_count = (size_t)heads * end * tokens;
    float *q = calloc(count, sizeof(float)), *g = calloc(count * 2, sizeof(float));
    _Float16 *k = malloc(kvcount * sizeof(_Float16)), *v = malloc(kvcount * sizeof(_Float16));
    float *got = malloc((count + 2 * guard) * sizeof(float));
    float *serial = malloc(row * sizeof(float));
    void *sink_map = NULL; const size_t sink_size = (size_t)getpagesize();
    if (with_sinks) {
        CHECK(posix_memalign(&sink_map, sink_size, sink_size) == 0);
        if (!sink_map) goto done;
        memset(sink_map, 0, sink_size);
        float *sinks = (float *)((char *)sink_map + 64);
        for (uint32_t h = 0; h < heads; h++) sinks[h] = uniform ? 0 : ((int)(h % 5) - 2) * 10.0f;
    }
    CHECK(q && g && k && v && got && serial);
    if (!q || !g || !k || !v || !got || !serial) goto done;
    for (size_t i = 0; i < count; i++)
        q[i] = uniform ? 0 : (float)((int)(i * 7 % 19) - 9) * (extreme ? 2.0f : 1.0f/32);
    for (size_t i = 0; i < count * 2; i++) g[i] = extreme ? ((int)(i % 5) - 2) * 40.0f : 0;
    for (size_t i = 0; i < kvcount; i++) {
        k[i] = (_Float16)((float)((int)(i * 13 % 17) - 8) * (extreme ? 2.0f : 1.0f/16));
        // Uniform logits have an independently known exact result, including
        // the GQA head mapping. Other cases exercise nonconstant values.
        v[i] = uniform ? (_Float16)((float)(i / dim % kv_heads + 1) / 8)
                       : (_Float16)((float)((int)(i * 11 % 23) - 11) / 16);
        if (extreme) v[i] = (_Float16)(i % 3 == 0 ? 0x1p-24f : (i % 3 == 1 ? -32752.0f : 8192.0f));
    }
    for (size_t i = 0; i < count + 2 * guard; i++) got[i] = -913;
    q36_gpu_tensor *qt = q36_gpu_tensor_alloc(count * sizeof(float));
    q36_gpu_tensor *gt = q36_gpu_tensor_alloc(count * 2 * sizeof(float));
    q36_gpu_tensor *kt = q36_gpu_tensor_alloc(kvcount * sizeof(_Float16));
    q36_gpu_tensor *vt = q36_gpu_tensor_alloc(kvcount * sizeof(_Float16));
    q36_gpu_tensor *base = q36_gpu_tensor_alloc((count + 2 * guard) * sizeof(float));
    q36_gpu_tensor *out = q36_gpu_tensor_view(base, guard * sizeof(float), count * sizeof(float));
    q36_gpu_tensor *scores = q36_gpu_tensor_alloc(scores_count * sizeof(float));
    q36_gpu_tensor *one = q36_gpu_tensor_alloc(row * sizeof(float));
    CHECK(qt && gt && kt && vt && base && out && scores && one);
    if (!(qt && gt && kt && vt && base && out && scores && one)) goto tensors;
    CHECK(q36_gpu_tensor_write(qt, 0, q, count * sizeof(float)));
    CHECK(q36_gpu_tensor_write(gt, 0, g, count * 2 * sizeof(float)));
    CHECK(q36_gpu_tensor_write(kt, 0, k, kvcount * sizeof(_Float16)));
    CHECK(q36_gpu_tensor_write(vt, 0, v, kvcount * sizeof(_Float16)));
    CHECK(q36_gpu_tensor_write(base, 0, got, (count + 2 * guard) * sizeof(float)));
    CHECK(q36_gpu_synchronize());
    command_count = locked_waits = 0; command_gpu_ms = max_command_gpu_ms = command_wait_ms = 0;
    memset(phase_gpu_ms, 0, sizeof(phase_gpu_ms));
    memset(phase_commands, 0, sizeof(phase_commands));
    max_static_threadgroup_bytes = 0;
    bounded_encoders = max_key_span = max_query_heads = 0;
    const uint64_t live_before = q36_live_bytes; q36_peak_bytes = live_before;
    const double started = now_ms();
    const int admitted = q36_gpu_attn_decode_tensor(out, qt, gt, kt, vt, scores,
        sink_map, sink_size, 64, with_sinks, pos0, tokens, heads, kv_heads, dim, 0, 0,
        (uint32_t)kvrow * 2, (uint32_t)kvrow * 2);
    const int completed = q36_gpu_synchronize();
    const double elapsed = now_ms() - started;
    const unsigned measured_commands = command_count, measured_locked = locked_waits;
    const unsigned measured_bounded = bounded_encoders, measured_span = max_key_span, measured_pairs = max_query_heads;
    const uint64_t scratch_bytes = q36_peak_bytes - live_before;
    const NSUInteger measured_threadgroup_bytes = max_static_threadgroup_bytes;
    const double measured_gpu = command_gpu_ms, measured_max_gpu = max_command_gpu_ms;
    const double measured_wait = command_wait_ms;
    const double score_max_gpu = phase_gpu_ms[3], weights_values_gpu = phase_gpu_ms[12];
    const double scores_gpu = phase_gpu_ms[1], max_gpu = phase_gpu_ms[2];
    const double weights_gpu = phase_gpu_ms[4], values_gpu = phase_gpu_ms[8];
    const unsigned score_commands = phase_commands[3], value_commands = phase_commands[12];
    CHECK(admitted && completed);
    CHECK(measured_locked == 0);
    CHECK(q36_live_bytes == live_before);
    CHECK(measured_threadgroup_bytes <= 4096u);
    if (segmented_check && end > 1024) {
        CHECK(measured_bounded > 0 && measured_span <= 1024 && measured_pairs <= 8192);
        CHECK(scratch_bytes > 0 && scratch_bytes <= 65536);
        if (isolated_encoders) {
            CHECK(phase_commands[1] > 0 && phase_commands[1] == phase_commands[2] &&
                  phase_commands[2] == phase_commands[4] && phase_commands[4] == phase_commands[8]);
            CHECK(phase_commands[1] * 4u == measured_commands);
            CHECK(fabs(scores_gpu + max_gpu + weights_gpu + values_gpu - measured_gpu) < 1e-6);
        } else {
            CHECK(score_commands > 0 && score_commands == value_commands);
            CHECK(score_commands + value_commands == measured_commands);
            CHECK(fabs(score_max_gpu + weights_values_gpu - measured_gpu) < 1e-6);
        }
    }
    // The production failure combined all 128 long-context queries in one
    // command. Observe actual submission, not a source spelling or flag.
    if (tokens == 128 && pos0 >= 25000) CHECK(measured_commands > 1);
    bool exact = admitted && completed;
    double max_uniform_error = 0;
    if (exact) {
        CHECK(q36_gpu_tensor_read(base, 0, got, (count + 2 * guard) * sizeof(float)));
        for (size_t i = 0; i < guard; i++) CHECK(got[i] == -913 && got[guard + count + i] == -913);
        for (size_t i = 0; i < count; i++) {
            if (!isfinite(got[guard + i])) exact = false;
            if (uniform) {
                double want = (double)((i / dim % heads) / (heads / kv_heads) + 1) / 16;
                if (with_sinks) {const double n = pos0 + i / row + 1; want *= n / (n + 1);}
                const double error = fabs(got[guard + i] - want);
                if (error > max_uniform_error) max_uniform_error = error;
                // Analytic real-number result versus GPU FP32 reciprocal and
                // multiply: allow eight FP32 epsilons, not bitwise real math.
                // The GPU scheduling comparison below remains byte-exact.
                if (error > 8 * FLT_EPSILON) exact = false;
            }
        }
        // Compare every query to the unchanged single-query path, including
        // each tile boundary, causal frontier and GQA output-row identity.
        for (uint32_t t = 0; t < tokens; t++) {
            q36_gpu_tensor *qv = q36_gpu_tensor_view(qt, t * row * sizeof(float), row * sizeof(float));
            q36_gpu_tensor *gv = q36_gpu_tensor_view(gt, t * row * 2 * sizeof(float), row * 2 * sizeof(float));
            int ok = reference_query(one, qv, gv, kt, vt, scores, pos0 + t, heads, kv_heads, dim, sink_map, sink_size);
            ok = ok && q36_gpu_tensor_read(one, 0, serial, row * sizeof(float));
            CHECK(ok);
            if (!ok || memcmp(serial, got + guard + t * row, row * sizeof(float))) exact = false;
            q36_gpu_tensor_free(qv); q36_gpu_tensor_free(gv);
        }
    }
    CHECK(exact);
    printf("{\"heads\":%u,\"kvHeads\":%u,\"position\":%u,\"tokens\":%u,\"dim\":%u,"
           "\"pattern\":%u,\"uniform\":%s,\"admitted\":%s,\"completed\":%s,\"exact\":%s,"
           "\"commandBuffers\":%u,\"waitsUnderLock\":%u,\"wallMs\":%.6f,"
           "\"gpuMs\":%.6f,\"maxCommandGpuMs\":%.6f,\"maxAnalyticError\":%.9g,"
           "\"waitWallMs\":%.6f,\"scoreMaximumGpuMs\":%.6f,\"weightsValuesGpuMs\":%.6f,"
           "\"scoreMaximumCommands\":%u,\"weightsValuesCommands\":%u,"
           "\"isolatedStageDiagnostic\":%s,\"scoresGpuMs\":%.6f,\"maximumGpuMs\":%.6f,"
           "\"weightsGpuMs\":%.6f,\"valuesGpuMs\":%.6f,"
           "\"boundedEncoders\":%u,\"maxKeySpan\":%u,\"maxQueryHeads\":%u,\"scratchBytes\":%llu,"
           "\"maxStaticThreadgroupBytes\":%lu}\n",
           heads, kv_heads, pos0, tokens, dim, pattern, uniform ? "true" : "false",
           admitted ? "true" : "false", completed ? "true" : "false",
           exact ? "true" : "false", measured_commands, measured_locked,
           elapsed, measured_gpu, measured_max_gpu, max_uniform_error,
           measured_wait, score_max_gpu, weights_values_gpu, score_commands, value_commands,
           isolated_encoders ? "true" : "false", scores_gpu, max_gpu, weights_gpu, values_gpu,
           measured_bounded, measured_span, measured_pairs, (unsigned long long)scratch_bytes,
           (unsigned long)measured_threadgroup_bytes);
    fflush(stdout);
    if (pos0 == 31 || pos0 == 1024) {
        q36_gpu_tensor *views[] = {out, qt, gt, kt, vt, scores};
        for (unsigned shortened = 0; shortened < 6; shortened++) {
            q36_gpu_tensor *short_view = q36_gpu_tensor_view(views[shortened], 0, views[shortened]->bytes - 1);
            CHECK(short_view != NULL);
            q36_gpu_tensor *input[6]; memcpy(input, views, sizeof(input)); input[shortened] = short_view;
            command_count = 0;
            CHECK(!q36_gpu_attn_decode_tensor(input[0], input[1], input[2], input[3], input[4], input[5],
                sink_map, sink_size, 64, with_sinks, pos0, tokens, heads, kv_heads, dim, 0, 0,
                (uint32_t)kvrow * 2, (uint32_t)kvrow * 2));
            CHECK(q36_gpu_synchronize() && command_count == 0);
            float *after = malloc((count + 2 * guard) * sizeof(float)); CHECK(after != NULL);
            if (after) {
                CHECK(q36_gpu_tensor_read(base, 0, after, (count + 2 * guard) * sizeof(float)));
                CHECK(memcmp(after, got, (count + 2 * guard) * sizeof(float)) == 0);
            }
            free(after); q36_gpu_tensor_free(short_view);
        }
        CHECK(!q36_gpu_attn_decode_tensor(out, qt, gt, kt, vt, scores,
            sink_map, sink_size, 64, with_sinks, UINT32_MAX, tokens, heads, kv_heads, dim, 0, 0,
            (uint32_t)kvrow * 2, (uint32_t)kvrow * 2));
        CHECK(q36_gpu_synchronize());
        if (segmented_check && pos0 == 1024) {
            AttentionDeviceProbe *device = (AttentionDeviceProbe *)q36_device;
            device.failAllocation = true; command_count = 0;
            CHECK(!q36_gpu_attn_decode_tensor(out, qt, gt, kt, vt, scores,
                sink_map, sink_size, 64, with_sinks, pos0, tokens, heads, kv_heads, dim, 0, 0,
                (uint32_t)kvrow * 2, (uint32_t)kvrow * 2));
            CHECK(q36_gpu_synchronize() && command_count == 0 && q36_live_bytes == live_before);
            device.failAllocation = false;
            float *after = malloc((count + 2 * guard) * sizeof(float)); CHECK(after != NULL);
            if (after) {
                CHECK(q36_gpu_tensor_read(base, 0, after, (count + 2 * guard) * sizeof(float)));
                CHECK(memcmp(after, got, (count + 2 * guard) * sizeof(float)) == 0);
            }
            free(after);
        }
        if (segmented_check && pos0 == 1024 && pattern == 0) {
            float *after = malloc((count + 2 * guard) * sizeof(float)); CHECK(after != NULL);
            // Two segments, two passes, two encoders per command. Reject at
            // every stage, including after a private partial value was prepared.
            // No unsubmitted half-command may leak into a later operation.
            for (unsigned fail_at = 1; after && fail_at <= 8; fail_at++) {
                CHECK(q36_gpu_tensor_write(base, 0, got, (count + 2 * guard) * sizeof(float)));
                encoder_calls = command_count = 0; encoder_fail_at = fail_at;
                CHECK(!q36_gpu_attn_decode_tensor(out, qt, gt, kt, vt, scores,
                    sink_map, sink_size, 64, with_sinks, pos0, tokens, heads, kv_heads, dim, 0, 0,
                    (uint32_t)kvrow * 2, (uint32_t)kvrow * 2));
                CHECK(encoder_calls == fail_at && q36_batch == nil);
                CHECK(command_count == (fail_at - 1u) / 2u && q36_live_bytes == live_before);
                CHECK(q36_gpu_synchronize() && command_count == (fail_at - 1u) / 2u);
                encoder_fail_at = 0;
                CHECK(q36_gpu_tensor_read(base, 0, after, (count + 2 * guard) * sizeof(float)));
                if (fail_at <= 6) CHECK(memcmp(after, got, (count + 2 * guard) * sizeof(float)) == 0);
                for (size_t i = 0; i < guard; i++) CHECK(after[i] == -913 && after[guard + count + i] == -913);
            }
            encoder_fail_at = 0;
            CHECK(q36_gpu_attn_decode_tensor(out, qt, gt, kt, vt, scores,
                sink_map, sink_size, 64, with_sinks, pos0, tokens, heads, kv_heads, dim, 0, 0,
                (uint32_t)kvrow * 2, (uint32_t)kvrow * 2));
            CHECK(q36_gpu_synchronize() && q36_live_bytes == live_before);
            if (after) {
                CHECK(q36_gpu_tensor_read(base, 0, after, (count + 2 * guard) * sizeof(float)));
                CHECK(memcmp(after, got, (count + 2 * guard) * sizeof(float)) == 0);
            }
            free(after);
        }
    }
    if (pos0 == 25344) {
        AttentionQueueProbe *queue = (AttentionQueueProbe *)q36_queue;
        for (size_t i = 0; i < count + 2 * guard; i++) got[i] = -913;
        CHECK(q36_gpu_tensor_write(base, 0, got, (count + 2 * guard) * sizeof(float)));
        queue.calls = 0; queue.failAt = 2; command_count = 0;
        CHECK(!q36_gpu_attn_decode_tensor(out, qt, gt, kt, vt, scores,
            NULL, 0, 0, false, pos0, tokens, heads, kv_heads, dim, 0, 0,
            (uint32_t)kvrow * 2, (uint32_t)kvrow * 2));
        CHECK(queue.calls == 2 && command_count == 1 && locked_waits == 0);
        queue.failAt = 0;
        CHECK(q36_gpu_tensor_read(base, 0, got, (count + 2 * guard) * sizeof(float)));
        // No automatic replay or later tile runs after failure. The caller
        // must discard its private candidate; prior committed KV is not here.
        const size_t tile = (8u * 1024u * 1024u) / ((size_t)heads * end);
        // The old first submission finished a query tile. The new first
        // submission prepares only scores/maxima, so no value is published.
        if (segmented_check) {
            for (size_t i = 0; i < count; i++) CHECK(got[guard + i] == -913);
            CHECK(q36_live_bytes == live_before);
        } else CHECK(got[guard] != -913);
        for (size_t i = tile * row; i < count; i++) CHECK(got[guard + i] == -913);
        for (size_t i = 0; i < guard; i++) CHECK(got[i] == -913 && got[guard + count + i] == -913);
        CHECK(q36_gpu_attn_decode_tensor(out, qt, gt, kt, vt, scores,
            NULL, 0, 0, false, pos0, tokens, heads, kv_heads, dim, 0, 0,
            (uint32_t)kvrow * 2, (uint32_t)kvrow * 2));
        CHECK(q36_gpu_synchronize());
    }
tensors:
    q36_gpu_tensor_free(one); q36_gpu_tensor_free(scores); q36_gpu_tensor_free(out);
    q36_gpu_tensor_free(base); q36_gpu_tensor_free(vt); q36_gpu_tensor_free(kt);
    q36_gpu_tensor_free(gt); q36_gpu_tensor_free(qt);
done:
    free(q); free(g); free(k); free(v); free(got); free(serial); free(sink_map);
}

static void attention_case(uint32_t heads, uint32_t kv_heads,
                           uint32_t pos0, uint32_t tokens, unsigned pattern) {
    attention_case_dim(heads, kv_heads, pos0, tokens, pattern, 256);
}

int main(int argc, char **argv) {
    isolated_encoders = argc == 2 && !strcmp(argv[1], "--profile-stages");
    segmented_check = isolated_encoders || (argc == 2 && !strcmp(argv[1], "--segmented"));
    if (argc > 2 || (argc == 2 && !segmented_check)) return 2;
    @autoreleasepool {
        if (!q36_gpu_init()) { fprintf(stderr, "Metal unavailable: NOT RUN\n"); return 2; }
        id<MTLCommandQueue> real = q36_queue;
        id<MTLDevice> real_device = q36_device;
        AttentionDeviceProbe *device = [AttentionDeviceProbe new]; device.real = real_device;
        q36_device = (id<MTLDevice>)device;
        AttentionQueueProbe *probe = [AttentionQueueProbe new]; probe.real = real;
        q36_queue = (id<MTLCommandQueue>)probe;
        q36_gpu_set_quality(true);
        if (isolated_encoders) {
            attention_case(24, 4, 27196, 12, false);
            attention_case(24, 4, 50741, 128, false);
        } else {
        attention_case(16, 2, 17, 5, false);
        attention_case(24, 4, 31, 17, false);
        attention_case(24, 4, 1023, 1, false);
        attention_case(24, 4, 1023, 2, false);
        attention_case(24, 4, 1024, 17, false);
        attention_case(24, 4, 1000, 400, false);
        attention_case(24, 4, 27196, 12, false);
        attention_case(16, 2, 1023, 5, 2);
        attention_case(24, 4, 27196, 12, 5);
        attention_case(24, 4, 1024, 17, 3);
        attention_case(24, 4, 27196, 12, 4);
        attention_case(24, 4, 25344, 128, true);
        attention_case(24, 4, 50741, 128, false);
        // The API admits smaller dimensions and arbitrary integral GQA ratios.
        // Inactive lanes must still reach shared-memory barriers, then leave
        // without touching output; exercise lane, head and eight-value tails.
        attention_case_dim(8, 8, 1024, 3, 0, 1);
        attention_case_dim(18, 2, 1023, 7, 2, 33);
        attention_case_dim(42, 2, 2047, 9, 3, 128);
        attention_case_dim(24, 4, 1024, 17, 4, 64);
        attention_case_dim(16, 2, 50741, 5, 5, 256);
        }
        CHECK(allocation_lock_violations == 0);
        q36_queue = real; q36_device = real_device; q36_gpu_cleanup();
        printf("{\"checks\":%u,\"failures\":%u,\"passed\":%s}\n",
               checks, failures, failures ? "false" : "true");
        return failures ? 1 : 0;
    }
}

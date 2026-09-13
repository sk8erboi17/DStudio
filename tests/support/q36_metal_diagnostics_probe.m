// Actual Metal allocation/submission plus explicitly simulated error receipts.
// No model weights and no intentionally invalid GPU command are submitted.
#include DSTUDIO_Q36_METAL_SOURCE
#include <assert.h>

@interface DiagnosticInfoFixture : NSObject <MTLCommandBufferEncoderInfo>
@property(copy) NSString *label;
@property(copy) NSArray<NSString *> *debugSignposts;
@property MTLCommandEncoderErrorState errorState;
@end
@implementation DiagnosticInfoFixture
@end

@interface DiagnosticFailureFixture : NSObject
@property(copy) NSString *label;
@property(strong) NSError *error;
@property unsigned commits;
@property unsigned waits;
@end
@implementation DiagnosticFailureFixture
- (MTLCommandBufferStatus)status { return MTLCommandBufferStatusError; }
- (void)commit {
    assert(pthread_mutex_trylock(&q36_mu) == 0);
    pthread_mutex_unlock(&q36_mu);
    _commits++;
}
- (void)waitUntilCompleted {
    assert(pthread_mutex_trylock(&q36_mu) == 0);
    pthread_mutex_unlock(&q36_mu);
    _waits++;
}
@end

int main(int argc, char **argv) {
    @autoreleasepool {
        assert(argc == 2);
        const bool enabled = !strcmp(argv[1], "on");
        assert(q36_gpu_init());
        assert(q36_error_details_enabled == enabled);
        float input[64], expected[64], observed[64];
        for (unsigned i = 0; i < 64; i++) {
            input[i] = (float)i / 4;
            expected[i] = input[i] + input[i];
        }
        q36_gpu_tensor *a = q36_gpu_tensor_alloc(sizeof(input));
        q36_gpu_tensor *out = q36_gpu_tensor_alloc(sizeof(input));
        assert(a && out);
        assert(q36_gpu_tensor_write(a, 0, input, sizeof(input)));
        assert(q36_gpu_add_tensor(out, a, a, 64));
        assert(q36_batch && q36_batch.retainedReferences);
        assert(q36_batch.errorOptions == (enabled ?
            MTLCommandBufferErrorOptionEncoderExecutionStatus : MTLCommandBufferErrorOptionNone));
        assert(q36_gpu_tensor_read(out, 0, observed, sizeof(observed)));
        assert(!memcmp(expected, observed, sizeof(expected)));
        assert(q36_error_details_reports == 0);
        q36_gpu_tensor_free(out); q36_gpu_tensor_free(a);

        NSMutableArray *infos = [NSMutableArray array];
        for (unsigned i = 0; i < 100; i++) {
            DiagnosticInfoFixture *info = [DiagnosticInfoFixture new];
            info.label = [@"fixture-" stringByPaddingToLength:1024 withString:@"x" startingAtIndex:0];
            info.debugSignposts = @[];
            info.errorState = (MTLCommandEncoderErrorState)(i % 5);
            [infos addObject:info];
        }
        for (unsigned i = 0; i < 5; i++) {
            DiagnosticFailureFixture *failure = [DiagnosticFailureFixture new];
            failure.label = @"simulated-error-formatter-not-a-driver-failure";
            failure.error = [NSError errorWithDomain:@"test-fixture" code:7
                userInfo:(i == 3 ? @{} : @{MTLCommandBufferEncoderInfoErrorKey: infos})];
            q36_batch = (id<MTLCommandBuffer>)failure;
            assert(!q36_metal_wait());
            assert(!q36_batch && q36_last_gpu_seconds == 0);
            assert(failure.commits == 1 && failure.waits == 1); // never retry
            assert(q36_error_details_reports == (enabled ? (i < 4 ? i + 1 : 4) : 0));
        }
        q36_gpu_cleanup();
        assert(!q36_error_details_enabled);
        printf("{\"passed\":true,\"diagnostics\":%s,\"actualGpuValues\":64,"
               "\"simulatedErrors\":5,\"reports\":%u,\"tensorBytes\":%zu}\n",
               enabled ? "true" : "false", q36_error_details_reports, sizeof(q36_gpu_tensor));
    }
    return 0;
}

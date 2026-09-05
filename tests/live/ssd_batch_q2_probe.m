/* Model-free numerical regression for the production Metal address consumer.
 * Distinct expert resources across a batch are NOT the per-token route count. */
#include "ds4_metal.m"
bool ds4_log_is_tty(FILE *fp) { (void)fp; return false; }
#define CHECK(x) do { if (!(x)) { fprintf(stderr, "FAIL line %d: %s\n", __LINE__, #x); exit(1); } } while (0)
typedef struct { uint8_t scales[16], qs[64]; uint16_t d, dmin; } q2_block;
_Static_assert(sizeof(q2_block) == 84, "Q2_K layout");

static void batch(unsigned tokens, unsigned used, unsigned experts) {
    enum { INPUT=256, OUTPUT=32, ROW_BYTES=84 };
    CHECK(tokens * used >= experts);
    id<MTLBuffer> addresses=[g_device newBufferWithLength:384*8 options:MTLResourceStorageModeShared];
    id<MTLBuffer> ids=[g_device newBufferWithLength:tokens*used*4 options:MTLResourceStorageModeShared];
    id<MTLBuffer> input=[g_device newBufferWithLength:tokens*used*INPUT*4 options:MTLResourceStorageModeShared];
    id<MTLBuffer> output=[g_device newBufferWithLength:tokens*OUTPUT*4 options:MTLResourceStorageModeShared];
    CHECK(addresses && ids && input && output);
    memset(addresses.contents,0,addresses.length);
    ds4_gpu_stream_expert_cache_entry entries[384]={0};
    ds4_gpu_stream_expert_cache_entry *ptrs[384];
    for (unsigned e=0; e<experts; ++e) {
        id<MTLBuffer> weight=[g_device newBufferWithLength:OUTPUT*ROW_BYTES options:MTLResourceStorageModeShared];
        CHECK(weight);
        q2_block *blocks=weight.contents;
        for (unsigned row=0; row<OUTPUT; ++row) {
            memset(blocks[row].scales,1+row%4,16);
            memset(blocks[row].qs,(1+e%3)*0x55,64);
            blocks[row].d=0x3c00; blocks[row].dmin=0;
        }
        ((uint64_t *)addresses.contents)[e]=weight.gpuAddress;
        entries[e].down_buffer=weight; entries[e].valid=1; ptrs[e]=&entries[e];
    }
    for (unsigned t=0; t<tokens; ++t) {
        for (unsigned slot=0; slot<used; ++slot) {
            const unsigned pair=t*used+slot;
            ((int32_t *)ids.contents)[pair]=pair%experts;
            for (unsigned i=0; i<INPUT; ++i)
                ((float *)input.contents)[pair*INPUT+i]=(float)(1+slot+t%7)/16;
        }
        for (unsigned row=0; row<OUTPUT; ++row) ((float *)output.contents)[t*OUTPUT+row]=NAN;
    }
    ds4_gpu_mul_mv_id_args args={
        .nei0=(int)used, .nei1=(int)tokens, .nbi1=used*4,
        .ne00=INPUT, .ne01=OUTPUT, .ne02=384,
        .nb00=84, .nb01=ROW_BYTES, .nb02=OUTPUT*ROW_BYTES,
        .ne10=INPUT, .ne11=(int)used, .ne12=(int)tokens, .ne13=1,
        .nb10=4, .nb11=INPUT*4, .nb12=used*INPUT*4,
        .ne0=OUTPUT, .ne1=(int)tokens, .nb1=OUTPUT*4, .nr0=4
    };
    int owned=0;
    id<MTLCommandBuffer> cb=ds4_gpu_command_buffer(&owned);
    CHECK(cb);
    ds4_gpu_mul_mv_id_args invalid=args;
    for (unsigned bad=0; bad<=9; bad+=9) {
        invalid.nei0=(int)bad;
        CHECK(!ds4_gpu_encode_mul_mv_addr_q2_sum6(cb,g_moe_mul_mv_addr_q2_k_sum6_pipeline,
            &invalid,ptrs,experts,addresses,input,0,output,0,ids,0,0,2,nil));
    }
    CHECK(!ds4_gpu_encode_mul_mv_addr_q2_sum6(cb,g_moe_mul_mv_addr_q2_k_sum6_pipeline,
        &args,ptrs,385,addresses,input,0,output,0,ids,0,0,2,nil));
    const int encoded=ds4_gpu_encode_mul_mv_addr_q2_sum6(cb,g_moe_mul_mv_addr_q2_k_sum6_pipeline,
        &args,ptrs,experts,addresses,input,0,output,0,ids,0,0,2,nil);
    if (!encoded) { fprintf(stderr,"BATCH REJECTED: tokens=%u per_token=%u distinct=%u\n",tokens,used,experts); exit(1); }
    CHECK(ds4_gpu_finish_command_buffer(cb,owned,"Q2 batch CPU oracle"));
    for (unsigned t=0; t<tokens; ++t) {
        for (unsigned row=0; row<OUTPUT; ++row) {
            float expected=0;
            for (unsigned slot=0; slot<used; ++slot) {
                unsigned e=(t*used+slot)%experts;
                expected+=INPUT*(float)(1+slot+t%7)/16*(1+e%3)*(1+row%4);
            }
            float actual=((float *)output.contents)[t*OUTPUT+row];
            CHECK(isfinite(actual) && actual == expected);
        }
    }
    printf("Q2 EXACT CPU ORACLE PASS: tokens=%u per_token=%u distinct=%u values=%u\n",tokens,used,experts,tokens*OUTPUT);
}

int main(void) {
    @autoreleasepool {
        CHECK(ds4_gpu_init());
        batch(2,6,12);
        batch(139,6,30);
        batch(760,6,384);
        batch(2,8,16);
        ds4_gpu_cleanup();
    }
    return 0;
}

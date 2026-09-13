/* Actual native CPU/session preparation with initialized state (no weights or
 * forward inference). Deterministic allocator and cancellation failpoints;
 * ASan/UBSan check retirement. Counting memcpy proves active-row copy cost. */
#include <stdlib.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>
#include <stdio.h>

typedef union {max_align_t alignment; size_t bytes;} allocation_header;
static size_t allocation_calls, live_allocations, fail_at, copied_bytes;
static void *probe_malloc(size_t bytes) {
    if (++allocation_calls == fail_at || bytes > SIZE_MAX - sizeof(allocation_header)) return NULL;
    allocation_header *p = malloc(sizeof(*p) + (bytes ? bytes : 1));
    if (!p) return NULL;
    p->bytes = bytes; live_allocations++; return p + 1;
}
static void probe_free(void *ptr) {
    if (ptr) {live_allocations--; free((allocation_header *)ptr - 1);}
}
static void *probe_calloc(size_t count, size_t width) {
    if (width && count > SIZE_MAX / width) return NULL;
    size_t bytes = count * width; void *p = probe_malloc(bytes);
    if (p) memset(p, 0, bytes); return p;
}
static void *probe_realloc(void *ptr, size_t bytes) {
    if (!ptr) return probe_malloc(bytes);
    if (++allocation_calls == fail_at || bytes > SIZE_MAX - sizeof(allocation_header)) return NULL;
    allocation_header *p = realloc((allocation_header *)ptr - 1, sizeof(*p) + (bytes ? bytes : 1));
    if (!p) return NULL;
    p->bytes = bytes; return p + 1;
}
static void *probe_memcpy(void *dst, const void *src, size_t bytes) {
    copied_bytes += bytes; return memcpy(dst, src, bytes);
}
#define malloc probe_malloc
#define calloc probe_calloc
#define realloc probe_realloc
#define free probe_free
#define memcpy probe_memcpy
#define Q36_NO_GPU
#include "q36.c"
#undef malloc
#undef calloc
#undef realloc
#undef free
#undef memcpy

static int checks, failures, cases;
#define CHECK(test) do {checks++; if (!(test)) {failures++; \
    fprintf(stderr, "case=%d line=%d failed: %s\n", cases, __LINE__, #test);}} while (0)
static void fill(void *data, size_t bytes, unsigned seed) {
    unsigned char *p = data;
    for (size_t i = 0; i < bytes; i++) p[i] = (unsigned char)(seed + i * 7u);
}
static bool same(q36_session *a, q36_session *b) {
    if (a->checkpoint.len != b->checkpoint.len || a->checkpoint_valid != b->checkpoint_valid ||
        a->logits_host_valid != b->logits_host_valid || a->gpu_top2_valid != b->gpu_top2_valid ||
        a->mtp_draft_token != b->mtp_draft_token || a->mtp_draft_valid != b->mtp_draft_valid ||
        a->mtp_draft_margin != b->mtp_draft_margin || a->mtp_backoff != b->mtp_backoff ||
        a->mtp_backoff_len != b->mtp_backoff_len ||
        memcmp(a->checkpoint.v, b->checkpoint.v, (size_t)a->checkpoint.len * sizeof(int)) ||
        memcmp(a->logits, b->logits, Q36_N_VOCAB * sizeof(float)) ||
        memcmp(a->gpu_top2, b->gpu_top2, sizeof a->gpu_top2)) return false;
    if (a->mtp_logits && memcmp(a->mtp_logits, b->mtp_logits, Q36_N_VOCAB * sizeof(float))) return false;
    q36_cpu_runtime *ar = a->runtime, *br = b->runtime;
    for (unsigned il = 0; il < Q36_N_LAYER; il++) {
        if (q36_layer_is_full_attention(il)) {
            if (ar->full[il].len != br->full[il].len ||
                memcmp(ar->full[il].k, br->full[il].k, q36_full_k_bytes(a->checkpoint.len, ar->full[il].type_k)) ||
                memcmp(ar->full[il].v, br->full[il].v, q36_full_v_bytes(a->checkpoint.len, ar->full[il].type_v))) return false;
        } else if (memcmp(ar->recurrent[il].conv, br->recurrent[il].conv, q36_recurrent_conv_bytes()) ||
                   memcmp(ar->recurrent[il].state, br->recurrent[il].state, q36_recurrent_state_bytes())) return false;
    }
    return true;
}
typedef struct {int at, visits;} cancellation;
static bool cancel(void *ud) {cancellation *c = ud; return ++c->visits == c->at;}

static size_t exercise(q36_kv_cache_type k, q36_kv_cache_type v, int ctx, bool mtp) {
    q36_engine engine = {.backend = Q36_BACKEND_CPU, .cpu_prefill_cap = 2,
        .cache_type_k = k, .cache_type_v = v, .mtp_ready = mtp};
    q36_session *source = NULL, *reference = NULL;
    CHECK(q36_session_create(&source, &engine, ctx) == 0);
    if (!source) return 0;
    for (int i = 0; i < 3; i++) q36_tokens_push(&source->checkpoint, i + 1);
    source->checkpoint_valid = true; source->logits_host_valid = true; source->gpu_top2_valid = true;
    source->gpu_top2[0] = 3; source->gpu_top2[1] = 2; source->mtp_draft_token = 2;
    source->mtp_draft_valid = mtp; source->mtp_draft_margin = 2.5f;
    source->mtp_backoff = 2; source->mtp_backoff_len = 4;
    for (unsigned i = 0; i < Q36_N_VOCAB; i++) {
        source->logits[i] = (float)i / 3;
        if (mtp) source->mtp_logits[i] = (float)i / 7;
    }
    q36_cpu_runtime *rt = source->runtime;
    for (unsigned il = 0; il < Q36_N_LAYER; il++) {
        if (q36_layer_is_full_attention(il)) {
            rt->full[il].len = 3;
            fill(rt->full[il].k, q36_full_k_bytes(3, k), il);
            fill(rt->full[il].v, q36_full_v_bytes(3, v), il + 17);
        } else {
            fill(rt->recurrent[il].conv, q36_recurrent_conv_bytes(), il);
            fill(rt->recurrent[il].state, q36_recurrent_state_bytes(), il + 17);
        }
    }
    q36_tokens prompt = source->checkpoint;
    char error[128];
    allocation_calls = copied_bytes = 0;
    CHECK(q36_session_prepare_sync(&reference, source, &prompt, NULL, NULL, NULL, NULL, error, sizeof error) == 0);
    size_t copy_cost = copied_bytes, allocs = allocation_calls, live = live_allocations;
    CHECK(reference != source && same(source, reference));
    CHECK(reference->progress == NULL && reference->cancel == NULL && reference->engine == &engine);
    CHECK(reference->ctx_size == ctx);
#if !defined(DSTUDIO_Q36_PAYLOAD_BASELINE) && !defined(DSTUDIO_Q36_PAYLOAD_WRITE_ONLY)
    /* Fork is preparation only: an extended prefix must retain exactly the
     * source frontier, while a replacement starts empty. No weights are loaded,
     * so an accidental forward call cannot masquerade as a successful copy. */
    int extended_ids[] = {1, 2, 3, 4, 5};
    q36_tokens extended = {.v = extended_ids, .len = 5, .cap = 5};
    cases++; allocation_calls = 0; fail_at = 1;
    CHECK(q36_session_sync(reference, &extended, error, sizeof error) != 0);
    fail_at = 0;
    CHECK(allocation_calls == 1 && same(source, reference) && live_allocations == live);
    q36_session *forked = NULL;
    cases++;
    CHECK(q36_session_fork_for_prompt(&forked, source, &extended,
        NULL, NULL, error, sizeof error) == 0);
    CHECK(forked && forked != source && same(forked, reference));
    if (forked) {
        CHECK(forked->checkpoint.len == 3 && forked->checkpoint.cap >= 5);
        CHECK(forked->progress == NULL && forked->cancel == NULL);
        q36_session_free(forked);
    }
    for (int replacement = 0; replacement < 2; replacement++) {
        cases++;
        extended_ids[0] = replacement ? 1 : 9;
        extended.len = replacement ? 2 : 5;
        forked = NULL;
        CHECK(q36_session_fork_for_prompt(&forked, source, &extended,
            NULL, NULL, error, sizeof error) == 0);
        if (forked) {
            CHECK(forked->checkpoint.len == 0 && !forked->checkpoint_valid);
            CHECK(forked->checkpoint.cap >= extended.len);
            CHECK(forked->engine == source->engine && forked->ctx_size == ctx);
            CHECK(forked->mtp_backoff == source->mtp_backoff);
            CHECK(forked->progress == NULL && forked->cancel == NULL);
            q36_session_free(forked);
        }
        CHECK(same(source, reference) && live_allocations == live);
    }
#endif
    for (size_t n = 1; n <= allocs; n++) {
        cases++; allocation_calls = 0; fail_at = n;
        q36_session *candidate = (q36_session *)(uintptr_t)1;
        int rc = q36_session_prepare_sync(&candidate, source, &prompt, NULL, NULL, NULL, NULL, error, sizeof error);
        fail_at = 0;
        CHECK(rc != 0 && candidate == (q36_session *)(uintptr_t)1);
        CHECK(live_allocations == live && same(source, reference));
    }
    for (int n = 1; n <= (int)Q36_N_LAYER + 3; n++) {
        cases++; cancellation c = {.at = n};
        q36_session *candidate = (q36_session *)(uintptr_t)1;
        int rc = q36_session_prepare_sync(&candidate, source, &prompt, NULL, NULL, cancel, &c, error, sizeof error);
        CHECK(rc == Q36_SESSION_SYNC_INTERRUPTED && candidate == (q36_session *)(uintptr_t)1);
        CHECK(live_allocations == live && same(source, reference));
    }
    cases++;
    q36_session *candidate = (q36_session *)(uintptr_t)1;
    prompt.len = ctx;
    CHECK(q36_session_prepare_sync(&candidate, source, &prompt, NULL, NULL, NULL, NULL, error, sizeof error) != 0);
    CHECK(candidate == (q36_session *)(uintptr_t)1 && live_allocations == live && same(source, reference));
    prompt.len = source->checkpoint.len;
    for (int change = 0; change < 2; change++) {
        cases++;
        if (!change) engine.cpu_prefill_cap = 4;
        else engine.cache_type_k = (k + 1) % 3;
        candidate = (q36_session *)(uintptr_t)1;
        int rc = q36_session_prepare_sync(&candidate, source, &prompt, NULL, NULL, NULL, NULL, error, sizeof error);
        CHECK(rc != 0 && candidate == (q36_session *)(uintptr_t)1);
        if (candidate && candidate != (q36_session *)(uintptr_t)1) q36_session_free(candidate);
        engine.cpu_prefill_cap = 2; engine.cache_type_k = k;
        CHECK(live_allocations == live && same(source, reference));
    }
    q36_session_free(reference); q36_session_free(source);
    CHECK(live_allocations == 0);
    return copy_cost;
}

int main(void) {
    g_q36_shape = Q36_SHAPE_27B;
    g_q36_shape.n_layer = 4; g_q36_shape.n_embd = 32; g_q36_shape.n_vocab = 32;
    g_q36_shape.n_head = 1; g_q36_shape.n_head_kv = 1; g_q36_shape.n_head_dim = 32;
    g_q36_shape.n_value_dim = 32; g_q36_shape.n_ff_shared = 64;
    g_q36_shape.n_ssm_state = 2; g_q36_shape.n_ssm_dt_rank = 2;
    g_q36_shape.n_ssm_conv = 4; g_q36_shape.n_ssm_group = 1; g_q36_shape.n_ssm_inner = 4;
    size_t copies[2] = {0};
    for (int type = 0; type <= Q36_KV_CACHE_Q4_0; type++) for (int other = 0; other <= Q36_KV_CACHE_Q4_0; other++)
        for (int mtp = 0; mtp <= 1; mtp++) for (int size = 0; size < 2; size++) {
            cases++;
            copies[size] = exercise(type, other, size ? 4096 : 64, mtp);
            if (size) CHECK(copies[0] == copies[1]);
        }
    printf("{\"cases\":%d,\"checks\":%d,\"failures\":%d,\"liveAllocations\":%zu,"
           "\"copyBytes64\":%zu,\"copyBytes4096\":%zu,\"sessionBytes\":%zu}\n",
           cases, checks, failures, live_allocations, copies[0], copies[1], sizeof(q36_session));
    return failures ? 1 : 0;
}

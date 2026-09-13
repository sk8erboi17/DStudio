/* Initialized native CPU buffers test checkpoint ownership/copying only: no
 * projector, forward inference or claim that CPU supports visual generation.
 * Reuse the allocator/cancellation instrumentation and byte oracle, not a
 * second implementation of native session preparation. */
#define main text_prepare_fixture_main
#include "q36_text_prepare_unit.c"
#undef main

static bool same_visual(q36_session *a, q36_session *b) {
    if (!same(a, b) || a->vision_state != b->vision_state ||
        a->vision_count != b->vision_count || a->rope_delta != b->rope_delta) return false;
    for (size_t i = 0; i < a->vision_count; i++) {
        const q36_vision_span *x = &a->vision_spans[i], *y = &b->vision_spans[i];
        if (x->token_start != y->token_start || x->embedding.data || y->embedding.data ||
            x->embedding.token_count != y->embedding.token_count ||
            x->embedding.grid_width != y->embedding.grid_width ||
            x->embedding.grid_height != y->embedding.grid_height ||
            memcmp(x->embedding.fingerprint, y->embedding.fingerprint, 32)) return false;
    }
    return true;
}

static size_t exercise_visual(q36_kv_cache_type k, q36_kv_cache_type v, int ctx) {
    q36_engine engine = {.backend = Q36_BACKEND_CPU, .cpu_prefill_cap = 2,
        .cache_type_k = k, .cache_type_v = v};
    q36_session *source = NULL, *reference = NULL;
    CHECK(q36_session_create(&source, &engine, ctx) == 0);
    if (!source) return 0;
    const int prefix[] = {3, 20, 21, 22, 4, 5, 6};
    for (size_t i = 0; i < sizeof(prefix) / sizeof(*prefix); i++) q36_tokens_push(&source->checkpoint, prefix[i]);
    source->checkpoint_valid = true; source->logits_host_valid = true;
    source->vision_state = true; source->rope_delta = -3;
    source->vision_count = 1;
    source->vision_spans = probe_calloc(1, sizeof(*source->vision_spans));
    CHECK(source->vision_spans != NULL);
    source->vision_spans[0] = (q36_vision_span){.token_start = 2,
        .embedding = {.token_count = 1, .grid_width = 1, .grid_height = 1}};
    memset(source->vision_spans[0].embedding.fingerprint, 0x35, 32);
    for (unsigned i = 0; i < Q36_N_VOCAB; i++) source->logits[i] = (float)i / 3;
    q36_cpu_runtime *rt = source->runtime;
    for (unsigned il = 0; il < Q36_N_LAYER; il++) {
        if (q36_layer_is_full_attention(il)) {
            rt->full[il].len = 7;
            fill(rt->full[il].k, q36_full_k_bytes(7, k), il);
            fill(rt->full[il].v, q36_full_v_bytes(7, v), il + 17);
        } else {
            fill(rt->recurrent[il].conv, q36_recurrent_conv_bytes(), il);
            fill(rt->recurrent[il].state, q36_recurrent_state_bytes(), il + 17);
        }
    }
    int token_ids[] = {3, 20, 21, 22, 4, 5, 6, 20, 21, 22, 8};
    q36_tokens prompt = {.v = token_ids, .len = 11, .cap = 11};
    q36_vision_span images[2] = {source->vision_spans[0], source->vision_spans[0]};
    images[1].token_start = 8;
    memset(images[1].embedding.fingerprint, 0x38, 32);
    char err[128];
    allocation_calls = copied_bytes = 0;
    CHECK(q36_session_fork_for_vision_prompt(&reference, source, &prompt,
        images, 2, NULL, NULL, err, sizeof(err)) == 0);
    size_t allocs = allocation_calls, bytes = copied_bytes, live = live_allocations;
    CHECK(reference && reference != source && same_visual(source, reference));
    if (!reference) {q36_session_free(source); return 0;}
    CHECK(reference->checkpoint.len == 7 && reference->checkpoint.cap >= 11);
    CHECK(reference->vision_count == 1 && reference->vision_spans != source->vision_spans);
    CHECK(reference->progress == NULL && reference->cancel == NULL);
    /* Candidate identity and runtime storage are independent of the source. */
    reference->vision_spans[0].embedding.fingerprint[0] ^= 1;
    CHECK(source->vision_spans[0].embedding.fingerprint[0] == 0x35);
    reference->vision_spans[0].embedding.fingerprint[0] ^= 1;
    for (size_t n = 1; n <= allocs; n++) {
        cases++; allocation_calls = 0; fail_at = n;
        q36_session *candidate = (q36_session *)(uintptr_t)1;
        int rc = q36_session_fork_for_vision_prompt(&candidate, source, &prompt,
            images, 2, NULL, NULL, err, sizeof(err));
        fail_at = 0;
        CHECK(rc != 0 && candidate == (q36_session *)(uintptr_t)1);
        CHECK(live_allocations == live && same_visual(source, reference));
    }
    for (int n = 1; n <= (int)Q36_N_LAYER + 2; n++) {
        cases++; cancellation c = {.at = n};
        q36_session *candidate = (q36_session *)(uintptr_t)1;
        int rc = q36_session_fork_for_vision_prompt(&candidate, source, &prompt,
            images, 2, cancel, &c, err, sizeof(err));
        CHECK(rc == Q36_SESSION_SYNC_INTERRUPTED && candidate == (q36_session *)(uintptr_t)1);
        CHECK(live_allocations == live && same_visual(source, reference));
    }
    for (int mismatch = 0; mismatch < 7; mismatch++) {
        cases++;
        images[0] = source->vision_spans[0];
        token_ids[0] = 3; images[1].token_start = 8;
        if (mismatch == 0) images[0].embedding.fingerprint[0] ^= 1;
        if (mismatch == 1) images[0].token_start++;
        if (mismatch == 2) images[0].embedding.token_count++;
        if (mismatch == 3) images[0].embedding.grid_width++;
        if (mismatch == 4) images[0].embedding.grid_height++;
        if (mismatch == 5) token_ids[0] = 9;
        if (mismatch == 6) images[1].token_start = 7; /* overlaps live frontier */
        q36_session *candidate = NULL;
        CHECK(q36_session_fork_for_vision_prompt(&candidate, source, &prompt,
            images, 2, NULL, NULL, err, sizeof(err)) == 0);
        if (candidate) {
            CHECK(candidate->checkpoint.len == 0 && !candidate->checkpoint_valid);
            CHECK(!candidate->vision_state && candidate->vision_count == 0 &&
                candidate->vision_spans == NULL && candidate->rope_delta == 0);
            q36_session_free(candidate);
        }
        CHECK(live_allocations == live && same_visual(source, reference));
    }
    images[0] = source->vision_spans[0]; token_ids[0] = 3; images[1].token_start = 8;
    for (int invalid = 0; invalid < 3; invalid++) {
        cases++; q36_session *candidate = (q36_session *)(uintptr_t)1;
        size_t before = allocation_calls;
        CHECK(q36_session_fork_for_vision_prompt(&candidate, source, &prompt,
            invalid == 0 ? NULL : images, invalid == 1 ? 0 : invalid == 2 ? 4 : 2,
            NULL, NULL, err, sizeof(err)) != 0);
        CHECK(candidate == (q36_session *)(uintptr_t)1 && allocation_calls == before);
        CHECK(live_allocations == live && same_visual(source, reference));
    }
    cases++; q36_session *text = NULL;
    CHECK(q36_session_fork_for_prompt(&text, source, &prompt, NULL, NULL, err, sizeof(err)) == 0);
    if (text) {
        CHECK(!text->vision_state && text->vision_count == 0 && text->checkpoint.len == 0);
        q36_session_free(text);
    }
    CHECK(same_visual(source, reference) && live_allocations == live);
    q36_session_free(reference); q36_session_free(source);
    CHECK(live_allocations == 0);
    return bytes;
}

int main(void) {
    g_q36_shape = Q36_SHAPE_27B;
    g_q36_shape.n_layer = 4; g_q36_shape.n_embd = 32; g_q36_shape.n_vocab = 32;
    g_q36_shape.n_head = 1; g_q36_shape.n_head_kv = 1; g_q36_shape.n_head_dim = 32;
    g_q36_shape.n_value_dim = 32; g_q36_shape.n_ff_shared = 64;
    g_q36_shape.n_ssm_state = 2; g_q36_shape.n_ssm_dt_rank = 2;
    g_q36_shape.n_ssm_conv = 4; g_q36_shape.n_ssm_group = 1; g_q36_shape.n_ssm_inner = 4;
    size_t copies[2] = {0};
    for (int k = 0; k <= Q36_KV_CACHE_Q4_0; k++) for (int v = 0; v <= Q36_KV_CACHE_Q4_0; v++)
        for (int size = 0; size < 2; size++) {
            cases++; copies[size] = exercise_visual(k, v, size ? 4096 : 64);
            if (size) CHECK(copies[0] == copies[1]);
        }
    printf("{\"cases\":%d,\"checks\":%d,\"failures\":%d,\"liveAllocations\":%zu,"
        "\"copyBytes64\":%zu,\"copyBytes4096\":%zu,\"sessionBytes\":%zu,\"spanBytes\":%zu}\n",
        cases, checks, failures, live_allocations, copies[0], copies[1], sizeof(q36_session), sizeof(q36_vision_span));
    return failures ? 1 : 0;
}

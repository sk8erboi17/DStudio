/* Production native payload restoration, including truncated reads and
 * cancellation. Reuse the allocator/state fixture, not a mock serializer. */
#include <assert.h>
#define main text_preparation_fixture_main
#include "q36_text_prepare_unit.c"
#undef main
#undef CHECK
#define CHECK(test) do {checks++; if (!(test)) {failures++; if (failures <= 64) \
    fprintf(stderr, "case=%d line=%d failed: %s\n", cases, __LINE__, #test);}} while (0)

typedef struct {const unsigned char *bytes; size_t size, pos, stop_at;} payload_input;
static int input_read(void *ud, char *dst, int count) {
    payload_input *in = ud;
    size_t n = in->size - in->pos;
    if (n > (size_t)count) n = (size_t)count;
    if (n > 65536) n = 65536;
    memcpy(dst, in->bytes + in->pos, n); in->pos += n;
    return (int)n;
}
static bool input_cancel(void *ud) {
    payload_input *in = ud;
    return in->stop_at != SIZE_MAX && in->pos >= in->stop_at;
}
#ifndef __APPLE__
static ssize_t input_cookie_read(void *ud, char *dst, size_t count) {
    return input_read(ud, dst, count > INT_MAX ? INT_MAX : (int)count);
}
#endif
static FILE *input_open(payload_input *in) {
#ifdef __APPLE__
    FILE *fp = funopen(in, input_read, NULL, NULL, NULL);
#else
    FILE *fp = fopencookie(in, "r", (cookie_io_functions_t){.read = input_cookie_read});
#endif
    if (fp) setvbuf(fp, NULL, _IONBF, 0);
    return fp;
}
static q36_session *state(q36_engine *engine, int ctx, int seed) {
    q36_session *s = NULL;
    if (q36_session_create(&s, engine, ctx)) return NULL;
    s->mtp_draft_margin = 0.25f;
    s->mtp_backoff = 3;
    s->mtp_backoff_len = 4;
    for (int i = 0; i < 3; i++) q36_tokens_push(&s->checkpoint, seed + i);
    s->checkpoint_valid = s->logits_host_valid = true;
    q36_cpu_runtime *rt = s->runtime;
    for (unsigned i = 0; i < Q36_N_VOCAB; i++) s->logits[i] = (float)(i + seed) / 3;
    for (unsigned il = 0; il < Q36_N_LAYER; il++) {
        if (q36_layer_is_full_attention(il)) {
            rt->full[il].len = 3;
            fill(rt->full[il].k, q36_full_k_bytes(3, rt->full[il].type_k), seed + il);
            fill(rt->full[il].v, q36_full_v_bytes(3, rt->full[il].type_v), seed + il + 17);
        } else {
            fill(rt->recurrent[il].conv, q36_recurrent_conv_bytes(), seed + il);
            fill(rt->recurrent[il].state, q36_recurrent_state_bytes(), seed + il + 17);
        }
    }
    return s;
}
static int prepared_load(q36_session **out, q36_session *source, FILE *fp,
                        uint64_t bytes, q36_session_cancel_fn cancel_fn, void *ud,
                        char *error, size_t error_len) {
#ifdef DSTUDIO_Q36_PAYLOAD_BASELINE
    q36_session_set_cancel(source, cancel_fn, ud);
    int rc = q36_session_load_payload(source, fp, bytes, error, error_len);
    q36_session_set_cancel(source, NULL, NULL);
    if (!rc) *out = source;
    return rc;
#else
    return q36_session_prepare_load_payload(out, source, fp, bytes,
                                            cancel_fn, ud, error, error_len);
#endif
}

static void payload_cases(q36_kv_cache_type k, q36_kv_cache_type v, int ctx) {
    q36_engine engine = {.backend = Q36_BACKEND_CPU, .cpu_prefill_cap = 2,
        .cache_type_k = k, .cache_type_v = v};
    q36_session *target = state(&engine, ctx, 11);
    CHECK(target != NULL); if (!target) return;
    char *payload = NULL, error[160]; size_t bytes = 0;
    FILE *writer = open_memstream(&payload, &bytes); CHECK(writer != NULL);
    CHECK(q36_session_save_payload(target, writer, error, sizeof error) == 0);
    CHECK(fclose(writer) == 0 && bytes == q36_session_payload_bytes(target));
    /* Every partial byte count is exercised, including the last byte. The
     * declared payload length stays correct, so this tests real short I/O. */
    for (size_t available = 0; available <= bytes; available++) {
        cases++;
        q36_session *source = state(&engine, ctx, 1), *reference = state(&engine, ctx, 1);
        CHECK(source && reference); if (!source || !reference) abort();
        size_t before = live_allocations;
        payload_input in = {.bytes = (unsigned char *)payload, .size = available, .stop_at = SIZE_MAX};
        FILE *fp = input_open(&in); CHECK(fp != NULL);
        q36_session *out = (q36_session *)(uintptr_t)1;
        int rc = prepared_load(&out, source, fp, bytes, NULL, NULL, error, sizeof error);
        CHECK((rc == 0) == (available == bytes));
        CHECK(same(source, reference));
        if (rc) CHECK(out == (q36_session *)(uintptr_t)1 && live_allocations == before);
        else {
            CHECK(out != source && same(out, target));
            CHECK(out->progress == NULL && out->cancel == NULL);
            CHECK(out->mtp_draft_margin == source->mtp_draft_margin &&
                  out->mtp_backoff == source->mtp_backoff &&
                  out->mtp_backoff_len == source->mtp_backoff_len);
        }
        if (out && out != source && out != (q36_session *)(uintptr_t)1) q36_session_free(out);
        fclose(fp); q36_session_free(source); q36_session_free(reference);
    }
    for (size_t stop = 0; stop <= bytes; stop += sizeof(uint32_t)) {
        cases++;
        q36_session *source = state(&engine, ctx, 1), *reference = state(&engine, ctx, 1);
        CHECK(source && reference); if (!source || !reference) abort();
        payload_input in = {.bytes = (unsigned char *)payload, .size = bytes, .stop_at = stop};
        FILE *fp = input_open(&in); CHECK(fp != NULL);
        q36_session *out = (q36_session *)(uintptr_t)1;
        size_t before = live_allocations;
        int rc = prepared_load(&out, source, fp, bytes, input_cancel, &in, error, sizeof error);
        CHECK(rc == Q36_SESSION_SYNC_INTERRUPTED && out == (q36_session *)(uintptr_t)1);
        CHECK(same(source, reference));
        if (out && out != source && out != (q36_session *)(uintptr_t)1) q36_session_free(out);
        CHECK(live_allocations == before);
        if (!stop) CHECK(in.pos == 0);
        fclose(fp); q36_session_free(source); q36_session_free(reference);
    }
    /* Header, declared-size and token errors remain failures, without changing
     * the source even after a syntactically valid header has been consumed. */
    for (int fault = 0; fault < 9; fault++) {
        cases++;
        q36_session *source = state(&engine, ctx, 1), *reference = state(&engine, ctx, 1);
        CHECK(source && reference); if (!source || !reference) abort();
        unsigned char *bad = malloc(bytes); CHECK(bad != NULL); memcpy(bad, payload, bytes);
        size_t declared = bytes;
        uint32_t invalid = UINT32_MAX;
        const size_t tokens_offset = (k == Q36_KV_CACHE_F16 && v == Q36_KV_CACHE_F16 ?
            Q36_PAYLOAD_U32_FIELDS : Q36_PAYLOAD_U32_FIELDS_TYPED_KV) * sizeof(uint32_t);
        if (fault == 0) memcpy(bad, &invalid, sizeof invalid);
        if (fault == 1) memcpy(bad + sizeof(uint32_t), &invalid, sizeof invalid);
        if (fault == 2) memcpy(bad + 2 * sizeof(uint32_t), &invalid, sizeof invalid);
        if (fault == 3) memcpy(bad + 4 * sizeof(uint32_t), &invalid, sizeof invalid);
        if (fault == 4) memcpy(bad + 5 * sizeof(uint32_t), &invalid, sizeof invalid);
        if (fault == 5) memcpy(bad + tokens_offset, &invalid, sizeof invalid);
        if (fault == 6) declared--;
        if (fault == 7) declared++;
        if (fault == 8) engine.cpu_prefill_cap = 4;
        payload_input in = {.bytes = bad, .size = bytes, .stop_at = SIZE_MAX};
        FILE *fp = input_open(&in); CHECK(fp != NULL);
        q36_session *out = (q36_session *)(uintptr_t)1;
        size_t before = live_allocations;
        int rc = prepared_load(&out, source, fp, declared, NULL, NULL, error, sizeof error);
        CHECK(rc != 0 && out == (q36_session *)(uintptr_t)1);
        engine.cpu_prefill_cap = 2;
        CHECK(same(source, reference));
        if (out && out != source && out != (q36_session *)(uintptr_t)1) q36_session_free(out);
        CHECK(live_allocations == before);
        fclose(fp); free(bad); q36_session_free(source); q36_session_free(reference);
    }
    q36_session *source = state(&engine, ctx, 1), *reference = state(&engine, ctx, 1);
    CHECK(source && reference); if (!source || !reference) abort();
    size_t allocations = 0, live = live_allocations;
    for (size_t point = 0; point <= allocations; point++) {
        cases++;
        payload_input in = {.bytes = (unsigned char *)payload, .size = bytes, .stop_at = SIZE_MAX};
        FILE *fp = input_open(&in); CHECK(fp != NULL);
        q36_session *out = (q36_session *)(uintptr_t)1;
        allocation_calls = 0; fail_at = point;
        int rc = prepared_load(&out, source, fp, bytes, NULL, NULL, error, sizeof error);
        fail_at = 0;
        if (!point) {allocations = allocation_calls; CHECK(rc == 0 && same(out, target));}
        else CHECK(rc != 0 && out == (q36_session *)(uintptr_t)1);
        CHECK(same(source, reference));
        if (out && out != source && out != (q36_session *)(uintptr_t)1) q36_session_free(out);
        CHECK(live_allocations == live);
        fclose(fp);
    }
    q36_session_free(source); q36_session_free(reference);
    q36_session_free(target); free(payload);
    CHECK(live_allocations == 0);
}
static void large_payload_case(void) {
    unsigned saved_vocab = g_q36_shape.n_vocab;
    g_q36_shape.n_vocab = 40000; /* Logits span multiple 64 KiB read checks. */
    q36_engine engine = {.backend = Q36_BACKEND_CPU, .cpu_prefill_cap = 2,
        .cache_type_k = Q36_KV_CACHE_F16, .cache_type_v = Q36_KV_CACHE_F16};
    q36_session *target = state(&engine, 64, 11), *source = state(&engine, 64, 1), *reference = state(&engine, 64, 1);
    CHECK(target && source && reference); if (!target || !source || !reference) abort();
    char *payload = NULL, error[160]; size_t bytes = 0;
    FILE *writer = open_memstream(&payload, &bytes); CHECK(writer != NULL);
    CHECK(q36_session_save_payload(target, writer, error, sizeof error) == 0);
    CHECK(fclose(writer) == 0);
    payload_input in = {.bytes = (unsigned char *)payload, .size = bytes, .stop_at = 65537};
    FILE *fp = input_open(&in); CHECK(fp != NULL);
    q36_session *out = (q36_session *)(uintptr_t)1;
    cases++;
    int rc = prepared_load(&out, source, fp, bytes, input_cancel, &in, error, sizeof error);
    CHECK(rc == Q36_SESSION_SYNC_INTERRUPTED && out == (q36_session *)(uintptr_t)1);
    CHECK(same(source, reference)); CHECK(in.pos <= in.stop_at + 65536);
    if (out && out != source && out != (q36_session *)(uintptr_t)1) q36_session_free(out);
    fclose(fp); free(payload);
    q36_session_free(target); q36_session_free(source); q36_session_free(reference);
    g_q36_shape.n_vocab = saved_vocab;
    CHECK(live_allocations == 0);
}
typedef struct {
    unsigned char *data;
    size_t capacity, pos, stop_at, fail_at, largest;
} payload_output;
static int output_write(void *ud, const char *data, int size) {
    payload_output *out = ud;
    if ((size_t)size > out->largest) out->largest = (size_t)size;
    size_t n = (size_t)size;
    if (n > out->capacity - out->pos) n = out->capacity - out->pos;
    if (n > out->fail_at - out->pos) n = out->fail_at - out->pos;
    if (!n) {errno = ENOSPC; return -1;}
    memcpy(out->data + out->pos, data, n); out->pos += n; return (int)n;
}
static bool output_cancel(void *ud) {
    payload_output *out = ud; return out->stop_at != SIZE_MAX && out->pos >= out->stop_at;
}
#ifndef __APPLE__
static ssize_t output_cookie_write(void *ud, const char *data, size_t size) {
    return output_write(ud, data, size > INT_MAX ? INT_MAX : (int)size);
}
#endif
static FILE *output_open(payload_output *out) {
#ifdef __APPLE__
    FILE *fp = funopen(out, NULL, output_write, NULL, NULL);
#else
    FILE *fp = fopencookie(out, "w", (cookie_io_functions_t){.write = output_cookie_write});
#endif
    if (fp) setvbuf(fp, NULL, _IONBF, 0);
    return fp;
}
#ifdef Q36_PAYLOAD_SCHEDULE_API
static int unexpected_device_enter(void *ud) {(void)ud; CHECK(false); return 1;}
static void unexpected_device_leave(void *ud) {(void)ud; CHECK(false);}
#endif
static void payload_write_cases(void) {
    unsigned saved_vocab = g_q36_shape.n_vocab;
    g_q36_shape.n_vocab = 40000;
    q36_engine engine = {.backend = Q36_BACKEND_CPU, .cpu_prefill_cap = 2,
        .cache_type_k = Q36_KV_CACHE_F16, .cache_type_v = Q36_KV_CACHE_F16};
    q36_session *source = state(&engine, 64, 11), *reference = state(&engine, 64, 11);
    CHECK(source && reference); if (!source || !reference) abort();
    char *expected = NULL, error[160]; size_t bytes = 0;
    FILE *full = open_memstream(&expected, &bytes); assert(full);
    CHECK(q36_session_save_payload(source, full, error, sizeof error) == 0); CHECK(!fclose(full));
    CHECK(bytes > 2 * 65536);
    const size_t points[] = {0, 1, 65536, 65537, bytes - 1, bytes};
    for (int kind = 0; kind < 2; kind++) for (unsigned i = 0; i < sizeof points / sizeof *points; i++) {
        cases++;
        payload_output out = {.data = calloc(1, bytes), .capacity = bytes,
            .stop_at = kind ? SIZE_MAX : points[i], .fail_at = kind ? points[i] : SIZE_MAX};
        assert(out.data);
        FILE *fp = output_open(&out); assert(fp);
        q36_session_set_cancel(source, output_cancel, &out);
        int rc = q36_session_save_payload(source, fp, error, sizeof error);
        q36_session_set_cancel(source, NULL, NULL); fclose(fp);
        if (!kind) {
            CHECK(rc == Q36_SESSION_SYNC_INTERRUPTED);
            CHECK(out.pos <= points[i] + 65536);
            if (!points[i]) CHECK(out.pos == 0);
        } else CHECK((rc == 0) == (points[i] == bytes));
        CHECK(out.largest <= 65536);
        CHECK(out.pos <= bytes && !memcmp(expected, out.data, out.pos));
        CHECK(same(source, reference)); free(out.data);
    }
#ifdef Q36_PAYLOAD_SCHEDULE_API
    /* CPU writers have no GPU borrow, but must honor request cancellation
     * from the descriptor as well as a native session cancellation callback. */
    const size_t cancel_points[] = {0, 65537, bytes};
    for (unsigned i = 0; i < sizeof cancel_points / sizeof *cancel_points; i++) {
        cases++;
        payload_output out = {.data = calloc(1, bytes), .capacity = bytes,
            .stop_at = cancel_points[i], .fail_at = SIZE_MAX}; assert(out.data);
        q36_payload_device_access access = {unexpected_device_enter, unexpected_device_leave, &out, output_cancel};
        FILE *fp = output_open(&out); assert(fp);
        CHECK(q36_session_save_payload_scheduled(source, fp, &access, error, sizeof error) == Q36_SESSION_SYNC_INTERRUPTED);
        fclose(fp); CHECK(out.pos <= cancel_points[i] + 65536 && out.largest <= 65536);
        CHECK(out.pos <= bytes && !memcmp(expected, out.data, out.pos) && same(source, reference)); free(out.data);
    }
    cases++; payload_output no_cancel = {.stop_at = SIZE_MAX}; int count = -1;
    q36_payload_device_access access = {unexpected_device_enter, unexpected_device_leave, &no_cancel, output_cancel};
    CHECK(q36_session_logits_scheduled(source, &count, &access) == source->logits && count == 40000);
    no_cancel.stop_at = 0; count = -1;
    CHECK(!q36_session_logits_scheduled(source, &count, &access) && count == 0 && same(source, reference));
#endif
    q36_session_free(source); q36_session_free(reference); free(expected);
    g_q36_shape.n_vocab = saved_vocab; CHECK(live_allocations == 0);
}
int main(void) {
    g_q36_shape = Q36_SHAPE_27B;
    g_q36_shape.n_layer = 4; g_q36_shape.n_embd = 32; g_q36_shape.n_vocab = 32;
    g_q36_shape.n_head = 1; g_q36_shape.n_head_kv = 1; g_q36_shape.n_head_dim = 32;
    g_q36_shape.n_value_dim = 32; g_q36_shape.n_ff_shared = 64;
    g_q36_shape.n_ssm_state = 2; g_q36_shape.n_ssm_dt_rank = 2;
    g_q36_shape.n_ssm_conv = 4; g_q36_shape.n_ssm_group = 1; g_q36_shape.n_ssm_inner = 4;
#ifndef DSTUDIO_Q36_PAYLOAD_WRITE_ONLY
    for (int k = 0; k <= Q36_KV_CACHE_Q4_0; k++)
        for (int v = 0; v <= Q36_KV_CACHE_Q4_0; v++) payload_cases(k, v, 64);
    large_payload_case();
#endif
    payload_write_cases();
    printf("{\"cases\":%d,\"checks\":%d,\"failures\":%d,\"liveAllocations\":%zu}\n",
           cases, checks, failures, live_allocations);
    return failures ? 1 : 0;
}

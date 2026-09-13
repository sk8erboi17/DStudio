/* Native serializer and real Metal buffers, initialized without model weights.
 * A separately assembled wire oracle checks every byte. The device scheduler
 * below is a bounded test fixture, NOT the server scheduler or a decode test. */
#include "q36_gpu.h"
#include <assert.h>
#include <stdatomic.h>
#include <pthread.h>
static int observed_read(const q36_gpu_tensor *, uint64_t, void *, uint64_t);
static int observed_write(q36_gpu_tensor *, uint64_t, const void *, uint64_t);
static void *observed_contents(q36_gpu_tensor *, const char *);
static q36_gpu_tensor *observed_alloc(uint64_t);
static q36_gpu_tensor *observed_uninitialized(uint64_t);
static int observed_copy(q36_gpu_tensor *, uint64_t, const q36_gpu_tensor *, uint64_t, uint64_t);
static int observed_sync(void);
#define q36_gpu_tensor_read observed_read
#define q36_gpu_tensor_write observed_write
#define q36_gpu_tensor_contents_named observed_contents
#define q36_gpu_tensor_alloc observed_alloc
#define q36_gpu_tensor_alloc_uninitialized observed_uninitialized
#define q36_gpu_tensor_copy observed_copy
#define q36_gpu_synchronize observed_sync
#include "q36.c"
#undef q36_gpu_tensor_read
#undef q36_gpu_tensor_write
#undef q36_gpu_tensor_contents_named
#undef q36_gpu_tensor_alloc
#undef q36_gpu_tensor_alloc_uninitialized
#undef q36_gpu_tensor_copy
#undef q36_gpu_synchronize

static atomic_uint checks, failures;
static unsigned cases, reads, enters, leaves, refused, max_read;
static bool observe, cancelled;
static _Thread_local bool owns_device;
static pthread_mutex_t device_mu = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t device_cv = PTHREAD_COND_INITIALIZER;
static bool device_busy;
static int fault;
static bool restoring, restore_cancelled, block_input, input_blocked, resume_input;
static unsigned uploads, allocations_observed, copies;
static const q36_gpu_tensor *last_copy;
static size_t input_bytes;
#define CHECK(x) do {atomic_fetch_add(&checks, 1); if (!(x)) { \
    atomic_fetch_add(&failures, 1); fprintf(stderr, "case=%u line=%d: %s\n", cases, __LINE__, #x);}} while (0)
static int device_enter(void *ud) {
    CHECK(ud == &device_busy); CHECK(!owns_device); enters++;
    if (fault == 1 || fault == 2) {refused++; return fault == 1 ? 1 : Q36_SESSION_SYNC_INTERRUPTED;}
    pthread_mutex_lock(&device_mu);
    while (device_busy) pthread_cond_wait(&device_cv, &device_mu);
    device_busy = owns_device = true; pthread_mutex_unlock(&device_mu);
    if (fault == 3) cancelled = true;
    return 0;
}
static void device_leave(void *ud) {
    CHECK(ud == &device_busy); CHECK(owns_device); leaves++;
    pthread_mutex_lock(&device_mu); device_busy = owns_device = false;
    pthread_cond_broadcast(&device_cv); pthread_mutex_unlock(&device_mu);
    if (fault == 4) cancelled = true;
}
static int observed_read(const q36_gpu_tensor *tensor, uint64_t off, void *dst, uint64_t bytes) {
    if (observe) {
        CHECK(owns_device); CHECK(bytes <= 65536); reads++;
        if (bytes > max_read) max_read = (unsigned)bytes;
        int rc = pthread_mutex_trylock(&device_mu); CHECK(!rc);
        if (!rc) pthread_mutex_unlock(&device_mu);
        if (fault == 5) return 0;
    }
    return q36_gpu_tensor_read(tensor, off, dst, bytes);
}
static int observed_write(q36_gpu_tensor *tensor, uint64_t off, const void *src, uint64_t bytes) {
    if (restoring) {
        CHECK(owns_device && bytes <= 65536); uploads++;
        int rc = pthread_mutex_trylock(&device_mu); CHECK(!rc);
        if (!rc) pthread_mutex_unlock(&device_mu);
        if (fault == 9 && input_bytes > 65536) return 0;
    }
    return q36_gpu_tensor_write(tensor, off, src, bytes);
}
static void *observed_contents(q36_gpu_tensor *tensor, const char *label) {
    if (restoring) CHECK(owns_device); /* Catches an unadmitted reset/sync path. */
    return q36_gpu_tensor_contents_named(tensor, label);
}
static q36_gpu_tensor *observed_alloc(uint64_t bytes) {
    if (restoring) {
        CHECK(!owns_device); allocations_observed++;
        if (fault == 14 && allocations_observed == 3) return NULL;
    }
    return q36_gpu_tensor_alloc(bytes);
}
static q36_gpu_tensor *observed_uninitialized(uint64_t bytes) {
    if (restoring) {CHECK(!owns_device); allocations_observed++;}
    return q36_gpu_tensor_alloc_uninitialized(bytes);
}
static int observed_copy(q36_gpu_tensor *dst, uint64_t dst_off, const q36_gpu_tensor *src,
    uint64_t src_off, uint64_t bytes) {
    if (restoring) {
        CHECK(owns_device && bytes <= 65536); copies++;
        if (fault == 15) return 0;
        if (fault == 16 || (fault == 17 && src == last_copy)) restore_cancelled = true;
    }
    return q36_gpu_tensor_copy(dst, dst_off, src, src_off, bytes);
}
static int observed_sync(void) {
    if (restoring) CHECK(owns_device);
    return q36_gpu_synchronize();
}
static bool cancel_write(void *ud) {CHECK(ud == &cancelled); return cancelled;}
static bool cancel_access(void *ud) {CHECK(ud == &device_busy); return cancelled;}
typedef struct {unsigned char *bytes; size_t len, cap;} byte_string;
static void append(byte_string *b, const void *p, size_t n) {
    assert(n <= SIZE_MAX - b->len);
    if (b->cap - b->len < n) {
        size_t cap = (b->len + n) * 2; assert(cap <= 64 * 1024 * 1024);
        unsigned char *next = realloc(b->bytes, cap); assert(next); b->bytes = next; b->cap = cap;
    }
    memcpy(b->bytes + b->len, p, n); b->len += n;
}
static void word(byte_string *b, uint32_t value) {
    unsigned char raw[4] = {value, value >> 8, value >> 16, value >> 24}; append(b, raw, sizeof raw);
}
static q36_gpu_tensor *tensor_bytes(byte_string *expected, size_t bytes, unsigned seed, bool half_state) {
    unsigned char *raw = malloc(bytes); assert(raw);
    if (half_state) {
        static const uint16_t half[] = {0x3c00, 0x4000, 0x4200, 0x4400};
        for (size_t i = 0; i < bytes / 2; i++) {
            ((uint16_t *)raw)[i] = half[(i + seed) % 4];
            float value = (float)((i + seed) % 4 + 1); append(expected, &value, sizeof value);
        }
    } else {
        for (size_t i = 0; i < bytes; i++) raw[i] = (unsigned char)(seed + i * 7u);
        append(expected, raw, bytes);
    }
    q36_gpu_tensor *tensor = q36_gpu_tensor_alloc(bytes); assert(tensor);
    assert(q36_gpu_tensor_write(tensor, 0, raw, bytes)); free(raw); return tensor;
}
typedef struct {
    q36_engine engine;
    q36_session session;
    q36_vulkan_runtime runtime;
    int tokens[8];
    size_t logits_offset;
    byte_string expected;
} fixture;
static void initialize(fixture *f, int k, int v, bool half, bool host_logits, int ctx) {
    memset(f, 0, sizeof *f);
    f->engine.backend = Q36_BACKEND_METAL;
    f->engine.quality = true; f->engine.prefill_cap_override = 128;
    f->engine.cache_type_k = k; f->engine.cache_type_v = v;
    f->runtime.prefill_cap = 128; f->runtime.recur_state_f16 = half;
    f->session.engine = &f->engine; f->session.runtime = &f->runtime; f->session.ctx_size = ctx;
    f->session.checkpoint = (q36_tokens){.v = f->tokens, .len = 8, .cap = 8};
    f->session.checkpoint_valid = true; f->session.logits_host_valid = host_logits;
    /* Header constants are the pinned native format, not copied struct bytes. */
    bool typed = k != Q36_KV_CACHE_F16 || v != Q36_KV_CACHE_F16;
    word(&f->expected, Q36_PAYLOAD_MAGIC); word(&f->expected, typed ? 3 : 2);
    word(&f->expected, ctx); word(&f->expected, 128); word(&f->expected, 8);
    word(&f->expected, Q36_N_VOCAB); word(&f->expected, Q36_N_LAYER);
    word(&f->expected, Q36_N_HEAD_KV); word(&f->expected, Q36_N_HEAD_DIM);
    word(&f->expected, Q36_N_VALUE_DIM); word(&f->expected, Q36_N_SSM_CONV);
    word(&f->expected, Q36_N_SSM_CONV_DIM); word(&f->expected, Q36_N_SSM_STATE);
    word(&f->expected, Q36_N_SSM_DT_RANK);
    if (typed) {word(&f->expected, k); word(&f->expected, v);}
    for (unsigned i = 0; i < 8; i++) {f->tokens[i] = 101 + i; word(&f->expected, f->tokens[i]);}
    size_t logits_start = f->expected.len;
    f->logits_offset = logits_start;
    f->runtime.logits = tensor_bytes(&f->expected, Q36_N_VOCAB * sizeof(float), 3, false);
    byte_string hidden = {0};
    f->runtime.last_h = tensor_bytes(&hidden, Q36_N_EMBD * sizeof(float), 71, false);
    free(hidden.bytes); /* Native hidden state is not in the disk payload. */
    f->session.logits = malloc(Q36_N_VOCAB * sizeof(float)); assert(f->session.logits);
    memcpy(f->session.logits, f->expected.bytes + logits_start, Q36_N_VOCAB * sizeof(float));
    for (unsigned il = 0; il < Q36_N_LAYER; il++) {
        if ((il + 1) % 4 == 0) {
            q36_vulkan_full_attn_cache *c = &f->runtime.full[il];
            c->cap = 8; c->type_k = k; c->type_v = v; word(&f->expected, 8);
            c->k_row_bytes = q36_kv_cache_row_bytes(k, Q36_N_HEAD_KV * Q36_N_HEAD_DIM);
            c->v_row_bytes = q36_kv_cache_row_bytes(v, Q36_N_HEAD_KV * Q36_N_VALUE_DIM);
            c->k = tensor_bytes(&f->expected, q36_full_k_bytes(8, k), il, false);
            c->v = tensor_bytes(&f->expected, q36_full_v_bytes(8, v), il + 7, false);
        } else {
            q36_vulkan_recurrent_cache *c = &f->runtime.recurrent[il];
            c->conv = tensor_bytes(&f->expected, q36_recurrent_conv_bytes(), il + 11, false);
            c->state = tensor_bytes(&f->expected, q36_recurrent_state_bytes() / (half ? 2 : 1), il, half);
        }
    }
}
static void dispose(fixture *f) {
    q36_gpu_tensor_free(f->runtime.logits);
    q36_gpu_tensor_free(f->runtime.last_h);
    for (unsigned il = 0; il < Q36_N_LAYER; il++) {
        q36_gpu_tensor_free(f->runtime.full[il].k); q36_gpu_tensor_free(f->runtime.full[il].v);
        q36_gpu_tensor_free(f->runtime.recurrent[il].conv); q36_gpu_tensor_free(f->runtime.recurrent[il].state);
    }
    free(f->session.logits); free(f->expected.bytes);
}
static pthread_mutex_t disk_mu = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t disk_cv = PTHREAD_COND_INITIALIZER;
static bool block_output, output_blocked, resume_output;
typedef struct {byte_string bytes; bool scheduled;} output;
static int output_write(void *ud, const char *bytes, int count) {
    output *out = ud;
    if (out->scheduled) CHECK(!owns_device);
    if (fault == 6 && reads) {errno = EIO; return -1;}
    if (block_output && reads) {
        pthread_mutex_lock(&disk_mu);
        if (!output_blocked) {
            output_blocked = true; pthread_cond_broadcast(&disk_cv);
            while (!resume_output) pthread_cond_wait(&disk_cv, &disk_mu);
        }
        pthread_mutex_unlock(&disk_mu);
    }
    append(&out->bytes, bytes, count); return count;
}
static FILE *output_open(output *out) {
    FILE *fp = funopen(out, NULL, output_write, NULL, NULL); assert(fp);
    setvbuf(fp, NULL, _IONBF, 0); return fp;
}
static const q36_payload_device_access device_access = {device_enter, device_leave, &device_busy, cancel_access};
static int save(fixture *f, output *out) {
    char err[160]; FILE *fp = output_open(out); observe = out->scheduled;
    q36_session_set_cancel(&f->session, cancel_write, &cancelled);
    int rc = q36_session_save_payload_scheduled(&f->session, fp, out->scheduled ? &device_access : NULL, err, sizeof err);
    q36_session_set_cancel(&f->session, NULL, NULL); observe = false;
    CHECK(!fclose(fp)); return rc;
}
static void reset_observation(int next_fault) {
    assert(!device_busy && !owns_device);
    reads = enters = leaves = refused = max_read = 0; cancelled = false; fault = next_fault;
}
static void matrix_case(int k, int v, bool half, bool host_logits) {
    cases++; fixture *f = calloc(1, sizeof *f); assert(f);
    initialize(f, k, v, half, host_logits, 1024);
    output actual = {.scheduled = true}; reset_observation(0);
    CHECK(!save(f, &actual)); CHECK(enters == leaves && enters > 0 && max_read == 65536);
    CHECK(actual.bytes.len == f->expected.len && !memcmp(actual.bytes.bytes, f->expected.bytes, f->expected.len));
    CHECK(actual.bytes.len == q36_session_payload_bytes(&f->session));
    unsigned active_reads = reads;
    free(actual.bytes.bytes); actual.bytes = (byte_string){0}; f->session.ctx_size = 8192;
    /* Only context capacity in the header changes; active read visits cannot grow. */
    f->expected.bytes[8] = 0; f->expected.bytes[9] = 32;
    reset_observation(0); CHECK(!save(f, &actual)); CHECK(reads == active_reads);
    CHECK(actual.bytes.len == f->expected.len && !memcmp(actual.bytes.bytes, f->expected.bytes, f->expected.len));
    free(actual.bytes.bytes); actual.bytes = (byte_string){0};
    reset_observation(0); observe = true; int count = 0;
    const float *logits = q36_session_logits_scheduled(&f->session, &count, &device_access);
    observe = false;
    CHECK(logits == f->session.logits && count == (int)Q36_N_VOCAB && f->session.logits_host_valid);
    CHECK(!memcmp(logits, f->expected.bytes + f->logits_offset, Q36_N_VOCAB * sizeof(float)));
    CHECK(enters == leaves && (host_logits ? !enters : enters > 0));
    unsigned before = enters;
    CHECK(q36_session_logits_scheduled(&f->session, NULL, &device_access) == logits && enters == before);
    CHECK(!save(f, &actual));
    CHECK(actual.bytes.len == f->expected.len && !memcmp(actual.bytes.bytes, f->expected.bytes, f->expected.len));
    free(actual.bytes.bytes); dispose(f); free(f);
}
static void *save_blocked(void *ud) {
    fixture *f = ud; output actual = {.scheduled = true};
    CHECK(!save(f, &actual)); CHECK(actual.bytes.len == f->expected.len);
    CHECK(!memcmp(actual.bytes.bytes, f->expected.bytes, f->expected.len)); free(actual.bytes.bytes); return NULL;
}

typedef struct {const byte_string *source; size_t offset;} input;
static bool restore_cancel(void *ud) {CHECK(ud == &restore_cancelled); return restore_cancelled;}
static int input_read(void *ud, char *dst, int count) {
    input *in = ud; CHECK(!owns_device); CHECK(count > 0 && count <= 65536);
    if (fault == 8 && in->offset >= 65536) return 0;
    if (block_input && in->offset >= 65536) {
        pthread_mutex_lock(&disk_mu);
        if (!input_blocked) {
            input_blocked = true; pthread_cond_broadcast(&disk_cv);
            while (!resume_input) pthread_cond_wait(&disk_cv, &disk_mu);
        }
        pthread_mutex_unlock(&disk_mu);
    }
    size_t n = in->source->len - in->offset;
    if (n > (size_t)count) n = (size_t)count;
    memcpy(dst, in->source->bytes + in->offset, n);
    in->offset += n; input_bytes = in->offset;
    if ((fault == 11 && in->offset >= 65536) ||
        (fault == 12 && in->offset == in->source->len)) restore_cancelled = true;
    return (int)n;
}
static int restore(fixture *f, const byte_string *bytes, q36_session **out) {
    input in = {.source = bytes}; FILE *fp = funopen(&in, input_read, NULL, NULL, NULL); assert(fp);
    setvbuf(fp, NULL, _IONBF, 0); char err[160]; restoring = true;
    int rc = q36_session_prepare_load_payload_scheduled(out, &f->session, fp, bytes->len,
        restore_cancel, &restore_cancelled, &device_access, err, sizeof err);
    restoring = false; CHECK(!fclose(fp)); CHECK(enters == leaves + refused && !device_busy);
    return rc;
}
static void reset_restore(int injected) {
    reset_observation(injected); restore_cancelled = injected == 10;
    uploads = allocations_observed = copies = 0; input_bytes = 0;
}
static void verify_restored(fixture *f, q36_session *candidate) {
    CHECK(candidate && candidate != &f->session && candidate->engine == &f->engine);
    CHECK(!candidate->cancel && !candidate->progress && candidate->ctx_size == f->session.ctx_size);
    FILE *fp = tmpfile(); assert(fp); char err[160];
    CHECK(!q36_session_save_payload(candidate, fp, err, sizeof err)); CHECK(!fflush(fp));
    CHECK(ftello(fp) == (off_t)f->expected.len); rewind(fp);
    unsigned char *raw = malloc(f->expected.len); assert(raw);
    CHECK(fread(raw, 1, f->expected.len, fp) == f->expected.len);
    CHECK(!memcmp(raw, f->expected.bytes, f->expected.len)); free(raw); fclose(fp);
    q36_session_free(candidate);
}
static void *restore_blocked(void *ud) {
    fixture *f = ud; q36_session *candidate = NULL;
    CHECK(!restore(f, &f->expected, &candidate)); verify_restored(f, candidate); return NULL;
}
static bool restore_cases(void) {
    for (unsigned dense = 0; dense < 2; dense++) {
        g_q36_shape = dense ? Q36_SHAPE_27B : Q36_SHAPE_35B_A3B; g_q36_shape.n_layer = 4;
        for (int k = 0; k <= Q36_KV_CACHE_Q4_0; k++) for (int v = 0; v <= Q36_KV_CACHE_Q4_0; v++)
            for (int host = 0; host < 2; host++) {
                cases++; fixture *f = calloc(1, sizeof *f); assert(f); initialize(f, k, v, false, host, 1024);
                reset_restore(0); q36_session *candidate = NULL;
                CHECK(!restore(f, &f->expected, &candidate)); CHECK(uploads > 0 && allocations_observed > 0);
                verify_restored(f, candidate); dispose(f); free(f);
            }
        /* Native FP32 wire -> FP16 recurrent state, also used by Vulkan.
         * Exercise conversion with real Metal storage, not a Vulkan claim. */
        cases++; reset_restore(0); byte_string full = {0};
        q36_gpu_tensor *half = tensor_bytes(&full, q36_recurrent_state_bytes() / 2, 0, true);
        input in = {.source = &full}; FILE *fp = funopen(&in, input_read, NULL, NULL, NULL); assert(fp);
        setvbuf(fp, NULL, _IONBF, 0); q36_payload_reader reader = {.fp = fp, .remaining = full.len, .device = &device_access};
        char error[160]; restoring = true;
        CHECK(!q36_payload_read_recurrent_state(half, &reader, true, error, sizeof error)); restoring = false;
        CHECK(!reader.remaining && enters == leaves && uploads > 0); fclose(fp);
        uint16_t *actual = malloc(full.len / 2); assert(actual);
        CHECK(q36_gpu_tensor_read(half, 0, actual, full.len / 2));
        static const uint16_t expected[] = {0x3c00, 0x4000, 0x4200, 0x4400};
        for (size_t i = 0; i < full.len / sizeof(float); i++) CHECK(actual[i] == expected[i % 4]);
        free(actual); free(full.bytes); q36_gpu_tensor_free(half);
    }
    fixture *f = calloc(1, sizeof *f); assert(f); initialize(f, 0, 0, false, false, 1024);
    const int faults[] = {1, 2, 3, 4, 8, 9, 10, 11, 12, 13, 14};
    for (unsigned i = 0; i < sizeof faults / sizeof *faults; i++) {
        cases++; int injected = faults[i]; reset_restore(injected);
        q36_session *candidate = &f->session;
        if (injected == 13) f->expected.bytes[0] ^= 1;
        int rc = restore(f, &f->expected, &candidate);
        if (injected == 13) f->expected.bytes[0] ^= 1;
        bool interrupted = injected == 2 || injected == 3 || injected == 4 || injected == 10 || injected == 11 || injected == 12;
        CHECK(rc == (interrupted ? Q36_SESSION_SYNC_INTERRUPTED : 1)); CHECK(candidate == &f->session);
        if (injected == 10) CHECK(!allocations_observed && !input_bytes && !enters);
        reset_restore(0); output retained = {0}; CHECK(!save(f, &retained));
        CHECK(retained.bytes.len == f->expected.len && !memcmp(retained.bytes.bytes, f->expected.bytes, f->expected.len));
        free(retained.bytes.bytes);
    }
    for (int empty = 0; empty < 2; empty++) {
        cases++; reset_restore(0); byte_string legacy = {0};
        word(&legacy, Q36_PAYLOAD_MAGIC); word(&legacy, 1); word(&legacy, 0);
        if (!empty) word(&legacy, 101); /* Trailing bytes cannot publish an empty checkpoint. */
        q36_session *candidate = NULL; int rc = restore(f, &legacy, &candidate);
        CHECK(rc == (empty ? 0 : 1)); CHECK(empty ? candidate && !candidate->checkpoint.len : !candidate);
        q36_session_free(candidate); free(legacy.bytes);
    }
    cases++; reset_restore(0); block_input = true; pthread_t worker;
    assert(!pthread_create(&worker, NULL, restore_blocked, f));
    pthread_mutex_lock(&disk_mu); struct timespec deadline; clock_gettime(CLOCK_REALTIME, &deadline); deadline.tv_sec += 3;
    while (!input_blocked) assert(!pthread_cond_timedwait(&disk_cv, &disk_mu, &deadline));
    pthread_mutex_unlock(&disk_mu);
    pthread_mutex_lock(&device_mu); bool available = !device_busy; pthread_mutex_unlock(&device_mu); CHECK(available);
    if (available) {
        CHECK(!device_enter(&device_busy)); q36_gpu_tensor *other = q36_gpu_tensor_alloc(4); assert(other);
        float x = 73, y = 0; CHECK(q36_gpu_tensor_write(other, 0, &x, sizeof x));
        CHECK(q36_gpu_tensor_read(other, 0, &y, sizeof y)); CHECK(x == y);
        q36_gpu_tensor_free(other); device_leave(&device_busy);
    }
    pthread_mutex_lock(&disk_mu); resume_input = true; pthread_cond_broadcast(&disk_cv); pthread_mutex_unlock(&disk_mu);
    pthread_join(worker, NULL); block_input = false; dispose(f); free(f); return available;
}

static int fork_scheduled(fixture *f, const q36_tokens *prompt, q36_session **out) {
    char err[160]; restoring = true; last_copy = f->runtime.last_h;
#ifdef Q36_TEXT_SCHEDULE_API
    int rc = q36_session_fork_for_prompt_scheduled(out, &f->session, prompt,
        restore_cancel, &restore_cancelled, &device_access, err, sizeof err);
#else
    /* Same ownership/byte requirements against the preceding native fork. */
    int rc = q36_session_fork_for_prompt(out, &f->session, prompt,
        restore_cancel, &restore_cancelled, err, sizeof err);
#endif
    restoring = false; CHECK(enters == leaves + refused && !device_busy); return rc;
}
static void fork_cases(void) {
    for (unsigned dense = 0; dense < 2; dense++) {
        g_q36_shape = dense ? Q36_SHAPE_27B : Q36_SHAPE_35B_A3B; g_q36_shape.n_layer = 4;
        for (int k = 0; k <= Q36_KV_CACHE_Q4_0; k++) for (int v = 0; v <= Q36_KV_CACHE_Q4_0; v++)
            for (int host = 0; host < 2; host++) {
                cases++; fixture *f = calloc(1, sizeof *f); assert(f); initialize(f, k, v, false, host, 8192);
                reset_restore(0); q36_session *candidate = NULL;
                CHECK(!fork_scheduled(f, &f->session.checkpoint, &candidate));
                CHECK(copies > 0 && allocations_observed > 0 && !reads);
                if (candidate) {
                    q36_vulkan_runtime *rt = candidate->runtime;
                    unsigned char a[Q36_SHAPE_27B.n_embd * sizeof(float)], b[sizeof a];
                    size_t bytes = Q36_N_EMBD * sizeof(float);
                    CHECK(q36_gpu_tensor_read(rt->last_h, 0, a, bytes));
                    CHECK(q36_gpu_tensor_read(f->runtime.last_h, 0, b, bytes));
                    CHECK(!memcmp(a, b, bytes));
#ifdef Q36_TEXT_SCHEDULE_API
                    char err[160]; reset_restore(0); restoring = true;
                    CHECK(!q36_session_sync_prefix_scheduled(candidate, &f->session.checkpoint, &device_access, err, sizeof err));
                    /* The native constructor already reserves this whole small
                     * context (its initial ceiling is 32,768). Use our separately
                     * initialized 8-row storage to actually exercise two grows.
                     * Neither grow changes its 8-token semantic state. */
                    CHECK(!q36_session_reserve_kv_scheduled(&f->session, 4096, &device_access));
                    unsigned active_copies = copies; copies = 0;
                    CHECK(!q36_session_reserve_kv_scheduled(&f->session, 8192, &device_access));
                    CHECK(copies == active_copies && copies > 0);
                    restoring = false; CHECK(enters == leaves && !device_busy);
                    output grown = {0}; CHECK(!save(f, &grown));
                    CHECK(grown.bytes.len == f->expected.len && !memcmp(grown.bytes.bytes, f->expected.bytes, f->expected.len));
                    free(grown.bytes.bytes);
#endif
                    verify_restored(f, candidate);
                }
                dispose(f); free(f);
            }
    }
    fixture *f = calloc(1, sizeof *f); assert(f); initialize(f, 0, 0, false, false, 1024);
    const int faults[] = {1, 2, 3, 4, 10, 14, 15, 16, 17};
    for (unsigned i = 0; i < sizeof faults / sizeof *faults; i++) {
        cases++; int injected = faults[i]; reset_restore(injected); q36_session *candidate = &f->session;
        int rc = fork_scheduled(f, &f->session.checkpoint, &candidate);
        bool interrupted = injected != 1 && injected != 14 && injected != 15;
        CHECK(rc == (interrupted ? Q36_SESSION_SYNC_INTERRUPTED : 1));
        CHECK(candidate == &f->session);
        /* The retained source is checked independently after every failure. */
        if (!rc && candidate != &f->session) q36_session_free(candidate);
        reset_restore(0); output retained = {0}; CHECK(!save(f, &retained));
        CHECK(retained.bytes.len == f->expected.len && !memcmp(retained.bytes.bytes, f->expected.bytes, f->expected.len));
        free(retained.bytes.bytes);
    }
#ifdef Q36_TEXT_SCHEDULE_API
    for (int missing = 0; missing < 2; missing++) {
        cases++; reset_restore(0); q36_payload_device_access invalid = device_access;
        if (missing) invalid.enter = NULL; else invalid.leave = NULL;
        q36_session *candidate = &f->session; char err[160]; restoring = true;
        CHECK(q36_session_fork_for_prompt_scheduled(&candidate, &f->session, &f->session.checkpoint,
            restore_cancel, &restore_cancelled, &invalid, err, sizeof err) == 1);
        restoring = false; CHECK(candidate == &f->session && !enters && !allocations_observed);
    }
    cases++; reset_restore(0); int ids[] = {71, 72}; q36_tokens replacement_prompt = {.v = ids, .len = 2, .cap = 2};
    q36_session *candidate = NULL; CHECK(!fork_scheduled(f, &replacement_prompt, &candidate));
    CHECK(candidate && candidate->checkpoint_valid && !candidate->checkpoint.len && !copies);
    q36_session_free(candidate);
#endif
    dispose(f); free(f);
}
int main(void) {
    assert(q36_gpu_init());
    for (unsigned dense = 0; dense < 2; dense++) {
        g_q36_shape = dense ? Q36_SHAPE_27B : Q36_SHAPE_35B_A3B;
        g_q36_shape.n_layer = 4; /* One full-attention layer + three recurrent. */
        for (int k = 0; k <= Q36_KV_CACHE_Q4_0; k++) for (int v = 0; v <= Q36_KV_CACHE_Q4_0; v++)
            for (int half = 0; half < 2; half++) for (int host = 0; host < 2; host++) matrix_case(k, v, half, host);
    }
    fixture *f = calloc(1, sizeof *f); assert(f); initialize(f, 0, 0, true, false, 1024);
    for (int injected = 1; injected <= 7; injected++) {
        cases++; reset_observation(injected); if (injected == 7) cancelled = true;
        output actual = {.scheduled = true}; int rc = save(f, &actual);
        CHECK(rc == ((injected == 2 || injected == 3 || injected == 4 || injected == 7) ? Q36_SESSION_SYNC_INTERRUPTED : 1));
        CHECK(enters == leaves + refused && !device_busy && !owns_device);
        if (injected == 7) CHECK(!actual.bytes.len && !enters);
        if (injected == 3) CHECK(!reads && enters == 1 && leaves == 1);
        free(actual.bytes.bytes); reset_observation(0);
        output retained = {0}; CHECK(!save(f, &retained));
        CHECK(retained.bytes.len == f->expected.len && !memcmp(retained.bytes.bytes, f->expected.bytes, f->expected.len));
        free(retained.bytes.bytes);
    }
    for (int missing = 0; missing < 2; missing++) {
        cases++; output out = {.scheduled = true}; FILE *fp = output_open(&out); char err[160];
        q36_payload_device_access invalid = device_access;
        if (missing) invalid.enter = NULL; else invalid.leave = NULL;
        CHECK(q36_session_save_payload_scheduled(&f->session, fp, &invalid, err, sizeof err) != 0);
        CHECK(!out.bytes.len); CHECK(!fclose(fp)); free(out.bytes.bytes);
    }
    for (unsigned scenario = 0; scenario < 3; scenario++) {
        cases++; reset_observation(scenario == 2 ? 5 : scenario == 1 ? 4 : 0);
        cancelled = scenario == 0; f->session.logits_host_valid = false;
        int count = -1; observe = true;
        CHECK(!q36_session_logits_scheduled(&f->session, &count, &device_access)); observe = false;
        CHECK(!count && !f->session.logits_host_valid && enters == leaves && !device_busy);
        if (!scenario) CHECK(!enters);
        reset_observation(0); observe = true;
        const float *logits = q36_session_logits_scheduled(&f->session, &count, &device_access); observe = false;
        CHECK(logits && f->session.logits_host_valid && count == (int)Q36_N_VOCAB);
        CHECK(!memcmp(logits, f->expected.bytes + f->logits_offset, Q36_N_VOCAB * sizeof(float)));
    }
    cases++; reset_observation(0); cancelled = true;
    output cancelled_output = {.scheduled = true}; FILE *cancelled_fp = output_open(&cancelled_output); char error[160];
    CHECK(q36_session_save_payload_scheduled(&f->session, cancelled_fp, &device_access, error, sizeof error) == Q36_SESSION_SYNC_INTERRUPTED);
    CHECK(!cancelled_output.bytes.len && !enters); CHECK(!fclose(cancelled_fp)); free(cancelled_output.bytes.bytes);
    f->session.logits_host_valid = false;
    cases++; reset_observation(0); block_output = true;
    pthread_t writer; assert(!pthread_create(&writer, NULL, save_blocked, f));
    pthread_mutex_lock(&disk_mu);
    struct timespec deadline; clock_gettime(CLOCK_REALTIME, &deadline); deadline.tv_sec += 3;
    while (!output_blocked) assert(!pthread_cond_timedwait(&disk_cv, &disk_mu, &deadline));
    pthread_mutex_unlock(&disk_mu);
    pthread_mutex_lock(&device_mu); bool available = !device_busy; pthread_mutex_unlock(&device_mu); CHECK(available);
    if (available) {
        /* Actual independent device operation while fwrite cannot finish. */
        CHECK(!device_enter(&device_busy)); q36_gpu_tensor *other = q36_gpu_tensor_alloc(4);
        float input = 37.0f, result = 0; CHECK(other != NULL);
        CHECK(q36_gpu_tensor_write(other, 0, &input, 4)); CHECK(q36_gpu_tensor_read(other, 0, &result, 4));
        CHECK(result == input); q36_gpu_tensor_free(other); device_leave(&device_busy);
    }
    pthread_mutex_lock(&disk_mu); resume_output = true; pthread_cond_broadcast(&disk_cv); pthread_mutex_unlock(&disk_mu);
    assert(!pthread_join(writer, NULL)); CHECK(enters == leaves && !device_busy); block_output = false;
    dispose(f); free(f); bool read_available = restore_cases(); fork_cases(); q36_gpu_cleanup();
    printf("{\"cases\":%u,\"checks\":%u,\"failures\":%u,\"independentGpuDuringBlockedWrite\":%s,"
        "\"independentGpuDuringBlockedRead\":%s,\"writerBytes\":%zu,\"accessBytes\":%zu,\"scope\":\"real Metal payload bytes, not model inference or server scheduling\"}\n",
        cases, atomic_load(&checks), atomic_load(&failures), available ? "true" : "false",
        read_available ? "true" : "false",
        sizeof(q36_payload_writer), sizeof(q36_payload_device_access));
    return atomic_load(&failures) ? 1 : 0;
}

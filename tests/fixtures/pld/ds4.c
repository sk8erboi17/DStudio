/* Deterministic stateful engine DOUBLE, not an LLM or a GPU benchmark.
 * The production PLD transaction code is compiled unchanged against this ABI.
 * Raw-ring overwrites + two independent recurrent states expose bad rollback. */
#include "ds4.h"
#include <assert.h>
#include <stdlib.h>
#include <string.h>
#include <stdio.h>

#define DS4_N_VOCAB 8
#define DS4_MODEL_FAMILY_DEEPSEEK4 0
#define DS4_SUPPORT_NONE 0
static int DS4_MODEL_FAMILY;
typedef ds4_tokens token_vec;
typedef int ds4_model;
typedef int ds4_weights;
typedef void ds4_gpu_tensor;
typedef struct {
    ds4_session *owner;
    void *placement;
    unsigned prefill_cap;
    ds4_gpu_tensor *spec_logits;
} ds4_gpu_graph;
struct ds4_engine {
    ds4_backend backend;
    bool quality;
    struct { bool active; } tp;
    int support_kind;
    ds4_model model;
    ds4_weights weights;
};
struct ds4_session {
    ds4_engine *engine;
    void *distributed;
    bool checkpoint_valid, mtp_draft_valid;
    ds4_gpu_graph graph;
    ds4_tokens checkpoint;
    int ctx_size, applied;
    float logits[DS4_N_VOCAB];
    int storage[512], raw[8];
    uint32_t compressor, indexer;
};
static int fake_fail_alloc, fake_fail_save, fake_fail_load, fake_fail_verify;
static int fake_fail_eval, fake_verify_calls, fake_serial_calls, fake_drift_row;
static uint64_t fake_payload_bytes;

static void token_vec_push(token_vec *v, int token) {
    assert(v->len < v->cap);
    v->v[v->len++] = token;
}
static void fake_advance(ds4_session *s, int token) {
    s->raw[s->applied % 8] = token;
    s->compressor = s->compressor * 33u + (unsigned)token;
    s->indexer = (s->indexer ^ (unsigned)token) * 16777619u;
    s->applied++;
    for (int i = 0; i < DS4_N_VOCAB; i++) s->logits[i] = -10;
    s->logits[(token + 1) % DS4_N_VOCAB] = 10;
}
int ds4_session_argmax(ds4_session *s) {
    int best = 0;
    for (int i = 1; i < DS4_N_VOCAB; i++)
        if (s->logits[i] > s->logits[best]) best = i;
    return best;
}
int ds4_session_eval(ds4_session *s, int token, char *err, size_t n) {
    fake_serial_calls++;
    if (fake_fail_eval) {
        if (n) snprintf(err, n, "injected serial error");
        return 1;
    }
    fake_advance(s, token);
    token_vec_push(&s->checkpoint, token);
    s->checkpoint_valid = true;
    return 0;
}
int ds4_session_pos(ds4_session *s) { return s->checkpoint.len; }
void ds4_session_invalidate(ds4_session *s) { s->checkpoint_valid = false; }
void ds4_session_rewind(ds4_session *s, int pos) {
    s->checkpoint.len = pos;
    s->applied = 0; s->compressor = s->indexer = 0;
    memset(s->raw, 0, sizeof(s->raw));
    memset(s->logits, 0, sizeof(s->logits)); s->logits[0] = 10;
    for (int i = 0; i < pos; i++) fake_advance(s, s->storage[i]);
}

typedef struct {
    int len, applied, tokens[512], raw[8];
    uint32_t compressor, indexer;
    float logits[DS4_N_VOCAB];
    bool valid;
} fake_snapshot;
uint64_t ds4_session_payload_bytes(ds4_session *s) {
    (void)s;
    return fake_payload_bytes ? fake_payload_bytes : sizeof(fake_snapshot);
}
int ds4_session_save_snapshot(ds4_session *s, ds4_session_snapshot *snap,
                              char *err, size_t n) {
    (void)err; (void)n;
    if (fake_fail_save) {
        snap->ptr = malloc(64); snap->cap = 64;
        if (n) snprintf(err, n, "injected snapshot error after allocation");
        return 1;
    }
    fake_snapshot *b = calloc(1, sizeof(*b));
    assert(b);
    b->len = s->checkpoint.len; b->applied = s->applied;
    b->compressor = s->compressor; b->indexer = s->indexer;
    b->valid = s->checkpoint_valid;
    memcpy(b->tokens, s->storage, sizeof(b->tokens));
    memcpy(b->raw, s->raw, sizeof(b->raw));
    memcpy(b->logits, s->logits, sizeof(b->logits));
    snap->ptr = (uint8_t *)b; snap->len = snap->cap = sizeof(*b);
    return 0;
}
int ds4_session_load_snapshot(ds4_session *s, const ds4_session_snapshot *snap,
                              char *err, size_t n) {
    if (fake_fail_load) {
        if (n) snprintf(err, n, "injected restore error");
        return 1;
    }
    const fake_snapshot *b = (const fake_snapshot *)snap->ptr;
    s->checkpoint.len = b->len; s->applied = b->applied;
    s->compressor = b->compressor; s->indexer = b->indexer;
    s->checkpoint_valid = b->valid;
    memcpy(s->storage, b->tokens, sizeof(b->tokens));
    memcpy(s->raw, b->raw, sizeof(b->raw));
    memcpy(s->logits, b->logits, sizeof(b->logits));
    return 0;
}
void ds4_session_snapshot_free(ds4_session_snapshot *snap) {
    free(snap->ptr); memset(snap, 0, sizeof(*snap));
}
static ds4_gpu_tensor *ds4_gpu_tensor_alloc(uint64_t bytes) {
    return fake_fail_alloc ? NULL : calloc(1, (size_t)bytes);
}
static bool metal_graph_verify_suffix_tops(ds4_gpu_graph *g,
        const ds4_model *model, const ds4_weights *weights,
        const token_vec *tokens, uint32_t start, uint32_t count,
        bool prefix, bool capture, int *tops, float *rows, void *timing) {
    (void)model; (void)weights; (void)prefix; (void)capture; (void)timing;
    fake_verify_calls++;
    ds4_session *s = g->owner;
    for (unsigned i = 0; i < count; i++) {
        fake_advance(s, tokens->v[start+i]);
        if (fake_fail_verify && i == 1) return false;
        memcpy(rows + i * DS4_N_VOCAB, s->logits, sizeof(s->logits));
        if (i + 1 < count) {
            tops[i] = ds4_session_argmax(s);
            if (fake_drift_row == (int)i + 1)
                tops[i] = tokens->v[start+i+1];
        }
    }
    return true;
}

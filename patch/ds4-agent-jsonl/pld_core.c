/* Shared managed-runtime translation unit. Upstream ds4.c and its normal object are never
 * edited/replaced. Unknown/older backends link the explicit unavailable stub. */
#ifdef DSTUDIO_PLD_NATIVE
#include "ds4.c"
#else
#include "ds4.h"
#include <string.h>
#include <stdio.h>
#endif
#include "pld_engine.h"

void ds4ui_pld_release(ds4ui_pld_transaction *tx) {
    if (!tx) return;
    ds4_session_snapshot_free(&tx->before);
    memset(tx, 0, sizeof(*tx));
}

int ds4ui_pld_rewind(ds4_session *s, ds4ui_pld_transaction *tx, int pos,
                     char *err, size_t errlen) {
    if (!s || !tx) {
        if (errlen) snprintf(err, errlen, "PLD rewind missing session/transaction");
        return -1;
    }
    if (!tx->active) { ds4_session_rewind(s, pos); return 0; }
    if (pos < tx->start || pos > tx->start + tx->count) {
        if (errlen) snprintf(err, errlen, "PLD rewind outside transaction");
        ds4_session_invalidate(s);
        return -1;
    }
    /* A full snapshot includes raw-ring rows, compressed attention, indexer,
     * counters, tokens AND logits. Merely changing checkpoint.len is unsafe. */
    if (ds4_session_load_snapshot(s, &tx->before, err, errlen) != 0) {
        ds4_session_invalidate(s);
        return -1;
    }
    for (int i = 0; i < pos - tx->start; i++) {
        if (ds4_session_eval(s, tx->tokens[i], err, errlen) != 0) {
            ds4_session_invalidate(s);
            return -1;
        }
    }
    return 0;
}

bool ds4ui_pld_can_verify(ds4_session *s) {
#ifndef DSTUDIO_PLD_NATIVE
    (void)s;
    return false;
#else
    return s && s->engine && s->checkpoint_valid &&
        s->engine->backend == DS4_BACKEND_METAL &&
        DS4_MODEL_FAMILY == DS4_MODEL_FAMILY_DEEPSEEK4 && !s->distributed &&
        !s->engine->quality && !s->engine->tp.active && !s->graph.placement &&
        s->engine->support_kind == DS4_SUPPORT_NONE;
#endif
}

int ds4ui_pld_verify(ds4_session *s, const int *tokens, int count,
                     ds4ui_pld_transaction *tx, char *err, size_t errlen) {
#ifndef DSTUDIO_PLD_NATIVE
    (void)s; (void)tokens; (void)count; (void)tx; (void)err; (void)errlen;
    return 0;
#else
    if (!ds4ui_pld_can_verify(s) || !tokens || !tx || tx->active || count < 2 ||
        count > DS4UI_PLD_DRAFT + 1 ||
        count > s->ctx_size - s->checkpoint.len ||
        (unsigned)count > s->graph.prefill_cap) return 0;
    for (int i = 0; i < count; i++)
        if (tokens[i] < 0 || tokens[i] >= (int)DS4_N_VOCAB) return 0;
    if (ds4_session_argmax(s) != tokens[0]) return 0;

    /* Snapshot admission is bounded. It is intentionally conservative and
     * included in any future end-to-end benchmark, never hidden from timing. */
    uint64_t bytes = ds4_session_payload_bytes(s);
    if (!bytes || bytes > 128ull * 1024 * 1024) return 0;
    if (ds4_session_save_snapshot(s, &tx->before, err, errlen) != 0) {
        /* The upstream serializer may have allocated before a read failed. */
        ds4ui_pld_release(tx);
        return -1;
    }
    tx->start = s->checkpoint.len;
    tx->count = count;
    memcpy(tx->tokens, tokens, (size_t)count * sizeof(int));
    tx->active = 1;

    /* No draft model or MTP buffers. Only verifier logits are added lazily;
     * upstream metal_graph_free owns this buffer afterwards. */
    if (!s->graph.spec_logits)
        s->graph.spec_logits = ds4_gpu_tensor_alloc(
            (uint64_t)(DS4UI_PLD_DRAFT + 1) * DS4_N_VOCAB * sizeof(float));
    if (!s->graph.spec_logits) { ds4ui_pld_release(tx); return 0; }
    float *rows = malloc((size_t)count * DS4_N_VOCAB * sizeof(float));
    if (!rows) { ds4ui_pld_release(tx); return 0; }
    int tops[DS4UI_PLD_DRAFT];
    for (int i = 0; i < count; i++) token_vec_push(&s->checkpoint, tokens[i]);
    bool ok = metal_graph_verify_suffix_tops(&s->graph,
        &s->engine->model, &s->engine->weights, &s->checkpoint,
        (uint32_t)tx->start, (uint32_t)count,
        false, false, tops, rows, NULL);
    int keep = ok ? 1 : 0;
    while (keep > 0 && keep < count && tops[keep-1] == tokens[keep]) keep++;
    if (ok && keep == count) {
        memcpy(s->logits, rows + (size_t)(count-1) * DS4_N_VOCAB,
               (size_t)DS4_N_VOCAB * sizeof(float));
        s->checkpoint_valid = true;
        s->mtp_draft_valid = false;
        free(rows);
        return keep;
    }
    free(rows);
    /* On a rejected suffix, restore BEFORE replay. Recheck every proposal
     * against canonical logits: batch rounding must not force a stale token. */
    if (ds4ui_pld_rewind(s, tx, tx->start, err, errlen) != 0) {
        ds4ui_pld_release(tx);
        return -1;
    }
    if (!ok) {
        /* A GPU/verifier error is not silently relabelled a cache miss. */
        if (errlen) snprintf(err, errlen, "PLD Metal verification failed (state restored)");
        ds4ui_pld_release(tx);
        return -1;
    }
    int committed = 0;
    for (int i = 0; i < keep; i++) {
        if (ds4_session_argmax(s) != tokens[i]) break;
        if (ds4_session_eval(s, tokens[i], err, errlen) != 0) {
            ds4_session_invalidate(s);
            ds4ui_pld_release(tx);
            return -1;
        }
        committed++;
    }
    tx->count = committed;
    if (!committed) ds4ui_pld_release(tx);
    return committed;
#endif
}

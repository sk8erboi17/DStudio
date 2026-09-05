#ifndef DSTUDIO_PLD_ENGINE_H
#define DSTUDIO_PLD_ENGINE_H
#include "ds4.h"
#include "pld.h"

typedef struct {
    ds4_session_snapshot before;
    int start, count;
    int tokens[DS4UI_PLD_DRAFT + 1];
    int active;
} ds4ui_pld_transaction;

/* Read-only backend admission; no allocations or model work. */
bool ds4ui_pld_can_verify(ds4_session *s);

/* 0: unavailable, session unchanged. -1: hard failure, do not continue.
 * >0: committed verified prefix, transaction retained for parser rollback.
 * Only the explicitly experimental Metal path calls this API. */
int ds4ui_pld_verify(ds4_session *s, const int *tokens, int count,
                     ds4ui_pld_transaction *tx, char *err, size_t errlen);
int ds4ui_pld_rewind(ds4_session *s, ds4ui_pld_transaction *tx, int pos,
                     char *err, size_t errlen);
void ds4ui_pld_release(ds4ui_pld_transaction *tx);
#endif

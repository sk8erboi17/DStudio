/* DStudio prompt lookup: bounded, token-exact, no model or external store.
 * Algorithm inspired by prompt lookup decoding; implementation is original. */
#ifndef DSTUDIO_PLD_H
#define DSTUDIO_PLD_H
#include <stdint.h>
#include <stddef.h>
#include <string.h>
#include <stdlib.h>

typedef enum { DS4UI_PLD_STRICT, DS4UI_PLD_OFF, DS4UI_PLD_BATCH } ds4ui_pld_mode;

/* A per-surface override wins over the shared setting, including an unknown
 * value: typos must never inherit experimental acceleration. */
static inline ds4ui_pld_mode ds4ui_pld_mode_for(const char *surface_env) {
    const char *value = getenv(surface_env);
    if (!value) value = getenv("DS4UI_PLD");
    if (value && strcmp(value, "off") == 0) return DS4UI_PLD_OFF;
    if (value && strcmp(value, "batch") == 0) return DS4UI_PLD_BATCH;
    return DS4UI_PLD_STRICT;
}

#define DS4UI_PLD_BUCKETS 4096
#define DS4UI_PLD_WAYS 4
#define DS4UI_PLD_DRAFT 4

typedef struct {
    int sites[DS4UI_PLD_BUCKETS][DS4UI_PLD_WAYS]; /* position + 1; zero = empty */
    int indexed;
    unsigned misses, cooldown;
    uint64_t lookups, hits, proposed, accepted, batches, fallbacks;
} ds4ui_pld_index;

static inline unsigned ds4ui_pld_hash(int a, int b, int c) {
    uint32_t h = 2166136261u;
    h = (h ^ (uint32_t)a) * 16777619u;
    h = (h ^ (uint32_t)b) * 16777619u;
    h = (h ^ (uint32_t)c) * 16777619u;
    return h & (DS4UI_PLD_BUCKETS - 1);
}

/* Call with the committed transcript BEFORE first is evaluated. The virtual
 * lookup suffix is [history[-2], history[-1], first]. Exact comparison, not
 * the hash, decides a match. No speculative token is ever indexed. */
static inline int ds4ui_pld_propose(ds4ui_pld_index *p, const int *tokens,
                                  int len, int first, int *out, int cap) {
    if (!p || !tokens || !out || len < 2 || cap <= 0) return 0;
    if (len < p->indexed) {
        memset(p->sites, 0, sizeof(p->sites));
        p->indexed = 0;
    }
    int start = p->indexed > 2 ? p->indexed - 2 : 0;
    for (int i = start; i + 2 < len; i++) {
        unsigned h = ds4ui_pld_hash(tokens[i], tokens[i+1], tokens[i+2]);
        memmove(p->sites[h] + 1, p->sites[h],
                (DS4UI_PLD_WAYS - 1) * sizeof(int));
        p->sites[h][0] = i + 1;
    }
    p->indexed = len;
    if (p->cooldown) { p->cooldown--; return 0; }
    p->lookups++;
    unsigned h = ds4ui_pld_hash(tokens[len-2], tokens[len-1], first);
    if (cap > DS4UI_PLD_DRAFT) cap = DS4UI_PLD_DRAFT;
    for (int way = 0; way < DS4UI_PLD_WAYS; way++) {
        int i = p->sites[h][way] - 1;
        if (i < 0 || i + 3 >= len || tokens[i] != tokens[len-2] ||
            tokens[i+1] != tokens[len-1] || tokens[i+2] != first) continue;
        int n = len - i - 3;
        if (n > cap) n = cap;
        memcpy(out, tokens + i + 3, (size_t)n * sizeof(int));
        p->hits++;
        p->proposed += (unsigned)n;
        return n;
    }
    return 0;
}

/* Deterministic backoff; wall-clock timing must not change generated text. */
static inline void ds4ui_pld_note(ds4ui_pld_index *p, int accepted) {
    if (accepted > 0) { p->accepted += (unsigned)accepted; p->misses = 0; }
    else if (++p->misses >= 3) { p->cooldown = 16; p->misses = 0; }
}
#endif

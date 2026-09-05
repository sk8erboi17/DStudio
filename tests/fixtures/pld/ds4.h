/* Minimal public ABI for the model-free test double. A separate build against
 * the real upstream header guards compatibility; this is not a model. */
#ifndef DSTUDIO_PLD_FIXTURE_DS4_H
#define DSTUDIO_PLD_FIXTURE_DS4_H
#include <stdbool.h>
#include <stdint.h>
#include <stddef.h>
typedef enum { DS4_BACKEND_CPU, DS4_BACKEND_METAL } ds4_backend;
typedef struct ds4_engine ds4_engine;
typedef struct ds4_session ds4_session;
typedef struct { int *v; int len, cap; } ds4_tokens;
typedef struct { uint8_t *ptr; uint64_t len, cap; } ds4_session_snapshot;
int ds4_session_argmax(ds4_session *);
int ds4_session_eval(ds4_session *, int, char *, size_t);
int ds4_session_pos(ds4_session *);
void ds4_session_invalidate(ds4_session *);
void ds4_session_rewind(ds4_session *, int);
uint64_t ds4_session_payload_bytes(ds4_session *);
int ds4_session_save_snapshot(ds4_session *, ds4_session_snapshot *, char *, size_t);
int ds4_session_load_snapshot(ds4_session *, const ds4_session_snapshot *, char *, size_t);
void ds4_session_snapshot_free(ds4_session_snapshot *);
#endif

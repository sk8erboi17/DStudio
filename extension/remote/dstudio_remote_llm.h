#ifndef DSTUDIO_REMOTE_LLM_H
#define DSTUDIO_REMOTE_LLM_H

#include <stddef.h>

/* Same-turn steering. Only the inference owner calls these, between completed
 * assistant/tool rounds. No transcript mutation occurs on the HTTP thread. */
typedef struct {
    unsigned long long turn;
    unsigned ack;
    int enabled;
} dstudio_steer;
typedef void (*dstudio_steer_append)(void *owner, const char *text);
dstudio_steer dstudio_steer_begin(void);
int dstudio_steer_drain(dstudio_steer *s, int finishing,
                       dstudio_steer_append append, void *owner);

typedef struct {
    char *ptr;
    size_t len;
    size_t cap;
} dstudio_remote_buf;

typedef void (*dstudio_remote_chunk_cb)(void *ud,
                                        const char *kind,
                                        const char *text,
                                        size_t len);

/* Called by the stream owner, never by a signal handler. Inspect the runtime's
 * existing cancellation latch; do not perform I/O or mutate its transcript. */
typedef int (*dstudio_remote_cancel_cb)(void *ud);

void dstudio_remote_buf_free(dstudio_remote_buf *b);
void dstudio_remote_buf_append(dstudio_remote_buf *b, const char *s, size_t n);
void dstudio_remote_buf_puts(dstudio_remote_buf *b, const char *s);
char *dstudio_remote_buf_take(dstudio_remote_buf *b);
void dstudio_remote_json_string(dstudio_remote_buf *b, const char *s);
void dstudio_remote_messages_append(dstudio_remote_buf *b,
                                    int *count,
                                    const char *role,
                                    const char *content);
char *dstudio_remote_messages_snapshot(const dstudio_remote_buf *b);

int dstudio_remote_chat_stream(const char *base_url,
                               const char *model,
                               const char *messages_json,
                               int think_level,
                               float temperature,
                               float top_p,
                               float min_p,
                               int max_tokens,
                               dstudio_remote_chunk_cb cb,
                               void *ud,
                               dstudio_remote_cancel_cb cancelled,
                               char *err,
                               size_t err_len);

/* Explicit structured Chat Completions boundary. The schemas and transcript
 * are serialized by the owning runtime; tool_calls_json receives one complete
 * JSON array only after a successful terminal frame. Caller frees it. Failure,
 * interruption and transport EOF leave it NULL. No tool executes in transport.
 * Legacy DSML callers keep the function above and reject structured calls. */
int dstudio_remote_chat_stream_tools(const char *base_url,
                                     const char *model,
                                     const char *messages_json,
                                     const char *tools_json,
                                     int think_level,
                                     float temperature, float top_p, float min_p,
                                     int max_tokens,
                                     dstudio_remote_chunk_cb cb, void *ud,
                                     dstudio_remote_cancel_cb cancelled,
                                     char **tool_calls_json,
                                     char *err, size_t err_len);

#endif

#ifndef DSTUDIO_REMOTE_LLM_H
#define DSTUDIO_REMOTE_LLM_H

#include <stddef.h>

typedef struct {
    char *ptr;
    size_t len;
    size_t cap;
} dstudio_remote_buf;

typedef void (*dstudio_remote_chunk_cb)(void *ud,
                                        const char *kind,
                                        const char *text,
                                        size_t len);

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
                               char *err,
                               size_t err_len);

#endif

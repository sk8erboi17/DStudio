#ifndef Q36_PROMPT_PREFIX_H
#define Q36_PROMPT_PREFIX_H

#include "q36.h"

#include <stddef.h>

typedef enum {
    Q36_PROMPT_PREFIX_USER,
    Q36_PROMPT_PREFIX_ASSISTANT,
} q36_prompt_prefix_role;

typedef struct {
    q36_prompt_prefix_role role;
    char *content;
} q36_prompt_prefix_turn;

typedef struct {
    q36_prompt_prefix_turn *turns;
    size_t count;
} q36_prompt_prefix;

int q36_prompt_prefix_parse(q36_prompt_prefix *out,
                            const char *data,
                            size_t len,
                            char *error,
                            size_t error_cap);
int q36_prompt_prefix_load(q36_prompt_prefix *out,
                           const char *path,
                           char *error,
                           size_t error_cap);
void q36_prompt_prefix_free(q36_prompt_prefix *prefix);

static inline void q36_prompt_prefix_append(q36_engine *engine,
                                             q36_tokens *tokens,
                                             const q36_prompt_prefix *prefix) {
    if (!prefix) return;
    for (size_t i = 0; i < prefix->count; i++) {
        const q36_prompt_prefix_turn *turn = &prefix->turns[i];
        const bool assistant = turn->role == Q36_PROMPT_PREFIX_ASSISTANT;
        q36_chat_append_message(engine, tokens,
                                assistant ? "assistant" : "user",
                                turn->content);
    }
}

#endif

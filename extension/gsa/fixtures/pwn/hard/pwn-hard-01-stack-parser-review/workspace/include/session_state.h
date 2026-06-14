#pragma once
#include <stddef.h>

typedef struct {
    char user[32];
    unsigned authenticated;
    unsigned request_count;
} session_state_t;

void session_init(session_state_t *state, const char *user);
int session_accept_payload(session_state_t *state, const char *payload, size_t len);
